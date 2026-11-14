// The file mode of the host helper (lib/ipc.js): the plugin's three files in, the service and the game out. The service is the real one
// (lib/service.js) in this process; the plugin is played by the test, which writes the state file and appends commands as the plugin does.
// The public listing endpoint is a stand-in that records what it is sent and answers what the test says.
// Ports: HTTP 27381, UDP 27382 (service), 27383 (the fake game), 27384 (a joiner's local address). Loopback only.
//   node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createService } from "../lib/service.js";
import { JoinHelper } from "../lib/helper.js";
import { HostIpc, parseState, parseCommand, FILES } from "../lib/ipc.js";

const HTTP_PORT = 27381;
const UDP_PORT = 27382;
const GAME_PORT = 27383;
const JOIN_PORT = 27384;
const BASE = "http://127.0.0.1:" + HTTP_PORT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unix = () => Math.floor(Date.now() / 1000);
let clock = 0;

let current = null; // the rig of the running test: what a timeout prints

async function until(fn, ms = 6000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(step);
  }
  let more = "";
  if (current) more = "\n--- journal:\n" + readOut(current.dir).map((l) => l.raw).join("\n") + "\n--- console:\n" + current.logs.join("\n");
  throw new Error("timeout waiting for " + fn + more);
}

const STATE_DEFAULTS = {
  v: 1, enabled: 1, stopping: 0, public: 0, direct: 1, relay: 1, direct_public: 0, require_account: 0, service: "", ttl: 600, uses: 1,
  name: "Test Game", map: "ts_dojo", players: 2, maxplayers: 16, password: 0,
};

// The plugin, as far as the state file goes: every call of writeState sets what the plugin keeps writing (every 400 ms, where the real
// plugin writes every 10 s) until pausePlugin; a raw write (once) with an old time or no end=1 is what a dead or half-written state looks like.
const plugins = new Map();

function writeState(dir, over = {}, { complete = true, time = unix(), once = false } = {}) {
  const s = { ...STATE_DEFAULTS, ...over };
  let text = Object.entries(s).map(([k, v]) => k + "=" + v).join("\n") + "\ntime=" + time + "\n";
  if (complete) text += "end=1\n";
  fs.writeFileSync(path.join(dir, FILES.state), text);
  const p = plugins.get(dir);
  if (p && !once) p.over = over;
}

function startPlugin(dir) {
  const p = { over: null, paused: false, timer: null };
  p.timer = setInterval(() => { if (p.over && !p.paused) writeState(dir, p.over, { once: true }); }, 400);
  plugins.set(dir, p);
}

const pausePlugin = (dir) => { plugins.get(dir).paused = true; };
const resumePlugin = (dir) => { plugins.get(dir).paused = false; };

let seq = 0;
function cmd(dir, text, { time = unix(), nl = true } = {}) {
  seq++;
  fs.appendFileSync(path.join(dir, FILES.cmd), time + " " + seq + " " + text + (nl ? "\n" : ""));
  return seq;
}

function readOut(dir) {
  let text = "";
  try { text = fs.readFileSync(path.join(dir, FILES.out), "latin1"); } catch (e) { return []; }
  return text.split("\n").filter(Boolean).map((l) => {
    const m = /^(\d+) (\S+)(?: re=(\d+))? ?(.*)$/.exec(l);
    return { raw: l, t: Number(m[1]), type: m[2], re: m[3] ? Number(m[3]) : 0, text: m[4] };
  });
}
const outHas = (dir, type, rx, re) => readOut(dir).find((l) => l.type === type && rx.test(l.text) && (re === undefined || l.re === re));

