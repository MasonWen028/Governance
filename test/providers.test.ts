import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  DEFAULT_SETTINGS,
  parseSettings,
  resolveAgentFor,
} from '../src/config/settings.js';
import { adapterFor, claudeAdapter, opencodeAdapter } from '../src/exec/adapters.js';
import { classifyTurnFailure, probeCli } from '../src/exec/agent.js';
import type { AgentTurn } from '../src/exec/agent.js';
import type { ResolvedCli } from '../src/exec/resolve.js';

/**
 * The provider architecture: default executor, migration, per-role overrides,
 * and the two CLI adapters. The rule under test everywhere is that a
 * configuration is either honoured exactly or refused loudly — never silently
 * reinterpreted.
 */

function turn(partial: Partial<AgentTurn> = {}): AgentTurn {
  return {
    prompt: 'do the thing',
    sessionId: null,
    cwd: '/tmp/feature',
    logPath: '/tmp/feature/runs/x.log',
    timeoutMs: 1000,
    model: '',
    allowedTools: [],
    ...partial,
  };
}

/* ------------------------------------------------------------- defaults */

test('a fresh install defaults to OpenCode, with Claude present but off', () => {
  const s = parseSettings({}).settings;
  assert.equal(s.agents.cli, 'opencode');
  assert.equal(s.agents.providers.opencode?.enabled, true);
  assert.equal(s.agents.providers.claude?.enabled, false);
  /* No vendor is assumed: an empty provider and model mean "whatever OpenCode
   * itself is configured with". */
  assert.equal(s.agents.providers.opencode?.provider, '');
  assert.equal(s.agents.providers.opencode?.model, '');
});

test('a settings file with an agents block but no cli keeps Claude (migration)', () => {
  /* This file was written when claude was the implicit default. Keeping it is
   * "preserve the user's executor choice", not "default to Claude". */
  const legacy = parseSettings({ agents: { maxParallel: 6 } });
  assert.equal(legacy.settings.agents.cli, 'claude');
  assert.equal(legacy.settings.agents.maxParallel, 6);

  /* An explicit choice survives verbatim, in both directions. */
  assert.equal(parseSettings({ agents: { cli: 'opencode' } }).settings.agents.cli, 'opencode');
  assert.equal(parseSettings({ agents: { cli: 'claude' } }).settings.agents.cli, 'claude');
});

test('an apiKey VALUE in a provider entry is refused, not stored', () => {
  const { settings, warnings } = parseSettings({
    agents: { providers: { opencode: { apiKey: 'sk-secret-value' } } },
  });
  assert.ok(warnings.some((w) => w.includes('refusing it')));
  const dumped = JSON.stringify(settings);
  assert.ok(!dumped.includes('sk-secret-value'), 'the key must not survive into the parsed settings');
  /* The safe field survives and defaults. */
  assert.equal(settings.agents.providers.opencode?.apiKeyEnv, 'OPENCODE_API_KEY');
});

test('a roleAgents entry carrying an apiKey is refused too', () => {
  const { warnings } = parseSettings({
    agents: { roleAgents: { qa: { cli: 'opencode', apiKey: 'sk-x' } } },
  });
  assert.ok(warnings.some((w) => w.includes('refusing it')));
});

/* ----------------------------------------------------------- resolution */

test('resolution: role > global > provider defaults', () => {
  const s = parseSettings({
    agents: {
      cli: 'opencode',
      providers: { opencode: { provider: 'ollama', model: 'qwen3-coder' } },
      roleAgents: {
        qa: { cli: 'claude', model: '', provider: '', baseUrl: '' },
        tech: { cli: 'opencode', model: 'deepseek-v3', provider: '', baseUrl: '' },
        ops: { cli: 'inherit', model: 'inherit', provider: '', baseUrl: '' },
      },
    },
  }).settings;

  /* Global: provider + model merge into OpenCode's provider/model form. */
  const global = resolveAgentFor(s);
  assert.equal(global.cli, 'opencode');
  assert.equal(global.model, 'ollama/qwen3-coder');

  /* A role that switches CLI takes that CLI's own defaults: Claude falls back
   * to sonnet when nothing names a model, exactly as it always did. */
  const qa = resolveAgentFor(s, 'qa');
  assert.equal(qa.cli, 'claude');
  assert.equal(qa.model, 'sonnet');

  /* A role model already in provider/model form passes through untouched;
   * a bare role model inherits the global provider as its namespace. */
  const tech = resolveAgentFor(s, 'tech');
  assert.equal(tech.model, 'ollama/deepseek-v3');

  /* `inherit` falls through to the global config. */
  const ops = resolveAgentFor(s, 'ops');
  assert.equal(ops.cli, 'opencode');
  assert.equal(ops.model, 'ollama/qwen3-coder');

  /* An unset role uses the global config. */
  assert.equal(resolveAgentFor(s, 'security').cli, 'opencode');
});

