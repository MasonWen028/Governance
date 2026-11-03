import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import {
  inspectCodebase,
  pickReader,
  readerSkills,
  readmeParagraph,
  renderCodebaseDoc,
} from '../src/tracker/codebase.js';

/**
 * Reading an existing repository is the one place the tool looks at code it did
 * not write, so the tests are about honesty: counts are files seen, a skipped
 * directory is not a missing one, and a README paragraph is prose rather than
 * the first line of markup.
 */

let root: string;
const execFileAsync = promisify(execFile);

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-codebase-'));

  // A small but realistic repository: markers, two languages, a test, CI, docs.
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(join(root, '.scratch', 'some-feature'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  );
  await writeFile(join(root, 'tsconfig.json'), '{}');
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src', 'util.ts'), 'export const b = 2;\n');
  await writeFile(join(root, 'src', 'legacy.js'), 'module.exports = 3;\n');
  await writeFile(join(root, 'test', 'index.test.ts'), '// nothing\n');
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  await writeFile(
    join(root, 'README.md'),
    [
      '# Demo',
      '',
      '[![build](https://img.shields.io/x.svg)](https://example.com)',
      '',
      'A demo repository that exists so the reader has something',
      'to describe correctly, wrapping mid-sentence.',
      '',
      '## Install',
      '',
      'npm ci',
      '',
    ].join('\n'),
  );
  // Dependency and feature directories must not be counted as source.
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'x\n');
  await writeFile(join(root, '.scratch', 'some-feature', 'map.md'), '# map\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('a directory that is not there is null, not an empty repository', async () => {
  assert.equal(await inspectCodebase(join(root, 'does-not-exist')), null);
});

test('stack markers are read from the root, in a stated order', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  const labels = brief.stack.map((s) => s.label);
  // No lockfile in the fixture, so the package manager is not named.
  assert.deepEqual(labels, ['Node', 'TypeScript']);
});

test('languages are counted by files, and skipped directories do not count', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  const ts = brief.languages.find((l) => l.language === 'TypeScript');
  const js = brief.languages.find((l) => l.language === 'JavaScript');
  // index.ts, util.ts, test/index.test.ts — but not node_modules/left-pad/index.js
  assert.equal(ts?.files, 3);
  assert.equal(js?.files, 1, 'node_modules is dependency output, not this repository');
  assert.equal(brief.files, 8, 'package.json, tsconfig, 3 ts, 1 js, ci.yml, readme');
});

test('a feature directory is not part of the codebase', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  assert.equal(brief.dirs.some((d) => d.name === 'some-feature'), false);
  assert.equal(brief.languages.some((l) => l.language === 'Markdown'), false);
});

test('docs, tests and CI are named rather than counted', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  assert.ok(brief.docs.includes('README.md'));
  assert.ok(brief.tests.includes('test/'));
  assert.ok(brief.tests.includes('index.test.ts'));
  assert.deepEqual(brief.ci, ['ci.yml']);
});

test('the README paragraph is prose, not the first line of markup', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  assert.equal(
    brief.readme,
    'A demo repository that exists so the reader has something to describe correctly, wrapping mid-sentence.',
  );
});

test('readmeParagraph skips badges and headings, and stops at the next heading', () => {
  const raw = ['# T', '', '![b](x)', '', 'First sentence.', 'Second line.', '', '## Next', 'no'].join('\n');
  assert.equal(readmeParagraph(raw), 'First sentence. Second line.');
  assert.equal(readmeParagraph('# only a heading\n'), null);
  assert.equal(readmeParagraph(''), null);
});

test('readmeParagraph caps a long paragraph and says so with an ellipsis', () => {
  const long = 'word '.repeat(200);
  const out = readmeParagraph(long, 40);
  assert.ok(out !== null);
  assert.equal(out.length, 40);
  assert.ok(out.endsWith('…'));
});

