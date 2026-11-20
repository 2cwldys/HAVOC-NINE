// The patch notes on the downloads page (havoc9.org/downloads/): what changed in each release,
// kept by its editors in the admin panel's PATCH NOTES tab or with EDIT NOTES on the page.
//
//   GET  /api/forum/patchnotes            anyone: the page as text and as rendered trees, and canEdit
//   PUT  /api/forum/patchnotes            its editors: { title, intro, entries }, the whole page
//   POST /api/forum/patchnotes/preview    its editors: the same body, rendered, nothing stored
// Its editors: admins, and whom patchNotesEditors names: "moderator" (moderators and up) and
// "developer" (accounts with the DEVELOPER flag).
//
// The page is a title, a short intro and a list of entries, each with a version, a date, a kind
// (PATCHNOTES_KINDS) and a body. The intro and the bodies use the forum's markup (markup.js
// parse) with the post rules for pictures: https links on IMAGE_HOSTS only, at most
// maxImagesPerPost in each text, shown from their host (the page's CSP lists the same hosts).
// Entries are kept and shown in the order the editor puts them in, newest first by convention.
// Every save goes into the audit log (forum.patchnotes.edit). One row in forum_patchnotes
// (migration 12) holds the page as JSON; none means the default below.

import { parse, cleanText, cleanLine } from "./markup.js";

export const PATCHNOTES_KINDS = Object.freeze({
  release: "Release", hotfix: "Hotfix", preview: "Preview",
});
const MAX_ENTRIES = 100;
// One release of a busy week runs to a few hundred lines, so the body is roomy; the page is one
// row and one request, so the whole of it is held well under the 512 KB a PUT body may be.
const MAX_BODY = 20000;
const MAX_PAGE = 400000;
// A version as the build files write it (1.68, 1.68.1, 1.69-rc1), and a word for an entry that has
// no number yet ("next"), which is what tools\release-notes.mjs --unreleased writes: the build
// number is not bumped until the release goes out, so until then there is nothing to call it.
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE = Object.freeze({
  title: "Patch notes",
  intro: "What changed in each release of H9XASH, newest first.",
  entries: [],
});

export function createPatchNotes(h) {
  const { ctx, s } = h;
  const { HttpError } = ctx.http;
  const db = ctx.db;
  const q = {
    get: db.prepare("SELECT * FROM forum_patchnotes WHERE id = 1"),
    set: db.prepare(`INSERT INTO forum_patchnotes (id, doc, updated_at, updated_by) VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  };
  const render = (text) => (text ? parse(text, { maxImages: s.maxImagesPerPost }) : []);
  const canEdit = (a) => !!a && (ctx.auth.roleAtLeast(a, "admin")
    || (s.patchNotesEditors.includes("moderator") && h.isMod(a)) || (s.patchNotesEditors.includes("developer") && h.isDeveloper(a)));

  // The page from a request body, cleaned and checked, or an error message.
  function check(input) {
    if (!input || typeof input !== "object") return { error: "Send the page: title, intro and entries." };
    const title = typeof input.title === "string" ? cleanLine(input.title) : "";
    if (!title || title.length > 120) return { error: "Give the page a title of 1 to 120 characters." };
    if (input.intro !== undefined && typeof input.intro !== "string") return { error: "The intro must be text." };
    const intro = cleanText(input.intro || "");
    if (intro.length > 4000) return { error: "Keep the intro to 4000 characters; it has " + intro.length + "." };
    if (!Array.isArray(input.entries)) return { error: "entries must be a list." };
    if (input.entries.length > MAX_ENTRIES) return { error: "Keep the list to " + MAX_ENTRIES + " entries." };
    const entries = [];
    const seen = new Set();
    for (const [i, x] of input.entries.entries()) {
      const n = "Entry " + (i + 1) + ": ";
      if (!x || typeof x !== "object") return { error: n + "not an entry." };
      if (!Object.hasOwn(PATCHNOTES_KINDS, x.kind)) return { error: n + "the kind is one of " + Object.keys(PATCHNOTES_KINDS).join(", ") + "." };
      const version = typeof x.version === "string" ? cleanLine(x.version) : "";
      if (!VERSION_RE.test(version)) return { error: n + "give it a version of letters, digits, dots or dashes, like 1.68." };
      if (seen.has(version)) return { error: n + version + " is listed twice." };
      seen.add(version);
      const date = typeof x.date === "string" ? cleanLine(x.date) : "";
      if (date && !DATE_RE.test(date)) return { error: n + "the date is YYYY-MM-DD, or leave it empty." };
      if (date && Number.isNaN(Date.parse(date + "T00:00:00Z"))) return { error: n + date + " is not a date." };
      const entryTitle = typeof x.title === "string" ? cleanLine(x.title) : "";
      if (entryTitle.length > 120) return { error: n + "keep the headline to 120 characters." };
      if (x.body !== undefined && typeof x.body !== "string") return { error: n + "the body must be text." };
      const body = cleanText(x.body || "");
      if (body.length > MAX_BODY) return { error: n + "keep the body to " + MAX_BODY + " characters; it has " + body.length + "." };
      entries.push({ version, date, kind: x.kind, title: entryTitle, body });
    }
    // The whole page is one row and one request: a hundred long entries would otherwise pass every
    // check above and still be larger than the request body allows.
    const page = { title, intro, entries };
    const size = JSON.stringify(page).length;
    if (size > MAX_PAGE) return { error: "The whole page is " + size + " characters; keep it under " + MAX_PAGE + " (fewer releases, or shorter ones)." };
    return { page };
  }

  function view(page, row, a) {
    return {
      page,
      content: { intro: render(page.intro), entries: page.entries.map((x) => render(x.body)) },
      kinds: PATCHNOTES_KINDS,
      updated: row ? h.iso(row.updated_at) : null,
      editors: s.patchNotesEditors, canEdit: canEdit(a),
    };
  }

  function current() {
    const row = q.get.get();
    let page = DEFAULT_PAGE;
    if (row) {
      try {
        page = JSON.parse(row.doc);
      } catch (e) {
        ctx.log.error("forum.patchnotes_unreadable", { error: e.message });
      }
    }
    return { page, row };
  }

  const editor = (handler) => ctx.auth.requireSession(async (req, res, rc) => {
    if (!canEdit(rc.account)) throw new HttpError(403, "forbidden", "Only the page's editors change it.");
    return handler(req, res, rc);
  });
  const r = ctx.router;

  r.get("/api/forum/patchnotes", ctx.auth.optionalSession(async (req, res, rc) => {
    const { page, row } = current();
    rc.json(200, view(page, row, rc.account));
  }));

  r.post("/api/forum/patchnotes/preview", editor(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 512 * 1024 });
    h.take([["patchNotesPreview", "a:" + rc.account.id, "You can preview again"]]);
    const c = check(input);
    rc.json(200, c.error ? { error: c.error } : { error: null, ...view(c.page, null, rc.account) });
  }));

  r.put("/api/forum/patchnotes", editor(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 512 * 1024 });
    const a = rc.account;
    const c = check(input);
    if (c.error) throw new HttpError(400, "invalid_page", c.error);
    h.take([["patchNotes", "a:" + a.id, "You can save the page again"]]);
    q.set.run(JSON.stringify(c.page), h.now(), a.id);
    const newest = c.page.entries.length ? c.page.entries[0].version : "none";
    h.audit(a, "forum.patchnotes.edit", { subject: "Patch notes", detail: c.page.entries.length + " entries, newest " + newest });
    const { page, row } = current();
    rc.json(200, { ok: true, ...view(page, row, a) });
  }));
}
