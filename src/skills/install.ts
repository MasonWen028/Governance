import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { PackEntry, SkillSource } from './packs.js';

const run = promisify(execFile);

/**
 * Install the skill a slot asks for.
 *
 * Three rules, each of them bought with a mistake somebody else already made:
 *
 * 1. **Clone shallow, into a temporary directory.** The user's own repositories
 *    are not where a third-party skill belongs, and a full clone of a monorepo
 *    to copy 40 kB out of it is a download nobody agreed to.
 * 2. **Find the skill by name, not by path.** Repositories move `skills/x` to
 *    `plugins/y/skills/x`; a hard-coded path either breaks or, worse, resolves
 *    to a directory that exists and is not the skill. Requiring `SKILL.md` next
 *    to the expected name is the check that survives a reorganisation.
 * 3. **Never install over an existing directory.** The machine may already have
 *    a skill of that name that the user edited. Reported as `kept`, not
 *    overwritten — the same rule `addWorkspace` follows for the root list.
 *
 * Installing a whole pack adds a fourth: **one clone per repository, not per
 * slot.** A three-slot repository cloned three times is three times the wait for
 * the same bytes, and on a first run that is the difference the user actually
 * feels.
 */

/**
 * Everything installed under a skills root, keyed by directory name.
 *
 * `SKILL.md` is what makes a directory a skill: a directory without one is
 * something else that happens to live in the same place, and treating it as a
 * skill would put its README through the contract checker.
 */
export async function readInstalledSkills(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return out;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(() => null);
    if (raw !== null) out.set(entry.name, raw);
  }
  return out;
}

export interface InstallResult {
  readonly slot: string;
  readonly skill: string;
  readonly status: 'installed' | 'kept';
  readonly path: string;
  readonly repo: string;
}

/** One slot's outcome. A slot that could not be installed carries the sentence
 *  a human can act on, because "failed" on its own is not actionable. */
export type InstallOutcome =
  | { readonly entry: PackEntry; readonly result: InstallResult }
  | { readonly entry: PackEntry; readonly error: string };

/** Thrown with a sentence a human can act on. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/** A directory name that can be joined to a path without escaping it. */
function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/**
 * Locate `<name>/SKILL.md` inside a checkout.
 *
 * Breadth-first and bounded: the shallowest match wins, so a repository that
 * carries both `skills/x` and `examples/vendored/x` installs the former. Depth 5
 * is deeper than any layout in use and shallow enough that a pathological
 * checkout cannot walk for minutes.
 */
async function locateSkill(
  cloneDir: string,
  names: readonly string[],
  maxDepth = 5,
): Promise<{ id: string; dir: string } | null> {
  const wanted = names.filter(safeName);
  if (wanted.length === 0) return null;

  let frontier: string[] = [cloneDir];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of frontier) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (entries === null) continue;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (wanted.includes(entry.name)) {
          const present = await stat(join(full, 'SKILL.md')).catch(() => null);
          if (present !== null) return { id: entry.name, dir: full };
        }
        next.push(full);
      }
    }
    frontier = next;
  }
  return null;
}

/** Injected for tests: the clone that would otherwise reach the network. */
export type Clone = (url: string, dest: string) => Promise<void>;

const gitClone: Clone = async (url, dest) => {
  /* `execFile`, never a shell: the URL comes from a catalogue in this repository
   * rather than from a request, but the argv form is what keeps that true if it
   * ever stops being.
   *
   * `GIT_TERMINAL_PROMPT=0` is not tidiness. A headless clone of a repository
   * that needs credentials makes git open a prompt on a terminal that does not
   * exist, and the request then hangs until the timeout with nothing to show —
   * a settings page that never answers. Failing fast turns that into a message. */
  await run('git', ['clone', '--depth', '1', '--quiet', url, dest], {
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
  });
};

export interface InstallOptions {
  /** Injected for tests. */
  readonly clone?: Clone;
  /** Injected for tests: where the temporary checkout is made. */
  readonly tempRoot?: string;
  /** Injected for tests: does the destination already exist? */
  readonly exists?: (path: string) => Promise<boolean>;
}

function makeExists(options: InstallOptions): (path: string) => Promise<boolean> {
  return (
    options.exists ??
    (async (p: string): Promise<boolean> => (await stat(p).catch(() => null)) !== null)
  );
}

/**
 * The expected destination of a slot, if the machine already has it.
 *
 * Checked before the clone, not after. The expected directory name is known up
 * front, so "already there" costs one `stat` instead of a download — which is
 * what makes it safe to call an install on every launch of a machine that
 * already has everything. Without it, install-on-first-run would clone every
 * repository every time the app opened.
 */
