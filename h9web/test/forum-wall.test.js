// Profile walls (modules/forum/wall.js): comments, the order (pins first, then the newest) and
// paging, edits and deletes, the owner's pins (at most 5) and switch, moderators' removal with
// the audit log and the forum's posting-off sanction, role rules, the post rate limits and the
// per-wall flood limit, the preview (the posted comment's own view, nothing stored), and an
// account's deletion taking its wall and its comments with it.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { DEFAULTS } from "../modules/forum/index.js";
import { parse, cleanText } from "../modules/forum/markup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const roomyForum = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
const CORE_ROOMY = { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY };

function forumApp(settings = {}, limits = {}) {
  return startApp({
    modules: ["forum"], limits: CORE_ROOMY,
    moduleSettings: { forum: { newAccountHours: 0, ...settings, limits: { ...roomyForum(), ...limits } } },
  }, { modulesDir: MODULES });
}

async function account(t, name, role = "user") {
  const cookie = await signup(t.base, name);
  const a = t.app.accounts.getByUsername(name);
  if (role !== "user") t.app.accounts.setRole(a.id, role);
  return { cookie, id: a.id, name };
}

const wall = (t, name, who, page) => request(t.base, "GET", "/api/forum/users/" + name + "/wall" + (page ? "?page=" + page : ""), { cookie: who ? who.cookie : undefined });
const write = (t, name, who, body, opts = {}) => request(t.base, "POST", "/api/forum/users/" + name + "/wall", { cookie: who.cookie, body: { body }, ...opts });
const auditRows = (t, action) => t.app.db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action);

