#!/usr/bin/env node
// Earpiece relay as a plain Node 22 server (SPEC 12.7): zero npm dependencies.
// For local testing and self-hosting. The same core logic runs in relay/worker.
//
//   GET /health                    -> {"ok":true,"v":1}
//   WS  /v1/bridge?id=<bridge_id>  -> bridge socket (challenge, auth, ready)
//   WS  /v1/phone/<bridge_id>      -> phone socket
//
// Env: RELAY_PORT (8790), RELAY_HOST (0.0.0.0), RELAY_STATE (optional JSON file for TOFU keys),
//      RELAY_TRUST_PROXY=1 (take the client IP from the last X-Forwarded-For entry; set only
//      behind exactly one reverse proxy, e.g. Caddy terminating TLS).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSE, LIMITS, PROTOCOL_VERSION, RateLimiter, Room, parseRoute } from '../core/index.js';
import { handleUpgrade } from './ws.js';

/** TOFU key store: bridge_id -> Ed25519 pub. In memory, optionally persisted to a JSON file. */
export class KeyStore {
  constructor(file = null) {
    this.file = file;
    this.keys = new Map();
    if (file && fs.existsSync(file)) {
      // Fail loudly on a corrupt file: silently forgetting keys would undo trust on first use.
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, entry] of Object.entries(data.keys || {})) this.keys.set(id, entry);
    }
  }

  checkOrStore(bridgeId, pub) {
    const existing = this.keys.get(bridgeId);
    if (existing) return existing.pub === pub ? 'match' : 'mismatch';
    this.keys.set(bridgeId, { pub, first_seen: new Date().toISOString() });
    this._persist();
    return 'new';
  }

  _persist() {
    if (!this.file) return;
    const body = JSON.stringify({ version: 1, keys: Object.fromEntries(this.keys) }, null, 2) + '\n';
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function defaultLog(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

const STATUS_TEXT = { 400: 'Bad Request', 404: 'Not Found', 429: 'Too Many Requests' };

/**
 * Create a relay server (not yet listening).
 * Options: port, host, statePath, trustProxy, log, limits (overrides for LIMITS), now, random.
 */
export function createRelay({
  port = 8790,
  host = '0.0.0.0',
  statePath = null,
  trustProxy = false,
  log = defaultLog,
  limits = {},
  now = Date.now,
  random,
} = {}) {
  const lim = { ...LIMITS, ...limits };
  const store = new KeyStore(statePath);
  const limiter = new RateLimiter({ limit: lim.RATE_LIMIT, windowMs: lim.RATE_WINDOW_MS, maxKeys: lim.RATE_MAX_KEYS });
  const rooms = new Map(); // bridge_id -> Room
  const rawSockets = new Set();
  const io = {
    send: (conn, text) => conn.send(text),
    close: (conn, code, reason) => conn.close(code, reason),
  };

  function roomFor(bridgeId) {
    let room = rooms.get(bridgeId);
    if (!room) {
      room = new Room({ bridgeId, io, store, log, limits, now, ...(random ? { random } : {}) });
      rooms.set(bridgeId, room);
    }
    return room;
  }

  function releaseIfEmpty(bridgeId, room) {
    if (room.isEmpty() && rooms.get(bridgeId) === room) rooms.delete(bridgeId);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      url = null;
    }
    if (url && url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION }));
      return;
    }
    const route = url ? parseRoute(url) : { kind: 'error', status: 400, error: 'bad url' };
    const status = route.kind === 'bridge' || route.kind === 'phone' ? 426 : route.status || 404;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: status === 426 ? 'expected a WebSocket upgrade' : route.error }));
  });

  server.on('connection', (socket) => {
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      return rejectUpgrade(socket, 400, STATUS_TEXT[400]);
    }
    const route = parseRoute(url);
    if (route.kind !== 'bridge' && route.kind !== 'phone') {
      const status = route.status || 404;
      return rejectUpgrade(socket, status, STATUS_TEXT[status] || 'Not Found');
    }
    const ip = clientIp(req, trustProxy);
    if (!limiter.hit(ip, now())) {
      log('rate_limited', { ip });
      return rejectUpgrade(socket, 429, STATUS_TEXT[429]);
    }
    const conn = handleUpgrade(req, socket, head, { maxPayload: lim.MAX_FRAME });
    if (!conn) return;
    const room = roomFor(route.bridgeId);
    conn.on('message', (data) => {
      room.onMessage(conn, data).catch((err) => log('error', { error: String(err?.stack || err) }));
    });
    conn.on('close', () => {
      room.onClose(conn);
      releaseIfEmpty(route.bridgeId, room);
    });
    conn.on('socketError', () => {});
    if (route.kind === 'bridge') room.addBridge(conn);
    else room.addPhone(conn);
  });

  let sweeper = null;

  return {
    server,
    rooms,
    store,
    /** Start listening. Resolves to the bound port. */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          sweeper = setInterval(() => {
            const t = now();
            for (const room of rooms.values()) room.sweep(t);
          }, 1000);
          sweeper.unref();
          resolve(server.address().port);
        });
      });
    },
    /** Close all sockets with 1001 and stop the server. */
    close() {
      clearInterval(sweeper);
      for (const room of rooms.values()) room.closeAll(CLOSE.GOING_AWAY, 'relay shutting down');
      return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          for (const s of rawSockets) s.destroy();
        }, 300).unref();
      });
    },
  };
}

async function main() {
  const port = Number(process.env.RELAY_PORT || 8790);
  const host = process.env.RELAY_HOST || '0.0.0.0';
  const statePath = process.env.RELAY_STATE || null;
  const trustProxy = process.env.RELAY_TRUST_PROXY === '1';
  const relay = createRelay({ port, host, statePath, trustProxy });
  const bound = await relay.listen();
  console.log(`Earpiece relay v${PROTOCOL_VERSION} listening on http://${host}:${bound}` + (statePath ? ` (keys: ${statePath})` : ' (keys in memory only)'));
  let stopping = false;
  const stop = () => {
    if (stopping) return process.exit(1);
    stopping = true;
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
