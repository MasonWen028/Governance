/**
 * The bilingual gate.
 *
 * The UI is bilingual by construction: every label goes through `t()`, and both
 * dictionaries have to answer. Two failures are invisible until a human sees
 * them on screen — a key that one language has and the other does not, and a
 * `t('…')` call naming a key neither has. Both render as a raw dotted string in
 * the middle of a sentence, in the language the reader may not be testing in.
 *
 * check-web.py catches raw keys in the markup it happens to render. This one is
 * static: it looks at every call site and every dictionary entry, including the
 * screens the fixture never visits.
 *
 * Run: node tools/check-i18n.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/* The module is a UMD wrapper with no DOM or storage access at load time, so it
 * can be evaluated directly. */
function loadI18n() {
  const src = read('web/i18n.js');
  const mod = { exports: {} };
  new Function('module', 'exports', src + '; return module.exports;')(mod, mod.exports);
  return mod.exports;
}

const i18n = loadI18n();
const DICT = i18n.DICT;
const LANGS = Object.keys(DICT);

/* Sources that call t(). Any file that renders user-visible text belongs here;
 * adding a screen without adding its file is the one way to stay invisible. */
const SOURCES = ['web/index.html', 'web/session.js'];

/* `t('x.y')` — a literal key. `t('role.' + x)` is a prefix, and prefixes cannot
 * be checked statically; they are left out on purpose rather than guessed. */
const LITERAL = /\bt\(\s*'([^']+)'/g;

const problems = [];
const used = new Set();

for (const rel of SOURCES) {
  const text = read(rel);
  for (const m of text.matchAll(LITERAL)) {
    const key = m[1];
    if (key.endsWith('.')) continue; // a prefix, completed at runtime
    used.add(key);
    for (const lang of LANGS) {
      if (!(key in DICT[lang])) problems.push(`${lang} has no "${key}" (used in ${rel})`);
    }
  }
}

/* Dictionary parity, independent of use: a key half the app cannot speak is a
 * half-translated screen waiting for someone to land on it. */
const all = new Set(LANGS.flatMap((l) => Object.keys(DICT[l])));
for (const key of all) {
  const missing = LANGS.filter((l) => !(key in DICT[l]));
  if (missing.length > 0) problems.push(`"${key}" is missing from ${missing.join(', ')}`);
}

/* A key nobody asks for is dead weight, and usually the residue of a rename.
 * Reported, never fatal. Two ways a key is reached without a literal `t('…')`:
 * through data (`{title: 'menu.file'}` → `t(title)`), and through a computed
 * prefix (`t('run.done.' + status)`). Both count as reached — the point of this
 * note is to find keys nothing anywhere names, not to police the call style. */
const quoted = new Set();
for (const rel of SOURCES) {
  for (const m of read(rel).matchAll(/'([A-Za-z][\w-]*(?:\.[\w-]+)*\.?)'/g)) {
    if (m[1].includes('.')) quoted.add(m[1]);
  }
}
const reachedByPrefix = (key) => [...quoted].some((q) => key.startsWith(q));
const unused = [...all].filter((k) => !used.has(k) && !quoted.has(k) && !reachedByPrefix(k));

if (problems.length > 0) {
  console.error('FAIL (i18n)');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(
  `  ok   ${used.size} keys used, ${all.size} defined in ${LANGS.length} languages, none missing`,
);
if (unused.length > 0) {
  console.log(`  note ${unused.length} key(s) referenced nowhere in ${SOURCES.join(' or ')}: ` +
    unused.slice(0, 6).join(', ') + (unused.length > 6 ? ', …' : ''));
}
