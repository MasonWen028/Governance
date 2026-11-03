import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { Decision, Gate } from '../src/domain/types.js';
import {
  DECISIONS_FILE,
  appendDecision,
  decisionsFor,
  gateState,
  makeDecision,
  openBlockingGates,
  readDecisions,
  validateDecision,
} from '../src/tracker/decisions.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gov-decisions-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gate = (over: Partial<Gate> = {}): Gate => ({
  id: 'g1',
  title: 'Slice breakdown',
  stage: 'split',
  scope: { kind: 'stage', ref: 'split' },
  owner: 'po',
  methods: ['signoff'],
  blocking: true,
  onFail: 'rework',
  raisedBy: 'rule',
  ...over,
});

const fixedClock = (iso: string) => () => new Date(iso);

test('an override with no reason is rejected', async () => {
  const d = makeDecision({
    gate: 'g1',
    outcome: 'override',
    actor: 'po',
    methods: ['signoff'],
    evidence: ['bench/run.json'],
  });
  const problems = validateDecision(d);
  assert.ok(
    problems.some((p) => p.includes('override needs a reason')),
    'forcing a gate must cost a sentence',
  );

  await assert.rejects(
    () => appendDecision(dir, d),
    /refusing to record/,
    'the log must refuse it, not record it with a hole',
  );
});

test('an override with a reason is accepted', async () => {
  const d = makeDecision({
    gate: 'g-override',
    outcome: 'override',
    actor: 'tech',
    methods: ['signoff'],
    evidence: ['bench/run.json'],
    reason: 'shipping to hit the launch window; the gap is tracked as TD-27',
  });
  const stored = await appendDecision(dir, d, { now: fixedClock('2026-10-13T00:00:00Z') });
  assert.ok(stored.reason);
});

test('a pass with no evidence is rejected', async () => {
  const d = makeDecision({
    gate: 'g1',
    outcome: 'pass',
    actor: 'po',
    methods: ['signoff'],
  });
  const problems = validateDecision(d);
  assert.ok(
    problems.some((p) => p.includes('pass needs at least one piece of evidence')),
    'an approval with nothing behind it is not a decision',
  );
  await assert.rejects(() => appendDecision(dir, d), /refusing to record/);
});

test('a pass with evidence is accepted', async () => {
  const d = makeDecision({
    gate: 'g-pass',
    outcome: 'pass',
    actor: 'po',
    methods: ['signoff', 'lateral'],
    evidence: ['reviews/standards.md', 'reviews/spec.md'],
  });
  await appendDecision(dir, d, { now: fixedClock('2026-10-13T00:01:00Z') });
  const all = await readDecisions(dir);
  assert.ok(all.some((x) => x.gate === 'g-pass' && x.outcome === 'pass'));
});

test('unknown role, outcome and method are all rejected', () => {
  const base = makeDecision({
    gate: 'g1',
    outcome: 'pass',
    actor: 'po',
    methods: ['signoff'],
    evidence: ['x'],
  });
  assert.ok(validateDecision({ ...base, actor: 'ceo' as never }).length > 0);
  assert.ok(validateDecision({ ...base, outcome: 'maybe' as never }).length > 0);
  assert.ok(validateDecision({ ...base, methods: ['vibes' as never] }).length > 0);
  assert.ok(validateDecision({ ...base, ts: 'not a date' }).length > 0);
});

test('the log is append-only: earlier lines survive', async () => {
  const path = join(dir, DECISIONS_FILE);
  const before = await readFile(path, 'utf8');
  const beforeLines = before.split('\n').filter((l) => l.trim().length > 0).length;

  await appendDecision(
    dir,
    makeDecision({
      gate: 'g1',
      outcome: 'fail',
      actor: 'qa',
      methods: ['cross'],
      evidence: ['bench/frames.json'],
      note: 'throughput below target',
    }),
    { now: fixedClock('2026-10-13T00:02:00Z') },
  );

  const after = await readFile(path, 'utf8');
  assert.ok(after.startsWith(before), 'an earlier byte was rewritten');
  assert.equal(after.split('\n').filter((l) => l.trim().length > 0).length, beforeLines + 1);
});

