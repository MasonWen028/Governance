import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { autoAcceptableIds, classifyChange } from '../src/tracker/triage.js';
import type { AcceptableChange } from '../src/tracker/triage.js';
import { branchName, composePullRequest } from '../src/tracker/pr.js';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import type { ChangeRecord } from '../src/tracker/journal.js';
import type { Dossier } from '../src/tracker/dossier.js';

/* Two things worth holding down: what the integration artifact says, and who
 * gets to accept a change when nobody is watching.
 *
 * The PR body is the last thing a reviewer reads before merging, and it is easy
 * for it to become prose that asserts things. These tests assert it *traces* —
 * to a ticket, a decision, a run — because that is the only property it has.
 */

const GIT = DEFAULT_SETTINGS.git;

function change(id: string, over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id, text: 'a change', openedAt: '2026-10-31T00:00:00.000Z',
    status: 'open', closedAt: null, note: null, outcome: null, followedUpBy: null,
    verdict: null,
    ...over,
  };
}

/* A dossier reduced to the parts the composer reads. Built here rather than read
 * from disk: what is under test is the composition, not the scan. */
function dossier(): Dossier {
  return {
    featureDir: '/x/.scratch/e', workspaceRoot: '/x',
    idea: null, ideaSource: null, destination: 'A page that says hello.',
    notes: [], conjectures: { decisions: [], notYetSpecified: [], outOfScope: [] },
    rounds: [], answeredRounds: 0,
    glossary: { exists: true, path: 'GLOSSARY.md', at: null },
    adrs: [{ file: 'docs/adr/0001-use-local-only.md', title: 'local only', at: null }],
    spec: { exists: true, path: 'spec.md', sections: ['Solution'] },
    tickets: [
      { id: 'T-01', slug: 't-01', title: 'greeting', type: 'task', status: 'resolved',
        blockedBy: [], what: 'Show Hello, World! centred', at: null, file: 'issues/01.md' },
      { id: 'T-02', slug: 't-02', title: 'time', type: 'task', status: 'frontier',
        blockedBy: [], what: 'Show the clock', at: null, file: 'issues/02.md' },
    ],
    runs: [{ jobId: 'j', root: '/x', feature: 'e', stage: 'develop', skill: 'implement',
      status: 'succeeded', startedAt: '', endedAt: '', exitCode: 0, error: null, ms: 1200, demo: false }],
    gates: [{ id: 'G-1', title: 'accept', stage: 'ship', owner: 'po', blocking: true, raisedBy: 'assess',
      decisions: [{ ts: '2026-10-31T00:00:00.000Z', gate: 'G-1', outcome: 'pass', actor: 'po',
        methods: ['signoff'], evidence: [] }] }],
    review: { exists: true, path: 'review.md', title: 'review' },
    release: { exists: true, path: 'release.md' },
    retro: { exists: false, path: null },
    logs: [], changes: [], journal: [], timeline: [], warnings: [],
  } as unknown as Dossier;
}

/* ------------------------------------------------------------ branch names */

test('a branch template resolves against the feature, never onto bindings', () => {
  assert.equal(branchName('feat/{ticket}', { project: 'p', feature: 'e', ticket: 'T-01' }), 'feat/T-01');
  assert.equal(branchName('agent/{feature}', { project: 'p', feature: 'hello-world' }), 'agent/hello-world');
  assert.equal(branchName('agent/{slug}', { project: 'p', feature: 'hello-world' }), 'agent/hello-world');
  assert.equal(branchName('ci/{project}', { project: 'my repo', feature: 'e' }), 'ci/my-repo');
});

test('a template that would not be a valid git ref is repaired rather than rejected later', () => {
  /* `git push` discovering this is the worst possible time for it. */
  assert.equal(branchName('feat/{ticket}', { project: 'p', feature: 'e', ticket: 'my ticket' }), 'feat/my-ticket');
  assert.equal(branchName('feat/{ticket}', { project: 'p', feature: 'e' }), 'feat/e', 'no ticket falls back to the feature, not to an empty name');
  assert.equal(branchName('feat/{{ticket}}', { project: 'p', feature: 'e' }), 'feat/e');
  assert.equal(branchName('feat/../{feature}', { project: 'p', feature: 'e' }), 'feat/e', 'no traversal survives');
  assert.equal(branchName('  ', { project: 'p', feature: 'e' }), 'e', 'never empty');
});

