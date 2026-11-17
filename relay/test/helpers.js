// Shared test helpers: a fake io for the core Room, an in-memory key store, a fake clock,
// and a WebCrypto Ed25519 "bridge" key.

import { encodeBase64url, signAuth } from '../core/index.js';

export const BRIDGE_ID = '3f2b8c1e-9d4a-4f6b-8e2c-7a1d5b9c0e4f';
export const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export async function bridgeKey() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return {
    pub,
    privateKey: pair.privateKey,
    auth: (nonce, bridgeId = BRIDGE_ID) => signAuth({ privateKey: pair.privateKey, pub, bridgeId, nonce }),
  };
}

/** A fake socket handle that records what the room sends it. */
export class FakeSocket {
  constructor(name) {
    this.name = name;
    this.sent = [];
    this.closed = null; // {code, reason}
    this.saved = null;
  }
  get messages() {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** Messages received since the last call. */
  take() {
    const out = this.sent.map((s) => JSON.parse(s));
    this.sent = [];
    return out;
  }
  last() {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

export function fakeIo() {
  return {
    send(sock, text) {
      if (sock.closed) throw new Error('send after close');
      sock.sent.push(text);
    },
    close(sock, code, reason) {
      if (!sock.closed) sock.closed = { code, reason };
    },
    save(sock, meta) {
      sock.saved = JSON.parse(JSON.stringify(meta));
    },
  };
}

export class MemoryStore {
  constructor() {
    this.keys = new Map();
  }
  checkOrStore(id, pub) {
    const have = this.keys.get(id);
    if (have) return have === pub ? 'match' : 'mismatch';
    this.keys.set(id, pub);
    return 'new';
  }
}

export function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
}

/** Send `obj` (or raw text) to the room as if it came from `sock`. */
export function deliver(room, sock, obj) {
  return room.onMessage(sock, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

/** Connect and authenticate a bridge socket. Returns the socket after `ready`. */
export async function connectBridge(room, key, name = 'bridge') {
  const sock = new FakeSocket(name);
  room.addBridge(sock);
  const challenge = sock.take()[0];
  await deliver(room, sock, await key.auth(challenge.nonce));
  return sock;
}

export function b64(text) {
  return encodeBase64url(new TextEncoder().encode(text));
}
