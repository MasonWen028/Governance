/* The adapter between the server's domain model and the view model the renderers
 * were written against.
 *
 * The two are deliberately not the same shape. The domain model is what the
 * server can prove about a working tree; the view model is what the prototype's
 * renderers know how to draw. Keeping the translation in one named place means
 * a change to either side has exactly one file to answer to, rather than being
 * smeared through the rendering code.
 *
 * Nothing here invents a value. Where the server does not know something — how
 * many agents are running, what CI last reported — the field is empty and the UI
 * shows nothing, rather than showing a plausible number.
 */

const STAGE_IDS = ['intake', 'ask', 'spec', 'design', 'split', 'develop', 'review', 'ship', 'retro'];

/* Display labels for the stage ids. The UI needs a name for a stage; the ids
 * themselves are the server's vocabulary. Both languages, because the UI is
 * bilingual and a stage name that only exists in one is a half-translated screen. */
const STAGE_LABEL = {
  intake: { en: 'Concept init', zh: '概念初始化' },
  ask: { en: 'Requirements', zh: '需求澄清' },
  spec: { en: 'Spec', zh: '规格' },
  design: { en: 'Design', zh: '架构设计' },
  split: { en: 'Ticketing', zh: '拆片' },
  develop: { en: 'Build (AFK)', zh: '建造（AFK）' },
  review: { en: 'Acceptance', zh: '验收' },
  ship: { en: 'Release', zh: '发布' },
  retro: { en: 'Retro', zh: '复盘' },
};

/* Domain stage state -> the class the stylesheet already knows. */
const STATE_CLASS = {
  complete: 'done',
  active: 'active',
  blocked: 'blocked',
  ready: 'pending',
  waived: 'done',
  absent: 'pending',
};

function openGates(feature) {
  return (feature.gates || []).filter((g) => g.blocking && !g.__decided);
}

function dotFor(project) {
  const blocked = project.features.reduce((n, e) => n + openGates(e).length, 0);
  if (blocked > 0) return 'blk';
  const active = project.features.some((e) => Object.values(e.stages).includes('active'));
  if (active) return 'run';
  const done =
    project.features.length > 0 &&
    project.features.every((e) => e.stages.retro === 'complete');
  return done ? 'ok' : 'idle';
}

/** The feature a project detail view shows. */
export function featureOf(project, slug) {
  if (!project || project.features.length === 0) return null;
  return project.features.find((e) => e.slug === slug) ?? project.features[0];
}

/**
 * The pipeline rail.
 *
 * `n` is the stage, `sk` is the skill that runs there — read from the chain the
 * server reports, not from a table duplicated here. A stage whose skill is
 * switched off says so, because that is the setting that makes it a human's job.
 */
function pipelineFor(feature, chain) {
  const byStage = new Map((chain || []).map((c) => [c.stage, c]));
  const gated = new Set(feature ? (feature.gates || []).map((g) => g.stage) : []);
  const stages = (feature && feature.stages) || {};
  return STAGE_IDS.map((id) => {
    const c = byStage.get(id);
    let sk;
    if (c === undefined) sk = { en: '—', zh: '—' };
    else if (c.skill === null) sk = { en: 'CI / CD', zh: 'CI / CD' };
    else if (!c.enabled) sk = { en: `${c.skill} (disabled)`, zh: `${c.skill}（已停用）` };
    else if (c.present === false) sk = { en: `${c.skill} (not installed)`, zh: `${c.skill}（未安装）` };
    else sk = { en: c.skill, zh: c.skill };
    return {
      n: id,
      s: feature ? (STATE_CLASS[stages[id]] ?? 'pending') : 'pending',
      sk,
      ...(gated.has(id) ? { g: true } : {}),
    };
  });
}

function operatingIndex(feature) {
  if (!feature) return 0;
  const stages = feature.stages || {};
  for (let i = 0; i < STAGE_IDS.length; i++) {
    const s = stages[STAGE_IDS[i]];
    if (s !== 'complete' && s !== 'waived') return i;
  }
  return STAGE_IDS.length - 1;
}

/** Ticket status -> the board's four classes. */
const TICKET_CLASS = {
  resolved: 'done',
  frontier: 'ready',
  claimed: 'prog',
  blocked: 'blocked',
  open: 'blocked',
  unknown: 'blocked',
};

