// Rated play (modules/presence/compete.js): compts's Elo per kill, match results, the three
// scopes, privacy, voids, disputes and decay. docs\H9_COMPETITIVE.txt is the guide.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startApp, request, signup } from "./helpers.js";
import { migrate, transaction } from "../lib/db.js";
import { HttpError, clientIp } from "../lib/http.js";
import { RateLimiter, ipKey } from "../lib/ratelimit.js";
import { serverClientId } from "../lib/playerid.js";
import { parseAddress } from "../lib/servers.js";
import { serversHook } from "../lib/modules.js";
import { createPresence, MIGRATIONS, DEFAULTS } from "../modules/presence/index.js";
import { writeKeys } from "../modules/presence/keys.js";
import { competeSettings } from "../modules/presence/compete.js";

const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const CORE_ROOMY = { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY };
const roomy = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
const LISTED = "203.0.113.10:27015";
const LISTED_KEY = crypto.randomBytes(32).toString("hex");
const hmacHex = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const randomHex = (n) => crypto.randomBytes(n).toString("hex");

async function app({ compete = {}, limits = {} } = {}) {
  const t = await startApp({ limits: CORE_ROOMY }, { servers: [{ name: "HAVOC 9", address: LISTED }] });
  const clock = { ms: Date.now() };
  migrate(t.app.db, "presence", MIGRATIONS, {});
  const dataDir = path.join(t.config.dataDir, "modules", "presence");
  const core = t.app.accounts;
  const p = createPresence({
    db: t.app.db,
    transaction: (fn) => transaction(t.app.db, fn),
    router: t.app.router.scoped(["/api/presence"]),
    auth: { ...t.app.auth, confirmAdmin: t.app.confirmAdmin },
    accounts: {
      getById: core.getById, getByUsername: core.getByUsername, publicView: core.publicView, isBanned: core.isBanned,
      clientIdIndex: t.app.clientIds.clientIdIndex, verifyIdProof: core.verifyIdProof, nameInUse: core.nameInUse,
    },
    servers: serversHook({ servers: t.app.servers, status: t.app.status }),
    events: t.app.events,
    audit: t.app.audit,
    log: t.app.log.child("presence"),
    settings: { limits: { ...roomy(), ...limits }, cacheSeconds: 0, compete },
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

function call(t, route, fields = {}) {
  const body = JSON.stringify({ v: 1, server: LISTED, ts: t.sec(), nonce: randomHex(8), ...fields });
  return request(t.base, "POST", "/api/presence/compete/" + route, { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(LISTED_KEY, body) } });
}

const idOf = (t, name) => t.app.accounts.getByUsername(name).id;
const cid = (t, name) => serverClientId(t.app.accounts.playerId(t.app.accounts.getByUsername(name)), parseAddress(LISTED).bytes);

// A presence report that has these players in game here; a device makes the player proven (a
// proof answering a nonce h9web issued, as POST /api/presence/server/nonce does).
async function present(t, list) {
  t.advance(1);
  const players = list.map(([name, slot, device]) => {
    const pid = t.app.accounts.playerId(t.app.accounts.getByUsername(name));
    const e = { id: cid(t, name), slot, name, joined: t.sec() - 5, time: 5 };
    if (device) {
      const nonce = randomHex(16);
      t.app.db.prepare("INSERT OR IGNORE INTO presence_proof_nonces (nonce, server, issued_at) VALUES (?, ?, ?)").run(nonce, LISTED, t.sec());
      const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
      const dm = Buffer.from(device, "hex");
      for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
      const devmask = dm.toString("hex");
      Object.assign(e, { nonce, devmask, proof: hmacHex(pid, "h9proof1:" + nonce + ":" + LISTED + ":" + devmask) });
    }
    return e;
  });
  const body = JSON.stringify({ v: 1, server: LISTED, ts: t.sec(), map: "h9_te_neuropolis", mode: "Team Elimination", players });
  const r = await request(t.base, "POST", "/api/presence/report", { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(LISTED_KEY, body) } });
  assert.equal(r.status, 200, r.text);
}

const DEV = (n) => String(n).repeat(32).slice(0, 32);
const elo = (t, scope, name, ladder = "match") => {
  const r = t.app.db.prepare("SELECT elo FROM compete_ratings WHERE scope = ? AND ladder = ? AND account_id = ?").get(scope, ladder, idOf(t, name));
  return r ? r.elo : null;
};
const S = "s:" + LISTED;
const lvXp = (xp, base = 20, power = 2.3) => (xp > 0 ? Math.min(99, 1 + Math.floor(Math.pow(xp / base, 1 / power) + 1e-9)) : 0);
const xpOf = (t, name) => (t.app.db.prepare("SELECT xp FROM compete_levels WHERE account_id = ?").get(t.app.accounts.getByUsername(name).id) || { xp: 0 }).xp;

async function start(t, ladder = "match", players = []) {
  const r = await call(t, "start", { ladder, map: "h9_te_neuropolis", mode: "Team Elimination", humans: players.length, bots: 0, players });
  assert.equal(r.status, 200, r.text);
  return r.json.match;
}

describe("compete: an Assault match ranks like any other", () => {
  let t;
  before(async () => {
    t = await app();
    for (const n of ["alice", "bob", "carol"]) await signup(t.base, n);
    await present(t, [["alice", 1, DEV(1)], ["bob", 2, DEV(2)], ["carol", 3, null]]);
  });
  after(() => t.close());

  test("it is the match ladder with its mode written as text, and a kill counts", async () => {
    const r0 = await call(t, "start", { ladder: "match", map: "h9_as_lift", mode: "Assault", humans: 2, bots: 0, players: [[cid(t, "alice"), 1], [cid(t, "bob"), 2]] });
    assert.equal(r0.status, 200, r0.text);
    const m = r0.json.match;
    const row = t.app.db.prepare("SELECT ladder, map, mode FROM compete_matches WHERE id = ?").get(m);
    assert.deepEqual([row.ladder, row.map, row.mode], ["match", "h9_as_lift", "Assault"]);
    const r = await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "alice"), cid(t, "bob"), 1, 0]] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.counted, 1);
    assert.equal(elo(t, S, "alice"), 1002);
    assert.equal(elo(t, S, "bob"), 999);
  });
});

describe("compete: a match of one round (Assault, Capture the Flag) is rated as the round it is", () => {
  let t;
  before(async () => {
    t = await app();
    for (const n of ["ann", "ben"]) await signup(t.base, n);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)]]);
  });
  after(() => t.close());

  const end = (m, result) => call(t, "end", { match: m, result, players: [[cid(t, "ann"), 1, 1, 400, 0], [cid(t, "ben"), 2, 1, 400, 0]] });
  const play = async (wait) => {
    const m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
    if (wait) {
      t.advance(wait);
      await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)]]);
    }
    return m;
  };

  test("one round that the plugin says is the whole match, and lasted the minimum time: rated", async () => {
    const r = await end(await play(400), { how: "finished", winner: 1, rounds: 1, oneRound: 1 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.rated, true);
    assert.equal(elo(t, S, "ann"), 1100);
    assert.equal(elo(t, S, "ben"), 930);
  });

  test("the same single round without the flag is too few rounds, as it always was; and a one-round match is still not rated when short", async () => {
    let r = await end(await play(400), { how: "finished", winner: 1, rounds: 1 });
    assert.equal(r.json.rated, false);
    assert.match(r.json.why, /fewer than 3 rounds/);
    r = await end(await play(0), { how: "finished", winner: 1, rounds: 1, oneRound: 1 });
    assert.equal(r.json.rated, false);
    assert.match(r.json.why, /shorter than/);
    r = await end(await play(400), { how: "finished", winner: 0, rounds: 1, oneRound: 1 });
    assert.equal(r.json.rated, false);
    assert.match(r.json.why, /no winner/);
  });
});

describe("compete: compts's Elo per kill", () => {
  let t;
  before(async () => {
    t = await app();
    for (const n of ["alice", "bob", "carol"]) await signup(t.base, n);
    await present(t, [["alice", 1, DEV(1)], ["bob", 2, DEV(2)], ["carol", 3, null]]);
  });
  after(() => t.close());

  test("a kill, a headshot and the bonus for killing a better player, as compts's README says", async () => {
    const m = await start(t, "match", [[cid(t, "alice"), 1], [cid(t, "bob"), 2]]);
    let r = await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "alice"), cid(t, "bob"), 1, 0]] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.counted, 1);
    assert.equal(elo(t, S, "alice"), 1002); // +1 kill, +1 headshot
    assert.equal(elo(t, S, "bob"), 999);
    // bob is now 3 below: no bonus either way under 100 apart
    t.app.db.prepare("UPDATE compete_ratings SET elo = 1300 WHERE scope = ? AND account_id = ?").run(S, idOf(t, "alice"));
    r = await call(t, "kills", { match: m, seq: 2, kills: [[cid(t, "bob"), cid(t, "alice"), 0, 0]] });
    assert.equal(r.json.counted, 1);
    assert.equal(elo(t, S, "bob"), 999 + 1 + 3); // 301 below: +3 bonus
    assert.equal(elo(t, S, "alice"), 1300 - 1 - 1); // and half of it, rounded down, lost
    // killing a worse player pays only the kill (compts's code paid more for it)
    r = await call(t, "kills", { match: m, seq: 3, kills: [[cid(t, "alice"), cid(t, "bob"), 0, 0]] });
    assert.equal(elo(t, S, "alice"), 1299);
    assert.equal(elo(t, S, "bob"), 1002);
  });

  test("team kills, an unproven victim and a suicide move nothing; batches go in order once", async () => {
    const m = t.app.db.prepare("SELECT id, seq FROM compete_matches WHERE status = 'open'").get();
    const before = [elo(t, S, "alice"), elo(t, S, "bob")];
    let r = await call(t, "kills", { match: m.id, seq: m.seq + 1, kills: [
      [cid(t, "alice"), cid(t, "bob"), 0, 1], [cid(t, "alice"), cid(t, "carol"), 0, 0], [cid(t, "alice"), cid(t, "alice"), 0, 0],
    ] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.counted, r.json.unrated], [0, 3]);
    assert.deepEqual([elo(t, S, "alice"), elo(t, S, "bob")], before);
    assert.equal(elo(t, S, "carol"), null, "an unproven player gets no rating");
    assert.equal(t.app.db.prepare("SELECT teamkills FROM compete_players WHERE match_id = ? AND account_id = ?").get(m.id, idOf(t, "alice")).teamkills, 1);
    r = await call(t, "kills", { match: m.id, seq: m.seq + 1, kills: [[cid(t, "alice"), cid(t, "bob"), 0, 0]] });
    assert.equal(r.json.duplicate, true);
    assert.deepEqual([elo(t, S, "alice"), elo(t, S, "bob")], before);
    r = await call(t, "kills", { match: m.id, seq: m.seq + 3, kills: [] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "out_of_order");
  });

  test("a forged or unsigned call is refused", async () => {
    const body = JSON.stringify({ v: 1, server: LISTED, ts: t.sec(), nonce: randomHex(8), ladder: "match" });
    const r = await request(t.base, "POST", "/api/presence/compete/start", { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(randomHex(32), body) } });
    assert.equal(r.status, 401);
  });
});

