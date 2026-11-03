// Backups of h9web's data, restores of all of it or of a part, and JSON exports of the forum or
// of the communities that another h9web can import. bin/h9web-backup.js is the command;
// README.txt section 10 is the guide.
//
// A backup is one file, h9web-<host>-<yyyyMMdd-HHmmss>.h9backup (the time in UTC, <host> from
// the first of allowedOrigins): a tar archive, gzip'd, that holds in this order
//   manifest.json      the format, the time, the host, the h9web version, each module's
//                      migration version, every table's row count, whether keys are in it, the
//                      ids (hashes) of the keys it was made with, and the size and SHA-256 of
//                      every other file
//   db/h9web.db        the database, copied with VACUUM INTO: consistent while the service runs
//   data/modules/...   <dataDir>/modules: the forum's pictures, the presence keys and the like
//   keys/...           only with keys: secrets.json, the data key, any module's secrets.json
// <dataDir>/backups (the copies made before migrations, restores and imports) is never in it.
// Encrypted, the gzip'd archive is sealed with AES-256-GCM under a key made from a passphrase
// with scrypt; the file is then "H9BKENC1", scrypt's log2 N, r and p (a byte each), a 16-byte
// salt, a 12-byte nonce, the ciphertext and the 16-byte tag, with the header as the additional
// data.
//
// What belongs to what is read from the database, never from a list kept here: a module's
// tables are named <module>_... (lib/modules.js) and schema_migrations names the modules and
// their versions; every other table is core's (accounts, sessions, audit_log, username_...).
// "community" is the presence tables named presence_communit... and every presence table whose
// foreign keys lead to one of them (members, staff, requests, invites, servers, sanctions ...).
// A row put back whose account (or other parent row) no longer exists is treated as SQLite
// treats it when that parent is deleted: ON DELETE CASCADE leaves it out, ON DELETE SET NULL
// clears the reference (a post from a deleted account), which is how each module defines a
// deleted account.

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HOME } from "./config.js";
import { usernameKey } from "./usernames.js";
import { createDataBox } from "./datakey.js";

export const EXT = ".h9backup";
const FORMAT = "h9web-backup";
const EXPORT_FORMAT = "h9web-export";
const DB_NAME = "h9web.db";
const DB_ENTRY = "db/" + DB_NAME;
const MAGIC = Buffer.from("H9BKENC1", "ascii");
const HEADER = MAGIC.length + 3 + 16 + 12;
const TAG = 16;
// scrypt for the passphrase: N = 2^17, r 8, p 1 (128 MiB, a fraction of a second, once per file)
const SCRYPT = { ln: 17, r: 8, p: 1 };
export const PASSPHRASE_MIN = 12;
const POSIX = process.platform !== "win32";
const COMMUNITY_ROOT = "presence_communit";
// Left out of a JSON export: the forum's profile pictures are files named by account id, which
// a backup carries and a JSON file does not. An import leaves the target's pictures as they are.
const JSON_LEAVE_OUT = { forum: ["forum_avatars"] };
export const JSON_SELECTIONS = ["forum", "community"];
// the folder that holds h9web/ (the checkout): nothing this writes may land in it
const CHECKOUT = path.resolve(HOME, "..");

export const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(HOME, "package.json"), "utf8")).version || "unknown");
  } catch (e) {
    return "unknown";
  }
})();

// code: usage (a wrong command line), running, passphrase, keys, version, damaged, cancelled,
// failed
export class BackupError extends Error {
  constructor(message, code = "failed") {
    super(message);
    this.code = code;
  }
}

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return null;
  }
};

// yyyyMMdd-HHmmss, UTC
export function stamp(date) {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

export function hostOf(config) {
  let host = "";
  try {
    host = new URL(config.allowedOrigins[0]).hostname;
  } catch (e) { /* no origin: "local" */ }
  return host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "local";
}

export function defaultOut(config) {
  return path.join(config.dataDir, "backups");
}

export function insideCheckout(p) {
  if (path.parse(CHECKOUT).root === CHECKOUT) return false;
  const rel = path.relative(CHECKOUT, path.resolve(p));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function keepOutOfCheckout(p, what) {
  if (insideCheckout(p)) {
    throw new BackupError(what + " " + path.resolve(p) + " is inside the checkout (" + CHECKOUT + "): backups and exports stay out of the repository. Choose a folder outside it.", "usage");
  }
}

// A folder, and the folders made on the way to it 0700 where the OS has modes.
function makeDir(dir) {
  const first = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!first || !POSIX) return;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try { fs.chmodSync(d, 0o700); } catch (e) { /* not ours to change: left as it is */ }
    if (d === path.resolve(first) || path.dirname(d) === d) return;
  }
}

