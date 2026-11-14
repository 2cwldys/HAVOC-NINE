// Loopback tests of the protocol: the service, the host helper and the join helper in one process, on 127.0.0.1 only.
// Ports: HTTP 28247, UDP 27248 (service), 27249 (the fake game), 27251 (a joiner's local address).
//   node --test test/
// The NAT cases are in tests/ of the folder above (WSL network namespaces).

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import { createService } from "../lib/service.js";
import { HostHelper, JoinHelper, httpJson, signHeaders } from "../lib/helper.js";
import { encode, decodeHeader, verify, ReplayWindow, T, F_HOST, helloPayload, hostFlowKey, MIN_HELLO, publicUnicast } from "../lib/wire.js";
import { normaliseCode, formatCode, newCode, codeHash } from "../lib/codes.js";
import crypto from "node:crypto";

const HTTP_PORT = 28247;
const UDP_PORT = 27248;
const GAME_PORT = 27249;
const BASE = "http://127.0.0.1:" + HTTP_PORT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Every socket of these tests is on loopback: a wildcard bind would make Windows ask about the firewall.
const H = (o) => new HostHelper({ bindAddress: "127.0.0.1", allowPrivatePeers: true, ...o });
const J = (o) => new JoinHelper({ bindAddress: "127.0.0.1", allowPrivatePeers: true, ...o });
let clock = 0; // added to the service's clock

async function until(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(step);
  }
  throw new Error("timeout waiting for " + fn);
}

async function rig(over = {}) {
  const svc = createService({
    config: {
      publicUdp: { host: "127.0.0.1", port: UDP_PORT },
      bind: { http: { host: "127.0.0.1", port: HTTP_PORT }, udp: { host: "127.0.0.1", port: UDP_PORT } },
      allowPrivatePeers: true,
      dev: { hosts: { "host-tok": { id: 1, name: "owner" } }, accounts: { "friend-tok": { id: 7, name: "mike" } } },
      ...over,
    },
    now: () => Date.now() + clock,
  });
  const server = http.createServer((req, res) => svc.handleHttp(req, res));
  await svc.start();
  await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
  // the fake game: answers every datagram with "ECHO:" and the datagram, and remembers who wrote
  const game = dgram.createSocket("udp4");
  const seen = [];
  game.on("message", (m, r) => { seen.push(r.address + ":" + r.port); game.send(Buffer.concat([Buffer.from("ECHO:"), m]), r.port, r.address); });
  await new Promise((r) => game.bind(GAME_PORT, "127.0.0.1", r));
  const closers = [];
  return {
    svc, seen, game,
    track: (x) => { closers.push(x); return x; },
    async stop() {
      for (const c of closers) { try { await c.close(); } catch (e) { /* closed */ } }
      game.close();
      server.close();
      await svc.stop();
      clock = 0;
    },
  };
}

// a fake "game client": sends to a joiner's local address and waits for the echo
async function clientRoundTrip(listen, text, ms = 3000) {
  const s = dgram.createSocket("udp4");
  await new Promise((r) => s.bind(0, "127.0.0.1", r));
  const got = new Promise((resolve) => s.on("message", (m) => resolve(m.toString())));
  s.send(Buffer.from(text), listen.port, listen.host);
  const r = await Promise.race([got, wait(ms).then(() => null)]);
  s.close();
  return r;
}

test("wire: tag, tamper, replay window, header shape", () => {
  const key = crypto.randomBytes(32);
  const buf = encode({ type: T.DATA, flags: F_HOST, flow: 0x01020304, seq: 4294967299, payload: Buffer.from("hello") }, key);
  const h = decodeHeader(buf);
  assert.equal(h.type, T.DATA);
  assert.equal(h.flow, 0x01020304);
  assert.equal(h.seq, 4294967299);
  assert.equal(h.host, true);
  assert.ok(verify(buf, key));
  assert.ok(!verify(buf, crypto.randomBytes(32)));
  const bad = Buffer.from(buf);
  bad[20] ^= 1;
  assert.ok(!verify(bad, key));
  assert.equal(decodeHeader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x67])), null); // a game packet is not ours
  const w = new ReplayWindow(64);
  assert.ok(w.accept(5));
  assert.ok(!w.accept(5));
  assert.ok(w.accept(3));
  assert.ok(!w.accept(3));
  assert.ok(w.accept(200));
  assert.ok(!w.accept(100)); // older than the window
  assert.ok(w.accept(199));
});

