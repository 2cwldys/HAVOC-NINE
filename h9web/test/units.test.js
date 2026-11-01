import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkUsername, skeleton, isReserved } from "../lib/usernames.js";
import { PasswordHasher, passwordProblem } from "../lib/passwords.js";
import { derivePlayerId, serverClientId, newUid } from "../lib/playerid.js";
import { RateLimiter, TokenBucket, takeAll, ipKey } from "../lib/ratelimit.js";
import { parseMasterQuery, buildMasterReplies, readMasterReply } from "../lib/master.js";
import { parseAddress, validateServers, parseInfoReply } from "../lib/servers.js";
import { openDatabase, migrate } from "../lib/db.js";
import { resolveConfig, loadSecrets } from "../lib/config.js";

test("usernames: length, characters, case and look-alikes", () => {
  assert.equal(checkUsername("Neo").ok, true);
  assert.equal(checkUsername("Neo").key, "neo");
  assert.equal(checkUsername("ab").ok, false);
  assert.equal(checkUsername("a".repeat(21)).ok, false);
  assert.equal(checkUsername("bad name").ok, false);
  assert.equal(checkUsername("-dash").ok, false);
  assert.equal(checkUsername("dot.").ok, false);
  assert.equal(checkUsername("a__b").ok, false);
  assert.equal(checkUsername("12345").ok, false);
  assert.equal(checkUsername("caf" + String.fromCharCode(0xe9)).ok, false);
  assert.equal(skeleton("N_e0"), skeleton("neo"));
  assert.equal(skeleton("Bi11"), skeleton("bill"));
});

test("usernames: staff and project names are reserved", () => {
  for (const n of ["admin", "Admin", "4dm1n", "SiteAdmin", "x_admin_x", "Moderator", "M0d3rat0r", "MSR", "msr_bot", "H9", "h9_official",
    "Havoc9", "HAVOC_9", "HavocNine", "root", "System", "Staff", "Official_Rep", "mod"]) {
    assert.equal(isReserved(n), true, n + " should be reserved");
    assert.equal(checkUsername(n).ok, false, n + " should be refused");
  }
  for (const n of ["Neo", "Havoc_Kid", "modern", "Trinity", "Cypher99"]) assert.equal(checkUsername(n).ok, true, n + " should be allowed");
});

test("passwords: length rule only, no composition rules", () => {
  assert.equal(passwordProblem("short", "neo"), "Use at least 10 characters.");
  assert.equal(passwordProblem("all lowercase words here", "neo"), null);
  assert.equal(passwordProblem("aaaaaaaaaaaa", "neo") !== null, true);
  assert.equal(passwordProblem("1234567890", "neo") !== null, true);
  assert.equal(passwordProblem("trinity1999", "trinity") !== null, true);
  assert.equal(passwordProblem("x".repeat(257) + "y", "neo") !== null, true);
});

