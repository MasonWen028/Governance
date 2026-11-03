import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import { readSettings, skillEnabledFor, skillFor, mcpForStage, resolveAgentFor } from '../config/settings.js';
import type { Settings } from '../config/settings.js';
import { adapterFor } from './adapters.js';
import type { AgentTurn } from './agent.js';
import { resolveCli } from './resolve.js';
import type { ResolvedCli } from './resolve.js';
import { operatingStage } from '../domain/stages.js';
import type { Feature, StageId } from '../domain/types.js';
import { loadWorkspaces } from '../workspaces.js';
import { scanProjects } from '../tracker/discover.js';

/**
 * The stage runner.
 *
 * It spawns a headless agent CLI and hands it a *reference* to the stage — the
 * skill file to read and the directory to work in — never a prompt of its own.
 * That is the whole reason for choosing a CLI over a built-in runtime: there is
 * exactly one copy of each stage's protocol, and it is the skill file, so the two
 * cannot drift.
 *
 * The configured skill chain is consulted, not duplicated. The mapping the runner
 * used to hardcode now lives in settings, and a stage whose skill is switched off
 * is not run at all — it becomes a gate for a human. A settings screen that does
 * not change behaviour would be a lie, and this is where that is made true.
 *
 * Default is a dry run. Spending money is something a foreground command should
 * do only when asked, and the flag is the asking.
 */

export interface AdvanceOptions {
  /** A feature slug, or a path to one. */
  readonly target: string;
  readonly execute: boolean;
  /** Overrides the configured skills root. */
  readonly skillsRoot?: string;
  /** Injected for tests. */
  readonly spawnFn?: typeof spawn;
  readonly now?: () => Date;
  /** Injected for tests, so the settings file is not read from disk. */
  readonly settings?: Settings;
}

/** The stage whose completion the tracker derives from a file, and the file.
 *  Mirrors `MARKERS` in tracker/discover.ts; kept here so the prompt names the
 *  same contract the scanner reads. */
const STAGE_RECORD: Partial<Record<StageId, string>> = {
  /* design was missing, and the omission was load-bearing: the comment above
   * says this table exists so the prompt names the same contract the scanner
   * reads, and with design absent the design prompt named no record at all.
   * Agents wrote design.md by the skill's own convention while the tracker
   * accepted only a field in spec.md — the stage could not complete on the
   * artifact the stage actually produces. */
  design: 'design.md (at the feature root)',
  review: 'review.md (at the feature root, or under reviews/)',
  ship: 'release.md (at the feature root, or under release/)',
  retro: 'retro.md (at the feature root, or under retro/)',
};

export interface AdvancePlan {
  readonly featureSlug: string;
  readonly featureDir: string;
  readonly stage: StageId;
  readonly skill: string | null;
  readonly skillPath: string | null;
  /** Set when the stage will not be run, and why. */
  readonly skipped: 'no-skill' | 'disabled' | null;
  readonly mcp: readonly string[];
  readonly command: readonly string[];
  readonly prompt: string;
  readonly logPath: string;
}

export const DEFAULT_SKILLS_ROOT = 'C:/Users/Administrator/.agents/skills';

