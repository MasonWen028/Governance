import { strict as assert } from 'node:assert';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import type { Settings } from '../src/config/settings.js';
import { JobRegistry, JobError } from '../src/exec/jobs.js';
import { makeDecision } from '../src/tracker/decisions.js';
import { readJournal } from '../src/tracker/journal.js';
import type { JournalEvent } from '../src/tracker/journal.js';
import type { Feature, Gate, StageId, StageState } from '../src/domain/types.js';

/* The registry is the control plane's state machine: one run per feature, a
 * concurrency cap, a timeout it owns, a record on disk for every run, and —
 * since P3 — admission before the spawn and an audit after it. Every test
 * drives a stub through `runStageOptions`: nothing here spawns a real CLI or
 * spends anything.
 *
 * The layout matters: a feature lives at `<root>/.scratch/<slug>/` and policy
 * refuses anything else, so these tests build the real shape rather than a
 * convenient one. */

function stages(partial: Partial<Record<StageId, StageState>>): Record<StageId, StageState> {
  const all: Record<StageId, StageState> = {
    intake: 'absent', ask: 'absent', spec: 'absent', design: 'absent',
    split: 'absent', develop: 'absent', review: 'absent', ship: 'absent', retro: 'absent',
  };
  return { ...all, ...partial };
}

function feature(featureDir: string, slug = 'the-feature', gates: readonly Gate[] = []): Feature {
  return {
    slug,
    root: featureDir,
    kind: 'build',
    destination: 'a thing',
    notes: [],
    decisionsSoFar: [],
    notYetSpecified: [],
    outOfScope: [],
    tickets: [],
    gates,
    stages: stages({
      intake: 'complete', ask: 'complete', spec: 'complete', design: 'active',
    }),
    warnings: [],
  };
}

function settingsWith(skills: { stage: string; enabled: boolean }[]): Settings {
  return {
    ...DEFAULT_SETTINGS,
    skills: DEFAULT_SETTINGS.skills.map((s) => {
      const hit = skills.find((x) => x.stage === s.stage);
      return hit ? { ...s, enabled: hit.enabled } : s;
    }),
  };
}

const SLOW_STUB = {
  resolve: async () => ({
    command: process.execPath,
    args: ['-e', `setTimeout(() => {}, 8000)`],
    how: 'stub (slow)',
  }),
};

const QUICK_STUB = {
  resolve: async () => ({
    command: process.execPath,
    args: ['-e', `console.log('stub ran')`],
    how: 'stub (quick)',
  }),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* A killed child can hold its cwd for a beat after 'close' on Windows; retry
 * the cleanup instead of racing it. */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 5 || !(err as NodeJS.ErrnoException).code?.startsWith('E')) throw err;
      await sleep(100);
    }
  }
}

/** A workspace with one feature in it, laid out the way the scanner expects. */
async function workspace(prefix: string): Promise<{ root: string; featureDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const featureDir = join(root, '.scratch', 'the-feature');
  await mkdir(featureDir, { recursive: true });
  return { root, featureDir };
}

/** Poll the registry until the job leaves `running` (or the deadline passes). */
async function settled(reg: JobRegistry, jobId: string, deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const view = reg.get(jobId);
    if (view === null || view.status !== 'running') return view;
    if (Date.now() > until) return view;
    await sleep(25);
  }
}

/** Poll for the *terminal* record: the `running` one lands first, by design. */
async function recordWritten(
  dir: string,
  jobId: string,
  deadlineMs = 5000,
): Promise<Record<string, unknown>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const raw = await readFile(join(dir, 'runs', `${jobId}.json`), 'utf8').catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed['status'] !== 'running') return parsed;
      } catch {
        /* caught it mid-write; read again */
      }
    }
    if (Date.now() > until) throw new Error(`run record never settled: ${jobId}`);
    await sleep(25);
  }
}

const gate = (id: string, stage: StageId, blocking = true): Gate => ({
  id,
  title: `${stage} signed off`,
  stage,
  scope: { kind: 'stage', ref: stage },
  owner: 'tech',
  methods: ['self'],
  blocking,
  onFail: 'rework',
  raisedBy: 'manual',
});

