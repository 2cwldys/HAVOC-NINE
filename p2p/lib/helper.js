// h9p2p: the helper that carries a game's UDP over the P2P path. Two roles in one file:
//   HostHelper  runs beside a listen (or dedicated) game: opens a session at the service, mints invites, and for every
//               friend that redeems one makes a loopback socket of its own that talks to the game as that friend;
//   JoinHelper  runs on the friend's PC: redeems an invite and opens a local UDP address that the stock engine connects to.
// Both carry a flow over two legs at once: the RELAY leg (through the service, always available once the first HELLO is
// answered) and, when host, invite and joiner all allow it, the DIRECT leg (a hole punched between the two NATs). A flow uses
// the direct leg while authenticated packets keep arriving on it and falls back to the relay leg the moment they stop.
//
// What the helper will send to: the game on loopback, the service, and a peer's address that came from the service in a
// packet that verified (or from a packet that verified on the direct leg). Nothing else. A joiner's address is never
// shown to the game, the person or the log.

import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  T, F_HOST, F_WANT_PEER, ReplayWindow, decodeHeader, payloadOf, verify, encode, hostFlowKey, helloPayload, parseAck, parsePeer,
  publicUnicast, MAX_PAYLOAD,
} from "./wire.js";
import { TokenBucket } from "./limits.js";
import { unb64, b64, normaliseCode, loopbackAlias } from "./codes.js";

// ---- a small JSON client over node:http(s), so there is nothing to install ---------------------------------------------

// base is the service's base URL, with or without a path prefix (https://havoc9.org/api/p2p): the service-relative path is appended to the
// base's own path, never resolved against it (new URL("/v1/x", base) would drop the prefix).
export function serviceUrl(base, path) {
  return new URL(String(base).replace(/\/+$/, "") + path);
}