function ticketsFor(feature) {
  if (!feature) return [];
  const all = Array.isArray(feature.tickets) ? feature.tickets : [];
  // Depth in the blocking graph becomes the column, so the board reads left to
  // right as "blockers first" without anyone declaring an order.
  const depth = (id, seen) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const tk = all.find((x) => x.id === id);
    if (!tk || tk.blockedBy.length === 0) return 0;
    return 1 + Math.max(...tk.blockedBy.map((b) => depth(b, seen)));
  };

  return all.map((tk) => {
    const unmet = tk.blockedBy.filter(
      (b) => !all.some((x) => x.id === b && x.status === 'resolved'),
    );
    return {
      id: tk.id,
      s: TICKET_CLASS[tk.status] ?? 'blocked',
      t: { en: tk.title, zh: tk.title },
      seg: tk.status === 'resolved' ? 4 : 0,
      col: Math.min(5, depth(tk.id, new Set()) + 1),
      d: {
        en:
          unmet.length > 0
            ? `Blocked by ${unmet.join(', ')}`
            : tk.status === 'resolved'
              ? 'Resolved'
              : `${tk.type || 'ticket'} · ${tk.status}`,
        zh:
          unmet.length > 0
            ? `依赖 ${unmet.join(', ')}`
            : tk.status === 'resolved'
              ? '已完成'
              : `${tk.type || 'ticket'} · ${tk.status}`,
      },
      raw: tk,
    };
  });
}

/** Gates arrive already qualified by the server as `<project>/<feature>/<id>`. */
function gatesFor(project, feature) {
  if (!feature) return [];
  return (feature.gates || []).map((g) => ({
    id: g.id,
    ref: `${project.name}/${feature.slug}/${g.id}`,
    /* The stage id, not just its name baked into a display string: the records
     * view has to put a gate on the stage row it belongs to, and parsing it back
     * out of a localised label would break the moment the label changed. */
    stage: g.stage,
    lv: g.onFail === 'escalate' ? 'crit' : 'warn',
    icon: 'gate',
    title: { en: g.title, zh: g.title },
    scope: { en: `${STAGE_LABEL[g.stage]?.en ?? g.stage} · ${g.scope.kind} ${g.scope.ref}`,
             zh: `${STAGE_LABEL[g.stage]?.zh ?? g.stage} · ${g.scope.ref}` },
    trigger: { en: `raised by ${g.raisedBy}`, zh: `来源：${g.raisedBy}` },
    owner: g.owner,
    methods: g.methods,
    block: g.blocking,
    __decided: g.__decided === true,
    body: {
      en:
        g.note ||
        `No decision is recorded against this gate yet. ${
          g.blocking ? 'It is holding its stage.' : 'It is not blocking.'
        }`,
      zh: g.note || '该门还没有决策记录。',
    },
    btns: [
      {
        label: { en: 'Pass', zh: '通过' },
        msg: { en: 'Recorded', zh: '已记录' },
        act: { outcome: 'pass', evidence: [`${g.scope.kind}:${g.scope.ref}`] },
      },
      {
        label: { en: 'Send back', zh: '退回重做' },
        msg: { en: 'Sent back', zh: '已退回' },
        act: { outcome: 'fail', evidence: [`${g.scope.kind}:${g.scope.ref}`] },
      },
      {
        label: { en: 'Skip and record', zh: '跳过并记录' },
        msg: { en: 'Recorded as skipped', zh: '已记为跳过' },
        act: { outcome: 'skip' },
      },
    ],
  }));
}

