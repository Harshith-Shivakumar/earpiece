// One room per bridge_id: one bridge socket, up to MAX_PHONES phone sockets (SPEC 12.2).
//
// A state machine with no I/O of its own. Adapters hand it opaque socket handles and an
// `io` object; tests drive it with fakes. The only async step is signature verification
// (and the key store, if the adapter's store is async).
//
// io = {
//   send(sock, text)            send a text frame (must not throw; errors are swallowed here anyway)
//   close(sock, code, reason)   close a socket
//   save?(sock, meta)           persist per-socket state (Worker: serializeAttachment), JSON-safe
//   lastActivity?(sock)         extra activity timestamp in ms (Worker: auto-response ping time)
// }
// store = { checkOrStore(bridgeId, pub) -> 'new' | 'match' | 'mismatch' (or a Promise of it) }
//   Must be atomic: the first pub stored for a bridge_id wins.
//
// Per-socket meta (what `save` receives, and what `restore` takes back after hibernation):
//   bridge: {role:'bridge', state:'auth'|'verifying'|'ready'|'closed', bridgeId, nonce?, since, lastSeen, bytesIn, bytesOut}
//   phone:  {role:'phone',  state:'waiting'|'open'|'closed', bridgeId, c, since, lastSeen, bytesIn, bytesOut}
// A phone's `c` is assigned each time it is opened to a bridge socket, so every `open` the
// bridge sees carries a connection id it has never seen before.

import { encodeBase64url } from './base64url.js';
import { newNonce, randomBytes, verifyAuthSignature } from './auth.js';
import { CLOSE, LIMITS, SIZES } from './limits.js';
import { canonicalBridgeId, checkAuth, checkPayload, isConnId, messageSize, parseFrame } from './messages.js';

export class Room {
  constructor({ bridgeId, io, store, now = Date.now, random = randomBytes, log = () => {}, limits = {} }) {
    const id = canonicalBridgeId(bridgeId);
    if (!id) throw new Error('Room needs a valid bridge_id');
    this.bridgeId = id;
    this.tag = id.slice(0, 8); // what logs show instead of the full id
    this.io = io;
    this.store = store;
    this.now = now;
    this.random = random;
    this.log = log;
    this.limits = { ...LIMITS, ...limits };
    this.sockets = new Map(); // sock -> meta, live sockets only
    this.bridge = null; // the authenticated bridge socket, if any
    this.conns = new Map(); // c -> phone sock
  }

  isEmpty() {
    return this.sockets.size === 0;
  }

  /** Counts for logs and tests. */
  stats() {
    let phones = 0;
    let pending = 0;
    for (const m of this.sockets.values()) {
      if (m.role === 'phone') phones++;
      else if (m.state !== 'ready') pending++;
    }
    return { bridge: this.bridge ? 1 : 0, pending, phones };
  }

  // ---- new sockets ----

  addBridge(sock) {
    const now = this.now();
    const meta = { role: 'bridge', state: 'auth', bridgeId: this.bridgeId, nonce: newNonce(this.random), since: now, lastSeen: now, bytesIn: 0, bytesOut: 0 };
    this.sockets.set(sock, meta);
    this._save(sock, meta);
    this._send(sock, { t: 'challenge', nonce: meta.nonce });
  }

  /** Returns false if the phone was turned away because the room is full. */
  addPhone(sock) {
    const now = this.now();
    const phones = this._phones();
    if (phones.length >= this.limits.MAX_PHONES) {
      // Evict the quietest phone only if it has missed pings (a dead socket left behind by a
      // network change); otherwise turn the newcomer away so live phones cannot be kicked.
      let stalest = null;
      let stalestAt = Infinity;
      for (const [s, m] of phones) {
        const at = this._lastActivity(s, m);
        if (now - at >= this.limits.STALE_MS && at < stalestAt) {
          stalest = s;
          stalestAt = at;
        }
      }
      if (!stalest) {
        this.log('room_full', { room: this.tag, phones: phones.length });
        this._closeRaw(sock, CLOSE.ROOM_FULL, 'room full');
        return false;
      }
      this.log('phone_evicted', { room: this.tag, idle_s: Math.round((now - stalestAt) / 1000) });
      this._closeSocket(stalest, CLOSE.IDLE, 'stale, replaced by a new phone connection');
    }
    const meta = { role: 'phone', state: 'waiting', bridgeId: this.bridgeId, c: null, since: now, lastSeen: now, bytesIn: 0, bytesOut: 0 };
    this.sockets.set(sock, meta);
    if (this.bridge) this._openPhone(sock, meta);
    else {
      this._save(sock, meta);
      this._send(sock, { t: 'bridge_offline' });
    }
    this.log('phone_connect', { room: this.tag, bridge: this.bridge ? 'online' : 'offline', ...this.stats() });
    return true;
  }