export function httpJson(base, path, { method = "POST", headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = serviceUrl(base, path);
    const lib = url.protocol === "https:" ? https : http;
    const data = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = lib.request(url, {
      method, timeout: timeoutMs, agent: false, // one connection per request: a restarted service never meets a stale socket
      headers: { "Content-Type": "application/json", "Content-Length": data.length, "User-Agent": "h9_p2p/0.1", ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json, retryAfter: Number(res.headers["retry-after"]) || 0 });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

export function signHeaders(method, path, session, hostKey, body) {
  const raw = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const t = String(Date.now());
  const n = crypto.randomBytes(8).toString("hex");
  const bodyMac = crypto.createHmac("sha256", hostKey).update(Buffer.concat([Buffer.from("body\n"), raw])).digest("hex");
  const m = crypto.createHmac("sha256", hostKey).update(method + "\n" + path + "\n" + t + "\n" + n + "\n" + bodyMac).digest("hex");
  return { "X-H9-Sig": "s=" + session + ";t=" + t + ";n=" + n + ";m=" + m };
}

const lookup4 = (host) => new Promise((resolve, reject) => {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return resolve(host);
  dns.lookup(host, { family: 4 }, (err, addr) => (err ? reject(err) : resolve(addr)));
});

const PUNCH_MS = 250;
const DIRECT_DEAD_MS = 4000;
const PUNCH_GIVE_UP_MS = 60000; // a punch window: how long the two ends try, once it opens
const RETRY_PUNCH_MS = 120000; // after a window ends without a direct leg, the next one opens this long after it began
const SUSPECT_MS = 1000; // a direct leg quiet for this long is not trusted yet: game datagrams go through the relay as well

// ---- one flow, one role: both legs, the choice between them ------------------------------------------------------------------

class PathEndpoint {
  constructor({ role, flow, relayKey, pairKey, sock, svc, directWanted, relayWanted, allowPrivate, onData, onPath, log }) {
    this.role = role; // "host" | "joiner"
    this.flow = flow;
    this.relayKey = relayKey;
    this.pairKey = pairKey;
    this.sock = sock;
    this.svc = svc; // { ip, port }
    this.directWanted = directWanted;
    this.relayWanted = relayWanted;
    this.allowPrivate = allowPrivate;
    this.onData = onData;
    this.onPath = onPath;
    this.log = log;
    this.flags = role === "host" ? F_HOST : 0; // origin role of what I send
    this.seqRelay = 1;
    this.seqDirect = 1;
    this.relayWin = new ReplayWindow();
    this.directWin = new ReplayWindow();
    this.peer = null; // { ip, port } of the other end, direct leg
    this.peerFromService = false;
    this.directUp = false;
    this.lastDirectRx = 0;
    this.lastSvcRx = 0;
    this.helloAcked = false;
    this.observed = null;
    this.startedAt = Date.now();
    this.punchFrom = this.startedAt; // when the current punch window opened
    this.reported = "relay"; // the leg last reported through onPath
    this.lastPunch = 0;
    this.lastHello = 0;
    this.lastKeep = 0;
    this.closed = false;
    this.stats = { relayTx: 0, relayRx: 0, directTx: 0, directRx: 0, drop: 0, punchTx: 0, relayTxBytes: 0, relayRxBytes: 0, directTxBytes: 0, directRxBytes: 0 };
    this.bucket = new TokenBucket(1500, 3000);
  }

  get path() {
    return this.directUp && Date.now() - this.lastDirectRx < DIRECT_DEAD_MS ? "direct" : "relay";
  }

  raw(buf, port, ip) {
    this.sock.send(buf, port, ip, () => {});
  }

  hello() {
    const wantPeer = this.directWanted && this.path !== "direct" && Date.now() - this.punchFrom < PUNCH_GIVE_UP_MS;
    const nonce = crypto.randomBytes(8);
    this.raw(encode({ type: T.HELLO, flags: this.flags | (wantPeer ? F_WANT_PEER : 0), flow: this.flow, seq: this.seqRelay++, payload: helloPayload(nonce) }, this.relayKey), this.svc.port, this.svc.ip);
    this.lastHello = Date.now();
  }

  // game -> the other end
  send(payload) {
    if (this.closed || payload.length > MAX_PAYLOAD) return;
    if (!this.bucket.take(1)) { this.stats.drop++; return; }
    const direct = this.path === "direct" && this.peer;
    let sent = false;
    if (direct) {
      this.raw(encode({ type: T.DATA, flags: this.flags, flow: this.flow, seq: this.seqDirect++, payload }, this.pairKey), this.peer.port, this.peer.ip);
      this.stats.directTx++;
      this.stats.directTxBytes += payload.length;
      sent = true;
    }
    // no direct leg, or one that has gone quiet: through the relay too (the game's netchannel drops the duplicate)
    if ((!direct || Date.now() - this.lastDirectRx > SUSPECT_MS) && this.relayWanted && this.helloAcked) {
      this.raw(encode({ type: T.DATA, flags: this.flags, flow: this.flow, seq: this.seqRelay++, payload }, this.relayKey), this.svc.port, this.svc.ip);
      this.stats.relayTx++;
      this.stats.relayTxBytes += payload.length;
      sent = true;
    }
    if (!sent) this.stats.drop++;
  }

  setPeer(ip, port, fromService) {
    if (!this.directWanted || !publicUnicast(ip, this.allowPrivate) || port < 1) return;
    if (!this.peer || this.peer.ip !== ip || this.peer.port !== port) {
      this.peer = { ip, port };
      this.peerFromService = fromService;
    }
  }

  // A packet of this flow came in. h is its decoded header.
  handle(msg, rinfo, h) {
    if (this.closed) return;
    const fromSvc = rinfo.address === this.svc.ip && rinfo.port === this.svc.port;
    // what the sender claims to be must be the OTHER role than mine
    if (h.host === (this.role === "host")) { this.stats.drop++; return; }
    if (fromSvc) {
      if (!verify(msg, this.relayKey) || !this.relayWin.accept(h.seq)) { this.stats.drop++; return; }
      this.lastSvcRx = Date.now();
      switch (h.type) {
        case T.HELLO_ACK: {
          const a = parseAck(payloadOf(msg));
          if (a) {
            this.observed = { ip: a.ip, port: a.port };
            if (!this.helloAcked) { this.helloAcked = true; this.onPath("relay", { first: true }); }
          }
          return;
        }
        case T.DATA:
          this.stats.relayRx++;
          this.stats.relayRxBytes += h.payloadLength;
          return this.onData(payloadOf(msg));
        case T.PEER_INFO: {
          const p = parsePeer(payloadOf(msg));
          if (p) this.setPeer(p.ip, p.port, true);
          return;
        }
        case T.CLOSE:
          return this.onPath("closed", { reason: "peer" });
        default:
          return;
      }
    }
    // the direct leg: only a peer that holds the pair key is heard, wherever the packet comes from
    if (!this.directWanted || !this.pairKey) { this.stats.drop++; return; }
    if (!verify(msg, this.pairKey) || !this.directWin.accept(h.seq)) { this.stats.drop++; return; }
    if (!publicUnicast(rinfo.address, this.allowPrivate)) { this.stats.drop++; return; }
    this.lastDirectRx = Date.now();
    this.setPeer(rinfo.address, rinfo.port, false); // latch: the NAT's real source wins (roaming, and the symmetric side's real port)
    switch (h.type) {
      case T.PUNCH:
        this.raw(encode({ type: T.PUNCH_ACK, flags: this.flags, flow: this.flow, seq: this.seqDirect++, payload: payloadOf(msg).subarray(0, 8) }, this.pairKey), rinfo.port, rinfo.address);
        break;
      case T.PUNCH_ACK:
        this.directUp = true;
        break;
      case T.DATA:
        this.directUp = true;
        this.stats.directRx++;
        this.stats.directRxBytes += h.payloadLength;
        this.onData(payloadOf(msg));
        break;
      case T.KEEPALIVE:
        this.directUp = true;
        break;
      default:
        break;
    }
    this.reportPath();
  }

  tick() {
    if (this.closed) return;
    const t = Date.now();
    if (this.directUp && t - this.lastDirectRx >= DIRECT_DEAD_MS) {
      this.directUp = false;
      this.punchFrom = t; // the direct leg died: a new punch window
    } else if (!this.directUp && this.directWanted && t - this.punchFrom >= RETRY_PUNCH_MS) {
      this.punchFrom = t; // gave up: try again now and then
    }
    // the relay leg: HELLO is the NAT keepalive and, while a punch window is open, the request for the peer's address
    const helloEvery = !this.helloAcked ? 500 : this.directWanted && this.path !== "direct" && t - this.punchFrom < 15000 ? 1000 : 5000;
    if (t - this.lastHello >= helloEvery) this.hello();
    // the direct leg
    if (this.directWanted && this.peer) {
      if (this.path !== "direct") {
        if (t - this.punchFrom < PUNCH_GIVE_UP_MS && t - this.lastPunch >= PUNCH_MS) {
          this.lastPunch = t;
          this.stats.punchTx++;
          this.raw(encode({ type: T.PUNCH, flags: this.flags, flow: this.flow, seq: this.seqDirect++, payload: crypto.randomBytes(8) }, this.pairKey), this.peer.port, this.peer.ip);
        }
      } else if (t - this.lastKeep >= 2000) {
        this.lastKeep = t;
        this.raw(encode({ type: T.KEEPALIVE, flags: this.flags, flow: this.flow, seq: this.seqDirect++ }, this.pairKey), this.peer.port, this.peer.ip);
      }
    }
    this.reportPath();
  }

  // tells the owner when the leg in use changes (the leg is a function of time: a direct leg that has gone quiet is the relay leg)
  reportPath() {
    const p = this.path;
    if (p !== this.reported) {
      this.reported = p;
      this.onPath(p, {});
    }
  }

  close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    if (notify) this.raw(encode({ type: T.CLOSE, flags: this.flags, flow: this.flow, seq: this.seqRelay++, payload: Buffer.from([1]) }, this.relayKey), this.svc.port, this.svc.ip);
  }
}

// ---- the host ---------------------------------------------------------------------------------------------------------------

export class HostHelper extends EventEmitter {
  // opts: service (base URL), token, game { host, port }, name, direct, relay, allowPrivatePeers, bindAddress
  constructor(opts) {
    super();
    this.o = { direct: true, relay: true, allowPrivatePeers: false, bindAddress: "0.0.0.0", ...opts };
    this.game = this.o.game || { host: "127.0.0.1", port: 27015 };
    this.flows = new Map();
    this.closed = false;
    this.session = null;
  }

  async open() {
    const r = await httpJson(this.o.service, "/v1/host/open", {
      headers: { Authorization: "Bearer " + this.o.token },
      body: { v: 1, name: this.o.name || "", directAllowed: this.o.direct, relayAllowed: this.o.relay },
    });
    if (r.status !== 200 || !r.json) throw Object.assign(new Error("open refused: " + r.status + " " + JSON.stringify(r.json)), { status: r.status, retryAfter: r.retryAfter });
    const j = r.json;
    this.session = j.session;
    this.ctl = j.ctl;
    this.hostKey = unb64(j.hostKey);
    this.virtual = j.virtual;
    this.direct = j.direct && this.o.direct;
    this.relay = j.relay && this.o.relay;
    const ip = await lookup4(j.udp.host);
    this.svc = { ip, port: j.udp.port };
    this.sock = dgram.createSocket("udp4");
    this.sock.on("message", (m, r2) => this.onPacket(m, r2));
    this.sock.on("error", (e) => this.emit("error", e));
    await new Promise((res) => this.sock.bind(0, this.o.bindAddress, res));
    this.ctlSeq = 1;
    this.ctlWin = new ReplayWindow();
    this.helloCtl();
    this.timer = setInterval(() => this.tick(), 100);
    this.ctlTimer = setInterval(() => this.helloCtl(), 5000);
    this.pollLoop();
    this.emit("ready", { session: this.session, virtual: this.virtual, direct: this.direct, relay: this.relay });
    return this;
  }

  helloCtl() {
    if (this.closed) return;
    const buf = encode({ type: T.HELLO, flags: F_HOST, flow: this.ctl, seq: this.ctlSeq++, payload: helloPayload(crypto.randomBytes(8)) }, this.hostKey);
    this.sock.send(buf, this.svc.port, this.svc.ip, () => {});
  }

  async api(path, body) {
    return httpJson(this.o.service, path, { headers: signHeaders("POST", path, this.session, this.hostKey, body), body, timeoutMs: 40000 });
  }

  // direct: whether THIS invite may use the direct leg, i.e. whether the friend may learn the host's address. Off unless the host says so.
  async invite({ ttl = 600, uses = 1, label = "", requireAccount = false, direct = false } = {}) {
    const r = await this.api("/v1/host/invite", { ttl, uses, label, requireAccount, direct });
    if (r.status !== 200) throw Object.assign(new Error("invite refused: " + r.status), { status: r.status, retryAfter: r.retryAfter });
    return r.json;
  }

  // The session's public listing (POST /v1/host/listing). Answers { status, json, retryAfter } as the service gave them.
  async listing(body) {
    return this.api("/v1/host/listing", body);
  }

  async revoke(what) {
    const r = await this.api("/v1/host/revoke", what);
    return r.json;
  }

  async pollLoop() {
    let backoff = 500;
    while (!this.closed) {
      let r;
      try {
        r = await this.api("/v1/host/poll", { wait: 20 });
      } catch (e) {
        if (this.closed) return;
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, 8000);
        continue;
      }
      if (this.closed) return;
      if (r.status === 401) { this.emit("session-lost"); return; }
      if (r.status !== 200 || !r.json) {
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, 8000);
        continue;
      }
      backoff = 500;
      for (const ev of r.json.events || []) this.onEvent(ev);
    }
  }

  onEvent(ev) {
    if (ev.t === "joiner") return this.addFlow(ev);
    if (ev.t === "gone") return this.removeFlow(ev.flow, ev.reason);
    if (ev.t === "closed") { this.emit("session-lost", { reason: ev.reason }); }
  }

  addFlow(ev) {
    if (this.flows.has(ev.flow)) return;
    // one loopback socket per friend, bound to a loopback alias of its own: the game sees a different address for every friend
    const alias = loopbackAlias(100, ev.account ? "a" + ev.account.id : "i" + ev.invite);
    const local = dgram.createSocket("udp4");
    const hf = { flow: ev.flow, label: ev.label, account: ev.account, alias, local, ep: null };
    const bindTo = (addr) => new Promise((res, rej) => { local.once("error", rej); local.bind(0, addr, () => { local.off("error", rej); res(); }); });
    bindTo(alias).catch(() => bindTo("127.0.0.1")).then(() => {
      if (this.closed || !this.flows.has(ev.flow)) { try { local.close(); } catch (e) { /* closed */ } return; }
      hf.localAddress = local.address();
      const ep = new PathEndpoint({
        role: "host", flow: ev.flow, relayKey: hostFlowKey(this.hostKey, ev.flow), pairKey: unb64(ev.pairKey), sock: this.sock, svc: this.svc,
        directWanted: !!ev.direct && this.direct, relayWanted: this.relay, allowPrivate: this.o.allowPrivatePeers,
        onData: (payload) => local.send(payload, this.game.port, this.game.host, () => {}),
        onPath: (path, info) => this.onPath(hf, path, info),
        log: () => {},
      });
      hf.ep = ep;
      local.on("message", (msg, rinfo) => {
        if (rinfo.port !== this.game.port) return;
        ep.send(msg);
      });
      local.on("error", () => {});
      ep.hello();
      this.emit("joiner", {
        flow: ev.flow, label: ev.label, account: ev.account, invite: ev.invite || null, public: ev.public === true,
        direct: !!ev.direct && this.direct, loopback: hf.localAddress.address + ":" + hf.localAddress.port,
      });
    });
    this.flows.set(ev.flow, hf);
  }

  onPath(hf, path, info) {
    if (path === "closed") return this.removeFlow(hf.flow, "peer");
    this.emit("path", { flow: hf.flow, path, first: !!info.first });
  }

  removeFlow(flow, reason) {
    const hf = this.flows.get(flow);
    if (!hf) return;
    this.flows.delete(flow);
    if (hf.ep) hf.ep.close(false);
    try { hf.local.close(); } catch (e) { /* closed */ }
    this.emit("gone", { flow, reason });
  }

  kick(flow) {
    return this.revoke({ flow });
  }

  onPacket(msg, rinfo) {
    const h = decodeHeader(msg);
    if (!h) return;
    if (h.flow === this.ctl) {
      // the session's own HELLO_ACK
      const fromSvc = rinfo.address === this.svc.ip && rinfo.port === this.svc.port;
      if (fromSvc && !h.host && h.type === T.HELLO_ACK && verify(msg, this.hostKey) && this.ctlWin.accept(h.seq)) {
        const a = parseAck(payloadOf(msg));
        if (a) this.observed = { ip: a.ip, port: a.port };
      }
      return;
    }
    const hf = this.flows.get(h.flow);
    if (hf && hf.ep) hf.ep.handle(msg, rinfo, h);
  }

  tick() {
    for (const hf of this.flows.values()) if (hf.ep) hf.ep.tick();
  }

  stats() {
    const out = {};
    for (const hf of this.flows.values()) if (hf.ep) out[hf.flow] = { label: hf.label, path: hf.ep.path, ...hf.ep.stats };
    return out;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.ctlTimer);
    for (const hf of this.flows.values()) { if (hf.ep) hf.ep.close(true); try { hf.local.close(); } catch (e) { /* closed */ } }
    this.flows.clear();
    try { await httpJson(this.o.service, "/v1/host/close", { headers: signHeaders("POST", "/v1/host/close", this.session, this.hostKey, {}), body: {}, timeoutMs: 3000 }); } catch (e) { /* the service times the session out */ }
    try { this.sock.close(); } catch (e) { /* closed */ }
  }
}

