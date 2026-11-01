// Accounts: sign-up, the password check at sign-in, password changes, roles and suspensions.
//
// An account row (table accounts, core migration 1):
//   id                   integer, never reused (AUTOINCREMENT); what other tables point at
//   uid                  random 32 hex, the source of the player id (playerid.js)
//   username             as typed at sign-up; also the display name
//   username_key         lowercase, for sign-in and case-insensitive uniqueness
//   username_skeleton    look-alike folding (usernames.js), unique as well
//   pass_hash            passwords.js's stored form
//   role                 user | moderator | admin
//   created_at, last_login_at, password_changed_at   unix seconds
//   username_changed_at  the last username change (lib/renames.js), or null
//   banned_until, ban_reason   a suspension: in force while banned_until is in the future
//                        (PERMANENT for one with no end); sign-in, every signed-in request and
//                        the relay all refuse a suspended account
//
// Changes are announced on the shared event emitter, for modules and the relay in this process:
//   account-created { id }   account-role { id, role }   account-banned { id, until }
//   account-unbanned { id }  account-password { id }     account-deleted { id, username }
//   account-player-id { id }   the account's player id changed (resetPlayerId, movePlayerId)

import crypto from "node:crypto";
import { checkUsername, usernameKey, skeleton } from "./usernames.js";
import { passwordProblem, BusyError } from "./passwords.js";
import { newUid, derivePlayerId, serverClientId } from "./playerid.js";
import { HttpError } from "./http.js";

export const ROLES = ["user", "moderator", "admin"];
export const PERMANENT = 253402300799; // 9999-12-31T23:59:59Z

const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);

