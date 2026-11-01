#!/usr/bin/env node
// h9web-admin: account tasks for whoever runs the server. Run it as the service's user, with
// the service's config, so it opens the same database:
//
//   sudo -u h9web node /opt/h9web/bin/h9web-admin.js --config /etc/h9web/config.json <command>
//
// Commands:
//   list [--limit N] [--offset N]          the accounts, oldest first
//   show <username>                        one account
//   create <username> [--role ROLE]        a new account with a random password, printed once
//   reset-password <username>              a new random password, printed once; every session ends
//   set-role <username> <user|moderator|admin>
//   ban <username> [--days N] [--reason TEXT]   suspend: no sign-in, no relay (no --days: until unban)
//   unban <username>
//   revoke-sessions <username>             sign the account out everywhere
//   delete <username> --yes                delete the account and its sessions
//   rename <username> <new name>           change a username at once: the sign-up checks, and the old
//                                          name held for admin.renameHoldDays (lib/renames.js)
//   backup <file>                          a consistent copy of the database, safe while it runs
//
// Every command that changes an account goes into the audit log, as "(command line)".
// Passwords are never taken as arguments (they would stay in the shell's history); the ones
// this makes are printed once and should be changed by their owner after signing in. Changes
// count at once for the API; the relay notices within relay.sessionCheckSeconds.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, loadSecrets } from "../lib/config.js";
import { openDatabase, appliedVersion, backupDatabase, CORE_MIGRATIONS } from "../lib/db.js";
import { PasswordHasher } from "../lib/passwords.js";
import { createAccounts, ROLES, PERMANENT } from "../lib/accounts.js";
import { createAuth } from "../lib/auth.js";
import { checkUsername } from "../lib/usernames.js";
import { createAudit } from "../lib/audit.js";
import { createRenames } from "../lib/renames.js";

const USAGE = "usage: h9web-admin [--config FILE] <list|show|create|reset-password|set-role|ban|unban|revoke-sessions|delete|rename|backup> ...";

function fail(message) {
  console.error("h9web-admin: " + message);
  process.exit(1);
}

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  if (v === undefined) fail(name + " needs a value");
  return v;
}
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

const config = loadConfig(option("--config") || process.env.H9WEB_CONFIG);
const command = args.shift();
if (!command) fail(USAGE);

const dbFile = path.join(config.dataDir, "h9web.db");
if (!fs.existsSync(dbFile)) fail(dbFile + " does not exist. Start the service once first; it makes the database.");
let secrets;
try {
  secrets = loadSecrets(config.dataDir, { create: false });
} catch (e) {
  fail(e.message);
}
const db = openDatabase(dbFile);
if (appliedVersion(db, "core") !== CORE_MIGRATIONS.length) fail("the database is at core v" + appliedVersion(db, "core") + ", this code at v" + CORE_MIGRATIONS.length + ". Start the service (it migrates), or use the matching code.");
const hasher = new PasswordHasher({ pepper: secrets.passwordPepper, ...config.scrypt });
const accounts = createAccounts({ db, hasher, secrets, config, events: null });
const auth = createAuth({ db, config, accounts, events: null });
const audit = createAudit({ db, retentionDays: config.admin.auditRetentionDays });
const renames = createRenames({ db, accounts, audit, config, events: null });
const record = (action, target, detail) => audit.record({ action, target, detail });

const day = (t) => (t ? new Date(t * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "-");

function account(name) {
  if (!name) fail("which account? " + USAGE);
  const a = accounts.getByUsername(name);
  if (!a) fail("no account named " + name);
  return a;
}

function randomPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 5; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join("-");
}

function banText(a) {
  if (!accounts.isBanned(a)) return "no";
  return (a.banned_until >= PERMANENT ? "until lifted" : "until " + day(a.banned_until)) + (a.ban_reason ? " (" + a.ban_reason + ")" : "");
}

