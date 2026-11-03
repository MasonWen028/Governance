import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  DEFAULT_PACKS,
  boundElsewhere,
  entryBySlot,
  packById,
  resolvePack,
  substitutionCandidates,
  verifySkill,
} from '../src/skills/packs.js';
import type { PackEntry } from '../src/skills/packs.js';
import { InstallError, installSlot, readInstalledSkills } from '../src/skills/install.js';

/**
 * The packs exist to answer one question: does the skill bound to a slot do that
 * slot's job? A name is not evidence, so these tests feed real `SKILL.md` text
 * through the contracts and pin the answers.
 *
 * The first test is the one the whole design was bought with: `agentic-actions-
 * auditor` is a *security* skill with "auditor" in its name, and the quality-gate
 * layer is a *design* review. Binding one to the other is the mistake that is
 * invisible from a settings file and obvious from the skill's own first sentence.
 */

/* Verbatim from trailofbits/skills — the description is the real one. */
const AGENTIC_AUDITOR = `---
name: agentic-actions-auditor
description: Audits GitHub Actions workflows for security vulnerabilities in AI agent integrations. Detects misconfigurations and attack vectors specific to Claude Code Action, Gemini CLI, OpenAI Codex, and GitHub AI Inference when used in CI/CD pipelines.
---

# agentic-actions-auditor

Analyzes workflow YAML files for vulnerabilities arising from AI agent
integrations. Attacker-controlled input can reach an agent running with elevated
permissions in CI. Produces a findings report with severity ratings.
`;

const FRONTEND_DESIGN = `---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Sets typography, colour, and layout for web pages and components.
---

# frontend-design

Choose a direction, then hold to it. Type scale, colour palette, spacing, and
composition are decided once and applied everywhere.
`;

const HIG_FOUNDATIONS = `---
name: hig-foundations
description: Apple Human Interface Guidelines foundations — design principles, typography, colour, layout, materials, and accessibility for Apple platforms.
---

# hig-foundations

Start from the principles, then choose components. Contrast ratios, touch
targets, and dynamic type are part of the foundation, not a later pass.
`;

const POLISH = `---
name: make-interfaces-feel-better
description: An agent skill that helps make your interface feel better — the small details of finish and interaction that make a UI feel considered.
---

# make-interfaces-feel-better

Subtle transitions, optical alignment, and consistent spacing. Polish is what is
left when nothing is obviously wrong.
`;

const MOTION = `---
name: emil-design-eng
description: Design engineering principles for polished UI — animations, typography, surfaces, micro-interactions.
---

# emil-design-eng

Easing curves, spring physics, and duration. Motion should explain, not decorate.
`;

/* Verbatim from anmolnagpal/devops-skills. Adjacent layers, deliberately not
 * interchangeable: `deploy` decides how to ship, `ci` builds the machinery. */
const DEPLOY_SKILL = `---
name: deploy
description: "Deployment strategy, production-readiness gating, and rollback planning for AWS/EKS services. Use when user says 'how should I deploy this', 'blue-green or canary', 'are we ready to ship', 'production readiness', 'plan a rollback', 'pre-deploy check', or before a first production release. Pairs with /k8s, /ci, /github-actions, /tf which own the per-artifact checks."
---

# deploy
`;

const CI_SKILL = `---
name: ci
description: "GitLab CI/CD pipeline review and scaffolding for Terraform and Helm/EKS deployments, including individual stages, jobs, manual gates on prod stages, and pipeline credentials. Use when user says 'review my pipeline', 'check my gitlab-ci', 'scaffold a pipeline', 'is my CI correct', 'is my pipeline gated before prod', 'add a stage', 'add a deploy job', 'add a helm deploy stage', 'my pipeline leaks credentials', 'why does staging deploy with prod credentials', 'staging and prod share a job', or when working in .gitlab-ci.yml files. Anything expressed as a pipeline, stage, or job belongs here."
---

# ci
`;

