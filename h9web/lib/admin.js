// The admin panel's API, under /api/admin/ (README.txt, section 16); its page is havoc9.org/admin/.
// For moderators and admins. The panel's link in the nav is only a link: every request is checked
// here, and every action goes into the audit log (lib/audit.js).
//
// The rules:
//   * nobody acts on an account of their own role or above: so nobody suspends, deletes or demotes
//     themselves, moderators act on users only, and admins on users and moderators;
//   * a moderator suspends a user for at most config.admin.modSuspendMaxDays days, with a reason;
//   * an admin also lists, searches and opens accounts, suspends for any time and lifts a
//     suspension, signs an account out everywhere, resets a password, deletes an account, moves
//     an account between user and moderator, decides username changes, and reads the audit log;
//   * making an admin, or unmaking one, is for the admin command only (bin/h9web-admin.js), so a
//     stolen admin session can neither make admins nor lock the real ones out;
//   * reset-password, delete, a role change, a suspension with no end and approving a username
//     change need the acting admin's own password in the same request ("password"), checked with
//     the sign-in hasher and limited by limits.reauthPerAccount (wrong ones only). Modules get
//     the same check for their own admin actions as ctx.auth.confirmAdmin(rc, password).
//
//   GET  /api/admin/me                              who you are here, and the limits
//   GET  /api/admin/accounts?q=&sort=&role=&filter=&page=   the account list (moderators: players only)
//   GET  /api/admin/accounts/:name                  (admin) one account, its rename request, its audit rows
//   POST /api/admin/accounts/:name/suspend          { reason, days, password }  (no days: no end, admin only)
//   POST /api/admin/accounts/:name/unsuspend        (admin)
//   POST /api/admin/accounts/:name/sessions         (admin) sign the account out everywhere
//   POST /api/admin/accounts/:name/password         (admin) { password }   200 { newPassword }, shown once
//   POST /api/admin/accounts/:name/delete           (admin) { confirm: the username as it is, password }
//   POST /api/admin/accounts/:name/role             (admin) { role: "user" | "moderator", password }
//   GET  /api/admin/renames?status=pending|decided&page=      (admin)
//   POST /api/admin/renames/:id/approve             (admin) { password }
//   POST /api/admin/renames/:id/deny                (admin) { reason }
//   GET  /api/admin/audit?name=&page=               (admin) the audit log, the latest first

import crypto from "node:crypto";
import { HttpError } from "./http.js";
import { ROLES, PERMANENT } from "./accounts.js";
import { skeleton } from "./usernames.js";

const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const rank = (a) => ROLES.indexOf(a.role);

export function randomPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 5; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join("-");
}

