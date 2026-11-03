import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { addWorkspace } from '../src/workspaces.js';

/**
 * The workspace list is hand-editable, so the tool may only ever *add* to it.
 * These pin the three properties that keep that true: a broken file is left
 * alone, an unrelated key survives a write, and adding the same root twice does
 * not produce two entries.
 */

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gov-workspaces-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a root is added to an empty file and read back', async () => {
  const file = join(dir, 'a.json');
  await writeFile(file, JSON.stringify({ roots: [] }), 'utf8');
  const result = await addWorkspace(join(dir, 'repo'), file);
  assert.equal(result.added, true);
  assert.deepEqual(result.roots, [resolve(dir, 'repo')]);
  /* Read the file itself. `loadWorkspaces` prefers the list beside the tool,
   * so going through it here would assert on whatever the running checkout
   * happens to have configured — a test of the fixture, not of the writer. */
  const saved = JSON.parse(await readFile(file, 'utf8')) as { roots: string[] };
  assert.deepEqual(saved.roots, [resolve(dir, 'repo')]);
});

test('adding the same root twice reports added:false and writes nothing new', async () => {
  const file = join(dir, 'b.json');
  await writeFile(file, JSON.stringify({ roots: [] }), 'utf8');
  await addWorkspace(join(dir, 'repo'), file);
  const again = await addWorkspace(join(dir, 'repo'), file);
  assert.equal(again.added, false);
  assert.equal(again.roots.length, 1);
});

test('a relative entry is kept, and compared after resolution', async () => {
  const file = join(dir, 'c.json');
  await writeFile(file, JSON.stringify({ roots: ['../repo'] }), 'utf8');
  const result = await addWorkspace(resolve(dir, '..', 'repo'), file);
  assert.equal(result.added, false, 'the relative entry already points there');
});

test('a key the tool does not read survives the rewrite', async () => {
  const file = join(dir, 'd.json');
  await writeFile(file, JSON.stringify({ note: 'hand written', roots: [] }), 'utf8');
  await addWorkspace(join(dir, 'repo2'), file);
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['note'], 'hand written');
  assert.equal((raw['roots'] as string[]).length, 1);
});

test('a file that is not JSON is refused rather than replaced', async () => {
  const file = join(dir, 'e.json');
  await writeFile(file, '{ this is not json', 'utf8');
  await assert.rejects(() => addWorkspace(join(dir, 'repo'), file), /cannot be updated/);
  assert.equal(await readFile(file, 'utf8'), '{ this is not json');
});

test('a file without a roots array is refused rather than replaced', async () => {
  const file = join(dir, 'f.json');
  await writeFile(file, JSON.stringify({ roots: 'nope' }), 'utf8');
  await assert.rejects(() => addWorkspace(join(dir, 'repo'), file), /cannot be updated/);
});

test('a missing file is created', async () => {
  const file = join(dir, 'g.json');
  const result = await addWorkspace(join(dir, 'fresh'), file);
  assert.equal(result.added, true);
  const raw = JSON.parse(await readFile(file, 'utf8')) as { roots: string[] };
  assert.deepEqual(raw.roots, [resolve(dir, 'fresh')]);
  assert.ok((await readFile(file, 'utf8')).endsWith('\n'), 'the file ends with a newline');
});
