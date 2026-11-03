import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { admit, auditRun, snapshot } from '../src/exec/policy.js';
import type { AdvancePlan } from '../src/exec/runner.js';
import type { Gate, StageId } from '../src/domain/types.js';

const execFileAsync = promisify(execFile);

/* Policy is the part of the system that says "no" — and the part that reports
 * what happened after it said yes. Both halves are tested here against real
 * files: a gate check against a real decisions.jsonl, the write audit against a
 * real git repository. Git is the oracle, so when git is absent the tests say
 * so rather than pretending the tree was clean. */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function plan(featureDir: string, stage: StageId = 'design'): AdvancePlan {
  return {
    featureSlug: 'the-feature',
    featureDir,
    stage,
    skill: 'codebase-design',
    skillPath: null,
    skipped: null,
    mcp: [],
    command: ['opencode', 'run'],
    prompt: 'p',
    logPath: join(featureDir, 'runs', 'now-design.log'),
  };
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

async function workspace(prefix: string): Promise<{ root: string; featureDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const featureDir = join(root, '.scratch', 'the-feature');
  await mkdir(featureDir, { recursive: true });
  return { root, featureDir };
}

/* --------------------------------------------------------------- admission */

test('admit: a feature directory that is not its own slot is refused', async () => {
  const { root } = await workspace('gov-policy-slot-');
  try {
    const verdict = await admit({
      root,
      featureDir: join(root, '.scratch', 'a-different-one'),
      featureSlug: 'the-feature',
      gates: [],
      plan: plan(join(root, '.scratch', 'a-different-one')),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.status, 403);
    assert.equal(verdict.ok === false && verdict.code, 'boundary');
  } finally {
    await rmRetry(root);
  }
});

test('admit: a slug that is not one directory name is refused', async () => {
  const { root } = await workspace('gov-policy-slug-');
  try {
    for (const slug of ['../escape', 'a/b', '.hidden', '']) {
      const verdict = await admit({
        root,
        featureDir: join(root, '.scratch', slug),
        featureSlug: slug,
        gates: [],
        plan: plan(join(root, '.scratch', slug)),
      });
      assert.equal(verdict.ok, false, `slug "${slug}" should be refused`);
    }
  } finally {
    await rmRetry(root);
  }
});

test('admit: a gate on a stage that does not exist blocks nothing', async () => {
  const { root, featureDir } = await workspace('gov-policy-unknown-');
  try {
    /* Waiting on a typo is waiting forever; a data problem must not stop the
     * loop, it must be visible somewhere else. */
    const verdict = await admit({
      root,
      featureDir,
      featureSlug: 'the-feature',
      gates: [{ ...gate('g-typo', 'design'), stage: 'desgin' as StageId }],
      plan: plan(featureDir),
    });
    assert.equal(verdict.ok, true);
  } finally {
    await rmRetry(root);
  }
});

test('admit: gates ahead of the operating stage are reported, not enforced', async () => {
  const { root, featureDir } = await workspace('gov-policy-ahead-');
  try {
    const verdict = await admit({
      root,
      featureDir,
      featureSlug: 'the-feature',
      gates: [gate('g-develop', 'develop'), gate('g-review', 'review', false)],
      plan: plan(featureDir),
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok === true && verdict.gatesAhead.length, 1);
    assert.equal(verdict.ok === true && verdict.gatesAhead[0]?.id, 'g-develop');
  } finally {
    await rmRetry(root);
  }
});

/* ------------------------------------------------------------------- audit */

test('audit: a write outside the feature is reported, and the feature itself is not', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not installed; the audit has no oracle here');
    return;
  }
  const { root, featureDir } = await workspace('gov-policy-audit-');
  try {
    await execFileAsync('git', ['-C', root, 'init'], { timeout: 10000, windowsHide: true });
    await writeFile(join(root, 'README.md'), '# repo\n', 'utf8');
    /* `.scratch/` ignored is the normal case: the feature's own transcript
     * should not show up as a change to the repository. */
    await writeFile(join(root, '.gitignore'), '.scratch/\n', 'utf8');

    const before = await snapshot({ root, featureDir });
    assert.ok(Array.isArray(before.porcelain), 'a git repo should produce a status');

    await mkdir(join(featureDir, 'runs'), { recursive: true });
    await writeFile(join(featureDir, 'runs', 'now-design.log'), 'transcript', 'utf8');
    await writeFile(join(root, 'src-leak.txt'), 'the agent wandered\n', 'utf8');

    const audit = await auditRun(before, { root, featureDir });
    assert.equal(audit.tampered, false);
    assert.deepEqual(audit.outsideWrites, ['src-leak.txt']);
  } finally {
    await rmRetry(root);
  }
});

test('audit: a run that rewrites gates.json is tampered', async () => {
  const { root, featureDir } = await workspace('gov-policy-gates-');
  try {
    await writeFile(join(featureDir, 'gates.json'), '[]\n', 'utf8');
    const before = await snapshot({ root, featureDir });

    await writeFile(join(featureDir, 'gates.json'), '[{"id":"g-new"}]\n', 'utf8');
    const audit = await auditRun(before, { root, featureDir });
    assert.equal(audit.gatesChanged, true);
    assert.equal(audit.decisionsChanged, false);
    assert.equal(audit.tampered, true);
  } finally {
    await rmRetry(root);
  }
});

test('audit: absent decision log and absent git are both reported as unknown, not clean', async () => {
  const { root, featureDir } = await workspace('gov-policy-unknown-audit-');
  try {
    const before = await snapshot({ root, featureDir });
    assert.equal(before.gatesHash, null);
    assert.equal(before.decisionsHash, null);
    assert.equal(before.porcelain, null);

    const audit = await auditRun(before, { root, featureDir });
    assert.equal(audit.outsideWrites, null);
    assert.equal(audit.tampered, false);
  } finally {
    await rmRetry(root);
  }
});
