// The public list: a host lists its session, anybody asks the list for a one-use relay-only guest invite, and what stops abuse of
// either (listing spam, invite spam, enumeration, a stale listing, a host that is gone). The service runs in this process on
// 127.0.0.1 with ports the system picks, so these files run beside the others in one `node --test`.
//   node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import { createService } from "../lib/service.js";
import { HostHelper, JoinHelper, httpJson, signHeaders } from "../lib/helper.js";
import { unb64, normaliseCode } from "../lib/codes.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD = (id, extra = {}) => ({ public: true, name: id, map: "h9_tsrp_hive", players: 3, max: 16, password: false, ...extra });

// A service on loopback; `clock` is added to its clock, `ip` lets a request say which address it comes from (header X-Test-Ip), and a
// visitor's account comes from X-Test-Account ("id:name"), the way h9web's session would give it.
async function rig({ config = {}, auth = null, accounts = true } = {}) {
  let clock = 0;
  const svc = createService({
    config: {
      publicUdp: { host: "127.0.0.1", port: 1 },
      bind: { http: { host: "127.0.0.1", port: 0 }, udp: { host: "127.0.0.1", port: 0 } },
      allowPrivatePeers: true,
      dev: {
        hosts: { "host-tok": { id: 1, name: "owner" }, "host2-tok": { id: 2, name: "second" }, "quiet-tok": { id: 3, name: "quiet", public: false } },
        accounts: accounts ? { "friend-tok": { id: 7, name: "mike" } } : {},
      },
      ...config,
    },
    auth,
    now: () => Date.now() + clock,
    clientAddress: (req) => String(req.headers["x-test-ip"] || "127.0.0.1"),
    clientAccount: async (req) => {
      const v = String(req.headers["x-test-account"] || "");
      return v ? { id: Number(v.split(":")[0]), name: v.split(":")[1] } : null;
    },
  });
  const server = http.createServer((req, res) => svc.handleHttp(req, res));
  const started = await svc.start();
  svc.config.publicUdp.port = started.udp.port;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const closers = [];
  return {
    svc, base, started,
    advance: (ms) => { clock += ms; },
    track: (x) => { closers.push(x); return x; },
    get: (path, headers = {}) => httpJson(base, path, { method: "GET", headers }),
    post: (path, body, headers = {}) => httpJson(base, path, { headers, body }),
    async stop() {
      for (const c of closers) { try { await c.close(); } catch (e) { /* closed */ } }
      server.close();
      await svc.stop();
    },
    // a host with a session, made without the data plane: signed calls only, signed with the service's shifted clock
    async host(token = "host-tok", name = "Mike's game", open = {}) {
      const o = await httpJson(base, "/v1/host/open", { headers: { Authorization: "Bearer " + token }, body: { v: 1, name, ...open } });
      assert.equal(o.status, 200, JSON.stringify(o.json));
      const key = unb64(o.json.hostKey);
      const call = (path, body = {}) => {
        const raw = Buffer.from(JSON.stringify(body));
        const t = String(Date.now() + clock);
        const n = crypto.randomBytes(8).toString("hex");
        const m = crypto.createHmac("sha256", key).update("POST\n" + path + "\n" + t + "\n" + n + "\n" + crypto.createHash("sha256").update(raw).digest("hex")).digest("hex");
        return httpJson(base, path, { headers: { "X-H9-Sig": "s=" + o.json.session + ";t=" + t + ";n=" + n + ";m=" + m }, body });
      };
      return {
        session: o.json.session, key, call,
        list: (extra = {}) => call("/v1/host/listing", GOOD(name, extra)),
        unlist: () => call("/v1/host/listing", { public: false }),
        touch: () => call("/v1/host/revoke", {}), // any signed call keeps the session alive
        events: async () => (await call("/v1/host/poll", { wait: 1 })).json.events,
      };
    },
  };
}

async function twoHosts(r) {
  const a = await r.host("host-tok", "Alpha");
  const b = await r.host("host2-tok", "Beta");
  return [a, b];
}

