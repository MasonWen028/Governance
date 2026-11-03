import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChangeVerdict } from './triage.js';

/**
 * The event journal.
 *
 * Why this exists: the dossier used to build its timeline out of **file mtimes**,
 * and mtime is not a record — `git checkout`, a copy, a restored backup or a
 * re-cloned workspace all reset it. What looked like history was really "when
 * this file last landed on this disk". Answers were worse: they lived only in
 * the turn transcript.
 *
 * This file is **append-only**, one JSON object per line, and it is never
 * rewritten. Files under the feature are still the authority on *state* (a ticket
 * is resolved because its Status line says so); the journal is the authority on
 * *what happened, in what order, and when*. `rebuild()` reconstructs it from the
 * files, which is what keeps the two from drifting: if a rebuild produces the
 * same events, the journal is not inventing history.
 */

export const JOURNAL_FILE = 'journal.jsonl';

export type JournalKind =
  /** the grilling conversation opened */
  | 'session.started'
  /** the agent wrote a round artifact */
  | 'round.written'
  /** the human answered a round */
  | 'answer.recorded'
  /** a PRD was written and the conversation closed */
  | 'session.finished'
  /** the human filed a change request */
  | 'change.opened'
  /**
   * The system routed the change: what kind it is, and which flow it takes.
   *
   * Recorded rather than recomputed. Triage reads one fact that the change
   * itself destroys — whether the work was already accepted — so a verdict
   * recomputed later would answer a different question and quietly rewrite the
   * reason the change went where it went.
   */
  | 'change.decided'
  /** a change was accepted and closed, with a note */
  | 'change.closed'
  /**
   * A change was handed to a follow-up feature instead of being absorbed here.
   * The record keeps the pointer: a feature whose scope moved on must be able to
   * say where it moved to, or the change looks dropped.
   */
  | 'change.followed-up'
  /** a feature was created out of another one's change (the child's own event) */
  | 'feature.derived'
  /** a stage run began */
  | 'run.started'
  /** a stage run ended */
  | 'run.ended'
  /**
   * The AFK chain stopped after a succeeded run, with the reason.
   *
   * Every stop the chain makes is designed — AFK switched off, a stage that did
   * not advance, a gate refusing the next run — and until now every one of them
   * was written only to the server's console. A person watching the board saw a
   * run succeed and then nothing, with no way to tell "finished" from "stopped",
   * and no way to tell which gate is holding it. The reason belongs next to the
   * run it followed, in the file that already records what happened.
   */
  | 'chain.stopped'
  /** a gate decision was appended */
  | 'decision.recorded';

export interface JournalEvent {
  /** ISO timestamp, written by the app at the moment the event happened. */
  readonly at: string;
  readonly kind: JournalKind;
  /** The thing the event is about: a change id, a stage, a gate id. */
  readonly ref: string;
  /** One line a human can read without opening the files. */
  readonly detail: string;
  readonly data?: Record<string, unknown>;
}

const KINDS: readonly JournalKind[] = [
  'session.started', 'round.written', 'answer.recorded', 'session.finished',
  'change.opened', 'change.decided', 'change.closed', 'change.followed-up', 'feature.derived',
  'run.started', 'run.ended', 'decision.recorded', 'chain.stopped',
];

function isKind(v: unknown): v is JournalKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/**
 * Kinds an older journal may carry, mapped to the kind they mean today.
 *
 * `effort.derived` is the only one, and it is the same event as
 * `feature.derived` — written before the rename, describing the same thing.
 * This predicate gates every line the journal reads, so a kind it rejected
 * would be a line that quietly stopped being history. Translating the word on
 * the way in changes the vocabulary, not the event: the file keeps what was
 * written, and nothing in this tool rewrites it.
 */
const LEGACY_KINDS: Readonly<Record<string, JournalKind>> = {
  'effort.derived': 'feature.derived',
};

/** The kind a line carries, or null if it is not one this journal knows. */
function kindOf(v: unknown): JournalKind | null {
  if (typeof v !== 'string') return null;
  if (isKind(v)) return v;
  return LEGACY_KINDS[v] ?? null;
}

export interface JournalReadResult {
  readonly events: readonly JournalEvent[];
  readonly warnings: readonly string[];
}

/**
 * Read the journal. A malformed line is reported and skipped, never fatal and
 * never silently dropped: a log with one bad line still holds every good one.
 */
