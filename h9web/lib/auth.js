// The shared auth layer: sessions, the session cookie, the CSRF and Origin checks, and the
// guards route handlers wrap themselves in. Core routes, the relay and modules all use these.
//
// Sessions
//   The cookie holds a random token: 32 bytes from crypto.randomBytes, base64url. The database
//   keeps only its SHA-256 (sessions.token_hash), so a copy of the database signs nobody in.
//   A session ends when its owner signs out (that row is deleted), at session.days after it was
//   made, after session.idleDays without use, on a password change (every session of the
//   account), and on a suspension. Expired rows are swept every hour.
//   Cookie: __Host-h9_session=<token>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=...
//   (__Host- binds it to this exact host. insecureCookies, for a test without HTTPS only,
//   drops Secure and with it the prefix: h9_session.)
//
// CSRF
//   SameSite=Strict keeps the cookie off requests other sites start. On top of that every
//   state-changing request must carry an Origin (or, failing that, a Referer) that is one of
//   config.allowedOrigins, and a request the browser marks Sec-Fetch-Site: cross-site is
//   refused outright. The router applies checkSameOrigin to every POST/PUT/PATCH/DELETE.
//
// Guards, for route handlers (core or module):
//   auth.requireSession(handler)          401 when not signed in, 403 when suspended
//   auth.requireRole("moderator", handler) as above, and 403 below that role
//   auth.optionalSession(handler)         rc.account is the account or null
// Each sets rc.account (the accounts row) and rc.session before calling handler(req, res, rc).
//
// Site activity, for "on the site" (modules/presence):
//   auth.lastActive(accountId)   unix seconds of the account's last signed-in request, or null
//   auth.activeSince(unixSeconds) the account ids with a signed-in request since then
//   sessionFromRequest records each request it answers for a live, unsuspended session. The
//   relay's re-check of its sockets calls sessionByHash, which records nothing: an open web
//   client is not being on the site. After a restart lastActive falls back to the sessions'
//   last_seen_at (touched every TOUCH_SECONDS); what is kept in memory goes after a day.

import crypto from "node:crypto";
import { HttpError, parseCookies, serializeCookie } from "./http.js";
import { ROLES } from "./accounts.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_SECONDS = 600;

