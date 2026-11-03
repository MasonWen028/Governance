import { readFile, stat, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { readRound } from '../session/round.js';
import type { Round, RoundQuestion } from '../session/round.js';
import { docTitle, field, sections } from './parse.js';
import { readDecisionsWithWarnings } from './decisions.js';
import { readRunRecords, readStageLogs } from './runs.js';
import { changesFrom, readJournal } from './journal.js';
import type { ChangeRecord, JournalEvent } from './journal.js';
import type { RunRecord } from './runs.js';
import type { Feature, StageId } from '../domain/types.js';

/**
 * The full provenance of one feature — what a stage dossier needs to answer
 * "问了几轮、问了哪些问题、答案是什么、产物是什么、gate 是什么、什么时候通过的、
 * 设计的结果是什么、ticket 是怎么分的、先做的什么后做的什么".
 *
 * Everything here is **read**, never derived or invented: the rounds come from
 * the session artifacts, the tickets from `issues/`, the decisions from the
 * append-only `decisions.jsonl`, the runs from `runs/`. Where a record does not
 * exist the field says so — an absent answer is not the same as no answer.
 */

interface DossierRound {
  readonly round: number;
  readonly kind: 'questions' | 'prd';
  readonly at: string | null;
  readonly answered: boolean;
  readonly questions: readonly RoundQuestion[];
  readonly answers: readonly { readonly id: string; readonly answer: string }[] | null;
  readonly glossaryWritten: readonly string[];
  readonly adrsWritten: readonly string[];
  readonly source: Round['source'];
  readonly warnings: readonly string[];
}

function dossierRound(r: Round, at: string | null, answered: boolean): DossierRound {
  return {
    round: r.round,
    kind: r.kind,
    at,
    answered,
    questions: r.questions,
    answers: r.answers ?? null,
    glossaryWritten: r.glossaryWritten,
    adrsWritten: r.adrsWritten,
    source: r.source,
    warnings: r.warnings,
  };
}

export interface DossierAdr {
  readonly file: string;
  readonly title: string;
  readonly at: string | null;
}

export interface DossierTicket {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
  readonly what: string;
  readonly at: string | null;
  /**
   * The ticket file, relative to the feature directory, or null when the file
   * the scan saw has since gone. Every artifact carries its own path so the
   * interface can open it without guessing where a file lives — a second copy
   * of "where does spec.md sit?" is how the two drift apart.
   */
  readonly file: string | null;
}

/** An artifact the feature has on disk: what it is, and where to read it. */
export interface DossierArtifact {
  readonly exists: boolean;
  readonly path: string | null;
}

export interface DossierDecision {
  readonly ts: string;
  readonly gate: string;
  readonly outcome: string;
  readonly actor: string;
  readonly actorName?: string;
  readonly methods: readonly string[];
  readonly evidence: readonly string[];
  readonly note?: string;
  readonly reason?: string;
}

export interface DossierGate {
  readonly id: string;
  readonly title: string;
  readonly stage: StageId;
  readonly owner: string;
  readonly blocking: boolean;
  readonly raisedBy: string;
  readonly decisions: readonly DossierDecision[];
}

export interface TimelineEvent {
  readonly at: string;
  readonly kind:
    | 'session' | 'round' | 'answer' | 'change'
    | 'run-started' | 'run-ended' | 'decision' | 'ticket' | 'adr' | 'artifact';
  readonly label: string;
  readonly detail: string;
}

/** What the feature believed at the start, before any stage ran. */
export interface DossierConjectures {
  readonly decisions: readonly { readonly title: string; readonly ref: string; readonly gist: string }[];
  readonly notYetSpecified: readonly string[];
  readonly outOfScope: readonly string[];
}

/** A run transcript under `runs/`. Prose, never parsed — only shown. */
export interface DossierLog {
  readonly file: string;
  readonly stage: string | null;
  readonly bytes: number;
}

export interface Dossier {
  /** Where this record lives on disk, and the workspace around it. The page
   *  shows these because "I finished — where is the thing?" is a real question
   *  and hunting for `.scratch/<slug>` by hand is not an answer. */
  readonly featureDir: string;
  readonly workspaceRoot: string;
  /** The concept the feature started from, and where it was found. A session
   *  feature keeps it in `.session/state.json`; a map feature never has one, so
   *  the opening paragraph of `map.md` stands in — and says that it does. */
  readonly idea: string | null;
  readonly ideaSource: 'session' | 'map' | null;
  readonly destination: string | null;
  readonly notes: readonly string[];
  /** What the feature started with: the map's early decisions, the open edges,
   *  and what was declared out of scope. Intake's own record — the stage that
   *  produced them shows them, and no other. */
  readonly conjectures: DossierConjectures;
  readonly rounds: readonly DossierRound[];
  readonly answeredRounds: number;
  readonly glossary: DossierArtifact & { readonly at: string | null };
  readonly adrs: readonly DossierAdr[];
  readonly spec: DossierArtifact & { readonly sections: readonly string[] };
  readonly tickets: readonly DossierTicket[];
  readonly runs: readonly RunRecord[];
  readonly gates: readonly DossierGate[];
  readonly review: DossierArtifact & { readonly title: string | null };
  readonly release: DossierArtifact;
  readonly retro: DossierArtifact;
  /** Run transcripts under `runs/`. The develop stage shows these; parsing
   *  them would be a second source of truth, so they are only offered whole. */
  readonly logs: readonly DossierLog[];
  /** Change requests from the journal: open ones are what the loop must deal with. */
  readonly changes: readonly ChangeRecord[];
  /** The durable event log. The timeline itself comes from here when it exists. */
  readonly journal: readonly JournalEvent[];
  readonly timeline: readonly TimelineEvent[];
  readonly warnings: readonly string[];
}

async function mtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** What a ticket asks for, condensed to one line: the file's own words. */
function ticketWhat(markdown: string): string {
  /* Shown as text, never as markdown — so the emphasis markers and code ticks
   * come out here once, rather than arriving as literal noise in the panel. */
  const plain = (s: string): string => s.replace(/\*\*/g, '').replace(/`/g, '').trim();
  const inline = field(markdown, 'What to build') ?? field(markdown, 'Question');
  if (inline !== undefined && plain(inline).length > 0) return plain(inline);
  /* Most ticket files state the ask under a heading and answer it below, which
   * is not an inline field at all. Reading only `**What to build:**` left `what`
   * empty for every ticket in a real feature — the split panel then listed
   * thirteen tickets and said nothing about any of them. */
  const secs = sections(markdown);
  const body = secs.get('what to build') ?? secs.get('question') ?? '';
  for (const block of body.split(/\n\s*\n/)) {
    const para = block.trim();
    if (para.length === 0 || para.startsWith('```') || para.startsWith('|')) continue;
    return plain(para.replace(/\s+/g, ' '));
  }
  return '';
}

/**
 * The opening concept of a map: its first paragraph of prose.
 *
 * A map has no session state to hold the operator's idea, so `map.md` is the
 * only place the feature's starting intent is written down. Headings are skipped
 * — "# Map: methodology-view" names the file, it does not state the concept —
 * and so are table rows and list bullets, which are the map's body, not its
 * opening. Fenced code is skipped because a prototype snippet is not prose. A
 * leading quote marker is stripped: `> Prove the API.` says "Prove the API."
 *
 * It is a paragraph, not a line: prose in these files is wrapped at eighty
 * columns, so taking the first line ends the concept mid-sentence — the same
 * defect as an empty field, wearing a plausible sentence.
 */
function mapConcept(markdown: string): string | null {
  let fenced = false;
  const para: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim().replace(/^>\s*/, '');
    if (line.startsWith('```')) {
      if (para.length > 0) break;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line === '' || line.startsWith('#') || line.startsWith('|') || /^[-*+]\s/.test(line)) {
      if (para.length > 0) break;
      continue;
    }
    para.push(line);
  }
  if (para.length === 0) return null;
  /* The panel shows this as text, not as markdown, so emphasis markers and
   * code ticks would arrive as literal noise. Removing them is a rendering
   * decision taken once, here, rather than a hope that every caller renders. */
  const text = para.join(' ').replace(/\s+/g, ' ').replace(/\*\*/g, '').replace(/`/g, '').trim();
  return text.length > 400 ? `${text.slice(0, 397).trimEnd()}...` : text;
}

/**
 * The workspace a `.scratch/<slug>` directory belongs to.
 *
 * Derived rather than passed in, so the two callers that already know the
 * feature directory cannot disagree about it. If the layout ever stops being
 * `<root>/.scratch/<slug>`, the answer degrades to "the parent", which is still
 * a directory that exists — a wrong-but-real path beats an invented one.
 */
function workspaceRootOf(featureDir: string): string {
  const dir = resolve(featureDir);
  const parent = dirname(dir);
  return basename(parent) === '.scratch' ? dirname(parent) : parent;
}

/** Read the feature's full provenance. Pure read; never throws for missing pieces. */
export async function readDossier(feature: Feature, featureDir: string): Promise<Dossier> {
  const warnings: string[] = [];
  const sessionDir = join(featureDir, '.session');

  /* --- the conversation: every round on disk, with its answers --- */
  const roundFiles = (await listFiles(sessionDir)).filter((f) => /^\d{2}\.json$/.test(f));
  const rounds: DossierRound[] = [];
  const stateRaw = await readTextOrNull(join(sessionDir, 'state.json'));
  let idea: string | null = null;
  if (stateRaw !== null) {
    try {
      const s = JSON.parse(stateRaw) as Record<string, unknown>;
      idea = typeof s['idea'] === 'string' && s['idea'].length > 0 ? s['idea'] : null;
    } catch {
      warnings.push('.session/state.json is not valid JSON; the idea text is unavailable');
    }
  }
  let ideaSource: 'session' | 'map' | null = idea !== null ? 'session' : null;
  /* A map feature has no session state, so its concept lives only in map.md.
   * Without this the intake panel showed an empty "original idea" for exactly
   * the features that do have one — and the empty string read as "there was
   * none", which is a false statement about a file that opens with the intent. */
  if (idea === null) {
    const mapRaw = await readTextOrNull(join(featureDir, 'map.md'));
    const concept = mapRaw !== null ? mapConcept(mapRaw) : null;
    if (concept !== null) {
      idea = concept;
      ideaSource = 'map';
    }
  }
  for (const f of roundFiles) {
    const raw = await readTextOrNull(join(sessionDir, f));
    if (raw === null) continue;
    const expected = Number(f.slice(0, 2));
    const r = readRound(raw, null, expected);
    if (r.source === 'none') {
      warnings.push(`${f} could not be read as a round artifact`);
      continue;
    }
    const answered = r.questions.length > 0 && (r.answers?.length ?? 0) > 0;
    rounds.push(dossierRound(r, await mtime(join(sessionDir, f)), answered));
  }
  rounds.sort((a, b) => a.round - b.round);
  const answeredRounds = rounds.filter((r) => r.answered).length;
  /* Rounds answered before P8 have no answers field; the transcript has them. */
  const unrecorded = rounds.filter((r) => r.questions.length > 0 && r.answers === null).length;
  if (unrecorded > 0) {
    warnings.push(
      `${unrecorded} answered round(s) predate answer recording; ` +
        'their answers live in the turn transcripts under .session/turns/',
    );
  }

  /* --- the artifacts --- */
  const glossaryRaw = await readTextOrNull(join(featureDir, 'GLOSSARY.md'));
  const glossary = {
    exists: glossaryRaw !== null,
    at: await mtime(join(featureDir, 'GLOSSARY.md')),
    path: glossaryRaw !== null ? 'GLOSSARY.md' : null,
  };

  const adrFiles = (await listFiles(join(featureDir, 'docs', 'adr'))).filter((f) => f.endsWith('.md'));
  const adrs: DossierAdr[] = [];
  for (const f of adrFiles) {
    const raw = await readTextOrNull(join(featureDir, 'docs', 'adr', f));
    adrs.push({
      file: `docs/adr/${f}`,
      title: raw !== null ? docTitle(raw) || f : f,
      at: await mtime(join(featureDir, 'docs', 'adr', f)),
    });
  }

  const specRaw = await readTextOrNull(join(featureDir, 'spec.md'));
  /* The headings as written — `sections()` lowercases its keys for lookup, and
   * a table of contents that shouted at the author is a small dishonesty. */
  const specSections: string[] = [];
  if (specRaw !== null) {
    for (const line of specRaw.split(/\r?\n/)) {
      const m = /^##\s+(.*?)\s*$/.exec(line);
      if (m) specSections.push(m[1]!.trim());
    }
  }

  /* --- the tickets: status and graph come from the scan (single-sourced),
   *     the file adds its own words and its timestamp --- */
  const tickets: DossierTicket[] = [];
  for (const t of feature.tickets) {
    const rel = `issues/${t.id}-${t.slug}.md`;
    const raw = await readTextOrNull(join(featureDir, rel));
    tickets.push({
      id: t.id,
      slug: t.slug,
      title: t.title,
      type: t.type,
      status: t.status,
      blockedBy: t.blockedBy,
      what: raw !== null ? ticketWhat(raw) : '',
      at: raw !== null ? await mtime(join(featureDir, rel)) : null,
      file: raw !== null ? rel : null,
    });
  }

  /* --- the execution record and the decisions --- */
  const runs = await readRunRecords(featureDir).catch(() => [] as RunRecord[]);

  const gateDecisions = await readDecisionsWithWarnings(featureDir);
  warnings.push(...gateDecisions.warnings.map((w) => `decisions.jsonl: ${w}`));
  const gates: DossierGate[] = (feature.gates || []).map((g) => ({
    id: g.id,
    title: g.title,
    stage: g.stage,
    owner: g.owner,
    blocking: g.blocking,
    raisedBy: g.raisedBy,
    decisions: gateDecisions.decisions
      .filter((d) => d.gate === g.id)
      .map((d) => ({ ...d })),
  }));
  /* Decisions naming a gate that no longer exists stay on the record — a log
   * entry silently vanishing is exactly what this file exists to prevent. */
  const known = new Set(gates.map((g) => g.id));
  for (const d of gateDecisions.decisions) {
    if (!known.has(d.gate)) {
      warnings.push(`a decision names gate "${d.gate}", which no gates.json entry defines`);
    }
  }

  const reviewRaw = await readTextOrNull(join(featureDir, 'review.md'));
  const review = {
    exists: reviewRaw !== null,
    title: reviewRaw !== null ? docTitle(reviewRaw) : null,
    path: reviewRaw !== null ? 'review.md' : null,
  };
  const releaseRaw = await readTextOrNull(join(featureDir, 'release.md'));
  const release = {
    exists: releaseRaw !== null,
    path: releaseRaw !== null ? 'release.md' : null,
  };
  const retroRaw = await readTextOrNull(join(featureDir, 'retro.md'));
  const retro = {
    exists: retroRaw !== null,
    path: retroRaw !== null ? 'retro.md' : null,
  };

  const logs = await readStageLogs(featureDir).catch(() => [] as DossierLog[]);

  /* --- the durable record ---
   *
   * The journal, when it exists, is the authority on *what happened and when*:
   * it was written by the app at the moment of the event, so it survives a
   * checkout, a copy or a re-clone, none of which preserve mtimes. Only when
   * there is no journal at all does the timeline fall back to file mtimes, and
   * the fallback says so. */
  const journalRead = await readJournal(featureDir);
  for (const w of journalRead.warnings) warnings.push(`journal: ${w}`);
  const changes = changesFrom(journalRead.events);

  const KIND_OF: Record<string, TimelineEvent['kind']> = {
    'session.started': 'session',
    'session.finished': 'session',
    'round.written': 'round',
    'answer.recorded': 'answer',
    'change.opened': 'change',
    'change.closed': 'change',
    'run.started': 'run-started',
    'run.ended': 'run-ended',
    'decision.recorded': 'decision',
  };

  /* --- the merged timeline: 先做的什么，后做的什么 --- */
  const timeline: TimelineEvent[] = [];
  if (journalRead.events.length > 0) {
    for (const e of journalRead.events) {
      const kind = KIND_OF[e.kind] ?? 'artifact';
      timeline.push({ at: e.at, kind, label: e.ref, detail: e.detail });
    }
    /* Artifacts the agent wrote are not app events — they enter the timeline from
     * the files, which is the only place that knows they exist. */
    for (const a of adrs) {
      if (a.at !== null) timeline.push({ at: a.at, kind: 'adr', label: a.file, detail: a.title });
    }
    for (const t of tickets) {
      if (t.at !== null) {
        timeline.push({
          at: t.at, kind: 'ticket', label: `ticket ${t.id}`,
          detail: `${t.title} (${t.status})`,
        });
      }
    }
  } else {
    warnings.push(
      'no journal for this feature yet; the timeline is reconstructed from file ' +
        'timestamps, which a checkout or a copy does not preserve',
    );
    for (const r of rounds) {
      if (r.at !== null) {
        timeline.push({
          at: r.at,
          kind: 'round',
          label: `round ${r.round}`,
          detail:
            r.kind === 'prd'
              ? 'the PRD turn'
              : `${r.questions.length} question(s) asked${r.answers ? ', answered' : ''}`,
        });
      }
    }
    for (const a of adrs) {
      if (a.at !== null) {
        timeline.push({ at: a.at, kind: 'adr', label: a.file, detail: a.title });
      }
    }
    if (glossary.at !== null) {
      timeline.push({ at: glossary.at, kind: 'artifact', label: 'GLOSSARY.md', detail: 'the language' });
    }
    for (const t of tickets) {
      if (t.at !== null) {
        timeline.push({
          at: t.at,
          kind: 'ticket',
          label: `ticket ${t.id}`,
          detail: `${t.title} (${t.status})`,
        });
      }
    }
    for (const r of runs) {
      timeline.push({
        at: r.startedAt,
        kind: 'run-started',
        label: `${r.stage} run`,
        detail: `skill ${r.skill ?? '(none)'}`,
      });
      if (r.endedAt !== null) {
        timeline.push({
          at: r.endedAt,
          kind: 'run-ended',
          label: `${r.stage} run`,
          detail: `${r.status}${r.ms !== null ? ` · ${r.ms} ms` : ''}`,
        });
      }
    }
    for (const d of gateDecisions.decisions) {
      timeline.push({
        at: d.ts,
        kind: 'decision',
        label: `gate ${d.gate}`,
        detail: `${d.outcome} by ${d.actor}${d.actorName ? ` (${d.actorName})` : ''}`,
      });
    }
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    featureDir: resolve(featureDir),
    workspaceRoot: workspaceRootOf(featureDir),
    idea,
    ideaSource,
    destination: feature.destination || null,
    notes: feature.notes,
    conjectures: {
      decisions: feature.decisionsSoFar,
      notYetSpecified: feature.notYetSpecified,
      outOfScope: feature.outOfScope,
    },
    rounds,
    answeredRounds,
    glossary,
    adrs,
    spec: {
      exists: specRaw !== null,
      sections: specSections,
      path: specRaw !== null ? 'spec.md' : null,
    },
    tickets,
    runs,
    gates,
    review,
    release,
    retro,
    logs,
    changes,
    journal: journalRead.events,
    timeline,
    warnings,
  };
}
