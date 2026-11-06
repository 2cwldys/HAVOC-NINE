// Profile walls: comments on a member's forum profile (havoc9.org/forum/user/?u=<name>, the page a
// double-click on a player opens in game), by any member in good standing, on another's wall or
// their own.
//
//   GET    /api/forum/users/:name/wall?page=N    the wall: its comments, the owner's pins first (at
//                                                most WALL_PINS), then the newest; whether it is
//                                                open, and what the reader may do
//   POST   /api/forum/users/:name/wall           members: { body }, a new comment
//   PUT    /api/forum/users/:name/wall           the owner: { open }: everyone may write (true) or
//                                                nobody (false)
//   POST   /api/forum/wall/preview               members: { body, wall: name } for a new comment,
//                                                { body, comment: id } for an edit: the comment as
//                                                it would show; nothing is stored
//   PATCH  /api/forum/wall/:id                   its author, for editWindowMinutes: { body }
//   DELETE /api/forum/wall/:id                   its author or the wall's owner: gone for good
//   PUT    /api/forum/wall/:id/pin               the owner: { pinned }
//   POST   /api/forum/wall/:id/remove            moderators: { note }, on a comment by an account
//                                                below their own role: it stays, as "Removed by a
//                                                moderator", and the audit log keeps the note
// Stopping someone from writing on walls is the forum's own sanction, posting off
// (POST /api/forum/restrictions/:name), which the profile offers beside each comment.
//
// Writing follows the forum's posting rules: signed in, not suspended (the guards refuse a
// suspended account), posting on, the post size limit, the post rate limits per account and per
// address (a comment counts as a post, slower for new accounts), and a flood limit per wall
// (wallFlood). While a wall is off nobody writes on it or edits a comment there; its owner still
// pins and deletes. A comment is the post markup, cleaned and rendered as posts are (contentOf),
// and its author block is a post's (the same author columns, counts and picture). A comment
// removed by a moderator keeps its place, its text for staff only, and gives up its pin.
// Tables forum_wall_comments and forum_walls (migration 11): deleting an account deletes its wall
// and its comments.

import { cleanText, cleanLine } from "./markup.js";
import { AUTHOR_COLUMNS } from "./store.js";

export const WALL_PINS = 5;

