import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { startApp, request, signup, until } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const CLIENT = "111111111111111111";
const GUILD = "222222222222222222";
const ROLE = "1566395367036035123";
const SECRET = "client-secret-" + crypto.randomBytes(8).toString("hex");
const BOT = "bot-token-" + crypto.randomBytes(8).toString("hex");
const REDIRECT = "https://havoc9.test/api/discord/callback";

// A stand-in for Discord's API: OAuth2 token exchange, /users/@me, and the guild member routes.
function fakeDiscord() {
  const st = { codes: new Map(), tokens: new Map(), members: new Map(), calls: [], limitRoles: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const body = Buffer.concat(chunks).toString("utf8");
      st.calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || "", reason: req.headers["x-audit-log-reason"] || "", body });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      if (req.method === "POST" && url.pathname === "/api/oauth2/token") {
        const f = new URLSearchParams(body);
        if (f.get("client_id") !== CLIENT || f.get("client_secret") !== SECRET || f.get("grant_type") !== "authorization_code" || f.get("redirect_uri") !== REDIRECT) return send(401, { error: "invalid_client" });
        const user = st.codes.get(f.get("code"));
        if (!user) return send(400, { error: "invalid_grant" });
        st.codes.delete(f.get("code"));
        const token = "access-" + crypto.randomBytes(8).toString("hex");
        st.tokens.set(token, user);
        return send(200, { access_token: token, token_type: "Bearer", scope: "identify", expires_in: 604800 });
      }
      if (req.method === "GET" && url.pathname === "/api/users/@me") {
        const user = st.tokens.get((req.headers.authorization || "").replace(/^Bearer /, ""));
        return user ? send(200, { id: user.id, username: user.username, global_name: user.global || null }) : send(401, { code: 0 });
      }
      if (req.headers.authorization !== "Bot " + BOT) return send(401, { code: 0 });
      let m = /^\/api\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/.exec(url.pathname);
      if (m) {
        if (st.limitRoles > 0) {
          st.limitRoles--;
          return send(429, { message: "You are being rate limited.", retry_after: 0.05, global: false }, { "retry-after": "0.05" });
        }
        const roles = st.members.get(m[2]);
        if (m[1] !== GUILD || !roles) return send(404, { message: "Unknown Member", code: 10007 });
        if (req.method === "PUT") roles.add(m[3]);
        else roles.delete(m[3]);
        return send(204);
      }
      m = /^\/api\/guilds\/(\d+)\/members\/(\d+)$/.exec(url.pathname);
      if (m && req.method === "GET") {
        const roles = st.members.get(m[2]);
        return roles ? send(200, { user: { id: m[2] }, roles: [...roles] }) : send(404, { message: "Unknown Member", code: 10007 });
      }
      if (url.pathname === "/api/guilds/" + GUILD + "/members" && req.method === "GET") {
        const after = BigInt(url.searchParams.get("after") || "0");
        const list = [...st.members.entries()].filter(([id]) => BigInt(id) > after).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1))
          .map(([id, roles]) => ({ user: { id }, roles: [...roles] }));
        return send(200, list);
      }
      send(404, { code: 0 });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ st, server, base: "http://127.0.0.1:" + server.address().port + "/api" })));
}

function secretsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-discord-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(file, JSON.stringify({ clientSecret: SECRET, botToken: BOT }), { mode: 0o600 });
  return { dir, file };
}

async function discordApp(fake, file, extra = {}) {
  return startApp({
    modules: ["discord"],
    limits: { signupPerIp: ROOMY, loginPerIp: ROOMY },
    moduleSettings: { discord: { clientId: CLIENT, guildId: GUILD, redirectUri: REDIRECT, secretsFile: file, apiBase: fake.base, authorizeUrl: fake.base.replace("/api", "") + "/oauth2/authorize", ...extra } },
  }, { modulesDir: MODULES });
}

const userId = () => String(300000000000000000n + BigInt(crypto.randomInt(1, 1e9)));

