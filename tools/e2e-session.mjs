/* End-to-end over the real HTTP API, with a scripted agent.
 *
 * The real CLI cannot run in this sandbox, so the runner is injected. Everything
 * else is real: the server, the socket, the filesystem, the session store.
 *
 * Usage: node tools/e2e-session.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { serve } from '../dist/src/server/http.js';

const root = await mkdtemp(join(tmpdir(), 'gov-e2e-'));
let round = 0;

/** A scripted agent that writes the artifacts a real turn would. */
const runner = {
  async run(turn) {
    round++;
    const dir = join(turn.cwd, '.session');
    await mkdir(dir, { recursive: true });
    const isPrd = turn.prompt.includes('## Closing the session');
    if (isPrd) {
      await writeFile(join(turn.cwd, 'spec.md'), [
        '# Spec: camera watch', '',
        '## Problem Statement', 'Nothing watches the feed.', '',
        '## Solution', 'A single-host service that does.', '',
        '## User Stories', '1. As the only user, I want an alert, so that it matters.', '',
        '## Implementation Decisions', '- Target: people.', '',
        '## Testing Decisions', '- External behaviour only.', '',
        '## Test Seams', 'At the ingest boundary.', '',
        '## Out of Scope', '- Multi-camera.', '',
        '## Design', 'Analysis one hop away.', '',
      ].join('\n'), 'utf8');
      await writeFile(join(turn.cwd, 'GLOSSARY.md'), '# camera\n\n## Language\n\n**alert**:\none notification.\n', 'utf8');
      const prd = { round, kind: 'prd', questions: [], glossaryWritten: [], adrsWritten: [], frontierEmpty: true };
      await writeFile(join(dir, 'latest.json'), JSON.stringify(prd), 'utf8');
      await writeFile(join(dir, String(round).padStart(2,'0')+'.json'), JSON.stringify(prd), 'utf8');
    } else {
      const qs = round === 1
        ? [{ id:'q1', title:'What are you detecting', body:'the target drives the model', why:'nothing settled', recommended:'People', options:['People','Vehicles'] },
           { id:'q2', title:'Where does the video come from', body:'this decides ingest', why:'independent', recommended:'RTSP' }]
        : [];
      const art = { round, kind:'questions', questions: qs,
        glossaryWritten: round===1?['alert']:[], adrsWritten: [],
        frontierEmpty: qs.length === 0 };
      await writeFile(join(dir, 'latest.json'), JSON.stringify(art), 'utf8');
      await writeFile(join(dir, String(round).padStart(2,'0')+'.json'), JSON.stringify(art), 'utf8');
    }
    return { ok: true, sessionId: 'sess-e2e', output: 'asked a round', error: null, phase: null, ms: 3 };
  },
};

const port = await new Promise((d) => {
  const p = createServer(); p.listen(0, '127.0.0.1', () => { const a=p.address(); p.close(()=>d(a.port)); });
});
const base = `http://127.0.0.1:${port}`;
void serve({ roots: [root], port, runner, settingsPath: join(root, 'settings.json'),
  workspacesPath: join(root, 'workspaces.json') });
for (let i=0;i<60;i++){ try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { await new Promise(r=>setTimeout(r,50)); } }