// A new file (never over an existing one), 0600 where the OS has modes, flushed to disk.
function writePrivate(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// renameSync, tried again for a moment on Windows while something (a virus scanner, a preview)
// holds the file
function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (POSIX || i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function freeName(dir, base, ext) {
  for (let i = 1; ; i++) {
    const file = path.join(dir, base + (i > 1 ? "-" + i : "") + ext);
    if (!fs.existsSync(file) && !fs.existsSync(file + ".partial")) return file;
  }
}

// ---- tar (ustar, plain files only) -----------------------------------------------------------

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    let cut = -1;
    for (let i = name.indexOf("/"); i > 0; i = name.indexOf("/", i + 1)) {
      if (Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) {
        cut = i;
        break;
      }
    }
    if (cut < 0) throw new BackupError("archive: the path " + name + " is too long", "failed");
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, "utf8");
  h.write("0000600\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  h.write(Math.max(0, Math.floor(mtime)).toString(8).padStart(11, "0") + "\0", 136, "ascii");
  h.fill(0x20, 148, 156);
  h.write("0", 156, "ascii");
  h.write("ustar\u000000", 257, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

// entries: [{ name, data, mtime }] -> one tar archive
export function writeTar(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.data.length, e.mtime || Date.now() / 1000), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function field(h, start, length) {
  const end = h.indexOf(0, start);
  return h.toString("utf8", start, end >= start && end < start + length ? end : start + length);
}

export function readTar(buf) {
  const entries = [];
  for (let off = 0; ; ) {
    if (off + 512 > buf.length) throw new BackupError("archive: it ends early (damaged)", "damaged");
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return entries;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== parseInt(field(h, 148, 8).trim(), 8)) throw new BackupError("archive: a damaged tar header", "damaged");
    const base = field(h, 0, 100);
    const prefix = h.toString("ascii", 257, 262) === "ustar" ? field(h, 345, 155) : "";
    const name = prefix ? prefix + "/" + base : base;
    const size = parseInt(field(h, 124, 12).trim() || "0", 8);
    off += 512;
    if (!Number.isSafeInteger(size) || size < 0 || off + size > buf.length) throw new BackupError("archive: it ends early (damaged)", "damaged");
    if (h[156] === 0x30 || h[156] === 0) entries.push({ name, data: buf.subarray(off, off + size) });
    else if (h[156] !== 0x35) throw new BackupError("archive: " + name + " is not a plain file", "damaged");
    off += Math.ceil(size / 512) * 512;
  }
}

// An archive's path as folder names: relative, "/" between names, nothing that climbs out of
// the folder it is unpacked into or that Windows reads otherwise (a drive, a stream, a device).
function pathParts(name) {
  const parts = String(name).split("/");
  if (!name || /[\\:*?"<>|\u0000-\u001f]/.test(name) || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new BackupError("archive: an unsafe path " + JSON.stringify(name), "damaged");
  }
  return parts;
}

function writeEntry(root, rel, data) {
  const dest = path.join(root, ...pathParts(rel));
  makeDir(path.dirname(dest));
  writePrivate(dest, data);
}

// ---- encryption ------------------------------------------------------------------------------

function deriveKey(passphrase, salt, { ln, r, p }) {
  const N = 2 ** ln;
  if (ln < 14 || ln > 22 || r < 1 || r > 32 || p < 1 || p > 16 || 128 * N * r > 1024 ** 3) throw new BackupError("archive: unusable encryption settings in its header (damaged)", "damaged");
  return crypto.scryptSync(String(passphrase).normalize("NFC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 16 * 1024 * 1024 });
}

export function encrypt(plain, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([SCRYPT.ln, SCRYPT.r, SCRYPT.p]), salt, iv]);
  const c = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, SCRYPT), iv, { authTagLength: TAG });
  c.setAAD(header);
  return Buffer.concat([header, c.update(plain), c.final(), c.getAuthTag()]);
}

function decrypt(buf, passphrase, label) {
  if (buf.length < HEADER + TAG) throw new BackupError(label + " is damaged (too short)", "damaged");
  const header = buf.subarray(0, HEADER);
  const at = MAGIC.length;
  const key = deriveKey(passphrase, buf.subarray(at + 3, at + 19), { ln: buf[at], r: buf[at + 1], p: buf[at + 2] });
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(at + 19, HEADER), { authTagLength: TAG });
  d.setAAD(header);
  d.setAuthTag(buf.subarray(buf.length - TAG));
  try {
    return Buffer.concat([d.update(buf.subarray(HEADER, buf.length - TAG)), d.final()]);
  } catch (e) {
    throw new BackupError(label + ": the passphrase is wrong, or the file was changed", "passphrase");
  }
}

// The passphrase, from --passphrase-file (its first line) or H9WEB_BACKUP_PASSPHRASE; null when
// neither is given. Never from the command line.
export function readPassphrase({ passphraseFile, env = process.env } = {}) {
  let text;
  if (passphraseFile) {
    let raw;
    try {
      raw = fs.readFileSync(passphraseFile);
    } catch (e) {
      throw new BackupError("--passphrase-file: " + e.message, "passphrase");
    }
    text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString("utf16le") : raw.toString("utf8").replace(/^\uFEFF/, "");
    text = text.split(/\r?\n/)[0];
  } else if (env.H9WEB_BACKUP_PASSPHRASE) {
    text = env.H9WEB_BACKUP_PASSPHRASE;
  } else {
    return null;
  }
  if (text.length < PASSPHRASE_MIN) throw new BackupError("the passphrase is shorter than " + PASSPHRASE_MIN + " characters", "passphrase");
  return text;
}

// ---- the database's layout -------------------------------------------------------------------

function tableList(db, schema = "main") {
  return db.prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name`).all();
}

// { core: 2, forum: 6, ... }: each module's newest applied migration
export function moduleVersions(db, schema = "main") {
  const out = {};
  if (!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get()) return out;
  for (const r of db.prepare(`SELECT module, max(version) AS v FROM ${schema}.schema_migrations GROUP BY module ORDER BY module`).all()) out[r.module] = r.v;
  return out;
}

function rowCounts(db, schema = "main", tables = tableList(db, schema).map((t) => t.name)) {
  const out = {};
  for (const t of tables) out[t] = db.prepare(`SELECT count(*) AS n FROM ${schema}.${q(t)}`).get().n;
  return out;
}

function columnsOf(db, table, schema = "main") {
  return db.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all().map((c) => c.name);
}

// [{ table: parent, from: [columns], to: [parent columns or null], onDelete }]
function foreignKeys(db, table, schema = "main") {
  const byId = new Map();
  for (const r of db.prepare(`PRAGMA ${schema}.foreign_key_list(${q(table)})`).all()) {
    if (!byId.has(r.id)) byId.set(r.id, { table: r.table, from: [], to: [], onDelete: String(r.on_delete || "NO ACTION").toUpperCase() });
    byId.get(r.id).from.push(r.from);
    byId.get(r.id).to.push(r.to);
  }
  return [...byId.values()];
}

function parentColumns(db, fk) {
  if (fk.to.every(Boolean)) return fk.to;
  const pk = db.prepare(`PRAGMA main.table_info(${q(fk.table)})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return pk.length === fk.from.length ? pk : ["rowid"];
}

// column -> ON DELETE action, for every one-column reference to accounts(id)
function accountColumns(db, table) {
  const out = new Map();
  for (const fk of foreignKeys(db, table)) if (fk.table === "accounts" && fk.from.length === 1) out.set(fk.from[0], fk.onDelete);
  return out;
}

function hasRowid(db, table) {
  const r = db.prepare(`PRAGMA main.table_list(${q(table)})`).get();
  return !r || !r.wr;
}

function ownerOf(table, modules) {
  for (const m of modules) if (table.startsWith(m + "_") || table.startsWith(m.replace(/-/g, "_") + "_")) return m;
  return "core";
}

