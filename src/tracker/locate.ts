import type { Feature } from '../domain/types.js';

/**
 * Which feature a sentence is about.
 *
 * Someone saying "change 登陆 to 登录 on the login page" has not said which of
 * twelve features to open, and making them find out is the wrong ask — the tool
 * has every feature's own words on disk and can look. But guessing is also
 * wrong: opening a change against the wrong feature writes a decision into that
 * feature's journal, and a wrong decision in the record is harder to undo than
 * to avoid.
 *
 * So the answer is ranked, scored and shown with its reasons. Where nothing in
 * the request matches anything on disk, the honest answer is "no candidate" —
 * which is different from "the first one", and the caller then asks a human
 * instead of picking for them.
 *
 * No agent here. Matching words to words is a rule, not judgement, and a rule
 * that can be shown is a rule that can be argued with.
 */

export interface Candidate {
  readonly slug: string;
  /** Higher is better. Zero means nothing matched at all. */
  readonly score: number;
  /** Why this one, in words the human can check. */
  readonly reasons: readonly string[];
}

export interface LocatedFeature {
  /** The best candidate, or null when nothing matched. */
  readonly best: Candidate | null;
  readonly candidates: readonly Candidate[];
  /**
   * Whether the top answer stands far enough above the rest to act on.
   *
   * False when two features score the same, and false when nothing scored: in
   * both cases the correct next step is to ask, not to take the first.
   */
  readonly confident: boolean;
}

/** Words too common to say anything about which feature is meant. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'please', 'change', 'modify', 'update', 'make', 'need',
  'want', 'should', 'can', 'you', 'i', 'we', 'my', 'our', 'with', 'from',
  '请', '把', '将', '修改', '改成', '改为', '一下', '的', '了', '我', '我们',
]);

/** Split into matchable tokens: latin words, and CJK runs of two or more. */
export function tokens(text: string): readonly string[] {
  const out: string[] = [];
  /* Three letters, not two. A two-letter word is a substring of half the
   * alphabet — "be" is inside "publishing", "is" inside "register" — so
   * counting it as evidence lets a sentence match a feature on a fragment that
   * was never written. The same rule as the stopwords, applied to length. */
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (word.length >= 3 && !STOP.has(word)) out.push(word);
  }
  /* Chinese has no spaces, so a request like "登录页面中的登陆" is one blob.
   * Bigrams are the cheap way to get comparable units out of it without a
   * dictionary: 登录/录页/页面 all appear, and the ones that match a feature's
   * own words are the ones that count. */
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** Everything a feature says about itself, as one bag of words. */
function featureText(feature: Feature): string {
  return [
    feature.slug.replace(/[-_]+/g, ' '),
    feature.destination,
    ...feature.notes,
    ...feature.notYetSpecified,
    ...feature.outOfScope,
    ...feature.tickets.map((t) => `${t.title} ${t.question ?? ''} ${t.answer ?? ''}`),
    ...feature.decisionsSoFar.map((d) => `${d.title} ${d.gist}`),
  ].join(' ');
}

/**
 * Score every feature against the request.
 *
 * Scoring, not search: every feature gets a number and a reason, so the runner
 * up is visible too. A single answer with no alternatives cannot be checked,
 * and an answer that cannot be checked is an answer to trust blindly.
 */
export function locateFeature(
  features: readonly Feature[],
  request: string,
): LocatedFeature {
  const asked = tokens(request);
  const candidates: Candidate[] = [];

  for (const feature of features) {
    const haystack = featureText(feature).toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    for (const token of asked) {
      if (!haystack.includes(token)) continue;
      score += token.length >= 4 ? 2 : 1;
      reasons.push(token);
    }
    /* The slug is the strongest signal there is: a request naming "login" that
     * lands on a feature called "login" is not a coincidence worth ignoring. */
    const slugWords = feature.slug.toLowerCase().split(/[-_]+/).filter((w) => w.length >= 2);
    for (const word of slugWords) {
      if (request.toLowerCase().includes(word)) {
        score += 3;
        reasons.push(`slug:${word}`);
      }
    }

    if (score > 0) {
      candidates.push({
        slug: feature.slug,
        score,
        reasons: [...new Set(reasons)].slice(0, 6),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  return {
    best,
    candidates,
    /* Confident needs a winner, a real margin over the runner-up, and more than
     * a single weak match — one shared common word is not evidence. */
    confident:
      best !== null &&
      best.score >= 3 &&
      (runnerUp === null || best.score >= runnerUp.score + 2),
  };
}

/**
 * The second step, when the rules cannot decide.
 *
 * Returns a prompt for an agent that is handed the request and the short list
 * with each one's own words. It is told to answer from those words and to say
 * "none" rather than guess, because a list with no right answer on it is a real
 * possibility, and an agent that must choose will choose.
 */
export function disambiguationPrompt(
  request: string,
  candidates: readonly Candidate[],
  features: readonly Feature[],
): string {
  const lines = candidates.slice(0, 5).map((c, i) => {
    const feature = features.find((f) => f.slug === c.slug);
    /* A feature derived from a reading has no destination of its own yet — the
     * derived ones carry what the area said, and a map is written later. Sending
     * an empty description would ask the agent to choose between two blank
     * lines, so the matched words stand in: they are the only evidence there is,
     * and saying what they are is better than saying nothing. */
    const said =
      feature !== undefined && feature.destination.trim().length > 0
        ? feature.destination
        : `no destination recorded yet; it was matched on: ${c.reasons.join(', ')}`;
    return `${i + 1}. ${c.slug} — ${said}`;
  });
  return [
    'A change request was filed, and the rules could not tell which feature it',
    'belongs to. Read the list and choose.',
    '',
    `The request, in the human's own words:`,
    `> ${request.trim()}`,
    '',
    'The candidates, with what each one says it is for:',
    ...lines,
    '',
    'Answer with just the slug of the one it belongs to. If none of them is',
    'right, answer `none` — guessing writes a decision into the wrong',
    "feature's record, and that is worse than asking.",
  ].join('\n');
}
