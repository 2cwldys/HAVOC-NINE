#!/usr/bin/env node
/*
release-prepare.mjs -- what a release needs before its packages are staged: the build number bumped when a shipped file changed, the AMX Mod X
plugins' hashes (the official presets) written from what H9XASH holds, and every place that states the build in step. stage-h9xash.ps1 runs it
(docs\H9_RELEASE.txt, section 5); it can be run by hand too.

    node tools\release-prepare.mjs                    --check: write the presets from H9XASH, check the build against the release
    node tools\release-prepare.mjs --auto --state F   bump the build if a plugin or module of the presets is not the one the state file F says the
                                                      last staged package had (no file: bump), then rebuild and export so the plugins carry it
    node tools\release-prepare.mjs --bump             bump the build now, whatever F says
    node tools\release-prepare.mjs --record --state F write F: the build, the release and every hash of the package that was just staged
    --dry          with --auto or --bump: say what would be done, change nothing
    --no-build     with --auto or --bump: write the new build into ts_matchmode.sma and stop (build.bat and export.bat are for you to run)
    --repo DIR     the git copy: its download page's "Version" notes are written too

  The build is VERSION in ts_matchmode.sma ("1.60": the number after the dot goes up by one, the letter some builds carry goes). It is compiled into
  the plugin, so a bump is a build: build.bat compiles ts_matchmode with it (and writes the presets and tools\release-check.mjs --write), export.bat
  carries the result to the export folders and the git copy; both run here under D:\temp\HEAVY-JOB.lock like every heavy job of this project, and
  refuse nothing but a game that is running from H9XASH. A step that fails puts the old build back. The release (the join gate's date,
  xash3d-h9-patches\overlay\ts\h9_release.txt) is never changed here: it decides which clients a server refuses, so it is a person's choice.
  The hashes are the ones of tools\preset-check.mjs (docs\H9_PRESENCE.txt, 4d): a bump that changes ts_matchmode.amxx changes them, and the admin
  imports the new presets as ever.
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- the parts with no files in them (tools\release_prepare_test.mjs) -----------------------------------------------------------------

/** The build in the text of ts_matchmode.sma, or null. */
export function parseBuild(text) {
  const m = /^#define\s+VERSION\s+"([^"]+)"/m.exec(text);
  return m ? m[1] : null;
}

/** The next build: "1.60" -> "1.61", "1.09" -> "1.10", "1.59b" -> "1.60" (the digits after the dot keep their width unless they outgrow it). */
export function nextBuild(v) {
  const m = /^(\d+)\.(\d+)[a-z]?$/.exec(v);
  if (!m) throw new Error('the build "' + v + '" is not <number>.<number> with at most one letter: change it by hand');
  return m[1] + "." + String(Number(m[2]) + 1).padStart(m[2].length, "0");
}

