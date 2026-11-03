// The "What we need" page (havoc9.org/join/needs/): what the team is looking for right now, kept
// by its editors in the admin panel's WHAT WE NEED tab or with EDIT THIS PAGE on the page.
//
//   GET  /api/forum/needs            anyone: the page as text and as rendered trees, and canEdit
//   PUT  /api/forum/needs            its editors: { title, intro, items }, the whole page
//   POST /api/forum/needs/preview    its editors: the same body, rendered, nothing stored
// Its editors: admins, and whom needsEditors names: "moderator" (moderators and up) and
// "developer" (accounts with the DEVELOPER flag).
//
// The page is a title, a short intro and a list of items, each with a category (NEEDS_CATEGORIES),
// a status (NEEDS_STATUSES), a title and a description. The intro and the descriptions use the
// forum's markup (markup.js parse) with the post rules for pictures: https links on IMAGE_HOSTS
// only, at most maxImagesPerPost in each text, shown from their host (the page's CSP lists the
// same hosts). Every save goes into the audit log (forum.needs.edit). One row in forum_needs
// (migration 8) holds the page as JSON; none means the default below.

import { parse, cleanText, cleanLine } from "./markup.js";

export const NEEDS_CATEGORIES = Object.freeze({
  maps: "Maps", models: "Models", sounds: "Sounds", code: "Code", art: "Art", direction: "Project direction", other: "Other",
});
export const NEEDS_STATUSES = Object.freeze({ needed: "Needed", in_progress: "In progress", done: "Done" });
const MAX_ITEMS = 50;
const DEFAULT_PAGE = Object.freeze({
  title: "What we need",
  intro: "What the HAVOC 9 team is looking for right now. If you can help with any of it, say so on the forum or on Discord.",
  items: [],
});

export function createNeeds(h) {
  const { ctx, s } = h;
  const { HttpError } = ctx.http;
  const db = ctx.db;
  const q = {
    get: db.prepare("SELECT * FROM forum_needs WHERE id = 1"),
    set: db.prepare(`INSERT INTO forum_needs (id, doc, updated_at, updated_by) VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  };
  const render = (text) => (text ? parse(text, { maxImages: s.maxImagesPerPost }) : []);
  const canEdit = (a) => !!a && (ctx.auth.roleAtLeast(a, "admin")
    || (s.needsEditors.includes("moderator") && h.isMod(a)) || (s.needsEditors.includes("developer") && h.isDeveloper(a)));

  // The page from a request body, cleaned and checked, or an error message.
  function check(input) {
    if (!input || typeof input !== "object") return { error: "Send the page: title, intro and items." };
    const title = typeof input.title === "string" ? cleanLine(input.title) : "";
    if (!title || title.length > 120) return { error: "Give the page a title of 1 to 120 characters." };
    if (input.intro !== undefined && typeof input.intro !== "string") return { error: "The intro must be text." };
    const intro = cleanText(input.intro || "");
    if (intro.length > 4000) return { error: "Keep the intro to 4000 characters; it has " + intro.length + "." };
    if (!Array.isArray(input.items)) return { error: "items must be a list." };
    if (input.items.length > MAX_ITEMS) return { error: "Keep the list to " + MAX_ITEMS + " items." };
    const items = [];
    for (const [i, x] of input.items.entries()) {
      const n = "Item " + (i + 1) + ": ";
      if (!x || typeof x !== "object") return { error: n + "not an item." };
      if (!Object.hasOwn(NEEDS_CATEGORIES, x.category)) return { error: n + "the category is one of " + Object.keys(NEEDS_CATEGORIES).join(", ") + "." };
      if (!Object.hasOwn(NEEDS_STATUSES, x.status)) return { error: n + "the status is one of " + Object.keys(NEEDS_STATUSES).join(", ") + "." };
      const itemTitle = typeof x.title === "string" ? cleanLine(x.title) : "";
      if (!itemTitle || itemTitle.length > 120) return { error: n + "give it a title of 1 to 120 characters." };
      if (x.description !== undefined && typeof x.description !== "string") return { error: n + "the description must be text." };
      const description = cleanText(x.description || "");
      if (description.length > 2000) return { error: n + "keep the description to 2000 characters." };
      items.push({ category: x.category, status: x.status, title: itemTitle, description });
    }
    return { page: { title, intro, items } };
  }

  function view(page, row, a) {
    return {
      page,
      content: { intro: render(page.intro), items: page.items.map((x) => render(x.description)) },
      categories: NEEDS_CATEGORIES, statuses: NEEDS_STATUSES,
      updated: row ? h.iso(row.updated_at) : null,
      editors: s.needsEditors, canEdit: canEdit(a),
    };
  }

  function current() {
    const row = q.get.get();
    let page = DEFAULT_PAGE;
    if (row) {
      try {
        page = JSON.parse(row.doc);
      } catch (e) {
        ctx.log.error("forum.needs_unreadable", { error: e.message });
      }
    }
    return { page, row };
  }

  const editor = (handler) => ctx.auth.requireSession(async (req, res, rc) => {
    if (!canEdit(rc.account)) throw new HttpError(403, "forbidden", "Only the page's editors change it.");
    return handler(req, res, rc);
  });
  const r = ctx.router;

  r.get("/api/forum/needs", ctx.auth.optionalSession(async (req, res, rc) => {
    const { page, row } = current();
    rc.json(200, view(page, row, rc.account));
  }));

  r.post("/api/forum/needs/preview", editor(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 256 * 1024 });
    h.take([["needsPreview", "a:" + rc.account.id, "You can preview again"]]);
    const c = check(input);
    rc.json(200, c.error ? { error: c.error } : { error: null, ...view(c.page, null, rc.account) });
  }));

  r.put("/api/forum/needs", editor(async (req, res, rc) => {
    const input = await rc.body({ maxBytes: 256 * 1024 });
    const a = rc.account;
    const c = check(input);
    if (c.error) throw new HttpError(400, "invalid_page", c.error);
    h.take([["needs", "a:" + a.id, "You can save the page again"]]);
    q.set.run(JSON.stringify(c.page), h.now(), a.id);
    const counts = Object.keys(NEEDS_STATUSES).map((k) => c.page.items.filter((x) => x.status === k).length + " " + NEEDS_STATUSES[k].toLowerCase());
    h.audit(a, "forum.needs.edit", { subject: "What we need", detail: c.page.items.length + " items (" + counts.join(", ") + ")" });
    const { page, row } = current();
    rc.json(200, { ok: true, ...view(page, row, a) });
  }));
}
