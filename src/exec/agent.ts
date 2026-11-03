import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { adapterFor } from './adapters.js';
import type { CliAdapter } from './adapters.js';
import { resolveCli } from './resolve.js';
import type { ResolvedCli } from './resolve.js';

/**
 * The agent runner.
 *
 * One conversation per feature, continued across rounds with `--resume`. That is
 * the load-bearing decision: the design tree lives in the conversation's context,
 * so a fresh process per round would force the agent to rebuild it from the
 * artifacts every time — and worse, to re-ask questions that were already
 * settled, because it would no longer know they had been.
 *
 * The runner is a **seam**, injected rather than constructed. That is not
 * test-driven decoration: on this machine the CLI cannot actually execute (it
 * reaches for `reg.exe`, which the sandbox blocks), so a full round-trip is not
 * verifiable here. Everything above the runner is tested against a scripted
 * double, and the one unverifiable link is named rather than papered over.
 */

export interface AgentTurn {
  /** The prompt to send. */
  readonly prompt: string;
  /** Resume a conversation, or start one. */
  readonly sessionId: string | null;
  /** Working directory for the agent. */
  readonly cwd: string;
  /** Where the transcript is written. */
  readonly logPath: string;
  readonly timeoutMs: number;
  readonly model: string;
  /** Tools the agent may use without asking. Edits, plus reads and search. */
  readonly allowedTools: readonly string[];
}

export interface AgentResult {
  readonly ok: boolean;
  /** The session id, for the next turn. Null when the run never started. */
  readonly sessionId: string | null;
  /** The agent's own final message. Kept for the log; not parsed for state. */
  readonly output: string;
  /** Empty on success. Set when the CLI could not run at all. */
  readonly error: string | null;
  readonly ms: number;
  /** Which turn failed, if any: spawning it, or the process exiting non-zero. */
  readonly phase: 'spawn' | 'exit' | 'timeout' | null;
}

export interface AgentRunner {
  run(turn: AgentTurn): Promise<AgentResult>;
}

/** The shape of `claude --output-format json`. Only the fields we use. */
interface CliJson {
  readonly session_id?: unknown;
  readonly result?: unknown;
  readonly is_error?: unknown;
  readonly subtype?: unknown;
}

/**
 * Parse the CLI's JSON output.
 *
 * Tolerant on purpose: the CLI's envelope has changed shape between versions, and
 * a runner that throws on an unexpected field is worse than one that reports what
 * it got. The session id is the only field the app genuinely needs.
 */
export function parseCliOutput(stdout: string): {
  sessionId: string | null;
  message: string;
  isError: boolean;
} {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { sessionId: null, message: '', isError: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as CliJson;
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
    const message =
      typeof parsed.result === 'string'
        ? parsed.result
        : typeof parsed.result === 'object' && parsed.result !== null
          ? JSON.stringify(parsed.result).slice(0, 4000)
          : trimmed.slice(0, 4000);
    return { sessionId, message, isError: parsed.is_error === true };
  } catch {
    // Not JSON. Keep the text: it is very often the error message.
    return { sessionId: null, message: trimmed.slice(0, 4000), isError: false };
  }
}

export interface SpawnRunnerOptions {
  /** The CLI to invoke. */
  readonly cli: string;
  /**
   * The adapter that builds the argv. Defaults to `adapterFor(cli)`; injected
   * by tests and by anything that needs a fake CLI.
   */
  readonly adapter?: CliAdapter;
  /** Injected for tests. */
  readonly spawnFn?: typeof spawn;
  /**
   * How to start `cli`. Resolved once and reused.
   *
   * Resolution is a separate concern from running: on Windows the name on PATH is
   * a batch file that has to be followed to its JavaScript entry, and getting
   * that wrong produces ENOENT from a CLI that is plainly installed.
   */
  readonly resolved?: ResolvedCli;
  readonly resolve?: (cli: string) => Promise<ResolvedCli>;
}

