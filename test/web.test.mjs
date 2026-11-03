import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { featureOf, toProjectVM, toProjectsVM, STAGE_IDS, STAGE_LABEL } from '../web/api.js';
import { featurePath, isNameTaken, slugify } from '../web/session.js';

/**
 * The adapter, tested directly.
 *
 * `web/api.js` is plain browser ESM, so it is imported here rather than
 * compiled. Only the pure mapping functions are exercised — the transport ones
 * need a socket and are covered by the server's own test.
 *
 * The property that matters most: the adapter must never invent a value. Where
 * the server does not know something, the view model must be empty, because a
 * plausible number on a board is worse than a blank.
 */

const REAL_PROJECT = {
  root: 'H:/Projects/railyard',
  name: 'railyard',
  git: { branch: 'methodology-view', head: 'dfaa026', dirty: true },
  warnings: [],
  features: [
    {
      slug: 'methodology-view',
      root: 'H:/Projects/railyard/.scratch/methodology-view',
      kind: 'map',
      destination: 'A normative contract plus a working read-only generator.',
      notes: ['Domain: Railyard governance.'],
      decisionsSoFar: [{ title: 'Registry shape', ref: 'issues/01-x.md', gist: 'declared plus discovered' }],
      notYetSpecified: ['something dim'],
      outOfScope: ['registering the contract'],
      tickets: [
        {
          id: '01',
          slug: 'one',
          title: 'The first',
          type: 'grilling',
          status: 'resolved',
          blockedByRaw: 'None (can start immediately)',
          blockedBy: [],
          warnings: [],
        },
        {
          id: '02',
          slug: 'two',
          title: 'The second',
          type: 'task',
          status: 'frontier',
          blockedByRaw: '01',
          blockedBy: ['01'],
          warnings: [],
        },
        {
          id: '03',
          slug: 'three',
          title: 'The third',
          type: 'task',
          status: 'blocked',
          blockedByRaw: '02',
          blockedBy: ['02'],
          warnings: [],
        },
        {
          id: '04',
          slug: 'four',
          title: 'The fourth',
          type: 'task',
          status: 'resolved',
          blockedByRaw: '03',
          blockedBy: ['03'],
          warnings: [],
        },
      ],
      gates: [
        {
          id: 'g1',
          title: 'Prove it',
          stage: 'develop',
          scope: { kind: 'stage', ref: 'develop' },
          owner: 'po',
          methods: ['signoff'],
          blocking: true,
          onFail: 'rework',
          raisedBy: 'manual',
        },
      ],
      stages: {
        intake: 'complete',
        ask: 'complete',
        spec: 'complete',
        design: 'active',
        split: 'active',
        develop: 'active',
        review: 'active',
        ship: 'ready',
        retro: 'absent',
      },
      warnings: ['stage "split" has output but "design" was never satisfied (crossed)'],
    },
  ],
};

test('the stage vocabulary is the loop, in order', () => {
  assert.deepEqual(STAGE_IDS, [
    'intake', 'ask', 'spec', 'design', 'split', 'develop', 'review', 'ship', 'retro',
  ]);
  // Every stage needs a label in both languages, or a screen is half translated.
  STAGE_IDS.forEach((id) => {
    const m = STAGE_LABEL[id];
    assert.ok(m && m.en && m.zh, `no bilingual label for ${id}`);
  });
});

/** The chain as GET /api/chain reports it. */
const CHAIN = STAGE_IDS.map((stage, i) => ({
  stage,
  skill: stage === 'ship' ? null : ['grill-with-docs', 'grilling', 'to-spec',
    'codebase-design', 'to-tickets', 'implement-spec', 'code-review', '', 'retro'][i],
  enabled: true,
  path: stage === 'ship' ? null : `/skills/x/SKILL.md`,
  present: stage === 'ship' ? null : true,
  mcp: [],
}));

test('featureOf prefers the selection and falls back to the first', () => {
  const p = REAL_PROJECT;
  assert.equal(featureOf(p, 'methodology-view').slug, 'methodology-view');
  assert.equal(featureOf(p, 'nope').slug, 'methodology-view');
  assert.equal(featureOf(p, undefined).slug, 'methodology-view');
  assert.equal(featureOf({ features: [] }, undefined), null);
  assert.equal(featureOf(null, undefined), null);
});

test('a project with no features maps without throwing', () => {
  const vm = toProjectVM({ name: 'empty', root: '/x', features: [], warnings: ['no .scratch/'] }, undefined, CHAIN);
  assert.equal(vm.name, 'empty');
  assert.equal(vm.tickets.length, 0);
  assert.equal(vm.gates.length, 0);
  assert.equal(vm.branch, '—', 'a missing git state must read as empty, not as a branch');
  assert.equal(vm.stageNo, 1);
});

