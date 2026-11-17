// Outbound relay client (SPEC 12.2, 12.5). Authenticates the bridge with Ed25519, then turns every
// relay connection `c` that completes the Noise IK handshake into a virtual phone connection.
// Reconnects with backoff 1/2/4/8/... max 30 s plus jitter.

import { EventEmitter } from 'node:events';
import { unwatchFile, watchFile } from 'node:fs';
import { b64url, ed25519Sign, fromB64url } from './noise.js';
import { TunnelConn, respondToPhone } from './tunnel.js';

export const AUTH_PREFIX = Buffer.from('earpiece-relay-auth/1:', 'utf8');

/** `<relay>/v1/bridge?id=<bridge_id>` from a base relay URL (accepts one that already has /v1/bridge). */
export function bridgeEndpoint(relay, bridgeId) {
  const u = new URL(relay);
  if (!/\/v1\/bridge\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/bridge`;
  if (!u.searchParams.has('id')) u.searchParams.set('id', bridgeId);
  return u.toString();
}

export function authSignature(seed, nonce) {
  return ed25519Sign(seed, Buffer.concat([AUTH_PREFIX, nonce]));
}

export class RelayClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url            relay base URL (wss://... or ws://...)
   * @param {string} o.bridgeId
   * @param {string} o.bridgeName
   * @param {object} o.keys           loadKeys() result: { relay, noise }
   * @param {PhoneStore} o.phones
   * @param {PairSecrets} o.secrets
   * @param {(conn: TunnelConn) => void} o.onConnection
   */
  constructor(o) {
    super();
    this.o = { backoffBaseMs: 1000, backoffMaxMs: 30_000, pingMs: 25_000, pongTimeoutMs: 60_000, connectTimeoutMs: 20_000, handshakeTimeoutMs: 15_000, phonesPollMs: 500, log: () => {}, ...o };
    this.endpoint = bridgeEndpoint(o.url, o.bridgeId);
    this.host = new URL(o.url).host;
    this.status = 'off';
    this.ws = null;
    this.attempt = 0;
    this.stopped = true;
    this.tunnels = new Map(); // c -> { conn | null, timer }
    this.timer = null;
    this.pingTimer = null;
  }

  log(m) {
    this.o.log(m);
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this._connect();
    // SPEC 12.4: unpairing (another process edits phones.json) closes that phone's sessions at once.
    this._watch = () => this.closeUnpaired();
    watchFile(this.o.phones.path, { interval: this.o.phonesPollMs }, this._watch);
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.connectTimer);
    clearInterval(this.pingTimer);
    if (this._watch) unwatchFile(this.o.phones.path, this._watch);
    for (const [c] of this.tunnels) this._dropTunnel(c, 'bridge shutting down', true);
    try {
      this.ws?.close(1000, 'bridge shutting down');
    } catch {
      /* ignore */
    }
    this._setStatus('off');
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  _send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  _connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.endpoint);
    } catch (err) {
      this.log(`relay: cannot connect to ${this.host}: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    // A connect attempt can hang without ever opening or closing (a flaky hotspot, a stalled
    // TLS handshake). Without this watchdog the bridge would stay "connecting" forever.
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.status === 'connected' || this.stopped) return;
      this.log(`relay: connecting to ${this.host} timed out after ${Math.round(this.o.connectTimeoutMs / 1000)} s; retrying`);
      this.ws = null;
      try {
        ws.close(4009, 'connect timeout');
      } catch {
        /* ignore */
      }
      this._scheduleReconnect();
    }, this.o.connectTimeoutMs);
    this.connectTimer.unref?.();
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        this.log('relay: ignored a frame that is not JSON');
        return;
      }
      try {
        this._onFrame(m);
      } catch (err) {
        this.log(`relay: error handling ${m?.t}: ${err.message}`);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.connectTimer);
      for (const [c] of this.tunnels) this._dropTunnel(c, 'relay connection lost', false);
      if (this.stopped) return;
      this.log(`relay: disconnected from ${this.host} (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`);
      this._scheduleReconnect();
    };
    ws.onerror = () => {}; // onclose follows
  }

  /** Give up on a socket that stopped answering: drop it and its sessions, then reconnect. */
  _dead(reason) {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    clearInterval(this.pingTimer);
    this.log(`relay: connection to ${this.host} looks dead (${reason}); reconnecting`);
    for (const [c] of this.tunnels) this._dropTunnel(c, 'relay connection lost', false);
    try {
      ws.close(4008, 'no pong');
    } catch {
      /* ignore */
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    const base = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** this.attempt);
    const delay = Math.round(base + Math.random() * base * 0.25);
    this.attempt += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), delay);
    this.timer.unref?.();
  }

  _onFrame(m) {
    switch (m?.t) {
      case 'challenge': {
        const nonce = fromB64url(m.nonce);
        const { relay } = this.o.keys;
        this._send({ t: 'auth', v: 1, bridge_id: this.o.bridgeId, pub: b64url(relay.publicKey), sig: b64url(authSignature(relay.privateKey, nonce)) });
        return;
      }
      case 'ready': {
        clearTimeout(this.connectTimer);
        this.attempt = 0;
        this._setStatus('connected');
        this.log(`relay: connected to ${this.host}`);
        // App-level keepalive: {t:"ping"} every pingMs; no {t:"pong"} for pongTimeoutMs = dead socket.
        this.lastPong = Date.now();
        let lastPing = 0;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastPong > this.o.pongTimeoutMs) {
            this._dead(`no pong for ${Math.round((Date.now() - this.lastPong) / 1000)} s`);
            return;
          }
          if (Date.now() - lastPing >= this.o.pingMs) {
            lastPing = Date.now();
            this._send({ t: 'ping' });
          }
        }, Math.max(10, Math.min(this.o.pingMs, 5000)));
        this.pingTimer.unref?.();
        return;
      }
      case 'pong':
        this.lastPong = Date.now();
        return;
      case 'open':
        if (typeof m.c === 'string') this._openTunnel(m.c);
        return;
      case 'data':
        if (typeof m.c === 'string' && typeof m.d === 'string') this._onData(m.c, m.d);
        return;
      case 'close':
        if (typeof m.c === 'string') this._dropTunnel(m.c, 'phone left', false);
        return;
      default:
        return; // pong, and anything newer: ignored
    }
  }

  _openTunnel(c) {
    if (this.tunnels.has(c)) return;
    const timer = setTimeout(() => {
      const t = this.tunnels.get(c);
      if (t && !t.conn) {
        this.log('relay: a phone did not finish the handshake in time');
        this._dropTunnel(c, 'handshake timeout', true);
      }
    }, this.o.handshakeTimeoutMs);
    timer.unref?.();
    this.tunnels.set(c, { conn: null, timer });
  }

  _onData(c, d) {
    if (!this.tunnels.has(c)) this._openTunnel(c); // tolerate data before open
    const t = this.tunnels.get(c);
    if (t.conn) {
      t.conn.receive(d);
      return;
    }
    // First frame on a connection: Noise handshake message 1.
    clearTimeout(t.timer);
    let r;
    try {
      r = respondToPhone({
        msg1: fromB64url(d),
        noiseKey: this.o.keys.noise,
        phones: this.o.phones,
        secrets: this.o.secrets,
        bridgeName: this.o.bridgeName,
        bridgeId: this.o.bridgeId,
      });
    } catch (err) {
      this.log(`relay: handshake failed (${err.message}); closing that connection`);
      this._dropTunnel(c, 'handshake failed', true);
      return;
    }
    this._send({ t: 'data', c, d: b64url(r.msg2) });
    if (!r.ok) {
      this.log(`relay: rejected an unpaired phone (${r.name})`);
      this._dropTunnel(c, 'not paired', true);
      return;
    }
    if (r.how === 'paired') this.log(`relay: paired new phone ${r.phone.name} (${r.phone.phone_id})`);
    const conn = new TunnelConn({ c, transport: r.transport, phone: r.phone, sendFrame: (obj) => this._send(obj) });
    conn.on('close', () => {
      const cur = this.tunnels.get(c);
      if (cur?.conn === conn) this.tunnels.delete(c);
    });
    t.conn = conn;
    this.o.onConnection(conn);
  }

  /** local=true: we close it (tell the relay); false: the relay already closed it. */
  _dropTunnel(c, reason, local) {
    const t = this.tunnels.get(c);
    if (!t) return;
    this.tunnels.delete(c);
    clearTimeout(t.timer);
    if (t.conn) {
      if (local) t.conn.close(1000, reason);
      else t.conn.remoteClosed(reason);
    } else if (local) {
      this._send({ t: 'close', c });
    }
  }

  /** Close sessions of phones no longer in phones.json, telling them why first. */
  closeUnpaired() {
    let keys;
    try {
      keys = new Set(this.o.phones.list().map((p) => p.noise_pub));
    } catch {
      return;
    }
    for (const [c, t] of this.tunnels) {
      if (!t.conn || keys.has(t.conn.phone.noise_pub)) continue;
      this.log(`relay: ${t.conn.phone.name} was unpaired; closing its session`);
      t.conn.send(JSON.stringify({ type: 'error', code: 'not_paired', message: 'This phone is no longer paired with this computer.' }));
      this._dropTunnel(c, 'unpaired', true);
    }
  }

  /** Phone connections that finished the handshake. */
  sessions() {
    return [...this.tunnels.values()].filter((t) => t.conn).map((t) => t.conn);
  }
}
