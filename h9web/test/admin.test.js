import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = "correct horse battery staple";
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };

function cli(t, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, "..", "bin", "h9web-admin.js"), "--config", t.configFile, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

describe("the admin panel's API", () => {
  let t;
  const people = {};
  const post = (who, p, body) => request(t.base, "POST", p, { cookie: who && who.cookie, body: body === undefined ? {} : body });
  const get = (who, p) => request(t.base, "GET", p, { cookie: who && who.cookie });
  const auditRows = (action) => t.app.db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action);
  async function make(name, role = "user") {
    const cookie = await signup(t.base, name);
    const a = t.app.accounts.getByUsername(name);
    if (role !== "user") t.app.accounts.setRole(a.id, role);
    people[name] = { name, cookie, id: a.id };
    return people[name];
  }
  before(async () => {
    t = await startApp({
      modules: ["forum"],
      limits: { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY, reauthPerAccount: { max: 3, windowSeconds: 900, blockSeconds: 900, maxBlockSeconds: 900 },
        adminListPerAccount: { max: 40, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 30 } },
      moduleSettings: { forum: { limits: Object.fromEntries(["thread", "post", "postHour", "newThread", "newPost", "newPostHour", "threadPerIp", "postPerIp"].map((k) => [k, ROOMY])) } },
    }, { modulesDir: path.join(HERE, "..", "modules") });
    await make("Trinity");
    await make("Switch");
    await make("Morpheus", "moderator");
    await make("Seraph", "moderator");
    await make("Oracle", "admin");
    await make("Architect", "admin");
  });
  after(async () => {
    await t.close();
  });

  test("who gets in: guests 401, users 403, moderators and admins 200", async () => {
    assert.equal((await get(null, "/api/admin/me")).status, 401);
    assert.equal((await get(people.Trinity, "/api/admin/me")).status, 403);
    const mod = await get(people.Morpheus, "/api/admin/me");
    assert.deepEqual([mod.status, mod.json.admin, mod.json.modSuspendMaxDays], [200, false, 7]);
    assert.equal((await get(people.Oracle, "/api/admin/me")).json.admin, true);
    assert.equal((await get(people.Morpheus, "/api/admin/accounts")).json.scope, "players", "moderators list the players");
    for (const p of ["/api/admin/accounts/Trinity", "/api/admin/renames", "/api/admin/audit"]) {
      assert.equal((await get(people.Morpheus, p)).status, 403, "moderators: " + p);
      assert.equal((await get(people.Oracle, p)).status, 200, "admins: " + p);
    }
  });

  test("the account list's sort key is a whitelist: inherited names fall back to the default, never an error", async () => {
    for (const sort of ["constructor", "__proto__", "toString", "hasOwnProperty", "name; DROP TABLE accounts"]) {
      const r = await get(people.Oracle, "/api/admin/accounts?sort=" + encodeURIComponent(sort));
      assert.equal(r.status, 200, "sort=" + sort);
      assert.equal(r.json.sort, "newest", "sort=" + sort);
    }
    assert.equal((await get(people.Oracle, "/api/admin/accounts?sort=name")).json.sort, "name");
  });

  test("moderators suspend users only, for 1 to 7 days, with a reason; lifting is for admins", async () => {
    const s = (who, name, body) => post(who, "/api/admin/accounts/" + name + "/suspend", body);
    assert.equal((await s(people.Morpheus, "Switch", { days: 3 })).status, 400, "a reason");
    assert.equal((await s(people.Morpheus, "Switch", { reason: "Spamming the forum", days: 8 })).status, 403, "past 7 days");
    assert.equal((await s(people.Morpheus, "Switch", { reason: "Spamming the forum" })).status, 403, "no end: admins only");
    for (const name of ["Seraph", "Oracle", "Morpheus"]) {
      assert.equal((await s(people.Morpheus, name, { reason: "not allowed", days: 1 })).status, 403, name);
    }
    assert.equal((await s(people.Morpheus, "Nobody", { reason: "who?", days: 1 })).status, 404);
    const ok = await s(people.Morpheus, "Switch", { reason: "Spamming the forum", days: 3 });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.until);
    assert.equal((await get(people.Switch, "/api/me")).json.signedIn, false, "every session ended");
    const login = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: PW } });
    assert.equal(login.status, 403);
    assert.equal(login.json.reason, "Spamming the forum");
    assert.equal((await post(people.Morpheus, "/api/admin/accounts/Switch/unsuspend")).status, 403);
    assert.equal((await post(people.Oracle, "/api/admin/accounts/Switch/unsuspend")).status, 200);
    const back = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: PW } });
    assert.equal(back.status, 200);
    people.Switch.cookie = back.cookie;
    const row = auditRows("account.suspend").at(-1);
    assert.deepEqual([row.actor_name, row.target_name, row.detail], ["Morpheus", "Switch", "3 days: Spamming the forum"]);
    assert.equal(auditRows("account.unsuspend").at(-1).actor_name, "Oracle");
  });

  test("admins: any length, moderators too, never admins or themselves; no end needs the password", async () => {
    const s = (name, body) => post(people.Oracle, "/api/admin/accounts/" + name + "/suspend", body);
    assert.equal((await s("Seraph", { reason: "Cooling off", days: 30 })).status, 200, "an admin suspends a moderator");
    await post(people.Oracle, "/api/admin/accounts/Seraph/unsuspend");
    assert.equal((await s("Architect", { reason: "a coup", days: 1 })).status, 403, "never another admin");
    assert.equal((await s("Oracle", { reason: "myself", days: 1 })).status, 403, "never yourself");
    const noPw = await s("Trinity", { reason: "For good" });
    assert.equal(noPw.status, 400);
    assert.equal(noPw.json.error, "password_required");
    assert.equal((await s("Trinity", { reason: "For good", password: "not my password" })).status, 403);
    const forever = await s("Trinity", { reason: "For good", password: PW });
    assert.equal(forever.status, 200);
    assert.equal(forever.json.until, null);
    assert.equal(auditRows("account.suspend").at(-1).detail, "no end: For good");
    await post(people.Oracle, "/api/admin/accounts/Trinity/unsuspend");
    const again = await request(t.base, "POST", "/api/login", { body: { username: "Trinity", password: PW } });
    people.Trinity.cookie = again.cookie;
  });

  test("accounts: search, list, show with its audit trail", async () => {
    const found = await get(people.Oracle, "/api/admin/accounts?q=SER");
    assert.deepEqual(found.json.accounts.map((a) => a.username), ["Seraph"]);
    assert.deepEqual((await get(people.Oracle, "/api/admin/accounts?q=5er")).json.accounts.map((a) => a.username), ["Seraph"], "5 looks like s");
    assert.equal((await get(people.Oracle, "/api/admin/accounts?q=" + encodeURIComponent("%"))).json.total, 0, "% is a character");
    assert.equal((await get(people.Oracle, "/api/admin/accounts")).json.total >= 6, true);
    const one = await get(people.Oracle, "/api/admin/accounts/switch");
    assert.equal(one.json.account.username, "Switch");
    assert.ok(one.json.audit.some((r) => r.action === "account.suspend" && r.by === "Morpheus"));
    assert.equal(one.json.can.act, true);
    assert.equal((await get(people.Oracle, "/api/admin/accounts/Architect")).json.can.act, false);
  });

  test("re-authentication: reset-password, delete and role need your own password, limited", async () => {
    const smith = await make("Smith", "admin");
    const reset = (body) => post(smith, "/api/admin/accounts/Switch/password", body);
    assert.equal((await reset({})).json.error, "password_required");
    for (let i = 0; i < 3; i++) assert.equal((await reset({ password: "wrong guess " + i })).status, 403);
    assert.equal((await reset({ password: "wrong guess 3" })).status, 429, "the fourth wrong password blocks");
    const blocked = await reset({ password: PW });
    assert.equal(blocked.status, 429, "wrong passwords are limited, and then even the right one waits");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    const r = await post(people.Oracle, "/api/admin/accounts/Switch/password", { password: PW });
    assert.equal(r.status, 200);
    assert.match(r.json.newPassword, /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    assert.equal((await get(people.Switch, "/api/me")).json.signedIn, false);
    const relogin = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: r.json.newPassword } });
    assert.equal(relogin.status, 200);
    people.Switch.cookie = relogin.cookie;
    assert.ok(!JSON.stringify(t.app.db.prepare("SELECT * FROM audit_log").all()).includes(r.json.newPassword), "the password is never in the audit log");
    assert.ok(!t.logs.join("\n").includes(r.json.newPassword), "or the log");
    // roles: user <-> moderator only
    const role = (name, body) => post(people.Oracle, "/api/admin/accounts/" + name + "/role", body);
    assert.equal((await role("Trinity", { role: "admin", password: PW })).status, 400, "admins are made on the server");
    assert.equal((await role("Architect", { role: "user", password: PW })).status, 403, "never demote an admin");
    assert.equal((await role("Trinity", { role: "moderator" })).status, 400);
    assert.equal((await role("Trinity", { role: "moderator", password: PW })).status, 200);
    assert.equal(t.app.accounts.getByUsername("Trinity").role, "moderator");
    assert.equal((await role("Trinity", { role: "user", password: PW })).status, 200);
    assert.equal(auditRows("account.role").at(-1).detail, "moderator -> user");
    assert.equal((await post(people.Morpheus, "/api/admin/accounts/Trinity/role", { role: "moderator", password: PW })).status, 403, "moderators set no roles");
    // delete: the username typed exactly, and the password
    const doomed = await make("Kid");
    const del = (body) => post(people.Oracle, "/api/admin/accounts/Kid/delete", body);
    assert.equal((await del({ confirm: "kid", password: PW })).status, 400, "typed exactly");
    assert.equal((await del({ confirm: "Kid", password: "wrong one here" })).status, 403);
    assert.equal((await del({ confirm: "Kid", password: PW })).status, 200);
    assert.equal(t.app.accounts.getByUsername("Kid"), null);
    const row = auditRows("account.delete").at(-1);
    assert.deepEqual([row.actor_name, row.target_name, row.target_id], ["Oracle", "Kid", null], "the name outlives the account");
    assert.equal((await get(doomed, "/api/me")).json.signedIn, false);
    assert.equal((await post(people.Oracle, "/api/admin/accounts/Kid/sessions")).status, 404);
    assert.equal((await post(people.Oracle, "/api/admin/accounts/Switch/sessions")).status, 200);
  });

  test("CSRF: every admin write refuses a foreign Origin, a missing one and a cross-site request", async () => {
    const writes = [
      ["/api/admin/accounts/Switch/suspend", { reason: "forged", days: 1 }],
      ["/api/admin/accounts/Switch/unsuspend", {}],
      ["/api/admin/accounts/Switch/sessions", {}],
      ["/api/admin/accounts/Switch/password", { password: PW }],
      ["/api/admin/accounts/Switch/delete", { confirm: "Switch", password: PW }],
      ["/api/admin/accounts/Switch/role", { role: "moderator", password: PW }],
      ["/api/admin/renames/1/approve", { password: PW }],
      ["/api/admin/renames/1/deny", {}],
      ["/api/account/rename", { username: "Forged_Name" }],
    ];
    for (const [p, body] of writes) {
      for (const how of [{ origin: "https://evil.example" }, { origin: null }, { headers: { "sec-fetch-site": "cross-site" } }]) {
        const r = await request(t.base, "POST", p, { cookie: people.Oracle.cookie, body, ...how });
        assert.equal(r.status, 403, p + " " + JSON.stringify(how));
        assert.equal(r.json.error, "csrf");
      }
    }
    for (const how of [{ origin: "https://evil.example" }, { origin: null }]) {
      assert.equal((await request(t.base, "DELETE", "/api/account/rename", { cookie: people.Oracle.cookie, ...how })).status, 403);
    }
    const sw = t.app.accounts.getByUsername("Switch");
    assert.ok(sw && sw.role === "user" && !t.app.accounts.isBanned(sw), "nothing happened to Switch");
  });

  test("the audit log: admins read it, by name too; old rows are pruned", async () => {
    const all = await get(people.Oracle, "/api/admin/audit");
    assert.equal(all.json.retentionDays, 90);
    assert.ok(all.json.entries.length > 5);
    assert.ok(all.json.entries[0].at >= all.json.entries.at(-1).at, "the latest first");
    const sw = await get(people.Oracle, "/api/admin/audit?name=switch");
    assert.ok(sw.json.entries.length > 0 && sw.json.entries.every((e) => e.target === "Switch" || e.by === "Switch"));
    const kid = await get(people.Oracle, "/api/admin/audit?name=Kid");
    assert.ok(kid.json.entries.some((e) => e.action === "account.delete"), "a deleted account by its old name");
    t.app.db.prepare("INSERT INTO audit_log (at, actor_name, action) VALUES (?, 'Old', 'account.sessions')").run(Math.floor(Date.now() / 1000) - 91 * 86400);
    assert.equal(t.app.audit.prune(), 1);
  });

  test("username changes: the request, its checks, approval with the password, and what stays", async () => {
    const neo = await make("Neo");
    const th = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: neo.cookie, body: { title: "Before the change", body: "mine" } });
    const pidBefore = (await get(neo, "/api/player")).json.playerId;
    const ask = (who, username) => post(who, "/api/account/rename", { username });
    for (const [name, why] of [["ab", "too short"], ["Admin_Neo", "reserved"], ["has space", "characters"], ["Neo", "the same name"]]) {
      assert.equal((await ask(neo, name)).status, 400, why);
    }
    for (const [name, why] of [["TRINITY", "another account, any case"], ["Tr1nity", "a look-alike"], ["Swi_tch", "a look-alike with a separator"]]) {
      const r = await ask(neo, name);
      assert.equal(r.status, 409, why);
      assert.equal(r.json.error, "username_taken");
    }
    const made = await ask(neo, "The_One");
    assert.equal(made.status, 201);
    assert.deepEqual([made.json.request.from, made.json.request.to, made.json.request.status], ["Neo", "The_One", "pending"]);
    assert.equal((await ask(neo, "The_Two")).json.error, "rename_pending", "one at a time");
    assert.equal((await request(t.base, "DELETE", "/api/account/rename", { cookie: neo.cookie })).json.changed, true);
    assert.equal((await get(neo, "/api/account/rename")).json.request.status, "cancelled");
    const id = (await ask(neo, "The_One")).json.request.id;
    assert.equal((await get(people.Oracle, "/api/admin/renames")).json.requests.find((r) => r.id === id).account, "Neo");
    assert.equal((await post(people.Oracle, "/api/admin/renames/" + id + "/approve", {})).json.error, "password_required");
    assert.equal((await post(people.Morpheus, "/api/admin/renames/" + id + "/approve", { password: PW })).status, 403, "admins decide");
    const ok = await post(people.Oracle, "/api/admin/renames/" + id + "/approve", { password: PW });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.from, ok.json.to], ["Neo", "The_One"]);
    // the same session, the same player id, the same posts, under the new name
    assert.equal((await get(neo, "/api/me")).json.user.username, "The_One");
    assert.equal((await get(neo, "/api/player")).json.playerId, pidBefore);
    assert.equal((await get(null, "/api/forum/threads/" + th.json.thread.id)).json.posts[0].by.username, "The_One");
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "the_one", password: PW } })).status, 200);
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "Neo", password: PW } })).status, 401);
    const row = auditRows("account.rename").at(-1);
    assert.deepEqual([row.actor_name, row.target_name], ["Oracle", "The_One"]);
    assert.match(row.detail, /^Neo -> The_One/);
    // the old name is held: nobody signs up as it, or as its look-alike, or asks for it
    for (const name of ["Neo", "NEO", "Ne0"]) {
      const r = await request(t.base, "POST", "/api/signup", { body: { username: name, password: PW } });
      assert.equal(r.status, 409, name);
    }
    assert.equal((await ask(people.Trinity, "neo")).json.error, "username_taken");
    // a cooldown after a change
    const soon = await ask(neo, "Thomas_A");
    assert.equal(soon.status, 403);
    assert.equal(soon.json.error, "rename_cooldown");
    // when the hold runs out, the old name is free again
    t.app.db.prepare("UPDATE username_holds SET held_until = ? WHERE username = 'Neo'").run(Math.floor(Date.now() / 1000) - 1);
    assert.equal((await request(t.base, "POST", "/api/signup", { body: { username: "Neo", password: PW } })).status, 201);
  });

  test("username changes: denial with a reason, an admin's own request, and a race at approval", async () => {
    const a = await make("Apoc");
    const b = await make("Tank");
    const ra = (await post(a, "/api/account/rename", { username: "Dozer" })).json.request.id;
    const rb = (await post(b, "/api/account/rename", { username: "D0zer" })).json.request.id;
    // both asked while the name was free; only one may get it
    const results = await Promise.all([
      post(people.Oracle, "/api/admin/renames/" + ra + "/approve", { password: PW }),
      post(people.Oracle, "/api/admin/renames/" + rb + "/approve", { password: PW }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const loser = results[0].status === 409 ? a : b;
    const loserId = results[0].status === 409 ? ra : rb;
    assert.equal((await get(loser, "/api/account/rename")).json.request.status, "pending", "the loser's request waits for a decision");
    const deny = await post(people.Oracle, "/api/admin/renames/" + loserId + "/deny", { reason: "Too close to another player's name" });
    assert.equal(deny.status, 200);
    const seen = (await get(loser, "/api/account/rename")).json.request;
    assert.deepEqual([seen.status, seen.reason], ["denied", "Too close to another player's name"]);
    assert.equal((await post(people.Oracle, "/api/admin/renames/" + loserId + "/approve", { password: PW })).status, 409, "decided already");
    // nobody decides their own, or an equal's
    const own = (await post(people.Oracle, "/api/account/rename", { username: "The_Oracle" })).json.request.id;
    assert.equal((await post(people.Oracle, "/api/admin/renames/" + own + "/approve", { password: PW })).status, 403);
    assert.equal((await post(people.Architect, "/api/admin/renames/" + own + "/approve", { password: PW })).status, 403);
    assert.ok(auditRows("account.rename-denied").some((r) => /Too close/.test(r.detail)));
  });

  test("the admin command: rename with the same checks and the hold, audited as the command line", async () => {
    await make("Mouse");
    let r = await cli(t, "rename", "Mouse", "Trinity");
    assert.notEqual(r.code, 0, "taken");
    r = await cli(t, "rename", "Mouse", "admin");
    assert.notEqual(r.code, 0, "reserved");
    r = await cli(t, "rename", "Mouse", "Rat");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Mouse is now Rat/);
    assert.equal(t.app.accounts.getByUsername("Rat").id, people.Mouse.id);
    assert.equal((await request(t.base, "POST", "/api/signup", { body: { username: "M0use", password: PW } })).status, 409, "held");
    const row = auditRows("account.rename").at(-1);
    assert.deepEqual([row.actor_name, row.actor_id, row.detail], ["(command line)", null, "Mouse -> Rat"]);
    r = await cli(t, "set-role", "Rat", "moderator");
    assert.equal(r.code, 0, r.out);
    assert.equal(auditRows("account.role").at(-1).actor_name, "(command line)");
  });
  test("the account list: everyone a role may act on, newest first, sorted, filtered, paged", async () => {
    const list = (who, query = "") => get(who, "/api/admin/accounts" + query);
    assert.equal((await list(null)).status, 401, "a session is needed");
    assert.equal((await list(people.Trinity)).status, 403);
    // moderators: players only
    const mod = await list(people.Morpheus);
    assert.equal(mod.status, 200);
    assert.equal(mod.json.scope, "players");
    assert.ok(mod.json.accounts.length > 0 && mod.json.accounts.every((a) => a.role === "user"));
    assert.equal((await list(people.Morpheus, "?role=admin")).json.total, 0);
    // admins: everyone, newest first by default
    const all = await list(people.Oracle);
    assert.equal(all.json.scope, "all");
    const total = t.app.db.prepare("SELECT count(*) AS n FROM accounts").get().n;
    assert.equal(all.json.total, total);
    const newest = t.app.db.prepare("SELECT username FROM accounts ORDER BY id DESC LIMIT 1").get().username;
    assert.equal(all.json.accounts[0].username, newest);
    assert.deepEqual(Object.keys(all.json.accounts[0]).sort(), ["joined", "lastLogin", "postingOff", "role", "suspended", "username"], "nothing more: no address, no reason");
    const oldest = await list(people.Oracle, "?sort=oldest&per=1");
    assert.equal(oldest.json.accounts[0].username, "Trinity");
    assert.equal(oldest.json.pages, total);
    const byName = (await list(people.Oracle, "?sort=name")).json.accounts.map((a) => a.username.toLowerCase());
    assert.deepEqual(byName, [...byName].sort());
    const byLogin = (await list(people.Oracle, "?sort=lastlogin")).json.accounts;
    const stamps = byLogin.filter((a) => a.lastLogin).map((a) => a.lastLogin);
    assert.deepEqual(stamps, [...stamps].sort().reverse(), "the latest sign-in first");
    assert.equal((await list(people.Oracle, "?per=500")).json.perPage, 100, "at most 100 a page");
    const p2 = await list(people.Oracle, "?sort=oldest&per=2&page=2");
    assert.deepEqual([p2.json.page, p2.json.accounts.length], [2, 2]);
    // the start of a name, without regard to case or look-alikes; nothing in the middle
    assert.deepEqual((await list(people.Oracle, "?q=tri")).json.accounts.map((a) => a.username), ["Trinity"]);
    assert.deepEqual((await list(people.Oracle, "?q=TR1")).json.accounts.map((a) => a.username), ["Trinity"], "1 looks like i");
    assert.equal((await list(people.Oracle, "?q=rinity")).json.total, 0);
    assert.equal((await list(people.Oracle, "?q=" + encodeURIComponent("%"))).json.total, 0);
    // filters: a role, the suspended, posting off; the badges
    assert.ok((await list(people.Oracle, "?role=moderator")).json.accounts.every((a) => a.role === "moderator"));
    const quiet = await make("Quiet");
    await post(people.Oracle, "/api/admin/accounts/Quiet/suspend", { reason: "Testing the list", days: 2 });
    await make("Mutee");
    await request(t.base, "POST", "/api/forum/restrictions/Mutee", { cookie: people.Oracle.cookie, body: { reason: "Testing the list" } });
    const suspended = await list(people.Oracle, "?filter=suspended");
    assert.deepEqual(suspended.json.accounts.map((a) => a.username), ["Quiet"]);
    assert.ok(suspended.json.accounts[0].suspended.until, "the end of the suspension");
    const off = await list(people.Oracle, "?filter=postingoff");
    assert.deepEqual(off.json.accounts.map((a) => a.username), ["Mutee"]);
    assert.deepEqual(off.json.accounts[0].postingOff, { until: null }, "posting off with no end date");
    assert.equal((await list(people.Morpheus, "?filter=suspended")).json.accounts[0].username, "Quiet", "a moderator sees a suspended player");
    await post(people.Oracle, "/api/admin/accounts/Quiet/unsuspend");
    assert.ok(quiet.id);
    // its own rate limit, per account
    const listy = await make("Listy", "admin");
    let status = 0;
    for (let i = 0; i < 41 && status !== 429; i++) status = (await list(listy, "?q=a")).status;
    assert.equal(status, 429);
  });
});
