import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { classifyTurnFailure } from '../src/exec/agent.js';
import { entryFromShim, findOnPath, resolveCli } from '../src/exec/resolve.js';

/**
 * Finding the agent CLI.
 *
 * Every case here comes from a real install rather than from imagination. On
 * Windows npm writes three shims into one directory — an extension-less shell
 * script, a `.cmd`, and a scripting-language variant — and Node cannot start the
 * first or use the last. Getting this wrong produced `spawn claude ENOENT` from a
 * CLI that was plainly on PATH, which is the least helpful failure shape there
 * is: it names a problem that is not the problem.
 */

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gov-resolve-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const always = (paths: readonly string[]) =>
  async (p: string): Promise<boolean> => paths.includes(p);

/** A shim shaped like the one npm actually writes. */
const NPM_BATCH_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\n');

const NPM_SH_SHIM = [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
  'else ',
  '  exec node  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
  'fi',
].join('\n');

test('the entry is read out of a batch shim, with its directory token stripped', () => {
  const entry = entryFromShim(NPM_BATCH_SHIM);
  assert.equal(entry, 'node_modules/@anthropic-ai/claude-code/cli.js');
  // The token must not survive: joined naively it produced
  // `...\npm\%dp0%\node_modules\...`, which is not a file and not a diagnostic.
  assert.equal(entry?.includes('%dp0%'), false);
});

test('the entry is read out of a shell shim too', () => {
  assert.equal(
    entryFromShim(NPM_SH_SHIM),
    'node_modules/@anthropic-ai/claude-code/cli.js',
  );
});

test('an unfamiliar shim yields nothing rather than a wrong answer', () => {
  assert.equal(entryFromShim('#!/bin/sh\nexec /usr/bin/thing "$@"\n'), null);
  assert.equal(entryFromShim(''), null);
});

test('PATH search prefers a real executable over an extension-less file', async () => {
  // This is the whole bug in one assertion. The extension-less `claude` exists,
  // is found first by a naive scan, and cannot be started on Windows.
  const bare = join(dir, 'claude');
  const cmd = join(dir, 'claude.cmd');
  const paths = await findOnPath('claude', dir, ['.exe', '.cmd', '.bat'], ';',
    always([bare, cmd]));
  assert.equal(paths, cmd, 'the .cmd must win over the extension-less script');
});

test('PATH search honours extension order', async () => {
  const exe = join(dir, 'tool.exe');
  const cmd = join(dir, 'tool.cmd');
  const found = await findOnPath('tool', dir, ['.exe', '.cmd', '.bat'], ';',
    always([exe, cmd]));
  assert.equal(found, exe, 'a real executable should win over a batch file');
});

test('PATH search walks directories in order', async () => {
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  const first = await findOnPath('x', `${a};${b}`, ['.exe'], ';', always([join(a, 'x.exe'), join(b, 'x.exe')]));
  assert.equal(first, join(a, 'x.exe'));
});

test('PATH search on POSIX does not invent extensions', async () => {
  // Candidates are built with `path.join`, which is platform-correct, so the
  // expectation is built the same way rather than spelled out. Passing a Windows
  // path here would also be wrong: its drive letter is a colon.
  const first = '/usr/local/bin';
  const second = '/usr/bin';
  const target = join(first, 'tool');
  const found = await findOnPath('tool', `${first}:${second}`, [], ':', always([target]));
  assert.equal(found, target);
  // With no extensions configured, the bare name is the only candidate.
  assert.equal(await findOnPath('tool', `${first}:${second}`, [], ':', always([])), null);
});

test('an empty PATH resolves to nothing rather than a bare name', async () => {
  assert.equal(await findOnPath('claude', '', ['.exe'], ';', always([])), null);
  assert.equal(await findOnPath('claude', '   ', ['.exe'], ';', always([])), null);
});

test('a name that already has an extension is not doubled', async () => {
  const cmd = join(dir, 'thing.cmd');
  const found = await findOnPath('thing.cmd', dir, ['.exe', '.cmd'], ';', always([cmd]));
  assert.equal(found, cmd);
});

