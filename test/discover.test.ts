import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { scanProject, MAX_FEATURES } from '../src/tracker/discover.js';
import type { StageState } from '../src/domain/types.js';

/**
 * Integration over a real filesystem.
 *
 * Two corpora are used. A synthetic one, built here, so the interesting shapes
 * (a frontier, a blocked edge, an open gate, a crossed stage) are all present and
 * deterministic. And the real feature on disk at railyard/.scratch/methodology-view
 * when it is reachable, because a parser proven only against fixtures is proven
 * against the author's assumptions.
 */

let root: string;

const TICKETS: Record<string, string> = {
  '01-first.md': `# 01: The first slice

**Type:** grilling
**Status:** resolved
**Blocked by:** None (can start immediately)

## Question

What is the first thing?

## Answer

The first thing.
`,
  '02-second.md': `# 02: The second slice

**Type:** task
**Status:** open
**Blocked by:** 01

## Question

What follows the first thing?
`,
  '03-third.md': `# 03: The third slice

**Type:** prototype
**Status:** open
**Blocked by:** None (can start immediately)

## Question

Something independent.
`,
  '04-fourth.md': `# 04: The fourth slice

**Type:** task
**Status:** claimed
**Blocked by:** 02, 03

## Question

Something waiting on two others.
`,
  '05-dangling.md': `# 05: Points at nothing

**Type:** task
**Status:** open
**Blocked by:** 99

## Question

This one names a ticket that does not exist.
`,
};

