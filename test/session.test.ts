import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseCliOutput, probeCli, spawnRunner } from '../src/exec/agent.js';
import type { AgentRunner, AgentResult, AgentTurn } from '../src/exec/agent.js';
import { answerPrompt, prdPrompt, startPrompt, pad } from '../src/session/prompt.js';
import { parseRoundJson, parseRoundMarkdown, readRound } from '../src/session/round.js';
import {
  SESSION_DIR,
  SessionError,
  answerSession,
  finaliseSession,
  readRoundHistory,
  readSession,
  resetSession,
  resolveFeatureDir,
  startSession,
} from '../src/session/session.js';
import type { SessionPorts } from '../src/session/session.js';

/**
 * The grilling session, driven end to end against a scripted agent.
 *
 * The agent is a double here because on this machine the real CLI cannot execute
 * (it reaches for a program the sandbox blocks). Everything above the runner is
 * therefore fully exercised — the conversation, the round artifacts, the refusals,
 * the PRD — and the one link that cannot be proven locally is named in
 * HANDOVER rather than left implied.
 */

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gov-session-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A scripted agent.
 *
 * Each `run` call pops the next scripted turn: writes whatever artifacts that turn
 * should produce, and returns a result. It records the prompts it was given, which
 * is how the tests assert that the conversation is actually being continued.
 */
function scriptedAgent(
  turns: readonly {
    readonly round: number;
    readonly questions?: readonly {
      id: string;
      title: string;
      body: string;
      recommended: string;
      options?: string[];
      why?: string;
    }[];
    readonly frontierEmpty?: boolean;
    readonly kind?: 'questions' | 'prd';
    readonly output?: string;
    readonly glossary?: readonly string[];
    readonly adrs?: readonly string[];
    /** Write spec.md, as the PRD turn must. */
    readonly writeSpec?: string;
    /** Fail instead of producing anything. */
    readonly fail?: string;
    /** Produce nothing at all — the silent no-op. */
    readonly silent?: boolean;
  }[],
) {
  const seen: AgentTurn[] = [];
  let i = 0;

  const runner: AgentRunner = {
    async run(turn: AgentTurn): Promise<AgentResult> {
      seen.push(turn);
      const script = turns[i++];
      if (script === undefined) {
        return { ok: false, sessionId: null, output: '', error: 'script exhausted', phase: 'exit', ms: 1 };
      }
      if (script.fail !== undefined) {
        return { ok: false, sessionId: turn.sessionId, output: '', error: script.fail, phase: 'exit', ms: 1 };
      }
      if (script.silent === true) {
        return { ok: true, sessionId: 'sess-1', output: '', error: null, phase: null, ms: 1 };
      }

      const dir = join(turn.cwd, SESSION_DIR);
      await mkdir(dir, { recursive: true });

      const artifact = {
        round: script.round,
        kind: script.kind ?? 'questions',
        questions: (script.questions ?? []).map((q) => ({
          id: q.id,
          title: q.title,
          body: q.body,
          why: q.why ?? 'nothing is settled yet',
          recommended: q.recommended,
          ...(q.options === undefined ? {} : { options: q.options }),
        })),
        glossaryWritten: script.glossary ?? [],
        adrsWritten: script.adrs ?? [],
        frontierEmpty: script.frontierEmpty === true,
      };
      await writeFile(join(dir, `${pad(script.round)}.json`), JSON.stringify(artifact, null, 2), 'utf8');
      await writeFile(join(dir, 'latest.json'), JSON.stringify(artifact, null, 2), 'utf8');

      if (script.writeSpec !== undefined) {
        await writeFile(join(turn.cwd, 'spec.md'), script.writeSpec, 'utf8');
      }
      return {
        ok: true,
        sessionId: 'sess-1',
        output: script.output ?? '',
        error: null,
        phase: null,
        ms: 1,
      };
    },
  };

  return { runner, seen };
}

function ports(runner: AgentRunner, over: Partial<SessionPorts> = {}): SessionPorts {
  return {
    runner,
    skillsRoot: 'C:/skills',
    model: 'sonnet',
    timeoutMs: 60_000,
    allowedTools: ['Read', 'Edit'],
    now: () => new Date('2026-10-13T00:00:00Z'),
    ...over,
  };
}

const IDEA = 'something that watches my camera feed and pings me when something looks off';

