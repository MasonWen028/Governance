import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { appendEvent } from './journal.js';
import { followUpSlug } from './triage.js';
import type { ChangeVerdict } from './triage.js';

/**
 * Deriving a follow-up feature from a change request.
 *
 * The parent feature is frozen the moment this runs: its journal gains
 * `change.followed-up` with the pointer, and it never carries the new work. What
 * the child gets is a directory, one journal line saying where it came from, and
 * an `INHERITED.md` naming the parent's artifacts as **inputs**.
 *
 * Why an instruction file and not a copy: a copy starts correct and rots the
 * first time the parent is amended; a pointer cannot. The child's agent is told
 * to read the parent, not handed a snapshot of it.
 *
 * What is deliberately not created: a spec, a map, tickets. Those are the flow's
 * output, and pre-filling them would be this module deciding what the change
 * means. The child starts at intake with nothing but a reason.
 */

export interface DerivedFeature {
  readonly slug: string;
  readonly dir: string;
}

export interface DeriveInput {
  /** The workspace root — the child is a sibling of the parent, not a child dir. */
  readonly root: string;
  readonly parentSlug: string;
  readonly parentDir: string;
  readonly change: { readonly id: string; readonly text: string };
  readonly verdict: ChangeVerdict;
  readonly now?: () => Date;
}

/**
 * An unused slug for a derived feature.
 *
 * Deterministic first (`<parent>-<chid>`), then `-2`, `-3`, … A change is filed
 * once, so a collision means a previous attempt half-ran and left a directory:
 * taking the number rather than reusing the directory keeps whatever is in there
 * intact and makes the oddity visible in the name.
 *
 * Exported because a feature can also be derived from a discovered area, and
 * two allocators would be two places for a collision to be missed.
 */
export async function freeSlug(root: string, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const exists = await stat(join(root, '.scratch', slug)).then(
      () => true,
      () => false,
    );
    if (!exists) return slug;
  }
  throw new Error(`no free slug for ${base}: 99 derived features already exist`);
}

function inheritedFile(input: DeriveInput): string {
  const parent = input.parentSlug;
  const filed = (input.now?.() ?? new Date()).toISOString().slice(0, 10);
  return `# Inherited from \`${parent}\`

This feature exists because of a change request filed against \`${parent}\` on
${filed}. It is **not** a continuation of that feature's record: it is a new
feature, and it produces its own spec, its own tickets, its own branch and its
own pull request.

## The change, in the human's own words

> ${input.change.text.trim().replace(/\n+/g, '\n> ')}

Filed as \`${parent}@${input.change.id}\`. The system routed it here:
${input.verdict.why}.

## What to read first — and what not to touch

\`${parent}/\` is an **input**, not this feature's record:

- \`${parent}/spec.md\` — what the released thing is
- \`${parent}/GLOSSARY.md\` — the words it uses
- \`${parent}/docs/adr/\` — the decisions it stands on
- \`${parent}/issues/\` — what it built

Do not write anything under \`${parent}/\`. If the change contradicts a decision
recorded there, say so: superseding a decision is a decision of its own, and it
belongs in this feature's ADRs — not in an edit to the old one.
`;
}

/**
 * Create the child feature and return where it is.
 *
 * Two writes, in this order: the journal line first (so a directory is never
 * left without a record of why it exists), then the inherited brief. The caller
 * appends `change.followed-up` to the parent afterwards — the pointer is written
 * last, so it can never point at a directory that was not finished.
 */
export async function deriveFeature(input: DeriveInput): Promise<DerivedFeature> {
  const root = resolve(input.root);
  const base = followUpSlug(input.parentSlug, input.change.id);
  const slug = await freeSlug(root, base);
  const dir = join(root, '.scratch', slug);

  await appendEvent(dir, {
    kind: 'feature.derived',
    ref: input.parentSlug,
    detail: `${input.change.id}: ${input.verdict.kind} → ${input.verdict.path}`,
    data: {
      parent: input.parentSlug,
      change: input.change.id,
      text: input.change.text,
      verdict: input.verdict,
    },
  });
  await writeFile(join(dir, 'INHERITED.md'), inheritedFile(input), 'utf8');

  return { slug, dir };
}