  // ---- incoming frames ----

  async onMessage(sock, raw) {
    const meta = this.sockets.get(sock);
    if (!meta) return;
    meta.bytesIn += messageSize(raw);
    meta.lastSeen = this.now();
    this._save(sock, meta);

    const parsed = parseFrame(raw, { maxFrame: this.limits.MAX_FRAME });
    if (!parsed.ok) return this._closeSocket(sock, parsed.code, parsed.reason);
    const msg = parsed.msg;
    if (msg.t === 'ping') return this._send(sock, { t: 'pong' });
    if (meta.role === 'bridge') return this._onBridgeMessage(sock, meta, msg);
    return this._onPhoneMessage(sock, meta, msg);
  }

  async _onBridgeMessage(sock, meta, msg) {
    if (meta.state === 'auth') return this._authenticate(sock, meta, msg);
    if (meta.state !== 'ready') return this._closeSocket(sock, CLOSE.BAD_MESSAGE, 'wait for ready');
    if (msg.t === 'data') {
      if (!isConnId(msg.c)) return this._closeSocket(sock, CLOSE.BAD_MESSAGE, 'invalid c');
      const bad = checkPayload(msg.d, { maxD: this.limits.MAX_D });
      if (bad) return this._closeSocket(sock, bad.code, bad.reason);
      const phone = this.conns.get(msg.c);
      // Unknown c: the phone is already gone; tell the bridge so it can clean up.
      if (!phone) return this._send(sock, { t: 'close', c: msg.c });
      return this._send(phone, { t: 'data', d: msg.d });
    }
    if (msg.t === 'close') {
      if (!isConnId(msg.c)) return this._closeSocket(sock, CLOSE.BAD_MESSAGE, 'invalid c');
      const phone = this.conns.get(msg.c);
      if (!phone) return;
      const pm = this.sockets.get(phone);
      this.conns.delete(msg.c);
      pm.c = null; // so dropping it does not echo a close back to the bridge
      this._send(phone, { t: 'close' });
      return this._closeSocket(phone, CLOSE.NORMAL, 'closed by bridge');
    }
    // Unknown types are ignored, for forward compatibility.
  }

  async _authenticate(sock, meta, msg) {
    const auth = checkAuth(msg);
    if (!auth.ok) return this._authFail(sock, auth.code, auth.reason);
    if (auth.bridgeId !== this.bridgeId) return this._authFail(sock, CLOSE.AUTH_FAILED, 'bridge_id does not match ?id=');
    meta.state = 'verifying';
    this._save(sock, meta);

    const ok = await verifyAuthSignature(meta.nonce, auth.pubBytes, auth.sigBytes);
    if (this.sockets.get(sock) !== meta || meta.state !== 'verifying') return; // closed meanwhile
    if (!ok) return this._authFail(sock, CLOSE.AUTH_FAILED, 'bad signature');

    let tofu;
    try {
      tofu = await this.store.checkOrStore(this.bridgeId, auth.pub);
    } catch (err) {
      this.log('store_error', { room: this.tag, error: String(err?.message || err) });
      return this._closeSocket(sock, CLOSE.INTERNAL, 'storage error');
    }
    if (this.sockets.get(sock) !== meta || meta.state !== 'verifying') return;
    if (tofu === 'mismatch') return this._authFail(sock, CLOSE.KEY_MISMATCH, 'key does not match this bridge_id');
    if (tofu !== 'new' && tofu !== 'match') return this._closeSocket(sock, CLOSE.INTERNAL, 'storage error');
    this._promote(sock, meta, tofu);
  }

