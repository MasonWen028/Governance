/**
 * Change triage: what kind of change is this, and where does it go?
 *
 * A change request arrives as one sentence, and the first thing that has to
 * happen is a **routing decision**, because the route determines everything
 * after it: whether the feature's own spec is amended, or a new feature is opened
 * on top of a released baseline. Left to a human, that decision is made twice
 * (once by whoever files it, once by whoever reads it) and recorded nowhere.
 *
 * So it is a pure function with a rule table, in the same spirit as the skill
 * contracts: every verdict names the rule that produced it and quotes the words
 * it matched. Same sentence in, same verdict out — and a reader can disagree
 * with a *reason* instead of a feeling.
 *
 * What this deliberately is not
 * -----------------------------
 * Not a model call. A classifier whose answer changes between runs cannot be the
 * thing that decides whether a released baseline is rewritten, and it cannot be
 * argued with. The signals below are boring on purpose.
 *
 * Not a reading of the whole feature either. This runs at filing time, on the
 * sentence and one durable fact (was the work accepted). Everything else it
 * could consult — the spec, the tickets, the ADRs — is what the **grilling**
 * does, and it does it better. The job here is routing, not understanding.
 */

/** What the sentence is asking for. */
export type ChangeKind =
  /** the delivered thing does not match what was asked */
  | 'correction'
  /** the words or details of something already agreed */
  | 'refinement'
  /** something the destination does not currently cover */
  | 'extension'
  /** it invalidates a decision the feature already recorded */
  | 'breaking'
  /** nothing in the sentence says; only the baseline fact is left to decide */
  | 'unstated';

/** Which flow the change takes. */
export type ChangePath =
  /** amend this feature: spec, tickets, and the work downstream of them */
  | 'in-place'
  /** new feature, with its own flow from intake: the released thing stays as it is */
  | 'follow-up';

export interface TriageInput {
  readonly text: string;
  /**
   * The feature's work has been accepted — a release record exists.
   *
   * A fact about the past, not a stage state. The stage ladder legitimately
   * un-completes `ship` when a change reopens requirements, so reading
   * acceptance from `stages.ship` after the first change would answer "no" for
   * the second one.
   */
  readonly accepted: boolean;
}

export interface ChangeVerdict {
  readonly kind: ChangeKind;
  readonly path: ChangePath;
  /** The rule id that decided the path. The UI translates it; the log keeps it. */
  readonly rule: string;
  /** One sentence, for the journal and the agent. The UI renders from `rule`. */
  readonly why: string;
  /** The words from the change that the signals matched, in order, at most 3. */
  readonly evidence: readonly string[];
}

/**
 * A phrase that leans towards one kind of change.
 *
 * Strength 2 means the words name the change outright ("rewrite", "new
 * feature", "should say"); 1 means they only lean ("minor", "wording"). The
 * threshold for promoting a change to a follow-up feature is 2, because opening
 * a feature on a lean is the expensive mistake: an in-place change that turns
 * out to be bigger is corrected by the grilling, and a wrong feature is not.
 */
interface Signal {
  readonly kind: Exclude<ChangeKind, 'unstated'>;
  readonly strength: 1 | 2;
  readonly pattern: RegExp;
}

