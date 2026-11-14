// The launchers' Node side (lib/launch.js): p2p.ini, the options a helper is started with, the join-and-play sequence, the stop request,
// and the service address with a path prefix. The service is the real one (lib/service.js) in this process.
// Ports: HTTP 27385, UDP 27386, 27387 (the fake game), 27388 (a joiner's local address). Loopback only.
//   node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createService } from "../lib/service.js";
import { HostHelper, httpJson, serviceUrl } from "../lib/helper.js";
import { HostIpc, FILES } from "../lib/ipc.js";
import { readIni, gamePort, parseHostPort, hostOptions, plainHttpWarning, playGame, stopHelper, isHttpUrl, EXAMPLE_TOKEN } from "../lib/launch.js";

const HTTP_PORT = 27385;
const UDP_PORT = 27386;
const GAME_PORT = 27387;
const JOIN_PORT = 27388;
const BASE = "http://127.0.0.1:" + HTTP_PORT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), "h9p2p-launch-"));

async function until(fn, ms = 6000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(step);
  }
  throw new Error("timeout waiting for " + fn);
}

async function rig() {
  const svc = createService({
    config: {
      publicUdp: { host: "127.0.0.1", port: UDP_PORT },
      bind: { http: { host: "127.0.0.1", port: HTTP_PORT }, udp: { host: "127.0.0.1", port: UDP_PORT } },
      allowPrivatePeers: true,
      dev: { hosts: { "host-tok": { id: 1, name: "owner" } }, accounts: {} },
    },
  });
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url);
    // the service answers under a prefix too, as h9web mounts it (/api/p2p)
    if (req.url.startsWith("/api/p2p/")) req.url = req.url.slice("/api/p2p".length);
    svc.handleHttp(req, res);
  });
  await svc.start();
  await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
  const game = dgram.createSocket("udp4");
  game.on("message", (m, r) => game.send(Buffer.concat([Buffer.from("ECHO:"), m]), r.port, r.address));
  await new Promise((r) => game.bind(GAME_PORT, "127.0.0.1", r));
  const closers = [];
  return {
    svc, urls,
    track: (x) => { closers.push(x); return x; },
    async host(over = {}) {
      const h = this.track(new HostHelper({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, bindAddress: "127.0.0.1", allowPrivatePeers: true, ...over }));
      await h.open();
      return h;
    },
    async stop() {
      for (const c of closers) { try { await c.close(); } catch (e) { /* closed */ } }
      game.close();
      server.close();
      await svc.stop();
    },
  };
}

// ---- p2p.ini and the options -------------------------------------------------------------------------------------------------------

