import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize, relative, resolve } from 'node:path';

import { answerPrompt, pad, prdPrompt, startPrompt } from './prompt.js';
import type { PromptContext } from './prompt.js';
import { emptyRound, readRound } from './round.js';
import type { Round } from './round.js';
import type { AgentRunner } from '../exec/agent.js';
import { appendEvent, openChangesFrom, readJournal } from '../tracker/journal.js';
import { legacyString } from '../domain/legacy.js';

/**
 * The grilling session.
 *
 * A session is: one feature, one idea, one conversation, and a sequence of rounds.
 * All of it lives on disk under the feature's own `.session/`, so closing the
 * laptop and coming back does not lose the thread. That is the shape "AFK" needs:
 * the run is durable, and picking it up again is reading a file.
 *
 * The session does not own the feature's markdown. `map.md`, `GLOSSARY.md` and
 * `spec.md` are written by the agent, through the skills, because that is what
 * `grill-with-docs` means. This module drives the conversation and reads the
 * round artifact back; it does not paraphrase the agent's work into its own copy.
 */

export const SESSION_DIR = '.session';

export interface SessionState {
  readonly feature: string;
  readonly featureDir: string;
  readonly repoRoot: string;
  readonly idea: string;
  /** Null until the first turn succeeds. */
  readonly conversationId: string | null;
  /** How many rounds have been answered. 1-based next round is this + 1. */
  readonly answeredRounds: number;
  /** The round currently waiting for answers, if any. */
  readonly pending: Round | null;
  readonly phase: 'starting' | 'asking' | 'ready-for-prd' | 'done' | 'failed';
  /** Set when a turn could not run at all. The reason, verbatim. */
  readonly failure: string | null;
  /** Which reader produced the pending round. 'none' means nothing was readable. */
  readonly source: Round['source'];
  readonly warnings: readonly string[];
  readonly updated: string;
}

export interface SessionPorts {
  readonly runner: AgentRunner;
  readonly skillsRoot: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly allowedTools: readonly string[];
  /** Injected so tests are deterministic. */
  readonly now?: () => Date;
}

export class SessionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
  }
}

/** The feature slug rule, same as the scaffolder's. Re-exported for callers. */
export const FEATURE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function sessionDir(featureDir: string): string {
  return join(featureDir, SESSION_DIR);
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readState(featureDir: string): Promise<Partial<SessionState> | null> {
  const raw = await readTextOrNull(join(sessionDir(featureDir), 'state.json'));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    // A state file written before the rename carries `effort`/`effortDir`.
    // Normalising here rather than at each reader means one place knows about
    // the old spelling, and the record on disk is never rewritten.
    const stored = parsed as Record<string, unknown>;
    const feature = legacyString(stored, 'feature');
    const storedDir = legacyString(stored, 'featureDir');
    return {
      ...stored,
      ...(feature !== null ? { feature } : {}),
      ...(storedDir !== null ? { featureDir: storedDir } : {}),
    } as Partial<SessionState>;
  } catch {
    return null;
  }
}

