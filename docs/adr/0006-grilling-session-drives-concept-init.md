# 6. The grilling session drives concept init

Date: 2026-10-13
Status: accepted

## Context

The first vertical slice had to answer one question: when a human types a fuzzy
idea, what actually happens next?

The prototype answered it with a five-step wizard of its own invention. Two of
those steps — `frame` (which of three readings of your sentence did you mean) and
`destination` (how far does this go) — asked the human to resolve ambiguity and
fix scope **before anything had been discussed**. That is the work `grilling`
exists to do, and a hand-written guess about what a skill will conclude is worse
than not asking: it pre-empts the interview with the interviewer's assumptions,
and the human then answers questions the skill never asked.

## Decision

The flow is three steps, and the middle one is the skill's:

```
idea  →  rounds  →  prd
```

**`/grill-with-docs` drives the middle step, and the app does not duplicate it.**

Four consequences, each of which was a real decision:

### The app owns the round artifact, not the question text

Each round is written to `.scratch/<effort>/.session/NN.json` in a documented
shape (`prompt.ts` owns it). The app reads that file.

Scraping questions out of the agent's prose would work — `grilling` does define a
round format — and it is the wrong default, because it couples the app to how a
model formatted its output on a given day. Asking for a file makes a round an
artifact like everything else this system reads. The prose reader exists as a
**fallback**, and every round records which reader produced it, so a silent
degrade to prose-scraping is visible in the UI rather than inferred.

### One conversation per effort

Rounds continue with `claude --resume <sessionId>`. The design tree lives in the
conversation's context; a fresh process per round would force the agent to rebuild
it from the artifacts and — worse — let it re-ask what was already settled. A turn
that returns no session id is therefore treated as **failed**, however successful
it looked, because the conversation cannot be continued.

### The prompt references the skill, and never restates it

Every prompt says which file to read and what the app needs back. None of them say
how to grill, when to offer an ADR, or how to sharpen a term. There is one copy of
each protocol and it is the skill file; a second copy here would drift.

### The human's own idea goes in verbatim

Not tidied, not summarised. The ambiguity is the raw material.

## Consequences

- **Two features the prototype had are gone.** There is no reading-picker and no
  scope-picker before the interview. If either turns out to be wanted, it belongs
  *after* a round, as an answer — not before.
- **A session is durable by construction.** `state.json` plus the round artifacts
  live under the effort, so closing the laptop and coming back resumes at the same
  round, and a refresh runs no agent turn.
- **The PRD is refused while the frontier is open.** Producing one early would
  freeze questions nobody asked, which is the failure the whole flow exists to
  prevent. `force` exists for a human who genuinely wants to stop.
- **A PRD turn that writes no `spec.md` is a failure**, not a quiet success. A
  session that claims to be done with nothing to show is worse than one that says
  it failed.
- **`intake` can complete from a spec.** A build effort has no `map.md` — that is
  a wayfinder artifact — so requiring a map left every session-produced effort
  with an intake stage that could never complete. The destination for a
  spec-first effort is in the spec's Problem and Solution.
- **The agent CLI cannot be verified on every machine.** Here it is installed and
  cannot execute: it reaches for a program the sandbox blocks. The runner is
  therefore an injected seam, everything above it is tested against a scripted
  double, and `GET /api/session/agent` reports *can execute* separately from
  *installed*. The UI says so before the human types anything.
