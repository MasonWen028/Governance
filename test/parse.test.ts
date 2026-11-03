import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  bullets,
  countGlossaryTerms,
  docTitle,
  field,
  parseBlockedBy,
  parseMap,
  parseTicket,
  sections,
  ticketIdFromFilename,
  ticketSlugFromFilename,
} from '../src/tracker/parse.js';

/* The fixtures below are trimmed excerpts of the real corpus at
 * railyard/.scratch/methodology-view. They are kept byte-similar on purpose: a
 * fixture that is tidier than reality tests a parser nobody needs. */

const REAL_TICKET = `# 01: Registry shape for multi-workspace reads

**Type:** grilling
**Status:** resolved
**Blocked by:** None (can start immediately)

## Question

How does the board learn which workspaces to read?

Decide:

- Where the Registry lives, and whether it is committed at all.
- What one entry declares.

## Proposed answer

Commit a Registry at \`assets/board/workspaces.json\`.

## Comments

Charting note: this ticket was blocked on ticket 02 and sharpened rather than
created by it.

## Answer

**Declared plus discovered.** A committed Registry carries what a scan cannot know.
`;

const REAL_MAP = `# Map: methodology view - CLEARED

## Destination

**Reached, as redrawn by ticket 08.**

> A normative contract plus a working read-only generator, on this branch, that
> renders many Railyard workspaces as one at-a-glance node-and-edge board.

## Notes

- Domain: Railyard governance, Source side. Vocabulary: \`GLOSSARY.md\`.
- Standing preferences: read-only over every workspace it reads.

## Handoff

The map is clear. Per the skill graph, this does **not** loop into implementation
directly.

## Decisions so far

- [Registry shape](issues/01-registry-shape.md): **declared plus discovered**,
  paths relative to a \`registry_base\`.
- [Board state source](issues/03-state-source.md): **live read-only reads only**.

## Not yet specified

- How the graph degrades for a workspace with hundreds of nodes.

## Out of scope

- **Registering \`references/board-contract.md\`** in the governance inventory.
`;

test('docTitle reads the H1 only', () => {
  assert.equal(docTitle(REAL_TICKET), '01: Registry shape for multi-workspace reads');
  assert.equal(docTitle('no heading here'), '');
  // A `##` must never be mistaken for the title.
  assert.equal(docTitle('## Map: x\n\ntext'), '');
});

test('sections splits on h2 and lowercases keys', () => {
  const s = sections(REAL_TICKET);
  assert.ok(s.has('question'));
  assert.ok(s.has('proposed answer'));
  assert.ok(s.has('comments'));
  assert.ok(s.has('answer'));
});

test('sections keeps repeated headings instead of dropping the second', () => {
  const s = sections('## Notes\n\nfirst\n\n## Notes\n\nsecond');
  const v = s.get('notes')!;
  assert.ok(v.includes('first'), 'first body lost');
  assert.ok(v.includes('second'), 'second body lost — a silent drop');
});

test('field reads both colon placements', () => {
  assert.equal(field(REAL_TICKET, 'Type'), 'grilling');
  assert.equal(field(REAL_TICKET, 'Status'), 'resolved');
  assert.equal(field('**Type**: research', 'Type'), 'research');
  // Case-insensitive on the field name, as the corpus varies.
  assert.equal(field(REAL_TICKET, 'type'), 'grilling');
});

test('field treats a placeholder value as absent', () => {
  assert.equal(field('**Answer:** —', 'Answer'), undefined);
  assert.equal(field('**Answer:**', 'Answer'), undefined);
  assert.equal(field('**Answer:**', 'Missing'), undefined);
});

test('bullets join continuations and skip blanks', () => {
  const b = bullets('- one\n  continued\n- two\n\ntext\n- three');
  assert.deepEqual(b, ['one continued', 'two', 'three']);
});

test('parseBlockedBy: "None" is authoritative and yields no edges', () => {
  assert.deepEqual(parseBlockedBy('None (can start immediately)'), {
    ids: [],
    malformed: false,
  });
  // The real corpus keeps historical prose in the Comments, not this line. Were
  // prose allowed here it would manufacture dependencies nobody declared.
  assert.deepEqual(parseBlockedBy('none').ids, []);
});

test('parseBlockedBy extracts ids from the shapes the corpus uses', () => {
  assert.deepEqual(parseBlockedBy('01, 02').ids, ['01', '02']);
  assert.deepEqual(parseBlockedBy('ticket 02').ids, ['02']);
  assert.deepEqual(parseBlockedBy('#7').ids, ['07']);
  assert.deepEqual(parseBlockedBy('issues/03-state-source.md').ids, ['03']);
  assert.deepEqual(parseBlockedBy('02, 13').ids, ['02', '13']);
});