describe("compete: match results, scopes and the rules", () => {
  let t;
  let admin;
  before(async () => {
    t = await app();
    for (const n of ["ann", "ben", "cat", "dan", "eve"]) await signup(t.base, n);
    admin = await signup(t.base, "boss");
    t.app.accounts.setRole(idOf(t, "boss"), "admin");
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)], ["eve", 5, null]]);
  });
  after(() => t.close());

  const serverId = () => t.p.enrollment.serverIdFor(LISTED);
  const end = (m, result, players, extra = {}) => call(t, "end", { match: m, result, players, ...extra });

  test("a rated match: +100 to the winners, -70 to the losers; a leaver loses", async () => {
    const m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2], [cid(t, "cat"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)]]);
    const r = await end(m, { how: "finished", winner: 1, score1: 5, score2: 2, rounds: 7 }, [
      [cid(t, "ann"), 1, 7, 400, 0], [cid(t, "ben"), 2, 7, 400, 0], [cid(t, "cat"), 2, 2, 120, 1],
    ]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.rated, true);
    assert.equal(elo(t, S, "ann"), 1100);
    assert.equal(elo(t, S, "ben"), 930);
    assert.equal(elo(t, S, "cat"), 930);
    assert.equal(r.json.changes[cid(t, "ann")].server, 100);
    const rows = t.app.db.prepare("SELECT account_id, result FROM compete_players WHERE match_id = ? ORDER BY account_id").all(m);
    assert.deepEqual(rows.map((x) => x.result), ["win", "loss", "left"]);
    // again: the same answer, nothing counted twice
    const again = await end(m, { how: "finished", winner: 1, score1: 5, score2: 2, rounds: 7 }, []);
    assert.equal(again.json.duplicate, true);
    assert.equal(elo(t, S, "ann"), 1100);
  });

  test("too short, too few rounds, bots, a cancel: recorded, not rated", async () => {
    for (const [result, extra, why] of [
      [{ how: "finished", winner: 2, rounds: 7 }, {}, /shorter than/],
      [{ how: "finished", winner: 2, rounds: 2 }, { wait: 400 }, /fewer than 3 rounds/],
      [{ how: "finished", winner: 2, rounds: 5 }, { wait: 400, bots: 1 }, /bots played/],
      [{ how: "cancelled", rounds: 5 }, { wait: 400 }, /cancelled/],
    ]) {
      const m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
      if (extra.wait) {
        t.advance(extra.wait);
        await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)]]);
      }
      const r = await end(m, result, [[cid(t, "ann"), 1, 5, 400, 0], [cid(t, "ben"), 2, 5, 400, 0]], { bots: extra.bots || 0 });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.rated, false);
      assert.match(r.json.why, why);
    }
    assert.equal(elo(t, S, "ann"), 1100);
  });

  test("every enrolled server counts for the H9 ladder, two proven a side; unproven players stop nothing; UNRANKED, a site admin's flag, counts none", async () => {
    // one a side: the server's table counts it, the H9 ladder does not
    let m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)], ["eve", 5, null]]);
    let r = await end(m, { how: "finished", winner: 2, rounds: 5 }, [[cid(t, "ann"), 1, 5, 400, 0], [cid(t, "ben"), 2, 5, 400, 0]]);
    assert.equal(r.json.rated, true);
    assert.match(r.json.why, /network: the H9 ladder needs 2 proven players a side/);
    assert.equal(elo(t, "n", "ben"), null);
    // two a side, and an unproven player (eve, no proof) on one: the proven play on, rated there too
    m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "cat"), 1], [cid(t, "ben"), 2], [cid(t, "dan"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)], ["eve", 5, null]]);
    const four = [[cid(t, "ann"), 1, 5, 400, 0], [cid(t, "cat"), 1, 5, 400, 0], [cid(t, "ben"), 2, 5, 400, 0], [cid(t, "dan"), 2, 5, 400, 0]];
    r = await end(m, { how: "finished", winner: 1, rounds: 5 }, [...four, [cid(t, "eve"), 2, 5, 400, 0]]);
    assert.equal(r.json.why, null);
    assert.equal(elo(t, "n", "ann"), 1100);
    assert.equal(elo(t, "n", "dan"), 930);
    assert.equal(elo(t, "n", "eve"), null, "the unproven player moves nothing");
    // UNRANKED: only a site admin's; the match under way ends, and the next is refused
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: await signup(t.base, "nobody"), body: { unranked: true } });
    assert.equal(r.status, 403);
    const open = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: "yes" } });
    assert.equal(r.status, 400);
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(t.p.compete.scopesFor(LISTED).keys, [], "it feeds no table");
    assert.equal(t.app.db.prepare("SELECT status, how FROM compete_matches WHERE id = ?").get(open).how, "cancelled");
    r = await call(t, "start", { ladder: "match", map: "h9_te_neuropolis", mode: "Team Elimination", humans: 2, bots: 0, players: [] });
    assert.deepEqual([r.status, r.json.error], [409, "not_rated"]);
    let audit = t.app.db.prepare("SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual([audit.action, audit.detail], ["presence.compete.server.unranked", "UNRANKED"]);
    // ranked again: all proven, a forfeit, counted on the H9 ladder
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: false } });
    assert.equal(r.status, 200, r.text);
    m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "cat"), 1], [cid(t, "ben"), 2], [cid(t, "dan"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)]]);
    r = await end(m, { how: "forfeit", winner: 1, rounds: 4 }, four);
    assert.equal(r.json.rated, true);
    assert.equal(r.json.why, null);
    assert.equal(elo(t, "n", "ann"), 1200);
    assert.equal(elo(t, "n", "dan"), 860);
    assert.equal(r.json.changes[cid(t, "dan")].network, -70);
    // UNRANKED with a void: the server's matches in the time given are taken back, one void each
    const from = t.sec() - 500;
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: true, void: { from, to: t.sec() } } });
    assert.equal(r.status, 400, "a void needs its typed confirm");
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: true, void: { from, to: t.sec() }, confirm: "VOID", note: "a test server" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.voided, 2, "the match cancelled by the first UNRANKED, and the forfeit");
    assert.equal(elo(t, "n", "ann"), 1100, "the forfeit's +100 is taken back");
    audit = t.app.db.prepare("SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.action, "presence.compete.server.unranked");
    assert.match(audit.detail, /UNRANKED; 2 matches voided, .* to .*: a test server/);
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: false } });
    assert.equal(r.status, 200, r.text);
  });

  test("the admin panel's list of every enrolled server carries its UNRANKED flag; anyone else gets the ordinary list", async () => {
    const mine = (r) => r.json.servers.find((s) => s.serverId === serverId());
    let r = await request(t.base, "GET", "/api/presence/compete/servers?all=1", { cookie: admin });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([typeof mine(r).name, mine(r).unranked, mine(r).unrankedAt], ["string", false, null]);
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: true } });
    assert.equal(r.status, 200, r.text);
    r = await request(t.base, "GET", "/api/presence/compete/servers?all=1", { cookie: admin });
    assert.deepEqual([mine(r).unranked, typeof mine(r).unrankedAt], [true, "string"]);
    // not an admin's to ask for: the ordinary list, which has none of the admin fields
    r = await request(t.base, "GET", "/api/presence/compete/servers?all=1", { cookie: await signup(t.base, "reader") });
    assert.equal(r.status, 200, r.text);
    assert.equal(mine(r).unranked, true);
    assert.equal("approved" in mine(r) || "unrankedAt" in mine(r), false);
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { unranked: false } });
    assert.equal(r.status, 200, r.text);
  });

  test("a roleplay map is not rated: the start is refused", async () => {
    for (const map of ["rp_city", "tsrp_downtown", "h9_tsrp_hive", "mymap_rp_x"]) {
      const r = await call(t, "start", { ladder: "dm", map, mode: "deathmatch", humans: 2, bots: 0, players: [] });
      assert.deepEqual([r.status, r.json.error], [409, "not_rated"], map);
    }
    const r = await call(t, "start", { ladder: "dm", map: "ts_dock", mode: "deathmatch", humans: 2, bots: 0, players: [] });
    assert.equal(r.status, 200, "TS's own map is rated as deathmatch");
  });

  test("a server h9web does not know is refused before anything is kept", async () => {
    const other = "198.51.100.7:27015";
    const body = JSON.stringify({ v: 1, server: other, ts: t.sec(), nonce: randomHex(8), ladder: "match", map: "h9_te_neuropolis", mode: "Team Elimination", humans: 2, bots: 0, players: [] });
    const before = t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_matches").get().n;
    const r = await request(t.base, "POST", "/api/presence/compete/start", { body, origin: null, headers: { "x-h9-server": other, "x-h9-signature": hmacHex(randomHex(32), body) } });
    assert.equal(r.status, 403, "no key for it: refused, which h9_compete takes quietly (one console line a map, the match not rated)");
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_matches").get().n, before, "no match was kept");
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_servers WHERE server = ?").get(other).n, 0, "and nothing of that server");
  });

  test("the boards and the player's page show every account's rank, whatever its switches; its matches follow SHOW WHICH SERVER AND MAP", async () => {
    let r = await request(t.base, "GET", "/api/presence/compete/board?scope=s:" + serverId());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scope.kind, "server");
    const names = r.json.players.map((p) => p.username);
    assert.ok(names.includes("ann") && names.includes("ben"));
    assert.equal(r.json.players[0].rank, 1);
    // ben hides his playtime and where he plays: his rank shows on, his matches do not
    const cookie = (await request(t.base, "POST", "/api/login", { body: { username: "ben", password: "correct horse battery staple" } })).cookie;
    assert.equal((await request(t.base, "POST", "/api/presence/settings", { cookie, body: { playtime: false, where: false } })).status, 200);
    r = await request(t.base, "GET", "/api/presence/compete/board?scope=s:" + serverId());
    assert.ok(r.json.players.some((p) => p.username === "ben"), "SHOW MY PLAYTIME hides no rank");
    assert.deepEqual(r.json.players.map((p) => p.rank), r.json.players.map((_, i) => i + 1));
    r = await request(t.base, "GET", "/api/presence/compete/player/ben");
    assert.ok(r.json.ratings.length >= 1, "his tables");
    assert.equal(r.json.matches, null, "where and when he played stays his");
    r = await request(t.base, "GET", "/api/presence/compete/me", { cookie });
    assert.ok(r.json.ratings.length >= 1 && r.json.matches.length >= 1, "a player sees all of their own");
    const m = r.json.matches[0].id;
    r = await request(t.base, "GET", "/api/presence/compete/match/" + m);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.players.some((p) => p.name === "a hidden player"));
    assert.ok(!r.json.players.some((p) => p.name === "ben"));
    r = await request(t.base, "GET", "/api/presence/compete/player/ann");
    assert.ok(r.json.ratings.some((x) => x.kind === "network" && x.elo === 1100));
    assert.ok(r.json.ratings.some((x) => x.kind === "server"));
    assert.equal(r.json.elo, 1100, "the H9 ladder's MATCH rating, the ELO figure");
    assert.ok(r.json.matches.length >= 1);
  });
  test("a void takes back exactly what the match gave; a dispute is for the match's players", async () => {
    const before = elo(t, S, "ann");
    const m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
    await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "ann"), cid(t, "ben"), 1, 0]] });
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)]]);
    await end(m, { how: "finished", winner: 1, rounds: 5 }, [[cid(t, "ann"), 1, 5, 400, 0], [cid(t, "ben"), 2, 5, 400, 0]]);
    assert.equal(elo(t, S, "ann"), before + 102);
    const ann = (await request(t.base, "POST", "/api/login", { body: { username: "ann", password: "correct horse battery staple" } })).cookie;
    let r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/dispute", { cookie: ann, body: { reason: "the server gave them godmode" } });
    assert.equal(r.status, 201, r.text);
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/dispute", { cookie: await signup(t.base, "outsider"), body: { reason: "x" } });
    assert.equal(r.status, 404);
    r = await request(t.base, "GET", "/api/presence/compete/disputes", { cookie: admin });
    assert.equal(r.json.disputes[0].match, m);
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/void", { cookie: ann, body: { note: "mine" } });
    assert.equal(r.status, 403);
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/void", { cookie: admin, body: { note: "godmode" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, "voided");
    assert.equal(elo(t, S, "ann"), before);
    const audit = t.app.db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.action, "presence.compete.void");
  });

  test("a community's ladder: the staff's switch and tick; a staff void takes back only their scope", async () => {
    const owner = await signup(t.base, "chief");
    let r = await request(t.base, "POST", "/api/presence/communities", { cookie: owner, body: { slug: "clan", name: "The Clan" } });
    assert.equal(r.status, 201, r.text);
    const cmId = t.app.db.prepare("SELECT id FROM presence_communities WHERE slug = 'clan'").get().id;
    t.app.db.prepare("INSERT INTO presence_community_servers (server, community_id, tag, read_only, linked_at) VALUES (?, ?, 'H9', 0, ?)").run(LISTED, cmId, t.sec());
    assert.equal((await request(t.base, "POST", "/api/presence/compete/communities/clan", { cookie: owner, body: { ladder: true } })).status, 200);
    r = await request(t.base, "POST", "/api/presence/compete/communities/clan/servers/" + serverId(), { cookie: owner, body: { counts: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(t.p.compete.scopesFor(LISTED).keys, [S, "c:" + cmId, "n"]);
    const m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
    await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "ann"), cid(t, "ben"), 0, 0]] });
    assert.equal(elo(t, "c:" + cmId, "ann"), 1001);
    const sBefore = elo(t, S, "ann");
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/void", { cookie: owner, body: { note: "test" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(elo(t, "c:" + cmId, "ann"), 1000);
    assert.equal(elo(t, S, "ann"), sBefore, "the server's own table is not the community's to void");
    r = await request(t.base, "GET", "/api/presence/compete/board?scope=c:clan");
    assert.equal(r.json.scope.kind, "community");
    assert.equal(r.json.scope.ladder, true);
    r = await request(t.base, "GET", "/api/presence/compete/servers");
    assert.equal(r.json.servers[0].community.slug, "clan");
    assert.equal(r.json.servers[0].unranked, false);
  });

  test("the join line's rating: a proven player's standing, told to everyone", async () => {
    const r = await call(t, "rating", { ids: [cid(t, "ann"), cid(t, "eve"), cid(t, "ben")] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.players[cid(t, "eve")], null);
    assert.equal(r.json.players[cid(t, "ann")].public, true);
    assert.equal(r.json.players[cid(t, "ben")].public, true, "no switch hides a rank");
    assert.ok(r.json.players[cid(t, "ann")].server.rank >= 1);
  });

  test("a deleted account stays in its matches as a deleted player", async () => {
    const m = t.app.db.prepare("SELECT match_id FROM compete_players WHERE account_id = ? ORDER BY match_id LIMIT 1").get(idOf(t, "cat")).match_id;
    const gone = idOf(t, "cat");
    if (typeof t.app.accounts.remove === "function") t.app.accounts.remove(gone);
    else t.app.db.prepare("DELETE FROM accounts WHERE id = ?").run(gone);
    const r = await request(t.base, "GET", "/api/presence/compete/match/" + m);
    assert.ok(r.json.players.some((p) => p.name === "a deleted player"));
  });
});

