/* The concept-init flow, driven by a real grilling session.
 *
 * Three steps, and the middle one is the whole point:
 *
 *   idea    one fuzzy line, handed to /grill-with-docs verbatim
 *   rounds  real rounds of questions, from the skill, answered round by round
 *   prd     the PRD the skill wrote, with the files it produced
 *
 * The flow this replaced had five steps, two of which (`frame`, `destination`)
 * were invented here rather than by the skill. They asked the human to pick a
 * reading of their own idea and to name a scope before anything had been
 * discussed — which is precisely the work `grilling` exists to do. Pre-empting a
 * skill with a guess about what it will conclude is worse than not asking.
 *
 * Nothing here computes the design. It renders what the session reports and sends
 * back what the human said.
 */

export const FLOW_STEPS = ['idea', 'rounds', 'prd'];

/** Every stage label the header needs, in both languages. */
const STEP_LABEL = {
  idea: { en: 'The idea', zh: '想法' },
  rounds: { en: 'Grilling', zh: '追问' },
  prd: { en: 'PRD', zh: 'PRD' },
};

const STEP_SUB = {
  idea: { en: 'Say it in one line', zh: '一句话说清' },
  rounds: { en: 'Questions, round by round', zh: '一轮一轮地问' },
  prd: { en: 'What the session produced', zh: '这次会话的产出' },
};

export { STEP_LABEL, STEP_SUB };

/**
 * A slug a feature directory can use. Mirrors the server's rule.
 *
 * Takes a few whole words rather than the first forty characters. Slicing a
 * sentence at a fixed offset produced names like
 * `something-that-watches-my-camera-feed-an` — cut mid-word, and long enough to
 * be unreadable as a directory name. Nobody wants to type that, and nobody did:
 * it was the default, so it was what got used.
 */
export function slugify(text, words = 3, maxChars = 24) {
  const parts = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);

  const kept = [];
  for (const w of parts) {
    if (kept.length >= words) break;
    const candidate = [...kept, w].join('-');
    // Always keep at least one word, however long it is.
    if (kept.length > 0 && candidate.length > maxChars) break;
    kept.push(w);
  }
  const slug = kept.join('-').slice(0, 64).replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'new-feature';
}

/**
 * Where a feature will actually be written.
 *
 * Shown next to the name because the name *is* a directory, inside a real
 * repository, and `.scratch/{slug}/` does not make that concrete. A full path
 * does, and it is the thing that makes a bad name look bad before it is used.
 */
