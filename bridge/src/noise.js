// Noise_IK_25519_ChaChaPoly_SHA256 (Noise Protocol Framework, revision 34), zero dependencies.
// The phone is the initiator, the bridge the responder (SPEC 12.3). Also: raw-key helpers for
// X25519 and Ed25519 on top of Node's KeyObjects, and base64url encoding.
//
//   IK:
//     <- s
//     ...
//     -> e, es, s, ss
//     <- e, ee, se

import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes,
  sign as edSign, verify as edVerify,
} from 'node:crypto';

export const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const PROLOGUE = Buffer.from('earpiece/2', 'ascii');
export const DHLEN = 32;
export const TAGLEN = 16;
export const MAX_MESSAGE = 65535; // Noise message size limit
const EMPTY = Buffer.alloc(0);
const MAX_NONCE = 2n ** 64n - 1n; // reserved by the spec

// ---------------------------------------------------------------- encoding

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s, length) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b = Buffer.from(s, 'base64url');
  if (length !== undefined && b.length !== length) throw new Error(`expected ${length} bytes, got ${b.length}`);
  return b;
}

// ---------------------------------------------------------------- X25519 and Ed25519 from raw keys

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

const rawPublic = (privateKeyObject) => Buffer.from(createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' }).subarray(-32));

/** X25519 key pair from a raw 32-byte private key (random if omitted): { privateKey, publicKey } raw buffers. */
export function x25519KeyPair(privateKey = randomBytes(32)) {
  const priv = Buffer.from(privateKey);
  if (priv.length !== 32) throw new Error('X25519 private key must be 32 bytes');
  return { privateKey: priv, publicKey: rawPublic(createPrivateKey({ key: Buffer.concat([X25519_PKCS8, priv]), format: 'der', type: 'pkcs8' })) };
}

/** X25519(private, public) with raw 32-byte keys. Throws on an invalid (e.g. low-order) public key. */
export function dh(privateKey, publicKey) {
  if (publicKey.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([X25519_PKCS8, privateKey]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, publicKey]), format: 'der', type: 'spki' }),
  });
}

/** Ed25519 key pair from a raw 32-byte seed (random if omitted). */
export function ed25519KeyPair(seed = randomBytes(32)) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  return { privateKey: s, publicKey: rawPublic(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, s]), format: 'der', type: 'pkcs8' })) };
}

export function ed25519Sign(seed, message) {
  return edSign(null, message, createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' }));
}

export function ed25519Verify(publicKey, message, signature) {
  try {
    return edVerify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicKey]), format: 'der', type: 'spki' }), signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- hash, HKDF, AEAD

function hash(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function hmac(key, ...parts) {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** HKDF as defined in the Noise spec (section 4.3), with HMAC-SHA256. */
export function hkdf(chainingKey, inputKeyMaterial, numOutputs) {
  const tempKey = hmac(chainingKey, inputKeyMaterial);
  const out1 = hmac(tempKey, Buffer.from([0x01]));
  const out2 = hmac(tempKey, out1, Buffer.from([0x02]));
  if (numOutputs === 2) return [out1, out2];
  return [out1, out2, hmac(tempKey, out2, Buffer.from([0x03]))];
}

/** ChaChaPoly nonce: 32 bits of zeros followed by the 64-bit counter, little-endian. */
function nonce(n) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(BigInt(n), 4);
  return b;
}

export function aeadEncrypt(key, n, ad, plaintext) {
  const c = createCipheriv('chacha20-poly1305', key, nonce(n), { authTagLength: TAGLEN });
  c.setAAD(ad, { plaintextLength: plaintext.length });
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

export function aeadDecrypt(key, n, ad, ciphertext) {
  if (ciphertext.length < TAGLEN) throw new Error('ciphertext too short');
  const d = createDecipheriv('chacha20-poly1305', key, nonce(n), { authTagLength: TAGLEN });
  d.setAAD(ad, { plaintextLength: ciphertext.length - TAGLEN });
  d.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  try {
    return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), d.final()]);
  } catch {
    throw new Error('decryption failed');
  }
}

// ---------------------------------------------------------------- CipherState, SymmetricState

export class CipherState {
  constructor(key = null) {
    this.k = key;
    this.n = 0n;
  }

  hasKey() {
    return this.k !== null;
  }

  encryptWithAd(ad, plaintext) {
    if (!this.k) return Buffer.from(plaintext);
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted');
    const ct = aeadEncrypt(this.k, this.n, ad, plaintext);
    this.n += 1n;
    return ct;
  }

  /** The nonce only advances on success, so a replayed or forged message fails and changes nothing. */
  decryptWithAd(ad, ciphertext) {
    if (!this.k) return Buffer.from(ciphertext);
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted');
    const pt = aeadDecrypt(this.k, this.n, ad, ciphertext);
    this.n += 1n;
    return pt;
  }
}

class SymmetricState {
  constructor(protocolName) {
    const name = Buffer.from(protocolName, 'ascii');
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : hash(name);
    this.ck = Buffer.from(this.h);
    this.cs = new CipherState();
  }

