# 2. Headless CLI as the agent runtime

Date: 2026-10-13
Status: accepted

## Context

Each stage of the loop needs an agent to do work: clarifying, prototyping,
specifying, slicing, building, reviewing. Two options were on the table:

- **A headless agent CLI**, spawned per stage, told which skill file to read.
- **A self-built runtime**, where the application owns the prompts and calls a
  model API directly.

The environment was inspected rather than assumed. `claude` is present on `PATH`
at `%APPDATA%\npm\claude`.

## Decision

Spawn a headless agent CLI per stage. The prompt names the skill file to read and
the working directory to operate in. **The skill files remain the single source of
truth for what each stage does.**

## Rationale

The self-built runtime was rejected on a specific failure mode, not on effort: it
duplicates semantics the skill files already own. A skill file that changes — a
sharper question in `/grilling`, a new rule in `/to-tickets` — would leave the
built-in prompt silently stale, and a runtime that is *nearly* right about a
protocol is worse than one that does not implement it at all.

Driving the CLI means the protocol cannot drift, because there is only one copy
of it.

## Consequences

- The application never contains stage prompts. It contains stage *references*.
- Agent output is captured, not interpreted. The stage's effect is judged by the
  artifacts that appear on disk, which is the same rule used for stage derivation
  everywhere else.
- Execution is opt-in: the default is a dry run that prints the command and the
  working directory. `--execute` is required to actually spawn anything, so an
  unattended process cannot start spending money by accident.
- The CLI is a dependency in a way a library would not be: its availability,
  flags, and output shape can change underfoot. The runner is therefore small and
  its invocation is asserted by a test.
