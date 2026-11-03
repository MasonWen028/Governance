import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { areaSlug, deriveAreaFeatures, discoveredAreas } from '../src/tracker/areas.js';
import { JOURNAL_FILE, readJournal } from '../src/tracker/journal.js';
import { FEATURE_SLUG } from '../src/tracker/scaffold.js';

/**
 * Turning discovered areas into features.
 *
 * The two claims worth holding down are both about honesty of source. The area
 * list has to come from what the reading actually wrote — not from a heading
 * this tool found convenient — and the feature has to start empty of decisions,
 * because a feature that arrives with a spec already written has quietly made
 * the decisions that were the human's to make.
 */

let root: string;
const OUT = 'docs/discovery';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-areas-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});


test('areaSlug produces a name the scaffolder will accept', () => {
  for (const name of [
    'Quote Request',
    'Blog & Content',
    '  Deployment  ',
    'Admin / Staff',
    'e-waste intake',
    'Public pages',
  ]) {
    const slug = areaSlug(name);
    assert.ok(
      FEATURE_SLUG.test(slug),
      `${JSON.stringify(name)} produced ${JSON.stringify(slug)}, which is not a feature slug`,
    );
  }
  assert.equal(areaSlug('Quote Request'), 'quote-request');
  assert.equal(areaSlug('Blog & Content'), 'blog-content');
  /* A name that reduces to nothing still names an area. Refusing it would lose
   * the area; calling it "area" is at least visible and fixable. */
  assert.equal(areaSlug('!!!'), 'area');
  assert.ok(areaSlug('x'.repeat(200)).length <= 64);
});

