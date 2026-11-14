// h9rv: the rendezvous and relay service of the P2P join path. One object, two faces:
//   * a JSON control plane (handleHttp, mounted on any node:http server or h9web's router): hosts open a session and mint
//     invites, joiners redeem an invite, hosts long-poll for their joiners; a host may list its session publicly, and anybody
//     may then ask the public list for a one-use, relay-only guest invite;
//   * ONE UDP port, the data plane: every packet is authenticated (lib/wire.js), nothing is answered unless it verifies, and
//     a datagram is only ever passed between the two sides of one flow.
// The calls, the limits and the threat model are in p2p/README.txt and docs/P2P_HOSTING.txt.
//
// The state lives in memory only. A restart forgets every session, invite and flow; the hosts open again by themselves.
// Nothing secret is written anywhere; no address is logged (an 8-hex-digit keyed tag stands for it).
//
// Fails closed: a request that does not verify, a packet that does not verify, a limit that is hit, a switch that is off: the
// answer is no (HTTP) or silence (UDP). With config.enabled false nothing listens at all.

import crypto from "node:crypto";
import dgram from "node:dgram";
import {
  T, F_HOST, MIN_HELLO, ReplayWindow, decodeHeader, payloadOf, verify, encode, hostFlowKey,
  ackPayload, peerPayload, publicUnicast, MAX_PAYLOAD,
} from "./wire.js";
import { RateLimiter, TokenBucket } from "./limits.js";
import { newCode, formatCode, normaliseCode, codeHash, randomKey, randomId32, randomToken, b64, unb64, loopbackAlias, addressTag } from "./codes.js";

export const DEFAULTS = Object.freeze({
  enabled: true,
  // where the clients are told to send UDP (the VPS's public name or address)
  publicUdp: { host: "127.0.0.1", port: 27248 },
  bind: { http: { host: "127.0.0.1", port: 28247 }, udp: { host: "0.0.0.0", port: 27248 } },
  // service-wide switches, each with its own off: no endpoint is ever handed to a peer / no datagram is ever relayed
  direct: { enabled: true },
  relay: { enabled: true },
  // the public list: a host may list its session (an auth entry with public false may not); enabled false keeps nothing and answers 404 / 403
  listing: { enabled: true, ttlSeconds: 45, inviteSeconds: 600 },
  // reserved, not implemented: createService refuses to start while either key is set
  publicPorts: { range: "", max: 0 },
  allowPrivatePeers: false,
  trustProxyHeader: "", // e.g. "x-real-ip" behind nginx; empty uses the socket address
  limits: {
    sessionsTotal: 200, sessionsPerAccount: 2, flowsPerSession: 16, flowsTotal: 2000, invitesPerSession: 16,
    inviteTtlMax: 900, inviteTtlDefault: 600, usesMax: 8,
    sessionIdleSeconds: 45, flowIdleSeconds: 30, flowMaxSeconds: 8 * 3600, sessionMaxSeconds: 12 * 3600,
    maxBody: 4096, pollMaxSeconds: 25,
    openPerAccount: { max: 6, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 3600 },
    invitePerSession: { max: 30, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 3600 },
    redeemPerIp: { max: 10, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 3600 },
    redeemFailPerIp: { max: 5, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 21600 },
    redeemFailGlobalPerMinute: 120,
    flowPps: 800, flowPpsBurst: 1600, flowBps: 192000, flowBpsBurst: 384000,
    unlatchedPps: 50, unlatchedBurst: 100,
    verifyPerSecond: 40000, verifyBurst: 80000,
    relayBytesPerAccountPerDay: 4 * 1024 * 1024 * 1024,
    listingPerSession: { max: 10, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 600 },
    publicListPerIp: { max: 30, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 600 },
    publicJoinPerIp: { max: 6, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 3600 },
    publicJoinPerAccount: { max: 20, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 3600 },
    publicJoinPerSession: { max: 30, windowSeconds: 3600, blockSeconds: 60, maxBlockSeconds: 3600 },
    publicFailPerIp: { max: 10, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 21600 },
    publicJoinGlobalPerMinute: 120,
    listedMax: 100, publicInvitesPerSession: 4, publicFlowsPerSession: 8, publicListCacheSeconds: 5,
  },
  // development authentication: bearer tokens -> accounts. A production deployment passes its own `auth` object.
  dev: { hosts: {}, accounts: {} },
});

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  }
  return out;
}

