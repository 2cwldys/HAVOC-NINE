// Linking a game to an account (lib/link.js): the game's GET routes, the link page's signed-in
// routes, the linked games on the account page, and every way a link ends.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup, sleep } from "./helpers.js";

const MODULES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "modules");

const ROOMY = { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const DEVICE = "9dca7efc8a5cfe1677a2df1cf4731c6f";
const roomyLimits = {
  signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY,
  linkStartPerIp: ROOMY, linkPollPerIp: ROOMY, linkStatusPerIp: ROOMY,
  linkCodePerAccount: ROOMY, linkCodePerIp: ROOMY, linkRevokePerAccount: ROOMY,
  linkAdoptPerIp: ROOMY, linkAdoptPerAccount: ROOMY, linkProfilePerIp: ROOMY,
};
const profile = (t, account, ip) => request(t.base, "GET", "/api/link/profile/" + account, { origin: null, ip });

const start = (t, query = "?v=1&device=" + DEVICE + "&os=windows", ip) => request(t.base, "GET", "/api/link/start" + query, { origin: null, ip });
const poll = (t, code, ip) => request(t.base, "GET", "/api/link/poll?code=" + encodeURIComponent(code), { origin: null, ip });
const linkStatus = (t, token) => request(t.base, "GET", "/api/link/status?token=" + encodeURIComponent(token), { origin: null });
const approve = (t, cookie, code, opts = {}) => request(t.base, "POST", "/api/link/approve", { body: { code }, cookie, ...opts });

// a game asks for a code, the owner approves it, the game polls: { token, answer }
async function link(t, cookie, query) {
  const s = await start(t, query);
  assert.equal(s.json.status, "ok");
  const a = await approve(t, cookie, s.json.userCode);
  assert.equal(a.status, 200, a.text);
  const p = await poll(t, s.json.deviceCode);
  assert.equal(p.json.status, "approved");
  return { token: p.json.token, answer: p.json, start: s.json };
}

describe("linking a game", () => {
  let t;
  let neo;
  let trinity;
  before(async () => {
    t = await startApp({ limits: roomyLimits, link: { maxPendingPerIp: 1000 } });
    neo = await signup(t.base, "Neo");
    trinity = await signup(t.base, "Trinity");
  });
  after(async () => {
    await t.close();
  });

  test("start: a code, a device code, the interval, the expiry and the page, with no session or Origin", async () => {
    const r = await start(t);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
    assert.match(r.json.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.match(r.json.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.json.interval, 5);
    assert.equal(r.json.expiresIn, 600);
    assert.equal(r.json.linkUrl, "https://havoc9.test/link/?code=" + r.json.userCode);
    assert.equal(r.headers["cache-control"], "no-store");
    const p = await poll(t, r.json.deviceCode);
    assert.deepEqual(p.json, { status: "pending" });
  });

  test("the whole flow: the page sees the code, approves it, the game gets the player id once", async () => {
    const s = await start(t);
    const view = await request(t.base, "GET", "/api/link/code?code=" + encodeURIComponent(s.json.userCode.toLowerCase().replace("-", " ")), { cookie: neo });
    assert.equal(view.status, 200);
    assert.equal(view.json.code, s.json.userCode);
    assert.equal(view.json.label, "H9XASH on Windows");
    assert.equal(view.json.sameNetwork, true);
    assert.ok(view.json.expiresIn > 590 && view.json.expiresIn <= 600);
    assert.equal((await approve(t, neo, s.json.userCode)).status, 200);
    const p = await poll(t, s.json.deviceCode);
    assert.equal(p.json.status, "approved");
    assert.equal(p.json.account, "Neo");
    assert.match(p.json.token, /^[A-Za-z0-9_-]{43}$/);
    const player = await request(t.base, "GET", "/api/player", { cookie: neo });
    assert.equal(p.json.playerId, player.json.playerId, "the account's own player id");
    // reused: the code is spent by the answer that carried the id
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "expired" });
    const again = await approve(t, neo, s.json.userCode);
    assert.equal(again.status, 404);
    assert.equal(again.json.error, "no_code");
    // the token is the game's; the database keeps its hash only
    const row = t.app.db.prepare("SELECT * FROM account_links WHERE label = 'H9XASH on Windows' ORDER BY id DESC").get();
    assert.notEqual(row.token_hash, p.json.token);
    assert.equal(row.device, DEVICE);
    const st = await linkStatus(t, p.json.token);
    assert.deepEqual(st.json, { status: "linked", account: "Neo" });
    const audit = t.app.audit.list({ accountId: row.account_id }).rows.map((a) => a.action);
    assert.ok(audit.includes("account.link"), "audit-logged");
  });

  test("the page shows another network as such", async () => {
    const s = await start(t, undefined, "198.51.100.7");
    const view = await request(t.base, "GET", "/api/link/code?code=" + s.json.userCode, { cookie: neo, ip: "203.0.113.99" });
    assert.equal(view.json.sameNetwork, false);
    const same = await request(t.base, "GET", "/api/link/code?code=" + s.json.userCode, { cookie: neo, ip: "198.51.100.7" });
    assert.equal(same.json.sameNetwork, true);
  });

  test("wrong account: a code one account answered is not another's, nor are its linked games", async () => {
    const s = await start(t);
    assert.equal((await approve(t, neo, s.json.userCode)).status, 200);
    const other = await approve(t, trinity, s.json.userCode);
    assert.equal(other.status, 409);
    assert.equal(other.json.error, "code_used");
    const deny = await request(t.base, "POST", "/api/link/deny", { body: { code: s.json.userCode }, cookie: trinity });
    assert.equal(deny.status, 409);
    const p = await poll(t, s.json.deviceCode);
    assert.equal(p.json.account, "Neo", "linked to the account that approved it");
    const mine = await request(t.base, "GET", "/api/link/devices", { cookie: neo });
    const id = mine.json.devices[0].id;
    const theirs = await request(t.base, "GET", "/api/link/devices", { cookie: trinity });
    assert.ok(!theirs.json.devices.some((d) => d.id === id));
    const revoke = await request(t.base, "POST", "/api/link/devices/" + id + "/revoke", { body: {}, cookie: trinity });
    assert.equal(revoke.status, 404);
    assert.deepEqual((await linkStatus(t, p.json.token)).json, { status: "linked", account: "Neo" });
  });

  test("denied: NOT ME ends the code, and the game hears it once", async () => {
    const s = await start(t);
    const d = await request(t.base, "POST", "/api/link/deny", { body: { code: s.json.userCode }, cookie: neo });
    assert.equal(d.status, 200);
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "denied" });
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "expired" });
  });

  test("slow down: a game that polls too fast is told a longer interval", async () => {
    const s = await start(t);
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "pending" });
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "slow_down", interval: 10 });
  });

  test("bad input: unknown codes expire, wrong shapes are refused, the page needs a session and the site's Origin", async () => {
    assert.deepEqual((await poll(t, "x".repeat(43))).json, { status: "expired" });
    assert.deepEqual((await poll(t, "not a code")).json, { status: "expired" });
    assert.deepEqual((await linkStatus(t, "nope")).json, { status: "unlinked" });
    const bad = await approve(t, neo, "ABCD-1234");
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "bad_code");
    const none = await approve(t, neo, "BBBB-BBBB");
    assert.equal(none.status, 404);
    const s = await start(t);
    const anon = await approve(t, null, s.json.userCode);
    assert.equal(anon.status, 401);
    const csrf = await approve(t, neo, s.json.userCode, { origin: "https://evil.test" });
    assert.equal(csrf.status, 403);
    assert.equal(csrf.json.error, "csrf");
    const noOrigin = await approve(t, neo, s.json.userCode, { origin: null });
    assert.equal(noOrigin.status, 403);
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "pending" }, "still waiting after the refusals");
    // a start without a device or with an unknown system still works, with a plain label
    const plain = await start(t, "?v=1&device=zz&os=amiga");
    assert.equal(plain.json.status, "ok");
    const v = await request(t.base, "GET", "/api/link/code?code=" + plain.json.userCode, { cookie: neo });
    assert.equal(v.json.label, "H9XASH");
    assert.equal(v.json.os, null);
  });

  test("revoke: REVOKE on the account page unlinks the game at its next check", async () => {
    const { token } = await link(t, neo, "?v=1&device=0123456789abcdef0123456789abcdef&os=wine");
    const list = await request(t.base, "GET", "/api/link/devices", { cookie: neo });
    const game = list.json.devices.find((d) => d.device === "01234567");
    assert.ok(game);
    assert.equal(game.label, "H9XASH under Wine or Proton");
    assert.ok(game.linked && game.lastSeen);
    const r = await request(t.base, "POST", "/api/link/devices/" + game.id + "/revoke", { body: {}, cookie: neo });
    assert.equal(r.status, 200);
    assert.deepEqual((await linkStatus(t, token)).json, { status: "unlinked" });
    const after = await request(t.base, "GET", "/api/link/devices", { cookie: neo });
    assert.ok(!after.json.devices.some((d) => d.id === game.id));
    const twice = await request(t.base, "POST", "/api/link/devices/" + game.id + "/revoke", { body: {}, cookie: neo });
    assert.equal(twice.status, 404);
    const bad = await request(t.base, "POST", "/api/link/devices/abc/revoke", { body: {}, cookie: neo });
    assert.equal(bad.status, 404);
    const actions = t.app.audit.list({ name: "Neo" }).rows.map((a) => a.action);
    assert.ok(actions.includes("account.link.revoke"));
  });

  test("h9_unlink: the game lets go, and the link is gone from the account page", async () => {
    const { token } = await link(t, trinity, "?v=1&os=windows");
    const before = (await request(t.base, "GET", "/api/link/devices", { cookie: trinity })).json.devices.length;
    assert.deepEqual((await request(t.base, "GET", "/api/link/unlink?token=" + token, { origin: null })).json, { status: "unlinked" });
    assert.equal((await request(t.base, "GET", "/api/link/devices", { cookie: trinity })).json.devices.length, before - 1);
    assert.deepEqual((await linkStatus(t, token)).json, { status: "unlinked" });
    assert.deepEqual((await request(t.base, "GET", "/api/link/unlink?token=" + token, { origin: null })).json, { status: "unlinked" }, "again: the same answer");
  });

  test("the same device linked again replaces its old link", async () => {
    const device = "fedcba9876543210fedcba9876543210";
    const first = await link(t, neo, "?v=1&device=" + device + "&os=windows");
    const second = await link(t, neo, "?v=1&device=" + device + "&os=windows");
    assert.deepEqual((await linkStatus(t, first.token)).json, { status: "unlinked" });
    assert.deepEqual((await linkStatus(t, second.token)).json, { status: "linked", account: "Neo" });
    const rows = t.app.db.prepare("SELECT count(*) AS n FROM account_links WHERE device = ?").get(device);
    assert.equal(rows.n, 1);
  });

  test("events: account-link and account-unlink carry the account and the device", async () => {
    const seen = [];
    const on = (name) => (e) => seen.push({ name, ...e });
    const l = on("account-link");
    const u = on("account-unlink");
    t.app.events.on("account-link", l);
    t.app.events.on("account-unlink", u);
    try {
      const { token } = await link(t, neo, "?v=1&device=" + "a".repeat(32) + "&os=windows");
      await request(t.base, "GET", "/api/link/unlink?token=" + token, { origin: null });
    } finally {
      t.app.events.off("account-link", l);
      t.app.events.off("account-unlink", u);
    }
    const id = t.app.accounts.getByUsername("Neo").id;
    assert.equal(seen[0].name, "account-link");
    assert.equal(seen[0].id, id);
    assert.equal(seen[0].device, "a".repeat(32));
    assert.equal(seen[1].name, "account-unlink");
    assert.equal(seen[1].reason, "unlinked");
    assert.equal(seen[1].device, "a".repeat(32));
  });

  test("a new player id ends every link of the account", async () => {
    const morpheus = await signup(t.base, "Morpheus");
    const a = await link(t, morpheus, "?v=1&device=" + "b".repeat(32) + "&os=windows");
    const b = await link(t, morpheus, "?v=1&device=" + "c".repeat(32) + "&os=wine");
    const id = t.app.accounts.getByUsername("Morpheus").id;
    t.app.accounts.resetPlayerId(id);
    assert.deepEqual((await linkStatus(t, a.token)).json, { status: "unlinked" });
    assert.deepEqual((await linkStatus(t, b.token)).json, { status: "unlinked" });
    assert.equal((await request(t.base, "GET", "/api/link/devices", { cookie: morpheus })).json.devices.length, 0);
  });

  test("a suspended account: no approving, and a code it approved earlier is denied at delivery", async () => {
    const tank = await signup(t.base, "Tank");
    const s = await start(t);
    assert.equal((await approve(t, tank, s.json.userCode)).status, 200);
    const id = t.app.accounts.getByUsername("Tank").id;
    t.app.accounts.ban(id, Math.floor(Date.now() / 1000) + 3600, "test");
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "denied" });
    const s2 = await start(t);
    const r = await approve(t, tank, s2.json.userCode);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "account_suspended");
    t.app.accounts.unban(id);
  });

  test("a deleted account's links go with it", async () => {
    const dozer = await signup(t.base, "Dozer");
    const { token } = await link(t, dozer, "?v=1&os=windows");
    t.app.accounts.remove(t.app.accounts.getByUsername("Dozer").id);
    assert.deepEqual((await linkStatus(t, token)).json, { status: "unlinked" });
  });

  test("profile: an account number sends the browser on to its forum profile, with no session", async () => {
    const id = t.app.accounts.getByUsername("Neo").id;
    const r = await profile(t, id);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/forum/user/?u=Neo");
    assert.equal(r.headers["cache-control"], "no-store", "a rename sends it elsewhere");
    assert.equal(r.text, "");
    await signup(t.base, "Mr.Smith-2");
    const smith = await profile(t, t.app.accounts.getByUsername("Mr.Smith-2").id);
    assert.equal(smith.headers.location, "/forum/user/?u=" + encodeURIComponent("Mr.Smith-2"));
  });

  test("profile: no such account, the default picture's number, or not a number: 404", async () => {
    const ghost = await signup(t.base, "Ghost");
    const gid = t.app.accounts.getByUsername("Ghost").id;
    t.app.accounts.remove(gid);
    const id = t.app.accounts.getByUsername("Neo").id;
    for (const bad of [String(gid), "0", "-1", "0" + id, String(id) + "x", "1.5", "1e3", "2147483647", "2147483648", "99999999999", "%20" + id, "Neo"]) {
      const r = await profile(t, bad);
      assert.equal(r.status, 404, bad);
      assert.equal(r.json.error, "not_found", bad);
      assert.equal(r.headers.location, undefined, bad);
    }
    assert.ok(ghost);
  });
});

