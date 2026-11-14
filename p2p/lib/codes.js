// Invite codes, ids and the small helpers around them.
//
// An invite code is 10 characters of Crockford's base32 (no I, L, O, U), 50 bits from the system's CSPRNG, shown as
// "H9-XXXXX-XXXXX". It is a bearer token: whoever has it can use it once (or the number of times the host allowed) until it
// expires. The service keeps only SHA-256 of the normalised code, so reading the service's memory or a dump of it does not
// give a live code.

import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newCode() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

export function formatCode(code) {
  return "H9-" + code.slice(0, 5) + "-" + code.slice(5, 10);
}

// What a person types or pastes -> the 10 characters, or null. Accepts the shown form, lower case, spaces, a link ending in the code,
// and the usual look-alikes (O is 0, I and L are 1).
export function normaliseCode(text) {
  let s = String(text || "").toUpperCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/[\s-]/g, "");
  if (s.startsWith("H9") && s.length === 12) s = s.slice(2);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(s) ? s : null;
}

export function codeHash(code) {
  return crypto.createHash("sha256").update("h9p2p-code-v1\0" + code).digest("hex");
}

export function randomKey() {
  return crypto.randomBytes(32);
}

export function randomId32(exists) {
  for (let i = 0; i < 100; i++) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n !== 0 && !(exists && exists(n))) return n;
  }
  throw new Error("codes: no free id");
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export const b64 = (buf) => Buffer.from(buf).toString("base64url");
export const unb64 = (s) => Buffer.from(String(s), "base64url");

// A loopback alias from a stable value: 127.<base>.<16 bits>, never .0.0 or .255.255. base 100 is the host side's
// per-joiner addresses, 101 the joiner side's per-session virtual server address.
export function loopbackAlias(base, material) {
  const h = crypto.createHash("sha256").update(String(material)).digest();
  let n = h.readUInt16BE(0);
  if (n === 0 || n === 0xffff) n = 1;
  return "127." + base + "." + (n >> 8) + "." + (n & 255);
}

// SHA-256 of an address for logs: the service never logs an address itself.
export function addressTag(secret, ip) {
  return crypto.createHmac("sha256", secret).update(String(ip)).digest("hex").slice(0, 8);
}
