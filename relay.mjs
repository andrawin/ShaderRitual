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
 *
 * It is also the way in for live-coding events. SuperCollider (or anything
 * that speaks OSC) sends to UDP port 57121; Strudel connects to the
 * WebSocket and sends JSON. Either way every window gets a `liveEvent`
 * message with the event's parameters and how many ms until it sounds.
 */
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const OSC_PORT = Number(process.env.OSC_PORT || 57121);
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

/* ------------------------------ OSC in ------------------------------ */

// Seconds between the NTP epoch (1900) and the Unix epoch (1970).
const NTP_UNIX = 2208988800;

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', off, end);
  return [str, (end + 4) & ~3];
}

/** One OSC message: its address and arguments. */
function readMessage(buf) {
  let [address, off] = readString(buf, 0);
  if (off >= buf.length) return { address, args: [] };
  let tags;
  [tags, off] = readString(buf, off);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(off)); off += 8; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(off))); off += 8; }
    else if (t === 's' || t === 'S') { let v; [v, off] = readString(buf, off); args.push(v); }
    else if (t === 'T') args.push(1);
    else if (t === 'F') args.push(0);
    else if (t === 'N' || t === 'I') args.push(null);
    else if (t === 'c') { args.push(String.fromCharCode(buf.readInt32BE(off))); off += 4; }
    else if (t === 'm' || t === 'r') { args.push(buf.readUInt32BE(off)); off += 4; }
    else if (t === 'b') { const n = buf.readInt32BE(off); off += 4 + ((n + 3) & ~3); args.push(null); }
    else break; // a type we do not know: stop rather than misread the rest
  }
  return { address, args };
}

/** Every message in a packet, with the time it is due (Unix ms, or 0 for now). */
function readPacket(buf, at = 0, out = []) {
  if (buf.length >= 16 && buf.toString('utf8', 0, 8) === '#bundle\0') {
    const secs = buf.readUInt32BE(8);
    const frac = buf.readUInt32BE(12);
    // Timetag 1 means "immediately".
    const when = secs === 0 && frac === 1 ? at : (secs - NTP_UNIX) * 1000 + (frac / 4294967296) * 1000;
    let off = 16;
    while (off + 4 <= buf.length) {
      const n = buf.readInt32BE(off);
      off += 4;
      if (n <= 0 || off + n > buf.length) break;
      readPacket(buf.subarray(off, off + n), when, out);
      off += n;
    }
  } else if (buf.length && buf[0] === 0x2f) {
    out.push({ ...readMessage(buf), at });
  }
  return out;
}

/**
 * OSC arguments as parameters. Alternating names and values (what SuperDirt's
 * /dirt/play and most SuperCollider senders use) become named ones; anything
 * else keeps its order under `args`.
 */
function toParams(args) {
  const named = args.length >= 2 && args.length % 2 === 0 &&
    args.every((a, i) => i % 2 === 1 || (typeof a === 'string' && a !== ''));
  if (!named) return { args };
  const p = {};
  for (let i = 0; i < args.length; i += 2) p[args[i]] = args[i + 1];
  return p;
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

const osc = createSocket('udp4');
let oscCount = 0;
osc.on('message', (buf, rinfo) => {
  let msgs;
  try { msgs = readPacket(buf); } catch (e) { return; }
  const now = Date.now();
  for (const m of msgs) {
    broadcast({
      type: 'liveEvent',
      // SuperDirt's own messages (Strudel or Tidal through SuperCollider)
      // are dirt; everything else that arrives over OSC is sc.
      src: m.address.startsWith('/dirt/') ? 'dirt' : 'sc',
      address: m.address,
      params: toParams(m.args),
      delay: m.at ? Math.max(0, m.at - now) : 0,
    });
    if (++oscCount === 1) console.log(`  OSC: first message (${m.address}) from ${rinfo.address}`);
  }
});
osc.on('error', (e) => {
  console.log(`  OSC: could not listen on UDP ${OSC_PORT} (${e.code}) — live events from SuperCollider are off.`);
});
osc.bind(OSC_PORT, '0.0.0.0');

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
  console.log('\n  Live events: SuperCollider / OSC to UDP port ' + OSC_PORT + ', Strudel over');
  console.log(`  ws://localhost:${PORT} (snippets in the panel, Audio Signals > Live events).`);
  console.log('  Connections are logged below as they arrive.\n');
});
