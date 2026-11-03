import { STAGE_IDS } from './types.js';
import type { ArtifactFacts, StageId, StageState, TicketStatus } from './types.js';

/**
 * Stage derivation. A pure function of observed facts — no filesystem, no clock,
 * no configuration — so the rules can be tested directly and cannot quietly
 * disagree with what is on disk.
 *
 * The ladder is a prerequisite chain: each stage requires the one before it. A
 * stage whose prerequisites are met but whose own output is missing is `ready`;
 * one showing partial evidence of having started is `active`.
 */

/** What each stage produces, and what counts as having started it. Ordered. */
interface StageRule {
  readonly id: StageId;
  /** The stage is complete when this is true. */
  readonly done: (f: ArtifactFacts) => boolean;
  /** Evidence that work began, used to tell `active` from `ready`. */
  readonly started: (f: ArtifactFacts) => boolean;
}

const RULES: readonly StageRule[] = [
  {
    id: 'intake',
    // A destination is the first act of charting: it fixes scope, so a feature
    // without one has not really been taken in yet.
    done: (f) => f.featureDir && f.destinationNamed,
    started: (f) => f.featureDir,
  },
  {
    id: 'ask',
    // Sharpening leaves a paper trail: glossary terms, and on a map, a cleared
    // frontier. An open change request outranks both: a change is new
    // requirement input, so until it has been grilled and closed the feature has
    // not finished asking — whatever the glossary already says.
    done: (f) => (f.glossaryTerms > 0 || f.mapCleared) && f.openChanges === 0,
    started: (f) => f.mapFile || f.specFile || f.openChanges > 0,
  },
  {
    id: 'spec',
    // For a build, the spec file. For a map, the Handoff section: charting writes
    // one when the way is clear, and it *is* the plan the skill graph collapses
    // the map into. Requiring a spec.md from a wayfinder feature would be asking
    // it for an artifact its own protocol never produces.
    done: (f) => f.specFile || f.hasHandoff,
    started: (f) => f.glossaryTerms > 0 || f.mapCleared,
  },
  {
    id: 'design',
    // Declared either way: a design, or an explicit waiver with a reason. The
    // waiver counts as complete, because a recorded skip is a decision and an
    // unrecorded one is an oversight.
    //
    // `designFile` is the other half of "declared". The stage prompt names
    // design.md as the record to leave; reading only the `**Design:**` field
    // made the ladder disagree with the directory — a feature whose design run
    // had succeeded and written its record sat at `active`, so the AFK chain
    // stopped on work that was finished.
    done: (f) => (f.specFile || f.hasHandoff) && (f.designDeclared || f.designFile),
    started: (f) => f.specFile || f.hasHandoff,
  },
  {
    id: 'split',
    // Slices, not tickets: a prototype ticket is a question to answer, and a
    // question is not a slice.
    done: (f) => f.sliceCount > 0,
    // No partial state is observable: either tickets have been cut or they have
    // not. Claiming `active` here would invent progress that leaves no trace.
    started: () => false,
  },
  {
    id: 'develop',
    done: (f) => f.sliceCount > 0 && f.sliceResolved === f.sliceCount,
    started: (f) => f.sliceCount > 0,
  },
  {
    id: 'review',
    done: (f) => f.reviewFile,
    started: (f) => f.sliceCount > 0 && f.sliceResolved === f.sliceCount,
  },
  {
    id: 'ship',
    done: (f) => f.releaseFile,
    started: (f) => f.reviewFile,
  },
  {
    id: 'retro',
    done: (f) => f.retroFile,
    started: (f) => f.releaseFile,
  },
];

export interface CrossedStage {
  /** The stage whose output exists. */
  readonly stage: StageId;
  /** The earlier stage that was never satisfied. */
  readonly over: StageId;
}

export interface DerivationResult {
  readonly stages: Record<StageId, StageState>;
  /**
   * Stages whose output exists while an earlier stage is unsatisfied.
   *
   * Reported, never absorbed. The board cannot stop an agent from writing the
   * next artifact, so the only honest thing it can do is say that it happened —
   * a gate that detected a crossing and folded it into "complete" would look
   * like governance while permitting exactly what it exists to prevent.
   */
  readonly crossed: readonly CrossedStage[];
}

/**
 * @param facts          what the parser observed
 * @param blockedStages  stages holding an open blocking gate
 */
