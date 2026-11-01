// Per-server report keys. Each game server that reports presence has its own key, which signs
// its reports (HMAC-SHA256). The keys live in one file in the module's data folder:
//
//   <dataDir>/modules/presence/server-keys.json        mode 0600, never in config.json or git
//   {
//     "note": "...",
//     "servers": {
//       "203.0.113.10:27015": { "key": "<64 lowercase hex>", "created": "2026-11-01T12:00:00Z" }
//     }
//   }
//
// A key is 32 random bytes written as 64 hex characters, and the HMAC takes those 64 characters
// as its key bytes (that is also what the game server's plugin has: the text in its config).
// bin/presence-key.js makes, rotates and removes keys and prints a new key once; the service
// reads the file again whenever it changes, so no restart is needed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KEY_RE = /^[0-9a-f]{64}$/;
export const FILE_NAME = "server-keys.json";

// "a.b.c.d:port" in its one written form (no leading zeros), or null.
export function addressKey(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(String(text || "").trim());
  if (!m) return null;
  const bytes = [m[1], m[2], m[3], m[4]].map(Number);
  const port = Number(m[5]);
  if (bytes.some((b) => b > 255) || port < 1 || port > 65535) return null;
  return bytes.join(".") + ":" + port;
}

export function newKey() {
  return crypto.randomBytes(32).toString("hex");
}

export function keysPath(moduleDataDir) {
  return path.join(moduleDataDir, FILE_NAME);
}

// The file's servers as a Map(address -> { key, created }). A missing file is an empty map; a
// damaged one throws, so a typo never silently drops every key.
export function readKeys(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return new Map();
    throw e;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error("presence: " + file + " is not valid JSON (" + e.message + ")");
  }
  const out = new Map();
  const servers = raw && typeof raw.servers === "object" && raw.servers ? raw.servers : {};
  for (const [address, entry] of Object.entries(servers)) {
    const a = addressKey(address);
    if (!a || !entry || !KEY_RE.test(String(entry.key || ""))) throw new Error("presence: " + file + " has a bad entry for " + JSON.stringify(address));
    out.set(a, { key: entry.key, created: typeof entry.created === "string" ? entry.created : null });
  }
  return out;
}

// Writes the whole map, mode 0600, through a temporary file and a rename, so a reader never
// sees half a file.
export function writeKeys(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = {
    note: "h9web presence: one key per game server, for h9_presence.sma. Never commit, never copy into the site. bin/presence-key.js manages this file.",
    servers: Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([a, e]) => [a, { key: e.key, created: e.created }])),
  };
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(body, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

// The service's view of the file: read on first use and again whenever its size or modification
// time changes (looked at no more than once a second).
export class KeyStore {
  constructor(file, { log = null, now = Date.now } = {}) {
    this.file = file;
    this.log = log;
    this.now = now;
    this.map = new Map();
    this.stamp = null;
    this.checkedAt = -Infinity;
  }

  refresh() {
    const t = this.now();
    if (t - this.checkedAt < 1000) return;
    this.checkedAt = t;
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch (e) {
      st = null;
    }
    const stamp = st ? st.size + ":" + st.mtimeMs : "none";
    if (stamp === this.stamp) return;
    try {
      this.map = readKeys(this.file);
      this.stamp = stamp;
      if (this.log) this.log.info("presence.keys_loaded", { servers: this.map.size });
      if (st && process.platform !== "win32" && st.mode & 0o077 && this.log) {
        this.log.warn("presence.keys_mode", { file: this.file, mode: (st.mode & 0o777).toString(8), fix: "chmod 600" });
      }
    } catch (e) {
      // the last good keys stay in force; the file is looked at again when it changes
      this.stamp = stamp;
      if (this.log) this.log.error("presence.keys_unreadable", { file: this.file, error: e.message, kept: this.map.size });
    }
  }

  get(address) {
    this.refresh();
    const e = this.map.get(address);
    return e ? e.key : null;
  }

  // Forget the timer, so the next get() looks at the file again (the tests, and the key script).
  touch() {
    this.checkedAt = -Infinity;
  }
}
