import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseMap, parseTicket, sections } from '../src/tracker/parse.js';
import { scanProject } from '../src/tracker/discover.js';
import { FEATURE_SLUG, ScaffoldError, scaffoldFeature } from '../src/tracker/scaffold.js';

/**
 * Scaffolding is the only path that creates material, so it gets the hardest
 * tests in the suite. The two properties that matter: it never overwrites, and it
 * never writes outside the feature it was asked for.
 *
 * The output is also fed back through the parser. What the wizard writes and what
 * the scanner reads are two halves of one contract, and a test that only checked
 * the writing half would miss them drifting apart.
 */

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-scaffold-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const INPUT = {
  root: '',
  feature: 'demo-feature',
  title: 'A demo feature',
  destination: 'Prove the scaffolder writes something the scanner can read.',
  notes: ['Domain: testing.', 'Standing preference: read-only over what it reads.'],
  decisions: ['Detection target: people.', 'Placement: one hop away on the same LAN.'],
  notYetSpecified: ['How it degrades at scale.'],
  outOfScope: ['Cloud deployment.'],
  glossary: [
    { word: 'frame', meaning: 'one decoded still from the stream' },
    { word: 'alert', meaning: 'one notification the user receives' },
  ],
  prd: {
    problem: 'Nothing watches the feed.',
    solution: 'A single-host service that does.',
    stories: [
      'As the only user, I want an alert within ten seconds, so that it still matters.',
      'As the only user, I want history for a week, so that I can check an alert.',
    ],
    decisions: ['Detection target: people.', 'Notification: desktop.'],
    testing: ['Test external behaviour only.'],
    seam: 'One seam, at the ingest boundary.',
    outOfScope: ['Multi-camera operation.'],
  },
  prototypeTickets: [
    { id: '1', title: 'Batch queue throughput', kind: 'logic' as const, reason: 'Not settleable by talking.' },
  ],
};

test('the slug pattern accepts what it should and rejects what it must', () => {
  assert.ok(FEATURE_SLUG.test('demo-feature'));
  assert.ok(FEATURE_SLUG.test('a1'));
  assert.ok(FEATURE_SLUG.test('camera.analytics_v2'));
  assert.equal(FEATURE_SLUG.test('../escape'), false);
  assert.equal(FEATURE_SLUG.test('..'), false);
  assert.equal(FEATURE_SLUG.test('Upper'), false);
  assert.equal(FEATURE_SLUG.test('-leading'), false);
  assert.equal(FEATURE_SLUG.test(''), false);
  assert.equal(FEATURE_SLUG.test('a'.repeat(65)), false);
});

test('scaffold writes the feature and reports the files', async () => {
  const result = await scaffoldFeature({ ...INPUT, root });
  assert.equal(result.files.length, 4, 'map, glossary, spec, one prototype ticket');
  for (const f of result.files) {
    assert.ok((await stat(f)).isFile(), `${f} was not created`);
  }
});

test('the four files are the ones the chain expects', async () => {
  const featureDir = join(root, '.scratch', 'demo-feature');
  const top = (await readdir(featureDir)).sort();
  assert.deepEqual(top, ['GLOSSARY.md', 'issues', 'map.md', 'spec.md']);
  const issues = await readdir(join(featureDir, 'issues'));
  assert.deepEqual(issues, ['01-batch-queue-throughput.md']);
});

test('scaffolding refuses to overwrite an existing feature', async () => {
  await assert.rejects(
    () => scaffoldFeature({ ...INPUT, root }),
    (err: unknown) => {
      assert.ok(err instanceof ScaffoldError);
      assert.equal(err.status, 409, 'a conflict, not a bad request');
      assert.ok(err.message.includes('already exists'));
      return true;
    },
  );
});

test('the refusal did not touch the files that were already there', async () => {
  const map = await readFile(join(root, '.scratch', 'demo-feature', 'map.md'), 'utf8');
  assert.ok(map.includes('A demo feature'));
});

test('a traversal slug is refused before anything is written', async () => {
  for (const bad of ['../escape', '..', '.', 'a/b', 'a\\b']) {
    await assert.rejects(
      () => scaffoldFeature({ ...INPUT, root, feature: bad }),
      (err: unknown) => err instanceof ScaffoldError && err.status === 400,
      `accepted a dangerous slug: ${bad}`,
    );
  }
  // Nothing appeared outside .scratch/.
  const top = await readdir(root);
  assert.deepEqual(top.sort(), ['.scratch']);
});

test('a root that does not exist is refused', async () => {
  await assert.rejects(
    () => scaffoldFeature({ ...INPUT, root: join(root, 'no-such-dir'), feature: 'x' }),
    (err: unknown) => err instanceof ScaffoldError && err.status === 404,
  );
});