// What --only names, from the database as it is:
//   <module>          that module's tables, and its files (<dataDir>/modules/<module>)
//   accounts (core)   the tables no module's name claims
//   community         presence_communit... and the presence tables whose foreign keys lead to them
// { names, modules: Set, tables: [..], fileDirs: [..], virtual: [..] }
export function resolveSelection(db, names, schema = "main") {
  const modules = Object.keys(moduleVersions(db, schema)).filter((m) => m !== "core").sort((a, b) => b.length - a.length);
  const all = tableList(db, schema);
  const owner = new Map(all.map((t) => [t.name, ownerOf(t.name, modules)]));
  const sel = { names: [], modules: new Set(), tables: new Set(), fileDirs: [] };
  for (const raw of names) {
    const name = raw === "core" ? "accounts" : raw === "communities" ? "community" : raw;
    let tables;
    if (name === "accounts") {
      tables = all.filter((t) => owner.get(t.name) === "core").map((t) => t.name);
      sel.modules.add("core");
    } else if (name === "community") {
      const presence = all.filter((t) => owner.get(t.name) === "presence").map((t) => t.name);
      const set = new Set(presence.filter((t) => t.startsWith(COMMUNITY_ROOT)));
      for (let grew = set.size > 0; grew; ) {
        grew = false;
        for (const t of presence) {
          if (!set.has(t) && foreignKeys(db, t, schema).some((fk) => set.has(fk.table))) {
            set.add(t);
            grew = true;
          }
        }
      }
      tables = [...set];
      sel.modules.add("presence");
    } else if (modules.includes(name)) {
      tables = all.filter((t) => owner.get(t.name) === name).map((t) => t.name);
      sel.modules.add(name);
      sel.fileDirs.push("modules/" + name);
    } else {
      throw new BackupError("--only " + raw + ": no such part. The parts here: " + ["accounts", "community", ...modules.slice().sort()].join(", "), "usage");
    }
    if (!tables.length) throw new BackupError("--only " + raw + ": " + (schema === "main" ? "this database" : "the backup") + " has no tables for it", "usage");
    if (!sel.names.includes(name)) sel.names.push(name);
    for (const t of tables) sel.tables.add(t);
  }
  sel.tables = [...sel.tables].sort();
  sel.virtual = all.filter((t) => sel.tables.includes(t.name) && /^\s*CREATE\s+VIRTUAL/i.test(t.sql || "")).map((t) => t.name);
  return sel;
}

// "12 accounts; core 140 rows, forum 3200 rows, ..." from a table -> rows map
export function summarize(tables, modules) {
  const mods = Object.keys(modules || {}).filter((m) => m !== "core").sort((a, b) => b.length - a.length);
  const sums = {};
  for (const [t, n] of Object.entries(tables || {})) {
    const o = ownerOf(t, mods);
    sums[o] = (sums[o] || 0) + n;
  }
  const parts = Object.keys(sums).sort().map((o) => o + " " + sums[o] + " rows");
  const accounts = tables && "accounts" in tables ? tables.accounts + (tables.accounts === 1 ? " account; " : " accounts; ") : "";
  return accounts + (parts.join(", ") || "no tables");
}

// ---- the keys' ids (hashes: they name a key without giving it away) -------------------------

function secretsIdOf(text) {
  try {
    const s = JSON.parse(text);
    if (!s.playerIdKey || !s.passwordPepper) return null;
    return crypto.createHash("sha256").update("h9web secrets id v1\u0000" + s.playerIdKey + "\u0000" + s.passwordPepper).digest("hex").slice(0, 8);
  } catch (e) {
    return null;
  }
}

function dataKeyIdOf(text) {
  try {
    const key = Buffer.from(String(text).trim(), "base64");
    return text && key.length === 32 ? createDataBox(key).keyId : null;
  } catch (e) {
    return null;
  }
}

// ---- making a backup ---------------------------------------------------------------------------

// <dataDir>/modules as [{ rel: "modules/forum/avatars/1-2.png", file, key }]: no links, no
// unfinished uploads (*.tmp). key: a module's secrets.json, which goes only with the keys.
function moduleFiles(dataDir) {
  const out = [];
  const walk = (rel) => {
    let list;
    try {
      list = fs.readdirSync(path.join(dataDir, ...rel.split("/")), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const d of list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel + "/" + d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile() && !d.name.endsWith(".tmp")) out.push({ rel: r, file: path.join(dataDir, ...r.split("/")), key: d.name === "secrets.json" });
    }
  };
  walk("modules");
  return out;
}

// One archive of the data that the open database db belongs to, into file. work: an empty
// folder for the copy of the database.
function writeArchive({ db, config, file, withKeys, passphrase, now, work }) {
  const snap = path.join(work, DB_NAME);
  db.prepare("VACUUM INTO ?").run(snap);
  const sdb = new DatabaseSync(snap);
  let modules, tables;
  try {
    modules = moduleVersions(sdb);
    tables = rowCounts(sdb);
  } finally {
    sdb.close();
  }
  const files = [{ name: DB_ENTRY, role: "db", data: fs.readFileSync(snap) }];
  for (const f of moduleFiles(config.dataDir)) {
    if (f.key && !withKeys) continue;
    files.push({ name: (f.key ? "keys/" : "data/") + f.rel, role: f.key ? "key" : "data", data: fs.readFileSync(f.file) });
  }
  if (withKeys) {
    for (const [name, from] of [["keys/secrets.json", path.join(config.dataDir, "secrets.json")], ["keys/data.key", config.dataKeyFile]]) {
      if (fs.existsSync(from)) files.push({ name, role: "key", data: fs.readFileSync(from) });
    }
  }
  const manifest = {
    format: FORMAT,
    formatVersion: 1,
    createdAt: now.toISOString(),
    host: hostOf(config),
    origin: config.allowedOrigins[0] || null,
    h9web: VERSION,
    node: process.version,
    modules,
    tables,
    keys: !!withKeys,
    encrypted: !!passphrase,
    secretsId: secretsIdOf(readText(path.join(config.dataDir, "secrets.json"))),
    dataKeyId: dataKeyIdOf(readText(config.dataKeyFile)),
    files: files.map((f) => ({ path: f.name, role: f.role, size: f.data.length, sha256: sha256(f.data) })),
  };
  const mtime = now.getTime() / 1000;
  const tar = writeTar([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }, ...files].map((e) => ({ ...e, mtime })));
  let body = zlib.gzipSync(tar, { level: 6 });
  if (passphrase) body = encrypt(body, passphrase);
  const partial = file + ".partial";
  try {
    writePrivate(partial, body);
    rename(partial, file);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e;
  }
  return { file, manifest, size: body.length };
}

const BACKUP_NAME = (host) => new RegExp("^h9web-" + host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d{8}-\\d{6})(?:-(\\d+))?\\" + EXT + "$");

// Deletes this host's oldest backups in dir beyond keep; the names deleted.
function prune(dir, host, keep) {
  const re = BACKUP_NAME(host);
  const list = fs.readdirSync(dir).map((name) => ({ name, m: re.exec(name) })).filter((x) => x.m);
  list.sort((a, b) => (a.m[1] !== b.m[1] ? (a.m[1] < b.m[1] ? 1 : -1) : Number(b.m[2] || 1) - Number(a.m[2] || 1)));
  const gone = list.slice(keep).map((x) => x.name);
  for (const name of gone) fs.rmSync(path.join(dir, name), { force: true });
  return gone;
}

