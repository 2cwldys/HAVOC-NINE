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
import { createPresence, MIGRATIONS, DEFAULTS, DEFAULT_ACCOUNT } from "../modules/presence/index.js";
import { writeKeys } from "../modules/presence/keys.js";
import { queryRules, parseRules } from "../modules/presence/a2s.js";
import { chatText, reasonText } from "../modules/presence/community.js";
import { decodePng, decodeGif, encodePng, square, gameVersion } from "../modules/presence/avatars.js";

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
const player = (t, name, server, slot, device) => {
  const e = { id: clientIdFor(pidOf(t, name), server), slot, name, joined: t.sec() - 5, time: 5 };
  if (device) {
    Object.assign(e, proof(pidOf(t, name), server, device, t.sec()));
    // issued to this server, as POST /api/presence/server/nonce does
    t.app.db.prepare("INSERT OR IGNORE INTO presence_proof_nonces (nonce, server, issued_at) VALUES (?, ?, ?)").run(e.nonce, server, t.sec());
  }
  return e;
};

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

  test("enrollment never aims its probes at private, local or reserved addresses for someone else", async () => {
    const u = await app({ settings: { enrollSameIp: false } });
    try {
      const ask = (server, ip) => request(u.base, "POST", "/api/presence/enroll", { body: { v: 1, server }, origin: null, ip });
      for (const server of ["10.0.0.5:27015", "127.0.0.1:27015", "169.254.169.254:80", "192.168.1.2:27015", "172.20.0.1:27015",
        "100.64.0.1:27015", "0.0.0.0:27015", "224.0.0.1:27015", "255.255.255.255:27015", "198.51.100.9:27015"]) {
        const r = await ask(server, "203.0.113.200");
        assert.equal(r.status, 403, server);
        assert.equal(r.json.error, "address_not_public", server);
      }
      assert.equal((await ask("8.8.4.4:27015", "203.0.113.200")).status, 200, "a public address may be asked for");
      assert.equal((await ask("192.168.1.2:27015", "192.168.1.2")).status, 200, "a caller at that very address may");
    } finally {
      await u.close();
    }
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
    assert.equal((await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3, DEV1)])).status, 200);
    r = await call(t, "server/chat", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Neo"), LISTED), text: "#^1hello\u0007 100% %s there" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.line, "[Zion] Neo: hello 100 s there");
    r = await call(t, "server/chat", LISTED, LISTED_KEY, { id: randomHex(16), text: "hi" });
    assert.equal(r.json.error, "not_an_account");
    assert.equal(chatText("a\u0000b^9c", 10), "a bc");
    assert.equal(reasonText("griefing; quit \"now\"\n"), "griefing quit now");
  });

  test("the long-poll: held, woken by a web line, never echoing a server's own lines", async () => {
    assert.equal((await site("GET", "/zion/chat?since=0", neo)).json.error, "members_only", "the web chat is for members");
    assert.equal((await site("POST", "/zion/join", neo, {})).json.status, "member", "an open community: joined at once");
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
    const rep = await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3, DEV1)]);
    assert.deepEqual(rep.json.actions, { 3: { mute: true } });
    await site("POST", "/zion/sanctions/" + r.json.id + "/revoke", owner, {});
    assert.deepEqual((await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3, DEV1)])).json.actions, {});
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
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2, DEV1)]);
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

  test("limits: key names, sizes, read-only servers, proof unless the owner switches it off", async () => {
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "Bad Key", value: "1" })).status, 400);
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "big", value: "x".repeat(600) })).status, 413);
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "n", value: 5 })).status, 413, "strings only");
    const serverId = (await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 })).json.serverId;
    await request(t.base, "POST", "/api/presence/communities/zion/servers/" + serverId, { cookie: owner, body: { readOnly: true } });
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: neoId(), key: "rp.money", value: "9" })).json.error, "read_only");
    assert.equal((await data("get", LISTED, LISTED_KEY, { id: neoId(), keys: ["rp.money"] })).status, 200, "it still reads");
    await request(t.base, "POST", "/api/presence/communities/zion/servers/" + serverId, { cookie: owner, body: { readOnly: false } });
    // proof is on from the start: Trinity's game sent no proof, so her announced id reads and writes nothing
    const tri = clientIdFor(pidOf(t, "Trinity"), LISTED);
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2)]);
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: tri, key: "rp.money", value: "9" })).json.error, "unverified");
    assert.equal((await data("get", LISTED, LISTED_KEY, { id: tri, keys: ["rp.money"] })).json.error, "unverified");
    assert.equal((await data("get", LISTED, LISTED_KEY, { id: neoId(), keys: ["rp.money"] })).status, 200, "a proven game reads");
    await request(t.base, "PATCH", "/api/presence/communities/zion", { cookie: owner, body: { dataProof: false } });
    assert.equal((await data("set", LISTED, LISTED_KEY, { id: tri, key: "rp.money", value: "9" })).status, 200, "switched off by the owner: the announced id is taken");
    await data("set", LISTED, LISTED_KEY, { id: tri, key: "rp.money", value: null });
    await request(t.base, "PATCH", "/api/presence/communities/zion", { cookie: owner, body: { dataProof: true } });
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2, DEV1)]);
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
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2, DEV1)]);
    const neo = pstr(neoId());

    assert.equal((await request(t.base, "POST", "/api/presence/communities/zion/chat", { cookie: owner, body: { text: "from the site" } })).status, 201);
    let r = await plugin("server/poll", ',"since":0,"hold":20');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.messages.some((m) => m.line === "[Web] Morpheus: from the site"));
    assert.ok(r.json.last > 0);
    assert.equal(r.json.community.slug, "zion");
    assert.ok(r.json.servers.some((s) => s.address === LISTED && s.tag === "Zion"));

    r = await plugin("server/chat", ',"id":' + neo + ',"text":' + pstr('say "hi" \\ there\u0001 \u00e9t\u00e9 %d'));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.line, '[Zion] Neo: say "hi" \\ there \u00e9t\u00e9 d');

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