test("codes: shape, normalising, hashing", () => {
  const c = newCode();
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(normaliseCode(formatCode(c)), c);
  assert.equal(normaliseCode("  " + formatCode(c).toLowerCase() + " "), c);
  assert.equal(normaliseCode("https://havoc9.org/join/" + formatCode(c)), c);
  assert.equal(normaliseCode("H9-OOOOO-IIIII"), "0000011111");
  assert.equal(normaliseCode("short"), null);
  assert.equal(normaliseCode("H9-UUUUU-UUUUU"), null); // U is not in the alphabet
  assert.notEqual(codeHash(c), codeHash(newCode()));
});

test("publicUnicast refuses private, loopback, CGNAT, link-local, multicast", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "0.0.0.0", "255.255.255.255"]) assert.equal(publicUnicast(ip), false, ip);
  for (const ip of ["8.8.8.8", "203.0.113.10", "198.51.100.10", "100.63.255.255", "172.32.0.1"]) assert.equal(publicUnicast(ip), true, ip);
  assert.equal(publicUnicast("127.0.0.1", true), true);
});

test("relay: host opens, invites, a joiner redeems, the game answers through the service; the game sees a loopback alias, not the joiner", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const joined = new Promise((res) => host.on("joiner", res));
    const inv = await host.invite({ label: "for Mike" });
    assert.match(inv.code, /^H9-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const join = r.track(J({ service: BASE, code: inv.code.toLowerCase(), listen: { host: "127.0.0.1", port: 27251 }, direct: false, allowPrivatePeers: true }));
    await join.start();
    const ready = await new Promise((res) => (join.ep.helloAcked ? res(true) : join.on("ready", res)));
    assert.ok(ready);
    const j = await joined;
    assert.equal(j.label, "for Mike");
    assert.equal(j.direct, false);
    assert.ok(!("ip" in j) && !JSON.stringify(j).match(/\d+\.\d+\.\d+\.\d+:\d+/) || j.loopback, "the joiner event names a loopback socket only");
    assert.match(j.loopback, /^127\./);
    const got = await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "ping-1");
    assert.equal(got, "ECHO:ping-1");
    assert.ok(r.seen.length >= 1 && r.seen.every((a) => a.startsWith("127.")), "the game saw loopback sources only");
    assert.equal(join.stats().path, "relay");
    assert.ok(r.svc.stats().relayed >= 2);
    assert.equal(r.svc.stats().punchInfo, 0, "relay-only: no endpoint was ever handed out");
    assert.equal(join.ep.peer, null);
    assert.equal(host.flows.get(j.flow).ep.peer, null);
  } finally { await r.stop(); }
});

test("the joiner's virtual address: auto binds a loopback alias on this OS and the game still answers", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({});
    const join = r.track(J({ service: BASE, code: inv.code, listen: { host: "auto", port: 27251 }, direct: false, allowPrivatePeers: true }));
    await join.start();
    assert.match(join.localAddress.address, /^127\.101\.\d+\.\d+$/);
    assert.equal(join.localAddress.address, host.virtual);
    await until(() => join.ep.helloAcked);
    const got = await clientRoundTrip({ host: join.localAddress.address, port: 27251 }, "via-alias");
    assert.equal(got, "ECHO:via-alias");
  } finally { await r.stop(); }
});

