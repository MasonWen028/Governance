import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentResult, AgentRunner, AgentTurn } from './agent.js';

/**
 * A demo agent.
 *
 * Exists so the flow can be exercised without a working agent: no credential, no
 * spend, no network. Two reasons that is worth having rather than a nicety:
 *
 * 1. **Verification.** The real CLI needs to be installed *and* authenticated, and
 *    those are different failures. Without this, "log in first" blocks a person
 *    from seeing whether the flow itself works.
 * 2. **Diagnosis.** When something is wrong, it separates the two halves. If the
 *    flow works here and not with the real agent, the problem is the agent.
 *
 * It is deliberately honest about what it is: every turn says it is a demo, and
 * `serve` prints a banner. A demo that looked like the real thing would be worse
 * than no demo, because a session produced by it would be indistinguishable from
 * a session produced by an agent.
 */

const DEMO_MARK = 'this turn was produced by the demo agent, not by a real one';

interface RoundSpec {
  readonly questions: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly why: string;
    readonly recommended: string;
    readonly options?: readonly string[];
  }[];
  readonly glossary?: readonly { readonly word: string; readonly meaning: string }[];
  readonly adr?: { readonly n: string; readonly title: string; readonly body: string };
}

/**
 * The rounds, written to read like real ones.
 *
 * The content is plausible but generic on purpose: it is a demonstration of the
 * shape, and pretending to have understood a particular idea would be a lie the
 * human might act on.
 */
const ROUNDS: readonly RoundSpec[] = [
  {
    questions: [
      {
        id: 'q1',
        title: 'Who is this for, and how many of them are there?',
        body:
          'A tool for one person and a tool for a team differ in almost everything ' +
          'downstream: accounts, sharing, permissions, and how much needs to be ' +
          'explained on screen.',
        why: 'Nothing is settled yet, so this can be asked first.',
        recommended: 'One person, run locally.',
        options: ['One person, run locally', 'A small team, shared', 'Something public'],
      },
      {
        id: 'q2',
        title: 'What is the one thing it must do well?',
        body:
          'Not everything it might do. The single behaviour that, if it were poor, ' +
          'would make the rest pointless.',
        why: 'Independent of who uses it.',
        recommended: 'Answer the question it was built for, quickly.',
      },
      {
        id: 'q3',
        title: 'What already exists that it has to live with?',
        body:
          'An existing system, a format, a habit. Knowing what cannot change is ' +
          'usually more useful than knowing what could.',
        why: 'Independent of the two above.',
        recommended: 'Nothing — it can be built fresh.',
        options: [
          'Nothing — it can be built fresh',
          'An existing tool it must fit around',
          'Data in a format that is fixed',
        ],
      },
    ],
    glossary: [
      { word: 'feature', meaning: 'one body of work with a single destination' },
      { word: 'round', meaning: 'one pass of questions over the current frontier' },
    ],
  },
  {
    questions: [
      {
        id: 'q1',
        title: 'How would you know it was working?',
        body:
          'The observable thing that tells you the problem is solved, rather than ' +
          'the feature being present.',
        why: 'Answerable now that the audience and the core behaviour are settled.',
        recommended: 'You stop doing the manual thing it replaced.',
      },
      {
        id: 'q2',
        title: 'What is the smallest version that is worth having?',
        body:
          'The version where, if it were all you ever built, you would not regret it.',
        why: 'Follows from the core behaviour.',
        recommended: 'The core behaviour, on one machine, with no settings.',
      },
    ],
    glossary: [{ word: 'frontier', meaning: 'every question whose prerequisites are settled' }],
    adr: {
      n: '0001',
      title: 'Local-only until the core behaviour is settled',
      body:
        'Nothing is shared or hosted while the core behaviour is still moving.\n' +
        'Sharing multiplies the cost of every change, and there is no evidence yet\n' +
        'that this is worth sharing. Reversible: hosting can come later without\n' +
        'changing what the thing does.',
    },
  },
  {
    questions: [],
  },
];

