import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  classifyTicket,
  completedCount,
  cycles,
  danglingBlockers,
  deriveStages,
  operatingStage,
} from '../src/domain/stages.js';
import { emptyFacts, STAGE_IDS } from '../src/domain/types.js';
import type { ArtifactFacts, StageId, StageState } from '../src/domain/types.js';

function facts(patch: Partial<ArtifactFacts> = {}): ArtifactFacts {
  return { ...emptyFacts(), ...patch };
}

/** Convenience: the states as a compact string, `++>..` style. */
function strip(stages: Readonly<Record<StageId, StageState>>): string {
  const g: Record<StageState, string> = {
    complete: '+',
    active: '>',
    ready: '.',
    blocked: '!',
    waived: '~',
    absent: ' ',
  };
  return STAGE_IDS.map((id) => g[stages[id]]).join('');
}

test('a fresh feature has everything absent', () => {
  const { stages } = deriveStages(facts());
  assert.equal(strip(stages), '         '.padEnd(9).slice(0, 9));
  assert.equal(stages.intake, 'absent');
});

test('a feature directory alone advances intake to active', () => {
  const { stages } = deriveStages(facts({ featureDir: true }));
  assert.equal(stages.intake, 'active');
});

test('naming a destination completes intake', () => {
  const { stages } = deriveStages(facts({ featureDir: true, destinationNamed: true }));
  assert.equal(stages.intake, 'complete');
  assert.equal(stages.ask, 'ready');
});

test('glossary terms complete ask and open spec', () => {
  const { stages } = deriveStages(
    facts({ featureDir: true, destinationNamed: true, glossaryTerms: 6 }),
  );
  assert.equal(stages.ask, 'complete');
  assert.equal(stages.spec, 'active');
});

test('a spec file completes spec, not design', () => {
  const { stages } = deriveStages(
    facts({ featureDir: true, destinationNamed: true, glossaryTerms: 2, specFile: true }),
  );
  assert.equal(stages.spec, 'complete');
  // Design needs an explicit declaration, so it is active — started, not done.
  assert.equal(stages.design, 'active');
});

test('design completes on the design artifact, not only on a field in the spec', () => {
  /* The real shape of project/.scratch/repalce-name: two succeeded
   * `codebase-design` runs, each writing a full design.md, and the stage still
   * derived to `active` — because completion read a `**Design:**` field in
   * spec.md and nothing else. The AFK chain then stopped on a stage whose work
   * was already on disk, with "the run did not advance the stage" as the only
   * explanation, which is a true sentence about a false premise.
   *
   * design.md is the record this stage writes. A feature that has written it has
   * declared a design as surely as one that has filled in the field; requiring
   * both asks the agent to write the same decision twice and rewards it by
   * stalling. */
  const { stages } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designFile: true,
    }),
  );
  assert.equal(stages.design, 'complete');
  assert.equal(stages.split, 'ready');
  assert.equal(operatingStage(stages), 'split');
});

test('a design with no plan behind it is a crossing, not a completion', () => {
  /* The prerequisite is what makes the ladder a chain. Dropping it would let
   * design.md alone complete the design stage on a feature that never wrote a
   * spec or a Handoff — the ladder certifying a design for work that has no
   * plan. It is reported, not absorbed: the artifact exists, so the stage is
   * `active` and says what it crossed. */
  const { stages, crossed } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      designFile: true,
    }),
  );
  /* What the rule would do without its prerequisite: `done` is satisfied by the
   * record alone, so the stage lands on `active` and reports a crossing over a
   * plan that was never written. With it, the record is simply early — the
   * stage waits at `ready` and the ladder says nothing happened out of order,
   * because nothing has. */
  assert.equal(stages.spec, 'active');
  assert.equal(stages.design, 'ready');
  assert.deepEqual(crossed, []);
});

test('design completes when declared, and waives with a reason', () => {
  const declared = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designDeclared: true,
    }),
  );
  assert.equal(declared.stages.design, 'complete');

  const waived = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designDeclared: true,
      designWaived: true,
    }),
  );
  assert.equal(waived.stages.design, 'waived');
  // A waiver satisfies the chain, so slicing may proceed.
  assert.equal(waived.stages.split, 'ready');
});

test('a Handoff section stands in for the spec on a map feature', () => {
  // This is the real shape of railyard/.scratch/methodology-view: charting wrote a
  // Handoff and no spec.md, because a wayfinder feature does not produce one.
  const { stages } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      mapFile: true,
      mapCleared: true,
      hasHandoff: true,
      glossaryTerms: 12,
      ticketCount: 13,
      ticketResolved: 13,
    }),
  );
  assert.equal(stages.intake, 'complete');
  assert.equal(stages.ask, 'complete');
  assert.equal(stages.spec, 'complete', 'a Handoff is the plan for a map');
  assert.equal(stages.design, 'active', 'design was never declared');
});

test('a prototype ticket is not a slice', () => {
  // A prototype settles a question; it is not work to build. Both live in
  // issues/, so counting files made a fresh feature look already sliced.
  const onlyPrototype = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      ticketCount: 1,
      ticketResolved: 0,
      sliceCount: 0,
      sliceResolved: 0,
    }),
  );
  assert.equal(onlyPrototype.stages.split, 'ready');
  assert.deepEqual(onlyPrototype.crossed, [], 'a question is not a crossing');

  const withSlice = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designDeclared: true,
      ticketCount: 2,
      ticketResolved: 0,
      sliceCount: 1,
      sliceResolved: 0,
    }),
  );
  assert.equal(withSlice.stages.split, 'complete');
});

