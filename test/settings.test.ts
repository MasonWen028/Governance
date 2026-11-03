import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  DEFAULT_SETTINGS,
  mcpForStage,
  parseSettings,
  readSettings,
  skillEnabledFor,
  skillFor,
  writeSettings,
} from '../src/config/settings.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gov-settings-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('an empty object yields the defaults', () => {
  const { settings, warnings } = parseSettings({});
  assert.deepEqual(warnings, []);
  assert.equal(settings.agents.maxParallel, 4);
  assert.equal(settings.agents.isolation, 'worktree');
  assert.equal(settings.skills.length, 9, 'the whole chain is present by default');
});

test('a non-object is rejected with a warning, not a throw', () => {
  const { settings, warnings } = parseSettings('nonsense');
  assert.equal(warnings.length, 1);
  assert.equal(settings.agents.maxParallel, DEFAULT_SETTINGS.agents.maxParallel);
});

test('maxParallel is clamped into range', () => {
  assert.equal(parseSettings({ agents: { maxParallel: 99 } }).settings.agents.maxParallel, 8);
  assert.equal(parseSettings({ agents: { maxParallel: 0 } }).settings.agents.maxParallel, 1);
  assert.equal(parseSettings({ agents: { maxParallel: -3 } }).settings.agents.maxParallel, 1);
  assert.equal(parseSettings({ agents: { maxParallel: 'four' } }).settings.agents.maxParallel, 4);
});

test('an unknown isolation warns and falls back', () => {
  const { settings, warnings } = parseSettings({ agents: { isolation: 'chroot' } });
  assert.equal(settings.agents.isolation, 'worktree');
  assert.ok(warnings.some((w) => w.includes('chroot')));
});

test('every stage is present even when the file omits some', () => {
  const { settings, warnings } = parseSettings({
    skills: [{ id: 'retro', stage: 'retro', enabled: false }],
  });
  assert.equal(settings.skills.length, 9, 'missing stages must be restored');
  assert.ok(warnings.some((w) => w.includes('restored')));
});

test('a skill naming an unknown stage is dropped and reported', () => {
  const { settings, warnings } = parseSettings({
    skills: [{ id: 'x', stage: 'deploy', enabled: true }],
  });
  assert.ok(warnings.some((w) => w.includes('deploy')));
  assert.equal(settings.skills.some((s) => s.stage === 'deploy'), false);
});

test('the CI stage keeps an empty skill id rather than vanishing', () => {
  const { settings } = parseSettings({});
  const ship = settings.skills.find((s) => s.stage === 'ship');
  assert.ok(ship, 'the ship stage must be in the table, showing its gap');
  assert.equal(ship.id, '');
  assert.equal(skillFor(settings, 'ship'), null);
  assert.equal(skillEnabledFor(settings, 'ship'), false);
});

test('disabling a skill is what makes a stage manual', () => {
  const { settings } = parseSettings({
    skills: [{ id: 'to-tickets', stage: 'split', enabled: false }],
  });
  assert.equal(skillFor(settings, 'split'), 'to-tickets', 'the skill is still named');
  assert.equal(skillEnabledFor(settings, 'split'), false, 'but it is not automatic');
});

test('mcp servers parse, and scope is validated against real stages', () => {
  const { settings, warnings } = parseSettings({
    mcp: [
      { name: 'git', transport: 'stdio', target: 'mcp-server-git', scope: ['develop', 'review'], enabled: true },
      { name: 'bad', transport: 'stdio', target: 'x', scope: ['nope'], enabled: true },
      { name: 'h', transport: 'http', target: 'https://example.com/mcp', scope: [], enabled: false },
    ],
  });
  assert.equal(settings.mcp.length, 3);
  assert.ok(warnings.some((w) => w.includes('nope')), 'an unknown stage in scope must be reported');
});

test('an mcp server with no name or target is dropped', () => {
  const { settings, warnings } = parseSettings({
    mcp: [{ transport: 'stdio', scope: [] }],
  });
  assert.equal(settings.mcp.length, 0);
  assert.ok(warnings.length > 0);
});

test('an unknown transport is rejected', () => {
  const { settings, warnings } = parseSettings({
    mcp: [{ name: 'x', transport: 'carrier-pigeon', target: 'y', scope: [] }],
  });
  assert.ok(warnings.some((w) => w.includes('transport')));
  assert.equal(settings.mcp[0]?.transport, 'stdio', 'falls back to stdio');
});

