// What the launchers (h9_p2p_host.*, h9_p2p_join.*, the start beside the dedicated server) need from Node: p2p.ini, the options a
// helper is started with, the join-and-play sequence, and the stop request.
//
// p2p.ini sits beside h9xash.bat (the H9XASH folder). It holds the host token, so it is never shipped or committed. Plain
// key=value lines; a line starting with ; or # is a comment; a [section] line is ignored; the last of a repeated key wins.
//   service=        the relay's base URL (https://relay.example.org, or https://havoc9.org/api/p2p)
//   token=          the host token the relay's owner gave you (host only)
//   game=           host:port of the game the helper talks to (default 127.0.0.1 and the port= of networking.ini, else 27015)
//   data_dir=       the game's AMX Mod X data folder, relative to this file (default ts/addons/amxmodx/data)
//   enabled=        1: the dedicated-server launchers start the helper beside the server (default 0)
//   idle_exit=      minutes the helper waits for a game that is gone before it stops itself (default 10, 0 = never)
//   start_game=     friend side: 1 starts the game with +connect (default 1); 0 only prints the address to type

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { JoinHelper } from "./helper.js";
import { FILES } from "./ipc.js";

export const EXAMPLE_TOKEN = "PASTE-YOUR-HOST-TOKEN-HERE";

// ---- ini files -------------------------------------------------------------------------------------------------------------------

// Returns { flat, sections }: flat[key] (lower case, any section), sections[section][key]. A missing file gives empty objects.
export function readIni(file) {
  const flat = Object.create(null);
  const sections = Object.create(null);
  let text = "";
  try { text = fs.readFileSync(file, "latin1"); } catch (e) { return { flat, sections, found: false }; }
  let section = "";
  for (const raw of text.replace(/^\xef\xbb\xbf/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ";" || line[0] === "#") continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { section = m[1].trim().toLowerCase(); continue; }
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    flat[key] = value;
    (sections[section] = sections[section] || Object.create(null))[key] = value;
  }
  return { flat, sections, found: true };
}

// The port of networking.ini ([server] port=), 27015 when there is none or it is not a port.
export function gamePort(folder) {
  const ini = readIni(path.join(folder, "networking.ini"));
  const v = ini.sections.server && ini.sections.server.port;
  return /^[1-9][0-9]{0,4}$/.test(v || "") && Number(v) <= 65535 ? Number(v) : 27015;
}

export function parseHostPort(text, fallbackPort) {
  const m = /^(.+):(\d{1,5})$/.exec(String(text || ""));
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: String(text || "127.0.0.1") || "127.0.0.1", port: fallbackPort };
}

export function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; } catch (e) { return false; }
}

// A plain http:// relay is fine on this PC or a LAN; anywhere else the host token crosses the network in the clear.
export function plainHttpWarning(service) {
  try {
    const u = new URL(service);
    if (u.protocol !== "http:") return "";
    const h = u.hostname;
    if (h === "localhost" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "";
    return "the relay address is http://, so the host token crosses the network unencrypted: use https:// unless the relay is on this PC or your LAN";
  } catch (e) { return ""; }
}

// ---- options -----------------------------------------------------------------------------------------------------------------------

// The options of `h9p2p host --ini <file>` / `--ipc <dir>`. args is the argument list after "host"; env is process.env.
// Returns { ok, errors, warnings, ...options }; a caller prints the errors and exits when ok is false.
export function hostOptions(args, env = process.env) {
  const val = (n, d = "") => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const iniPath = val("--ini");
  const ini = iniPath ? readIni(iniPath) : { flat: Object.create(null), found: false };
  const folder = iniPath ? path.dirname(path.resolve(iniPath)) : process.cwd();
  const errors = [];
  const warnings = [];
  if (iniPath && !ini.found) errors.push("cannot read " + iniPath + ": copy p2p.ini.example to p2p.ini and fill it in");
  const service = val("--service") || ini.flat.service || "";
  if (service && !isHttpUrl(service)) errors.push("service= is not an http:// or https:// address");
  const warn = service ? plainHttpWarning(service) : "";
  if (warn) warnings.push(warn);
  const token = env.H9_P2P_TOKEN || val("--token") || ini.flat.token || "";
  if (!token) errors.push("no host token: put the token your relay gave you in token= of p2p.ini");
  else if (token === EXAMPLE_TOKEN) errors.push("p2p.ini still has the example token: put the token your relay gave you in token=");
  const dir = val("--ipc") || path.resolve(folder, ini.flat.data_dir || path.join("ts", "addons", "amxmodx", "data"));
  const game = parseHostPort(val("--game") || ini.flat.game, gamePort(folder));
  const idleMin = val("--idle-exit") !== "" ? Number(val("--idle-exit")) : ini.flat.idle_exit !== undefined ? Number(ini.flat.idle_exit) : 10;
  if (!Number.isFinite(idleMin) || idleMin < 0) errors.push("idle_exit= is not a number of minutes");
  return { ok: errors.length === 0, errors, warnings, service, token, dir, game, folder, idleExitMs: Math.max(0, idleMin || 0) * 60000 };
}

// ---- the friend: redeem, wait for the relay, start the game ---------------------------------------------------------------------

export function gameRunning() {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/fi", "imagename eq HAVOC 9.exe", "/nh"], { encoding: "utf8", timeout: 8000 });
      return /HAVOC 9\.exe/i.test(r.stdout || "");
    }
    return spawnSync("pgrep", ["-f", "HAVOC 9.exe"], { timeout: 8000 }).status === 0;
  } catch (e) {
    return false;
  }
}