export function createAuth({ db, config, accounts, events }) {
  const secure = !config.insecureCookies;
  const cookieName = secure ? "__Host-h9_session" : "h9_session";
  const ttl = Math.round(config.session.days * 86400);
  const idle = Math.round(config.session.idleDays * 86400);
  const allowed = new Set(config.allowedOrigins);
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const emit = (name, data) => { if (events) events.emit(name, data); };

  const q = {
    insert: db.prepare("INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)"),
    get: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
    touch: db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?"),
    remove: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    removeAccount: db.prepare("DELETE FROM sessions WHERE account_id = ?"),
    removeAccountExcept: db.prepare("DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?"),
    sweep: db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?"),
    countAccount: db.prepare("SELECT count(*) AS n FROM sessions WHERE account_id = ? AND expires_at > ? AND last_seen_at > ?"),
    lastSeen: db.prepare("SELECT max(last_seen_at) AS t FROM sessions WHERE account_id = ?"),
  };
  const recent = new Map(); // account id -> unix seconds of its last signed-in request

  function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  // Makes a session for the account and returns its token (for the cookie only; never logged).
  function newSession(accountId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = nowSeconds();
    q.insert.run(tokenHash(token), accountId, t, t, t + ttl);
    return token;
  }

  function setSessionCookie(res, token) {
    res.setHeader("Set-Cookie", serializeCookie(cookieName, token, { maxAge: ttl, secure }));
  }

  function clearSessionCookie(res) {
    res.setHeader("Set-Cookie", serializeCookie(cookieName, "", { maxAge: 0, secure }));
  }

  // The live session behind a token hash: { session, account, banned } or null.
  function sessionByHash(hash, { touch = true } = {}) {
    const session = q.get.get(hash);
    if (!session) return null;
    const t = nowSeconds();
    if (session.expires_at <= t || session.last_seen_at + idle <= t) {
      q.remove.run(hash);
      return null;
    }
    const account = accounts.getById(session.account_id);
    if (!account) return null;
    if (touch && t - session.last_seen_at >= TOUCH_SECONDS) {
      q.touch.run(t, hash);
      session.last_seen_at = t;
    }
    return { session, account, banned: accounts.isBanned(account, t) };
  }

  function tokenFromCookieHeader(header) {
    const token = parseCookies(header).get(cookieName);
    return token && TOKEN_RE.test(token) ? token : null;
  }

  // { session, account, banned } for the request's cookie, or null.
  function sessionFromRequest(req, opts) {
    const token = tokenFromCookieHeader(req.headers.cookie);
    const s = token ? sessionByHash(tokenHash(token), opts) : null;
    if (s && !s.banned) recent.set(s.account.id, nowSeconds());
    return s;
  }

  function lastActive(accountId) {
    if (recent.has(accountId)) return recent.get(accountId);
    const r = q.lastSeen.get(accountId);
    return r && r.t ? r.t : null;
  }

  function activeSince(t) {
    const out = [];
    for (const [id, at] of recent) if (at >= t) out.push(id);
    return out;
  }

  function revokeSession(hash, reason = "signed-out") {
    q.remove.run(hash);
    emit("session-ended", { tokenHash: hash, reason });
  }

  function revokeAllSessions(accountId, { except = null, reason = "signed-out" } = {}) {
    if (except) q.removeAccountExcept.run(accountId, except);
    else q.removeAccount.run(accountId);
    emit("account-sessions-ended", { accountId, except, reason });
  }

  function activeSessions(accountId) {
    const t = nowSeconds();
    return q.countAccount.get(accountId, t, t - idle).n;
  }

  function sweep() {
    const t = nowSeconds();
    for (const [id, at] of recent) if (at < t - 86400) recent.delete(id);
    return Number(q.sweep.run(t, t - idle).changes);
  }

  function originAllowed(value) {
    if (!value) return false;
    try {
      return allowed.has(new URL(value).origin.toLowerCase());
    } catch (e) {
      return false;
    }
  }

  // CSRF: the request must come from one of the site's own pages.
  function checkSameOrigin(req) {
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;
    const origin = req.headers.origin;
    if (origin) return originAllowed(origin);
    return originAllowed(req.headers.referer);
  }

  // The relay's WebSocket: a browser always sends Origin on one, so it is required.
  function checkWebSocketOrigin(req) {
    return originAllowed(req.headers.origin);
  }

  function roleAtLeast(account, role) {
    return !!account && ROLES.indexOf(account.role) >= ROLES.indexOf(role) && ROLES.includes(role);
  }

  function signedIn(req) {
    const s = sessionFromRequest(req);
    if (!s) throw new HttpError(401, "not_signed_in", "Sign in first.");
    if (s.banned) throw new HttpError(403, "account_suspended", "This account is suspended.");
    return s;
  }

  function requireSession(handler) {
    return async (req, res, rc) => {
      const s = signedIn(req);
      rc.account = s.account;
      rc.session = s.session;
      return handler(req, res, rc);
    };
  }

  function requireRole(role, handler) {
    if (!ROLES.includes(role)) throw new Error("auth: unknown role " + role);
    return async (req, res, rc) => {
      const s = signedIn(req);
      if (!roleAtLeast(s.account, role)) throw new HttpError(403, "forbidden", "You do not have the rights for this.");
      rc.account = s.account;
      rc.session = s.session;
      return handler(req, res, rc);
    };
  }

  function optionalSession(handler) {
    return async (req, res, rc) => {
      const s = sessionFromRequest(req);
      rc.account = s && !s.banned ? s.account : null;
      rc.session = s && !s.banned ? s.session : null;
      return handler(req, res, rc);
    };
  }

  return {
    cookieName, ROLES,
    tokenHash, newSession, setSessionCookie, clearSessionCookie,
    sessionByHash, sessionFromRequest, tokenFromCookieHeader,
    revokeSession, revokeAllSessions, activeSessions, sweep, lastActive, activeSince,
    checkSameOrigin, checkWebSocketOrigin, originAllowed,
    roleAtLeast, requireSession, requireRole, optionalSession,
  };
}
