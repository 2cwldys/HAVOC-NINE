#!/usr/bin/env node
/*
webclient-sync.mjs -- keeps the web client in step with the engine and the client library, so that a change to either
is never left native-only.

    node tools\webclient-sync.mjs             bring the web client up to date, whatever that takes
    node tools\webclient-sync.mjs --check     build nothing; exit 1 and say what is out of date (for the end of a piece of work)
    node tools\webclient-sync.mjs --watch     stay running and sync when something changed and stayed quiet for 20 seconds
    node tools\webclient-sync.mjs --force     build even when nothing changed
    node tools\webclient-sync.mjs --check --repo-check   also check the git copy of the engine tree, patches and client library against the record
    node tools\webclient-sync.mjs --stage     lay the stage out again (the game's files changed) without building

The browser build and the native game are built from the same patched tree: xash3d-fwgs with xash3d-h9-patches (H9's patch
chain, applied to both) and webassembly-patch (the browser port). Both patch sets, the engine tree, the client library
(reTS) and the browser builds (webclient-bin) are in git. What nothing did, until this, was rebuild the browser engine when
the patches changed, and nothing noticed code that exists only in the native build. This does both:

  1. fingerprints the inputs of the browser build: the patched engine tree, the patch chain as xash.bat applies it, the
     client library's sources, and the build scripts. webclient-bin\INPUTS.json holds what the last build was made from.
  2. refuses (exit 3) native-only code with no answer: a patch that compiles code out of the browser build
     (#if !XASH_EMSCRIPTEN) needs an entry in xash3d-h9-patches\WEB_PARITY.json saying what the page does instead (or why
     nothing is needed), and every Module.* object an engine patch calls into must be handed over by the page's engine
     config (havoc9.org\webclient\client.js).
  3. builds the browser engine and client library when an input changed (build-webclient.ps1: about 4 minutes, compile
     jobs at BelowNormal priority), lays the stage out from H9XASH, copies webclient-bin, the stage, the web tools and the
     page files into the git mirror, publishes the page files to this PC's local site, and runs the smoke test
     (tools\webclient-test\smoke.mjs) in a headless browser.
  4. writes webclient-bin\INPUTS.json. Nothing here commits.

It is a heavy job: it takes D:\temp\HEAVY-JOB.lock for the build (--lock-held when the caller holds it already, --wait <min>
to wait for another holder instead of giving up). Exit codes: 0 up to date, 1 out of date (--check), 3 parity problems,
4 smoke test failed, 5 lock held, 6 a build step failed.
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "webclient-build");
const BIN = path.join(ROOT, "webclient-bin");
const STAGE = path.join(OUT, "stage");
const RECORD = path.join(BIN, "INPUTS.json");
const CACHE = path.join(OUT, ".sync-cache.json");
const PAGE = path.join(ROOT, "havoc9.org", "webclient");
const LOCK = process.env.H9_HEAVY_LOCK || "D:\\temp\\HEAVY-JOB.lock";
const REPO = process.env.H9_REPO || "D:\\GIT Storage\\ts_h9_team_elimination";
const HL = process.env.H9_HL || "D:\\SteamLibrary\\steamapps\\common\\Half-Life";
const LOCAL = process.env.H9WEB_LOCAL || path.join(process.env.LOCALAPPDATA || os.homedir(), "h9web-local");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JOBS = Number(opt("jobs", "4"));
const repo = opt("repo", REPO);
// the H9XASH the stage is laid out from: the git copy's when there is one (the game the user plays), else this tree's
const stageH9xash = () => (fs.existsSync(path.join(repo, "H9XASH")) ? path.join(repo, "H9XASH") : path.join(ROOT, "H9XASH"));

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (t = "") => console.log(t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---- fingerprints ------------------------------------------------------------------------------------------------

const glob = (g) => new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
const TEXT = /\.(c|h|cpp|hpp|cc|cmake|in|js|mjs|json|py|ps1|bat|cmd|txt|patch|cfg|ini|html|css|def|rc|sh|vcxproj|sln|toml|yml|yaml)$/i;
const BINARY = /\.(dll|exe|pdb|obj|lib|o|a|so|ilk|exp|zip|7z|png|jpg|tga|wav|mp3)$/i;

const GROUPS = {
  // the tree build-webclient.ps1 copies and builds with waf, minus what it leaves out
  engine: {
    root: "xash3d-fwgs",
    dirSkip: (name, rel) => rel === "build" || [".git", "build-web", "waf3-*", "__pycache__"].some((g) => glob(g).test(name)),
    // what the build does not read: ignore files (export leaves them out of the mirror), notes and sounds
    fileSkip: (name) => [".git", ".gitignore", ".lock-waf*", "*.bak_*", "*.md", "*.wav"].some((g) => glob(g).test(name)),
  },
  // the client library's sources: reTS minus its own native build output
  client: {
    root: "reTS",
    dirSkip: (name, rel) => name === ".git" || (!rel.includes("/") && (/^build/i.test(name) || ["binaries", "release_binaries"].includes(name))),
    fileSkip: (name) => /\.(log|md)$/i.test(name) || /\.bak_/i.test(name) || BINARY.test(name),
  },
};

function* walk(dir, rel, g) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) {
      if (!g.dirSkip(e.name, r)) yield* walk(path.join(dir, e.name), r, g);
    } else if (e.isFile() && !g.fileSkip(e.name, r)) yield r;
  }
}

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (e) { /* none yet */ }
const seen = {};

