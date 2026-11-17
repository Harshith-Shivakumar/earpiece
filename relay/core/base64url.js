// base64url without padding (RFC 4648 section 5), strict and canonical.
// Uses atob/btoa, which exist in Node 22 and in Workers.

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** True if `s` is a non-empty string of base64url characters whose length base64url can produce. */
export function isBase64url(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 4 !== 1 && B64URL_RE.test(s);
}

export function encodeBase64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode strictly: rejects padding, other characters, impossible lengths and
 * non-canonical encodings (non-zero trailing bits). Returns a Uint8Array or null.
 */
export function decodeBase64url(s) {
  if (!isBase64url(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (encodeBase64url(out) !== s) return null;
  return out;
}

/** Decode and require an exact byte length. Returns a Uint8Array or null. */
export function decodeBase64urlBytes(s, length) {
  if (typeof s !== 'string' || s.length !== Math.ceil((length * 4) / 3)) return null;
  const out = decodeBase64url(s);
  return out && out.length === length ? out : null;
}
