// HAVOC9 account pages: CREATE ACCOUNT (account/signup/), SIGN IN (account/login/) and the
// account page (account/). Each page has one of the forms below; this script runs whichever it
// finds. It talks to the account service on this site (/api/), sends JSON, and shows the
// service's own messages. Nothing typed here is kept in the browser.
(() => {
  "use strict";

  const script = document.currentScript;
  const root = new URL("../", script && script.src ? script.src : location.href);
  const api = (p) => new URL("api/" + p, root).href;
  const $ = (id) => document.getElementById(id);
  const OFFLINE = "The account service is not answering. Try again in a minute.";

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

  function say(el, text) {
    el.textContent = text;
    return false;
  }

  function busy(form, on) {
    for (const b of form.querySelectorAll("button")) b.disabled = on;
  }

  // Where to go after signing in: ?next= when it is a plain path inside this site (with a plain
  // query, such as forum/thread/?t=12&page=2), else the account page.
  function nextUrl() {
    const n = new URLSearchParams(location.search).get("next") || "";
    const plain = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}(\?[A-Za-z0-9_.=&%-]{1,200})?$/.test(n) && !n.includes("..") && !n.includes("//");
    const target = new URL(plain ? n : "account/", root);
    return target.origin === location.origin ? target.href : new URL("account/", root).href;
  }

  function keepNext() {
    const n = new URLSearchParams(location.search).get("next");
    if (!n) return;
    for (const a of document.querySelectorAll("a[data-keep-next]")) {
      const u = new URL(a.href);
      u.searchParams.set("next", n);
      a.href = u.href;
    }
  }

  function day(iso, withTime) {
    if (!iso) return "-";
    const d = new Date(iso);
    return withTime
      ? d.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  const signupForm = $("signupForm");
  if (signupForm) {
    keepNext();
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("formError");
      err.textContent = "";
      const username = signupForm.elements.username.value.trim();
      const password = signupForm.elements.password.value;
      if (username.length < 3 || username.length > 20) return say(err, "Use 3 to 20 characters for the username.");
      if (Array.from(password).length < 10) return say(err, "Use at least 10 characters for the password.");
      if (password !== signupForm.elements.password2.value) return say(err, "The two passwords are not the same.");
      busy(signupForm, true);
      try {
        const res = await call("POST", "signup", { username, password });
        if (res.status === 201) {
          location.href = nextUrl();
          return;
        }
        say(err, message(res));
      } catch (x) {
        say(err, OFFLINE);
      } finally {
        busy(signupForm, false);
      }
    });
  }

  const loginForm = $("loginForm");
  if (loginForm) {
    keepNext();
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("formError");
      err.textContent = "";
      const username = loginForm.elements.username.value.trim();
      const password = loginForm.elements.password.value;
      if (!username || !password) return say(err, "Type your username and your password.");
      busy(loginForm, true);
      try {
        const res = await call("POST", "login", { username, password });
        if (res.status === 200) {
          location.href = nextUrl();
          return;
        }
        if (res.status === 403 && res.data.error === "account_suspended") {
          let text = "This account is suspended" + (res.data.until ? " until " + day(res.data.until, true) : "") + ".";
          if (res.data.reason) text += " Reason: " + res.data.reason;
          say(err, text);
        } else {
          say(err, message(res));
        }
      } catch (x) {
        say(err, OFFLINE);
      } finally {
        busy(loginForm, false);
      }
    });
  }

  if ($("signedIn")) {
    const show = (id) => {
      for (const s of ["accountLoading", "accountUnavailable", "signedOut", "signedIn"]) $(s).hidden = s !== id;
    };

    const roles = { user: "Player", moderator: "Moderator", admin: "Admin" };

    // the PLAYER ID row's own text: the start of the id
    let shortPlayerId = "";

    function fill(a) {
      $("fUsername").textContent = a.username;
      $("fRole").textContent = roles[a.role] || a.role;
      $("fCreated").textContent = day(a.created);
      $("fLastLogin").textContent = day(a.lastLogin, true);
      shortPlayerId = a.playerIdShort + "...";
      $("fPlayerId").textContent = shortPlayerId;
      $("playerIdShow").textContent = "SHOW";
      $("fSessions").textContent = a.sessions + (a.sessions === 1 ? " browser" : " browsers");
      $("pwUsername").value = a.username;
      const box = $("serverIds");
      box.textContent = "";
      if (!a.servers || !a.servers.length) {
        const p = document.createElement("p");
        p.className = "account-small";
        p.style.padding = "1rem";
        p.textContent = "No H9 servers are on the list yet.";
        box.appendChild(p);
      }
      for (const s of a.servers || []) {
        const row = document.createElement("div");
        row.className = "feature-row";
        const label = document.createElement("span");
        label.className = "feature-label";
        label.textContent = s.name;
        label.title = s.address;
        const value = document.createElement("span");
        value.className = "feature-value";
        const code = document.createElement("code");
        code.textContent = s.clientId;
        value.appendChild(code);
        row.append(label, value);
        box.appendChild(row);
      }
    }

    // ---- the whole player id, in the PLAYER ID row: fetched (GET /api/player) on SHOW or COPY
    // only, and kept nowhere; SHOW puts it in the row until HIDE or the page is left ----
    async function fullPlayerId() {
      $("playerIdError").textContent = "";
      const res = await call("GET", "player").catch(() => null);
      const id = res && res.status === 200 ? String(res.data.playerId || "") : "";
      if (/^[0-9a-f]{32}$/.test(id)) return id;
      say($("playerIdError"), res ? message(res) : OFFLINE);
      return null;
    }

    $("playerIdShow").addEventListener("click", async () => {
      if ($("playerIdShow").textContent === "HIDE") {
        $("fPlayerId").textContent = shortPlayerId;
        $("playerIdShow").textContent = "SHOW";
        return;
      }
      const id = await fullPlayerId();
      if (!id) return;
      $("fPlayerId").textContent = id;
      $("playerIdShow").textContent = "HIDE";
    });

    $("playerIdCopy").addEventListener("click", async () => {
      const id = await fullPlayerId();
      if (!id) return;
      const done = $("playerIdDone");
      try {
        await navigator.clipboard.writeText(id);
        done.textContent = "Copied. Paste it into enter_userid.cmd.";
      } catch (e) {
        done.textContent = "Copying is blocked here: press SHOW and copy it by hand.";
      }
      done.hidden = false;
    });

    // ---- Discord: linked once, for the registered role (h9web's discord module; hidden without it) ----
    const DISCORD_SAID = {
      linked: "Your Discord account is linked, and the registered role is yours.",
      pending: "Your Discord account is linked. Join H9's Discord and the registered role follows within a quarter of an hour.",
      taken: "That Discord account is linked to another HAVOC 9 account already. If it is yours, ask an admin on Discord.",
      already: "This account is linked to a Discord account already.",
      restart: "That sign-in with Discord ran out, was used already, or did not start in this browser. Nothing was linked: start again here with SYNC YOUR DISCORD.",
      cancelled: "Discord did not share your account, so nothing was linked.",
      off: "Discord linking is switched off just now.",
      error: "Discord did not answer as expected. Try again in a minute.",
    };

    async function loadDiscord() {
      let res = null;
      try { res = await call("GET", "discord/status"); } catch (e) { /* offline */ }
      if (!res || res.status !== 200 || !res.data.enabled) return;
      $("discord").hidden = false;
      const link = res.data.link;
      const said = DISCORD_SAID[new URLSearchParams(location.search).get("discord")];
      const lines = said ? [said] : [];
      if (link) {
        lines.push("Linked to " + link.displayName + " since " + day(link.linked) + ". "
          + ({ granted: "You have the registered role.", pending: "The registered role comes once you join H9's Discord.", withheld: "The registered role is held back while this account is suspended." }[link.role] || ""));
        lines.push("Only an admin can free the link, for a player who has lost that Discord account.");
      }
      $("discordState").textContent = lines.join(" ");
      $("discordState").hidden = !lines.length;
      $("discordSync").hidden = !!link;
      const invite = String(res.data.inviteUrl || "");
      if (/^https:\/\/(discord\.gg|discord\.com)\//.test(invite) && (!link || link.role === "pending")) {
        $("discordInvite").href = invite;
        $("discordInvite").hidden = false;
      }
    }

    $("discordSync").addEventListener("click", async () => {
      $("discordError").textContent = "";
      const res = await call("POST", "discord/sync", {}).catch(() => null);
      if (res && res.status === 200 && /^https?:\/\//.test(String(res.data.url || ""))) {
        location.href = res.data.url;
        return;
      }
      say($("discordError"), res ? message(res) : OFFLINE);
    });

    // ---- the profile picture: the forum's (the section stays hidden without the forum module) ----
    const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    const mb = (n) => (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + " MB";
    let pictureLimits = null;

    async function loadPicture() {
      let res = null;
      try { res = await call("GET", "forum/avatar"); } catch (e) { /* offline */ }
      if (!res || res.status !== 200) return;
      const p = res.data.picture;
      pictureLimits = res.data.limits;
      $("pictureSection").hidden = false;
      $("pictureImg").src = p ? new URL("api/forum/avatars/" + p.id + "?v=" + p.v, root).href : new URL("assets/avatar-default.png", root).href;
      $("pictureInfo").textContent = p
        ? p.type.replace("image/", "").toUpperCase() + ", " + p.width + " x " + p.height + (p.frames > 1 ? ", " + p.frames + " frames" : "") + ", " + Math.max(1, Math.round(p.bytes / 1024)) + " KB"
        : "No picture yet: the forum shows the default one.";
      $("pictureRemove").hidden = !p;
      $("pictureRules").textContent = "Up to " + mb(pictureLimits.maxBytes) + " and " + pictureLimits.maxSide + " x " + pictureLimits.maxSide
        + "; a GIF or WebP may move (" + pictureLimits.maxFrames + " frames at most). It shows beside your forum posts and on your forum profile. The camera, the place and the other details a file carries are removed before it is kept.";
      if (!pictureLimits.enabled) {
        $("pictureRules").textContent = "Profile pictures are switched off on this site for now.";
        busy($("pictureForm"), true);
      }
    }

    $("pictureForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("pictureError");
      err.textContent = "";
      const file = $("pictureFile").files && $("pictureFile").files[0];
      if (!file) return say(err, "Choose a picture first.");
      if (pictureLimits && file.size > pictureLimits.maxBytes) return say(err, "The picture is larger than " + mb(pictureLimits.maxBytes) + ".");
      busy($("pictureForm"), true);
      try {
        // the picture's own bytes, sent as the image type it is
        const r = await fetch(api("forum/avatar"), {
          method: "PUT", body: file, credentials: "same-origin", cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": PICTURE_TYPES.includes(file.type) ? file.type : "image/png" },
        });
        let data = {};
        try { data = await r.json(); } catch (x) { /* a proxy's own page */ }
        if (r.status === 200) {
          $("pictureFile").value = "";
          await loadPicture();
        } else {
          say(err, r.status === 413 ? "The picture is too large." : message({ status: r.status, data: data || {} }));
        }
      } catch (x) {
        say(err, OFFLINE);
      } finally {
        busy($("pictureForm"), !(pictureLimits && pictureLimits.enabled));
      }
    });

    $("pictureRemove").addEventListener("click", async () => {
      const res = await call("DELETE", "forum/avatar").catch(() => null);
      if (res && res.status === 200) loadPicture();
      else say($("pictureError"), res ? message(res) : OFFLINE);
    });

    // ---- a username change: asked for here, decided by an admin ----
    async function loadRename() {
      let res = null;
      try { res = await call("GET", "account/rename"); } catch (e) { /* offline */ }
      if (!res || res.status !== 200) return;
      $("renameSection").hidden = false;
      const r = res.data.request;
      const parts = [];
      if (r && r.status === "pending") parts.push("Waiting for an admin: " + r.from + " to " + r.to + ", asked " + day(r.created, true) + ".");
      if (r && r.status === "denied") parts.push("Your request for " + r.to + " was turned down" + (r.reason ? ": " + r.reason : ".") );
      if (r && r.status === "approved") parts.push("Your name changed from " + r.from + " to " + r.to + " on " + day(r.decided) + ".");
      if (res.data.cooldownUntil) parts.push("You can ask for another change after " + day(res.data.cooldownUntil) + ".");
      $("renameState").textContent = parts.join(" ");
      $("renameState").hidden = !parts.length;
      $("renameCancel").hidden = !(r && r.status === "pending");
    }

    $("renameForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("renameError");
      err.textContent = "";
      const username = $("renameName").value.trim();
      if (username.length < 3 || username.length > 20) return say(err, "Use 3 to 20 characters for the username.");
      busy($("renameForm"), true);
      try {
        const res = await call("POST", "account/rename", { username });
        if (res.status === 201) {
          $("renameName").value = "";
          await loadRename();
        } else {
          say(err, message(res));
        }
      } catch (x) {
        say(err, OFFLINE);
      } finally {
        busy($("renameForm"), false);
      }
    });

    $("renameCancel").addEventListener("click", async () => {
      const res = await call("DELETE", "account/rename").catch(() => null);
      if (res && res.status === 200) loadRename();
      else say($("renameError"), res ? message(res) : OFFLINE);
    });

    (async () => {
      let res = null;
      try { res = await call("GET", "account"); } catch (e) { /* offline */ }
      if (!res || res.status >= 500) return show("accountUnavailable");
      if (res.status !== 200) return show("signedOut");
      fill(res.data);
      show("signedIn");
      loadPicture();
      loadRename();
      loadDiscord();
    })();

    const pwForm = $("passwordForm");
    pwForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("formError");
      const done = $("formDone");
      err.textContent = "";
      done.hidden = true;
      const currentPassword = pwForm.elements.currentPassword.value;
      const newPassword = pwForm.elements.newPassword.value;
      if (!currentPassword) return say(err, "Type your current password.");
      if (Array.from(newPassword).length < 10) return say(err, "Use at least 10 characters for the new password.");
      if (newPassword !== pwForm.elements.newPassword2.value) return say(err, "The two new passwords are not the same.");
      busy(pwForm, true);
      try {
        const res = await call("POST", "password", { currentPassword, newPassword });
        if (res.status === 200) {
          pwForm.reset();
          done.hidden = false;
          const again = await call("GET", "account");
          if (again.status === 200) fill(again.data);
        } else if (res.status === 401) {
          show("signedOut");
        } else {
          say(err, message(res));
        }
      } catch (x) {
        say(err, OFFLINE);
      } finally {
        busy(pwForm, false);
      }
    });

    async function signOut(everywhere) {
      try {
        await call("POST", "logout", everywhere ? { everywhere: true } : null);
      } catch (e) { /* the cookie may stay; the next page load shows the state */ }
      location.href = root.href;
    }
    $("signOut").addEventListener("click", () => signOut(false));
    $("signOutAll").addEventListener("click", () => signOut(true));
  }
})();
