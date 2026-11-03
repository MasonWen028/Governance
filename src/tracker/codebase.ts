import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Reading a codebase that is already there.
 *
 * The point of this module is to make "load an existing repository" a *read*
 * first: before any agent is asked to understand the code, the tool states what
 * it can see for itself — which markers exist, what languages the files are in,
 * which branch is checked out, whether the tree is dirty, which files are the
 * docs and the tests.
 *
 * Everything here is bounded and refuses to guess. A walk that hits its ceiling
 * says so instead of reporting a smaller repository as if it were the whole
 * one; a git command that fails returns nothing instead of an empty branch.
 * Counts are files seen, never files that "should" be there.
 */

/** Directories that are never source: dependencies, build output, VCS, caches. */
const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'coverage',
  'venv',
  '__pycache__',
  'site-packages',
  'packages-cache',
  'tmp',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.venv',
  '.idea',
  '.vs',
  '.vscode',
  /* This tool's own area. A feature's prose is not the project's source. */
  '.scratch',
]);

/** File extension → the language a reader would name it by. */
const LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.cs': 'C#',
  '.fs': 'F#',
  '.vb': 'Visual Basic',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.hpp': 'C++',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.lua': 'Lua',
  '.scala': 'Scala',
  '.ex': 'Elixir',
  '.dart': 'Dart',
};

/** How deep and how wide the walk is allowed to go before it says "truncated". */
const MAX_VISITED = 20_000;
const MAX_DEPTH = 8;

/** Marker files at the repository root, in the order they are reported.
 *  Patterns rather than names: real repositories carry `requirements-test.txt`
 *  and `requirements-mcp.txt` as often as the plain one, and a literal list
 *  reported "no stack" for a Python repository that had two. */
const MARKERS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /^package\.json$/, label: 'Node' },
  { pattern: /^tsconfig\.json$/, label: 'TypeScript' },
  { pattern: /^pnpm-lock\.yaml$/, label: 'pnpm' },
  { pattern: /^yarn\.lock$/, label: 'Yarn' },
  { pattern: /^package-lock\.json$/, label: 'npm' },
  { pattern: /^go\.mod$/, label: 'Go modules' },
  { pattern: /^Cargo\.toml$/, label: 'Cargo' },
  { pattern: /^pyproject\.toml$/, label: 'Python (pyproject)' },
  { pattern: /^requirements.*\.txt$/, label: 'Python (pip)' },
  { pattern: /^setup\.py$/, label: 'Python (setuptools)' },
  { pattern: /^Gemfile$/, label: 'Ruby bundler' },
  { pattern: /^composer\.json$/, label: 'PHP composer' },
  { pattern: /^pom\.xml$/, label: 'Maven' },
  { pattern: /^build\.gradle$/, label: 'Gradle' },
  { pattern: /^Dockerfile$/, label: 'Docker' },
  { pattern: /^docker-compose\.ya?ml$/, label: 'Docker Compose' },
  { pattern: /^compose\.ya?ml$/, label: 'Docker Compose' },
  { pattern: /^Makefile$/, label: 'Make' },
  { pattern: /^\.pre-commit-config\.yaml$/, label: 'pre-commit' },
];

/** Documentation worth naming, in the order a reader wants them. */
const DOC_FILES = [
  'README.md',
  'README',
  'readme.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'HANDOVER.md',
  'CHANGELOG.md',
  'GLOSSARY.md',
  'LICENSE',
];

/** Directories whose mere existence means "the tests live here". */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e', 'testing']);

/** File names that are test configuration rather than a test. */
const TEST_CONFIG = /^(jest|vitest|playwright|cypress|karma|ava|mocha)\.config\.[cm]?[jt]s$|^pytest\.ini$|^phpunit\.xml$/;

/** A file that is itself a test, in the conventions this machine's projects use.
 *  The first version only knew `*.test.ts`, so a Python repository with forty
 *  `test_*.py` files was reported as having no tests at all — a false statement
 *  about absence, which is the worst kind for a reader to make. */
const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^test_.*\.py$)|(_test\.py$)|(_test\.go$)|(Tests?\.(cs|java|kt|php)$)/;

export interface StackHit {
  /** The file or directory that caused this label. */
  readonly marker: string;
  readonly label: string;
}

export interface LanguageCount {
  readonly language: string;
  readonly files: number;
}

export interface DirCount {
  readonly name: string;
  readonly files: number;
}

export interface CodebaseBrief {
  readonly path: string;
  readonly name: string;
  /** Files counted by the walk. Zero is possible for an empty repository. */
  readonly files: number;
  /** The walk hit its ceiling: the counts are a floor, not the total. */
  readonly truncated: boolean;
  readonly stack: readonly StackHit[];
  readonly languages: readonly LanguageCount[];
  readonly dirs: readonly DirCount[];
  readonly docs: readonly string[];
  readonly tests: readonly string[];
  readonly ci: readonly string[];
  /** First paragraph of the README, capped. `null` when there is no README. */
  readonly readme: string | null;
  readonly git: GitFacts | null;
  /** Everything that surprised the reader, said plainly. */
  readonly notes: readonly string[];
}

