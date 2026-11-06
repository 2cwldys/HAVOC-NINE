// HAVOC9 forum: the pages under forum/ (the forum, a category, a thread, a member, search).
// One script for all of them; <body data-forum-page="index|category|thread|user|search"> says which.
// Everything comes from h9web's forum API (/api/forum/..., h9web/README.txt section 15) as JSON.
// What members wrote arrives as a tree of plain data (the forum's renderer) and is built here with
// createElement and textContent only: nothing in this file uses innerHTML. A link is made only for
// an http: or https: address, and gets rel="nofollow ugc noopener noreferrer".
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = (p) => new URL("api/forum/" + p, root).href;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const PAGE = document.body.getAttribute("data-forum-page");
  const DOT = " " + String.fromCharCode(183) + " ";
  const LINK_REL = "nofollow ugc noopener noreferrer";
  const OFFLINE = "The forum is not answering. Try again in a minute.";
  const DEFAULT_PICTURE = new URL("assets/avatar-default.png", root).href;
  const ROLE = { moderator: "MODERATOR", admin: "ADMIN" };
  const ID = /^[1-9][0-9]{0,14}$/;
  const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

  // ---- elements --------------------------------------------------------------------------------

  // el("a", { href, class, text, on: { click } }, ...children); strings become text nodes
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k === "on") for (const [name, fn] of Object.entries(v)) e.addEventListener(name, fn);
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
    return e;
  }

  const code = (text) => el("code", { text });
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "S");

  function when(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function month(iso) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "";
  }

  // ---- the API ---------------------------------------------------------------------------------

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await fetch(api(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      return { status: 0, data: { message: OFFLINE } };
    }
    let data = {};
    try {
      data = (await r.json()) || {};
    } catch (e) {
      // not JSON: a proxy's own error page
    }
    return { status: r.status, data };
  }

  function problem(res) {
    if (res.status === 413) return "That is too long to send. Shorten it and try again.";
    if (res.data && typeof res.data.message === "string") return res.data.message;
    if (res.status === 0) return OFFLINE;
    return "Something went wrong (" + res.status + "). Try again.";
  }

  // ---- addresses -------------------------------------------------------------------------------

  const href = {
    home: () => new URL("forum/", root).href,
    category(slug, page) {
      const u = new URL("forum/category/", root);
      u.searchParams.set("c", slug);
      if (page > 1) u.searchParams.set("page", page);
      return u.href;
    },
    thread(id, { page, post } = {}) {
      const u = new URL("forum/thread/", root);
      u.searchParams.set("t", id);
      if (page > 1) u.searchParams.set("page", page);
      if (post) {
        u.searchParams.set("post", post);
        u.hash = "p" + post;
      }
      return u.href;
    },
    user(name) {
      const u = new URL("forum/user/", root);
      u.searchParams.set("u", name);
      return u.href;
    },
    search(q, page) {
      const u = new URL("forum/search/", root);
      u.searchParams.set("q", q);
      if (page > 1) u.searchParams.set("page", page);
      return u.href;
    },
    admin(tab, name) {
      const u = new URL("admin/", root);
      if (tab) u.searchParams.set("tab", tab);
      if (name) u.searchParams.set("name", name);
      return u.href;
    },
    // SIGN IN brings the visitor back to this very page
    signIn(signup) {
      const u = new URL(signup ? "account/signup/" : "account/login/", root);
      u.searchParams.set("next", location.pathname.slice(root.pathname.length) + location.search);
      return u.href;
    },
  };

  // ---- what members wrote: the renderer's tree, as elements -----------------------------------

  function safeHref(value) {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // A picture in a post, shown from its host (the server's tree names only https addresses on its
  // list of picture hosts, and the page's CSP allows only those). It sends no Referer; a click
  // opens it in a new tab; one that does not load shows as its link. opts.onRemove, for
  // moderators, adds REMOVE PICTURE.
  function postPicture(n, opts) {
    const src = safeHref(n.src);
    if (!src || !src.startsWith("https://")) return "";
    const img = el("img", { class: "forum-img", src, alt: n.alt || "Picture", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    // a signature's pictures: no taller than the forum's signatureImageHeight
    if (opts && opts.maxHeight > 0) img.style.maxHeight = opts.maxHeight + "px";
    const link = el("a", { class: "forum-img-link", href: src, target: "_blank", rel: "noopener noreferrer nofollow ugc", title: src }, img);
    const box = el("span", { class: "forum-figure" }, link);
    img.addEventListener("error", () => link.replaceChildren(n.alt || src), { once: true });
    if (opts && opts.onRemove) box.append(el("button", { type: "button", class: "forum-act is-danger", text: "REMOVE PICTURE", on: { click: () => opts.onRemove(src) } }));
    return box;
  }

  function inline(nodes, parent, depth, opts) {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (typeof n === "string") {
        n.split("\n").forEach((part, i) => {
          if (i) parent.append(document.createElement("br"));
          if (part) parent.append(part);
        });
      } else if (n && typeof n === "object" && depth < 4) {
        if (n.t === "b" || n.t === "i") {
          const e = document.createElement(n.t === "b" ? "strong" : "em");
          inline(n.c, e, depth + 1, opts);
          parent.append(e);
        } else if (n.t === "img") {
          parent.append(postPicture(n, opts));
        } else if (n.t === "code") {
          parent.append(code(String(n.text || "")));
        } else if (n.t === "a") {
          const url = safeHref(n.href);
          const words = String(n.text || "");
          parent.append(url ? el("a", { href: url, rel: LINK_REL, target: "_blank", title: url, text: words || url }) : words);
        }
      }
    }
  }

  function blocks(list, parent, depth = 0, opts = null) {
    for (const b of Array.isArray(list) ? list : []) {
      if (!b || typeof b !== "object") continue;
      if (b.t === "p") {
        const p = document.createElement("p");
        inline(b.c, p, 0, opts);
        parent.append(p);
      } else if (b.t === "pre") {
        parent.append(el("pre", null, code(String(b.text || ""))));
      } else if (b.t === "quote" && depth < 6) {
        const q = document.createElement("blockquote");
        blocks(b.c, q, depth + 1, opts);
        parent.append(q);
      }
    }
  }

  // ---- shared parts ----------------------------------------------------------------------------

  // A member's picture: the default one, or theirs. A large one (a long GIF) waits for a hover, a
  // focus or a tap, so a page of posts does not fetch megabytes of pictures at once.
  function picture(by, large, inlineBytes) {
    const size = large ? 128 : 72;
    const img = el("img", { src: DEFAULT_PICTURE, alt: "", width: size, height: size, loading: "lazy", decoding: "async" });
    const box = el("span", { class: "forum-pic" + (large ? " is-large" : "") }, img);
    const p = by && by.picture;
    if (!p || !ID.test(String(p.id)) || !/^[0-9]{1,20}$/.test(String(p.v))) return box;
    const src = new URL("api/forum/avatars/" + p.id + "?v=" + p.v, root).href;
    if (large || !(p.bytes > inlineBytes)) {
      img.src = src;
      return box;
    }
    box.classList.add("is-standin");
    box.setAttribute("data-kind", p.frames > 1 ? "GIF" : "IMG");
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", "Show " + by.username + "'s picture");
    box.tabIndex = 0;
    const show = () => {
      if (!box.classList.contains("is-standin")) return;
      box.classList.remove("is-standin");
      box.removeAttribute("role");
      img.src = src;
    };
    for (const name of ["pointerenter", "focus", "click"]) box.addEventListener(name, show);
    return box;
  }

  // a tag, or "" when there is none: they go into append(), which would write a null as "null"
  const roleTag = (role) => (ROLE[role] ? el("span", { class: "forum-tag " + (role === "admin" ? "is-admin" : "is-hot"), text: ROLE[role] }) : "");
  // the DEVELOPER flag (an admin gives it; it goes with any role): a purple tag, and the name in purple
  const devTag = (who) => (who && who.developer ? el("span", { class: "forum-tag is-dev", text: "DEVELOPER" }) : "");
  const nameClass = (base, developer) => (base || "") + (developer ? (base ? " " : "") + "is-developer" : "") || null;
  const nameSpan = (name, developer) => (developer ? el("span", { class: "is-developer", text: name }) : name);
  // a member's career level badge beside their name, filled in by presence.js (data-h9-level; one
  // renderer for every place), with elo their H9 ladder rating beside it ("1.2K ELO", on a post's
  // author and the profile): nothing for an account that has none to show
  const levelMark = (name, large, elo) => (name ? el("span", { class: "forum-level", "data-h9-level": name, "data-h9-level-size": large ? "large" : null, "data-h9-level-elo": elo ? "1" : null }) : null);

  function status(content, error) {
    const s = $("forumStatus");
    s.textContent = "";
    if (content) s.append(content);
    s.hidden = !content;
    s.classList.toggle("is-error", !!error);
  }

  // false, with the reason on the page, unless the answer is a 200
  function ok(res) {
    if (res.status === 200) {
      status("");
      return true;
    }
    if (res.status === 401) {
      status(el("span", null, "The forum is for HAVOC 9 members. ", el("a", { href: href.signIn(), text: "SIGN IN" }), " or ",
        el("a", { href: href.signIn(true), text: "CREATE AN ACCOUNT" }), "."));
    } else {
      status(problem(res), true);
    }
    return false;
  }

  function bar(crumbs, viewer) {
    const ol = $("forumCrumbs");
    ol.textContent = "";
    for (const [label, url] of crumbs) ol.append(el("li", null, url ? el("a", { href: url, text: label }) : el("span", { text: label })));
    const who = $("forumWho");
    who.textContent = "";
    if (viewer && viewer.signedIn) {
      who.append(el("a", { href: href.user(viewer.username), text: viewer.username }));
      if (viewer.moderator) who.append(DOT, el("a", { href: href.admin(), text: "ADMIN PANEL" + (viewer.openReports ? " (" + viewer.openReports + " REPORTS)" : "") }));
    } else if (viewer) {
      who.append(el("a", { href: href.signIn(), text: "SIGN IN" }), " TO POST");
    }
  }

  function setTitle(text, label) {
    $("forumTitle").textContent = text;
    if (label) $("forumLabel").textContent = label;
    document.title = text + " -- FORUM -- HAVOC9";
  }

  function pager(page, pages, link) {
    if (!(pages > 1)) return null;
    const nav = el("nav", { class: "forum-pager", "aria-label": "Pages" });
    const add = (n, label, aria) => nav.append(n === page && !label
      ? el("span", { class: "is-current", "aria-current": "page", text: String(n) })
      : el("a", { href: link(n), text: label || String(n), "aria-label": aria || "Page " + n }));
    if (page > 1) add(page - 1, "<", "Previous page");
    let last = 0;
    for (const n of [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((x) => x >= 1 && x <= pages).sort((a, b) => a - b)) {
      if (n - last > 1) nav.append(el("span", { class: "is-gap", text: "..." }));
      add(n);
      last = n;
    }
    if (page < pages) add(page + 1, ">", "Next page");
    return nav;
  }

  function blockedNote(b) {
    return el("p", { class: "forum-note" }, el("strong", { text: "Posting is turned off for your account" }),
      b.until ? " until " + when(b.until) + "." : " until a moderator turns it back on.", " Reason: " + b.reason);
  }

  function signInNote(what) {
    return el("p", { class: "forum-note" }, el("a", { href: href.signIn(), text: "SIGN IN" }), " or ",
      el("a", { href: href.signIn(true), text: "CREATE AN ACCOUNT" }), " to " + what + ".");
  }

  // A form for writing: a title (for a new thread), the text, and its own errors. WRITE and
  // PREVIEW switch between the text and what it shows as once posted: preview(text) answers
  // { node, notes } (postPreview: the server's own post view, drawn by postNode) or { error }.
  // onSubmit({ title, body }) answers an error message, or nothing when it went through.
  // pics: { imagesPerPost, imageHosts } from the viewer: how many pictures a post shows and the
  // sites they are shown from, for the help. label names the text for screen readers.
  function composer({ title, titleValue = "", body = "", submit, cancel, onSubmit, max = 10000, pics = null, preview = null, label = "Your post" }) {
    const form = el("form", { class: "forum-compose", novalidate: true });
    let titleInput = null;
    if (title) {
      titleInput = el("input", { class: "forum-input", type: "text", maxlength: 120, "aria-label": "Title", placeholder: "Title" });
      titleInput.value = titleValue;
      form.append(el("label", { class: "forum-label", text: "TITLE" }), titleInput);
    }
    const area = el("textarea", { class: "forum-textarea", maxlength: max, rows: 8, "aria-label": label });
    area.value = body;
    const counter = el("span");
    const count = () => {
      counter.textContent = area.value.length + " / " + max;
    };
    area.addEventListener("input", count);
    count();
    const help = el("details", { class: "forum-help" }, el("summary", { text: "FORMATTING" }), el("ul", null,
      el("li", null, code("**bold**"), "   ", code("*italic*"), "   ", code("`code`")),
      el("li", null, "a line of ", code("```"), " before and after: a block of code"),
      el("li", null, code(">"), " at the start of a line: a quote"),
      el("li", null, code("https://..."), " or ", code("[words](https://...)"), ": a link"),
      el("li", null, code("![words](https://i.imgur.com/...)"), ", or a picture link alone on its line: a picture, shown from the site it is on",
        pics && Array.isArray(pics.imageHosts) ? " (imgur.com links, and " + pics.imageHosts.join(", ") + ")" : "",
        pics && pics.imagesPerPost !== undefined ? "; up to " + pics.imagesPerPost + " a post, the rest stay links" : "",
        ". Nothing is uploaded here, and that site sees readers' addresses as any website does"),
      el("li", null, "a blank line starts a new paragraph; no HTML")));
    const write = el("div", { class: "forum-compose-write" }, area, el("div", { class: "forum-compose-meta" }, help, counter));
    const pane = el("div", { class: "forum-preview", hidden: true, "aria-live": "polite" });
    const error = el("p", { class: "forum-error", role: "alert" });
    const send = el("button", { type: "submit", class: "btn btn-primary btn-sm", text: submit });
    const actions = el("div", { class: "forum-compose-actions" });
    if (cancel) actions.append(el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "CANCEL", on: { click: cancel } }));
    actions.append(send);
    // WRITE / PREVIEW: the latest preview asked for is the one shown
    let toWrite = () => {};
    let tabs = null;
    if (preview) {
      let asked = 0;
      const tab = (text) => el("button", { type: "button", class: "forum-tab", role: "tab", "aria-selected": "false", text });
      const writeTab = tab("WRITE");
      const previewTab = tab("PREVIEW");
      tabs = el("div", { class: "forum-tabs", role: "tablist", "aria-label": "Write or preview" }, writeTab, previewTab);
      const showing = async (previewing) => {
        writeTab.setAttribute("aria-selected", String(!previewing));
        previewTab.setAttribute("aria-selected", String(previewing));
        write.hidden = previewing;
        pane.hidden = !previewing;
        error.textContent = "";
        const mine = ++asked;
        if (!previewing) return;
        if (!area.value.trim()) {
          pane.replaceChildren(el("p", { class: "forum-removed", text: "Nothing to show yet." }));
          return;
        }
        pane.replaceChildren(el("p", { class: "forum-row-meta", text: "PREVIEW..." }));
        const got = await preview(area.value);
        if (mine !== asked) return;
        if (got.error) {
          pane.replaceChildren(el("p", { class: "forum-error", role: "alert", text: got.error }));
          return;
        }
        pane.replaceChildren(got.node, ...(got.notes || []).map((n) => el("p", { class: "forum-row-meta", text: String(n) })));
      };
      writeTab.addEventListener("click", () => {
        showing(false);
        area.focus();
      });
      previewTab.addEventListener("click", () => showing(true));
      writeTab.setAttribute("aria-selected", "true");
      toWrite = () => {
        if (write.hidden) showing(false);
      };
    }
    form.append(...(tabs ? [tabs] : []), write, pane, error, actions);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      if (titleInput && titleInput.value.trim().length < 3) {
        error.textContent = "Give the thread a title of at least 3 characters.";
        return;
      }
      if (!area.value.trim()) {
        error.textContent = "Write something first.";
        return;
      }
      send.disabled = true;
      try {
        const message = await onSubmit({ title: titleInput ? titleInput.value : undefined, body: area.value });
        if (message) error.textContent = message;
      } finally {
        send.disabled = false;
      }
    });
    return {
      form,
      focus: () => (titleInput || area).focus(),
      // a quote goes in at the end, on its own lines (back on WRITE)
      insert(text) {
        toWrite();
        const before = area.value && !area.value.endsWith("\n\n") ? (area.value.endsWith("\n") ? "\n" : "\n\n") : "";
        area.value += before + text;
        count();
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      },
    };
  }

  // A post's likes and dislikes: buttons for an account that may vote (pressing the chosen one
  // again takes the vote back), the counts alone for everyone else.
  function voteBar(p) {
    const bar = el("span", { class: "forum-votes" });
    const show = (v) => {
      bar.textContent = "";
      for (const [value, word, count] of [[1, "LIKE", v.likes], [-1, "DISLIKE", v.dislikes]]) {
        const label = word + " " + count;
        if (!p.can.vote) {
          bar.append(el("span", { class: "forum-vote-count", text: label }));
          continue;
        }
        const chosen = v.mine === value;
        bar.append(el("button", {
          type: "button", class: "forum-act" + (chosen ? " is-on" : ""), "aria-pressed": chosen ? "true" : "false", text: label,
          on: {
            click: async () => {
              const r = await call("PUT", "posts/" + p.id + "/vote", { value: chosen ? 0 : value });
              if (r.status !== 200) return alert(problem(r));
              show(r.data);
            },
          },
        }));
      }
    };
    show(p.votes);
    return bar;
  }

  // PIN / UNPIN and LOCK / UNLOCK on a row of a category's list, for moderators and admins
  function quickTools(t) {
    const tools = el("div", { class: "forum-row-tools", role: "group", "aria-label": "Moderate this thread" });
    const toggle = (label, body) => tools.append(el("button", {
      type: "button", class: "forum-act", text: label,
      on: {
        click: async () => {
          const r = await call("PATCH", "threads/" + t.id, body);
          if (r.status !== 200) return alert(problem(r));
          await categoryPage();
        },
      },
    }));
    toggle(t.pinned ? "UNPIN" : "PIN", { pinned: !t.pinned });
    toggle(t.locked ? "UNLOCK" : "LOCK", { locked: !t.locked });
    toggle(t.hidden ? "UNHIDE" : "HIDE", { hidden: !t.hidden });
    return tools;
  }

  function threadRow(t, { category } = {}) {
    const tags = [
      t.pinned ? el("span", { class: "forum-tag is-hot", text: "PINNED" }) : null,
      t.locked ? el("span", { class: "forum-tag", text: "LOCKED" }) : null,
      t.hidden ? el("span", { class: "forum-tag is-off", text: "HIDDEN" }) : null,
      t.removed ? el("span", { class: "forum-tag is-off", text: "REMOVED" }) : null,
    ];
    const meta = ["by ", t.by ? [nameSpan(t.by.username, t.by.developer), levelMark(t.by.username)] : "a deleted account", DOT + when(t.created)];
    if (category) meta.unshift(category.name + DOT);
    return el("div", { class: "forum-row" + (t.removed ? " is-removed" : "") },
      el("div", { class: "forum-row-main" }, el("a", { class: "forum-row-title", href: href.thread(t.id), text: t.title }), tags, el("p", { class: "forum-row-meta" }, meta)),
      el("div", { class: "forum-row-stats" }, plural(t.posts, "POST")),
      el("div", { class: "forum-row-last" },
        t.lastPost ? el("a", { href: href.thread(t.id, { post: t.lastPost }) }, "last by ", t.lastBy ? [nameSpan(t.lastBy, t.lastByDeveloper), levelMark(t.lastBy)] : "a deleted account") : null,
        when(t.lastAt)));
  }

  // ---- the forum: its categories ---------------------------------------------------------------

  async function indexPage() {
    const res = await call("GET", "categories");
    bar([["FORUM", null]], res.data && res.data.viewer);
    if (!ok(res)) return;
    const main = $("forumMain");
    main.textContent = "";
    const list = el("div", { class: "forum-list" });
    for (const c of res.data.categories) {
      list.append(el("div", { class: "forum-row" },
        el("div", null,
          el("a", { class: "forum-row-title forum-cat-title", href: href.category(c.slug), text: c.name }),
          c.visible ? null : el("span", { class: "forum-tag is-off", text: "HIDDEN" }),
          c.startRole !== "user" ? el("span", { class: "forum-tag", text: "STAFF THREADS" }) : null,
          c.description ? el("p", { class: "forum-row-desc", text: c.description }) : null),
        el("div", { class: "forum-row-stats" }, plural(c.threads, "THREAD"), el("br"), plural(c.posts, "POST")),
        el("div", { class: "forum-row-last" },
          c.last ? [el("a", { href: href.thread(c.last.thread, { post: c.last.post }), text: c.last.title }), "by ", c.last.by ? [nameSpan(c.last.by, c.last.byDeveloper), levelMark(c.last.by)] : "a deleted account", DOT + when(c.last.at)] : "No threads yet.")));
    }
    if (!res.data.categories.length) list.append(el("p", { class: "forum-empty", text: "No categories yet." }));
    main.append(list);
    if (res.data.viewer && res.data.viewer.postingBlocked) main.prepend(blockedNote(res.data.viewer.postingBlocked));
  }

  // ---- a category: its threads, and a new one ---------------------------------------------------

  async function categoryPage() {
    const slug = params.get("c") || "";
    if (!SLUG.test(slug)) {
      bar([["FORUM", href.home()]], null);
      return status("No such category.", true);
    }
    const page = Number(params.get("page")) || 1;
    const res = await call("GET", "categories/" + encodeURIComponent(slug) + (page > 1 ? "?page=" + page : ""));
    const d = res.data || {};
    bar([["FORUM", href.home()], [d.category ? d.category.name : "CATEGORY", null]], d.viewer);
    if (!ok(res)) return;
    const c = d.category;
    setTitle(c.name.toUpperCase(), "// FORUM");
    const main = $("forumMain");
    main.textContent = "";
    const head = el("div", { class: "forum-head" }, el("p", { text: c.description || "" }));
    main.append(head);
    if (!c.visible) main.append(el("p", { class: "forum-note", text: "This category is hidden: only moderators and admins see it." }));
    let compose = null;
    if (d.viewer.signedIn && d.viewer.postingBlocked) {
      main.append(blockedNote(d.viewer.postingBlocked));
    } else if (c.canStart) {
      compose = composer({
        title: true, submit: "START THREAD", pics: d.viewer, preview: postPreview({}),
        cancel: () => {
          compose.form.hidden = true;
        },
        async onSubmit({ title, body }) {
          const r = await call("POST", "categories/" + encodeURIComponent(c.slug) + "/threads", { title, body });
          if (r.status !== 201) return problem(r);
          keepNotes(r.data);
          location.href = href.thread(r.data.thread.id);
          return null;
        },
      });
      compose.form.hidden = true;
      head.append(el("button", {
        type: "button", class: "btn btn-primary btn-sm", text: "NEW THREAD",
        on: { click: () => { compose.form.hidden = false; compose.focus(); } },
      }));
    } else if (!d.viewer.signedIn) {
      main.append(signInNote("start a thread"));
    } else {
      main.append(el("p", { class: "forum-note", text: "Only moderators and admins start threads here. Everyone signed in can reply." }));
    }
    if (compose) main.append(compose.form);
    const list = el("div", { class: "forum-list" });
    for (const t of d.threads) {
      const row = threadRow(t);
      if (d.viewer.moderator) row.querySelector(".forum-row-main").append(quickTools(t));
      list.append(row);
    }
    if (!d.threads.length) list.append(el("p", { class: "forum-empty", text: "No threads here yet." }));
    main.append(pager(d.page, d.pages, (n) => href.category(c.slug, n)) || "", list, pager(d.page, d.pages, (n) => href.category(c.slug, n)) || "");
  }

  // ---- a thread: its posts, replies, and the moderators' tools -----------------------------------

  async function threadPage() {
    const id = params.get("t") || "";
    if (!ID.test(id)) {
      bar([["FORUM", href.home()]], null);
      return status("No such thread.", true);
    }
    const q = new URLSearchParams();
    for (const k of ["page", "post"]) if (params.get(k)) q.set(k, params.get(k));
    const res = await call("GET", "threads/" + id + (q.toString() ? "?" + q : ""));
    const d = res.data || {};
    bar([["FORUM", href.home()], ...(d.category ? [[d.category.name, href.category(d.category.slug)]] : [])], d.viewer);
    if (!ok(res)) return;
    renderThread(d);
    showNotes();
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView();
  }

  // load the thread again, at the page holding a post when one is given
  // What a save said about the post's pictures, shown at the top of the thread once it is shown
  // again (a new thread: on its own page).
  function keepNotes(result) {
    const notes = result && Array.isArray(result.notes) ? result.notes : [];
    if (!notes.length) return;
    try {
      sessionStorage.setItem("h9-forum-notes", JSON.stringify(notes));
    } catch (e) {
      // no session storage: no note
    }
  }
  function showNotes() {
    let notes = null;
    try {
      notes = JSON.parse(sessionStorage.getItem("h9-forum-notes") || "null");
      sessionStorage.removeItem("h9-forum-notes");
    } catch (e) {
      // as above
    }
    if (Array.isArray(notes) && notes.length) status(el("span", null, notes.map((x) => String(x)).join(" ")));
  }

  async function reloadThread(post) {
    const u = new URL(location.href);
    for (const k of ["page", "post"]) u.searchParams.delete(k);
    if (post) {
      u.searchParams.set("post", post);
      u.hash = "p" + post;
    }
    history.replaceState(null, "", u.href);
    for (const k of ["page", "post"]) params.delete(k);
    for (const [k, v] of u.searchParams) params.set(k, v);
    await threadPage();
  }

  function renderThread(d) {
    const t = d.thread;
    setTitle(t.title, "// " + d.category.name.toUpperCase());
    const main = $("forumMain");
    main.textContent = "";
    const crumbs = $("forumCrumbs");
    crumbs.append(el("li", null, el("span", { text: t.title })));
    main.append(el("p", { class: "forum-row-meta" },
      "Started by ", t.by ? [el("a", { class: nameClass("", t.by.developer), href: href.user(t.by.username), "data-h9-card": t.by.username, text: t.by.username }), levelMark(t.by.username)] : "a deleted account", DOT + when(t.created),
      t.pinned ? el("span", { class: "forum-tag is-hot", text: "PINNED" }) : null,
      t.locked ? el("span", { class: "forum-tag", text: "LOCKED" }) : null,
      t.hidden ? el("span", { class: "forum-tag is-off", text: "HIDDEN" }) : null));
    if (t.hidden) main.append(el("p", { class: "forum-note", text: "This thread is hidden: only moderators and admins see it. UNHIDE brings it back for everyone." }));
    if (t.removed) main.append(el("p", { class: "forum-note", text: t.removed === "empty" ? "Every post in this thread was removed, so the thread is hidden. Restore a post to bring it back." : "This thread was removed by a moderator. Only moderators and admins see it." }));
    if (t.can.moderate) main.append(modBar(d));
    else if (t.can.rename) main.append(renameBar(t));
    let reply = null;
    if (t.can.reply) {
      reply = composer({
        submit: "POST REPLY", pics: d.viewer, preview: postPreview({ thread: t.id }),
        async onSubmit({ body }) {
          const r = await call("POST", "threads/" + t.id + "/posts", { body });
          if (r.status !== 201) return problem(r);
          keepNotes(r.data);
          await reloadThread(r.data.post.id);
          return null;
        },
      });
    }
    const link = (n) => href.thread(t.id, { page: n });
    main.append(pager(d.page, d.pages, link) || "");
    for (const p of d.posts) main.append(postNode(p, d, reply));
    main.append(pager(d.page, d.pages, link) || "");
    // one request for every author on the page; presence.js would otherwise read them post by post
    if (window.H9Presence) window.H9Presence.decorate(main);
    if (reply) {
      main.append(el("h2", { class: "sub-title forum-section", text: "REPLY" }));
      if (t.locked) main.append(el("p", { class: "forum-note", text: "This thread is locked. As staff you can still reply." }));
      main.append(reply.form);
    } else {
      const why = {
        signin: () => signInNote("reply"),
        locked: () => el("p", { class: "forum-note", text: "This thread is locked: no new replies. Moderators and admins can still reply." }),
        role: () => el("p", { class: "forum-note", text: "Only moderators and admins reply in this category." }),
        removed: () => null,
        posting_disabled: () => blockedNote(d.viewer.postingBlocked),
      }[t.replyBlock];
      const note = why ? why() : null;
      if (note) main.append(note);
    }
  }

  // The block beside what a member wrote, a post or a wall comment alike: their picture, name,
  // level badge, role and DEVELOPER tags, when they joined, their posts and likes, and presence.js's
  // line; for a deleted account, the default picture and "deleted account".
  function authorBlock(by, inlineBytes) {
    const aside = el("aside", { class: "forum-author" });
    if (!by) {
      aside.append(picture(null), el("span", { class: "forum-author-name", text: "deleted account" }));
      return aside;
    }
    aside.append(picture(by, false, inlineBytes),
      el("a", { class: nameClass("forum-author-name", by.developer), href: href.user(by.username), "data-h9-card": by.username, text: by.username }),
      levelMark(by.username, false, true), roleTag(by.role), devTag(by), el("span", { text: "JOINED " + month(by.joined).toUpperCase() }), el("span", { text: plural(by.posts, "POST") }),
      el("span", { text: plural(by.likes || 0, "LIKE") }),
      // in game, in the web client, on the site or last seen, the badge and playtime (presence.js)
      el("span", { class: "forum-presence", "data-h9-presence": "author", "data-h9-user": by.username }));
    return aside;
  }

  function postNode(p, d, reply) {
    const t = d.thread;
    const art = el("article", { class: "forum-post" + (p.removed ? " is-removed" : ""), id: "p" + p.id });
    const aside = authorBlock(p.by, d.pictureInlineBytes);
    if (p.by) {
      if (p.can.clearSignature) {
        aside.append(el("button", {
          type: "button", class: "forum-act is-danger", text: "CLEAR SIGNATURE",
          on: {
            click: async () => {
              const reason = prompt("Why is " + p.by.username + "'s signature cleared? (kept in the audit log)", "");
              if (reason === null) return;
              const r = await call("POST", "signatures/" + encodeURIComponent(p.by.username) + "/clear", { reason });
              if (r.status !== 200) return alert(problem(r));
              await reloadThread(p.id);
            },
          },
        }));
      }
    }
    const main = el("div", { class: "forum-post-main" });
    const stamp = [el("time", { datetime: p.created, text: when(p.created) })];
    if (p.edited) stamp.push(el("span", { title: when(p.edited.at), text: DOT + (p.edited.byModerator ? "EDITED BY A MODERATOR" : "EDITED") }));
    main.append(el("header", { class: "forum-post-head" }, el("a", { href: href.thread(t.id, { post: p.id }), text: "#" + p.number }), el("span", null, stamp)));
    const body = el("div", { class: "forum-body" });
    if (p.removed) {
      body.append(el("p", { class: "forum-removed", text: (p.removed === "moderator" ? "Removed by a moderator." : "This user has deleted their post.") + (p.content ? " Only moderators and admins see what it said:" : "") }));
    }
    const removePicture = async (src) => {
      const reason = prompt("Why is the picture taken out? (kept in the audit log)", "");
      if (reason === null) return;
      const r = await call("POST", "posts/" + p.id + "/pictures/remove", { src, reason });
      if (r.status !== 200) return alert(problem(r));
      await reloadThread(p.id);
    };
    if (p.content) blocks(p.content, body, 0, { onRemove: d.viewer.moderator && !p.removed ? removePicture : null });
    main.append(body);
    // the author's signature, under a thin rule (the server leaves it out of removed posts, and
    // out of everything for a reader whose SHOW SIGNATURES is off)
    if (Array.isArray(p.signature) && p.signature.length) main.append(signatureNode(p.signature, d.signatureImageHeight));
    const actions = el("div", { class: "forum-post-actions" });
    const act = (label, fn, danger) => actions.append(el("button", { type: "button", class: "forum-act" + (danger ? " is-danger" : ""), text: label, on: { click: fn } }));
    if (reply && !p.removed && typeof p.body === "string") {
      act("QUOTE", () => {
        const name = p.by ? p.by.username : "a deleted account";
        const quoted = p.body.split("\n").map((line) => (line ? "> " + line : ">")).join("\n");
        reply.insert("> **" + name + "** wrote:\n" + quoted + "\n\n");
      });
    }
    if (p.can.edit) act("EDIT", () => editPost(p, body, actions, d.viewer));
    // on the thread's first post, for staff: hide or unhide the whole thread from here too
    if (t.can.moderate && !t.removed && p.number === 1) {
      act(t.hidden ? "UNHIDE THREAD" : "HIDE THREAD", async () => {
        const r = await call("PATCH", "threads/" + t.id, { hidden: !t.hidden });
        if (r.status !== 200) return alert(problem(r));
        await reloadThread(p.id);
      });
    }
    if (p.can.remove) {
      act(p.own ? "DELETE" : "REMOVE", async () => {
        if (!confirm(p.own ? "Delete your post? It stays in the thread, emptied, and says: This user has deleted their post." : "Remove this post? Readers see that a moderator removed it.")) return;
        const r = await call("DELETE", "posts/" + p.id);
        if (r.status !== 200) return alert(problem(r));
        if (r.data.threadRemoved && !d.viewer.moderator) {
          location.href = href.category(d.category.slug);
          return;
        }
        await reloadThread(p.id);
      }, true);
    }
    if (p.can.restore) {
      act("RESTORE", async () => {
        const r = await call("POST", "posts/" + p.id + "/restore", {});
        if (r.status !== 200) return alert(problem(r));
        await reloadThread(p.id);
      });
    }
    if (p.can.report) act("REPORT", () => reportForm(p, main, actions));
    if (d.viewer.moderator && p.by && p.by.role === "user") {
      actions.append(el("a", { class: "forum-act", href: href.admin("accounts", p.by.username), text: "ACCOUNT TOOLS" }));
    }
    if (p.votes) actions.prepend(voteBar(p));
    main.append(actions);
    art.append(aside, main);
    return art;
  }

  // A signature as it shows under each post and on the member page; the ACCOUNT page's preview
  // draws it with this too (window.H9Forum).
  function signatureNode(tree, maxHeight) {
    const sig = el("div", { class: "forum-signature" });
    blocks(tree, sig, 0, { maxHeight });
    return sig;
  }

  // PREVIEW in a composer: the server's preview (POST /api/forum/preview with the text and the
  // thread it replies to or the post it edits) is the post view a thread page gets, so postNode
  // draws it as the posted post: the same author block, body and signature, without actions.
  const postPreview = (context) => async (text) => {
    const res = await call("POST", "preview", { body: text, ...context });
    if (res.status !== 200) return { error: problem(res) };
    return { node: previewNode(res.data), notes: res.data.notes || [] };
  };

  // A post drawn from a preview: marked as one, and every link on it opens a new tab, so the
  // text being written stays.
  function previewNode(data) {
    const d = { thread: { id: data.thread || 0, can: {} }, viewer: {}, pictureInlineBytes: data.pictureInlineBytes, signatureImageHeight: data.signatureImageHeight };
    const art = postNode(data.post, d, null);
    // a post not written yet has no address of its own: its number stays as it shows, unlinked
    const number = art.querySelector(".forum-post-head a");
    if (number && !data.post.id) number.removeAttribute("href");
    return asPreview(art);
  }

  function asPreview(art) {
    art.removeAttribute("id");
    art.classList.add("is-preview");
    for (const a of art.querySelectorAll("a[href]")) {
      if (a.target === "_blank") continue;
      a.target = "_blank";
      a.rel = "noopener";
    }
    return art;
  }

  // ---- a member's wall ---------------------------------------------------------------------------

  // The member page's WALL (GET users/:name/wall, page ?wall=N): comments drawn as posts are, the
  // owner's pins first, then the newest. Whoever may write gets the composer with WRITE / PREVIEW;
  // the owner the switch (everyone may write, or nobody), PIN and DELETE; an author EDIT and
  // DELETE; staff REMOVE (with a note for the audit log) and TURN OFF POSTING (the forum's own
  // sanction), on accounts below their own role.
  async function showWall(u, viewer, box) {
    const page = Number(params.get("wall")) || 1;
    const name = encodeURIComponent(u.username);
    const res = await call("GET", "users/" + name + "/wall" + (page > 1 ? "?page=" + page : ""));
    box.textContent = "";
    box.append(el("h2", { class: "sub-title forum-section", text: "WALL" + (res.data && res.data.wall && res.data.wall.total ? " (" + res.data.wall.total + ")" : "") }));
    if (res.status !== 200) {
      box.append(el("p", { class: "forum-error", text: problem(res) }));
      return;
    }
    const w = res.data;
    const again = () => showWall(u, viewer, box);
    box.append(el("p", { class: "forum-row-meta forum-wall-state", text: w.wall.open ? "Everyone signed in may write on this wall." : u.username + " has turned this wall off: nobody writes on it for now." }));
    if (w.can.manage) {
      box.append(el("div", { class: "forum-wall-owner" },
        el("button", {
          type: "button", class: "forum-act", text: w.wall.open ? "TURN THE WALL OFF" : "OPEN THE WALL TO EVERYONE",
          on: {
            click: async () => {
              const r = await call("PUT", "users/" + name + "/wall", { open: !w.wall.open });
              if (r.status !== 200) return alert(problem(r));
              await again();
            },
          },
        }),
        el("span", { class: "forum-row-meta", text: "PINNED " + w.wall.pins + " OF " + w.wall.maxPins })));
    }
    if (w.can.comment) {
      const compose = composer({
        submit: "WRITE ON THE WALL", label: "Your comment", pics: viewer, preview: wallPreview({ wall: u.username }),
        async onSubmit({ body }) {
          const r = await call("POST", "users/" + name + "/wall", { body });
          if (r.status !== 201) return problem(r);
          await again();
          return null;
        },
      });
      box.append(compose.form);
    } else if (w.can.why === "signin") {
      box.append(signInNote("write on " + u.username + "'s wall"));
    } else if (w.can.why === "posting_disabled" && w.postingBlocked) {
      box.append(blockedNote(w.postingBlocked));
    }
    const link = (n) => {
      const x = new URL(location.href);
      x.searchParams.set("wall", n);
      x.hash = "wall";
      return x.href;
    };
    const list = el("div", { class: "forum-wall-list" });
    for (const c of w.comments) list.append(wallComment(c, w.pictureInlineBytes, again));
    if (!w.comments.length) list.append(el("p", { class: "forum-empty", text: "Nothing on this wall yet." }));
    box.append(pager(w.page, w.pages, link) || "", list, pager(w.page, w.pages, link) || "");
  }

  // One comment on a wall: the author block a post has, then its time (and EDITED), its text, and
  // what the reader may do. again() draws the wall again after a change; a preview has none.
  function wallComment(c, inlineBytes, again) {
    const art = el("article", { class: "forum-post forum-wall-comment" + (c.removed ? " is-removed" : "") + (c.pinned ? " is-pinned" : ""), id: c.id ? "w" + c.id : null });
    const main = el("div", { class: "forum-post-main" });
    const stamp = [el("time", { datetime: c.created, text: when(c.created) })];
    if (c.edited) stamp.push(el("span", { title: when(c.edited.at), text: DOT + "EDITED" }));
    main.append(el("header", { class: "forum-post-head" }, c.pinned ? el("span", { class: "forum-tag is-hot", text: "PINNED" }) : el("span"), el("span", null, stamp)));
    const body = el("div", { class: "forum-body" });
    if (c.removed) {
      body.append(el("p", { class: "forum-removed", text: "Removed by a moderator." + (c.content ? " Only moderators and admins see what it said" + (c.removedNote ? " (" + c.removedNote + ")" : "") + ":" : "") }));
    }
    if (c.content) blocks(c.content, body);
    main.append(body);
    const actions = el("div", { class: "forum-post-actions" });
    const act = (label, fn, danger) => actions.append(el("button", { type: "button", class: "forum-act" + (danger ? " is-danger" : ""), text: label, on: { click: fn } }));
    const done = (r) => (r.status === 200 ? again() : alert(problem(r)));
    if (c.can.edit) act("EDIT", () => editWallComment(c, body, actions, again));
    if (c.can.pin) act(c.pinned ? "UNPIN" : "PIN", async () => done(await call("PUT", "wall/" + c.id + "/pin", { pinned: !c.pinned })));
    if (c.can.delete) {
      act("DELETE", async () => {
        if (!confirm(c.own ? "Delete your comment? It goes for good." : "Delete this comment from your wall? It goes for good.")) return;
        done(await call("DELETE", "wall/" + c.id));
      }, true);
    }
    if (c.can.remove) {
      act("REMOVE", async () => {
        const note = prompt("Why is the comment removed? (kept in the audit log; it stays as Removed by a moderator)", "");
        if (note === null) return;
        done(await call("POST", "wall/" + c.id + "/remove", { note }));
      }, true);
    }
    if (c.can.postingOff && c.by) {
      act("TURN OFF POSTING", async () => {
        const reason = prompt("Why is " + c.by.username + "'s posting turned off? It stops their posts and wall comments; they see the reason.", "");
        if (reason === null) return;
        const days = prompt("For how many days? (empty: until a moderator turns it back on)", "");
        if (days === null) return;
        const input = { reason };
        if (days.trim()) input.days = Number(days);
        const r = await call("POST", "restrictions/" + encodeURIComponent(c.by.username), input);
        if (r.status !== 200) return alert(problem(r));
        alert("Posting is off for " + c.by.username + ".");
      }, true);
    }
    if (actions.childNodes.length) main.append(actions);
    art.append(authorBlock(c.by, inlineBytes), main);
    return art;
  }

  function editWallComment(c, body, actions, again) {
    const box = composer({
      body: c.body, submit: "SAVE", label: "Your comment", preview: wallPreview({ comment: c.id }),
      cancel: () => {
        box.form.remove();
        body.hidden = false;
        actions.hidden = false;
      },
      async onSubmit({ body: text }) {
        const r = await call("PATCH", "wall/" + c.id, { body: text });
        if (r.status !== 200) return problem(r);
        await again();
        return null;
      },
    });
    body.hidden = true;
    actions.hidden = true;
    body.after(box.form);
    box.focus();
  }

  // PREVIEW in a wall's composer: the server's preview (POST wall/preview) is the comment view the
  // wall gets, drawn by wallComment itself, without actions.
  const wallPreview = (context) => async (text) => {
    const res = await call("POST", "wall/preview", { body: text, ...context });
    if (res.status !== 200) return { error: problem(res) };
    return { node: asPreview(wallComment(res.data.comment, res.data.pictureInlineBytes, null)) };
  };

  function editPost(p, body, actions, pics) {
    const box = composer({
      body: p.body, submit: "SAVE", pics, preview: postPreview({ post: p.id }),
      cancel: () => {
        box.form.remove();
        body.hidden = false;
        actions.hidden = false;
      },
      async onSubmit({ body: text }) {
        const r = await call("PATCH", "posts/" + p.id, { body: text });
        if (r.status !== 200) return problem(r);
        keepNotes(r.data);
        await reloadThread(p.id);
        return null;
      },
    });
    body.hidden = true;
    actions.hidden = true;
    body.after(box.form);
    box.focus();
  }

  function reportForm(p, main, actions) {
    if (main.querySelector(".forum-report")) return;
    const reason = el("input", { class: "forum-input", type: "text", maxlength: 500, "aria-label": "What is wrong with this post?", placeholder: "What is wrong with this post?" });
    const error = el("p", { class: "forum-error", role: "alert" });
    const form = el("form", { class: "forum-compose forum-report", novalidate: true },
      el("label", { class: "forum-label", text: "REPORT TO THE MODERATORS" }), reason, error,
      el("div", { class: "forum-compose-actions" },
        el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "CANCEL", on: { click: () => form.remove() } }),
        el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "SEND REPORT" })));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await call("POST", "posts/" + p.id + "/report", { reason: reason.value });
      if (r.status !== 200 && r.status !== 201) {
        error.textContent = problem(r);
        return;
      }
      form.replaceWith(el("p", { class: "forum-done", role: "status", text: "Thank you. The moderators will look at it." }));
    });
    actions.before(form);
    reason.focus();
  }

  function renameBar(t) {
    const input = el("input", { class: "forum-input", type: "text", maxlength: 120, "aria-label": "New title" });
    input.value = t.title;
    const error = el("span", { class: "forum-error", role: "alert" });
    const form = el("form", { class: "forum-modbar" }, "YOUR TITLE", input,
      el("button", { type: "submit", class: "forum-act", text: "RENAME" }), error);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await call("PATCH", "threads/" + t.id, { title: input.value });
      if (r.status !== 200) {
        error.textContent = problem(r);
        return;
      }
      await reloadThread();
    });
    return form;
  }

  function modBar(d) {
    const t = d.thread;
    const error = el("span", { class: "forum-error", role: "alert" });
    const run = async (method, path, body, after) => {
      error.textContent = "";
      const r = await call(method, path, body);
      if (r.status !== 200) {
        error.textContent = problem(r);
        return;
      }
      if (after) after(r);
      else await reloadThread();
    };
    const bar = el("div", { class: "forum-modbar", role: "group", "aria-label": "Moderator tools" }, "MODERATE");
    const button = (label, fn, danger) => bar.append(el("button", { type: "button", class: "forum-act" + (danger ? " is-danger" : ""), text: label, on: { click: fn } }));
    if (!t.removed) {
      button(t.pinned ? "UNPIN" : "PIN", () => run("PATCH", "threads/" + t.id, { pinned: !t.pinned }));
      button(t.locked ? "UNLOCK (REPLIES ON)" : "LOCK (REPLIES OFF)", () => run("PATCH", "threads/" + t.id, { locked: !t.locked }));
      button(t.hidden ? "UNHIDE" : "HIDE (STAFF ONLY)", () => run("PATCH", "threads/" + t.id, { hidden: !t.hidden }));
      button("RENAME", () => {
        const title = prompt("New title for the thread:", t.title);
        if (title !== null && title.trim() !== t.title) run("PATCH", "threads/" + t.id, { title });
      });
      const select = el("select", { class: "forum-select", "aria-label": "Move to" });
      for (const c of d.categories || []) {
        const o = el("option", { value: c.slug, text: c.name });
        if (c.slug === d.category.slug) o.selected = true;
        select.append(o);
      }
      bar.append(select);
      button("MOVE", () => {
        if (select.value !== d.category.slug) run("PATCH", "threads/" + t.id, { category: select.value });
      });
      button("REMOVE THREAD", () => {
        if (confirm("Remove this whole thread? Moderators can restore it from the admin panel.")) run("DELETE", "threads/" + t.id, undefined);
      }, true);
    } else if (t.removed === "moderator") {
      button("RESTORE THREAD", () => run("POST", "threads/" + t.id + "/restore", {}));
    }
    bar.append(error);
    return bar;
  }

  // ---- a member ----------------------------------------------------------------------------------

  async function userPage() {
    const name = params.get("u") || "";
    const res = name ? await call("GET", "users/" + encodeURIComponent(name)) : { status: 404, data: { message: "No such member." } };
    const d = res.data || {};
    bar([["FORUM", href.home()], ["MEMBERS", null]], d.viewer);
    if (!ok(res)) return;
    const u = d.user;
    setTitle(u.username, "// MEMBER");
    $("forumTitle").classList.toggle("is-developer", !!u.developer);
    const main = $("forumMain");
    main.textContent = "";
    const rows = [["ROLE", ({ user: "Player", moderator: "Moderator", admin: "Admin" }[u.role] || u.role) + (u.developer ? ", Developer" : "")], ["JOINED", month(u.joined)], ["POSTS", String(u.posts)], ["LIKES", String(u.likes || 0)], ["THREADS", String(u.threads)]];
    main.append(el("div", { class: "forum-profile" }, picture(u, true, d.pictureInlineBytes), levelMark(u.username, true, true),
      el("div", { class: "feature-list" }, rows.map(([k, v]) => el("div", { class: "feature-row" }, el("span", { class: "feature-label", text: k }), el("span", { class: "feature-value", text: v }))))));
    // the player's card: in game or not, the badge, playtime (presence.js)
    main.append(el("div", { class: "forum-presence-card", "data-h9-presence": "card", "data-h9-user": u.username }));
    // their RANK block: the level, this season on the H9 ladder (presence.js); nothing when hidden
    main.append(el("div", { class: "forum-presence-rank", "data-h9-presence": "rank", "data-h9-user": u.username }));
    if (Array.isArray(u.signature) && u.signature.length) {
      main.append(el("h2", { class: "sub-title forum-section", text: "SIGNATURE" }), signatureNode(u.signature, d.signatureImageHeight));
    }
    if (d.can.removePicture || d.can.suspend || d.can.blockSignature) {
      const error = el("span", { class: "forum-error", role: "alert" });
      const tools = el("div", { class: "forum-modbar" }, "MODERATE");
      if (d.can.removePicture) {
        tools.append(el("button", {
          type: "button", class: "forum-act is-danger", text: "REMOVE PICTURE",
          on: {
            click: async () => {
              const reason = prompt("Why is the picture removed? (kept in the audit log)", "");
              if (reason === null) return;
              const r = await call("POST", "avatars/" + encodeURIComponent(u.username) + "/remove", { reason });
              if (r.status !== 200) error.textContent = problem(r);
              else await userPage();
            },
          },
        }));
      }
      if (d.can.suspend) tools.append(el("a", { class: "forum-act", href: href.admin("accounts", u.username), text: "SUSPEND OR TURN OFF POSTING" }));
      const sigAct = (label, method, path, ask, body) => tools.append(el("button", {
        type: "button", class: "forum-act is-danger", text: label,
        on: {
          click: async () => {
            let input = body;
            if (ask) {
              const reason = prompt(ask, "");
              if (reason === null) return;
              input = { ...(body || {}), reason };
              if (label === "BLOCK SIGNATURE") {
                const days = prompt("For how many days? (empty: until a moderator lifts it)", "");
                if (days === null) return;
                if (days.trim()) input.days = Number(days);
              }
            }
            const r = await call(method, "signatures/" + encodeURIComponent(u.username) + path, input);
            if (r.status !== 200) error.textContent = problem(r);
            else await userPage();
          },
        },
      }));
      if (d.can.clearSignature) sigAct("CLEAR SIGNATURE", "POST", "/clear", "Why is the signature cleared? (kept in the audit log)", {});
      if (d.can.blockSignature) {
        const b = u.signatureBlock;
        if (b) {
          tools.append(el("span", { class: "forum-row-meta", text: "Signature blocked" + (b.until ? " until " + when(b.until) : "") + ": " + b.reason }));
          sigAct("LET SIGNATURE BACK", "DELETE", "/block", null, undefined);
        } else {
          sigAct("BLOCK SIGNATURE", "POST", "/block", "Why can " + u.username + " not set a signature? (they see this)", {});
        }
      }
      tools.append(error);
      main.append(tools);
    }
    main.append(el("h2", { class: "sub-title forum-section", text: "LATEST POSTS" }));
    const list = el("div", { class: "forum-list" });
    for (const p of d.recent) {
      list.append(el("div", { class: "forum-row" }, el("div", null, el("a", { class: "forum-row-title", href: href.thread(p.thread, { post: p.post }), text: p.title })),
        el("div", { class: "forum-row-stats" }), el("div", { class: "forum-row-last", text: when(p.at) })));
    }
    if (!d.recent.length) list.append(el("p", { class: "forum-empty", text: "No posts yet." }));
    main.append(list);
    // the WALL, drawn when its own answer comes
    const wall = el("section", { class: "forum-wall", id: "wall", "aria-label": "Wall" });
    main.append(wall);
    showWall(u, d.viewer, wall).catch(() => wall.replaceChildren(el("p", { class: "forum-error", text: OFFLINE })));
  }

  // ---- search ------------------------------------------------------------------------------------

  async function searchPage() {
    const q = (params.get("q") || "").trim();
    const box = $("forumSearch") && $("forumSearch").elements.q;
    if (box) box.value = q;
    if (q.length < 2) {
      const res = await call("GET", "categories");
      bar([["FORUM", href.home()], ["SEARCH", null]], res.data && res.data.viewer);
      return status("Type at least 2 characters of a thread's title.");
    }
    const page = Number(params.get("page")) || 1;
    const res = await call("GET", "search?q=" + encodeURIComponent(q) + (page > 1 ? "&page=" + page : ""));
    const d = res.data || {};
    bar([["FORUM", href.home()], ["SEARCH", null]], d.viewer);
    if (!ok(res)) return;
    setTitle("SEARCH", "// FORUM");
    const main = $("forumMain");
    main.textContent = "";
    main.append(el("p", { class: "forum-row-meta", text: plural(d.total, "THREAD") + " WITH " + d.query.toUpperCase() + " IN THE TITLE" }));
    const list = el("div", { class: "forum-list" });
    for (const t of d.threads) list.append(threadRow(t, { category: t.category }));
    if (!d.threads.length) list.append(el("p", { class: "forum-empty", text: "Nothing found. Try fewer or shorter words." }));
    main.append(list, pager(d.page, d.pages, (n) => href.search(q, n)) || "");
  }

  // for pages outside the forum that show what the forum shows (the ACCOUNT page's signature
  // preview): the forum's own drawing, so it can never differ
  window.H9Forum = Object.freeze({ signature: signatureNode });

  const pages = { index: indexPage, category: categoryPage, thread: threadPage, user: userPage, search: searchPage };
  if (pages[PAGE]) {
    pages[PAGE]().catch(() => status(OFFLINE, true));
  }
})();
