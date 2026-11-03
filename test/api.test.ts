import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { DECISIONS_FILE } from '../src/tracker/decisions.js';
import { serve } from '../src/server/http.js';

/**
 * The server, over a real socket.
 *
 * The two properties worth testing hardest are the ones that keep the boundary
 * honest: it writes only inside a feature's own `.scratch/`, and it never accepts
 * a path from the client. Both are asserted by trying to break them.
 */

let root: string;
let base: string;
/** A settings file under the temp root, so the suite never writes to the
 *  repository's own config. */
let settingsFile: string;
let workspacesFile: string;

async function buildRepo(dir: string): Promise<void> {
  const feature = join(dir, '.scratch', 'demo-feature');
  await mkdir(join(feature, 'issues'), { recursive: true });
  await writeFile(
    join(feature, 'map.md'),
    '# Map: demo\n\n## Destination\n\n> Prove the API.\n',
    'utf8',
  );
  await writeFile(
    join(feature, 'issues', '01-one.md'),
    '# 01: One\n\n**Type:** task\n**Status:** open\n**Blocked by:** None (can start immediately)\n\n## Question\n\nwhy\n',
    'utf8',
  );
  await writeFile(
    join(feature, 'gates.json'),
    JSON.stringify([
      {
        id: 'g1',
        title: 'Prove it',
        stage: 'develop',
        scope: { kind: 'stage', ref: 'develop' },
        owner: 'po',
        methods: ['signoff'],
        blocking: true,
        onFail: 'rework',
        raisedBy: 'manual',
      },
    ]),
    'utf8',
  );
}

/** Ask the OS for a free port, so the test never collides with a real run. */
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

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-api-'));
  await buildRepo(root);

  settingsFile = join(root, 'test-settings.json');
  workspacesFile = join(root, 'test-workspaces.json');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  // serve() resolves only when the server closes, so it is deliberately not
  // awaited. The health probe below is what proves it came up.
  void serve({ roots: [root], port, settingsPath: settingsFile, workspacesPath: workspacesFile });

  for (let i = 0; i < 60; i++) {
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
  await rm(root, { recursive: true, force: true });
  // The server keeps the process alive by design (foreground only), so the test
  // process is ended explicitly once the tree is cleaned up.
  process.exit(0);
});

test('GET /api/health reports the roots it was given', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; roots: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.roots.length, 1);
});

test('GET /api/projects returns the scanned tree', async () => {
  const r = await fetch(`${base}/api/projects`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    name: string;
    features: { slug: string; tickets: unknown[] }[];
  }[];
  assert.equal(body.length, 1);
  assert.equal(body[0]!.features[0]!.slug, 'demo-feature');
  assert.equal(body[0]!.features[0]!.tickets.length, 1);
});

test('GET /api/gates reports the open gate and its feature-qualified id', async () => {
  const r = await fetch(`${base}/api/gates`);
  const body = (await r.json()) as { id: string; state: string }[];
  assert.equal(body.length, 1);
  assert.equal(body[0]!.state, 'open');
  assert.match(body[0]!.id, /^[^/]+\/demo-feature\/g1$/);
});

test('GET /api/open-gates lists it as owed', async () => {
  const r = await fetch(`${base}/api/open-gates`);
  const body = (await r.json()) as { feature: string }[];
  assert.equal(body.length, 1);
  assert.equal(body[0]!.feature, 'demo-feature');
});

test('POST /api/decide appends a decision and returns 201', async () => {
  const projects = (await (await fetch(`${base}/api/projects`)).json()) as {
    name: string;
  }[];
  const project = projects[0]!.name;

  const r = await fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gate: `${project}/demo-feature/g1`,
      outcome: 'pass',
      actor: 'po',
      methods: ['signoff'],
      evidence: ['issues/01-one.md'],
    }),
  });
  assert.equal(r.status, 201);

  // It landed on disk, one line, in the feature's own directory.
  const raw = await readFile(join(root, '.scratch', 'demo-feature', DECISIONS_FILE), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as { outcome: string }).outcome, 'pass');
});

test('the gate is no longer open once decided', async () => {
  const r = await fetch(`${base}/api/open-gates`);
  const body = (await r.json()) as unknown[];
  assert.equal(body.length, 0);
});

test('POST /api/decide rejects an override with no reason', async () => {
  const projects = (await (await fetch(`${base}/api/projects`)).json()) as {
    name: string;
  }[];
  const project = projects[0]!.name;
  const r = await fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gate: `${project}/demo-feature/g1`,
      outcome: 'override',
      actor: 'po',
      methods: ['signoff'],
      evidence: ['x'],
    }),
  });
  // 400, not 500: the caller's input broke a rule, and the message names it.
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: string };
  assert.ok(body.error.includes('reason'), body.error);
});