test('parseBlockedBy pads to two digits and sorts', () => {
  assert.deepEqual(parseBlockedBy('9, 10, 2').ids, ['02', '09', '10']);
});

test('parseBlockedBy flags what it cannot understand', () => {
  assert.equal(parseBlockedBy('the registry ticket').malformed, true);
  assert.equal(parseBlockedBy('').malformed, true);
});

test('parseTicket reads the real ticket shape', () => {
  const t = parseTicket(REAL_TICKET, '01', 'registry-shape');
  assert.equal(t.id, '01');
  assert.equal(t.slug, 'registry-shape');
  assert.equal(t.title, 'Registry shape for multi-workspace reads');
  assert.equal(t.type, 'grilling');
  assert.equal(t.rawStatus, 'resolved');
  assert.deepEqual(t.blockedBy, []);
  assert.ok(t.question?.includes('How does the board learn'));
  assert.ok(t.answer?.includes('Declared plus discovered'));
  assert.deepEqual(t.warnings, [], 'a well-formed ticket should raise nothing');
});

test('parseTicket warns rather than dropping a malformed ticket', () => {
  const t = parseTicket('# 01: Bare\n\nno fields at all\n', '01', 'bare');
  assert.equal(t.type, 'unknown');
  assert.equal(t.rawStatus, '');
  assert.ok(t.warnings.length >= 3, 'missing fields must be reported');
  // The ticket still exists. A parser that dropped it would hide a real file.
  assert.equal(t.id, '01');
});

test('parseTicket notices a heading that disagrees with the filename', () => {
  const t = parseTicket('# 07: Wrong\n\n**Type:** task\n**Status:** open\n', '02', 'x');
  assert.ok(t.warnings.some((w) => w.includes('filename says 02')));
});

test('parseTicket rejects an unknown type but keeps the ticket', () => {
  const t = parseTicket(
    '# 03: X\n\n**Type:** wizardry\n**Status:** open\n**Blocked by:** None\n\n## Question\n\nwhy\n',
    '03',
    'x',
  );
  assert.equal(t.type, 'unknown');
  assert.ok(t.warnings.some((w) => w.includes('unrecognised Type')));
});

test('parseMap reads destination, notes and the three scope sections', () => {
  const m = parseMap(REAL_MAP);
  assert.equal(m.cleared, true);
  assert.equal(m.hasHandoff, true);
  assert.ok(m.destination.includes('A normative contract plus a working'));
  // A blockquote destination is unwrapped, not left with its markers.
  assert.ok(!m.destination.includes('>'));
  assert.equal(m.notes.length, 2);
  assert.equal(m.notYetSpecified.length, 1);
  assert.equal(m.outOfScope.length, 1);
});

test('parseMap reads "Decisions so far" as pointer plus gist', () => {
  const m = parseMap(REAL_MAP);
  assert.equal(m.decisionsSoFar.length, 2);
  const first = m.decisionsSoFar[0]!;
  assert.equal(first.title, 'Registry shape');
  assert.equal(first.ref, 'issues/01-registry-shape.md');
  assert.ok(first.gist.includes('declared plus discovered'));
});

test('a map without a Handoff section is not cleared by that signal', () => {
  const m = parseMap('# Map: thing\n\n## Destination\n\n> do it\n');
  assert.equal(m.hasHandoff, false);
  // The title carries no CLEARED either.
  assert.equal(m.cleared, false);
});

test('a CLEARED title marks a map cleared even without a Handoff', () => {
  const m = parseMap('# Map: thing - CLEARED\n\n## Destination\n\n> do it\n');
  assert.equal(m.cleared, true);
});

test('ticketIdFromFilename takes identity from the filename', () => {
  assert.equal(ticketIdFromFilename('01-registry-shape.md'), '01');
  assert.equal(ticketIdFromFilename('9-x.md'), '09');
  assert.equal(ticketIdFromFilename('readme.md'), null);
  assert.equal(ticketIdFromFilename('01-x.txt'), null);
  assert.equal(ticketSlugFromFilename('13-register-at-release.md'), 'register-at-release');
});

test('countGlossaryTerms is a low-bar smoke signal', () => {
  assert.equal(countGlossaryTerms(''), 0);
  assert.ok(countGlossaryTerms('## frame\n\nsomething\n') > 0);
  assert.ok(countGlossaryTerms('- frame: one decoded still\n') > 0);
  assert.ok(countGlossaryTerms('| Word | Meaning |\n|---|---|\n| frame | x |\n') > 0);
  // Prose alone is not a glossary.
  assert.equal(countGlossaryTerms('This is just a paragraph.\n'), 0);
});
