// Who may host: the hosts file (tokens kept as hashes, read again when it changes), havoc9.org link tokens, and the relay's config file.
//   node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { parseHosts, hostsFileAuth, addHost, listHosts, removeHost, linkTokenAuth, hashToken, makeToken, PLACEHOLDER } from "../lib/auth.js";
import { loadConfig } from "../lib/config.js";
import { createService } from "../lib/service.js";
import { httpJson } from "../lib/helper.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "h9p2p-auth-"));
const TOKEN = "h9t_" + "a".repeat(32);
const write = (file, doc) => fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2));

test("the hosts file: plain and hashed tokens, notes, and every way it can be wrong (a problem never prints a token)", () => {
  const hash = hashToken("some-token-of-more-than-twenty-chars");
  const ok = parseHosts(JSON.stringify({
    _note: "anything", [TOKEN]: { id: 1, name: "Mike" }, [hash]: { id: "anna", name: "Anna", public: false }, ["sha256:" + "0".repeat(64)]: { id: 3, disabled: true },
  }));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.entries.size, 3);
  assert.deepEqual(ok.entries.get(hashToken(TOKEN)), { id: 1, name: "Mike", public: true, disabled: false });
  assert.equal(ok.entries.get(hash).public, false);
  assert.equal(ok.entries.get("sha256:" + "0".repeat(64)).name, "host 3");
  assert.equal(ok.entries.has(TOKEN), false, "a plain token is kept as its hash only");

  const bad = (doc) => parseHosts(typeof doc === "string" ? doc : JSON.stringify(doc)).problems;
  assert.match(bad("{nope")[0], /not valid JSON/);
  assert.match(bad("[]")[0], /top level must be an object/);
  assert.deepEqual(bad("{}"), [], "an empty file is a valid file: the last token was taken away");
  assert.match(bad({ [PLACEHOLDER + "-make-one-with-h9rv-token"]: { id: 1, name: "x" } })[0], /example token/);
  assert.match(bad({ short: { id: 1 } })[0], /shorter than 20/);
  assert.match(bad({ [TOKEN]: "mike" })[0], /must be an object/);
  assert.match(bad({ [TOKEN]: { name: "x" } })[0], /needs an id/);
  assert.match(bad({ [TOKEN]: { id: 0 } })[0], /needs an id/);
  assert.match(bad({ [TOKEN]: { id: "bad id!" } })[0], /needs an id/);
  for (const p of bad({ short: { id: 1 }, [TOKEN]: { id: -1 } })) assert.ok(!p.includes("aaaaaaaa"), "no token in a problem: " + p);
  assert.ok(parseHosts("\uFEFF" + JSON.stringify({ [TOKEN]: { id: 1 } })).problems.length === 0, "a BOM from Notepad is fine");
});

