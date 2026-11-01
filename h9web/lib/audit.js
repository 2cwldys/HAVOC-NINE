// The audit log: every action a moderator or an admin takes on an account or on what members
// wrote. The admin routes (lib/admin.js), the username changes (lib/renames.js), modules (through
// ctx.audit, the forum's moderation) and the admin command ("(command line)") write it; admins read
// it in the admin panel (GET /api/admin/audit). A row older than config.admin.auditRetentionDays
// (90 by default) is deleted in the hourly housekeeping.
//
// A row: when; who acted (the account, and its name as it was then); the action, such as
// "account.suspend" or "forum.post.remove"; the account acted on (and its name as it was, which
// outlives the account); what it was about ("post 12", "thread 3"); and the reason or details.
// Never a password: no caller passes one.

export const COMMAND_LINE = "(command line)";
const ACTION = /^[a-z][a-z0-9._-]{1,63}$/;

export function createAudit({ db, retentionDays }) {
  const q = {
    insert: db.prepare(`INSERT INTO audit_log (at, actor_id, actor_name, action, target_id, target_name, subject, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    count: db.prepare("SELECT count(*) AS n FROM audit_log"),
    page: db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?"),
    countAccount: db.prepare("SELECT count(*) AS n FROM audit_log WHERE actor_id = ? OR target_id = ?"),
    pageAccount: db.prepare("SELECT * FROM audit_log WHERE actor_id = ? OR target_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"),
    countName: db.prepare("SELECT count(*) AS n FROM audit_log WHERE actor_name = ? COLLATE NOCASE OR target_name = ? COLLATE NOCASE"),
    pageName: db.prepare(`SELECT * FROM audit_log WHERE actor_name = ? COLLATE NOCASE OR target_name = ? COLLATE NOCASE
      ORDER BY id DESC LIMIT ? OFFSET ?`),
    prune: db.prepare("DELETE FROM audit_log WHERE at < ?"),
  };
  const clip = (value, n) => (value === null || value === undefined || value === "" ? null : String(value).slice(0, n));

  // actor and target are account rows (or null); actorName names an actor with no account, such
  // as the admin command; targetName names a target that is not (or no longer) an account.
  function record({ actor = null, actorName = COMMAND_LINE, action, target = null, targetName = null, subject = null, detail = null, at } = {}) {
    if (typeof action !== "string" || !ACTION.test(action)) throw new Error("audit: bad action " + action);
    q.insert.run(
      at || Math.floor(Date.now() / 1000),
      actor ? actor.id : null,
      clip(actor ? actor.username : actorName, 64),
      action,
      target ? target.id : null,
      clip(target ? target.username : targetName, 64),
      clip(subject, 200),
      clip(detail, 1000),
    );
  }

  // { total, rows }, the latest first: all of it, the rows about one account (by id: what it
  // did and what was done to it, under any name it had), or the rows that name a name.
  function list({ accountId = null, name = null, limit = 50, offset = 0 } = {}) {
    if (accountId) return { total: q.countAccount.get(accountId, accountId).n, rows: q.pageAccount.all(accountId, accountId, limit, offset) };
    if (name) return { total: q.countName.get(name, name).n, rows: q.pageName.all(name, name, limit, offset) };
    return { total: q.count.get().n, rows: q.page.all(limit, offset) };
  }

  function prune(now = Math.floor(Date.now() / 1000)) {
    return Number(q.prune.run(now - Math.round(retentionDays * 86400)).changes);
  }

  return { record, list, prune };
}
