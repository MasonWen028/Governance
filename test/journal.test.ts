import { strict as assert } from 'node:assert';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  JOURNAL_FILE,
  appendEvent,
  changesFrom,
  nextChangeId,
  openChangesFrom,
  readJournal,
  rebuild,
} from '../src/tracker/journal.js';

/* The journal is the durable half of the record: files say what the state is,
 * the journal says what happened and when. These tests hold it to the two
 * promises that make it worth having — it is append-only, and its contents are
 * derivable from the files (`rebuild`). An event a rebuild cannot find is an
 * event the record cannot prove. */

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

test('appendEvent creates the journal, one line per event, in order', async () => {
  const dir = await tmp('gov-journal-');
  try {
    // Not there yet: an empty journal, not an error and not a warning.
    const empty = await readJournal(dir);
    assert.deepEqual(empty.events, []);
    assert.deepEqual(empty.warnings, []);

    await appendEvent(dir, { at: '2026-10-31T00:00:01.000Z', kind: 'session.started', ref: 'ask', detail: 'idea' });
    await appendEvent(dir, {
      at: '2026-10-31T00:00:02.000Z',
      kind: 'change.opened',
      ref: 'CH-01',
      detail: 'hello world -> heja world',
      data: { text: 'change the greeting' },
    });

    const raw = await readFile(join(dir, JOURNAL_FILE), 'utf8');
    assert.equal(raw.trimEnd().split('\n').length, 2, 'one line per event');

    const { events, warnings } = await readJournal(dir);
    assert.deepEqual(warnings, []);
    assert.deepEqual(events.map((e) => e.kind), ['session.started', 'change.opened']);
    assert.equal(events[1]!.data?.['text'], 'change the greeting');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed line is reported and skipped; every good line survives', async () => {
  const dir = await tmp('gov-journal-bad-');
  try {
    await writeFile(
      join(dir, JOURNAL_FILE),
      [
        '{"at":"2026-10-31T00:00:00.000Z","kind":"session.started","ref":"ask","detail":"ok"}',
        'this is not json',
        '{"at":"not-a-time","kind":"round.written","ref":"round 1","detail":"bad timestamp"}',
        '{"at":"2026-10-31T00:00:03.000Z","kind":"invented.kind","ref":"x","detail":"unknown"}',
        '{"at":"2026-10-31T00:00:04.000Z","kind":"round.written","ref":"round 1","detail":"good"}',
      ].join('\n') + '\n',
      'utf8',
    );
    const { events, warnings } = await readJournal(dir);
    assert.deepEqual(events.map((e) => e.kind), ['session.started', 'round.written']);
    assert.equal(events[1]!.detail, 'good');
    // Three bad lines, three warnings — and the reasons differ, because
    // "not JSON" and "unknown kind" are different repairs.
    assert.equal(warnings.length, 3);
    assert.ok(warnings.some((w) => /not JSON/.test(w)));
    assert.ok(warnings.some((w) => /no usable timestamp/.test(w)));
    assert.ok(warnings.some((w) => /unknown kind/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('changesFrom folds open and close; a close without an open is not a change', async () => {
  const dir = await tmp('gov-journal-changes-');
  try {
    await appendEvent(dir, { at: '2026-10-31T00:00:01.000Z', kind: 'change.opened', ref: 'CH-01', detail: 'a', data: { text: 'first' } });
    await appendEvent(dir, { at: '2026-10-31T00:00:02.000Z', kind: 'change.opened', ref: 'CH-02', detail: 'b', data: { text: 'second' } });
    await appendEvent(dir, { at: '2026-10-31T00:00:03.000Z', kind: 'change.closed', ref: 'CH-01', detail: 'done', data: { note: 'handled' } });
    // A close with nothing opened: ignored rather than invented into a change.
    await appendEvent(dir, { at: '2026-10-31T00:00:04.000Z', kind: 'change.closed', ref: 'CH-09', detail: 'orphan' });

    const { events } = await readJournal(dir);
    const changes = changesFrom(events);
    assert.deepEqual(changes.map((c) => c.id), ['CH-01', 'CH-02']);
    assert.equal(changes[0]!.status, 'closed');
    assert.equal(changes[0]!.note, 'handled');
    assert.equal(changes[1]!.status, 'open');
    assert.equal(changes[1]!.closedAt, null);
    assert.equal(changes[1]!.text, 'second');

    // Ids are never reused, even after every change is closed.
    assert.equal(nextChangeId(events), 'CH-03');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a change handed to a follow-up feature closes here without claiming the work', async () => {
  const dir = await tmp('gov-journal-followup-');
  try {
    await appendEvent(dir, { at: '2026-10-31T00:00:01.000Z', kind: 'change.opened', ref: 'CH-01', detail: 'a', data: { text: 'absorbed here' } });
    await appendEvent(dir, { at: '2026-10-31T00:00:02.000Z', kind: 'change.opened', ref: 'CH-02', detail: 'b', data: { text: 'moved elsewhere' } });
    await appendEvent(dir, { at: '2026-10-31T00:00:03.000Z', kind: 'change.closed', ref: 'CH-01', detail: 'handled', data: { note: 'ticket T-04' } });
    await appendEvent(dir, {
      at: '2026-10-31T00:00:04.000Z',
      kind: 'change.followed-up',
      ref: 'CH-02',
      detail: 'moved to build-changes-ch02',
      data: { child: 'build-changes-ch02' },
    });
    // A handoff with nothing opened is ignored, exactly like an orphan close.
    await appendEvent(dir, { at: '2026-10-31T00:00:05.000Z', kind: 'change.followed-up', ref: 'CH-09', detail: 'orphan' });

    const { events } = await readJournal(dir);
    const changes = changesFrom(events);
    assert.deepEqual(changes.map((c) => c.id), ['CH-01', 'CH-02']);

    /* The distinction the whole record exists for: both are closed *here*, and
     * only one of them was done here. Folding them together would let a feature
     * report a change as handled when all it did was forward it. */
    assert.equal(changes[0]!.outcome, 'absorbed');
    assert.equal(changes[0]!.followedUpBy, null);
    assert.equal(changes[1]!.outcome, 'followed-up');
    assert.equal(changes[1]!.followedUpBy, 'build-changes-ch02');
    assert.equal(changes[1]!.status, 'closed');

    // And closed-by-handoff stops the feature from reading as "still asking".
    assert.deepEqual(openChangesFrom(events), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rebuild finds the events the files can prove', async () => {
  const dir = await tmp('gov-journal-rebuild-');
  try {
    await mkdir(join(dir, '.session'), { recursive: true });
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(
      join(dir, '.session', '01.json'),
      JSON.stringify({
        round: 1,
        questions: [{ id: 'q1', title: 'q', body: 'b', why: 'w', recommended: 'r', options: [] }],
        answers: [{ id: 'q1', answer: 'the answer' }],
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'runs', 'r1.json'),
      JSON.stringify({
        jobId: 'r1', stage: 'develop', skill: 'implement', status: 'succeeded',
        startedAt: '2026-10-31T01:00:00.000Z', endedAt: '2026-10-31T01:00:04.000Z', ms: 4000,
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'decisions.jsonl'),
      JSON.stringify({
        ts: '2026-10-31T02:00:00.000Z', gate: 'g1', outcome: 'pass', actor: 'po',
        methods: ['signoff'], evidence: [],
      }) + '\n',
      'utf8',
    );

    const events = await rebuild(dir);
    /* Sorted by kind, not by position: a rebuild orders by *when*, and the
     * round file's mtime is "now" while the run and decision carry their own
     * timestamps. What a rebuild has to get right is which events exist. */
    assert.deepEqual([...events.map((e) => e.kind)].sort(), [
      'answer.recorded', 'decision.recorded', 'round.written', 'run.ended', 'run.started',
    ]);
    const answer = events.find((e) => e.kind === 'answer.recorded')!;
    assert.equal(answer.ref, 'round 1');
    assert.deepEqual(answer.data?.['answers'], [{ id: 'q1', answer: 'the answer' }]);

    /* The property that matters: a journal written from what the rebuild found
     * must describe the same happenings when read back. Timestamps legitimately
     * differ — mtime is when a file landed, not when the thing happened — so the
     * comparison is on kind + ref. This is the round-trip a rebuild is for. */
    for (const e of events) {
      await appendEvent(dir, {
        at: e.at, kind: e.kind, ref: e.ref, detail: e.detail,
        ...(e.data === undefined ? {} : { data: e.data }),
      });
    }
    const { events: written } = await readJournal(dir);
    const shape = (list: readonly { kind: string; ref: string }[]): string[] =>
      list.map((e) => `${e.kind}:${e.ref}`).sort();
    assert.deepEqual(shape(written), shape(events));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the journal is never rewritten, only appended to', async () => {
  const dir = await tmp('gov-journal-append-');
  try {
    await appendEvent(dir, { at: '2026-10-31T00:00:01.000Z', kind: 'session.started', ref: 'ask', detail: 'one' });
    const first = await readFile(join(dir, JOURNAL_FILE), 'utf8');
    await appendEvent(dir, { at: '2026-10-31T00:00:02.000Z', kind: 'session.finished', ref: 'ask', detail: 'two' });
    const second = await readFile(join(dir, JOURNAL_FILE), 'utf8');
    assert.ok(second.startsWith(first), 'the earlier bytes are untouched');
    // Even a line that cannot be parsed stays where it was written.
    await appendFile(join(dir, JOURNAL_FILE), 'garbage\n', 'utf8');
    await appendEvent(dir, { at: '2026-10-31T00:00:03.000Z', kind: 'round.written', ref: 'round 1', detail: 'three' });
    const third = await readFile(join(dir, JOURNAL_FILE), 'utf8');
    assert.ok(third.includes('garbage'));
    const { events } = await readJournal(dir);
    assert.equal(events.length, 3, 'three valid events; the bad line was skipped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