  mixKey(ikm) {
    const [ck, tempK] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs = new CipherState(tempK);
  }

  mixHash(data) {
    this.h = hash(this.h, data);
  }

  encryptAndHash(plaintext) {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split() {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

// ---------------------------------------------------------------- IK handshake

/**
 * One IK handshake. Initiator: new HandshakeIK({ initiator: true, s, rs }), writeMessage1, readMessage2.
 * Responder: new HandshakeIK({ initiator: false, s }), readMessage1, writeMessage2.
 * s/e are { privateKey, publicKey } raw 32-byte keys; e is random unless given (for test vectors).
 * After the second message: .transport (a Transport), .handshakeHash, .remoteStatic.
 */
export class HandshakeIK {
  constructor({ initiator, s, rs = null, e = null, prologue = PROLOGUE, protocolName = PROTOCOL_NAME }) {
    if (!s) throw new Error('a static key pair is required');
    if (initiator && !rs) throw new Error('the initiator must know the responder static key');
    this.initiator = initiator;
    this.s = s;
    this.e = e;
    this.rs = rs ? Buffer.from(rs) : null;
    this.re = null;
    this.step = 0;
    this.ss = new SymmetricState(protocolName);
    this.ss.mixHash(prologue);
    this.ss.mixHash(initiator ? this.rs : s.publicKey); // pre-message: <- s
  }

  _expect(initiator, step) {
    if (this.initiator !== initiator || this.step !== step) throw new Error('handshake message out of order');
  }

  /** -> e, es, s, ss, payload */
  writeMessage1(payload = EMPTY) {
    this._expect(true, 0);
    this.e ??= x25519KeyPair();
    this.ss.mixHash(this.e.publicKey);
    this.ss.mixKey(dh(this.e.privateKey, this.rs)); // es
    const encS = this.ss.encryptAndHash(this.s.publicKey); // s
    this.ss.mixKey(dh(this.s.privateKey, this.rs)); // ss
    const encPayload = this.ss.encryptAndHash(payload);
    this.step = 1;
    return this._check(Buffer.concat([this.e.publicKey, encS, encPayload]));
  }

  readMessage1(message) {
    this._expect(false, 0);
    if (message.length > MAX_MESSAGE) throw new Error('handshake message too long');
    if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN) throw new Error('handshake message 1 too short');
    this.re = Buffer.from(message.subarray(0, DHLEN));
    this.ss.mixHash(this.re);
    this.ss.mixKey(dh(this.s.privateKey, this.re)); // es
    this.rs = this.ss.decryptAndHash(message.subarray(DHLEN, DHLEN * 2 + TAGLEN)); // s
    this.ss.mixKey(dh(this.s.privateKey, this.rs)); // ss
    const payload = this.ss.decryptAndHash(message.subarray(DHLEN * 2 + TAGLEN));
    this.step = 1;
    return payload;
  }

  /** <- e, ee, se, payload */
  writeMessage2(payload = EMPTY) {
    this._expect(false, 1);
    this.e ??= x25519KeyPair();
    this.ss.mixHash(this.e.publicKey);
    this.ss.mixKey(dh(this.e.privateKey, this.re)); // ee
    this.ss.mixKey(dh(this.e.privateKey, this.rs)); // se
    const encPayload = this.ss.encryptAndHash(payload);
    this._finish();
    return this._check(Buffer.concat([this.e.publicKey, encPayload]));
  }

  readMessage2(message) {
    this._expect(true, 1);
    if (message.length > MAX_MESSAGE) throw new Error('handshake message too long');
    if (message.length < DHLEN + TAGLEN) throw new Error('handshake message 2 too short');
    this.re = Buffer.from(message.subarray(0, DHLEN));
    this.ss.mixHash(this.re);
    this.ss.mixKey(dh(this.e.privateKey, this.re)); // ee
    this.ss.mixKey(dh(this.s.privateKey, this.re)); // se
    const payload = this.ss.decryptAndHash(message.subarray(DHLEN));
    this._finish();
    return payload;
  }

  _check(message) {
    if (message.length > MAX_MESSAGE) throw new Error('handshake message too long');
    return message;
  }

  _finish() {
    const [c1, c2] = this.ss.split();
    this.handshakeHash = Buffer.from(this.ss.h);
    this.remoteStatic = this.rs;
    // c1 encrypts initiator -> responder, c2 responder -> initiator.
    this.transport = this.initiator ? new Transport(c1, c2) : new Transport(c2, c1);
    this.step = 2;
  }
}

export class Transport {
  constructor(send, recv) {
    this.send = send;
    this.recv = recv;
  }

  encrypt(plaintext) {
    if (plaintext.length + TAGLEN > MAX_MESSAGE) throw new Error('transport message too long');
    return this.send.encryptWithAd(EMPTY, plaintext);
  }

  decrypt(ciphertext) {
    if (ciphertext.length > MAX_MESSAGE) throw new Error('transport message too long');
    return this.recv.decryptWithAd(EMPTY, ciphertext);
  }
}
