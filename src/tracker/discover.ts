import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { classifyTicket, cycles, danglingBlockers, deriveStages } from '../domain/stages.js';
import { emptyFacts, FAIL_ACTIONS, METHOD_IDS, ROLE_IDS, STAGE_IDS } from '../domain/types.js';
import type {
  ArtifactFacts,
  Feature,
  Gate,
  GitState,
  Project,
  StageId,
  Ticket,
} from '../domain/types.js';
import { readDecisions } from './decisions.js';
import { changesFrom, readJournal } from './journal.js';
import { readRunRecords } from './runs.js';
import {
  countGlossaryTerms,
  inferKind,
  parseMap,
  parseTicket,
  ticketIdFromFilename,
  ticketSlugFromFilename,
} from './parse.js';

const execFileAsync = promisify(execFile);

/** Files larger than this are skipped rather than read. A tracker file is prose;
 *  anything this big is not one, and reading it would only waste memory. */
const MAX_FILE_BYTES = 512 * 1024;

/** Cap on features read from one repository, so a pathological `.scratch/` cannot
 *  turn one scan into an unbounded walk. */
export const MAX_FEATURES = 200;

export interface ScanWarning {
  readonly scope: string;
  readonly message: string;
}

async function readText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[] | null> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return null;
    return (await readdir(path)).sort();
  } catch {
    return null;
  }
}

/** Git facts, read rather than assumed. A missing git, a non-repository, or a
 *  hanging command all resolve to `undefined` — the UI shows nothing rather than
 *  something invented. */
export async function readGitState(root: string): Promise<GitState | undefined> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return undefined;
  const head = await run(['rev-parse', '--short', 'HEAD']);
  const status = await run(['status', '--porcelain']);

  return {
    branch,
    head: head ?? '',
    dirty: (status ?? '').length > 0,
  };
}

/**
 * Read gate definitions. Immutable, so a plain JSON file is the right shape: no
 * merge semantics, no partial updates.
 *
 * Every entry is validated against the Gate shape before it is trusted. This is
 * not pedantry: a malformed gate that was silently accepted with `blocking`
 * undefined would neither block nor warn — a permission the file never granted.
 * An entry that fails validation is dropped with a warning that says exactly
 * what that costs (a dropped gate is *not* enforced), because the honest
 * alternative — trusting a half-read gate — is how a guard stops guarding.
 */
async function readGateDefinitions(featureDir: string): Promise<{
  gates: readonly Gate[];
  warnings: readonly string[];
}> {
  const raw = await readText(join(featureDir, 'gates.json'));
  if (raw === null) return { gates: [], warnings: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { gates: [], warnings: ['gates.json is not an array'] };

    const gates: Gate[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < parsed.length; i++) {
      const defect = gateDefect(parsed[i]);
      if (defect !== null) {
        warnings.push(
          `gates.json entry ${i + 1} is not a usable gate definition (${defect}); ` +
            'it is skipped, so any gate it was meant to be is NOT enforced',
        );
        continue;
      }
      const gate = parsed[i] as Gate;
      if (seen.has(gate.id)) {
        warnings.push(`gates.json entry ${i + 1} repeats id "${gate.id}"; the repeat is skipped`);
        continue;
      }
      seen.add(gate.id);
      gates.push(gate);
    }
    return { gates, warnings };
  } catch (err) {
    return {
      gates: [],
      warnings: [`gates.json is not valid JSON: ${(err as Error).message}`],
    };
  }
}

/* The unions behind `Gate` are compile-time only. A JSON file is read at
 * runtime, so the allowed values are restated here as the lists they are. */
const GATE_SCOPE_KINDS = ['stage', 'slice', 'artifact'];
const GATE_RAISED_BY = ['rule', 'session', 'manual'];

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function oneOf(v: unknown, allowed: readonly string[]): boolean {
  return isStr(v) && allowed.includes(v);
}

