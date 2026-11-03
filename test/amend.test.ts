import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordAmendment, sectionText, withoutAmendments } from '../src/tracker/amend.js';

/**
 * Amending a requirements document.
 *
 * The whole design hangs on one refusal: the original is never overwritten. A
 * spec that shows the current design and not the previous one has destroyed the
 * only record of what changed, and the person who most needs that record is the
 * one who did not make the change.
 */

const AT = '2026-11-01T12:00:00.000Z';

test('an amendment records the request, the time, and what it said before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-amend-'));
  try {
    await writeFile(
      join(dir, 'spec.md'),
      '# Requirements\n\n## Problem Statement\n\nPeople cannot sign in.\n\n## Solution\n\nA form posting to /login with email and password.\n',
      'utf8',
    );
    const { file, amendment } = await recordAmendment(dir, {
      id: 'CH-01',
      text: 'change 登陆 to 登录 on the login page',
      at: AT,
    });
    assert.equal(file, join(dir, 'spec.md'));
    assert.equal(amendment.section, 'Solution');
    assert.equal(amendment.previous, 'A form posting to /login with email and password.');

    const after = await readFile(join(dir, 'spec.md'), 'utf8');
    /* The old design is still in the document, in its original place — the
     * amendment does not move it, because "what it says now" has to be readable
     * without archaeology. */
    assert.ok(after.includes('A form posting to /login with email and password.'));
    assert.ok(after.includes('## Solution'));
    assert.ok(after.includes('CH-01'), 'the change is named');
    assert.ok(after.includes(AT), 'the time is on the record');
    assert.ok(after.includes('change 登陆 to 登录'), 'the request is in the human\'s words');
    /* "Modified at" and its date on the same line, not merely both somewhere in
     * the document: the amendment heading also carries the date, so checking
     * for the date alone passes even when the marker has been emptied. */
    assert.ok(after.includes('**Modified at:**'), 'it says it was modified, and when');
    assert.ok(
      after.includes(`**Modified at:** ${AT}`),
      'the marker carries the time on the same line, not just somewhere nearby',
    );
    /* Quoted, so the previous design survives even if the section above is
     * rewritten later by a run. */
    assert.ok(after.includes('> A form posting to /login'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second amendment quotes the state before it, not the state before that', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-amend-two-'));
  try {
    await writeFile(
      join(dir, 'spec.md'),
      '# Requirements\n\n## Solution\n\nFirst design.\n',
      'utf8',
    );
    await recordAmendment(dir, { id: 'CH-01', text: 'first change', at: AT });
    const second = await recordAmendment(dir, {
      id: 'CH-02',
      text: 'second change',
      at: '2026-11-02T09:00:00.000Z',
    });
    /* "Before this change" means before *this* one. Quoting the original twice
     * would make CH-02 look like it replaced the first design rather than the
     * amended one. */
    assert.equal(second.amendment.previous, 'First design.');
    const after = await readFile(join(dir, 'spec.md'), 'utf8');
    assert.ok(after.includes('first change'));
    assert.ok(after.includes('second change'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a feature with no spec gets one, and says nothing was on file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-amend-blank-'));
  try {
    /* The real case: a feature derived from a discovery has no spec yet, and the
     * first thing anyone asked for *is* the requirement. Refusing here would
     * block exactly the features the reading just created. */
    const { amendment } = await recordAmendment(dir, { id: 'CH-01', text: 'make it work', at: AT });
    assert.equal(amendment.previous, null);
    const after = await readFile(join(dir, 'spec.md'), 'utf8');
    assert.ok(after.includes('make it work'));
    assert.ok(
      /[Nn]othing was recorded/.test(after),
      'it says there was no prior design rather than implying one',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second change quotes the design, not the first change\'s amendment', async () => {
  /* The real failure, seen on a live project: the second amendment quoted the
   * whole document, which by then included the first amendment. Each change
   * then carries a copy of every change before it, and the sentence the reader
   * came for — what it originally said — sinks further down each time. */
  const dir = await mkdtemp(join(tmpdir(), 'gov-amend-nest-'));
  try {
    await writeFile(
      join(dir, 'spec.md'),
      '# Requirements\n\n## Solution\n\nA form posting to /login.\n',
      'utf8',
    );
    await recordAmendment(dir, { id: 'CH-01', text: 'first', at: AT });
    const second = await recordAmendment(dir, { id: 'CH-02', text: 'second', at: '2026-11-02T09:00:00.000Z' });
    assert.equal(second.amendment.previous, 'A form posting to /login.');

    const after = await readFile(join(dir, 'spec.md'), 'utf8');
    /* "first" appears once, in its own amendment — not a second time inside
     * CH-02's quotation of what came before it. */
    const times = after.split('first').length - 1;
    assert.equal(times, 1, `the first change is quoted back ${times} times`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a spec with no design heading does not quote its own amendment history', async () => {
  /* The case seen on a live project, and the one that matters most: a feature
   * derived from a reading has no Solution section, so the whole document is
   * what gets quoted. Once the document contains an amendment, quoting all of
   * it means quoting that amendment — and every change after that carries every
   * change before it. */
  const dir = await mkdtemp(join(tmpdir(), 'gov-amend-bare2-'));
  try {
    await writeFile(join(dir, 'spec.md'), '# Requirements\n\nTurn a form into an email.\n', 'utf8');
    await recordAmendment(dir, { id: 'CH-01', text: 'first change', at: AT });
    const second = await recordAmendment(dir, {
      id: 'CH-02', text: 'second change', at: '2026-11-02T09:00:00.000Z',
    });
    assert.equal(second.amendment.section, null, 'there is no design section to name');
    assert.ok(second.amendment.previous !== null, 'what it said is still captured');
    assert.ok(second.amendment.previous?.includes('Turn a form into an email.'),
      'the design is in what was captured');
    assert.ok(!second.amendment.previous?.includes('first change'),
      'the earlier amendment is quoted back inside the later one');
    assert.ok(!second.amendment.previous?.includes('Amendment'),
      'the amendment history is not part of "what it said before"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sectionText reads one section and stops at the next heading', () => {
  const md = '# T\n\n## Solution\n\nline one\nline two\n\n## Testing\n\nnot this\n';
  assert.equal(sectionText(md, 'Solution'), 'line one\nline two');
  assert.equal(sectionText(md, 'Testing'), 'not this');
  assert.equal(sectionText(md, 'Nothing'), null);
  /* An empty section is not a design. */
  assert.equal(sectionText('# T\n\n## Solution\n\n## Testing\n\nx\n', 'Solution'), null);
});

test('withoutAmendments keeps the design and drops the history', () => {
  const md = '# Requirements\n\n## Solution\n\nThe design.\n\n## Amendment — CH-01 — today\n\nblah\n';
  const kept = withoutAmendments(md);
  assert.ok(kept.includes('The design.'), 'the design is kept');
  assert.ok(!kept.includes('Amendment'), 'the amendment history is dropped');
  assert.equal(withoutAmendments('no amendments here'), 'no amendments here');
});

test('a spec with no known heading still keeps what it said', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-amend-bare-'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'spec.md'), 'Just one line describing it.\n', 'utf8');
    const { amendment } = await recordAmendment(dir, { id: 'CH-01', text: 'x', at: AT });
    assert.equal(amendment.section, null);
    assert.equal(amendment.previous, 'Just one line describing it.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
