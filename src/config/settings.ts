import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { METHOD_IDS, ROLE_IDS } from '../domain/types.js';
import type { MethodId, RoleId } from '../domain/types.js';
import { DEFAULT_PACKS, entryBySlot } from '../skills/packs.js';

/**
 * Application settings.
 *
 * Not a preferences pane that writes to nowhere: this file is read by the runner
 * before it runs a stage, so disabling a skill genuinely stops that stage being
 * automatic. The point of the settings screen is that it changes behaviour, and a
 * settings screen that only changes its own appearance is a lie.
 *
 * The file lives beside `governance.workspaces.json`, is hand-editable, and is
 * diffable. Unknown keys are preserved rather than dropped: someone editing this
 * by hand should not lose a field because this version does not know it yet.
 */

export const SETTINGS_FILE = 'governance.settings.json';

export interface McpServer {
  /** Unique within the file. Referenced by scope checks and by the runner. */
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  /** The command line for stdio, or the URL for http/sse. */
  readonly target: string;
  /** Stage ids this server is available to. An empty list means no stage. */
  readonly scope: readonly string[];
  readonly enabled: boolean;
  /** Environment variable names the server needs. Names only — never values, so
   *  a settings file cannot become a place secrets leak from. */
  readonly env?: readonly string[];
  readonly note?: string;
}

export interface SkillSetting {
  /** The skill's directory name under the skills root. */
  readonly id: string;
  readonly stage: string;
  readonly enabled: boolean;
}

/**
 * A skill pack, as configured.
 *
 * The pack's *contents* live in `src/skills/packs.ts` — this record holds only
 * what the user decided: whether the pack is active, and which skill they put in
 * a slot instead of the one the pack prefers.
 *
 * A substitution is a claim of functional equivalence, and it is checked rather
 * than trusted: the skills page re-runs the slot's contract against whatever is
 * named here, and a substitution whose contents no longer match falls back to
 * the pack's own preference instead of silently filling the slot with the wrong
 * tool. That is the difference between a setting and an assertion.
 */
export interface SkillPackSetting {
  readonly id: string;
  readonly enabled: boolean;
  /** Slot id -> skill id. A slot not named here uses the pack's preference. */
  readonly substitutions: Readonly<Record<string, string>>;
}

/** Per-CLI provider configuration. All fields are safe to commit. */
export interface ProviderConfig {
  readonly enabled: boolean;
  /** OpenCode provider id (`anthropic`, `ollama`, …). Empty = the CLI's own default. */
  readonly provider: string;
  /** Model id within the provider. Empty = the CLI's own default. */
  readonly model: string;
  /** Base URL override, where the provider supports one. Empty = provider default. */
  readonly baseUrl: string;
  /** NAME of the environment variable holding the API key. Never a value. */
  readonly apiKeyEnv: string;
}

/** Per-role agent override. Empty or `inherit` falls through to the global config. */
export interface RoleAgentConfig {
  readonly cli: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
}

export interface AgentSettings {
  readonly cli: string;
  readonly model: string;
  readonly maxParallel: number;
  readonly isolation: 'worktree' | 'container' | 'vm';
  readonly copyRoot: string;
  readonly timeoutMin: number;
  readonly retries: number;
  readonly pauseOnGate: boolean;
  readonly roleModels: Readonly<Partial<Record<RoleId, string>>>;
  /**
   * Per-CLI provider configuration, keyed by CLI id (`opencode`, `claude`).
   *
   * An API key is never stored here — `apiKeyEnv` is the NAME of an
   * environment variable, and the parser refuses an entry that tries to carry
   * a value. The same rule the MCP `env` list has, for the same reason.
   */
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  /**
   * Per-role overrides. Resolution order: role > global agents > provider
   * defaults. A field set to `inherit` (or empty, which is different only in
   * the UI) falls through to the next level.
   */
  readonly roleAgents: Readonly<Partial<Record<RoleId, RoleAgentConfig>>>;
  /**
   * How agent turns execute.
   *
   * `cli` spawns the headless CLI, which reads the skill files and writes the
   * artifacts itself. `api` calls the Messages API directly; the app then reads
   * the skill files on the model's behalf and owns the file writes through a
   * minimal tool loop, because a bare API model can touch neither.
   */
  readonly transport: 'cli' | 'api';
  /** Messages API base. Point it at a gateway or a local proxy if needed. */
  readonly apiBase: string;
  /** Model used for API turns when `model` is `inherit`. */
  readonly apiModel: string;
  /**
   * Name of the environment variable holding the API key.
   *
   * A name, never a value — a settings file is not somewhere a secret can leak
   * from, and the parser refuses one that tries to be.
   */
  readonly apiKeyEnv: string;
  readonly apiMaxTokens: number;
}