test("direct: both ends allow it, the punch succeeds, the flow moves to the direct leg, falls back to the relay when it dies and returns to it", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, allowPrivatePeers: true, bindAddress: "127.0.0.1" }));
    await host.open();
    const inv = await host.invite({ direct: true });
    const join = r.track(J({ service: BASE, code: inv.code, listen: { host: "127.0.0.1", port: 27251 }, allowPrivatePeers: true }));
    await join.start();
    await until(() => join.ep.path === "direct" && [...host.flows.values()].every((f) => f.ep && f.ep.path === "direct"), 8000);
    const before = join.stats().directRx;
    const got = await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "direct-1");
    assert.equal(got, "ECHO:direct-1");
    assert.ok(join.stats().directRx > before, "the answer came on the direct leg");
    assert.ok(r.svc.stats().punchInfo >= 1);
    // the direct leg dies (the host stops answering it): the flow falls back to the relay leg on its own
    const hf = [...host.flows.values()][0];
    const savedKey = hf.ep.pairKey;
    hf.ep.pairKey = crypto.randomBytes(32); // the direct leg dies: what the host sends on it no longer verifies, and what the friend sends is not heard
    // while the leg is only quiet (not yet declared dead) a datagram goes on both legs, so the game keeps being answered
    await wait(1400);
    assert.equal(await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "suspect-1"), "ECHO:suspect-1");
    await until(() => join.ep.path === "relay", 8000);
    const got2 = await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "fallback-1");
    assert.equal(got2, "ECHO:fallback-1");
    // the direct leg comes back: a new punch window has opened at both ends and the flow returns to it
    hf.ep.pairKey = savedKey;
    await until(() => join.ep.path === "direct" && hf.ep.path === "direct", 12000);
    assert.equal(await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "again-1"), "ECHO:again-1");
  } finally { await r.stop(); }
});

test("a wrong, an expired and a used code are refused with the same answer; a used one cannot be replayed", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({ ttl: 10 });
    const wrong = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: "H9-AAAAA-BBBBB" } });
    assert.equal(wrong.status, 404);
    // use it once
    const ok = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code } });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.flow && ok.json.jKey && ok.json.pairKey);
    const used = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code } });
    assert.equal(used.status, 404);
    assert.deepEqual(used.json, wrong.json, "used and unknown look the same");
    // expired
    const inv2 = await host.invite({ ttl: 10 });
    clock += 11000;
    const late = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv2.code } });
    assert.equal(late.status, 404);
    assert.deepEqual(late.json, wrong.json);
    // junk
    for (const body of [{}, { code: 12 }, { code: "x".repeat(5000) }]) {
      const rr = await httpJson(BASE, "/v1/join/redeem", { body });
      assert.ok([404, 413, 429].includes(rr.status), "junk gets " + rr.status);
    }
  } finally { await r.stop(); }
});

test("a revoked invite and a closed session are refused; a kicked joiner is closed", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({});
    await host.revoke({ invite: inv.id });
    assert.equal((await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code } })).status, 404);
    const inv2 = await host.invite({});
    const join = r.track(J({ service: BASE, code: inv2.code, listen: { host: "127.0.0.1", port: 27251 }, direct: false, allowPrivatePeers: true }));
    await join.start();
    await until(() => join.ep.helloAcked);
    const closed = new Promise((res) => join.on("closed", res));
    const flow = [...host.flows.keys()][0];
    await host.kick(flow);
    await Promise.race([closed, wait(4000).then(() => { throw new Error("joiner not told"); })]);
    assert.equal(r.svc.stats().flows, 0);
    const inv3 = await host.invite({});
    await host.close();
    assert.equal((await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv3.code } })).status, 404);
  } finally { await r.stop(); }
});

test("requireAccount: the invite needs the joiner's account token; the host sees the account name, never an address", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({ requireAccount: true });
    assert.equal((await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code } })).status, 404);
    assert.equal((await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code, account: "nope" } })).status, 404);
    const seen = new Promise((res) => host.on("joiner", res));
    const ok = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code, account: "friend-tok" } });
    assert.equal(ok.status, 200);
    const ev = await seen;
    assert.deepEqual(ev.account, { id: 7, name: "mike" });
    assert.match(ev.loopback || "127.", /^127\./);
  } finally { await r.stop(); }
});