/* Verbatim from findscripter/everything-skills — the interface review written in
 * Chinese that the English-only gate contract used to refuse. */
const DESIGN_CRITIQUE = `---
name: design-critique
description: 当需要对界面/原型/视觉稿做结构化设计评审时使用；按可用性·层级·一致性·无障碍多维度产出带严重度分级和优先级建议的评审报告；不适用于纯代码实现、文案校对或无设计稿的需求讨论。触发词：评审这个设计、critique mockup、Figma 链接反馈
---

# design-critique
`;

function installedMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

test('a security auditor is refused by the design quality gate', () => {
  const entry = entryBySlot('design-stack', 'design.gate');
  assert.ok(entry !== null);
  const verdict = verifySkill('agentic-actions-auditor', AGENTIC_AUDITOR, entry.contract);

  assert.equal(verdict.status, 'mismatch');
  /* Vetoed, not merely outscored. A score alone could be argued with; this is a
   * statement about what the skill is for. */
  assert.ok(verdict.rejected.length > 0, 'the veto should have fired');
  assert.ok(
    verdict.rejected.some((r) => r.includes('GitHub Actions')),
    `expected a GitHub Actions veto, got: ${verdict.rejected.join('; ')}`,
  );
  assert.deepEqual(verdict.reasons, [], 'a rejected skill has no reasons in its favour');
});

test('and it is refused by every other design layer too', () => {
  const pack = packById('design-stack');
  assert.ok(pack !== null);
  for (const entry of pack.entries) {
    const verdict = verifySkill('agentic-actions-auditor', AGENTIC_AUDITOR, entry.contract);
    assert.equal(verdict.status, 'mismatch', `${entry.slot} should refuse it`);
  }
});

test('the same skill is exactly what the audit slot wants', () => {
  const entry = entryBySlot('devops-suite', 'devops.audit');
  assert.ok(entry !== null);
  const verdict = verifySkill('agentic-actions-auditor', AGENTIC_AUDITOR, entry.contract);
  assert.equal(verdict.status, 'match');
  assert.deepEqual(verdict.rejected, []);
  assert.ok(verdict.reasons.some((r) => r.includes('audits security')));
});

test('a design skill is refused by a delivery slot', () => {
  const entry = entryBySlot('devops-suite', 'devops.image');
  assert.ok(entry !== null);
  const verdict = verifySkill('frontend-design', FRONTEND_DESIGN, entry.contract);
  assert.equal(verdict.status, 'mismatch');
  assert.ok(verdict.rejected.some((r) => r.includes('type')));
});

test('the named skills match the slots they are meant for', () => {
  const cases: [string, string, string][] = [
    ['design-stack', 'design.visual', FRONTEND_DESIGN],
    ['design-stack', 'design.foundation', HIG_FOUNDATIONS],
    ['design-stack', 'design.polish', POLISH],
    ['design-stack', 'design.interaction', MOTION],
  ];
  for (const [packId, slot, text] of cases) {
    const entry = entryBySlot(packId, slot);
    assert.ok(entry !== null, slot);
    const verdict = verifySkill(slot, text, entry.contract);
    assert.equal(verdict.status, 'match', `${slot} should accept its own skill: ${JSON.stringify(verdict)}`);
  }
});

test('a not-installed skill is missing, which is not the same as wrong', () => {
  const entry = entryBySlot('design-stack', 'design.visual');
  assert.ok(entry !== null);
  const verdict = verifySkill('frontend-design', null, entry.contract);
  assert.equal(verdict.status, 'missing');
});

test('a description counts double against the same words in the body', () => {
  const entry = entryBySlot('design-stack', 'design.visual');
  assert.ok(entry !== null);
  const inDescription = verifySkill(
    'a',
    `---\ndescription: typography, colour, layout, visual direction\n---\n\nShort body.`,
    entry.contract,
  );
  const inBody = verifySkill(
    'b',
    `---\ndescription: nothing\n---\n\ntypography, colour, layout, visual direction`,
    entry.contract,
  );
  assert.ok(
    inDescription.score > inBody.score,
    `${inDescription.score} should beat ${inBody.score}`,
  );
});

