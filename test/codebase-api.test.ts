import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { serve } from '../src/server/http.js';

/**
 * Loading a codebase, over a real socket.
 *
 * The three claims under test: inspection is a read, registering writes exactly
 * two things (a root, and one document inside `.scratch/`), and neither accepts
 * a path it was not asked about. The skill is injected through a settings file
 * pointing at a fixture skills root, so the test does not depend on whatever
 * happens to be installed on the machine running it.
 */

const execFileAsync = promisify(execFile);

let tmp: string;
let repo: string;
let existing: string;
let settingsFile: string;
let workspacesFile: string;
let base: string;

async function freePort(): Promise<number> {
  return await new Promise<number>((done, fail) => {
    const probe = createNetServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => done(port));
    });
  });
}

function fileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/')}`;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gov-codebase-api-'));
  repo = join(tmp, 'loaded-repo');
  existing = join(tmp, 'existing');

  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'), { recursive: true });
  await mkdir(existing, { recursive: true });
  await writeFile(join(repo, 'package.json'), '{"name":"loaded"}', 'utf8');
  await writeFile(join(repo, 'src', 'main.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(repo, 'test', 'main.test.ts'), '// test\n', 'utf8');
  await writeFile(join(repo, 'README.md'), '# Loaded\n\nA repository loaded by a test.\n', 'utf8');

  const skills = join(tmp, 'skills');
  await mkdir(join(skills, 'research'), { recursive: true });
  await mkdir(join(skills, 'implement-spec'), { recursive: true });
  await writeFile(
    join(skills, 'research', 'SKILL.md'),
    '---\nname: research\ndescription: Investigate a question against a codebase.\n---\n',
    'utf8',
  );
  await writeFile(
    join(skills, 'implement-spec', 'SKILL.md'),
    '---\nname: implement-spec\ndescription: Implement a spec and write code.\n---\n',
    'utf8',
  );

  settingsFile = join(tmp, 'settings.json');
  workspacesFile = join(tmp, 'governance.workspaces.json');
  await writeFile(
    settingsFile,
    JSON.stringify({ skillsRoot: skills, roots: undefined }),
    'utf8',
  );
  await writeFile(workspacesFile, JSON.stringify({ roots: [] }), 'utf8');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  void serve({
    roots: [existing],
    port,
    settingsPath: settingsFile,
    workspacesPath: workspacesFile,
  });

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('server did not come up');
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
  process.exit(0);
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('inspecting without a path is a refusal, not a guess', async () => {
  const r = await fetch(`${base}/api/codebase`);
  assert.equal(r.status, 400);
});

test('inspecting a relative path is refused', async () => {
  const r = await fetch(`${base}/api/codebase?path=src`);
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: string };
  assert.match(body.error, /not an absolute path/);
});

test('inspecting a path that is not there is 404', async () => {
  const r = await fetch(`${base}/api/codebase?path=${encodeURIComponent(join(tmp, 'nope'))}`);
  assert.equal(r.status, 404);
});

test('inspecting reports the files, and offers the reader it found', async () => {
  const r = await fetch(`${base}/api/codebase?path=${encodeURIComponent(repo)}`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    brief: { files: number; languages: { language: string }[] };
    pick: { id: string } | null;
    alreadyRoot: boolean;
  };
  assert.ok(body.brief.files >= 4);
  assert.equal(body.brief.languages[0]?.language, 'TypeScript');
  assert.equal(body.pick?.id, 'research', 'the fixture skills root decides the pick');
  assert.equal(body.alreadyRoot, false);
});

test('registering adds the root, and says which file now holds it', async () => {
  const r = await post('/api/workspaces', { path: repo });
  assert.equal(r.status, 201);
  const body = (await r.json()) as {
    added: boolean;
    roots: string[];
    file: string;
    doc: { path: string; status: string };
    reader: { id: string } | null;
    project: { root: string } | null;
  };
  assert.equal(body.added, true);
  assert.equal(body.file, workspacesFile);
  assert.equal(body.reader?.id, 'research');
  assert.equal(body.project?.root, repo);

  const saved = JSON.parse(await readFile(workspacesFile, 'utf8')) as { roots: string[] };
  assert.deepEqual(saved.roots, [repo], 'the injected list is the one written');

  const doc = await readFile(join(repo, '.scratch', 'CODEBASE.md'), 'utf8');
  assert.match(doc, /Chosen skill: `\/research`/);
  assert.match(doc, /A repository loaded by a test\./);
});

test('the new root is live: the scanner and the guard both see it', async () => {
  const health = (await (await fetch(`${base}/api/health`)).json()) as { roots: string[] };
  assert.ok(health.roots.includes(repo), 'no restart was needed');

  const projects = (await (await fetch(`${base}/api/projects`)).json()) as { root: string }[];
  assert.ok(projects.some((p) => p.root === repo), 'the project list re-scans the new root');
});

test('loading the same repository twice does not duplicate the entry', async () => {
  const r = await post('/api/workspaces', { path: repo });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { added: boolean; roots: string[] };
  assert.equal(body.added, false);
  assert.equal(body.roots.filter((x) => x === repo).length, 1);
});

test('a second load leaves an existing CODEBASE.md alone', async () => {
  const doc = join(repo, '.scratch', 'CODEBASE.md');
  await writeFile(doc, '# edited by a human\n', 'utf8');
  const r = await post('/api/workspaces', { path: repo });
  const body = (await r.json()) as { doc: { status: string } };
  assert.equal(body.doc.status, 'kept');
  assert.equal(await readFile(doc, 'utf8'), '# edited by a human\n');
});

test('a path inside an existing workspace is refused, with the reason', async () => {
  const r = await post('/api/workspaces', { path: repo });
  assert.equal(r.status, 200, 'still allowed: repo is not inside the existing root');

  const r2 = await post('/api/workspaces', { path: join(repo, 'src') });
  assert.equal(r2.status, 400);
  const body = (await r2.json()) as { error: string };
  assert.match(body.error, /inside the workspace/);
});

test('a path that contains an existing workspace is refused', async () => {
  const r = await post('/api/workspaces', { path: tmp });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: string };
  assert.match(body.error, /contains the workspace/);
});