test("host calls: unsigned, wrongly signed, replayed and stale requests are refused", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    assert.equal((await httpJson(BASE, "/v1/host/open", { body: {} })).status, 401, "no bearer");
    assert.equal((await httpJson(BASE, "/v1/host/open", { headers: { Authorization: "Bearer wrong" }, body: {} })).status, 401);
    assert.equal((await httpJson(BASE, "/v1/host/invite", { body: { ttl: 10 } })).status, 401, "unsigned");
    const sig = signHeaders("POST", "/v1/host/invite", host.session, crypto.randomBytes(32), { ttl: 10 });
    assert.equal((await httpJson(BASE, "/v1/host/invite", { headers: sig, body: { ttl: 10 } })).status, 401, "wrong key");
    const body = { ttl: 10 };
    const good = signHeaders("POST", "/v1/host/invite", host.session, host.hostKey, body);
    assert.equal((await httpJson(BASE, "/v1/host/invite", { headers: good, body })).status, 200);
    assert.equal((await httpJson(BASE, "/v1/host/invite", { headers: good, body })).status, 401, "the same signed request twice");
    const sigPath = signHeaders("POST", "/v1/host/revoke", host.session, host.hostKey, body);
    assert.equal((await httpJson(BASE, "/v1/host/invite", { headers: sigPath, body })).status, 401, "a signature for another path");
    clock += 120000;
    const stale = signHeaders("POST", "/v1/host/invite", host.session, host.hostKey, body); // made with the real clock, the service is 2 minutes ahead
    assert.equal((await httpJson(BASE, "/v1/host/invite", { headers: stale, body })).status, 401, "stale timestamp");
  } finally { await r.stop(); }
});

test("rate limits: a guesser is slowed, then blocked, and a good code is refused while it is blocked", async () => {
  const r = await rig({ limits: { redeemFailPerIp: { max: 3, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 3600 } } });
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({});
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: "H9-" + newCode().slice(0, 5) + "-" + newCode().slice(0, 5) } })).status);
    assert.ok(statuses.includes(429), "blocked after the failures: " + statuses.join(","));
    const good = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code } });
    assert.equal(good.status, 429, "the block holds even for a good code");
    assert.ok(good.retryAfter > 0);
  } finally { await r.stop(); }
});

test("UDP: forged, replayed, unknown-flow and short packets get NO answer; HELLO's answer is never bigger than the question", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({});
    const red = await httpJson(BASE, "/v1/join/redeem", { body: { v: 1, code: inv.code } });
    const flow = red.json.flow;
    const kJ = Buffer.from(red.json.jKey, "base64url");
    const s = dgram.createSocket("udp4");
    await new Promise((res) => s.bind(0, "127.0.0.1", res));
    const rx = [];
    s.on("message", (m) => rx.push(m));
    const send = (b) => s.send(b, UDP_PORT, "127.0.0.1");
    // garbage of every kind
    send(Buffer.from("hello"));
    send(Buffer.alloc(40, 0xff));
    send(encode({ type: T.HELLO, flow: flow + 1, seq: 1, payload: helloPayload(crypto.randomBytes(8)) }, kJ)); // unknown flow
    send(encode({ type: T.HELLO, flow, seq: 1, payload: helloPayload(crypto.randomBytes(8)) }, crypto.randomBytes(32))); // wrong key
    send(encode({ type: T.HELLO, flags: F_HOST, flow, seq: 1, payload: helloPayload(crypto.randomBytes(8)) }, kJ)); // joiner key on the host leg
    await wait(300);
    assert.equal(rx.length, 0, "nothing answered");
    // a good HELLO: answered, and the answer is not bigger
    const hello = encode({ type: T.HELLO, flags: 0, flow, seq: 1, payload: helloPayload(crypto.randomBytes(8)) }, kJ);
    assert.ok(hello.length >= MIN_HELLO);
    send(hello);
    await until(() => rx.length === 1);
    assert.ok(rx[0].length <= hello.length, "answer " + rx[0].length + " <= question " + hello.length);
    assert.ok(verify(rx[0], kJ));
    // the same packet again (a replay): silence
    send(hello);
    await wait(300);
    assert.equal(rx.length, 1, "a replayed packet is not answered");
    // a short HELLO (an amplification probe): its sender is not answered
    send(encode({ type: T.HELLO, flags: 0, flow, seq: 2, payload: Buffer.alloc(8) }, kJ));
    await wait(300);
    assert.equal(rx.length, 1);
    const st = r.svc.stats();
    assert.ok(st.drops.shape >= 2 && st.drops.noflow >= 1 && st.drops.badtag >= 2 && st.drops.replay >= 1 && st.drops["hello-short"] >= 1, JSON.stringify(st.drops));
    s.close();
  } finally { await r.stop(); }
});

