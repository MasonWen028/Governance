import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { STAGE_IDS } from '../domain/types.js';
import type { Gate, StageId } from '../domain/types.js';
import { openBlockingGates, readDecisions } from '../tracker/decisions.js';
import { DECISIONS_FILE } from '../tracker/decisions.js';
import type { RunAudit } from '../tracker/runs.js';
import type { AdvancePlan } from './runner.js';

const execFileAsync = promisify(execFile);

/**
 * Policy: what a run is allowed to be, and what it is checked against after.
 *
 * The job registry arbitrates *physics* — one run per feature, a cap, a clock.
 * This module decides *permission*, and it is deliberately the only place that
 * does. Two questions, in this order:
 *
 * 1. **Admission (before).** May this run start at all? A gate that is behind
 *    the operating stage and still open is the whole reason governance exists:
 *    proceeding past it is not a shortcut, it is the failure mode this system
 *    was built to make visible. Refusing here costs nothing; refusing later
 *    costs a spent run.
 *
 * 2. **Audit (after).** What did it change? Specifically: did the agent touch
 *    the two files that are supposed to be human-only — `gates.json` (gate
 *    definitions are immutable) and `decisions.jsonl` (an approval the agent
 *    wrote itself is not an approval). Any change to either during a run is
 *    reported as `tampered`, because the record must say what happened, not
 *    what should have happened.
 *
 * **What this cannot do, stated plainly.** A spawned CLI is a child process
 * with the user's own permissions. There is no interception here and no
 * sandbox: the write allowlist below is *prevention of our own planner's
 * mistakes* (a wrong feature path, a traversal) and *detection after the fact*
 * via git. An agent determined to write to `C:\Windows` can. The honest
 * position: report what git saw, and say "unknown" when there is no git —
 * never "clean".
 */

/* ------------------------------------------------------------------ gates */

export interface GateRef {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly stage: string;
}

export interface PolicyRefusal {
  readonly ok: false;
  readonly code: 'gate' | 'boundary' | 'disabled' | 'no-skill';
  /** 409 for a state the world is in, 403 for a request that is out of bounds. */
  readonly status: number;
  readonly message: string;
  /** The gates that caused it. Empty for every code but `gate`. */
  readonly gates: readonly GateRef[];
}

export interface PolicyAdmit {
  readonly ok: true;
  /** Blocking gates that are open but *ahead of* the operating stage. They do
   *  not stop this run; they are what it owes after. */
  readonly gatesAhead: readonly GateRef[];
  /** Blocking gates already decided, kept for the record's shape. */
  readonly gatesDecided: number;
}

export type Verdict = PolicyAdmit | PolicyRefusal;

function stageIndex(id: string): number {
  return (STAGE_IDS as readonly string[]).indexOf(id);
}

function ref(g: Gate): GateRef {
  return { id: g.id, title: g.title, owner: g.owner, stage: g.stage };
}

export interface AdmissionInput {
  readonly root: string;
  readonly featureDir: string;
  readonly featureSlug: string;
  readonly gates: readonly Gate[];
  readonly plan: AdvancePlan;
}

/**
 * Is this plan allowed to run?
 *
 * The rule is **at or behind the operating stage**, and it is not arbitrary —
 * it is the same rule the stage derivation already applies. `deriveStages()`
 * marks a stage `blocked` when it has an open blocking gate, and
 * `operatingStage()` then *stops there*: the feature cannot be further along
 * than its first unanswered question. So a gate on the operating stage is
 * exactly the thing making the tile read "blocked".
 *
 * A board that says "blocked" while the Run button still spends money is the
 * two-source-of-truth failure this project exists to avoid. Either `blocked`
 * means something or it should not be displayed.
 *
 * **Why this cannot deadlock.** Only a human clears a gate — §9 settled that,
 * and `appendDecision` is the only writer. So a run is never the sole path out:
 * the answer is always "decide the gate, then run". And a *failed* gate does
 * not block (`gateState` → `failed`, not `open`), so "the human rejected this,
 * redo it" still works — which is the case that would otherwise make this rule
 * unusable in practice.
 *
 * A gate naming a stage that does not exist blocks nothing. Waiting on a typo
 * is waiting forever; that is a data problem and belongs in the warnings.
 */
export async function admit(input: AdmissionInput): Promise<Verdict> {
  const boundary = checkBoundary(input);
  if (boundary !== null) return boundary;

  /* These two used to live in the registry. They are policy, not physics, and
   * the registry should not be the reason a stage cannot run. */
  if (input.plan.skipped === 'disabled') {
    return {
      ok: false,
      code: 'disabled',
      status: 409,
      message: `"${input.plan.skill}" is disabled in settings, so this stage will not run; it is a gate for you to work directly`,
      gates: [],
    };
  }
  if (input.plan.skipped === 'no-skill') {
    return {
      ok: false,
      code: 'no-skill',
      status: 409,
      message: `the stage "${input.plan.stage}" has no skill to run`,
      gates: [],
    };
  }

  const decisions = await readDecisions(input.featureDir);
  const open = openBlockingGates(input.gates, decisions);
  const here = stageIndex(input.plan.stage);

  const inTheWay = open.filter((g) => {
    const at = stageIndex(g.stage);
    /* Unknown stage (or an unreachable one): not a reason to stop the loop. */
    return at >= 0 && here >= 0 && at <= here;
  });

  if (inTheWay.length > 0) {
    const ids = inTheWay.map((g) => g.id).join(', ');
    return {
      ok: false,
      code: 'gate',
      status: 409,
      message:
        `cannot run ${input.plan.stage}: ${String(inTheWay.length)} blocking gate(s) at or behind it ` +
        `are still open (${ids}). Decide them first — a gate is not cleared by running past it.`,
      gates: inTheWay.map(ref),
    };
  }

  return {
    ok: true,
    gatesAhead: open
      .filter((g) => {
        const at = stageIndex(g.stage);
        return at < 0 || here < 0 || at > here;
      })
      .map(ref),
    gatesDecided: input.gates.filter((g) => g.blocking).length - open.length,
  };
}

