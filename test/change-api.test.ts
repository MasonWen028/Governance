import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { serve } from '../src/server/http.js';
import { DEFAULT_SETTINGS, writeSettings } from '../src/config/settings.js';

/**
 * Filing a change from a sentence, over a real socket.
 *
 * The failure this exists to prevent is the quiet one: the sentence is routed to
 * a feature, the feature's journal records a decision, and the requirements
 * document is rewritten — all on the strength of a guess nobody checked. So the
 * tests are mostly about what the endpoint *declines* to do. Where it cannot
 * tell which feature is meant, it must say so and write nothing, because a
 * decision in the wrong feature's record is harder to undo than a question.
 */

let base: string;
let port: number;
let settingsFile: string;
let workspacesFile: string;
const stop = new AbortController();

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-change-api-'));
  settingsFile = join(root, 'governance.settings.json');
  workspacesFile = join(root, 'governance.workspaces.json');
  await writeSettings(DEFAULT_SETTINGS, settingsFile);

  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
  const addr = probe.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  base = `http://127.0.0.1:${port}`;

  void serve({ roots: [root], port, settingsPath: settingsFile, workspacesPath: workspacesFile,
    signal: stop.signal });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not come up');
});

after(() => {
  stop.abort();
});

/**
 * A workspace with two features, each with a map naming where it is going and a
 * spec recording the design as it stands.
 */
async function workspaceWithFeatures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gov-change-api-target-'));
  for (const [slug, destination, solution] of [
    ['login-page', '登录页面 — let a registered user sign in', 'A form posting to /login.'],
    ['billing', 'Charge a card and write an invoice', 'One charge per subscription month.'],
  ] as const) {
    const featureDir = join(dir, '.scratch', slug);
    await mkdir(featureDir, { recursive: true });
    await writeFile(
      join(featureDir, 'map.md'),
      `# ${slug}\n\n## Destination\n\n> ${destination}\n`,
      'utf8',
    );
    await writeFile(
      join(featureDir, 'spec.md'),
      `# Requirements\n\n## Solution\n\n${solution}\n`,
      'utf8',
    );
  }
  const r = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  assert.equal(r.status, 201, 'the workspace was not registered');
  return dir;
}