/** Build the plan without running anything. Pure, so it can be asserted. */
export function planAdvance(
  feature: Feature,
  skillsRoot: string,
  settings: Settings,
  now: () => Date = () => new Date(),
): AdvancePlan {
  const stage = operatingStage(feature.stages);
  const skill = skillFor(settings, stage);
  const enabled = skillEnabledFor(settings, stage);
  const skillPath = skill === null ? null : join(skillsRoot, skill, 'SKILL.md');
  const mcp = mcpForStage(settings, stage).map((m) => m.name);

  const skipped: AdvancePlan['skipped'] =
    skill === null ? 'no-skill' : enabled ? null : 'disabled';

  // A destination read from a map usually ends in a full stop; appending
  // another produced "Prove the wire.." in every prompt.
  const destination = feature.destination.trim().replace(/[.\s]+$/, '');

  // The prompt names the skill file and the working directory. It does not
  // restate the protocol — restating it is how the two copies begin to disagree.
  /* "Open tickets:" with an empty list after it was what this printed once every
   * ticket was resolved — a label pointing at nothing, in the one prompt an
   * agent reads before deciding whether the work is already done. */
  const openTickets = feature.tickets.filter((t) => t.status !== 'resolved');
  const lines = [
    `Read the skill at ${skillPath ?? '(none - this stage has no skill)'} and follow it.`,
    `Work in ${feature.root}.`,
    `The feature is "${feature.slug}". Its destination: ${destination.length > 0 ? `${destination}.` : '(not stated).'}`,
    openTickets.length > 0
      ? `Open tickets: ${openTickets.map((t) => `${t.id} (${t.status})`).join(', ')}`
      : feature.tickets.length > 0
        ? `All ${feature.tickets.length} ticket(s) are resolved.`
        : 'No tickets yet.',
  ];
  if (mcp.length > 0) {
    lines.push(`MCP servers available to this stage: ${mcp.join(', ')}.`);
  }
  // How this tracker closes work. Not a restatement of the skill's protocol —
  // it is a fact about this workspace that no skill file carries, and without it
  // an agent that finished the work left every ticket saying "ready-for-agent":
  // the stage kept deriving to "active" and nothing downstream could advance.
  // The closing marker is the tracker's, so the stage ladder can see it.
  if (feature.tickets.length > 0) {
    lines.push(
      'This tracker closes a ticket by setting its `**Status:**` line to `resolved` ' +
        'in the ticket file under issues/. Close each ticket as its work lands — ' +
        'the feature cannot advance past develop while tickets read otherwise.',
    );
  }
  // The same for the stages whose completion is a file. The review agent that
  // succeeded without leaving a record kept review deriving to `active`, and
  // the AFK chain correctly refused to re-run it — the contract was the missing
  // part, not the agent's diligence.
  const record = STAGE_RECORD[stage];
  if (record !== undefined) {
    lines.push(`Leave this stage's record as ${record} — the tracker derives this stage's completion from that file.`);
  }
  /* A derived feature starts with a reason, and the reason is the change that
   * created it. Without this the child reads as a feature with no destination
   * and no idea what it is for — its own journal says nothing a stage prompt
   * reads, because nothing has happened in it yet. */
  if (feature.derivedFrom !== undefined && feature.derivedFrom !== null) {
    const from = feature.derivedFrom;
    lines.push(
      '',
      `This feature was opened from ${from.parent}@${from.change}, which was filed as:`,
      `- ${from.text.trim().replace(/\s+/g, ' ')}`,
      `Read ${join(feature.root, 'INHERITED.md')} first: it names what to read in ${from.parent} ` +
        '(an input, not this feature\'s record) and what not to touch there.',
    );
  }

  /* An open change request is why this stage is running. The person who filed it
   * wrote a sentence, not a spec: the ask stage's job is to grill it into
   * requirements the same way the first pass was grilled.
   *
   * The sentence itself is quoted, not summarised, and not replaced by a count.
   * A prompt that said "there is 1 open change request" and nothing else told an
   * agent that something was wrong without telling it what — the run started,
   * produced nothing, and the change sat there. The count is not the requirement. */
  const openChanges = (feature.changes ?? []).filter((c) => c.status === 'open');
  if (openChanges.length > 0 || (feature.openChanges ?? 0) > 0) {
    const quoted = openChanges.map((c) => `- ${c.id}: ${c.text.trim().replace(/\s+/g, ' ')}`);
    lines.push(
      '',
      openChanges.length > 0
        ? `Open change requests (${openChanges.length}), in the human's own words:`
        : `There ${feature.openChanges === 1 ? 'is 1 open change request' : `are ${feature.openChanges} open change requests`}.`,
      ...quoted,
      '',
      'They are requirement input, not tasks. A change re-enters the flow at requirements — ' +
        'it is grilled, then spec, design, tickets and build follow in order, exactly as they ' +
        'did the first time.',
    );
    if (stage === 'ask') {
      lines.push(
        '',
        'This feature already has a spec and work downstream of it, so this pass **amends** ' +
          'that work — it does not replace it. The smallest set of edits that makes the spec ' +
          'and the tickets true again is the whole job:',
        `- Amend ${join(feature.root, 'spec.md')} in the sections the change touches. Leave the rest of it as it stands, even where you would write it differently today.`,
        '- Touch only the tickets the change affects: amend an existing one, or add one. Every other ticket stays exactly as it is.',
        '- Where the change contradicts the spec, the contradiction is a question for the human, not something to resolve silently in either direction.',
        '- If the spec already covers the change, say so and change nothing. Do not invent work to look productive.',
        '- The change stays open until the human accepts it: report what you changed and leave the journal alone. Closing a change is their decision, not this stage\'s.',
      );
    } else {
      lines.push(
        '',
        'This stage is downstream of that: do not absorb a change here, and do not let its ' +
          'output contradict one. If the work this stage is about to do depends on how a change ' +
          'is resolved, stop and say so — it has to be specified first.',
      );
    }
  }
  lines.push(`Do not move any file outside ${feature.root}.`);

  /* The executor is resolved here and frozen into the plan, so a settings
   * change between planning and executing cannot swap the CLI under a run. */
  const resolved = resolveAgentFor(settings);
  const turnish: AgentTurn = {
    prompt: lines.join('\n'),
    sessionId: null,
    cwd: feature.root,
    logPath: '',
    timeoutMs: 0,
    model: resolved.model,
    allowedTools: [],
  };
  const command = [resolved.cli, ...adapterFor(resolved.cli).turnArgs(turnish)];

  return {
    featureSlug: feature.slug,
    featureDir: feature.root,
    stage,
    skill,
    skillPath,
    skipped,
    mcp,
    command,
    prompt: lines.join('\n'),
    logPath: join(
      feature.root,
      'runs',
      `${now().toISOString().replace(/[:.]/g, '-')}-${stage}.log`,
    ),
  };
}