export function featurePath(root, slug) {
  if (!root) return `.scratch/${slug}/`;
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]$/, '')}${sep}.scratch${sep}${slug}${sep}`;
}

/**
 * The state the flow keeps while it runs.
 *
 * `phase` is the server's, not ours: the flow does not decide whether the frontier
 * is empty, it reads that from the session. Guessing here would let the UI move on
 * before the grilling had actually finished.
 */
export function blankFlow() {
  return {
    step: 0,
    /* Set when a start is refused because the name is taken. Carries the feature
     * so the interface can offer to clear it rather than dead-ending. */
    stuck: null,
    idea: '',
    ideaTouched: false,
    root: '',
    name: '',
    busy: false,
    phase: null,
    failure: null,
    pending: null,
    answeredRounds: 0,
    history: [],
    agent: null,
    warnings: [],
    error: null,
    files: null,
  };
}

/**
 * Is this refusal one the human can resolve by starting over?
 *
 * Matched on the message because the server has one refusal of this shape. The
 * feature is recovered from the name we tried rather than parsed out of the text.
 */
export function isNameTaken(message, feature) {
  if (typeof message !== 'string') return false;
  return /already exists/i.test(message) && typeof feature === 'string' && feature.length > 0;
}

/* The idea field starts empty. It used to fall back to a hardcoded sample
 * sentence, which read as "the app has decided what I am building" — the field
 * looked filled in when the human had written nothing. The placeholder in the
 * i18n file carries the example now; the field itself carries only what the
 * human typed. */
export function flowIdea(flow) {
  return flow.ideaTouched ? flow.idea : '';
}

/** Can the flow move on from the current step? */
export function canAdvance(flow) {
  const step = FLOW_STEPS[flow.step];
  if (step === 'idea') {
    return flowIdea(flow).trim().length >= 8 && flow.root.length > 0;
  }
  if (step === 'rounds') {
    // The rounds step ends when the session says the frontier is empty, not when
    // the human feels done. There is no "skip ahead" here on purpose.
    return flow.phase === 'ready-for-prd' || flow.phase === 'done';
  }
  return true;
}

/** Every question in the pending round has an answer. */
export function roundComplete(flow, answers) {
  if (flow.pending === null) return false;
  const qs = flow.pending.questions ?? [];
  if (qs.length === 0) return false;
  return qs.every((q) => {
    const a = answers[q.id];
    return typeof a === 'string' && a.trim().length > 0;
  });
}

/** Seed each question with the skill's own recommendation, as the default. */
export function seedAnswers(flow) {
  const out = {};
  for (const q of flow.pending?.questions ?? []) {
    out[q.id] = q.recommended ?? '';
  }
  return out;
}

/**
 * A short, human-readable explanation of why the flow cannot proceed.
 * Returned as a catalog key so the caller localises it.
 */
export function blocker(flow) {
  if (flow.busy) return 'busy';
  if (flow.error !== null) return 'error';
  if (flow.failure !== null) return 'failed';
  const step = FLOW_STEPS[flow.step];
  if (step === 'idea') {
    if (flowIdea(flow).trim().length < 8) return 'ideaShort';
    if (flow.root.length === 0) return 'noRepo';
    if (flow.agent !== null && flow.agent.available === false) return 'agentBlocked';
    return null;
  }
  if (step === 'rounds') {
    if (flow.pending === null) return 'noRound';
    return null;
  }
  return null;
}

/** The files the session is expected to have produced, and whether they exist. */
export function expectedArtifacts(session) {
  const dir = session?.featureDir ?? '';
  return [
    { path: join(dir, 'spec.md'), label: { en: 'The PRD', zh: 'PRD' } },
    { path: join(dir, 'GLOSSARY.md'), label: { en: 'Glossary', zh: '术语表' } },
    { path: join(dir, 'map.md'), label: { en: 'The map', zh: '地图' } },
    { path: join(dir, '.session'), label: { en: 'The conversation', zh: '会话记录' } },
  ];
}

function join(dir, name) {
  if (dir.length === 0) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]$/, '')}${sep}${name}`;
}

/**
 * Fold a server session into the flow state.
 *
 * One place, so a refresh and a turn land in the same shape — and so the flow's
 * step is derived from the session rather than tracked separately, which is what
 * makes resuming after a restart work.
 */
export function absorb(flow, session) {
  const next = { ...flow };
  next.phase = session.phase;
  next.failure = session.failure ?? null;
  next.pending = session.pending ?? null;
  next.answeredRounds = session.answeredRounds ?? 0;
  next.history = session.history ?? [];
  next.warnings = session.warnings ?? [];
  next.error = null;
  next.busy = false;

  if (session.phase === 'done') next.step = 2;
  else if (session.phase === 'ready-for-prd' || session.phase === 'asking') next.step = 1;

  return next;
}

/** How far along, for the header. Deliberately not a percentage. */
export function progress(flow) {
  const total = FLOW_STEPS.length;
  const step = Math.min(flow.step, total - 1);
  if (flow.step === 2) return { text: { en: 'PRD', zh: 'PRD' }, pct: 100 };
  if (step === 0) return { text: { en: 'step 1 of 3', zh: '第 1 步 / 共 3 步' }, pct: 0 };
  return {
    text: {
      en: `round ${flow.answeredRounds + 1}`,
      zh: `第 ${flow.answeredRounds + 1} 轮`,
    },
    pct: 50,
  };
}