/* ---------- prompts ---------- */

test('the start prompt quotes the idea verbatim and does not tidy it', () => {
  const p = startPrompt({
    featureSlug: 'e',
    featureDir: '/x',
    repoRoot: '/r',
    idea: '  a thing   that watches stuff  ',
    skills: { root: 'C:/skills' },
    sessionDir: '/x/.session',
    round: 1,
  });
  assert.ok(p.includes('a thing   that watches stuff'), 'internal spacing must survive');
  assert.ok(p.includes('Do not tidy this up'));
});

test('every prompt points at the skill file rather than restating it', () => {
  const ctx = {
    featureSlug: 'e',
    featureDir: '/x',
    repoRoot: '/r',
    idea: 'an idea that is long enough',
    skills: { root: 'C:/skills' },
    sessionDir: '/x/.session',
    round: 2,
  };
  for (const p of [startPrompt(ctx), answerPrompt(ctx, [{ id: 'q1', answer: 'a' }]), prdPrompt(ctx)]) {
    // The whole design rests on there being one copy of the protocol.
    assert.ok(
      p.includes('C:/skills/grill-with-docs/SKILL.md'),
      'the skill path must be named',
    );
    assert.ok(
      !/ask one question at a time|number each question/i.test(p),
      'the prompt must not restate grilling rules',
    );
  }
});

test('a change filed mid-session reaches the next turn, verbatim', () => {
  /* The change box sits on the same panel that runs the session, so this is a
   * real sequence and not a hypothetical: file a change, then answer the round
   * already on screen. Before this the turn carried the original idea only, and
   * the change waited in the journal for a stage run that might never come. */
  const ctx = {
    featureSlug: 'e',
    featureDir: '/x',
    repoRoot: '/r',
    idea: 'an idea that is long enough',
    skills: { root: 'C:/skills' },
    sessionDir: '/x/.session',
    round: 2,
    openChanges: [{ id: 'CH-01', text: '  the greeting should say   Hello, DeepSeek ' }],
  };
  const p = answerPrompt(ctx, [{ id: 'q1', answer: 'a' }]);
  assert.ok(p.includes('CH-01: the greeting should say Hello, DeepSeek'));
  assert.ok(!p.includes('say   Hello'), 'runs of whitespace are collapsed, not the words');
  assert.match(p, /do not assume the newer one wins/);
});

test('the answer prompt names the artifact path and stays terse', () => {
  const p = answerPrompt(
    {
      featureSlug: 'e',
      featureDir: '/x',
      repoRoot: '/r',
      idea: 'idea',
      skills: { root: 's' },
      sessionDir: '/x/.session',
      round: 3,
    },
    [
      { id: 'q1', answer: 'people' },
      { id: 'q2', answer: 'a camera' },
    ],
  );
  assert.ok(p.includes('- q1: people'));
  assert.ok(p.includes('- q2: a camera'));
  assert.ok(p.includes('/x/.session/03.json'), 'the round artifact path must be exact');
});

test('the PRD prompt fixes the section headings the rest of the system reads', () => {
  const p = prdPrompt({
    featureSlug: 'e',
    featureDir: '/x',
    repoRoot: '/r',
    idea: 'idea',
    skills: { root: 's' },
    sessionDir: '/x/.session',
    round: 4,
  });
  for (const heading of [
    '## Problem Statement',
    '## Solution',
    '## User Stories',
    '## Implementation Decisions',
    '## Testing Decisions',
    '## Test Seams',
    '## Out of Scope',
    '## Design',
  ]) {
    assert.ok(p.includes(heading), `missing ${heading}`);
  }
  // The prompt must warn against inventing requirements, which is the failure a
  // generated PRD is most prone to.
  assert.ok(/[Dd]o not invent/.test(p));
});

/* ---------- round parsing ---------- */

test('the JSON artifact is read as-is', () => {
  const r = parseRoundJson(
    JSON.stringify({
      round: 2,
      kind: 'questions',
      questions: [
        { id: 'q1', title: 'T', body: 'B', why: 'W', recommended: 'R', options: ['a', 'b'] },
      ],
      glossaryWritten: ['frame'],
      adrsWritten: ['0001-x.md'],
      frontierEmpty: false,
    }),
    2,
  );
  assert.ok(r);
  assert.equal(r.source, 'json');
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.questions[0]!.options, ['a', 'b']);
  assert.deepEqual(r.glossaryWritten, ['frame']);
  assert.equal(r.frontierEmpty, false);
  assert.deepEqual(r.warnings, []);
});