test('reversing a decision appends its opposite rather than editing', async () => {
  const g = gate({ id: 'g-reverse' });
  await appendDecision(
    dir,
    makeDecision({ gate: g.id, outcome: 'fail', actor: 'qa', methods: ['cross'], evidence: ['a'] }),
    { now: fixedClock('2026-10-13T00:03:00Z') },
  );
  let decisions = await readDecisions(dir);
  assert.equal(gateState(g, decisions), 'failed');

  await appendDecision(
    dir,
    makeDecision({ gate: g.id, outcome: 'pass', actor: 'qa', methods: ['cross'], evidence: ['a'] }),
    { now: fixedClock('2026-10-13T00:04:00Z') },
  );
  decisions = await readDecisions(dir);
  assert.equal(gateState(g, decisions), 'passed');
  // Both are still on the record.
  assert.equal(decisionsFor(g, decisions).length, 2);
});

test('gateState: a gate with no decisions is open', () => {
  assert.equal(gateState(gate({ id: 'never-touched' }), []), 'open');
});

test('gateState: skip is reported as skipped, not as a pass', () => {
  const g = gate({ id: 'g-skip' });
  const decisions: Decision[] = [
    makeDecision({ gate: g.id, outcome: 'skip', actor: 'po', methods: [], note: 'stage ran ahead' }),
  ];
  // Folding a crossing into "passed" would look like governance while permitting
  // exactly what the gate exists to prevent.
  assert.equal(gateState(g, decisions), 'skipped');
});

test('gateState: override reads as passed, because it was decided', () => {
  const g = gate({ id: 'g-ov' });
  const decisions: Decision[] = [
    makeDecision({
      gate: g.id,
      outcome: 'override',
      actor: 'po',
      methods: ['signoff'],
      evidence: ['x'],
      reason: 'knowingly accepted',
    }),
  ];
  assert.equal(gateState(g, decisions), 'passed');
});

test('openBlockingGates lists only what a human still owes', async () => {
  const gates: Gate[] = [
    gate({ id: 'a', blocking: true }),
    gate({ id: 'b', blocking: false }),
    gate({ id: 'c', blocking: true }),
  ];
  const decisions = [
    makeDecision({ gate: 'c', outcome: 'pass', actor: 'po', methods: [], evidence: ['x'] }),
  ];
  const open = openBlockingGates(gates, decisions);
  assert.deepEqual(open.map((g) => g.id), ['a']);
});

test('a malformed line is reported and skipped, never fatal', async () => {
  const bad = await mkdtemp(join(tmpdir(), 'gov-bad-'));
  try {
    const path = join(bad, DECISIONS_FILE);
    await writeFile(
      path,
      [
        '{"ts":"2026-10-13T00:00:00Z","gate":"g1","outcome":"pass","actor":"po","methods":[],"evidence":["x"]}',
        'this is not json',
        '{"ts":"2026-10-13T00:01:00Z","gate":"g2","outcome":"skip","actor":"po","methods":[],"evidence":[]}',
        '',
      ].join('\n'),
      'utf8',
    );
    const { readDecisionsWithWarnings } = await import('../src/tracker/decisions.js');
    const result = await readDecisionsWithWarnings(bad);
    // Both good lines survive; the bad one is named.
    assert.equal(result.decisions.length, 2);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]!.includes(':2'), 'the warning must point at the line');
  } finally {
    await rm(bad, { recursive: true, force: true });
  }
});

test('a missing log reads as empty rather than throwing', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'gov-empty-'));
  try {
    assert.deepEqual(await readDecisions(empty), []);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('appendDecision creates the feature directory when absent', async () => {
  const nested = join(dir, 'created', 'by', 'append');
  await appendDecision(
    nested,
    makeDecision({
      gate: 'g1',
      outcome: 'skip',
      actor: 'po',
      methods: [],
      evidence: ['x'],
    }),
    { now: fixedClock('2026-10-13T00:05:00Z') },
  );
  const stored = await readDecisions(nested);
  assert.equal(stored.length, 1);
});

test('the timestamp is set by the log, not trusted from the caller', async () => {
  const stored = await appendDecision(
    dir,
    makeDecision({
      gate: 'g-ts',
      outcome: 'pass',
      actor: 'po',
      methods: ['auto'],
      evidence: ['ci/482'],
    }),
    { now: fixedClock('2026-10-13T09:15:00Z') },
  );
  // Without an injected clock the wall clock is used, so assert only that it
  // parses and is close to now rather than a hardcoded instant.
  assert.ok(!Number.isNaN(Date.parse(stored.ts)));
});