/** The text of ts_matchmode.sma with its VERSION changed, every other byte (the line ends too) as it was. */
export function withBuild(text, to) {
  const re = /^(#define\s+VERSION\s+")([^"]+)(")/m;
  if (!re.test(text)) throw new Error("no #define VERSION line");
  return text.replace(re, (_all, a, _old, c) => a + to + c);
}

/** {"amxx:ts_matchmode.amxx": sha256, ...} from the text of an official preset. */
export function hashMap(preset) {
  const out = {};
  for (const e of preset.entries || []) out[e.kind + ":" + e.file] = e.sha256;
  return out;
}

/** What differs between two hash maps, by name. */
export function diffHashes(was, now) {
  const changed = [], added = [], removed = [];
  for (const k of Object.keys(now)) {
    if (!(k in was)) added.push(k);
    else if (was[k] !== now[k]) changed.push(k);
  }
  for (const k of Object.keys(was)) if (!(k in now)) removed.push(k);
  return { changed, added, removed, same: !changed.length && !added.length && !removed.length };
}

/** Whether a package of these hashes and this build needs a new build number, given the state of the last staged package. */
export function decide(state, build, hashes) {
  if (!state) return { bump: true, why: "no earlier staged package is recorded" };
  const d = diffHashes(state.hashes || {}, hashes);
  if (d.same) return { bump: false, why: "the plugins and modules are those of build " + state.build, diff: d };
  if (build !== state.build) return { bump: false, why: "build " + build + " is already a new one (the last staged was " + state.build + ")", diff: d };
  return { bump: true, why: d.changed.length + " changed, " + d.added.length + " added and " + d.removed.length + " no longer shipped since build " + state.build, diff: d };
}

// ---- the parts with files in them ------------------------------------------------------------------------------------------------------

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const has = (n) => argv.includes("--" + n);
  const ROOT = path.resolve(opt("root", path.resolve(HERE, "..")));
  const statePath = opt("state", "");
  const repo = opt("repo", "");
  const dry = has("dry");
  const sma = ["ts_matchmode.sma", "src/ts_matchmode.sma", "H9XASH/ts/addons/amxmodx/scripting/ts_matchmode.sma"].map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p)) || path.join(ROOT, "ts_matchmode.sma");
  const h9 = path.join(ROOT, "H9XASH");
  const presetFile = path.join(h9, "presets", "official-preset.json");
  const node = process.execPath;
  const say = (s) => console.log("release-prepare: " + s);
  const die = (s) => { console.error("release-prepare: " + s); process.exit(1); };

  if (!fs.existsSync(sma)) die("no ts_matchmode.sma in " + ROOT);
  const readBuild = () => parseBuild(fs.readFileSync(sma, "latin1")) || die("no #define VERSION line in " + sma);
  const writePresets = () => {
    if (has("no-write-presets")) return;   // for the tests, which have no plugins to hash
    const r = run(node, [path.join(HERE, "preset-check.mjs"), "--write", "--h9xash", h9]);
    if (r.code !== 0) die("preset-check --write failed:\n" + r.out);
  };
  const readPreset = () => hashMap(JSON.parse(fs.readFileSync(presetFile, "utf8")));
  const readState = () => {
    if (!statePath || !fs.existsSync(statePath)) return null;
    try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { die(statePath + " is not JSON: delete it to start again"); }
  };
  const releaseWord = () => {
    const f = path.join(ROOT, "xash3d-h9-patches", "overlay", "ts", "h9_release.txt");
    return fs.existsSync(f) ? (fs.readFileSync(f, "latin1").trim().split(/\s+/)[0] || "") : "";
  };
  const releaseCheck = (write) => {
    const roots = [ROOT].concat(repo ? [path.resolve(repo)] : []);
    for (const r of roots) {
      const rc = run(node, [path.join(HERE, "release-check.mjs"), ...(write ? ["--write"] : []), "--root", r]);
      if (rc.code !== 0) return rc;
    }
    return { code: 0, out: "" };
  };

  // ---- --record: the package was staged
  if (has("record")) {
    if (!statePath) die("--record needs --state FILE");
    if (!fs.existsSync(presetFile)) die("no " + presetFile + " (build.bat writes it)");
    const state = { build: readBuild(), release: releaseWord(), recorded: new Date().toISOString(), hashes: readPreset() };
    fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
    say("recorded build " + state.build + ", release " + state.release + " and " + Object.keys(state.hashes).length + " hashes in " + statePath);
    return;
  }

  const auto = has("auto"), bump = has("bump");
  if (!auto && !bump) {
    // --check
    if (!dry) writePresets();
    const rc = releaseCheck(false);
    process.stdout.write(rc.out);
    if (rc.code !== 0) die("the build and the release do not agree (above)");
    say("build " + readBuild() + ", release " + releaseWord() + ": the presets are written from H9XASH and the places that state the build agree");
    return;
  }

  // ---- --auto and --bump
  if (!dry) writePresets();
  if (!fs.existsSync(presetFile)) die("no " + presetFile + " (build.bat writes it)");
  const before = readBuild();
  const hashes = readPreset();
  const state = readState();
  const why = bump ? { bump: true, why: "asked for" } : decide(state, before, hashes);
  say("build " + before + ": " + (why.bump ? "a new build is needed (" + why.why + ")" : "kept (" + why.why + ")"));
  if (why.diff && !why.diff.same) {
    const names = [...why.diff.changed.map((n) => "changed " + n), ...why.diff.added.map((n) => "new " + n), ...why.diff.removed.map((n) => "gone " + n)];
    for (const n of names.slice(0, 14)) say("  " + n);
    if (names.length > 14) say("  and " + (names.length - 14) + " more");
  }
  if (!why.bump) {
    if (!dry) {
      const rc = releaseCheck(true);
      process.stdout.write(rc.out);
      if (rc.code !== 0) die("the build and the release do not agree (above)");
    }
    return;
  }
  if (!has("no-build") && !(fs.existsSync(path.join(ROOT, "build.bat")) && fs.existsSync(path.join(ROOT, "export.bat")))) {
    die("a new build is made in the source tree: there is no build.bat and export.bat in " + ROOT + " (run this from the source tree, or use --root, or --no-build)");
  }
  const to = nextBuild(before);
  if (dry) { say("would write build " + to + (has("no-build") ? "" : ", run build.bat and export.bat") + " and the notes of the download page; nothing was changed"); return; }

  // a game running from H9XASH has its files locked: build.bat and export.bat would stop in the middle
  const folders = [h9].concat(repo ? [path.join(path.resolve(repo), "H9XASH")] : []).map((p) => p.toLowerCase());
  const ps = run("powershell", ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.ProcessName -match 'HAVOC|xash|hl$|hlds' } | ForEach-Object { try { $_.Path } catch { } }"]);
  for (const p of ps.out.split(/\r?\n/)) {
    const low = p.trim().toLowerCase();
    if (low && folders.some((f) => low.startsWith(f))) die(p.trim() + " is running: close the game first, then run this again");
  }

  const original = fs.readFileSync(sma, "latin1");
  const restore = () => { try { fs.writeFileSync(sma, original, "latin1"); } catch { /* the message names the file */ } };
  fs.writeFileSync(sma, withBuild(original, to), "latin1");
  say("ts_matchmode.sma now says build " + to);
  if (has("no-build")) { say("--no-build: build.bat and export.bat are yours to run now; the presets are not written for it yet"); return; }

  const LOCK = process.env.H9_HEAVY_LOCK || "D:/temp/HEAVY-JOB.lock";
  const LOGS = process.env.H9_LOGDIR || (fs.existsSync("D:/temp") ? "D:/temp" : os.tmpdir());
  const token = "release-prepare pid " + process.pid + " | build.bat and export.bat for build " + to + " | since " + new Date().toISOString();
  let held = false;
  const unlock = () => {
    try { if (held && fs.readFileSync(LOCK, "utf8") === token) fs.unlinkSync(LOCK); } catch { /* gone */ }
    held = false;
  };
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    const t0 = Date.now();
    for (;;) {
      try { fs.writeFileSync(LOCK, token, { flag: "wx" }); held = true; break; }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (Date.now() - t0 > 90 * 60 * 1000) throw new Error("the heavy-job lock (" + LOCK + ") was held for 90 minutes: " + fs.readFileSync(LOCK, "utf8"));
        sleepMs(20000);
      }
    }
    for (const bat of ["build.bat", "export.bat"]) {
      const log = path.join(LOGS, "release-prepare-" + bat.replace(".bat", "") + ".log");
      say("running " + bat + " (log " + log + ")");
      // cmd /s takes the outer pair of quotes off the whole command line, so the batch file's own pair and the log's stay as they are
      const r = spawnSync("cmd.exe", ["/d", "/s", "/c", '""' + path.join(ROOT, bat) + '" < NUL > "' + log + '" 2>&1"'], { cwd: ROOT, windowsVerbatimArguments: true, windowsHide: true });
      const text = fs.existsSync(log) ? fs.readFileSync(log, "latin1") : "";
      if (r.status !== 0) throw new Error(bat + " exited " + r.status + " (see " + log + ")");
      if (bat === "build.bat" && /Failed:\s*[1-9]/.test(text)) throw new Error("build.bat reports plugins that failed (see " + log + ")");
    }
  } catch (e) {
    unlock();
    restore();
    die(e.message + "\nts_matchmode.sma has its build " + before + " again; nothing was recorded.");
  }
  unlock();

  writePresets();
  const rc = releaseCheck(true);
  process.stdout.write(rc.out);
  if (rc.code !== 0) die("the build and the release do not agree (above)");
  const after = readPreset();
  const d = diffHashes(hashes, after);
  say("build " + before + " -> " + to + "; the presets are written (" + d.changed.length + " plugin or module hashes changed by the build" + (d.changed.length ? ": " + d.changed.join(", ") : "") + ")");
  say("the admin imports the new presets (docs\\H9_PRESENCE.txt, 4d) once these plugins are published");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
