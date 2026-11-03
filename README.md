# Governance

A local control plane for driving an effort through a nine-stage SDLC loop, where
a gate records a decision instead of mutating state.

> **Status: experimental.** Built while the owner was away, on an explicit
> delegation. The design decisions it rests on are in [`docs/decisions.md`](docs/decisions.md)
> and [`docs/adr/`](docs/adr/). Read those before changing anything load-bearing.

## The loop

```
intake → ask → spec → design → split → develop → review → ship → retro
```

`design` sits between `spec` and `split` deliberately. Slices are sequenced
against an interface, so slicing before the interface is fixed produces slices
that get rewritten. It can be skipped, but only by writing
`**Design:** none - <reason>` in `spec.md`, so skipping is a recorded decision
rather than an oversight.

## The two rules everything follows

**A stage's state is derived from artifacts, never declared.** A stage cannot
claim to be complete; the presence of what it produces makes it so. This is what
stops the display from becoming a second, disagreeing source of truth.

**A gate is an immutable definition plus an append-only `decisions.jsonl`.** The
log is the only authority on the gate's state. A button that changed a gate
without leaving a record would produce a state nobody can audit, and an
unauditable approval is indistinguishable from one that never happened.

Two consequences worth knowing before you read the code:

- A crossing is **reported, not absorbed**. If `split` has output while `design`
  was never satisfied, the stage reports `active` and the effort carries a
  `crossed` warning. It does not quietly mark `split` complete.
- There is **no percentage anywhere**. A percentage over nine stages claims a
  precision the loop does not have.

## Quick start

```bash
npm install          # two devDependencies; nothing at runtime
npm test             # five gates, see below
npm run scan         # read every workspace and print what is there

npm run serve:demo   # http://127.0.0.1:4173 — scripted agent, no credential needed
npm run serve        # the same, with the real agent CLI
```

**Serve it; do not open `web/index.html` directly.** The page reads repositories
off disk and runs an agent, so it needs the server. Opened as a file the browser
blocks its modules and nothing renders. If you do open it that way, the page now
says so rather than showing a blank screen.

### Reaching it from another machine

The server binds `127.0.0.1` and refuses any request whose `Host` is not
loopback. That check is DNS-rebinding armor and it is load-bearing: there is no
login in front of this server and, by design, there never will be. So pointing a
Cloudflare Tunnel straight at port 4173 does **not** work — the tunnel arrives
with `Host: <name>.trycloudflare.com` and every request is answered before it
reaches a route:

```
{"error":"refusing non-loopback host header: abc.trycloudflare.com"}
```

Two ways through.

**Same network: forward, do not publish.** An SSH local forward makes the far end
a genuine loopback port, so the guard passes honestly and nothing is exposed to
anyone else:

```bash
ssh -L 4173:127.0.0.1:4173 <this-host>    # run on the other machine
# then open http://127.0.0.1:4173 there
```

**Different networks: put the proxy in front, then tunnel that.** It rewrites
`Host` and drops `Origin`, and it binds loopback itself, so the tunnel running on
this machine is the only thing that can reach it:

```bash
npm run proxy:remote -- --to 4173 --port 4180 --accept-risk
cloudflared tunnel --url http://127.0.0.1:4180
```

Read the warning it prints before you run it. The tunnel URL is unauthenticated:
whoever has it can read every file under your workspace roots, create projects,
and run an agent that spends money. A quick-tunnel URL is random and short-lived,
which is some mitigation and is not access control. Stop the tunnel when the demo
ends.

Either way also fixes the empty-workspaces problem on its own — the server reads
*this* machine's disk, where the roots in `governance.workspaces.json` actually
exist.

### Verifying, two ways

`serve:demo` runs the whole flow against a scripted agent. Use it to check the
flow itself — no CLI, no credential, no spend — and to tell "the flow is broken"
apart from "the agent is broken". Anything it writes says it came from the demo.

In demo mode the real CLI is **not probed**, so no credential error is shown: the
demo is what will run, so the demo is what is reported. The interface says so in
neutral terms rather than in red, because nothing is wrong.

`serve` runs the real thing. **`GET /api/session/agent` reports whether the CLI can
execute, which is not the same as whether it is installed.** Where it cannot, the
answer is specific:

