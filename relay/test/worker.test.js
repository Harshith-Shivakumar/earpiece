// The Worker adapter cannot run here (no workerd, no wrangler). This checks that the module
// parses and imports with no Cloudflare-specific imports, and drives it with small fakes of
// the runtime (WebSocketPair, Durable Object ctx with node:sqlite standing in for ctx.storage.sql).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLOSE } from '../core/index.js';
import { BRIDGE_ID, b64, bridgeKey } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerFile = path.join(here, '..', 'worker', 'index.js');

class FakeWS {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.att = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('closed');
    this.sent.push(text);
  }
  close(code, reason) {
    if (this.readyState !== 1) throw new Error('already closed');
    this.readyState = 3;
    this.closed = { code, reason };
  }
  serializeAttachment(v) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att === null ? null : structuredClone(this.att);
  }
  take() {
    const out = this.sent.map((s) => JSON.parse(s));
    this.sent = [];
    return out;
  }
}

const saved = {};
let mod;
let sqlite;

before(async () => {
  saved.Response = globalThis.Response;
  saved.WebSocketPair = globalThis.WebSocketPair;
  saved.WebSocketRequestResponsePair = globalThis.WebSocketRequestResponsePair;
  const RealResponse = globalThis.Response;
  globalThis.Response = class extends RealResponse {
    constructor(body, init = {}) {
      if (init.status === 101) {
        super(null, { status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        this.webSocket = init.webSocket;
      } else super(body, init);
    }
  };
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new FakeWS();
      this[1] = new FakeWS();
    }
  };
  globalThis.WebSocketRequestResponsePair = class {
    constructor(request, response) {
      this.request = request;
      this.response = response;
    }
  };
  process.removeAllListeners('warning'); // node:sqlite prints an ExperimentalWarning
  sqlite = await import('node:sqlite');
  mod = await import('../worker/index.js');
});

after(() => {
  Object.assign(globalThis, saved);
});

function fakeCtx() {
  const db = new sqlite.DatabaseSync(':memory:');
  const sockets = [];
  const ctx = {
    alarm: null,
    autoResponse: null,
    sockets,
    storage: {
      sql: {
        exec(query, ...args) {
          const stmt = db.prepare(query);
          const rows = /^\s*select/i.test(query) ? stmt.all(...args).map((r) => ({ ...r })) : (stmt.run(...args), []);
          return { toArray: () => rows, one: () => rows[0] };
        },
      },
      getAlarm: async () => ctx.alarm,
      setAlarm: async (t) => {
        ctx.alarm = t;
      },
    },
    acceptWebSocket(ws) {
      sockets.push(ws);
    },
    getWebSockets: () => sockets.filter((ws) => ws.readyState === 1),
    setWebSocketAutoResponse(pair) {
      ctx.autoResponse = pair;
    },
    getWebSocketAutoResponseTimestamp: () => null,
  };
  return ctx;
}

function upgrade(pathname, headers = {}) {
  return new Request(`https://earpiece-relay.example.workers.dev${pathname}`, { headers: { Upgrade: 'websocket', ...headers } });
}