// A backup of config's data into out (default <dataDir>/backups): { file, manifest, size, removed }.
export function createBackup({ config, out, keep, encrypt: sealed = false, withKeys = false, passphrase = null, now = new Date() }) {
  if (withKeys && !sealed) throw new BackupError("--with-keys needs --encrypt: the database and its keys in one plain file is a backup anyone can open", "usage");
  if (sealed && !passphrase) throw new BackupError("--encrypt needs a passphrase: set H9WEB_BACKUP_PASSPHRASE or give --passphrase-file FILE", "passphrase");
  if (keep !== undefined && keep !== null && !(Number.isInteger(keep) && keep >= 1)) throw new BackupError("--keep must be a whole number of 1 or more", "usage");
  const dbFile = path.join(config.dataDir, DB_NAME);
  if (!fs.existsSync(dbFile)) throw new BackupError(dbFile + " does not exist: a wrong --config, or the service has never started", "usage");
  const dir = path.resolve(out || defaultOut(config));
  keepOutOfCheckout(dir, "--out");
  makeDir(dir);
  const host = hostOf(config);
  const file = freeName(dir, "h9web-" + host + "-" + stamp(now), EXT);
  // the plain copy of the database is made in the data folder, never in the backup folder, which
  // may be copied off the machine
  const work = fs.mkdtempSync(path.join(config.dataDir, ".h9backup-"));
  const db = new DatabaseSync(dbFile);
  let result;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    result = writeArchive({ db, config, file, withKeys, passphrase: sealed ? passphrase : null, now, work });
  } finally {
    db.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  result.removed = keep ? prune(dir, host, keep) : [];
  return result;
}

// ---- reading and checking a backup -----------------------------------------------------------

// The archive, its checksums checked: { file, encrypted, manifest, data: Map(path -> Buffer) }.
export function readArchive(file, { passphrase = null } = {}) {
  const label = path.basename(file);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    throw new BackupError("cannot read " + file + ": " + e.message, "usage");
  }
  const encrypted = raw.length >= MAGIC.length && raw.subarray(0, MAGIC.length).equals(MAGIC);
  let gz = raw;
  if (encrypted) {
    if (!passphrase) throw new BackupError(label + " is encrypted: set H9WEB_BACKUP_PASSPHRASE or give --passphrase-file FILE", "passphrase");
    gz = decrypt(raw, passphrase, label);
  } else if (raw[0] !== 0x1f || raw[1] !== 0x8b) {
    throw new BackupError(label + " is not an h9web backup", "damaged");
  }
  let tar;
  try {
    tar = zlib.gunzipSync(gz);
  } catch (e) {
    throw new BackupError(label + " is damaged (" + e.message + ")", "damaged");
  }
  const entries = readTar(tar);
  if (!entries.length || entries[0].name !== "manifest.json") throw new BackupError(label + " is damaged: no manifest.json at its start", "damaged");
  let manifest;
  try {
    manifest = JSON.parse(entries[0].data.toString("utf8"));
  } catch (e) {
    throw new BackupError(label + " is damaged: its manifest.json is not JSON", "damaged");
  }
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files)) throw new BackupError(label + " is not an h9web backup", "damaged");
  if (!(manifest.formatVersion <= 1)) throw new BackupError(label + " was made by a newer h9web-backup (format " + manifest.formatVersion + "); use that one", "version");
  const data = new Map();
  for (const e of entries.slice(1)) {
    pathParts(e.name);
    if (data.has(e.name) || e.name === "manifest.json") throw new BackupError(label + " is damaged: " + e.name + " is in it twice", "damaged");
    data.set(e.name, e.data);
  }
  const listed = new Set();
  for (const f of manifest.files) {
    const d = data.get(f.path);
    if (!d) throw new BackupError(label + " is damaged: " + f.path + " is missing", "damaged");
    if (d.length !== f.size || sha256(d) !== f.sha256) throw new BackupError(label + ": " + f.path + " does not match its checksum; the file was changed or damaged", "damaged");
    listed.add(f.path);
  }
  for (const name of data.keys()) if (!listed.has(name)) throw new BackupError(label + ": " + name + " is not in its manifest; the file was changed", "damaged");
  if (!data.has(DB_ENTRY)) throw new BackupError(label + " is damaged: it holds no database", "damaged");
  return { file, encrypted, manifest, data };
}

// The copy of the database in an archive, opened: it passes quick_check and has the versions
// and row counts its manifest says. Returns the row counts.
function checkSnapshot(dbFile, manifest, label) {
  const db = new DatabaseSync(dbFile);
  try {
    const problems = [];
    const qc = db.prepare("PRAGMA quick_check").all().map((r) => Object.values(r)[0]);
    if (qc.length !== 1 || qc[0] !== "ok") problems.push("quick_check: " + qc.slice(0, 3).join("; "));
    const counts = rowCounts(db);
    for (const t of new Set([...Object.keys(counts), ...Object.keys(manifest.tables || {})])) {
      if (counts[t] !== (manifest.tables || {})[t]) problems.push(t + " has " + counts[t] + " rows, the manifest says " + (manifest.tables || {})[t]);
    }
    const versions = moduleVersions(db);
    for (const m of new Set([...Object.keys(versions), ...Object.keys(manifest.modules || {})])) {
      if (versions[m] !== (manifest.modules || {})[m]) problems.push(m + " is at v" + versions[m] + ", the manifest says v" + (manifest.modules || {})[m]);
    }
    if (problems.length) throw new BackupError(label + ": its database does not check out: " + problems.slice(0, 5).join("; "), "damaged");
    return counts;
  } finally {
    db.close();
  }
}

// readArchive, and the database opened and checked: { ..., counts }
export function verifyArchive(file, { passphrase = null } = {}) {
  const archive = readArchive(file, { passphrase });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-verify-"));
  try {
    const dbFile = path.join(tmp, DB_NAME);
    writePrivate(dbFile, archive.data.get(DB_ENTRY));
    archive.counts = checkSnapshot(dbFile, archive.manifest, path.basename(file));
    return archive;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// Every .h9backup in dir, newest name last: [{ name, size, ok, encrypted, manifest, error }]
export function listArchives(dir, { passphrase = null } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(EXT)).sort();
  } catch (e) {
    throw new BackupError("cannot read the folder " + dir + ": " + e.message, "usage");
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    try {
      const a = readArchive(file, { passphrase });
      return { name, file, size, ok: true, encrypted: a.encrypted, manifest: a.manifest };
    } catch (e) {
      return { name, file, size, ok: false, encrypted: e.code === "passphrase", error: e.message };
    }
  });
}

