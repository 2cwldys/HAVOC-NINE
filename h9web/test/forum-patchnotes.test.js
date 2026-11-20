// The downloads page's patch notes: anyone reads them, their editors (admins, and
// patchNotesEditors: moderators and developers by default) save the page whole, each save in the
// audit log; its checks, its markup (the post rules for pictures), the preview, CSRF.

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
  title: "Patch notes",
  intro: "What **changed**, newest first.\nhttps://i.imgur.com/AbCdE12.png\nhttps://evil.example/a.png",
  entries: [
    { version: "1.68", date: "2026-11-19", kind: "release", title: "Assault and the updater", body: "Assault mode, and the *updater* only fetches what changed." },
    { version: "1.67", date: "", kind: "hotfix", title: "", body: "" },
  ],
};

describe("the downloads page's patch notes", () => {
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
  const put = (body, cookie, opts = {}) => request(t.base, "PUT", "/api/forum/patchnotes", { cookie, body, ...opts });

  test("anyone reads them; before a save, the default page", async () => {
    const r = await request(t.base, "GET", "/api/forum/patchnotes");
    assert.equal(r.status, 200);
    assert.equal(r.json.page.title, "Patch notes");
    assert.deepEqual(r.json.page.entries, []);
    assert.equal(r.json.updated, null);
    assert.deepEqual(r.json.editors, ["moderator", "developer"]);
    assert.equal(r.json.canEdit, false);
    assert.equal((await request(t.base, "GET", "/api/forum/patchnotes", { cookie: mod })).json.canEdit, true);
    assert.equal(r.json.kinds.release, "Release");
    assert.equal(r.json.kinds.hotfix, "Hotfix");
  });

  test("staff save the whole page, into the audit log; pictures follow the post rules", async () => {
    assert.equal((await put(PAGE)).status, 401);
    assert.equal((await put(PAGE, user)).status, 403);
    assert.equal((await put(PAGE, mod, { origin: "https://evil.example" })).status, 403, "CSRF");
    assert.equal((await put(PAGE, mod)).status, 200);
    const got = (await request(t.base, "GET", "/api/forum/patchnotes")).json;
    assert.deepEqual(got.page, PAGE);
    assert.ok(got.updated);
    assert.deepEqual(got.content.intro[0].c[0], "What ");
    assert.deepEqual(got.content.intro[0].c[1], { t: "b", c: ["changed"] });
    const intro = got.content.intro[0].c;
    assert.ok(intro.some((x) => x.t === "img" && x.src === "https://i.imgur.com/AbCdE12.png"), "a picture from a listed host");
    assert.ok(intro.some((x) => x.t === "a" && x.href === "https://evil.example/a.png"), "anything else stays a link");
    assert.deepEqual(got.content.entries[0][0].c[1], { t: "i", c: ["updater"] });
    assert.deepEqual(got.content.entries[1], [], "an entry with no body renders to nothing");
    const log = t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'forum.patchnotes.edit'").get();
    assert.equal(log.detail, "2 entries, newest 1.68");
  });

  test("the order is the editor's, so the newest entry stays on top", async () => {
    const flipped = { ...PAGE, entries: [PAGE.entries[1], PAGE.entries[0]] };
    assert.equal((await put(flipped, mod)).status, 200);
    const got = (await request(t.base, "GET", "/api/forum/patchnotes")).json;
    assert.deepEqual(got.page.entries.map((x) => x.version), ["1.67", "1.68"]);
    assert.equal(t.app.db.prepare("SELECT detail FROM audit_log WHERE action = 'forum.patchnotes.edit' ORDER BY id DESC").get().detail,
      "2 entries, newest 1.67");
    assert.equal((await put(PAGE, mod)).status, 200, "put it back for the tests after this one");
  });

  test("its checks, and the preview stores nothing", async () => {
    const one = PAGE.entries[0];
    const bad = [
      { ...PAGE, title: "" },
      { ...PAGE, entries: [{ ...one, kind: "rewrite" }] },
      { ...PAGE, entries: [{ ...one, version: "" }] },
      { ...PAGE, entries: [{ ...one, version: "1.68 and a half" }] },
      { ...PAGE, entries: [{ ...one, version: "-1.68" }] },
      { ...PAGE, entries: [{ ...one, date: "19-11-2026" }] },
      { ...PAGE, entries: [{ ...one, date: "2026-13-40" }] },
      { ...PAGE, entries: [one, { ...one, title: "again" }] },
      { ...PAGE, entries: [{ ...one, body: "x".repeat(20001) }] },
      // every entry inside the limits, the page as a whole over them: over 400000 characters, but
      // still small enough to arrive, so the page's own cap is what refuses it
      { ...PAGE, entries: Array.from({ length: 24 }, (_, i) => ({ ...one, version: "1." + i, body: "x".repeat(17000) })) },
      { ...PAGE, entries: Array.from({ length: 101 }, (_, i) => ({ ...one, version: "1." + i })) },
      { ...PAGE, intro: "x".repeat(4001) },
      { ...PAGE, entries: "none" },
    ];
    for (const b of bad) assert.equal((await put(b, mod)).json.error, "invalid_page", JSON.stringify(b).slice(0, 90));
    const ok = [
      { ...PAGE, entries: [{ ...one, version: "1.68.1" }] },
      { ...PAGE, entries: [{ ...one, version: "1.69-rc1" }] },
      // what release-notes.mjs --unreleased writes: no number has been bumped yet
      { ...PAGE, entries: [{ ...one, version: "next", kind: "preview" }] },
      { ...PAGE, entries: [{ ...one, date: "" }] },
      // a busy release: a body of this size is what tools/release-notes.mjs can make
      { ...PAGE, entries: [{ ...one, body: "x".repeat(19999) }] },
      { ...PAGE, entries: [] },
    ];
    for (const g of ok) assert.equal((await put(g, mod)).status, 200, JSON.stringify(g).slice(0, 90));
    const pv = await request(t.base, "POST", "/api/forum/patchnotes/preview", { cookie: mod, body: { ...PAGE, title: "Changed" } });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.page.title, "Changed");
    assert.match((await request(t.base, "POST", "/api/forum/patchnotes/preview", { cookie: mod, body: { ...PAGE, title: "" } })).json.error, /title/);
    assert.deepEqual((await request(t.base, "GET", "/api/forum/patchnotes")).json.page.entries, [], "nothing stored: the last save stands");
    assert.equal((await request(t.base, "POST", "/api/forum/patchnotes/preview", { cookie: user, body: PAGE })).status, 403);
  });

  test("patchNotesEditors: an empty list leaves the notes to admins", async () => {
    assert.throws(() => forumSettings({ patchNotesEditors: ["user"] }), /patchNotesEditors/);
    assert.throws(() => forumSettings({ patchNotesEditors: "moderator" }), /patchNotesEditors/);
    const u = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum({ patchNotesEditors: [] }) } }, { modulesDir: MODULES });
    try {
      const m = await signup(u.base, "Tank");
      const a = await signup(u.base, "Dozer");
      u.app.accounts.setRole(u.app.accounts.getByUsername("Tank").id, "moderator");
      u.app.accounts.setRole(u.app.accounts.getByUsername("Dozer").id, "admin");
      assert.equal((await request(u.base, "PUT", "/api/forum/patchnotes", { cookie: m, body: PAGE })).status, 403);
      assert.equal((await request(u.base, "PUT", "/api/forum/patchnotes", { cookie: a, body: PAGE })).status, 200);
      assert.deepEqual((await request(u.base, "GET", "/api/forum/patchnotes")).json.editors, []);
    } finally {
      await u.close();
    }
  });

  test("a developer edits them, and the two pages keep their own settings", async () => {
    const dev = await signup(t.base, "Switch");
    assert.equal((await put(PAGE, dev)).status, 403, "not yet");
    assert.equal((await request(t.base, "POST", "/api/forum/developers/Switch", { cookie: adm, body: {} })).status, 200);
    assert.equal((await put(PAGE, dev)).status, 200, "a developer edits the patch notes");
    // the two pages are stored apart: saving one leaves the other alone
    assert.deepEqual((await request(t.base, "GET", "/api/forum/needs")).json.page.items, []);
  });
});