  _authFail(sock, code, reason) {
    this.log('auth_failed', { room: this.tag, code, reason });
    return this._closeSocket(sock, code, reason);
  }

  /** The socket passed auth: make it the room's bridge, replacing any older one. */
  _promote(sock, meta, tofu) {
    meta.state = 'ready';
    delete meta.nonce;
    this._save(sock, meta);
    const old = this.bridge;
    this.bridge = sock;
    if (old) this._closeSocket(old, CLOSE.REPLACED, 'replaced by a newer bridge connection');
    const phones = this._phones();
    // Sessions opened to the old bridge socket are gone; every phone is reopened with a new c.
    for (const [, pm] of phones) {
      if (pm.c) this.conns.delete(pm.c);
      pm.c = null;
      pm.state = 'waiting';
    }
    this._send(sock, { t: 'ready' });
    for (const [ps] of phones) this._send(ps, { t: 'bridge_online' });
    for (const [ps, pm] of phones) this._openPhone(ps, pm);
    this.log('bridge_ready', { room: this.tag, tofu, replaced: Boolean(old), phones: phones.length });
  }

  _onPhoneMessage(sock, meta, msg) {
    if (msg.t === 'data') {
      const bad = checkPayload(msg.d, { maxD: this.limits.MAX_D });
      if (bad) return this._closeSocket(sock, bad.code, bad.reason);
      // While the bridge is offline the phone was told so; its data is dropped.
      if (!meta.c || !this.bridge) return;
      return this._send(this.bridge, { t: 'data', c: meta.c, d: msg.d });
    }
    if (msg.t === 'close') return this._closeSocket(sock, CLOSE.NORMAL, 'closed');
    // Unknown types are ignored, for forward compatibility.
  }

  // ---- closing ----

  /** The adapter reports that a socket closed (by the peer or after our close). */
  onClose(sock) {
    this._drop(sock);
  }

  /**
   * Close sockets that timed out. Returns the next time (ms) sweep should run, or null
   * if the room has no sockets.
   */
  sweep(now = this.now()) {
    for (const [sock, meta] of [...this.sockets]) {
      if (meta.role === 'bridge' && meta.state !== 'ready') {
        if (now - meta.since >= this.limits.AUTH_TIMEOUT_MS) this._authFail(sock, CLOSE.AUTH_TIMEOUT, 'auth timeout');
      } else if (now - this._lastActivity(sock, meta) >= this.limits.IDLE_MS) {
        this.log('idle_close', { room: this.tag, role: meta.role });
        this._closeSocket(sock, CLOSE.IDLE, 'idle');
      }
    }
    const next = this.nextDeadline();
    return next === null ? null : Math.max(next, now + 1000);
  }

  /** Earliest time a socket could time out, or null if there are no sockets. */
  nextDeadline() {
    let next = null;
    for (const [sock, meta] of this.sockets) {
      const t =
        meta.role === 'bridge' && meta.state !== 'ready'
          ? meta.since + this.limits.AUTH_TIMEOUT_MS
          : this._lastActivity(sock, meta) + this.limits.IDLE_MS;
      if (next === null || t < next) next = t;
    }
    return next;
  }

  /** Close every socket (relay shutting down). */
  closeAll(code = CLOSE.GOING_AWAY, reason = 'relay shutting down') {
    this.bridge = null; // avoid sending bridge_offline to phones that are about to close
    for (const sock of [...this.sockets.keys()]) this._closeSocket(sock, code, reason);
  }

  // ---- hibernation ----