/* --------------------------------------------------------------- admission */

test('submit: the run finishes succeeded and the record says so on disk', async () => {
  const { root, featureDir } = await workspace('gov-jobs-ok-');
  try {
    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    const { jobId, plan } = await reg.submit({
      root,
      featureDir,
      feature: feature(featureDir),
      settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills',
      maxParallel: 2,
      timeoutMs: 30000,
    });
    assert.equal(plan.stage, 'design');
    assert.equal(plan.skill, 'codebase-design');

    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'succeeded');
    assert.equal(view?.exitCode, 0);
    assert.equal(view?.demo, false);
    /* No git in a temp directory: "could not check" is reported as null,
     * never as a clean bill of health. */
    assert.equal(view?.audit?.outsideWrites, null);
    assert.equal(view?.audit?.tampered, false);

    const record = await recordWritten(featureDir, jobId);
    assert.equal(record['status'], 'succeeded');
    assert.equal(record['demo'], false);
    assert.equal(record['stage'], 'design');
    assert.equal((record['audit'] as Record<string, unknown>)['tampered'], false);
  } finally {
    await rmRetry(root);
  }
});

test('admission: a blocking gate behind the operating stage refuses the run', async () => {
  const { root, featureDir } = await workspace('gov-jobs-gate-');
  try {
    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    /* design is the operating stage; a gate on `spec` is behind it and open. */
    await assert.rejects(
      reg.submit({
        root,
        featureDir,
        feature: feature(featureDir, 'the-feature', [gate('g-spec', 'spec')]),
        settings: DEFAULT_SETTINGS,
        skillsRoot: '/skills',
        maxParallel: 4,
        timeoutMs: 30000,
      }),
      (err: unknown) =>
        err instanceof JobError &&
        err.status === 409 &&
        /g-spec/.test(err.message) &&
        err.gates.length === 1 &&
        err.gates[0]?.id === 'g-spec',
    );
  } finally {
    await rmRetry(root);
  }
});

test('admission: a gate on the operating stage refuses the run — "blocked" means blocked', async () => {
  const { root, featureDir } = await workspace('gov-jobs-gate-here-');
  try {
    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    /* `deriveStages` marks the stage `blocked` for exactly this reason, and the
     * board displays it. A tile that says "blocked" next to a button that spends
     * money is the contradiction this check removes. */
    await assert.rejects(
      reg.submit({
        root,
        featureDir,
        feature: feature(featureDir, 'the-feature', [gate('g-design', 'design')]),
        settings: DEFAULT_SETTINGS,
        skillsRoot: '/skills',
        maxParallel: 4,
        timeoutMs: 30000,
      }),
      (err: unknown) =>
        err instanceof JobError && err.status === 409 && /g-design/.test(err.message),
    );
  } finally {
    await rmRetry(root);
  }
});

test('admission: a gate ahead of the operating stage does not block, and a failed one never does', async () => {
  const { root, featureDir } = await workspace('gov-jobs-gate-ahead-');
  try {
    /* `fail` is the human saying "not good enough, redo it". If a failed gate
     * blocked the re-run, the only way forward would be an override — which is
     * how a governance system teaches people to route around itself. */
    const failed = makeDecision({
      gate: 'g-design',
      outcome: 'fail',
      actor: 'tech',
      methods: ['self'],
      note: 'the interface is not settled',
    });
    await appendFile(join(featureDir, 'decisions.jsonl'), `${JSON.stringify(failed)}\n`, 'utf8');

    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    const { jobId } = await reg.submit({
      root,
      featureDir,
      feature: feature(featureDir, 'the-feature', [
        gate('g-design', 'design'),
        gate('g-review', 'review'),
      ]),
      settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills',
      maxParallel: 4,
      timeoutMs: 30000,
    });
    assert.equal((await settled(reg, jobId))?.status, 'succeeded');
  } finally {
    await rmRetry(root);
  }
});

