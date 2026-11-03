import { strict as assert } from 'node:assert';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import type { Settings } from '../src/config/settings.js';
import { advance, planAdvance, runStage } from '../src/exec/runner.js';
import type { AdvancePlan } from '../src/exec/runner.js';
import { emptyFacts } from '../src/domain/types.js';
import type { Feature, StageId, StageState } from '../src/domain/types.js';
import { deriveStages } from '../src/domain/stages.js';

/* runner.ts had no tests at all until 2026-10-30 (noted in HANDOVER as "the
 * planning path is tested", which was not true). These cover the plan, the
 * stage-run seam P2's job registry will call, and the dry-run guarantees of
 * `advance`. Nothing here touches a real workspace or a real CLI. */

function stages(partial: Partial<Record<StageId, StageState>>): Record<StageId, StageState> {
  const all: Record<StageId, StageState> = {
    intake: 'absent', ask: 'absent', spec: 'absent', design: 'absent',
    split: 'absent', develop: 'absent', review: 'absent', ship: 'absent', retro: 'absent',
  };
  return { ...all, ...partial };
}

function feature(root: string, slug: string): Feature {
  return {
    slug,
    root,
    kind: 'build',
    destination: 'a working thing',
    notes: [],
    decisionsSoFar: [],
    notYetSpecified: [],
    outOfScope: [],
    tickets: [],
    gates: [],
    stages: stages({
      intake: 'complete', ask: 'complete', spec: 'complete', design: 'active',
    }),
    warnings: [],
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  return dir;
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

/* ------------------------------------------------------------ planAdvance */

test('planAdvance: names the operating stage, its skill, and the resolved executor', () => {
  const root = 'H:/tmp/example-feature';
  const plan = planAdvance(feature(root, 'example-feature'), '/skills', DEFAULT_SETTINGS);

  assert.equal(plan.stage, 'design');
  assert.equal(plan.skill, 'codebase-design');
  assert.equal(plan.skipped, null);
  assert.equal(plan.skillPath, join('/skills', 'codebase-design', 'SKILL.md'));
  /* The command is the resolved executor's argv, and the prompt is a
   * reference to the skill, never a restatement of it. */
  assert.equal(plan.command[0], 'opencode');
  assert.ok(plan.command.includes('--standalone'));
  assert.ok(plan.command.includes('--auto'));
  assert.match(plan.prompt, /SKILL\.md/);
  assert.match(plan.prompt, /Do not move any file outside/);
  assert.match(plan.logPath, /runs[/\\].*[-_]design\.log$/);
});

test('planAdvance: a disabled skill is skipped, which is what makes the stage manual', () => {
  const plan = planAdvance(
    feature('H:/tmp/example-feature', 'example-feature'),
    '/skills',
    settingsWith([{ stage: 'design', enabled: false }]),
  );
  assert.equal(plan.skipped, 'disabled');
});

test('planAdvance: a stage with no skill (ship/CI) is skipped, not failed', () => {
  const e = feature('H:/tmp/example-feature', 'example-feature');
  const plan = planAdvance(
    { ...e, stages: stages({
      intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete',
      split: 'complete', develop: 'complete', review: 'complete', ship: 'ready',
    }) },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.equal(plan.stage, 'ship');
  assert.equal(plan.skill, null);
  assert.equal(plan.skipped, 'no-skill');
});

test('planAdvance: the operating stage agrees with what the artifacts would derive', () => {
  /* A plan whose operating stage disagrees with the derivation is the failure
   * this module must never produce. The feature built by `feature()` claims
   * design is active; derivation over equivalent facts must agree that
   * everything through design is settled, making `split` the operating stage. */
  const e = feature('H:/tmp/example-feature', 'example-feature');
  const facts = {
    ...emptyFacts(),
    featureDir: true,
    destinationNamed: true,
    specFile: true,
    designDeclared: true,
    mapFile: true,
    glossaryTerms: 2,
  };
  const derived = deriveStages(facts);
  assert.equal(derived.stages.intake, 'complete');
  assert.equal(derived.stages.ask, 'complete');
  assert.equal(derived.stages.spec, 'complete');
  assert.equal(derived.stages.design, 'complete'); /* declared, so complete */

  const plan = planAdvance({ ...e, stages: derived.stages }, '/skills', DEFAULT_SETTINGS);
  assert.equal(plan.stage, 'split');
  assert.equal(plan.skill, 'to-tickets');
});

/* ------------------------------------------------- open change requests */

/** A change in the shape `changesFrom` produces, so the prompt path is fed the
 *  same record the scanner builds rather than a hand-made lookalike. */
function change(id: string, text: string, status: 'open' | 'closed' = 'open') {
  return {
    id, text,
    openedAt: '2026-10-31T00:00:00.000Z',
    status,
    closedAt: status === 'open' ? null : '2026-10-31T01:00:00.000Z',
    note: null,
    outcome: status === 'open' ? null : ('absorbed' as const),
    followedUpBy: null,
    verdict: null,
  };
}

test('planAdvance: the ask prompt quotes the change, not a count of it', () => {
  /* The failure this pins: the prompt used to say "there is 1 open change
   * request" and nothing else. The run started, learned nothing it could act
   * on, and the change sat in the journal looking ignored. The human's sentence
   * is the requirement; a count is not. */
  const e = feature('H:/tmp/example-feature', 'example-feature');
  const plan = planAdvance(
    {
      ...e,
      stages: stages({ intake: 'complete', ask: 'active' }),
      openChanges: 1,
      changes: [change('CH-01', 'Change the greeting from "hello world" to "Hello, DeepSeek"')],
    },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.equal(plan.stage, 'ask');
  assert.match(plan.prompt, /CH-01: Change the greeting from "hello world" to "Hello, DeepSeek"/);
  /* And it says what to do about it: amend, do not rebuild. A change that
   * triggers a rewrite is the opposite of the smallest change that solves it. */
  assert.match(plan.prompt, /amends/);
  assert.match(plan.prompt, /Touch only the tickets/);
  assert.match(plan.prompt, /leave the journal alone/);
});

test('planAdvance: a closed change is not quoted as if it were open', () => {
  const e = feature('H:/tmp/example-feature', 'example-feature');
  const plan = planAdvance(
    {
      ...e,
      stages: stages({ intake: 'complete', ask: 'active' }),
      openChanges: 0,
      changes: [change('CH-01', 'already absorbed', 'closed')],
    },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.doesNotMatch(plan.prompt, /already absorbed/);
  assert.doesNotMatch(plan.prompt, /Open change requests/);
});

test('planAdvance: downstream of the change, the prompt says not to absorb it', () => {
  /* A develop run with an open change is a state the ladder should prevent, and
   * the prompt must not invite the agent to implement an unspecified change when
   * it happens anyway. */
  const e = feature('H:/tmp/example-feature', 'example-feature');
  const plan = planAdvance(
    {
      ...e,
      stages: stages({
        intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete',
        split: 'complete', develop: 'active',
      }),
      openChanges: 1,
      changes: [change('CH-01', 'rename the button')],
    },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.equal(plan.stage, 'develop');
  assert.match(plan.prompt, /CH-01: rename the button/);
  assert.match(plan.prompt, /do not absorb a change here/);
});

test('planAdvance: a destination already ending in a full stop is not doubled', () => {
  /* Prompts are read by humans in the transcript; "Prove the wire.." is the
   * kind of small wrongness that erodes trust in everything bigger. */
  const plan = planAdvance(
    { ...feature('H:/tmp/example-feature', 'example-feature'), destination: 'Prove the wire.' },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.match(plan.prompt, /Its destination: Prove the wire\.\n/);
  const stated = planAdvance(
    { ...feature('H:/tmp/example-feature', 'example-feature'), destination: '   ' },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.match(stated.prompt, /Its destination: \(not stated\)\./);
});

test('planAdvance: a feature with tickets is told how this tracker closes work', () => {
  /* The live run that found this: a real develop turn implemented everything
   * and closed nothing — every issue file still read `ready-for-agent`, so the
   * ladder kept deriving develop as `active` and AFK could not advance. The
   * closing convention lives in the tracker, not in any skill file, so the
   * prompt has to carry it or the agent cannot know it. */
  const ticket = {
    id: '01', slug: 'one', title: 'The first', type: 'task' as const, status: 'frontier' as const,
    blockedByRaw: 'None', blockedBy: [], warnings: [],
  };
  const withTickets = planAdvance(
    {
      ...feature('H:/tmp/example-feature', 'example-feature'),
      tickets: [ticket],
      stages: stages({
        intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete',
        split: 'complete', develop: 'active',
      }),
    },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.match(withTickets.prompt, /Status:\*\*` line to `resolved`/);
  assert.match(withTickets.prompt, /issues\//);

  const without = planAdvance(feature('H:/tmp/example-feature', 'example-feature'), '/skills', DEFAULT_SETTINGS);
  assert.doesNotMatch(without.prompt, /resolved/);
});

test('planAdvance: a file-derived stage is told which file the tracker reads', () => {
  /* The review run that found this: succeeded, no record left behind, review
   * kept deriving to `active`, and the AFK chain correctly refused to re-run —
   * the contract was missing, not the diligence. review/ship/retro complete on
   * a file, so the prompt names that file. */
  const e = feature('H:/tmp/example-feature', 'example-feature');
  const review = planAdvance(
    { ...e, stages: stages({
      intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete',
      split: 'complete', develop: 'complete', review: 'active',
    }) },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.match(review.prompt, /review\.md/);
  const develop = planAdvance(
    { ...e, stages: stages({
      intake: 'complete', ask: 'complete', spec: 'complete', design: 'complete',
      split: 'complete', develop: 'active',
    }) },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.doesNotMatch(develop.prompt, /record as/);

  /* design is the same kind of stage and was the one left out. Its record is
   * design.md, and the scanner completes the stage on that file — so a design
   * prompt that never names it sends an agent to write the artifact under a
   * name the tracker does not read. Two succeeded design runs on
   * project/.scratch/repalce-name did exactly that, and the stage stayed
   * `active` behind them. */
  const design = planAdvance(
    { ...e, stages: stages({
      intake: 'complete', ask: 'complete', spec: 'complete', design: 'active',
    }) },
    '/skills',
    DEFAULT_SETTINGS,
  );
  assert.match(design.prompt, /design\.md/);
});

/* --------------------------------------------------------------- runStage */

function planFor(tmp: string, command: string[]): AdvancePlan {
  const featureDir = join(tmp, 'the-feature');
  return {
    featureSlug: 'the-feature',
    featureDir,
    stage: 'develop',
    skill: 'implement-spec',
    skillPath: null,
    skipped: null,
    mcp: [],
    command,
    prompt: 'the prompt text',
    logPath: join(featureDir, 'runs', 'run.log'),
  };
}

test('runStage: calls the resolver with the plan command and spawns the resolved target', async () => {
  const tmp = await tempDir('gov-runstage-resolve');
  try {
    let resolvedWith: string | null = null;
    const result = await runStage(planFor(tmp, ['fake-cli', 'positional-arg']), {
      resolve: async (cli) => {
        resolvedWith = cli;
        return {
          command: process.execPath,
          args: ['-e', `console.log('resolved:', process.argv[1])`],
          how: 'injected',
        };
      },
    });
    /* plan.command[0] is the CLI *id*; the resolver turns it into the real
     * command, and its own args are prepended before the plan's argv. */
    assert.equal(resolvedWith, 'fake-cli');
    assert.equal(result.ok, true);
    assert.match(result.output, /resolved: positional-arg/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runStage: exit 0 is ok, output captured, log written', async () => {
  const tmp = await tempDir('gov-runstage-ok');
  try {
    const script = `process.stdout.write('OUT'); process.stderr.write('ERR');`;
    const result = await runStage(planFor(tmp, [process.execPath, '-e', script]), {
      resolve: async (cli) => ({ command: cli, args: [], how: 'as given' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.phase, null);
    assert.equal(result.error, null);
    assert.ok(result.output.includes('OUT'));
    assert.ok(result.output.includes('ERR'));

    const log = await readFile(result.logPath, 'utf8');
    assert.match(log, /^# develop - implement-spec/);
    assert.match(log, /the prompt text/);
    assert.match(log, /OUT/);
    assert.match(log, /ERR/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runStage: a non-zero exit is phase "exit" with the code and a captured tail', async () => {
  const tmp = await tempDir('gov-runstage-exit');
  try {
    const result = await runStage(
      planFor(tmp, [process.execPath, '-e', `console.error('the reason'); process.exit(3);`]),
      { resolve: async (cli) => ({ command: cli, args: [], how: 'as given' }) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.phase, 'exit');
    assert.match(result.error ?? '', /the reason/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runStage: a command that cannot start is phase "spawn", exitCode null', async () => {
  const tmp = await tempDir('gov-runstage-spawn');
  try {
    const result = await runStage(planFor(tmp, ['definitely-not-a-real-cli-xyz-00']), {
      resolve: async (cli) => ({ command: cli, args: [], how: 'as given' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.phase, 'spawn');
    assert.match(result.error ?? '', /ENOENT|not found|cannot find/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runStage: output chunks reach onOutput with their stream tag', async () => {
  const tmp = await tempDir('gov-runstage-echo');
  try {
    const seen: { text: string; stream: string }[] = [];
    await runStage(
      planFor(tmp, [process.execPath, '-e', `process.stdout.write('O'); process.stderr.write('E');`]),
      {
        resolve: async (cli) => ({ command: cli, args: [], how: 'as given' }),
        onOutput: (text, stream) => seen.push({ text, stream }),
      },
    );
    assert.ok(seen.some((s) => s.text.includes('O') && s.stream === 'stdout'));
    assert.ok(seen.some((s) => s.text.includes('E') && s.stream === 'stderr'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- aborting */

test('runStage: a signal aborted before the call never spawns', async () => {
  const tmp = await tempDir('gov-runstage-preabort');
  try {
    const controller = new AbortController();
    controller.abort();
    let spawned = 0;
    const result = await runStage(planFor(tmp, [process.execPath, '-e', 'console.log(1)']), {
      resolve: async (cli) => ({ command: cli, args: [], how: 'as given' }),
      signal: controller.signal,
      spawnFn: (() => {
        spawned += 1;
        throw new Error('an aborted plan must not spawn');
      }) as unknown as typeof import('node:child_process').spawn,
    });
    assert.equal(spawned, 0);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.error ?? '', /cancelled before it started/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runStage: an abort during the run kills the child and reports no exit code', async () => {
  const tmp = await tempDir('gov-runstage-midabort');
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runStage(
      planFor(tmp, [process.execPath, '-e', 'setTimeout(() => {}, 8000)']),
      {
        resolve: async (cli) => ({ command: cli, args: [], how: 'as given' }),
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 150);
    const result = await pending;
    /* Killed, not finished: the whole point is that it does not wait 8s. */
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.error ?? '', /terminated/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- advance */

async function scaffoldFeatureDir(root: string, slug: string): Promise<string> {
  const featureDir = join(root, '.scratch', slug);
  await mkdir(featureDir, { recursive: true });
  await mkdir(join(featureDir, 'issues'), { recursive: true });
  const map = [
    '# A test feature',
    '',
    '## Destination',
    '',
    'A thing that works.',
    '',
    '## Notes',
    '',
    '- one',
    '',
  ].join('\n');
  await writeFile(join(featureDir, 'map.md'), map, 'utf8');
  return featureDir;
}

test('advance: a dry run plans, prints, and spawns nothing', async () => {
  const root = await tempDir('gov-advance-dry');
  try {
    const featureDir = await scaffoldFeatureDir(root, 'dry-feature');
    let spawned = 0;
    const code = await advance({
      target: featureDir,
      execute: false,
      settings: DEFAULT_SETTINGS,
      spawnFn: (() => {
        spawned += 1;
        throw new Error('a dry run must not spawn');
      }) as unknown as typeof import('node:child_process').spawn,
    });
    assert.equal(code, 0);
    assert.equal(spawned, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('advance: a disabled skill makes the stage a human gate and spawns nothing', async () => {
  const root = await tempDir('gov-advance-gate');
  try {
    const featureDir = await scaffoldFeatureDir(root, 'gated-feature');
    /* map.md only: derivation puts the feature at `ask`, whose skill is
     * `grilling`. Disabled, so nothing runs and nothing is spent. */
    const code = await advance({
      target: featureDir,
      execute: true,
      settings: settingsWith([{ stage: 'ask', enabled: false }]),
      spawnFn: (() => {
        throw new Error('a disabled stage must not spawn');
      }) as unknown as typeof import('node:child_process').spawn,
    });
    assert.equal(code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
