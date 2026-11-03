import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Amending a feature's requirements document.
 *
 * A change that is filed, routed and coded but leaves the spec saying what it
 * said before is a lie waiting to be found: the next person reads the
 * requirements, believes them, and builds the old thing again. So the document
 * has to move.
 *
 * How it moves is the whole design. The original is **never overwritten or
 * deleted**. The amendment is appended, dated, and quotes what the section said
 * beforehand. That gives both things the reader needs at once: what it says
 * now, and what it used to say, with the date the difference appeared.
 *
 * Rewriting the section in place would be tidier to read and useless as a
 * record — you would see the current design and have no way to know it changed,
 * or when, or from what. A diff that cannot be read is not a diff.
 */

export interface Amendment {
  /** The change id, e.g. `CH-01`. */
  readonly id: string;
  /** The request, in the words it was filed in. */
  readonly text: string;
  /** When it was recorded. */
  readonly at: string;
  /** The heading of the section whose earlier text was captured, when there was one. */
  readonly section: string | null;
  /** What that section said before this change. Null when nothing was recorded. */
  readonly previous: string | null;
}

/** The section most likely to be the design, in the order they are looked for. */
const SECTIONS = ['Solution', 'Problem Statement', 'Destination', 'Goal'] as const;

/**
 * The text of one `## Heading` section, sans the heading.
 *
 * Returns null when the section is not there, or is empty. An empty section is
 * not a design, and quoting blank space back as "what it said before" would be
 * worse than saying nothing was recorded.
 */
export function sectionText(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let collecting = false;
  const out: string[] = [];
  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line);
    if (isHeading) {
      if (collecting) break;
      collecting = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'i').test(line.trim());
      continue;
    }
    if (collecting) out.push(line);
  }
  const text = out.join('\n').trim();
  return text.length === 0 ? null : text;
}

/**
 * The document as it was before any amendment was appended.
 *
 * "What it said before this change" has to mean the *design*, not the record of
 * previous amendments. Left alone, the second change quotes the first change's
 * amendment, the third quotes both, and the file grows by its own history —
 * while the sentence a reader came for, the original design, sinks further down
 * each time. The history is not lost: it is still in the file above, in order.
 */
export function withoutAmendments(markdown: string): string {
  const cut = markdown.search(/^##\s+Amendment\s+—/m);
  return (cut < 0 ? markdown : markdown.slice(0, cut)).trim();
}

/** The first section that actually has content, or null. */
function priorDesign(markdown: string): { section: string | null; text: string | null } {
  const before = withoutAmendments(markdown);
  for (const heading of SECTIONS) {
    const text = sectionText(before, heading);
    if (text !== null) return { section: heading, text };
  }
  /* Fall back to whatever the document said before it was amended: a spec with
   * no recognisable heading still said something, and losing it loses the only
   * design there is. */
  return before.length === 0 ? { section: null, text: null } : { section: null, text: before };
}

function block(input: Amendment): string {
  const quoted =
    input.previous === null
      ? '_Nothing was recorded before this. There was no prior design on file._'
      : input.previous
          .split(/\n/)
          .map((l) => `> ${l}`)
          .join('\n');
  const where = input.section === null ? 'the document' : `\`${input.section}\``;
  return [
    '',
    `## Amendment — ${input.id} — ${input.at}`,
    '',
    `**Requested:** ${input.text.trim().replace(/\n+/g, ' ')}`,
    '',
    `**Modified at:** ${input.at}`,
    '',
    `**What ${where} said before this change:**`,
    '',
    quoted,
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Append a dated amendment to the feature's `spec.md`, capturing the prior text.
 *
 * Creates the file when there is none. That is not a shortcut: for a feature
 * derived from a discovery there is no spec yet, and the first thing anyone has
 * asked for *is* the requirement. It says so, rather than pretending the blank
 * was a design.
 */
export async function recordAmendment(
  featureDir: string,
  input: { id: string; text: string; at?: string },
): Promise<{ file: string; amendment: Amendment }> {
  const file = join(featureDir, 'spec.md');
  const at = input.at ?? new Date().toISOString();
  const before = await readFile(file, 'utf8').catch(() => null);
  const prior = before === null ? { section: null, text: null } : priorDesign(before);
  const amendment: Amendment = {
    id: input.id,
    text: input.text,
    at,
    section: prior.section,
    previous: prior.text,
  };
  const next = (before ?? '# Requirements\n') + block(amendment);
  await writeFile(file, next, 'utf8');
  return { file, amendment };
}