export interface GitFacts {
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly remote: string | null;
  readonly lastCommit: string | null;
}

async function isDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() === true;
}

async function readGit(root: string): Promise<GitFacts | null> {
  const run = async (args: readonly string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return null;
  const head = await run(['rev-parse', '--short', 'HEAD']);
  const status = await run(['status', '--porcelain']);
  const remote = await run(['config', '--get', 'remote.origin.url']);
  const when = await run(['log', '-1', '--format=%cs']);
  return {
    branch,
    head: head ?? '',
    dirty: (status ?? '').length > 0,
    remote: remote === null || remote.length === 0 ? null : remote,
    lastCommit: when === null || when.length === 0 ? null : when,
  };
}

/**
 * The first paragraph of prose in a README.
 *
 * Not the first line: a README wraps at 80 columns, so a first line is half a
 * sentence. Markdown furniture — headings, badges, tables, fences — is skipped
 * because it is structure, not a description of the repository.
 */
export function readmeParagraph(raw: string, cap = 400): string | null {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const furniture =
      trimmed.length === 0 ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('---') ||
      trimmed.startsWith('===') ||
      /^\[!\[/.test(trimmed) ||
      /^!\[/.test(trimmed) ||
      /^<[^>]+>$/.test(trimmed);
    if (!started) {
      if (furniture) continue;
      started = true;
      out.push(trimmed);
      continue;
    }
    if (trimmed.length === 0) break;
    if (trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('|')) break;
    out.push(trimmed);
  }
  if (out.length === 0) return null;
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length > cap ? `${text.slice(0, cap - 1).trimEnd()}…` : text;
}

interface Walk {
  files: number;
  truncated: boolean;
  byExt: Map<string, number>;
  byTop: Map<string, number>;
  dirs: Set<string>;
  testHits: Set<string>;
  ciHits: Set<string>;
  /** A `docs/adr/` directory exists. Documentation, not CI. */
  adr: boolean;
}

async function walk(root: string): Promise<Walk> {
  const acc: Walk = {
    files: 0,
    truncated: false,
    byExt: new Map(),
    byTop: new Map(),
    dirs: new Set(),
    testHits: new Set(),
    ciHits: new Set(),
    adr: false,
  };
  let visited = 0;
  const queue: { dir: string; depth: number; top: string | null }[] = [
    { dir: root, depth: 0, top: null },
  ];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) continue;
    for (const entry of entries) {
      if (++visited > MAX_VISITED) {
        acc.truncated = true;
        return acc;
      }
      const name = entry.name;
      const full = join(next.dir, name);
      const top = next.top ?? (entry.isDirectory() ? name : null);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (next.depth + 1 > MAX_DEPTH) {
          acc.truncated = true;
          continue;
        }
        acc.dirs.add(name);
        if (TEST_DIRS.has(name.toLowerCase())) acc.testHits.add(`${name}/`);
        if (next.depth === 0) {
          if (name === '.github') {
            const ci = await readdir(join(full, 'workflows')).catch(() => null);
            for (const w of ci ?? []) if (/\.ya?ml$/.test(w)) acc.ciHits.add(w);
          }
          /* `docs/adr/` is documentation, not continuous integration. Filing it
           * under CI said something false about a repository that has no
           * pipelines at all. */
          if (name === 'docs') {
            const inside = await readdir(full).catch(() => null);
            if ((inside ?? []).includes('adr')) acc.adr = true;
          }
        }
        queue.push({ dir: full, depth: next.depth + 1, top });
        continue;
      }
      if (!entry.isFile()) continue;
      acc.files += 1;
      if (top !== null) acc.byTop.set(top, (acc.byTop.get(top) ?? 0) + 1);
      const ext = extname(name).toLowerCase();
      if (ext in LANGUAGES) acc.byExt.set(ext, (acc.byExt.get(ext) ?? 0) + 1);
      if (TEST_CONFIG.test(name)) acc.testHits.add(name);
      if (TEST_FILE.test(name) && acc.testHits.size < 12) acc.testHits.add(name);
    }
  }
  return acc;
}

