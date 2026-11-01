// The accounts API, under /api/. JSON in and out; every answer is Cache-Control: no-store.
// Errors are { "error": code, "message": text } with the HTTP status.
//
//   POST /api/signup    { username, password }       201 { ok, user }, signed in
//   POST /api/login     { username, password }       200 { ok, user }, signed in
//   POST /api/logout    { everywhere?: true }        200 { ok }, signed out (everywhere: all sessions)
//   GET  /api/me                                     200 { signedIn: false } or { signedIn: true, user }
//   GET  /api/account   (signed in)                  200 the account page's details
//   POST /api/password  { currentPassword, newPassword }  (signed in)  200 { ok }; other sessions end
//   GET  /api/player    (signed in)                  200 { playerId } for the web client
//   GET  /api/servers                                200 the live server list (servers/index.html)
//
// A failed sign-in always answers 401 bad_credentials, whether or not the name exists; a
// suspended account learns it is suspended (403) only after giving its right password.
// Limits: sign-in per IP and per username, sign-up per IP, password change per account
// (config.limits); over a limit the answer is 429 with Retry-After.

import { HttpError } from "./http.js";
import { ipKey } from "./ratelimit.js";
import { usernameKey, checkUsername } from "./usernames.js";
import { passwordProblem } from "./passwords.js";

function limited(result) {
  const minutes = Math.max(1, Math.ceil(result.retryAfter / 60));
  return new HttpError(429, "rate_limited", "Too many tries. Wait " + minutes + " minute" + (minutes === 1 ? "" : "s") + " and try again.", {
    headers: { "Retry-After": String(result.retryAfter) },
    body: { retryAfter: result.retryAfter },
  });
}

function text(value, max) {
  return typeof value === "string" && value.length <= max ? value : null;
}

export function registerCoreRoutes(router, { auth, accounts, limits, servers, status, config, log }) {
  const maxPw = config.password.maxLength * 4;

  function signIn(res, account) {
    const token = auth.newSession(account.id);
    auth.setSessionCookie(res, token);
    accounts.markLogin(account.id);
  }

  const userView = (account) => ({ username: account.username, role: account.role });

  router.post("/api/signup", async (req, res, rc) => {
    const body = await rc.body();
    const username = text(body.username, 64);
    const password = text(body.password, maxPw);
    // a form filled in wrong costs nothing; a real attempt counts against the limit
    const u = checkUsername(username);
    if (!u.ok) throw new HttpError(400, "invalid_username", u.message);
    const problem = passwordProblem(password, u.username, config.password);
    if (problem) throw new HttpError(400, "invalid_password", problem);
    const lim = limits.signupPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) throw limited(lim);
    const account = await accounts.create(username, password);
    signIn(res, account);
    log.info("signup", { user: account.username });
    rc.json(201, { ok: true, user: userView(account) });
  });

  router.post("/api/login", async (req, res, rc) => {
    const lim = limits.loginPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) throw limited(lim);
    const body = await rc.body();
    const name = text(body.username, 64);
    const password = text(body.password, maxPw);
    const userKey = "u:" + usernameKey(name || "");
    const ulim = limits.loginPerUser.check(userKey);
    if (!ulim.ok) throw limited(ulim);
    const result = await accounts.verifyLogin(name || "", password || "");
    if (!result.ok) {
      const after = limits.loginPerUser.hit(userKey);
      // only a name that is an account is logged: a password typed into the name box is not
      log.info("login.fail", { user: result.account ? result.account.username : undefined, known: !!result.account });
      if (!after.ok) throw limited(after);
      throw new HttpError(401, "bad_credentials", "Wrong username or password.");
    }
    limits.loginPerUser.reset(userKey);
    const account = result.account;
    if (accounts.isBanned(account)) {
      log.info("login.suspended", { user: account.username });
      throw new HttpError(403, "account_suspended", "This account is suspended.", {
        body: { until: account.banned_until >= accounts.PERMANENT ? null : new Date(account.banned_until * 1000).toISOString(), reason: account.ban_reason || null },
      });
    }
    const old = auth.sessionFromRequest(req, { touch: false });
    if (old) auth.revokeSession(old.session.token_hash, "replaced");
    signIn(res, account);
    log.info("login", { user: account.username });
    rc.json(200, { ok: true, user: userView(account) });
  });

  router.post("/api/logout", async (req, res, rc) => {
    const body = await rc.body({ optional: true });
    const s = auth.sessionFromRequest(req, { touch: false });
    if (s) {
      if (body.everywhere === true) auth.revokeAllSessions(s.account.id, { reason: "signed-out-everywhere" });
      else auth.revokeSession(s.session.token_hash);
      log.info(body.everywhere === true ? "logout.everywhere" : "logout", { user: s.account.username });
    }
    auth.clearSessionCookie(res);
    rc.json(200, { ok: true });
  });

  router.get("/api/me", async (req, res, rc) => {
    const s = auth.sessionFromRequest(req);
    if (!s || s.banned) return rc.json(200, { signedIn: false });
    rc.json(200, { signedIn: true, user: userView(s.account) });
  });

  router.get("/api/account", auth.requireSession(async (req, res, rc) => {
    const a = rc.account;
    rc.json(200, {
      ...accounts.ownView(a),
      sessions: auth.activeSessions(a.id),
      servers: accounts.serverIds(a, servers.listed("")),
    });
  }));

  router.post("/api/password", auth.requireSession(async (req, res, rc) => {
    const a = rc.account;
    const key = "a:" + a.id;
    const lim = limits.passwordPerAccount.check(key);
    if (!lim.ok) throw limited(lim);
    const body = await rc.body();
    try {
      await accounts.changePassword(a, text(body.currentPassword, maxPw), text(body.newPassword, maxPw));
    } catch (e) {
      if (e instanceof HttpError && e.code === "bad_credentials") {
        const after = limits.passwordPerAccount.hit(key);
        if (!after.ok) throw limited(after);
      }
      throw e;
    }
    auth.revokeAllSessions(a.id, { reason: "password-changed" });
    signIn(res, a);
    log.info("password.change", { user: a.username });
    rc.json(200, { ok: true });
  }));

  router.get("/api/player", auth.requireSession(async (req, res, rc) => {
    rc.json(200, { playerId: accounts.playerId(rc.account) });
  }));

  router.get("/api/servers", async (req, res, rc) => {
    rc.json(200, status.snapshot(), { "Cache-Control": "public, max-age=10" });
  });
}