export function createAccounts({ db, hasher, secrets, config, events }) {
  const q = {
    byId: db.prepare("SELECT * FROM accounts WHERE id = ?"),
    byKey: db.prepare("SELECT * FROM accounts WHERE username_key = ?"),
    bySkeleton: db.prepare("SELECT id FROM accounts WHERE username_skeleton = ?"),
    insert: db.prepare("INSERT INTO accounts (uid, username, username_key, username_skeleton, pass_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)"),
    setHash: db.prepare("UPDATE accounts SET pass_hash = ?, password_changed_at = ? WHERE id = ?"),
    rehash: db.prepare("UPDATE accounts SET pass_hash = ? WHERE id = ?"),
    login: db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?"),
    role: db.prepare("UPDATE accounts SET role = ? WHERE id = ?"),
    ban: db.prepare("UPDATE accounts SET banned_until = ?, ban_reason = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM accounts WHERE id = ?"),
    count: db.prepare("SELECT count(*) AS n FROM accounts"),
    list: db.prepare("SELECT * FROM accounts ORDER BY id LIMIT ? OFFSET ?"),
    // an old name, held after a username change (lib/renames.js) for anyone but its old owner
    held: db.prepare(`SELECT id FROM username_holds WHERE held_until > ? AND (username_key = ? OR username_skeleton = ?)
      AND (account_id IS NULL OR account_id <> ?) LIMIT 1`),
    rename: db.prepare("UPDATE accounts SET username = ?, username_key = ?, username_skeleton = ?, username_changed_at = ? WHERE id = ?"),
    hold: db.prepare("INSERT INTO username_holds (account_id, username, username_key, username_skeleton, created_at, held_until) VALUES (?, ?, ?, ?, ?, ?)"),
    pruneHolds: db.prepare("DELETE FROM username_holds WHERE held_until <= ?"),
    setUid: db.prepare("UPDATE accounts SET uid = ? WHERE id = ?"),
  };
  const emit = (name, data) => { if (events) events.emit(name, data); };
  const policy = config.password;

  async function busyGuard(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e instanceof BusyError) throw new HttpError(503, "busy", "The server is busy. Try again in a moment.", { headers: { "Retry-After": "5" } });
      throw e;
    }
  }

  const taken = () => new HttpError(409, "username_taken", "That name is taken, or too close to one that is. Pick another.");

  // Whether a checked name (checkUsername's u) belongs to another account, looks like one, or is
  // an old name held after a username change. exceptId is the account asking, whose own name and
  // held names do not count against it.
  function nameTaken(u, exceptId = 0, t = nowSeconds()) {
    const byKey = q.byKey.get(u.key);
    if (byKey && byKey.id !== exceptId) return true;
    const bySkeleton = q.bySkeleton.get(u.skeleton);
    if (bySkeleton && bySkeleton.id !== exceptId) return true;
    return !!q.held.get(t, u.key, u.skeleton, exceptId);
  }

  async function create(rawName, password) {
    const u = checkUsername(rawName);
    if (!u.ok) throw new HttpError(400, "invalid_username", u.message);
    const problem = passwordProblem(password, u.username, policy);
    if (problem) throw new HttpError(400, "invalid_password", problem);
    if (nameTaken(u)) throw taken();
    const hash = await busyGuard(hasher.hash(password));
    const t = nowSeconds();
    // again, now that the hash is made: a username change may have happened meanwhile
    if (nameTaken(u, 0, t)) throw taken();
    let id;
    try {
      id = Number(q.insert.run(newUid(), u.username, u.key, u.skeleton, hash, t, t).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) throw taken();
      throw e;
    }
    emit("account-created", { id });
    return q.byId.get(id);
  }

  // { ok, account }: account is set whenever the name exists, ok only when the password is
  // right. A name with no account costs the same time as a wrong password.
  async function verifyLogin(rawName, password) {
    const key = usernameKey(rawName);
    const account = key && key.length <= 64 ? q.byKey.get(key) : null;
    const pw = typeof password === "string" ? password.slice(0, policy.maxLength * 4) : "";
    if (!account) {
      await busyGuard(hasher.dummyVerify(pw));
      return { ok: false, account: null };
    }
    const v = await busyGuard(hasher.verify(pw, account.pass_hash));
    if (!v.ok) return { ok: false, account };
    if (v.needsRehash) q.rehash.run(await busyGuard(hasher.hash(pw)), account.id);
    return { ok: true, account };
  }

  async function setPassword(id, password, { checkPolicy = true } = {}) {
    const account = q.byId.get(id);
    if (!account) throw new HttpError(404, "not_found", "No such account.");
    if (checkPolicy) {
      const problem = passwordProblem(password, account.username, policy);
      if (problem) throw new HttpError(400, "invalid_password", problem);
    }
    q.setHash.run(await busyGuard(hasher.hash(password)), nowSeconds(), id);
    emit("account-password", { id });
  }

  async function changePassword(account, current, next) {
    if (typeof current !== "string" || typeof next !== "string") throw new HttpError(400, "bad_request", "Fill in both passwords.");
    const v = await busyGuard(hasher.verify(current.slice(0, policy.maxLength * 4), account.pass_hash));
    if (!v.ok) throw new HttpError(403, "bad_credentials", "Your current password is not right.");
    if (current === next) throw new HttpError(400, "invalid_password", "That is the password you have now. Pick a new one.");
    await setPassword(account.id, next);
  }

  // The admin panel's confirmations: is this the account's own password? Same hasher, same cost.
  async function verifyPassword(account, password) {
    if (typeof password !== "string" || !password) return false;
    const v = await busyGuard(hasher.verify(password.slice(0, policy.maxLength * 4), account.pass_hash));
    return v.ok;
  }

  // A username change, inside the caller's transaction: the checks again, then username,
  // username_key and username_skeleton together, and the old name held until holdUntil. The
  // account's uid (its player id), sessions and everything pointing at its id stay as they are.
  function applyRename(id, u, holdUntil, t = nowSeconds()) {
    const account = q.byId.get(id);
    if (!account) throw new HttpError(404, "not_found", "No such account.");
    if (account.username === u.username) throw new HttpError(400, "same_name", "That is the account's name already.");
    if (nameTaken(u, id, t)) throw taken();
    try {
      q.rename.run(u.username, u.key, u.skeleton, t, id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) throw taken();
      throw e;
    }
    q.hold.run(id, account.username, account.username_key, account.username_skeleton, t, holdUntil);
    return { from: account.username, to: u.username };
  }

  function markLogin(id) {
    q.login.run(nowSeconds(), id);
  }

  function setRole(id, role) {
    if (!ROLES.includes(role)) throw new Error("role must be one of " + ROLES.join(", "));
    q.role.run(role, id);
    emit("account-role", { id, role });
  }

  function ban(id, until = PERMANENT, reason = null) {
    q.ban.run(Math.floor(until), reason ? String(reason).slice(0, 200) : null, id);
    emit("account-banned", { id, until });
  }

  function unban(id) {
    q.ban.run(null, null, id);
    emit("account-unbanned", { id });
  }

  function remove(id) {
    const account = q.byId.get(id);
    if (!account) return false;
    emit("account-deleted", { id, username: account.username });
    q.remove.run(id);
    return true;
  }

  function isBanned(account, t = nowSeconds()) {
    return !!account && account.banned_until !== null && account.banned_until !== undefined && account.banned_until > t;
  }

  function playerId(account) {
    return derivePlayerId(secrets.playerIdKey, account.uid);
  }

  // What each server on the list sees as this account's h9_clientid.
  function serverIds(account, servers) {
    const pid = playerId(account);
    return servers.map((s) => ({ name: s.name || s.address.key, address: s.address.key, clientId: serverClientId(pid, s.address.bytes) }));
  }

  // The answer a game client gave to h9_presence's challenge (docs/H9_PRESENCE.txt, "The id
  // proof"), checked against the account's player id: { valid, device }.
  //   proof   = HMAC-SHA256(key: the player id as 32 ASCII hex, "h9proof1:" nonce ":" server ":" devmask)
  //   devmask = device id XOR the first 16 bytes of HMAC-SHA256(the player id, "h9dev1:" nonce)
  // device is a hash of the device id: SHA-256("h9device1:" + its 16 bytes), first 32 hex. The
  // raw device id never leaves this function, the player id never leaves core.
  const HEX32 = /^[0-9a-f]{32}$/;
  const HEX64 = /^[0-9a-f]{64}$/;
  function verifyIdProof(accountId, { nonce, server, devmask, proof } = {}) {
    const account = q.byId.get(accountId);
    if (!account || !HEX32.test(String(nonce)) || !HEX32.test(String(devmask)) || !HEX64.test(String(proof)) || typeof server !== "string") {
      return { valid: false, device: null };
    }
    const pid = playerId(account);
    const want = crypto.createHmac("sha256", pid).update("h9proof1:" + nonce + ":" + server + ":" + devmask).digest();
    if (!crypto.timingSafeEqual(Buffer.from(proof, "hex"), want)) return { valid: false, device: null };
    const mask = crypto.createHmac("sha256", pid).update("h9dev1:" + nonce).digest();
    const device = Buffer.from(devmask, "hex");
    for (let i = 0; i < 16; i++) device[i] ^= mask[i];
    return { valid: true, device: crypto.createHash("sha256").update("h9device1:").update(device).digest("hex").slice(0, 32) };
  }

  // A new uid, so the old player id, and every h9_clientid made from it, is no longer this
  // account's (a leaked id dies). Plain statements, no transaction of their own: the caller runs
  // this and movePlayerId inside its own, with whatever it moves alongside.
  function resetPlayerId(accountId) {
    if (!q.byId.get(accountId)) throw new Error("resetPlayerId: no such account");
    q.setUid.run(newUid(), accountId);
    emit("account-player-id", { id: accountId });
  }

  // toId takes fromId's uid (fromId's player id now means toId), fromId gets a new one; toId's
  // old player id stops working.
  function movePlayerId(fromId, toId) {
    const from = q.byId.get(fromId);
    const to = q.byId.get(toId);
    if (!from || !to || fromId === toId) throw new Error("movePlayerId: two different accounts");
    q.setUid.run(newUid(), fromId);
    q.setUid.run(from.uid, toId);
    emit("account-player-id", { id: fromId });
    emit("account-player-id", { id: toId });
  }

  // Whether a name (one used in game, which need not pass the username rules) is an account's
  // username, looks like one, or is a name held after a username change: the sign-up rule.
  function nameInUse(name) {
    const key = usernameKey(String(name || ""));
    return !!key && nameTaken({ key, skeleton: skeleton(key) });
  }

  // What other players and modules may show about an account.
  function publicView(account) {
    return { id: account.id, username: account.username, role: account.role, created: iso(account.created_at) };
  }

  // What the account's owner sees.
  function ownView(account) {
    return {
      username: account.username,
      role: account.role,
      created: iso(account.created_at),
      lastLogin: iso(account.last_login_at),
      passwordChanged: iso(account.password_changed_at),
      playerIdShort: playerId(account).slice(0, 8),
    };
  }

  return {
    ROLES, PERMANENT,
    create, verifyLogin, setPassword, changePassword, markLogin, setRole, ban, unban, remove,
    isBanned, playerId, serverIds, publicView, ownView,
    nameTaken, verifyPassword, applyRename,
    verifyIdProof, resetPlayerId, movePlayerId, nameInUse,
    pruneHolds: (t = nowSeconds()) => Number(q.pruneHolds.run(t).changes),
    getById: (id) => q.byId.get(id) || null,
    getByUsername: (name) => q.byKey.get(usernameKey(name)) || null,
    count: () => q.count.get().n,
    list: (limit = 100, offset = 0) => q.list.all(limit, offset),
  };
}