export function ipKey(ip) {
  const text = String(ip || "");
  if (!text.includes(":")) return text;
  const parts = text.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const full = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail);
  return full.slice(0, 4).map((h) => (h || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// auth: { host(token) -> { id, name, public? } | null, account(token) -> { id, name } | null (both may be async), accountsAvailable }.
//   public false forbids listing for that host; accountsAvailable false refuses requireAccount invites and listings (it is
//   true unless an auth object says otherwise; the development auth says it only when dev.accounts has an entry).
// clientAddress(req): the visitor's address, for the per-address limits; clientAccount(req): the signed-in visitor's
//   { id, name } or null. h9web passes both; a standalone service uses the socket's address and the body's account token.
export function createService({ config: userConfig = {}, auth: userAuth = null, log = () => {}, now = Date.now, clientAddress: userClientAddress = null, clientAccount: userClientAccount = null } = {}) {
  const cfg = merge(DEFAULTS, userConfig);
  if (cfg.publicPorts && (cfg.publicPorts.range || cfg.publicPorts.max)) throw new Error("publicPorts is not implemented yet: leave publicPorts.range empty and publicPorts.max 0");
  const L = cfg.limits;
  const logTagSecret = crypto.randomBytes(16);
  const tag = (ip) => addressTag(logTagSecret, ip);

  const auth = userAuth || {
    host: (token) => cfg.dev.hosts[token] || null,
    account: (token) => cfg.dev.accounts[token] || null,
    accountsAvailable: Object.keys(cfg.dev.accounts).length > 0,
  };
  const accountsAvailable = () => auth.accountsAvailable !== false;

  const sessions = new Map(); // id -> session
  const sessionsByCtl = new Map(); // ctl flow id -> session
  const invites = new Map(); // code hash -> invite
  const flows = new Map(); // flow id -> flow
  const perAccountSessions = new Map(); // account id -> count
  const dailyRelay = new Map(); // account id -> { day, bytes }
  const publicById = new Map(); // public id -> session (a session that has been listed; the id is not the session's secret one)
  let publicCache = null; // { at, text }: GET /v1/public is computed at most once per publicListCacheSeconds
  const stats = {
    http: 0, redeemOk: 0, redeemFail: 0, opened: 0, invitesMade: 0, rx: 0, tx: 0, relayed: 0, relayedBytes: 0, punchInfo: 0,
    listings: 0, publicJoins: 0, publicRefused: 0,
    drops: Object.create(null),
  };
  const drop = (why) => { stats.drops[why] = (stats.drops[why] || 0) + 1; };

  const limitOpen = new RateLimiter({ ...L.openPerAccount, now });
  const limitInvite = new RateLimiter({ ...L.invitePerSession, now });
  const limitRedeem = new RateLimiter({ ...L.redeemPerIp, now });
  const limitRedeemFail = new RateLimiter({ ...L.redeemFailPerIp, now });
  const failGlobal = new TokenBucket(L.redeemFailGlobalPerMinute / 60, L.redeemFailGlobalPerMinute, now);
  const limitListing = new RateLimiter({ ...L.listingPerSession, now });
  const limitPublicList = new RateLimiter({ ...L.publicListPerIp, now });
  const limitPublicJoinIp = new RateLimiter({ ...L.publicJoinPerIp, now });
  const limitPublicJoinAccount = new RateLimiter({ ...L.publicJoinPerAccount, now });
  const limitPublicJoinSession = new RateLimiter({ ...L.publicJoinPerSession, now });
  const limitPublicFail = new RateLimiter({ ...L.publicFailPerIp, now });
  const publicJoinGlobal = new TokenBucket(L.publicJoinGlobalPerMinute / 60, L.publicJoinGlobalPerMinute, now);
  // Every tag check costs one HMAC; this bounds what a flood of forged packets can cost, whatever addresses it comes from.
  const verifyBudget = new TokenBucket(L.verifyPerSecond, L.verifyBurst, now);

  let udp = null;
  let timer = null;
  let stopped = false;

  const udpSend = (buf, port, ip) => {
    if (!udp) return;
    stats.tx++;
    udp.send(buf, port, ip, () => {});
  };

  // ---- sessions, invites, flows ---------------------------------------------------------------------------------

  function idleOk(s) {
    return now() - s.lastSeen < L.sessionIdleSeconds * 1000;
  }

  function closeSession(s, reason) {
    if (!sessions.delete(s.id)) return;
    sessionsByCtl.delete(s.ctl);
    for (const flowId of [...s.flows]) closeFlow(flows.get(flowId), reason, false);
    for (const h of s.invites) invites.delete(h);
    if (s.pub) publicById.delete(s.pub);
    s.listing = null;
    perAccountSessions.set(s.accountId, Math.max(0, (perAccountSessions.get(s.accountId) || 1) - 1));
    if (s.waiter) s.waiter.resolve([{ t: "closed", reason }]);
    log("session.close", { session: s.id.slice(0, 6), reason });
  }

  function closeFlow(f, reason, notifyHost = true) {
    if (!f || f.closed) return;
    f.closed = true;
    flows.delete(f.id);
    const s = f.session;
    s.flows.delete(f.id);
    if (f.public) s.publicFlows = Math.max(0, s.publicFlows - 1);
    // tell both ends (best effort), the joiner first
    if (f.jEndpoint) udpSend(encode({ type: T.CLOSE, flags: F_HOST, flow: f.id, seq: f.seqToJ++, payload: Buffer.from([reason === "kicked" ? 2 : 1]) }, f.kJ), f.jEndpoint.port, f.jEndpoint.ip);
    if (s.hostEndpoint && notifyHost) udpSend(encode({ type: T.CLOSE, flags: 0, flow: f.id, seq: f.seqToH++, payload: Buffer.from([1]) }, f.kH), s.hostEndpoint.port, s.hostEndpoint.ip);
    pushEvent(s, { t: "gone", flow: f.id, reason });
    log("flow.close", { flow: f.id, reason, rx: f.rx, tx: f.tx });
  }

  function pushEvent(s, ev) {
    if (s.events.length >= 64) s.events.shift();
    s.events.push(ev);
    if (s.waiter) {
      const w = s.waiter;
      s.waiter = null;
      w.resolve(s.events.splice(0));
    }
  }

  function addRelayBytes(accountId, n) {
    const day = Math.floor(now() / 86400000);
    let d = dailyRelay.get(accountId);
    if (!d || d.day !== day) {
      d = { day, bytes: 0 };
      dailyRelay.set(accountId, d);
    }
    d.bytes += n;
    return d.bytes <= L.relayBytesPerAccountPerDay;
  }

  function dropInvite(inv) {
    invites.delete(inv.hash);
    inv.session.invites.delete(inv.hash);
    inv.session.publicInvites.delete(inv.hash);
  }

  // A listing is live for listing.ttlSeconds after the host's last call, while its session is open and the service lists at all.
  function listingLive(s) {
    return !!(s.listing && cfg.listing.enabled && sessions.has(s.id) && idleOk(s) && now() - s.listing.updated < cfg.listing.ttlSeconds * 1000);
  }

  function listedCount() {
    let n = 0;
    for (const s of sessions.values()) if (listingLive(s)) n++;
    return n;
  }

  // Takes the session off the list and revokes its unspent public guest invites; the guests already in stay (the host kicks them).
  function unlist(s) {
    s.listing = null;
    let n = 0;
    for (const h of [...s.publicInvites]) {
      const inv = invites.get(h);
      if (inv) dropInvite(inv);
      else { s.invites.delete(h); s.publicInvites.delete(h); }
      n++;
    }
    return n;
  }

  const printable = (v, max) => String(v).replace(/[^\x20-\x7e]/g, "?").slice(0, max);
  const clampInt = (v, lo, hi) => Math.min(Math.max(Math.floor(Number(v) || 0), lo), hi);
  const blockedSeconds = (limiter, key) => {
    const e = limiter.entry(key, false);
    return e && e.blockedUntil > now() ? Math.ceil((e.blockedUntil - now()) / 1000) : 0;
  };

  // ---- HTTP ------------------------------------------------------------------------------------------------------

  // The address a control-plane request came from, for the per-address limits. h9web passes its own (the visitor behind nginx and Cloudflare).
  function defaultClientAddress(req) {
    if (cfg.trustProxyHeader) {
      const v = req.headers[cfg.trustProxyHeader];
      if (v) return String(v).split(",")[0].trim();
    }
    return req.socket.remoteAddress || "";
  }
  const clientAddress = userClientAddress || defaultClientAddress;

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      let over = false;
      req.on("data", (c) => {
        n += c.length;
        if (over) return;
        if (n > L.maxBody) {
          over = true;
          chunks.length = 0;
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function reply(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  // The host's requests are signed: X-H9-Sig: s=<session>;t=<ms>;n=<nonce>;m=<hex HMAC-SHA256(hostKey, method LF path LF t LF n LF bodyMac)>,
  // bodyMac being hex HMAC-SHA256(hostKey, "body" LF body): the body is covered by the same key, with no plain hash of it.
  // The key itself never travels again after the open. A request outside +-60 s of the clock, or whose nonce was seen, is refused.
  function verifyHost(req, path, raw) {
    const h = String(req.headers["x-h9-sig"] || "");
    // only the four keys of the signature are read, into a Map: a key of the header is never a property name
    const parts = new Map();
    for (const part of h.split(";")) {
      const i = part.indexOf("=");
      const k = i > 0 ? part.slice(0, i).trim() : "";
      if (k === "s" || k === "t" || k === "n" || k === "m") parts.set(k, part.slice(i + 1).trim());
    }
    const f = { s: parts.get("s"), t: parts.get("t"), n: parts.get("n"), m: parts.get("m") };
    const s = sessions.get(f.s || "");
    if (!s || !f.t || !f.n || !f.m || f.n.length > 64) return null;
    const t = Number(f.t);
    if (!Number.isFinite(t) || Math.abs(now() - t) > 60000) return null;
    const bodyMac = crypto.createHmac("sha256", s.hostKey).update(Buffer.concat([Buffer.from("body\n"), raw])).digest("hex");
    const want = crypto.createHmac("sha256", s.hostKey).update(req.method + "\n" + path + "\n" + f.t + "\n" + f.n + "\n" + bodyMac).digest("hex");
    const a = Buffer.from(want);
    const b = Buffer.from(f.m);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    for (const [n, exp] of s.nonces) if (exp < now()) s.nonces.delete(n);
    if (s.nonces.has(f.n) || s.nonces.size >= 512) return null;
    s.nonces.set(f.n, now() + 130000);
    s.lastSeen = now();
    return s;
  }

  function parseJson(raw) {
    if (!raw.length) return {};
    try {
      const v = JSON.parse(raw.toString("utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  async function handleHttp(req, res) {
    stats.http++;
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (!cfg.enabled) return reply(res, 503, { error: "disabled" });
    try {
      if (req.method === "GET" && path === "/v1/health") return reply(res, 200, { ok: true, v: 1, direct: cfg.direct.enabled, relay: cfg.relay.enabled, listing: cfg.listing.enabled });
      if (req.method === "GET" && path === "/v1/public") return publicList(req, res);
      if (req.method !== "POST") return reply(res, 405, { error: "method" });
      const raw = await readBody(req);
      if (path === "/v1/join/redeem") return await redeem(req, res, raw);
      if (path === "/v1/public/join") return await publicJoin(req, res, raw);
      if (path === "/v1/host/open") return await hostOpen(req, res, raw);
      const s = verifyHost(req, path, raw);
      if (!s) return reply(res, 401, { error: "unauthorized" });
      const body = parseJson(raw);
      if (!body) return reply(res, 400, { error: "bad json" });
      if (path === "/v1/host/invite") return hostInvite(res, s, body);
      if (path === "/v1/host/poll") return await hostPoll(res, s, body);
      if (path === "/v1/host/revoke") return hostRevoke(res, s, body);
      if (path === "/v1/host/listing") return hostListing(res, s, body);
      if (path === "/v1/host/close") {
        closeSession(s, "host-closed");
        return reply(res, 200, { ok: true });
      }
      return reply(res, 404, { error: "not found" });
    } catch (e) {
      if (e && e.status === 413) {
        // answer, then drop the connection: what is still arriving is not read any further
        res.on("finish", () => req.destroy());
        return reply(res, 413, { error: "too large" }, { Connection: "close" });
      }
      log("http.error", { error: String(e && e.message) });
      return reply(res, 500, { error: "error" });
    }
  }

  async function hostOpen(req, res, raw) {
    const body = parseJson(raw);
    if (!body) return reply(res, 400, { error: "bad json" });
    const m = /^Bearer (.{1,200})$/.exec(String(req.headers.authorization || ""));
    const who = m ? await auth.host(m[1]) : null;
    if (!who) return reply(res, 401, { error: "unauthorized" });
    const lim = limitOpen.hit("a" + who.id);
    if (!lim.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(lim.retryAfter) });
    if (sessions.size >= L.sessionsTotal || (perAccountSessions.get(who.id) || 0) >= L.sessionsPerAccount) return reply(res, 429, { error: "too many sessions" }, { "Retry-After": "30" });
    const id = randomToken(16);
    const ctl = randomId32((n) => flows.has(n) || sessionsByCtl.has(n));
    const s = {
      id, ctl, hostKey: randomKey(), accountId: who.id, accountName: String(who.name || "").slice(0, 32),
      name: String(body.name || who.name || "game").replace(/[^\x20-\x7e]/g, "?").slice(0, 40),
      direct: body.directAllowed !== false && cfg.direct.enabled,
      relay: body.relayAllowed !== false && cfg.relay.enabled,
      createdAt: now(), lastSeen: now(), hostEndpoint: null, hostWin: new ReplayWindow(), seqCtl: 1, unlatched: new TokenBucket(L.unlatchedPps, L.unlatchedBurst, now),
      flows: new Set(), invites: new Set(), events: [], waiter: null, nonces: new Map(),
      virtual: loopbackAlias(101, id),
      publicInvites: new Set(), publicFlows: 0, canList: who.public !== false, pub: null, listing: null,
    };
    sessions.set(id, s);
    sessionsByCtl.set(ctl, s);
    perAccountSessions.set(who.id, (perAccountSessions.get(who.id) || 0) + 1);
    stats.opened++;
    log("session.open", { session: id.slice(0, 6), account: who.id, direct: s.direct, relay: s.relay });
    return reply(res, 200, {
      v: 1, session: id, ctl, hostKey: b64(s.hostKey), udp: cfg.publicUdp, now: now(), virtual: s.virtual,
      direct: s.direct, relay: s.relay,
      limits: { inviteTtlMax: L.inviteTtlMax, usesMax: L.usesMax, flowsPerSession: L.flowsPerSession, sessionIdleSeconds: L.sessionIdleSeconds },
    });
  }

  function hostInvite(res, s, body) {
    const lim = limitInvite.hit(s.id);
    if (!lim.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(lim.retryAfter) });
    if (body.requireAccount === true && !accountsAvailable()) return reply(res, 400, { error: "accounts unavailable" });
    if (s.invites.size - s.publicInvites.size >= L.invitesPerSession) return reply(res, 429, { error: "too many invites" }, { "Retry-After": "30" });
    const ttl = Math.min(Math.max(Number(body.ttl) || L.inviteTtlDefault, 10), L.inviteTtlMax);
    const uses = Math.min(Math.max(Math.floor(Number(body.uses) || 1), 1), L.usesMax);
    let code;
    let hash;
    do {
      code = newCode();
      hash = codeHash(code);
    } while (invites.has(hash));
    const inv = {
      id: randomToken(6), hash, session: s, expires: now() + ttl * 1000, usesLeft: uses,
      label: String(body.label || "").replace(/[^\x20-\x7e]/g, "?").slice(0, 32),
      requireAccount: body.requireAccount === true,
      direct: body.direct !== false, createdAt: now(),
    };
    invites.set(hash, inv);
    s.invites.add(hash);
    stats.invitesMade++;
    log("invite.make", { session: s.id.slice(0, 6), invite: inv.id, ttl, uses });
    return reply(res, 200, { code: formatCode(code), id: inv.id, expires: inv.expires, ttl, uses });
  }

  async function hostPoll(res, s, body) {
    if (s.events.length) return reply(res, 200, { events: s.events.splice(0), now: now() });
    const wait = Math.min(Math.max(Number(body.wait) || 20, 1), L.pollMaxSeconds) * 1000;
    if (s.waiter) s.waiter.resolve([]);
    const events = await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (s.waiter && s.waiter.resolve === done) s.waiter = null;
        resolve([]);
      }, wait);
      const done = (ev) => {
        clearTimeout(t);
        resolve(ev);
      };
      s.waiter = { resolve: done };
    });
    s.lastSeen = now();
    return reply(res, 200, { events, now: now() });
  }

  function hostRevoke(res, s, body) {
    let n = 0;
    if (body.all === true) {
      for (const h of [...s.invites]) {
        const inv = invites.get(h);
        if (inv) dropInvite(inv);
        else s.invites.delete(h);
        n++;
      }
      for (const id of [...s.flows]) { closeFlow(flows.get(id), "kicked"); n++; }
    } else if (typeof body.invite === "string") {
      for (const h of [...s.invites]) {
        const inv = invites.get(h);
        if (inv && inv.id === body.invite) { dropInvite(inv); n++; }
      }
    } else if (Number.isInteger(body.flow)) {
      const f = flows.get(body.flow);
      if (f && f.session === s) { closeFlow(f, "kicked"); n++; }
    }
    return reply(res, 200, { ok: true, revoked: n });
  }

  // POST /v1/host/listing: the host lists its session (public true, repeated within listing.ttlSeconds) or takes it off the list at once.
  function hostListing(res, s, body) {
    const lim = limitListing.hit(s.id);
    if (!lim.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(lim.retryAfter) });
    if (typeof body.public !== "boolean") return reply(res, 400, { error: "bad listing" });
    if (body.public === false) return reply(res, 200, { ok: true, ttl: 0, revoked: unlist(s) });
    if (!cfg.listing.enabled || !s.canList) return reply(res, 403, { error: "listing disabled" });
    const types = { name: "string", map: "string", players: "number", max: "number", password: "boolean", requireAccount: "boolean", directPublic: "boolean" };
    for (const [k, type] of Object.entries(types)) if (body[k] !== undefined && typeof body[k] !== type) return reply(res, 400, { error: "bad listing" });
    if (!s.relay || !cfg.relay.enabled) return reply(res, 400, { error: "relay off" });
    if (body.requireAccount === true && !accountsAvailable()) return reply(res, 400, { error: "accounts unavailable" });
    if (!listingLive(s) && listedCount() >= L.listedMax) return reply(res, 429, { error: "list full" }, { "Retry-After": "30" });
    if (!s.pub) {
      do { s.pub = randomToken(9); } while (publicById.has(s.pub));
      publicById.set(s.pub, s);
    }
    s.listing = {
      name: printable(body.name !== undefined && body.name !== "" ? body.name : s.name, 64),
      map: String(body.map || "").replace(/[^A-Za-z0-9_.+-]/g, "").slice(0, 32),
      players: clampInt(body.players, 0, 128), max: clampInt(body.max, 0, 128),
      password: body.password === true, requireAccount: body.requireAccount === true, directPublic: body.directPublic === true,
      updated: now(),
    };
    stats.listings++;
    return reply(res, 200, { ok: true, ttl: cfg.listing.ttlSeconds, id: s.pub });
  }

  // GET /v1/public: the listed sessions, most populated first; no address, no secret. Computed once per publicListCacheSeconds for everybody.
  function publicList(req, res) {
    if (!cfg.listing.enabled) return reply(res, 404, { error: "not found" });
    const lim = limitPublicList.hit(ipKey(clientAddress(req)));
    if (!lim.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(lim.retryAfter) });
    const t = now();
    if (!publicCache || t - publicCache.at >= L.publicListCacheSeconds * 1000) {
      const list = [];
      for (const s of sessions.values()) {
        if (!listingLive(s)) continue;
        const l = s.listing;
        list.push({ id: s.pub, name: l.name, map: l.map, players: l.players, max: l.max, password: l.password, direct: l.directPublic && s.direct && cfg.direct.enabled, account: l.requireAccount });
      }
      list.sort((a, b) => (b.players - a.players) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      publicCache = { at: t, text: JSON.stringify({ sessions: list.slice(0, L.listedMax) }) };
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(publicCache.text) });
    res.end(publicCache.text);
  }

  // POST /v1/public/join: a guest of a listed session gets a one-use, relay-only invite for it, bound to the account that asked (when there is one).
  // Unknown, unlisted, stale, gone and full all answer the same 404; the failures of an address are counted and block it.
  async function publicJoin(req, res, raw) {
    if (!cfg.listing.enabled) return reply(res, 404, { error: "not found" });
    const ipk = ipKey(clientAddress(req));
    const wait = blockedSeconds(limitPublicFail, ipk);
    if (wait) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(wait) });
    const lim = limitPublicJoinIp.hit(ipk);
    if (!lim.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(lim.retryAfter) });
    if (!publicJoinGlobal.take(1)) return reply(res, 429, { error: "slow down" }, { "Retry-After": "5" });
    const refuse = () => {
      stats.publicRefused++;
      limitPublicFail.hit(ipk);
      return reply(res, 404, { error: "unavailable" });
    };
    const body = parseJson(raw);
    if (!body || typeof body.session !== "string" || body.session.length > 64) {
      limitPublicFail.hit(ipk);
      return reply(res, 400, { error: "bad request" });
    }
    const s = publicById.get(body.session);
    if (!s || !listingLive(s)) return refuse();
    let who = null;
    if (userClientAccount) who = await userClientAccount(req);
    if (!who && typeof body.account === "string" && body.account) who = await auth.account(body.account.slice(0, 200));
    if (s.listing && s.listing.requireAccount && !who) return reply(res, 401, { error: "account required" });
    if (who) {
      const la = limitPublicJoinAccount.hit("a" + who.id);
      if (!la.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(la.retryAfter) });
    }
    const ls = limitPublicJoinSession.hit(s.id);
    if (!ls.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(ls.retryAfter) });
    if (!listingLive(s)) return refuse();
    const live = s.publicInvites.size;
    if (live >= L.publicInvitesPerSession || s.publicFlows + live >= L.publicFlowsPerSession || s.flows.size + live >= L.flowsPerSession || flows.size >= L.flowsTotal) return refuse();
    let code;
    let hash;
    do {
      code = newCode();
      hash = codeHash(code);
    } while (invites.has(hash));
    const ttl = cfg.listing.inviteSeconds;
    const inv = {
      id: randomToken(6), hash, session: s, expires: now() + ttl * 1000, usesLeft: 1, label: "public", requireAccount: false,
      direct: s.listing.directPublic === true, createdAt: now(), public: true,
      account: who ? { id: who.id, name: String(who.name || "").slice(0, 32) } : null,
    };
    invites.set(hash, inv);
    s.invites.add(hash);
    s.publicInvites.add(hash);
    stats.publicJoins++;
    log("public.join", { session: s.id.slice(0, 6), invite: inv.id, account: inv.account ? inv.account.id : null });
    return reply(res, 200, { code: formatCode(code), expires: Math.floor(inv.expires / 1000), ttl, name: s.listing.name, map: s.listing.map, password: s.listing.password });
  }

  // Every way a redeem can fail answers the same body after a short random delay: unknown, expired, used up, revoked, host gone,
  // host full, wrong account rule. Nothing tells a guesser how close it was.
  async function redeem(req, res, raw) {
    const addr = clientAddress(req);
    const ipk = ipKey(addr);
    const lim = limitRedeem.hit(ipk);
    if (!lim.ok) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(lim.retryAfter) });
    const blocked = limitRedeemFail.entry(ipk, false);
    if (blocked && blocked.blockedUntil > now()) return reply(res, 429, { error: "slow down" }, { "Retry-After": String(Math.ceil((blocked.blockedUntil - now()) / 1000)) });
    const body = parseJson(raw);
    const refuse = async () => {
      stats.redeemFail++;
      limitRedeemFail.hit(ipk);
      const over = !failGlobal.take(1);
      await sleep(over ? 1500 + Math.random() * 1000 : 30 + Math.random() * 40);
      log("redeem.fail", { ip: tag(addr), tarpit: over });
      return reply(res, 404, { error: "invalid" });
    };
    if (!body) return refuse();
    const code = normaliseCode(body.code);
    if (!code) return refuse();
    const inv = invites.get(codeHash(code));
    const s = inv ? inv.session : null;
    const live = inv && s && sessions.has(s.id) && inv.expires > now() && inv.usesLeft > 0 && idleOk(s) && s.flows.size < L.flowsPerSession && flows.size < L.flowsTotal;
    if (!live) return refuse();
    // a public guest invite is good only while its session is still listed and has room for guests
    if (inv.public && (!listingLive(s) || s.publicFlows >= L.publicFlowsPerSession)) return refuse();
    // an invite that a signed-in visitor asked the public list for carries that visitor's account
    let account = inv.account || null;
    if (!account && typeof body.account === "string" && body.account) {
      account = await auth.account(body.account.slice(0, 200));
      if (!account && inv.requireAccount) return refuse();
    }
    if (inv.requireAccount && !account) return refuse();
    if (!sessions.has(s.id)) return refuse();
    inv.usesLeft--;
    if (inv.usesLeft <= 0) dropInvite(inv);
    const flowId = randomId32((n) => flows.has(n) || sessionsByCtl.has(n));
    const f = {
      id: flowId, session: s, kJ: randomKey(), kH: hostFlowKey(s.hostKey, flowId), pairKey: randomKey(),
      jEndpoint: null, jWin: new ReplayWindow(), hWin: new ReplayWindow(), seqToJ: 1, seqToH: 1,
      direct: s.direct && inv.direct && body.direct !== false && cfg.direct.enabled,
      account: account ? { id: account.id, name: String(account.name || "").slice(0, 32) } : null,
      label: inv.label, public: inv.public === true, createdAt: now(), lastSeen: now(), closed: false, rx: 0, tx: 0,
      pps: new TokenBucket(L.flowPps, L.flowPpsBurst, now), bps: new TokenBucket(L.flowBps, L.flowBpsBurst, now),
      unlatched: new TokenBucket(L.unlatchedPps, L.unlatchedBurst, now),
    };
    flows.set(flowId, f);
    s.flows.add(flowId);
    if (f.public) s.publicFlows++;
    stats.redeemOk++;
    pushEvent(s, { t: "joiner", flow: flowId, pairKey: b64(f.pairKey), label: f.label, invite: inv.id, account: f.account, direct: f.direct, at: now(), ...(f.public ? { public: true } : {}) });
    log("redeem.ok", { flow: flowId, invite: inv.id, direct: f.direct });
    return reply(res, 200, {
      v: 1, flow: flowId, jKey: b64(f.kJ), pairKey: b64(f.pairKey), udp: cfg.publicUdp, now: now(),
      host: { name: s.name }, virtual: s.virtual, direct: f.direct, relay: s.relay,
      expiresIn: Math.floor(L.flowMaxSeconds), idleSeconds: L.flowIdleSeconds,
    });
  }

  // ---- UDP -------------------------------------------------------------------------------------------------------

  function onPacket(msg, rinfo) {
    stats.rx++;
    const h = decodeHeader(msg);
    if (!h) return drop("shape");
    const src = { ip: rinfo.address, port: rinfo.port };
    if (!cfg.allowPrivatePeers && !publicUnicast(src.ip)) return drop("source-not-public");

    // The host's own session-level HELLO / KEEPALIVE / CLOSE: key = hostKey
    if (h.host) {
      const sess = sessionsByCtl.get(h.flow);
      if (sess) return onHostCtl(sess, h, msg, src);
    }
    const f = flows.get(h.flow);
    if (!f || f.closed) return drop("noflow");
    // A packet from the address this end of the flow last proved itself from goes straight to the tag check. A packet from any other
    // address (a forger who has learned the flow id, or the first packet from a new NAT mapping) has a small allowance per flow, so
    // forged packets for a flow cannot crowd out that flow's real ones, and cost the HMAC budget little.
    const latched = h.host ? f.session.hostEndpoint : f.jEndpoint;
    if (!(latched && latched.ip === src.ip && latched.port === src.port) && !f.unlatched.take(1)) return drop("flow-unlatched");
    if (!verifyBudget.take(1)) return drop("verify-budget");
    const key = h.host ? f.kH : f.kJ;
    if (!verify(msg, key)) return drop("badtag");
    const win = h.host ? f.hWin : f.jWin;
    if (!win.accept(h.seq)) return drop("replay");
    // the flow's own packet budget is charged for packets that verified only: forged packets cannot starve the real ones
    if (!f.pps.take(1)) return drop("flow-rate");
    f.lastSeen = now();
    f.session.lastSeen = h.host ? now() : f.session.lastSeen;
    f.rx++;
    const ep = h.host ? f.session.hostEndpoint : f.jEndpoint;
    switch (h.type) {
      case T.HELLO: {
        if (h.host) f.session.hostEndpoint = src; else f.jEndpoint = src;
        if (msg.length < MIN_HELLO) return drop("hello-short");
        const p = payloadOf(msg);
        udpSend(encode({ type: T.HELLO_ACK, flags: h.host ? 0 : F_HOST, flow: f.id, seq: h.host ? f.seqToH++ : f.seqToJ++, payload: ackPayload(src.ip, src.port, p.subarray(0, 8)) }, key), src.port, src.ip);
        if (h.wantPeer) sendPeerInfo(f);
        return;
      }
      case T.KEEPALIVE:
        if (h.host) f.session.hostEndpoint = src; else f.jEndpoint = src;
        return;
      case T.CLOSE:
        return closeFlow(f, h.host ? "kicked" : "joiner-left");
      case T.DATA: {
        if (!f.session.relay || !cfg.relay.enabled) return drop("relay-off");
        const payload = payloadOf(msg);
        if (!f.bps.take(payload.length + 28)) return drop("flow-bytes");
        if (!addRelayBytes(f.session.accountId, payload.length)) return drop("account-day-cap");
        if (h.host) f.session.hostEndpoint = src; else f.jEndpoint = src;
        const to = h.host ? f.jEndpoint : f.session.hostEndpoint;
        if (!to) return drop("no-peer");
        const out = h.host
          ? encode({ type: T.DATA, flags: F_HOST, flow: f.id, seq: f.seqToJ++, payload }, f.kJ)
          : encode({ type: T.DATA, flags: 0, flow: f.id, seq: f.seqToH++, payload }, f.kH);
        udpSend(out, to.port, to.ip);
        f.tx++;
        stats.relayed++;
        stats.relayedBytes += payload.length;
        return;
      }
      default:
        return drop("type");
    }
    void ep;
  }

  function onHostCtl(s, h, msg, src) {
    const latched = s.hostEndpoint;
    if (!(latched && latched.ip === src.ip && latched.port === src.port) && !s.unlatched.take(1)) return drop("flow-unlatched");
    if (!verifyBudget.take(1)) return drop("verify-budget");
    if (!verify(msg, s.hostKey)) return drop("badtag");
    if (!s.hostWin.accept(h.seq)) return drop("replay");
    s.lastSeen = now();
    s.hostEndpoint = src;
    if (h.type === T.HELLO) {
      if (msg.length < MIN_HELLO) return drop("hello-short");
      udpSend(encode({ type: T.HELLO_ACK, flags: 0, flow: s.ctl, seq: s.seqCtl++, payload: ackPayload(src.ip, src.port, payloadOf(msg).subarray(0, 8)) }, s.hostKey), src.port, src.ip);
    }
  }

  // Both ends are told the other's address, only when the service, the host's session, the invite and the joiner all allow it,
  // and only to a peer whose packets verified. A relay-only flow never gets here.
  function sendPeerInfo(f) {
    const s = f.session;
    if (!f.direct || !s.hostEndpoint || !f.jEndpoint) return;
    if (!cfg.allowPrivatePeers && (!publicUnicast(s.hostEndpoint.ip) || !publicUnicast(f.jEndpoint.ip))) return;
    udpSend(encode({ type: T.PEER_INFO, flags: F_HOST, flow: f.id, seq: f.seqToJ++, payload: peerPayload(s.hostEndpoint.ip, s.hostEndpoint.port) }, f.kJ), f.jEndpoint.port, f.jEndpoint.ip);
    udpSend(encode({ type: T.PEER_INFO, flags: 0, flow: f.id, seq: f.seqToH++, payload: peerPayload(f.jEndpoint.ip, f.jEndpoint.port) }, f.kH), s.hostEndpoint.port, s.hostEndpoint.ip);
    stats.punchInfo++;
  }

  // ---- housekeeping ----------------------------------------------------------------------------------------------

  function sweep() {
    const t = now();
    for (const inv of [...invites.values()]) {
      if (inv.expires <= t) dropInvite(inv);
    }
    for (const f of [...flows.values()]) {
      if (t - f.lastSeen > L.flowIdleSeconds * 1000) closeFlow(f, "idle");
      else if (t - f.createdAt > L.flowMaxSeconds * 1000) closeFlow(f, "expired");
    }
    for (const s of [...sessions.values()]) {
      if (!idleOk(s)) closeSession(s, "idle");
      else if (t - s.createdAt > L.sessionMaxSeconds * 1000) closeSession(s, "expired");
    }
    for (const s of sessions.values()) if (s.listing && !listingLive(s)) unlist(s);
    limitOpen.sweep(); limitInvite.sweep(); limitRedeem.sweep(); limitRedeemFail.sweep();
    limitListing.sweep(); limitPublicList.sweep(); limitPublicJoinIp.sweep(); limitPublicJoinAccount.sweep(); limitPublicJoinSession.sweep(); limitPublicFail.sweep();
  }

  // For h9web: an account that is suspended or signed out everywhere loses its sessions at once.
  function closeAccountSessions(accountId, reason = "account") {
    for (const s of [...sessions.values()]) if (s.accountId === accountId) closeSession(s, reason);
  }

  async function start() {
    if (!cfg.enabled || udp) return { udp: null };
    udp = dgram.createSocket({ type: "udp4", reuseAddr: false });
    udp.on("message", (m, r) => { try { onPacket(m, r); } catch (e) { drop("exception"); log("udp.error", { error: String(e && e.message) }); } });
    udp.on("error", (e) => log("udp.socket_error", { error: e.message }));
    await new Promise((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(cfg.bind.udp.port, cfg.bind.udp.host, () => { udp.off("error", reject); resolve(); });
    });
    timer = setInterval(sweep, 1000);
    timer.unref();
    return { udp: udp.address() };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    for (const s of [...sessions.values()]) closeSession(s, "shutdown");
    if (udp) { try { udp.close(); } catch (e) { /* closed */ } udp = null; }
  }

  return {
    handleHttp, start, stop, sweep, closeAccountSessions,
    config: cfg,
    stats: () => ({ ...stats, drops: { ...stats.drops }, sessions: sessions.size, flows: flows.size, invites: invites.size, listed: listedCount() }),
    // test hooks: read-only views
    _debug: { sessions, flows, invites, publicById },
    MAX_PAYLOAD, unb64,
  };
}
