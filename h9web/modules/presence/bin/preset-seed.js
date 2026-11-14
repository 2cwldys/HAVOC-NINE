#!/usr/bin/env node
// The official preset's entries, made from a build's own files (modules/presence/preset.js,
// docs\H9_PRESENCE.txt section 4d): what the admin panel's import takes.
//
//   node preset-seed.js --h9xash <H9XASH folder> [--game ts] [--presets Siege,TeamElimination]
//                       [--game-mode <tag|*>] [--live] [--out preset.json] [--note "build 1.54"]
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
// names that the build does not have are listed on standard error and left out. With exactly one tag in
// --presets (or --game-mode) the file also says "gameMode": that mode's list is what the import fills; with
// none it fills the shared list "*", which every game mode accepts.
//
// --import puts the entries straight into the site's database instead (run it as the service's user, with the
// service's config, as h9web-admin.js is: --config FILE or H9WEB_CONFIG; the service must have run once with
// presence migration 15): the same as the admin route, in the audit log as "(command line)". The site reads the
// table again every cacheSeconds, so it needs no restart. --mode add (the default) or replace. Each tag it
// takes is one game mode's list: that tag's plugins, every module and every Metamod plugin, imported as that
// mode's; --live's plugins go on the shared list. --game-mode <tag|*> puts everything on that one list instead
// (* gives the whole build to every mode). replace drops every
// entry that is not optional, from every list, before it imports.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readGameMode, SHARED } from "../preset.js";

function arg(name, flag = false) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return flag ? false : null;
  return flag ? true : process.argv[i + 1] ?? null;
}

const root = arg("h9xash");
if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("usage: node preset-seed.js --h9xash <H9XASH folder> [--game ts] [--presets A,B] [--game-mode tag|*] [--live] [--out file] [--note text]");
  process.exit(2);
}
const game = arg("game") || "ts";
const tags = arg("presets") ? arg("presets").split(",").map((s) => s.trim()).filter(Boolean) : null;
const note = (arg("note") || "").slice(0, 120) || undefined;
const amx = path.join(root, game, "addons", "amxmodx");
const forced = arg("game-mode") === null ? null : readGameMode(arg("game-mode"));
if (arg("game-mode") !== null && forced === null) {
  console.error("--game-mode is a preset tag (letters, digits, _ and -, 24 at most), or * for the shared list");
  process.exit(2);
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const missing = new Set();

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

// The entries of some plugin lists: their plugins and, with modules, every module and every Metamod plugin
// ("kind|file" -> entry, a file once however many lists name it).
function collect(lists, { modules = true } = {}) {
  const entries = new Map();
  const add = (kind, file, from) => {
    const key = kind + "|" + file.toLowerCase();
    if (entries.has(key)) return;
    entries.set(key, { kind, file: path.basename(file), sha256: sha256(from), ...(note ? { note } : {}) });
  };
  for (const list of lists) {
    for (const name of pluginsOf(list)) {
      const file = path.join(amx, "plugins", name);
      if (fs.existsSync(file)) add("amxx", name, file);
      else missing.add(name + " (" + path.basename(list) + ")");
    }
  }
  if (!modules) return entries;
  const dir = path.join(amx, "modules");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (/_amxx(_i386)?\.(dll|so)$/i.test(f)) add("module", f, path.join(dir, f));
  }
  const metaIni = path.join(root, game, "addons", "metamod", "plugins.ini");
  if (fs.existsSync(metaIni)) {
    for (const line of fs.readFileSync(metaIni, "utf8").split(/\r?\n/)) {
      const m = /^\s*(win32|linux)\s+(\S+)/i.exec(line.replace(/;.*$/, ""));
      if (!m) continue;
      const file = path.resolve(root, game, m[2].replace(/\\/g, "/"));
      if (fs.existsSync(file)) add("meta", path.basename(file), file);
      else missing.add(m[2] + " (metamod plugins.ini)");
    }
  }
  return entries;
}

const byName = (a, b) => (a.kind + a.file).localeCompare(b.kind + b.file);
const sortedOf = (entries) => [...entries.values()].sort(byName);

// the build's tags, each with its plugins.<tag>.ini
const tagLists = [];
const presets = path.join(root, "presets");
if (fs.existsSync(presets)) {
  for (const f of fs.readdirSync(presets).sort()) {
    const m = /^plugins\.([^.]+)\.ini$/i.exec(f);
    if (m && (!tags || tags.includes(m[1]))) tagLists.push({ tag: m[1], file: path.join(presets, f) });
  }
}
const liveList = arg("live", true) ? path.join(amx, "configs", "plugins.ini") : null;
if (!tagLists.length && !liveList) {
  console.error("no plugins.<tag>.ini found under " + presets + (tags ? " for " + tags.join(", ") : ""));
  process.exit(2);
}

// What goes where: one list of entries for a file, every tag's own for an import
const everyList = [...tagLists.map((l) => l.file), ...(liveList ? [liveList] : [])];
const all = collect(everyList);
const gameMode = forced !== null ? forced : tags && tags.length === 1 ? tags[0] : null;
const groups = forced !== null
  ? [{ gameMode: forced, entries: all }]
  : [
    ...tagLists.map((l) => ({ gameMode: l.tag, entries: collect([l.file]) })),
    ...(liveList ? [{ gameMode: SHARED, entries: collect([liveList], { modules: !tagLists.length }) }] : []),
  ];

const sorted = sortedOf(all);
const result = JSON.stringify({ mode: arg("mode") || "add", ...(gameMode && gameMode !== SHARED ? { gameMode } : {}), entries: sorted }, null, 1) + "\n";
const out = arg("out");
if (out) fs.writeFileSync(out, result);
else if (!arg("import", true)) process.stdout.write(result);
const counts = { amxx: 0, module: 0, meta: 0 };
for (const e of all.values()) counts[e.kind]++;
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
  if (appliedVersion(db, "presence") < 15) {
    console.error("the database is at presence v" + appliedVersion(db, "presence") + ": start the service with this code once (it migrates to v15), then import.");
    process.exit(1);
  }
  const at = Math.floor(Date.now() / 1000);
  const put = db.prepare(`INSERT INTO presence_preset (kind, file, sha256, game_mode, version, optional, note, added_by, added_at)
    VALUES (?, ?, ?, ?, NULL, 0, ?, NULL, ?)
    ON CONFLICT (kind, file, sha256, game_mode) DO UPDATE SET note = excluded.note`);
  let rows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (mode === "replace") db.prepare("DELETE FROM presence_preset WHERE optional = 0").run();
    for (const g of groups) {
      for (const e of sortedOf(g.entries)) {
        put.run(e.kind, e.file, e.sha256, g.gameMode, e.note || null, at);
        rows++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const lists = groups.map((g) => (g.gameMode === SHARED ? "shared" : g.gameMode) + " " + g.entries.size).join(", ");
  createAudit({ db, retentionDays: config.admin.auditRetentionDays }).record({
    action: "presence.preset.import", subject: "preset", detail: rows + " file(s) on " + groups.length + " list(s) (" + lists + "), " + mode + " (command line)",
  });
  console.error("imported " + rows + " entries into " + dbFile + " (" + mode + "; " + lists + ")");
}
console.error((out ? "wrote " + out + ": " : "") + all.size + " files (" + counts.amxx + " plugins, " + counts.module + " modules, " + counts.meta + " metamod)" + (missing.size ? "; not in the build: " + [...missing].join(", ") : ""));
