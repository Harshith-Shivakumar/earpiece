// Protocol constants and limits for the Earpiece relay (SPEC.md 12.2).
// Shared by the core room logic, the Node adapter and the Worker adapter.

export const PROTOCOL_VERSION = 1;

/** Prefix of the bytes the bridge signs: UTF-8 of this string, then the raw 32 nonce bytes. */
export const AUTH_PREFIX = 'earpiece-relay-auth/1:';

export const LIMITS = Object.freeze({
  /** Largest accepted WebSocket message, in bytes (1 MiB). */
  MAX_FRAME: 1024 * 1024,
  /**
   * Largest `d` (base64url characters). Leaves headroom so the frame the relay
   * forwards (which adds `c`) still fits in MAX_FRAME.
   */
  MAX_D: 1_048_000,
  /** Phone sockets per bridge_id. */
  MAX_PHONES: 4,
  /** Close a socket after this long without a message from its peer. */
  IDLE_MS: 90_000,
  /** When the room is full, a phone silent for this long may be evicted by a new phone. */
  STALE_MS: 35_000,
  /** A bridge must send a valid `auth` within this long after the challenge. */
  AUTH_TIMEOUT_MS: 10_000,
  /** New WebSocket connections per IP per window. */
  RATE_LIMIT: 20,
  RATE_WINDOW_MS: 60_000,
  /** IPs tracked by one rate limiter before old entries are pruned. */
  RATE_MAX_KEYS: 10_000,
});

/** Byte sizes of the binary fields. */
export const SIZES = Object.freeze({
  NONCE: 32,
  CONN_ID: 16,
  ED25519_PUB: 32,
  ED25519_SIG: 64,
});

/** WebSocket close codes the relay uses. */
export const CLOSE = Object.freeze({
  NORMAL: 1000, // phone or bridge asked to close, or the bridge closed this phone's session
  GOING_AWAY: 1001, // relay shutting down
  UNSUPPORTED: 1003, // binary frame
  INTERNAL: 1011, // relay storage error
  TOO_BIG: 1009, // frame over MAX_FRAME or `d` over MAX_D
  BAD_MESSAGE: 4000, // not JSON, missing or invalid fields, wrong message for the state
  AUTH_FAILED: 4001, // bad signature, bad fields, unsupported v, bridge_id differs from ?id=
  REPLACED: 4002, // a newer authenticated bridge socket took over
  KEY_MISMATCH: 4003, // TOFU: pub differs from the key first seen for this bridge_id
  ROOM_FULL: 4004, // already MAX_PHONES active phone sockets
  IDLE: 4005, // no message for IDLE_MS, or evicted as stale when the room was full
  AUTH_TIMEOUT: 4006, // no valid auth within AUTH_TIMEOUT_MS
});

/** Exact text of a keepalive. The Worker answers it without waking the Durable Object. */
export const PING_TEXT = '{"t":"ping"}';
export const PONG_TEXT = '{"t":"pong"}';
