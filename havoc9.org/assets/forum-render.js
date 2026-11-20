// HAVOC9: draws what h9web's forum markup (modules/forum/markup.js) makes of a text, with
// createElement and textContent only, never innerHTML; and the "What we need" page's editor. For
// pages outside the forum's own forum.js: the "What we need" page (join/needs/) and the admin
// panel.
//
//   window.H9ForumRender.blocks(tree, parent)    a parsed text: paragraphs, code, quotes, links and
//                                                pictures (the server names only https pictures on
//                                                the forum's picture hosts; the page's CSP allows
//                                                only those); a picture sends no Referer, loads
//                                                lazily, opens in a new tab, and shows as its link
//                                                when it does not load
//   window.H9ForumRender.needs(view, parent)     the "What we need" page from GET /api/forum/needs
//                                                (or its preview): the intro, then the items by
//                                                status, needed first
//   window.H9ForumRender.needsEditor(box, view, call, onSaved)
//                                                its editor: title, intro, items (ADD ITEM, UP,
//                                                DOWN, REMOVE), a live preview, SAVE. call(method,
//                                                path, body) answers { status, data } for a path
//                                                under /api/; onSaved(view) after a save
//   window.H9ForumRender.patchNotes(view, parent) the downloads page's patch notes from GET
//                                                /api/forum/patchnotes (or its preview): the intro,
//                                                then each release in the order it is kept, the
//                                                first one open and the rest folded away
//   window.H9ForumRender.patchNotesEditor(box, view, call, onSaved)
//                                                its editor, the same shape as needsEditor's
(() => {
  "use strict";

  const LINK_REL = "nofollow ugc noopener noreferrer";

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function href(value, httpsOnly) {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:" || (!httpsOnly && u.protocol === "http:") ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  function link(url, words) {
    const a = el("a", null, words || url);
    a.href = url;
    a.rel = LINK_REL;
    a.target = "_blank";
    return a;
  }

  function picture(n) {
    const src = href(n.src, true);
    if (!src) return String(n.alt || "");
    const img = el("img", "needs-img");
    img.src = src;
    img.alt = n.alt || "Picture";
    img.loading = "lazy";
    img.decoding = "async";
    img.setAttribute("referrerpolicy", "no-referrer");
    const a = el("a", "needs-img-link");
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow ugc";
    a.append(img);
    img.addEventListener("error", () => a.replaceChildren(n.alt || src), { once: true });
    return a;
  }

  function inline(nodes, parent, depth) {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (typeof n === "string") {
        n.split("\n").forEach((part, i) => {
          if (i) parent.append(document.createElement("br"));
          if (part) parent.append(part);
        });
      } else if (n && typeof n === "object" && depth < 4) {
        if (n.t === "b" || n.t === "i") {
          const e = el(n.t === "b" ? "strong" : "em");
          inline(n.c, e, depth + 1);
          parent.append(e);
        } else if (n.t === "code") {
          parent.append(el("code", null, String(n.text || "")));
        } else if (n.t === "a") {
          const url = href(n.href);
          parent.append(url ? link(url, String(n.text || "")) : String(n.text || ""));
        } else if (n.t === "img") {
          parent.append(picture(n));
        }
      }
    }
  }

  function blocks(list, parent, depth = 0) {
    for (const b of Array.isArray(list) ? list : []) {
      if (!b || typeof b !== "object") continue;
      if (b.t === "p") {
        const p = el("p");
        inline(b.c, p, 0);
        parent.append(p);
      } else if (b.t === "pre") {
        const pre = el("pre");
        pre.append(el("code", null, String(b.text || "")));
        parent.append(pre);
      } else if (b.t === "quote" && depth < 6) {
        const q = el("blockquote");
        blocks(b.c, q, depth + 1);
        parent.append(q);
      }
    }
  }

  const ORDER = ["needed", "in_progress", "done"];

  function needs(view, parent) {
    parent.textContent = "";
    if (!view || !view.page) return;
    const page = view.page;
    const intro = el("div", "needs-intro forum-body");
    blocks(view.content && view.content.intro, intro);
    parent.append(intro);
    const items = Array.isArray(page.items) ? page.items : [];
    const trees = (view.content && view.content.items) || [];
    if (!items.length) parent.append(el("p", "needs-empty", "Nothing on the list right now."));
    for (const status of ORDER) {
      const here = items.map((x, i) => [x, trees[i]]).filter(([x]) => x.status === status);
      if (!here.length) continue;
      const label = (view.statuses && view.statuses[status]) || status;
      parent.append(el("h2", "sub-title needs-status", label.toUpperCase() + " (" + here.length + ")"));
      const list = el("div", "needs-list");
      for (const [x, tree] of here) {
        const card = el("article", "needs-item is-" + status);
        const head = el("div", "needs-item-head");
        head.append(el("span", "needs-tag", ((view.categories && view.categories[x.category]) || x.category).toUpperCase()), el("span", "needs-title", x.title));
        card.append(head);
        const body = el("div", "needs-desc forum-body");
        blocks(tree, body);
        if (body.childNodes.length) card.append(body);
        list.append(card);
      }
      parent.append(list);
    }
    if (view.updated) {
      const d = new Date(view.updated);
      parent.append(el("p", "needs-updated", "Updated " + (isFinite(d) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "") + "."));
    }
  }

  // ---- the editor ------------------------------------------------------------------------------

  function control(tag, cls, attrs) {
    const e = el(tag, cls);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  }
  function labelled(text, field) {
    const l = el("label", "needs-field");
    l.append(el("span", "forum-label", text), field);
    return l;
  }
  function act(text, fn, kind) {
    const b = control("button", kind === "primary" ? "btn btn-primary btn-sm" : "forum-act" + (kind === "danger" ? " is-danger" : ""), { type: "button" });
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }
  function choices(map, value) {
    const s = control("select", "forum-select");
    for (const [k, label] of Object.entries(map || {})) {
      const o = el("option", null, label);
      o.setAttribute("value", k);
      if (k === value) o.selected = true;
      s.append(o);
    }
    return s;
  }

  function needsEditor(box, view, call, onSaved) {
    box.textContent = "";
    const msg = el("p", "forum-row-meta");
    msg.setAttribute("role", "status");
    const title = control("input", "forum-input", { type: "text", maxlength: "120", "aria-label": "Page title" });
    title.value = view.page.title || "";
    const intro = control("textarea", "forum-textarea", { rows: "4", maxlength: "4000", "aria-label": "Intro" });
    intro.value = view.page.intro || "";
    const list = el("div", "needs-edit-list");
    const preview = el("div", "needs-page");
    const rows = [];
    let timer = null;
    let seq = 0;
    const gather = () => ({
      title: title.value, intro: intro.value,
      items: rows.map((r) => ({ category: r.cat.value, status: r.st.value, title: r.t.value, description: r.desc.value })),
    });
    function later() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        const r = await call("POST", "forum/needs/preview", gather());
        if (mine !== seq) return;
        const error = r.status !== 200 ? (r.data && r.data.message) || "The preview could not be made (" + r.status + ")." : r.data.error;
        msg.className = error ? "forum-error" : "forum-row-meta";
        msg.textContent = error || "";
        if (!error) needs(r.data, preview);
      }, 600);
    }
    function redraw(quiet) {
      list.textContent = "";
      for (const r of rows) list.append(r.node);
      if (!rows.length) list.append(el("p", "forum-empty", "No items yet: ADD ITEM."));
      if (!quiet) later();
    }
    function addRow(x) {
      const r = {
        cat: choices(view.categories, x.category), st: choices(view.statuses, x.status),
        t: control("input", "forum-input", { type: "text", maxlength: "120", placeholder: "What is needed", "aria-label": "Item title" }),
        desc: control("textarea", "forum-textarea", { rows: "2", maxlength: "2000", "aria-label": "Item description" }),
      };
      r.cat.setAttribute("aria-label", "Category");
      r.st.setAttribute("aria-label", "Status");
      r.t.value = x.title || "";
      r.desc.value = x.description || "";
      const move = (by) => {
        const i = rows.indexOf(r);
        const j = i + by;
        if (j < 0 || j >= rows.length) return;
        rows.splice(i, 1);
        rows.splice(j, 0, r);
        redraw();
      };
      const line = el("div", "panel-actions");
      line.append(r.cat, r.st, r.t, act("UP", () => move(-1)), act("DOWN", () => move(1)),
        act("REMOVE", () => {
          rows.splice(rows.indexOf(r), 1);
          redraw();
        }, "danger"));
      r.node = el("div", "panel-item");
      r.node.append(line, r.desc);
      for (const f of [r.t, r.desc]) f.addEventListener("input", later);
      for (const f of [r.cat, r.st]) f.addEventListener("change", later);
      rows.push(r);
    }
    for (const x of view.page.items || []) addRow(x);
    title.addEventListener("input", later);
    intro.addEventListener("input", later);
    const buttons = el("div", "panel-actions");
    buttons.append(
      act("ADD ITEM", () => {
        addRow({ category: "other", status: "needed", title: "", description: "" });
        redraw();
      }),
      act("SAVE", async () => {
        const r = await call("PUT", "forum/needs", gather());
        const ok = r.status === 200;
        msg.className = ok ? "forum-done" : "forum-error";
        msg.textContent = ok ? "Saved: the page shows it now." : (r.data && r.data.message) || "Not saved (" + r.status + ").";
        if (ok) {
          needs(r.data, preview);
          if (onSaved) onSaved(r.data);
        }
      }, "primary"));
    const help = el("p", "forum-row-meta", "The intro and the descriptions take the forum's formatting: bold, italic, links, and pictures linked from the forum's picture hosts, shown from that site. SAVE stores the whole page and goes into the audit log.");
    box.append(help, labelled("TITLE", title), labelled("INTRO", intro), el("h3", "forum-section", "ITEMS"), list, buttons, msg,
      el("h3", "forum-section", "PREVIEW"), preview);
    redraw(true);
    needs(view, preview);
  }

  // ---- the patch notes -------------------------------------------------------------------------

  function noteHead(view, x) {
    const head = el("div", "pn-head");
    head.append(el("span", "pn-version", x.version));
    head.append(el("span", "pn-tag is-" + x.kind, ((view.kinds && view.kinds[x.kind]) || x.kind).toUpperCase()));
    if (x.title) head.append(el("span", "pn-headline", x.title));
    if (x.date) {
      const d = new Date(x.date + "T00:00:00Z");
      const when = el("time", "pn-date", isFinite(d)
        ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
        : x.date);
      when.setAttribute("datetime", x.date);
      head.append(when);
    }
    return head;
  }

  function patchNotes(view, parent) {
    parent.textContent = "";
    if (!view || !view.page) return;
    const page = view.page;
    const intro = el("div", "pn-intro forum-body");
    blocks(view.content && view.content.intro, intro);
    if (intro.childNodes.length) parent.append(intro);
    const entries = Array.isArray(page.entries) ? page.entries : [];
    const trees = (view.content && view.content.entries) || [];
    if (!entries.length) {
      parent.append(el("p", "pn-empty", "No patch notes yet."));
      return;
    }
    const list = el("div", "pn-list");
    entries.forEach((x, i) => {
      const body = el("div", "pn-body forum-body");
      blocks(trees[i], body);
      // the newest release is open; the ones behind it fold away, so the page stays short
      let card;
      if (i === 0) {
        card = el("article", "pn-entry is-latest");
        card.append(noteHead(view, x), body);
      } else {
        card = el("details", "pn-entry");
        const sum = el("summary", "pn-summary");
        sum.append(noteHead(view, x));
        card.append(sum, body);
      }
      list.append(card);
    });
    parent.append(list);
    if (view.updated) {
      const d = new Date(view.updated);
      parent.append(el("p", "pn-updated", "Updated " + (isFinite(d) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "") + "."));
    }
  }

  function patchNotesEditor(box, view, call, onSaved) {
    box.textContent = "";
    const msg = el("p", "forum-row-meta");
    msg.setAttribute("role", "status");
    const title = control("input", "forum-input", { type: "text", maxlength: "120", "aria-label": "Page title" });
    title.value = view.page.title || "";
    const intro = control("textarea", "forum-textarea", { rows: "3", maxlength: "4000", "aria-label": "Intro" });
    intro.value = view.page.intro || "";
    const list = el("div", "needs-edit-list");
    const preview = el("div", "pn-page");
    const rows = [];
    let timer = null;
    let seq = 0;
    const gather = () => ({
      title: title.value, intro: intro.value,
      entries: rows.map((r) => ({ version: r.v.value, date: r.d.value, kind: r.k.value, title: r.t.value, body: r.body.value })),
    });
    function later() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        const r = await call("POST", "forum/patchnotes/preview", gather());
        if (mine !== seq) return;
        const error = r.status !== 200 ? (r.data && r.data.message) || "The preview could not be made (" + r.status + ")." : r.data.error;
        msg.className = error ? "forum-error" : "forum-row-meta";
        msg.textContent = error || "";
        if (!error) patchNotes(r.data, preview);
      }, 600);
    }
    function redraw(quiet) {
      list.textContent = "";
      for (const r of rows) list.append(r.node);
      if (!rows.length) list.append(el("p", "forum-empty", "No releases yet: ADD RELEASE."));
      if (!quiet) later();
    }
    function addRow(x, top) {
      const r = {
        k: choices(view.kinds, x.kind),
        v: control("input", "forum-input pn-edit-version", { type: "text", maxlength: "32", placeholder: "1.68", "aria-label": "Version" }),
        d: control("input", "forum-input pn-edit-date", { type: "date", "aria-label": "Date" }),
        t: control("input", "forum-input", { type: "text", maxlength: "120", placeholder: "Headline, if it wants one", "aria-label": "Headline" }),
        body: control("textarea", "forum-textarea", { rows: "4", maxlength: "8000", "aria-label": "What changed" }),
      };
      r.k.setAttribute("aria-label", "Kind");
      r.v.value = x.version || "";
      r.d.value = x.date || "";
      r.t.value = x.title || "";
      r.body.value = x.body || "";
      const move = (by) => {
        const i = rows.indexOf(r);
        const j = i + by;
        if (j < 0 || j >= rows.length) return;
        rows.splice(i, 1);
        rows.splice(j, 0, r);
        redraw();
      };
      const line = el("div", "panel-actions");
      line.append(r.v, r.d, r.k, r.t, act("UP", () => move(-1)), act("DOWN", () => move(1)),
        act("REMOVE", () => {
          rows.splice(rows.indexOf(r), 1);
          redraw();
        }, "danger"));
      r.node = el("div", "panel-item");
      r.node.append(line, r.body);
      for (const f of [r.v, r.d, r.t, r.body]) f.addEventListener("input", later);
      for (const f of [r.k, r.d]) f.addEventListener("change", later);
      if (top) rows.unshift(r);
      else rows.push(r);
    }
    for (const x of view.page.entries || []) addRow(x);
    title.addEventListener("input", later);
    intro.addEventListener("input", later);
    const buttons = el("div", "panel-actions");
    buttons.append(
      // a new release goes on top: the list reads newest first, and that is the one being written
      act("ADD RELEASE", () => {
        addRow({ kind: "release", version: "", date: "", title: "", body: "" }, true);
        redraw();
      }),
      act("SAVE", async () => {
        const r = await call("PUT", "forum/patchnotes", gather());
        const ok = r.status === 200;
        msg.className = ok ? "forum-done" : "forum-error";
        msg.textContent = ok ? "Saved: the downloads page shows it now." : (r.data && r.data.message) || "Not saved (" + r.status + ").";
        if (ok) {
          patchNotes(r.data, preview);
          if (onSaved) onSaved(r.data);
        }
      }, "primary"));
    const help = el("p", "forum-row-meta", "One entry a release, newest at the top. A version starts with a digit (1.68) and the date is the day it went out. The intro and the bodies take the forum's formatting: bold, italic, lists, links, and pictures linked from the forum's picture hosts. SAVE stores the whole page and goes into the audit log.");
    box.append(help, labelled("TITLE", title), labelled("INTRO", intro), el("h3", "forum-section", "RELEASES"), list, buttons, msg,
      el("h3", "forum-section", "PREVIEW"), preview);
    redraw(true);
    patchNotes(view, preview);
  }

  window.H9ForumRender = { blocks, needs, needsEditor, patchNotes, patchNotesEditor };
})();
