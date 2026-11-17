// Bridge keys, paired phones and the pairing secret (SPEC 12.1, 12.4). All files are mode 0600 in
// EARPIECE_HOME and are written atomically (temp file + rename), so `npm run pair` / `unpair`
// (separate processes) and the running bridge can share them.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64url, ed25519KeyPair, fromB64url, x25519KeyPair } from './noise.js';

export const PAIR_SECRET_TTL_MS = 10 * 60_000;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse ${path}: ${err.message}`);
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * keys.json: { relay_key: {public, private}, noise_key: {public, private} } as base64url raw keys.
 * Generated on first use. Returns raw buffers: { relay: {publicKey, privateKey}, noise: {...}, path }.
 */
export function loadKeys(home) {
  const path = join(home, 'keys.json');
  const stored = readJson(path, null);
  if (stored?.relay_key?.private && stored?.noise_key?.private) {
    const relay = ed25519KeyPair(fromB64url(stored.relay_key.private, 32));
    const noise = x25519KeyPair(fromB64url(stored.noise_key.private, 32));
    return { relay, noise, path, generated: false };
  }
  const relay = ed25519KeyPair();
  const noise = x25519KeyPair();
  writeJsonAtomic(path, {
    relay_key: { type: 'ed25519', public: b64url(relay.publicKey), private: b64url(relay.privateKey) },
    noise_key: { type: 'x25519', public: b64url(noise.publicKey), private: b64url(noise.privateKey) },
  });
  return { relay, noise, path, generated: true };
}

/** phones.json: [{phone_id, name, noise_pub, paired_at, last_seen}]. Authorization lives here. */
export class PhoneStore {
  constructor(home) {
    this.path = join(home, 'phones.json');
  }

  list() {
    const v = readJson(this.path, []);
    return Array.isArray(v) ? v.filter((p) => p && typeof p.noise_pub === 'string') : [];
  }

  findByKey(noisePub) {
    return this.list().find((p) => p.noise_pub === noisePub) ?? null;
  }

  /** Add or update (same phone_id or same key) a phone. */
  add({ phone_id, name, noise_pub }) {
    const now = new Date().toISOString();
    const phones = this.list().filter((p) => p.phone_id !== phone_id && p.noise_pub !== noise_pub);
    const entry = { phone_id, name, noise_pub, paired_at: now, last_seen: now };
    phones.push(entry);
    writeJsonAtomic(this.path, phones);
    return entry;
  }

  touch(noisePub, name) {
    const phones = this.list();
    const p = phones.find((x) => x.noise_pub === noisePub);
    if (!p) return null;
    p.last_seen = new Date().toISOString();
    if (name && name !== p.name) p.name = name;
    writeJsonAtomic(this.path, phones);
    return p;
  }

  /** Remove by exact phone_id, or by name (case-insensitive) if exactly one phone has it. */
  remove(idOrName) {
    const phones = this.list();
    let match = phones.filter((p) => p.phone_id === idOrName);
    if (!match.length) match = phones.filter((p) => String(p.name).toLowerCase() === String(idOrName).toLowerCase());
    if (match.length === 0) return { removed: [], error: `No paired phone matches "${idOrName}".` };
    if (match.length > 1) return { removed: [], error: `Several phones are named "${idOrName}"; use the phone_id.` };
    writeJsonAtomic(this.path, phones.filter((p) => p !== match[0]));
    return { removed: match };
  }
}

/** The pairing secret: 16 random bytes, valid 10 minutes, single use. Shared through pair-secret.json. */
export class PairSecrets {
  constructor(home, { ttlMs = PAIR_SECRET_TTL_MS } = {}) {
    this.path = join(home, 'pair-secret.json');
    this.ttlMs = ttlMs;
  }

  /** Create a new secret (replacing any previous one). Returns { secret (base64url), expiresAt }. */
  create() {
    const secret = b64url(randomBytes(16));
    const expiresAt = Date.now() + this.ttlMs;
    writeJsonAtomic(this.path, { secret, expires_at: new Date(expiresAt).toISOString() });
    return { secret, expiresAt };
  }

  current() {
    let v;
    try {
      v = readJson(this.path, null);
    } catch {
      return null;
    }
    if (!v || typeof v.secret !== 'string') return null;
    const expiresAt = Date.parse(v.expires_at);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
    return { secret: v.secret, expiresAt };
  }

  /** Constant-time check; on success the secret is consumed (deleted). */
  consume(candidate) {
    const cur = this.current();
    if (!cur || typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(cur.secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      unlinkSync(this.path);
    } catch {
      return false; // someone else consumed it first
    }
    return true;
  }
}

export function newPhoneId() {
  return randomUUID();
}