export function registerAdminRoutes(router, { db, auth, accounts, renames, audit, limits, config, log }) {
  const moderator = (h) => auth.requireRole("moderator", h);
  const admin = (h) => auth.requireRole("admin", h);
  const isAdmin = (a) => auth.roleAtLeast(a, "admin");
  const notFound = () => new HttpError(404, "not_found", "No such account.");

  function limited(r) {
    return new HttpError(429, "rate_limited", "Too many wrong passwords. Wait " + Math.max(1, Math.ceil(r.retryAfter / 60)) + " minutes.", {
      headers: { "Retry-After": String(r.retryAfter) },
      body: { retryAfter: r.retryAfter },
    });
  }

  function suspension(a, t = nowSeconds()) {
    if (!accounts.isBanned(a, t)) return null;
    return { until: a.banned_until >= PERMANENT ? null : iso(a.banned_until), reason: a.ban_reason || null };
  }

  function listView(a) {
    return { username: a.username, role: a.role, created: iso(a.created_at), lastLogin: iso(a.last_login_at), suspended: suspension(a) };
  }

  // The account acted on: there, not the actor, and of a lower role than the actor's.
  function target(actor, name) {
    const t = typeof name === "string" ? accounts.getByUsername(name) : null;
    if (!t) throw notFound();
    if (t.id === actor.id) throw new HttpError(403, "forbidden", "Not on your own account.");
    if (!(rank(actor) > rank(t))) throw new HttpError(403, "forbidden", "You cannot act on an account of your own role or above.");
    return t;
  }

  // The acting account's own password, in this request; afterwards the actor is read again, in
  // case its role changed while the password was checked.
  async function confirm(rc, password) {
    const key = "a:" + rc.account.id;
    const lim = limits.reauthPerAccount.check(key);
    if (!lim.ok) throw limited(lim);
    if (typeof password !== "string" || !password) throw new HttpError(400, "password_required", "Type your own password to confirm this.");
    if (!(await accounts.verifyPassword(rc.account, password))) {
      const after = limits.reauthPerAccount.hit(key);
      log.info("admin.confirm.fail", { user: rc.account.username });
      if (!after.ok) throw limited(after);
      throw new HttpError(403, "bad_password", "That is not your password.");
    }
    const actor = accounts.getById(rc.account.id);
    if (!actor || accounts.isBanned(actor) || !isAdmin(actor)) throw new HttpError(403, "forbidden", "You do not have the rights for this.");
    return actor;
  }

  function reasonOf(value, { required = false, max = 200 } = {}) {
    if (value === undefined || value === null || value === "") {
      if (required) throw new HttpError(400, "invalid_reason", "Give a reason of 3 to " + max + " characters: the player reads it.");
      return null;
    }
    const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
    if (text.length < 3 || text.length > max) throw new HttpError(400, "invalid_reason", "Give a reason of 3 to " + max + " characters.");
    return text;
  }

  function done(actor, action, who, detail, fields = {}) {
    audit.record({ actor, action, target: who, detail });
    log.info("admin." + action, { by: actor.username, user: who ? who.username : undefined, ...fields });
  }

  router.get("/api/admin/me", moderator(async (req, res, rc) => {
    rc.json(200, {
      username: rc.account.username, role: rc.account.role, admin: isAdmin(rc.account),
      modSuspendMaxDays: config.admin.modSuspendMaxDays, renameHoldDays: config.admin.renameHoldDays,
    });
  }));

  // The account list. Moderators see players only (what they may act on); admins see everyone.
  //   q       the start of a name, without regard to case or look-alikes (username_key, or
  //           username_skeleton from lib/usernames.js)
  //   sort    newest (the default), oldest, lastlogin, name
  //   role    user, moderator or admin
  //   filter  suspended, or postingoff (the forum's posting switch, when the forum is there)
  //   page, per (50 by default, 100 at most)
  // Each row: username, role, joined, last sign-in, a suspension's end, posting off's end.
  const SORTS = {
    newest: "a.id DESC",
    oldest: "a.id ASC",
    lastlogin: "a.last_login_at IS NULL, a.last_login_at DESC, a.id DESC",
    name: "a.username_key ASC",
  };
  const listStatements = new Map();
  const hasRestrictions = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'forum_restrictions'");
  const like = (text) => text.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

  router.get("/api/admin/accounts", moderator(async (req, res, rc) => {
    const actor = rc.account;
    const lim = limits.adminListPerAccount.hit("a:" + actor.id);
    if (!lim.ok) throw new HttpError(429, "rate_limited", "Too many lookups. Wait a moment.", { headers: { "Retry-After": String(lim.retryAfter) }, body: { retryAfter: lim.retryAfter } });
    const text = String(rc.query.get("q") || "").trim().slice(0, 20);
    const sort = Object.hasOwn(SORTS, rc.query.get("sort")) ? rc.query.get("sort") : "newest";
    let role = ROLES.includes(rc.query.get("role")) ? rc.query.get("role") : null;
    const filter = ["suspended", "postingoff"].includes(rc.query.get("filter")) ? rc.query.get("filter") : null;
    const per = Math.min(100, Math.max(1, Number.parseInt(rc.query.get("per"), 10) || 50));
    const forum = !!hasRestrictions.get();
    const t = nowSeconds();
    // a moderator's list holds players only
    const onlyUsers = !isAdmin(actor);
    if (onlyUsers && role && role !== "user") return rc.json(200, { accounts: [], page: 1, pages: 1, total: 0, perPage: per, scope: "players" });
    if (onlyUsers) role = "user";
    const where = [];
    const args = [];
    if (text) {
      where.push("(a.username_key LIKE ? ESCAPE '\\' OR a.username_skeleton LIKE ? ESCAPE '\\')");
      args.push(like(text.toLowerCase()), like(skeleton(text)));
    }
    if (role) {
      where.push("a.role = ?");
      args.push(role);
    }
    if (filter === "suspended") {
      where.push("a.banned_until > ?");
      args.push(t);
    }
    if (filter === "postingoff") {
      if (!forum) return rc.json(200, { accounts: [], page: 1, pages: 1, total: 0, perPage: per, scope: onlyUsers ? "players" : "all" });
      where.push("EXISTS (SELECT 1 FROM forum_restrictions r WHERE r.account_id = a.id AND (r.until IS NULL OR r.until > ?))");
      args.push(t);
    }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    const key = whereSql + "|" + sort + "|" + forum;
    let st = listStatements.get(key);
    if (!st) {
      // only fixed pieces of SQL are put together here; every value is a bound parameter
      const posting = forum
        ? "(SELECT coalesce(r.until, -1) FROM forum_restrictions r WHERE r.account_id = a.id AND (r.until IS NULL OR r.until > ?)) AS posting_until"
        : "NULL AS posting_until";
      st = {
        count: db.prepare("SELECT count(*) AS n FROM accounts a" + whereSql),
        page: db.prepare("SELECT a.username, a.role, a.created_at, a.last_login_at, a.banned_until, " + posting + " FROM accounts a" + whereSql
          + " ORDER BY " + SORTS[sort] + " LIMIT ? OFFSET ?"),
      };
      listStatements.set(key, st);
    }
    const total = st.count.get(...args).n;
    const pages = Math.max(1, Math.ceil(total / per));
    const page = Math.min(pages, Math.max(1, Number.parseInt(rc.query.get("page"), 10) || 1));
    const rows = st.page.all(...(forum ? [t] : []), ...args, per, (page - 1) * per);
    rc.json(200, {
      accounts: rows.map((a) => ({
        username: a.username, role: a.role, joined: iso(a.created_at), lastLogin: iso(a.last_login_at),
        suspended: a.banned_until > t ? { until: a.banned_until >= PERMANENT ? null : iso(a.banned_until) } : null,
        postingOff: a.posting_until === null || a.posting_until === undefined ? null : { until: a.posting_until === -1 ? null : iso(a.posting_until) },
      })),
      page, pages, total, perPage: per, sort, scope: onlyUsers ? "players" : "all",
    });
  }));

  router.get("/api/admin/accounts/:name", admin(async (req, res, rc) => {
    const a = accounts.getByUsername(rc.params.name);
    if (!a) throw notFound();
    const trail = audit.list({ accountId: a.id, limit: 25 });
    rc.json(200, {
      account: {
        ...listView(a), passwordChanged: iso(a.password_changed_at), usernameChanged: iso(a.username_changed_at),
        sessions: auth.activeSessions(a.id),
      },
      rename: renames.pendingFor(a.id),
      audit: trail.rows.map(auditView),
      can: { act: a.id !== rc.account.id && rank(rc.account) > rank(a) },
    });
  }));

  router.post("/api/admin/accounts/:name/suspend", moderator(async (req, res, rc) => {
    const body = await rc.body();
    let actor = rc.account;
    target(actor, rc.params.name);
    const reason = reasonOf(body.reason, { required: true });
    let days = null;
    if (body.days !== undefined && body.days !== null) {
      if (typeof body.days !== "number" || !(body.days > 0) || body.days > 36500) throw new HttpError(400, "bad_request", "days is a number above 0, or left out for no end.");
      days = body.days;
    }
    if (!isAdmin(actor)) {
      if (days === null || days > config.admin.modSuspendMaxDays) {
        throw new HttpError(403, "forbidden", "Moderators suspend for 1 to " + config.admin.modSuspendMaxDays + " days. Ask an admin for longer.");
      }
    } else if (days === null) {
      actor = await confirm(rc, body.password);
    }
    const who = target(actor, rc.params.name);
    const until = days === null ? PERMANENT : nowSeconds() + Math.round(days * 86400);
    accounts.ban(who.id, until, reason);
    auth.revokeAllSessions(who.id, { reason: "suspended" });
    done(actor, "account.suspend", who, (days === null ? "no end" : days + " days") + ": " + reason);
    rc.json(200, { ok: true, until: days === null ? null : iso(until), reason });
  }));

  router.post("/api/admin/accounts/:name/unsuspend", admin(async (req, res, rc) => {
    const who = target(rc.account, rc.params.name);
    if (!accounts.isBanned(who)) return rc.json(200, { ok: true, changed: false });
    accounts.unban(who.id);
    done(rc.account, "account.unsuspend", who, null);
    rc.json(200, { ok: true, changed: true });
  }));

  router.post("/api/admin/accounts/:name/sessions", admin(async (req, res, rc) => {
    const who = target(rc.account, rc.params.name);
    auth.revokeAllSessions(who.id, { reason: "admin" });
    done(rc.account, "account.sessions", who, null);
    rc.json(200, { ok: true });
  }));

  router.post("/api/admin/accounts/:name/password", admin(async (req, res, rc) => {
    const body = await rc.body();
    target(rc.account, rc.params.name);
    const actor = await confirm(rc, body.password);
    const who = target(actor, rc.params.name);
    const password = randomPassword();
    await accounts.setPassword(who.id, password, { checkPolicy: false });
    auth.revokeAllSessions(who.id, { reason: "password-reset" });
    done(actor, "account.password", who, "a new password; every session ended");
    rc.json(200, { ok: true, newPassword: password });
  }));

  router.post("/api/admin/accounts/:name/delete", admin(async (req, res, rc) => {
    const body = await rc.body();
    const first = target(rc.account, rc.params.name);
    if (body.confirm !== first.username) throw new HttpError(400, "confirm", "Type the account's username exactly as it is (" + first.username + ") to confirm.");
    const actor = await confirm(rc, body.password);
    const who = target(actor, rc.params.name);
    done(actor, "account.delete", who, "role " + who.role + ", made " + iso(who.created_at));
    accounts.remove(who.id);
    rc.json(200, { ok: true });
  }));

  router.post("/api/admin/accounts/:name/role", admin(async (req, res, rc) => {
    const body = await rc.body();
    if (body.role !== "user" && body.role !== "moderator") {
      throw new HttpError(400, "bad_request", "The panel sets user or moderator. Admins are made and unmade with the admin command on the server.");
    }
    const first = target(rc.account, rc.params.name);
    if (first.role === body.role) return rc.json(200, { ok: true, changed: false });
    const actor = await confirm(rc, body.password);
    const who = target(actor, rc.params.name);
    accounts.setRole(who.id, body.role);
    done(actor, "account.role", who, who.role + " -> " + body.role);
    rc.json(200, { ok: true, changed: true });
  }));

  router.get("/api/admin/renames", admin(async (req, res, rc) => {
    const per = 50;
    const status = rc.query.get("status") === "decided" ? "decided" : "pending";
    const first = renames.list(status, per, 0);
    const pages = Math.max(1, Math.ceil(first.total / per));
    const page = Math.min(pages, Math.max(1, Number.parseInt(rc.query.get("page"), 10) || 1));
    const list = page > 1 ? renames.list(status, per, (page - 1) * per) : first;
    rc.json(200, { status, requests: list.rows, page, pages, total: list.total, perPage: per });
  }));

  router.post("/api/admin/renames/:id/approve", admin(async (req, res, rc) => {
    const id = /^[1-9][0-9]{0,14}$/.test(rc.params.id) ? Number(rc.params.id) : 0;
    const body = await rc.body();
    const actor = await confirm(rc, body.password);
    const result = renames.approve(id, actor);
    log.info("admin.rename", { by: actor.username, from: result.from, to: result.to });
    rc.json(200, { ok: true, from: result.from, to: result.to });
  }));

  router.post("/api/admin/renames/:id/deny", admin(async (req, res, rc) => {
    const id = /^[1-9][0-9]{0,14}$/.test(rc.params.id) ? Number(rc.params.id) : 0;
    const body = await rc.body({ optional: true });
    const request = renames.deny(id, rc.account, reasonOf(body.reason, { max: 300 }));
    log.info("admin.rename-denied", { by: rc.account.username, request: id });
    rc.json(200, { ok: true, request });
  }));

  function auditView(r) {
    return { at: iso(r.at), by: r.actor_name, action: r.action, target: r.target_name, subject: r.subject, detail: r.detail };
  }

  router.get("/api/admin/audit", admin(async (req, res, rc) => {
    const per = 50;
    const name = String(rc.query.get("name") || "").trim().slice(0, 64);
    const account = name ? accounts.getByUsername(name) : null;
    const filter = account ? { accountId: account.id } : name ? { name } : {};
    const first = audit.list({ ...filter, limit: per, offset: 0 });
    const pages = Math.max(1, Math.ceil(first.total / per));
    const page = Math.min(pages, Math.max(1, Number.parseInt(rc.query.get("page"), 10) || 1));
    const list = page > 1 ? audit.list({ ...filter, limit: per, offset: (page - 1) * per }) : first;
    rc.json(200, { entries: list.rows.map(auditView), page, pages, total: list.total, perPage: per, retentionDays: config.admin.auditRetentionDays });
  }));

  // the password check above, for modules' admin actions (lib/modules.js, ctx.auth.confirmAdmin)
  return { confirmAdmin: confirm };
}
