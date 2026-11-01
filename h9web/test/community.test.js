// Enrollment (modules/presence/enroll.js, a2s.js) and communities (community.js): keys without
// hand-made files, proven over A2S_RULES; communities, their chat, sanctions, find and shared data.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { startApp, request, signup, sleep } from "./helpers.js";
import { migrate, transaction } from "../lib/db.js";
import { HttpError, clientIp } from "../lib/http.js";
import { RateLimiter, ipKey } from "../lib/ratelimit.js";
import { serverClientId } from "../lib/playerid.js";
import { parseAddress } from "../lib/servers.js";
import { serversHook } from "../lib/modules.js";
import { createPresence, MIGRATIONS, DEFAULTS } from "../modules/presence/index.js";
import { writeKeys } from "../modules/presence/keys.js";
import { queryRules, parseRules } from "../modules/presence/a2s.js";
import { chatText, reasonText } from "../modules/presence/community.js";

const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const CORE_ROOMY = { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY };
const roomy = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
const PASSWORD = "correct horse battery staple";
const DEV1 = "11".repeat(16);
const DEV2 = "22".repeat(16);
const LISTED = "203.0.113.10:27015"; // on servers.json, with a hand-made key
const LISTED_KEY = crypto.randomBytes(32).toString("hex");

const hmacHex = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const randomHex = (n) => crypto.randomBytes(n).toString("hex");

// A UDP server that answers A2S_RULES the way FWGS does: a challenge first, then the rules; with
// split, in two HLDS-style parts.
function fakeRules({ split = false } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.rules = new Map([["mp_timelimit", "20"]]);
    sock.asked = 0;
    const challenge = 0x2468ace0;
    sock.on("message", (msg, rinfo) => {
      if (msg.length < 9 || msg.readInt32LE(0) !== -1 || msg[4] !== 0x56) return;
      sock.asked++;
      if (msg.readInt32LE(5) !== challenge) {
        const a = Buffer.alloc(9);
        a.writeInt32LE(-1, 0);
        a[4] = 0x41;
        a.writeInt32LE(challenge, 5);
        sock.send(a, rinfo.port, rinfo.address);
        return;
      }
      const head = Buffer.alloc(7);
      head.writeInt32LE(-1, 0);
      head[4] = 0x45;
      head.writeUInt16LE(sock.rules.size, 5);
      const whole = Buffer.concat([head, ...[...sock.rules].map(([k, v]) => Buffer.from(k + "\0" + v + "\0"))]);
      if (!split) return sock.send(whole, rinfo.port, rinfo.address);
      const cut = Math.floor(whole.length / 2);
      [whole.subarray(0, cut), whole.subarray(cut)].forEach((chunk, i) => {
        const h = Buffer.alloc(9);
        h.writeInt32LE(-2, 0);
        h.writeInt32LE(77, 4);
        h[8] = (i << 4) | 2;
        sock.send(Buffer.concat([h, chunk]), rinfo.port, rinfo.address);
      });
    });
    sock.bind(0, "127.0.0.1", () => resolve(sock));
  });
}

// The service and the presence module beside it, as in presence.test.js: core's hooks, a clock the
// tests move by hand.
async function app({ settings = {}, servers = [] } = {}) {
  const t = await startApp({ limits: CORE_ROOMY }, { servers: [{ name: "HAVOC 9", address: LISTED }, ...servers] });
  const clock = { ms: Date.now() };
  migrate(t.app.db, "presence", MIGRATIONS, {});
  const dataDir = path.join(t.config.dataDir, "modules", "presence");
  const core = t.app.accounts;
  const p = createPresence({
    db: t.app.db,
    transaction: (fn) => transaction(t.app.db, fn),
    router: t.app.router.scoped(["/api/presence"]),
    auth: t.app.auth,
    accounts: {
      getById: core.getById, getByUsername: core.getByUsername, publicView: core.publicView, isBanned: core.isBanned,
      clientIdIndex: t.app.clientIds.clientIdIndex, verifyIdProof: core.verifyIdProof, nameInUse: core.nameInUse,
    },
    servers: serversHook({ servers: t.app.servers, status: t.app.status }),
    events: t.app.events,
    audit: t.app.audit,
    log: t.app.log.child("presence"),
    settings: { limits: roomy(), cacheSeconds: 0, enrollProbeSeconds: 1, enrollProbeTimeoutMs: 600, pollHoldSeconds: 2, chatCooldownSeconds: 0, ...settings },
    dataDir,
    http: { HttpError, clientIp: (req) => clientIp(req, t.config.trustProxy) },
    limits: { RateLimiter, ipKey },
    now: () => clock.ms,
  });
  p.start();
  writeKeys(path.join(dataDir, "server-keys.json"), new Map([[LISTED, { key: LISTED_KEY, created: "2026-11-01T00:00:00Z" }]]));
  p.keys.touch();
  return {
    ...t, p, clock,
    sec: () => Math.floor(clock.ms / 1000),
    advance(seconds) { clock.ms += seconds * 1000; },
    async close() { p.stop(); await t.close(); },
  };
}

