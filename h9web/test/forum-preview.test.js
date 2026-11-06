// The forum's PREVIEW (POST /api/forum/preview): a new thread's first post, a reply and an edit
// show exactly as the same text does once posted (the same post view: cleaning, renderer, author
// block, signature, number, votes), for markup edge cases, links and what is cleaned away; and a
// preview writes nothing, needs a session, keeps posting's size limits and has its own rate limit.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { DEFAULTS } from "../modules/forum/index.js";

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

const preview = (t, who, body) => request(t.base, "POST", "/api/forum/preview", { cookie: who.cookie, body });
const threadPost = async (t, threadId, postId, who) => {
  const g = await request(t.base, "GET", "/api/forum/threads/" + threadId + "?post=" + postId, { cookie: who.cookie });
  assert.equal(g.status, 200, g.text);
  return g.json.posts.find((p) => p.id === postId);
};

// What a reader sees of a post, without what only a saved post has (its id, its time, its
// actions): the preview must give the same.
const shown = (p) => ({
  number: p.number, body: p.body, content: p.content, by: p.by, signature: p.signature, removed: p.removed,
  votes: p.votes, edited: p.edited ? { byModerator: p.edited.byModerator } : null,
});

// Text a preview has to show as the post will: formatting at word edges, code, nested quotes past
// the depth limit, links with and without words, addresses that are not links (javascript:, data:),
// HTML and entities as plain text, escapes, pictures on and off the picture hosts, the characters
// the cleaner takes out (bidi overrides, zero width, stacked marks, C0 controls), Windows line ends.
const TEXTS = [
  "Hello **world** and *it*, 5*3*2 and snake*case stay; `code` and ``with ` a tick``.",
  "```\n<script>alert(1)</script>\n**not bold** in code\n```\nafter the block",
  "> one\n> > two\n> > > three\n> > > > four\n> > > > > five, past the depth limit",
  "[click](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.com/a b) https://example.com/x?y=1&z=<2> www.example.com",
  "<b>not html</b> &amp; &lt;i&gt; \\*escaped\\* \\` \\[ \\]",
  "![pic](https://i.imgur.com/abcd123.png)\n![plain http](http://i.imgur.com/abcd123.png)\n![elsewhere](https://evil.example/x.png)\nhttps://i.imgur.com/efgh456.jpg",
  "bidi \u202eevil\u202c zero\u200bwidth, e\u0301\u0302\u0303\u0304\u0305\u0306\u0307 stacked, bell\u0007 and nul gone",
  "\r\n\r\nwindows\r\nline ends\r\n\r\n\r\nand a last paragraph   \r\n",
];

