# 1. Local-first control plane, not a hosted service

Date: 2026-10-13
Status: accepted

## Context

The ten prototype iterations assumed a multi-project workbench. The open question
was whether that becomes a hosted multi-user console or stays on one machine.

A prior effort in `railyard` (`methodology-view`) had already drawn this boundary
and written down why: a hosted runtime and a background service are excluded by
that repository's own scope, and the loop should not become either. The stated
constraint was that the serving surface be **loopback only, foreground, no timer,
no filesystem watch**.

## Decision

The control plane runs on one machine, as a foreground process, serving only
`127.0.0.1`. It writes only inside a workspace's own `.scratch/` directory.

No authentication, because there is no network surface to authenticate over.

## Consequences

- Multi-project support survives: the workspace list lives in a local config file,
  not in a database. Portfolio views read many workspaces from one process.
- No user accounts, no sessions, no tenancy. The "role" concept in gates stays a
  label for who *would* approve, not an enforceable permission — and that is
  honest, where a fake permission check would not be.
- When the process exits, nothing is running. There is no state to reconcile on
  restart beyond the files already on disk.
- A future hosted mode would be a different product with a different ADR, not an
  extension of this one.
