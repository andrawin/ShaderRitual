/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ShaderRitual LAN relay: serves the built app (dist/) on every network
 * interface and relays sync messages between all connected windows over a
 * WebSocket — so a phone / tablet on the same network can run the detached
 * control panel (`?control`) for the render window on your laptop.
 *
 *   npm run remote     (builds, then serves + relays on port 8787)
 *
 * Then open the printed URL on the render machine, and the same URL with
 * `?control` on the phone/tablet.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function lanUrls() {
  const urls = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === '/') path = '/index.html';
    // Keep requests inside dist/.
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    let body;
    let type = MIME[extname(file)] || 'application/octet-stream';
    try {
      body = await readFile(file);
    } catch (e) {
      // SPA fallback.
      body = await readFile(join(ROOT, 'index.html'));
      type = MIME['.html'];
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end();
  }
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 * 1024 });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'remoteHello', urls: lanUrls() }));
  ws.on('message', (data, isBinary) => {
    // Relay to every other connected window.
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === 1) client.send(data, { binary: isBinary });
    }
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\nShaderRitual LAN relay running.\n');
  console.log('  Render window (THIS machine — use localhost so the mic works):');
  console.log(`    http://localhost:${PORT}`);
  console.log('\n  Controller (phone / tablet on the same network):');
  for (const u of urls) console.log(`    ${u}?control`);
  console.log('');
});
