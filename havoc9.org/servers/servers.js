    /*
     * The live table above. Points at the JSON list data-master names (h9web's /api/servers,
     * in the shape of serverlist-bot's GET /v1/servers/<gamedir>.json) and redraws every
     * data-refresh seconds, so the page never needs a reload to catch a server coming up,
     * a map changing, or someone joining.
     *
     * Deliberately not fetching the plain-text /v1/servers/<gamedir> list this page used
     * to read: that format has no fields for mode or ping, only a server's connect
     * address and a human comment line -- a table with real columns needs the bot's own
     * .json list instead.
     */
    (function () {
      var board = document.getElementById("serverBoard");
      var rows = document.getElementById("serverRows");
      var url = (board && board.getAttribute("data-master") || "").trim();
      var refreshSeconds = Number(board && board.getAttribute("data-refresh")) || 30;
      if (!url) {
        // Left unconfigured on purpose until a real list is reachable -- "Loading" would
        // otherwise sit there forever and look like a stuck fetch instead of a page
        // nobody has pointed at a bot yet. Set data-master on #serverBoard to fix it.
        if (rows) {
          rows.innerHTML = '<tr class="server-row-empty"><td colspan="5" class="servers-note">'
            + "Server list not configured yet.</td></tr>";
        }
        return;
      }

      function escapeHtml(text) {
        return String(text == null ? "" : text).replace(/[<>&"]/g, function (ch) {
          return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch];
        });
      }

      // H9's own map pictures, the ones Discord Rich Presence shows (cl_presence.c sends the
      // bare map name as the "large_image" asset): presence\maps\<map>.png, copied into
      // assets/maps/ at 256 x 256 by sync_map_pictures.ps1, which export.bat runs. The files
      // are named in lowercase, so the map name is too. A map with no picture falls back to
      // the menu background (the img's onerror below).
      function thumbFor(map) {
        var safe = String(map || "").toLowerCase().replace(/[^a-z0-9_.+-]/g, "");
        return safe ? "../assets/maps/" + safe + ".png" : "../mainmenu.png";
      }

      // Roleplay maps, named as the engine's Discord card names them (H9P_Mode in
      // engine/client/cl_presence.c, from xash3d-h9-patches\patches\engine-h9-presence.patch)
      // and h9web does (modeFor() in h9web/modules/presence/modes.js): rp_ or tsrp_ at the
      // start, or _rp_ or _tsrp_ anywhere (h9_tsrp_, h9_rp_), in any case.
      function isRoleplayMap(map) {
        var m = String(map || "").toLowerCase();
        return m.indexOf("rp_") === 0 || m.indexOf("tsrp_") === 0 || m.indexOf("_rp_") !== -1 || m.indexOf("_tsrp_") !== -1;
      }

      // TS's own game descriptions ("The Specialists", "The Specialists (DM)" and the like) say
      // nothing about the map, so on a roleplay map they show as Roleplay. Any other description
      // is the server's own (an H9 server's "Roleplay", "Match Mode", "Siege") and always wins.
      function modeFor(s) {
        var mode = String(s.mode || "").trim();
        var stock = !mode || /^the specialists(\s*\(.*\))?$/i.test(mode);
        if (stock && isRoleplayMap(s.map)) return "Roleplay";
        return mode || (s.kind === "gs" ? "GoldSrc" : "Xash");
      }

      function pingText(ms) {
        if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "&ndash;";
        return Math.round(ms) + " ms";
      }

      function pingClass(ms) {
        if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
        if (ms < 80) return "ping-good";
        if (ms < 160) return "ping-ok";
        return "ping-bad";
      }

      function render(servers) {
        if (!servers.length) {
          rows.innerHTML = '<tr class="server-row-empty"><td colspan="5" class="servers-note" id="serverEmpty">'
            + "No servers indexed yet. The list fills when the bot reports live addresses.</td></tr>";
          return;
        }

        // Answering servers first, most populated first -- the server worth joining is the one
        // with people on it. One that stopped answering (online: false) comes last, greyed.
        servers = servers.slice().sort(function (a, b) {
          return ((a.online === false) - (b.online === false)) || (b.players || 0) - (a.players || 0);
        });

        shown = servers;
        rows.innerHTML = servers.map(function (s) {
          var mode = modeFor(s);
          var siege = /siege/i.test(mode);
          var down = s.online === false;
          var open = !!openRows[s.address];
          return (
            '<tr class="server-row' + (down ? " server-row-offline" : "") + '" data-address="' + escapeHtml(s.address) + '"' +
              ' tabindex="0" aria-expanded="' + (open ? "true" : "false") + '" title="Who is playing here">' +
              '<td class="col-map"><div class="map-cell">' +
                '<img class="server-thumb" src="' + thumbFor(s.map) + '" alt=""' +
                  '>' +
                '<span class="server-map">' + escapeHtml(s.map) + "</span>" +
              "</div></td>" +
              '<td class="col-server">' +
                '<span class="server-name">' + chainFor(s) + (s.requireAccount ? LOCK : "") + escapeHtml(s.name || "HAVOC 9 server") + "</span>" +
                '<span class="server-addr">connect ' + escapeHtml(s.address) + unrankedTag(s) + "</span>" +
              "</td>" +
              '<td class="col-mode"><span class="mode-tag' + (siege ? " mode-siege" : "") + '">'
                + escapeHtml(mode) + "</span></td>" +
              '<td class="col-players">' + (down ? "OFFLINE" : playersText(s)) + "</td>" +
              '<td class="col-ping"><span class="' + pingClass(s.ping_ms) + '">' + pingText(down ? null : s.ping_ms) + "</span></td>" +
            "</tr>"
          );
        }).join("");
        drawDetails();
      }

      // The chain: green while havoc9.org vouches for the server (it reports with a live key and runs H9's
      // official preset, or it is on a roleplay map, where that check does not apply), red and broken when it
      // does not. h9web says which in auth (ok, rp, mod or off); an h9web that does not say draws no chain.
      var CHAIN_WHOLE = '<rect x="2" y="8" width="12" height="8" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
        '<rect x="10" y="8" width="12" height="8" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/>';
      var CHAIN_BROKEN = '<rect x="1" y="8" width="9" height="8" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
        '<rect x="14" y="8" width="9" height="8" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
        '<path d="M11.5 5.5l1 3M12.5 18.5l-1-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
      var CHAIN_TEXT = {
        ok: "Authenticated: connected to havoc9.org and running H9's official preset",
        rp: "Authenticated: connected to havoc9.org. A roleplay map: nothing here is ranked",
        mod: "Not authenticated (modified): it runs something beside H9's official preset, so its matches are not ranked",
        opt: "Not authenticated: its operator chose it (h9_authenticated 0), so its matches are not ranked",
        off: "Not authenticated: this server does not report to havoc9.org, so its matches are not ranked"
      };
      function chainFor(s) {
        if (!CHAIN_TEXT[s.auth]) return "";
        var good = s.auth === "ok" || s.auth === "rp";
        return '<svg class="server-chain ' + (good ? "server-chain-ok" : "server-chain-bad") + '" viewBox="0 0 24 24" role="img" aria-label="' +
          (good ? "Authenticated" : "Not authenticated") + '"><title>' + escapeHtml(CHAIN_TEXT[s.auth]) + "</title>" +
          (good ? CHAIN_WHOLE : CHAIN_BROKEN) + "</svg>";
      }
      function unrankedTag(s) {
        return s.auth === "rp" ? ' <span class="server-unranked">UNRANKED: roleplay</span>' : "";
      }

      // A havoc9.org account is required to play there (its rules' h9_require_account 1).
      var LOCK = '<svg class="server-lock" viewBox="0 0 24 24" role="img" aria-label="Account required">' +
        '<title>A havoc9.org account is required to play here</title>' +
        '<path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>';

      // People and bots apart: A2S_INFO counts bots among the players.
      function humansOf(s) {
        return Math.max(0, (Number(s.players) || 0) - (Number(s.bots) || 0));
      }
      function playersText(s) {
        var bots = Number(s.bots) || 0;
        return humansOf(s) + " / " + (Number(s.max) || 0) + (bots > 0 ? ' <span class="server-bots">+' + bots + " bots</span>" : "");
      }

      // ---- a row's details: its havoc9.org players (h9web's presence, /api/presence/now), joined by
      // the server's address, with their minutes and the map's picture. Built with textContent.
      var openRows = {};
      var shown = [];
      var now = null;
      var nowUrl = "/api/presence/now";

      function fetchNow() {
        return fetch(nowUrl, { credentials: "same-origin" })
          .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
          .then(function (data) { now = data; })
          .catch(function () { /* the details say they could not be read */ });
      }

      function node(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
      }

      function detailsFor(s) {
        var box = node("div", "server-detail");
        var pic = node("img", "server-detail-pic");
        pic.alt = "";
        pic.src = thumbFor(s.map);
        pic.onerror = function () { this.onerror = null; this.src = "../mainmenu.png"; };
        box.appendChild(pic);
        var text = node("div", "server-detail-text");
        text.appendChild(node("strong", null, (s.map || "") + (modeFor(s) ? " (" + modeFor(s) + ")" : "")));
        var bots = Number(s.bots) || 0;
        text.appendChild(node("span", "h9-dim", s.online === false ? "Not answering right now." :
          humansOf(s) + " of " + (Number(s.max) || 0) + " playing" + (bots ? ", and " + bots + (bots === 1 ? " bot" : " bots") : "") + "."));
        var entry = null;
        var list = now && Array.isArray(now.servers) ? now.servers : [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].server && list[i].server.address === s.address) entry = list[i];
        }
        var players = entry && Array.isArray(entry.players) ? entry.players : [];
        if (!now) {
          text.appendChild(node("span", "h9-dim", "Who is playing could not be read just now."));
        } else if (!players.length) {
          text.appendChild(node("span", "h9-dim", "No havoc9.org players here right now" + (humansOf(s) ? ": everyone here plays without an account, or keeps it to themselves." : ".")));
        } else {
          var ul = node("ul", "server-detail-list");
          players.forEach(function (p) {
            var li = node("li");
            var a = node("a", null, p.username);
            a.href = "../forum/user/?u=" + encodeURIComponent(p.username);
            li.appendChild(a);
            li.appendChild(node("span", null, p.verified === false ? "unverified" : typeof p.minutes === "number" ? p.minutes + " min" : ""));
            ul.appendChild(li);
          });
          text.appendChild(ul);
          var others = humansOf(s) - players.length;
          if (others > 0) text.appendChild(node("span", "h9-dim", "and " + others + (others === 1 ? " other player" : " other players") + " without a havoc9.org account on show."));
        }
        text.appendChild(node("span", "h9-dim", "connect " + s.address));
        box.appendChild(text);
        return box;
      }

      // Puts each open row's details under it, after every redraw of the table.
      function drawDetails() {
        var trs = rows.querySelectorAll("tr.server-row");
        for (var i = 0; i < trs.length; i++) {
          var address = trs[i].getAttribute("data-address");
          if (!openRows[address]) continue;
          var s = null;
          for (var j = 0; j < shown.length; j++) if (shown[j].address === address) s = shown[j];
          if (!s) continue;
          var tr = node("tr", "server-details");
          var td = node("td");
          td.colSpan = 5;
          td.appendChild(detailsFor(s));
          tr.appendChild(td);
          trs[i].parentNode.insertBefore(tr, trs[i].nextSibling);
        }
      }

      function toggle(tr) {
        var address = tr && tr.getAttribute("data-address");
        if (!address) return;
        if (openRows[address]) delete openRows[address];
        else openRows[address] = true;
        render(shown);
        if (openRows[address]) fetchNow().then(function () { render(shown); });
      }

      rows.addEventListener("click", function (e) {
        var tr = e.target && e.target.closest ? e.target.closest("tr.server-row") : null;
        if (tr && !(e.target.closest && e.target.closest("a"))) toggle(tr);
      });
      rows.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var tr = e.target && e.target.closest ? e.target.closest("tr.server-row") : null;
        if (!tr) return;
        e.preventDefault();
        toggle(tr);
      });

      function refresh() {
        var open = Object.keys(openRows).length > 0;
        Promise.all([fetch(url).then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); }), open ? fetchNow() : null])
          .then(function (got) { var data = got[0]; render(Array.isArray(data.servers) ? data.servers : []); })
          .catch(function () {
            // A failed poll leaves whatever was already on screen rather than blanking a
            // table that was working a moment ago over one dropped request.
          });
      }

      refresh();
      setInterval(refresh, refreshSeconds * 1000);
    })();

(function () {
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (img && img.tagName === "IMG" && img.className === "server-thumb" && !img.dataset.fallback) {
      img.dataset.fallback = "1";
      img.src = "../mainmenu.png";
    }
  }, true);
})();
