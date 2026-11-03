import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { legacyBody, legacyParam, legacyString } from '../src/domain/legacy.js';
import { JOURNAL_FILE, readJournal } from '../src/tracker/journal.js';
import { readRunRecords, writeRunRecord } from '../src/tracker/runs.js';
import { readSession } from '../src/session/session.js';
import { branchName } from '../src/tracker/pr.js';
import { scanProject } from '../src/tracker/discover.js';
import type { RunRecord } from '../src/tracker/runs.js';

/* Reading records written before `effort` became `feature`.
 *
 * A rename that only changed the code would be a rename that quietly discarded
 * every session, run and journal written before it — the record would load as
 * blank, and blank looks like "nothing happened" rather than "the word moved".
 * These tests are the ones that say otherwise, and they are written against the
 * *old* file shapes on purpose: a fixture that used the new spelling could not
 * tell the difference between a fallback that works and one that was never
 * needed. */

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

test('legacyString prefers the new key and falls back to the old', () => {
  assert.equal(legacyString({ feature: 'new' }, 'feature'), 'new');
  assert.equal(legacyString({ effort: 'old' }, 'feature'), 'old');
  assert.equal(legacyString({ effort: 'old', feature: 'new' }, 'feature'), 'new',
    'both present: the new spelling wins, because it is the one written now');
  assert.equal(legacyString({}, 'feature'), null);

  // The rule is not special-cased to one key: any `feature*` key has a twin.
  assert.equal(legacyString({ effortDir: 'C:\\old' }, 'featureDir'), 'C:\\old');
  assert.equal(legacyString({ effortDir: 'C:\\old', featureDir: 'C:\\new' }, 'featureDir'), 'C:\\new');
});

test('legacyString treats a blank key as absent, so an empty string is never a value', () => {
  /* A key present but empty is the shape a half-written record takes. Reading
   * it as a value would make a blank feature look like a selection. */
  assert.equal(legacyString({ feature: '', effort: 'old' }, 'feature'), 'old');

  /* Only *blank* counts as absent, not whitespace. This reader reports the value
   * that is there and leaves the verdict to the slug rule downstream; deciding
   * here that a whitespace record is corrupt would put a second opinion where
   * one is enough, and the two could disagree. */
  assert.equal(legacyString({ feature: '   ' }, 'feature'), '   ');
  assert.equal(legacyString({ feature: '   ', effort: 'old' }, 'feature'), '   ',
    'a key that is present is not treated as missing, even when it looks wrong');

  assert.equal(legacyString(null, 'feature'), null);
  assert.equal(legacyString(undefined, 'feature'), null);
});

test('legacyParam and legacyBody read the old spelling of a parameter', () => {
  const now = new URLSearchParams('feature=a-feature');
  const then = new URLSearchParams('effort=a-feature');
  assert.equal(legacyParam(now, 'feature'), 'a-feature');
  assert.equal(legacyParam(then, 'feature'), 'a-feature');

  assert.equal(legacyBody({ feature: 'a' }, 'feature'), 'a');
  assert.equal(legacyBody({ effort: 'a' }, 'feature'), 'a');
  assert.equal(legacyBody({}, 'feature'), '');
});