describe("membership: joining, visibility and members-only servers", () => {
  let t;
  let owner;
  let admin;
  const cookies = {};
  before(async () => {
    t = await app();
    owner = await signup(t.base, "Morpheus");
    admin = await adminCookie(t, "Oracle");
    for (const n of ["Neo", "Trinity", "Tank", "Smith", "Cypher"]) cookies[n] = await signup(t.base, n);
    await request(t.base, "POST", "/api/presence/communities", { cookie: owner, body: { slug: "zion", name: "Zion" } });
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    await request(t.base, "POST", "/api/presence/communities/zion/claim", { cookie: owner, body: { code: claim.json.code, tag: "Zion" } });
  });
  after(async () => {
    await t.close();
  });

  const site = (method, p, cookie, body) => request(t.base, method, "/api/presence/communities" + p, { cookie, body });
  const as = (name) => cookies[name];
  const idOn = (name) => clientIdFor(pidOf(t, name), LISTED);
  const settings = (body) => site("PATCH", "/zion", owner, body);

  test("join modes: open joins at once, request waits for staff, invite needs an invitation", async () => {
    assert.equal((await site("POST", "/zion/join", as("Neo"), {})).json.status, "member");
    let r = await site("GET", "/zion/members", as("Neo"));
    assert.deepEqual(r.json.members.map((m) => [m.username, m.role]), [["Morpheus", "owner"], ["Neo", "member"]]);
    assert.equal(r.json.requests, undefined, "requests are for staff");
    assert.equal((await site("GET", "/zion", undefined)).json.members, 2, "the count is public");

    assert.equal((await settings({ joinMode: "request" })).json.joinMode, "request");
    assert.equal((await site("POST", "/zion/join", as("Trinity"), {})).json.status, "requested");
    assert.equal((await site("GET", "/zion", as("Trinity"))).json.me.requested, true);
    assert.equal((await site("POST", "/zion/join", as("Tank"), {})).json.status, "requested");
    r = await site("GET", "/zion/members", owner);
    assert.deepEqual(r.json.requests.map((x) => x.username), ["Trinity", "Tank"]);
    assert.equal((await site("POST", "/zion/requests/Trinity/approve", as("Neo"), {})).status, 403, "staff only");
    assert.equal((await site("POST", "/zion/requests/Trinity/approve", owner, {})).status, 200);
    assert.equal((await site("POST", "/zion/requests/Tank/refuse", owner, {})).status, 200);
    assert.equal((await site("GET", "/zion", as("Trinity"))).json.me.member, true);
    assert.equal((await site("GET", "/zion", as("Tank"))).json.me.member, false);
    assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'community.member.approve'").get());
    assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'community.member.refuse'").get());

    await settings({ joinMode: "invite" });
    assert.equal((await site("POST", "/zion/join", as("Smith"), {})).json.error, "invite_only");
    assert.equal((await site("POST", "/zion/invites", owner, { username: "Smith" })).status, 201);
    let list = await request(t.base, "GET", "/api/presence/communities", { cookie: as("Smith") });
    assert.deepEqual(list.json.invitations.map((i) => [i.slug, i.by]), [["zion", "Morpheus"]]);
    assert.equal((await site("POST", "/zion/invitation/decline", as("Smith"), {})).status, 200);
    list = await request(t.base, "GET", "/api/presence/communities", { cookie: as("Smith") });
    assert.deepEqual(list.json.invitations, []);
    await site("POST", "/zion/invites", owner, { username: "Smith" });
    assert.equal((await site("POST", "/zion/join", as("Smith"), {})).json.status, "member", "an invitation is taken by joining");
    assert.equal((await site("POST", "/zion/invites", owner, { username: "Smith" })).json.error, "member");
    list = await request(t.base, "GET", "/api/presence/communities", { cookie: as("Neo") });
    assert.deepEqual(list.json.mine.map((c) => c.slug), ["zion"], "YOUR COMMUNITIES");
    assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'community.member.invite'").get());
  });

  test("leave and remove: the owner stays, admins only by the owner", async () => {
    assert.equal((await site("POST", "/zion/leave", as("Neo"), {})).status, 200);
    assert.equal((await site("GET", "/zion/members", as("Neo"))).json.error, "members_only");
    assert.equal((await site("POST", "/zion/leave", owner, {})).json.error, "owner");
    await site("POST", "/zion/staff", owner, { username: "Trinity" });
    let r = await site("GET", "/zion/members", owner);
    assert.ok(r.json.members.some((m) => m.username === "Trinity" && m.role === "admin"));
    assert.equal((await site("DELETE", "/zion/members/Smith", as("Tank"))).status, 403, "staff only");
    assert.equal((await site("DELETE", "/zion/members/Morpheus", as("Trinity"))).status, 403, "never the owner");
    assert.equal((await site("DELETE", "/zion/members/Smith", as("Trinity"))).status, 200, "an admin removes a member");
    assert.equal((await site("GET", "/zion", as("Smith"))).json.me.member, false);
    assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'community.member.remove'").get());
  });

  test("a banned account cannot join, ask or be invited; here or H9-wide", async () => {
    await settings({ joinMode: "open" });
    await site("POST", "/zion/sanctions", owner, { username: "Tank", kind: "ban", reason: "griefing" });
    assert.equal((await site("POST", "/zion/join", as("Tank"), {})).json.error, "banned");
    await request(t.base, "POST", "/api/presence/admin/sanctions", { cookie: admin, body: { username: "Cypher", kind: "ban" } });
    assert.equal((await site("POST", "/zion/join", as("Cypher"), {})).json.error, "banned");
    assert.equal((await site("POST", "/zion/invites", owner, { username: "Cypher" })).json.error, "banned");
  });

  test("the web chat is for members; .relay from the game is not, and members read it", async () => {
    assert.equal((await site("GET", "/zion/chat?since=0", as("Neo"))).json.error, "members_only");
    assert.equal((await site("POST", "/zion/chat", as("Neo"), { text: "hi" })).json.error, "members_only");
    assert.equal((await site("POST", "/zion/join", as("Neo"), {})).json.status, "member");
    assert.equal((await site("POST", "/zion/chat", as("Neo"), { text: "hello members" })).status, 201);
    assert.equal((await report(t, LISTED, LISTED_KEY, [player(t, "Smith", LISTED, 2, DEV1)])).status, 200);
    assert.equal((await call(t, "server/chat", LISTED, LISTED_KEY, { id: idOn("Smith"), text: "from the game" })).status, 200, "anyone on its servers relays, member or not, with a proven game");
    const read = await site("GET", "/zion/chat?since=0", as("Neo"));
    assert.deepEqual(read.json.messages.map((m) => m.text), ["hello members", "from the game"]);
    assert.equal((await site("GET", "/zion/chat?since=0", as("Smith"))).json.error, "members_only");
    assert.equal((await site("GET", "/zion/chat?since=0", admin)).status, 200, "a site admin reads it");
  });

  test("unlisted and private: the list, the page, the public lists and /find", async () => {
    await settings({ visibility: "unlisted" });
    let list = await request(t.base, "GET", "/api/presence/communities", {});
    assert.ok(!list.json.communities.some((c) => c.slug === "zion"), "not on the list");
    assert.equal((await site("GET", "/zion", undefined)).status, 200, "the link still opens it");

    await settings({ visibility: "private" });
    let r = await site("GET", "/zion", undefined);
    assert.deepEqual([r.json.private, r.json.name, r.json.servers, r.json.members], [true, "Zion", undefined, undefined], "open: a stub to join from");
    await settings({ joinMode: "invite" });
    assert.equal((await site("GET", "/zion", undefined)).status, 404, "by invitation: not there at all");
    assert.equal((await site("GET", "/zion", as("Smith"))).status, 404);
    assert.equal((await site("POST", "/zion/join", as("Smith"), {})).status, 404);
    r = await site("GET", "/zion", admin);
    assert.ok(Array.isArray(r.json.servers), "a site admin sees it");

    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 3, DEV1), player(t, "Smith", LISTED, 2, DEV1)]);
    r = await site("GET", "/zion", as("Neo"));
    assert.deepEqual(r.json.servers[0].players.sort(), ["Neo", "Smith", "Trinity"], "members see who is on its servers");
    const now = await request(t.base, "GET", "/api/presence/now", {});
    assert.ok(!now.json.servers.some((s) => s.server.address === LISTED), "not on the public list");
    assert.ok(now.json.elsewhere.some((p) => p.username === "Neo"), "in game, the server hidden");
    const card = await request(t.base, "GET", "/api/presence/account/Neo", {});
    assert.equal(card.json.state, "game");
    assert.equal(card.json.playing.server, undefined, "the card hides the server");

    const find = (fields) => call(t, "server/find", LISTED, LISTED_KEY, { q: "Neo", ...fields });
    assert.equal((await find({})).json.results[0].address, null, "nobody asked: hidden");
    assert.equal((await find({ id: idOn("Smith") })).json.results[0].address, null, "a non-member: hidden");
    assert.equal((await find({ id: idOn("Trinity") })).json.results[0].address, LISTED, "a member: shown");
    await settings({ visibility: "listed", joinMode: "open" });
  });

  test("members-only servers: the report's answer turns away whoever is not a member", async () => {
    let r = await settings({ whitelist: true });
    assert.equal(r.json.whitelist, true);
    assert.equal((await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 })).json.report, true, "its servers report at once");
    const strangers = [{ slot: 5, name: "steam player" }, { id: randomHex(16), slot: 6, name: "no account" }];
    const all = (device) => [player(t, "Neo", LISTED, 1, device), player(t, "Smith", LISTED, 2), player(t, "Trinity", LISTED, 3),
      player(t, "Oracle", LISTED, 4), ...strangers];
    r = await report(t, LISTED, LISTED_KEY, all());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.members, true);
    const away = "This server is for members of Zion. Join at havoc9.org/community/?c=zion";
    assert.deepEqual(r.json.actions, { 2: { kick: away }, 5: { kick: away }, 6: { kick: away } }, "members, the admin and the site admin stay");

    await settings({ whitelistProof: true });
    r = await report(t, LISTED, LISTED_KEY, all(DEV1));
    const proof = "This server is for members of Zion whose game proves their H9 id.";
    assert.deepEqual(r.json.actions, { 2: { kick: away }, 3: { kick: proof }, 4: { kick: proof }, 5: { kick: away }, 6: { kick: away } },
      "with the proof switch only a proven game gets in, staff included");

    await settings({ whitelist: false, whitelistProof: false });
    r = await report(t, LISTED, LISTED_KEY, all());
    assert.equal(r.json.members, undefined);
    assert.deepEqual(r.json.actions, {});
  });

  test("members-only servers: a copy of a member's id is turned away, the member whose game proved it is not", async () => {
    await settings({ whitelist: true });
    const away = "This server is for members of Zion. Join at havoc9.org/community/?c=zion";
    const copyOf = (name, slot) => ({ id: clientIdFor(pidOf(t, name), LISTED), slot, name: "Mallory", joined: t.sec() - 5, time: 5 });
    let r = await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), copyOf("Neo", 2)]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.actions, { 2: { kick: away } }, "only the copy goes; the member's game proved the id");
    assert.deepEqual(r.json.proven, [1]);

    await settings({ whitelistProof: true });
    r = await report(t, LISTED, LISTED_KEY, [copyOf("Neo", 2), player(t, "Neo", LISTED, 1, DEV1)]);
    assert.deepEqual(r.json.actions, { 2: { kick: away } }, "with the proof switch too, whichever entry comes first");

    r = await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1), copyOf("Neo", 2)]);
    assert.deepEqual(r.json.actions, { 1: { kick: away }, 2: { kick: away } }, "no proof on either: the server cannot say which is real, so neither is let in");
    await settings({ whitelist: false, whitelistProof: false });
  });

  test("joins, requests and invitations are rate-limited", async () => {
    const tight = { max: 2, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 60 };
    const u = await app({ settings: { limits: { ...roomy(), membershipPerAccount: tight, invitePerAccount: { ...tight, max: 1 } } } });
    try {
      const boss = await signup(u.base, "Morpheus");
      const neo = await signup(u.base, "Neo");
      await signup(u.base, "Smith");
      await signup(u.base, "Tank");
      await request(u.base, "POST", "/api/presence/communities", { cookie: boss, body: { slug: "zion", name: "Zion" } });
      const join = () => request(u.base, "POST", "/api/presence/communities/zion/join", { cookie: neo, body: {} });
      const leave = () => request(u.base, "POST", "/api/presence/communities/zion/leave", { cookie: neo, body: {} });
      assert.equal((await join()).status, 200);
      assert.equal((await leave()).status, 200);
      assert.equal((await join()).status, 429);
      const invite = (username) => request(u.base, "POST", "/api/presence/communities/zion/invites", { cookie: boss, body: { username } });
      assert.equal((await invite("Smith")).status, 201);
      assert.equal((await invite("Tank")).status, 429);
    } finally {
      await u.close();
    }
  });
});

