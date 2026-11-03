import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { serve } from '../src/server/http.js';

/**
 * Skill packs over a real socket.
 *
 * The behaviour under test is a refusal: binding a skill to a slot it does not
 * do the job of has to fail at the endpoint, not warn in the interface. A
 * settings file that carries the wrong skill in the wrong slot is read by the
 * runner, so a warning here would be a warning followed by the mistake.
 */

const AUDITOR = `---
name: agentic-actions-auditor
description: Audits GitHub Actions workflows for security vulnerabilities in AI agent integrations. Detects misconfigurations and attack vectors specific to Claude Code Action and OpenAI Codex in CI/CD pipelines.
---

# agentic-actions-auditor

Analyzes workflow YAML for vulnerabilities where attacker-controlled input
reaches an agent with elevated permissions.
`;

const FRONTEND = `---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Sets typography, colour, and layout.
---

# frontend-design

Type scale, palette, spacing, composition.
`;

const FOUNDATIONS = `---
name: hig-foundations
description: Apple Human Interface Guidelines foundations — design principles, typography, colour, layout, materials, and accessibility.
---

# hig-foundations

Principles first, then components. Contrast, touch targets, dynamic type.
`;

const MOTION = `---
name: emil-design-eng
description: Design engineering principles for polished UI — animations, typography, surfaces, micro-interactions.
---

# emil-design-eng

Easing, spring physics, duration.
`;

const POLISH = `---
name: make-interfaces-feel-better
description: An agent skill that helps make your interface feel better — the small details of finish that make a UI feel considered.
---

# make-interfaces-feel-better

Subtle transitions, optical alignment, consistent spacing.
`;

const RESEARCH = `---
name: research
description: Investigate a question against a codebase and write down the findings.
---

# research

Read the repository before answering.
`;

/* Verbatim from anmolnagpal/devops-skills and agent-skills-hub. `deploy` and
 * `deployment-engineer` both pass the release contract, which is exactly the
 * situation the candidate list has to survive: one of them is already filling
 * the next layer of the same pack. */
const DEPLOY = `---
name: deploy
description: "Deployment strategy, production-readiness gating, and rollback planning for AWS/EKS services. Use when user says 'how should I deploy this', 'blue-green or canary', 'are we ready to ship', 'production readiness', 'plan a rollback', 'pre-deploy check', or before a first production release."
---

# deploy
`;

const CI = `---
name: ci
description: "GitLab CI/CD pipeline review and scaffolding for Terraform and Helm/EKS deployments, including individual stages, jobs, manual gates on prod stages, and pipeline credentials. Use when user says 'review my pipeline', 'check my gitlab-ci', 'scaffold a pipeline', 'is my CI correct', 'add a stage', 'add a deploy job', 'staging and prod share a job', or when working in .gitlab-ci.yml files."
---

# ci
`;

const DEPLOYMENT_ENGINEER = `---
name: deployment-engineer
description: Expert deployment engineer specializing in modern CI/CD pipelines,
  GitOps workflows, and advanced deployment automation. Masters GitHub Actions,
  ArgoCD/Flux, progressive delivery, container security, and platform
  engineering. Handles zero-downtime deployments, security scanning, and
  developer experience optimization. Use PROACTIVELY for CI/CD design, GitOps
  implementation, or deployment automation.
---

# deployment-engineer
`;

let tmp: string;
let skillsRoot: string;
let settingsFile: string;
let workspacesFile: string;
let base: string;

async function freePort(): Promise<number> {
  return await new Promise<number>((done, fail) => {
    const probe = createNetServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => done(port));
    });
  });
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gov-packs-api-'));
  skillsRoot = join(tmp, 'skills');
  for (const [id, body] of Object.entries({
    'hig-foundations': FOUNDATIONS,
    'frontend-design': FRONTEND,
    'emil-design-eng': MOTION,
    'make-interfaces-feel-better': POLISH,
    'agentic-actions-auditor': AUDITOR,
    research: RESEARCH,
    ci: CI,
    deploy: DEPLOY,
    'deployment-engineer': DEPLOYMENT_ENGINEER,
  })) {
    await mkdir(join(skillsRoot, id), { recursive: true });
    await writeFile(join(skillsRoot, id, 'SKILL.md'), body, 'utf8');
  }

  settingsFile = join(tmp, 'settings.json');
  workspacesFile = join(tmp, 'workspaces.json');
  /* `skillsRoot` is not a field of Settings, so it survives in `unknown` and the
   * server reads it from there — which is also how a hand-edited file points the
   * app at another skills directory. */
  await writeFile(settingsFile, JSON.stringify({ skillsRoot }), 'utf8');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  void serve({ roots: [tmp], port, settingsPath: settingsFile, workspacesPath: workspacesFile });

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('server did not come up');
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
  process.exit(0);
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Slot {
  slot: string;
  skill: string | null;
  status: string;
  substituted: boolean;
  rejected: string[];
  unresolved: string | null;
  alternatives: { id: string }[];
}
interface Pack {
  id: string;
  enabled: boolean;
  ready: boolean;
  required: number;
  satisfied: number;
  entries: Slot[];
}
interface PacksBody {
  skillsRoot: string;
  packs: Pack[];
  installed: string[];
  needsSetup: boolean;
}

