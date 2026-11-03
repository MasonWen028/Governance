import assert from 'node:assert/strict';
import test from 'node:test';

import { windowsShim, winShellLine } from '../src/server/http.js';

/* The launcher was rewritten because "Open in VS Code" started the editor and
 * opened nothing: `shell: true` joins argv with bare spaces, so `cmd.exe` cut
 * `…\space probe` in two. These pin the shapes that failure depended on. */

test('winShellLine quotes the command and every argument', () => {
  assert.equal(
    winShellLine('C:\\Program Files\\Code\\bin\\code.cmd', ['C:\\work\\a b']),
    '""C:\\Program Files\\Code\\bin\\code.cmd" "C:\\work\\a b""',
  );
});

test('winShellLine keeps a space-containing path as one argument', () => {
  const line = winShellLine('code.cmd', ['C:\\work\\space probe']);
  // cmd /s strips the outer pair; what is left is two quoted tokens.
  const inner = line.slice(1, -1);
  assert.deepEqual(inner.match(/"[^"]*"/g), ['"code.cmd"', '"C:\\work\\space probe"']);
  assert.equal(inner.split(' ').length, 3, 'only the two tokens and their separator');
});

test('windowsShim prefers the first directory on PATH', () => {
  const hit = windowsShim('code', 'C:\\first;C:\\second', (c) => c.startsWith('C:\\second'));
  assert.equal(hit, 'C:\\second\\code.cmd');
});

test('windowsShim skips entries a broken PATH leaves behind', () => {
  // Both appear in this machine's PATH: a bare drive letter, and the tail of
  // `C:\Program Files (x86)\…` after the `P` was lost.
  const path = 'G;ram Files (x86)\\Microsoft SQL Server\\160\\Tools\\Binn\\;C:\\real';
  const seen: string[] = [];
  const hit = windowsShim('code', path, (c) => {
    seen.push(c);
    return c === 'C:\\real\\code.exe';
  });
  assert.equal(hit, 'C:\\real\\code.exe');
  assert.equal(seen.length, 3, 'one candidate per extension, for the one usable directory');
});

test('windowsShim ignores MSYS-style PATH entries', () => {
  const seen: string[] = [];
  windowsShim('code', '/usr/bin:/c/Windows', (c) => {
    seen.push(c);
    return false;
  });
  assert.deepEqual(seen, []);
});

test('windowsShim falls back to .bat then .exe', () => {
  assert.equal(windowsShim('code', 'C:\\a', (c) => c.endsWith('.bat')), 'C:\\a\\code.bat');
  assert.equal(windowsShim('code', 'C:\\a', (c) => c.endsWith('.exe')), 'C:\\a\\code.exe');
  assert.equal(windowsShim('code', 'C:\\a', () => false), null);
});

test('windowsShim tolerates a quoted PATH entry', () => {
  const hit = windowsShim('code', '"C:\\Program Files\\Code\\bin"', (c) =>
    c.startsWith('C:\\Program Files\\Code\\bin\\code'),
  );
  assert.equal(hit, 'C:\\Program Files\\Code\\bin\\code.cmd');
});