/* Every catalogue slot now has a verified upstream, so the "no source" path is
 * exercised with a synthetic entry: the behaviour still has to hold for the next
 * slot somebody adds before finding a repository for it. */
const ORPHAN: PackEntry = {
  slot: 'test.orphan',
  layer: 1,
  required: true,
  wants: ['nothing'],
  source: null,
  unresolved: 'no upstream exists for this',
  contract: { mustMatch: [], mustNotMatch: [], minScore: 1 },
};

test('a slot with no verified source resolves as unresolved, not as missing', () => {
  const state = resolvePack(
    { id: 'test', title: 'test', entries: [ORPHAN] },
    { installed: new Map() },
  );
  const slot = state.entries[0];
  assert.ok(slot !== undefined);
  assert.equal(slot.status, 'unresolved');
  assert.ok((slot.unresolved ?? '').length > 0, 'the interface needs the reason to show');
  assert.equal(state.ready, false, 'an unfillable slot must not read as ready');
});

test('every catalogue slot names a repository it can be installed from', () => {
  /* The inverse of the test above: the shipped packs should not contain an
   * orphan, because an orphan is a slot the user can only fix by hand. */
  for (const pack of DEFAULT_PACKS) {
    for (const entry of pack.entries) {
      assert.ok(entry.source !== null, `${entry.slot} has no source`);
      assert.ok((entry.source?.expect.length ?? 0) > 0, `${entry.slot} expects no directory`);
    }
  }
});

test('a high score does not save a skill that never claims the job', () => {
  /* The real description of `brooks-design-lint`, which scores 10 against the
   * quality-gate slot — above its threshold of 6 — and is still refused, because
   * "设计层审查" is a review of code architecture and it never says it reviews an
   * interface. This is the case that a scoring model alone cannot express. */
  const entry = entryBySlot('design-stack', 'design.gate');
  assert.ok(entry !== null);
  const verdict = verifySkill(
    'brooks-design-lint',
    `---\nname: brooks-design-lint\ndescription: 当需要超越 linter 的架构与设计层审查（重构前、新模块设计评审、接手陌生代码）时使用；以 12 本经典软工书籍为视角，产出按书籍/严重度分级的坏味、耦合、稳定性与数据一致性问题。\n---\n\nBody.\n`,
    entry.contract,
  );
  assert.ok(verdict.score >= entry.contract.minScore, `expected a passing score, got ${verdict.score}`);
  assert.equal(verdict.status, 'mismatch');
});

/* Verbatim from DietrichGebert/ponytail. The slot's job is the smallest change
 * that fully solves the task — the user asked for it as "控制 token 的使用和简洁
 * 代码", and this description is that job in the author's own words. */
const PONYTAIL = `---
name: ponytail
description: >
  Lazy senior dev mode: the smallest change that fully solves the task, and a
  reply a busy human understands in one read. Use on any coding task (writing,
  fixing, refactoring, reviewing, choosing dependencies) and when the user says
  "ponytail", "be lazy", "simplest solution", "yagni", or complains about
  over-engineering or bloat. Levels: lite, full (default), ultra.
---

# ponytail
`;

/* The sibling review pass. It says "is every line needed" — close, but it is a
 * one-shot review of a change, not the standing discipline that a slot is bound
 * to, and its description never commits to the smallest change. */
const PONYTAIL_REVIEW = `---
name: ponytail-review
description: >
  Quality review of a change: is the logic right, is it safe, does it hold
  under real load, is risky code tested, is it fast enough, and is every line
  needed. Reads the connected code, not only the diff. Each finding is
  explained in plain English. Use for "review this", "code review", "review
  the last commit", "review my PR", "is this over-engineered", /ponytail-review.
---

# ponytail-review
`;

