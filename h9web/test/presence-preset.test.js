// The official preset (modules/presence/preset.js): the plugin list a server reports, the admins' allowlist,
// the verdict the game's server browser draws as a chain, and rated play's gate.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { migrate, transaction } from "../lib/db.js";
import { HttpError, clientIp } from "../lib/http.js";
import { RateLimiter, ipKey } from "../lib/ratelimit.js";
import { serversHook } from "../lib/modules.js";
import { createPresence, MIGRATIONS, DEFAULTS } from "../modules/presence/index.js";
import { readComponents, readEntries } from "../modules/presence/preset.js";
import { writeKeys } from "../modules/presence/keys.js";

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "modules", "presence", "bin", "preset-seed.js");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const CORE_ROOMY = { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY };
const roomy = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
const A = "203.0.113.10:27015";
const B = "198.51.100.20:27016";
const KEYS = { [A]: crypto.randomBytes(32).toString("hex"), [B]: crypto.randomBytes(32).toString("hex") };
const hmacHex = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

// the official build's files, as the report names them
const PRESENCE = { k: "amxx", f: "h9_presence.amxx", v: "1.11", h: hash("h9_presence") };
const MATCH = { k: "amxx", f: "ts_matchmode.amxx", v: "5.0", h: hash("ts_matchmode") };
const TSX = { k: "module", f: "tsx_amxx.dll", v: "", h: hash("tsx") };
const OFFICIAL = [PRESENCE, MATCH, TSX];
const asEntries = (list, extra = {}) => list.map((c) => ({ kind: c.k, file: c.f, sha256: c.h, version: c.v, ...extra }));

async function app() {
  const t = await startApp({ limits: CORE_ROOMY }, { servers: [{ name: "HAVOC 9", address: A }, { name: "HAVOC 9 Siege", address: B }] });
  const clock = { ms: Date.now() };
  migrate(t.app.db, "presence", MIGRATIONS, {});
  const dataDir = path.join(t.config.dataDir, "modules", "presence");
  const core = t.app.accounts;
  const p = createPresence({
    db: t.app.db,
    transaction: (fn) => transaction(t.app.db, fn),
    router: t.app.router.scoped(["/api/presence"]),
    auth: { ...t.app.auth, confirmAdmin: t.app.confirmAdmin },
    accounts: {
      getById: core.getById, getByUsername: core.getByUsername, publicView: core.publicView, isBanned: core.isBanned,
      clientIdIndex: t.app.clientIds.clientIdIndex, verifyIdProof: core.verifyIdProof, nameInUse: core.nameInUse,
    },
    servers: serversHook({ servers: t.app.servers, status: t.app.status }),
    events: t.app.events,
    audit: t.app.audit,
    log: t.app.log.child("presence"),
    settings: { limits: roomy(), cacheSeconds: 0 },
    dataDir,
    http: { HttpError, clientIp: (req) => clientIp(req, t.config.trustProxy) },
    limits: { RateLimiter, ipKey },
    now: () => clock.ms,
  });
  p.start();
  writeKeys(path.join(dataDir, "server-keys.json"), new Map(Object.entries(KEYS).map(([a, key]) => [a, { key, created: "2026-11-01T00:00:00Z" }])));
  p.keys.touch();
  return {
    ...t, p, clock,
    sec: () => Math.floor(clock.ms / 1000),
    advance(seconds) { clock.ms += seconds * 1000; },
    async close() { p.stop(); await t.close(); },
  };
}

// A report as h9_presence.sma signs it; plugins left undefined are not in it.
async function report(t, server, { map = "h9_te_neuropolis", plugins, authenticated, humans } = {}) {
  t.advance(1);
  const fields = { v: 1, server, ts: t.sec(), reason: "tick", map, mode: "Team Elimination", players: [] };
  if (humans !== undefined) fields.humans = humans;
  if (plugins !== undefined) fields.plugins = plugins;
  if (authenticated !== undefined) fields.authenticated = authenticated;
  const body = JSON.stringify(fields);
  const r = await request(t.base, "POST", "/api/presence/report", { body, origin: null, headers: { "x-h9-server": server, "x-h9-signature": hmacHex(KEYS[server], body) } });
  assert.equal(r.status, 200, r.text);
  return r;
}