/** sha-256 of a file, line endings normalised for text so a clone with CRLF hashes as the original; cached by size and time */
function fileSha(full, key) {
  const st = fs.statSync(full);
  const hit = cache[key];
  if (hit && hit[0] === st.size && hit[1] === st.mtimeMs) { seen[key] = hit; return hit[2]; }
  let buf = fs.readFileSync(full);
  if (TEXT.test(full)) buf = Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  const sum = sha256(buf);
  seen[key] = [st.size, st.mtimeMs, sum];
  return sum;
}

const hashLines = (lines) => sha256(lines.sort().join("\n"));

/** the patches xash.bat applies, in its order: [{ name, file }] */
function chain() {
  const bat = fs.readFileSync(path.join(ROOT, "xash3d-h9-patches", "xash.bat"), "latin1");
  const out = [];
  for (const m of bat.matchAll(/call :patch\s+"[^"]+"\s+"([^"]+\.patch)"/gi)) {
    const p = m[1].replace(/%XASH%/gi, "xash3d-h9-patches").replace(/%WEB%/gi, "webassembly-patch").replace(/%TSM%\\?/gi, "");
    const file = path.join(ROOT, ...p.split(/[\\/]/));
    out.push({ name: path.basename(p), file });
  }
  return out;
}

function fingerprint() {
  const groups = {}, counts = {};
  for (const [name, g] of Object.entries(GROUPS)) {
    const lines = [];
    for (const rel of walk(path.join(ROOT, g.root), "", g)) lines.push(rel + "\0" + fileSha(path.join(ROOT, g.root, rel), name + ":" + rel));
    groups[name] = hashLines(lines);
    counts[name] = lines.length;
  }
  // the chain: each patch's text, in xash.bat's order
  const patches = chain();
  groups.patches = sha256(patches.map((p) => p.name + "\0" + (fs.existsSync(p.file) ? fileSha(p.file, "patch:" + p.name) : "missing")).join("\n"));
  counts.patches = patches.length;
  const own = (rels) => sha256(rels.map((r) => r + "\0" + (fs.existsSync(path.join(ROOT, r)) ? fileSha(path.join(ROOT, r), "own:" + r) : "missing")).join("\n"));
  // what the build is made with: the toolchain pins and the packer of webclient-bin
  groups.builder = own(["build-webclient.ps1", "tools/make_webclient_bin.py"]);
  // what the stage is made with: its packer, and the config.cfg a new player starts with (ts\config.stock.cfg of the game it lays out)
  const stock = path.join(stageH9xash(), "ts", "config.stock.cfg");
  groups.stager = sha256(own(["tools/make_webclient_game.py", "tools/webclient_leave_out.txt"]) + "\0" + (fs.existsSync(stock) ? fileSha(stock, "stock:" + stock) : "missing"));
  // the page's own files: not a build input; the page is published and tested when they change
  const pages = [];
  for (const f of fs.existsSync(PAGE) ? fs.readdirSync(PAGE) : []) {
    const full = path.join(PAGE, f);
    if (fs.statSync(full).isFile() && pageFile(f)) pages.push("havoc9.org/webclient/" + f);
  }
  groups.pages = own(pages.sort());
  cache = seen;
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(seen)); } catch (e) { /* the next run hashes again */ }
  return { groups, counts };
}

