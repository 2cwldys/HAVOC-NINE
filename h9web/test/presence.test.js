import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startApp, request, signup, fakeGameServer, until, openRelay } from "./helpers.js";
import { migrate, transaction } from "../lib/db.js";
import { loadSecrets } from "../lib/config.js";
import { HttpError, clientIp } from "../lib/http.js";
import { RateLimiter, ipKey } from "../lib/ratelimit.js";
import { serverClientId } from "../lib/playerid.js";
import { parseAddress } from "../lib/servers.js";
import { createPresence, presenceSettings, MIGRATIONS, DEFAULTS } from "../modules/presence/index.js";
import { modeFor, keyFromDescription, cleanMap, cleanText } from "../modules/presence/modes.js";
import { writeKeys, readKeys } from "../modules/presence/keys.js";
import { serversHook } from "../lib/modules.js";
import { createClientIds } from "../lib/clientids.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const KEY_SCRIPT = path.join(MODULES, "presence", "bin", "presence-key.js");

const A = "203.0.113.10:27015"; // listed, has a key
const B = "198.51.100.20:27016"; // listed, has a key
const C = "203.0.113.10:27020"; // the same IP as A, not listed, has a key
const D = "198.51.100.30:27015"; // listed, no key
const KEYS = {
  [A]: crypto.randomBytes(32).toString("hex"),
  [B]: crypto.randomBytes(32).toString("hex"),
  [C]: crypto.randomBytes(32).toString("hex"),
};
const SERVERS = [
  { name: "HAVOC 9", address: A },
  { name: "HAVOC 9 Siege", address: B },
  { name: "HAVOC 9 test", address: C, listed: false },
  { name: "HAVOC 9 keyless", address: D },
];
// installs (device ids) and coarse networks
const DEV1 = "11".repeat(16);
const DEV2 = "22".repeat(16);
const DEV3 = "33".repeat(16);
const NET1 = "100.64.7";
const NET2 = "100.72.9";

const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const CORE_ROOMY = { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY };
const roomy = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
const PASSWORD = "correct horse battery staple";

// Site activity on the tests' clock: core's lastActive and activeSince (lib/auth.js) answer from
// the wall clock, so the tests that move the clock by hand use this in their place. It answers the
// way core does (a signed-in request, or the sessions' last_seen_at), plus what a test sets with
// touch(). Core's own is tested in "presence: core's hooks" below.
function createActivity({ db }) {
  const recent = new Map();
  const last = db.prepare("SELECT max(last_seen_at) AS t FROM sessions WHERE account_id = ?");
  const since = db.prepare("SELECT account_id, max(last_seen_at) AS t FROM sessions GROUP BY account_id HAVING t >= ?");
  return {
    touch: (accountId, at) => recent.set(accountId, at),
    forget: (accountId) => recent.delete(accountId),
    lastActive(accountId) {
      if (recent.has(accountId)) return recent.get(accountId);
      const r = last.get(accountId);
      return r && r.t ? r.t : null;
    },
    activeSince(t) {
      const ids = new Set(since.all(t).map((r) => r.account_id));
      for (const [id, at] of recent) {
        if (at >= t) ids.add(id);
        else ids.delete(id);
      }
      return [...ids];
    },
  };
}

// The service with no presence module of its own, and the module made beside it from the same
// parts the registry hands a module: core's hooks (lib/clientids.js, lib/accounts.js, serversHook
// from lib/modules.js), the site activity above, and a clock the tests move by hand. hooks
// replaces core's (null takes one away).
async function presenceApp({ settings = {}, servers = SERVERS, hooks = {} } = {}) {
  const t = await startApp({ limits: CORE_ROOMY }, { servers });
  const secrets = loadSecrets(t.config.dataDir);
  const clock = { ms: Date.now() };
  migrate(t.app.db, "presence", MIGRATIONS, {});
  const activity = createActivity({ db: t.app.db });
  const dataDir = path.join(t.config.dataDir, "modules", "presence");
  const core = t.app.accounts;
  const accounts = {
    getById: core.getById, getByUsername: core.getByUsername, publicView: core.publicView, isBanned: core.isBanned,
    clientIdIndex: t.app.clientIds.clientIdIndex, verifyIdProof: core.verifyIdProof, resetPlayerId: core.resetPlayerId,
    movePlayerId: core.movePlayerId, nameInUse: core.nameInUse, ...hooks,
  };
  for (const [k, v] of Object.entries(accounts)) if (v === null) delete accounts[k];
  const p = createPresence({
    db: t.app.db,
    transaction: (fn) => transaction(t.app.db, fn),
    router: t.app.router.scoped(["/api/presence"]),
    auth: { ...t.app.auth, lastActive: activity.lastActive, activeSince: activity.activeSince, confirmAdmin: t.app.confirmAdmin },
    accounts,
    servers: serversHook({ servers: t.app.servers, status: t.app.status }),
    events: t.app.events,
    audit: t.app.audit,
    log: t.app.log.child("presence"),
    settings: { limits: roomy(), cacheSeconds: 0, ...settings },
    dataDir,
    http: { HttpError, clientIp: (req) => clientIp(req, t.config.trustProxy) },
    limits: { RateLimiter, ipKey },
    now: () => clock.ms,
  });
  p.start();
  writeKeys(path.join(dataDir, "server-keys.json"), new Map(Object.entries(KEYS).map(([a, key]) => [a, { key, created: "2026-11-01T00:00:00Z" }])));
  p.keys.touch();
  return {
    ...t, p, clock, secrets, dataDir, activity,
    sec: () => Math.floor(clock.ms / 1000),
    advance(seconds) { clock.ms += seconds * 1000; },
    async close() { p.stop(); await t.close(); },
  };
}

const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();
const pidOf = (t, username) => t.app.accounts.playerId(t.app.accounts.getByUsername(username));
const idOf = (t, username) => t.app.accounts.getByUsername(username).id;
const randomHex = (n) => crypto.randomBytes(n).toString("hex");
// What the engine sends to the server at address (engine-h9-userid.patch): MD5(player id as text
// + the server's 4 IPv4 bytes).
const clientIdFor = (pid, address) => serverClientId(pid, parseAddress(address).bytes);
const nonceAt = (sec) => sec.toString(16).padStart(8, "0") + randomHex(12);
// The device id's hash, as core's verifyIdProof gives it.
const deviceHash = (device) => crypto.createHash("sha256").update("h9device1:").update(Buffer.from(device, "hex")).digest("hex").slice(0, 32);

// The engine's answer to the plugin's challenge (docs/H9_PRESENCE.txt, "The id proof").
function makeProof(pid, server, device, nonce) {
  const mask = hmac(pid, "h9dev1:" + nonce);
  const dm = Buffer.from(device, "hex");
  for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
  const devmask = dm.toString("hex");
  return { nonce, devmask, proof: hmac(pid, "h9proof1:" + nonce + ":" + server + ":" + devmask).toString("hex") };
}

// A nonce as h9web issues it to a server for its challenge (POST /api/presence/server/nonce), at the
// time the test nonce carries in its first 8 hex.
function issue(t, server, nonce) {
  t.app.db.prepare("INSERT OR IGNORE INTO presence_proof_nonces (nonce, server, issued_at) VALUES (?, ?, ?)").run(nonce, server, parseInt(nonce.slice(0, 8), 16));
}

// A player as the plugin reports it: proven (the client answered the challenge) unless proof is false.
function entry(t, pid, server, { device = DEV1, proof = true, nonce, net = NET1, name = "player", joined, time, proofServer } = {}) {
  const e = { id: clientIdFor(pid, server), name, joined: joined === undefined ? t.sec() - 5 : joined, time: time === undefined ? 5 : time };
  if (proof) {
    const n = nonce || nonceAt(t.sec());
    issue(t, server, n);
    Object.assign(e, makeProof(pid, proofServer || server, device, n));
    if (net) e.net = net;
  }
  return e;
}
const as = (t, username, server, opts = {}) => entry(t, pidOf(t, username), server, { name: username + "-ingame", ...opts });

// A report, signed the way h9_presence.sma signs it.
function send(t, { server = A, key, ts, players = [], map = "h9_te_neuropolis", mode = "Team Elimination", detail, body, signature, headers = {}, ip, contentType } = {}) {
  const text = body !== undefined ? body : JSON.stringify({ v: 1, server, ts: ts === undefined ? t.sec() : ts, reason: "tick", map, mode, detail, players });
  const sig = signature !== undefined ? signature : hmac(key === undefined ? KEYS[server] || KEYS[A] : key, text).toString("hex");
  const h = { "x-h9-server": server, ...headers };
  if (sig !== null) h["x-h9-signature"] = sig;
  return request(t.base, "POST", "/api/presence/report", { body: text, origin: null, headers: h, ip, contentType });
}

async function ok(t, opts) {
  const r = await send(t, opts);
  assert.equal(r.status, 200, r.text);
  return r;
}

const get = (t, p, opts = {}) => request(t.base, "GET", p, opts);
const rows = (t, table) => t.app.db.prepare("SELECT * FROM " + table).all();
const onlineOf = (t, username) => t.app.db.prepare("SELECT * FROM presence_online WHERE account_id = ? ORDER BY since, server").all(idOf(t, username));
const playtime = (t, username) => t.app.db.prepare("SELECT COALESCE(sum(seconds), 0) AS s FROM presence_playtime WHERE account_id = ?").get(idOf(t, username)).s;
const flagsOf = (t, username) => t.app.db.prepare("SELECT * FROM presence_flags WHERE account_id = ? ORDER BY id").all(idOf(t, username));
const login = async (t, username) => (await request(t.base, "POST", "/api/login", { body: { username, password: PASSWORD } })).cookie;

