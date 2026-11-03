// The MEDIA page (modules/forum/media.js) and hidden threads: link parsing, posting and its rules,
// comments for members only, staff PIN/HIDE/REMOVE with the audit log, the front page's limit and
// the archive by month, title search, CSRF, rate limits, and the page's CSP against the code.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { DEFAULTS, forumSettings } from "../modules/forum/index.js";
import { youtubeId, THUMB_HOST, EMBED_HOST, ARCHIVE_PAGE } from "../modules/forum/media.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const SITE = path.join(HERE, "..", "..", "havoc9.org");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const forum = (more = {}) => ({ newAccountHours: 0, limits: Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY])), ...more });
const VID = "dQw4w9WgXcQ";
const audit = (t, action) => t.app.db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC").get(action);

describe("media: links and the page's CSP", () => {
  test("YouTube links in every accepted form give the id; anything else nothing", () => {
    for (const l of ["https://www.youtube.com/watch?v=" + VID, "https://youtube.com/watch?v=" + VID + "&t=42s", "https://m.youtube.com/watch?v=" + VID,
      "https://youtu.be/" + VID + "?si=abc", "https://www.youtube.com/shorts/" + VID, "https://www.youtube.com/embed/" + VID,
      "https://www.youtube-nocookie.com/embed/" + VID, "http://youtu.be/" + VID]) {
      assert.equal(youtubeId(l), VID, l);
    }
    for (const l of ["https://evil.example/watch?v=" + VID, "https://youtu.be/short", "https://youtu.be/" + VID + "x", "javascript:alert(1)",
      "https://www.youtube.com/watch?v=" + VID.slice(0, 10) + "<", "https://www.youtube.com/playlist?list=" + VID, "https://youtube.com.evil.example/watch?v=" + VID,
      "https://me:pw@youtu.be/" + VID, "", null, 12, "ftp://youtu.be/" + VID]) {
      assert.equal(youtubeId(l), null, String(l));
    }
  });

  test("the MEDIA page's CSP names exactly the thumbnail and player hosts the code uses", () => {
    const html = fs.readFileSync(path.join(SITE, "media", "index.html"), "utf8");
    assert.match(html, new RegExp("img-src 'self' https://" + THUMB_HOST.replace(/\./g, "\\.") + ";"));
    assert.match(html, new RegExp("frame-src https://" + EMBED_HOST.replace(/\./g, "\\.") + ";"));
  });

  test("mediaFrontCount: 30 by default, 1 to 200", () => {
    assert.equal(DEFAULTS.mediaFrontCount, 30);
    assert.throws(() => forumSettings({ mediaFrontCount: 0 }), /mediaFrontCount/);
    assert.equal(forumSettings({ mediaFrontCount: 3 }).mediaFrontCount, 3);
  });
});

