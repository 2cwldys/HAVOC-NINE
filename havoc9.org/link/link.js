// HAVOC9: LINK A GAME (link/). The downloaded game shows a code (Link your Account in its main
// menu, or .link on an H9 server) and opens this page with ?code=; a signed-in player checks what
// is asking and presses LINK or NOT ME. h9web's lib/link.js answers:
//   GET  api/link/code?code=   what the code would link (the game, when it asked, whether it asked
//                              from the network this browser is on)
//   POST api/link/approve      { code }   LINK: the game is handed this account's player id
//   POST api/link/deny         { code }   NOT ME: the code is dropped
// Nothing typed here is kept in the browser.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = (p) => new URL("api/" + p, root).href;
  const $ = (id) => document.getElementById(id);
  const OFFLINE = "The account service is not answering. Try again in a minute.";
  const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    const r = await fetch(api(path), { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store" });
    let data = {};
    try { data = await r.json(); } catch (e) { /* no JSON body */ }
    return { status: r.status, data: data || {} };
  }

  function message(res) {
    if (res.data && typeof res.data.message === "string") return res.data.message;
    return "Something went wrong (" + res.status + "). Try again.";
  }

  // what was typed or came in ?code=: case, spaces and the hyphen do not matter
  function normal(text) {
    const s = String(text || "").toUpperCase().replace(/[\s-]/g, "");
    return CODE.test(s) ? s.slice(0, 4) + "-" + s.slice(4) : null;
  }

  const show = (id) => {
    for (const s of ["linkLoading", "linkUnavailable", "linkSignedOut", "linkSignedIn"]) $(s).hidden = s !== id;
  };

  let current = null; // the code shown in linkAsk

  function busy(on) {
    for (const b of document.querySelectorAll("#codeForm button, #linkAsk button")) b.disabled = on;
  }

  async function look(code) {
    $("codeError").textContent = "";
    $("askError").textContent = "";
    $("linkDone").hidden = true;
    $("linkAsk").hidden = true;
    current = null;
    const res = await call("GET", "link/code?code=" + encodeURIComponent(code)).catch(() => null);
    if (!res) {
      $("codeError").textContent = OFFLINE;
      return;
    }
    if (res.status !== 200) {
      $("codeError").textContent = message(res);
      return;
    }
    const d = res.data;
    current = d.code;
    $("linkShownCode").textContent = d.code;
    $("linkLabel").textContent = d.label;
    $("linkCreated").textContent = new Date(d.created).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      + " (" + Math.max(1, Math.ceil(d.expiresIn / 60)) + " min left)";
    $("linkNetwork").textContent = d.sameNetwork
      ? "The network you are on now"
      : "Another network than the one you are on now (a phone on mobile data, a VPN, or not your game)";
    $("linkAsk").hidden = false;
    $("linkApprove").focus();
  }

  async function answer(path, done) {
    if (!current) return;
    $("askError").textContent = "";
    busy(true);
    try {
      const res = await call("POST", path, { code: current });
      if (res.status === 200) {
        $("linkAsk").hidden = true;
        $("linkDoneText").textContent = done;
        $("linkDone").hidden = false;
        current = null;
        return;
      }
      $("askError").textContent = message(res);
    } catch (e) {
      $("askError").textContent = OFFLINE;
    } finally {
      busy(false);
    }
  }

  $("codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = normal($("linkCode").value);
    if (!code) {
      $("codeError").textContent = "That is not a code: it is 8 letters, like WDJB-MJHT.";
      return;
    }
    $("linkCode").value = code;
    busy(true);
    try { await look(code); } finally { busy(false); }
  });

  $("linkApprove").addEventListener("click", () => answer("link/approve",
    "Linked. Your game says so within a few seconds, and plays as this account from then on. You can close this page."));
  $("linkDeny").addEventListener("click", () => answer("link/deny",
    "Turned down: nothing was linked, and the game's code no longer works."));

  (async () => {
    const given = normal(new URLSearchParams(location.search).get("code"));
    const me = window.h9account ? await window.h9account.me : null;
    if (!me) {
      show("linkUnavailable");
      return;
    }
    if (!me.signedIn) {
      // SIGN IN and CREATE ACCOUNT bring the player back here, with the code
      const back = "link/" + (given ? "?code=" + given : "");
      for (const id of ["linkSignIn", "linkSignUp"]) {
        const u = new URL($(id).href);
        u.searchParams.set("next", back);
        $(id).href = u.href;
      }
      show("linkSignedOut");
      return;
    }
    $("linkAccount").textContent = me.user.username;
    show("linkSignedIn");
    if (given) {
      $("linkCode").value = given;
      busy(true);
      try { await look(given); } finally { busy(false); }
    } else {
      $("linkCode").focus();
    }
  })();
})();
