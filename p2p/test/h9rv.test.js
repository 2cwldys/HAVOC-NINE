// The standalone runner as a process: what it refuses, what --check says, a relay run from a config and a hosts file (a token added
// while it runs works, one removed ends its sessions), the token command, and TLS where openssl is at hand.
//   node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { httpJson } from "../lib/helper.js";

const H9RV = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "h9rv.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "h9rv-"));
const run = (args, opts = {}) => spawnSync(process.execPath, [H9RV, ...args], { encoding: "utf8", timeout: 20000, ...opts });

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// a relay process; resolves when it logs "listening" and gives the ports it took
async function relay(dir, over = {}, extra = []) {
  const httpPort = await freePort();
  const cfg = {
    publicUdp: { host: "127.0.0.1", port: 27369 },
    bind: { http: { host: "127.0.0.1", port: httpPort }, udp: { host: "127.0.0.1", port: 0 } },
    allowPrivatePeers: true,
    auth: { mode: "tokens", hostsFile: "hosts.json" },
    ...over,
  };
  fs.writeFileSync(path.join(dir, "relay.config.json"), JSON.stringify(cfg));
  const child = spawn(process.execPath, [H9RV, "--config", path.join(dir, "relay.config.json"), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  let err = "";
  child.stdout.on("data", (c) => out.push(...String(c).split("\n").filter(Boolean)));
  child.stderr.on("data", (c) => { err += c; });
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));
  const end = Date.now() + 10000;
  let listening = null;
  while (Date.now() < end && !listening) {
    for (const line of out) {
      try { const j = JSON.parse(line); if (j.event === "listening") listening = j; } catch (e) { /* not a log line */ }
    }
    if (!listening) await wait(25);
  }
  if (!listening) {
    child.kill();
    throw new Error("the relay did not start: " + err + out.join("\n"));
  }
  const base = (cfg.bind.http.tls ? "https" : "http") + "://127.0.0.1:" + listening.http.port;
  return {
    child, base, listening, out, exited, httpPort,
    stats: async () => (await httpJson(base, "/v1/stats", { method: "GET" })).json,
    async stop() { child.kill(); await exited; },
  };
}