/** One project -> the view model. */
export function toProjectVM(project, selectedFeature, chain) {
  const feature = featureOf(project, selectedFeature);
  const gateList = gatesFor(project, feature);
  const blockedCount = gateList.filter((g) => g.block && !g.__decided).length;
  const idx = operatingIndex(feature);

  return {
    name: project.name,
    root: project.root,
    /* Which feature the detail view is showing. The server addresses a run by
     * `<root> + <slug>`, and the page has to name the same one the cards show —
     * guessing "the first" would run a stage in a feature nobody was looking at. */
    featureSlug: feature ? feature.slug : null,
    mode: { en: 'Local workspace', zh: '本地工作区' },
    branch: project.git ? `${project.git.branch}${project.git.dirty ? '*' : ''}` : '—',
    head: project.git ? project.git.head : '',
    dot: dotFor(project),
    blk: blockedCount,
    running: 0,
    stageNo: idx + 1,
    stageTotal: STAGE_IDS.length,
    stageName: STAGE_LABEL[STAGE_IDS[idx]],
    updated: '—',
    note: {
      en: feature
        ? `${(feature.tickets || []).length} tickets · ${(feature.warnings || []).length} warnings`
        : project.warnings[0] || 'no features',
      zh: feature
        ? `${(feature.tickets || []).length} 个 ticket · ${(feature.warnings || []).length} 条警告`
        : '无 feature',
    },
    commits: 0,
    pipeline: pipelineFor(feature, chain),
    /* Real per-stage dossiers, replacing the prototype's hardcoded {}. */
    records: recordsFor(feature),
    tickets: ticketsFor(feature),
    gates: gateList,
    ci: { pipe: [], servers: [], releases: [], log: [] },
    /* Every feature the project has, so the page can offer switching between
     * them. Without this the selection was write-only: the wizard set it once
     * and nothing in the UI could ever change it. */
    features: (project.features || []).map((e) => {
      const tk = e.tickets || [];
      return {
        slug: e.slug,
        kind: e.kind,
        destination: e.destination,
        tickets: tk.length,
        frontier: tk.filter((t) => t.status === 'frontier').length,
        warnings: e.warnings || [],
        stages: e.stages || {},
      };
    }),
    warnings: [...(project.warnings || []), ...(feature ? feature.warnings || [] : [])],
    raw: project,
  };
}

/**
 * Per-stage dossier facts, read from the feature's own data — never invented.
 * Keyed 1..9 to match the pipeline's 1-based stage selection. Every stage gets
 * an entry, so every stage can show its own record; a stage that has not run
 * says so in its own section rather than disappearing behind a generic empty
 * panel.
 */
export function recordsFor(feature) {
  if (!feature) return {};
  /* These come off the wire and this is the module's boundary, so a field the
   * server did not send must cost one row, not the whole page: a renderer that
   * throws here blanks every view behind it. */
  const arr = (v) => (Array.isArray(v) ? v : []);
  const runs = arr(feature.runs);
  const tickets = arr(feature.tickets);
  const runsFor = (id) => runs.filter((r) => r.stage === id).slice(-3).reverse();
  const stages = feature.stages || {};
  const stageOf = (id) => stages[id] || 'absent';
  const resolved = tickets.filter((t) => t.status === 'resolved').length;
  const frontier = tickets.filter((t) => t.status === 'frontier').length;
  const notes = arr(feature.notes).length;
  const decisions = arr(feature.decisionsSoFar).length;

  const facts = {
    intake: [
      ['destination', feature.destination || null],
      ['notes', notes > 0 ? notes : null],
      ['decisions', decisions > 0 ? decisions : null],
    ],
    ask: [['grillRounds', feature.sessionRounds > 0 ? feature.sessionRounds : null]],
    spec: [['adrCount', feature.adrCount > 0 ? feature.adrCount : null]],
    design: [[
      'designMode',
      stageOf('design') === 'waived'
        ? 'waived'
        : stageOf('design') === 'complete' ? 'declared' : null,
    ]],
    split: [
      ['tickets', tickets.length > 0 ? `${resolved}/${tickets.length}` : null],
      ['frontier', frontier > 0 ? frontier : null],
    ],
  };

  const out = {};
  STAGE_IDS.forEach((id, i) => {
    const rows = (facts[id] || []).filter(([, v]) => v !== null && v !== undefined);
    const stageRuns = runsFor(id);
    const status = stageOf(id);
    /* Every stage gets an entry, including one that has never run. Skipping it
     * was right when a panel was only quick facts plus runs — an absent stage
     * had nothing to say. It is wrong now: each stage owns a record section,
     * and a stage whose record section is "this has not run yet" is speaking,
     * not silent. Dropping the entry silenced the panel itself, so the honest
     * sentence the stage had to say was replaced by the generic empty state. */
    out[i + 1] = { stage: id, status, rows, runs: stageRuns };
  });
  return out;
}