async function adminCookie(t, name = "Oracle") {
  const cookie = await signup(t.base, name);
  t.app.accounts.setRole(idOf(t, name), "admin");
  return cookie;
}

// every text value in the module's tables, for "never stored" checks
function storedText(t) {
  const out = [];
  for (const table of ["presence_settings", "presence_servers", "presence_online", "presence_sessions", "presence_playtime",
    "presence_devices", "presence_flags", "presence_nets"]) {
    for (const r of rows(t, table)) out.push(JSON.stringify(r));
  }
  return out.join("\n");
}

describe("presence: reports and their authentication", () => {
  let t;
  before(async () => {
    t = await presenceApp();
    await signup(t.base, "Trinity");
    await signup(t.base, "Neo");
  });
  after(async () => {
    await t.close();
  });

  test("a signed report is accepted; ids no account has are dropped, never stored or logged", async () => {
    const stranger = randomHex(16);
    const r = await ok(t, { players: [as(t, "Trinity", A), { id: stranger, name: "Ghost-Visitor-77", joined: t.sec() - 50, time: 50 }] });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.players, 2);
    assert.match(r.json.serverId, /^[a-z2-9]{10}$/, "every server that reports has a public server id");
    assert.deepEqual(r.json.actions, {}, "nobody to kick or mute");
    const online = rows(t, "presence_online");
    assert.equal(online.length, 1);
    assert.equal(online[0].account_id, idOf(t, "Trinity"));
    assert.equal(online[0].name, "Trinity-ingame");
    const stored = storedText(t);
    assert.ok(!stored.includes(stranger) && !stored.includes("Ghost-Visitor-77"), "nothing of the stranger is stored");
    const logs = t.logs.join("\n");
    assert.ok(!logs.includes(stranger) && !logs.includes("Ghost-Visitor-77"), "nothing of the stranger is logged");
    const now = await get(t, "/api/presence/now");
    assert.equal(now.status, 200);
    assert.equal(now.json.players, 1);
    assert.equal(now.json.servers[0].server.name, "HAVOC 9");
    assert.equal(now.json.servers[0].map, "h9_te_neuropolis");
    assert.equal(now.json.servers[0].mode, "Team Elimination");
    assert.deepEqual(now.json.servers[0].players.map((x) => [x.username, x.verified]), [["Trinity", true]]);
    assert.match(now.headers["cache-control"], /^public, max-age=\d+$/);
  });

  test("a wrong key, no signature, a changed body, an unlisted server or one without a key: refused", async () => {
    t.advance(1);
    const players = [as(t, "Neo", A)];
    const before = storedText(t);
    let r = await send(t, { players, key: randomHex(32) });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "bad_signature");
    r = await send(t, { players, signature: null });
    assert.equal(r.json.error, "bad_signature");
    r = await send(t, { players, signature: "zz" });
    assert.equal(r.json.error, "bad_signature");
    const signed = JSON.stringify({ v: 1, server: A, ts: t.sec(), map: "h9_te_neuropolis", players: [] });
    r = await send(t, { body: signed.replace("[]", JSON.stringify(players)), signature: hmac(KEYS[A], signed).toString("hex") });
    assert.equal(r.status, 401, "a body changed after signing");
    r = await send(t, { server: "192.0.2.77:27015", players, key: KEYS[A] });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "unknown_server");
    r = await send(t, { server: D, players, key: KEYS[A] });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "no_key");
    r = await send(t, { server: "havoc9.org:27015", players });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_server");
    const other = JSON.stringify({ v: 1, server: B, ts: t.sec(), players: [] });
    r = await send(t, { server: A, body: other, key: KEYS[A] });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "server_mismatch");
    r = await send(t, { players, contentType: "text/plain" });
    assert.equal(r.status, 415);
    r = await send(t, { body: JSON.stringify({ v: 1, server: A, ts: t.sec(), players: [], pad: "x".repeat(20000) }) });
    assert.equal(r.status, 413);
    r = await send(t, { players: [{ id: "not-an-id", name: "x" }] });
    assert.equal(r.status, 400, "a malformed player refuses the report");
    r = await send(t, { players: [{ ...as(t, "Neo", A), proof: "ab" }] });
    assert.equal(r.status, 400, "a malformed proof refuses the report");
    r = await send(t, { body: JSON.stringify({ v: 2, server: A, ts: t.sec(), players: [] }) });
    assert.equal(r.json.error, "bad_version");
    assert.equal(storedText(t), before, "no refused report changed anything");
    assert.ok(t.logs.some((l) => l.includes("presence.report_refused") && l.includes("reason=bad_signature")));
  });

  test("a stale or future timestamp, a replayed report and an out-of-order one: refused", async () => {
    const players = [as(t, "Neo", B)];
    let r = await send(t, { server: B, players, ts: t.sec() - 121 });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "stale");
    r = await send(t, { server: B, players, ts: t.sec() + 121 });
    assert.equal(r.json.error, "stale");
    const ts = t.sec();
    const body = JSON.stringify({ v: 1, server: B, ts, map: "h9_siege_neuropolis", mode: "Siege", players });
    await ok(t, { server: B, body });
    r = await send(t, { server: B, body });
    assert.equal(r.status, 409, "the same report again");
    assert.equal(r.json.error, "replay");
    r = await send(t, { server: B, players, ts: ts - 1 });
    assert.equal(r.status, 409, "an older report after a newer one");
    r = await send(t, { server: B, players: [], ts });
    assert.equal(r.status, 409, "another report with the same time");
    await ok(t, { server: B, players, ts: ts + 1 });
    assert.equal(t.app.db.prepare("SELECT last_ts FROM presence_servers WHERE server = ?").get(B).last_ts, ts + 1, "the guard is in the database, so it outlives a restart");
  });

  test("salted ids: each server sees its own; another server's id matches nobody; one IP shares it", async () => {
    await signup(t.base, "Cypher");
    const pid = pidOf(t, "Cypher");
    assert.notEqual(clientIdFor(pid, A), clientIdFor(pid, B));
    assert.equal(clientIdFor(pid, A), clientIdFor(pid, C), "the engine salts with the IP only, so A and C (one IP) see the same id");
    t.advance(2);
    await ok(t, { server: B, players: [{ ...entry(t, pid, B, { name: "Cypher" }), id: clientIdFor(pid, A) }] });
    assert.equal(onlineOf(t, "Cypher").length, 0, "A's id means nothing on B");
    t.advance(1);
    await ok(t, { server: B, players: [entry(t, pid, B, { name: "Cypher" })] });
    assert.equal(onlineOf(t, "Cypher").length, 1);
    t.advance(1);
    await ok(t, { server: C, players: [entry(t, pid, C, { name: "Cypher" })] });
    const card = await get(t, "/api/presence/account/Cypher");
    assert.equal(card.json.playing.server.address, B, "the unlisted server C never shows in public");
    assert.ok(!JSON.stringify(card.json).includes(C));
  });

  test("an id listed twice in one report is dropped both times", async () => {
    await signup(t.base, "Apoc");
    t.advance(1);
    const e = as(t, "Apoc", A);
    await ok(t, { players: [e, { ...e, name: "Impostor" }, as(t, "Trinity", A)] });
    assert.equal(onlineOf(t, "Apoc").length, 0);
    assert.ok(!storedText(t).includes("Impostor"));
  });
});