const SPEC = (idea: string): string =>
  [
    '# Spec: a feature from the demo agent',
    '',
    '## Problem Statement',
    '',
    `The idea, as given: "${idea}"`,
    '',
    'Nothing yet does this, and doing it by hand is both slow and easy to forget.',
    '',
    '## Solution',
    '',
    'A single thing, run locally, that does the core behaviour well and nothing else.',
    '',
    '## User Stories',
    '',
    '1. As the only user, I want it to do the one thing it is for, so that I stop doing it by hand.',
    '2. As the only user, I want it to run without configuration, so that using it costs nothing.',
    '3. As the only user, I want it to be obvious when it is not working, so that I can trust it.',
    '',
    '## Implementation Decisions',
    '',
    '- Runs on one machine, for one person.',
    '- No accounts, no sharing, no hosting.',
    '- The core behaviour is the whole of the first version.',
    '',
    '## Testing Decisions',
    '',
    '- Test the core behaviour from the outside. It is the only part with a contract.',
    '- Do not test the glue; it has no behaviour worth asserting.',
    '',
    '## Test Seams',
    '',
    'One seam, at the boundary of the core behaviour, so it can be driven without',
    'its surroundings.',
    '',
    '## Out of Scope',
    '',
    '- Sharing, accounts, permissions.',
    '- Any hosted or background component.',
    '- Configuration beyond what one person needs.',
    '',
    '## Design',
    '',
    'Nothing is designed yet: this spec came from the demo agent, which does not',
    'resolve design. Run the design stage before slicing.',
    '',
    '## Further Notes',
    '',
    '**This spec was written by the demo agent.** It describes the shape of a PRD,',
    'not your actual project. Run the flow with a real agent for a real one.',
    '',
  ].join('\n');

const GLOSSARY = (): string =>
  [
    '# Demo feature',
    '',
    'A glossary produced by the demo agent. Explanatory, never normative.',
    '',
    '## Language',
    '',
    '**feature**:',
    'One body of work with a single destination.',
    '_Avoid_: project, task',
    '',
    '**round**:',
    'One pass of questions over the current frontier.',
    '',
    '**frontier**:',
    'Every question whose prerequisites are already settled.',
    '',
  ].join('\n');

function writeArtifact(
  dir: string,
  round: number,
  body: Record<string, unknown>,
): Promise<void> {
  const text = JSON.stringify(body, null, 2);
  return (async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${String(round).padStart(2, '0')}.json`), text, 'utf8');
    await writeFile(join(dir, 'latest.json'), text, 'utf8');
  })();
}

export interface DemoRunnerOptions {
  /** Where the demo writes, relative to the feature directory. */
  readonly sessionDir?: string;
}

/** A runner that produces plausible rounds without an agent. */
export function demoRunner(options: DemoRunnerOptions = {}): AgentRunner {
  const session = options.sessionDir ?? '.session';
  let round = 0;

  return {
    async run(turn: AgentTurn): Promise<AgentResult> {
      round += 1;
      const dir = join(turn.cwd, session);

      const isPrd = /Closing the session/.test(turn.prompt);
      if (isPrd) {
        await writeFile(join(turn.cwd, 'spec.md'), SPEC(ideaFrom(turn.prompt)), 'utf8');
        await writeFile(join(turn.cwd, 'GLOSSARY.md'), GLOSSARY(), 'utf8');
        // No ADR here. The decision was recorded in the round that produced it —
        // `domain-modeling` writes them as they crystallise, not in a batch at the
        // end. Writing it again here would also collide numbers, and an ADR
        // directory with two `0001`s is worse than one with no ADR at all.
        await writeArtifact(dir, round, {
          round,
          kind: 'prd',
          questions: [],
          glossaryWritten: [],
          adrsWritten: [],
          frontierEmpty: true,
        });
        return {
          ok: true,
          sessionId: 'demo',
          output: `Wrote spec.md.\n\n(${DEMO_MARK})`,
          error: null,
          phase: null,
          ms: 12,
        };
      }

      const spec = ROUNDS[Math.min(round - 1, ROUNDS.length - 1)]!;
      if (spec.glossary !== undefined) {
        await writeFile(join(turn.cwd, 'GLOSSARY.md'), GLOSSARY(), 'utf8');
      }
      if (spec.adr !== undefined) {
        await mkdir(join(turn.cwd, 'docs', 'adr'), { recursive: true });
        await writeFile(
          join(turn.cwd, 'docs', 'adr', `${spec.adr.n}-${slug(spec.adr.title)}.md`),
          `# ${spec.adr.title}\n\n${spec.adr.body}\n`,
          'utf8',
        );
      }

      await writeArtifact(dir, round, {
        round,
        kind: 'questions',
        questions: spec.questions,
        glossaryWritten: (spec.glossary ?? []).map((g) => g.word),
        adrsWritten: spec.adr === undefined ? [] : [`${spec.adr.n}-${slug(spec.adr.title)}.md`],
        frontierEmpty: spec.questions.length === 0,
      });

      return {
        ok: true,
        sessionId: 'demo',
        output: `Asked ${spec.questions.length} question(s).\n\n(${DEMO_MARK})`,
        error: null,
        phase: null,
        ms: 12,
      };
    },
  };
}

/** Pull the idea back out of the opening prompt, so the spec can quote it. */
function ideaFrom(prompt: string): string {
  const m = /^>\s*(.+)$/m.exec(prompt);
  return m?.[1]?.trim() ?? 'an idea';
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'decision'
  );
}
