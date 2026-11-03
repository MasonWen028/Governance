import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { legacyString } from '../domain/legacy.js';

/**
 * Run records.
 *
 * A stage run leaves two traces in `runs/`, and this module owns both:
 *
 * - `runs/<jobId>.json` — the structured record the API reads back. Written
 *   when the job starts (status `running`) and rewritten when it ends, so a
 *   process that dies mid-run leaves a record that says so.
 * - `runs/<timestamp>-<stage>.log` — the transcript `advance` has always
 *   written (and until 2026-10-30 nothing ever read). Listed here so the UI
 *   can show it; parsed never — it is prose, and parsing prose is how a
 *   second source of truth is born.
 *
 * These files are the audit trail for "the agent ran". Like everything else
 * under `.scratch/`, they outlive the tool.
 */

export const RUNS_DIR = 'runs';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

/**
 * What the run did to the two files only a human may write.
 *
 * `tampered` is not an accusation, it is an observation: the decision log or
 * the gate definitions changed while the agent was running. If that happens the
 * run cannot be read as evidence of anything, because the evidence moved.
 */
export interface RunAudit {
  readonly gatesChanged: boolean;
  readonly decisionsChanged: boolean;
  /** Either of the above. Gate definitions are immutable; decisions are human. */
  readonly tampered: boolean;
  /** Paths git reports as changed outside the feature dir. Null = no git here,
   *  which is not the same as "nothing was written". */
  readonly outsideWrites: readonly string[] | null;
}

export interface RunRecord {
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
  /** Set when the turn came from the demo agent, so a demo run is never
   *  mistaken for a real one — the same honesty the session turns carry. */
  readonly demo: boolean;
  /** Present once the run has ended. Absent on the `running` record: at that
   *  point there is nothing yet to say. */
  readonly audit?: RunAudit | null;
}

function runsDir(featureDir: string): string {
  return join(featureDir, RUNS_DIR);
}

export async function writeRunRecord(featureDir: string, record: RunRecord): Promise<void> {
  const dir = runsDir(featureDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * A record written before the rename carries `effort` where a new one carries
 * `feature`. Read either; the record itself is history, so it stays as written.
 */
function normaliseRecord(raw: unknown): RunRecord {
  const feature = legacyString(raw as Record<string, unknown>, 'feature');
  return { ...(raw as RunRecord), ...(feature !== null ? { feature } : {}) };
}

export async function readRunRecords(featureDir: string): Promise<RunRecord[]> {
  const entries = await readdir(runsDir(featureDir)).catch(() => null);
  if (entries === null) return [];
  const out: RunRecord[] = [];
  for (const f of entries.filter((x) => x.endsWith('.json')).sort()) {
    try {
      const raw = await readFile(join(runsDir(featureDir), f), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as RunRecord).jobId === 'string') {
        out.push(normaliseRecord(parsed));
      }
    } catch {
      // A record that cannot be parsed is skipped; the good ones beside it
      // still count. Corrupting one line must not erase the run history.
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The stage transcripts beside the records, oldest first. Read, never parsed. */
export async function readStageLogs(featureDir: string): Promise<
  { file: string; stage: string | null; bytes: number }[]
> {
  const dir = runsDir(featureDir);
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return [];
  const out: { file: string; stage: string | null; bytes: number }[] = [];
  for (const f of entries.filter((x) => x.endsWith('.log')).sort()) {
    const info = await stat(join(dir, f)).catch(() => null);
    // The log name from planAdvance: <ISO with : and . replaced by ->-<stage>.log
    const m = /-\d+Z-([a-z]+)\.log$/i.exec(f);
    out.push({
      file: f,
      stage: m?.[1] ?? null,
      bytes: info?.size ?? 0,
    });
  }
  return out;
}
