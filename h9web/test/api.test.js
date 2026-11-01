import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startApp, request, signup, ORIGIN } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = "correct horse battery staple";

function admin(t, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, "..", "bin", "h9web-admin.js"), "--config", t.configFile, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

describe("accounts API", () => {
  let t;
  before(async () => {
    const roomy = { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
    t = await startApp({ modules: ["notes"], limits: { signupPerIp: roomy, loginPerIp: roomy, loginPerUser: roomy } }, {
      servers: [{ name: "HAVOC 9", address: "203.0.113.10:27015" }],
      modulesDir: path.join(HERE, "fixtures", "modules"),
    });
  });
  after(async () => {
    await t.close();
  });

  test("sign up: 201, signed in, cookie HttpOnly Secure SameSite=Strict Path=/ __Host-", async () => {
    const r = await request(t.base, "POST", "/api/signup", { body: { username: "Trinity", password: PW } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { ok: true, user: { username: "Trinity", role: "user" } });
    const c = r.setCookie[0];
    assert.match(c, /^__Host-h9_session=[A-Za-z0-9_-]{43}; /);
    for (const part of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=2592000"]) assert.ok(c.includes(part), part);
    assert.ok(!/Domain=/i.test(c), "no Domain: bound to this host");
    const me = await request(t.base, "GET", "/api/me", { cookie: r.cookie });
    assert.deepEqual(me.json, { signedIn: true, user: { username: "Trinity", role: "user" } });
    assert.equal(me.headers["cache-control"], "no-store");
    const anon = await request(t.base, "GET", "/api/me");
    assert.deepEqual(anon.json, { signedIn: false });
  });

  test("sign up: taken names, any case, and look-alikes", async () => {
    await signup(t.base, "Morpheus");
    for (const name of ["morpheus", "MORPHEUS", "M0rpheus", "Morph_eus"]) {
      const r = await request(t.base, "POST", "/api/signup", { body: { username: name, password: PW } });
      assert.equal(r.status, 409, name);
      assert.equal(r.json.error, "username_taken");
    }
  });

  test("sign up: input rules", async () => {
    const cases = [
      [{ username: "ab", password: PW }, "invalid_username"],
      [{ username: "Admin", password: PW }, "invalid_username"],
      [{ username: "MSR_Official", password: PW }, "invalid_username"],
      [{ username: "has space", password: PW }, "invalid_username"],
      [{ username: "Tank", password: "short pw" }, "invalid_password"],
      [{ username: "Tank", password: "1234567890" }, "invalid_password"],
      [{ username: "Tank", password: 12345678901 }, "invalid_password"],
      [{ username: ["Tank"], password: PW }, "invalid_username"],
    ];
    for (const [body, code] of cases) {
      const r = await request(t.base, "POST", "/api/signup", { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, code);
    }
  });

  test("log in: one generic answer for a wrong password and for no such user", async () => {
    await signup(t.base, "Switch");
    const wrong = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: "not the password at all" } });
    const nobody = await request(t.base, "POST", "/api/login", { body: { username: "Nobody_Here", password: "not the password at all" } });
    assert.equal(wrong.status, 401);
    assert.equal(nobody.status, 401);
    assert.deepEqual(wrong.json, nobody.json);
    assert.equal(wrong.json.message, "Wrong username or password.");
    assert.equal(wrong.setCookie.length, 0);
    const ok = await request(t.base, "POST", "/api/login", { body: { username: "SWITCH", password: PW } });
    assert.equal(ok.status, 200, "names are case-insensitive at sign-in");
    assert.equal(ok.json.user.username, "Switch", "shown as typed at sign-up");
    assert.ok(ok.cookie);
  });

  test("sessions: log out ends the session server-side; log out everywhere ends them all", async () => {
    const c1 = await signup(t.base, "Apoc");
    const c2 = (await request(t.base, "POST", "/api/login", { body: { username: "Apoc", password: PW } })).cookie;
    const c3 = (await request(t.base, "POST", "/api/login", { body: { username: "Apoc", password: PW } })).cookie;
    assert.notEqual(c1, c2);
    const out = await request(t.base, "POST", "/api/logout", { cookie: c1 });
    assert.equal(out.status, 200);
    assert.match(out.setCookie[0], /^__Host-h9_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c1 })).json.signedIn, false, "the old cookie is dead");
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c2 })).json.signedIn, true, "other sessions stay");
    await request(t.base, "POST", "/api/logout", { cookie: c2, body: { everywhere: true } });
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c2 })).json.signedIn, false);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c3 })).json.signedIn, false);
  });

  test("sessions: forged, malformed and expired cookies sign nobody in", async () => {
    const forged = "__Host-h9_session=" + "A".repeat(43);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: forged })).json.signedIn, false);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: "__Host-h9_session=../../etc" })).json.signedIn, false);
    const c = await signup(t.base, "Dozer");
    t.app.db.prepare("UPDATE sessions SET expires_at = 1 WHERE account_id = (SELECT id FROM accounts WHERE username = 'Dozer')").run();
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c })).json.signedIn, false);
    const rows = t.app.db.prepare("SELECT token_hash FROM sessions").all();
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)), "only hashes are stored");
    const token = c.split("=")[1];
    assert.ok(!rows.some((r) => r.token_hash === token), "the token itself is never stored");
  });

  test("CSRF: state-changing requests need the site's Origin (or Referer)", async () => {
    const body = { username: "Switch", password: "wrong password here" };
    const none = await request(t.base, "POST", "/api/login", { body, origin: null });
    assert.equal(none.status, 403);
    assert.equal(none.json.error, "csrf");
    assert.equal((await request(t.base, "POST", "/api/login", { body, origin: "https://evil.example" })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/login", { body, origin: "null" })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/login", { body, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    const viaReferer = await request(t.base, "POST", "/api/login", { body, origin: null, headers: { referer: ORIGIN + "/account/login/" } });
    assert.equal(viaReferer.status, 401, "the site's Referer passes the CSRF check");
    const c = await signup(t.base, "Mouse");
    const evil = await request(t.base, "POST", "/api/logout", { cookie: c, origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c })).json.signedIn, true, "a cross-site logout did nothing");
    const form = await request(t.base, "POST", "/api/login", { body: "username=Switch&password=x", contentType: "application/x-www-form-urlencoded" });
    assert.equal(form.status, 415, "only JSON, which a cross-site form cannot send");
    const big = await request(t.base, "POST", "/api/login", { body: { username: "Switch", password: "x".repeat(5000) } });
    assert.equal(big.status, 413);
  });

  test("password change: needs the current one, ends the other sessions, keeps this browser in", async () => {
    const c1 = await signup(t.base, "Niobe");
    const c2 = (await request(t.base, "POST", "/api/login", { body: { username: "Niobe", password: PW } })).cookie;
    const wrong = await request(t.base, "POST", "/api/password", { cookie: c1, body: { currentPassword: "nope nope nope", newPassword: "a brand new long password" } });
    assert.equal(wrong.status, 403);
    const weak = await request(t.base, "POST", "/api/password", { cookie: c1, body: { currentPassword: PW, newPassword: "short" } });
    assert.equal(weak.status, 400);
    const ok = await request(t.base, "POST", "/api/password", { cookie: c1, body: { currentPassword: PW, newPassword: "a brand new long password" } });
    assert.equal(ok.status, 200);
    assert.ok(ok.cookie && ok.cookie !== c1, "a fresh session for this browser");
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: ok.cookie })).json.signedIn, true);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c1 })).json.signedIn, false);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c2 })).json.signedIn, false);
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "Niobe", password: PW } })).status, 401);
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "Niobe", password: "a brand new long password" } })).status, 200);
    assert.equal((await request(t.base, "POST", "/api/password", { body: { currentPassword: PW, newPassword: "x".repeat(20) } })).status, 401, "signed out: 401");
  });

  test("player id: 32 hex, the same at every sign-in, per account; the account page's short form and server ids", async () => {
    const c = await signup(t.base, "Ghost");
    const p1 = (await request(t.base, "GET", "/api/player", { cookie: c })).json.playerId;
    assert.match(p1, /^[0-9a-f]{32}$/);
    const c2 = (await request(t.base, "POST", "/api/login", { body: { username: "Ghost", password: PW } })).cookie;
    assert.equal((await request(t.base, "GET", "/api/player", { cookie: c2 })).json.playerId, p1);
    const other = await signup(t.base, "Sparks");
    assert.notEqual((await request(t.base, "GET", "/api/player", { cookie: other })).json.playerId, p1);
    assert.equal((await request(t.base, "GET", "/api/player")).status, 401);
    const acct = (await request(t.base, "GET", "/api/account", { cookie: c })).json;
    assert.equal(acct.playerIdShort, p1.slice(0, 8));
    assert.equal(acct.servers.length, 1);
    assert.equal(acct.servers[0].address, "203.0.113.10:27015");
    assert.match(acct.servers[0].clientId, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(acct).includes(p1), "the account page never gets the whole id");
  });

  test("suspension: refused at sign-in (after the right password only) and on every signed-in request", async () => {
    const c = await signup(t.base, "Cypher");
    const a = t.app.accounts.getByUsername("Cypher");
    t.app.accounts.ban(a.id, Math.floor(Date.now() / 1000) + 3600, "testing");
    const wrong = await request(t.base, "POST", "/api/login", { body: { username: "Cypher", password: "not the right one" } });
    assert.equal(wrong.status, 401, "a wrong password does not learn of the suspension");
    const right = await request(t.base, "POST", "/api/login", { body: { username: "Cypher", password: PW } });
    assert.equal(right.status, 403);
    assert.equal(right.json.error, "account_suspended");
    assert.equal(right.json.reason, "testing");
    assert.equal((await request(t.base, "GET", "/api/player", { cookie: c })).status, 403);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: c })).json.signedIn, false);
    t.app.accounts.unban(a.id);
    assert.equal((await request(t.base, "GET", "/api/player", { cookie: c })).status, 200);
  });

  test("module registry: routes, pages, migrations, guards and scoping", async () => {
    const list = await request(t.base, "GET", "/api/notes");
    assert.equal(list.status, 200);
    assert.equal(list.json.refusedOutside, true, "a module cannot take a path outside /api/notes and /notes");
    assert.equal((await request(t.base, "POST", "/api/notes", { body: { body: "hi" } })).status, 401);
    const c = await signup(t.base, "Oracle");
    const post = await request(t.base, "POST", "/api/notes", { cookie: c, body: { body: "hello" } });
    assert.equal(post.status, 201);
    assert.equal(post.json.by.username, "Oracle");
    assert.equal((await request(t.base, "POST", "/api/notes", { cookie: c, body: { body: "x" }, origin: "https://evil.example" })).status, 403, "the CSRF guard covers modules");
    const id = (await request(t.base, "GET", "/api/notes")).json.notes[0].id;
    assert.equal((await request(t.base, "DELETE", "/api/notes/" + id, { cookie: c })).status, 403, "a user is not a moderator");
    const a = t.app.accounts.getByUsername("Oracle");
    t.app.accounts.setRole(a.id, "moderator");
    assert.equal((await request(t.base, "DELETE", "/api/notes/" + id, { cookie: c })).status, 200);
    const page = await request(t.base, "GET", "/notes/board/1");
    assert.equal(page.status, 200);
    assert.match(page.text, /board\/1/);
    const v = t.app.db.prepare("SELECT version FROM schema_migrations WHERE module = 'notes'").all();
    assert.deepEqual(v.map((r) => r.version), [1]);
  });

  test("admin script: set-role, ban, reset-password, backup", async () => {
    await signup(t.base, "Kid");
    let r = await admin(t, "set-role", "kid", "admin");
    assert.equal(r.code, 0, r.out);
    assert.equal(t.app.accounts.getByUsername("Kid").role, "admin");
    r = await admin(t, "set-role", "kid", "overlord");
    assert.notEqual(r.code, 0);
    r = await admin(t, "ban", "Kid", "--days", "2", "--reason", "spam");
    assert.equal(r.code, 0, r.out);
    assert.ok(t.app.accounts.isBanned(t.app.accounts.getByUsername("Kid")));
    r = await admin(t, "unban", "Kid");
    assert.equal(r.code, 0, r.out);
    r = await admin(t, "reset-password", "Kid");
    assert.equal(r.code, 0, r.out);
    const pw = /shown this once: (\S+)/.exec(r.out)[1];
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "Kid", password: PW } })).status, 401);
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "Kid", password: pw } })).status, 200);
    r = await admin(t, "show", "Kid");
    assert.match(r.out, /role\s+admin/);
    r = await admin(t, "backup", path.join(t.dir, "copy.db"));
    assert.equal(r.code, 0, r.out);
    r = await admin(t, "delete", "Kid");
    assert.notEqual(r.code, 0, "delete wants --yes");
  });

  test("the logs hold no password and no session token", async () => {
    const c = await signup(t.base, "Bane", "a secret only bane knows");
    await request(t.base, "POST", "/api/login", { body: { username: "Bane", password: "a secret only bane knows" } });
    await request(t.base, "POST", "/api/login", { body: { username: "a secret typed as a name", password: "whatever whatever" } });
    const all = t.logs.join("\n");
    assert.ok(all.includes("signup"), "the log is working");
    assert.ok(!all.includes("a secret only bane knows"));
    assert.ok(!all.includes("a secret typed as a name"));
    assert.ok(!all.includes(c.split("=")[1]));
    assert.ok(!all.includes(PW));
  });
});

