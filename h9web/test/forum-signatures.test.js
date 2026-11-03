// Forum signatures: the limits, the markup a signature may use, new accounts, the reader's switch,
// moderators clearing and blocking, posting off, suspension and CSRF.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { DEFAULTS, forumSettings } from "../modules/forum/index.js";
import { parseSignature } from "../modules/forum/markup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const forum = (more = {}) => ({ newAccountHours: 0, limits: Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY])), ...more });
const PIC = "https://i.imgur.com/AbCdE12.png";

describe("signatures: settings and markup", () => {
  test("the defaults and their ranges", () => {
    assert.equal(DEFAULTS.signatureMaxChars, 300);
    assert.equal(DEFAULTS.signatureMaxLines, 4);
    assert.equal(DEFAULTS.signatureImages, 1);
    assert.equal(DEFAULTS.signatureImageHeight, 100);
    assert.equal(forumSettings({ signatureMaxChars: 0 }).signatureMaxChars, 0, "0 switches signatures off");
    for (const [k, v] of [["signatureMaxChars", 2001], ["signatureMaxLines", 0], ["signatureImages", 11], ["signatureImageHeight", 8]]) {
      assert.throws(() => forumSettings({ [k]: v }), new RegExp(k));
    }
  });

  test("one paragraph of post markup: no code blocks or quotes; pictures capped; plain text for new accounts", () => {
    const tree = parseSignature("**Neo** of [Zion](https://zion.example)\n> not a quote\n```\n" + PIC + "\n" + PIC, { maxImages: 1 });
    assert.equal(tree.length, 1);
    assert.equal(tree[0].t, "p");
    const c = tree[0].c;
    assert.deepEqual(c[0], { t: "b", c: ["Neo"] });
    assert.ok(c.some((x) => x.t === "a" && x.href === "https://zion.example/"));
    assert.ok(c.some((x) => typeof x === "string" && x.includes("> not a quote\n```")), "quote and fence marks stay text");
    assert.equal(c.filter((x) => x.t === "img").length, 1, "one picture; the next is a link");
    assert.equal(c.filter((x) => x.t === "a" && x.href === PIC).length, 1);
    assert.deepEqual(parseSignature("**bold** " + PIC, { plain: true }), [{ t: "p", c: ["**bold** " + PIC] }]);
    assert.deepEqual(parseSignature("  \n "), []);
    assert.equal(parseSignature(PIC, { maxImages: 0 })[0].c[0].t, "a", "signatureImages 0: no pictures");
  });
});

