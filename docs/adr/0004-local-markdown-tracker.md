# 4. Local markdown is the tracker, and the only source of truth

Date: 2026-10-13
Status: accepted

## Context

Efforts need somewhere to record decisions, tickets, blocking edges and stage
progress. Three options: GitHub Issues, a local database, or local markdown files.

This was settled by evidence rather than preference. A real effort already exists
on disk — `H:\Projects\railyard\.scratch\methodology-view` — with a `map.md` and
thirteen resolved tickets under `issues/`. Its layout matches the conventions in
`docs/agents/issue-tracker.md` exactly.

## Decision

Local markdown under `.scratch/<effort>/` is authoritative. The application reads
it and projects it; it does not own it.

Layout, as already in use:

```
.scratch/<effort>/
  map.md                  # Destination, Notes, Decisions so far,
                          # Not yet specified, Out of scope
  issues/NN-<slug>.md     # one ticket per file, never a combined file
  decisions.jsonl         # append-only gate decisions
```

A ticket carries `**Type:**`, `**Status:**` and `**Blocked by:**` as lines near the
top, with `## Question`, `## Proposed answer`, `## Comments` and `## Answer`
sections below.

## Rationale

- The files are readable, diffable and committable without the application. A
  tracker only the application can read is a tracker that holds the project
  hostage.
- Keeping the markdown authoritative means the application can be replaced without
  a migration. The data outlives the tool.
- It matches what the skill chain already writes, so there is no import step and
  no second format to keep in sync.

## Consequences

- The application never rewrites a ticket's prose. It appends a decision record;
  it does not edit the markdown body. Editing prose is the agent's or the human's
  job, through the skill chain.
- GitHub mirroring is deferred. It needs credentials and a conflict-resolution
  story, and neither is worth inventing while the local path is still proving
  itself. When it arrives it will be a **one-way mirror out**, never a second
  authority.
- The parser must tolerate hand-written variation: inconsistent heading levels,
  missing optional sections, and tickets that carry a status the code does not
  recognise. It degrades to a visible warning rather than dropping the ticket.