test('a control character in the title is refused', async () => {
  await assert.rejects(
    () => scaffoldFeature({ ...INPUT, root, feature: 'ctrl', title: 'bad\u0000title' }),
    (err: unknown) => err instanceof ScaffoldError,
  );
});

/* ---- the contract with the reader ---- */

test('the written map parses back with its sections intact', async () => {
  const map = await readFile(join(root, '.scratch', 'demo-feature', 'map.md'), 'utf8');
  const parsed = parseMap(map);
  assert.equal(parsed.destination, 'Prove the scaffolder writes something the scanner can read.');
  assert.ok(parsed.notes.length >= 2);
  assert.ok(parsed.notYetSpecified.length >= 1);
  assert.ok(parsed.outOfScope.length >= 1);
  // The decisions section uses the `- text` shape, which the scanner reads as
  // bullets. A pointer-plus-gist expectation would silently yield nothing.
  const secs = sections(map);
  assert.ok(secs.has('decisions so far'));
});

test('the written spec does NOT declare design, so a fresh feature cannot skip it', async () => {
  const spec = await readFile(join(root, '.scratch', 'demo-feature', 'spec.md'), 'utf8');
  // A `none - <reason>` value parses as a waiver, which satisfies the stage.
  // Writing one here would be the scaffolder making a decision the human has not
  // made, and would let every new feature skip design by default.
  const anchored = /^\*\*\s*Design\s*:?\s*\*\*\s*(.*)$/im.exec(spec);
  assert.equal(anchored, null, 'the scaffolder must not declare design on the human behalf');
  assert.ok(spec.includes('/codebase-design'), 'but it should point at what resolves it');
});

test('prose that mentions the design field is not read as the field', async () => {
  // The spec above explains the syntax without using it. An unanchored regex
  // would have matched the explanation and mistaken the document for a waiver —
  // which is what it did before this was fixed.
  const spec = await readFile(join(root, '.scratch', 'demo-feature', 'spec.md'), 'utf8');
  const project = await scanProject(root);
  const e = project.features.find((x) => x.slug === 'demo-feature')!;
  assert.equal(e.stages.design, 'active', 'design must be open, not waived');
  assert.ok(!/\*\*\s*Design\s*:?\s*\*\*/im.test(spec));
});

test('the prototype ticket parses as an open prototype', async () => {
  const raw = await readFile(
    join(root, '.scratch', 'demo-feature', 'issues', '01-batch-queue-throughput.md'),
    'utf8',
  );
  const t = parseTicket(raw, '01', 'batch-queue-throughput');
  assert.equal(t.type, 'prototype');
  assert.equal(t.rawStatus, 'open');
  assert.deepEqual(t.blockedBy, [], 'a fresh prototype can start immediately');
  assert.ok(t.question && t.question.length > 0);
});

test('a scan of the fresh feature lands where the wizard promised', async () => {
  const project = await scanProject(root);
  assert.equal(project.features.length, 1);
  const e = project.features[0]!;
  // intake, ask and spec are satisfied by what was written; design is declared
  // as not-yet-decided, so the feature is operating at design — stage 4.
  assert.equal(e.stages.intake, 'complete');
  assert.equal(e.stages.ask, 'complete');
  assert.equal(e.stages.spec, 'complete');
  assert.equal(e.stages.design, 'active');
  // Split is still open: a prototype ticket is a question, not a slice, so the
  // feature has not been sliced and nothing has been crossed.
  assert.equal(e.stages.split, 'ready');
  assert.deepEqual(e.warnings, [], 'a fresh feature must not report a crossing');
  assert.equal(e.tickets.length, 1);
  assert.equal(e.tickets[0]!.status, 'frontier');
});

test('a feature with no optional sections still scaffolds and scans', async () => {
  const bare = {
    root,
    feature: 'bare-feature',
    title: 'Bare',
    destination: 'Exist.',
    prd: { problem: 'p', solution: 's', stories: [], decisions: [], testing: [], outOfScope: [] },
  };
  const result = await scaffoldFeature(bare);
  assert.equal(result.files.length, 3, 'no prototype tickets, so three files');
  const p = await scanProject(root);
  const e = p.features.find((x) => x.slug === 'bare-feature');
  assert.ok(e);
  assert.equal(e.stages.intake, 'complete');
  assert.equal(e.tickets.length, 0);
});

test('an empty environment cannot scaffold over a file it did not create', async () => {
  // A directory that exists but is a file, not a directory, must not be treated
  // as free space.
  const other = await mkdtemp(join(tmpdir(), 'gov-scaffold2-'));
  try {
    await mkdir(join(other, '.scratch'), { recursive: true });
    await writeFile(join(other, '.scratch', 'taken'), 'not a directory', 'utf8');
    await assert.rejects(
      () => scaffoldFeature({ ...INPUT, root: other, feature: 'taken' }),
      (err: unknown) => err instanceof ScaffoldError && err.status === 409,
    );
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});