test("passwords: scrypt hash, constant-time verify, rehash on new cost", async () => {
  const pepper = crypto.randomBytes(32);
  const h = new PasswordHasher({ pepper, ln: 10, r: 8, p: 1 });
  const stored = await h.hash("correct horse battery staple");
  assert.match(stored, /^\$scrypt\$ln=10,r=8,p=1,k=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(stored, await h.hash("correct horse battery staple"), "salted: two hashes differ");
  assert.deepEqual(await h.verify("correct horse battery staple", stored), { ok: true, needsRehash: false });
  assert.equal((await h.verify("correct horse battery stapl", stored)).ok, false);
  // the pepper matters: another pepper never matches
  const other = new PasswordHasher({ pepper: crypto.randomBytes(32), ln: 10, r: 8, p: 1 });
  assert.equal((await other.verify("correct horse battery staple", stored)).ok, false);
  const stronger = new PasswordHasher({ pepper, ln: 11, r: 8, p: 1 });
  assert.deepEqual(await stronger.verify("correct horse battery staple", stored), { ok: true, needsRehash: true });
  assert.equal((await h.verify("x", "garbage")).ok, false);
  assert.equal(PasswordHasher.parse("$scrypt$ln=30,r=8,p=1,k=1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(43) + "="), null, "absurd cost refused");
});

test("player id: stable per account, 32 hex, and the engine's h9_clientid", () => {
  const key = Buffer.alloc(32, 7);
  const uid = "00112233445566778899aabbccddeeff";
  const id = derivePlayerId(key, uid);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(derivePlayerId(key, uid), id);
  assert.notEqual(derivePlayerId(Buffer.alloc(32, 8), uid), id);
  assert.notEqual(derivePlayerId(key, newUid()), id);
  // ID_GetMD5ForAddressEx: MD5(raw id text + 4 IPv4 bytes), lowercase hex
  const expected = crypto.createHash("md5").update(Buffer.concat([Buffer.from(id, "ascii"), Buffer.from([203, 0, 113, 10])])).digest("hex");
  assert.equal(serverClientId(id, Buffer.from([203, 0, 113, 10])), expected);
  assert.notEqual(serverClientId(id, Buffer.from([203, 0, 113, 11])), expected);
});

test("rate limiter: window, block and doubling backoff", () => {
  let now = 0;
  const l = new RateLimiter({ max: 3, windowSeconds: 60, blockSeconds: 10, maxBlockSeconds: 25, now: () => now });
  assert.equal(l.hit("k").ok, true);
  assert.equal(l.hit("k").ok, true);
  assert.equal(l.hit("k").ok, true);
  const b1 = l.hit("k");
  assert.deepEqual(b1, { ok: false, retryAfter: 10 });
  assert.equal(l.check("k").ok, false);
  assert.equal(l.hit("other").ok, true, "keys are separate");
  now += 10001;
  for (let i = 0; i < 3; i++) assert.equal(l.hit("k").ok, true);
  assert.deepEqual(l.hit("k"), { ok: false, retryAfter: 20 }, "second block doubles");
  now += 20001;
  for (let i = 0; i < 3; i++) l.hit("k");
  assert.deepEqual(l.hit("k"), { ok: false, retryAfter: 25 }, "capped at maxBlockSeconds");
});

test("token buckets and ipKey", () => {
  let now = 0;
  const a = new TokenBucket(10, 5, () => now);
  const b = new TokenBucket(10, 2, () => now);
  assert.equal(takeAll([[a, 1], [b, 1]]), true);
  assert.equal(takeAll([[a, 1], [b, 1]]), true);
  assert.equal(takeAll([[a, 1], [b, 1]]), false, "b is empty");
  assert.equal(a.tokens, 3, "a kept its tokens when b was short");
  now += 100;
  assert.equal(takeAll([[a, 1], [b, 1]]), true);
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
});

// The query exactly as NET_BuildMasterServerScanRequest makes it.
function engineQuery(info) {
  return Buffer.concat([Buffer.from([0x31, 0xff]), Buffer.from("0.0.0.0:0\0", "latin1"), Buffer.from(info + "\0", "latin1")]);
}

test("master: parses the engine's query, both forms", () => {
  const fwgs = parseMasterQuery(engineQuery("\\gamedir\\ts\\clver\\0.21\\nat\\0\\commit\\abc\\branch\\h9\\os\\emscripten\\arch\\wasm32\\buildnum\\1\\key\\1"));
  assert.equal(fwgs.fwgs, true);
  assert.equal(fwgs.seed, "0.0.0.0:0");
  assert.equal(fwgs.info.get("gamedir"), "ts");
  assert.equal(fwgs.info.get("key"), "1");
  const gs = parseMasterQuery(engineQuery("\\gamedir\\ts"));
  assert.equal(gs.fwgs, false);
  assert.equal(parseMasterQuery(Buffer.from("\xff\xff\xff\xffinfo 49", "latin1")), null);
});

test("master: replies read back the way CL_ServerList reads them", () => {
  const servers = [parseAddress("203.0.113.10:27015"), parseAddress("198.51.100.7:27016")];
  const [fw] = buildMasterReplies(servers, { fwgs: true, key: 1 });
  assert.deepEqual([...fw.subarray(0, 12)], [0xff, 0xff, 0xff, 0xff, 0x66, 0x0a, 0x7f, 1, 0, 0, 0, 0]);
  assert.deepEqual(readMasterReply(fw, { fwgs: true }), ["203.0.113.10:27015", "198.51.100.7:27016"]);
  const [gs] = buildMasterReplies(servers, { fwgs: false });
  assert.deepEqual(readMasterReply(gs, { fwgs: false }), ["203.0.113.10:27015", "198.51.100.7:27016"]);
  const empty = buildMasterReplies([], { fwgs: true });
  assert.equal(empty.length, 1);
  assert.deepEqual(readMasterReply(empty[0], { fwgs: true }), []);
  const many = Array.from({ length: 450 }, (_, i) => parseAddress("10.0." + (i >> 8) + "." + (i & 255) + ":27015"));
  const pages = buildMasterReplies(many, { fwgs: true });
  assert.equal(pages.length, 3);
  assert.ok(pages.every((p) => p.length <= 1400));
  assert.equal(pages.flatMap((p) => readMasterReply(p, { fwgs: true })).length, 450);
});

test("servers.json: validation", () => {
  const master = parseAddress("192.0.2.1:27010");
  const { entries, problems } = validateServers({ servers: [
    { name: "A", address: "203.0.113.10:27015" },
    { name: "B", address: "203.0.113.11:27015", target: "127.0.0.1:27015", listed: false },
    { name: "dup", address: "203.0.113.10:27015" },
    { name: "bad", address: "example.org:27015" },
    { name: "multicast", address: "239.1.1.1:27015" },
    { name: "master", address: "192.0.2.1:27010" },
    { name: "port", address: "203.0.113.12:0" },
  ] }, { master });
  assert.equal(entries.length, 2);
  assert.equal(problems.length, 5);
  assert.equal(entries[1].target.key, "127.0.0.1:27015");
  assert.equal(entries[1].listed, false);
  assert.equal(entries[0].gamedir, "ts");
});

test("A2S_INFO replies: Xash (Source layout) and challenge", () => {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 49])];
  for (const t of ["HAVOC 9", "h9_te_neuropolis", "ts", "Siege 2/5"]) parts.push(Buffer.from(t + "\0"));
  parts.push(Buffer.from([0, 0, 7, 16, 3, 0x64, 0x6c, 0, 0]), Buffer.from("0.21\0"));
  assert.deepEqual(parseInfoReply(Buffer.concat(parts)), { kind: "ip", name: "HAVOC 9", map: "h9_te_neuropolis", folder: "ts", mode: "Siege 2/5", players: 7, max: 16, bots: 3 });
  assert.deepEqual([...parseInfoReply(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4])).challenge], [1, 2, 3, 4]);
  assert.equal(parseInfoReply(Buffer.from("junk")), null);
});