test('the pipeline reflects the real stage states', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  assert.equal(vm.pipeline.length, 9);
  const byStage = new Map(vm.pipeline.map((s) => [s.n, s.s]));
  assert.equal(byStage.get('intake'), 'done');
  assert.equal(byStage.get('design'), 'active');
  assert.equal(byStage.get('ship'), 'pending', 'ready maps to pending');
  assert.equal(byStage.get('retro'), 'pending', 'absent maps to pending');
});

test('the rail names the skill each stage runs, from the chain', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  const byStage = new Map(vm.pipeline.map((s) => [s.n, s]));
  assert.equal(byStage.get('split').sk.en, 'to-tickets');
  assert.equal(byStage.get('ship').sk.en, 'CI / CD', 'ship has no skill; it is CI');
  assert.equal(byStage.get('design').sk.en, 'codebase-design');
});

test('a disabled skill says so on the rail', () => {
  const off = CHAIN.map((c) => (c.stage === 'split' ? { ...c, enabled: false } : c));
  const vm = toProjectVM(REAL_PROJECT, undefined, off);
  const split = vm.pipeline.find((s) => s.n === 'split');
  assert.ok(split.sk.en.includes('to-tickets'), 'the skill is still named');
  assert.ok(split.sk.en.includes('disabled'), 'and its state is shown');
});

test('a skill the machine does not have says so', () => {
  const missing = CHAIN.map((c) => (c.stage === 'develop' ? { ...c, present: false } : c));
  const vm = toProjectVM(REAL_PROJECT, undefined, missing);
  const dev = vm.pipeline.find((s) => s.n === 'develop');
  assert.ok(dev.sk.en.includes('not installed'));
});

test('a gated stage is marked so the rail can show it', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  const develop = vm.pipeline.find((s) => s.n === 'develop');
  assert.equal(develop.g, true);
  const split = vm.pipeline.find((s) => s.n === 'split');
  assert.equal(split.g, undefined, 'ungated stages must not claim a gate');
});

test('stageNo is the operating stage, not a completion count', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  // design is the first unfinished stage.
  assert.equal(vm.stageNo, 4);
});

test('tickets map to the board classes the stylesheet knows', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  const byId = new Map(vm.tickets.map((t) => [t.id, t]));
  assert.equal(byId.get('01').s, 'done');
  assert.equal(byId.get('02').s, 'ready', 'frontier maps to ready');
  assert.equal(byId.get('03').s, 'blocked');
  // 04 is resolved even though it names an unresolved blocker: the written
  // record wins, exactly as the server decided.
  assert.equal(byId.get('04').s, 'done');
});

test('ticket columns come from blocking depth, blockers first', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  const col = new Map(vm.tickets.map((t) => [t.id, t.col]));
  assert.equal(col.get('01'), 1, 'no blockers, first column');
  assert.equal(col.get('02'), 2);
  assert.equal(col.get('03'), 3);
  assert.equal(col.get('04'), 4, 'deepest in the chain');
  // Columns are bounded, so a long chain cannot overflow the board.
  assert.ok(vm.tickets.every((t) => t.col >= 1 && t.col <= 5));
});

test('gates carry the feature-qualified ref the API needs', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  assert.equal(vm.gates.length, 1);
  assert.equal(vm.gates[0].ref, 'railyard/methodology-view/g1');
});

test('blocking gates count toward the sidebar badge', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  assert.equal(vm.blk, 1);
});

test('an already-decided gate does not count as blocking', () => {
  const decided = structuredClone(REAL_PROJECT);
  decided.features[0].gates[0].__decided = true;
  const vm = toProjectVM(decided, undefined);
  assert.equal(vm.blk, 0);
});

test('gate buttons carry an outcome so a click can be recorded', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  const outs = vm.gates[0].btns.map((b) => b.act && b.act.outcome);
  assert.deepEqual(outs, ['pass', 'fail', 'skip']);
});

test('nothing is invented: unknown quantities are empty, not zero-filled', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  // The server cannot know how many agents are running or what CI reported.
  assert.equal(vm.running, 0);
  assert.deepEqual(vm.ci.pipe, []);
  assert.deepEqual(vm.ci.servers, []);
  assert.deepEqual(vm.ci.releases, []);
  assert.equal(vm.commits, 0);
});

test('the dot reflects the worst thing in the project', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  assert.equal(vm.dot, 'blk', 'an open blocking gate outranks everything');

  const noGate = structuredClone(REAL_PROJECT);
  noGate.features[0].gates = [];
  assert.equal(toProjectVM(noGate, undefined, CHAIN).dot, 'run', 'an active stage means running');

  const allDone = structuredClone(REAL_PROJECT);
  allDone.features[0].gates = [];
  for (const k of Object.keys(allDone.features[0].stages)) allDone.features[0].stages[k] = 'complete';
  assert.equal(toProjectVM(allDone, undefined, CHAIN).dot, 'ok');
});