async function findFeature(target: string): Promise<Feature | null> {
  // A direct path to a feature directory, or a slug looked up across workspaces.
  const asPath = resolve(target);
  const looksLikePath = /[\\/]/.test(target);
  if (looksLikePath) {
    const info = await stat(asPath).catch(() => null);
    if (info?.isDirectory() === true) {
      const parent = dirname(asPath);
      const projects = await scanProjects([dirname(parent)]);
      for (const p of projects) {
        for (const e of p.features) {
          if (resolve(e.root) === asPath) return e;
        }
      }
    }
  }
  const roots = (await loadWorkspaces()).roots;
  const projects = await scanProjects(roots);
  for (const p of projects) {
    for (const e of p.features) {
      if (e.slug === target) return e;
    }
  }
  return null;
}

export async function advance(options: AdvanceOptions): Promise<number> {
  const feature = await findFeature(options.target);
  if (feature === null) {
    console.error(`no feature matches "${options.target}"`);
    return 1;
  }

  const settings = options.settings ?? (await readSettings()).settings;
  const skillsRoot = options.skillsRoot ?? DEFAULT_SKILLS_ROOT;

  const plan = planAdvance(feature, skillsRoot, settings, options.now);

  console.log(`feature  ${plan.featureDir}`);
  console.log(`stage   ${plan.stage}`);
  console.log(`skill   ${plan.skill ?? '(none)'}${plan.skipped === 'disabled' ? '  [disabled in settings]' : ''}`);
  if (plan.mcp.length > 0) console.log(`mcp     ${plan.mcp.join(', ')}`);
  console.log(`log     ${plan.logPath}`);
  console.log('');
  console.log('--- prompt ---');
  console.log(plan.prompt);
  console.log('--------------');

  if (plan.skipped !== null) {
    // A disabled skill is the mechanism by which a stage becomes a human's job.
    // Saying so is the whole point of the setting.
    console.log(
      plan.skipped === 'disabled'
        ? `\n"${plan.skill}" is disabled in settings, so this stage will not run.` +
          '\nIt is now a gate for you to work directly.'
        : '\nthis stage has no skill; nothing to run.',
    );
    return 0;
  }
  if (!options.execute) {
    console.log('\nDry run. Re-run with --execute to spawn the agent CLI.');
    return 0;
  }

  if (plan.skillPath !== null) {
    const exists = await stat(plan.skillPath).catch(() => null);
    if (exists === null) {
      console.error(`\nskill file not found: ${plan.skillPath}`);
      return 1;
    }
  }

  const result = await runStage(plan, {
    ...(options.spawnFn !== undefined ? { spawnFn: options.spawnFn } : {}),
    onOutput: (text, stream) => (stream === 'stdout' ? process.stdout : process.stderr).write(text),
  });
  return result.exitCode ?? 1;
}

