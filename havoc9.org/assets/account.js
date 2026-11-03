// HAVOC9: who is signed in, shown in every page's nav.
//
// Every page loads this after script.js. It asks the account service once (GET /api/me) and adds
// to the nav: SIGN IN and CREATE ACCOUNT when nobody is signed in; the username, ACCOUNT and
// LOG OUT when someone is, and ADMIN for moderators and admins (a link only: the server checks
// every request the admin panel makes). A page without the nav (#navLinks) gets the same in any element marked
// data-h9-account. When the service does not answer (or the page is opened as a file), the nav
// stays as it is.
//
// window.h9account = { root, me } lets other scripts on the page (webclient/auth.js, the account
// pages) reuse the answer: me is a promise of /api/me's JSON, or of null when there was none.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const me = fetch(new URL("api/me", root), { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  window.h9account = { root: root.href, me };
  const DOT = " " + String.fromCharCode(183) + " ";

  const STYLE = [
    ".nav-links .h9a-name{display:inline-block;max-width:11rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;",
    "font-family:var(--font-mono);font-size:.85rem;letter-spacing:.15em;color:var(--text)}",
    ".nav-links a.h9a-cta{color:var(--orange)}",
    ".nav-links a.h9a-cta:hover{color:#fff}",
    "@media (min-width:769px) and (max-width:1180px){.nav-links{gap:1.1rem}.nav-links .h9a-wide{display:none}}",
    ".h9a-line{font-family:var(--font-mono,monospace);font-size:.85rem;letter-spacing:.1em}",
    ".h9a-line a{color:#ff4d00}",
    ".nav-links button.h9a-out,.h9a-line button.h9a-out{background:none;border:0;padding:0;margin:0;cursor:pointer;",
    "font-family:var(--font-mono);font-size:.85rem;letter-spacing:.15em;color:var(--text-dim)}",
    ".h9a-line button.h9a-out{color:#ff4d00;letter-spacing:.1em}",
    ".nav-links button.h9a-out:hover,.nav-links button.h9a-out:focus-visible,.h9a-line button.h9a-out:hover{color:var(--orange)}",
    ".nav-links button.h9a-out:disabled,.h9a-line button.h9a-out:disabled{opacity:.5;cursor:default}",
  ].join("");

  // where SIGN IN brings the visitor back to: this page, as a path under the site's root, with its
  // query (a forum thread is forum/thread/?t=12)
  function backHere() {
    const path = location.pathname;
    if (!path.startsWith(root.pathname)) return "";
    const rel = path.slice(root.pathname.length);
    return rel.startsWith("account/") ? "" : rel + location.search;
  }

  function link(href, label, className) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (className) a.className = className;
    return a;
  }

  // LOG OUT: ends this browser's session (POST api/logout, which the server takes only from the
  // site's own pages), then shows the page again, signed out. The account and admin pages need an
  // account, so from them it goes to the home page instead.
  function logoutButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "h9a-out";
    button.textContent = "LOG OUT";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await fetch(new URL("api/logout", root), { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      } catch (e) {
        // the next page load shows whatever the server kept
      }
      const path = location.pathname;
      if (path.startsWith(root.pathname + "account/") || path.startsWith(root.pathname + "admin/")) location.href = root.href;
      else location.reload();
    });
    return button;
  }

  function item(child, className) {
    const li = document.createElement("li");
    if (className) li.className = className;
    li.appendChild(child);
    return li;
  }

  function render(data) {
    if (!data) return;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    const next = backHere();
    const withNext = (u) => {
      const url = new URL(u, root);
      if (next) url.searchParams.set("next", next);
      return url.href;
    };
    const onAccountPages = location.pathname.startsWith(root.pathname + "account/");
    const signedIn = !!(data.signedIn && data.user);
    const items = [];
    if (signedIn) {
      const name = document.createElement("span");
      name.className = "h9a-name";
      name.textContent = data.user.username;
      name.title = "Signed in as " + data.user.username;
      items.push(item(name, "h9a h9a-wide"));
      if (data.user.role === "moderator" || data.user.role === "admin") {
        const onAdminPages = location.pathname.startsWith(root.pathname + "admin/");
        items.push(item(link(new URL("admin/", root).href, "ADMIN", onAdminPages ? "active" : ""), "h9a"));
      }
      items.push(item(link(new URL("account/", root).href, "ACCOUNT", onAccountPages ? "active" : ""), "h9a"));
      items.push(item(logoutButton(), "h9a"));
    } else {
      items.push(item(link(withNext("account/login/"), "SIGN IN"), "h9a"));
      items.push(item(link(withNext("account/signup/"), "CREATE ACCOUNT", "h9a-cta"), "h9a h9a-wide"));
    }
    const nav = document.getElementById("navLinks");
    if (nav) for (const li of items) nav.appendChild(li);

    for (const box of document.querySelectorAll("[data-h9-account]")) {
      box.textContent = "";
      box.classList.add("h9a-line");
      if (signedIn) {
        box.append("Signed in as " + data.user.username + DOT);
        box.appendChild(link(new URL("account/", root).href, "ACCOUNT"));
        box.append(DOT);
        box.appendChild(logoutButton());
      } else {
        box.appendChild(link(withNext("account/login/"), "SIGN IN"));
        box.append(DOT);
        box.appendChild(link(withNext("account/signup/"), "CREATE ACCOUNT"));
      }
    }
  }

  me.then(render);
})();
