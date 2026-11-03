import { access, readFile } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/**
 * Finding the agent CLI, and getting it to actually start.
 *
 * This exists because `spawn('claude', args)` fails with ENOENT on Windows even
 * when `claude` is installed and on PATH. npm installs three shims — `claude`,
 * `claude.cmd`, `claude.ps1` — and the one that works is `claude.cmd`, a batch
 * file. Node's `spawn` with `shell: false` cannot start a `.cmd`: CreateProcess
 * needs a real executable, and a batch file needs `cmd.exe` in front of it.
 *
 * The obvious fixes are both wrong:
 *
 * - `shell: true` puts the arguments through `cmd.exe` parsing, and one of the
 *   arguments is the prompt, which contains the human's own text — quotes,
 *   newlines, `%`, `&`. That is a quoting hazard and an injection surface for
 *   no benefit.
 * - Hardcoding a path to the Anthropic package makes the tool depend on one
 *   vendor's install layout.
 *
 * So instead: resolve the shim, read the JavaScript entry it points at, and run
 * that with `node` directly. Arguments then travel as an array, never as shell
 * text, and nothing in the prompt can be interpreted as syntax.
 */

/**
 * What Windows will try, in the order the OS itself prefers.
 *
 * The order is not cosmetic: a `.exe` should win over a `.cmd` when both exist.
 */
const WINDOWS_EXT = ['.exe', '.cmd', '.bat'] as const;

export interface ResolvedCli {
  /** The executable to spawn. */
  readonly command: string;
  /** Arguments that must come before the caller's own. */
  readonly args: readonly string[];
  /** How this was resolved, in words. The probe reports it verbatim. */
  readonly how: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a command on PATH.
 *
 * @param exts extensions to try when the name has none. Windows only; on POSIX
 *             an empty list means "the name is the file name".
 */
export async function findOnPath(
  name: string,
  pathValue: string,
  exts: readonly string[] = [],
  separator = delimiter,
  existsFn: (path: string) => Promise<boolean> = exists,
): Promise<string | null> {
  if (pathValue.trim().length === 0) return null;
  const dirs = pathValue.split(separator).filter((d) => d.trim().length > 0);
  const hasExt = extname(name).length > 0;

  const candidates: string[] = [];
  for (const dir of dirs) {
    const base = dir.trim();
    if (hasExt) {
      candidates.push(join(base, name));
    } else if (exts.length > 0) {
      // Extensions first, and the bare name never.
      //
      // npm puts three shims in one directory: `claude` — a shell script with no
      // extension — plus a `.cmd` and a scripting-language variant. On Windows
      // the extension-less one is not executable at all. Trying it first produced
      // a command that *resolves* and then fails to start, which is worse than
      // not finding it: the reason is invisible and the CLI looks broken for no
      // stated cause.
      for (const ext of exts) candidates.push(join(base, name + ext));
    } else {
      candidates.push(join(base, name));
    }
  }
  for (const c of candidates) {
    if (await existsFn(c)) return c;
  }
  return null;
}

/**
 * The JavaScript entry an npm shim points at.
 *
 * npm generates these shims from a template, so both the batch variant and the
 * POSIX variant name the real entry on one line. Reading it is more durable than
 * guessing a package path, and when the shape is unfamiliar this returns null
 * rather than a wrong answer.
 *
 * Seen in the wild, after backslashes are normalised:
 *
 *     "%_prog%"  "%dp0%/node_modules/@anthropic-ai/claude-code/cli.js" %*
 *     exec "$basedir/node" "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"
 *
 * Both spell the directory *of the shim itself* as a token — `%dp0%` or
 * `$basedir` — rather than as a real path. That token is stripped here and the
 * remainder is returned relative, for the caller to resolve against the shim's
 * own directory. Leaving it in produced a path like
 * `...\npm\%dp0%\node_modules\...`, which is not a file and not a diagnostic.
 */
export function entryFromShim(shimText: string): string | null {
  const normalized = shimText.replace(/\\/g, '/');
  const matches = [...normalized.matchAll(/["']?([^"'\s]*node_modules\/[^"'\s]+\.(?:js|mjs|cjs))["']?/g)]
    .map((m) => m[1]!)
    .filter((p) => p.length > 0);
  if (matches.length === 0) return null;

  // Prefer the most specific path; some shims reference a nested one first.
  const best = matches.sort((a, b) => b.length - a.length)[0]!;
  return best
    .replace(/^%dp0%\/?/i, '')
    .replace(/^\$\{?basedir\}?\/?/i, '')
    .replace(/^\.\//, '');
}

/** Is this something we can hand to `node` directly? */
function isScript(path: string): boolean {
  return ['.js', '.mjs', '.cjs'].includes(extname(path).toLowerCase());
}

export interface ResolveOptions {
  /** Defaults to the running platform. Injected so both branches are testable. */
  readonly platform?: NodeJS.Platform;
  readonly pathValue?: string;
  /** Injected so a test can supply a shim without writing to the real PATH. */
  readonly readShim?: (path: string) => Promise<string | null>;
  readonly existsFn?: (path: string) => Promise<boolean>;
  /** npm's shims live beside `node_modules`. */
  readonly nodeExecutable?: string;
}

/**
 * Work out how to start the configured CLI.
 *
 * Never throws and never returns a command it cannot justify: when nothing
 * resolves, it returns the name as given and says so, so the caller can report
 * exactly what was tried.
 */
export async function resolveCli(
  cli: string,
  options: ResolveOptions = {},
): Promise<ResolvedCli> {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env['PATH'] ?? '';
  const node = options.nodeExecutable ?? process.execPath;
  const readShim =
    options.readShim ??
    (async (p: string) => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    });

  // An explicit script path needs no resolution.
  if (isScript(cli)) {
    return { command: node, args: [cli], how: 'ran the JavaScript entry directly' };
  }

  // An explicit path to a batch file still has to be opened like a shim.
  const explicit = isAbsolute(cli) ? cli : null;
  const found =
    explicit ??
    (await findOnPath(
      cli,
      pathValue,
      platform === 'win32' ? WINDOWS_EXT : [],
      delimiter,
      options.existsFn ?? exists,
    ));

  if (found === null) {
    return {
      command: cli,
      args: [],
      how: pathValue.trim().length === 0
        ? 'PATH was empty, so the command could not be located'
        : 'not found on PATH; trying it as given',
    };
  }

  const ext = extname(found).toLowerCase();

  if (isScript(found)) {
    return { command: node, args: [found], how: 'ran the JavaScript entry directly' };
  }

  if (ext === '.cmd' || ext === '.bat' || (platform !== 'win32' && ext === '')) {
    // Read the shim and follow it to the script. This is the Windows case, and
    // the POSIX case where the shim is a shell script naming a .js entry.
    const text = await readShim(found);
    if (text !== null) {
      const entry = entryFromShim(text);
      if (entry !== null) {
        // Resolve the entry relative to the shim, exactly as the shim does.
        const dir = found.replace(/[\\/][^\\/]*$/, '');
        const abs = isAbsolute(entry) ? entry : join(dir, entry);
        const existsFn = options.existsFn ?? exists;
        if (await existsFn(abs)) {
          return {
            command: node,
            args: [abs],
            how: `followed ${found.split(/[\\/]/).pop()} to its JavaScript entry`,
          };
        }
        return {
          command: found,
          args: [],
          how: `found ${found}, but the entry it names is missing: ${abs}`,
        };
      }
    }
    return {
      command: found,
      args: [],
      how: `found ${found}; it is a batch file and its entry could not be read`,
    };
  }

  // A real executable.
  return { command: found, args: [], how: `found ${found}` };
}