// the game's browser's read, as { address: code }
async function chains(t) {
  const r = await request(t.base, "GET", "/api/presence/servers/auth");
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers["content-type"], /^text\/plain/);
  const lines = r.text.split("\n");
  assert.equal(lines[0], "H9SRV 1");
  assert.equal(lines[lines.length - 1], "", "ends with a newline");
  return Object.fromEntries(lines.slice(1, -1).map((l) => l.split(" ")));
}

async function adminCookie(t, name = "Oracle") {
  const cookie = await signup(t.base, name);
  t.app.accounts.setRole(t.app.accounts.getByUsername(name).id, "admin");
  return cookie;
}
const post = (t, cookie, route, body) => request(t.base, "POST", "/api/presence/admin/preset/" + route, { body, cookie });

function competeStart(t, server, map = "h9_te_neuropolis") {
  const body = JSON.stringify({ v: 1, server, ts: t.sec(), nonce: crypto.randomBytes(8).toString("hex"), ladder: "match", map, mode: "Team Elimination", humans: 0, bots: 0, players: [] });
  return request(t.base, "POST", "/api/presence/compete/start", { body, origin: null, headers: { "x-h9-server": server, "x-h9-signature": hmacHex(KEYS[server], body) } });
}

describe("preset: reading what a report lists", () => {
  test("a list is read clean, and anything else is not a list", () => {
    assert.deepEqual(readComponents([{ k: "amxx", f: "a.amxx", v: " 1.0\n", h: "AB".repeat(32) }], 10), [{ k: "amxx", f: "a.amxx", v: "1.0", h: "ab".repeat(32) }]);
    assert.deepEqual(readComponents([], 10), []);
    assert.equal(readComponents([{ k: "amxx", f: "a.amxx", h: "" }], 10)[0].h, "", "a file the server could not read has no hash");
    assert.equal(readComponents("x", 10), null);
    assert.equal(readComponents([{ k: "evil", f: "a.amxx", h: "" }], 10), null);
    assert.equal(readComponents([{ k: "amxx", f: "../a.amxx", h: "" }], 10), null);
    assert.equal(readComponents([{ k: "amxx", f: "a.amxx", h: "zz" }], 10), null);
    assert.equal(readComponents([{ k: "amxx", f: "a.amxx", h: "" }, { k: "amxx", f: "b.amxx", h: "" }], 1), null, "too many");
    assert.equal(readComponents([{ k: "amxx", f: "a.amxx", h: "" }, { k: "amxx", f: "A.AMXX", h: "" }], 10).length, 1, "a file twice is one");
  });

  test("an import's entries are checked one by one", () => {
    const bad = (m) => new Error(m);
    assert.throws(() => readEntries([], 10, bad), /1 to 10/);
    assert.throws(() => readEntries([{ kind: "x", file: "a.amxx", sha256: "a".repeat(64) }], 10, bad), /kind/);
    assert.throws(() => readEntries([{ kind: "amxx", file: "dir/a.amxx", sha256: "a".repeat(64) }], 10, bad), /file/);
    assert.throws(() => readEntries([{ kind: "amxx", file: "a.amxx", sha256: "a" }], 10, bad), /sha256/);
    assert.throws(() => readEntries([{ kind: "amxx", file: "a.amxx", sha256: "a".repeat(64), optional: "yes" }], 10, bad), /optional/);
  });
});

