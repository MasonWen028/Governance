/**
 * Turning an agent's raw output into a line a human can read.
 *
 * The agent prints newline-delimited JSON: `step_start`, `tool_use`, `text`,
 * `step_finish`, each with the whole session and part envelope around it. Put
 * on screen as-is it is technically "live output" and practically useless —
 * the person watching cannot tell whether it is reading a file, running a
 * command or thinking, which is the only question they are actually asking.
 *
 * So each event is reduced to what it did. Two rules keep it honest:
 *
 * - **Nothing is invented.** A tool event with no file, command or pattern in
 *   it says which tool ran and nothing more. Guessing a target would put words
 *   on screen the agent never said.
 * - **Noise is dropped rather than dressed up.** `step_start` and `step_finish`
 *   mark the boundaries of a step and carry nothing else; showing them as lines
 *   would make the log longer without making it say more.
 *
 * A line that is not JSON — a plain banner, a warning, a stack trace — is
 * passed through. It is already readable, and swallowing it would hide the one
 * output that most needs to be seen.
 */

export interface DescribedEvent {
  /** What to show, or null when the event carries nothing worth a line. */
  readonly text: string | null;
}

/** The tools whose target is worth naming, and where that target lives. */
const TARGET_KEYS = ['filePath', 'path', 'file', 'command', 'pattern', 'query', 'url'] as const;

function targetOf(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** One raw line of agent output -> one readable line, or null. */
export function describeEventLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('{')) return trimmed;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    /* Half a line, or not JSON after all: show it rather than lose it. */
    return trimmed;
  }
  if (event === null || typeof event !== 'object') return null;
  const root = event as Record<string, unknown>;
  const type = typeof root['type'] === 'string' ? root['type'] : '';
  const part = root['part'];
  const p = part !== null && typeof part === 'object' ? (part as Record<string, unknown>) : {};

  if (type === 'step_start' || type === 'step_finish') return null;

  if (type === 'tool_use') {
    const tool = typeof p['tool'] === 'string' ? p['tool'] : 'tool';
    const target = targetOf(p['state'] !== undefined
      ? (p['state'] as Record<string, unknown>)['input']
      : p['input']);
    return target === null ? `using ${tool}` : `${tool} → ${target}`;
  }

  if (type === 'text') {
    const text = typeof p['text'] === 'string' ? p['text'] : '';
    const first = text.replace(/\s+/g, ' ').trim();
    return first.length === 0 ? null : first;
  }

  /* An event whose shape this does not know says nothing rather than printing
   * its own envelope. */
  return null;
}

/**
 * A whole chunk, which may hold several lines or part of one.
 *
 * Returns the lines worth showing. Everything here is derived from what the
 * agent actually emitted, so a log built from it can be read as a record rather
 * than as a guess.
 */
export function describeChunk(chunk: string): readonly string[] {
  const out: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const described = describeEventLine(line);
    if (described !== null) out.push(described);
  }
  return out;
}
