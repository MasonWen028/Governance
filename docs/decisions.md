# Engineering decisions

Five decisions were left open through ten iterations of the prototype. The owner
went AFK and delegated them explicitly ("一切都基于你的理解和设计，因为也是实验
性质的项目"). They are recorded here because a decision made while nobody was
watching is exactly the kind of thing that needs a paper trail.

Each has a full ADR under `docs/adr/`.

| # | Decision | Chosen | ADR |
|---|---|---|---|
| 1 | Form factor | Local-first, multi-project, loopback server | [0001](adr/0001-local-first-control-plane.md) |
| 2 | Agent execution | Headless `claude` CLI driving the existing skill files | [0002](adr/0002-headless-cli-execution.md) |
| 3 | Tech stack | TypeScript, zero runtime dependencies | [0003](adr/0003-zero-dependency-typescript.md) |
| 4 | Tracker | Local markdown as the source of truth | [0004](adr/0004-local-markdown-tracker.md) |
| 5 | Desktop timing | Web first; a desktop shell is a later layer | [0005](adr/0005-web-before-desktop.md) |

## What was decided on evidence, not preference

Two of the five stopped being judgement calls once the environment was inspected:

- **Decision 2** depended on whether a headless agent CLI exists. `claude` is on
  `PATH` at `%APPDATA%\npm\claude`. The alternative — a self-built runtime that
  reimplements each stage's prompt — was rejected because it duplicates semantics
  the skill files already own, and duplicated semantics drift.
- **Decision 4** depended on what the tracker format actually is. It is not a
  guess: a real effort exists on disk at `H:\Projects\railyard\.scratch\methodology-view`
  with a `map.md` and thirteen `issues/NN-slug.md` tickets, matching
  `docs/agents/issue-tracker.md` exactly. The parser is written against that real
  corpus, not against an imagined one.

## Convergence with a prior effort

`railyard`'s `methodology-view` map already charted this same problem and reached
conclusions that this build adopts rather than rediscovers. Reading it changed the
design in four places:

1. **`design` is its own stage.** Their reasoning: slices are sequenced against an
   interface, so slicing before the interface is fixed produces slices that get
   rewritten. The loop is `intake → ask → spec → design → split → develop →
   review → ship → retro`, not eight stages with design folded into spec.
2. **A gate is an immutable definition plus an append-only `decisions.jsonl`**,
   and that log is the only authority on the gate's state. "A button that mutates
   state without a record is an authority nobody can audit."
3. **A stage's state is derived from artifacts, never declared.** A stage cannot
   claim to be complete; the presence of the artifacts it produces makes it so.
4. **No percentage anywhere.** A progress percentage over a set of stages implies
   a precision the loop does not have. Stage states are discrete and that is all
   that is shown.

Two boundaries from that map are adopted verbatim for the server, because they are
what keep this from becoming the hosted service it should not be: **loopback only,
foreground, no timer, no filesystem watch, writing only into a workspace's own
`.scratch/`.**

## What this deliberately is not

- Not a hosted service, not a scheduler, not a deployment mechanism. Deployment is
  approved and recorded here; performing it stays outside.
- Not a background daemon. When the process exits, nothing is watching.
- Not a second source of truth. The markdown stays authoritative; the server reads
  it and the UI projects it.

## Still open (not decided, deliberately)

- **GitHub mirroring.** Decision 4 keeps markdown authoritative and defers the
  mirror. Mirroring needs credentials and a conflict story, neither of which is
  worth inventing before the local path is load-bearing.
- **Gate SLA escalation.** The prototype had an "escalate after N hours" setting.
  With no timer in the server, escalation has nothing to run on. Recorded as a
  gate field, not yet acted on.
- **Cost accounting.** The prototype showed a token cost. Nothing produces that
  number yet; it is displayed only when a real figure exists (`settings.cost`).
