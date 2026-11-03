import { strict as assert } from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readDossier } from '../src/tracker/dossier.js';
import { appendEvent } from '../src/tracker/journal.js';
import { scanProjects } from '../src/tracker/discover.js';

/* The dossier is the feature's provenance, read whole: the conversation (rounds,
 * answers), the artifacts (glossary, ADRs, spec), the tickets, the runs, the
 * gate decisions, and the merged timeline. These tests build a small feature on
 * disk and assert the dossier says what the files say — no derivation, no
 * invention, and honest absence where a record is missing. */

async function buildFeature(dir: string): Promise<string> {
  const e = join(dir, '.scratch', 'recorded');
  await mkdir(join(e, '.session'), { recursive: true });
  await mkdir(join(e, 'docs', 'adr'), { recursive: true });
  await mkdir(join(e, 'issues'), { recursive: true });
  await mkdir(join(e, 'runs'), { recursive: true });

  await writeFile(join(e, '.session', 'state.json'), JSON.stringify({
    feature: 'recorded', idea: 'show the whole record', phase: 'done',
  }), 'utf8');
  await writeFile(join(e, '.session', '01.json'), JSON.stringify({
    round: 1, kind: 'questions',
    questions: [
      { id: 'q1', title: 'What to show', body: 'name the string', why: 'w', recommended: 'Hello', options: [] },
    ],
    answers: [{ id: 'q1', answer: 'Hello, World!' }],
    glossaryWritten: ['Greeting'], adrsWritten: [], frontierEmpty: false,
  }), 'utf8');
  await writeFile(join(e, '.session', '02.json'), JSON.stringify({
    round: 2, kind: 'questions',
    questions: [
      { id: 'q1', title: 'Layout', body: 'centred?', why: 'w', recommended: 'yes', options: [] },
    ],
    glossaryWritten: [], adrsWritten: [], frontierEmpty: false,
  }), 'utf8');
  await writeFile(join(e, 'GLOSSARY.md'), '# G\n\n**Greeting**:\nThe string shown.\n', 'utf8');
  await writeFile(join(e, 'gates.json'), JSON.stringify([
    {
      id: 'g1', title: 'Prove it', stage: 'develop',
      scope: { kind: 'stage', ref: 'develop' }, owner: 'po',
      methods: ['signoff'], blocking: true, onFail: 'rework', raisedBy: 'manual',
    },
  ]), 'utf8');
  await writeFile(join(e, 'docs', 'adr', '0001-one-document.md'),
    '# Keep it one document\n\nWe chose one file.\n', 'utf8');
  await writeFile(join(e, 'spec.md'),
    '# Spec\n\n## Problem Statement\n\ns\n\n## Solution\n\ns\n', 'utf8');
  await writeFile(join(e, 'issues', '01-first.md'),
    '# 01: First\n\n**What to build:** the first slice\n\n**Blocked by:** None (can start immediately)\n\n**Status:** resolved\n',
    'utf8');
  await writeFile(join(e, 'decisions.jsonl'), JSON.stringify({
    ts: '2026-10-31T01:00:00.000Z', gate: 'g1', outcome: 'pass', actor: 'po',
    methods: ['signoff'], evidence: ['stage:develop'],
  }) + '\n', 'utf8');
  await writeFile(join(e, 'runs', 'aaaaaaaa-0000-0000-0000-000000000000.json'), JSON.stringify({
    jobId: 'aaaaaaaa-0000-0000-0000-000000000000', root: dir, feature: 'recorded',
    stage: 'develop', skill: 'implement-spec', status: 'succeeded',
    startedAt: '2026-10-31T00:00:00.000Z', endedAt: '2026-10-31T00:00:05.000Z',
    exitCode: 0, error: null, ms: 5000, demo: false,
    audit: { gatesChanged: false, decisionsChanged: false, tampered: false, outsideWrites: null },
  }), 'utf8');
  return e;
}