test('a journal line written as effort.derived is still part of the record', async () => {
  const dir = await tmp('gov-legacy-journal-');
  try {
    /* Written the way an older build wrote it. `readJournal` gates every line
     * on its kind, so a kind it no longer recognises is a line that silently
     * stops being history — this is the case that would lose it. */
    await writeFile(
      join(dir, JOURNAL_FILE),
      [
        '{"at":"2026-10-31T00:00:01.000Z","kind":"session.started","ref":"ask","detail":"idea"}',
        '{"at":"2026-10-31T00:00:02.000Z","kind":"effort.derived","ref":"parent-feature","detail":"opened from CH-02","data":{"parent":"parent-feature","change":"CH-02"}}',
      ].join('\n') + '\n',
      'utf8',
    );

    const { events, warnings } = await readJournal(dir);
    assert.deepEqual(warnings, [], 'an old kind is not a malformed line');
    assert.deepEqual(events.map((e) => e.kind), ['session.started', 'feature.derived']);

    const derived = events[1]!;
    assert.equal(derived.data?.['parent'], 'parent-feature');
    assert.equal(derived.data?.['change'], 'CH-02');

    // And it stays an unknown kind that is still refused.
    await writeFile(
      join(dir, JOURNAL_FILE),
      '{"at":"2026-10-31T00:00:03.000Z","kind":"effort.invented","ref":"x","detail":"nope"}\n',
      'utf8',
    );
    const bad = await readJournal(dir);
    assert.equal(bad.events.length, 0);
    assert.ok(bad.warnings.some((w) => /unknown kind/.test(w)),
      'accepting the old spelling must not accept anything else');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanProject still reports the lineage of a feature derived under the old word', async () => {
  const root = await tmp('gov-legacy-scan-');
  try {
    const dir = join(root, '.scratch', 'child-feature');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'map.md'), '# Map: child\n\n## Destination\n\n> Inherited work.\n', 'utf8');
    await writeFile(
      join(dir, JOURNAL_FILE),
      '{"at":"2026-10-31T00:00:01.000Z","kind":"effort.derived","ref":"parent-feature","detail":"opened from CH-02","data":{"parent":"parent-feature","change":"CH-02","text":"add a clock"}}\n',
      'utf8',
    );

    const project = await scanProject(root);
    const child = project.features.find((f) => f.slug === 'child-feature');
    assert.ok(child, 'the feature is found');
    /* The point of the pointer: a feature whose scope moved on has to be able to
     * say where it came from, or the change reads as dropped. */
    assert.equal(child?.derivedFrom?.parent, 'parent-feature');
    assert.equal(child?.derivedFrom?.change, 'CH-02');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a run record written with effort reads back with feature', async () => {
  const dir = await tmp('gov-legacy-runs-');
  try {
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(
      join(dir, 'runs', 'job-1.json'),
      JSON.stringify({
        jobId: 'job-1', root: 'C:\\repo', effort: 'the-feature', stage: 'develop',
        skill: 'implement-spec', status: 'succeeded',
        startedAt: '2026-10-31T01:00:00.000Z', endedAt: '2026-10-31T01:00:04.000Z',
        exitCode: 0, error: null, ms: 4000, demo: false,
      }),
      'utf8',
    );

    const records = await readRunRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.feature, 'the-feature',
      'the feature it ran against is not lost to a key rename');
    assert.equal(records[0]!.stage, 'develop');

    // A record written today round-trips with the new key.
    const fresh: RunRecord = {
      jobId: 'job-2', root: 'C:\\repo', feature: 'new-feature', stage: 'review',
      skill: 'code-review', status: 'running',
      startedAt: '2026-11-01T01:00:00.000Z', endedAt: null,
      exitCode: null, error: null, ms: null, demo: false,
    };
    await writeRunRecord(dir, fresh);
    const both = await readRunRecords(dir);
    assert.deepEqual(both.map((r) => r.feature), ['the-feature', 'new-feature']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a session state written with effort and effortDir resumes under the new words', async () => {
  const dir = await tmp('gov-legacy-session-');
  try {
    await mkdir(join(dir, '.session'), { recursive: true });
    const onDisk = JSON.stringify({
      effort: 'the-feature',
      effortDir: dir,
      repoRoot: 'C:\\repo',
      idea: 'an idea written before the rename',
      conversationId: 'ses_old',
      answeredRounds: 3,
      pending: null,
      phase: 'asking',
      failure: null,
      source: 'none',
      warnings: [],
      updated: '2026-10-31T11:28:13.052Z',
    });
    await writeFile(join(dir, '.session', 'state.json'), onDisk, 'utf8');

    const state = await readSession(dir);
    assert.ok(state, 'the session is found');
    assert.equal(state?.feature, 'the-feature');
    assert.equal(state?.featureDir, dir);
    assert.equal(state?.idea, 'an idea written before the rename');
    assert.equal(state?.conversationId, 'ses_old');

    /* `answeredRounds` is *derived* from the round files, not taken from the
     * cache — so a state file claiming three answers with none on disk reads as
     * zero. That the cache's own number loses is the design (a session is what
     * its artifacts prove), not an artefact of the rename, and it is why the
     * rename had to reach this reader at all: without the fallback the whole
     * record would have come back blank, derivation included. */
    assert.equal(state?.answeredRounds, 0, 'derived from the artifacts, not the cache');

    /* The promise that makes the fallback honest rather than convenient: reading
     * an old record does not convert it. The file keeps what was written, so a
     * rebuild and an audit still see the original. */
    const after = await readFile(join(dir, '.session', 'state.json'), 'utf8');
    assert.equal(after, onDisk, 'reading never rewrites the record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a branch template saved as {effort} still resolves', () => {
  const ctx = { project: 'demo', feature: 'the-feature' };
  assert.equal(branchName('feat/{feature}', ctx), 'feat/the-feature');
  assert.equal(branchName('feat/{effort}', ctx), 'feat/the-feature',
    'a template in someone’s settings file is not invalidated by a rename');
  assert.equal(branchName('feat/{slug}', ctx), 'feat/the-feature');
});
