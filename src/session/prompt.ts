/**
 * The prompts that drive a grilling session.
 *
 * The governing rule, same as everywhere else in this codebase: **the skill file
 * is the protocol, and this module never restates it.** Every prompt here says
 * *which* skill to read and *what the app needs back*. It does not say how to
 * grill, what a good question is, when to offer an ADR, or how to sharpen a
 * fuzzy term — all of that lives in `grilling` and `domain-modeling`, and a copy
 * here would drift from it.
 *
 * What this module *does* own is the app's own contract: the round artifact. The
 * agent is asked to write each round of questions as JSON, because the app has to
 * render it as a form. Scraping questions out of prose would couple the app to
 * the model's formatting on a given day; asking for a file makes the round an
 * artifact like every other thing this system reads.
 */

export interface SkillPaths {
  /** Where the skill directories live. */
  readonly root: string;
}

export interface PromptContext {
  readonly featureSlug: string;
  readonly featureDir: string;
  readonly idea: string;
  readonly repoRoot: string;
  readonly skills: SkillPaths;
  /** Where the app expects the round artifact. */
  readonly sessionDir: string;
  /** 1-based. */
  readonly round: number;
  /**
   * Changes the human filed while this session was open.
   *
   * A change is filed from the same panel that runs the session, so the two
   * overlap in practice: the human files one, then answers the round that was
   * already on screen. Without this the next turn never hears about it, and the
   * change sits in the journal looking ignored until somebody runs a stage.
   */
  readonly openChanges?: readonly { readonly id: string; readonly text: string }[];
}

/** The JSON shape the app reads back. Documented in docs/adr/0007. */
export const ROUND_SCHEMA = `{
  "round": <integer, 1-based>,
  "kind": "questions" | "prd",
  "questions": [
    {
      "id": "q1",
      "title": "<short title>",
      "body": "<the question, possibly several sentences>",
      "why": "<why this can be asked now>",
      "recommended": "<your recommended answer, phrased so that "yes" accepts it>",
      "options": ["<option>", "<option>"]
    }
  ],
  "glossaryWritten": ["<term>", ...],
  "adrsWritten": ["<filename>", ...],
  "frontierEmpty": <boolean>
}`;

function header(ctx: PromptContext): string {
  const head = [
    `Read the skill at ${ctx.skills.root}/grill-with-docs/SKILL.md and follow it exactly.`,
    'It will send you to `grilling` and `domain-modeling`; read those too.',
    '',
    `Work in ${ctx.featureDir}.`,
    `The repository is ${ctx.repoRoot}. Do not write outside ${ctx.featureDir}.`,
  ];
  /* Quoted, never paraphrased. The sentence is the requirement, and a summary of
   * it is a second document that can disagree with the first. */
  const changes = ctx.openChanges ?? [];
  if (changes.length > 0) {
    head.push(
      '',
      '## Open change requests',
      '',
      'The human filed these while this conversation was open. They are the newest',
      'requirement input, and they are part of what this session has to settle:',
      '',
      ...changes.map((c) => `- ${c.id}: ${c.text.trim().replace(/\s+/g, ' ')}`),
      '',
      'Grill them the way you grilled the idea: what is now different, and what that',
      'makes untrue in what was already agreed. Where a change contradicts a settled',
      'answer, ask which one stands — do not assume the newer one wins.',
    );
  }
  return head.join('\n');
}

/**
 * The opening turn: the human's one fuzzy line, handed to the skill.
 *
 * The idea is quoted verbatim and explicitly not tidied, because the ambiguity is
 * the raw material the grilling exists to remove.
 */