test('a model already in provider/model form is not double-prefixed', () => {
  const s = parseSettings({
    agents: {
      cli: 'opencode',
      providers: { opencode: { provider: 'ollama', model: 'ollama/qwen3-coder' } },
    },
  }).settings;
  assert.equal(resolveAgentFor(s).model, 'ollama/qwen3-coder');
});

test('an empty model means the CLI decides; no vendor is assumed', () => {
  const s = parseSettings({ agents: { cli: 'opencode' } }).settings;
  const r = resolveAgentFor(s);
  assert.equal(r.model, '');
  assert.equal(r.provider, '');
  /* Ollama with no key is a valid configuration, not an error. */
  const local = parseSettings({
    agents: {
      cli: 'opencode',
      providers: { opencode: { provider: 'ollama', apiKeyEnv: '' } },
    },
  }).settings;
  assert.equal(resolveAgentFor(local).apiKeyEnv, '');
});

test('baseUrl override travels from the role level', () => {
  const s = parseSettings({
    agents: {
      cli: 'opencode',
      providers: { opencode: { baseUrl: 'http://127.0.0.1:11434' } },
      roleAgents: { security: { cli: 'opencode', model: '', provider: '', baseUrl: 'http://other:11434' } },
    },
  }).settings;
  assert.equal(resolveAgentFor(s).baseUrl, 'http://127.0.0.1:11434');
  assert.equal(resolveAgentFor(s, 'security').baseUrl, 'http://other:11434');
});

/* ------------------------------------------------------------ adapters */

test('opencode argv: flags first, prompt as ONE argument, no shell anywhere', () => {
  const hostile = 'do the thing; rm -rf / && echo "`whoami`" | sh';
  const argv = opencodeAdapter.turnArgs(turn({ prompt: hostile, model: 'ollama/qwen3-coder' }));
  assert.deepEqual(argv, [
    'run', '--format', 'json', '--standalone', '--auto',
    '--model', 'ollama/qwen3-coder',
    hostile,
  ]);
  /* The prompt is one array element — it can never be read as syntax. */
  assert.equal(argv[argv.length - 1], hostile);

  /* Resume continues the same session; an empty model omits --model entirely. */
  const resume = opencodeAdapter.turnArgs(turn({ sessionId: 'ses_abc', model: '' }));
  assert.ok(resume.includes('--session'));
  assert.ok(resume.includes('ses_abc'));
  assert.ok(!resume.includes('--model'));
});

