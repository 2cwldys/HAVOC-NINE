#!/usr/bin/env node
/*
preset-check.mjs -- the official presets' hashes against the plugins this tree ships (docs\H9_PRESENCE.txt, section 4d).

    node tools\preset-check.mjs                     compare H9XASH\presets\official-preset.json, and one official-preset-<Mode>.json for
                                                    each game mode, with the SHA-256 of the AMX Mod X plugins, modules and Metamod plugins
                                                    H9XASH holds; exit 1 and say what differs
    node tools\preset-check.mjs --write             rewrite the files from what H9XASH holds now (build.bat does this at every build)
    node tools\preset-check.mjs --h9xash <folder>   another H9XASH folder

A server is authenticated (the green chain) only while everything it runs is on the site's allowlist, and the allowlist is made from
these files: an update that changes a plugin, a module or a preset list without the files being rewritten leaves every server that
takes the update reading as modified. official-preset.json holds everything every mode ships. official-preset-<Mode>.json (one for
each presets\plugins.<Mode>.ini: Assault, Siege, TeamElimination) holds what that one mode ships: the plugins its plugins.<Mode>.ini
switches on, every module and every Metamod plugin; the mode's own file is what a server that runs that mode's official preset is
checked against, and says "gameMode": "<Mode>", the list of the site's allowlist its import fills. (The name has a hyphen, not a dot, before the mode: h9_presets.bat takes a name with three dot-parts for a preset
and would copy it over a config.) The entries come from h9web\modules\presence\bin\preset-seed.js, the tool the site's import takes, so
each file is exactly what the admin imports: POST /api/presence/admin/preset/import with the file as the body, or preset-seed.js
--import on the host (docs\H9_PRESENCE.txt 4d). The import itself is the admin's step; this tool and the GitHub workflow
.github\workflows\preset-hash.yml only see to it that the committed files match the committed binaries. A note in an entry (the
build it was made in) is not part of the comparison.
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const write = argv.includes("--write");
const h9xash = path.resolve(opt("h9xash", path.join(ROOT, "H9XASH")));
const presetsDir = path.join(h9xash, "presets");
const seed = path.join(ROOT, "h9web", "modules", "presence", "bin", "preset-seed.js");

// on a GitHub runner: lines for the run's summary page (what the person who sees the red mark reads first)
function summary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n"); } catch { /* the log has it */ }
}

// the build the plugins carry: the version ts_matchmode registers (the first of its copies this tree has)
function buildTag() {
  const sources = [
    path.join(ROOT, "ts_matchmode.sma"),
    path.join(ROOT, "src", "ts_matchmode.sma"),
    path.join(h9xash, "ts", "addons", "amxmodx", "scripting", "ts_matchmode.sma"),
  ];
  for (const p of sources) {
    try {
      const m = /^#define\s+VERSION\s+"([^"]+)"/m.exec(fs.readFileSync(p, "latin1"));
      if (m) return m[1];
    } catch { /* the next copy */ }
  }
  return "";
}

if (!fs.existsSync(seed)) {
  console.error("preset-check: " + seed + " is not there");
  process.exit(2);
}

// the game modes: one for each presets\plugins.<Mode>.ini
const modes = fs.existsSync(presetsDir)
  ? fs.readdirSync(presetsDir).map((f) => /^plugins\.([^.]+)\.ini$/.exec(f)).filter(Boolean).map((m) => m[1]).sort()
  : [];
const sets = [
  { label: "official preset", file: path.join(presetsDir, "official-preset.json"), mode: null },
  ...modes.map((m) => ({ label: "official preset, " + m, file: path.join(presetsDir, "official-preset-" + m + ".json"), mode: m })),
];

const tag = buildTag();
const key = (e) => e.kind + "|" + String(e.file).toLowerCase();
const mapOf = (entries) => new Map((entries || []).map((e) => [key(e), e]));
const short = (h) => String(h).slice(0, 12);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

// the entries the seed tool makes from this tree, for the whole tree or one mode
function generate(set) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-"));
  const generated = path.join(tmpDir, "preset.json");
  const args = [seed, "--h9xash", h9xash, "--out", generated];
  if (set.mode) args.push("--presets", set.mode);
  if (tag) args.push("--note", "build " + tag);
  const run = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (run.status !== 0) {
    console.error("preset-check: preset-seed.js failed (" + run.status + ")\n" + (run.stderr || run.stdout || ""));
    process.exit(2);
  }
  if (run.stderr && run.stderr.trim()) console.error(run.stderr.trim());
  const fresh = JSON.parse(fs.readFileSync(generated, "utf8"));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return fresh;
}

