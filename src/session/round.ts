/**
 * Parsing a round of questions.
 *
 * The agent writes each round as JSON (the contract is in `prompt.ts`), so the
 * app reads a file rather than scraping prose. That is the same rule the rest of
 * the system follows: **state comes from artifacts, not from what a model said.**
 *
 * The markdown fallback exists because the shape is the `grilling` skill's own
 * documented format, not an accident of formatting:
 *
 *     ❓ **Q1** - **<title>**: <body>
 *     ➡️ <recommended answer>
 *
 * It is a fallback, and every parse says which path it took, so a session that
 * silently degraded to prose-scraping is visible rather than inferred.
 */

export interface RoundQuestion {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly why: string;
  readonly recommended: string;
  readonly options: readonly string[];
}

export interface Round {
  readonly round: number;
  readonly kind: 'questions' | 'prd';
  readonly questions: readonly RoundQuestion[];
  /** The human's answers, written back by the app after a successful answer
   *  turn. The question round is the record of what was asked; without the
   *  answers beside it, "问了几轮、答案是什么" could only be answered by
   *  scraping the turn transcript. Optional: sessions answered before P8 keep
   *  their answers in the transcript only, and the dossier says so. */
  readonly answers?: readonly { readonly id: string; readonly answer: string }[];
  readonly glossaryWritten: readonly string[];
  readonly adrsWritten: readonly string[];
  readonly frontierEmpty: boolean;
  /** Which reader produced this. Surfaced so a fallback is never invisible. */
  readonly source: 'json' | 'markdown' | 'none';
  readonly warnings: readonly string[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function emptyRound(round: number, source: Round['source'] = 'none'): Round {
  return {
    round,
    kind: 'questions',
    questions: [],
    glossaryWritten: [],
    adrsWritten: [],
    frontierEmpty: false,
    source,
    warnings: [],
  };
}

/** The JSON artifact, if it is usable. */
export function parseRoundJson(text: string, expectedRound: number): Round | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;

  const warnings: string[] = [];
  const roundRaw = o['round'];
  const round = typeof roundRaw === 'number' && Number.isFinite(roundRaw) ? Math.round(roundRaw) : expectedRound;
  if (round !== expectedRound) {
    warnings.push(`the artifact says round ${round}, the app expected ${expectedRound}`);
  }

  const kind = o['kind'] === 'prd' ? 'prd' : 'questions';

  const questionsRaw = Array.isArray(o['questions']) ? o['questions'] : [];
  const questions: RoundQuestion[] = [];
  for (const item of questionsRaw) {
    if (item === null || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    const body = str(q['body']);
    const title = str(q['title']);
    if (title.length === 0 && body.length === 0) continue;
    questions.push({
      id: str(q['id']) || `q${questions.length + 1}`,
      title: title || body.slice(0, 60),
      body,
      why: str(q['why']),
      recommended: str(q['recommended']),
      options: strArray(q['options']),
    });
  }

  const frontierEmpty = o['frontierEmpty'] === true;

  /* Answers written back by the app. Tolerant: a malformed entry is dropped
   * rather than poisoning the round, and an answer for a question the round
   * does not contain is kept anyway — the human said it, the record says so. */
  let answers: { id: string; answer: string }[] | undefined;
  if (Array.isArray(o['answers'])) {
    const parsed = (o['answers'] as unknown[])
      .map((a) => (a !== null && typeof a === 'object' ? (a as Record<string, unknown>) : null))
      .filter((a): a is Record<string, unknown> => a !== null)
      .map((a) => ({ id: str(a['id']), answer: str(a['answer']) }))
      .filter((a) => a.id.length > 0 || a.answer.length > 0);
    if (parsed.length > 0) answers = parsed;
  }

  // A round with no questions that does not claim the frontier is empty is a lost
  // round: the app has nothing to show and no reason to advance.
  if (questions.length === 0 && !frontierEmpty && kind !== 'prd') {
    warnings.push('the artifact carried no questions and did not declare the frontier empty');
  }
  // And claiming an empty frontier while also asking questions is contradictory.
  if (questions.length > 0 && frontierEmpty) {
    warnings.push('the artifact asked questions and also claimed the frontier was empty; treating it as open');
  }

  return {
    round,
    kind,
    questions,
    ...(answers !== undefined ? { answers } : {}),
    glossaryWritten: strArray(o['glossaryWritten']),
    adrsWritten: strArray(o['adrsWritten']),
    frontierEmpty: frontierEmpty && questions.length === 0,
    source: 'json',
    warnings,
  };
}

/**
 * The `grilling` skill's own round format.
 *
 * Only used when the JSON artifact is missing. It reads the two documented
 * markers rather than guessing at headings, so it either finds questions or
 * returns nothing — it does not invent them out of prose.
 */
export function parseRoundMarkdown(text: string, expectedRound: number): Round | null {
  const lines = text.split(/\r?\n/);
  const questions: RoundQuestion[] = [];
  const warnings: string[] = [];

  let current: {
    id: string;
    title: string;
    bodyLines: string[];
    recommended: string;
  } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const body = current.bodyLines.join(' ').replace(/\s+/g, ' ').trim();
    questions.push({
      id: current.id,
      title: current.title,
      body,
      why: '',
      recommended: current.recommended,
      options: [],
    });
    current = null;
  };

  // `❓ **Q1** - **title**: body`  — the marker is a question mark in a box,
  // optionally followed by a variation selector, then the bold id.
  const askRe = /^\s*\u2753\uFE0F?\s*\*\*(Q\d+)\*\*\s*[-–—:]?\s*(.*)$/;
  // `➡️ recommended answer`
  const recRe = /^\s*\u27A1\uFE0F?\s*(.*)$/;

  for (const line of lines) {
    const ask = askRe.exec(line);
    if (ask !== null) {
      flush();
      const rest = ask[2] ?? '';
      // `**title**: body`
      const tm = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(rest);
      current = {
        id: ask[1]!,
        title: tm !== null ? tm[1]!.trim() : rest.slice(0, 60),
        bodyLines: tm !== null && (tm[2] ?? '').length > 0 ? [tm[2]!] : [],
        recommended: '',
      };
      continue;
    }
    if (current === null) continue;
    const rec = recRe.exec(line);
    if (rec !== null) {
      current.recommended = rec[1]!.trim();
      continue;
    }
    if (line.trim().length > 0 && !/^[-–—]{3,}$/.test(line.trim())) {
      current.bodyLines.push(line.trim());
    }
  }
  flush();

  if (questions.length === 0) return null;
  warnings.push('read from prose, not from the round artifact');
  return {
    round: expectedRound,
    kind: 'questions',
    questions,
    glossaryWritten: [],
    adrsWritten: [],
    frontierEmpty: false,
    source: 'markdown',
    warnings,
  };
}

/** Read a round from whichever artifact is present. */
export function readRound(
  json: string | null,
  markdown: string | null,
  expectedRound: number,
): Round {
  if (json !== null) {
    const fromJson = parseRoundJson(json, expectedRound);
    if (fromJson !== null) return fromJson;
  }
  if (markdown !== null) {
    const fromMd = parseRoundMarkdown(markdown, expectedRound);
    if (fromMd !== null) return fromMd;
  }
  return emptyRound(expectedRound);
}
