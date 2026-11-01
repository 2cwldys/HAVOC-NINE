// HAVOC9: who is in game, on the site. Reads h9web's presence module (/api/presence/...) and
// draws into any element marked data-h9-presence:
//
//   data-h9-presence="now"                        who's playing: each server, its map picture,
//                                                 "<map> (<mode>)", and the players on it
//   data-h9-presence="online"                     online now: one line, how many in game, in the
//                                                 web client and on the site, and who
//   data-h9-presence="author" data-h9-user="Neo"  a forum post's author: a dot and the state
//                                                 ("PLAYING ON <server> / <map> (<mode>) / <n>
//                                                 MIN", "IN THE WEB CLIENT", "ON THE SITE", "LAST
//                                                 SEEN ..."), the badge, playtime. Every author on
//                                                 the page comes from one request
//   data-h9-presence="card" data-h9-user="Neo"    one player's full card
//   data-h9-presence="account"                    the signed-in player's own: state, playtime,
//                                                 badge and sessions, whatever its switches say
//   data-h9-presence-settings                     the privacy switches (ACCOUNT page): in game,
//                                                 which server and map, web client, site,
//                                                 playtime, last seen; each saved on change
//   data-h9-card="Neo" on any element             a click opens Neo's card in a dialog (a click
//                                                 with Ctrl, Shift, Cmd or the middle button
//                                                 still follows a link)
//   data-h9-refresh="30"                          on a "now" or "online" element: seconds between
//                                                 redraws (default 30, at least 15)
//
// Elements added later (a forum thread drawn after its fetch) are filled as they appear. The
// server applies each player's privacy switches before anything reaches the page: what a player
// hides never arrives. A map with no picture on the site is shown as text, as the Discord card
// does. An unverified sighting (a game that did not prove the player id) is marked so.
//
// For other scripts, window.H9Presence:
//   fetchAccounts(names) -> Promise<Map(lowercase name -> view or null)>   batched, cached 15 s
//   fetchAccount(name) / fetchNow() / fetchMe()
//   renderAuthor(view) -> element or null       renderCard(view) -> element
//   renderNow(data) / renderOnline(data) / renderAccount(me) -> element
//   fetchSettings() / renderSettings(data)      the privacy switches
//   decorate(root) -> Promise                   fills every data-h9-presence element in root
//   openCard(name) / closeCard()                the card dialog
//   playingText(playing) -> "Playing on HAVOC 9 / h9_te_neuropolis (Team Elimination) / 25 min"
//   duration(seconds) -> "3h 05m"
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = new URL("api/presence/", root);
  const DOT = " " + String.fromCharCode(183) + " ";
  const TTL = 15000;
  const BATCH = 50;
  // What "unverified" means, for its tooltips.
  const UNVERIFIED = "This game did not prove it holds the player's id (an older H9XASH, or someone using a copied id). It shows, but counts for nothing.";

  const STYLE = [
    ".h9p-dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;background:var(--text-muted,#5c4538);margin-right:.45em;vertical-align:middle;flex-shrink:0}",
    ".is-online>.h9p-dot,.h9p-dot.is-online{background:#2ecc71;box-shadow:0 0 8px rgba(46,204,113,.6)}",
    ".h9p-dot.is-web{background:#4aa3df;box-shadow:0 0 8px rgba(74,163,223,.55)}",
    ".h9p-dot.is-site{background:var(--orange,#ff4d00);box-shadow:0 0 8px var(--orange-glow,rgba(255,77,0,.35))}",
    ".h9p-status.is-web{color:#4aa3df}.h9p-status.is-site{color:var(--orange,#ff4d00)}",
    ".h9p-settings{display:flex;flex-direction:column;gap:.9rem;max-width:640px;margin:0 auto}",
    ".h9p-switch-label{display:block}",
    ".h9p-switch-help{display:block;margin-top:.15rem;font-family:var(--font-body,sans-serif);font-size:.95rem;letter-spacing:0;color:var(--text-dim,#9a7f6e)}",
    ".h9p-settings .h9p-switch{align-items:flex-start}.h9p-settings .h9p-switch input{margin-top:.15rem;flex-shrink:0}",
    ".h9p-badge{display:inline-block;font-family:var(--font-mono,monospace);font-size:.7rem;letter-spacing:.12em;color:var(--orange,#ff4d00);",
    "border:1px solid var(--border,rgba(255,77,0,.25));padding:.05rem .4rem;white-space:nowrap}",
    ".h9p-author{display:flex;flex-direction:column;gap:.2rem;margin-top:.15rem;font-family:var(--font-mono,monospace);font-size:.72rem;",
    "letter-spacing:.06em;color:var(--text-dim,#9a7f6e);min-width:0}",
    ".h9p-author .h9p-status{color:#2ecc71;display:flex;align-items:center}",
    ".h9p-author .h9p-where,.h9p-card .h9p-where{color:var(--text-dim,#9a7f6e);overflow-wrap:anywhere}",
    ".h9p-author .h9p-line{display:flex;flex-wrap:wrap;gap:.3rem .5rem;align-items:center}",
    ".h9p-card{background:var(--bg-card,#1a0f14);border:1px solid var(--border,rgba(255,77,0,.25));color:var(--text,#e8d5c4);overflow:hidden}",
    ".h9p-card-pic{display:block;width:100%;aspect-ratio:1024/560;max-height:220px;object-fit:cover;border-bottom:1px solid var(--border,rgba(255,77,0,.25));background:var(--bg,#0a0608)}",
    ".h9p-card-body{padding:1.1rem 1.25rem 1.25rem;display:flex;flex-direction:column;gap:.75rem}",
    ".h9p-card-head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem}",
    ".h9p-card-name{font-family:var(--font-display,sans-serif);font-size:1.15rem;letter-spacing:.06em;color:#fff;overflow-wrap:anywhere}",
    ".h9p-card .h9p-status{font-family:var(--font-mono,monospace);font-size:.85rem;letter-spacing:.05em;display:flex;align-items:baseline;flex-wrap:wrap;color:var(--text,#e8d5c4)}",
    ".h9p-card .h9p-status.is-online{color:#2ecc71}",
    ".h9p-author .h9p-status.is-unverified,.h9p-card .h9p-status.is-unverified,.h9p-names .is-unverified{color:var(--text-dim,#9a7f6e)}",
    ".h9p-card .h9p-detail{font-family:var(--font-mono,monospace);font-size:.8rem;color:var(--text-dim,#9a7f6e)}",
    ".h9p-rows{max-width:none;margin:0}",
    ".h9p-rows .feature-row{grid-template-columns:110px 1fr;padding:.55rem .9rem;font-size:.85rem}",
    ".h9p-quiet{font-family:var(--font-mono,monospace);font-size:.85rem;color:var(--text-dim,#9a7f6e)}",
    ".h9p-links{display:flex;flex-wrap:wrap;gap:.75rem;font-family:var(--font-mono,monospace);font-size:.78rem;letter-spacing:.12em}",
    ".h9p-links a,.h9p-name{color:var(--orange,#ff4d00);text-decoration:none}",
    ".h9p-links a:hover,.h9p-name:hover{color:#fff}",
    ".h9p-now{display:flex;flex-direction:column;gap:1rem}",
    ".h9p-server{display:flex;gap:1rem;align-items:flex-start;padding:1rem;background:var(--bg-card,#1a0f14);border:1px solid var(--border,rgba(255,77,0,.25))}",
    ".h9p-thumb{width:112px;height:61px;object-fit:cover;flex-shrink:0;border:1px solid var(--border,rgba(255,77,0,.25));background:var(--bg,#0a0608)}",
    ".h9p-server-text{display:flex;flex-direction:column;gap:.25rem;min-width:0}",
    ".h9p-server-name{font-family:var(--font-display,sans-serif);font-size:.95rem;letter-spacing:.06em;color:#fff}",
    ".h9p-server-game{font-family:var(--font-mono,monospace);font-size:.85rem;color:var(--text-dim,#9a7f6e);overflow-wrap:anywhere}",
    ".h9p-names{list-style:none;display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin-top:.35rem;padding:0;font-family:var(--font-mono,monospace);font-size:.88rem}",
    ".h9p-names li{display:flex;align-items:center}",
    ".h9p-names .h9p-for{color:var(--text-muted,#5c4538);margin-left:.4rem;font-size:.78rem}",
    ".h9p-online{font-family:var(--font-mono,monospace);font-size:.85rem;letter-spacing:.08em;color:var(--text-dim,#9a7f6e)}",
    ".h9p-online .h9p-count{color:#2ecc71}",
    ".h9p-account{display:flex;flex-direction:column;gap:1rem;max-width:640px;margin:0 auto}",
    ".h9p-account .h9p-card .h9p-status{font-size:.9rem}",
    ".h9p-list{list-style:none;margin:0;padding:0;font-family:var(--font-mono,monospace);font-size:.82rem;color:var(--text-dim,#9a7f6e)}",
    ".h9p-list li{padding:.35rem 0;border-bottom:1px solid rgba(255,77,0,.12)}",
    ".h9p-list li:last-child{border-bottom:none}",
    ".h9p-sub{font-family:var(--font-mono,monospace);font-size:.75rem;letter-spacing:.18em;color:var(--orange,#ff4d00)}",
    ".h9p-switch{display:flex;align-items:center;gap:.6rem;font-family:var(--font-mono,monospace);font-size:.85rem;letter-spacing:.12em;color:var(--text,#e8d5c4);cursor:pointer}",
    ".h9p-switch input{width:1.1rem;height:1.1rem;accent-color:var(--orange,#ff4d00);cursor:pointer}",
    ".h9p-note{font-size:.95rem;line-height:1.5;color:var(--text-dim,#9a7f6e)}",
    ".h9p-note code{background:rgba(0,0,0,.35);padding:.1em .35em;font-family:var(--font-mono,monospace);font-size:.9em;color:var(--orange,#ff4d00)}",
    ".h9p-error{min-height:1.2em;font-family:var(--font-mono,monospace);font-size:.82rem;color:#e0603f}",
    ".h9p-modal{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(10,6,8,.78);backdrop-filter:blur(4px)}",
    ".h9p-modal-box{position:relative;width:min(520px,100%);max-height:calc(100vh - 2rem);overflow:auto;box-shadow:0 0 32px rgba(255,77,0,.18)}",
    ".h9p-modal-close{position:absolute;top:.5rem;right:.5rem;z-index:1;font-family:var(--font-mono,monospace);font-size:.72rem;letter-spacing:.15em;",
    "padding:.35rem .6rem;background:rgba(10,6,8,.85);color:var(--text,#e8d5c4);border:1px solid var(--border,rgba(255,77,0,.25));cursor:pointer}",
    ".h9p-modal-close:hover,.h9p-modal-close:focus-visible{color:var(--orange,#ff4d00);border-color:var(--orange,#ff4d00)}",
    "[data-h9-card]{cursor:pointer}",
    "@media (max-width:560px){.h9p-server{flex-direction:column}.h9p-thumb{width:100%;height:auto;aspect-ratio:1024/560}}",
  ].join("");

  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // ---- small helpers ------------------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }

  function duration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return s ? "<1m" : "0m";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + String(m % 60).padStart(2, "0") + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  }

  function since(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : 0;
  }

  function ago(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400 * 2) return Math.round(s / 3600) + " h ago";
    if (s < 86400 * 30) return Math.round(s / 86400) + " days ago";
    return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function day(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  }

  // "h9_te_neuropolis (Team Elimination)", the map and the mode as the Discord card names them
  function gameText(g) {
    if (!g) return "";
    if (g.map && g.mode) return g.map + " (" + g.mode + ")";
    return g.map || g.mode || "";
  }

  // The mode's progress, the Discord card's details line ("Siege - Insurgents attacking: 2 of 5
  // objectives"), when it says more than the mode's name.
  function progress(g) {
    return g && g.detail && g.detail !== g.mode ? g.detail : "";
  }

  // "Playing on HAVOC 9 / h9_te_neuropolis (Team Elimination) / 25 min"
  function playingText(playing) {
    if (!playing) return "";
    const parts = [playing.server ? "Playing on " + playing.server.name : "In game"];
    if (playing.server && gameText(playing)) parts.push(gameText(playing));
    if (typeof playing.minutes === "number") parts.push(playing.minutes + " min");
    return parts.join(" / ");
  }

  function profileHref(name) {
    const u = new URL("forum/user/", root);
    u.searchParams.set("u", name);
    return u.href;
  }

  // A player's name: a link to their forum profile that opens their card.
  function nameLink(name, className) {
    return el("a", { class: className || "h9p-name", href: profileHref(name), "data-h9-card": name, text: name });
  }

  // A map picture, or nothing: one that fails to load takes itself away and leaves the text.
  function picture(url, className) {
    if (!url) return null;
    const img = el("img", { class: className, src: new URL(url, root).href, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.remove(), { once: true });
    return img;
  }

  function badge(view) {
    return view && view.badge ? el("span", { class: "h9p-badge", title: "Seen in game with this account", text: "PLAYS IN GAME" }) : null;
  }

  // ---- reading the API ----------------------------------------------------------------------------

  function getJson(path, opts) {
    return fetch(new URL(path, api), { credentials: "same-origin", headers: { Accept: "application/json" }, ...(opts || {}) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))));
  }

  const accounts = new Map(); // lowercase name -> { at, view } or { promise }

  // Every name's view, in as few requests as the server's cap allows; a name read in the last
  // 15 seconds is not asked again. Unknown names, and names that could not be read, are null.
  async function fetchAccounts(names) {
    const want = [];
    const keys = [];
    const seen = new Set();
    for (const raw of names || []) {
      const name = String(raw || "").trim();
      const k = name.toLowerCase();
      if (!name || name.length > 64 || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
      const c = accounts.get(k);
      if (!c || (!c.promise && Date.now() - c.at > TTL)) want.push({ name, k });
    }
    for (let i = 0; i < want.length; i += BATCH) {
      const chunk = want.slice(i, i + BATCH);
      const done = (data) => {
        const got = (data && data.accounts) || {};
        for (const x of chunk) accounts.set(x.k, { at: Date.now(), view: got[x.name] || null });
      };
      const promise = getJson("accounts?u=" + chunk.map((x) => encodeURIComponent(x.name)).join(",")).then(done, () => done(null));
      for (const x of chunk) accounts.set(x.k, { promise });
    }
    await Promise.all(keys.map((k) => accounts.get(k) && accounts.get(k).promise).filter(Boolean));
    const out = new Map();
    for (const k of keys) {
      const c = accounts.get(k);
      out.set(k, c && !c.promise ? c.view : null);
    }
    if (accounts.size > 2000) accounts.clear();
    return out;
  }

  function fetchAccount(name) {
    return getJson("account/" + encodeURIComponent(String(name || "").trim())).catch(() => null);
  }

  function fetchNow() {
    return getJson("now").catch(() => null);
  }

  function fetchMe() {
    return getJson("me", { cache: "no-store" }).catch(() => null);
  }

  // ---- drawing ------------------------------------------------------------------------------------

  // A state's words, in capitals for the small mono lines and the card's status:
  //   game     PLAYING ON <server> / <map> (<mode>) / <n> MIN   (IN GAME / <n> MIN when the
  //            player hides which server)
  //   web      IN THE WEB CLIENT
  //   site     ON THE SITE
  //   offline  LAST SEEN <time> AGO, or nothing when the player hides it
  function stateText(view) {
    if (!view) return "";
    if (view.state === "game" && view.playing) {
      const p = view.playing;
      const parts = p.server ? ["PLAYING ON " + p.server.name] : ["IN GAME"];
      if (p.server && gameText(p)) parts.push(gameText(p));
      if (typeof p.minutes === "number") parts.push(p.minutes + " MIN");
      return parts.join(" / ") + (p.verified === false ? DOT + "UNVERIFIED" : "");
    }
    if (view.state === "web") return "IN THE WEB CLIENT";
    if (view.state === "site") return "ON THE SITE";
    if (view.lastSeen) return "LAST SEEN " + ago(view.lastSeen).toUpperCase();
    return "";
  }

  function dot(view) {
    const cls = { game: view.playing && view.playing.verified === false ? "h9p-dot" : "h9p-dot is-online", web: "h9p-dot is-web", site: "h9p-dot is-site" }[view.state];
    return el("i", { class: cls || "h9p-dot" });
  }

  function statusClass(view) {
    if (view.state === "game") return view.playing && view.playing.verified === false ? "h9p-status is-unverified" : "h9p-status is-online";
    return "h9p-status is-" + view.state;
  }

  // A forum author's line: nothing for a player with nothing to show.
  function renderAuthor(view) {
    if (!view) return null;
    const text = stateText(view);
    const line = el("span", { class: "h9p-line" }, badge(view),
      view.playtimeSeconds > 0 ? el("span", { text: duration(view.playtimeSeconds).toUpperCase() + " PLAYED" }) : null);
    if (!text && !line.childNodes.length) return null;
    style();
    const box = el("span", { class: "h9p-author" });
    if (text) {
      box.append(el("span", { class: statusClass(view), title: view.playing && view.playing.verified === false ? UNVERIFIED : progress(view.playing) || null },
        dot(view), text));
    }
    if (line.childNodes.length) box.append(line);
    return box;
  }

  function statusLine(view) {
    const text = stateText(view);
    // with the playtime shown, a zero means never; hidden, it says nothing either way
    if (!text) return el("div", { class: "h9p-status" }, el("i", { class: "h9p-dot" }), view.playtimeSeconds === 0 && !view.badge ? "NOT SEEN IN GAME YET" : "OFFLINE");
    return el("div", { class: statusClass(view), title: view.playing && view.playing.verified === false ? UNVERIFIED : null }, dot(view), text);
  }

  function rows(list) {
    return el("div", { class: "feature-list h9p-rows" }, list.filter(Boolean).map(([k, v]) =>
      el("div", { class: "feature-row" }, el("span", { class: "feature-label", text: k }), el("span", { class: "feature-value", text: v }))));
  }

  // One player's full card (the dialog, a profile page).
  function renderCard(view, { name } = {}) {
    style();
    const card = el("div", { class: "h9p-card" });
    const username = (view && view.username) || name || "";
    if (view && view.state === "game" && view.playing) card.append(picture(view.playing.mapPicture, "h9p-card-pic") || "");
    const body = el("div", { class: "h9p-card-body" });
    card.append(body);
    body.append(el("div", { class: "h9p-card-head" }, el("span", { class: "h9p-card-name", text: username }), badge(view)));
    if (!view) {
      body.append(el("p", { class: "h9p-quiet", text: "No such player, or the site could not be reached." }));
      return card;
    }
    body.append(statusLine(view));
    const detail = view.state === "game" ? progress(view.playing) : "";
    if (detail) body.append(el("div", { class: "h9p-detail", text: detail }));
    const top = Array.isArray(view.servers) && view.servers.length ? view.servers[0] : null;
    const facts = [
      view.playtimeSeconds !== null && view.playtimeSeconds !== undefined ? ["PLAYTIME", duration(view.playtimeSeconds)] : null,
      view.firstSeen ? ["FIRST SEEN", day(view.firstSeen)] : null,
      top ? ["MOST PLAYED", top.server.name + DOT + duration(top.seconds)] : null,
    ];
    if (facts.some(Boolean)) body.append(rows(facts));
    body.append(el("div", { class: "h9p-links" }, el("a", { href: profileHref(username), text: "FORUM PROFILE" })));
    return card;
  }

  // Who's playing: each server with its picture, "<map> (<mode>)" and its players; then the
  // players in game somewhere they keep to themselves, and who is in the web client or on the site.
  function renderNow(data) {
    style();
    const box = el("div", { class: "h9p-now" });
    const servers = data && Array.isArray(data.servers) ? data.servers : [];
    const elsewhere = (data && data.elsewhere) || [];
    if (!servers.length && !elsewhere.length) {
      box.append(el("p", { class: "h9p-quiet", text: data ? "Nobody with a havoc9.org account is in game right now." : "Who's playing could not be read just now." }));
    }
    const who = (p) => el("li", p.verified === false ? { class: "is-unverified", title: UNVERIFIED } : null,
      el("i", { class: p.verified === false ? "h9p-dot" : "h9p-dot is-online" }), nameLink(p.username),
      el("span", { class: "h9p-for", text: p.verified === false ? "unverified" : typeof p.minutes === "number" ? p.minutes + " min" : "" }));
    for (const s of servers) {
      box.append(el("div", { class: "h9p-server" }, picture(s.mapPicture, "h9p-thumb"),
        el("div", { class: "h9p-server-text" },
          el("span", { class: "h9p-server-name", text: s.server.name }),
          gameText(s) ? el("span", { class: "h9p-server-game", text: gameText(s) }) : null,
          progress(s) ? el("span", { class: "h9p-server-game", text: progress(s) }) : null,
          el("ul", { class: "h9p-names" }, s.players.map(who)))));
    }
    if (elsewhere.length) {
      box.append(el("div", { class: "h9p-server" }, el("div", { class: "h9p-server-text" },
        el("span", { class: "h9p-server-name", text: "In game" }),
        el("span", { class: "h9p-server-game", text: "on a server they keep to themselves" }),
        el("ul", { class: "h9p-names" }, elsewhere.map(who)))));
    }
    for (const [list, label, cls] of [[data && data.web, "IN THE WEB CLIENT", "is-web"], [data && data.site, "ON THE SITE", "is-site"]]) {
      if (!list || !list.length) continue;
      const line = el("div", { class: "h9p-online" }, el("i", { class: "h9p-dot " + cls }), label + ": ");
      list.forEach((p, i) => {
        if (i) line.append(", ");
        line.append(nameLink(p.username));
      });
      box.append(line);
    }
    return box;
  }

  // Online now: one line, everyone in game, in the web client and on the site.
  function renderOnline(data) {
    style();
    const line = el("div", { class: "h9p-online" });
    if (!data) return line;
    const game = [];
    for (const s of data.servers || []) for (const p of s.players) game.push(p.username);
    for (const p of data.elsewhere || []) game.push(p.username);
    const web = (data.web || []).map((p) => p.username);
    const site = (data.site || []).map((p) => p.username);
    if (!game.length && !web.length && !site.length) {
      line.append(el("i", { class: "h9p-dot" }), "NOBODY ONLINE RIGHT NOW");
      return line;
    }
    const counts = [[game, "IN GAME", "is-online"], [web, "IN THE WEB CLIENT", "is-web"], [site, "ON THE SITE", "is-site"]].filter(([l]) => l.length);
    counts.forEach(([l, label, cls], i) => {
      if (i) line.append(DOT);
      line.append(el("i", { class: "h9p-dot " + cls }), el("span", { class: "h9p-count", text: l.length + " " + label }));
    });
    line.append(": ");
    [...game, ...web, ...site].forEach((n, i) => {
      if (i) line.append(", ");
      line.append(nameLink(n));
    });
    return line;
  }

  // The signed-in player's own presence: everything, whatever the privacy switches say.
  function renderAccount(me) {
    style();
    const box = el("div", { class: "h9p-account" });
    if (!me) return box;
    const online = me.online || [];
    // the place that counts first, then held ones, then unverified ones
    const order = { counted: 0, held: 1, unverified: 2 };
    online.sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3));
    const view = { username: me.username, state: me.state, badge: me.badge, playing: online[0] || null,
      playtimeSeconds: me.playtimeSeconds, lastSeen: me.lastSeen, firstSeen: me.firstSeen, servers: me.servers || [] };
    const card = renderCard(view);
    box.append(card);
    const body = card.querySelector(".h9p-card-body");
    for (const p of online) {
      const bits = [p === view.playing ? "" : stateText({ state: "game", playing: p })];
      if (p.name) bits.push("as " + p.name);
      if (p.via === "web") bits.push("in the browser");
      if (p.via === "game") bits.push("in the game");
      if (!p.listed) bits.push("on an unlisted server, which never shows to anyone else");
      if (p.state === "held") bits.push("not counted: you are counted on another server at the same time (an admin sees this)");
      if (p.state === "unverified") bits.push("not counted: this game did not prove your player id; it needs an H9XASH that answers the server's check");
      const text = bits.filter(Boolean).join(DOT);
      if (text) body.append(el("div", { class: "h9p-detail", text }));
    }
    if ((me.sessions || []).length) {
      body.append(el("span", { class: "h9p-sub", text: "LATEST SESSIONS" }));
      body.append(el("ul", { class: "h9p-list" }, me.sessions.slice(0, 5).map((x) =>
        el("li", { text: x.server.name + DOT + duration(x.seconds) + DOT + ago(x.ended) + (x.name ? DOT + "as " + x.name : "") + (x.via === "web" ? DOT + "in the browser" : "") }))));
    }
    if (!me.badge) {
      body.append(el("p", { class: "h9p-note" },
        "A server knows you by your player id. In the browser that happens by itself. In the downloaded game, run ",
        el("code", { text: "enter_userid.cmd" }), " in the H9XASH folder and paste your player id (COPY on the PLAYER ID line at the top of this page); your next game is then counted here."));
    }
    return box;
  }

  // The privacy switches, for the ACCOUNT page: each saved as soon as it is changed.
  const SWITCHES = [
    ["game", "SHOW THAT I'M IN GAME", "Others see when you are in game on an H9 server."],
    ["where", "SHOW WHICH SERVER AND MAP", "With the above: which server, map and mode, with the map's picture."],
    ["web", "SHOW WHEN I'M IN THE WEB CLIENT", "Others see when the web client is open and you are in its menu."],
    ["site", "SHOW WHEN I'M ON THE SITE", "Others see when you used havoc9.org in the last few minutes, signed in."],
    ["playtime", "SHOW MY PLAYTIME", "Your playtime and the PLAYS IN GAME badge."],
    ["lastSeen", "SHOW \"LAST SEEN\"", "When you are none of the above: when you were last seen, in what you show."],
  ];

  function renderSettings(data) {
    style();
    const box = el("div", { class: "h9p-settings" });
    if (!data || !data.privacy) {
      box.append(el("p", { class: "h9p-quiet", text: data === null ? "Sign in to choose what others see of you." : "Your settings could not be read just now." }));
      return box;
    }
    const error = el("p", { class: "h9p-error", role: "alert" });
    for (const [key, label, help] of SWITCHES) {
      const input = el("input", { type: "checkbox" });
      input.checked = !!data.privacy[key];
      input.addEventListener("change", async () => {
        const want = input.checked;
        input.disabled = true;
        error.textContent = "";
        try {
          const r = await fetch(new URL("settings", api), {
            method: "POST", credentials: "same-origin", cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ [key]: want }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.message || "Could not save that. Try again.");
          accounts.clear();
        } catch (e) {
          input.checked = !want;
          error.textContent = e.message || "Could not save that. Try again.";
        } finally {
          input.disabled = false;
        }
      });
      box.append(el("label", { class: "h9p-switch" }, input, el("span", null, el("span", { class: "h9p-switch-label", text: label }),
        el("span", { class: "h9p-switch-help", text: help }))));
    }
    const defaults = data.defaults || {};
    const off = SWITCHES.filter(([k]) => defaults[k] === false).map(([, label]) => label.toLowerCase());
    box.append(el("p", { class: "h9p-note", text: "You always see all of yours. New accounts start with " +
      (off.length ? "everything on but " + off.join(", ") : "everything on") + ". A change shows within a few seconds." }));
    box.append(error);
    return box;
  }

  function fetchSettings() {
    return fetch(new URL("settings", api), { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
      .then((r) => (r.status === 401 ? null : r.ok ? r.json() : undefined))
      .catch(() => undefined);
  }

  // ---- the card dialog ----------------------------------------------------------------------------

  let modal = null;
  let opener = null;

  function closeCard() {
    if (!modal) return;
    modal.remove();
    modal = null;
    document.removeEventListener("keydown", onKey, true);
    if (opener && typeof opener.focus === "function") opener.focus();
    opener = null;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCard();
    } else if (e.key === "Tab" && modal) {
      const focusable = modal.querySelectorAll("a[href],button");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  async function openCard(name) {
    name = String(name || "").trim();
    if (!name) return;
    style();
    closeCard();
    opener = document.activeElement;
    const content = el("div", null, el("div", { class: "h9p-card" }, el("div", { class: "h9p-card-body" }, el("span", { class: "h9p-quiet", text: "Loading " + name + "..." }))));
    const close = el("button", { type: "button", class: "h9p-modal-close", text: "CLOSE" });
    close.addEventListener("click", closeCard);
    const box = el("div", { class: "h9p-modal-box" }, close, content);
    modal = el("div", { class: "h9p-modal", role: "dialog", "aria-modal": "true", "aria-label": name + "'s player card" }, box);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeCard(); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(modal);
    close.focus();
    const mine = modal;
    const view = await fetchAccount(name);
    if (modal !== mine) return;
    content.replaceChildren(renderCard(view, { name }));
  }

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest("[data-h9-card]") : null;
    if (!target || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openCard(target.getAttribute("data-h9-card"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target instanceof Element ? e.target.closest("[data-h9-card]") : null;
    if (!target || target.tagName === "A" || target.tagName === "BUTTON") return;
    e.preventDefault();
    openCard(target.getAttribute("data-h9-card"));
  });

  // ---- filling the page ---------------------------------------------------------------------------

  const timers = new WeakMap();

  function refreshEvery(node, draw) {
    if (timers.has(node)) return;
    const seconds = Math.max(15, Number(node.getAttribute("data-h9-refresh")) || 30);
    const timer = setInterval(() => {
      if (!node.isConnected) {
        clearInterval(timer);
        timers.delete(node);
        return;
      }
      if (document.visibilityState === "visible") draw();
    }, seconds * 1000);
    timers.set(node, timer);
  }

  async function decorate(scope) {
    const base = scope && scope.querySelectorAll ? scope : document;
    const found = [...base.querySelectorAll("[data-h9-presence]")];
    if (base !== document && base.matches && base.matches("[data-h9-presence]")) found.unshift(base);
    const settings = [...base.querySelectorAll("[data-h9-presence-settings]")];
    if (base !== document && base.matches && base.matches("[data-h9-presence-settings]")) settings.unshift(base);
    if (!found.length && !settings.length) return;
    const of = (kind) => found.filter((n) => n.getAttribute("data-h9-presence") === kind);
    const work = [];

    const user = (n) => String(n.getAttribute("data-h9-user") || "").trim();
    const authors = of("author").filter(user);
    if (authors.length) {
      work.push(fetchAccounts(authors.map(user)).then((views) => {
        for (const n of authors) {
          const node = renderAuthor(views.get(user(n).toLowerCase()));
          n.replaceChildren(...(node ? [node] : []));
        }
      }));
    }
    for (const n of of("card").filter(user)) {
      work.push(fetchAccount(user(n)).then((v) => n.replaceChildren(renderCard(v, { name: user(n) }))));
    }

    const live = of("now").concat(of("online"));
    if (live.length) {
      const draw = () => fetchNow().then((data) => {
        for (const n of of("now")) if (data || !n.childNodes.length) n.replaceChildren(renderNow(data));
        for (const n of of("online")) if (data || !n.childNodes.length) n.replaceChildren(renderOnline(data));
      });
      work.push(draw());
      for (const n of live) refreshEvery(n, () => fetchNow().then((data) => {
        if (!data) return;
        n.replaceChildren(n.getAttribute("data-h9-presence") === "now" ? renderNow(data) : renderOnline(data));
      }));
    }

    if (of("account").length) {
      work.push(fetchMe().then((me) => {
        for (const n of of("account")) n.replaceChildren(renderAccount(me));
      }));
    }
    if (settings.length) {
      work.push(fetchSettings().then((data) => {
        for (const n of settings) n.replaceChildren(renderSettings(data));
      }));
    }
    await Promise.all(work);
  }

  // Elements drawn later by other scripts are filled once they are in the page.
  const HOOKS = "[data-h9-presence],[data-h9-presence-settings]";
  let queued = [];
  let pending = false;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(HOOKS) || node.querySelector(HOOKS)) queued.push(node);
      }
    }
    if (!queued.length || pending) return;
    pending = true;
    setTimeout(() => {
      const nodes = queued.filter((n) => n.isConnected && !queued.some((m) => m !== n && m.contains(n)));
      queued = [];
      pending = false;
      for (const n of nodes) decorate(n);
    }, 30);
  });

  function startPage() {
    decorate(document);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.H9Presence = {
    fetchAccounts, fetchAccount, fetchNow, fetchMe,
    fetchSettings, renderSettings,
    renderAuthor, renderCard, renderNow, renderOnline, renderAccount,
    decorate, openCard, closeCard, playingText, duration,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startPage, { once: true });
  else startPage();
})();
