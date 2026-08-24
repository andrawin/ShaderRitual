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
    // Plain-text reachability probe — open this on the phone to prove the
    // network path works before blaming the app.
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`ShaderRitual relay OK\nclients: ${wss.clients.size}\n`);
      return;
    }
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

wss.on('connection', (ws, req) => {
  const who = req.socket.remoteAddress || 'unknown';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log(`  + client connected (${who}) — ${wss.clients.size} total`);

  ws.send(JSON.stringify({ type: 'remoteHello', urls: lanUrls() }));
  ws.on('message', (data, isBinary) => {
    // Relay to every other connected window.
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === 1) client.send(data, { binary: isBinary });
    }
  });
  ws.on('close', () => {
    console.log(`  - client left (${who}) — ${wss.clients.size} total`);
  });
  ws.on('error', () => {});
});

// Phones suspend backgrounded tabs and home routers drop idle NAT entries, so
// an untouched socket can die silently. Ping every 25s and drop the ones that
// stop answering, which frees the client to reconnect instead of sitting on a
// half-open socket.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\nShaderRitual LAN relay running.\n');
  console.log('  Render window (THIS machine — use localhost so the mic works):');
  console.log(`    http://localhost:${PORT}`);
  console.log('\n  Controller (phone / tablet on the same network):');
  if (urls.length === 0) {
    console.log('    (no LAN address found — is Wi-Fi connected?)');
  }
  for (const u of urls) console.log(`    ${u}?control`);
  if (urls.length > 1) {
    console.log('\n  More than one address is listed because this machine has');
    console.log('  several network interfaces. Try each — only the Wi-Fi one works.');
  }
  console.log('\n  If the phone will not connect, open this on it first:');
  for (const u of urls) console.log(`    ${u}/health`);
  console.log('  Blank/timeout there means the network is blocking us, not the app:');
  console.log('    - macOS may be firewalling node. System Settings > Network >');
  console.log('      Firewall > Options: allow incoming connections for node.');
  console.log('    - macOS 14+ also gates local networking: System Settings >');
  console.log('      Privacy & Security > Local Network: enable Terminal.');
  console.log('    - Some routers isolate wireless clients (AP/guest isolation).');
  console.log('  Connections are logged below as they arrive.\n');
});