test("it refuses to start without an auth, with the example's CHANGE-ME values, with a missing or empty hosts file", () => {
  const dir = tmp();
  const cfg = path.join(dir, "relay.config.json");
  const w = (doc) => fs.writeFileSync(cfg, JSON.stringify(doc));
  const good = { publicUdp: { host: "127.0.0.1", port: 27369 }, auth: { mode: "tokens", hostsFile: "hosts.json" } };
  let r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--config .* is needed/);
  w({ publicUdp: good.publicUdp });
  r = run(["--config", cfg]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /auth is missing/, "no auth and no --dev: no start, no default credentials");
  w({ ...good, publicUdp: { host: "CHANGE-ME-relay.example.org", port: 27248 } });
  r = run(["--config", cfg]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /publicUdp\.host still says CHANGE-ME/);
  w(good);
  r = run(["--config", cfg]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /hosts file .* does not exist/);
  fs.writeFileSync(path.join(dir, "hosts.json"), JSON.stringify({ "CHANGE-ME-run-h9rv-token": { id: 1, name: "example" } }));
  r = run(["--config", cfg]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /example token \(CHANGE-ME/);
  assert.ok(!/CHANGE-ME-run-h9rv-token/.test(r.stderr), "the entry's own text is not echoed");
  fs.writeFileSync(path.join(dir, "hosts.json"), "{}");
  r = run(["--config", cfg]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no host token in it yet/);
  w({ ...good, auth: { mode: "h9web", url: "gopher://x" } });
  assert.equal(run(["--config", cfg]).status, 2);
  // h9web mode: the site's address is the environment's (relay.site.ini through run.bat), and a start without it says so
  w({ ...good, auth: { mode: "h9web" } });
  const noSite = { ...process.env };
  delete noSite.H9RV_SITE_URL;
  r = run(["--config", cfg], { env: noSite });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /H9RV_SITE_URL/);
  r = run(["--config", cfg], { env: { ...noSite, H9RV_SITE_URL: "gopher://x" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /H9RV_SITE_URL/);
  fs.writeFileSync(path.join(dir, "hosts.json"), JSON.stringify({ ["h9t_" + "q".repeat(32)]: { id: 1, name: "Mike" } }));
  w({ ...good, publicPorts: { range: "28000-28099", max: 10 } });
  r = run(["--config", cfg]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /publicPorts is not implemented yet/, "the reserved keys stop the start with a sentence");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--check reads the config and the hosts file and starts nothing; enabled false listens to nothing", async () => {
  const dir = tmp();
  const cfg = path.join(dir, "relay.config.json");
  const port = await freePort();
  fs.writeFileSync(cfg, JSON.stringify({ publicUdp: { host: "relay.example.net", port: 27248 }, bind: { http: { host: "0.0.0.0", port }, udp: { host: "0.0.0.0", port: 0 } }, auth: { mode: "tokens", hostsFile: "hosts.json" } }));
  const add = run(["token", "Mike", "--hosts", path.join(dir, "hosts.json")]);
  assert.equal(add.status, 0, add.stderr);
  const r = run(["--config", cfg, "--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tokens \(.*hosts\.json, 1 host\)/);
  assert.match(r.stdout, /players are told relay\.example\.net:27248/);
  assert.match(r.stdout, /public list on/);
  assert.match(r.stdout, /NOTE: plain http on a public address/);
  const s = net.createServer();
  await new Promise((res, rej) => { s.once("error", rej); s.listen(port, "127.0.0.1", res); }); // the port is free: --check bound nothing
  await new Promise((res) => s.close(res));
  fs.writeFileSync(cfg, JSON.stringify({ enabled: false }));
  const off = run(["--config", cfg]);
  assert.equal(off.status, 0);
  assert.match(off.stderr, /enabled is false: nothing listens/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a relay run from a config and a hosts file: a token opens a session and lists it; one added while it runs works, one removed ends its sessions", async () => {
  const dir = tmp();
  const hosts = path.join(dir, "hosts.json");
  const mike = run(["token", "Mike", "--hosts", hosts]).stdout.match(/h9t_[A-Za-z0-9_-]{32}/)[0];
  const r = await relay(dir);
  try {
    assert.equal(r.listening.auth, "tokens");
    assert.equal(r.listening.listing, true);
    const open = (t) => httpJson(r.base, "/v1/host/open", { headers: { Authorization: "Bearer " + t }, body: { v: 1, name: "Mike's game" } });
    assert.equal((await open("h9t_" + "z".repeat(32))).status, 401);
    const o = await open(mike);
    assert.equal(o.status, 200);
    const key = Buffer.from(o.json.hostKey, "base64url");
    const sign = (p, body) => {
      const raw = Buffer.from(JSON.stringify(body));
      const t = String(Date.now());
      const n = crypto.randomBytes(8).toString("hex");
      const m = crypto.createHmac("sha256", key).update("POST\n" + p + "\n" + t + "\n" + n + "\n" + crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.from("body\n"), raw])).digest("hex")).digest("hex");
      return { "X-H9-Sig": "s=" + o.json.session + ";t=" + t + ";n=" + n + ";m=" + m };
    };
    const listing = { public: true, name: "Mike's game", map: "h9_tsrp_hive", players: 1, max: 16, password: false };
    const l = await httpJson(r.base, "/v1/host/listing", { headers: sign("/v1/host/listing", listing), body: listing });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    assert.equal(l.json.ttl, 45);
    const pub = await httpJson(r.base, "/v1/public", { method: "GET" });
    assert.equal(pub.json.sessions.length, 1);
    assert.equal(pub.json.sessions[0].id, l.json.id);
    // /v1/stats answers a caller on this machine, and nobody a proxy forwarded
    assert.equal((await r.stats()).sessions, 1);
    assert.equal((await httpJson(r.base, "/v1/stats", { method: "GET", headers: { "X-Real-IP": "1.2.3.4" } })).status, 405);

    // a token added while it runs
    await wait(2300);
    const anna = run(["token", "Anna", "--no-public", "--hosts", hosts]).stdout.match(/h9t_[A-Za-z0-9_-]{32}/)[0];
    const oa = await open(anna);
    assert.equal(oa.status, 200, "picked up without a restart");
    const key2 = Buffer.from(oa.json.hostKey, "base64url");
    const lb = { public: true, name: "x" };
    const raw2 = Buffer.from(JSON.stringify(lb));
    const t2 = String(Date.now());
    const m2 = crypto.createHmac("sha256", key2).update("POST\n/v1/host/listing\n" + t2 + "\nn2\n" + crypto.createHash("sha256").update(raw2).digest("hex")).digest("hex");
    const denied = await httpJson(r.base, "/v1/host/listing", { headers: { "X-H9-Sig": "s=" + oa.json.session + ";t=" + t2 + ";n=n2;m=" + m2 }, body: lb });
    assert.equal(denied.status, 403, "hosts.json public false: this token may not list");
    assert.deepEqual(denied.json, { error: "listing disabled" });

    // a token removed while it runs: its sessions end within the runner's 5-second look
    assert.match(run(["hosts", "remove", "1", "--hosts", hosts]).stdout, /removed 1 token/);
    const end = Date.now() + 9000;
    let sessions = (await r.stats()).sessions;
    while (sessions > 1 && Date.now() < end) { await wait(250); sessions = (await r.stats()).sessions; }
    assert.equal(sessions, 1, "Mike's session ended with his token (Anna's is still there)");
    assert.equal((await open(mike)).status, 401);
    assert.equal((await httpJson(r.base, "/v1/public", { method: "GET" })).json.sessions.length, 0, "and so did his entry");
  } finally { await r.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the token command: shown once, the file keeps the hash; hosts list shows no token; an unknown host is said so", () => {
  const dir = tmp();
  const hosts = path.join(dir, "hosts.json");
  fs.writeFileSync(hosts, JSON.stringify({ "CHANGE-ME-example": { id: 1, name: "example" } }));
  const a = run(["token", "Mike", "the", "host", "--hosts", hosts]);
  assert.equal(a.status, 0, a.stderr);
  const token = a.stdout.match(/h9t_[A-Za-z0-9_-]{32}/)[0];
  assert.match(a.stdout, /host 1 \(Mike the host\) added/);
  assert.ok(!fs.readFileSync(hosts, "utf8").includes(token));
  const list = run(["hosts", "list", "--hosts", hosts]);
  assert.match(list.stdout, /1 +Mike the host +sha256:/);
  assert.ok(!list.stdout.includes(token));
  assert.match(run(["hosts", "remove", "7", "--hosts", hosts]).stdout, /no host 7/);
  assert.equal(run(["token", "--hosts", hosts]).status, 2, "a token needs a name");
  assert.equal(run(["token", "x"]).status, 2, "and a hosts file");
  assert.equal(run(["hosts", "list"]).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a port that is taken is said in a sentence, with exit 1", async () => {
  const dir = tmp();
  run(["token", "Mike", "--hosts", path.join(dir, "hosts.json")]);
  const busy = http.createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  const port = busy.address().port;
  fs.writeFileSync(path.join(dir, "relay.config.json"), JSON.stringify({ publicUdp: { host: "127.0.0.1", port: 27369 }, bind: { http: { host: "127.0.0.1", port }, udp: { host: "127.0.0.1", port: 0 } }, auth: { mode: "tokens", hostsFile: "hosts.json" } }));
  const r = run(["--config", path.join(dir, "relay.config.json")]);
  busy.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot listen: .*EADDRINUSE/);
  assert.ok(!/at .*\.js:\d+/.test(r.stderr), "no stack trace");
  fs.rmSync(dir, { recursive: true, force: true });
});

const haveOpenssl = (() => { try { return spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0; } catch (e) { return false; } })();
test("TLS: with bind.http.tls the control plane is https (needs openssl to make a throw-away certificate)", { skip: !haveOpenssl && "no openssl on this machine" }, async () => {
  const dir = tmp();
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const mk = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  run(["token", "Mike", "--hosts", path.join(dir, "hosts.json")]);
  const port = await freePort();
  const r = await relay(dir, { bind: { http: { host: "127.0.0.1", port, tls: { cert: "cert.pem", key: "key.pem" } }, udp: { host: "127.0.0.1", port: 0 } } });
  try {
    assert.equal(r.listening.http.tls, true);
    const body = await new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port, path: "/v1/health", ca: fs.readFileSync(cert) }, (res) => {
        let s = "";
        res.on("data", (c) => { s += c; });
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(s) }));
      }).on("error", reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.json.ok, true);
    const plain = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/v1/health", timeout: 2000 }, (res) => resolve(res.statusCode)).on("error", () => resolve("refused")).on("timeout", function () { this.destroy(); }));
    assert.notEqual(plain, 200, "plain http on the https port is not an answer");
  } finally { await r.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