/** Every project -> the map the renderers index by key. */
export function toProjectsVM(projects, selection, chain) {
  const out = {};
  for (const p of projects) {
    out[p.name] = toProjectVM(p, selection && selection[p.name], chain);
  }
  return out;
}

/* ---- transport ---- */

async function jsonOrThrow(r, what) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || `${what} -> ${r.status}`);
    err.status = r.status;
    /* A 409 from a run with gates is a to-do list, not a failure: the caller
     * needs the gate ids to show *which* question is unanswered. Dropping them
     * here would leave the UI with "no" and nothing to do about it. */
    if (Array.isArray(body.gates)) err.gates = body.gates;
    /* A 409 from a substitution is the same shape of answer: "no" plus the
     * sentence that explains it, and the alternatives that would have passed.
     * The interface needs both to be useful rather than merely negative. */
    if (Array.isArray(body.rejected)) err.rejected = body.rejected;
    if (Array.isArray(body.candidates)) err.candidates = body.candidates;
    throw err;
  }
  return body;
}

export async function fetchProjects() {
  return jsonOrThrow(await fetch('/api/projects'), 'GET /api/projects');
}

/* ---- loading a codebase that already exists ---- *
 *
 * Inspect is a read and safe to call on every keystroke (debounced by the
 * caller). Registering is the one write: it adds a root and drops a single
 * CODEBASE.md inside the repository's own .scratch/. */

export async function inspectCodebase(path) {
  return jsonOrThrow(
    await fetch('/api/codebase?path=' + encodeURIComponent(path)),
    'GET /api/codebase',
  );
}

export async function readerSkills() {
  return jsonOrThrow(await fetch('/api/skills/readers'), 'GET /api/skills/readers');
}

export async function addWorkspace(path, skill) {
  return jsonOrThrow(
    await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, skill: skill || '' }),
    }),
    'POST /api/workspaces',
  );
}

export async function cloneWorkspace(url, dir) {
  return jsonOrThrow(
    await fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, dir }),
    }),
    'POST /api/workspaces/clone',
  );
}

/** Create one folder, one level deep. 409 when something is already there. */
export async function mkdir(path) {
  return jsonOrThrow(
    await fetch('/api/mkdir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
    'POST /api/mkdir',
  );
}

/** Start reading an existing codebase in three passes.
 *
 * 202, not 201: the passes outlive the response and the caller polls. Nothing
 * about the result is known yet, so nothing is claimed. */
export async function discover(target, skill) {
  return jsonOrThrow(
    await fetch('/api/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, ...(skill ? { skill } : {}) }),
    }),
    'POST /api/discover',
  );
}

/** Where a discovery has got to, and what it has actually written. */
export async function discoverStatus(jobId) {
  return jsonOrThrow(
    await fetch('/api/discover?jobId=' + encodeURIComponent(jobId)),
    'GET /api/discover',
  );
}

/** What the tool is doing right now, and what it did recently.
 *
 * Polled rather than streamed: a client that stops asking stops costing
 * anything, and the work being watched here runs for minutes, not
 * milliseconds. */
export async function activity() {
  return jsonOrThrow(await fetch('/api/activity'), 'GET /api/activity');
}

/** The areas a reading named. Listing never creates anything. */
export async function areas(root, outputRoot) {
  return jsonOrThrow(
    await fetch(
      '/api/areas?root=' +
        encodeURIComponent(root) +
        '&outputRoot=' +
        encodeURIComponent(outputRoot || 'docs/discovery'),
    ),
    'GET /api/areas',
  );
}

/** Turn chosen areas into features. Each call is a decision, so it is a POST and
 *  it is never a side effect of merely looking. */
export async function areaFeatures(root, outputRoot, slugs) {
  return jsonOrThrow(
    await fetch('/api/areas/features', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, outputRoot: outputRoot || 'docs/discovery', slugs }),
    }),
    'POST /api/areas/features',
  );
}

/** One directory level, for the folder chooser.
 *
 * A missing `path` asks for the home directory, which is where a chooser should
 * open — not the drive root, and not wherever the server happens to run. The
 * reply carries `empty`, because "is this folder actually new" is the question
 * the empty-project branch is asking, and only the server can answer it. */
