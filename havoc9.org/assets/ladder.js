// HAVOC9: the ladder -- ratings from rated play on H9's servers (compts's Elo, per havoc9.org
// account). Reads h9web's presence module (/api/presence/compete/...) and draws into the element
// marked data-h9-ladder on havoc9.org/ladder/:
//
//   ladder/                         the H9 ladder: every enrolled server but the UNRANKED ones
//   ladder/?scope=c:<community>     a community's ladder: the servers its staff count for it
//   ladder/?scope=s:<server id>     one rated server's own table
//     with &ladder=dm               the deathmatch ladder (kills only) instead of the match one,
//     and &page=N                   further down the board
//   ladder/?p=<username>            a player: each rating and rank, and the latest matches
//     with &season=N                a past season's final standings (the current one without)
//   ladder/?m=<match>               a match: its sides, score, rounds, and each player's numbers
//                                   and change
//
// Staff see their switches beside what they run: H9's site admins UNRANKED on a server's table and
// the open disputes on the H9 ladder; a community's staff its LADDER switch and each
// linked server's COUNTS FOR THE LADDER; VOID on a match for whoever may void it, and DISPUTE for
// the match's own players. Everything the server sends goes in as text (textContent), never as
// HTML. The server checks every change again and writes it to the audit log.
// docs\H9_COMPETITIVE.txt is the guide.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = new URL("api/presence/compete/", root);
  const DOT = " " + String.fromCharCode(183) + " ";

  const STYLE = [
    ".h9l{display:flex;flex-direction:column;gap:1.6rem}",
    ".h9l-quiet{font-family:var(--font-mono,monospace);font-size:.85rem;color:var(--text-dim,#9a7f6e)}",
    ".h9l>.h9l-quiet,.h9l>.h9l-error,.h9l>.h9l-done,.h9l-panel>.h9l-quiet,.h9l-panel>.h9l-error,.h9l-panel>.h9l-done{text-align:center}",
    ".h9l-quiet a,.h9l a{color:var(--orange,#ff4d00);text-decoration:none}",
    ".h9l a:hover{color:#fff}",
    ".h9l-tabs{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center}",
    ".h9l-tab{font-family:var(--font-mono,monospace);font-size:.8rem;letter-spacing:.12em;padding:.35rem .8rem;border:1px solid var(--border,rgba(255,77,0,.25));color:var(--text,#e8d5c4)}",
    ".h9l-tab.is-on{border-color:var(--orange,#ff4d00);color:var(--orange,#ff4d00)}",
    ".h9l-head{display:flex;flex-direction:column;gap:.3rem;align-items:center;text-align:center}",
    ".h9l-head h2{font-family:var(--font-display,sans-serif);letter-spacing:.1em;color:#fff;margin:0;font-size:1.2rem}",
    ".h9l-scroll{overflow-x:auto}",
    ".h9l-table{width:100%;border-collapse:collapse;font-family:var(--font-mono,monospace);font-size:.85rem}",
    ".h9l-table th,.h9l-table td{text-align:left;padding:.4rem .55rem;border-bottom:1px solid var(--border,rgba(255,77,0,.15));white-space:nowrap}",
    ".h9l-table th{color:var(--orange,#ff4d00);font-weight:normal;letter-spacing:.1em}",
    ".h9l-table td.num,.h9l-table th.num{text-align:right}",
    ".h9l-up{color:#2ecc71}.h9l-down{color:#ff6b6b}",
    ".h9l-pager{display:flex;gap:1rem;justify-content:center;font-family:var(--font-mono,monospace);font-size:.85rem}",
    ".h9l-panel{display:flex;flex-direction:column;gap:.8rem;padding:1rem 1.2rem;border:1px solid var(--border,rgba(255,77,0,.25))}",
    ".h9l-panel h3{font-family:var(--font-display,sans-serif);font-size:.95rem;letter-spacing:.12em;color:#fff;margin:0;text-align:center}",
    ".h9l-row{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:center;text-align:center;font-family:var(--font-mono,monospace);font-size:.85rem}",
    ".h9l input[type=text]{flex:1;min-width:12rem;max-width:28rem;padding:.5rem .7rem;background:rgba(0,0,0,.35);border:1px solid var(--border,rgba(255,77,0,.25));",
    "color:var(--text,#e8d5c4);font-family:var(--font-mono,monospace);font-size:.9rem}",
    ".h9l-error{color:#ff6b6b;font-family:var(--font-mono,monospace);font-size:.85rem;min-height:1em}",
    ".h9l-done{color:#2ecc71;font-family:var(--font-mono,monospace);font-size:.85rem}",
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

  function here(params) {
    const u = new URL(location.href);
    u.search = "";
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return u.pathname + u.search;
  }

  const playerLink = (name) => el("a", { href: here({ p: name }), text: name });
  const matchLink = (id, text) => el("a", { href: here({ m: id }), text: text || "#" + id });
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }).toUpperCase() : "");
  const signed = (n) => (n === null || n === undefined ? "" : n > 0 ? "+" + n : String(n));
  const change = (n) => el("span", { class: n > 0 ? "h9l-up" : n < 0 ? "h9l-down" : "", text: signed(n) });
  const LADDER_NAME = { match: "MATCH", dm: "DEATHMATCH" };
  // a level as everywhere on the site: presence.js's badge, or the plain number without it
  const levelCell = (level, size) => {
    if (level === null || level === undefined) return "";
    const P = window.H9Presence;
    const badge = P && typeof P.levelBadge === "function" ? P.levelBadge(level, size) : null;
    return badge || "Lv " + level;
  };
  // assists show where a server counted them: a column only when a row has a number
  const counted = (list) => (list || []).some((x) => Number.isInteger(x.assists));
  const assistText = (n) => (Number.isInteger(n) ? n : "");
  const NOT_HERE = "The ladder isn't available on this site yet.";

  // A read that failed, in plain words. probe is the list of rated servers, which answers whenever
  // the ladder is on this site at all: when it does not, the ladder is not here (or the site is
  // not answering); when it does, the failed read's own message says what is missing.
  function failed(box, probe, r, fallback) {
    let text;
    if (probe.status === 0 || r.status === 0) text = "The site is not answering. Try again in a minute.";
    else if (!probe.ok) text = NOT_HERE;
    else text = r.body.message || fallback;
    box.append(el("p", { class: "h9l-quiet", text }));
  }

  function button(text, onclick) {
    return el("button", { type: "button", class: "account-mini", text, onclick });
  }

  function table(head, rows) {
    return el("div", { class: "h9l-scroll" },
      el("table", { class: "h9l-table" },
        el("thead", {}, el("tr", {}, head.map(([t, num]) => el("th", { class: num ? "num" : null, text: t })))),
        el("tbody", {}, rows)));
  }

  const td = (v, num) => el("td", { class: num ? "num" : null }, v === null || v === undefined ? "" : typeof v === "object" ? v : String(v));

  // ---- the boards -------------------------------------------------------------------------------

  async function drawBoard(box, q, me) {
    const scope = q.get("scope") || "network";
    const ladder = q.get("ladder") === "dm" ? "dm" : "match";
    const page = Math.max(1, Number.parseInt(q.get("page") || "1", 10) || 1);
    const season = Number.parseInt(q.get("season") || "0", 10) || 0;
    const [board, list, seasons] = await Promise.all([
      call("board?scope=" + encodeURIComponent(scope) + "&ladder=" + ladder + "&page=" + page + (season ? "&season=" + season : "")),
      call("servers"),
      call("seasons"),
    ]);
    if (!board.ok || !list.ok) {
      failed(box, list, board, "No such ladder.");
      return;
    }
    const b = board.body;
    const servers = list.body.servers || [];

    // where to look: the H9 ladder, each community's, each rated server's
    const tabs = el("div", { class: "h9l-tabs" });
    const tab = (text, sc) => tabs.append(el("a", { class: "h9l-tab" + (sc === scope ? " is-on" : ""), href: here({ scope: sc === "network" ? null : sc, ladder: ladder === "dm" ? "dm" : null }), text }));
    tab("H9 LADDER", "network");
    const seen = new Set();
    for (const s of servers) {
      if (s.community && s.community.ladder && !seen.has(s.community.slug)) {
        seen.add(s.community.slug);
        tab(s.community.name.toUpperCase(), "c:" + s.community.slug);
      }
    }
    for (const s of servers) tab(s.name, "s:" + s.serverId);
    const ladders = el("div", { class: "h9l-tabs" });
    for (const l of ["match", "dm"]) {
      ladders.append(el("a", { class: "h9l-tab" + (l === ladder ? " is-on" : ""), href: here({ scope: scope === "network" ? null : scope, ladder: l === "dm" ? "dm" : null }), text: LADDER_NAME[l] }));
    }
    box.append(tabs, ladders);

    const title = b.scope.kind === "network" ? "THE H9 LADDER" : b.scope.kind === "community" ? b.scope.name.toUpperCase() + "'S LADDER" : b.scope.name.toUpperCase();
    const note = b.scope.kind === "network" ? "Matches on every server enrolled with havoc9.org, except the ones H9's admins mark UNRANKED."
      : b.scope.kind === "community" ? (b.scope.ladder ? "Matches on the servers this community counts for its ladder." : "This community's ladder is off: what it holds stays, nothing new counts.")
      : "This server's own table: its matches, as the server reports them." + (b.scope.unranked ? " It is UNRANKED: from when it was marked, none of its matches count." : " It counts for the H9 ladder too.");
    box.append(el("div", { class: "h9l-head" }, el("h2", { text: title + DOT + LADDER_NAME[ladder] }), el("p", { class: "h9l-quiet", text: note }),
      seasonLine(b, seasons.ok ? seasons.body : null, scope, ladder)));

    if (!b.players.length) {
      box.append(el("p", { class: "h9l-quiet", text: "Nobody is rated here yet." }));
    } else {
      const withA = counted(b.players);
      const rows = b.players.map((p) => el("tr", {},
        td(p.rank, true), td(p.deleted ? p.username : playerLink(p.username)), td(levelCell(p.level, 22), true), td(p.elo, true), td(p.kills, true), td(p.deaths, true), td(p.headshots, true),
        withA ? td(assistText(p.assists), true) : null, ladder === "match" ? td(p.wins + " / " + p.losses, true) : null, td(when(p.lastPlayed))));
      const head = [["#", true], ["PLAYER"], ["LEVEL", true], ["RATING", true], ["KILLS", true], ["DEATHS", true], ["HEADSHOTS", true]];
      if (withA) head.push(["ASSISTS", true]);
      if (ladder === "match") head.push(["WON / LOST", true]);
      head.push(["LAST PLAYED"]);
      box.append(table(head, rows));
    }
    if (b.pages > 1) {
      const pager = el("div", { class: "h9l-pager" });
      if (page > 1) pager.append(el("a", { href: here({ scope: scope === "network" ? null : scope, ladder: ladder === "dm" ? "dm" : null, page: page - 1 }), text: "< PREVIOUS" }));
      pager.append(el("span", { class: "h9l-quiet", text: "PAGE " + page + " OF " + b.pages }));
      if (page < b.pages) pager.append(el("a", { href: here({ scope: scope === "network" ? null : scope, ladder: ladder === "dm" ? "dm" : null, page: page + 1 }), text: "NEXT >" }));
      box.append(pager);
    }

    box.append(findForm());
    if (b.scope.manage) await drawManage(box, b.scope, servers, me);
  }

  // "SEASON 2, SINCE <date>", or a past season's dates, with links to every other season's table.
  function seasonLine(b, seasons, scope, ladder) {
    if (!b.season) return null;
    const s = b.season;
    const line = el("p", { class: "h9l-quiet" }, "SEASON " + s.number + (s.ended ? ", " + day(s.started) + " TO " + day(s.ended) + ": FINAL STANDINGS" : ", SINCE " + day(s.started)));
    const others = [];
    if (seasons && seasons.current && seasons.current.number !== s.number) others.push(seasons.current.number);
    for (const p of (seasons && seasons.past) || []) if (p.number !== s.number) others.push(p.number);
    for (const n of others) {
      const current = seasons.current && n === seasons.current.number;
      line.append(DOT, el("a", { href: here({ scope: scope === "network" ? null : scope, ladder: ladder === "dm" ? "dm" : null, season: current ? null : n }), text: current ? "THIS SEASON" : "SEASON " + n }));
    }
    return line;
  }

  function findForm() {
    const input = el("input", { type: "text", placeholder: "a player's username", maxlength: "20" });
    const go = () => {
      const v = input.value.trim();
      if (v) location.href = here({ p: v });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    return el("div", { class: "h9l-row" }, input, button("FIND A PLAYER", go));
  }

  async function post(path, body, msg) {
    msg.className = "h9l-error";
    msg.textContent = "";
    const r = await call(path, { method: "POST", body });
    if (!r.ok) {
      msg.textContent = r.body.message || "That did not work.";
      return null;
    }
    msg.className = "h9l-done";
    msg.textContent = "Saved.";
    return r.body;
  }

  async function drawManage(box, scope, servers, me) {
    const panel = el("div", { class: "h9l-panel" });
    const msg = el("p", { class: "h9l-error" });
    if (scope.kind === "server") {
      panel.append(el("h3", { text: "H9 ADMIN: UNRANKED" }),
        el("p", { class: "h9l-quiet", text: scope.unranked ? "UNRANKED: this server's matches count nowhere, from when it was marked." : "This server's matches count for its own table, its community's ladder and the H9 ladder, as every enrolled server's do. Mark it UNRANKED to count none of them from now on (the admin panel's LEVELS tab can also void its past matches)." }),
        el("div", { class: "h9l-row" }, button(scope.unranked ? "RANK IT AGAIN" : "MARK IT UNRANKED", async () => {
          if (!scope.unranked && !confirm("Mark this server UNRANKED? Its match under way ends, and no match of it counts from now on.")) return;
          if (await post("servers/" + encodeURIComponent(scope.serverId), { unranked: !scope.unranked }, msg)) location.reload();
        })), msg);
    } else if (scope.kind === "community") {
      panel.append(el("h3", { text: "STAFF: THE COMMUNITY'S LADDER" }),
        el("div", { class: "h9l-row" }, button(scope.ladder ? "TURN THE LADDER OFF" : "TURN THE LADDER ON", async () => {
          if (await post("communities/" + encodeURIComponent(scope.slug), { ladder: !scope.ladder }, msg)) location.reload();
        })));
      for (const s of servers.filter((x) => x.community && x.community.slug === scope.slug)) {
        panel.append(el("div", { class: "h9l-row" }, el("span", { text: s.name }), button(s.community.counts ? "COUNTS FOR THE LADDER: YES" : "COUNTS FOR THE LADDER: NO", async () => {
          if (await post("communities/" + encodeURIComponent(scope.slug) + "/servers/" + encodeURIComponent(s.serverId), { counts: !s.community.counts }, msg)) location.reload();
        })));
      }
      panel.append(el("p", { class: "h9l-quiet", text: "A server that runs h9_compete and is linked to this community shows here once it has reported a match." }), msg);
    } else if (scope.kind === "network" && me && me.role === "admin") {
      const r = await call("disputes?status=open");
      panel.append(el("h3", { text: "H9 ADMIN: OPEN DISPUTES" }));
      const list = r.ok ? r.body.disputes : [];
      if (!list.length) panel.append(el("p", { class: "h9l-quiet", text: "No open disputes." }));
      for (const d of list) {
        panel.append(el("div", { class: "h9l-row" }, matchLink(d.match, "MATCH #" + d.match), el("span", { text: d.username + ": " + d.reason }),
          button("RESOLVE", async () => {
            if (await post("disputes/" + d.id + "/resolve", { note: "" }, msg)) location.reload();
          })));
      }
      panel.append(msg);
    } else {
      return;
    }
    box.append(panel);
  }

  // ---- a player -----------------------------------------------------------------------------------

  async function drawPlayer(box, name, me) {
    const own = me && me.username.toLowerCase() === name.toLowerCase();
    const [r, probe] = await Promise.all([call(own ? "me" : "player/" + encodeURIComponent(name)), call("servers")]);
    if (!r.ok) {
      failed(box, probe, r, "No such player.");
      return;
    }
    const p = r.body;
    box.append(el("div", { class: "h9l-head" }, el("h2", { text: p.username }), levelCell(p.level, 72) || null,
      el("a", { href: here({}), text: "< THE LADDER" })));
    if (!p.ratings.length) {
      box.append(el("p", { class: "h9l-quiet", text: "No rated kills or matches yet." }));
    } else {
      const withA = counted(p.ratings);
      box.append(table([["WHERE"], ["LADDER"], ["RATING", true], ["#", true], ["KILLS", true], ["DEATHS", true], ["HEADSHOTS", true], withA ? ["ASSISTS", true] : null, ["WON / LOST", true]].filter(Boolean),
        p.ratings.map((x) => el("tr", {},
          td(el("a", { href: here({ scope: x.scope === "network" ? null : x.scope, ladder: x.ladder === "dm" ? "dm" : null }), text: x.name })),
          td(LADDER_NAME[x.ladder]), td(x.elo, true), td(x.rank, true), td(x.kills, true), td(x.deaths, true), td(x.headshots, true),
          withA ? td(assistText(x.assists), true) : null, td(x.ladder === "match" ? x.wins + " / " + x.losses : "", true)))));
    }
    if (p.matches === null) {
      box.append(el("p", { class: "h9l-quiet", text: "Their matches are hidden." }));
    } else if (p.matches.length) {
      box.append(el("div", { class: "h9l-head" }, el("h2", { text: "LATEST MATCHES" })));
      const withA = counted(p.matches);
      box.append(table([["MATCH"], ["WHEN"], ["SERVER"], ["MAP"], ["RESULT"], ["K", true], ["D", true], ["HS", true], withA ? ["A", true] : null, ["CHANGE", true]].filter(Boolean),
        p.matches.map((m) => el("tr", {},
          td(matchLink(m.id)), td(when(m.started)), td(m.server), td(m.map), td(resultText(m)),
          td(m.kills, true), td(m.deaths, true), td(m.headshots, true), withA ? td(assistText(m.assists), true) : null, td(change(m.change), true)))));
    }
  }

  function resultText(m) {
    if (m.status === "voided") return "void";
    if (m.status === "open") return "playing";
    if (m.ladder === "dm") return m.place ? "#" + m.place : "";
    return { win: "won", loss: "lost", left: "left" }[m.result] || m.how || "";
  }

  // ---- a match --------------------------------------------------------------------------------------

  async function drawMatch(box, id) {
    const [r, probe] = await Promise.all([call("match/" + encodeURIComponent(id)), call("servers")]);
    if (!r.ok) {
      failed(box, probe, r, "No such match.");
      return;
    }
    const m = r.body;
    const score = m.score ? m.score[0] + " -- " + m.score[1] : "";
    box.append(el("div", { class: "h9l-head" },
      el("h2", { text: "MATCH #" + m.id + DOT + (m.map || "") }),
      el("p", { class: "h9l-quiet", text: [m.server, m.mode, when(m.started), score].filter(Boolean).join(DOT) }),
      el("p", { class: "h9l-quiet", text: m.status === "voided" ? "VOID: it counts for nothing." : m.status === "open" ? "Being played now." :
        (m.rated ? "Rated" : "Recorded, result not rated" + (m.why ? ": " + m.why : "")) + DOT + "counts for: " + m.scopes.join(", ") }),
      el("a", { href: here({}), text: "< THE LADDER" })));
    const sides = m.ladder === "dm" ? [0] : [1, 2];
    for (const s of sides) {
      const players = m.players.filter((p) => (m.ladder === "dm" ? true : p.side === s));
      if (!players.length) continue;
      if (m.ladder !== "dm") box.append(el("div", { class: "h9l-head" }, el("h2", { text: "SIDE " + s + (m.winner === s ? DOT + "WON" : "") })));
      const withA = counted(players);
      const head = [["PLAYER"], ["K", true], ["D", true], ["HS", true]];
      if (withA) head.push(["A", true]);
      head.push(["TK", true]);
      if (m.ladder !== "dm") head.push(["ROUNDS", true], ["RESULT"]);
      else head.push(["PLACE", true]);
      for (const k of m.scopes) head.push([k.toUpperCase(), true]);
      box.append(table(head, players.map((p) => el("tr", {},
        td(p.linked ? playerLink(p.name) : p.name), td(p.kills, true), td(p.deaths, true), td(p.headshots, true),
        withA ? td(assistText(p.assists), true) : null, td(p.teamkills, true),
        m.ladder !== "dm" ? [td(p.rounds, true), td({ win: "won", loss: "lost", left: "left" }[p.result] || "")] : td(p.place, true),
        m.scopes.map((k) => td(change(p.change[k]), true))))));
    }
    if (m.unratedKills) box.append(el("p", { class: "h9l-quiet", text: m.unratedKills + " kills counted for nothing (bots, team kills, or players not proven)." }));
    if (m.canDispute || m.canVoid) {
      const panel = el("div", { class: "h9l-panel" });
      const msg = el("p", { class: "h9l-error" });
      const reason = el("input", { type: "text", maxlength: "300", placeholder: m.canVoid ? "a note for the audit log" : "what is wrong with this match" });
      panel.append(el("h3", { text: m.canVoid ? "VOID OR DISPUTE" : "DISPUTE THIS MATCH" }), el("div", { class: "h9l-row" }, reason));
      const row = el("div", { class: "h9l-row" });
      if (m.canDispute) row.append(button("DISPUTE", async () => {
        if (await post("matches/" + m.id + "/dispute", { reason: reason.value.trim() }, msg)) msg.textContent = "H9's admins will look at it.";
      }));
      if (m.canVoid && m.status !== "voided") row.append(button("VOID THIS MATCH", async () => {
        if (await post("matches/" + m.id + "/void", { note: reason.value.trim() }, msg)) location.reload();
      }));
      panel.append(row, msg);
      box.append(panel);
    }
  }

  // ---- start -----------------------------------------------------------------------------------------

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

  async function start() {
    const box = document.querySelector("[data-h9-ladder]");
    if (!box) return;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    box.className = "h9l";
    const q = new URLSearchParams(location.search);
    const me = await whoAmI();
    if (q.get("m")) await drawMatch(box, q.get("m"));
    else if (q.get("p")) await drawPlayer(box, q.get("p"), me);
    else await drawBoard(box, q, me);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
