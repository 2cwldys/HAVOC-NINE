// Username changes. A player asks for a new name under ACCOUNT; an admin approves it (with their own
// password) or denies it in the admin panel (lib/admin.js); the admin command renames at once
// (h9web-admin.js rename <old> <new>). The new name passes sign-up's checks when it is asked for,
// and again inside the transaction that applies it: the username rules (lib/usernames.js), no other
// account's name in any case, nothing that looks like one, and no old name still held.
//
// On a change the account keeps its sessions, its player id (made from the account's uid, which
// never changes) and everything it wrote (posts point at the account's id). Its old name is held
// for config.admin.renameHoldDays, so nobody else can take it at once and pass as its owner, and
// the audit log records old and new. A player has at most one request waiting (they may cancel
// it), and may ask again only config.admin.renameCooldownDays after their last change.
//
//   GET    /api/account/rename    { request: the latest or null, cooldownUntil, holdDays }
//   POST   /api/account/rename    { username }   201 { request }
//   DELETE /api/account/rename    the waiting request, cancelled
// Changes are announced on the shared event emitter: account-renamed { id, from, to }.

import { checkUsername } from "./usernames.js";
import { transaction } from "./db.js";
import { HttpError } from "./http.js";
import { COMMAND_LINE } from "./audit.js";

const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function createRenames({ db, accounts, audit, config, events }) {
  const settings = config.admin;
  const q = {
    latest: db.prepare("SELECT * FROM username_requests WHERE account_id = ? ORDER BY id DESC LIMIT 1"),
    pendingFor: db.prepare("SELECT * FROM username_requests WHERE account_id = ? AND status = 'pending'"),
    byId: db.prepare("SELECT * FROM username_requests WHERE id = ?"),
    insert: db.prepare("INSERT INTO username_requests (account_id, old_name, new_name, created_at) VALUES (?, ?, ?, ?)"),
    decide: db.prepare("UPDATE username_requests SET status = ?, reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'"),
    cancelFor: db.prepare("UPDATE username_requests SET status = 'cancelled', reason = ?, decided_at = ? WHERE account_id = ? AND status = 'pending'"),
    countStatus: db.prepare("SELECT count(*) AS n FROM username_requests WHERE (status = 'pending') = (? = 'pending')"),
    pageStatus: db.prepare(`SELECT r.*, a.username, a.role, d.username AS decided_name FROM username_requests r
      JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts d ON d.id = r.decided_by
      WHERE (r.status = 'pending') = (? = 'pending')
      ORDER BY CASE WHEN r.status = 'pending' THEN r.id ELSE -coalesce(r.decided_at, 0) END LIMIT ? OFFSET ?`),
  };
  const emit = (name, data) => { if (events) events.emit(name, data); };

  function view(r) {
    if (!r) return null;
    return {
      id: r.id, from: r.old_name, to: r.new_name, status: r.status, reason: r.reason || null,
      created: iso(r.created_at), decided: iso(r.decided_at),
      ...(r.username !== undefined ? { account: r.username, role: r.role, decidedBy: r.decided_name || null } : {}),
    };
  }

  function cooldownUntil(account, t = nowSeconds()) {
    if (!account.username_changed_at) return null;
    const until = account.username_changed_at + Math.round(settings.renameCooldownDays * 86400);
    return until > t ? until : null;
  }

  function checked(rawName) {
    const u = checkUsername(typeof rawName === "string" ? rawName.trim() : rawName);
    if (!u.ok) throw new HttpError(400, "invalid_username", u.message);
    return u;
  }

  // A player's request: the name checked, one waiting at a time, not inside the cooldown.
  function request(account, rawName, t = nowSeconds()) {
    const u = checked(rawName);
    if (u.username === account.username) throw new HttpError(400, "same_name", "That is your name already.");
    const wait = cooldownUntil(account, t);
    if (wait) {
      throw new HttpError(403, "rename_cooldown", "Your name changed lately. You can ask for another change after " + iso(wait).slice(0, 10) + ".", { body: { until: iso(wait) } });
    }
    if (q.pendingFor.get(account.id)) throw new HttpError(409, "rename_pending", "You have a request waiting already. Cancel it first to ask for another name.");
    if (accounts.nameTaken(u, account.id, t)) throw new HttpError(409, "username_taken", "That name is taken, or too close to one that is. Pick another.");
    try {
      q.insert.run(account.id, account.username, u.username, t);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, "rename_pending", "You have a request waiting already.");
      throw e;
    }
    return view(q.pendingFor.get(account.id));
  }

  function cancel(account, t = nowSeconds()) {
    return Number(q.cancelFor.run("cancelled by the player", t, account.id).changes) > 0;
  }

  // Applies a change inside one transaction: the request still waiting, the account still below
  // the deciding admin's role, the name checked again. Throws an HttpError otherwise.
  function approve(id, actor, t = nowSeconds()) {
    const result = transaction(db, () => {
      const r = q.byId.get(id);
      if (!r) throw new HttpError(404, "not_found", "No such request.");
      if (r.status !== "pending") throw new HttpError(409, "decided", "That request was " + r.status + " already.");
      const account = accounts.getById(r.account_id);
      if (!account) throw new HttpError(404, "not_found", "No such account.");
      if (actor && !(rankOf(actor) > rankOf(account))) throw new HttpError(403, "forbidden", "You cannot act on an account of your own role or above.");
      const u = checked(r.new_name);
      const change = accounts.applyRename(account.id, u, t + Math.round(settings.renameHoldDays * 86400), t);
      q.decide.run("approved", null, t, actor ? actor.id : null, r.id);
      return { ...change, accountId: account.id };
    });
    const account = accounts.getById(result.accountId);
    audit.record({ actor, action: "account.rename", target: account, detail: result.from + " -> " + result.to + " (requested by the player)" });
    emit("account-renamed", { id: result.accountId, from: result.from, to: result.to });
    return result;
  }

  function deny(id, actor, reason, t = nowSeconds()) {
    const r = q.byId.get(id);
    if (!r) throw new HttpError(404, "not_found", "No such request.");
    if (r.status !== "pending") throw new HttpError(409, "decided", "That request was " + r.status + " already.");
    const account = accounts.getById(r.account_id);
    if (actor && account && !(rankOf(actor) > rankOf(account))) throw new HttpError(403, "forbidden", "You cannot act on an account of your own role or above.");
    q.decide.run("denied", reason || null, t, actor ? actor.id : null, r.id);
    audit.record({ actor, action: "account.rename-denied", target: account, detail: r.old_name + " -> " + r.new_name + (reason ? ": " + reason : "") });
    return view(q.byId.get(id));
  }

  // The admin command's rename: the same checks and the same hold, no request, no cooldown; a
  // request the account had waiting is cancelled.
  function renameNow(account, rawName, t = nowSeconds()) {
    const u = checked(rawName);
    const result = transaction(db, () => {
      const change = accounts.applyRename(account.id, u, t + Math.round(settings.renameHoldDays * 86400), t);
      q.cancelFor.run("renamed by an admin", t, account.id);
      return change;
    });
    audit.record({ actorName: COMMAND_LINE, action: "account.rename", target: accounts.getById(account.id), detail: result.from + " -> " + result.to });
    emit("account-renamed", { id: account.id, from: result.from, to: result.to });
    return result;
  }

  function list(status, limit, offset) {
    const which = status === "decided" ? "decided" : "pending";
    return { total: q.countStatus.get(which).n, rows: q.pageStatus.all(which, limit, offset).map(view) };
  }

  const ROLES = ["user", "moderator", "admin"];
  const rankOf = (a) => ROLES.indexOf(a.role);

  return {
    request, cancel, approve, deny, renameNow, list, view, cooldownUntil,
    latest: (accountId) => view(q.latest.get(accountId)),
    pendingFor: (accountId) => view(q.pendingFor.get(accountId)),
  };
}

