// The forum: categories, threads and posts in a small formatting subset, profile pictures, and
// the moderators' side (pins, locks, moves, soft deletes, the report queue), with posting
// limits. h9web's module registry loads it when config.json lists it ("modules": ["forum"]).
// Its pages are static files in the site (havoc9.org/forum/, the admin panel havoc9.org/admin/
// and the ACCOUNT page), which call the JSON API below with fetch; nginx's /api/ location covers
// all of it but the picture upload, which needs a larger body (README.txt, section 15).
//
// Reading (guests too, unless moduleSettings.forum.guestRead is false):
//   GET    /api/forum/categories                        the categories, with counts and the latest thread
//   GET    /api/forum/categories/:slug?page=N           its threads: pinned first, then by last post
//   GET    /api/forum/threads/:id?page=N|last&post=ID   its posts (post=ID: the page holding that post)
//   GET    /api/forum/users/:name                       a member's profile and latest posts
//   GET    /api/forum/avatars/:id?v=V                   a profile picture (cached for good when V is current)
// Signed in, not suspended:
//   POST   /api/forum/categories/:slug/threads  { title, body }
//   POST   /api/forum/threads/:id/posts         { body }
//   PATCH  /api/forum/posts/:id                 { body }     the author, for editWindowMinutes
//   DELETE /api/forum/posts/:id                              the author (a soft delete)
//   POST   /api/forum/posts/:id/report          { reason }
//   PUT    /api/forum/posts/:id/vote            { value: 1 | -1 | 0 }   like, dislike, or take it back
//   PATCH  /api/forum/threads/:id               { title }    the author, for editWindowMinutes
//   POST   /api/forum/preview                   { body }     the rendered tree; nothing is stored
//   GET, PUT /api/forum/signature, POST /api/forum/signature/preview   your signature (signatures.js)
//   GET    /api/forum/needs; PUT and POST /api/forum/needs/preview for its editors
//                                               the "What we need" page (needs.js)
//   GET    /api/forum/avatar                                 your picture, and what a picture may be
//   PUT    /api/forum/avatar                    the picture's own bytes, sent as image/png,
//                                               image/jpeg, image/webp or image/gif
//   DELETE /api/forum/avatar
// Moderators and admins; every action goes into h9web's audit log:
//   PATCH  /api/forum/threads/:id               { title, pinned, locked, hidden, category }
//   DELETE /api/forum/threads/:id               POST /api/forum/threads/:id/restore
//   PATCH and DELETE /api/forum/posts/:id on any post;  POST /api/forum/posts/:id/restore
//   POST   /api/forum/posts/:id/pictures/remove { src, reason }   the post without that picture
//   GET    /api/forum/removed?page=N            removed threads, the latest first
//   GET    /api/forum/reports?status=open|closed&page=N
//   POST   /api/forum/reports/:id/close         { outcome }
//   POST   /api/forum/avatars/:name/remove      { reason }   only an account below your own role
//   POST   /api/forum/signatures/:name/clear, POST and DELETE /api/forum/signatures/:name/block
// Admins:
//   POST   /api/forum/categories                { slug, name, description, startRole, replyRole }
//   PATCH  /api/forum/categories/:slug          { name, description, startRole, replyRole } or { move: "up"|"down" }
//   DELETE /api/forum/categories/:slug          only a category that holds no thread at all
//   GET, POST and DELETE /api/forum/developers/:name   the DEVELOPER flag (purple; edits "What we need")
// The MEDIA page's routes, /api/forum/media...: media.js.
//
// No IP address is stored with anything here; the rate limits key on accounts (and on addresses
// in memory only), and the log lines name the account and the thread or post, never the text.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MIGRATIONS } from "./migrations.js";
import { createStore } from "./store.js";
import { createSignatures } from "./signatures.js";
import { createNeeds } from "./needs.js";
import { createMedia } from "./media.js";
import { parse, cleanText, cleanLine, imageCount, imageSource, withoutImage, MAX_IMAGES, IMAGE_HOSTS } from "./markup.js";
import { inspectPicture, PICTURE_TYPES } from "./images.js";

const MB = 1024 * 1024;

export const DEFAULTS = Object.freeze({
  guestRead: true,
  threadsPerPage: 25,
  postsPerPage: 20,
  titleMax: 120,
  postMax: 10000,
  editWindowMinutes: 60,
  newAccountHours: 24,
  // pictures a post shows (links to pictures on the hosts in markup.js); the ones after stay links
  maxImagesPerPost: MAX_IMAGES,
  // signatures (signatures.js): signatureMaxChars 0 switches them off
  signatureMaxChars: 300,
  signatureMaxLines: 4,
  signatureImages: 1,
  signatureImageHeight: 100,
  // who edits the "What we need" page (needs.js) besides admins: "moderator" (moderators),
  // "developer" (accounts with the DEVELOPER flag), both, or neither
  needsEditors: Object.freeze(["moderator", "developer"]),
  // the MEDIA page (media.js): its front page shows the pinned posts and this many others; older
  // ones are in the archive, by month
  mediaFrontCount: 30,
  pictureMaxBytes: 10 * MB,
  pictureMaxSide: 512,
  pictureMaxFrames: 300,
  pictureInlineBytes: MB / 2,
  pictureQuotaBytes: 1024 * MB,
  picturesAtOnce: 2,
  limits: Object.freeze({
    thread: { max: 1, windowSeconds: 120, blockSeconds: 120, maxBlockSeconds: 600 },
    post: { max: 1, windowSeconds: 15, blockSeconds: 15, maxBlockSeconds: 15 },
    postHour: { max: 60, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600 },
    newThread: { max: 1, windowSeconds: 900, blockSeconds: 900, maxBlockSeconds: 1800 },
    newPost: { max: 1, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 },
    newPostHour: { max: 15, windowSeconds: 3600, blockSeconds: 1800, maxBlockSeconds: 3600 },
    threadPerIp: { max: 20, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600 },
    postPerIp: { max: 200, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600 },
    edit: { max: 20, windowSeconds: 600, blockSeconds: 300, maxBlockSeconds: 1800 },
    report: { max: 10, windowSeconds: 3600, blockSeconds: 1800, maxBlockSeconds: 7200 },
    preview: { max: 30, windowSeconds: 300, blockSeconds: 60, maxBlockSeconds: 600 },
    picture: { max: 10, windowSeconds: 3600, blockSeconds: 1800, maxBlockSeconds: 7200 },
    vote: { max: 30, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 },
    signature: { max: 10, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600 },
    signaturePreview: { max: 120, windowSeconds: 300, blockSeconds: 60, maxBlockSeconds: 600 },
    needs: { max: 30, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600 },
    needsPreview: { max: 120, windowSeconds: 300, blockSeconds: 60, maxBlockSeconds: 600 },
    // title searches, per address (guests search too): each one reads every title
    search: { max: 30, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 },
  }),
});