test("the host lists its session: the answer, the public list's shape, and no address or session id anywhere in it", async () => {
  const r = await rig();
  try {
    assert.equal((await r.get("/v1/public")).json.sessions.length, 0, "an empty list is an empty list");
    const h = await r.host();
    const l = await h.list();
    assert.equal(l.status, 200);
    assert.equal(l.json.ok, true);
    assert.equal(l.json.ttl, 45);
    assert.match(l.json.id, /^[A-Za-z0-9_-]{12}$/);
    assert.notEqual(l.json.id, h.session, "the public id is not the session's own id");
    r.advance(6000);
    const list = await r.get("/v1/public");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.sessions, [{ id: l.json.id, name: "Mike's game", map: "h9_tsrp_hive", players: 3, max: 16, password: false, direct: false, account: false }]);
    // read the raw text: nothing of the session, its key or any address
    const raw = await new Promise((resolve) => http.get(r.base + "/v1/public", (res) => { let s = ""; res.on("data", (c) => { s += c; }); res.on("end", () => resolve(s)); }));
    for (const secret of [h.session, Buffer.from(h.key).toString("base64url"), "127.0.0.1", "hostKey", "\"session\""]) assert.ok(!raw.includes(secret), "the list must not contain " + secret);
    const again = await h.list();
    assert.equal(again.json.id, l.json.id, "the public id is the session's for as long as it lives");
  } finally { await r.stop(); }
});

test("a listing's strings and numbers are made safe, and a wrong type is refused", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const l = await h.call("/v1/host/listing", { public: true, name: "x".repeat(90) + "\u00e9\u0007", map: "h9/../map<b>_1.5+x", players: 9999, max: -4, password: true });
    assert.equal(l.status, 200);
    r.advance(6000);
    const e = (await r.get("/v1/public")).json.sessions[0];
    assert.equal(e.name.length, 64);
    assert.equal(e.name, "x".repeat(64));
    assert.equal(e.map, "h9..mapb_1.5+x".slice(0, 32), "only A-Za-z0-9_.+- stay");
    assert.equal(e.players, 128);
    assert.equal(e.max, 0);
    assert.equal(e.password, true);
    await h.call("/v1/host/listing", { public: true, name: "caf\u00e9 \u0007x" });
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions[0].name, "caf? ?x", "non-printable and non-ASCII become ?");
    for (const bad of [{}, { public: "yes" }, { public: 1 }, { public: true, name: 5 }, { public: true, players: "3" }, { public: true, password: "no" }, { public: true, requireAccount: 1 }, { public: true, directPublic: "x" }]) {
      const x = await h.call("/v1/host/listing", bad);
      assert.equal(x.status, 400, JSON.stringify(bad));
      assert.deepEqual(x.json, { error: "bad listing" });
    }
    // unsigned and wrongly signed
    assert.equal((await r.post("/v1/host/listing", GOOD("x"))).status, 401);
    assert.equal((await r.post("/v1/host/listing", GOOD("x"), { "X-H9-Sig": "s=" + h.session + ";t=1;n=2;m=00" })).status, 401);
  } finally { await r.stop(); }
});

test("a listing without a name (or with an empty one) shows the game's own name", async () => {
  const r = await rig();
  try {
    const h = await r.host("host-tok", "Mike's game");
    await h.call("/v1/host/listing", { public: true });
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions[0].name, "Mike's game");
    await h.call("/v1/host/listing", { public: true, name: "" });
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions[0].name, "Mike's game");
    await h.call("/v1/host/listing", { public: true, name: "Renamed" });
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions[0].name, "Renamed", "and a new name replaces it");
  } finally { await r.stop(); }
});

test("the public list is computed once per 5 seconds for everybody, most populated first", async () => {
  const r = await rig();
  try {
    const [a, b] = await twoHosts(r);
    await a.call("/v1/host/listing", GOOD("A", { name: "Alpha", players: 2 }));
    await b.call("/v1/host/listing", GOOD("B", { name: "Beta", players: 9 }));
    r.advance(6000);
    const first = (await r.get("/v1/public")).json.sessions;
    assert.deepEqual(first.map((s) => s.name), ["Beta", "Alpha"]);
    await a.call("/v1/host/listing", GOOD("A", { name: "Alpha", players: 12 }));
    r.advance(2000);
    assert.deepEqual((await r.get("/v1/public")).json.sessions.map((s) => s.players), [9, 2], "inside the 5 seconds the answer is the same one");
    r.advance(3100);
    assert.deepEqual((await r.get("/v1/public")).json.sessions.map((s) => s.players), [12, 9]);
  } finally { await r.stop(); }
});

