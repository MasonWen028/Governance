import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { classifyTurnFailure } from './agent.js';
import type { AgentResult, AgentRunner, AgentTurn, ProbeResult } from './agent.js';

/**
 * The API transport.
 *
 * Same seam as `spawnRunner`, different physics. The headless CLI is not just a
 * model — it reads the skill files, writes the artifacts, and remembers the
 * conversation. A bare Messages API call can do none of that, so this runner
 * supplies the three missing halves itself:
 *
 * 1. **Skill files are inlined.** The prompt says "read the skill at <path>";
 *    an API model cannot, so every `SKILL.md` path the prompt names is read
 *    from disk and inlined into the system block. The protocol still has
 *    exactly one copy — the skill file — which is what ADR 0002 actually
 *    requires; only the *reading* moved into the app.
 * 2. **File access is a minimal tool loop.** Two tools, `read_file` and
 *    `write_file`. Writes are confined to the feature directory and reads to
 *    the feature directory plus the skill roots — the same boundary the server
 *    enforces everywhere else, now enforced against the model too.
 * 3. **The conversation is persisted by the app.** There is no `--resume` for
 *    a raw API, so the message history lives in
 *    `.session/api-history/<key>.json` under the feature and is replayed every
 *    turn. The session id this runner returns is that key.
 *
 * A turn whose history cannot be saved is a failure, however good the reply
 * looked: without it, round 2 cannot continue the conversation, and a round 2
 * that re-asks settled questions is exactly the failure ADR 0006 names.
 */

/* ------------------------------------------------------------------ types */

interface Block {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly is_error?: boolean;
  readonly tool_use_id?: string;
  readonly content?: string;
}

interface ApiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly Block[];
}

interface ApiResponse {
  readonly content?: readonly Block[];
  readonly stop_reason?: string;
  readonly error?: { readonly message?: string };
}

export interface ApiRunnerOptions {
  readonly apiBase: string;
  /** Used when the turn's model is `inherit` or empty. */
  readonly model: string;
  readonly maxTokens: number;
  /** Read at call time — a key must not be captured at construction. */
  readonly apiKey: () => string | undefined;
  /** Injected for tests. */
  readonly fetchFn?: typeof fetch;
  /** Injected for tests. */
  readonly idFactory?: () => string;
  /** Upper bound on tool round-trips inside one turn. */
  readonly maxLoops?: number;
}

const TOOL_DEFS = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file. Allowed inside the working directory and the skill roots only.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write or overwrite a UTF-8 text file. Allowed inside the working directory only; anywhere else is refused.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
];

