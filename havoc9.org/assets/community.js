// HAVOC9: communities -- an account's group of enrolled game servers, with one chat across them
// and the website, its players, and its own admins. Reads and writes h9web's presence module
// (/api/presence/communities/...) and draws into the element marked data-h9-community on
// havoc9.org/community/:
//
//   community/            every community, with its owner and how many servers; signed in, a
//                         form to make one (you own it)
//   community/?c=<name>   one community: its servers, each with its map, mode, players and the
//                         address to connect to (who is on a server is as each player's own
//                         privacy switches allow: the server leaves out what a player hides),
//                         and the community chat for anyone signed in -- the game servers' lines
//                         come as [Tag] Name, the website's as [Web] Name, and announcements as
//                         [Community] text. New lines are fetched every 4 seconds while the page
//                         is in view, and the box sends at most one line every 2 seconds.
//   its admins            (the owner, the admins the owner names, and H9's site admins): the
//                         settings, linking a server with the code its console prints, each
//                         server's tag and read-only switch, staff, bans, mutes and kicks,
//                         announcements, deleting a chat line, the shared data's history and
//                         putting it back to an earlier time.
//   H9's site admins      on community/: every enrolled server (approve, revoke, block), H9-wide
//                         bans, mutes and kicks, and announcements to every server.
//
// Everything the server sends goes in as text (textContent), never as HTML. The server checks
// every change again and writes it to the audit log; this page only offers what it may do.
// docs\H9_COMMUNITIES.txt is the guide.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = new URL("api/presence/", root);
  const DOT = " " + String.fromCharCode(183) + " ";
  const CHAT_EVERY = 4000;
  const CHAT_MAX = 120;
  const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;

  const STYLE = [
    ".h9c{display:flex;flex-direction:column;gap:2rem}",
    ".h9c-quiet{font-family:var(--font-mono,monospace);font-size:.85rem;color:var(--text-dim,#9a7f6e)}",
    ".h9c-list{display:flex;flex-direction:column;gap:.6rem}",
    ".h9c-item{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem 1rem;padding:.8rem 1rem;background:var(--bg-card,#1a0f14);",
    "border:1px solid var(--border,rgba(255,77,0,.25))}",
    ".h9c-item a{font-family:var(--font-display,sans-serif);letter-spacing:.06em;color:#fff;text-decoration:none}",
    ".h9c-item a:hover{color:var(--orange,#ff4d00)}",
    ".h9c-meta{font-family:var(--font-mono,monospace);font-size:.8rem;color:var(--text-dim,#9a7f6e)}",
    ".h9c-servers{display:grid;gap:.8rem}",
    ".h9c-server{padding:.9rem 1rem;background:var(--bg-card,#1a0f14);border:1px solid var(--border,rgba(255,77,0,.25));display:flex;flex-direction:column;gap:.45rem}",
    ".h9c-server-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem .8rem}",
    ".h9c-tag{font-family:var(--font-mono,monospace);font-size:.75rem;letter-spacing:.12em;color:var(--orange,#ff4d00);border:1px solid var(--border,rgba(255,77,0,.25));padding:.05rem .4rem}",
    ".h9c-name{font-family:var(--font-display,sans-serif);letter-spacing:.05em;color:#fff;overflow-wrap:anywhere}",
    ".h9c-players{display:flex;flex-wrap:wrap;gap:.3rem .6rem;font-family:var(--font-mono,monospace);font-size:.85rem}",
    ".h9c-players a{color:var(--text,#e8d5c4)}",
    ".h9c-connect{font-family:var(--font-mono,monospace);font-size:.8rem;color:var(--text-dim,#9a7f6e);display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}",
    ".h9c-connect code{color:var(--text,#e8d5c4)}",
    ".h9c-chat{display:flex;flex-direction:column;gap:.6rem}",
    ".h9c-lines{height:22rem;overflow-y:auto;padding:.75rem .9rem;background:rgba(0,0,0,.35);border:1px solid var(--border,rgba(255,77,0,.25));",
    "font-family:var(--font-mono,monospace);font-size:.88rem;line-height:1.45;display:flex;flex-direction:column;gap:.15rem}",
    ".h9c-line{overflow-wrap:anywhere}",
    ".h9c-line time{color:var(--text-muted,#5c4538);margin-right:.5rem}",
    ".h9c-line .h9c-who{color:var(--orange,#ff4d00)}",
    ".h9c-line.is-web .h9c-who{color:#4aa3df}",
    ".h9c-line.is-announce{color:#ffd27f}",
    ".h9c-line button{margin-left:.5rem}",
    ".h9c-say{display:flex;gap:.5rem}",
    ".h9c-say input{flex:1;min-width:0}",
    ".h9c input[type=text],.h9c input[type=number],.h9c input[type=datetime-local],.h9c select{padding:.55rem .7rem;background:rgba(0,0,0,.35);",
    "border:1px solid var(--border,rgba(255,77,0,.25));border-radius:0;color:var(--text,#e8d5c4);font-family:var(--font-mono,monospace);font-size:.9rem}",
    ".h9c input:focus,.h9c select:focus{outline:none;border-color:var(--orange,#ff4d00)}",
    ".h9c-form{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}",
    ".h9c-form label{font-family:var(--font-mono,monospace);font-size:.75rem;letter-spacing:.12em;color:var(--orange,#ff4d00);display:flex;align-items:center;gap:.4rem}",
    ".h9c-panel{display:flex;flex-direction:column;gap:1rem;padding:1.1rem 1.2rem;border:1px solid var(--border,rgba(255,77,0,.25))}",
    ".h9c-panel h3{font-family:var(--font-display,sans-serif);font-size:.95rem;letter-spacing:.12em;color:#fff;margin:0}",
    ".h9c-table{width:100%;border-collapse:collapse;font-family:var(--font-mono,monospace);font-size:.8rem}",
    ".h9c-table th,.h9c-table td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--border,rgba(255,77,0,.15));vertical-align:top;overflow-wrap:anywhere}",
    ".h9c-table th{color:var(--orange,#ff4d00);font-weight:normal;letter-spacing:.1em}",
    ".h9c-scroll{overflow-x:auto}",
    ".h9c-error{color:#ff6b6b;font-family:var(--font-mono,monospace);font-size:.85rem;min-height:1em}",
    ".h9c-done{color:#2ecc71;font-family:var(--font-mono,monospace);font-size:.85rem}",
  ].join("");

  // ---- small helpers ----------------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }

  // { ok, status, body }: body is the JSON answer, or { error, message } made up when there was none.
  async function call(path, { method = "GET", body } = {}) {
    const opts = { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    try {
      const r = await fetch(new URL(path, api), opts);
      let data = null;
      try {
        data = await r.json();
      } catch (e) {
        data = null;
      }
      if (!data || typeof data !== "object") data = { error: "bad_answer", message: "The server answered " + r.status + "." };
      return { ok: r.ok, status: r.status, body: data };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "offline", message: "The site is not answering. Try again in a minute." } };
    }
  }

  const enc = encodeURIComponent;

  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function clock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // An error line under a form, and a short "done" note.
  function status() {
    const line = el("p", { class: "h9c-error", role: "alert" });
    return {
      line,
      fail(r) { line.className = "h9c-error"; line.textContent = (r && r.body && r.body.message) || "That did not work."; },
      done(text) { line.className = "h9c-done"; line.textContent = text || "Done."; },
      clear() { line.textContent = ""; },
    };
  }

  function button(text, onclick, cls) {
    return el("button", { type: "button", class: cls || "account-mini", text, onclick });
  }

  function field(label, input) {
    return el("label", {}, label, input);
  }

  // A player's name: a link to their forum profile, which presence.js turns into their card.
  function cardLink(name) {
    const u = new URL("forum/user/", root);
    u.searchParams.set("u", name);
    return el("a", { href: u.href, "data-h9-card": name, text: name });
  }

  function copyButton(text) {
    const b = button("COPY", async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "COPIED";
      } catch (e) {
        b.textContent = "SELECT IT";
      }
      setTimeout(() => { b.textContent = "COPY"; }, 2000);
    });
    return b;
  }

  // ---- who is looking ---------------------------------------------------------------------------

  async function whoAmI() {
    const shared = window.h9account && window.h9account.me;
    let me = null;
    try {
      me = shared ? await shared : await (await fetch(new URL("api/me", root), { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })).json();
    } catch (e) {
      me = null;
    }
    return me && me.signedIn && me.user ? me.user : null;
  }

  // ---- the list -----------------------------------------------------------------------------------

  async function showList(box, user) {
    const r = await call("communities");
    box.textContent = "";
    if (!r.ok) {
      box.append(el("p", { class: "h9c-quiet", text: r.body.message }));
      return;
    }
    const list = r.body.communities || [];
    const section = el("section", { class: "account-section" }, el("h2", { class: "sub-title", text: "COMMUNITIES" }));
    if (!list.length) section.append(el("p", { class: "h9c-quiet", text: "No communities yet." }));
    const rows = el("div", { class: "h9c-list" });
    for (const c of list) {
      rows.append(el("div", { class: "h9c-item" },
        el("a", { href: "?c=" + enc(c.slug), text: c.name }),
        el("span", { class: "h9c-meta", text: c.slug + DOT + (c.owner ? "run by " + c.owner : "no owner") + DOT + c.servers + (c.servers === 1 ? " server" : " servers") })));
    }
    section.append(rows);
    box.append(section);

    if (user) box.append(createForm());
    else box.append(el("p", { class: "h9c-quiet" }, "Sign in to chat with a community or make one. ", el("a", { href: new URL("account/login/?next=community/", root).href, text: "SIGN IN" })));
    if (user && user.role === "admin") box.append(adminTools());
  }

  function createForm() {
    const slug = el("input", { type: "text", maxlength: 32, placeholder: "short-name", autocomplete: "off", spellcheck: "false" });
    const name = el("input", { type: "text", maxlength: 40, placeholder: "Its name" });
    const st = status();
    const form = el("form", { class: "h9c-form" }, field("SHORT NAME", slug), field("NAME", name), el("button", { type: "submit", class: "btn btn-primary", text: "MAKE IT" }));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const s = slug.value.trim().toLowerCase();
      if (!SLUG.test(s)) {
        st.fail({ body: { message: "The short name: 3 to 32 of a to z, 0 to 9 and -, starting with a letter or digit." } });
        return;
      }
      const r = await call("communities", { method: "POST", body: { slug: s, name: name.value } });
      if (!r.ok) return st.fail(r);
      location.search = "?c=" + enc(s);
    });
    return el("section", { class: "account-section" },
      el("h2", { class: "sub-title", text: "MAKE A COMMUNITY" }),
      el("p", { text: "You own it: you link your servers to it and name its admins. The short name is its address on this page and cannot change." }),
      form, st.line);
  }

  // ---- one community ------------------------------------------------------------------------------

  let chatTimer = null;
  let chatTick = null;

  async function showCommunity(box, slug, user) {
    const r = await call("communities/" + enc(slug));
    box.textContent = "";
    if (!r.ok) {
      box.append(el("p", { class: "h9c-quiet", text: r.body.message }), el("p", {}, el("a", { href: "./", text: "ALL COMMUNITIES" })));
      return;
    }
    const c = r.body;
    const title = document.getElementById("communityTitle");
    if (title) title.textContent = c.name;
    document.title = c.name + " -- HAVOC9";

    box.append(el("p", { class: "h9c-meta" },
      el("a", { href: "./", text: "ALL COMMUNITIES" }), DOT, c.slug, DOT,
      c.owner ? "run by " + c.owner : "no owner", c.staff.length ? DOT + "admins: " + c.staff.join(", ") : ""));

    box.append(serversSection(c));
    box.append(chatSection(c, user));
    if (c.me && c.me.staff) box.append(staffTools(c, user));
  }

  function serversSection(c) {
    const section = el("section", { class: "account-section" }, el("h2", { class: "sub-title", text: "SERVERS" }));
    if (!c.servers.length) {
      section.append(el("p", { class: "h9c-quiet", text: "No servers linked yet." }));
      return section;
    }
    const grid = el("div", { class: "h9c-servers" });
    for (const s of c.servers) {
      const count = s.humans === null || s.humans === undefined ? "no word from it lately" : s.humans + (s.max ? " / " + s.max : "") + " players";
      const map = s.map ? s.map + (s.mode ? " (" + s.mode + ")" : "") : "";
      const players = el("div", { class: "h9c-players" });
      for (const p of s.players || []) players.append(cardLink(p));
      grid.append(el("div", { class: "h9c-server" },
        el("div", { class: "h9c-server-head" }, el("span", { class: "h9c-tag", text: s.tag }), el("span", { class: "h9c-name", text: s.name || s.tag }),
          el("span", { class: "h9c-meta", text: [map, count].filter(Boolean).join(DOT) })),
        (s.players || []).length ? players : null,
        el("div", { class: "h9c-connect" }, "In the game's console: ", el("code", { text: "connect " + s.address }), copyButton("connect " + s.address))));
    }
    section.append(grid);
    return section;
  }

  // ---- the chat -----------------------------------------------------------------------------------

  function chatSection(c, user) {
    const section = el("section", { class: "account-section" }, el("h2", { class: "sub-title", text: "COMMUNITY CHAT" }));
    if (!user) {
      section.append(el("p", { class: "h9c-quiet" }, "Sign in to read and write the community's chat. ",
        el("a", { href: new URL("account/login/?next=" + enc("community/?c=" + c.slug), root).href, text: "SIGN IN" })));
      return section;
    }
    const lines = el("div", { class: "h9c-lines", "aria-live": "polite" });
    const input = el("input", { type: "text", maxlength: CHAT_MAX, placeholder: c.chat ? "Say something to every server" : "The chat is off", autocomplete: "off" });
    const send = el("button", { type: "submit", class: "btn btn-primary", text: "SAY" });
    const st = status();
    const form = el("form", { class: "h9c-say" }, input, send);
    section.append(el("p", { text: "Players on the community's servers write here with " }, el("code", { text: ".relay <text>" }), " in game chat; what you write here shows in their chat as [Web] and your username."),
      el("div", { class: "h9c-chat" }, lines, form, st.line));

    let last = 0;
    let staff = false;
    const shown = new Set();

    function lineOf(m) {
      const row = el("div", { class: "h9c-line" + (m.kind === "announce" ? " is-announce" : m.source === "web" ? " is-web" : "") });
      row.append(el("time", { datetime: m.at, text: clock(m.at) }));
      if (m.kind === "announce") {
        row.append(el("span", { class: "h9c-who", text: "[" + (m.tag || "H9") + "] " }), m.text);
      } else {
        row.append(el("span", { class: "h9c-who", text: "[" + m.tag + "] " + m.name + ": " }), m.text);
      }
      if (staff) {
        row.append(button("DELETE", async () => {
          const r = await call("communities/" + enc(c.slug) + "/chat/" + m.id, { method: "DELETE" });
          if (r.ok) row.remove();
          else st.fail(r);
        }));
        if (m.kind === "chat" && m.name) row.append(button("MUTE", () => prefillSanction(m.name, "mute")));
      }
      return row;
    }

    async function fetchLines() {
      const r = await call("communities/" + enc(c.slug) + "/chat?since=" + last);
      if (!r.ok) return;
      staff = !!r.body.staff;
      const atBottom = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 30;
      for (const m of r.body.messages || []) {
        if (shown.has(m.id)) continue;
        shown.add(m.id);
        lines.append(lineOf(m));
      }
      if (Number.isSafeInteger(r.body.last)) last = r.body.last;
      while (lines.childElementCount > 300) lines.firstElementChild.remove();
      if (atBottom) lines.scrollTop = lines.scrollHeight;
      if (!r.body.chat) {
        input.disabled = true;
        send.disabled = true;
      }
    }

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      const r = await call("communities/" + enc(c.slug) + "/chat", { method: "POST", body: { text } });
      setTimeout(() => { send.disabled = !c.chat; }, 2000);
      if (!r.ok) return st.fail(r);
      st.clear();
      input.value = "";
      fetchLines();
    });

    // one timer and one listener, whichever drawing of the page is current
    const tick = () => {
      if (!document.hidden && lines.isConnected) fetchLines();
    };
    fetchLines();
    if (chatTimer) clearInterval(chatTimer);
    if (chatTick) document.removeEventListener("visibilitychange", chatTick);
    chatTimer = setInterval(tick, CHAT_EVERY);
    chatTick = tick;
    document.addEventListener("visibilitychange", tick);
    return section;
  }

  // ---- the community's admins ---------------------------------------------------------------------

  let sanctionForm = null; // { username, kind } inputs of the open sanctions form, for MUTE in the chat

  function prefillSanction(name, kind) {
    if (!sanctionForm) return;
    sanctionForm.username.value = name;
    sanctionForm.kind.value = kind;
    sanctionForm.username.scrollIntoView({ behavior: "smooth", block: "center" });
    sanctionForm.reason.focus();
  }

  function staffTools(c, user) {
    const base = "communities/" + enc(c.slug);
    const reload = () => showCommunity(document.querySelector("[data-h9-community]"), c.slug, user);
    const section = el("section", { class: "account-section" }, el("h2", { class: "sub-title", text: "RUNNING IT" }));

    // settings
    {
      const name = el("input", { type: "text", maxlength: 40, value: c.name });
      const chat = el("input", { type: "checkbox", checked: c.chat });
      const chatProof = el("input", { type: "checkbox", checked: c.chatProof });
      const dataProof = el("input", { type: "checkbox", checked: c.dataProof });
      const st = status();
      const form = el("form", { class: "h9c-form" }, field("NAME", name), field("CHAT ON", chat),
        field("CHAT NEEDS PROVEN PLAYERS", chatProof), field("DATA NEEDS PROVEN PLAYERS", dataProof),
        el("button", { type: "submit", class: "btn btn-ghost", text: "SAVE" }));
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const r = await call(base, { method: "PATCH", body: { name: name.value, chat: chat.checked, chatProof: chatProof.checked, dataProof: dataProof.checked } });
        if (!r.ok) return st.fail(r);
        reload();
      });
      section.append(el("div", { class: "h9c-panel" }, el("h3", { text: "SETTINGS" }),
        el("p", { class: "h9c-quiet", text: "Proven players: only games that prove the player's H9 id (h9_presence_challenge 1 on the server) may chat or write data." }),
        form, st.line));
    }

    // linking a server, and each server's tag and switches
    {
      const code = el("input", { type: "text", maxlength: 9, placeholder: "abcd-2345", autocomplete: "off", spellcheck: "false" });
      const tag = el("input", { type: "text", maxlength: 12, placeholder: "Tag" });
      const st = status();
      const form = el("form", { class: "h9c-form" }, field("CODE", code), field("TAG", tag), el("button", { type: "submit", class: "btn btn-primary", text: "LINK" }));
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const r = await call(base + "/claim", { method: "POST", body: { code: code.value.trim(), tag: tag.value.trim() } });
        if (!r.ok) return st.fail(r);
        reload();
      });
      const panel = el("div", { class: "h9c-panel" }, el("h3", { text: "LINK A SERVER" }),
        el("p", {}, "On the server's console (or over rcon), run ", el("code", { text: "h9_community_claim" }),
          ": it prints a one-time code, good for 15 minutes. The server has to be enrolled with havoc9.org first (h9_presence does that by itself). The tag (1 to 12 letters, digits, space _ . -) is how its players' lines are marked."),
        form, st.line);
      for (const s of c.servers) {
        const t = el("input", { type: "text", maxlength: 12, value: s.tag });
        const ro = el("input", { type: "checkbox", checked: s.readOnly });
        const st2 = status();
        const f = el("form", { class: "h9c-form" }, el("span", { class: "h9c-name", text: s.name || s.tag }), field("TAG", t), field("READ-ONLY DATA", ro),
          el("button", { type: "submit", class: "account-mini", text: "SAVE" }),
          button("UNLINK", async () => {
            if (!confirm("Unlink " + (s.name || s.tag) + " from " + c.name + "?")) return;
            const r = await call(base + "/servers/" + enc(s.serverId), { method: "DELETE" });
            if (!r.ok) return st2.fail(r);
            reload();
          }));
        f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const r = await call(base + "/servers/" + enc(s.serverId), { method: "POST", body: { tag: t.value.trim(), readOnly: ro.checked } });
          if (!r.ok) return st2.fail(r);
          reload();
        });
        panel.append(f, st2.line);
      }
      section.append(panel);
    }

    // staff: the owner names them
    if (c.me.owner) {
      const name = el("input", { type: "text", maxlength: 32, placeholder: "username" });
      const st = status();
      const form = el("form", { class: "h9c-form" }, field("USERNAME", name), el("button", { type: "submit", class: "btn btn-ghost", text: "ADD" }));
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const r = await call(base + "/staff", { method: "POST", body: { username: name.value.trim() } });
        if (!r.ok) return st.fail(r);
        reload();
      });
      const list = el("div", { class: "h9c-form" });
      for (const u of c.staff) {
        list.append(el("span", { class: "h9c-tag", text: u }), button("REMOVE", async () => {
          const r = await call(base + "/staff/" + enc(u), { method: "DELETE" });
          if (!r.ok) return st.fail(r);
          reload();
        }));
      }
      section.append(el("div", { class: "h9c-panel" }, el("h3", { text: "ADMINS" }),
        el("p", { class: "h9c-quiet", text: "They can do everything here but name admins, put data back and delete the community." }),
        c.staff.length ? list : el("p", { class: "h9c-quiet", text: "None yet." }), form, st.line));
    }

    section.append(sanctionsPanel(base + "/sanctions", "BANS, MUTES AND KICKS",
      "A ban kicks the account from every server of the community and keeps it out, on any device it has proved its id on; a mute stops its chat in game and here; a kick removes it once. Each takes effect within seconds."));
    section.append(announcePanel(base + "/announce", "Shows on every server of the community and in its chat, as [" + c.name + "]."));
    section.append(dataPanel(c, base));

    if (c.me.owner) {
      const confirmBox = el("input", { type: "text", maxlength: 32, placeholder: c.slug, autocomplete: "off" });
      const st = status();
      const form = el("form", { class: "h9c-form" }, field("TYPE " + c.slug, confirmBox), el("button", { type: "submit", class: "btn btn-ghost", text: "DELETE THE COMMUNITY" }));
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const r = await call(base, { method: "DELETE", body: { confirm: confirmBox.value.trim() } });
        if (!r.ok) return st.fail(r);
        location.search = "";
      });
      section.append(el("div", { class: "h9c-panel" }, el("h3", { text: "DELETE" }),
        el("p", { class: "h9c-quiet", text: "Its servers, chat, sanctions and shared data go with it. The servers stay enrolled with havoc9.org." }),
        form, st.line));
    }
    return section;
  }

  // Bans, mutes and kicks: one community's (base = communities/<name>/sanctions) or H9-wide.
  function sanctionsPanel(base, heading, help) {
    const username = el("input", { type: "text", maxlength: 32, placeholder: "username" });
    const kind = el("select", {}, el("option", { value: "ban", text: "ban" }), el("option", { value: "mute", text: "mute" }), el("option", { value: "kick", text: "kick" }));
    const reason = el("input", { type: "text", maxlength: 60, placeholder: "reason (letters, digits, . , : ! ? ( ) -)" });
    const days = el("input", { type: "number", min: 1, max: 3650, placeholder: "days (none: until revoked)" });
    const st = status();
    const form = el("form", { class: "h9c-form" }, field("WHO", username), field("WHAT", kind), field("WHY", reason), field("DAYS", days),
      el("button", { type: "submit", class: "btn btn-primary", text: "APPLY" }));
    const table = el("div", { class: "h9c-scroll" });
    sanctionForm = { username, kind, reason };

    function draw(list) {
      table.textContent = "";
      if (!list.length) {
        table.append(el("p", { class: "h9c-quiet", text: "None." }));
        return;
      }
      const body = el("tbody");
      for (const x of list) {
        body.append(el("tr", {},
          el("td", { text: x.username }), el("td", { text: x.kind }), el("td", { text: x.reason || "" }), el("td", { text: x.by || "" }),
          el("td", { text: when(x.created) }), el("td", { text: x.kind === "kick" ? "" : x.until ? when(x.until) : "until revoked" }),
          el("td", {}, x.active && x.kind !== "kick" ? button("REVOKE", async () => {
            const r = await call(base + "/" + x.id + "/revoke", { method: "POST", body: {} });
            if (!r.ok) return st.fail(r);
            draw(r.body.sanctions || []);
          }) : x.revoked ? "revoked " + when(x.revoked) : x.active ? "" : "over")));
      }
      table.append(el("table", { class: "h9c-table" },
        el("thead", {}, el("tr", {}, ["WHO", "WHAT", "WHY", "BY", "WHEN", "UNTIL", ""].map((h) => el("th", { text: h })))), body));
    }

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = { username: username.value.trim(), kind: kind.value, reason: reason.value };
      if (days.value) body.days = Number(days.value);
      const r = await call(base, { method: "POST", body });
      if (!r.ok) return st.fail(r);
      st.done("Applied.");
      username.value = "";
      reason.value = "";
      days.value = "";
      draw(r.body.sanctions || []);
    });
    call(base).then((r) => (r.ok ? draw(r.body.sanctions || []) : st.fail(r)));
    return el("div", { class: "h9c-panel" }, el("h3", { text: heading }), el("p", { class: "h9c-quiet", text: help }), form, st.line, table);
  }

  function announcePanel(path, help) {
    const text = el("input", { type: "text", maxlength: CHAT_MAX, placeholder: "The announcement" });
    const st = status();
    const form = el("form", { class: "h9c-say" }, text, el("button", { type: "submit", class: "btn btn-primary", text: "ANNOUNCE" }));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const r = await call(path, { method: "POST", body: { text: text.value } });
      if (!r.ok) return st.fail(r);
      text.value = "";
      st.done("Sent.");
    });
    return el("div", { class: "h9c-panel" }, el("h3", { text: "ANNOUNCE" }), el("p", { class: "h9c-quiet", text: help }), form, st.line);
  }

  // The shared data's history (every write, with the server that made it) and, for the owner,
  // putting the values back as they were at a time.
  function dataPanel(c, base) {
    const who = el("input", { type: "text", maxlength: 32, placeholder: "username (all: empty)" });
    const st = status();
    const table = el("div", { class: "h9c-scroll" });
    const form = el("form", { class: "h9c-form" }, field("WHOSE", who), el("button", { type: "submit", class: "account-mini", text: "SHOW" }));

    async function load() {
      const q = who.value.trim() ? "?username=" + enc(who.value.trim()) : "";
      const r = await call(base + "/data/log" + q);
      table.textContent = "";
      if (!r.ok) return st.fail(r);
      st.clear();
      const log = r.body.log || [];
      if (!log.length) {
        table.append(el("p", { class: "h9c-quiet", text: "No writes yet." }));
        return;
      }
      const body = el("tbody");
      for (const x of log) {
        body.append(el("tr", {}, el("td", { text: when(x.at) }), el("td", { text: x.username }), el("td", { text: x.key }),
          el("td", { text: x.old === null ? "-" : x.old }), el("td", { text: x.value === null ? "(removed)" : x.value }),
          el("td", { text: String(x.version) }), el("td", { text: x.server || "" })));
      }
      table.append(el("table", { class: "h9c-table" },
        el("thead", {}, el("tr", {}, ["WHEN", "WHO", "KEY", "WAS", "NOW", "VERSION", "BY SERVER"].map((h) => el("th", { text: h })))), body));
    }
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      load();
    });

    const panel = el("div", { class: "h9c-panel" }, el("h3", { text: "SHARED DATA" }),
      el("p", { class: "h9c-quiet", text: "What the community's servers keep for each account (other plugins write it through h9_community). The last 200 writes, kept 30 days." }),
      form, st.line, table);

    if (c.me.owner) {
      const to = el("input", { type: "datetime-local" });
      const whose = el("input", { type: "text", maxlength: 32, placeholder: "username (all: empty)" });
      const st2 = status();
      const back = el("form", { class: "h9c-form" }, field("BACK TO", to), field("WHOSE", whose), el("button", { type: "submit", class: "btn btn-ghost", text: "PUT IT BACK" }));
      back.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const t = new Date(to.value);
        if (!to.value || Number.isNaN(t.getTime())) return st2.fail({ body: { message: "Pick the time to go back to." } });
        const target = whose.value.trim() ? whose.value.trim() + "'s values" : "every value";
        if (!confirm("Put " + target + " back as they were at " + t.toLocaleString() + "?")) return;
        const body = { to: t.toISOString() };
        if (whose.value.trim()) body.username = whose.value.trim();
        const r = await call(base + "/data/rollback", { method: "POST", body });
        if (!r.ok) return st2.fail(r);
        st2.done(r.body.restored + (r.body.restored === 1 ? " value" : " values") + " put back.");
        load();
      });
      panel.append(el("p", { class: "h9c-quiet", text: "Putting it back writes each changed value as it was at that time (a new version, in the history too)." }), back, st2.line);
    }
    load();
    return panel;
  }

  // ---- H9's site admins -----------------------------------------------------------------------------

  function adminTools() {
    const section = el("section", { class: "account-section" }, el("h2", { class: "sub-title", text: "H9 ADMIN" }));
    section.append(serversPanel());
    section.append(sanctionsPanel("admin/sanctions", "H9-WIDE BANS, MUTES AND KICKS", "On every enrolled server, in every community."));
    section.append(announcePanel("admin/announce", "Shows on every enrolled server, and in every community's chat, as [H9]."));
    return section;
  }

  function serversPanel() {
    const filter = el("select", {},
      ["all", "pending_approval", "active", "pending_proof", "blocked"].map((s) => el("option", { value: s, text: s.replace("_", " ") })));
    const st = status();
    const table = el("div", { class: "h9c-scroll" });

    async function act(s, what) {
      if ((what === "block" || what === "revoke") && !confirm(what + " " + s.address + "?")) return;
      const r = await call("admin/servers/" + enc(s.serverId) + "/" + what, { method: "POST", body: {} });
      if (!r.ok) return st.fail(r);
      load();
    }

    async function load() {
      const r = await call("admin/servers?status=" + enc(filter.value));
      table.textContent = "";
      if (!r.ok) return st.fail(r);
      st.clear();
      const flags = new Map();
      for (const f of r.body.flags || []) {
        if (!flags.has(f.server)) flags.set(f.server, []);
        flags.get(f.server).push(f);
      }
      const list = r.body.servers || [];
      if (!list.length) {
        table.append(el("p", { class: "h9c-quiet", text: "None." }));
        return;
      }
      const body = el("tbody");
      for (const s of list) {
        const marks = (flags.get(s.address) || []).map((f) => f.kind.replace("_", " ") + (f.count > 1 ? " x" + f.count : "") + " (" + when(f.last) + ")");
        const actions = el("td", {});
        if (s.status === "pending_approval") actions.append(button("APPROVE", () => act(s, "approve")));
        if (s.status === "active" || s.status === "pending_approval") actions.append(button("REVOKE", () => act(s, "revoke")));
        actions.append(s.blocked ? button("UNBLOCK", () => act(s, "unblock")) : button("BLOCK", () => act(s, "block")));
        if (marks.length) actions.append(button("RESOLVE FLAGS", () => act(s, "flags/resolve")));
        body.append(el("tr", {}, el("td", { text: s.serverId }), el("td", { text: s.address }),
          el("td", { text: s.status.replace("_", " ") + (s.listed ? DOT + "on servers.json" : "") + (s.manual ? DOT + "hand-made key" : "") }),
          el("td", { text: when(s.live) }), el("td", { text: when(s.lastReport) }), el("td", { text: marks.join("; ") }), actions));
      }
      table.append(el("table", { class: "h9c-table" },
        el("thead", {}, el("tr", {}, ["ID", "ADDRESS", "STATUS", "LIVE SINCE", "LAST REPORT", "FLAGS", ""].map((h) => el("th", { text: h })))), body));
    }
    filter.addEventListener("change", load);
    load();
    return el("div", { class: "h9c-panel" }, el("h3", { text: "ENROLLED SERVERS" }),
      el("p", { class: "h9c-quiet", text: "A server not on servers.json goes live once approved here. Revoke stops its key at once (it may enroll again, and waits for approval again); block stops it enrolling at all. Re-enrolled flags a key replaced by a new enrollment." }),
      el("div", { class: "h9c-form" }, field("SHOW", filter)), st.line, table);
  }

  // ---- start ------------------------------------------------------------------------------------------

  async function start() {
    const box = document.querySelector("[data-h9-community]");
    if (!box) return;
    const style = el("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    box.classList.add("h9c");
    box.append(el("p", { class: "h9c-quiet", text: "Loading..." }));
    const user = await whoAmI();
    const slug = (new URLSearchParams(location.search).get("c") || "").trim().toLowerCase();
    if (slug && SLUG.test(slug)) await showCommunity(box, slug, user);
    else await showList(box, user);
  }

  window.H9Community = { start };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