test('readDossier: the whole record, from the rounds to the timeline', async () => {
  const dir = await mkdtempTmp('gov-dossier-');
  try {
    const e = await buildFeature(dir);
    const scanned = (await scanProjects([dir]))[0]!;
    const ef = scanned.features.find((x) => x.slug === 'recorded')!;
    const d = await readDossier(ef, e);

    assert.equal(d.idea, 'show the whole record');
    // Rounds: both on record, the answer beside the question it answers, and
    // the unrecorded round honestly named as transcript-only.
    assert.equal(d.rounds.length, 2);
    assert.equal(d.answeredRounds, 1);
    assert.equal(d.rounds[0]!.questions[0]!.title, 'What to show');
    assert.deepEqual(
      d.rounds[0]!.answers!.map((a) => a.answer),
      ['Hello, World!'],
    );
    assert.equal(d.rounds[1]!.answers, null);
    assert.ok(d.warnings.some((w) => w.includes('predate answer recording')));

    // Artifacts: glossary, the ADR by its own title, the spec's sections.
    assert.equal(d.glossary.exists, true);
    assert.equal(d.adrs.length, 1);
    assert.equal(d.adrs[0]!.title, 'Keep it one document');
    assert.ok(d.spec.sections.includes('Problem Statement'));

    // Tickets: status from the scan, words from the file.
    assert.equal(d.tickets.length, 1);
    assert.equal(d.tickets[0]!.status, 'resolved');
    assert.equal(d.tickets[0]!.what, 'the first slice');

    // Gates: the definition and the decision that answered it.
    assert.equal(d.gates.length, 1);
    assert.equal(d.gates[0]!.decisions.length, 1);
    assert.equal(d.gates[0]!.decisions[0]!.outcome, 'pass');

    // Runs and the merged timeline, in order.
    assert.equal(d.runs.length, 1);
    const kinds = d.timeline.map((ev) => ev.kind);
    assert.ok(kinds.includes('round') && kinds.includes('adr') &&
      kinds.includes('run-started') && kinds.includes('run-ended') &&
      kinds.includes('decision'));
    const at = d.timeline.map((ev) => ev.at);
    assert.deepEqual([...at].sort(), at, 'the timeline must be in order');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the journal, when present, is the timeline — and the mtime fallback says so', async () => {
  const dir = await mkdtempTmp('gov-journal-first-');
  try {
    const e = await buildFeature(dir);
    const scanned = (await scanProjects([dir]))[0]!;
    const ef = scanned.features.find((x) => x.slug === 'recorded')!;

    /* No journal yet: the timeline is reconstructed from file timestamps, and
     * the dossier says so rather than presenting a guess as the record. */
    const without = await readDossier(ef, e);
    assert.equal(without.journal.length, 0);
    assert.ok(without.warnings.some((w) => w.includes('reconstructed from file')));

    /* With a journal, the app's own events are the timeline: an event that no
     * file mtime could produce (an answer recorded at a moment of its own)
     * appears, and the fallback warning is gone. */
    await appendEvent(e, {
      at: '2026-10-31T02:00:00.000Z',
      kind: 'answer.recorded',
      ref: 'round 1',
      detail: '1 answer(s)',
      data: { answers: [{ id: 'q1', answer: 'Hello, World!' }] },
    });
    const withJournal = await readDossier(ef, e);
    assert.ok(!withJournal.warnings.some((w) => w.includes('reconstructed from file')));
    const answer = withJournal.timeline.find((ev) => ev.kind === 'answer');
    assert.ok(answer !== undefined, 'the recorded answer is on the timeline');
    assert.equal(answer!.at, '2026-10-31T02:00:00.000Z');

    // Artifacts the app never saw written still enter from the files.
    assert.ok(withJournal.timeline.some((ev) => ev.kind === 'adr'));
    assert.ok(withJournal.timeline.some((ev) => ev.kind === 'ticket'));

    // Every artifact carries the path the page needs to open it.
    assert.equal(withJournal.spec.path, 'spec.md');
    assert.equal(withJournal.glossary.path, 'GLOSSARY.md');
    assert.equal(withJournal.tickets[0]!.file, 'issues/01-first.md');
    assert.equal(withJournal.adrs[0]!.file, 'docs/adr/0001-one-document.md');
    assert.equal(withJournal.featureDir, e);
    assert.equal(withJournal.workspaceRoot, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function mkdtempTmp(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), prefix));
}

/* A map feature has no `.session/state.json`, so its concept is only ever in
 * `map.md`. Reading it is the difference between "this feature's idea" and an
 * empty field that reads as "there was no idea" — a false statement about a
 * file that opens with one. */
test('readDossier: a map feature takes its concept from map.md, and says so', async () => {
  const dir = await mkdtempTmp('gov-map-idea-');
  try {
    const e = join(dir, '.scratch', 'wayfound');
    await mkdir(join(e, 'issues'), { recursive: true });
    await writeFile(join(e, 'map.md'),
      '# Map: wayfound\n\n```\nnot the concept\n```\n\n' +
      '## Redraw\n\nDrive a feature from a fuzzy requirement to a release.\n\n' +
      '- a bullet is the body, not the opening\n', 'utf8');
    await writeFile(join(e, 'issues', '01-x.md'),
      '# 01: X\n\n**What to build:** x\n\n**Blocked by:** None (can start immediately)\n\n**Status:** frontier\n',
      'utf8');

    const scanned = (await scanProjects([dir]))[0]!;
    const ef = scanned.features.find((x) => x.slug === 'wayfound')!;
    const d = await readDossier(ef, e);

    assert.equal(d.idea, 'Drive a feature from a fuzzy requirement to a release.');
    assert.equal(d.ideaSource, 'map');
    // The heading, the fence and the bullet were all correctly not the concept.

    /* And a map with no prose at all is not given an invented one: the absence
     * is reported, so the page can say "there is none" instead of showing a
     * plausible sentence that no one wrote. */
    await writeFile(join(e, 'map.md'), '# Map: wayfound\n\n- only\n- bullets\n', 'utf8');
    const bare = await readDossier(ef, e);
    assert.equal(bare.idea, null);
    assert.equal(bare.ideaSource, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readDossier: the map concept is the whole paragraph, not its first line', async () => {
  const dir = await mkdtempTmp('gov-map-wrap-');
  try {
    const e = join(dir, '.scratch', 'wrapped');
    await mkdir(e, { recursive: true });
    /* Prose in these files is wrapped at eighty columns. Taking one line ends
     * the concept mid-sentence, which reads like a truncation bug in the UI —
     * so the paragraph is what the panel gets. */
    await writeFile(join(e, 'map.md'),
      '# Map: wrapped\n\nDrive a feature from a fuzzy requirement through planning, design\n' +
      'and deployment, and keep all of it in one interface.\n\nA second paragraph.\n', 'utf8');
    const scanned = (await scanProjects([dir]))[0]!;
    const ef = scanned.features.find((x) => x.slug === 'wrapped')!;
    const d = await readDossier(ef, e);
    assert.equal(
      d.idea,
      'Drive a feature from a fuzzy requirement through planning, design and deployment, ' +
        'and keep all of it in one interface.',
    );
    assert.ok(!d.idea!.includes('A second paragraph'), 'only the opening paragraph');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readDossier: a ticket that states its ask under a heading still says what it is', async () => {
  const dir = await mkdtempTmp('gov-ticket-what-');
  try {
    const e = await buildFeature(dir);
    /* The real ticket files put the ask under `## Question` and answer it
     * below; only the fixture style uses an inline `**What to build:**`. The
     * inline-only reader left `what` empty for thirteen real tickets, so the
     * split panel listed them and said nothing about any of them. */
    await writeFile(join(e, 'issues', '02-heading.md'),
      '# 02: Heading first\n\n**Type:** research\n\n**Blocked by:** 01\n\n' +
      '## Question\n\nWhat exactly does the authority record contain, and where\n' +
      'does it live?\n\n## Answer\n\nIn the install directory.\n', 'utf8');
    const scanned = (await scanProjects([dir]))[0]!;
    const ef = scanned.features.find((x) => x.slug === 'recorded')!;
    const d = await readDossier(ef, e);
    const second = d.tickets.find((t) => t.id === '02')!;
    assert.equal(
      second.what,
      'What exactly does the authority record contain, and where does it live?',
    );
    // The answer is not the question.
    assert.ok(!second.what.includes('In the install directory'));
    // And the inline form still wins where a file uses it.
    assert.equal(d.tickets.find((t) => t.id === '01')!.what, 'the first slice');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readDossier: a session idea outranks the map, and the source says which', async () => {
  const dir = await mkdtempTmp('gov-idea-source-');
  try {
    const e = await buildFeature(dir);
    // A map alongside the session must not overwrite the operator's own words.
    await writeFile(join(e, 'map.md'), '# Map\n\nthe map says something else\n', 'utf8');
    const scanned = (await scanProjects([dir]))[0]!;
    const ef = scanned.features.find((x) => x.slug === 'recorded')!;
    const d = await readDossier(ef, e);
    assert.equal(d.idea, 'show the whole record');
    assert.equal(d.ideaSource, 'session');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