describe("compete: deathmatch, the pair cap, abandon and decay", () => {
  let t;
  before(async () => {
    t = await app({ compete: { pairKillsPerDay: 2 } });
    for (const n of ["dee", "fay", "gus"]) await signup(t.base, n);
    await present(t, [["dee", 1, DEV(1)], ["fay", 2, DEV(2)], ["gus", 3, DEV(3)]]);
  });
  after(() => t.close());

  test("a deathmatch map: kills only, places by frags minus deaths", async () => {
    const m = await start(t, "dm", [[cid(t, "dee"), 0], [cid(t, "fay"), 0], [cid(t, "gus"), 0]]);
    const k = (a, b) => [cid(t, a), cid(t, b), 0, 0];
    await call(t, "kills", { match: m, seq: 1, kills: [k("dee", "fay"), k("dee", "gus"), k("gus", "fay")] });
    const r = await call(t, "end", { match: m, result: { how: "finished" }, players: [[cid(t, "dee"), 0, 0, 600, 0], [cid(t, "fay"), 0, 0, 600, 0], [cid(t, "gus"), 0, 0, 600, 0]] });
    assert.equal(r.json.rated, false);
    const places = t.app.db.prepare("SELECT account_id, place FROM compete_players WHERE match_id = ? ORDER BY place").all(m);
    assert.deepEqual(places.map((p) => p.account_id), [idOf(t, "dee"), idOf(t, "gus"), idOf(t, "fay")]);
    assert.equal(elo(t, S, "dee", "dm"), 1002);
    assert.equal(elo(t, S, "dee", "match"), null);
  });

  test("past pairKillsPerDay one account's kills on another are kept and rate nothing", async () => {
    const m = await start(t, "dm", []);
    const k = [cid(t, "fay"), cid(t, "gus"), 0, 0];
    const r = await call(t, "kills", { match: m, seq: 1, kills: [k, k, k] });
    assert.equal(r.json.counted, 3);
    assert.equal(elo(t, S, "fay", "dm"), 1000 - 2 + 2); // two rated kills; the third rates nothing
    const p = t.app.db.prepare("SELECT kills FROM compete_players WHERE match_id = ? AND account_id = ?").get(m, idOf(t, "fay"));
    assert.equal(p.kills, 3);
  });

  test("a match nobody hears of for six hours is abandoned; 30 idle days cost 10 a day, once", async () => {
    t.advance(7 * 3600);
    let s = t.p.compete.sweep(t.sec());
    assert.ok(s.abandoned >= 1);
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_matches WHERE status = 'open'").get().n, 0);
    const was = elo(t, S, "dee", "dm");
    t.advance(35 * 86400);
    s = t.p.compete.sweep(t.sec());
    assert.ok(s.decayed >= 1);
    const after1 = elo(t, S, "dee", "dm");
    assert.ok(was - after1 >= 40 && was - after1 <= 60, "about 5 days past the 30: " + (was - after1));
    t.p.compete.sweep(t.sec());
    assert.equal(elo(t, S, "dee", "dm"), after1, "the same day twice decays once");
    t.advance(86400);
    t.p.compete.sweep(t.sec());
    assert.equal(elo(t, S, "dee", "dm"), after1 - 10);
  });

  test("settings are checked", () => {
    assert.throws(() => competeSettings({ winPoints: -1 }));
    assert.throws(() => competeSettings({ limits: { callsPerServer: { max: 0 } } }));
    assert.equal(competeSettings({}).startElo, 1000);
  });
});