| What it says | What to do |
|---|---|
| `not authenticated` | Run the CLI by hand once — `claude` — and log in. |
| `host refused to let a subprocess run` | An environment restriction, not a configuration problem. |
| `not found on PATH` | The CLI is not installed, or `agents.cli` in settings names the wrong command. |
| `could not be started: …` | Installed but unrunnable; the message carries the underlying error. |

### On a machine with no agent CLI

Both `spawn opencode ENOENT` and `… API key is not set` come from real mode.
`serve:demo` never probes the CLI, so neither can appear — start there.

To run the real agent on a fresh machine:

```bash
npm install -g opencode-ai   # the package is opencode-ai; the command is opencode
opencode --version           # "command not found" means npm's global bin is off PATH
npm prefix -g                # add the printed path to PATH, then reopen the terminal

opencode auth login          # pick a provider, paste the key
```

`opencode auth login` is the reliable route: it writes the credential where
OpenCode already looks, so no environment variable is involved at all.

If you would rather use a variable, its name has to match the provider in
`governance.settings.json`. That file ships with `provider: deepseek`, so the
variable is `DEEPSEEK_API_KEY`:

```bash
setx DEEPSEEK_API_KEY "sk-…"   # Windows; reopen the terminal
export DEEPSEEK_API_KEY=sk-…   # macOS / Linux
```

`OPENCODE_API_KEY` is OpenCode Zen's variable and does nothing for DeepSeek. Naming
the wrong one is why the app can report "not set" while the agent is in fact
authenticated through its own `auth.json` — in `cli` transport the credential is
OpenCode's business, and this field only says which variable to check.

Two more things that differ per machine:

- **`governance.workspaces.json` is machine-local.** It carries absolute paths from
  the machine that wrote it. Replace `roots` with local checkouts, or a scan finds
  nothing.
- **No CLI at all?** Set `agents.transport` to `"api"` in
  `governance.settings.json` and set `ANTHROPIC_API_KEY`. Nothing is spawned.

### What a test run covers

| Gate | Command |
|---|---|
| 207 unit assertions — parsing, stage derivation, the session, the CLI resolver | `npm test` |
| A headless boot of the UI, including every inline handler | `npm run test:web` |
| The session over a real socket, with a scripted agent | `npm run test:e2e` |
| The whole flow with the demo agent, over a real socket | `npm run test:demo` |

`scan` against a real tree:

```
railyard [methodology-view*]
  H:\Projects\railyard
  methodology-view         +++>>>>.   3/9  at design  13 tickets  all resolved
  ! methodology-view: stage "split" has output but "design" was never satisfied (crossed)
```

## Where a project's state comes from

Local markdown under `.scratch/`, exactly as the skill chain already writes it.
The application reads it and projects it; it never owns it.

```
.scratch/<effort>/
  map.md                  # Destination, Notes, Decisions so far,
                          # Not yet specified, Out of scope
  issues/NN-<slug>.md     # one ticket per file, never a combined file
  gates.json              # gate definitions (immutable)
  decisions.jsonl         # gate decisions (append-only)
  runs/*.log              # stage runs, when one has happened
```

A ticket carries `**Type:**`, `**Status:**` and `**Blocked by:**` as lines near the
top, then `## Question` / `## Answer` sections.

Because the markdown is authoritative, the application can be replaced without a
migration. The data outlives the tool.

## Commands

| Command | What it does |
|---|---|
| `governance scan [root...]` | Read workspaces, print stages and tickets. `--json` for machine output. |
| `governance serve [--port N]` | Serve the UI and API on loopback. Foreground. |
| `governance advance <effort>` | Plan the next stage's skill run. **Dry run** unless `--execute`. |

## Configuration

Two files at the package root, both hand-editable and both diffable. Delete either
and its defaults come back.

**`governance.workspaces.json`** — which repositories to read.

```json
{ "roots": ["H:/Projects/railyard"] }
```

**`governance.settings.json`** — how the agents run. Fully editable through the
Settings window, which writes this file.

```json
{
  "agents": {
    "cli": "opencode",
    "maxParallel": 4,
    "isolation": "worktree",
    "providers": {
      "opencode": { "provider": "ollama", "model": "qwen3-coder", "baseUrl": "", "apiKeyEnv": "" }
    },
    "roleAgents": { "qa": { "cli": "claude", "provider": "", "model": "", "baseUrl": "" } }
  },
  "skills": [{ "id": "implement-spec", "stage": "develop", "enabled": true }],
  "mcp": [{ "name": "git", "transport": "stdio", "target": "mcp-server-git",
            "scope": ["develop", "review"], "enabled": true, "env": ["GIT_DIR"] }]
}
```

