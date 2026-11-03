import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import forum, { DEFAULTS } from "../modules/forum/index.js";
import { openDatabase, migrate } from "../lib/db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const roomyForum = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
const CORE_ROOMY = { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY };

function forumApp(settings = {}) {
  return startApp({ modules: ["forum"], limits: CORE_ROOMY, moduleSettings: { forum: { limits: roomyForum(), ...settings } } }, { modulesDir: MODULES });
}

async function account(t, name, role = "user") {
  const cookie = await signup(t.base, name);
  const a = t.app.accounts.getByUsername(name);
  if (role !== "user") t.app.accounts.setRole(a.id, role);
  return { cookie, id: a.id, name };
}

async function startThread(t, who, slug, title, body, opts = {}) {
  const r = await request(t.base, "POST", "/api/forum/categories/" + slug + "/threads", { cookie: who.cookie, body: { title, body }, ...opts });
  return r;
}

const reply = (t, who, threadId, body, opts = {}) =>
  request(t.base, "POST", "/api/forum/threads/" + threadId + "/posts", { cookie: who.cookie, body: { body }, ...opts });
const get = (t, p, who) => request(t.base, "GET", p, { cookie: who ? who.cookie : undefined });
const auditRows = (t, action) => t.app.db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action);

describe("forum: reading, writing and roles", () => {
  let t;
  let user;
  let other;
  let mod;
  let adm;
  before(async () => {
    t = await forumApp();
    user = await account(t, "Trinity");
    other = await account(t, "Switch");
    mod = await account(t, "Morpheus", "moderator");
    adm = await account(t, "Oracle", "admin");
  });
  after(async () => {
    await t.close();
  });

  test("the seeded categories, in order, readable by guests", async () => {
    const r = await get(t, "/api/forum/categories");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.categories.map((c) => c.slug), ["announcements", "general", "servers", "roleplay", "modding", "support", "off-topic", "suggestions"]);
    assert.deepEqual(r.json.categories.map((c) => c.name), ["Announcements", "General", "Servers", "Roleplay", "Modding", "Support", "Off-topic", "Suggestions"]);
    assert.equal(r.json.categories[0].startRole, "moderator");
    assert.equal(r.json.categories[0].canStart, false);
    assert.deepEqual(r.json.viewer, { signedIn: false });
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(r.headers["content-security-policy"], /default-src 'none'/);
  });

  test("a thread: started, read by a guest, replied to, counted", async () => {
    const r = await startThread(t, user, "general", "  First   thread\n here ", "Hello **world**.\n\nSecond paragraph.");
    assert.equal(r.status, 201, r.text);
    const id = r.json.thread.id;
    const g = await get(t, "/api/forum/threads/" + id);
    assert.equal(g.status, 200);
    assert.equal(g.json.thread.title, "First thread here", "a title is one line, its white space collapsed");
    assert.equal(g.json.thread.can.reply, false);
    assert.equal(g.json.thread.replyBlock, "signin");
    const p = g.json.posts[0];
    assert.equal(p.number, 1);
    assert.equal(p.by.username, "Trinity");
    assert.equal(p.by.posts, 1);
    assert.equal(p.body, "Hello **world**.\n\nSecond paragraph.");
    assert.deepEqual(p.content, [{ t: "p", c: ["Hello ", { t: "b", c: ["world"] }, "."] }, { t: "p", c: ["Second paragraph."] }]);
    assert.equal(p.can.report, false, "a guest reports nothing");
    const rr = await reply(t, other, id, "A reply.");
    assert.equal(rr.status, 201);
    assert.equal(rr.json.page, 1);
    const list = await get(t, "/api/forum/categories/general");
    const row = list.json.threads.find((x) => x.id === id);
    assert.equal(row.posts, 2);
    assert.equal(row.lastBy, "Switch");
    const cats = await get(t, "/api/forum/categories");
    const general = cats.json.categories.find((c) => c.slug === "general");
    assert.ok(general.threads >= 1 && general.posts >= 2);
    assert.equal(general.last.title, "First thread here");
  });

  test("input rules: titles, bodies, sizes, unknown things", async () => {
    const cases = [
      [{ title: "ab", body: "x" }, 400, "invalid_title"],
      [{ title: "x".repeat(121), body: "x" }, 400, "invalid_title"],
      [{ title: "Fine title", body: "   \n  " }, 400, "invalid_body"],
      [{ title: "Fine title", body: "y".repeat(10001) }, 400, "invalid_body"],
      [{ title: ["array"], body: "x" }, 400, "invalid_title"],
      [{ title: "Fine title", body: 42 }, 400, "invalid_body"],
    ];
    for (const [body, status, code] of cases) {
      const r = await startThread(t, user, "general", body.title, body.body);
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
      assert.equal(r.json.error, code);
    }
    assert.equal((await startThread(t, user, "general", "Fine title", "y".repeat(10000))).status, 201, "10,000 characters is the limit");
    assert.equal((await startThread(t, user, "no-such-board", "Fine title", "x")).status, 404);
    assert.equal((await get(t, "/api/forum/threads/999999")).status, 404);
    assert.equal((await get(t, "/api/forum/threads/abc")).status, 404);
    assert.equal((await get(t, "/api/forum/categories/..%2Fadmin")).status, 404);
    const form = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: user.cookie, body: "title=x&body=y", contentType: "application/x-www-form-urlencoded" });
    assert.equal(form.status, 415, "JSON only");
  });

  test("roles: who starts threads where, who moderates, who runs the categories", async () => {
    assert.equal((await startThread(t, user, "announcements", "News from me", "x")).status, 403, "a user starts no announcement");
    const news = await startThread(t, mod, "announcements", "Real news", "Moderators start these.");
    assert.equal(news.status, 201);
    assert.equal((await startThread(t, adm, "announcements", "Admin news", "And admins.")).status, 201);
    assert.equal((await reply(t, user, news.json.thread.id, "Users reply to them.")).status, 201);
    const id = news.json.thread.id;
    for (const body of [{ pinned: true }, { locked: true }, { category: "general" }]) {
      const r = await request(t.base, "PATCH", "/api/forum/threads/" + id, { cookie: user.cookie, body });
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal((await request(t.base, "DELETE", "/api/forum/threads/" + id, { cookie: user.cookie })).status, 403);
    assert.equal((await get(t, "/api/forum/reports", user)).status, 403);
    assert.equal((await get(t, "/api/forum/removed", user)).status, 403);
    assert.equal((await get(t, "/api/forum/reports")).status, 401);
    assert.equal((await get(t, "/api/forum/reports", mod)).status, 200);
    const add = { slug: "events", name: "Events", description: "Match nights.", startRole: "user", replyRole: "user" };
    assert.equal((await request(t.base, "POST", "/api/forum/categories", { cookie: mod.cookie, body: add })).status, 403, "moderators do not run categories");
    const made = await request(t.base, "POST", "/api/forum/categories", { cookie: adm.cookie, body: add });
    assert.equal(made.status, 201);
    assert.equal((await request(t.base, "POST", "/api/forum/categories", { cookie: adm.cookie, body: add })).status, 409);
    assert.equal((await request(t.base, "POST", "/api/forum/categories", { cookie: adm.cookie, body: { ...add, slug: "Bad Slug!" } })).status, 400);
    const edit = await request(t.base, "PATCH", "/api/forum/categories/events", { cookie: adm.cookie, body: { name: "Events and matches", replyRole: "moderator" } });
    assert.equal(edit.status, 200);
    assert.equal(edit.json.category.replyRole, "moderator");
    const up = await request(t.base, "PATCH", "/api/forum/categories/events", { cookie: adm.cookie, body: { move: "up" } });
    assert.equal(up.json.changed, true);
    const order = (await get(t, "/api/forum/categories")).json.categories.map((c) => c.slug);
    assert.deepEqual(order.slice(-2), ["events", "suggestions"]);
    const ev = await startThread(t, user, "events", "Match night", "Who is in?");
    assert.equal(ev.status, 201);
    assert.equal((await reply(t, other, ev.json.thread.id, "me")).status, 403, "replyRole moderator");
    const del = await request(t.base, "DELETE", "/api/forum/categories/events", { cookie: adm.cookie });
    assert.equal(del.status, 409, "a category with threads stays");
    assert.equal((await request(t.base, "PATCH", "/api/forum/threads/" + ev.json.thread.id, { cookie: mod.cookie, body: { category: "off-topic" } })).status, 200);
    assert.equal((await request(t.base, "DELETE", "/api/forum/categories/events", { cookie: adm.cookie })).status, 200);
    assert.ok(auditRows(t, "forum.category.add").length === 1 && auditRows(t, "forum.category.remove").length === 1);
    assert.equal(auditRows(t, "forum.thread.move")[0].detail, "Events and matches -> Off-topic");
  });

  test("editing: the author within the window, a moderator any time, nobody else", async () => {
    const th = await startThread(t, user, "general", "Edit me", "first version");
    const postId = th.json.post.id;
    const edit = (who, body) => request(t.base, "PATCH", "/api/forum/posts/" + postId, { cookie: who.cookie, body: { body } });
    assert.equal((await edit(user, "second version")).status, 200);
    assert.equal((await edit(other, "vandal")).status, 403);
    const view = (await get(t, "/api/forum/threads/" + th.json.thread.id)).json.posts[0];
    assert.equal(view.body, "second version");
    assert.equal(view.edited.byModerator, false);
    t.app.db.prepare("UPDATE forum_posts SET created_at = created_at - 7200 WHERE id = ?").run(postId);
    const late = await edit(user, "third version");
    assert.equal(late.status, 403);
    assert.equal(late.json.error, "edit_window_closed");
    assert.equal((await edit(mod, "fixed by a moderator")).status, 200);
    const after = (await get(t, "/api/forum/threads/" + th.json.thread.id)).json.posts[0];
    assert.equal(after.body, "fixed by a moderator");
    assert.equal(after.edited.byModerator, true);
    const rows = auditRows(t, "forum.post.edit");
    assert.equal(rows.at(-1).actor_name, "Morpheus");
    assert.equal(rows.at(-1).target_name, "Trinity");
    assert.equal(rows.at(-1).subject, "post " + postId);
    const title = await request(t.base, "PATCH", "/api/forum/threads/" + th.json.thread.id, { cookie: user.cookie, body: { title: "Edited title" } });
    assert.equal(title.status, 200, "the author renames their own thread in the window");
    t.app.db.prepare("UPDATE forum_threads SET created_at = created_at - 7200 WHERE id = ?").run(th.json.thread.id);
    assert.equal((await request(t.base, "PATCH", "/api/forum/threads/" + th.json.thread.id, { cookie: user.cookie, body: { title: "Too late" } })).status, 403);
  });

  test("soft deletes: placeholders, what moderators see, restore, and a thread left empty", async () => {
    const th = await startThread(t, user, "general", "Short lived", "only post");
    const tid = th.json.thread.id;
    const r2 = await reply(t, other, tid, "a reply to remove");
    const del = await request(t.base, "DELETE", "/api/forum/posts/" + r2.json.post.id, { cookie: other.cookie });
    assert.equal(del.status, 200);
    let view = await get(t, "/api/forum/threads/" + tid);
    const gone = view.json.posts[1];
    assert.equal(gone.removed, "author");
    assert.equal(gone.body, undefined, "a removed post's text is not sent to readers");
    assert.equal(gone.content, undefined);
    const modView = (await get(t, "/api/forum/threads/" + tid, mod)).json.posts[1];
    assert.equal(modView.body, "a reply to remove", "moderators still see it");
    assert.equal(modView.can.restore, true);
    assert.equal((await request(t.base, "POST", "/api/forum/posts/" + r2.json.post.id + "/restore", { cookie: user.cookie })).status, 403);
    // the author removes the first and now only post: the thread goes with it
    const first = await request(t.base, "DELETE", "/api/forum/posts/" + th.json.post.id, { cookie: user.cookie });
    assert.equal(first.json.threadRemoved, true);
    assert.equal((await get(t, "/api/forum/threads/" + tid)).status, 404);
    assert.ok(!(await get(t, "/api/forum/categories/general")).json.threads.some((x) => x.id === tid));
    const removed = await get(t, "/api/forum/removed", mod);
    assert.equal(removed.json.threads.find((x) => x.id === tid).removed, "empty");
    const back = await request(t.base, "POST", "/api/forum/posts/" + th.json.post.id + "/restore", { cookie: mod.cookie });
    assert.equal(back.status, 200);
    view = await get(t, "/api/forum/threads/" + tid);
    assert.equal(view.status, 200, "restoring a post brings its thread back");
    assert.equal(view.json.thread.posts, 1);
    assert.equal(auditRows(t, "forum.post.restore").length, 1);
    // a moderator removes another member's post: placeholder, audit
    const r3 = await reply(t, other, tid, "rule breaking");
    await request(t.base, "DELETE", "/api/forum/posts/" + r3.json.post.id, { cookie: mod.cookie });
    view = await get(t, "/api/forum/threads/" + tid);
    assert.equal(view.json.posts.find((p) => p.id === r3.json.post.id).removed, "moderator");
    assert.equal(auditRows(t, "forum.post.remove").at(-1).target_name, "Switch");
    // a moderator removes the thread: 404 for readers, listed for moderators, restored
    assert.equal((await request(t.base, "DELETE", "/api/forum/threads/" + tid, { cookie: mod.cookie })).status, 200);
    assert.equal((await get(t, "/api/forum/threads/" + tid, user)).status, 404);
    assert.equal((await get(t, "/api/forum/threads/" + tid, mod)).json.thread.removed, "moderator");
    assert.equal((await reply(t, user, tid, "anyone?")).status, 404);
    assert.equal((await request(t.base, "POST", "/api/forum/threads/" + tid + "/restore", { cookie: mod.cookie })).status, 200);
    assert.equal((await get(t, "/api/forum/threads/" + tid, user)).status, 200);
  });

  test("locks and pins", async () => {
    const a = await startThread(t, user, "modding", "Map A", "a");
    const b = await startThread(t, user, "modding", "Map B", "b");
    const c = await startThread(t, user, "modding", "Map C", "c");
    const set = (id, at) => t.app.db.prepare("UPDATE forum_threads SET last_post_at = ? WHERE id = ?").run(at, id);
    const base = Math.floor(Date.now() / 1000) - 1000;
    set(a.json.thread.id, base + 1);
    set(b.json.thread.id, base + 2);
    set(c.json.thread.id, base + 3);
    const order = async () => (await get(t, "/api/forum/categories/modding")).json.threads.map((x) => x.title);
    assert.deepEqual(await order(), ["Map C", "Map B", "Map A"], "latest activity first");
    await reply(t, other, a.json.thread.id, "bump");
    assert.deepEqual(await order(), ["Map A", "Map C", "Map B"], "a reply moves a thread up");
    assert.equal((await request(t.base, "PATCH", "/api/forum/threads/" + b.json.thread.id, { cookie: mod.cookie, body: { pinned: true } })).status, 200);
    assert.deepEqual(await order(), ["Map B", "Map A", "Map C"], "pinned first");
    const lock = await request(t.base, "PATCH", "/api/forum/threads/" + c.json.thread.id, { cookie: mod.cookie, body: { locked: true } });
    assert.equal(lock.json.thread.locked, true);
    const blocked = await reply(t, other, c.json.thread.id, "no");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, "locked");
    assert.equal((await reply(t, mod, c.json.thread.id, "Locked: see the rules.")).status, 201, "moderators still reply");
    assert.equal((await request(t.base, "PATCH", "/api/forum/posts/" + c.json.post.id, { cookie: user.cookie, body: { body: "x" } })).status, 403);
    assert.equal((await request(t.base, "DELETE", "/api/forum/posts/" + c.json.post.id, { cookie: user.cookie })).status, 403);
    const view = await get(t, "/api/forum/threads/" + c.json.thread.id, other);
    assert.equal(view.json.thread.replyBlock, "locked");
    assert.equal(auditRows(t, "forum.thread.pin").length, 1);
    assert.equal(auditRows(t, "forum.thread.lock").length, 1);
  });

  test("reports: one open report per reader, the queue, closing, removal closes them", async () => {
    const th = await startThread(t, user, "off-topic", "Reported", "something bad");
    const pid = th.json.post.id;
    const report = (who, reason) => request(t.base, "POST", "/api/forum/posts/" + pid + "/report", { cookie: who.cookie, body: { reason } });
    assert.equal((await report(user, "my own")).status, 400, "not your own post");
    assert.equal((await report(other, "x")).status, 400, "a reason of a few words");
    assert.equal((await report(other, "It breaks the rules")).status, 201);
    assert.equal((await report(other, "Still bad")).json.changed, false, "one open report per reader");
    const q = await get(t, "/api/forum/reports", mod);
    const mine = q.json.reports.find((x) => x.post.id === pid);
    assert.equal(mine.snapshot, "something bad");
    assert.equal(mine.by, "Switch");
    assert.equal(mine.post.author, "Trinity");
    // the author edits the post: the report keeps what was reported
    await request(t.base, "PATCH", "/api/forum/posts/" + pid, { cookie: user.cookie, body: { body: "something nice" } });
    assert.equal((await get(t, "/api/forum/reports", mod)).json.reports.find((x) => x.post.id === pid).snapshot, "something bad");
    const close = await request(t.base, "POST", "/api/forum/reports/" + mine.id + "/close", { cookie: mod.cookie, body: { outcome: "talked to them" } });
    assert.equal(close.status, 200);
    const closed = await get(t, "/api/forum/reports?status=closed", mod);
    assert.equal(closed.json.reports.find((x) => x.id === mine.id).closed.outcome, "talked to them");
    assert.equal((await report(other, "Again, really")).status, 201, "a new report after the last one closed");
    await request(t.base, "DELETE", "/api/forum/posts/" + pid, { cookie: mod.cookie });
    assert.ok(!(await get(t, "/api/forum/reports", mod)).json.reports.some((x) => x.post.id === pid), "removing the post closes its reports");
    assert.equal(auditRows(t, "forum.report.close").at(-1).detail, "talked to them");
  });

  test("pagination: posts by page, the last page, the page of a post; threads by page", async () => {
    const th = await startThread(t, user, "roleplay", "Long one", "post 1");
    const tid = th.json.thread.id;
    const ids = [th.json.post.id];
    for (let i = 2; i <= 45; i++) ids.push((await reply(t, i % 2 ? user : other, tid, "post " + i)).json.post.id);
    const p1 = await get(t, "/api/forum/threads/" + tid);
    assert.equal(p1.json.pages, 3);
    assert.equal(p1.json.total, 45);
    assert.equal(p1.json.posts.length, 20);
    assert.equal(p1.json.posts[19].number, 20);
    const last = await get(t, "/api/forum/threads/" + tid + "?page=last");
    assert.equal(last.json.page, 3);
    assert.equal(last.json.posts.length, 5);
    assert.equal(last.json.posts[4].body, "post 45");
    const at = await get(t, "/api/forum/threads/" + tid + "?post=" + ids[24]);
    assert.equal(at.json.page, 2);
    assert.ok(at.json.posts.some((p) => p.id === ids[24]));
    assert.equal((await get(t, "/api/forum/threads/" + tid + "?page=99")).json.page, 3, "past the end: the last page");
    assert.equal((await get(t, "/api/forum/threads/" + tid + "?page=-1")).json.page, 1);
    const r = await reply(t, user, tid, "post 46");
    assert.equal(r.json.page, 3, "a reply says which page it is on");
    for (let i = 0; i < 26; i++) await startThread(t, other, "support", "Support " + i, "help " + i);
    const s1 = await get(t, "/api/forum/categories/support");
    assert.equal(s1.json.threads.length, 25);
    assert.equal(s1.json.pages, 2);
    const s2 = await get(t, "/api/forum/categories/support?page=2");
    assert.equal(s2.json.threads.length, 1);
  });

  test("text is stored as written and rendered safely; preview stores nothing", async () => {
    const evil = "<script>alert(1)</script> [x](javascript:alert(1)) **bold**";
    const th = await startThread(t, user, "general", "<b>Title</b>", evil);
    const v = await get(t, "/api/forum/threads/" + th.json.thread.id);
    assert.equal(v.json.thread.title, "<b>Title</b>", "titles are plain text");
    assert.equal(v.json.posts[0].body, evil);
    const flat = JSON.stringify(v.json.posts[0].content);
    assert.ok(!flat.includes("\"href\""), "no link to javascript:");
    assert.ok(flat.includes("<script>alert(1)</script>"), "the tags are text");
    const before = t.app.db.prepare("SELECT count(*) AS n FROM forum_posts").get().n;
    const pv = await request(t.base, "POST", "/api/forum/preview", { cookie: user.cookie, body: { body: "> quoted\n\n`code`" } });
    assert.equal(pv.status, 200);
    assert.deepEqual(pv.json.content, [{ t: "quote", c: [{ t: "p", c: ["quoted"] }] }, { t: "p", c: [{ t: "code", text: "code" }] }]);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_posts").get().n, before);
    assert.equal((await request(t.base, "POST", "/api/forum/preview", { body: { body: "x" } })).status, 401);
  });

  test("suspended accounts post nothing, report nothing, and read as guests", async () => {
    const bad = await account(t, "Cypher");
    const th = await startThread(t, user, "general", "Bait", "come at me");
    t.app.accounts.ban(bad.id, Math.floor(Date.now() / 1000) + 3600, "testing");
    const tries = [
      ["POST", "/api/forum/categories/general/threads", { title: "Hello", body: "x" }],
      ["POST", "/api/forum/threads/" + th.json.thread.id + "/posts", { body: "x" }],
      ["POST", "/api/forum/posts/" + th.json.post.id + "/report", { reason: "because" }],
      ["POST", "/api/forum/preview", { body: "x" }],
      ["GET", "/api/forum/avatar", undefined],
    ];
    for (const [method, p, body] of tries) {
      const r = await request(t.base, method, p, { cookie: bad.cookie, body });
      assert.equal(r.status, 403, method + " " + p);
      assert.equal(r.json.error, "account_suspended");
    }
    const read = await get(t, "/api/forum/threads/" + th.json.thread.id, bad);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.viewer, { signedIn: false });
    t.app.accounts.unban(bad.id);
    assert.equal((await reply(t, bad, th.json.thread.id, "back")).status, 201);
  });

  test("profiles: the counts and the latest posts", async () => {
    const p = await get(t, "/api/forum/users/trinity");
    assert.equal(p.status, 200);
    assert.equal(p.json.user.username, "Trinity");
    assert.ok(p.json.user.posts > 5);
    assert.ok(p.json.recent.length > 0 && p.json.recent.length <= 10);
    assert.equal(p.json.can.suspend, false);
    assert.equal((await get(t, "/api/forum/users/trinity", mod)).json.can.suspend, true);
    assert.equal((await get(t, "/api/forum/users/oracle", mod)).json.can.suspend, false, "never on an admin");
    assert.equal((await get(t, "/api/forum/users/nobody-here")).status, 404);
  });

  test("CSRF: every write refuses a foreign Origin, a missing Origin and a cross-site request", async () => {
    const th = await startThread(t, user, "general", "CSRF target", "keep me");
    const tid = th.json.thread.id;
    const pid = th.json.post.id;
    await request(t.base, "POST", "/api/forum/posts/" + pid + "/report", { cookie: other.cookie, body: { reason: "for the test" } });
    const rid = (await get(t, "/api/forum/reports", mod)).json.reports.at(-1).id;
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const writes = [
      ["POST", "/api/forum/categories/general/threads", { title: "Forged", body: "x" }],
      ["POST", "/api/forum/threads/" + tid + "/posts", { body: "forged" }],
      ["PATCH", "/api/forum/posts/" + pid, { body: "forged" }],
      ["DELETE", "/api/forum/posts/" + pid, undefined],
      ["POST", "/api/forum/posts/" + pid + "/restore", {}],
      ["POST", "/api/forum/posts/" + pid + "/report", { reason: "forged report" }],
      ["POST", "/api/forum/preview", { body: "x" }],
      ["PATCH", "/api/forum/threads/" + tid, { locked: true }],
      ["DELETE", "/api/forum/threads/" + tid, undefined],
      ["POST", "/api/forum/threads/" + tid + "/restore", {}],
      ["POST", "/api/forum/reports/" + rid + "/close", {}],
      ["POST", "/api/forum/categories", { slug: "forged", name: "Forged" }],
      ["PATCH", "/api/forum/categories/general", { name: "Forged" }],
      ["DELETE", "/api/forum/categories/off-topic", undefined],
      ["PUT", "/api/forum/avatar", png],
      ["DELETE", "/api/forum/avatar", undefined],
      ["POST", "/api/forum/avatars/Trinity/remove", {}],
      ["POST", "/api/forum/restrictions/Trinity", { reason: "forged", days: 1 }],
      ["DELETE", "/api/forum/restrictions/Trinity", undefined],
    ];
    for (const [method, p, body] of writes) {
      for (const how of [{ origin: "https://evil.example" }, { origin: null }, { headers: { "sec-fetch-site": "cross-site" } }]) {
        const opts = { cookie: adm.cookie, ...how };
        if (Buffer.isBuffer(body)) {
          opts.body = body.toString("latin1");
          opts.contentType = "image/png";
        } else if (body !== undefined) {
          opts.body = body;
        }
        const r = await request(t.base, method, p, opts);
        assert.equal(r.status, 403, method + " " + p + " " + JSON.stringify(how));
        assert.equal(r.json.error, "csrf");
      }
    }
    const v = await get(t, "/api/forum/threads/" + tid, adm);
    assert.equal(v.json.posts.length, 1, "no forged reply");
    assert.equal(v.json.posts[0].body, "keep me");
    assert.equal(v.json.thread.locked, false);
    assert.equal(v.json.thread.removed, null);
    assert.equal((await get(t, "/api/forum/reports", mod)).json.reports.at(-1).id, rid, "the report is still open");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_restrictions").get().n, 0, "no forged restriction");
    const cats = (await get(t, "/api/forum/categories")).json.categories;
    assert.ok(cats.some((c) => c.slug === "off-topic") && !cats.some((c) => c.slug === "forged"));
    assert.equal(cats.find((c) => c.slug === "general").name, "General");
  });

  test("hidden categories: only moderators and admins see them, or anything in them", async () => {
    const made = await request(t.base, "POST", "/api/forum/categories", { cookie: adm.cookie, body: { slug: "staff-room", name: "Staff room", visible: false, startRole: "moderator" } });
    assert.equal(made.status, 201);
    assert.equal(made.json.category.visible, false);
    const th = await startThread(t, mod, "staff-room", "Staff only plans", "secret plans");
    assert.equal(th.status, 201);
    assert.ok(!(await get(t, "/api/forum/categories", user)).json.categories.some((c) => c.slug === "staff-room"));
    assert.ok((await get(t, "/api/forum/categories", mod)).json.categories.some((c) => c.slug === "staff-room"));
    assert.equal((await get(t, "/api/forum/categories/staff-room", user)).status, 404);
    assert.equal((await get(t, "/api/forum/categories/staff-room")).status, 404);
    assert.equal((await get(t, "/api/forum/threads/" + th.json.thread.id, user)).status, 404);
    assert.equal((await get(t, "/api/forum/threads/" + th.json.thread.id, mod)).status, 200);
    assert.equal((await reply(t, user, th.json.thread.id, "let me in")).status, 404);
    assert.equal((await startThread(t, user, "staff-room", "Let me in", "please")).status, 404);
    assert.equal((await get(t, "/api/forum/search?q=staff+plans", user)).json.total, 0);
    assert.equal((await get(t, "/api/forum/search?q=staff+plans", mod)).json.total, 1);
    assert.ok(!(await get(t, "/api/forum/users/morpheus", user)).json.recent.some((p) => p.thread === th.json.thread.id));
    const shown = await request(t.base, "PATCH", "/api/forum/categories/staff-room", { cookie: adm.cookie, body: { visible: true } });
    assert.equal(shown.json.category.visible, true);
    assert.equal((await get(t, "/api/forum/threads/" + th.json.thread.id, user)).status, 200);
    await request(t.base, "PATCH", "/api/forum/categories/staff-room", { cookie: adm.cookie, body: { visible: false } });
    assert.ok(auditRows(t, "forum.category.edit").some((r) => /hidden/.test(r.detail)));
  });

  test("deleting a category: refused while it holds threads, or with its threads moved first", async () => {
    await request(t.base, "POST", "/api/forum/categories", { cookie: adm.cookie, body: { slug: "old-board", name: "Old board" } });
    const a1 = await startThread(t, user, "old-board", "Kept thread", "keep");
    const a2 = await startThread(t, user, "old-board", "Removed thread", "gone");
    await request(t.base, "DELETE", "/api/forum/threads/" + a2.json.thread.id, { cookie: mod.cookie });
    const refused = await request(t.base, "DELETE", "/api/forum/categories/old-board", { cookie: adm.cookie });
    assert.equal(refused.status, 409);
    assert.match(refused.json.message, /2 threads \(1 of them removed\)/);
    assert.equal((await request(t.base, "DELETE", "/api/forum/categories/old-board", { cookie: adm.cookie, body: { moveTo: "old-board" } })).status, 400);
    assert.equal((await request(t.base, "DELETE", "/api/forum/categories/old-board", { cookie: mod.cookie, body: { moveTo: "general" } })).status, 403);
    const del = await request(t.base, "DELETE", "/api/forum/categories/old-board", { cookie: adm.cookie, body: { moveTo: "general" } });
    assert.equal(del.status, 200);
    assert.equal(del.json.moved, 2);
    assert.equal((await get(t, "/api/forum/categories/old-board")).status, 404);
    assert.equal((await get(t, "/api/forum/threads/" + a1.json.thread.id)).json.category.slug, "general");
    assert.match(auditRows(t, "forum.category.remove").at(-1).detail, /2 threads moved to General/);
  });

  test("title search: every word, wildcards as text, removed threads left out, paged", async () => {
    await startThread(t, user, "general", "Neuropolis siege tactics", "x");
    await startThread(t, user, "general", "Siege on neuropolis tonight", "x");
    await startThread(t, user, "general", "100% legit_name thread", "x");
    const gone = await startThread(t, user, "general", "Neuropolis siege removed", "x");
    await request(t.base, "DELETE", "/api/forum/threads/" + gone.json.thread.id, { cookie: mod.cookie });
    const r = await get(t, "/api/forum/search?q=NEUROPOLIS%20siege");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.threads.map((x) => x.title).sort(), ["Neuropolis siege tactics", "Siege on neuropolis tonight"]);
    assert.equal(r.json.threads[0].category.slug, "general");
    assert.equal((await get(t, "/api/forum/search?q=" + encodeURIComponent("100%"))).json.total, 1, "% is a character, not a wildcard");
    assert.equal((await get(t, "/api/forum/search?q=" + encodeURIComponent("legit_"))).json.total, 1);
    assert.equal((await get(t, "/api/forum/search?q=" + encodeURIComponent("lag_"))).json.total, 0, "_ is a character");
    assert.equal((await get(t, "/api/forum/search?q=x")).status, 400);
    assert.equal((await get(t, "/api/forum/search")).status, 400);
    for (let i = 0; i < 27; i++) await startThread(t, other, "off-topic", "Pagetest " + i, "x");
    const p1 = await get(t, "/api/forum/search?q=pagetest");
    assert.equal(p1.json.total, 27);
    assert.equal(p1.json.threads.length, 25);
    assert.equal((await get(t, "/api/forum/search?q=pagetest&page=2")).json.threads.length, 2);
  });

  test("posting turned off: the account reads, reports and stays signed in, but posts nothing until lifted", async () => {
    const quiet = await account(t, "Mouse");
    const th = await startThread(t, quiet, "general", "Before the mute", "my words");
    const off = (who, name, body) => request(t.base, "POST", "/api/forum/restrictions/" + name, { cookie: who.cookie, body });
    assert.equal((await off(user, "Mouse", { reason: "spam spam" })).status, 403, "users cannot");
    assert.equal((await off(mod, "Mouse", { reason: "x" })).status, 400, "a reason the player can read");
    assert.equal((await off(mod, "Mouse", { reason: "Spamming links", days: 0 })).status, 400);
    assert.equal((await off(mod, "Morpheus", { reason: "myself" })).status, 403, "not on yourself");
    const modTwo = await account(t, "Seraph", "moderator");
    assert.equal((await off(mod, "Seraph", { reason: "a peer" })).status, 403, "moderators never on moderators");
    assert.equal((await off(mod, "Oracle", { reason: "the boss" })).status, 403, "or on admins");
    const set = await off(mod, "Mouse", { reason: "Spamming links", days: 2 });
    assert.equal(set.status, 200);
    assert.ok(set.json.until);
    const blocked = [
      () => startThread(t, quiet, "general", "Muted thread", "x"),
      () => reply(t, quiet, th.json.thread.id, "muted reply"),
      () => request(t.base, "PATCH", "/api/forum/posts/" + th.json.post.id, { cookie: quiet.cookie, body: { body: "edited" } }),
      () => request(t.base, "PATCH", "/api/forum/threads/" + th.json.thread.id, { cookie: quiet.cookie, body: { title: "New title" } }),
      () => request(t.base, "PUT", "/api/forum/avatar", { cookie: quiet.cookie, body: "GIF89a", contentType: "image/gif" }),
    ];
    for (const attempt of blocked) {
      const r = await attempt();
      assert.equal(r.status, 403);
      assert.equal(r.json.error, "posting_disabled");
      assert.match(r.json.message, /Reason: Spamming links/);
      assert.equal(r.json.reason, "Spamming links");
    }
    const view = (await get(t, "/api/forum/threads/" + th.json.thread.id, quiet)).json;
    assert.equal(view.viewer.postingBlocked.reason, "Spamming links", "still reads, and is told why");
    assert.equal(view.thread.replyBlock, "posting_disabled");
    assert.equal(view.posts[0].can.edit, false);
    assert.equal(view.posts[0].can.remove, true, "removing your own post stays yours");
    assert.equal((await request(t.base, "GET", "/api/me", { cookie: quiet.cookie })).json.signedIn, true, "still signed in");
    const target = await startThread(t, user, "general", "Reportable", "bad");
    assert.equal((await request(t.base, "POST", "/api/forum/posts/" + target.json.post.id + "/report", { cookie: quiet.cookie, body: { reason: "still reports" } })).status, 201);
    const list = await get(t, "/api/forum/restrictions", mod);
    const entry = list.json.accounts.find((x) => x.username === "Mouse");
    assert.equal(entry.reason, "Spamming links");
    assert.equal(entry.by, "Morpheus");
    assert.equal(entry.can.lift, true);
    assert.equal((await get(t, "/api/forum/restrictions", user)).status, 403);
    // an admin may turn a moderator's posting off; a moderator cannot lift it
    assert.equal((await off(adm, "Seraph", { reason: "Cool down" })).status, 200);
    assert.equal((await request(t.base, "DELETE", "/api/forum/restrictions/Seraph", { cookie: mod.cookie })).status, 403);
    assert.equal((await startThread(t, modTwo, "general", "Mod muted", "x")).json.error, "posting_disabled");
    assert.equal((await request(t.base, "DELETE", "/api/forum/restrictions/Seraph", { cookie: adm.cookie })).status, 200);
    // lifted, and an end date that has passed
    assert.equal((await request(t.base, "DELETE", "/api/forum/restrictions/Mouse", { cookie: mod.cookie })).json.changed, true);
    assert.equal((await reply(t, quiet, th.json.thread.id, "back again")).status, 201);
    await off(mod, "Mouse", { reason: "Again now", days: 1 });
    t.app.db.prepare("UPDATE forum_restrictions SET until = ? WHERE account_id = ?").run(Math.floor(Date.now() / 1000) - 5, quiet.id);
    assert.equal((await reply(t, quiet, th.json.thread.id, "it ran out")).status, 201);
    assert.ok(!(await get(t, "/api/forum/restrictions", mod)).json.accounts.some((x) => x.username === "Mouse"));
    assert.ok(auditRows(t, "forum.posting.off").some((r) => r.target_name === "Mouse" && /Spamming links/.test(r.detail) && r.actor_name === "Morpheus"));
    assert.ok(auditRows(t, "forum.posting.on").some((r) => r.target_name === "Mouse"));
  });

  test("votes: like, dislike, take back; counts for everyone, totals by the author's picture", async () => {
    const th = await startThread(t, user, "general", "Vote on me", "first post");
    const tid = th.json.thread.id;
    const pid = th.json.post.id;
    const second = (await reply(t, user, tid, "second post by the same author")).json.post.id;
    const voter = await account(t, "Voter");
    const vote = (who, post, value, opts = {}) => request(t.base, "PUT", "/api/forum/posts/" + post + "/vote", { cookie: who && who.cookie, body: { value }, ...opts });
    assert.equal((await vote(null, pid, 1)).status, 401, "guests do not vote");
    const liked = await vote(other, pid, 1);
    assert.equal(liked.status, 200, liked.text);
    assert.deepEqual([liked.json.likes, liked.json.dislikes, liked.json.mine], [1, 0, 1]);
    assert.deepEqual([(await vote(voter, pid, 1)).json.likes, (await vote(mod, pid, -1)).json.dislikes], [2, 1]);
    assert.equal((await vote(voter, second, 1)).status, 200);
    // one vote per account per post: a second like changes nothing, a dislike replaces it, 0 takes it back
    assert.deepEqual([(await vote(other, pid, 1)).json.likes], [2]);
    const flipped = await vote(other, pid, -1);
    assert.deepEqual([flipped.json.likes, flipped.json.dislikes, flipped.json.mine], [1, 2, -1]);
    const back = await vote(other, pid, 0);
    assert.deepEqual([back.json.likes, back.json.dislikes, back.json.mine], [1, 1, 0]);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_votes WHERE post_id = ?").get(pid).n, 2);
    for (const bad of [2, "1", null, true, 0.5]) assert.equal((await vote(voter, pid, bad)).status, 400, String(bad));
    // never on your own post
    const own = await vote(user, pid, 1);
    assert.deepEqual([own.status, own.json.error], [403, "own_post"]);
    // what readers see: the counts (guests too), the viewer's own vote, and the author's likes in all
    const guest = (await get(t, "/api/forum/threads/" + tid)).json;
    assert.deepEqual(guest.posts[0].votes, { likes: 1, dislikes: 1, mine: 0 });
    assert.equal(guest.posts[0].can.vote, false);
    assert.equal(guest.posts[0].by.likes, guest.posts[1].by.likes, "one total per author");
    const before = guest.posts[0].by.likes;
    const mine = (await get(t, "/api/forum/threads/" + tid, voter)).json;
    assert.deepEqual([mine.posts[0].votes.mine, mine.posts[0].can.vote, mine.posts[1].votes.mine], [1, true, 1]);
    assert.equal((await get(t, "/api/forum/threads/" + tid, user)).json.posts[0].can.vote, false, "not on your own");
    assert.equal((await get(t, "/api/forum/users/Trinity")).json.user.likes, before, "the profile has the same total");
    // a removed post keeps its votes, hidden; restored, they are back
    await request(t.base, "DELETE", "/api/forum/posts/" + second, { cookie: user.cookie });
    const hidden = (await get(t, "/api/forum/threads/" + tid)).json;
    assert.equal(hidden.posts[1].votes, undefined, "not shown on a removed post");
    assert.equal(hidden.posts[0].by.likes, before - 1, "nor counted in the author's total");
    assert.deepEqual([(await vote(voter, second, -1)).status], [403], "no voting on a removed post");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_votes WHERE post_id = ?").get(second).n, 1, "kept");
    await request(t.base, "POST", "/api/forum/posts/" + second + "/restore", { cookie: mod.cookie, body: {} });
    assert.equal((await get(t, "/api/forum/threads/" + tid)).json.posts[1].votes.likes, 1, "back with the post");
    // posting off and suspension stop voting
    await request(t.base, "POST", "/api/forum/restrictions/Voter", { cookie: mod.cookie, body: { reason: "Testing votes" } });
    assert.equal((await vote(voter, pid, -1)).json.error, "posting_disabled");
    assert.equal((await get(t, "/api/forum/threads/" + tid, voter)).json.posts[0].can.vote, false);
    await request(t.base, "DELETE", "/api/forum/restrictions/Voter", { cookie: mod.cookie });
    t.app.accounts.ban(voter.id, Math.floor(Date.now() / 1000) + 600, "testing");
    assert.equal((await vote(voter, pid, -1)).json.error, "account_suspended");
    t.app.accounts.unban(voter.id);
    // CSRF: a vote from another site, or with no Origin, is refused and counts nothing
    for (const how of [{ origin: "https://evil.example" }, { origin: null }, { headers: { "sec-fetch-site": "cross-site" } }]) {
      const r = await vote(voter, pid, -1, how);
      assert.deepEqual([r.status, r.json.error], [403, "csrf"]);
    }
    assert.equal(t.app.db.prepare("SELECT value FROM forum_votes WHERE post_id = ? AND account_id = ?").get(pid, voter.id).value, 1);
    // an account deleted takes its votes with it
    t.app.accounts.remove(voter.id);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_votes WHERE account_id = ?").get(voter.id).n, 0);
  });

  test("votes are rate-limited per account", async () => {
    const app = await forumApp({ limits: { ...roomyForum(), vote: { max: 3, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 30 } } });
    try {
      const author = await account(app, "Author");
      const fan = await account(app, "Fan");
      const th = await startThread(app, author, "general", "Rate me", "x");
      const vote = (value) => request(app.base, "PUT", "/api/forum/posts/" + th.json.post.id + "/vote", { cookie: fan.cookie, body: { value } });
      for (const value of [1, -1, 0]) assert.equal((await vote(value)).status, 200);
      const r = await vote(1);
      assert.equal(r.status, 429);
      assert.equal(r.headers["retry-after"], "30");
    } finally {
      await app.close();
    }
  });

  test("title searches are rate-limited per address", async () => {
    const app = await forumApp({ limits: { ...roomyForum(), search: { max: 3, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 30 } } });
    try {
      const search = (ip) => request(app.base, "GET", "/api/forum/search?q=anything", { ip });
      for (let i = 0; i < 3; i++) assert.equal((await search("198.51.100.7")).status, 200);
      const r = await search("198.51.100.7");
      assert.equal(r.status, 429);
      assert.equal(r.headers["retry-after"], "30");
      assert.equal((await search("198.51.100.8")).status, 200, "another address is not held up");
    } finally {
      await app.close();
    }
  });

  test("the logs hold no post text, no title and no session token", async () => {
    await startThread(t, user, "general", "A very private title", "a secret only the forum knows");
    const all = t.logs.join("\n");
    assert.ok(all.includes("forum.thread"), "the log is working");
    assert.ok(!all.includes("a secret only the forum knows"));
    assert.ok(!all.includes("A very private title"));
    assert.ok(!all.includes(user.cookie.split("=")[1]));
  });
});

