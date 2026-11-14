// Authentication for a standalone relay (bin/h9rv.js). createService takes any object with host(token), account(token) and
// accountsAvailable (lib/service.js); this file has the two that a standalone relay uses:
//
//   hostsFileAuth  the operator's own list of host tokens, a JSON file (hosts.json, README.txt). A token is kept as its SHA-256
//                  only, in the file ("sha256:<hex>" keys, made by `h9rv token`) and in memory (a plain key is hashed when the file
//                  is read), so a lookup is by hash and a timing difference tells nothing about a token. The file is read again when
//                  it changes (checked at most every 2 s on a call, and by the runner every 5 s): a token added works at once, one
//                  removed or disabled stops working at once and its sessions are closed. A file that does not parse is refused at
//                  start and ignored while running (the table in use stays).
//   linkTokenAuth  havoc9.org accounts: the token is the player's link token, checked against an h9web's GET /api/link/status
//                  (an answer is kept 60 s, a refusal 10 s). h9web's own module uses it with its accounts table to resolve the account.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { TokenBucket } from "./limits.js";

export const PLACEHOLDER = "CHANGE-ME";
export const MIN_TOKEN_LENGTH = 20;
const ID_RX = /^[A-Za-z0-9_.:-]{1,40}$/;

export const hashToken = (token) => "sha256:" + crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
export const makeToken = () => "h9t_" + crypto.randomBytes(24).toString("base64url");
const tame = (v, max) => String(v).replace(/[^\x20-\x7e]/g, "?").slice(0, max);
const hint = (key) => String(key).slice(0, 4).replace(/[^\x20-\x7e]/g, "?") + "...";

// The hosts file's text -> { entries: Map("sha256:<hex>" -> { id, name, public, disabled }), problems: [text] }.
// Keys that start with "_" are notes. A problem never carries a token. A file with no token at all is valid here (the operator took the last one
// away); hostsFileAuth refuses it at start, where nobody could ever open a session.
export function parseHosts(text) {
  const entries = new Map();
  const problems = [];
  let doc;
  try {
    doc = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (e) {
    return { entries, problems: ["not valid JSON (" + e.message + ")"] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { entries, problems: ["the top level must be an object: { \"<token>\": { \"id\": 1, \"name\": \"Mike\" } }"] };
  }
  for (const [key, v] of Object.entries(doc)) {
    if (key.startsWith("_")) continue;
    if (key.toUpperCase().startsWith(PLACEHOLDER)) {
      problems.push("an entry still holds the example token (" + PLACEHOLDER + "...): make a real one with  node bin/h9rv.js token <name> --hosts hosts.json");
      continue;
    }
    const hashed = /^sha256:[0-9a-f]{64}$/i.test(key);
    if (!hashed && key.length < MIN_TOKEN_LENGTH) {
      problems.push("the token that starts \"" + hint(key) + "\" is shorter than " + MIN_TOKEN_LENGTH + " characters: make one with  node bin/h9rv.js token <name> --hosts hosts.json");
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      problems.push("the entry \"" + hint(key) + "\" must be an object with an id and a name");
      continue;
    }
    if (!((Number.isInteger(v.id) && v.id > 0) || (typeof v.id === "string" && ID_RX.test(v.id)))) {
      problems.push("the entry \"" + hint(key) + "\" needs an id: a whole number above 0 (or letters, digits and _.:- up to 40 characters)");
      continue;
    }
    entries.set(hashed ? key.toLowerCase() : hashToken(key), {
      id: v.id, name: tame(v.name || "host " + v.id, 32), public: v.public !== false, disabled: v.disabled === true,
    });
  }
  return { entries, problems };
}

export function hostsFileAuth({ file, log = () => {}, now = Date.now, recheckMs = 2000, onRemoved = () => {} }) {
  let table = new Map();
  let signature = "";
  let checked = 0;

  function load(first) {
    // one descriptor for the stat and the read: the file cannot change between them
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const st = fs.fstatSync(fd);
      const sig = st.mtimeMs + ":" + st.size;
      if (sig === signature) return;
      signature = sig;
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    const r = parseHosts(text);
    if (first && !r.problems.length && !r.entries.size) r.problems.push("no host token in it yet: make one with  node bin/h9rv.js token <name> --hosts hosts.json");
    if (r.problems.length) {
      if (first) throw Object.assign(new Error(file + ": " + r.problems.join("; ")), { problems: r.problems });
      log("hosts.reload_refused", { problems: r.problems.length });
      return;
    }
    const active = (m) => new Set([...m.values()].filter((e) => !e.disabled).map((e) => e.id));
    const before = active(table);
    table = r.entries;
    const after = active(table);
    for (const id of before) if (!after.has(id)) onRemoved(id);
    log("hosts.loaded", { hosts: table.size });
  }

  function recheck() {
    if (now() - checked < recheckMs) return;
    checked = now();
    try { load(false); } catch (e) { log("hosts.reload_error", { error: String(e && e.code || e && e.message) }); }
  }

  load(true);
  checked = now();
  return {
    host(token) {
      recheck();
      const e = table.get(hashToken(String(token || "")));
      return e && !e.disabled ? { id: e.id, name: e.name, public: e.public } : null;
    },
    account() { return null; },
    accountsAvailable: false,
    recheck,
    size: () => table.size,
  };
}

// ---- hosts.json by hand: what `h9rv token`, `h9rv hosts list` and `h9rv hosts remove` do --------------------------------

function readDoc(file) {
  if (!fs.existsSync(file)) return {};
  const doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(file + " is not a JSON object");
  return doc;
}

// The file is replaced whole (written beside it, then renamed). An existing file keeps its permissions and, when root writes it, its
// owner, so that `sudo node bin/h9rv.js token ...` leaves /etc/h9-p2p/hosts.json readable by the service's user.
function writeDoc(file, doc) {
  let before = null;
  try { before = fs.statSync(file); } catch (e) { /* a new file */ }
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: before ? before.mode & 0o777 : 0o600 });
  if (before) {
    try { fs.chmodSync(tmp, before.mode & 0o777); } catch (e) { /* not supported here */ }
    try { fs.chownSync(tmp, before.uid, before.gid); } catch (e) { /* only root may give a file away: then it stays the writer's */ }
  }
  fs.renameSync(tmp, file);
}