/** The real runner: spawns the CLI, with the argv built by its adapter. */
export function spawnRunner(options: SpawnRunnerOptions): AgentRunner {
  const spawnFn = options.spawnFn ?? spawn;
  const adapter = options.adapter ?? adapterFor(options.cli);
  const resolve = options.resolve ?? ((c: string) => resolveCli(c));
  let cached: ResolvedCli | null = options.resolved ?? null;

  return {
    async run(turn: AgentTurn): Promise<AgentResult> {
      const target: ResolvedCli = cached ?? (await resolve(options.cli));
      cached = target;
      const args = [...target.args, ...adapter.turnArgs(turn)];

      const started = Date.now();
      return await new Promise<AgentResult>((done) => {
        let settled = false;
        const finish = (r: Omit<AgentResult, 'ms'>): void => {
          if (settled) return;
          settled = true;
          done({ ...r, ms: Date.now() - started });
        };

        let child: ReturnType<typeof spawn>;
        try {
          child = spawnFn(target.command, args, {
            cwd: turn.cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          finish({
            ok: false,
            sessionId: turn.sessionId,
            output: '',
            error: (err as Error).message,
            phase: 'spawn',
          });
          return;
        }

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (c: Buffer) => {
          stdout += c.toString('utf8');
        });
        child.stderr?.on('data', (c: Buffer) => {
          stderr += c.toString('utf8');
        });

        const timer = setTimeout(() => {
          child.kill();
          void persist(turn, stdout, stderr + `\n[killed after ${turn.timeoutMs}ms]`);
          finish({
            ok: false,
            sessionId: turn.sessionId,
            output: stdout,
            error: `the agent ran longer than ${Math.round(turn.timeoutMs / 1000)}s and was stopped`,
            phase: 'timeout',
          });
        }, turn.timeoutMs);

        child.on('error', (err) => {
          clearTimeout(timer);
          // A missing CLI lands here, and so does a sandbox refusal. Both are
          // "could not run", which is a different thing from "ran and failed".
          void persist(turn, stdout, stderr + `\n[spawn error] ${err.message}`);
          finish({
            ok: false,
            sessionId: turn.sessionId,
            output: stdout,
            error: err.message,
            phase: 'spawn',
          });
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          const parsed = adapter.parse(stdout);
          const failed = code !== 0 || parsed.isError;
          void persist(
            turn,
            stdout,
            stderr,
            `exit ${String(code)}`,
          ).then(() => {
            finish({
              ok: !failed && parsed.sessionId !== null,
              sessionId: parsed.sessionId ?? turn.sessionId,
              output: parsed.message,
              error: failed
                ? (stderr.trim() || parsed.message || `the agent exited ${String(code)}`).slice(0, 800)
                : parsed.sessionId === null
                  ? 'the agent replied without a session id, so the conversation cannot be resumed'
                  : null,
              phase: failed ? 'exit' : null,
            });
          });
        });
      });
    },
  };
}

async function persist(
  turn: AgentTurn,
  stdout: string,
  stderr: string,
  note = '',
): Promise<void> {
  try {
    await mkdir(dirname(turn.logPath), { recursive: true });
    await writeFile(
      turn.logPath,
      [
        `# turn`,
        '',
        `cwd: ${turn.cwd}`,
        `resume: ${turn.sessionId ?? '(new conversation)'}`,
        note.length > 0 ? `note: ${note}` : '',
        '',
        '## prompt',
        '',
        turn.prompt,
        '',
        '## stdout',
        '',
        stdout || '(empty)',
        '',
        '## stderr',
        '',
        stderr || '(empty)',
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

/** A runner used when the app is asked not to execute anything. Records the turn. */
export function dryRunner(): AgentRunner {
  return {
    async run(turn: AgentTurn): Promise<AgentResult> {
      await persist(turn, '', `[dry run] would have invoked the agent here`, 'dry run');
      return {
        ok: false,
        sessionId: turn.sessionId,
        output: '',
        error: 'dry run: the agent was not invoked',
        phase: null,
        ms: 0,
      };
    },
  };
}

/**
 * Probe whether the CLI can actually run.
 *
 * Worth having as its own step: "the CLI is installed" and "the CLI can execute"
 * are different facts, and on this machine they differ. Version alone is not
 * evidence.
 */
/**
 * Why the agent is not usable.
 *
 * This exists because a single `available: false` conflated two states that look
 * identical from the outside and need completely different responses:
 *
 * - the CLI could not be started at all, and
 * - the CLI ran fine and rejected the credentials.
 *
 * The first is an installation or environment problem. The second is a login. The
 * UI was written for the first, so a machine whose CLI worked perfectly told the
 * human it "cannot run on this machine" — advice that sends them to fix something
 * that is not broken.
 */
export type ProbeReason =
  | 'ok'
  /** Nothing on PATH matched, or the entry it named was missing. */
  | 'not-installed'
  /** Found, but the process could not be started. */
  | 'unrunnable'
  /** It ran, and rejected the credentials. */
  | 'not-authenticated'
  /** Started, and the host refused to let it run a subprocess. */
  | 'blocked'
  /** Temporarily out of capacity. */
  | 'rate-limited'
  /** It ran, but no session id came back, so a conversation cannot be continued. */
  | 'no-session'
  | 'unknown';

export interface ProbeResult {
  /** Usable for a real turn. */
  readonly available: boolean;
  /** The specific reason. Lets a caller say something true rather than generic. */
  readonly reason: ProbeReason;
  readonly detail: string;
  readonly version: string | null;
  /** The executable actually invoked. Absent when nothing resolved. */
  readonly command?: string;
  /** How it was found. Reported so a failure can be acted on. */
  readonly how?: string;
}

/**
 * Categorise a failure, and describe it factually.
 *
 * Deliberately returns no advice. What to do about a failure depends on where the
 * reader is — a person at a terminal, a screen in a browser, a log line — and
 * baking one audience's instructions into the value meant the interface repeated
 * them verbatim, wrong. The reason travels; the advice is composed where it is
 * shown.
 */
export function classifyTurnFailure(raw: string): { reason: ProbeReason; detail: string } {
  const text = raw.trim();
  if (text.length === 0) {
    return { reason: 'unknown', detail: 'the CLI reported a failure with no detail' };
  }

  // "provider.auth" and "Authentication Fails" are OpenCode 2.2.1's own shape
  // for a rejected credential — captured live 2026-10-30 by planting a bogus
  // DeepSeek key through `auth import` in an isolated XDG environment. The
  // message alone ("Your api key: ****0000 is invalid") matched none of the
  // older phrases, so a real 401 reported as `unknown`.
  if (/authentication_error|authentication fails|provider\.auth|401|invalid api key|not logged in|unauthoriz|please run \/login/i.test(text)) {
    return { reason: 'not-authenticated', detail: text };
  }
  if (/ENOENT|not recognized|is not recognized|command not found|cannot find/i.test(text)) {
    return { reason: 'not-installed', detail: text };
  }
  if (/blocked|refused to start|security policy|not permitted/i.test(text)) {
    return { reason: 'blocked', detail: text };
  }
  if (/rate.?limit|429|overloaded|free.?limit|usage.?limit|retry.?after/i.test(text)) {
    // "Free usage limit reached … retryAfterMs" — the real shape OpenCode 2.2.1
    // emits when the default model's free quota is exhausted (captured
    // 2026-10-30). `rate.?limit` alone never matched it, so a throttled run
    // reported as `unknown`.
    return { reason: 'rate-limited', detail: text };
  }
  if (/session id/i.test(text)) {
    return { reason: 'no-session', detail: text };
  }
  return { reason: 'unknown', detail: text };
}

export async function probeCli(
  cli: string,
  spawnFn: typeof spawn = spawn,
  timeoutMs = 20000,
  resolve: (cli: string) => Promise<ResolvedCli> = (c) => resolveCli(c),
  adapter: CliAdapter = adapterFor(cli),
  model = '',
): Promise<ProbeResult> {
  const target = await resolve(cli);

  const attempt = async (args: readonly string[]): Promise<{ code: number | null; out: string; err: string }> =>
    await new Promise((done) => {
      let out = '';
      let err = '';
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnFn(target.command, [...target.args, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        done({ code: null, out: '', err: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        done({ code: null, out, err: err + '\n[timed out]' });
      }, timeoutMs);
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        err += c.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ code: null, out, err: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, out, err });
      });
    });

  const version = await attempt(adapter.versionArgs);
  if (version.code !== 0) {
    const detail = (version.err.trim() || 'the CLI did not report a version').slice(0, 300);
    return {
      available: false,
      // Nothing started, so this is about finding or starting it — whichever the
      // resolution says, regardless of what the error text happens to contain.
      reason: /not found|PATH was empty/i.test(target.how) ? 'not-installed' : 'unrunnable',
      version: null,
      command: target.command,
      how: target.how,
      detail,
    };
  }
  const v = version.out.trim().split('\n')[0] ?? '';

  // Version answers "is it installed". A real turn answers "can it run", and the
  // two can differ — a blocked subprocess, a missing credential, a policy.
  // The turn runs the *configured* model when there is one: a probe that passes
  // on the CLI's default says nothing about the model the runs will use, and
  // reporting "ok" for a model that was never exercised is a lie with a green
  // dot on it (caught 2026-10-30: the probe validated the free default while
  // every real run went to deepseek).
  const turn = await attempt(adapter.probeTurnArgs(model));
  const parsedTurn = adapter.parse(turn.out);
  if (turn.code !== 0 || parsedTurn.isError) {
    const raw = (parsedTurn.message || turn.err.trim() || turn.out.trim()).slice(0, 600);
    const { reason, detail } = classifyTurnFailure(raw);
    return {
      available: false,
      reason,
      version: v,
      command: target.command,
      how: target.how,
      detail,
    };
  }
  if (parsedTurn.sessionId === null) {
    return {
      available: false,
      reason: 'no-session',
      version: v,
      command: target.command,
      how: target.how,
      detail: 'the CLI ran but returned no session id, so conversations cannot be resumed',
    };
  }
  return {
    available: true,
    reason: 'ok',
    version: v,
    command: target.command,
    how: target.how,
    detail: 'a turn completed and returned a session id',
  };
}