test('warnings from the project and the feature are both surfaced', () => {
  const p = structuredClone(REAL_PROJECT);
  p.warnings = ['project-level warning'];
  const vm = toProjectVM(p, undefined, CHAIN);
  assert.ok(vm.warnings.includes('project-level warning'));
  assert.ok(vm.warnings.some((w) => w.includes('crossed')), 'the feature warning survives');
});

test('toProjectsVM keys by project name', () => {
  const vm = toProjectsVM([REAL_PROJECT], { railyard: 'methodology-view' }, CHAIN);
  assert.deepEqual(Object.keys(vm), ['railyard']);
  assert.equal(vm.railyard.pipeline.length, 9);
});

test('the feature list keeps the real kind and counts', () => {
  const vm = toProjectVM(REAL_PROJECT, undefined, CHAIN);
  assert.equal(vm.features.length, 1);
  assert.equal(vm.features[0].kind, 'map');
  assert.equal(vm.features[0].tickets, 4);
  assert.equal(vm.features[0].frontier, 1);
});

test('a stage state the adapter does not know falls back rather than crashing', () => {
  const odd = structuredClone(REAL_PROJECT);
  odd.features[0].stages.design = 'something-new';
  const vm = toProjectVM(odd, undefined, CHAIN);
  const design = vm.pipeline.find((s) => s.n === 'design');
  assert.equal(design.s, 'pending');
});

/* ---------- naming a feature ---------- */

test('a slug is a few whole words, never a truncated sentence', () => {
  // The name that was actually produced and shipped to a real repository.
  // Forty characters sliced at a fixed offset gave a directory called
  // `something-that-watches-my-camera-feed-an` — cut mid-word, and unreadable.
  const idea = 'something that watches my camera feed and tells me when something looks off';
  const slug = slugify(idea);
  assert.equal(slug, 'something-that-watches');
  assert.ok(slug.length <= 24, `too long: ${slug.length}`);
  assert.equal(slug.endsWith('-'), false, 'must not end on a separator');
  assert.equal(/\ban\b/.test(slug), false, 'must not carry a cut-off word');
});

test('a slug never comes back empty', () => {
  assert.equal(slugify(''), 'new-feature');
  assert.equal(slugify('!!!'), 'new-feature');
  assert.equal(slugify('   '), 'new-feature');
});

test('a single very long word is kept rather than dropped', () => {
  const slug = slugify('a'.repeat(60));
  assert.equal(slug.length > 0, true, 'something must be usable as a directory name');
});

test('already-short ideas pass through unchanged', () => {
  assert.equal(slugify('camera watch'), 'camera-watch');
  assert.equal(slugify('Camera Watch'), 'camera-watch');
});

test('a slug matches the rule the server enforces', () => {
  const rule = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  for (const idea of [
    'something that watches my camera feed',
    'A/B testing for the thing',
    '  leading and trailing  ',
    'x',
    '1 2 3',
  ]) {
    assert.ok(rule.test(slugify(idea)), `${idea} -> ${slugify(idea)}`);
  }
});

test('the full path is shown, so a name looks like a directory', () => {
  assert.equal(
    featurePath('H:/Projects/railyard', 'camera-watch'),
    'H:/Projects/railyard/.scratch/camera-watch/',
  );
  // Windows separators are preserved, because that is what the human will see on
  // screen. Built at runtime so the test file carries no escaping ambiguity.
  const BS = String.fromCharCode(92);
  const win = ['H:', 'Projects', 'railyard'].join(BS);
  assert.equal(
    featurePath(win, 'camera-watch'),
    [win, '.scratch', 'camera-watch'].join(BS) + BS,
  );
  assert.equal(featurePath('', 'x'), '.scratch/x/');
  // A trailing separator on the root must not double up.
  assert.equal(featurePath('H:/r/', 'x'), 'H:/r/.scratch/x/');
  assert.equal(featurePath(win + BS, 'x'), [win, '.scratch', 'x'].join(BS) + BS);
});

test('only the name-taken refusal is treated as recoverable', () => {
  const taken = 'a feature already exists at H:////r////.scratch////x; pick another slug or remove it first';
  assert.equal(isNameTaken(taken, 'x'), true);
  // Everything else is a plain error, and must not be dressed up as recoverable.
  assert.equal(isNameTaken('the agent could not run', 'x'), false);
  assert.equal(isNameTaken(taken, ''), false, 'without a feature there is nothing to remove');
  assert.equal(isNameTaken(null, 'x'), false);
});