// A signed server call.
function call(t, route, server, key, fields = {}, { ts, nonce, sig } = {}) {
  const body = JSON.stringify({ v: 1, server, ts: ts === undefined ? t.sec() : ts, nonce: nonce || randomHex(8), ...fields });
  return request(t.base, "POST", "/api/presence/" + route, { body, origin: null, headers: { "x-h9-server": server, "x-h9-signature": sig || hmacHex(key, body) } });
}

// A report, as h9_presence.sma sends it.
async function report(t, server, key, players, extra = {}) {
  t.advance(1);
  const body = JSON.stringify({ v: 1, server, ts: t.sec(), map: "h9_tsrp_hive", mode: "Roleplay", players, ...extra });
  return request(t.base, "POST", "/api/presence/report", { body, origin: null, headers: { "x-h9-server": server, "x-h9-signature": hmacHex(key, body) } });
}

const pidOf = (t, name) => t.app.accounts.playerId(t.app.accounts.getByUsername(name));
const idOf = (t, name) => t.app.accounts.getByUsername(name).id;
const clientIdFor = (pid, server) => serverClientId(pid, parseAddress(server).bytes);
function proof(pid, server, device, sec) {
  const nonce = sec.toString(16).padStart(8, "0") + randomHex(12);
  const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
  const dm = Buffer.from(device, "hex");
  for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
  const devmask = dm.toString("hex");
  return { nonce, devmask, proof: hmacHex(pid, "h9proof1:" + nonce + ":" + server + ":" + devmask) };
}
// a player entry: the account's h9_clientid on that server, a slot, and with device a proof
const player = (t, name, server, slot, device) => ({
  id: clientIdFor(pidOf(t, name), server), slot, name, joined: t.sec() - 5, time: 5,
  ...(device ? proof(pidOf(t, name), server, device, t.sec()) : {}),
});

async function adminCookie(t, name) {
  const cookie = await signup(t.base, name);
  t.app.accounts.setRole(idOf(t, name), "admin");
  return cookie;
}

// Enrolls the fake rules server's address: { server, key, serverId } once live (or pending approval).
async function enroll(t, rules) {
  const port = rules.address().port;
  const r = await request(t.base, "POST", "/api/presence/enroll", { body: { v: 1, port }, origin: null });
  assert.equal(r.status, 200, r.text);
  rules.rules.set("h9_presence_enroll", r.json.code);
  t.advance(2);
  const st = await call(t, "enroll/status", r.json.server, r.json.key);
  assert.equal(st.status, 200, st.text);
  return { server: r.json.server, key: r.json.key, serverId: r.json.serverId, status: st.json.status, code: r.json.code };
}