describe("compete: account levels Lv 0-99 from the H9 ladder", () => {
  let t;
  let admin;
  before(async () => {
    t = await app();
    for (const n of ["hal", "ivy", "jon", "kim", "lee"]) await signup(t.base, n);
    admin = await signup(t.base, "overseer");
    t.app.accounts.setRole(idOf(t, "overseer"), "admin");
  });
  after(() => t.close());

  const level = (name) => t.p.compete.levelOf(idOf(t, name));
  const four = ["hal", "ivy", "jon", "kim"];
  async function ratedMatch(winners, losers, kills = []) {
    const dev = (n) => DEV(["hal", "ivy", "jon", "kim", "lee"].indexOf(n) + 1);
    await present(t, [...winners, ...losers].map((n, i) => [n, i + 1, dev(n)]));
    const m = await start(t, "match", [...winners.map((n) => [cid(t, n), 1]), ...losers.map((n) => [cid(t, n), 2])]);
    if (kills.length) await call(t, "kills", { match: m, seq: 1, kills: kills.map(([a, b]) => [cid(t, a), cid(t, b), 0, 0]) });
    t.advance(400);
    await present(t, [...winners, ...losers].map((n, i) => [n, i + 1, dev(n)]));
    const r = await call(t, "end", { match: m, result: { how: "finished", winner: 1, rounds: 5 },
      players: [...winners.map((n) => [cid(t, n), 1, 5, 400, 0]), ...losers.map((n) => [cid(t, n), 2, 5, 400, 0])] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.rated, true, r.json.why);
    return m;
  }

  test("the level is the career's: Lv 0 with no experience, then Lv 1 + (xp / xpBase) ^ (1 / xpPower)", async () => {
    assert.equal(level("hal"), 0);
    await ratedMatch(["hal", "ivy"], ["jon", "kim"]);
    assert.equal(xpOf(t, "hal"), 165, "won at 1100: (100 + 50) x 1 x 1.1");
    assert.equal(level("hal"), lvXp(165));
    assert.equal(xpOf(t, "jon"), 93, "lost at 930: 100 x 1 x 0.93");
    assert.equal(level("jon"), lvXp(93));
    assert.equal(level("lee"), 0, "an account that never played");
  });
  test("the report answer gives each proven player's level, and nothing for anyone unproven; Lv 0 only with showZero", async () => {
    const report = async () => {
      t.advance(1);
      const players = [["hal", 3, DEV(1)], ["lee", 4, DEV(5)], ["jon", 5, null]].map(([name, slot, device]) => {
        const pid = t.app.accounts.playerId(t.app.accounts.getByUsername(name));
        const e = { id: cid(t, name), slot, name, joined: t.sec() - 5, time: 5 };
        if (device) {
          const nonce = randomHex(16);
          t.app.db.prepare("INSERT OR IGNORE INTO presence_proof_nonces (nonce, server, issued_at) VALUES (?, ?, ?)").run(nonce, LISTED, t.sec());
          const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
          const dm = Buffer.from(device, "hex");
          for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
          const devmask = dm.toString("hex");
          Object.assign(e, { nonce, devmask, proof: hmacHex(pid, "h9proof1:" + nonce + ":" + LISTED + ":" + devmask) });
        }
        return e;
      });
      const body = JSON.stringify({ v: 1, server: LISTED, ts: t.sec(), map: "h9_te_neuropolis", mode: "Team Elimination", players });
      const r = await request(t.base, "POST", "/api/presence/report", { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(LISTED_KEY, body) } });
      assert.equal(r.status, 200, r.text);
      return r.json.levels;
    };
    // showZero on, the default: an account with no rated match shows as Lv 0
    let levels = await report();
    assert.equal(levels["3"], level("hal"));
    assert.equal(levels["4"], 0, "an account with no rated match: Lv 0 while showZero is on");
    assert.equal(levels["5"], undefined, "unproven: no level");
    // showZero off: it shows nothing; unproven still nothing
    let r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { showZero: false } });
    assert.equal(r.status, 200, r.text);
    levels = await report();
    assert.equal(levels["3"], level("hal"));
    assert.equal(levels["4"], undefined, "an account with no rated match: nothing with showZero off");
    assert.equal(levels["5"], undefined, "unproven: no level");
    // and back to the default for the tests after this one
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { showZero: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await report())["4"], 0);
  });

  test("the career: matches, wins and KDA times the rating, and each kill; the admins' curve; it only rises", async () => {
    let r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: await signup(t.base, "plainuser"), body: { xpBase: 10 } });
    assert.equal(r.status, 403);
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { xpPower: 9 } });
    assert.equal(r.status, 400, "the curve's power is 1 to 5");
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { xpBase: 10, xpPower: 2, rule: "elo" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.settings.rule, undefined, "no rule to pick: the level is always the career's");
    assert.equal(level("hal"), lvXp(165, 10, 2));
    // a lost match still adds experience; each kill adds killXp, 1
    const before = level("hal");
    const m = await ratedMatch(["jon", "kim"], ["hal", "ivy"], [["jon", "hal"], ["jon", "hal"]]);
    assert.ok(level("hal") >= before, "a career only rises");
    assert.ok(xpOf(t, "jon") > 93 + 2);
    assert.equal(t.app.db.prepare("SELECT xp FROM compete_xp WHERE match_id = ? AND account_id = ?").get(m, idOf(t, "jon")).xp > 2, true);
    // a void takes that match's experience back, its kills' with it
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/void", { cookie: admin, body: { note: "test" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(xpOf(t, "jon"), 93);
    r = await request(t.base, "GET", "/api/presence/compete/levels", { cookie: admin });
    assert.deepEqual([r.json.settings.xpBase, r.json.settings.xpPower], [10, 2]);
    assert.deepEqual([r.json.defaults.xpBase, r.json.defaults.xpPower, r.json.defaults.killXp], [20, 2.3, 1]);
    assert.deepEqual(r.json.estimate.levels.map((e) => e.level), [10, 25, 50, 75, 99]);
    const board = await request(t.base, "GET", "/api/presence/compete/board?scope=network");
    assert.equal(board.json.players.find((p) => p.username === "hal").level, level("hal"));
    // back to the default curve
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { xpBase: 20, xpPower: 2.3 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(level("hal"), lvXp(xpOf(t, "hal")));
  });

  test("the estimate: hours of a typical active hour to Lv 10, 25, 50, 75 and 99 at the default curve", async () => {
    const r = await request(t.base, "GET", "/api/presence/compete/levels", { cookie: admin });
    const e = r.json.estimate;
    assert.equal(e.typical.xpPerHour, Math.round(3 * (100 + 0.25 * 50) + 40 * 1));
    const hours = Object.fromEntries(e.levels.map((x) => [x.level, x.hours]));
    assert.ok(hours[10] >= 5 && hours[10] <= 12, "a few evenings: " + hours[10]);
    assert.ok(hours[50] >= 300 && hours[50] <= 500, "months: " + hours[50]);
    assert.ok(hours[99] >= 1800 && hours[99] <= 2200, "years: " + hours[99]);
    assert.equal(e.levels[0].xp, Math.ceil(20 * Math.pow(9, 2.3)));
  });
});

