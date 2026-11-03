# 3. TypeScript with no runtime dependencies

Date: 2026-10-13
Status: accepted

## Context

The implementation stack was open. The prototype is vanilla JS with no build step,
which kept it cheap to iterate on but gives no guarantees at the boundaries that
now matter: parsing arbitrary markdown into a typed model, and reading a
filesystem whose shape is not guaranteed.

## Decision

TypeScript, compiled with `tsc`. **Zero runtime dependencies.** Node's built-in
`node:test` is the test runner and `node:http` is the server.

`typescript` and `@types/node` are the only entries in `package.json`, both
devDependencies.

## Rationale

The layer that most needs types is the parser: it turns untrusted text into the
objects everything else reasons about. `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` are all on, because the failure this code has to
avoid is silently treating a missing field as an empty one.

The dependency count is a deliberate zero rather than a small number. A control
plane that reads arbitrary local repositories and spawns processes is a poor place
to inherit a transitive tree. Node's standard library covers everything needed:
HTTP, filesystem, child processes, and a test runner.

## Consequences

- The frontend stays plain ESM, served statically, with no bundler. The prototype's
  design system is already validated in that form; introducing a bundler would be
  work with no buyer.
- Tests run as compiled JavaScript under `node --test dist/test/`. There is no
  watch mode and no coverage threshold — the value here is assertions that encode
  real rules, not a number.
- Compilation is a required step before running, so `npm test` builds first.