test("readIni: comments, sections, a byte order mark, CRLF, case, the last of a repeated key", () => {
  const d = tmp();
  const f = path.join(d, "p2p.ini");
  fs.writeFileSync(f, "\xef\xbb\xbf; a comment\r\n# another\r\n[Host]\r\nService = https://relay.example.org \r\nTOKEN=abc=def\r\n\r\n[server]\r\nport=27016\r\nservice=https://second.example.org\r\nnoequals\r\n=nokey\r\n", "latin1");
  const ini = readIni(f);
  assert.equal(ini.found, true);
  assert.equal(ini.flat.service, "https://second.example.org", "the last one wins in the flat view");
  assert.equal(ini.flat.token, "abc=def", "the value is what follows the first =");
  assert.equal(ini.sections.host.service, "https://relay.example.org");
  assert.equal(ini.sections.server.port, "27016");
  assert.equal(readIni(path.join(d, "nothing.ini")).found, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test("gamePort and parseHostPort", () => {
  const d = tmp();
  assert.equal(gamePort(d), 27015, "no networking.ini");
  fs.writeFileSync(path.join(d, "networking.ini"), "[client]\nport=1\n[server]\nheartbeat=1\nport=27016\n");
  assert.equal(gamePort(d), 27016, "the port under [server]");
  fs.writeFileSync(path.join(d, "networking.ini"), "[server]\nport=notaport\n");
  assert.equal(gamePort(d), 27015);
  fs.writeFileSync(path.join(d, "networking.ini"), "[server]\nport=70000\n");
  assert.equal(gamePort(d), 27015);
  assert.deepEqual(parseHostPort("10.0.0.5:27020", 27015), { host: "10.0.0.5", port: 27020 });
  assert.deepEqual(parseHostPort("", 27016), { host: "127.0.0.1", port: 27016 });
  assert.deepEqual(parseHostPort("localhost", 27016), { host: "localhost", port: 27016 });
  fs.rmSync(d, { recursive: true, force: true });
});

test("hostOptions: what a launcher starts the helper with, and what it refuses", () => {
  const d = tmp();
  const ini = path.join(d, "p2p.ini");
  fs.writeFileSync(ini, "service=https://relay.example.org/api/p2p\ntoken=" + EXAMPLE_TOKEN + "\n");
  let o = hostOptions(["--ini", ini], {});
  assert.equal(o.ok, false);
  assert.match(o.errors.join("|"), /still has the example token/);
  fs.writeFileSync(ini, "service=https://relay.example.org/api/p2p\ntoken=tok-from-ini\ngame=127.0.0.1:27020\ndata_dir=custom\\data\nidle_exit=3\n");
  o = hostOptions(["--ini", ini], {});
  assert.equal(o.ok, true, o.errors.join("|"));
  assert.equal(o.token, "tok-from-ini");
  assert.equal(o.service, "https://relay.example.org/api/p2p");
  assert.deepEqual(o.game, { host: "127.0.0.1", port: 27020 });
  assert.equal(o.dir, path.resolve(d, "custom\\data"));
  assert.equal(o.idleExitMs, 180000);
  assert.deepEqual(o.warnings, []);
  assert.equal(hostOptions(["--ini", ini], { H9_P2P_TOKEN: "tok-from-env" }).token, "tok-from-env", "the environment wins over the file, so the launcher need not put the token on a command line");
  assert.equal(hostOptions(["--ini", ini, "--token", "tok-flag", "--service", "http://relay.example.org:28247", "--game", "10.0.0.2:27015", "--idle-exit", "0"], {}).token, "tok-flag");
  const plain = hostOptions(["--ini", ini, "--service", "http://relay.example.org:28247"], {});
  assert.match(plain.warnings.join("|"), /crosses the network unencrypted/);
  assert.equal(hostOptions(["--ini", ini, "--service", "http://192.168.1.5:28247"], {}).warnings.length, 0, "a LAN relay over http is not warned about");
  assert.equal(hostOptions(["--ini", ini, "--service", "http://127.0.0.1:28247"], {}).warnings.length, 0);
  assert.match(hostOptions(["--ini", ini, "--service", "ftp://x"], {}).errors.join("|"), /not an http/);
  assert.match(hostOptions(["--ini", path.join(d, "missing.ini")], {}).errors.join("|"), /cannot read/);
  fs.writeFileSync(ini, "service=https://relay.example.org\n");
  assert.match(hostOptions(["--ini", ini], {}).errors.join("|"), /no host token/);
  fs.writeFileSync(ini, "token=t\nidle_exit=soon\n");
  assert.match(hostOptions(["--ini", ini], {}).errors.join("|"), /idle_exit/);
  // the defaults: the game's data folder beside p2p.ini and the port of networking.ini
  fs.writeFileSync(ini, "token=t\n");
  fs.writeFileSync(path.join(d, "networking.ini"), "[server]\nport=27018\n");
  o = hostOptions(["--ini", ini], {});
  assert.equal(o.dir, path.join(d, "ts", "addons", "amxmodx", "data"));
  assert.deepEqual(o.game, { host: "127.0.0.1", port: 27018 });
  assert.equal(o.idleExitMs, 600000);
  assert.equal(hostOptions(["--ipc", path.join(d, "x"), "--token", "t"], {}).dir, path.join(d, "x"));
  fs.rmSync(d, { recursive: true, force: true });
});

test("service addresses: a path prefix is kept, a plain-http warning is only for addresses beyond the LAN", () => {
  assert.equal(serviceUrl("https://havoc9.org/api/p2p", "/v1/host/open").href, "https://havoc9.org/api/p2p/v1/host/open");
  assert.equal(serviceUrl("https://havoc9.org/api/p2p/", "/v1/host/open").href, "https://havoc9.org/api/p2p/v1/host/open");
  assert.equal(serviceUrl("http://127.0.0.1:28247", "/v1/health").href, "http://127.0.0.1:28247/v1/health");
  assert.equal(isHttpUrl("https://x.example"), true);
  assert.equal(isHttpUrl("x.example"), false);
  assert.equal(plainHttpWarning("https://relay.example.org"), "");
  assert.equal(plainHttpWarning("http://localhost:1"), "");
  assert.notEqual(plainHttpWarning("http://relay.example.org"), "");
  assert.notEqual(plainHttpWarning("http://172.32.0.1"), "", "172.32 is not a private address");
  assert.equal(plainHttpWarning("http://172.31.0.1"), "");
});

test("a service mounted under a prefix works for the host and the joiner (the prefix is kept in every call)", async () => {
  const r = await rig();
  try {
    const prefixed = BASE + "/api/p2p";
    const h = await r.host({ service: prefixed });
    const inv = await h.invite({ label: "Mike" });
    assert.ok(r.urls.every((u) => u.startsWith("/api/p2p/v1/")), r.urls.join(","));
    const answer = await httpJson(prefixed, "/v1/health", { method: "GET" });
    assert.equal(answer.status, 200);
    const done = await playGame({ code: inv.code, service: prefixed, folder: tmp(), noGame: true, listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true });
    assert.match(done.address, /^127\.101\.\d+\.\d+:27388$/);
    await done.stop();
    await done.done;
  } finally { await r.stop(); }
});

// ---- the friend: play ------------------------------------------------------------------------------------------------------------------

test("play without a game: the address is printed, the helper carries the game's packets, and it ends when the host closes the game", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const inv = await h.invite({ label: "Mike" });
    const lines = [];
    const s = await playGame({ code: inv.code, service: BASE, folder: tmp(), noGame: true, listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true, log: (t) => lines.push(t) });
    assert.match(lines[0], /^ready: connect 127\.101\.\d+\.\d+:27388/);
    assert.match(lines[1], /^type this in the game's console:  connect 127\.101\./);
    const c = dgram.createSocket("udp4");
    await new Promise((res) => c.bind(0, "127.0.0.1", res));
    const got = new Promise((res) => c.on("message", (m) => res(m.toString())));
    const [ah, ap] = s.address.split(":");
    c.send(Buffer.from("hi"), Number(ap), ah);
    assert.equal(await Promise.race([got, wait(3000).then(() => null)]), "ECHO:hi");
    c.close();
    // the host closes the game: the friend's side ends with the reason
    await h.close();
    const end = await Promise.race([s.done, wait(8000).then(() => null)]);
    assert.ok(end, "the helper ended when the host closed the game");
    assert.equal(end.code, 0);
    assert.match(end.why, /the host closed the game/);
  } finally { await r.stop(); }
});

test("play with a game: the launcher is started with +connect <address>; the helper ends with the game and the game's exit code is the answer", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const inv = await h.invite({ label: "Mike" });
    const calls = [];
    const fake = new EventEmitter();
    const s = await playGame({
      code: inv.code, service: BASE, folder: tmp(), listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true, running: () => false,
      spawnFn: (cmd, argv, opts) => { calls.push({ cmd, argv, cwd: opts.cwd }); return fake; },
    });
    assert.equal(calls.length, 1);
    const last = calls[0].argv.slice(-2);
    assert.equal(last[0], "+connect");
    assert.equal(last[1], s.address);
    assert.ok(calls[0].argv.some((a) => /h9xash\.(bat|sh)$/.test(a)), "the launcher beside p2p.ini");
    fake.emit("exit", 7);
    const end = await s.done;
    assert.deepEqual(end, { code: 7, why: "the game ended" });
    assert.equal(s.join.closed, true, "the helper is closed with the game");
    // a game that cannot start
    const inv2 = await h.invite({ label: "Anna" });
    const bad = new EventEmitter();
    const s2 = await playGame({ code: inv2.code, service: BASE, folder: tmp(), listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true, running: () => false, spawnFn: () => bad });
    bad.emit("error", new Error("ENOENT"));
    const end2 = await s2.done;
    assert.equal(end2.code, 1);
    assert.match(end2.why, /did not start: ENOENT/);
  } finally { await r.stop(); }
});

