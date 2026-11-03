// The MEDIA page (havoc9.org/media/): members post YouTube videos of their games as media posts,
// and members (never guests) comment on them.
//
//   GET    /api/forum/media                       the front page: every pinned post, then the newest
//                                                 mediaFrontCount others; and the archive's months
//   GET    /api/forum/media/archive/:year/:month?page=N   older posts of that month, ARCHIVE_PAGE a page
//   GET    /api/forum/media/search?q=             titles holding every word, at most 30, newest first
//   GET    /api/forum/media/:id?page=N            one post, and its comments (signed in only)
//   POST   /api/forum/media                       members: { title, link, description }
//   PATCH  /api/forum/media/:id                   the author (editWindowMinutes) or staff: { title,
//                                                 description }; staff: { pinned, hidden }
//   DELETE /api/forum/media/:id                   the author, or staff
//   POST   /api/forum/media/:id/comments          members: { body }
//   PATCH  /api/forum/media/comments/:id          its author (editWindowMinutes) or staff: { body }
//   DELETE /api/forum/media/comments/:id          its author, or staff
// Staff are moderators and admins, as for threads; each staff step on someone else's post or
// comment goes into the audit log (forum.media.*). A hidden post is seen only by staff, marked so,
// on the front page and in the archive alike; a removed post or comment by no one. Posting follows
// the forum's rules: signed in, not suspended, posting on, and the forum's limits (a media post
// counts as a thread, a comment as a post, with the slower limits for new accounts).
//
// A link may be youtube.com/watch?v=, youtu.be/, youtube.com/shorts/ or youtube.com/embed/ (and
// youtube-nocookie.com/embed/); only the 11-character video id is kept. The page shows
// THUMB_HOST's picture of it and, once a visitor clicks, EMBED_HOST's player: nothing loads from
// YouTube before that click. The page's CSP names exactly these two hosts (test/forum-media.test.js
// checks). Descriptions and comments take the forum's markup without pictures.

import { parse, cleanText, cleanLine } from "./markup.js";

export const THUMB_HOST = "i.ytimg.com";
export const EMBED_HOST = "www.youtube-nocookie.com";
export const ARCHIVE_PAGE = 20;
const COMMENTS_PAGE = 50;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