/** One-line reason a value is not a usable Gate, or null if it is one. */
function gateDefect(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'the entry is not an object';
  }
  const g = raw as Record<string, unknown>;
  if (!isStr(g['id'])) return 'id is missing or empty';
  if (!isStr(g['title'])) return 'title is missing or empty';
  if (!oneOf(g['stage'], STAGE_IDS)) return `stage "${String(g['stage'])}" is not a known stage id`;
  const scope = g['scope'];
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    return 'scope is missing or not an object';
  }
  const s = scope as Record<string, unknown>;
  if (!oneOf(s['kind'], GATE_SCOPE_KINDS)) return `scope.kind "${String(s['kind'])}" is not one of ${GATE_SCOPE_KINDS.join('/')}`;
  if (!isStr(s['ref'])) return 'scope.ref is missing or empty';
  if (!oneOf(g['owner'], ROLE_IDS)) return `owner "${String(g['owner'])}" is not a known role`;
  const methods = g['methods'];
  if (
    !Array.isArray(methods) ||
    methods.length === 0 ||
    !methods.every((m) => oneOf(m, METHOD_IDS))
  ) {
    return `methods must be a non-empty array drawn from ${METHOD_IDS.join('/')}`;
  }
  if (typeof g['blocking'] !== 'boolean') return 'blocking must be true or false';
  if (!oneOf(g['onFail'], FAIL_ACTIONS)) return `onFail "${String(g['onFail'])}" is not one of ${FAIL_ACTIONS.join('/')}`;
  if (!oneOf(g['raisedBy'], GATE_RAISED_BY)) return `raisedBy "${String(g['raisedBy'])}" is not one of ${GATE_RAISED_BY.join('/')}`;
  if (g['note'] !== undefined && typeof g['note'] !== 'string') return 'note must be a string when present';
  return null;
}

/** Artifact names that mark a stage's output, by convention. */
const MARKERS = {
  design: /^(design|design[-_].*)\.(md|json)$/i,
  review: /^(review|reviews?[-_].*|.*[-_]review)\.(md|json)$/i,
  release: /^(release|released|release[-_].*)\.(md|json)$/i,
  retro: /^(retro|retrospective|retro[-_].*)\.(md|json)$/i,
} as const;

async function listFeatureFiles(featureDir: string): Promise<string[]> {
  const top = (await listDir(featureDir)) ?? [];
  const files: string[] = top.filter((f) => f.endsWith('.md'));
  for (const sub of ['reviews', 'release', 'retro']) {
    const inner = await listDir(join(featureDir, sub));
    if (inner) for (const f of inner) files.push(`${sub}/${f}`);
  }
  return files;
}

