// HAVOC9: the "What we need" page. Reads GET /api/forum/needs (h9web's forum module, needs.js)
// and draws it with assets/forum-render.js (createElement and textContent only). Its editors
// (admins, and moderators and developers by default) get EDIT THIS PAGE, the same editor as the
// admin panel's WHAT WE NEED tab.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../../", script && script.src ? script.src : location.href);
  const $ = (id) => document.getElementById(id);

  async function load() {
    const status = $("needsStatus");
    let r;
    try {
      r = await fetch(new URL("api/forum/needs", root).href, { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      status.textContent = "The site is not answering. Try again in a minute.";
      return;
    }
    if (r.status !== 200) {
      status.textContent = "This page could not be read just now (" + r.status + ").";
      return;
    }
    const view = await r.json();
    status.hidden = true;
    if (view.page && view.page.title) {
      $("needsTitle").textContent = view.page.title.toUpperCase();
      document.title = view.page.title.toUpperCase() + " -- HAVOC9";
    }
    window.H9ForumRender.needs(view, $("needsPage"));
    if (view.canEdit) {
      $("needsEditOpen").hidden = false;
      $("needsEdit").addEventListener("click", () => {
        const box = $("needsEditor");
        box.hidden = !box.hidden;
        if (!box.hidden) window.H9ForumRender.needsEditor(box, view, call, (saved) => window.H9ForumRender.needs(saved, $("needsPage")));
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