describe("forum: guest reading switched off", () => {
  let t;
  before(async () => {
    t = await forumApp({ guestRead: false });
  });
  after(async () => {
    await t.close();
  });

  test("guests get 401, members read, the suspended get 403", async () => {
    for (const p of ["/api/forum/categories", "/api/forum/categories/general", "/api/forum/threads/1", "/api/forum/users/x", "/api/forum/avatars/1"]) {
      const r = await get(t, p);
      assert.equal(r.status, 401, p);
      assert.equal(r.json.error, "not_signed_in");
    }
    const who = await account(t, "Niobe");
    const ok = await get(t, "/api/forum/categories", who);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.viewer.username, "Niobe");
    t.app.accounts.ban(who.id, Math.floor(Date.now() / 1000) + 60, null);
    assert.equal((await get(t, "/api/forum/categories", who)).status, 403);
  });
});

describe("forum: posting limits", () => {
  let t;
  // the limiters' clock, moved by hand so no test waits
  let clock = Date.now();
  const now = () => clock;
  const later = (seconds) => {
    clock += seconds * 1000;
  };
  before(async () => {
    const limits = Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, { ...ROOMY, now }]));
    Object.assign(limits, {
      thread: { max: 1, windowSeconds: 120, blockSeconds: 120, maxBlockSeconds: 600, now },
      post: { max: 1, windowSeconds: 15, blockSeconds: 15, maxBlockSeconds: 15, now },
      postHour: { max: 4, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600, now },
      newThread: { max: 1, windowSeconds: 900, blockSeconds: 900, maxBlockSeconds: 1800, now },
      newPost: { max: 1, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60, now },
      postPerIp: { max: 6, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600, now },
    });
    t = await startApp({ modules: ["forum"], limits: CORE_ROOMY, moduleSettings: { forum: { limits } } }, { modulesDir: MODULES });
  });
  after(async () => {
    await t.close();
  });

  const old = (who) => t.app.db.prepare("UPDATE accounts SET created_at = created_at - 172800 WHERE id = ?").run(who.id);

  test("new threads: one per two minutes, with Retry-After; a form error costs nothing", async () => {
    const who = await account(t, "Ghost");
    old(who);
    assert.equal((await startThread(t, who, "general", "x", "too short a title")).status, 400);
    assert.equal((await startThread(t, who, "general", "First", "one", { ip: "198.51.100.1" })).status, 201);
    const second = await startThread(t, who, "general", "Second", "two", { ip: "198.51.100.1" });
    assert.equal(second.status, 429);
    assert.equal(second.headers["retry-after"], "120");
    assert.equal(second.json.error, "rate_limited");
    assert.equal(second.json.retryAfter, 120);
    later(121);
    assert.equal((await startThread(t, who, "general", "Second", "two", { ip: "198.51.100.1" })).status, 201, "after the wait");
  });

  test("posts: one per 15 seconds, and a cap per hour", async () => {
    const who = await account(t, "Sparks");
    old(who);
    later(200);
    const th = await startThread(t, who, "general", "Talk", "start", { ip: "198.51.100.2" });
    const tid = th.json.thread.id;
    assert.equal((await reply(t, who, tid, "one", { ip: "198.51.100.2" })).status, 201);
    const fast = await reply(t, who, tid, "two", { ip: "198.51.100.2" });
    assert.equal(fast.status, 429);
    assert.equal(fast.headers["retry-after"], "15");
    later(16);
    assert.equal((await reply(t, who, tid, "two", { ip: "198.51.100.2" })).status, 201);
    later(16);
    assert.equal((await reply(t, who, tid, "three", { ip: "198.51.100.2" })).status, 201);
    later(16);
    const capped = await reply(t, who, tid, "four", { ip: "198.51.100.2" });
    assert.equal(capped.status, 429, "the thread and three replies make the hour's four");
    assert.equal(capped.headers["retry-after"], "600");
    assert.match(capped.json.message, /one hour/);
  });

  test("accounts less than a day old: tighter limits, and they say why; staff are never new", async () => {
    later(200);
    const fresh = await account(t, "Mouse");
    const th = await startThread(t, fresh, "general", "Hi all", "new here", { ip: "198.51.100.3" });
    assert.equal(th.status, 201);
    const again = await startThread(t, fresh, "general", "Hi again", "still new", { ip: "198.51.100.3" });
    assert.equal(again.status, 429);
    assert.equal(again.headers["retry-after"], "900");
    assert.match(again.json.message, /less than 24 hours old/);
    assert.equal((await reply(t, fresh, th.json.thread.id, "one", { ip: "198.51.100.3" })).status, 201);
    const r2 = await reply(t, fresh, th.json.thread.id, "two", { ip: "198.51.100.3" });
    assert.equal(r2.status, 429);
    assert.equal(r2.headers["retry-after"], "60");
    const staff = await account(t, "Dozer", "moderator");
    assert.equal((await startThread(t, staff, "general", "Staff one", "x", { ip: "198.51.100.4" })).status, 201);
    const s2 = await startThread(t, staff, "general", "Staff two", "y", { ip: "198.51.100.4" });
    assert.equal(s2.headers["retry-after"], "120", "staff get the normal limits, not the new-account ones");
  });

  test("posts from one network: a cap across accounts", async () => {
    later(4000);
    const a1 = await account(t, "Apoc");
    const a2 = await account(t, "Tank");
    old(a1);
    old(a2);
    const ip = "203.0.113.50";
    const th = await startThread(t, a1, "general", "Same place", "one", { ip });
    const tid = th.json.thread.id;
    const statuses = [];
    for (const who of [a2, a1, a2, a1, a2, a1]) {
      later(16);
      const r = await reply(t, who, tid, "post", { ip });
      statuses.push(r.status);
      if (r.status === 429) assert.match(r.json.message, /network/);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429], "six posts from the address, the thread included");
    later(16);
    assert.equal((await reply(t, a2, tid, "from elsewhere", { ip: "203.0.113.51" })).status, 201);
  });
});

