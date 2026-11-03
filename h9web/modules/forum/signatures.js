// Forum signatures: a few lines an account writes once, shown under each of its posts.
//
//   GET    /api/forum/signature                 your signature, SHOW SIGNATURES, a block, the limits
//   PUT    /api/forum/signature                 { signature } and/or { showSignatures }
//   POST   /api/forum/signature/preview         { signature }: the tree it shows as, or why not
//   POST   /api/forum/signatures/:name/clear    moderators: { reason }
//   POST   /api/forum/signatures/:name/block    moderators: { reason, days } (days left out: no end)
//   DELETE /api/forum/signatures/:name/block    moderators
// Moderators act only on accounts below their own role; each step goes into the audit log.
//
// A signature is the post markup in one paragraph (markup.js parseSignature: bold, italic, code,
// links, pictures from IMAGE_HOSTS), at most signatureMaxChars characters on signatureMaxLines
// lines with signatureImages pictures, each at most signatureImageHeight pixels tall on the page.
// An account younger than newAccountHours shows its signature as plain text. Setting one is
// refused while posting is off (a suspended account is refused by the guard) or while a moderator
// blocks it, and a blocked account's signature is not shown. A reader with SHOW SIGNATURES off
// sees nobody's. Table forum_signatures (migration 6).

import { parseSignature, cleanText } from "./markup.js";

