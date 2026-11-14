// Rate limits, in memory (one process; a restart forgets them). Same behaviour as h9web's lib/ratelimit.js
// (RateLimiter with backoff, TokenBucket), so that moving the service into h9web as a module can use h9web's own.
//
// RateLimiter counts hits per key in a fixed window. The hit past "max" is refused and blocks the key for
// blockSeconds; every further block of the same key doubles that, up to maxBlockSeconds. A key that has gone a day
// without a block starts over. TokenBucket is a steady rate with a burst.

export class RateLimiter {
  constructor({ max, windowSeconds, blockSeconds, maxBlockSeconds, maxKeys = 100000, now = Date.now }) {
    this.max = max;
    this.windowMs = windowSeconds * 1000;
    this.blockMs = blockSeconds * 1000;
    this.maxBlockMs = Math.max(maxBlockSeconds, blockSeconds) * 1000;
    this.maxKeys = maxKeys;
    this.now = now;
    this.keys = new Map();
  }

  entry(key, create) {
    let e = this.keys.get(key);
    if (!e && create) {
      if (this.keys.size >= this.maxKeys) this.sweep();
      if (this.keys.size >= this.maxKeys) this.keys.delete(this.keys.keys().next().value);
      e = { start: this.now(), count: 0, blockedUntil: 0, strikes: 0, lastBlock: 0 };
      this.keys.set(key, e);
    }
    return e;
  }

  // Counts one and says whether it may go ahead.
  hit(key) {
    const e = this.entry(key, true);
    const t = this.now();
    if (e.blockedUntil > t) return { ok: false, retryAfter: Math.ceil((e.blockedUntil - t) / 1000) };
    if (t - e.start >= this.windowMs) {
      e.start = t;
      e.count = 0;
    }
    if (e.strikes && t - e.lastBlock > 86400000) e.strikes = 0;
    e.count++;
    if (e.count > this.max) {
      e.strikes++;
      e.lastBlock = t;
      const ms = Math.min(this.blockMs * 2 ** (e.strikes - 1), this.maxBlockMs);
      e.blockedUntil = t + ms;
      e.start = t;
      e.count = 0;
      return { ok: false, retryAfter: Math.ceil(ms / 1000) };
    }
    return { ok: true };
  }

  sweep() {
    const t = this.now();
    for (const [key, e] of this.keys) {
      if (e.blockedUntil <= t && t - e.start >= this.windowMs && (!e.strikes || t - e.lastBlock > 86400000)) this.keys.delete(key);
    }
  }
}

export class TokenBucket {
  constructor(ratePerSecond, burst, now = Date.now) {
    this.rate = ratePerSecond / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.last = now();
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.rate);
    this.last = t;
  }

  take(n = 1) {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

// Takes n from every bucket, or from none when one of them is short.
export function takeAll(pairs) {
  for (const [bucket, n] of pairs) {
    bucket.refill();
    if (bucket.tokens < n) return false;
  }
  for (const [bucket, n] of pairs) bucket.tokens -= n;
  return true;
}
