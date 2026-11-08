// Settings and secrets.
//
// Settings come from a JSON file (config.example.json lists every key) laid over DEFAULTS below.
// Relative paths in it are taken from the file's own folder. Nothing in the settings is secret.
//
// Secrets live in <dataDir>/secrets.json, made on the first start with mode 0600 and never
// written again: the player id key and the password pepper. Losing the file loses every
// password and every player id, so it is backed up once, offline (README.txt, "Backups").
// The service refuses to start on a damaged secrets file instead of making new secrets.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
  listen: { host: "127.0.0.1", port: 8090 },
  // the site's own origins: state-changing requests and the relay's WebSocket must come from one
  allowedOrigins: ["https://havoc9.org"],
  // where the client address comes from, for a request that reaches h9web from this machine: true = nginx's X-Real-IP,
  // "cf-connecting-ip" = a Cloudflare Tunnel's cloudflared, false = the connection's own address (lib/http.js clientIp)
  trustProxy: true,
  dataDir: "./data",
  // the data key (lib/datakey.js): encryption at rest; null = <dataDir>/data.key
  dataKeyFile: null,
  serversFile: "./servers.json",
  modulesDir: "./modules",
  gamedir: "ts",
  // only for a test without HTTPS on another machine: drops Secure and the __Host- cookie prefix
  insecureCookies: false,
  // maxPerAccount: the newest this many sessions of one account stay; a sign-in beyond that ends the oldest
  session: { days: 30, idleDays: 14, maxPerAccount: 10 },
  password: { minLength: 10, maxLength: 256 },
  // scrypt cost: N = 2^ln, 32 MiB per hash at ln 15 / r 8; p 3 (OWASP's equal-strength row)
  scrypt: { ln: 15, r: 8, p: 3, maxConcurrent: 2, maxQueue: 64 },
  limits: {
    loginPerIp: { max: 20, windowSeconds: 600, blockSeconds: 60, maxBlockSeconds: 3600 },
    loginPerUser: { max: 8, windowSeconds: 900, blockSeconds: 300, maxBlockSeconds: 3600 },
    signupPerIp: { max: 5, windowSeconds: 3600, blockSeconds: 3600, maxBlockSeconds: 86400 },
    passwordPerAccount: { max: 10, windowSeconds: 900, blockSeconds: 300, maxBlockSeconds: 3600 },
    upgradePerIp: { max: 60, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 600 },
    // the admin panel's password confirmations, wrong ones only, per acting account
    reauthPerAccount: { max: 5, windowSeconds: 900, blockSeconds: 900, maxBlockSeconds: 3600 },
    // username change requests a player sends, per account
    renamePerAccount: { max: 10, windowSeconds: 86400, blockSeconds: 86400, maxBlockSeconds: 86400 },
    // the admin panel's account list (it searches as the name is typed), per acting account
    adminListPerAccount: { max: 120, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 },
    // linking a game (lib/link.js): codes a game asks for, per address; the game's polls and its
    // status checks and h9_unlink, per address; codes looked at, approved or denied on the site, per
    // account and per address (so a code cannot be guessed); REVOKE, per account
    linkStartPerIp: { max: 10, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 3600 },
    linkPollPerIp: { max: 400, windowSeconds: 600, blockSeconds: 60, maxBlockSeconds: 600 },
    linkStatusPerIp: { max: 60, windowSeconds: 600, blockSeconds: 300, maxBlockSeconds: 3600 },
    linkCodePerAccount: { max: 10, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 3600 },
    linkCodePerIp: { max: 20, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 3600 },
    linkRevokePerAccount: { max: 30, windowSeconds: 600, blockSeconds: 300, maxBlockSeconds: 3600 },
    // adopting the id a game holds: nonces and tries per address; proofs that did not check out,
    // per account
    linkAdoptPerIp: { max: 20, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 3600 },
    linkAdoptPerAccount: { max: 5, windowSeconds: 600, blockSeconds: 1800, maxBlockSeconds: 3600 },
    // the scoreboard's double-click opening a player's profile, per address
    linkProfilePerIp: { max: 60, windowSeconds: 600, blockSeconds: 300, maxBlockSeconds: 3600 },
  },
  // linking a game (lib/link.js): how long a code waits for its approval, how often the game asks,
  // how many codes may wait at once, in all and per address, and how long an adopt nonce lasts
  link: { codeSeconds: 600, intervalSeconds: 5, maxPending: 10000, maxPendingPerIp: 5, adoptNonceSeconds: 300 },
  // the admin panel and username changes (lib/admin.js, lib/renames.js, lib/audit.js)
  admin: {
    modSuspendMaxDays: 7,      // the longest suspension a moderator may give (users only)
    auditRetentionDays: 90,    // audit log rows older than this are deleted
    renameCooldownDays: 30,    // after a username change, the next request waits this long
    renameHoldDays: 30,        // an old username stays unusable by anyone else this long
  },
  relay: {
    enabled: true,
    path: "/webclient/relay",
    // the reserved address the page sets as the engine's master (TEST-NET-1, never a real host)
    master: "192.0.2.1:27010",
    bindAddress: "0.0.0.0",
    maxDatagram: 4096,
    idleSeconds: 180,
    pingSeconds: 30,
    sessionCheckSeconds: 60,
    maxSocketsPerAccount: 4,
    maxSocketsPerIp: 12,
    maxSocketsTotal: 512,
    perAccount: { packetsPerSecond: 300, packetBurst: 600, bytesPerSecond: 262144, byteBurst: 524288 },
    perIp: { packetsPerSecond: 800, packetBurst: 1600, bytesPerSecond: 1048576, byteBurst: 2097152 },
    abuseCloseSeconds: 10,
    maxPendingBytes: 1048576,
    masterQueriesPerSecond: 2,
  },
  status: { pollSeconds: 30, timeoutMs: 1500, expireSeconds: 120 },
  modules: [],
  moduleSettings: {},
  // local testing only: { "/": "../havoc9.org", ... } serves those folders as the site; a folder
  // given as { "dir": "...", "listing": true } is served as a plain file index (lib/static.js)
  devStatic: null,
  logLevel: "info",
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function positive(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("config: " + name + " must be a number above 0");
}