test("an entry goes 45 seconds after its last call, with the host's session still open, and takes its guest invites with it", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const l = await h.list();
    const j = await r.post("/v1/public/join", { session: l.json.id });
    assert.equal(j.status, 200);
    r.advance(30000);
    await h.touch();
    assert.equal((await r.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.0.0.2" })).status, 200, "still listed at 30 s");
    r.advance(16000);
    await h.touch();
    r.svc.sweep();
    assert.equal((await r.get("/v1/public")).json.sessions.length, 0, "gone at 46 s without a new listing call");
    assert.equal((await r.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.0.0.3" })).status, 404, "a stale entry is refused");
    assert.equal((await r.post("/v1/join/redeem", { v: 1, code: j.json.code })).status, 404, "its unspent guest invite is dead");
    assert.equal(r.svc._debug.invites.size, 0, "nothing of them is kept");
    const back = await h.list();
    assert.equal(back.json.id, l.json.id, "listing again brings the same entry back");
  } finally { await r.stop(); }
});

test("a host that closes or goes silent is off the list and its code is dead", async () => {
  const r = await rig();
  try {
    const [a, b] = await twoHosts(r);
    const la = await a.list();
    await b.list();
    const ja = await r.post("/v1/public/join", { session: la.json.id });
    assert.equal(ja.status, 200);
    await a.call("/v1/host/close", {});
    r.advance(6000);
    assert.deepEqual((await r.get("/v1/public")).json.sessions.map((s) => s.name), ["Beta"]);
    assert.equal((await r.post("/v1/public/join", { session: la.json.id }, { "x-test-ip": "10.0.0.2" })).status, 404);
    assert.equal((await r.post("/v1/join/redeem", { v: 1, code: ja.json.code })).status, 404);
    assert.equal(r.svc._debug.publicById.size, 1, "the public id of the closed session is forgotten");
    r.advance(50000); // Beta says nothing for 56 s: its session is idle and goes
    r.svc.sweep();
    assert.equal((await r.get("/v1/public")).json.sessions.length, 0);
    assert.equal(r.svc._debug.sessions.size, 0);
    assert.equal(r.svc._debug.publicById.size, 0);
  } finally { await r.stop(); }
});

test("a public guest invite: one use, ten minutes, bound to its session, relay-only; the host sees a public joiner", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const l = await h.list();
    const t0 = Math.floor(Date.now() / 1000);
    const j = await r.post("/v1/public/join", { session: l.json.id });
    assert.equal(j.status, 200);
    assert.match(j.json.code, /^H9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.equal(j.json.ttl, 600);
    assert.ok(Math.abs(j.json.expires - (t0 + 600)) <= 3, "expires is unix SECONDS, ten minutes ahead: " + j.json.expires);
    assert.deepEqual(Object.keys(j.json).sort(), ["code", "expires", "map", "name", "password", "ttl"]);
    const red = await r.post("/v1/join/redeem", { v: 1, code: j.json.code, direct: true });
    assert.equal(red.status, 200);
    assert.equal(red.json.direct, false, "relay-only although the host's session and the guest both allow direct");
    const ev = (await h.events()).find((e) => e.t === "joiner");
    assert.equal(ev.public, true);
    assert.equal(ev.label, "public");
    assert.equal(ev.account, null);
    assert.equal(ev.direct, false);
    assert.equal(JSON.stringify(ev).includes("127.0.0.1"), false, "no address in the event");
    assert.equal((await r.post("/v1/join/redeem", { v: 1, code: j.json.code })).status, 404, "one use");
    const j2 = await r.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.0.0.2" });
    r.advance(601000);
    assert.equal((await r.post("/v1/join/redeem", { v: 1, code: j2.json.code }, { "x-test-ip": "10.0.0.3" })).status, 404, "ten minutes");
  } finally { await r.stop(); }
});

test("directPublic: only when the host lists it, and still only with the session's own direct switch", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const l = await h.list({ directPublic: true });
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions[0].direct, true);
    const j = await r.post("/v1/public/join", { session: l.json.id });
    const red = await r.post("/v1/join/redeem", { v: 1, code: j.json.code });
    assert.equal(red.json.direct, true);
    const noDirect = await r.host("host2-tok", "NoDirect", { directAllowed: false });
    const l2 = await noDirect.list({ directPublic: true });
    const j2 = await r.post("/v1/public/join", { session: l2.json.id }, { "x-test-ip": "10.0.0.4" });
    const red2 = await r.post("/v1/join/redeem", { v: 1, code: j2.json.code }, { "x-test-ip": "10.0.0.4" });
    assert.equal(red2.json.direct, false, "the session's h9_p2p_direct 0 wins");
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions.find((s) => s.id === l2.json.id).direct, false);
  } finally { await r.stop(); }
});

