// Passwords: scrypt with a random 16-byte salt per hash and a server-side pepper.
//
// Stored form:  $scrypt$ln=15,r=8,p=3,k=1$<salt, base64>$<32-byte hash, base64>
//   ln, r, p   scrypt's cost (N = 2^ln); each hash keeps its own, so the cost can be raised later
//              and older hashes are redone at their owner's next sign-in
//   k=1        the password went through HMAC-SHA256 with secrets.json's passwordPepper first, so
//              a copy of the database alone is not enough to try guesses offline
// The password is NFKC-normalised first, so the same text typed on different devices matches.
// Hashes are compared in constant time. At most maxConcurrent hashes run at once (each holds
// 128 * 2^ln * r bytes); the rest wait in a short queue, and past that the caller gets "busy".

import crypto from "node:crypto";

const PREFIX = "$scrypt$";

export class BusyError extends Error {}

function scryptAsync(input, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export class PasswordHasher {
  constructor({ pepper, ln = 15, r = 8, p = 3, maxConcurrent = 2, maxQueue = 64 }) {
    if (!Buffer.isBuffer(pepper) || pepper.length < 32) throw new Error("passwords: a 32-byte pepper is needed");
    this.pepper = pepper;
    this.params = { ln, r, p, k: 1 };
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.running = 0;
    this.queue = [];
    this.dummy = null;
  }

  input(password, k) {
    const bytes = Buffer.from(String(password).normalize("NFKC"), "utf8");
    return k === 1 ? crypto.createHmac("sha256", this.pepper).update(bytes).digest() : bytes;
  }

  async slot(fn) {
    if (this.running >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) throw new BusyError("too many password checks at once");
      await new Promise((resolve) => this.queue.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }

  derive(password, salt, { ln, r, p, k }) {
    const N = 2 ** ln;
    return this.slot(() => scryptAsync(this.input(password, k), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 + 1048576 }));
  }

  async hash(password) {
    const salt = crypto.randomBytes(16);
    const key = await this.derive(password, salt, this.params);
    const { ln, r, p, k } = this.params;
    return PREFIX + "ln=" + ln + ",r=" + r + ",p=" + p + ",k=" + k + "$" + salt.toString("base64") + "$" + key.toString("base64");
  }

  static parse(stored) {
    const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)(?:,k=(\d+))?\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ""));
    if (!m) return null;
    const params = { ln: +m[1], r: +m[2], p: +m[3], k: m[4] === undefined ? 0 : +m[4] };
    // bounds, so a damaged row cannot ask for gigabytes
    if (params.ln < 10 || params.ln > 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16 || params.k > 1) return null;
    const salt = Buffer.from(m[5], "base64");
    const key = Buffer.from(m[6], "base64");
    if (salt.length < 16 || key.length !== 32) return null;
    return { params, salt, key };
  }

  // { ok, needsRehash }
  async verify(password, stored) {
    const parsed = PasswordHasher.parse(stored);
    if (!parsed) {
      await this.dummyVerify(password);
      return { ok: false, needsRehash: false };
    }
    const key = await this.derive(password, parsed.salt, parsed.params);
    const ok = crypto.timingSafeEqual(key, parsed.key);
    const cur = this.params;
    const p = parsed.params;
    return { ok, needsRehash: ok && (p.ln !== cur.ln || p.r !== cur.r || p.p !== cur.p || p.k !== cur.k) };
  }

  // Makes the stand-in hash dummyVerify checks against; called once at start.
  async warm() {
    if (!this.dummy) this.dummy = await this.hash(crypto.randomBytes(16).toString("hex"));
  }

  // The same work as a real check, for a name with no account, so the answer time does not
  // tell whether the account exists.
  async dummyVerify(password) {
    await this.warm();
    const parsed = PasswordHasher.parse(this.dummy);
    await this.derive(password, parsed.salt, parsed.params);
    return false;
  }
}

// Passwords people pick first; each is at least 10 characters, so the length rule alone lets
// it through. Compared lowercased.
const COMMON = new Set([
  "1234567890", "0123456789", "12345678910", "0987654321", "1234554321", "1122334455", "1111111111",
  "123456789a", "a123456789", "123456789q", "qwertyuiop", "qwertyuiop1", "1qaz2wsx3edc", "1q2w3e4r5t",
  "1q2w3e4r5t6y", "qwerty1234", "qwerty12345", "1234qwerty", "asdfghjkl1", "zxcvbnm123", "q1w2e3r4t5",
  "password12", "password123", "password1234", "passw0rd12", "p@ssw0rd123", "iloveyou12", "iloveyou123",
  "abcdefghij", "abcdefg123", "abc1234567", "letmein123", "welcome123", "monkey1234", "dragon1234",
  "football12", "baseball12", "superman12", "trustno1234", "changeme12", "sunshine12", "princess12",
  "starwars12", "computer12", "whatever12", "michael123", "charlie123", "jordan2323", "1234567890a",
  "havoc9havoc9", "havocnine1", "specialists", "thespecialists", "counterstrike", "halflife12",
  "halflife123", "halflife2", "gordonfreeman", "minecraft12", "fortnite123",
]);

// Why a new password is not acceptable, or null. Only length and a few obvious picks: no
// rules about kinds of characters.
export function passwordProblem(password, username, { minLength = 10, maxLength = 256 } = {}) {
  if (typeof password !== "string") return "Type a password.";
  const length = [...password.normalize("NFKC")].length;
  if (length < minLength) return "Use at least " + minLength + " characters.";
  if (length > maxLength) return "Use at most " + maxLength + " characters.";
  const lower = password.toLowerCase();
  if (/^(.)\1+$/s.test(password)) return "That is one character over and over. Pick something harder to guess.";
  if (COMMON.has(lower)) return "That password is on every list of the most common ones. Pick another.";
  const name = String(username || "").toLowerCase();
  if (name && (lower === name || (name.length >= 5 && lower.includes(name)))) return "Keep your username out of your password.";
  return null;
}
