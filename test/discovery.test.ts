import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DISCOVERY_PHASES, phasePrompt, producedFiles } from '../src/tracker/discovery.js';

/* Bringing an existing codebase in. The prompts are what decide whether the
 * agent uses the skill or improvises something that reads like it did, so they
 * are asserted here rather than trusted — a prompt that stopped naming the
 * skill would still "work", and that is the failure worth catching. */

const CTX = {
  target: 'H:\\Projects\\acme',
  skillPath: 'C:/Users/Administrator/.agents/skills/codebase-discovery/SKILL.md',
  outputRoot: 'docs/discovery',
};

test('the passes run in the order the human named them', () => {
  assert.deepEqual(
    DISCOVERY_PHASES.map((p) => p.id),
    ['discovery', 'architecture', 'feature-mapping'],
  );
  for (const p of DISCOVERY_PHASES) {
    assert.ok(p.purpose.length > 0, `${p.id} has no line for the interface to show`);
  }
});

test('every pass addresses the skill as a file, and settles the mode itself', () => {
  for (const phase of DISCOVERY_PHASES) {
    const prompt = phasePrompt(phase, CTX);
    /* The skill is addressed by path, not by `/codebase-discovery`. A slash
     * command is a convention of one CLI; this tool does not know which CLI is
     * in front of it, and a name that one does not implement means the agent
     * never opens the skill — it writes a plausible essay instead, which is the
     * most expensive artefact here because it reads like evidence. */
    assert.ok(prompt.includes(CTX.skillPath), `${phase.id} does not give the skill's path`);
    assert.ok(prompt.includes('SKILL.md'), `${phase.id} does not name the skill file`);
    assert.ok(/read the skill at/i.test(prompt), `${phase.id} does not say to follow it`);
    assert.ok(prompt.includes('docs/discovery'), `${phase.id} does not say where to write`);
    /* The output root and the mode are stated as decisions already made, not as
     * `--output` / `code-only` flags: no configured CLI is obliged to implement
     * the skill's slash-command arguments, and the skill's own instructions
     * accept the prose form. */
    assert.ok(!prompt.includes('--output'), `${phase.id} still depends on a flag no CLI implements`);
    assert.ok(prompt.includes('code-only'), `${phase.id} does not settle the mode`);
    assert.ok(/do not stop to ask/i.test(prompt),
      `${phase.id} leaves the agent to ask a human who is not there`);
    assert.ok(prompt.includes('interview'), `${phase.id} does not name the phase to avoid`);
  }
});

test('a pass reads the code and does not change it', () => {
  const prompt = phasePrompt(DISCOVERY_PHASES[0]!, CTX);
  assert.ok(prompt.includes(CTX.target), 'the pass does not say what to read');
  assert.ok(/do not move, delete or rewrite/i.test(prompt),
    'nothing stops the pass from editing the code it was asked to read');
  assert.ok(/this pass reads the code/i.test(prompt));
});

test('a pass says what it is, and asks for honesty about what it could not find', () => {
  const mapping = phasePrompt(DISCOVERY_PHASES[2]!, CTX);
  assert.ok(mapping.includes('feature-mapping'), 'the pass does not name itself');
  assert.ok(/could not determine/i.test(mapping),
    'a pass that fills every gap by guessing poisons the pass after it');
  assert.ok(/empty placeholders/i.test(mapping),
    'the skill writes only what has content; the prompt must not undo that');
});

test('producedFiles reports what exists and says nothing about what does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-discovery-'));
  try {
    const docs = join(root, 'docs', 'discovery');
    await mkdir(join(docs, 'domain'), { recursive: true });
    await mkdir(join(docs, 'tech'), { recursive: true });
    await writeFile(join(docs, 'domain', 'domain-model.md'), '# model\n', 'utf8');
    await writeFile(join(docs, 'tech', 'integrations.md'), '# integrations\n', 'utf8');

    const files = await producedFiles(root, 'docs/discovery');
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, [
      'docs/discovery/domain/domain-model.md',
      'docs/discovery/tech/integrations.md',
    ]);
    assert.ok(files.every((f) => f.bytes > 0));

    /* The property that matters: the display is built from what is on disk,
     * never from the `expects` list. A pass that wrote one file must not be
     * reported as having written four. */
    const missing = await producedFiles(root, 'docs/nowhere');
    assert.deepEqual(missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file that landed somewhere unexpected is still shown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-discovery-walk-'));
  try {
    /* The skill nests its own layout, and guessing where is the one bet this
     * module refuses to make. A file outside the expected list is still a file
     * the human should see. */
    await mkdir(join(root, 'docs', 'discovery', 'something-else'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'discovery', 'something-else', 'surprise.md'),
      '# surprise\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'discovery', 'not-markdown.txt'), 'ignore me', 'utf8');

    const files = await producedFiles(root, 'docs/discovery');
    assert.deepEqual(files.map((f) => f.path), ['docs/discovery/something-else/surprise.md']);

    // Capped, so a large system cannot turn the display into a directory dump.
    const many = await producedFiles(root, 'docs/discovery', 0);
    assert.deepEqual(many, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the walk does not follow a symlinked directory out of the output root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-discovery-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'gov-discovery-outside-'));
  try {
    await mkdir(join(root, 'docs', 'discovery'), { recursive: true });
    await writeFile(join(outside, 'far-away.md'), '# outside\n', 'utf8');
    await symlink(outside, join(root, 'docs', 'discovery', 'linked'), 'dir');
    const files = await producedFiles(root, 'docs/discovery');
    assert.deepEqual(files, [], 'a link is not a directory to walk into');

    /* The case the directory link cannot decide. `withFileTypes` already keeps a
     * link out of the recursion and out of `dirs` — removing the explicit
     * isSymbolicLink check above changed nothing about a link named `linked`,
     * which is how it became clear this was the shape that actually tests it.
     *
     * It matters because the display says "this pass wrote this file": a link
     * named `escape.md` would be reported at a path inside the project while the
     * bytes live somewhere else entirely. That is the same fiction the rest of
     * the module refuses to tell. */
    await symlink(join(outside, 'far-away.md'), join(root, 'docs', 'discovery', 'escape.md'), 'file');
    const withLink = await producedFiles(root, 'docs/discovery');
    assert.deepEqual(withLink, [], 'a linked file is not a file this pass wrote');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
