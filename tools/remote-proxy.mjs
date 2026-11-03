#!/usr/bin/env node
/**
 * A reverse proxy that lets a tunnel reach the control plane.
 *
 * Why this exists at all: `serve` binds 127.0.0.1 and refuses any request whose
 * Host header is not loopback (src/server/http.ts, the `guard` function). That
 * check is DNS-rebinding armor and it is load-bearing — the server has no
 * authentication and, by its own design, never will. A tunnel terminates at a
 * public hostname, so it arrives with `Host: <something>.trycloudflare.com` and
 * every single request is answered 403 before it reaches a route.
 *
 * So this proxy rewrites the two headers the guard reads, and nothing else:
 *
 *   Host   -> 127.0.0.1:<target>      so the Host check passes
 *   Origin -> removed                 so the mutation check takes its
 *                                     "non-browser caller" branch, which is
 *                                     explicitly allowed
 *
 * WHAT THIS MEANS, STATED PLAINLY: anyone who can reach the tunnel URL can read
 * every file under your configured workspace roots, create projects, submit
 * changes, advance stages, and run an agent that spends your money. There is no
 * login. Putting this on the public internet publishes that. The URL from a
 * quick tunnel is random and ephemeral, which is some mitigation and not access
 * control.
 *
 * Two things are deliberately constrained to limit the blast radius:
 *
 *   - It binds 127.0.0.1 only. Nothing else on your network can reach it; the
 *     tunnel, running on this same machine, is the only thing that can. This is
 *     not a LAN server.
 *   - It requires --accept-risk, so starting one is a decision rather than a
 *     copy-paste.
 *
 * If both machines are on the same network, prefer an SSH forward instead —
 * `ssh -L 4173:127.0.0.1:4173 <this-host>` makes the far end a real loopback
 * port, so the guard passes honestly and nothing is published at all.
 *
 * Usage:
 *   node tools/remote-proxy.mjs --to 4173 --port 4180 --accept-risk
 *   cloudflared tunnel --url http://127.0.0.1:4180
 */

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name) => argv.includes(`--${name}`);

if (has('help') || has('h')) {
  process.stdout.write(
    'Usage: node tools/remote-proxy.mjs --to <governance port> --port <proxy port> --accept-risk\n' +
      '\n' +
      '  --to PORT      where governance is listening (default 4173)\n' +
      '  --port PORT    where this proxy listens, loopback only (default 4180)\n' +
      '  --accept-risk  required; acknowledges that the tunnel is unauthenticated\n',
  );
  process.exit(0);
}

const target = Number(flag('to') ?? '4173');
const port = Number(flag('port') ?? '4180');

if (!Number.isInteger(target) || target <= 0 || target > 65535) {
  console.error(`--to must be a port number, got: ${String(flag('to'))}`);
  process.exit(1);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`--port must be a port number, got: ${String(flag('port'))}`);
  process.exit(1);
}

if (!has('accept-risk')) {
  console.error(
    'Refusing to start without --accept-risk.\n' +
      '\n' +
      'This proxy removes the Host and Origin checks that are the only thing\n' +
      'standing between the control plane and whoever can reach the tunnel URL.\n' +
      'Anything behind it can read your workspace roots and run a paid agent.\n' +
      'If the other machine is on your network, use an SSH forward instead:\n' +
      '\n' +
      `  ssh -L ${target}:127.0.0.1:${target} <this-host>\n`,
  );
  process.exit(1);
}

/** Hop-by-hop and rewritten-by-us headers. Everything else is forwarded as-is. */
const DROP = new Set(['connection', 'origin', 'referer', 'host']);

const server = createServer((clientReq, clientRes) => {
  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) {
    if (DROP.has(k.toLowerCase()) || v === undefined) continue;
    headers[k] = v;
  }
  // The two rewrites. Everything about the request body, method and path is
  // passed through untouched — this is not a modifying proxy.
  headers['host'] = `127.0.0.1:${target}`;

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: target,
      method: clientReq.method,
      path: clientReq.url ?? '/',
      headers,
    },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
      // Pipe, never buffer: session turns stream, and buffering one would turn
      // a live response into a spinner that ends with the whole thing at once.
      upRes.pipe(clientRes);
    },
  );

  upstream.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    clientRes.end(
      JSON.stringify({
        error: `governance is not reachable on 127.0.0.1:${target}: ${err.message}`,
      }),
    );
  });

  clientReq.on('error', () => upstream.destroy());
  clientReq.pipe(upstream);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    '\n' +
      '  *** REMOTE PROXY — the tunnel behind this is UNAUTHENTICATED ***\n' +
      '  *** anyone with the URL can read your workspace roots and run a paid agent ***\n' +
      '\n' +
      `  proxy      http://127.0.0.1:${port}  (loopback only — not reachable from your LAN)\n` +
      `  forwarding to governance on 127.0.0.1:${target}\n` +
      '\n' +
      '  Now start the tunnel, in another terminal:\n' +
      `    cloudflared tunnel --url http://127.0.0.1:${port}\n` +
      '\n' +
      '  Stop this when the demo ends. Ctrl-C.\n\n',
  );
});