async function buildFixture(dir: string): Promise<void> {
  const feature = join(dir, '.scratch', 'demo-feature');
  await mkdir(join(feature, 'issues'), { recursive: true });

  await writeFile(
    join(feature, 'map.md'),
    `# Map: demo feature

## Destination

> Prove the scanner reads a real tree.

## Notes

- Domain: testing.

## Decisions so far

- [First choice](issues/01-first.md): the first thing was chosen.

## Not yet specified

- Something dim.

## Out of scope

- Something ruled out.
`,
    'utf8',
  );

  for (const [name, body] of Object.entries(TICKETS)) {
    await writeFile(join(feature, 'issues', name), body, 'utf8');
  }

  await writeFile(
    join(feature, 'gates.json'),
    JSON.stringify([
      {
        id: 'g-split',
        title: 'Slice breakdown',
        stage: 'split',
        scope: { kind: 'stage', ref: 'split' },
        owner: 'po',
        methods: ['signoff'],
        blocking: true,
        onFail: 'rework',
        raisedBy: 'rule',
      },
    ]),
    'utf8',
  );
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-scan-'));
  await buildFixture(root);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('scanProject finds the feature and its map', async () => {
  const p = await scanProject(root);
  assert.equal(p.features.length, 1);
  const e = p.features[0]!;
  assert.equal(e.slug, 'demo-feature');
  assert.equal(e.kind, 'map');
  assert.equal(e.destination, 'Prove the scanner reads a real tree.');
  assert.equal(e.decisionsSoFar.length, 1);
  assert.equal(e.notYetSpecified.length, 1);
  assert.equal(e.outOfScope.length, 1);
});

test('scanProject classifies every ticket status correctly', async () => {
  const p = await scanProject(root);
  const byId = new Map(p.features[0]!.tickets.map((t) => [t.id, t]));

  assert.equal(byId.get('01')!.status, 'resolved');
  // Its blocker is resolved, so it is on the frontier.
  assert.equal(byId.get('02')!.status, 'frontier');
  assert.equal(byId.get('03')!.status, 'frontier');
  // Two unmet blockers.
  assert.equal(byId.get('04')!.status, 'blocked');
  // Names a ticket that does not exist, so it can never start.
  assert.equal(byId.get('05')!.status, 'blocked');
});

test('scanProject reports a dangling blocking edge', async () => {
  const p = await scanProject(root);
  const warnings = p.features[0]!.warnings.join('\n');
  assert.ok(warnings.includes('99'), 'the dangling edge must be named');
});

test('an open blocking gate holds its stage', async () => {
  const p = await scanProject(root);
  const e = p.features[0]!;
  assert.equal(e.gates.length, 1);
  assert.equal(e.stages.split, 'blocked');
});

test('recording a decision releases the gate', async () => {
  const feature = join(root, '.scratch', 'demo-feature');
  await writeFile(
    join(feature, 'decisions.jsonl'),
    `${JSON.stringify({
      ts: '2026-10-13T00:00:00Z',
      gate: 'g-split',
      outcome: 'pass',
      actor: 'po',
      methods: ['signoff'],
      evidence: ['issues/01-first.md'],
    })}\n`,
    'utf8',
  );
  const p = await scanProject(root);
  const e = p.features[0]!;
  assert.notEqual(e.stages.split, 'blocked', 'a decided gate must stop blocking');
  // It does NOT become complete: design was never declared, so the chain is still
  // broken and split stays crossed. Releasing a gate removes a hold, it does not
  // invent the missing stage.
  assert.equal(e.stages.split, 'active');
  assert.equal(e.stages.develop, 'active', 'tickets remain unresolved');
  assert.ok(
    e.warnings.join('\n').includes('crossed'),
    'the crossing must still be reported after the gate releases',
  );
});

test('the frontier is exactly the open, unblocked, unclaimed tickets', async () => {
  const p = await scanProject(root);
  const frontier = p.features[0]!.tickets
    .filter((t) => t.status === 'frontier')
    .map((t) => t.id)
    .sort();
  assert.deepEqual(frontier, ['02', '03']);
});

async function scanDesignDir(designBody: string): Promise<StageState> {
  const dir = await mkdtemp(join(tmpdir(), 'gov-design-'));
  try {
    const feature = join(dir, '.scratch', 'designed');
    await mkdir(feature, { recursive: true });
    await writeFile(
      join(feature, 'spec.md'),
      '# Spec\n\n**Problem:** the scanner and the prompt disagreed.\n\n**Solution:** say the same thing.\n',
      'utf8',
    );
    await writeFile(join(feature, 'GLOSSARY.md'), '- **Design:** the design.\n', 'utf8');
    await writeFile(join(feature, 'design.md'), designBody, 'utf8');
    const p = await scanProject(dir);
    const e = p.features[0]!;
    assert.ok(e, 'the feature must be found');
    return e.stages.design;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('design.md on disk completes the design stage', async () => {
  /* The shape of project/.scratch/repalce-name: spec.md without a `**Design:**`
   * field, and a design.md the stage wrote. The ladder used to say `active`
   * about a design that was sitting in the directory, so the AFK chain stopped
   * after a run that had done its job. */
  assert.equal(await scanDesignDir('# Design\n\nOne module, one seam.\n'), 'complete');
});

test('an empty design.md declares nothing', async () => {
  /* Presence alone is not a design. A run that touched the file and then died
   * leaves it empty, and completing the stage on that would be the ladder
   * certifying work that was never done. */
  assert.equal(await scanDesignDir(''), 'active');
  assert.equal(await scanDesignDir('   \n\n'), 'active');
});

test('a crossed stage is surfaced as a warning on the feature', async () => {
  const p = await scanProject(root);
  const warnings = p.features[0]!.warnings.join('\n');
  // design was never declared, yet tickets exist and some are resolved.
  assert.ok(
    warnings.includes('crossed'),
    `expected a crossing report, got:\n${warnings}`,
  );
});

test('a malformed gate definition is dropped with a warning that names the cost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-gatebad-'));
  try {
    const feature = join(dir, '.scratch', 'gated');
    await mkdir(feature, { recursive: true });
    const good = {
      id: 'g-good',
      title: 'Spec sign-off',
      stage: 'spec',
      scope: { kind: 'stage', ref: 'spec' },
      owner: 'po',
      methods: ['signoff'],
      blocking: true,
      onFail: 'rework',
      raisedBy: 'rule',
    };
    await writeFile(
      join(feature, 'gates.json'),
      JSON.stringify([
        good,
        { ...good, id: 'g-bad-stage', stage: 'not-a-stage' },
        { ...good, id: 'g-bad-owner', owner: 'wizard' },
        { ...good, id: 'g-bad-blocking', blocking: 'yes' },
        { ...good, id: 'g-good' /* duplicate id */ },
        { id: 'g-empty', title: '' },
      ]),
      'utf8',
    );
    const p = await scanProject(dir);
    const e = p.features[0]!;
    assert.deepEqual(e.gates.map((g) => g.id), ['g-good'], 'only the valid gate survives');
    const warnings = e.warnings.join('\n');
    for (const bit of ['entry 2', 'entry 3', 'entry 4', 'entry 5', 'entry 6', 'NOT enforced']) {
      assert.ok(warnings.includes(bit), `warnings must name ${bit}; got:\n${warnings}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repository with no .scratch/ scans to a warning, not a throw', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'gov-bare-'));
  try {
    const p = await scanProject(bare);
    assert.equal(p.features.length, 0);
    assert.ok(p.warnings.some((w) => w.includes('.scratch')));
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('a path that does not exist scans to a warning, not a throw', async () => {
  const p = await scanProject(join(tmpdir(), 'gov-definitely-not-here-12345'));
  assert.equal(p.features.length, 0);
  assert.ok(p.warnings.length > 0);
});

test('a feature directory with no readable files still appears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-sparse-'));
  try {
    await mkdir(join(dir, '.scratch', 'empty-feature'), { recursive: true });
    const p = await scanProject(dir);
    // An empty feature is a fact about the tree. Dropping it would hide a
    // directory a human can see.
    assert.equal(p.features.length, 1);
    assert.equal(p.features[0]!.slug, 'empty-feature');
    assert.equal(p.features[0]!.stages.intake, 'active');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the scan is read-only: it creates nothing', async () => {
  const before = await stat(join(root, '.scratch', 'demo-feature'));
  await scanProject(root);
  const afterStat = await stat(join(root, '.scratch', 'demo-feature'));
  assert.equal(before.mtimeMs, afterStat.mtimeMs, 'the scan touched the tree');
});

/* The real corpus, when this machine has it. This is the test that matters: a
 * parser proven only against fixtures is proven against its author's guesses. */
const REAL = 'H:/Projects/railyard/.scratch';

test('reads the real railyard feature, if present', async (t) => {
  const exists = await stat(REAL).catch(() => null);
  if (exists === null) {
    t.skip('real corpus not on this machine');
    return;
  }
  const p = await scanProject('H:/Projects/railyard');
  assert.equal(p.features.length >= 1, true);

  const feature = p.features.find((e) => e.slug === 'methodology-view');
  assert.ok(feature, 'methodology-view not found');
  assert.equal(feature.kind, 'map');
  assert.equal(feature.tickets.length, 13, 'the real map has thirteen tickets');
  assert.equal(
    feature.tickets.every((tk) => tk.status === 'resolved'),
    true,
    'every ticket in the real map is resolved',
  );
  // The map names a destination, which is what completes intake.
  assert.ok(feature.destination.length > 40, 'destination not read');
  assert.equal(feature.stages.intake, 'complete');
  assert.equal(feature.stages.ask, 'complete');
  assert.ok(feature.decisionsSoFar.length >= 10, 'Decisions so far not read');
  // Real files are messy; the parser must not have flagged every one of them.
  const noisy = feature.tickets.filter((tk) => tk.warnings.length > 0);
  assert.ok(
    noisy.length <= 2,
    `${noisy.length} of 13 real tickets raised warnings: ` +
      noisy.map((t) => `${t.id}: ${t.warnings.join(', ')}`).join(' | '),
  );
});

test('MAX_FEATURES caps a pathological tree', () => {
  // A guard on the constant rather than the walk: building 200 features to test
  // the cap would cost more than the guard is worth.
  assert.ok(MAX_FEATURES > 0 && MAX_FEATURES <= 1000);
});