test('discoveredAreas reads the areas the reading wrote, and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-areas-list-'));
  try {
    await mkdir(join(dir, OUT, 'areas'), { recursive: true });
    await writeFile(
      join(dir, OUT, 'areas', 'quote-request.md'),
      '# Quote Request\n\nCaptures an enquiry and emails it to the right mailbox.\n\n## Detail\n\n- one\n',
      'utf8',
    );
    /* Everything that is not prose comes first on purpose: a blockquote header,
     * a bullet list, a table and a fenced diagram. The purpose is the sentence
     * after all of them — quoting any of the furniture back as the area's
     * purpose would make the feature look like it was described by a diagram. */
    await writeFile(
      join(dir, OUT, 'areas', 'blog.md'),
      [
        '# Blog',
        '',
        '> **Status:** code-derived',
        '',
        '- lists posts newest-first',
        '- six per page',
        '',
        '| ID | Requirement |',
        '|---|---|',
        '| FR-10 | list posts |',
        '',
        '```text',
        'home -> blog -> post',
        '```',
        '',
        'Lists posts newest-first, six to a page.',
        '',
      ].join('\n'),
      'utf8',
    );
    // Not markdown, so not an area document.
    await writeFile(join(dir, OUT, 'areas', 'notes.txt'), 'ignore me', 'utf8');

    const areas = await discoveredAreas(dir, OUT);
    assert.deepEqual(
      areas.map((a) => a.name),
      ['Blog', 'Quote Request'],
      'sorted, from the headings the reading chose',
    );
    assert.deepEqual(
      areas.map((a) => a.slug),
      ['blog', 'quote-request'],
    );
    const quote = areas.find((a) => a.slug === 'quote-request');
    assert.ok(quote !== undefined);
    assert.equal(
      quote.purpose,
      'Captures an enquiry and emails it to the right mailbox.',
      'the purpose is prose, not the first table row or bullet',
    );
    assert.equal(quote.file, 'areas/quote-request.md');

    const blog = areas.find((a) => a.slug === 'blog');
    assert.ok(blog !== undefined);
    assert.equal(blog.purpose, 'Lists posts newest-first, six to a page.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no areas directory means no areas, not invented ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-areas-none-'));
  try {
    await mkdir(join(dir, OUT, 'domain'), { recursive: true });
    await writeFile(join(dir, OUT, 'domain', 'domain-glossary.md'), '# Glossary\n', 'utf8');
    /* The refusal is the point. A heading elsewhere in the docs mentions areas;
     * scraping it would produce a boundary the reading never drew, and every
     * feature made from it would inherit that guess. */
    assert.deepEqual(await discoveredAreas(dir, OUT), []);

    const empty = await mkdtemp(join(tmpdir(), 'gov-areas-empty-'));
    await mkdir(join(empty, OUT, 'areas'), { recursive: true });
    assert.deepEqual(await discoveredAreas(empty, OUT), [], 'an areas/ with nothing in it');
    await rm(empty, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a discovered area becomes a feature with a reason and a reading list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-areas-derive-'));
  try {
    await mkdir(join(dir, OUT, 'areas'), { recursive: true });
    await writeFile(
      join(dir, OUT, 'areas', 'quote-request.md'),
      '# Quote Request\n\nCapture an enquiry and route it by service category.\n',
      'utf8',
    );
    const areas = await discoveredAreas(dir, OUT);
    assert.equal(areas.length, 1);

    const made = await deriveAreaFeatures({
      root: dir,
      outputRoot: OUT,
      areas,
      now: () => new Date('2026-11-01T00:00:00Z'),
    });
    assert.equal(made.length, 1);
    const only = made[0];
    assert.ok(only !== undefined, 'no feature was created');
    assert.equal(only.slug, 'quote-request');
    assert.equal(only.name, 'Quote Request');

    const featureDir = join(dir, '.scratch', 'quote-request');
    assert.deepEqual(await readdir(featureDir).then((f) => f.sort()), ['INHERITED.md', JOURNAL_FILE]);

    /* The record says where the feature came from, so a directory is never found
     * on disk without an answer to "why is this here". */
    const journal = await readJournal(featureDir);
    assert.equal(journal.events.length, 1);
    const event = journal.events[0];
    assert.ok(event !== undefined, 'the feature has no journal line');
    assert.equal(event.kind, 'feature.derived');
    assert.equal(event.ref, 'discovery/areas/quote-request.md');

    const inherited = await readFile(join(featureDir, 'INHERITED.md'), 'utf8');
    assert.ok(inherited.includes('Quote Request'), 'it names the area');
    assert.ok(
      inherited.includes('Capture an enquiry and route it by service category.'),
      'it carries what the reading said',
    );
    for (const doc of [
      'domain/domain-glossary.md',
      'business/business-requirements.md',
      'tech/current-architecture.md',
      'areas/quote-request.md',
    ]) {
      assert.ok(inherited.includes(doc), `the reading list does not point at ${doc}`);
    }
    assert.ok(/Do not write anything under/.test(inherited), 'it says the docs are inputs');

    /* Nothing was decided on the human's behalf. A feature arriving with a spec
     * has already answered the questions the intake stage exists to ask. */
    for (const not of ['spec.md', 'map.md', 'issues']) {
      assert.ok(
        !(await readdir(featureDir)).includes(not),
        `the feature arrived with ${not} already written`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an area whose name is taken is numbered, not reused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-areas-clash-'));
  try {
    await mkdir(join(dir, OUT, 'areas'), { recursive: true });
    await writeFile(join(dir, OUT, 'areas', 'blog.md'), '# Blog\n\nPosts.\n', 'utf8');
    const areas = await discoveredAreas(dir, OUT);

    const first = await deriveAreaFeatures({ root: dir, outputRoot: OUT, areas });
    assert.deepEqual(first.map((f) => f.slug), ['blog']);

    const second = await deriveAreaFeatures({ root: dir, outputRoot: OUT, areas });
    assert.deepEqual(
      second.map((f) => f.slug),
      ['blog-2'],
      'the existing feature is left alone and the new one is visible as a second',
    );
    /* Deriving twice is not idempotent, and that is deliberate: a second
     * derivation is a second decision, so it is a second feature rather than a
     * silent no-op that looks like success. */
    assert.equal((await readJournal(join(dir, '.scratch', 'blog'))).events.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