describe("enrollment: a key without anyone typing it", () => {
  let t;
  let rules;
  let admin;
  before(async () => {
    rules = await fakeRules();
    t = await app({ servers: [] });
    admin = await adminCookie(t, "Oracle");
  });
  after(async () => {
    await t.close();
    rules.close();
  });

  test("A2S_RULES: the challenge step, and an answer split in two", async () => {
    const r = await queryRules("127.0.0.1", rules.address().port, { timeoutMs: 800 });
    assert.equal(r.get("mp_timelimit"), "20");
    const split = await fakeRules({ split: true });
    try {
      split.rules.set("h9_presence_enroll", "h9-abcdefghijkl");
      const s = await queryRules("127.0.0.1", split.address().port, { timeoutMs: 800 });
      assert.equal(s.get("h9_presence_enroll"), "h9-abcdefghijkl");
    } finally {
      split.close();
    }
    assert.equal(parseRules(Buffer.from("nonsense")), null);
    assert.equal(await queryRules("127.0.0.1", 9, { timeoutMs: 200, retries: 0 }), null, "nothing there: null, quietly");
  });

  test("a server enrolls only its own address, and its key is inactive until the code shows", async () => {
    const port = rules.address().port;
    let r = await request(t.base, "POST", "/api/presence/enroll", { body: { v: 1, server: "198.51.100.9:" + port }, origin: null });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "address_mismatch");
    r = await request(t.base, "POST", "/api/presence/enroll", { body: { v: 1, port }, origin: null });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.server, "127.0.0.1:" + port);
    assert.match(r.json.key, /^[0-9a-f]{64}$/);
    assert.match(r.json.code, /^h9-[a-z2-9]{12}$/);
    const { key, server } = r.json;
    t.advance(2);
    let st = await call(t, "enroll/status", server, key);
    assert.equal(st.json.status, "pending_proof", "the code is not in the rules yet");
    const rep = await report(t, server, key, []);
    assert.equal(rep.status, 403);
    assert.equal(rep.json.error, "not_enrolled", "an inactive key reports nothing");
    rules.rules.set("h9_presence_enroll", "h9-wrongwrongwr");
    t.advance(2);
    st = await call(t, "enroll/status", server, key);
    assert.equal(st.json.status, "pending_proof", "a wrong code proves nothing");
    rules.rules.set("h9_presence_enroll", r.json.code);
    t.advance(2);
    st = await call(t, "enroll/status", server, key);
    assert.equal(st.json.status, "pending_approval", "proven; not on servers.json, so an admin decides");
    const rep2 = await report(t, server, key, []);
    assert.equal(rep2.json.error, "pending_approval");
    const list = await request(t.base, "GET", "/api/presence/admin/servers?status=pending_approval", { cookie: admin });
    assert.equal(list.json.servers.length, 1);
    assert.ok(list.json.flags.some((f) => f.kind === "pending_approval"));
    const ok = await request(t.base, "POST", "/api/presence/admin/servers/" + r.json.serverId + "/approve", { cookie: admin, body: {} });
    assert.equal(ok.status, 200);
    assert.equal((await report(t, server, key, [])).status, 200, "live");
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'presence.server.approve'").get());
  });

  test("re-enrolling: the old key works until the new one is proven, then a flag and the audit log", async () => {
    const before = await enroll(t, rules);
    assert.equal(before.status, "active", "approved before, so live at once");
    const port = rules.address().port;
    const r = await request(t.base, "POST", "/api/presence/enroll", { body: { v: 1, port }, origin: null });
    assert.equal((await report(t, before.server, before.key, [])).status, 200, "the old key still reports");
    rules.rules.set("h9_presence_enroll", r.json.code);
    t.advance(2);
    const st = await call(t, "enroll/status", r.json.server, r.json.key);
    assert.equal(st.json.status, "active");
    assert.equal((await report(t, before.server, before.key, [])).status, 401, "the old key is dead");
    assert.equal((await report(t, before.server, r.json.key, [])).status, 200);
    const admin2 = await request(t.base, "GET", "/api/presence/admin/servers", { cookie: admin });
    assert.ok(admin2.json.flags.some((f) => f.kind === "re_enrolled"));
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'presence.server.reenroll'").get());
  });

  test("a stranger enrolling someone else's address never gets a live key", async () => {
    const u = await app({ settings: { enrollSameIp: false } });
    const victim = await fakeRules();
    try {
      const r = await request(u.base, "POST", "/api/presence/enroll", { body: { v: 1, server: "127.0.0.1:" + victim.address().port }, origin: null });
      assert.equal(r.status, 200, "allowed to ask, with enrollSameIp off");
      victim.rules.set("h9_presence_enroll", "h9-notthecode1");
      for (let i = 0; i < 3; i++) {
        u.advance(2);
        assert.equal((await call(u, "enroll/status", r.json.server, r.json.key)).json.status, "pending_proof");
      }
      u.advance(61 * 60);
      u.p.sweep();
      const st = await call(u, "enroll/status", r.json.server, r.json.key);
      assert.equal(st.status, 403, "after an hour the enrollment is forgotten");
    } finally {
      await u.close();
      victim.close();
    }
  });

  test("on servers.json: live on proof; blocked and revoked by an admin; stale keys expire", async () => {
    const own = await fakeRules();
    const address = "127.0.0.1:" + own.address().port;
    const u = await app({ servers: [{ name: "Own", address }] });
    try {
      const a = await adminCookie(u, "Overseer");
      const e = await enroll(u, own);
      assert.equal(e.status, "active");
      const ok = await report(u, e.server, e.key, []);
      assert.equal(ok.status, 200);
      assert.equal(ok.json.serverId, e.serverId);
      await request(u.base, "POST", "/api/presence/admin/servers/" + e.serverId + "/block", { cookie: a, body: {} });
      assert.equal((await report(u, e.server, e.key, [])).status, 403);
      const again = await request(u.base, "POST", "/api/presence/enroll", { body: { v: 1, port: own.address().port }, origin: null });
      assert.equal(again.json.error, "blocked");
      await request(u.base, "POST", "/api/presence/admin/servers/" + e.serverId + "/unblock", { cookie: a, body: {} });
      const e2 = await enroll(u, own);
      assert.equal(e2.status, "active");
      assert.equal(e2.serverId, e.serverId, "the address keeps its server id");
      u.advance(31 * 86400);
      u.p.sweep();
      assert.equal((await report(u, e2.server, e2.key, [])).status, 403, "30 days without a report: expired");
    } finally {
      await u.close();
      own.close();
    }
  });

  test("enrolling is rate-limited per caller", async () => {
    const tight = { max: 2, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 600 };
    const u = await app({ settings: { limits: { ...roomy(), enrollPerIp: tight } } });
    try {
      for (let i = 0; i < 2; i++) assert.equal((await request(u.base, "POST", "/api/presence/enroll", { body: { v: 1, port: 27015 }, origin: null })).status, 200);
      assert.equal((await request(u.base, "POST", "/api/presence/enroll", { body: { v: 1, port: 27015 }, origin: null })).status, 429);
    } finally {
      await u.close();
    }
  });
});