describe("linking a game: expiry", () => {
  let t;
  let neo;
  before(async () => {
    t = await startApp({ limits: roomyLimits, link: { codeSeconds: 1 } });
    neo = await signup(t.base, "Neo");
  });
  after(async () => {
    await t.close();
  });

  test("an unanswered code runs out for the game and for the page", async () => {
    const s = await start(t);
    assert.equal(s.json.expiresIn, 1);
    await sleep(1100);
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "expired" });
    const r = await approve(t, neo, s.json.userCode);
    assert.equal(r.status, 404);
  });

  test("an approved code that the game never collects runs out too", async () => {
    const s = await start(t);
    assert.equal((await approve(t, neo, s.json.userCode)).status, 200);
    await sleep(1100);
    assert.deepEqual((await poll(t, s.json.deviceCode)).json, { status: "expired" });
    assert.equal((await request(t.base, "GET", "/api/link/devices", { cookie: neo })).json.devices.length, 0);
  });
});

describe("linking a game: rate limits", () => {
  let t;
  let neo;
  before(async () => {
    t = await startApp({
      limits: {
        ...roomyLimits,
        linkStartPerIp: { max: 3, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
        linkCodePerAccount: { max: 4, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
        linkCodePerIp: { max: 6, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
        linkStatusPerIp: { max: 2, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
        linkRevokePerAccount: { max: 1, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
        linkProfilePerIp: { max: 2, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
      },
      link: { maxPendingPerIp: 2 },
    });
    neo = await signup(t.base, "Neo");
  });
  after(async () => {
    await t.close();
  });

  test("profiles opened per address: the third is a 429, another address is not held", async () => {
    const id = t.app.accounts.getByUsername("Neo").id;
    const ip = "198.51.100.40";
    assert.equal((await profile(t, id, ip)).status, 302);
    assert.equal((await profile(t, "0", ip)).status, 404, "a miss counts too");
    const third = await profile(t, id, ip);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers["retry-after"]) >= 1);
    assert.equal((await profile(t, id, "198.51.100.41")).status, 302);
  });

  test("codes waiting per address, then starts per address", async () => {
    const ip = "198.51.100.20";
    assert.equal((await start(t, undefined, ip)).json.status, "ok");
    assert.equal((await start(t, undefined, ip)).json.status, "ok");
    const third = await start(t, undefined, ip);
    assert.equal(third.status, 200, "the game reads a 200");
    assert.equal(third.json.status, "busy", "two codes wait already");
    const fourth = await start(t, undefined, ip);
    assert.equal(fourth.json.status, "busy");
    assert.ok(fourth.json.retryAfter >= 1);
    assert.equal((await start(t, undefined, "198.51.100.21")).json.status, "ok", "another address is not held");
  });

  test("codes tried per account: guessing stops at the limit with a 429", async () => {
    const codes = ["BBBB-BBBB", "CCCC-CCCC", "DDDD-DDDD", "FFFF-FFFF"];
    for (const c of codes) assert.equal((await approve(t, neo, c, { ip: "198.51.100.30" })).status, 404);
    const s = await start(t, undefined, "198.51.100.31");
    const r = await approve(t, neo, s.json.userCode, { ip: "198.51.100.30" });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers["retry-after"]) > 0);
  });

  test("codes tried per address, whatever the account", async () => {
    const accounts = [];
    for (const n of ["Apoc", "Switch", "Mouse"]) accounts.push(await signup(t.base, n));
    const ip = "198.51.100.40";
    let refused = 0;
    for (let i = 0; i < 8; i++) {
      const r = await approve(t, accounts[i % 3], "GGGG-GGG" + "BCDFGHJK"[i], { ip });
      if (r.status === 429) refused++;
    }
    assert.ok(refused >= 2, "the address is held after six tries");
  });

  test("status checks per address answer busy, not an error", async () => {
    for (let i = 0; i < 2; i++) assert.equal((await linkStatus(t, "x")).json.status, "unlinked");
    const r = await linkStatus(t, "x");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "busy");
  });

  test("REVOKE per account", async () => {
    const one = await request(t.base, "POST", "/api/link/devices/999/revoke", { body: {}, cookie: neo });
    assert.equal(one.status, 404);
    const two = await request(t.base, "POST", "/api/link/devices/999/revoke", { body: {}, cookie: neo });
    assert.equal(two.status, 429);
  });
});

// ---- adopting the id a game holds ------------------------------------------------------------

// what engine-h9-link.patch sends for the id P (cl_idproof.c's formulas, S = "h9link-adopt")
function adoptQuery(P, nonce, device, os = "windows") {
  const key = crypto.createHmac("sha256", P).update("h9adopt-key1").digest("hex").slice(0, 32);
  const mask = crypto.createHmac("sha256", P).update("h9dev1:" + nonce).digest();
  const dm = Buffer.from(device);
  for (let i = 0; i < 16; i++) dm[i] ^= mask[i];
  const devmask = dm.toString("hex");
  const proof = crypto.createHmac("sha256", P).update("h9proof1:" + nonce + ":h9link-adopt:" + devmask).digest("hex");
  return "?v=1&key=" + key + "&nonce=" + nonce + "&devmask=" + devmask + "&proof=" + proof + "&os=" + os;
}
const deviceHash = (device) => crypto.createHash("sha256").update("h9device1:").update(device).digest("hex").slice(0, 32);

async function adoptNonce(t, ip) {
  const r = await request(t.base, "GET", "/api/link/adopt/nonce?v=1", { origin: null, ip });
  assert.equal(r.status, 200);
  return r.json;
}

async function adoptWith(t, P, device, { ip, os, nonce } = {}) {
  const n = nonce || (await adoptNonce(t, ip)).nonce;
  return (await request(t.base, "GET", "/api/link/adopt" + adoptQuery(P, n, device, os), { origin: null, ip })).json;
}

describe("adopting the id a game holds", () => {
  let t;
  let neo;
  let P;
  before(async () => {
    t = await startApp({ limits: roomyLimits, link: { maxPendingPerIp: 1000 } });
    neo = await signup(t.base, "Neo");
    P = (await request(t.base, "GET", "/api/player", { cookie: neo })).json.playerId;
  });
  after(async () => {
    await t.close();
  });

  test("an account's id with its proof: linked, a token for the proven device, audit-logged", async () => {
    const device = crypto.randomBytes(16);
    const n = await adoptNonce(t);
    assert.equal(n.status, "ok");
    assert.match(n.nonce, /^[0-9a-f]{32}$/);
    const r = await adoptWith(t, P, device, { nonce: n.nonce });
    assert.equal(r.status, "linked");
    assert.equal(r.account, "Neo");
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!("playerId" in r), "no player id on the wire");
    assert.deepEqual((await linkStatus(t, r.token)).json, { status: "linked", account: "Neo" });
    const list = (await request(t.base, "GET", "/api/link/devices", { cookie: neo })).json.devices;
    assert.ok(list.some((d) => d.device === deviceHash(device).slice(0, 8) && d.label === "H9XASH on Windows"), "the device the proof unmasked");
    const actions = t.app.audit.list({ name: "Neo" }).rows.map((a) => a.action);
    assert.ok(actions.includes("account.link.adopt"));
    // the same device again replaces its link
    const again = await adoptWith(t, P, device);
    assert.equal(again.status, "linked");
    assert.deepEqual((await linkStatus(t, r.token)).json, { status: "unlinked" });
  });

  test("an id that is no account's is unknown; a wrong proof and a bad request are refused", async () => {
    const other = crypto.randomBytes(16).toString("hex");
    assert.deepEqual(await adoptWith(t, other, crypto.randomBytes(16)), { status: "unknown" });
    // the right key with a proof made from another id
    const n = (await adoptNonce(t)).nonce;
    const good = new URLSearchParams(adoptQuery(P, n, crypto.randomBytes(16)).slice(1));
    const bad = new URLSearchParams(adoptQuery(other, n, crypto.randomBytes(16)).slice(1));
    bad.set("key", good.get("key"));
    const r = await request(t.base, "GET", "/api/link/adopt?" + bad.toString(), { origin: null });
    assert.deepEqual(r.json, { status: "refused", reason: "bad_proof" });
    const shape = await request(t.base, "GET", "/api/link/adopt?v=1&key=zz&nonce=" + n, { origin: null });
    assert.deepEqual(shape.json, { status: "refused", reason: "bad_request" });
  });

  test("a nonce is used once, and one the site never issued is stale", async () => {
    const device = crypto.randomBytes(16);
    const n = (await adoptNonce(t)).nonce;
    assert.equal((await adoptWith(t, P, device, { nonce: n })).status, "linked");
    assert.deepEqual(await adoptWith(t, P, device, { nonce: n }), { status: "refused", reason: "stale" });
    assert.deepEqual(await adoptWith(t, P, device, { nonce: "0".repeat(32) }), { status: "refused", reason: "stale" });
  });

  test("a suspended account is refused", async () => {
    const tank = await signup(t.base, "Tank");
    const tp = (await request(t.base, "GET", "/api/player", { cookie: tank })).json.playerId;
    const id = t.app.accounts.getByUsername("Tank").id;
    t.app.accounts.ban(id, Math.floor(Date.now() / 1000) + 3600, "test");
    assert.deepEqual(await adoptWith(t, tp, crypto.randomBytes(16)), { status: "refused", reason: "suspended" });
    t.app.accounts.unban(id);
    assert.equal((await adoptWith(t, tp, crypto.randomBytes(16))).status, "linked");
  });

  test("a new player id: the old one adopts nothing, the new one does", async () => {
    const morpheus = await signup(t.base, "Morpheus");
    const old = (await request(t.base, "GET", "/api/player", { cookie: morpheus })).json.playerId;
    t.app.accounts.resetPlayerId(t.app.accounts.getByUsername("Morpheus").id);
    const now = (await request(t.base, "GET", "/api/player", { cookie: morpheus })).json.playerId;
    assert.deepEqual(await adoptWith(t, old, crypto.randomBytes(16)), { status: "unknown" });
    assert.equal((await adoptWith(t, now, crypto.randomBytes(16))).status, "linked");
  });
});

