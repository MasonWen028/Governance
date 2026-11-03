import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { appendEvent } from './journal.js';
import { freeSlug } from './derive.js';

/**
 * Turning what a discovery found into features.
 *
 * Reading a codebase produces documents. Documents are not work: nothing has
 * been decided about any of them, no branch exists, and no ticket has been
 * written. The gap between "we now understand this system" and "we are doing
 * something about it" is where these features come from.
 *
 * Each area becomes a feature the same way a change request does — a directory,
 * one journal line saying where it came from, and an `INHERITED.md` naming the
 * discovery documents as **inputs**. Not a copy, for the reason that applies
 * everywhere else in this tool: a copy starts correct and rots the first time
 * the discovery is re-run.
 *
 * What is deliberately not created: a spec, a map, tickets, a PRD. Those are the
 * flow's output. Pre-filling them would be this module deciding what the area
 * means, and the whole point of reading the code first was to find out what a
 * human thinks it should mean. The feature starts at intake with a reason and a
 * reading list, and nothing else.
 */

export interface DiscoveredArea {
  /** A slug safe to use as a feature directory name. */
  readonly slug: string;
  /** The name as the discovery wrote it, kept for display and for the record. */
  readonly name: string;
  /** Path relative to the output root, e.g. `areas/billing.md`. */
  readonly file: string;
  /** One line: what this area is for. Empty when the document did not say. */
  readonly purpose: string;
}

/**
 * A slug for an area name.
 *
 * The pattern is the one `scaffold.ts` enforces on every feature slug, so a name
 * that survives this cannot be rejected later. Names are not paths, and a name
 * that reduces to nothing still has to become something — an unnamed area is
 * still an area.
 */
export function areaSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug.length === 0 ? 'area' : slug;
}

/**
 * The first line of a markdown document that says what it is about.
 *
 * The first heading is the name; after it, the first non-empty line that is not
 * another heading, not a table and not a fence is the purpose. Anything else is
 * structural furniture, and quoting it back would make the feature look like it
 * was described by a table of contents.
 */
