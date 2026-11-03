/* The demo flow, over the real API.
 *
 * Two jobs. First, a regression test for a bug this caught: the agent runner was
 * being constructed per request, so any state it held restarted on every call —
 * the demo agent's round counter among it, which meant every request produced
 * round 1 and the session never advanced. A runner is built once now, and this
 * asserts the round sequence actually moves.
 *
 * Second, it is the thing to reach for when the real agent will not run: if this
 * passes and a real session does not, the problem is the agent, not the flow.
 *
 * Usage: node tools/e2e-demo.mjs
 */
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { serve } from '../dist/src/server/http.js';

const root = await mkdtemp(join(tmpdir(), 'gov-demo-'));
await mkdir(root, { recursive: true });

const port = await new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const a = probe.address();
    probe.close(() => done(a.port));
  });
});
const base = `http://127.0.0.1:${port}`;

void serve({ roots: [root], port, demo: true, settingsPath: join(root, 'settings.json'),
  workspacesPath: join(root, 'workspaces.json') });
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const fail = [];
const say = (ok, msg) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg);
  if (!ok) fail.push(msg);
};

const IDEA = 'something that watches my camera feed and tells me when something looks off';
const at = (s) => `phase=${s.phase} answered=${s.answeredRounds} round=${s.pending?.round ?? '-'} q=${s.pending?.questions?.length ?? 0}`;

console.log('=== the rounds advance ===');
{
  const s1 = (await post('/api/session/start', { root, feature: 'demo-feature', idea: IDEA })).body;
  say(s1.pending?.round === 1, `round 1 came first — ${at(s1)}`);
  say(s1.pending?.questions?.length === 3, 'round 1 asked three questions');
  say(s1.answeredRounds === 0, 'nothing answered yet');

  const s2 = (
    await post('/api/session/answer', {
      root,
      feature: 'demo-feature',
      answers: [
        { id: 'q1', answer: 'One person, run locally' },
        { id: 'q2', answer: 'Do the core thing well' },
        { id: 'q3', answer: 'Nothing' },
      ],
    })
  ).body;
  // The regression: with a per-request runner this came back as round 1 again.
  say(s2.pending?.round === 2, `the next round is round 2, not round 1 again — ${at(s2)}`);
  say(s2.answeredRounds === 1, 'one round recorded as answered');
  say(s2.pending?.adrsWritten?.length === 1, 'the round reported the ADR it wrote');

  const s3 = (
    await post('/api/session/answer', {
      root,
      feature: 'demo-feature',
      answers: [
        { id: 'q1', answer: 'I stop doing it by hand' },
        { id: 'q2', answer: 'Core behaviour, on one machine' },
      ],
    })
  ).body;
  say(s3.phase === 'ready-for-prd', `the empty frontier moves it on — ${at(s3)}`);
  say(s3.pending?.questions?.length === 0, 'and there is nothing left to answer');

  const s4 = (await post('/api/session/finalise', { root, feature: 'demo-feature' })).body;
  say(s4.phase === 'done', `the PRD turn finished it — ${at(s4)}`);
  say(s4.failure === null, 'no failure recorded');
}

console.log('=== what it wrote ===');
{
  const dir = join(root, '.scratch', 'demo-feature');
  const rounds = (await readdir(join(dir, '.session'))).filter((f) => /^\d\d\.json$/.test(f));
  say(rounds.length === 4, `four round artifacts, one per turn (${rounds.length})`);

  const spec = await readFile(join(dir, 'spec.md'), 'utf8');
  say(spec.includes('## User Stories'), 'spec.md carries the sections the scanner reads');
  // The demo must be honest about itself, or a session it wrote is
  // indistinguishable from one an agent wrote.
  say(/demo agent/i.test(spec), 'the spec says it came from the demo agent');

  const glossary = await readFile(join(dir, 'GLOSSARY.md'), 'utf8');
  say(glossary.includes('frontier'), 'GLOSSARY.md was written');

  const adrs = await readdir(join(dir, 'docs', 'adr'));
  // Exactly one. The decision is recorded once, in the round that produced it;
  // writing it again at the PRD would collide numbers, and two ADRs sharing a
  // number is worse than none.
  say(adrs.length === 1, `exactly one ADR was written (${adrs.join(', ')})`);
  const numbers = adrs.map((f) => f.slice(0, 4));
  say(new Set(numbers).size === numbers.length, 'no two ADRs share a number');
}

console.log('=== the feature the demo wrote is visible to the scanner ===');
{
  const projects = await (await fetch(`${base}/api/projects`)).json();
  const e = projects[0].features.find((x) => x.slug === 'demo-feature');
  say(!!e, 'the scanner found it');
  say(e?.stages.intake === 'complete', 'intake complete');
  say(e?.stages.spec === 'complete', 'spec complete');
  say(e?.stages.design === 'active', 'design active — nothing waived it on the human behalf');
}

console.log('=== resuming runs nothing ===');
{
  const r = await fetch(`${base}/api/session?root=${encodeURIComponent(root)}&feature=demo-feature`);
  const s = await r.json();
  say(s.phase === 'done', `resumed as done (${s.phase})`);
  say(s.history.length === 4, `the whole conversation is on the record (${s.history.length})`);
}

await rm(root, { recursive: true, force: true });
console.log('');
if (fail.length) {
  console.log(`${fail.length} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