export interface GitSettings {
  readonly branchTemplate: string;
  readonly integrationTemplate: string;
  readonly sign: boolean;
  readonly draftPr: boolean;
  readonly cleanup: boolean;
}

export interface AutomationSettings {
  readonly afk: boolean;
  readonly autoMerge: boolean;
  readonly maxWaitHours: number;
  readonly dailySummary: boolean;
}

export interface Settings {
  readonly general: {
    readonly startup: 'portfolio' | 'last';
    readonly confirmDestructive: boolean;
    readonly showCost: boolean;
    readonly telemetry: boolean;
  };
  readonly agents: AgentSettings;
  readonly skills: readonly SkillSetting[];
  /**
   * The skill packs this machine is meant to have.
   *
   * Separate from `skills`, which binds one skill per SDLC stage. A pack fills
   * capability slots — a design foundation, a deployment strategy, a pipeline
   * audit — and those are not stages: the same pack is used by several stages,
   * and a stage can be satisfied while every pack is empty.
   */
  readonly skillPacks: readonly SkillPackSetting[];
  readonly mcp: readonly McpServer[];
  readonly git: GitSettings;
  readonly automation: AutomationSettings;
  /** Keys this build does not know about, carried through a save untouched. */
  readonly unknown?: Readonly<Record<string, unknown>>;
}

/** Stage ids, duplicated here rather than imported from the view layer, because
 *  this module validates against them and the view layer is not the authority. */
const STAGES = [
  'intake',
  'ask',
  'spec',
  'design',
  'split',
  'develop',
  'review',
  'ship',
  'retro',
] as const;

