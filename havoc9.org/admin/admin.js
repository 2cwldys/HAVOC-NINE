// HAVOC9 admin panel (admin/): the forum's report queue, removed threads and categories; accounts
// (suspensions, posting on the forum, profile pictures, and for admins sign-outs, passwords, roles
// and deletion); username changes; presence (flags, devices, and moving or resetting a player id,
// for admins); the audit log. The panel shows what the account's role may do; the server checks
// every request again (h9web's lib/admin.js, the forum module and the presence module, README.txt
// sections 15 and 16, modules/presence/README.txt). Built with createElement and textContent
// only. A password typed for a confirmation goes with that one request and is not kept.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const DOT = " " + String.fromCharCode(183) + " ";
  const OFFLINE = "The service is not answering. Try again in a minute.";
  const ROLE_WORDS = { user: "Player", moderator: "Moderator", admin: "Admin" };
  let me = null;
  let forumOn = true;
  const shown = {};

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

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await fetch(new URL("api/" + path, root).href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
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

  const problem = (res) => (res.data && typeof res.data.message === "string" ? res.data.message : res.status === 0 ? OFFLINE : "Something went wrong (" + res.status + ").");
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");
  const forumHref = (p) => new URL("forum/" + p, root).href;
  const threadHref = (id, post) => forumHref("thread/?t=" + id + (post ? "&post=" + post + "#p" + post : ""));
  const userHref = (name) => forumHref("user/?u=" + encodeURIComponent(name));

  // ---- small parts -------------------------------------------------------------------------------

  const box = (title, ...kids) => el("div", { class: "panel-box" }, title ? el("h3", { text: title }) : null, ...kids);
  const field = (label, input) => el("label", null, el("span", { class: "forum-label", text: label }), input);
  const input = (props = {}) => el("input", { class: "forum-input", type: "text", ...props });
  const roleSelect = (value, roles = ["user", "moderator", "admin"]) => {
    const s = el("select", { class: "forum-select" });
    for (const r of roles) {
      const o = el("option", { value: r, text: { user: "everyone", moderator: "moderators and up", admin: "admins" }[r] });
      if (r === value) o.selected = true;
      s.append(o);
    }
    return s;
  };
  const button = (label, fn, kind) => el("button", { type: "button", class: kind === "primary" ? "btn btn-primary btn-sm" : "forum-act" + (kind === "danger" ? " is-danger" : ""), text: label, on: { click: fn } });
  const note = () => el("p", { class: "forum-error", role: "alert" });
  const say = (where, res, okText) => {
    where.className = res.status >= 200 && res.status < 300 ? "forum-done" : "forum-error";
    where.textContent = res.status >= 200 && res.status < 300 ? okText : problem(res);
    return res.status >= 200 && res.status < 300;
  };
  // A small password prompt, opened under the button whose action needs it, with one line saying
  // why. Resolves to the password typed (it goes with that one request and is not kept), or null
  // when cancelled. Only one is open at a time.
  let openPrompt = null;
  function askPassword(anchor, why) {
    if (openPrompt) openPrompt();
    return new Promise((resolve) => {
      const pass = el("input", { class: "forum-input", type: "password", autocomplete: "current-password", "aria-label": "Your own password" });
      const form = el("form", { class: "panel-confirm" },
        el("p", { class: "forum-row-meta", text: why + " Type your own password: it goes with this one action and is not kept." }),
        field("YOUR PASSWORD", pass),
        el("div", { class: "panel-actions" }, el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "CONFIRM" }), button("CANCEL", () => finish(null))));
      const finish = (value) => {
        form.remove();
        if (openPrompt === close) openPrompt = null;
        resolve(value);
      };
      const close = () => finish(null);
      openPrompt = close;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const value = pass.value;
        pass.value = "";
        if (value) finish(value);
      });
      anchor.after(form);
      pass.focus();
    });
  }
  function pagerButtons(d, go) {
    if (!(d.pages > 1)) return null;
    return el("div", { class: "panel-actions" },
      d.page > 1 ? button("< NEWER", () => go(d.page - 1)) : null,
      el("span", { class: "forum-row-meta", text: "PAGE " + d.page + " OF " + d.pages }),
      d.page < d.pages ? button("OLDER >", () => go(d.page + 1)) : null);
  }

  // ---- tabs --------------------------------------------------------------------------------------

  const TABS = { reports: showReports, forum: showForum, accounts: showAccounts, renames: showRenames, presence: showPresence, audit: showAudit };

  function open(tab) {
    if (!TABS[tab] || (tab !== "accounts" && !me.admin && (tab === "renames" || tab === "presence" || tab === "audit")) || (!forumOn && (tab === "reports" || tab === "forum"))) tab = forumOn ? "reports" : "accounts";
    for (const b of $("panelTabs").querySelectorAll("button")) b.setAttribute("aria-selected", b.getAttribute("data-tab") === tab ? "true" : "false");
    for (const name of Object.keys(TABS)) $("tab-" + name).hidden = name !== tab;
    TABS[tab]($("tab-" + tab));
  }

  // ---- reports -------------------------------------------------------------------------------------

  async function showReports(section, status = shown.reportStatus || "open", page = 1) {
    shown.reportStatus = status;
    const res = await call("GET", "forum/reports?status=" + status + "&page=" + page);
    section.textContent = "";
    section.append(el("div", { class: "panel-actions" },
      button(status === "open" ? "SHOW CLOSED REPORTS" : "SHOW OPEN REPORTS", () => showReports(section, status === "open" ? "closed" : "open"))));
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    const d = res.data;
    const list = box((status === "open" ? "OPEN REPORTS" : "CLOSED REPORTS") + " (" + d.total + ")");
    for (const r of d.reports) {
      const msg = note();
      const outcome = input({ maxlength: 200, placeholder: "What was done (optional)", "aria-label": "Outcome" });
      const item = el("div", { class: "panel-item" },
        el("div", { class: "panel-item-head" },
          el("span", null, "On a post by " + (r.post.author || "a deleted account") + " in ", el("a", { href: threadHref(r.post.thread, r.post.id), text: r.post.threadTitle })),
          el("span", { text: "reported by " + (r.by || "a deleted account") + DOT + when(r.created) })),
        el("p", null, el("strong", { text: "Reason: " }), r.reason),
        el("div", { class: "panel-snapshot", text: r.snapshot }),
        r.post.removed ? el("p", { class: "forum-row-meta", text: "The post was removed (" + r.post.removed + ")." }) : null,
        r.post.threadRemoved ? el("p", { class: "forum-row-meta", text: "Its thread was removed." }) : null,
        r.closed ? el("p", { class: "forum-row-meta", text: "Closed by " + (r.closed.by || "?") + DOT + when(r.closed.at) + DOT + r.closed.outcome }) : null);
      if (!r.closed) {
        item.append(el("div", { class: "panel-actions" }, outcome,
          button("DISMISS", async () => {
            const res2 = await call("POST", "forum/reports/" + r.id + "/close", { outcome: outcome.value || undefined });
            if (say(msg, res2, "Closed.")) showReports(section, status, page);
          }),
          r.post.removed ? null : button("REMOVE THE POST", async () => {
            if (!confirm("Remove this post? Readers see that a moderator removed it; it can be restored.")) return;
            const res2 = await call("DELETE", "forum/posts/" + r.post.id);
            if (say(msg, res2, "Removed.")) showReports(section, status, page);
          }, "danger")), msg);
      }
      list.append(item);
    }
    if (!d.reports.length) list.append(el("p", { class: "forum-empty", text: status === "open" ? "No open reports." : "No closed reports." }));
    section.append(list, pagerButtons(d, (n) => showReports(section, status, n)) || "");
  }

  // ---- the forum: removed threads, categories --------------------------------------------------------

  async function showForum(section, page = 1) {
    section.textContent = "";
    const res = await call("GET", "forum/removed?page=" + page);
    const removed = box("REMOVED THREADS");
    if (res.status !== 200) removed.append(el("p", { class: "forum-error", text: problem(res) }));
    else {
      for (const t of res.data.threads) {
        const msg = note();
        removed.append(el("div", { class: "panel-item" },
          el("div", { class: "panel-item-head" },
            el("a", { href: threadHref(t.id), text: t.title }),
            el("span", { text: (t.category || "") + DOT + (t.removed === "empty" ? "every post removed" : "removed by a moderator") + DOT + (t.by ? "by " + t.by.username : "") })),
          el("div", { class: "panel-actions" }, t.removed === "moderator" ? button("RESTORE", async () => {
            const r2 = await call("POST", "forum/threads/" + t.id + "/restore", {});
            if (say(msg, r2, "Restored.")) showForum(section, page);
          }) : el("span", { class: "forum-row-meta", text: "Restore one of its posts (open the thread) to bring it back." })), msg));
      }
      if (!res.data.threads.length) removed.append(el("p", { class: "forum-empty", text: "No removed threads." }));
      const more = pagerButtons(res.data, (n) => showForum(section, n));
      if (more) removed.append(more);
    }
    section.append(removed);
    if (me.admin) section.append(await categoriesBox(section));
  }

  async function categoriesBox(section) {
    const res = await call("GET", "forum/categories");
    const wrap = box("CATEGORIES");
    if (res.status !== 200) return wrap.append(el("p", { class: "forum-error", text: problem(res) })), wrap;
    const cats = res.data.categories;
    for (const c of cats) {
      const msg = note();
      const name = input({ maxlength: 60, "aria-label": "Name" });
      name.value = c.name;
      const desc = input({ maxlength: 300, "aria-label": "Description" });
      desc.value = c.description;
      const starts = roleSelect(c.startRole);
      const replies = roleSelect(c.replyRole);
      const visible = el("input", { type: "checkbox", "aria-label": "Visible to everyone" });
      visible.checked = c.visible;
      const moveTo = el("select", { class: "forum-select", "aria-label": "Move its threads to" }, el("option", { value: "", text: "(keep threads: refuse if any)" }),
        cats.filter((x) => x.slug !== c.slug).map((x) => el("option", { value: x.slug, text: "move threads to " + x.name })));
      wrap.append(el("div", { class: "panel-item" },
        el("div", { class: "panel-item-head" }, el("span", { text: c.slug + DOT + c.threads + " threads" + DOT + c.posts + " posts" }), c.visible ? null : el("span", { class: "forum-tag is-off", text: "HIDDEN" })),
        el("div", { class: "panel-grid" }, field("NAME", name), field("DESCRIPTION", desc), field("WHO STARTS THREADS", starts), field("WHO REPLIES", replies),
          el("label", null, visible, " VISIBLE TO EVERYONE (unticked: staff only)")),
        el("div", { class: "panel-actions" },
          button("SAVE", async () => {
            const r2 = await call("PATCH", "forum/categories/" + c.slug, { name: name.value, description: desc.value, startRole: starts.value, replyRole: replies.value, visible: visible.checked });
            if (say(msg, r2, "Saved.")) showForum(section);
          }, "primary"),
          button("UP", async () => say(msg, await call("PATCH", "forum/categories/" + c.slug, { move: "up" }), "Moved.") && showForum(section)),
          button("DOWN", async () => say(msg, await call("PATCH", "forum/categories/" + c.slug, { move: "down" }), "Moved.") && showForum(section)),
          moveTo,
          button("DELETE", async () => {
            if (!confirm("Delete the category " + c.name + "?" + (moveTo.value ? " Its threads move first." : ""))) return;
            const r2 = await call("DELETE", "forum/categories/" + c.slug, moveTo.value ? { moveTo: moveTo.value } : undefined);
            if (say(msg, r2, "Deleted.")) showForum(section);
          }, "danger")), msg));
    }
    const slug = input({ maxlength: 40, placeholder: "address, e.g. events", "aria-label": "Address" });
    const name = input({ maxlength: 60, "aria-label": "Name" });
    const desc = input({ maxlength: 300, "aria-label": "Description" });
    const starts = roleSelect("user");
    const replies = roleSelect("user");
    const visible = el("input", { type: "checkbox", "aria-label": "Visible to everyone" });
    visible.checked = true;
    const msg = note();
    wrap.append(el("div", { class: "panel-item" }, el("h3", { text: "ADD A CATEGORY" }),
      el("div", { class: "panel-grid" }, field("ADDRESS (a-z 0-9 -)", slug), field("NAME", name), field("DESCRIPTION", desc), field("WHO STARTS THREADS", starts), field("WHO REPLIES", replies),
        el("label", null, visible, " VISIBLE TO EVERYONE")),
      el("div", { class: "panel-actions" }, button("ADD", async () => {
        const r2 = await call("POST", "forum/categories", { slug: slug.value, name: name.value, description: desc.value, startRole: starts.value, replyRole: replies.value, visible: visible.checked });
        if (say(msg, r2, "Added.")) showForum(section);
      }, "primary")), msg));
    return wrap;
  }

  // ---- accounts ----------------------------------------------------------------------------------------

  async function showAccounts(section) {
    section.textContent = "";
    const preset = params.get("name") || "";
    const detail = el("div");
    const filled = el("p", { class: "forum-done", role: "status" });
    // a row opens the account for an admin; for a moderator it fills in the forms below
    const pick = me.admin ? (name) => showAccount(detail, name) : (name) => {
      for (const i of section.querySelectorAll("input")) if (i.getAttribute("aria-label") === "Username") i.value = name;
      filled.textContent = name + " is filled in below.";
    };
    section.append(accountList(pick), filled, detail, suspendBox(preset));
    if (forumOn) section.append(await postingBox(preset, section), pictureBox(preset));
    if (me.admin) {
      const discord = await discordBox();
      if (discord) section.append(discord);
      if (preset) showAccount(detail, preset);
    }
  }

  function suspendBox(preset, onDone) {
    const name = input({ maxlength: 20, "aria-label": "Username" });
    name.value = preset;
    const days = el("input", { class: "forum-input", type: "number", min: "0.01", step: "any", max: me.admin ? "36500" : String(me.modSuspendMaxDays), "aria-label": "Days" });
    days.value = "1";
    const reason = input({ maxlength: 200, "aria-label": "Reason (the player reads it)" });
    const msg = note();
    return box("SUSPEND AN ACCOUNT",
      el("p", { class: "forum-row-meta", text: me.admin ? "No sign-in, no web client, no posting. Leave DAYS empty for no end (asks for your password)." : "No sign-in, no web client, no posting, for 1 to " + me.modSuspendMaxDays + " days. Players only." }),
      el("div", { class: "panel-grid" }, field("USERNAME", name), field("DAYS", days), field("REASON (THE PLAYER READS IT)", reason)),
      el("div", { class: "panel-actions" }, button("SUSPEND", async (ev) => {
        const body = { reason: reason.value };
        if (days.value !== "") body.days = Number(days.value);
        else {
          body.password = await askPassword(ev.target, "A suspension with no end needs your own password.");
          if (body.password === null) return;
        }
        const r = await call("POST", "admin/accounts/" + encodeURIComponent(name.value.trim()) + "/suspend", body);
        if (say(msg, r, "Suspended " + (r.data.until ? "until " + when(r.data.until) : "with no end") + ".") && onDone) onDone();
      }, "danger")), msg);
  }

  async function postingBox(preset, section) {
    const res = await call("GET", "forum/restrictions");
    const name = input({ maxlength: 20, "aria-label": "Username" });
    name.value = preset;
    const days = el("input", { class: "forum-input", type: "number", min: "0.01", step: "any", "aria-label": "Days" });
    const reason = input({ maxlength: 300, "aria-label": "Reason (the player reads it)" });
    const msg = note();
    const wrap = box("POSTING ON THE FORUM",
      el("p", { class: "forum-row-meta", text: "Turning posting off stops new threads, replies, edits and picture changes. The account still signs in, reads and plays. Leave DAYS empty for no end date." }),
      el("div", { class: "panel-grid" }, field("USERNAME", name), field("DAYS (OPTIONAL)", days), field("REASON (THE PLAYER READS IT)", reason)),
      el("div", { class: "panel-actions" }, button("TURN POSTING OFF", async () => {
        const body = { reason: reason.value };
        if (days.value !== "") body.days = Number(days.value);
        const r = await call("POST", "forum/restrictions/" + encodeURIComponent(name.value.trim()), body);
        if (say(msg, r, "Posting is off.")) showAccounts(section);
      }, "danger")), msg);
    if (res.status === 200) {
      for (const x of res.data.accounts) {
        const m2 = note();
        wrap.append(el("div", { class: "panel-item" },
          el("div", { class: "panel-item-head" }, el("a", { href: userHref(x.username), text: x.username }),
            el("span", { text: (x.until ? "until " + when(x.until) : "no end date") + DOT + "by " + (x.by || "?") })),
          el("p", { text: "Reason: " + x.reason }),
          x.can.lift ? el("div", { class: "panel-actions" }, button("TURN POSTING BACK ON", async () => {
            if (say(m2, await call("DELETE", "forum/restrictions/" + encodeURIComponent(x.username)), "Posting is on.")) showAccounts(section);
          })) : null, m2));
      }
      if (!res.data.accounts.length) wrap.append(el("p", { class: "forum-empty", text: "Nobody's posting is off." }));
    }
    return wrap;
  }

  function pictureBox(preset) {
    const name = input({ maxlength: 20, "aria-label": "Username" });
    name.value = preset;
    const reason = input({ maxlength: 300, "aria-label": "Reason (optional)" });
    const msg = note();
    return box("REMOVE A PROFILE PICTURE",
      el("div", { class: "panel-grid" }, field("USERNAME", name), field("REASON (OPTIONAL)", reason)),
      el("div", { class: "panel-actions" }, button("REMOVE PICTURE", async () => {
        const r = await call("POST", "forum/avatars/" + encodeURIComponent(name.value.trim()) + "/remove", { reason: reason.value || undefined });
        say(msg, r, r.data.changed ? "Removed." : "That account has no picture.");
      }, "danger")), msg);
  }

  // The accounts this role may act on (moderators: players), newest first, as the panel opens:
  // a search as you type (the start of a name, without regard to case or look-alikes), a role,
  // suspended or posting off, a sort; a row is picked with onPick(username).
  function accountList(onPick) {
    const q = input({ maxlength: 20, placeholder: "the start of a name", "aria-label": "Search accounts by name" });
    const select = (label, options) => el("select", { class: "forum-select", "aria-label": label }, options.map(([value, text]) => el("option", { value, text })));
    const sort = select("Sort", [["newest", "newest first"], ["oldest", "oldest first"], ["lastlogin", "last sign-in first"], ["name", "by name"]]);
    const role = select("Role", [["", "every role"], ["user", "players"], ["moderator", "moderators"], ["admin", "admins"]]);
    const show = select("Show", [["", "everyone"], ["suspended", "suspended"], ...(forumOn ? [["postingoff", "posting off"]] : [])]);
    const out = el("div", { class: "panel-wrap" });
    let timer = null;
    let latest = 0;
    const status = (x) => [
      x.suspended ? el("span", { class: "forum-tag is-off", text: "SUSPENDED " + (x.suspended.until ? "UNTIL " + when(x.suspended.until).toUpperCase() : "WITH NO END") }) : null,
      x.postingOff ? el("span", { class: "forum-tag", text: "POSTING OFF " + (x.postingOff.until ? "UNTIL " + when(x.postingOff.until).toUpperCase() : "WITH NO END") }) : null,
    ];
    const run = async (page = 1) => {
      const mine = ++latest;
      const qs = new URLSearchParams({ page: String(page), sort: sort.value });
      if (q.value.trim()) qs.set("q", q.value.trim());
      if (role.value) qs.set("role", role.value);
      if (show.value) qs.set("filter", show.value);
      const r = await call("GET", "admin/accounts?" + qs);
      if (mine !== latest) return;
      out.textContent = "";
      if (r.status !== 200) return out.append(el("p", { class: "forum-error", text: problem(r) }));
      const table = el("table", { class: "panel-table" }, el("tr", null, ["USERNAME", "ROLE", "JOINED", "LAST SIGN-IN", ""].map((h) => el("th", { text: h }))));
      for (const x of r.data.accounts) {
        table.append(el("tr", null,
          el("td", null, button(x.username, () => onPick(x.username))),
          el("td", { text: ROLE_WORDS[x.role] || x.role }), el("td", { text: when(x.joined) }), el("td", { text: when(x.lastLogin) }),
          el("td", null, status(x))));
      }
      out.append(el("p", { class: "forum-row-meta", text: r.data.total + (r.data.total === 1 ? " account" : " accounts") }), table);
      if (!r.data.accounts.length) out.append(el("p", { class: "forum-empty", text: "No account matches." }));
      const more = pagerButtons(r.data, run);
      if (more) out.append(more);
    };
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(), 250);
    });
    for (const s of [sort, role, show]) s.addEventListener("change", () => run());
    run();
    return box(me.admin ? "ACCOUNTS" : "PLAYERS",
      el("p", { class: "forum-row-meta", text: me.admin ? "Every account, newest first. Click a name to open it." : "The players you may act on, newest first. Click a name to fill it in below." }),
      el("div", { class: "panel-grid" }, field("NAME", q), field("SORT", sort), me.admin ? field("ROLE", role) : null, field("SHOW", show)),
      out);
  }

  async function showAccount(detail, name) {
    const r = await call("GET", "admin/accounts/" + encodeURIComponent(name));
    detail.textContent = "";
    if (r.status !== 200) return detail.append(box(null, el("p", { class: "forum-error", text: problem(r) })));
    const a = r.data.account;
    const msg = note();
    const again = () => showAccount(detail, a.username);
    const act = async (path, body, okText, after) => {
      const res = await call("POST", "admin/accounts/" + encodeURIComponent(a.username) + "/" + path, body);
      if (say(msg, res, okText)) (after || again)(res);
    };
    const rows = [["ROLE", ROLE_WORDS[a.role] || a.role], ["MADE", when(a.created)], ["LAST SIGN-IN", when(a.lastLogin)],
      ["PASSWORD CHANGED", when(a.passwordChanged)], ["NAME CHANGED", when(a.usernameChanged)], ["SIGNED IN ON", a.sessions + " browsers"],
      ["SUSPENDED", a.suspended ? (a.suspended.until ? "until " + when(a.suspended.until) : "with no end") + (a.suspended.reason ? ": " + a.suspended.reason : "") : "no"]];
    if (r.data.rename) rows.push(["NAME REQUEST", r.data.rename.from + " -> " + r.data.rename.to + " (waiting)"]);
    const panel = box("ACCOUNT: " + a.username.toUpperCase(),
      el("div", { class: "feature-list" }, rows.map(([k, v]) => el("div", { class: "feature-row" }, el("span", { class: "feature-label", text: k }), el("span", { class: "feature-value", text: v })))),
      el("p", { class: "forum-row-meta" }, el("a", { href: userHref(a.username), text: "Forum profile" })));
    if (r.data.can.act) {
      const role = el("select", { class: "forum-select", "aria-label": "Role" }, ["user", "moderator"].map((x) => {
        const o = el("option", { value: x, text: ROLE_WORDS[x] });
        if (x === a.role) o.selected = true;
        return o;
      }));
      const confirmName = input({ maxlength: 20, placeholder: "type " + a.username + " to delete", "aria-label": "Type the username to delete" });
      panel.append(
        el("div", { class: "panel-actions" },
          a.suspended ? button("LIFT THE SUSPENSION", () => act("unsuspend", {}, "No longer suspended.")) : null,
          button("SIGN OUT EVERYWHERE", () => act("sessions", {}, "Signed out everywhere.")),
          button("RESET PASSWORD", async (ev) => {
            const password = await askPassword(ev.target, "Resetting " + a.username + "'s password needs your own password.");
            if (password !== null) act("password", { password }, "New password made.", (res) => {
            again().then(() => detail.prepend(box("NEW PASSWORD FOR " + a.username.toUpperCase() + " (SHOWN THIS ONCE)", el("p", { class: "panel-secret", text: res.data.newPassword }),
              el("p", { class: "forum-row-meta", text: "Send it privately (a direct message, never a channel); they change it under ACCOUNT. Every session of the account has ended." }))));
            });
          }, "danger")),
        el("div", { class: "panel-actions" }, role, button("SET ROLE", async (ev) => {
          const password = await askPassword(ev.target, "Changing " + a.username + "'s role needs your own password.");
          if (password !== null) act("role", { role: role.value, password }, "Role set.");
        })),
        el("div", { class: "panel-actions" }, confirmName, button("DELETE THE ACCOUNT", async (ev) => {
          if (!confirm("Delete " + a.username + " for good? Nothing brings it back.")) return;
          const password = await askPassword(ev.target, "Deleting " + a.username + " needs your own password.");
          if (password === null) return;
          act("delete", { confirm: confirmName.value, password }, "Deleted.", () => {
            detail.textContent = "";
            detail.append(box(null, el("p", { class: "forum-done", text: a.username + " was deleted." })));
          });
        }, "danger")), msg);
    } else {
      panel.append(el("p", { class: "forum-row-meta", text: "This account's role is the same as yours or above: nothing here acts on it." }));
    }
    const trail = el("table", { class: "panel-table" }, el("tr", null, ["WHEN", "WHO", "WHAT", "ON", "DETAILS"].map((h) => el("th", { text: h }))));
    for (const e of r.data.audit) trail.append(el("tr", null, [when(e.at), e.by || "-", e.action, e.target || "-", [e.subject, e.detail].filter(Boolean).join(DOT) || "-"].map((v) => el("td", { text: v }))));
    panel.append(el("h3", { class: "forum-section", text: "ITS AUDIT TRAIL" }), el("div", { class: "panel-wrap" }, trail));
    detail.append(panel);
    const discord = await discordOf(a.username, again);
    if (discord) panel.insertBefore(discord, panel.querySelector(".forum-section"));
  }

  // The account's Discord link (the discord module), with FREE: the link goes, and the
  // registered role with it, so the player can link a new Discord account.
  async function discordOf(name, again) {
    const r = await call("GET", "discord/links/" + encodeURIComponent(name));
    if (r.status !== 200 || !r.data.enabled) return null;
    const link = r.data.link;
    const msg = note();
    const reason = input({ maxlength: 200, placeholder: "Why (optional)", "aria-label": "Reason" });
    return el("div", null, el("h3", { class: "forum-section", text: "DISCORD" }),
      link
        ? el("div", null,
          el("p", { text: "Linked to " + link.displayName + " (Discord user " + link.discordUser + ") since " + when(link.linked) + DOT + "role " + link.role }),
          el("div", { class: "panel-actions" }, reason, button("FREE THE LINK", async () => {
            if (!confirm("Free " + name + "'s Discord link? The registered role is taken away, and the player can link another Discord account.")) return;
            if (say(msg, await call("POST", "discord/links/" + encodeURIComponent(name) + "/free", { reason: reason.value || undefined }), "Freed.")) again();
          }, "danger")), msg)
        : el("p", { class: "forum-row-meta", text: "No Discord account is linked." }));
  }

  async function discordBox() {
    const r = await call("GET", "discord/admin");
    if (r.status !== 200) return null;
    const d = r.data;
    if (!d.enabled) return box("DISCORD", el("p", { class: "forum-row-meta", text: "Discord linking is off: no secrets file, or no client id or guild id in config.json (README.txt, section 18)." }));
    const msg = note();
    const last = d.lastReconcile;
    return box("DISCORD",
      el("p", { text: d.links + " linked" + DOT + d.pending + " waiting for the player to join" + (d.freeing ? DOT + d.freeing + " roles still to take back" : "") }),
      el("p", { class: "forum-row-meta", text: "The reconcile runs every " + d.reconcileMinutes + " minutes" + (last ? "; last " + when(last.at) + ": " + last.given + " given, " + last.taken + " taken, " + last.failed + " failed" : "") + "." }),
      el("div", { class: "panel-actions" }, button("RECONCILE NOW", async () => {
        const res = await call("POST", "discord/reconcile", {});
        const sum = res.data && res.data.summary;
        say(msg, res, sum ? "Done: " + sum.given + " given, " + sum.taken + " taken, " + sum.pending + " waiting, " + sum.failed + " failed." : "Done.");
      })), msg);
  }

  // ---- username changes ----------------------------------------------------------------------------------

  async function showRenames(section, status = "pending", page = 1) {
    const res = await call("GET", "admin/renames?status=" + status + "&page=" + page);
    section.textContent = "";
    section.append(el("div", { class: "panel-actions" },
      button(status === "pending" ? "SHOW DECIDED" : "SHOW WAITING", () => showRenames(section, status === "pending" ? "decided" : "pending")),
      el("span", { class: "forum-row-meta", text: status === "pending"
        ? "SHOW DECIDED lists the requests already approved, denied or cancelled, the latest first."
        : "SHOW WAITING goes back to the requests that wait for a decision." })));
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    const list = box(status === "pending" ? "WAITING FOR A DECISION (" + res.data.total + ")" : "DECIDED (" + res.data.total + ")",
      el("p", { class: "forum-row-meta", text: status === "pending"
        ? "A player asked for each of these names under ACCOUNT. APPROVE checks the name again (if someone took it, or one like it, meanwhile, it fails) and asks for your password; the old name stays reserved for its owner for a while. DENY sends the player your reason."
        : "Requests already decided, or cancelled by the player." }));
    for (const r of res.data.requests) {
      const msg = note();
      const reason = input({ maxlength: 300, placeholder: "Reason for a denial (the player reads it)", "aria-label": "Reason" });
      list.append(el("div", { class: "panel-item" },
        el("div", { class: "panel-item-head" }, el("span", { text: r.from + " -> " + r.to }), el("span", { text: (ROLE_WORDS[r.role] || r.role) + DOT + "asked " + when(r.created) })),
        r.status === "pending"
          ? el("div", { class: "panel-actions" },
            button("APPROVE", async (ev) => {
              const password = await askPassword(ev.target, "Approving " + r.from + " -> " + r.to + " changes the name at once and needs your own password.");
              if (password === null) return;
              if (say(msg, await call("POST", "admin/renames/" + r.id + "/approve", { password }), "Approved.")) showRenames(section, status, page);
            }, "primary"),
            reason,
            button("DENY", async () => {
              if (say(msg, await call("POST", "admin/renames/" + r.id + "/deny", { reason: reason.value || undefined }), "Denied.")) showRenames(section, status, page);
            }, "danger"))
          : el("p", { class: "forum-row-meta", text: r.status.toUpperCase() + DOT + when(r.decided) + (r.decidedBy ? DOT + "by " + r.decidedBy : "") + (r.reason ? DOT + r.reason : "") }),
        msg));
    }
    if (!res.data.requests.length) list.append(el("p", { class: "forum-empty", text: "Nothing here." }));
    section.append(list, pagerButtons(res.data, (n) => showRenames(section, status, n)) || "");
  }

  // ---- presence (the presence module's admin hooks: modules/presence/README.txt) ------------------------

  const FLAG_WORDS = { second_device: "SECOND DEVICE", concurrent: "TWO PLACES AT ONCE", bad_proof: "BAD PROOF", stale_proof: "STALE PROOF" };
  const STATE_WORDS = { game: "In game", web: "In the web client", site: "On the site", offline: "Offline" };
  const shortDevice = (d) => (d ? d.slice(0, 12) + "..." : "-");
  const presenceApi = (name, rest) => "presence/admin/accounts/" + encodeURIComponent(name) + (rest || "");
  function duration(seconds) {
    const m = Math.floor((Number(seconds) || 0) / 60);
    return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
  }

  async function showPresence(section, status = shown.flagStatus || "open", page = 1) {
    shown.flagStatus = status;
    const res = await call("GET", "presence/admin/flags?status=" + status + "&page=" + page);
    section.textContent = "";
    if (res.status === 404) {
      return section.append(box("PRESENCE", el("p", { class: "forum-row-meta", text: "The presence module is not loaded: add \"presence\" to \"modules\" in config.json (h9web/modules/presence/README.txt)." })));
    }
    const detail = el("div");
    const name = input({ maxlength: 64, placeholder: "a username", "aria-label": "Username" });
    const form = el("form", { class: "panel-actions" }, name, el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "OPEN" }));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (name.value.trim()) presenceAccount(detail, name.value.trim());
    });
    const look = (n) => {
      name.value = n;
      presenceAccount(detail, n);
      if (typeof form.scrollIntoView === "function") form.scrollIntoView({ block: "start" });
    };
    section.append(box("AN ACCOUNT'S PRESENCE",
      el("p", { class: "forum-row-meta", text: "Where an account is now, its devices, and its player id: allow or unbind a device, reset the id, or move it to another account." }),
      form), detail);
    section.append(el("div", { class: "panel-actions" },
      [["open", "OPEN FLAGS"], ["resolved", "RESOLVED"], ["all", "ALL"]].map(([s, label]) => {
        const b = button(label, () => showPresence(section, s));
        if (s === status) b.className += " is-on";
        b.setAttribute("aria-pressed", s === status ? "true" : "false");
        return b;
      })));
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    const d = res.data;
    const list = box((status === "open" ? "OPEN FLAGS" : status === "resolved" ? "RESOLVED FLAGS" : "ALL FLAGS") + " (" + d.total + ")",
      el("p", { class: "forum-row-meta", text: "SECOND DEVICE: an install that is not the account's proved its player id, and was refused. A second PC of theirs looks like that (a network the account has used makes it likely): ALLOW THIS DEVICE. A leaked id looks like that too: reset the id. TWO PLACES AT ONCE: only the first place counted. BAD PROOF or STALE PROOF: a game sent an answer that does not match the id, or answers an old challenge (a copied id, most likely)." }));
    for (const f of d.flags) list.append(flagItem(f, () => showPresence(section, status, page), look));
    if (!d.flags.length) list.append(el("p", { class: "forum-empty", text: "Nothing here." }));
    section.append(list, pagerButtons(d, (n) => showPresence(section, status, n)) || "");
  }

  // One flag: what happened, and for an open one RESOLVE (and, for a refused device, ALLOW THIS
  // DEVICE). look(name), when given, opens the account above.
  function flagItem(f, again, look) {
    const msg = note();
    const facts = [
      f.server ? "on " + f.server + (f.otherServer ? " and " + f.otherServer : "") : null,
      f.device ? "device " + shortDevice(f.device) : null,
      f.networkKnown === true ? "from a network the account has used" : f.networkKnown === false ? "from a new network" : null,
      f.count + (f.count === 1 ? " time" : " times"),
      "first " + when(f.first),
      "last " + when(f.last),
    ].filter(Boolean).join(DOT);
    const item = el("div", { class: "panel-item" },
      el("div", { class: "panel-item-head" }, el("span", { text: f.username + DOT + (FLAG_WORDS[f.kind] || String(f.kind).toUpperCase()) }),
        el("span", { text: f.status === "open" ? "OPEN" : "RESOLVED " + when(f.resolved) })),
      f.detail ? el("p", { text: f.detail }) : null,
      el("p", { class: "forum-row-meta", text: facts }));
    if (f.status !== "open") {
      if (f.note) item.append(el("p", { class: "forum-row-meta", text: "Note: " + f.note }));
    } else {
      const why = input({ maxlength: 300, placeholder: "A note (the audit log keeps it)", "aria-label": "Note" });
      const actions = el("div", { class: "panel-actions" }, why, button("RESOLVE", async () => {
        if (say(msg, await call("POST", "presence/admin/flags/" + f.id + "/resolve", { note: why.value || undefined }), "Resolved.")) again();
      }));
      if (f.kind === "second_device" && f.device) {
        actions.append(button("ALLOW THIS DEVICE", async () => {
          if (!confirm("Let this device count as " + f.username + "? Only for a device you know is theirs; a leaked id is reset instead.")) return;
          if (say(msg, await call("POST", presenceApi(f.username, "/devices/" + f.device + "/allow"), { note: why.value || undefined }), "Allowed.")) again();
        }));
      }
      item.append(actions);
    }
    if (look) item.append(el("div", { class: "panel-actions" }, button("OPEN " + f.username.toUpperCase(), () => look(f.username))));
    item.append(msg);
    return item;
  }

  async function presenceAccount(detail, name, done) {
    const r = await call("GET", presenceApi(name));
    detail.textContent = "";
    if (r.status !== 200) return detail.append(box(null, el("p", { class: "forum-error", text: problem(r) })));
    const a = r.data;
    const msg = note();
    const again = (text) => presenceAccount(detail, a.username, text);
    const why = input({ maxlength: 300, placeholder: "Why (optional; the audit log keeps it)", "aria-label": "Note for the audit log" });
    const rows = [["STATE", STATE_WORDS[a.state] || a.state], ["PLAYTIME", duration(a.playtimeSeconds) + (a.badge ? DOT + "PLAYS IN GAME" : "")],
      ["FIRST SEEN", when(a.firstSeen)], ["LAST SEEN", when(a.lastSeen)], ["NETWORKS", a.networks + " seen lately, kept only as keyed hashes"]];
    const panel = box("PRESENCE: " + a.username.toUpperCase(),
      done ? el("p", { class: "forum-done", text: done }) : null,
      el("div", { class: "feature-list" }, rows.map(([k, v]) => el("div", { class: "feature-row" }, el("span", { class: "feature-label", text: k }), el("span", { class: "feature-value", text: v })))));

    panel.append(el("h3", { class: "forum-section", text: "NOW" }));
    if (!a.online.length) panel.append(el("p", { class: "forum-row-meta", text: "Not in game anywhere." }));
    for (const o of a.online) {
      panel.append(el("p", { text: [o.server ? o.server.name : "a server", [o.map, o.mode].filter(Boolean).join(" / "), String(o.state || "").toUpperCase(),
        o.name ? "as " + o.name : null, o.via === "web" ? "in the browser" : o.via === "game" ? "in the game" : null,
        o.device ? "device " + shortDevice(o.device) : null].filter(Boolean).join(DOT) }));
    }
    if ((a.sessions || []).length) {
      panel.append(el("h3", { class: "forum-section", text: "LATEST SESSIONS" }));
      const st = el("table", { class: "panel-table" }, el("tr", null, ["SERVER", "STARTED", "ENDED", "COUNTED", "NAME IN GAME", "FROM"].map((h) => el("th", { text: h }))));
      for (const x of a.sessions) {
        st.append(el("tr", null, [x.server.name, when(x.started), when(x.ended), duration(x.seconds), x.name || "-",
          x.via === "web" ? "the browser" : x.via === "game" ? "the game" : "-"].map((v) => el("td", { text: v }))));
      }
      panel.append(el("div", { class: "panel-wrap" }, st));
    }

    panel.append(el("h3", { class: "forum-section", text: "DEVICES" }),
      el("p", { class: "forum-row-meta", text: "Each install that proved this account's player id, as a hash. The first one is bound; more are allowed from a SECOND DEVICE flag. UNBIND takes one away: with none left, the next install to prove the id is bound." }));
    const devMsg = note();
    const table = el("table", { class: "panel-table" }, el("tr", null, ["DEVICE", "STATUS", "FIRST SEEN", "LAST SEEN", ""].map((h) => el("th", { text: h }))));
    for (const d of a.devices) {
      table.append(el("tr", null, el("td", { text: shortDevice(d.device), title: d.device }), el("td", { text: String(d.status).toUpperCase() }),
        el("td", { text: when(d.firstSeen) }), el("td", { text: when(d.lastSeen) }),
        el("td", null, button("UNBIND", async () => {
          if (!confirm("Unbind this device from " + a.username + "? It stops counting as them.")) return;
          const res = await call("POST", presenceApi(a.username, "/devices/" + d.device + "/unbind"), { note: why.value || undefined });
          if (say(devMsg, res, "Unbound.")) again("Device " + shortDevice(d.device) + " unbound.");
        }, "danger"))));
    }
    panel.append(a.devices.length ? el("div", { class: "panel-wrap" }, table) : el("p", { class: "forum-empty", text: "No device has proved this account's id yet." }), devMsg);

    if (a.flags.length) {
      panel.append(el("h3", { class: "forum-section", text: "ITS FLAGS" }));
      for (const f of a.flags) panel.append(flagItem(f, () => again(), null));
    }

    panel.append(el("h3", { class: "forum-section", text: "PLAYER ID" }), field("NOTE FOR THE AUDIT LOG", why));
    const keep = el("input", { type: "checkbox" });
    keep.checked = true;
    const resetConfirm = input({ maxlength: 20, placeholder: "type " + a.username, "aria-label": "Type the username to reset its player id" });
    panel.append(
      el("p", { class: "forum-row-meta", text: "RESET gives " + a.username + " a new player id. The old one, and every h9_clientid made from it, stops working at once, so a leaked id dies. Their open sessions end. They copy the new id from their ACCOUNT page into enter_userid.cmd; the web client uses it by itself." }),
      el("div", { class: "panel-actions" }, resetConfirm, el("label", { class: "forum-row-meta" }, keep, " keep the bound device"),
        button("RESET THE PLAYER ID", async (ev) => {
          if (!confirm("Reset " + a.username + "'s player id? The old one stops working at once.")) return;
          const password = await askPassword(ev.target, "Resetting " + a.username + "'s player id needs your own password.");
          if (password === null) return;
          const res = await call("POST", presenceApi(a.username, "/reset-id"), { confirm: resetConfirm.value, keepDevices: keep.checked, password, note: why.value || undefined });
          if (say(msg, res, "Reset.")) again("Player id reset. " + a.username + " copies the new one from the ACCOUNT page into enter_userid.cmd.");
        }, "danger")));

    const to = input({ maxlength: 20, placeholder: "the account that gets the id", "aria-label": "Move the player id to" });
    const moveConfirm = input({ maxlength: 20, placeholder: "type " + a.username, "aria-label": "Type the username to move its player id" });
    panel.append(
      el("p", { class: "forum-note" }, el("strong", { text: "MOVE DISCARDS THE OTHER ACCOUNT'S OWN PLAYER ID. " }),
        "MOVE gives " + a.username + "'s player id, with its presence history and devices, to another account: the same install, unchanged, then counts as that account (a player whose game ended up on the wrong account). " +
        a.username + " gets a new player id. The other account's old player id is thrown away for good: any game set up with it stops counting as anyone, and nothing brings it back."),
      el("div", { class: "panel-actions" }, to, moveConfirm,
        button("MOVE THE PLAYER ID", async (ev) => {
          const target = to.value.trim();
          if (!target) return say(msg, { status: 400, data: { message: "Type the account that gets the player id." } });
          if (!confirm("Move " + a.username + "'s player id to " + target + "? " + target + "'s own player id is discarded and cannot be brought back.")) return;
          const password = await askPassword(ev.target, "Moving " + a.username + "'s player id to " + target + " discards " + target + "'s own id and needs your own password.");
          if (password === null) return;
          const res = await call("POST", presenceApi(a.username, "/move-id"), { to: target, confirm: moveConfirm.value, password, note: why.value || undefined });
          if (say(msg, res, "Moved.")) {
            presenceAccount(detail, res.data.to, "Moved: " + res.data.from + "'s player id and history are " + res.data.to + "'s now. " + res.data.from + " has a new id; " + res.data.to + "'s old one is gone.");
          }
        }, "danger")),
      msg);
    detail.append(panel);
  }

  // ---- the audit log ----------------------------------------------------------------------------------------

  async function showAudit(section, page = 1, name = shown.auditName || "") {
    shown.auditName = name;
    const res = await call("GET", "admin/audit?page=" + page + (name ? "&name=" + encodeURIComponent(name) : ""));
    section.textContent = "";
    const q = input({ maxlength: 64, placeholder: "a username (who acted, or was acted on)", "aria-label": "Filter by name" });
    q.value = name;
    const form = el("form", { class: "panel-actions" }, q, el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "FILTER" }));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      showAudit(section, 1, q.value.trim());
    });
    section.append(form);
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    const table = el("table", { class: "panel-table" }, el("tr", null, ["WHEN", "WHO", "WHAT", "ON", "DETAILS"].map((h) => el("th", { text: h }))));
    for (const e of res.data.entries) table.append(el("tr", null, [when(e.at), e.by || "-", e.action, e.target || "-", [e.subject, e.detail].filter(Boolean).join(DOT) || "-"].map((v) => el("td", { text: v }))));
    section.append(box("AUDIT LOG (KEPT " + res.data.retentionDays + " DAYS)", el("div", { class: "panel-wrap" }, table)), pagerButtons(res.data, (n) => showAudit(section, n, name)) || "");
  }

  // ---- start -----------------------------------------------------------------------------------------------

  (async () => {
    const status = $("panelStatus");
    const res = await call("GET", "admin/me");
    if (res.status === 401) {
      const login = new URL("account/login/", root);
      login.searchParams.set("next", "admin/");
      status.textContent = "";
      status.append("Sign in first: ", el("a", { href: login.href, text: "SIGN IN" }), ".");
      return;
    }
    if (res.status !== 200) {
      status.textContent = res.status === 403 && res.data.error === "forbidden" ? "This page is for moderators and admins." : problem(res);
      return;
    }
    me = res.data;
    forumOn = (await call("GET", "forum/reports?status=open")).status !== 404;
    status.hidden = true;
    const tabs = $("panelTabs");
    tabs.hidden = false;
    for (const b of tabs.querySelectorAll("button")) {
      const tab = b.getAttribute("data-tab");
      if ((b.hasAttribute("data-admin") && !me.admin) || (!forumOn && (tab === "reports" || tab === "forum"))) b.hidden = true;
      else b.hidden = false;
      b.addEventListener("click", () => open(tab));
    }
    open(params.get("tab") || "reports");
  })().catch(() => {
    $("panelStatus").textContent = OFFLINE;
  });
})();
