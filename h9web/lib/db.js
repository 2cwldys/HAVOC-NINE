// The database: one SQLite file through node:sqlite (built into Node 24, no native build).
//
// Schema changes are migrations: each module (the core is the module "core") has a list of
// { version, description, up(db) } with versions 1, 2, 3 ... in order. schema_migrations records
// which ran. A pending migration runs inside a transaction, so it lands whole or not at all, and
// before any pending migration touches a database that already holds tables, a copy of the file
// is written to <dataDir>/backups/. A database newer than the code (a version the list does not
// have) stops the start instead of running old code against it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The database and its copies are readable by the service's user only (0600), whatever umask
// the process had; SQLite gives its -wal and -shm files the database file's mode.
function ownerOnly(file) {
  if (process.platform === "win32") return;
  try { fs.chmodSync(file, 0o600); } catch (e) { /* not ours to change: left as it is */ }
}

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  ownerOnly(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA secure_delete = ON");
  return db;
}

// Runs fn inside BEGIN IMMEDIATE ... COMMIT; any throw rolls back and is rethrown.
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (ignored) { /* the error that matters is e */ }
    throw e;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-") + "-" + crypto.randomBytes(2).toString("hex");
}

// A consistent copy of the open database (VACUUM INTO works while the service runs).
export function backupDatabase(db, file) {
  if (fs.existsSync(file)) throw new Error("backup: " + file + " already exists");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  db.prepare("VACUUM INTO ?").run(file);
  ownerOnly(file);
  return file;
}

export function migrate(db, moduleName, migrations, { backupDir, log } = {}) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(moduleName)) throw new Error("migrations: bad module name " + moduleName);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    module TEXT NOT NULL,
    version INTEGER NOT NULL,
    description TEXT,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (module, version)
  )`);
  let last = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version !== last + 1) {
      throw new Error("migrations: " + moduleName + " versions must run 1, 2, 3 ... (found " + m.version + " after " + last + ")");
    }
    if (typeof m.up !== "function") throw new Error("migrations: " + moduleName + " v" + m.version + " has no up(db)");
    last = m.version;
  }
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations WHERE module = ?").all(moduleName).map((r) => r.version));
  const newest = Math.max(0, ...applied);
  if (newest > last) {
    throw new Error("migrations: the database has " + moduleName + " v" + newest + " but this code knows only up to v" + last + ". Run the newer code, or restore a backup.");
  }
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (!pending.length) return [];
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").get().n;
  if (tables > 0 && backupDir) {
    const file = path.join(backupDir, "pre-migrate-" + moduleName + "-v" + pending[0].version + "-" + stamp() + ".db");
    backupDatabase(db, file);
    if (log) log.info("migrate.backup", { module: moduleName, file });
  }
  const insert = db.prepare("INSERT INTO schema_migrations (module, version, description, applied_at) VALUES (?, ?, ?, ?)");
  for (const m of pending) {
    transaction(db, () => {
      m.up(db);
      insert.run(moduleName, m.version, String(m.description || ""), Math.floor(Date.now() / 1000));
    });
    if (log) log.info("migrate.applied", { module: moduleName, version: m.version, description: m.description });
  }
  return pending.map((m) => m.version);
}

export function appliedVersion(db, moduleName) {
  try {
    const row = db.prepare("SELECT max(version) AS v FROM schema_migrations WHERE module = ?").get(moduleName);
    return row && row.v ? row.v : 0;
  } catch (e) {
    return 0;
  }
}

// The core tables. Modules add their own, named after the module (forum_threads, ...).
//   v1  accounts, sessions
//   v2  audit_log (lib/audit.js); username_requests and username_holds, and
//       accounts.username_changed_at (lib/renames.js)
//   v3  account_links: the games linked to an account (lib/link.js)
export const CORE_MIGRATIONS = [
  {
    version: 1,
    description: "accounts and sessions",
    up(db) {
      db.exec(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL,
          username_key TEXT NOT NULL UNIQUE,
          username_skeleton TEXT NOT NULL UNIQUE,
          pass_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
          created_at INTEGER NOT NULL,
          last_login_at INTEGER,
          password_changed_at INTEGER NOT NULL,
          banned_until INTEGER,
          ban_reason TEXT
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX sessions_account ON sessions(account_id);
        CREATE INDEX sessions_expires ON sessions(expires_at);
      `);
    },
  },
  {
    version: 2,
    description: "audit log, username change requests and held names",
    up(db) {
      db.exec(`
        ALTER TABLE accounts ADD COLUMN username_changed_at INTEGER;
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          actor_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          actor_name TEXT,
          action TEXT NOT NULL,
          target_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          target_name TEXT,
          subject TEXT,
          detail TEXT
        );
        CREATE INDEX audit_log_at ON audit_log(at);
        CREATE INDEX audit_log_actor ON audit_log(actor_id);
        CREATE INDEX audit_log_target ON audit_log(target_id);
        CREATE TABLE username_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          old_name TEXT NOT NULL,
          new_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
          reason TEXT,
          created_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX username_requests_pending ON username_requests(account_id) WHERE status = 'pending';
        CREATE INDEX username_requests_status ON username_requests(status, id);
        CREATE TABLE username_holds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          username TEXT NOT NULL,
          username_key TEXT NOT NULL,
          username_skeleton TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          held_until INTEGER NOT NULL
        );
        CREATE INDEX username_holds_key ON username_holds(username_key, held_until);
        CREATE INDEX username_holds_skeleton ON username_holds(username_skeleton, held_until);
      `);
    },
  },
  {
    version: 3,
    description: "games linked to an account",
    up(db) {
      db.exec(`
        CREATE TABLE account_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          device TEXT,
          os TEXT,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX account_links_account ON account_links(account_id);
      `);
    },
  },
];