describe("adopting: nonces that run out, and the limits", () => {
  let t;
  let P;
  before(async () => {
    t = await startApp({
      limits: {
        ...roomyLimits,
        linkAdoptPerIp: { max: 6, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
        linkAdoptPerAccount: { max: 2, windowSeconds: 600, blockSeconds: 600, maxBlockSeconds: 600 },
      },
      link: { adoptNonceSeconds: 1 },
    });
    const neo = await signup(t.base, "Neo");
    P = (await request(t.base, "GET", "/api/player", { cookie: neo })).json.playerId;
  });
  after(async () => {
    await t.close();
  });

  test("a nonce runs out", async () => {
    const n = (await adoptNonce(t, "198.51.100.50")).nonce;
    await sleep(1100);
    assert.deepEqual(await adoptWith(t, P, crypto.randomBytes(16), { nonce: n, ip: "198.51.100.50" }), { status: "refused", reason: "stale" });
  });

  test("wrong proofs per account, then every try of that account waits", async () => {
    const ip = "198.51.100.60";
    const wrong = crypto.randomBytes(16).toString("hex");
    const tryWrong = async () => {
      const n = (await adoptNonce(t, ip)).nonce;
      const good = new URLSearchParams(adoptQuery(P, n, crypto.randomBytes(16)).slice(1));
      const bad = new URLSearchParams(adoptQuery(wrong, n, crypto.randomBytes(16)).slice(1));
      bad.set("key", good.get("key"));
      return (await request(t.base, "GET", "/api/link/adopt?" + bad.toString(), { origin: null, ip })).json;
    };
    assert.equal((await tryWrong()).reason, "bad_proof");
    assert.equal((await tryWrong()).reason, "bad_proof");
    assert.equal((await tryWrong()).reason, "bad_proof", "the third is counted, and blocks");
    const r = await adoptWith(t, P, crypto.randomBytes(16), { ip: "198.51.100.61" });
    assert.equal(r.status, "busy", "even a right proof, from elsewhere, waits");
  });

  test("tries per address answer busy", async () => {
    const ip = "198.51.100.70";
    let busy = 0;
    for (let i = 0; i < 8; i++) {
      const r = await request(t.base, "GET", "/api/link/adopt/nonce?v=1", { origin: null, ip });
      if (r.json.status === "busy") busy++;
    }
    assert.ok(busy >= 2);
  });
});

describe("adopting with the presence module: its second-device rule", () => {
  let t;
  let neo;
  let P;
  before(async () => {
    t = await startApp({ modules: ["presence"], limits: roomyLimits, link: { maxPendingPerIp: 1000 } }, { modulesDir: MODULES });
    neo = await signup(t.base, "Neo");
    P = (await request(t.base, "GET", "/api/player", { cookie: neo })).json.playerId;
  });
  after(async () => {
    await t.close();
  });

  test("an account whose id presence bound to another device is refused; its own device is linked", async () => {
    const id = t.app.accounts.getByUsername("Neo").id;
    const bound = crypto.randomBytes(16);
    const s = Math.floor(Date.now() / 1000);
    t.app.db.prepare("INSERT INTO presence_devices (account_id, device, status, first_seen, last_seen) VALUES (?, ?, 'bound', ?, ?)").run(id, deviceHash(bound), s, s);
    assert.deepEqual(await adoptWith(t, P, crypto.randomBytes(16)), { status: "refused", reason: "second_device" });
    assert.ok(t.app.audit.list({ name: "Neo" }).rows.some((a) => a.action === "account.link.adopt.refused"));
    assert.equal((await adoptWith(t, P, bound)).status, "linked");
  });
});