test("delisting takes the entry and the unspent public invites away, and leaves the guests already in", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const l = await h.list();
    const a = await r.post("/v1/public/join", { session: l.json.id });
    const b = await r.post("/v1/public/join", { session: l.json.id });
    await r.post("/v1/join/redeem", { v: 1, code: a.json.code });
    const off = await h.unlist();
    assert.deepEqual(off.json, { ok: true, ttl: 0, revoked: 1 });
    assert.equal((await r.post("/v1/join/redeem", { v: 1, code: b.json.code })).status, 404);
    assert.equal(r.svc._debug.flows.size, 1, "the guest who is in stays; the host kicks");
    assert.equal((await r.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.0.0.2" })).status, 404);
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions.length, 0);
    assert.deepEqual((await h.unlist()).json, { ok: true, ttl: 0, revoked: 0 }, "delisting twice is fine");
  } finally { await r.stop(); }
});

test("one answer for unknown, unlisted, stale, gone and full; the failures of an address block that address, not another", async () => {
  const r = await rig({ config: { limits: { publicJoinPerIp: { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 } } } });
  try {
    const [a, b] = await twoHosts(r);
    const la = await a.list();
    const answers = [];
    answers.push(await r.post("/v1/public/join", { session: "AAAAAAAAAAAA" }));
    answers.push(await r.post("/v1/public/join", { session: b.session }));
    answers.push(await r.post("/v1/public/join", { session: "x".repeat(12) }));
    for (const x of answers) {
      assert.equal(x.status, 404);
      assert.deepEqual(x.json, { error: "unavailable" });
    }
    assert.equal((await r.post("/v1/public/join", { session: la.json.id })).status, 200, "a real id still works");
    // enumeration: ten refusals inside a minute block the address, a real id included
    const seen = [];
    for (let i = 0; i < 14; i++) seen.push((await r.post("/v1/public/join", { session: crypto.randomBytes(9).toString("base64url") }, { "x-test-ip": "10.9.9.9" })).status);
    assert.ok(seen.includes(429), "blocked: " + seen.join(","));
    assert.equal(seen[0], 404);
    const blocked = await r.post("/v1/public/join", { session: la.json.id }, { "x-test-ip": "10.9.9.9" });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.retryAfter >= 1);
    assert.equal((await r.post("/v1/public/join", { session: la.json.id }, { "x-test-ip": "10.8.8.8" })).status, 200, "another address is not affected");
    // a body that is not ours counts too, and is a 400 not a crash
    assert.equal((await r.post("/v1/public/join", { nope: 1 }, { "x-test-ip": "10.7.7.7" })).status, 400);
    assert.equal((await r.post("/v1/public/join", { session: 5 }, { "x-test-ip": "10.7.7.7" })).status, 400);
    assert.equal((await r.post("/v1/public/join", { session: "x".repeat(200) }, { "x-test-ip": "10.7.7.7" })).status, 400);
  } finally { await r.stop(); }
});