const SKILL_REF = /(?:[A-Za-z]:)?[^\s`'"*]+SKILL\.md/g;

function readTextOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/** Every `SKILL.md` path the prompt names, deduplicated, order kept. */
export function skillPathsIn(prompt: string): readonly string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(SKILL_REF)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

function contains(dir: string, abs: string): boolean {
  const rel = relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/* -------------------------------------------------------- the tool loop */

interface ToolOutcome {
  readonly ok: boolean;
  readonly text: string;
}

async function runTool(
  turn: AgentTurn,
  readableRoots: readonly string[],
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const args = (input ?? {}) as { path?: unknown; content?: unknown };
  const raw = typeof args.path === 'string' ? args.path : '';
  if (raw.trim().length === 0) return { ok: false, text: 'error: no path given' };
  const abs = resolve(turn.cwd, raw);

  if (name === 'write_file') {
    if (!contains(turn.cwd, abs)) {
      return { ok: false, text: `error: refused — ${abs} is outside the working directory` };
    }
    const content = typeof args.content === 'string' ? args.content : '';
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return { ok: true, text: `wrote ${abs} (${content.length} bytes)` };
    } catch (e) {
      return { ok: false, text: `error: ${(e as Error).message}` };
    }
  }

  if (name === 'read_file') {
    const allowed = readableRoots.some((root) => contains(root, abs));
    if (!allowed) {
      return { ok: false, text: `error: refused — ${abs} is outside the readable roots` };
    }
    const text = await readTextOrNull(abs);
    if (text === null) return { ok: false, text: `error: ${abs} could not be read` };
    return { ok: true, text };
  }

  return { ok: false, text: `error: unknown tool ${name}` };
}

/* ------------------------------------------------------------- the runner */

interface History {
  readonly key: string;
  readonly messages: ApiMessage[];
}

function historyPath(turn: AgentTurn, key: string): string {
  return join(turn.cwd, '.session', 'api-history', `${key}.json`);
}

async function loadHistory(turn: AgentTurn, key: string): Promise<History | null> {
  const raw = await readTextOrNull(historyPath(turn, key));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { messages?: ApiMessage[] };
    if (!Array.isArray(parsed.messages)) return null;
    return { key, messages: parsed.messages };
  } catch {
    return null;
  }
}

async function saveHistory(turn: AgentTurn, key: string, messages: readonly ApiMessage[]): Promise<boolean> {
  try {
    const p = historyPath(turn, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify({ key, messages }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function persistTranscript(
  turn: AgentTurn,
  system: string,
  messages: readonly ApiMessage[],
  note: string,
): Promise<void> {
  try {
    await mkdir(dirname(turn.logPath), { recursive: true });
    await writeFile(
      turn.logPath,
      [
        '# api turn',
        '',
        `cwd: ${turn.cwd}`,
        `conversation: ${turn.sessionId ?? '(new)'}`,
        note.length > 0 ? `note: ${note}` : '',
        '',
        '## system',
        '',
        system,
        '',
        '## messages',
        '',
        JSON.stringify(messages, null, 2),
        '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
      'utf8',
    );
  } catch {
    // A log that cannot be written must not turn a working run into a failure.
  }
}

export function apiRunner(options: ApiRunnerOptions): AgentRunner {
  const doFetch = options.fetchFn ?? fetch;
  const newId =
    options.idFactory ?? (() => `api-${randomUUID()}`);
  const maxLoops = options.maxLoops ?? 32;

  const callApi = async (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ status: number; json: ApiResponse | null; raw: string }> => {
    const base = options.apiBase.replace(/\/+$/, '');
    const res = await doFetch(`${base}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey() ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json: ApiResponse | null = null;
    try {
      json = JSON.parse(raw) as ApiResponse;
    } catch {
      json = null;
    }
    return { status: res.status, json, raw };
  };

  return {
    async run(turn: AgentTurn): Promise<AgentResult> {
      const started = Date.now();
      const finish = (r: Omit<AgentResult, 'ms'>): AgentResult => ({ ...r, ms: Date.now() - started });

      const key = options.apiKey();
      if (key === undefined || key.trim().length === 0) {
        return finish({
          ok: false,
          sessionId: turn.sessionId,
          output: '',
          error: 'no API key: the key environment variable is not set',
          phase: 'spawn',
        });
      }

      // The system block: the skill files, read on the model's behalf, plus the
      // tool boundary. Built fresh every turn — the skill file may have changed,
      // and a stale inline copy is a second source of truth.
      const skills = skillPathsIn(turn.prompt);
      const sections: string[] = [];
      for (const p of skills) {
        const text = await readTextOrNull(p);
        sections.push(`## Skill file: ${p}\n\n${text ?? '(this file could not be read)'}`);
      }
      const system = [
        'The skill files below were read from disk on your behalf. You cannot read',
        'files yourself; use the read_file tool for anything else you need. Follow',
        'the skills exactly. Where a skill tells you to write a file, use write_file.',
        '',
        `Working directory (the only place writes are accepted): ${turn.cwd}`,
        sections.length > 0 ? '' : '',
        ...sections,
      ]
        .filter((l) => l !== undefined)
        .join('\n');

      const readableRoots = [turn.cwd, ...skills.map((p) => dirname(p))];

      let history: History | null = null;
      let convKey: string;
      if (turn.sessionId !== null) {
        history = await loadHistory(turn, turn.sessionId);
        if (history === null) {
          return finish({
            ok: false,
            sessionId: turn.sessionId,
            output: '',
            error:
              'the saved conversation could not be loaded, so this turn cannot continue it',
            phase: null,
          });
        }
        convKey = turn.sessionId;
      } else {
        convKey = newId();
        history = { key: convKey, messages: [] };
      }

      const messages: ApiMessage[] = [...history.messages, { role: 'user', content: turn.prompt }];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), turn.timeoutMs);

      let note = '';
      let text = '';
      let error: string | null = null;
      let phase: AgentResult['phase'] = null;

      try {
        for (let i = 0; i < maxLoops; i++) {
          const effective =
            turn.model && turn.model !== 'inherit' ? turn.model : options.model;
          const { status, json, raw } = await callApi(
            {
              model: effective,
              max_tokens: options.maxTokens,
              system,
              messages,
              tools: TOOL_DEFS,
            },
            controller.signal,
          );

          if (status !== 200) {
            const detail = (json?.error?.message ?? raw).slice(0, 500);
            error = `API error ${String(status)}: ${detail}`;
            phase = 'exit';
            note = error;
            break;
          }

          const content = json?.content ?? [];
          const toolUses = content.filter((b) => b.type === 'tool_use');
          text = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n')
            .trim();

          messages.push({ role: 'assistant', content });

          if (json?.stop_reason !== 'tool_use' || toolUses.length === 0) break;

          const results: Block[] = [];
          for (const use of toolUses) {
            const out = await runTool(turn, readableRoots, use.name ?? '', use.input);
            if (!out.ok) {
              note = note.length > 0 ? note : `tool ${use.name}: ${out.text}`;
            }
            results.push({
              type: 'tool_result',
              tool_use_id: use.id ?? '',
              content: out.text,
              is_error: !out.ok,
            });
          }
          messages.push({ role: 'user', content: results });
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === 'AbortError') {
          error = `the agent ran longer than ${Math.round(turn.timeoutMs / 1000)}s and was stopped`;
          phase = 'timeout';
          note = note.length > 0 ? note : 'aborted';
        } else {
          // Network and DNS failures are "could not run", the same category a
          // spawn failure lands in for the CLI transport.
          error = err.message;
          phase = 'spawn';
          note = note.length > 0 ? note : err.message;
        }
      } finally {
        clearTimeout(timer);
      }

      if (error !== null) {
        await persistTranscript(turn, system, messages, note);
        return finish({ ok: false, sessionId: convKey, output: text, error, phase });
      }

      // No history, no continuation. This is the API transport's `no-session`:
      // the reply may be brilliant, but round 2 could not pick it up.
      const saved = await saveHistory(turn, convKey, messages);
      if (!saved) {
        await persistTranscript(turn, system, messages, 'history could not be saved');
        return finish({
          ok: false,
          sessionId: convKey,
          output: text,
          error:
            'the conversation history could not be saved under the feature, so the conversation cannot be continued',
          phase: null,
        });
      }

      await persistTranscript(turn, system, messages, note);
      return finish({ ok: true, sessionId: convKey, output: text, error: null, phase: null });
    },
  };
}

