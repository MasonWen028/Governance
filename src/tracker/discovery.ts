import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

/**
 * Bringing an existing codebase in as a project.
 *
 * An empty folder has nothing to explain, so it can go straight to being
 * grilled. A folder that already holds code has opinions the new owner does not
 * — and guessing at them is how a "modernisation" spends six months discovering
 * it moved the wrong thing. So the code is read first, in three passes.
 *
 * The three passes are the ones the human asked for, in this order:
 *
 *   Discovery → Architecture → Feature Mapping
 *
 * They are separate passes and not one big prompt, for a reason that is easy to
 * feel and hard to argue with: a single pass that answers all three at once
 * produces one document nobody can check. Three passes produce three artefacts
 * the human can read between them, and stop after any one.
 */

export type PhaseId = 'discovery' | 'architecture' | 'feature-mapping';

export interface DiscoveryPhase {
  readonly id: PhaseId;
  /** One line the interface shows, in the order the passes run. */
  readonly purpose: string;
  /**
   * What this pass is expected to leave behind, relative to the output root.
   *
   * "Expected", not "required": the skill is told not to write empty
   * placeholders, so a small system legitimately produces fewer files. These
   * names are what the interface looks for to show *what was actually read* —
   * and the display is built from the files that exist, never from this list.
   * Claiming a file was written because a pass was supposed to write it is
   * exactly the fiction this whole tool exists to avoid.
   */
  readonly expects: readonly string[];
}

/**
 * The three passes, and the DiUS output layout each one is asked for.
 *
 * The names are `codebase-discovery`'s own, not a shape invented here. The skill
 * writes `docs/business`, `docs/domain`, `docs/tech` and `docs/_discovery`
 * beneath whatever `--output` root it is given; forcing it into a flat
 * `PROJECT_OVERVIEW.md` list would mean editing a third-party skill to suit a
 * diagram, and the instruction was to extend it rather than rewrite it.
 *
 * These lists were a prediction until 2026-11-01, when a real run read
 * `H:\Projects\RecycleTechWebsite` (a Django site, 465 files) end to end and
 * produced every path named below, plus two audit files that had not been
 * predicted and are now listed where they actually appeared. What is written
 * here is therefore observed, not assumed — which is the only status worth
 * having for a list the prompt presents to an agent as fact.
 */
export const DISCOVERY_PHASES: readonly DiscoveryPhase[] = [
  {
    id: 'discovery',
    purpose: 'Read the code and name the domain, the rules and the glossary',
    expects: [
      'domain/domain-glossary.md',
      'domain/domain-model.md',
      'business/business-requirements.md',
      '_discovery/recon-manifest.md',
    ],
  },
  {
    id: 'architecture',
    purpose: 'Map the system: its areas, its shape, and what it talks to',
    expects: ['tech/current-architecture.md', 'tech/integrations.md'],
  },
  {
    id: 'feature-mapping',
    purpose: 'Turn what was found into named areas and the workflows between them',
    expects: [
      'business/user-personas.md',
      'areas',
      /* Not in the original prediction. Both landed in this pass on the real
       * run: the register of what could not be determined, and the index that
       * traces each claim back to the code it came from. */
      '_discovery/assumptions-register.md',
      '_discovery/traceability-index.md',
    ],
  },
];

export interface DiscoveryPromptContext {
  /** Absolute path of the repository being read. */
  readonly target: string;
  /**
   * Absolute path to the reading skill's `SKILL.md`.
   *
   * The skill is addressed as a file, the way every other stage in this tool
   * addresses one — not as `/codebase-discovery`, which is a convention of one
   * particular CLI. A name that the CLI in front of us does not implement means
   * the agent never opens the skill and improvises instead, and an improvised
   * analysis is the most expensive artefact in this toolchain, because it reads
   * like evidence. A path works whichever CLI is configured.
   */
  readonly skillPath: string;
  /** Where the skill should write, relative to `target`. */
  readonly outputRoot: string;
}

/**
 * The prompt for one pass.
 *
 * Two decisions are stated as *already made* rather than as flags. The skill
 * documents them as `--output <dir>` and `full|code-only` because it was written
 * for a host that passes arguments to a slash command; this tool hands the agent
 * a file path instead, and no configured CLI is obliged to implement that
 * convention. So they are written out as decisions the pass has already taken —
 * which the skill's own instructions accept ("these are a shorthand, not the
 * interface... extract from prose").
 *
 * Both are settled up front for one reason: these passes run unattended, and an
 * agent that stops to ask which output root to use, or enters the interview
 * phase, will wait for an answer nobody is there to give.
 */
export function phasePrompt(phase: DiscoveryPhase, ctx: DiscoveryPromptContext): string {
  const expects =
    phase.expects.length === 0
      ? ''
      : `\nUnder ${ctx.outputRoot}/, this pass is expected to produce:\n` +
        phase.expects.map((f) => `- ${f}`).join('\n') +
        '\n\nOnly write a file that has real content. Do not create empty placeholders.';

  return [
    `Read the skill at ${ctx.skillPath} and follow it.`,
    `Work in ${ctx.target}.`,
    '',
    `This pass is **${phase.id}**: ${phase.purpose}.`,
    '',
    'Two choices are already made, so do not stop to ask about them:',
    `- the output root is ${ctx.outputRoot}, beneath ${ctx.target};`,
    '- the mode is code-only, so the interview phase is not entered.',
    '',
    'Work only inside the target directory. Do not move, delete or rewrite any',
    'source file — this pass reads the code; it does not change it.',
    expects,
    '',
    'Report what you found and which files you wrote, and say plainly what you',
    'could not determine. An honest gap is worth more here than a guess, because',
    'the next pass builds on this one.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What the passes have actually written, read off the disk.
 *
 * This walks the output root rather than checking the `expects` lists, and that
 * is a deliberate refusal to bet on a guess. Those lists say what a pass is
 * *asked* for; they cannot say what a third-party skill nested where, and a
 * display built from the request would either claim files that were never
 * written or — worse, because it looks like nothing happened — hide the ones
 * that landed somewhere slightly else.
 *
 * So: whatever markdown is under the output root is what gets shown. After a
 * real run the layout is visible, and then the `expects` lists can be corrected
 * to match fact instead of assumption.
 *
 * Capped, because a large system produces a lot of `areas/`, and a display that
 * grows without limit stops being a summary.
 */
export async function producedFiles(
  target: string,
  outputRoot: string,
  limit = 60,
): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (out.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;
    for (const entry of entries) {
      if (out.length >= limit) return;
      /* A link is not something this pass wrote. Keeping it out of the recursion
       * is `withFileTypes`' job, not this line's — what this line decides is the
       * link *named* `*.md`, which would otherwise be reported at a path inside
       * the project while its bytes live somewhere else. */
      if (entry.isSymbolicLink()) continue;
      const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }
      if (!/\.md$/i.test(entry.name)) continue;
      const info = await stat(abs).catch(() => null);
      if (info === null) continue;
      out.push({ path: `${outputRoot}/${childRel}`, bytes: info.size });
    }
  };
  await walk(join(target, outputRoot), '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