test("invite spam: per address, per account, per session and for the whole service", async () => {
  const r = await rig({ config: { limits: { publicInvitesPerSession: 50, publicFlowsPerSession: 50 } } });
  try {
    const h = await r.host();
    const l = await h.list();
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await r.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.1.1.1" })).status);
    assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200], "six an address and minute");
    assert.ok(statuses.slice(6).every((s) => s === 429), "then 429: " + statuses.join(","));
    const limited = await r.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.1.1.1" });
    assert.equal(limited.status, 429);
    assert.ok(limited.retryAfter >= 1, "Retry-After says when");
  } finally { await r.stop(); }
  const wide = { publicJoinPerIp: { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 }, publicFailPerIp: { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 } };
  const r2 = await rig({ config: { limits: { ...wide, publicJoinPerAccount: { max: 2, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 3600 }, publicInvitesPerSession: 50, publicFlowsPerSession: 50 } } });
  try {
    const h = await r2.host();
    const l = await h.list();
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await r2.post("/v1/public/join", { session: l.json.id }, { "x-test-account": "9:visitor" })).status);
    assert.deepEqual(s, [200, 200, 429, 429], "per account");
    assert.equal((await r2.post("/v1/public/join", { session: l.json.id }, { "x-test-account": "10:other" })).status, 200, "another account is not affected");
  } finally { await r2.stop(); }
  const r3 = await rig({ config: { limits: { ...wide, publicJoinPerSession: { max: 3, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 3600 }, publicInvitesPerSession: 50, publicFlowsPerSession: 50 } } });
  try {
    const h = await r3.host();
    const l = await h.list();
    const s = [];
    for (let i = 0; i < 5; i++) s.push((await r3.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.2.2." + i })).status);
    assert.deepEqual(s, [200, 200, 200, 429, 429], "per session");
  } finally { await r3.stop(); }
  const r4 = await rig({ config: { limits: { ...wide, publicJoinGlobalPerMinute: 2, publicInvitesPerSession: 50, publicFlowsPerSession: 50 } } });
  try {
    const h = await r4.host();
    const l = await h.list();
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await r4.post("/v1/public/join", { session: l.json.id }, { "x-test-ip": "10.3.3." + i })).status);
    assert.deepEqual(s, [200, 200, 429, 429], "the whole service");
  } finally { await r4.stop(); }
});

test("caps: 4 unspent public invites, 8 public guests, and strangers cannot take the host's own room", async () => {
  const wide = { publicJoinPerIp: { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 }, publicJoinPerSession: { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 } };
  const r = await rig({ config: { limits: wide } });
  try {
    const h = await r.host();
    const l = await h.list();
    const mint = async () => (await r.post("/v1/public/join", { session: l.json.id })).status;
    assert.deepEqual([await mint(), await mint(), await mint(), await mint(), await mint()], [200, 200, 200, 200, 404], "four unspent");
    const own = [];
    for (let i = 0; i < 16; i++) own.push((await h.call("/v1/host/invite", { label: "f" + i })).status);
    assert.ok(own.every((s) => s === 200), "the host's own 16 invites are not counted against the strangers' 4: " + own.join(","));
    assert.equal([...r.svc._debug.invites.values()].filter((i) => i.public).length, 4);
  } finally { await r.stop(); }
  const r2 = await rig({ config: { limits: wide } });
  try {
    const h = await r2.host();
    const l = await h.list();
    let in_ = 0;
    for (let i = 0; i < 12; i++) {
      const x = await r2.post("/v1/public/join", { session: l.json.id });
      if (x.status !== 200) break;
      const red = await r2.post("/v1/join/redeem", { v: 1, code: x.json.code });
      if (red.status === 200) in_++;
    }
    assert.equal(in_, 8, "eight public guests, then no more");
    assert.equal((await r2.post("/v1/public/join", { session: l.json.id })).status, 404);
    const own = await h.call("/v1/host/invite", { label: "mine" });
    const mine = await r2.post("/v1/join/redeem", { v: 1, code: own.json.code });
    assert.equal(mine.status, 200, "the host's own friend still gets in (16 flows per session, 8 of them public at most)");
    // a guest leaves: room again
    const flow = [...r2.svc._debug.flows.values()].find((f) => f.public);
    await h.call("/v1/host/revoke", { flow: flow.id });
    assert.equal((await r2.post("/v1/public/join", { session: l.json.id })).status, 200);
  } finally { await r2.stop(); }
});