const SIGNALS: readonly Signal[] = [
  /* --- correction: the built thing is not what was asked for --- */
  { kind: 'correction', strength: 2, pattern: /\bshould (?:say|read|show|be|display)\b/i },
  { kind: 'correction', strength: 2, pattern: /\binstead of\b/i },
  { kind: 'correction', strength: 2, pattern: /\btypo\b/i },
  { kind: 'correction', strength: 2, pattern: /\b(?:wrong|incorrect)\b/i },
  { kind: 'correction', strength: 2, pattern: /\bdoes(?:n'?t| not) match\b/i },
  { kind: 'correction', strength: 2, pattern: /\bfix(?:es|ed|ing)?\b/i },
  /* "change X to Y" is a value being set, which is a correction; "replace the
   * architecture" is not, and the breaking signals below claim that phrasing. */
  { kind: 'correction', strength: 2, pattern: /\bchange[^.]{0,48}\bto\b/i },
  { kind: 'correction', strength: 2, pattern: /改为|改成|应该是|显示成|修正|修复|错了|错误|不要显示/ },
  { kind: 'correction', strength: 1, pattern: /而不是|换成文字|改为显示/ },

  /* --- refinement: same behaviour, different words --- */
  { kind: 'refinement', strength: 1, pattern: /\b(?:rename|reword|rephrase|tweak|rewording)\b/i },
  { kind: 'refinement', strength: 1, pattern: /\b(?:minor|wording|phrasing)\b/i },
  { kind: 'refinement', strength: 1, pattern: /文案|措辞|微调|润色|改名|字体大小|间距/ },

  /* --- extension: something the destination does not cover --- */
  { kind: 'extension', strength: 2, pattern: /\bnew (?:feature|capability|screen|page|endpoint|report|flow|integration|mode|view)\b/i },
  { kind: 'extension', strength: 2, pattern: /\badd (?:a |an )?(?:new )?(?:feature|screen|page|endpoint|report|mode|view|integration)\b/i },
  { kind: 'extension', strength: 2, pattern: /\balso (?:want|need|add|support|show)\b/i },
  { kind: 'extension', strength: 2, pattern: /\bas well as\b/i },
  /* "support for X" is how new capability usually arrives in a sentence that
   * contains none of the words above. */
  { kind: 'extension', strength: 2, pattern: /\bsupport for\b/i },
  { kind: 'extension', strength: 2, pattern: /\banother (?:screen|page|feature|report|mode|view)\b/i },
  { kind: 'extension', strength: 2, pattern: /新增|增加一个|还要|再加|另外还|多一个|扩展成/ },
  /* Leans towards more scope without claiming it. Kept at strength 1 on
   * purpose: "maybe more pages later" is not a scope decision, and opening an
   * feature on it would be the expensive mistake this table is built to avoid. */
  { kind: 'extension', strength: 1, pattern: /\b(?:more|extra) (?:screens?|pages?|features?|reports?)\b/i },
  { kind: 'extension', strength: 1, pattern: /最好也|顺便|如果方便|将来可能/ },

  /* --- breaking: it invalidates a decision already recorded --- */
  { kind: 'breaking', strength: 2, pattern: /\bre-?architect\b/i },
  { kind: 'breaking', strength: 2, pattern: /\brewrite\b/i },
  { kind: 'breaking', strength: 2, pattern: /\breplace the (?:architecture|stack|framework|database|schema|api|approach|design|model|storage)\b/i },
  { kind: 'breaking', strength: 2, pattern: /\bdifferent (?:approach|architecture|stack)\b/i },
  { kind: 'breaking', strength: 2, pattern: /重构|推翻|重新设计|换掉.{0,8}(?:架构|框架|方案|技术栈)|废弃|不用.{0,6}了，换个/ },
  { kind: 'breaking', strength: 1, pattern: /\bfrom scratch\b/i },
];

/** Riskier reading wins a tie: breaking > extension > correction > refinement. */
const PRIORITY: readonly Exclude<ChangeKind, 'unstated'>[] = [
  'breaking', 'extension', 'correction', 'refinement',
];

interface Tally {
  readonly kind: Exclude<ChangeKind, 'unstated'>;
  readonly score: number;
  readonly evidence: readonly string[];
}

function tally(text: string): readonly Tally[] {
  return PRIORITY.map((kind) => {
    let score = 0;
    const evidence: string[] = [];
    for (const signal of SIGNALS) {
      if (signal.kind !== kind) continue;
      const m = signal.pattern.exec(text);
      if (m === null) continue;
      score += signal.strength;
      evidence.push(m[0].trim());
    }
    return { kind, score, evidence };
  });
}

/** The strongest reading of the sentence, or `unstated` when nothing matched. */
function readKind(text: string): Tally | null {
  const tallies = tally(text).filter((x) => x.score > 0);
  if (tallies.length === 0) return null;
  /* Stable sort by score, then by PRIORITY order (already the array order). */
  return [...tallies].sort((a, b) => b.score - a.score)[0]!;
}

/**
 * Route one change.
 *
 * The table, in the order it is applied:
 *
 * 1. **Accepted work is a baseline.** Once a release record exists, the change
 *    is new work on top of it, whatever it says — a released feature is not
 *    rewritten, because its record is the evidence that the release happened.
 *    This outranks the sentence: reading the text first would let "small typo"
 *    quietly edit history.
 * 2. **A clear breaking signal** moves it out even before acceptance: the
 *    decision it invalidates is recorded in an ADR, and superseding a decision
 *    is its own piece of work.
 * 3. **A clear new-scope signal** likewise: the destination was fixed at
 *    intake, and growing it silently is how a feature becomes unbounded.
 * 4. **A correction or refinement** is amended here — that is what reopening
 *    the requirements stage is for.
 * 5. **Nothing readable** is amended here too, and the verdict says so. Opening
 *    a feature on a lean is the expensive mistake; the grilling is the place
 *    where an under-read change gets caught, and it has the spec in front of it.
 */
export function classifyChange(input: TriageInput): ChangeVerdict {
  const text = input.text.trim();
  const read = readKind(text);
  const evidence = read === null ? [] : read.evidence.slice(0, 3);

  if (input.accepted) {
    return {
      kind: read?.kind ?? 'unstated',
      path: 'follow-up',
      rule: 'baseline',
      why:
        'this feature produced a release record, so it is a baseline: the change ' +
        'is new work on top of it, not an edit to it',
      evidence,
    };
  }

  if (read !== null && read.score >= 2 && read.kind === 'breaking') {
    return {
      kind: 'breaking',
      path: 'follow-up',
      rule: 'breaking-decision',
      why: 'it invalidates a decision this feature recorded, and superseding a decision is its own feature',
      evidence,
    };
  }

  if (read !== null && read.score >= 2 && read.kind === 'extension') {
    return {
      kind: 'extension',
      path: 'follow-up',
      rule: 'new-scope',
      why: 'it asks for something the destination does not cover, and growing the destination is a new feature',
      evidence,
    };
  }

  if (read !== null && (read.kind === 'correction' || read.kind === 'refinement')) {
    return {
      kind: read.kind,
      path: 'in-place',
      rule: 'amend-here',
      why:
        read.kind === 'correction'
          ? 'it corrects what this feature built, so this feature is where the correction belongs'
          : 'it changes wording rather than scope, so it is amended where the wording lives',
      evidence,
    };
  }

  /* Something was read, but only as a lean. Naming it beats calling it
   * unclassified — the dossier should not claim to have understood nothing when
   * it matched a phrase — while still refusing to act on it. */
  if (read !== null) {
    return {
      kind: read.kind,
      path: 'in-place',
      rule: 'lean-only',
      why:
        'it leans that way without saying it, so it is handled here: the grilling ' +
        'is where a lean becomes a decision, and it has the spec in front of it',
      evidence,
    };
  }

  return {
    kind: 'unstated',
    path: 'in-place',
    rule: 'no-new-scope',
    why:
      'nothing in it says the scope grew, so it is handled here — if the grilling ' +
      'finds otherwise, the feature says so before anything is built',
    evidence,
  };
}

/**
 * Open changes an unattended requirements run may treat as answered.
 *
 * Kept here, next to the table that routed them, because "may be accepted
 * without a human present" is the same kind of judgement as "must go to a new
 * feature" — and because a policy written inside a chain callback cannot be
 * argued with in a test.
 *
 * Three refuses, each because the alternative is wrong:
 *
 * - routed to a follow-up feature — the work landed somewhere else, and closing
 *   it here would claim credit for it;
 * - filed while the run was in flight — it was not in the prompt, so this run
 *   cannot have answered it;
 * - no verdict — nobody recorded how it was routed, and accepting it would
 *   invent that decision rather than disagree with it.
 */
export interface AcceptableChange {
  readonly id: string;
  readonly openedAt: string;
  readonly status: 'open' | 'closed';
  readonly verdict: { readonly path: string } | null;
}

export function autoAcceptableIds(
  changes: readonly AcceptableChange[],
  runStartedAt: string,
): readonly string[] {
  return changes
    .filter((c) => c.status === 'open')
    .filter((c) => c.verdict !== null && c.verdict.path === 'in-place')
    .filter((c) => c.openedAt < runStartedAt)
    .map((c) => c.id);
}

/**
 * The follow-up feature's slug for a change: `<parent>-<chid>`, e.g.
 * `html-hello-world-ch-01`.
 *
 * Derived, not asked for. A slug the human types is a second naming decision
 * that can hide which change produced the feature; this one cannot be read any
 * other way.
 */
export function followUpSlug(parentSlug: string, changeId: string): string {
  return `${parentSlug}-${changeId.toLowerCase()}`;
}
