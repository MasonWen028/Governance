# 8. A multi-provider executor, with OpenCode as the default

Date: 2026-10-29
Status: accepted

## Context

ADR 0002 chose a headless `claude` CLI as the executor, on the evidence that it
existed on PATH. That made a Claude subscription a de-facto dependency of the
default path, and left every other executor — OpenCode in particular —
unreachable without pretending it was Claude (the runner hardcoded Claude's
arguments for whatever `agents.cli` named, which worked only by accident of
nobody having tried it).

## Decision

**The argv moves behind an adapter.** `src/exec/adapters.ts` defines
`CliAdapter` — `turnArgs(turn)`, `probeTurnArgs`, `versionArgs`, `parse` — and
two implementations: `claudeAdapter` (the previous argv, unchanged) and
`opencodeAdapter` (`run --format json --auto`, `--model provider/model`,
`--session <id>`). The scheduler spawns whatever the adapter returns, as an
argv array; a prompt can never be read as shell syntax, which is why
`shell: true` remains rejected. An unknown CLI id falls back to the Claude
adapter — the exact pre-adapter behaviour — with a settings warning, because
inventing a command line for an unverified CLI is how a migration pretends to
work.

**OpenCode is the default for fresh installs; existing choices survive.**
`DEFAULT_SETTINGS.agents.cli` is `opencode`. A settings file that has an
`agents` block but never named a CLI was written when `claude` was the implicit
default, so migration keeps `claude` for it: preserving the user's executor
choice, not defaulting to Claude. A file that names a CLI keeps it verbatim.

**Provider configuration is data the CLI can use, and nothing more.**
`agents.providers.<cli>` carries `provider`, `model`, `baseUrl`, `apiKeyEnv`.
Empty means "whatever the CLI itself is configured with" — no vendor is
assumed, and Ollama with no key is a valid configuration (which is why these
fields parse with explicit-empty semantics rather than snap-to-default).
`apiKeyEnv` is the *name* of an environment variable; the parser refuses an
`apiKey` value, the same refusal the MCP `env` list makes. OpenCode resolves
actual credentials its own way — `opencode auth login` (OS keychain) or
`{env:VAR}` in its own config — and this app never handles the key itself.

**Roles can override the executor.** `agents.roleAgents.<role>` sets
`cli`, `provider`, `model`, `baseUrl` per role. Resolution is
role > global > provider defaults; `inherit` and empty both fall through
(they differ only in what the UI shows). The resolution happens at task start
and is frozen into the turn, so a settings change mid-run cannot drift a
conversation onto another model.

**The probe is per-adapter and honest.** `probeCli` takes the adapter's
version and probe-turn argv and parses with the adapter's parser, so the same
six `ProbeReason` categories cover both CLIs. `POST /api/agent/test` runs that
probe on demand against the configuration being edited, and reports whether
the named key variable is *set* — never the key itself.

## Consequences

- The default path needs no Claude subscription. OpenCode's own free models,
  or a local Ollama model, are first-class configurations.
- `advance`'s plan and the session runner both resolve through
  `resolveAgentFor`, so a stage plan names the CLI it will actually spawn.
- **Named gap:** OpenCode is not installed on the machine this was built on.
  The argv, the NDJSON event parsing (sessionID on every event, `text`
  carrying `part.text`, `error` carrying `error.data.message`, exit code 1)
  are verified against the published CLI docs and community event references,
  and tested with fixtures — not against a live install. The first real
  `opencode run` on an installed machine is the verification step.
- `--auto` (OpenCode's permission auto-approve) is required for a
  non-interactive session to write files at all; it is broader than Claude's
  `acceptEdits` and is named in the adapter rather than hidden.
- DeepSeek Harness, WorkBuddy CLI and other executors are **not** implemented
  and are not shown as options. An adapter is written when its protocol can be
  verified, not before.