export function createSignatures(h) {
  const { ctx, s } = h;
  const { HttpError } = ctx.http;
  const db = ctx.db;
  const q = {
    get: db.prepare("SELECT * FROM forum_signatures WHERE account_id = ?"),
    ofAuthors: db.prepare(`SELECT account_id, body, blocked_until FROM forum_signatures
      WHERE account_id IN (SELECT value FROM json_each(?)) AND body <> ''`),
    setBody: db.prepare(`INSERT INTO forum_signatures (account_id, body, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`),
    setShow: db.prepare(`INSERT INTO forum_signatures (account_id, hide_others, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET hide_others = excluded.hide_others`),
    block: db.prepare(`INSERT INTO forum_signatures (account_id, blocked_until, blocked_reason, blocked_by, blocked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET blocked_until = excluded.blocked_until,
      blocked_reason = excluded.blocked_reason, blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`),
    unblock: db.prepare("UPDATE forum_signatures SET blocked_until = NULL, blocked_reason = NULL, blocked_by = NULL, blocked_at = NULL WHERE account_id = ? AND blocked_at IS NOT NULL"),
  };
  // blocked_until: NULL with blocked_at set is a block with no end
  const blockOf = (row) => (row && row.blocked_at !== null && row.blocked_at !== undefined
    && (row.blocked_until === null || row.blocked_until > h.now())
    ? { until: h.iso(row.blocked_until), reason: row.blocked_reason } : null);
  const blockedNow = (row) => !!blockOf(row);

  const cache = new Map();
  // The tree a signature shows as, for an author ({ role, created_at }): its first
  // signatureMaxLines lines and signatureMaxChars characters (the limits may have shrunk since).
  function tree(body, author) {
    const text = String(body).split("\n").slice(0, s.signatureMaxLines).join("\n").slice(0, s.signatureMaxChars);
    const plain = h.isNew(author);
    const key = (plain ? "p" : "f") + text;
    let t = cache.get(key);
    if (!t) {
      t = parseSignature(text, { maxImages: s.signatureImages, plain });
      if (cache.size >= 400) cache.delete(cache.keys().next().value);
      cache.set(key, t);
    }
    return t;
  }

  // Whether this reader turned signatures off.
  const hides = (a) => {
    if (!a) return false;
    const row = q.get.get(a.id);
    return !!(row && row.hide_others);
  };

  // For a page of posts: Map author id -> signature tree, or empty when the reader hides them.
  // rows: the posts, with account_id, author_role and author_created.
  function forPosts(rows, a) {
    const out = new Map();
    if (!s.signatureMaxChars || hides(a)) return out;
    const authors = new Map();
    for (const p of rows) if (p.account_id !== null) authors.set(p.account_id, { role: p.author_role, created_at: p.author_created });
    if (!authors.size) return out;
    for (const r of q.ofAuthors.all(JSON.stringify([...authors.keys()]))) {
      if (blockedNow(r)) continue;
      const t = tree(r.body, authors.get(r.account_id));
      if (t.length) out.set(r.account_id, t);
    }
    return out;
  }

  // For a member's profile: { signature (tree or null), block (moderators only) }.
  function profile(u, a) {
    const row = q.get.get(u.id);
    const show = !!row && !!row.body && !blockedNow(row) && !hides(a) && !!s.signatureMaxChars;
    return { signature: show ? tree(row.body, u) : null, hasSignature: !!(row && row.body), block: h.isMod(a) ? blockOf(row) : undefined };
  }

  // A text as a signature: cleaned, within the limits, or an error message.
  function check(value) {
    if (typeof value !== "string") return { error: "The signature must be text." };
    const text = cleanText(value);
    if (text.length > s.signatureMaxChars) return { error: "Keep the signature to " + s.signatureMaxChars + " characters; this one has " + text.length + "." };
    const lines = text ? text.split("\n").length : 0;
    if (lines > s.signatureMaxLines) return { error: "Keep the signature to " + s.signatureMaxLines + " lines; this one has " + lines + "." };
    return { text };
  }

  const limits = (a) => ({
    enabled: s.signatureMaxChars > 0, maxChars: s.signatureMaxChars, maxLines: s.signatureMaxLines,
    images: s.signatureImages, imageHeight: s.signatureImageHeight, plainText: h.isNew(a),
  });

  const r = ctx.router;

  r.get("/api/forum/signature", h.member(async (req, res, rc) => {
    const a = rc.account;
    const row = q.get.get(a.id);
    const body = row ? row.body : "";
    rc.json(200, {
      signature: body, showSignatures: !(row && row.hide_others), block: blockOf(row),
      content: body ? tree(body, a) : [], limits: limits(a),
    });
  }));

  r.post("/api/forum/signature/preview", h.member(async (req, res, rc) => {
    const input = await rc.body();
    const a = rc.account;
    h.take([["signaturePreview", "a:" + a.id, "You can preview again"]]);
    const c = check(input.signature);
    rc.json(200, { content: c.text ? tree(c.text, a) : [], error: c.error || null });
  }));

  r.put("/api/forum/signature", h.member(async (req, res, rc) => {
    const input = await rc.body();
    const a = rc.account;
    if (input.signature === undefined && input.showSignatures === undefined) throw new HttpError(400, "bad_request", "Send signature, showSignatures, or both.");
    if (input.showSignatures !== undefined && typeof input.showSignatures !== "boolean") throw new HttpError(400, "bad_request", "showSignatures must be true or false.");
    let text = null;
    if (input.signature !== undefined) {
      if (!s.signatureMaxChars) throw new HttpError(403, "signatures_off", "Signatures are switched off.");
      h.requirePosting(a);
      const b = blockOf(q.get.get(a.id));
      if (b) {
        throw new HttpError(403, "signature_blocked", "A moderator has stopped this account from setting a signature" + (b.until ? " until " + b.until.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "") + ". Reason: " + b.reason, { body: { until: b.until, reason: b.reason } });
      }
      const c = check(input.signature);
      if (c.error) throw new HttpError(400, "invalid_signature", c.error);
      text = c.text;
    }
    h.take([["signature", "a:" + a.id, "You can change your signature again"]]);
    ctx.transaction(() => {
      if (text !== null) q.setBody.run(a.id, text, h.now());
      if (input.showSignatures !== undefined) q.setShow.run(a.id, input.showSignatures ? 0 : 1, h.now());
    });
    if (text !== null) ctx.log.info("forum.signature", { user: a.username, chars: text.length });
    const row = q.get.get(a.id);
    rc.json(200, { ok: true, signature: row ? row.body : "", showSignatures: !(row && row.hide_others), content: row && row.body ? tree(row.body, a) : [] });
  }));

  function targetOf(a, name) {
    const target = ctx.accounts.getByUsername(name);
    if (!target) throw new HttpError(404, "not_found", "No such account.");
    if (!h.outranks(a, target)) throw new HttpError(403, "forbidden", target.id === a.id ? "Not on your own account." : "You cannot act on an account of your own role or above.");
    return target;
  }

  r.post("/api/forum/signatures/:name/clear", h.moderator(async (req, res, rc) => {
    const input = await rc.body({ optional: true });
    const a = rc.account;
    const target = targetOf(a, rc.params.name);
    const reason = h.optionalText(input.reason, 300, "The reason");
    const row = q.get.get(target.id);
    if (!row || !row.body) return rc.json(200, { ok: true, changed: false });
    q.setBody.run(target.id, "", h.now());
    h.audit(a, "forum.signature.clear", { target, detail: reason });
    rc.json(200, { ok: true, changed: true });
  }));

  r.post("/api/forum/signatures/:name/block", h.moderator(async (req, res, rc) => {
    const input = await rc.body();
    const a = rc.account;
    const target = targetOf(a, rc.params.name);
    const reason = typeof input.reason === "string" ? h.cleanLine(input.reason) : "";
    if (reason.length < 3 || reason.length > 300) throw new HttpError(400, "invalid_reason", "Give a reason of 3 to 300 characters: the player sees it.");
    let until = null;
    if (input.days !== undefined && input.days !== null) {
      if (typeof input.days !== "number" || !(input.days > 0) || input.days > 3650) throw new HttpError(400, "bad_request", "days is a number from above 0 to 3650, or left out for no end.");
      until = h.now() + Math.round(input.days * 86400);
    }
    q.block.run(target.id, until, reason, a.id, h.now(), h.now());
    h.audit(a, "forum.signature.block", { target, detail: (until ? "until " + h.iso(until) : "no end date") + ": " + reason });
    rc.json(200, { ok: true, until: h.iso(until), reason });
  }));

  r.delete("/api/forum/signatures/:name/block", h.moderator(async (req, res, rc) => {
    const a = rc.account;
    const target = targetOf(a, rc.params.name);
    const changed = Number(q.unblock.run(target.id).changes) > 0;
    if (changed) h.audit(a, "forum.signature.unblock", { target });
    rc.json(200, { ok: true, changed });
  }));

  return { forPosts, profile, hides };
}
