// HAVOC9: the MEDIA page. Members post YouTube videos of their games; members (never guests)
// comment. Reads and writes h9web's /api/forum/media (modules/forum/media.js):
//   (no query)        the front page: pinned posts, then the newest few; the archive's months;
//                     POST A VIDEO; a title search
//   ?p=<id>           one post: its video, its description, its comments
//   ?y=<year>&m=<month>[&page=N]   one month of the archive
//   ?q=<words>        titles holding every word
// A video shows as its thumbnail from i.ytimg.com; nothing loads from YouTube until a click, which
// puts youtube-nocookie.com's player in its place (the page's CSP allows those two hosts only).
// Staff (moderators and admins) get PIN, HIDE and REMOVE on each post; a hidden post is marked
// HIDDEN and only staff see it. Everything is built with createElement and textContent; the
// description and comments are drawn by assets/forum-render.js.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const DOT = " " + String.fromCharCode(183) + " ";
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const ID = /^[1-9][0-9]{0,14}$/;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const OFFLINE = "The site is not answering. Try again in a minute.";

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "on") for (const [name, fn] of Object.entries(v)) e.addEventListener(name, fn);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
    return e;
  }

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await fetch(new URL("api/forum/" + path, root).href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      return { status: 0, data: { message: OFFLINE } };
    }
    let data = {};
    try {
      data = (await r.json()) || {};
    } catch (e) {
      // not JSON
    }
    return { status: r.status, data };
  }
  const problem = (r) => (r.data && typeof r.data.message === "string" ? r.data.message : r.status === 0 ? OFFLINE : "Something went wrong (" + r.status + ").");
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  const link = (q) => {
    const u = new URL("media/", root);
    for (const [k, v] of Object.entries(q || {})) u.searchParams.set(k, v);
    return u.href;
  };
  const signIn = () => {
    const u = new URL("account/login/", root);
    u.searchParams.set("next", location.pathname.replace(/^\//, "") + location.search);
    return u.href;
  };

  function status(text, error) {
    const s = $("mediaStatus");
    s.textContent = text || "";
    s.hidden = !text;
    s.classList.toggle("is-error", !!error);
  }

  const name = (by) => (by ? el("span", { class: by.developer ? "is-developer" : null, text: by.username }) : "a deleted account");

  // The thumbnail, which becomes the player on a click.
  function video(id, title, big) {
    if (!VIDEO_ID.test(String(id))) return el("div", { class: "media-video" });
    const thumb = el("img", { src: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg", alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    const play = el("button", { type: "button", class: "media-play", "aria-label": "Play " + title }, thumb, el("span", { class: "media-play-mark", text: "PLAY" }));
    const box = el("div", { class: "media-video" + (big ? " is-big" : "") }, play);
    play.addEventListener("click", () => {
      box.textContent = "";
      box.append(el("iframe", {
        src: "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0", title,
        allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
        referrerpolicy: "strict-origin-when-cross-origin", sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox",
      }));
    });
    return box;
  }

  // PIN, HIDE and REMOVE for staff; REMOVE for the author too.
  function tools(p, after) {
    const box = el("div", { class: "media-tools" });
    const go = async (method, body, ask) => {
      if (ask && !confirm(ask)) return;
      const r = await call(method, "media/" + p.id, body);
      if (r.status !== 200) return alert(problem(r));
      after();
    };
    if (p.can.moderate) {
      box.append(el("button", { type: "button", class: "forum-act", text: p.pinned ? "UNPIN" : "PIN", on: { click: () => go("PATCH", { pinned: !p.pinned }) } }));
      box.append(el("button", { type: "button", class: "forum-act", text: p.hidden ? "UNHIDE" : "HIDE", on: { click: () => go("PATCH", { hidden: !p.hidden }) } }));
    }
    if (p.can.remove) box.append(el("button", { type: "button", class: "forum-act is-danger", text: "REMOVE", on: { click: () => go("DELETE", undefined, "Remove this media post for good?") } }));
    return box.childNodes.length ? box : null;
  }

  function tags(p) {
    return [p.pinned ? el("span", { class: "forum-tag is-hot", text: "PINNED" }) : null, p.hidden ? el("span", { class: "forum-tag is-off", text: "HIDDEN" }) : null];
  }

  function card(p, after) {
    return el("article", { class: "media-card" + (p.hidden ? " is-hidden" : "") }, video(p.video, p.title, false),
      el("div", { class: "media-card-body" },
        el("div", { class: "media-card-head" }, el("a", { class: "media-title", href: link({ p: p.id }), text: p.title }), tags(p)),
        el("p", { class: "forum-row-meta" }, "by ", name(p.by), DOT + when(p.created) + DOT,
          el("a", { href: link({ p: p.id }), text: p.comments + (p.comments === 1 ? " comment" : " comments") })),
        tools(p, after)));
  }

  function composer(after) {
    const title = el("input", { class: "forum-input", type: "text", maxlength: 120, placeholder: "Title", "aria-label": "Title" });
    const url = el("input", { class: "forum-input", type: "url", maxlength: 500, placeholder: "https://www.youtube.com/watch?v=... or https://youtu.be/...", "aria-label": "YouTube link" });
    const desc = el("textarea", { class: "forum-textarea", rows: 3, maxlength: 4000, placeholder: "What happens in it (optional): **bold**, *italic*, links", "aria-label": "Description" });
    const error = el("p", { class: "forum-error", role: "alert" });
    const form = el("form", { class: "forum-compose media-compose", novalidate: true, hidden: true },
      el("label", { class: "forum-label", text: "POST A VIDEO" }), title, url, desc,
      el("p", { class: "forum-row-meta", text: "A YouTube link: youtube.com/watch?v=, youtu.be/, /shorts/ or /embed/. The page shows its picture; the video loads from YouTube (youtube-nocookie.com) only when someone presses play." }),
      error, el("div", { class: "forum-compose-actions" },
        el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "CANCEL", on: { click: () => { form.hidden = true; } } }),
        el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "POST" })));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      const r = await call("POST", "media", { title: title.value, link: url.value, description: desc.value });
      if (r.status !== 201) {
        error.textContent = problem(r);
        return;
      }
      location.href = link({ p: r.data.post.id });
    });
    const open = el("button", { type: "button", class: "btn btn-primary btn-sm", text: "POST A VIDEO", on: { click: () => { form.hidden = false; title.focus(); } } });
    return [open, form];
  }

  function searchBox(value) {
    const q = el("input", { class: "forum-input", type: "search", name: "q", maxlength: 100, placeholder: "Search titles", "aria-label": "Search titles" });
    q.value = value || "";
    const form = el("form", { class: "media-search", role: "search", action: link() }, q, el("button", { type: "submit", class: "btn btn-ghost btn-sm", text: "SEARCH" }));
    return form;
  }

  async function front() {
    const r = await call("GET", "media");
    if (r.status !== 200) return status(problem(r), true);
    status("");
    const d = r.data;
    const main = $("mediaMain");
    main.textContent = "";
    const head = el("div", { class: "media-head" }, searchBox(""));
    if (d.viewer.signedIn && !d.viewer.postingBlocked) head.prepend(...composer());
    else if (!d.viewer.signedIn) head.prepend(el("p", { class: "forum-row-meta" }, el("a", { href: signIn(), text: "SIGN IN" }), " to post a video or to comment."));
    main.append(head);
    const list = el("div", { class: "media-list" });
    for (const p of [...d.pinned, ...d.posts]) list.append(card(p, front));
    if (!list.childNodes.length) list.append(el("p", { class: "forum-empty", text: "No videos yet." }));
    main.append(list);
    if (d.archive.length) {
      const arch = el("div", { class: "media-archive" }, el("h2", { class: "sub-title", text: "ARCHIVE" }),
        el("p", { class: "forum-row-meta", text: "Older videos, by month." }));
      const ul = el("ul", { class: "media-months" });
      for (const a of d.archive) ul.append(el("li", null, el("a", { href: link({ y: a.year, m: a.month }), text: MONTHS[a.month - 1] + " " + a.year }), " (" + a.posts + ")"));
      arch.append(ul);
      main.append(arch);
    }
  }

  function pager(page, pages, to) {
    if (!(pages > 1)) return null;
    return el("nav", { class: "forum-pager", "aria-label": "Pages" },
      page > 1 ? el("a", { href: to(page - 1), text: "<" }) : null,
      el("span", { class: "is-current", text: page + " / " + pages }),
      page < pages ? el("a", { href: to(page + 1), text: ">" }) : null);
  }

  async function month(y, m) {
    const page = Number(params.get("page")) || 1;
    const r = await call("GET", "media/archive/" + y + "/" + m + (page > 1 ? "?page=" + page : ""));
    if (r.status !== 200) return status(problem(r), true);
    status("");
    const d = r.data;
    $("mediaTitle").textContent = (MONTHS[d.month - 1] + " " + d.year).toUpperCase();
    const main = $("mediaMain");
    main.textContent = "";
    main.append(el("p", { class: "media-back" }, el("a", { href: link(), text: "< MEDIA" })));
    const list = el("div", { class: "media-list" });
    for (const p of d.posts) list.append(card(p, () => month(y, m)));
    if (!d.posts.length) list.append(el("p", { class: "forum-empty", text: "No videos in this month." }));
    main.append(list, pager(d.page, d.pages, (n) => link({ y, m, page: n })) || "");
  }

  async function search(q) {
    const r = await call("GET", "media/search?q=" + encodeURIComponent(q));
    const main = $("mediaMain");
    main.textContent = "";
    main.append(el("p", { class: "media-back" }, el("a", { href: link(), text: "< MEDIA" })), searchBox(q));
    if (r.status !== 200) return status(problem(r), true);
    status("");
    const list = el("div", { class: "media-list" });
    for (const p of r.data.posts) list.append(card(p, () => search(q)));
    if (!r.data.posts.length) list.append(el("p", { class: "forum-empty", text: "No video with that in its title." }));
    main.append(list);
  }

  function commentNode(c, after) {
    const body = el("div", { class: "forum-body" });
    window.H9ForumRender.blocks(c.content, body);
    const actions = el("div", { class: "media-tools" });
    if (c.can.edit) {
      actions.append(el("button", {
        type: "button", class: "forum-act", text: "EDIT",
        on: {
          click: () => {
            const area = el("textarea", { class: "forum-textarea", rows: 3, maxlength: 2000, "aria-label": "Your comment" });
            area.value = c.body;
            const error = el("p", { class: "forum-error", role: "alert" });
            const save = el("button", {
              type: "button", class: "btn btn-primary btn-sm", text: "SAVE",
              on: {
                click: async () => {
                  const r = await call("PATCH", "media/comments/" + c.id, { body: area.value });
                  if (r.status !== 200) error.textContent = problem(r);
                  else after();
                },
              },
            });
            body.textContent = "";
            body.append(area, error, save);
          },
        },
      }));
    }
    if (c.can.remove) {
      actions.append(el("button", {
        type: "button", class: "forum-act is-danger", text: "REMOVE",
        on: {
          click: async () => {
            if (!confirm("Remove this comment?")) return;
            const r = await call("DELETE", "media/comments/" + c.id);
            if (r.status !== 200) return alert(problem(r));
            after();
          },
        },
      }));
    }
    return el("div", { class: "media-comment" }, el("p", { class: "forum-row-meta" }, name(c.by), DOT + when(c.created) + (c.edited ? DOT + "EDITED" : "")), body, actions.childNodes.length ? actions : null);
  }

  async function one(id) {
    const r = await call("GET", "media/" + id + (params.get("page") ? "?page=" + encodeURIComponent(params.get("page")) : ""));
    if (r.status !== 200) return status(problem(r), true);
    status("");
    const d = r.data;
    const p = d.post;
    const again = () => one(id);
    $("mediaTitle").textContent = p.title.toUpperCase();
    document.title = p.title + " -- MEDIA -- HAVOC9";
    const main = $("mediaMain");
    main.textContent = "";
    const desc = el("div", { class: "forum-body media-desc" });
    window.H9ForumRender.blocks(p.content, desc);
    main.append(el("p", { class: "media-back" }, el("a", { href: link(), text: "< MEDIA" })), video(p.video, p.title, true),
      el("div", { class: "media-card-head" }, tags(p)),
      el("p", { class: "forum-row-meta" }, "by ", name(p.by), DOT + when(p.created) + (p.edited ? DOT + "EDITED" : "")),
      desc, tools(p, () => (p.can.moderate ? again() : (location.href = link()))) || "");
    const section = el("section", { class: "media-comments" }, el("h2", { class: "sub-title", text: "COMMENTS (" + p.comments + ")" }));
    if (!d.viewer.signedIn) {
      section.append(el("p", { class: "forum-note" }, el("a", { href: signIn(), text: "SIGN IN" }), " to read and write comments."));
    } else {
      for (const c of d.comments || []) section.append(commentNode(c, again));
      const pg = pager(d.commentPage, d.commentPages, (n) => link({ p: id, page: n }));
      if (pg) section.append(pg);
      if (d.viewer.postingBlocked) {
        section.append(el("p", { class: "forum-note", text: "Posting is turned off for your account. Reason: " + d.viewer.postingBlocked.reason }));
      } else {
        const area = el("textarea", { class: "forum-textarea", rows: 3, maxlength: 2000, placeholder: "Your comment: **bold**, *italic*, links", "aria-label": "Your comment" });
        const error = el("p", { class: "forum-error", role: "alert" });
        const form = el("form", { class: "forum-compose", novalidate: true }, area, error,
          el("div", { class: "forum-compose-actions" }, el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "COMMENT" })));
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          error.textContent = "";
          const res = await call("POST", "media/" + id + "/comments", { body: area.value });
          if (res.status !== 201) {
            error.textContent = problem(res);
            return;
          }
          again();
        });
        section.append(form);
      }
    }
    main.append(section);
  }

  const p = params.get("p");
  const y = params.get("y");
  const m = params.get("m");
  const q = (params.get("q") || "").trim();
  let run;
  if (p && ID.test(p)) run = one(p);
  else if (/^\d{4}$/.test(y || "") && /^\d{1,2}$/.test(m || "")) run = month(y, m);
  else if (q) run = search(q);
  else run = front();
  run.catch(() => status(OFFLINE, true));
})();
