import { randomUUID } from 'node:crypto';

import { planAdvance, runStage } from './runner.js';
import type { AdvancePlan, RunStageOptions } from './runner.js';
import { admit, auditRun, snapshot } from './policy.js';
import type { GateRef, WorkspaceSnapshot } from './policy.js';
import { operatingStage } from '../domain/stages.js';
import { appendEvent } from '../tracker/journal.js';
import { writeRunRecord } from '../tracker/runs.js';
import type { RunAudit, RunRecord, RunStatus } from '../tracker/runs.js';
import type { Feature } from '../domain/types.js';
import type { Settings } from '../config/settings.js';

/**
 * The job registry: the control plane between the HTTP surface and the
 * stage-run seam.
 *
 * It is deliberately small, and deliberately in-process. It owns exactly four
 * things, and nothing else:
 *
 * 1. **One run at a time per feature.** Two agents writing one feature
 *    concurrently is not parallelism, it is corruption.
 * 2. **A concurrency cap** across all features, read from settings at submit
 *    time (`maxParallel` — stored and displayed since the first pass, and
 *    until now nothing honoured it).
 * 3. **A timeout per run**, owned here rather than in `runStage`, because a
 *    timeout is a lifecycle decision and the seam is a single invocation.
 * 4. **The run record**, written when the job starts and rewritten when it
 *    ends — so a killed server leaves a record that says `running`, which is
 *    the honest report.
 *
 * It does NOT decide whether a run is *allowed*. That is `policy.ts`, called
 * here so no caller can route around it: admission happens inside submit, and
 * the audit happens inside run, on either side of the spawn. A registry that
 * admitted without reading the decision log would be guessing.
 */

export class JobError extends Error {
  readonly status: number;
  /** The gates that caused a refusal, when a gate did. Carried to the client
   *  so the board can show *which* question is unanswered, not just "no". */
  readonly gates: readonly GateRef[];
  constructor(message: string, status = 400, gates: readonly GateRef[] = []) {
    super(message);
    this.name = 'JobError';
    this.status = status;
    this.gates = gates;
  }
}

export interface JobView {
  readonly jobId: string;
  readonly root: string;
  readonly feature: string;
  readonly stage: string;
  readonly skill: string | null;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly ms: number | null;
  readonly demo: boolean;
  readonly plan: Pick<AdvancePlan, 'skillPath' | 'command' | 'prompt' | 'logPath' | 'mcp'>;
  /** Null while running, and for a server that never got that far. */
  readonly audit: RunAudit | null;
}

export interface SubmitInput {
  readonly root: string;
  readonly featureDir: string;
  readonly feature: Feature;
  readonly settings: Settings;
  readonly skillsRoot: string;
  /** Where per-run configuration comes from — read at submit, then frozen. */
  readonly maxParallel: number;
  readonly timeoutMs: number;
  /**
   * Each output chunk as it arrives, for a caller that wants to show the run
   * while it happens. The registry keeps its own tail regardless; this is the
   * tap, and it is optional because most callers only want the result.
   */
  readonly onOutput?: (text: string) => void;
}

interface Job {
  readonly jobId: string;
  readonly input: SubmitInput;
  readonly plan: AdvancePlan;
  readonly startedAt: string;
  /** Taken before the spawn, compared after it. */
  readonly before: WorkspaceSnapshot | null;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout> | null;
  /** Set by cancel(); wins over the timeout flag when both race. */
  cancelRequested: boolean;
  /** Set when the timeout fires. */
  timedOut: boolean;
  outputTail: string;
  done: JobView | null;
}

export interface RegistryOptions {
  readonly demo?: boolean | undefined;
  /** Injected into every run — tests, and a demo that must not spend. */
  readonly runStageOptions?: Omit<RunStageOptions, 'signal'> | undefined;
  /**
   * The AFK chain. After a run **succeeds**, the registry asks this hook for
   * the next submit's inputs: a freshly scanned feature and freshly read
   * settings (AFK may have been switched off while the run was going). Return
   * null to stop the chain.
   *
   * The registry still owns the loop control, because the loop is a lifecycle
   * decision: it continues only while the operating stage actually advances —
   * a succeeded run that did not move the stage has produced no new
   * information, and re-running blind is spend without a reason. Gate
   * refusals, the parallel cap and no-skill stages all surface as JobError
   * from submit, which is exactly the stop the chain should make: a gate is
   * the human's turn, not an error to swallow.
   */
  readonly autoAdvance?: ((finished: JobView) => Promise<SubmitInput | null>) | undefined;
  /**
   * Told when the chain stops, with the reason and the gates that stopped it.
   *
   * The registry decides to stop; it does not know who is watching. The reason
   * is the interesting half of a stop, and a caller that can put it in front of
   * a person is the only thing that can make "the chain stopped" distinguishable
   * from "the chain finished". Optional, because a registry used without a chain
   * has no stops to report.
   */
  readonly onStop?:
    | ((finished: JobView, why: string, gates: readonly GateRef[]) => void)
    | undefined;
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly demo: boolean;
  private readonly runStageOptions: Omit<RunStageOptions, 'signal'> | undefined;
  private readonly autoAdvance:
    | ((finished: JobView) => Promise<SubmitInput | null>)
    | undefined;
  private readonly onStop:
    | ((finished: JobView, why: string, gates: readonly GateRef[]) => void)
    | undefined;
  /**
   * How many finished jobs stay addressable by id. The durable history is the
   * run records on disk; this map only backs "where did that run get to?", and
   * a long-lived server that never forgets is a leak with good manners.
   */
  private readonly retain = 50;

