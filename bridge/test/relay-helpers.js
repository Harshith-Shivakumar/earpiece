// Test doubles for SPEC 12: an in-process fake relay speaking the /v1 protocol (12.2), and a phone
// that connects through it with a Noise IK initiator (12.3). Independent of relay/ on purpose.

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { HandshakeIK, b64url, ed25519Verify, fromB64url, x25519KeyPair } from '../src/noise.js';
import { AUTH_PREFIX } from '../src/relay.js';
import { handleUpgrade } from '../src/ws.js';
import { Phone, waitUntil } from './helpers.js';

export class FakeRelay {
  constructor() {
    this.keys = new Map(); // bridge_id -> pub (TOFU)
    this.bridges = new Map(); // bridge_id -> conn
    this.rooms = new Map(); // bridge_id -> Map(c -> phone conn)
    this.auths = 0;
    this.closes = []; // close codes the relay sent to bridges
    this.lastQueryId = null;
    this.pings = 0;
    this.answerPings = true; // set false to simulate a relay that stopped answering
  }

  room(id) {
    if (!this.rooms.has(id)) this.rooms.set(id, new Map());
    return this.rooms.get(id);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, v: 1 }));
    });
    this.sockets = new Set();
    this.server.on('upgrade', (req, socket, head) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      const u = new URL(req.url, 'http://relay');
      const conn = handleUpgrade(req, socket, head);
      if (!conn) return;
      const m = u.pathname.match(/^\/v1\/phone\/([^/]+)$/);
      if (u.pathname === '/v1/bridge') this._bridge(conn, u);
      else if (m) this._phone(conn, decodeURIComponent(m[1]));
      else conn.close(4004, 'unknown path');
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `ws://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  _send(conn, obj) {
    conn.send(JSON.stringify(obj));
  }

  _bridge(conn, u) {
    const nonce = randomBytes(32);
    let id = null;
    this._send(conn, { t: 'challenge', nonce: b64url(nonce) });
    conn.on('message', (text) => {
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (!id) {
        const reject = (code, reason) => {
          this.closes.push(code);
          conn.close(code, reason);
        };
        if (m.t !== 'auth' || m.v !== 1 || typeof m.bridge_id !== 'string') return reject(4001, 'auth expected');
        let pub;
        let sig;
        try {
          pub = fromB64url(m.pub, 32);
          sig = fromB64url(m.sig, 64);
        } catch {
          return reject(4001, 'bad key');
        }
        if (!ed25519Verify(pub, Buffer.concat([AUTH_PREFIX, nonce]), sig)) return reject(4001, 'bad signature');
        const known = this.keys.get(m.bridge_id);
        if (known && !known.equals(pub)) return reject(4003, 'key mismatch');
        this.keys.set(m.bridge_id, pub);
        id = m.bridge_id;
        this.auths += 1;
        this.lastQueryId = u.searchParams.get('id');
        const old = this.bridges.get(id);
        this.bridges.set(id, conn);
        if (old) old.close(4000, 'replaced');
        this._send(conn, { t: 'ready' });
        for (const [c, p] of this.room(id)) {
          this._send(p, { t: 'bridge_online' });
          this._send(conn, { t: 'open', c });
        }
        return;
      }
      if (m.t === 'data') {
        const p = this.room(id).get(m.c);
        if (p) this._send(p, { t: 'data', d: m.d });
      } else if (m.t === 'close') {
        const p = this.room(id).get(m.c);
        if (p) {
          this.room(id).delete(m.c);
          p.close(1000, 'closed by bridge');
        }
      } else if (m.t === 'ping') {
        this.pings += 1;
        if (this.answerPings) this._send(conn, { t: 'pong' });
      }
    });
    conn.on('close', () => {
      if (!id || this.bridges.get(id) !== conn) return;
      this.bridges.delete(id);
      for (const p of this.room(id).values()) this._send(p, { t: 'bridge_offline' });
    });
  }

  _phone(conn, id) {
    const c = b64url(randomBytes(16));
    this.room(id).set(c, conn);
    const bridge = this.bridges.get(id);
    if (bridge) this._send(bridge, { t: 'open', c });
    else this._send(conn, { t: 'bridge_offline' });
    conn.on('message', (text) => {
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m.t === 'data') {
        const b = this.bridges.get(id);
        if (b) this._send(b, { t: 'data', c, d: m.d });
      }
    });
    conn.on('close', () => {
      if (this.room(id).get(c) !== conn) return;
      this.room(id).delete(c);
      const b = this.bridges.get(id);
      if (b) this._send(b, { t: 'close', c });
    });
  }

  /** Drop the bridge's socket without a close handshake (network loss). */
  kickBridge(id) {
    this.bridges.get(id)?.terminate();
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(() => r()));
  }
}

/**
 * A phone reaching the bridge through the relay with Noise IK. Same message API as Phone
 * (next, nextSay, nextState, says, send, hello, say, control, close, waitClosed).
 */
export class TunnelPhone extends Phone {
  constructor(relayUrl, { bridgeId, bridgeKey, phoneKey = x25519KeyPair(), phoneId = randomUUID(), name = 'Test iPhone', secret = null } = {}) {
    super(`${relayUrl}/v1/phone/${encodeURIComponent(bridgeId)}`);
    Object.assign(this, { bridgeKey, phoneKey, phoneId, name, secret });
    this.relayFrames = [];
    this.transport = null;
    this.handshakeReply = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('websocket error'));
    });
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      this.relayFrames.push(m);
      if (m.t === 'data') this._onData(m.d);
      this._wake();
    };
    this.ws.onclose = (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      this._wake();
    };
    return this;
  }

  _onData(d) {
    if (!this.transport) {
      try {
        this.handshakeReply = JSON.parse(this.hs.readMessage2(fromB64url(d)).toString('utf8'));
        if (this.handshakeReply.ok) this.transport = this.hs.transport;
      } catch (err) {
        this.handshakeReply = { error: err.message };
      }
      return;
    }
    this.messages.push(JSON.parse(this.transport.decrypt(fromB64url(d)).toString('utf8')));
  }

  /** Run the handshake; resolves with the message 2 payload (or { closed } if the bridge hung up). */
  async handshake({ tamper = false, wrongKey = false } = {}) {
    await waitUntil(() => this.relayFrames.length === 0 || this.relayFrames.at(-1).t !== 'bridge_offline', { timeout: 5000, label: 'bridge online' }).catch(() => {});
    this.hs = new HandshakeIK({ initiator: true, s: this.phoneKey, rs: wrongKey ? x25519KeyPair().publicKey : this.bridgeKey });
    const payload = { phone_id: this.phoneId, name: this.name };
    if (this.secret) payload.pair_secret = this.secret;
    const msg1 = this.hs.writeMessage1(Buffer.from(JSON.stringify(payload)));
    if (tamper) msg1[msg1.length - 1] ^= 1;
    this.ws.send(JSON.stringify({ t: 'data', d: b64url(msg1) }));
    await waitUntil(() => this.handshakeReply || this.closed, { timeout: 4000, label: 'handshake reply' });
    return this.handshakeReply ?? { closed: this.closed };
  }

  send(obj) {
    const ct = this.transport.encrypt(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
    this.lastCiphertext = ct;
    this.ws.send(JSON.stringify({ t: 'data', d: b64url(ct) }));
  }

  sendCiphertext(ct) {
    this.ws.send(JSON.stringify({ t: 'data', d: b64url(ct) }));
  }
}