describe("rate limits", () => {
  let t;
  before(async () => {
    t = await startApp({
      limits: {
        loginPerIp: { max: 4, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 60 },
        loginPerUser: { max: 3, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 60 },
        signupPerIp: { max: 2, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 60 },
      },
    });
  });
  after(async () => {
    await t.close();
  });

  test("sign-up per IP, with Retry-After", async () => {
    await signup(t.base, "Alpha1", PW, { ip: "198.51.100.1" });
    await signup(t.base, "Bravo1", PW, { ip: "198.51.100.1" });
    const third = await request(t.base, "POST", "/api/signup", { body: { username: "Charlie1", password: PW }, ip: "198.51.100.1" });
    assert.equal(third.status, 429);
    assert.equal(third.headers["retry-after"], "30");
    const bad = await request(t.base, "POST", "/api/signup", { body: { username: "x", password: PW }, ip: "198.51.100.1" });
    assert.equal(bad.status, 400, "a form filled in wrong is answered, not counted");
    await signup(t.base, "Charlie1", PW, { ip: "198.51.100.2" });
  });

  test("log in per IP", async () => {
    for (let i = 0; i < 4; i++) {
      assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "user" + i, password: "wrong password " + i }, ip: "198.51.100.9" })).status, 401);
    }
    const r = await request(t.base, "POST", "/api/login", { body: { username: "Alpha1", password: PW }, ip: "198.51.100.9" });
    assert.equal(r.status, 429, "even the right password waits out the block");
    assert.ok(Number(r.headers["retry-after"]) > 0);
    assert.equal((await request(t.base, "POST", "/api/login", { body: { username: "Alpha1", password: PW }, ip: "198.51.100.10" })).status, 200);
  });

  test("log in per username, across IPs, with backoff", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await request(t.base, "POST", "/api/login", { body: { username: "Bravo1", password: "guess number " + i }, ip: "203.0.113." + (20 + i) });
      assert.equal(r.status, 401);
    }
    const fourth = await request(t.base, "POST", "/api/login", { body: { username: "bravo1", password: "guess number 4" }, ip: "203.0.113.30" });
    assert.equal(fourth.status, 429);
    const right = await request(t.base, "POST", "/api/login", { body: { username: "Bravo1", password: PW }, ip: "203.0.113.31" });
    assert.equal(right.status, 429, "blocked for the name, whatever the IP");
    const unknown = await request(t.base, "POST", "/api/login", { body: { username: "NoSuchUser9", password: "guess" }, ip: "203.0.113.32" });
    assert.equal(unknown.status, 401, "other names are not affected");
  });
});