export const DEFAULT_SETTINGS: Settings = {
  general: {
    startup: 'portfolio',
    confirmDestructive: true,
    showCost: false,
    telemetry: false,
  },
  agents: {
    /* OpenCode is the default executor for fresh installs. Claude remains
     * available but opt-in — nothing in the default path needs a Claude
     * subscription. A settings file that already named a CLI keeps it (see
     * the migration note in parseSettings). */
    cli: 'opencode',
    model: 'inherit',
    maxParallel: 4,
    isolation: 'worktree',
    copyRoot: '../.worktrees',
    timeoutMin: 30,
    retries: 1,
    pauseOnGate: false,
    roleModels: {},
    transport: 'cli',
    apiBase: 'https://api.anthropic.com',
    apiModel: 'claude-sonnet-4-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiMaxTokens: 8192,
    providers: {
      /* OpenCode is the default executor. Its provider, model and credentials
       * are resolved by OpenCode itself (opencode.json, `opencode auth login`,
       * or {env:VAR} in its own config); these fields only carry what we pass
       * on the command line. An empty provider/model means "whatever OpenCode
       * is configured with" — we do not assume a vendor. */
      opencode: {
        enabled: true,
        provider: '',
        model: '',
        baseUrl: '',
        apiKeyEnv: 'OPENCODE_API_KEY',
      },
      claude: {
        enabled: false,
        provider: 'anthropic',
        model: '',
        baseUrl: '',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
    },
    roleAgents: {},
  },
  /* The chain, in order. Stage 8 is CI and has no skill by design; it is present
   * with an empty id so the table shows the gap rather than hiding it. */
  skills: [
    { id: 'grill-with-docs', stage: 'intake', enabled: true },
    { id: 'grilling', stage: 'ask', enabled: true },
    { id: 'to-spec', stage: 'spec', enabled: true },
    { id: 'codebase-design', stage: 'design', enabled: true },
    { id: 'to-tickets', stage: 'split', enabled: true },
    { id: 'implement-spec', stage: 'develop', enabled: true },
    { id: 'code-review', stage: 'review', enabled: true },
    { id: '', stage: 'ship', enabled: true },
    { id: 'retro', stage: 'retro', enabled: true },
  ],
  /* Both packs on, nothing substituted. The packs themselves live in
   * `src/skills/packs.ts`; deriving the defaults from there means a pack cannot
   * be added to the catalogue and forgotten in the settings file. */
  skillPacks: DEFAULT_PACKS.map((p) => ({ id: p.id, enabled: true, substitutions: {} })),
  mcp: [],
  git: {
    branchTemplate: 'feat/{ticket}',
    integrationTemplate: 'integration/{project}',
    sign: true,
    draftPr: true,
    cleanup: true,
  },
  automation: {
    afk: false,
    autoMerge: false,
    maxWaitHours: 24,
    dailySummary: false,
  },
};

export interface SettingsReadResult {
  readonly settings: Settings;
  /** What was wrong with the file, if anything. Never fatal: a partly broken
   *  settings file should degrade to defaults for the broken parts, not stop the
   *  application from starting. */
  readonly warnings: readonly string[];
  readonly source: string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}

/** Like str, but an explicit empty string is a VALUE, not a missing field.
 *
 * Provider fields need this: `apiKeyEnv: ""` is the Ollama configuration —
 * "this provider has no key variable" — and snapping it back to the default
 * would make a local-only setup impossible to express. */
function rawStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function isMethod(v: unknown): v is MethodId {
  return typeof v === 'string' && (METHOD_IDS as readonly string[]).includes(v);
}
void isMethod;

function isRoleKey(v: unknown): v is RoleId {
  return typeof v === 'string' && (ROLE_IDS as readonly string[]).includes(v);
}

export function parseMcpServer(raw: unknown, index: number): { server: McpServer | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { server: null, problems: [`mcp[${index}] is not an object`] };

  const name = str(raw['name'], '');
  if (name.length === 0) problems.push(`mcp[${index}] has no name`);

  const transport = raw['transport'];
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    problems.push(`mcp[${index}] transport must be stdio | http | sse`);
  }

  const target = str(raw['target'], '');
  if (target.length === 0) problems.push(`mcp[${index}] has no target`);

  const scopeRaw = Array.isArray(raw['scope']) ? raw['scope'] : [];
  const scope = scopeRaw.filter((s): s is string => typeof s === 'string');
  for (const s of scope) {
    if (!(STAGES as readonly string[]).includes(s)) {
      problems.push(`mcp[${index}] scope names an unknown stage: ${s}`);
    }
  }

  const envRaw = Array.isArray(raw['env']) ? raw['env'] : [];
  // `env` holds variable NAMES. A file that carries `NAME=value` is one a secret
  // could leak from, so the value is dropped and the mistake is named.
  const contaminated = envRaw.some((e) => typeof e === 'string' && e.includes('='));
  if (contaminated) {
    problems.push(`mcp[${index}] env must hold variable NAMES, not values`);
  }
  const env = envRaw
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.split('=')[0]!.trim())
    .filter((e) => e.length > 0);

  if (problems.length > 0 && (name.length === 0 || target.length === 0)) {
    return { server: null, problems };
  }

  return {
    server: {
      name,
      transport: transport === 'http' || transport === 'sse' ? transport : 'stdio',
      target,
      scope,
      enabled: bool(raw['enabled'], true),
      ...(env.length > 0 ? { env } : {}),
      ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
    },
    problems,
  };
}

export function parseSkill(raw: unknown, index: number, defaults: readonly SkillSetting[]): { skill: SkillSetting | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { skill: null, problems: [`skills[${index}] is not an object`] };
  const stage = str(raw['stage'], '');
  if (!(STAGES as readonly string[]).includes(stage)) {
    problems.push(`skills[${index}] names an unknown stage: ${stage || '(empty)'}`);
    return { skill: null, problems };
  }
  const fallback = defaults.find((d) => d.stage === stage);
  return {
    skill: {
      id: typeof raw['id'] === 'string' ? raw['id'] : (fallback?.id ?? ''),
      stage,
      enabled: bool(raw['enabled'], true),
    },
    problems,
  };
}