async function alreadyThere(
  entry: PackEntry,
  source: SkillSource,
  skillsRoot: string,
  exists: (p: string) => Promise<boolean>,
): Promise<InstallResult | null> {
  for (const name of source.expect) {
    if (!safeName(name)) continue;
    const dest = resolve(skillsRoot, name);
    if (await exists(dest)) {
      return { slot: entry.slot, skill: name, status: 'kept', path: dest, repo: source.repo };
    }
  }
  return null;
}

const sourceOf = (entry: PackEntry): SkillSource => {
  if (entry.source === null) {
    throw new InstallError(entry.unresolved ?? `no verified source for ${entry.slot}`);
  }
  return entry.source;
};

/**
 * Copy one entry's skill out of an existing checkout.
 *
 * Returns null when the checkout does not contain the name the slot expects,
 * which the caller reports — installing the nearest-sounding directory instead
 * would be the same class of error as binding a skill to the wrong slot.
 */
async function copyFromCheckout(
  entry: PackEntry,
  source: SkillSource,
  checkout: string,
  skillsRoot: string,
  exists: (p: string) => Promise<boolean>,
): Promise<InstallResult | null> {
  const found = await locateSkill(checkout, source.expect);
  if (found === null) return null;

  const dest = resolve(skillsRoot, found.id);
  if (!dest.startsWith(resolve(skillsRoot))) {
    throw new InstallError(`refusing to write outside the skills root: ${dest}`);
  }
  if (await exists(dest)) {
    return { slot: entry.slot, skill: found.id, status: 'kept', path: dest, repo: source.repo };
  }
  await mkdir(skillsRoot, { recursive: true });
  await cp(found.dir, dest, { recursive: true });
  return { slot: entry.slot, skill: found.id, status: 'installed', path: dest, repo: source.repo };
}

/**
 * Install several slots, cloning each repository once.
 *
 * Outcomes come back in the order the entries were given, so a caller can pair
 * them up without matching on the slot string.
 */
export async function installAll(
  entries: readonly PackEntry[],
  skillsRoot: string,
  options: InstallOptions = {},
): Promise<InstallOutcome[]> {
  const clone = options.clone ?? gitClone;
  const exists = makeExists(options);

  const bySlot = new Map<string, InstallOutcome>();
  const byRepo = new Map<string, { source: SkillSource; entries: PackEntry[] }>();

  for (const entry of entries) {
    if (entry.source === null) {
      bySlot.set(entry.slot, { entry, error: entry.unresolved ?? 'no verified source' });
      continue;
    }
    /* Already present: no clone at all for this repository on account of this
     * slot. Recorded here so the checkout loop can skip it. */
    const there = await alreadyThere(entry, entry.source, skillsRoot, exists);
    if (there !== null) {
      bySlot.set(entry.slot, { entry, result: there });
      continue;
    }
    const group = byRepo.get(entry.source.repo) ?? { source: entry.source, entries: [] };
    group.entries.push(entry);
    byRepo.set(entry.source.repo, group);
  }

  for (const { source, entries: wanted } of byRepo.values()) {
    const scratch = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'gov-skill-'));
    try {
      const checkout = join(scratch, 'repo');
      try {
        await clone(`https://github.com/${source.repo}.git`, checkout);
      } catch (err) {
        for (const entry of wanted) {
          bySlot.set(entry.slot, {
            entry,
            error: `could not clone ${source.repo}: ${(err as Error).message}`,
          });
        }
        continue;
      }
      for (const entry of wanted) {
        try {
          const result = await copyFromCheckout(
            entry,
            sourceOf(entry),
            checkout,
            skillsRoot,
            exists,
          );
          bySlot.set(
            entry.slot,
            result === null
              ? {
                  entry,
                  error: `${source.repo} does not contain ${source.expect.join(' or ')} with a SKILL.md`,
                }
              : { entry, result },
          );
        } catch (err) {
          bySlot.set(entry.slot, { entry, error: (err as Error).message });
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return entries.flatMap((entry) => {
    const outcome = bySlot.get(entry.slot);
    return outcome === undefined ? [] : [outcome];
  });
}

/**
 * Install one slot's skill from its declared source.
 *
 * Returns `kept` rather than failing when the directory is already there. An
 * installer whose second run reports an error is an installer nobody runs twice,
 * and the second run is the normal case — the first one is often offline.
 */
export async function installSlot(
  entry: PackEntry,
  skillsRoot: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const [outcome] = await installAll([entry], skillsRoot, options);
  if (outcome === undefined) throw new InstallError(`nothing to install for ${entry.slot}`);
  if ('error' in outcome) throw new InstallError(outcome.error);
  return outcome.result;
}

/** Which slots in a pack can be installed at all, and which need a substitute. */
export function installable(entries: readonly PackEntry[]): {
  readonly installable: readonly string[];
  readonly unresolved: readonly string[];
} {
  const yes: string[] = [];
  const no: string[] = [];
  for (const e of entries) (e.source === null ? no : yes).push(e.slot);
  return { installable: yes, unresolved: no };
}