test('POST /api/decide rejects an unknown role', async () => {
  const projects = (await (await fetch(`${base}/api/projects`)).json()) as {
    name: string;
  }[];
  const r = await fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gate: `${projects[0]!.name}/demo-feature/g1`,
      outcome: 'pass',
      actor: 'ceo',
      methods: ['signoff'],
      evidence: ['x'],
    }),
  });
  assert.equal(r.status, 400);
});

test('POST /api/decide rejects a gate id that is not three parts', async () => {
  const r = await fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gate: 'g1',
      outcome: 'skip',
      actor: 'po',
      methods: [],
      evidence: [],
    }),
  });
  assert.equal(r.status, 400);
});

test('a gate id cannot escape the workspace', async () => {
  const projects = (await (await fetch(`${base}/api/projects`)).json()) as {
    name: string;
  }[];
  const project = projects[0]!.name;
  const attempts = [
    `${project}/../../etc/g1`,
    `${project}/..%2F..%2Fetc/g1`,
    `${project}/../.git/g1`,
    `${project}/%2e%2e%2f%2e%2e/g1`,
  ];
  for (const gate of attempts) {
    const r = await fetch(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate, outcome: 'skip', actor: 'po', methods: [], evidence: [] }),
    });
    assert.equal(r.status, 400, `accepted an escaping gate id: ${gate}`);
  }
  // And nothing was written above the feature.
  const stray = await readFile(join(root, DECISIONS_FILE), 'utf8').catch(() => null);
  assert.equal(stray, null, 'a decision landed outside .scratch/');
});

test('an unknown project is refused', async () => {
  const r = await fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gate: 'not-a-project/demo-feature/g1',
      outcome: 'skip',
      actor: 'po',
      methods: [],
      evidence: [],
    }),
  });
  assert.equal(r.status, 400);
});

test('a malformed body is refused with 400, not 500', async () => {
  const r = await fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(r.status, 400);
});

test('responses are never cached', async () => {
  const r = await fetch(`${base}/api/projects`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

/* ---- settings ---- */

test('GET /api/settings returns the defaults when no file exists', async () => {
  const r = await fetch(`${base}/api/settings`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { settings: { agents: { maxParallel: number } }; source: string | null };
  assert.equal(body.settings.agents.maxParallel, 4);
  // The test machine may or may not have a settings file; either is acceptable,
  // so only the shape is asserted.
  assert.ok(body.source === null || typeof body.source === 'string');
});

test('PUT /api/settings validates before writing', async () => {
  const r = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { agents: { maxParallel: 99, isolation: 'nonsense' } } }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    settings: { agents: { maxParallel: number; isolation: string } };
    warnings: string[];
  };
  assert.equal(body.settings.agents.maxParallel, 8, 'clamped, not stored as given');
  assert.equal(body.settings.agents.isolation, 'worktree');
  assert.ok(body.warnings.some((w) => w.includes('nonsense')));
});

test('PUT /api/settings rejects a non-JSON body with 400', async () => {
  const r = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: 'nope',
  });
  assert.equal(r.status, 400);
});

test('GET /api/chain reports the skill for every stage', async () => {
  const r = await fetch(`${base}/api/chain`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    chain: { stage: string; skill: string | null; enabled: boolean; present: boolean | null }[];
  };
  assert.equal(body.chain.length, 9, 'all nine stages, including the CI gap');
  const ship = body.chain.find((c) => c.stage === 'ship');
  assert.equal(ship?.skill, null, 'the ship stage has no skill');
  assert.equal(ship?.present, null);
  const develop = body.chain.find((c) => c.stage === 'develop');
  assert.equal(develop?.skill, 'implement-spec');
  // `present` is read from disk. On this machine the skills are installed, so it
  // should be true; the assertion is that it is a boolean, not a guess.
  assert.equal(typeof develop?.present, 'boolean');
});

test('GET /api/mcp lists the configured servers', async () => {
  const r = await fetch(`${base}/api/mcp`);
  const body = (await r.json()) as { servers: unknown[] };
  assert.ok(Array.isArray(body.servers));
});