function refusal(e) {
  if (e && e.status === 404) return "that invite is not valid";
  if (e && e.status === 429) return "too many tries from this address: wait " + (e.retryAfter || 60) + " s and try again";
  if (e && e.status === 400) return "that is not an invite code";
  if (e && e.status) return "the relay answered " + e.status;
  return "cannot reach the relay: " + String((e && (e.code || e.message)) || e);
}

// opts: code, service, folder, noGame, listenPort, relayOnly, account, bindAddress, allowPrivatePeers, launcher, readyMs, pollMs, log, makeJoin, running, spawnFn
// Redeems the code, waits until the relay answers, then starts the game with +connect <address> (not when noGame is set or a game runs
// already: the address is printed to type). Resolves with { address, join, child, done, stop } at once; done resolves with { code, why }
// when the game has ended, the host has closed the game, or stop() was called; the helper is closed by then.
export async function playGame(opts) {
  const o = { listenPort: 27015, readyMs: 20000, pollMs: 5000, log: () => {}, running: gameRunning, spawnFn: spawn, bindAddress: "0.0.0.0", ...opts };
  const join = (o.makeJoin || ((x) => new JoinHelper(x)))({
    service: o.service, code: o.code, listen: { host: "auto", port: o.listenPort }, direct: !o.relayOnly, relay: true,
    account: o.account || undefined, allowPrivatePeers: !!o.allowPrivatePeers, bindAddress: o.bindAddress,
  });
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let poll = null;
  const end = (code, why) => { clearInterval(poll); finish({ code, why }); };
  join.on("error", (e) => o.log("helper: " + String(e && e.message)));
  join.on("closed", () => end(0, "the host closed the game"));
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the relay did not answer in " + Math.round(o.readyMs / 1000) + " s: this network may block UDP")), o.readyMs);
    join.once("ready", (r) => { clearTimeout(t); resolve(r); });
  });
  ready.catch(() => {});
  try {
    await join.start();
  } catch (e) {
    throw new Error(refusal(e));
  }
  let r;
  try {
    r = await ready;
  } catch (e) {
    await join.close();
    throw e;
  }
  const address = r.listen;
  o.log("ready: connect " + address + (r.host ? "   (" + r.host + ")" : ""));
  done.then(() => join.close().catch(() => {}));

  let child = null;
  if (o.noGame || o.running()) {
    o.log((o.noGame ? "type this in the game's console:  connect " : "the game is running already: type this in its console:  connect ") + address);
    if (!o.noGame) {
      poll = setInterval(() => { if (!o.running()) end(0, "the game ended"); }, o.pollMs);
      poll.unref();
    }
  } else {
    const exe = o.launcher || path.join(o.folder, process.platform === "win32" ? "h9xash.bat" : "h9xash.sh");
    const win = process.platform === "win32";
    o.log("starting the game: " + path.basename(exe) + " +connect " + address);
    child = o.spawnFn(win ? process.env.ComSpec || "cmd.exe" : "bash", win ? ["/c", exe, "+connect", address] : [exe, "+connect", address], { cwd: o.folder, stdio: "inherit" });
    child.on("exit", (code) => end(code === null ? 1 : code, "the game ended"));
    child.on("error", (e) => end(1, "the game did not start: " + e.message));
  }
  return { address, join, child, done, stop: async () => { end(0, "stopped"); } };
}

// ---- ensure: the helper beside a dedicated server ---------------------------------------------------------------------------------------

// The file-mode helper of p2p.ini started in the background (no window, its output in p2p.log beside p2p.ini), unless one runs already:
// { state: "started", pid } or { state: "running", pid } (a helper that is not ours is left alone). Throws when it did not come up.
export async function ensureHelper({ ini, script, node = process.execPath, timeoutMs = 10000, extraArgs = [] }) {
  const opt = hostOptions(["--ini", ini]);
  if (!opt.ok) throw new Error(opt.errors.join("; "));
  const alive = () => {
    try {
      const t = fs.readFileSync(path.join(opt.dir, FILES.pid), "latin1");
      const pid = Number((/pid=(\d+)/.exec(t) || [])[1]);
      const at = Number((/time=(\d+)/.exec(t) || [])[1]);
      return pid && Math.floor(Date.now() / 1000) - at < 20 ? pid : 0;
    } catch (e) {
      return 0;
    }
  };
  const before = alive();
  if (before) return { state: "running", pid: before };
  const logFile = path.join(opt.folder, "p2p.log");
  const fd = fs.openSync(logFile, "w");
  const child = spawn(node, [script, "host", "--ini", ini, ...extraArgs], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, cwd: opt.folder, env: process.env });
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  child.on("error", (e) => { exited = e.message; });
  child.unref();
  fs.closeSync(fd);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const pid = alive();
    if (pid) return { state: "started", pid };
    if (exited !== null) {
      if (exited === 4) return { state: "running", pid: 0 };
      let tail = "";
      try {
        const rfd = fs.openSync(logFile, "r");
        try { tail = fs.readFileSync(rfd, "latin1").trim().split(/\r?\n/).pop(); } finally { fs.closeSync(rfd); }
      } catch (e) { /* no log */ }
      throw new Error("the helper did not start (" + exited + ")" + (tail ? ": " + tail : ""));
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the helper did not report in " + Math.round(timeoutMs / 1000) + " s (see " + logFile + ")");
}

// ---- stop ------------------------------------------------------------------------------------------------------------------------------

// Asks the helper of a data folder to stop (a quit line in its command file) and waits for its pid file to go.
export async function stopHelper(dir, timeoutMs = 8000) {
  const pidFile = path.join(dir, FILES.pid);
  if (!fs.existsSync(pidFile)) return { stopped: true, was: false };
  fs.appendFileSync(path.join(dir, FILES.cmd), Math.floor(Date.now() / 1000) + " 0 quit\n");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!fs.existsSync(pidFile)) return { stopped: true, was: true };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { stopped: false, was: true };
}
