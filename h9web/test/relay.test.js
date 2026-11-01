// The relay: who may connect, the framing, the allowlist, the master, the events, the limits.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import dgram from "node:dgram";
import { startApp, request, signup, rawUpgrade, openRelay, frame, unframe, udpEcho, fakeGameServer, sleep, until, ORIGIN } from "./helpers.js";
import { readMasterReply } from "../lib/master.js";

const MASTER = "192.0.2.1:27010";

function engineQuery(info) {
  return Buffer.concat([Buffer.from([0x31, 0xff]), Buffer.from("0.0.0.0:0\0", "latin1"), Buffer.from(info + "\0", "latin1")]);
}

describe("relay", () => {
  let t;
  let echo;
  let echo2;
  let outsider;
  let game;
  let cookie;
  const sockets = [];

  before(async () => {
    echo = await udpEcho();
    echo2 = await udpEcho();
    outsider = await udpEcho();
    game = await fakeGameServer({ name: "Live One", map: "h9_te_neuropolis", players: 5, max: 16, bots: 2 });
    t = await startApp({
      relay: { maxSocketsPerAccount: 2, idleSeconds: 30 },
      limits: { signupPerIp: { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 } },
    }, {
      servers: [
        { name: "Echo", address: "127.0.0.1:" + echo.address().port },
        { name: "Public Echo", address: "203.0.113.50:27015", target: "127.0.0.1:" + echo2.address().port },
        { name: "Hidden", address: "127.0.0.1:" + game.address().port, listed: false },
        { name: "Other game", address: "203.0.113.60:27015", gamedir: "valve" },
      ],
    });
    cookie = await signup(t.base, "Neo");
  });

  after(async () => {
    for (const ws of sockets) try { ws.close(); } catch (e) { /* closed */ }
    await t.close();
    for (const s of [echo, echo2, outsider, game]) s.close();
  });

  async function relay(c = cookie) {
    const ws = await openRelay(t.port, c);
    sockets.push(ws);
    return ws;
  }

  test("refused: no session, a stranger's Origin, no Origin, a dead cookie, a suspended account", async () => {
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN })).status, 401);
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { origin: "https://evil.example", cookie })).status, 403);
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { cookie })).status, 403);
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie: "__Host-h9_session=" + "B".repeat(43) })).status, 401);
    assert.equal((await rawUpgrade(t.port, "/elsewhere", { origin: ORIGIN, cookie })).status, 404);
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie, "sec-websocket-version": "8" })).status, 426);
    const c = await signup(t.base, "Agent_Brown");
    const a = t.app.accounts.getByUsername("Agent_Brown");
    t.app.accounts.ban(a.id, Math.floor(Date.now() / 1000) + 600, null);
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie: c })).status, 401);
    const ok = await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie });
    assert.equal(ok.status, 101);
    ok.socket.destroy();
  });

  test("framing: a datagram to a listed server and its answer, both with the address in front", async () => {
    const ws = await relay();
    const to = "127.0.0.1:" + echo.address().port;
    ws.send(frame(to, Buffer.from("\xff\xff\xff\xffinfo 49", "latin1")));
    const m = unframe(await ws.next());
    assert.equal(m.address, to, "the source is the server");
    assert.equal(m.payload.toString("latin1"), "echo:\xff\xff\xff\xffinfo 49");
    assert.equal(echo.received.at(-1).msg.toString("latin1"), "\xff\xff\xff\xffinfo 49", "the server got the payload alone");
    const first = echo.received.at(-1).rinfo.port;
    ws.send(frame(to, Buffer.from("again")));
    await ws.next();
    assert.equal(echo.received.at(-1).rinfo.port, first, "one UDP port for the whole WebSocket");
    ws.close();
  });

  test("target: the page talks to the public address, the relay to the target", async () => {
    const ws = await relay();
    ws.send(frame("203.0.113.50:27015", Buffer.from("hello")));
    const m = unframe(await ws.next());
    assert.equal(m.address, "203.0.113.50:27015");
    assert.equal(m.payload.toString(), "echo:hello");
    assert.equal(echo2.received.length, 1);
    ws.close();
  });

  test("allowlist: nothing goes to an address that is not on servers.json, nothing comes from one", async () => {
    const ws = await relay();
    ws.send(frame("127.0.0.1:" + outsider.address().port, Buffer.from("let me out")));
    ws.send(frame("8.8.8.8:53", Buffer.from("dns?")));
    ws.send(frame("255.255.255.255:27015", Buffer.from("\xff\xff\xff\xffinfo 49", "latin1")));
    await sleep(300);
    assert.equal(outsider.received.length, 0, "the unlisted server got nothing");
    assert.equal(ws.inbox.length, 0);
    // a stranger who finds the relay's UDP port cannot reach the page
    const to = "127.0.0.1:" + echo.address().port;
    ws.send(frame(to, Buffer.from("x")));
    await ws.next();
    const relayPort = echo.received.at(-1).rinfo.port;
    const stranger = dgram.createSocket("udp4");
    await new Promise((r) => stranger.bind(0, "127.0.0.1", r));
    stranger.send(Buffer.from("spoofed"), relayPort, "127.0.0.1");
    await sleep(300);
    stranger.close();
    assert.equal(ws.inbox.length, 0, "the page got nothing from an unlisted source");
    ws.close();
  });

  test("master: the FWGS query gets the listed servers with the 7F block, from the master's address", async () => {
    const ws = await relay();
    ws.send(frame(MASTER, engineQuery("\\gamedir\\ts\\clver\\0.21\\nat\\0\\commit\\h9\\branch\\h9\\os\\emscripten\\arch\\wasm32\\buildnum\\4000\\key\\1")));
    const m = unframe(await ws.next());
    assert.equal(m.address, MASTER);
    assert.deepEqual([...m.payload.subarray(0, 7)], [0xff, 0xff, 0xff, 0xff, 0x66, 0x0a, 0x7f]);
    assert.deepEqual(readMasterReply(m.payload, { fwgs: true }), ["127.0.0.1:" + echo.address().port, "203.0.113.50:27015"],
      "listed servers of this gamedir only: not the hidden one, not the valve one");
    ws.close();
  });

  test("master: the GoldSrc form, and the whole list for no gamedir", async () => {
    const ws = await relay();
    ws.send(frame(MASTER, engineQuery("\\gamedir\\valve")));
    const m = unframe(await ws.next());
    assert.notEqual(m.payload[6], 0x7f);
    assert.deepEqual(readMasterReply(m.payload, { fwgs: false }), ["203.0.113.60:27015"]);
    ws.send(frame(MASTER, engineQuery("")));
    assert.equal(readMasterReply(unframe(await ws.next()).payload, { fwgs: false }).length, 3);
    ws.close();
  });

  test("bad messages close the socket: text 1003, short 1007, too big 1009", async () => {
    let ws = await relay();
    ws.send("text, not binary");
    assert.equal((await ws.closed).code, 1003);
    ws = await relay();
    ws.send(new Uint8Array([127, 0, 0]));
    assert.equal((await ws.closed).code, 1007);
    ws = await relay();
    ws.send(new Uint8Array(6 + 4097));
    assert.equal((await ws.closed).code, 1009);
    ws = await relay();
    ws.send(frame("127.0.0.1:" + echo.address().port, Buffer.alloc(4096, 1)));
    assert.equal(unframe(await ws.next()).payload.length, 5 + 4096, "the largest allowed datagram passes");
    ws.close();
  });

  test("socket cap per account", async () => {
    const c = await signup(t.base, "Tank");
    const a = await relay(c);
    const b = await relay(c);
    const third = await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie: c });
    assert.equal(third.status, 429);
    a.close();
    await a.closed;
    await until(async () => {
      const r = await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie: c });
      if (r.socket) r.socket.destroy();
      return r.status === 101;
    }, 3000, 100);
    b.close();
  });

  test("signing out closes the relay (4401); a suspension too (4403)", async () => {
    const c = await signup(t.base, "Dozer");
    const ws = await relay(c);
    await request(t.base, "POST", "/api/logout", { cookie: c });
    assert.equal((await ws.closed).code, 4401);
    const c2 = await signup(t.base, "Mouse");
    const ws2 = await relay(c2);
    const a = t.app.accounts.getByUsername("Mouse");
    t.app.accounts.ban(a.id, Math.floor(Date.now() / 1000) + 600, "test");
    assert.equal((await ws2.closed).code, 4403);
  });

  test("a session ended by another process (the admin script) is noticed within sessionCheckSeconds", async () => {
    const c = await signup(t.base, "Apoc");
    const ws = await relay(c);
    const a = t.app.accounts.getByUsername("Apoc");
    t.app.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(a.id);
    assert.equal((await ws.closed).code, 4401);
  });

  test("servers.json is read again when it changes", async () => {
    const ws = await relay();
    ws.send(frame("127.0.0.1:" + outsider.address().port, Buffer.from("before")));
    await sleep(200);
    assert.equal(outsider.received.length, 0);
    const list = JSON.parse(fs.readFileSync(t.serversFile, "utf8"));
    list.servers.push({ name: "Outsider", address: "127.0.0.1:" + outsider.address().port });
    fs.writeFileSync(t.serversFile, JSON.stringify(list));
    await until(() => t.app.servers.byAddress.has("127.0.0.1:" + outsider.address().port), 8000);
    ws.send(frame("127.0.0.1:" + outsider.address().port, Buffer.from("after")));
    assert.equal(unframe(await ws.next()).payload.toString(), "echo:after");
    ws.close();
  });

  test("events for modules: relay-open, relay-game-start on game traffic only, -end and relay-close on close", async () => {
    const c = await signup(t.base, "Morpheus");
    const id = t.app.accounts.getByUsername("Morpheus").id;
    const seen = [];
    const fns = ["relay-open", "relay-close", "relay-game-start", "relay-game-end"].map((n) => [n, (e) => { if (e.accountId === id) seen.push([n, e]); }]);
    for (const [n, fn] of fns) t.app.events.on(n, fn);
    try {
      const ws = await relay(c);
      await until(() => seen.length === 1);
      assert.deepEqual(seen[0], ["relay-open", { accountId: id }]);
      const to = "127.0.0.1:" + echo.address().port;
      ws.send(frame(to, Buffer.from("\xff\xff\xff\xffinfo 49", "latin1")));
      await ws.next();
      assert.equal(seen.length, 1, "a connectionless query is not playing");
      ws.send(frame(to, Buffer.from([1, 0, 0, 0, 9, 9])));
      await ws.next();
      ws.send(frame(to, Buffer.from([2, 0, 0, 0, 9, 9])));
      await ws.next();
      assert.deepEqual(seen.slice(1), [["relay-game-start", { accountId: id, server: to }]], "once per server");
      ws.close();
      await ws.closed;
      await until(() => seen.length === 4);
      assert.deepEqual(seen.slice(2), [["relay-game-end", { accountId: id, server: to }], ["relay-close", { accountId: id }]]);
    } finally {
      for (const [n, fn] of fns) t.app.events.off(n, fn);
    }
  });

  test("/api/servers: the live list, in the shape servers/index.html reads", async () => {
    // the hidden server answers queries but is not listed; list a visible copy of it
    const list = JSON.parse(fs.readFileSync(t.serversFile, "utf8"));
    list.servers = list.servers.filter((s) => s.name !== "Hidden");
    list.servers.push({ name: "HAVOC 9 Live", address: "127.0.0.1:" + game.address().port });
    fs.writeFileSync(t.serversFile, JSON.stringify(list));
    const s = await until(async () => {
      const r = await request(t.base, "GET", "/api/servers");
      return r.json.servers.find((x) => x.name === "HAVOC 9 Live");
    }, 10000, 200);
    assert.equal(s.map, "h9_te_neuropolis");
    assert.equal(s.players, 5);
    assert.equal(s.max, 16);
    assert.equal(s.bots, 2);
    assert.equal(s.kind, "ip");
    assert.equal(typeof s.ping_ms, "number");
  });
});