The executor is multi-provider. **OpenCode is the default** (`opencode` CLI,
`run --format json`); Claude Code is opt-in. A settings file that already names
a CLI keeps it across upgrades. Empty provider/model fields mean "whatever the
CLI itself is configured with" — no vendor is assumed, and a local Ollama model
with no API key is a valid configuration, not an error. An API key is **never**
stored here: `apiKeyEnv` names an environment variable, and the parser refuses
an entry that tries to carry a value. Roles (`tech`, `qa`, `ops`, `security`)
can override the CLI, provider and model; resolution is role > global > provider
defaults, computed at task start and frozen into the run. `POST /api/agent/test`
runs a real probe (version check plus a minimal live turn) against whatever is
configured.

Four things about settings worth knowing, because they are the difference between
a preferences pane and a control:

- **Turning a skill off stops that stage being automatic.** `advance` reads the
  file before it plans a run; a disabled skill is not run and the stage becomes a
  gate for you. Verified end to end.
- **An MCP server's `scope` is enforced, not decorative.** It lists the stages the
  server is available to, so one server's credentials never reach an agent working
  on something else.
- **`env` holds variable names, never values.** A settings file is not somewhere a
  secret can leak from, and the parser refuses one that tries.

### API

| Endpoint | What it does |
|---|---|
| `GET /api/projects` | Scan every workspace. The board is a projection of this. |
| `GET /api/gates` · `GET /api/open-gates` | Gates and what a human still owes. |
| `POST /api/decide` | Append one decision. Rejects an override with no reason, and a pass with no evidence. |
| `GET`/`PUT /api/settings` | Read and write `governance.settings.json`, validated on both sides. |
| `GET /api/chain` | The skill chain, with each skill's path **read from disk** so a skill the settings name but the machine lacks is visible. |
| `GET /api/mcp` · `POST /api/mcp/test` | List servers, and actually try to start one. |
| `POST /api/init` | Scaffold an effort without an agent: writes `map.md`, `GLOSSARY.md`, `spec.md` and any prototype tickets. Refuses an existing slug with 409, and a non-workspace root with 403. |
| `GET /api/session/agent` | Whether the agent CLI can execute, reported separately from whether it is installed. |
| `POST /api/session/start` | Hand the idea to `/grill-with-docs` and get the first round back. |
| `POST /api/session/answer` | Answer a round; the next round continues the same conversation. |
| `POST /api/session/finalise` | Have the session write the PRD. Refused while the frontier is open. |
| `GET /api/session?root=&effort=` | Read the session back. Runs nothing. |
| `POST /api/session/reset` | Remove an effort so its name is free again. **Without `confirm: true` it deletes nothing** and returns the list of files that would go. |

## Concept init, driven by a real grilling session

`New project` runs three steps:

```
idea  →  rounds  →  prd
```

Type one fuzzy line. Press start. The server reads `/grill-with-docs` — which is
`grilling` plus `domain-modeling` — and the agent interviews you. Each round comes
back as questions **with the answer the agent would give**, so agreeing to all of
them is one click. When the frontier is empty, the same session writes the PRD.

Nothing about the interview lives in this application. The prompts name the skill
file and say what the app needs back; they do not say how to grill. See
[ADR 0006](docs/adr/0006-grilling-session-drives-concept-init.md) for why the
prototype's own `frame` and `destination` steps were removed.

What the session writes, and where:

```
.scratch/<effort>/
  spec.md          the PRD, in the section shape the scanner reads
  GLOSSARY.md      terms, as they crystallised
  docs/adr/        one file per recorded decision
  .session/
    state.json     the conversation id and where the session is
    01.json 02.json  each round, as an artifact the app renders
    turns/         every prompt and reply, verbatim
```

Tickets are `/to-tickets`' job and design is `/codebase-design`'s, so init does not
do them. A fresh effort lands with `design` **active**, because nothing has settled
it — no effort can skip design by default.

### Starting over

A name is refused if an effort already has one, which is a guard — but a guard on
its own is a dead end, since nothing the human can press changes the name they
have. So a refusal is offered as a recovery:

1. **Show me what is there** — a preview call. It deletes nothing and returns the
   file list, which the interface displays.
2. **Remove it** — a second call with `confirm: true`, after the list has been
   seen.