const WHOLE = {
  threadsPerPage: [1, 100], postsPerPage: [1, 100], titleMax: [10, 300], postMax: [100, 100000],
  editWindowMinutes: [0, 525600], newAccountHours: [0, 8760], maxImagesPerPost: [0, 200],
  signatureMaxChars: [0, 2000], signatureMaxLines: [1, 20], signatureImages: [0, 10], signatureImageHeight: [16, 480],
  mediaFrontCount: [1, 200],
  pictureMaxBytes: [1024, 50 * MB], pictureMaxSide: [16, 4096], pictureMaxFrames: [1, 10000],
  pictureInlineBytes: [0, 50 * MB], pictureQuotaBytes: [0, Number.MAX_SAFE_INTEGER], picturesAtOnce: [1, 16],
};

export function forumSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw, limits: {} };
  for (const [k, def] of Object.entries(DEFAULTS.limits)) s.limits[k] = { ...def, ...((raw.limits && raw.limits[k]) || {}) };
  if (typeof s.guestRead !== "boolean") throw new Error("forum: moduleSettings.forum.guestRead must be true or false");
  if (!Array.isArray(s.needsEditors) || s.needsEditors.some((x) => x !== "moderator" && x !== "developer")) {
    throw new Error("forum: moduleSettings.forum.needsEditors must be a list of \"moderator\" and \"developer\" (admins always edit)");
  }
  for (const [k, [lo, hi]] of Object.entries(WHOLE)) {
    if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) throw new Error("forum: moduleSettings.forum." + k + " must be a whole number from " + lo + " to " + hi);
  }
  for (const [k, l] of Object.entries(s.limits)) {
    for (const f of ["max", "windowSeconds", "blockSeconds", "maxBlockSeconds"]) {
      if (typeof l[f] !== "number" || !(l[f] > 0)) throw new Error("forum: moduleSettings.forum.limits." + k + "." + f + " must be a number above 0");
    }
  }
  return s;
}

const ID = /^[1-9][0-9]{0,14}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const WHO = { user: "members", moderator: "moderators and admins", admin: "admins" };