test('the brevity slot takes the skill that promises the smallest change', () => {
  const entry = entryBySlot('code-discipline', 'code.brevity');
  assert.ok(entry !== null);
  const verdict = verifySkill('ponytail', PONYTAIL, entry.contract);
  assert.equal(verdict.status, 'match', verdict.rejected.join('; '));

  /* The sibling is a review pass, not the discipline. It mentions code and even
   * "every line needed", but never commits to writing less — and without the
   * commitment one review skill after another would qualify. */
  const review = verifySkill('ponytail-review', PONYTAIL_REVIEW, entry.contract);
  assert.equal(review.status, 'mismatch', 'a review pass is not the brevity discipline');
  assert.ok(
    review.rejected.some((r) => r.includes('writing less')),
    `expected the mustInclude refusal, got: ${[...review.reasons, ...review.rejected].join('; ')}`,
  );
});

test('the release layer asks how to ship, not how to promote', () => {
  /* Layers 2 and 4 are adjacent and both talk about production, so the risk is
   * that they collapse into one job and `/ci` substitutes into both. The split:
   * layer 2 owns the mechanics (a deploy stage, a job, which credentials), and
   * layer 4 owns the decision (strategy, readiness, rollback).
   *
   * The first version of this contract asked layer 4 for "moves a build between
   * environments" and refused `deploy` — the skill the catalogue names — for not
   * saying it. Both descriptions below are verbatim. */
  const entry = entryBySlot('devops-suite', 'devops.release');
  assert.ok(entry !== null);

  const deploy = verifySkill('deploy', DEPLOY_SKILL, entry.contract);
  assert.equal(deploy.status, 'match', deploy.reasons.join('; '));

  /* `/ci` says "deploy job", "staging deploy with prod credentials" and "gated
   * before prod" — mechanical promotion, in the layer below. It must not pass
   * here, or one skill fills two layers of the same stack. */
  const ci = verifySkill('ci', CI_SKILL, entry.contract);
  assert.equal(ci.status, 'mismatch', 'ci must not also fill the release layer');
  assert.ok(
    ci.rejected.some((r) => r.includes('ship safely')),
    `expected the mustInclude refusal, got: ${[...ci.reasons, ...ci.rejected].join('; ')}`,
  );

  /* And the layer below keeps its own skill, so the exclusion is not symmetric
   * by accident: `deploy` does not pass the pipeline contract either. */
  const pipeline = entryBySlot('devops-suite', 'devops.pipeline');
  assert.ok(pipeline !== null);
  assert.equal(verifySkill('deploy', DEPLOY_SKILL, pipeline.contract).status, 'mismatch');
  assert.equal(verifySkill('ci', CI_SKILL, pipeline.contract).status, 'match');
});

test('a Chinese-language interface review fills the quality gate', () => {
  /* `design-critique` is the skill that made the "no upstream" claim wrong, and
   * it is written in Chinese. An earlier gate contract read only English and
   * refused it for that reason while reporting that its content was wrong. */
  const entry = entryBySlot('design-stack', 'design.gate');
  assert.ok(entry !== null);
  const verdict = verifySkill('design-critique', DESIGN_CRITIQUE, entry.contract);
  assert.equal(verdict.status, 'match', verdict.rejected.join('; '));
});

test('a pack is ready only when every required slot is filled and checked', () => {
  const pack = packById('design-stack');
  assert.ok(pack !== null);
  const missing = resolvePack(pack, { installed: new Map() });
  assert.equal(missing.ready, false);
  assert.equal(missing.satisfied, 0);

  const full = resolvePack(pack, {
    installed: installedMap({
      'hig-foundations': HIG_FOUNDATIONS,
      'frontend-design': FRONTEND_DESIGN,
      'emil-design-eng': MOTION,
      'design-critique': DESIGN_CRITIQUE,
      'make-interfaces-feel-better': POLISH,
    }),
  });
  assert.equal(full.required, 5);
  assert.equal(full.satisfied, 5);
  assert.equal(full.ready, true);

  /* One missing layer is enough to hold the whole pack back, even though every
   * other slot is filled. That is what "required" means here. */
  const noGate = resolvePack(pack, {
    installed: installedMap({
      'hig-foundations': HIG_FOUNDATIONS,
      'frontend-design': FRONTEND_DESIGN,
      'emil-design-eng': MOTION,
      'make-interfaces-feel-better': POLISH,
    }),
  });
  assert.equal(noGate.satisfied, 4);
  assert.equal(noGate.ready, false);
});