// An origin is https, or http only for a loopback address (a test site on this machine) or with insecureCookies on.
function checkOrigin(text, insecure = false) {
  const u = new URL(text);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("config: origin " + text + " is not http(s)");
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol === "http:" && !loopback && !insecure) throw new Error("config: origin " + text + " is http; use https (http is for a loopback test site)");
  return u.origin.toLowerCase();
}

// Validates and completes a settings object. base is the folder relative paths start from.
export function resolveConfig(raw = {}, base = HOME) {
  const c = merge(DEFAULTS, raw);
  c.allowedOrigins = (Array.isArray(c.allowedOrigins) ? c.allowedOrigins : []).map((o) => checkOrigin(o, c.insecureCookies === true));
  if (!c.allowedOrigins.length) throw new Error("config: allowedOrigins is empty");
  for (const key of ["dataDir", "serversFile", "modulesDir"]) c[key] = path.resolve(base, String(c[key]));
  c.dataKeyFile = c.dataKeyFile ? path.resolve(base, String(c.dataKeyFile)) : path.join(c.dataDir, "data.key");
  if (c.devStatic) {
    const mounts = {};
    for (const [prefix, spec] of Object.entries(c.devStatic)) {
      if (!prefix.startsWith("/") || !prefix.endsWith("/")) throw new Error("config: devStatic prefix " + prefix + " must start and end with /");
      const listing = isPlainObject(spec);
      if (listing && (spec.listing !== true || typeof spec.dir !== "string")) {
        throw new Error("config: devStatic " + prefix + " must be a folder, or { \"dir\": folder, \"listing\": true }");
      }
      const dir = path.resolve(base, String(listing ? spec.dir : spec));
      mounts[prefix] = listing ? { dir, listing: true } : dir;
      for (const [name, place] of [["dataDir", c.dataDir], ["dataKeyFile", c.dataKeyFile]]) {
        const rel = path.relative(dir, place);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("config: " + name + " is inside the served folder " + dir);
      }
    }
    c.devStatic = mounts;
  }
  if (c.trustProxy !== true && c.trustProxy !== false && !(typeof c.trustProxy === "string" && ["x-real-ip", "cf-connecting-ip"].includes(c.trustProxy.toLowerCase()))) {
    throw new Error("config: trustProxy must be true, false, \"x-real-ip\" or \"cf-connecting-ip\"");
  }
  positive(c.listen.port, "listen.port");
  positive(c.session.days, "session.days");
  positive(c.session.idleDays, "session.idleDays");
  positive(c.session.maxPerAccount, "session.maxPerAccount");
  if (c.password.minLength < 10) throw new Error("config: password.minLength below 10");
  positive(c.password.maxLength, "password.maxLength");
  for (const [name, l] of Object.entries(c.limits)) {
    for (const k of ["max", "windowSeconds", "blockSeconds", "maxBlockSeconds"]) positive(l[k], "limits." + name + "." + k);
  }
  const r = c.relay;
  if (typeof r.path !== "string" || !r.path.startsWith("/")) throw new Error("config: relay.path must start with /");
  for (const k of ["maxDatagram", "idleSeconds", "pingSeconds", "sessionCheckSeconds", "maxSocketsPerAccount",
    "maxSocketsPerIp", "maxSocketsTotal", "abuseCloseSeconds", "maxPendingBytes", "masterQueriesPerSecond"]) positive(r[k], "relay." + k);
  if (r.maxDatagram < 1500 || r.maxDatagram > 65507) throw new Error("config: relay.maxDatagram must be 1500..65507");
  for (const group of ["perAccount", "perIp"]) {
    for (const k of ["packetsPerSecond", "packetBurst", "bytesPerSecond", "byteBurst"]) positive(r[group][k], "relay." + group + "." + k);
  }
  if (!Array.isArray(c.modules)) throw new Error("config: modules must be a list of names");
  for (const k of ["modSuspendMaxDays", "auditRetentionDays", "renameCooldownDays", "renameHoldDays"]) positive(c.admin[k], "admin." + k);
  for (const k of ["codeSeconds", "intervalSeconds", "maxPending", "maxPendingPerIp", "adoptNonceSeconds"]) positive(c.link[k], "link." + k);
  return c;
}

