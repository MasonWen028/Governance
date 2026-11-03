#!/usr/bin/env python3
"""Boot web/index.html headlessly and check it renders.

The page is a browser module, so nothing else in the suite exercises its
top-level code. A syntax check does not catch a typo in a property name or a
render that throws on real data, and those are exactly the failures that produce
a blank screen with nothing in the console.

This extracts the module, shims the DOM and `fetch`, runs it under node, and
asserts that boot() populated the view models and rendered something.

Usage:  python tools/check-web.py
Exit:   0 = the page boots and renders, 1 = it does not
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, 'web', 'index.html')

NODE_CANDIDATES = [
    r'C://Users//Administrator//.workbuddy//binaries//node//versions//22.22.2-6//node.exe',
    r'C://nvm4w//nodejs//node.exe',
]

# A project shaped like the server's output, so the adapter is exercised on
# something with a real chain in it.
FIXTURE = """
{
  root: '/tmp/railyard',
  name: 'railyard',
  git: { branch: 'methodology-view', head: 'dfaa026', dirty: true },
  warnings: [],
  features: [{
    slug: 'methodology-view',
    root: '/tmp/railyard/.scratch/methodology-view',
    kind: 'map',
    destination: 'A normative contract plus a working generator.',
    notes: ['Domain: Railyard governance.'],
    decisionsSoFar: [{ title: 'Registry shape', ref: 'issues/01-x.md', gist: 'declared plus discovered' }],
    notYetSpecified: ['something dim'],
    outOfScope: ['registering the contract'],
    tickets: [
      { id: '01', slug: 'one', title: 'The first', type: 'grilling', status: 'resolved',
        blockedByRaw: 'None (can start immediately)', blockedBy: [], warnings: [] },
      { id: '02', slug: 'two', title: 'The second', type: 'task', status: 'frontier',
        blockedByRaw: '01', blockedBy: ['01'], warnings: [] },
      { id: '03', slug: 'three', title: 'The third', type: 'task', status: 'blocked',
        blockedByRaw: '02', blockedBy: ['02'], warnings: [] }
    ],
    gates: [{ id: 'g1', title: 'Prove it', stage: 'develop',
              scope: { kind: 'stage', ref: 'develop' }, owner: 'po',
              methods: ['signoff'], blocking: true, onFail: 'rework', raisedBy: 'manual' }],
    /* The presentation facts the server now sends, in the shape readFeature
     * produces. Without these the dossier renders facts only, and the run row
     * path — the one that carries the tampered flag — is never exercised. */
    adrCount: 2,
    sessionRounds: 3,
    runs: [
      { jobId: 'r1', root: '/tmp/railyard', feature: 'methodology-view', stage: 'develop',
        skill: 'implement-spec', status: 'succeeded', startedAt: '2026-10-30T01:00:00Z',
        endedAt: '2026-10-30T01:00:09Z', exitCode: 0, error: null, ms: 9000, demo: false,
        audit: { gatesChanged: false, decisionsChanged: false, tampered: false, outsideWrites: null } },
      { jobId: 'r2', root: '/tmp/railyard', feature: 'methodology-view', stage: 'review',
        skill: 'code-review', status: 'failed', startedAt: '2026-10-30T02:00:00Z',
        endedAt: '2026-10-30T02:00:04Z', exitCode: 1, error: 'left the tree dirty', ms: 4000,
        demo: false,
        audit: { gatesChanged: false, decisionsChanged: true, tampered: true,
                 outsideWrites: ['src/leak.ts'] } }
    ],
    stages: { intake: 'complete', ask: 'complete', spec: 'complete', design: 'active',
              split: 'active', develop: 'active', review: 'active', ship: 'ready', retro: 'absent' },
    warnings: ['stage "split" has output but "design" was never satisfied (crossed)']
  }]
}
"""

SHIM = """
/* The inline styles the markup ships with, per id. A shim whose `style` always
 * starts empty cannot tell "hidden until asked for" from "visible by default",
 * and the difference is exactly what a reveal control is for: an assertion that
 * a row was hidden before the click passes vacuously, and so does one that says
 * the click opened it. The browser gives the element its declared style, so the
 * shim has to as well. */
const STYLE_ATTRS = {};
{
  const re = /<[a-zA-Z][^>]*>/g;
  let tag;
  while ((tag = re.exec(STATIC_MARKUP)) !== null) {
    const id = /\\bid="([^"]+)"/.exec(tag[0]);
    if (!id) continue;
    const st = /\\bstyle="([^"]*)"/.exec(tag[0]);
    if (!st) continue;
    const s = {};
    for (const decl of st[1].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      s[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
    STYLE_ATTRS[id[1]] = s;
  }
}
const cache = {};
function mkEl(id) {
  return {
    id: id || '', innerHTML: '', textContent: '', value: '', checked: false,
    disabled: false, offsetLeft: 0, offsetTop: 0,
    style: Object.assign({}, STYLE_ATTRS[id] || {}), dataset: {},
    placeholder: '', title: '',
    // A real class list. A stub that always reports "not present" makes every
    // "did the panel open" assertion pass vacuously.
    classList: (() => {
      const set = new Set();
      return {
        add(...c) { c.forEach((x) => set.add(x)); },
        remove(...c) { c.forEach((x) => set.delete(x)); },
        toggle(c, force) {
          const want = force === undefined ? !set.has(c) : force;
          if (want) set.add(c); else set.delete(c);
          return want;
        },
        contains(c) { return set.has(c); },
        _all() { return [...set]; }
      };
    })(),
    querySelectorAll: () => [], querySelector: () => null,
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    appendChild() {}, remove() {}, addEventListener() {}, closest: () => null,
    focus() {}, blur() {}
  };
}
globalThis.__cache = cache;
globalThis.document = {
  getElementById(id) { if (!cache[id]) cache[id] = mkEl(id); return cache[id]; },
  /* Keyed by selector, not fresh each call: a fake DOM that hands back a new
   * element every time hides the bug where a value is typed into one element
   * and read from another. */
  querySelectorAll: () => [],
  querySelector(sel) { if (!cache[sel]) cache[sel] = mkEl(sel); return cache[sel]; },
  createElement: () => mkEl(), addEventListener() {},
  documentElement: { lang: '', setAttribute() {}, getAttribute() { return ''; } },
  body: mkEl('body')
};
globalThis.window = globalThis;
// `navigator` is a getter-only global in Node 22, so it is redefined rather than
// assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-AU' }, configurable: true, writable: true
});
/* Window listeners are recorded rather than dropped, so a test can deliver one.
 * `hashchange` is how a link pasted into the address bar reaches the page without
 * a reload; a listener the shim silently discarded would make that path — and the
 * bug where the page showed one project while the URL named another — untestable. */
globalThis.__listeners = {};
globalThis.addEventListener = (type, fn) => { globalThis.__listeners[type] = fn; };
globalThis.location = { hash: '', href: 'http://127.0.0.1:4173/' };
globalThis.history = { replaceState() {} };
globalThis.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
/* Interval callbacks are recorded rather than dropped. A stub that returns 0 and
 * forgets the function makes "the interface keeps asking until the passes are
 * done" untestable — and that is the only thing standing between a long read
 * and a dialog that shows "pending" forever. */
globalThis.__intervals = [];
globalThis.setInterval = (fn, ms) => {
  globalThis.__intervals.push({ fn, ms });
  return globalThis.__intervals.length;
};
/* Recorded for the same reason: a watcher that is never dismissed keeps asking
 * the server about a job that finished, forever, on every project left open. */
globalThis.__cleared = [];
globalThis.clearInterval = (id) => {
  globalThis.__cleared.push(id);
};
const SETTINGS_FIXTURE = {
  general: { startup: 'portfolio', confirmDestructive: true, showCost: false, telemetry: false },
  agents: { cli: 'claude', model: 'inherit', maxParallel: 4, isolation: 'worktree',
    copyRoot: '../.worktrees', timeoutMin: 30, retries: 1, pauseOnGate: false, roleModels: {} },
  skills: [
    { id: 'grill-with-docs', stage: 'intake', enabled: true },
    { id: 'grilling', stage: 'ask', enabled: true },
    { id: 'to-spec', stage: 'spec', enabled: true },
    { id: 'codebase-design', stage: 'design', enabled: true },
    { id: 'to-tickets', stage: 'split', enabled: true },
    { id: 'implement-spec', stage: 'develop', enabled: true },
    { id: 'code-review', stage: 'review', enabled: true },
    { id: '', stage: 'ship', enabled: true },
    { id: 'retro', stage: 'retro', enabled: true }
  ],
  mcp: [], git: { branchTemplate: 'feat/{ticket}', integrationTemplate: 'integration/{project}',
    sign: true, draftPr: true, cleanup: true },
  automation: { afk: false, autoMerge: false, maxWaitHours: 24, dailySummary: false }
};
const CHAIN_FIXTURE = {
  skillsRoot: '/skills',
  chain: SETTINGS_FIXTURE.skills.map(s => ({
    stage: s.stage, skill: s.id || null, enabled: s.enabled,
    path: s.id ? '/skills/' + s.id + '/SKILL.md' : null,
    present: s.id ? true : null, mcp: []
  }))
};
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (v) => ({ ok: true, status: 200, json: async () => (v), headers: { get: () => null } });
  if (u.includes('/api/projects')) return ok([FIXTURE]);
  if (u.includes('/api/settings')) return ok({ settings: SETTINGS_FIXTURE, warnings: [], source: null, skillsRoot: '/skills' });
  if (u.includes('/api/chain')) return ok(CHAIN_FIXTURE);
  if (u.includes('/api/mcp')) return ok({ servers: [] });
  if (u.includes('/api/runs') && u.indexOf('root=') > 0)
    return ok({
      records: [
        { jobId: 'j1', root: FIXTURE.root, feature: 'methodology-view', stage: 'develop',
          skill: 'implement-spec', status: 'succeeded', startedAt: '2026-10-30T01:00:00Z',
          endedAt: '2026-10-30T01:00:09Z', exitCode: 0, error: null, ms: 9000, demo: false,
          audit: { gatesChanged: false, decisionsChanged: false, tampered: false, outsideWrites: null } },
        { jobId: 'j2', root: FIXTURE.root, feature: 'methodology-view', stage: 'review',
          skill: 'code-review', status: 'succeeded', startedAt: '2026-10-30T02:00:00Z',
          endedAt: '2026-10-30T02:00:04Z', exitCode: 0, error: null, ms: 4000, demo: false,
          audit: { gatesChanged: false, decisionsChanged: true, tampered: true, outsideWrites: ['src/leak.ts'] } }
      ],
      logs: [{ file: 'x-develop.log', stage: 'develop', bytes: 10 }],
      active: [],
      /* The journal's answer to "why is nothing happening?" — read back after a
       * restart, when the activity line that first said it is gone. */
      lastStop: {
        at: '2026-10-30T02:00:05Z', kind: 'chain.stopped', ref: 'review',
        detail: 'a blocking gate is open on ship',
        data: { jobId: 'j2', stage: 'review', gates: ['g-ship-signoff'] }
      }
    });
  if (u.includes('/api/session/agent')) return ok({ available: true, version: '2.0.9', detail: 'ok' });
  if (u.includes('/api/dossier')) return ok({
    idea: 'watch my camera and tell me when something looks off',
    ideaSource: 'session',
    destination: 'A page that says heja world.',
    notes: ['one note'],
    rounds: [
      { round: 1, kind: 'questions', at: '2026-10-31T01:00:00.000Z', answered: true,
        questions: [{ id: 'q1', title: 'What are you detecting', body: 'name the target',
          why: 'w', recommended: 'People', options: ['People', 'Vehicles'] }],
        answers: [{ id: 'q1', answer: 'People' }],
        glossaryWritten: ['frame'], adrsWritten: [], source: 'json', warnings: [] },
      { round: 2, kind: 'questions', at: '2026-10-31T01:05:00.000Z', answered: false,
        questions: [{ id: 'q1', title: 'Where does the video come from', body: 'ingest',
          why: 'w', recommended: 'RTSP', options: [] }],
        answers: null, glossaryWritten: [], adrsWritten: [], source: 'json', warnings: [] }
    ],
    answeredRounds: 1,
    featureDir: '/work/railyard/.scratch/methodology-view',
    workspaceRoot: '/work/railyard',
    conjectures: {
      decisions: [{ title: 'One document', ref: 'decision-1', gist: 'keep the record in one file' }],
      notYetSpecified: ['Which model writes the summary'],
      outOfScope: ['Multi-user auth']
    },
    glossary: { exists: true, at: '2026-10-31T01:00:00.000Z', path: 'GLOSSARY.md' },
    adrs: [{ file: 'docs/adr/0001-one-document.md', title: 'Keep it one document',
      at: '2026-10-31T01:10:00.000Z' }],
    spec: { exists: true, sections: ['Problem Statement', 'Solution'], path: 'spec.md' },
    tickets: [
      { id: '01', slug: 'first', title: 'The first', type: 'task', status: 'resolved',
        blockedBy: [], what: 'the first slice', at: '2026-10-31T01:20:00.000Z',
        file: 'issues/01-first.md' },
      { id: '02', slug: 'change-request', title: 'Change request — heja world', type: 'task',
        status: 'frontier', blockedBy: [], what: 'say heja world instead',
        at: '2026-10-31T02:00:00.000Z', file: 'issues/02-change-request.md' },
      { id: '03', slug: 'grilled', title: 'Which greeting is right', type: 'grilling',
        status: 'resolved', blockedBy: [], what: 'settle the greeting',
        at: '2026-10-31T01:30:00.000Z', file: 'issues/03-grilled.md' }
    ],
    runs: [
      { jobId: 'r1', root: '/tmp/railyard', feature: 'methodology-view', stage: 'develop',
        skill: 'implement-spec', status: 'succeeded', startedAt: '2026-10-31T00:00:00.000Z',
        endedAt: '2026-10-31T00:00:09.000Z', exitCode: 0, error: null, ms: 9000, demo: false,
        audit: { gatesChanged: false, decisionsChanged: false, tampered: false, outsideWrites: null } }
    ],
    gates: [
      { id: 'g1', title: 'Prove it', stage: 'develop', owner: 'po', blocking: true,
        raisedBy: 'manual',
        decisions: [{ ts: '2026-10-31T03:00:00.000Z', gate: 'g1', outcome: 'pass',
          actor: 'po', methods: ['signoff'], evidence: ['stage:develop'] }] }
    ],
    review: { exists: false, title: null, path: null },
    release: { exists: false, path: null },
    retro: { exists: false, path: null },
    logs: [{ file: '2026-10-31T00-00-00-000Z-develop.log', stage: 'develop', bytes: 1024 }],
    changes: [
      { id: 'CH-01', text: 'show heja world instead of hello world',
        openedAt: '2026-10-31T02:00:00.000Z', status: 'open',
        closedAt: null, note: null }
    ],
    journal: [
      { at: '2026-10-31T02:00:00.000Z', kind: 'change.opened', ref: 'CH-01',
        detail: 'show heja world instead of hello world' }
    ],
    timeline: [
      { at: '2026-10-31T00:00:00.000Z', kind: 'run-started', label: 'develop run', detail: 'skill implement-spec' },
      { at: '2026-10-31T00:00:09.000Z', kind: 'run-ended', label: 'develop run', detail: 'succeeded · 9000 ms' },
      { at: '2026-10-31T01:00:00.000Z', kind: 'round', label: 'round 1', detail: '1 question(s) asked, answered' },
      { at: '2026-10-31T03:00:00.000Z', kind: 'decision', label: 'gate g1', detail: 'pass by po' }
    ],
    warnings: []
  });
  if (u.includes('/api/change-request') && opts && opts.method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    return ok({ change: { id: 'CH-02', text: body.text, openedAt: '2026-10-31T04:00:00.000Z' } });
  }
  if (u.includes('/api/change-close') && opts && opts.method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    return ok({ change: { id: body.id, status: 'closed',
      closedAt: '2026-10-31T05:00:00.000Z', note: body.note } });
  }
  if (u.includes('/api/file?')) {
    return ok({ path: 'spec.md', name: 'spec.md', size: 48, at: '2026-10-31T01:30:00.000Z',
      lang: 'markdown', tooLarge: false, binary: false,
      text: '# Spec\\n\\n## Problem Statement\\n\\nThe greeting is wrong.\\n' });
  }
  if (u.includes('/api/reveal') && opts && opts.method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    return ok({ ok: true, mode: body.mode, launcher: 'explorer.exe',
      target: '/work/railyard/.scratch/methodology-view' });
  }
  return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
};
globalThis.__i18n = null;
globalThis.__report = () => ({
  projects: typeof PROJECTS === 'undefined' ? null : Object.keys(PROJECTS).length,
  loaded: typeof LOADED === 'undefined' ? null : LOADED,
  error: typeof LOAD_ERROR === 'undefined' ? 'undefined-binding' : LOAD_ERROR,
  main: (globalThis.__cache['main'] || {}).innerHTML || '',
  root: (globalThis.__cache['crumbs'] || {}).innerHTML || '',
  sidebar: (globalThis.__cache['sidebar'] || {}).innerHTML || '',
  statusbar: (globalThis.__cache['statusbar'] || {}).innerHTML || '',
  scope: typeof STATE === 'undefined' ? 'no-STATE' : STATE.scope,
  project: typeof STATE === 'undefined' ? '-' : STATE.project,
  pview: typeof STATE === 'undefined' ? '-' : STATE.pview,
  view: typeof STATE === 'undefined' ? '-' : STATE.view
});
"""

ASSERTIONS = r"""
// The module kicks off boot() without awaiting it, so give it a turn to settle.
await new Promise((r) => setTimeout(r, 150));