function firstProse(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let seenHeading = false;
  /* Fenced blocks are tracked rather than skipped line by line, because the
   * lines *inside* a fence are prose-shaped and would otherwise be quoted as
   * the area's purpose — an architecture diagram is not a description. */
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      seenHeading = true;
      continue;
    }
    if (!seenHeading) continue;
    if (line.startsWith('|') || line.startsWith('>')) continue;
    if (line.startsWith('-') || line.startsWith('*') || /^\d+\./.test(line)) continue;
    return line.replace(/[*_`]/g, '').trim();
  }
  return '';
}

/**
 * The areas a discovery actually named, read off the disk.
 *
 * Two places an area can come from, in this order:
 *
 * 1. `areas/` under the output root — the skill writes one document per area
 *    there when the system is big enough to have areas at all.
 * 2. Nowhere. If `areas/` is absent, the answer is an empty list, and that is a
 *    fact to report rather than a gap to fill: inventing areas from a heading
 *    somewhere else would be this tool guessing at a boundary the reading did
 *    not find.
 *
 * A directory that exists but holds no markdown is also an empty list.
 */
export async function discoveredAreas(
  target: string,
  outputRoot: string,
): Promise<readonly DiscoveredArea[]> {
  const dir = join(resolve(target), outputRoot, 'areas');
  /* No `stat` first: `readdir` failing covers a missing directory, a missing
   * output root and an unreadable one, and a separate existence check would be a
   * second guard for the same hole — which is how a check ends up claiming to
   * hold something the next line actually holds. */
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  const out: DiscoveredArea[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const text = await readFile(join(dir, entry.name), 'utf8').catch(() => null);
    if (text === null) continue;
    /* The heading is the name the reading chose; the filename is only a fallback,
     * because `workflow-quote-request.md` is a document shape, not an area. */
    const heading = /^#\s+(.+)$/m.exec(text);
    const raw = heading === null ? basename(entry.name, '.md') : (heading[1] ?? '');
    const name = raw.replace(/[*_`]/g, '').trim();
    out.push({
      slug: areaSlug(name),
      name,
      file: `areas/${entry.name}`,
      purpose: firstProse(text),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DerivedAreaFeature {
  readonly slug: string;
  readonly dir: string;
  readonly name: string;
}

export interface AreaDeriveInput {
  /** The workspace root; features are created under `<root>/.scratch/`. */
  readonly root: string;
  /** Where the discovery wrote, relative to the root. */
  readonly outputRoot: string;
  readonly areas: readonly DiscoveredArea[];
  readonly now?: () => Date;
}

function inheritedFromArea(
  area: DiscoveredArea,
  input: AreaDeriveInput,
  filed: string,
): string {
  return `# Inherited from the discovery of this codebase

This feature exists because reading the code named **${area.name}** as one of the
areas of the system, on ${filed}. It is **not** a continuation of anything: it is
a new feature, and it produces its own spec, its own tickets, its own branch and
its own pull request.

## What the reading said

${area.purpose.length > 0 ? `> ${area.purpose}` : '> (the reading named this area without a one-line description)'}

From \`${input.outputRoot}/${area.file}\`.

## What to read first — and what not to touch

The discovery documents are **inputs**, not this feature's record:

- \`${input.outputRoot}/domain/domain-glossary.md\` — the words this system uses
- \`${input.outputRoot}/domain/domain-model.md\` — the things it is about
- \`${input.outputRoot}/business/business-requirements.md\` — what it is for
- \`${input.outputRoot}/tech/current-architecture.md\` — its shape, and its other areas
- \`${input.outputRoot}/${area.file}\` — this area

Do not write anything under \`${input.outputRoot}/\`. It is a record of what the
code said at a point in time; if this feature changes the code, the reading goes
stale, and re-running the discovery is how it is refreshed — not an edit.

## What is not decided yet

Nothing. The reading described this area; it did not decide to change it. What
this feature is *for* is the first thing to settle, and settling it is the
intake stage's job.
`;
}

/**
 * Create one feature per area.
 *
 * Journal line first, then the brief — so a directory is never left on disk
 * without a record of why it exists. Areas already taken (a feature of that name
 * is there) are skipped rather than reused: whatever is in that directory was
 * put there by something, and numbering around it keeps both intact.
 */
export async function deriveAreaFeatures(
  input: AreaDeriveInput,
): Promise<readonly DerivedAreaFeature[]> {
  const root = resolve(input.root);
  const filed = (input.now?.() ?? new Date()).toISOString().slice(0, 10);
  const out: DerivedAreaFeature[] = [];

  for (const area of input.areas) {
    const slug = await freeSlug(root, area.slug);
    const dir = join(root, '.scratch', slug);

    await appendEvent(dir, {
      kind: 'feature.derived',
      ref: `discovery/${area.file}`,
      detail: `area "${area.name}" from ${input.outputRoot}`,
      data: {
        source: 'discovery',
        area: area.name,
        file: area.file,
        outputRoot: input.outputRoot,
        filed,
      },
    });
    await writeFile(join(dir, 'INHERITED.md'), inheritedFromArea(area, input, filed), 'utf8');

    out.push({ slug, dir, name: area.name });
  }

  return out;
}

/**
 * What a derived feature inherited, as words a request can be matched against.
 *
 * A feature made from a reading has no map and no destination: the only thing
 * that says what it is for is the `INHERITED.md` the derivation wrote, and that
 * is exactly where the vocabulary lives — "quote request", "internal mailbox".
 * Matching only the slug meant a sentence using any of those words found
 * nothing, so the tool asked the human a question it already had the answer to.
 *
 * The whole document is used rather than just the quoted purpose, because the
 * heading "What to read first" names the same area in the same words and there
 * is no reason to throw it away. It is bounded anyway: a change request is a
 * sentence, and a feature's inheritance is not a novel.
 */
export async function inheritedWords(
  root: string,
  slug: string,
  limit = 4000,
): Promise<string | null> {
  const text = await readFile(join(root, '.scratch', slug, 'INHERITED.md'), 'utf8').catch(
    () => null,
  );
  if (text === null) return null;
  return text.slice(0, limit);
}