test('an installed skill by the right name but the wrong contents is reported, not used', () => {
  const pack = packById('design-stack');
  assert.ok(pack !== null);
  const resolved = resolvePack(pack, {
    installed: installedMap({ 'frontend-design': AGENTIC_AUDITOR }),
  });
  const visual = resolved.entries.find((e) => e.slot === 'design.visual');
  assert.ok(visual !== undefined);
  assert.equal(visual.status, 'mismatch');
  assert.equal(visual.skill, null, 'a mismatched skill must not fill the slot');
});

test('a substitution is honoured when it passes and dropped when it does not', () => {
  const pack = packById('design-stack');
  assert.ok(pack !== null);

  const substituted = resolvePack(pack, {
    installed: installedMap({ 'hig-foundations': HIG_FOUNDATIONS }),
    substitutions: { 'design.foundation': 'hig-foundations' },
  });
  const foundation = substituted.entries.find((e) => e.slot === 'design.foundation');
  assert.ok(foundation !== undefined);
  assert.equal(foundation.status, 'substituted');
  assert.equal(foundation.substituted, true);

  /* Same substitution, but the skill behind the name is now the auditor — a
   * hand edit, or a directory swapped underneath. The claim is checked again. */
  const broken = resolvePack(pack, {
    installed: installedMap({ 'hig-foundations': AGENTIC_AUDITOR }),
    substitutions: { 'design.foundation': 'hig-foundations' },
  });
  const fallback = broken.entries.find((e) => e.slot === 'design.foundation');
  assert.ok(fallback !== undefined);
  assert.notEqual(fallback.status, 'substituted');
  assert.equal(fallback.skill, null);
});

test('the substitution picker offers only what the checker would accept', () => {
  const candidates = substitutionCandidates(
    'design-stack',
    'design.gate',
    installedMap({
      'agentic-actions-auditor': AGENTIC_AUDITOR,
      'frontend-design': FRONTEND_DESIGN,
      'hig-foundations': HIG_FOUNDATIONS,
    }),
  );
  /* None of these is a design review, so the list is empty — and that is the
   * correct answer, not a bug. A picker offering the auditor would be inviting
   * the exact mistake this module exists to prevent. */
  assert.deepEqual(candidates, []);
});

test('a skill that merely uses the words is not accepted', () => {
  /* Six real skills, six real descriptions, six false positives the first
   * draft produced. Kept verbatim because the words that fooled it are the
   * point: "feels right" is not finishing work, and "workflows" is not GitHub
   * Actions. An additive score admits all six; the declared-subject rule is what
   * refuses them. */
  const cases: [string, string, string][] = [
    [
      'design.polish',
      'prototype',
      'Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.',
    ],
    [
      'design.polish',
      'tdd',
      'Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.',
    ],
    [
      'design.visual',
      'ask-matt',
      'Ask which skill or flow fits your situation. A router over the skills in this repo.',
    ],
    [
      'devops.workflows',
      'loop-me',
      'Grill me about specs for the workflows I want to build, within this workspace.',
    ],
    [
      'devops.pipeline',
      'wizard',
      'Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets.',
    ],
    [
      'design.gate',
      'code-review',
      'Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards and Spec. Runs both reviews in parallel sub-agents.',
    ],
  ];
  for (const [slot, id, description] of cases) {
    const entry = entryBySlot('design-stack', slot) ?? entryBySlot('devops-suite', slot);
    assert.ok(entry !== null, slot);
    const verdict = verifySkill(id, `---\nname: ${id}\ndescription: ${description}\n---\n\nBody.\n`, entry.contract);
    assert.equal(verdict.status, 'mismatch', `${id} must not fill ${slot}`);
  }
});

