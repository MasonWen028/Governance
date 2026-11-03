import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import request from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { serve } from '../src/server/http.js';
import { appendEvent } from '../src/tracker/journal.js';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../src/config/settings.js';

/* The run endpoints over a real socket. This is the first surface that can
 * spend money on behalf of an HTTP caller, so the tests spend as much feature
 * on the guards (origin, host, workspace bounds) as on the happy path.
 *
 * Every run goes through an injected stub resolver — a real stage run would
 * launch the actual CLI, and no test gets to do that. `stageDelayMs` is the
 * knob that makes a run still-running when the next request arrives, which is
 * what the 409 and the cancel case need; everything else runs at full speed.
 *
 * Each test starts from quiescence (`beforeEach` drains), because the registry
 * allows exactly one run per feature by design — leaving one in flight would
 * make the next test's 202 depend on the previous test's timing. */

let root: string;
let base: string;
let port: number;
let settingsFile: string;
let workspacesFile: string;
let stageDelayMs = 0;
let stop: AbortController | null = null;

const STAGE_STUB = {
  resolve: async () => ({
    command: process.execPath,
    args: ['-e', `console.log('stub stage ran'); setTimeout(() => {}, ${stageDelayMs})`],
    how: 'stub',
  }),
};

async function buildRepo(dir: string): Promise<void> {
  const feature = join(dir, '.scratch', 'demo-feature');
  await mkdir(feature, { recursive: true });
  await writeFile(join(feature, 'map.md'), '# Map: demo\n\n## Destination\n\n> Prove the API.\n', 'utf8');

  /* A second feature that has already been asked a question it never answered:
   * a blocking gate on `intake`, with the feature at `ask`. */
  const gated = join(dir, '.scratch', 'gated-feature');
  await mkdir(gated, { recursive: true });
  await writeFile(join(gated, 'map.md'), '# Map: gated\n\n## Destination\n\n> Prove the refusal.\n', 'utf8');
  await writeFile(
    join(gated, 'gates.json'),
    JSON.stringify(
      [
        {
          id: 'g-intake',
          title: 'intake signed off',
          stage: 'intake',
          scope: { kind: 'stage', ref: 'intake' },
          owner: 'po',
          methods: ['signoff'],
          blocking: true,
          onFail: 'rework',
          raisedBy: 'manual',
        },
      ],
      null,
      2,
    ),
    'utf8',
  );

  /* A third feature that carries real artifacts, so reading one over HTTP is a
   * real read rather than a fixture that always exists. Kept separate from
   * `demo-feature` so the stage derivation the run tests rely on cannot move. */
  const files = join(dir, '.scratch', 'files-feature');
  await mkdir(join(files, 'docs', 'adr'), { recursive: true });
  await mkdir(join(files, 'issues'), { recursive: true });
  await writeFile(join(files, 'map.md'), '# Map: files\n\n## Destination\n\n> Have artifacts.\n', 'utf8');
  await writeFile(join(files, 'GLOSSARY.md'), '# Glossary\n\n- **feature** — one unit of work.\n', 'utf8');
  await writeFile(
    join(files, 'spec.md'),
    '# Spec\n\n## Problem\n\nThe greeting is wrong.\n\n## Solution\n\nShow the new one.\n',
    'utf8',
  );
  await writeFile(
    join(files, 'docs', 'adr', '0001-first.md'),
    '# ADR 0001 — the first decision\n\n## Status\n\naccepted\n',
    'utf8',
  );
  await writeFile(
    join(files, 'issues', '01-greeting.md'),
    '# 01: Greeting\n\n**Type:** task\n**What to build:** Show heja world.\n**Status:** resolved\n',
    'utf8',
  );
}

async function freePort(): Promise<number> {
  return await new Promise<number>((done, fail) => {
    const probe = createNetServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => done(p));
    });
  });
}