try {
  switch (command) {
    case "list": {
      const limit = Number(option("--limit") || 100);
      const offset = Number(option("--offset") || 0);
      const rows = accounts.list(limit, offset);
      console.log("id".padEnd(6) + "username".padEnd(22) + "role".padEnd(11) + "created".padEnd(25) + "last sign-in".padEnd(25) + "suspended");
      for (const a of rows) {
        console.log(String(a.id).padEnd(6) + a.username.padEnd(22) + a.role.padEnd(11) + day(a.created_at).padEnd(25) + day(a.last_login_at).padEnd(25) + banText(a));
      }
      console.log(rows.length + " of " + accounts.count() + " accounts");
      break;
    }
    case "show": {
      const a = account(args[0]);
      console.log("username          " + a.username);
      console.log("id                " + a.id);
      console.log("role              " + a.role);
      console.log("created           " + day(a.created_at));
      console.log("last sign-in      " + day(a.last_login_at));
      console.log("password changed  " + day(a.password_changed_at));
      console.log("suspended         " + banText(a));
      console.log("live sessions     " + auth.activeSessions(a.id));
      console.log("player id (short) " + accounts.playerId(a).slice(0, 8));
      break;
    }
    case "create": {
      const role = option("--role") || "user";
      if (!ROLES.includes(role)) fail("role must be one of " + ROLES.join(", "));
      const u = checkUsername(args[0]);
      if (!u.ok) fail(u.message);
      const password = randomPassword();
      const a = await accounts.create(u.username, password);
      if (role !== "user") accounts.setRole(a.id, role);
      record("account.create", accounts.getById(a.id), "role " + role);
      console.log("made " + a.username + " (" + role + "). Password, shown this once: " + password);
      break;
    }
    case "reset-password": {
      const a = account(args[0]);
      const password = randomPassword();
      await accounts.setPassword(a.id, password, { checkPolicy: false });
      auth.revokeAllSessions(a.id, { reason: "password-reset" });
      record("account.password", a, "a new password; every session ended");
      console.log("new password for " + a.username + ", shown this once: " + password);
      console.log("every session of the account has ended. Ask them to change it under ACCOUNT after signing in.");
      break;
    }
    case "set-role": {
      const a = account(args[0]);
      const role = args[1];
      if (!ROLES.includes(role)) fail("role must be one of " + ROLES.join(", "));
      accounts.setRole(a.id, role);
      record("account.role", a, a.role + " -> " + role);
      console.log(a.username + ": " + a.role + " -> " + role);
      break;
    }
    case "ban": {
      const daysText = option("--days");
      const reason = option("--reason") || null;
      const a = account(args[0]);
      let until = PERMANENT;
      if (daysText !== undefined) {
        const days = Number(daysText);
        if (!(days > 0)) fail("--days must be a number above 0");
        until = Math.floor(Date.now() / 1000 + days * 86400);
      }
      accounts.ban(a.id, until, reason);
      auth.revokeAllSessions(a.id, { reason: "suspended" });
      record("account.suspend", a, (daysText === undefined ? "no end" : daysText + " days") + (reason ? ": " + reason : ""));
      console.log(a.username + " suspended " + (until >= PERMANENT ? "until lifted" : "until " + day(until)) + "; every session has ended.");
      break;
    }
    case "unban": {
      const a = account(args[0]);
      accounts.unban(a.id);
      record("account.unsuspend", a, null);
      console.log(a.username + " is no longer suspended.");
      break;
    }
    case "revoke-sessions": {
      const a = account(args[0]);
      auth.revokeAllSessions(a.id, { reason: "admin" });
      record("account.sessions", a, null);
      console.log("every session of " + a.username + " has ended.");
      break;
    }
    case "delete": {
      const yes = flag("--yes");
      const a = account(args[0]);
      if (!yes) fail("this deletes " + a.username + " for good. Run it again with --yes.");
      record("account.delete", a, "role " + a.role);
      accounts.remove(a.id);
      console.log(a.username + " deleted, with its sessions.");
      break;
    }
    case "rename": {
      const a = account(args[0]);
      if (!args[1]) fail("rename needs the new name: rename <username> <new name>");
      const change = renames.renameNow(a, args[1]);
      console.log(change.from + " is now " + change.to + ". The old name is held for " + config.admin.renameHoldDays + " days; sessions, player id and posts stay with the account.");
      break;
    }
    case "backup": {
      const file = args[0];
      if (!file) fail("backup needs a file name");
      backupDatabase(db, path.resolve(file));
      console.log("wrote " + path.resolve(file));
      break;
    }
    default:
      fail(USAGE);
  }
} catch (e) {
  fail(e.message);
} finally {
  db.close();
}
