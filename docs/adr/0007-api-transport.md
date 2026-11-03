# 7. An API transport beside the CLI, not instead of it

Date: 2026-10-29
Status: accepted

## Context

ADR 0002 chose a headless `claude` CLI as the way agent turns execute, because
the skill files are the protocol and the CLI can read them and write the
artifacts. That choice has a cost: the machine must have the CLI installed,
authenticated, and allowed to run — three different facts, three different
failures (see `probeCli`). Environments exist where none of them can be met: a
server that may only make outbound HTTPS calls, a CI container, a machine whose
owner does not want a second agent runtime on it.

The runner is a seam (`AgentRunner`), and the demo runner already proves
everything above the seam is transport-agnostic. The question was whether a
direct Messages API transport is honest about the same protocol, or whether it
quietly becomes a second runtime with its own copy of it.

## Decision

`agents.transport` selects between `cli` (default) and `api`. The API transport
(`src/exec/apiagent.ts`) implements the same `AgentRunner` seam, and is honest
about the three things a bare model call cannot do:

1. **The skill files are read by the app and inlined.** Every `SKILL.md` path
   the prompt names is read from disk and placed in the system block. The
   protocol still has exactly one copy — the skill file — which is what
   ADR 0002 requires; only the *reading* moved into the app. A skill file the
   app cannot read is inlined as "(this file could not be read)", so the gap is
   visible in the transcript rather than papered over.
2. **File access is a two-tool loop.** `read_file` and `write_file`, nothing
   else. Writes resolve against the effort directory and are refused outside
   it; reads are allowed inside the effort directory and the skill roots. This
   is the server's own write boundary, now enforced against the model.
3. **The conversation is the app's to persist.** There is no `--resume` for a
   raw API, so the full message history is saved to
   `.session/api-history/<key>.json` under the effort and replayed every turn.
   The session id this runner returns is that key. A turn whose history cannot
   be saved is a failure however good the reply looked — round 2 must be able
   to continue what round 1 started, which is the load-bearing rule of
   ADR 0006.

Credentials follow the settings file's own rule: `agents.apiKeyEnv` holds the
*name* of an environment variable, never a value. The key is read from the
environment at call time.

The probe gains no new vocabulary. `probeApi` reports the same `ProbeReason`
set as `probeCli` — a missing key is `not-authenticated`, a failed real call is
`unrunnable` or `rate-limited` — so the interface says one true thing per
reason in both transports.

## The round artifact, which prompt.ts points at here

Each agent turn ends by writing `.session/<NN>.json` (and `latest.json`, the
same content) inside the effort, in this shape:

```json
{
  "round": 1,
  "kind": "questions" | "prd",
  "questions": [
    {
      "id": "q1",
      "title": "...", "body": "...", "why": "...",
      "recommended": "...",
      "options": ["..."]
    }
  ],
  "glossaryWritten": ["term"],
  "adrsWritten": ["0001-..."],
  "frontierEmpty": false
}
```

The app reads this file to render the answer form and to derive the session
phase; the agent's prose is kept (`last-output.md`) only as a fallback reader,
and every round records which reader produced it.

## Consequences

- The grilling session works on machines with no CLI at all.
- `advance` (the stage runner) still spawns the CLI directly. Wiring the API
  transport there too is a later slice — stage prompts lean harder on file
  access, and the stage path has never run with `--execute` on this machine
  either.
- The API transport was verified against a scripted fetch double: tool loops,
  history replay, path refusals, and every failure category. A real round trip
  against the live API has not been made from the machine this was built on —
  the same named gap the CLI transport carries.