describe("compete: the level beside a name on the site and in game", () => {
  let t;
  let admin;
  before(async () => {
    t = await app();
    for (const n of ["mia", "ned", "oli", "pam", "quin"]) await signup(t.base, n);
    admin = await signup(t.base, "warden");
    t.app.accounts.setRole(idOf(t, "warden"), "admin");
    let r;
    const dev = (n) => DEV(["mia", "ned", "oli", "pam", "quin"].indexOf(n) + 1);
    const four = [["mia", 1], ["ned", 1], ["oli", 2], ["pam", 2]];
    await present(t, [...four.map(([n], i) => [n, i + 1, dev(n)]), ["quin", 5, dev("quin")]]);
    const m = await start(t, "match", four.map(([n, s]) => [cid(t, n), s]));
    t.advance(400);
    await present(t, [...four.map(([n], i) => [n, i + 1, dev(n)]), ["quin", 5, dev("quin")]]);
    r = await call(t, "end", { match: m, result: { how: "finished", winner: 1, rounds: 5 }, players: four.map(([n, s]) => [cid(t, n), s, 5, 400, 0]) });
    assert.equal(r.json.rated, true, r.json.why);
  });
  after(() => t.close());

  const lv1100 = lvXp(165); // a winner's career level after one rated match: 165 XP
  const login = async (name) => (await request(t.base, "POST", "/api/login", { body: { username: name, password: "correct horse battery staple" } })).cookie;

  test("the presence views carry the level; an account with no rated match shows Lv 0 by default", async () => {
    let r = await request(t.base, "GET", "/api/presence/accounts?u=mia,quin");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.accounts.mia.level, lv1100);
    assert.equal(r.json.accounts.quin.level, 0, "Lv 0 shows unless the admins turn it off");
    r = await request(t.base, "GET", "/api/presence/account/mia");
    assert.equal(r.json.level, lv1100);
  });

  test("SHOW MY PLAYTIME hides no level: others see it, on the card and in the batch, and so does the game", async () => {
    const cookie = await login("ned");
    assert.equal((await request(t.base, "POST", "/api/presence/settings", { cookie, body: { playtime: false } })).status, 200);
    let r = await request(t.base, "GET", "/api/presence/account/ned");
    assert.equal(r.json.level, lv1100);
    assert.equal(r.json.elo, 1100, "and the ELO figure beside it");
    assert.equal(r.json.playtimeSeconds, null, "the playtime is what it hides");
    r = await request(t.base, "GET", "/api/presence/accounts?u=ned");
    assert.deepEqual([r.json.accounts.ned.level, r.json.accounts.ned.elo], [lv1100, 1100]);
    r = await request(t.base, "GET", "/api/presence/me", { cookie });
    assert.equal(r.json.level, lv1100);
  });
  test("the game gets the same: every proven player's level, Lv 0 shown, and left out once showZero is off", async () => {
    const report = async () => {
      t.advance(1);
      const players = [["mia", 1], ["ned", 2], ["quin", 5]].map(([name, slot]) => {
        const pid = t.app.accounts.playerId(t.app.accounts.getByUsername(name));
        const e = { id: cid(t, name), slot, name, joined: t.sec() - 5, time: 5 };
        const nonce = randomHex(16);
        t.app.db.prepare("INSERT OR IGNORE INTO presence_proof_nonces (nonce, server, issued_at) VALUES (?, ?, ?)").run(nonce, LISTED, t.sec());
        const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
        const dm = Buffer.from(DEV(["mia", "ned", "oli", "pam", "quin"].indexOf(name) + 1), "hex");
        for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
        const devmask = dm.toString("hex");
        return { ...e, nonce, devmask, proof: hmacHex(pid, "h9proof1:" + nonce + ":" + LISTED + ":" + devmask) };
      });
      const body = JSON.stringify({ v: 1, server: LISTED, ts: t.sec(), map: "h9_te_neuropolis", mode: "Team Elimination", players });
      const r = await request(t.base, "POST", "/api/presence/report", { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(LISTED_KEY, body) } });
      assert.equal(r.status, 200, r.text);
      return r.json.levels;
    };
    let levels = await report();
    assert.equal(levels["1"], lv1100);
    assert.equal(levels["2"], lv1100, "ned hides his playtime, not his level");
    assert.equal(levels["5"], 0, "quin has no experience: Lv 0, by default");
    let r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { showZero: "maybe" } });
    assert.equal(r.status, 400);
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { showZero: false } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.settings.showZero, false);
    levels = await report();
    assert.equal(levels["5"], undefined, "with showZero off, Lv 0 shows nothing in game");
    assert.equal(levels["1"], lv1100, "and the rated still show");
    r = await request(t.base, "GET", "/api/presence/accounts?u=quin");
    assert.equal(r.json.accounts.quin.level, null, "nor on the site");
  });
});

describe("compete: bots and unproven players count for nothing", () => {
  let t;
  let admin;
  before(async () => {
    t = await app();
    for (const n of ["rho", "sig", "tau"]) await signup(t.base, n);
    admin = await signup(t.base, "marshal");
    t.app.accounts.setRole(idOf(t, "marshal"), "admin");
    // rho and sig proven; tau an account whose game proves nothing
    await present(t, [["rho", 1, DEV(1)], ["sig", 2, DEV(2)], ["tau", 3, null]]);
  });
  after(() => t.close());

  const N = "n";
  const both = (name) => [elo(t, S, name), elo(t, N, name)];
  const stats = (m, name) => ({ ...t.app.db.prepare("SELECT kills, deaths FROM compete_players WHERE match_id = ? AND account_id = ?").get(m, idOf(t, name)) });
  const BOT = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"; // an h9_clientid no account has, as a bot would send if any

  test("a kill of a bot, and a death to one, move nothing in any table, and no kills-to-deaths figure", async () => {
    const m = await start(t, "match", [[cid(t, "rho"), 1], [cid(t, "sig"), 2]]);
    const r = await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "rho"), BOT, 1, 0], [BOT, cid(t, "rho"), 0, 0], [BOT, cid(t, "sig"), 1, 0]] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.counted, r.json.unrated], [0, 3]);
    assert.deepEqual(both("rho"), [null, null], "no rating made at all");
    assert.deepEqual(both("sig"), [null, null]);
    assert.deepEqual(stats(m, "rho"), { kills: 0, deaths: 0 });
  });

  test("an unproven human's kills of or by a proven player move nothing", async () => {
    const m = t.app.db.prepare("SELECT id, seq FROM compete_matches WHERE status = 'open'").get();
    const r = await call(t, "kills", { match: m.id, seq: m.seq + 1, kills: [[cid(t, "rho"), cid(t, "tau"), 1, 0], [cid(t, "tau"), cid(t, "sig"), 0, 0]] });
    assert.deepEqual([r.json.counted, r.json.unrated], [0, 2]);
    assert.deepEqual(both("rho"), [null, null]);
    assert.equal(elo(t, S, "tau"), null);
    assert.deepEqual(stats(m.id, "rho"), { kills: 0, deaths: 0 });
  });

  test("a match with bots at its start or its end is not rated: no result, only each player's experience for playing it out", async () => {
    const xp = () => t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_xp").get().n;
    for (const [startBots, endBots] of [[1, 0], [0, 2]]) {
      await present(t, [["rho", 1, DEV(1)], ["sig", 2, DEV(2)]]);
      const s = await call(t, "start", { ladder: "match", map: "h9_te_neuropolis", mode: "Team Elimination", humans: 2, bots: startBots, players: [[cid(t, "rho"), 1], [cid(t, "sig"), 2]] });
      assert.equal(s.status, 200, s.text);
      t.advance(400);
      await present(t, [["rho", 1, DEV(1)], ["sig", 2, DEV(2)]]);
      const r = await call(t, "end", { match: s.json.match, result: { how: "finished", winner: 1, rounds: 5 }, bots: endBots,
        players: [[cid(t, "rho"), 1, 5, 400, 0], [cid(t, "sig"), 2, 5, 400, 0]] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.rated, false);
      assert.match(r.json.why, /bots played/);
    }
    assert.equal(xp(), 4, "the experience for playing each of the two out, the two of them");
    const own = t.app.db.prepare("SELECT xp FROM compete_xp WHERE account_id = ? ORDER BY match_id").all(idOf(t, "rho")).map((r) => r.xp);
    assert.deepEqual(own, [100, 100], "matchXp, with no win in it: no result was rated");
    assert.deepEqual(both("rho"), [null, null], "and no win counted");
    assert.equal(t.p.compete.levelOf(idOf(t, "rho")), lvXp(200), "the career's level from that experience");
  });
});

