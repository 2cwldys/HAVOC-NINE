// The live server board (lib/servers.js, StatusPoller; GET /api/servers serves its snapshot): a
// server named by its own hostname, offline within a round of queries once it stops answering,
// greyed until expireSeconds after its last answer, then gone, and back with its next answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { ServerList, StatusPoller, validateServers } from "../lib/servers.js";

// A game server that answers A2S_INFO the way Xash does (the Source layout), as name.
function fakeServer(name, port = 0) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      if (msg.length < 5 || msg.readInt32LE(0) !== -1 || msg[4] !== 0x54) return;
      const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 49])];
      for (const t of [name, "h9_tsrp_hive", "ts", "Roleplay"]) parts.push(Buffer.from(t + "\0"));
      parts.push(Buffer.from([0, 0, 3, 16, 0, 0x64, 0x6c, 0, 0]), Buffer.from("0.21\0"));
      sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
    });
    sock.bind(port, "127.0.0.1", () => resolve(sock));
  });
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the board names a server as it names itself, marks it offline when it stops answering, drops it after the grace, and takes it back", async () => {
  const long = "Real Hostname" + String.fromCharCode(7) + " " + "x".repeat(80);
  let game = await fakeServer(long);
  const port = game.address().port;
  const list = new ServerList({});
  list.setEntries(validateServers({ servers: [{ name: "H9 local test", address: "203.0.113.10:27015", target: "127.0.0.1:" + port }] }).entries);
  const poller = new StatusPoller({ servers: list, pollSeconds: 0.3, timeoutMs: 100, expireSeconds: 1.5 });
  poller.start();
  try {
    const row = () => poller.snapshot().servers[0];

    let r = await until(() => row() && row().online && row());
    assert.ok(r.name.startsWith("Real Hostname x"), "its own hostname, cleaned: " + r.name);
    assert.ok(r.name.length <= 64, "and cut to 64 characters");
    assert.equal(r.players, 3);
    assert.equal(typeof r.ping_ms, "number");

    const quietAt = Date.now();
    game.close();
    r = await until(() => row() && row().online === false && row());
    assert.ok(Date.now() - quietAt < 1200, "offline within a round of queries and its retry");
    assert.equal(r.name, "H9 local test", "a server that does not answer goes by servers.json's name");
    assert.equal(r.players, 0);
    assert.equal(r.ping_ms, null);

    await until(() => !row(), 4000);
    assert.equal(poller.snapshot().servers.length, 0, "gone once expireSeconds have passed");

    game = await fakeServer("", port);
    r = await until(() => row() && row().online && row());
    assert.equal(r.name, "H9 local test", "an empty hostname falls back to servers.json's name");
    game.close();
    game = await fakeServer("Back Again", port);
    r = await until(() => row() && row().online && row().name === "Back Again" && row());
    assert.equal(r.players, 3);
  } finally {
    poller.stop();
    game.close();
  }
});

// A game server that answers A2S_INFO and, when rules is a Map, A2S_RULES with the challenge step.
function fakeRulesServer(rules) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const challenge = 0x1234abcd;
    sock.on("message", (msg, rinfo) => {
      if (msg.length < 5 || msg.readInt32LE(0) !== -1) return;
      if (msg[4] === 0x54) {
        const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 49])];
        for (const t of ["Locked Box", "h9_te_neuropolis", "ts", "Match Mode"]) parts.push(Buffer.from(t + "\0"));
        parts.push(Buffer.from([0, 0, 2, 16, 0, 0x64, 0x6c, 0, 0]), Buffer.from("0.21\0"));
        return sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
      }
      if (msg[4] !== 0x56 || !rules || msg.length < 9) return;
      if (msg.readInt32LE(5) !== challenge) {
        const a = Buffer.alloc(9);
        a.writeInt32LE(-1, 0);
        a[4] = 0x41;
        a.writeInt32LE(challenge, 5);
        return sock.send(a, rinfo.port, rinfo.address);
      }
      const head = Buffer.alloc(7);
      head.writeInt32LE(-1, 0);
      head[4] = 0x45;
      head.writeUInt16LE(rules.size, 5);
      sock.send(Buffer.concat([head, ...[...rules].map(([k, v]) => Buffer.from(k + "\0" + v + "\0"))]), rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => resolve(sock));
  });
}

test("the lock: a server whose rules say h9_require_account 1 requires an account; one whose rules go unanswered does not", async () => {
  const locked = await fakeRulesServer(new Map([["h9_require_account", "1"], ["mp_timelimit", "20"]]));
  const open = await fakeRulesServer(new Map([["h9_require_account", "0"]]));
  const silent = await fakeRulesServer(null);
  const list = new ServerList({});
  list.setEntries(validateServers({ servers: [
    { name: "Locked", address: "203.0.113.11:27015", target: "127.0.0.1:" + locked.address().port },
    { name: "Open", address: "203.0.113.12:27015", target: "127.0.0.1:" + open.address().port },
    { name: "Silent", address: "203.0.113.13:27015", target: "127.0.0.1:" + silent.address().port },
  ] }).entries);
  const poller = new StatusPoller({ servers: list, pollSeconds: 0.3, timeoutMs: 150, expireSeconds: 5, rulesSeconds: 0.2 });
  poller.start();
  try {
    const rows = () => new Map(poller.snapshot().servers.map((s) => [s.address, s]));
    await until(() => {
      const r = rows();
      const st = (k) => poller.state.get("127.0.0.1:" + k.address().port);
      return r.size === 3 && [locked, open, silent].every((k) => st(k) && st(k).rulesAt);
    }, 6000);
    const r = rows();
    assert.equal(r.get("203.0.113.11:27015").requireAccount, true);
    assert.equal(r.get("203.0.113.12:27015").requireAccount, false);
    assert.equal(r.get("203.0.113.13:27015").requireAccount, false, "no answer to the rules: not required");
    assert.equal(r.get("203.0.113.13:27015").online, true, "a server that answers its info stays online without rules");
  } finally {
    poller.stop();
    for (const s of [locked, open, silent]) s.close();
  }
});
