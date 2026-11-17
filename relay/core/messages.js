// Parsing and validation of relay frames and URLs (SPEC.md 12.2). Pure functions.

import { decodeBase64urlBytes, isBase64url } from './base64url.js';
import { CLOSE, LIMITS, PROTOCOL_VERSION, SIZES } from './limits.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONN_ID_LEN = Math.ceil((SIZES.CONN_ID * 4) / 3); // 22

/** A bridge_id is the bridge's UUID (SPEC 11.1). Case-insensitive. */
export function isBridgeId(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Canonical form used for room names: lowercase. Returns null if invalid. */
export function canonicalBridgeId(s) {
  return isBridgeId(s) ? s.toLowerCase() : null;
}

export function isConnId(c) {
  return typeof c === 'string' && c.length === CONN_ID_LEN && isBase64url(c);
}

/** UTF-8 byte length of a JS string without allocating. */
export function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Byte size of a received message (string, Buffer, ArrayBuffer or typed array). */
export function messageSize(raw) {
  if (typeof raw === 'string') return utf8Length(raw);
  if (raw && typeof raw.byteLength === 'number') return raw.byteLength;
  return 0;
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Parse one received WebSocket message into a JSON object with a string `t`.
 * Returns {ok:true, msg} or {ok:false, code, reason} with the close code to use.
 */
export function parseFrame(raw, { maxFrame = LIMITS.MAX_FRAME } = {}) {
  if (typeof raw !== 'string') return fail(CLOSE.UNSUPPORTED, 'text frames only');
  if (raw.length > maxFrame || utf8Length(raw) > maxFrame) return fail(CLOSE.TOO_BIG, 'frame too large');
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail(CLOSE.BAD_MESSAGE, 'not JSON');
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return fail(CLOSE.BAD_MESSAGE, 'not an object');
  if (typeof msg.t !== 'string') return fail(CLOSE.BAD_MESSAGE, 'missing t');
  return { ok: true, msg };
}

/** Validate a `d` payload. Returns null if fine, else {code, reason}. */
export function checkPayload(d, { maxD = LIMITS.MAX_D } = {}) {
  if (typeof d !== 'string') return { code: CLOSE.BAD_MESSAGE, reason: 'missing d' };
  if (d.length > maxD) return { code: CLOSE.TOO_BIG, reason: 'd too large' };
  if (!isBase64url(d)) return { code: CLOSE.BAD_MESSAGE, reason: 'd is not base64url' };
  return null;
}

/**
 * Validate a bridge `auth` message's shape. Does not check the signature.
 * Returns {ok:true, bridgeId, pub, pubBytes, sigBytes} or {ok:false, code, reason}.
 */
export function checkAuth(msg) {
  if (msg.t !== 'auth') return fail(CLOSE.BAD_MESSAGE, 'expected auth');
  if (msg.v !== PROTOCOL_VERSION) return fail(CLOSE.AUTH_FAILED, 'unsupported version');
  const bridgeId = canonicalBridgeId(msg.bridge_id);
  if (!bridgeId) return fail(CLOSE.AUTH_FAILED, 'invalid bridge_id');
  const pubBytes = decodeBase64urlBytes(msg.pub, SIZES.ED25519_PUB);
  if (!pubBytes) return fail(CLOSE.AUTH_FAILED, 'invalid pub');
  const sigBytes = decodeBase64urlBytes(msg.sig, SIZES.ED25519_SIG);
  if (!sigBytes) return fail(CLOSE.AUTH_FAILED, 'invalid sig');
  return { ok: true, bridgeId, pub: msg.pub, pubBytes, sigBytes };
}

/**
 * Route a request URL. Accepts a URL object.
 * Returns {kind:'health'} | {kind:'bridge'|'phone', bridgeId} | {kind:'error', status, error}.
 *
 * Bridge: /v1/bridge?id=<bridge_id>   (the id picks the room before auth; auth must repeat it)
 * Phone:  /v1/phone/<bridge_id>
 */
export function parseRoute(url) {
  const path = url.pathname;
  if (path === '/health') return { kind: 'health' };
  if (path === '/v1/bridge') {
    const bridgeId = canonicalBridgeId(url.searchParams.get('id'));
    if (!bridgeId) return { kind: 'error', status: 400, error: 'expected /v1/bridge?id=<bridge_id>' };
    return { kind: 'bridge', bridgeId };
  }
  if (path.startsWith('/v1/phone/')) {
    const bridgeId = canonicalBridgeId(decodeSegment(path.slice('/v1/phone/'.length)));
    if (!bridgeId) return { kind: 'error', status: 400, error: 'expected /v1/phone/<bridge_id>' };
    return { kind: 'phone', bridgeId };
  }
  return { kind: 'error', status: 404, error: 'not found' };
}

function decodeSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