/** Validate one pack entry. A pack this build does not ship is dropped, not
 *  carried: an unknown pack cannot be rendered, and keeping it would let a
 *  typo look like configuration. */
export function parseSkillPack(
  raw: unknown,
  index: number,
): { pack: SkillPackSetting | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { pack: null, problems: [`skillPacks[${index}] is not an object`] };

  const id = str(raw['id'], '');
  if (id.length === 0) return { pack: null, problems: [`skillPacks[${index}] has no id`] };
  if (!DEFAULT_PACKS.some((p) => p.id === id)) {
    return { pack: null, problems: [`skillPacks[${index}] names an unknown pack: ${id}`] };
  }

  const substitutions: Record<string, string> = {};
  if (isObject(raw['substitutions'])) {
    for (const [slot, skill] of Object.entries(raw['substitutions'])) {
      if (entryBySlot(id, slot) === null) {
        problems.push(`skillPacks.${id}.substitutions names an unknown slot: ${slot}`);
        continue;
      }
      if (typeof skill !== 'string') {
        problems.push(`skillPacks.${id}.substitutions.${slot} is not a skill id`);
        continue;
      }
      /* Kept as written. Whether the skill is *equivalent* is a question about
       * its contents, which this file cannot answer — the page asks the checker
       * every time it renders, so a substitution that stops holding is visible
       * rather than permanently trusted. */
      const wanted = skill.trim();
      if (wanted.length > 0) substitutions[slot] = wanted;
    }
  }

  return {
    pack: { id, enabled: bool(raw['enabled'], true), substitutions },
    problems,
  };
}