describe("compete: resetting the competitive season", () => {
  let t;
  let admin;
  before(async () => {
    t = await app();
    for (const n of ["uma", "vic", "xan", "yul"]) await signup(t.base, n);
    admin = await signup(t.base, "steward");
    t.app.accounts.setRole(idOf(t, "steward"), "admin");
  });
  after(() => t.close());

  // two a side, as the H9 ladder wants: uma and xan against vic and yul
  const sides = [["uma", 1], ["xan", 1], ["vic", 2], ["yul", 2]];
  async function rated() {
    const here = () => present(t, sides.map(([n], i) => [n, i + 1, DEV(i + 1)]));
    await here();
    const m = await start(t, "match", sides.map(([n, s]) => [cid(t, n), s]));
    t.advance(400);
    await here();
    const r = await call(t, "end", { match: m, result: { how: "finished", winner: 1, rounds: 5 }, players: sides.map(([n, s]) => [cid(t, n), s, 5, 400, 0]) });
    assert.equal(r.json.rated, true, r.json.why);
    return m;
  }
  const count = (table) => t.app.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;

  test("only a site admin, and only typed RESET", async () => {
    let r = await request(t.base, "POST", "/api/presence/compete/season/reset", { cookie: await signup(t.base, "wes"), body: { confirm: "RESET" } });
    assert.equal(r.status, 403);
    r = await request(t.base, "POST", "/api/presence/compete/season/reset", { cookie: admin, body: { confirm: "reset" } });
    assert.equal(r.status, 400);
  });

  test("a reset copies the database first, archives the standings, and leaves everyone unrated; the career stays", async () => {
    const old = await rated();
    assert.equal(elo(t, "n", "uma"), 1100);
    const career = t.p.compete.levelOf(idOf(t, "uma"));
    assert.ok(career > 0);
    let r = await request(t.base, "GET", "/api/presence/compete/seasons");
    assert.equal(r.json.current.number, 1);
    r = await request(t.base, "POST", "/api/presence/compete/season/reset", { cookie: admin, body: { confirm: "RESET" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ended, 1);
    assert.equal(r.json.season.number, 2);
    assert.ok(fs.existsSync(path.join(t.config.dataDir, "backups", r.json.backup)), "the copy made before the reset");
    assert.equal(count("compete_ratings"), 0);
    assert.ok(count("compete_xp") > 0, "the career's experience is the account's, over every season");
    assert.equal(t.p.compete.levelOf(idOf(t, "uma")), career, "the career level stays: it is the account's");
    assert.equal(t.p.compete.publicLevel(idOf(t, "uma")), career);
    const audit = t.app.db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.action, "presence.compete.season.reset");
    // this season's table is empty; season 1's final standings stay readable
    r = await request(t.base, "GET", "/api/presence/compete/board?scope=network");
    assert.equal(r.json.season.number, 2);
    assert.equal(r.json.players.length, 0);
    r = await request(t.base, "GET", "/api/presence/compete/board?scope=network&season=1");
    assert.equal(r.json.season.number, 1);
    assert.ok(r.json.season.ended);
    assert.deepEqual(r.json.players.map((p) => [p.rank, p.elo]), [[1, 1100], [2, 1100], [3, 930], [4, 930]]);
    assert.deepEqual(r.json.players.slice(0, 2).map((p) => p.username).sort(), ["uma", "xan"]);
    r = await request(t.base, "GET", "/api/presence/compete/seasons");
    assert.equal(r.json.current.number, 2);
    assert.deepEqual(r.json.past.map((s) => s.number), [1]);
    // the next rated match starts from the normal start, not from 0
    await rated();
    assert.equal(elo(t, "n", "uma"), 1100);
    assert.equal(elo(t, "n", "vic"), 930);
    assert.equal(t.app.db.prepare("SELECT season FROM compete_matches ORDER BY id DESC LIMIT 1").get().season, 2);
    // a void of last season's match takes nothing from this one
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + old + "/void", { cookie: admin, body: { note: "old" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(elo(t, "n", "uma"), 1100);
    assert.equal(r.json.status, "voided");
  });
});

describe("compete: an account's rank, on the site and from a game's .rank", () => {
  let t;
  let admin;
  const names = ["ash", "bea", "cyd", "dov", "eli"];
  const dev = (n) => DEV(names.indexOf(n) + 1);
  const four = [["ash", 1], ["bea", 1], ["cyd", 2], ["dov", 2]];
  // everyone in game here, proven, and fox, an account whose game proves nothing
  const here = () => present(t, [...names.map((n, i) => [n, i + 1, dev(n)]), ["fox", 6, null]]);
  const login = async (name) => (await request(t.base, "POST", "/api/login", { body: { username: name, password: "correct horse battery staple" } })).cookie;
  const hide = async (name) => {
    const r = await request(t.base, "POST", "/api/presence/settings", { cookie: await login(name), body: { playtime: false } });
    assert.equal(r.status, 200, r.text);
  };
  before(async () => {
    t = await app();
    for (const n of [...names, "fox"]) await signup(t.base, n);
    admin = await signup(t.base, "steward");
    t.app.accounts.setRole(idOf(t, "steward"), "admin");
    let r;
    await here();
    const m = await start(t, "match", four.map(([n, s]) => [cid(t, n), s]));
    // ash: two kills (one a headshot) and one death; cyd: one kill, one death; dov: one death
    r = await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "ash"), cid(t, "cyd"), 1, 0], [cid(t, "ash"), cid(t, "dov"), 0, 0], [cid(t, "cyd"), cid(t, "ash"), 0, 0]] });
    assert.equal(r.json.counted, 3, r.text);
    t.advance(400);
    await here();
    r = await call(t, "end", { match: m, result: { how: "finished", winner: 1, rounds: 5 }, players: four.map(([n, s]) => [cid(t, n), s, 5, 400, 0]) });
    assert.equal(r.json.rated, true, r.json.why);
  });
  after(() => t.close());


  test("GET rank: the level, the rule, the season, and each table with its place and numbers", async () => {
    let r = await request(t.base, "GET", "/api/presence/compete/rank/ASH");
    assert.equal(r.status, 200, r.text);
    const a = r.json;
    assert.equal(a.username, "ash");
    assert.equal(a.private, false);
    assert.deepEqual([a.rule, a.xp, a.season.number], ["career", xpOf(t, "ash"), 1]);
    assert.equal(a.level, lvXp(xpOf(t, "ash")));
    assert.equal(a.elo, elo(t, "n", "ash"), "the H9 ladder's MATCH rating, the ELO figure");
    assert.deepEqual(a.ladders.map((l) => [l.kind, l.ladder]), [["network", "match"], ["server", "match"]], "the H9 ladder first");
    const h9 = a.ladders[0];
    assert.equal(h9.elo, elo(t, "n", "ash"));
    assert.deepEqual([h9.place, h9.matches, h9.wins, h9.losses, h9.kills, h9.deaths, h9.headshots, h9.assists, h9.kd], [1, 1, 1, 0, 2, 1, 1, null, 2]);
    assert.equal(a.ladders[1].elo, elo(t, S, "ash"));
    assert.match(String(r.headers["cache-control"] || ""), /^public/, "the same for everyone: cacheable");
    r = await request(t.base, "GET", "/api/presence/compete/rank/dov");
    const d = r.json.ladders[0];
    assert.deepEqual([d.place, d.wins, d.losses, d.kills, d.deaths, d.kd], [4, 0, 1, 0, 1, 0]);
    r = await request(t.base, "GET", "/api/presence/compete/rank/eli");
    assert.deepEqual([r.json.level, r.json.ladders, r.json.elo], [0, [], null], "no experience: Lv 0, no table and no ELO yet");
    r = await request(t.base, "GET", "/api/presence/compete/rank/nobody-at-all");
    assert.equal(r.status, 404);
  });

  test("GET rank: SHOW MY PLAYTIME hides nothing of a rank, to anyone", async () => {
    await hide("bea");
    let r = await request(t.base, "GET", "/api/presence/compete/rank/bea");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.private, false);
    assert.deepEqual([r.json.ladders[0].kind, r.json.ladders[0].wins, r.json.ladders[0].place], ["network", 1, 2], "ash is above");
    assert.match(String(r.headers["cache-control"] || ""), /^public/, "the same for everyone: cacheable");
    r = await request(t.base, "GET", "/api/presence/compete/rank/bea", { cookie: await signup(t.base, "stranger") });
    assert.equal(r.json.ladders[0].wins, 1);
  });
  test("the RANK block rides on the card and the ACCOUNT page's view, not the batch, for every account", async () => {
    let r = await request(t.base, "GET", "/api/presence/account/ash");
    const rk = r.json.rank;
    assert.deepEqual([rk.season.number, rk.rule, rk.xp, rk.level], [1, "career", xpOf(t, "ash"), r.json.level]);
    assert.deepEqual([rk.h9.elo, rk.h9.place, rk.h9.matches, rk.h9.wins, rk.h9.losses, rk.h9.kills, rk.h9.deaths, rk.h9.kd], [elo(t, "n", "ash"), 1, 1, 1, 0, 2, 1, 2]);
    r = await request(t.base, "GET", "/api/presence/accounts?u=ash");
    assert.equal("rank" in r.json.accounts.ash, false, "the batch read leaves it out");
    r = await request(t.base, "GET", "/api/presence/account/eli");
    assert.deepEqual([r.json.rank.level, r.json.rank.h9], [0, null], "no rated match: Lv 0 and nothing on the table");
    await hide("cyd");
    r = await request(t.base, "GET", "/api/presence/account/cyd");
    assert.deepEqual([r.json.rank.h9.losses, r.json.rank.h9.kills, r.json.rank.level], [1, 1, lvXp(xpOf(t, "cyd"))], "SHOW MY PLAYTIME hides no rank");
    r = await request(t.base, "GET", "/api/presence/me", { cookie: await login("cyd") });
    assert.equal(r.json.rank.level, lvXp(xpOf(t, "cyd")));
  });

  test("a game's .rank: the asker's own, a player here, an account by name; not signed in", async () => {
    await here();
    let r = await call(t, "rank", { asker: cid(t, "ash"), id: cid(t, "ash") });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.account.username, "ash");
    assert.deepEqual(r.json.account.ladders.map((l) => [l.kind, l.ladder, l.kills]), [["network", "match", 2], ["server", "match", 2]], "the H9 ladder and this server's");
    // fox's game proves nothing here, and an id no account has: not signed in
    r = await call(t, "rank", { asker: cid(t, "ash"), id: cid(t, "fox") });
    assert.deepEqual([r.status, r.json.account], [200, null]);
    r = await call(t, "rank", { asker: cid(t, "ash"), id: "ab".repeat(16) });
    assert.equal(r.json.account, null);
    // by name, any case; a name that is no account
    r = await call(t, "rank", { asker: cid(t, "ash"), name: "ELI" });
    assert.deepEqual([r.json.account.username, r.json.account.level, r.json.account.ladders], ["eli", 0, []]);
    r = await call(t, "rank", { asker: cid(t, "ash"), name: "nobody-at-all" });
    assert.deepEqual([r.json.account, r.json.unknown], [null, true]);
    // dov hides his playtime: his rank answers anyone, an asker whose game proves nothing too
    await hide("dov");
    r = await call(t, "rank", { asker: cid(t, "ash"), id: cid(t, "dov") });
    assert.deepEqual([r.json.account.private, r.json.account.ladders[0].losses], [false, 1]);
    r = await call(t, "rank", { asker: cid(t, "fox"), name: "Dov" });
    assert.deepEqual([r.json.account.username, r.json.account.level], ["dov", lvXp(xpOf(t, "dov"))]);
    // bad and forged calls
    r = await call(t, "rank", { asker: cid(t, "ash") });
    assert.equal(r.status, 400);
    r = await call(t, "rank", { asker: cid(t, "ash"), id: "not-an-id" });
    assert.equal(r.status, 400);
    const body = JSON.stringify({ v: 1, server: LISTED, ts: t.sec(), nonce: randomHex(8), asker: cid(t, "ash"), id: cid(t, "ash") });
    r = await request(t.base, "POST", "/api/presence/compete/rank", { body, origin: null, headers: { "x-h9-server": LISTED, "x-h9-signature": hmacHex(randomHex(32), body) } });
    assert.equal(r.status, 401);
  });

  test("GET rank is rate-limited per address", async () => {
    const t2 = await app({ limits: { readPerIp: { max: 3, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 30 } } });
    try {
      await signup(t2.base, "solo");
      for (let i = 0; i < 3; i++) assert.equal((await request(t2.base, "GET", "/api/presence/compete/rank/solo")).status, 200);
      assert.equal((await request(t2.base, "GET", "/api/presence/compete/rank/solo")).status, 429);
    } finally {
      await t2.close();
    }
  });
});