describe("communities: linking servers, staff, chat and the long-poll", () => {
  let t;
  let owner;
  let other;
  let neo;
  before(async () => {
    t = await app();
    owner = await signup(t.base, "Morpheus");
    other = await signup(t.base, "Smith");
    neo = await signup(t.base, "Neo");
    await signup(t.base, "Trinity");
  });
  after(async () => {
    await t.close();
  });

  const site = (method, p, cookie, body) => request(t.base, method, "/api/presence/communities" + p, { cookie, body });

  test("an account makes a community; a server links by the code it shows in its console", async () => {
    let r = await site("POST", "", owner, { slug: "z!", name: "Zion" });
    assert.equal(r.status, 400, "a short name is 3 to 32 of a to z, 0 to 9 and -");
    r = await site("POST", "", owner, { slug: "Zion", name: "Zion RP" });
    assert.equal(r.json.slug, "zion", "taken in lowercase");
    assert.equal(r.status, 201, r.text);
    assert.equal((await site("POST", "", other, { slug: "zion", name: "Mine" })).status, 409);
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    assert.equal(claim.status, 200);
    assert.match(claim.json.code, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal((await site("POST", "/zion/claim", other, { code: claim.json.code, tag: "Zion" })).status, 403, "only the community's staff");
    assert.equal((await site("POST", "/zion/claim", owner, { code: "aaaa-bbbb", tag: "Zion" })).status, 404);
    r = await site("POST", "/zion/claim", owner, { code: claim.json.code, tag: "Zion" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.servers[0].tag, "Zion");
    assert.equal((await site("POST", "/zion/claim", owner, { code: claim.json.code, tag: "Zion" })).status, 404, "a code works once");
    await site("POST", "", other, { slug: "machine", name: "The Machine" });
    const again = await call(t, "server/claim", LISTED, LISTED_KEY);
    assert.equal((await site("POST", "/machine/claim", other, { code: again.json.code, tag: "Mx" })).status, 409, "linked elsewhere");
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'community.server.link'").get());
  });

  test("staff: the owner names admins; others may not", async () => {
    assert.equal((await site("POST", "/zion/staff", other, { username: "Smith" })).status, 403);
    assert.equal((await site("POST", "/zion/staff", owner, { username: "Trinity" })).status, 200);
    const view = await site("GET", "/zion", owner);
    assert.deepEqual(view.json.staff, ["Trinity"]);
    assert.equal(view.json.me.owner, true);
  });

  test("chat from the game: an account in game here, cleaned, with its server's tag", async () => {
    let r = await call(t, "server/chat", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Neo"), LISTED), text: "hi" });
    assert.equal(r.json.error, "not_here", "not in game yet");
    assert.equal((await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3)])).status, 200);
    r = await call(t, "server/chat", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Neo"), LISTED), text: "#^1hello\u0007 100% %s there" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.line, "[Zion] Neo: hello 100 s there");
    r = await call(t, "server/chat", LISTED, LISTED_KEY, { id: randomHex(16), text: "hi" });
    assert.equal(r.json.error, "not_an_account");
    assert.equal(chatText("a\u0000b^9c", 10), "a bc");
    assert.equal(reasonText("griefing; quit \"now\"\n"), "griefing quit now");
  });

  test("the long-poll: held, woken by a web line, never echoing a server's own lines", async () => {
    let r = await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.json.community.slug, "zion");
    assert.equal(r.json.servers[0].tag, "Zion");
    const last = r.json.last;
    const started = Date.now();
    const waiting = call(t, "server/poll", LISTED, LISTED_KEY, { since: last });
    await sleep(150);
    const web = await site("POST", "/zion/chat", neo, { text: "from the site" });
    assert.equal(web.status, 201, web.text);
    r = await waiting;
    assert.ok(Date.now() - started < 1500, "woken, not timed out");
    assert.deepEqual(r.json.messages.map((m) => m.line), ["[Web] Neo: from the site"]);
    await call(t, "server/chat", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Neo"), LISTED), text: "own line" });
    r = await call(t, "server/poll", LISTED, LISTED_KEY, { since: r.json.last, hold: 0 });
    assert.deepEqual(r.json.messages, [], "the server showed its own line already");
    const webRead = await site("GET", "/zion/chat?since=0", neo);
    assert.deepEqual(webRead.json.messages.map((m) => m.source), ["game", "web", "game"]);
    assert.equal((await site("GET", "/zion/chat", undefined)).status, 401, "the chatbox is for accounts");
    assert.equal((await request(t.base, "POST", "/api/presence/communities/zion/chat", { cookie: neo, body: { text: "x" }, origin: null })).status, 403, "CSRF");
  });

  test("moderation: delete a line, mute an account (game and web), announcements", async () => {
    const msgs = (await site("GET", "/zion/chat?since=0", owner)).json.messages;
    assert.equal((await site("DELETE", "/zion/chat/" + msgs[0].id, other)).status, 403);
    assert.equal((await site("DELETE", "/zion/chat/" + msgs[0].id, owner)).status, 200);
    assert.ok(!(await site("GET", "/zion/chat?since=0", owner)).json.messages.some((m) => m.id === msgs[0].id));
    let r = await site("POST", "/zion/sanctions", owner, { username: "Neo", kind: "mute", reason: "spam" });
    assert.equal(r.status, 201, r.text);
    assert.equal((await site("POST", "/zion/chat", neo, { text: "can I" })).json.error, "muted");
    assert.equal((await call(t, "server/chat", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Neo"), LISTED), text: "x" })).json.error, "muted");
    const poll = await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 });
    assert.equal(poll.json.report, true, "a sanction makes the community's servers report");
    const rep = await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3)]);
    assert.deepEqual(rep.json.actions, { 3: { mute: true } });
    await site("POST", "/zion/sanctions/" + r.json.id + "/revoke", owner, {});
    assert.deepEqual((await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3)])).json.actions, {});
    r = await site("POST", "/zion/announce", owner, { text: "server restart in 5" });
    assert.equal(r.status, 201);
    const p2 = await call(t, "server/poll", LISTED, LISTED_KEY, { since: r.json.id - 1, hold: 0 });
    assert.deepEqual(p2.json.messages.map((m) => m.line), ["[Zion RP] server restart in 5"]);
  });
});