test("play with a real launcher script: it gets +connect and the address, in the H9XASH folder", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const inv = await h.invite({ label: "Mike" });
    const folder = tmp();
    const out = path.join(folder, "args.txt");
    if (process.platform === "win32") fs.writeFileSync(path.join(folder, "h9xash.bat"), "@echo off\r\necho %*> \"" + out + "\"\r\ncd >> \"" + out + "\"\r\nexit /b 5\r\n");
    else fs.writeFileSync(path.join(folder, "h9xash.sh"), "#!/bin/bash\necho \"$@\" > \"" + out + "\"\npwd >> \"" + out + "\"\nexit 5\n", { mode: 0o755 });
    const s = await playGame({ code: inv.code, service: BASE, folder, listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true, running: () => false });
    const end = await Promise.race([s.done, wait(15000).then(() => null)]);
    assert.ok(end, "the launcher ran and ended");
    assert.equal(end.code, 5);
    const text = fs.readFileSync(out, "latin1");
    assert.ok(text.includes("+connect " + s.address), text);
    assert.ok(text.toLowerCase().includes(path.basename(folder).toLowerCase()), "it ran in the folder: " + text);
  } finally { await r.stop(); }
});

test("play: a game that runs already is not started again; the helper leaves when the game is gone", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const inv = await h.invite({ label: "Mike" });
    let up = true;
    let spawned = 0;
    const lines = [];
    const s = await playGame({
      code: inv.code, service: BASE, folder: tmp(), listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true, running: () => up,
      spawnFn: () => { spawned++; return new EventEmitter(); }, log: (t) => lines.push(t), pollMs: 150,
    });
    assert.equal(spawned, 0);
    assert.match(lines[1], /^the game is running already: type this in its console:  connect 127\.101\./);
    up = false;
    const end = await Promise.race([s.done, wait(8000).then(() => null)]);
    assert.ok(end, "the game's end was noticed");
    assert.deepEqual(end, { code: 0, why: "the game ended" });
  } finally { await r.stop(); }
});