test('POST /api/mcp/test refuses a name that is not configured', async () => {
  const r = await fetch(`${base}/api/mcp/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'not-a-server' }),
  });
  assert.equal(r.status, 404);
});

/* ---- concept init ---- */

const INIT_BODY = (feature: string, root: string) => ({
  root,
  feature,
  title: 'A feature from the wizard',
  destination: 'Prove the init endpoint writes what the scanner reads.',
  notes: ['Domain: testing.'],
  decisions: ['Target: people.'],
  notYetSpecified: ['Scale.'],
  outOfScope: ['Cloud.'],
  glossary: [{ word: 'frame', meaning: 'one decoded still' }],
  prd: {
    problem: 'Nothing watches.',
    solution: 'A service that does.',
    stories: ['As the only user, I want an alert, so that it matters.'],
    decisions: ['Target: people.'],
    testing: ['External behaviour only.'],
    seam: 'At the ingest boundary.',
    outOfScope: ['Multi-camera.'],
  },
  prototypeTickets: [
    { id: '1', title: 'Queue throughput', kind: 'logic', reason: 'Measured, not argued.' },
  ],
});

test('POST /api/init creates a feature that then scans', async () => {
  const r = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(INIT_BODY('wizard-feature', root)),
  });
  assert.equal(r.status, 201);
  const body = (await r.json()) as { featureDir: string; files: string[] };
  assert.equal(body.files.length, 4);

  // The point of the endpoint: the created feature is visible to the scanner.
  const projects = (await (await fetch(`${base}/api/projects`)).json()) as {
    name: string;
    features: { slug: string; stages: Record<string, string>; tickets: unknown[] }[];
  }[];
  const feature = projects[0]!.features.find((e) => e.slug === 'wizard-feature');
  assert.ok(feature, 'the new feature did not appear in the scan');
  assert.equal(feature.stages.intake, 'complete');
  assert.equal(feature.stages.spec, 'complete');
  assert.equal(feature.stages.design, 'active', 'design is open, not waived');
  assert.equal(feature.tickets.length, 1, 'the prototype ticket was written');
});

test('a second init with the same slug is refused with 409', async () => {
  const r = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(INIT_BODY('wizard-feature', root)),
  });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string };
  assert.ok(body.error.includes('already exists'));
});

test('init refuses a root that is not a configured workspace', async () => {
  const r = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(INIT_BODY('escapee', join(tmpdir(), 'somewhere-else'))),
  });
  // 403, not 400: the request is well formed, the target is not permitted. An
  // endpoint that wrote anywhere it was told would be a hole in the machine.
  assert.equal(r.status, 403);
});

test('init refuses a traversing slug', async () => {
  for (const bad of ['../escape', '..', 'a/b']) {
    const r = await fetch(`${base}/api/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(INIT_BODY(bad, root)),
    });
    assert.equal(r.status, 400, `accepted a dangerous slug: ${bad}`);
  }
});

test('init rejects a malformed body with 400', async () => {
  const r = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(r.status, 400);
});

test('init tolerates missing optional arrays', async () => {
  const r = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, feature: 'sparse-feature', title: 'Sparse', destination: 'Exist.' }),
  });
  // An empty PRD is still a PRD: a section with nothing in it is better than a
  // 500 because a field was absent.
  assert.equal(r.status, 201);
  const body = (await r.json()) as { files: string[] };
  assert.equal(body.files.length, 3);
});

/* ---- the folder chooser ----
 *
 * "New project" needs to look at a directory before it claims one: the git
 * branch asks where to clone, and the empty-folder branch asks whether the
 * folder really is new. Both questions are answered by listing, and the one
 * that matters most is `empty` — because a repository that has only `.git` in
 * it must not be offered as a fresh start.
 */