// The video id a YouTube link names, or null.
export function youtubeId(raw) {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  let id = null;
  if (host === "youtu.be") id = parts.length === 1 ? parts[0] : null;
  else if (YT_HOSTS.has(host)) {
    if (parts.length === 1 && parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts.length === 2 && (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live")) id = parts[1];
  } else if ((host === "www.youtube-nocookie.com" || host === "youtube-nocookie.com") && parts.length === 2 && parts[0] === "embed") {
    id = parts[1];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

export function createMedia(h) {
  const { ctx, s, store } = h;
  const { HttpError } = ctx.http;
  const db = ctx.db;
  const ROW = `SELECT m.*, a.username AS author_name, a.role AS author_role,
      EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = m.account_id) AS author_dev
    FROM forum_media_posts m LEFT JOIN accounts a ON a.id = m.account_id`;
  // ? = 1: staff, who see hidden posts
  const SEEN = "m.removed_at IS NULL AND (m.hidden_at IS NULL OR ? = 1)";
  const q = {
    pinned: db.prepare(`${ROW} WHERE ${SEEN} AND m.pinned = 1 ORDER BY m.created_at DESC, m.id DESC`),
    front: db.prepare(`${ROW} WHERE ${SEEN} AND m.pinned = 0 ORDER BY m.created_at DESC, m.id DESC LIMIT ?`),
    // the archive: posts not pinned, after the newest mediaFrontCount
    months: db.prepare(`SELECT strftime('%Y', created_at, 'unixepoch') AS y, strftime('%m', created_at, 'unixepoch') AS mo, count(*) AS n
      FROM (SELECT m.created_at FROM forum_media_posts m WHERE ${SEEN} AND m.pinned = 0 ORDER BY m.created_at DESC, m.id DESC LIMIT -1 OFFSET ?)
      GROUP BY y, mo ORDER BY y DESC, mo DESC`),
    month: db.prepare(`SELECT * FROM (${ROW} WHERE ${SEEN} AND m.pinned = 0 ORDER BY m.created_at DESC, m.id DESC LIMIT -1 OFFSET ?)
      WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`),
    monthCount: db.prepare(`SELECT count(*) AS n FROM (SELECT m.created_at FROM forum_media_posts m WHERE ${SEEN} AND m.pinned = 0
      ORDER BY m.created_at DESC, m.id DESC LIMIT -1 OFFSET ?) WHERE created_at >= ? AND created_at < ?`),
    get: db.prepare(`${ROW} WHERE m.id = ?`),
    insert: db.prepare("INSERT INTO forum_media_posts (account_id, title, video, description, created_at) VALUES (?, ?, ?, ?, ?)"),
    edit: db.prepare("UPDATE forum_media_posts SET title = ?, description = ?, edited_at = ? WHERE id = ?"),
    pin: db.prepare("UPDATE forum_media_posts SET pinned = ? WHERE id = ?"),
    hide: db.prepare("UPDATE forum_media_posts SET hidden_at = ?, hidden_by = ? WHERE id = ?"),
    remove: db.prepare("UPDATE forum_media_posts SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL"),
    comments: db.prepare(`SELECT c.*, a.username AS author_name, a.role AS author_role,
        EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = c.account_id) AS author_dev
      FROM forum_media_comments c LEFT JOIN accounts a ON a.id = c.account_id
      WHERE c.media_id = ? AND c.removed_at IS NULL ORDER BY c.id LIMIT ? OFFSET ?`),
    comment: db.prepare("SELECT * FROM forum_media_comments WHERE id = ?"),
    commentInsert: db.prepare("INSERT INTO forum_media_comments (media_id, account_id, body, created_at) VALUES (?, ?, ?, ?)"),
    commentEdit: db.prepare("UPDATE forum_media_comments SET body = ?, edited_at = ? WHERE id = ?"),
    commentRemove: db.prepare("UPDATE forum_media_comments SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL"),
    recount: db.prepare("UPDATE forum_media_posts SET comment_count = (SELECT count(*) FROM forum_media_comments WHERE media_id = ?1 AND removed_at IS NULL) WHERE id = ?1"),
  };
  const searches = new Map();
  function searchStatement(words) {
    let st = searches.get(words);
    if (!st) {
      st = db.prepare(`${ROW} WHERE ${SEEN}` + " AND m.title LIKE ? ESCAPE '\\'".repeat(words) + " ORDER BY m.created_at DESC, m.id DESC LIMIT 30");
      searches.set(words, st);
    }
    return st;
  }
  const likeWord = (w) => "%" + w.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

  const staff = (a) => (h.isMod(a) ? 1 : 0);
  const render = (text) => (text ? parse(text, { maxImages: 0 }) : []);
  const by = (r) => (r.author_name ? { username: r.author_name, role: r.author_role, developer: !!r.author_dev } : null);

  function view(m, a, full) {
    const own = !!a && m.account_id !== null && m.account_id === a.id;
    const mod = h.isMod(a);
    const v = {
      id: m.id, title: m.title, video: m.video, created: h.iso(m.created_at), edited: h.iso(m.edited_at),
      by: by(m), pinned: !!m.pinned, hidden: !!m.hidden_at, comments: m.comment_count,
      can: {
        edit: (own && !h.postingBlock(a) && h.now() - m.created_at <= s.editWindowMinutes * 60) || mod,
        remove: own || mod, moderate: mod,
      },
    };
    if (full) {
      v.description = m.description;
      v.content = render(m.description);
    }
    return v;
  }

  // A post the account may see, or 404.
  function postFor(id, a) {
    const m = q.get.get(id);
    if (!m || m.removed_at || (m.hidden_at && !h.isMod(a))) throw new HttpError(404, "not_found", "No such media post.");
    return m;
  }

  function checkTitle(value) {
    const t = typeof value === "string" ? cleanLine(value) : "";
    if (t.length < 3 || t.length > s.titleMax) throw new HttpError(400, "invalid_title", "Give the video a title of 3 to " + s.titleMax + " characters.");
    return t;
  }
  function checkText(value, what, max) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new HttpError(400, "bad_request", what + " must be text.");
    const t = cleanText(value);
    if (t.length > max) throw new HttpError(400, "invalid_body", "Keep " + what.toLowerCase() + " to " + max + " characters.");
    return t;
  }
  function checkComment(value) {
    const t = checkText(value, "The comment", 2000);
    if (!t.trim()) throw new HttpError(400, "invalid_body", "Write something first.");
    return t;
  }

  const monthRange = (y, mo) => [Date.UTC(y, mo - 1, 1) / 1000, Date.UTC(y, mo, 1) / 1000];
  const viewer = (a) => (a ? { signedIn: true, username: a.username, moderator: h.isMod(a), postingBlocked: h.postingBlock(a) } : { signedIn: false });

  const r = ctx.router;

  r.get("/api/forum/media", h.reader(async (req, res, rc) => {
    const a = rc.account;
    const st = staff(a);
    rc.json(200, {
      viewer: viewer(a),
      pinned: q.pinned.all(st).map((m) => view(m, a, false)),
      posts: q.front.all(st, s.mediaFrontCount).map((m) => view(m, a, false)),
      archive: q.months.all(st, s.mediaFrontCount).map((x) => ({ year: Number(x.y), month: Number(x.mo), posts: x.n })),
      frontCount: s.mediaFrontCount,
    });
  }));

  r.get("/api/forum/media/archive/:year/:month", h.reader(async (req, res, rc) => {
    const a = rc.account;
    const y = /^\d{4}$/.test(rc.params.year) ? Number(rc.params.year) : 0;
    const mo = /^\d{1,2}$/.test(rc.params.month) ? Number(rc.params.month) : 0;
    if (y < 2000 || y > 2999 || mo < 1 || mo > 12) throw new HttpError(404, "not_found", "No such month.");
    const st = staff(a);
    const [from, to] = monthRange(y, mo);
    const total = q.monthCount.get(st, s.mediaFrontCount, from, to).n;
    const pages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE));
    const page = Math.min(pages, Math.max(1, Number.parseInt(rc.query.get("page") || "1", 10) || 1));
    rc.json(200, {
      viewer: viewer(a), year: y, month: mo, total, page, pages, perPage: ARCHIVE_PAGE,
      posts: q.month.all(st, s.mediaFrontCount, from, to, ARCHIVE_PAGE, (page - 1) * ARCHIVE_PAGE).map((m) => view(m, a, false)),
    });
  }));

  r.get("/api/forum/media/search", h.reader(async (req, res, rc) => {
    const a = rc.account;
    const query = cleanLine(String(rc.query.get("q") || "")).slice(0, 100);
    const words = query.split(" ").filter(Boolean).slice(0, 5);
    if (!words.length || query.length < 2) throw new HttpError(400, "invalid_query", "Search for at least 2 characters of a title.");
    h.take([["search", h.ipKey(rc.ip), "You can search again"]]);
    rc.json(200, { viewer: viewer(a), query, posts: searchStatement(words.length).all(staff(a), ...words.map(likeWord)).map((m) => view(m, a, false)) });
  }));

  r.get("/api/forum/media/:id", h.reader(async (req, res, rc) => {
    const a = rc.account;
    const m = postFor(h.idOf(rc.params.id, "No such media post."), a);
    const out = { viewer: viewer(a), post: view(m, a, true), thumbHost: THUMB_HOST, embedHost: EMBED_HOST };
    // comments are for members: a guest sees how many there are
    if (a) {
      const pages = Math.max(1, Math.ceil(m.comment_count / COMMENTS_PAGE));
      const page = Math.min(pages, Math.max(1, Number.parseInt(rc.query.get("page") || "1", 10) || 1));
      out.comments = q.comments.all(m.id, COMMENTS_PAGE, (page - 1) * COMMENTS_PAGE).map((c) => {
        const own = c.account_id !== null && c.account_id === a.id;
        return {
          id: c.id, by: by(c), created: h.iso(c.created_at), edited: h.iso(c.edited_at), body: c.body, content: render(c.body),
          can: { edit: own && h.now() - c.created_at <= s.editWindowMinutes * 60 && !h.postingBlock(a), remove: own || h.isMod(a) },
        };
      });
      out.commentPage = page;
      out.commentPages = pages;
    }
    rc.json(200, out);
  }));

  r.post("/api/forum/media", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 64 * 1024 });
    const a = rc.account;
    h.requirePosting(a);
    const title = checkTitle(input.title);
    const video = youtubeId(input.link);
    if (!video) throw new HttpError(400, "invalid_link", "That is not a YouTube video link: use youtube.com/watch?v=..., youtu.be/..., /shorts/ or /embed/.");
    const description = checkText(input.description, "The description", 4000);
    h.limitThread(a, rc.ip);
    const id = Number(q.insert.run(a.id, title, video, description, h.now()).lastInsertRowid);
    ctx.log.info("forum.media", { user: a.username, media: id });
    rc.json(201, { ok: true, post: { id } });
  }));

  r.patch("/api/forum/media/:id", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 64 * 1024 });
    const a = rc.account;
    const mod = h.isMod(a);
    const m = postFor(h.idOf(rc.params.id, "No such media post."), a);
    const own = m.account_id === a.id;
    const done = [];
    if (input.title !== undefined || input.description !== undefined) {
      if (!mod) {
        if (!own) throw new HttpError(403, "forbidden", "You can edit only your own media posts.");
        h.requirePosting(a);
        if (h.now() - m.created_at > s.editWindowMinutes * 60) throw new HttpError(403, "edit_window_closed", "A media post can be edited for " + s.editWindowMinutes + " minutes after it is posted.");
      }
      const title = input.title !== undefined ? checkTitle(input.title) : m.title;
      const description = input.description !== undefined ? checkText(input.description, "The description", 4000) : m.description;
      h.take([["edit", "a:" + a.id, "You can edit again"]]);
      q.edit.run(title, description, h.now(), m.id);
      if (!own) done.push(["forum.media.edit", null]);
    }
    for (const k of ["pinned", "hidden"]) {
      if (input[k] === undefined) continue;
      if (!mod) throw new HttpError(403, "forbidden", "Only moderators pin and hide media posts.");
      if (typeof input[k] !== "boolean") throw new HttpError(400, "bad_request", k + " must be true or false.");
    }
    if (input.pinned !== undefined && input.pinned !== !!m.pinned) {
      q.pin.run(input.pinned ? 1 : 0, m.id);
      done.push([input.pinned ? "forum.media.pin" : "forum.media.unpin", null]);
    }
    if (input.hidden !== undefined && input.hidden !== !!m.hidden_at) {
      q.hide.run(input.hidden ? h.now() : null, input.hidden ? a.id : null, m.id);
      done.push([input.hidden ? "forum.media.hide" : "forum.media.unhide", null]);
    }
    for (const [action, detail] of done) h.audit(a, action, { targetId: m.account_id, subject: "media " + m.id, detail: detail || m.title });
    rc.json(200, { ok: true, post: view(q.get.get(m.id), a, true) });
  }));

  r.delete("/api/forum/media/:id", h.member(async (req, res, rc) => {
    const a = rc.account;
    const m = postFor(h.idOf(rc.params.id, "No such media post."), a);
    const own = m.account_id === a.id;
    if (!own && !h.isMod(a)) throw new HttpError(403, "forbidden", "You can remove only your own media posts.");
    q.remove.run(h.now(), a.id, m.id);
    if (!own) h.audit(a, "forum.media.remove", { targetId: m.account_id, subject: "media " + m.id, detail: m.title });
    rc.json(200, { ok: true });
  }));

  r.post("/api/forum/media/:id/comments", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 16 * 1024 });
    const a = rc.account;
    const m = postFor(h.idOf(rc.params.id, "No such media post."), a);
    h.requirePosting(a);
    const body = checkComment(input.body);
    h.limitPost(a, rc.ip);
    const id = ctx.transaction(() => {
      const cid = Number(q.commentInsert.run(m.id, a.id, body, h.now()).lastInsertRowid);
      q.recount.run(m.id);
      return cid;
    });
    rc.json(201, { ok: true, comment: { id } });
  }));

  function commentFor(id, a) {
    const c = q.comment.get(id);
    if (!c || c.removed_at) throw new HttpError(404, "not_found", "No such comment.");
    postFor(c.media_id, a);
    return c;
  }

  r.patch("/api/forum/media/comments/:id", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 16 * 1024 });
    const a = rc.account;
    const c = commentFor(h.idOf(rc.params.id, "No such comment."), a);
    const own = c.account_id === a.id;
    if (!own && !h.isMod(a)) throw new HttpError(403, "forbidden", "You can edit only your own comments.");
    if (own) {
      h.requirePosting(a);
      if (!h.isMod(a) && h.now() - c.created_at > s.editWindowMinutes * 60) throw new HttpError(403, "edit_window_closed", "A comment can be edited for " + s.editWindowMinutes + " minutes.");
    }
    const body = checkComment(input.body);
    h.take([["edit", "a:" + a.id, "You can edit again"]]);
    q.commentEdit.run(body, h.now(), c.id);
    if (!own) h.audit(a, "forum.media.comment.edit", { targetId: c.account_id, subject: "comment " + c.id + " on media " + c.media_id });
    rc.json(200, { ok: true });
  }));

  r.delete("/api/forum/media/comments/:id", h.member(async (req, res, rc) => {
    const a = rc.account;
    const c = commentFor(h.idOf(rc.params.id, "No such comment."), a);
    const own = c.account_id === a.id;
    if (!own && !h.isMod(a)) throw new HttpError(403, "forbidden", "You can remove only your own comments.");
    ctx.transaction(() => {
      q.commentRemove.run(h.now(), a.id, c.id);
      q.recount.run(c.media_id);
    });
    if (!own) h.audit(a, "forum.media.comment.remove", { targetId: c.account_id, subject: "comment " + c.id + " on media " + c.media_id });
    rc.json(200, { ok: true });
  }));

  return { youtubeId };
}
