import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");

const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };

// Maintenance mode closes the whole site. The thing worth testing is not that it closes -- that is
// one flag -- but that closing it does not lock out the only people who can reopen it. Every test
// below is about that asymmetry.
describe("maintenance mode: the whole site closed", () => {
  let t;
  let admin;
  let user;

  const setSite = (enabled) =>
    request(t.base, "POST", "/api/admin/site", { cookie: admin, body: { part: "site", enabled } });
  const gate = (cookie) =>
    request(t.base, "GET", "/api/site/gate/site", cookie ? { cookie } : undefined);

  before(async () => {
    t = await startApp({ limits: { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY } });
    admin = await signup(t.base, "Oracle");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Oracle").id, "admin");
    user = await signup(t.base, "Trinity");
  });
  after(async () => { await t.close(); });

  test("the site starts open, and the gate lets anyone through", async () => {
    const s = (await request(t.base, "GET", "/api/site")).json;
    assert.equal(s.site.enabled, true);
    assert.equal((await gate()).status, 204);
    assert.equal((await gate(user)).status, 204);
  });

  test("only an admin may close it", async () => {
    assert.equal((await request(t.base, "POST", "/api/admin/site", { cookie: user, body: { part: "site", enabled: false } })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/admin/site", { body: { part: "site", enabled: false } })).status, 401);
    assert.equal((await request(t.base, "GET", "/api/site")).json.site.enabled, true);
  });

  test("closed: the gate refuses a visitor and a player, and passes the admin", async () => {
    assert.equal((await setSite(false)).status, 200);
    // Caddy decides what to serve from this answer alone, so the admin MUST get 204 here or the
    // person who closed the site is handed the maintenance page and can never reopen it.
    assert.equal((await gate()).status, 403, "a visitor with no session");
    assert.equal((await gate(user)).status, 403, "a signed-in player is still a visitor");
    assert.equal((await gate(admin)).status, 204, "the admin keeps browsing");
  });

  test("closed: a visitor asking for a page gets the maintenance page", async () => {
    const r = await request(t.base, "GET", "/forum/");
    assert.equal(r.status, 503);
  });

  test("closed: signing in still works, or an admin could never get in", async () => {
    // /api/site answers so the page can show the note; /api/login and /api/me answer so somebody
    // can become an admin in the first place. Those three are the whole allow list.
    assert.equal((await request(t.base, "GET", "/api/site")).status, 200);
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: admin })).status, 200);
    assert.equal((await request(t.base, "GET", "/api/me")).status, 200, "a visitor may ask who they are");
  });

  test("closed: an admin's own requests are not held", async () => {
    const r = await request(t.base, "GET", "/forum/", { cookie: admin });
    assert.notEqual(r.status, 503, "an admin browses normally while the site is closed");
  });

  test("closed: another part's gate is unaffected", async () => {
    assert.equal((await request(t.base, "GET", "/api/site/gate/downloads")).status, 204);
  });

  test("the note an admin leaves is readable while it is closed", async () => {
    assert.equal((await request(t.base, "POST", "/api/admin/site", { cookie: admin, body: { part: "site", enabled: false, note: "Back in an hour." } })).status, 200);
    assert.equal((await request(t.base, "GET", "/api/site")).json.site.note, "Back in an hour.");
  });

  test("reopened: everyone is let through again", async () => {
    assert.equal((await setSite(true)).status, 200);
    assert.equal((await request(t.base, "GET", "/api/site")).json.site.enabled, true);
    assert.equal((await gate()).status, 204);
    assert.notEqual((await request(t.base, "GET", "/forum/")).status, 503);
  });
});

// The forum's DEVELOPER flag is the other way past maintenance mode. It is not a role in ROLES:
// it is a row in forum_developers that an admin gives and takes, and core reads it directly
// because the gate has to answer before any module route runs.
describe("maintenance mode: the forum's DEVELOPER flag gets in too", () => {
  let t;
  let admin;
  let dev;
  let plain;

  const gate = (cookie) =>
    request(t.base, "GET", "/api/site/gate/site", cookie ? { cookie } : undefined);

  before(async () => {
    t = await startApp(
      { modules: ["forum"], limits: { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY } },
      { modulesDir: MODULES },
    );
    admin = await signup(t.base, "Oracle");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Oracle").id, "admin");
    dev = await signup(t.base, "Tank");
    plain = await signup(t.base, "Mouse");
    // an admin grants the flag, the same way the forum panel does
    assert.equal((await request(t.base, "POST", "/api/forum/developers/Tank", { cookie: admin, body: {} })).status, 200);
  });
  after(async () => { await t.close(); });

  test("open: everyone passes, flag or not", async () => {
    assert.equal((await gate(dev)).status, 204);
    assert.equal((await gate(plain)).status, 204);
  });

  test("closed: the developer passes, an ordinary account does not", async () => {
    assert.equal((await request(t.base, "POST", "/api/admin/site", { cookie: admin, body: { part: "site", enabled: false } })).status, 200);
    assert.equal((await gate(dev)).status, 204, "the DEVELOPER flag gets past maintenance");
    assert.equal((await gate(plain)).status, 403, "an ordinary account does not");
    assert.equal((await gate()).status, 403, "nor does a visitor with no session");
  });

  test("closed: the developer's pages are not held either", async () => {
    assert.notEqual((await request(t.base, "GET", "/forum/", { cookie: dev })).status, 503);
    assert.equal((await request(t.base, "GET", "/forum/", { cookie: plain })).status, 503);
  });

  test("the flag can be taken away again, and then they are held", async () => {
    assert.equal((await request(t.base, "DELETE", "/api/forum/developers/Tank", { cookie: admin })).status, 200);
    assert.equal((await gate(dev)).status, 403, "no longer a developer");
  });
});