export function deriveStages(
  facts: ArtifactFacts,
  blockedStages: readonly StageId[] = [],
): DerivationResult {
  const blocked = new Set<StageId>(blockedStages);
  const stages = {} as Record<StageId, StageState>;
  const crossed: CrossedStage[] = [];

  // No feature directory, nothing to report. Returning a ladder of `ready` for a
  // tree that does not exist would read as "nine stages waiting for you".
  if (!facts.featureDir) {
    for (const id of STAGE_IDS) stages[id] = 'absent';
    return { stages, crossed };
  }

  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i]!;
    const prev = i === 0 ? null : RULES[i - 1]!;
    const prevState: StageState = prev ? stages[prev.id]! : 'complete';

    // A gate outranks everything: if a human has not answered it, the stage is
    // not complete however much of its output has appeared.
    if (blocked.has(rule.id)) {
      stages[rule.id] = 'blocked';
      continue;
    }

    if (rule.id === 'design' && facts.designWaived) {
      stages[rule.id] = 'waived';
      continue;
    }

    const valid = prevState === 'complete' || prevState === 'waived';
    const last = i === RULES.length - 1;

    if (rule.done(facts)) {
      if (valid || last) {
        stages[rule.id] = 'complete';
      } else {
        // Its output is on disk but the chain never reached it. Say so.
        stages[rule.id] = 'active';
        crossed.push({ stage: rule.id, over: prev!.id });
      }
      continue;
    }

    if (!valid && prevState !== 'active') {
      stages[rule.id] = 'absent';
      continue;
    }

    stages[rule.id] = rule.started(facts) ? 'active' : 'ready';
  }

  return { stages, crossed };
}

/**
 * The stage a feature is actually operating at — the first stage that is not
 * complete, ignoring waived ones.
 *
 * Deliberately not "the furthest completed stage". A feature whose finished work
 * sits at `retro` while new work is back at `split` is operating, and reporting
 * `retro` would hide the thing that needs a human.
 */
export function operatingStage(
  stages: Readonly<Record<StageId, StageState>>,
): StageId {
  for (const id of STAGE_IDS) {
    const s = stages[id];
    if (s !== 'complete' && s !== 'waived') return id;
  }
  return 'retro';
}

/** How far along, counted in completed stages. Deliberately a count of discrete
 *  stages rather than a percentage: a percentage over nine stages claims a
 *  precision the loop does not have. */
export function completedCount(
  stages: Readonly<Record<StageId, StageState>>,
): number {
  return STAGE_IDS.filter((id) => stages[id] === 'complete').length;
}

/** Stages that need a human before anything downstream can move. */
export function blockedStages(
  stages: Readonly<Record<StageId, StageState>>,
): readonly StageId[] {
  return STAGE_IDS.filter((id) => stages[id] === 'blocked');
}

/**
 * Ticket status from the parsed fields.
 *
 * Order matters, and it is the order the tracker doc states: resolved first
 * (a written resolution wins over a computed one, because the written record is
 * what a human reviewed), then blocked, then claimed, and whatever is left is the
 * frontier.
 */
export function classifyTicket(input: {
  readonly rawStatus: string;
  readonly blockedBy: readonly string[];
  readonly resolvedIds: ReadonlySet<string>;
}): TicketStatus {
  const raw = input.rawStatus.trim().toLowerCase();

  if (raw === 'resolved' || raw === 'closed' || raw === 'done') return 'resolved';
  if (raw === '') return 'unknown';

  const unmet = input.blockedBy.filter((id) => !input.resolvedIds.has(id));
  if (unmet.length > 0) return 'blocked';

  if (raw === 'claimed' || raw === 'in-progress' || raw === 'in progress') {
    return 'claimed';
  }
  if (raw === 'open' || raw === 'ready-for-agent' || raw === 'ready') {
    return 'frontier';
  }
  return 'unknown';
}

/** All ticket ids that close every blocker. Used to detect a dangling edge. */
export function danglingBlockers(
  tickets: readonly { readonly id: string; readonly blockedBy: readonly string[] }[],
): readonly { readonly from: string; readonly missing: string }[] {
  const known = new Set(tickets.map((t) => t.id));
  const out: { from: string; missing: string }[] = [];
  for (const t of tickets) {
    for (const b of t.blockedBy) {
      if (!known.has(b)) out.push({ from: t.id, missing: b });
    }
  }
  return out;
}

/** Blockers that can never be satisfied because the edge is circular. */
export function cycles(
  tickets: readonly { readonly id: string; readonly blockedBy: readonly string[] }[],
): readonly string[][] {
  const edges = new Map<string, string[]>();
  for (const t of tickets) edges.set(t.id, [...t.blockedBy]);
  const found: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const at = stack.indexOf(id);
      found.push(stack.slice(at).concat(id));
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) walk(next);
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of edges.keys()) walk(id);
  return found;
}
