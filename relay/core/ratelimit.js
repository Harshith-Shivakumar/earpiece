// Per-key (per-IP) sliding-window rate limiter: at most `limit` hits in any `windowMs`.
// Memory is bounded: at most `limit` timestamps per key and `maxKeys` keys.

import { LIMITS } from './limits.js';

export class RateLimiter {
  constructor({ limit = LIMITS.RATE_LIMIT, windowMs = LIMITS.RATE_WINDOW_MS, maxKeys = LIMITS.RATE_MAX_KEYS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map(); // key -> ascending timestamps within the window
  }

  /** Record a new connection attempt. Returns true if allowed, false if over the limit. */
  hit(key, now = Date.now()) {
    const k = String(key || 'unknown');
    const cutoff = now - this.windowMs;
    let list = this.hits.get(k);
    if (list) {
      while (list.length && list[0] <= cutoff) list.shift();
    } else {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      list = [];
      this.hits.set(k, list);
    }
    if (list.length >= this.limit) return false;
    list.push(now);
    return true;
  }

  /** Drop keys with no hits in the window; if still too many, drop the oldest keys. */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [k, list] of this.hits) {
      if (!list.length || list[list.length - 1] <= cutoff) this.hits.delete(k);
    }
    // Map iteration order is insertion order, so this drops the longest-tracked keys first.
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}
