// HAVOC 9 web client: the sign-in gate. Loaded before client.js.
//
// The web client is for signed-in players. client.js calls window.h9auth.ready() just before it
// would offer PLAY:
//   - signed in: ready() fetches the account's player id (GET /api/player), hands it over as
//     window.h9webAccount = { playerId } (relay-protocol section 6; client.js writes it to
//     cl_h9_userid) and resolves true, and client.js goes on to PLAY;
//   - not signed in: the page offers SIGN IN and CREATE ACCOUNT instead, each coming back here
//     afterwards, and ready() resolves false;
//   - the account service is not answering: the page says so, and ready() resolves false.
// The relay checks the session on its own, so this gate is for the visitor's sake: a page that
// skipped it would still reach no server.
//
// Signed in, the page also tells the site it is open, once a minute while it stays open (POST
// /api/presence/web): the player then shows as IN THE WEB CLIENT, game running or not, and as on
// the site. It stops when the site answers that the player is signed out or has no presence.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = (p) => new URL("api/" + p, root).href;
  const $ = (id) => document.getElementById(id);
  const back = "webclient/";

  function say(title, text, detail) {
    $("webclientTitle").textContent = title;
    $("webclientText").textContent = text;
    $("webclientDetail").textContent = detail;
  }

  function buttons(list) {
    const box = $("webclientActions");
    box.textContent = "";
    for (const [label, href, primary] of list) {
      const a = document.createElement("a");
      a.className = "btn " + (primary ? "btn-primary" : "btn-ghost");
      a.href = href;
      a.textContent = label;
      box.appendChild(a);
    }
  }

  function offerSignIn() {
    say("SIGN IN TO PLAY", "The web client is for HAVOC 9 members. Sign in, or make an account: a name and a password, nothing else.",
      "Your account carries your player id, so the servers know you from one visit to the next.");
    const login = new URL("account/login/", root);
    const signup = new URL("account/signup/", root);
    login.searchParams.set("next", back);
    signup.searchParams.set("next", back);
    buttons([["SIGN IN", login.href, true], ["CREATE ACCOUNT", signup.href, false]]);
  }

  function unavailable() {
    say("SIGN-IN UNAVAILABLE", "The account service is not answering right now, so the web client cannot start.",
      "Try again in a minute. The native H9XASH client needs no account.");
    buttons([["TRY AGAIN", location.href, true], ["GET THE CLIENT", new URL("downloads/index.html", root).href, false]]);
  }

  async function getJson(url) {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    return { status: r.status, data: r.ok ? await r.json() : null };
  }

  async function ready() {
    let me = null;
    try {
      me = window.h9account ? await window.h9account.me : (await getJson(api("me"))).data;
    } catch (e) { /* offline */ }
    if (!me) {
      unavailable();
      return false;
    }
    if (!me.signedIn) {
      offerSignIn();
      return false;
    }
    let player = null;
    try {
      player = await getJson(api("player"));
    } catch (e) { /* offline */ }
    if (player && player.status === 401) {
      offerSignIn();
      return false;
    }
    const id = player && player.data && String(player.data.playerId || "");
    if (!/^[0-9a-f]{32}$/.test(id)) {
      unavailable();
      return false;
    }
    window.h9webAccount = Object.freeze({ playerId: id, username: me.user.username });
    heartbeat();
    return true;
  }

  // "the web client is open", every minute while the page is
  let beating = false;
  function heartbeat() {
    if (beating) return;
    beating = true;
    const beat = async () => {
      try {
        const r = await fetch(api("presence/web"), {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/json" }, body: "{}",
        });
        if (r.status === 401 || r.status === 404) clearInterval(timer);
      } catch (e) { /* offline: the next minute tries again */ }
    };
    const timer = setInterval(beat, 60000);
    beat();
  }

  window.h9auth = { ready };
})();