/** Validate and fill. Never throws: a bad field falls back and says so. */
export function parseSettings(raw: unknown): { settings: Settings; warnings: string[] } {
  const warnings: string[] = [];
  if (!isObject(raw)) {
    return { settings: DEFAULT_SETTINGS, warnings: ['settings file is not an object; using defaults'] };
  }

  const g = isObject(raw['general']) ? raw['general'] : {};
  const a = isObject(raw['agents']) ? raw['agents'] : {};
  const git = isObject(raw['git']) ? raw['git'] : {};
  const auto = isObject(raw['automation']) ? raw['automation'] : {};

  const isolation = a['isolation'];
  if (isolation !== undefined && isolation !== 'worktree' && isolation !== 'container' && isolation !== 'vm') {
    warnings.push(`agents.isolation "${String(isolation)}" is not recognised; using worktree`);
  }

  const roleModels: Partial<Record<RoleId, string>> = {};
  if (isObject(a['roleModels'])) {
    for (const [k, v] of Object.entries(a['roleModels'])) {
      if (!isRoleKey(k)) {
        warnings.push(`agents.roleModels has an unknown role: ${k}`);
        continue;
      }
      if (typeof v === 'string') roleModels[k] = v;
    }
  }

  /* Providers. The one hard refusal: a provider entry that carries an apiKey
   * VALUE is stripped and warned about. A settings file is not somewhere a
   * secret can leak from — the same rule the MCP env list enforces. */
  const providers: Record<string, ProviderConfig> = {};
  if (isObject(a['providers'])) {
    for (const [id, entry] of Object.entries(a['providers'])) {
      if (!isObject(entry)) {
        warnings.push(`agents.providers.${id} is not an object; using defaults`);
        continue;
      }
      if (entry['apiKey'] !== undefined || entry['apiKeyRef'] !== undefined) {
        if (typeof entry['apiKey'] === 'string' && entry['apiKey'].length > 0) {
          warnings.push(
            `agents.providers.${id} carries an apiKey value; refusing it. ` +
              `Store the key in an environment variable and name it in apiKeyEnv.`,
          );
        } else {
          warnings.push(
            `agents.providers.${id} uses apiKey/apiKeyRef; the field is apiKeyEnv and holds a variable name, never a value`,
          );
        }
      }
      const fallback = DEFAULT_SETTINGS.agents.providers[id];
      providers[id] = {
        enabled: bool(entry['enabled'], fallback?.enabled ?? false),
        provider: rawStr(entry['provider'], fallback?.provider ?? ''),
        model: rawStr(entry['model'], fallback?.model ?? ''),
        baseUrl: rawStr(entry['baseUrl'], fallback?.baseUrl ?? ''),
        apiKeyEnv: rawStr(entry['apiKeyEnv'], fallback?.apiKeyEnv ?? ''),
      };
    }
  }
  for (const id of Object.keys(DEFAULT_SETTINGS.agents.providers)) {
    if (providers[id] === undefined) {
      providers[id] = DEFAULT_SETTINGS.agents.providers[id]!;
    }
  }

  const roleAgents: Partial<Record<RoleId, RoleAgentConfig>> = {};
  if (isObject(a['roleAgents'])) {
    for (const [k, v] of Object.entries(a['roleAgents'])) {
      if (!isRoleKey(k)) {
        warnings.push(`agents.roleAgents has an unknown role: ${k}`);
        continue;
      }
      if (!isObject(v)) {
        warnings.push(`agents.roleAgents.${k} is not an object; ignoring it`);
        continue;
      }
      if (v['apiKey'] !== undefined) {
        warnings.push(`agents.roleAgents.${k} carries an apiKey value; refusing it`);
      }
      roleAgents[k] = {
        cli: str(v['cli'], 'inherit'),
        provider: str(v['provider'], ''),
        model: str(v['model'], ''),
        baseUrl: str(v['baseUrl'], ''),
      };
    }
  }

  /* Migration. A fresh install defaults to OpenCode. But a settings file that
   * HAS an agents block and never named a CLI was written when `claude` was
   * the implicit default — keeping that is "preserve the user's executor
   * choice", not "default to Claude". */
  const legacyCli = isObject(raw['agents']) && a['cli'] === undefined ? 'claude' : undefined;
  const cliValue = str(a['cli'], legacyCli ?? DEFAULT_SETTINGS.agents.cli);
  if (
    cliValue !== 'opencode' &&
    cliValue !== 'claude' &&
    DEFAULT_SETTINGS.agents.providers[cliValue] === undefined
  ) {
    warnings.push(
      `agents.cli "${cliValue}" has no adapter; it will run with Claude-style arguments`,
    );
  }

  const skills: SkillSetting[] = [];
  const skillsRaw = Array.isArray(raw['skills']) ? raw['skills'] : null;
  if (skillsRaw === null) {
    // Absent is not the same as broken. A file that never mentions skills is
    // asking for the default chain, and warning about all nine would drown the
    // warnings that do mean something.
    skills.push(...DEFAULT_SETTINGS.skills);
  } else {
    skillsRaw.forEach((s, i) => {
      const { skill, problems } = parseSkill(s, i, DEFAULT_SETTINGS.skills);
      warnings.push(...problems);
      if (skill) skills.push(skill);
    });
    // But an array that exists and omits a stage is a different matter: that
    // stage would silently drop out of the chain.
    for (const d of DEFAULT_SETTINGS.skills) {
      if (!skills.some((s) => s.stage === d.stage)) {
        skills.push(d);
        warnings.push(`stage ${d.stage} was missing from skills; restored its default`);
      }
    }
  }

  /* Packs. Same two rules as the stage chain: absent means "the defaults", an
   * array that exists and omits a pack gets it back with a warning, because a
   * missing pack would silently stop being checked. */
  const skillPacks: SkillPackSetting[] = [];
  const packsRaw = Array.isArray(raw['skillPacks']) ? raw['skillPacks'] : null;
  if (packsRaw === null) {
    skillPacks.push(...DEFAULT_SETTINGS.skillPacks);
  } else {
    packsRaw.forEach((p, i) => {
      const { pack, problems } = parseSkillPack(p, i);
      warnings.push(...problems);
      if (pack !== null && !skillPacks.some((x) => x.id === pack.id)) skillPacks.push(pack);
    });
    for (const d of DEFAULT_SETTINGS.skillPacks) {
      if (!skillPacks.some((p) => p.id === d.id)) {
        skillPacks.push(d);
        warnings.push(`skill pack ${d.id} was missing; restored its default`);
      }
    }
  }

  const mcp: McpServer[] = [];
  const mcpRaw = Array.isArray(raw['mcp']) ? raw['mcp'] : [];
  mcpRaw.forEach((m, i) => {
    const { server, problems } = parseMcpServer(m, i);
    warnings.push(...problems);
    if (server) mcp.push(server);
  });
  const dupes = mcp.map((m) => m.name).filter((n, i, arr) => arr.indexOf(n) !== i);
  for (const d of new Set(dupes)) warnings.push(`mcp server name used twice: ${d}`);

  const known = new Set(['general', 'agents', 'skills', 'skillPacks', 'mcp', 'git', 'automation']);
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!known.has(k)) unknown[k] = v;

  const settings: Settings = {
    general: {
      startup: g['startup'] === 'last' ? 'last' : 'portfolio',
      confirmDestructive: bool(g['confirmDestructive'], true),
      showCost: bool(g['showCost'], false),
      telemetry: bool(g['telemetry'], false),
    },
    agents: {
      cli: cliValue,
      model: str(a['model'], DEFAULT_SETTINGS.agents.model),
      maxParallel: num(a['maxParallel'], DEFAULT_SETTINGS.agents.maxParallel, 1, 8),
      isolation:
        isolation === 'container' || isolation === 'vm' ? isolation : 'worktree',
      copyRoot: str(a['copyRoot'], DEFAULT_SETTINGS.agents.copyRoot),
      timeoutMin: num(a['timeoutMin'], DEFAULT_SETTINGS.agents.timeoutMin, 1, 600),
      retries: num(a['retries'], DEFAULT_SETTINGS.agents.retries, 0, 10),
      pauseOnGate: bool(a['pauseOnGate'], false),
      roleModels,
      providers,
      roleAgents,
      transport: a['transport'] === 'api' ? 'api' : 'cli',
      apiBase: str(a['apiBase'], DEFAULT_SETTINGS.agents.apiBase),
      apiModel: str(a['apiModel'], DEFAULT_SETTINGS.agents.apiModel),
      apiKeyEnv: str(a['apiKeyEnv'], DEFAULT_SETTINGS.agents.apiKeyEnv),
      apiMaxTokens: num(a['apiMaxTokens'], DEFAULT_SETTINGS.agents.apiMaxTokens, 256, 65536),
    },
    skills,
    skillPacks,
    mcp,
    git: {
      branchTemplate: str(git['branchTemplate'], DEFAULT_SETTINGS.git.branchTemplate),
      integrationTemplate: str(git['integrationTemplate'], DEFAULT_SETTINGS.git.integrationTemplate),
      sign: bool(git['sign'], true),
      draftPr: bool(git['draftPr'], true),
      cleanup: bool(git['cleanup'], true),
    },
    automation: {
      afk: bool(auto['afk'], false),
      autoMerge: bool(auto['autoMerge'], false),
      maxWaitHours: num(auto['maxWaitHours'], 24, 1, 24 * 30),
      dailySummary: bool(auto['dailySummary'], false),
    },
    ...(Object.keys(unknown).length > 0 ? { unknown } : {}),
  };

  return { settings, warnings };
}