describe("signatures over HTTP", () => {
  let t;
  let neo;
  let mouse;
  let mod;
  let thread;
  let post;
  before(async () => {
    t = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum({ signatureMaxLines: 2, signatureMaxChars: 120 }) } }, { modulesDir: MODULES });
    neo = await signup(t.base, "Neo");
    mouse = await signup(t.base, "Mouse");
    mod = await signup(t.base, "Morpheus");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Morpheus").id, "moderator");
    const th = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: neo, body: { title: "Signed", body: "Hello." } });
    thread = th.json.thread.id;
    post = th.json.post.id;
  });
  after(async () => {
    await t.close();
  });
  const put = (body, cookie = neo, opts = {}) => request(t.base, "PUT", "/api/forum/signature", { cookie, body, ...opts });
  const postOf = async (cookie) => (await request(t.base, "GET", "/api/forum/threads/" + thread, { cookie })).json.posts.find((p) => p.id === post);

  test("set, checked against the limits, shown under the author's posts with the image height", async () => {
    assert.equal((await put({ signature: "a\nb\nc" })).json.error, "invalid_signature", "three lines, two allowed");
    assert.equal((await put({ signature: "x".repeat(121) })).json.error, "invalid_signature");
    assert.equal((await put({ signature: "x" }, neo, { origin: "https://evil.example" })).status, 403, "CSRF");
    assert.equal((await put({ signature: "x" }, null)).status, 401);
    const r = await put({ signature: "**The One**\n" + PIC });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.content[0].c.filter((x) => x.t === "img").length, 1);
    const d = (await request(t.base, "GET", "/api/forum/threads/" + thread)).json;
    assert.equal(d.signatureImageHeight, 100);
    const p = d.posts.find((x) => x.id === post);
    assert.deepEqual(p.signature[0].c[0], { t: "b", c: ["The One"] });
    const pv = await request(t.base, "POST", "/api/forum/signature/preview", { cookie: neo, body: { signature: "a\nb\nc" } });
    assert.match(pv.json.error, /2 lines/);
    const me = (await request(t.base, "GET", "/api/forum/signature", { cookie: neo })).json;
    assert.equal(me.signature, "**The One**\n" + PIC);
    assert.equal(me.limits.maxLines, 2);
  });

  test("the reader's SHOW SIGNATURES off hides everyone's; a removed post shows none", async () => {
    assert.ok((await postOf(mouse)).signature);
    assert.equal((await put({ showSignatures: false }, mouse)).status, 200);
    assert.equal((await postOf(mouse)).signature, undefined);
    assert.ok((await postOf(neo)).signature, "others still see it");
    assert.equal((await put({ showSignatures: true }, mouse)).status, 200);
    const reply = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo, body: { body: "Gone soon." } });
    await request(t.base, "DELETE", "/api/forum/posts/" + reply.json.post.id, { cookie: mod });
    const removed = (await request(t.base, "GET", "/api/forum/threads/" + thread, { cookie: mod })).json.posts.find((x) => x.id === reply.json.post.id);
    assert.equal(removed.signature, undefined);
  });

  test("new accounts show plain text; posting off and suspension refuse a change", async () => {
    const u = await startApp({ modules: ["forum"], moduleSettings: { forum: forum({ newAccountHours: 24 }) } }, { modulesDir: MODULES });
    try {
      const fresh = await signup(u.base, "Fresh");
      const r = await request(u.base, "PUT", "/api/forum/signature", { cookie: fresh, body: { signature: "**hi** " + PIC } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.content, [{ t: "p", c: ["**hi** " + PIC] }]);
    } finally {
      await u.close();
    }
    await request(t.base, "POST", "/api/forum/restrictions/Mouse", { cookie: mod, body: { reason: "cool off" } });
    assert.equal((await put({ signature: "hello" }, mouse)).json.error, "posting_disabled");
    await request(t.base, "DELETE", "/api/forum/restrictions/Mouse", { cookie: mod });
    const banned = await signup(t.base, "Cypher");
    t.app.accounts.ban(t.app.accounts.getByUsername("Cypher").id, Math.floor(Date.now() / 1000) + 600, "no");
    assert.equal((await put({ signature: "hello" }, banned)).status, 403);
  });

  test("moderators clear one and block setting one, below their own role, in the audit log", async () => {
    const audit = (action) => t.app.db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC").get(action);
    assert.equal((await request(t.base, "POST", "/api/forum/signatures/Neo/clear", { cookie: mouse, body: {} })).status, 403);
    const cleared = await request(t.base, "POST", "/api/forum/signatures/Neo/clear", { cookie: mod, body: { reason: "too loud" } });
    assert.equal(cleared.json.changed, true);
    assert.equal(audit("forum.signature.clear").detail, "too loud");
    assert.equal((await postOf(mouse)).signature, undefined);
    assert.equal((await request(t.base, "POST", "/api/forum/signatures/Neo/block", { cookie: mod, body: { reason: "x" } })).status, 400, "a reason");
    assert.equal((await request(t.base, "POST", "/api/forum/signatures/Neo/block", { cookie: mod, body: { reason: "again and again", days: 2 } })).status, 200);
    const refused = await put({ signature: "back" });
    assert.equal(refused.json.error, "signature_blocked");
    assert.match(refused.json.message, /again and again/);
    const prof = (await request(t.base, "GET", "/api/forum/users/Neo", { cookie: mod })).json;
    assert.equal(prof.user.signatureBlock.reason, "again and again");
    assert.equal(prof.can.blockSignature, true);
    assert.equal((await request(t.base, "DELETE", "/api/forum/signatures/Neo/block", { cookie: mod })).json.changed, true);
    assert.ok(audit("forum.signature.unblock"));
    assert.equal((await put({ signature: "back" })).status, 200);
    t.app.accounts.setRole(t.app.accounts.getByUsername("Neo").id, "moderator");
    assert.equal((await request(t.base, "POST", "/api/forum/signatures/Neo/clear", { cookie: mod, body: {} })).status, 403, "not on an equal role");
  });
});
