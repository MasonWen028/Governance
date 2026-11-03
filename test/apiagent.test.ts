import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { apiRunner, probeApi, skillPathsIn } from '../src/exec/apiagent.js';
import { parseSettings } from '../src/config/settings.js';

/**
 * The API transport.
 *
 * The seam contract is shared with the CLI runner, so the cases here mirror the
 * ones that matter there: a turn either continues a conversation or it fails;
 * writes stay inside the feature; a key problem is reported as authentication,
 * not as "cannot run".
 */

type FetchCall = { url: string; body: Record<string, unknown> };

interface Harness {
  calls: FetchCall[];
  fetchFn: typeof fetch;
  respond: (fn: (call: FetchCall, n: number) => { status?: number; json: unknown }) => void;
}

function harness(): Harness {
  const calls: FetchCall[] = [];
  let responder: ((call: FetchCall, n: number) => { status?: number; json: unknown }) | null = null;
  const fetchFn = (async (url: unknown, init?: { body?: string }) => {
    const call: FetchCall = {
      url: String(url),
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    const n = calls.length;
    calls.push(call);
    const r = responder
      ? responder(call, n)
      : { status: 200, json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } };
    return {
      ok: (r.status ?? 200) === 200,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.json),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    fetchFn,
    respond: (fn) => {
      responder = fn;
    },
  };
}

function runner(h: Harness, opts: { key?: string | undefined } = {}) {
  return apiRunner({
    apiBase: 'https://api.test',
    model: 'test-model',
    maxTokens: 1024,
    apiKey: () => ('key' in opts ? opts.key : 'sk-test'),
    fetchFn: h.fetchFn,
    idFactory: (() => {
      let n = 0;
      return () => `api-test-${String(++n)}`;
    })(),
  });
}

function toolUse(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input };
}

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gov-apiagent-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a first turn inlines the skill file into the system block', async () => {
  const skill = join(dir, 'skills', 'grill-with-docs', 'SKILL.md');
  await mkdir(join(dir, 'skills', 'grill-with-docs'), { recursive: true });
  await writeFile(skill, 'FOLLOW THIS PROTOCOL MARKER', 'utf8');

  const h = harness();
  const r = runner(h);
  const prompt = `Read the skill at ${skill} and follow it.\nWork in ${dir}.`;
  const res = await r.run({
    prompt,
    sessionId: null,
    cwd: dir,
    logPath: join(dir, 'turn.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });

  assert.equal(res.ok, true);
  assert.match(res.sessionId ?? '', /^api-test-1$/);
  const system = String(h.calls[0]?.body.system ?? '');
  assert.match(system, /FOLLOW THIS PROTOCOL MARKER/);
  assert.match(system, /Working directory/);
  assert.equal(h.calls[0]?.url, 'https://api.test/v1/messages');
  // 'inherit' resolves to the configured model, not the literal string.
  assert.equal(h.calls[0]?.body.model, 'test-model');
});

test('tool calls write artifacts, and the conversation persists for the next round', async () => {
  const feature = join(dir, 'feature-a');
  await mkdir(feature, { recursive: true });
  const h = harness();
  h.respond((_call, n) => {
    if (n === 0) {
      return {
        json: {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me record the round.' },
            toolUse('t1', 'write_file', {
              path: '.session/01.json',
              content: '{"round":1,"kind":"questions","questions":[]}',
            }),
            toolUse('t2', 'write_file', {
              path: '.session/latest.json',
              content: '{"round":1,"kind":"questions","questions":[]}',
            }),
          ],
        },
      };
    }
    return { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Round asked.' }] } };
  });

  const r = runner(h);
  const res = await r.run({
    prompt: 'ask round 1',
    sessionId: null,
    cwd: feature,
    logPath: join(feature, 'turns', '1.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });

  assert.equal(res.ok, true);
  assert.match(res.output, /Round asked\./);

  const artifact = await readFile(join(feature, '.session', '01.json'), 'utf8');
  assert.match(artifact, /"kind":\s*"questions"/);
  await readFile(join(feature, '.session', 'latest.json'), 'utf8');
  const hist = await readFile(
    join(feature, '.session', 'api-history', `${res.sessionId}.json`),
    'utf8',
  );
  assert.match(hist, /ask round 1/);

  // Round 2 replays the history: the prior prompt and reply must both travel.
  const res2 = await r.run({
    prompt: 'human answered',
    sessionId: res.sessionId,
    cwd: feature,
    logPath: join(feature, 'turns', '2.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.sessionId, res.sessionId);
  // Run 1 made two calls (tool round-trip + final), so run 2's request is the third.
  const sent = h.calls[2]?.body.messages as { role: string; content: unknown }[];
  const texts = sent.map((m) => (typeof m.content === 'string' ? m.content : ''));
  assert.ok(texts.some((t) => t.includes('ask round 1')), 'the first prompt is replayed');
  assert.ok(texts.some((t) => t.includes('human answered')), 'the new prompt is appended');
});

test('a write outside the feature is refused, and the refusal reaches the model', async () => {
  const feature = join(dir, 'feature-b');
  await mkdir(feature, { recursive: true });
  const h = harness();
  h.respond((_call, n) => {
    if (n === 0) {
      return {
        json: {
          stop_reason: 'tool_use',
          content: [toolUse('t1', 'write_file', { path: '../escaped.txt', content: 'no' })],
        },
      };
    }
    return { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'understood' }] } };
  });

  const r = runner(h);
  const res = await r.run({
    prompt: 'try to escape',
    sessionId: null,
    cwd: feature,
    logPath: join(feature, 'turn.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });

  // The turn itself completes; the escape does not.
  assert.equal(res.ok, true);
  await assert.rejects(readFile(join(dir, 'escaped.txt'), 'utf8'));
  const toolResults = (
    h.calls[1]?.body.messages as { role: string; content: { is_error?: boolean }[] }[]
  ).find((m) => m.role === 'user' && Array.isArray(m.content));
  assert.equal(toolResults?.content[0]?.is_error, true);
});

test('a 401 is reported as authentication, not as "cannot run"', async () => {
  const h = harness();
  h.respond(() => ({ status: 401, json: { error: { message: 'authentication_error: invalid key' } } }));
  const res = await runner(h).run({
    prompt: 'hello',
    sessionId: null,
    cwd: dir,
    logPath: join(dir, 'turn.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /401/);
});

test('a missing key fails before any call is made', async () => {
  const h = harness();
  const res = await runner(h, { key: undefined }).run({
    prompt: 'hello',
    sessionId: null,
    cwd: dir,
    logPath: join(dir, 'turn.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /API key/);
  assert.equal(h.calls.length, 0);
});

test('a turn whose history cannot be continued is a failure', async () => {
  const h = harness();
  const res = await runner(h).run({
    prompt: 'continue',
    sessionId: 'api-gone',
    cwd: dir,
    logPath: join(dir, 'turn.log'),
    timeoutMs: 5000,
    model: 'inherit',
    allowedTools: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /conversation/);
  assert.equal(h.calls.length, 0);
});

test('probeApi: no key is not-authenticated; a 200 is ok; a 401 is not', async () => {
  const missing = await probeApi({
    apiBase: 'https://api.test',
    model: 'test-model',
    apiKeyEnv: 'GOV_TEST_KEY_MISSING',
    apiKey: () => undefined,
    fetchFn: harness().fetchFn,
  });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'not-authenticated');

  const h = harness();
  const ok = await probeApi({
    apiBase: 'https://api.test',
    model: 'test-model',
    apiKeyEnv: 'GOV_TEST_KEY',
    apiKey: () => 'sk-test',
    fetchFn: h.fetchFn,
  });
  assert.equal(ok.available, true);
  assert.equal(ok.reason, 'ok');

  const h2 = harness();
  h2.respond(() => ({ status: 401, json: { error: { message: 'authentication_error' } } }));
  const bad = await probeApi({
    apiBase: 'https://api.test',
    model: 'test-model',
    apiKeyEnv: 'GOV_TEST_KEY',
    apiKey: () => 'sk-test',
    fetchFn: h2.fetchFn,
  });
  assert.equal(bad.available, false);
  assert.equal(bad.reason, 'not-authenticated');
});

test('settings: the api fields parse, default, and clamp', () => {
  const d = parseSettings({}).settings.agents;
  assert.equal(d.transport, 'cli');
  assert.equal(d.apiBase, 'https://api.anthropic.com');
  assert.equal(d.apiModel, 'claude-sonnet-4-5');
  assert.equal(d.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(d.apiMaxTokens, 8192);

  const p = parseSettings({
    agents: { transport: 'api', apiMaxTokens: 1, apiBase: 'https://gw.internal' },
  }).settings.agents;
  assert.equal(p.transport, 'api');
  assert.equal(p.apiBase, 'https://gw.internal');
  assert.equal(p.apiMaxTokens, 256, 'below the floor clamps to it');

  const bad = parseSettings({ agents: { transport: 'carrier-pigeon' } }).settings.agents;
  assert.equal(bad.transport, 'cli', 'an unknown transport falls back to the default');
});

test('skillPathsIn deduplicates and keeps order', () => {
  const paths = skillPathsIn(
    'Read the skill at /a/SKILL.md and follow it. Also /b/SKILL.md and /a/SKILL.md again.',
  );
  assert.deepEqual(paths, ['/a/SKILL.md', '/b/SKILL.md']);
});