describe("sanctions: bans, kicks and devices, in a community and H9-wide", () => {
  let t;
  let owner;
  let admin;
  let rules;
  let enrolled;
  before(async () => {
    t = await app();
    rules = await fakeRules();
    owner = await signup(t.base, "Morpheus");
    admin = await adminCookie(t, "Oracle");
    for (const n of ["Cypher", "Mouse", "Apoc"]) await signup(t.base, n);
    await request(t.base, "POST", "/api/presence/communities", { cookie: owner, body: { slug: "zion", name: "Zion" } });
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    await request(t.base, "POST", "/api/presence/communities/zion/claim", { cookie: owner, body: { code: claim.json.code, tag: "Zion" } });
    enrolled = await enroll(t, rules);
    await request(t.base, "POST", "/api/presence/admin/servers/" + enrolled.serverId + "/approve", { cookie: admin, body: {} });
  });
  after(async () => {
    await t.close();
    rules.close();
  });

  test("a community ban kicks on its servers only; it follows the banned account's device", async () => {
    let r = await report(t, LISTED, LISTED_KEY, [player(t, "Cypher", LISTED, 4, DEV1)]);
    assert.deepEqual(r.json.actions, {});
    r = await request(t.base, "POST", "/api/presence/communities/zion/sanctions", { cookie: owner, body: { username: "Cypher", kind: "ban", reason: "traitor", days: 7 } });
    assert.equal(r.status, 201, r.text);
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Cypher", LISTED, 4, DEV1)]);
    assert.deepEqual(r.json.actions, { 4: { kick: "Banned from Zion: traitor" } });
    r = await report(t, enrolled.server, enrolled.key, [player(t, "Cypher", enrolled.server, 2)]);
    assert.deepEqual(r.json.actions, {}, "not on a server outside the community");
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Mouse", LISTED, 5, DEV1)]);
    assert.deepEqual(r.json.actions, { 5: { kick: "Banned from Zion: traitor" } }, "another account, the banned account's device");
  });

  test("a kick is once; an H9-wide ban by a site admin reaches every server", async () => {
    let r = await request(t.base, "POST", "/api/presence/communities/zion/sanctions", { cookie: owner, body: { username: "Apoc", kind: "kick", reason: "afk" } });
    assert.equal(r.status, 201);
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Apoc", LISTED, 6)]);
    assert.deepEqual(r.json.actions, { 6: { kick: "Kicked: afk" } });
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Apoc", LISTED, 6)]);
    assert.deepEqual(r.json.actions, {}, "once");
    assert.equal((await request(t.base, "POST", "/api/presence/admin/sanctions", { cookie: owner, body: { username: "Apoc", kind: "ban" } })).status, 403, "H9-wide is for site admins");
    r = await request(t.base, "POST", "/api/presence/admin/sanctions", { cookie: admin, body: { username: "Apoc", kind: "ban", reason: "cheating" } });
    assert.equal(r.status, 201);
    r = await report(t, enrolled.server, enrolled.key, [player(t, "Apoc", enrolled.server, 1)]);
    assert.deepEqual(r.json.actions, { 1: { kick: "Banned from H9: cheating" } });
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'presence.sanction.ban'").get());
    assert.equal((await request(t.base, "POST", "/api/presence/communities/zion/sanctions", { cookie: owner, body: { username: "Oracle", kind: "ban" } })).status, 403, "nobody below an H9 admin bans one");
  });
});