test("play: a bad code, a code the relay does not know and a relay that is not there are told in words", async () => {
  const r = await rig();
  try {
    const base = { service: BASE, folder: tmp(), noGame: true, listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true };
    await assert.rejects(playGame({ ...base, code: "not a code" }), /that is not an invite code/);
    await assert.rejects(playGame({ ...base, code: "H9-ABCDE-ABCDE" }), /that invite is not valid/);
    await assert.rejects(playGame({ ...base, code: "H9-ABCDE-ABCDE", service: "http://127.0.0.1:1" }), /cannot reach the relay: ECONNREFUSED/);
  } finally { await r.stop(); }
});

test("play: a relay that answers the redeem but not the UDP says so after the wait", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const inv = await h.invite({ label: "Mike" });
    // the service's UDP is told to be elsewhere: the redeem works, the HELLO is never answered
    const odd = http.createServer(async (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const a = await httpJson(BASE, req.url, { body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
        if (a.json && a.json.udp) a.json.udp = { host: "127.0.0.1", port: 1 };
        res.writeHead(a.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(a.json));
      });
    });
    await new Promise((res) => odd.listen(HTTP_PORT + 10, "127.0.0.1", res));
    try {
      await assert.rejects(playGame({ code: inv.code, service: "http://127.0.0.1:" + (HTTP_PORT + 10), folder: tmp(), noGame: true, listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true, readyMs: 1200 }), /did not answer in 1 s: this network may block UDP|did not answer in 2 s/);
    } finally { odd.close(); }
  } finally { await r.stop(); }
});

