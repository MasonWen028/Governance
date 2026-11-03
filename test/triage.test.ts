import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyChange, followUpSlug } from '../src/tracker/triage.js';

/* The routing table.
 *
 * Each of these cases is a decision somebody could disagree with, so each one
 * asserts the *rule* that produced it and the *words* it matched — not just the
 * path. A test that only checked `path` would pass for the wrong reason the day
 * two rules start agreeing on an answer.
 */

const ACCEPTED = { accepted: true };
const OPEN = { accepted: false };

test('accepted work is a baseline: any change after release goes to a new feature', () => {
  /* The sentence is irrelevant here, and that is the point: after a release the
   * record is evidence that something shipped, and "it's only a typo" must not
   * be able to edit history. */
  for (const text of [
    'change the display text from hello world to Hello, DeepSeek',
    'the footer should say 2026',
    'rewrite the storage layer',
  ]) {
    const v = classifyChange({ text, ...ACCEPTED });
    assert.equal(v.path, 'follow-up', text);
    assert.equal(v.rule, 'baseline', text);
  }
  // The kind is still read, so the child feature knows how big it is.
  assert.equal(classifyChange({ text: 'the footer should say 2026', ...ACCEPTED }).kind, 'correction');
});

test('a correction before acceptance is amended where it was built', () => {
  /* The live example from the hello-world feature. */
  const v = classifyChange({
    text: 'I need to change the display text from hello world to Hello, DeepSeek',
    ...OPEN,
  });
  assert.equal(v.kind, 'correction');
  assert.equal(v.path, 'in-place');
  assert.equal(v.rule, 'amend-here');
  assert.ok(v.evidence.length > 0, 'a verdict without evidence is a guess');
});

test('wording is a refinement, and refinements stay in place', () => {
  const v = classifyChange({ text: 'rename the button label to "Send"', ...OPEN });
  assert.equal(v.kind, 'refinement');
  assert.equal(v.path, 'in-place');
});

test('a clear new-scope signal opens a new feature even before acceptance', () => {
  for (const text of [
    'also add a new report page',
    'we need support for an export flow',
    '顺便新增一个导出页面',
  ]) {
    const v = classifyChange({ text, ...OPEN });
    assert.equal(v.path, 'follow-up', text);
    assert.equal(v.rule, 'new-scope', text);
    assert.equal(v.kind, 'extension', text);
  }
});

test('a clear breaking signal opens a new feature: a decision is being superseded', () => {
  for (const text of [
    'rewrite the API layer',
    'replace the storage approach with something else',
    '把数据层重构掉',
  ]) {
    const v = classifyChange({ text, ...OPEN });
    assert.equal(v.path, 'follow-up', text);
    assert.equal(v.rule, 'breaking-decision', text);
    assert.equal(v.kind, 'breaking', text);
  }
});

test('a lean towards more scope does not open a feature', () => {
  /* The expensive mistake. Opening a feature costs a whole flow; an in-place
   * change that turns out to be bigger is caught by the grilling, which has the
   * spec in front of it. So the threshold for promoting is "it says so", not
   * "it hints at it". */
  const v = classifyChange({ text: 'maybe more pages later', ...OPEN });
  assert.equal(v.path, 'in-place');
  assert.equal(v.rule, 'lean-only');
  // Named, not "unclassified" — a matched phrase should not be reported as nothing.
  assert.equal(v.kind, 'extension');
});

test('a phrase that merely mentions replacing text is not a breaking change', () => {
  /* `replace the …` is a breaking signal only when its object is a system-level
   * thing. "replace the display text" must not cost a new feature. */
  const v = classifyChange({ text: 'replace the display text with Hello, DeepSeek', ...OPEN });
  assert.notEqual(v.kind, 'breaking');
  assert.equal(v.path, 'in-place');
});

test('nothing readable is amended here, and the verdict says so', () => {
  const v = classifyChange({ text: 'hmm, the vibe is off', ...OPEN });
  assert.equal(v.kind, 'unstated');
  assert.equal(v.path, 'in-place');
  assert.equal(v.rule, 'no-new-scope');
  assert.deepEqual(v.evidence, []);
});

test('the follow-up slug is derived from the parent and the change, not typed', () => {
  /* Two naming decisions would let the child's name hide which change made it. */
  assert.equal(followUpSlug('html-hello-world', 'CH-01'), 'html-hello-world-ch-01');
});