// Pictures made and decoded by Pillow (PNG interlaced and of 4 bits, GIF with transparency and
// interlaced): [name, type, width, height, sha256 of Pillow's RGBA (a GIF's transparent pixels as 0,0,0,0), base64]
const PICTURES = [
  ["pal_interlaced.png", "image/png", 9, 10, "ad95792f7655d3ed70bd93d28bdceb7d53d31023a48f1fc189828d40488a28c3",
    "iVBORw0KGgoAAAANSUhEUgAAAAkAAAAKBAMAAACUK2mNAAAAFVBMVEWw13NG2HnTlZ5nmaLNU4OpGoc/PG8bhrNgAAAAR0lEQVR4nAE8AMP/AUDz3gQ7AhTgRf0AAg5NzkDgATMjEMowABM2FUYAAhMQ7woAAQIgIe0wAj/jICOwARMyHb5ABBP/r/MAE+0RiVgagL8AAAAASUVORK5CYII="],
  ["pal4.png", "image/png", 13, 11, "e33f65b2a5bc8fccecfdcd33349b666bbdfd30c699e6cb6104a9ce667837118a",
    "iVBORw0KGgoAAAANSUhEUgAAAA0AAAALBAMAAABWnBpSAAAAMFBMVEXG8IHA0FfmrIeqoWA07H1Bx2Q2oG7FdXLbVVM6Z4+nKIsqH3gAAAAAAAAAAAAAAADzjBE1AAAAY0lEQVR4nAFYAKf/ALMRaElCpEAAIJq4VJAJEAE6COD1o/rsAAlYSqoxuTACecr6plrwMAIZlic5z/ywAgeZS9/BEGAClzcDsX7mAARc9Jj5v7oeBAyBcRggLnoCFZu7J34BgBPJItwLXCBqAAAAAElFTkSuQmCC"],
  ["trans.gif", "image/gif", 14, 9, "d5670ebeba393360d44d576e8a321bc746ba11710fad10c4f3568e6baef6e77f",
    "R0lGODlhDgAJAIQAAMLnfpLyiuLGUrS8duaavfCjQLGsaLCVfG/zhWvYXC3nlyzHZly4diS3Z0iYe+RrcqJu095JkK5NuV54Wxx3b1xRjiNOrcYyqb8Ws2wldnADqD8zrkAxJCYSngAAAAAAACH5BAEAAAMALAAAAAAOAAkAAAiHADc0eJCAg4IEEBIs6JBhQYAHBiRMAACgQsEFDx5siPCwwIEAHTZwmBDhQoWNGjJoMLDAQIICEghEsJChAYEDFCwEMEjTAYAEGCRQQDChAQUMGRIySPAggoAMCjAo4EBgQAILDQJAEKDR4IEEGyAEKIChgAMOBSBcsKABAQECDghcuKBhgYCAADs="],
  ["interlaced.gif", "image/gif", 16, 16, "9c18630a8477074d483f3dbfcbb8950c34fe8330b63bb4218381d2cb2719049c",
    "R0lGODdhEAAQAIYAAOP1yPf3g+fev9PdRdztDdnjOc3iKuDcGaz07rPkx5rhprDQnqXUQ9LKwcSxs+Osa9atHqm/1ZnCSpOpds+X2OSFm5SW1pWLYWv50En6nmH5HnroYjf5mwv0sR3kVlzO5U3Tnl7EhjvMfGTLMy3COXChqEikVmarE06tMWuGq0eWdjOmwjmzfAek5wOtqw6TtByPGtx1wOV+eNpfxc+CP852W+ZiQJVyvpx4hJdew4lhhqN7SJhmMeE+ofEus+dAOuMrKrs+rqwyDINHPdoWjfELHKocurgoR7sNJ1t4pFZ0NXxlCjFy3DpieiV4WGpSn3VDwGpGTUNUgQhXpmowgUQ9tGI2Mjw8DGARSD4Sbx8woBczUhY0FxciXREfBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACwAAAAAEAAQAEAI/wB1NMiyIQOICFouMMnhowiAIAhWRGjRhYYAHQFsYNlhIYoUABJqqKhgAUkSLjt60Bixo0CHDDISBIERgEMQCwx6LGFiAYWFCiaoHJgyA4cUICk0eLDioccHEiJ6RLmBZMCLKhiGCJHyZMKOGhEMSHACoAUDEiFOKEFggMgJAQ+0EBiggwIGLBoMyBBhg0gTGVwOlJjwoYYSKFpm/HDiBEcBEy8QxLACQkYRIFWMPOAyggUTkFRIZKCxYQuLGU50RPEiZUeED1wcOEBhowkFJktmdHgipAQQCxIwQAlRhImPIRdiDKBigIIVLQmAQBFyJIALLV5qUCQAIwUPCiI0QCAAgULJlQ85VFiB0GTEkS0RFixIgoOnCyxGmLDQokJBQAA7"],
];