describe("forum: migrations", () => {
  test("v1 to v10 make the tables and the categories once; deleting an account keeps its posts", async () => {
    const t = await forumApp();
    try {
      const v = t.app.db.prepare("SELECT version FROM schema_migrations WHERE module = 'forum'").all();
      assert.deepEqual(v.map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_media_posts").get().n, 0, "v10: the MEDIA page");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_developers").get().n, 0, "v9: the developer flag");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_needs").get().n, 0, "v8: the What we need page");
      // v7 again (a forum that has its own Suggestions already): still one
      forum.migrations.find((m) => m.version === 7).up(t.app.db);
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_categories WHERE slug = 'suggestions'").get().n, 1, "v7: one Suggestions");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_signatures").get().n, 0, "v6: signatures");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_votes").get().n, 0, "v4: votes");
      const modding = t.app.db.prepare("SELECT name FROM forum_categories WHERE slug = 'modding'").get();
      assert.equal(modding?.name, "Modding", "v3: Maps and Mapping became Modding");
      const name = (slug) => t.app.db.prepare("SELECT name FROM forum_categories WHERE slug = ?").get(slug).name;
      assert.equal(name("servers"), "Servers", "v5: Servers and Match Mode became Servers");
      assert.equal(name("support"), "Support", "v5: Web Client and Support became Support");
      // v5 on a forum where an admin renamed one already: that name stands
      const v5 = forum.migrations.find((m) => m.version === 5);
      t.app.db.prepare("UPDATE forum_categories SET name = 'Our servers' WHERE slug = 'servers'").run();
      t.app.db.prepare("UPDATE forum_categories SET name = 'Web Client and Support' WHERE slug = 'support'").run();
      v5.up(t.app.db);
      assert.equal(name("servers"), "Our servers");
      assert.equal(name("support"), "Support");
      assert.equal(t.app.db.prepare("SELECT visible FROM forum_categories LIMIT 1").get().visible, 1, "v2: categories are visible");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_restrictions").get().n, 0);
      assert.deepEqual(migrate(t.app.db, "forum", forum.migrations, {}), [], "nothing runs twice");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_categories").get().n, 8);
      const who = await account(t, "Kid");
      const th = await startThread(t, who, "general", "Before I go", "my post");
      t.app.accounts.remove(who.id);
      const view = await get(t, "/api/forum/threads/" + th.json.thread.id);
      assert.equal(view.status, 200);
      assert.equal(view.json.posts[0].by, null, "shown as a deleted account");
      assert.equal(view.json.posts[0].body, "my post");
      assert.equal(view.json.thread.by, null);
    } finally {
      await t.close();
    }
  });

  test("a database newer than the code stops the start", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db, "core", [{ version: 1, up: (d) => d.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY)") }]);
      migrate(db, "forum", forum.migrations);
      assert.throws(() => migrate(db, "forum", []), /newer/);
    } finally {
      db.close();
    }
  });
});