export function registerRenameRoutes(router, { auth, renames, limits, config, log }) {
  function limited(r) {
    return new HttpError(429, "rate_limited", "Too many requests. Try again later.", {
      headers: { "Retry-After": String(r.retryAfter) },
      body: { retryAfter: r.retryAfter },
    });
  }

  router.get("/api/account/rename", auth.requireSession(async (req, res, rc) => {
    const wait = renames.cooldownUntil(rc.account);
    rc.json(200, { request: renames.latest(rc.account.id), cooldownUntil: iso(wait), holdDays: config.admin.renameHoldDays });
  }));

  // A name that breaks the rules costs nothing; every other try counts against the limit, so the
  // form cannot be used to find out which names are taken.
  router.post("/api/account/rename", auth.requireSession(async (req, res, rc) => {
    const body = await rc.body();
    const u = checkUsername(typeof body.username === "string" ? body.username.trim() : body.username);
    if (!u.ok) throw new HttpError(400, "invalid_username", u.message);
    const lim = limits.renamePerAccount.hit("a:" + rc.account.id);
    if (!lim.ok) throw limited(lim);
    const made = renames.request(rc.account, u.username);
    log.info("rename.request", { user: rc.account.username });
    rc.json(201, { ok: true, request: made });
  }));

  router.delete("/api/account/rename", auth.requireSession(async (req, res, rc) => {
    const changed = renames.cancel(rc.account);
    rc.json(200, { ok: true, changed });
  }));
}