test('a round number that disagrees with the app is reported', () => {
  const r = parseRoundJson(JSON.stringify({ round: 5, questions: [] , frontierEmpty: true}), 2);
  assert.ok(r);
  assert.ok(r.warnings.some((w) => w.includes('round 5')));
});

test('an artifact with no questions and no empty frontier is flagged', () => {
  const r = parseRoundJson(JSON.stringify({ round: 1, questions: [], frontierEmpty: false }), 1);
  assert.ok(r);
  assert.ok(r.warnings.some((w) => w.includes('no questions')));
});

test('claiming an empty frontier while asking questions is caught', () => {
  const r = parseRoundJson(
    JSON.stringify({
      round: 1,
      questions: [{ id: 'q1', title: 'T', body: '', recommended: '' }],
      frontierEmpty: true,
    }),
    1,
  );
  assert.ok(r);
  assert.equal(r.frontierEmpty, false, 'the contradiction resolves toward open');
  assert.ok(r.warnings.some((w) => w.includes('contradictory') || w.includes('also claimed')));
});

test('prose that is not JSON is not read as a round', () => {
  assert.equal(parseRoundJson('just some text', 1), null);
  assert.equal(parseRoundJson('[1,2,3]', 1), null);
  assert.equal(parseRoundJson('null', 1), null);
});

test('the markdown fallback reads the grilling skill format', () => {
  const md = [
    '\u2753 **Q1** - **What are you detecting**: the target drives the model.',
    '',
    '\u27A1\uFE0F People.',
    '',
    '---',
    '',
    '\u2753 **Q2** - **Where does the video come from**: this decides the ingest path.',
    '',
    '\u27A1\uFE0F An existing IP camera over RTSP.',
  ].join('\n');
  const r = parseRoundMarkdown(md, 1);
  assert.ok(r);
  assert.equal(r.source, 'markdown');
  assert.equal(r.questions.length, 2);
  assert.equal(r.questions[0]!.id, 'Q1');
  assert.equal(r.questions[0]!.title, 'What are you detecting');
  assert.equal(r.questions[0]!.recommended, 'People.');
  // The fallback must announce itself: a silent degrade is the thing to avoid.
  assert.ok(r.warnings.some((w) => w.includes('prose')));
});

test('the markdown fallback returns nothing rather than inventing questions', () => {
  assert.equal(parseRoundMarkdown('no questions here at all', 1), null);
  assert.equal(parseRoundMarkdown('', 1), null);
});

test('readRound prefers the artifact and falls back', () => {
  const json = JSON.stringify({
    round: 1,
    questions: [{ id: 'q1', title: 'from json', body: '', recommended: '' }],
    frontierEmpty: false,
  });
  const md = '\u2753 **Q1** - **from markdown**: x\n\n\u27A1\uFE0F rec';
  assert.equal(readRound(json, md, 1).source, 'json');
  assert.equal(readRound(null, md, 1).source, 'markdown');
  assert.equal(readRound(null, null, 1).source, 'none');
});

/* ---------- the session ---------- */

test('resolving a feature refuses anything that is not a slug', () => {
  assert.match(resolveFeatureDir('/r', 'ok-slug'), /\.scratch[\\/]ok-slug$/);
  for (const bad of ['../escape', '..', 'a/b', 'A', '']) {
    assert.throws(() => resolveFeatureDir('/r', bad), SessionError, `accepted ${bad}`);
  }
});