test('a directory with no git says so instead of inventing a branch', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  // The temp directory is not a repository. If git is installed and a parent
  // happens to be one, `git -C` still resolves the *enclosing* repository, so
  // the assertion is on the shape rather than on null.
  if (brief.git === null) {
    assert.ok(brief.notes.some((n) => n.startsWith('no git repository')));
  } else {
    assert.equal(typeof brief.git.branch, 'string');
  }
});

test('a real repository reports its branch and remote', async () => {
  /* Its own directory: a second repository inside the shared fixture would
   * change the file counts every test above asserts on. */
  const repo = await mkdtemp(join(tmpdir(), 'gov-codebase-git-'));
  await writeFile(join(repo, 'a.txt'), 'a\n');
  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync('git', ['-C', repo, ...args], { windowsHide: true });
  };
  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('add', '.');
    await git('commit', '-q', '-m', 'first');
  } catch {
    return; // No git on this machine: the null path is covered above.
  }
  const brief = await inspectCodebase(repo);
  assert.ok(brief !== null);
  assert.equal(brief.git?.branch, 'main');
  assert.equal(brief.git?.dirty, false);
  assert.equal(brief.git?.remote, null);
  await rm(repo, { recursive: true, force: true });
});

test('reader skills are found by what their description says', async () => {
  const skills = await mkdtemp(join(tmpdir(), 'gov-codebase-skills-'));
  await mkdir(join(skills, 'research'), { recursive: true });
  await mkdir(join(skills, 'implement-spec'), { recursive: true });
  await mkdir(join(skills, 'not-a-skill'), { recursive: true });
  await writeFile(
    join(skills, 'research', 'SKILL.md'),
    '---\nname: research\ndescription: Investigate a question against a codebase and write findings.\n---\n# Research\n',
  );
  await writeFile(
    join(skills, 'implement-spec', 'SKILL.md'),
    '---\nname: implement-spec\ndescription: Implement a spec and write code.\n---\n',
  );
  const found = await readerSkills(skills);
  assert.deepEqual(
    found.map((s) => s.id),
    ['research', 'implement-spec'],
    'a directory without SKILL.md is not a skill',
  );
  assert.ok(found[0] !== undefined && found[0].score > 0);
  assert.ok(found[1] !== undefined && found[1].score < 0, 'writing code scores against reading it');
  assert.equal(pickReader(found)?.id, 'research');
});

test('pickReader refuses to invent a choice when nothing scored', () => {
  assert.equal(pickReader([]), null);
  assert.equal(
    pickReader([{ id: 'x', description: '', score: 0, reason: 'nothing' }]),
    null,
  );
});

test('the named reader wins even when another skill scores higher', () => {
  /* `/intake-and-mapping` is the skill this project reads codebases with. The
   * scorer exists for machines that do not have it; on a machine that does, the
   * answer must not depend on which other skills happen to be installed. */
  const skills = [
    { id: 'research', description: 'Investigate a repository', score: 12, reason: 'it investigates' },
    {
      id: 'intake-and-mapping',
      description: 'Use when entering Phase -1',
      score: 0,
      reason: 'installed, but its description says nothing about reading code',
    },
  ];
  assert.equal(pickReader(skills)?.id, 'intake-and-mapping');
});

test('without the named reader the scorer still answers', () => {
  const skills = [
    { id: 'improve-codebase-architecture', description: '', score: 6, reason: 'names the codebase' },
    { id: 'research', description: '', score: 3, reason: 'it investigates' },
  ];
  assert.equal(pickReader(skills)?.id, 'improve-codebase-architecture');
});

test('a missing skills root is an empty list, not a throw', async () => {
  assert.deepEqual(await readerSkills(join(root, 'no-such-skills')), []);
});