test('every design slot of the real stack is filled by its own skill', () => {
  /* The four skills that do exist upstream, checked as a set: filling the whole
   * stack must work once they are installed, or the tightening above went too
   * far. */
  const pack = packById('design-stack');
  assert.ok(pack !== null);
  const installed = installedMap({
    'hig-foundations': HIG_FOUNDATIONS,
    'frontend-design': FRONTEND_DESIGN,
    'emil-design-eng': MOTION,
    'make-interfaces-feel-better': POLISH,
  });
  for (const entry of pack.entries) {
    if (entry.slot === 'design.gate') continue; // no upstream exists
    const verdict = verifySkill(
      entry.wants[0] ?? '',
      installed.get(entry.wants[0] ?? '') ?? null,
      entry.contract,
    );
    assert.equal(verdict.status, 'match', `${entry.slot}: ${JSON.stringify(verdict)}`);
  }
});

test('a description written as a YAML block still counts', () => {
  /* The shape `hig-foundations` actually uses, and the one that broke the first
   * reader: matching `^description:` alone captures the marker `>-` and drops
   * the sentence underneath it. */
  const folded = `---
name: hig-foundations
version: 1.0.0
description: >-
  Apple Human Interface Guidelines design foundations. Use this skill when the
  user asks about "HIG color", "Apple typography", "SF Symbols", or dark mode.
license: MIT
---

# hig-foundations

Principles first.
`;
  const entry = entryBySlot('design-stack', 'design.foundation');
  assert.ok(entry !== null);
  const verdict = verifySkill('hig-foundations', folded, entry.contract);
  assert.equal(verdict.status, 'match', JSON.stringify(verdict));
  assert.ok(
    verdict.reasons.some((r) => r.includes('in its own description')),
    'the folded description is the description, not the body',
  );

  /* And the marker itself is not content: a skill whose only claim is `>-`
   * must not pass. */
  const empty = `---\nname: x\ndescription: >-\n---\n\nBody about typography.\n`;
  const refused = verifySkill('x', empty, entry.contract);
  assert.equal(refused.status, 'mismatch');
});

test('a skill already filling one layer is not offered for another', () => {
  /* `hig-foundations` discusses motion and type, so it passed the contracts for
   * both the visual-direction and interaction layers — and outscored the
   * intended skill for the first. The five layers are different jobs; one skill
   * answering three of them recreates the single vague "design skill" the stack
   * was split out of. */
  const pack = packById('design-stack');
  assert.ok(pack !== null);
  const installed = installedMap({
    'hig-foundations': HIG_FOUNDATIONS,
    'frontend-design': FRONTEND_DESIGN,
    'emil-design-eng': MOTION,
    'make-interfaces-feel-better': POLISH,
  });
  const resolved = resolvePack(pack, { installed });

  const forVisual = boundElsewhere(resolved.entries, 'design.visual');
  assert.ok(forVisual.has('hig-foundations'), 'the foundation layer holds it');
  assert.ok(!forVisual.has('frontend-design'), 'the slot itself may still offer its own');

  const alts = substitutionCandidates('design-stack', 'design.visual', installed, forVisual)
    .map((c) => c.id);
  assert.ok(!alts.includes('hig-foundations'), `offered anyway: ${alts.join(', ')}`);
  assert.ok(alts.includes('frontend-design'));
});