const post = async (p, body) => {
  const r = await fetch(base+p, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const fail = [];
const say = (ok, msg) => { console.log((ok?'  ok   ':'  FAIL ')+msg); if(!ok) fail.push(msg); };

console.log('=== 1. the agent probe reports honestly ===');
{
  const r = await fetch(`${base}/api/session/agent`);
  const b = await r.json();
  say(r.status===200, 'GET /api/session/agent -> 200');
  say(typeof b.available === 'boolean', `available is a boolean (${b.available})`);
}

console.log('=== 2. start: the idea goes in, a round comes out ===');
let s;
{
  const r = await post('/api/session/start', {
    root, feature:'camera-watch',
    idea:'something that watches my camera feed and pings me when something looks off',
  });
  s = r.body;
  say(r.status===201, `POST /api/session/start -> 201 (got ${r.status})`);
  say(s.phase==='asking', `phase is asking (${s.phase})`);
  say(s.pending && s.pending.questions.length===2, `two questions came back (${s.pending?.questions?.length})`);
  say(s.pending?.questions?.[0]?.recommended==='People', 'the recommendation survived the round trip');
  say(s.answeredRounds===0, `nothing answered yet (${s.answeredRounds})`);
}

console.log('=== 3. answering continues the conversation ===');
{
  const r = await post('/api/session/answer', {
    root, feature:'camera-watch',
    answers:[{id:'q1',answer:'people'},{id:'q2',answer:'an RTSP camera'}],
  });
  s = r.body;
  say(r.status===200, `POST /api/session/answer -> 200 (got ${r.status})`);
  say(s.answeredRounds===1, `one round answered (${s.answeredRounds})`);
  say(s.phase==='ready-for-prd', `the empty frontier moved it on (${s.phase})`);
  say(s.history.length===2, `two rounds on the record (${s.history.length})`);
}

console.log('=== 4. the PRD is written, then verified on disk ===');
{
  const r = await post('/api/session/finalise', { root, feature:'camera-watch' });
  s = r.body;
  say(r.status===200, `POST /api/session/finalise -> 200 (got ${r.status})`);
  say(s.phase==='done', `phase is done (${s.phase})`);
  say(s.failure===null, 'no failure recorded');
  const spec = await readFile(join(root,'.scratch','camera-watch','spec.md'),'utf8');
  say(spec.includes('## User Stories'), 'spec.md has the sections the scanner reads');
  say(spec.includes('## Design'), 'and a Design section, so the stage is declared');
  const files = await readdir(join(root,'.scratch','camera-watch','.session'));
  say(files.includes('state.json'), '.session/state.json persists the session');
  say(files.filter(f=>/^\d\d\.json$/.test(f)).length===3, `three round artifacts (${files.filter(f=>/^\d\d\.json$/.test(f)).length})`);
}

console.log('=== 5. the feature the session wrote is visible to the scanner ===');
{
  const projects = await (await fetch(`${base}/api/projects`)).json();
  const e = projects[0].features.find(x=>x.slug==='camera-watch');
  say(!!e, 'the scanner found the feature');
  say(e?.stages.intake==='complete', 'intake complete');
  say(e?.stages.spec==='complete', 'spec complete — the PRD is real');
  say(e?.stages.design==='active', 'design active — nothing waived it on the human behalf');
}

console.log('=== 6. resume: reading the session back runs nothing ===');
{
  const r = await fetch(`${base}/api/session?root=${encodeURIComponent(root)}&feature=camera-watch`);
  const b = await r.json();
  say(r.status===200, 'GET /api/session -> 200');
  say(b.phase==='done', `resumed as done (${b.phase})`);
  say(b.answeredRounds===2, `answered rounds remembered (${b.answeredRounds})`);
  say(round===3, `no extra agent turns were spent (${round})`);
}

console.log('=== 7. the refusals ===');
{
  const a = await post('/api/session/start', { root, feature:'camera-watch', idea:'a duplicate idea here' });
  say(a.status===409, `a second start is refused with 409 (got ${a.status})`);
  const b = await post('/api/session/start', { root, feature:'../escape', idea:'a long enough idea' });
  say(b.status===400, `a traversing feature name is refused (got ${b.status})`);
  const c = await post('/api/session/start', { root:'/tmp/elsewhere', feature:'x', idea:'a long enough idea' });
  say(c.status===403, `a root that is not a workspace is refused (got ${c.status})`);
  const d = await post('/api/session/start', { root, feature:'tiny', idea:'short' });
  say(d.status===400, `an idea too short to grill is refused (got ${d.status})`);
  const e = await post('/api/session/answer', { root, feature:'camera-watch', answers:[{id:'qNINE',answer:'x'}] });
  say(e.status===409, `answering a finished session is refused (got ${e.status})`);
}

console.log('=== 8. a taken name can be cleared ===');
{
  // The dead end this opened: a session created with a name nobody wanted left
  // the name taken and the interface with nothing to offer but an error.
  const taken = await post('/api/session/start', {
    root, feature: 'taken', idea: 'an idea long enough to pass the gate',
  });
  say(taken.status === 201, `a fresh name starts (got ${taken.status})`);

  const again = await post('/api/session/start', {
    root, feature: 'taken', idea: 'an idea long enough to pass the gate',
  });
  say(again.status === 409, `the same name is refused (got ${again.status})`);

  // A preview must not delete, and must list what is really there.
  const preview = await post('/api/session/reset', { root, feature: 'taken' });
  say(preview.status === 200, `a preview is returned (got ${preview.status})`);
  say(preview.body.removed === false, 'confirm:false deleted nothing');
  say(
    Array.isArray(preview.body.files) && preview.body.files.length > 0,
    `the preview lists files (${preview.body.files?.length})`,
  );
  const stillThere = await fetch(
    `${base}/api/session?root=${encodeURIComponent(root)}&feature=taken`,
  );
  say(stillThere.status === 200, 'and the session is still readable');

  // With confirm it goes, and the name is free.
  const gone = await post('/api/session/reset', { root, feature: 'taken', confirm: true });
  say(gone.body.removed === true, 'confirm:true removed it');
  const after = await fetch(
    `${base}/api/session?root=${encodeURIComponent(root)}&feature=taken`,
  );
  say(after.status === 404, `the session is gone (got ${after.status})`);
  const reused = await post('/api/session/start', {
    root, feature: 'taken', idea: 'a different idea entirely, long enough',
  });
  say(reused.status === 201, `and the name can be used again (got ${reused.status})`);
}

console.log('=== 9. reset is bounded ===');
{
  const escape = await post('/api/session/reset', { root, feature: '../escape', confirm: true });
  say(escape.status === 400, `a traversing name is refused (got ${escape.status})`);
  const elsewhere = await post('/api/session/reset', { root: '/tmp/elsewhere', feature: 'x' });
  say(elsewhere.status === 403, `a root that is not a workspace is refused (got ${elsewhere.status})`);
  const missing = await post('/api/session/reset', { root, feature: 'never-existed', confirm: true });
  say(missing.status === 404, `a name that is not there is reported (got ${missing.status})`);
}

await rm(root, { recursive: true, force: true });
console.log('');
if (fail.length) { console.log(`${fail.length} FAILURE(S)`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);
