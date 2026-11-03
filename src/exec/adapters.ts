import { parseCliOutput } from './agent.js';
import type { AgentTurn } from './agent.js';

/**
 * CLI adapters.
 *
 * The scheduler never builds a command itself and never concatenates a shell
 * string: each adapter returns an argv array, so a prompt containing quotes or
 * an operator can only ever arrive as one argument. That constraint is why
 * `shell: true` was rejected for the Claude runner and holds for every adapter.
 *
 * Two adapters exist. A CLI without one is not "supported with quirks" — it
 * falls back to the Claude-style arguments with a settings warning, exactly as
 * it did before adapters existed, because inventing a command line for an
 * unverified CLI is how a migration pretends to work.
 */

export interface ParsedTurn {
  readonly sessionId: string | null;
  readonly message: string;
  readonly isError: boolean;
}

export interface CliAdapter {
  /** The CLI id this adapter builds for. */
  readonly id: string;
  /**
   * A minimal turn's argv, for the probe. Takes the model the same way
   * `turnArgs` does: empty means "the CLI's own default".
   *
   * The probe must run the model the runs will use. It did not always: until
   * 2026-10-30 the probe left the model off, so it validated OpenCode's default
   * (the free tier) while every real run went to the configured model — and the
   * UI reported "ok" for a configuration that had never been exercised.
   */
  probeTurnArgs(model: string): string[];
  readonly versionArgs: readonly string[];
  /**
   * The argv for a real turn. `turn.model` empty means "let the CLI use its
   * own configured default" — we do not assume a vendor's model.
   */
  turnArgs(turn: AgentTurn): string[];
  /** Parse the CLI's stdout into the one thing the app needs back. */
  parse(stdout: string): ParsedTurn;
}

/** Claude Code: `--print`, JSON envelope, `--resume` for conversations. */
export const claudeAdapter: CliAdapter = {
  id: 'claude',
  probeTurnArgs(model): string[] {
    return [
      '--print', 'Reply with exactly: PONG', '--output-format', 'json',
      ...(model !== '' ? ['--model', model] : []),
    ];
  },
  versionArgs: ['--version'],
  turnArgs(turn): string[] {
    const args = ['--print', turn.prompt, '--output-format', 'json'];
    // The agent writes files inside the feature, so it needs edit permission
    // without a prompt. Scoped to acceptEdits; not bypassPermissions.
    args.push('--permission-mode', 'acceptEdits');
    if (turn.model !== '') args.push('--model', turn.model);
    if (turn.allowedTools.length > 0) {
      args.push('--allowedTools', turn.allowedTools.join(','));
    }
    if (turn.sessionId !== null) args.push('--resume', turn.sessionId);
    return args;
  },
  parse(stdout): ParsedTurn {
    const { sessionId, message, isError } = parseCliOutput(stdout);
    return { sessionId, message, isError };
  },
};

/**
 * OpenCode: `run --format json`, NDJSON events.
 *
 * The event contract (verified against the published docs and the community
 * event cheatsheets, not against a local install — see the honest-gap note in
 * the ADR): every event carries `sessionID`; `text` events carry `part.text`;
 * an `error` event sets exit code 1. Session ids look like `ses_…` and are the
 * handle `--session` resumes.
 *
 * `--auto` auto-approves permission prompts. A non-interactive `run` cannot
 * answer one, and the grilling session must write files, so without it every
 * file write would hang. It is the OpenCode equivalent of Claude's
 * `acceptEdits` — broader than we would like, and named here rather than
 * hidden in a flag list.
 *
 * `--standalone` runs the turn against a private server instead of the
 * background service the desktop app owns. Verified against 2.2.1: without
 * it, a headless `run` waits on that service and hangs when it is absent or
 * wedged ("Background service is unresponsive"). Stdin must also be closed —
 * governance already spawns with `stdio: ['ignore', …]`, which is the same
 * shape.
 */
export const opencodeAdapter: CliAdapter = {
  id: 'opencode',
  probeTurnArgs(model): string[] {
    return [
      'run', '--format', 'json', '--standalone',
      ...(model !== '' ? ['--model', model] : []),
      'Reply with exactly: PONG',
    ];
  },
  versionArgs: ['--version'],
  turnArgs(turn): string[] {
    const args = ['run', '--format', 'json', '--standalone', '--auto'];
    if (turn.model !== '') args.push('--model', turn.model);
    if (turn.sessionId !== null) args.push('--session', turn.sessionId);
    args.push(turn.prompt);
    return args;
  },
  parse(stdout): ParsedTurn {
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    let sessionId: string | null = null;
    let message = '';
    let isError = false;
    for (const line of lines) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Not JSON — often the error text itself. Keep it.
        if (!isError && line.trim().length > 0) message = line.trim().slice(0, 4000);
        continue;
      }
      if (typeof evt['sessionID'] === 'string' && sessionId === null) {
        sessionId = evt['sessionID'];
      }
      if (evt['type'] === 'text') {
        const part = evt['part'] as { text?: unknown } | undefined;
        if (typeof part?.text === 'string') message += (message === '' ? '' : '\n') + part.text;
      }
      if (evt['type'] === 'error') {
        isError = true;
        const err = evt['error'] as { message?: unknown; data?: { message?: unknown }; name?: unknown } | undefined;
        const text =
          typeof err?.data?.message === 'string'
            ? err.data.message
            : typeof err?.message === 'string'
              ? err.message
              : typeof err?.name === 'string'
                ? err.name
                : 'the agent reported an error with no detail';
        message = text.slice(0, 4000);
      }
    }
    return { sessionId, message: message.slice(0, 4000), isError };
  },
};

const ADAPTERS: Readonly<Record<string, CliAdapter>> = {
  claude: claudeAdapter,
  opencode: opencodeAdapter,
};

/**
 * The adapter for a CLI id. An unknown id gets the Claude adapter — the
 * pre-adapter behaviour for every custom `agents.cli` value — and the settings
 * parser has already warned about it.
 */
export function adapterFor(cli: string): CliAdapter {
  return ADAPTERS[cli] ?? claudeAdapter;
}

export const KNOWN_CLIS: readonly string[] = Object.keys(ADAPTERS);
