#!/usr/bin/env node
// The official preset's entries, made from a build's own files (modules/presence/preset.js,
// docs\H9_PRESENCE.txt section 4d): what the admin panel's import takes.
//
//   node preset-seed.js --h9xash <H9XASH folder> [--game ts] [--presets Siege,TeamElimination]
//                       [--live] [--out preset.json] [--note "build 1.54"]
//                       [--import [--config FILE] [--mode add|replace]]
//
//   AMX Mod X plugins   every plugin the build's presets\plugins.<tag>.ini switch on (--presets names
//                       the tags; every tag found by default; --live adds the plugins.ini now in
//                       <game>\addons\amxmodx\configs), hashed from <game>\addons\amxmodx\plugins
//   AMX Mod X modules   every *_amxx.dll, *_amxx.so and *_amxx_i386.so in <game>\addons\amxmodx\modules
//   Metamod plugins     every file <game>\addons\metamod\plugins.ini names that is there
//
// It writes { "mode": "add", "entries": [...] } to --out (standard output without it): send that with
//   POST /api/presence/admin/preset/import        (signed in as an admin, Content-Type: application/json)
// "add" keeps the hashes of older builds official; use "replace" in the file to drop them. Files a preset
// names that the build does not have are listed on standard error and left out.
//
// --import puts the entries straight into the site's database instead (run it as the service's user, with the
// service's config, as h9web-admin.js is: --config FILE or H9WEB_CONFIG; the service must have run once with
// presence migration 12): the same as the admin route, in the audit log as "(command line)". The site reads the
// table again every cacheSeconds, so it needs no restart. --mode add (the default) or replace.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function arg(name, flag = false) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return flag ? false : null;
  return flag ? true : process.argv[i + 1] ?? null;
}

const root = arg("h9xash");
if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("usage: node preset-seed.js --h9xash <H9XASH folder> [--game ts] [--presets A,B] [--live] [--out file] [--note text]");
  process.exit(2);
}
const game = arg("game") || "ts";
const tags = arg("presets") ? arg("presets").split(",").map((s) => s.trim()).filter(Boolean) : null;
const note = (arg("note") || "").slice(0, 120) || undefined;
const amx = path.join(root, game, "addons", "amxmodx");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const entries = new Map();
const missing = [];
function add(kind, file, from) {
  const key = kind + "|" + file.toLowerCase();
  if (entries.has(key)) return;
  entries.set(key, { kind, file: path.basename(file), sha256: sha256(from), ...(note ? { note } : {}) });
}

// the lines of a plugins.ini that switch a plugin on: "name.amxx" before any ";" (a trailing "debug" is not a name)
function pluginsOf(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const text = line.replace(/;.*$/, "").trim();
    const m = /^([^\s]+\.amxx)(\s|$)/i.exec(text);
    if (m) out.push(m[1]);
  }
  return out;
}

const lists = [];
const presets = path.join(root, "presets");
if (fs.existsSync(presets)) {
  for (const f of fs.readdirSync(presets)) {
    const m = /^plugins\.([^.]+)\.ini$/i.exec(f);
    if (m && (!tags || tags.includes(m[1]))) lists.push(path.join(presets, f));
  }
}
if (arg("live", true)) lists.push(path.join(amx, "configs", "plugins.ini"));
if (!lists.length) {
  console.error("no plugins.<tag>.ini found under " + presets + (tags ? " for " + tags.join(", ") : ""));
  process.exit(2);
}
for (const list of lists) {
  for (const name of pluginsOf(list)) {
    const file = path.join(amx, "plugins", name);
    if (fs.existsSync(file)) add("amxx", name, file);
    else missing.push(name + " (" + path.basename(list) + ")");
  }
}

const modules = path.join(amx, "modules");
if (fs.existsSync(modules)) {
  for (const f of fs.readdirSync(modules)) if (/_amxx(_i386)?\.(dll|so)$/i.test(f)) add("module", f, path.join(modules, f));
}

const metaIni = path.join(root, game, "addons", "metamod", "plugins.ini");
if (fs.existsSync(metaIni)) {
  for (const line of fs.readFileSync(metaIni, "utf8").split(/\r?\n/)) {
    const m = /^\s*(win32|linux)\s+(\S+)/i.exec(line.replace(/;.*$/, ""));
    if (!m) continue;
    const file = path.resolve(root, game, m[2].replace(/\\/g, "/"));
    if (fs.existsSync(file)) add("meta", path.basename(file), file);
    else missing.push(m[2] + " (metamod plugins.ini)");
  }
}

const sorted = [...entries.values()].sort((a, b) => (a.kind + a.file).localeCompare(b.kind + b.file));
const result = JSON.stringify({ mode: arg("mode") || "add", entries: sorted }, null, 1) + "\n";
const out = arg("out");
if (out) fs.writeFileSync(out, result);
else if (!arg("import", true)) process.stdout.write(result);
const counts = { amxx: 0, module: 0, meta: 0 };
for (const e of entries.values()) counts[e.kind]++;
if (arg("import", true)) {
  const mode = arg("mode") || "add";
  if (mode !== "add" && mode !== "replace") {
    console.error("--mode is add or replace");
    process.exit(2);
  }
  const { loadConfig } = await import("../../../lib/config.js");
  const { openDatabase, appliedVersion } = await import("../../../lib/db.js");
  const { createAudit } = await import("../../../lib/audit.js");
  const config = loadConfig(arg("config") || process.env.H9WEB_CONFIG);
  const dbFile = path.join(config.dataDir, "h9web.db");
  if (!fs.existsSync(dbFile)) {
    console.error(dbFile + " does not exist. Start the service once first; it makes the database.");
    process.exit(1);
  }
  const db = openDatabase(dbFile);
  if (appliedVersion(db, "presence") < 12) {
    console.error("the database is at presence v" + appliedVersion(db, "presence") + ": start the service with this code once (it migrates to v12), then import.");
    process.exit(1);
  }
  const at = Math.floor(Date.now() / 1000);
  const put = db.prepare(`INSERT INTO presence_preset (kind, file, sha256, version, optional, note, added_by, added_at)
    VALUES (?, ?, ?, NULL, 0, ?, NULL, ?)
    ON CONFLICT (kind, file, sha256) DO UPDATE SET note = excluded.note`);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (mode === "replace") db.prepare("DELETE FROM presence_preset WHERE optional = 0").run();
    for (const e of sorted) put.run(e.kind, e.file, e.sha256, e.note || null, at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  createAudit({ db, retentionDays: config.admin.auditRetentionDays }).record({
    action: "presence.preset.import", subject: "preset", detail: sorted.length + " file(s), " + mode + " (command line)",
  });
  console.error("imported " + sorted.length + " files into " + dbFile + " (" + mode + ")");
}
console.error((out ? "wrote " + out + ": " : "") + entries.size + " files (" + counts.amxx + " plugins, " + counts.module + " modules, " + counts.meta + " metamod)" + (missing.length ? "; not in the build: " + missing.join(", ") : ""));