/* ------------------------------------------------------------------ probe */

export interface ProbeApiOptions {
  readonly apiBase: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly apiKey: () => string | undefined;
  readonly fetchFn?: typeof fetch;
}

/**
 * Whether an API turn can actually run.
 *
 * Same discipline as `probeCli`: a key being present is not evidence the call
 * works, so a real minimal turn is made — a few tokens, no tools. The failure
 * categories are the CLI's, because the interface downstream already knows how
 * to say each one.
 */
export async function probeApi(
  options: ProbeApiOptions,
  timeoutMs = 20000,
): Promise<ProbeResult> {
  const base = {
    command: options.apiBase,
    how: `Messages API transport (key from ${options.apiKeyEnv})`,
  };
  const key = options.apiKey();
  if (key === undefined || key.trim().length === 0) {
    return {
      available: false,
      reason: 'not-authenticated',
      version: null,
      detail: `the environment variable ${options.apiKeyEnv} is not set`,
      ...base,
    };
  }

  const doFetch = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${options.apiBase.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      }),
    });
    const raw = await res.text();
    if (res.status === 200) {
      return {
        available: true,
        reason: 'ok',
        version: options.model,
        detail: 'a real turn completed against the Messages API',
        ...base,
      };
    }
    const { reason, detail } = classifyTurnFailure(`API error ${String(res.status)}: ${raw.slice(0, 300)}`);
    return { available: false, reason, version: options.model, detail, ...base };
  } catch (e) {
    const err = e as Error;
    const { reason, detail } = classifyTurnFailure(err.message);
    return {
      available: false,
      reason: reason === 'unknown' ? 'unrunnable' : reason,
      version: null,
      detail: detail.slice(0, 300),
      ...base,
    };
  } finally {
    clearTimeout(timer);
  }
}