/* ------------------------------------------------------------------ */
/* The stage-run seam                                                  */
/* ------------------------------------------------------------------ */

/** How a stage run ended, with everything the job registry will need. */
export interface RunStageResult {
  /** Exit code 0. Spawn failures and unresolvable commands are not ok. */
  readonly ok: boolean;
  /** Null when the process never started. */
  readonly exitCode: number | null;
  /** Captured stdout and stderr, in arrival order. */
  readonly output: string;
  /** Null on success; the error or a captured tail on failure. */
  readonly error: string | null;
  readonly ms: number;
  /** `spawn` = the process never ran; `exit` = it ran and failed. */
  readonly phase: 'spawn' | 'exit' | null;
  /** Where the transcript was written — always `plan.logPath`. */
  readonly logPath: string;
}

export interface RunStageOptions {
  /** Injected for tests. */
  readonly spawnFn?: typeof spawn;
  /**
   * Injected for tests. Defaults to the same resolver the session runner
   * uses, so a stage command and a session turn start the CLI the same way —
   * which `advance` never did before: it spawned the bare name, and on
   * Windows that is an ENOENT for any npm-shimmed CLI.
   */
  readonly resolve?: (cli: string) => Promise<ResolvedCli>;
  /** Each output chunk as it arrives, tagged by stream. `advance` echoes. */
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Aborting kills the child. The job registry owns the signal — timeout and
   * cancel are lifecycle decisions, and this seam only obeys.
   */
  readonly signal?: AbortSignal;
}

/**
 * Run one planned stage: resolve the CLI, spawn it in the feature directory,
 * capture the output, and write the transcript to `plan.logPath`.
 *
 * This is the seam the job registry (P2) will call. It is deliberately
 * process-shaped, not governance-shaped: it knows nothing about gates,
 * skills or settings — the plan already encodes all of that, and what runs
 * it is the caller's policy. No timeout here on purpose: `advance` never had
 * one, and a timeout belongs to whoever owns the lifecycle. The job registry
 * will bring one; a bare CLI invocation should not invent its own.
 */