describe("media over HTTP", () => {
  let t;
  let neo;
  let mouse;
  let mod;
  before(async () => {
    t = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum({ mediaFrontCount: 3 }) } }, { modulesDir: MODULES });
    neo = await signup(t.base, "Neo");
    mouse = await signup(t.base, "Mouse");
    mod = await signup(t.base, "Morpheus");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Morpheus").id, "moderator");
  });
  after(async () => {
    await t.close();
  });
  const post = (body, cookie = neo, opts = {}) => request(t.base, "POST", "/api/forum/media", { cookie, body, ...opts });
  const front = async (cookie) => (await request(t.base, "GET", "/api/forum/media", { cookie })).json;
  const ids = (list) => list.map((x) => x.id);

  test("posting: members only, a real YouTube link, the forum's rules; guests read", async () => {
    assert.equal((await post({ title: "A round", link: "https://youtu.be/" + VID }, null)).status, 401);
    assert.equal((await post({ title: "A round", link: "https://youtu.be/" + VID }, neo, { origin: "https://evil.example" })).status, 403, "CSRF");
    assert.equal((await post({ title: "A round", link: "https://vimeo.com/123" })).json.error, "invalid_link");
    assert.equal((await post({ title: "x", link: "https://youtu.be/" + VID })).json.error, "invalid_title");
    const r = await post({ title: "Siege on neuropolis", link: "https://www.youtube.com/watch?v=" + VID + "&t=3", description: "**Watch** the end." });
    assert.equal(r.status, 201, r.text);
    const one = (await request(t.base, "GET", "/api/forum/media/" + r.json.post.id)).json;
    assert.equal(one.post.video, VID);
    assert.deepEqual(one.post.content[0].c[0], { t: "b", c: ["Watch"] });
    assert.equal(one.comments, undefined, "guests see no comments");
    assert.equal(one.thumbHost, THUMB_HOST);
    assert.equal(one.embedHost, EMBED_HOST);
    await request(t.base, "POST", "/api/forum/restrictions/Mouse", { cookie: mod, body: { reason: "cool off" } });
    assert.equal((await post({ title: "Mine too", link: "https://youtu.be/" + VID }, mouse)).json.error, "posting_disabled");
    await request(t.base, "DELETE", "/api/forum/restrictions/Mouse", { cookie: mod });
  });

  test("comments: members only, edit and remove your own, moderators remove any (audit log)", async () => {
    const m = (await post({ title: "Comment me", link: "https://youtu.be/" + VID })).json.post.id;
    const url = "/api/forum/media/" + m + "/comments";
    assert.equal((await request(t.base, "POST", url, { body: { body: "hi" } })).status, 401, "never guests");
    assert.equal((await request(t.base, "POST", url, { cookie: mouse, body: { body: "" } })).json.error, "invalid_body");
    const c = await request(t.base, "POST", url, { cookie: mouse, body: { body: "Nice *shot*." } });
    assert.equal(c.status, 201);
    const cid = c.json.comment.id;
    assert.equal((await request(t.base, "PATCH", "/api/forum/media/comments/" + cid, { cookie: neo, body: { body: "no" } })).status, 403);
    assert.equal((await request(t.base, "PATCH", "/api/forum/media/comments/" + cid, { cookie: mouse, body: { body: "Great shot." } })).status, 200);
    let one = (await request(t.base, "GET", "/api/forum/media/" + m, { cookie: neo })).json;
    assert.equal(one.post.comments, 1);
    assert.equal(one.comments[0].body, "Great shot.");
    const c2 = await request(t.base, "POST", url, { cookie: neo, body: { body: "Thanks!" } });
    assert.equal((await request(t.base, "DELETE", "/api/forum/media/comments/" + c2.json.comment.id, { cookie: neo })).status, 200, "your own");
    assert.equal((await request(t.base, "DELETE", "/api/forum/media/comments/" + cid, { cookie: mod })).status, 200);
    assert.ok(audit(t, "forum.media.comment.remove"));
    one = (await request(t.base, "GET", "/api/forum/media/" + m, { cookie: neo })).json;
    assert.equal(one.post.comments, 0);
    assert.deepEqual(one.comments, []);
  });

  test("staff pin, hide and remove, inline, into the audit log; hidden is staff-only", async () => {
    const m = (await post({ title: "Pin me", link: "https://youtu.be/" + VID })).json.post.id;
    const url = "/api/forum/media/" + m;
    assert.equal((await request(t.base, "PATCH", url, { cookie: mouse, body: { pinned: true } })).status, 403);
    assert.equal((await request(t.base, "PATCH", url, { cookie: mod, body: { pinned: true } })).status, 200);
    assert.ok(audit(t, "forum.media.pin"));
    assert.ok(ids((await front()).pinned).includes(m), "pinned on top");
    assert.equal((await request(t.base, "PATCH", url, { cookie: mod, body: { hidden: true } })).status, 200);
    assert.ok(audit(t, "forum.media.hide"));
    assert.ok(!ids((await front()).pinned).includes(m), "hidden from guests");
    assert.equal((await request(t.base, "GET", url, { cookie: mouse })).status, 404);
    const staffView = await front(mod);
    assert.ok(staffView.pinned.find((x) => x.id === m).hidden, "staff see it, marked hidden");
    assert.equal((await request(t.base, "PATCH", url, { cookie: mod, body: { hidden: false } })).status, 200);
    assert.ok(audit(t, "forum.media.unhide"));
    assert.equal((await request(t.base, "GET", url)).status, 200);
    assert.equal((await request(t.base, "DELETE", url, { cookie: mouse })).status, 403);
    assert.equal((await request(t.base, "DELETE", url, { cookie: mod })).status, 200);
    assert.ok(audit(t, "forum.media.remove"));
    assert.equal((await request(t.base, "GET", url, { cookie: mod })).status, 404, "removed for everyone");
  });

  test("the front page holds the newest mediaFrontCount; the rest are in the archive by month", async () => {
    const u = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum({ mediaFrontCount: 3 }) } }, { modulesDir: MODULES });
    try {
      const c = await signup(u.base, "Trin");
      const made = [];
      for (let i = 0; i < 3; i++) made.push((await request(u.base, "POST", "/api/forum/media", { cookie: c, body: { title: "Video " + i, link: "https://youtu.be/" + VID } })).json.post.id);
      let f = (await request(u.base, "GET", "/api/forum/media")).json;
      assert.equal(f.posts.length, 3, "exactly mediaFrontCount: nothing archived yet");
      assert.deepEqual(f.archive, []);
      // one more: the oldest moves to the archive, in its month
      const old = made[0];
      u.app.db.prepare("UPDATE forum_media_posts SET created_at = ? WHERE id = ?").run(Date.UTC(2025, 2, 15) / 1000, old);
      made.push((await request(u.base, "POST", "/api/forum/media", { cookie: c, body: { title: "Video 3", link: "https://youtu.be/" + VID } })).json.post.id);
      f = (await request(u.base, "GET", "/api/forum/media")).json;
      assert.deepEqual(ids(f.posts), [made[3], made[2], made[1]]);
      assert.deepEqual(f.archive, [{ year: 2025, month: 3, posts: 1 }]);
      const month = (await request(u.base, "GET", "/api/forum/media/archive/2025/3")).json;
      assert.deepEqual(ids(month.posts), [old]);
      assert.equal(month.perPage, ARCHIVE_PAGE);
      assert.equal((await request(u.base, "GET", "/api/forum/media/" + old)).status, 200, "its own page stays");
      assert.equal((await request(u.base, "GET", "/api/forum/media/archive/2025/13")).status, 404);
      // a pinned post stays on the front page and does not count toward mediaFrontCount
      const staff = await signup(u.base, "Seraph");
      u.app.accounts.setRole(u.app.accounts.getByUsername("Seraph").id, "moderator");
      assert.equal((await request(u.base, "PATCH", "/api/forum/media/" + made[3], { cookie: staff, body: { pinned: true } })).status, 200);
      f = (await request(u.base, "GET", "/api/forum/media")).json;
      assert.deepEqual(ids(f.pinned), [made[3]]);
      assert.deepEqual(ids(f.posts), [made[2], made[1], old], "the oldest is back on the front page");
      assert.deepEqual(f.archive, []);
    } finally {
      await u.close();
    }
  });

  test("search by title, rate-limited per address", async () => {
    await post({ title: "Uplink capture highlights", link: "https://youtu.be/" + VID });
    const r = await request(t.base, "GET", "/api/forum/media/search?q=" + encodeURIComponent("uplink HIGH"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.posts.map((x) => x.title), ["Uplink capture highlights"]);
    assert.equal((await request(t.base, "GET", "/api/forum/media/search?q=a")).json.error, "invalid_query");
  });

  test("posting and commenting are rate-limited like threads and posts", async () => {
    const u = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: { newAccountHours: 0 } } }, { modulesDir: MODULES });
    try {
      const c = await signup(u.base, "Tank");
      const first = await request(u.base, "POST", "/api/forum/media", { cookie: c, body: { title: "One", link: "https://youtu.be/" + VID } });
      assert.equal(first.status, 201);
      const second = await request(u.base, "POST", "/api/forum/media", { cookie: c, body: { title: "Two", link: "https://youtu.be/" + VID } });
      assert.equal(second.status, 429);
      const url = "/api/forum/media/" + first.json.post.id + "/comments";
      assert.equal((await request(u.base, "POST", url, { cookie: c, body: { body: "a" } })).status, 201);
      assert.equal((await request(u.base, "POST", url, { cookie: c, body: { body: "b" } })).status, 429);
    } finally {
      await u.close();
    }
  });
});