describe("the account API (h9_presence 1.9): the answer's usernames and roles", () => {
  let t;
  const cookies = {};
  const DEV3 = "33".repeat(16);
  const DEV4 = "44".repeat(16);
  before(async () => {
    t = await app();
    for (const n of ["Morpheus", "Trinity", "Neo", "Smith", "Tank"]) cookies[n] = await signup(t.base, n);
  });
  after(async () => {
    await t.close();
  });

  test("proven players' usernames and roles, for the slots with the chain only", async () => {
    // a server in no community: the site's roles alone
    t.app.accounts.setRole(idOf(t, "Neo"), "moderator");
    t.app.accounts.setRole(idOf(t, "Tank"), "admin");
    let r = await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3, DEV1), player(t, "Smith", LISTED, 4)]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.accounts, { 3: idOf(t, "Neo") });
    assert.deepEqual(r.json.usernames, { 3: "Neo" }, "the proven player only; the unproven one gets no name");
    assert.deepEqual(r.json.roles, { 3: "h9_moderator" });

    // the server joins Morpheus's community, Trinity is one of its admins, Smith a member
    const site = (method, sub, cookie, body) => request(t.base, method, "/api/presence/communities" + sub, { cookie, body });
    const cookie = cookies.Morpheus;
    assert.equal((await site("POST", "", cookie, { slug: "zion", name: "Zion" })).status, 201);
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    assert.equal((await site("POST", "/zion/claim", cookie, { code: claim.json.code, tag: "Zion" })).status, 200);
    assert.equal((await site("POST", "/zion/staff", cookie, { username: "Trinity" })).status, 200);
    t.app.db.prepare("INSERT INTO presence_community_members (community_id, account_id, joined_at) SELECT id, ?, ? FROM presence_communities WHERE slug = 'zion'")
      .run(idOf(t, "Smith"), t.sec());

    r = await report(t, LISTED, LISTED_KEY, [
      player(t, "Morpheus", LISTED, 1, DEV2), player(t, "Trinity", LISTED, 2, DEV3), player(t, "Neo", LISTED, 3, DEV1),
      player(t, "Smith", LISTED, 4, DEV4), player(t, "Tank", LISTED, 5)
    ]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.accounts).sort(), ["1", "2", "3", "4"], "Tank proves nothing here");
    assert.deepEqual(r.json.usernames, { 1: "Morpheus", 2: "Trinity", 3: "Neo", 4: "Smith" });
    assert.deepEqual(r.json.roles, { 1: "owner,staff,member", 2: "staff,member", 3: "h9_moderator", 4: "member" },
      "the site's role first, then the community's words; a site admin who proves nothing gets none");

    // a rename on the site is the next answer's name
    const entries = [player(t, "Morpheus", LISTED, 1, DEV2), player(t, "Neo", LISTED, 3, DEV1)];
    t.app.db.prepare("UPDATE accounts SET username = 'TheOne' WHERE id = ?").run(idOf(t, "Neo"));
    r = await report(t, LISTED, LISTED_KEY, entries);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.usernames, { 1: "Morpheus", 3: "TheOne" });
  });
});

