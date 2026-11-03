import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mcpForStage,
  parseSettings,
  readSettings,
  resolveAgentFor,
  writeSettings,
} from '../config/settings.js';
import type { McpServer, Settings } from '../config/settings.js';
import { METHOD_IDS, ROLE_IDS } from '../domain/types.js';
import type { DecisionOutcome, Feature, MethodId, RoleId } from '../domain/types.js';
import { legacyBody, legacyParam } from '../domain/legacy.js';
import { appendDecision, gateState, makeDecision, openBlockingGates, readDecisions } from '../tracker/decisions.js';
import { scanProjects } from '../tracker/discover.js';
import { readDossier } from '../tracker/dossier.js';
import { appendEvent, changesFrom, nextChangeId, readJournal } from '../tracker/journal.js';
import { deriveFeature } from '../tracker/derive.js';
import { autoAcceptableIds, classifyChange } from '../tracker/triage.js';
import { ScaffoldError, scaffoldFeature } from '../tracker/scaffold.js';
import { composePullRequest } from '../tracker/pr.js';
import { DISCOVERY_PHASES, phasePrompt, producedFiles } from '../tracker/discovery.js';
import { locateFeature, disambiguationPrompt } from '../tracker/locate.js';
import { recordAmendment } from '../tracker/amend.js';
import type { PhaseId } from '../tracker/discovery.js';
import { deriveAreaFeatures, discoveredAreas } from '../tracker/areas.js';
import { beginActivity, readActivity } from './activity.js';
import type { ActivityHandle } from './activity.js';
import { probeCli, spawnRunner } from '../exec/agent.js';
import { apiRunner, probeApi } from '../exec/apiagent.js';
import { demoRunner } from '../exec/demo.js';
import type { AgentRunner } from '../exec/agent.js';
import { JobRegistry, JobError } from '../exec/jobs.js';
import type { SubmitInput } from '../exec/jobs.js';
import { describeChunk } from '../exec/stream.js';
import { inheritedWords } from '../tracker/areas.js';
import type { RunStageOptions } from '../exec/runner.js';
import { readRunRecords, readStageLogs } from '../tracker/runs.js';
import {
  SessionError,
  answerSession,
  finaliseSession,
  readRoundHistory,
  readSession,
  resetSession,
  resolveFeatureDir,
  startSession,
} from '../session/session.js';
import type { SessionPorts } from '../session/session.js';
import {
  DEFAULT_READER,
  inspectCodebase,
  pickReader,
  readerSkills,
  renderCodebaseDoc,
} from '../tracker/codebase.js';
import type { CodebaseBrief, ReaderSkill } from '../tracker/codebase.js';
import {
  DEFAULT_PACKS,
  boundElsewhere,
  entryBySlot,
  packById,
  resolveAllPacks,
  substitutionCandidates,
  verifySkill,
} from '../skills/packs.js';
import type { PackEntry, SlotState } from '../skills/packs.js';
import { installAll, readInstalledSkills } from '../skills/install.js';
import { addWorkspace } from '../workspaces.js';

/**
 * The loopback server.
 *
 * Bounded on purpose, and the bounds are the design: loopback only, foreground,
 * no timer, no filesystem watch, and it writes only into a feature's own
 * `.scratch/`. Those four constraints are what keep this from becoming the
 * hosted service and the background daemon it should not be.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 256 * 1024;

export interface ServeOptions {
  readonly roots: readonly string[];
  readonly port?: number | undefined;
  /**
   * Where the settings file lives. Injectable so a test does not write to the
   * repository's own config — a test suite that mutates the thing it is testing
   * is worse than no test, because the next run starts from a changed state.
   */
  readonly settingsPath?: string | undefined;
  /**
   * The workspace list to update when a codebase is loaded. Injectable for the
   * same reason as `settingsPath`: a test must not add a temporary directory to
   * the repository's own list and leave it there.
   */
  readonly workspacesPath?: string | undefined;
  /**
   * How agent turns are run. Injected so tests drive a scripted double, and so a
   * deployment that must not spend money can pass `dryRunner()`.
   */
  readonly runner?: AgentRunner | undefined;
  /**
   * Run with the demo agent instead of the real CLI.
   *
   * For verifying the flow without a credential, and for telling "the flow is
   * broken" apart from "the agent is broken". Printed loudly at startup, because
   * a session produced this way must not be mistaken for a real one.
   */
  readonly demo?: boolean | undefined;
  /**
   * How stage runs spawn. Injected so tests drive a stub (a real `runStage`
   * would run the actual CLI), and so demo mode never spends.
   */
  readonly stageRunner?: Omit<RunStageOptions, 'signal'> | undefined;
  /**
   * Close the listener when this aborts. `serve` resolves only on close, so
   * without this a caller has no handle — Ctrl-C is a signal, not an API. Tests
   * need it for the same reason: a suite that cannot stop the server never
   * exits.
   */
  readonly signal?: AbortSignal | undefined;
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': type,
    // No caching: this reads a working tree, and a stale board is worse than a
    // slow one.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Which feature directory a gate id belongs to. A gate id is
 *  `<project>/<feature>/<gate>` so the server never has to guess, and never has to
 *  accept a path from a request. */
interface ResolvedTarget {
  readonly projectRoot: string;
  readonly featureSlug: string;
  readonly featureDir: string;
  readonly gateId: string;
}

async function resolveTarget(
  roots: readonly string[],
  raw: string,
): Promise<ResolvedTarget | { readonly error: string }> {
  const parts = raw.split('/').filter((p) => p.length > 0);
  if (parts.length !== 3) {
    return { error: 'gate id must be <project>/<feature>/<gate>' };
  }
  const [projectName, featureSlug, gateId] = parts as [string, string, string];
  // Reject anything that could escape the workspace. A gate that could write
  // outside its own feature is a gate that can edit a repository without a record.
  if (!/^[\w.-]+$/.test(featureSlug) || featureSlug === '.' || featureSlug === '..') {
    return { error: 'invalid feature slug' };
  }
  const project = roots.find((r) => {
    const base = resolve(r);
    return (base.split(/[\\/]/).filter(Boolean).pop() ?? base) === projectName;
  });
  if (project === undefined) return { error: `unknown project: ${projectName}` };
  const projectRoot = resolve(project);
  const featureDir = join(projectRoot, '.scratch', featureSlug);
  // Belt and braces: the resolved path must still be inside the project.
  const normalised = normalize(featureDir);
  if (!normalised.startsWith(normalize(projectRoot))) {
    return { error: 'resolved path escapes the project' };
  }
  return { projectRoot, featureSlug, featureDir, gateId };
}

function isOutcome(v: unknown): v is DecisionOutcome {
  return typeof v === 'string' && ['pass', 'fail', 'skip', 'override'].includes(v);
}
function isRole(v: unknown): v is RoleId {
  return typeof v === 'string' && (ROLE_IDS as readonly string[]).includes(v);
}
function isMethod(v: unknown): v is MethodId {
  return typeof v === 'string' && (METHOD_IDS as readonly string[]).includes(v);
}

/* ---- request body coercion ----
 * Each of these returns a value the scaffolder can trust, or an empty one. They
 * never throw on shape: a malformed field becomes an empty field, and the
 * server's response says what it wrote so the caller can see the difference. */

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function asGlossary(v: unknown): { word: string; meaning: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { word: string; meaning: string }[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const word = typeof o['word'] === 'string' ? o['word'].trim() : '';
    const meaning = typeof o['meaning'] === 'string' ? o['meaning'].trim() : '';
    if (word.length > 0) out.push({ word, meaning });
  }
  return out;
}

function asPrd(v: unknown): {
  problem: string;
  solution: string;
  stories: string[];
  decisions: string[];
  testing: string[];
  seam?: string;
  outOfScope: string[];
} {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof o[k] === 'string' ? o[k] : '');
  const arr = (k: string): string[] => asStringArray(o[k]);
  return {
    problem: str('problem'),
    solution: str('solution'),
    stories: arr('stories'),
    decisions: arr('decisions'),
    testing: arr('testing'),
    ...(str('seam').length > 0 ? { seam: str('seam') } : {}),
    outOfScope: arr('outOfScope'),
  };
}

function asPrototypes(v: unknown): {
  id: string;
  title: string;
  kind: 'logic' | 'ui';
  reason: string;
}[] {
  if (!Array.isArray(v)) return [];
  const out: { id: string; title: string; kind: 'logic' | 'ui'; reason: string }[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o['title'] === 'string' ? o['title'].trim() : '';
    if (title.length === 0) continue;
    out.push({
      id: typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : String(out.length + 1),
      title,
      kind: o['kind'] === 'ui' ? 'ui' : 'logic',
      reason: typeof o['reason'] === 'string' ? o['reason'] : '',
    });
  }
  return out;
}

/* ---- session wiring ---- */

const DEFAULT_SKILLS_ROOT = 'C:/Users/Administrator/.agents/skills';

/** Tools the agent may use without a prompt. Reads, search, and edits. */
const AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'] as const;

function isAllowedRoot(roots: readonly string[], candidate: string): boolean {
  const want = resolve(candidate);
  return roots.some((r) => resolve(r) === want);
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: (err as Error).message });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'body must be a JSON object' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'body is not JSON' });
    return null;
  }
}

function sendSessionError(res: ServerResponse, err: unknown): void {
  if (err instanceof SessionError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  sendJson(res, 500, { error: (err as Error).message });
}

async function withHistory(state: Awaited<ReturnType<typeof readSession>>): Promise<unknown> {
  if (state === null) return state;
  return { ...state, history: await readRoundHistory(state.featureDir) };
}

/** Prefer the skills root recorded in settings, falling back to the default. */
/** Build the session's dependencies from settings, honouring an injected runner. */
function sessionPorts(settings: Settings, runner: AgentRunner): SessionPorts {
  /* The model is resolved at task start and frozen into the turn, so a
   * settings change mid-session cannot drift the conversation onto another
   * model. Empty model = the CLI's own configured default. */
  const resolved = resolveAgentFor(settings);
  return {
    runner,
    skillsRoot: DEFAULT_SKILLS_ROOT,
    model: resolved.model,
    timeoutMs: settings.agents.timeoutMin * 60 * 1000,
    allowedTools: AGENT_TOOLS,
  };
}

async function resolveSkillsRoot(settings: { readonly unknown?: Readonly<Record<string, unknown>> }): Promise<string> {
  const v = settings.unknown?.['skillsRoot'];
  return typeof v === 'string' && v.trim().length > 0 ? v : DEFAULT_SKILLS_ROOT;
}

/* ---- discovery jobs ----
 *
 * Reading an existing codebase happens in three passes, and the passes outlive a
 * single request. The job is held in memory for the same reason a stage run is:
 * the human is watching a progress display, not waiting on an HTTP response.
 */

interface DiscoveryPhaseState {
  readonly id: PhaseId;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
}

interface DiscoveryJob {
  readonly jobId: string;
  readonly target: string;
  readonly skill: string;
  /** Absolute path of the skill's `SKILL.md`, resolved when the job is made. */
  readonly skillPath: string;
  readonly outputRoot: string;
  readonly startedAt: string;
  status: 'running' | 'succeeded' | 'failed';
  endedAt: string | null;
  error: string | null;
  phases: DiscoveryPhaseState[];
  /** The live activity record for this job, so the caller can follow it. */
  activityId?: string;
}

/** Keyed by job id. Survives a request; does not survive a restart, and says so. */
const discoveryJobs = new Map<string, DiscoveryJob>();

/**
 * Run the three passes in order, stopping at the first failure.
 *
 * Stopping is deliberate. The passes build on each other — architecture is read
 * from what discovery found, and feature mapping from both — so continuing after
 * a failed pass would write the next one on top of a gap it was told was filled.
 */
/**
 * Watch the output root for files that appear while a pass runs.
 *
 * The agent does not tell us what it is thinking, so we cannot honestly say what
 * it is reading. We *can* say what it has produced, by looking. That is the
 * difference between a progress line and a guess.
 *
 * Seeded with whatever is already there, or the first tick would report the
 * previous pass's work as if this one had just written it.
 */
/**
 * One line out of an agent's output, for display.
 *
 * Chunks arrive mid-line and can be enormous. What goes on screen is a single
 * trimmed line, and the cap is what keeps a runaway process from filling the
 * log — the whole point is to see what is happening, not to keep all of it.
 */
/**
 * What an agent's raw line means, for anyone watching.
 *
 * The agent prints JSON envelopes; put on screen as they arrive they say
 * nothing about whether it is reading a file, running a command or answering.
 * Reduced here to the thing it did, so the dock answers "what is it doing"
 * rather than merely proving that something is happening.
 */
function readableLines(chunk: string): readonly string[] {
  return describeChunk(chunk).map(trimLine);
}

function trimLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= 200 ? line : `${line.slice(0, 197)}…`;
}