  /**
   * Rebuild state from saved metas after the Worker woke from hibernation.
   * `entries` is an iterable of [sock, meta]; sockets must still be open.
   */
  restore(entries) {
    const bridges = [];
    for (const [sock, saved] of entries) {
      if (!saved || saved.bridgeId !== this.bridgeId || saved.state === 'closed') continue;
      const meta = { ...saved };
      if (meta.role === 'bridge') {
        // A verification in flight did not survive; the auth timeout will clean it up.
        if (meta.state === 'verifying') meta.state = 'auth';
        if (meta.state === 'ready') bridges.push([sock, meta]);
        else if (meta.state !== 'auth' || typeof meta.nonce !== 'string') continue;
      } else if (meta.role !== 'phone') continue;
      this.sockets.set(sock, meta);
    }
    bridges.sort((a, b) => b[1].since - a[1].since);
    if (bridges.length) this.bridge = bridges[0][0];
    for (const [sock] of bridges.slice(1)) this._closeSocket(sock, CLOSE.REPLACED, 'replaced by a newer bridge connection');
    for (const [sock, meta] of this._phones()) {
      if (meta.c && this.bridge && !this.conns.has(meta.c)) {
        this.conns.set(meta.c, sock);
      } else if (this.bridge) {
        this._openPhone(sock, meta);
      } else if (meta.c) {
        meta.c = null;
        meta.state = 'waiting';
        this._save(sock, meta);
        this._send(sock, { t: 'bridge_offline' });
      }
    }
  }

  // ---- internals ----

  _phones() {
    const out = [];
    for (const entry of this.sockets) if (entry[1].role === 'phone') out.push(entry);
    return out;
  }

  _openPhone(sock, meta) {
    meta.c = encodeBase64url(this.random(SIZES.CONN_ID));
    meta.state = 'open';
    this.conns.set(meta.c, sock);
    this._save(sock, meta);
    this._send(this.bridge, { t: 'open', c: meta.c });
  }

  _lastActivity(sock, meta) {
    let extra = 0;
    try {
      extra = this.io.lastActivity?.(sock) || 0;
    } catch {
      extra = 0;
    }
    return Math.max(meta.lastSeen, extra);
  }

  _send(sock, obj) {
    const meta = this.sockets.get(sock);
    if (!meta) return;
    const text = JSON.stringify(obj);
    meta.bytesOut += text.length; // ASCII: every field is base64url or a fixed word
    try {
      this.io.send(sock, text);
    } catch {
      /* the close event will follow */
    }
  }

  _save(sock, meta) {
    if (!this.io.save) return;
    try {
      this.io.save(sock, meta);
    } catch {
      /* best effort */
    }
  }

  _closeRaw(sock, code, reason) {
    try {
      this.io.close(sock, code, reason);
    } catch {
      /* already closed */
    }
  }

  /** Close a socket we know about and forget it immediately. */
  _closeSocket(sock, code, reason) {
    const meta = this.sockets.get(sock);
    if (meta) {
      this._drop(sock);
      meta.state = 'closed';
      this._save(sock, meta);
    }
    this._closeRaw(sock, code, reason);
  }

  /** Forget a socket and tell the other side. Safe to call twice. */
  _drop(sock) {
    const meta = this.sockets.get(sock);
    if (!meta) return;
    this.sockets.delete(sock);
    const secs = Math.round((this.now() - meta.since) / 1000);
    if (meta.role === 'phone') {
      if (meta.c) {
        this.conns.delete(meta.c);
        if (this.bridge) this._send(this.bridge, { t: 'close', c: meta.c });
      }
      this.log('phone_close', { room: this.tag, secs, bytes_in: meta.bytesIn, bytes_out: meta.bytesOut });
      return;
    }
    if (sock !== this.bridge) {
      if (meta.state === 'ready') this.log('bridge_close', { room: this.tag, secs, replaced: true });
      return; // a pending or replaced bridge socket: phones are unaffected
    }
    this.bridge = null;
    const phones = this._phones();
    for (const [ps, pm] of phones) {
      if (pm.c) this.conns.delete(pm.c);
      pm.c = null;
      pm.state = 'waiting';
      this._save(ps, pm);
      this._send(ps, { t: 'bridge_offline' });
    }
    this.log('bridge_close', { room: this.tag, secs, bytes_in: meta.bytesIn, bytes_out: meta.bytesOut, phones: phones.length });
  }
}