async function readFeature(
  projectRoot: string,
  slug: string,
  repoGlossaryTerms: number,
): Promise<Feature> {
  const featureDir = join(projectRoot, '.scratch', slug);
  const local: string[] = [];

  const mapRaw = await readText(join(featureDir, 'map.md'));
  const parsedMap = mapRaw === null ? null : parseMap(mapRaw);
  const hasMapFile = parsedMap !== null;

  /* Sharpening leaves its paper trail in one of two places, and both are in use:
   * a single repo-level GLOSSARY.md, or one per feature beside the map. Checking
   * only the repo-level file was a real bug — the scaffolder writes the feature's
   * own, so a freshly created feature looked like it had never been sharpened. */
  const featureGlossaryRaw = await readText(join(featureDir, 'GLOSSARY.md'));
  const glossaryTerms =
    featureGlossaryRaw !== null
      ? countGlossaryTerms(featureGlossaryRaw)
      : repoGlossaryTerms;

  const issuesDir = join(featureDir, 'issues');
  const issueFiles = (await listDir(issuesDir)) ?? [];

  const parsedTickets: (Omit<Ticket, 'status'> & { rawStatus: string })[] = [];
  for (const filename of issueFiles) {
    const id = ticketIdFromFilename(filename);
    if (id === null) {
      if (filename.endsWith('.md')) {
        local.push(`issues/${filename} does not match NN-slug.md and was skipped`);
      }
      continue;
    }
    const raw = await readText(join(issuesDir, filename));
    if (raw === null) {
      local.push(`issues/${filename} could not be read`);
      continue;
    }
    parsedTickets.push(parseTicket(raw, id, ticketSlugFromFilename(filename)));
  }

  // Resolution is read first, because a blocker is only satisfied by a ticket the
  // corpus already marks resolved. Computing it in one pass would make a ticket's
  // status depend on the order files were listed in.
  const resolvedIds = new Set<string>();
  for (const t of parsedTickets) {
    const raw = t.rawStatus.trim().toLowerCase();
    if (raw === 'resolved' || raw === 'closed' || raw === 'done') resolvedIds.add(t.id);
  }

  const tickets: Ticket[] = parsedTickets.map((t) => ({
    ...t,
    status: classifyTicket({
      rawStatus: t.rawStatus,
      blockedBy: t.blockedBy,
      resolvedIds,
    }),
  }));

  const frontier = tickets.filter((t) => t.status === 'frontier').map((t) => t.id);
  const unresolved = tickets.filter((t) => t.status !== 'resolved').length;
  // A prototype ticket settles a question; it is not a slice. Both kinds share
  // issues/, so the count has to separate them by type rather than by presence.
  const slices = tickets.filter((t) => t.type !== 'prototype');
  const sliceResolved = slices.filter((t) => t.status === 'resolved').length;

  const dangling = danglingBlockers(tickets);
  for (const d of dangling) {
    // On the feature's own warnings, not the project's: a dangling edge is a fact
    // about this feature, and it should be shown beside it.
    local.push(`ticket ${d.from} is blocked by ${d.missing}, which does not exist`);
  }
  for (const c of cycles(tickets)) {
    local.push(`blocking cycle: ${c.join(' -> ')}`);
  }

  const files = await listFeatureFiles(featureDir);
  const specRaw = await readText(join(featureDir, 'spec.md'));
  /* The design record, read rather than merely seen.
   *
   * Presence alone was the first version of this fact and it is not enough: a
   * design.md that exists and says nothing has declared nothing. A stage that
   * crashed after touching the file would otherwise complete, which is the one
   * thing a completion rule must not do. */
  const designRel = files.find((f) => MARKERS.design.test(f)) ?? null;
  const designRaw = designRel === null ? null : await readText(join(featureDir, designRel));
  /* Anchored to the start of a line, and to the end of that line.
   *
   * It was neither, and an unanchored field regex misreads prose: a sentence
   * that merely *mentions* `**Design:**` was being read as the field, which
   * turned a document explaining the syntax into one that used it. Fields are
   * line-anchored; anything else is text about the field. */
  const designMatch =
    specRaw === null ? null : /^\*\*\s*Design\s*:?\s*\*\*\s*(.*)$/im.exec(specRaw);
  const designValue = designMatch?.[1]?.trim() ?? '';
  const designDeclared = designMatch !== null;
  // `none` alone is not a waiver; it needs a reason, or it is just a placeholder.
  const designWaived =
    designDeclared && /^none\b/i.test(designValue) && designValue.replace(/^none\b/i, '').trim().length > 3;

  const gateDefs = await readGateDefinitions(featureDir);
  for (const w of gateDefs.warnings) local.push(w);
  const decisions = await readDecisions(featureDir);
  const decidedGates = new Set(decisions.map((d) => d.gate));
  /* The journal, for the one fact that lives there: how many change requests
   * are still open. Reading it here keeps derivation a pure function of what is
   * on disk, the journal included. */
  const journalRead = await readJournal(featureDir);
  for (const w of journalRead.warnings) local.push(`journal: ${w}`);
  /* Folded once, read twice: the ladder wants the count, the prompt and the
   * pipeline want the sentences. Folding twice would let the two disagree. */
  const changes = changesFrom(journalRead.events);
  /* The lineage line, if this feature was opened out of another one's change.
   * Read from the journal rather than a separate file because it is the same
   * kind of fact as everything else in there: what happened, once. */
  const derivedEvent = journalRead.events.find((e) => e.kind === 'feature.derived');
  const derivedFrom =
    derivedEvent === undefined
      ? null
      : {
          parent:
            typeof derivedEvent.data?.['parent'] === 'string'
              ? (derivedEvent.data['parent'] as string)
              : derivedEvent.ref,
          change:
            typeof derivedEvent.data?.['change'] === 'string'
              ? (derivedEvent.data['change'] as string)
              : '',
          text: typeof derivedEvent.data?.['text'] === 'string' ? (derivedEvent.data['text'] as string) : '',
        };
  const blockedStages: StageId[] = gateDefs.gates
    .filter((g) => g.blocking && !decidedGates.has(g.id))
    .map((g) => g.stage);

  const facts: ArtifactFacts = {
    ...emptyFacts(),
    featureDir: true,
    mapFile: hasMapFile,
    mapCleared:
      hasMapFile && tickets.length > 0 && tickets.every((t) => t.status === 'resolved'),
    /* A destination is named by a map's Destination section, or by a spec.
     * A build feature has no map — that is a wayfinder artifact — and for a
     * spec-first feature the destination is in the spec's Problem and Solution.
     * Requiring a map here left every session-produced feature with an intake
     * stage that could never complete. */
    destinationNamed: (parsedMap?.destination.length ?? 0) > 0 || specRaw !== null,
    hasHandoff: parsedMap?.hasHandoff ?? false,
    glossaryTerms,
    specFile: specRaw !== null,
    designDeclared,
    designFile: (designRaw ?? '').trim().length > 0,
    designWaived,
    ticketCount: tickets.length,
    ticketResolved: tickets.length - unresolved,
    sliceCount: slices.length,
    sliceResolved,
    /* Change requests are read from the journal, not inferred: an open change is
     * a fact somebody recorded, and it reopens the ask stage until it is closed. */
    openChanges: changes.filter((c) => c.status === 'open').length,
    frontier,
    reviewFile: files.some((f) => MARKERS.review.test(f)),
    releaseFile: files.some((f) => MARKERS.release.test(f)),
    retroFile: files.some((f) => MARKERS.retro.test(f)),
  };

  const derived = deriveStages(facts, blockedStages);
  for (const c of derived.crossed) {
    local.push(
      `stage "${c.stage}" has output but "${c.over}" was never satisfied (crossed)`,
    );
  }

  /* Dossier facts. Each is read with its own tolerance: a missing directory is
   * a zero, not an error — a feature that never ran a grilling session or has
   * no ADRs yet is a normal state, not a broken one. */
  const [runs, adrEntries, sessionEntries] = await Promise.all([
    readRunRecords(featureDir).catch(() => []),
    listDir(join(featureDir, 'docs', 'adr')).catch(() => []),
    listDir(join(featureDir, '.session')).catch(() => []),
  ]);

  return {
    slug,
    root: featureDir,
    kind: inferKind(hasMapFile),
    destination: parsedMap?.destination ?? '',
    notes: parsedMap?.notes ?? [],
    decisionsSoFar: parsedMap?.decisionsSoFar ?? [],
    notYetSpecified: parsedMap?.notYetSpecified ?? [],
    outOfScope: parsedMap?.outOfScope ?? [],
    tickets,
    gates: gateDefs.gates,
    stages: derived.stages,
    warnings: local,
    openChanges: facts.openChanges,
    changes,
    /* Acceptance is a file, not a stage: the ladder is allowed to un-complete
     * `ship` when a change reopens requirements, and a release that happened
     * still happened. */
    accepted: facts.releaseFile || facts.retroFile,
    derivedFrom,
    runs: runs.slice(-10),
    adrCount: (adrEntries ?? []).filter((f) => f.endsWith('.md')).length,
    sessionRounds: (sessionEntries ?? []).filter((f) => /^\d{2,3}\.json$/.test(f)).length,
  };
}

