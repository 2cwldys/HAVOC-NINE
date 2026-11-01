// Rate limits, kept in memory (one process; a restart forgets them).
//
// RateLimiter counts hits per key in a fixed window. The hit past "max" is refused and blocks
// the key for blockSeconds; every further block of the same key doubles that, up to
// maxBlockSeconds (backoff). A key that has gone a day without a block starts over.
//
// TokenBucket is a steady rate with a burst, for datagrams and bytes per second.

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

  // Whether the key may go ahead now, without counting.
  check(key) {
    const e = this.entry(key, false);
    const t = this.now();
    if (e && e.blockedUntil > t) return { ok: false, retryAfter: Math.ceil((e.blockedUntil - t) / 1000) };
    return { ok: true };
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

  // Forgets the count in the current window (after a good sign-in); a running block stays.
  reset(key) {
    const e = this.keys.get(key);
    if (e) e.count = 0;
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

// The key a client address is limited under: the address itself for IPv4, its /64 for IPv6
// (one IPv6 user usually holds a whole /64).
export function ipKey(ip) {
  const text = String(ip || "");
  if (!text.includes(":")) return text;
  const parts = text.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const full = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail);
  return full.slice(0, 4).map((h) => (h || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