/** Where the settings file lives: at the package root, beside the workspaces
 *  file, so both local config files sit together and are edited the same way. */
export function settingsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/src/config -> package root is three levels up.
  return resolve(here, '..', '..', '..', SETTINGS_FILE);
}

export async function readSettings(path?: string): Promise<SettingsReadResult> {
  const file = path ?? settingsPath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { settings: DEFAULT_SETTINGS, warnings: [], source: null };
  }
  try {
    const parsed = parseSettings(JSON.parse(raw));
    return { settings: parsed.settings, warnings: parsed.warnings, source: file };
  } catch (err) {
    return {
      settings: DEFAULT_SETTINGS,
      warnings: [`${SETTINGS_FILE} is not valid JSON: ${(err as Error).message}`],
      source: file,
    };
  }
}

export async function writeSettings(settings: Settings, path?: string): Promise<string> {
  const file = path ?? settingsPath();
  // Round-trip unknown keys so hand edits survive this version's save.
  const out: Record<string, unknown> = {
    general: settings.general,
    agents: settings.agents,
    skills: settings.skills,
    skillPacks: settings.skillPacks,
    mcp: settings.mcp,
    git: settings.git,
    automation: settings.automation,
    ...(settings.unknown ?? {}),
  };
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return file;
}

/** Is the skill for this stage enabled? A disabled skill is what makes a stage
 *  manual, so the runner asks this before planning a run. */