test("play: a second friend of the same host on one PC, or a game port that is taken, gets another port instead of an error", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const a = await h.invite({ label: "A" });
    const b = await h.invite({ label: "B" });
    const base = { service: BASE, folder: tmp(), noGame: true, listenPort: JOIN_PORT, bindAddress: "127.0.0.1", allowPrivatePeers: true };
    const s1 = await playGame({ ...base, code: a.code });
    const s2 = await playGame({ ...base, code: b.code });
    assert.ok(s1.address.endsWith(":" + JOIN_PORT), s1.address);
    assert.ok(!s2.address.endsWith(":" + JOIN_PORT), "the second one took a free port: " + s2.address);
    assert.equal(s1.address.split(":")[0], s2.address.split(":")[0], "the same virtual address of the host's session");
    for (const s of [s1, s2]) {
      const c = dgram.createSocket("udp4");
      await new Promise((res) => c.bind(0, "127.0.0.1", res));
      const got = new Promise((res) => c.on("message", (m) => res(m.toString())));
      const [ah, ap] = s.address.split(":");
      c.send(Buffer.from("hi"), Number(ap), ah);
      assert.equal(await Promise.race([got, wait(3000).then(() => null)]), "ECHO:hi", s.address);
      c.close();
      await s.stop();
      await s.done;
    }
  } finally { await r.stop(); }
});

// ---- stop ----------------------------------------------------------------------------------------------------------------------------------

test("stopHelper: no helper is not an error; a running one is asked to stop and its pid file goes", async () => {
  const d = tmp();
  assert.deepEqual(await stopHelper(d, 500), { stopped: true, was: false });
  const ipc = new HostIpc({ dir: d, token: "x", tickMs: 40, log: () => {} });
  ipc.start();
  const stopped = new Promise((res) => ipc.once("stopped", res));
  const r = await stopHelper(d, 4000);
  assert.deepEqual(r, { stopped: true, was: true });
  await stopped;
  assert.ok(!fs.existsSync(path.join(d, FILES.pid)));
  // a pid file that nobody removes: the answer is that it did not stop
  fs.writeFileSync(path.join(d, FILES.pid), "pid=4242\ntime=1\n");
  assert.deepEqual(await stopHelper(d, 500), { stopped: false, was: true });
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- the command line, as the launchers run it --------------------------------------------------------------------------------------------

const SCRIPT = new URL("../bin/h9p2p.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// synchronous: for what needs nothing from this process (the in-process service cannot answer while a spawnSync blocks the loop)
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...env }, windowsHide: true });
}

function runCliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("h9p2p host --ini refuses a missing or example token (exit 2) and a second helper for one folder (exit 4); no secret is printed", async () => {
  const d = tmp();
  const ini = path.join(d, "p2p.ini");
  fs.writeFileSync(ini, "service=http://127.0.0.1:" + HTTP_PORT + "\ntoken=" + EXAMPLE_TOKEN + "\n");
  let r = runCli(["host", "--ini", ini]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /still has the example token/);
  r = runCli(["host", "--ini", path.join(d, "missing.ini")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
  fs.writeFileSync(ini, "service=http://127.0.0.1:" + HTTP_PORT + "\ntoken=SECRET-TOKEN-VALUE\n");
  const dataDir = path.join(d, "ts", "addons", "amxmodx", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, FILES.pid), "pid=4242\ntime=" + Math.floor(Date.now() / 1000) + "\n");
  r = runCli(["host", "--ini", ini, "--bind", "127.0.0.1"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /already running/);
  assert.ok(!(r.stdout + r.stderr).includes("SECRET-TOKEN-VALUE"));
  fs.rmSync(d, { recursive: true, force: true });
});

test("h9p2p ensure starts a background helper, a second ensure leaves it alone, stop ends it; the helper opens the path from the state file and prints nothing secret", async () => {
  const rg = await rig();
  const d = tmp();
  try {
    const ini = path.join(d, "p2p.ini");
    fs.writeFileSync(ini, "service=" + BASE + "\ntoken=host-tok\nidle_exit=0\ngame=127.0.0.1:" + GAME_PORT + "\n");
    const dataDir = path.join(d, "ts", "addons", "amxmodx", "data");
    const extra = ["--bind", "127.0.0.1", "--allow-private-peers"];
    let r = runCli(["ensure", "--ini", ini, ...extra]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /the helper started \(pid \d+/);
    r = runCli(["ensure", "--ini", ini, ...extra]);
    assert.equal(r.status, 10, "the second one is left alone: " + r.stdout + r.stderr);
    assert.match(r.stdout, /running already/);
    // the plugin's state: the helper opens the path
    const state = "v=1\nenabled=1\nstopping=0\npublic=0\ndirect=1\nrelay=1\nttl=600\nuses=1\nname=T\nmap=m\nplayers=1\nmaxplayers=8\npassword=0\ntime=" + Math.floor(Date.now() / 1000) + "\nend=1\n";
    const tick = setInterval(() => fs.writeFileSync(path.join(dataDir, FILES.state), state.replace(/time=\d+/, "time=" + Math.floor(Date.now() / 1000))), 300);
    try {
      await until(() => /status opened /.test(fs.readFileSync(path.join(dataDir, FILES.out), "latin1")), 15000);
    } finally { clearInterval(tick); }
    const log = fs.readFileSync(path.join(d, "p2p.log"), "latin1");
    assert.match(log, /the path is open/);
    assert.ok(!log.includes("host-tok"), "the log has no token");
    r = runCli(["stop", "--ini", ini]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /the helper stopped/);
    assert.ok(!fs.existsSync(path.join(dataDir, FILES.pid)));
    assert.match(fs.readFileSync(path.join(dataDir, FILES.out), "latin1"), /status stopped stopped on request/);
    r = runCli(["stop", "--ini", ini]);
    assert.match(r.stdout, /no helper is running/);
  } finally {
    runCli(["stop", "--ini", path.join(d, "p2p.ini")]);
    await rg.stop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("h9p2p play --no-game redeems a code, prints the address to type and keeps running; a bad code exits 1 with words", async () => {
  const rg = await rig();
  try {
    const h = await rg.host();
    const inv = await h.invite({ label: "Mike" });
    const child = spawn(process.execPath, [SCRIPT, "play", inv.code, "--service", BASE, "--no-game", "--bind", "127.0.0.1", "--allow-private-peers", "--port", String(JOIN_PORT)], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    try {
      await until(() => /ready: connect 127\.101\.\d+\.\d+:27388/.test(out) && /type this in the game's console:  connect 127\.101\./.test(out), 15000);
    } finally { child.kill(); }
    const bad = await runCliAsync(["play", "H9-ABCDE-ABCDE", "--service", BASE, "--no-game", "--bind", "127.0.0.1"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /that invite is not valid/);
    const none = runCli(["play", inv.code, "--no-game"]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no relay address/);
    const nocode = runCli(["play"]);
    assert.equal(nocode.status, 2);
  } finally { await rg.stop(); }
});