function noteOf(brief: Omit<CodebaseBrief, 'notes'>, walk: Walk, name: string): string[] {
  const notes: string[] = [];
  if (brief.files === 0) {
    notes.push('no source files were found — the directory is empty, or everything in it is dependency output');
  }
  if (brief.truncated) {
    notes.push(`the walk stopped at ${MAX_VISITED} entries; the counts below are a floor, not the total`);
  }
  if (brief.git === null) {
    notes.push('no git repository here (or git is not installed), so there is no branch to report');
  }
  if (brief.languages.length === 0 && brief.files > 0) {
    notes.push('files were found, but none in a language this reader recognises');
  }
  if (walk.testHits.size === 0) notes.push('no test directory or test file was found');
  if (name.length === 0) notes.push('the directory has no name');
  return notes;
}

/** Read a directory as a codebase. Returns `null` when it is not a directory. */
export async function inspectCodebase(target: string): Promise<CodebaseBrief | null> {
  const root = resolve(target);
  if (!(await isDir(root))) return null;

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((e) => e.name));

  const stack: StackHit[] = [];
  for (const m of MARKERS) {
    const hit = [...names].find((n) => m.pattern.test(n));
    // One line per label: `requirements-mcp.txt` and `requirements-test.txt` are
    // both pip, and listing pip twice says less than listing it once.
    if (hit !== undefined && !stack.some((s) => s.label === m.label)) {
      stack.push({ marker: hit, label: m.label });
    }
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (/\.(csproj|sln|fsproj|vbproj)$/i.test(e.name)) {
      stack.push({ marker: e.name, label: '.NET project' });
      break;
    }
  }

  const docs = DOC_FILES.filter((f) => names.has(f));
  if (names.has('docs')) docs.push('docs/');

  const walkResult = await walk(root);
  if (walkResult.adr) docs.push('docs/adr/');
  const languages: LanguageCount[] = [...walkResult.byExt.entries()]
    .map(([ext, files]) => ({ language: LANGUAGES[ext] ?? ext, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8);
  const dirs: DirCount[] = [...walkResult.byTop.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8);

  const readmeName = ['README.md', 'README', 'readme.md'].find((f) => names.has(f));
  const readme =
    readmeName === undefined
      ? null
      : await readFile(join(root, readmeName), 'utf8')
          .then((raw) => readmeParagraph(raw))
          .catch(() => null);

  const git = await readGit(root);
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

  const base: Omit<CodebaseBrief, 'notes'> = {
    path: root,
    name,
    files: walkResult.files,
    truncated: walkResult.truncated,
    stack,
    languages,
    dirs,
    docs,
    tests: [...walkResult.testHits].sort().slice(0, 8),
    ci: [...walkResult.ciHits].sort().slice(0, 8),
    readme,
    git,
  };
  return { ...base, notes: noteOf(base, walkResult, name) };
}

/* ---- which skill reads a codebase ---- */

export interface ReaderSkill {
  readonly id: string;
  readonly description: string;
  /** Higher is a better fit. Zero means "installed, but says nothing about code". */
  readonly score: number;
  /** Why it was picked or skipped, in words the interface can show. */
  readonly reason: string;
}

/**
 * Words that mean "this skill reads code". Scored rather than matched so a
 * general-purpose research skill can still win when it is the only reader on
 * the machine — an empty answer here is worse than a documented guess, because
 * the human can always override a listed candidate and cannot override silence.
 *
 * The weights encode one judgement: a skill whose job is to *understand* beats
 * one whose job is to *change*. `/improve-codebase-architecture` names the
 * codebase in its description and still ranks below `/research`, because the
 * first thing a repository needs is a reader, not a refactor.
 */
const READER_HINTS: readonly { readonly pattern: RegExp; readonly weight: number; readonly why: string }[] = [
  { pattern: /\bcodebase\b/i, weight: 4, why: 'its description names the codebase' },
  { pattern: /\brepository\b|\brepo\b/i, weight: 3, why: 'its description names the repository' },
  { pattern: /\barchitecture\b/i, weight: 1, why: 'it works on architecture' },
  { pattern: /\bdomain model\b|\bglossary\b/i, weight: 1, why: 'it builds the domain model' },
  { pattern: /\bresearch\b|\binvestigate\b|\bfindings\b/i, weight: 3, why: 'it investigates and writes down what it found' },
  { pattern: /\bread\b|\bunderstand\b|\bsurvey\b|\bdocument\b/i, weight: 2, why: 'its job is to read' },
  { pattern: /\bimprove\b|\brefactor\b|\bmigrate\b|\bredesign\b/i, weight: -2, why: 'it changes code rather than reading it' },
  { pattern: /\bimplement\b|\bwrite code\b/i, weight: -3, why: 'it writes code rather than reading it' },
];

function frontmatter(raw: string): { name: string | null; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const body = match?.[1] ?? '';
  const get = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(body);
    return line?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  };
  return { name: get('name'), description: get('description') ?? '' };
}

/**
 * Find skills installed on this machine that could read a codebase.
 *
 * Reads `<root>/<id>/SKILL.md`, so "installed" means the file is there — not
 * that a settings list mentions it. Sorted by score, then by id, so the list is
 * stable across runs.
 */