test('a directory that is not there is 404', async () => {
  const r = await post('/api/workspaces', { path: join(tmp, 'missing-repo') });
  assert.equal(r.status, 404);
});

test('naming a skill that is not installed is refused, and the list is returned', async () => {
  const r = await post('/api/workspaces', { path: repo, skill: 'no-such-skill' });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: string; readers: string[] };
  assert.match(body.error, /no installed skill named/);
  assert.deepEqual(body.readers.sort(), ['implement-spec', 'research']);
});

test('the reader list is ordered by what it says about reading code', async () => {
  const r = await fetch(`${base}/api/skills/readers`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { readers: { id: string; score: number }[] };
  assert.equal(body.readers[0]?.id, 'research');
  assert.ok((body.readers[1]?.score ?? 0) < (body.readers[0]?.score ?? 0));
});

test('a URL that is really a git option is refused', async () => {
  const r = await post('/api/workspaces/clone', {
    url: '--upload-pack=touch /tmp/pwned',
    dir: join(tmp, 'clone-bad'),
  });
  assert.equal(r.status, 400);
  assert.equal((await stat(join(tmp, 'clone-bad')).catch(() => null)) === null, true);
});

test('a destination that already exists is refused rather than written into', async () => {
  const r = await post('/api/workspaces/clone', {
    url: 'https://example.com/x.git',
    dir: existing,
  });
  assert.equal(r.status, 409);
});

test('a destination with no parent directory is refused', async () => {
  const r = await post('/api/workspaces/clone', {
    url: 'https://example.com/x.git',
    dir: join(tmp, 'no', 'such', 'parent', 'repo'),
  });
  assert.equal(r.status, 400);
});

test('a local repository is cloned, and the copy is a repository', async () => {
  const origin = join(tmp, 'origin');
  const dest = join(tmp, 'clone-target');
  await mkdir(join(origin), { recursive: true });
  await writeFile(join(origin, 'file.txt'), 'hello\n', 'utf8');
  try {
    await execFileAsync('git', ['-C', origin, 'init', '-q', '-b', 'main'], { windowsHide: true });
    await execFileAsync('git', ['-C', origin, 'add', '.'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', origin, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'x'],
      { windowsHide: true },
    );
  } catch {
    return; // no git on this machine
  }
  const r = await post('/api/workspaces/clone', { url: fileUrl(origin), dir: dest });
  assert.equal(r.status, 201);
  const body = (await r.json()) as { cloned: string };
  assert.equal(body.cloned, dest);
  assert.ok((await stat(join(dest, 'file.txt'))) !== null);
});