async function writeState(featureDir: string, state: SessionState): Promise<void> {
  const dir = sessionDir(featureDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Every round ever written, oldest first. The record of the conversation. */
export async function readRoundHistory(featureDir: string): Promise<Round[]> {
  const dir = sessionDir(featureDir);
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return [];
  const numbered = entries
    .filter((f) => /^\d{2,3}\.json$/.test(f))
    .sort();
  const out: Round[] = [];
  for (const f of numbered) {
    const raw = await readTextOrNull(join(dir, f));
    if (raw === null) continue;
    const n = Number(f.replace('.json', ''));
    const r = readRound(raw, null, n);
    if (r.source !== 'none') out.push(r);
  }
  return out;
}

/**
 * Read the session as it currently stands, without running anything.
 *
 * Deliberately reconstructs the pending round from the artifacts rather than
 * trusting `state.json`: the state file is a cache, and the artifacts are the
 * record. If they disagree, the artifacts win and the disagreement is reported.
 */
export async function readSession(featureDir: string): Promise<SessionState | null> {
  const stored = await readState(featureDir);
  const dir = sessionDir(featureDir);

  const latestRaw = await readTextOrNull(join(dir, 'latest.json'));
  const transcriptRaw = await readTextOrNull(join(dir, 'last-output.md'));

  const history = await readRoundHistory(featureDir);
  const questionRounds = history.filter((r) => r.kind === 'questions');

  /* `answeredRounds` is rounds the human has answered, which is not the same as
   * rounds written: the newest round is the one still waiting for them.
   *
   * The round number comes from the artifact, not from counting files. Counting
   * was a real defect (P5, found against a live DeepSeek session): the count was
   * off by one whenever the pending round was a question round, which fed
   * `answerSession`'s next-round computation, which told the agent to overwrite
   * `01.json` every turn — so the count could never grow. A self-reinforcing
   * loop, surfaced only as a per-round warning nobody had asked for.
   *
   * When the pending round came from the JSON artifact, its own `round` field is
   * the agent's declaration of where the conversation is: answered = round - 1.
   * The markdown fallback has no round of its own, so there the file count minus
   * the unread pending is the best available truth. */
  const nextRoundNumber = questionRounds.reduce((max, r) => Math.max(max, r.round), 0) + 1;
  let pending = readRound(latestRaw, transcriptRaw, Math.max(1, nextRoundNumber));
  const answered =
    pending.source === 'json' && pending.kind === 'questions'
      ? Math.max(0, pending.round - 1)
      : pending.source !== 'none' && pending.kind === 'questions'
        ? Math.max(0, questionRounds.length - 1)
        : questionRounds.length;

  if (stored === null && pending.source === 'none') return null;

  /* Derive the phase from the artifacts, not from the cached state file. The
   * cache is a convenience; the artifacts are the record, and a phase that
   * disagrees with them is exactly the kind of drift this system exists to avoid.
   *
   * `done` is the case that made this necessary: the PRD turn writes a round
   * artifact like any other, so deriving naively from it sent a finished session
   * back to "ready for a PRD". The spec on disk is the evidence that it finished. */
  const specExists = (await stat(join(featureDir, 'spec.md')).catch(() => null)) !== null;
  const warnings = [...(stored?.warnings ?? []), ...pending.warnings];

  /* A pending artifact that claims `kind: "prd"` with no spec on disk has two
   * very different causes, and they want opposite handling:
   *
   * 1. the PRD turn ran and failed to write the spec — a real failure;
   * 2. a grilling round mislabeled itself — the live DeepSeek session's closing
   *    round (round 8, "nothing left to ask") wrote `kind: "prd"` on its own,
   *    the derivation believed it, `finalise` refused with "not ready to produce
   *    a PRD", and the human was stuck between a refusal and a failed resume.
   *
   * The app's own transcript knows which is which: only `finaliseSession` ever
   * writes a prd line to `turns-index.jsonl`. No line, no PRD turn — so the
   * label is impossible and the round's own content is the truth. */
  let prdTurnRan = false;
  if (pending.kind === 'prd' && !specExists) {
    const idx = await readTextOrNull(join(dir, 'turns-index.jsonl'));
    prdTurnRan = idx !== null && idx.includes('"prd"');
    if (!prdTurnRan) {
      pending = { ...pending, kind: 'questions' };
      warnings.push(
        'the round artifact claims kind "prd", but no PRD turn has run; reading it as a question round',
      );
    }
  }

  let phase: SessionState['phase'];
  if (pending.kind === 'prd') {
    phase = specExists ? 'done' : 'failed';
    if (!specExists) warnings.push('the PRD turn produced no spec.md');
  } else if (pending.source === 'none') {
    // Nothing readable: fall back to what was recorded, including a failure.
    phase = stored?.failure != null ? 'failed' : (stored?.phase ?? 'starting');
    if (phase === 'done' && !specExists) phase = 'failed';
  } else if (pending.frontierEmpty) {
    phase = 'ready-for-prd';
  } else {
    phase = 'asking';
  }

  return {
    feature: stored?.feature ?? '',
    featureDir,
    repoRoot: stored?.repoRoot ?? '',
    idea: stored?.idea ?? '',
    conversationId: stored?.conversationId ?? null,
    answeredRounds: answered,
    pending: pending.source === 'none' ? null : pending,
    phase,
    failure: phase === 'failed' ? (stored?.failure ?? null) : null,
    source: pending.source,
    warnings,
    updated: stored?.updated ?? '',
  };
}

function context(
  ports: SessionPorts,
  input: {
    feature: string; featureDir: string; repoRoot: string; idea: string; round: number;
    openChanges?: readonly { readonly id: string; readonly text: string }[];
  },
): PromptContext {
  return {
    featureSlug: input.feature,
    featureDir: input.featureDir,
    repoRoot: input.repoRoot,
    idea: input.idea,
    skills: { root: ports.skillsRoot },
    sessionDir: sessionDir(input.featureDir),
    round: input.round,
    ...(input.openChanges === undefined ? {} : { openChanges: input.openChanges }),
  };
}

/**
 * The open changes on a feature, in the shape a prompt wants them.
 *
 * Read here rather than cached: a change filed one turn ago must reach the next
 * turn, and a cached list is exactly the thing that would not.
 */
async function openChangesFor(
  featureDir: string,
): Promise<readonly { id: string; text: string }[]> {
  const { events } = await readJournal(featureDir);
  return openChangesFrom(events).map((c) => ({ id: c.id, text: c.text }));
}

function logPath(featureDir: string, round: number, kind: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(sessionDir(featureDir), 'turns', `${pad(round)}-${kind}-${stamp}.log`);
}

/** Resolve the feature directory under a repository root, refusing anything odd. */
export function resolveFeatureDir(repoRoot: string, feature: string): string {
  if (!FEATURE_SLUG.test(feature)) {
    throw new SessionError(
      `invalid feature name "${feature}": use lowercase letters, digits, dot, dash or underscore`,
    );
  }
  const root = resolve(repoRoot);
  const dir = normalize(join(root, '.scratch', feature));
  if (!dir.startsWith(normalize(join(root, '.scratch')))) {
    throw new SessionError('resolved path escapes the repository');
  }
  return dir;
}

export interface StartInput {
  readonly repoRoot: string;
  readonly feature: string;
  readonly idea: string;
}

/**
 * Start a session: create the feature directory if needed, then send the idea.
 *
 * The feature directory is created before the agent runs, because the agent is
 * told to write into it. It refuses to reuse a directory that already has a
 * session — resuming is a different operation, and conflating the two would let a
 * second "start" quietly overwrite a conversation in progress.
 */
export async function startSession(
  ports: SessionPorts,
  input: StartInput,
): Promise<SessionState> {
  const idea = input.idea.trim();
  if (idea.length < 8) {
    throw new SessionError('the idea is too short to grill; write at least a sentence', 400);
  }
  const featureDir = resolveFeatureDir(input.repoRoot, input.feature);
  const existing = await readState(featureDir);
  if (existing !== null) {
    throw new SessionError(
      `a session already exists for "${input.feature}"; resume it, or remove ${sessionDir(featureDir)}`,
      409,
    );
  }

  await mkdir(sessionDir(featureDir), { recursive: true });
  const now = ports.now ?? (() => new Date());

  const ctx = context(ports, {
    feature: input.feature,
    featureDir,
    repoRoot: resolve(input.repoRoot),
    idea,
    round: 1,
  });

  const result = await ports.runner.run({
    prompt: startPrompt(ctx),
    sessionId: null,
    cwd: featureDir,
    logPath: logPath(featureDir, 1, 'start', now()),
    timeoutMs: ports.timeoutMs,
    model: ports.model,
    allowedTools: ports.allowedTools,
  });

  // Keep the agent's own words too, so the markdown fallback has something to read.
  if (result.output.trim().length > 0) {
    await writeFile(join(sessionDir(featureDir), 'last-output.md'), result.output, 'utf8');
  }

  const pending = await readPending(featureDir, 1);

  const state: SessionState = {
    feature: input.feature,
    featureDir,
    repoRoot: ctx.repoRoot,
    idea,
    conversationId: result.sessionId,
    answeredRounds: 0,
    pending: pending.source === 'none' ? null : pending,
    phase: result.ok
      ? pending.frontierEmpty
        ? 'ready-for-prd'
        : 'asking'
      : 'failed',
    failure: result.ok ? null : (result.error ?? 'the agent did not run'),
    source: pending.source,
    warnings: pending.warnings,
    updated: now().toISOString(),
  };
  await writeState(featureDir, state);
  /* The journal is the durable record of what happened; these appends are the
   * moments the app itself witnessed, which is why they are not derived later. */
  await appendEvent(featureDir, {
    kind: 'session.started',
    ref: state.feature,
    detail: `idea: ${state.idea.slice(0, 80)}`,
    data: { idea: state.idea },
  }).catch(() => undefined);
  if (pending.source !== 'none') {
    await appendEvent(featureDir, {
      kind: 'round.written',
      ref: `round ${pending.round}`,
      detail: `${pending.questions.length} question(s)`,
      data: { round: pending.round, source: pending.source },
    }).catch(() => undefined);
  }
  return state;
}

async function readPending(featureDir: string, expected: number): Promise<Round> {
  const dir = sessionDir(featureDir);
  const latest = await readTextOrNull(join(dir, 'latest.json'));
  const spoken = await readTextOrNull(join(dir, 'last-output.md'));
  return readRound(latest, spoken, expected);
}

export interface AnswerInput {
  readonly repoRoot: string;
  readonly feature: string;
  readonly answers: readonly { readonly id: string; readonly answer: string }[];
}

/**
 * Answer the pending round and ask for the next one.
 *
 * Refuses when there is nothing pending, and refuses to accept a round that was
 * never asked — an answer to a question the session does not have is a client bug
 * that would otherwise be sent to the agent as though it were real.
 */
export async function answerSession(
  ports: SessionPorts,
  input: AnswerInput,
): Promise<SessionState> {
  const featureDir = resolveFeatureDir(input.repoRoot, input.feature);
  const state = await readSession(featureDir);
  if (state === null) {
    throw new SessionError(`no session for "${input.feature}"`, 404);
  }
  if (state.phase === 'failed') {
    throw new SessionError(
      `the session is stopped: ${state.failure ?? 'the agent could not run'}`,
      409,
    );
  }
  if (state.phase === 'done') {
    throw new SessionError('the session is finished; the PRD has been written', 409);
  }
  // A PRD round carries no questions, so there is nothing to answer even though a
  // round artifact exists.
  if (state.pending === null || state.pending.kind === 'prd') {
    throw new SessionError(
      state.pending === null
        ? 'there is no round waiting for answers'
        : 'the session is ready for its PRD; there are no questions to answer',
      409,
    );
  }

  const asked = new Set(state.pending.questions.map((q) => q.id));
  const answers = input.answers
    .map((a) => ({ id: a.id.trim(), answer: a.answer.trim() }))
    .filter((a) => a.answer.length > 0);
  const unknown = answers.filter((a) => !asked.has(a.id));
  if (unknown.length > 0) {
    throw new SessionError(
      `these answers are for questions this round did not ask: ${unknown.map((u) => u.id).join(', ')}`,
      400,
    );
  }
  if (answers.length === 0) {
    throw new SessionError('no answers given', 400);
  }

  /* The next round number is anchored to the pending artifact, not to a count:
   * the agent's own numbering is the record of where the conversation is, and
   * re-anchoring here is what breaks the overwrite loop — the prompt names
   * `<round>.json`, so a number that never advanced made every turn overwrite
   * `01.json` (P5). A drift between the two now surfaces as the round-mismatch
   * warning instead of silently resetting the conversation's arithmetic. */
  const nextRound = state.pending.round + 1;
  const now = ports.now ?? (() => new Date());
  const ctx = context(ports, {
    feature: input.feature,
    featureDir,
    repoRoot: resolve(input.repoRoot),
    idea: state.idea,
    round: nextRound,
    openChanges: await openChangesFor(featureDir),
  });

  const result = await ports.runner.run({
    prompt: answerPrompt(ctx, answers),
    sessionId: state.conversationId,
    cwd: featureDir,
    logPath: logPath(featureDir, nextRound, 'round', now()),
    timeoutMs: ports.timeoutMs,
    model: ports.model,
    allowedTools: ports.allowedTools,
  });

  if (result.output.trim().length > 0) {
    await writeFile(join(sessionDir(featureDir), 'last-output.md'), result.output, 'utf8');
  }

  /* The human's answers go back into the round artifact they answer. The round
   * file is the record of what was asked; without this write, what was answered
   * lived only in the turn transcript, and the dossier's "问了几轮、问了哪些
   * 问题、答案是是什么" could not be answered from the record. Written even
   * when the agent turn failed — the answers were given either way. */
  try {
    const answeredPath = join(sessionDir(featureDir), `${pad(state.pending.round)}.json`);
    const raw = await readFile(answeredPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed['answers'] = answers;
      await writeFile(answeredPath, JSON.stringify(parsed, null, 2), 'utf8');
    }
  } catch {
    /* The artifact was unreadable; the transcript still carries the turn. Not
     * fatal to answering, and the dossier will say the answers are there. */
  }

  const pending = await readPending(featureDir, nextRound);
  const next: SessionState = {
    ...state,
    conversationId: result.sessionId ?? state.conversationId,
    /* The round just answered is the pending round itself, not a count plus one:
     * the two agree when rounds are consecutive, and the artifact wins when they
     * are not. */
    answeredRounds: state.pending.round,
    pending: pending.source === 'none' ? null : pending,
    phase: result.ok
      ? pending.frontierEmpty
        ? 'ready-for-prd'
        : 'asking'
      : 'failed',
    failure: result.ok ? null : (result.error ?? 'the agent did not run'),
    source: pending.source,
    warnings: pending.warnings,
    updated: now().toISOString(),
  };
  await writeState(featureDir, next);
  await appendEvent(featureDir, {
    kind: 'answer.recorded',
    ref: `round ${state.pending.round}`,
    detail: `${answers.length} answer(s)`,
    data: { answers, round: state.pending.round },
  }).catch(() => undefined);
  if (pending.source !== 'none') {
    await appendEvent(featureDir, {
      kind: 'round.written',
      ref: `round ${pending.round}`,
      detail: `${pending.questions.length} question(s)`,
      data: { round: pending.round, source: pending.source },
    }).catch(() => undefined);
  }
  return next;
}

/**
 * Ask for the PRD.
 *
 * Only allowed when the session says the frontier is empty, or when the human
 * explicitly overrides. Producing a PRD from a live frontier would freeze
 * questions that were never asked, which is the one thing this whole flow exists
 * to prevent.
 */
export async function finaliseSession(
  ports: SessionPorts,
  input: { readonly repoRoot: string; readonly feature: string; readonly force?: boolean },
): Promise<SessionState> {
  const featureDir = resolveFeatureDir(input.repoRoot, input.feature);
  const state = await readSession(featureDir);
  if (state === null) throw new SessionError(`no session for "${input.feature}"`, 404);
  if (state.phase === 'done') return state;
  if (state.phase !== 'ready-for-prd' && input.force !== true) {
    throw new SessionError(
      state.pending !== null && state.pending.questions.length > 0
        ? `${state.pending.questions.length} question(s) are still open; answer them, or pass force`
        : 'the session is not ready to produce a PRD',
      409,
    );
  }

  const now = ports.now ?? (() => new Date());
  const ctx = context(ports, {
    feature: input.feature,
    featureDir,
    repoRoot: resolve(input.repoRoot),
    idea: state.idea,
    /* The PRD turn is the conversation's next turn, so its number is the last
     * round the artifact shows, plus one — not the answered count plus one,
     * which skips a number whenever a round is still open (force override). */
    round: (state.pending?.round ?? state.answeredRounds) + 1,
    openChanges: await openChangesFor(featureDir),
  });

  const result = await ports.runner.run({
    prompt: prdPrompt(ctx),
    sessionId: state.conversationId,
    cwd: featureDir,
    logPath: logPath(featureDir, state.answeredRounds + 1, 'prd', now()),
    timeoutMs: ports.timeoutMs,
    model: ports.model,
    allowedTools: ports.allowedTools,
  });

  if (result.output.trim().length > 0) {
    await writeFile(join(sessionDir(featureDir), 'last-output.md'), result.output, 'utf8');
  }
  // Record the closing turn in the transcript, so the session's history is one file.
  await appendFile(
    join(sessionDir(featureDir), 'turns-index.jsonl'),
    `${JSON.stringify({ ts: now().toISOString(), kind: 'prd', ok: result.ok, ms: result.ms })}\n`,
    'utf8',
  ).catch(() => undefined);

  const specWritten = (await stat(join(featureDir, 'spec.md')).catch(() => null)) !== null;

  const next: SessionState = {
    ...state,
    conversationId: result.sessionId ?? state.conversationId,
    pending: null,
    // A turn that "succeeded" but wrote no spec is a failure the human needs to
    // see: the session would otherwise claim to be done with nothing to show.
    phase: result.ok && specWritten ? 'done' : 'failed',
    failure: result.ok
      ? specWritten
        ? null
        : 'the agent finished but no spec.md appeared, so the PRD was not written'
      : (result.error ?? 'the agent did not run'),
    source: 'none',
    warnings: specWritten ? [] : ['spec.md was not written'],
    updated: now().toISOString(),
  };
  await writeState(featureDir, next);
  await appendEvent(featureDir, {
    kind: 'session.finished',
    ref: state.feature,
    detail: next.phase === 'done' ? 'the PRD was written' : `stopped: ${next.failure ?? 'unknown'}`,
    data: { phase: next.phase },
  }).catch(() => undefined);
  return next;
}

export { emptyRound };

/* ---- undoing a session ---- */

export interface ResetPreview {
  readonly featureDir: string;
  readonly files: readonly string[];
  readonly removed: boolean;
}

/** Every file under a directory, relative to it, sorted. For the preview. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        out.push(relative(dir, full).split(/[\\/]/).join('/'));
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Remove a feature so it can be started again.
 *
 * Exists because refusing to reuse a name was a dead end rather than a guard. A
 * session created with a name nobody wanted — or by the demo agent — left the
 * name taken and the interface with nothing to offer but an error message.
 *
 * Two properties make the deletion safe enough to expose:
 *
 * 1. **`confirm: false` deletes nothing.** It returns the list of files that
 *    *would* go, so the interface can show exactly what is at stake before asking.
 *    A preview and an action are the same call, which is the only way to be sure
 *    the preview describes what the action will do.
 * 2. **It refuses unless the directory is a direct child of `.scratch/`.** The
 *    slug has already been validated, and the resolved path is checked again
 *    here, so no input can reach a repository root or anything beside it.
 *
 * The whole feature goes, not just `.session/`. Clearing the conversation while
 * leaving `spec.md` behind would make the scanner report a finished spec for an
 * feature that has no session — a state that never happened.
 */
export async function resetSession(input: {
  readonly repoRoot: string;
  readonly feature: string;
  readonly confirm: boolean;
}): Promise<ResetPreview> {
  const featureDir = resolveFeatureDir(input.repoRoot, input.feature);

  // The same containment check the slug rule makes, restated against the real
  // path. Cheap, and it is the one thing that must not be got wrong.
  const scratchRoot = normalize(join(resolve(input.repoRoot), '.scratch'));
  if (!normalize(featureDir).startsWith(scratchRoot)) {
    throw new SessionError('refusing to touch anything outside .scratch/');
  }

  const info = await stat(featureDir).catch(() => null);
  if (info === null) {
    throw new SessionError(`no feature named "${input.feature}" to remove`, 404);
  }
  if (!info.isDirectory()) {
    throw new SessionError(`${featureDir} is not a directory`, 409);
  }

  const files = await listFiles(featureDir);
  if (input.confirm !== true) {
    return { featureDir, files, removed: false };
  }

  await rm(featureDir, { recursive: true, force: true });
  return { featureDir, files, removed: true };
}

/** Does this feature already have a session? Used to explain a refusal. */
export async function hasSession(featureDir: string): Promise<boolean> {
  return (await readState(featureDir)) !== null;
}
