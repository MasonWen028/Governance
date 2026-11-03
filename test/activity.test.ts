import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import {
  beginActivity,
  clearActivity,
  findActivity,
  readActivity,
} from '../src/server/activity.js';

/**
 * The record of what is happening.
 *
 * The property that matters is that a finished thing stops looking live. A dock
 * that keeps a spinner on work that ended is worse than no dock, because it
 * teaches the human to ignore it — and the whole reason this exists is the
 * question "is it stuck?".
 */

beforeEach(() => {
  clearActivity();
});

test('an activity records its steps and closes with a verdict', () => {
  const a = beginActivity({ kind: 'discovery', label: 'Reading acme', target: 'H:/acme' });
  a.note('pass 1 of 3: discovery', 'start');
  a.wrote('domain/domain-glossary.md');
  a.progress(0.33);

  const mid = findActivity(a.id);
  assert.ok(mid !== null);
  assert.equal(mid.status, 'running');
  assert.equal(mid.endedAt, null);
  assert.deepEqual(
    mid.steps.map((s) => s.kind),
    ['start', 'wrote'],
  );
  assert.equal(mid.progress, 0.33);

  a.end('succeeded');
  const done = findActivity(a.id);
  assert.ok(done !== null);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.endedAt !== null, 'a finished activity has an end');
  assert.equal(done.error, null);
});

test('a failed activity carries the reason, and stops counting as running', () => {
  const a = beginActivity({ kind: 'run', label: 'develop · one' });
  a.note('it broke', 'error');
  a.end('failed', 'the agent exited 1');

  const done = findActivity(a.id);
  assert.ok(done !== null);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'the agent exited 1');
  assert.equal(readActivity().filter((x) => x.status === 'running').length, 0);
});

test('progress is clamped, because a fraction above 1 is not a fraction', () => {
  const a = beginActivity({ kind: 'run', label: 'x' });
  a.progress(4);
  assert.equal(findActivity(a.id)?.progress, 1);
  a.progress(-2);
  assert.equal(findActivity(a.id)?.progress, 0);
});

test('running work is listed before finished work', () => {
  const first = beginActivity({ kind: 'run', label: 'first' });
  const second = beginActivity({ kind: 'run', label: 'second' });
  /* The *newer* one finishing is the case that decides it. Items are added at
   * the front, so an older job that ends is already below; it is the newer job
   * that has to sink beneath work still running. Without that, the list opens
   * with something that is over while the live job sits under the fold. */
  second.end('succeeded');

  const labels = readActivity().map((x) => x.label);
  assert.deepEqual(labels, ['first', 'second']);
  assert.equal(readActivity()[0]?.status, 'running');
  assert.equal(readActivity()[0]?.id, first.id);
});

test('finished work is kept, but not forever', () => {
  for (let i = 0; i < 60; i += 1) {
    beginActivity({ kind: 'run', label: `job ${i}` }).end('succeeded');
  }
  const items = readActivity();
  /* Bounded: an unbounded list is a leak with a scrollbar. */
  assert.ok(items.length <= 45, `kept ${items.length} finished items`);
  // The newest is still there, which is the one a human would look for.
  assert.equal(items[0]?.label, 'job 59');
});

test('a chattering run cannot grow the log without limit', () => {
  const a = beginActivity({ kind: 'run', label: 'noisy' });
  for (let i = 0; i < 400; i += 1) a.note(`line ${i}`);
  const steps = findActivity(a.id)?.steps ?? [];
  /* Bounded, and the newest are the ones kept: what happened a thousand lines
   * ago is not what anyone is looking at. */
  assert.ok(steps.length <= 200, `kept ${steps.length} steps`);
  assert.equal(steps[steps.length - 1]?.text, 'line 399');
});

test('missing work answers nothing rather than guessing', () => {
  assert.equal(findActivity('nope'), null);
  assert.deepEqual(readActivity(), []);
});