  constructor(options: RegistryOptions = {}) {
    this.demo = options.demo === true;
    this.runStageOptions = options.runStageOptions;
    this.autoAdvance = options.autoAdvance;
    this.onStop = options.onStop;
  }

  /** Jobs still running, across all features. */
  active(): JobView[] {
    return [...this.jobs.values()].filter((j) => j.done === null).map((j) => this.view(j));
  }

  get(jobId: string): JobView | null {
    const job = this.jobs.get(jobId);
    return job === undefined ? null : this.view(job);
  }

  private runningCount(): number {
    return [...this.jobs.values()].filter((j) => j.done === null).length;
  }

  private runningFor(featureDir: string): Job | undefined {
    return [...this.jobs.values()].find(
      (j) => j.done === null && j.input.featureDir === featureDir,
    );
  }

  /** Drop the oldest finished jobs past the retention cap. Never a running one. */
  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.done !== null);
    const excess = finished.length - this.retain;
    if (excess <= 0) return;
    for (const job of finished.slice(0, excess)) this.jobs.delete(job.jobId);
  }

  /**
   * Submit a stage run. Returns immediately with the id and the plan; the run
   * continues in the background. The plan is returned *before* anything
   * spends, so the caller can show what is about to happen — the same
   * reasoning that makes `advance` a dry run by default.
   *
   * Asynchronous because admission reads the decision log, and a registry that
   * admits without reading it is guessing. It still returns before the run
   * starts: the only thing awaited here is the paperwork.
   */
  async submit(input: SubmitInput): Promise<{ jobId: string; plan: AdvancePlan }> {
    const featureDir = input.featureDir;

    if (this.runningFor(featureDir) !== undefined) {
      throw new JobError(`a run is already in progress for "${input.feature.slug}"`, 409);
    }
    if (this.runningCount() >= Math.max(1, input.maxParallel)) {
      throw new JobError(
        `at the parallel cap (${input.maxParallel} running); wait for one to finish`,
        429,
      );
    }

    const plan = planAdvance(input.feature, input.skillsRoot, input.settings);

    const verdict = await admit({
      root: input.root,
      featureDir,
      featureSlug: input.feature.slug,
      gates: input.feature.gates,
      plan,
    });
    if (!verdict.ok) {
      throw new JobError(verdict.message, verdict.status, verdict.gates);
    }

    /* Taken here, not inside run(): the spawn happens on the next tick, and a
     * snapshot taken after it would be comparing the workspace to itself. */
    const before = await snapshot({ root: input.root, featureDir }).catch(() => null);

    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer =
      input.timeoutMs > 0
        ? setTimeout(() => {
            job.timedOut = true;
            controller.abort();
          }, input.timeoutMs)
        : null;

    const job: Job = {
      jobId,
      input,
      plan,
      startedAt,
      before,
      controller,
      timer,
      cancelRequested: false,
      timedOut: false,
      outputTail: '',
      done: null,
    };
    this.jobs.set(jobId, job);
    this.prune();

    /* The journal records the attempt at the moment it is made — the run record
     * on disk is the outcome, this is the fact that someone asked for the run. */
    await appendEvent(featureDir, {
      kind: 'run.started',
      ref: plan.stage,
      detail: `skill ${plan.skill ?? '(none)'}`,
      data: { jobId, demo: this.demo },
    }).catch(() => undefined);

    /* The start record must land *before* the run, not merely before the call
     * returns. Two independent writes to one file race: with `void` on both,
     * the `running` record can be written after the terminal one and the file
     * is left claiming a run that ended is still going. Sequencing them costs
     * the caller nothing — submit still returns immediately — because the
     * whole chain is off the return path. */
    void (async () => {
      await writeRunRecord(featureDir, this.record(job, 'running')).catch(() => {
        // A record that cannot be written is not, by itself, a reason to refuse
        // the run — the transcript and the registry still hold the truth. But
        // the transcript write in runStage is the load-bearing one.
      });
      await this.run(job);
    })();
    return { jobId, plan };
  }

  /** Cancel a running job. Returns false when the job is not running. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.done !== null) return false;
    job.cancelRequested = true;
    job.controller.abort();
    return true;
  }

  private async run(job: Job): Promise<void> {
    const result = await runStage(job.plan, {
      ...this.runStageOptions,
      signal: job.controller.signal,
      onOutput: (text) => {
        job.outputTail = (job.outputTail + text).slice(-4000);
        job.input.onOutput?.(text);
      },
    });

    if (job.timer !== null) clearTimeout(job.timer);

    const status: RunStatus = job.cancelRequested
      ? 'cancelled'
      : job.timedOut
        ? 'timed_out'
        : result.ok
          ? 'succeeded'
          : 'failed';

    /* The audit runs before the view is published, so `status` and `audit` are
     * never seen out of step: a caller that reads "succeeded" also learns
     * whether the decision log moved while it did. */
    const audit =
      job.before === null
        ? null
        : await auditRun(job.before, { root: job.input.root, featureDir: job.input.featureDir }).catch(
            () => null,
          );

    job.done = {
      jobId: job.jobId,
      root: job.input.root,
      feature: job.input.feature.slug,
      stage: job.plan.stage,
      skill: job.plan.skill,
      status,
      startedAt: job.startedAt,
      endedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      error: status === 'succeeded' ? null : (result.error ?? job.plan.stage),
      ms: result.ms,
      demo: this.demo,
      audit,
      plan: {
        skillPath: job.plan.skillPath,
        command: job.plan.command,
        prompt: job.plan.prompt,
        logPath: job.plan.logPath,
        mcp: job.plan.mcp,
      },
    };

    await writeRunRecord(job.input.featureDir, this.record(job, status)).catch(() => undefined);

    await appendEvent(job.input.featureDir, {
      kind: 'run.ended',
      ref: job.plan.stage,
      detail: `${status}${result.ms > 0 ? ` · ${result.ms} ms` : ''}`,
      data: { jobId: job.jobId, status, demo: this.demo },
    }).catch(() => undefined);

    if (status === 'succeeded' && this.autoAdvance !== undefined) {
      await this.chain(job);
    }
  }

  /**
   * Continue the AFK chain after a succeeded run, or stop. Every stop here is
   * a designed stop, and each one has a reason a human can act on:
   *
   * - the hook returns null — AFK was switched off, or the feature is gone;
   * - the operating stage did not advance — the run succeeded but produced no
   *   new state, so another run now would repeat the same work;
   * - submit refuses — a gate is open (the human's turn), the parallel cap is
   *   hit, or the next stage has no runnable skill.
   *
   * A refusal is reported to the server log, not swallowed silently and not
   * thrown into the void: the chain stopping IS the event.
   */
  private async chain(finished: Job): Promise<void> {
    /* A designed stop is still an event: when AFK is on and nothing follows a
     * succeeded run, "why" is the first thing to check. Silent stops made the
     * chain look broken when it was behaving — and "behaving" was the charitable
     * reading a person could not reach, because the reason was only ever printed
     * to a console they were not watching. So it is written to the journal, next
     * to the run it followed, and handed to whoever is watching. */
    const stop = (why: string, gates: readonly GateRef[] = []): void => {
      console.warn(
        `[afk] chain stopped after ${finished.plan.stage} on "${finished.input.feature.slug}": ${why}`,
      );
      void appendEvent(finished.input.featureDir, {
        kind: 'chain.stopped',
        ref: finished.plan.stage,
        detail: why,
        data: {
          jobId: finished.jobId,
          stage: finished.plan.stage,
          /* The gate ids, so "a gate is open" is followed by *which* gate. A
           * stop that names the obstruction is a to-do; one that does not is a
           * shrug. */
          ...(gates.length > 0 ? { gates: gates.map((g) => g.id) } : {}),
        },
      }).catch(() => undefined);
      this.onStop?.(this.view(finished), why, gates);
    };
    try {
      const next = await this.autoAdvance!(this.view(finished));
      if (next === null) return stop('the hook had nothing to chain');
      if (next.settings.automation.afk !== true)
        return stop('AFK was switched off while the agent worked');
      const nextStage = operatingStage(next.feature.stages);
      if (nextStage === finished.plan.stage)
        return stop(
          `the run did not advance the stage (still ${nextStage}); ` +
            'another run now would repeat the same work',
        );
      await this.submit(next);
    } catch (err) {
      stop(
        err instanceof JobError ? err.message : String(err),
        err instanceof JobError ? err.gates : [],
      );
    }
  }

  private record(job: Job, status: RunStatus): RunRecord {
    const done = job.done;
    return {
      jobId: job.jobId,
      root: job.input.root,
      feature: job.input.feature.slug,
      stage: job.plan.stage,
      skill: job.plan.skill,
      status,
      startedAt: job.startedAt,
      endedAt: done?.endedAt ?? null,
      exitCode: done?.exitCode ?? null,
      error: done?.error ?? null,
      ms: done?.ms ?? null,
      demo: this.demo,
      ...(done === null ? {} : { audit: done.audit }),
    };
  }

  private view(job: Job): JobView {
    if (job.done !== null) return job.done;
    return {
      jobId: job.jobId,
      root: job.input.root,
      feature: job.input.feature.slug,
      stage: job.plan.stage,
      skill: job.plan.skill,
      status: 'running',
      startedAt: job.startedAt,
      endedAt: null,
      exitCode: null,
      error: null,
      ms: null,
      demo: this.demo,
      audit: null,
      plan: {
        skillPath: job.plan.skillPath,
        command: job.plan.command,
        prompt: job.plan.prompt,
        logPath: job.plan.logPath,
        mcp: job.plan.mcp,
      },
    };
  }
}