export async function readJournal(featureDir: string): Promise<JournalReadResult> {
  let raw: string;
  try {
    raw = await readFile(join(featureDir, JOURNAL_FILE), 'utf8');
  } catch {
    return { events: [], warnings: [] };
  }
  const events: JournalEvent[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`line ${i + 1} is not JSON; skipped`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`line ${i + 1} is not an object; skipped`);
      continue;
    }
    const o = parsed as Record<string, unknown>;
    const at = typeof o['at'] === 'string' ? o['at'] : '';
    const kind = kindOf(o['kind']);
    if (at === '' || Number.isNaN(Date.parse(at))) {
      warnings.push(`line ${i + 1} has no usable timestamp; skipped`);
      continue;
    }
    if (kind === null) {
      warnings.push(`line ${i + 1} has an unknown kind "${String(o['kind'])}"; skipped`);
      continue;
    }
    events.push({
      at,
      kind,
      ref: typeof o['ref'] === 'string' ? o['ref'] : '',
      detail: typeof o['detail'] === 'string' ? o['detail'] : '',
      ...(o['data'] !== undefined && o['data'] !== null && typeof o['data'] === 'object'
        ? { data: o['data'] as Record<string, unknown> }
        : {}),
    });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { events, warnings };
}

/** Append one event. The only write path; nothing ever rewrites this file. */
export async function appendEvent(
  featureDir: string,
  event: Omit<JournalEvent, 'at'> & { readonly at?: string },
): Promise<JournalEvent> {
  const full: JournalEvent = {
    at: event.at ?? new Date().toISOString(),
    kind: event.kind,
    ref: event.ref,
    detail: event.detail,
    ...(event.data === undefined ? {} : { data: event.data }),
  };
  await mkdir(featureDir, { recursive: true });
  await appendFile(join(featureDir, JOURNAL_FILE), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

/**
 * How a change left the feature that received it.
 *
 * There are exactly two ways, and the difference is not cosmetic. `absorbed`
 * means this feature's own spec, tickets and code now cover it. `followed-up`
 * means the work went somewhere else — so this feature is done *asking* about it
 * without ever having *done* it. Folding both into "closed" would let a feature
 * report a change as handled when all it did was forward it.
 */
export type ChangeOutcome =
  /** grilled here, and this feature's spec/tickets carry the result */
  | 'absorbed'
  /** handed to a follow-up feature; `followedUpBy` names it */
  | 'followed-up';

/** A change request, as the journal records it: opened, maybe closed. */
export interface ChangeRecord {
  readonly id: string;
  readonly text: string;
  readonly openedAt: string;
  /** Closed *in this feature* — which for a follow-up means closed here and open
   *  there. The pending work moved; it did not disappear. */
  readonly status: 'open' | 'closed';
  readonly closedAt: string | null;
  readonly note: string | null;
  /** Null while open. */
  readonly outcome: ChangeOutcome | null;
  /**
   * The follow-up feature's slug, when it went somewhere else.
   *
   * A slug and not a path: the child is created under the same workspace as the
   * parent, so the parent's root plus this slug addresses it exactly. Storing a
   * root as well would let the two disagree, and there would be no way to say
   * which one was right.
   */
  readonly followedUpBy: string | null;
  /**
   * How the system routed it, as it was decided at filing time.
   *
   * Null on journals written before triage existed — which is not the same as
   * "no decision": it means nobody recorded one.
   */
  readonly verdict: ChangeVerdict | null;
}

/** Read a verdict back out of a journal line, refusing anything half-written. */
function verdictOf(data: Record<string, unknown> | undefined): ChangeVerdict | null {
  const v = data?.['verdict'];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const kind = o['kind'];
  const path = o['path'];
  const rule = o['rule'];
  if (typeof kind !== 'string' || typeof path !== 'string' || typeof rule !== 'string') return null;
  const evidence = Array.isArray(o['evidence'])
    ? o['evidence'].filter((e): e is string => typeof e === 'string')
    : [];
  return {
    kind: kind as ChangeVerdict['kind'],
    path: path as ChangeVerdict['path'],
    rule,
    why: typeof o['why'] === 'string' ? o['why'] : '',
    evidence,
  };
}

/**
 * The change requests, folded from the journal. Open ones are what the loop
 * has to deal with; closed ones stay on the record with the note that closed
 * them, because a change nobody can find afterwards is a change that will be
 * asked for again.
 */
export function changesFrom(events: readonly JournalEvent[]): readonly ChangeRecord[] {
  const byId = new Map<string, {
    id: string; text: string; openedAt: string;
    closedAt: string | null; note: string | null;
    outcome: ChangeOutcome | null; followedUpBy: string | null;
    verdict: ChangeVerdict | null;
  }>();
  for (const e of events) {
    if (e.kind === 'change.opened') {
      const text = typeof e.data?.['text'] === 'string' ? (e.data['text'] as string) : e.detail;
      byId.set(e.ref, {
        id: e.ref, text, openedAt: e.at,
        closedAt: null, note: null, outcome: null, followedUpBy: null,
        /* The verdict is recorded on its own line, a moment later; reading the
         * open's data first means a hand-written journal can still carry one. */
        verdict: verdictOf(e.data),
      });
    } else if (e.kind === 'change.decided') {
      const prior = byId.get(e.ref);
      if (prior === undefined) continue; // a decision about nothing is not a decision
      byId.set(e.ref, { ...prior, verdict: verdictOf(e.data) ?? prior.verdict });
    } else if (e.kind === 'change.closed') {
      const prior = byId.get(e.ref);
      if (prior === undefined) continue; // a close without an open is not a change
      byId.set(e.ref, {
        ...prior,
        closedAt: e.at,
        note: typeof e.data?.['note'] === 'string' ? (e.data['note'] as string) : e.detail,
        outcome: 'absorbed',
      });
    } else if (e.kind === 'change.followed-up') {
      const prior = byId.get(e.ref);
      if (prior === undefined) continue; // nor is a handoff
      const child = typeof e.data?.['child'] === 'string' ? (e.data['child'] as string) : '';
      byId.set(e.ref, {
        ...prior,
        closedAt: e.at,
        note: typeof e.data?.['note'] === 'string' ? (e.data['note'] as string) : e.detail,
        outcome: 'followed-up',
        followedUpBy: child.length > 0 ? child : null,
      });
    }
  }
  return [...byId.values()]
    .map((c) => ({
      ...c,
      status: c.closedAt === null ? ('open' as const) : ('closed' as const),
    }))
    .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0));
}