/**
 * Follow a submitted job until it settles, and close its activity then.
 *
 * The registry is the authority on when a run ends, so the activity is closed
 * from the registry's answer rather than from a guess about how long the stage
 * takes. Cancelled counts as finished: it is over, and the dock must stop
 * saying it is running.
 */
function watchJob(
  registry: { get(id: string): { status: string; error: string | null } | null },
  jobId: string,
  activity: ActivityHandle,
): void {
  const timer = setInterval(() => {
    const view = registry.get(jobId);
    if (view === null || view.status === 'running') return;
    clearInterval(timer);
    if (view.status === 'succeeded') activity.end('succeeded');
    else activity.end('failed', view.error ?? view.status);
  }, 1500);
  timer.unref?.();
}

function watchOutput(
  handle: ActivityHandle,
  target: string,
  outputRoot: string,
  everyMs = 2500,
): () => void {
  const seen = new Set<string>();
  let closed = false;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (closed || busy) return;
    busy = true;
    const files = await producedFiles(target, outputRoot, 200).catch(() => []);
    for (const f of files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      handle.wrote(f.path);
    }
    busy = false;
  };
  void producedFiles(target, outputRoot, 200)
    .catch(() => [])
    .then((files) => {
      for (const f of files) seen.add(f.path);
    });
  const timer = setInterval(() => void tick(), everyMs);
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

async function runDiscoveryJob(
  job: DiscoveryJob,
  runner: AgentRunner,
  model: string,
  timeoutMs: number,
  allowedTools: readonly string[],
  activity: ActivityHandle,
): Promise<void> {
  const stopWatching = watchOutput(activity, job.target, job.outputRoot);
  try {
    for (let i = 0; i < DISCOVERY_PHASES.length; i += 1) {
      const phase = DISCOVERY_PHASES[i]!;
      const state = job.phases[i]!;
      state.status = 'running';
      activity.note(`pass ${i + 1} of ${DISCOVERY_PHASES.length}: ${phase.id} — ${phase.purpose}`, 'start');
      activity.progress(i / DISCOVERY_PHASES.length);
      const result = await runner.run({
        prompt: phasePrompt(phase, {
          target: job.target,
          skillPath: job.skillPath,
          outputRoot: job.outputRoot,
        }),
        sessionId: null,
        cwd: job.target,
        logPath: join(job.target, '.governance', 'discovery', `${phase.id}.log`),
        timeoutMs,
        model,
        allowedTools,
      });
      if (!result.ok) {
        state.status = 'failed';
        state.error = result.error ?? `the agent exited in phase ${result.phase ?? 'exit'}`;
        job.status = 'failed';
        job.error = `${phase.id}: ${state.error}`;
        job.endedAt = new Date().toISOString();
        activity.note(`${phase.id}: ${state.error}`, 'error');
        activity.end('failed', job.error);
        return;
      }
      state.status = 'succeeded';
      activity.note(`${phase.id} finished`);
      activity.progress((i + 1) / DISCOVERY_PHASES.length);
    }
    job.status = 'succeeded';
    job.endedAt = new Date().toISOString();
    activity.end('succeeded');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.status = 'failed';
    job.error = message;
    job.endedAt = new Date().toISOString();
    activity.note(message, 'error');
    activity.end('failed', message);
    throw err;
  } finally {
    stopWatching();
  }
}

/**
 * The drive roots this machine actually has.
 *
 * A folder chooser that starts at `C:\Users\name` cannot reach `H:\Projects`,
 * and on Windows there is no single root to enumerate the way there is on a
 * unix machine. Twenty-six `existsSync` calls is cheap, and it is the only
 * portable way to ask "where can I even go" without shelling out.
 */
function driveRoots(): readonly string[] {
  const out: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) out.push(root);
  }
  return out;
}

/**
 * Every enabled pack's substitutions, in one map.
 *
 * Slot ids are namespaced by pack (`design.visual`, `devops.audit`), so two packs
 * cannot collide and the resolver can take one map instead of one per pack. A
 * disabled pack contributes nothing: its substitutions are not claims about
 * anything the framework is currently using.
 */
function packSubstitutions(settings: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of settings.skillPacks) {
    if (p.enabled) Object.assign(out, p.substitutions);
  }
  return out;
}

/**
 * Probe an MCP server.
 *
 * A real attempt, not a canned "ok": for stdio it spawns the command and reports
 * whether it started, and for http it makes one request. Both are given a short
 * deadline, because a settings screen that hangs on a dead server is worse than
 * one that says it could not reach it.
 */
async function probeMcp(server: McpServer): Promise<{
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}> {
  const started = Date.now();

  if (server.transport !== 'stdio') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const r = await fetch(server.target, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      return {
        name: server.name,
        ok: r.ok,
        detail: `HTTP ${r.status}`,
        ms: Date.now() - started,
      };
    } catch (err) {
      return {
        name: server.name,
        ok: false,
        detail: (err as Error).message,
        ms: Date.now() - started,
      };
    }
  }

  const [cmd, ...args] = server.target.split(/\s+/).filter((p) => p.length > 0);
  if (cmd === undefined) {
    return { name: server.name, ok: false, detail: 'no command configured', ms: 0 };
  }

  return await new Promise((done) => {
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      done({ name: server.name, ok, detail, ms: Date.now() - started });
    };
    try {
      const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        // Starting at all is the answer for a server that waits on stdin, which
        // most stdio MCP servers do.
        finish(true, 'started, still running (expected for stdio)');
      }, 1500);
      child.on('error', (err) => {
        clearTimeout(timer);
        finish(false, err.message);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) finish(true, 'exited 0');
        else finish(false, `exited ${String(code)}`);
      });
    } catch (err) {
      finish(false, (err as Error).message);
    }
  });
}

/* ---- reading an artifact, and reaching it on disk ----
 *
 * Two capabilities that turn the record from something you can see into
 * something you can use: open a file's text in the page, and hand the human the
 * OS window they would otherwise go hunting for. Both are bounded exactly like
 * the rest of this server — the target must resolve inside a configured
 * workspace, and **no command ever comes from the request**. The request names
 * one of two fixed verbs; the argv is built here, from a path this file has
 * already proved is inside a feature.
 */

const MAX_PREVIEW_BYTES = 512 * 1024;

/** Resolve `rel` inside `base`, or null if it would land outside it. */
function insideBase(base: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const b = normalize(base);
  const abs = normalize(resolve(b, rel));
  if (abs === b) return abs;
  return abs.startsWith(b.endsWith(sep) ? b : b + sep) ? abs : null;
}

/** How the page should render a file. Anything unknown is shown as text. */
function langOf(file: string): 'markdown' | 'json' | 'text' {
  const ext = extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  return 'text';
}

interface LaunchResult {
  readonly ok: boolean;
  readonly launcher: string;
  readonly reason?: string;
}

/**
 * Start a process and report whether it *started*.
 *
 * Not whether it succeeded: `explorer.exe` exits 1 even when the window opened,
 * so waiting for an exit code would report a working launch as a failure. The
 * `spawn` event means the OS accepted it, which is the only thing this can
 * honestly know. Detached and unref'd so a viewer outlives the request that
 * asked for it.
 */
interface LaunchOptions {
  /** Run through the platform shell — needed for a `.cmd` shim on Windows. */
  readonly shell?: boolean;
  /**
   * Hand `args` to the process byte for byte, with no quoting or escaping.
   *
   * Only for a command line that is already quoted by the caller, when the
   * consumer is `cmd.exe` — which understands quotes but not backslash
   * escapes, so Node's own quoting would corrupt it.
   */
  readonly verbatim?: boolean;
}

function launchDetached(
  cmd: string,
  args: readonly string[],
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: LaunchResult): void => {
      if (settled) return;
      settled = true;
      done(r);
    };
    try {
      const child = spawn(cmd, [...args], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
        ...(options.shell ? { shell: true } : {}),
        ...(options.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
      child.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        finish({
          ok: false,
          launcher: cmd,
          reason: code === 'ENOENT' ? `${cmd} is not on PATH` : err.message,
        });
      });
      child.on('spawn', () => {
        child.unref();
        finish({ ok: true, launcher: cmd });
      });
    } catch (err) {
      finish({ ok: false, launcher: cmd, reason: (err as Error).message });
    }
  });
}

/**
 * Windows: build a `cmd.exe` command line that is already quoted.
 *
 * `code` is a `.cmd` shim, so it cannot be spawned without a shell — but
 * `shell: true` makes Node join argv with single spaces and no quoting, and
 * `cmd.exe` splits on those spaces. A path ending `…\html-hello-world\space
 * probe` reaches VS Code as `…\html-hello-world\space` plus `probe`: the
 * editor starts, the folder never opens, and the button still reports success
 * because `spawn` fired.
 *
 * The route has already refused `"` for this verb (see the allowlist), which is
 * the one character that could end the quoting early. The outer pair is what
 * `cmd /s` strips, leaving `"code" "…\space probe"`.
 */
export function winShellLine(cmd: string, args: readonly string[]): string {
  return `"${[cmd, ...args].map((s) => `"${s}"`).join(' ')}"`;
}

/**
 * Windows: the absolute path of a `.cmd` shim on PATH.
 *
 * Quoting the bare name is not enough. `cmd` sets `%0` to the token as typed,
 * so a shim invoked as `"code"` sees an empty `%~dp0`, and VS Code's own
 * `"%~dp0..\Code.exe"` resolves against the working directory — the shim is
 * found, the editor is not, and exit code 9009 says so on a stream nobody
 * reads. An absolute path also stops a `code.cmd` that happens to sit in the
 * server's working directory from being picked up instead.
 *
 * PATH arrives with a few mangled entries on this machine (`ram Files (x86)\…`
 * from a lost `P`), so a directory that does not exist is simply skipped.
 */