// ---- is the service running on this data? ----------------------------------------------------

export function portInUse(host, port, timeoutMs = 1000) {
  const target = !host || host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return new Promise((resolve) => {
    const s = net.connect({ host: target, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function runningError(why) {
  return new BackupError("h9web is running on this data: " + why + ". Stop it first, then run this again:\n" +
    "  the local site: Ctrl+C in its window (local-site.cmd), or close that window\n" +
    "  the VPS:        sudo systemctl stop h9web    (afterwards: sudo systemctl start h9web)", "running");
}

// The database with an exclusive lock, held until it is closed, so that nothing else uses it
// while a restore or an import runs and the service cannot start meanwhile; null when there is
// no database yet. Throws "running" when something listens on the service's port, or when
// another process has the database open (the service holds a lock on it all the time it runs).
export async function claimData(config) {
  const { host, port } = config.listen;
  if (await portInUse(host, port)) runningThrow("something is listening on " + host + ":" + port + " (listen in " + (config.file || "the settings") + ")");
  const dbFile = path.join(config.dataDir, DB_NAME);
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (e) {
    db.close();
    if (e.errcode === 5 || e.errcode === 6 || /locked|busy/i.test(e.message)) runningThrow("another process has its database " + dbFile + " open");
    throw e;
  }
  return db;
}

function runningThrow(why) {
  throw runningError(why);
}

// ---- putting rows back -----------------------------------------------------------------------

// After rows were replaced with the foreign keys off: every row of those tables, and of the
// tables that refer to them, whose parent row is gone is treated as SQLite treats it when the
// parent is deleted (CASCADE: left out; SET NULL: the reference cleared), again until nothing
// changes. { affected: [tables], report: [{ table, what, columns, parent, rows }] }
function fixReferences(db, tables) {
  const all = tableList(db).map((t) => t.name);
  const fks = new Map(all.map((t) => [t, foreignKeys(db, t)]));
  const affected = new Set(tables);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all) {
      if (!affected.has(t) && fks.get(t).some((fk) => affected.has(fk.table))) {
        affected.add(t);
        grew = true;
      }
    }
  }
  const report = new Map();
  for (let round = 0, changed = true; changed; round++) {
    if (round > 100) throw new BackupError("the references kept changing; nothing was changed", "failed");
    changed = false;
    for (const t of affected) {
      for (const fk of fks.get(t)) {
        if (fk.onDelete !== "CASCADE" && fk.onDelete !== "SET NULL") continue;
        const parent = parentColumns(db, fk);
        const where = fk.from.map((c) => `${q(t)}.${q(c)} IS NOT NULL`).join(" AND ") +
          ` AND NOT EXISTS (SELECT 1 FROM main.${q(fk.table)} AS p WHERE ` + fk.from.map((c, i) => `p.${q(parent[i])} = ${q(t)}.${q(c)}`).join(" AND ") + ")";
        const n = fk.onDelete === "CASCADE"
          ? db.prepare(`DELETE FROM main.${q(t)} WHERE ${where}`).run().changes
          : db.prepare(`UPDATE main.${q(t)} SET ${fk.from.map((c) => q(c) + " = NULL").join(", ")} WHERE ${where}`).run().changes;
        if (!n) continue;
        changed = true;
        const key = [t, fk.onDelete, fk.from.join(","), fk.table].join("|");
        report.set(key, (report.get(key) || 0) + Number(n));
      }
    }
  }
  return {
    affected: [...affected],
    report: [...report].map(([k, rows]) => {
      const [table, action, columns, parent] = k.split("|");
      return { table, what: action === "CASCADE" ? "left out" : "cleared", columns, parent, rows };
    }),
  };
}

function checkReferences(db, tables) {
  const bad = [];
  for (const t of tables) {
    for (const r of db.prepare(`PRAGMA main.foreign_key_check(${q(t)})`).all()) {
      if (bad.length < 5) bad.push(r.table + " row " + r.rowid + " -> " + r.parent);
    }
  }
  if (bad.length) throw new BackupError("rows would point at rows that do not exist (" + bad.join(", ") + "); nothing was changed", "failed");
}

// The keys a restore needs in place. Throws when the database would be unusable with them;
// returns warnings otherwise.
function keysCheck(archive, config, { secretsMatter, dataKeyMatters, allowOtherKeys }) {
  const m = archive.manifest;
  const warnings = [];
  if (secretsMatter && !archive.data.has("keys/secrets.json")) {
    const here = secretsIdOf(readText(path.join(config.dataDir, "secrets.json")));
    if (!here) {
      throw new BackupError("there is no usable secrets.json in " + config.dataDir + " and the backup holds none. Put the secrets.json (and data.key) the backup was made with there first (the service's user, mode 0600), then run this again.", "keys");
    }
    if (m.secretsId && here !== m.secretsId) {
      const text = "the backup was made with another secrets.json (id " + m.secretsId + "; the one here is " + here + "): every password and player id in it would stop working";
      if (!allowOtherKeys) throw new BackupError(text + ". Put the secrets.json it was made with in place first, or give --allow-other-keys to restore anyway.", "keys");
      warnings.push(text + " (--allow-other-keys)");
    }
  }
  if (dataKeyMatters && !archive.data.has("keys/data.key") && m.dataKeyId) {
    const here = dataKeyIdOf(readText(config.dataKeyFile));
    if (here !== m.dataKeyId) warnings.push("the backup was made with another data key (" + m.dataKeyId + "; here " + (here || "none") + "): its Discord links do not open until that data.key is back in place (README.txt section 10)");
  }
  return warnings;
}

function safetyBackup(db, config, kind, work, now) {
  const dir = path.join(config.dataDir, "backups");
  makeDir(dir);
  const file = freeName(dir, kind + "-" + stamp(now), EXT);
  writeArchive({ db, config, file, withKeys: false, passphrase: null, now, work: fs.mkdtempSync(path.join(work, "safety-")) });
  return file;
}

// The archive's files under prefix (a folder such as modules or modules/forum) into stageRoot,
// and the key files in place there that the archive does not hold (they stay).
function stageFiles(archive, config, prefix, stageRoot) {
  let n = 0;
  for (const [name, data] of archive.data) {
    const m = /^(data|keys)\/(.+)$/.exec(name);
    if (!m || !(m[2] === prefix || m[2].startsWith(prefix + "/"))) continue;
    writeEntry(stageRoot, m[2], data);
    n++;
  }
  for (const f of moduleFiles(config.dataDir)) {
    if (!f.key || !(f.rel.startsWith(prefix + "/"))) continue;
    const dest = path.join(stageRoot, ...f.rel.split("/"));
    if (!fs.existsSync(dest)) writeEntry(stageRoot, f.rel, fs.readFileSync(f.file));
  }
  makeDir(path.join(stageRoot, ...prefix.split("/")));
  return n;
}

// Restores a backup into config's data: the whole of it, or the parts only names. Refuses while
// the service runs; takes a safety backup into <dataDir>/backups before changing anything.
// confirm(lines) shows the plan and answers true to go on.
export async function restoreArchive({ config, file, only = [], passphrase = null, confirm = async () => true, allowOtherKeys = false, now = new Date() }) {
  const archive = readArchive(file, { passphrase });
  const label = path.basename(file);
  const cur = await claimData(config);
  let open = !!cur;
  let work = null;
  const close = () => {
    if (open) cur.close();
    open = false;
  };
  try {
    if (only.length && !cur) throw new BackupError("there is no database at " + path.join(config.dataDir, DB_NAME) + " to restore a part into; restore the whole backup (no --only)", "usage");
    makeDir(config.dataDir);
    work = fs.mkdtempSync(path.join(config.dataDir, ".h9restore-"));
    const snap = path.join(work, DB_NAME);
    writePrivate(snap, archive.data.get(DB_ENTRY));
    checkSnapshot(snap, archive.manifest, label);
    const args = { archive, config, cur, close, work, snap, label, confirm, allowOtherKeys, now };
    return only.length ? await restorePart({ ...args, only }) : await restoreAll(args);
  } finally {
    close();
    if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function restoreAll({ archive, config, cur, close, work, snap, label, confirm, allowOtherKeys, now }) {
  const m = archive.manifest;
  const dataDir = config.dataDir;
  const dbFile = path.join(dataDir, DB_NAME);
  const warnings = keysCheck(archive, config, { secretsMatter: true, dataKeyMatters: true, allowOtherKeys });
  if (cur) {
    const here = moduleVersions(cur);
    for (const [mod, v] of Object.entries(m.modules || {})) {
      if (v > (here[mod] || 0) && here[mod]) warnings.push(mod + " is at v" + v + " in the backup and v" + here[mod] + " here: the service starts on it only with code that knows v" + v + " (the h9web the backup was made with, " + m.h9web + ", or newer)");
    }
  }
  const keyFiles = [["keys/secrets.json", path.join(dataDir, "secrets.json")], ["keys/data.key", config.dataKeyFile]].filter(([name]) => archive.data.has(name));
  const fileCount = [...archive.data.keys()].filter((n) => /^(data|keys)\/modules\//.test(n)).length;
  const lines = [
    "restore " + label + " (made " + m.createdAt + " on " + m.host + ", h9web " + m.h9web + ") over " + dataDir + ":",
    "  the whole database: " + summarize(m.tables, m.modules),
    "  the modules' files: " + fileCount + " from the backup, in place of the ones here (a key file here that the backup lacks stays)",
    "  keys: " + (keyFiles.length ? keyFiles.map(([n]) => n.slice(5)).join(" and ") + " from the backup; the ones here are kept beside them as *.pre-restore-<time>" : "secrets.json and data.key here stay as they are"),
    "  first, a safety backup of the data here into " + path.join(dataDir, "backups") + (cur ? "" : " (none: there is no database here yet)"),
    ...warnings.map((w) => "  WARNING: " + w),
  ];
  if (!(await confirm(lines))) throw new BackupError("nothing was changed", "cancelled");
  const safety = cur ? safetyBackup(cur, config, "pre-restore", work, now) : null;
  const staged = path.join(work, "new");
  stageFiles(archive, config, "modules", staged);
  const old = path.join(work, "old");
  makeDir(old);
  const undo = [];
  const move = (from, to) => {
    rename(from, to);
    undo.push(() => rename(to, from));
  };
  const asides = [];
  try {
    close();
    for (const ext of ["", "-wal", "-shm", "-journal"]) if (fs.existsSync(dbFile + ext)) move(dbFile + ext, path.join(old, DB_NAME + ext));
    move(snap, dbFile);
    const live = path.join(dataDir, "modules");
    if (fs.existsSync(live)) move(live, path.join(old, "modules"));
    move(path.join(staged, "modules"), live);
    for (const [name, dest] of keyFiles) {
      const data = archive.data.get(name);
      if (fs.existsSync(dest)) {
        if (fs.readFileSync(dest).equals(data)) continue;
        const aside = freeName(path.dirname(dest), path.basename(dest) + ".pre-restore-" + stamp(now), "");
        move(dest, aside);
        asides.push(aside);
      }
      makeDir(path.dirname(dest));
      writePrivate(dest, data);
      undo.push(() => fs.rmSync(dest, { force: true }));
    }
  } catch (e) {
    for (const u of undo.reverse()) {
      try { u(); } catch (ignored) { /* the error that matters is e */ }
    }
    throw e;
  }
  return { kind: "full", dataDir, safety, tables: m.tables, modules: m.modules, files: fileCount, keys: keyFiles.map(([n]) => n.slice(5)), asides, warnings };
}

async function restorePart({ archive, config, cur, work, snap, label, only, confirm, allowOtherKeys, now }) {
  const m = archive.manifest;
  cur.prepare("ATTACH DATABASE ? AS snap").run(snap);
  try {
    const sel = resolveSelection(cur, only);
    const theirs = resolveSelection(cur, only, "snap");
    const here = moduleVersions(cur);
    const there = moduleVersions(cur, "snap");
    for (const mod of sel.modules) {
      if ((here[mod] || 0) !== (there[mod] || 0)) {
        throw new BackupError(label + " has " + mod + " at version " + (there[mod] || 0) + " and this database at " + (here[mod] || 0) + ": a part is restored only between the same versions. " +
          "Run the h9web the backup was made with (h9web " + m.h9web + ", the same module versions), restore, then update; or restore the whole backup.", "version");
      }
    }
    if (sel.tables.join() !== theirs.tables.join()) {
      throw new BackupError(label + ": the tables of " + sel.names.join(", ") + " differ from this database's (" + theirs.tables.join(", ") + " / " + sel.tables.join(", ") + "); restore with the same h9web version", "version");
    }
    for (const t of sel.tables) {
      if (columnsOf(cur, t).join() !== columnsOf(cur, t, "snap").join()) throw new BackupError(label + ": the columns of " + t + " differ from this database's; restore with the same h9web version", "version");
    }
    if (sel.virtual.length) throw new BackupError("--only " + only.join(",") + ": " + sel.virtual.join(", ") + " cannot be restored on its own; restore the whole backup", "usage");
    const warnings = keysCheck(archive, config, { secretsMatter: sel.modules.has("core"), dataKeyMatters: sel.modules.has("discord"), allowOtherKeys });
    const before = rowCounts(cur, "main", sel.tables);
    const theirCounts = rowCounts(cur, "snap", sel.tables);
    const lines = [
      "restore " + sel.names.join(", ") + " from " + label + " (made " + m.createdAt + " on " + m.host + ") into " + config.dataDir + ":",
      ...sel.tables.map((t) => "  " + t.padEnd(34) + String(before[t]).padStart(7) + " rows now, " + theirCounts[t] + " in the backup"),
      ...(sel.fileDirs.length ? ["  files: " + sel.fileDirs.join(", ") + " from the backup, in place of the ones here (a key file here that the backup lacks stays)"] : []),
      "  everything else stays as it is; a row whose account is gone is treated as from a deleted account",
      "  first, a safety backup of the data here into " + path.join(config.dataDir, "backups"),
      ...warnings.map((w) => "  WARNING: " + w),
    ];
    if (!(await confirm(lines))) throw new BackupError("nothing was changed", "cancelled");
    const safety = safetyBackup(cur, config, "pre-restore", work, now);
    const staged = path.join(work, "new");
    for (const dir of sel.fileDirs) stageFiles(archive, config, dir, staged);
    const old = path.join(work, "old");
    const undo = [];
    let fixed;
    cur.exec("PRAGMA foreign_keys = OFF");
    try {
      cur.exec("BEGIN IMMEDIATE");
      try {
        for (const t of sel.tables) {
          const cols = columnsOf(cur, t).map(q).join(", ");
          cur.exec(`DELETE FROM main.${q(t)}`);
          cur.exec(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM snap.${q(t)}`);
        }
        fixed = fixReferences(cur, sel.tables);
        checkReferences(cur, fixed.affected);
        for (const dir of sel.fileDirs) {
          const live = path.join(config.dataDir, ...dir.split("/"));
          const aside = path.join(old, ...dir.split("/"));
          makeDir(path.dirname(aside));
          if (fs.existsSync(live)) {
            rename(live, aside);
            undo.push(() => rename(aside, live));
          }
          makeDir(path.dirname(live));
          rename(path.join(staged, ...dir.split("/")), live);
          undo.push(() => rename(live, path.join(staged, ...dir.split("/"))));
        }
        cur.exec("COMMIT");
      } catch (e) {
        try { cur.exec("ROLLBACK"); } catch (ignored) { /* the error that matters is e */ }
        for (const u of undo.reverse()) {
          try { u(); } catch (ignored) { /* the error that matters is e */ }
        }
        throw e;
      }
    } finally {
      cur.exec("PRAGMA foreign_keys = ON");
    }
    return { kind: "part", names: sel.names, tables: sel.tables, before, after: rowCounts(cur, "main", sel.tables), fixed: fixed.report, files: sel.fileDirs, safety, warnings };
  } finally {
    cur.exec("DETACH DATABASE snap");
  }
}

// ---- JSON export and import ----------------------------------------------------------------

function toJson(v) {
  if (v instanceof Uint8Array) return { $base64: Buffer.from(v).toString("base64") };
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  return v;
}

function fromJson(v, where) {
  if (v === null || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v && typeof v === "object" && typeof v.$base64 === "string") return Buffer.from(v.$base64, "base64");
  throw new BackupError("a value in " + where + " is not one a table holds", "usage");
}

// The header pretty, one row per line: readable, and small enough to diff.
function exportText(doc) {
  const head = { ...doc };
  delete head.tables;
  const lines = [JSON.stringify(head, null, 2).replace(/\n}$/, ","), '  "tables": {'];
  const names = Object.keys(doc.tables);
  names.forEach((t, i) => {
    const rows = doc.tables[t];
    const comma = i < names.length - 1 ? "," : "";
    if (!rows.length) {
      lines.push("    " + JSON.stringify(t) + ": []" + comma);
      return;
    }
    lines.push("    " + JSON.stringify(t) + ": [");
    rows.forEach((r, j) => lines.push("      " + JSON.stringify(r) + (j < rows.length - 1 ? "," : "")));
    lines.push("    ]" + comma);
  });
  lines.push("  }", "}");
  return lines.join("\n") + "\n";
}

// The forum or the communities as JSON, accounts named by username: { file, doc }.
export function exportJson({ config, only, out, now = new Date() }) {
  if (!JSON_SELECTIONS.includes(only)) throw new BackupError("export takes --only " + JSON_SELECTIONS.join(" or --only "), "usage");
  const dbFile = path.join(config.dataDir, DB_NAME);
  if (!fs.existsSync(dbFile)) throw new BackupError(dbFile + " does not exist: a wrong --config, or the service has never started", "usage");
  const file = path.resolve(out || path.join(defaultOut(config), "h9web-" + hostOf(config) + "-" + only + "-" + stamp(now) + ".json"));
  keepOutOfCheckout(file, "--out");
  if (fs.existsSync(file)) throw new BackupError(file + " exists already; choose another --out", "usage");
  const db = new DatabaseSync(dbFile);
  let doc;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN");
    try {
      const sel = resolveSelection(db, [only]);
      const module = [...sel.modules][0];
      const leaveOut = JSON_LEAVE_OUT[only] || [];
      const tables = sel.tables.filter((t) => !leaveOut.includes(t));
      const names = new Map(db.prepare("SELECT id, username FROM accounts").all().map((r) => [r.id, r.username]));
      const body = {};
      const accounts = {};
      for (const t of tables) {
        const cols = accountColumns(db, t);
        if (cols.size) accounts[t] = [...cols.keys()];
        body[t] = db.prepare(`SELECT * FROM main.${q(t)}${hasRowid(db, t) ? " ORDER BY rowid" : ""}`).all().map((row) => {
          const o = {};
          for (const [k, v] of Object.entries(row)) o[k] = cols.has(k) && v !== null ? (names.get(v) ?? null) : toJson(v);
          return o;
        });
      }
      doc = {
        format: EXPORT_FORMAT,
        formatVersion: 1,
        selection: only,
        module,
        version: moduleVersions(db)[module],
        h9web: VERSION,
        exportedAt: now.toISOString(),
        host: hostOf(config),
        origin: config.allowedOrigins[0] || null,
        about: "Accounts are named by username; h9web-backup import maps them to the accounts of the site it imports into and makes none.",
        leftOut: leaveOut.filter((t) => sel.tables.includes(t)),
        accountColumns: accounts,
        counts: Object.fromEntries(tables.map((t) => [t, body[t].length])),
        tables: body,
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
  makeDir(path.dirname(file));
  writePrivate(file, exportText(doc));
  return { file, doc };
}

// Replaces the forum or the communities with an export's. Each username maps to the account of
// that name here; a name with no account here is a deleted account: its rows that belong to an
// account (votes, memberships, requests, invites, signatures ...) are left out, and a reference
// to it elsewhere (a post's author, who invited) is cleared. Refuses while the service runs and
// between different module versions; takes a safety backup first; one transaction.
export async function importJson({ config, file, only, confirm = async () => true, now = new Date() }) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new BackupError(file + " cannot be read as JSON: " + e.message, "usage");
  }
  if (!doc || doc.format !== EXPORT_FORMAT || !JSON_SELECTIONS.includes(doc.selection) || !doc.tables || typeof doc.tables !== "object") {
    throw new BackupError(file + " is not an h9web export", "usage");
  }
  if (!(doc.formatVersion <= 1)) throw new BackupError(file + " was made by a newer h9web-backup (format " + doc.formatVersion + ")", "version");
  if (only && only !== doc.selection) throw new BackupError(file + " holds " + doc.selection + ", not " + only, "usage");
  const label = path.basename(file);
  const cur = await claimData(config);
  if (!cur) throw new BackupError("there is no database at " + path.join(config.dataDir, DB_NAME) + ": start the service once (it makes the database), stop it, then import", "usage");
  let work = null;
  try {
    const sel = resolveSelection(cur, [doc.selection]);
    const module = [...sel.modules][0];
    const here = moduleVersions(cur)[module] || 0;
    if (doc.version !== here) {
      throw new BackupError(label + " was exported from " + module + " version " + doc.version + " and this database is at " + here + ": import it with the same h9web version (the export says h9web " + doc.h9web + ")", "version");
    }
    const leaveOut = JSON_LEAVE_OUT[doc.selection] || [];
    const tables = sel.tables.filter((t) => !leaveOut.includes(t));
    const theirs = Object.keys(doc.tables).sort();
    if (theirs.join() !== tables.join()) throw new BackupError(label + " holds the tables " + theirs.join(", ") + "; this database has " + tables.join(", ") + ": use the same h9web version", "version");
    const plan = {};
    for (const t of tables) {
      const cols = columnsOf(cur, t);
      const acc = accountColumns(cur, t);
      const named = [...acc.keys()].sort().join();
      if (named !== (Array.isArray(doc.accountColumns && doc.accountColumns[t]) ? doc.accountColumns[t].slice().sort().join() : "")) {
        throw new BackupError(label + ": the account columns of " + t + " differ from this database's: use the same h9web version", "version");
      }
      if (!Array.isArray(doc.tables[t])) throw new BackupError(label + ": " + t + " is not a list of rows", "usage");
      for (const r of doc.tables[t]) {
        if (!r || typeof r !== "object" || Array.isArray(r)) throw new BackupError(label + ": a row of " + t + " is not an object", "usage");
        for (const k of Object.keys(r)) if (!cols.includes(k)) throw new BackupError(label + ": " + t + " has no column " + k + " here: use the same h9web version", "version");
        for (const c of cols) if (!(c in r)) throw new BackupError(label + ": a row of " + t + " has no " + c, "usage");
      }
      plan[t] = { cols, acc };
    }
    const ids = new Map(cur.prepare("SELECT id, username_key FROM accounts").all().map((r) => [r.username_key, r.id]));
    const missing = new Set();
    for (const t of tables) {
      for (const r of doc.tables[t]) {
        for (const c of plan[t].acc.keys()) {
          if (r[c] !== null && !ids.has(usernameKey(String(r[c])))) missing.add(String(r[c]));
        }
      }
    }
    const before = rowCounts(cur, "main", tables);
    const lines = [
      "import " + doc.selection + " from " + label + " (exported " + doc.exportedAt + " on " + doc.host + ") into " + config.dataDir + ", in place of what is here:",
      ...tables.map((t) => "  " + t.padEnd(34) + String(before[t]).padStart(7) + " rows now, " + doc.tables[t].length + " in the file"),
      ...(doc.leftOut && doc.leftOut.length ? ["  not in the file, left as they are: " + doc.leftOut.join(", ")] : []),
      "  usernames with no account here: " + (missing.size ? missing.size + " (" + [...missing].slice(0, 10).join(", ") + (missing.size > 10 ? ", ..." : "") + "); their rows go as for a deleted account" : "none"),
      "  first, a safety backup of the data here into " + path.join(config.dataDir, "backups"),
    ];
    if (!(await confirm(lines))) throw new BackupError("nothing was changed", "cancelled");
    work = fs.mkdtempSync(path.join(config.dataDir, ".h9import-"));
    const safety = safetyBackup(cur, config, "pre-import", work, now);
    const counts = {};
    let fixed;
    cur.exec("PRAGMA foreign_keys = OFF");
    try {
      cur.exec("BEGIN IMMEDIATE");
      try {
        for (const t of tables) cur.exec(`DELETE FROM main.${q(t)}`);
        for (const t of tables) {
          const { cols, acc } = plan[t];
          const insert = cur.prepare(`INSERT INTO main.${q(t)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
          const c = (counts[t] = { rows: 0, leftOut: 0, cleared: 0 });
          for (const r of doc.tables[t]) {
            let skip = false;
            let cleared = false;
            const values = cols.map((col) => {
              if (!acc.has(col) || r[col] === null) return fromJson(r[col], t + "." + col);
              const id = ids.get(usernameKey(String(r[col])));
              if (id) return id;
              const action = acc.get(col);
              if (action === "CASCADE") skip = true;
              else if (action === "SET NULL") cleared = true;
              else throw new BackupError(t + "." + col + " names " + r[col] + ", who has no account here, and the table keeps no row without one", "failed");
              return null;
            });
            if (skip) {
              c.leftOut++;
              continue;
            }
            insert.run(...values);
            c.rows++;
            if (cleared) c.cleared++;
          }
        }
        fixed = fixReferences(cur, tables);
        checkReferences(cur, fixed.affected);
        cur.exec("COMMIT");
      } catch (e) {
        try { cur.exec("ROLLBACK"); } catch (ignored) { /* the error that matters is e */ }
        throw e;
      }
    } finally {
      cur.exec("PRAGMA foreign_keys = ON");
    }
    return { selection: doc.selection, tables, before, after: rowCounts(cur, "main", tables), counts, fixed: fixed.report, missing: [...missing].sort(), safety };
  } finally {
    cur.close();
    if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
