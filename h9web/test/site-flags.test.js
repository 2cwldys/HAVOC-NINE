import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, request, signup, rawUpgrade, ORIGIN } from "./helpers.js";

const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };

describe("the download area and the web client can be closed", () => {
  let t;
  let admin;
  let user;
  const post = (who, body) => request(t.base, "POST", "/api/admin/site", { cookie: who, body });
  const site = async () => (await request(t.base, "GET", "/api/site")).json;
  const gate = async (part) => (await request(t.base, "GET", "/api/site/gate/" + part)).status;

  before(async () => {
    t = await startApp({ limits: { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY } });
    admin = await signup(t.base, "Oracle");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Oracle").id, "admin");
    user = await signup(t.base, "Trinity");
  });
  after(async () => { await t.close(); });

  test("both parts start open, and the gate lets a request through", async () => {
    const s = await site();
    assert.equal(s.downloads.enabled, true);
    assert.equal(s.webclient.enabled, true);
    assert.equal(await gate("downloads"), 204);
    assert.equal(await gate("webclient"), 204);
    assert.equal(await gate("nonsense"), 404);
  });

  test("only an admin can close a part", async () => {
    assert.equal((await post(null, { part: "downloads", enabled: false })).status, 401);
    assert.equal((await post(user, { part: "downloads", enabled: false })).status, 403);
    assert.equal((await site()).downloads.enabled, true);
  });

  test("closing the downloads greys them out and shuts the gate, and the web client stays open", async () => {
    const r = await post(admin, { part: "downloads", enabled: false, note: "Back on Saturday." });
    assert.equal(r.status, 200);
    const s = await site();
    assert.deepEqual(s.downloads, { enabled: false, note: "Back on Saturday." });
    assert.equal(s.webclient.enabled, true);
    assert.equal(await gate("downloads"), 403);
    assert.equal(await gate("webclient"), 204);
    const rows = t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'site.downloads'").all();
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /"enabled":false/);
  });

  test("closing the web client closes its relay too, and opening it again opens it", async () => {
    assert.equal((await post(admin, { part: "webclient", enabled: false })).status, 200);
    assert.equal(await gate("webclient"), 403);
    assert.equal((await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie: admin })).status, 503);
    assert.equal((await post(admin, { part: "webclient", enabled: true })).status, 200);
    assert.equal(await gate("webclient"), 204);
    assert.notEqual((await rawUpgrade(t.port, "/webclient/relay", { origin: ORIGIN, cookie: admin })).status, 503);
  });

  test("the state is kept in a file, so it survives a restart, and a bad request changes nothing", async () => {
    const file = path.join(t.config.dataDir, "site-flags.json");
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(kept.downloads.enabled, false);
    assert.equal(kept.webclient.enabled, true);
    assert.equal((await post(admin, { part: "chat", enabled: false })).status, 400);
    assert.equal((await post(admin, { part: "downloads", enabled: "no" })).status, 400);
    assert.equal((await post(admin, { part: "downloads", enabled: true, note: "x".repeat(201) })).status, 400);
    assert.equal((await site()).downloads.enabled, false);
    assert.equal((await post(admin, { part: "downloads", enabled: true })).status, 200);
    assert.equal((await site()).downloads.enabled, true);
  });
});

describe("config.site decides the starting state", () => {
  test("a part set to false in config.json starts closed", async () => {
    const t = await startApp({ site: { downloads: false } });
    try {
      const s = (await request(t.base, "GET", "/api/site")).json;
      assert.equal(s.downloads.enabled, false);
      assert.equal(s.webclient.enabled, true);
    } finally {
      await t.close();
    }
  });
});
