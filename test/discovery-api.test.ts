import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { serve } from '../src/server/http.js';
import { DEFAULT_SETTINGS, writeSettings } from '../src/config/settings.js';

/* The discovery endpoints, over a real socket, with a scripted runner.
 *
 * Discovery spawns an agent three times, so this is the second surface that can
 * spend money on an HTTP caller — and unlike a stage run it is handed a
 * directory the caller supplies. Every test injects its own runner. A suite that
 * called the real CLI would be a suite that paid for itself on every run, and
 * the thing under test here is the plumbing, not the model. */

let base: string;
let port: number;
let settingsFile: string;
let workspacesFile: string;
const stop = new AbortController();
/** What the injected runner does, per phase. Set per test. */
let script: ((prompt: string) => { ok: boolean; error?: string }) | null = null;
/** Held while a pass "runs", so a test can observe the job mid-flight. */
let hold: Promise<void> | null = null;
/** Prompts the runner received, in order. */
const seen: string[] = [];

const STUB = {
  run: async (turn: { prompt: string; cwd: string }) => {
    seen.push(turn.prompt);
    if (hold !== null) await hold;
    const step = script?.(turn.prompt) ?? { ok: true };
    if (!step.ok) {
      return {
        ok: false, sessionId: null, output: '',
        error: step.error ?? 'the agent refused', ms: 1, phase: 'exit' as const,
      };
    }
    /* Leave something real on disk, so `producedFiles` has to read the disk
     * rather than echo the plan back. */
    await mkdir(join(turn.cwd, 'docs', 'discovery', 'domain'), { recursive: true });
    await writeFile(
      join(turn.cwd, 'docs', 'discovery', 'domain', 'domain-model.md'),
      '# domain\n',
      'utf8',
    );
    return { ok: true, sessionId: null, output: 'done', error: null, ms: 1, phase: null };
  },
};

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-discovery-api-'));
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
    runner: STUB, signal: stop.signal });
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
  hold = null;
  stop.abort();
});

async function settled(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i += 1) {
    const r = await fetch(`${base}/api/discover?jobId=${encodeURIComponent(jobId)}`);
    const body = (await r.json()) as Record<string, unknown>;
    if (body['status'] !== 'running') return body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('the discovery never settled');
}