/* --------------------------------------------------------- the PR itself */

test('the body traces to tickets, decisions and runs — nothing is asserted freehand', () => {
  const pr = composePullRequest({
    dossier: dossier(), project: 'widget', feature: 'e', git: GIT, derivedFrom: null,
  });
  assert.match(pr.body, /## What this delivers/);
  assert.match(pr.body, /A page that says hello\./);
  assert.match(pr.body, /`T-01`/, 'the resolved ticket is named');
  assert.match(pr.body, /`T-02` \(frontier\)/, 'so is the one that is not done');
  assert.match(pr.body, /\*\*G-1\*\* pass by `po` · signoff/, 'gate decisions travel with the body');
  assert.match(pr.body, /\| develop \| implement \| succeeded \| 1200 \|/, 'so do the runs');
  assert.match(pr.body, /`release\.md`/);
  assert.match(pr.body, /docs\/adr\/0001-use-local-only\.md/);
  assert.equal(pr.draft, GIT.draftPr);
});

test('a derived feature says which change made it exist', () => {
  const pr = composePullRequest({
    dossier: dossier(), project: 'widget', feature: 'html-hello-world-ch-02', git: GIT,
    derivedFrom: { parent: 'html-hello-world', change: 'CH-02', text: 'also add a new page that shows the current time' },
  });
  assert.match(pr.title, /^CH-02: also add a new page/);
  assert.match(pr.body, /Change `CH-02` filed against `html-hello-world`/);
  assert.match(pr.body, /also add a new page that shows the current time/);
  /* The branch carries the feature, so two features derived from one parent never
   * share a name — and a `{ticket}` in the template stays silent rather than
   * naming one slice out of several. */
  assert.equal(pr.branch, 'feat/html-hello-world-ch-02');
});

test('an open change blocks the merge right there in the body', () => {
  const d = { ...dossier(), changes: [change('CH-03', { verdict: classifyChange({ text: 'the footer should say 2026', accepted: false }) })] };
  const pr = composePullRequest({ dossier: d, project: 'widget', feature: 'e', git: GIT, derivedFrom: null });
  assert.match(pr.body, /## Not done/);
  assert.match(pr.body, /1 change request\(s\) are still open/);
});

/* -------------------------------------------- accepting changes unattended */

test('AFK may accept what it answered, and nothing else', () => {
  const before = '2026-10-31T10:00:00.000Z';
  const during = '2026-10-31T11:00:00.000Z';
  const accepted = classifyChange({ text: 'the footer should say 2026', accepted: false });
  const routedOut = classifyChange({ text: 'rewrite the API layer', accepted: false });

  const changes: AcceptableChange[] = [
    { id: 'CH-01', openedAt: before, status: 'open', verdict: accepted },
    { id: 'CH-02', openedAt: during, status: 'open', verdict: accepted },   // filed mid-run
    { id: 'CH-03', openedAt: before, status: 'open', verdict: routedOut },  // went elsewhere
    { id: 'CH-04', openedAt: before, status: 'open', verdict: null },       // never routed
    { id: 'CH-05', openedAt: before, status: 'closed', verdict: accepted }, // already done
  ];

  /* A change opened in the same millisecond the run started is genuinely
   * ambiguous, so the boundary is strict: to be answerable it must predate the
   * run, not merely not postdate it. */
  const started = '2026-10-31T10:30:00.000Z';
  assert.deepEqual(autoAcceptableIds(changes, started), ['CH-01']);
  /* Each refusal is for a different reason, and none of them is "maybe". */
  for (const id of ['CH-02', 'CH-03', 'CH-04', 'CH-05']) {
    assert.ok(!autoAcceptableIds(changes, started).includes(id), `${id} must not be accepted`);
  }
  assert.deepEqual(
    autoAcceptableIds([changes[0]!], before),
    [],
    'a change opened at the instant the run started was not in the prompt',
  );
});
