// Bridge authentication: Ed25519 over `earpiece-relay-auth/1:` + raw nonce bytes (SPEC 12.2).
// WebCrypto only (crypto.subtle), so the same code runs in Node 22 and in Workers.

import { decodeBase64url, encodeBase64url } from './base64url.js';
import { AUTH_PREFIX, SIZES } from './limits.js';

const PREFIX_BYTES = new TextEncoder().encode(AUTH_PREFIX);

/** The exact bytes the bridge signs for a given raw nonce. */
export function authMessage(nonceBytes) {
  const out = new Uint8Array(PREFIX_BYTES.length + nonceBytes.length);
  out.set(PREFIX_BYTES, 0);
  out.set(nonceBytes, PREFIX_BYTES.length);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A fresh challenge nonce, base64url. */
export function newNonce(random = randomBytes) {
  return encodeBase64url(random(SIZES.NONCE));
}

// Workers accepted only the non-standard name before standard Ed25519 landed; try both.
const ALGORITHMS = [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }];

async function importPublicKey(pubBytes) {
  let lastErr;
  for (const alg of ALGORITHMS) {
    try {
      return { key: await crypto.subtle.importKey('raw', pubBytes, alg, false, ['verify']), alg };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Verify an auth signature. `nonce` is the base64url challenge the relay sent;
 * `pubBytes` (32) and `sigBytes` (64) are already decoded. Resolves to a boolean, never throws.
 */
export async function verifyAuthSignature(nonce, pubBytes, sigBytes) {
  const nonceBytes = decodeBase64url(nonce);
  if (!nonceBytes || nonceBytes.length !== SIZES.NONCE) return false;
  if (pubBytes?.length !== SIZES.ED25519_PUB || sigBytes?.length !== SIZES.ED25519_SIG) return false;
  try {
    const { key, alg } = await importPublicKey(pubBytes);
    return await crypto.subtle.verify(alg, key, sigBytes, authMessage(nonceBytes));
  } catch {
    return false;
  }
}

/**
 * Build the bridge's `auth` reply. `privateKey` is a WebCrypto Ed25519 private CryptoKey and
 * `pub` its raw public key as base64url. Used by tests; the bridge may use it as a reference.
 */
export async function signAuth({ privateKey, pub, bridgeId, nonce }) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, authMessage(decodeBase64url(nonce)));
  return { t: 'auth', v: 1, bridge_id: bridgeId, pub, sig: encodeBase64url(new Uint8Array(sig)) };
}