export function windowsShim(
  name: string,
  pathEnv: string = process.env['PATH'] ?? '',
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  for (const raw of pathEnv.split(';')) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!/^[a-zA-Z]:[\\/]/.test(dir)) continue;
    for (const ext of ['.cmd', '.bat', '.exe']) {
      const candidate = join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Open a folder, select a file in it, or open it in the editor. */
async function revealTarget(mode: 'folder' | 'vscode', target: string): Promise<LaunchResult> {
  const info = await stat(target).catch(() => null);
  const isDir = info?.isDirectory() ?? false;
  if (mode === 'vscode') {
    if (process.platform !== 'win32') {
      return await launchDetached('code', [target]);
    }
    if (target.includes('"')) {
      return {
        ok: false,
        launcher: 'code',
        reason: 'this path contains a quote, which cannot be passed to a launcher',
      };
    }
    const shim = windowsShim('code');
    if (shim === null) {
      // No shim on PATH: the old shell form still works for paths without
      // spaces, and one failure mode beats no editor at all.
      return await launchDetached('code', [target], { shell: true });
    }
    return await launchDetached(
      'cmd.exe',
      ['/d', '/s', '/c', winShellLine(shim, [target])],
      { verbatim: true },
    );
  }
  if (process.platform === 'win32') {
    const launched = await launchDetached('explorer.exe', [isDir ? target : `/select,${target}`]);
    if (launched.ok) focusExplorerWindow(isDir ? target : dirname(target));
    return launched;
  }
  if (process.platform === 'darwin') {
    return await launchDetached('open', isDir ? [target] : ['-R', target]);
  }
  return await launchDetached('xdg-open', [isDir ? target : dirname(target)]);
}

/**
 * Windows: make sure the folder window is actually in front.
 *
 * Opening a folder that is *already* open makes Explorer put another window
 * behind everything — from the user's side the button did nothing at all,
 * while the toast said it worked. Opening a window is not showing it.
 *
 * Best feature by design: detached, no result, and a machine without PowerShell
 * still gets the window (the previous behaviour). The target travels in an
 * environment variable so no path is ever pasted into script text — the same
 * reason the endpoint takes a verb and a path, never a command.
 */
function focusExplorerWindow(dir: string): void {
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class W {',
    ' [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '}',
    '"@',
    '$want = (Get-Item -LiteralPath $env:GOV_REVEAL_TARGET).FullName.Replace("\\", "/")',
    '$uri = "file:///" + $want',
    '$s = New-Object -ComObject Shell.Application',
    '$w = $s.Windows() | Where-Object { $_.LocationURL -eq $uri } | Select-Object -First 1',
    'if ($w) { [void][W]::ShowWindow([IntPtr]$w.HWND, 9); [void][W]::SetForegroundWindow([IntPtr]$w.HWND) }',
  ].join('\n');
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, GOV_REVEAL_TARGET: dir },
    });
    child.on('error', () => {
      /* The window is open either way; losing the nudge is not a failure. */
    });
    child.unref();
  } catch {
    /* Best feature, and never the response. */
  }
}

