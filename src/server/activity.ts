/**
 * What the tool is doing right now.
 *
 * Long work in this application is invisible by default: an agent runs for
 * minutes, and the only thing that comes back is a final answer. That is fine
 * when it succeeds and useless when you are wondering whether it is stuck — and
 * "is it stuck" is the question people actually ask.
 *
 * So every long-running operation gets a record here: what it is, which step it
 * reached, and what it has written so far. Two sources feed it, and the second
 * is the honest one:
 *
 * 1. **Orchestration steps** — the tool knows when it starts a pass, and which
 *    one, because the tool decided to run it.
 * 2. **Files appearing on disk** — the agent does not stream its thoughts, so
 *    what it is *reading* cannot be known. What it has *produced* can, and be
 *    observed rather than inferred. A line saying "wrote domain/domain-model.md"
 *    is a fact; a line saying "analysing the domain" would be a guess dressed as
 *    one.
 *
 * In memory only, on purpose. This is a view of the present, not a record of the
 * past: a restart clears it, and the durable answers — the journal, the files —
 * are already on disk. Pretending otherwise would make this look like history
 * while quietly losing it.
 */

export type ActivityStatus = 'running' | 'succeeded' | 'failed';

export type StepKind = 'start' | 'note' | 'wrote' | 'error';

export interface ActivityStep {
  readonly at: string;
  readonly kind: StepKind;
  readonly text: string;
}

export interface Activity {
  readonly id: string;
  /** What sort of work: `clone`, `discovery`, `run`, `change`, `derive`. */
  readonly kind: string;
  /** One line a human can read, already localised by the caller if it knows how. */
  readonly label: string;
  /** The project or feature root the work belongs to, when there is one. */
  readonly target: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: ActivityStatus;
  readonly error: string | null;
  /** 0..1, only when the work has a shape that makes a fraction meaningful. */
  readonly progress: number | null;
  readonly steps: readonly ActivityStep[];
}

/** The record as it is held: the fields a caller may only read are writable
 *  here, which is the only place that can move them. */
interface ActivityRecord {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly target: string | null;
  readonly startedAt: string;
  endedAt: string | null;
  status: ActivityStatus;
  error: string | null;
  progress: number | null;
  steps: ActivityStep[];
}

/** Finished work is kept for a while, so closing a dialog and coming back still
 *  shows what happened. Capped: an unbounded list is a memory leak with a UI. */
const KEEP_FINISHED = 40;
/** Steps are capped per item for the same reason. */
const KEEP_STEPS = 200;

const items: ActivityRecord[] = [];
let seq = 0;

export interface ActivityHandle {
  readonly id: string;
  /** Append a step. Kinds are typed because the UI renders them differently. */
  note(text: string, kind?: StepKind): void;
  wrote(text: string): void;
  progress(fraction: number): void;
  end(status: 'succeeded' | 'failed', error?: string | null): void;
}

/**
 * Start tracking a piece of work.
 *
 * Newest first in the list, because the thing running now is the thing being
 * looked for. Finished items sink as new ones arrive and drop off the end.
 */
export function beginActivity(input: {
  kind: string;
  label: string;
  target?: string | null;
  now?: () => Date;
}): ActivityHandle {
  seq += 1;
  const id = `a-${seq.toString(36)}-${Date.now().toString(36)}`;
  const now = input.now ?? (() => new Date());
  const item: ActivityRecord = {
    id,
    kind: input.kind,
    label: input.label,
    target: input.target ?? null,
    startedAt: now().toISOString(),
    endedAt: null,
    status: 'running',
    error: null,
    progress: null,
    steps: [],
  };
  items.unshift(item);

  const push = (text: string, kind: StepKind): void => {
    if (item.steps.length >= KEEP_STEPS) item.steps.shift();
    item.steps.push({ at: now().toISOString(), kind, text });
  };

  return {
    id,
    note: (text, kind = 'note') => push(text, kind),
    wrote: (text) => push(text, 'wrote'),
    progress: (fraction) => {
      item.progress = Math.max(0, Math.min(1, fraction));
    },
    end: (status, error = null) => {
      item.status = status;
      item.error = error;
      item.endedAt = now().toISOString();
      /* Sink it below everything still running. Not "below the first finished
       * item", and not "if it is not already at the front": items are added at
       * the front, so the usual case is a *newer* job finishing while an older
       * one still runs — and that is exactly the case where leaving it at the
       * front puts finished work above live work. */
      const at = items.indexOf(item);
      if (at >= 0) items.splice(at, 1);
      let insert = 0;
      for (let i = 0; i < items.length; i += 1) {
        if (items[i] !== undefined && items[i]!.status === 'running') insert = i + 1;
      }
      items.splice(insert, 0, item);
      while (items.filter((x) => x.status !== 'running').length > KEEP_FINISHED) {
        const last = items.map((x, i) => ({ x, i })).filter((e) => e.x.status !== 'running').pop();
        if (last === undefined) break;
        items.splice(last.i, 1);
      }
    },
  };
}

/** Everything being tracked, running first. */
export function readActivity(): readonly Activity[] {
  return items.slice();
}

/** One activity, or null. Used by a caller that wants to poll a single job. */
export function findActivity(id: string): Activity | null {
  return items.find((x) => x.id === id) ?? null;
}

/** Test seam: forget everything. */
export function clearActivity(): void {
  items.length = 0;
  seq = 0;
}
