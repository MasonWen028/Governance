import type {
  FeatureKind,
  MapDecision,
  Ticket,
  TicketType,
} from '../domain/types.js';

/**
 * Text-level parsing of the tracker's markdown.
 *
 * Written against a real corpus rather than an imagined format: the feature at
 * `railyard/.scratch/methodology-view` (one `map.md` plus thirteen `issues/*.md`)
 * is the reference. Everything here is a pure function of a string, so the
 * parser can be tested against that corpus without touching a filesystem.
 *
 * The governing rule is: **never drop something silently**. A shape the parser
 * does not recognise becomes a `warning` on the object it was trying to build.
 * A ticket the UI omits is worse than a ticket the UI flags.
 */

const EMPTY_FIELD = /^(-{2,}|—|–|)$/;

function isBlankField(value: string | undefined): boolean {
  if (value === undefined) return true;
  return EMPTY_FIELD.test(value.trim());
}

/** Split a markdown document into `## Heading` sections. Text before the first
 *  heading is returned under the empty key. */
export function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let key = '';
  let buf: string[] = [];

  const flush = (): void => {
    const body = buf.join('\n').trim();
    if (body.length > 0 || key.length > 0) {
      // Later sections with the same title append rather than overwrite: a
      // hand-written doc can repeat a heading, and losing the second one would
      // be a silent drop.
      const prior = out.get(key);
      out.set(key, prior === undefined ? body : `${prior}\n\n${body}`);
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(.*?)\s*$/.exec(line);
    if (m && !/^###/.test(line)) {
      flush();
      key = m[1]!.trim().toLowerCase();
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** The document's `# ` title, or an empty string. */
export function docTitle(markdown: string): string {
  const m = /^#\s+(.*?)\s*$/m.exec(markdown);
  return m ? m[1]!.trim() : '';
}

/** First `**Field:**` value in a document, case-insensitive on the field name. */
export function field(markdown: string, name: string): string | undefined {
  // One pattern, tolerant of where the colon sits: `**Type:** x` and `**Type**: x`
  // are both in the wild. The colon is consumed by the pattern rather than left
  // to be captured into the value, which is where it ended up in the first cut.
  const re = new RegExp(`^\\*\\*\\s*${name}\\s*:?\\s*\\*\\*\\s*:?\\s*(.*)$`, 'im');
  const m = re.exec(markdown);
  if (!m) return undefined;
  const value = m[1]!.trim();
  return isBlankField(value) ? undefined : value;
}

/** Bullet lines from a section body, preserving order. */
export function bullets(body: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) {
      if (current !== null) out.push(current.trim());
      current = m[1]!;
      continue;
    }
    // A continuation line belongs to the bullet above it, if indented or not.
    if (current !== null && line.trim().length > 0 && /^\s{2,}/.test(line)) {
      current += ` ${line.trim()}`;
    }
  }
  if (current !== null) out.push(current.trim());
  return out.filter((b) => b.length > 0);
}

const NONE_BLOCKERS = /^\s*none\b/i;

/**
 * Ticket ids from a `Blocked by:` value.
 *
 * Observed shapes in the real corpus: `None (can start immediately)`,
 * `01, 02`, and prose that names a ticket mid-sentence. A line that opens with
 * "none" is authoritative and yields no edges — otherwise prose in that line
 * could manufacture dependencies that do not exist.
 */
export function parseBlockedBy(raw: string): { ids: string[]; malformed: boolean } {
  const text = raw.trim();
  if (NONE_BLOCKERS.test(text)) return { ids: [], malformed: false };
  if (text.length === 0) return { ids: [], malformed: true };

  const ids = new Set<string>();
  // `01`, `1`, `#01`, `ticket 01`, `issues/01-x.md`. The trailing lookahead has
  // to accept `-` as well as whitespace, because a path shape like
  // `issues/03-state-source.md` puts a hyphen straight after the number.
  for (const m of text.matchAll(/(?:#|ticket\s+|issues\/)?(\d{1,3})(?=[\s,.)\]-]|$)/gi)) {
    ids.add(m[1]!.padStart(2, '0'));
  }
  if (ids.size === 0) return { ids: [], malformed: true };
  return { ids: [...ids].sort(), malformed: false };
}

function asTicketType(raw: string | undefined): TicketType | 'unknown' {
  if (raw === undefined) return 'unknown';
  const v = raw.trim().toLowerCase();
  if (v === 'grilling' || v === 'research' || v === 'prototype' || v === 'task') return v;
  return 'unknown';
}

/**
 * One `issues/NN-slug.md` file.
 *
 * @param id   from the filename, not the heading — the filename is what other
 *             tickets reference, so it is the identity.
 */
export function parseTicket(
  markdown: string,
  id: string,
  slug: string,
): Omit<Ticket, 'status'> & { readonly rawStatus: string } {
  const warnings: string[] = [];

  const title = docTitle(markdown);
  if (title.length === 0) warnings.push('no H1 title');

  const typeRaw = field(markdown, 'Type');
  if (typeRaw === undefined) warnings.push('no Type field');
  const type = asTicketType(typeRaw);
  if (typeRaw !== undefined && type === 'unknown') {
    warnings.push(`unrecognised Type: ${typeRaw}`);
  }

  const rawStatus = field(markdown, 'Status') ?? '';
  if (rawStatus.length === 0) warnings.push('no Status field');

  const blockedRaw = field(markdown, 'Blocked by') ?? '';
  const { ids: blockedBy, malformed } = parseBlockedBy(blockedRaw);
  if (malformed && blockedRaw.length > 0) {
    warnings.push(`Blocked by not understood: ${blockedRaw}`);
  }
  if (blockedRaw.length === 0) warnings.push('no Blocked by line');

  const secs = sections(markdown);
  const question = secs.get('question');
  const answer = secs.get('answer');
  if (question === undefined && answer === undefined) {
    warnings.push('neither a Question nor an Answer section');
  }

  // A heading that disagrees with the filename is worth saying out loud.
  const numbered = /^(\d{1,3})\s*:/.exec(title);
  if (numbered && numbered[1]!.padStart(2, '0') !== id) {
    warnings.push(`heading says ${numbered[1]} but the filename says ${id}`);
  }

  return {
    id,
    slug,
    title: title.replace(/^\d{1,3}\s*:\s*/, '') || slug,
    type,
    rawStatus,
    blockedByRaw: blockedRaw,
    blockedBy,
    ...(question === undefined ? {} : { question }),
    ...(answer === undefined ? {} : { answer }),
    warnings,
  };
}

export interface ParsedMap {
  readonly title: string;
  readonly destination: string;
  readonly cleared: boolean;
  readonly notes: readonly string[];
  readonly decisionsSoFar: readonly MapDecision[];
  readonly notYetSpecified: readonly string[];
  readonly outOfScope: readonly string[];
  readonly hasHandoff: boolean;
}

/** A `## Decisions so far` entry: `- [Title](ref): gist`. */
function parseDecisionEntry(line: string): MapDecision | null {
  const m = /^\[(.*?)\]\(([^)]+)\)\s*:?\s*(.*)$/.exec(line.trim());
  if (!m) return null;
  return {
    title: m[1]!.trim(),
    ref: m[2]!.trim(),
    gist: m[3]!.trim(),
  };
}

export function parseMap(markdown: string): ParsedMap {
  const title = docTitle(markdown);
  const secs = sections(markdown);

  const destinationRaw = secs.get('destination') ?? '';
  // A destination is often stated as a blockquote after a one-line verdict.
  const quoted = destinationRaw
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('>'))
    .map((l) => l.replace(/^\s*>\s?/, '').trim())
    .join(' ')
    .trim();
  const destination = quoted.length > 0 ? quoted : destinationRaw.trim();

  const decisionsSoFar = bullets(secs.get('decisions so far') ?? '')
    .map(parseDecisionEntry)
    .filter((d): d is MapDecision => d !== null);

  return {
    title,
    destination,
    // Two independent signals, either sufficient: the title says so, or the map
    // carries a Handoff section, which is what charting produces when the way is
    // clear.
    cleared: /\bcleared\b/i.test(title) || secs.has('handoff'),
    notes: bullets(secs.get('notes') ?? ''),
    decisionsSoFar,
    notYetSpecified: bullets(secs.get('not yet specified') ?? ''),
    outOfScope: bullets(secs.get('out of scope') ?? ''),
    hasHandoff: secs.has('handoff'),
  };
}

/** Does the feature directory look like a map or a build? A `map.md` decides it. */
export function inferKind(hasMapFile: boolean): FeatureKind {
  return hasMapFile ? 'map' : 'build';
}

/**
 * Count glossary terms.
 *
 * Deliberately a heuristic with a low bar: the only question asked of it is
 * "has sharpening left a paper trail at all", so it counts heading-style and
 * bullet-style entries and makes no attempt to be exact. Documented as a
 * heuristic rather than a measurement, because the number is shown in the UI.
 */
export function countGlossaryTerms(markdown: string): number {
  let n = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{2,4}\s+\S/.test(line)) n++;
    else if (/^\s*[-*]\s+\S/.test(line)) n++;
    else if (/^\s*\|\s*[^|\s]/.test(line)) n++;
  }
  return n;
}

/** Sorted ticket ids as the corpus numbers them: `01`, `02`, … */
export function ticketIdFromFilename(filename: string): string | null {
  const m = /^(\d{1,3})-(.*)\.md$/i.exec(filename);
  if (!m) return null;
  return m[1]!.padStart(2, '0');
}

export function ticketSlugFromFilename(filename: string): string {
  const m = /^\d{1,3}-(.*)\.md$/i.exec(filename);
  return m ? m[1]! : filename.replace(/\.md$/i, '');
}