test('admission: a decided gate no longer blocks, and a non-blocking one never does', async () => {
  const { root, featureDir } = await workspace('gov-jobs-gate-passed-');
  try {
    const decision = makeDecision({
      gate: 'g-spec',
      outcome: 'pass',
      actor: 'tech',
      methods: ['self'],
      evidence: ['spec.md reviewed'],
    });
    await appendFile(join(featureDir, 'decisions.jsonl'), `${JSON.stringify(decision)}\n`, 'utf8');

    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    const { jobId } = await reg.submit({
      root,
      featureDir,
      feature: feature(featureDir, 'the-feature', [
        gate('g-spec', 'spec'),
        gate('g-intake', 'intake', false),
      ]),
      settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills',
      maxParallel: 4,
      timeoutMs: 30000,
    });
    assert.equal((await settled(reg, jobId))?.status, 'succeeded');
  } finally {
    await rmRetry(root);
  }
});

test('admission: a plan that would write outside the feature is refused', async () => {
  const { root } = await workspace('gov-jobs-bounds-');
  try {
    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    /* Not `<root>/.scratch/the-feature` — the plan's log would land somewhere
     * the feature does not own. */
    const elsewhere = join(root, 'somewhere-else');
    await mkdir(elsewhere, { recursive: true });
    await assert.rejects(
      reg.submit({
        root,
        featureDir: elsewhere,
        feature: feature(elsewhere),
        settings: DEFAULT_SETTINGS,
        skillsRoot: '/skills',
        maxParallel: 4,
        timeoutMs: 30000,
      }),
      (err: unknown) =>
        err instanceof JobError && err.status === 403 && /outside its slot/.test(err.message),
    );
  } finally {
    await rmRetry(root);
  }
});

/* ------------------------------------------------------------------- audit */

