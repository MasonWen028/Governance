/**
 * Mutation sweep.
 *
 * A test that passes proves nothing on its own: it proves the code and the
 * assertion agree *today*. To know the test would actually catch the failure it
 * claims to catch, break the code on purpose and watch it fail. Where it does
 * not fail, the honest conclusion is that the claim was never tested — and the
 * fix is to strengthen the assertion, never to drop it.
 *
 * Usage: node tools/mutate.mjs <plan.json>
 *
 * The plan is a list of { file, old, new, name, tests, expect? }. `old` is
 * replaced at its FIRST occurrence only.
 *
 * Two ways this harness can lie, both of which it now refuses to do silently:
 *
 *   1. A command that never runs. Spawning `npx` through execFile on Windows
 *      fails with ENOENT, which reads exactly like "the tests failed" — every
 *      mutation then reports CAUGHT and the sweep is worthless. Both commands
 *      now run through process.execPath, and a spawn error is reported as
 *      HARNESS-ERROR rather than as a verdict.
 *   2. A mutation that never applies. `old` not found is NO-MATCH, and `old`
 *      appearing more than once is flagged: the first-occurrence rule would
 *      then mutate only one site while the claim is about all of them.
 *
 * A plan may also carry `expect: "SURVIVED"` entries — edits that change the
 * text without changing behaviour. Those are the canary: a harness that calls
 * them CAUGHT is broken, and it says so instead of printing a green total.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TSC = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');

async function tsc() {
  await run(process.execPath, [TSC, '-p', join(root, 'tsconfig.json')], { cwd: root });
}

const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const results = [];

/* Config files the tool itself uses, snapshotted and put back afterwards.
 *
 * A mutant that removes an injected path — "write the workspace list next to
 * the tool instead of where you were told" — makes the suite write into the
 * repository's own list. Restoring the mutant is not enough: the side effect is
 * already on disk. So the sweep puts these back, because leaving 130 deleted
 * temporary folders in the list a human reads would be a worse outcome than the
 * mutant it was looking for. */
const GUARDED = ['governance.workspaces.json', 'governance.settings.json'];
const snapshots = new Map();
for (const name of GUARDED) {
  try {
    snapshots.set(name, await readFile(join(root, name)));
  } catch {
    /* not there; nothing to put back */
  }
}

for (const m of plan) {
  /* Sources here are CRLF on disk, but `old` in a plan is written with \n.
   * Matching against the raw bytes would report NO-MATCH for any multi-line
   * `old`, which is a silent hole: a mutation that never applied looks like a
   * mutation that was never needed. Normalise for matching, restore verbatim. */
  const raw = await readFile(join(root, m.file), 'utf8');
  const crlf = raw.includes('\r\n');
  const original = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const at = original.indexOf(m.old);
  if (at < 0) {
    results.push({ name: m.name, status: 'NO-MATCH' });
    continue;
  }
  const twice = original.indexOf(m.old, at + 1) >= 0;
  const mutated = original.slice(0, at) + m.new + original.slice(at + m.old.length);
  await writeFile(join(root, m.file), crlf ? mutated.replace(/\n/g, '\r\n') : mutated, 'utf8');

  let status;
  try {
    if (Array.isArray(m.check)) {
      /* Some claims live in the page, not in a unit test: the web harness is
       * the thing that checks them, so that is the thing to run. */
      await run(m.check[0], m.check.slice(1), { cwd: root });
    } else {
      /* The suite runs from dist/, so a mutation only exists once it is
       * emitted. Typechecking alone leaves the old build in place, and every
       * verdict becomes a verdict about code that was never run. */
      await tsc();
      /* `tests` may be written as one path or as a list. Spreading a bare
       * string spreads its *characters*, and node is then asked to run a file
       * called `d` — which fails for the same reason a real failure does, so
       * every verdict came back CAUGHT and the sweep agreed with whatever it
       * was told. A harness that cannot distinguish "the tests failed" from
       * "the tests never ran" is worse than no harness, so the shape is
       * normalised here and a spawn error is named rather than read as a
       * verdict. */
      const tests = Array.isArray(m.tests) ? m.tests : [m.tests];
      if (tests.some((p) => typeof p !== 'string' || p.length === 0)) {
        throw new Error(`HARNESS-ERROR(bad tests entry in "${m.name}")`);
      }
      await run(process.execPath, ['--test', '--test-reporter=dot', ...tests], { cwd: root });
    }
    status = 'SURVIVED';
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.killed) {
      status = `HARNESS-ERROR(${err.code ?? 'killed'})`;
    } else {
      status = /TS\d{4}/.test(`${err.stdout ?? ''}${err.stderr ?? ''}`) ? 'BROKE-BUILD' : 'CAUGHT';
    }
  } finally {
    await writeFile(join(root, m.file), original, 'utf8');
    await tsc().catch(() => {});
  }
  results.push({ name: m.name, status, ambiguous: twice, expect: m.expect });
}

for (const [name, bytes] of snapshots) {
  await writeFile(join(root, name), bytes);
}

const broken = [];
console.log('');
for (const r of results) {
  const notes = [];
  if (r.ambiguous) notes.push('`old` appears more than once');
  if (r.expect && r.expect !== r.status) {
    notes.push(`expected ${r.expect}`);
    broken.push(r);
  }
  console.log(`${r.status.padEnd(11)} ${r.name}${notes.length ? `  [${notes.join('; ')}]` : ''}`);
}

const survived = results.filter((r) => r.status !== 'CAUGHT' && !r.expect);
console.log('');
if (broken.length) {
  console.log(`HARNESS IS LYING — ${broken.length} canary/expected verdict(s) came back wrong.`);
} else {
  console.log(`${results.length - survived.length}/${results.length} caught`);
}
if (survived.length) {
  console.log(`${survived.length} need stronger assertions:`);
  for (const r of survived) console.log(`  - ${r.name} (${r.status})`);
}
process.exit(broken.length || survived.length ? 1 : 0);
