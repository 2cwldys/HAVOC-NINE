/*
 * P2P GAMES under the live table (servers/index.html): the games that players host from their own PC, with no port
 * forwarded, and that they chose to list (the server cvar h9_p2p_public). The list is h9web's p2p module's, GET
 * /api/p2p/public (h9web/README.txt, section 20); this script shows the section only when that route answers, so a
 * site without the module shows nothing here and never asks again. JOIN asks POST /api/p2p/public/join for a one-use
 * invite code (a signed-in visitor's account goes with it, because the request carries the site's cookie) and shows
 * it with the one line that joins: the launcher, h9_p2p_join, in the HAVOC 9 folder.
 *
 * Everything on screen is built with textContent: what a host named its game is never markup. Same-origin requests
 * only, no third-party script, no inline script; plain ES5 like servers.js.
 */
(function () {
  var board = document.getElementById("p2pBoard");
  if (!board || !window.fetch) return;
  var rows = document.getElementById("p2pRows");
  var codeBox = document.getElementById("p2pCode");
  var msg = document.getElementById("p2pMsg");
  var listUrl = (board.getAttribute("data-list") || "").trim();
  var joinUrl = (board.getAttribute("data-join") || "").trim();
  var refreshSeconds = Number(board.getAttribute("data-refresh")) || 15;
  if (!listUrl || !joinUrl) return;

  // the separator of the small print under a game's name: a middle dot, written as a code so that this file stays ASCII
  var DOT = " " + String.fromCharCode(183) + " ";
  var timer = null;
  var gone = false;
  var shown = [];

  function node(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // the same pictures as the live table's (servers.js thumbFor): a map without one falls back to the menu picture
  function thumbFor(map) {
    var safe = String(map || "").toLowerCase().replace(/[^a-z0-9_.+-]/g, "");
    return safe ? "../assets/maps/" + safe + ".png" : "../mainmenu.png";
  }

  function say(text, link) {
    msg.textContent = "";
    msg.hidden = !text;
    if (!text) return;
    msg.appendChild(document.createTextNode(text));
    if (link) {
      msg.appendChild(document.createTextNode(" "));
      var a = node("a", null, link.text);
      a.href = link.href;
      msg.appendChild(a);
    }
  }

  function render(list) {
    shown = list;
    rows.textContent = "";
    if (!list.length) {
      var tr0 = node("tr", "server-row-empty");
      var td0 = node("td", "servers-note", "No P2P games are listed right now. A host lists one with the server setting h9_p2p_public 1.");
      td0.colSpan = 4;
      tr0.appendChild(td0);
      rows.appendChild(tr0);
      return;
    }
    list.forEach(function (s, i) {
      var tr = node("tr", "server-row");
      tr.style.cursor = "default";

      var tdMap = node("td", "col-map");
      var cell = node("div", "map-cell");
      var img = node("img", "server-thumb");
      img.alt = "";
      img.src = thumbFor(s.map);
      cell.appendChild(img);
      cell.appendChild(node("span", "server-map", s.map || ""));
      tdMap.appendChild(cell);
      tr.appendChild(tdMap);

      var tdName = node("td", "col-server");
      tdName.appendChild(node("span", "server-name", s.name || "P2P game"));
      var tags = node("span", "server-addr");
      var bits = [];
      if (s.password) bits.push("password");
      if (s.account) bits.push("havoc9.org account needed");
      bits.push(s.direct ? "relay, direct allowed" : "relay");
      // on a phone the map column is gone and the map's name is on this line instead (servers/index.html, .p2p-mapline)
      if (s.map) tags.appendChild(node("span", "p2p-mapline", s.map + DOT));
      tags.appendChild(document.createTextNode(bits.join(DOT)));
      tdName.appendChild(tags);
      tr.appendChild(tdName);

      var tdPlayers = node("td", "col-players", (Number(s.players) || 0) + " / " + (Number(s.max) || 0));
      tr.appendChild(tdPlayers);

      var tdJoin = node("td", "col-ping");
      var b = node("button", "btn btn-ghost p2p-join", "JOIN");
      b.type = "button";
      b.setAttribute("data-index", String(i));
      tdJoin.appendChild(b);
      tr.appendChild(tdJoin);
      rows.appendChild(tr);
    });
  }

  function showCode(s, data) {
    codeBox.textContent = "";
    codeBox.hidden = false;
    codeBox.appendChild(node("div", "section-label", "// YOUR INVITE CODE FOR " + String(s.name || "P2P GAME").toUpperCase().slice(0, 64)));
    codeBox.appendChild(node("div", "p2p-code-value", data.code));
    var minutes = Math.max(1, Math.round((Number(data.ttl) || 600) / 60));
    codeBox.appendChild(node("p", "p2p-code-text", "One use, good for " + minutes + " minutes. In your HAVOC 9 folder run:"));
    var line = node("div", "p2p-code-line");
    line.appendChild(node("code", null, "h9_p2p_join.bat " + data.code));
    line.appendChild(document.createTextNode("  (Linux: "));
    line.appendChild(node("code", null, "./h9_p2p_join.sh " + data.code));
    line.appendChild(document.createTextNode(")"));
    codeBox.appendChild(line);
    codeBox.appendChild(node("p", "p2p-code-text", "It joins the game for you, or prints the one line to type in the game's console." + (data.password ? " This game has a password: ask its host." : "")));
    var copy = node("button", "btn btn-ghost p2p-join", "COPY CODE");
    copy.type = "button";
    copy.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.code).then(function () { copy.textContent = "COPIED"; }, function () { copy.textContent = "SELECT THE CODE ABOVE"; });
      } else {
        copy.textContent = "SELECT THE CODE ABOVE";
      }
    });
    codeBox.appendChild(copy);
    codeBox.scrollIntoView && codeBox.scrollIntoView({ block: "nearest" });
  }

  function join(index, button) {
    var s = shown[index];
    if (!s || !s.id) return;
    button.disabled = true;
    say("");
    fetch(joinUrl, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: s.id })
    }).then(function (r) {
      var retry = Number(r.headers.get("Retry-After")) || 0;
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data, retry: retry }; });
    }).then(function (res) {
      button.disabled = false;
      if (res.status === 200 && res.data && res.data.code) return showCode(s, res.data);
      if (res.status === 401) return say("This game needs a havoc9.org account. Sign in, then press JOIN again.", { text: "SIGN IN", href: "../account/login/index.html" });
      if (res.status === 429) return say("Slow down: try again in " + (res.retry || 60) + " seconds.");
      if (res.status === 404) { say("This game is not taking guests right now: it may have closed, or be full."); return refresh(); }
      say("The invite could not be made just now. Try again in a moment.");
    }).catch(function () {
      button.disabled = false;
      say("The invite could not be made just now. Try again in a moment.");
    });
  }

  rows.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button.p2p-join") : null;
    if (b) join(Number(b.getAttribute("data-index")), b);
  });

  function refresh() {
    if (gone) return;
    fetch(listUrl, { credentials: "same-origin" }).then(function (r) {
      if (r.status === 404 || r.status === 405 || r.status === 501) {
        // the module is not there (or its list is switched off): nothing to show, nothing to ask again
        gone = true;
        board.hidden = true;
        if (timer) clearInterval(timer);
        return null;
      }
      if (!r.ok) throw new Error("bad status");
      return r.json();
    }).then(function (data) {
      if (!data) return;
      board.hidden = false;
      render(Array.isArray(data.sessions) ? data.sessions : []);
    }).catch(function () {
      // a failed poll leaves what was on screen, as the live table does
    });
  }

  refresh();
  timer = setInterval(refresh, refreshSeconds * 1000);
})();