async function packs(): Promise<PacksBody> {
  const r = await fetch(`${base}/api/skills/packs`);
  assert.equal(r.status, 200);
  return (await r.json()) as PacksBody;
}

function slotIn(body: PacksBody, packId: string, slot: string): Slot {
  const pack = body.packs.find((p) => p.id === packId);
  assert.ok(pack !== undefined, `no pack ${packId}`);
  const found = pack.entries.find((e) => e.slot === slot);
  assert.ok(found !== undefined, `no slot ${slot}`);
  return found;
}

test('the packs report what is on this machine, slot by slot', async () => {
  const body = await packs();
  assert.equal(body.skillsRoot, skillsRoot);
  assert.deepEqual(body.installed, [
    'agentic-actions-auditor',
    'ci',
    'deploy',
    'deployment-engineer',
    'emil-design-eng',
    'frontend-design',
    'hig-foundations',
    'make-interfaces-feel-better',
    'research',
  ]);

  const design = body.packs.find((p) => p.id === 'design-stack');
  assert.ok(design !== undefined);
  assert.equal(design.required, 5);
  assert.equal(design.satisfied, 4, 'four of five layers are filled by installed skills');
  assert.equal(design.ready, false, 'a missing quality gate is not ready');
  /* `design.gate` used to be `unresolved` — a slot with no upstream at all.
   * `findscripter/everything-skills` contains a real interface review, so the
   * slot now has a source and the honest status is `missing`: the catalogue
   * knows where to get it, the machine does not have it. The difference matters
   * on screen, because `missing` gets an Install button and `unresolved` cannot. */
  const gate = slotIn(body, 'design-stack', 'design.gate');
  assert.equal(gate.status, 'missing');
  assert.equal(gate.unresolved, null, 'a slot with a source is not unresolved');
  assert.equal(body.needsSetup, true);
});

test('the auditor fills the audit slot and nothing else', async () => {
  const body = await packs();
  const audit = slotIn(body, 'devops-suite', 'devops.audit');
  assert.equal(audit.skill, 'agentic-actions-auditor');
  assert.equal(audit.status, 'match');

  /* Every design layer either has its own skill or is unresolved. None of them
   * has quietly accepted the auditor. */
  const design = body.packs.find((p) => p.id === 'design-stack');
  assert.ok(design !== undefined);
  assert.ok(
    design.entries.every((e) => e.skill !== 'agentic-actions-auditor'),
    'the auditor must not appear in the design stack',
  );
});

test('binding the auditor to the design quality gate is refused', async () => {
  const before = await readFile(settingsFile, 'utf8');
  const r = await post('/api/skills/packs/substitute', {
    pack: 'design-stack',
    slot: 'design.gate',
    skill: 'agentic-actions-auditor',
  });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string; rejected: string[]; candidates: string[] };
  assert.match(body.error, /does not do the job/);
  assert.ok(
    body.rejected.some((x) => x.includes('GitHub Actions')),
    `expected a GitHub Actions rejection, got ${JSON.stringify(body.rejected)}`,
  );
  assert.deepEqual(body.candidates, []);

  /* Nothing was written. A refusal that still persists the value is a warning
   * with extra steps. */
  assert.equal(await readFile(settingsFile, 'utf8'), before);
});

test('a skill that is installed but does not review is refused too', async () => {
  const r = await post('/api/skills/packs/substitute', {
    pack: 'design-stack',
    slot: 'design.gate',
    skill: 'research',
  });
  assert.equal(r.status, 409);
});