The preview and the removal are the same endpoint, which is the only way to be
sure the preview describes what the action will do. Bounded to a direct child of
`.scratch/`, and it refuses to touch anything that is not a directory.

The effort name defaults to the first few words of your idea — **not** the first
forty characters of it. Slicing at a fixed offset produced directories like
`something-that-watches-my-camera-feed-an`, cut mid-word and unreadable. The full
path is shown next to the field, because the name is a directory inside a real
repository and that is worth seeing before it is created rather than after.

### When the agent cannot run

`GET /api/session/agent` reports *installed* and *can execute* separately, because
they are different facts. Where a turn cannot complete, the flow says so up front,
the session records the reason verbatim, and nothing is lost: the effort directory
and the conversation so far are on disk.

## Boundaries, and why each one exists

These are the design, not incidental constraints. Removing one changes what this
program is.

- **Loopback only.** It binds `127.0.0.1`, never `0.0.0.0`. There is no
  authentication because there is no network surface to authenticate over.
- **Foreground, no timer, no filesystem watch.** When the process exits, nothing
  is running. A background board that refreshes on its own is the hosted service
  this is not.
- **Writes only inside an effort's own `.scratch/`.** The server never accepts a
  path from a client; a gate reference is `<project>/<effort>/<gate>` and the
  resolved directory is checked to still be inside the workspace. A test tries to
  break this with traversal sequences.
- **No new source of truth.** The markdown stays authoritative. `serve` re-reads
  it on every request and caches nothing — a stale board is worse than a slow one.
- **Nothing invented.** Where a value is not known — agents running, CI status,
  token cost — the field is empty and the UI shows nothing. A plausible number on
  a governance board is worse than a blank.

## The agent runtime

Each stage spawns a headless agent CLI and hands it a **reference** to the stage:
the skill file to read, and the directory to work in. The application never
contains a stage's prompt.

That choice is the reason the protocol cannot drift: there is exactly one copy of
what `/to-tickets` means, and it is the skill file. A built-in runtime that is
*nearly* right about a protocol is worse than one that does not implement it.

`advance` prints the command and the working directory by default. `--execute` is
required to actually spawn anything, so an unattended process cannot start
spending money by accident.

## Layout

```
src/
  domain/       types.ts (the model) · stages.ts (derivation, a pure function)
  tracker/      parse.ts (markdown) · discover.ts (filesystem) · decisions.ts (the log)
  server/       http.ts (loopback API + static)
  exec/         runner.ts (headless CLI per stage)
  cli.ts        scan / serve / advance
web/            the UI. index.html + api.js (the adapter) + i18n.js
test/           node:test. Pure rules, a real filesystem, a real socket.
prototypes/     the ten-iteration design prototype this UI came from
docs/           decisions.md and the ADRs
tools/          wire-web.py, which patched the prototype into web/
```

## Tests

104 assertions, no test framework:

- **Pure rules** — parsing, stage derivation, chain enforcement, crossing reports,
  ticket classification, cycle and dangling-edge detection.
- **The real corpus** — the effort at `railyard/.scratch/methodology-view` is read
  for real when present: 13 tickets, all resolved, and no more than two of them
  raising a warning. A parser proven only against fixtures is proven against its
  author's guesses.
- **A real filesystem** — synthetic efforts in a temp directory, including one
  that asserts the scan does not touch what it reads.
- **A real socket** — the API over an ephemeral port, including four attempts to
  escape the workspace through a gate id.
- **The adapter** — that nothing is invented, and that columns come from blocking
  depth.

## Not built yet

Named so they are not mistaken for oversights:

- **GitHub mirroring.** Local markdown is authoritative; the mirror is deferred
  until the local path is load-bearing. It will be one-way out, never a second
  authority.
- **Gate SLA escalation.** The prototype had "escalate after N hours". With no
  timer in the server, there is nothing for it to run on. The field is stored.
- **Stage run history in the UI.** `advance` writes `runs/*.log` and the session
  writes `turns/*.log`; the records view does not read them yet.
- **Prototype tickets from the round.** `grilling` can conclude that a question
  needs a prototype rather than an answer. The scaffold path writes prototype
  tickets; the session path does not yet — it finishes at the PRD.
- **The parallel-agent scheduler.** `maxParallel` is stored and shown, and the
  isolation model is documented, but nothing spawns N agents yet — `advance` runs
  one stage at a time.