describe("find, and the shared data of h9_community.inc", () => {
  let t;
  let owner;
  let rules;
  let other;
  before(async () => {
    t = await app();
    rules = await fakeRules();
    owner = await signup(t.base, "Morpheus");
    const admin = await adminCookie(t, "Oracle");
    for (const n of ["Neo", "Trinity", "Tank"]) await signup(t.base, n);
    await request(t.base, "POST", "/api/presence/communities", { cookie: owner, body: { slug: "zion", name: "Zion" } });
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    await request(t.base, "POST", "/api/presence/communities/zion/claim", { cookie: owner, body: { code: claim.json.code, tag: "Zion" } });
    other = await enroll(t, rules);
    await request(t.base, "POST", "/api/presence/admin/servers/" + other.serverId + "/approve", { cookie: admin, body: {} });
    const c2 = await call(t, "server/claim", other.server, other.key);
    await request(t.base, "POST", "/api/presence/communities", { cookie: admin, body: { slug: "machine", name: "Machine" } });
    await request(t.base, "POST", "/api/presence/communities/machine/claim", { cookie: admin, body: { code: c2.json.code, tag: "Mx" } });
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1), player(t, "Trinity", LISTED, 2)]);
  });
  after(async () => {
    await t.close();
    rules.close();
  });

  const data = (route, server, key, fields) => call(t, "server/data/" + route, server, key, fields);
  const neoId = () => clientIdFor(pidOf(t, "Neo"), LISTED);

  test("find: where an account is, as its switches allow", async () => {
    let r = await call(t, "server/find", other.server, other.key, { q: "neo" });
    assert.equal(r.json.results[0].username, "Neo");
    assert.equal(r.json.results[0].address, LISTED);
    assert.equal(r.json.results[0].tag, "Zion");
    assert.equal(r.json.results[0].community, false);
    const tri = await request(t.base, "POST", "/api/login", { body: { username: "Trinity", password: PASSWORD } });
    await request(t.base, "POST", "/api/presence/settings", { cookie: tri.cookie, body: { where: false } });
    r = await call(t, "server/find", LISTED, LISTED_KEY, { q: "Trinity" });
    assert.equal(r.json.results[0].state, "game");
    assert.equal(r.json.results[0].address, null, "the server stays hidden");
    r = await call(t, "server/find", LISTED, LISTED_KEY, { q: "Tank" });
    assert.ok(["site", "offline"].includes(r.json.results[0].state), "not in game");
    assert.equal(r.json.results[0].address, null);
  });

  test("set and get, with a version check; only for a player in game here", async () => {
    let r = await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "100" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, 1);
    r = await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "150", version: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.json.version, 1);
    assert.equal(r.json.value, "100");
    r = await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "150", version: 1 });
    assert.equal(r.json.version, 2);
    r = await data("get", LISTED, LISTED_KEY, { id: neoId(), keys: ["rp.money", "rp.car"] });
    assert.deepEqual([r.json.values["rp.money"].value, r.json.values["rp.money"].version, r.json.values["rp.car"].version], ["150", 2, 0]);
    r = await data("set", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Tank"), LISTED), key: "rp.money", value: "1" });
    assert.equal(r.json.error, "not_here", "Tank is not in game here");
    r = await data("get", other.server, other.key, { account: "Neo", keys: ["rp.money"] });
    assert.equal(r.json.values["rp.money"].version, 0, "another community sees nothing of Zion's");
  });

  test("limits: key names, sizes, read-only servers, proof when the community asks for it", async () => {
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "Bad Key", value: "1" })).status, 400);
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "big", value: "x".repeat(600) })).status, 413);
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "n", value: 5 })).status, 413, "strings only");
    const serverId = (await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 })).json.serverId;
    await request(t.base, "POST", "/api/presence/communities/zion/servers/" + serverId, { cookie: owner, body: { readOnly: true } });
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "9" })).json.error, "read_only");
    assert.equal((await data("get", LISTED, LISTED_KEY, { id: neoId(), keys: ["rp.money"] })).status, 200, "it still reads");
    await request(t.base, "POST", "/api/presence/communities/zion/servers/" + serverId, { cookie: owner, body: { readOnly: false } });
    await request(t.base, "PATCH", "/api/presence/communities/zion", { cookie: owner, body: { dataProof: true } });
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "9" })).json.error, "unverified");
    await request(t.base, "PATCH", "/api/presence/communities/zion", { cookie: owner, body: { dataProof: false } });
  });

  test("every change is logged; the owner rolls a community back to a time", async () => {
    const before = new Date(t.sec() * 1000).toISOString();
    t.advance(10);
    await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "999999" });
    await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.car", value: "tank" });
    const log = await request(t.base, "GET", "/api/presence/communities/zion/data/log?username=Neo", { cookie: owner });
    assert.equal(log.json.log[0].key, "rp.car");
    assert.equal(log.json.log[1].value, "999999");
    const r = await request(t.base, "POST", "/api/presence/communities/zion/data/rollback", { cookie: owner, body: { to: before } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.restored, 2);
    const v = await data("get", LISTED, LISTED_KEY, { id: neoId(), keys: ["rp.money", "rp.car"] });
    assert.equal(v.json.values["rp.money"].value, "150");
    assert.equal(v.json.values["rp.car"].value, null);
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'community.data.rollback'").get());
  });

  test("signed calls: a wrong key, a stale time and a replayed nonce are refused", async () => {
    assert.equal((await call(t, "server/poll", LISTED, randomHex(32), { hold: 0 })).status, 401);
    assert.equal((await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 }, { ts: t.sec() - 500 })).json.error, "stale");
    const nonce = randomHex(8);
    assert.equal((await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 }, { nonce })).status, 200);
    assert.equal((await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 }, { nonce })).json.error, "replay");
    assert.equal((await call(t, "server/poll", "198.51.100.99:27015", LISTED_KEY, { hold: 0 })).json.error, "no_key");
  });

  test("no key, code or link code in the logs", async () => {
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    const logs = t.logs.join("\n");
    for (const secret of [LISTED_KEY, other.key, other.code, claim.json.code]) assert.ok(!logs.includes(secret));
    const keyFile = path.join(t.config.dataDir, "modules", "presence", "enroll-key");
    assert.ok(fs.existsSync(keyFile));
    const row = t.app.db.prepare("SELECT * FROM presence_enrolled WHERE server = ?").get(other.server);
    assert.ok(!JSON.stringify(row).includes(other.key), "only a salt is stored, never the key");
  });

  // Each call exactly as h9_community.sma writes it (body_begin, app_str, the fields in its order):
  // " and the backslash escaped, control characters as u00XX, every other byte as it is.
  test("the bodies h9_community.sma builds, as it builds them", async () => {
    const pstr = (s) => '"' + Array.from(s).map((ch) => {
      const c = ch.codePointAt(0);
      if (c === 34 || c === 92) return "\\" + ch;
      if (c < 32 || c === 127) return "\\u00" + c.toString(16).padStart(2, "0");
      return ch;
    }).join("") + '"';
    const plugin = (route, tail) => {
      const body = '{"v":1,"server":' + pstr(LISTED) + ',"ts":' + t.sec() + ',"nonce":' + pstr(randomHex(8)) + tail + "}";
      return request(t.base, "POST", "/api/presence/" + route, { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(LISTED_KEY, body) } });
    };
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1), player(t, "Trinity", LISTED, 2)]);
    const neo = pstr(neoId());

    assert.equal((await request(t.base, "POST", "/api/presence/communities/zion/chat", { cookie: owner, body: { text: "from the site" } })).status, 201);
    let r = await plugin("server/poll", ',"since":0,"hold":20');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.messages.some((m) => m.line === "[Web] Morpheus: from the site"));
    assert.ok(r.json.last > 0);
    assert.equal(r.json.community.slug, "zion");
    assert.ok(r.json.servers.some((s) => s.address === LISTED && s.tag === "Zion"));

    r = await plugin("server/chat", ',"id":' + neo + ',"text":' + pstr('say "hi" \\ there\u0001 été %d'));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.line, '[Zion] Neo: say "hi" \\ there été d');

    r = await plugin("server/find", ',"q":' + pstr("ne"));
    assert.equal(r.json.results[0].username, "Neo");

    r = await plugin("server/data/set", ',"id":' + neo + ',"key":' + pstr("pawn.k") + ',"value":' + pstr('a "quoted" \\ value') + ',"version":0');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, 1);
    r = await plugin("server/data/get", ',"id":' + neo + ',"keys":[' + pstr("pawn.k") + "]");
    assert.deepEqual([r.json.values["pawn.k"].value, r.json.values["pawn.k"].version], ['a "quoted" \\ value', 1]);
    r = await plugin("server/data/set", ',"id":' + neo + ',"key":' + pstr("pawn.k") + ',"value":null,"version":1');
    assert.equal(r.json.version, 0, "removed");
    r = await plugin("server/data/get", ',"id":' + neo + ',"keys":[' + pstr("pawn.k") + "]");
    assert.deepEqual([r.json.values["pawn.k"].value, r.json.values["pawn.k"].version], [null, 0]);

    r = await plugin("server/claim", "");
    assert.match(r.json.code, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal(r.json.minutes, 15);
  });
});