describe('worker module', () => {
  it('parses with node --check and has no cloudflare: imports', () => {
    execFileSync(process.execPath, ['--check', workerFile]);
    const src = fs.readFileSync(workerFile, 'utf8');
    assert.doesNotMatch(src, /from\s+['"]cloudflare:/);
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\.\/core\//);
  });

  it('exports the fetch handler and the BridgeRoom class', () => {
    assert.equal(typeof mod.default.fetch, 'function');
    assert.equal(typeof mod.BridgeRoom, 'function');
  });

  it('routes requests: health, errors, rate limit, and the room picked by bridge_id', async () => {
    const calls = [];
    const env = {
      ROOMS: {
        idFromName: (name) => ({ name }),
        get: (id) => ({ fetch: async (req) => (calls.push({ id: id.name, url: req.url }), new Response('room')) }),
      },
    };
    const health = await mod.default.fetch(new Request('https://x.dev/health'), env);
    assert.deepEqual(await health.json(), { ok: true, v: 1 });
    assert.equal((await mod.default.fetch(new Request('https://x.dev/v1/bridge'), env)).status, 400);
    assert.equal((await mod.default.fetch(new Request('https://x.dev/zzz'), env)).status, 404);
    assert.equal((await mod.default.fetch(new Request(`https://x.dev/v1/phone/${BRIDGE_ID}`), env)).status, 426);
    await mod.default.fetch(upgrade(`/v1/bridge?id=${BRIDGE_ID.toUpperCase()}`, { 'CF-Connecting-IP': '9.9.9.1' }), env);
    await mod.default.fetch(upgrade(`/v1/phone/${BRIDGE_ID}`, { 'CF-Connecting-IP': '9.9.9.1' }), env);
    assert.deepEqual(calls.map((c) => c.id), [BRIDGE_ID, BRIDGE_ID]);
    let last;
    for (let i = 0; i < 20; i++) last = await mod.default.fetch(upgrade(`/v1/phone/${BRIDGE_ID}`, { 'CF-Connecting-IP': '9.9.9.2' }), env);
    assert.equal(last.status, 200);
    last = await mod.default.fetch(upgrade(`/v1/phone/${BRIDGE_ID}`, { 'CF-Connecting-IP': '9.9.9.2' }), env);
    assert.equal(last.status, 429);
  });
});

describe('BridgeRoom durable object (fake runtime)', () => {
  it('runs auth, TOFU, routing, hibernation restore and the idle alarm', async () => {
    const ctx = fakeCtx();
    const key = await bridgeKey();
    let room = new mod.BridgeRoom(ctx, {});
    assert.equal(ctx.autoResponse.request, '{"t":"ping"}');
    assert.equal(ctx.autoResponse.response, '{"t":"pong"}');

    const res = await room.fetch(upgrade(`/v1/bridge?id=${BRIDGE_ID}`));
    assert.equal(res.status, 101);
    const bridge = ctx.sockets[0];
    const [challenge] = bridge.take();
    await room.webSocketMessage(bridge, JSON.stringify(await key.auth(challenge.nonce)));
    assert.deepEqual(bridge.take(), [{ t: 'ready' }]);
    assert.ok(ctx.alarm > Date.now(), 'an alarm is scheduled for timeouts');

    await room.fetch(upgrade(`/v1/phone/${BRIDGE_ID}`));
    const phone = ctx.sockets[1];
    const [open] = bridge.take();
    assert.equal(open.t, 'open');
    await room.webSocketMessage(phone, JSON.stringify({ t: 'data', d: b64('m1') }));
    assert.deepEqual(bridge.take(), [{ t: 'data', c: open.c, d: b64('m1') }]);

    // Hibernation: the object is rebuilt from its sockets' attachments.
    room = new mod.BridgeRoom(ctx, {});
    await room.webSocketMessage(bridge, JSON.stringify({ t: 'data', c: open.c, d: b64('m2') }));
    assert.deepEqual(phone.take(), [{ t: 'data', d: b64('m2') }]);

    // TOFU key lives in SQL: an impostor gets 4003 even after the rebuild.
    await room.fetch(upgrade(`/v1/bridge?id=${BRIDGE_ID}`));
    const impostor = ctx.sockets[2];
    await room.webSocketMessage(impostor, JSON.stringify(await (await bridgeKey()).auth(impostor.take()[0].nonce)));
    assert.equal(impostor.closed.code, CLOSE.KEY_MISMATCH);

    // Peer close: the bridge hears close c; reciprocating twice does not throw.
    phone.readyState = 3;
    await room.webSocketClose(phone, 1005, '', true);
    assert.deepEqual(bridge.take(), [{ t: 'close', c: open.c }]);

    // Alarm 10 min later. Auto-answered pings (which never reach webSocketMessage) keep a
    // socket alive through getWebSocketAutoResponseTimestamp; the silent bridge is closed.
    const realNow = Date.now;
    const later = realNow() + 10 * 60_000;
    await room.fetch(upgrade(`/v1/phone/${BRIDGE_ID}`));
    const pinger = ctx.sockets[3];
    ctx.getWebSocketAutoResponseTimestamp = (ws) => (ws === pinger ? new Date(later - 5_000) : null);
    Date.now = () => later;
    try {
      ctx.alarm = null;
      await room.alarm();
    } finally {
      Date.now = realNow;
    }
    assert.equal(bridge.closed.code, CLOSE.IDLE);
    assert.equal(pinger.closed, null, 'auto-response pings count as traffic');
    assert.equal(ctx.alarm, later - 5_000 + 90_000, 'next alarm is when the pinger would go idle');
  });
});