export function loadConfig(file) {
  if (!file) {
    const local = path.join(HOME, "config.json");
    if (fs.existsSync(local)) file = local;
  }
  if (!file) return resolveConfig({}, HOME);
  const text = fs.readFileSync(file, "utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error("config: " + file + " is not valid JSON: " + e.message);
  }
  const c = resolveConfig(raw, path.dirname(path.resolve(file)));
  c.file = path.resolve(file);
  return c;
}

const SECRET_KEYS = ["playerIdKey", "passwordPepper"];

function readSecrets(file) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error("secrets: " + file + " cannot be read (" + e.message + "). Restore it from the backup; a new one would lose every password and player id.");
  }
  const out = {};
  for (const k of SECRET_KEYS) {
    const b = Buffer.from(String(s[k] || ""), "base64");
    if (b.length !== 32) throw new Error("secrets: " + file + " has no valid " + k + ". Restore it from the backup.");
    out[k] = b;
  }
  return out;
}

// The service calls this with create = true; the admin script with create = false, so that a
// script run as root before the first start never makes a secrets file the service cannot read.
export function loadSecrets(dataDir, { create = false, log } = {}) {
  const file = path.join(dataDir, "secrets.json");
  if (fs.existsSync(file)) {
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077 && log) log.warn("secrets.mode", { file, mode: mode.toString(8), fix: "chmod 600" });
    }
    return readSecrets(file);
  }
  if (!create) throw new Error("secrets: " + file + " does not exist. Start the service once first; it makes the file.");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const body = {
    note: "h9web secrets. Never commit, never copy into the site. Back up offline once: losing this file loses every password and player id.",
    created: new Date().toISOString(),
    playerIdKey: crypto.randomBytes(32).toString("base64"),
    passwordPepper: crypto.randomBytes(32).toString("base64"),
  };
  // "wx": never overwrite a file another process made a moment ago
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(body, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (log) log.warn("secrets.created", { file, todo: "back this file up offline now" });
  return readSecrets(file);
}