test('starting a session sends the idea and records the first round', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s1-'));
  try {
    const { runner, seen } = scriptedAgent([
      {
        round: 1,
        questions: [
          { id: 'q1', title: 'What are you detecting', body: 'name the target', recommended: 'People' },
          { id: 'q2', title: 'Where does the video come from', body: 'ingest path', recommended: 'RTSP' },
        ],
        glossary: ['frame'],
      },
    ]);
    const state = await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });

    assert.equal(state.phase, 'asking');
    assert.equal(state.conversationId, 'sess-1');
    assert.equal(state.pending?.questions.length, 2);
    assert.equal(state.answeredRounds, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.sessionId, null, 'the first turn starts a conversation');
    assert.ok(seen[0]!.prompt.includes(IDEA), 'the idea must be sent verbatim');

    // The artifact is on disk, under the feature, where the feature lives.
    const files = await readdir(join(dir, '.scratch', 'camera', SESSION_DIR));
    assert.ok(files.includes('01.json'));
    assert.ok(files.includes('state.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second start on the same feature is refused rather than overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s2-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: '' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    await assert.rejects(
      () => startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA }),
      (err: unknown) => err instanceof SessionError && err.status === 409,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an idea too short to grill is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s3-'));
  try {
    const { runner } = scriptedAgent([]);
    await assert.rejects(
      () => startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: 'a thing' }),
      (err: unknown) => err instanceof SessionError && err.status === 400,
    );
    // And nothing was created for it.
    assert.equal(await stat(join(dir, '.scratch')).catch(() => null), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('answering continues the same conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s4-'));
  try {
    const { runner, seen } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
      { round: 2, questions: [{ id: 'q1', title: 'U', body: '', recommended: 'S' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    const state = await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [{ id: 'q1', answer: 'people' }],
    });

    assert.equal(state.answeredRounds, 1);
    assert.equal(state.pending?.questions[0]!.title, 'U', 'the second round must be read');
    // This is the load-bearing bit: the second turn resumes, it does not restart.
    assert.equal(seen[1]!.sessionId, 'sess-1');
    assert.ok(seen[1]!.prompt.includes('- q1: people'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('answering writes the answers into the round they answer', async () => {
  /* The dossier's "问了几轮、答案是是什么" reads the round artifacts, so the
   * answers must land beside the questions — not only in the transcript. */
  const dir = await mkdtemp(join(tmpdir(), 'gov-s4c-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
      { round: 2, questions: [{ id: 'q1', title: 'U', body: '', recommended: 'S' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [{ id: 'q1', answer: 'people' }],
    });
    const one = JSON.parse(
      await readFile(join(dir, '.scratch', 'camera', '.session', '01.json'), 'utf8'),
    );
    assert.deepEqual(one.answers, [{ id: 'q1', answer: 'people' }]);
    // The next round stays clean: it has not been answered yet.
    const two = JSON.parse(
      await readFile(join(dir, '.scratch', 'camera', '.session', '02.json'), 'utf8'),
    );
    assert.equal(two.answers, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round numbers re-anchor to the artifact: three rounds, no drift, no warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s4b-'));
  try {
    const { runner, seen } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'A', body: '', recommended: 'R' }] },
      { round: 2, questions: [{ id: 'q1', title: 'B', body: '', recommended: 'S' }] },
      { round: 3, questions: [{ id: 'q1', title: 'C', body: '', recommended: 'T' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [{ id: 'q1', answer: 'first' }],
    });
    const state = await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [{ id: 'q1', answer: 'second' }],
    });

    assert.equal(state.answeredRounds, 2, 'two rounds answered');
    assert.equal(state.pending?.round, 3);
    assert.deepEqual(
      state.warnings.filter((w) => w.includes('round')),
      [],
      'a well-numbered conversation must not warn about round drift',
    );
    // The prompt names the file for the round the agent is actually on.
    assert.ok(seen[1]!.prompt.includes('02.json'), 'the second turn names 02.json');
    assert.ok(seen[2]!.prompt.includes('03.json'), 'the third turn names 03.json');
    // And the history is three real files, not one overwritten file.
    const files = await readdir(join(dir, '.scratch', 'camera', SESSION_DIR));
    for (const f of ['01.json', '02.json', '03.json']) {
      assert.ok(files.includes(f), `${f} must exist`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a session the agent numbered itself still advances (the P5 overwrite shape)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s4c-'));
  try {
    /* The live DeepSeek session this reproduces: the app told the agent to write
     * `01.json` every turn (its own round arithmetic was stuck at 1), so the
     * agent overwrote one file while tagging each artifact with its true round.
     * The next answer must continue from the artifact's number, not the count. */
    const sessionDir = join(dir, '.scratch', 'camera', SESSION_DIR);
    await mkdir(sessionDir, { recursive: true });
    const corrupted = {
      round: 7,
      kind: 'questions',
      questions: [{ id: 'q1', title: 'Still open', body: '', why: '', recommended: 'R' }],
      glossaryWritten: [],
      adrsWritten: [],
      frontierEmpty: false,
    };
    await writeFile(join(sessionDir, '01.json'), JSON.stringify(corrupted, null, 2), 'utf8');
    await writeFile(join(sessionDir, 'latest.json'), JSON.stringify(corrupted, null, 2), 'utf8');
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ feature: 'camera', conversationId: 'sess-1', phase: 'asking' }),
      'utf8',
    );

    const { runner, seen } = scriptedAgent([
      { round: 8, questions: [{ id: 'q1', title: 'Next', body: '', recommended: 'S' }] },
    ]);
    const state = await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [{ id: 'q1', answer: 'because the evidence says so' }],
    });

    assert.equal(state.answeredRounds, 7, 'round seven was answered');
    assert.equal(state.pending?.round, 8);
    assert.deepEqual(
      state.warnings.filter((w) => w.includes('round')),
      [],
      'continuing from the artifact must not warn about its own number',
    );
    assert.ok(seen[0]!.prompt.includes('08.json'), 'the next turn must name 08.json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an answer to a question the round did not ask is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s5-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    await assert.rejects(
      () =>
        answerSession(ports(runner), {
          repoRoot: dir,
          feature: 'camera',
          answers: [{ id: 'q9', answer: 'something' }],
        }),
      (err: unknown) =>
        err instanceof SessionError && err.status === 400 && err.message.includes('q9'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('answering with nothing is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s6-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    await assert.rejects(
      () => answerSession(ports(runner), { repoRoot: dir, feature: 'camera', answers: [] }),
      (err: unknown) => err instanceof SessionError && err.status === 400,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent that cannot run leaves the session failed, with the reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s7-'));
  try {
    const { runner } = scriptedAgent([{ round: 1, fail: 'spawn claude ENOENT' }]);
    const state = await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });

    assert.equal(state.phase, 'failed');
    assert.ok(state.failure?.includes('ENOENT'), 'the reason must survive verbatim');
    assert.equal(state.pending, null);

    // And the failure is durable: reading it back says the same thing.
    const reread = await readSession(resolveFeatureDir(dir, 'camera'));
    assert.equal(reread?.phase, 'failed');
    assert.ok(reread?.failure?.includes('ENOENT'));

    // Answering a stopped session is refused rather than silently doing nothing.
    await assert.rejects(
      () => answerSession(ports(runner), { repoRoot: dir, feature: 'camera', answers: [{ id: 'q1', answer: 'x' }] }),
      (err: unknown) => err instanceof SessionError && err.status === 409,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent that succeeds but writes no round is not treated as progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s8-'));
  try {
    const { runner } = scriptedAgent([{ round: 1, silent: true }]);
    const state = await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    // Nothing to show and nothing to answer: the session is asking, but the
    // pending round is absent, which the UI must handle rather than crash on.
    assert.equal(state.pending, null);
    assert.equal(state.phase, 'asking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the PRD is refused while questions are still open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-s9-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    await assert.rejects(
      () => finaliseSession(ports(runner), { repoRoot: dir, feature: 'camera' }),
      (err: unknown) =>
        err instanceof SessionError && err.status === 409 && /open/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the whole flow runs: idea, rounds, empty frontier, PRD, done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-full-'));
  try {
    const spec = [
      '# Spec: camera watch',
      '',
      '## Problem Statement',
      'Nothing watches the feed.',
      '',
      '## Solution',
      'A single-host service that does.',
      '',
      '## User Stories',
      '1. As the only user, I want an alert, so that it matters.',
      '',
      '## Implementation Decisions',
      '- Target: people.',
      '',
      '## Testing Decisions',
      '- External behaviour only.',
      '',
      '## Test Seams',
      'At the ingest boundary.',
      '',
      '## Out of Scope',
      '- Multi-camera.',
      '',
      '## Design',
      'Analysis one hop away.',
      '',
    ].join('\n');

    const { runner, seen } = scriptedAgent([
      {
        round: 1,
        questions: [
          { id: 'q1', title: 'Target', body: 'what are you detecting', recommended: 'People' },
          { id: 'q2', title: 'Source', body: 'where the video comes from', recommended: 'RTSP' },
        ],
        glossary: ['frame'],
        adrs: ['0001-one-hop.md'],
      },
      {
        round: 2,
        questions: [{ id: 'q1', title: 'Latency', body: 'how fresh', recommended: 'ten seconds' }],
      },
      { round: 3, questions: [], frontierEmpty: true, kind: 'questions' },
      { round: 4, questions: [], frontierEmpty: true, kind: 'prd', writeSpec: spec },
    ]);

    const s0 = await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    assert.equal(s0.phase, 'asking');
    assert.deepEqual(s0.pending?.glossaryWritten, ['frame']);
    assert.deepEqual(s0.pending?.adrsWritten, ['0001-one-hop.md']);

    const s1 = await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [
        { id: 'q1', answer: 'people' },
        { id: 'q2', answer: 'an RTSP camera' },
      ],
    });
    assert.equal(s1.phase, 'asking');

    const s2 = await answerSession(ports(runner), {
      repoRoot: dir,
      feature: 'camera',
      answers: [{ id: 'q1', answer: 'about ten seconds is fine' }],
    });
    assert.equal(s2.phase, 'ready-for-prd', 'an empty frontier moves the session on');

    const s3 = await finaliseSession(ports(runner), { repoRoot: dir, feature: 'camera' });
    assert.equal(s3.phase, 'done');
    assert.equal(s3.failure, null);

    // The spec is real, on disk, with the sections the scanner reads.
    const written = await readFile(join(dir, '.scratch', 'camera', 'spec.md'), 'utf8');
    assert.ok(written.includes('## User Stories'));
    // Every turn continued one conversation.
    assert.equal(seen.length, 4);
    assert.equal(seen[0]!.sessionId, null);
    assert.deepEqual(seen.slice(1).map((t) => t.sessionId), ['sess-1', 'sess-1', 'sess-1']);

    // And the round history is the record of the conversation.
    const history = await readRoundHistory(resolveFeatureDir(dir, 'camera'));
    assert.equal(history.length, 4);
    assert.equal(history[0]!.round, 1);

    // Re-reading after the fact must agree without running anything.
    const reread = await readSession(resolveFeatureDir(dir, 'camera'));
    assert.equal(reread?.phase, 'done');
    assert.equal(reread?.answeredRounds, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a grilling round that mislabels itself as the PRD does not deadlock the flow', async () => {
  /* The live DeepSeek session (2026-10-30): its closing round wrote
   * `kind: "prd"` on its own — nothing left to ask, it decided the PRD was
   * next. The derivation believed the label, `finalise` refused with "not
   * ready", and the human was stuck. The label is impossible before a PRD turn
   * runs (only finalise writes one), so the round's content must win. */
  const dir = await mkdtemp(join(tmpdir(), 'gov-mislabel-'));
  try {
    const sessionDir = join(dir, '.scratch', 'camera', SESSION_DIR);
    await mkdir(sessionDir, { recursive: true });
    const mislabeled = {
      round: 8,
      kind: 'prd',
      questions: [],
      glossaryWritten: [],
      adrsWritten: ['0002-render-based-verification.md'],
      frontierEmpty: true,
    };
    for (const f of ['08.json', 'latest.json']) {
      await writeFile(join(sessionDir, f), JSON.stringify(mislabeled, null, 2), 'utf8');
    }
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ feature: 'camera', conversationId: 'sess-1', phase: 'asking' }),
      'utf8',
    );
    // No turns-index.jsonl: no PRD turn has ever run.

    const reread = await readSession(resolveFeatureDir(dir, 'camera'));
    assert.equal(reread?.phase, 'ready-for-prd', 'the mislabel must not read as failed');
    assert.ok(
      reread?.warnings.some((w) => w.includes('no PRD turn has run')),
      'the repair must be visible, not silent',
    );

    // And the flow continues: finalise runs the real PRD turn and finishes.
    const { runner } = scriptedAgent([
      { round: 9, kind: 'prd', writeSpec: '# spec\n\n## User Stories\n\n1. As a user, I want it to work, so that it does.' },
    ]);
    const done = await finaliseSession(ports(runner), { repoRoot: dir, feature: 'camera' });
    assert.equal(done.phase, 'done');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a PRD turn that writes no spec is a failure, not a quiet success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-nospec-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [], frontierEmpty: true },
      { round: 2, questions: [], frontierEmpty: true, kind: 'prd' },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'camera', idea: IDEA });
    const state = await finaliseSession(ports(runner), { repoRoot: dir, feature: 'camera' });
    assert.equal(state.phase, 'failed');
    assert.ok(state.failure?.includes('spec.md'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- the runner itself ---------- */

test('the CLI envelope is read tolerantly', () => {
  assert.deepEqual(parseCliOutput(''), { sessionId: null, message: '', isError: false });
  const ok = parseCliOutput(JSON.stringify({ session_id: 'abc', result: 'hello' }));
  assert.equal(ok.sessionId, 'abc');
  assert.equal(ok.message, 'hello');
  assert.equal(ok.isError, false);
  // Not JSON: keep the text, because it is usually the error.
  const raw = parseCliOutput('Error: something went wrong');
  assert.equal(raw.sessionId, null);
  assert.ok(raw.message.includes('something went wrong'));
  // An error envelope is recognised.
  assert.equal(parseCliOutput(JSON.stringify({ is_error: true })).isError, true);
});

test('the runner invokes the CLI with the flags the design depends on', async () => {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  // A fake child process: enough surface for spawnRunner to drive.
  const fakeSpawn = ((cmd: string, args: readonly string[], opts: { cwd?: string }) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd ?? '' });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ session_id: 'sess-9', result: 'ok' }));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  // The CLI is resolved before it is spawned. Asserting on the raw name would
  // bake in the bug this fixed: on Windows the name on PATH is a batch file that
  // cannot be started, so what gets spawned is the JavaScript entry behind it.
  const resolved = {
    command: 'NODE',
    args: ['/resolved/cli.js'],
    how: 'followed the shim',
  };
  const runner = spawnRunner({
    cli: 'claude',
    spawnFn: fakeSpawn,
    resolve: async () => resolved,
  });
  const result = await runner.run({
    prompt: 'do the thing',
    sessionId: 'prev-session',
    cwd: '/tmp',
    logPath: join(tmpdir(), 'gov-turn.log'),
    timeoutMs: 5000,
    model: 'sonnet',
    allowedTools: ['Read', 'Edit'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'sess-9');
  const args = calls[0]!.args;
  assert.equal(calls[0]!.cmd, 'NODE', 'the resolved command must be the one spawned');
  assert.equal(args[0], '/resolved/cli.js', 'the resolution args must come first');
  assert.ok(args.includes('--print'), 'non-interactive, or it would hang forever');
  assert.ok(args.includes('--output-format') && args.includes('json'), 'json, so the session id is readable');
  assert.ok(args.includes('--resume') && args.includes('prev-session'), 'the conversation must continue');
  // Scoped permission, never the blanket bypass.
  assert.ok(args.includes('--permission-mode') && args.includes('acceptEdits'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false, 'never bypass wholesale');
  assert.ok(args.includes('--allowedTools'));
});

test('a non-zero exit is reported with its phase and message', async () => {
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stderr.write('the sandbox refused to start reg.exe');
      child.emit('close', 1);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const runner = spawnRunner({ cli: 'claude', spawnFn: fakeSpawn });
  const result = await runner.run({
    prompt: 'x',
    sessionId: null,
    cwd: '/tmp',
    logPath: join(tmpdir(), 'gov-fail.log'),
    timeoutMs: 5000,
    model: 'sonnet',
    allowedTools: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'exit');
  assert.ok(result.error?.includes('reg.exe'), 'the reason must reach the caller');
});

test('a spawn failure is distinguished from a run failure', async () => {
  const fakeSpawn = (() => {
    throw new Error('spawn claude ENOENT');
  }) as unknown as typeof import('node:child_process').spawn;

  const runner = spawnRunner({ cli: 'claude', spawnFn: fakeSpawn });
  const result = await runner.run({
    prompt: 'x',
    sessionId: null,
    cwd: '/tmp',
    logPath: join(tmpdir(), 'gov-nospawn.log'),
    timeoutMs: 5000,
    model: 'sonnet',
    allowedTools: [],
  });
  assert.equal(result.phase, 'spawn');
  assert.ok(result.error?.includes('ENOENT'));
});

test('a reply with no session id is not a usable turn', async () => {
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ result: 'I did something' }));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const runner = spawnRunner({ cli: 'claude', spawnFn: fakeSpawn });
  const result = await runner.run({
    prompt: 'x',
    sessionId: null,
    cwd: '/tmp',
    logPath: join(tmpdir(), 'gov-nosid.log'),
    timeoutMs: 5000,
    model: 'sonnet',
    allowedTools: [],
  });
  // Without a session id the conversation cannot be continued, so the turn is not
  // usable however successful it looked.
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('session id'));
});

test('probeCli separates "installed" from "can execute"', async () => {
  const versionOnly = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stdout.write('2.0.9 (Claude Code)\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  // Reports a version, then fails every turn: exactly this machine's situation.
  let call = 0;
  const flaky = ((cmd: string, args: readonly string[]) => {
    call++;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    const isVersion = args.includes('--version');
    setImmediate(() => {
      if (isVersion) {
        child.stdout.write('2.0.9 (Claude Code)\n');
        child.emit('close', 0);
      } else {
        child.stderr.write('PROGRAM BLOCKED: reg.exe');
        child.emit('close', 1);
      }
    });
    void cmd;
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const v = await probeCli('claude', versionOnly);
  assert.equal(v.available, false, 'a version alone is not proof it can run');
  assert.equal(v.version, '2.0.9 (Claude Code)');

  const probed = await probeCli('claude', flaky);
  assert.equal(probed.available, false);
  assert.equal(call, 2, 'it must actually try a turn, not just the version');
  assert.ok(probed.detail.includes('reg.exe'), 'the obstruction must be reported');
});

/* ---------- undoing a session ---------- */

test('a taken name is recoverable: reset with confirm:false deletes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-reset1-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'taken', idea: IDEA });

    const preview = await resetSession({ repoRoot: dir, feature: 'taken', confirm: false });
    assert.equal(preview.removed, false, 'a preview must not delete');
    assert.ok(preview.files.length > 0, 'and it must say what would go');
    assert.ok(
      preview.files.some((f) => f.endsWith('state.json')),
      'listing the real files, not a guess',
    );
    // The session is still there and still readable.
    const after = await readSession(resolveFeatureDir(dir, 'taken'));
    assert.equal(after?.phase, 'asking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reset with confirm:true frees the name so a start succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-reset2-'));
  try {
    const { runner } = scriptedAgent([
      { round: 1, questions: [{ id: 'q1', title: 'T', body: '', recommended: 'R' }] },
      { round: 1, questions: [{ id: 'q1', title: 'Second try', body: '', recommended: 'R' }] },
    ]);
    await startSession(ports(runner), { repoRoot: dir, feature: 'taken', idea: IDEA });
    // Refused while it exists. This is the dead end the reset exists to open.
    await assert.rejects(
      () => startSession(ports(runner), { repoRoot: dir, feature: 'taken', idea: IDEA }),
      (err: unknown) => err instanceof SessionError && err.status === 409,
    );

    const result = await resetSession({ repoRoot: dir, feature: 'taken', confirm: true });
    assert.equal(result.removed, true);

    const state = await startSession(ports(runner), { repoRoot: dir, feature: 'taken', idea: IDEA });
    assert.equal(state.phase, 'asking');
    assert.equal(state.pending?.questions[0]?.title, 'Second try');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reset refuses a slug that is not a plain name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-reset3-'));
  try {
    await mkdir(join(dir, '.scratch'), { recursive: true });
    for (const bad of ['../escape', '..', 'a/b', '']) {
      await assert.rejects(
        () => resetSession({ repoRoot: dir, feature: bad, confirm: true }),
        SessionError,
        `accepted ${bad}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reset refuses to touch a file, and reports a name that is not there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-reset4-'));
  try {
    await mkdir(join(dir, '.scratch'), { recursive: true });
    await writeFile(join(dir, '.scratch', 'a-file'), 'not a directory', 'utf8');

    await assert.rejects(
      () => resetSession({ repoRoot: dir, feature: 'a-file', confirm: true }),
      (err: unknown) => err instanceof SessionError && err.status === 409,
    );
    // And a file it refused to touch is still there.
    assert.equal(await readFile(join(dir, '.scratch', 'a-file'), 'utf8'), 'not a directory');

    await assert.rejects(
      () => resetSession({ repoRoot: dir, feature: 'never-existed', confirm: true }),
      (err: unknown) => err instanceof SessionError && err.status === 404,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
