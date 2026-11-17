// Runtime-agnostic relay core: zero dependencies, used by relay/node and relay/worker.

export { AUTH_PREFIX, CLOSE, LIMITS, PING_TEXT, PONG_TEXT, PROTOCOL_VERSION, SIZES } from './limits.js';
export { decodeBase64url, decodeBase64urlBytes, encodeBase64url, isBase64url } from './base64url.js';
export {
  canonicalBridgeId,
  checkAuth,
  checkPayload,
  isBridgeId,
  isConnId,
  messageSize,
  parseFrame,
  parseRoute,
  utf8Length,
} from './messages.js';
export { authMessage, newNonce, randomBytes, signAuth, verifyAuthSignature } from './auth.js';
export { RateLimiter } from './ratelimit.js';
export { Room } from './room.js';

/** Close codes a peer may send or receive that are valid on the wire (RFC 6455 7.4). */
export function isSendableCloseCode(code) {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999))
  );
}