// Snapshot the boot state FIRST. The interaction checks below deliberately mutate
// STATE (openWizard, wzCreate), so asserting on the landing state after them would
// be asserting on a state the app was never in at load.
const rep = globalThis.__report();
const problems = [];
if (rep.projects === null) problems.push('PROJECTS binding missing');
else if (rep.projects !== 1) problems.push('expected 1 project, got ' + rep.projects);
if (rep.loaded !== true) problems.push('LOADED is ' + rep.loaded);
if (rep.error) problems.push('LOAD_ERROR: ' + rep.error);
if (rep.scope !== 'portfolio')
  problems.push('the app did not land on the portfolio, it landed on ' + rep.scope);
if (!rep.main || rep.main.length < 200)
  problems.push('main did not render: ' + (rep.main || '').length + ' chars');
if (rep.main && rep.main.indexOf('railyard') < 0)
  problems.push('the project name is not in the landing view');
if (!rep.sidebar || rep.sidebar.length < 100) problems.push('sidebar did not render');
if (!rep.statusbar) problems.push('statusbar did not render');
if (rep.main && /\\bundefined\\b/.test(rep.main))
  problems.push('the word "undefined" reached the markup');
// A raw i18n key in the markup means a t() call was missed. The stage rail is the
// usual suspect, because its ids changed vocabulary from s1..s9 to intake..retro.
if (rep.main && /\\b(?:stage|seg|pf|tl|act|ins|pipe|board|inbox|rel|rec|set|wiz|dos|ticket|dec)\\.[a-zA-Z]+/.test(rep.main))
  problems.push('a raw i18n key reached the markup: ' +
    (rep.main.match(/\\b(?:stage|seg|pf|tl|act|ins|pipe|board|inbox|rel|rec|set|wiz)\\.[a-zA-Z]+/) || [''])[0]);

if (problems.length) {
  console.error('FAIL');
  for (const p of problems) console.error('  - ' + p);
  console.error('--- render state ---');
  console.error('LOADED=' + rep.loaded + ' LOAD_ERROR=' + rep.error +
    ' projects=' + rep.projects);
  console.error('scope=' + rep.scope + ' project=' + rep.project +
    ' pview=' + rep.pview + ' view=' + rep.view);
  console.error('main(' + (rep.main || '').length + '): ' + (rep.main || '').slice(0, 400));
  process.exit(1);
}

/* ---- the two paths the user reported as dead ---- */
const extra = [];
try {
  openFlow();
  if (!document.getElementById('wizard').classList.contains('on'))
    extra.push('openFlow did not open the flow');
  const rail = (globalThis.__cache['wzRail'] || {}).innerHTML || '';
  if (rail.length < 50) extra.push('the flow rail did not render');
  const wmain = (globalThis.__cache['wzMain'] || {}).innerHTML || '';
  // Step one must be the idea screen with its input, or there is nothing to type into.
  if (wmain.indexOf('flowIdea') < 0) extra.push('step 1 is not the idea screen');
  if (wmain.indexOf('flowRoot') < 0) extra.push('step 1 has no repository picker');
  if (wmain.indexOf('flowName') < 0) extra.push('step 1 has no feature name');
  // The idea field must start EMPTY. It used to be prefilled with a hardcoded
  // sample sentence, which read as "the app has decided what I am building";
  // the example belongs in the placeholder, the field in the human's hands.
  // (The placeholder itself quotes the sample, so the discriminator is the
  // textarea's CONTENT, not the surrounding markup.)
  const taMatch = /<textarea[^>]*id="flowIdea"[^>]*>([^<]*)</.exec(wmain);
  if (taMatch === null) extra.push('the idea textarea did not render');
  else if (taMatch[1].trim().length > 0)
    extra.push('the idea field is prefilled with: ' + taMatch[1].trim().slice(0, 60));
  if (wmain.indexOf(I18N.t('wiz.seed.ph')) < 0)
    extra.push('the idea field lost its placeholder example');
  // An empty idea must hold the flow at step one even with a repository chosen.
  FLOWSTATE.root = FIXTURE.root;
  FLOWSTATE.idea = '';
  FLOWSTATE.ideaTouched = false;
  FLOWSTATE.name = '';
  FLOWSTATE.nameTouched = false;
  if (FLOW.canAdvance(FLOWSTATE))
    extra.push('an empty idea advanced the flow');
  // And the flow must be three steps, not the five the prototype had.
  if (FLOW.FLOW_STEPS.length !== 3)
    extra.push('expected 3 flow steps, got ' + FLOW.FLOW_STEPS.length);
  closeWizard();
} catch (e) { extra.push('openFlow threw: ' + e.message + '\n    ' +
    (e.stack||'').split('\n').slice(1,4).join('\n    ')); }

/* The rounds screen, driven from a real round shape. */
try {
  FLOWSTATE.open = true;
  FLOWSTATE.step = 1;
  FLOWSTATE.root = FIXTURE.root;
  FLOWSTATE.name = 'camera-watch';
  FLOWSTATE.phase = 'asking';
  FLOWSTATE.answeredRounds = 0;
  FLOWSTATE.pending = {
    round: 1, kind: 'questions', source: 'json', warnings: [], frontierEmpty: false,
    glossaryWritten: ['frame'], adrsWritten: ['0001-one-hop.md'],
    questions: [
      { id: 'q1', title: 'What are you detecting', body: 'name the target',
        why: 'nothing settled yet', recommended: 'People', options: ['People', 'Vehicles'] },
      { id: 'q2', title: 'Where does the video come from', body: 'ingest path',
        why: 'independent', recommended: 'RTSP', options: [] }
    ]
  };
  FLOWSTATE.answers = FLOW.seedAnswers(FLOWSTATE);
  if (FLOWSTATE.answers.q1 !== 'People') extra.push('recommendations were not seeded');
  renderWizard();
  const rounds = (globalThis.__cache['wzMain'] || {}).innerHTML || '';
  if (rounds.indexOf('What are you detecting') < 0) extra.push('round 1 did not render its question');
  if (rounds.indexOf('glossaryWritten') >= 0) extra.push('raw field leaked into the markup');
  // The round must be answerable, and complete once seeded.
  if (!FLOW.roundComplete(FLOWSTATE, FLOWSTATE.answers))
    extra.push('a seeded round must count as complete');
  // Answering is refused while a question is blank.
  FLOWSTATE.answers.q2 = '';
  if (FLOW.roundComplete(FLOWSTATE, FLOWSTATE.answers))
    extra.push('a blank answer counted as complete');
  // An empty frontier moves the flow on without a PRD button being pressed.
  FLOWSTATE.pending.frontierEmpty = true;
  FLOWSTATE.pending.questions = [];
  FLOWSTATE.phase = 'ready-for-prd';
  if (!FLOW.canAdvance(FLOWSTATE)) extra.push('an empty frontier must let the flow advance');
  renderWizard();
  closeWizard();
} catch (e) { extra.push('the rounds screen threw: ' + e.message + '\n    ' +
    (e.stack||'').split('\n').slice(1,4).join('\n    ')); }

try {
  openSettings();
  if (!document.getElementById('settings').classList.contains('on'))
    extra.push('openSettings did not open the window');
  openSettings('skills');
  const skills = (globalThis.__cache['setMain'] || {}).innerHTML || '';
  // Built from GET /api/chain, not from the prototype's local fixtures.
  if (skills.indexOf('implement-spec') < 0)
    extra.push('the skill chain did not come from the server');
  if (skills.indexOf('/skills/implement-spec/SKILL.md') < 0)
    extra.push('the chain table does not show where each skill lives');
  openSettings('mcp');
  const mcp = (globalThis.__cache['setMain'] || {}).innerHTML || '';
  if (mcp.length < 100) extra.push('the MCP panel did not render');
  openSettings('agents');
  const agents = (globalThis.__cache['setMain'] || {}).innerHTML || '';
  if (agents.indexOf('claude') < 0) extra.push('the agent runtime is not shown');
  closeSettings();
} catch (e) { extra.push('openSettings threw: ' + e.message); }

try {
  // Starting the flow must reach POST /api/session/start with the idea verbatim.
  // Driven with a recording fetch, so this is about the wiring; the server's own
  // tests cover the session itself.
  const calls = [];
  const rescans = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/projects')) rescans.push(u);
    if (u.includes('/api/session/start')) {
      const body = JSON.parse((opts || {}).body || '{}');
      calls.push(body);
      return { ok: true, status: 201, json: async () => ({
        feature: body.feature, featureDir: '/x/.scratch/' + body.feature, repoRoot: body.root,
        idea: body.idea, conversationId: 'sess-1', answeredRounds: 0,
        pending: { round: 1, kind: 'questions', source: 'json', warnings: [],
          frontierEmpty: false, glossaryWritten: [], adrsWritten: [],
          questions: [{ id: 'q1', title: 'T', body: '', why: '', recommended: 'R', options: [] }] },
        phase: 'asking', failure: null, source: 'json', warnings: [], updated: '', history: [] }) };
    }
    return realFetch(url, opts);
  };
  FLOWSTATE.open = true;
  FLOWSTATE.step = 0;
  FLOWSTATE.idea = 'a thing that watches my camera and tells me when something looks off';
  FLOWSTATE.ideaTouched = true;
  FLOWSTATE.name = 'camera-watch';
  FLOWSTATE.root = FIXTURE.root;
  await flowStart();
  globalThis.fetch = realFetch;
  if (calls.length !== 1) extra.push('flowStart did not POST once to /api/session/start');
  else {
    if (calls[0].feature !== 'camera-watch') extra.push('wrong feature slug: ' + calls[0].feature);
    if (calls[0].root !== FIXTURE.root) extra.push('wrong root: ' + calls[0].root);
    if (!calls[0].idea.includes('watches my camera')) extra.push('the idea was not sent verbatim');
  }
  // And the flow moved to the rounds step, with the round absorbed.
  if (FLOWSTATE.step !== 1) extra.push('the flow did not move to the rounds step');
  if (FLOWSTATE.pending === null) extra.push('the round was not absorbed');
  if (FLOWSTATE.phase !== 'asking') extra.push('phase not taken from the server: ' + FLOWSTATE.phase);
  /* The feature exists on disk the moment the session starts. A board that is
   * not re-scanned until the human clicks "Open project" reads as "I added it
   * and it is not there" — the exact report this fixes. */
  if (rescans.length === 0) extra.push('flowStart never re-scanned /api/projects');
} catch (e) { extra.push('flowStart threw: ' + e.message + '\n    ' +
    (e.stack||'').split('\n').slice(1,4).join('\n    ')); }

if (extra.length) {
  console.error('FAIL (interaction)');
  for (const p of extra) console.error('  - ' + p);
  process.exit(1);
}


/* ---- the inline-handler surface ----
 *
 * The page is a module, and module scope is not global. Every `on*` attribute in
 * the rendered markup therefore needs its function deliberately published on
 * globalThis. When it is not, the button does nothing at all and no exception
 * reaches the console the human is looking at — which is exactly how "clicking
 * New project has no reaction" happened, twice over: the handler was missing, and
 * nothing tested that a click would work.
 *
 * This walks the actual rendered markup, collects every function an inline
 * handler names, and asserts each one is callable.
 */
{
  const handlers = [];
  const collect = (html, source) => {
    const attr = /on\w+="([^"]*)"/g;
    let m;
    while ((m = attr.exec(html)) !== null) {
      const call = /([A-Za-z_$][\w$]*)\s*\(/g;
      let c;
      while ((c = call.exec(m[1])) !== null) handlers.push({ fn: c[1], source });
    }
  };
  // Every region that renders interactive markup, not just the current view.
  ['main', 'sidebar', 'inspector', 'crumbs', 'statusbar'].forEach((id) => {
    collect((globalThis.__cache[id] || {}).innerHTML || '', id);
  });
  // The page's own static markup. The modal's buttons live here and never pass
  // through a render cache, so scanning only the cache would leave them unchecked.
  collect(STATIC_MARKUP, 'static');
  // And the template strings that build views the current state does not show.
  openFlow();
  collect((globalThis.__cache['wzMain'] || {}).innerHTML || '', 'flow');
  closeWizard();
  openSettings();
  ['general', 'agents', 'skills', 'mcp', 'credentials', 'git', 'automation'].forEach((c) => {
    openSettings(c);
    collect((globalThis.__cache['setMain'] || {}).innerHTML || '', 'settings:' + c);
  });
  closeSettings();
  renderAll();
  ['overview', 'timeline', 'activity'].forEach((v) => {
    STATE.scope = 'portfolio';
    STATE.pview = v;
    renderAll();
    collect((globalThis.__cache['main'] || {}).innerHTML || '', 'portfolio:' + v);
  });
  STATE.scope = 'project';
  STATE.project = Object.keys(PROJECTS)[0] || '';
  ['pipeline', 'board', 'inbox', 'releases', 'records'].forEach((v) => {
    STATE.view = v;
    renderAll();
    collect((globalThis.__cache['main'] || {}).innerHTML || '', 'view:' + v);
  });

  const unique = [...new Set(handlers.map((h) => h.fn))];
  const missing = unique.filter((fn) => typeof globalThis[fn] !== 'function');
  if (unique.length === 0) {
    console.error('FAIL: found no inline handlers at all, so this check proved nothing');
    process.exit(1);
  }
  if (missing.length) {
    console.error('FAIL (inline handlers)');
    console.error('  these are named in onclick/on* attributes but are not callable:');
    for (const fn of missing) {
      const where = handlers.filter((h) => h.fn === fn).map((h) => h.source);
      console.error('    ' + fn + '  (named in: ' + [...new Set(where)].join(', ') + ')');
    }
    console.error('  A module\'s top-level functions are not globals; publish them.');
    process.exit(1);
  }
  console.log('  ok   ' + unique.length + ' inline handler(s) callable: ' + unique.join(', '));
}