test("UDP: a flood on one flow is rate limited; the relay does not pass more than the limits allow", async () => {
  const r = await rig({ limits: { flowPps: 100, flowPpsBurst: 200, flowBps: 1e9, flowBpsBurst: 1e9 } });
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false, allowPrivatePeers: true }));
    await host.open();
    const inv = await host.invite({});
    const join = r.track(J({ service: BASE, code: inv.code, listen: { host: "127.0.0.1", port: 27251 }, direct: false, allowPrivatePeers: true }));
    await join.start();
    await until(() => join.ep.helloAcked && [...host.flows.values()].every((f) => f.ep && f.ep.helloAcked));
    const flow = join.flow;
    const kJ = join.ep.relayKey;
    // flood from the helper's own socket (the address the flow is latched to) with VALID tags, faster than the flow's budget allows
    const before = r.seen.length;
    for (let i = 0; i < 3000; i++) join.sock.send(encode({ type: T.DATA, flags: 0, flow, seq: 1000000 + i, payload: Buffer.from("x") }, kJ), UDP_PORT, "127.0.0.1");
    await wait(800);
    const passed = r.seen.length - before;
    assert.ok(passed <= 260, "at most the burst plus a little: " + passed);
    assert.ok(r.svc.stats().drops["flow-rate"] > 2000, JSON.stringify(r.svc.stats().drops));
  } finally { await r.stop(); }
});

test("off is clean: a disabled service opens no UDP socket and answers 503", async () => {
  const svc = createService({ config: { enabled: false, bind: { http: { host: "127.0.0.1", port: HTTP_PORT }, udp: { host: "127.0.0.1", port: UDP_PORT } } } });
  const server = http.createServer((req, res) => svc.handleHttp(req, res));
  const info = await svc.start();
  assert.equal(info.udp, null);
  await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
  try {
    assert.equal((await httpJson(BASE, "/v1/health", { method: "GET" })).status, 503);
    assert.equal((await httpJson(BASE, "/v1/join/redeem", { body: { code: "H9-AAAAA-BBBBB" } })).status, 503);
    // and the UDP port is free: we can bind it ourselves
    const s = dgram.createSocket("udp4");
    await new Promise((res, rej) => { s.once("error", rej); s.bind(UDP_PORT, "127.0.0.1", res); });
    s.close();
  } finally { server.close(); await svc.stop(); }
});