describe("Discord: linking and the registered role", () => {
  let t;
  let fake;
  let secrets;
  const people = {};
  async function make(name, role) {
    const cookie = await signup(t.base, name);
    const a = t.app.accounts.getByUsername(name);
    if (role) t.app.accounts.setRole(a.id, role);
    return (people[name] = { name, cookie, id: a.id });
  }
  const bindings = [];
  // SYNC: the authorize address's state, and the binding cookie (name=value) the browser keeps
  async function startSync(who) {
    const sync = await request(t.base, "POST", "/api/discord/sync", { cookie: who.cookie, body: {} });
    assert.equal(sync.status, 200, sync.text);
    const binding = sync.setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-h9_dsync="));
    bindings.push(binding.split("=")[1]);
    return { sync, state: new URL(sync.json.url).searchParams.get("state"), binding };
  }
  // Discord sending the browser back: a top-level GET from discord.com, which carries the Lax
  // binding cookie and never the Strict session cookie
  const comeBack = (state, binding, code = "none") => request(t.base, "GET", "/api/discord/callback?code=" + code + "&state=" + encodeURIComponent(state), { origin: null, cookie: binding || undefined });
  const outcomeOf = (back) => (/discord=([a-z]+)/.exec(back.text) || [])[1];
  // the whole dance
  async function link(who, user, { inGuild = true } = {}) {
    if (inGuild && !fake.st.members.has(user.id)) fake.st.members.set(user.id, new Set());
    const { state, binding } = await startSync(who);
    const code = "code-" + crypto.randomBytes(6).toString("hex");
    fake.st.codes.set(code, user);
    const back = await comeBack(state, binding, code);
    return { back, state, code, binding, outcome: outcomeOf(back) };
  }
  const linkRow = (who) => t.app.db.prepare("SELECT * FROM discord_links WHERE account_id = ?").get(who.id);
  const hasRole = (user) => !!(fake.st.members.get(user.id) && fake.st.members.get(user.id).has(ROLE));

  before(async () => {
    fake = await fakeDiscord();
    secrets = secretsFile();
    t = await discordApp(fake, secrets.file);
    await make("Trinity");
    await make("Switch");
    await make("Morpheus", "moderator");
    await make("Oracle", "admin");
  });
  after(async () => {
    await t.close();
    fake.server.close();
    fs.rmSync(secrets.dir, { recursive: true, force: true });
  });

  test("SYNC: signed in, from the site's own pages, and the authorize address it gives", async () => {
    assert.equal((await request(t.base, "POST", "/api/discord/sync", { body: {} })).status, 401);
    assert.equal((await request(t.base, "POST", "/api/discord/sync", { cookie: people.Trinity.cookie, body: {}, origin: "https://evil.example" })).status, 403);
    assert.equal((await request(t.base, "POST", "/api/discord/sync", { cookie: people.Trinity.cookie, body: {}, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    const r = await request(t.base, "POST", "/api/discord/sync", { cookie: people.Trinity.cookie, body: {} });
    const u = new URL(r.json.url);
    const cookie = r.setCookie.find((c) => c.startsWith("__Host-h9_dsync="));
    assert.match(cookie, /^__Host-h9_dsync=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/, "the binding cookie: Lax, so it comes back from Discord");
    const value = cookie.split(";")[0].split("=")[1];
    assert.ok(!t.app.db.prepare("SELECT binding_hash FROM discord_states").all().some((x) => x.binding_hash === value), "only its hash is stored");
    assert.equal(u.searchParams.get("client_id"), CLIENT);
    assert.equal(u.searchParams.get("scope"), "identify");
    assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.match(u.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);
    const stored = t.app.db.prepare("SELECT state_hash FROM discord_states").all().map((x) => x.state_hash);
    assert.ok(!stored.includes(u.searchParams.get("state")), "only the state's hash is stored");
    const status = await request(t.base, "GET", "/api/discord/status", { cookie: people.Trinity.cookie });
    assert.deepEqual([status.json.enabled, status.json.link], [true, null]);
  });

  test("the callback: no session cookie needed, the role given, a page that goes on to /account/", async () => {
    const neo = { id: userId(), username: "neo_matrix", global: "Neo" };
    const { back, outcome } = await link(people.Trinity, neo);
    assert.equal(back.status, 200);
    assert.equal(outcome, "linked");
    assert.match(back.headers["content-type"], /^text\/html/);
    assert.match(back.headers["content-security-policy"], /default-src 'none'/);
    assert.match(back.text, /http-equiv="refresh" content="0;url=\/account\/\?discord=linked#discord"/);
    assert.deepEqual(back.setCookie, ["__Host-h9_dsync=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"], "it clears the binding cookie and sets nothing else");
    assert.ok(hasRole(neo), "the role is given");
    const put = fake.st.calls.find((c) => c.method === "PUT" && c.path.endsWith("/roles/" + ROLE));
    assert.equal(put.auth, "Bot " + BOT);
    assert.match(decodeURIComponent(put.reason), /HAVOC 9 account Trinity linked/);
    const row = linkRow(people.Trinity);
    assert.deepEqual([row.discord_user_id, row.display_name, row.role_state, row.linked_by], [neo.id, "Neo", "granted", people.Trinity.id]);
    const status = await request(t.base, "GET", "/api/discord/status", { cookie: people.Trinity.cookie });
    assert.deepEqual([status.json.link.displayName, status.json.link.role], ["Neo", "granted"]);
    assert.equal(t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'discord.link'").get().target_name, "Trinity");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM discord_states").get().n, 0, "the state is gone");
  });

  test("states: used once, 10 minutes, and a forged one does nothing", async () => {
    const user = { id: userId(), username: "ghost" };
    fake.st.members.set(user.id, new Set());
    const first = await startSync(people.Switch);
    // forged: the right shape, not ours; or not even the shape
    fake.st.codes.set("c1", user);
    assert.equal(outcomeOf(await comeBack(crypto.randomBytes(32).toString("base64url"), first.binding, "c1")), "restart");
    assert.equal(outcomeOf(await comeBack("<script>", first.binding, "c1")), "restart");
    // expired, with the right cookie
    t.app.db.prepare("UPDATE discord_states SET expires_at = ?").run(Math.floor(Date.now() / 1000) - 1);
    assert.equal(outcomeOf(await comeBack(first.state, first.binding, "c1")), "restart");
    assert.equal(linkRow(people.Switch), undefined);
    // used once: the second return with the same state and cookie finds nothing
    const second = await startSync(people.Switch);
    fake.st.codes.set("c2", user);
    assert.equal(outcomeOf(await comeBack(second.state, second.binding, "c2")), "linked");
    fake.st.codes.set("c3", { id: userId(), username: "other" });
    assert.equal(outcomeOf(await comeBack(second.state, second.binding, "c3")), "restart");
    assert.equal(linkRow(people.Switch).discord_user_id, user.id, "the link did not change");
    // a cancelled authorization uses the state up too
    const third = await startSync(people.Morpheus);
    const cancelled = await request(t.base, "GET", "/api/discord/callback?error=access_denied&state=" + third.state, { origin: null, cookie: third.binding });
    assert.equal(outcomeOf(cancelled), "cancelled");
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM discord_states").get().n, 0);
  });

  test("the binding cookie: a state finishes only in the browser that started it", async () => {
    const agent = await make("Agent");
    const mouse = await make("Mouse");
    const refusals = () => t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'discord.link.refused' ORDER BY id").all();
    // the attacker starts a SYNC and gets the victim to finish it on Discord: the victim's
    // browser comes back with the attacker's state but without the attacker's cookie
    const attack = await startSync(agent);
    fake.st.codes.set("victim-code", { id: userId(), username: "victim" });
    const noCookie = await comeBack(attack.state, null, "victim-code");
    assert.equal(outcomeOf(noCookie), "restart");
    assert.equal(linkRow(agent), undefined, "nothing is linked to the attacker");
    assert.ok(fake.st.codes.has("victim-code"), "Discord was not even asked");
    assert.deepEqual(noCookie.setCookie, ["__Host-h9_dsync=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"]);
    assert.match(refusals().at(-1).detail, /^no binding cookie came back/);
    assert.equal(refusals().at(-1).target_name, "Agent");
    // the victim's browser carries a binding cookie of its own (its own SYNC): still refused
    const attack2 = await startSync(agent);
    const victim = await startSync(mouse);
    assert.equal(outcomeOf(await comeBack(attack2.state, victim.binding, "victim-code")), "restart");
    assert.equal(linkRow(agent), undefined);
    assert.match(refusals().at(-1).detail, /^the browser's binding cookie did not match/);
    // the refused attempt used the attacker's state up: the attacker's own cookie no longer helps
    assert.equal(outcomeOf(await comeBack(attack2.state, attack2.binding, "victim-code")), "restart");
    // a cookie from another flow of the same account: SYNC twice, come back with the first cookie
    const older = await startSync(agent);
    const newer = await startSync(agent);
    assert.equal(outcomeOf(await comeBack(newer.state, older.binding, "victim-code")), "restart");
    // an expired cookie: the right pair, ten minutes on (the browser would have dropped it too)
    const late = await startSync(agent);
    t.app.db.prepare("UPDATE discord_states SET expires_at = ? WHERE account_id = ?").run(Math.floor(Date.now() / 1000) - 1, agent.id);
    assert.equal(outcomeOf(await comeBack(late.state, late.binding, "victim-code")), "restart");
    assert.equal(linkRow(agent), undefined);
    // the victim's own flow still works, with its own state and cookie
    const user = { id: userId(), username: "mouse" };
    fake.st.members.set(user.id, new Set());
    fake.st.codes.set("mouse-code", user);
    assert.equal(outcomeOf(await comeBack(victim.state, victim.binding, "mouse-code")), "linked");
    assert.equal(linkRow(mouse).discord_user_id, user.id);
    assert.ok(t.logs.some((l) => /discord\.link\.refused/.test(l)));
  });

  test("one Discord per account, one account per Discord", async () => {
    const again = await request(t.base, "POST", "/api/discord/sync", { cookie: people.Trinity.cookie, body: {} });
    assert.equal(again.status, 409, "a linked account cannot link again or replace it");
    const neoId = linkRow(people.Trinity).discord_user_id;
    const steal = await link(people.Morpheus, { id: neoId, username: "neo_matrix" });
    assert.equal(steal.outcome, "taken", "that Discord is linked to Trinity");
    assert.equal(linkRow(people.Morpheus), undefined);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM discord_links WHERE discord_user_id = ?").get(neoId).n, 1);
  });

  test("not in the guild yet: pending; then joins; the reconcile gives the role", async () => {
    const tank = { id: userId(), username: "tank" };
    const { outcome } = await link(people.Morpheus, tank, { inGuild: false });
    assert.equal(outcome, "pending");
    assert.equal(linkRow(people.Morpheus).role_state, "pending");
    assert.equal((await request(t.base, "POST", "/api/discord/reconcile", { cookie: people.Morpheus.cookie, body: {} })).status, 403, "admins run it");
    fake.st.members.set(tank.id, new Set());
    const r = await request(t.base, "POST", "/api/discord/reconcile", { cookie: people.Oracle.cookie, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.summary.given, 1);
    assert.ok(hasRole(tank));
    assert.equal(linkRow(people.Morpheus).role_state, "granted");
    // drift: the role taken away by hand in Discord comes back at the next reconcile
    fake.st.members.get(tank.id).delete(ROLE);
    await request(t.base, "POST", "/api/discord/reconcile", { cookie: people.Oracle.cookie, body: {} });
    assert.ok(hasRole(tank));
  });

  test("a free: admins only, the role taken, the link gone, a new Discord can be linked", async () => {
    const neoId = linkRow(people.Trinity).discord_user_id;
    const free = (who, how = {}) => request(t.base, "POST", "/api/discord/links/Trinity/free", { cookie: who.cookie, body: { reason: "Lost their Discord account" }, ...how });
    assert.equal((await free(people.Trinity)).status, 403, "never the player");
    assert.equal((await free(people.Morpheus)).status, 403, "never a moderator");
    assert.equal((await free(people.Oracle, { origin: "https://evil.example" })).status, 403, "CSRF");
    assert.ok(linkRow(people.Trinity));
    const r = await free(people.Oracle);
    assert.deepEqual([r.status, r.json.changed, r.json.role], [200, true, "removed"]);
    assert.ok(!hasRole({ id: neoId }), "the role is taken");
    assert.equal(linkRow(people.Trinity), undefined);
    const del = fake.st.calls.filter((c) => c.method === "DELETE").at(-1);
    assert.match(decodeURIComponent(del.reason), /freed by an admin/);
    const row = t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'discord.free'").get();
    assert.deepEqual([row.actor_name, row.target_name], ["Oracle", "Trinity"]);
    assert.match(row.detail, /Lost their Discord account/);
    const fresh = await link(people.Trinity, { id: userId(), username: "neo_new" });
    assert.equal(fresh.outcome, "linked", "a new Discord after the free");
    assert.equal((await request(t.base, "GET", "/api/discord/links/Trinity", { cookie: people.Oracle.cookie })).json.link.displayName, "neo_new");
  });

  test("a suspension takes the role, lifting it gives it back; deleting the account takes it for good", async () => {
    const uid = linkRow(people.Switch).discord_user_id;
    assert.ok(hasRole({ id: uid }));
    t.app.accounts.ban(people.Switch.id, Math.floor(Date.now() / 1000) + 3600, "testing");
    await until(() => !hasRole({ id: uid }));
    assert.equal(linkRow(people.Switch).role_state, "withheld");
    t.app.accounts.unban(people.Switch.id);
    await until(() => hasRole({ id: uid }));
    // the reconcile agrees with a suspension made elsewhere (the admin command's)
    t.app.db.prepare("UPDATE accounts SET banned_until = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) + 3600, people.Switch.id);
    await request(t.base, "POST", "/api/discord/reconcile", { cookie: people.Oracle.cookie, body: {} });
    assert.ok(!hasRole({ id: uid }));
    t.app.db.prepare("UPDATE accounts SET banned_until = NULL WHERE id = ?").run(people.Switch.id);
    await request(t.base, "POST", "/api/discord/reconcile", { cookie: people.Oracle.cookie, body: {} });
    assert.ok(hasRole({ id: uid }));
    t.app.accounts.remove(people.Switch.id);
    await until(() => !hasRole({ id: uid }));
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM discord_links WHERE discord_user_id = ?").get(uid).n, 0, "the link goes too");
  });

  test("Discord's rate limit: a 429 is waited out and tried again", async () => {
    const who = await make("Apoc");
    fake.st.limitRoles = 1;
    const user = { id: userId(), username: "apoc" };
    const { outcome } = await link(who, user);
    assert.equal(outcome, "linked");
    assert.ok(hasRole(user));
    assert.ok(t.logs.some((l) => l.includes("discord.rate_limited")));
  });

  test("members with the role and no link keep it (removeUnlinked is off)", async () => {
    const staffGiven = userId();
    fake.st.members.set(staffGiven, new Set([ROLE]));
    await request(t.base, "POST", "/api/discord/reconcile", { cookie: people.Oracle.cookie, body: {} });
    assert.ok(fake.st.members.get(staffGiven).has(ROLE));
  });

  test("no secret, code, state or token in the logs", async () => {
    const all = t.logs.join("\n");
    assert.ok(all.includes("discord.link"), "the log is working");
    for (const secret of [SECRET, BOT]) assert.ok(!all.includes(secret));
    for (const call of fake.st.calls) {
      const code = new URLSearchParams(call.body).get("code");
      if (code) assert.ok(!all.includes(code), "a code");
    }
    assert.ok(!/access-[0-9a-f]{16}/.test(all), "an access token");
    assert.ok(!/state=/.test(all), "a state");
    for (const b of bindings) assert.ok(!all.includes(b), "a binding cookie");
    const audit = JSON.stringify(t.app.db.prepare("SELECT * FROM audit_log").all());
    assert.ok(!audit.includes(SECRET) && !audit.includes(BOT));
  });
});

describe("Discord: switched off, and removing unlinked roles", () => {
  test("without the secrets file it is off, and the rest runs", async () => {
    const fake = await fakeDiscord();
    const t = await discordApp(fake, path.join(os.tmpdir(), "h9web-no-such-dir", "secrets.json"));
    try {
      const cookie = await signup(t.base, "Niobe");
      assert.equal((await request(t.base, "GET", "/api/discord/status", { cookie })).json.enabled, false);
      const sync = await request(t.base, "POST", "/api/discord/sync", { cookie, body: {} });
      assert.equal(sync.status, 503);
      assert.equal(sync.json.error, "discord_off");
      assert.equal((await request(t.base, "GET", "/api/me", { cookie })).json.signedIn, true);
      assert.ok(t.logs.some((l) => /discord\.off/.test(l) && /no secrets file/.test(l)));
      assert.equal(fake.st.calls.length, 0, "Discord was never called");
    } finally {
      await t.close();
      fake.server.close();
    }
  });

  test("removeUnlinked on: the reconcile takes the role from members with no link", async () => {
    const fake = await fakeDiscord();
    const secrets = secretsFile();
    const t = await discordApp(fake, secrets.file, { removeUnlinked: true });
    try {
      const cookie = await signup(t.base, "Sparks");
      const a = t.app.accounts.getByUsername("Sparks");
      t.app.accounts.setRole(a.id, "admin");
      const loner = userId();
      const kept = userId();
      fake.st.members.set(loner, new Set([ROLE]));
      fake.st.members.set(kept, new Set(["999"]));
      const r = await request(t.base, "POST", "/api/discord/reconcile", { cookie, body: {} });
      assert.equal(r.json.summary.unlinkedTaken, 1);
      assert.ok(!fake.st.members.get(loner).has(ROLE));
      assert.ok(fake.st.members.get(kept).has("999"), "other roles are left alone");
    } finally {
      await t.close();
      fake.server.close();
      fs.rmSync(secrets.dir, { recursive: true, force: true });
    }
  });
});
