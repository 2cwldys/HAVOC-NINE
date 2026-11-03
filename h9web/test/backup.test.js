// h9web-backup (lib/backup.js, bin/h9web-backup.js): a backup while the database is open, the
// checks on an archive, encryption, --keep, restores whole and in part, refusals while the
// service runs, and the JSON export and import. Every site is made in a temporary folder of its
// own, with the real modules and their migrations.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveConfig } from "../lib/config.js";
import { createApp } from "../lib/app.js";
import { openDatabase } from "../lib/db.js";
import * as B from "../lib/backup.js";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(HOME, "bin", "h9web-backup.js");
const MODULES = path.join(HOME, "modules");
const PASS = "correct horse battery staple, for backups";
const T0 = 1767225600;
const yes = async () => true;

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A site in a temporary folder, running (its database open) until stop().
async function makeSite(name = "site") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-backup-test-"));
  dirs.push(dir);
  const raw = {
    listen: { host: "127.0.0.1", port: await freePort() },
    allowedOrigins: ["https://" + name + ".test"],
    dataDir: path.join(dir, "data"),
    serversFile: path.join(dir, "servers.json"),
    modulesDir: MODULES,
    modules: ["discord", "forum", "presence"],
    scrypt: { ln: 10, r: 8, p: 1 },
    status: { pollSeconds: 3600, timeoutMs: 500, expireSeconds: 30 },
  };
  fs.writeFileSync(raw.serversFile, JSON.stringify({ servers: [] }));
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));
  const config = resolveConfig(raw, dir);
  config.file = configFile;
  const site = {
    dir, config, configFile,
    out: path.join(dir, "out"),
    dbFile: path.join(config.dataDir, "h9web.db"),
    backups: path.join(config.dataDir, "backups"),
    app: await createApp(config, { logSink: () => {}, logLevel: "error" }),
    async stop() {
      if (this.app) await this.app.stop();
      this.app = null;
    },
    open() {
      return new DatabaseSync(this.dbFile);
    },
  };
  return site;
}

// alice owns the community and wrote the thread; bob is its admin; carol posted, voted and has a
// signature; dave asked to join; erin is invited.
async function seed(site) {
  const { app } = site;
  const db = app.db;
  const ids = {};
  for (const name of ["alice", "bob", "carol", "dave", "erin"]) ids[name] = (await app.accounts.create(name, "correct horse battery")).id;
  const cat = db.prepare("SELECT id FROM forum_categories WHERE slug = 'general'").get().id;
  ids.thread = Number(db.prepare("INSERT INTO forum_threads (category_id, account_id, title, created_at, post_count, last_post_at, last_account_id) VALUES (?, ?, 'Hello', ?, 2, ?, ?)")
    .run(cat, ids.alice, T0, T0, ids.carol).lastInsertRowid);
  const post = (who, body) => Number(db.prepare("INSERT INTO forum_posts (thread_id, account_id, body, created_at) VALUES (?, ?, ?, ?)").run(ids.thread, who, body, T0).lastInsertRowid);
  ids.p1 = post(ids.alice, "first post");
  ids.p2 = post(ids.carol, "carol was here");
  for (const who of [ids.bob, ids.carol]) db.prepare("INSERT INTO forum_votes (post_id, account_id, value, created_at) VALUES (?, ?, 1, ?)").run(ids.p1, who, T0);
  db.prepare("INSERT INTO forum_signatures (account_id, body, updated_at) VALUES (?, 'carol sig', ?)").run(ids.carol, T0);
  db.prepare("INSERT INTO forum_avatars (account_id, version, type, bytes, width, height, frames, updated_at) VALUES (?, 1, 'image/png', 4, 1, 1, 1, ?)").run(ids.alice, T0);
  const avatars = path.join(site.config.dataDir, "modules", "forum", "avatars");
  fs.mkdirSync(avatars, { recursive: true });
  fs.writeFileSync(path.join(avatars, ids.alice + "-1.png"), "PNG1");
  ids.clan = Number(db.prepare("INSERT INTO presence_communities (slug, name, owner_id, created_at, join_mode) VALUES ('clan', 'The Clan', ?, ?, 'request')").run(ids.alice, T0).lastInsertRowid);
  db.prepare("INSERT INTO presence_community_staff (community_id, account_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(ids.clan, ids.bob, ids.alice, T0);
  for (const who of [ids.alice, ids.bob, ids.carol]) db.prepare("INSERT INTO presence_community_members (community_id, account_id, joined_at, added_by) VALUES (?, ?, ?, ?)").run(ids.clan, who, T0, ids.alice);
  db.prepare("INSERT INTO presence_community_requests (community_id, account_id, created_at) VALUES (?, ?, ?)").run(ids.clan, ids.dave, T0);
  db.prepare("INSERT INTO presence_community_invites (community_id, account_id, invited_by, created_at) VALUES (?, ?, ?, ?)").run(ids.clan, ids.erin, ids.bob, T0);
  db.prepare("INSERT INTO presence_messages (community_id, kind, source, tag, account_id, name, text, created_at) VALUES (?, 'chat', 'web', 'CLAN', ?, 'carol', 'hi all', ?)").run(ids.clan, ids.carol, T0);
  return ids;
}

function cli(args, env = {}) {
  const e = { ...process.env, ...env };
  if (!("H9WEB_BACKUP_PASSPHRASE" in env)) delete e.H9WEB_BACKUP_PASSPHRASE;
  delete e.H9WEB_CONFIG;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: e, timeout: 60000 });
}