test("hostsFileAuth: a token opens, a wrong one does not, disabled and public false are carried, and a missing file is ENOENT", () => {
  const dir = tmp();
  const file = path.join(dir, "hosts.json");
  write(file, { [TOKEN]: { id: 1, name: "Mike" }, [hashToken("t".repeat(24))]: { id: 2, name: "Anna", public: false }, [hashToken("d".repeat(24))]: { id: 3, name: "Gone", disabled: true } });
  const a = hostsFileAuth({ file });
  assert.deepEqual(a.host(TOKEN), { id: 1, name: "Mike", public: true });
  assert.deepEqual(a.host("t".repeat(24)), { id: 2, name: "Anna", public: false });
  assert.equal(a.host("d".repeat(24)), null, "disabled");
  assert.equal(a.host("x".repeat(24)), null);
  assert.equal(a.host(""), null);
  assert.equal(a.host(undefined), null);
  assert.equal(a.account("anything"), null);
  assert.equal(a.accountsAvailable, false);
  assert.throws(() => hostsFileAuth({ file: path.join(dir, "nope.json") }), (e) => e.code === "ENOENT");
  write(path.join(dir, "empty.json"), {});
  assert.throws(() => hostsFileAuth({ file: path.join(dir, "empty.json") }), (e) => /no host token/.test(e.message), "at start an empty file is refused: nobody could ever open");
  write(path.join(dir, "bad.json"), { [PLACEHOLDER + "-x"]: { id: 1 } });
  assert.throws(() => hostsFileAuth({ file: path.join(dir, "bad.json") }), (e) => /example token/.test(e.message) && Array.isArray(e.problems));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hostsFileAuth reads the file again when it changes: an added token works, a removed or disabled one stops and is reported; a broken edit changes nothing", () => {
  const dir = tmp();
  const file = path.join(dir, "hosts.json");
  const removed = [];
  const logs = [];
  let clock = 0;
  write(file, { [TOKEN]: { id: 1, name: "Mike" }, [hashToken("t".repeat(24))]: { id: 2, name: "Anna" } });
  const a = hostsFileAuth({ file, now: () => clock, recheckMs: 2000, onRemoved: (id) => removed.push(id), log: (e, f) => logs.push(e) });
  assert.equal(a.size(), 2);
  write(file, { [TOKEN]: { id: 1, name: "Mike" }, [hashToken("t".repeat(24))]: { id: 2, name: "Anna" }, [hashToken("n".repeat(24))]: { id: 4, name: "New host" } });
  assert.equal(a.host("n".repeat(24)), null, "inside the 2 seconds the old table is used");
  clock += 2500;
  assert.equal(a.host("n".repeat(24)).name, "New host", "after them the file is read again");
  write(file, { [TOKEN]: { id: 1, name: "Mike", disabled: true }, [hashToken("n".repeat(24))]: { id: 4, name: "New host with a longer name" } });
  clock += 2500;
  assert.equal(a.host(TOKEN), null, "disabled");
  assert.equal(a.host("t".repeat(24)), null, "removed");
  assert.deepEqual(removed.sort(), [1, 2], "the ids whose tokens stopped are reported, so their sessions can end");
  write(file, "{ this is not json at all, and longer than before ");
  clock += 2500;
  assert.equal(a.host("n".repeat(24)).id, 4, "a broken edit keeps the table in use");
  assert.ok(logs.includes("hosts.reload_refused"));
  write(file, { [TOKEN + "x"]: { id: 9, name: "Fixed host!" }, [hashToken("n".repeat(24))]: { id: 4, name: "x" } });
  clock += 2500;
  assert.equal(a.host(TOKEN + "x").id, 9, "and the fixed file is taken up");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("h9rv token / hosts list / hosts remove (the library calls behind them): the token is shown once and the file holds only its hash", () => {
  const dir = tmp();
  const file = path.join(dir, "hosts.json");
  write(file, { [PLACEHOLDER + "-example"]: { id: 1, name: "example" }, _note: "kept" });
  const a = addHost(file, { name: "Mike" });
  assert.equal(a.id, 1, "the example entry goes and the first real one is host 1");
  assert.match(a.token, /^h9t_[A-Za-z0-9_-]{32}$/);
  const b = addHost(file, { name: "Anna\u00e9 \u0007", publicOk: false });
  assert.equal(b.id, 2);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(a.token) && !text.includes(b.token), "no token in the file");
  assert.ok(text.includes(hashToken(a.token)), "its hash is");
  assert.ok(text.includes("_note"), "notes are kept");
  assert.ok(!text.includes(PLACEHOLDER), "the example entry is gone");
  assert.deepEqual(listHosts(file).map((r) => [r.id, r.name, r.public]), [[1, "Mike", true], [2, "Anna? ?", false]]);
  const auth = hostsFileAuth({ file });
  assert.equal(auth.host(a.token).name, "Mike");
  assert.equal(auth.host(b.token).public, false);
  assert.equal(removeHost(file, 1), 1);
  assert.equal(removeHost(file, 1), 0);
  assert.equal(addHost(file, { name: "Next" }).id, 3, "ids are not reused below the highest");
  assert.notEqual(makeToken(), makeToken());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the hosts file keeps its permissions when a token is added (a root-run token command must not lock the service out)", { skip: process.platform === "win32" && "file modes are not a thing on Windows" }, () => {
  const dir = tmp();
  const file = path.join(dir, "hosts.json");
  write(file, { _note: "x" });
  fs.chmodSync(file, 0o640);
  addHost(file, { name: "Mike" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, "an existing file keeps its mode");
  const fresh = path.join(dir, "fresh.json");
  addHost(fresh, { name: "Anna" });
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o600, "a new file is private to its maker");
  assert.ok(!fs.existsSync(file + ".tmp"), "no temp file is left");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("linkTokenAuth: a link token is checked once a minute, a refusal for ten seconds, a bad shape never leaves the machine", async () => {
  let calls = 0;
  let answer = { status: "linked", account: "Neo" };
  const seen = [];
  const getter = async (url) => { calls++; seen.push(url); return answer; };
  let clock = 0;
  const auth = linkTokenAuth({ statusUrl: "https://example.test/api/link/status?token=", getter, now: () => clock });
  const T = "A".repeat(43);
  assert.deepEqual(await auth.host(T), { id: "h9:neo", name: "Neo" });
  assert.deepEqual(await auth.account(T), { id: "h9:neo", name: "Neo" });
  assert.equal(calls, 1, "the second check is the first one's answer");
  assert.equal(seen[0], "https://example.test/api/link/status?token=" + T);
  clock += 61000;
  await auth.host(T);
  assert.equal(calls, 2, "a minute later it asks again");
  for (const bad of ["", "short", "A".repeat(200), "has space " + "A".repeat(30), "../../x" + "A".repeat(20), null, undefined]) assert.equal(await auth.host(bad), null);
  assert.equal(calls, 2, "a token of the wrong shape is not sent anywhere");
  answer = { status: "unlinked" };
  const U = "B".repeat(43);
  assert.equal(await auth.host(U), null);
  answer = { status: "linked", account: "Late" };
  assert.equal(await auth.host(U), null, "a refusal is remembered for ten seconds");
  clock += 11000;
  assert.equal((await auth.host(U)).name, "Late");
  assert.equal(auth.accountsAvailable, true);
  // the resolver can refuse (a suspended account) or give the real id, and it runs at every check, so a suspension counts at once
  const strict = linkTokenAuth({ statusUrl: "x?token=", getter: async () => ({ status: "linked", account: "Banned" }), resolve: async (n) => (n === "Banned" ? null : { id: 5, name: n }), now: () => clock });
  assert.equal(await strict.host("C".repeat(43)), null);
  let suspended = false;
  let asked = 0;
  const live = linkTokenAuth({ statusUrl: "x?token=", getter: async () => { asked++; return { status: "linked", account: "Neo" }; }, resolve: async (n) => (suspended ? null : { id: 1, name: n }), now: () => clock });
  assert.equal((await live.host("D".repeat(43))).id, 1);
  suspended = true;
  assert.equal(await live.host("D".repeat(43)), null, "suspended: no, although h9web was asked only once");
  suspended = false;
  assert.equal((await live.host("D".repeat(43))).id, 1);
  assert.equal(asked, 1);
  live.forget();
  await live.host("D".repeat(43));
  assert.equal(asked, 2, "forget() makes it ask h9web again");
  // a flood of made-up tokens: the checks that miss the cache are budgeted
  let n = 0;
  const flood = linkTokenAuth({ statusUrl: "x?token=", getter: async () => { n++; return null; }, now: () => clock });
  for (let i = 0; i < 200; i++) await flood.host(crypto.randomBytes(24).toString("base64url"));
  assert.ok(n <= 41, "at most the burst of 40 reached the getter: " + n);
});

test("linkTokenAuth against a real http answer: the status route's own shape", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url, "http://x");
    const t = u.searchParams.get("token");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(t === "L".repeat(43) ? { status: "linked", account: "Trinity" } : { status: "unlinked" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const auth = linkTokenAuth({ statusUrl: "http://127.0.0.1:" + server.address().port + "/api/link/status?token=" });
    assert.deepEqual(await auth.host("L".repeat(43)), { id: "h9:trinity", name: "Trinity" });
    assert.equal(await auth.host("M".repeat(43)), null);
    assert.equal(hits, 2);
    const dead = linkTokenAuth({ statusUrl: "http://127.0.0.1:1/api/link/status?token=" });
    assert.equal(await dead.host("L".repeat(43)), null, "an h9web that does not answer is a no, not a crash");
  } finally { server.close(); }
});

test("a service with the hosts file: a good token opens, a wrong one is 401, and taking a token away ends its sessions", async () => {
  const dir = tmp();
  const file = path.join(dir, "hosts.json");
  const tok = makeToken();
  const mike = addHost(file, { name: "Mike" });
  let svc;
  const auth = hostsFileAuth({ file, recheckMs: 0, onRemoved: (id) => svc.closeAccountSessions(id, "host-removed") });
  svc = createService({ config: { publicUdp: { host: "127.0.0.1", port: 1 }, bind: { udp: { host: "127.0.0.1", port: 0 } } }, auth });
  const server = http.createServer((req, res) => svc.handleHttp(req, res));
  await svc.start();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const open = (t) => httpJson(base, "/v1/host/open", { headers: { Authorization: "Bearer " + t }, body: { v: 1, name: "g" } });
    assert.equal((await open(tok)).status, 401);
    assert.equal((await open("")).status, 401);
    const good = await open(mike.token);
    assert.equal(good.status, 200);
    assert.equal(svc.stats().sessions, 1);
    removeHost(file, mike.id);
    await open(mike.token); // reads the file again (recheckMs 0), finds the host gone, ends its sessions
    assert.equal(svc.stats().sessions, 0, "the host's session ended with its token");
    assert.equal((await open(mike.token)).status, 401);
    const again = addHost(file, { name: "Again" });
    assert.equal((await open(again.token)).status, 200, "a token made after the start works too");
  } finally {
    server.close();
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the relay's config file: what is refused before anything starts", () => {
  const dir = tmp();
  const file = path.join(dir, "relay.config.json");
  const load = (doc, opts) => { write(file, doc); return loadConfig(file, opts); };
  const good = { publicUdp: { host: "relay.example.net", port: 27248 }, auth: { mode: "tokens", hostsFile: "hosts.json" } };
  assert.deepEqual(load(good).problems, []);
  assert.deepEqual(load({ ...good, auth: { mode: "h9web" } }).problems, []);
  assert.match(load({ ...good, auth: { mode: "h9web", url: "https://havoc9.org" } }).problems.join("|"), /auth\.url has moved/);
  assert.match(load({ ...good, publicUdp: { host: PLACEHOLDER + "-name", port: 27248 } }).problems.join("|"), /publicUdp\.host still says CHANGE-ME/);
  assert.match(load({ ...good, publicUdp: { host: "", port: 27248 } }).problems.join("|"), /publicUdp\.host must be/);
  assert.match(load({ ...good, publicUdp: { host: "0.0.0.0", port: 27248 } }).problems.join("|"), /publicUdp\.host must be/);
  assert.match(load({ ...good, publicUdp: { host: "x.example", port: 0 } }).problems.join("|"), /publicUdp\.port/);
  assert.match(load({ publicUdp: good.publicUdp }).problems.join("|"), /auth is missing/);
  assert.match(load({ ...good, auth: { mode: "none" } }).problems.join("|"), /auth\.mode must be/);
  assert.match(load({ ...good, auth: { mode: "tokens" } }).problems.join("|"), /auth\.hostsFile/);
  assert.match(load({ ...good, auth: { mode: "h9web", url: "ftp://x" } }).problems.join("|"), /auth\.url/);
  assert.match(load({ ...good, bind: { udp: { port: 70000 } } }).problems.join("|"), /bind\.udp\.port/);
  assert.match(load({ ...good, bind: { http: { port: 28247, tls: { cert: "no.pem", key: "no.key" } } } }).problems.join("|"), /no file .*no\.pem/);
  assert.match(load("[1]").problems.join("|"), /must hold one JSON object/);
  assert.match(load("{ not json").problems.join("|"), /not valid JSON/);
  assert.match(loadConfig(path.join(dir, "missing.json")).problems.join("|"), /cannot read/);
  assert.deepEqual(load("\uFEFF" + JSON.stringify(good)).problems, [], "a BOM is fine");
  assert.deepEqual(load({ dev: { hosts: { x: { id: 1 } } } }, { dev: true }).problems, [], "--dev needs no auth and no public address");
  assert.deepEqual(load({ enabled: false }).problems, [], "a relay that is switched off needs nothing else");
  assert.deepEqual(load({ ...good, publicPorts: { range: "", max: 0 } }).problems, [], "publicPorts is reserved: unset is fine");
  assert.match(load({ ...good, publicPorts: { range: "28000-28099", max: 0 } }).problems.join("|"), /publicPorts is not implemented yet/);
  assert.match(load({ ...good, publicPorts: { range: "", max: 20 } }).problems.join("|"), /publicPorts is not implemented yet/);
  assert.throws(() => createService({ config: { publicPorts: { max: 5 } } }), /publicPorts is not implemented yet/);
  assert.throws(() => createService({ config: { publicPorts: { range: "28000-28010" } } }), /publicPorts is not implemented yet/);
  assert.doesNotThrow(() => createService({ config: { publicPorts: { range: "", max: 0 } } }));
  assert.equal(loadConfig(file).dir, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
