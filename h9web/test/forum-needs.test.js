// The "What we need" page: anyone reads it, its editors (admins, and needsEditors: moderators and
// developers by default) save it whole, each save in the audit log; its checks, its markup (the
// post rules for pictures), the preview, CSRF; and the DEVELOPER flag admins give.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { DEFAULTS, forumSettings } from "../modules/forum/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const forum = (more = {}) => ({ limits: Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY])), ...more });
const PAGE = {
  title: "What we need",
  intro: "We are **looking** for help.\nhttps://i.imgur.com/AbCdE12.png\nhttps://evil.example/a.png",
  items: [
    { category: "maps", status: "needed", title: "A Siege map", description: "Two teams, *five* objectives." },
    { category: "direction", status: "in_progress", title: "Season plan", description: "" },
  ],
};

describe("the What we need page", () => {
  let t;
  let user;
  let mod;
  let adm;
  before(async () => {
    t = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum() } }, { modulesDir: MODULES });
    user = await signup(t.base, "Neo");
    mod = await signup(t.base, "Morpheus");
    adm = await signup(t.base, "Oracle");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Morpheus").id, "moderator");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Oracle").id, "admin");
  });
  after(async () => {
    await t.close();
  });
  const put = (body, cookie, opts = {}) => request(t.base, "PUT", "/api/forum/needs", { cookie, body, ...opts });

  test("anyone reads it; before a save, the default page", async () => {
    const r = await request(t.base, "GET", "/api/forum/needs");
    assert.equal(r.status, 200);
    assert.equal(r.json.page.title, "What we need");
    assert.deepEqual(r.json.page.items, []);
    assert.equal(r.json.updated, null);
    assert.deepEqual(r.json.editors, ["moderator", "developer"]);
    assert.equal(r.json.canEdit, false);
    assert.equal((await request(t.base, "GET", "/api/forum/needs", { cookie: mod })).json.canEdit, true);
    assert.equal(r.json.categories.maps, "Maps");
    assert.equal(r.json.statuses.in_progress, "In progress");
  });

  test("staff save the whole page, into the audit log; pictures follow the post rules", async () => {
    assert.equal((await put(PAGE)).status, 401);
    assert.equal((await put(PAGE, user)).status, 403);
    assert.equal((await put(PAGE, mod, { origin: "https://evil.example" })).status, 403, "CSRF");
    const r = await put(PAGE, mod);
    assert.equal(r.status, 200, r.text);
    const got = (await request(t.base, "GET", "/api/forum/needs")).json;
    assert.deepEqual(got.page, PAGE);
    assert.ok(got.updated);
    assert.deepEqual(got.content.intro[0].c[0], "We are ");
    assert.deepEqual(got.content.intro[0].c[1], { t: "b", c: ["looking"] });
    const intro = got.content.intro[0].c;
    assert.ok(intro.some((x) => x.t === "img" && x.src === "https://i.imgur.com/AbCdE12.png"), "a picture from a listed host");
    assert.ok(intro.some((x) => x.t === "a" && x.href === "https://evil.example/a.png"), "anything else stays a link");
    assert.deepEqual(got.content.items[0][0].c[1], { t: "i", c: ["five"] });
    const log = t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'forum.needs.edit'").get();
    assert.equal(log.detail, "2 items (1 needed, 1 in progress, 0 done)");
  });

  test("its checks, and the preview stores nothing", async () => {
    const bad = [
      { ...PAGE, title: "" },
      { ...PAGE, items: [{ ...PAGE.items[0], category: "money" }] },
      { ...PAGE, items: [{ ...PAGE.items[0], status: "maybe" }] },
      { ...PAGE, items: [{ ...PAGE.items[0], title: "" }] },
      { ...PAGE, items: Array.from({ length: 51 }, () => PAGE.items[0]) },
      { ...PAGE, intro: "x".repeat(4001) },
      { ...PAGE, items: "none" },
    ];
    for (const b of bad) assert.equal((await put(b, mod)).json.error, "invalid_page", JSON.stringify(b).slice(0, 80));
    const pv = await request(t.base, "POST", "/api/forum/needs/preview", { cookie: mod, body: { ...PAGE, title: "Changed" } });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.page.title, "Changed");
    assert.match((await request(t.base, "POST", "/api/forum/needs/preview", { cookie: mod, body: { ...PAGE, title: "" } })).json.error, /title/);
    assert.equal((await request(t.base, "GET", "/api/forum/needs")).json.page.title, "What we need", "nothing stored");
    assert.equal((await request(t.base, "POST", "/api/forum/needs/preview", { cookie: user, body: PAGE })).status, 403);
  });

  test("needsEditors: an empty list leaves the page to admins", async () => {
    assert.throws(() => forumSettings({ needsEditors: ["user"] }), /needsEditors/);
    assert.throws(() => forumSettings({ needsEditors: "moderator" }), /needsEditors/);
    const u = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum({ needsEditors: [] }) } }, { modulesDir: MODULES });
    try {
      const m = await signup(u.base, "Tank");
      const a = await signup(u.base, "Dozer");
      u.app.accounts.setRole(u.app.accounts.getByUsername("Tank").id, "moderator");
      u.app.accounts.setRole(u.app.accounts.getByUsername("Dozer").id, "admin");
      assert.equal((await request(u.base, "PUT", "/api/forum/needs", { cookie: m, body: PAGE })).status, 403);
      assert.equal((await request(u.base, "PUT", "/api/forum/needs", { cookie: a, body: PAGE })).status, 200);
      assert.deepEqual((await request(u.base, "GET", "/api/forum/needs")).json.editors, []);
    } finally {
      await u.close();
    }
  });

  test("DEVELOPER: admins give and take it, into the audit log; purple names; it edits the page", async () => {
    const dev = await signup(t.base, "Switch");
    const url = "/api/forum/developers/Switch";
    assert.equal((await request(t.base, "POST", url, { cookie: mod, body: {} })).status, 403, "admins only");
    assert.equal((await request(t.base, "POST", url, { cookie: adm, body: {}, origin: "https://evil.example" })).status, 403, "CSRF");
    assert.equal((await put(PAGE, dev)).status, 403, "not yet");
    const on = await request(t.base, "POST", url, { cookie: adm, body: {} });
    assert.equal(on.json.changed, true);
    assert.equal((await request(t.base, "GET", url, { cookie: adm })).json.developer, true);
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'forum.developer.add'").get());
    assert.equal((await put(PAGE, dev)).status, 200, "a developer edits What we need");
    assert.equal((await request(t.base, "POST", "/api/forum/restrictions/Neo", { cookie: dev, body: { reason: "nope" } })).status, 403, "and nothing a moderator does");
    const th = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: dev, body: { title: "Dev notes", body: "Hi." } });
    const view = (await request(t.base, "GET", "/api/forum/threads/" + th.json.thread.id)).json;
    assert.equal(view.thread.by.developer, true);
    assert.equal(view.posts[0].by.developer, true);
    const row = (await request(t.base, "GET", "/api/forum/categories/general")).json.threads.find((x) => x.id === th.json.thread.id);
    assert.equal(row.by.developer, true);
    assert.equal(row.lastByDeveloper, true);
    assert.equal((await request(t.base, "GET", "/api/forum/users/Switch")).json.user.developer, true);
    // with a role: a developer moderator keeps both
    t.app.accounts.setRole(t.app.accounts.getByUsername("Switch").id, "moderator");
    assert.equal((await request(t.base, "GET", "/api/forum/users/Switch")).json.user.developer, true);
    const off = await request(t.base, "DELETE", url, { cookie: adm });
    assert.equal(off.json.changed, true);
    assert.ok(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'forum.developer.remove'").get());
    assert.equal((await request(t.base, "GET", "/api/forum/users/Switch")).json.user.developer, false);
  });

  test("the Suggestions category is there, once, for everyone", async () => {
    const cats = (await request(t.base, "GET", "/api/forum/categories")).json.categories;
    const s = cats.filter((c) => c.slug === "suggestions");
    assert.equal(s.length, 1);
    assert.equal(s[0].name, "Suggestions");
    assert.equal(s[0].canStart, false, "a guest starts nothing");
    const r = await request(t.base, "POST", "/api/forum/categories/suggestions/threads", { cookie: adm, body: { title: "More maps", body: "Please." } });
    assert.equal(r.status, 201);
  });
});