describe("the ID proof's nonces, and pictures on the scoreboard", () => {
  let t;
  before(async () => {
    t = await app();
    for (const n of ["Neo", "Trinity", "Tank"]) await signup(t.base, n);
  });
  after(async () => {
    await t.close();
  });

  const nonceOf = async (server, key) => (await call(t, "server/nonce", server, key, {})).json.nonces[0];
  const answer = (name, server, nonce, device = DEV1) => {
    const pid = pidOf(t, name);
    const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
    const dm = Buffer.from(device, "hex");
    for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
    const devmask = dm.toString("hex");
    return { id: clientIdFor(pid, server), slot: 4, name, joined: t.sec() - 5, time: 5, nonce, devmask, proof: hmacHex(pid, "h9proof1:" + nonce + ":" + server + ":" + devmask) };
  };
  const provenRow = (name) => t.app.db.prepare("SELECT proven FROM presence_online WHERE account_id = ? AND server = ?").get(idOf(t, name), LISTED);
  const flags = (name) => t.app.db.prepare("SELECT kind FROM presence_flags WHERE account_id = ?").all(idOf(t, name)).map((f) => f.kind);

  test("a proof counts only for a nonce h9web gave this server, and only while it is fresh", async () => {
    const r = await call(t, "server/nonce", LISTED, LISTED_KEY, { count: 3 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.nonces.length, 3);
    assert.ok(r.json.nonces.every((n) => /^[0-9a-f]{32}$/.test(n)));
    assert.equal(r.json.maxAge, 600);
    assert.equal((await call(t, "server/nonce", LISTED, LISTED_KEY, { count: 9 })).status, 400);
    assert.equal((await call(t, "server/nonce", LISTED, randomHex(32), {})).status, 401, "signed");

    await report(t, LISTED, LISTED_KEY, [answer("Neo", LISTED, await nonceOf(LISTED, LISTED_KEY))]);
    assert.equal(provenRow("Neo").proven, 1, "fresh and issued: proven");

    await report(t, LISTED, LISTED_KEY, [answer("Trinity", LISTED, randomHex(16))]);
    assert.equal(provenRow("Trinity").proven, 0, "a nonce of the plugin's own: in game, unverified");
    assert.deepEqual(flags("Trinity"), [], "and not flagged: an older plugin does that");

    const old = await nonceOf(LISTED, LISTED_KEY);
    t.advance(601);
    await report(t, LISTED, LISTED_KEY, [answer("Tank", LISTED, old)]);
    assert.equal(provenRow("Tank"), undefined, "an old proof sent again is refused");
    assert.deepEqual(flags("Tank"), ["stale_proof"]);
  });

  test("the picture codec: PNG and GIF as Pillow decodes them, squared to 64 x 64", () => {
    for (const [name, type, w, h, sha, b64] of PICTURES) {
      const img = type === "image/gif" ? decodeGif(Buffer.from(b64, "base64")) : decodePng(Buffer.from(b64, "base64"));
      assert.deepEqual([img.width, img.height], [w, h], name);
      assert.equal(crypto.createHash("sha256").update(img.rgba).digest("hex"), sha, name);
      const sq = decodePng(encodePng(square(img)));
      assert.deepEqual([sq.width, sq.height], [64, 64], name);
    }
    assert.throws(() => decodePng(Buffer.from("not a picture")));
    assert.equal(gameVersion(1762041600123), 1762041600123 % 2147483647);
  });

  test("the report's answer names proven players' pictures; the game fetches them by version", async () => {
    t.app.db.exec(`CREATE TABLE IF NOT EXISTS forum_avatars (account_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, type TEXT NOT NULL,
      bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, frames INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    const dir = path.join(t.config.dataDir, "modules", "forum", "avatars");
    fs.mkdirSync(dir, { recursive: true });
    const version = 1762041600123;
    const png = Buffer.from(PICTURES[0][5], "base64");
    for (const n of ["Neo", "Trinity"]) {
      fs.writeFileSync(path.join(dir, idOf(t, n) + "-" + version + ".png"), png);
      t.app.db.prepare("INSERT OR REPLACE INTO forum_avatars VALUES (?, ?, 'image/png', ?, 9, 10, 1, 0)").run(idOf(t, n), version, png.length);
    }
    t.app.db.prepare("INSERT OR REPLACE INTO forum_avatars VALUES (?, ?, 'image/jpeg', 10, 9, 10, 1, 0)").run(idOf(t, "Tank"), version);

    const neo = answer("Neo", LISTED, await nonceOf(LISTED, LISTED_KEY));
    neo.slot = 2;
    const trin = player(t, "Trinity", LISTED, 3);
    const r = await report(t, LISTED, LISTED_KEY, [neo, trin]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.avatars, { 2: { a: idOf(t, "Neo"), v: gameVersion(version) } }, "only the proven player's");
    assert.deepEqual(r.json.accounts, { 2: idOf(t, "Neo") }, "the same slots as the pictures: the proven player's own account");

    const got = await fetch(t.base + "/api/presence/avatar/" + idOf(t, "Neo") + "/" + gameVersion(version) + ".png");
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.match(got.headers.get("cache-control"), /immutable/);
    const img = decodePng(Buffer.from(await got.arrayBuffer()));
    assert.deepEqual([img.width, img.height], [64, 64]);
    assert.equal((await fetch(t.base + "/api/presence/avatar/" + idOf(t, "Neo") + "/12345.png")).status, 404, "another version: none");
    assert.equal((await fetch(t.base + "/api/presence/avatar/" + idOf(t, "Tank") + "/" + gameVersion(version) + ".png")).status, 404, "a JPEG has none yet");
    assert.equal((await fetch(t.base + "/api/presence/avatar/abc/1.png")).status, 404);
  });
});

describe("Create Game servers, the default picture, browser-made copies, the board, the web client page", () => {
  let t;
  let tank;
  let neo;
  let admin;
  before(async () => {
    t = await app();
    // the forum's tables as its migrations make them, before anything reads them
    t.app.db.exec(`CREATE TABLE IF NOT EXISTS forum_avatars (account_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, type TEXT NOT NULL,
      bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, frames INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS forum_developers (account_id INTEGER PRIMARY KEY, added_by INTEGER, added_at INTEGER NOT NULL)`);
    neo = await signup(t.base, "Neo");
    tank = await signup(t.base, "Tank");
    await signup(t.base, "Morpheus");
    await signup(t.base, "Switch");
    admin = await adminCookie(t, "Oracle");
  });
  after(async () => {
    await t.close();
  });

  // the proof a game sends for nonce on server, with device
  const answerFor = (name, server, nonce, device = DEV1) => {
    const pid = pidOf(t, name);
    const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
    const dm = Buffer.from(device, "hex");
    for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
    const devmask = dm.toString("hex");
    return { id: clientIdFor(pid, server), nonce, devmask, proof: hmacHex(pid, "h9proof1:" + nonce + ":" + server + ":" + devmask) };
  };
  const listenEnroll = async (port) => {
    const r = await request(t.base, "POST", "/api/presence/enroll", { body: { v: 1, port, listen: true }, origin: null });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };

  test("a listen server enrolls by its own player's ID proof, counts proven players only, and never shows", async () => {
    const e = await listenEnroll(27031);
    assert.equal(e.server, "127.0.0.1:27031", "the caller's own IP");
    assert.equal(e.listen, true);
    assert.match(e.nonce, /^[0-9a-f]{32}$/);
    let st = await call(t, "enroll/status", e.server, e.key);
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.status, "pending_proof", "no rules probe for a listen server");
    assert.ok([401, 403].includes((await call(t, "server/nonce", e.server, e.key, {})).status), "the key is not live yet");

    // what does not prove it
    const stranger = { ...answerFor("Morpheus", e.server, e.nonce), id: randomHex(16) };
    assert.equal((await call(t, "enroll/status", e.server, e.key, { host: stranger })).json.error, "not_an_account");
    const wrong = { ...answerFor("Morpheus", e.server, e.nonce), proof: randomHex(32) };
    assert.equal((await call(t, "enroll/status", e.server, e.key, { host: wrong })).json.error, "bad_proof");
    const otherAddress = answerFor("Morpheus", "127.0.0.1:27099", e.nonce);
    assert.equal((await call(t, "enroll/status", e.server, e.key, { host: { ...otherAddress, id: clientIdFor(pidOf(t, "Morpheus"), e.server) } })).json.error, "bad_proof", "signed for another address");
    assert.equal((await call(t, "enroll/status", e.server, e.key, { host: answerFor("Morpheus", e.server, randomHex(16)) })).json.error, "stale_proof", "a nonce of its own");
    assert.equal((await call(t, "enroll/status", e.server, e.key, { host: { id: "x" } })).status, 400);

    st = await call(t, "enroll/status", e.server, e.key, { host: answerFor("Morpheus", e.server, e.nonce) });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.status, "active", "live at once: no admin");
    const row = t.app.db.prepare("SELECT listen, owner_id, approved FROM presence_enrolled WHERE server = ?").get(e.server);
    assert.deepEqual({ ...row }, { listen: 1, owner_id: idOf(t, "Morpheus"), approved: 1 });
    assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'presence.server.listen'").get());
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_proof_nonces WHERE nonce = ?").get(e.nonce).n, 0, "the nonce is used up");

    // its reports: the proven host counts, an unproven player is dropped
    const host = { ...player(t, "Morpheus", e.server, 1, DEV1), name: "Morpheus" };
    const joiner = player(t, "Switch", e.server, 2);
    const r = await report(t, e.server, e.key, [host, joiner]);
    assert.equal(r.status, 200, r.text);
    const on = (n) => t.app.db.prepare("SELECT proven FROM presence_online WHERE account_id = ? AND server = ?").get(idOf(t, n), e.server);
    assert.equal(on("Morpheus").proven, 1);
    assert.equal(on("Switch"), undefined, "only proven players on a listen server");

    // never shown: the host is in game somewhere, with no server, map or address
    const now = (await request(t.base, "GET", "/api/presence/now")).json;
    assert.ok(now.elsewhere.some((w) => w.username === "Morpheus"));
    assert.ok(!JSON.stringify(now.servers).includes("27031"));
    const card = (await request(t.base, "GET", "/api/presence/account/Morpheus")).json;
    assert.equal(card.state, "game");
    assert.ok(!JSON.stringify(card).includes("127.0.0.1"), "no address on the card");

    // the admin panel names it
    const list = (await request(t.base, "GET", "/api/presence/admin/servers", { cookie: admin })).json.servers;
    const mine = list.find((x) => x.address === e.server);
    assert.equal(mine.listen, true);
    assert.equal(mine.owner, "Morpheus");
  });

  test("a listen server enrolls only its own address, and needs the proof hooks", async () => {
    const r = await request(t.base, "POST", "/api/presence/enroll", { body: { v: 1, server: "203.0.113.77:27015", listen: true }, origin: null });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "address_mismatch");
  });

  test("the default picture: a proven account with none gets the site's, under one address every game keeps", async () => {
    // the module's copy is the site's own picture
    const site = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "havoc9.org", "assets", "avatar-default.png"));
    const mine = fs.readFileSync(path.join(import.meta.dirname, "..", "modules", "presence", "default-picture.png"));
    assert.ok(site.equals(mine), "modules/presence/default-picture.png is havoc9.org/assets/avatar-default.png");

    const nonce = (await call(t, "server/nonce", LISTED, LISTED_KEY, {})).json.nonces[0];
    const neoE = { ...answerFor("Neo", LISTED, nonce), slot: 5, name: "Neo", joined: t.sec() - 5, time: 5 };
    const r = await report(t, LISTED, LISTED_KEY, [neoE, player(t, "Switch", LISTED, 6)]);
    assert.equal(r.status, 200, r.text);
    const a = r.json.avatars;
    assert.deepEqual(Object.keys(a), ["5"], "the unproven player keeps the silhouette");
    assert.equal(a[5].a, DEFAULT_ACCOUNT);
    assert.deepEqual(r.json.accounts, { 5: idOf(t, "Neo") }, "the default picture's player by its own account number; the unproven one by none");
    assert.ok(Number.isInteger(a[5].v) && a[5].v > 0 && a[5].v < 2147483647);
    const got = await fetch(t.base + "/api/presence/avatar/" + DEFAULT_ACCOUNT + "/" + a[5].v + ".png");
    assert.equal(got.status, 200);
    assert.match(got.headers.get("cache-control"), /immutable/);
    const img = decodePng(Buffer.from(await got.arrayBuffer()));
    assert.deepEqual([img.width, img.height], [64, 64]);
    assert.equal((await fetch(t.base + "/api/presence/avatar/" + DEFAULT_ACCOUNT + "/" + (a[5].v + 1) + ".png")).status, 404);
  });

  test("a JPEG or WebP picture: its owner's browser sends the 64 x 64 copy, checked, kept and served", async () => {
    const version = 1762100000123;
    const id = idOf(t, "Tank");
    t.app.db.prepare("INSERT OR REPLACE INTO forum_avatars VALUES (?, ?, 'image/jpeg', 2000, 300, 200, 1, 0)").run(id, version);
    const mineView = async () => (await request(t.base, "GET", "/api/presence/avatar", { cookie: tank })).json;
    let v = await mineView();
    assert.equal(v.needed, true);
    assert.deepEqual(v.picture, { v: version, type: "image/jpeg" });
    assert.match(v.game, new RegExp("^api/presence/avatar/" + DEFAULT_ACCOUNT + "/"), "until then, the default");
    assert.equal((await request(t.base, "GET", "/api/presence/avatar")).status, 401);

    const good = encodePng(square(decodePng(Buffer.from(PICTURES[0][5], "base64"))));
    const send = (body, cookie = tank) => request(t.base, "POST", "/api/presence/avatar", { cookie, body });
    assert.equal((await send({ v: version - 1, png: good.toString("base64") })).json.error, "stale");
    const small = encodePng(square(decodePng(Buffer.from(PICTURES[0][5], "base64")), 32));
    assert.equal((await send({ v: version, png: small.toString("base64") })).json.error, "invalid_picture");
    const flat = encodePng({ width: 64, height: 64, rgba: Buffer.alloc(64 * 64 * 4, 255) });
    assert.equal((await send({ v: version, png: flat.toString("base64") })).json.error, "blank_picture");
    const huge = Buffer.from(good);
    huge.writeUInt32BE(30000, 16);
    huge.writeUInt32BE(30000, 20);
    assert.equal((await send({ v: version, png: huge.toString("base64") })).json.error, "invalid_picture", "never decoded");
    assert.equal((await send({ v: version, png: "not base64!" })).json.error, "invalid_picture");
    assert.equal((await request(t.base, "POST", "/api/presence/avatar", { cookie: tank, body: { v: version, png: good.toString("base64") }, origin: "https://evil.example" })).status, 403, "the site's own pages only");

    let r = await send({ v: version, png: good.toString("base64") });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.changed, true);
    assert.equal(r.json.game, "api/presence/avatar/" + id + "/" + gameVersion(version) + ".png");
    r = await send({ v: version, png: encodePng(square(decodePng(Buffer.from(PICTURES[1][5], "base64")))).toString("base64") });
    assert.equal(r.json.changed, false, "the first copy of a version stays");
    v = await mineView();
    assert.equal(v.needed, false);
    assert.equal(v.game, "api/presence/avatar/" + id + "/" + gameVersion(version) + ".png");

    const got = await fetch(t.base + "/" + v.game);
    assert.equal(got.status, 200);
    const img = decodePng(Buffer.from(await got.arrayBuffer()));
    assert.ok(img.rgba.equals(decodePng(good).rgba), "the copy as it was sent");

    // in the report's answer, for the proven owner
    const nonce = (await call(t, "server/nonce", LISTED, LISTED_KEY, {})).json.nonces[0];
    const tankE = { ...answerFor("Tank", LISTED, nonce), slot: 7, name: "Tank", joined: t.sec() - 5, time: 5 };
    const rep = await report(t, LISTED, LISTED_KEY, [tankE]);
    assert.deepEqual(rep.json.avatars[7], { a: id, v: gameVersion(version) });
    assert.equal(rep.json.accounts[7], id);

    // a PNG picture is the site's to make
    t.app.db.prepare("INSERT OR REPLACE INTO forum_avatars VALUES (?, ?, 'image/png', 2000, 9, 10, 1, 0)").run(idOf(t, "Neo"), version);
    assert.equal((await send({ v: version, png: good.toString("base64") }, neo)).json.error, "not_needed");
  });

  test("the site's server board leaves out what a module hides (ctx.servers.hideFromBoard)", async () => {
    const entry = t.app.servers.byAddress.get(LISTED);
    t.app.status.state.set(entry.target.key, { answer: { kind: "ip", name: "HAVOC 9", map: "h9_tsrp_hive", mode: "Roleplay", players: 1, max: 32, bots: 0 }, answeredAt: Date.now(), ping: 5 });
    const board = async () => (await request(t.base, "GET", "/api/servers")).json.servers.map((x) => x.address);
    assert.ok((await board()).includes(LISTED));
    const off = serversHook({ servers: t.app.servers, status: t.app.status }).hideFromBoard((address) => address === LISTED);
    assert.ok(!(await board()).includes(LISTED), "hidden while the filter says so");
    off();
    assert.ok((await board()).includes(LISTED), "and back once it is taken away");
    const offBroken = serversHook({ servers: t.app.servers, status: t.app.status }).hideFromBoard(() => { throw new Error("broken"); });
    assert.ok((await board()).includes(LISTED), "a filter that throws hides nothing");
    offBroken();

    // presence's own filter: a private community's server
    const site = (method, p, cookie, body) => request(t.base, method, "/api/presence/communities" + p, { cookie, body });
    assert.equal((await site("POST", "", tank, { slug: "nebuchadnezzar", name: "Nebuchadnezzar" })).status, 201);
    const code = (await call(t, "server/claim", LISTED, LISTED_KEY)).json.code;
    assert.equal((await site("POST", "/nebuchadnezzar/claim", tank, { code, tag: "Neb" })).status, 200);
    assert.ok((await board()).includes(LISTED), "a listed community's server shows");
    assert.equal((await site("PATCH", "/nebuchadnezzar", tank, { visibility: "private" })).status, 200);
    assert.ok(!(await board()).includes(LISTED), "a private community's server does not");
    assert.equal((await site("PATCH", "/nebuchadnezzar", tank, { visibility: "listed" })).status, 200);
    assert.ok((await board()).includes(LISTED));
  });

  test("the web client's page keeps its player IN THE WEB CLIENT while it is open", async () => {
    const state = async () => (await request(t.base, "GET", "/api/presence/account/Switch")).json.state;
    const sw = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: PASSWORD } });
    const r = await request(t.base, "POST", "/api/presence/web", { cookie: sw.cookie, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.every, 60);
    assert.equal(await state(), "web");
    assert.ok((await request(t.base, "GET", "/api/presence/now")).json.web.some((w) => w.username === "Switch"));
    t.advance(181);
    assert.notEqual(await state(), "web", "three minutes without a word: not in the web client any more");
    assert.equal((await request(t.base, "POST", "/api/presence/web", { body: {} })).status, 401);
  });

  test("a DEVELOPER's name comes with developer: true on the cards and lists", async () => {
    t.app.db.prepare("INSERT OR REPLACE INTO forum_developers (account_id, added_by, added_at) VALUES (?, NULL, 0)").run(idOf(t, "Switch"));
    const sw = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: PASSWORD } });
    await request(t.base, "POST", "/api/presence/web", { cookie: sw.cookie, body: {} });
    const card = (await request(t.base, "GET", "/api/presence/account/Switch")).json;
    assert.equal(card.developer, true);
    const web = (await request(t.base, "GET", "/api/presence/now")).json.web;
    assert.equal(web.find((w) => w.username === "Switch").developer, true);
    assert.equal((await request(t.base, "GET", "/api/presence/account/Neo")).json.developer, undefined, "nobody else");
  });
});

describe("the community chat: the owner's open switch, and the Discord bridge", () => {
  let t;
  let owner;
  let adminOfIt;
  let stranger;
  let siteAdmin;
  const sent = [];
  const watched = [];
  before(async () => {
    t = await app();
    owner = await signup(t.base, "Morpheus");
    adminOfIt = await signup(t.base, "Niobe");
    stranger = await signup(t.base, "Smith");
    siteAdmin = await adminCookie(t, "Oracle");
    await signup(t.base, "Neo");
    t.app.events.on("discord-relay-out", (e) => sent.push(e));
    t.app.events.on("discord-relay-watch", (e) => watched.push(e));
    const site = (method, p, cookie, body) => request(t.base, method, "/api/presence/communities" + p, { cookie, body });
    assert.equal((await site("POST", "", owner, { slug: "zion", name: "Zion" })).status, 201);
    assert.ok((await site("POST", "/zion/staff", owner, { username: "Niobe" })).status < 300);
    const code = (await call(t, "server/claim", LISTED, LISTED_KEY)).json.code;
    assert.equal((await site("POST", "/zion/claim", owner, { code, tag: "Zion" })).status, 200);
  });
  after(async () => {
    await t.close();
  });
  const site = (method, p, cookie, body) => request(t.base, method, "/api/presence/communities" + p, { cookie, body });

  test("open chat: the owner's switch; members-only by default, and always in a private community", async () => {
    assert.equal((await site("GET", "/zion/chat", stranger)).status, 403, "members only by default");
    assert.equal((await site("POST", "/zion/chat", stranger, { text: "hi" })).status, 403);
    let r = await site("PATCH", "/zion", adminOfIt, { chatOpen: true });
    assert.equal(r.status, 403, "an admin may not open it");
    assert.match(r.json.message, /owner/);
    assert.equal((await site("PATCH", "/zion", adminOfIt, { name: "Zion", chat: true })).status, 200, "the other settings stay the admins'");
    r = await site("PATCH", "/zion", owner, { chatOpen: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.chatOpen, true);
    assert.equal((await site("GET", "/zion", stranger)).json.me.chat, true);
    assert.equal((await site("GET", "/zion/chat", stranger)).status, 200, "every signed-in account");
    assert.equal((await site("POST", "/zion/chat", stranger, { text: "hello zion" })).status, 201);
    assert.equal((await site("GET", "/zion/chat")).status, 401, "signed in, though");
    assert.equal((await site("PATCH", "/zion", owner, { visibility: "private" })).status, 200);
    assert.equal((await site("GET", "/zion/chat", stranger)).status, 403, "private: members only, whatever the switch says");
    assert.equal((await site("PATCH", "/zion", owner, { visibility: "listed", chatOpen: false })).status, 200);
    assert.equal((await site("GET", "/zion/chat", stranger)).status, 403, "closed again");
    const audit = t.app.db.prepare("SELECT detail FROM audit_log WHERE action = 'community.settings' ORDER BY id DESC LIMIT 1").get();
    assert.match(audit.detail, /"chatOpen":0/);
  });

  test("the Discord bridge: an H9 site admin sets it; game and web lines go out, Discord's come in, never back", async () => {
    const CH = "123456789012345678";
    assert.equal((await site("PUT", "/zion/discord", owner, { channel: CH })).status, 403, "H9's site admins only");
    assert.equal((await site("PUT", "/zion/discord", siteAdmin, { channel: "12345" })).status, 400);
    watched.length = 0;
    let r = await site("PUT", "/zion/discord", siteAdmin, { channel: CH });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.discord, true);
    assert.equal(r.json.discordChannel, CH);
    assert.deepEqual(watched.at(-1).channels, [{ channel: CH, after: null }], "the discord module is told");
    assert.equal((await site("GET", "/zion", owner)).json.discordChannel, undefined, "the channel id is for H9's admins");
    assert.equal((await site("GET", "/zion", owner)).json.discord, true, "that there is a bridge is not");
    await site("POST", "", stranger, { slug: "machine", name: "The Machine" });
    assert.equal((await site("PUT", "/machine/discord", siteAdmin, { channel: CH })).status, 409, "one community a channel");

    // out: a game line (.relay) and a web line, as text; announcements too
    sent.length = 0;
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 3, DEV1)]);
    assert.equal((await call(t, "server/chat", LISTED, LISTED_KEY, { id: clientIdFor(pidOf(t, "Neo"), LISTED), text: "@everyone **look** <@1>" })).status, 200);
    assert.equal((await site("POST", "/zion/chat", owner, { text: "from the web" })).status, 201);
    assert.equal((await site("POST", "/zion/announce", owner, { text: "server restart" })).status, 201);
    assert.deepEqual(sent.map((e) => [e.channel, e.kind, e.tag, e.name, e.text]), [
      [CH, "chat", "Zion", "Neo", "@everyone **look** <@1>"],
      [CH, "chat", "Web", "Morpheus", "from the web"],
      [CH, "announce", "Zion", "Morpheus", "server restart"],
    ], "the discord module escapes and blocks mentions (modules/discord)");

    // in: to the servers and the web chat, as [Discord]; never sent back out
    sent.length = 0;
    t.app.events.emit("discord-relay-in", { channel: CH, id: "223456789012345678", name: "Tank [ops]:", text: "hello %s from ^1discord", at: t.sec() });
    const lines = (await site("GET", "/zion/chat", owner)).json.messages;
    const last = lines.at(-1);
    const said = chatText("hello %s from ^1discord", 120);
    assert.deepEqual([last.source, last.tag, last.name, last.text], ["discord", "Discord", "Tank ops", said]);
    assert.equal(sent.length, 0, "a Discord line is not echoed to Discord");
    const poll = await call(t, "server/poll", LISTED, LISTED_KEY, { since: last.id - 1, hold: 0 });
    assert.ok(poll.json.messages.some((m) => m.line === "[Discord] Tank ops: " + said), "every server on the relay");
    assert.equal(t.app.db.prepare("SELECT discord_last FROM presence_communities WHERE slug = 'zion'").get().discord_last, "223456789012345678");
    const before = (await site("GET", "/zion/chat", owner)).json.messages.length;
    t.app.events.emit("discord-relay-in", { channel: CH, id: "223456789012345679", name: "Tank", text: "an old one", at: t.sec() - 3600 });
    t.app.events.emit("discord-relay-in", { channel: "999999999999999999", id: "1", name: "x", text: "not bridged", at: t.sec() });
    assert.equal((await site("GET", "/zion/chat", owner)).json.messages.length, before, "old news and other channels are dropped");

    t.app.events.emit("discord-relay-status", { channel: CH, ok: false, error: "no_access" });
    assert.equal((await site("GET", "/zion", siteAdmin)).json.discordStatus.error, "no_access", "H9's admins see how the channel answers");
    r = await site("PUT", "/zion/discord", siteAdmin, { channel: null });
    assert.equal(r.json.discord, false);
    assert.deepEqual(watched.at(-1).channels, [], "and stops");
    assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'community.discord'").get());
  });
});

describe("a listen server's own player: the report's host slot and the answer's word on it", () => {
  let t;
  before(async () => {
    t = await app();
    await signup(t.base, "Morpheus");
  });
  after(async () => {
    await t.close();
  });

  test("unknown, known or proven, for that slot only", async () => {
    const stranger = { id: randomHex(16), slot: 1, name: "host", joined: t.sec() - 5, time: 5 };
    let r = await report(t, LISTED, LISTED_KEY, [stranger], { host: 1 });
    assert.equal(r.json.host, "unknown", "an id no account gives here: the game's player id is not its account's");
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Morpheus", LISTED, 1)], { host: 1 });
    assert.equal(r.json.host, "known", "the account, without a proof");
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Morpheus", LISTED, 1, DEV1)], { host: 1 });
    assert.equal(r.json.host, "proven");
    r = await report(t, LISTED, LISTED_KEY, [player(t, "Morpheus", LISTED, 1, DEV1)]);
    assert.equal(r.json.host, undefined, "no host slot, no word");
  });
});

describe("accounts-only servers: the answer's proven slots, and a linked game's device", () => {
  let t;
  before(async () => {
    t = await app();
    await signup(t.base, "Morpheus");
    await signup(t.base, "Neo");
  });
  after(async () => {
    await t.close();
  });
  const devices = (name) => t.app.db.prepare("SELECT device, status FROM presence_devices WHERE account_id = ? ORDER BY device").all(idOf(t, name)).map((r) => ({ ...r }));
  const deviceHash = (hex) => crypto.createHash("sha256").update("h9device1:").update(Buffer.from(hex, "hex")).digest("hex").slice(0, 32);

  test("the answer lists the slots that proved an account, and no other", async () => {
    const r = await report(t, LISTED, LISTED_KEY, [player(t, "Morpheus", LISTED, 3, DEV1), player(t, "Neo", LISTED, 4), { id: randomHex(16), slot: 5, name: "x", joined: t.sec() - 5, time: 5 }]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.proven, [3]);
  });

  test("a game linked to its account may prove it from its device at once; revoking takes that away", async () => {
    // Morpheus's first proof bound DEV1; a linked second install brings DEV2
    assert.deepEqual(devices("Morpheus").map((d) => d.status), ["bound"]);
    t.app.events.emit("account-link", { id: idOf(t, "Morpheus"), link: 7, device: deviceHash(DEV2) });
    assert.deepEqual(devices("Morpheus").find((d) => d.device === deviceHash(DEV2)).status, "allowed");
    const r = await report(t, LISTED, LISTED_KEY, [player(t, "Morpheus", LISTED, 3, DEV2)]);
    assert.deepEqual(r.json.proven, [3], "no second-device refusal for the linked install");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_flags WHERE account_id = ? AND kind = 'second_device'").get(idOf(t, "Morpheus")).n, 0);
    t.app.events.emit("account-unlink", { id: idOf(t, "Morpheus"), link: 7, device: deviceHash(DEV2), reason: "revoked" });
    assert.equal(devices("Morpheus").find((d) => d.device === deviceHash(DEV2)), undefined, "a revoked link's device is no longer allowed");
    t.app.events.emit("account-unlink", { id: idOf(t, "Morpheus"), link: 6, device: deviceHash(DEV1), reason: "revoked" });
    assert.deepEqual(devices("Morpheus").map((d) => d.status), ["bound"], "the bound one stays: only an admin unbinds it");
    // an account with no device yet: the linked one is bound
    t.app.events.emit("account-link", { id: idOf(t, "Neo"), link: 8, device: deviceHash(DEV2) });
    assert.deepEqual(devices("Neo"), [{ device: deviceHash(DEV2), status: "bound" }]);
    t.app.events.emit("account-link", { id: idOf(t, "Neo"), link: 9, device: "not a hash" });
    assert.equal(devices("Neo").length, 1);
  });
});

describe("a game that cannot prove its player id: chat, shared data and /find leave it out", () => {
  let t;
  let owner;
  let trinity;
  const site = (method, p, cookie, body) => request(t.base, method, "/api/presence/communities" + p, { cookie, body });
  const idOn = (name) => clientIdFor(pidOf(t, name), LISTED);
  const said = (text) => call(t, "server/chat", LISTED, LISTED_KEY, { id: idOn("Neo"), text });
  const lines = () => t.app.db.prepare("SELECT count(*) AS n FROM presence_messages WHERE kind = 'chat'").get().n;
  const set = (id, value) => call(t, "server/data/set", LISTED, LISTED_KEY, { id, key: "rp.money", value });
  const get = (fields) => call(t, "server/data/get", LISTED, LISTED_KEY, { keys: ["rp.money"], ...fields });
  const settings = (body) => site("PATCH", "/zion", owner, body);
  before(async () => {
    t = await app();
    owner = await signup(t.base, "Morpheus");
    trinity = await signup(t.base, "Trinity");
    for (const n of ["Neo", "Tank"]) await signup(t.base, n);
    await site("POST", "", owner, { slug: "zion", name: "Zion" });
    const claim = await call(t, "server/claim", LISTED, LISTED_KEY);
    await site("POST", "/zion/claim", owner, { code: claim.json.code, tag: "Zion" });
    assert.equal((await site("POST", "/zion/join", trinity, {})).status, 200);
  });
  after(async () => {
    await t.close();
  });

  test("a community is made with both proof switches on, and the poll tells the plugin", async () => {
    let view = (await site("GET", "/zion", owner)).json;
    assert.deepEqual([view.chatProof, view.dataProof], [true, true]);
    assert.deepEqual({ ...t.app.db.prepare("SELECT chat_proof, data_proof FROM presence_communities WHERE slug = 'zion'").get() }, { chat_proof: 1, data_proof: 1 });
    let c = (await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 })).json.community;
    assert.deepEqual([c.chatProof, c.dataProof], [true, true]);
    await settings({ chatProof: false });
    c = (await call(t, "server/poll", LISTED, LISTED_KEY, { hold: 0 })).json.community;
    assert.deepEqual([c.chatProof, c.dataProof], [false, true], "an explicit opt-out is kept, and the plugin hears of it");
    await settings({ chatProof: true });
  });

  test("a copy of the id of a player who is not in game does not speak as that player", async () => {
    // Neo is not in game; a game with no proof announces his id (its owner copied it)
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1)]);
    const before = lines();
    const r = await said("Admin says: join my server");
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "unverified");
    assert.equal(lines(), before, "nothing was posted to the community's servers or its page");
  });

  test("the owner may switch the proof off for chat: the announced id is taken, as the plugin's own gate says", async () => {
    assert.equal((await settings({ chatProof: false })).status, 200);
    const r = await said("hello");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.line, "[Zion] Neo: hello");
    assert.equal((await settings({ chatProof: true })).status, 200);
    assert.equal((await said("hello again")).json.error, "unverified");
  });

  test("only the owner switches a proof requirement off; an admin may switch it on", async () => {
    assert.equal((await site("POST", "/zion/staff", owner, { username: "Trinity" })).status, 200);
    const stay = await site("PATCH", "/zion", trinity, { chatProof: true, dataProof: true });
    assert.equal(stay.status, 200, "an admin saves the page with the switches as they are");
    for (const body of [{ chatProof: false }, { dataProof: false }]) {
      const r = await site("PATCH", "/zion", trinity, body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.match(r.json.message, /owner may switch off the proof/);
    }
    assert.deepEqual(t.app.db.prepare("SELECT chat_proof, data_proof FROM presence_communities WHERE slug = 'zion'").all().map((r) => [r.chat_proof, r.data_proof]), [[1, 1]]);
    assert.equal((await settings({ chatProof: false })).status, 200, "the owner");
    assert.equal((await site("PATCH", "/zion", trinity, { chatProof: true })).status, 200, "an admin may put it back on");
    assert.equal(t.app.db.prepare("SELECT chat_proof FROM presence_communities WHERE slug = 'zion'").get().chat_proof, 1);
  });

  test("a proven game speaks, writes and reads", async () => {
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1)]);
    assert.equal((await said("proven")).status, 200);
    assert.equal((await set(idOn("Neo"), "5")).status, 200);
    assert.equal((await get({ id: idOn("Neo") })).json.values["rp.money"].value, "5");
  });

  test("shared data by an announced id alone: refused to write and to read, until the owner switches it off; by name it is read as ever", async () => {
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1)]);
    assert.equal((await set(idOn("Neo"), "6")).json.error, "unverified");
    assert.equal((await get({ id: idOn("Neo") })).json.error, "unverified", "a plugin that gives perks from the read is not fooled");
    assert.equal((await get({ account: "Neo" })).json.values["rp.money"].value, "5", "the server may read any account's value by name");
    await settings({ dataProof: false });
    assert.equal((await set(idOn("Neo"), "7")).status, 200);
    assert.equal((await get({ id: idOn("Neo") })).json.values["rp.money"].value, "7");
    await settings({ dataProof: true });
    assert.equal((await get({ id: idOn("Neo") })).json.error, "unverified");
  });

  test("/find: an unproven asker is nobody, and an unproven game does not place the player it names", async () => {
    await settings({ visibility: "private" });
    const find = (q, fields) => call(t, "server/find", LISTED, LISTED_KEY, { q, ...fields });
    // Neo and Trinity, both proven: a member who asks sees the private server
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2, DEV1)]);
    assert.equal((await find("Neo", { id: idOn("Trinity") })).json.results[0].address, LISTED, "a proven member");
    // a game that announces Trinity's id with no proof asks: the server stays hidden
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2)]);
    assert.equal((await find("Neo", { id: idOn("Trinity") })).json.results[0].address, null, "an unproven asker");
    assert.equal((await find("Neo", {})).json.results[0].address, null, "nobody asking");
    await settings({ visibility: "listed" });
    // Trinity is on that server only by an unproven sighting: the site does not say where she is
    const place = (await find("Trinity", {})).json.results[0];
    assert.notEqual(place.state, "game");
    assert.equal(place.address, null);
    await report(t, LISTED, LISTED_KEY, [player(t, "Neo", LISTED, 1, DEV1), player(t, "Trinity", LISTED, 2, DEV1)]);
    assert.equal((await find("Trinity", {})).json.results[0].address, LISTED, "proven: findable");
  });
});

describe("migration 14: every community that exists gets the proof switches on", () => {
  test("rows made with the old default, or with one switch on, come out with both on; a community made after is made with both on", async () => {
    const t = await startApp({ limits: CORE_ROOMY }, { servers: [] });
    try {
      migrate(t.app.db, "presence", MIGRATIONS.slice(0, 13), {});
      await signup(t.base, "Morpheus");
      const owner = t.app.accounts.getByUsername("Morpheus").id;
      const ins = t.app.db.prepare("INSERT INTO presence_communities (slug, name, owner_id, created_at, chat_proof, data_proof) VALUES (?, ?, ?, 1, ?, ?)");
      ins.run("never-chose", "Never chose", owner, 0, 0);
      ins.run("chat-only", "Chat only", owner, 1, 0);
      ins.run("data-only", "Data only", owner, 0, 1);
      assert.deepEqual(migrate(t.app.db, "presence", MIGRATIONS, {}), [14, 15], "the next migrations run");
      const rows = t.app.db.prepare("SELECT slug, chat_proof, data_proof FROM presence_communities ORDER BY slug").all().map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { slug: "chat-only", chat_proof: 1, data_proof: 1 },
        { slug: "data-only", chat_proof: 1, data_proof: 1 },
        { slug: "never-chose", chat_proof: 1, data_proof: 1 },
      ]);
    } finally {
      await t.close();
    }
  });

  test("a community made through the site has both on, and an owner's explicit off after the migration stays off", async () => {
    const t = await app();
    try {
      const cookie = await signup(t.base, "Morpheus");
      const made = await request(t.base, "POST", "/api/presence/communities", { cookie, body: { slug: "zion", name: "Zion" } });
      assert.equal(made.status, 201, made.text);
      assert.deepEqual([made.json.chatProof, made.json.dataProof], [true, true]);
      const off = await request(t.base, "PATCH", "/api/presence/communities/zion", { cookie, body: { chatProof: false, dataProof: false } });
      assert.deepEqual([off.json.chatProof, off.json.dataProof], [false, false]);
      assert.deepEqual({ ...t.app.db.prepare("SELECT chat_proof, data_proof FROM presence_communities WHERE slug = 'zion'").get() }, { chat_proof: 0, data_proof: 0 });
    } finally {
      await t.close();
    }
  });
});
