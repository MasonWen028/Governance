import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Feature } from '../src/domain/types.js';
import { disambiguationPrompt, locateFeature, tokens } from '../src/tracker/locate.js';

/**
 * Finding which feature a sentence is about.
 *
 * The failure this exists to prevent is quiet: a change opens against the wrong
 * feature, gets coded, and the wrong feature's journal now says a decision was
 * made there. Nothing errors. So the tests are mostly about *refusing* —
 * refusing to guess on a tie, refusing to match on a word that carries no
 * information, refusing when nothing matched at all.
 */

function feature(slug: string, destination: string, extra: Partial<Feature> = {}): Feature {
  return {
    slug,
    root: `/work/.scratch/${slug}`,
    kind: 'map',
    destination,
    notes: [],
    decisionsSoFar: [],
    notYetSpecified: [],
    outOfScope: [],
    tickets: [],
    gates: [],
    stages: {} as Feature['stages'],
    warnings: [],
    ...extra,
  } as Feature;
}

const FEATURES = [
  feature('login-page', '登录页面 — let a registered user sign in with email and password'),
  feature('billing', 'Charge a card and write an invoice for the subscription'),
  feature('blog', 'Publish posts newest-first, six per page'),
];

test('a request naming its feature finds it, and says why', () => {
  const found = locateFeature(FEATURES, 'change 登陆 to 登录 on the login page');
  assert.equal(found.best?.slug, 'login-page');
  assert.ok(found.confident, 'a clear winner is acted on, not offered as a choice');
  assert.ok(
    (found.best?.reasons ?? []).some((r) => r.includes('slug')),
    'the reason names the slug match, so a human can check it',
  );
});

test('a request naming another feature finds that one', () => {
  const found = locateFeature(FEATURES, 'the invoice should show tax');
  assert.equal(found.best?.slug, 'billing');
});

test('CJK is matched without a dictionary, because it has no spaces', () => {
  const found = locateFeature(FEATURES, '把登录页面的登陆改成登录');
  assert.equal(found.best?.slug, 'login-page');
  /* The point of the bigram split: 登录 appears inside one unspaced run, and a
   * word-splitter would see one opaque blob and match nothing. */
  assert.ok(tokens('登录页面').length > 1, 'an unspaced run yields comparable units');
});

test('when two features both describe it, the one carrying the name wins', () => {
  /* Why the slug is weighted above a passing mention: both features here are
   * about signing in and both say so, but only one is *called* login and only
   * the request says "login". With the slug counting no more than any other
   * word, these two score within one of each other and the answer is refused —
   * the human is asked a question the system already had the answer to. */
  const two = [
    feature('login', 'Let a registered user in'),
    feature('session', 'Let a registered user login and stay logged in'),
  ];
  const found = locateFeature(two, 'login is broken');
  assert.equal(found.best?.slug, 'login');
  assert.ok(found.confident, 'the feature carrying the name wins by a real margin');
});

test('a tie is not a decision', () => {
  const two = [
    feature('alpha', 'Change the login wording'),
    feature('beta', 'Change the login wording'),
  ];
  const found = locateFeature(two, 'change the login wording');
  assert.equal(found.confident, false, 'two identical features must not be decided by order');
  assert.equal(found.candidates.length, 2, 'both are shown');
});

test('nothing matching is reported as nothing, not as the first feature', () => {
  const found = locateFeature(FEATURES, 'zzzz qqqq');
  assert.equal(found.best, null);
  assert.equal(found.confident, false);
  assert.deepEqual(found.candidates, []);
});

test('glue words in the request are not evidence', () => {
  /* "the" and "it" turn up inside almost any English sentence — and inside
   * ordinary words like "site". Counting them would let a request that names
   * nothing in particular score as high as one that does, and turn "change it"
   * into a confident decision about a feature.
   *
   * Checked on the reasons rather than on a total score: the reasons *are* the
   * recorded evidence, so a glue word appearing in them is the failure itself,
   * whatever the arithmetic around it happens to do. */
  const GLUE = ['change', 'it', 'in', 'the'];
  const asked = tokens('change it in the index');
  for (const word of GLUE) {
    assert.ok(!asked.includes(word), `"${word}" must not be treated as evidence`);
  }
  const found = locateFeature(
    [feature('site-search', 'Search the site index for items')],
    'change it in the index',
  );
  for (const reason of found.best?.reasons ?? []) {
    assert.ok(!GLUE.includes(reason), `"${reason}" is a glue word and must not be cited`);
  }
});

test('a single weak match is not enough to act on', () => {
  /* "the" is a stopword and "change" is too; a real single-token hit on a short
   * common word should not be mistaken for evidence. */
  const found = locateFeature([feature('blog', 'Publish posts')], 'post it');
  assert.equal(found.confident, false, 'one short match does not carry a decision');
});

test('a feature with no destination still gets a line the agent can read', () => {
  /* The real case: a feature derived from a reading has no map yet, so there is
   * no destination to quote. Two blank descriptions make the choice a coin
   * toss, which is the thing this prompt exists to avoid. */
  const two = [
    feature('enquiry', ''),
    feature('site-operations', ''),
  ];
  const found = locateFeature(two, 'the enquiry form should send a copy to the site owner');
  assert.equal(found.confident, false);
  const prompt = disambiguationPrompt('x', found.candidates, two);
  for (const c of found.candidates) {
    const line = prompt.split('\n').find((l) => l.includes(c.slug));
    assert.ok(line !== undefined, `no line for ${c.slug}`);
    const after = (line ?? '').split('—')[1] ?? '';
    assert.ok(after.trim().length > 0, `${c.slug} is described by nothing at all`);
    assert.ok(
      !/\bundefined\b/.test(after),
      `${c.slug}'s line says "undefined": ${after}`,
    );
  }
});

test('a two-letter word is not evidence, because it lives inside other words', () => {
  /* "be" is inside "publishing", "is" inside "register". Counting them lets a
   * sentence match a feature on a fragment nobody wrote — the same failure as
   * the stopwords, reached by length instead of by frequency. */
  assert.ok(!tokens('be able to publish').includes('be'), '"be" was counted');
  assert.ok(!tokens('is it').includes('is'), '"is" was counted');
  const found = locateFeature(
    [feature('content-publishing', 'Publish posts newest-first')],
    'be able to publish',
  );
  assert.deepEqual(
    found.best?.reasons ?? [],
    ['publish'],
    'the only real word is the only reason cited',
  );
});

test('the disambiguation prompt carries the request and the shortlist', () => {
  const found = locateFeature(FEATURES, 'change the wording');
  const prompt = disambiguationPrompt('change the wording', found.candidates, FEATURES);
  assert.ok(prompt.includes('change the wording'), 'the request travels with it');
  for (const c of found.candidates) {
    assert.ok(prompt.includes(c.slug), `the prompt omits ${c.slug}`);
  }
  /* Without this the agent is handed a list and no way to say "none of these",
   * and an agent that must choose will choose. */
  assert.ok(/none/i.test(prompt), 'the agent is not told it may answer "none"');
});