export function createWall(h) {
  const { ctx, s, store } = h;
  const { HttpError } = ctx.http;
  const db = ctx.db;
  const editSeconds = s.editWindowMinutes * 60;
  const ROW = `SELECT c.*, ${AUTHOR_COLUMNS}
    FROM forum_wall_comments c
    LEFT JOIN accounts a ON a.id = c.account_id
    LEFT JOIN forum_avatars av ON av.account_id = c.account_id`;
  const q = {
    count: db.prepare("SELECT count(*) AS n FROM forum_wall_comments WHERE wall_id = ?"),
    // the owner's pins first, the latest pin first; then the newest
    page: db.prepare(`${ROW} WHERE c.wall_id = ? ORDER BY c.pinned_at IS NULL, c.pinned_at DESC, c.id DESC LIMIT ? OFFSET ?`),
    row: db.prepare(`${ROW} WHERE c.id = ?`),
    pins: db.prepare("SELECT count(*) AS n FROM forum_wall_comments WHERE wall_id = ? AND pinned_at IS NOT NULL"),
    insert: db.prepare("INSERT INTO forum_wall_comments (wall_id, account_id, body, created_at) VALUES (?, ?, ?, ?)"),
    edit: db.prepare("UPDATE forum_wall_comments SET body = ?, edited_at = ? WHERE id = ?"),
    del: db.prepare("DELETE FROM forum_wall_comments WHERE id = ?"),
    pin: db.prepare("UPDATE forum_wall_comments SET pinned_at = ? WHERE id = ?"),
    remove: db.prepare(`UPDATE forum_wall_comments SET removed_at = ?, removed_by = ?, removed_note = ?, pinned_at = NULL
      WHERE id = ? AND removed_at IS NULL`),
    wall: db.prepare("SELECT open FROM forum_walls WHERE account_id = ?"),
    setOpen: db.prepare(`INSERT INTO forum_walls (account_id, open, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET open = excluded.open, updated_at = excluded.updated_at`),
  };
  const isOpen = (ownerId) => {
    const w = q.wall.get(ownerId);
    return !w || !!w.open;
  };
  const notFound = (message) => new HttpError(404, "not_found", message);
  const refuse = (code, message) => new HttpError(403, code, message);
  const closed = (owner) => refuse("wall_closed", owner.username + " has turned their wall off: nobody writes on it for now.");

  function ownerOr404(name) {
    const owner = typeof name === "string" && name ? ctx.accounts.getByUsername(name) : null;
    if (!owner) throw notFound("No such member.");
    return owner;
  }

  function commentFor(idText) {
    const c = q.row.get(h.idOf(idText, "No such comment."));
    if (!c) throw notFound("No such comment.");
    return c;
  }

  function checkBody(value) {
    if (typeof value !== "string") throw new HttpError(400, "invalid_body", "Write something first.");
    const t = cleanText(value);
    if (t.length > s.postMax) throw new HttpError(400, "invalid_body", "Keep a comment to " + s.postMax + " characters; this one has " + t.length + ".");
    return t;
  }

  // A comment as the profile draws it. page: { counts, likes } for the authors shown (their
  // forum posts and likes, as beside a post), blocked (the reader's posting is off), open.
  function commentView(c, a, owner, page) {
    const mod = h.isMod(a);
    const own = !!a && c.account_id === a.id;
    const mine = !!a && owner.id === a.id;
    const live = !c.removed_at;
    const author = { id: c.account_id, role: c.author_role };
    const v = {
      id: c.id, created: h.iso(c.created_at), edited: c.edited_at ? { at: h.iso(c.edited_at) } : null, pinned: !!c.pinned_at,
      by: c.author_name ? {
        id: c.account_id, username: c.author_name, role: c.author_role, joined: h.iso(c.author_created), developer: !!c.author_dev,
        posts: page.counts.get(c.account_id) || 0, likes: page.likes.get(c.account_id) || 0,
        picture: h.pictureRef(c.account_id, c.pic_version, c.pic_bytes, c.pic_frames, c.pic_type),
      } : null,
      removed: live ? null : "moderator",
      own,
      can: {
        edit: live && own && !page.blocked && page.open && h.now() - c.created_at <= editSeconds,
        delete: own || mine,
        pin: live && mine,
        remove: live && mod && h.outranks(a, author),
        postingOff: mod && h.outranks(a, author),
      },
    };
    if (live || mod) {
      v.body = c.body;
      v.content = h.contentOf(c.body);
    }
    if (!live && mod) v.removedNote = c.removed_note || null;
    return v;
  }

  const pageFor = (rows, a, open) => {
    const authors = rows.map((c) => c.account_id);
    return { counts: store.authorCounts(authors), likes: store.likesReceived(authors), blocked: !!h.postingBlock(a), open };
  };

  const r = ctx.router;

  r.get("/api/forum/users/:name/wall", h.reader(async (req, res, rc) => {
    const a = rc.account;
    const owner = ownerOr404(rc.params.name);
    const per = s.postsPerPage;
    const total = q.count.get(owner.id).n;
    const pg = h.paging(rc.query.get("page"), total, per);
    const rows = q.page.all(owner.id, per, pg.offset);
    const open = isOpen(owner.id);
    const page = pageFor(rows, a, open);
    let why = null;
    if (!a) why = "signin";
    else if (page.blocked) why = "posting_disabled";
    else if (!open) why = "closed";
    rc.json(200, {
      wall: { owner: owner.username, open, total, pins: q.pins.get(owner.id).n, maxPins: WALL_PINS },
      comments: rows.map((c) => commentView(c, a, owner, page)),
      page: pg.page, pages: pg.pages, perPage: per,
      can: { comment: !why, why, manage: !!a && a.id === owner.id, moderate: h.isMod(a) },
      postingBlocked: a ? h.postingBlock(a) : null,
      pictureInlineBytes: s.pictureInlineBytes,
    });
  }));

  r.post("/api/forum/users/:name/wall", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: h.bodyBytes });
    const a = rc.account;
    const owner = ownerOr404(rc.params.name);
    h.requirePosting(a);
    if (!isOpen(owner.id)) throw closed(owner);
    const text = h.checkBody(input.body);
    h.limitPost(a, rc.ip);
    h.take([["wallFlood", "w:" + owner.id, "Many comments are coming in on this wall just now. Try again"]]);
    const id = Number(q.insert.run(owner.id, a.id, text, h.now()).lastInsertRowid);
    ctx.log.info("forum.wall", { user: a.username, wall: owner.username, comment: id });
    rc.json(201, { ok: true, comment: { id } });
  }));

  r.put("/api/forum/users/:name/wall", h.member(async (req, res, rc) => {
    const input = await rc.body();
    const a = rc.account;
    const owner = ownerOr404(rc.params.name);
    if (owner.id !== a.id) throw refuse("forbidden", "Only the wall's owner turns it on or off.");
    if (typeof input.open !== "boolean") throw new HttpError(400, "bad_request", "open is true (everyone may write) or false (nobody).");
    h.take([["edit", "a:" + a.id, "You can change it again"]]);
    q.setOpen.run(a.id, input.open ? 1 : 0, h.now());
    rc.json(200, { ok: true, open: input.open });
  }));

  // A comment as it would show, stored nowhere: the same view as the wall's, without actions.
  r.post("/api/forum/wall/preview", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: h.bodyBytes });
    const a = rc.account;
    const text = checkBody(input.body);
    h.take([["preview", "a:" + a.id, "You can preview again"]]);
    let row;
    let owner;
    if (input.comment !== undefined && input.comment !== null) {
      const c = commentFor(input.comment);
      if (c.account_id !== a.id) throw refuse("forbidden", "You can edit only your own comments.");
      if (c.removed_at) throw refuse("removed", "A moderator removed this comment.");
      owner = ctx.accounts.getById(c.wall_id);
      row = { ...c, body: text, edited_at: h.now() };
    } else {
      owner = ownerOr404(input.wall);
      row = {
        ...store.authorRow(a.id), id: null, wall_id: owner.id, body: text, created_at: h.now(),
        edited_at: null, pinned_at: null, removed_at: null, removed_note: null,
      };
    }
    const view = commentView(row, a, owner, pageFor([row], a, true));
    rc.json(200, { comment: { ...view, can: {}, preview: true }, pictureInlineBytes: s.pictureInlineBytes });
  }));

  r.patch("/api/forum/wall/:id", h.member(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: h.bodyBytes });
    const a = rc.account;
    const c = commentFor(rc.params.id);
    if (c.removed_at) throw refuse("removed", "A moderator removed this comment.");
    if (c.account_id !== a.id) throw refuse("forbidden", "You can edit only your own comments.");
    h.requirePosting(a);
    if (!isOpen(c.wall_id)) throw closed(ctx.accounts.getById(c.wall_id));
    if (h.now() - c.created_at > editSeconds) {
      throw refuse("edit_window_closed", s.editWindowMinutes ? "A comment can be edited for " + s.editWindowMinutes + " minutes after it is written." : "Comments cannot be edited.");
    }
    const text = h.checkBody(input.body);
    if (text === c.body) return rc.json(200, { ok: true, changed: false });
    h.take([["edit", "a:" + a.id, "You can edit again"]]);
    q.edit.run(text, h.now(), c.id);
    rc.json(200, { ok: true, changed: true });
  }));

  r.delete("/api/forum/wall/:id", h.member(async (req, res, rc) => {
    const a = rc.account;
    const c = commentFor(rc.params.id);
    if (c.account_id !== a.id && c.wall_id !== a.id) {
      throw refuse("forbidden", "Only the comment's author and the wall's owner delete it" + (h.isMod(a) ? "; as a moderator, REMOVE it." : "."));
    }
    q.del.run(c.id);
    rc.json(200, { ok: true });
  }));

  r.put("/api/forum/wall/:id/pin", h.member(async (req, res, rc) => {
    const input = await rc.body();
    const a = rc.account;
    const c = commentFor(rc.params.id);
    if (c.wall_id !== a.id) throw refuse("forbidden", "Only the wall's owner pins comments on it.");
    if (typeof input.pinned !== "boolean") throw new HttpError(400, "bad_request", "pinned is true or false.");
    if (input.pinned && c.removed_at) throw refuse("removed", "A moderator removed this comment.");
    if (input.pinned === !!c.pinned_at) return rc.json(200, { ok: true, changed: false, pinned: input.pinned });
    if (input.pinned && q.pins.get(a.id).n >= WALL_PINS) {
      throw new HttpError(409, "too_many_pins", "You can pin at most " + WALL_PINS + " comments on your wall. Unpin one first.");
    }
    h.take([["edit", "a:" + a.id, "You can pin again"]]);
    q.pin.run(input.pinned ? h.now() : null, c.id);
    rc.json(200, { ok: true, changed: true, pinned: input.pinned });
  }));

  r.post("/api/forum/wall/:id/remove", h.moderator(async (req, res, rc) => {
    const input = await rc.body();
    const a = rc.account;
    const c = commentFor(rc.params.id);
    if (!h.outranks(a, { id: c.account_id, role: c.author_role })) {
      throw refuse("forbidden", c.account_id === a.id ? "That is your own comment: delete it instead." : "You cannot act on an account of your own role or above.");
    }
    const note = typeof input.note === "string" ? cleanLine(input.note) : "";
    if (note.length < 3 || note.length > 300) throw new HttpError(400, "invalid_note", "Say in 3 to 300 characters why it is removed: the audit log keeps it.");
    if (c.removed_at) return rc.json(200, { ok: true, changed: false });
    q.remove.run(h.now(), a.id, note, c.id);
    const owner = ctx.accounts.getById(c.wall_id);
    h.audit(a, "forum.wall.remove", { targetId: c.account_id, subject: "wall comment " + c.id + " on " + (owner ? owner.username + "'s" : "a") + " wall", detail: note });
    rc.json(200, { ok: true, changed: true });
  }));

  return { WALL_PINS };
}