export default {
  name: "forum",
  migrations: MIGRATIONS,
  async setup(ctx) {
    const s = forumSettings(ctx.settings);
    const { HttpError } = ctx.http;
    const { auth, log } = ctx;
    const store = createStore(ctx.db);
    const bodyBytes = Math.max(16384, s.postMax * 4 + 8192);
    const editSeconds = s.editWindowMinutes * 60;
    const pictureDir = path.join(ctx.dataDir, "avatars");
    const now = () => Math.floor(Date.now() / 1000);
    const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
    const isMod = (a) => auth.roleAtLeast(a, "moderator");
    const rank = (a) => auth.ROLES.indexOf(a.role);
    // whether actor may act on target: only on an account of a lower role (never on itself)
    const outranks = (actor, target) => !!actor && !!target && actor.id !== target.id && rank(actor) > rank(target);

    const limiters = {};
    for (const [k, v] of Object.entries(s.limits)) limiters[k] = new ctx.limits.RateLimiter(v);
    let hits = 0;
    function hit(name, key) {
      if (++hits % 1000 === 0) for (const l of Object.values(limiters)) l.sweep();
      return limiters[name].hit(key);
    }

    const notFound = (message) => new HttpError(404, "not_found", message);
    const refuse = (code, message) => new HttpError(403, code, message);
    const invalid = (code, message) => new HttpError(400, code, message);
    const waitText = (sec) => (sec < 120 ? sec + " second" + (sec === 1 ? "" : "s") : Math.ceil(sec / 60) + " minutes");
    const tooFast = (r, text) => new HttpError(429, "rate_limited", text + " in " + waitText(r.retryAfter) + ".", {
      headers: { "Retry-After": String(r.retryAfter) },
      body: { retryAfter: r.retryAfter },
    });
    function take(steps) {
      for (const [name, key, text] of steps) {
        const r = hit(name, key);
        if (!r.ok) throw tooFast(r, text);
      }
    }
    const ipKey = (ip) => "ip:" + ctx.limits.ipKey(ip);
    const isNew = (a) => !isMod(a) && now() - a.created_at < s.newAccountHours * 3600;
    const NEWLY = "Accounts less than " + s.newAccountHours + " hours old post more slowly. ";

    function limitThread(a, ip) {
      const fresh = isNew(a);
      take([
        [fresh ? "newThread" : "thread", "a:" + a.id, (fresh ? NEWLY : "") + "You can start another thread"],
        [fresh ? "newPostHour" : "postHour", "a:" + a.id, "That is a lot of posting for one hour. You can post again"],
        ["threadPerIp", ipKey(ip), "Many threads come from your network just now. Try again"],
        ["postPerIp", ipKey(ip), "Many posts come from your network just now. Try again"],
      ]);
    }

    function limitPost(a, ip) {
      const fresh = isNew(a);
      take([
        [fresh ? "newPost" : "post", "a:" + a.id, (fresh ? NEWLY : "") + "You can post again"],
        [fresh ? "newPostHour" : "postHour", "a:" + a.id, "That is a lot of posting for one hour. You can post again"],
        ["postPerIp", ipKey(ip), "Many posts come from your network just now. Try again"],
      ]);
    }

    // The rendered tree of a post's text, kept for the latest few hundred texts: a post is parsed
    // once for many readers, and an edited post is a new text.
    const rendered = new Map();
    function contentOf(text) {
      let tree = rendered.get(text);
      if (tree) {
        rendered.delete(text);
      } else {
        tree = parse(text, { maxImages: s.maxImagesPerPost });
        if (rendered.size >= 400) rendered.delete(rendered.keys().next().value);
      }
      rendered.set(text, tree);
      return tree;
    }

    function idOf(text, message) {
      if (!ID.test(String(text))) throw notFound(message);
      return Number(text);
    }

    // A hidden category, and everything in it, is there only for moderators and admins.
    const seen = (c, a) => !!c && (!!c.visible || isMod(a));

    function categoryOr404(slug, a) {
      const c = SLUG.test(slug) ? store.categoryBySlug(slug) : null;
      if (!seen(c, a)) throw notFound("No such category.");
      return c;
    }

    // A thread the account may see: a removed or hidden one, or one in a hidden category, only for
    // moderators.
    function threadFor(id, a) {
      const t = store.thread(id);
      if (!t || ((t.deleted_at || t.hidden_at) && !isMod(a)) || !seen(store.category(t.category_id), a)) throw notFound("No such thread.");
      return t;
    }

    // Posting turned off for the account (forum_restrictions): { until, reason } while it lasts.
    function postingBlock(a) {
      const row = a ? store.restriction(a.id) : null;
      if (!row || (row.until !== null && row.until <= now())) return null;
      return { until: row.until === null ? null : iso(row.until), reason: row.reason };
    }

    function requirePosting(a) {
      const b = postingBlock(a);
      if (!b) return;
      const when = b.until ? "until " + b.until.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "until a moderator turns it back on";
      throw new HttpError(403, "posting_disabled", "Posting is turned off for your account " + when + ". Reason: " + b.reason, { body: { until: b.until, reason: b.reason } });
    }

    function postFor(id, a) {
      const p = store.post(id);
      if (!p) throw notFound("No such post.");
      return { p, t: threadFor(p.thread_id, a) };
    }

    function checkTitle(value) {
      if (typeof value !== "string") throw invalid("invalid_title", "Give the thread a title.");
      const t = cleanLine(value);
      if (t.length < 3) throw invalid("invalid_title", "Give the thread a title of at least 3 characters.");
      if (t.length > s.titleMax) throw invalid("invalid_title", "Keep the title to " + s.titleMax + " characters.");
      return t;
    }

    function checkBody(value) {
      if (typeof value !== "string") throw invalid("invalid_body", "Write something first.");
      const t = cleanText(value);
      if (!t.trim()) throw invalid("invalid_body", "Write something first.");
      if (t.length > s.postMax) throw invalid("invalid_body", "Keep a post to " + s.postMax + " characters; this one has " + t.length + ".");
      return t;
    }

    // What a save tells its writer about the text's pictures: past maxImagesPerPost they are links.
    function imageNotes(text) {
      const n = imageCount(text);
      return n > s.maxImagesPerPost
        ? ["This post has " + n + " pictures: it shows the first " + s.maxImagesPerPost + ", and the others as links."]
        : [];
    }

    function optionalText(value, max, what) {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "string") throw invalid("bad_request", what + " must be text.");
      const t = cleanLine(value);
      if (t.length > max) throw invalid("bad_request", "Keep " + what.toLowerCase() + " to " + max + " characters.");
      return t || null;
    }

    function paging(raw, total, per) {
      const pages = Math.max(1, Math.ceil(total / per));
      let page = raw === "last" ? pages : /^[0-9]{1,9}$/.test(String(raw || "")) ? Number(raw) : 1;
      if (page < 1) page = 1;
      if (page > pages) page = pages;
      return { page, pages, offset: (page - 1) * per };
    }

    function audit(actor, action, { target = null, targetId = null, subject = null, detail = null } = {}) {
      const who = target || (targetId ? ctx.accounts.getById(targetId) : null);
      ctx.audit.record({ actor, action, target: who, subject, detail });
      log.info("forum.moderation", { by: actor.username, action, subject: subject || undefined, target: who ? who.username : undefined });
    }

    function viewer(a) {
      if (!a) return { signedIn: false };
      const v = {
        signedIn: true, id: a.id, username: a.username, role: a.role, moderator: isMod(a), admin: auth.roleAtLeast(a, "admin"),
        postingBlocked: postingBlock(a), imagesPerPost: s.maxImagesPerPost, imageHosts: IMAGE_HOSTS,
      };
      if (v.moderator) v.openReports = store.openReportCount();
      return v;
    }

    const pictureRef = (accountId, version, bytes, frames, type) =>
      version ? { id: accountId, v: String(version), bytes, frames, type } : null;

    function categoryView(c, a, withStats) {
      const v = {
        slug: c.slug, name: c.name, description: c.description, startRole: c.start_role, replyRole: c.reply_role,
        visible: !!c.visible, canStart: !!a && auth.roleAtLeast(a, c.start_role),
      };
      if (withStats) {
        const st = store.categoryStats(c.id, isMod(a));
        const last = store.categoryLatest(c.id, isMod(a));
        v.threads = st.threads;
        v.posts = st.posts;
        v.last = last ? { thread: last.id, title: last.title, post: last.last_post_id, at: iso(last.last_post_at), by: last.last_name || null, byDeveloper: !!last.last_dev } : null;
      }
      return v;
    }

    function threadRow(t) {
      return {
        id: t.id, title: t.title, pinned: !!t.pinned, locked: !!t.locked, created: iso(t.created_at),
        by: t.author_name ? { username: t.author_name, role: t.author_role, developer: !!t.author_dev } : null,
        posts: t.post_count, lastPost: t.last_post_id, lastAt: iso(t.last_post_at), lastBy: t.last_name || null, lastByDeveloper: !!t.last_dev,
        removed: t.deleted_at ? t.deleted_kind : null, hidden: !!t.hidden_at,
      };
    }

    function threadView(t, c, a) {
      const mod = isMod(a);
      const own = !!a && t.account_id === a.id;
      let replyBlock = null;
      if (!a) replyBlock = "signin";
      else if (t.deleted_at) replyBlock = "removed";
      else if (!auth.roleAtLeast(a, c.reply_role)) replyBlock = "role";
      else if (t.locked && !mod) replyBlock = "locked";
      else if (postingBlock(a)) replyBlock = "posting_disabled";
      return {
        id: t.id, title: t.title, pinned: !!t.pinned, locked: !!t.locked,
        removed: t.deleted_at ? t.deleted_kind : null, hidden: !!t.hidden_at, created: iso(t.created_at),
        by: t.author_name ? { username: t.author_name, role: t.author_role, developer: !!t.author_dev } : null, posts: t.post_count,
        replyBlock, replyRole: c.reply_role,
        can: {
          reply: !replyBlock,
          rename: !!a && (mod || (own && !t.deleted_at && !t.locked && now() - t.created_at <= editSeconds && !postingBlock(a))),
          moderate: mod,
        },
      };
    }

    // page: what the thread page worked out once for all its posts, each in one grouped query:
    // counts (author -> posts), likes (author -> likes received), votes (post -> { likes,
    // dislikes }), mine (post -> the viewer's own vote), blocked (the viewer's posting is off)
    function postView(p, t, a, page, number) {
      const { counts, likes, votes, mine, blocked } = page;
      const mod = isMod(a);
      const own = !!a && p.account_id !== null && p.account_id === a.id;
      const live = !p.deleted_at;
      const threadLive = !t.deleted_at;
      const v = {
        id: p.id, number, created: iso(p.created_at),
        edited: p.edited_at ? { at: iso(p.edited_at), byModerator: p.edited_by !== null && p.edited_by !== p.account_id } : null,
        by: p.author_name ? {
          id: p.account_id, username: p.author_name, role: p.author_role, joined: iso(p.author_created), developer: !!p.author_dev,
          posts: counts.get(p.account_id) || 0,
          likes: likes.get(p.account_id) || 0,
          picture: pictureRef(p.account_id, p.pic_version, p.pic_bytes, p.pic_frames, p.pic_type),
        } : null,
        removed: live ? null : p.deleted_kind,
        own,
        can: {
          edit: live && threadLive && (own ? !blocked && (mod || (!t.locked && now() - p.created_at <= editSeconds)) : mod),
          remove: live && (mod || (own && threadLive && !t.locked)),
          restore: !live && mod,
          report: live && threadLive && !!a && !own && !mod,
          vote: live && threadLive && !!a && !own && !blocked,
        },
      };
      if (live || mod) {
        v.body = p.body;
        v.content = contentOf(p.body);
      }
      // a removed post shows no signature
      const sig = live && p.account_id !== null ? page.signatures.get(p.account_id) : null;
      if (sig) v.signature = sig;
      v.can.clearSignature = !!sig && mod && outranks(a, { id: p.account_id, role: p.author_role });
      // a removed post keeps its votes, but they are not shown
      if (live) v.votes = { ...(votes.get(p.id) || { likes: 0, dislikes: 0 }), mine: mine.get(p.id) || 0 };
      return v;
    }

    function reportView(r) {
      return {
        id: r.id, created: iso(r.created_at), reason: r.reason, snapshot: r.snapshot, by: r.reporter || null,
        post: {
          id: r.post_id, thread: r.thread_id, threadTitle: r.thread_title, author: r.post_author || null,
          removed: r.post_removed || null, threadRemoved: r.thread_removed || null,
        },
        closed: r.closed_at ? { at: iso(r.closed_at), by: r.closer || null, outcome: r.outcome } : null,
      };
    }

    const reader = (h) => (s.guestRead ? auth.optionalSession(h) : auth.requireSession(h));
    const member = (h) => auth.requireSession(h);
    const moderator = (h) => auth.requireRole("moderator", h);
    const admin = (h) => auth.requireRole("admin", h);
    const r = ctx.router;
    const sigs = createSignatures({
      ctx, s, now, iso, isMod, isNew, outranks, requirePosting, take, audit, optionalText, cleanLine, member, moderator,
    });
    createNeeds({ ctx, s, now, iso, take, audit, isMod, isDeveloper: (a) => !!a && store.isDeveloper(a.id) });
    createMedia({
      ctx, s, store, now, iso, isMod, postingBlock, requirePosting, take, ipKey, idOf, audit, limitThread, limitPost, reader, member,
    });

    // ---- the DEVELOPER flag (admins give and take it; every change into the audit log) ---------

    function developerTarget(name) {
      const target = ctx.accounts.getByUsername(name);
      if (!target) throw notFound("No such account.");
      return target;
    }
    r.get("/api/forum/developers/:name", admin(async (req, res, rc) => {
      const target = developerTarget(rc.params.name);
      rc.json(200, { username: target.username, developer: store.isDeveloper(target.id) });
    }));
    r.post("/api/forum/developers/:name", admin(async (req, res, rc) => {
      const target = developerTarget(rc.params.name);
      const changed = store.addDeveloper(target.id, rc.account.id, now());
      if (changed) audit(rc.account, "forum.developer.add", { target });
      rc.json(200, { ok: true, changed, developer: true });
    }));
    r.delete("/api/forum/developers/:name", admin(async (req, res, rc) => {
      const target = developerTarget(rc.params.name);
      const changed = store.removeDeveloper(target.id);
      if (changed) audit(rc.account, "forum.developer.remove", { target });
      rc.json(200, { ok: true, changed, developer: false });
    }));

    // ---- reading -------------------------------------------------------------------------------

    r.get("/api/forum/categories", reader(async (req, res, rc) => {
      const a = rc.account;
      rc.json(200, { viewer: viewer(a), categories: store.categories().filter((c) => seen(c, a)).map((c) => categoryView(c, a, true)) });
    }));

    r.get("/api/forum/categories/:slug", reader(async (req, res, rc) => {
      const a = rc.account;
      const c = categoryOr404(rc.params.slug, a);
      const per = s.threadsPerPage;
      const total = store.threadCount(c.id, isMod(a));
      const pg = paging(rc.query.get("page"), total, per);
      rc.json(200, {
        viewer: viewer(a), category: categoryView(c, a, false),
        threads: store.threadPage(c.id, per, pg.offset, isMod(a)).map(threadRow),
        page: pg.page, pages: pg.pages, perPage: per, total,
      });
    }));

    r.get("/api/forum/threads/:id", reader(async (req, res, rc) => {
      const a = rc.account;
      const t = threadFor(idOf(rc.params.id, "No such thread."), a);
      const c = store.category(t.category_id);
      const per = s.postsPerPage;
      const total = store.postCount(t.id);
      let want = rc.query.get("page");
      const at = rc.query.get("post");
      if (at && ID.test(at)) {
        const p = store.post(Number(at));
        if (p && p.thread_id === t.id) want = String(Math.floor(store.postsBefore(t.id, p.id) / per) + 1);
      }
      const pg = paging(want, total, per);
      const rows = store.postPage(t.id, per, pg.offset);
      const authors = rows.map((p) => p.account_id);
      const ids = rows.map((p) => p.id);
      const page = {
        counts: store.authorCounts(authors), likes: store.likesReceived(authors),
        votes: store.voteCounts(ids), mine: store.votesBy(a ? a.id : null, ids), blocked: !!postingBlock(a),
        signatures: sigs.forPosts(rows, a),
      };
      const out = {
        viewer: viewer(a),
        category: { slug: c.slug, name: c.name },
        thread: threadView(t, c, a),
        posts: rows.map((p, i) => postView(p, t, a, page, pg.offset + i + 1)),
        page: pg.page, pages: pg.pages, perPage: per, total,
        editWindowMinutes: s.editWindowMinutes,
        pictureInlineBytes: s.pictureInlineBytes,
        signatureImageHeight: s.signatureImageHeight,
      };
      if (isMod(a)) out.categories = store.categories().map((x) => ({ slug: x.slug, name: x.name }));
      rc.json(200, out);
    }));

    r.get("/api/forum/users/:name", reader(async (req, res, rc) => {
      const a = rc.account;
      const u = ctx.accounts.getByUsername(rc.params.name);
      if (!u) throw notFound("No such member.");
      const pic = store.picture(u.id);
      const mod = isMod(a);
      const sig = sigs.profile(u, a);
      rc.json(200, {
        viewer: viewer(a),
        user: {
          id: u.id, username: u.username, role: u.role, joined: iso(u.created_at),
          posts: store.authorCounts([u.id]).get(u.id) || 0, threads: store.threadsBy(u.id),
          likes: store.likesReceived([u.id]).get(u.id) || 0,
          picture: pic ? pictureRef(u.id, pic.version, pic.bytes, pic.frames, pic.type) : null,
          signature: sig.signature, signatureBlock: sig.block, developer: store.isDeveloper(u.id),
        },
        signatureImageHeight: s.signatureImageHeight,
        recent: store.recentPosts(u.id, 10, mod).map((p) => ({ post: p.id, thread: p.thread_id, title: p.title, at: iso(p.created_at) })),
        can: {
          removePicture: mod && !!pic && outranks(a, u), suspend: mod && outranks(a, u),
          clearSignature: mod && sig.hasSignature && outranks(a, u), blockSignature: mod && outranks(a, u),
        },
        pictureInlineBytes: s.pictureInlineBytes,
      });
    }));

    // ---- writing -------------------------------------------------------------------------------

    r.post("/api/forum/categories/:slug/threads", member(async (req, res, rc) => {
      const input = await rc.body({ maxBytes: bodyBytes });
      const a = rc.account;
      const c = categoryOr404(rc.params.slug, a);
      if (!auth.roleAtLeast(a, c.start_role)) throw refuse("forbidden", "Only " + WHO[c.start_role] + " start threads in " + c.name + ".");
      requirePosting(a);
      const title = checkTitle(input.title);
      const text = checkBody(input.body);
      limitThread(a, rc.ip);
      const ids = ctx.transaction(() => store.createThread(c.id, a.id, title, text, now()));
      log.info("forum.thread", { user: a.username, category: c.slug, thread: ids.threadId });
      rc.json(201, { ok: true, thread: { id: ids.threadId }, post: { id: ids.postId }, notes: imageNotes(text) });
    }));

    r.post("/api/forum/threads/:id/posts", member(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such thread.");
      const input = await rc.body({ maxBytes: bodyBytes });
      const a = rc.account;
      const t = threadFor(id, a);
      const c = store.category(t.category_id);
      if (t.deleted_at) throw refuse("removed", "This thread was removed.");
      if (!auth.roleAtLeast(a, c.reply_role)) throw refuse("forbidden", "Only " + WHO[c.reply_role] + " reply in " + c.name + ".");
      if (t.locked && !isMod(a)) throw refuse("locked", "This thread is locked: only moderators and admins reply to it.");
      requirePosting(a);
      const text = checkBody(input.body);
      limitPost(a, rc.ip);
      const postId = ctx.transaction(() => store.addPost(t.id, a.id, text, now()));
      const page = Math.floor(store.postsBefore(t.id, postId) / s.postsPerPage) + 1;
      log.info("forum.post", { user: a.username, thread: t.id, post: postId });
      rc.json(201, { ok: true, post: { id: postId }, page, notes: imageNotes(text) });
    }));

    r.patch("/api/forum/posts/:id", member(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such post.");
      const input = await rc.body({ maxBytes: bodyBytes });
      const a = rc.account;
      const mod = isMod(a);
      const { p, t } = postFor(id, a);
      if (p.deleted_at) throw refuse("removed", "This post was removed.");
      if (t.deleted_at) throw refuse("removed", "This thread was removed.");
      const own = p.account_id === a.id;
      if (own) requirePosting(a);
      if (!mod) {
        if (!own) throw refuse("forbidden", "You can edit only your own posts.");
        if (t.locked) throw refuse("locked", "This thread is locked.");
        if (now() - p.created_at > editSeconds) {
          throw refuse("edit_window_closed", s.editWindowMinutes ? "A post can be edited for " + s.editWindowMinutes + " minutes after it is written." : "Posts cannot be edited.");
        }
      }
      const text = checkBody(input.body);
      if (text === p.body) return rc.json(200, { ok: true, changed: false });
      take([["edit", "a:" + a.id, "You can edit again"]]);
      ctx.transaction(() => store.editPost(p.id, text, now(), a.id));
      if (!own) audit(a, "forum.post.edit", { targetId: p.account_id, subject: "post " + p.id });
      rc.json(200, { ok: true, changed: true, notes: imageNotes(text) });
    }));

    r.delete("/api/forum/posts/:id", member(async (req, res, rc) => {
      const a = rc.account;
      const mod = isMod(a);
      const { p, t } = postFor(idOf(rc.params.id, "No such post."), a);
      const own = p.account_id === a.id;
      if (!own && !mod) throw refuse("forbidden", "You can remove only your own posts.");
      if (!mod && t.locked) throw refuse("locked", "This thread is locked.");
      if (p.deleted_at) return rc.json(200, { ok: true, changed: false, threadRemoved: !!t.deleted_at });
      const kind = own ? "author" : "moderator";
      const ts = now();
      const result = ctx.transaction(() => {
        store.removePost(p.id, ts, a.id, kind);
        if (kind === "moderator") store.closeReportsForPost(p.id, ts, a.id, "post removed");
        return store.refreshThread(t.id, a.id, ts);
      });
      if (kind === "moderator") audit(a, "forum.post.remove", { targetId: p.account_id, subject: "post " + p.id });
      rc.json(200, { ok: true, changed: true, threadRemoved: result.empty || !!t.deleted_at });
    }));

    r.post("/api/forum/posts/:id/restore", moderator(async (req, res, rc) => {
      const a = rc.account;
      const { p, t } = postFor(idOf(rc.params.id, "No such post."), a);
      if (!p.deleted_at) return rc.json(200, { ok: true, changed: false });
      const ts = now();
      const result = ctx.transaction(() => {
        store.restorePost(p.id);
        return store.refreshThread(t.id, a.id, ts);
      });
      audit(a, "forum.post.restore", { targetId: p.account_id, subject: "post " + p.id });
      rc.json(200, { ok: true, changed: true, threadRemoved: result.empty ? "empty" : (store.thread(t.id).deleted_kind || null) });
    }));

    // A moderator takes one picture out of a post: each place the post shows it from src becomes
    // "(picture removed by a moderator)", as an edit by the moderator, into the audit log.
    r.post("/api/forum/posts/:id/pictures/remove", moderator(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such post.");
      const input = await rc.body();
      const a = rc.account;
      const { p } = postFor(id, a);
      const src = typeof input.src === "string" ? imageSource(input.src) : null;
      if (!src || src !== input.src) throw invalid("bad_request", "src is the address of a picture the post shows.");
      const reason = optionalText(input.reason, 300, "The reason");
      const text = withoutImage(p.body, src);
      if (text === p.body) throw notFound("That picture is not in this post.");
      ctx.transaction(() => store.editPost(p.id, text, now(), a.id));
      audit(a, "forum.post.picture.remove", { targetId: p.account_id, subject: "post " + p.id, detail: (reason ? reason + "; " : "") + src });
      rc.json(200, { ok: true, changed: true });
    }));

    r.post("/api/forum/posts/:id/report", member(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such post.");
      const input = await rc.body();
      const a = rc.account;
      const { p, t } = postFor(id, a);
      if (p.deleted_at || t.deleted_at) throw refuse("removed", "This post was removed already.");
      if (p.account_id === a.id) throw invalid("own_post", "That is your own post: edit or remove it instead.");
      const reason = typeof input.reason === "string" ? cleanLine(input.reason) : "";
      if (reason.length < 3) throw invalid("invalid_reason", "Say in a few words what is wrong with the post.");
      if (reason.length > 500) throw invalid("invalid_reason", "Keep the reason to 500 characters.");
      if (store.openReportBy(p.id, a.id)) return rc.json(200, { ok: true, changed: false });
      take([["report", "a:" + a.id, "You can send another report"]]);
      try {
        store.addReport(p.id, a.id, reason, p.body, now());
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) return rc.json(200, { ok: true, changed: false });
        throw e;
      }
      log.info("forum.report", { user: a.username, post: p.id });
      rc.json(201, { ok: true, changed: true });
    }));

    // One vote per account per post: 1 likes, -1 dislikes, 0 takes the vote back. Not on your own
    // post, not on a removed one, not while your posting is off (the guard refuses the suspended).
    r.put("/api/forum/posts/:id/vote", member(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such post.");
      const input = await rc.body();
      const a = rc.account;
      const { p, t } = postFor(id, a);
      if (p.deleted_at || t.deleted_at) throw refuse("removed", "This post was removed.");
      if (p.account_id === a.id) throw refuse("own_post", "You cannot vote on your own post.");
      requirePosting(a);
      const value = input.value;
      if (value !== 1 && value !== -1 && value !== 0) throw invalid("bad_request", "value is 1 (like), -1 (dislike) or 0 (take the vote back).");
      take([["vote", "a:" + a.id, "You can vote again"]]);
      store.vote(p.id, a.id, value, now());
      rc.json(200, { ok: true, ...(store.voteCounts([p.id]).get(p.id) || { likes: 0, dislikes: 0 }), mine: value });
    }));

    r.post("/api/forum/preview", member(async (req, res, rc) => {
      const input = await rc.body({ maxBytes: bodyBytes });
      if (typeof input.body !== "string") throw invalid("invalid_body", "Write something first.");
      const text = cleanText(input.body);
      if (text.length > s.postMax) throw invalid("invalid_body", "Keep a post to " + s.postMax + " characters; this one has " + text.length + ".");
      take([["preview", "a:" + rc.account.id, "You can preview again"]]);
      rc.json(200, { content: parse(text, { maxImages: s.maxImagesPerPost }), notes: imageNotes(text) });
    }));

    // ---- threads: the author's title, and the moderators' tools ---------------------------------

    r.patch("/api/forum/threads/:id", member(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such thread.");
      const input = await rc.body();
      const a = rc.account;
      const mod = isMod(a);
      const t = threadFor(id, a);
      const own = t.account_id === a.id;
      const change = {};
      if (input.title !== undefined) {
        if (!mod && !(own && !t.deleted_at && !t.locked && now() - t.created_at <= editSeconds)) {
          throw refuse("forbidden", own ? "The title can be changed for " + s.editWindowMinutes + " minutes after the thread starts." : "Only moderators rename other people's threads.");
        }
        if (own) requirePosting(a);
        change.title = checkTitle(input.title);
      }
      for (const k of ["pinned", "locked", "hidden"]) {
        if (input[k] === undefined) continue;
        if (!mod) throw refuse("forbidden", "Only moderators pin, lock and hide threads.");
        if (typeof input[k] !== "boolean") throw invalid("bad_request", k + " must be true or false.");
        change[k] = input[k];
      }
      if (input.category !== undefined) {
        if (!mod) throw refuse("forbidden", "Only moderators move threads.");
        const c = typeof input.category === "string" && SLUG.test(input.category) ? store.categoryBySlug(input.category) : null;
        if (!c) throw invalid("bad_request", "No such category.");
        change.category = c;
      }
      if (!Object.keys(change).length) throw invalid("bad_request", "Nothing to change.");
      const done = [];
      ctx.transaction(() => {
        if (change.title !== undefined && change.title !== t.title) {
          store.setTitle(t.id, change.title);
          if (!own) done.push(["forum.thread.rename", t.title + " -> " + change.title]);
        }
        const pinned = change.pinned === undefined ? !!t.pinned : change.pinned;
        const locked = change.locked === undefined ? !!t.locked : change.locked;
        if (pinned !== !!t.pinned) done.push([pinned ? "forum.thread.pin" : "forum.thread.unpin", null]);
        if (locked !== !!t.locked) done.push([locked ? "forum.thread.lock" : "forum.thread.unlock", null]);
        if (pinned !== !!t.pinned || locked !== !!t.locked) store.setFlags(t.id, pinned, locked);
        if (change.hidden !== undefined && change.hidden !== !!t.hidden_at) {
          store.setHidden(t.id, change.hidden, a.id, now());
          done.push([change.hidden ? "forum.thread.hide" : "forum.thread.unhide", null]);
        }
        if (change.category && change.category.id !== t.category_id) {
          const from = store.category(t.category_id);
          store.moveThread(t.id, change.category.id);
          done.push(["forum.thread.move", from.name + " -> " + change.category.name]);
        }
      });
      for (const [action, detail] of done) audit(a, action, { targetId: t.account_id, subject: "thread " + t.id, detail });
      const fresh = store.thread(t.id);
      rc.json(200, { ok: true, thread: threadView(fresh, store.category(fresh.category_id), a) });
    }));

    r.delete("/api/forum/threads/:id", moderator(async (req, res, rc) => {
      const a = rc.account;
      const t = threadFor(idOf(rc.params.id, "No such thread."), a);
      if (t.deleted_kind === "moderator") return rc.json(200, { ok: true, changed: false });
      const ts = now();
      ctx.transaction(() => {
        store.removeThread(t.id, ts, a.id);
        store.closeReportsForThread(t.id, ts, a.id, "thread removed");
      });
      audit(a, "forum.thread.remove", { targetId: t.account_id, subject: "thread " + t.id, detail: t.title });
      rc.json(200, { ok: true, changed: true });
    }));

    r.post("/api/forum/threads/:id/restore", moderator(async (req, res, rc) => {
      const a = rc.account;
      const t = threadFor(idOf(rc.params.id, "No such thread."), a);
      if (!t.deleted_at) return rc.json(200, { ok: true, changed: false });
      if (!store.visiblePosts(t.id)) {
        throw new HttpError(409, "empty", "No post in this thread is left. Restore one of its posts and the thread comes back with it.");
      }
      ctx.transaction(() => {
        store.restoreThread(t.id);
        store.refreshThread(t.id, a.id, now());
      });
      audit(a, "forum.thread.restore", { targetId: t.account_id, subject: "thread " + t.id, detail: t.title });
      rc.json(200, { ok: true, changed: true });
    }));

    r.get("/api/forum/removed", moderator(async (req, res, rc) => {
      const per = s.threadsPerPage;
      const total = store.removedCount();
      const pg = paging(rc.query.get("page"), total, per);
      const names = new Map(store.categories().map((c) => [c.id, c.name]));
      rc.json(200, {
        viewer: viewer(rc.account),
        threads: store.removedPage(per, pg.offset).map((t) => ({ ...threadRow(t), category: names.get(t.category_id) || null })),
        page: pg.page, pages: pg.pages, perPage: per, total,
      });
    }));

    // ---- reports -------------------------------------------------------------------------------

    r.get("/api/forum/reports", moderator(async (req, res, rc) => {
      const closed = rc.query.get("status") === "closed";
      const per = 20;
      const total = closed ? store.closedReportCount() : store.openReportCount();
      const pg = paging(rc.query.get("page"), total, per);
      const rows = closed ? store.closedReports(per, pg.offset) : store.openReports(per, pg.offset);
      rc.json(200, {
        viewer: viewer(rc.account), status: closed ? "closed" : "open", reports: rows.map(reportView),
        page: pg.page, pages: pg.pages, perPage: per, total,
      });
    }));

    r.post("/api/forum/reports/:id/close", moderator(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such report.");
      const input = await rc.body({ optional: true });
      const a = rc.account;
      const rep = store.report(id);
      if (!rep) throw notFound("No such report.");
      if (rep.closed_at) return rc.json(200, { ok: true, changed: false });
      const outcome = optionalText(input.outcome, 200, "The outcome") || "dismissed";
      store.closeReport(id, now(), a.id, outcome);
      const p = store.post(rep.post_id);
      audit(a, "forum.report.close", { targetId: p ? p.account_id : null, subject: "report " + id + " on post " + rep.post_id, detail: outcome });
      rc.json(200, { ok: true, changed: true });
    }));

    // ---- categories (admins) -------------------------------------------------------------------

    function roleField(value, current, what) {
      if (value === undefined) return current;
      if (!auth.ROLES.includes(value)) throw invalid("bad_request", what + " must be user, moderator or admin.");
      return value;
    }

    function categoryFields(input, current) {
      let name = current ? current.name : undefined;
      if (input.name !== undefined || !current) {
        name = typeof input.name === "string" ? cleanLine(input.name) : "";
        if (!name || name.length > 60) throw invalid("invalid_name", "Give the category a name of 1 to 60 characters.");
      }
      let description = current ? current.description : "";
      if (input.description !== undefined) {
        if (typeof input.description !== "string") throw invalid("bad_request", "The description must be text.");
        description = cleanLine(input.description);
        if (description.length > 300) throw invalid("bad_request", "Keep the description to 300 characters.");
      }
      let visible = current ? !!current.visible : true;
      if (input.visible !== undefined) {
        if (typeof input.visible !== "boolean") throw invalid("bad_request", "visible must be true or false.");
        visible = input.visible;
      }
      return {
        name, description, visible,
        startRole: roleField(input.startRole, current ? current.start_role : "user", "startRole"),
        replyRole: roleField(input.replyRole, current ? current.reply_role : "user", "replyRole"),
      };
    }

    const categoryWords = (f) => "name " + f.name + "; starts threads: " + f.startRole + "; replies: " + f.replyRole + "; " + (f.visible ? "visible" : "hidden");

    r.post("/api/forum/categories", admin(async (req, res, rc) => {
      const input = await rc.body();
      const a = rc.account;
      const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
      if (!SLUG.test(slug)) throw invalid("invalid_slug", "The address takes 1 to 40 of a-z, 0-9 and -, starting with a letter or a digit.");
      if (store.categoryBySlug(slug)) throw new HttpError(409, "slug_taken", "A category has that address already.");
      const f = categoryFields(input, null);
      store.addCategory(slug, f, now());
      audit(a, "forum.category.add", { subject: "category " + slug, detail: categoryWords(f) });
      rc.json(201, { ok: true, category: categoryView(store.categoryBySlug(slug), a, false) });
    }));

    r.patch("/api/forum/categories/:slug", admin(async (req, res, rc) => {
      const input = await rc.body();
      const a = rc.account;
      const c = categoryOr404(rc.params.slug, a);
      if (input.move !== undefined) {
        if (input.move !== "up" && input.move !== "down") throw invalid("bad_request", "move is up or down.");
        const moved = ctx.transaction(() => store.moveCategory(c.id, input.move));
        if (moved) audit(a, "forum.category.move", { subject: "category " + c.slug, detail: input.move });
        return rc.json(200, { ok: true, changed: moved });
      }
      const f = categoryFields(input, c);
      const changed = f.name !== c.name || f.description !== c.description || f.startRole !== c.start_role
        || f.replyRole !== c.reply_role || f.visible !== !!c.visible;
      if (changed) {
        store.updateCategory(c.id, f);
        audit(a, "forum.category.edit", { subject: "category " + c.slug, detail: categoryWords(f) });
      }
      rc.json(200, { ok: true, changed, category: categoryView(store.categoryBySlug(c.slug), a, false) });
    }));

    // { moveTo: "<slug>" } moves every thread (removed ones too) to that category first.
    r.delete("/api/forum/categories/:slug", admin(async (req, res, rc) => {
      const input = await rc.body({ optional: true });
      const a = rc.account;
      const c = categoryOr404(rc.params.slug, a);
      if (store.categories().length <= 1) throw new HttpError(409, "last_category", "The forum needs at least one category.");
      let to = null;
      if (input.moveTo !== undefined) {
        to = typeof input.moveTo === "string" && SLUG.test(input.moveTo) ? store.categoryBySlug(input.moveTo) : null;
        if (!to || to.id === c.id) throw invalid("bad_request", "Name another category to move the threads to.");
      }
      const moved = ctx.transaction(() => {
        const n = to ? store.moveAllThreads(c.id, to.id) : 0;
        const holds = store.categoryHolds(c.id);
        if (holds.threads) {
          throw new HttpError(409, "not_empty", "It still holds " + holds.threads + " thread" + (holds.threads === 1 ? "" : "s")
            + (holds.removed ? " (" + holds.removed + " of them removed)" : "") + ". Move them to another category first.");
        }
        store.deleteCategory(c.id);
        return n;
      });
      audit(a, "forum.category.remove", { subject: "category " + c.slug, detail: c.name + (to ? "; " + moved + " threads moved to " + to.name : "") });
      rc.json(200, { ok: true, moved });
    }));

    // ---- title search --------------------------------------------------------------------------

    r.get("/api/forum/search", reader(async (req, res, rc) => {
      const a = rc.account;
      const query = cleanLine(String(rc.query.get("q") || "")).slice(0, 100);
      const words = query.split(" ").filter(Boolean).slice(0, 5);
      if (!words.length || query.length < 2) throw invalid("invalid_query", "Search for at least 2 characters of a thread title.");
      take([["search", ipKey(rc.ip), "You can search again"]]);
      const per = s.threadsPerPage;
      const first = store.search(words, isMod(a), per, 0);
      const pg = paging(rc.query.get("page"), first.total, per);
      const found = pg.offset ? store.search(words, isMod(a), per, pg.offset) : first;
      const names = new Map(store.categories().map((c) => [c.id, { slug: c.slug, name: c.name }]));
      rc.json(200, {
        viewer: viewer(a), query, threads: found.rows.map((t) => ({ ...threadRow(t), category: names.get(t.category_id) || null })),
        page: pg.page, pages: pg.pages, perPage: per, total: found.total,
      });
    }));

    // ---- posting turned off (moderators and up, on accounts below their own role) -------------

    r.get("/api/forum/restrictions", moderator(async (req, res, rc) => {
      const per = 50;
      const first = store.restrictions(now(), per, 0);
      const pg = paging(rc.query.get("page"), first.total, per);
      const list = pg.offset ? store.restrictions(now(), per, pg.offset) : first;
      rc.json(200, {
        viewer: viewer(rc.account),
        accounts: list.rows.map((x) => ({
          username: x.username, role: x.role, until: iso(x.until), reason: x.reason, by: x.by_name || null, since: iso(x.created_at),
          can: { lift: outranks(rc.account, { id: x.account_id, role: x.role }) },
        })),
        page: pg.page, pages: pg.pages, perPage: per, total: list.total,
      });
    }));

    function restrictionTarget(a, name) {
      const target = ctx.accounts.getByUsername(name);
      if (!target) throw notFound("No such account.");
      if (!outranks(a, target)) throw refuse("forbidden", target.id === a.id ? "Not on your own account." : "You cannot act on an account of your own role or above.");
      return target;
    }

    // { reason, days }: days leaves out for no end date
    r.post("/api/forum/restrictions/:name", moderator(async (req, res, rc) => {
      const input = await rc.body();
      const a = rc.account;
      const target = restrictionTarget(a, rc.params.name);
      const reason = typeof input.reason === "string" ? cleanLine(input.reason) : "";
      if (reason.length < 3 || reason.length > 300) throw invalid("invalid_reason", "Give a reason of 3 to 300 characters: the player sees it.");
      let until = null;
      if (input.days !== undefined && input.days !== null) {
        if (typeof input.days !== "number" || !(input.days > 0) || input.days > 3650) throw invalid("bad_request", "days is a number from above 0 to 3650, or left out for no end.");
        until = now() + Math.round(input.days * 86400);
      }
      store.restrict(target.id, until, reason, a.id, now());
      audit(a, "forum.posting.off", { target, detail: (until ? "until " + iso(until) : "no end date") + ": " + reason });
      rc.json(200, { ok: true, until: iso(until), reason });
    }));

    r.delete("/api/forum/restrictions/:name", moderator(async (req, res, rc) => {
      const a = rc.account;
      const target = restrictionTarget(a, rc.params.name);
      const lifted = store.lift(target.id);
      if (lifted) audit(a, "forum.posting.on", { target });
      rc.json(200, { ok: true, changed: !!lifted });
    }));

    // ---- profile pictures ----------------------------------------------------------------------

    fs.mkdirSync(pictureDir, { recursive: true, mode: 0o700 });
    const pictureFile = (accountId, version, type) => path.join(pictureDir, accountId + "-" + version + "." + EXT[type]);
    const dropFile = (file) => fs.promises.unlink(file).catch(() => {});

    // Files no row names any more (an account deleted by the admin command, a replaced picture
    // whose old file a crash left behind) go at start.
    {
      const live = new Set(store.pictureVersions().map((x) => x.account_id + "-" + x.version));
      for (const name of fs.readdirSync(pictureDir)) {
        const m = /^(\d+-\d+)\.(png|jpg|webp|gif)$/.exec(name);
        if ((m && !live.has(m[1])) || name.endsWith(".tmp")) await dropFile(path.join(pictureDir, name));
      }
    }
    ctx.events.on("account-deleted", ({ id }) => {
      const row = store.picture(id);
      if (row) dropFile(pictureFile(id, row.version, row.type));
    });

    const mb = (n) => (n / MB).toFixed(n % MB ? 1 : 0) + " MB";
    function readPicture(req) {
      return new Promise((resolve, reject) => {
        const tooLarge = () => new HttpError(413, "payload_too_large", "The picture is larger than " + mb(s.pictureMaxBytes) + ".");
        const declared = req.headers["content-length"];
        if (declared !== undefined && !(Number(declared) <= s.pictureMaxBytes)) {
          req.resume();
          return reject(tooLarge());
        }
        const chunks = [];
        let size = 0;
        let done = false;
        req.on("data", (chunk) => {
          if (done) return;
          size += chunk.length;
          if (size > s.pictureMaxBytes) {
            done = true;
            req.resume();
            return reject(tooLarge());
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (!done) {
            done = true;
            resolve(Buffer.concat(chunks, size));
          }
        });
        // an upload the client gave up on settles too, so it never holds a place in picturesAtOnce
        const broken = () => {
          if (!done) {
            done = true;
            reject(new HttpError(400, "bad_request", "The picture could not be read."));
          }
        };
        req.on("error", broken);
        req.on("close", broken);
      });
    }

    const pictureLimits = () => ({
      enabled: s.pictureQuotaBytes > 0, types: PICTURE_TYPES, maxBytes: s.pictureMaxBytes,
      maxSide: s.pictureMaxSide, maxFrames: s.pictureMaxFrames,
    });
    const ownPicture = (a) => {
      const row = store.picture(a.id);
      return row ? { ...pictureRef(a.id, row.version, row.bytes, row.frames, row.type), width: row.width, height: row.height } : null;
    };

    r.get("/api/forum/avatar", member(async (req, res, rc) => {
      rc.json(200, { picture: ownPicture(rc.account), limits: pictureLimits() });
    }));

    let uploading = 0;
    r.put("/api/forum/avatar", member(async (req, res, rc) => {
      const a = rc.account;
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!PICTURE_TYPES.includes(type)) {
        req.resume();
        throw new HttpError(415, "unsupported_media_type", "Send the picture itself, as image/png, image/jpeg, image/webp or image/gif.");
      }
      if (!s.pictureQuotaBytes) {
        req.resume();
        throw refuse("pictures_off", "Profile pictures are switched off.");
      }
      try {
        requirePosting(a);
      } catch (e) {
        req.resume();
        throw e;
      }
      const lim = hit("picture", "a:" + a.id);
      if (!lim.ok) {
        req.resume();
        throw tooFast(lim, "You can change your picture again");
      }
      if (uploading >= s.picturesAtOnce) {
        req.resume();
        throw new HttpError(503, "busy", "Many pictures are on their way in just now. Try again in a moment.", { headers: { "Retry-After": "5" } });
      }
      uploading++;
      try {
        const img = inspectPicture(await readPicture(req), { maxSide: s.pictureMaxSide, maxFrames: s.pictureMaxFrames });
        if (!img.ok) throw invalid("invalid_picture", img.message);
        const before = store.picture(a.id);
        if (store.pictureBytes() - (before ? before.bytes : 0) + img.data.length > s.pictureQuotaBytes) {
          throw new HttpError(507, "storage_full", "There is no room for more pictures just now. Tell an admin.");
        }
        const version = Math.max(Date.now(), before ? before.version + 1 : 0);
        const file = pictureFile(a.id, version, img.type);
        const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
        try {
          await fs.promises.writeFile(tmp, img.data, { mode: 0o600 });
          await fs.promises.rename(tmp, file);
        } catch (e) {
          await dropFile(tmp);
          throw e;
        }
        // whichever picture the table names at this moment is the one replaced
        const replaced = store.picture(a.id);
        store.setPicture(a.id, { version, type: img.type, bytes: img.data.length, width: img.width, height: img.height, frames: img.frames }, now());
        if (replaced) dropFile(pictureFile(a.id, replaced.version, replaced.type));
        log.info("forum.picture", { user: a.username, type: img.type, bytes: img.data.length, frames: img.frames });
        rc.json(200, { ok: true, picture: ownPicture(a), limits: pictureLimits() });
      } finally {
        uploading--;
      }
    }));

    r.delete("/api/forum/avatar", member(async (req, res, rc) => {
      const row = store.picture(rc.account.id);
      if (!row) return rc.json(200, { ok: true, changed: false });
      store.removePicture(rc.account.id);
      dropFile(pictureFile(rc.account.id, row.version, row.type));
      rc.json(200, { ok: true, changed: true });
    }));

    r.post("/api/forum/avatars/:name/remove", moderator(async (req, res, rc) => {
      const input = await rc.body({ optional: true });
      const a = rc.account;
      const target = ctx.accounts.getByUsername(rc.params.name);
      if (!target) throw notFound("No such account.");
      if (!outranks(a, target)) {
        throw refuse("forbidden", target.id === a.id ? "Remove your own picture under ACCOUNT." : "You cannot act on an account of your own role or above.");
      }
      const reason = optionalText(input.reason, 300, "The reason");
      const row = store.picture(target.id);
      if (!row) return rc.json(200, { ok: true, changed: false });
      store.removePicture(target.id);
      dropFile(pictureFile(target.id, row.version, row.type));
      audit(a, "forum.picture.remove", { target, detail: reason });
      rc.json(200, { ok: true, changed: true });
    }));

    r.get("/api/forum/avatars/:id", reader(async (req, res, rc) => {
      const id = idOf(rc.params.id, "No such picture.");
      const row = store.picture(id);
      if (!row) throw notFound("No such picture.");
      const file = pictureFile(id, row.version, row.type);
      let size;
      try {
        size = (await fs.promises.stat(file)).size;
      } catch (e) {
        throw notFound("No such picture.");
      }
      const etag = "\"" + row.version + "\"";
      const current = rc.query.get("v") === String(row.version);
      const headers = {
        "Cache-Control": current ? (s.guestRead ? "public" : "private") + ", max-age=31536000, immutable" : "no-cache",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
      };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return void res.end();
      }
      res.writeHead(200, { ...headers, "Content-Type": row.type, "Content-Length": size, "Content-Disposition": "inline" });
      if (req.method === "HEAD") return void res.end();
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    }));
  },
};