describe("presence: states, the privacy switches, the reads and the cache", () => {
  let t;
  let neo;
  before(async () => {
    t = await presenceApp();
    neo = await signup(t.base, "Neo");
    await signup(t.base, "Trinity");
    await signup(t.base, "Tank");
    await ok(t, { players: [as(t, "Neo", A), as(t, "Trinity", A, { device: DEV2 })] });
  });
  after(async () => {
    await t.close();
  });

  const privacy = (cookie, body, opts = {}) => request(t.base, "POST", "/api/presence/settings", { cookie, body, ...opts });
  const card = async (name) => (await get(t, "/api/presence/account/" + name)).json;

  test("by default everything shows: in game, the server, map, mode and minutes", async () => {
    const c = await get(t, "/api/presence/account/neo");
    assert.equal(c.status, 200);
    assert.equal(c.json.username, "Neo");
    assert.equal(c.json.state, "game");
    assert.equal(c.json.online, true);
    assert.equal(c.json.badge, true);
    assert.equal(c.json.playing.server.name, "HAVOC 9");
    assert.equal(c.json.playing.map, "h9_te_neuropolis");
    assert.equal(c.json.playing.mode, "Team Elimination");
    assert.equal(typeof c.json.playing.minutes, "number");
    assert.equal(c.json.playing.verified, true);
    assert.equal(c.json.playing.mapPicture, null, "no picture folder set: text only");
    assert.equal(c.json.lastSeen, null, "in game: no last seen");
    assert.ok(Array.isArray(c.json.servers));
    assert.ok(!("name" in c.json.playing), "the in-game name is the owner's only");
    assert.equal((await get(t, "/api/presence/account/nobody")).status, 404);
    const s = await get(t, "/api/presence/settings", { cookie: neo });
    assert.deepEqual(s.json.privacy, { game: true, where: true, web: true, site: true, playtime: true, lastSeen: true });
    assert.deepEqual(s.json.defaults, s.json.privacy);
  });

  test("game off: not in game to others, not in /now; a lower state that is true shows instead", async () => {
    const r = await privacy(neo, { game: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.privacy.game, false);
    assert.equal(r.json.privacy.where, true, "the others stay as they were");
    let c = await card("Neo");
    assert.equal(c.state, "site", "signed in a moment ago");
    assert.equal(c.playing, null);
    const batch = await get(t, "/api/presence/accounts?u=Neo,Trinity");
    assert.equal(batch.json.accounts.Neo.state, "site");
    assert.equal(batch.json.accounts.Trinity.state, "game");
    const now = (await get(t, "/api/presence/now")).json;
    assert.deepEqual(now.servers[0].players.map((p) => p.username), ["Trinity"]);
    assert.equal(now.players, 1);
    assert.ok(now.site.some((x) => x.username === "Neo"));
    assert.equal((await privacy(neo, { site: false })).status, 200);
    c = await card("Neo");
    assert.equal(c.state, "offline");
    assert.equal(c.lastSeen, null, "the open session never shows through last seen");
    const me = (await get(t, "/api/presence/me", { cookie: neo })).json;
    assert.equal(me.state, "game", "the owner sees it all");
    assert.equal(me.privacy.game, false);
    assert.equal(me.online.length, 1);
    assert.equal(me.online[0].name, "Neo-ingame");
    assert.equal(me.online[0].via, "game");
    assert.equal(me.online[0].state, "counted");
    assert.equal((await privacy(neo, { game: true, site: true })).status, 200);
    assert.equal((await card("Neo")).state, "game");
  });

  test("where off: in game, no server or map; /now lists the player apart", async () => {
    assert.equal((await privacy(neo, { where: false })).status, 200);
    const c = await card("Neo");
    assert.equal(c.state, "game");
    assert.deepEqual(Object.keys(c.playing).sort(), ["minutes", "since", "verified"]);
    assert.deepEqual(c.servers, [], "no per-server playtime either");
    const now = (await get(t, "/api/presence/now")).json;
    assert.deepEqual(now.elsewhere.map((x) => x.username), ["Neo"]);
    assert.ok(!now.servers.some((s) => s.players.some((p) => p.username === "Neo")));
    assert.equal(now.players, 2);
    assert.equal((await privacy(neo, { where: true })).status, 200);
  });

  test("playtime off: no playtime, badge or per-server list; last seen off: no time when offline", async () => {
    assert.equal((await privacy(neo, { playtime: false })).status, 200);
    let c = await card("Neo");
    assert.equal(c.playtimeSeconds, null);
    assert.equal(c.badge, false);
    assert.equal(c.firstSeen, null);
    assert.deepEqual(c.servers, []);
    assert.equal((await privacy(neo, { playtime: true })).status, 200);
    const tank = await login(t, "Tank");
    t.advance(400);
    c = await card("Tank");
    assert.equal(c.state, "offline");
    assert.ok(c.lastSeen, "last seen on the site");
    assert.equal((await privacy(tank, { lastSeen: false })).status, 200);
    t.advance(301);
    assert.equal((await card("Tank")).lastSeen, null);
  });

  test("the settings: signed in, from the site's own pages, known switches, true or false only", async () => {
    let r = await privacy(undefined, { game: false });
    assert.equal(r.status, 401);
    r = await privacy(neo, { game: false }, { origin: null });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "csrf");
    r = await privacy(neo, { game: false }, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
    for (const bad of [{ game: "no" }, { show: false }, {}, { game: true, nonsense: true }]) {
      assert.equal((await privacy(neo, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await get(t, "/api/presence/me")).status, 401);
    assert.equal((await get(t, "/api/presence/settings")).status, 401);
  });

  test("the batch read: one request for many names, unknown names null, a cap, cache headers", async () => {
    const r = await get(t, "/api/presence/accounts?u=Neo,trinity,nobody,NEO&u=Tank");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.accounts), ["Neo", "trinity", "nobody", "Tank"]);
    assert.equal(r.json.accounts.nobody, null);
    assert.equal(r.json.accounts.trinity.username, "Trinity");
    assert.equal(r.json.accounts.Tank.badge, false, "never seen in game");
    assert.equal(r.json.accounts.Tank.online, false);
    assert.ok(!("servers" in r.json.accounts.Neo), "the compact view has no per-server list");
    assert.match(r.headers["cache-control"], /^public, max-age=0$/);
    const many = Array.from({ length: 51 }, (_, i) => "user" + i).join(",");
    assert.equal((await get(t, "/api/presence/accounts?u=" + many)).json.error, "too_many");
    assert.equal((await get(t, "/api/presence/accounts")).status, 400);
    assert.equal((await get(t, "/api/presence/accounts?u=" + "x".repeat(65))).status, 400);
  });

  test("deleting an account deletes its presence", async () => {
    await signup(t.base, "Dozer");
    t.advance(1);
    const dozer = as(t, "Dozer", A, { device: DEV3 });
    await ok(t, { players: [dozer, as(t, "Neo", A), as(t, "Trinity", A, { device: DEV2 })] });
    const id = idOf(t, "Dozer");
    assert.ok(t.app.db.prepare("SELECT * FROM presence_playtime WHERE account_id = ?").get(id));
    assert.ok(t.app.db.prepare("SELECT * FROM presence_devices WHERE account_id = ?").get(id));
    t.app.accounts.remove(id);
    for (const table of ["presence_online", "presence_playtime", "presence_sessions", "presence_settings", "presence_devices", "presence_flags", "presence_nets"]) {
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM " + table + " WHERE account_id = ?").get(id).n, 0, table);
    }
    t.advance(1);
    await ok(t, { players: [{ id: dozer.id, name: "Dozer" }] });
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_online WHERE account_id = ?").get(id).n, 0, "its old id is just unknown now");
  });
});

describe("presence: playtime, sessions, away and the silent server", () => {
  let t;
  before(async () => {
    t = await presenceApp();
    for (const n of ["Trinity", "Morpheus", "Niobe"]) await signup(t.base, n);
  });
  after(async () => {
    await t.close();
  });

  test("playtime adds up across reports, gaps are capped, a player who left ends after rejoinSeconds", async () => {
    const t0 = t.sec();
    const me = (extra) => as(t, "Trinity", A, { name: "Trin", ...extra });
    await ok(t, { players: [me({ joined: t0 - 30, time: 30 })] });
    assert.equal(playtime(t, "Trinity"), 30, "the time in game before the first report counts, up to one gap");
    t.advance(60);
    await ok(t, { players: [me({ joined: t0 - 30, time: 90 })] });
    t.advance(60);
    await ok(t, { players: [me({ joined: t0 - 30, time: 150 })] });
    assert.equal(playtime(t, "Trinity"), 150);
    t.advance(30);
    await ok(t, { players: [] });
    assert.equal(playtime(t, "Trinity"), 180, "the time up to the report that missed her");
    assert.equal(onlineOf(t, "Trinity")[0].away_at, t0 + 150, "away, not ended: a map change looks the same");
    assert.equal((await get(t, "/api/presence/account/Trinity")).json.online, false, "away is not in game");
    t.advance(121);
    t.p.sweep();
    const s = rows(t, "presence_sessions");
    assert.equal(s.length, 1);
    assert.equal(s[0].started_at, t0 - 30);
    assert.equal(s[0].ended_at, t0 + 150, "ended when she went");
    assert.equal(s[0].seconds, 180);
    assert.equal(s[0].name, "Trin");
    assert.equal(onlineOf(t, "Trinity").length, 0);
    t.advance(729);
    await ok(t, { players: [me({ joined: t.sec() - 10, time: 10 })] });
    assert.equal(playtime(t, "Trinity"), 190, "a new session");
    t.advance(170);
    await ok(t, { players: [me({ time: 180 })] });
    assert.equal(playtime(t, "Trinity"), 340, "a gap of 170 s counts maxCreditSeconds (150)");
    const card = await get(t, "/api/presence/account/Trinity");
    assert.equal(card.json.playtimeSeconds, 340);
    assert.equal(card.json.lastSeen, null, "in game: no last seen in public");
    assert.equal(card.json.servers[0].seconds, 340);
    const own = await get(t, "/api/presence/me", { cookie: await login(t, "Trinity") });
    assert.equal(own.json.lastSeen, new Date(t.sec() * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
    assert.equal(own.json.sessions.length, 1);
    assert.equal(own.json.sessions[0].seconds, 180);
    assert.equal(own.json.sessions[0].via, "game");
    t.advance(1);
    await ok(t, { players: [] });
  });

  test("a map change: missing from one report and back within rejoinSeconds, the session goes on", async () => {
    const t0 = t.sec();
    await ok(t, { server: B, players: [as(t, "Niobe", B, { joined: t0, time: 0 })] });
    t.advance(60);
    await ok(t, { server: B, players: [as(t, "Niobe", B, { joined: t0, time: 60 })] });
    t.advance(5);
    await ok(t, { server: B, players: [], map: "h9_siege_lift", mode: "Siege" });
    t.advance(20);
    await ok(t, { server: B, players: [as(t, "Niobe", B, { joined: t.sec(), time: 0 })], map: "h9_siege_lift", mode: "Siege" });
    const row = onlineOf(t, "Niobe")[0];
    assert.equal(row.since, t0, "the same session");
    assert.equal(row.away_at, null);
    t.advance(60);
    await ok(t, { server: B, players: [as(t, "Niobe", B, { time: 60 })], map: "h9_siege_lift", mode: "Siege" });
    assert.equal(playtime(t, "Niobe"), 125, "60 + 5 + 60: the 20 s of loading are not counted");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_sessions WHERE account_id = ?").get(idOf(t, "Niobe")).n, 0);
    const card = await get(t, "/api/presence/account/Niobe");
    assert.equal(card.json.playing.map, "h9_siege_lift");
    t.advance(1);
    await ok(t, { server: B, players: [], map: "h9_siege_lift", mode: "Siege" });
  });

  test("a server that goes silent: its sessions end after the timeout, at its last report", async () => {
    t.advance(200);
    t.p.sweep();
    const before = playtime(t, "Morpheus");
    const t0 = t.sec();
    await ok(t, { server: B, players: [as(t, "Morpheus", B, { joined: t0, time: 0 })] });
    t.advance(179);
    t.p.sweep();
    assert.equal(onlineOf(t, "Morpheus").length, 1, "179 s: still in game");
    t.advance(2);
    t.p.sweep();
    assert.equal(onlineOf(t, "Morpheus").length, 0);
    const s = t.app.db.prepare("SELECT * FROM presence_sessions WHERE account_id = ?").get(idOf(t, "Morpheus"));
    assert.equal(s.ended_at, t0, "ended at the last report, not at the sweep");
    assert.equal(playtime(t, "Morpheus"), before, "the silence is not counted");
    assert.equal((await get(t, "/api/presence/now")).json.players, 0);
    assert.equal((await get(t, "/api/presence/account/Morpheus")).json.online, false);
  });

  test("a server taken off servers.json: its sessions end at the next sweep", async () => {
    t.advance(5);
    await ok(t, { server: B, players: [as(t, "Niobe", B)] });
    assert.equal(onlineOf(t, "Niobe").length, 1);
    fs.writeFileSync(t.serversFile, JSON.stringify({ servers: SERVERS.filter((x) => x.address !== B) }));
    t.app.servers.load();
    t.p.sweep();
    assert.equal(onlineOf(t, "Niobe").length, 0);
    t.advance(1);
    assert.equal((await send(t, { server: B, players: [] })).json.error, "unknown_server");
    fs.writeFileSync(t.serversFile, JSON.stringify({ servers: SERVERS }));
    t.app.servers.load();
  });
});

describe("presence: the proof of the player id", () => {
  let t;
  before(async () => {
    t = await presenceApp();
    for (const n of ["Neo", "Trinity", "Switch"]) await signup(t.base, n);
  });
  after(async () => {
    await t.close();
  });

  test("no proof (an old client, or a copied h9_clientid): shown as unverified, counted for nothing", async () => {
    await ok(t, { players: [as(t, "Switch", A, { proof: false })] });
    const card = (await get(t, "/api/presence/account/Switch")).json;
    assert.equal(card.online, true);
    assert.equal(card.playing.verified, false);
    assert.equal(card.badge, false);
    assert.equal(card.playtimeSeconds, 0);
    assert.equal((await get(t, "/api/presence/now")).json.servers[0].players[0].verified, false);
    t.advance(60);
    await ok(t, { players: [as(t, "Switch", A, { proof: false })] });
    assert.equal(playtime(t, "Switch"), 0);
    t.advance(1);
    await ok(t, { players: [] });
    t.advance(200);
    t.p.sweep();
    assert.equal(onlineOf(t, "Switch").length, 0);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_sessions WHERE account_id = ?").get(idOf(t, "Switch")).n, 0, "no trace");
    assert.equal(rows(t, "presence_devices").length, 0);
  });

  test("a forged proof, or one made for another server: refused and flagged, never shown", async () => {
    t.advance(1);
    const forged = { ...as(t, "Neo", A, { proof: false }), ...makeProof(randomHex(16), A, DEV1, nonceAt(t.sec())), net: NET1 };
    await ok(t, { players: [forged] });
    assert.equal(onlineOf(t, "Neo").length, 0);
    let f = flagsOf(t, "Neo");
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "bad_proof");
    assert.equal(f[0].server, A);
    t.advance(1);
    await ok(t, { players: [as(t, "Neo", A, { proofServer: B })] });
    assert.equal(onlineOf(t, "Neo").length, 0, "a proof bound to B means nothing on A");
    f = flagsOf(t, "Neo");
    assert.equal(f.length, 1, "the same open flag");
    assert.equal(f[0].count, 2);
    assert.equal(rows(t, "presence_devices").length, 0, "a refused proof binds no device");
  });

  test("a proof that answers an old nonce is refused as stale", async () => {
    t.advance(1);
    await ok(t, { players: [as(t, "Trinity", A, { nonce: nonceAt(t.sec() - 90000) })] });
    assert.equal(onlineOf(t, "Trinity").length, 0);
    assert.equal(flagsOf(t, "Trinity")[0].kind, "stale_proof");
    t.advance(1);
    await ok(t, { players: [as(t, "Trinity", A)] });
    assert.equal(onlineOf(t, "Trinity")[0].proven, 1, "a fresh one is fine");
  });

  test("a copied h9_clientid beside the real, proven player: never shown, and flagged", async () => {
    t.advance(1);
    await ok(t, { server: B, players: [as(t, "Trinity", B, { proof: false })] });
    const card = (await get(t, "/api/presence/account/Trinity")).json;
    assert.equal(card.playing.server.address, A);
    assert.equal(card.playing.verified, true);
    const now = (await get(t, "/api/presence/now")).json;
    assert.deepEqual(now.servers.map((s) => s.server.address), [A], "the copy on B is not listed");
    const f = flagsOf(t, "Trinity").find((x) => x.kind === "concurrent");
    assert.ok(f, "flagged");
    assert.equal(f.other_server, B);
  });

  test("requireProof: an unproven sighting is dropped entirely", async () => {
    const u = await presenceApp({ settings: { requireProof: true } });
    try {
      await signup(u.base, "Ghost");
      await ok(u, { players: [as(u, "Ghost", A, { proof: false })] });
      assert.equal(onlineOf(u, "Ghost").length, 0);
      u.advance(1);
      await ok(u, { players: [as(u, "Ghost", A)] });
      assert.equal(onlineOf(u, "Ghost").length, 1);
    } finally {
      await u.close();
    }
  });

  test("without core's verifyIdProof a proof cannot be checked: the sighting is unverified", async () => {
    const u = await presenceApp({ hooks: { verifyIdProof: null } });
    try {
      await signup(u.base, "Kid");
      await ok(u, { players: [as(u, "Kid", A)] });
      assert.equal(onlineOf(u, "Kid")[0].proven, 0);
      assert.equal(playtime(u, "Kid"), 0);
      assert.ok(u.logs.some((l) => l.includes("presence.core_hook_missing") && l.includes("verifyIdProof")));
    } finally {
      await u.close();
    }
  });
});

describe("presence: devices, concurrency and the admin panel's hooks", () => {
  let t;
  let admin;
  let user;
  before(async () => {
    t = await presenceApp();
    admin = await adminCookie(t);
    user = await signup(t.base, "Mouse");
    for (const n of ["Neo", "Trinity", "Switch", "Ghost"]) await signup(t.base, n);
  });
  after(async () => {
    await t.close();
  });

  const post = (p, body, cookie = admin) => request(t.base, "POST", "/api/presence/admin" + p, { cookie, body: body === undefined ? {} : body });
  const audit = (action) => t.app.db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action);

  test("the first device binds; a second one is refused and flagged, with its network known or not", async () => {
    await ok(t, { players: [as(t, "Neo", A, { device: DEV1, net: NET1 })] });
    let view = (await get(t, "/api/presence/admin/accounts/Neo", { cookie: admin })).json;
    assert.deepEqual(view.devices.map((d) => [d.device, d.status]), [[deviceHash(DEV1), "bound"]]);
    t.advance(60);
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2, net: NET2 })] });
    assert.deepEqual(onlineOf(t, "Neo").map((r) => r.server), [A], "nothing from the second device");
    const f = flagsOf(t, "Neo").find((x) => x.kind === "second_device");
    assert.equal(f.device, deviceHash(DEV2));
    assert.equal(f.net_known, 0, "from a network the account has not used");
    t.advance(1);
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2, net: NET1 })] });
    const again = flagsOf(t, "Neo").find((x) => x.kind === "second_device");
    assert.equal(again.count, 2);
    assert.equal(again.net_known, 1, "now from the account's usual network");
    view = (await get(t, "/api/presence/admin/accounts/Neo", { cookie: admin })).json;
    assert.equal(view.flags[0].kind, "second_device");
    assert.equal(view.flags[0].networkKnown, true);
    assert.ok(!JSON.stringify(view).includes(NET1) && !storedText(t).includes(NET1), "networks are kept as keyed hashes only");
  });

  test("allow an extra device: it counts from then on and its flag closes; unbind takes one away", async () => {
    let r = await post("/accounts/Neo/devices/" + deviceHash(DEV2) + "/allow", { note: "his laptop" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.devices.map((d) => d.status).sort(), ["allowed", "bound"]);
    assert.equal(flagsOf(t, "Neo").find((x) => x.kind === "second_device").status, "resolved");
    assert.equal(audit("presence.device.allow").length, 1);
    // Neo leaves A, then plays from the laptop on B
    t.advance(1);
    await ok(t, { players: [] });
    t.advance(200);
    t.p.sweep();
    t.advance(1);
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2 })] });
    assert.equal(onlineOf(t, "Neo")[0].proven, 1);
    r = await post("/accounts/Neo/devices/" + deviceHash(DEV1) + "/unbind", { note: "sold the PC" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.devices.map((d) => d.device), [deviceHash(DEV2)]);
    assert.equal(audit("presence.device.unbind").length, 1);
    t.advance(1);
    await ok(t, { players: [as(t, "Neo", A, { device: DEV1 })] });
    assert.ok(flagsOf(t, "Neo").some((x) => x.kind === "second_device" && x.status === "open" && x.device === deviceHash(DEV1)), "the unbound PC is a second device now");
    assert.equal((await post("/accounts/Neo/devices/" + randomHex(16) + "/unbind")).status, 404);
  });

  test("in two places at once: only the first counts, the other is held and flagged, then promoted", async () => {
    t.advance(1);
    await ok(t, { players: [as(t, "Trinity", A, { device: DEV3 })] });
    const countedAt = t.sec();
    t.advance(1);
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2 }), as(t, "Trinity", B, { device: DEV3 })] });
    let r = onlineOf(t, "Trinity");
    assert.deepEqual(r.map((x) => [x.server, x.held]), [[A, 0], [B, 1]]);
    const before = playtime(t, "Trinity");
    t.advance(60);
    await ok(t, { players: [as(t, "Trinity", A, { device: DEV3 })] });
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2 }), as(t, "Trinity", B, { device: DEV3 })] });
    assert.equal(playtime(t, "Trinity"), before + (t.sec() - countedAt), "only A's time; the held one on B adds nothing");
    assert.equal((await get(t, "/api/presence/account/Trinity")).json.playing.server.address, A);
    assert.equal(flagsOf(t, "Trinity").find((x) => x.kind === "concurrent").other_server, B);
    // she leaves A: once the away time is over, B is promoted and counts from then
    t.advance(1);
    await ok(t, { players: [] });
    t.advance(121);
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2 }), as(t, "Trinity", B, { device: DEV3 })] });
    t.p.sweep();
    r = onlineOf(t, "Trinity");
    assert.deepEqual(r.map((x) => [x.server, x.held]), [[B, 0]]);
    const promoted = playtime(t, "Trinity");
    t.advance(30);
    await ok(t, { server: B, players: [as(t, "Neo", B, { device: DEV2 }), as(t, "Trinity", B, { device: DEV3 })] });
    assert.equal(playtime(t, "Trinity"), promoted + 30);
  });

  test("the relay's session beside a plugin one on another server is held too", async () => {
    t.advance(1);
    t.app.events.emit("relay-game-start", { accountId: idOf(t, "Neo"), server: A });
    const r = onlineOf(t, "Neo");
    assert.deepEqual(r.map((x) => [x.server, x.held]), [[B, 0], [A, 1]]);
    t.app.events.emit("relay-game-end", { accountId: idOf(t, "Neo"), server: A });
    assert.deepEqual(onlineOf(t, "Neo").map((x) => x.server), [B]);
  });

  test("flags: listed for admins only, and resolved with a note into the audit log", async () => {
    assert.equal((await get(t, "/api/presence/admin/flags")).status, 401);
    assert.equal((await get(t, "/api/presence/admin/flags", { cookie: user })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/presence/admin/flags/1/resolve", { cookie: admin, body: {}, origin: null })).status, 403, "the admin's POSTs pass the CSRF check");
    const list = (await get(t, "/api/presence/admin/flags", { cookie: admin })).json;
    assert.ok(list.total >= 2);
    assert.ok(list.flags.every((f) => f.status === "open"));
    const one = list.flags.find((f) => f.kind === "concurrent");
    let r = await post("/flags/" + one.id + "/resolve", { note: "two PCs at a LAN" });
    assert.equal(r.status, 200);
    r = await post("/flags/" + one.id + "/resolve", {});
    assert.equal(r.status, 409);
    assert.equal(audit("presence.flag.resolve")[0].detail, "two PCs at a LAN");
    assert.equal((await get(t, "/api/presence/admin/flags?status=resolved", { cookie: admin })).json.flags.some((f) => f.id === one.id), true);
  });

  test("move an id (the admin's password first): its history and devices go to the other account, and its h9_clientid", async () => {
    // Switch gets a history first: two reports and a finished session
    t.advance(1);
    await ok(t, { players: [as(t, "Switch", A, { device: DEV1 })] });
    t.advance(60);
    await ok(t, { players: [as(t, "Switch", A, { device: DEV1 })] });
    t.advance(1);
    await ok(t, { players: [] });
    t.advance(200);
    t.p.sweep();
    const seconds = playtime(t, "Switch");
    assert.ok(seconds > 0);
    const oldPid = pidOf(t, "Switch");
    let r = await post("/accounts/Switch/move-id", { to: "Ghost", confirm: "nope" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "confirm");
    r = await post("/accounts/Switch/move-id", { to: "Ghost", confirm: "switch" });
    assert.equal(r.json.error, "password_required", "the admin's own password, every time");
    r = await post("/accounts/Switch/move-id", { to: "Ghost", confirm: "switch", password: "not the password at all" });
    assert.equal(r.json.error, "bad_password");
    assert.equal(pidOf(t, "Switch"), oldPid, "nothing moved");
    r = await post("/accounts/Switch/move-id", { to: "Ghost", confirm: "switch", password: PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(pidOf(t, "Ghost"), oldPid, "Ghost holds the id now");
    assert.notEqual(pidOf(t, "Switch"), oldPid, "Switch has a new one");
    assert.equal(playtime(t, "Ghost"), seconds);
    assert.equal(playtime(t, "Switch"), 0);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_sessions WHERE account_id = ?").get(idOf(t, "Ghost")).n, 1);
    const view = (await get(t, "/api/presence/admin/accounts/Ghost", { cookie: admin })).json;
    assert.deepEqual(view.devices.map((d) => d.device), [deviceHash(DEV1)]);
    // the same install, the same user_id.ini: it is Ghost now
    t.advance(1);
    await ok(t, { players: [entry(t, oldPid, A, { device: DEV1, name: "same-install" })] });
    assert.equal(onlineOf(t, "Ghost").length, 1);
    assert.equal(onlineOf(t, "Switch").length, 0);
    assert.equal(audit("presence.id.move")[0].target_name, "Switch");
  });

  test("reset an id: the old one dies at once; the device stays bound unless told otherwise", async () => {
    const oldPid = pidOf(t, "Ghost");
    let r = await post("/accounts/Ghost/reset-id", { confirm: "Ghost" });
    assert.equal(r.status, 400, "no password");
    assert.equal(pidOf(t, "Ghost"), oldPid);
    r = await post("/accounts/Ghost/reset-id", { confirm: "Ghost", password: PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.keepDevices, true);
    assert.equal(onlineOf(t, "Ghost").length, 0, "its open session ended");
    t.advance(1);
    await ok(t, { players: [entry(t, oldPid, A, { device: DEV1 })] });
    assert.equal(rows(t, "presence_online").filter((x) => x.server === A).length, 0, "the leaked id matches nobody");
    t.advance(1);
    await ok(t, { players: [as(t, "Ghost", A, { device: DEV1 })] });
    assert.equal(onlineOf(t, "Ghost")[0].proven, 1, "the new id from the bound device");
    r = await post("/accounts/Ghost/reset-id", { confirm: "Ghost", keepDevices: false, password: PASSWORD });
    assert.equal(r.status, 200);
    assert.equal((await get(t, "/api/presence/admin/accounts/Ghost", { cookie: admin })).json.devices.length, 0);
    assert.equal(audit("presence.id.reset").length, 2);
    assert.equal((await post("/accounts/Ghost/reset-id", { confirm: "Ghost", password: PASSWORD }, user)).status, 403);
  });

  test("without the core hooks, move-id and reset-id answer 503", async () => {
    const u = await presenceApp({ hooks: { movePlayerId: null, resetPlayerId: null } });
    try {
      const c = await adminCookie(u, "Root2");
      await signup(u.base, "Bob");
      const r = await request(u.base, "POST", "/api/presence/admin/accounts/Bob/reset-id", { cookie: c, body: { confirm: "Bob" } });
      assert.equal(r.status, 503);
      const m = await request(u.base, "POST", "/api/presence/admin/accounts/Bob/move-id", { cookie: c, body: { confirm: "Bob", to: "Root2" } });
      assert.equal(m.status, 503);
    } finally {
      await u.close();
    }
  });
});

describe("presence: the web client's menu and the site", () => {
  let t;
  let tank;
  before(async () => {
    t = await presenceApp();
    tank = await signup(t.base, "Tank");
    await signup(t.base, "Dozer");
    t.advance(400);
  });
  after(async () => {
    await t.close();
  });

  const card = async (name) => (await get(t, "/api/presence/account/" + name)).json;

  test("on the site: a signed-in request within siteActiveSeconds, else offline with that time", async () => {
    assert.equal((await card("Tank")).state, "offline");
    t.activity.touch(idOf(t, "Tank"), t.sec() - 10);
    let c = await card("Tank");
    assert.equal(c.state, "site");
    assert.equal(c.lastSeen, null);
    const now = (await get(t, "/api/presence/now")).json;
    assert.deepEqual(now.site.map((x) => x.username), ["Tank"]);
    t.advance(300);
    c = await card("Tank");
    assert.equal(c.state, "offline");
    assert.equal(c.lastSeen, new Date((t.sec() - 310) * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
    assert.equal((await get(t, "/api/presence/now")).json.site.length, 0);
  });

  test("in the web client's menu: a relay socket open on no listed server; in game once it plays", async () => {
    const id = idOf(t, "Dozer");
    t.app.events.emit("relay-open", { accountId: id });
    assert.equal((await card("Dozer")).state, "web");
    assert.deepEqual((await get(t, "/api/presence/now")).json.web.map((x) => x.username), ["Dozer"]);
    t.app.events.emit("relay-game-start", { accountId: id, server: A });
    let c = await card("Dozer");
    assert.equal(c.state, "game");
    assert.equal(c.playing.server.address, A);
    t.advance(60);
    t.app.events.emit("relay-game-end", { accountId: id, server: A });
    assert.equal((await card("Dozer")).state, "web", "back in the menu");
    t.advance(5);
    t.app.events.emit("relay-close", { accountId: id });
    c = await card("Dozer");
    assert.equal(c.state, "offline");
    assert.equal(c.lastSeen, new Date(t.sec() * 1000).toISOString().replace(/\.\d+Z$/, "Z"), "when the web client closed");
  });

  test("web off: the menu never shows, not even through last seen", async () => {
    const id = idOf(t, "Tank");
    assert.equal((await request(t.base, "POST", "/api/presence/settings", { cookie: tank, body: { web: false, site: false } })).status, 200);
    t.activity.forget(id);
    t.advance(600);
    const before = (await card("Tank")).lastSeen;
    t.app.events.emit("relay-open", { accountId: id });
    const c = await card("Tank");
    assert.equal(c.state, "offline");
    assert.equal(c.lastSeen, before);
    assert.equal((await get(t, "/api/presence/me", { cookie: tank })).json.state, "web", "the owner sees it");
    t.app.events.emit("relay-close", { accountId: id });
  });
});

describe("presence: names in game", () => {
  let t;
  before(async () => {
    t = await presenceApp();
    for (const n of ["Neo", "Trinity", "Mouse", "Seraph"]) await signup(t.base, n);
  });
  after(async () => {
    await t.close();
  });

  const named = async (players, extra = {}) => {
    t.advance(1);
    const body = JSON.stringify({ v: 1, server: A, ts: t.sec(), map: "h9_te_neuropolis", mode: "Team Elimination", names: true, players, ...extra });
    return (await ok(t, { body })).json;
  };

  test("a verified account is told its username; a registered name on anyone else is taken", async () => {
    const r = await named([
      { ...as(t, "Neo", A), slot: 3, name: "xX_n30_Xx" },
      { ...as(t, "Trinity", A, { proof: false }), slot: 4, name: "Trinity" },
      { id: randomHex(16), slot: 5, name: "NE0" },
      { slot: 6, name: "trinity" },
      { slot: 7, name: "Player 4821" },
      { slot: 8, name: "[H9] Neo" },
      { slot: 9, name: "M o u s e" },
    ]);
    assert.deepEqual(r.names, { 3: { set: "Neo" }, 4: { taken: true }, 5: { taken: true }, 6: { taken: true } });
    assert.ok(!storedText(t).includes("Player 4821") && !t.logs.join("\n").includes("Player 4821"), "names alone are never stored or logged");
  });

  test("the name follows a rename on the site, and the old name stays protected while it is held", async () => {
    const id = idOf(t, "Neo");
    t.app.db.prepare("UPDATE accounts SET username = 'TheOne', username_key = 'theone', username_skeleton = 'theone' WHERE id = ?").run(id);
    t.app.db.prepare("INSERT INTO username_holds (account_id, username, username_key, username_skeleton, created_at, held_until) VALUES (?, 'Neo', 'neo', 'neo', ?, ?)")
      .run(id, t.sec(), t.sec() + 30 * 86400);
    const r = await named([{ ...as(t, "TheOne", A), slot: 3, name: "Neo" }, { slot: 4, name: "neo" }]);
    assert.deepEqual(r.names, { 3: { set: "TheOne" }, 4: { taken: true } });
  });

  test("the relay vouches for a web client player; a refused second device is not vouched for", async () => {
    t.app.events.emit("relay-game-start", { accountId: idOf(t, "Mouse"), server: A });
    let r = await named([{ ...as(t, "Mouse", A, { proof: false }), slot: 2, name: "mouse" }]);
    assert.deepEqual(r.names, { 2: { set: "Mouse" } });
    t.app.events.emit("relay-game-end", { accountId: idOf(t, "Mouse"), server: A });
    await named([{ ...as(t, "Seraph", A, { device: DEV1 }), slot: 2, name: "Seraph" }]);
    r = await named([{ ...as(t, "Seraph", A, { device: DEV2 }), slot: 2, name: "Seraph" }]);
    assert.deepEqual(r.names, { 2: { taken: true } }, "the second device keeps no claim on the name");
  });

  test("no names unless asked; and none at all without core's verifyIdProof", async () => {
    t.advance(1);
    let r = (await ok(t, { players: [{ ...as(t, "Trinity", A), slot: 4 }] })).json;
    assert.equal(r.names, undefined);
    const u = await presenceApp({ hooks: { verifyIdProof: null } });
    try {
      await signup(u.base, "Kid");
      const body = JSON.stringify({ v: 1, server: A, ts: u.sec(), names: true, players: [{ ...as(u, "Kid", A), slot: 1 }] });
      r = (await ok(u, { body })).json;
      assert.equal(r.names, undefined);
    } finally {
      await u.close();
    }
    r = await send(t, { body: JSON.stringify({ v: 1, server: A, ts: t.sec() + 1, names: true, players: [{ slot: 0, name: "x" }] }) });
    assert.equal(r.status, 400, "a slot is 1 to 255");
  });
});

describe("presence: web client players through the relay's events", () => {
  let t;
  let game;
  let siege;
  before(async () => {
    game = await fakeGameServer({ name: "Siege box", map: "h9_siege_neuropolis", mode: "Siege 2/5" });
    siege = "198.51.100.40:27015";
    const servers = SERVERS.concat([{ name: "Siege box", address: siege, target: "127.0.0.1:" + game.address().port }]);
    t = await presenceApp({ servers });
    for (const n of ["Switch", "Mouse"]) await signup(t.base, n);
  });
  after(async () => {
    await t.close();
    game.close();
  });

  test("relay-game-start and -end: a verified session, counted by the sweep, with no plugin at all", async () => {
    t.app.events.emit("relay-game-start", { accountId: idOf(t, "Switch"), server: A });
    let card = (await get(t, "/api/presence/account/Switch")).json;
    assert.equal(card.online, true);
    assert.equal(card.playing.server.address, A);
    assert.equal(card.playing.verified, true, "the relay knows the signed-in account");
    t.advance(30);
    t.p.sweep();
    t.advance(20);
    t.app.events.emit("relay-game-end", { accountId: idOf(t, "Switch"), server: A });
    card = (await get(t, "/api/presence/account/Switch")).json;
    assert.equal(card.online, false);
    assert.equal(card.playtimeSeconds, 50);
    assert.equal(t.app.db.prepare("SELECT * FROM presence_sessions WHERE account_id = ?").get(idOf(t, "Switch")).seen_by, 2, "via the web client");
    t.app.events.emit("relay-game-start", { accountId: idOf(t, "Switch"), server: "192.0.2.99:27015" });
    t.app.events.emit("relay-game-start", { accountId: 999999, server: A });
    assert.equal(rows(t, "presence_online").length, 0, "an unlisted server or an unknown account is ignored");
  });

  test("both sources on one server: one session, counted once, ending when both have let go", async () => {
    const id = idOf(t, "Mouse");
    t.app.events.emit("relay-game-start", { accountId: id, server: A });
    t.advance(10);
    await ok(t, { players: [as(t, "Mouse", A, { proof: false })] });
    let row = onlineOf(t, "Mouse")[0];
    assert.equal(row.seen_by, 3);
    t.advance(10);
    t.p.sweep();
    t.advance(10);
    await ok(t, { players: [] });
    row = onlineOf(t, "Mouse")[0];
    assert.ok(row, "the relay still has it");
    assert.equal(row.plugin_at, null);
    t.advance(10);
    t.app.events.emit("relay-game-end", { accountId: id, server: A });
    assert.equal(onlineOf(t, "Mouse").length, 0);
    const s = t.app.db.prepare("SELECT * FROM presence_sessions WHERE account_id = ?").get(id);
    assert.equal(s.seconds, 40, "40 s of wall time, whichever source counted it");
    assert.equal(s.seen_by, 3);
  });

  test("a server without the plugin is named from its status answer, the way the card names it", async () => {
    await until(() => t.app.status.snapshot().servers.some((x) => x.address === siege), 5000);
    t.app.events.emit("relay-game-start", { accountId: idOf(t, "Switch"), server: siege });
    const now = (await get(t, "/api/presence/now")).json;
    const entryOn = now.servers.find((x) => x.server.address === siege);
    assert.equal(entryOn.map, "h9_siege_neuropolis");
    assert.equal(entryOn.mode, "Siege");
    assert.equal(entryOn.server.name, "Siege box");
    t.app.events.emit("relay-game-end", { accountId: idOf(t, "Switch"), server: siege });
  });

  test("after a restart the relay's old rows are over", async () => {
    t.app.events.emit("relay-game-start", { accountId: idOf(t, "Switch"), server: A });
    t.p.stop();
    t.p.start();
    assert.equal(rows(t, "presence_online").length, 0);
  });
});

describe("presence: map pictures and mode names", () => {
  test("the modes, as the engine's Discord card names them (H9P_Mode)", () => {
    assert.equal(modeFor("h9_te_neuropolis", "match"), "Team Elimination", "the map's name before match");
    assert.equal(modeFor("h9_siege_lift", "siege", "2/5"), "Siege");
    assert.equal(modeFor("h9_te_neuropolis", "", "1/3"), "Siege", "siege progress wins");
    assert.equal(modeFor("h9_up_drainage", "uplink"), "Capture the Uplink");
    assert.equal(modeFor("h9_ws_lift", ""), "Wave Survival");
    assert.equal(modeFor("h9_mw_drainage", ""), "Mech Warrior");
    assert.equal(modeFor("anything", "mechwarrior"), "Mech Warrior");
    assert.equal(modeFor("h9_tsrp_newbyzantium", ""), "Roleplay");
    assert.equal(modeFor("rp_city", ""), "Roleplay");
    assert.equal(modeFor("tsrp_hive", ""), "Roleplay");
    assert.equal(modeFor("alexandria_msr_b5", "match"), "Match Mode");
    assert.equal(modeFor("ts_blitz", ""), "Deathmatch");
    assert.equal(modeFor("xenoncity_final", ""), "Deathmatch");
    assert.equal(modeFor("H9_TE_Meridian", ""), "Team Elimination");
    assert.equal(keyFromDescription("Match Mode"), "match");
    assert.equal(keyFromDescription("Siege 2/5"), "siege");
    assert.equal(keyFromDescription("Capture the Uplink"), "uplink");
    assert.equal(keyFromDescription("The Specialists"), "");
    assert.equal(cleanMap("../etc/passwd"), null);
    assert.equal(cleanMap("H9_TE_Neuropolis"), "h9_te_neuropolis");
    assert.equal(cleanText("a\u0000b\n  c", 64), "a b c");
    assert.equal(cleanText("x".repeat(70), 64).length, 64);
  });

  test("the id proof's test vectors in docs/H9_PRESENCE.txt", () => {
    const pid = "0123456789abcdef0123456789abcdef";
    const p = makeProof(pid, "203.0.113.10:27015", "fedcba9876543210fedcba9876543210", "6724a2c000112233445566778899aabb");
    assert.equal(p.devmask, "3da5e554be8c05d6e3c265025e73fa45");
    assert.equal(p.proof, "cc3fd059d636b90d80456c1692ac059047bd208076deffdf336a3a4bf1db6af4");
    assert.equal(clientIdFor(pid, "203.0.113.10:27015"), "6f25203910203f1f3c7e4f98e15fe7ae");
    assert.equal(deviceHash("fedcba9876543210fedcba9876543210"), "9dca7efc8a5cfe1677a2df1cf4731c6f");
  });

  test("a picture URL only for a map that has a picture", async () => {
    const pics = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-maps-"));
    fs.writeFileSync(path.join(pics, "h9_te_neuropolis.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const t = await presenceApp({ settings: { mapPicturesDir: pics } });
    try {
      await signup(t.base, "Ghost");
      await ok(t, { players: [as(t, "Ghost", A)] });
      let card = await get(t, "/api/presence/account/Ghost");
      assert.equal(card.json.playing.mapPicture, "/assets/maps/h9_te_neuropolis.png");
      t.advance(1);
      await ok(t, { players: [as(t, "Ghost", A)], map: "ts_blitz", mode: "Deathmatch" });
      card = await get(t, "/api/presence/account/Ghost");
      assert.equal(card.json.playing.map, "ts_blitz");
      assert.equal(card.json.playing.mapPicture, null, "no picture: text only, as the Discord card falls back");
    } finally {
      await t.close();
      fs.rmSync(pics, { recursive: true, force: true });
    }
  });

  test("settings are checked", () => {
    assert.throws(() => presenceSettings({ maxCreditSeconds: 200, sessionTimeoutSeconds: 180 }), /maxCreditSeconds/);
    assert.throws(() => presenceSettings({ privacy: { game: "yes" } }), /privacy\.game/);
    assert.throws(() => presenceSettings({ privacy: { everything: true } }), /no switch everything/);
    assert.throws(() => presenceSettings({ inGameNames: 1 }), /inGameNames/);
    assert.throws(() => presenceSettings({ requireProof: 1 }), /requireProof/);
    assert.throws(() => presenceSettings({ mapPicturesDir: "relative/dir" }), /absolute/);
    assert.throws(() => presenceSettings({ limits: { readPerIp: { max: 0 } } }), /readPerIp/);
    assert.deepEqual(presenceSettings({ privacy: { site: false } }).privacy, { game: true, where: true, web: true, site: false, playtime: true, lastSeen: true });
    assert.equal(presenceSettings({}).requireProof, false);
  });
});

describe("presence: rate limits", () => {
  let t;
  before(async () => {
    const tight = { max: 3, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 };
    t = await presenceApp({ settings: { limits: { ...roomy(), reportPerIp: { ...tight, max: 8 }, reportPerServer: tight, readPerIp: tight, settingsPerAccount: { ...tight, max: 2 } } } });
    await signup(t.base, "Seraph");
  });
  after(async () => {
    await t.close();
  });

  test("per server only reports that verified count; per IP every request counts", async () => {
    const wrong = randomHex(32);
    for (let i = 0; i < 4; i++) assert.equal((await send(t, { key: wrong, ip: "203.0.113.200" })).status, 401);
    for (let i = 0; i < 3; i++) {
      t.advance(1);
      const r = await send(t, { ip: "203.0.113.200" });
      assert.equal(r.status, 200, "forged reports did not use up the server's own allowance");
    }
    t.advance(1);
    let r = await send(t, { ip: "203.0.113.201" });
    assert.equal(r.status, 429, "the fourth verified report from A within the minute");
    assert.ok(Number(r.headers["retry-after"]) > 0);
    for (let i = 0; i < 8; i++) assert.equal((await send(t, { server: B, key: wrong, ip: "203.0.113.202" })).status, 401);
    r = await send(t, { server: B, ip: "203.0.113.202" });
    assert.equal(r.status, 429, "the ninth request from one address, though a good one");
  });

  test("reads per IP and the switch per account", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await get(t, "/api/presence/now", { ip: "198.51.100.77" })).status, 200);
    const r = await get(t, "/api/presence/accounts?u=Seraph", { ip: "198.51.100.77" });
    assert.equal(r.status, 429);
    assert.equal((await get(t, "/api/presence/now", { ip: "198.51.100.78" })).status, 200, "another address is not affected");
    const cookie = await login(t, "Seraph");
    for (let i = 0; i < 2; i++) assert.equal((await request(t.base, "POST", "/api/presence/settings", { cookie, body: { game: i === 0 } })).status, 200);
    assert.equal((await request(t.base, "POST", "/api/presence/settings", { cookie, body: { game: true } })).status, 429);
  });
});

describe("presence: keys, the registry, and no secret in the logs", () => {
  test("presence-key.js makes a key, prints it once, keeps it in a 0600 file; list never shows keys", async () => {
    const t = await startApp({}, { servers: SERVERS });
    try {
      const run = (...a) => spawnSync(process.execPath, [KEY_SCRIPT, "--config", t.configFile, ...a], { encoding: "utf8" });
      let r = run("add", A);
      assert.equal(r.status, 0, r.stderr);
      const key = /h9_presence_key "([0-9a-f]{64})"/.exec(r.stdout)[1];
      const file = path.join(t.config.dataDir, "modules", "presence", "server-keys.json");
      assert.equal(readKeys(file).get(A).key, key);
      if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      r = run("add", A);
      assert.notEqual(r.status, 0, "a second add is refused");
      r = run("list");
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes(A) && !r.stdout.includes(key));
      r = run("rotate", A);
      assert.equal(r.status, 0);
      assert.notEqual(readKeys(file).get(A).key, key);
      r = run("add", "192.0.2.50:27015");
      assert.equal(r.status, 0);
      assert.match(r.stdout, /not on .* yet/);
      r = run("remove", "192.0.2.50:27015");
      assert.equal(r.status, 0);
      assert.equal(readKeys(file).has("192.0.2.50:27015"), false);
      assert.notEqual(run("add", "havoc9.org:27015").status, 0, "an address, not a host name");
    } finally {
      await t.close();
    }
  });

  test("without core's clientIdIndex: reads work, reports answer 503, the log names the hook", async () => {
    const t = await presenceApp({ hooks: { clientIdIndex: null } });
    try {
      const now = await request(t.base, "GET", "/api/presence/now");
      assert.equal(now.status, 200);
      assert.deepEqual(now.json.servers, []);
      const r = await send(t, {});
      assert.equal(r.status, 503);
      assert.equal(r.json.error, "not_ready");
      assert.ok(t.logs.some((l) => l.includes("presence.core_hook_missing") && l.includes("accounts.clientIdIndex")));
    } finally {
      await t.close();
    }
  });

  test("loaded through the registry, core's hooks are there: a proven report, the site, the relay", async () => {
    const t = await startApp({ modules: ["presence"], moduleSettings: { presence: { cacheSeconds: 0 } }, limits: CORE_ROOMY },
      { modulesDir: MODULES, servers: SERVERS });
    const sockets = [];
    try {
      assert.equal(t.app.db.prepare("SELECT version FROM schema_migrations WHERE module = 'presence'").get().version, 1);
      assert.ok(!t.logs.some((l) => l.includes("presence.core_hook_missing")), "no hook is missing");
      await signup(t.base, "Neo");
      const trin = await signup(t.base, "Trinity");
      const card = async (name) => (await request(t.base, "GET", "/api/presence/account/" + name)).json;
      writeKeys(path.join(t.config.dataDir, "modules", "presence", "server-keys.json"),
        new Map([[A, { key: KEYS[A], created: "2026-11-01T00:00:00Z" }]]));
      const pid = t.app.accounts.playerId(t.app.accounts.getByUsername("Neo"));
      // the key file is looked at again at most once a second
      await until(async () => {
        const ts = Math.floor(Date.now() / 1000);
        const player = { id: clientIdFor(pid, A), name: "Neo-ingame", joined: ts - 5, time: 5, ...makeProof(pid, A, DEV1, nonceAt(ts)), net: NET1 };
        issue(t, A, player.nonce);
        const body = JSON.stringify({ v: 1, server: A, ts, reason: "tick", map: "h9_te_neuropolis", mode: "Team Elimination", players: [player] });
        const r = await request(t.base, "POST", "/api/presence/report", { body, origin: null, headers: { "x-h9-server": A, "x-h9-signature": hmac(KEYS[A], body).toString("hex") } });
        return r.status === 200;
      }, 4000, 250);
      const neo = await card("Neo");
      assert.equal(neo.state, "game");
      assert.equal(neo.playing.server.address, A);
      assert.equal(neo.playing.verified, true, "core's verifyIdProof checked the proof");
      await t.app.accounts.create("Oracle", PASSWORD);
      assert.equal((await card("Oracle")).state, "offline", "never signed in");
      assert.equal((await request(t.base, "GET", "/api/me", { cookie: trin })).json.signedIn, true);
      assert.equal((await card("Trinity")).state, "site", "core's site activity");
      const ws = await openRelay(t.port, trin);
      sockets.push(ws);
      await until(async () => (await card("Trinity")).state === "web");
      ws.close();
      await ws.closed;
      await until(async () => (await card("Trinity")).state === "site");
      // signing out ends "on the site" at once
      assert.equal((await request(t.base, "POST", "/api/logout", { cookie: trin })).status, 200);
      const gone = await card("Trinity");
      assert.equal(gone.state, "offline", "signed out: not on the site");
      assert.ok(gone.lastSeen, "the sign-out's request is kept as last seen");
    } finally {
      for (const ws of sockets) try { ws.close(); } catch (e) { /* closed */ }
      await t.close();
    }
  });

  test("no key, signature, player id, h9_clientid, proof, device or network in the logs", async () => {
    const t = await presenceApp();
    try {
      const cookie = await signup(t.base, "Oracle");
      await signup(t.base, "Smith");
      const pid = pidOf(t, "Oracle");
      const secrets = [...Object.values(KEYS), pid, cookie.split("=")[1], DEV1, DEV2, NET1, NET2, deviceHash(DEV1), deviceHash(DEV2)];
      for (let i = 0; i < 3; i++) {
        t.advance(1);
        const players = [entry(t, pid, A, { device: i === 2 ? DEV2 : DEV1, net: i ? NET2 : NET1 }), { id: randomHex(16), name: "n" }];
        const body = JSON.stringify({ v: 1, server: A, ts: t.sec(), map: "h9_te_neuropolis", players });
        secrets.push(hmac(KEYS[A], body).toString("hex"), players[0].id, players[1].id, players[0].proof, players[0].devmask, players[0].nonce);
        await ok(t, { body });
      }
      t.advance(1);
      const forged = { ...entry(t, pidOf(t, "Smith"), A, { proof: false }), ...makeProof(randomHex(16), A, DEV3, nonceAt(t.sec())) };
      secrets.push(forged.proof);
      await ok(t, { players: [forged] });
      await send(t, { key: KEYS[B] });
      await send(t, { ts: 1 });
      await request(t.base, "POST", "/api/presence/settings", { cookie, body: { game: false } });
      t.app.events.emit("relay-game-start", { accountId: idOf(t, "Oracle"), server: B });
      t.p.sweep();
      const logs = t.logs.join("\n");
      for (const s of secrets) assert.ok(!logs.includes(s), "a secret, an id, a device or a network reached the log");
      assert.ok(logs.includes("presence.privacy") && logs.includes("presence.flag"), "the log has the events, without them");
    } finally {
      await t.close();
    }
  });
});

describe("presence: core's hooks", () => {
  test("site activity: a signed-in request counts; the relay's re-check and a suspended account do not", async () => {
    const t = await startApp({ limits: CORE_ROOMY });
    try {
      const { auth, accounts } = t.app;
      const before = Math.floor(Date.now() / 1000);
      const cookie = await signup(t.base, "Walker");
      const walker = accounts.getByUsername("Walker").id;
      assert.deepEqual(auth.activeSince(before), [], "signing up makes no request with a session yet");
      await request(t.base, "GET", "/api/me", { cookie });
      assert.ok(auth.lastActive(walker) >= before);
      assert.deepEqual(auth.activeSince(before), [walker]);
      // the relay's re-check of its sockets goes through sessionByHash, which records nothing
      const ghost = await accounts.create("Ghost", PASSWORD);
      const token = auth.newSession(ghost.id);
      const seen = before - 60;
      t.app.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE account_id = ?").run(seen, ghost.id);
      assert.ok(auth.sessionByHash(auth.tokenHash(token)));
      assert.equal(auth.lastActive(ghost.id), seen, "no request since a restart: the session's last_seen_at");
      assert.deepEqual(auth.activeSince(before), [walker]);
      const smith = await signup(t.base, "Smith");
      accounts.ban(accounts.getByUsername("Smith").id, before + 600, null);
      await request(t.base, "GET", "/api/me", { cookie: smith });
      assert.deepEqual(auth.activeSince(before), [walker], "a suspended account's request does not count");
      assert.equal(auth.lastActive(424242), null);
      // signing out: no longer active at once, its last request kept as its last seen
      assert.equal(auth.signedOutAt(walker), null);
      assert.equal((await request(t.base, "POST", "/api/logout", { cookie })).status, 200);
      assert.deepEqual(auth.activeSince(before), [], "a signed-out account is not on the site");
      assert.ok(auth.signedOutAt(walker) >= before);
      assert.ok(auth.lastActive(walker) >= before, "its last request stays its last seen");
    } finally {
      await t.close();
    }
  });

  test("clientIdIndex follows accounts made, deleted, reset and moved; nameInUse is the sign-up rule", async () => {
    const t = await startApp({ limits: CORE_ROOMY });
    try {
      const { accounts, clientIds } = t.app;
      const cid = (id, address) => clientIdFor(accounts.playerId(accounts.getById(id)), address);
      await signup(t.base, "Neo");
      const neo = accounts.getByUsername("Neo").id;
      assert.equal(clientIds.clientIdIndex(A).get(cid(neo, A)), neo);
      assert.equal(clientIds.clientIdIndex(A).get(cid(neo, B)), undefined, "another server's id matches nobody");
      assert.equal(clientIds.clientIdIndex(C).get(cid(neo, A)), neo, "one IP, one id, whatever the port");
      await signup(t.base, "Trinity");
      const trin = accounts.getByUsername("Trinity").id;
      assert.equal(clientIds.clientIdIndex(A).get(cid(trin, A)), trin, "a new account at once");
      const leaked = cid(neo, A);
      accounts.resetPlayerId(neo);
      assert.equal(clientIds.clientIdIndex(A).get(leaked), undefined, "a reset id is dead");
      assert.equal(clientIds.clientIdIndex(A).get(cid(neo, A)), neo);
      const neoId = cid(neo, A);
      const trinOld = cid(trin, A);
      accounts.movePlayerId(neo, trin);
      assert.equal(clientIds.clientIdIndex(A).get(neoId), trin, "a moved id is the other account's");
      assert.equal(clientIds.clientIdIndex(A).get(trinOld), undefined, "and that account's old one is dead");
      assert.equal(clientIds.clientIdIndex(A).get(cid(neo, A)), neo);
      assert.throws(() => accounts.movePlayerId(neo, neo));
      accounts.remove(trin);
      assert.equal(clientIds.clientIdIndex(A).get(neoId), undefined, "a deleted account's id matches nobody");
      assert.throws(() => clientIds.clientIdIndex("havoc9.org:27015"));
      // an account another process made (the admin script) is noticed within recheckMs
      const clock = { ms: Date.now() };
      const other = createClientIds({ db: t.app.db, secrets: loadSecrets(t.config.dataDir), now: () => clock.ms });
      assert.equal(other.clientIdIndex(A).size, 1);
      await signup(t.base, "Mouse");
      assert.equal(other.clientIdIndex(A).size, 1);
      clock.ms += 61000;
      assert.equal(other.clientIdIndex(A).get(cid(accounts.getByUsername("Mouse").id, A)), accounts.getByUsername("Mouse").id);
      assert.equal(accounts.nameInUse("ne0"), true, "a look-alike");
      assert.equal(accounts.nameInUse("NEO"), true);
      assert.equal(accounts.nameInUse("Player 1234"), false);
      assert.equal(accounts.nameInUse(""), false);
    } finally {
      await t.close();
    }
  });
});