test("switches: relay off at the service leaves direct working and drops relayed DATA; direct off never hands out an address", async () => {
  const r = await rig({ relay: { enabled: false } });
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, allowPrivatePeers: true, bindAddress: "127.0.0.1" }));
    await host.open();
    assert.equal(host.relay, false);
    const inv = await host.invite({ direct: true });
    const join = r.track(J({ service: BASE, code: inv.code, listen: { host: "127.0.0.1", port: 27251 }, allowPrivatePeers: true }));
    await join.start();
    await until(() => join.ep.path === "direct", 8000);
    assert.equal(await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "direct-only"), "ECHO:direct-only");
    assert.equal(r.svc.stats().relayed, 0);
  } finally { await r.stop(); }
  const r2 = await rig({ direct: { enabled: false } });
  try {
    const host = r2.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, allowPrivatePeers: true }));
    await host.open();
    assert.equal(host.direct, false);
    const inv = await host.invite({ direct: true });
    const join = r2.track(J({ service: BASE, code: inv.code, listen: { host: "127.0.0.1", port: 27251 }, allowPrivatePeers: true }));
    await join.start();
    await until(() => join.ep.helloAcked);
    assert.equal(await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "relay-only-by-service"), "ECHO:relay-only-by-service");
    assert.equal(r2.svc.stats().punchInfo, 0);
  } finally { await r2.stop(); }
});

test("idle session and flow are swept; limits on sessions per account", async () => {
  const r = await rig();
  try {
    const a = r.track(H({ service: BASE, token: "host-tok", direct: false, allowPrivatePeers: true }));
    await a.open();
    const b = r.track(H({ service: BASE, token: "host-tok", direct: false, allowPrivatePeers: true }));
    await b.open();
    await assert.rejects(() => H({ service: BASE, token: "host-tok" }).open(), /refused: 429/);
    assert.equal(r.svc.stats().sessions, 2);
    // silence: the clock jumps past the idle limit and the sweep runs
    clock += 60000;
    r.svc.sweep();
    assert.equal(r.svc.stats().sessions, 0);
  } finally { await r.stop(); }
});

test("consent: an invite made without direct stays on the relay although the host's session and the friend both allow direct", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT } }));
    await host.open();
    assert.equal(host.direct, true);
    const inv = await host.invite({}); // direct is off unless the host says so
    const join = r.track(J({ service: BASE, code: inv.code, listen: { host: "127.0.0.1", port: 27251 } }));
    await join.start();
    await until(() => join.ep.helloAcked && [...host.flows.values()].every((f) => f.ep && f.ep.helloAcked));
    await wait(1500);
    assert.equal(join.ep.path, "relay");
    assert.equal(join.ep.peer, null);
    assert.equal(r.svc.stats().punchInfo, 0);
    assert.equal(await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "consent"), "ECHO:consent");
  } finally { await r.stop(); }
});

test("a flood of forged packets that name a real flow does not starve it (the flow's budget is charged for verified packets only)", async () => {
  const r = await rig();
  try {
    const host = r.track(H({ service: BASE, token: "host-tok", game: { host: "127.0.0.1", port: GAME_PORT }, direct: false }));
    await host.open();
    const inv = await host.invite({});
    const join = r.track(J({ service: BASE, code: inv.code, listen: { host: "127.0.0.1", port: 27251 }, direct: false }));
    await join.start();
    await until(() => join.ep.helloAcked && [...host.flows.values()].every((f) => f.ep && f.ep.helloAcked));
    const s = dgram.createSocket("udp4");
    await new Promise((res) => s.bind(0, "127.0.0.1", res));
    const wrong = crypto.randomBytes(32);
    for (let i = 0; i < 3000; i++) s.send(encode({ type: T.DATA, flags: 0, flow: join.flow, seq: 5000 + i, payload: Buffer.from("forged") }, wrong), UDP_PORT, "127.0.0.1");
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await clientRoundTrip({ host: "127.0.0.1", port: 27251 }, "real-" + i)) === "ECHO:real-" + i) ok++;
    assert.equal(ok, 20, "all the real packets got through the flood");
    const d = r.svc.stats().drops;
    assert.ok((d.badtag || 0) + (d["flow-unlatched"] || 0) >= 1000, JSON.stringify(d));
    assert.ok((d.badtag || 0) <= 150, "only the small allowance reached the tag check: " + JSON.stringify(d));
    s.close();
  } finally { await r.stop(); }
});
