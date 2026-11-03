import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

/**
 * Creating a feature on disk.
 *
 * This is the only write path in the application that creates new material. Two
 * rules make it safe to expose:
 *
 * 1. **It never overwrites.** If the feature directory already exists, it refuses
 *    and says which path it found. A scaffolder that clobbers is one someone
 *    loses a day's work to.
 * 2. **It writes only inside `<root>/.scratch/<feature>/`.** The root and the slug
 *    are both validated, and the resolved path is checked to still be inside. A
 *    slug is never a path.
 *
 * What it writes is deliberately the *input* to the chain, not its output:
 * the map, the glossary and the spec. Tickets are `/to-tickets`' job, and design
 * is `/codebase-design`'s. Writing those here would do a skill's work for it,
 * which is the one thing this application is built not to do.
 */

export const FEATURE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ScaffoldInput {
  /** The repository root the feature belongs to. Must be an absolute path that
   *  already exists. */
  readonly root: string;
  readonly feature: string;
  readonly title: string;
  readonly destination: string;
  readonly notes?: readonly string[];
  /** From the clarifying rounds, as `question → answer` lines. */
  readonly decisions?: readonly string[];
  readonly notYetSpecified?: readonly string[];
  readonly outOfScope?: readonly string[];
  /** Terms the rounds produced. */
  readonly glossary?: readonly { readonly word: string; readonly meaning: string }[];
  /** The synthesised PRD. */
  readonly prd: {
    readonly problem: string;
    readonly solution: string;
    readonly stories: readonly string[];
    readonly decisions: readonly string[];
    readonly testing: readonly string[];
    readonly seam?: string;
    readonly outOfScope?: readonly string[];
  };
  /** Tickets for the questions that need a prototype rather than an answer. */
  readonly prototypeTickets?: readonly {
    readonly id: string;
    readonly title: string;
    readonly kind: 'logic' | 'ui';
    readonly reason: string;
  }[];
}

export interface ScaffoldResult {
  readonly featureDir: string;
  readonly files: readonly string[];
}

export class ScaffoldError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ScaffoldError';
    this.status = status;
  }
}

function asciiOnly(text: string, what: string): void {
  // The tracker is markdown that gets committed and diffed. Non-ASCII is fine in
  // prose, but a stray control character is not, and a NUL would truncate a file.
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== '\n' && ch !== '\t') {
      throw new ScaffoldError(`${what} contains a control character`, 400);
    }
  }
}