/** A raw request, for headers `fetch` refuses to set (Host, Origin). */
function raw(
  p: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request.request({ host: '127.0.0.1', port: p, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function post(p: string, body: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function get(p: string) {
  const r = await fetch(base + p);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** Poll one job until it leaves `running`. Returns the last view seen. */
async function settled(jobId: string): Promise<Record<string, unknown>> {
  let view: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) {
    view = (await get(`/api/runs/${jobId}`)).body;
    if (view['status'] !== 'running') return view;
    await sleep(20);
  }
  return view;
}

/** Wait until no job is running, so the next test's 202 is not a 409. */
async function drain(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const active = (await get('/api/runs')).body['active'] as unknown[];
    if (active.length === 0) return;
    await sleep(20);
  }
  throw new Error('a run never finished; the suite cannot continue deterministically');
}

/** `/api/projects` as this file reads it: just the parts under test. */
type ProjectsBody = {
  features: {
    slug: string;
    stages: Record<string, string>;
    openChanges?: number;
    derivedFrom?: { parent: string; change: string; text: string } | null;
  }[];
}[];

function parseError(body: Record<string, unknown>): string {
  return String(body['error'] ?? '');
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-runs-api-'));
  await buildRepo(root);
  settingsFile = join(root, 'settings.json');
  workspacesFile = join(root, 'workspaces.json');
  await writeFile(settingsFile, JSON.stringify({ settings: DEFAULT_SETTINGS }), 'utf8');

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  stop = new AbortController();
  void serve({
    roots: [root],
    port,
    settingsPath: settingsFile,
    workspacesPath: workspacesFile,
    stageRunner: STAGE_STUB,
    signal: stop.signal,
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(50);
  }
  throw new Error('the server never came up');
});

beforeEach(async () => {
  stageDelayMs = 0;
  await drain();
});

after(async () => {
  stop?.abort();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

test('POST /api/runs accepts a run and returns the plan before anything happens', async () => {
  const r = await post('/api/runs', { root, feature: 'demo-feature' });
  assert.equal(r.status, 202);
  assert.equal(typeof r.body['jobId'], 'string');
  assert.equal(r.body['status'], 'running');
  assert.equal(r.body['demo'], false);
  const plan = r.body['plan'] as Record<string, unknown>;
  /* map-only feature: derivation puts it at `ask`, whose skill is grilling */
  assert.equal(plan['stage'], 'ask');
  assert.equal(plan['skill'], 'grilling');
  assert.ok((plan['command'] as string[]).includes('--standalone'));
  assert.ok(String(plan['prompt']).includes('Do not move any file outside'));
});

test('GET /api/runs/:id tracks the job to succeeded, and the record lands on disk', async () => {
  const started = await post('/api/runs', { root, feature: 'demo-feature' });
  const jobId = started.body['jobId'] as string;

  const view = await settled(jobId);
  assert.equal(view['status'], 'succeeded');
  assert.equal(view['stage'], 'ask');
  assert.equal(view['exitCode'], 0);
  assert.equal(typeof view['ms'], 'number');

  const history = await get(`/api/runs?root=${encodeURIComponent(root)}&feature=demo-feature`);
  assert.equal(history.status, 200);
  const records = history.body['records'] as Record<string, unknown>[];
  assert.ok(records.some((x) => x['jobId'] === jobId && x['status'] === 'succeeded'));
  assert.ok((history.body['logs'] as unknown[]).length >= 1);
  assert.deepEqual(history.body['active'], []);
});

test('GET /api/runs reports the last time the chain stopped, and why', async () => {
  /* Why this exists: a run succeeds, nothing follows it, and the board shows a
   * green run and then silence. The stop was real and it had a reason — the
   * reason was only ever printed to a console. The activity line that now
   * carries it is in memory and a restart clears it, so the history endpoint
   * reads the last one back off the journal: the place a person looks when they
   * come back later and wonder why nothing is happening. */
  const featureDir = join(root, '.scratch', 'demo-feature');
  await appendEvent(featureDir, {
    kind: 'chain.stopped', ref: 'ask', detail: 'an earlier stop',
    data: { jobId: 'old', stage: 'ask' },
  });
  await appendEvent(featureDir, {
    kind: 'chain.stopped', ref: 'ask', detail: 'a blocking gate is open on split',
    data: { jobId: 'new', stage: 'ask', gates: ['g-split'] },
  });

  const h = await get(`/api/runs?root=${encodeURIComponent(root)}&feature=demo-feature`);
  assert.equal(h.status, 200);
  const stop = h.body['lastStop'] as Record<string, unknown> | null;
  assert.ok(stop, 'a feature that stopped reports the stop');
  assert.equal(stop!['detail'], 'a blocking gate is open on split',
    'the most recent stop, not the first one ever recorded');
  assert.deepEqual((stop!['data'] as Record<string, unknown>)['gates'], ['g-split']);

  /* A feature that never stopped reports no stop, rather than an empty one that
   * reads like a stop with no reason. */
  const clean = await get(`/api/runs?root=${encodeURIComponent(root)}&feature=gated-feature`);
  assert.equal(clean.body['lastStop'], null);
});

test('GET /api/runs/:id carries the audit, so "succeeded" is never read alone', async () => {
  const started = await post('/api/runs', { root, feature: 'demo-feature' });
  const view = await settled(started.body['jobId'] as string);
  const audit = view['audit'] as Record<string, unknown> | null;
  assert.ok(audit !== null, 'a finished run must say what it changed');
  assert.equal(audit['tampered'], false);
  /* No git in a temp workspace: unknown, not clean. */
  assert.equal(audit['outsideWrites'], null);
});

test('a blocking gate behind the operating stage is a 409, and names the gate', async () => {
  const r = await post('/api/runs', { root, feature: 'gated-feature' });
  assert.equal(r.status, 409);
  assert.match(parseError(r.body), /g-intake/);
  const gates = r.body['gates'] as Record<string, unknown>[];
  assert.equal(gates.length, 1);
  assert.equal(gates[0]?.['id'], 'g-intake');
  assert.equal(gates[0]?.['stage'], 'intake');
  assert.equal(gates[0]?.['owner'], 'po');
});

test('a second run while one is in flight is a 409', async () => {
  stageDelayMs = 1200;
  const first = await post('/api/runs', { root, feature: 'demo-feature' });
  assert.equal(first.status, 202);
  const second = await post('/api/runs', { root, feature: 'demo-feature' });
  assert.equal(second.status, 409);
  assert.match(parseError(second.body), /already in progress/);
  await settled(first.body['jobId'] as string);
});

test('cancelling a running job lands as cancelled, and a second cancel is a 409', async () => {
  stageDelayMs = 5000;
  const started = await post('/api/runs', { root, feature: 'demo-feature' });
  const jobId = started.body['jobId'] as string;

  const cancelled = await post(`/api/runs/${jobId}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body['cancelling'], true);

  const view = await settled(jobId);
  assert.equal(view['status'], 'cancelled');
  /* killed, not exited: there is no exit code to report, and inventing 0 or
   * -1 would read as a real result */
  assert.equal(view['exitCode'], null);

  const again = await post(`/api/runs/${jobId}/cancel`, {});
  assert.equal(again.status, 409);
  assert.match(parseError(again.body), /cancelled/);
});

test('a cross-origin mutation is refused', async () => {
  const r = await raw(
    port,
    'POST',
    '/api/runs',
    { 'content-type': 'application/json', origin: 'http://evil.example' },
    JSON.stringify({ root, feature: 'demo-feature' }),
  );
  assert.equal(r.status, 403);
  assert.match(r.body, /cross-origin/);
});

test('a non-loopback Host header is refused (DNS-rebinding armor)', async () => {
  const r = await raw(port, 'GET', '/api/projects', { host: 'attacker.example' });
  assert.equal(r.status, 403);
  assert.match(r.body, /non-loopback host/);
});

test('a run outside the configured workspaces is refused', async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'gov-elsewhere-'));
  try {
    const r = await post('/api/runs', { root: elsewhere, feature: 'whatever' });
    assert.equal(r.status, 403);
    assert.match(parseError(r.body), /not a configured workspace/);
  } finally {
    await rm(elsewhere, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('an unknown feature is a 404', async () => {
  const r = await post('/api/runs', { root, feature: 'no-such-feature' });
  assert.equal(r.status, 404);
});

test('an unknown job id is a 404, and cancelling one is too', async () => {
  assert.equal((await get('/api/runs/no-such-job')).status, 404);
  assert.equal((await post('/api/runs/no-such-job/cancel', {})).status, 404);
});

test('a disabled skill is a 409 whose message says the stage is a gate', async () => {
  const disabled = {
    settings: {
      ...DEFAULT_SETTINGS,
      skills: DEFAULT_SETTINGS.skills.map((s) => (s.stage === 'ask' ? { ...s, enabled: false } : s)),
    },
  };
  const put = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(disabled),
  });
  assert.equal(put.status, 200);

  try {
    const r = await post('/api/runs', { root, feature: 'demo-feature' });
    assert.equal(r.status, 409);
    assert.match(parseError(r.body), /disabled/);
  } finally {
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: DEFAULT_SETTINGS }),
    });
  }
});

/* ---- the dossier, the change request, and the files ----
 *
 * The dossier is the feature's provenance over HTTP; a change request is how
 * "我想把 hello world 改成 heja world" enters the loop — as new requirement
 * input that reopens `ask`, *not* as a ticket, because a ticket is work that has
 * already been specified. All of it reads and writes a real workspace, so it
 * sits beside the run endpoints with the same guards.
 */

test('GET /api/dossier returns the feature record, and refuses foreign roots', async () => {
  const ok = await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=demo-feature`);
  assert.equal(ok.status, 200);
  const d = ok.body as Record<string, unknown>;
  /* A map-kind feature has no session state, so its concept is read from
   * map.md — and named as such. Returning null here (which this test used to
   * require) made "the map opens with the intent" indistinguishable from "this
   * feature has no concept at all". */
  assert.equal(d['idea'], 'Prove the API.');
  assert.equal(d['ideaSource'], 'map');
  assert.equal(d['destination'], 'Prove the API.');
  assert.ok(Array.isArray(d['rounds']));
  assert.ok(Array.isArray(d['timeline']));
  // Where the record lives, so the page can offer to open it.
  assert.equal(d['featureDir'], join(root, '.scratch', 'demo-feature'));

  const missing = await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=absent-feature`);
  assert.equal(missing.status, 404);
  const bad = await get('/api/dossier?root=C:/not-a-workspace&feature=demo-feature');
  assert.equal(bad.status, 403);
});

test('a link or a client written before the rename still names the feature', async () => {
  /* The query parameter moved from `effort` to `feature` along with the word.
   * Anything holding the old spelling — a bookmark, a script, a browser tab
   * left open overnight — would otherwise resolve to "no feature selected",
   * which reads as an empty project rather than a renamed parameter. */
  const old = await get(`/api/dossier?root=${encodeURIComponent(root)}&effort=demo-feature`);
  assert.equal(old.status, 200);
  assert.equal(old.body['featureDir'], join(root, '.scratch', 'demo-feature'),
    'the old parameter names the same feature, not a blank one');

  const now = await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=demo-feature`);
  assert.equal(now.status, 200);
  assert.deepEqual(now.body, old.body,
    'the two spellings answer identically — this is an alias, not a second path');

  // And the new spelling still takes precedence when both are sent.
  const both = await get(
    `/api/dossier?root=${encodeURIComponent(root)}&feature=demo-feature&effort=gated-feature`,
  );
  assert.equal(both.status, 200);
  assert.equal(both.body['featureDir'], join(root, '.scratch', 'demo-feature'));

  /* Same for a request body: a client that posts the old key still gets the
   * run it asked for, rather than a refusal naming a feature it never sent. */
  const posted = await post('/api/runs', { root, effort: 'demo-feature' });
  assert.equal(posted.status, 202, 'the old body key is accepted, not rejected as missing');
  const settledView = await settled(posted.body['jobId'] as string);
  assert.equal(settledView['feature'], 'demo-feature',
    'and the record is written under the new key');
});

test('a change request reopens ask instead of becoming a ticket', async () => {
  /* Baseline first: without a change, this feature's requirements stage is done
   * (its map carries a destination). Capturing it before filing is what makes
   * the assertion after filing mean something. */
  const askStage = async (): Promise<string | undefined> => {
    const projects = (await get('/api/projects')).body as unknown as ProjectsBody;
    return projects.flatMap((p) => p.features).find((e) => e.slug === 'files-feature')?.stages['ask'];
  };
  assert.equal(await askStage(), 'complete');

  const text = 'change the displayed greeting from hello world to heja world';
  const r = await post('/api/change-request', { root, feature: 'files-feature', text });
  assert.equal(r.status, 201);
  const change = (r.body as Record<string, unknown>)['change'] as Record<string, unknown>;
  assert.equal(change['id'], 'CH-01');
  assert.equal(change['text'], text);

  /* The difference that matters: no ticket was cut. A ticket would be work
   * nobody specified — the flow has to grill the change first. */
  const d = (await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=files-feature`)).body;
  // Still exactly the one ticket the feature came with: nothing was cut.
  assert.equal((d['tickets'] as unknown[]).length, 1);
  const changes = d['changes'] as { id: string; text: string; status: string }[];
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.status, 'open');
  assert.equal(changes[0]!.text, text);

  // It is on the record as an event, and it reopens the requirements stage.
  const journal = d['journal'] as { kind: string; ref: string }[];
  assert.ok(journal.some((e) => e.kind === 'change.opened' && e.ref === 'CH-01'));
  const stage = (d['timeline'] as { kind: string }[]).some((e) => e.kind === 'change');
  assert.ok(stage, 'the change belongs on the timeline');

  const projects = (await get('/api/projects')).body as unknown as ProjectsBody;
  const feature = projects.flatMap((p) => p.features).find((e) => e.slug === 'files-feature')!;
  assert.equal(feature.openChanges, 1);
  assert.notEqual(feature.stages['ask'], 'complete', 'an open change reopens ask');

  // A blank change is refused, not silently filed.
  const blank = await post('/api/change-request', { root, feature: 'files-feature', text: '   ' });
  assert.equal(blank.status, 400);
});

test('closing a change is a second journal line, and it must be open to close', async () => {
  /* Filed here rather than reused from the test above: a test that leans on
   * another test's side effect fails in isolation, and then the failure points
   * at the wrong thing. */
  const opened = await post('/api/change-request', {
    root,
    feature: 'files-feature',
    text: 'a change to close',
  });
  const id = ((opened.body as Record<string, unknown>)['change'] as Record<string, unknown>)['id'] as string;

  const closed = await post('/api/change-close', {
    root,
    feature: 'files-feature',
    id,
    note: 'handled by the build stage',
  });
  assert.equal(closed.status, 200);
  assert.equal(
    ((closed.body as Record<string, unknown>)['change'] as Record<string, unknown>)['status'],
    'closed',
  );

  const d = (await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=files-feature`)).body;
  const changes = d['changes'] as { id: string; status: string; note: string | null }[];
  const mine = changes.find((c) => c.id === id)!;
  assert.equal(mine.status, 'closed');
  assert.equal(mine.note, 'handled by the build stage');
  /* Both lines survive: the record is the history of the decision, not its
   * current value. */
  const kinds = (d['journal'] as { kind: string; ref: string }[])
    .filter((e) => e.ref === id)
    .map((e) => e.kind);
  /* The routing decision sits between the two, because it happened between the
   * two: filed, routed, then accepted. A record that folded the routing into the
   * open would lose the fact that it was a separate decision. */
  assert.deepEqual(kinds, ['change.opened', 'change.decided', 'change.closed']);

  const again = await post('/api/change-close', { root, feature: 'files-feature', id });
  assert.equal(again.status, 404, 'a closed change cannot be closed twice');
  const unknown = await post('/api/change-close', { root, feature: 'files-feature', id: 'CH-99' });
  assert.equal(unknown.status, 404);
});

test('a change that adds scope opens its own feature at filing time', async () => {
  /* The routing is not a suggestion here. A change whose words say the scope
   * grew gets a new feature immediately, with a lineage line and a brief — the
   * person who filed it does not get asked to decide what they already said. */
  const text = 'also add a new report page';
  const r = await post('/api/change-request', { root, feature: 'files-feature', text });
  assert.equal(r.status, 201);
  const body = r.body as Record<string, unknown>;
  const change = body['change'] as Record<string, unknown>;
  const verdict = body['verdict'] as Record<string, unknown>;
  const id = change['id'] as string;

  assert.equal(verdict['path'], 'follow-up');
  assert.equal(verdict['kind'], 'extension');
  assert.equal(verdict['rule'], 'new-scope');

  const child = body['child'] as string;
  assert.equal(child, `files-feature-${id.toLowerCase()}`);
  assert.equal(change['status'], 'closed', 'the parent is done with it, not holding it');

  /* The parent keeps the pointer. Without it the change looks dropped: closed,
   * with nothing anywhere saying where the work went. */
  const d = (await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=files-feature`)).body;
  const mine = (d['changes'] as { id: string; outcome: string | null; followedUpBy: string | null }[])
    .find((c) => c.id === id)!;
  assert.equal(mine.outcome, 'followed-up');
  assert.equal(mine.followedUpBy, child);

  // Closing it again is refused: it is already closed, by handoff.
  const again = await post('/api/change-close', { root, feature: 'files-feature', id });
  assert.equal(again.status, 404);

  /* The child is a real feature with nothing but a reason: no spec, no tickets,
   * no pre-filled destination. Those are the flow's output, not its input. */
  const projects = (await get('/api/projects')).body as unknown as ProjectsBody;
  const derived = projects.flatMap((p) => p.features).find((e) => e.slug === child);
  assert.ok(derived, 'the child feature is visible to the scanner');
  assert.deepEqual(derived.derivedFrom, { parent: 'files-feature', change: id, text });
  assert.equal(derived.stages['intake'], 'active', 'it starts at intake, on nothing');

  const inherited = await readFile(join(root, '.scratch', child, 'INHERITED.md'), 'utf8');
  assert.ok(inherited.includes(text), 'the brief quotes the change verbatim');
  assert.ok(inherited.includes('files-feature/spec.md'), 'it names the parent artifacts to read');
  assert.ok(/not an? (?:continuation|record)/i.test(inherited) || inherited.includes('**input**'));
});

test('under AFK a filed change lights the first stage itself', async () => {
  /* The ignition that was missing. Before this, filing a change reopened
   * requirements and then waited for somebody to notice — which is what "the
   * change did not continue" actually was: not a chain that broke, but one that
   * was never started. With AFK off nothing may start; with it on, the operator
   * has already said run unattended. */
  const before = await readSettings(settingsFile);
  await writeSettings(
    { ...before.settings, automation: { ...before.settings.automation, afk: true } },
    settingsFile,
  );
  let opened: Record<string, unknown> = {};
  try {
    const r = await post('/api/change-request', {
      root,
      feature: 'files-feature',
      text: 'the footer should say 2026',
    });
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    opened = body['change'] as Record<string, unknown>;
    const started = body['started'] as string[];
    assert.equal(started.length, 1, 'AFK lights one run, on the feature that changed');
    assert.equal((body['verdict'] as Record<string, unknown>)['path'], 'in-place');

    await settled(started[0]!);

    /* And the loop accepts what it just answered: a succeeded requirements run
     * closes the change that was open going into it, with the run named, so the
     * record can always say who decided. */
    const d = (await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=files-feature`)).body;
    const mine = (d['changes'] as { id: string; status: string; note: string | null }[])
      .find((c) => c.id === opened['id'])!;
    assert.equal(mine.status, 'closed');
    assert.match(String(mine.note), /AFK accepted this/);
  } finally {
    await writeSettings(before.settings, settingsFile);
  }
});

test('GET /api/file reads an artifact inside the feature, and refuses to escape it', async () => {
  const read = async (p: string) =>
    await get(`/api/file?root=${encodeURIComponent(root)}&feature=files-feature&path=${encodeURIComponent(p)}`);

  const ok = await read('docs/adr/0001-first.md');
  assert.equal(ok.status, 200);
  const f = ok.body as Record<string, unknown>;
  assert.equal(f['lang'], 'markdown');
  assert.match(String(f['text']), /^# ADR 0001/);
  assert.equal(f['tooLarge'], false);
  assert.equal(f['binary'], false);

  /* The dossier carries the path of every artifact, so the page never has to
   * guess where a file lives — this is the join between the two. */
  const d = (await get(`/api/dossier?root=${encodeURIComponent(root)}&feature=files-feature`)).body;
  const adrs = d['adrs'] as { file: string }[];
  assert.equal(adrs[0]!.file, 'docs/adr/0001-first.md');
  assert.equal((d['spec'] as Record<string, unknown>)['path'], 'spec.md');
  assert.equal((d['glossary'] as Record<string, unknown>)['path'], 'GLOSSARY.md');

  /* The guard that makes this safe to put on a page: `..` is resolved and then
   * refused, so the reader is confined to the feature it belongs to. */
  const escape = await read('../../../package.json');
  assert.equal(escape.status, 400);
  assert.match(parseError(escape.body), /escapes the feature/);

  const absent = await read('nope.md');
  assert.equal(absent.status, 404);

  const foreign = await get('/api/file?root=C:/not-a-workspace&feature=files-feature&path=spec.md');
  assert.equal(foreign.status, 403);
});

test('POST /api/reveal names a verb, never a command', async () => {
  const bad = await post('/api/reveal', { root, feature: 'files-feature', mode: 'rm -rf /' });
  assert.equal(bad.status, 400);
  assert.match(parseError(bad.body), /mode must be/);

  const escape = await post('/api/reveal', {
    root,
    feature: 'files-feature',
    mode: 'folder',
    path: '../../..',
  });
  assert.equal(escape.status, 400);

  const foreign = await post('/api/reveal', {
    root: 'C:/not-a-workspace',
    feature: 'files-feature',
    mode: 'folder',
  });
  assert.equal(foreign.status, 403);

  /* A real launch is not asserted here: it would open a window on whatever
   * machine runs the suite. What is asserted is that a valid request is
   * answered by the launcher (200) or reported as unavailable (501) — never a
   * 400 from the guard, and never a 500. */
  const ok = await post('/api/reveal', { root, feature: 'files-feature', mode: 'folder' });
  assert.ok([200, 501].includes(ok.status), `unexpected status ${ok.status}`);
  assert.equal((ok.body as Record<string, unknown>)['target'], join(root, '.scratch', 'files-feature'));

  // The project scope reaches the workspace, which is also a configured root.
  const project = await post('/api/reveal', {
    root,
    feature: 'files-feature',
    mode: 'folder',
    scope: 'project',
  });
  assert.ok([200, 501].includes(project.status));
  assert.equal((project.body as Record<string, unknown>)['target'], root);

  /* The guard is an allowlist, and its character class must cover the
   * characters real paths carry. Temp dirs on Windows are 8.3-shortened
   * (ADMINI~1), so nearly every path on a dev machine contains `~` — refusing
   * it made "Open in VS Code" dead on exactly the setups that use the app. */
  const tilde = await post('/api/reveal', { root, feature: 'files-feature', mode: 'vscode' });
  assert.ok(
    [200, 501].includes(tilde.status),
    `a path containing ~ must pass the guard, got ${tilde.status}`,
  );

  // And the guard still refuses what cmd.exe would treat as syntax. A real
  // directory named with `&` proves the check fires on the resolved target.
  const shellDir = join(root, '.scratch', 'files-feature', 'a&b');
  await mkdir(shellDir, { recursive: true });
  const ampersand = await post('/api/reveal', {
    root,
    feature: 'files-feature',
    mode: 'vscode',
    path: 'a&b',
  });
  assert.equal(ampersand.status, 400);
  assert.match(parseError(ampersand.body), /not safe/);
});