test('a secret pasted into env is refused, because names only', () => {
  const { settings, warnings } = parseSettings({
    mcp: [{ name: 'x', transport: 'stdio', target: 'y', scope: [], env: ['GITHUB_TOKEN=ghp_abc123'] }],
  });
  assert.ok(
    warnings.some((w) => w.includes('NAMES')),
    'a settings file must never become somewhere a secret leaks from',
  );
  assert.deepEqual(settings.mcp[0]?.env, ['GITHUB_TOKEN'], 'the value is not carried through');
});

test('duplicate mcp names are reported', () => {
  const { warnings } = parseSettings({
    mcp: [
      { name: 'dup', transport: 'stdio', target: 'a', scope: [] },
      { name: 'dup', transport: 'stdio', target: 'b', scope: [] },
    ],
  });
  assert.ok(warnings.some((w) => w.includes('twice')));
});

test('mcpForStage honours both the switch and the scope', () => {
  const { settings } = parseSettings({
    mcp: [
      { name: 'on-scoped', transport: 'stdio', target: 'a', scope: ['develop'], enabled: true },
      { name: 'off-scoped', transport: 'stdio', target: 'b', scope: ['develop'], enabled: false },
      { name: 'on-elsewhere', transport: 'stdio', target: 'c', scope: ['review'], enabled: true },
    ],
  });
  assert.deepEqual(mcpForStage(settings, 'develop').map((m) => m.name), ['on-scoped']);
  assert.deepEqual(mcpForStage(settings, 'retro'), [], 'a stage with no servers gets none');
});

test('role models only accept real roles', () => {
  const { settings, warnings } = parseSettings({
    agents: { roleModels: { tech: 'opus', ceo: 'gpt' } },
  });
  const models: Record<string, string | undefined> = settings.agents.roleModels;
  assert.equal(models['tech'], 'opus');
  assert.equal(models['ceo'], undefined);
  assert.ok(warnings.some((w) => w.includes('ceo')));
});

test('unknown top-level keys survive a save', async () => {
  const file = join(dir, 'unknown.json');
  const { settings } = parseSettings({ skillsRoot: 'D:/skills', somethingElse: 42 });
  await writeSettings(settings, file);
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['skillsRoot'], 'D:/skills', 'a hand edit must not be lost');
  assert.equal(raw['somethingElse'], 42);
});

test('a save round-trips through a read', async () => {
  const file = join(dir, 'roundtrip.json');
  const { settings } = parseSettings({
    agents: { maxParallel: 6, isolation: 'container' },
    mcp: [{ name: 'gh', transport: 'http', target: 'https://x/mcp', scope: ['ship'], enabled: true }],
  });
  await writeSettings(settings, file);
  const back = await readSettings(file);
  assert.equal(back.warnings.length, 0);
  assert.equal(back.settings.agents.maxParallel, 6);
  assert.equal(back.settings.agents.isolation, 'container');
  assert.equal(back.settings.mcp[0]?.name, 'gh');
});

test('a missing file reads as defaults with no warnings', async () => {
  const result = await readSettings(join(dir, 'not-here.json'));
  assert.equal(result.source, null);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.settings.agents.maxParallel, 4);
});

test('a corrupt file reads as defaults and says why', async () => {
  const file = join(dir, 'broken.json');
  await writeFile(file, '{ this is not json', 'utf8');
  const result = await readSettings(file);
  assert.equal(result.settings.agents.maxParallel, 4);
  assert.ok(result.warnings.some((w) => w.includes('not valid JSON')));
});

test('a partly broken file keeps its good parts', async () => {
  const file = join(dir, 'partial.json');
  await writeFile(
    file,
    JSON.stringify({
      agents: { maxParallel: 2, isolation: 'nonsense' },
      mcp: [{ name: 'ok', transport: 'stdio', target: 'x', scope: ['review'] }],
    }),
    'utf8',
  );
  const result = await readSettings(file);
  assert.equal(result.settings.agents.maxParallel, 2, 'the good field survives');
  assert.equal(result.settings.agents.isolation, 'worktree', 'the bad one falls back');
  assert.equal(result.settings.mcp.length, 1);
  assert.ok(result.warnings.length > 0);
});