async function post(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const journalOf = (dir: string, slug: string) =>
  readFile(join(dir, '.scratch', slug, 'journal.jsonl'), 'utf8').catch(() => '');

test('find: a sentence naming its feature is routed, with the reason shown', async () => {
  const dir = await workspaceWithFeatures();
  try {
    const { status, body } = await post('/api/change/find', {
      root: dir,
      text: '帮我将登录页面中的登陆修改为登录',
    });
    assert.equal(status, 200);
    const best = body['best'] as { slug: string; reasons: string[] } | null;
    assert.equal(best?.slug, 'login-page');
    assert.equal(body['confident'], true);
    /* The reasons are quoted back in the words the request itself used — this
     * one is written entirely in Chinese, so there is no latin word to cite and
     * the evidence is the bigrams. A reason the human cannot find in their own
     * sentence is not a reason they can check. */
    const reasons = best?.reasons ?? [];
    assert.ok(reasons.length > 0, 'the answer says why, so it can be argued with');
    for (const reason of reasons) {
      assert.ok(
        '帮我将登录页面中的登陆修改为登录'.includes(reason),
        `"${reason}" is cited as evidence but is not in the request`,
      );
    }
    /* Finding is not filing. Nothing should have been written by a lookup. */
    assert.equal(await journalOf(dir, 'login-page'), '', 'a lookup already wrote to the journal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('find: where the rules cannot tell, an agent prompt is offered — but not used', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-change-api-ambiguous-'));
  try {
    /* Two features that say the same thing, so neither can win on merit. */
    for (const slug of ['login', 'session']) {
      const featureDir = join(dir, '.scratch', slug);
      await mkdir(featureDir, { recursive: true });
      await writeFile(
        join(featureDir, 'map.md'),
        `# ${slug}\n\n## Destination\n\n> Let a registered user sign in\n`,
        'utf8',
      );
    }
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(r.status, 201);

    const { status, body } = await post('/api/change/find', {
      root: dir,
      text: 'registered user',
    });
    assert.equal(status, 200);
    assert.equal(body['confident'], false, 'two indistinguishable features are not decided by order');
    assert.ok((body['candidates'] as unknown[]).length >= 2, 'the alternatives are shown');
    const prompt = body['askPrompt'];
    assert.equal(typeof prompt, 'string', 'a way to resolve it is offered');
    assert.ok(
      /none/i.test(prompt as string),
      'the offered prompt lets the answer be "none of these"',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('find: a derived feature is matched by the words it inherited, not only its slug', async () => {
  /* The case that was broken on a real project: a feature made from a reading
   * has no map and no destination, so the only words on file are in its
   * INHERITED.md. Matching the slug alone meant "the quote form" found nothing
   * and the human was asked a question the tool already had the answer to. */
  const dir = await mkdtemp(join(tmpdir(), 'gov-change-api-derived-'));
  try {
    const featureDir = join(dir, '.scratch', 'enquiry');
    await mkdir(featureDir, { recursive: true });
    await writeFile(
      join(featureDir, 'INHERITED.md'),
      '# Inherited from the discovery of this codebase\n\n' +
        "This feature exists because the reading named **Enquiry**.\n\n" +
        '## What the reading said\n\n' +
        "> Turn a visitor's quote request into an email routed to the right internal mailbox.\n",
      'utf8',
    );
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(r.status, 201);

    const { status, body } = await post('/api/change/find', {
      root: dir,
      text: 'the quote form should accept a phone number',
    });
    assert.equal(status, 200);
    const best = body['best'] as { slug: string; reasons: string[] } | null;
    assert.equal(best?.slug, 'enquiry', 'a word only present in INHERITED.md was not matched');
    assert.ok(
      (best?.reasons ?? []).includes('quote'),
      'it says which word matched: ' + JSON.stringify(best?.reasons),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('find: refuses a root that is not a configured workspace', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'gov-change-api-outside-'));
  try {
    const { status } = await post('/api/change/find', { root: outside, text: 'anything' });
    assert.equal(status, 403, 'an unregistered root is not routed through this endpoint');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('apply: the change is filed, decided, and the spec moves with it', async () => {
  const dir = await workspaceWithFeatures();
  try {
    const { status, body } = await post('/api/change/apply', {
      root: dir,
      text: '帮我将登录页面中的登陆修改为登录',
    });
    assert.equal(status, 201);
    assert.equal(body['feature'], 'login-page', 'it was routed to the feature that said so');
    const amendment = body['amendment'] as { id: string; previous: string | null; at: string };
    assert.equal(amendment.id, 'CH-01');
    /* The prior design was captured — that is the whole point of the amendment,
     * and it is what lets the next reader see what changed and from what. */
    assert.equal(amendment.previous, 'A form posting to /login.');
    assert.ok(typeof body['activityId'] === 'string', 'the work was not tracked');

    const spec = await readFile(join(dir, '.scratch', 'login-page', 'spec.md'), 'utf8');
    assert.ok(spec.includes('A form posting to /login.'), 'the original design is still there');
    assert.ok(spec.includes('> A form posting to /login.'), 'it is quoted back as what it was');
    assert.ok(spec.includes('**Modified at:**'), 'the spec says it was modified');
    assert.ok(spec.includes(amendment.at), 'and says when');
    assert.ok(spec.includes('登陆'), "the request is kept in the words it was filed in");

    const journal = await journalOf(dir, 'login-page');
    assert.ok(journal.includes('change.opened'), 'the change is on the record');
    assert.ok(journal.includes('change.decided'), 'and so is the routing decision');
    assert.ok(
      journal.includes('"locatedBy":"locate"'),
      'the record says the tool chose, not the human',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply: when it cannot tell which feature, it writes nothing and asks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-change-api-refuse-'));
  try {
    for (const slug of ['login', 'session']) {
      const featureDir = join(dir, '.scratch', slug);
      await mkdir(featureDir, { recursive: true });
      await writeFile(
        join(featureDir, 'map.md'),
        `# ${slug}\n\n## Destination\n\n> Let a registered user sign in\n`,
        'utf8',
      );
      await writeFile(
        join(featureDir, 'spec.md'),
        `# Requirements\n\n## Solution\n\nOriginal ${slug} design.\n`,
        'utf8',
      );
    }
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(r.status, 201);

    const { status, body } = await post('/api/change/apply', { root: dir, text: 'registered user' });
    assert.equal(status, 200);
    assert.equal(body['needsChoice'], true, 'it says it needs a choice rather than making one');
    assert.equal(body['text'], 'registered user', 'the sentence is handed back, not lost');
    assert.ok((body['candidates'] as unknown[]).length >= 2, 'the alternatives come with it');

    /* The refusal that matters: nothing was written to either feature. A
     * decision recorded against the wrong one is the expensive mistake, and it
     * cannot be undone by a later apology. */
    for (const slug of ['login', 'session']) {
      assert.equal(await journalOf(dir, slug), '', `a refusal still wrote to ${slug}`);
      const spec = await readFile(join(dir, '.scratch', slug, 'spec.md'), 'utf8');
      assert.ok(!spec.includes('Amendment'), `${slug}'s spec was amended on a refusal`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply: naming the feature outright is recorded as stated, not as a guess', async () => {
  const dir = await workspaceWithFeatures();
  try {
    /* The sentence on its own belongs to billing; the human says login-page.
     * What they said wins, and the record must show that they said it — a later
     * reader has to be able to tell a decision from a deduction. */
    const { status, body } = await post('/api/change/apply', {
      root: dir,
      text: 'the invoice should show tax',
      feature: 'login-page',
    });
    assert.equal(status, 201);
    assert.equal(body['feature'], 'login-page');
    const journal = await journalOf(dir, 'login-page');
    assert.ok(journal.includes('"locatedBy":"stated"'), 'the record says the human named it');
    assert.equal(
      await journalOf(dir, 'billing'),
      '',
      'the feature the sentence pointed at was left alone',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply: a workspace with no features cannot take a change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-change-api-empty-'));
  try {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(r.status, 201);
    const { status, body } = await post('/api/change/apply', { root: dir, text: 'anything at all' });
    /* Not 201 with an empty result: "filed 0 changes" reads like success. */
    assert.equal(status, 409, 'it is refused, not quietly accepted');
    assert.ok(/no features/i.test(String(body['error'])), 'the refusal says why');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