test('every slot id in every pack is unique and namespaced', () => {
  const seen = new Set<string>();
  for (const pack of DEFAULT_PACKS) {
    for (const entry of pack.entries) {
      assert.ok(!seen.has(entry.slot), `duplicate slot: ${entry.slot}`);
      seen.add(entry.slot);
      assert.ok(
        entry.slot.startsWith(`${pack.id.split('-')[0]}.`),
        `${entry.slot} is not namespaced under ${pack.id}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* Installing                                                          */
/* ------------------------------------------------------------------ */

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gov-packs-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A clone that writes a checkout instead of reaching the network. */
function fakeClone(files: Record<string, string>) {
  return async (_url: string, dest: string): Promise<void> => {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dest, rel);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, body, 'utf8');
    }
  };
}

test('a skill is found by name wherever the repository puts it', async () => {
  const skillsRoot = join(dir, 'root-a');
  const entry = entryBySlot('design-stack', 'design.visual');
  assert.ok(entry !== null);

  const result = await installSlot(entry, skillsRoot, {
    tempRoot: dir,
    clone: fakeClone({ 'plugins/x/skills/frontend-design/SKILL.md': FRONTEND_DESIGN }),
  });
  assert.equal(result.status, 'installed');
  assert.equal(result.skill, 'frontend-design');
  const saved = await readFile(join(skillsRoot, 'frontend-design', 'SKILL.md'), 'utf8');
  assert.equal(saved, FRONTEND_DESIGN);
});

test('the shallowest match wins when a repository carries two copies', async () => {
  const skillsRoot = join(dir, 'root-b');
  const entry = entryBySlot('design-stack', 'design.visual');
  assert.ok(entry !== null);

  const result = await installSlot(entry, skillsRoot, {
    tempRoot: dir,
    clone: fakeClone({
      'frontend-design/SKILL.md': FRONTEND_DESIGN,
      'examples/vendored/frontend-design/SKILL.md': 'not the real one',
    }),
  });
  assert.equal(result.skill, 'frontend-design');
  const saved = await readFile(join(skillsRoot, 'frontend-design', 'SKILL.md'), 'utf8');
  assert.equal(saved, FRONTEND_DESIGN, 'the root copy is the skill, the vendored one is an example');
});

test('a second install keeps what is already there', async () => {
  const skillsRoot = join(dir, 'root-c');
  const entry = entryBySlot('design-stack', 'design.polish');
  assert.ok(entry !== null);
  const options = {
    tempRoot: dir,
    clone: fakeClone({ 'make-interfaces-feel-better/SKILL.md': 'mine, edited' }),
  };

  await installSlot(entry, skillsRoot, options);
  await writeFile(join(skillsRoot, 'make-interfaces-feel-better', 'SKILL.md'), 'edited by hand');

  const second = await installSlot(entry, skillsRoot, options);
  assert.equal(second.status, 'kept');
  const saved = await readFile(join(skillsRoot, 'make-interfaces-feel-better', 'SKILL.md'), 'utf8');
  assert.equal(saved, 'edited by hand', 'an installer must not overwrite local edits');
});

test('a repository without the expected skill fails instead of installing something else', async () => {
  const skillsRoot = join(dir, 'root-d');
  const entry = entryBySlot('design-stack', 'design.visual');
  assert.ok(entry !== null);
  await assert.rejects(
    () =>
      installSlot(entry, skillsRoot, {
        tempRoot: dir,
        clone: fakeClone({ 'README.md': '# something else' }),
      }),
    (err: Error) => err instanceof InstallError && err.message.includes('does not contain'),
  );
});

test('a slot with no verified source refuses to install at all', async () => {
  await assert.rejects(
    () => installSlot(ORPHAN, join(dir, 'root-e'), { tempRoot: dir }),
    (err: Error) => err instanceof InstallError && err.message === 'no upstream exists for this',
  );
});

test('a directory without a SKILL.md is not a skill', async () => {
  const root = join(dir, 'root-f');
  await mkdir(join(root, 'not-a-skill'), { recursive: true });
  await writeFile(join(root, 'not-a-skill', 'README.md'), '# not a skill');
  await mkdir(join(root, 'real-skill'), { recursive: true });
  await writeFile(join(root, 'real-skill', 'SKILL.md'), POLISH);

  const found = await readInstalledSkills(root);
  assert.deepEqual([...found.keys()], ['real-skill']);
  assert.ok((await stat(join(root, 'not-a-skill'))).isDirectory());
});