describe("preset: the verdict and the browser's list", () => {
  let t;
  let cookie;
  before(async () => {
    t = await app();
    cookie = await adminCookie(t);
  });
  after(() => t.close());

  test("no server is listed before it reports; with no preset kept a reporting server is ok", async () => {
    assert.deepEqual(await chains(t), {});
    await report(t, A);
    await report(t, B);
    assert.deepEqual(await chains(t), { [A]: "ok", [B]: "ok" });
    const view = (await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json;
    assert.equal(view.enforced, false);
  });

  test("a silent server leaves the list", async () => {
    t.advance(DEFAULTS.authFreshSeconds + 10);
    assert.deepEqual(await chains(t), {});
    await report(t, A);
    assert.deepEqual(await chains(t), { [A]: "ok" });
  });

  test("a report counts for authFreshSeconds, and for authQuietSeconds when it said nobody was on", async () => {
    assert.ok(DEFAULTS.authFreshSeconds >= 600, "long enough for a big map to load");
    await report(t, A, { humans: 3 });
    t.advance(DEFAULTS.authFreshSeconds - 5);
    assert.equal((await chains(t))[A], "ok", "inside the window");
    t.advance(10);
    assert.equal((await chains(t))[A], undefined, "past it");
    await report(t, A, { humans: 0 });
    t.advance(DEFAULTS.authFreshSeconds + 10);
    assert.equal((await chains(t))[A], "ok", "an empty server's report counts for longer");
    t.advance(DEFAULTS.authQuietSeconds);
    assert.equal((await chains(t))[A], undefined, "and not for ever");
    await report(t, A);
    assert.equal((await chains(t))[A], "ok");
  });

  test("a server the site hears answering keeps its verdict through any gap between reports", async () => {
    const hear = (address, on) => {
      const e = t.app.servers.byAddress.get(address);
      if (on) t.app.status.state.set(e.target.key, { answer: { name: "x", map: "m", mode: "Match Mode", players: 0, max: 64, bots: 0 }, answeredAt: Date.now() });
      else t.app.status.state.delete(e.target.key);
    };
    await report(t, A, { humans: 0 });
    hear(A, true);
    t.advance(DEFAULTS.authQuietSeconds * 5);
    assert.equal((await chains(t))[A], "ok", "answering the site's own query, so it is what its last report made it");
    t.advance(DEFAULTS.authHoldSeconds - DEFAULTS.authQuietSeconds * 5 - 100);
    assert.equal((await chains(t))[A], "ok", "and nearly a day without a word changes nothing");
    hear(A, false);
    assert.equal((await chains(t))[A], undefined, "not answering, and silent past the window: gone");
    hear(A, true);
    t.advance(200);
    assert.equal((await chains(t))[A], undefined, "a day without a word is not held, answering or not");
    await report(t, A);
    assert.equal((await chains(t))[A], "ok", "its next report makes it what it is again");
    hear(A, false);
  });

  test("a roleplay map is rp, with a preset or without", async () => {
    await report(t, B, { map: "tsrp_hive" });
    assert.equal((await chains(t))[B], "rp");
    await report(t, B, { map: "h9_tsrp_hive" });
    assert.equal((await chains(t))[B], "rp");
    await report(t, B);
  });

  test("the admin imports the official files: a server that lists exactly them is ok, one that lists more or nothing is mod", async () => {
    const r = await post(t, cookie, "import", { entries: asEntries(OFFICIAL) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 3);
    await report(t, A, { plugins: OFFICIAL });
    await report(t, B, { plugins: [...OFFICIAL, { k: "amxx", f: "wallhack.amxx", v: "1", h: hash("wallhack") }] });
    assert.deepEqual(await chains(t), { [A]: "ok", [B]: "mod" });
    const view = (await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json;
    assert.equal(view.enforced, true);
    const b = view.servers.find((s) => s.server === B);
    assert.equal(b.code, "mod");
    assert.deepEqual(b.offending.map((o) => [o.kind, o.file, o.why]), [["amxx", "wallhack.amxx", "not on the official list"]]);
    assert.equal(view.servers.find((s) => s.server === A).offending.length, 0);
  });

  test("a file with another hash is not the official file; a list never given, or unreadable, is mod", async () => {
    await report(t, A, { plugins: [PRESENCE, { ...MATCH, h: hash("ts_matchmode edited") }, TSX] });
    let view = (await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json;
    assert.deepEqual(view.servers.find((s) => s.server === A).offending.map((o) => [o.file, o.why]), [["ts_matchmode.amxx", "not the official file (another hash)"]]);
    await report(t, A, { plugins: [PRESENCE, { k: "amxx", f: "x.amxx", v: "", h: "" }] });
    view = (await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json;
    assert.deepEqual(view.servers.find((s) => s.server === A).offending.map((o) => o.why), ["its file could not be read"]);
    await report(t, A, { plugins: "not a list" });
    assert.equal((await chains(t))[A], "mod");
    assert.equal((await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json.servers.find((s) => s.server === A).why, "its plugin list could not be read");
    // a report with no list leaves what is kept, so a good list stays good until a worse one comes
    await report(t, A, { plugins: OFFICIAL });
    await report(t, A);
    assert.equal((await chains(t))[A], "ok");
  });

  test("a server that never listed anything is mod while a preset is kept", async () => {
    t.app.db.prepare("UPDATE presence_servers SET plugins = NULL, plugins_at = NULL WHERE server = ?").run(A);
    assert.equal((await chains(t))[A], "mod");
    assert.equal((await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json.servers.find((s) => s.server === A).why, "it has not reported its plugin list");
    await report(t, A, { plugins: OFFICIAL });
  });

  test("a held verdict still follows what the server reports: a file off the list makes it modified, the next good list ok", async () => {
    const e = t.app.servers.byAddress.get(A);
    const hear = () => t.app.status.state.set(e.target.key, { answer: { name: "x", map: "m", mode: "Match Mode", players: 0, max: 64, bots: 0 }, answeredAt: Date.now() });
    await report(t, A, { plugins: OFFICIAL, humans: 0 });
    hear();
    t.advance(DEFAULTS.authQuietSeconds * 3);
    assert.equal((await chains(t))[A], "ok", "held with no word at all");
    await report(t, A, { plugins: [...OFFICIAL, { k: "amxx", f: "extra.amxx", v: "1", h: hash("extra") }], humans: 0 });
    hear();
    t.advance(DEFAULTS.authQuietSeconds * 3);
    assert.equal((await chains(t))[A], "mod", "held, but as what its last report made it");
    await report(t, A, { plugins: OFFICIAL, humans: 0 });
    assert.equal((await chains(t))[A], "ok", "and the next good list makes it ok again");
    t.app.status.state.delete(e.target.key);
  });
});

describe("preset: the admins' allowlist", () => {
  let t;
  let cookie;
  before(async () => {
    t = await app();
    cookie = await adminCookie(t);
  });
  after(() => t.close());

  test("only an admin reads or changes it", async () => {
    const plain = await signup(t.base, "plainjoe");
    assert.equal((await request(t.base, "GET", "/api/presence/admin/preset", { cookie: plain })).status, 403);
    assert.equal((await post(t, plain, "import", { entries: asEntries(OFFICIAL) })).status, 403);
    assert.equal((await request(t.base, "GET", "/api/presence/admin/preset")).status, 401);
    assert.equal((await post(t, plain, "remove", { kind: "amxx", file: "a.amxx", sha256: "a".repeat(64) })).status, 403);
  });

  test("a bad import changes nothing", async () => {
    for (const body of [{}, { entries: [] }, { entries: asEntries(OFFICIAL), mode: "merge" }, { entries: [{ kind: "amxx", file: "a.amxx", sha256: "nope" }] }]) {
      assert.equal((await post(t, cookie, "import", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_preset").get().n, 0);
  });

  test("add keeps older hashes official; replace drops them but keeps what an admin added as optional", async () => {
    await post(t, cookie, "import", { entries: asEntries(OFFICIAL) });
    const old = { ...MATCH, h: hash("ts_matchmode old build") };
    await post(t, cookie, "import", { entries: asEntries([old, MATCH]) });
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_preset").get().n, 4, "add keeps the old hash beside the new");
    await post(t, cookie, "import", { entries: [{ kind: "amxx", file: "mine.amxx", sha256: hash("mine"), optional: true, note: "a community's own" }] });
    const r = await post(t, cookie, "import", { mode: "replace", entries: asEntries([PRESENCE]) });
    assert.equal(r.json.total, 2, "the new official file and the optional one");
    const view = (await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json;
    assert.deepEqual(view.entries.map((e) => [e.file, e.optional]).sort(), [["h9_presence.amxx", false], ["mine.amxx", true]]);
    assert.equal(view.entries.find((e) => e.file === "mine.amxx").note, "a community's own");
  });

  test("an entry goes when the admin removes it", async () => {
    const mine = { kind: "amxx", file: "mine.amxx", sha256: hash("mine") };
    assert.equal((await post(t, cookie, "remove", mine)).status, 200);
    assert.equal((await post(t, cookie, "remove", mine)).status, 404);
    assert.equal((await post(t, cookie, "remove", { kind: "amxx", file: "../x", sha256: "a" })).status, 400);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_preset").get().n, 1);
  });

  test("every change is in the audit log", () => {
    const actions = t.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'presence.preset.%'").all().map((r) => r.action);
    assert.ok(actions.includes("presence.preset.import"));
    assert.ok(actions.includes("presence.preset.remove"));
  });
});

describe("preset: the seed tool", () => {
  let build;
  const put = (rel, text) => {
    const file = path.join(build, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return crypto.createHash("sha256").update(text).digest("hex");
  };
  const run = (...args) => spawnSync(process.execPath, [SEED, ...args], { encoding: "utf8" });
  let sums;
  before(() => {
    build = fs.mkdtempSync(path.join(os.tmpdir(), "h9seed-"));
    sums = {
      a: put("ts/addons/amxmodx/plugins/alpha.amxx", "alpha"),
      b: put("ts/addons/amxmodx/plugins/beta.amxx", "beta"),
      m: put("ts/addons/amxmodx/modules/fakemeta_amxx.dll", "fakemeta"),
      x: put("ts/addons/rcbot/dlls/rcbot_mm.dll", "rcbot"),
    };
    put("presets/plugins.Siege.ini", "; plugins\nalpha.amxx ; the first\n;beta.amxx\nmissing.amxx\n");
    put("presets/plugins.Other.ini", "beta.amxx debug\n");
    put("ts/addons/metamod/plugins.ini", "win32 addons/rcbot/dlls/rcbot_mm.dll\n; linux nothing\n");
  });
  after(() => fs.rmSync(build, { recursive: true, force: true }));

  test("it lists the plugins a preset switches on, the modules and the Metamod plugins, with their hashes", () => {
    const r = run("--h9xash", build, "--presets", "Siege", "--note", "a build");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "add");
    assert.deepEqual(out.entries.map((e) => [e.kind, e.file, e.sha256, e.note]), [
      ["amxx", "alpha.amxx", sums.a, "a build"],
      ["meta", "rcbot_mm.dll", sums.x, "a build"],
      ["module", "fakemeta_amxx.dll", sums.m, "a build"],
    ]);
    assert.match(r.stderr, /missing\.amxx/);
    const both = JSON.parse(run("--h9xash", build).stdout).entries.filter((e) => e.kind === "amxx").map((e) => e.file);
    assert.deepEqual(both, ["alpha.amxx", "beta.amxx"], "every tag found by default");
  });

  test("--import writes them into the site's database, the running site sees them without a restart, and the audit log says so", async () => {
    const t = await app();
    try {
      const r = run("--h9xash", build, "--import", "--config", t.configFile);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "", "nothing but the import");
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_preset").get().n, 4);
      assert.ok(t.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'presence.preset.import'").get());
      await report(t, A, { plugins: [{ k: "amxx", f: "alpha.amxx", v: "", h: sums.a }] });
      assert.equal((await chains(t))[A], "ok");
      await report(t, A, { plugins: [{ k: "amxx", f: "alpha.amxx", v: "", h: hash("edited") }] });
      assert.equal((await chains(t))[A], "mod");
      // a later import made behind the running site's back is seen at its next read
      const again = run("--h9xash", build, "--import", "--mode", "replace", "--config", t.configFile);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM presence_preset").get().n, 4, "the same four, not eight");
    } finally {
      await t.close();
    }
  });

  test("it refuses a mode it does not know, and a database that has no migration 12", async () => {
    const t = await app();
    try {
      assert.equal(run("--h9xash", build, "--import", "--mode", "merge", "--config", t.configFile).status, 2);
      t.app.db.prepare("DELETE FROM schema_migrations WHERE module = 'presence' AND version >= 12").run();
      const r = run("--h9xash", build, "--import", "--config", t.configFile);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /presence v11/);
    } finally {
      await t.close();
    }
  });
});

describe("preset: a server that opts out (h9_authenticated 0)", () => {
  let t;
  let cookie;
  before(async () => {
    t = await app();
    cookie = await adminCookie(t);
  });
  after(() => t.close());

  test("with no preset kept, authenticated: false makes the server opt, red, and unrated; the next report without it is ok again", async () => {
    await report(t, A);
    assert.equal((await chains(t))[A], "ok");
    await report(t, A, { authenticated: false });
    assert.equal((await chains(t))[A], "opt");
    const r = await competeStart(t, A);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, "not_rated");
    assert.match(r.json.message, /h9_authenticated 0/);
    await report(t, A);
    assert.equal((await chains(t))[A], "ok");
    assert.equal((await competeStart(t, A)).status, 200);
  });

  test("only the boolean false opts out, true and anything else asks for nothing", async () => {
    for (const v of [true, 0, "0", "false", null, 1]) {
      await report(t, A, { authenticated: v });
      assert.equal((await chains(t))[A], "ok", "authenticated: " + JSON.stringify(v));
    }
  });

  test("the opt-out beats a roleplay map, and the admin's view says why", async () => {
    await report(t, B, { map: "rp_hive", authenticated: false });
    assert.equal((await chains(t))[B], "opt");
    const view = (await request(t.base, "GET", "/api/presence/admin/preset", { cookie })).json;
    const b = view.servers.find((s) => s.server === B);
    assert.equal(b.code, "opt");
    assert.match(b.why, /h9_authenticated 0/);
    await report(t, B, { map: "rp_hive" });
    assert.equal((await chains(t))[B], "rp");
  });

  test("a server never makes itself more authenticated: a preset it does not meet still makes it mod", async () => {
    await post(t, cookie, "import", { entries: asEntries(OFFICIAL) });
    await report(t, A, { plugins: [...OFFICIAL, { k: "amxx", f: "wallhack.amxx", v: "1", h: hash("wallhack") }], authenticated: true });
    assert.equal((await chains(t))[A], "mod");
  });
});

describe("preset: the site's board carries the verdict", () => {
  let t;
  let cookie;
  before(async () => {
    t = await app();
    cookie = await adminCookie(t);
    const answer = { kind: "ip", name: "n", map: "m", mode: "mode", players: 1, max: 8, bots: 0 };
    for (const a of [A, B]) t.app.status.state.set(a, { answer, answeredAt: Date.now(), sentAt: Date.now(), ping: 5 });
  });
  after(() => t.close());

  const board = () => Object.fromEntries(t.app.status.snapshot().servers.map((s) => [s.address, s]));

  test("a board entry says ok, rp, mod or off, and why", async () => {
    assert.equal(board()[A].auth, "off", "it has not reported");
    assert.match(board()[A].authWhy, /not reporting/);
    await report(t, A);
    assert.equal(board()[A].auth, "ok");
    await report(t, B, { map: "rp_hive" });
    assert.equal(board()[B].auth, "rp");
    await post(t, cookie, "import", { entries: asEntries(OFFICIAL) });
    await report(t, A, { plugins: [...OFFICIAL, { k: "meta", f: "evil_mm.dll", v: "", h: hash("evil") }] });
    assert.equal(board()[A].auth, "mod");
    assert.match(board()[A].authWhy, /off the official list/);
    await report(t, A, { plugins: OFFICIAL });
    assert.equal(board()[A].auth, "ok");
  });

  test("the poller's own fields win, and a note that throws adds nothing", () => {
    const off = t.app.status.boardNotes;
    const add = (fn) => { off.add(fn); return () => off.delete(fn); };
    const drop = [add(() => ({ address: "elsewhere", players: 99, extra: 1 })), add(() => { throw new Error("a module's own trouble"); })];
    const entry = board()[A];
    assert.equal(entry.address, A);
    assert.equal(entry.players, 1);
    assert.equal(entry.extra, 1);
    for (const d of drop) d();
  });

  test("the presence module takes its note off the board when it stops", () => {
    assert.ok(t.app.status.boardNotes.size >= 1);
    t.p.stop();
    assert.equal(t.app.status.boardNotes.size, 0);
    assert.equal(board()[A].auth, undefined);
  });
});

describe("preset: rated play needs an authenticated server", () => {
  let t;
  let cookie;
  before(async () => {
    t = await app();
    cookie = await adminCookie(t);
  });
  after(() => t.close());

  test("with no preset kept a match starts as before", async () => {
    const r = await competeStart(t, A);
    assert.equal(r.status, 200, r.text);
  });

  test("a server that runs the official files rates; one that does not is refused 409 not_rated, and the match is never made", async () => {
    await post(t, cookie, "import", { entries: asEntries(OFFICIAL) });
    await report(t, A, { plugins: OFFICIAL });
    await report(t, B, { plugins: [...OFFICIAL, { k: "amxx", f: "wallhack.amxx", v: "1", h: hash("wallhack") }] });
    assert.equal((await competeStart(t, A)).status, 200);
    const before = t.app.db.prepare("SELECT count(*) AS n FROM compete_matches WHERE server = ?").get(B).n;
    const r = await competeStart(t, B);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, "not_rated");
    assert.match(r.json.message, /official preset/);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM compete_matches WHERE server = ?").get(B).n, before);
  });

  test("the modified server rates again once it runs the official files", async () => {
    await report(t, B, { plugins: OFFICIAL });
    assert.equal((await competeStart(t, B)).status, 200);
  });
});