test("require account: no account, no code; the account is bound to the invite and the host sees its name", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const l = await h.list({ requireAccount: true });
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions[0].account, true);
    const anon = await r.post("/v1/public/join", { session: l.json.id });
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.json, { error: "account required" });
    assert.equal((await r.post("/v1/public/join", { session: l.json.id, account: "nope" })).status, 401, "a token nobody knows is no account");
    const viaToken = await r.post("/v1/public/join", { session: l.json.id, account: "friend-tok" });
    assert.equal(viaToken.status, 200);
    const red = await r.post("/v1/join/redeem", { v: 1, code: viaToken.json.code });
    assert.equal(red.status, 200, "the guest needs nothing but the code: the account was bound when it was asked for");
    let ev = (await h.events()).find((e) => e.t === "joiner");
    assert.deepEqual(ev.account, { id: 7, name: "mike" });
    assert.equal(ev.public, true);
    const viaSession = await r.post("/v1/public/join", { session: l.json.id }, { "x-test-account": "9:visitor" });
    assert.equal(viaSession.status, 200, "a signed-in visitor of the site needs no token");
    await r.post("/v1/join/redeem", { v: 1, code: viaSession.json.code });
    ev = (await h.events()).find((e) => e.t === "joiner");
    assert.deepEqual(ev.account, { id: 9, name: "visitor" });
    // without the rule an account is still passed on to the host when there is one
    const open = await r.host("host2-tok", "Open");
    const lo = await open.list();
    const named = await r.post("/v1/public/join", { session: lo.json.id }, { "x-test-account": "9:visitor", "x-test-ip": "10.0.0.9" });
    await r.post("/v1/join/redeem", { v: 1, code: named.json.code }, { "x-test-ip": "10.0.0.9" });
    assert.deepEqual((await open.events()).find((e) => e.t === "joiner").account, { id: 9, name: "visitor" });
  } finally { await r.stop(); }
});

test("a service with no account check refuses require-account invites and listings, plainly", async () => {
  const noAccounts = { host: (t) => (t === "host-tok" ? { id: 1, name: "owner" } : null), account: () => null, accountsAvailable: false };
  const r = await rig({ auth: noAccounts });
  try {
    const h = await r.host();
    const l = await h.list({ requireAccount: true });
    assert.equal(l.status, 400);
    assert.deepEqual(l.json, { error: "accounts unavailable" });
    const inv = await h.call("/v1/host/invite", { requireAccount: true });
    assert.equal(inv.status, 400);
    assert.deepEqual(inv.json, { error: "accounts unavailable" });
    assert.equal((await h.call("/v1/host/invite", {})).status, 200, "an ordinary invite is fine");
    assert.equal((await h.list()).status, 200, "an ordinary listing is fine");
  } finally { await r.stop(); }
});

test("off is clean: with listing off the three calls say so and nothing is kept; a token without the right to list is refused", async () => {
  const r = await rig({ config: { listing: { enabled: false } } });
  try {
    assert.equal((await r.get("/v1/health")).json.listing, false);
    const h = await r.host();
    const l = await h.list();
    assert.equal(l.status, 403);
    assert.deepEqual(l.json, { error: "listing disabled" });
    assert.deepEqual((await h.unlist()).json, { ok: true, ttl: 0, revoked: 0 }, "taking an entry off the list still works");
    const pub = await r.get("/v1/public");
    assert.equal(pub.status, 404);
    const join = await r.post("/v1/public/join", { session: "AAAAAAAAAAAA" });
    assert.equal(join.status, 404);
    assert.deepEqual(join.json, { error: "not found" });
    assert.equal(r.svc._debug.publicById.size, 0);
    assert.equal(r.svc.stats().listed, 0);
  } finally { await r.stop(); }
  const r2 = await rig();
  try {
    assert.equal((await r2.get("/v1/health")).json.listing, true);
    const quiet = await r2.host("quiet-tok", "Quiet");
    const l = await quiet.list();
    assert.equal(l.status, 403, "hosts.json public false");
    const noRelay = await r2.host("host-tok", "NoRelay", { relayAllowed: false });
    const l2 = await noRelay.list();
    assert.equal(l2.status, 400);
    assert.deepEqual(l2.json, { error: "relay off" }, "a public guest is relay-only: a session with no relay cannot be listed");
  } finally { await r2.stop(); }
});