const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;
const safetyBackups = (site, kind = "pre-") => (fs.existsSync(site.backups) ? fs.readdirSync(site.backups).filter((n) => n.startsWith(kind) && n.endsWith(".h9backup")) : []);

test("a backup taken while the database is open holds the database, the modules' files and a manifest, and no keys", async () => {
  const site = await makeSite();
  const ids = await seed(site);
  fs.mkdirSync(site.backups, { recursive: true });
  fs.writeFileSync(path.join(site.backups, "pre-migrate-forum-v1-x.db"), "an older copy");
  const r = B.createBackup({ config: site.config, out: site.out, now: new Date("2026-01-02T03:04:05Z") });
  assert.equal(path.basename(r.file), "h9web-site.test-20260102-030405.h9backup");
  const a = B.verifyArchive(r.file);
  const m = a.manifest;
  assert.equal(m.format, "h9web-backup");
  assert.equal(m.host, "site.test");
  assert.equal(m.keys, false);
  assert.equal(m.tables.accounts, 5);
  assert.equal(m.tables.forum_posts, 2);
  assert.equal(m.tables.presence_community_members, 3);
  assert.equal(m.modules.forum, count(site.app.db, "SELECT max(version) AS n FROM schema_migrations WHERE module = 'forum'"));
  assert.equal(m.modules.presence, count(site.app.db, "SELECT max(version) AS n FROM schema_migrations WHERE module = 'presence'"));
  assert.ok(a.data.has("data/modules/forum/avatars/" + ids.alice + "-1.png"));
  if (fs.existsSync(path.join(site.config.dataDir, "modules", "presence", "net-key"))) assert.ok(a.data.has("data/modules/presence/net-key"));
  const names = [...a.data.keys()];
  assert.ok(!names.some((n) => n.startsWith("keys/") || /secrets\.json|data\.key|backups\//.test(n)), names.join(" "));
  for (const f of m.files) assert.equal(crypto.createHash("sha256").update(a.data.get(f.path)).digest("hex"), f.sha256);
  assert.ok(m.secretsId && m.dataKeyId);
  // the backup is a copy: the site goes on as before
  assert.equal(count(site.app.db, "SELECT count(*) AS n FROM accounts"), 5);
  // the CLI: a backup and the folder's list
  const res = cli(["backup", "--config", site.configFile, "--out", site.out, "--keep", "5"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /wrote .*h9web-site\.test-\d{8}-\d{6}\.h9backup/);
  assert.match(res.stdout, /not in it/);
  const list = cli(["list", "--out", site.out]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /h9web-site\.test-20260102-030405\.h9backup .* ok/);
  assert.match(list.stdout, /2 backup\(s\)/);
  assert.equal(cli(["verify", r.file]).status, 0);
  await site.stop();
});

test("a changed or damaged archive is refused, and restore changes nothing then", async () => {
  const site = await makeSite();
  await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  await site.stop();
  const entries = B.readTar(zlib.gunzipSync(fs.readFileSync(r.file)));
  const write = (name, list) => {
    const f = path.join(site.out, name);
    fs.writeFileSync(f, zlib.gzipSync(B.writeTar(list)));
    return f;
  };
  // the database changed, the manifest kept
  const forged = write("forged.h9backup", entries.map((e) => {
    if (e.name !== "db/h9web.db") return e;
    const d = Buffer.from(e.data);
    d[d.length - 100] ^= 1;
    return { ...e, data: d };
  }));
  assert.throws(() => B.readArchive(forged), /does not match its checksum/);
  // a file that the manifest does not list, a path that climbs out
  assert.throws(() => B.readArchive(write("extra.h9backup", [...entries, { name: "data/modules/forum/x", data: Buffer.from("x") }])), /not in its manifest/);
  assert.throws(() => B.readArchive(write("climb.h9backup", [...entries, { name: "data/../../evil", data: Buffer.from("x") }])), /unsafe path/);
  // a byte of the file itself
  const raw = fs.readFileSync(r.file);
  raw[raw.length >> 1] ^= 0xff;
  const flipped = path.join(site.out, "flipped.h9backup");
  fs.writeFileSync(flipped, raw);
  assert.throws(() => B.readArchive(flipped), (e) => e.code === "damaged");
  const res = cli(["verify", forged]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /checksum/);
  await assert.rejects(B.restoreArchive({ config: site.config, file: forged, confirm: yes }), /checksum/);
  assert.equal(safetyBackups(site).length, 0);
});

test("encrypted backups: a round trip with keys, a wrong passphrase refused, --with-keys only with --encrypt", async () => {
  const site = await makeSite();
  await seed(site);
  const { config } = site;
  assert.throws(() => B.createBackup({ config, out: site.out, withKeys: true }), /--with-keys needs --encrypt/);
  assert.throws(() => B.createBackup({ config, out: site.out, encrypt: true }), /needs a passphrase/);
  const r = B.createBackup({ config, out: site.out, encrypt: true, withKeys: true, passphrase: PASS });
  await site.stop();
  const raw = fs.readFileSync(r.file);
  assert.equal(raw.subarray(0, 8).toString("ascii"), "H9BKENC1");
  assert.equal(raw.indexOf(Buffer.from("SQLite format 3")), -1);
  assert.throws(() => B.readArchive(r.file), /is encrypted/);
  assert.throws(() => B.readArchive(r.file, { passphrase: "not the right passphrase" }), /passphrase is wrong/);
  const a = B.verifyArchive(r.file, { passphrase: PASS });
  assert.equal(a.manifest.keys, true);
  assert.deepEqual(Buffer.from(a.data.get("keys/secrets.json")), fs.readFileSync(path.join(config.dataDir, "secrets.json")));
  assert.deepEqual(Buffer.from(a.data.get("keys/data.key")), fs.readFileSync(config.dataKeyFile));
  // the passphrase: from the environment or a file, never an argument
  const pf = path.join(site.dir, "pass.txt");
  fs.writeFileSync(pf, PASS + "\r\n");
  assert.equal(B.readPassphrase({ passphraseFile: pf, env: {} }), PASS);
  assert.throws(() => B.readPassphrase({ env: { H9WEB_BACKUP_PASSPHRASE: "short" } }), /shorter than/);
  assert.equal(cli(["verify", r.file], { H9WEB_BACKUP_PASSPHRASE: PASS }).status, 0);
  assert.equal(cli(["verify", r.file, "--passphrase-file", pf]).status, 0);
  const wrong = cli(["verify", r.file], { H9WEB_BACKUP_PASSPHRASE: "not the right passphrase" });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /passphrase is wrong/);
  const argument = cli(["verify", r.file, "--passphrase", PASS]);
  assert.equal(argument.status, 2);
  assert.match(argument.stderr, /never taken as an argument/);
  const plainKeys = cli(["backup", "--config", site.configFile, "--out", site.out, "--with-keys"]);
  assert.equal(plainKeys.status, 2);
  assert.match(plainKeys.stderr, /--with-keys needs --encrypt/);
});

test("--keep deletes this host's oldest backups beyond N, and nothing else", async () => {
  const site = await makeSite();
  fs.mkdirSync(site.out, { recursive: true });
  const other = path.join(site.out, "h9web-other.test-20200101-000000.h9backup");
  fs.writeFileSync(other, "another host's");
  fs.writeFileSync(path.join(site.out, "notes.txt"), "mine");
  const at = (d) => new Date(Date.UTC(2026, 0, d, 4, 0, 0));
  const made = [1, 2, 3, 3].map((d) => B.createBackup({ config: site.config, out: site.out, keep: 2, now: at(d) }));
  await site.stop();
  assert.equal(path.basename(made[3].file), "h9web-site.test-20260103-040000-2.h9backup");
  assert.deepEqual(made[3].removed, ["h9web-site.test-20260102-040000.h9backup"]);
  assert.deepEqual(fs.readdirSync(site.out).sort(), [
    "h9web-other.test-20200101-000000.h9backup",
    "h9web-site.test-20260103-040000-2.h9backup",
    "h9web-site.test-20260103-040000.h9backup",
    "notes.txt",
  ]);
  assert.throws(() => B.createBackup({ config: site.config, out: site.out, keep: 0 }), /--keep/);
});

test("restore refuses while h9web runs: its database open in another process, or its port answering", async () => {
  const site = await makeSite();
  await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  const x = B.exportJson({ config: site.config, only: "community", out: path.join(site.dir, "community.json") });
  // the service itself, its database open
  await assert.rejects(B.restoreArchive({ config: site.config, file: r.file, confirm: yes }), (e) => e.code === "running" && /open/.test(e.message));
  await site.stop();
  // another process holds the database open, as the running service does
  const holder = openDatabase(site.dbFile);
  holder.prepare("SELECT count(*) AS n FROM accounts").get();
  try {
    const res = cli(["restore", r.file, "--config", site.configFile, "--yes"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /h9web is running on this data/);
    assert.match(res.stderr, /local-site\.cmd/);
    assert.match(res.stderr, /systemctl stop h9web/);
    const imp = cli(["import", x.file, "--config", site.configFile, "--yes"]);
    assert.equal(imp.status, 1);
    assert.match(imp.stderr, /h9web is running on this data/);
  } finally {
    holder.close();
  }
  // something listens on the configured port
  const server = net.createServer().listen(site.config.listen.port, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(B.restoreArchive({ config: site.config, file: r.file, confirm: yes }), /something is listening/);
  } finally {
    server.close();
  }
  // no terminal and no --yes
  const quiet = cli(["restore", r.file, "--config", site.configFile]);
  assert.equal(quiet.status, 1);
  assert.match(quiet.stderr, /--yes/);
  // answered no
  await assert.rejects(B.restoreArchive({ config: site.config, file: r.file, confirm: async () => false }), (e) => e.code === "cancelled");
  assert.equal(safetyBackups(site).length, 0);
});

test("a full restore puts the database and the modules' files back, after a safety backup", async () => {
  const site = await makeSite();
  const ids = await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  const db = site.app.db;
  await site.app.accounts.create("frank", "correct horse battery");
  db.prepare("DELETE FROM forum_posts WHERE id = ?").run(ids.p2);
  db.prepare("DELETE FROM presence_community_members WHERE account_id = ?").run(ids.carol);
  const avatars = path.join(site.config.dataDir, "modules", "forum", "avatars");
  fs.rmSync(path.join(avatars, ids.alice + "-1.png"));
  fs.writeFileSync(path.join(avatars, "999-1.png"), "made after the backup");
  const secrets = fs.readFileSync(path.join(site.config.dataDir, "secrets.json"));
  await site.stop();
  const res = await B.restoreArchive({ config: site.config, file: r.file, confirm: yes });
  assert.equal(res.kind, "full");
  assert.ok(fs.existsSync(res.safety) && path.dirname(res.safety) === site.backups);
  const before = B.verifyArchive(res.safety).manifest.tables;
  assert.equal(before.accounts, 6);
  assert.equal(before.forum_posts, 1);
  const now = site.open();
  try {
    for (const [t, n] of Object.entries(r.manifest.tables)) assert.equal(count(now, `SELECT count(*) AS n FROM "${t}"`), n, t);
    assert.equal(count(now, "SELECT count(*) AS n FROM accounts WHERE username = 'frank'"), 0);
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_posts WHERE id = ?", ids.p2), 1);
  } finally {
    now.close();
  }
  assert.ok(fs.existsSync(path.join(avatars, ids.alice + "-1.png")));
  assert.ok(!fs.existsSync(path.join(avatars, "999-1.png")));
  assert.deepEqual(fs.readFileSync(path.join(site.config.dataDir, "secrets.json")), secrets);
  assert.deepEqual(fs.readdirSync(site.config.dataDir).filter((n) => n.startsWith(".h9")), []);
  // the service starts on it, and alice signs in as before
  site.app = await createApp(site.config, { logSink: () => {}, logLevel: "error" });
  assert.equal(site.app.accounts.getByUsername("alice").id, ids.alice);
  await site.stop();
});

test("a full restore over other keys is refused unless asked for; one made with keys brings its own", async () => {
  const site = await makeSite();
  await seed(site);
  const plain = B.createBackup({ config: site.config, out: site.out });
  const sealed = B.createBackup({ config: site.config, out: site.out, encrypt: true, withKeys: true, passphrase: PASS, now: new Date(Date.now() + 5000) });
  await site.stop();
  const secretsFile = path.join(site.config.dataDir, "secrets.json");
  const original = fs.readFileSync(secretsFile);
  const other = JSON.parse(original);
  other.passwordPepper = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(secretsFile, JSON.stringify(other));
  await assert.rejects(B.restoreArchive({ config: site.config, file: plain.file, confirm: yes }), (e) => e.code === "keys" && /another secrets\.json/.test(e.message));
  fs.rmSync(secretsFile);
  await assert.rejects(B.restoreArchive({ config: site.config, file: plain.file, confirm: yes }), /no usable secrets\.json/);
  fs.writeFileSync(secretsFile, JSON.stringify(other));
  const res = await B.restoreArchive({ config: site.config, file: sealed.file, passphrase: PASS, confirm: yes });
  assert.deepEqual(res.keys, ["secrets.json", "data.key"]);
  assert.deepEqual(fs.readFileSync(secretsFile), original);
  assert.equal(res.asides.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(res.asides[0])).passwordPepper, other.passwordPepper);
});

test("--only forum puts the forum back and leaves accounts and the communities alone", async () => {
  const site = await makeSite();
  const ids = await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  const db = site.app.db;
  db.prepare("INSERT INTO forum_posts (thread_id, account_id, body, created_at) VALUES (?, ?, 'after the backup', ?)").run(ids.thread, ids.bob, T0 + 9);
  const frank = (await site.app.accounts.create("frank", "correct horse battery")).id;
  db.prepare("INSERT INTO presence_community_members (community_id, account_id, joined_at, added_by) VALUES (?, ?, ?, NULL)").run(ids.clan, frank, T0 + 9);
  site.app.accounts.remove(ids.carol);
  await site.stop();
  const res = await B.restoreArchive({ config: site.config, file: r.file, only: ["forum"], confirm: yes });
  assert.equal(res.kind, "part");
  assert.ok(res.tables.includes("forum_signatures") && res.tables.includes("forum_votes") && res.tables.every((t) => t.startsWith("forum_")));
  assert.equal(safetyBackups(site, "pre-restore").length, 1);
  const now = site.open();
  try {
    // the forum as backed up; carol, deleted since, as a deleted account: her post kept without
    // an author, her vote and her signature left out
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_posts"), 2);
    assert.equal(now.prepare("SELECT account_id FROM forum_posts WHERE id = ?").get(ids.p2).account_id, null);
    assert.equal(now.prepare("SELECT last_account_id FROM forum_threads WHERE id = ?").get(ids.thread).last_account_id, null);
    assert.deepEqual(now.prepare("SELECT account_id FROM forum_votes ORDER BY account_id").all().map((x) => x.account_id), [ids.bob]);
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_signatures"), 0);
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_avatars WHERE account_id = ?", ids.alice), 1);
    // accounts and the communities untouched
    assert.equal(count(now, "SELECT count(*) AS n FROM accounts WHERE id = ?", frank), 1);
    assert.equal(count(now, "SELECT count(*) AS n FROM accounts WHERE id = ?", ids.carol), 0);
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_community_members WHERE account_id = ?", frank), 1);
    assert.equal(now.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    now.close();
  }
  assert.ok(res.fixed.some((f) => f.table === "forum_posts" && f.what === "cleared" && f.parent === "accounts"));
  assert.ok(res.fixed.some((f) => f.table === "forum_votes" && f.what === "left out"));
  assert.ok(fs.existsSync(path.join(site.config.dataDir, "modules", "forum", "avatars", ids.alice + "-1.png")));
  // the CLI says what it did
  const again = cli(["restore", r.file, "--config", site.configFile, "--only", "forum", "--yes"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /forum_posts +2 -> 2/);
  assert.match(again.stdout, /as for a deleted account/);
});

test("--only community puts the communities back, members, requests and invites included, and leaves the rest alone", async () => {
  const site = await makeSite();
  const ids = await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  const db = site.app.db;
  db.prepare("DELETE FROM presence_community_staff WHERE account_id = ?").run(ids.bob);
  db.prepare("DELETE FROM presence_community_members WHERE account_id = ?").run(ids.bob);
  db.prepare("DELETE FROM presence_community_invites").run();
  db.prepare("INSERT INTO presence_communities (slug, name, owner_id, created_at) VALUES ('later', 'Made later', ?, ?)").run(ids.bob, T0 + 9);
  db.prepare("INSERT INTO presence_settings (account_id, show_game, updated_at) VALUES (?, 0, ?)").run(ids.erin, T0 + 9);
  db.prepare("INSERT INTO forum_posts (thread_id, account_id, body, created_at) VALUES (?, ?, 'after the backup', ?)").run(ids.thread, ids.bob, T0 + 9);
  site.app.accounts.remove(ids.dave);
  await site.stop();
  const res = await B.restoreArchive({ config: site.config, file: r.file, only: ["community"], confirm: yes });
  for (const t of ["presence_communities", "presence_community_members", "presence_community_requests", "presence_community_invites", "presence_community_staff", "presence_messages"]) {
    assert.ok(res.tables.includes(t), t);
  }
  assert.ok(!res.tables.includes("presence_settings") && !res.tables.includes("presence_enrolled"));
  const now = site.open();
  try {
    assert.deepEqual(now.prepare("SELECT slug FROM presence_communities ORDER BY slug").all().map((x) => x.slug), ["clan"]);
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_community_staff WHERE account_id = ?", ids.bob), 1);
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_community_members WHERE account_id = ?", ids.bob), 1);
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_community_invites WHERE account_id = ?", ids.erin), 1);
    // dave's account went after the backup: his request is left out, never made up
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_community_requests"), 0);
    // the forum, the accounts and the other presence tables untouched
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_posts"), 3);
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_settings WHERE account_id = ?", ids.erin), 1);
    assert.equal(count(now, "SELECT count(*) AS n FROM accounts"), 4);
    assert.equal(now.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    now.close();
  }
  assert.ok(res.fixed.some((f) => f.table === "presence_community_requests" && f.what === "left out"));
  assert.equal(safetyBackups(site, "pre-restore").length, 1);
});

test("--only accounts puts the accounts back; the modules' rows of an account it takes away go as for a deleted account", async () => {
  const site = await makeSite();
  const ids = await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  const db = site.app.db;
  const frank = (await site.app.accounts.create("frank", "correct horse battery")).id;
  const post = Number(db.prepare("INSERT INTO forum_posts (thread_id, account_id, body, created_at) VALUES (?, ?, 'by frank', ?)").run(ids.thread, frank, T0 + 9).lastInsertRowid);
  db.prepare("INSERT INTO forum_votes (post_id, account_id, value, created_at) VALUES (?, ?, 1, ?)").run(ids.p1, frank, T0 + 9);
  db.prepare("INSERT INTO presence_community_members (community_id, account_id, joined_at, added_by) VALUES (?, ?, ?, ?)").run(ids.clan, frank, T0 + 9, ids.alice);
  await site.stop();
  const res = await B.restoreArchive({ config: site.config, file: r.file, only: ["accounts"], confirm: yes });
  assert.ok(res.tables.includes("accounts") && res.tables.includes("sessions") && !res.tables.some((t) => /^(forum|presence|discord)_/.test(t)));
  const now = site.open();
  try {
    assert.equal(count(now, "SELECT count(*) AS n FROM accounts"), 5);
    assert.equal(now.prepare("SELECT account_id FROM forum_posts WHERE id = ?").get(post).account_id, null);
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_votes WHERE account_id = ?", frank), 0);
    assert.equal(count(now, "SELECT count(*) AS n FROM presence_community_members"), 3);
    assert.equal(count(now, "SELECT count(*) AS n FROM forum_posts"), 3);
    assert.equal(now.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    now.close();
  }
  assert.ok(res.fixed.some((f) => f.table === "forum_posts" && f.what === "cleared"));
  assert.ok(res.fixed.some((f) => f.table === "presence_community_members" && f.what === "left out"));
});

test("a part is refused when its module's version differs between the backup and the database", async () => {
  const site = await makeSite();
  await seed(site);
  const r = B.createBackup({ config: site.config, out: site.out });
  const x = B.exportJson({ config: site.config, only: "forum", out: path.join(site.dir, "forum.json") });
  site.app.db.prepare("INSERT INTO schema_migrations (module, version, description, applied_at) VALUES ('forum', 99, 'a newer forum', 0)").run();
  await site.stop();
  await assert.rejects(B.restoreArchive({ config: site.config, file: r.file, only: ["forum"], confirm: yes }), (e) => e.code === "version" && /same versions/.test(e.message) && /h9web/.test(e.message));
  await assert.rejects(B.importJson({ config: site.config, file: x.file, confirm: yes }), (e) => e.code === "version" && /same h9web version/.test(e.message));
  await assert.rejects(B.restoreArchive({ config: site.config, file: r.file, only: ["nothing"], confirm: yes }), /no such part/);
  assert.equal(safetyBackups(site).length, 0);
  // the communities' version did not change: that part still goes
  const res = await B.restoreArchive({ config: site.config, file: r.file, only: ["community"], confirm: yes });
  assert.equal(res.kind, "part");
});

test("the JSON export and import move the forum and the communities to another site by username", async () => {
  const a = await makeSite("a");
  const ids = await seed(a);
  const b = await makeSite("b");
  const bIds = {};
  for (const name of ["zed", "bob", "alice"]) bIds[name] = (await b.app.accounts.create(name, "correct horse battery")).id;
  const bCat = b.app.db.prepare("SELECT id FROM forum_categories WHERE slug = 'general'").get().id;
  const bThread = Number(b.app.db.prepare("INSERT INTO forum_threads (category_id, account_id, title, created_at, post_count, last_post_at) VALUES (?, ?, 'B only', ?, 1, ?)").run(bCat, bIds.zed, T0, T0).lastInsertRowid);
  b.app.db.prepare("INSERT INTO forum_posts (thread_id, account_id, body, created_at) VALUES (?, ?, 'on b', ?)").run(bThread, bIds.zed, T0);
  b.app.db.prepare("INSERT INTO presence_communities (slug, name, owner_id, created_at) VALUES ('bclub', 'B club', ?, ?)").run(bIds.zed, T0);
  // exported while a runs
  const fx = B.exportJson({ config: a.config, only: "forum", out: path.join(a.dir, "x", "forum.json") });
  const cx = B.exportJson({ config: a.config, only: "community", out: path.join(a.dir, "x", "community.json") });
  await a.stop();
  const forum = JSON.parse(fs.readFileSync(fx.file, "utf8"));
  assert.equal(forum.format, "h9web-export");
  assert.deepEqual(forum.leftOut, ["forum_avatars"]);
  assert.ok(!("forum_avatars" in forum.tables));
  assert.equal(forum.tables.forum_posts.find((p) => p.id === ids.p1).account_id, "alice");
  assert.ok(forum.accountColumns.forum_posts.includes("account_id"));
  const community = JSON.parse(fs.readFileSync(cx.file, "utf8"));
  assert.deepEqual(community.tables.presence_community_members.map((m) => m.account_id).sort(), ["alice", "bob", "carol"]);
  assert.equal(community.tables.presence_community_requests[0].account_id, "dave");
  assert.throws(() => B.exportJson({ config: a.config, only: "forum", out: fx.file }), /exists already/);
  assert.throws(() => B.exportJson({ config: a.config, only: "accounts" }), /--only forum/);
  await b.stop();
  const ri = await B.importJson({ config: b.config, file: fx.file, confirm: yes });
  assert.deepEqual(ri.missing, ["carol"]);
  assert.equal(safetyBackups(b, "pre-import").length, 1);
  const rc = await B.importJson({ config: b.config, file: cx.file, confirm: yes });
  assert.deepEqual(rc.missing, ["carol", "dave", "erin"]);
  assert.equal(safetyBackups(b, "pre-import").length, 2);
  const db = b.open();
  try {
    // posts by name; carol has no account on b: her post is from a deleted account, her vote and
    // signature left out; b's own thread replaced
    const posts = db.prepare("SELECT id, account_id, body FROM forum_posts ORDER BY id").all();
    assert.deepEqual(posts.map((p) => [p.id, p.account_id, p.body]), [[ids.p1, bIds.alice, "first post"], [ids.p2, null, "carol was here"]]);
    assert.equal(db.prepare("SELECT account_id FROM forum_threads WHERE id = ?").get(ids.thread).account_id, bIds.alice);
    assert.deepEqual(db.prepare("SELECT account_id FROM forum_votes").all().map((v) => v.account_id), [bIds.bob]);
    assert.equal(count(db, "SELECT count(*) AS n FROM forum_signatures"), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM forum_threads WHERE title = 'B only'"), 0);
    // the community by name: alice owns it, bob is its admin, both members; carol's membership,
    // dave's request and erin's invite left out; b's own community replaced
    assert.deepEqual(db.prepare("SELECT slug, owner_id, join_mode FROM presence_communities").all().map((c) => [c.slug, c.owner_id, c.join_mode]), [["clan", bIds.alice, "request"]]);
    assert.deepEqual(db.prepare("SELECT account_id FROM presence_community_members ORDER BY account_id").all().map((m) => m.account_id), [bIds.bob, bIds.alice].sort((x, y) => x - y));
    assert.deepEqual(db.prepare("SELECT account_id FROM presence_community_staff").all().map((m) => m.account_id), [bIds.bob]);
    assert.equal(count(db, "SELECT count(*) AS n FROM presence_community_requests"), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM presence_community_invites"), 0);
    assert.equal(db.prepare("SELECT account_id FROM presence_messages").get().account_id, null);
    // the membership rules: the owner and every admin are members
    assert.equal(count(db, "SELECT count(*) AS n FROM presence_communities c WHERE c.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM presence_community_members m WHERE m.community_id = c.id AND m.account_id = c.owner_id)"), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM presence_community_staff s WHERE NOT EXISTS (SELECT 1 FROM presence_community_members m WHERE m.community_id = s.community_id AND m.account_id = s.account_id)"), 0);
    // nothing made up: b's accounts as they were
    assert.deepEqual(db.prepare("SELECT username FROM accounts ORDER BY id").all().map((x) => x.username), ["zed", "bob", "alice"]);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
  }
  // the safety backup before the first import holds b as it was
  const oldest = safetyBackups(b, "pre-import").map((n) => path.join(b.backups, n)).sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs)[0];
  const first = B.verifyArchive(oldest);
  assert.equal(first.manifest.tables.forum_posts, 1);
  // the CLI: export, then import with --yes
  const out = path.join(b.dir, "cli-forum.json");
  const ex = cli(["export", "--config", b.configFile, "--only", "forum", "--format", "json", "--out", out]);
  assert.equal(ex.status, 0, ex.stderr);
  const im = cli(["import", out, "--config", b.configFile, "--only", "forum", "--yes"]);
  assert.equal(im.status, 0, im.stderr);
  assert.match(im.stdout, /forum_posts +2 -> 2/);
  const wrong = cli(["import", out, "--config", b.configFile, "--only", "community", "--yes"]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /holds forum, not community/);
});

test("nothing is written inside the checkout", async () => {
  const site = await makeSite();
  assert.ok(B.insideCheckout(HOME));
  assert.ok(!B.insideCheckout(site.dir));
  assert.throws(() => B.createBackup({ config: site.config, out: path.join(HOME, "backups-here") }), /inside the checkout/);
  assert.throws(() => B.exportJson({ config: site.config, only: "forum", out: path.join(HOME, "forum.json") }), /inside the checkout/);
  assert.ok(!fs.existsSync(path.join(HOME, "backups-here")));
  await site.stop();
});