export async function readerSkills(skillsRoot: string): Promise<ReaderSkill[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const out: ReaderSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8').catch(() => null);
    if (raw === null) continue;
    const fm = frontmatter(raw);
    const text = `${fm.name ?? ''} ${fm.description}`;
    let score = 0;
    const why: string[] = [];
    for (const hint of READER_HINTS) {
      if (!hint.pattern.test(text)) continue;
      score += hint.weight;
      if (hint.weight > 0) why.push(hint.why);
    }
    out.push({
      id: entry.name,
      description: fm.description,
      score,
      reason:
        why.length === 0
          ? 'installed, but its description says nothing about reading code'
          : why.slice(0, 2).join('; '),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * The reader this framework uses when it is installed.
 *
 * Named rather than scored, on purpose. The heuristics below pick a plausible
 * reader on a machine that has none of the intended ones, but "plausible" is not
 * a default: `/intake-and-mapping` is the skill this project reads codebases
 * with, and a scorer that only *usually* chooses it would make the answer depend
 * on which other skills happen to be installed.
 *
 * It is still a *preference*, not a requirement. When it is absent the scorer
 * answers, because a machine with no reader at all is worse than a machine that
 * had to guess.
 */
export const DEFAULT_READER = 'intake-and-mapping';

/** The best reader on this machine, or `null` when nothing scored. */
export function pickReader(skills: readonly ReaderSkill[]): ReaderSkill | null {
  const preferred = skills.find((s) => s.id === DEFAULT_READER);
  if (preferred !== undefined) return preferred;
  const best = skills[0];
  if (best === undefined || best.score <= 0) return null;
  return best;
}

/**
 * The artifact written to `<root>/.scratch/CODEBASE.md`.
 *
 * Facts first, and every one of them is something this module read. The skill
 * is recorded as a decision with its reason, because the next reader of this
 * file — human or agent — needs to know who was asked to read the code, and
 * why that one.
 */
export function renderCodebaseDoc(brief: CodebaseBrief, pick: ReaderSkill | null): string {
  const list = (items: readonly string[]): string =>
    items.length === 0 ? '- (none found)' : items.map((i) => `- ${i}`).join('\n');
  const lines: string[] = [];
  lines.push(`# Codebase: ${brief.name}`);
  lines.push('');
  lines.push(`Read at ${brief.path}.`);
  lines.push('');
  lines.push('## What the files say');
  lines.push('');
  lines.push(`- files counted: ${brief.files}${brief.truncated ? ' (walk truncated — a floor)' : ''}`);
  lines.push(`- stack markers: ${brief.stack.length === 0 ? '(none at the root)' : brief.stack.map((s) => `${s.label} (${s.marker})`).join(', ')}`);
  lines.push(`- languages: ${brief.languages.length === 0 ? '(none recognised)' : brief.languages.map((l) => `${l.language} ${l.files}`).join(', ')}`);
  lines.push(`- docs: ${brief.docs.length === 0 ? '(none)' : brief.docs.join(', ')}`);
  lines.push(`- tests: ${brief.tests.length === 0 ? '(none found)' : brief.tests.join(', ')}`);
  lines.push(`- CI: ${brief.ci.length === 0 ? '(none found)' : brief.ci.join(', ')}`);
  if (brief.git !== null) {
    lines.push(
      `- git: ${brief.git.branch} @ ${brief.git.head}${brief.git.dirty ? ' (working tree dirty)' : ''}` +
        `${brief.git.remote === null ? '' : `, remote ${brief.git.remote}`}` +
        `${brief.git.lastCommit === null ? '' : `, last commit ${brief.git.lastCommit}`}`,
    );
  } else {
    lines.push('- git: none read');
  }
  lines.push('');
  if (brief.readme !== null) {
    lines.push('## What the README says');
    lines.push('');
    lines.push(brief.readme);
    lines.push('');
  }
  lines.push('## Reading plan');
  lines.push('');
  if (pick === null) {
    lines.push('No installed skill claims to read a codebase. Choose one by hand before');
    lines.push('the first intake run, rather than letting the default skill guess.');
  } else {
    lines.push(`Chosen skill: \`/${pick.id}\` — ${pick.reason}.`);
    lines.push('');
    lines.push(`It is installed at \`${pick.id}/SKILL.md\` under the skills root. Make it the`);
    lines.push('intake skill for this project, or override it per run.');
  }
  lines.push('');
  lines.push('## What is not here');
  lines.push('');
  lines.push(list(brief.notes));
  lines.push('');
  lines.push('This file records what a bounded file walk could see. It is not a design');
  lines.push('document, and it does not claim the code was understood.');
  lines.push('');
  return lines.join('\n');
}