describe("relay limits", () => {
  let t;
  let echo;
  before(async () => {
    echo = await udpEcho();
    t = await startApp({
      relay: {
        idleSeconds: 1.5, abuseCloseSeconds: 2,
        perAccount: { packetsPerSecond: 5, packetBurst: 5, bytesPerSecond: 100000, byteBurst: 100000 },
      },
    }, { servers: [{ name: "Echo", address: "127.0.0.1:" + echo.address().port }] });
  });
  after(async () => {
    await t.close();
    echo.close();
  });

  test("datagrams per second per account: the excess is dropped, a flood is closed (4429)", async () => {
    const c = await signup(t.base, "Flood");
    const ws = await openRelay(t.port, c);
    const to = "127.0.0.1:" + echo.address().port;
    for (let i = 0; i < 40; i++) ws.send(frame(to, Buffer.from("p" + i)));
    await sleep(400);
    assert.ok(echo.received.length >= 5 && echo.received.length <= 8, "about the burst got through, not 40 (" + echo.received.length + ")");
    const timer = setInterval(() => { for (let i = 0; i < 30; i++) ws.send(frame(to, Buffer.from("f"))); }, 100);
    const closed = await ws.closed;
    clearInterval(timer);
    assert.equal(closed.code, 4429);
  });

  test("idle: no datagram from the page for idleSeconds closes it (4408)", async () => {
    const c = await signup(t.base, "Sleepy");
    const ws = await openRelay(t.port, c);
    const started = Date.now();
    assert.equal((await ws.closed).code, 4408);
    assert.ok(Date.now() - started >= 1400);
  });
});