/* ---- recovering from a taken name ----
 *
 * The dead end this opens: the server refuses to reuse a name, which is a guard,
 * but on its own it leaves the human with nothing to do — the name they have is
 * taken and no button changes it. The offer has to include the file list before
 * anything is deleted, which is why the preview is a separate call.
 */
{
  const problems = [];

  // Nothing when there is no problem.
  FLOWSTATE.open = true;
  FLOWSTATE.step = 0;
  FLOWSTATE.root = FIXTURE.root;
  FLOWSTATE.agent = { available: true, reason: 'demo', demoAvailable: true };
  FLOWSTATE.idea = 'an idea long enough to pass the gate';
  FLOWSTATE.ideaTouched = true;
  FLOWSTATE.stuck = null;
  renderWizard();
  if (((globalThis.__cache['wzMain'] || {}).innerHTML || '').indexOf('wzResetStart') >= 0) {
    problems.push('a recovery button was offered when nothing was stuck');
  }

  // The offer, before any preview.
  FLOWSTATE.stuck = { root: FIXTURE.root, feature: 'camera-watch', message: 'already exists', preview: null };
  renderWizard();
  const offered = (globalThis.__cache['wzMain'] || {}).innerHTML || '';
  if (offered.indexOf(I18N.t('flow.stuck.title')) < 0) problems.push('the taken name is not explained');
  if (offered.indexOf('wzResetStart') < 0) problems.push('no way to start over is offered');
  // The path must be spelled out, or the human cannot tell what is at stake.
  if (offered.indexOf(FIXTURE.root) < 0) problems.push('the feature path is not shown');

  // And the confirmation, listing what the server said would go.
  FLOWSTATE.stuck.preview = { featureDir: '/x', removed: false,
    files: ['spec.md', 'GLOSSARY.md', '.session/state.json'] };
  renderWizard();
  const confirming = (globalThis.__cache['wzMain'] || {}).innerHTML || '';
  if (confirming.indexOf('wzResetGo') < 0) problems.push('no confirm button');
  if (confirming.indexOf('wzResetCancel') < 0) problems.push('no cancel button');
  // Every file from the preview must be visible. Deleting without showing is the
  // thing this whole two-step flow exists to avoid.
  for (const f of ['spec.md', 'GLOSSARY.md', '.session/state.json']) {
    if (confirming.indexOf(f) < 0) problems.push('the preview does not list ' + f);
  }
  // And the count must be stated, not left to be counted by eye.
  if (confirming.indexOf('3') < 0) problems.push('the number of files is not stated');

  FLOWSTATE.stuck = null;
  closeWizard();
  if (problems.length) {
    console.error('FAIL (recovery)');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   a taken name offers a recovery, with the file list first');
}

/* ---- the agent notice says which thing is wrong ----
 *
 * The bug this locks down: one "the agent CLI cannot run on this machine" was
 * shown for every failure, including one where the CLI ran perfectly and only
 * lacked a credential. Advice built on the wrong diagnosis sends someone to fix
 * something that is not broken.
 */
{
  const cases = [
    { reason: 'not-authenticated', mustNotSay: /cannot run|not allowed to run/i },
    { reason: 'blocked', mustNotSay: /log in|not logged in/i },
    { reason: 'not-installed', mustNotSay: /not logged in|credential/i },
  ];
  const problems = [];
  for (const c of cases) {
    FLOWSTATE.open = true;
    FLOWSTATE.step = 0;
    FLOWSTATE.root = FIXTURE.root;
    FLOWSTATE.agent = { available: false, reason: c.reason, version: '2.0.9',
      command: '/x', how: 'followed claude.cmd', detail: 'API Error: 401', demoAvailable: false };
    FLOWSTATE.idea = 'an idea long enough to pass the gate';
    FLOWSTATE.ideaTouched = true;
    renderWizard();
    const html = (globalThis.__cache['wzMain'] || {}).innerHTML || '';
    if (html.indexOf('agent.why.') >= 0) {
      problems.push(c.reason + ': a raw i18n key reached the markup');
    }
    // The headline for this reason must actually appear, resolved.
    const want = (I18N.DICT[I18N.getLocale()] || {})['agent.why.' + c.reason];
    if (want && html.indexOf(want) < 0) {
      problems.push(c.reason + ': the specific headline is missing');
    }
    if (c.mustNotSay.test(html)) {
      problems.push(c.reason + ': the notice says something untrue for this reason');
    }
  }
  // And the demo path must be offered when it exists — the difference between
  // "you cannot try this" and "you cannot try it this way yet".
  FLOWSTATE.agent = { available: false, reason: 'not-authenticated', version: '2.0.9',
    command: '/x', how: 'x', detail: 'API Error: 401', demoAvailable: true };
  renderWizard();
  const withDemo = (globalThis.__cache['wzMain'] || {}).innerHTML || '';
  if (withDemo.indexOf(I18N.t('agent.demoAvailable')) < 0) {
    problems.push('the demo path was not offered although it is available');
  }
  closeWizard();
  if (problems.length) {
    console.error('FAIL (agent notice)');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   the agent notice names the right failure: ' + cases.map(c => c.reason).join(', '));
}

/* ---- advance actually asks the server ----
 *
 * The button this replaced was a toast. This asserts the three things that make
 * it real: it POSTs the *selected* feature (not the first one in the project), it
 * watches the job it was given, and it reports the outcome — audit included.
 * The network is stubbed here on purpose: this is the wiring check, and the
 * server's own behaviour is covered by runs-api.test.ts and policy.test.ts.
 */
{
  const realFetch = globalThis.fetch;
  let posted = null;
  let polls = 0;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const resp = (v) => ({ ok: true, status: 200, json: async () => v, headers: { get: () => null } });
    if (u.slice(-9) === '/api/runs' && opts && opts.method === 'POST') {
      posted = JSON.parse(opts.body);
      return resp({ jobId: 'jx', status: 'running', demo: false, plan: { stage: 'develop' } });
    }
    if (u.indexOf('/api/runs/jx') >= 0) {
      polls += 1;
      return resp({
        jobId: 'jx', stage: 'develop', skill: 'implement-spec', status: 'succeeded',
        exitCode: 0, ms: 1200, demo: false,
        audit: { gatesChanged: false, decisionsChanged: false, tampered: false, outsideWrites: null }
      });
    }
    return realFetch(url, opts);
  };
  const bad = [];
  try {
    // Through the dispatcher, not the function: the menu item and the toolbar
    // button both arrive via runAction, so that is the path worth asserting.
    runAction('advance');
    for (let i = 0; i < 60 && !posted; i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 150));  // let the watch + boot settle
  } catch (e) {
    bad.push('advance threw: ' + e.message);
  }
  globalThis.fetch = realFetch;
  if (!posted) bad.push('advance sent no request at all');
  if (posted && posted.root !== '/tmp/railyard')
    bad.push('advance used root ' + posted.root + ' instead of the selected project');
  if (posted && posted.feature !== 'methodology-view')
    bad.push('advance used feature ' + posted.feature + ' instead of the one on screen');
  if (polls < 1) bad.push('advance never read the job it was given');
  const said = (globalThis.__cache['toast'] || {}).textContent || '';
  const want = I18N.t('run.done.succeeded',
    { stage: I18N.pick({ en: 'Build (AFK)', zh: '\u5efa\u9020\uff08AFK\uff09' }), ms: 1200 });
  if (said.indexOf(want) < 0) bad.push('the outcome was not announced; toast said: ' + said);
  if (bad.length) {
    console.error('FAIL (advance)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   advance posts the selected feature, watches the job, and says how it ended');
}

/* ---- a refusal is a to-do list ----
 *
 * A 409 from a run carries the gates that caused it. The page must open the
 * first one in the inspector, not print "no" and leave the operator to guess.
 */
{
  const realFetch = globalThis.fetch;
  const gate = { id: 'g1', title: 'Prove it', owner: 'po', stage: 'develop' };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.slice(-9) === '/api/runs' && opts && opts.method === 'POST') {
      return {
        ok: false, status: 409, headers: { get: () => null },
        json: async () => ({
          error: 'cannot run develop: 1 blocking gate(s) at or behind it are still open (g1)',
          gates: [gate]
        })
      };
    }
    return realFetch(url, opts);
  };
  const bad = [];
  try {
    runAction('scope:railyard');
    runAction('advance');
    for (let i = 0; i < 60 && STATE.gate !== 'railyard/g1'; i++) await new Promise(r => setTimeout(r, 20));
    if (STATE.gate !== 'railyard/g1')
      bad.push('the refusal did not open the gate it named (STATE.gate=' + STATE.gate + ')');
    const said = (globalThis.__cache['toast'] || {}).textContent || '';
    // The same sentence the operator sees, built from the same key, so the check
    // fails when the wording or the interpolation breaks rather than when it
    // merely changes.
    const want = I18N.t('run.gateBlocked', {
      stage: I18N.pick({ en: 'Design', zh: '\u67b6\u6784\u8bbe\u8ba1' }), n: 1
    });
    if (said.indexOf(want) < 0) bad.push('the refusal was not explained; toast said: ' + said);
  } catch (e) {
    bad.push('the refusal path threw: ' + e.message);
  }
  globalThis.fetch = realFetch;
  if (bad.length) {
    console.error('FAIL (gate refusal)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   a 409 with gates opens the gate instead of printing "no"');
}