export async function runStage(
  plan: AdvancePlan,
  options: RunStageOptions = {},
): Promise<RunStageResult> {
  const spawnFn = options.spawnFn ?? spawn;
  const resolve = options.resolve ?? resolveCli;
  const started = Date.now();

  const finish = (
    r: Omit<RunStageResult, 'ms' | 'logPath'>,
  ): RunStageResult => ({ ...r, ms: Date.now() - started, logPath: plan.logPath });

  const [rawCmd, ...rest] = plan.command;
  if (rawCmd === undefined) {
    await persistStageLog(plan, '', 'the plan has no command');
    return finish({ ok: false, exitCode: null, output: '', error: 'the plan has no command', phase: 'spawn' });
  }

  let target: ResolvedCli;
  try {
    target = await resolve(rawCmd);
  } catch (err) {
    await persistStageLog(plan, '', `[resolve error] ${(err as Error).message}`);
    return finish({ ok: false, exitCode: null, output: '', error: (err as Error).message, phase: 'spawn' });
  }

  await mkdir(dirname(plan.logPath), { recursive: true });

  /* Cancelled before it began: do not spawn at all. This is the cheapest place
   * to honour a cancel, and the one that matters most — a run that starts
   * after the caller gave up spends real money for nothing. */
  if (options.signal?.aborted === true) {
    await persistStageLog(plan, '', 'cancelled before the process started');
    return finish({
      ok: false,
      exitCode: null,
      output: '',
      error: 'the stage was cancelled before it started',
      phase: 'spawn',
    });
  }

  return await new Promise<RunStageResult>((done) => {
    let settled = false;
    const complete = (r: Omit<RunStageResult, 'ms' | 'logPath'>): void => {
      if (settled) return;
      settled = true;
      done(finish(r));
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(target.command, [...target.args, ...rest], {
        cwd: plan.featureDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      void persistStageLog(plan, '', `[spawn error] ${(err as Error).message}`);
      complete({ ok: false, exitCode: null, output: '', error: (err as Error).message, phase: 'spawn' });
      return;
    }

    let captured = '';
    child.stdout?.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      captured += text;
      options.onOutput?.(text, 'stdout');
    });
    child.stderr?.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      captured += text;
      options.onOutput?.(text, 'stderr');
    });

    /* Kill on abort, and stop listening once the child is gone — a registry
     * that cancels one job must not hold every listener it ever made.
     *
     * `kill()` on a handle whose process does not exist yet is a no-op, so a
     * cancel in the gap between `spawn()` and the OS process is deferred to the
     * `spawn` event rather than silently lost. Without this, a cancel issued
     * immediately after submit let the whole run proceed. */
    const onAbort = (): void => {
      if (child.pid === undefined) child.once('spawn', () => child.kill());
      else child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    /* Closed the window between spawn() and the listener: the abort may have
     * happened in it, and 'abort' fires once, never again. */
    if (options.signal?.aborted === true) onAbort();

    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      void persistStageLog(plan, captured, `[spawn error] ${err.message}`);
      complete({ ok: false, exitCode: null, output: captured, error: err.message, phase: 'spawn' });
    });

    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', onAbort);
      /* A killed process reports code null with a signal — that is not exit 0,
       * and treating it as one would let a cancelled run claim success. */
      const killed = (signal ?? null) !== null;
      const exitCode = killed ? null : (code ?? 0);
      const note = killed
        ? `terminated by signal ${String(signal)}`
        : exitCode === 0
          ? ''
          : `exit ${String(exitCode)}`;
      void persistStageLog(plan, captured, note).finally(() => {
        complete({
          ok: !killed && exitCode === 0,
          exitCode,
          output: captured,
          error:
            !killed && exitCode === 0
              ? null
              : (captured.trim().slice(-800) ||
                (killed
                  ? `the stage was terminated (${String(signal)})`
                  : `the stage exited ${String(exitCode)}`)),
          phase: killed || exitCode !== 0 ? 'exit' : null,
        });
      });
    });
  });
}

/** The transcript format `advance` has always written; runs/ readers depend on it. */
async function persistStageLog(plan: AdvancePlan, output: string, note: string): Promise<void> {
  try {
    await writeFile(
      plan.logPath,
      [
        `# ${plan.stage} - ${plan.skill}`,
        '',
        plan.prompt,
        '',
        '--- output ---',
        '',
        output,
        ...(note.length > 0 ? ['', `--- ${note} ---`, ''] : []),
      ].join('\n'),
      'utf8',
    );
  } catch {
    // A log that cannot be written must not turn a working run into a failure.
  }
}
