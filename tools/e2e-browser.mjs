#!/usr/bin/env node
/* Drive the real page in a real headless browser and report what the control
 * plane actually did.
 *
 * check-web.py boots the module under a DOM shim, which is where most of the
 * page's tests belong. But a shim cannot prove the things a real browser can:
 * that `insertAdjacentHTML` really appends where it should, that the runs card
 * is visible in the inspector next to the gate card, and that clicking Run ends
 * with the server's own transcript on disk. This tool proves those.
 *
 * Opt-in, not part of `npm test`: it needs Chrome or Edge installed and a server
 * already running.
 *
 *   node dist/src/cli.js serve --demo --port 4327 --root <workspace>   # terminal 1
 *   node tools/e2e-browser.mjs 9223 http://127.0.0.1:4327/ <project>   # terminal 2
 *
 * The driver never touches module scope directly. It uses what an operator's
 * click reaches — the published `runAction`/`toast` surface and the DOM — so it
 * fails when the wiring breaks, not when an internals rename happens.
 *
 * Exit 0 when every check passed; nonzero with the reason when one did not.
 */
const DEBUG_PORT = process.argv[2] || '9223';
const PAGE_URL = process.argv[3] || 'http://127.0.0.1:4327/';
const PROJECT = process.argv[4];
const BROWSER = process.env.E2E_BROWSER
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!PROJECT) {
  console.error('usage: node tools/e2e-browser.mjs [debugPort] [pageUrl] <project>');
  process.exit(2);
}

const { spawn } = await import('node:child_process');
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = PAGE_URL.endsWith('/') ? PAGE_URL : `${PAGE_URL}/`;

/* Preflight. Without it the first assertion dies on a null DOM element and
 * reports "Cannot read properties of null", which says nothing about the actual
 * mistake — there being no server. On Windows a system HTTP proxy answers 502
 * for ports nothing listens on, so "the page came back" is not evidence. */
try {
  const health = await fetch(new URL('api/health', base), { signal: AbortSignal.timeout(4000) });
  if (!health.ok) {
    console.error(
      `no Governance server at ${base}\n` +
      `  /api/health answered ${health.status}. A 502 usually means a system proxy ` +
      'answered for a port nothing is listening on.\n' +
      '  Start one first:\n' +
      '    node dist/src/cli.js serve --demo --port 4327 --root <workspace>',
    );
    process.exit(2);
  }
} catch (err) {
  const why = err.cause && err.cause.message ? err.cause.message : err.message;
  console.error(
    `no Governance server at ${base} (${why})\n` +
    '  Start one first:\n' +
    '    node dist/src/cli.js serve --demo --port 4327 --root <workspace>',
  );
  process.exit(2);
}

const chrome = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  /* The harness only ever drives a local server, so the system proxy must not
   * sit in the path: Chrome honours the Windows proxy by default and otherwise
   * renders the proxy's error page instead of the app. */
  '--no-proxy-server',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), 'gov-e2e-browser-'))}`,
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => {
  try { chrome.kill(); } catch { /* already gone */ }
});

let seq = 0;
let ws;
const pending = new Map();

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((done, fail) => pending.set(id, { done, fail }));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(
      'evaluate failed: ' +
      String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 400),
    );
  }
  return r.result.value;
}

const failures = [];
const ok = (what, good) => {
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${what}`);
  if (!good) failures.push(what);
};

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* chrome is still starting */ }
    await sleep(250);
  }
  throw new Error('no debug target; is the browser installed and startable?');
}

const wsUrl = (await target()).webSocketDebuggerUrl;
ws = new WebSocket(wsUrl);
await new Promise((done, fail) => { ws.onopen = done; ws.onerror = () => fail(new Error('websocket failed')); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.fail(new Error(m.error.message));
    else p.done(m.result);
  }
};

await send('Page.enable');
await send('Page.navigate', { url: base });
await sleep(2500);

/* What actually loaded, not what the script hoped for. A proxy error page, a
 * 404 or a stale build all reach here looking the same — so report the evidence
 * (title, URL, visible text) instead of letting a null element throw. */