/**
 * Scan one repository root into a project.
 *
 * Read-only throughout: nothing here creates, writes or repairs a file. A file
 * that cannot be read becomes a warning, never an exception, because a scan that
 * throws on one bad feature hides every good one beside it.
 */
export async function scanProject(root: string): Promise<Project> {
  const abs = resolve(root);
  const warnings: ScanWarning[] = [];

  const scratch = join(abs, '.scratch');
  const scratchEntries = await listDir(scratch);
  if (scratchEntries === null) {
    return {
      root: abs,
      name: abs.split(/[\\/]/).filter(Boolean).pop() ?? abs,
      features: [],
      warnings: [`${abs}: no .scratch/ directory`],
    };
  }

  const glossaryRaw =
    (await readText(join(scratch, 'GLOSSARY.md'))) ??
    (await readText(join(abs, 'GLOSSARY.md')));
  const glossaryTerms = glossaryRaw === null ? 0 : countGlossaryTerms(glossaryRaw);

  const features: Feature[] = [];
  for (const entry of scratchEntries) {
    if (entry === 'GLOSSARY.md' || entry.startsWith('.')) continue;
    const info = await (async () => {
      try {
        return await stat(join(scratch, entry));
      } catch {
        return null;
      }
    })();
    if (info?.isDirectory() !== true) continue;
    if (features.length >= MAX_FEATURES) {
      warnings.push({
        scope: abs,
        message: `stopped after ${MAX_FEATURES} features`,
      });
      break;
    }
    features.push(await readFeature(abs, entry, glossaryTerms));
  }

  const git = await readGitState(abs);

  return {
    root: abs,
    name: abs.split(/[\\/]/).filter(Boolean).pop() ?? abs,
    features,
    ...(git === undefined ? {} : { git }),
    warnings: warnings.map((w) => `${w.scope}: ${w.message}`),
  };
}

/** Scan several roots, tolerating one that fails. */
export async function scanProjects(roots: readonly string[]): Promise<Project[]> {
  const out: Project[] = [];
  for (const root of roots) {
    try {
      out.push(await scanProject(root));
    } catch (err) {
      out.push({
        root: resolve(root),
        name: root,
        features: [],
        warnings: [`scan failed: ${(err as Error).message}`],
      });
    }
  }
  return out;
}
