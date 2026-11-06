// H9's site admins and an account's linked games (lib/link.js): the list (moderators may look),
// and revoking one or all with the admin's own password and a note, through the owner's own
// revoke: the game hears "unlinked" at its next status check, and the account's audit trail
// shows who did it and why.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, request, signup } from "./helpers.js";

const ROOMY = { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const PASSWORD = "correct horse battery staple";
const roomyLimits = {
  signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY,
  linkStartPerIp: ROOMY, linkPollPerIp: ROOMY, linkStatusPerIp: ROOMY,
  linkCodePerAccount: ROOMY, linkCodePerIp: ROOMY, linkRevokePerAccount: ROOMY,
  linkAdoptPerIp: ROOMY, linkAdoptPerAccount: ROOMY, linkProfilePerIp: ROOMY, reauthPerAccount: ROOMY,
};

const start = (t, device, os) => request(t.base, "GET", "/api/link/start?v=1&device=" + device + "&os=" + os, { origin: null });
const poll = (t, code) => request(t.base, "GET", "/api/link/poll?code=" + encodeURIComponent(code), { origin: null });
const linkStatus = (t, token) => request(t.base, "GET", "/api/link/status?token=" + encodeURIComponent(token), { origin: null });

async function link(t, cookie, device, os) {
  const s = await start(t, device, os);
  assert.equal(s.json.status, "ok", s.text);
  const a = await request(t.base, "POST", "/api/link/approve", { body: { code: s.json.userCode }, cookie });
  assert.equal(a.status, 200, a.text);
  const p = await poll(t, s.json.deviceCode);
  assert.equal(p.json.status, "approved");
  return p.json.token;
}

describe("an admin and an account's linked games", () => {
  let t;
  let neo;
  let boss;
  let modo;
  let chief;
  let tokens;
  before(async () => {
    t = await startApp({ limits: roomyLimits, link: { maxPendingPerIp: 1000 } });
    neo = await signup(t.base, "Neo");
    boss = await signup(t.base, "Boss");
    modo = await signup(t.base, "Modo");
    chief = await signup(t.base, "Chief");
    const id = (n) => t.app.accounts.getByUsername(n).id;
    t.app.accounts.setRole(id("Boss"), "admin");
    t.app.accounts.setRole(id("Chief"), "admin");
    t.app.accounts.setRole(id("Modo"), "moderator");
    tokens = [await link(t, neo, "11".repeat(16), "windows"), await link(t, neo, "22".repeat(16), "linux")];
    await link(t, chief, "33".repeat(16), "windows");
  });
  after(() => t.close());

  const list = (cookie, name = "Neo") => request(t.base, "GET", "/api/link/accounts/" + name + "/devices", { cookie });
  const revoke = (cookie, path, body, name = "Neo") => request(t.base, "POST", "/api/link/accounts/" + name + "/devices/" + path, { cookie, body });

  test("moderators and admins see an account's linked games; only an admin may act; a player sees nothing", async () => {
    let r = await list(modo);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.devices.length, 2);
    assert.equal(r.json.can.act, false);
    assert.ok(r.json.devices.every((d) => d.label && d.linked));
    r = await list(boss);
    assert.equal(r.json.can.act, true);
    r = await list(neo);
    assert.equal(r.status, 403);
    r = await list(boss, "Nobody");
    assert.equal(r.status, 404);
  });

  test("REVOKE: the admin's own password and a note; the game is unlinked and the trail says who and why", async () => {
    const games = (await list(boss)).json.devices;
    const one = games[0];
    let r = await revoke(modo, one.id + "/revoke", { password: PASSWORD, note: "lost laptop" });
    assert.equal(r.status, 403, "moderators do not act");
    r = await revoke(boss, one.id + "/revoke", { password: "not it at all", note: "lost laptop" });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "bad_password");
    r = await revoke(boss, one.id + "/revoke", { password: PASSWORD });
    assert.equal(r.status, 400, "a note is needed");
    r = await revoke(boss, one.id + "/revoke", { password: PASSWORD, note: "lost laptop" });
    assert.equal(r.status, 200, r.text);
    assert.equal((await list(boss)).json.devices.length, 1);
    const statuses = await Promise.all(tokens.map((x) => linkStatus(t, x)));
    assert.equal(statuses.filter((s) => s.json.status === "unlinked").length, 1, "that game hears it at its next check");
    const trail = (await request(t.base, "GET", "/api/admin/accounts/Neo", { cookie: boss })).json.audit;
    const entry = trail.find((e) => e.action === "account.link.revoke");
    assert.ok(entry, "the revoke is in the account's trail");
    assert.equal(entry.by, "Boss");
    assert.match(String(entry.detail), /lost laptop/);
  });

  test("REVOKE ALL ends every link; never on an admin's account", async () => {
    let r = await revoke(boss, "revoke-all", { password: PASSWORD, note: "locked out, starting over" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.revoked, 1);
    assert.equal((await list(boss)).json.devices.length, 0);
    for (const x of tokens) assert.equal((await linkStatus(t, x)).json.status, "unlinked");
    r = await revoke(boss, "revoke-all", { password: PASSWORD, note: "nope" }, "Chief");
    assert.equal(r.status, 403, "an admin's own role or above: nothing");
    r = await list(boss, "Chief");
    assert.equal(r.json.can.act, false);
  });
});