/**
 * The plan must write where we think it writes.
 *
 * `featureDir` is composed by the server from user input, and `logPath` by the
 * planner. If either escapes `<root>/.scratch/<slug>/`, the run is refused
 * before it starts rather than audited afterwards — a transcript written into
 * the repository root is not a mistake worth discovering in a report.
 */
function checkBoundary(input: AdmissionInput): PolicyRefusal | null {
  const want = resolve(input.root, '.scratch', input.featureSlug);
  const got = resolve(input.featureDir);
  if (got !== want) {
    return {
      ok: false,
      code: 'boundary',
      status: 403,
      message: `the feature directory is outside its slot: expected ${want}, got ${got}`,
      gates: [],
    };
  }
  if (input.featureSlug.length === 0 || /[\\/]/.test(input.featureSlug) || input.featureSlug.startsWith('.')) {
    return {
      ok: false,
      code: 'boundary',
      status: 403,
      message: `refusing a feature slug that is not a single directory name: "${input.featureSlug}"`,
      gates: [],
    };
  }
  const base = resolve(input.featureDir);
  const inside = (p: string): boolean => {
    const target = resolve(p);
    return target === base || target.startsWith(base + sep) || target.startsWith(`${base}/`);
  };
  if (!inside(input.plan.logPath) || !inside(input.plan.featureDir)) {
    return {
      ok: false,
      code: 'boundary',
      status: 403,
      message: `the plan would write outside the feature: ${input.plan.logPath}`,
      gates: [],
    };
  }
  return null;
}

/* ------------------------------------------------------------------ audit */

export interface SnapshotInput {
  readonly root: string;
  readonly featureDir: string;
}

/**
 * What the workspace looked like before the run.
 *
 * `porcelain: null` means *no git here*, not *nothing changed*. The distinction
 * is the entire value of this type: a quiet "no outside writes" when nothing
 * could be checked is worse than no audit at all.
 */
export interface WorkspaceSnapshot {
  readonly gatesHash: string | null;
  readonly decisionsHash: string | null;
  readonly porcelain: readonly string[] | null;
}

async function hashFile(path: string): Promise<string | null> {
  try {
    const data = await readFile(path);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

/** `git status --porcelain` as lines, or null when git cannot answer. */
async function porcelain(root: string): Promise<readonly string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch {
    return null;
  }
}

export async function snapshot(input: SnapshotInput): Promise<WorkspaceSnapshot> {
  const [gatesHash, decisionsHash, dirty] = await Promise.all([
    hashFile(join(input.featureDir, 'gates.json')),
    hashFile(join(input.featureDir, DECISIONS_FILE)),
    porcelain(input.root),
  ]);
  return { gatesHash, decisionsHash, porcelain: dirty };
}

/** The path in a porcelain line: `?? foo/bar`, ` M foo`, `R  a -> b`. */
function porcelainPath(line: string): string {
  const body = line.slice(3);
  const arrow = body.lastIndexOf(' -> ');
  const raw = arrow >= 0 ? body.slice(arrow + 4) : body;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Compare, and report.
 *
 * `outsideWrites` is every path git now reports that it did not report before
 * and that lies outside the feature directory. Two honest limits:
 *
 * - A file that was already dirty before the run and got dirtier keeps the same
 *   porcelain line, so it is not reported. Catching that needs content hashes
 *   over every tracked file, which is a walk this layer will not do on every
 *   run; `git diff` in the UI is the thing that answers it.
 * - If `.scratch/` as a whole is untracked, git collapses it to one entry and
 *   the feature's own writes cannot be told apart from a sibling feature's. That
 *   entry is treated as allowed rather than reported, so a sibling-feature write
 *   would be missed. `.scratch/` being ignored is the normal case and makes
 *   this moot.
 */
export async function auditRun(
  before: WorkspaceSnapshot,
  input: SnapshotInput,
): Promise<RunAudit> {
  const after = await snapshot(input);

  const gatesChanged = before.gatesHash !== after.gatesHash;
  const decisionsChanged = before.decisionsHash !== after.decisionsHash;

  let outsideWrites: string[] | null = null;
  if (before.porcelain !== null && after.porcelain !== null) {
    const slug = input.featureDir.replace(/\\/g, '/').split('/').filter((x) => x.length > 0).pop() ?? '';
    const allowed = [`.scratch/${slug}`, '.scratch'];
    const known = new Set(before.porcelain);
    outsideWrites = after.porcelain
      .filter((line) => !known.has(line))
      .map(porcelainPath)
      .filter((p) => p.length > 0)
      .filter((p) => !allowed.some((a) => p === a || p.startsWith(`${a}/`)));
  }

  return { gatesChanged, decisionsChanged, tampered: gatesChanged || decisionsChanged, outsideWrites };
}

/* -------------------------------------------------------------- utilities */

/** Does this stage id exist in the pipeline? Exported for the refusal tests. */
export function isStageId(id: string): id is StageId {
  return (STAGE_IDS as readonly string[]).includes(id);
}
