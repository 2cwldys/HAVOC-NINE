#!/usr/bin/env node
/*
linux-sync.mjs -- is H9XASH-linux (the native Linux build) in step with H9XASH and with the sources it is built from?
(docs\LINUX_BUILD_LAYOUT.txt says what the folder is and how the two trees relate.)

    node tools/linux-sync.mjs                 check; exit 0 when everything is in step, 1 when a step or a file is stale
    node tools/linux-sync.mjs --record [steps...]   write H9XASH-linux/INPUTS.json for the steps just built (build-linux.ps1 does this)
    node tools/linux-sync.mjs --baseline      record every step whose inputs are not newer than its libraries (a first record)
    node tools/linux-sync.mjs --dist <dir>    where the ZIPs are (default: dist\ here, else the repository named by export.bat)
    node tools/linux-sync.mjs --quiet         print only what is not in step
    node tools/linux-sync.mjs --json          the result as JSON

It never edits anything but INPUTS.json. What it checks:
  1. BUILDINFO.txt: every library it lists is there with the recorded SHA-256
  2. the files the build derives from H9XASH's own (ts/gameinfo.txt, ts/liblist.gam, ts/addons/metamod/plugins.ini): the Linux copy
     equals H9XASH's once the Linux-only lines are taken out
  3. the Linux counterpart of everything the server configuration loads: each module in AMX Mod X's modules.ini has its
     <name>_amxx_i386.so, each linux line of Metamod's plugins.ini names a file that exists
  4. each build step's inputs (the sources) against INPUTS.json: a step whose sources changed since it was built is stale
  5. the ZIPs in dist: staged after the build, and holding every Linux library of BUILDINFO
Run build-linux.cmd (all steps, or the stale ones plus assemble) and then export.bat and build-linux.cmd -Stage to put it right.
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIN = path.join(ROOT, "H9XASH-linux");
const WIN = path.join(ROOT, "H9XASH");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const QUIET = flag("--quiet");
const JSON_OUT = flag("--json");
const distArg = args.indexOf("--dist") >= 0 ? args[args.indexOf("--dist") + 1] : null;

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const exists = (p) => fs.existsSync(p);
const readText = (p) => fs.readFileSync(p, "latin1").replace(/\r\n/g, "\n");

// the inputs of each build step (relative to ROOT); a directory is hashed by content, skipping build output
const SKIP_DIR = new Set([".git", "build", "build-win32", "build-linux", ".builds", "node_modules", "out", "release_binaries", "binaries", "msvc", "obj"]);
const STEPS = {
  rets: { libs: ["ts/dlls/ts_i386.so"], inputs: ["reTS/CMakeLists.txt", "reTS/cmake", "reTS/dlls", "reTS/game_shared", "reTS/pm_shared", "reTS/common", "reTS/public", "reTS/engine"] },
  metamod: { libs: ["ts/addons/metamod/dlls/metamod.so"], inputs: ["metamod-r/metamod", "metamod-r/CMakeLists.txt"] },
  engine: { libs: ["xashds", "filesystem_stdio.so"], inputs: ["xash3d-h9-patches/patches", "@git:xash3d-fwgs"] },
  amxx: { libs: ["ts/addons/amxmodx/dlls/amxmodx_mm_i386.so", "ts/addons/amxmodx/modules/tsx_amxx_i386.so"], inputs: ["AMXMODX", "linux/dedupe-engine-types.py"] },
  rcbot: { libs: ["rcbot/dlls/rcbot_mm.so"], inputs: ["rcbot-patch/src", "rcbot-patch/rcbot-ts-objectives.patch", "rcbot-patch/rcbot-ts-briefcase.patch"] },
  assemble: { libs: ["BUILDINFO.txt"], inputs: ["H9XASH/ts/gameinfo.txt", "H9XASH/ts/liblist.gam", "H9XASH/ts/addons/metamod/plugins.ini", "linux/h9xash_server.sh", "linux/build-linux.sh", "linux/LICENSE-AMXXEASYHTTP.txt"] },
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || e.name.startsWith("obj-") || e.name.startsWith("msvc")) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
}

// a fingerprint of a step's inputs: SHA-256 over each file's relative path and content
function fingerprint(step) {
  const h = crypto.createHash("sha256");
  let count = 0;
  let newest = 0;
  for (const inp of STEPS[step].inputs) {
    if (inp.startsWith("@git:")) {
      const r = spawnSync("git", ["-C", path.join(ROOT, inp.slice(5)), "rev-parse", "HEAD"], { encoding: "utf8" });
      h.update(inp + ":" + (r.status === 0 ? r.stdout.trim() : "no-git"));
      continue;
    }
    const p = path.join(ROOT, inp);
    if (!exists(p)) { h.update("missing:" + inp); continue; }
    const files = [];
    if (fs.statSync(p).isDirectory()) walk(p, files); else files.push(p);
    files.sort();
    for (const f of files) {
      const fd = fs.openSync(f, "r");
      try {
        const st = fs.fstatSync(fd);
        if (st.size > 40 * 1024 * 1024) continue;
        h.update(path.relative(ROOT, f).replace(/\\/g, "/") + "\0");
        h.update(fs.readFileSync(fd));
        count++;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return { hash: h.digest("hex"), count, newest };
}

const rows = [];
const add = (name, state, detail) => rows.push({ name, state, detail });

function parseBuildInfo() {
  const p = path.join(LIN, "BUILDINFO.txt");
  if (!exists(p)) return null;
  const text = readText(p);
  const libs = [];
  for (const l of text.split("\n")) {
    const m = l.match(/^([0-9a-f]{64})\s+\.\/(\S+)\s+glibc\s+(\S+)\s+(\d+) bytes/);
    if (m) libs.push({ sha: m[1], rel: m[2], glibc: m[3], size: Number(m[4]) });
  }
  const d = text.match(/on (\d{4}-\d{2}-\d{2})/);
  return { libs, date: d ? d[1] : null, mtime: fs.statSync(p).mtimeMs };
}

function recordPath() { return path.join(LIN, "INPUTS.json"); }
function readRecord() { try { return JSON.parse(fs.readFileSync(recordPath(), "utf8")); } catch { return {}; } }

function libsNewest(step) {
  let t = 0;
  for (const rel of STEPS[step].libs) {
    const p = path.join(LIN, rel);
    if (exists(p)) t = Math.max(t, fs.statSync(p).mtimeMs);
  }
  return t;
}

function doRecord(steps, baseline) {
  if (!exists(LIN)) { console.error("no H9XASH-linux folder"); return 1; }
  const rec = readRecord();
  for (const s of steps) {
    if (!STEPS[s]) { console.error("unknown step " + s); return 1; }
    const fp = fingerprint(s);
    if (baseline && fp.newest > libsNewest(s)) {
      console.log("  %s: its sources are newer than its libraries: not recorded (build it)", s);
      continue;
    }
    rec[s] = { fingerprint: fp.hash, files: fp.count, recorded: new Date().toISOString(), how: baseline ? "baseline (sources not newer than the libraries)" : "recorded by the build" };
    console.log("  %s: %d input files, %s", s, fp.count, fp.hash.slice(0, 12));
  }
  fs.writeFileSync(recordPath(), JSON.stringify(rec, null, 1) + "\n");
  console.log("wrote " + recordPath());
  return 0;
}

// ---- the checks ------------------------------------------------------------------------------------------------------------------
function checkLibs(bi) {
  let bad = 0;
  for (const l of bi.libs) {
    const p = path.join(LIN, l.rel);
    if (!exists(p)) { add("library " + l.rel, "FAIL", "listed in BUILDINFO.txt, not in the folder"); bad++; continue; }
    if (sha256(p) !== l.sha) { add("library " + l.rel, "FAIL", "its SHA-256 is not the one BUILDINFO.txt records (a copy or a half-finished build)"); bad++; }
  }
  if (!bad) add("libraries", "ok", bi.libs.length + " libraries, every SHA-256 as BUILDINFO.txt records (built " + (bi.date || "?") + ")");
}

function stripLinux(text) {
  return text.split("\n").filter((l) => !/^;?linux\b/.test(l) && !/^gamedll_linux/.test(l)).join("\n").replace(/\n+$/, "");
}
function checkVariants() {
  for (const rel of ["ts/gameinfo.txt", "ts/liblist.gam", "ts/addons/metamod/plugins.ini"]) {
    const w = path.join(WIN, rel);
    const l = path.join(LIN, rel);
    if (!exists(w)) { add(rel, "warn", "H9XASH has no such file"); continue; }
    if (!exists(l)) { add(rel, "STALE", "H9XASH has it, H9XASH-linux does not: run build-linux.cmd -Steps assemble"); continue; }
    if (stripLinux(readText(w)) === stripLinux(readText(l))) add(rel, "ok", "equals H9XASH's once the Linux-only lines are left out");
    else add(rel, "STALE", "differs from H9XASH's beyond the Linux-only lines: run build-linux.cmd -Steps assemble");
  }
}

function checkCounterparts() {
  const mi = path.join(WIN, "ts/addons/amxmodx/configs/modules.ini");
  if (exists(mi)) {
    const missing = [];
    for (const l of readText(mi).split("\n")) {
      const m = l.trim();
      if (!m || m.startsWith(";") || m.startsWith("//")) continue;
      const name = m.split(/\s+/)[0].replace(/_amxx(\.dll)?$/i, "");
      if (!exists(path.join(LIN, "ts/addons/amxmodx/modules", name + "_amxx_i386.so"))) missing.push(name);
    }
    if (missing.length) add("AMX Mod X modules", "FAIL", "listed in modules.ini, no Linux build: " + missing.join(", "));
    else add("AMX Mod X modules", "ok", "every module of modules.ini has its Linux build");
  }
  const pi = path.join(LIN, "ts/addons/metamod/plugins.ini");
  if (exists(pi)) {
    const missing = [];
    for (const l of readText(pi).split("\n")) {
      const m = l.match(/^linux\s+(\S+)/);
      if (m && !exists(path.join(LIN, "ts", m[1]))) missing.push(m[1]);
    }
    if (missing.length) add("Metamod plugins.ini", "FAIL", "linux lines name files that are not there: " + missing.join(", "));
    else add("Metamod plugins.ini", "ok", "every linux line names a file that exists");
  }
}

function checkSteps(bi) {
  const rec = readRecord();
  if (!Object.keys(rec).length) { add("build inputs", "warn", "no INPUTS.json: run node tools/linux-sync.mjs --baseline (or build-linux.cmd, which records it)"); return; }
  for (const s of Object.keys(STEPS)) {
    if (!rec[s]) { add("step " + s, "warn", "no record (not built since the record exists)"); continue; }
    const fp = fingerprint(s);
    if (fp.hash === rec[s].fingerprint) add("step " + s, "ok", fp.count + " input files unchanged since " + rec[s].recorded.slice(0, 16));
    else add("step " + s, "STALE", "its sources changed since it was built (" + rec[s].recorded.slice(0, 16) + "): build-linux.cmd -Steps " + s + ",assemble");
  }
}

function findDist() {
  if (distArg) return path.resolve(distArg);
  if (exists(path.join(ROOT, "dist"))) return path.join(ROOT, "dist");
  const eb = path.join(ROOT, "export.bat");
  if (exists(eb)) {
    const m = readText(eb).match(/^set "REPO=(.+)"\s*$/m);
    if (m && exists(path.join(m[1], "dist"))) return path.join(m[1], "dist");
  }
  return null;
}
function listZip(zip) {
  const code = "import sys, zipfile\nfor i in zipfile.ZipFile(sys.argv[1]).infolist():\n    print(i.file_size, i.filename)";
  for (const [exe, pre] of [["python", ["-I"]], ["py", ["-3", "-I"]]]) {
    const r = spawnSync(exe, [...pre, "-c", code, zip], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) continue;
    const map = new Map();
    for (const l of r.stdout.split("\n")) {
      const m = l.replace(/\r$/, "").match(/^(\d+) (.+)$/);
      if (m) map.set(m[2].trim(), Number(m[1]));
    }
    return map;
  }
  return null;
}
function checkZips(bi) {
  const dist = findDist();
  if (!dist) { add("ZIPs", "warn", "no dist folder found (--dist <dir>)"); return; }
  for (const [name, needNative] of [["H9XASH-linux-server.zip", true], ["H9XASH-linux.zip", false]]) {
    const z = path.join(dist, name);
    if (!exists(z)) { add(name, "STALE", "not staged: build-linux.cmd -Stage"); continue; }
    const st = fs.statSync(z);
    const where = [];
    if (st.mtimeMs < bi.mtime - 60000) where.push("older than the build (BUILDINFO.txt): stage again");
    const list = listZip(z);
    if (!list) { add(name, "warn", "could not read the ZIP's file list (Python's zipfile through python or py is needed)"); continue; }
    if (needNative) {
      const missing = bi.libs.filter((l) => list.get("H9XASH/" + l.rel) !== l.size).map((l) => l.rel);
      if (missing.length) where.push(missing.length + " libraries missing or of another size, e.g. " + missing.slice(0, 3).join(", "));
    }
    if (!needNative) {
      const native = list.has("H9XASH/xash3d");
      where.push(native ? "native client package" : "Wine/Proton package (no native client: H9XASH-linux holds no xash3d)");
      if (!native) { rows.push({ name, state: where.some((w) => /older|missing/.test(w)) ? "STALE" : "ok", detail: where.join("; ") }); continue; }
    }
    add(name, where.some((w) => /older|missing/.test(w)) ? "STALE" : "ok", where.length ? where.join("; ") : "staged after the build, holds every Linux library");
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------------------
if (flag("--record")) {
  const i = args.indexOf("--record");
  const steps = args.slice(i + 1).filter((a) => !a.startsWith("--"));
  process.exit(doRecord(steps.length ? steps : Object.keys(STEPS), false));
}
if (flag("--baseline")) process.exit(doRecord(Object.keys(STEPS), true));

if (!exists(LIN)) {
  console.log("linux-sync: no H9XASH-linux folder here (it is the build's output: build-linux.cmd makes it)");
  process.exit(0);
}
const bi = parseBuildInfo();
if (!bi) { console.log("linux-sync: H9XASH-linux has no BUILDINFO.txt"); process.exit(1); }
checkLibs(bi);
checkVariants();
checkCounterparts();
checkSteps(bi);
checkZips(bi);

const bad = rows.filter((r) => r.state === "STALE" || r.state === "FAIL").length;
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: bad === 0, rows }, null, 1));
} else {
  console.log("linux-sync: H9XASH-linux against H9XASH and its sources");
  for (const r of rows) {
    if (QUIET && (r.state === "ok")) continue;
    const tag = r.state === "ok" ? " ok  " : r.state === "warn" ? "warn " : r.state === "STALE" ? "STALE" : "FAIL ";
    console.log("  [" + tag + "] " + r.name.padEnd(30) + " " + r.detail);
  }
  console.log(bad ? "\n" + bad + " item(s) not in step: run build-linux.cmd (the steps named above plus assemble), export.bat, then build-linux.cmd -Stage" : "\nin step");
}
process.exit(bad ? 1 : 0);
