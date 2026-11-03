import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { serve } from '../src/server/http.js';
import { DEFAULT_SETTINGS, writeSettings } from '../src/config/settings.js';

/**
 * The bridge from "the code has been read" to "there is work to do", over a real
 * socket.
 *
 * The property worth holding down is that creating a feature is never a side
 * effect of looking. A page that renders the areas must not be silently making
 * them, because deriving is not idempotent: each call is a decision, and a
 * reload would then be a decision too.
 */

let base: string;
let port: number;
/** The repository root, so the tool's own workspace list can be named.
 *  Compiled tests run from dist/test, hence two levels up. */
const here = dirname(fileURLToPath(import.meta.url));
/** Where the server under test keeps its config — separate from the targets. */
let configRoot: string;
let settingsFile: string;
let workspacesFile: string;
const stop = new AbortController();

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-areas-api-'));
  configRoot = root;
  settingsFile = join(root, 'governance.settings.json');
  workspacesFile = join(root, 'governance.workspaces.json');
  await writeSettings(DEFAULT_SETTINGS, settingsFile);

  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
  const addr = probe.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  base = `http://127.0.0.1:${port}`;

  void serve({ roots: [root], port, settingsPath: settingsFile, workspacesPath: workspacesFile,
    signal: stop.signal });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not come up');
});

after(() => {
  stop.abort();
});

/** A workspace under the configured root, with a reading already in it. */
async function workspaceWithAreas(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gov-areas-api-target-'));
  const areas = join(dir, 'docs', 'discovery', 'areas');
  await mkdir(areas, { recursive: true });
  await writeFile(
    join(areas, 'enquiry.md'),
    '# Enquiry\n\nTurn a quote request into an email to the right mailbox.\n',
    'utf8',
  );
  await writeFile(
    join(areas, 'public-pages.md'),
    '# Public pages\n\nPresent the brochure and route a visitor to the quote form.\n',
    'utf8',
  );
  const r = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  assert.equal(r.status, 201, 'the workspace was not registered');
  return dir;
}

async function getAreas(target: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(
    `${base}/api/areas?root=${encodeURIComponent(target)}&outputRoot=docs%2Fdiscovery`,
  );
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('GET /api/areas reports what the reading named, and creates nothing', async () => {
  const dir = await workspaceWithAreas();
  try {
    const { status, body } = await getAreas(dir);
    assert.equal(status, 200);
    assert.equal(body['count'], 2);
    const areas = body['areas'] as { slug: string; name: string; purpose: string }[];
    assert.deepEqual(areas.map((a) => a.slug).sort(), ['enquiry', 'public-pages']);
    assert.ok(areas.every((a) => a.purpose.length > 0), 'an area with no purpose was reported');

    /* Reading is not deciding. If listing made features, reloading the page
     * would quietly create them again and again. */
    const scratch = await readdir(join(dir, '.scratch')).catch((): string[] => []);
    assert.ok(!scratch.includes('enquiry'), 'listing the areas already made the feature');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/areas refuses a root that is not a workspace', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'gov-areas-api-outside-'));
  try {
    const { status } = await getAreas(outside);
    assert.equal(status, 403, 'an unregistered root is not readable through this endpoint');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('POST /api/areas/features makes one feature per chosen area', async () => {
  const dir = await workspaceWithAreas();
  try {
    const r = await fetch(`${base}/api/areas/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: dir, outputRoot: 'docs/discovery', slugs: ['enquiry'] }),
    });
    assert.equal(r.status, 201);
    const body = (await r.json()) as {
      created: { slug: string; name: string }[];
      activityId?: string;
    };
    assert.deepEqual(body.created.map((c) => c.slug), ['enquiry']);
    assert.equal(body.created[0]?.name, 'Enquiry');
    assert.ok(typeof body.activityId === 'string', 'the work was not tracked');

    const written = await readFile(join(dir, '.scratch', 'enquiry', 'INHERITED.md'), 'utf8');
    assert.ok(written.includes('Enquiry'));
    /* Only the one that was asked for. Sending one slug and getting two features
     * would be the endpoint deciding for the caller. Directories only —
     * registering the workspace leaves a CODEBASE.md beside them. */
    const dirs = (await readdir(join(dir, '.scratch'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    assert.deepEqual(dirs, ['enquiry']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registering a workspace writes the list it was given, not the tool\'s own', async () => {
  /* The bug this pins: registration fell back to the workspace list beside the
   * tool, so every test run added its temporary directories to the list the
   * human actually uses — 157 entries, most of them deleted folders, after a
   * few runs. A suite that mutates the thing it is testing also leaves the next
   * run starting from a state nobody chose. */
  const dir = await workspaceWithAreas();
  try {
    const injected = JSON.parse(
      await readFile(join(configRoot, 'governance.workspaces.json'), 'utf8'),
    ) as { roots: string[] };
    assert.ok(injected.roots.includes(dir), 'it did not write the list it was given');

    const own = JSON.parse(
      await readFile(join(here, '..', '..', 'governance.workspaces.json'), 'utf8'),
    ) as { roots: string[] };
    assert.ok(
      !own.roots.some((r) => r.includes('gov-areas-api-')),
      'a temporary root was added to the tool\'s own workspace list',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a project with no areas says so instead of inventing them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-areas-api-empty-'));
  try {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(r.status, 201);

    const listed = await getAreas(dir);
    assert.equal(listed.status, 200);
    assert.equal(listed.body['count'], 0);

    /* Nothing was read, so there is nothing to turn into work — and saying
     * "created 0" with a 201 would read like success. */
    const made = await fetch(`${base}/api/areas/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: dir }),
    });
    assert.equal(made.status, 409, 'deriving from no areas should be refused, not empty-success');
    const body = (await made.json()) as { error: string };
    assert.ok(/no areas/i.test(body.error), 'the refusal does not say why');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