export function skillEnabledFor(settings: Settings, stage: string): boolean {
  const s = settings.skills.find((x) => x.stage === stage);
  // A stage with no entry, or an entry with no skill id, is CI or manual.
  if (s === undefined) return false;
  if (s.id.length === 0) return false;
  return s.enabled;
}

/** The skill id for a stage, or null when the stage has none. */
export function skillFor(settings: Settings, stage: string): string | null {
  const s = settings.skills.find((x) => x.stage === stage);
  if (s === undefined || s.id.length === 0) return null;
  return s.id;
}

/** MCP servers available to a stage, honouring both the server's own switch and
 *  its scope. This is the function that makes scoping mean something. */
export function mcpForStage(settings: Settings, stage: string): readonly McpServer[] {
  return settings.mcp.filter((m) => m.enabled && m.scope.includes(stage));
}

/* ------------------------------------------------------------------ */
/* Agent resolution                                                     */
/* ------------------------------------------------------------------ */

/** The result of resolving who actually runs, and with what model. */
export interface ResolvedAgent {
  /** The CLI id actually invoked. */
  readonly cli: string;
  /** The provider id, when one is configured. Empty = the CLI's own default. */
  readonly provider: string;
  /**
   * The effective model id. Empty = let the CLI decide. For OpenCode this may
   * be `provider/model`; for Claude a bare model name.
   */
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
}

/**
 * Resolve the agent for a role: role > global agents > provider defaults.
 *
 * `inherit` and empty both fall through — they differ only in what the UI
 * shows, never in behaviour. A field that is set wins, whatever level it is
 * set at. The resolution is computed at task time and frozen into the task
 * context, so changing settings mid-run cannot drift a running turn.
 */
export function resolveAgentFor(
  settings: Settings,
  role?: RoleId,
): ResolvedAgent {
  const roleCfg = role !== undefined ? settings.agents.roleAgents[role] : undefined;

  const cli =
    roleCfg !== undefined && roleCfg.cli !== '' && roleCfg.cli !== 'inherit'
      ? roleCfg.cli
      : settings.agents.cli;

  const providerCfg = settings.agents.providers[cli];
  /** First value that is set wins; `inherit` and empty both fall through. */
  const pick = (...vals: readonly string[]): string => {
    for (const v of vals) {
      if (v !== '' && v !== 'inherit') return v;
    }
    return '';
  };

  const provider = pick(roleCfg?.provider ?? '', providerCfg?.provider ?? '');
  const model = pick(
    roleCfg?.model ?? '',
    providerCfg?.model ?? '',
    settings.agents.model,
  );
  const baseUrl = pick(roleCfg?.baseUrl ?? '', providerCfg?.baseUrl ?? '');

  let effective = model;
  if (cli === 'opencode' && provider !== '' && model !== '' && !model.includes('/')) {
    effective = `${provider}/${model}`;
  }
  /* Claude's runner has always fallen back to `sonnet` when nothing was set;
   * keep that so an upgraded config behaves exactly as it did. */
  if (cli === 'claude' && effective === '') {
    effective = 'sonnet';
  }

  return {
    cli,
    provider,
    model: effective,
    baseUrl,
    apiKeyEnv: providerCfg?.apiKeyEnv ?? '',
  };
}

export { STAGES as SETTINGS_STAGES };