/* ---- the feature switcher ----
 *
 * Before P6 the feature selection had exactly one write point (the wizard), so a
 * project's second feature was unreachable in the UI. The select must offer every
 * feature, mark the one on screen, and switching must re-anchor the whole page —
 * hash, view model, and the runs card's target — not just redraw a label.
 */
{
  const bad = [];
  const q = PROJECTS['railyard'];
  const prevFeatures = q.features;
  try {
    q.features = [{ slug: 'methodology-view' }, { slug: 'second-feature' }];
    STATE.scope = 'project'; STATE.project = 'railyard'; STATE.view = 'pipeline';
    renderMain();
    const html = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (html.indexOf('data-effsel') < 0)
      bad.push('no feature select rendered for a two-feature project');
    /* Styled like every other select on the page. A bare <select> renders as
     * the OS control, which is what looked bolted onto the pipeline header. */
    if (html.indexOf('<select class="psel" data-effsel') < 0)
      bad.push('the feature select did not use the styled select');
    if (html.indexOf('<option value="second-feature"') < 0)
      bad.push('the second feature is not offered in the select');
    if (html.indexOf('<option value="methodology-view" selected') < 0)
      bad.push('the select does not mark the feature currently on screen');
    if (html.indexOf(I18N.t('pipe.feature')) < 0)
      bad.push('the select carries no label');

    // The single-feature case shows the name, but offers no choice to fake.
    q.features = [{ slug: 'methodology-view' }];
    renderMain();
    const single = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (single.indexOf('data-effsel') >= 0)
      bad.push('a select was rendered although the project has one feature');
    if (single.indexOf('methodology-view') < 0)
      bad.push('the single feature is not named on the pipeline header');

    // The switch itself: what the change handler does, minus the DOM event the
    // shim cannot deliver. The write side (hash + selection map), then the read
    // side — the adapter must honour a selection when the feature exists, and
    // carry the list the select is built from. (The stub fixture has one feature,
    // so boot() would correctly fall back to it; the adapter is what decides.)
    q.features = prevFeatures;

    /* A link saved or shared before the rename carries `#effort=`. Honouring
     * only the new spelling would turn every old bookmark into "no feature
     * selected", which reads as an empty project rather than a moved word.
     *
     * Split into project and feature, too. The old assertion here checked
     * `.selected === 'railyard/second-feature'` — the joined string — and it
     * passed for months while the page ignored the hash entirely, because the
     * selection map is keyed by project name and nothing ever split it. A test
     * that agrees with the defect is worse than no test: it is the thing that
     * made the bug look handled. */
    location.hash = '#effort=railyard/second-feature';
    {
      const s = readSelectionFromHash();
      if (s === null || s.project !== 'railyard' || s.feature !== 'second-feature')
        bad.push('a hash written before the rename is not split into project and feature');
    }
    location.hash = '#feature=railyard/second-feature';
    {
      const s = readSelectionFromHash();
      if (s === null || s.project !== 'railyard' || s.feature !== 'second-feature')
        bad.push('the new hash spelling is not split into project and feature');
    }

    /* The page has to actually go there. Reading the hash and storing it under
     * the wrong key is how `#effort=gov-real-mode/html-hello-world-ch-02` opened
     * on a different project while the address bar said otherwise. */
    location.hash = '#feature=railyard/second-feature';
    /* Cleared to something else on purpose. A link's job is to move the page,
     * and an assertion that starts from the value it expects proves nothing —
     * it passed while the view was never set at all. */
    STATE.scope = 'portfolio'; STATE.project = ''; STATE.view = 'overview';
    {
      const problem = applyHashSelection([{
        root: '/tmp/railyard', name: 'railyard', warnings: [],
        features: [{ slug: 'methodology-view' }, { slug: 'second-feature' }],
      }]);
      if (problem !== null) bad.push('a link to a feature that exists was reported as a problem');
      if (STATE.scope !== 'project') bad.push('the hash did not move the page to the project');
      if (STATE.project !== 'railyard') bad.push('the hash selected the wrong project: ' + STATE.project);
      if (selectionMap()['railyard'] !== 'second-feature')
        bad.push('the hash did not select the feature it named');
      if (STATE.view !== 'pipeline') bad.push('a feature link did not open the pipeline');
    }

    /* A link to something that is not here says so. Opening somewhere else in
     * silence leaves a person holding a bookmark they cannot diagnose. */
    if (applyHashSelection([{ root: '/tmp/x', name: 'other', features: [] }]) === null)
      bad.push('a link to a project that is not open was accepted silently');
    if (applyHashSelection([{
      root: '/tmp/railyard', name: 'railyard', features: [{ slug: 'methodology-view' }],
    }]) === null)
      bad.push('a link to a feature the project does not have was accepted silently');

    /* A link pasted into the address bar changes the hash without reloading.
     * With no listener the page keeps showing the old project while the URL
     * names a new one — the same lie as ignoring the hash, from the other end. */
    if (typeof globalThis.__listeners['hashchange'] !== 'function')
      bad.push('no hashchange listener: a pasted link never reaches the page');
    location.hash = '';

    setSelection('railyard', 'second-feature');
    if (String(location.hash).indexOf('second-feature') < 0)
      bad.push('after switching, the URL hash was not updated');
    if (selectionMap()['railyard'] !== 'second-feature')
      bad.push('the selection map did not record the switch');
    const twoFeatures = {
      root: '/tmp/railyard', name: 'railyard', git: null, warnings: [],
      features: [
        { slug: 'methodology-view', tickets: [], gates: [], warnings: [],
          stages: { intake: 'active' } },
        { slug: 'second-feature', tickets: [], gates: [], warnings: [],
          stages: { intake: 'active' } }
      ]
    };
    const vm = API.toProjectVM(twoFeatures, 'second-feature', CHAIN.chain);
    if (vm.featureSlug !== 'second-feature')
      bad.push('the adapter ignored the selection: ' + vm.featureSlug);
    if (!vm.features || vm.features.length !== 2)
      bad.push('the view model does not carry the feature list for the select');
    setSelection('railyard', 'methodology-view');
    await boot(true);
    /* Put the URL back to nothing. boot() now honours the hash, so leaving a
     * selection in it would make every later block's boot() reopen railyard —
     * and a block that switches project by hand would be silently overridden by
     * the address bar. */
    setSelection(null, null);
  } catch (e) {
    bad.push('the switcher check threw: ' + e.message);
  } finally {
    q.features = prevFeatures;
  }
  if (bad.length) {
    console.error('FAIL (feature switcher)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   the feature switcher offers every feature and re-anchors the page');
}

/* ---- the stage dossier ----
 *
 * The panel used to say "This stage has not run yet" for every one of the nine
 * stages, including the seven that had. A dossier that is always empty is worse
 * than no panel: it teaches the operator to stop looking. These assertions are
 * about the three things the panel must now do — name what the stage produced,
 * say how it ran, and keep the honest empty state only where it is true.
 */
{
  const bad = [];
  const q = PROJECTS['railyard'];
  try {
    STATE.scope = 'project'; STATE.project = 'railyard'; STATE.view = 'pipeline';

    // 1 · Intake has produced a destination, one note, one decision.
    STATE.stage = 1;
    renderMain();
    const intake = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (intake.indexOf(I18N.t('pipe.dossier')) < 0)
      bad.push('the dossier panel did not render at all');
    if (intake.indexOf('A normative contract plus a working generator.') < 0)
      bad.push('the intake dossier does not show the destination');
    if (intake.indexOf(I18N.t('dossier.destination')) < 0)
      bad.push('the destination row carries no label');
    if (intake.indexOf(I18N.t('dossier.notes')) < 0)
      bad.push('the notes count is missing from the intake dossier');
    if (intake.indexOf(I18N.t('dossier.decisions')) < 0)
      bad.push('the decisions count is missing from the intake dossier');
    // The rawness check: a missing i18n key or a `undefined` means the renderer
    // is reading a field the payload no longer has.
    if (/\\bdossier\\.[a-zA-Z]+/.test(intake))
      bad.push('a raw dossier key reached the markup: ' +
        (intake.match(/\\bdossier\\.[a-zA-Z]+/) || [''])[0]);
    if (/\\bundefined\\b/.test(intake)) bad.push('a fact rendered as "undefined"');

    // 2 · Ask counts the grilling rounds actually on disk.
    STATE.stage = 2; renderMain();
    const ask = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (ask.indexOf(I18N.t('dossier.grillRounds')) < 0)
      bad.push('the ask dossier does not count grilling rounds');
    if (!/class="v">3</.test(ask)) bad.push('the grilling round count is not 3');

    // 3 · Spec counts ADRs.
    STATE.stage = 3; renderMain();
    const spec = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (!/class="v">2</.test(spec))
      bad.push('the spec dossier does not show 2 ADRs');

    // 4 · Split shows progress over the ticket set.
    STATE.stage = 5; renderMain();
    const split = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (split.indexOf('1/3') < 0)
      bad.push('the split dossier does not show 1 of 3 tickets resolved');
    if (split.indexOf(I18N.t('dossier.frontier')) < 0)
      bad.push('the split dossier does not show the frontier count');

    // 5 · Review ran and failed, and its run must be visible with the flags.
    STATE.stage = 7; renderMain();
    const review = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (review.indexOf('4000 ms') < 0)
      bad.push('the review dossier does not show the run it has');
    if (review.indexOf(I18N.t('ins.runsTampered')) < 0)
      bad.push('a tampered run in the dossier was not flagged');
    if (review.indexOf(I18N.t('ins.runsOutside', { n: 1 })) < 0)
      bad.push('the dossier kept the outside write secret');

    // 6 · A stage that truly has not run keeps the honest empty state, and a
    // stage that is active with no run says so rather than showing nothing.
    STATE.stage = 9; renderMain();
    const retro = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (retro.indexOf(I18N.t('pipe.empty')) < 0)
      bad.push('a stage with no facts and no runs did not show the empty state');
    STATE.stage = 4; renderMain();
    const design = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (design.indexOf(I18N.t('dossier.noRuns')) < 0)
      bad.push('an active stage with no runs did not say so');
  } catch (e) {
    bad.push('the dossier check threw: ' + e.message + '\n    ' +
      (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  } finally {
    STATE.stage = 1;
  }
  if (bad.length) {
    console.error('FAIL (stage dossier)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   the dossier shows real facts, the runs, and the honest empty state');
}

/* ---- the per-stage record panels ----
 *
 * 核心原则：各环节只负责自己的部分。 These checks assert BOTH directions: the
 * stage that owns a fact shows it, and the stages that do not own it do not
 * show it — a panel that repeated the whole record under every stage is the
 * failure this guards against, and it is exactly what P8 shipped.
 */
{
  const bad = [];
  const stageHTML = async (i) => {
    STATE.scope = 'project'; STATE.project = 'railyard'; STATE.view = 'pipeline';
    STATE.stage = i;
    await ensureDossier(true);
    renderMain();
    return (globalThis.__cache['main'] || {}).innerHTML || '';
  };
  const must = (html, needle, why) => {
    if (html.indexOf(needle) < 0) bad.push(why + ' (missing: ' + needle.slice(0, 60) + ')');
  };
  const mustNot = (html, needle, why) => {
    if (html.indexOf(needle) >= 0) bad.push(why + ' (must not contain: ' + needle.slice(0, 60) + ')');
  };
  try {
    const Q = 'What are you detecting';          // a grilling question — ask's own
    const ADR = 'Keep it one document';          // a design artifact — design's own
    const T1 = 'issues/01-first.md';             // a ticket file — split/develop's own
    const GATE = 'Prove it';                     // a develop gate

    const intake = await stageHTML(1);
    must(intake, 'watch my camera and tell me when something looks off', 'intake does not show the idea');
    must(intake, I18N.t('dos.conj'), 'intake does not show the early conjectures');
    must(intake, 'One document', 'the early decision is not on the intake panel');
    must(intake, 'Multi-user auth', 'the exclusion is not on the intake panel');
    mustNot(intake, Q, 'intake is showing the grilling record, which is not its part');
    mustNot(intake, ADR, 'intake is showing design artifacts');
    mustNot(intake, T1, 'intake is showing tickets');
    /* A session idea is the operator's own words, so the panel must not claim
     * it was quoted from a map — and must not print the "there is none"
     * sentence over an idea that plainly exists. */
    mustNot(intake, I18N.t('dos.ideaFromMap'), 'the panel credited map.md for a session idea');
    mustNot(intake, I18N.t('dos.noIdea'), 'the panel said there is no idea while showing one');

    /* The other half of the same rule, on the same panel: with no idea the
     * page states the absence instead of rendering an em-dash placeholder,
     * which is what it did before — and an em-dash reads as "empty field",
     * not as "this feature has no concept on the record". */
    {
      const realIdea = DOSSIER.data.idea, realSource = DOSSIER.data.ideaSource;
      DOSSIER.data.idea = null; DOSSIER.data.ideaSource = null;
      renderMain();
      const bare = (globalThis.__cache['main'] || {}).innerHTML || '';
      must(bare, I18N.t('dos.noIdea'), 'a feature with no idea did not say so');
      DOSSIER.data.idea = realIdea; DOSSIER.data.ideaSource = realSource;
      renderMain();
    }

    /* And a map feature's concept says where it came from, because a sentence
     * quoted out of map.md must not read as something the operator typed. */
    {
      const realIdea = DOSSIER.data.idea, realSource = DOSSIER.data.ideaSource;
      DOSSIER.data.idea = 'quoted from the map'; DOSSIER.data.ideaSource = 'map';
      renderMain();
      const quoted = (globalThis.__cache['main'] || {}).innerHTML || '';
      must(quoted, I18N.t('dos.ideaFromMap'), 'a map-sourced idea did not name its source');
      DOSSIER.data.idea = realIdea; DOSSIER.data.ideaSource = realSource;
      renderMain();
    }

    /* The pipeline is a pane, not a page: the rail must not scroll, the
     * dossier column must. The class is the only thing CSS can key on, so its
     * presence is what the layout contract rests on — present on the pipeline,
     * gone the moment another view renders into the same container. */
    if (!document.getElementById('main').classList.contains('piped'))
      bad.push('the pipeline pane did not switch to its own scrolling');
    {
      STATE.view = 'board';
      renderMain();
      const boardEl = document.getElementById('main');
      if (boardEl.classList.contains('piped'))
        bad.push('the board view is still marked as the scrolling pipeline pane');
      STATE.view = 'pipeline';
      renderMain();
    }

    /* Version skew, named where it bites: an old server process behind a
     * current page sends `exists` without `path`, every preview button
     * silently becomes a dash, and nothing explains why. The panel must say
     * what happened and how to fix it, above the dashes. */
    {
      const realPath = DOSSIER.data.spec.path;
      DOSSIER.data.spec.path = null;
      renderMain();
      const skewed = (globalThis.__cache['main'] || {}).innerHTML || '';
      must(skewed, I18N.t('dos.staleServer'), 'an exists-without-path dossier did not name the version skew');
      DOSSIER.data.spec.path = realPath;
      renderMain();
      const fresh = (globalThis.__cache['main'] || {}).innerHTML || '';
      mustNot(fresh, I18N.t('dos.staleServer'), 'the stale-server banner is shown for a current server');
    }

    const ask = await stageHTML(2);
    must(ask, Q, 'ask does not show the round question');
    must(ask, 'People', 'the recorded answer is not beside its question');
    must(ask, I18N.t('dos.answersInTranscript'), 'a transcript-only round is not honestly marked');
    must(ask, 'changeReqText', 'the change input is not on the requirements stage');
    must(ask, 'show heja world instead of hello world', 'the open change is not listed');
    mustNot(ask, ADR, 'ask is showing design artifacts');
    mustNot(ask, GATE, 'ask is showing another stage\'s gate');
    /* A round-only panel is blank over a map feature that was grilled through
     * tickets. With no rounds, the grilling tickets ARE the record, and the
     * panel must point at them rather than report nothing. */
    {
      const realRounds = DOSSIER.data.rounds;
      DOSSIER.data.rounds = [];
      renderMain();
      const noRounds = (globalThis.__cache['main'] || {}).innerHTML || '';
      must(noRounds, I18N.t('dos.noRounds'), 'a feature with no rounds did not say so');
      must(noRounds, I18N.t('dos.grilledByTickets', { n: 1 }),
        'the grilling tickets were not offered as the grilling record');
      must(noRounds, 'Which greeting is right', 'the grilling ticket itself is not named');
      DOSSIER.data.rounds = realRounds;
      renderMain();
      const withRounds = (globalThis.__cache['main'] || {}).innerHTML || '';
      mustNot(withRounds, I18N.t('dos.grilledByTickets', { n: 1 }),
        'the ticket fallback was shown even though the rounds exist');
    }

    const spec = await stageHTML(3);
    must(spec, 'Problem Statement', 'spec does not show its sections');
    mustNot(spec, Q, 'spec is showing the grilling record');
    mustNot(spec, GATE, 'spec is showing another stage\'s gate');

    const design = await stageHTML(4);
    must(design, ADR, 'design does not show its ADRs');
    mustNot(design, Q, 'design is showing the grilling record');

    const split = await stageHTML(5);
    must(split, T1, 'split does not open the ticket file');
    must(split, I18N.t('dos.noAssignee'), 'the honest no-assignee note is missing');
    mustNot(split, Q, 'split is showing the grilling record');

    const develop = await stageHTML(6);
    must(develop, 'implement-spec', 'develop does not show the runs in order');
    must(develop, '2026-10-31T00-00-00-000Z-develop.log', 'develop does not show the transcript');
    must(develop, GATE, 'develop does not show its own gate');
    mustNot(develop, Q, 'develop is showing the grilling record');

    const review = await stageHTML(7);
    must(review, I18N.t('dos.reviewArt'), 'review does not show its record section');
    must(review, I18N.t('dos.noReviewRun'), 'review does not say honestly that it has not run');
    mustNot(review, Q, 'review is showing the grilling record');

    const ship = await stageHTML(8);
    must(ship, I18N.t('dos.shipNoSkill'), 'ship does not say what will run it (nothing is configured)');
    /* Saying "configure it in Settings" without a way to get there is a dead
     * end described politely. The panel must carry the way, not only the need. */
    must(ship, I18N.t('dos.shipConfigure'), 'ship does not offer the way to configure automation');
    must(ship, 'onclick="openSettings', 'the configure button is not wired to the settings panel');
    mustNot(ship, Q, 'ship is showing the grilling record');

    const retro = await stageHTML(9);
    must(retro, I18N.t('dos.noRetro'), 'retro does not show its honest empty state');
    mustNot(retro, Q, 'retro is showing the grilling record');

    /* The cross-stage view: the timeline lives here, and only here. */
    STATE.view = 'records';
    renderMain();
    const rec = (globalThis.__cache['main'] || {}).innerHTML || '';
    must(rec, I18N.t('dos.timeline'), 'the timeline is not in the records view');

    /* Structure and raw keys, still true for every panel. */
    for (const [name, html] of [['intake', intake], ['ask', ask], ['develop', develop], ['records', rec]]) {
      const open = (html.match(/<div\b/g) || []).length;
      const close = (html.match(/<\/div>/g) || []).length;
      if (open !== close)
        bad.push(name + ' panel is not balanced: ' + open + ' <div> vs ' + close + ' </div>');
      if (/\\b(?:dos|ticket|dec|pv)\\.[a-zA-Z]+/.test(html))
        bad.push(name + ': a raw i18n key reached the markup: ' +
          (html.match(/\\b(?:dos|ticket|dec|pv)\\.[a-zA-Z]+/) || [''])[0]);
    }

    /* The adjust path, on the stage that owns it: file a change verbatim. */
    STATE.stage = 2; renderMain();
    const calls = [];
    const closed = [];
    const revealed = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (u.includes('/api/change-request') && opts && opts.method === 'POST') {
        calls.push(body);
        return { ok: true, status: 201, json: async () => ({ change: { id: 'CH-02',
          text: body.text, openedAt: '2026-10-31T04:00:00.000Z' } }) };
      }
      if (u.includes('/api/change-close') && opts && opts.method === 'POST') {
        closed.push(body);
        return { ok: true, status: 200, json: async () => ({ change: { id: body.id,
          status: 'closed', closedAt: '2026-10-31T05:00:00.000Z', note: body.note } }) };
      }
      if (u.includes('/api/reveal') && opts && opts.method === 'POST') {
        revealed.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, mode: body.mode }) };
      }
      if (u.includes('/api/file?')) {
        return { ok: true, status: 200, json: async () => ({ path: 'spec.md',
          name: 'spec.md', size: 48, at: '2026-10-31T01:30:00.000Z', lang: 'markdown',
          tooLarge: false, binary: false,
          text: '# Spec\n\n## Problem Statement\n\nThe greeting is wrong.\n' }) };
      }
      return realFetch(url, opts);
    };
    const input = document.getElementById('changeReqText');
    if (!input) bad.push('there is no change-request input on the ask panel');
    else {
      input.value = 'change hello world to heja world';
      await fileChangeRequest();
      if (calls.length !== 1) bad.push('filing the change sent no request');
      else if (calls[0].text !== 'change hello world to heja world')
        bad.push('the change was not sent verbatim');
      const said = (globalThis.__cache['toast'] || {}).textContent || '';
      if (said.indexOf(I18N.t('dos.changeFiled', { id: 'CH-02' })) < 0)
        bad.push('the filed change was not announced; toast said: ' + said);
      if (input.value !== '') bad.push('the input was not cleared after filing');
    }
    const note = document.querySelector('[data-note-for="CH-01"]');
    if (note) {
      note.value = 'handled in the build stage';
      await closeChangeFlow('CH-01');
      if (closed.length !== 1) bad.push('closing a change sent no request');
      else if (closed[0].note !== 'handled in the build stage')
        bad.push('the closing note was not sent');
    }

    /* The preview and the reveal verbs, unchanged by the reshuffle. */
    await openPreview('spec.md', I18N.t('dos.spec'));
    const pv = document.getElementById('pv');
    if (!pv || !pv.classList.contains('on')) bad.push('the preview did not open');
    const pvBody = (document.getElementById('pvBody') || {}).innerHTML || '';
    if (pvBody.indexOf('Problem Statement') < 0)
      bad.push('the preview did not render the file it was given');
    await revealPath('spec.md', 'vscode', 'feature');
    if (revealed.length !== 1) bad.push('"open in VS Code" sent no request');
    else if (revealed[0].mode !== 'vscode') bad.push('the reveal mode was not vscode');
    closePreview();
    if (document.getElementById('pv').classList.contains('on')) bad.push('the preview did not close');

    globalThis.fetch = realFetch;
  } catch (e) {
    bad.push('the stage-panel check threw: ' + e.message + '\n    ' +
      (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  }
  if (bad.length) {
    console.error('FAIL (per-stage panels)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   each stage shows only its own part (and none of the others\')');
}


/* ---- the records view ----
 *
 * It shared the `records` map with the dossier and kept reading the prototype's
 * shape, so it threw on real data and blanked the whole page. Now it reads the
 * same per-stage records; what it must never do again is state something that is
 * not on disk.
 */
{
  const bad = [];
  try {
    STATE.scope = 'project'; STATE.project = 'railyard'; STATE.view = 'records';
    renderMain();
    const html = (globalThis.__cache['main'] || {}).innerHTML || '';
    if (html.length < 200) bad.push('the records view rendered nothing');
    if (html.indexOf(I18N.t('rec.skill')) < 0)
      bad.push('the records table has no skill column');
    if (html.indexOf(I18N.t('rec.lastRun')) < 0)
      bad.push('the records table has no last-run column');
    // The gate that guards develop must supply the approver, because that is
    // where approval is actually recorded.
    if (html.indexOf(I18N.t('role.po')) < 0)
      bad.push('the records table does not name the approver of the gate');
    if (html.indexOf(I18N.t('m.signoffShort')) < 0)
      bad.push('the records table does not show the acceptance method');
    // The prototype's phantom columns: it claimed a run window and a trigger for
    // stages that had never run.
    if (html.indexOf(I18N.t('tbl.interval')) >= 0)
      bad.push('the phantom "run window" column is back');
    if (/\\bundefined\\b/.test(html)) bad.push('the records table rendered "undefined"');
    if (/\\brec\\.[a-zA-Z]+/.test(html))
      bad.push('a raw rec key reached the markup: ' +
        (html.match(/\\brec\\.[a-zA-Z]+/) || [''])[0]);
  } catch (e) {
    bad.push('the records view threw: ' + e.message + '\n    ' +
      (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  } finally {
    STATE.view = 'pipeline';
  }
  if (bad.length) {
    console.error('FAIL (records view)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   the records view reads the real per-stage records');
}

/* ---- the AFK switch ----
 *
 * Auto-advance is a behaviour the operator has to be able to see and stop. The
 * pill reads the setting and toggles it; when it disagrees with SETTINGS the
 * only way to find out is to click it and watch a stage run on its own.
 */
{
  const bad = [];
  const before = SETTINGS.automation.afk;
  try {
    SETTINGS.automation = Object.assign({}, SETTINGS.automation, { afk: false });
    renderStatusbar();
    let bar = (globalThis.__cache['statusbar'] || {}).innerHTML || '';
    if (bar.indexOf('id="afkPill"') < 0) bad.push('the status bar has no AFK pill');
    if (bar.indexOf(I18N.t('status.afk')) < 0) bad.push('the AFK pill carries no label');
    if (bar.indexOf(I18N.t('status.afkOff')) < 0)
      bad.push('an AFK pill that is off does not say so');
    if (bar.indexOf('p-blue') >= 0) bad.push('the pill reads as on while AFK is off');

    const pill = document.getElementById('afkPill');
    if (!pill || typeof pill.onclick !== 'function')
      bad.push('clicking the AFK pill would do nothing');
    else pill.onclick();
    if (SETTINGS.automation.afk !== true) bad.push('the pill did not turn AFK on');
    bar = (globalThis.__cache['statusbar'] || {}).innerHTML || '';
    if (bar.indexOf(I18N.t('status.afkOn')) < 0)
      bad.push('a pill that is on does not say so');
    if (bar.indexOf('p-blue') < 0) bad.push('an AFK pill that is on is not marked');
  } catch (e) {
    bad.push('the AFK pill threw: ' + e.message);
  } finally {
    SETTINGS.automation = Object.assign({}, SETTINGS.automation, { afk: before });
    renderStatusbar();
  }
  if (bad.length) {
    console.error('FAIL (AFK switch)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   the AFK pill reads the setting and toggles it');
}

/* ---- the opening notice ----
 *
 * It explains a dead page, so it must not become a permanent banner. It comes
 * down once there is data behind it, and stays up with the reason when there is
 * not — a blank page with a clean console being the least diagnosable failure
 * there is.
 */
{
  const notice = document.getElementById('bootNotice');
  if (!notice) {
    console.error('FAIL: #bootNotice is missing, so a dead page explains nothing');
    process.exit(1);
  }
  if (!notice.classList.contains('gone')) {
    console.error('FAIL: the boot notice is still showing after a successful boot');
    console.error('  detail: ' + ((globalThis.__cache['bootNoticeDetail'] || {}).textContent || ''));
    process.exit(1);
  }
  // And the element it would write a reason into must exist, or the failure path
  // is silent.
  if (!document.getElementById('bootNoticeDetail')) {
    console.error('FAIL: #bootNoticeDetail is missing, so a failure cannot say why');
    process.exit(1);
  }
}

/* ---- the runs card ----
 *
 * The control plane's read side. It has three jobs and each one is asserted:
 * name the stage, report how long it took, and *flag a run whose audit is not
 * clean*. The last is the whole reason the card exists — a tampered run that
 * looks like a succeeded one is worse than no history at all.
 */
try {
  runAction('scope:railyard');
  await new Promise(r => setTimeout(r, 120));  // ensureRuns() is not awaited by the renderer
  const card = (globalThis.__cache['runsCard'] || {}).innerHTML || '';
  const bad = [];
  if (!card) bad.push('the inspector renders no runs card');
  // The stage is shown by its localised name, which is what the rail uses too.
  if (card && card.indexOf(I18N.pick({ en: 'Acceptance', zh: '\u9a8c\u6536' })) < 0)
    bad.push('the run history did not render its stages');
  if (card && (card.match(/class="kv"/g) || []).length < 2)
    bad.push('the run history rendered fewer rows than the fixture has runs');
  if (card && card.indexOf('4000 ms') < 0) bad.push('a run did not report its duration');
  if (card && card.indexOf('code-review') >= 0) bad.push('a skill name leaked into the card as the stage');
  if (card && card.indexOf('leak') >= 0) bad.push('an outside path leaked instead of being counted');
  if (card && card.indexOf(I18N.t('ins.runsTampered')) < 0)
    bad.push('a tampered run was not flagged');
  if (card && card.indexOf(I18N.t('ins.runsOutside', { n: 1 })) < 0)
    bad.push('outside writes were not reported');
  /* The stop, and the gate that caused it. Without this a person coming back
   * later sees a list of green runs and no answer to "why did it stop?" — the
   * activity line that reported it does not survive a restart. */
  if (card && card.indexOf(I18N.t('ins.lastStop', { why: 'a blocking gate is open on ship' })) < 0)
    bad.push('the reason the chain stopped is not shown');
  if (card && card.indexOf(I18N.t('ins.lastStopGates', { ids: 'g-ship-signoff' })) < 0)
    bad.push('the gate holding the chain is not named');
  const raw = card.match(/\bins\.[a-zA-Z]+/);
  if (raw) bad.push('a raw i18n key reached the runs card: ' + raw[0]);
  if (bad.length) {
    console.error('FAIL (runs card)');
    for (const p of bad) console.error('  - ' + p);
    console.error('card: ' + card.slice(0, 400));
    process.exit(1);
  }
  console.log('  ok   the runs card lists history and flags a tampered run');
} catch (e) {
  console.error('FAIL (runs card): ' + e.message);
  process.exit(1);
}

/* ---- a project from a folder that already has code in it ----
 *
 * Three claims: the entry point is there and labelled, the root is registered
 * with the path and reader actually chosen, and reading the code is *started*
 * rather than claimed finished. A dialog that renders a pretty card but posts
 * the wrong path looks perfect in a browser, so the request bodies are asserted.
 *
 * This used to drive a second dialog for "load a codebase". There is one entry
 * point now with three branches, so the same coverage is held against the live
 * one instead — dropping it would have been the easier edit and the wrong one.
 */
try {
  const bad = [];
  if (STATE.scope !== 'portfolio') runAction('scope:portfolio');
  /* The sidebar is a rendered string in this harness, so the button is checked
   * where it is written rather than through a parsed element. */
  const side = (globalThis.__cache['sidebar'] || {}).innerHTML || '';
  /* The sidebar's primary action has to make a *project*. It used to open the
   * concept wizard, which makes a feature, so "new project" silently meant
   * "new feature" — and the two read alike enough that nobody noticed. */
  if (side.indexOf('openNewProject()') < 0)
    bad.push('the sidebar offers no way to start a new project');
  else if (side.indexOf(I18N.t('np.title')) < 0)
    bad.push('the new-project button is not labelled in the current locale');
  /* Loading an existing codebase is the same dialog, opened at its second
   * branch: one entry point with three ways in, not two dialogs that drift. */
  if (side.indexOf("openNewProject('existing')") < 0)
    bad.push('the sidebar offers no way to load a codebase');
  else if (side.indexOf(I18N.t('sb.loadCodebase')) < 0)
    bad.push('the load-codebase button is not labelled in the current locale');

  const sent = [];
  const reads = [];
  const polled = [];
  let loaded = false;
  const NEW_PROJECT = JSON.parse(JSON.stringify(FIXTURE));
  NEW_PROJECT.name = 'loaded-repo';
  NEW_PROJECT.root = 'D:/src/loaded-repo';
  NEW_PROJECT.features = [];
  NEW_PROJECT.git = { branch: 'main', head: 'abc1234', dirty: false };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const ok = (v, st) => ({ ok: true, status: st || 200, json: async () => v });
    if (u.includes('/api/projects')) return ok(loaded ? [FIXTURE, NEW_PROJECT] : [FIXTURE]);
    if (u.includes('/api/skills/readers'))
      return ok({ skillsRoot: '/skills', pick: { id: 'research', description: '', score: 6, reason: 'x' },
        readers: [{ id: 'research', description: 'reads a codebase', score: 6, reason: 'names the codebase' },
                  { id: 'implement-spec', description: 'writes code', score: -3, reason: 'writes code' }] });
    if (u.indexOf('/api/workspaces') >= 0 && opts && opts.method === 'POST') {
      sent.push(JSON.parse(opts.body));
      loaded = true;
      return ok({ root: 'D:/src/loaded-repo', added: true, roots: ['D:/src/loaded-repo'],
        file: '/tmp/w.json', doc: { path: 'D:/src/loaded-repo/.scratch/CODEBASE.md', status: 'written' },
        brief: { name: 'loaded-repo' }, reader: { id: 'research' }, project: null }, 201);
    }
    if (u.indexOf('/api/discover') >= 0 && opts && opts.method === 'POST') {
      reads.push(JSON.parse(opts.body));
      return ok({ jobId: 'd1', status: 'running', target: 'D:/src/loaded-repo', skill: 'research',
        outputRoot: 'docs/discovery',
        phases: [{ id: 'discovery', status: 'pending', error: null },
                 { id: 'architecture', status: 'pending', error: null },
                 { id: 'feature-mapping', status: 'pending', error: null }] }, 202);
    }
    if (u.indexOf('/api/discover?') >= 0) {
      polled.push(u);
      /* Running first, then finished: the watcher has to notice the difference
       * and stop, and the files have to reach the screen when it does. */
      const done = polled.length > 1;
      return ok({ jobId: 'd1', status: done ? 'succeeded' : 'running',
        target: 'D:/src/loaded-repo', skill: 'research', outputRoot: 'docs/discovery',
        files: done ? [{ path: 'docs/discovery/domain/domain-glossary.md', bytes: 120 }] : [],
        phases: [{ id: 'discovery', status: done ? 'succeeded' : 'running', error: null },
                 { id: 'architecture', status: done ? 'succeeded' : 'pending', error: null },
                 { id: 'feature-mapping', status: done ? 'succeeded' : 'pending', error: null }] });
    }
    return realFetch(url, opts);
  };

  openNewProject('existing');
  if (!document.getElementById('npModeExisting').classList.contains('on'))
    bad.push('the codebase entry point did not open the existing-folder branch');
  if (document.getElementById('npSkillWrap').style.display === 'none')
    bad.push('the existing branch never asks which skill reads the folder');

  document.getElementById('npPath').value = 'D:/src/loaded-repo';
  document.getElementById('npSkill').value = 'research';
  await submitNewProject();

  if (sent.length !== 1) bad.push('the project was never registered');
  else {
    if (sent[0].path !== 'D:/src/loaded-repo') bad.push('it registered the wrong path: ' + sent[0].path);
    if (sent[0].skill !== 'research') bad.push('it did not send the chosen skill: ' + sent[0].skill);
  }
  /* Reading an existing folder is the reason this branch exists. A project that
   * registers and then quietly skips the reading would look like it succeeded. */
  if (reads.length !== 1) bad.push('reading the codebase was never started');
  else if (reads[0].target !== 'D:/src/loaded-repo')
    bad.push('it started reading the wrong folder: ' + reads[0].target);
  /* The dialog stays open while the passes run: the phases are the only thing
   * that tells a human it is doing something, and closing early loses them. */
  if (!document.getElementById('npOverlay').classList.contains('on'))
    bad.push('the dialog closed before the reading finished');
  const progress = document.getElementById('npProgress').innerHTML;
  if (progress.indexOf(I18N.t('np.phases')) < 0)
    bad.push('the passes being run are not shown');
  for (const id of ['discovery', 'architecture', 'feature-mapping']) {
    if (progress.indexOf(I18N.t('np.ph.' + id)) < 0)
      bad.push('the pass ' + id + ' is not listed');
  }
  const rawPhase = progress.match(/\bnp\.[a-zA-Z.]+/);
  if (rawPhase) bad.push('a raw i18n key reached the progress: ' + rawPhase[0]);

  /* A read takes minutes. The only way the dialog stops saying "pending" is a
   * poll, so one has to have been scheduled — and it has to ask about *this*
   * job, not merely about something. */
  /* Several watchers run now — the job's own poll, and the global activity
   * poll that outlives the dialog. Which is which is an implementation detail;
   * what has to be true is that *something* keeps asking. */
  const timers = globalThis.__intervals.filter((t) => t && typeof t.fn === 'function');
  if (timers.length === 0)
    bad.push('nothing was scheduled to watch the reading');
  else {
    const runAll = async () => {
      for (const t of globalThis.__intervals.slice()) {
        if (t && typeof t.fn === 'function') await t.fn();
      }
    };
    await runAll();
    if (polled.length === 0)
      bad.push('the watcher never asked how the reading was going');
    else if (polled[polled.length - 1].indexOf('jobId=d1') < 0)
      bad.push('the watcher asked about the wrong job: ' + polled[polled.length - 1]);

    /* Then it finishes. The watcher has to stop asking, and what the passes
     * wrote has to replace the phase list on screen — a dialog still saying
     * "pending" after the work is done is indistinguishable from one that is
     * never going to be. */
    globalThis.__cleared.length = 0;
    await runAll();
    if (globalThis.__cleared.length === 0)
      bad.push('the watcher kept asking after the reading finished');
    const after = document.getElementById('npProgress').innerHTML;
    if (after.indexOf('docs/discovery/domain/domain-glossary.md') < 0)
      bad.push('the files the passes wrote never reached the screen');
  }

  if (STATE.scope !== 'project' || STATE.project !== 'loaded-repo')
    bad.push('the page did not switch to the new project (' + STATE.scope + '/' + STATE.project + ')');
  if ((globalThis.__cache['main'] || {}).innerHTML === '')
    bad.push('the new project rendered an empty page');
  /* The landed-on state: no features. "Stage 0/9 · Retro" would claim the work
   * had reached the end, so the sidebar must say there is nothing yet. */
  const sideAfter = (globalThis.__cache['sidebar'] || {}).innerHTML || '';
  if (sideAfter.indexOf(I18N.t('sb.noFeature')) < 0)
    bad.push('a project with no features still shows a stage position');
  const rawKey = sideAfter.match(/\bsb\.[a-zA-Z]+/);
  if (rawKey) bad.push('a raw i18n key reached the sidebar: ' + rawKey[0]);

  closeNewProject();
  globalThis.fetch = realFetch;

  if (bad.length) {
    console.error('FAIL (load a codebase)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   an existing folder is registered, and reading it is started and shown');
} catch (e) {
  console.error('FAIL (load a codebase) threw: ' + e.message + '\n    ' +
    (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  process.exit(1);
}

/* ---- new project: three ways in ----
 *
 * A project is the folder; a feature is the work described inside it. The
 * dialog has to offer all three ways a folder arrives, and it has to say which
 * one is chosen — a mode switch that looks selected but is not is how someone
 * clones into the folder they meant to read.
 */
try {
  const bad = [];
  if (STATE.scope !== 'portfolio') runAction('scope:portfolio');

  for (const id of ['npModeEmpty', 'npModeExisting', 'npModeGit']) {
    if (STATIC_MARKUP.indexOf('id="' + id + '"') < 0)
      bad.push('the new-project dialog has no ' + id + ' branch');
  }

  openNewProject();
  if (!document.getElementById('npOverlay').classList.contains('on'))
    bad.push('the new-project dialog did not open');
  if (!document.getElementById('npModeEmpty').classList.contains('on'))
    bad.push('the dialog did not open on the empty-folder branch');
  /* An empty folder has nothing to read, so asking which skill reads it is a
   * question with no answer — and a control that answers it anyway invites a
   * skill to be recorded against a folder nobody has looked at. */
  if (document.getElementById('npSkillWrap').style.display !== 'none')
    bad.push('the empty branch still asks which skill reads the folder');

  npMode('existing');
  if (!document.getElementById('npModeExisting').classList.contains('on'))
    bad.push('the existing-folder branch did not mark itself chosen');
  if (document.getElementById('npModeEmpty').classList.contains('on'))
    bad.push('two branches are marked chosen at once');
  if (document.getElementById('npSkillWrap').style.display === 'none')
    bad.push('the existing branch never asks which skill reads the folder');

  npMode('git');
  if (document.getElementById('npGitWrap').style.display === 'none')
    bad.push('the git branch did not reveal the URL field');
  /* The folder field means something different in this branch: it is where the
   * clone goes, not what gets read. An unrelabelled field is a wrong answer
   * waiting to be typed into it. */
  if (document.getElementById('npFolderLabel').textContent !== I18N.t('np.cloneInto'))
    bad.push('the git branch does not relabel the folder as a clone destination');

  npMode('empty');
  const go = document.getElementById('npGo').textContent;
  if (!go || go === I18N.t('np.reading'))
    bad.push('the action button carries no label for the chosen branch');

  closeNewProject();
  if (document.getElementById('npOverlay').classList.contains('on'))
    bad.push('the dialog did not close');

  if (bad.length) {
    console.error('FAIL (new project)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   a new project offers three ways in, and says which one is chosen');
} catch (e) {
  console.error('FAIL (new project) threw: ' + e.message + '\n    ' +
    (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  process.exit(1);
}

/* ---- the folder chooser: every drive, and a folder that does not exist yet ----
 *
 * Two things a path field alone cannot do, both reported as broken by the person
 * using it: reach a drive that is not the one the process started on, and name a
 * folder that has not been made yet. A chooser that can only pick from what is
 * already there sends the human to Explorer mid-flow, and they come back having
 * lost the place they were standing.
 *
 * The drive list is whatever the server says exists — asserted against a list
 * that contains a drive other than C:, so a hardcoded `C:\` cannot pass.
 */
try {
  const bad = [];
  if (STATE.scope !== 'portfolio') runAction('scope:portfolio');

  /* The listener is on the markup, and the shim's addEventListener is a no-op,
   * so the wiring is checked in the markup and the behaviour by calling what
   * the listener calls. Checking only one of the two would let a selector that
   * is never wired pass. */
  if (STATIC_MARKUP.indexOf("getElementById('npDrive').addEventListener('change'") < 0)
    bad.push('choosing a drive is not wired to browsing it');

  const DRIVES = ['C:\\', 'D:\\', 'H:\\'];
  const BROWSE = {
    'C:\\Users\\me': { path: 'C:\\Users\\me', parent: 'C:\\Users', drives: DRIVES,
      dirs: [{ name: 'Projects', path: 'C:\\Users\\me\\Projects' }],
      files: 3, other: 0, entries: 4, empty: false },
    'H:\\': { path: 'H:\\', parent: null, drives: DRIVES,
      dirs: [{ name: 'Projects', path: 'H:\\Projects' }],
      files: 0, other: 0, entries: 1, empty: false },
    'H:\\Projects': { path: 'H:\\Projects', parent: 'H:\\', drives: DRIVES,
      dirs: [], files: 0, other: 0, entries: 0, empty: true },
    'H:\\Projects\\fresh': { path: 'H:\\Projects\\fresh', parent: 'H:\\Projects',
      drives: DRIVES, dirs: [], files: 0, other: 0, entries: 0, empty: true }
  };

  const asked = [];
  const made = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const ok = (v, st) => ({ ok: true, status: st || 200, json: async () => v });
    if (u.includes('/api/browse')) {
      const p = decodeURIComponent((u.split('path=')[1] || '').split('&')[0]);
      asked.push(p);
      return ok(BROWSE[p] || BROWSE['C:\\Users\\me']);
    }
    if (u.includes('/api/mkdir')) {
      made.push(JSON.parse(opts.body));
      return ok({ path: JSON.parse(opts.body).path, created: true }, 201);
    }
    return realFetch(url, opts);
  };

  openNewProject();
  npToggleBrowse();
  await npBrowse('C:\\Users\\me');

  const driveHtml = document.getElementById('npDrive').innerHTML;
  for (const d of DRIVES) {
    /* One backslash in the markup; two in this source, because JS escapes it. */
    if (driveHtml.indexOf(d + '"') < 0)
      bad.push('the chooser does not offer the drive ' + d);
  }

  /* The whole point: get off the starting drive and land somewhere real. */
  await npBrowse('H:\\');
  if (document.getElementById('npPath').value !== 'H:\\')
    bad.push('browsing a drive other than C: did not go there');
  if (asked.indexOf('H:\\') < 0)
    bad.push('the other drive was never asked for');
  const listHtml = document.getElementById('npDirList').innerHTML;
  if (listHtml.indexOf('H:\\Projects') < 0)
    bad.push('the chooser did not list what is on the other drive');

  /* ---- making a folder ---- */
  if (npJoin('H:\\Projects', 'fresh') !== 'H:\\Projects\\fresh')
    bad.push('joining a folder name onto a path produced ' + npJoin('H:\\Projects', 'fresh'));
  /* A bare drive already ends in a separator: `H:\\\\new` would be a path with
   * an empty component, which is not the same folder. */
  if (npJoin('H:\\', 'fresh') !== 'H:\\fresh')
    bad.push('joining onto a drive root produced ' + npJoin('H:\\', 'fresh'));

  await npBrowse('H:\\Projects');
  if (document.getElementById('npDirNew').style.display !== 'none')
    bad.push('the new-folder row is open before it was asked for');
  npNewToggle();
  if (document.getElementById('npDirNew').style.display === 'none')
    bad.push('the new-folder button did not open the row');

  /* An empty name must not become a request: the server would be asked to make
   * a folder called the parent, and it would answer 409 at best. */
  document.getElementById('npNewName').value = '   ';
  await npCreateFolder();
  if (made.length !== 0)
    bad.push('an empty folder name still sent ' + made.length + ' request(s)');

  document.getElementById('npNewName').value = 'fresh';
  await npCreateFolder();
  if (made.length !== 1) bad.push('making a folder sent no request');
  else if (made[0].path !== 'H:\\Projects\\fresh')
    bad.push('the folder was made in the wrong place: ' + made[0].path);
  /* Landing inside it is the difference between one click and three: without
   * this the next thing typed goes into the parent, not the new project. */
  if (document.getElementById('npPath').value !== 'H:\\Projects\\fresh')
    bad.push('the chooser did not land inside the folder it made');
  if (document.getElementById('npDirNew').style.display !== 'none')
    bad.push('the new-folder row stayed open after the folder was made');

  closeNewProject();
  globalThis.fetch = realFetch;

  if (bad.length) {
    console.error('FAIL (folder chooser)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   the chooser reaches every drive, and can make the folder it lands in');
} catch (e) {
  console.error('FAIL (folder chooser) threw: ' + e.message + '\n    ' +
    (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  process.exit(1);
}

/* ---- long work: shown while it runs, and not stopped by closing ----
 *
 * Two claims that are easy to get separately wrong. Work that runs for minutes
 * must say what stage it is at, or the only honest thing on screen is a spinner
 * and the human learns to distrust it. And closing the window must not stop the
 * job: hiding a dialog and abandoning work look identical from the outside, so
 * the difference has to be asserted, not assumed.
 */
try {
  const bad = [];
  if (STATE.scope !== 'portfolio') runAction('scope:portfolio');

  const polled = [];
  const areaCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const ok = (v, st) => ({ ok: true, status: st || 200, json: async () => v });
    if (u.includes('/api/skills/readers'))
      return ok({ skillsRoot: '/skills', pick: { id: 'research', description: '', score: 6, reason: 'x' },
        readers: [{ id: 'research', description: 'reads a codebase', score: 6, reason: 'x' }] });
    if (u.indexOf('/api/workspaces') >= 0 && opts && opts.method === 'POST')
      return ok({ root: 'D:/src/loaded-repo', added: true, roots: [],
        brief: { name: 'loaded-repo' }, reader: { id: 'research' }, project: null }, 201);
    if (u.indexOf('/api/discover') >= 0 && opts && opts.method === 'POST')
      return ok({ jobId: 'd2', activityId: 'a2', status: 'running',
        target: 'D:/src/loaded-repo', skill: 'research', outputRoot: 'docs/discovery',
        phases: [{ id: 'discovery', status: 'pending', error: null }] }, 202);
    if (u.indexOf('/api/discover?') >= 0) {
      polled.push(u);
      return ok({ jobId: 'd2', status: 'running', target: 'D:/src/loaded-repo',
        skill: 'research', outputRoot: 'docs/discovery', files: [],
        phases: [{ id: 'discovery', status: 'running', error: null }] });
    }
    if (u.indexOf('/api/activity') >= 0)
      return ok({ running: 1, items: [{ id: 'a2', kind: 'discovery',
        label: 'Reading loaded-repo', target: 'D:/src/loaded-repo',
        startedAt: new Date().toISOString(), endedAt: null, status: 'running', error: null,
        progress: 0.5,
        steps: [{ at: new Date().toISOString(), kind: 'start', text: 'pass 1 of 3' },
                { at: new Date().toISOString(), kind: 'wrote', text: 'domain/domain-glossary.md' }] }] });
    if (u.indexOf('/api/areas?') >= 0)
      return ok({ root: 'D:/src/loaded-repo', outputRoot: 'docs/discovery', count: 2, areas: [
        { slug: 'enquiry', name: 'Enquiry', file: 'areas/enquiry.md', purpose: 'Route an enquiry.' },
        { slug: 'blog', name: 'Blog', file: 'areas/blog.md', purpose: 'Publish posts.' }] });
    if (u.indexOf('/api/areas/features') >= 0 && opts && opts.method === 'POST') {
      areaCalls.push(JSON.parse(opts.body));
      return ok({ root: 'D:/src/loaded-repo', outputRoot: 'docs/discovery', created: [
        { slug: 'enquiry', dir: 'x/enquiry', name: 'Enquiry' }] }, 201);
    }
    return realFetch(url, opts);
  };

  openNewProject('existing');
  document.getElementById('npPath').value = 'D:/src/loaded-repo';
  document.getElementById('npSkill').value = 'research';
  await submitNewProject();

  /* A mask that covers the form, with the stage named. A spinner alone would
   * answer "is it working" and leave "what is it doing" unanswered. */
  const mask = document.getElementById('npMask');
  if (mask.style.display === 'none')
    bad.push('the dialog does not mask itself while work runs');
  const stage = document.getElementById('npMaskStage').textContent;
  if (stage !== I18N.t('np.stageReading'))
    bad.push('the mask does not name the stage (got ' + JSON.stringify(stage) + ')');
  /* The header and footer stay reachable: a mask over the whole sheet would
   * take the close button with it, and then closing means the OS. */
  if (document.getElementById('npBg').style.display === 'none')
    bad.push('there is no way to send it to the background');

  /* ---- closing does not stop it ----
   *
   * Two parts, because either alone can be faked. Calling the timer function
   * proves it *works*; what proves it is still *scheduled* is that nothing was
   * dismissed when the dialog closed. */
  const before = polled.length;
  globalThis.__cleared.length = 0;
  closeNewProject();
  if (document.getElementById('npOverlay').classList.contains('on'))
    bad.push('the dialog did not close');
  if (globalThis.__cleared.length > 0)
    bad.push('closing dismissed the watcher (' + globalThis.__cleared.length + ' timer(s) cleared)');
  const timers = globalThis.__intervals.filter((t) => t && typeof t.fn === 'function');
  if (timers.length === 0) bad.push('closing cleared every watcher');
  else {
    for (const t of globalThis.__intervals.slice()) await t.fn();
    if (polled.length <= before)
      bad.push('closing stopped the work being watched');
  }
  /* And there is still a way to see it: a job nobody is watching is a job the
   * human has to assume is lost. */
  if (document.getElementById('actDock').style.display === 'none')
    bad.push('nothing on screen shows work is still running');
  else if (document.getElementById('actText').textContent.indexOf('Reading loaded-repo') < 0)
    bad.push('the dock does not say what is running');

  /* ---- the areas the reading named ---- */
  await npShowAreas('D:/src/loaded-repo');
  const listHtml = document.getElementById('npAreas').innerHTML;
  for (const name of ['Enquiry', 'Blog']) {
    if (listHtml.indexOf(name) < 0) bad.push('the areas list does not offer ' + name);
  }
  if (listHtml.indexOf('data-area="enquiry"') < 0)
    bad.push('an area cannot be chosen individually');
  const rawArea = listHtml.match(/\bnp\.[a-zA-Z]+/);
  if (rawArea) bad.push('a raw i18n key reached the areas list: ' + rawArea[0]);

  /* What is chosen is what is sent, and only that. Ticking is done through the
   * state the ticking writes, because this harness has no real DOM to click —
   * and the property that matters is not the widget, it is that a choice made
   * in the list is the choice that goes over the wire. */
  await npCreateAreaFeatures();
  if (areaCalls.length !== 1) bad.push('creating features sent no request');
  else if (!Array.isArray(areaCalls[0].slugs) || areaCalls[0].slugs.length !== 2)
    bad.push('it did not send the chosen areas: ' + JSON.stringify(areaCalls[0]));

  /* Creating clears the list, so a second click cannot silently make the same
   * features again — each call is a decision, and a stale list on screen would
   * invite repeating it. */
  if (document.getElementById('npAreas').innerHTML !== '')
    bad.push('the areas stayed on screen after being created');

  await npShowAreas('D:/src/loaded-repo');
  NP.chosen.delete('blog');
  await npCreateAreaFeatures();
  if (areaCalls.length !== 2) bad.push('the second choice sent no request');
  else if (JSON.stringify(areaCalls[1].slugs) !== JSON.stringify(['enquiry']))
    bad.push('it sent every area, not the chosen one: ' + JSON.stringify(areaCalls[1].slugs));

  globalThis.fetch = realFetch;

  if (bad.length) {
    console.error('FAIL (long work)');
    for (const p of bad) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  ok   work is shown while it runs, survives closing, and its areas become features');
} catch (e) {
  console.error('FAIL (long work) threw: ' + e.message + '\n    ' +
    (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  process.exit(1);
}

/* ---- a change, from a sentence ----
 *
 * The starting point is one box with no feature named, and the tool looks. What
 * is asserted here is mostly what it *declines* to do: where the words on disk
 * cannot separate two features it must say so and write nothing, because a
 * change filed against the wrong feature puts a decision in that feature's
 * journal, and a wrong decision in the record is harder to undo than a question.
 */
try {
  const bad = [];
  const realFetch = globalThis.fetch;
  const applied = [];
  const ROOT = (typeof PROJECTS === 'object' && Object.keys(PROJECTS).length > 0)
    ? PROJECTS[Object.keys(PROJECTS)[0]].root : 'D:/src/demo-app';

  /* A response whose body is not delivered until `letGo()` is called, so the
   * state *during* the wait is observable. Without it the only thing that can
   * be checked is the state after the answer arrives, by which time the mask
   * that is supposed to be showing the wait is already gone. */
  let letGo = null;
  let gated = null;
  const hold = (v) => ({ ok: true, status: 201, json: async () => v });

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('/api/change/apply') >= 0) {
      applied.push(JSON.parse(opts.body));
      if (gated) return gated;
      return hold(APPLY_OK);
    }
    return realFetch(url, opts);
  };

  const APPLY_OK = {
    change: { id: 'CH-01', text: 'x', status: 'open' },
    feature: 'login-page',
    located: { best: { slug: 'login-page', score: 6, reasons: ['slug:login'] },
               candidates: [{ slug: 'login-page', score: 6, reasons: ['slug:login'] }],
               confident: true },
    amendment: { id: 'CH-01', text: 'x', at: '2026-11-01T12:00:00.000Z',
                 section: 'Solution', previous: 'A form posting to /login.' },
    child: null, started: [], activityId: 'a-change-1'
  };

  /* ---- it opens, in the language in use, with a box to type into ---- */
  openChangeDialog();
  /* A browser selects the first option of a <select> by itself; this shim gives
   * the element no value at all, so it is set here — without it the dialog has
   * no project and the sentence goes nowhere. */
  document.getElementById('chProj').value = Object.keys(PROJECTS)[0] || '';
  if (document.getElementById('chProj').value === '')
    bad.push('no project is selected by default');
  if (!document.getElementById('chOverlay').classList.contains('on'))
    bad.push('the change dialog does not open');
  if (document.getElementById('chTitle').textContent !== I18N.t('ch.title'))
    bad.push('the title is not localised');
  /* Not `.options.length`: this shim has no real <select>, so the check is on
   * the markup the dialog wrote, which is what a browser would turn into
   * options. */
  if (document.getElementById('chProj').innerHTML.indexOf('<option') < 0)
    bad.push('no project can be chosen');
  if (document.getElementById('chText').placeholder.indexOf('ch.') === 0)
    bad.push('a raw i18n key reached the placeholder');

  /* ---- while it looks, the wait is named ----
   *
   * Held open by a promise so the state during the wait is observable at all:
   * once the call returns, the mask is gone and there is nothing left to check. */
  gated = { ok: true, status: 201,
    json: () => new Promise((res) => { letGo = () => res(APPLY_OK); }) };
  document.getElementById('chText').value = 'change 登陆 to 登录 on the login page';
  const pending = submitChange();
  /* One tick, so the call has actually gone out. Without it the assertions run
   * against a promise that has not yet reached its first await, and every one
   * of them passes or fails for the wrong reason. */
  await new Promise((r) => setTimeout(r, 0));
  if (document.getElementById('chMask').style.display === 'none')
    bad.push('nothing masks the dialog while the feature is being found');
  if (document.getElementById('chMaskStage').textContent !== I18N.t('ch.stageFinding'))
    bad.push('the mask does not say it is finding the feature');
  if (document.getElementById('chBg').style.display === 'none')
    bad.push('there is no way to send it to the background while it works');
  if (typeof letGo !== 'function') {
    bad.push('the apply call was never made (nothing was sent: ' + applied.length + ')');
    gated = null;
  } else { letGo(); gated = null; await pending; }

  /* ---- what went over the wire ---- */
  if (applied.length !== 1) bad.push('no change was sent');
  else {
    const sent = applied[0];
    if (sent.root !== ROOT) bad.push('it sent the wrong root: ' + JSON.stringify(sent.root));
    if (sent.text.indexOf('登陆') < 0) bad.push('the sentence did not travel with it');
    /* The point of the whole flow: the caller did not name a feature, and none
     * was sent. Sending one here would mean the page had already decided. */
    if (sent.feature) bad.push('the page named a feature instead of letting it be found');
  }

  /* ---- the answer, and what the spec said before ---- */
  const out = document.getElementById('chResult').innerHTML;
  if (out.indexOf('CH-01') < 0) bad.push('the result does not name the change');
  if (out.indexOf('login-page') < 0) bad.push('the result does not say which feature');
  if (out.indexOf('A form posting to /login.') < 0)
    bad.push('the result does not show what the design said before');
  if (out.indexOf('2026-11-01T12:00:00.000Z') < 0)
    bad.push('the result does not say when it was modified');
  if (out.indexOf('ch.') >= 0) bad.push('a raw i18n key reached the result');
  /* The mask is for the wait. Left up, it would cover the answer. */
  if (document.getElementById('chMask').style.display !== 'none')
    bad.push('the mask is still covering the result');
  if (document.getElementById('chLog').style.display === 'none')
    bad.push('nothing shows the work while it continues');

  /* ---- closing does not stop it ---- */
  globalThis.__cleared.length = 0;
  closeChangeDialog();
  if (globalThis.__cleared.length > 0)
    bad.push('closing dismissed the watcher');
  if (document.getElementById('actDock').style.display === 'none')
    bad.push('nothing on screen still shows work running');

  /* ---- where it cannot tell, it asks and writes nothing ---- */
  openChangeDialog();
  document.getElementById('chText').value = 'registered user';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('/api/change/apply') >= 0) {
      applied.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({
        needsChoice: true, text: 'registered user', root: ROOT,
        candidates: [{ slug: 'login', score: 4, reasons: ['registered', 'user'] },
                     { slug: 'session', score: 4, reasons: ['registered', 'user'] }],
        askPrompt: 'choose one, or answer none'
      }) };
    }
    return realFetch(url, opts);
  };
  await submitChange();

  const found = document.getElementById('chFound').innerHTML;
  if (found.indexOf('login') < 0 || found.indexOf('session') < 0)
    bad.push('both candidates are not offered');
  if (found.indexOf('data-pick=') < 0) bad.push('a candidate cannot be chosen');
  /* Nothing was filed: saying "it could not tell" and then filing anyway would
   * be the worst of both. */
  if (document.getElementById('chResult').innerHTML !== '')
    bad.push('it wrote a result despite saying it could not tell');
  if (document.getElementById('chMask').style.display !== 'none')
    bad.push('the mask stayed up after it gave up');

  /* ---- choosing one sends that choice, and that alone ---- */
  const before = applied.length;
  /* The click itself cannot be exercised by this shim — its querySelectorAll
   * returns nothing, so no handler is ever attached. What is observable is that
   * each candidate is rendered with its slug as the thing to send, and that
   * sending that slug is what reaches the server. */
  if (found.indexOf('data-pick="session"') < 0)
    bad.push('the second candidate carries no slug to send');
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('/api/change/apply') >= 0) {
      applied.push(JSON.parse(opts.body));
      return hold(Object.assign({}, APPLY_OK, { feature: 'session' }));
    }
    return realFetch(url, opts);
  };
  await submitChange('session');
  if (applied.length !== before + 1) bad.push('picking sent no request');
  else if (applied[applied.length - 1].feature !== 'session')
    bad.push('picking did not send the chosen feature: ' +
      JSON.stringify(applied[applied.length - 1]));

  /* ---- a change routed out says where it went ----
   *
   * The one that is easiest to lose: the change is filed on one feature and the
   * work lands in another. Without a line naming the child, the record looks
   * like the change was filed and then dropped. */
  openChangeDialog();
  document.getElementById('chProj').value = Object.keys(PROJECTS)[0] || '';
  document.getElementById('chText').value = 'make the login page support passkeys';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('/api/change/apply') >= 0) {
      applied.push(JSON.parse(opts.body));
      return hold(Object.assign({}, APPLY_OK, { child: 'passkey-login' }));
    }
    return realFetch(url, opts);
  };
  await submitChange();
  if (document.getElementById('chResult').innerHTML.indexOf('passkey-login') < 0)
    bad.push('it does not say the change was routed to a new feature');

  globalThis.fetch = realFetch;
  closeChangeDialog();

  if (bad.length) {
    console.error('FAIL (change from a sentence)');
    for (const p2 of bad) console.error('  - ' + p2);
    process.exit(1);
  }
  console.log('  ok   a sentence is routed to a feature, and the spec keeps what it said before');
} catch (e) {
  console.error('FAIL (change from a sentence) threw: ' + e.message + '\n    ' +
    (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  process.exit(1);
}

/* ---- skill packs ----
 *
 * The claim the packs were built for: a slot names a job, so a skill that does a
 * different job cannot fill it. Three things are asserted, because each one fails
 * separately — the page shows the gap, it offers only equivalents the server
 * would accept, and a refusal says why instead of only saying no.
 */
try {
  const bad = [];
  const FOUNDATION = {
    slot: 'design.foundation', layer: 1, required: true, skill: 'hig-foundations',
    status: 'match', substituted: false, reasons: ['it names the HIG (in its own description)'],
    rejected: [], source: { repo: 'raintree-technology/hig-doctor', expect: ['hig-foundations'] },
    unresolved: null, alternatives: ['hig-foundations']
  };
  /* The quality gate has no upstream. It is the honest gap the interface has to
   * be able to show without dressing it up as fine. */
  const GATE = {
    slot: 'design.gate', layer: 4, required: true, skill: null,
    status: 'unresolved', substituted: false, reasons: [], rejected: [], source: null,
    unresolved: 'no Microsoft frontend design-review skill was found on GitHub',
    alternatives: []
  };
  const AUDIT = {
    slot: 'devops.audit', layer: 6, required: true, skill: 'agentic-actions-auditor',
    status: 'match', substituted: false,
    reasons: ['it audits GitHub Actions', 'it audits security'],
    rejected: [], source: { repo: 'trailofbits/skills', expect: ['agentic-actions-auditor'] },
    unresolved: null, alternatives: ['agentic-actions-auditor']
  };
  /* A slot whose upstream exists but which is not installed, with no equivalent
   * on the machine. It must offer Install and say why the picker is empty —
   * rather than showing a dead control. */
  const WORKFLOWS = {
    slot: 'devops.workflows', layer: 1, required: true, skill: null,
    status: 'missing', substituted: false, reasons: [], rejected: [],
    source: { repo: 'example/actions-author', expect: ['github-actions-author'] },
    unresolved: null, alternatives: []
  };
  const FIXTURE_PACKS = {
    skillsRoot: '/skills',
    needsSetup: true,
    installed: ['agentic-actions-auditor', 'hig-foundations', 'research'],
    packs: [
      { id: 'design-stack', title: 'Design', enabled: true, ready: false,
        required: 5, satisfied: 1, entries: [FOUNDATION, GATE] },
      { id: 'devops-suite', title: 'DevOps', enabled: true, ready: false,
        required: 6, satisfied: 1, entries: [WORKFLOWS, AUDIT] }
    ]
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const ok = (v) => ({ ok: true, status: 200, json: async () => v });
    /* Order matters: the substitute path contains the list path. */
    if (u.indexOf('/api/skills/packs/substitute') >= 0) {
      const sent = JSON.parse(opts.body);
      if (sent.skill === 'agentic-actions-auditor') {
        return { ok: false, status: 409, json: async () => ({
          error: '"agentic-actions-auditor" does not do the job of design.gate',
          rejected: ['it is about GitHub Actions workflows'],
          candidates: []
        }) };
      }
      FIXTURE_PACKS.packs[0].entries[1] = Object.assign({}, GATE, {
        skill: sent.skill, status: 'substituted', substituted: true,
        alternatives: [sent.skill]
      });
      return ok({ file: '/tmp/s.json', slot: null,
        skillPacks: [{ id: 'design-stack', enabled: true,
                       substitutions: { 'design.gate': sent.skill } }],
        packs: FIXTURE_PACKS.packs });
    }
    if (u.indexOf('/api/skills/packs') >= 0) return ok(FIXTURE_PACKS);
    return realFetch(url, opts);
  };

  PACKS = await API.skillPacks();
  openSettings('skills');
  const html = (globalThis.__cache['setMain'] || {}).innerHTML || '';

  if (html.indexOf(I18N.t('pack.title.design-stack')) < 0)
    bad.push('the design stack is not on the skills page');
  if (html.indexOf(I18N.t('pack.title.devops-suite')) < 0)
    bad.push('the devops suite is not on the skills page');
  if (html.indexOf(I18N.t('pack.role.design.gate')) < 0)
    bad.push('a slot was rendered without its role');
  if (html.indexOf('agentic-actions-auditor') < 0)
    bad.push('the audit slot did not name the skill filling it');
  if (html.indexOf(I18N.t('pack.state.match')) < 0)
    bad.push('a filled slot was not marked as filled');
  if (html.indexOf(I18N.t('pack.state.unresolved')) < 0)
    bad.push('a slot with no upstream was not shown as such');
  if (html.indexOf('no Microsoft frontend design-review skill') < 0)
    bad.push('the reason a slot is unfilled was not rendered');
  /* The picker may only offer what the checker accepts, and a picker with
   * nothing to offer is not drawn at all — a disabled control that can never be
   * enabled reads as a bug. */
  if (!/data-packslot="design\.foundation"/.test(html))
    bad.push('a slot with an equivalent in it rendered no picker');
  if (/data-packslot="design\.gate"/.test(html))
    bad.push('a drawable picker was rendered for a slot with no equivalent');
  /* A gap with an upstream still asks to be filled, and says why the picker is
   * empty rather than leaving the cell blank. */
  if (!/data-packinstall="devops\.workflows"/.test(html))
    bad.push('a slot with an upstream but no skill offered no Install action');
  if (html.indexOf(I18N.t('pack.noEquivalent')) < 0)
    bad.push('an empty substitution list explained nothing');
  const raw = html.match(/\bpack\.(?:role|state|title|count)\.[a-zA-Z.-]+/);
  if (raw) bad.push('a raw i18n key reached the settings page: ' + raw[0]);

  /* The refusal itself. It must reach the user as a sentence about GitHub
   * Actions, not as "409" or as a silent no-op. */
  await substituteSlot('design-stack', 'design.gate', 'agentic-actions-auditor');
  const said = document.getElementById('toast').textContent || '';
  if (said.indexOf('does not do the job') < 0)
    bad.push('the refusal did not say what was wrong: ' + said);
  if (said.indexOf('GitHub Actions') < 0)
    bad.push('the refusal did not say why: ' + said);

  /* And an accepted one shows as substituted on the next render. */
  await substituteSlot('design-stack', 'design.gate', 'hig-foundations');
  const after = (globalThis.__cache['setMain'] || {}).innerHTML || '';
  if (after.indexOf(I18N.t('pack.state.substituted')) < 0)
    bad.push('an accepted substitution did not render as substituted');
  if (after.indexOf('hig-foundations') < 0)
    bad.push('the substituted skill was not named');

  /* The page answers "what do I have" before "what is missing": the skill list
   * comes first, the packs after it. */
  const LBL = API.STAGE_LABEL;
  const at = (s) => html.indexOf(s);
  if (at(I18N.t('set.skills.pool')) < 0)
    bad.push('the installed-but-unbound skills were not listed');
  if (at(I18N.t('set.skills.pool')) > at(I18N.t('pack.title.design-stack')))
    bad.push('the skill list did not come before the packs');

  /* Grouped in the order the work happens, not in whatever order the settings
   * file happens to hold. */
  const order = ['intake', 'ask', 'spec', 'design', 'split', 'develop', 'review', 'ship', 'retro'];
  let prev = -1;
  for (const st of order) {
    /* Match the heading row itself, not the bare word: "Design foundation" in a
     * pack table also contains "Design", and matching that would make this
     * assertion pass for the wrong reason — or fail for one. */
    const marker = 'class="grp"><td colspan="3">' + LBL[st].en;
    const i = at(marker);
    if (i < 0) { bad.push('stage heading missing from the skill list: ' + st); break; }
    if (i < prev) { bad.push('stage headings are out of SDLC order at ' + st); break; }
    prev = i;
  }

  /* The nine in the chain are the framework's presets and are marked as such. */
  if (at(I18N.t('set.skills.preset')) < 0)
    bad.push('a stage-bound skill was not marked as a preset');
  /* The release stage has no skill; that is a gap the page must show rather than
   * a switch it silently disables. */
  if (at(I18N.t('set.skills.manual')) < 0)
    bad.push('a stage with no skill explained nothing');

  /* Everything installed is visible. A skill filling a pack slot is not
   * unbound — it belongs to the stage its pack answers to, and it must not be
   * listed twice. Only what no stage and no pack owns stays in this list, with
   * the real count beside it. */
  const poolAt = at(I18N.t('set.skills.pool'));
  const packsAt = at(I18N.t('pack.title.design-stack'));
  const between = html.slice(poolAt < 0 ? 0 : poolAt, packsAt < 0 ? html.length : packsAt);
  if (between.indexOf('research') < 0)
    bad.push('an installed skill outside every stage and pack was dropped');
  if (between.indexOf('hig-foundations') >= 0 || between.indexOf('agentic-actions-auditor') >= 0)
    bad.push('a pack-bound skill was also listed as unbound');
  if (!/>1</.test(html.slice(poolAt, poolAt + 200)))
    bad.push('the unbound group did not carry its count');

  /* Pack skills surface under the stage their pack answers to: the design slots
   * under Design, the CI/CD slots under Release. */
  const shipAt = at('class="grp"><td colspan="3">' + LBL.ship.en);
  const designAt = at('class="grp"><td colspan="3">' + LBL.design.en);
  if (designAt < 0 || html.slice(designAt, shipAt).indexOf(I18N.t('pack.role.design.foundation')) < 0)
    bad.push('the design pack skills did not show under the design stage');
  if (shipAt < 0 || html.slice(shipAt, poolAt).indexOf(I18N.t('pack.role.devops.audit')) < 0)
    bad.push('the CI/CD pack skills did not show under the release stage');

  /* The substitution picker is styled like the rest of the form, not the OS
   * control. */
  if (!/class="psel"/.test(html))
    bad.push('the substitution picker did not use the styled select');

  globalThis.fetch = realFetch;

  if (bad.length) {
    console.error('FAIL (skill packs)');
    for (const p of bad) console.error('  - ' + p);
    console.error('html: ' + html.slice(0, 600));
    process.exit(1);
  }
  console.log('  ok   packs show their gaps, offer only equivalents, and refuse the wrong skill');
} catch (e) {
  console.error('FAIL (skill packs) threw: ' + e.message + '\n    ' +
    (e.stack || '').split('\n').slice(1, 4).join('\n    '));
  process.exit(1);
}

console.log('OK  projects=' + rep.projects +
  ' main=' + rep.main.length + ' chars' +
  ' sidebar=' + rep.sidebar.length + ' chars' +
  ' wizard+settings+init all reachable');
process.exit(0);
"""


def find_node() -> str:
    for c in NODE_CANDIDATES:
        if c == 'node' or os.path.exists(c):
            return c
    return 'node'


def main() -> int:
    with io.open(PAGE, encoding='utf-8') as f:
        html = f.read()

    # The dossier column scrolls its body, not itself: the "Stage dossier"
    # header stays put while the record scrolls under it. This is CSS, so it is
    # checked against the page here rather than through the DOM shim.
    for needle in (
        '.cbody.piped>.split>div:not(.card){overflow:hidden',
        '.cbody.piped>.split>div:not(.card)>.card>.bd{flex:1;min-height:0;overflow-y:auto}',
    ):
        if needle not in html:
            print('FAIL: the dossier scroll rule is missing: ' + needle)
            return 1

    # Finishing the new-project flow must select the feature it just created,
    # before the re-scan builds the view model. Wiping the selection there made
    # the board fall back to "whatever feature is first" — which is exactly the
    # report of a project that exists on disk but is not visible on the page.
    flow_open = re.search(r'async function flowOpenProject\(\)\{.*?\n\}', html, re.S)
    if flow_open is None:
        print('FAIL: flowOpenProject is missing')
        return 1
    block = flow_open.group(0)
    if 'setSelection(key,feature)' not in block:
        print('FAIL: flowOpenProject does not select the feature it created')
        return 1
    if 'FEATURE_SEL={}' in block:
        print('FAIL: flowOpenProject wipes the feature selection')
        return 1
    if block.index('setSelection(key,feature)') > block.index('await boot(true)'):
        print('FAIL: flowOpenProject selects the feature after re-scanning, so the view model cannot see it')
        return 1

    blocks = re.findall(r'<script type="module">(.*?)</script>', html, re.S)
    if not blocks:
        print('FAIL: no module script in web/index.html')
        return 1
    module = blocks[-1]

    # The page imports the adapter; the harness inlines it instead so the whole
    # thing is one file with one resolution rule.
    if "from './api.js'" not in module:
        print('FAIL: the module does not import ./api.js')
        return 1
    with io.open(os.path.join(ROOT, 'web', 'api.js'), encoding='utf-8') as f:
        adapter = f.read()
    with io.open(os.path.join(ROOT, 'web', 'session.js'), encoding='utf-8') as f:
        flow_src = f.read()

    def as_namespace(source: str, name: str) -> str:
        """Wrap an ES module as a namespace binding.

        Stripping `export` and rewriting `API.x` to `x` looks simpler and is
        wrong: a bare name in the page can then collide with a helper of the same
        name, and the resulting "already declared" error points at the page rather
        than at the harness. A namespace object keeps the names apart, which is
        what the browser does anyway.
        """
        names = set(re.findall(r'export\s+(?:async\s+)?function\s+(\w+)', source))
        names |= set(re.findall(r'export\s+(?:const|let|var)\s+(\w+)', source))
        # `export { A, B };` is how a module re-exports names it declared plainly.
        # Missing this left the namespace short of exactly those names, and the
        # failure surfaced far away as "cannot read properties of undefined".
        for group in re.findall(r'export\s*\{([^}]*)\}\s*;?', source):
            for piece in group.split(','):
                # Careful: this must not be called `name`. Shadowing the
                # parameter renamed the wrapper after the last exported symbol,
                # so `const __API_NS = ...` became `const STAGE_LABEL = ...` and
                # the namespace the page refers to was never declared.
                exported = piece.strip().split(' as ')[-1].strip()
                if re.fullmatch(r'\w+', exported):
                    names.add(exported)
        body = re.sub(r'export\s*\{[^}]*\}\s*;?', '', source).replace('export ', '')
        names = sorted(names)
        return (
            f'const {name} = (() => {{\n' + body + '\nreturn { ' +
            ', '.join(names) + ' };\n})();'
        )

    module = module.replace(
        "import * as API from './api.js';", as_namespace(adapter, '__API_NS'))
    module = module.replace(
        "import * as FLOW from './session.js';", as_namespace(flow_src, '__FLOW_NS'))
    # The page uses the imported names; bind them to the namespaces.
    module = module.replace('API.', '__API_NS.')
    module = module.replace('FLOW.', '__FLOW_NS.')
    global _ns_alias
    _ns_alias = (as_namespace(adapter, '__API_NS'), as_namespace(flow_src, '__FLOW_NS'))

    i18n_path = os.path.join(ROOT, 'web', 'i18n.js')
    with io.open(i18n_path, encoding='utf-8') as f:
        i18n = f.read()

    # The whole page's markup, so static handlers are checked too.
    static_markup = json.dumps(html)

    harness = '\n'.join([
        'const STATIC_MARKUP = ' + static_markup + ';',
        # The UMD wrapper assigns globalThis.GovernanceI18n itself, which is how
        # the page reaches it. Its `module.exports` branch is neutralised with a
        # no-op rather than deleted: deleting the statement would leave the `if`
        # to swallow the next one, and the global would never be set.
        i18n.replace('module.exports = mod;', 'void mod;'),
        'const FIXTURE = ' + FIXTURE.strip() + ';',
        SHIM,
        module,
        # The assertions are written the way the page is, with `API.` and `FLOW.`,
        # so they get the same aliasing. Missing this made them reference a bare
        # `FLOW` that does not exist in the harness.
        ASSERTIONS.replace('API.', '__API_NS.').replace('FLOW.', '__FLOW_NS.'),
    ])

    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'boot.mjs')
        with io.open(out, 'w', encoding='utf-8') as f:
            f.write(harness)
        keep = os.environ.get('KEEP_HARNESS')
        if keep:
            out = os.path.join(ROOT, keep)
            with io.open(out, 'w', encoding='utf-8') as f:
                f.write(harness)
        proc = subprocess.run([find_node(), out], cwd=ROOT,
                              capture_output=True, text=True, encoding='utf-8')
        sys.stdout.write(proc.stdout)
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        return proc.returncode


if __name__ == '__main__':
    sys.exit(main())