export async function serve(options: ServeOptions): Promise<number> {
  const port = options.port ?? 4173;
  /**
   * The agent runner, built once per transport+cli choice for the life of the
   * server.
   *
   * Not per request. A runner can hold state — the demo agent counts rounds — and
   * rebuilding it restarted that count, so every request produced round 1 and the
   * session never advanced. The resolution of the CLI is cached here too, which
   * saves repeating a filesystem walk on every turn.
   *
   * Cached against a key rather than blindly: the settings file can switch the
   * transport between requests (settings PUT is a real control), and a cache
   * that ignored that would keep calling the CLI after the human asked for the
   * API. An injected runner — tests, embedding — always wins.
   */
  let runnerCache: AgentRunner | null = options.runner ?? null;
  let runnerCacheKey = options.runner !== undefined ? 'injected' : '';
  const keyFor = (s: Settings): string => {
    if (options.demo === true) return 'demo';
    if (s.agents.transport === 'api') return 'api';
    const r = resolveAgentFor(s);
    return `cli:${r.cli}:${r.model}`;
  };
  const runnerFor = (s: Settings): AgentRunner => {
    if (runnerCache !== null && (options.runner !== undefined || runnerCacheKey === keyFor(s))) {
      return runnerCache;
    }
    const built: AgentRunner =
      options.demo === true
        ? demoRunner()
        : s.agents.transport === 'api'
          ? apiRunner({
              apiBase: s.agents.apiBase,
              model: s.agents.apiModel,
              maxTokens: s.agents.apiMaxTokens,
              apiKey: () => process.env[s.agents.apiKeyEnv],
            })
          : spawnRunner({ cli: resolveAgentFor(s).cli });
    runnerCacheKey = options.runner !== undefined ? 'injected' : keyFor(s);
    runnerCache = built;
    return built;
  };
  /* Mutable on purpose: loading a codebase adds a root while the server runs.
   * Every reader below closes over this one array, so a new root is visible to
   * the scanner, the gate endpoints and the reveal guard at the same moment —
   * there is no second copy of the list to keep in step. */
  const roots: string[] = options.roots.map((r) => resolve(r));
  const here = fileURLToPath(import.meta.url);
  // dist/src/server/http.js -> the package root is four levels up, then `web/`.
  const webRoot = resolve(here, '..', '..', '..', '..', 'web');

  /**
   * The job registry: the first thing in this server that can spend money and
   * write outside a session, on behalf of an HTTP caller. Built once, like the
   * runner — a registry rebuilt per request would forget what is running.
   *
   * Demo mode never spawns a real stage: a stub stands in, and every record it
   * writes says `demo: true`.
   */
  const stageRunner =
    options.stageRunner ??
    (options.demo === true
      ? {
          resolve: async () => ({
            command: process.execPath,
            args: ['-e', `console.log('demo: no stage was executed')`],
            how: 'demo stub',
          }),
        }
      : undefined);
  /**
   * Fresh submit inputs for one feature, or null when nothing should be run.
   *
   * Two things make this the only correct way to build inputs for an automatic
   * run: **fresh settings**, because AFK may have been switched off since the
   * last submission, and a **fresh scan**, because the feature may have moved on
   * disk while an agent was working. Null therefore means "not under AFK" or
   * "the feature is gone" — never a failed lookup to be retried.
   */
  const inputsFor = async (root: string, slug: string): Promise<SubmitInput | null> => {
    const { settings: fresh } = await readSettings(options.settingsPath);
    if (fresh.automation.afk !== true) return null;
    const projects = await scanProjects([root]);
    const feature = projects[0]?.features.find((e) => e.slug === slug);
    if (feature === undefined) return null;
    return {
      root,
      featureDir: resolveFeatureDir(root, slug),
      feature,
      settings: fresh,
      skillsRoot: await resolveSkillsRoot(fresh),
      maxParallel: fresh.agents.maxParallel,
      timeoutMs: fresh.agents.timeoutMin * 60 * 1000,
    };
  };

  /* Which live activity belongs to which job, so a chain stop can be written
   * onto the run it followed. The stop is decided by the registry, which knows
   * nothing about activities; this is the only place that knows both. Capped,
   * because a long-lived server that remembers every job forever is a leak. */
  const runActivities = new Map<string, ActivityHandle>();
  const rememberRun = (jobId: string, handle: ActivityHandle): void => {
    runActivities.set(jobId, handle);
    while (runActivities.size > 50) {
      const oldest = runActivities.keys().next();
      if (oldest.done === true) break;
      runActivities.delete(oldest.value);
    }
  };

  const registry = new JobRegistry({
    ...(options.demo === true ? { demo: true } : {}),
    ...(stageRunner !== undefined ? { runStageOptions: stageRunner } : {}),
    /* A stop is the answer to "did it finish, or did it stop?" — and when it
     * stopped, whether a gate is holding it. Both halves go onto the run's own
     * activity line, which is the thing a person has been watching for the last
     * several minutes, rather than to a console they are not reading.
     *
     * A gate is named by id. "A gate is open" tells you to go looking; "gate
     * g-split is open" tells you where to look. */
    onStop: (finished, why, gates) => {
      const handle = runActivities.get(finished.jobId);
      if (handle === undefined) return;
      handle.note(
        gates.length > 0
          ? `stopped after ${finished.stage}: ${why} — gate(s) ${gates.map((g) => g.id).join(', ')}`
          : `stopped after ${finished.stage}: ${why}`,
      );
    },
    /* The AFK chain. After a succeeded run, the next inputs are built from a
     * fresh scan and fresh settings — never from the ones the finished run
     * was submitted with: the feature may have advanced on disk, and AFK may
     * have been switched off while the agent was working. The registry owns
     * the loop control (progress, gates, cap); this only supplies material. */
    autoAdvance: async (finished) => {
      if (finished.status !== 'succeeded') return null;
      const { settings: fresh } = await readSettings(options.settingsPath);
      if (fresh.automation.afk !== true) return null;
      const featureDir = resolveFeatureDir(finished.root, finished.feature);

      /* A succeeded requirements run is the answer to every change that was
       * open when it began. Running unattended means nobody is standing by to
       * press "accept", and a loop that stops to ask has no way to continue.
       *
       * So the closure is written — with the run that produced it, and the word
       * `afk` on it, because the record must be able to say who decided. Three
       * refuses are built in, each because the alternative is wrong:
       *
       * - a change routed to a follow-up feature is never closed here (the work
       *   did not land in this feature, and closing it would claim it did);
       * - a change filed *during* the run is left open (it was not in the
       *   prompt, so this run cannot have answered it);
       * - a change with no recorded verdict is left open (nobody knows how it
       *   was routed, so accepting it here would invent a decision).
       */
      if (finished.stage === 'ask') {
        const { events } = await readJournal(featureDir);
        const changes = changesFrom(events);
        for (const id of autoAcceptableIds(changes, finished.startedAt)) {
          await appendEvent(featureDir, {
            kind: 'change.closed',
            ref: id,
            detail: `closed by AFK: the requirements stage ran and succeeded (${finished.jobId.slice(0, 8)})`,
            data: {
              by: 'afk',
              jobId: finished.jobId,
              note: 'AFK accepted this after the requirements stage ran and succeeded',
            },
          });
        }
      }

      return await inputsFor(finished.root, finished.feature);
    },
  });

  /**
   * The loopback guard, now that the server can spend money.
   *
   * The Host check is DNS-rebinding armor: a page at an attacker's domain that
   * resolves to 127.0.0.1 sends a Host header naming their domain, and a
   * response to a GET would otherwise be readable by their script. The Origin
   * check covers mutations: a same-origin POST carries `http://127.0.0.1:<port>`,
   * a foreign page's fetch carries its own origin and is refused — including a
   * `text/plain` body smuggling valid JSON, which no preflight would stop.
   * A missing Origin means a non-browser caller (curl, tests); it is allowed,
   * because this server has no other authentication and never will.
   */
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    const host = String(req.headers.host ?? '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      sendJson(res, 403, { error: `refusing non-loopback host header: ${host}` });
      return false;
    }
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(String(origin))) {
        sendJson(res, 403, { error: `refusing cross-origin mutation from: ${String(origin)}` });
        return false;
      }
    }
    return true;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!guard(req, res)) return;
    /* Read once per request. The session endpoints need it, and re-reading it in
     * each of them would be four chances for them to disagree. */
    const settings = (await readSettings(options.settingsPath)).settings;
    const ports = (): SessionPorts =>
      sessionPorts(settings, runnerFor(settings));

    try {
      if (path === '/api/health') {
        sendJson(res, 200, { ok: true, roots, webRoot });
        return;
      }

      if (path === '/api/projects' && req.method === 'GET') {
        sendJson(res, 200, await scanProjects(roots));
        return;
      }

      /* ---- loading a codebase that already exists ----
       *
       * Inspect, choose a reader, register. The first two are reads: what is at
       * this path, and which installed skill would read it. Registering writes
       * two things and nothing else — a root in the workspace list, and a
       * `.scratch/CODEBASE.md` inside the repository that states what was seen.
       * No agent runs here: a repository is made *visible* before anything is
       * asked to understand it.
       */

      if (path === '/api/codebase' && req.method === 'GET') {
        const target = (url.searchParams.get('path') ?? '').trim();
        if (target.length === 0) {
          sendJson(res, 400, { error: 'pass ?path= to inspect' });
          return;
        }
        if (!isAbsolute(target)) {
          sendJson(res, 400, { error: `not an absolute path: ${target}` });
          return;
        }
        const brief = await inspectCodebase(target);
        if (brief === null) {
          sendJson(res, 404, { error: `no such directory: ${resolve(target)}` });
          return;
        }
        const skillsRoot = await resolveSkillsRoot(settings);
        const installed = await readerSkills(skillsRoot);
        sendJson(res, 200, {
          brief,
          readers: installed.slice(0, 12),
          pick: pickReader(installed),
          alreadyRoot: roots.some((r) => resolve(r) === brief.path),
        });
        return;
      }

      if (path === '/api/skills/readers' && req.method === 'GET') {
        const skillsRoot = await resolveSkillsRoot(settings);
        const installed = await readerSkills(skillsRoot);
        sendJson(res, 200, { skillsRoot, readers: installed, pick: pickReader(installed) });
        return;
      }

      /* ---- skill packs: which capability slots this machine fills ---- */

      if (path === '/api/skills/packs' && req.method === 'GET') {
        const { settings } = await readSettings(options.settingsPath);
        const skillsRoot = await resolveSkillsRoot(settings);
        const installed = await readInstalledSkills(skillsRoot);
        const resolved = resolveAllPacks({
          installed,
          substitutions: packSubstitutions(settings),
        });
        const on = new Map(settings.skillPacks.map((p) => [p.id, p.enabled]));
        const packs = resolved.map((p) => ({
          ...p,
          enabled: on.get(p.id) ?? true,
          /* Computed here rather than by the page: the picker may only offer what
           * the checker would accept, and a second implementation in the browser
           * would be a second answer to the same question. A skill already doing
           * another job in this pack is not offered for this one. */
          entries: p.entries.map((e) => ({
            ...e,
            alternatives: substitutionCandidates(
              p.id,
              e.slot,
              installed,
              boundElsewhere(p.entries, e.slot),
            ).map((c) => c.id),
          })),
        }));
        sendJson(res, 200, {
          skillsRoot,
          packs,
          // Directory names only: the interface needs them for the substitution
          // picker, and shipping every SKILL.md back would be a megabyte of
          // prose the page never shows.
          installed: [...installed.keys()].sort(),
          /* "Somebody has to do something" — true only for a pack that is on.
           * A disabled pack is not a gap, it is a decision. */
          needsSetup: packs.some((p) => p.enabled && !p.ready),
        });
        return;
      }

      if (path === '/api/skills/packs/substitute' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const packId = String(b['pack'] ?? '').trim();
        const slot = String(b['slot'] ?? '').trim();
        const skill = String(b['skill'] ?? '').trim();

        const pack = packById(packId);
        if (pack === null) {
          sendJson(res, 400, { error: `no skill pack named "${packId}"` });
          return;
        }
        const entry = entryBySlot(packId, slot);
        if (entry === null) {
          sendJson(res, 400, {
            error: `no slot named "${slot}" in ${packId}`,
            slots: pack.entries.map((e) => e.slot),
          });
          return;
        }

        const { settings } = await readSettings(options.settingsPath);
        const skillsRoot = await resolveSkillsRoot(settings);
        const installed = await readInstalledSkills(skillsRoot);

        /* Clearing a substitution is allowed and always safe: it restores the
         * pack's own preference. Setting one is the dangerous direction, and it
         * is the one that gets checked. */
        if (skill.length > 0) {
          const raw = installed.get(skill);
          if (raw === undefined) {
            sendJson(res, 400, {
              error: `"${skill}" is not installed under ${skillsRoot}`,
              installed: [...installed.keys()].sort(),
            });
            return;
          }
          const verdict = verifySkill(skill, raw, entry.contract);
          if (verdict.status !== 'match') {
            /* Refused, with the reason. Storing it and showing a warning later
             * would leave the slot bound to the wrong tool in the meantime —
             * which is the exact failure this endpoint exists to prevent.
             *
             * The candidate list has to be built the same way the list endpoint
             * builds it. It was not, and this message offered
             * `deployment-engineer`, which the same pack already uses for its
             * next layer — the one-skill-fills-two-layers mistake, recommended
             * in an error body. */
            const now = resolveAllPacks({
              installed,
              substitutions: packSubstitutions(settings),
            }).find((p) => p.id === packId);
            sendJson(res, 409, {
              error: `"${skill}" does not do the job of ${slot}`,
              rejected: verdict.rejected,
              reasons: verdict.reasons,
              score: verdict.score,
              minScore: entry.contract.minScore,
              candidates: substitutionCandidates(
                packId,
                slot,
                installed,
                now === undefined ? new Set<string>() : boundElsewhere(now.entries, slot),
              ).map((c) => c.id),
            });
            return;
          }
        }

        const packs = settings.skillPacks.map((p) => {
          if (p.id !== packId) return p;
          const next: Record<string, string> = { ...p.substitutions };
          if (skill.length === 0) delete next[slot];
          else next[slot] = skill;
          return { ...p, substitutions: next };
        });

        let file: string;
        try {
          file = await writeSettings({ ...settings, skillPacks: packs }, options.settingsPath);
        } catch (err) {
          sendJson(res, 409, { error: (err as Error).message });
          return;
        }

        const after = resolveAllPacks({
          installed,
          substitutions: packSubstitutions({ ...settings, skillPacks: packs }),
        });
        const state: SlotState | undefined = after
          .find((p) => p.id === packId)
          ?.entries.find((e) => e.slot === slot);
        sendJson(res, 200, { file, slot: state ?? null, skillPacks: packs, packs: after });
        return;
      }

      if (path === '/api/skills/packs/install' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const packId = String(b['pack'] ?? '').trim();
        const slot = String(b['slot'] ?? '').trim();

        const { settings } = await readSettings(options.settingsPath);
        const skillsRoot = await resolveSkillsRoot(settings);

        let targets: readonly PackEntry[];
        if (slot.length > 0) {
          const entry = entryBySlot(packId, slot);
          if (entry === null) {
            sendJson(res, 400, { error: `no slot named "${slot}" in "${packId}"` });
            return;
          }
          targets = [entry];
        } else if (packId.length > 0) {
          const pack = packById(packId);
          if (pack === null) {
            sendJson(res, 400, { error: `no skill pack named "${packId}"` });
            return;
          }
          targets = pack.entries;
        } else {
          targets = DEFAULT_PACKS.flatMap((p) => p.entries);
        }

        /* One clone per repository, not one per slot. Three devops slots come
         * from the same repo; installed slot by slot in a loop they would clone
         * it three times, on the run where the user is waiting. `installAll`
         * groups by repo and clones once, and it stats before it clones so a
         * machine that already has everything touches the network not at all.
         *
         * Entries with no source are answered here rather than there: "skipped"
         * is a decision, not a failure, and the two must not be folded into one
         * status by the installer. */
        type Row = {
          slot: string;
          status: 'installed' | 'kept' | 'skipped' | 'failed';
          skill?: string;
          path?: string;
          error?: string;
        };
        const runnable = targets.filter((e) => e.source !== null);
        const outcomes = new Map(
          (await installAll(runnable, skillsRoot)).map((o) => [o.entry.slot, o]),
        );
        const results: Row[] = targets.map((entry) => {
          if (entry.source === null) {
            return {
              slot: entry.slot,
              status: 'skipped',
              ...(entry.unresolved === undefined ? {} : { error: entry.unresolved }),
            };
          }
          const outcome = outcomes.get(entry.slot);
          if (outcome === undefined) {
            return { slot: entry.slot, status: 'failed', error: 'the installer returned no result' };
          }
          if ('result' in outcome) {
            return {
              slot: entry.slot,
              status: outcome.result.status,
              skill: outcome.result.skill,
              path: outcome.result.path,
            };
          }
          return { slot: entry.slot, status: 'failed', error: outcome.error };
        });

        const installed = await readInstalledSkills(skillsRoot);
        const packs = resolveAllPacks({
          installed,
          substitutions: packSubstitutions(settings),
        });
        /* 207 when some slots failed: the caller needs both halves of the answer,
         * and a plain 500 would throw away the ones that worked. */
        const failed = results.some((r) => r.status === 'failed');
        sendJson(res, failed ? 207 : 200, { skillsRoot, results, packs });
        return;
      }

      if (path === '/api/workspaces' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const raw = String(b['path'] ?? '').trim();
        if (raw.length === 0 || !isAbsolute(raw)) {
          sendJson(res, 400, { error: 'pass an absolute path to the repository' });
          return;
        }
        const target = resolve(raw);

        /* A root inside an existing root would make every scan read the same
         * feature twice and show it under two projects — and so would a root that
         * contains one. Refused in both directions, with the reason: "add the
         * top of the repository" is the fix, and the caller cannot guess it. */
        const inside = roots.find((r) => target !== resolve(r) && target.startsWith(resolve(r) + sep));
        if (inside !== undefined) {
          sendJson(res, 400, {
            error: `this path is inside the workspace ${inside}; load the top of that repository instead`,
          });
          return;
        }
        const container = roots.find((r) => !target.startsWith(resolve(r) + sep) && resolve(r).startsWith(target + sep));
        if (container !== undefined) {
          sendJson(res, 400, {
            error: `this path contains the workspace ${container}; load that repository on its own instead`,
          });
          return;
        }

        const brief: CodebaseBrief | null = await inspectCodebase(target);
        if (brief === null) {
          sendJson(res, 404, { error: `no such directory: ${target}` });
          return;
        }

        const skillsRoot = await resolveSkillsRoot(settings);
        const installed = await readerSkills(skillsRoot);
        const wanted = String(b['skill'] ?? '').trim();
        const reader: ReaderSkill | null =
          wanted.length === 0
            ? pickReader(installed)
            : (installed.find((s) => s.id === wanted) ?? null);
        if (wanted.length > 0 && reader === null) {
          sendJson(res, 400, {
            error: `no installed skill named "${wanted}" under ${skillsRoot}`,
            readers: installed.map((s) => s.id),
          });
          return;
        }

        let saved: { file: string; added: boolean; roots: readonly string[] };
        try {
          saved = await addWorkspace(target, options.workspacesPath);
        } catch (err) {
          sendJson(res, 409, { error: (err as Error).message });
          return;
        }
        if (!roots.some((r) => resolve(r) === target)) roots.push(target);

        /* `.scratch/` is this tool's own namespace inside a repository, and the
         * document is written once: a second load must not overwrite notes a
         * human has since added to it. */
        const scratch = join(target, '.scratch');
        const docPath = join(scratch, 'CODEBASE.md');
        const already = await stat(docPath).catch(() => null);
        let doc: 'written' | 'kept' = 'written';
        if (already !== null) {
          doc = 'kept';
        } else {
          await mkdir(scratch, { recursive: true });
          await writeFile(docPath, renderCodebaseDoc(brief, reader), 'utf8');
        }

        sendJson(res, saved.added ? 201 : 200, {
          root: target,
          added: saved.added,
          roots,
          file: saved.file,
          doc: { path: docPath, status: doc },
          brief,
          reader,
          project: (await scanProjects([target]))[0] ?? null,
        });
        return;
      }

      if (path === '/api/workspaces/clone' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const remote = String(b['url'] ?? '').trim();
        const dir = String(b['dir'] ?? '').trim();

        /* A URL is handed to git as one argument, never through a shell, and
         * never starting with `-`: that is how a "URL" becomes an option such as
         * `--upload-pack=<command>`. Only the schemes git itself documents are
         * accepted, plus file:// — cloning a local bare repository is a real
         * workflow and needs no network. */
        if (!/^(https?:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[A-Za-z0-9._-]+:[^\s]+|file:\/\/[^\s]+)$/.test(remote)) {
          sendJson(res, 400, {
            error: 'expected an https://, ssh://, git@host:path or file:// URL',
          });
          return;
        }
        if (dir.length === 0 || !isAbsolute(dir)) {
          sendJson(res, 400, { error: 'pass an absolute destination directory' });
          return;
        }
        const dest = resolve(dir);
        const parent = await stat(dirname(dest)).catch(() => null);
        if (parent?.isDirectory() !== true) {
          sendJson(res, 400, { error: `the parent directory does not exist: ${dirname(dest)}` });
          return;
        }
        if ((await stat(dest).catch(() => null)) !== null) {
          sendJson(res, 409, { error: `a file or directory is already there: ${dest}` });
          return;
        }
        /* Cloning is minutes of nothing happening, which is the worst kind of
         * wait to leave unexplained, so it gets a line of its own. Live progress
         * is deliberately *not* claimed: `execFile` reports when git exits, not
         * while it copies, and a progress bar invented from nothing would be
         * the one thing this tool must not do. What is reported is the truth —
         * cloning, then done or failed — with git's own last words attached. */
        const cloning = beginActivity({
          kind: 'clone',
          label: `Cloning ${remote.split('/').pop() ?? remote}`,
          target: dest,
        });
        const cloned = await new Promise<{ ok: boolean; detail: string }>((done) => {
          execFile(
            'git',
            ['clone', '--progress', remote, dest],
            { timeout: 300_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (err, _stdout, stderr) => {
              if (err === null) {
                done({ ok: true, detail: String(stderr).trim().split('\n').slice(-1)[0] ?? '' });
                return;
              }
              done({ ok: false, detail: String(stderr).trim().split('\n').slice(-3).join('\n') || err.message });
            },
          );
        });
        if (!cloned.ok) {
          cloning.note(cloned.detail, 'error');
          cloning.end('failed', cloned.detail);
          sendJson(res, 502, { error: `git clone failed: ${cloned.detail}`, url: remote, dir: dest });
          return;
        }
        cloning.wrote(dest);
        cloning.end('succeeded');
        sendJson(res, 201, { cloned: dest, detail: cloned.detail, url: remote, activityId: cloning.id });
        return;
      }

      /* ---- a folder chooser ----
       *
       * Two branches of "new project" need to look at a directory before
       * committing to it. The git branch has to ask *where* to clone, and the
       * empty-folder branch has to know whether the folder really is empty
       * before promising a fresh start.
       *
       * A text field that accepts `H:\src\proj` serves neither: the human types
       * a path they are guessing at, and discovers they were wrong by failing
       * after the clone or after the register. Looking first is the cheaper way
       * to be sure, and it is the only one that shows what is already there.
       *
       * Only names are returned — no file contents, no recursion — and only over
       * the loopback interface this whole server is bound to, behind the same
       * origin and host checks as every mutating route.
       *
       * A symlinked directory is never offered as a destination, and what makes
       * that true is `withFileTypes`: `isDirectory()` on a `Dirent` describes the
       * link itself, not its target, so a link is not a directory here and cannot
       * reach `dirs`. It is counted under `other` instead, which is why the three
       * counts add up to `entries` — a tally that silently dropped one kind of
       * entry would make `empty` the only number a caller could trust, and
       * `empty` is not enough to tell a folder's contents apart.
       */
      if (path === '/api/browse' && req.method === 'GET') {
        const asked = url.searchParams.get('path');
        const target = asked === null || asked.trim() === '' ? homedir() : resolve(asked);
        const info = await stat(target).catch(() => null);
        if (info?.isDirectory() !== true) {
          sendJson(res, 404, { error: `not a directory: ${target}` });
          return;
        }
        const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
        if (entries === null) {
          // Not an error worth retrying: the OS said no, and the reason is the OS's.
          sendJson(res, 403, { error: `cannot list the contents of ${target}` });
          return;
        }

        const dirs: { name: string; path: string }[] = [];
        let files = 0;
        let other = 0;
        for (const entry of entries) {
          if (entry.isDirectory()) dirs.push({ name: entry.name, path: join(target, entry.name) });
          else if (entry.isFile()) files += 1;
          else other += 1;
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        /* `empty` is the whole answer to "is this a brand-new folder", and it
         * counts hidden entries: a directory holding only `.git` is not empty,
         * and saying otherwise would let a repository be claimed as a fresh
         * start. `files` and `dirs` are what the interface shows beside it. */
        sendJson(res, 200, {
          path: target,
          parent: dirname(target) === target ? null : dirname(target),
          drives: driveRoots(),
          dirs,
          files,
          other,
          entries: entries.length,
          empty: entries.length === 0,
        });
        return;
      }

      /* ---- make a folder ----
       *
       * A chooser that can only pick a folder that already exists forces the
       * human to leave, open Explorer, come back, and re-find the place they
       * were just looking at. Brand-new project, brand-new folder is the common
       * case, not the awkward one.
       *
       * Same trust model as the listing: loopback only, behind the origin and
       * host checks. The parent must already exist — one level at a time, so a
       * typo cannot build a tree nobody asked for.
       *
       * That parent check is the control that holds: once the parent exists, the
       * only new name in the path is the last one, so `{ recursive: false }`
       * below cannot be what stops a tree. It is kept because it says the same
       * thing to the next reader, and because one day the check above may move.
       */
      if (path === '/api/mkdir' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const raw = String(b['path'] ?? '').trim();
        if (raw.length === 0 || !isAbsolute(raw)) {
          sendJson(res, 400, { error: 'pass an absolute path for the new folder' });
          return;
        }
        const target = resolve(raw);
        if (basename(target).length === 0) {
          sendJson(res, 400, { error: `not a folder name: ${target}` });
          return;
        }
        const parent = dirname(target);
        if ((await stat(parent).catch(() => null))?.isDirectory() !== true) {
          sendJson(res, 400, { error: `the parent directory does not exist: ${parent}` });
          return;
        }
        if ((await stat(target).catch(() => null)) !== null) {
          sendJson(res, 409, { error: `a file or folder is already there: ${target}` });
          return;
        }
        await mkdir(target, { recursive: false }).catch(() => undefined);
        if ((await stat(target).catch(() => null))?.isDirectory() !== true) {
          sendJson(res, 500, { error: `the folder could not be created: ${target}` });
          return;
        }
        sendJson(res, 201, { path: target, created: true });
        return;
      }

      /* ---- discovery: reading an existing codebase in three passes ---- */
      if (path === '/api/discover' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const raw = String(b['target'] ?? '').trim();
        const outputRoot = String(b['outputRoot'] ?? '').trim() || 'docs/discovery';
        if (raw.length === 0 || !isAbsolute(raw)) {
          sendJson(res, 400, { error: 'pass an absolute directory to read' });
          return;
        }
        const target = resolve(raw);
        if ((await stat(target).catch(() => null))?.isDirectory() !== true) {
          sendJson(res, 404, { error: `not a directory: ${target}` });
          return;
        }
        /* One discovery per target. Two agents writing one set of docs would
         * overwrite each other, and the later one would win by no decision
         * anyone made. */
        const busy = [...discoveryJobs.values()].find(
          (j) => j.status === 'running' && j.target === target,
        );
        if (busy !== undefined) {
          sendJson(res, 409, {
            error: `a discovery is already reading ${target}`,
            jobId: busy.jobId,
          });
          return;
        }

        const skillsRoot = await resolveSkillsRoot(settings);
        const asked = String(b['skill'] ?? '').trim();
        const skill =
          asked !== '' ? asked : (pickReader(await readerSkills(skillsRoot))?.id ?? DEFAULT_READER);
        const skillPath = join(skillsRoot, skill, 'SKILL.md');

        /* Refuse before spending anything on it. A skill named but not installed
         * is the one failure here that costs real money to discover: the agent
         * would run, find no file at that path, and write a plausible analysis
         * instead — which is worse than an error, because it looks like it
         * worked. */
        if ((await stat(skillPath).catch(() => null))?.isFile() !== true) {
          sendJson(res, 400, {
            error: `the reading skill is not installed: no file at ${skillPath}`,
            skill,
            skillsRoot,
          });
          return;
        }

        const job: DiscoveryJob = {
          jobId: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          target,
          skill,
          skillPath,
          outputRoot,
          startedAt: new Date().toISOString(),
          status: 'running',
          endedAt: null,
          error: null,
          phases: DISCOVERY_PHASES.map((p) => ({ id: p.id, status: 'pending', error: null })),
        };
        discoveryJobs.set(job.jobId, job);
        await mkdir(join(target, '.governance', 'discovery'), { recursive: true }).catch(
          () => undefined,
        );

        /* The activity is opened before the work starts and handed the same
         * lifetime, so "what is it doing" has an answer from the first moment —
         * including while the caller is deciding whether to keep watching. */
        const activity = beginActivity({
          kind: 'discovery',
          label: `Reading ${basename(target) || target}`,
          target,
        });
        activity.note(`reading with ${skill}, writing to ${outputRoot}`, 'start');
        job.activityId = activity.id;

        /* Not awaited: the passes outlive this response, and the caller polls.
         * 202 says exactly that — accepted, not finished. */
        void runDiscoveryJob(
          job,
          runnerFor(settings),
          resolveAgentFor(settings).model,
          settings.agents.timeoutMin * 60 * 1000,
          AGENT_TOOLS,
          activity,
        ).catch((err: unknown) => {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          job.endedAt = new Date().toISOString();
          activity.end('failed', job.error);
        });

        sendJson(res, 202, {
          jobId: job.jobId,
          activityId: activity.id,
          status: job.status,
          target: job.target,
          skill: job.skill,
          outputRoot: job.outputRoot,
          phases: job.phases,
        });
        return;
      }

      if (path === '/api/discover' && req.method === 'GET') {
        const jobId = url.searchParams.get('jobId');
        if (jobId === null) {
          sendJson(res, 400, { error: 'pass a jobId' });
          return;
        }
        const job = discoveryJobs.get(jobId);
        if (job === undefined) {
          /* Restarting the server drops these. Saying so beats a 404 that looks
           * like the caller named a job that never existed. */
          sendJson(res, 404, {
            error: `no discovery job "${jobId}" — jobs are held in memory and do not survive a restart`,
          });
          return;
        }
        /* The files are read back from disk, never remembered from the plan:
         * what the interface shows is what the passes actually wrote. */
        sendJson(res, 200, {
          jobId: job.jobId,
          status: job.status,
          target: job.target,
          skill: job.skill,
          outputRoot: job.outputRoot,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          error: job.error,
          phases: job.phases,
          files: await producedFiles(job.target, job.outputRoot),
        });
        return;
      }

      /* ---- discovered areas, and features made from them ----
       *
       * Reading a codebase ends with documents. Nothing has been decided about
       * any of them. These two endpoints are the bridge: one reports what the
       * reading named, the other turns a chosen area into a feature that starts
       * at intake with a reason and a reading list.
       *
       * Separated on purpose. Deriving is not idempotent — each call is a
       * decision, so it makes a feature — and an endpoint that listed and
       * created in one step would derive every area every time the page
       * rendered.
       */
      if (path === '/api/areas' && req.method === 'GET') {
        const asked = legacyParam(url.searchParams, 'root');
        const outputRoot = (url.searchParams.get('outputRoot') ?? '').trim() || 'docs/discovery';
        if (asked === null || asked.trim().length === 0 || !isAbsolute(asked)) {
          sendJson(res, 400, { error: 'pass an absolute project root' });
          return;
        }
        const target = resolve(asked);
        if (!isAllowedRoot(roots, target)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${target}` });
          return;
        }
        const areas = await discoveredAreas(target, outputRoot);
        sendJson(res, 200, { root: target, outputRoot, areas, count: areas.length });
        return;
      }

      if (path === '/api/areas/features' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const raw = String(b['root'] ?? '').trim();
        const outputRoot = String(b['outputRoot'] ?? '').trim() || 'docs/discovery';
        if (raw.length === 0 || !isAbsolute(raw)) {
          sendJson(res, 400, { error: 'pass an absolute project root' });
          return;
        }
        const target = resolve(raw);
        if (!isAllowedRoot(roots, target)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${target}` });
          return;
        }
        const all = await discoveredAreas(target, outputRoot);
        if (all.length === 0) {
          sendJson(res, 409, {
            error: `the reading named no areas under ${outputRoot}/areas`,
            hint: 'run the reading again, or name the areas yourself',
          });
          return;
        }
        /* Only what was asked for. A caller that sends nothing gets nothing
         * rather than everything: creating features is not reversible by
         * reloading the page. */
        const wanted = Array.isArray(b['slugs'])
          ? (b['slugs'] as unknown[]).map((s) => String(s))
          : null;
        const chosen =
          wanted === null
            ? all
            : all.filter((a) => wanted.includes(a.slug));
        if (chosen.length === 0) {
          sendJson(res, 400, { error: 'none of the requested areas were found', areas: all.map((a) => a.slug) });
          return;
        }

        const activity = beginActivity({
          kind: 'derive',
          label: `Making ${chosen.length} feature(s) from what the reading found`,
          target,
        });
        activity.note(`areas: ${chosen.map((a) => a.name).join(', ')}`, 'start');
        try {
          const made = await deriveAreaFeatures({
            root: target,
            outputRoot,
            areas: chosen,
          });
          for (const f of made) activity.wrote(`.scratch/${f.slug}/INHERITED.md`);
          activity.end('succeeded');
          sendJson(res, 201, {
            root: target,
            outputRoot,
            created: made,
            activityId: activity.id,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          activity.end('failed', message);
          sendJson(res, 500, { error: message });
        }
        return;
      }

      /* ---- what is happening right now ----
       *
       * Polled, not streamed: one request, one answer, and a client that stops
       * asking stops costing anything. A socket would be more elegant and would
       * also leave a connection per open tab, which is the wrong trade for a
       * tool that runs one agent at a time.
       */
      if (path === '/api/activity' && req.method === 'GET') {
        const items = readActivity();
        sendJson(res, 200, {
          items,
          running: items.filter((x) => x.status === 'running').length,
        });
        return;
      }

      if (path === '/api/gates' && req.method === 'GET') {
        const projects = await scanProjects(roots);
        const out = [];
        for (const p of projects) {
          for (const e of p.features) {
            const decisions = await readDecisions(e.root);
            for (const g of e.gates) {
              out.push({
                id: `${p.name}/${e.slug}/${g.id}`,
                state: gateState(g, decisions),
                gate: g,
              });
            }
          }
        }
        sendJson(res, 200, out);
        return;
      }

      if (path === '/api/decisions' && req.method === 'GET') {
        const target = legacyParam(url.searchParams, 'feature');
        if (target === null) {
          sendJson(res, 400, { error: 'feature query parameter is required' });
          return;
        }
        const resolved = await resolveTarget(roots, `${target}`);
        if ('error' in resolved) {
          sendJson(res, 400, resolved);
          return;
        }
        sendJson(res, 200, await readDecisions(resolved.featureDir));
        return;
      }

      if (path === '/api/decide' && req.method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: 'body is not JSON' });
          return;
        }
        const b = body as Record<string, unknown>;
        const gateRef = typeof b['gate'] === 'string' ? b['gate'] : '';
        const resolved = await resolveTarget(roots, gateRef);
        if ('error' in resolved) {
          sendJson(res, 400, resolved);
          return;
        }

        if (!isOutcome(b['outcome'])) {
          sendJson(res, 400, { error: 'unknown outcome' });
          return;
        }
        if (!isRole(b['actor'])) {
          sendJson(res, 400, { error: 'unknown role' });
          return;
        }
        const methods = Array.isArray(b['methods']) ? b['methods'] : [];
        if (methods.some((m) => !isMethod(m))) {
          sendJson(res, 400, { error: 'unknown method' });
          return;
        }
        const evidence = Array.isArray(b['evidence'])
          ? b['evidence'].filter((e): e is string => typeof e === 'string')
          : [];

        const decision = makeDecision({
          gate: resolved.gateId,
          outcome: b['outcome'],
          actor: b['actor'],
          methods: methods as MethodId[],
          evidence,
          ...(typeof b['note'] === 'string' ? { note: b['note'] } : {}),
          ...(typeof b['reason'] === 'string' ? { reason: b['reason'] } : {}),
        });

        try {
          const stored = await appendDecision(resolved.featureDir, decision);
          sendJson(res, 201, stored);
        } catch (err) {
          // A rejected decision is a 400, not a 500: the caller's input was
          // wrong, and the message says which rule it broke.
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (path === '/api/open-gates' && req.method === 'GET') {
        const projects = await scanProjects(roots);
        const out = [];
        for (const p of projects) {
          for (const e of p.features) {
            const open = openBlockingGates(e.gates, await readDecisions(e.root));
            for (const g of open) {
              out.push({ id: `${p.name}/${e.slug}/${g.id}`, gate: g, feature: e.slug });
            }
          }
        }
        sendJson(res, 200, out);
        return;
      }

      /* ---- settings ---- */

      if (path === '/api/settings' && req.method === 'GET') {
        const result = await readSettings(options.settingsPath);
        sendJson(res, 200, {
          settings: result.settings,
          warnings: result.warnings,
          // The path is sent so the UI can show where a hand edit should go.
          source: result.source,
          skillsRoot: DEFAULT_SKILLS_ROOT,
        });
        return;
      }

      if (path === '/api/settings' && req.method === 'PUT') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: 'body is not JSON' });
          return;
        }
        // Validate before writing: the file is read by the runner, so a bad
        // value here would become a bad run later.
        const parsed = parseSettings((body as Record<string, unknown>)['settings'] ?? body);
        const file = await writeSettings(parsed.settings, options.settingsPath);
        sendJson(res, 200, {
          settings: parsed.settings,
          warnings: parsed.warnings,
          source: file,
        });
        return;
      }

      /* ---- the skill chain, as configured ---- */

      if (path === '/api/chain' && req.method === 'GET') {
        const { settings } = await readSettings(options.settingsPath);
        const skillsRoot = await resolveSkillsRoot(settings);
        const out = [];
        for (const s of settings.skills) {
          const path = s.id.length === 0 ? null : join(skillsRoot, s.id, 'SKILL.md');
          const present = path === null ? null : (await stat(path).catch(() => null)) !== null;
          out.push({
            stage: s.stage,
            skill: s.id.length === 0 ? null : s.id,
            enabled: s.enabled,
            path,
            // Read from disk, not assumed: a skill the settings name but the
            // machine does not have is the failure worth showing.
            present,
            mcp: mcpForStage(settings, s.stage).map((m) => m.name),
          });
        }
        sendJson(res, 200, { skillsRoot, chain: out });
        return;
      }

      /* ---- MCP: list, and a real handshake attempt ---- */

      if (path === '/api/mcp' && req.method === 'GET') {
        const { settings } = await readSettings(options.settingsPath);
        sendJson(res, 200, {
          servers: settings.mcp.map((m) => ({
            ...m,
            // What the settings cannot know: whether the command exists at all.
            reachable: null,
          })),
        });
        return;
      }

      if (path === '/api/mcp/test' && req.method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: 'body is not JSON' });
          return;
        }
        const name = String((body as Record<string, unknown>)['name'] ?? '');
        const { settings } = await readSettings(options.settingsPath);
        const server = settings.mcp.find((m) => m.name === name);
        if (server === undefined) {
          sendJson(res, 404, { error: `no MCP server named ${name}` });
          return;
        }
        sendJson(res, 200, await probeMcp(server));
        return;
      }

      /* ---- concept init: create a feature for real ---- */

      if (path === '/api/init' && req.method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: 'body is not JSON' });
          return;
        }
        const b = body as Record<string, unknown>;
        const rootRaw = String(b['root'] ?? '');
        const root = resolve(rootRaw);

        // The root must be one of the configured workspaces. Accepting an
        // arbitrary path from a request would make this an endpoint that writes
        // anywhere on the machine.
        const allowed = roots.some((r) => resolve(r) === root);
        if (!allowed) {
          sendJson(res, 403, {
            error: `root is not a configured workspace: ${root}`,
            workspaces: roots,
          });
          return;
        }

        try {
          const result = await scaffoldFeature({
            root,
            feature: legacyBody(b, 'feature'),
            title: String(b['title'] ?? legacyBody(b, 'feature')),
            destination: String(b['destination'] ?? ''),
            notes: asStringArray(b['notes']),
            decisions: asStringArray(b['decisions']),
            notYetSpecified: asStringArray(b['notYetSpecified']),
            outOfScope: asStringArray(b['outOfScope']),
            glossary: asGlossary(b['glossary']),
            prd: asPrd(b['prd']),
            prototypeTickets: asPrototypes(b['prototypeTickets']),
          });
          sendJson(res, 201, result);
        } catch (err) {
          if (err instanceof ScaffoldError) {
            sendJson(res, err.status, { error: err.message });
            return;
          }
          throw err;
        }
        return;
      }

      /* ---- the grilling session ----
       *
       * These are the only endpoints that spend money, so they are the only ones
       * that run an agent. Everything else reads. */

      if (path === '/api/session/agent' && req.method === 'GET') {
        // "Installed", "can execute", and "is authenticated" are three different
        // facts, and only the third means a turn will work. The reason travels
        // with the result so the interface can say which one is missing rather
        // than reporting a working CLI as broken.
        if (options.demo === true) {
          /* In demo mode the real CLI is irrelevant, so it is not probed.
           *
           * Probing it anyway produced a contradiction on screen: a red error
           * saying the agent could not be used, immediately above a note saying
           * the flow could be walked regardless. The demo is what will run, so
           * the demo is what is reported — and skipping the probe also saves the
           * several seconds a real turn costs. */
          sendJson(res, 200, {
            available: true,
            reason: 'demo',
            detail: 'a scripted agent answers; the real CLI is not used',
            version: null,
            cli: settings.agents.cli,
            demo: true,
            demoAvailable: true,
          });
          return;
        }
        if (settings.agents.transport === 'api') {
          // The API transport is probed with the same honesty as the CLI: the
          // key being set is not evidence a turn works, so a real minimal call
          // is made. The reason categories are shared, so the interface needs
          // no new copy for this transport.
          const probe = await probeApi({
            apiBase: settings.agents.apiBase,
            model: settings.agents.apiModel,
            apiKeyEnv: settings.agents.apiKeyEnv,
            apiKey: () => process.env[settings.agents.apiKeyEnv],
          });
          sendJson(res, 200, {
            ...probe,
            cli: settings.agents.apiBase,
            transport: 'api',
            demo: false,
            demoAvailable: false,
          });
          return;
        }
        const resolvedAgent = resolveAgentFor(settings);
        /* The model travels with the probe: "ok" must mean *this* model ran,
         * not that some model ran. */
        const probe = await probeCli(resolvedAgent.cli, spawn, 20000, undefined, undefined, resolvedAgent.model);
        sendJson(res, 200, {
          ...probe,
          cli: resolvedAgent.cli,
          transport: 'cli',
          model: resolvedAgent.model,
          provider: resolvedAgent.provider,
          demo: false,
          // Whether a credential-free path exists. The interface offers it when
          // the real one cannot run, which is the difference between "you cannot
          // try this" and "you cannot try it this way yet".
          demoAvailable: false,
        });
        return;
      }

      /* A connection test the user asked for, against the configuration the
       * user is looking at — possibly one not saved yet, so the body carries
       * overrides. It runs the same probe the boot probe runs: a version
       * check, then a real minimal turn. A non-empty input check would prove
       * nothing. Local models (no key) are a valid configuration, not an
       * error, so the probe makes no assumption about credentials. */
      if (path === '/api/agent/test' && req.method === 'POST') {
        const body = (await readJsonBody(req, res)) ?? {};
        const base = parseSettings({
          ...(settings as unknown as Record<string, unknown>),
          agents: {
            ...(settings.agents as unknown as Record<string, unknown>),
            cli: typeof body.cli === 'string' && body.cli !== '' ? body.cli : settings.agents.cli,
          },
        }).settings;
        const resolved = resolveAgentFor(base);
        /* The model override is applied after resolution so the test exercises
         * exactly what the user typed, not the merged default. */
        const model =
          typeof body.model === 'string' && body.model !== '' ? body.model : resolved.model;
        /* The probe runs the model the UI is about to display as tested — the
         * override included. Anything else validates a configuration nobody
         * configured. */
        const probe = await probeCli(resolved.cli, spawn, 20000, undefined, undefined, model);
        sendJson(res, 200, {
          ...probe,
          cli: resolved.cli,
          model,
          provider: resolved.provider,
          apiKeyEnv: resolved.apiKeyEnv,
          /* Honest presence check, not a value: the UI shows whether the named
           * variable is set without ever receiving the key itself. */
          apiKeySet: resolved.apiKeyEnv !== '' && process.env[resolved.apiKeyEnv] !== undefined,
        });
        return;
      }

      if (path === '/api/session' && req.method === 'GET') {
        const root = url.searchParams.get('root');
        const feature = legacyParam(url.searchParams, 'feature');
        if (root === null || feature === null) {
          sendJson(res, 400, { error: 'root and feature are required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, feature);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        const state = await readSession(featureDir);
        if (state === null) {
          sendJson(res, 404, { error: `no session for "${feature}"` });
          return;
        }
        sendJson(res, 200, { ...state, history: await readRoundHistory(featureDir) });
        return;
      }

      if (path === '/api/session/start' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, {
            error: `root is not a configured workspace: ${resolve(root)}`,
            workspaces: roots,
          });
          return;
        }
        try {
          const state = await startSession(ports(), {
            repoRoot: root,
            feature: legacyBody(b, 'feature'),
            idea: String(b['idea'] ?? ''),
          });
          sendJson(res, 201, await withHistory(state));
        } catch (err) {
          sendSessionError(res, err);
        }
        return;
      }

      if (path === '/api/session/answer' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        const answers = Array.isArray(b['answers'])
          ? (b['answers'] as unknown[]).flatMap((a) => {
              if (a === null || typeof a !== 'object') return [];
              const o = a as Record<string, unknown>;
              return [{ id: String(o['id'] ?? ''), answer: String(o['answer'] ?? '') }];
            })
          : [];
        try {
          const state = await answerSession(ports(), {
            repoRoot: root,
            feature: legacyBody(b, 'feature'),
            answers,
          });
          sendJson(res, 200, await withHistory(state));
        } catch (err) {
          sendSessionError(res, err);
        }
        return;
      }

      if (path === '/api/session/reset' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        try {
          // `confirm` defaults to false, so an accidental request is a preview.
          const result = await resetSession({
            repoRoot: root,
            feature: legacyBody(b, 'feature'),
            confirm: b['confirm'] === true,
          });
          sendJson(res, result.removed ? 200 : 200, result);
        } catch (err) {
          sendSessionError(res, err);
        }
        return;
      }

      if (path === '/api/session/finalise' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        try {
          const state = await finaliseSession(ports(), {
            repoRoot: root,
            feature: legacyBody(b, 'feature'),
            force: b['force'] === true,
          });
          sendJson(res, 200, await withHistory(state));
        } catch (err) {
          sendSessionError(res, err);
        }
        return;
      }

      /* ---- stage runs: the control plane ----
       *
       * These are the endpoints that let the board drive the loop instead of
       * only watching it. Every one of them can spend money or write into a
       * workspace, which is why the guard above runs before this code and not
       * after it. */

      if (path === '/api/runs' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        const featureSlug = legacyBody(b, 'feature');
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, {
            error: `root is not a configured workspace: ${resolve(root)}`,
            workspaces: roots,
          });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, featureSlug);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        const projects = await scanProjects([resolve(root)]);
        const feature = projects[0]?.features.find((e) => e.slug === featureSlug);
        if (feature === undefined) {
          sendJson(res, 404, { error: `no feature "${featureSlug}" under ${resolve(root)}` });
          return;
        }
        try {
          /* A stage run is the longest thing this tool does, and it used to be
           * visible only as a job id. From here on it has a line: which stage,
           * on what, and the agent's own output as it arrives. */
          const activity = beginActivity({
            kind: 'run',
            label: `Working on ${featureSlug}`,
            target: resolve(root),
          });
          const { jobId, plan } = await registry.submit({
            root: resolve(root),
            featureDir,
            feature,
            settings,
            skillsRoot: await resolveSkillsRoot(settings),
            maxParallel: settings.agents.maxParallel,
            timeoutMs: settings.agents.timeoutMin * 60 * 1000,
            onOutput: (chunk) => {
              for (const line of readableLines(chunk)) activity.note(line);
            },
          });
          /* Which stage is decided by the planner, not the caller, so it is
           * named here — after the plan exists — rather than guessed in the
           * label above. */
          activity.note(
            `${plan.stage ?? 'stage'} · ${plan.skill ?? 'no skill'} → ${plan.logPath}`,
            'start',
          );
          watchJob(registry, jobId, activity);
          rememberRun(jobId, activity);
          /* 202, not 201: the run has been accepted, not finished. The plan
           * travels with the receipt — what will run, with what argv, and
           * where the transcript will land. */
          sendJson(res, 202, {
            jobId,
            activityId: activity.id,
            status: 'running',
            demo: options.demo === true,
            plan: {
              stage: plan.stage,
              skill: plan.skill,
              skillPath: plan.skillPath,
              command: plan.command,
              prompt: plan.prompt,
              logPath: plan.logPath,
              mcp: plan.mcp,
            },
          });
        } catch (err) {
          /* A refusal carries the gates that caused it. "No" without *which*
           * question is unanswered leaves the caller with nothing to do. */
          if (err instanceof JobError) {
            sendJson(res, err.status, {
              error: err.message,
              ...(err.gates.length > 0 ? { gates: err.gates } : {}),
            });
          } else throw err;
        }
        return;
      }

      if (path === '/api/runs' && req.method === 'GET') {
        const root = url.searchParams.get('root');
        const feature = legacyParam(url.searchParams, 'feature');
        if (root === null && feature === null) {
          sendJson(res, 200, { active: registry.active() });
          return;
        }
        if (root === null || feature === null) {
          sendJson(res, 400, { error: 'root and feature are both required for a run history' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, feature);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        /* The last time the AFK chain stopped here, and why.
         *
         * The activity line that reports a stop lives in memory and a restart
         * clears it, so a person arriving later sees a list of green runs and no
         * answer to "why is nothing happening?" The journal keeps it, and the
         * runs card is where that person is already looking. */
        const journalRead = await readJournal(featureDir);
        const lastStop =
          [...journalRead.events].reverse().find((e) => e.kind === 'chain.stopped') ?? null;
        sendJson(res, 200, {
          records: await readRunRecords(featureDir),
          logs: await readStageLogs(featureDir),
          active: registry.active().filter((j) => j.feature === feature),
          lastStop,
        });
        return;
      }

      if (path === '/api/dossier' && req.method === 'GET') {
        const root = url.searchParams.get('root');
        const feature = legacyParam(url.searchParams, 'feature');
        if (root === null || feature === null) {
          sendJson(res, 400, { error: 'root and feature are both required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, feature);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        const projects = await scanProjects([resolve(root)]);
        const scanned = projects[0]?.features.find((e) => e.slug === feature);
        if (scanned === undefined) {
          sendJson(res, 404, { error: `no feature "${feature}" under ${resolve(root)}` });
          return;
        }
        sendJson(res, 200, await readDossier(scanned, featureDir));
        return;
      }

      /* The integration artifact for one feature: the branch it belongs on and a
       * pull-request body composed from the record.
       *
       * `GET`, not `POST`: composing costs nothing and touches nothing. This is
       * the answer to "what do I even write in the PR?" — and because it is
       * derived, it cannot disagree with the feature it describes. */
      if (path === '/api/pr' && req.method === 'GET') {
        const root = url.searchParams.get('root');
        const feature = legacyParam(url.searchParams, 'feature');
        if (root === null || feature === null) {
          sendJson(res, 400, { error: 'root and feature are both required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, feature);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        const projects = await scanProjects([resolve(root)]);
        const scanned = projects[0]?.features.find((e) => e.slug === feature);
        if (scanned === undefined) {
          sendJson(res, 404, { error: `no feature "${feature}" under ${resolve(root)}` });
          return;
        }
        const dossier = await readDossier(scanned, featureDir);
        sendJson(res, 200, {
          ...composePullRequest({
            dossier,
            project: projects[0]!.name,
            feature,
            git: settings.git,
            derivedFrom: scanned.derivedFrom ?? null,
          }),
        });
        return;
      }

      if (path === '/api/change-request' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        const featureSlug = legacyBody(b, 'feature');
        const text = String(b['text'] ?? '').trim();
        if (root === '' || featureSlug === '' || text === '') {
          sendJson(res, 400, { error: 'root, feature and text are all required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, featureSlug);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        /* A change is not a ticket: a ticket is a unit of work already specified.
         * A change is new requirement input. Before anything is written, it is
         * **routed** — the routing decides whether this feature amends itself or a
         * new feature is opened on top of a released baseline, and that is the
         * system's decision because it follows from facts, not taste.
         *
         * Triage reads the state *before* the change exists: acceptance is one of
         * its inputs, and an open change legitimately un-completes the stages
         * that acceptance would otherwise be read from. */
        const projects = await scanProjects([resolve(root)]);
        const feature = projects[0]?.features.find((e) => e.slug === featureSlug);
        if (feature === undefined) {
          sendJson(res, 404, { error: `no feature "${featureSlug}" under ${resolve(root)}` });
          return;
        }
        const verdict = classifyChange({ text, accepted: feature.accepted === true });

        const { events } = await readJournal(featureDir);
        const id = nextChangeId(events);
        const opened = await appendEvent(featureDir, {
          kind: 'change.opened',
          ref: id,
          detail: text.slice(0, 120),
          data: { text },
        });
        /* The verdict is its own line, not a field on the open: a decision made
         * by a rule table is a decision somebody may need to argue with, and an
         * argument needs the rule and the words it matched. */
        await appendEvent(featureDir, {
          kind: 'change.decided',
          ref: id,
          detail: `${verdict.kind} → ${verdict.path} (${verdict.rule})`,
          data: { verdict },
        });

        /* A follow-up is created here, at filing — not offered as a suggestion.
         * A routing that waits for a click is a routing the human has to make
         * twice, and the second time they have less context than the sentence
         * they just wrote. */
        let child: string | null = null;
        if (verdict.path === 'follow-up') {
          const derived = await deriveFeature({
            root: resolve(root),
            parentSlug: featureSlug,
            parentDir: featureDir,
            change: { id, text },
            verdict,
          });
          child = derived.slug;
          await appendEvent(featureDir, {
            kind: 'change.followed-up',
            ref: id,
            detail: `moved to ${child}`,
            data: { child, note: verdict.why },
          });
        }

        /* The loop had no ignition. Filing a change reopened requirements, and a
         * reopened requirements stage that nobody runs stays open forever — which
         * is what "the change did not continue" actually was: not a broken chain,
         * but one that was never started.
         *
         * Under AFK the person has already said *run unattended*, so the first
         * stage is lit here. Without AFK nothing happens but the record, and that
         * is deliberate: starting an agent is the thing that costs money, and it
         * stays a click. */
        let started: readonly string[] = [];
        /* A follow-up handles the change that was routed out, but the parent may
         * still be carrying *other* open changes — routing one away does not
         * answer the rest, and each is a requirements question of its own. Both
         * are lit; if the parallel cap refuses the second, the change is still on
         * the record and the loop catches up on the next attempt. */
        const targets = child === null ? [featureSlug] : [child, featureSlug];
        for (const target of targets) {
          const input = await inputsFor(resolve(root), target);
          if (input === null) continue;
          if ((input.feature.openChanges ?? 0) === 0 && target === featureSlug && child !== null) continue;
          try {
            const submitted = await registry.submit(input);
            started = [...started, submitted.jobId];
          } catch (err) {
            /* A refusal here is an ordinary state, not an error to surface to the
             * caller: a run already in progress for this feature, the parallel cap,
             * an open gate. The change is filed either way. */
            console.warn(
              `[change] no run started on ${input.feature.slug}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }

        sendJson(res, 201, {
          change: {
            id,
            text,
            openedAt: opened.at,
            status: child === null ? 'open' : 'closed',
            verdict,
          },
          verdict,
          child,
          started,
        });
        return;
      }

      /* ---- a change, from a sentence ----
       *
       * "Change 登陆 to 登录 on the login page" does not name a feature, and the
       * person writing it should not have to go and find out which of twelve it
       * is. So the sentence is routed: the tool looks, and says what it found
       * and why. Where the rules cannot tell, it says so and hands the shortlist
       * back rather than taking the first — a wrong guess writes a decision into
       * the wrong feature's journal, which is harder to undo than to ask about.
       */
      /**
       * Every feature's own words, including the ones a derived feature only
       * has in its INHERITED.md.
       *
       * A feature made from a reading has no map and no destination, so without
       * this the only thing a sentence can match is the slug — and a request
       * about a "quote request" finds nothing at all, even though the feature
       * exists precisely because the reading named it in those words.
       */
      const featuresForMatching = async (root: string, features: readonly Feature[]) =>
        Promise.all(
          features.map(async (e) => {
            const inherited = await inheritedWords(root, e.slug);
            return inherited === null ? e : { ...e, notes: [...e.notes, inherited] };
          }),
        );

      if (path === '/api/change/find' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        const text = String(b['text'] ?? '').trim();
        if (root === '' || text === '') {
          sendJson(res, 400, { error: 'root and text are both required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        const projects = await scanProjects([resolve(root)]);
        const listed = projects[0]?.features ?? [];
        const features = await featuresForMatching(resolve(root), listed);
        const located = locateFeature(features, text);
        sendJson(res, 200, {
          root: resolve(root),
          text,
          ...located,
          /* Offered only when the rules could not decide, and never silently:
           * an agent call is the expensive way to answer this, so it is a
           * separate step the caller takes knowingly. */
          askPrompt:
            located.confident || located.candidates.length < 2
              ? null
              : disambiguationPrompt(text, located.candidates, features),
        });
        return;
      }

      if (path === '/api/change/apply' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        const text = String(b['text'] ?? '').trim();
        const given = legacyBody(b, 'feature').trim();
        if (root === '' || text === '') {
          sendJson(res, 400, { error: 'root and text are both required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        const projects = await scanProjects([resolve(root)]);
        const listed = projects[0]?.features ?? [];
        const features = await featuresForMatching(resolve(root), listed);
        if (features.length === 0) {
          sendJson(res, 409, { error: `there are no features under ${resolve(root)} to change` });
          return;
        }

        const located = locateFeature(features, text);
        const slug =
          given !== ''
            ? given
            : located.confident && located.best !== null
              ? located.best.slug
              : '';
        if (slug === '') {
          /* Not a failure to guess: a refusal to guess. The sentence is kept, so
           * the human does not have to type it again after choosing. */
          sendJson(res, 200, {
            needsChoice: true,
            text,
            root: resolve(root),
            candidates: located.candidates,
            askPrompt: disambiguationPrompt(text, located.candidates, features),
          });
          return;
        }
        const feature = features.find((e) => e.slug === slug);
        if (feature === undefined) {
          sendJson(res, 404, { error: `no feature "${slug}" under ${resolve(root)}`, features: features.map((f) => f.slug) });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(resolve(root), slug);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }

        const activity = beginActivity({
          kind: 'change',
          label: `Changing ${slug}`,
          target: resolve(root),
        });
        activity.note(text, 'start');

        const verdict = classifyChange({ text, accepted: feature.accepted === true });
        const { events } = await readJournal(featureDir);
        const id = nextChangeId(events);
        await appendEvent(featureDir, {
          kind: 'change.opened',
          ref: id,
          detail: text.slice(0, 120),
          data: { text, locatedBy: given !== '' ? 'stated' : 'locate', confidence: located.confident },
        });
        await appendEvent(featureDir, {
          kind: 'change.decided',
          ref: id,
          detail: `${verdict.kind} → ${verdict.path} (${verdict.rule})`,
          data: { verdict },
        });

        /* The requirements document moves with the change, and says what it said
         * before. A spec that still describes the old design is the most
         * expensive kind of stale, because it looks current. */
        const { file, amendment } = await recordAmendment(featureDir, { id, text });
        activity.wrote(file.replace(resolve(root), '.'));

        let child: string | null = null;
        if (verdict.path === 'follow-up') {
          const derived = await deriveFeature({
            root: resolve(root),
            parentSlug: slug,
            parentDir: featureDir,
            change: { id, text },
            verdict,
          });
          child = derived.slug;
          await appendEvent(featureDir, {
            kind: 'change.followed-up',
            ref: id,
            detail: `moved to ${child}`,
            data: { child, note: verdict.why },
          });
          activity.wrote(`.scratch/${child}/INHERITED.md`);
        }

        const started: string[] = [];
        for (const target of child === null ? [slug] : [child, slug]) {
          const input = await inputsFor(resolve(root), target);
          if (input === null) continue;
          try {
            const submitted = await registry.submit({
              ...input,
              onOutput: (chunk) => {
                for (const line of readableLines(chunk)) activity.note(line);
              },
            });
            started.push(submitted.jobId);
            watchJob(registry, submitted.jobId, activity);
          } catch (err) {
            console.warn(
              `[change] no run started on ${target}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        activity.note(`${verdict.kind} → ${verdict.path}; ${started.length} run(s) lit`);

        sendJson(res, 201, {
          change: { id, text, status: child === null ? 'open' : 'closed', verdict },
          feature: slug,
          located,
          verdict,
          amendment,
          child,
          started,
          activityId: activity.id,
        });
        return;
      }

      if (path === '/api/change-close' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        const featureSlug = legacyBody(b, 'feature');
        const id = String(b['id'] ?? '').trim();
        const note = String(b['note'] ?? '').trim();
        if (root === '' || featureSlug === '' || id === '') {
          sendJson(res, 400, { error: 'root, feature and id are all required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, featureSlug);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        const { events } = await readJournal(featureDir);
        const open = changesFrom(events).find((c) => c.id === id && c.status === 'open');
        if (open === undefined) {
          sendJson(res, 404, { error: `no open change "${id}" on ${featureSlug}` });
          return;
        }
        const closed = await appendEvent(featureDir, {
          kind: 'change.closed',
          ref: id,
          detail: note.length > 0 ? note : 'closed without a note',
          data: { note },
        });
        sendJson(res, 200, { change: { id, status: 'closed', closedAt: closed.at, note } });
        return;
      }

      if (path === '/api/file' && req.method === 'GET') {
        const root = url.searchParams.get('root');
        const featureSlug = legacyParam(url.searchParams, 'feature');
        const rel = (url.searchParams.get('path') ?? '').trim();
        if (root === null || featureSlug === null || rel === '') {
          sendJson(res, 400, { error: 'root, feature and path are all required' });
          return;
        }
        if (!isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, featureSlug);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        /* The guard that makes this safe to expose on a page: `../..` in the
         * path is resolved first and then refused, so a request cannot read
         * outside the feature whose record it is looking at. */
        const file = insideBase(featureDir, rel);
        if (file === null) {
          sendJson(res, 400, { error: `path escapes the feature: ${rel}` });
          return;
        }
        const info = await stat(file).catch(() => null);
        if (info === null || !info.isFile()) {
          sendJson(res, 404, { error: `no file "${rel}" in ${featureSlug}` });
          return;
        }
        const shown = rel.replace(/\\/g, '/');
        const common = {
          path: shown,
          name: basename(file),
          size: info.size,
          at: info.mtime.toISOString(),
          lang: langOf(file),
        };
        if (info.size > MAX_PREVIEW_BYTES) {
          /* Refuse the body, keep the metadata: the page can still say what the
           * artifact is and offer to open it, which is better than an empty
           * panel or half a file pretending to be the whole one. */
          sendJson(res, 200, { ...common, tooLarge: true, binary: false, text: null });
          return;
        }
        const buf = await readFile(file);
        const binary = buf.subarray(0, 1024).includes(0);
        sendJson(res, 200, {
          ...common,
          tooLarge: false,
          binary,
          text: binary ? null : buf.toString('utf8'),
        });
        return;
      }

      if (path === '/api/reveal' && req.method === 'POST') {
        const b = await readJsonBody(req, res);
        if (b === null) return;
        const root = String(b['root'] ?? '');
        const featureSlug = legacyBody(b, 'feature');
        const rel = String(b['path'] ?? '').trim();
        const mode = b['mode'] === 'vscode' ? 'vscode' : b['mode'] === 'folder' ? 'folder' : null;
        if (mode === null) {
          sendJson(res, 400, { error: 'mode must be "folder" or "vscode"' });
          return;
        }
        if (root === '' || !isAllowedRoot(roots, root)) {
          sendJson(res, 403, { error: `root is not a configured workspace: ${resolve(root)}` });
          return;
        }
        let featureDir: string;
        try {
          featureDir = resolveFeatureDir(root, featureSlug);
        } catch (err) {
          sendJson(res, (err as SessionError).status ?? 400, { error: (err as Error).message });
          return;
        }
        /* Two scopes, both already proved safe: the feature's own directory, or
         * the workspace root the server was started with. */
        const base = b['scope'] === 'project' ? resolve(root) : featureDir;
        const target = rel === '' ? base : insideBase(base, rel);
        if (target === null) {
          sendJson(res, 400, { error: `path escapes the feature: ${rel}` });
          return;
        }
        if ((await stat(target).catch(() => null)) === null) {
          sendJson(res, 404, { error: `no such path: ${rel || target}` });
          return;
        }
        /* Windows runs `code` through cmd.exe, so a path is the one thing that
         * could still turn into a command. The allowlist is characters a real
         * path legitimately carries — including `~`, which 8.3 short names
         * (ADMINI~1) put in almost every temp path — and that are inert in
         * cmd.exe: no `& | ^ < > % ! "`, nothing that starts a command or
         * expands a variable. Anything else is refused rather than escaped. */
        if (mode === 'vscode' && !/^[\w .,'()[\]{}+@=~:\\/-]+$/.test(target)) {
          const bad = [...target].find((ch) => !/^[\w .,'()[\]{}+@=~:\\/-]$/.test(ch)) ?? '';
          sendJson(res, 400, {
            error:
              'this path contains characters that are not safe to hand to a launcher' +
              (bad ? ` (${JSON.stringify(bad)})` : ''),
          });
          return;
        }
        const launched = await revealTarget(mode, target);
        if (!launched.ok) {
          /* 501, and the reason as `error` so the page's one error path says
           * "code is not on PATH" rather than "POST /api/reveal -> 501". */
          sendJson(res, 501, {
            error: launched.reason ?? `could not launch ${launched.launcher}`,
            ...launched,
            mode,
            target,
          });
          return;
        }
        sendJson(res, 200, { ...launched, mode, target });
        return;
      }

      if (path.startsWith('/api/runs/') && path.endsWith('/cancel') && req.method === 'POST') {
        const id = decodeURIComponent(path.slice('/api/runs/'.length, -'/cancel'.length));
        if (registry.cancel(id)) {
          sendJson(res, 200, { jobId: id, cancelling: true });
          return;
        }
        const job = registry.get(id);
        if (job === null) {
          sendJson(res, 404, { error: `no job "${id}" in this server's registry` });
        } else {
          sendJson(res, 409, { error: `job is ${job.status}, not running` });
        }
        return;
      }

      if (path.startsWith('/api/runs/') && req.method === 'GET') {
        const id = decodeURIComponent(path.slice('/api/runs/'.length));
        const job = registry.get(id);
        if (job === null) {
          sendJson(res, 404, {
            error:
              `no job "${id}" in this server's registry; ` +
              'finished runs are read back via /api/runs?root=&feature=',
          });
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      // Static frontend.
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const filePath = normalize(join(webRoot, rel));
      if (!filePath.startsWith(normalize(webRoot))) {
        send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
        return;
      }
      try {
        const data = await readFile(filePath);
        send(res, 200, data.toString('utf8'), MIME[extname(filePath)] ?? 'application/octet-stream');
      } catch {
        send(res, 404, `not found: ${rel}`, 'text/plain; charset=utf-8');
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  return await new Promise<number>((resolveDone) => {
    server.on('error', (err) => {
      console.error(`server error: ${err.message}`);
      resolveDone(1);
    });
    // 127.0.0.1, never 0.0.0.0. There is no authentication here because there is
    // no network surface to authenticate over.
    server.listen(port, '127.0.0.1', () => {
      if (options.demo === true) {
        console.log('  *** DEMO: sessions run against a scripted agent, not the real CLI');
        console.log('  ***         anything it writes says so');
      }
      console.log(`governance listening on http://127.0.0.1:${port}`);
      console.log(`  workspaces: ${roots.join(', ') || '(none)'}`);
      console.log('  foreground only; no timer, no watch. Ctrl-C to stop.');
    });
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      options.signal?.removeEventListener('abort', stop);
      // Idempotent: two Ctrl-Cs must not throw a second close.
      server.close(() => resolveDone(0));
      server.closeIdleConnections?.();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (options.signal !== undefined) {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener('abort', stop, { once: true });
    }
  });
}