describe("profile walls", () => {
  let t;
  let neo;
  let trin;
  let mod;
  let mod2;
  let adm;
  before(async () => {
    t = await forumApp({ postsPerPage: 5 });
    neo = await account(t, "Neo");
    trin = await account(t, "Trinity");
    mod = await account(t, "Morpheus", "moderator");
    mod2 = await account(t, "Niobe", "moderator");
    adm = await account(t, "Oracle", "admin");
  });
  after(async () => {
    await t.close();
  });

  test("a member writes on another's wall and on their own; it shows as a post's text, with a post's author block", async () => {
    const text = "Hi **Neo**, see [this](https://example.com/a) and [that](javascript:alert(1)).\r\n\r\n> quoted\u202e";
    const w1 = await write(t, "Neo", trin, text);
    assert.equal(w1.status, 201, w1.text);
    assert.equal((await write(t, "Neo", neo, "my own wall")).status, 201);
    const g = await wall(t, "Neo", null);
    assert.equal(g.status, 200, "guests read walls (guestRead)");
    assert.equal(g.json.wall.owner, "Neo");
    assert.equal(g.json.wall.open, true);
    assert.equal(g.json.wall.total, 2);
    assert.deepEqual(g.json.can, { comment: false, why: "signin", manage: false, moderate: false });
    const c = g.json.comments.find((x) => x.id === w1.json.comment.id);
    assert.equal(c.body, cleanText(text), "cleaned as a post");
    assert.deepEqual(c.content, parse(cleanText(text), { maxImages: DEFAULTS.maxImagesPerPost }), "rendered as a post");
    const links = [];
    const walk = (n) => (Array.isArray(n) ? n.forEach(walk) : n && typeof n === "object" && (n.t === "a" && links.push(n.href), walk(n.c)));
    walk(c.content);
    assert.deepEqual(links, ["https://example.com/a"], "the javascript: one stays text, never a link");
    // the same author block a post has
    const th = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: trin.cookie, body: { title: "Hello", body: "a post" } });
    const post = (await request(t.base, "GET", "/api/forum/threads/" + th.json.thread.id)).json.posts[0];
    const again = (await wall(t, "Neo", null)).json.comments.find((x) => x.id === w1.json.comment.id);
    assert.deepEqual(again.by, post.by);
    assert.deepEqual(Object.keys(again.by).sort(), ["developer", "id", "joined", "likes", "picture", "posts", "role", "username"]);
    assert.equal(again.edited, null);
    assert.equal(again.removed, null);
  });

  test("who may write: not a guest, not with posting off, not suspended, not on a wall that is off; post size limits", async () => {
    assert.equal((await request(t.base, "POST", "/api/forum/users/Neo/wall", { body: { body: "x" } })).status, 401);
    assert.equal((await write(t, "Nobody", trin, "x")).status, 404);
    const long = await write(t, "Neo", trin, "x".repeat(DEFAULTS.postMax + 1));
    assert.deepEqual([long.status, long.json.error], [400, "invalid_body"]);
    assert.equal((await write(t, "Neo", trin, "   ")).status, 400);
    // posting off, the forum's sanction, stops wall comments too
    const off = await request(t.base, "POST", "/api/forum/restrictions/Trinity", { cookie: mod.cookie, body: { reason: "flooding walls", days: 1 } });
    assert.equal(off.status, 200, off.text);
    const refused = await write(t, "Neo", trin, "still here?");
    assert.deepEqual([refused.status, refused.json.error], [403, "posting_disabled"]);
    assert.equal((await wall(t, "Neo", trin)).json.can.why, "posting_disabled");
    assert.equal((await request(t.base, "DELETE", "/api/forum/restrictions/Trinity", { cookie: mod.cookie })).status, 200);
    // a suspended account is refused by the guard
    const sus = await account(t, "Cypher");
    assert.equal((await request(t.base, "POST", "/api/admin/accounts/Cypher/suspend", { cookie: mod.cookie, body: { reason: "a test", days: 1 } })).status, 200);
    const s1 = await write(t, "Neo", sus, "x");
    assert.ok(s1.status === 401 || s1.status === 403, String(s1.status));
    // the owner turns the wall off: nobody writes, the profile says so; on again
    assert.equal((await request(t.base, "PUT", "/api/forum/users/Neo/wall", { cookie: trin.cookie, body: { open: false } })).status, 403, "only the owner");
    assert.equal((await request(t.base, "PUT", "/api/forum/users/Neo/wall", { cookie: neo.cookie, body: { open: "no" } })).status, 400);
    assert.equal((await request(t.base, "PUT", "/api/forum/users/Neo/wall", { cookie: neo.cookie, body: { open: false } })).status, 200);
    const shut = await write(t, "Neo", trin, "x");
    assert.deepEqual([shut.status, shut.json.error], [403, "wall_closed"]);
    assert.equal((await write(t, "Neo", neo, "x")).status, 403, "nobody: the owner too");
    const g = await wall(t, "Neo", trin);
    assert.equal(g.json.wall.open, false);
    assert.equal(g.json.can.why, "closed");
    assert.equal((await request(t.base, "PUT", "/api/forum/users/Neo/wall", { cookie: neo.cookie, body: { open: true } })).status, 200);
    assert.equal((await write(t, "Neo", trin, "open again")).status, 201);
  });

  test("newest first, the owner's pins first (at most 5, a 6th refused, unpin allowed), paged", async () => {
    const ids = [];
    for (let i = 1; i <= 8; i++) {
      const r = await write(t, "Trinity", neo, "comment " + i);
      assert.equal(r.status, 201, r.text);
      ids.push(r.json.comment.id);
    }
    let g = await wall(t, "Trinity", trin);
    assert.deepEqual(g.json.comments.map((c) => c.body), ["comment 8", "comment 7", "comment 6", "comment 5", "comment 4"]);
    assert.equal(g.json.pages, 2);
    assert.equal(g.json.can.manage, true);
    assert.equal((await request(t.base, "PUT", "/api/forum/wall/" + ids[0] + "/pin", { cookie: neo.cookie, body: { pinned: true } })).status, 403, "only the owner pins");
    for (const id of ids.slice(0, 5)) {
      const p = await request(t.base, "PUT", "/api/forum/wall/" + id + "/pin", { cookie: trin.cookie, body: { pinned: true } });
      assert.equal(p.status, 200, p.text);
    }
    const sixth = await request(t.base, "PUT", "/api/forum/wall/" + ids[5] + "/pin", { cookie: trin.cookie, body: { pinned: true } });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.json.error, "too_many_pins");
    assert.match(sixth.json.message, /at most 5/);
    g = await wall(t, "Trinity", trin);
    assert.equal(g.json.wall.pins, 5);
    assert.deepEqual(g.json.comments.map((c) => [c.body, c.pinned]), [["comment 5", true], ["comment 4", true], ["comment 3", true], ["comment 2", true], ["comment 1", true]],
      "the latest pin first, all five on page 1");
    assert.deepEqual((await wall(t, "Trinity", trin, 2)).json.comments.map((c) => c.body), ["comment 8", "comment 7", "comment 6"]);
    assert.equal((await request(t.base, "PUT", "/api/forum/wall/" + ids[2] + "/pin", { cookie: trin.cookie, body: { pinned: false } })).status, 200);
    assert.equal((await request(t.base, "PUT", "/api/forum/wall/" + ids[5] + "/pin", { cookie: trin.cookie, body: { pinned: true } })).status, 200, "a pin is free again");
    assert.equal((await wall(t, "Trinity", trin)).json.wall.pins, 5);
  });

  test("an author edits (marked edited) and deletes; the owner deletes any comment; nobody else does", async () => {
    const r = await write(t, "Neo", trin, "first words");
    const id = r.json.comment.id;
    assert.equal((await request(t.base, "PATCH", "/api/forum/wall/" + id, { cookie: neo.cookie, body: { body: "not yours" } })).status, 403);
    const e = await request(t.base, "PATCH", "/api/forum/wall/" + id, { cookie: trin.cookie, body: { body: "better **words**" } });
    assert.deepEqual([e.status, e.json.changed], [200, true]);
    const c = (await wall(t, "Neo", trin)).json.comments.find((x) => x.id === id);
    assert.equal(c.body, "better **words**");
    assert.ok(c.edited && c.edited.at, "shows edited");
    assert.equal(c.can.edit, true);
    assert.equal((await request(t.base, "DELETE", "/api/forum/wall/" + id, { cookie: mod.cookie })).status, 403, "a moderator removes, never deletes");
    assert.equal((await request(t.base, "DELETE", "/api/forum/wall/" + id, { cookie: adm.cookie })).status, 403);
    assert.equal((await request(t.base, "DELETE", "/api/forum/wall/" + id, { cookie: trin.cookie })).status, 200, "the author deletes");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_wall_comments WHERE id = ?").get(id).n, 0, "gone for good");
    const other = await write(t, "Neo", trin, "the owner may delete this");
    assert.equal((await request(t.base, "DELETE", "/api/forum/wall/" + other.json.comment.id, { cookie: neo.cookie })).status, 200, "the owner deletes");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_wall_comments WHERE id = ?").get(other.json.comment.id).n, 0);
    assert.equal(auditRows(t, "forum.wall.remove").length, 0, "an author's or owner's delete is not a moderator action");
  });

  test("an edit after the edit window is refused", async () => {
    const r = await write(t, "Neo", trin, "old words");
    const id = r.json.comment.id;
    t.app.db.prepare("UPDATE forum_wall_comments SET created_at = created_at - ? WHERE id = ?").run(DEFAULTS.editWindowMinutes * 60 + 5, id);
    const e = await request(t.base, "PATCH", "/api/forum/wall/" + id, { cookie: trin.cookie, body: { body: "new words" } });
    assert.deepEqual([e.status, e.json.error], [403, "edit_window_closed"]);
    assert.match(e.json.message, new RegExp(DEFAULTS.editWindowMinutes + " minutes"));
    assert.equal((await wall(t, "Neo", trin)).json.comments.find((x) => x.id === id).can.edit, false);
    assert.equal((await request(t.base, "DELETE", "/api/forum/wall/" + id, { cookie: trin.cookie })).status, 200, "deleting it still works");
  });
  test("moderators: REMOVE with a note leaves the placeholder, in the audit log; posting off from the profile; role rules", async () => {
    const r = await write(t, "Neo", trin, "something rude");
    const id = r.json.comment.id;
    await request(t.base, "PUT", "/api/forum/wall/" + id + "/pin", { cookie: neo.cookie, body: { pinned: true } });
    assert.equal((await request(t.base, "POST", "/api/forum/wall/" + id + "/remove", { cookie: trin.cookie, body: { note: "x" } })).status, 403, "members do not remove");
    assert.equal((await request(t.base, "POST", "/api/forum/wall/" + id + "/remove", { cookie: mod.cookie, body: { note: "x" } })).status, 400, "a note of 3 or more");
    const rm = await request(t.base, "POST", "/api/forum/wall/" + id + "/remove", { cookie: mod.cookie, body: { note: "rude to the owner" } });
    assert.deepEqual([rm.status, rm.json.changed], [200, true]);
    const seen = (await wall(t, "Neo", trin)).json.comments.find((x) => x.id === id);
    assert.equal(seen.removed, "moderator", "it stays, as removed by a moderator");
    assert.equal(seen.pinned, false, "and gives up its pin");
    assert.equal(seen.content, undefined, "readers do not see what it said");
    assert.equal(seen.body, undefined);
    const staff = (await wall(t, "Neo", mod2)).json.comments.find((x) => x.id === id);
    assert.equal(staff.body, "something rude", "staff do");
    assert.equal(staff.removedNote, "rude to the owner");
    const row = auditRows(t, "forum.wall.remove").at(-1);
    assert.equal(row.actor_name, "Morpheus");
    assert.equal(row.target_id, trin.id, "in the author's audit trail");
    assert.equal(row.detail, "rude to the owner");
    assert.match(row.subject, /wall comment \d+ on Neo's wall/);
    const trail = await request(t.base, "GET", "/api/admin/accounts/Trinity", { cookie: adm.cookie });
    assert.equal(trail.status, 200, trail.text);
    assert.ok(trail.json.audit.some((x) => x.action === "forum.wall.remove" && x.by === "Morpheus"), "the admin panel's trail shows it");
    // posting off, offered beside each comment: the forum's own sanction and its audit entry
    assert.equal(seen.can.postingOff, false, "not for members");
    const view = (await wall(t, "Neo", mod)).json.comments.find((x) => x.id === id);
    assert.equal(view.can.postingOff, true);
    const off = await request(t.base, "POST", "/api/forum/restrictions/Trinity", { cookie: mod.cookie, body: { reason: "rude on walls" } });
    assert.equal(off.status, 200);
    assert.equal(auditRows(t, "forum.posting.off").at(-1).target_id, trin.id);
    assert.equal((await write(t, "Neo", trin, "again")).status, 403);
    await request(t.base, "DELETE", "/api/forum/restrictions/Trinity", { cookie: mod.cookie });
    // nobody acts on an account of their own role or above
    const byMod = await write(t, "Neo", mod2, "a moderator's comment");
    const rr = await request(t.base, "POST", "/api/forum/wall/" + byMod.json.comment.id + "/remove", { cookie: mod.cookie, body: { note: "same role" } });
    assert.equal(rr.status, 403);
    assert.equal((await wall(t, "Neo", mod)).json.comments.find((x) => x.id === byMod.json.comment.id).can.remove, false);
    const own = await write(t, "Neo", mod, "my own");
    assert.equal((await request(t.base, "POST", "/api/forum/wall/" + own.json.comment.id + "/remove", { cookie: mod.cookie, body: { note: "mine" } })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/forum/wall/" + byMod.json.comment.id + "/remove", { cookie: adm.cookie, body: { note: "an admin may" } })).status, 200);
    const byAdm = await write(t, "Neo", adm, "an admin's comment");
    assert.equal((await request(t.base, "POST", "/api/forum/wall/" + byAdm.json.comment.id + "/remove", { cookie: mod.cookie, body: { note: "above me" } })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/forum/restrictions/Oracle", { cookie: mod.cookie, body: { reason: "above me" } })).status, 403);
  });

  test("the preview is the comment as it is posted, and writes nothing", async () => {
    const tables = ["forum_wall_comments", "forum_walls", "audit_log"];
    const snapshot = () => tables.map((n) => JSON.stringify(t.app.db.prepare("SELECT * FROM " + n + " ORDER BY rowid").all()));
    const shown = (c) => ({ by: c.by, body: c.body, content: c.content, removed: c.removed, pinned: c.pinned, edited: !!c.edited });
    for (const text of ["**bold** *it* `code` [ok](https://example.com) [no](javascript:x)", "> a\n> > b\n\n```\n<b>x</b>\n```", "\u200bzero\u202e and \r\n lines"]) {
      const before = snapshot();
      const pv = await request(t.base, "POST", "/api/forum/wall/preview", { cookie: trin.cookie, body: { body: text, wall: "Neo" } });
      assert.equal(pv.status, 200, pv.text);
      assert.deepEqual(pv.json.comment.can, {});
      assert.deepEqual(snapshot(), before, "nothing written");
      const made = await write(t, "Neo", trin, text);
      const posted = (await wall(t, "Neo", trin)).json.comments.find((x) => x.id === made.json.comment.id);
      assert.deepEqual(shown(pv.json.comment), shown(posted), JSON.stringify(text));
      const pe = await request(t.base, "POST", "/api/forum/wall/preview", { cookie: trin.cookie, body: { body: text + " (edited)", comment: made.json.comment.id } });
      await request(t.base, "PATCH", "/api/forum/wall/" + made.json.comment.id, { cookie: trin.cookie, body: { body: text + " (edited)" } });
      const edited = (await wall(t, "Neo", trin)).json.comments.find((x) => x.id === made.json.comment.id);
      assert.deepEqual(shown(pe.json.comment), shown(edited));
    }
    assert.equal((await request(t.base, "POST", "/api/forum/wall/preview", { body: { body: "x", wall: "Neo" } })).status, 401);
    assert.equal((await request(t.base, "POST", "/api/forum/wall/preview", { cookie: trin.cookie, body: { body: "x".repeat(DEFAULTS.postMax + 1), wall: "Neo" } })).status, 400);
    assert.equal((await request(t.base, "POST", "/api/forum/wall/preview", { cookie: trin.cookie, body: { body: "x", wall: "Nobody" } })).status, 404);
    const theirs = await write(t, "Neo", neo, "the owner's");
    assert.equal((await request(t.base, "POST", "/api/forum/wall/preview", { cookie: trin.cookie, body: { body: "x", comment: theirs.json.comment.id } })).status, 403);
  });

  test("CSRF: a write from another site is refused", async () => {
    const r = await request(t.base, "POST", "/api/forum/users/Neo/wall", { cookie: trin.cookie, origin: "https://evil.example", body: { body: "x" } });
    assert.equal(r.status, 403);
  });

  test("deleting an account deletes its wall and its comments on walls", async () => {
    const gone = await account(t, "Mouse");
    await write(t, "Neo", gone, "from Mouse");
    await write(t, "Mouse", trin, "on Mouse's wall");
    await request(t.base, "PUT", "/api/forum/users/Mouse/wall", { cookie: gone.cookie, body: { open: false } });
    const count = (sql, id) => t.app.db.prepare(sql).get(id).n;
    assert.equal(count("SELECT count(*) AS n FROM forum_wall_comments WHERE account_id = ? OR wall_id = ?1", gone.id), 2);
    t.app.accounts.remove(gone.id);
    assert.equal(count("SELECT count(*) AS n FROM forum_wall_comments WHERE account_id = ? OR wall_id = ?1", gone.id), 0);
    assert.equal(count("SELECT count(*) AS n FROM forum_walls WHERE account_id = ?", gone.id), 0);
    assert.equal((await wall(t, "Mouse", trin)).status, 404);
  });
});

test("profile walls: the post rate limits per account and per address, and the flood limit per wall", async () => {
  const one = { max: 1, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 };
  const t = await forumApp({}, { post: one });
  try {
    const a = await account(t, "Neo");
    const b = await account(t, "Trinity");
    assert.equal((await write(t, "Trinity", a, "one")).status, 201);
    const second = await write(t, "Trinity", a, "two");
    assert.equal(second.status, 429, "a comment counts as a post");
    assert.ok(Number(second.headers["retry-after"]) > 0);
    assert.equal((await write(t, "Neo", b, "another writer")).status, 201);
  } finally {
    await t.close();
  }
  const t2 = await forumApp({}, { postPerIp: { max: 2, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 } });
  try {
    const a = await account(t2, "Neo");
    const b = await account(t2, "Trinity");
    const c = await account(t2, "Switch");
    assert.equal((await write(t2, "Neo", b, "1", { ip: "203.0.113.5" })).status, 201);
    assert.equal((await write(t2, "Neo", c, "2", { ip: "203.0.113.5" })).status, 201);
    assert.equal((await write(t2, "Neo", a, "3", { ip: "203.0.113.5" })).status, 429, "per address");
  } finally {
    await t2.close();
  }
  const t3 = await forumApp({}, { wallFlood: { max: 2, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 } });
  try {
    const writers = [await account(t3, "Neo"), await account(t3, "Trinity"), await account(t3, "Switch"), await account(t3, "Apoc")];
    assert.equal((await write(t3, "Apoc", writers[0], "1")).status, 201);
    assert.equal((await write(t3, "Apoc", writers[1], "2")).status, 201);
    const flood = await write(t3, "Apoc", writers[2], "3");
    assert.equal(flood.status, 429, "the wall's own flood limit");
    assert.match(flood.json.message, /this wall/);
    assert.equal((await write(t3, "Neo", writers[2], "elsewhere")).status, 201, "other walls are open");
  } finally {
    await t3.close();
  }
});
