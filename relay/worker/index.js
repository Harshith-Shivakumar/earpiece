// Earpiece relay on Cloudflare Workers (SPEC 12.7): a Worker plus one Durable Object
// (BridgeRoom) per bridge_id, using the WebSocket Hibernation API and SQLite-backed storage.
//
// Thin adapter: all protocol logic lives in ../core (unit-tested with node --test).
// Imports only ../core and Workers runtime globals (WebSocketPair, Response,
// WebSocketRequestResponsePair), so wrangler bundles it without any npm packages.
//
//   GET /health                    -> {"ok":true,"v":1}
//   WS  /v1/bridge?id=<bridge_id>  -> BridgeRoom(bridge_id): challenge, auth, ready
//   WS  /v1/phone/<bridge_id>      -> BridgeRoom(bridge_id)

import { PING_TEXT, PONG_TEXT, PROTOCOL_VERSION, RateLimiter, Room, isSendableCloseCode, parseRoute } from '../core/index.js';

// Best effort: one limiter per isolate. Cloudflare runs many isolates in many locations,
// so a client spread across them gets more than 20/min. See README.
const limiter = new RateLimiter();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function isWebSocketUpgrade(request) {
  return (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = parseRoute(url);
    if (route.kind === 'health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { ok: false, error: 'method not allowed' });
      return json(200, { ok: true, v: PROTOCOL_VERSION });
    }
    if (route.kind !== 'bridge' && route.kind !== 'phone') return json(route.status || 404, { ok: false, error: route.error || 'not found' });
    if (!isWebSocketUpgrade(request)) return json(426, { ok: false, error: 'expected a WebSocket upgrade' });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!limiter.hit(ip, Date.now())) {
      log('rate_limited', { ip });
      return json(429, { ok: false, error: 'too many connections' });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(route.bridgeId));
    return stub.fetch(request);
  },
};

const TOFU_TABLE = 'CREATE TABLE IF NOT EXISTS tofu (bridge_id TEXT PRIMARY KEY, pub TEXT NOT NULL, first_seen INTEGER NOT NULL)';

export class BridgeRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const sql = ctx.storage.sql;
    sql.exec(TOFU_TABLE);
    // Synchronous SQL, so check-then-insert cannot interleave with another event: first key wins.
    this.store = {
      checkOrStore(bridgeId, pub) {
        const row = sql.exec('SELECT pub FROM tofu WHERE bridge_id = ?', bridgeId).toArray()[0];
        if (row) return row.pub === pub ? 'match' : 'mismatch';
        sql.exec('INSERT INTO tofu (bridge_id, pub, first_seen) VALUES (?, ?, ?)', bridgeId, pub, Date.now());
        return 'new';
      },
    };
    this.io = {
      send: (ws, text) => ws.send(text),
      close: (ws, code, reason) => ws.close(code, reason),
      save: (ws, meta) => ws.serializeAttachment(meta),
      lastActivity: (ws) => {
        const at = ctx.getWebSocketAutoResponseTimestamp?.(ws);
        return at ? at.getTime() : 0;
      },
    };
    // Keepalives are answered by the runtime without waking this object.
    if (typeof WebSocketRequestResponsePair === 'function' && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    }
    this.room = null;
    // After hibernation the constructor runs again: rebuild the room from socket attachments.
    const entries = [];
    for (const ws of ctx.getWebSockets()) {
      if (ws.readyState !== undefined && ws.readyState !== 1) continue; // 1 = OPEN
      let meta = null;
      try {
        meta = ws.deserializeAttachment();
      } catch {
        meta = null;
      }
      if (meta && typeof meta.bridgeId === 'string') entries.push([ws, meta]);
    }
    if (entries.length) this._roomFor(entries[0][1].bridgeId).restore(entries);
  }

  _roomFor(bridgeId) {
    if (!this.room) this.room = new Room({ bridgeId, io: this.io, store: this.store, log });
    return this.room;
  }

  async fetch(request) {
    const route = parseRoute(new URL(request.url));
    if (route.kind !== 'bridge' && route.kind !== 'phone') return json(route.status || 404, { ok: false, error: route.error || 'not found' });
    if (!isWebSocketUpgrade(request)) return json(426, { ok: false, error: 'expected a WebSocket upgrade' });
    const room = this._roomFor(route.bridgeId);
    if (room.bridgeId !== route.bridgeId) return json(500, { ok: false, error: 'room mismatch' });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [route.kind]);
    if (route.kind === 'bridge') room.addBridge(server);
    else room.addPhone(server);
    await this._scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (!this.room) {
      try {
        ws.close(1011, 'room state lost');
      } catch {
        /* already closed */
      }
      return;
    }
    await this.room.onMessage(ws, message);
  }

  async webSocketClose(ws, code) {
    this.room?.onClose(ws);
    // Complete the closing handshake (a no-op or a caught error if the runtime already did).
    try {
      ws.close(isSendableCloseCode(code) ? code : 1000);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws) {
    this.room?.onClose(ws);
  }

  /** Idle and auth timeouts. Runs at the earliest deadline, then reschedules itself. */
  async alarm() {
    if (!this.room) return;
    const next = this.room.sweep(Date.now());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async _scheduleSweep() {
    const next = this.room?.nextDeadline();
    if (next == null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > next) await this.ctx.storage.setAlarm(next);
  }
}