test('audit: a run that appends to the decision log is marked tampered', async () => {
  const { root, featureDir } = await workspace('gov-jobs-tamper-');
  try {
    /* The stub stands in for an agent that approves its own gate. */
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      gate: 'g-review',
      outcome: 'pass',
      actor: 'tech',
      methods: ['self'],
      evidence: ['trust me'],
    })}\n`;
    const selfApproving = {
      resolve: async () => ({
        command: process.execPath,
        args: [
          '-e',
          `require('node:fs').appendFileSync(${JSON.stringify(join(featureDir, 'decisions.jsonl'))}, ${JSON.stringify(line)})`,
        ],
        how: 'stub (self-approving)',
      }),
    };
    const reg = new JobRegistry({ runStageOptions: selfApproving });
    const { jobId } = await reg.submit({
      root,
      featureDir,
      /* The gate is ahead of the operating stage, so admission lets the run
       * start — which is exactly the situation the audit exists for: the agent
       * then approves that gate itself, mid-run. */
      feature: feature(featureDir, 'the-feature', [gate('g-review', 'review')]),
      settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills',
      maxParallel: 4,
      timeoutMs: 30000,
    });
    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'succeeded');
    assert.equal(view?.audit?.decisionsChanged, true);
    assert.equal(view?.audit?.gatesChanged, false);
    assert.equal(view?.audit?.tampered, true);

    const record = await recordWritten(featureDir, jobId);
    assert.equal((record['audit'] as Record<string, unknown>)['tampered'], true);
  } finally {
    await rmRetry(root);
  }
});

/* ----------------------------------------------------------------- physics */

test('submit: a second run on the same feature is a 409, not a queue', async () => {
  const { root, featureDir } = await workspace('gov-jobs-dup-');
  try {
    const reg = new JobRegistry({ runStageOptions: SLOW_STUB });
    const first = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 4, timeoutMs: 30000,
    });
    await assert.rejects(
      reg.submit({
        root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
        skillsRoot: '/skills', maxParallel: 4, timeoutMs: 30000,
      }),
      (err: unknown) => err instanceof JobError && err.status === 409,
    );
    assert.ok(reg.cancel(first.jobId));
    /* The killed child still holds the temp dir for a beat on Windows;
     * wait for it to be gone before the cleanup rm. */
    await settled(reg, first.jobId);
  } finally {
    await rmRetry(root);
  }
});

test('submit: the concurrency cap is enforced across features', async () => {
  const a = await workspace('gov-jobs-cap-a-');
  const rootB = await mkdtemp(join(tmpdir(), 'gov-jobs-cap-b-'));
  const featureB = join(rootB, '.scratch', 'the-feature');
  await mkdir(featureB, { recursive: true });
  try {
    const reg = new JobRegistry({ runStageOptions: SLOW_STUB });
    const first = await reg.submit({
      root: a.root, featureDir: a.featureDir, feature: feature(a.featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 1, timeoutMs: 30000,
    });
    await assert.rejects(
      reg.submit({
        root: rootB, featureDir: featureB, feature: feature(featureB), settings: DEFAULT_SETTINGS,
        skillsRoot: '/skills', maxParallel: 1, timeoutMs: 30000,
      }),
      (err: unknown) => err instanceof JobError && err.status === 429,
    );
    assert.ok(reg.cancel(first.jobId));
    await settled(reg, first.jobId);
  } finally {
    await rmRetry(a.root);
    await rmRetry(rootB);
  }
});

test('cancel: a running job ends cancelled, on the record too', async () => {
  const { root, featureDir } = await workspace('gov-jobs-cancel-');
  try {
    const reg = new JobRegistry({ runStageOptions: SLOW_STUB });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 4, timeoutMs: 30000,
    });
    await sleep(150); /* let the child actually start */
    assert.equal(reg.cancel(jobId), true);

    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'cancelled');
    const record = await recordWritten(featureDir, jobId);
    assert.equal(record['status'], 'cancelled');
    /* Cancelling a finished job is not an error, it is a no-op returning false. */
    assert.equal(reg.cancel(jobId), false);
  } finally {
    await rmRetry(root);
  }
});

test('cancel: a cancel issued the instant after submit still stops the run', async () => {
  const { root, featureDir } = await workspace('gov-jobs-cancel-now-');
  try {
    const reg = new JobRegistry({ runStageOptions: SLOW_STUB });
    const started = Date.now();
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 4, timeoutMs: 30000,
    });
    /* No sleep: this lands in the gap between spawn() and the OS process —
     * the window where a naive kill is silently a no-op and the run (an
     * 8-second one here, a paid one in production) proceeds regardless. */
    assert.equal(reg.cancel(jobId), true);
    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'cancelled');
    assert.ok(Date.now() - started < 4000, `cancel took ${Date.now() - started}ms to bite`);
  } finally {
    await rmRetry(root);
  }
});

test('timeout: a run past its deadline ends timed_out', async () => {
  const { root, featureDir } = await workspace('gov-jobs-timeout-');
  try {
    const reg = new JobRegistry({ runStageOptions: SLOW_STUB });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 4, timeoutMs: 120,
    });
    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'timed_out');
    const record = await recordWritten(featureDir, jobId);
    assert.equal(record['status'], 'timed_out');
  } finally {
    await rmRetry(root);
  }
});

test('submit: a disabled skill is refused — the stage is a human gate', async () => {
  const { root, featureDir } = await workspace('gov-jobs-disabled-');
  try {
    const reg = new JobRegistry({ runStageOptions: QUICK_STUB });
    await assert.rejects(
      reg.submit({
        root, featureDir, feature: feature(featureDir),
        settings: settingsWith([{ stage: 'design', enabled: false }]),
        skillsRoot: '/skills', maxParallel: 4, timeoutMs: 30000,
      }),
      (err: unknown) => err instanceof JobError && err.status === 409 && /disabled/.test(err.message),
    );
  } finally {
    await rmRetry(root);
  }
});

test('demo: records written by a demo registry say demo', async () => {
  const { root, featureDir } = await workspace('gov-jobs-demo-');
  try {
    const reg = new JobRegistry({ demo: true, runStageOptions: QUICK_STUB });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 4, timeoutMs: 30000,
    });
    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'succeeded');
    assert.equal(view?.demo, true);
    const record = await recordWritten(featureDir, jobId);
    assert.equal(record['demo'], true);
  } finally {
    await rmRetry(root);
  }
});

/* --------------------------------------------------------------- afk chain */

/** Poll the feature's runs directory until it holds `n` records (or deadline). */
async function recordCount(dir: string, n: number, deadlineMs = 15000): Promise<number> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const files = (await readdir(join(dir, 'runs')).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.json'));
    if (files.length >= n) return files.length;
    if (Date.now() > until) return files.length;
    await sleep(25);
  }
}

const afkSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  automation: { ...DEFAULT_SETTINGS.automation, afk: true },
});

test('afk: a succeeded run chains into the next stage while stages advance', async () => {
  const { root, featureDir } = await workspace('gov-afk-chain-');
  try {
    /* The hook stands in for the server's refresh: each call re-scans and
     * hands back the feature one stage further along, AFK still on. */
    let calls = 0;
    const progressions = [
      stages({ intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete', split: 'active' }),
      stages({ intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete', split: 'complete', develop: 'active' }),
    ];
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      autoAdvance: async () => {
        const stagesNow = progressions[calls];
        calls++;
        if (stagesNow === undefined) return null; // nothing left to advance into
        return {
          root,
          featureDir,
          feature: { ...feature(featureDir), stages: stagesNow },
          settings: afkSettings(),
          skillsRoot: '/skills',
          maxParallel: 2,
          timeoutMs: 30000,
        };
      },
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });

    // Three runs total — design, split, develop — then the hook runs dry and
    // the chain stops. The third hook call happens after the third record is
    // written, so poll for it rather than racing it.
    const view = await settled(reg, jobId);
    assert.equal(view?.status, 'succeeded');
    assert.equal(await recordCount(featureDir, 3), 3, 'the chain ran design, split, develop');
    const hookDeadline = Date.now() + 5000;
    while (calls < 3 && Date.now() < hookDeadline) await sleep(25);
    assert.equal(calls, 3, 'the hook was consulted after every success');

    const stagesRun: string[] = [];
    for (const f of (await readdir(join(featureDir, 'runs'))).filter((f) => f.endsWith('.json'))) {
      stagesRun.push(String(JSON.parse(await readFile(join(featureDir, 'runs', f), 'utf8'))['stage']));
    }
    assert.deepEqual(stagesRun.sort(), ['design', 'develop', 'split']);
  } finally {
    await rmRetry(root);
  }
});

test('afk: an open gate on the next stage stops the chain — the human\'s turn', async () => {
  const { root, featureDir } = await workspace('gov-afk-gate-');
  try {
    let calls = 0;
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      autoAdvance: async () => {
        calls++;
        return {
          root,
          featureDir,
          /* The next stage advances, but a blocking gate sits on it. */
          feature: {
            ...feature(featureDir, 'the-feature', [gate('g-split', 'split', true)]),
            stages: stages({ intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete', split: 'active' }),
          },
          settings: afkSettings(),
          skillsRoot: '/skills',
          maxParallel: 2,
          timeoutMs: 30000,
        };
      },
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });
    await settled(reg, jobId);
    await sleep(300); // give the chain its chance to misbehave

    assert.equal(await recordCount(featureDir, 1), 1, 'only the first run happened');
    assert.equal(calls, 1, 'the chain stopped at the refusal');
  } finally {
    await rmRetry(root);
  }
});

test('afk: a succeeded run that did not advance the stage is not re-run blind', async () => {
  const { root, featureDir } = await workspace('gov-afk-stall-');
  try {
    let calls = 0;
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      autoAdvance: async () => {
        calls++;
        /* The run "succeeded" but the feature on disk is unchanged: the
         * operating stage is still design. */
        return {
          root,
          featureDir,
          feature: feature(featureDir),
          settings: afkSettings(),
          skillsRoot: '/skills',
          maxParallel: 2,
          timeoutMs: 30000,
        };
      },
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });
    await settled(reg, jobId);
    await sleep(300);

    assert.equal(await recordCount(featureDir, 1), 1, 'no blind re-run');
    assert.equal(calls, 1);
  } finally {
    await rmRetry(root);
  }
});

async function stops(featureDir: string): Promise<JournalEvent[]> {
  const { events } = await readJournal(featureDir);
  return events.filter((e) => e.kind === 'chain.stopped');
}

test('afk: a stop is recorded in the journal, not only printed to a console', async () => {
  /* The whole shape of the bug: a run succeeds, nothing follows it, and the
   * board shows a green run and then silence. The reason existed — it was being
   * written to a console nobody was reading. A stop is something that happened
   * to this feature, so it belongs in the file that records what happened. */
  const { root, featureDir } = await workspace('gov-afk-record-');
  try {
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      autoAdvance: async () => ({
        root,
        featureDir,
        feature: feature(featureDir), // still at design: the run changed nothing
        settings: afkSettings(),
        skillsRoot: '/skills',
        maxParallel: 2,
        timeoutMs: 30000,
      }),
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });
    await settled(reg, jobId);
    await sleep(300);

    const recorded = await stops(featureDir);
    assert.equal(recorded.length, 1, 'one stop, recorded once');
    const e = recorded[0]!;
    assert.equal(e.ref, 'design', 'the stop is filed against the stage it followed');
    assert.match(e.detail, /did not advance the stage/, `the reason, verbatim: ${e.detail}`);
    assert.equal(e.data?.['stage'], 'design');
    assert.equal(e.data?.['jobId'], jobId);
  } finally {
    await rmRetry(root);
  }
});

test('afk: a stop caused by a gate names the gate that is holding it', async () => {
  /* "A gate is open" sends a person looking. Naming the gate sends them to it.
   * The refusal already carried the ids; dropping them here would turn a
   * to-do list back into a shrug. */
  const { root, featureDir } = await workspace('gov-afk-stopgate-');
  try {
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      autoAdvance: async () => ({
        root,
        featureDir,
        feature: {
          ...feature(featureDir, 'the-feature', [gate('g-split', 'split', true)]),
          stages: stages({ intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete', split: 'active' }),
        },
        settings: afkSettings(),
        skillsRoot: '/skills',
        maxParallel: 2,
        timeoutMs: 30000,
      }),
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });
    await settled(reg, jobId);
    await sleep(300);

    const recorded = await stops(featureDir);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]!.data?.['gates'], ['g-split']);
  } finally {
    await rmRetry(root);
  }
});

test('afk: the hook is told why the chain stopped', async () => {
  /* The journal is the durable record; the caller is the one that can put the
   * reason in front of a person. Both get the same sentence — a stop that is
   * recorded but never shown is still silence. */
  const { root, featureDir } = await workspace('gov-afk-onstop-');
  try {
    let why: string | null = null;
    let gates: readonly { id: string }[] = [];
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      onStop: (_finished, reason, gs) => {
        why = reason;
        gates = gs;
      },
      autoAdvance: async () => ({
        root,
        featureDir,
        feature: feature(featureDir),
        settings: afkSettings(),
        skillsRoot: '/skills',
        maxParallel: 2,
        timeoutMs: 30000,
      }),
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: DEFAULT_SETTINGS,
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });
    await settled(reg, jobId);
    await sleep(300);

    assert.ok(why !== null, 'the hook was called');
    assert.match(why!, /did not advance the stage/);
    assert.deepEqual(gates, []);
  } finally {
    await rmRetry(root);
  }
});

test('afk: switching AFK off mid-chain stops it after the current run', async () => {
  const { root, featureDir } = await workspace('gov-afk-off-');
  try {
    const reg = new JobRegistry({
      runStageOptions: QUICK_STUB,
      autoAdvance: async () => ({
        root,
        featureDir,
        feature: {
          ...feature(featureDir),
          stages: stages({ intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete', split: 'active' }),
        },
        /* The human turned AFK off while the run was going. */
        settings: DEFAULT_SETTINGS,
        skillsRoot: '/skills',
        maxParallel: 2,
        timeoutMs: 30000,
      }),
    });
    const { jobId } = await reg.submit({
      root, featureDir, feature: feature(featureDir), settings: afkSettings(),
      skillsRoot: '/skills', maxParallel: 2, timeoutMs: 30000,
    });
    await settled(reg, jobId);
    await sleep(300);
    assert.equal(await recordCount(featureDir, 1), 1, 'the chain stopped when AFK went off');
  } finally {
    await rmRetry(root);
  }
});