describe("forum preview: as it would show once posted", () => {
  let t;
  let neo;
  let mod;
  let thread;
  before(async () => {
    t = await forumApp();
    neo = await account(t, "Neo");
    mod = await account(t, "Morpheus", "moderator");
    const adm = await account(t, "Oracle", "admin");
    // an author block with everything in it: a picture, the DEVELOPER flag, a signature
    t.app.db.prepare("INSERT INTO forum_avatars (account_id, version, type, bytes, width, height, frames, updated_at) VALUES (?, 7, 'image/png', 1234, 64, 64, 1, 1)").run(neo.id);
    assert.equal((await request(t.base, "POST", "/api/forum/developers/Neo", { cookie: adm.cookie, body: {} })).status, 200);
    const sig = await request(t.base, "PUT", "/api/forum/signature", { cookie: neo.cookie, body: { signature: "**The One**, [site](https://example.com/neo)" } });
    assert.equal(sig.status, 200, sig.text);
    const first = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: neo.cookie, body: { title: "Preview tests", body: "the first post" } });
    assert.equal(first.status, 201, first.text);
    thread = first.json.thread.id;
  });
  after(async () => {
    await t.close();
  });

  test("a new thread's first post: the preview is the posted post", async () => {
    for (const text of TEXTS) {
      const pv = await preview(t, neo, { body: text });
      assert.equal(pv.status, 200, pv.text);
      assert.equal(pv.json.post.preview, true);
      assert.deepEqual(pv.json.post.can, {}, "no actions on a preview");
      assert.deepEqual(pv.json.content, pv.json.post.content, "content, as before, for older callers");
      const made = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: neo.cookie, body: { title: "Same text", body: text } });
      assert.equal(made.status, 201, made.text);
      const posted = await threadPost(t, made.json.thread.id, made.json.post.id, neo);
      assert.deepEqual(shown(pv.json.post), shown(posted), JSON.stringify(text));
      assert.equal(pv.json.post.number, 1);
      assert.ok(pv.json.post.by.picture && pv.json.post.by.developer && pv.json.post.signature.length, "picture, flag and signature are there");
    }
  });

  test("a reply: the same, with the number it gets", async () => {
    for (const text of TEXTS) {
      const pv = await preview(t, neo, { body: text, thread });
      assert.equal(pv.status, 200, pv.text);
      assert.equal(pv.json.thread, thread);
      const made = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo.cookie, body: { body: text } });
      assert.equal(made.status, 201, made.text);
      const posted = await threadPost(t, thread, made.json.post.id, neo);
      assert.deepEqual(shown(pv.json.post), shown(posted), JSON.stringify(text));
    }
  });

  test("an edit: the post with the new text, marked edited; a moderator's edit keeps the author's block", async () => {
    const made = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo.cookie, body: { body: "before" } });
    const id = made.json.post.id;
    assert.equal((await request(t.base, "PUT", "/api/forum/posts/" + id + "/vote", { cookie: mod.cookie, body: { value: 1 } })).status, 200);
    for (const [who, text] of [[neo, TEXTS[0]], [mod, TEXTS[3]], [neo, TEXTS[5]]]) {
      const pv = await preview(t, who, { body: text, post: id });
      assert.equal(pv.status, 200, pv.text);
      assert.equal(pv.json.post.by.username, "Neo", "the author's block, whoever edits");
      assert.equal(pv.json.post.edited.byModerator, who === mod);
      const saved = await request(t.base, "PATCH", "/api/forum/posts/" + id, { cookie: who.cookie, body: { body: text } });
      assert.equal(saved.status, 200, saved.text);
      const posted = await threadPost(t, thread, id, who);
      assert.deepEqual(shown(pv.json.post), shown(posted), JSON.stringify(text));
      assert.equal(posted.votes.likes, 1, "the post's votes");
    }
  });

  test("an edit preview only of a post the account may edit, and not of a removed one", async () => {
    const other = await account(t, "Switch");
    const made = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo.cookie, body: { body: "mine" } });
    const id = made.json.post.id;
    assert.equal((await preview(t, other, { body: "x", post: id })).status, 403);
    assert.equal((await preview(t, other, { body: "x", post: 999999 })).status, 404);
    assert.equal((await preview(t, other, { body: "x", thread: 999999 })).status, 404);
    assert.equal((await request(t.base, "DELETE", "/api/forum/posts/" + id, { cookie: neo.cookie })).status, 200);
    assert.equal((await preview(t, neo, { body: "x", post: id })).status, 403);
  });

  test("nothing is written: every forum table, the audit log and the counters stay as they were", async () => {
    const tables = t.app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'forum_%' OR name IN ('audit_log', 'sqlite_sequence')) ORDER BY name").all().map((r) => r.name);
    assert.ok(tables.includes("forum_posts") && tables.includes("audit_log"));
    const snapshot = () => Object.fromEntries(tables.map((n) => [n, JSON.stringify(t.app.db.prepare("SELECT * FROM " + n + " ORDER BY rowid").all())]));
    const before = snapshot();
    const made = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo.cookie, body: { body: "kept" } });
    const after1 = snapshot();
    for (const text of TEXTS) {
      assert.equal((await preview(t, neo, { body: text })).status, 200);
      assert.equal((await preview(t, neo, { body: text, thread })).status, 200);
      assert.equal((await preview(t, neo, { body: text, post: made.json.post.id })).status, 200);
      assert.equal((await preview(t, mod, { body: text, post: made.json.post.id })).status, 200);
    }
    assert.deepEqual(snapshot(), after1, "previews change nothing");
    assert.notDeepEqual(after1, before, "the snapshot does see a real post");
  });

  test("sign-in, the same size limits as posting, CSRF", async () => {
    assert.equal((await request(t.base, "POST", "/api/forum/preview", { body: { body: "x" } })).status, 401);
    const long = await preview(t, neo, { body: "x".repeat(DEFAULTS.postMax + 1) });
    assert.deepEqual([long.status, long.json.error], [400, "invalid_body"]);
    assert.equal((await preview(t, neo, { body: "x".repeat(DEFAULTS.postMax) })).status, 200, "the longest post previews");
    const huge = await request(t.base, "POST", "/api/forum/preview", { cookie: neo.cookie, body: JSON.stringify({ body: "\u20ac".repeat(DEFAULTS.postMax * 2) }) });
    assert.equal(huge.status, 413, "past the posting body size");
    assert.equal((await preview(t, neo, { body: 12 })).status, 400);
    assert.equal((await request(t.base, "POST", "/api/forum/preview", { cookie: neo.cookie, origin: "https://evil.example", body: { body: "x" } })).status, 403);
  });
});