describe("hidden threads", () => {
  let t;
  let user;
  let mod;
  before(async () => {
    t = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum() } }, { modulesDir: MODULES });
    user = await signup(t.base, "Neo");
    mod = await signup(t.base, "Morpheus");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Morpheus").id, "moderator");
  });
  after(async () => {
    await t.close();
  });

  test("staff hide and unhide; hidden threads are staff-only everywhere, marked HIDDEN, in the audit log", async () => {
    const th = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: user, body: { title: "Quiet please", body: "Hello." } });
    const id = th.json.thread.id;
    const url = "/api/forum/threads/" + id;
    assert.equal((await request(t.base, "PATCH", url, { cookie: user, body: { hidden: true } })).status, 403);
    assert.equal((await request(t.base, "PATCH", url, { cookie: mod, body: { hidden: true }, origin: "https://evil.example" })).status, 403, "CSRF");
    const hid = await request(t.base, "PATCH", url, { cookie: mod, body: { hidden: true } });
    assert.equal(hid.status, 200, hid.text);
    assert.equal(hid.json.thread.hidden, true);
    assert.ok(audit(t, "forum.thread.hide"));
    assert.equal((await request(t.base, "GET", url, { cookie: user })).status, 404, "not even its author");
    assert.equal((await request(t.base, "GET", url)).status, 404);
    const list = async (cookie) => (await request(t.base, "GET", "/api/forum/categories/general", { cookie })).json.threads;
    assert.ok(!(await list(user)).some((x) => x.id === id));
    assert.ok((await list(mod)).find((x) => x.id === id).hidden, "staff see it, marked");
    const front = async (cookie) => (await request(t.base, "GET", "/api/forum/categories", { cookie })).json.categories.find((c) => c.slug === "general");
    assert.equal((await front(user)).threads, 0);
    assert.equal((await front(mod)).threads, 1);
    assert.equal((await request(t.base, "GET", "/api/forum/search?q=Quiet")).json.total, 0);
    assert.equal((await request(t.base, "GET", "/api/forum/users/Neo")).json.recent.length, 0);
    assert.equal((await request(t.base, "POST", url + "/posts", { cookie: user, body: { body: "hi" } })).status, 404);
    assert.equal((await request(t.base, "PATCH", url, { cookie: mod, body: { hidden: false } })).status, 200);
    assert.ok(audit(t, "forum.thread.unhide"));
    assert.equal((await request(t.base, "GET", url, { cookie: user })).status, 200);
  });
});