async function browseAt(dir: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/browse?path=${encodeURIComponent(dir)}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('GET /api/browse lists the subdirectories and counts what is there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-browse-'));
  await mkdir(join(dir, 'alpha'), { recursive: true });
  await mkdir(join(dir, 'beta'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# hi\n', 'utf8');
  await writeFile(join(dir, 'index.js'), 'export {};\n', 'utf8');
  try {
    const { status, body } = await browseAt(dir);
    assert.equal(status, 200);
    assert.equal(body['path'], resolve(dir));
    assert.equal(body['parent'], resolve(dirname(dir)));
    assert.deepEqual((body['dirs'] as { name: string }[]).map((d) => d.name), ['alpha', 'beta']);
    assert.equal(body['files'], 2);
    assert.equal(body['entries'], 4);
    assert.equal(body['empty'], false);
    assert.ok(Array.isArray(body['drives']), 'a chooser needs somewhere to start from');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty folder reports empty, and one holding only .git does not', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'gov-browse-empty-'));
  const repo = await mkdtemp(join(tmpdir(), 'gov-browse-repo-'));
  await mkdir(join(repo, '.git'), { recursive: true });
  try {
    const a = await browseAt(fresh);
    assert.equal(a.body['empty'], true, 'a brand-new folder is empty');
    assert.equal(a.body['entries'], 0);
    assert.deepEqual(a.body['dirs'], []);

    /* The case that would silently break the empty-project branch: a clone that
     * failed half way, or a repository with nothing committed yet, looks like a
     * new folder to anything counting non-hidden entries. */
    const b = await browseAt(repo);
    assert.equal(b.body['empty'], false, 'a folder holding only .git is not a fresh start');
    assert.equal(b.body['entries'], 1);
    assert.equal(b.body['files'], 0);
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('GET /api/browse refuses a path that is not a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-browse-not-'));
  const file = join(dir, 'a-file.txt');
  await writeFile(file, 'x', 'utf8');
  try {
    const { status, body } = await browseAt(file);
    assert.equal(status, 404);
    assert.ok(/not a directory/i.test(String(body['error'])));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a symlinked directory is never offered, and every entry is still counted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-browse-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'gov-browse-outside-'));
  await mkdir(join(dir, 'real'), { recursive: true });
  await symlink(outside, join(dir, 'linked'), 'dir');
  try {
    const { body } = await browseAt(dir);
    const names = (body['dirs'] as { name: string }[]).map((d) => d.name);
    assert.ok(names.includes('real'), 'the real directory is still offered');

    /* What keeps a link out of the list is `withFileTypes`: `isDirectory()` on a
     * Dirent describes the link itself, not its target. An earlier draft of this
     * handler also skipped symlinks by hand; mutating that away changed nothing
     * about the listing, which is how it became clear the guarantee was never
     * where its comment said it was. */
    assert.ok(!names.includes('linked'), 'a link is not a directory to clone into');
    assert.equal(body['files'], 0, 'a link is not counted as a file either');

    // The tally has to add up, or `entries` is the only number worth trusting.
    assert.equal(
      (body['dirs'] as unknown[]).length + (body['files'] as number) + (body['other'] as number),
      body['entries'],
      'every entry is accounted for exactly once',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

/* ---- making a folder ----
 *
 * The chooser's other half: a folder that does not exist yet. The temptation is
 * `recursive: true`, which will happily build `H:/a/b/c/d` from a typo and leave
 * four empty directories behind. One level at a time keeps a mistake to one
 * directory, and the parent check is what makes that true.
 */

async function mkdirAt(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/mkdir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('POST /api/mkdir makes one folder, and the chooser can then see it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-mkdir-'));
  const target = join(dir, 'fresh-project');
  try {
    const made = await mkdirAt({ path: target });
    assert.equal(made.status, 201);
    assert.equal(made.body['created'], true);
    assert.equal(made.body['path'], resolve(target));

    // The point of the whole exercise: it is now somewhere a chooser can land.
    const seen = await browseAt(target);
    assert.equal(seen.status, 200);
    assert.equal(seen.body['empty'], true, 'the new folder is a fresh start');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/mkdir will not build a tree nobody asked for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-mkdir-deep-'));
  try {
    const deep = await mkdirAt({ path: join(dir, 'a', 'b', 'c') });
    assert.equal(deep.status, 400, 'a missing parent is refused, not built');
    assert.ok(/parent directory does not exist/i.test(String(deep.body['error'])));

    /* Asserted on the filesystem, not on the status code: which check refuses
     * it is an implementation detail, and `recursive: false` turned out not to
     * be the one doing the work — the parent check is. What has to hold is that
     * three directories were not left behind. */
    assert.deepEqual(await readdir(dir), [], 'no part of the tree was created');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/mkdir refuses a relative path and an empty name', async () => {
  const relative = await mkdirAt({ path: 'somewhere/else' });
  assert.equal(relative.status, 400);

  const blank = await mkdirAt({ path: '' });
  assert.equal(blank.status, 400);

  /* A drive root names no folder. `H:\` is where folders go, not one of them;
   * a trailing separator is not the same thing, because `basename` reads
   * `H:\Projects\` as `Projects` and creating that is perfectly reasonable. */
  const rootOnly = parse(tmpdir()).root;
  assert.ok(rootOnly.length > 0, 'this platform reports a root to test with');
  const bare = await mkdirAt({ path: rootOnly });
  assert.equal(bare.status, 400, 'a path that names no folder is refused');
});

test('POST /api/mkdir does not overwrite what is already there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-mkdir-clash-'));
  const taken = join(dir, 'taken');
  await mkdir(taken, { recursive: true });
  const file = join(dir, 'a-file.txt');
  await writeFile(file, 'x', 'utf8');
  try {
    const again = await mkdirAt({ path: taken });
    assert.equal(again.status, 409, 'a folder that exists is not silently reused');

    const clash = await mkdirAt({ path: file });
    assert.equal(clash.status, 409, 'a file of that name is refused too');

    /* The refusal has to be a refusal: overwriting a file with a directory is
     * the kind of thing that cannot be undone by clicking again. */
    assert.equal((await readFile(file, 'utf8')), 'x', 'the file is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
