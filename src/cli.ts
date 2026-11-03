#!/usr/bin/env node
import { resolve } from 'node:path';

import { operatingStage, completedCount } from './domain/stages.js';
import { STAGE_IDS } from './domain/types.js';
import type { Feature, Project, StageState } from './domain/types.js';
import { scanProjects } from './tracker/discover.js';
import { loadWorkspaces } from './workspaces.js';

const USAGE = `governance - a local control plane for the nine-stage loop

Usage
  governance scan [root ...]        read workspaces and print what is there
  governance serve [--port N]       serve the UI on loopback (default 4173)
                                    --demo  scripted agent, no CLI or credential needed
  governance advance <feature>       run the next stage's skill (dry run by default)

Options
  --execute                         actually spawn the agent CLI (advance)
  --json                            machine-readable output (scan)
  --help

With no root given, scan reads every workspace in governance.workspaces.json.
`;

const GLYPH: Record<StageState, string> = {
  complete: '+',
  active: '>',
  ready: '.',
  blocked: '!',
  waived: '~',
  absent: ' ',
};

function stageStrip(stages: Readonly<Record<string, StageState>>): string {
  return STAGE_IDS.map((id) => GLYPH[stages[id] ?? 'absent']).join('');
}

function featureLine(e: Feature): string {
  const done = completedCount(e.stages);
  const at = operatingStage(e.stages);
  const open = e.tickets.filter((t) => t.status !== 'resolved').length;
  const frontier = e.tickets.filter((t) => t.status === 'frontier').length;
  const bits = [
    stageStrip(e.stages),
    `${done}/${STAGE_IDS.length}`,
    `at ${at}`,
    `${e.tickets.length} tickets`,
    open > 0 ? `${open} open (${frontier} frontier)` : 'all resolved',
  ];
  return `  ${e.slug.padEnd(24)} ${bits.join('  ')}`;
}

function printProject(p: Project): void {
  const git = p.git === undefined ? '' : ` [${p.git.branch}${p.git.dirty ? '*' : ''}]`;
  console.log(`\n${p.name}${git}`);
  console.log(`  ${p.root}`);
  if (p.features.length === 0) {
    console.log('  (no features)');
  } else {
    for (const e of p.features) console.log(featureLine(e));
  }
  for (const w of p.warnings) console.log(`  ! ${w}`);
  for (const e of p.features) {
    for (const w of e.warnings) console.log(`  ! ${e.slug}: ${w}`);
  }
}

async function cmdScan(roots: readonly string[], json: boolean): Promise<number> {
  const list = roots.length > 0 ? roots : (await loadWorkspaces()).roots;
  if (list.length === 0) {
    console.error('no workspaces. Pass a root, or create governance.workspaces.json.');
    return 1;
  }
  const projects = await scanProjects(list);
  if (json) {
    console.log(JSON.stringify(projects, null, 2));
    return 0;
  }
  for (const p of projects) printProject(p);
  console.log('\nlegend  + complete   > active   . ready   ! blocked   ~ waived');
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const command = args.shift()!;
  const json = args.includes('--json');
  const execute = args.includes('--execute');
  const demo = args.includes('--demo');
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && !(portArg >= 0 && i === portArg),
  );

  switch (command) {
    case 'scan':
      return cmdScan(positional.slice(portArg >= 0 ? 1 : 0), json);

    case 'serve': {
      const { serve } = await import('./server/http.js');
      const roots = positional.filter((p) => p !== String(port));
      return serve({
        roots: roots.length > 0 ? roots : (await loadWorkspaces()).roots,
        port,
        demo,
      });
    }

    case 'advance': {
      const { advance } = await import('./exec/runner.js');
      const slug = positional[0];
      if (slug === undefined) {
        console.error('advance needs a feature slug, or a path to one.');
        return 1;
      }
      return advance({ target: slug, execute });
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });

export { main, resolve as _resolve };