const pageFile = (f) => f !== "DEPLOY.txt" && !/\.bak/i.test(f) && !/\.zip$/i.test(f);

const readRecord = () => { try { return JSON.parse(fs.readFileSync(RECORD, "utf8")); } catch (e) { return null; } };

/**
 * The git mirror's own copy of this program, run against the mirror: its engine tree, patch chain, client library and build
 * scripts against the record it holds. Up to date there means the mirror carries what the browser build was made from.
 */
function mirrorStatus() {
  const script = path.join(repo, "tools", "webclient-sync.mjs");
  if (path.resolve(repo) === ROOT || !fs.existsSync(script)) return null;
  const r = spawnSync(process.execPath, [script, "--check"], { cwd: repo, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, lines: (r.stdout || "").split(/\r?\n/).filter(Boolean), exit: r.status };
}

// ---- parity: native-only code needs an answer ---------------------------------------------------------------------

const RUNTIME = new Set(["FS", "ccall", "cwrap", "callMain", "UTF8ToString", "stringToUTF8", "lengthBytesUTF8", "arguments", "print", "printErr",
  "locateFile", "canvas", "preRun", "postRun", "onExit", "onAbort", "onRuntimeInitialized", "wasmExports", "asm"]);

function parity() {
  const problems = [];
  let manifest = { patches: {} };
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "xash3d-h9-patches", "WEB_PARITY.json"), "utf8")); }
  catch (e) { problems.push("xash3d-h9-patches\\WEB_PARITY.json is missing or not JSON: " + e.message); }
  const pageJs = fs.existsSync(path.join(PAGE, "client.js")) ? fs.readFileSync(path.join(PAGE, "client.js"), "latin1") : "";
  const cfg = /const config = \{([\s\S]*?)\n    return config;/.exec(pageJs);
  const pageKeys = new Set(cfg ? [...cfg[1].matchAll(/^ {6}([A-Za-z_]\w*):/gm)].map((m) => m[1]) : []);
  if (!cfg) problems.push("havoc9.org\\webclient\\client.js: engineConfig's `const config = {...}` was not found, so the Module.* objects it hands over cannot be checked");
  const known = new Set(Object.keys(manifest.patches));
  const used = new Map(), self = new Set();
  const names = new Set();
  for (const p of chain()) {
    names.add(p.name);
    if (!fs.existsSync(p.file)) { problems.push(`${p.name}: xash.bat applies it but it is not there`); continue; }
    const added = fs.readFileSync(p.file, "latin1").split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++") && !/^\+\s*(\/\/|\*|\/\*)/.test(l));
    // the browser port's own patches decide what is compiled out; H9's patches must say what stands in its place
    const h9 = p.file.includes("xash3d-h9-patches");
    const nativeOnly = h9 ? added.filter((l) => /^\+\s*#\s*(?:if|elif)\b.*!\s*XASH_EMSCRIPTEN/.test(l)).length : 0;
    if (nativeOnly && !known.has(p.name)) {
      problems.push(`${p.name}: ${nativeOnly} native-only block(s) (#if !XASH_EMSCRIPTEN) and no entry in xash3d-h9-patches\\WEB_PARITY.json -- say what the web client does in their place (bridged, page-fed) or why nothing is needed (native-only)`);
    }
    for (const l of added) {
      for (const m of l.matchAll(/Module\.([A-Za-z_]\w*)/g)) { if (!used.has(m[1])) used.set(m[1], p.name); }
      for (const m of l.matchAll(/Module\.([A-Za-z_]\w*)\s*=[^=]/g)) self.add(m[1]);
    }
  }
  for (const [name, patch] of used) {
    if (!pageKeys.has(name) && !self.has(name) && !RUNTIME.has(name)) {
      problems.push(`${patch}: the engine calls into Module.${name}, which neither the page's engine config nor a patch provides`);
    }
  }
  for (const [name, e] of Object.entries(manifest.patches)) {
    if (!names.has(name)) { problems.push(`WEB_PARITY.json names ${name}, which xash.bat does not apply`); continue; }
    if (!["bridged", "page-fed", "native-only"].includes(e.status)) problems.push(`WEB_PARITY.json: ${name} has no valid status`);
    if (e.status === "native-only" && !e.why) problems.push(`WEB_PARITY.json: ${name} is native-only and gives no reason`);
    if (e.status !== "native-only") {
      for (const m of e.markers || []) if (!pageJs.includes(m)) problems.push(`WEB_PARITY.json: ${name} is ${e.status}, but client.js has no "${m}"`);
      if (!(e.markers || []).length) problems.push(`WEB_PARITY.json: ${name} is ${e.status} and names no marker in client.js`);
    }
  }
  return problems;
}

// ---- the plan -----------------------------------------------------------------------------------------------------

const BUILD_INPUTS = ["engine", "patches", "client", "builder"];

function plan(now, rec) {
  const changed = (g) => !rec || !rec.inputs || rec.inputs[g] !== now.groups[g];
  const why = BUILD_INPUTS.filter(changed);
  const stageMissing = !fs.existsSync(path.join(STAGE, "manifest.json"));
  const out = {
    build: flag("force") || why.length > 0,
    stage: flag("force") || flag("stage") || why.length > 0 || changed("stager") || stageMissing,
    test: flag("force") || flag("stage") || why.length > 0 || changed("pages") || changed("stager"),
    why,
    stager: changed("stager"),
    pages: changed("pages"),
  };
  return out;
}

const describe = (p) => {
  const parts = [];
  if (p.why.length) parts.push("the browser build is out of date: " + p.why.join(", ") + " changed since webclient-bin was built");
  if (p.stager) parts.push("the stage's packer or its starting config changed");
  if (p.pages) parts.push("the page's files changed since the last test");
  return parts;
};

// ---- the heavy job's lock --------------------------------------------------------------------------------------------

function takeLock(what) {
  if (flag("lock-held")) return true;
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  } catch (e) {
    return true; // no folder for a lock here (a clone on another machine): nothing else shares it
  }
  try {
    const fd = fs.openSync(LOCK, "wx");
    fs.writeSync(fd, `webclient-sync (${what}) pid ${process.pid} at ${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    return false;
  }
}
const dropLock = () => { if (!flag("lock-held")) { try { fs.unlinkSync(LOCK); } catch (e) { /* gone */ } } };

async function getLock(what) {
  const waitMs = Number(opt("wait", "0")) * 60000;
  const until = Date.now() + waitMs;
  for (;;) {
    if (takeLock(what)) return true;
    let holder = "";
    try { holder = fs.readFileSync(LOCK, "utf8").trim(); } catch (e) { /* gone again */ }
    if (Date.now() >= until) { say(`${LOCK} is held (${holder}); not starting a heavy job while another holds it. Use --wait <minutes> to wait.`); return false; }
    say(`${stamp()} ${LOCK} is held (${holder}); checking again in 60 s`);
    await sleep(60000);
  }
}

// ---- the steps -----------------------------------------------------------------------------------------------------

function run(cmd, args, { cwd = ROOT, log, echo = true, below = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    if (below) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not allowed: normal priority */ } }
    const sink = log ? fs.createWriteStream(log, { flags: "a" }) : null;
    let tail = [];
    const onData = (d) => {
      const text = d.toString();
      if (sink) sink.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line); if (tail.length > 30) tail.shift();
        if (echo && /^===|^\s+\S.* \d+ s$|\berror\b|\bFAILED\b|\bfatal\b|^\[ERROR\]/i.test(line)) say("    " + line.trim().slice(0, 160));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { tail.push(String(e)); resolve({ code: -1, tail }); });
    child.on("close", (code) => { if (sink) sink.end(); resolve({ code, tail }); });
  });
}

async function build() {
  say(`${stamp()} building the browser engine and client library (build-webclient.ps1, ${JOBS} jobs, below normal priority; about 4 minutes)`);
  const log = path.join(OUT, "sync-build.log");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(log, "");
  const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "build-webclient.ps1"), "-Jobs", String(JOBS), "-NoStage", "-UpdateTracked"], { log });
  if (r.code !== 0) { say("the build failed (exit " + r.code + "); the log is " + log + ":\n  " + r.tail.slice(-12).join("\n  ")); return false; }
  return true;
}

async function stage() {
  const h9xash = stageH9xash();
  say(`${stamp()} laying out the stage from ${h9xash}`);
  const args = ["-3", path.join(ROOT, "tools", "make_webclient_game.py"), "--h9xash", h9xash, "--out", STAGE, "--replace"];
  if (fs.existsSync(path.join(HL, "valve"))) args.push("--hl-valve", path.join(HL, "valve"), "--write-leave-out");
  const r = await run("py", args, { log: path.join(OUT, "sync-stage.log") });
  if (r.code !== 0) { say("the stage failed (exit " + r.code + "):\n  " + r.tail.slice(-10).join("\n  ")); return false; }
  return true;
}

function robo(from, to, extra = []) {
  const r = spawnSync("robocopy", [from, to, ...extra, "/NJH", "/NJS", "/NDL", "/NFL", "/NP"], { windowsHide: true });
  return r.status !== null && r.status < 8;
}

/** the mirror gets what the web client is made of and from; the mirror's own commits are the user's */
function copyToRepo() {
  if (path.resolve(repo) === ROOT) return; // run from the repo itself: it is where everything already is
  if (!fs.existsSync(repo)) { say(`  no git mirror at ${repo}: nothing copied`); return; }
  const tools = ["make_webclient_game.py", "make_webclient_bin.py", "serve_webclient.py", "webclient_leave_out.txt", "webclient-sync.mjs"];
  const steps = [
    ["webclient-bin", () => robo(BIN, path.join(repo, "webclient-bin"), ["/MIR", "/XF", "*.bak_*"])],
    ["tools", () => robo(path.join(ROOT, "tools"), path.join(repo, "tools"), tools)],
    ["tools\\webclient-test", () => robo(path.join(ROOT, "tools", "webclient-test"), path.join(repo, "tools", "webclient-test"), ["/E"])],
    ["stage", () => robo(STAGE, path.join(repo, "webclient-build", "stage"), ["/MIR"])],
    ["page files", () => robo(PAGE, path.join(repo, "havoc9.org", "webclient"), ["/XF", "*.bak_*", "*.zip"])],
    ["parity manifest", () => robo(path.join(ROOT, "xash3d-h9-patches"), path.join(repo, "xash3d-h9-patches"), ["WEB_PARITY.json"])],
    ["build scripts", () => robo(ROOT, repo, ["build-webclient.ps1", "build-webclient.cmd", "webclient-sync.cmd"])],
    ["docs\\BUILDING.txt", () => robo(path.join(ROOT, "docs"), path.join(repo, "docs"), ["BUILDING.txt"])],
  ];
  for (const [name, fn] of steps) say(`  ${fn() ? "copied " : "FAILED "} ${name} -> ${repo}`);
}

/** the page files into this PC's local site, which copies them once at its start and then serves that copy */
function publishLocal() {
  const wc = path.join(LOCAL, "webclient");
  if (!fs.existsSync(wc)) return [];
  const done = [];
  for (const f of fs.readdirSync(PAGE)) {
    const from = path.join(PAGE, f), to = path.join(wc, f);
    if (!fs.statSync(from).isFile() || !pageFile(f)) continue;
    if (!fs.existsSync(to) || sha256(fs.readFileSync(from)) !== sha256(fs.readFileSync(to))) { fs.copyFileSync(from, to); done.push(f); }
  }
  return done;
}

async function smokeTest() {
  say(`${stamp()} smoke test in a headless browser`);
  const mod = await import(pathToFileURL(path.join(ROOT, "tools", "webclient-test", "smoke.mjs")).href);
  return mod.smoke({ stage: STAGE, site: path.join(ROOT, "havoc9.org"), browser: opt("browser"), say });
}

// ---- main -------------------------------------------------------------------------------------------------------------

async function sync() {
  const rec = readRecord();
  const now = fingerprint();
  const problems = parity();
  const p = plan(now, rec);
  const reasons = describe(p);

  if (problems.length) {
    say("web parity -- native-only code with no answer for the web client:");
    for (const t of problems) say("  - " + t);
  }
  if (flag("check")) {
    for (const t of reasons) say("out of date: " + t);
    const wc = path.join(LOCAL, "webclient");
    if (fs.existsSync(wc)) {
      const stale = fs.readdirSync(PAGE).filter((f) => pageFile(f) && fs.statSync(path.join(PAGE, f)).isFile() && (!fs.existsSync(path.join(wc, f)) || sha256(fs.readFileSync(path.join(PAGE, f))) !== sha256(fs.readFileSync(path.join(wc, f)))));
      if (stale.length) say("not published to the local site: " + stale.join(", ") + " (node tools\\webclient-sync.mjs does it)");
    }
    if (!problems.length && !reasons.length) say("the web client is up to date with the engine, the patch chain and the client library" + (rec ? ` (built ${rec.builtAt})` : ""));
    if (flag("repo-check")) {
      const m = mirrorStatus();
      if (!m) say("git copy: no copy of this program in " + repo + " to check it with");
      else for (const l of m.lines) say("git copy: " + l);
    }
    return problems.length ? 3 : reasons.length ? 1 : 0;
  }
  if (problems.length) return 3;

  if (!p.build && !p.stage && !p.test) {
    const done = publishLocal();
    say(`${stamp()} the web client is up to date` + (done.length ? "; published " + done.join(", ") + " to the local site" : ""));
    return 0;
  }
  say(`${stamp()} syncing the web client: ` + (reasons.join("; ") || "forced"));

  if (!(await getLock("webclient-sync"))) return 5;
  let code = 0;
  try {
    if (p.build && !(await build())) return 6;
    if (p.stage && !(await stage())) return 6;
    copyToRepo();
    const done = publishLocal();
    if (done.length) say(`  published ${done.join(", ")} to the local site (${path.join(LOCAL, "webclient")})`);
    let smoke = { ran: false, ok: null };
    if (!flag("no-test") && p.test) {
      smoke = await smokeTest();
      if (!smoke.ran) say("  the smoke test could not run: " + smoke.why);
      else if (!smoke.ok) { say("  the smoke test FAILED:"); for (const c of smoke.checks.filter((c) => !c.ok)) say(`    ${c.name}: ${c.detail}`); code = 4; }
    }
    // the record is made from the files as they are now: the packer may have rewritten its own leave-out list
    const after = fingerprint();
    const record = {
      format: 1,
      builtAt: new Date().toISOString(),
      inputs: after.groups,
      counts: after.counts,
      outputs: Object.fromEntries(["engine/xash.wasm", "engine/xash.js", "cl_dll/client_emscripten_wasm32.wasm", "3rdparty/mainui/libmenu.wasm"]
        .filter((f) => fs.existsSync(path.join(BIN, f))).map((f) => [f, sha256(fs.readFileSync(path.join(BIN, f))).slice(0, 12)])),
      smoke: smoke.ran ? { ok: smoke.ok, checks: smoke.checks.length, at: new Date().toISOString(), perf: smoke.perf } : (rec && rec.smoke) || null,
    };
    if (code !== 4) {
      fs.writeFileSync(RECORD, JSON.stringify(record, null, 1) + "\n");
      if (fs.existsSync(repo)) robo(BIN, path.join(repo, "webclient-bin"), ["/MIR", "/XF", "*.bak_*"]);
    }
    say(`${stamp()} ${code === 0 ? "done: the web client matches the engine" : "NOT done: see above"}; xash.wasm ${record.outputs["engine/xash.wasm"] || "?"}, client ${record.outputs["cl_dll/client_emscripten_wasm32.wasm"] || "?"}`);
    const m = mirrorStatus();
    if (m) for (const l of m.lines) say("git copy: " + l + (m.ok ? "" : ""));
  } finally {
    dropLock();
  }
  return code;
}

async function watch() {
  say(`watching the engine, the patch chain, the client library and the page; syncing when something changes and stays quiet for 20 seconds (Ctrl+C stops)`);
  let last = null, quiet = 0;
  for (;;) {
    const fp = fingerprint().groups;
    const key = JSON.stringify(fp);
    if (last !== null && key !== last) quiet = 0; else quiet += 1;
    const pending = plan({ groups: fp }, readRecord());
    const dirty = pending.build || pending.stage || pending.test;
    last = key;
    if (dirty && quiet >= 1) {
      const code = await sync();
      say(`${stamp()} sync finished with exit ${code}; watching again`);
      last = JSON.stringify(fingerprint().groups);
      quiet = 0;
    }
    await sleep(20000);
  }
}

if (flag("watch")) await watch();
else process.exit(await sync());
