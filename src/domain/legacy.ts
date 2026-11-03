/**
 * Reading records written before `effort` became `feature`.
 *
 * On 2026-11-01 the word changed and the files did not. Every record this tool
 * writes to disk — `.session/state.json`, `runs/<jobId>.json`, the journal, a
 * saved `#feature=…` link — was written under the old key, and some of those
 * files are the only trace of a session that already happened.
 *
 * Renaming a key in a reader is a decision about history. These records say
 * *what happened*, and what happened used the old word. Rewriting them so they
 * look modern would be editing the past to suit the present, which is the one
 * thing a governance tool must never do to its own evidence.
 *
 * So the rule is narrow and one-directional: **writers emit `feature`, readers
 * accept either.** A file written yesterday still loads today; a file written
 * today loads tomorrow with no migration step and no flag day.
 */

/** The key an old record used, for the key a new one uses. */
export function legacyKey(key: string): string {
  return key.startsWith('feature') ? `effort${key.slice('feature'.length)}` : key;
}

/**
 * A string field read from a parsed record, preferring the new key and falling
 * back to the old one.
 *
 * Empty and absent are the same answer — a key that is present but blank is not
 * a value worth keeping, and falling through to the old spelling is the right
 * reading of a half-written record. Whitespace is *not* treated as blank: this
 * reader reports what the file says and leaves the verdict to the slug rule, so
 * there is exactly one place that decides what a valid name is.
 */
export function legacyString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (source === null || source === undefined) return null;
  const now = source[key];
  if (typeof now === 'string' && now !== '') return now;
  const old = legacyKey(key);
  if (old === key) return null;
  const then = source[old];
  return typeof then === 'string' && then !== '' ? then : null;
}

/** A query parameter under either spelling. */
export function legacyParam(params: URLSearchParams, key: string): string | null {
  return params.get(key) ?? params.get(legacyKey(key));
}

/** A string field of a JSON request body, under either spelling. */
export function legacyBody(body: Record<string, unknown>, key: string): string {
  return legacyString(body, key) ?? '';
}
