import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The workspace list.
 *
 * Declared, not discovered, for the top-level roots — a scan for candidate
 * repositories is a convenience, not an authority, and a wrong guess that
 * silently reads the wrong tree is worse than an explicit list. The list lives
 * beside the tool rather than in a database so it can be edited by hand and
 * diffed.
 */

export const WORKSPACES_FILE = 'governance.workspaces.json';

export interface Workspaces {
  /** Repository roots to read. */
  readonly roots: readonly string[];
  /** Where this list was found, or `null` when nothing was found. */
  readonly source: string | null;
}

interface RawWorkspaces {
  readonly roots?: unknown;
}

function parse(raw: string, source: string): Workspaces {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  const obj = data as RawWorkspaces;
  if (!Array.isArray(obj.roots)) {
    throw new Error(`${source} must have a "roots" array`);
  }
  const roots = obj.roots
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) => resolve(dirname(source), r));
  return { roots, source };
}

/** Look for the workspace list beside the tool, then in the working directory. */
export async function loadWorkspaces(
  startDir: string = process.cwd(),
): Promise<Workspaces> {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/src -> package root is two levels up.
  const candidates = [
    resolve(here, '..', '..', WORKSPACES_FILE),
    resolve(startDir, WORKSPACES_FILE),
  ];

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      return parse(raw, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return { roots: [], source: null };
}

/** Where a list would be created when none exists yet. */
export function defaultWorkspacesFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', WORKSPACES_FILE);
}

export interface AddWorkspaceResult {
  /** The file that now holds the list. */
  readonly file: string;
  readonly roots: readonly string[];
  /** False when the root was already listed. */
  readonly added: boolean;
}

/**
 * Add one root to the list.
 *
 * Three rules, all of them the same rule the scaffolder follows:
 *
 * 1. **A file that cannot be parsed is never overwritten.** It is hand-editable
 *    by design, so a syntax error is the human's work, not a blank slate — and
 *    replacing it would silently drop every other root in it.
 * 2. **Unknown top-level keys survive.** This file is not a private database;
 *    a key the tool does not read today is still someone's note.
 * 3. **Paths are written absolute.** Entries may be relative on the way in, but
 *    what the tool writes is unambiguous, so the list cannot change meaning if
 *    the file is moved.
 */
export async function addWorkspace(
  root: string,
  file?: string,
): Promise<AddWorkspaceResult> {
  const target = file ?? (await loadWorkspaces()).source ?? defaultWorkspacesFile();
  const candidate = resolve(root);

  let base: Record<string, unknown> = { roots: [] };
  let existing: string[] = [];
  try {
    const raw = await readFile(target, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the file does not hold a JSON object');
    }
    base = parsed as Record<string, unknown>;
    if (!Array.isArray(base['roots'])) {
      throw new Error('it has no "roots" array');
    }
    existing = (base['roots'] as unknown[])
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => resolve(dirname(target), r));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`${target} cannot be updated: ${(err as Error).message}`);
    }
  }

  if (existing.includes(candidate)) {
    return { file: target, roots: existing, added: false };
  }

  const roots = [...existing, candidate];
  const body = JSON.stringify({ ...base, roots }, null, 2) + '\n';
  // Written beside the target and renamed, so a crash mid-write leaves the old
  // list intact rather than a truncated one.
  const temp = `${target}.tmp`;
  await writeFile(temp, body, 'utf8');
  await rename(temp, target);
  return { file: target, roots, added: true };
}