describe("compete: assists, from a server whose end report counts them", () => {
  let t;
  let admin;
  const names = ["gil", "hob", "ida", "jax"];
  const dev = (n) => DEV(names.indexOf(n) + 1);
  const four = [["gil", 1], ["hob", 1], ["ida", 2], ["jax", 2]];
  const here = () => present(t, names.map((n, i) => [n, i + 1, dev(n)]));
  const assists = (scope, name) => {
    const r = t.app.db.prepare("SELECT assists FROM compete_ratings WHERE scope = ? AND ladder = 'match' AND account_id = ?").get(scope, idOf(t, name));
    return r ? r.assists : undefined;
  };
  const inMatch = (m, name) => t.app.db.prepare("SELECT assists FROM compete_players WHERE match_id = ? AND account_id = ?").get(m, idOf(t, name)).assists;
  // a rated match, side 1 winning; each player's end entry with the assists given (undefined: none sent)
  async function play(counts) {
    await here();
    const m = await start(t, "match", four.map(([n, s]) => [cid(t, n), s]));
    let r = await call(t, "kills", { match: m, seq: 1, kills: [[cid(t, "gil"), cid(t, "ida"), 0, 0]] });
    assert.equal(r.status, 200, r.text);
    t.advance(400);
    await here();
    r = await call(t, "end", {
      match: m, result: { how: "finished", winner: 1, rounds: 5 },
      players: four.map(([n, s]) => (counts[n] === undefined ? [cid(t, n), s, 5, 400, 0] : [cid(t, n), s, 5, 400, 0, counts[n]])),
    });
    assert.equal(r.json.rated, true, r.json.why);
    return m;
  }
  before(async () => {
    t = await app();
    for (const n of names) await signup(t.base, n);
    admin = await signup(t.base, "bailiff");
    t.app.accounts.setRole(idOf(t, "bailiff"), "admin");
  });
  after(() => t.close());

  test("each player's assists go into the match and are summed into every table, as kills are; none sent stays null", async () => {
    const m = await play({ gil: 3, hob: 0, jax: 2, ida: undefined });
    assert.deepEqual(["gil", "hob", "ida", "jax"].map((n) => inMatch(m, n)), [3, 0, null, 2]);
    for (const scope of [S, "n"]) assert.deepEqual(["gil", "hob", "ida", "jax"].map((n) => assists(scope, n)), [3, 0, null, 2], scope);
    let r = await request(t.base, "GET", "/api/presence/compete/rank/gil");
    assert.equal(r.json.ladders[0].assists, 3);
    r = await request(t.base, "GET", "/api/presence/compete/rank/ida");
    assert.equal(r.json.ladders[0].assists, null, "a server that sends none: still null");
    r = await request(t.base, "GET", "/api/presence/compete/board?scope=network");
    assert.equal(r.json.players.find((p) => p.username === "gil").assists, 3);
    r = await request(t.base, "GET", "/api/presence/compete/match/" + m);
    assert.equal(r.json.players.find((p) => p.name === "jax").assists, 2);
    r = await request(t.base, "GET", "/api/presence/account/gil");
    assert.equal(r.json.rank.h9.assists, 3, "the RANK block's too");
  });

  test("a second match adds to the sum, and voiding it takes its assists back; a bad count is no count", async () => {
    const m2 = await play({ gil: 4, hob: "two", ida: 1, jax: -1 });
    assert.deepEqual(["gil", "hob", "ida", "jax"].map((n) => inMatch(m2, n)), [4, null, 1, null], "only whole numbers count");
    assert.deepEqual(["gil", "hob", "ida", "jax"].map((n) => assists("n", n)), [7, 0, 1, 2]);
    const r = await request(t.base, "POST", "/api/presence/compete/matches/" + m2 + "/void", { cookie: admin, body: { note: "a test match" } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(["gil", "hob", "ida", "jax"].map((n) => assists("n", n)), [3, 0, 0, 2], "the void takes back what the match added");
    assert.deepEqual(["gil", "hob"].map((n) => assists(S, n)), [3, 0]);
  });
});

describe("compete: an admin's rank adjustment, and the seasons back to season 1", () => {
  let t;
  let admin;
  let mod;
  const PASSWORD = "correct horse battery staple";
  const four = [["kai", 1], ["lou", 1], ["max", 2], ["nia", 2]];
  before(async () => {
    t = await app();
    for (const [n] of four) await signup(t.base, n);
    admin = await signup(t.base, "magistrate");
    t.app.accounts.setRole(idOf(t, "magistrate"), "admin");
    await signup(t.base, "colleague");
    t.app.accounts.setRole(idOf(t, "colleague"), "admin");
    mod = await signup(t.base, "monitor");
    t.app.accounts.setRole(idOf(t, "monitor"), "moderator");
    const here = () => present(t, four.map(([n], i) => [n, i + 1, DEV(i + 1)]));
    await here();
    const m = await start(t, "match", four.map(([n, s]) => [cid(t, n), s]));
    t.advance(400);
    await here();
    const r = await call(t, "end", { match: m, result: { how: "finished", winner: 1, rounds: 5 }, players: four.map(([n, s]) => [cid(t, n), s, 5, 400, 0]) });
    assert.equal(r.json.rated, true, r.json.why);
  });
  after(() => t.close());

  const view = (cookie, name = "kai") => request(t.base, "GET", "/api/presence/compete/accounts/" + name, { cookie });
  const adjust = (cookie, body, name = "kai") => request(t.base, "POST", "/api/presence/compete/accounts/" + name + "/adjust", { cookie, body });

  test("moderators see an account's whole rank; only an admin changes it, never their own or another admin's", async () => {
    let r = await view(mod);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.rank.username, "kai");
    assert.equal(r.json.xp.total, xpOf(t, "kai"));
    assert.equal(r.json.can.adjust, false, "a moderator looks only");
    assert.deepEqual(r.json.next, { level: r.json.rank.level + 1, xp: Math.ceil(20 * Math.pow(r.json.rank.level, 2.3)) });
    r = await view(admin);
    assert.equal(r.json.can.adjust, true);
    r = await view(await signup(t.base, "bystander"));
    assert.equal(r.status, 403);
    r = await view(mod, "bystander");
    assert.deepEqual([r.json.rank.level, r.json.xp.total, r.json.next], [0, 0, { level: 1, xp: 1 }], "no experience: Lv 0, and any at all makes Lv 1");
    r = await adjust(mod, { field: "xp", by: 100, note: "a gift", password: PASSWORD });
    assert.equal(r.status, 403);
    r = await adjust(admin, { field: "xp", by: 100, note: "mine", password: PASSWORD }, "magistrate");
    assert.equal(r.status, 403, "not on their own account");
    r = await adjust(admin, { field: "xp", by: 100, note: "theirs", password: PASSWORD }, "colleague");
    assert.equal(r.status, 403, "nor on another admin's");
  });

  test("a rating set or moved, the career's experience, with a note and the admin's password; audited; the level at once", async () => {
    let r = await adjust(admin, { field: "elo", set: 1500, note: "", password: PASSWORD });
    assert.equal(r.status, 400, "a note is needed");
    r = await adjust(admin, { field: "elo", set: 1500, by: 10, note: "both", password: PASSWORD });
    assert.equal(r.status, 400, "set or by, not both");
    r = await adjust(admin, { field: "elo", set: 1500, note: "a lost match restored", password: "not it at all" });
    assert.deepEqual([r.status, r.json.error], [403, "bad_password"]);
    r = await adjust(admin, { field: "elo", set: 1500, note: "a lost match restored", password: PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.before, r.json.after], [1100, 1500]);
    assert.equal(elo(t, "n", "kai"), 1500);
    r = await adjust(admin, { field: "elo", scope: "s:" + t.p.enrollment.serverIdFor(LISTED), ladder: "match", by: -50, note: "a farmed win", password: PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(elo(t, S, "kai"), 1050);
    const xp0 = xpOf(t, "kai");
    r = await adjust(admin, { field: "xp", by: 5000, note: "the old site's career", password: PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(xpOf(t, "kai"), xp0 + 5000);
    assert.equal(t.p.compete.levelOf(idOf(t, "kai")), lvXp(xp0 + 5000), "the level at once");
    r = await adjust(admin, { field: "xp", set: 0, note: "start again", password: PASSWORD });
    assert.equal(xpOf(t, "kai"), 0);
    assert.equal(t.p.compete.levelOf(idOf(t, "kai")), 0);
    r = await view(mod);
    assert.deepEqual(r.json.adjustments.map((a) => [a.field, a.before, a.after, a.by]).slice(0, 2), [["xp", xp0 + 5000, 0, "magistrate"], ["xp", xp0, xp0 + 5000, "magistrate"]]);
    assert.equal(r.json.adjustments[3].table, "H9 ladder");
    const trail = (await request(t.base, "GET", "/api/admin/accounts/kai", { cookie: admin })).json.audit;
    const rows = trail.filter((e) => e.action === "presence.compete.adjust");
    assert.equal(rows.length, 4, "every change is in the account's trail");
    assert.match(rows[rows.length - 1].detail, /H9 ladder MATCH rating 1100 -> 1500: a lost match restored/);
  });

  test("SEASONS BACK TO SEASON 1: the database copied first, typed SEASON 1, audited; the season under way is season 1", async () => {
    let r = await request(t.base, "POST", "/api/presence/compete/season/reset", { cookie: admin, body: { confirm: "RESET" } });
    assert.equal(r.json.season.number, 2);
    r = await request(t.base, "POST", "/api/presence/compete/season/restart", { cookie: mod, body: { confirm: "SEASON 1" } });
    assert.equal(r.status, 403);
    r = await request(t.base, "POST", "/api/presence/compete/season/restart", { cookie: admin, body: { confirm: "season 1" } });
    assert.equal(r.status, 400);
    r = await request(t.base, "POST", "/api/presence/compete/season/restart", { cookie: admin, body: { confirm: "SEASON 1" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.was, 2);
    assert.equal(r.json.season.number, 1);
    assert.ok(fs.existsSync(path.join(t.config.dataDir, "backups", r.json.backup)), "the copy made first");
    r = await request(t.base, "GET", "/api/presence/compete/seasons");
    assert.deepEqual([r.json.current.number, r.json.past], [1, []]);
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_season_standings").get().n, 0, "the archived standings go");
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM compete_matches WHERE season <> 1").get().n, 0, "every match is season 1's");
    const audit = t.app.db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.action, "presence.compete.season.restart");
  });
});

describe("compete: integrity, what the site holds a server to whatever its plugin says", () => {
  const names = ["ann", "ben", "cat", "dan"];
  const four = (t) => [[cid(t, "ann"), 1], [cid(t, "cat"), 1], [cid(t, "ben"), 2], [cid(t, "dan"), 2]];
  const present4 = (t) => present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)]]);
  async function fresh(compete = {}) {
    const t = await app({ compete });
    for (const n of names) await signup(t.base, n);
    await present4(t);
    return t;
  }
  const lastAudit = (t) => t.app.db.prepare("SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1").get();
  const matchRow = (t, m) => t.app.db.prepare("SELECT status, how, rated, kills, unrated_kills FROM compete_matches WHERE id = ?").get(m);
  const flip = (t, optedOut) => t.app.db.prepare("UPDATE presence_servers SET opted_out = ? WHERE server = ?").run(optedOut, LISTED);
  const kill = (t, killer = "ann", victim = "ben") => [cid(t, killer), cid(t, victim), 0, 0];
  const endFour = (t, m, rounds = 5, seconds = 400) => call(t, "end", {
    match: m, result: { how: "finished", winner: 1, rounds }, players: four(t).map(([id, side]) => [id, side, rounds, seconds, 0]),
  });

  test("a server that stops being authenticated mid-match loses the match: voided, its ratings and experience taken back", async () => {
    const t = await fresh();
    try {
      const m = await start(t, "match", four(t));
      let r = await call(t, "kills", { match: m, seq: 1, kills: [kill(t)] });
      assert.equal(r.json.counted, 1);
      assert.equal(elo(t, "n", "ann"), 1001);
      assert.ok(xpOf(t, "ann") > 0, "the kill gave experience");
      // its operator sets h9_authenticated 0, or it lists a plugin off the official list: the report says so, and the verdict follows
      flip(t, 1);
      r = await call(t, "kills", { match: m, seq: 2, kills: [kill(t)] });
      assert.deepEqual([r.status, r.json.error], [409, "not_rated"]);
      assert.match(r.text, /not authenticated/);
      assert.equal(matchRow(t, m).status, "voided");
      assert.equal(elo(t, "n", "ann"), 1000);
      assert.equal(elo(t, S, "ann"), 1000);
      assert.equal(elo(t, S, "ben"), 1000);
      assert.equal(xpOf(t, "ann"), 0, "the experience goes with it");
      assert.equal(lastAudit(t).action, "presence.compete.void");
      // the end of a match it is no longer rated for is refused the same way, and the match voided
      flip(t, 0);
      const m2 = await start(t, "match", four(t));
      flip(t, 1);
      r = await endFour(t, m2);
      assert.deepEqual([r.status, r.json.error], [409, "not_rated"]);
      assert.equal(matchRow(t, m2).status, "voided");
      // and its next start is refused, as it always was
      r = await call(t, "start", { ladder: "match", map: "h9_te_neuropolis", mode: "Team Elimination", humans: 2, bots: 0, players: [] });
      assert.deepEqual([r.status, r.json.error], [409, "not_rated"]);
    } finally {
      await t.close();
    }
  });

  test("a listen server (Create Game) rates nothing and gives no experience, unless listenRated allows it", async () => {
    const LISTEN = "203.0.113.20:27015";
    // an enrolled server whose key came from a player's proof (enroll.js), signing as h9_compete does
    const asListen = (t) => {
      const secret = Buffer.from(fs.readFileSync(path.join(t.config.dataDir, "modules", "presence", "enroll-key"), "utf8").trim(), "hex");
      const salt = randomHex(8);
      t.app.db.prepare("INSERT INTO presence_enrolled (server, server_id, live_salt, live_since, approved, listen, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)")
        .run(LISTEN, "listen" + randomHex(3), salt, t.sec(), t.sec());
      const key = crypto.createHmac("sha256", secret).update("srvkey1:" + LISTEN + ":" + salt).digest("hex");
      return (route, fields = {}) => {
        const body = JSON.stringify({ v: 1, server: LISTEN, ts: t.sec(), nonce: randomHex(8), ...fields });
        return request(t.base, "POST", "/api/presence/compete/" + route, { body, origin: null, headers: { "x-h9-server": LISTEN, "x-h9-signature": hmacHex(key, body) } });
      };
    };
    const begin = (as) => as("start", { ladder: "match", map: "h9_te_neuropolis", mode: "Team Elimination", humans: 0, bots: 0, players: [] });

    let t = await fresh();
    try {
      let r = await begin(asListen(t));
      assert.deepEqual([r.status, r.json.error], [409, "not_rated"]);
      assert.match(r.text, /listen server/);
      assert.equal(t.p.enrollment.isListen(LISTEN), true);
      assert.equal(t.p.enrollment.isListen(LISTED), false, "a server on servers.json with a hand-made key is never a listen server");
    } finally {
      await t.close();
    }
    t = await fresh({ listenRated: 1 });
    try {
      const r = await begin(asListen(t));
      assert.equal(r.status, 200, r.text);
    } finally {
      await t.close();
    }
  });

  test("a match cannot make more kills than the clock allows: the excess is not counted, and the audit log says so", async () => {
    const t = await fresh({ matchKillsPerMinute: 60, killBurst: 3, playerKillsPerMinute: 0 });
    try {
      const m = await start(t, "match", four(t));
      let r = await call(t, "kills", { match: m, seq: 1, kills: [kill(t), kill(t), kill(t), kill(t), kill(t)] });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.json.counted, r.json.unrated], [3, 2], "the burst, three, and no more at once");
      assert.equal(lastAudit(t).action, "presence.compete.kill_rate");
      assert.deepEqual([matchRow(t, m).kills, matchRow(t, m).unrated_kills], [3, 2]);
      // ten seconds of the match's own clock, a kill a second more
      t.advance(10);
      await present4(t);
      r = await call(t, "kills", { match: m, seq: 2, kills: [kill(t, "cat", "dan"), kill(t, "cat", "dan")] });
      assert.deepEqual([r.json.counted, r.json.unrated], [2, 0]);
    } finally {
      await t.close();
    }
  });

  test("no hand scores faster than playerKillsPerMinute in a match; another player's kills still count", async () => {
    const t = await fresh({ playerKillsPerMinute: 60, killBurst: 3, matchKillsPerMinute: 0 });
    try {
      const m = await start(t, "match", four(t));
      const r = await call(t, "kills", { match: m, seq: 1, kills: [kill(t), kill(t), kill(t), kill(t), kill(t), kill(t, "cat", "dan")] });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.json.counted, r.json.unrated], [4, 2], "three of ann's, and cat's one");
      assert.equal(elo(t, S, "ann"), 1003);
      assert.equal(elo(t, S, "cat"), 1001);
    } finally {
      await t.close();
    }
  });

  test("a match whose rounds ran faster than a round can be played is not rated; a player's seconds never exceed the match's", async () => {
    const t = await fresh();
    try {
      const m = await start(t, "match", four(t));
      t.advance(400);
      await present4(t);
      const r = await endFour(t, m, 100, 90000);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.rated, false);
      assert.match(r.json.why, /rounds ran faster/);
      assert.equal(elo(t, "n", "ann"), null, "nothing was rated");
      const seconds = t.app.db.prepare("SELECT MAX(seconds) AS s FROM compete_players WHERE match_id = ?").get(m).s;
      assert.ok(seconds > 0 && seconds <= 500, "90000 s claimed in a match of about 400: " + seconds);
    } finally {
      await t.close();
    }
  });

  test("an account earns at most xpPerDayMax experience and gains at most eloGainPerDayMax points on the H9 ladder in a UTC day", async () => {
    const t = await fresh({ xpPerDayMax: 200, eloGainPerDayMax: 150 });
    try {
      const play = async () => {
        const m = await start(t, "match", four(t));
        t.advance(400);
        await present4(t);
        const r = await endFour(t, m);
        assert.equal(r.json.rated, true, r.text);
      };
      await play();
      assert.equal(elo(t, "n", "ann"), 1100);
      assert.equal(xpOf(t, "ann"), 165, "(100 + 50) at a rating of 1100 / 1000");
      await play();
      assert.equal(elo(t, "n", "ann"), 1150, "only 50 of the day's 150 were left");
      assert.equal(xpOf(t, "ann"), 200);
      await play();
      assert.equal(elo(t, "n", "ann"), 1150, "the day's limit is reached");
      assert.equal(xpOf(t, "ann"), 200);
      assert.equal(elo(t, S, "ann"), 1300, "the server's own table has no daily limit");
      // the next UTC day starts afresh
      t.advance(86400);
      await present4(t);
      await play();
      assert.equal(elo(t, "n", "ann"), 1250);
      assert.ok(xpOf(t, "ann") > 200);
    } finally {
      await t.close();
    }
  });

  test("the integrity settings are checked; 0 turns a limit off", async () => {
    for (const bad of [{ listenRated: 2 }, { killBurst: -1 }, { xpPerDayMax: 1.5 }, { minRoundSeconds: 99999 }]) {
      assert.throws(() => competeSettings(bad), /compete\./);
    }
    const c = competeSettings({});
    assert.deepEqual([c.listenRated, c.matchKillsPerMinute, c.playerKillsPerMinute, c.killBurst, c.minRoundSeconds, c.xpPerDayMax, c.eloGainPerDayMax],
      [0, 120, 12, 40, 20, 6000, 1500]);
    const t = await fresh({ xpPerDayMax: 0, eloGainPerDayMax: 0, matchKillsPerMinute: 0, playerKillsPerMinute: 0, minRoundSeconds: 0 });
    try {
      const m = await start(t, "match", four(t));
      const r = await call(t, "kills", { match: m, seq: 1, kills: Array.from({ length: 30 }, () => kill(t)) });
      assert.equal(r.json.counted, 30, "with the rates off every kill the pair cap allows counts");
    } finally {
      await t.close();
    }
  });
});