async function rig({ listing = null, ipc: ipcOpts = {}, startIpc = true } = {}) {
  const svc = createService({
    config: {
      publicUdp: { host: "127.0.0.1", port: UDP_PORT },
      bind: { http: { host: "127.0.0.1", port: HTTP_PORT }, udp: { host: "127.0.0.1", port: UDP_PORT } },
      allowPrivatePeers: true,
      dev: { hosts: { "host-tok": { id: 1, name: "owner" } }, accounts: { "friend-tok": { id: 7, name: "mike" } } },
    },
    now: () => Date.now() + clock,
  });
  const posts = [];
  const stub = { answer: listing || (() => ({ status: 200, json: { ok: true, ttl: 45, id: "PUBID1234567" } })) };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/host/listing") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* not json */ }
        posts.push({ body, sig: String(req.headers["x-h9-sig"] || "") });
        const a = stub.answer(body, posts.length);
        if (a.destroy) { req.socket.destroy(); return; }
        res.writeHead(a.status, { "Content-Type": "application/json", ...(a.headers || {}) });
        res.end(JSON.stringify(a.json));
      });
      return;
    }
    svc.handleHttp(req, res);
  });
  await svc.start();
  await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
  const game = dgram.createSocket("udp4");
  const seen = [];
  game.on("message", (m, r) => { seen.push(r.address + ":" + r.port); game.send(Buffer.concat([Buffer.from("ECHO:"), m]), r.port, r.address); });
  await new Promise((r) => game.bind(GAME_PORT, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), "h9p2p-ipc-"));
  const logs = [];
  const closers = [];
  startPlugin(dir);
  const ipc = new HostIpc({
    dir, service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, bindAddress: "127.0.0.1", allowPrivatePeers: true,
    tickMs: 40, stateEveryMs: 80, listingEveryMs: 300, beatEveryMs: 400, staleMs: 6000, stoppingMs: 12000, log: (t) => logs.push(t), ...ipcOpts,
  });
  if (startIpc) ipc.start();
  const handle = {
    svc, ipc, dir, posts, stub, seen, logs, game,
    track: (x) => { closers.push(x); return x; },
    async stop() {
      clearInterval(plugins.get(dir).timer);
      plugins.delete(dir);
      for (const c of closers) { try { await c.close(); } catch (e) { /* closed */ } }
      try { await ipc.stop("test over"); } catch (e) { /* stopped */ }
      game.close();
      server.close();
      await svc.stop();
      clock = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  current = handle;
  return handle;
}

async function openPath(r, over = {}) {
  writeState(r.dir, over);
  await until(() => outHas(r.dir, "status", /^opened /));
}

async function inviteCode(r, flags = "") {
  const n = cmd(r.dir, "invite Mike" + flags);
  const line = await until(() => readOut(r.dir).find((l) => l.type === "invite" && l.re === n));
  const [code, label] = line.text.split(" ");
  const kv = Object.fromEntries(line.text.split(" ").filter((x) => x.includes("=")).map((x) => x.split("=")));
  return { code, label, id: kv.id, n, line };
}

async function friend(r, code, extra = {}) {
  const j = r.track(new JoinHelper({ service: BASE, code, listen: { host: "auto", port: JOIN_PORT }, bindAddress: "127.0.0.1", allowPrivatePeers: true, ...extra }));
  await j.start();
  await new Promise((res) => j.once("ready", res));
  return j;
}

async function echo(j, text) {
  const s = dgram.createSocket("udp4");
  await new Promise((res) => s.bind(0, "127.0.0.1", res));
  const got = new Promise((res) => s.on("message", (m) => res(m.toString())));
  s.send(Buffer.from(text), j.localAddress.port, j.localAddress.address);
  const out = await Promise.race([got, wait(3000).then(() => null)]);
  s.close();
  return out;
}

// ---- the files -------------------------------------------------------------------------------------------------------------------

test("parseState: a complete state, a partial write, another file, clamping and sanitising", () => {
  const ok = parseState("v=1\nenabled=1\nstopping=0\npublic=1\ndirect=0\nrelay=1\ndirect_public=1\nrequire_account=1\nservice=https://r.example/api/p2p\nttl=5000\nuses=0\nname=My Game\nmap=ts_dojo\nplayers=3\nmaxplayers=64\npassword=1\ntime=1789000000\nend=1\n");
  assert.equal(ok.enabled, true);
  assert.equal(ok.public, true);
  assert.equal(ok.direct, false);
  assert.equal(ok.directPublic, true);
  assert.equal(ok.requireAccount, true);
  assert.equal(ok.service, "https://r.example/api/p2p");
  assert.equal(ok.ttl, 900); // clamped
  assert.equal(ok.uses, 1); // clamped
  assert.equal(ok.name, "My Game");
  assert.equal(ok.max, 64);
  assert.equal(ok.password, true);
  assert.equal(ok.time, 1789000000);
  assert.equal(parseState("v=1\nenabled=1\ntime=5\n"), null, "no end=1: a write in progress");
  assert.equal(parseState(""), null);
  assert.equal(parseState("enabled=1\nend=1\n"), null, "no version: not ours");
  assert.equal(parseState("v=1\nenabled=1\r\ntime=5\r\nend=1\r\n").enabled, true, "CRLF is fine");
  const dirty = parseState("v=1\nname=bad" + String.fromCharCode(1) + "name" + String.fromCharCode(233) + "\nmap=a b/c\\d\nend=1\n");
  assert.match(dirty.name, /^bad\?name\?$/);
  assert.equal(dirty.map, "abcd");
  assert.equal(parseState("v=1\nplayers=9999\nmaxplayers=-5\nend=1\n").players, 128);
  assert.equal(parseState("v=1\nplayers=9999\nmaxplayers=-5\nend=1\n").max, 0);
  const none = parseState("v=1\nend=1\n");
  assert.equal(none.enabled, false);
  assert.equal(none.direct, true, "the stock values stand in for a key that is missing");
});

test("parseCommand: stamp, number, verb, arguments", () => {
  assert.deepEqual(parseCommand("1789000000 7 invite Mike direct account"), { t: 1789000000, seq: 7, verb: "invite", args: ["Mike", "direct", "account"] });
  assert.equal(parseCommand("1789000000 7"), null, "no verb");
  assert.equal(parseCommand("x 7 invite"), null);
  assert.equal(parseCommand("1789000000 y invite"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand("1789000000 7 KICK 3").verb, "kick", "the verb is lower-cased");
});

// ---- the session ------------------------------------------------------------------------------------------------------------------

test("enabled=1 opens a path, enabled=0 closes it, and a closed path refuses the invites it had", async () => {
  const r = await rig();
  try {
    assert.ok(outHas(r.dir, "status", /^started pid=/), "the helper says it started");
    await until(() => outHas(r.dir, "status", /^waiting /));
    writeState(r.dir, { enabled: 1 });
    const opened = await until(() => outHas(r.dir, "status", /^opened session=\S{6} direct=1 relay=1$/));
    assert.ok(opened);
    const inv = await inviteCode(r);
    writeState(r.dir, { enabled: 0 });
    await until(() => outHas(r.dir, "status", /^closed h9_p2p is 0/));
    assert.ok(outHas(r.dir, "invite-end", new RegExp("^" + inv.id + " closed$")), "its invite is told dead");
    const refused = await new JoinHelper({ service: BASE, code: inv.code, bindAddress: "127.0.0.1" }).start().then(() => "joined", (e) => e.status);
    assert.equal(refused, 404);
    writeState(r.dir, { enabled: 1 });
    await until(() => readOut(r.dir).filter((l) => l.type === "status" && /^opened /.test(l.text)).length === 2);
  } finally { await r.stop(); }
});

test("an invite through the command file reaches a friend; the game answers through the path; the friend is told to the plugin, with its number", async () => {
  const r = await rig();
  try {
    await openPath(r);
    const inv = await inviteCode(r);
    assert.match(inv.code, /^H9-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    assert.equal(inv.label, "Mike");
    assert.match(inv.line.text, / id=\S+ ttl=600 uses=1 exp=\d+$/);
    const j = await friend(r, inv.code);
    assert.equal(await echo(j, "hello"), "ECHO:hello");
    const joiner = await until(() => readOut(r.dir).find((l) => l.type === "joiner"));
    assert.match(joiner.text, /^1 Mike - \S+ relay$/);
    assert.ok(outHas(r.dir, "invite-end", new RegExp("^" + inv.id + " used$")), "a one-use invite is spent");
    assert.ok(r.seen.every((a) => a.startsWith("127.100.")), "the game sees a loopback alias, never the friend's address");
    for (const l of readOut(r.dir)) assert.ok(!/host-tok/.test(l.raw), "the token is never in the journal");
    for (const t of r.logs) assert.ok(!/host-tok|H9-[0-9A-Z]{5}-/.test(t), "the console shows no token and no code: " + t);
  } finally { await r.stop(); }
});

test("invite flags: account needs the friend's account; direct is allowed only when the state allows it", async () => {
  const r = await rig();
  try {
    await openPath(r, { direct: 0 });
    const inv = await inviteCode(r, " account");
    const anon = await new JoinHelper({ service: BASE, code: inv.code, bindAddress: "127.0.0.1" }).start().then(() => "joined", (e) => e.status);
    assert.equal(anon, 404, "an account invite refuses a friend with no account");
    const j = await friend(r, inv.code, { account: "friend-tok" });
    const joiner = await until(() => readOut(r.dir).find((l) => l.type === "joiner"));
    assert.match(joiner.text, /^1 Mike mike \S+ relay$/);
    assert.ok(j);
    // direct was refused at the state: the invite stays relay-only whatever the command says
    const d = await inviteCode(r, " direct");
    const j2 = await friend(r, d.code, { listen: { host: "127.0.0.2", port: JOIN_PORT + 1 } });
    await wait(600);
    assert.equal(j2.ep.directWanted, false, "no direct leg was offered");
  } finally { await r.stop(); }
});

test("kick: the friend is removed at once and the plugin is told; revoke kills an invite by code or by id; close ends everything", async () => {
  const r = await rig();
  try {
    await openPath(r);
    const a = await inviteCode(r);
    const j = await friend(r, a.code);
    const closed = new Promise((res) => j.once("closed", res));
    await until(() => readOut(r.dir).find((l) => l.type === "joiner"));
    const k = cmd(r.dir, "kick 1");
    await until(() => outHas(r.dir, "status", /^kicked 1$/, k));
    await until(() => outHas(r.dir, "left", /^1 kicked$/));
    await closed;
    const bad = cmd(r.dir, "kick 9");
    assert.ok(await until(() => outHas(r.dir, "error", /no friend has the number 9/, bad)));

    const b = await inviteCode(r);
    const rb = cmd(r.dir, "revoke " + b.code.toLowerCase());
    await until(() => outHas(r.dir, "status", new RegExp("^revoked " + b.id + "$"), rb));
    assert.ok(outHas(r.dir, "invite-end", new RegExp("^" + b.id + " revoked$")));
    assert.equal(await new JoinHelper({ service: BASE, code: b.code, bindAddress: "127.0.0.1" }).start().then(() => "joined", (e) => e.status), 404);

    const c = await inviteCode(r);
    const rc = cmd(r.dir, "revoke " + c.id);
    await until(() => outHas(r.dir, "status", new RegExp("^revoked " + c.id + "$"), rc));
    const none = cmd(r.dir, "revoke nosuchinvite");
    await until(() => outHas(r.dir, "error", /no such invite/, none));

    const d = await inviteCode(r);
    const j2 = await friend(r, d.code, { listen: { host: "127.0.0.3", port: JOIN_PORT + 2 } });
    const closed2 = new Promise((res) => j2.once("closed", res));
    const cl = cmd(r.dir, "close");
    await until(() => outHas(r.dir, "status", /^closed by h9_p2p_close/, cl));
    await closed2;
    assert.ok(outHas(r.dir, "left", /^2 h9_p2p_close$/), "the friend is told gone");
    await wait(600);
    assert.equal(r.ipc.host, null, "a closed path stays closed while the state is still fresh");
    // the next invite opens it again
    const e = await inviteCode(r);
    assert.match(e.code, /^H9-/);
    assert.ok(r.ipc.host, "open again");
  } finally { await r.stop(); }
});

test("a stale state closes the path, a fresh one opens it; stopping=1 is waited for longer; a partial state is ignored", async () => {
  const r = await rig({ ipc: { staleMs: 4000, stoppingMs: 12000 } });
  try {
    await openPath(r);
    pausePlugin(r.dir);
    // a write in progress (no end=1) changes nothing
    writeState(r.dir, { enabled: 0 }, { complete: false, once: true });
    await wait(500);
    assert.ok(r.ipc.host, "a partial state is not believed");
    // the plugin ends (map change): the path waits
    writeState(r.dir, { enabled: 1, stopping: 1 }, { time: unix() - 6, once: true });
    await wait(500);
    assert.ok(r.ipc.host, "stopping=1: six seconds is not long enough to give up");
    // the same age without stopping is stale
    writeState(r.dir, { enabled: 1, stopping: 0 }, { time: unix() - 9, once: true });
    await until(() => outHas(r.dir, "status", /^closed the game's state file is stale/));
    // and the game coming back opens it again
    resumePlugin(r.dir);
    writeState(r.dir, { enabled: 1 });
    await until(() => readOut(r.dir).filter((l) => l.type === "status" && /^opened /.test(l.text)).length === 2);
    // a state that goes unwritten goes stale by itself
    pausePlugin(r.dir);
    await until(() => readOut(r.dir).filter((l) => l.type === "status" && /^closed the game's state file is stale/.test(l.text)).length === 2, 9000);
    // stopping=1 and then a very old file: the long wait is over
    writeState(r.dir, { enabled: 1, stopping: 1 }, { time: unix() - 40, once: true });
    await wait(300);
    assert.equal(r.ipc.host, null);
  } finally { await r.stop(); }
});

test("commands: a stale line is dropped with an answer, a half line waits, lines before the helper started are ignored, an unknown verb is answered", async () => {
  const dir0 = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), "h9p2p-ipc-"));
  fs.writeFileSync(path.join(dir0, FILES.cmd), unix() + " 1 close\n");
  fs.rmSync(dir0, { recursive: true, force: true });
  const r = await rig({ startIpc: false });
  try {
    // a command queued before the helper existed must not run when it starts
    fs.writeFileSync(path.join(r.dir, FILES.cmd), unix() + " 90 close\n");
    r.ipc.start();
    writeState(r.dir);
    await until(() => outHas(r.dir, "status", /^opened /));
    await wait(300);
    assert.ok(r.ipc.host, "the old close line was not run");
    const old = cmd(r.dir, "invite Old", { time: unix() - 120 });
    await until(() => outHas(r.dir, "error", /dropped a stale 'invite' command/, old));
    const half = cmd(r.dir, "invite Half", { nl: false });
    await wait(400);
    assert.equal(readOut(r.dir).filter((l) => l.type === "invite").length, 0, "a line with no end is not run");
    fs.appendFileSync(path.join(r.dir, FILES.cmd), "\n");
    await until(() => outHas(r.dir, "invite", /^H9-\S+ Half /, half));
    const odd = cmd(r.dir, "frobnicate now");
    await until(() => outHas(r.dir, "error", /unknown command 'frobnicate'/, odd));
    fs.appendFileSync(path.join(r.dir, FILES.cmd), "this is not a command\n");
    await until(() => outHas(r.dir, "error", /not a command/));
  } finally { await r.stop(); }
});

test("the command file is emptied once it is read and has grown; the journal is emptied when the helper starts and rotated when it grows, with snapshots", async () => {
  const r = await rig({ startIpc: false });
  try {
    fs.writeFileSync(path.join(r.dir, FILES.out), "old line that must not survive\n");
    r.ipc.start();
    assert.equal(readOut(r.dir).length >= 1, true);
    assert.ok(!fs.readFileSync(path.join(r.dir, FILES.out), "latin1").includes("old line"), "the journal begins empty");
    await openPath(r);
    const a = await inviteCode(r);
    await friend(r, a.code);
    await until(() => readOut(r.dir).find((l) => l.type === "joiner"));
    const b = await inviteCode(r); // stays open: it is part of the snapshot
    for (let i = 0; i < 60; i++) cmd(r.dir, "kick 99 " + "x".repeat(60));
    await until(() => fs.statSync(path.join(r.dir, FILES.cmd)).size === 0, 8000);
    // a journal past 32 KB is emptied, and what is still true is written again
    r.ipc.emitLine("status", "padding " + "y".repeat(150));
    for (let i = 0; i < 250; i++) fs.appendFileSync(path.join(r.dir, FILES.out), "1 status padding " + "z".repeat(150) + "\n");
    await until(() => outHas(r.dir, "status", /^rotated$/), 5000);
    const lines = readOut(r.dir);
    assert.ok(lines.length < 40, "emptied: " + lines.length);
    assert.ok(lines.find((l) => l.type === "joiner" && / snap$/.test(l.text)), "the friend is written again; journal: " + lines.map((l) => l.raw).join(" | "));
    assert.ok(lines.find((l) => l.type === "invite" && / snap$/.test(l.text) && l.text.startsWith(b.code)), "the open invite is written again");
  } finally { await r.stop(); }
});

test("a path the service forgets is opened again by itself, and the friends and invites it had are told gone", async () => {
  const r = await rig();
  try {
    await openPath(r);
    const a = await inviteCode(r);
    await friend(r, a.code);
    await until(() => readOut(r.dir).find((l) => l.type === "joiner"));
    const b = await inviteCode(r);
    clock += 70000; // the service's sweep sees a silent session; the helper's next poll is refused
    await until(() => outHas(r.dir, "error", /the relay forgot this path/), 12000);
    assert.ok(outHas(r.dir, "left", /^1 \w+$/), "the friend is told gone, with the reason the service or the helper had");
    assert.ok(outHas(r.dir, "invite-end", new RegExp("^" + b.id + " closed$")));
    clock = 0;
    await until(() => readOut(r.dir).filter((l) => l.type === "status" && /^opened /.test(l.text)).length === 2, 12000);
  } finally { await r.stop(); }
});

test("opening fails politely: a refused token, no relay address, and a relay that is not there are said once with their cause", async () => {
  const r = await rig({ ipc: { token: "wrong-token" } });
  try {
    writeState(r.dir);
    await until(() => outHas(r.dir, "error", /the relay refused the host token \(401\)/));
    assert.equal(r.ipc.host, null);
    const n = cmd(r.dir, "invite Mike");
    await until(() => outHas(r.dir, "error", /no invite: .*refused the host token/, n), 25000);
  } finally { await r.stop(); }
  const r2 = await rig({ ipc: { service: "http://127.0.0.1:1" } });
  try {
    writeState(r2.dir);
    await until(() => outHas(r2.dir, "error", /cannot reach the relay: ECONNREFUSED/));
  } finally { await r2.stop(); }
  const r3 = await rig({ ipc: { service: "", staleMs: 60000 } });
  try {
    writeState(r3.dir, { service: "" });
    await until(() => outHas(r3.dir, "error", /no relay address/));
    writeState(r3.dir, { service: BASE });
    await until(() => outHas(r3.dir, "status", /^opened /), 20000);
  } finally { await r3.stop(); }
});

// ---- the public listing ------------------------------------------------------------------------------------------------------------

test("public=1: the listing is posted at the cadence, signed, with the game's fields; public=0 withdraws it once; the plugin is told", async () => {
  const r = await rig();
  try {
    await openPath(r, { public: 1, name: "Mike's game", map: "h9_tsrp_hive", players: 3, maxplayers: 16, password: 1, require_account: 1, direct_public: 1 });
    await until(() => outHas(r.dir, "status", /^public listed PUBID1234567$/));
    await until(() => r.posts.length >= 3, 5000);
    const b = r.posts[0].body;
    assert.deepEqual(b, { public: true, name: "Mike's game", map: "h9_tsrp_hive", players: 3, max: 16, password: true, requireAccount: true, directPublic: true });
    assert.match(r.posts[0].sig, /^s=[^;]+;t=\d+;n=[0-9a-f]+;m=[0-9a-f]{64}$/);
    assert.equal(readOut(r.dir).filter((l) => l.text.startsWith("public listed")).length, 1, "said once, not per call");
    // the numbers follow the state
    writeState(r.dir, { public: 1, players: 5, name: "Mike's game", map: "h9_tsrp_hive", maxplayers: 16, password: 1, require_account: 1, direct_public: 1 });
    await until(() => r.posts.at(-1).body.players === 5, 3000);
    // direct_public needs direct
    writeState(r.dir, { public: 1, direct: 0, direct_public: 1, players: 5 });
    await until(() => r.posts.at(-1).body.directPublic === false, 3000);
    const before = r.posts.length;
    writeState(r.dir, { public: 0 });
    await until(() => r.posts.length > before && r.posts.at(-1).body.public === false);
    await until(() => outHas(r.dir, "status", /^public off$/));
    const after = r.posts.length;
    await wait(900);
    assert.equal(r.posts.length, after, "nothing is posted while public=0");
  } finally { await r.stop(); }
});

test("a public listing that is refused: 403 stops it with one error, 400 and failures are throttled, 401 reopens the path, the public command is answered", async () => {
  let mode = "403";
  const r = await rig({ listing: () => (mode === "403" ? { status: 403, json: { error: "listing disabled" } } : mode === "400" ? { status: 400, json: { error: "bad listing" } } : mode === "401" ? { status: 401, json: { error: "unauthorized" } } : { status: 200, json: { ok: true, ttl: 45, id: "PUBID1234567" } }) });
  try {
    await openPath(r, { public: 1 });
    await until(() => outHas(r.dir, "error", /does not list games \(403: listing disabled\)/));
    const n = r.posts.length;
    await wait(1000);
    assert.equal(r.posts.length, n, "no more posts after a 403 until the path opens again");
    assert.equal(readOut(r.dir).filter((l) => l.type === "error" && /does not list games/.test(l.text)).length, 1);

    // a new path forgets the refusal: 400 is throttled
    mode = "400";
    writeState(r.dir, { enabled: 0 });
    await until(() => outHas(r.dir, "status", /^closed h9_p2p is 0/));
    writeState(r.dir, { public: 1 });
    await until(() => outHas(r.dir, "error", /refused the public listing \(400: bad listing\)/));
    await wait(700);
    assert.equal(readOut(r.dir).filter((l) => l.type === "error" && /refused the public listing/.test(l.text)).length, 1, "the same refusal is said once");

    // a 401 means the relay forgot the path (switching public off and on again is an immediate retry)
    mode = "401";
    writeState(r.dir, { public: 0 });
    await wait(300);
    writeState(r.dir, { public: 1 });
    await until(() => outHas(r.dir, "error", /the relay forgot this path \(listing: unauthorized\)/), 8000);
    mode = "ok";
    await until(() => outHas(r.dir, "status", /^public listed /), 15000);

    // the public command is answered and switches the listing at once
    writeState(r.dir, { public: 0 });
    await until(() => outHas(r.dir, "status", /^public off$/));
    const c = cmd(r.dir, "public 1");
    await until(() => outHas(r.dir, "status", /^public listing on$/, c));
  } finally { await r.stop(); }
});

test("the listing never goes out without a session, and a listing endpoint that cannot be reached is said once and recovers", async () => {
  let dead = false;
  const r = await rig({ listing: () => (dead ? { destroy: true } : { status: 200, json: { ok: true, ttl: 45, id: "PUBID1234567" } }) });
  try {
    writeState(r.dir, { public: 1, enabled: 0 });
    await wait(500);
    assert.equal(r.posts.length, 0, "enabled=0: no session, no listing");
    dead = true;
    writeState(r.dir, { public: 1 });
    await until(() => outHas(r.dir, "error", /the public listing could not be posted: /));
    await wait(1000);
    assert.equal(readOut(r.dir).filter((l) => l.type === "error" && /could not be posted/.test(l.text)).length, 1, "a streak of failures is said once");
    assert.ok(!outHas(r.dir, "status", /^public listed /));
    dead = false;
    await until(() => outHas(r.dir, "status", /^public listed /));
  } finally { await r.stop(); }
});

test("a second helper for the same folder refuses to start (a pid file that is fresh), a stale pid file does not stop one; quit stops it and removes the file", async () => {
  const r = await rig({ startIpc: false });
  try {
    const pidFile = path.join(r.dir, FILES.pid);
    const fresh = "pid=4242\ntime=" + unix() + "\n";
    fs.writeFileSync(pidFile, fresh);
    const second = new HostIpc({ dir: r.dir, token: "x", log: () => {} });
    let err = null;
    try { second.start(); } catch (e) { err = e; }
    assert.equal(err && err.code, "running");
    assert.equal(err.pid, 4242);
    assert.equal(fs.readFileSync(pidFile, "latin1"), fresh, "the running helper's file is left alone");
    fs.writeFileSync(pidFile, "pid=4242\ntime=" + (unix() - 60) + "\n");
    r.ipc.start();
    assert.match(fs.readFileSync(pidFile, "latin1"), new RegExp("^pid=" + process.pid + "\\ntime=\\d+\\n$"), "a pid file that nobody keeps fresh is taken over");
    const stopped = new Promise((res) => r.ipc.once("stopped", res));
    cmd(r.dir, "quit");
    await stopped;
    assert.ok(!fs.existsSync(path.join(r.dir, FILES.pid)));
    assert.ok(outHas(r.dir, "status", /^stopped stopped on request$/));
  } finally { await r.stop(); }
});

test("idle exit: a game that never shows up ends the helper on its own, a disabled but fresh game does not", async () => {
  const r = await rig({ ipc: { idleExitMs: 900, staleMs: 800 } });
  try {
    const stopped = new Promise((res) => r.ipc.once("stopped", res));
    await stopped;
    assert.ok(outHas(r.dir, "status", /^stopped the game has been gone/));
  } finally { await r.stop(); }
  const r2 = await rig({ ipc: { idleExitMs: 900, staleMs: 2500 } });
  try {
    let gone = false;
    r2.ipc.once("stopped", () => { gone = true; });
    for (let i = 0; i < 6; i++) { writeState(r2.dir, { enabled: 0 }); await wait(300); }
    assert.equal(gone, false, "h9_p2p 0 is not a reason to leave");
  } finally { await r2.stop(); }
});