describe("MEDIA preview: a comment and a description as they will show", () => {
  let t;
  let neo;
  let mod;
  let media;
  const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
  before(async () => {
    t = await forumApp();
    neo = await account(t, "Neo");
    mod = await account(t, "Morpheus", "moderator");
    const made = await request(t.base, "POST", "/api/forum/media", { cookie: neo.cookie, body: { title: "A round", link: VIDEO, description: "first" } });
    assert.equal(made.status, 201, made.text);
    media = made.json.post.id;
  });
  after(async () => {
    await t.close();
  });
  const mediaPreview = (who, body) => request(t.base, "POST", "/api/forum/media/preview", { cookie: who.cookie, body });
  const comments = async (who) => (await request(t.base, "GET", "/api/forum/media/" + media, { cookie: who.cookie })).json.comments;
  const shownComment = (c) => ({ by: c.by, body: c.body, content: c.content, edited: !!c.edited });

  test("a new comment and an edit: the preview is the saved comment", async () => {
    for (const text of TEXTS) {
      const pv = await mediaPreview(neo, { comment: text });
      assert.equal(pv.status, 200, pv.text);
      assert.deepEqual(pv.json.comment.can, {});
      const made = await request(t.base, "POST", "/api/forum/media/" + media + "/comments", { cookie: neo.cookie, body: { body: text } });
      assert.equal(made.status, 201, made.text);
      const saved = (await comments(neo)).find((c) => c.id === made.json.comment.id);
      assert.deepEqual(shownComment(pv.json.comment), shownComment(saved), JSON.stringify(text));
      const pe = await mediaPreview(mod, { comment: text + " (edited)", id: saved.id });
      assert.equal(pe.status, 200, pe.text);
      assert.equal(pe.json.comment.by.username, "Neo", "an edit keeps its author");
      assert.equal((await request(t.base, "PATCH", "/api/forum/media/comments/" + saved.id, { cookie: mod.cookie, body: { body: text + " (edited)" } })).status, 200);
      const edited = (await comments(neo)).find((c) => c.id === saved.id);
      assert.deepEqual(shownComment(pe.json.comment), shownComment(edited), JSON.stringify(text));
    }
  });

  test("a description: the preview is the saved description", async () => {
    for (const text of TEXTS) {
      const pv = await mediaPreview(neo, { description: text });
      assert.equal(pv.status, 200, pv.text);
      const made = await request(t.base, "POST", "/api/forum/media", { cookie: neo.cookie, body: { title: "Same text", link: VIDEO, description: text } });
      assert.equal(made.status, 201, made.text);
      const saved = await request(t.base, "GET", "/api/forum/media/" + made.json.post.id, { cookie: neo.cookie });
      assert.deepEqual(pv.json.content, saved.json.post.content, JSON.stringify(text));
    }
  });

  test("the checks of saving, sign-in, and nothing written", async () => {
    const tables = ["forum_media_posts", "forum_media_comments", "audit_log"];
    const snapshot = () => tables.map((n) => JSON.stringify(t.app.db.prepare("SELECT * FROM " + n + " ORDER BY rowid").all()));
    const before = snapshot();
    assert.equal((await request(t.base, "POST", "/api/forum/media/preview", { body: { comment: "x" } })).status, 401);
    assert.equal((await mediaPreview(neo, { comment: "x".repeat(2001) })).status, 400);
    assert.equal((await mediaPreview(neo, { comment: "   " })).status, 400);
    assert.equal((await mediaPreview(neo, { description: "x".repeat(4001) })).status, 400);
    const other = await account(t, "Switch");
    const mine = await request(t.base, "POST", "/api/forum/media/" + media + "/comments", { cookie: neo.cookie, body: { body: "mine" } });
    const after1 = snapshot();
    assert.equal((await mediaPreview(other, { comment: "x", id: mine.json.comment.id })).status, 403);
    assert.equal((await mediaPreview(other, { comment: "x", id: 999999 })).status, 404);
    for (const text of TEXTS) {
      assert.equal((await mediaPreview(neo, { comment: text })).status, 200);
      assert.equal((await mediaPreview(neo, { comment: text, id: mine.json.comment.id })).status, 200);
      assert.equal((await mediaPreview(neo, { description: text })).status, 200);
    }
    assert.deepEqual(snapshot(), after1, "previews change nothing");
    assert.notDeepEqual(after1, before);
  });
});

test("forum preview: its own rate limit", async () => {
  const t = await forumApp({}, { preview: { max: 2, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 } });
  try {
    const neo = await account(t, "Neo");
    assert.equal((await preview(t, neo, { body: "a" })).status, 200);
    assert.equal((await preview(t, neo, { body: "b" })).status, 200);
    const third = await preview(t, neo, { body: "c" });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers["retry-after"]) > 0);
  } finally {
    await t.close();
  }
});
