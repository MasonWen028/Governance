# 9. `effort` is a feature

Date: 2026-11-01
Status: accepted

## Context

The unit of work this tool drives was called an *effort*. The word was wrong in
a way that mattered more than spelling: in estimation, "effort" is a measure —
how much a piece of work costs. In this system the unit is the work itself: the
thing with a destination, a spec, tickets, a branch and an eventual release.

The distinction shows up in the record. A journal line says *what happened to
the work*, not *how much the work cost*. `change.followed-up` points at the
feature the work moved to. `derivedFrom` names the parent work. Calling that
"effort" let a reader hear a statistic where the record meant an artefact.

The rename was requested directly: *"effort是效率上的统计学概念， feature才是具体
的工作."*

## Decision

**The word is `feature`, everywhere a human or an API can see it.** Identifiers,
query parameters, request bodies, UI copy, i18n keys, prompts and tests. The
rename is mechanical and total: a codebase that says `feature` in one layer and
`effort` in another is a codebase with two names for one thing, and the two
would eventually disagree.

**The files on disk keep what was written.** Every record this tool leaves
behind — `.session/state.json`, `runs/<jobId>.json`, the journal, a saved
`#feature=` link — was written under the old key, and some of them are the only
trace of a session that already happened. Those files are the record of *what
happened*, and what happened used the old word. Rewriting them so they look
modern would be editing the past to suit the present, which is the one thing a
governance tool must never do to its own evidence.

So the rule is narrow and deliberately one-directional:

> **Writers emit `feature`. Readers accept either.**

`src/domain/legacy.ts` is the only module that knows about the old spelling, and
it is read-only. Five boundaries use it:

| Boundary | Old | New |
| --- | --- | --- |
| Query parameter / request body | `effort=`, `b.effort` | `feature=`, `b.feature` |
| Session state | `state.json` `effort`, `effortDir` | `feature`, `featureDir` |
| Run record | `runs/*.json` `effort` | `feature` |
| Journal event kind | `effort.derived` | `feature.derived` |
| Branch template | `{effort}` | `{feature}` |

**The journal translation happens at the read boundary, and only there.**
`readJournal` gates every line on its kind, so an unrecognised kind is not
merely ignored — it is a line that stops being history. `kindOf` accepts
`effort.derived` and reports it as `feature.derived`. This is a translation of
vocabulary, not of fact: the file keeps the bytes that were written, and nothing
in this tool rewrites them. One place does the translating, so there is no
second opinion for the two to disagree with.

**A reader reports the value that is there.** `legacyString` treats a key that
is *blank* as absent and falls through to the old spelling — a half-written
record is read as the value it does have. It does not treat *whitespace* as
blank. Deciding at the reader that a whitespace value is corrupt would put a
second judgement where one is enough; the slug rule downstream is already the
single place that decides what a valid name is.

## Consequences

- **No migration step, and no flag day.** A workspace written before the rename
  loads unchanged, and one written after loads without a version marker. There
  is nothing to run and nothing to schedule.
- **The old spelling is never deleted.** It is read-only vocabulary in one
  module, exercised by tests written against the *old* file shapes. A fixture
  using the new spelling could not tell a working fallback from an unnecessary
  one, so `test/legacy.test.ts` builds its fixtures the way an older build wrote
  them.
- **Five fallbacks, five mutations.** Each boundary was broken deliberately and
  confirmed to fail a test before being restored: removing the journal kind
  translation, the run-record normalisation, the state-file normalisation, the
  `{effort}` template case, and the legacy query parameter each fail a distinct
  assertion. An untested compatibility shim is a claim, not a guarantee.
- **Verified against real records, not fixtures.** After the rename, the live
  workspace was read back through the HTTP API: the `html-hello-world` session
  (a real DeepSeek conversation, eight rounds, `state.json` still carrying
  `"effort":`) resumes with its idea and history intact; `html-hello-world-ch-02`
  still reports its lineage from a journal line that literally says
  `effort.derived`; its three run records still resolve their feature. The
  journal read produced zero warnings, meaning no line was dropped. All four
  files still contain the old keys — which is the point.
- **Directory names are untouched.** `.scratch/<slug>` paths were never named
  after the concept, so no workspace moved and nothing on disk was renamed.