test("listing spam: a host's listing calls are limited per session, and readers of the list per address", async () => {
  const r = await rig();
  try {
    const h = await r.host();
    const s = [];
    for (let i = 0; i < 13; i++) s.push((await h.list()).status);
    assert.deepEqual(s.slice(0, 10), new Array(10).fill(200));
    assert.ok(s.slice(10).every((x) => x === 429), "more than 10 a minute is refused: " + s.join(","));
    const slow = await h.list();
    assert.equal(slow.status, 429);
    assert.ok(slow.retryAfter >= 1);
    assert.equal((await h.unlist()).status, 429, "the limit counts every call of the session; it is far above the helper's 4 a minute");
  } finally { await r.stop(); }
  // readers: 30 a minute per address, then 429; the cache means the service computes the list once per 5 s
  const r3 = await rig();
  try {
    const h = await r3.host();
    await h.list();
    const codes = [];
    for (let i = 0; i < 33; i++) codes.push((await r3.get("/v1/public")).status);
    assert.equal(codes.filter((c) => c === 200).length, 30);
    assert.ok(codes.slice(30).every((c) => c === 429));
    assert.equal((await r3.get("/v1/public", { "x-test-ip": "10.4.4.4" })).status, 200, "another reader is not affected");
  } finally { await r3.stop(); }
});

test("the public list holds at most listedMax entries and says 'list full' to the next host", async () => {
  const r = await rig({ config: { limits: { listedMax: 2 } }, auth: { host: (t) => ({ id: t, name: "h" + t }), account: () => null } });
  try {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const h = await r.host("t" + i, "G" + i);
      const l = await h.list();
      out.push(l.status);
    }
    assert.deepEqual(out, [200, 200, 429, 429]);
    r.advance(6000);
    assert.equal((await r.get("/v1/public")).json.sessions.length, 2);
  } finally { await r.stop(); }
});

// ---- the whole path, with the real helpers and a fake game ------------------------------------------------------------------

async function freeUdpPort() {
  const s = dgram.createSocket("udp4");
  await new Promise((res) => s.bind(0, "127.0.0.1", res));
  const p = s.address().port;
  s.close();
  return p;
}

test("a public guest plays through the relay: list, ask the list, redeem, talk to the game", async () => {
  const r = await rig();
  const game = dgram.createSocket("udp4");
  game.on("message", (m, rinfo) => game.send(Buffer.concat([Buffer.from("ECHO:"), m]), rinfo.port, rinfo.address));
  await new Promise((res) => game.bind(0, "127.0.0.1", res));
  try {
    const host = r.track(new HostHelper({ service: r.base, token: "host-tok", game: { host: "127.0.0.1", port: game.address().port }, direct: false, bindAddress: "127.0.0.1", allowPrivatePeers: true }));
    await host.open();
    const joined = new Promise((res) => host.on("joiner", res));
    const body = GOOD("live");
    const l = await httpJson(r.base, "/v1/host/listing", { headers: signHeaders("POST", "/v1/host/listing", host.session, host.hostKey, body), body });
    assert.equal(l.status, 200);
    const list = await r.get("/v1/public");
    assert.equal(list.status, 200);
    const j = await r.post("/v1/public/join", { session: list.json.sessions[0].id });
    assert.equal(j.status, 200);
    const listen = { host: "127.0.0.1", port: await freeUdpPort() };
    const guest = r.track(new JoinHelper({ service: r.base, code: j.json.code, listen, direct: false, bindAddress: "127.0.0.1", allowPrivatePeers: true }));
    await guest.start();
    const ready = await Promise.race([new Promise((res) => (guest.ep.helloAcked ? res(true) : guest.on("ready", res))), wait(5000).then(() => false)]);
    assert.ok(ready, "the guest's helper reached the relay");
    const ev = await Promise.race([joined, wait(5000).then(() => { throw new Error("the host saw no joiner"); })]);
    assert.equal(ev.label, "public");
    const c = dgram.createSocket("udp4");
    try {
      await new Promise((res) => c.bind(0, "127.0.0.1", res));
      const got = new Promise((res) => c.on("message", (m) => res(m.toString())));
      c.send(Buffer.from("hello-public"), listen.port, listen.host);
      assert.equal(await Promise.race([got, wait(4000).then(() => null)]), "ECHO:hello-public");
    } finally { c.close(); }
    assert.equal(normaliseCode(j.json.code).length, 10);
    const stats = r.svc.stats();
    assert.equal(stats.publicJoins, 1);
    assert.equal(stats.relayed > 0, true, "it went through the relay");
  } finally {
    game.close();
    await r.stop();
  }
});
