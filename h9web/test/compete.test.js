// Rated play (modules/presence/compete.js): compts's Elo per kill, match results, the three
// scopes, privacy, voids, disputes and decay. docs\H9_COMPETITIVE.txt is the guide.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
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

async function app({ compete = {} } = {}) {
  const t = await startApp({ limits: CORE_ROOMY }, { servers: [{ name: "HAVOC 9", address: LISTED }] });
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
    settings: { limits: roomy(), cacheSeconds: 0, compete },
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

async function start(t, ladder = "match", players = []) {
  const r = await call(t, "start", { ladder, map: "h9_te_neuropolis", mode: "Team Elimination", humans: players.length, bots: 0, players });
  assert.equal(r.status, 200, r.text);
  return r.json.match;
}

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

  test("NETWORK LADDER: a site admin's flag; the H9 ladder wants every player proven, two a side", async () => {
    let r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: await signup(t.base, "nobody"), body: { network: true } });
    assert.equal(r.status, 403);
    r = await request(t.base, "POST", "/api/presence/compete/servers/" + serverId(), { cookie: admin, body: { network: true } });
    assert.equal(r.status, 200, r.text);
    // one a side: the server's table counts it, the H9 ladder does not
    let m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "ben"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)], ["eve", 5, null]]);
    r = await end(m, { how: "finished", winner: 2, rounds: 5 }, [[cid(t, "ann"), 1, 5, 400, 0], [cid(t, "ben"), 2, 5, 400, 0]]);
    assert.equal(r.json.rated, true);
    assert.match(r.json.why, /network: the H9 ladder needs 2 proven players a side/);
    assert.equal(elo(t, "n", "ben"), null);
    // two a side, and an unproven player (eve, no proof) on one: still not on the H9 ladder
    m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "cat"), 1], [cid(t, "ben"), 2], [cid(t, "dan"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)], ["eve", 5, null]]);
    const four = [[cid(t, "ann"), 1, 5, 400, 0], [cid(t, "cat"), 1, 5, 400, 0], [cid(t, "ben"), 2, 5, 400, 0], [cid(t, "dan"), 2, 5, 400, 0]];
    r = await end(m, { how: "finished", winner: 1, rounds: 5 }, [...four, [cid(t, "eve"), 2, 5, 400, 0]]);
    assert.match(r.json.why, /every player must be proven/);
    assert.equal(elo(t, "n", "ann"), null);
    // all proven: counted on the H9 ladder too
    m = await start(t, "match", [[cid(t, "ann"), 1], [cid(t, "cat"), 1], [cid(t, "ben"), 2], [cid(t, "dan"), 2]]);
    t.advance(400);
    await present(t, [["ann", 1, DEV(1)], ["ben", 2, DEV(2)], ["cat", 3, DEV(3)], ["dan", 4, DEV(4)]]);
    r = await end(m, { how: "forfeit", winner: 1, rounds: 4 }, four);
    assert.equal(r.json.rated, true);
    assert.equal(r.json.why, null);
    assert.equal(elo(t, "n", "ann"), 1100);
    assert.equal(elo(t, "n", "dan"), 930);
    assert.equal(r.json.changes[cid(t, "dan")].network, -70);
  });

  test("the boards, the player's page and the match page follow the privacy switches", async () => {
    let r = await request(t.base, "GET", "/api/presence/compete/board?scope=s:" + serverId());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scope.kind, "server");
    const names = r.json.players.map((p) => p.username);
    assert.ok(names.includes("ann") && names.includes("ben"));
    assert.equal(r.json.players[0].rank, 1);
    // ben hides his numbers: off the board, the ranks close up
    const cookie = (await request(t.base, "POST", "/api/login", { body: { username: "ben", password: "correct horse battery staple" } })).cookie;
    assert.equal((await request(t.base, "POST", "/api/presence/settings", { cookie, body: { playtime: false, where: false } })).status, 200);
    r = await request(t.base, "GET", "/api/presence/compete/board?scope=network");
    assert.ok(!r.json.players.some((p) => p.username === "ben"));
    assert.deepEqual(r.json.players.map((p) => p.rank), r.json.players.map((_, i) => i + 1));
    r = await request(t.base, "GET", "/api/presence/compete/player/ben");
    assert.equal(r.json.ratings, null);
    assert.equal(r.json.matches, null);
    r = await request(t.base, "GET", "/api/presence/compete/me", { cookie });
    assert.ok(r.json.ratings.length >= 1 && r.json.matches.length >= 1, "a player sees all of their own");
    const m = r.json.matches[0].id;
    r = await request(t.base, "GET", "/api/presence/compete/match/" + m);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.players.some((p) => p.name === "a hidden player"));
    assert.ok(!r.json.players.some((p) => p.name === "ben"));
    r = await request(t.base, "GET", "/api/presence/compete/player/ann");
    assert.ok(r.json.ratings.some((x) => x.kind === "network" && x.elo === 1100));
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
    assert.equal(r.json.servers[0].network, true);
  });

  test("say /rank: a proven player's standing, and whether others may be told", async () => {
    const r = await call(t, "rating", { ids: [cid(t, "ann"), cid(t, "eve"), cid(t, "ben")] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.players[cid(t, "eve")], null);
    assert.equal(r.json.players[cid(t, "ann")].public, true);
    assert.equal(r.json.players[cid(t, "ben")].public, false);
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
    const r = await request(t.base, "POST", "/api/presence/compete/servers/" + t.p.enrollment.serverIdFor(LISTED), { cookie: admin, body: { network: true } });
    assert.equal(r.status, 200, r.text);
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

  test("no rated match on the H9 ladder is Lv 0; the ELO rule follows the rating up and down", async () => {
    assert.equal(level("hal"), 0);
    await ratedMatch(["hal", "ivy"], ["jon", "kim"]);
    assert.equal(level("hal"), Math.floor((1100 - 800) / 20) + 1);
    assert.equal(level("jon"), Math.floor((930 - 800) / 20) + 1);
    assert.equal(level("lee"), 0, "an account that never played");
  });

  test("the report answer gives each proven player's level, and nothing for anyone unproven", async () => {
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
    assert.equal(r.json.levels["3"], level("hal"));
    assert.equal(r.json.levels["4"], 0, "an account with no rated match: Lv 0");
    assert.equal(r.json.levels["5"], undefined, "unproven: no level");
  });

  test("the career rule: experience from rated matches, wins and KDA times the rating; it only rises", async () => {
    let r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: await signup(t.base, "plainuser"), body: { rule: "career" } });
    assert.equal(r.status, 403);
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { rule: "career", eloPerLevel: 0 } });
    assert.equal(r.status, 400);
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { rule: "career", xpPerLevel: 10 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.settings.rule, "career");
    // the first match: no kills, KDA factor 1; hal won at 1100: (100 + 50) x 1 x 1.1 = 165 XP
    const xp = (name) => t.app.db.prepare("SELECT xp FROM compete_levels WHERE account_id = ?").get(idOf(t, name)).xp;
    assert.equal(xp("hal"), 165);
    assert.equal(level("hal"), Math.floor(Math.sqrt(165 / 10)));
    assert.equal(xp("jon"), Math.round(100 * 1 * 0.93));
    // a lost match still adds experience: the career level does not fall
    const before = level("hal");
    const m = await ratedMatch(["jon", "kim"], ["hal", "ivy"], [["jon", "hal"], ["jon", "hal"]]);
    assert.ok(level("hal") >= before, "a career only rises");
    assert.ok(xp("jon") > 93);
    // a void takes that match's experience back
    const jonBefore = xp("jon");
    r = await request(t.base, "POST", "/api/presence/compete/matches/" + m + "/void", { cookie: admin, body: { note: "test" } });
    assert.equal(r.status, 200, r.text);
    assert.ok(xp("jon") < jonBefore);
    assert.equal(xp("jon"), Math.round(100 * 1 * 0.93));
    r = await request(t.base, "GET", "/api/presence/compete/levels", { cookie: admin });
    assert.equal(r.json.settings.xpPerLevel, 10);
    assert.equal(r.json.defaults.rule, "elo");
    // and back to the ELO rule: the rating decides again
    r = await request(t.base, "POST", "/api/presence/compete/levels", { cookie: admin, body: { rule: "elo" } });
    assert.equal(level("hal"), Math.floor((t.app.db.prepare("SELECT elo FROM compete_ratings WHERE scope = 'n' AND ladder = 'match' AND account_id = ?").get(idOf(t, "hal")).elo - 800) / 20) + 1);
    const board = await request(t.base, "GET", "/api/presence/compete/board?scope=network");
    assert.equal(board.json.players.find((p) => p.username === "hal").level, level("hal"));
  });
});