/** The changes still waiting on somebody. The one thing the stage ladder reads. */
export function openChangesFrom(events: readonly JournalEvent[]): readonly ChangeRecord[] {
  return changesFrom(events).filter((c) => c.status === 'open');
}

/** The next change id: `CH-01`, `CH-02`, … Existing ids are never reused. */
export function nextChangeId(events: readonly JournalEvent[]): string {
  let max = 0;
  for (const e of events) {
    if (e.kind !== 'change.opened') continue;
    const m = /^CH-(\d+)$/.exec(e.ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CH-${String(max + 1).padStart(2, '0')}`;
}

/**
 * Reconstruct the journal from the files.
 *
 * This is the honesty check for the whole scheme: if the files are the record,
 * the events must be derivable from them. Mtimes are used here and only here —
 * a rebuild is a best-feature reconstruction of *when*, and its real job is to
 * prove the *what* matches.
 */
export async function rebuild(featureDir: string): Promise<readonly JournalEvent[]> {
  const events: JournalEvent[] = [];
  const mtimeOf = async (path: string): Promise<string | null> => {
    try {
      const { stat } = await import('node:fs/promises');
      return (await stat(path)).mtime.toISOString();
    } catch {
      return null;
    }
  };

  // Rounds, and the answers recorded inside them.
  let roundFiles: string[] = [];
  try {
    roundFiles = (await readdir(join(featureDir, '.session'))).filter((f) => /^\d{2}\.json$/.test(f)).sort();
  } catch {
    /* no session */
  }
  for (const f of roundFiles) {
    const path = join(featureDir, '.session', f);
    const at = await mtimeOf(path);
    if (at === null) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
      parsed = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    } catch {
      continue;
    }
    const round = String(parsed?.['round'] ?? Number(f.slice(0, 2)));
    events.push({
      at, kind: 'round.written', ref: `round ${round}`,
      detail: `${(parsed?.['questions'] as unknown[] | undefined)?.length ?? 0} question(s)`,
    });
    const answers = parsed?.['answers'];
    if (Array.isArray(answers) && answers.length > 0) {
      events.push({
        at, kind: 'answer.recorded', ref: `round ${round}`,
        detail: `${answers.length} answer(s)`,
        data: { answers },
      });
    }
  }

  // Runs.
  let runFiles: string[] = [];
  try {
    runFiles = (await readdir(join(featureDir, 'runs'))).filter((f) => f.endsWith('.json'));
  } catch {
    /* no runs */
  }
  for (const f of runFiles) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(await readFile(join(featureDir, 'runs', f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const stage = String(rec['stage'] ?? '');
    if (typeof rec['startedAt'] === 'string') {
      events.push({
        at: rec['startedAt'], kind: 'run.started', ref: stage,
        detail: `skill ${String(rec['skill'] ?? '(none)')}`,
        data: { jobId: rec['jobId'], demo: rec['demo'] === true },
      });
    }
    if (typeof rec['endedAt'] === 'string') {
      events.push({
        at: rec['endedAt'], kind: 'run.ended', ref: stage,
        detail: `${String(rec['status'])}${typeof rec['ms'] === 'number' ? ` · ${rec['ms']} ms` : ''}`,
        data: { jobId: rec['jobId'], status: rec['status'] },
      });
    }
  }

  // Decisions.
  let decisionLines: string[] = [];
  try {
    decisionLines = (await readFile(join(featureDir, 'decisions.jsonl'), 'utf8')).split(/\r?\n/);
  } catch {
    /* no decisions */
  }
  for (const line of decisionLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const d = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof d['ts'] !== 'string') continue;
      events.push({
        at: d['ts'], kind: 'decision.recorded', ref: String(d['gate'] ?? ''),
        detail: `${String(d['outcome'])} by ${String(d['actor'])}`,
        data: d,
      });
    } catch {
      continue;
    }
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return events;
}