export function startPrompt(ctx: PromptContext): string {
  return [
    header(ctx),
    '',
    '## The idea, as the human wrote it',
    '',
    '> ' + ctx.idea.trim(),
    '',
    'Do not tidy this up. The ambiguity is the point.',
    '',
    '## What this session is',
    '',
    `The feature is "${ctx.featureSlug}". It is starting from nothing: no spec, no`,
    'glossary, no ADRs. Your job across this session is to grill the human until the',
    'design is understood, and to write GLOSSARY.md and any ADRs as terms and',
    'decisions crystallise — that is what grill-with-docs is for.',
    '',
    '## What the app needs back',
    '',
    'The human answers through a form, so the app has to know what you are asking.',
    'After you have asked your first round of questions, also write this file:',
    '',
    `  ${ctx.sessionDir}/${pad(ctx.round)}.json`,
    '',
    'in exactly this shape:',
    '',
    '```json',
    ROUND_SCHEMA,
    '```',
    '',
    '- One entry per question you asked in this round, in the order you asked them.',
    '- `kind` must be `"questions"`. Only the app\'s closing PRD turn writes',
    '  `"kind": "prd"`, and it runs only after the human asks for it — never',
    '  claim it early, even when you think nothing is left to ask.',
    '- `recommended` is the answer you would give. The app shows it as the default,',
    '  so phrase it so that agreeing to it is a complete answer.',
    '- `options` is optional. Use it when the answer is a choice between a few',
    '  named things rather than free text.',
    '- `frontierEmpty` is true only when every branch of the design tree has been',
    '  visited and nothing is left silently assumed.',
    '- Also write the same file as `latest.json` so the app can find the current',
    '  round without listing the directory.',
    '',
    'Write the artifact in addition to whatever you say to the human, not instead',
    'of it.',
  ].join('\n');
}

/**
 * A round of answers, handed back into the same conversation.
 *
 * Deliberately terse: the conversation already holds the design tree, so this
 * only has to say what changed. Re-stating the history would invite the agent to
 * re-open settled questions.
 */
export function answerPrompt(
  ctx: PromptContext,
  answers: readonly { readonly id: string; readonly answer: string }[],
): string {
  const lines = answers.map((a) => `- ${a.id}: ${a.answer.trim()}`).join('\n');
  return [
    header(ctx),
    '',
    '## This round',
    '',
    'The human answered, through the app:',
    '',
    lines,
    '',
    'Carry on grilling. Move the frontier outward: ask what these answers have just',
    'unblocked, and nothing that depends on something still open.',
    'This continues the same session, so do not re-ask anything already settled.',
    '',
    `Then write ${ctx.sessionDir}/${pad(ctx.round)}.json and ${ctx.sessionDir}/latest.json`,
    'in the same shape as before, with `kind` kept as `"questions"` — the PRD',
    'turn is separate and happens only after the human asks for it. Set',
    '`frontierEmpty` to true only when there is genuinely nothing left to ask.',
  ].join('\n');
}

/**
 * The closing turn: turn the settled design into the PRD.
 *
 * The PRD is written as `spec.md` in the shape the rest of the system already
 * reads — the same sections the scaffolder writes and the scanner looks for.
 * Keeping that shape is not cosmetic: `design` is a stage in the loop, and the
 * spec is what declares it.
 */
export function prdPrompt(ctx: PromptContext): string {
  return [
    header(ctx),
    '',
    '## Closing the session',
    '',
    'The frontier is empty. Every branch of the design tree has been visited.',
    '',
    `Write the PRD to ${ctx.featureDir}/spec.md with exactly these sections, in this`,
    'order, as `## ` headings:',
    '',
    '1. `## Problem Statement` — what is wrong today.',
    '2. `## Solution` — what will exist instead, in a few sentences.',
    '3. `## User Stories` — a numbered list, each "As a <role>, I want <thing>, so that <reason>".',
    '4. `## Implementation Decisions` — the decisions the grilling settled.',
    '5. `## Testing Decisions` — what will be tested, and what will not.',
    '6. `## Test Seams` — the boundaries tests are written against. Prefer an existing',
    '   seam; use the highest one. The ideal number of new seams is zero.',
    '7. `## Out of Scope` — what this deliberately does not do. The explicit no-s are',
    '   as valuable as the yes-s.',
    '8. `## Design` — either the design in a few sentences, or, if the human decided',
    '   to skip design, the line `**Design:** none - <reason>`.',
    '',
    'Also update GLOSSARY.md and add any ADRs that the session produced but that have',
    'not been written yet. An ADR is only worth writing when the decision is hard to',
    'reverse, surprising without context, and the result of a real trade-off.',
    '',
    `Then write ${ctx.sessionDir}/latest.json with \`"kind": "prd"\` and an empty`,
    '`questions` array, so the app knows the session is finished.',
    '',
    'Do not invent requirements that were not settled. If something is genuinely',
    'undecided, put it under Out of Scope or leave a clearly marked note; a PRD that',
    'says more than the grilling established is worse than one that says less.',
  ].join('\n');
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}