function compare(set, fresh) {
  let committed = null;
  if (fs.existsSync(set.file)) {
    try { committed = JSON.parse(fs.readFileSync(set.file, "utf8")); } catch (e) { console.error("preset-check: " + set.file + " does not parse: " + e.message); }
  }
  const was = mapOf(committed && committed.entries);
  const now = mapOf(fresh.entries);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [k, e] of now) {
    if (!was.has(k)) added.push(e);
    else if (was.get(k).sha256 !== e.sha256) changed.push({ file: e.file, kind: e.kind, from: was.get(k).sha256, to: e.sha256 });
  }
  for (const [k, e] of was) if (!now.has(k)) removed.push(e);
  const same = !changed.length && !added.length && !removed.length && committed !== null;
  return { committed, now, changed, added, removed, same };
}

function report(set, r, where) {
  console.log(set.label + " (" + where + "): " + r.now.size + " files, " + r.changed.length + " changed, " + r.added.length + " new, " + r.removed.length + " no longer shipped");
  for (const c of r.changed) console.log("  changed  " + c.kind.padEnd(6) + " " + c.file + "  " + short(c.from) + " -> " + short(c.to));
  for (const e of r.added) console.log("  new      " + e.kind.padEnd(6) + " " + e.file + "  " + short(e.sha256));
  for (const e of r.removed) console.log("  removed  " + e.kind.padEnd(6) + " " + e.file);
}

const results = sets.map((set) => {
  const fresh = generate(set);
  return { set, fresh, ...compare(set, fresh) };
});

if (write) {
  fs.mkdirSync(presetsDir, { recursive: true });
  for (const r of results) {
    fs.writeFileSync(r.set.file, JSON.stringify({ mode: "add", ...(r.set.mode ? { gameMode: r.set.mode } : {}), entries: r.fresh.entries }, null, 2) + "\n");
    if (r.same) console.log(r.set.label + ": " + r.now.size + " files, nothing changed since the committed file" + (tag ? " (build " + tag + ")" : ""));
    else report(r.set, r, "written" + (tag ? ", build " + tag : ""));
    console.log("  " + r.set.file);
  }
  console.log("  Import these into the site (docs/H9_PRESENCE.txt 4d) once these plugins are published.");
  process.exit(0);
}

const stale = results.filter((r) => !r.same);
if (!stale.length) {
  for (const r of results) console.log(r.set.label + ": " + r.now.size + " files, every hash is the one the plugins carry");
  process.exit(0);
}

for (const r of stale) {
  if (r.committed === null) console.error(r.set.label + ": " + rel(r.set.file) + " is missing or unreadable");
  report(r.set, r, "out of date");
}
console.error("\nThe official preset files do not match the plugins, modules or Metamod plugins in " + rel(h9xash) + ".");
console.error("Run build.bat (or: node tools/preset-check.mjs --write), commit " + stale.map((r) => rel(r.set.file)).join(", ") + " with the binaries,");
console.error("and have an admin import them into the site (docs/H9_PRESENCE.txt, section 4d).");
if (process.env.GITHUB_ACTIONS) {
  const rows = [];
  for (const r of stale) {
    const where = rel(r.set.file);
    console.log("::error file=" + where + "::The official preset does not match the plugins, modules or Metamod plugins this change ships: run build.bat (or node tools/preset-check.mjs --write) and commit " + where + ".");
    for (const c of r.changed) rows.push("| `" + where + "` | changed | " + c.kind + " | `" + c.file + "` | `" + short(c.from) + "` | `" + short(c.to) + "` |");
    for (const e of r.added) rows.push("| `" + where + "` | new | " + e.kind + " | `" + e.file + "` | | `" + short(e.sha256) + "` |");
    for (const e of r.removed) rows.push("| `" + where + "` | no longer shipped | " + e.kind + " | `" + e.file + "` | | |");
    if (r.committed === null) rows.push("| `" + where + "` | file missing | | | | |");
  }
  summary([
    "### The official presets are out of date",
    "",
    "`" + stale.map((r) => rel(r.set.file)).join("`, `") + "` does not hold the SHA-256 of what this change ships.",
    "",
    ...(rows.length ? ["| file | | kind | file | committed | now |", "|---|---|---|---|---|---|", ...rows.slice(0, 60), ...(rows.length > 60 ? ["| ... | | | " + (rows.length - 60) + " more | | |"] : [])] : []),
    "",
    "**To fix it:** run `build.bat` (it rewrites the files), or `node tools/preset-check.mjs --write`, and commit them with the binaries. If you did not build locally, the files made from this commit are attached to this run as the artifact `official-preset`: put them in `H9XASH/presets/`.",
    "",
    "After the release is published, an admin imports the files into the site (`docs/H9_PRESENCE.txt`, section 4d). Nothing here changes the site.",
  ]);
}
process.exit(1);