async function start(target: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('POST /api/discover accepts the three passes and reports them pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-start-'));
  script = () => ({ ok: true });
  try {
    const { status, body } = await start(dir);
    assert.equal(status, 202, 'accepted, not finished');
    assert.equal(typeof body['jobId'], 'string');
    assert.equal(body['target'], dir);
    /* The skill is chosen, not assumed: whatever reads codebases on this
     * machine, named so the human can see who was asked. */
    assert.ok((body['skill'] as string).length > 0, 'no reader was named');
    const phases = body['phases'] as { id: string; status: string }[];
    assert.deepEqual(phases.map((p) => p.id), ['discovery', 'architecture', 'feature-mapping']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the passes run in order, and the files shown are the ones on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-run-'));
  seen.length = 0;
  script = () => ({ ok: true });
  try {
    const started = await start(dir);
    const job = await settled(started.body['jobId'] as string);
    assert.equal(job['status'], 'succeeded');
    const phases = job['phases'] as { id: string; status: string }[];
    assert.deepEqual(phases.map((p) => p.status), ['succeeded', 'succeeded', 'succeeded']);

    // Three turns, one per pass, in the order the human named them.
    assert.equal(seen.length, 3);
    assert.ok(seen[0]!.includes('discovery'), 'the first pass is not discovery');
    assert.ok(seen[2]!.includes('feature-mapping'), 'the last pass is not feature mapping');

    /* Read back from disk, not from the plan: the stub wrote one file, so the
     * display shows one file — not the four the passes were expected to write. */
    const files = job['files'] as { path: string }[];
    assert.deepEqual(files.map((f) => f.path), ['docs/discovery/domain/domain-model.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed pass stops the ones after it instead of building on a gap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-fail-'));
  seen.length = 0;
  script = (prompt) =>
    prompt.includes('architecture') ? { ok: false, error: 'the agent refused' } : { ok: true };
  try {
    const started = await start(dir);
    const job = await settled(started.body['jobId'] as string);
    assert.equal(job['status'], 'failed');
    assert.ok(String(job['error']).includes('the agent refused'));
    const phases = job['phases'] as { id: string; status: string; error: string | null }[];
    /* The point of stopping: architecture failed, so feature mapping never ran.
     * Running it anyway would map features onto a map that does not exist. */
    assert.deepEqual(phases.map((p) => p.status), ['succeeded', 'failed', 'pending']);
    assert.equal(phases[1]!.error, 'the agent refused');
    assert.equal(seen.length, 2, 'the third pass must not have been asked for');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discovery refuses a target that is not a directory, and a relative path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-refuse-'));
  const file = join(dir, 'a-file.txt');
  await writeFile(file, 'x', 'utf8');
  try {
    assert.equal((await start(file)).status, 404, 'a file is not a codebase');
    assert.equal((await start('relative/path')).status, 400, 'a relative path is refused');
    assert.equal((await start('')).status, 400, 'an empty target is refused');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second discovery on the same folder is refused while the first runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-busy-'));
  script = () => ({ ok: true });
  let release: () => void = () => undefined;
  /* The first pass blocks, so the job is provably still running when the second
   * request arrives. Without this the 409 would be a race the test only
   * sometimes won. */
  hold = new Promise<void>((done) => {
    release = done;
  });
  let first: { status: number; body: Record<string, unknown> } | null = null;
  try {
    first = await start(dir);
    assert.equal(first.status, 202);
    const second = await start(dir);
    assert.equal(second.status, 409, 'two agents writing one set of docs must not both start');
    assert.equal(typeof second.body['jobId'], 'string', 'the refusal names the job that is running');
  } finally {
    release();
    hold = null;
    /* Let the first job finish writing before the directory is taken away.
     * Removing it while the passes are still running is a race the cleanup
     * loses — ENOTEMPTY, from an agent that was only ever told to write. */
    if (first !== null) await settled(first.body['jobId'] as string).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a skill that is not installed is refused rather than run without it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-noskill-'));
  try {
    const r = await fetch(`${base}/api/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: dir, skill: 'no-such-skill-anywhere' }),
    });
    /* This is the one failure here that costs real money to discover: the agent
     * would start, find no file at that path, and write a plausible analysis
     * instead — which is worse than an error, because it looks like it worked. */
    assert.equal(r.status, 400, 'a missing skill must not cost a run to find out');
    const body = (await r.json()) as { error: string };
    assert.ok(/not installed/i.test(body.error));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown job says the jobs are in memory, so a restart is not read as a typo', async () => {
  const r = await fetch(`${base}/api/discover?jobId=nope`);
  assert.equal(r.status, 404);
  const body = (await r.json()) as { error: string };
  assert.ok(/do not survive a restart/i.test(body.error));
  const missing = await fetch(`${base}/api/discover`);
  assert.equal(missing.status, 400);
});

test('a running discovery is visible while it runs, and stops being live when it ends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-disc-visible-'));
  script = () => ({ ok: true });
  try {
    const { body } = await start(dir);
    const jobId = String(body['jobId']);

    /* The whole point of the activity record: while the passes run there is an
     * answer to "what is it doing", and it names the target and the pass. */
    const during = (await (await fetch(`${base}/api/activity`)).json()) as {
      running: number;
      items: { kind: string; label: string; status: string; target: string | null }[];
    };
    const one = during.items.find((x) => x.kind === 'discovery');
    assert.ok(one !== undefined, 'the read is not visible while it runs');
    assert.equal(one.status, 'running');
    assert.equal(one.target, resolve(dir), 'the record says which project it is reading');

    const done = await settled(jobId);
    assert.equal(done['status'], 'succeeded');

    const after = (await (await fetch(`${base}/api/activity`)).json()) as {
      running: number;
      items: { kind: string; status: string }[];
    };
    const same = after.items.find((x) => x.kind === 'discovery');
    assert.equal(same?.status, 'succeeded', 'it did not stop being reported as running');
    assert.equal(after.running, 0, 'nothing is still counted as running');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