test('a crossed stage is reported, never absorbed', () => {
  // Slices exist and are all resolved, but design was never declared. Downstream
  // work happened over an unsatisfied stage, and the derivation must say so
  // rather than marking the later stages complete.
  const result = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      ticketCount: 5,
      ticketResolved: 5,
      sliceCount: 5,
      sliceResolved: 5,
    }),
  );
  assert.equal(result.stages.design, 'active');
  assert.equal(result.stages.split, 'active', 'split must not claim complete');
  assert.ok(result.crossed.length > 0, 'the crossing must be reported');
  assert.ok(
    result.crossed.some((c) => c.stage === 'split' && c.over === 'design'),
    'the report must name the stage crossed over',
  );
});

test('no crossing is reported on a satisfied chain', () => {
  const result = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designDeclared: true,
      ticketCount: 3,
      ticketResolved: 3,
      sliceCount: 3,
      sliceResolved: 3,
    }),
  );
  assert.deepEqual(result.crossed, []);
});

test('an open blocking gate holds its stage whatever else is on disk', () => {
  const { stages } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designDeclared: true,
    }),
    ['design'],
  );
  assert.equal(stages.design, 'blocked');
  // And nothing downstream may claim to be complete through a blocked stage.
  assert.notEqual(stages.split, 'complete');
});

test('blocked outranks complete', () => {
  const { stages } = deriveStages(
    facts({ featureDir: true, destinationNamed: true, glossaryTerms: 1, specFile: true }),
    ['spec'],
  );
  assert.equal(stages.spec, 'blocked');
});

test('a waiver does not excuse a blocked stage', () => {
  // Blocked is checked before waived: a gate a human has not answered cannot be
  // sidestepped by declaring the stage skipped.
  const { stages } = deriveStages(
    facts({ featureDir: true, destinationNamed: true, glossaryTerms: 1, specFile: true, designDeclared: true, designWaived: true }),
    ['design'],
  );
  assert.equal(stages.design, 'blocked');
});

test('the full loop can be completed', () => {
  const { stages, crossed } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 3,
      specFile: true,
      designDeclared: true,
      ticketCount: 4,
      ticketResolved: 4,
      sliceCount: 4,
      sliceResolved: 4,
      reviewFile: true,
      releaseFile: true,
      retroFile: true,
    }),
  );
  assert.equal(strip(stages), '+++++++++');
  assert.equal(completedCount(stages), 9);
  assert.deepEqual(crossed, []);
  assert.equal(operatingStage(stages), 'retro');
});

test('operatingStage reports the first unfinished stage', () => {
  const { stages } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
    }),
  );
  assert.equal(operatingStage(stages), 'design');
});

test('operatingStage skips a waived stage', () => {
  const { stages } = deriveStages(
    facts({
      featureDir: true,
      destinationNamed: true,
      glossaryTerms: 1,
      specFile: true,
      designDeclared: true,
      designWaived: true,
    }),
  );
  assert.equal(operatingStage(stages), 'split');
});

test('classifyTicket: a written resolution wins over a computed one', () => {
  const resolvedIds = new Set<string>();
  const status = classifyTicket({
    rawStatus: 'resolved',
    // It names a blocker that is not resolved, and it is still resolved: the
    // written record is what a human reviewed.
    blockedBy: ['09'],
    resolvedIds,
  });
  assert.equal(status, 'resolved');
});

test('classifyTicket: an unmet blocker makes a ticket blocked', () => {
  const status = classifyTicket({
    rawStatus: 'open',
    blockedBy: ['02'],
    resolvedIds: new Set<string>(),
  });
  assert.equal(status, 'blocked');
});

test('classifyTicket: a settled blocker frees the ticket to the frontier', () => {
  const status = classifyTicket({
    rawStatus: 'open',
    blockedBy: ['02'],
    resolvedIds: new Set(['02']),
  });
  assert.equal(status, 'frontier');
});

test('classifyTicket: claimed is not frontier', () => {
  assert.equal(
    classifyTicket({ rawStatus: 'claimed', blockedBy: [], resolvedIds: new Set() }),
    'claimed',
  );
});

test('classifyTicket: an empty status is unknown, not frontier', () => {
  // Guessing "open" here would put a ticket nobody wrote onto the frontier.
  assert.equal(
    classifyTicket({ rawStatus: '', blockedBy: [], resolvedIds: new Set() }),
    'unknown',
  );
});

test('classifyTicket: an unrecognised status is unknown', () => {
  assert.equal(
    classifyTicket({ rawStatus: 'banana', blockedBy: [], resolvedIds: new Set() }),
    'unknown',
  );
});

test('danglingBlockers reports an edge to a ticket that does not exist', () => {
  const d = danglingBlockers([
    { id: '01', blockedBy: [] },
    { id: '02', blockedBy: ['01', '99'] },
  ]);
  assert.deepEqual(d, [{ from: '02', missing: '99' }]);
});

test('cycles finds a circular blocking edge', () => {
  const c = cycles([
    { id: '01', blockedBy: ['02'] },
    { id: '02', blockedBy: ['01'] },
  ]);
  assert.ok(c.length > 0, 'a cycle must be reported, not left to hang');
});

test('cycles is empty for a diamond, which is not a cycle', () => {
  const c = cycles([
    { id: '01', blockedBy: [] },
    { id: '02', blockedBy: ['01'] },
    { id: '03', blockedBy: ['01'] },
    { id: '04', blockedBy: ['02', '03'] },
  ]);
  assert.deepEqual(c, []);
});

test('stage order is the documented loop, with design between spec and split', () => {
  assert.deepEqual([...STAGE_IDS], [
    'intake',
    'ask',
    'spec',
    'design',
    'split',
    'develop',
    'review',
    'ship',
    'retro',
  ]);
});