// ---- the joiner -------------------------------------------------------------------------------------------------------------

export class JoinHelper extends EventEmitter {
  // opts: service, code, listen { host ("auto" = the session's virtual loopback address), port }, direct, relay, account, allowPrivatePeers
  constructor(opts) {
    super();
    this.o = { direct: true, relay: true, allowPrivatePeers: false, bindAddress: "0.0.0.0", listen: { host: "auto", port: 27015 }, ...opts };
    this.closed = false;
  }

  async start() {
    const code = normaliseCode(this.o.code);
    if (!code) throw Object.assign(new Error("that is not an invite code"), { status: 400 });
    const r = await httpJson(this.o.service, "/v1/join/redeem", { body: { v: 1, code, direct: this.o.direct, account: this.o.account || undefined } });
    if (r.status !== 200 || !r.json) throw Object.assign(new Error("invite refused: " + r.status + " " + JSON.stringify(r.json)), { status: r.status, retryAfter: r.retryAfter });
    const j = r.json;
    this.flow = j.flow;
    this.hostName = j.host && j.host.name;
    this.virtual = j.virtual;
    const direct = !!j.direct && this.o.direct;
    const relay = !!j.relay && this.o.relay;
    const ip = await lookup4(j.udp.host);
    this.svc = { ip, port: j.udp.port };
    this.sock = dgram.createSocket("udp4");
    this.sock.on("error", (e) => this.emit("error", e));
    await new Promise((res) => this.sock.bind(0, this.o.bindAddress, res));
    this.gameAddr = null;
    this.ep = new PathEndpoint({
      role: "joiner", flow: j.flow, relayKey: unb64(j.jKey), pairKey: unb64(j.pairKey), sock: this.sock, svc: this.svc,
      directWanted: direct, relayWanted: relay, allowPrivate: this.o.allowPrivatePeers,
      onData: (payload) => { if (this.gameAddr) this.local.send(payload, this.gameAddr.port, this.gameAddr.address, () => {}); },
      onPath: (path, info) => this.onPath(path, info),
      log: () => {},
    });
    this.sock.on("message", (m, r2) => {
      const h = decodeHeader(m);
      if (h && h.flow === this.flow) this.ep.handle(m, r2, h);
    });
    const listenHost = this.o.listen.host === "auto" ? this.virtual : this.o.listen.host;
    // The port asked for is the game's usual one. Another program may hold it (the friend's own listen game, a second helper for the same host):
    // then any free port does, and the ready line says which.
    const bindLocal = (port) => new Promise((res, rej) => {
      const s = dgram.createSocket("udp4");
      const fail = (e) => { try { s.close(); } catch (e2) { /* closed */ } rej(e); };
      s.once("error", fail);
      s.bind(port, listenHost, () => { s.off("error", fail); res(s); });
    });
    try {
      this.local = await bindLocal(this.o.listen.port);
    } catch (e) {
      if (e.code !== "EADDRINUSE" || !this.o.listen.port) { try { this.sock.close(); } catch (e2) { /* closed */ } throw e; }
      this.local = await bindLocal(0);
    }
    this.local.on("error", (e) => this.emit("error", e));
    this.localAddress = this.local.address();
    this.local.on("message", (msg, rinfo) => { this.gameAddr = rinfo; this.ep.send(msg); });
    this.timer = setInterval(() => this.ep.tick(), 100);
    this.ep.hello();
    return this;
  }

  onPath(path, info) {
    if (path === "closed") { this.emit("closed", info); return this.close(false); }
    if (info.first) this.emit("ready", { listen: this.localAddress.address + ":" + this.localAddress.port, host: this.hostName });
    this.emit("path", { path });
  }

  stats() {
    return { path: this.ep.path, ...this.ep.stats, observed: this.ep.observed };
  }

  async close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.ep) this.ep.close(notify);
    try { this.sock.close(); } catch (e) { /* closed */ }
    try { this.local.close(); } catch (e) { /* closed */ }
  }
}

export { b64 };