export async function browse(path) {
  const q = path ? '?path=' + encodeURIComponent(path) : '';
  return jsonOrThrow(await fetch('/api/browse' + q), 'GET /api/browse');
}

/* ---- skill packs ---- */

export async function skillPacks() {
  return jsonOrThrow(await fetch('/api/skills/packs'), 'GET /api/skills/packs');
}

/** Store (or clear, with an empty skill) a slot's substitution.
 *
 * A 409 here means the skill does not do the slot's job, and the body carries
 * the reason. `jsonOrThrow` turns that into an Error the caller shows — the
 * server is the authority on equivalence, never this file. */
export async function substituteSkill(pack, slot, skill) {
  return jsonOrThrow(
    await fetch('/api/skills/packs/substitute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack, slot, skill: skill || '' }),
    }),
    'POST /api/skills/packs/substitute',
  );
}

export async function installPacks(pack, slot) {
  return jsonOrThrow(
    await fetch('/api/skills/packs/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack: pack || '', slot: slot || '' }),
    }),
    'POST /api/skills/packs/install',
  );
}

export async function fetchSettings() {
  return jsonOrThrow(await fetch('/api/settings'), 'GET /api/settings');
}

export async function saveSettings(settings) {
  return jsonOrThrow(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),
    'PUT /api/settings',
  );
}

export async function fetchChain() {
  return jsonOrThrow(await fetch('/api/chain'), 'GET /api/chain');
}

export async function fetchMcp() {
  return jsonOrThrow(await fetch('/api/mcp'), 'GET /api/mcp');
}

export async function testMcp(name) {
  return jsonOrThrow(
    await fetch('/api/mcp/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    'POST /api/mcp/test',
  );
}

/**
 * Test the agent connection for real: the server runs its probe (a version
 * check plus a minimal live turn) against the CLI being configured.
 */
export async function testAgent(cli, model) {
  return jsonOrThrow(
    await fetch('/api/agent/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli, model }),
    }),
    'POST /api/agent/test',
  );
}

/**
 * Create a feature for real. The server writes the files; this returns where.
 */
export async function initFeature(payload) {
  return jsonOrThrow(
    await fetch('/api/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    'POST /api/init',
  );
}

/* ---- the grilling session ---- */

/** Whether the agent CLI can actually execute, not merely whether it is installed. */
export async function probeAgent() {
  return jsonOrThrow(await fetch('/api/session/agent'), 'GET /api/session/agent');
}

export async function readSession(root, feature) {
  const q = new URLSearchParams({ root, feature });
  return jsonOrThrow(await fetch(`/api/session?${q}`), 'GET /api/session');
}

export async function startSession(root, feature, idea) {
  return jsonOrThrow(
    await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, idea }),
    }),
    'POST /api/session/start',
  );
}

export async function answerSession(root, feature, answers) {
  return jsonOrThrow(
    await fetch('/api/session/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, answers }),
    }),
    'POST /api/session/answer',
  );
}

/**
 * Remove a feature so its name can be used again.
 *
 * With `confirm` false this deletes nothing and returns the list of files that
 * would go — so the interface shows exactly what is at stake before asking. The
 * preview and the action are the same call, which is the only way to be sure the
 * preview describes what the action will do.
 */
export async function resetSession(root, feature, confirm) {
  return jsonOrThrow(
    await fetch('/api/session/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, confirm: confirm === true }),
    }),
    'POST /api/session/reset',
  );
}

export async function finaliseSession(root, feature, force) {
  return jsonOrThrow(
    await fetch('/api/session/finalise', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, force: force === true }),
    }),
    'POST /api/session/finalise',
  );
}

export async function decide(ref, act, actor) {
  return jsonOrThrow(
    await fetch('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gate: ref,
        outcome: act.outcome,
        actor: actor || 'po',
        methods: act.methods || ['signoff'],
        evidence: act.evidence || [],
        ...(act.note === undefined ? {} : { note: act.note }),
        ...(act.reason === undefined ? {} : { reason: act.reason }),
      }),
    }),
    'POST /api/decide',
  );
}

