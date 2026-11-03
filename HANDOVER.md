# Handover

Written while the owner was away, on an explicit delegation ("帮我 afk 后续的开发…
一切都基于你的理解和设计，因为也是实验性质的项目").

## What I did

I stopped designing and started building. Ten iterations of prototype had settled
the interface; the missing piece was everything behind it. So this is the first
real vertical slice, cut through all four layers:

```
markdown on disk  →  parser  →  domain model  →  HTTP API  →  the UI
```

It works end to end on a real repository. `npm run scan` reads
`railyard/.scratch/methodology-view` for real and reports it; `npm run serve`
draws it.

## The five decisions I made

They had been open since the first conversation. I decided them and wrote them
down, because a decision made while nobody was watching needs a trail.

| # | Decision | ADR |
|---|---|---|
| 1 | Local-first, loopback, foreground — not a hosted console | [0001](docs/adr/0001-local-first-control-plane.md) |
| 2 | Headless `claude` CLI per stage; skill files stay the only source of truth | [0002](docs/adr/0002-headless-cli-execution.md) |
| 3 | TypeScript, zero runtime dependencies | [0003](docs/adr/0003-zero-dependency-typescript.md) |
| 4 | Local markdown authoritative; GitHub mirror deferred | [0004](docs/adr/0004-local-markdown-tracker.md) |
| 5 | Web first; a desktop shell is a later wrapper | [0005](docs/adr/0005-web-before-desktop.md) |

Two of them stopped being judgement calls once I looked:

- **#2** hinged on whether a headless agent CLI exists. `claude` is on `PATH`.
- **#4** hinged on the real tracker format. There is a real effort on disk with
  13 tickets matching `docs/agents/issue-tracker.md` exactly. The parser is
  written against that corpus, and a test reads it whenever the machine has it.

## What reading `railyard`'s map changed

There is a prior effort on this same problem — `railyard`'s `methodology-view`
branch — and it had already reached conclusions I would otherwise have
rediscovered, or contradicted. Four changes came from reading it:

1. **`design` is its own stage**, between `spec` and `split`. Slices are
   sequenced against an interface; slicing first produces slices that get
   rewritten. Waivable, but only by `**Design:** none - <reason>`, so skipping is
   recorded rather than overlooked.
2. **A gate is an immutable definition plus an append-only `decisions.jsonl`**,
   and the log is the only authority on its state.
3. **Stage state is derived from artifacts, never declared.**
4. **A crossing is reported, not absorbed.** Their words: a gate that could
   detect a crossing and absorbed it "would look like governance while permitting
   exactly what it exists to prevent."

I also adopted their server boundary verbatim: loopback only, foreground, no
timer, no filesystem watch, writing only inside an effort's own `.scratch/`.

## One honest finding about your own tree

Running the scanner on `railyard` reports:

```
methodology-view         +++>>>>.   3/9  at design  13 tickets  all resolved
! stage "split" has output but "design" was never satisfied (crossed)
! stage "develop" has output but "split" was never satisfied (crossed)
```

That is not a parser bug. The map cleared and build tickets exist, but nothing
ever declared a `design` artifact, so the chain has a gap and the derivation says
so instead of smoothing it over. Whether that gap matters is yours to judge — it
may be that a wayfinder effort should satisfy `design` from its own decision
tickets, in which case the rule needs one more line.

## Where to look first

```bash
npm install
npm test              # 104 assertions, then a headless boot of the UI
npm run scan          # reads your real trees
npm run serve         # http://127.0.0.1:4173
```

Then, in order of how much I would want a second opinion:

1. `docs/decisions.md` — the five calls, and what is still open.
2. `src/domain/stages.ts` — the derivation rules. This is the load-bearing file;
   everything else projects what it decides. Two of its rules are arguable:
   whether a map's `Handoff` should stand in for `spec`, and whether `split` has
   any observable partial state (I concluded it does not, so it goes straight
   from `ready` to `complete`).
3. `src/tracker/decisions.ts` — the append-only log. I made two rules mandatory:
   an `override` needs a reason, and a `pass` needs evidence. Both are enforced
   at write time and tested.
4. `web/api.js` — the domain-to-view adapter. It is deliberately the only place
   the two shapes meet.

## What I deliberately did not do

- **Did not touch `railyard`.** Read-only. Its files are hash-frozen and its test
  census is a hardcoded manifest, so writing there would have turned its own
  route red.
- **Did not wire the concept-init wizard to a live `/grilling` session.** The flow
  is designed and demonstrable; its question bank is still reference content in
  `web/index.html`. That is the obvious next slice.
- **Did not build GitHub mirroring, SLA escalation, or stage-run history in the
  UI.** Each needs something that does not exist yet (credentials, a timer, a
  decision about log format). Listed in the README so they are not mistaken for
  oversights.
- **Did not add a dependency.** Two devDependencies, nothing at runtime.

## Rough edges I know about

- `web/index.html` is still large and has its rendering, its reference content
  and its bootstrap in one module. It wants splitting into an app module plus a
  content module, but doing that before the data layer existed would have been
  rearranging furniture.
- The `statusbar` reassignment at the bottom of the page module works but is
  ugly: it wraps the renderer to replace a claim ("daemon connected") with what
  is actually true. A cleaner version would pass the state in.
- `advance` has never been run against a real effort with `--execute`. The
  planning path is tested; the spawn path is not.
- Nothing runs the server against a repository with more than a couple of
  efforts, so the portfolio views have only ever drawn small numbers.


---

# Second pass: settings and the wizard, made real

The owner reported that **"New project" did nothing** and that **the
agent/skill/MCP settings could not be found**. Both were true, and the reasons
were different.

## Why "New project" did nothing

`wzCreate()` mutated an in-memory object:

```js
if (!PROJECTS[key]) { PROJECTS[key] = { ... } }   // memory only
closeWizard(); renderAll();
```

`PROJECTS` is reassigned by `boot()` on every read, so the project appeared and
then vanished. Nothing was written to disk. It also modelled the wrong thing: a
new effort belongs *inside* a repository, not as a repository of its own.

## Why settings could not be found

`openSettings()` worked, but the only way in was the menu bar
(`File → Project settings…`, `⌘,`). There is now a gear in the toolbar.

## What is real now

**Settings are a control, not a preferences pane.** They live in
`governance.settings.json`, the server reads that file before it plans a stage
run, and turning a skill off genuinely stops that stage being automatic. Verified:

```
$ governance advance methodology-view
stage   design
skill   codebase-design  [disabled in settings]
...
"codebase-design" is disabled in settings, so this stage will not run.
It is now a gate for you to work directly.
```

- `GET /api/chain` reports each skill's path **read from disk**, so a skill the
  settings name but the machine lacks shows as `not installed` rather than
  silently failing at run time.
- `POST /api/mcp/test` actually spawns or calls the server and reports what
  happened. Against a command that is not installed it says
  `spawn mcp-server-git ENOENT`, which is the honest answer.
- An MCP server's `scope` is enforced by `mcpForStage`, so one server's
  credentials cannot reach a stage it is not scoped to.
- `env` holds variable names only. The parser refuses a value and strips it.

**The wizard writes real files.** `POST /api/init` scaffolds
`.scratch/<effort>/` with `map.md`, `GLOSSARY.md`, `spec.md` and any prototype
tickets. Verified end to end:

```
_e2e/.scratch/camera-watch/GLOSSARY.md
_e2e/.scratch/camera-watch/issues/01-batch-queue-throughput.md
_e2e/.scratch/camera-watch/map.md
_e2e/.scratch/camera-watch/spec.md
```

and a rescan finds it: `intake ask spec complete · design active · split ready`.

Two refusals make that endpoint safe to expose: **409** on an existing slug
(never overwrite), and **403** on a root that is not a configured workspace (never
write anywhere it is told).

## Four bugs the tests caught, and one the tests caused

1. **The scaffolder was waiving design on the human's behalf.** Writing
   `**Design:** none - not decided yet` parses as a waiver, which *satisfies* the
   stage and lets the chain proceed to slicing. A tool that defaults to a waiver
   lets every new effort skip design by default — exactly what the stage exists to
   prevent. It now writes no design field, and a fresh effort lands at
   `design: active`.
2. **An unanchored field regex misread prose.** `/\*\*\s*Design\s*:?/` had no line
   anchor, so a sentence that merely *mentioned* the field was read as the field.
   Now anchored at both ends.
3. **A prototype ticket was counted as a slice.** Both live in `issues/`, so
   counting files made a freshly scaffolded effort report a spurious `crossed`
   warning. Fixed by separating slices from questions — checked against the real
   corpus, which is 6 grilling + 4 research + 2 task + **1 prototype**.
4. **Field renames stopped at the writer.** Settings moved to the server's field
   names, but `integrationBranch()` still read the old one and threw on open.
5. **The test suite wrote to the repository's own settings file.** `PUT
   /api/settings` resolved to the package root. `serve()` now takes an injectable
   `settingsPath`, and the test points it at a temp file. A suite that mutates
   what it is testing is worse than no suite, because the next run starts from a
   changed state.

## Two test-harness faults worth remembering

- **The interaction checks mutated state before the landing assertions ran.** The
  boot snapshot was taken *after* `wzCreate()` had switched the scope, so the
  assertion was reading a state the app was never in at load. Snapshot first,
  mutate second.
- **A stub `classList` that always returned false** made every "did the panel
  open" assertion pass vacuously. The shim now tracks classes for real.

## Still open

- The wizard's question bank is a designed bank, not a live `/grilling` session.
  The flow is real and writes real files; the questions are reference content.
  **This is the next slice.**
- `maxParallel` is stored and displayed; nothing spawns N agents yet.
- Gate SLA escalation has a field and no timer to run on.

---

# Third pass: the first vertical slice

Asked for: the complete project-init flow — first screen takes the idea, then the
skills produce the PRD. Four layers, end to end.

## The shape

```
idea  →  rounds  →  prd
```

The middle step is `/grill-with-docs` and **nothing about it lives in this
application.** The prompts name the skill file and say what the app needs back;
they do not say how to grill. See
[ADR 0006](docs/adr/0006-grilling-session-drives-concept-init.md).

The prototype's five-step wizard lost two steps. `frame` (which of three readings
of your sentence did you mean) and `destination` (how far does this go) asked the
human to resolve ambiguity and fix scope *before the interview*. That is the
interviewer's job, and doing it first means the human then answers questions the
skill never asked.

## What is real

Verified end to end over a real socket, with a scripted agent:

```
=== 2. start: the idea goes in, a round comes out ===
  ok   POST /api/session/start -> 201
  ok   phase is asking
  ok   two questions came back
  ok   the recommendation survived the round trip
=== 4. the PRD is written, then verified on disk ===
  ok   phase is done
  ok   spec.md has the sections the scanner reads
  ok   .session/state.json persists the session
  ok   three round artifacts
=== 5. the effort the session wrote is visible to the scanner ===
  ok   intake complete
  ok   spec complete — the PRD is real
  ok   design active — nothing waived it on the human behalf
=== 6. resume: reading the session back runs nothing ===
  ok   no extra agent turns were spent
```

`npm test` now runs three gates: 185 unit assertions, a headless boot of the UI,
and `tools/e2e-session.mjs`.

## Five decisions worth knowing

1. **One conversation per effort.** Rounds continue with `claude --resume`. The
   design tree lives in the conversation; a fresh process per round would let the
   agent re-ask what was settled. A turn with no session id is *failed*, however
   successful it looked.
2. **The app owns the round artifact, not the question text.** Each round is
   written to `.session/NN.json` in a documented shape. Scraping prose would work
   and couples the app to a model's formatting; the prose reader exists as a
   fallback and every round says which reader produced it.
3. **The idea goes in verbatim.** Not tidied. The ambiguity is the raw material.
4. **The PRD is refused while the frontier is open.** Producing one early freezes
   questions nobody asked — the failure this flow exists to prevent.
5. **A PRD turn that writes no `spec.md` is a failure**, not a quiet success.

## What the tests caught

- **`answeredRounds` counted rounds on disk, not rounds answered.** The newest
  round is the one still waiting, so every session reported one more than had
  actually been answered — and the next round number was computed from it.
- **`readSession` recomputed `done` back to `ready-for-prd`.** The PRD turn writes
  a round artifact like any other. The phase is now derived from the artifacts,
  including whether `spec.md` exists, rather than from the cached state file.
- **`intake` could never complete for a session effort.** The rule required a
  `map.md` Destination; a build effort has no map, because that is a wayfinder
  artifact. The destination for a spec-first effort is in the spec.
- **`sendJson(res, 201, withHistory(state))` without `await`.** The helper is
  async, so `JSON.stringify` ran on a pending promise and every session response
  came back as `{}` — a 201 with an empty body, which is the kind of silence that
  costs an hour.
- **Answering a finished session returned 400, not 409.** The distinction matters
  to a caller deciding whether to retry.

And two in the verification harness, both worth remembering:

- **A loop variable that shadowed a function parameter.** In `as_namespace`, the
  loop used `name = piece...`, clobbering the wrapper's own name: `const
  __API_NS = ...` was emitted as `const STAGE_LABEL = ...`. The namespace the page
  referred to was never declared, and the error surfaced far away as "cannot read
  properties of undefined".
- **A stub `classList` and un-ordered assertions**, from the previous pass, were
  fixed the same way: make the double honest, and snapshot before mutating.

## The one unverifiable link

**The real agent CLI cannot execute on this machine.** It is installed (2.0.9) and
a turn reaches for `reg.exe`, which the sandbox blocks — a `sandbox_boundary`, not
a defect. So:

- the runner is an **injected seam**;
- everything above it is tested against a scripted double;
- `GET /api/session/agent` reports *can execute* separately from *installed* by
  actually attempting a turn, not by reading a version;
- the UI says so before the human types anything.

What is **not** proven here: that a real `claude -p --resume` round trip produces
the round artifact the parser expects. Everything on both sides of that call is
tested; the call itself has never been made in this environment.

## Still open

- Prototype tickets from a round. `grilling` can conclude a question needs a
  prototype rather than an answer; the scaffold path writes those tickets, the
  session path finishes at the PRD.
- `maxParallel` is stored and displayed; nothing spawns N agents yet.
- Gate SLA escalation has a field and no timer to run on.

---

# Fourth pass: two bugs that made the page look dead

The owner reported: **"I click New project and still nothing happens."** They were
right, twice over, and both causes were mine.

## One: every inline handler was dead

The page became `<script type="module">` in the first pass, and **module scope is
not global**. In a classic script a top-level `function f(){}` becomes a global, so
`onclick="f()"` works. In a module it does not. Every inline handler in the page
threw a ReferenceError at click time, so the button did nothing at all — no
console error the human would see, no visual change. Exactly "no reaction".

Eight handlers, seven of them broken, across the whole page: `openFlow`,
`openModal`, `closeModal`, `createGate`, `runAction`, `toast`, `openWizard`. The
owner found it by clicking the one they wanted.

Fixed by publishing the handler surface on `globalThis`, with the list **computed
from the page** rather than hand-written, so a new inline handler is published by
the next run of `tools/wire-web.py`. And `tools/check-web.py` now walks the
rendered markup, collects every function an `on*` attribute names, and asserts
each is callable. It found eight; it would have found the bug.

Why the earlier checks missed it: they called `openFlow()` directly from inside the
module, which always worked, and never asked whether a *click* would.

## Two: the CLI could never be started, on Windows at all

`spawn('claude', args)` fails with `ENOENT` on Windows even when `claude` is
installed and on PATH. npm writes three shims — an extension-less shell script, a
`.cmd`, and a scripting-language variant — and the one that works is the `.cmd`.
Node's `spawn` with `shell: false` cannot start a batch file.

Then a second layer: with the `.cmd` found, the path inside it is
`%dp0%\node_modules\...`, where `%dp0%` means "the directory of this shim".
Joined literally that is `...\npm\%dp0%\node_modules\...` — not a file, and not a
diagnostic either.

Both fixes are in `src/exec/resolve.ts`: search PATH with Windows extensions
**before** the bare name, follow the shim to the JavaScript entry it names, and run
that with `node`. Arguments then travel as an array, never through a shell, so the
human's own text in the prompt cannot be read as syntax. `shell: true` was
rejected for exactly that reason.

The payoff is that the probe now reports something true and actionable:

```
available: false
version  : 2.0.9 (Claude Code)
how      : followed claude.cmd to its JavaScript entry
detail   : The CLI ran, but it is not authenticated. Log in once by running the
           CLI by hand — `claude` — and following its prompt.
           Original error: API Error: 401 ... OAuth access token is invalid.
```

Before, this environment reported `spawn claude ENOENT`, which is the least
helpful failure shape there is: it names a problem that is not the problem.

## Three: the runner was built per request

Caught by running the demo flow end to end, which is why it is worth having one.
`ports()` constructed the agent runner on every request, so anything the runner
held restarted each time — including the demo agent's round counter. Every request
produced round 1, `02.json` was never written, and the session silently never
advanced. It is built once now, per server.

Two smaller things the same run caught: the demo wrote its ADR twice, giving two
files numbered `0001`, and `tools/wire-web.py` was not self-contained — the
connection banner had been added by a hand command, so a replay produced a page
whose boot code referenced an element that did not exist. Both fixed; the replay
now emits everything from prototype anchors.

## Verifying without a credential

`npm run serve:demo` runs the whole flow against a scripted agent. It exists
because the real CLI has to be installed *and* authenticated, and those are
different failures — without it, "log in first" would block anyone from checking
whether the flow works. It is loud about what it is, at startup and in everything
it writes, because a session produced by it must not be mistaken for a real one.

`npm test` now runs five gates: 207 unit assertions, a headless boot of the UI
including every inline handler, the session over a real socket, the same with the
demo agent, and the page's own checks.

---

# Fifth pass: the notice was lying

The owner pasted the message the interface was showing:

> **agent 命令行在这台机器上无法运行。**
> The CLI ran, but it is not authenticated. Log in once by running the CLI by hand…
> 「装了」和「能跑」是两回事。会话仍会启动，但每一轮都会失败；先修 CLI。

The headline and the second line contradict each other, and the headline is the
false one. The CLI **did** run — it returned a version, executed a turn, and came
back with `API Error: 401 ... OAuth access token is invalid`. It was never unable
to run. It was not logged in.

That is one bug in three places, all mine:

1. **The probe collapsed distinct states into one flag.** `available: false` meant
   "could not be started", "ran but rejected the credentials", "was blocked by the
   host", and "returned no session id" — four situations with four different
   responses, reported identically.
2. **The message was written as prose, with the advice inside it.** So the
   interface could only repeat it verbatim, and it repeated the wrong advice:
   *fix the CLI*, when the fix is *log in*.
3. **The interface had a hardcoded headline** for the whole category. It said
   "cannot run on this machine" for every failure it saw, which meant the one
   situation where the CLI worked perfectly was described as the one where it is
   broken.

## What changed

**The failure now travels as a category, not as a sentence.** `ProbeResult` gains
a `reason`:

| reason | what it means |
|---|---|
| `not-installed` | nothing on PATH matched, or the entry it named is missing |
| `unrunnable` | found, but the process would not start |
| `not-authenticated` | it ran, and rejected the credentials |
| `blocked` | started, and the host refused to let it run a subprocess |
| `rate-limited` | temporarily out of capacity |
| `no-session` | ran, but no session id, so no conversation can be continued |
| `ok` | a turn completed |

**The advice moved out of the value.** `classifyTurnFailure` returns a reason and
the raw error, and nothing else. What to do about a failure depends on where the
reader is — a terminal, a screen, a log line — and baking one audience's
instructions into the return value is how the interface came to repeat them wrong.
The reason travels; the sentence is composed where it is shown, and localized.

**The interface says one true thing per reason**, in both languages. For the
owner's actual state it now reads:

> **The agent CLI is installed and working, but not logged in**
> Run the CLI once by hand — `claude` — and follow its prompt. It is not a fault
> in this application.
> `API Error: 401 … OAuth access token is invalid`

**And the demo path is offered.** When the real agent cannot be used but the
server was started with `--demo`, the notice says so. That is the difference
between "you cannot try this" and "you cannot try it this way yet".

## Locked down

`tools/check-web.py` renders the notice for each reason and asserts that the copy
matches it — including the negative: the `not-authenticated` notice **must not**
contain "cannot run", and the `blocked` notice **must not** mention logging in.
That is the bug, and it can no longer come back silently.

One more harness fault, of the same family as the last two: a replacement body for
`flowIdeaView` was written as a bare prefix — `function flowIdeaView(){` with
nothing after it. It was applied as a complete replacement, so the real function
became an empty shell and every brace after it shifted, surfacing hundreds of
lines away as "Unexpected reserved word" on an unrelated `await`. `wire-web.py`
now refuses a replacement body whose braces do not balance, so the failure points
at the edit instead of at the symptom.

208 unit assertions, and five gates, all green.

---

# Sixth pass: a dead end, and a notice that contradicted itself

The owner pasted two things at once, and they were separate bugs that happened to
arrive together.

## One: the demo wrote into a real repository

`H://Projects//railyard//.scratch//something-that-watches-my-camera-feed-an//` —
created 2026-10-13 21:28, which was my own demo verification run. **I removed it.**
Railyard's other uncommitted changes are the owner's own work on the
`methodology-view` branch (timestamps 10-12 16:09–16:11) and were not touched.
Nothing else of mine is in that repository: `advance` was only ever run as a dry
run, so no `runs/` directory was created.

Two faults produced that name, and both are fixed:

1. **The slug was the first forty characters of the idea**, sliced at a fixed
   offset — hence `…-feed-an`, cut mid-word. It now takes a few whole words:
   `something-that-watches`.
2. **Nothing showed where it would land.** The hint said `.scratch/{slug}/`,
   which does not make "a directory inside this repository" concrete. The idea
   screen now shows the **full path**, which is what makes a poor name look poor
   *before* it is used.

## Two: refusing a name was a dead end

`a session already exists for "…"; resume it, or remove …` — true, and useless.
The server was right to refuse to overwrite, but there was nothing the human could
press to get past it. A guard with no way through is a wall.

`POST /api/session/reset` now exists, and its shape is the point:

- **`confirm: false` deletes nothing.** It returns the list of files that *would*
  go, which the interface shows. The preview and the removal are the same
  endpoint, so the preview cannot describe something other than what the action
  does.
- **`confirm: true` removes the effort.** The whole thing, not just `.session/`:
  clearing the conversation while leaving `spec.md` behind would make the scanner
  report a finished spec for an effort with no session — a state that never
  happened.
- Bounded to a direct child of `.scratch/`, refuses a non-directory, and reports
  a name that is not there as 404.

In the interface this is two steps with the file list between them, and after the
removal it simply starts, since starting is what the human was trying to do.

## Three: demo mode reported the real CLI's credentials

With `--demo`, the notice read: *the agent CLI is installed and working, but not
logged in* — and immediately below it, *this server was started with `--demo`, so
you can still walk the flow*. Both true, and together incoherent.

In demo mode the real CLI is now **not probed at all**. The demo is what will run,
so the demo is what is reported: `available: true, reason: 'demo'`, shown as a
neutral note rather than a red error. Skipping the probe also removes the several
seconds a real turn costs from every page load.

## Locked down

| What the bug was | What now fails if it returns |
|---|---|
| a slug cut mid-word | `test/web.test.mjs` asserts the exact slug for the idea that produced it, and that no cut-off word survives |
| a refusal with no way out | `tools/e2e-session.mjs` walks refusal → preview → still-there → confirm → gone → name reused |
| a preview that deletes | the same suite asserts `confirm:false` changes nothing and the session is still readable |
| the file list not being shown | `tools/check-web.py` renders the confirmation and asserts every file from the preview appears, with the count |
| a confusing demo notice | the notice check asserts `reason: 'demo'` renders the demo headline and **no** credential advice |

219 assertions, five gates, all green.

---

# Seventh pass: a Multica-flavored reskin, with light / dark / system

The owner supplied screenshots of Multica's interface and asked for that
register: clean, hairline-bordered, generous whitespace, black primary buttons
— plus theme switching.

## What changed

- **`tools/theme.css`** — an override layer, appended after the prototype's
  stylesheet, touching nothing in it. Two moves: token remap for light (white
  chrome surfaces, `#f7f7f8` canvas, hairline `rgba(0,0,0,.085)` borders,
  near-zero shadows, black primary buttons, neutral menu/settings highlights —
  blue is reserved for state, not for hover), and `html[data-theme="dark"]`
  remapping the same tokens to a zinc palette, including lighter variants for
  every `-d` tinted-text color and dark overrides for the handful of hardcoded
  `#fff` surfaces tokens could not reach.
- **`web/theme.js`** — the theme manager. Three modes (`light` / `dark` /
  `system`), one attribute on `<html>`. Loads as a classic script in `<head>`
  before the module boots, so the resolved theme is on the element before
  first paint and there is no flash. `system` tracks the OS live via
  `matchMedia`; the choice persists in `localStorage`.
- **The menubar grew a theme chip** next to the language chip: Light → Dark →
  System, one click each, with a toast saying which.
- **`tools/theme-wire.py`** — because `wire-web.py` is a one-shot patcher over
  the pristine prototype, a replay would produce a page without this layer.
  The injector re-applies all three edits (style block, script tag, chip) and
  is idempotent: it was run twice in a row and the second run changed nothing.

## Verification

`node --test` 219/219, `check-web.py` OK (all inline handlers still callable),
both e2e gates ALL PASS, `tsc` clean. `serve:demo` serves the layer: `GET /
200`, `GET /theme.js 200`, `data-theme-layer` present in the served page.

## One honest caveat

The dark palette is derived from the tokens, not screenshots of a real dark
reference — Multica's own dark mode was not in evidence. If it drifts from what
the owner wants, the fix is confined to `tools/theme.css` and one re-run of the
injector.

## Seventh pass, second slice: the new-project flow became a modal

The owner asked for it: "新增项目" must open a dialog, not take over the page.
The concept-init flow had been a full-screen takeover since the prototype; the
design is unchanged, only its container.

- `.wizard` is now an overlay (dimmed, blurred backdrop) with a centered
  `.wz-win` window — `min(1020px,96vw)` by `min(700px,90vh)`, the same pattern
  as the settings window. The shell in the markup gained the one wrapper div;
  every renderer inside it is untouched.
- Clicking the backdrop does nothing on purpose. A stray click mid-sentence
  must not throw away a half-typed idea; ESC and the back button close it.
- ESC never actually closed the flow: the keydown handler tested `WZSTATE.open`
  while `openFlow()` only set `FLOWSTATE.open`. Now both are set on open and
  cleared on close, so ESC works — which a borderless takeover never needed,
  but a floating window does.

---

# Eighth pass: a real API transport beside the CLI

Asked for: wire in real agent calls through an API. The seam already existed;
what was missing was a second implementation of it.

## What is real now

- **`src/exec/apiagent.ts`** — `apiRunner`, the same `AgentRunner` seam. A bare
  model call cannot read skill files or write artifacts, so the runner supplies
  both: skill files the prompt names are read from disk and inlined into the
  system block; file access is a two-tool loop (`read_file`, `write_file`)
  whose writes are refused outside the effort directory; the message history
  persists to `.session/api-history/<key>.json` and is replayed each turn, so
  rounds continue one conversation without `--resume`. A turn whose history
  cannot be saved fails, whatever the reply said.
- **Settings** — `agents.transport` (`cli` | `api`, default `cli`),
  `agents.apiBase`, `agents.apiModel`, `agents.apiMaxTokens`, and
  `agents.apiKeyEnv` — a variable *name*, read from the environment at call
  time. A settings file is still not somewhere a secret can leak from.
- **The probe** — `probeApi` reports the same `ProbeReason` set as `probeCli`,
  so the interface needed no new copy. `GET /api/session/agent` picks the probe
  from the transport.
- **`docs/adr/0007`** — the decision, plus the round-artifact shape that
  `prompt.ts` had been pointing at since it was written (the file did not
  exist; now it does).

## Honest boundaries

- `advance` still spawns the CLI only; the API transport covers the session
  flow. Stage prompts lean harder on file access, and that path needs its own
  slice.
- Verified against a scripted fetch double (228 assertions now, +9): tool
  loops, history replay, path refusals, 401/missing-key classification. A real
  round trip against the live API has not been made here — no key on this
  machine — the same named gap the CLI transport carries.

All gates green: 228/228 unit, web checks, both e2e, tsc.

---

# Ninth pass: a multi-provider executor, OpenCode by default

Asked for: upgrade the agent system so OpenCode is the default executor with
user-configured providers, Claude is opt-in, roles can override the executor,
and no key is ever persisted. The task's own instruction was the right one:
audit first, plan, then cut.

## What is real now

- **`src/exec/adapters.ts`** — the `CliAdapter` seam: `turnArgs(turn)`,
  `probeTurnArgs`, `versionArgs`, `parse`. `claudeAdapter` carries the previous
  argv verbatim; `opencodeAdapter` builds `run --format json --auto [--model
  provider/model] [--session <id>] <prompt>` and parses the NDJSON event
  stream (sessionID on every event, `text` → `part.text`, `error` →
  `error.data.message`). Unknown CLI ids fall back to the Claude adapter — the
  exact pre-adapter behaviour — with a settings warning.
- **`spawnRunner`/`probeCli` are adapter-driven.** Same spawn/timeout/parse
  pipeline, argv from the adapter. One probe implementation, six failure
  categories, both CLIs.
- **Settings.** `agents.providers.<cli>` (`provider`/`model`/`baseUrl`/
  `apiKeyEnv`, explicit-empty semantics so Ollama-without-a-key is expressible)
  and `agents.roleAgents.<role>`. An `apiKey` VALUE anywhere in there is
  refused with a warning — the MCP `env` rule, extended. Migration: fresh
  installs default to `opencode`; a file with an `agents` block but no `cli`
  keeps `claude` (its implicit historical choice); an explicit choice survives
  verbatim.
- **`resolveAgentFor(settings, role?)`** — role > global > provider defaults,
  `inherit`/empty fall through, computed at task start and frozen into the
  turn. Consumed by the session ports, the runner cache key, and `advance`'s
  plan (which now names the CLI it will actually spawn, not always `claude`).
- **`POST /api/agent/test`** — a real connection test: the adapter's version
  check plus a minimal live turn, against the configuration being edited.
  Reports `apiKeySet` (whether the named variable exists) — never the key.
- **Settings UI** — the CLI row is a dropdown (OpenCode · default / Claude
  Code); a Provider section with the four fields and a Test button whose
  result line shows reason + detail; a Role overrides section (CLI + model per
  role); a rate-limit note on the concurrency section. All writes go through
  `persistSettings`; nothing new is display-only.

## What is deliberately not claimed

- **OpenCode is not installed on this machine.** Its argv and event parsing
  are verified against the published CLI docs and community event references
  and covered by fixture tests; a live `opencode run` has never been made
  here. First real run on an installed machine is the verification step.
- **DeepSeek Harness / WorkBuddy CLI are not implemented and not offered in
  the dropdown.** An adapter ships when its protocol can be verified.
- Parallel execution, worktree isolation, retries, timeouts and gate
  behaviour are untouched — `maxParallel`/`isolation` remain stored and
  displayed, and the parallel scheduler still does not exist (unchanged
  honesty from previous passes).

## Gates

244/244 unit assertions (+16: defaults, migration, key refusal, resolution
precedence, per-CLI argv including hostile-prompt-as-one-argument, NDJSON
parsing, adapter-driven probe with a fake spawn), web checks OK, both e2e
ALL PASS, tsc clean. Live: `POST /api/agent/test {"cli":"opencode"}` answers
`not-installed` honestly on this machine; `GET /api/settings` shows the local
file's explicit `claude` choice preserved with the new fields filled in.

---

## Two live bugs from real use (2026-11-02)

Both were reported from the running app, not found by a test.

### One: `#feature=<project>/<feature>` was read and then ignored

`readSelectionFromHash()` returned the whole `project/feature` string under the
key `selected`, while every reader indexes the selection by *project name*. The
hash was therefore decoded, stored, and never matched anything; `boot()` left
`STATE.project` at its initial value and the page opened on a different project
while the address bar said otherwise.

The old web-harness assertion checked `.selected === 'railyard/second-feature'`
— the joined string — and passed for as long as the bug existed. A test that
agrees with the defect is worse than no test, so it was replaced with one that
asserts the split *and* that the page moves.

Now: split at read time, applied at boot against the real project list, a
`hashchange` listener for a link pasted without a reload, and a spoken answer
(`boot.hashProject` / `boot.hashFeature`) when the link names something that is
not open — rather than silently opening somewhere else.

### Two: the design stage could never complete, so the AFK chain always stopped there

The completion rule was `(specFile || hasHandoff) && designDeclared`, and
`designDeclared` meant a `**Design:**` field in `spec.md` — nothing else. The
design run writes `design.md`. `STAGE_RECORD` in `runner.ts`, whose comment says
it exists "so the prompt names the same contract the scanner reads", covered
review/ship/retro but **not design** — so the design prompt never named any
record at all.

`project/.scratch/repalce-name` ran `codebase-design` twice, both succeeded,
both wrote a thorough `design.md`, and the stage stayed `active` behind them.
The chain stopped with "the run did not advance the stage", which is a true
sentence about a false premise.

Fixed on both sides: `designFile` is a fact (design.md, read — an empty one
declares nothing), design completes on it, and the prompt now names it. Live
after the fix, `repalce-name` derives to `split` with no run, and
`governance advance repalce-name` plans `split` / `to-tickets`.

**A wayfinder feature with only a Handoff is still at `design`, deliberately.**
The `spec` stage accepts a Handoff because a map's protocol never writes a
spec.md; adding the same exemption to `design` would make the stage complete
without ever asking the design question, and it would never run. Instead the
prompt now tells that run to leave `design.md` — verified in a dry run on
`railyard/methodology-view`.

### Three: a stop was invisible

Every stop the AFK chain makes is designed, and every one of them was written
only to `console.warn`. A run succeeded and then nothing happened, with no way
to tell "finished" from "stopped" and no way to tell which gate was holding it.

- `chain.stopped` is a journal kind. The stop is written next to the run it
  followed, with the reason and — when a gate caused it — the gate ids.
- An `onStop` hook puts the same sentence on the run's activity line.
- `GET /api/runs` returns `lastStop`, and the runs card shows it. The activity
  line does not survive a restart; the journal does.
- The activity dock now asks once more, after a beat: the stop is decided after
  the run settles, so a dock that stopped polling at that instant never showed
  it.

### A harness that lied, again

`tools/mutate.mjs` spread `m.tests` — and a bare string spreads into its
*characters*, so node was asked to run a file called `d`. Every verdict came
back CAUGHT for a reason that had nothing to do with the tests. Normalised, and
it now refuses a malformed `tests` entry instead of reading it as a verdict.

### Gates

532/532 unit assertions, web checks OK, i18n 625 used / 979 defined, both e2e
ALL PASS, tsc clean.

Mutation sweeps, all with a passing canary:
- design artifact: 6/6
- chain stop: 7/7
- hash routing: 8/8
- stop visibility: 6/6