test('the written document carries the facts, the pick, and what is missing', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  const doc = renderCodebaseDoc(brief, {
    id: 'research',
    description: 'reads a codebase',
    score: 6,
    reason: 'its description names the codebase',
  });
  assert.match(doc, /^# Codebase: /);
  assert.ok(doc.includes('files counted: ' + brief.files), 'the count comes from the brief, not from the test');
  assert.match(doc, /Chosen skill: `\/research`/);
  assert.match(doc, /## What is not here/);
  assert.match(doc, /does not claim the code was understood/);
});

test('with no skill found the document says so, rather than naming a guess', async () => {
  const brief = await inspectCodebase(root);
  assert.ok(brief !== null);
  const doc = renderCodebaseDoc(brief, null);
  assert.match(doc, /No installed skill claims to read a codebase/);
  assert.equal(/Chosen skill/.test(doc), false);
});

/* ---- three things the first real repository got wrong ----
 *
 * Reading H:\Projects\railyard reported no stack, no tests, and filed its ADR
 * directory under CI. Every one of those was a false statement about a
 * repository that plainly had each thing, so each gets a fixture.
 */

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gov-codebase-case-'));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return dir;
}

test('requirements-test.txt counts as Python, not as no stack at all', async () => {
  const dir = await fixture({
    'requirements-mcp.txt': 'mcp\n',
    'requirements-test.txt': 'pytest\n',
    'scripts/run.py': 'print(1)\n',
  });
  const brief = await inspectCodebase(dir);
  assert.ok(brief !== null);
  const labels = brief.stack.map((s) => s.label);
  assert.deepEqual(labels, ['Python (pip)'], 'pip is named once, whichever requirement file was found');
  assert.match(brief.stack[0]?.marker ?? '', /^requirements-(mcp|test)\.txt$/);
  await rm(dir, { recursive: true, force: true });
});

test('test_*.py is a test, so a Python repository is not reported as untested', async () => {
  const dir = await fixture({
    'scripts/test_census.py': 'def test_x():\n    pass\n',
    'scripts/test_release.py': 'def test_y():\n    pass\n',
    'scripts/board.py': 'x = 1\n',
  });
  const brief = await inspectCodebase(dir);
  assert.ok(brief !== null);
  assert.deepEqual([...brief.tests].sort(), ['test_census.py', 'test_release.py']);
  assert.equal(
    brief.notes.some((n) => n.startsWith('no test directory')),
    false,
    'the reader must not claim there are no tests when there are',
  );
  await rm(dir, { recursive: true, force: true });
});

test('docs/adr is documentation, not continuous integration', async () => {
  const dir = await fixture({
    'docs/adr/0001-one.md': '# one\n',
    'docs/guide.md': '# guide\n',
    'src/app.ts': 'export const a = 1;\n',
  });
  const brief = await inspectCodebase(dir);
  assert.ok(brief !== null);
  assert.deepEqual(brief.ci, [], 'a repository with no pipelines must report none');
  assert.ok(brief.docs.includes('docs/'));
  assert.ok(brief.docs.includes('docs/adr/'), 'ADRs are documentation and are named as such');
  await rm(dir, { recursive: true, force: true });
});

test('a skill that changes code ranks below one that reads it', async () => {
  const skills = await mkdtemp(join(tmpdir(), 'gov-codebase-rank-'));
  const write = async (id: string, description: string): Promise<void> => {
    await mkdir(join(skills, id), { recursive: true });
    await writeFile(
      join(skills, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${description}\n---\n`,
      'utf8',
    );
  };
  await write('improve-codebase-architecture', 'Scan a codebase for deepening opportunities, then improve it.');
  await write('research', 'Investigate a question against a codebase and capture the findings.');
  const found = await readerSkills(skills);
  assert.equal(found[0]?.id, 'research');
  assert.ok(
    (found[0]?.score ?? 0) > (found[1]?.score ?? 0),
    'understanding must outrank changing',
  );
  assert.equal(pickReader(found)?.id, 'research');
  await rm(skills, { recursive: true, force: true });
});