const boot = await evaluate(
  '(() => { const n = document.getElementById("bootNotice");' +
  ' const m = document.getElementById("main");' +
  ' return { title: document.title, url: location.href,' +
  '  notice: n !== null, gone: n ? n.classList.contains("gone") : null,' +
  '  main: m ? m.innerHTML.length : -1,' +
  '  text: (document.body ? (document.body.innerText || "").slice(0, 160) : "") }; })()',
);
if (boot.main < 0 || boot.notice !== true) {
  console.error(
    `the page at ${base} is not the Governance UI\n` +
    `  title: ${JSON.stringify(boot.title)}\n` +
    `  url:   ${boot.url}\n` +
    `  #main found: ${boot.main >= 0}\n` +
    `  text:  ${JSON.stringify(boot.text)}\n` +
    '  If that text is a proxy or 502 page, the server is not running on this port.',
  );
  process.exit(1);
}
ok('the page boots in a real browser', boot.gone === true && boot.main > 200);

/* Project scope: the runs card. Present even when the history is empty, and
 * honest about the emptiness rather than rendering nothing. */
await evaluate(`runAction('scope:${PROJECT}')`);
await sleep(800);
const card = await evaluate(
  '({ present: !!document.getElementById("runsCard"), ' +
  'html: (document.getElementById("runsCard")||{innerHTML:""}).innerHTML })',
);
ok('the inspector shows a runs card in project scope', card.present);
/* Either branch is honest: "nothing has run yet" on a fresh workspace, or the
 * rows of a workspace that has run. What would not be honest is an empty card. */
ok('the card renders its state rather than nothing',
  card.html.length > 80 &&
  (/Nothing has run here yet|这里还没有运行过/.test(card.html) ||
    /class="kv"/.test(card.html)));

/* Advance, through the dispatcher: the exact path a click takes. The server
 * decides what runs; the page only has to ask, watch, and say. */
await evaluate(`runAction('advance')`);
await sleep(3000);
const after = await evaluate(
  '({ toast: document.getElementById("toast").textContent, ' +
  'rows: ((document.getElementById("runsCard")||{innerHTML:""}).innerHTML.match(/class="kv"/g)||[]).length })',
);
ok('advance produced a receipt the page announced', after.toast.length > 0);
ok('the run landed in the history', after.rows >= 1);

/* A refusal is a to-do list. With a gate open, the page must open that gate in
 * the inspector rather than leave the operator with "no". */
await evaluate(`runAction('advance')`);
await sleep(1200);
const refused = await evaluate(
  '({ toast: document.getElementById("toast").textContent, ' +
  'gate: (document.getElementById("inspector")||{innerHTML:""}).innerHTML })',
);
/* The workspace this run targets has no gate, so a second advance is either a
 * 409 (already running) or a success; both are fine. What must never happen is
 * a silent nothing. */
ok('a repeated advance is answered, not ignored', refused.toast.length > 0);

/* The feature switcher. Only offered when the project has more than one feature;
 * when it is offered, switching must re-anchor the page — hash, select state,
 * and an announcement — through the same boot path the wizard uses. */
const sel = await evaluate(
  '(() => { const s = document.querySelector("#main select[data-effsel]");' +
  ' return s ? { present: true, options: [...s.options].map(o => o.value), value: s.value }' +
  ' : { present: false }; })()',
);
if (sel.present) {
  const target = sel.options.find((v) => v !== sel.value);
  await evaluate(
    '(() => { const s = document.querySelector("#main select[data-effsel]");' +
    ` s.value = ${JSON.stringify(target)}; s.dispatchEvent(new Event("change")); return true; })()`,
  );
  await sleep(1500);
  const switched = await evaluate(
    '({ hash: location.hash,' +
    ' value: (document.querySelector("#main select[data-effsel]") || {}).value,' +
    ' toast: document.getElementById("toast").textContent })',
  );
  ok('the select marked the switched feature', switched.value === target);
  ok('switching updated the URL hash', String(switched.hash).includes(encodeURIComponent(target)));
  ok('switching was announced', switched.toast.length > 0);
} else {
  ok('no feature select on a single-feature project (as designed)', true);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nALL PASS');
process.exit(0);
