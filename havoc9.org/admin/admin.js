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

  const TABS = { reports: showReports, forum: showForum, accounts: showAccounts, needs: showNeeds, renames: showRenames, presence: showPresence, levels: showLevels, site: showSite, audit: showAudit };

  function open(tab) {
    if (!TABS[tab] || (tab !== "accounts" && !me.admin && (tab === "renames" || tab === "presence" || tab === "levels" || tab === "audit" || tab === "site")) || (!forumOn && (tab === "reports" || tab === "forum" || tab === "needs"))) tab = forumOn ? "reports" : "accounts";
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
    if (!me.admin) section.append(linkedGamesLookup(preset), rankLookup(preset));
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
    const trailHead = el("h3", { class: "forum-section", text: "ITS AUDIT TRAIL" });
    panel.append(trailHead, el("div", { class: "panel-wrap" }, trail));
    detail.append(panel);
    // Each box goes in above the audit trail, before this heading: the first ".forum-section" in the
    // panel is the heading of the box that went in before it, which is not the panel's own child.
    const discord = await discordOf(a.username, again);
    if (discord) panel.insertBefore(discord, trailHead);
    const games = await linkedGames(a.username, again);
    if (games) panel.insertBefore(games, trailHead);
    const rank = await rankBox(a.username, again);
    if (rank) panel.insertBefore(rank, trailHead);
    const dev = me.admin ? await developerOf(a.username) : null;
    if (dev) panel.insertBefore(dev, trailHead);
  }

  // The account's DEVELOPER flag (the forum module), for admins: it goes with any role, shows the
  // name in purple on the forum, and lets the account edit the "What we need" page.
  async function developerOf(name) {
    const r = await call("GET", "forum/developers/" + encodeURIComponent(name));
    if (r.status !== 200) return null;
    const msg = note();
    const box = el("div", null, el("h3", { class: "forum-section", text: "DEVELOPER" }));
    const draw = (on) => {
      box.textContent = "";
      box.append(el("h3", { class: "forum-section", text: "DEVELOPER" }),
        el("p", { text: on ? name + " is a developer: a purple name on the forum, and an editor of What we need." : name + " is not a developer." }),
        el("div", { class: "panel-actions" }, button(on ? "REMOVE DEVELOPER" : "MAKE DEVELOPER", async () => {
          const res = await call(on ? "DELETE" : "POST", "forum/developers/" + encodeURIComponent(name), on ? undefined : {});
          if (say(msg, res, on ? "No longer a developer." : "Now a developer.")) draw(!on);
        }, on ? "danger" : null)), msg);
    };
    draw(r.data.developer);
    return box;
  }

  // The account's Discord link (the discord module), with FREE: the link goes, and the
  // registered role with it, so the player can link a new Discord account.
  // An account's LINKED GAMES (lib/link.js): each game's label, system, when it was linked and last
  // seen, and its site where the link holds one. An admin REVOKES one or ALL, with their own
  // password and a note for the audit log: the same revoke as the owner's on their ACCOUNT page, so
  // the game hears it at its next status check and the account's proof for that device is dropped.
  // Moderators see the list and act on nothing. null when the site has no linking.
  async function linkedGames(name, again) {
    const r = await call("GET", "link/accounts/" + encodeURIComponent(name) + "/devices");
    if (r.status === 404 && !(r.data && r.data.error === "not_found")) return null;
    const box = el("div", null, el("h3", { class: "forum-section", text: "LINKED GAMES" }));
    if (r.status !== 200) {
      box.append(el("p", { class: "forum-error", text: problem(r) }));
      return box;
    }
    const games = r.data.devices || [];
    if (!games.length) {
      box.append(el("p", { class: "forum-row-meta", text: "No game is linked to " + name + "." }));
      return box;
    }
    const act = !!(r.data.can && r.data.can.act);
    const msg = note();
    const why = input({ maxlength: 200, placeholder: "why (the audit log keeps it)", "aria-label": "Note for the audit log" });
    const revoke = async (ev, path, what) => {
      if (why.value.trim().length < 3) {
        msg.className = "forum-error";
        msg.textContent = "Say why, in 3 characters or more: the audit log keeps it.";
        return;
      }
      if (!confirm("Revoke " + what + "? The game is unlinked at its next check, and has to be linked again from its main menu.")) return;
      const password = await askPassword(ev.target, "Revoking " + name + "'s linked games needs your own password.");
      if (password === null) return;
      const res = await call("POST", "link/accounts/" + encodeURIComponent(name) + "/devices/" + path, { password, note: why.value.trim() });
      if (say(msg, res, "Revoked.")) again();
    };
    const head = ["GAME", "SYSTEM", "LINKED", "LAST SEEN", "SITE"];
    if (act) head.push("");
    const table = el("table", { class: "panel-table" }, el("tr", null, head.map((h) => el("th", { text: h }))));
    for (const g of games) {
      const cells = [g.label + (g.device ? DOT + g.device : ""), g.os || "-", when(g.linked), when(g.lastSeen), g.site || "-"].map((v) => el("td", { text: v }));
      if (act) cells.push(el("td", null, button("REVOKE", (ev) => revoke(ev, g.id + "/revoke", "the " + g.label + " game"), "danger")));
      table.append(el("tr", null, cells));
    }
    box.append(el("div", { class: "panel-wrap" }, table));
    if (act) {
      box.append(field("NOTE FOR THE AUDIT LOG", why),
        el("div", { class: "panel-actions" }, button("REVOKE ALL", (ev) => revoke(ev, "revoke-all", "every game linked to " + name), "danger")), msg);
    } else {
      box.append(el("p", { class: "forum-row-meta", text: "Only an admin revokes a linked game, and never on an account of their own role or above." }));
    }
    return box;
  }

  // For moderators, who do not open an account's whole page: one account's linked games, to look at.
  function linkedGamesLookup(preset) {
    const name = input({ maxlength: 20, value: preset || "", "aria-label": "Username" });
    const out = el("div");
    const form = el("form", { class: "panel-actions" }, name, el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "SHOW" }));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      out.textContent = "";
      const n = name.value.trim();
      if (!n) return;
      const games = await linkedGames(n, () => {});
      out.append(games || el("p", { class: "forum-row-meta", text: "Linking is not on this site." }));
    });
    return box("LINKED GAMES", el("p", { class: "forum-row-meta", text: "The games linked to an account, as its owner sees them on the ACCOUNT page." }), form, out);
  }

  // An account's RANK (compete.js): the career level and its experience, the next level's, each
  // table's rating, place and numbers, and every adjustment made. An admin ADJUSTS a table's rating
  // (set it, or move it by an amount) or the career's experience, with a note for the audit log and
  // their own password; never on their own account or another admin's. Moderators look only. null
  // when the site has no rated play.
  async function rankBox(name, again) {
    const r = await call("GET", "presence/compete/accounts/" + encodeURIComponent(name));
    if (r.status === 404 && !(r.data && r.data.error === "not_found")) return null;
    const box = el("div", null, el("h3", { class: "forum-section", text: "RANK" }));
    if (r.status !== 200) {
      box.append(el("p", { class: "forum-error", text: problem(r) }));
      return box;
    }
    const d = r.data;
    const rk = d.rank;
    box.append(el("p", { text: "Lv " + (rk.level === null ? "0" : rk.level) + DOT + d.xp.total + " career XP" + (d.xp.adjusted ? " (" + (d.xp.adjusted > 0 ? "+" : "") + d.xp.adjusted + " of it adjusted)" : "") +
      (d.next ? DOT + "Lv " + d.next.level + " at " + d.next.xp + " XP" : "") + (rk.elo !== null && rk.elo !== undefined ? DOT + "H9 ladder MATCH rating " + rk.elo : "") + DOT + "season " + rk.season.number }));
    if (rk.ladders.length) {
      const table = el("table", { class: "panel-table" }, el("tr", null, ["TABLE", "LADDER", "RATING", "#", "MATCHES", "WON / LOST", "KILLS / DEATHS", "K/D"].map((h) => el("th", { text: h }))));
      for (const l of rk.ladders) {
        table.append(el("tr", null, [l.name, l.ladder.toUpperCase(), l.elo, "#" + l.place, l.matches, l.wins + " / " + l.losses,
          l.kills + " / " + l.deaths + (Number.isInteger(l.assists) ? " / " + l.assists + " A" : ""), Number(l.kd).toFixed(2)].map((v) => el("td", { text: String(v) }))));
      }
      box.append(el("div", { class: "panel-wrap" }, table));
    } else {
      box.append(el("p", { class: "forum-row-meta", text: "No table yet this season." }));
    }
    if (d.adjustments.length) {
      const adj = el("table", { class: "panel-table" }, el("tr", null, ["WHEN", "WHO", "WHAT", "FROM", "TO", "NOTE"].map((h) => el("th", { text: h }))));
      for (const x of d.adjustments) {
        const what = x.field === "xp" ? "career XP" : (x.table || "a table") + " " + String(x.ladder || "").toUpperCase() + " rating";
        adj.append(el("tr", null, [when(x.at), x.by || "-", what, x.before, x.after, x.note].map((v) => el("td", { text: String(v) }))));
      }
      box.append(el("h4", { text: "ADJUSTMENTS" }), el("div", { class: "panel-wrap" }, adj));
    }
    if (!d.can.adjust) {
      box.append(el("p", { class: "forum-row-meta", text: "Only an admin adjusts a rank, and never their own account's or another admin's." }));
      return box;
    }
    const msg = note();
    const what = el("select", { class: "forum-select", "aria-label": "What to adjust" },
      el("option", { value: "xp", text: "Career XP" }),
      ...rk.ladders.map((l) => el("option", { value: "elo|" + l.scope + "|" + l.ladder, text: l.name + " " + l.ladder.toUpperCase() + " rating" })),
      rk.ladders.some((l) => l.kind === "network" && l.ladder === "match") ? null : el("option", { value: "elo|network|match", text: "H9 ladder MATCH rating" }));
    const how = el("select", { class: "forum-select", "aria-label": "Set or move" },
      el("option", { value: "set", text: "set it to" }), el("option", { value: "by", text: "move it by (below 0 takes away)" }));
    const amount = input({ inputmode: "numeric", placeholder: "a whole number", "aria-label": "Amount" });
    const why = input({ maxlength: 200, placeholder: "why (the audit log keeps it)", "aria-label": "Note for the audit log" });
    box.append(el("div", { class: "panel-grid" }, field("ADJUST", what), field("HOW", how), field("AMOUNT", amount), field("NOTE", why)),
      el("div", { class: "panel-actions" }, button("ADJUST THE RANK", async (ev) => {
        const n = Number(amount.value.trim());
        if (!Number.isInteger(n)) return say(msg, { status: 400, data: { message: "The amount is a whole number." } });
        if (why.value.trim().length < 3) return say(msg, { status: 400, data: { message: "Say why, in 3 characters or more: the audit log keeps it." } });
        const password = await askPassword(ev.target, "Adjusting " + name + "'s rank needs your own password.");
        if (password === null) return;
        const [field_, scope, ladder] = what.value.split("|");
        const body = { field: field_ === "xp" ? "xp" : "elo", note: why.value.trim(), password };
        body[how.value] = n;
        if (body.field === "elo") Object.assign(body, { scope, ladder });
        if (say(msg, await call("POST", "presence/compete/accounts/" + encodeURIComponent(name) + "/adjust", body), "Adjusted: the level is worked out again.")) again();
      }, "danger")), msg);
    return box;
  }

  // For moderators: one account's RANK, to look at.
  function rankLookup(preset) {
    const name = input({ maxlength: 20, value: preset || "", "aria-label": "Username" });
    const out = el("div");
    const form = el("form", { class: "panel-actions" }, name, el("button", { type: "submit", class: "btn btn-primary btn-sm", text: "SHOW" }));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      out.textContent = "";
      const n = name.value.trim();
      if (!n) return;
      const rank = await rankBox(n, () => {});
      out.append(rank || el("p", { class: "forum-row-meta", text: "Rated play is not on this site." }));
    });
    return box("RANK", el("p", { class: "forum-row-meta", text: "An account's career level, its experience and its tables, and every adjustment an admin made." }), form, out);
  }

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
      el("p", { class: "forum-row-meta", text: "RESET gives " + a.username + " a new player id. The old one, and every h9_clientid made from it, stops working at once, so a leaked id dies. Their open sessions end, and every game linked to the account is unlinked. 'Link your Account' in the game's main menu links it again and fetches the new id by itself (or they copy it from their ACCOUNT page into enter_userid.cmd); the web client uses it by itself." }),
      el("div", { class: "panel-actions" }, resetConfirm, el("label", { class: "forum-row-meta" }, keep, " keep the bound device"),
        button("RESET THE PLAYER ID", async (ev) => {
          if (!confirm("Reset " + a.username + "'s player id? The old one stops working at once.")) return;
          const password = await askPassword(ev.target, "Resetting " + a.username + "'s player id needs your own password.");
          if (password === null) return;
          const res = await call("POST", presenceApi(a.username, "/reset-id"), { confirm: resetConfirm.value, keepDevices: keep.checked, password, note: why.value || undefined });
          if (say(msg, res, "Reset.")) again("Player id reset. " + a.username + " links the game again with Link your Account in its main menu, which fetches the new id by itself, or copies it from the ACCOUNT page into enter_userid.cmd.");
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

  // ---- the "What we need" page (join/needs/; the forum module's needs.js) --------------------------------

  // The page's editor (assets/forum-render.js needsEditor): its title, intro and items, a live
  // preview drawn as the page draws it, and SAVE, which stores the whole page and goes into the
  // audit log. Admins edit it, and whom the forum's needsEditors names (moderators, developers).
  async function showNeeds(section) {
    const res = await call("GET", "forum/needs");
    section.textContent = "";
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    const d = res.data;
    const link = el("a", { href: new URL("join/needs/", root).href, text: "the page" });
    if (!d.canEdit) {
      return section.append(box("WHAT WE NEED", el("p", { class: "forum-row-meta" }, "You do not edit ", link, " on this site (the forum's needsEditors).")));
    }
    const editor = el("div");
    section.append(box("WHAT WE NEED", el("p", { class: "forum-row-meta" }, "What the team is looking for, on ", link, "."), editor));
    window.H9ForumRender.needsEditor(editor, d, call);
  }

  // ---- site: which parts of the site are open (h9web's lib/siteflags.js) ----

  const SITE_PARTS = [
    ["downloads", "THE DOWNLOAD AREA", "Closed, the pages grey it out and the server refuses its files."],
    ["webclient", "THE WEB CLIENT", "Closed, its page and its relay of the game's traffic are refused."],
  ];

  async function showSite(section) {
    const res = await call("GET", "site");
    section.textContent = "";
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    for (const [part, title, what] of SITE_PARTS) {
      const s = res.data[part];
      const note = el("input", { type: "text", maxlength: "200", value: s.note || "", placeholder: "A note visitors see while it is closed (optional)", "aria-label": title + " note" });
      const msg = el("p", { class: "forum-row-meta", text: what });
      const button = el("button", { type: "button", class: "btn btn-ghost", text: s.enabled ? "CLOSE IT" : "OPEN IT" });
      button.addEventListener("click", async () => {
        button.disabled = true;
        const r = await call("POST", "admin/site", { part, enabled: !s.enabled, note: note.value });
        if (r.status === 200) showSite(section);
        else {
          button.disabled = false;
          msg.textContent = problem(r);
        }
      });
      section.append(box(title, el("p", { class: "forum-row-meta", text: s.enabled ? "OPEN" : "CLOSED" }), note, button, msg));
    }
  }

  // ---- levels: the career's Lv 0-99, the ranked servers, the seasons (h9web's modules/presence/compete.js) ----

  const LEVEL_FIELDS = [
    ["matchXp", "XP A MATCH OR DEATHMATCH MAP PLAYED OUT"],
    ["winXp", "MORE FOR A RATED WIN"],
    ["killXp", "XP A KILL OF A PROVEN PLAYER"],
    ["kdaMin", "LOWEST KILLS-TO-DEATHS FACTOR"],
    ["kdaMax", "HIGHEST KILLS-TO-DEATHS FACTOR"],
    ["eloMultMin", "LOWEST RATING FACTOR"],
    ["eloMultMax", "HIGHEST RATING FACTOR"],
    ["xpBase", "THE CURVE: XP FOR LV 2"],
    ["xpPower", "THE CURVE: ITS STEEPNESS (1 TO 5)"],
  ];

  async function showLevels(section) {
    const res = await call("GET", "presence/compete/levels");
    section.textContent = "";
    if (res.status === 404) return section.append(box("LEVELS", el("p", { class: "forum-row-meta", text: "Rated play is not on this site." })));
    if (res.status !== 200) return section.append(el("p", { class: "forum-error", text: problem(res) }));
    const { settings, defaults } = res.data;
    const zero = el("select", { class: "forum-select", "aria-label": "Lv 0" },
      el("option", { value: "no", text: "No badge or level at all" }),
      el("option", { value: "yes", text: "Show Lv 0 (the default)" }));
    zero.value = settings.showZero ? "yes" : "no";
    const inputs = {};
    const grid = el("div", { class: "panel-grid" }, field("AN ACCOUNT WITH NO EXPERIENCE", zero));
    for (const [k, label] of LEVEL_FIELDS) {
      inputs[k] = input({ value: String(settings[k]), inputmode: "decimal", "aria-label": label });
      grid.append(field(label + " (" + defaults[k] + ")", inputs[k]));
    }
    const msg = el("p", { class: "forum-row-meta" });
    const estimate = el("div");
    const drawEstimate = (e) => {
      estimate.textContent = "";
      if (!e) return;
      const table = el("table", { class: "panel-table" }, el("tr", null, ["LEVEL", "CAREER XP", "ROUGH HOURS OF ACTIVE PLAY"].map((h) => el("th", { text: h }))));
      for (const x of e.levels) table.append(el("tr", null, ["Lv " + x.level, String(x.xp), x.hours === null ? "-" : String(x.hours)].map((v) => el("td", { text: v }))));
      estimate.append(el("h3", { class: "forum-section", text: "THE ROAD TO 99, AT THESE SETTINGS" }),
        el("p", { class: "forum-row-meta", text: "A typical active hour: " + e.typical.matches + " matches or deathmatch maps, " + Math.round(e.typical.ratedShare * 100) + "% of them with a result rated on the H9 ladder and " +
          Math.round(e.typical.winShare * 100) + "% of those won, and " + e.typical.kills + " kills of proven players, at a kills-to-deaths factor of 1 and a rating of 1000: about " + e.typical.xpPerHour + " XP an hour." }),
        el("div", { class: "panel-wrap" }, table));
    };
    drawEstimate(res.data.estimate);
    const save = button("SAVE, AND WORK OUT EVERY LEVEL AGAIN", async () => {
      const body = { showZero: zero.value === "yes" };
      for (const [k] of LEVEL_FIELDS) body[k] = inputs[k].value.trim();
      const r = await call("POST", "presence/compete/levels", body);
      msg.textContent = r.status === 200 ? "Saved: " + r.data.accounts + " accounts' levels worked out again." : problem(r);
      if (r.status === 200) drawEstimate(r.data.estimate);
    }, "primary");
    section.append(box("LEVELS",
      el("p", { class: "forum-row-meta", text: "Every account's badge is its career level, Lv 0 to 99: its overall experience, on top of the compts ELO rating, which stays the skill figure (ELO beside the badge on the forum, on the ladder and in .rank). It shows in game by the name on the scoreboard, on the forum, on profiles and on the ladder, for every account: no privacy switch hides it. An account with no experience is Lv 0, shown unless you say otherwise below." }),
      el("p", { class: "forum-row-meta", text: "Experience: each kill of a proven player, and each match or deathmatch map a proven player plays out (half its rounds and not leaving; on a deathmatch map, there at its end after 5 minutes or more of it) gives (XP a match + more for a win, when the result is rated on the H9 ladder and won) x the player's kills-to-deaths factor x their rating / 1000, each factor kept between its lowest and highest. Bots, bot kills and players whose game proves nothing give nothing; roleplay maps and UNRANKED servers give nothing at all. Lv = 1 + (experience / the XP for Lv 2) ^ (1 / the steepness), from 1 to 99: it only rises, a voided match's experience is taken back, and a season's reset keeps it." }),
      grid, el("div", { class: "panel-actions" }, save), msg, estimate));
    section.append(await serversBox());
    section.append(await seasonBox());
  }

  // RANKED SERVERS: every enrolled server counts, for its own table, its community's ladder and the
  // H9 ladder, unless an admin marks it UNRANKED; then it counts for nothing from then on, and its
  // past matches in a time given can be voided too (typed VOID). Audited.
  async function serversBox() {
    const r = await call("GET", "presence/compete/servers?all=1");
    const msg = note();
    const out = box("RANKED SERVERS", el("p", { class: "forum-row-meta", text: "Every enrolled server is ranked: its matches count for its own table, its community's ladder (where the community's staff count it) and the H9 ladder. UNRANKED: from now on, none of its matches count; with VOID PAST MATCHES its matches from the time given are taken back too, one void each." }));
    if (r.status !== 200) {
      out.append(el("p", { class: "forum-error", text: problem(r) }));
      return out;
    }
    if (!r.data.servers.length) {
      out.append(el("p", { class: "forum-row-meta", text: "No server is enrolled yet." }));
      return out;
    }
    const table = el("table", { class: "panel-table" }, el("tr", null, ["SERVER", "STATE", "LAST MATCH", ""].map((h) => el("th", { text: h }))));
    for (const sv of r.data.servers) {
      const from = input({ type: "date", "aria-label": "Void from" });
      const to = input({ type: "date", "aria-label": "Void to" });
      const typed = input({ placeholder: "type VOID", "aria-label": "Type VOID to void its matches", autocomplete: "off" });
      const set = async (unranked, withVoid) => {
        const body = { unranked };
        if (withVoid) {
          if (!from.value || !to.value) return say(msg, { status: 400, data: { message: "Pick the first and the last day of the matches to void." } });
          if (typed.value.trim() !== "VOID") return say(msg, { status: 400, data: { message: "Type VOID to confirm voiding its matches." } });
          body.void = { from: from.value + "T00:00:00Z", to: to.value + "T23:59:59Z" };
          body.confirm = "VOID";
        } else if (unranked && !confirm("Mark " + sv.name + " UNRANKED? Its match under way ends, and none of its matches count from now on.")) {
          return;
        }
        const res = await call("POST", "presence/compete/servers/" + encodeURIComponent(sv.serverId), body);
        if (say(msg, res, unranked ? "UNRANKED" + (res.data && res.data.voided ? ": " + res.data.voided + " matches voided." : ".") : "Ranked again.")) out.replaceWith(await serversBox());
      };
      const actions = sv.unranked
        ? el("td", null, button("RANK IT AGAIN", () => set(false, false)))
        : el("td", null, button("MARK UNRANKED", () => set(true, false), "danger"),
          el("details", null, el("summary", { text: "AND VOID PAST MATCHES" }), el("div", { class: "panel-actions" }, from, to, typed, button("UNRANKED + VOID", () => set(true, true), "danger"))));
      table.append(el("tr", null, el("td", { text: sv.name }), el("td", { text: sv.unranked ? "UNRANKED since " + when(sv.unrankedAt) : "ranked" }), el("td", { text: when(sv.lastMatch) || "-" }), actions));
    }
    out.append(el("div", { class: "panel-wrap" }, table), msg);
    return out;
  }

  // RESET THE COMPETITIVE SEASON: the season's final standings are archived (still readable on the
  // ladder as that season's), and everyone starts the next one unrated. h9web copies the database
  // first. Typed RESET, and written to the audit log.
  async function seasonBox() {
    const res = await call("GET", "presence/compete/seasons");
    const cur = res.status === 200 ? res.data.current : null;
    const typed = input({ placeholder: "type RESET", "aria-label": "Type RESET to confirm", autocomplete: "off" });
    const msg = el("p", { class: "forum-row-meta" });
    const go = button("RESET THE COMPETITIVE SEASON", async () => {
      if (typed.value.trim() !== "RESET") {
        msg.textContent = "Type RESET to confirm.";
        return;
      }
      const r = await call("POST", "presence/compete/season/reset", { confirm: "RESET" });
      msg.textContent = r.status === 200
        ? "Season " + r.data.ended + " is archived, and season " + r.data.season.number + " has begun with everyone unrated. The database was copied first to " + r.data.backup + " (the data folder's backups)."
        : problem(r);
      typed.value = "";
    }, "danger");
    return box("COMPETITIVE SEASON",
      el("p", { class: "forum-row-meta", text: cur ? "Season " + cur.number + ", since " + when(cur.started) + "." : "The season could not be read." }),
      el("p", { class: "forum-row-meta", text: "A reset ends this season: its final standings stay on the ladder as Season " + (cur ? cur.number : "N") + ", and everyone starts the next one unrated, from the normal starting rating. The career levels and their experience stay: they are each account's over every season. h9web copies its database into the data folder's backups first. It cannot be undone from here." }),
      el("div", { class: "panel-grid" }, field("CONFIRM", typed)), el("div", { class: "panel-actions" }, go), msg,
      seasonOneBox(cur));
  }

  // SEASONS BACK TO SEASON 1: every archived season goes, with its final standings, and the season
  // under way becomes Season 1 from when it started (its tables, the levels and the career
  // experience as they are). The database is copied first; typed SEASON 1; audited.
  function seasonOneBox(cur) {
    const typed = input({ placeholder: "type SEASON 1", "aria-label": "Type SEASON 1 to confirm", autocomplete: "off" });
    const msg = el("p", { class: "forum-row-meta" });
    const go = button("SET THE SEASONS BACK TO SEASON 1", async () => {
      if (typed.value.trim() !== "SEASON 1") {
        msg.textContent = "Type SEASON 1 to confirm.";
        return;
      }
      const r = await call("POST", "presence/compete/season/restart", { confirm: "SEASON 1" });
      msg.textContent = r.status === 200
        ? "Season " + r.data.was + " is Season 1 now, and the archived seasons are gone. The database was copied first to " + r.data.backup + " (the data folder's backups)."
        : problem(r);
      typed.value = "";
    }, "danger");
    return el("div", null, el("h3", { class: "forum-section", text: "BACK TO SEASON 1" }),
      el("p", { class: "forum-row-meta", text: "Every archived season goes, with its final standings, and the season under way" + (cur ? " (Season " + cur.number + ")" : "") + " becomes Season 1 from when it started: its tables, the levels and the career experience stay as they are. h9web copies its database into the data folder's backups first. It cannot be undone from here." }),
      el("div", { class: "panel-grid" }, field("CONFIRM", typed)), el("div", { class: "panel-actions" }, go), msg);
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
      if ((b.hasAttribute("data-admin") && !me.admin) || (!forumOn && (tab === "reports" || tab === "forum" || tab === "needs"))) b.hidden = true;
      else b.hidden = false;
      b.addEventListener("click", () => open(tab));
    }
    // the community page's site-admin tools (enrolled game servers, H9-wide sanctions), for admins
    const community = $("communityLink");
    if (me.admin && community) community.hidden = false;
    open(params.get("tab") || "reports");
  })().catch(() => {
    $("panelStatus").textContent = OFFLINE;
  });
})();
