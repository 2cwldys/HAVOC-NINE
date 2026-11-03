// Pictures in posts: links to pictures on other sites, shown from there (markup.js IMAGE_HOSTS),
// the forum pages' CSP that must name the same hosts, the per-post limit (maxImagesPerPost), and
// a moderator taking one picture out.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { DEFAULTS, forumSettings } from "../modules/forum/index.js";
import { parse, render, imageSource, imageCount, withoutImage, IMAGE_HOSTS, MAX_IMAGES, IMAGE_REMOVED } from "../modules/forum/markup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const SITE = path.join(HERE, "..", "..", "havoc9.org");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const images = (tree) => {
  const out = [];
  const walk = (list) => {
    for (const n of list || []) {
      if (!n || typeof n !== "object") continue;
      if (n.t === "img") out.push(n);
      if (Array.isArray(n.c)) walk(n.c);
    }
  };
  walk(tree);
  return out;
};

describe("pictures in the markup", () => {
  test("https on a listed host shows a picture; anything else stays a link", () => {
    assert.deepEqual(parse("![a cat](https://i.imgur.com/AbCdE12.png)")[0].c, [{ t: "img", src: "https://i.imgur.com/AbCdE12.png", alt: "a cat" }]);
    assert.deepEqual(parse("![x](https://evil.example/a.png)")[0].c, [{ t: "a", href: "https://evil.example/a.png", text: "x" }]);
    assert.deepEqual(parse("![x](http://i.imgur.com/AbCdE12.png)")[0].c, [{ t: "a", href: "http://i.imgur.com/AbCdE12.png", text: "x" }]);
    assert.deepEqual(parse("![x](javascript:alert(1))")[0].c, ["![x](javascript:alert(1))"]);
    assert.equal(imageSource("https://i.imgur.com:8443/AbCdE12.png"), null, "no other port");
    assert.equal(imageSource("https://user:pw@i.imgur.com/AbCdE12.png"), null);
    for (const host of IMAGE_HOSTS) assert.ok(imageSource("https://" + host + (host === "i.imgur.com" ? "/AbCdE12.jpg" : "/a/b.jpg")), host);
  });

  test("imgur page links show the picture, .gifv as .gif; albums and galleries stay links", () => {
    assert.equal(imageSource("https://imgur.com/AbCdE12"), "https://i.imgur.com/AbCdE12.png");
    assert.equal(imageSource("https://i.imgur.com/AbCdE12.gifv"), "https://i.imgur.com/AbCdE12.gif");
    assert.equal(imageSource("https://i.imgur.com/AbCdE12.mp4"), null);
    for (const album of ["https://imgur.com/a/AbCdE12", "https://imgur.com/gallery/AbCdE12", "https://imgur.com/t/cats/AbCdE12"]) {
      assert.equal(imageSource(album), null, album);
      assert.equal(parse(album)[0].c[0].t, "a", album);
    }
  });

  test("a bare picture link shows only alone on its line, and only with a picture's extension", () => {
    const tree = parse("look\nhttps://i.redd.it/a.jpg\nsee https://i.redd.it/b.jpg here\nhttps://i.redd.it/page\n> https://imgur.com/AbCdE12\n```\nhttps://i.redd.it/c.jpg\n```");
    assert.deepEqual(images(tree).map((x) => x.src), ["https://i.redd.it/a.jpg", "https://i.imgur.com/AbCdE12.png"]);
  });

  test("the limit: MAX_IMAGES by default, any number on request; the rest stay links", () => {
    assert.equal(MAX_IMAGES, 25);
    const text = Array.from({ length: 30 }, (_, i) => "https://i.imgur.com/AbCd" + String(i).padStart(3, "0") + ".png").join("\n");
    assert.equal(images(parse(text)).length, 25);
    assert.equal(images(parse(text, { maxImages: 3 })).length, 3);
    assert.equal(imageCount(text), 30);
    const fourth = parse(text, { maxImages: 3 })[0].c.filter((x) => typeof x === "object")[3];
    assert.equal(fourth.t, "a", "past the limit: a link");
  });

  test("as HTML: escaped, no Referer, lazy; a moderator takes one picture out, code blocks left alone", () => {
    assert.equal(render("![\"><b>](https://i.imgur.com/AbCdE12.png)"),
      "<p><img src=\"https://i.imgur.com/AbCdE12.png\" alt=\"&quot;&gt;&lt;b&gt;\" loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\"></p>");
    const text = "a\n![x](https://imgur.com/AbCdE12)\n> https://i.imgur.com/AbCdE12.png\nhttps://i.redd.it/keep.png\n```\n![x](https://imgur.com/AbCdE12)\n```";
    assert.equal(withoutImage(text, "https://i.imgur.com/AbCdE12.png"),
      "a\n" + IMAGE_REMOVED + "\n> " + IMAGE_REMOVED + "\nhttps://i.redd.it/keep.png\n```\n![x](https://imgur.com/AbCdE12)\n```");
    assert.equal(withoutImage(text, "https://i.imgur.com/Other12.png"), text);
  });

  test("taking a picture out finds what the parser shows: parentheses in the address, never inside `code`", () => {
    const wiki = "https://upload.wikimedia.org/wikipedia/commons/a/ab/File_(1).png";
    const text = "![one](" + wiki + ") and more\n" + wiki + "\n![enc](https://upload.wikimedia.org/a/File_%281%29.png)\n"
      + "`![x](" + wiki + ")` stays, as does ``a " + wiki + " b``";
    const shown = images(parse(text)).map((x) => x.src);
    assert.deepEqual(shown, [wiki, wiki, "https://upload.wikimedia.org/a/File_%281%29.png"], "what renders as pictures");
    assert.equal(withoutImage(text, wiki), IMAGE_REMOVED + " and more\n" + IMAGE_REMOVED + "\n![enc](https://upload.wikimedia.org/a/File_%281%29.png)\n"
      + "`![x](" + wiki + ")` stays, as does ``a " + wiki + " b``");
    assert.equal(withoutImage(text, shown[2]), "![one](" + wiki + ") and more\n" + wiki + "\n" + IMAGE_REMOVED + "\n"
      + "`![x](" + wiki + ")` stays, as does ``a " + wiki + " b``");
    // a code span across lines of one paragraph, and the same picture in a quote
    const multi = "a `x\n![p](https://i.imgur.com/AbCdE12.png)` b\n> ![q](https://i.imgur.com/AbCdE12.png)";
    assert.equal(withoutImage(multi, "https://i.imgur.com/AbCdE12.png"), "a `x\n![p](https://i.imgur.com/AbCdE12.png)` b\n> " + IMAGE_REMOVED);
  });

  test("the CSP of every page that shows forum pictures allows exactly IMAGE_HOSTS", () => {
    const want = ["'self'", ...IMAGE_HOSTS.map((h) => "https://" + h)].join(" ");
    for (const page of ["forum/index.html", "forum/category/index.html", "forum/thread/index.html", "forum/user/index.html", "forum/search/index.html", "account/index.html", "join/needs/index.html", "admin/index.html"]) {
      const html = fs.readFileSync(path.join(SITE, page), "utf8");
      const m = /img-src ([^;"]+);/.exec(html);
      assert.ok(m, page);
      assert.equal(m[1].trim(), want, page + ": change markup.js IMAGE_HOSTS and this CSP together");
    }
  });

  test("maxImagesPerPost: 25 by default, 0 to 200", () => {
    assert.equal(DEFAULTS.maxImagesPerPost, 25);
    assert.equal(forumSettings({ maxImagesPerPost: 3 }).maxImagesPerPost, 3);
    assert.throws(() => forumSettings({ maxImagesPerPost: 201 }), /maxImagesPerPost/);
    assert.throws(() => forumSettings({ maxImagesPerPost: -1 }), /maxImagesPerPost/);
  });
});

describe("pictures in posts over HTTP", () => {
  let t;
  let neo;
  let mod;
  let thread;
  const forum = (more = {}) => ({ newAccountHours: 0, limits: Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY])), ...more });
  before(async () => {
    t = await startApp({ modules: ["forum"], limits: { signupPerIp: ROOMY }, moduleSettings: { forum: forum({ maxImagesPerPost: 2 }) } }, { modulesDir: MODULES });
    neo = await signup(t.base, "Neo");
    mod = await signup(t.base, "Morpheus");
    t.app.accounts.setRole(t.app.accounts.getByUsername("Morpheus").id, "moderator");
    thread = (await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: neo, body: { title: "Pictures", body: "First." } })).json.thread.id;
  });
  after(async () => {
    await t.close();
  });
  const pics = ["https://i.imgur.com/AbCdE01.png", "https://i.imgur.com/AbCdE02.png", "https://i.imgur.com/AbCdE03.png"];

  test("a custom limit: the post saves, shows that many, says so; the help gets the number", async () => {
    const r = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo, body: { body: pics.join("\n") } });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.notes[0], /3 pictures: it shows the first 2/);
    const d = (await request(t.base, "GET", "/api/forum/threads/" + thread, { cookie: neo })).json;
    assert.equal(d.viewer.imagesPerPost, 2);
    assert.deepEqual(d.viewer.imageHosts, [...IMAGE_HOSTS]);
    const post = d.posts.find((p) => p.id === r.json.post.id);
    assert.deepEqual(images(post.content).map((x) => x.src), pics.slice(0, 2));
    const pv = await request(t.base, "POST", "/api/forum/preview", { cookie: neo, body: { body: pics.join("\n") } });
    assert.equal(images(pv.json.content).length, 2);
    assert.equal(pv.json.notes.length, 1);
  });

  test("the default limit is 25", async () => {
    const u = await startApp({ modules: ["forum"], moduleSettings: { forum: forum() } }, { modulesDir: MODULES });
    try {
      const c = await signup(u.base, "Trin");
      const text = Array.from({ length: 26 }, (_, i) => "https://i.imgur.com/AbCd" + String(i).padStart(3, "0") + ".png").join("\n");
      const r = await request(u.base, "POST", "/api/forum/categories/general/threads", { cookie: c, body: { title: "Many", body: text } });
      assert.equal(r.status, 201, r.text);
      assert.match(r.json.notes[0], /26 pictures: it shows the first 25/);
      const d = (await request(u.base, "GET", "/api/forum/threads/" + r.json.thread.id)).json;
      assert.equal(images(d.posts[0].content).length, 25);
    } finally {
      await u.close();
    }
  });

  test("REMOVE PICTURE: moderators only, an edit with the note, into the audit log", async () => {
    const r = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo, body: { body: "Mine:\n" + pics[0] + "\n![b](" + pics[1] + ")" } });
    const url = "/api/forum/posts/" + r.json.post.id + "/pictures/remove";
    assert.equal((await request(t.base, "POST", url, { cookie: neo, body: { src: pics[0] } })).status, 403);
    assert.equal((await request(t.base, "POST", url, { cookie: mod, body: { src: "https://evil.example/x.png" } })).status, 400);
    assert.equal((await request(t.base, "POST", url, { cookie: mod, body: { src: pics[2] } })).status, 404);
    const ok = await request(t.base, "POST", url, { cookie: mod, body: { src: pics[0], reason: "off-topic" } });
    assert.equal(ok.status, 200, ok.text);
    const post = (await request(t.base, "GET", "/api/forum/threads/" + thread, { cookie: neo })).json.posts.find((p) => p.id === r.json.post.id);
    assert.equal(post.body, "Mine:\n" + IMAGE_REMOVED + "\n![b](" + pics[1] + ")");
    assert.equal(post.edited.byModerator, true);
    const log = t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'forum.post.picture.remove'").get();
    assert.equal(log.detail, "off-topic; " + pics[0]);
    assert.equal(log.subject, "post " + r.json.post.id);
    // an address with parentheses, as the page sends it back from the tree
    const w = await request(t.base, "POST", "/api/forum/threads/" + thread + "/posts", { cookie: neo, body: { body: "![w](https://upload.wikimedia.org/wikipedia/commons/a/ab/File_(1).png)" } });
    const shown = (await request(t.base, "GET", "/api/forum/threads/" + thread, { cookie: mod })).json.posts.find((x) => x.id === w.json.post.id);
    const src = images(shown.content)[0].src;
    const gone = await request(t.base, "POST", "/api/forum/posts/" + w.json.post.id + "/pictures/remove", { cookie: mod, body: { src } });
    assert.equal(gone.status, 200, gone.text);
  });
});