test("migrations: versioned per module, transactional, backup first, no downgrade", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-mig-"));
  const db = openDatabase(path.join(dir, "t.db"));
  try {
    const backups = path.join(dir, "backups");
    const v1 = [{ version: 1, description: "one", up: (d) => d.exec("CREATE TABLE notes_a (x INTEGER)") }];
    assert.deepEqual(migrate(db, "notes", v1, { backupDir: backups }), [1]);
    assert.deepEqual(migrate(db, "notes", v1, { backupDir: backups }), [], "ran once only");
    assert.equal(fs.existsSync(backups), false, "no backup of a database with no tables");
    const broken = [...v1, { version: 2, up: (d) => { d.exec("CREATE TABLE notes_b (x INTEGER)"); throw new Error("half done"); } }];
    assert.throws(() => migrate(db, "notes", broken, { backupDir: backups }), /half done/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'notes_b'").get().n, 0, "rolled back");
    assert.equal(fs.readdirSync(backups).length, 1, "a copy was made before migrating");
    const v2 = [...v1, { version: 2, up: (d) => d.exec("CREATE TABLE notes_b (x INTEGER)") }];
    assert.deepEqual(migrate(db, "notes", v2, { backupDir: backups }), [2]);
    assert.throws(() => migrate(db, "notes", v1, {}), /newer/);
    assert.throws(() => migrate(db, "notes", [{ version: 2, up() {} }], {}), /1, 2, 3/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets: made once with 0600, never remade, refused when damaged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-sec-"));
  try {
    assert.throws(() => loadSecrets(dir, { create: false }), /does not exist/);
    const a = loadSecrets(dir, { create: true });
    assert.equal(a.playerIdKey.length, 32);
    const b = loadSecrets(dir, { create: true });
    assert.deepEqual(a.playerIdKey, b.playerIdKey, "the same secrets on the next start");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "secrets.json")).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, "secrets.json"), "{\"playerIdKey\":\"short\"}");
    assert.throws(() => loadSecrets(dir, { create: true }), /Restore it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: the data folder may not be inside a served folder", () => {
  assert.throws(() => resolveConfig({ dataDir: "/srv/site/data", devStatic: { "/": "/srv/site" } }, "/"), /inside the served folder/);
  assert.throws(() => resolveConfig({ password: { minLength: 8 } }), /below 10/);
  assert.throws(() => resolveConfig({ relay: { maxDatagram: 1000 } }), /1500/);
});