test('claude argv keeps acceptEdits, allowedTools and resume', () => {
  const argv = claudeAdapter.turnArgs(
    turn({ model: 'sonnet', sessionId: 's1', allowedTools: ['Read', 'Edit'] }),
  );
  assert.ok(argv.includes('--permission-mode'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(argv.includes('--resume'));
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Edit');
  assert.ok(!argv.includes('--model"'), 'no quoting games');
  /* An empty model omits the flag rather than passing garbage. */
  assert.ok(!claudeAdapter.turnArgs(turn({ model: '' })).includes('--model'));
});

test('opencode parse: NDJSON events yield sessionID, text and errors', () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"ses_4947","part":{"type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"ses_4947","part":{"type":"text","text":"Round asked."}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"ses_4947","part":{"type":"step-finish","reason":"stop"}}',
  ].join('\n');
  const parsed = opencodeAdapter.parse(ndjson);
  assert.equal(parsed.sessionId, 'ses_4947');
  assert.equal(parsed.message, 'Round asked.');
  assert.equal(parsed.isError, false);

  const failure = opencodeAdapter.parse(
    '{"type":"error","sessionID":"ses_x","error":{"name":"APIError","data":{"message":"No payment method (401)"}}}',
  );
  assert.equal(failure.isError, true);
  assert.match(failure.message, /401/);

  /* An empty stream is not an error; it is nothing. */
  const empty = opencodeAdapter.parse('');
  assert.equal(empty.sessionId, null);
  assert.equal(empty.isError, false);
});

test('opencode parse: the real 2.2.1 event stream, captured 2026-10-30', () => {
  /* Verbatim stdout of `opencode run --format json "Reply with exactly: PONG"`
   * against the desktop-bundled CLI v2.2.1 (--standalone). This is the
   * contract the adapter was written against, now locked against reality:
   * every event carries a top-level sessionID; the reply text sits at
   * part.text; there is no closing envelope — the stream just ends. */
  const ndjson = [
    '{"type":"step_start","timestamp":1793322097684,"sessionID":"ses_e75ac6d16ffeJBXh8lp7zoAJnS","part":{"id":"prt_18a539c14001o9BqC6G0q5ED0U","sessionID":"ses_e75ac6d16ffeJBXh8lp7zoAJnS","messageID":"msg_18a539578001q5n8Cj0jNEvkNK","type":"step-start"}}',
    '{"type":"text","timestamp":1793322098103,"sessionID":"ses_e75ac6d16ffeJBXh8lp7zoAJnS","part":{"id":"prt_18a539578001q5n8Cj0jNEvkNK_text-0","sessionID":"ses_e75ac6d16ffeJBXh8lp7zoAJnS","messageID":"msg_18a539578001q5n8Cj0jNEvkNK","type":"text","text":"PONG","time":{"start":1793322096081,"end":1793322098103}}}',
  ].join('\n');
  const parsed = opencodeAdapter.parse(ndjson);
  assert.equal(parsed.sessionId, 'ses_e75ac6d16ffeJBXh8lp7zoAJnS');
  assert.equal(parsed.message, 'PONG');
  assert.equal(parsed.isError, false);
});

test('opencode parse: real 2.2.1 error events captured 2026-10-30', () => {
  /* Both captured from real failing turns. Two facts the fixtures lock:
   * errors travel on STDOUT as NDJSON (not stderr), and the message sits at
   * error.message — the error.data.message shape the 1.x docs described is
   * gone from 2.2.1. */

  /* A nonexistent model: exit 1, one error event. */
  const noRoute =
    '{"type":"error","timestamp":1793322810140,"sessionID":"ses_e75a1873effezhP9hyVGtX0ZPA","error":{"type":"provider.no-route","message":"Model unavailable: nonexistent/nope-model"}}';
  const parsedRoute = opencodeAdapter.parse(noRoute);
  assert.equal(parsedRoute.isError, true);
  assert.match(parsedRoute.message, /Model unavailable/);

  /* A throttled default model: status 429 and a nested provider body. */
  const freeLimit =
    '{"type":"error","timestamp":1793322813200,"sessionID":"ses_doesnotexist0000","error":{"type":"provider.free-limit","message":"Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.","status":429,"retryAfterMs":81988000}}';
  const parsedLimit = opencodeAdapter.parse(freeLimit);
  assert.equal(parsedLimit.isError, true);
  assert.match(parsedLimit.message, /Free usage limit/);
});

test('classifyTurnFailure: the real 2.2.1 free-limit text is rate-limited', () => {
  /* Before 2026-10-30 this text fell through to `unknown`: the regex knew
   * `rate limit` and `429`, but the live message says "Free usage limit". */
  const { reason } = classifyTurnFailure(
    'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.',
  );
  assert.equal(reason, 'rate-limited');
});

test('classifyTurnFailure: the real 2.2.1 auth-rejection text is not-authenticated', () => {
  /* Captured live 2026-10-30 by planting a bogus DeepSeek key through
   * `opencode auth import` in an isolated XDG environment — the only way to
   * make the CLI produce a genuine 401 without touching the real credential.
   * The message matches none of the older phrases: it says "Authentication
   * Fails" (not authentication_error), the word 401 lives in a sibling field,
   * and "api key" is separated from "invalid" by the masked key. Before the
   * fix this classified as `unknown`. */
  const line =
    '{"type":"error","timestamp":1793342277582,"sessionID":"ses_e74787e4cffeQywVkOMfkbEf3z","error":{"type":"provider.auth","message":"Authentication Fails, Your api key: ****0000 is invalid (request_id: 7c9c50fd-576a-4c6e-a69b-751172241dca)","status":401,"response":{"body":"{\\"error\\":{\\"message\\":\\"Authentication Fails, Your api key: ****0000 is invalid (request_id: 7c9c50fd-576a-4c6e-a69b-751172241dca)\\",\\"type\\":\\"authentication_error\\",\\"param\\":null,\\"code\\":\\"invalid_request_error\\"}}"}}}';
  const parsed = opencodeAdapter.parse(line);
  assert.equal(parsed.isError, true);
  assert.match(parsed.message, /Authentication Fails/);
  // The path the probe actually takes: the adapter-extracted message, not the
  // full line. Both must classify — the line happens to carry 401, the message
  // carries none of the old signals.
  assert.equal(classifyTurnFailure(parsed.message).reason, 'not-authenticated');
  assert.equal(classifyTurnFailure(line).reason, 'not-authenticated');
});

test('an unknown cli id falls back to the Claude adapter, as it always did', () => {
  assert.equal(adapterFor('codex-future').id, 'claude');
  assert.equal(adapterFor('opencode').id, 'opencode');
});

/* --------------------------------------------------------------- probe */

type FakeResult = { code: number; out: string; err: string };

function fakeSpawn(script: (args: readonly string[]) => FakeResult): typeof import('node:child_process').spawn {
  return ((_cmd: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    const r = script(args);
    queueMicrotask(() => {
      child.stdout.write(r.out);
      child.stderr.write(r.err);
      child.emit('close', r.code);
    });
    return child as unknown as import('node:child_process').ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
}

const FAKE_RESOLVE = async (cli: string): Promise<ResolvedCli> => ({
  command: cli,
  args: [],
  how: `found ${cli} on PATH`,
});

test('probe argv: the configured model is in the probe, or the probe says nothing', () => {
  /* Caught 2026-10-30 in the OpenCode desktop UI: the probe left the model
   * off, validated the free default (Flint 40B Free), and the panel reported
   * "ok" for deepseek — a model nothing had exercised. */
  const withModel = opencodeAdapter.probeTurnArgs('deepseek/deepseek-flash');
  assert.deepEqual(withModel, [
    'run', '--format', 'json', '--standalone',
    '--model', 'deepseek/deepseek-flash',
    'Reply with exactly: PONG',
  ]);
  const without = opencodeAdapter.probeTurnArgs('');
  assert.ok(!without.includes('--model'), 'an empty model omits the flag');
  assert.equal(without[without.length - 1], 'Reply with exactly: PONG');

  const claude = claudeAdapter.probeTurnArgs('sonnet');
  assert.equal(claude[claude.indexOf('--model') + 1], 'sonnet');
  assert.ok(!claudeAdapter.probeTurnArgs('').includes('--model'));
});

test('probeCli passes the model through to the probe turn', async () => {
  let seen: readonly string[] = [];
  const spawnFn = fakeSpawn((args) => {
    if (args.includes('--version')) return { code: 0, out: '1.0.0\n', err: '' };
    seen = args;
    return {
      code: 0,
      out: '{"type":"text","sessionID":"ses_m","part":{"type":"text","text":"PONG"}}\n',
      err: '',
    };
  });
  const probe = await probeCli(
    'opencode', spawnFn, 1000, FAKE_RESOLVE, opencodeAdapter, 'deepseek/deepseek-flash',
  );
  assert.equal(probe.available, true);
  assert.equal(seen[seen.indexOf('--model') + 1], 'deepseek/deepseek-flash');
});

test('probe via an adapter: installed and working', async () => {
  const spawnFn = fakeSpawn((args) => {
    if (args.includes('--version')) return { code: 0, out: '1.0.0\n', err: '' };
    return {
      code: 0,
      out: '{"type":"text","sessionID":"ses_ok","part":{"type":"text","text":"PONG"}}\n',
      err: '',
    };
  });
  const probe = await probeCli('opencode', spawnFn, 1000, FAKE_RESOLVE, opencodeAdapter);
  assert.equal(probe.available, true);
  assert.equal(probe.reason, 'ok');
  assert.equal(probe.version, '1.0.0');
});

test('probe via an adapter: CLI present, credentials rejected', async () => {
  const spawnFn = fakeSpawn((args) => {
    if (args.includes('--version')) return { code: 0, out: '1.0.0\n', err: '' };
    return {
      code: 1,
      out: '',
      err: 'authentication_error: invalid API key (401)',
    };
  });
  const probe = await probeCli('opencode', spawnFn, 1000, FAKE_RESOLVE, opencodeAdapter);
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'not-authenticated');
});

test('probe via an adapter: nothing on PATH', async () => {
  const spawnFn = fakeSpawn(() => ({ code: 127, out: '', err: 'command not found' }));
  const resolve = async (): Promise<ResolvedCli> => ({
    command: 'opencode',
    args: [],
    how: 'not found: PATH was empty',
  });
  const probe = await probeCli('opencode', spawnFn, 1000, resolve, opencodeAdapter);
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'not-installed');
});

/* --------------------------------------------------------- regression */

test('the default settings serialise with no secret-shaped fields', () => {
  const dumped = JSON.stringify(DEFAULT_SETTINGS);
  assert.ok(!dumped.includes('sk-'));
  for (const [id, p] of Object.entries(DEFAULT_SETTINGS.agents.providers)) {
    assert.equal(typeof p.apiKeyEnv, 'string', `${id} names a variable, not a value`);
  }
});