test('resolveCli follows a batch shim to its JavaScript entry', async () => {
  const shim = join(dir, 'follow', 'claude.cmd');
  const entry = join(dir, 'follow', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const resolved = await resolveCli('claude', {
    platform: 'win32',
    pathValue: join(dir, 'follow'),
    existsFn: always([shim, entry]),
    readShim: async () => NPM_BATCH_SHIM,
    nodeExecutable: 'NODE',
  });
  assert.equal(resolved.command, 'NODE');
  assert.deepEqual(resolved.args, [entry]);
  assert.match(resolved.how, /followed claude\.cmd/);
});

test('resolveCli reports when the shim names an entry that is missing', async () => {
  const shim = join(dir, 'missing', 'claude.cmd');
  const resolved = await resolveCli('claude', {
    platform: 'win32',
    pathValue: join(dir, 'missing'),
    existsFn: always([shim]),
    readShim: async () => NPM_BATCH_SHIM,
    nodeExecutable: 'NODE',
  });
  // It does not silently fall back to the shim: that would resolve to something
  // that cannot start, and the reason would never reach the human.
  assert.equal(resolved.command, shim);
  assert.match(resolved.how, /entry it names is missing/);
});

test('resolveCli runs an explicit .js path with node', async () => {
  const resolved = await resolveCli('/somewhere/cli.js', { nodeExecutable: 'NODE' });
  assert.equal(resolved.command, 'NODE');
  assert.deepEqual(resolved.args, ['/somewhere/cli.js']);
});

test('resolveCli runs a real executable directly', async () => {
  const exe = join(dir, 'direct', 'tool.exe');
  const resolved = await resolveCli('tool', {
    platform: 'win32',
    pathValue: join(dir, 'direct'),
    existsFn: always([exe]),
    nodeExecutable: 'NODE',
  });
  assert.equal(resolved.command, exe);
  assert.deepEqual(resolved.args, []);
});

test('resolveCli says so when nothing is found', async () => {
  const resolved = await resolveCli('nothing-here', {
    platform: 'win32',
    pathValue: join(dir, 'nowhere'),
    existsFn: always([]),
    nodeExecutable: 'NODE',
  });
  assert.equal(resolved.command, 'nothing-here');
  assert.match(resolved.how, /not found on PATH/);
});

test('resolveCli reports an empty PATH as such', async () => {
  const resolved = await resolveCli('claude', {
    platform: 'win32',
    pathValue: '',
    existsFn: always([]),
    nodeExecutable: 'NODE',
  });
  assert.match(resolved.how, /PATH was empty/);
});

test('resolveCli on POSIX follows an extension-less shell shim', async () => {
  const shim = join(dir, 'posix', 'claude');
  const entry = join(dir, 'posix', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const resolved = await resolveCli('claude', {
    platform: 'linux',
    pathValue: join(dir, 'posix'),
    existsFn: always([shim, entry]),
    readShim: async () => NPM_SH_SHIM,
    nodeExecutable: 'NODE',
  });
  assert.equal(resolved.command, 'NODE');
  assert.deepEqual(resolved.args, [entry]);
});

/* ---- failure classification ----
 *
 * The reason travels separately from the words, because the two failure states
 * that matter most here look identical from outside and need opposite responses:
 * a CLI that will not start, and a CLI that starts and rejects the credentials.
 * Collapsing them produced a screen that told a person with a perfectly working
 * CLI that it "cannot run on this machine".
 */

test('a rejected credential is classified as not-authenticated', () => {
  const r = classifyTurnFailure(
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."}} · Please run /login',
  );
  assert.equal(r.reason, 'not-authenticated');
  // The raw error is kept: it is what a search engine can be asked about.
  assert.match(r.detail, /401/);
  // But no advice is baked in. The audience decides what to do with it, and
  // baking one audience's instructions in made the interface repeat them wrong.
  assert.equal(/Log in once/.test(r.detail), false);
});

test('a missing executable is classified as not-installed', () => {
  assert.equal(classifyTurnFailure('spawn claude ENOENT').reason, 'not-installed');
  assert.equal(
    classifyTurnFailure("'claude' is not recognized as a command").reason,
    'not-installed',
  );
});

test('a host refusal is classified as blocked, not as a configuration problem', () => {
  const r = classifyTurnFailure('PROGRAM BLOCKED BY SECURITY POLICY: refused to start reg.exe');
  assert.equal(r.reason, 'blocked');
});

test('being rate limited is its own reason', () => {
  assert.equal(classifyTurnFailure('429 rate_limit_error').reason, 'rate-limited');
});

test('a turn with no session id is its own reason', () => {
  assert.equal(
    classifyTurnFailure('the CLI ran but returned no session id').reason,
    'no-session',
  );
});

test('an unrecognised error is passed through under unknown', () => {
  const r = classifyTurnFailure('something nobody has seen before');
  assert.equal(r.reason, 'unknown');
  assert.equal(r.detail, 'something nobody has seen before');
});

test('a silent failure still says something', () => {
  const r = classifyTurnFailure('   ');
  assert.equal(r.reason, 'unknown');
  assert.equal(r.detail, 'the CLI reported a failure with no detail');
});
