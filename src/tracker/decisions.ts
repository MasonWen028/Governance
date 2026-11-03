import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { METHOD_IDS, ROLE_IDS } from '../domain/types.js';
import { appendEvent } from './journal.js';
import type { Decision, DecisionOutcome, Gate, MethodId, RoleId } from '../domain/types.js';

/**
 * The decision log.
 *
 * A gate is an immutable definition plus this file, and **this file is the only
 * authority on the gate's state**. That is the whole point of the shape: a button
 * that changes a gate without leaving a record produces a state nobody can audit,
 * and an unauditable approval is indistinguishable from one that never happened.
 *
 * Concretely: nothing here mutates. Every call appends one line. To reverse a
 * decision you append its opposite, which leaves both on the record.
 */

export const DECISIONS_FILE = 'decisions.jsonl';

type DecisionState = 'open' | 'passed' | 'failed' | 'skipped';

export interface DecisionReadResult {
  readonly decisions: readonly Decision[];
  readonly warnings: readonly string[];
}

const OUTCOMES: readonly DecisionOutcome[] = ['pass', 'fail', 'skip', 'override'];

function isOutcome(v: unknown): v is DecisionOutcome {
  return typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);
}

function isRole(v: unknown): v is RoleId {
  return typeof v === 'string' && (ROLE_IDS as readonly string[]).includes(v);
}

function isMethod(v: unknown): v is MethodId {
  return typeof v === 'string' && (METHOD_IDS as readonly string[]).includes(v);
}

/**
 * Problems that make a decision unacceptable.
 *
 * `override` is the one outcome allowed to contradict the evidence, so it is the
 * one that must justify itself. That asymmetry is intentional: forcing a gate
 * should cost a sentence, and a record without one is not a decision.
 */
export function validateDecision(d: Decision): readonly string[] {
  const problems: string[] = [];
  if (d.gate.trim().length === 0) problems.push('gate id is empty');
  if (!isOutcome(d.outcome)) problems.push(`unknown outcome: ${String(d.outcome)}`);
  if (!isRole(d.actor)) problems.push(`unknown role: ${String(d.actor)}`);
  if (!Array.isArray(d.methods) || d.methods.some((m) => !isMethod(m))) {
    problems.push('methods contains an unknown method');
  }
  if (Number.isNaN(Date.parse(d.ts))) problems.push(`ts is not a date: ${d.ts}`);
  if (d.outcome === 'override' && (d.reason ?? '').trim().length === 0) {
    problems.push('an override needs a reason');
  }
  if (d.outcome === 'pass' && (d.evidence ?? []).length === 0) {
    problems.push('a pass needs at least one piece of evidence');
  }
  return problems;
}

/**
 * Read the log. A malformed line is reported and skipped, never silently
 * dropped and never fatal: a log with one bad line still holds every good one.
 */
export async function readDecisions(featureDir: string): Promise<readonly Decision[]> {
  const result = await readDecisionsWithWarnings(featureDir);
  return result.decisions;
}

export async function readDecisionsWithWarnings(
  featureDir: string,
): Promise<DecisionReadResult> {
  const path = join(featureDir, DECISIONS_FILE);
  let raw: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { decisions: [], warnings: [] };
    raw = await readFile(path, 'utf8');
  } catch {
    return { decisions: [], warnings: [] };
  }

  const decisions: Decision[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object') {
        warnings.push(`${DECISIONS_FILE}:${i + 1} is not an object`);
        continue;
      }
      decisions.push(parsed as Decision);
    } catch (err) {
      warnings.push(`${DECISIONS_FILE}:${i + 1} is not valid JSON (${(err as Error).message})`);
    }
  }

  return { decisions, warnings };
}

/**
 * Resolve a gate's state from the log: the latest decision wins.
 *
 * `skip` maps to `skipped` rather than to a pass, because a gate that was
 * crossed without running is a fact the board must report. Absorbing it into
 * "passed" would look like governance while permitting exactly what the gate
 * exists to prevent.
 */
export function gateState(gate: Gate, decisions: readonly Decision[]): DecisionState {
  const mine = decisions.filter((d) => d.gate === gate.id);
  const last = mine[mine.length - 1];
  if (last === undefined) return 'open';
  switch (last.outcome) {
    case 'pass':
    case 'override':
      return 'passed';
    case 'fail':
      return 'failed';
    case 'skip':
      return 'skipped';
    default:
      return 'open';
  }
}

/** Every decision recorded against a gate, oldest first. The audit trail. */
export function decisionsFor(
  gate: Gate,
  decisions: readonly Decision[],
): readonly Decision[] {
  return decisions.filter((d) => d.gate === gate.id);
}

/** Gates with no decision yet and `blocking` set — what a human still owes. */
export function openBlockingGates(
  gates: readonly Gate[],
  decisions: readonly Decision[],
): readonly Gate[] {
  return gates.filter((g) => g.blocking && gateState(g, decisions) === 'open');
}

export interface AppendOptions {
  /** Injected so tests are deterministic. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/**
 * Append one decision.
 *
 * Creates `.scratch/<feature>/` if needed, but nothing outside it: the caller
 * passes the feature directory, and this function never walks upward. A gate that
 * could write outside its own feature would be a gate that could edit the
 * repository without a record, which is the failure this file exists to prevent.
 */
export async function appendDecision(
  featureDir: string,
  decision: Decision,
  options: AppendOptions = {},
): Promise<Decision> {
  const problems = validateDecision(decision);
  if (problems.length > 0) {
    throw new Error(`refusing to record a decision: ${problems.join('; ')}`);
  }

  const now = options.now ?? (() => new Date());
  const normalised: Decision = {
    ...decision,
    // The log is the record of when it happened, so the timestamp is set here
    // rather than trusted from a caller that might have a stale clock.
    ts: decision.ts.length > 0 ? decision.ts : now().toISOString(),
  };

  await mkdir(featureDir, { recursive: true });
  const path = join(featureDir, DECISIONS_FILE);
  // One line, one write. No read-modify-write, so nothing already on disk can be
  // lost or rewritten by this call.
  await appendFile(path, `${JSON.stringify(normalised)}\n`, 'utf8');
  await appendEvent(featureDir, {
    kind: 'decision.recorded',
    ref: normalised.gate,
    detail: `${normalised.outcome} by ${normalised.actor}`,
    data: { ...normalised },
  }).catch(() => undefined);
  return normalised;
}

/** Build a well-formed decision, filling the fields a caller should not have to. */
export function makeDecision(input: {
  readonly gate: string;
  readonly outcome: DecisionOutcome;
  readonly actor: RoleId;
  readonly methods: readonly MethodId[];
  readonly evidence?: readonly string[];
  readonly note?: string;
  readonly reason?: string;
  readonly actorName?: string;
  readonly now?: () => Date;
}): Decision {
  const now = input.now ?? (() => new Date());
  return {
    ts: now().toISOString(),
    gate: input.gate,
    outcome: input.outcome,
    actor: input.actor,
    methods: input.methods,
    evidence: input.evidence ?? [],
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.actorName === undefined ? {} : { actorName: input.actorName }),
  };
}