test('the refusal does not recommend a skill another layer is already using', async () => {
  /* `ci` cannot fill the release layer: layer 2 owns the pipeline machinery and
   * this layer owns the decision about how to ship. The refusal is correct.
   *
   * The candidate list beside it was not: built without the exclusion the list
   * endpoint applies, it offered `deployment-engineer`, which this same pack
   * already binds to its next layer. A refusal that answers "what should I use
   * instead?" with a skill that would collapse two layers is the mistake the
   * exclusion exists to prevent, made in the error path. */
  const r = await post('/api/skills/packs/substitute', {
    pack: 'devops-suite',
    slot: 'devops.release',
    skill: 'ci',
  });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { rejected: string[]; candidates: string[] };
  assert.ok(
    body.rejected.some((x) => x.includes('ship safely')),
    `expected the release-layer refusal, got ${JSON.stringify(body.rejected)}`,
  );
  assert.ok(
    !body.candidates.includes('deployment-engineer'),
    `offered a skill already bound to devops.deploy: ${JSON.stringify(body.candidates)}`,
  );
  /* And it agrees with what the list endpoint offers for the same slot — one
   * question, one answer, whichever route asked it. */
  const listed = slotIn(await packs(), 'devops-suite', 'devops.release');
  assert.ok(
    !listed.alternatives.some((a) => a.id === 'deployment-engineer'),
    `the list endpoint offered it too: ${JSON.stringify(listed.alternatives.map((a) => a.id))}`,
  );
});

test('an uninstalled skill is a 400 with the list of what is there', async () => {
  const r = await post('/api/skills/packs/substitute', {
    pack: 'design-stack',
    slot: 'design.gate',
    skill: 'not-a-skill',
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { installed: string[] };
  assert.ok(body.installed.includes('frontend-design'));
});

test('an unknown pack or slot is refused, not ignored', async () => {
  assert.equal(
    (await post('/api/skills/packs/substitute', { pack: 'nope', slot: 'x', skill: '' })).status,
    400,
  );
  assert.equal(
    (
      await post('/api/skills/packs/substitute', {
        pack: 'design-stack',
        slot: 'design.nope',
        skill: '',
      })
    ).status,
    400,
  );
});

test('a substitution that passes is stored, and shows as substituted', async () => {
  const r = await post('/api/skills/packs/substitute', {
    pack: 'design-stack',
    slot: 'design.foundation',
    skill: 'hig-foundations',
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { slot: Slot; packs: Pack[] };
  assert.equal(body.slot.status, 'substituted');
  assert.equal(body.slot.substituted, true);

  const file = JSON.parse(await readFile(settingsFile, 'utf8')) as {
    skillPacks: { id: string; substitutions: Record<string, string> }[];
  };
  const design = file.skillPacks.find((p) => p.id === 'design-stack');
  assert.equal(design?.substitutions['design.foundation'], 'hig-foundations');

  const fresh = await packs();
  assert.equal(slotIn(fresh, 'design-stack', 'design.foundation').substituted, true);
});

test('clearing a substitution restores the pack preference', async () => {
  const r = await post('/api/skills/packs/substitute', {
    pack: 'design-stack',
    slot: 'design.foundation',
    skill: '',
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { slot: Slot };
  assert.equal(body.slot.status, 'match');
  assert.equal(body.slot.substituted, false);
  assert.equal(body.slot.skill, 'hig-foundations', 'the pack still prefers this skill');
});

test('installing a slot that is already on disk is kept, not fetched again', async () => {
  /* The stat check before the clone. Opening the settings page must not
   * re-download eleven skills, and `npm test` must not visit GitHub.
   *
   * This test used to install `design.gate` and expect `skipped`, because that
   * slot had no upstream when it was written. It has one now, so the same call
   * reached github.com and spent 13 seconds inside the test suite — the fixture
   * was still passing the shape of the old world. A source-less slot is no
   * longer reachable from the catalogue; that branch is covered against a
   * synthetic entry in packs.test.ts. */
  const r = await post('/api/skills/packs/install', {
    pack: 'design-stack',
    slot: 'design.polish',
  });
  assert.equal(r.status, 200, 'nothing failed, so this is not a partial success');
  const body = (await r.json()) as {
    results: { slot: string; status: string; path?: string }[];
  };
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.status, 'kept');
  assert.ok(body.results[0]?.path?.endsWith('make-interfaces-feel-better'));
});

test('installing into an unknown pack is a 400', async () => {
  const r = await post('/api/skills/packs/install', { pack: 'nope' });
  assert.equal(r.status, 400);
});

test('a disabled pack is still reported, and does not ask for setup', async () => {
  const saved = JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>;
  await writeFile(
    settingsFile,
    JSON.stringify({
      ...saved,
      skillPacks: [
        { id: 'design-stack', enabled: false, substitutions: {} },
        { id: 'devops-suite', enabled: true, substitutions: {} },
      ],
    }),
    'utf8',
  );

  const body = await packs();
  const design = body.packs.find((p) => p.id === 'design-stack');
  assert.equal(design?.enabled, false);
  /* The fleet is still one short, but the design pack was switched off on
   * purpose, so nothing is asking to be installed for it. */
  assert.equal(body.needsSetup, true, 'the devops suite still lacks five slots');
  assert.equal(slotIn(body, 'devops-suite', 'devops.audit').status, 'match');

  await writeFile(settingsFile, JSON.stringify(saved), 'utf8');
});