// Makes a token, adds its hash as the next id (the example entry goes), and returns the token: it is shown once and kept nowhere.
export function addHost(file, { name, publicOk = true }) {
  const doc = readDoc(file);
  let max = 0;
  for (const [k, v] of Object.entries(doc)) {
    if (k.toUpperCase().startsWith(PLACEHOLDER)) delete doc[k];
    else if (!k.startsWith("_") && v && Number.isInteger(v.id)) max = Math.max(max, v.id);
  }
  const token = makeToken();
  const id = max + 1;
  doc[hashToken(token)] = { id, name: tame(name || "host " + id, 32), ...(publicOk ? {} : { public: false }) };
  writeDoc(file, doc);
  return { token, id };
}

export function listHosts(file) {
  const rows = [];
  for (const [k, v] of Object.entries(readDoc(file))) {
    if (k.startsWith("_") || !v || typeof v !== "object") continue;
    rows.push({ id: v.id, name: v.name || "", public: v.public !== false, disabled: v.disabled === true, key: /^sha256:/i.test(k) ? k.slice(0, 15) + "..." : "(a plain token: replace it with a hashed one)" });
  }
  return rows;
}

export function removeHost(file, id) {
  const doc = readDoc(file);
  let n = 0;
  for (const [k, v] of Object.entries(doc)) {
    if (!k.startsWith("_") && v && String(v.id) === String(id)) { delete doc[k]; n++; }
  }
  if (n) writeDoc(file, doc);
  return n;
}

// ---- havoc9.org link tokens ----------------------------------------------------------------------------------------------

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    // the address comes from a configuration file: https only (http to this PC alone, for tests), and no credentials in it
    const here = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && here))) return resolve(null);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, agent: false, headers: { "User-Agent": "h9_p2p_relay/1", Accept: "application/json" } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on("data", (c) => { n += c.length; if (n <= 8192) chunks.push(c); });
      res.on("end", () => {
        if (res.statusCode !== 200 || n > 8192) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// statusUrl: ".../api/link/status?token=" (the token is appended, URL-encoded), or a function that returns it, or null while it is not
// known yet (every check is then a no). resolve(accountName) -> { id, name } | null (it may look the account up, refuse a suspended
// one, or derive an id); the default derives "h9:<lower-case name>".
export function linkTokenAuth({ statusUrl, resolve = null, now = Date.now, timeoutMs = 3000, getter = getJson }) {
  const cache = new Map();
  const budget = new TokenBucket(20, 40, now); // checks that miss the cache per second: a flood of made-up tokens cannot make this a hammer for h9web
  const derive = (name) => ({ id: "h9:" + String(name).toLowerCase(), name: String(name) });
  // What is kept is h9web's answer (the account's name); resolve runs at every check, so a suspension counts at once.
  async function check(token) {
    const t = String(token || "");
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(t)) return null;
    let name = null;
    const hit = cache.get(t);
    if (hit && hit.until > now()) {
      name = hit.name;
    } else {
      const prefix = typeof statusUrl === "function" ? statusUrl() : statusUrl;
      if (!prefix) return null;
      if (!budget.take(1)) return null;
      const r = await getter(prefix + encodeURIComponent(t), timeoutMs);
      name = r && r.status === "linked" && typeof r.account === "string" && r.account ? r.account : null;
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(t, { name, until: now() + (name ? 60000 : 10000) });
    }
    return name ? (await (resolve || derive)(name)) || null : null;
  }
  // forget() drops what is kept (h9web's module calls it when a game is unlinked: that token must be asked about again).
  return { host: check, account: check, accountsAvailable: true, forget: () => cache.clear() };
}