function heading(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function bullets(lines: readonly string[] | undefined, empty = '- (none recorded)'): string {
  if (lines === undefined || lines.length === 0) return empty;
  return lines.map((l) => `- ${l.trim()}`).join('\n');
}

function renderMap(input: ScaffoldInput): string {
  const parts: string[] = [];
  parts.push(`# Map: ${heading(input.title)}`);
  parts.push('');
  parts.push('## Destination');
  parts.push('');
  parts.push(input.destination.trim() || '(not stated)');
  parts.push('');
  parts.push('## Notes');
  parts.push('');
  parts.push(bullets(input.notes));
  parts.push('');
  parts.push('## Decisions so far');
  parts.push('');
  if (input.decisions === undefined || input.decisions.length === 0) {
    parts.push('- (none yet)');
  } else {
    for (const d of input.decisions) parts.push(`- ${d.trim()}`);
  }
  parts.push('');
  parts.push('## Not yet specified');
  parts.push('');
  parts.push(bullets(input.notYetSpecified));
  parts.push('');
  parts.push('## Out of scope');
  parts.push('');
  parts.push(bullets(input.outOfScope));
  parts.push('');
  return parts.join('\n');
}

function renderGlossary(input: ScaffoldInput): string {
  const parts: string[] = [];
  parts.push(`# Glossary: ${heading(input.title)}`);
  parts.push('');
  parts.push('Explanatory, never normative.');
  parts.push('');
  if (input.glossary === undefined || input.glossary.length === 0) {
    parts.push('_No terms recorded yet._');
    parts.push('');
    return parts.join('\n');
  }
  for (const g of input.glossary) {
    parts.push(`## ${g.word.trim()}`);
    parts.push('');
    parts.push(g.meaning.trim());
    parts.push('');
  }
  return parts.join('\n');
}

function renderSpec(input: ScaffoldInput): string {
  const p = input.prd;
  const parts: string[] = [];
  parts.push(`# Spec: ${heading(input.title)}`);
  parts.push('');
  parts.push('## Problem Statement');
  parts.push('');
  parts.push(p.problem.trim() || '(not stated)');
  parts.push('');
  parts.push('## Solution');
  parts.push('');
  parts.push(p.solution.trim() || '(not stated)');
  parts.push('');
  parts.push('## User Stories');
  parts.push('');
  if (p.stories.length === 0) parts.push('(none recorded)');
  else p.stories.forEach((s, i) => parts.push(`${i + 1}. ${s.trim()}`));
  parts.push('');
  parts.push('## Implementation Decisions');
  parts.push('');
  parts.push(bullets(p.decisions));
  parts.push('');
  parts.push('## Testing Decisions');
  parts.push('');
  parts.push(bullets(p.testing));
  if (p.seam !== undefined && p.seam.trim().length > 0) {
    parts.push('');
    parts.push(`**Test seam:** ${p.seam.trim()}`);
  }
  parts.push('');
  parts.push('## Out of Scope');
  parts.push('');
  parts.push(bullets(p.outOfScope ?? input.outOfScope));
  parts.push('');
  parts.push('## Further Notes');
  parts.push('');
  parts.push('Generated by the concept-init wizard. The PRD above was synthesised from the');
  parts.push('clarifying rounds, not from a fresh interview.');
  parts.push('');
  // Deliberately NOT a design declaration.
  //
  // That field is load-bearing: `none - <reason>` counts as a waiver, and a
  // waiver means the stage is satisfied and the chain proceeds to slicing. A
  // scaffolder that wrote one would be making a decision the human has not
  // made, and would let every fresh feature skip design by default — exactly the
  // failure the stage exists to prevent.
  //
  // Left unset, the derivation reports `design` as active: started, not done.
  // That is the true state, and `/codebase-design` is what resolves it.
  //
  // The syntax is described rather than demonstrated, because a literal example
  // in prose is a parseable field as far as the scanner is concerned.
  parts.push('Design has not been settled yet. Run `/codebase-design` before `/to-tickets`;');
  parts.push('or, to skip it deliberately, add a design line near the top of this file whose');
  parts.push('value begins with the word "none" followed by your reason.');
  parts.push('');
  return parts.join('\n');
}

function renderPrototypeTicket(
  input: ScaffoldInput,
  t: NonNullable<ScaffoldInput['prototypeTickets']>[number],
): string {
  return [
    `# ${t.id}: ${heading(t.title)}`,
    '',
    '**Type:** prototype',
    '**Status:** open',
    '**Blocked by:** None (can start immediately)',
    '',
    '## Question',
    '',
    t.reason.trim(),
    '',
    '## Proposed answer',
    '',
    `A throwaway ${t.kind === 'ui' ? 'UI' : 'logic'} prototype. It exists to answer the`,
    'question above and is kept as a primary source on its own branch after it does.',
    '',
    '## Comments',
    '',
    `Raised by the concept-init wizard for ${heading(input.title)}: this question could`,
    'not be settled by talking.',
    '',
    '## Answer',
    '',
    '(open)',
    '',
  ].join('\n');
}

export async function scaffoldFeature(input: ScaffoldInput): Promise<ScaffoldResult> {
  const root = resolve(input.root);
  asciiOnly(input.title, 'title');
  asciiOnly(input.destination, 'destination');

  if (!FEATURE_SLUG.test(input.feature)) {
    throw new ScaffoldError(
      `invalid feature slug "${input.feature}": use lowercase letters, digits, dot, dash or underscore`,
    );
  }

  const rootInfo = await stat(root).catch(() => null);
  if (rootInfo?.isDirectory() !== true) {
    throw new ScaffoldError(`project root does not exist: ${root}`, 404);
  }

  const featureDir = normalize(join(root, '.scratch', input.feature));
  if (!featureDir.startsWith(normalize(join(root, '.scratch')))) {
    throw new ScaffoldError('resolved path escapes the project root');
  }

  const existing = await stat(featureDir).catch(() => null);
  if (existing !== null) {
    // Refuse rather than merge. A half-written feature is worse than none, and the
    // message says exactly which path was found so the human can decide.
    throw new ScaffoldError(
      `a feature already exists at ${featureDir}; pick another slug or remove it first`,
      409,
    );
  }

  const files: string[] = [];
  const write = async (name: string, body: string): Promise<void> => {
    const path = join(featureDir, name);
    await writeFile(path, body, 'utf8');
    files.push(path);
  };

  await mkdir(join(featureDir, 'issues'), { recursive: true });
  await write('map.md', renderMap(input));
  await write('GLOSSARY.md', renderGlossary(input));
  await write('spec.md', renderSpec(input));

  const prototypes = input.prototypeTickets ?? [];
  for (const t of prototypes) {
    const id = /^\d{1,3}$/.test(t.id) ? t.id.padStart(2, '0') : t.id;
    await write(join('issues', `${id}-${slug(t.title)}.md`), renderPrototypeTicket(input, { ...t, id }));
  }

  return { featureDir, files };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ticket'
  );
}