/* ---- stage runs ----
 *
 * The server plans a run, returns the plan before anything spends, then runs it
 * in the background. These three calls are the whole control plane from the
 * page's point of view: ask, watch, stop. */

/** Ask for a stage run. 202 carries the plan; a 409 carries `.gates`. */
export async function startRun(root, feature) {
  return jsonOrThrow(
    await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature }),
    }),
    'POST /api/runs',
  );
}

/** One job's progress. Finished jobs stay readable for a while. */
export async function readRun(jobId) {
  return jsonOrThrow(await fetch(`/api/runs/${encodeURIComponent(jobId)}`), 'GET /api/runs/:id');
}

/** What this feature has run: records and transcripts on disk, plus live jobs. */
export async function readRuns(root, feature) {
  const q = new URLSearchParams({ root, feature });
  return jsonOrThrow(await fetch(`/api/runs?${q}`), 'GET /api/runs');
}

/** The feature's full provenance: rounds, answers, artifacts, decisions, runs. */
export async function readDossier(root, feature) {
  const q = new URLSearchParams({ root, feature });
  return jsonOrThrow(await fetch(`/api/dossier?${q}`), 'GET /api/dossier');
}

/**
 * Insert a change request.
 *
 * Not a ticket. A ticket is a unit of work that has already been specified; a
 * change is *new requirement input*, so it goes into the journal, which reopens
 * the requirements stage — the loop grills it, then spec, design, split and
 * build follow in their usual order. That is what "the change follows the same
 * flow" has to mean, and it is why this call returns something the page then
 * lists as open rather than a ticket it could pretend is ready.
 */
export async function requestChange(root, feature, text) {
  return jsonOrThrow(
    await fetch('/api/change-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, text }),
    }),
    'POST /api/change-request',
  );
}

/**
 * Which feature a sentence is about, without filing anything.
 *
 * Separate from applying for the same reason looking is separate from deciding
 * everywhere else: this one is free to call and safe to call, so the page can
 * show what the rules think before anything is written anywhere.
 */
export async function changeFind(root, text) {
  return jsonOrThrow(
    await fetch('/api/change/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, text }),
    }),
    'POST /api/change/find',
  );
}

/**
 * File a change from a sentence, letting the tool route it.
 *
 * `feature` is optional on purpose: leaving it out asks the tool to find the
 * feature, and a 200 carrying `needsChoice` is its refusal to guess — not an
 * error, but an answer the page has to show and act on.
 */
export async function changeApply(root, text, feature) {
  return jsonOrThrow(
    await fetch('/api/change/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root,
        text,
        ...(feature ? { feature } : {}),
      }),
    }),
    'POST /api/change/apply',
  );
}

/** Close a change, with the note that says how it was dealt with. */
export async function closeChange(root, feature, id, note) {
  return jsonOrThrow(
    await fetch('/api/change-close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, id, note: note || '' }),
    }),
    'POST /api/change-close',
  );
}

/** The integration artifact: branch and a body composed from the record. */
export async function pullRequest(root, feature) {
  return jsonOrThrow(
    await fetch(`/api/pr?root=${encodeURIComponent(root)}&feature=${encodeURIComponent(feature)}`),
    'GET /api/pr',
  );
}

/** Read one artifact's text for inline preview. `path` is relative to the feature. */
export async function readFile(root, feature, path) {
  const q = new URLSearchParams({ root, feature, path });
  return jsonOrThrow(await fetch(`/api/file?${q}`), 'GET /api/file');
}

/**
 * Ask the machine to show a path: the OS file window, or the editor.
 *
 * The server owns the argv; the page only names which verb. A 501 back means
 * the launcher is not installed — which the page must say out loud, because a
 * button that silently does nothing is worse than no button.
 */
export async function reveal(root, feature, path, mode, scope) {
  return jsonOrThrow(
    await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, feature, path: path || '', mode, scope: scope || 'feature' }),
    }),
    'POST /api/reveal',
  );
}

/** Ask a running job to stop. The kill is the server's, not the page's. */
export async function cancelRun(jobId) {
  return jsonOrThrow(
    await fetch(`/api/runs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    'POST /api/runs/:id/cancel',
  );
}

export { STAGE_IDS, STAGE_LABEL };
