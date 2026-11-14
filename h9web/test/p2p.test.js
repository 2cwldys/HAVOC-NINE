// The P2P module (modules/p2p) inside the real h9web: off by default and clean when off, the host's link token, the signed host calls,
// the public list and its guest invites (with the site's CSRF guard and the visitor's account), the UDP socket, and what an account
// ban does to a host's session. The relay itself (p2p/lib/service.js) has its own tests in p2p/test; this is the glue.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dgram from "node:dgram";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, request, signup } from "./helpers.js";
import { encode, decodeHeader, helloPayload, T, F_HOST } from "../../p2p/lib/wire.js";

const MODULES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "modules");
const ROOMY = { max: 1000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const roomyLimits = {
  signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY,
  linkStartPerIp: ROOMY, linkPollPerIp: ROOMY, linkStatusPerIp: ROOMY, linkCodePerAccount: ROOMY, linkCodePerIp: ROOMY,
};
const DEVICE = "9dca7efc8a5cfe1677a2df1cf4731c6f";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function freeUdpPort() {
  const s = dgram.createSocket("udp4");
  await new Promise((r) => s.bind(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// a game links to the account: the link token it keeps
async function link(t, cookie) {
  const s = await request(t.base, "GET", "/api/link/start?v=1&device=" + DEVICE + "&os=windows", { origin: null });
  assert.equal(s.json.status, "ok");
  const a = await request(t.base, "POST", "/api/link/approve", { body: { code: s.json.userCode }, cookie });
  assert.equal(a.status, 200, a.text);
  const p = await request(t.base, "GET", "/api/link/poll?code=" + encodeURIComponent(s.json.deviceCode), { origin: null });
  assert.equal(p.json.status, "approved");
  return p.json.token;
}

const P2P = "/api/p2p";
const open = (t, token, body = { v: 1, name: "Neo's game" }) => request(t.base, "POST", P2P + "/v1/host/open", { origin: null, headers: { Authorization: "Bearer " + token }, body });

// a signed host call, the way the helper makes it: the signature covers the service's own path (/v1/...), not the /api/p2p mount
function signed(t, sess, p, body = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Date.now());
  const n = crypto.randomBytes(8).toString("hex");
  const m = crypto.createHmac("sha256", Buffer.from(sess.hostKey, "base64url")).update("POST\n" + p + "\n" + ts + "\n" + n + "\n" + crypto.createHash("sha256").update(raw).digest("hex")).digest("hex");
  return request(t.base, "POST", P2P + p, { origin: null, body, headers: { "X-H9-Sig": "s=" + sess.session + ";t=" + ts + ";n=" + n + ";m=" + m } });
}

describe("p2p module: off", () => {
  test("not listed in modules: nothing is mounted", async () => {
    const t = await startApp({}, { modulesDir: MODULES });
    try {
      assert.equal((await request(t.base, "GET", P2P + "/v1/health", { origin: null })).status, 404);
    } finally { await t.close(); }
  });

  test("listed but not enabled: no route, no socket, and the log says why", async () => {
    const t = await startApp({ modules: ["p2p"], moduleSettings: { p2p: { publicUdp: { host: "play.example.org", port: 27248 } } } }, { modulesDir: MODULES });
    try {
      assert.equal((await request(t.base, "GET", P2P + "/v1/health", { origin: null })).status, 404);
      assert.equal((await request(t.base, "GET", P2P + "/public", { origin: null })).status, 404);
      assert.ok(t.logs.some((l) => l.includes("p2p.off")), "p2p.off is logged");
      assert.ok(!t.logs.some((l) => l.includes("p2p.on")));
    } finally { await t.close(); }
  });

  test("enabled but unfinished (no public name for the UDP port, or no relay code): it stays off and the site stays up", async () => {
    let t = await startApp({ modules: ["p2p"], moduleSettings: { p2p: { enabled: true } } }, { modulesDir: MODULES });
    try {
      assert.equal((await request(t.base, "GET", P2P + "/v1/health", { origin: null })).status, 404);
      assert.ok(t.logs.some((l) => l.includes("p2p.off") && l.includes("publicUdp.host")));
      assert.equal((await request(t.base, "GET", "/api/me", { origin: null })).status, 200, "the rest of h9web is fine");
    } finally { await t.close(); }
    t = await startApp({ modules: ["p2p"], moduleSettings: { p2p: { enabled: true, publicUdp: { host: "CHANGE-ME.example.org", port: 27248 } } } }, { modulesDir: MODULES });
    try {
      assert.equal((await request(t.base, "GET", P2P + "/v1/health", { origin: null })).status, 404);
    } finally { await t.close(); }
    t = await startApp({ modules: ["p2p"], moduleSettings: { p2p: { enabled: true, publicPorts: { range: "28000-28099", max: 5 }, publicUdp: { host: "play.example.org", port: 27248 } } } }, { modulesDir: MODULES });
    try {
      assert.equal((await request(t.base, "GET", P2P + "/v1/health", { origin: null })).status, 404);
      assert.ok(t.logs.some((l) => l.includes("p2p.off") && l.includes("publicPorts is not implemented yet")), "the reserved keys keep the module off, with the reason in the log");
      assert.equal((await request(t.base, "GET", "/api/me", { origin: null })).status, 200, "and h9web starts");
    } finally { await t.close(); }
    t = await startApp({ modules: ["p2p"], moduleSettings: { p2p: { enabled: true, libDir: path.join(MODULES, "no-such-folder"), publicUdp: { host: "play.example.org", port: 27248 } } } }, { modulesDir: MODULES });
    try {
      assert.equal((await request(t.base, "GET", P2P + "/v1/health", { origin: null })).status, 404);
      assert.ok(t.logs.some((l) => l.includes("p2p.off") && l.includes("is missing")));
    } finally { await t.close(); }
  });
});

describe("p2p module: on", () => {
  let t;
  let udp;
  let neo;
  let trin;
  let neoToken;
  before(async () => {
    udp = await freeUdpPort();
    t = await startApp({
      limits: roomyLimits, link: { maxPendingPerIp: 1000 }, modules: ["p2p"],
      moduleSettings: { p2p: {
        enabled: true, allowPrivatePeers: true, publicUdp: { host: "127.0.0.1", port: udp }, bind: { udp: { host: "127.0.0.1", port: udp } },
        limits: { publicJoinPerIp: ROOMY, publicFailPerIp: ROOMY, publicListPerIp: ROOMY },
      } },
    }, { modulesDir: MODULES });
    neo = await signup(t.base, "Neo");
    trin = await signup(t.base, "Trinity");
    neoToken = await link(t, neo);
  });
  after(async () => { await t.close(); });

  test("the routes answer under /api/p2p, the health says what is on, a wrong or missing token is a 401", async () => {
    assert.ok(t.logs.some((l) => l.includes("p2p.on")));
    const h = await request(t.base, "GET", P2P + "/v1/health", { origin: null });
    assert.equal(h.status, 200);
    assert.deepEqual(h.json, { ok: true, v: 1, direct: true, relay: true, listing: true });
    assert.equal((await open(t, "A".repeat(43))).status, 401, "a token no account holds");
    assert.equal((await request(t.base, "POST", P2P + "/v1/host/open", { origin: null, body: { v: 1 } })).status, 401, "no token");
    assert.equal((await request(t.base, "POST", P2P + "/v1/host/open", { origin: null, headers: { Authorization: "Bearer short" }, body: { v: 1 } })).status, 401, "a token of the wrong shape");
    assert.equal((await request(t.base, "GET", P2P + "/v1/host/open", { origin: null })).status, 405);
  });

  test("a linked game opens a session with its link token, signs its calls, and the friend redeems an invite with no Origin and no cookie", async () => {
    const o = await open(t, neoToken);
    assert.equal(o.status, 200, o.text);
    assert.equal(o.json.udp.port, udp);
    assert.ok(o.json.session && o.json.hostKey && o.json.ctl);
    const inv = await signed(t, o.json, "/v1/host/invite", { label: "Trinity", ttl: 60 });
    assert.equal(inv.status, 200, inv.text);
    assert.match(inv.json.code, /^H9-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    assert.equal((await request(t.base, "POST", P2P + "/v1/host/invite", { origin: null, body: { label: "x" } })).status, 401, "unsigned");
    const red = await request(t.base, "POST", P2P + "/v1/join/redeem", { origin: null, body: { v: 1, code: inv.json.code } });
    assert.equal(red.status, 200, red.text);
    assert.equal(red.json.udp.port, udp);
    const ev = await signed(t, o.json, "/v1/host/poll", { wait: 1 });
    const joiner = ev.json.events.find((e) => e.t === "joiner");
    assert.equal(joiner.label, "Trinity");
    assert.equal((await request(t.base, "POST", P2P + "/v1/join/redeem", { origin: null, body: { v: 1, code: inv.json.code } })).status, 404, "one use");
    assert.equal((await signed(t, o.json, "/v1/host/close", {})).status, 200);
  });

  test("the data plane is a live UDP socket in this process: a signed HELLO of the host's session is answered, a forged one is not", async () => {
    const o = await open(t, neoToken);
    const key = Buffer.from(o.json.hostKey, "base64url");
    const s = dgram.createSocket("udp4");
    await new Promise((r) => s.bind(0, "127.0.0.1", r));
    try {
      const got = [];
      s.on("message", (m) => got.push(m));
      const hello = (k, seq) => encode({ type: T.HELLO, flags: F_HOST, flow: o.json.ctl, seq, payload: helloPayload(crypto.randomBytes(8)) }, k);
      s.send(hello(crypto.randomBytes(32), 1), udp, "127.0.0.1");
      await wait(300);
      assert.equal(got.length, 0, "a HELLO signed with the wrong key gets no answer");
      s.send(hello(key, 2), udp, "127.0.0.1");
      const end = Date.now() + 2000;
      while (!got.length && Date.now() < end) await wait(20);
      assert.equal(got.length, 1);
      assert.equal(decodeHeader(got[0]).type, T.HELLO_ACK);
    } finally { s.close(); }
    await signed(t, o.json, "/v1/host/close", {});
  });

  test("the public list: a host lists its game, both paths of the list answer, and the guest invite is for the site's own pages (CSRF) and carries the signed-in account", async () => {
    const o = await open(t, neoToken);
    const l = await signed(t, o.json, "/v1/host/listing", { public: true, name: "Neo's hive", map: "h9_tsrp_hive", players: 2, max: 16, password: false });
    assert.equal(l.status, 200, l.text);
    assert.equal(l.json.ttl, 45);
    await wait(5100); // the list is computed once per 5 seconds
    for (const p of ["/public", "/v1/public"]) {
      const g = await request(t.base, "GET", P2P + p, { origin: null });
      assert.equal(g.status, 200);
      assert.deepEqual(g.json.sessions, [{ id: l.json.id, name: "Neo's hive", map: "h9_tsrp_hive", players: 2, max: 16, password: false, direct: false, account: false }]);
      assert.ok(!g.text.includes(o.json.session) && !g.text.includes("127.0.0.1"), "no session id and no address in the list");
    }
    const noOrigin = await request(t.base, "POST", P2P + "/public/join", { origin: null, body: { session: l.json.id } });
    assert.equal(noOrigin.status, 403, "the guest invite is asked for by the site's pages");
    assert.equal(noOrigin.json.error, "csrf");
    const elsewhere = await request(t.base, "POST", P2P + "/public/join", { origin: "https://evil.example", body: { session: l.json.id } });
    assert.equal(elsewhere.status, 403);
    const anon = await request(t.base, "POST", P2P + "/public/join", { body: { session: l.json.id } });
    assert.equal(anon.status, 200, anon.text);
    assert.match(anon.json.code, /^H9-/);
    assert.equal(anon.json.ttl, 600);
    const signedIn = await request(t.base, "POST", P2P + "/v1/public/join", { cookie: trin, body: { session: l.json.id } });
    assert.equal(signedIn.status, 200, signedIn.text);
    const red = await request(t.base, "POST", P2P + "/v1/join/redeem", { origin: null, body: { v: 1, code: signedIn.json.code } });
    assert.equal(red.status, 200);
    const ev = (await signed(t, o.json, "/v1/host/poll", { wait: 1 })).json.events.find((e) => e.t === "joiner");
    assert.equal(ev.public, true);
    assert.equal(ev.label, "public");
    assert.equal(ev.account.name, "Trinity", "the host sees which havoc9.org account the guest is");
    assert.equal((await request(t.base, "POST", P2P + "/public/join", { body: { session: "nope" } })).status, 404);
    await signed(t, o.json, "/v1/host/close", {});
  });

  test("a listing that needs an account: the visitor must be signed in", async () => {
    const o = await open(t, neoToken);
    const l = await signed(t, o.json, "/v1/host/listing", { public: true, name: "Accounts only", map: "ts_dojo", players: 0, max: 8, requireAccount: true });
    assert.equal(l.status, 200, l.text);
    const anon = await request(t.base, "POST", P2P + "/public/join", { body: { session: l.json.id } });
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.json, { error: "account required" });
    const ok = await request(t.base, "POST", P2P + "/public/join", { cookie: trin, body: { session: l.json.id } });
    assert.equal(ok.status, 200, ok.text);
    await signed(t, o.json, "/v1/host/close", {});
  });

  test("a suspended account loses its host session at once, and cannot open another", async () => {
    const o = await open(t, neoToken);
    assert.equal((await signed(t, o.json, "/v1/host/invite", {})).status, 200);
    const neoRow = t.app.accounts.getByUsername("Neo");
    t.app.accounts.ban(neoRow.id, Math.floor(Date.now() / 1000) + 3600, "test");
    assert.equal((await signed(t, o.json, "/v1/host/invite", {})).status, 401, "the session ended with the suspension");
    assert.equal((await open(t, neoToken)).status, 401, "and the same token cannot open another while the account is suspended, although the link check was just made");
    t.app.accounts.unban(neoRow.id);
    assert.equal((await open(t, neoToken)).status, 200, "it can when the suspension is over");
  });

  test("a game that is unlinked on the account page loses its host session at once, and its token opens nothing more", async () => {
    const token = await link(t, trin);
    const o = await open(t, token);
    assert.equal(o.status, 200, o.text);
    assert.equal((await signed(t, o.json, "/v1/host/invite", {})).status, 200);
    const devices = await request(t.base, "GET", "/api/link/devices", { cookie: trin, origin: null });
    assert.equal(devices.status, 200, devices.text);
    const id = devices.json.devices.find((d) => d.linked !== false).id;
    const revoke = await request(t.base, "POST", "/api/link/devices/" + id + "/revoke", { body: {}, cookie: trin });
    assert.equal(revoke.status, 200, revoke.text);
    assert.equal((await signed(t, o.json, "/v1/host/invite", {})).status, 401, "the session ended with the link");
    assert.equal((await open(t, token)).status, 401, "and the token is refused, not remembered");
  });
});

describe("p2p module: stop", () => {
  test("stopping h9web closes the UDP port and takes the listeners off", async () => {
    const udp = await freeUdpPort();
    const t = await startApp({ modules: ["p2p"], moduleSettings: { p2p: { enabled: true, allowPrivatePeers: true, publicUdp: { host: "127.0.0.1", port: udp }, bind: { udp: { host: "127.0.0.1", port: udp } } } } }, { modulesDir: MODULES });
    const events = t.app.events;
    const before = events.listenerCount("account-banned");
    const taken = dgram.createSocket("udp4");
    await assert.rejects(new Promise((res, rej) => { taken.once("error", rej); taken.bind(udp, "127.0.0.1", res); }), /EADDRINUSE/, "the module holds the port while it runs");
    taken.close();
    await t.close();
    assert.ok(events.listenerCount("account-banned") < before, "the module's listeners are gone");
    const after = dgram.createSocket("udp4");
    await new Promise((res, rej) => { after.once("error", rej); after.bind(udp, "127.0.0.1", res); });
    after.close();
  });
});
