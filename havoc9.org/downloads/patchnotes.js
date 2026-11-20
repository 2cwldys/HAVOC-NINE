// HAVOC9: the patch notes on the DOWNLOADS page. Reads GET /api/forum/patchnotes (h9web's forum
// module, patchnotes.js) and draws it with assets/forum-render.js (createElement and textContent
// only). Its editors (admins, and moderators and developers by default) get EDIT NOTES, the same
// editor as the admin panel's PATCH NOTES tab.
//
// The section stays out of the page until the notes are read, so a site without the backend, or a
// browser with script off, shows the downloads alone rather than an empty heading.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const $ = (id) => document.getElementById(id);

  async function load() {
    let r;
    try {
      r = await fetch(new URL("api/forum/patchnotes", root).href, { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      return;
    }
    if (r.status !== 200) return;
    let view;
    try {
      view = await r.json();
    } catch (e) {
      return;
    }
    if (!view || !view.page) return;
    $("patchNotes").hidden = false;
    if (view.page.title) $("patchNotesTitle").textContent = view.page.title.toUpperCase();
    window.H9ForumRender.patchNotes(view, $("patchNotesPage"));
    if (view.canEdit) {
      $("patchNotesEditOpen").hidden = false;
      $("patchNotesEdit").addEventListener("click", () => {
        const box = $("patchNotesEditor");
        box.hidden = !box.hidden;
        if (!box.hidden) window.H9ForumRender.patchNotesEditor(box, view, call, (saved) => window.H9ForumRender.patchNotes(saved, $("patchNotesPage")));
      });
    }
  }

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await fetch(new URL("api/" + path, root).href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      return { status: 0, data: { message: "The site is not answering. Try again in a minute." } };
    }
    let data = {};
    try {
      data = (await r.json()) || {};
    } catch (e) {
      // not JSON
    }
    return { status: r.status, data };
  }

  load();
})();
