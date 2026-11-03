/**
 * The domain model.
 *
 * Two rules shape everything here, both taken from the prior feature in
 * `railyard`'s methodology-view map rather than invented here:
 *
 * 1. A stage's state is DERIVED FROM ARTIFACTS, never declared. A stage cannot
 *    claim to be complete; the presence of what it produces makes it so. This is
 *    what stops the display from becoming a second, disagreeing source of truth.
 *
 * 2. A gate is an immutable definition plus an append-only decision log, and the
 *    log is the only authority on the gate's state. Mutating a gate's state
 *    without recording why is "an authority nobody can audit".
 */

/** The nine-stage loop. `design` sits between `spec` and `split` on purpose:
 *  slices are sequenced against an interface, so slicing before the interface is
 *  fixed produces slices that get rewritten. */
export const STAGE_IDS = [
  'intake',
  'ask',
  'spec',
  'design',
  'split',
  'develop',
  'review',
  'ship',
  'retro',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

/**
 * - `absent`   its inputs are not there yet, so there is nothing to say about it
 * - `ready`    everything it needs exists and it has not started
 * - `active`   started, not finished
 * - `complete` its outputs exist
 * - `blocked`  an open gate is holding it
 * - `waived`   deliberately skipped, with a recorded reason
 */
export type StageState =
  | 'absent'
  | 'ready'
  | 'active'
  | 'complete'
  | 'blocked'
  | 'waived';

/** Gates are owned by a role, never a person. Roles let a solo operator run every
 *  gate today and map people onto roles later without touching a single gate. */
export const ROLE_IDS = ['po', 'tech', 'qa', 'ops', 'security', 'client'] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** Acceptance methods stack. Any subset may apply to one gate. */
export const METHOD_IDS = [
  'auto',
  'self',
  'lateral',
  'cross',
  'adversarial',
  'signoff',
] as const;
export type MethodId = (typeof METHOD_IDS)[number];

/** What happens when a gate is not passed. Four outcomes, all recorded. */
export const FAIL_ACTIONS = ['rework', 'lower', 'accept', 'escalate'] as const;
export type FailAction = (typeof FAIL_ACTIONS)[number];

export type GateScopeKind = 'stage' | 'slice' | 'artifact';

export interface GateScope {
  readonly kind: GateScopeKind;
  /** A stage id, a ticket id such as `07`, or a workspace-relative path. */
  readonly ref: string;
}

/** The immutable half. A gate definition never changes; only decisions accrue. */
export interface Gate {
  readonly id: string;
  readonly title: string;
  readonly stage: StageId;
  readonly scope: GateScope;
  readonly owner: RoleId;
  readonly methods: readonly MethodId[];
  readonly blocking: boolean;
  readonly onFail: FailAction;
  /** Where the human answers it. `rule` fires on a condition, `session` is
   *  raised mid-conversation, `manual` is placed by hand. */
  readonly raisedBy: 'rule' | 'session' | 'manual';
  readonly note?: string;
}

export type DecisionOutcome =
  /** every method passed and the owner signed off */
  | 'pass'
  /** sent back, lowered or accepted as a known limitation */
  | 'fail'
  /** the gate did not run and the crossing was reported, not absorbed */
  | 'skip'
  /** a human passed it against the evidence. Requires a reason. */
  | 'override';

/**
 * One line of `decisions.jsonl`. Append-only, never edited.
 *
 * `override` is the only outcome that may contradict the evidence, so it is the
 * only one that mandates `reason`. That asymmetry is the point: forcing a gate
 * should cost a sentence.
 */
export interface Decision {
  readonly ts: string;
  readonly gate: string;
  readonly outcome: DecisionOutcome;
  readonly actor: RoleId;
  /** Free text — who actually clicked. Roles are the gate's contract; this is
   *  the audit trail. */
  readonly actorName?: string;
  readonly methods: readonly MethodId[];
  /** Pointers to evidence, never copies. A copy goes stale; a pointer does not. */
  readonly evidence: readonly string[];
  readonly note?: string;
  readonly reason?: string;
  /** Present when the outcome was forced against a failing method. */
  readonly forcedFrom?: readonly MethodId[];
}

export type TicketType = 'grilling' | 'research' | 'prototype' | 'task';
export type TicketStatus =
  /** open and not started */
  | 'open'
  /** open, unblocked, unclaimed — the edge of the known */
  | 'frontier'
  /** open, but something it depends on is not done */
  | 'blocked'
  /** claimed: an assignee is on it */
  | 'claimed'
  /** done */
  | 'resolved'
  /** a status the parser did not recognise */
  | 'unknown';

export interface Ticket {
  /** `01`, `02`, … from the filename. Its identity. */
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly type: TicketType | 'unknown';
  readonly status: TicketStatus;
  /** Raw `Blocked by:` text, kept even when it cannot be parsed. */
  readonly blockedByRaw: string;
  /** Ticket ids this one waits on. Empty means it can start immediately. */
  readonly blockedBy: readonly string[];
  readonly question?: string;
  readonly answer?: string;
  /** Set when the file's shape did not match the convention. Surfaced, never
   *  swallowed — a ticket the parser drops is worse than one it flags. */
  readonly warnings: readonly string[];
}

/** A list entry from the map's `## Decisions so far`, pointer plus gist. */
export interface MapDecision {
  readonly title: string;
  readonly ref: string;
  readonly gist: string;
}

export type FeatureKind =
  /** a wayfinder map: decision tickets, produces decisions not deliverables */
  | 'map'
  /** a build: spec plus tracer-bullet tickets */
  | 'build';

export interface Feature {
  readonly slug: string;
  /** Absolute path to `.scratch/<slug>`. */
  readonly root: string;
  readonly kind: FeatureKind;
  /** What reaching the end looks like. Fixes the scope, so it is read first. */
  readonly destination: string;
  readonly notes: readonly string[];
  readonly decisionsSoFar: readonly MapDecision[];
  readonly notYetSpecified: readonly string[];
  readonly outOfScope: readonly string[];
  readonly tickets: readonly Ticket[];
  readonly gates: readonly Gate[];
  readonly stages: Readonly<Record<StageId, StageState>>;
  readonly warnings: readonly string[];
  /* Stage-dossier facts, read rather than derived: what the human sees when
   * they click a stage on the pipeline. Optional because they are presentation
   * facts — the derivation above never reads them. */
  /** Recent stage runs, newest last, capped — the execution record. */
  readonly runs?: readonly import('../tracker/runs.js').RunRecord[];
  /** ADRs under `docs/adr/`. */
  readonly adrCount?: number;
  /** Grilling rounds on disk (`NN.json` under `.session/`). */
  readonly sessionRounds?: number;
  /** Change requests still open, from the journal. Non-zero reopens `ask`. */
  readonly openChanges?: number;
  /**
   * The change requests themselves, newest last — the count above is derived from
   * these, but the count alone was not enough: a prompt that says "there is 1 open
   * change request" and nothing else tells an agent that something is wrong
   * without telling it what. The human's sentence is the requirement.
   */
  readonly changes?: readonly import('../tracker/journal.js').ChangeRecord[];
  /**
   * The feature's work has been accepted — a release record exists.
   *
   * Read from the release/retro file, never from `stages.ship`: the ladder
   * un-completes `ship` when a change reopens requirements, so asking the stages
   * after the first change would answer "no" for the second. Acceptance is a
   * fact about the past, and this is the only field that keeps it that way.
   */
  readonly accepted?: boolean;
  /**
   * The feature and change this one was derived from, when it was opened as a
   * follow-up. Null for a feature that started from an idea.
   */
  readonly derivedFrom?: {
    readonly parent: string;
    readonly change: string;
    readonly text: string;
  } | null;
}

export interface Project {
  /** Absolute path to the repository root. */
  readonly root: string;
  readonly name: string;
  /** `.scratch/` children, one per feature. */
  readonly features: readonly Feature[];
  /** Version control facts read from git, not assumed. */
  readonly git?: GitState;
  readonly warnings: readonly string[];
}

export interface GitState {
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
}

/** Everything the stage derivation is allowed to look at. Built by the parser,
 *  consumed by a pure function, so derivation is testable without a filesystem. */
export interface ArtifactFacts {
  readonly featureDir: boolean;
  readonly mapFile: boolean;
  readonly mapCleared: boolean;
  /** A destination has been named, which is what fixes the feature's scope. */
  readonly destinationNamed: boolean;
  /** The map carries a `## Handoff` section. Charting writes one when the map
   *  clears, and it is the plan — for a map feature it stands in for `spec.md`. */
  readonly hasHandoff: boolean;
  readonly glossaryTerms: number;
  readonly specFile: boolean;
  /** `**Design:**` declared in spec.md — either a design or an explicit waiver. */
  readonly designDeclared: boolean;
  /**
   * The design record this stage writes: a non-empty `design.md`.
   *
   * Not a second, stricter way to say `designDeclared` — the *other* way a
   * design gets declared. The stage prompt names `design.md` as the record to
   * leave, and a `codebase-design` agent that followed it did the stage's work
   * without ever touching a field in spec.md. Reading only the field left those
   * features at `design` forever: the run succeeded, the artifact existed, and
   * the ladder said otherwise.
   */
  readonly designFile: boolean;
  /** `**Design:** none - <reason>` — skipped on purpose, on the record. */
  readonly designWaived: boolean;
  readonly ticketCount: number;
  readonly ticketResolved: number;
  /**
   * Tickets that are work to build, as opposed to questions to answer.
   *
   * A `prototype` ticket exists to settle a question, so it is not a slice. Both
   * kinds live in the same `issues/` directory, so counting files conflated them
   * and made a freshly scaffolded feature look like it had already been sliced.
   */
  readonly sliceCount: number;
  readonly sliceResolved: number;
  /** Open, unblocked, unclaimed ticket ids. */
  readonly frontier: readonly string[];
  readonly reviewFile: boolean;
  readonly releaseFile: boolean;
  readonly retroFile: boolean;
  /**
   * Change requests from the journal that nobody has closed.
   *
   * A change is new requirement input, so while one is open the feature is
   * genuinely back at requirements: `ask` cannot be complete, and the cascade
   * marks the stages downstream of it as crossed rather than silently stale.
   */
  readonly openChanges: number;
}

/** A facts object with every observable unset. Useful as a base in tests and as
 *  the starting point for a parser that fills fields as it goes. */
export function emptyFacts(): ArtifactFacts {
  return {
    featureDir: false,
    mapFile: false,
    mapCleared: false,
    destinationNamed: false,
    hasHandoff: false,
    glossaryTerms: 0,
    specFile: false,
    designDeclared: false,
    designFile: false,
    designWaived: false,
    ticketCount: 0,
    ticketResolved: 0,
    sliceCount: 0,
    sliceResolved: 0,
    frontier: [],
    reviewFile: false,
    releaseFile: false,
    retroFile: false,
    openChanges: 0,
  };
}
