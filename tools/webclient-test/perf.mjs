// How the web client feels, measured in a headless browser on the real GPU: frame times, long tasks, synchronous file
// reads (a game file is fetched the first time the engine reads it), the audio callback's timing and a CPU profile.
//
//   node perf.mjs --name <label> [--url <page>] [--phases menu,map] [--map <name>] [--secs 25] [--browser edge|opera]
//                 [--size 1280,800] [--no-profile] [--emulate] [--signup] [--glcount] [--inject <file.js>] [--script <file.mjs>]
//                 [--fresh]
//
// With no --url it serves the stage itself (server.mjs, stubbed API routes). With --url http://127.0.0.1:8090/webclient/index.html
// it measures through this PC's local site, whose sign-in is stubbed by inject.js (a fixed test id, no account). Phases:
//   menu   20 seconds of the main menu
//   map    loads --map in the page's own engine (a listen server in the tab), then --secs seconds in it
// --signup makes a throwaway account on the site --url names (POST /api/signup) and signs the tab in with it, in place of the
// stubbed sign-in: what a join through the relay needs. Both --signup and --login read the account's password from
// H9_PASSWORD (required: the tool carries no default). A --script <file.mjs> exports default async
// ({ tab, cmd, sleep, out, window_, shot, results, nowMs, stamp }) to run its own phase (join.mjs joins a server).
// Results go to <ROOT>\webclient-build\perf\<name>\: summary.json, <phase>.cpuprofile, shot-<phase>.png, console.txt,
// engine-log.txt; `node perf.mjs --top <file.cpuprofile> [n]` prints where the main thread's time went.
// The browser profile (webclient-build\test-profile-<browser>) is kept between runs, with the config the page saved in it;
// --fresh empties it first: a first-time visitor, who starts from the stage's own config.cfg.
// It is a heavy job: run it under D:\temp\HEAVY-JOB.lock.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { launch, killBrowser, newTab, playToMenu, sleep, findBrowser } from "./cdp.mjs";
import { startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

function top(file, n) {
  const prof = JSON.parse(fs.readFileSync(file, "utf8"));
  const byId = new Map(prof.nodes.map((x) => [x.id, x]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < prof.samples.length; i++) {
    const cf = byId.get(prof.samples[i]).callFrame;
    const dt = prof.timeDeltas[i] || 0;
    const key = (cf.functionName || "(anonymous)") + "  " + (cf.url ? cf.url.split("/").pop().slice(0, 40) : "") + ":" + cf.lineNumber;
    self.set(key, (self.get(key) || 0) + dt);
    total += dt;
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
  const sum = (p) => rows.filter(([k]) => k.startsWith(p)).reduce((s, [, v]) => s + v, 0);
  console.log(`${file}: ${(total / 1e6).toFixed(1)} s sampled; idle ${(100 * sum("(idle)") / total).toFixed(1)}%, (program) ${(100 * sum("(program)") / total).toFixed(1)}%, busy ${(100 * (total - sum("(idle)")) / total).toFixed(1)}%`);
  for (const [k, v] of rows.slice(0, n)) console.log(((100 * v) / total).toFixed(1).padStart(5) + "%  " + (v / 1000).toFixed(0).padStart(7) + " ms  " + k);
}

if (argv.includes("--top")) {
  top(arg("top"), Number(argv[argv.indexOf("--top") + 2] || 30));
  process.exit(0);
}

const name = arg("name", "run");
const phases = arg("phases", "menu,map").split(",");
const map = arg("map", "h9_te_neuropolis");
const secs = Number(arg("secs", "25"));
const size = arg("size", "1280,800");
const port = Number(arg("port", "9444"));
const noProfile = argv.includes("--no-profile");
const found = findBrowser(arg("browser"));
if (!found) { console.log("no Chromium browser found"); process.exit(2); }
const out = path.join(ROOT, "webclient-build", "perf", name);
fs.mkdirSync(out, { recursive: true });
const profile = path.join(ROOT, "webclient-build", "test-profile-" + found.name);
if (argv.includes("--fresh")) {
  killBrowser(profile);
  fs.rmSync(profile, { recursive: true, force: true });
}
// the CPU seconds each of this test browser's processes has used, by kind (the profile folder names them)
function procCpu() {
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + profile + "*' } | ForEach-Object { $t = $null; try { $t = (Get-Process -Id $_.ProcessId -ErrorAction Stop).TotalProcessorTime.TotalSeconds } catch {}; if ($t -ne $null) { $k = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }; \"$k $t\" } }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const sums = {};
  for (const line of (r.stdout || "").split(String.fromCharCode(10))) {
    const m = /^(\S+) ([\d.]+)$/.exec(line.trim());
    if (m) sums[m[1]] = (sums[m[1]] || 0) + Number(m[2]);
  }
  return sums;
}

const consoleLines = [];
const t00 = Date.now();
const stamp = () => ((Date.now() - t00) / 1000).toFixed(1).padStart(7);
const say = (t) => console.log(stamp() + " " + t);

let srv = null, tab = null;
try {
  let url = arg("url");
  if (!url) {
    srv = await startServer({ site: path.join(ROOT, "havoc9.org"), stage: path.join(ROOT, "webclient-build", "stage") });
    url = srv.url + "/webclient/index.html";
  }
  const br = await launch({ browser: found.name, profile, port, size });
  say(`browser ${br.exe} ${br.version.Browser}`);
  tab = await newTab(port);
  tab.on("Runtime.consoleAPICalled", (p) => consoleLines.push(stamp() + " [" + p.type + "] " + p.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(" ")));
  tab.on("Runtime.exceptionThrown", (p) => consoleLines.push(stamp() + " [exception] " + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text)));
  tab.on("Log.entryAdded", (p) => consoleLines.push(stamp() + " [log." + p.entry.level + "] " + p.entry.text + " " + (p.entry.url || "")));
  await tab.send("Profiler.enable");
  // --emulate, or --dpr <n> for a display scaled n times (a 4K screen at 150% is 1.5)
  if (argv.includes("--emulate") || arg("dpr")) await tab.send("Emulation.setDeviceMetricsOverride", { width: Number(size.split(",")[0]), height: Number(size.split(",")[1]), deviceScaleFactor: Number(arg("dpr", "1")), mobile: false });
  let inject = fs.readFileSync(path.join(HERE, "inject.js"), "utf8");
  if (argv.includes("--glcount")) inject = "window.__glcount = true;" + String.fromCharCode(10) + inject;
  // --inject <file.js>: more page script, run before the page's own (a probe for one question)
  if (arg("inject")) inject += String.fromCharCode(10) + fs.readFileSync(path.resolve(arg("inject")), "utf8");
  if (argv.includes("--signup") || arg("login")) {
    // --login <name> signs in as an account an earlier --signup made (the site limits signups per hour), or one the admin tool made
    // (h9web-admin create <name> prints a password: H9_PASSWORD names it)
    const origin = new URL(url).origin;
    const user = arg("login") || "perf" + Math.random().toString(36).slice(2, 8);
    const password = process.env.H9_PASSWORD;
    if (!password) throw new Error("set H9_PASSWORD to the account's password (--login) or to the one the new account gets (--signup)");
    const route = arg("login") ? "/api/login" : "/api/signup";
    const r = await fetch(origin + route, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ username: user, password }) });
    if (r.status !== (arg("login") ? 200 : 201)) throw new Error(route + " on " + origin + " answered " + r.status + ": " + (await r.text()).slice(0, 120));
    const [cname, ...cvalue] = r.headers.getSetCookie()[0].split(";")[0].split("=");
    await tab.send("Network.enable");
    // the site's cookie is __Host- prefixed: Secure, path /, no domain (a loopback address counts as secure for it)
    await tab.send("Network.setCookie", { name: cname, value: cvalue.join("="), url: origin, path: "/", httpOnly: true, secure: true, sameSite: "Strict" });
    inject = "window.__realAuth = true;" + String.fromCharCode(10) + inject;
    say((arg("login") ? "signed in as " : "signed up ") + user + " on " + origin);
  }
  const state = await playToMenu({ tab, url, inject, say });
  await sleep(4000);

  const cmd = (c) => tab.eval(`window.h9web.module().ccall("Cbuf_AddText", null, ["string"], [${JSON.stringify(c + "\n")}])`);
  const nowMs = () => tab.eval("performance.now()");
  const results = { browser: br.version.Browser, url, size, gl: state.gl, phases: {} };

  async function window_(label, seconds, { profile: prof = true } = {}) {
    const from = await nowMs();
    const cpu0 = procCpu();
    if (prof && !noProfile) { await tab.send("Profiler.setSamplingInterval", { interval: 1000 }); await tab.send("Profiler.start"); }
    await sleep(seconds * 1000);
    const to = await nowMs();
    if (prof && !noProfile) {
      const { profile: p } = await tab.send("Profiler.stop");
      fs.writeFileSync(path.join(out, label + ".cpuprofile"), JSON.stringify(p));
    }
    results.phases[label] = await tab.eval(`window.__perf.summary(${from}, ${to})`);
    const cpu1 = procCpu();
    const wall = (to - from) / 1000;
    results.phases[label].processCpuPercentOfOneCore = Object.fromEntries(Object.keys(cpu1).map((k) => [k, Math.round(100 * ((cpu1[k] || 0) - (cpu0[k] || 0)) / wall)]));
    console.log("\n== " + label + " ==\n" + JSON.stringify(results.phases[label], null, 1));
    const shot = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(out, "shot-" + label + ".png"), Buffer.from(shot.data, "base64"));
  }

  async function shot(label) {
    const s = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(out, "shot-" + label + ".png"), Buffer.from(s.data, "base64"));
  }

  if (phases.includes("menu")) await window_("menu", 20);

  if (phases.includes("map")) {
    const logLen = () => tab.eval("window.h9web.log.length");
    const began = await nowMs();
    let last = await logLen(), quiet = 0, waited = 0;
    await cmd("map " + map);
    say("map " + map + " asked");
    while (waited < 180000) {
      await sleep(500);
      waited += 500;
      const n = await logLen();
      if (n !== last) { last = n; quiet = 0; } else quiet += 500;
      if (waited >= 4000 && quiet >= 4000) break;
    }
    const loaded = await nowMs();
    results.mapLoadSeconds = Math.round((loaded - began) / 100) / 10;
    results.phases.mapLoad = await tab.eval(`window.__perf.summary(${began}, ${loaded})`);
    console.log("\n== mapLoad (" + results.mapLoadSeconds + " s) ==\n" + JSON.stringify(results.phases.mapLoad, null, 1));
    await window_("inmap", secs);
  }

  if (arg("script")) {
    const mod = await import("file:///" + path.resolve(arg("script")).replace(/\\/g, "/"));
    await mod.default({ tab, cmd, sleep, out, window_, shot, results, nowMs, stamp });
  }

  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(out, "engine-log.txt"), await tab.eval("window.h9web.log.slice(-600).join('\\n')"));
} catch (e) {
  console.log("FAILED: " + e.message);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, "console.txt"), consoleLines.join("\n"));
  if (tab) tab.close();
  if (srv) await srv.close();
  killBrowser(profile);
  process.exit();
}
