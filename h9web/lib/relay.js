// The web client's relay: one WebSocket per engine UDP socket, for signed-in players only.
//
// The contract with the page is D:\temp\relay-protocol.txt (copied into README.txt): every
// binary message is 4 bytes of IPv4 address, 2 of port (network order), then one UDP payload.
// From the page the address is where the datagram goes; to the page it is where it came from.
//
// On the upgrade the relay wants a valid WebSocket request, an Origin from config.allowedOrigins
// and a live session cookie of an account that is not suspended; past that, room under the
// socket caps (per account, per IP, in total). Each accepted WebSocket gets a UDP socket of its
// own, on a port of its own, kept for the WebSocket's whole life, so a game server sees one
// stable address per engine socket.
//
// A datagram from the page goes out only when its address is
//   - the reserved master address: the relay answers the master query itself, with the
//     servers on servers.json (master.js); or
//   - a server on servers.json: it goes to that server's target.
// Anything else is dropped. Datagrams reaching the UDP socket from anywhere but a listed
// server's target are dropped too. Never an open relay.
//
// Limits: datagrams and bytes per second per account and per IP (token buckets shared by all
// of that account's or IP's sockets; datagrams over the rate are dropped, and a socket that
// keeps sending mostly dropped datagrams for abuseCloseSeconds is closed), the datagram size
// (maxDatagram), an idle timeout (no datagram from the page), and a ping every pingSeconds that
// a live browser answers by itself. The session is checked again every sessionCheckSeconds, and
// at once when this process signs it out, changes the password or suspends the account.
//
// Events on the shared emitter, for modules (modules/presence):
//   relay-open { accountId }                     a socket opened for the account
//   relay-close { accountId }                    that socket closed
//   relay-game-start { accountId, server }       the socket began sending a listed server the
//                                                game's own traffic (not a connectionless query);
//                                                server is its address as servers.json lists it
//   relay-game-end { accountId, server }         no game traffic to that server for 15 seconds,
//                                                or the socket closed

import dgram from "node:dgram";
import { checkUpgrade, refuseUpgrade, acceptUpgrade, WebSocketConnection } from "./websocket.js";
import { RateLimiter, TokenBucket, takeAll, ipKey } from "./ratelimit.js";
import { clientIp } from "./http.js";
import { parseAddress } from "./servers.js";
import { parseMasterQuery, buildMasterReplies } from "./master.js";

export const CLOSE = { SIGNED_OUT: 4401, SUSPENDED: 4403, IDLE: 4408, FLOOD: 4429, SHUTDOWN: 1001, TEXT: 1003, MALFORMED: 1007, UDP_ERROR: 1011 };

export function createRelay({ config, auth, servers, events, log }) {
  const rc = config.relay;
  const master = parseAddress(rc.master);
  if (!master) throw new Error("config: relay.master must be IPv4:port");
  const upgrades = new RateLimiter(config.limits.upgradePerIp);
  const sockets = new Set();
  const groups = { account: new Map(), ip: new Map() };
  const totals = { opened: 0, refused: 0, sent: 0, received: 0, dropped: 0 };
  // The events listed at the top of this file. A listener that throws is logged and goes no
  // further: it never breaks the relay's own work.
  const tell = (name, data) => {
    try { events.emit(name, data); } catch (e) { log.error("relay.event_listener", { event: name, error: e.message }); }
  };

  // The buckets of an account or IP outlive its last socket by a minute, so closing and opening
  // sockets does not refill them.
  function group(kind, key, limits) {
    let g = groups[kind].get(key);
    if (!g) {
      g = { count: 0, idleSince: 0, packets: new TokenBucket(limits.packetsPerSecond, limits.packetBurst), bytes: new TokenBucket(limits.bytesPerSecond, limits.byteBurst) };
      groups[kind].set(key, g);
    }
    return g;
  }

  function release(kind, key) {
    const g = groups[kind].get(key);
    if (g && --g.count <= 0) {
      g.count = 0;
      g.idleSince = Date.now();
    }
  }

  function sweepGroups() {
    const t = Date.now();
    for (const map of Object.values(groups)) {
      for (const [key, g] of map) if (g.count === 0 && t - g.idleSince > 60000) map.delete(key);
    }
  }

  function handleUpgrade(req, socket, head) {
    const ip = clientIp(req, config.trustProxy);
    const ipk = ipKey(ip);
    const refuse = (status, why, headers) => {
      totals.refused++;
      log.debug("relay.refused", { status, why });
      refuseUpgrade(socket, status, headers);
    };
    if (!rc.enabled) return refuse(404, "relay off");
    const v = checkUpgrade(req);
    if (!v.ok) return refuse(v.status, "not a websocket upgrade", v.headers);
    const lim = upgrades.hit(ipk);
    if (!lim.ok) return refuse(429, "too many upgrades", { "Retry-After": lim.retryAfter });
    if (!auth.checkWebSocketOrigin(req)) return refuse(403, "origin");
    const s = auth.sessionFromRequest(req);
    if (!s || s.banned) return refuse(401, s ? "suspended" : "not signed in");
    const accountKey = String(s.account.id);
    const ga = groups.account.get(accountKey);
    const gi = groups.ip.get(ipk);
    if (sockets.size >= rc.maxSocketsTotal || (ga && ga.count >= rc.maxSocketsPerAccount) || (gi && gi.count >= rc.maxSocketsPerIp)) {
      return refuse(429, "socket cap", { "Retry-After": 10 });
    }
    acceptUpgrade(socket, v.key);
    const ws = new WebSocketConnection(socket, head, { maxMessage: 6 + rc.maxDatagram, maxPendingBytes: rc.maxPendingBytes });
    open(ws, s, ipk);
  }

  function open(ws, s, ipk) {
    const accountKey = String(s.account.id);
    const acct = group("account", accountKey, rc.perAccount);
    const byIp = group("ip", ipk, rc.perIp);
    acct.count++;
    byIp.count++;
    const t = Date.now();
    const r = {
      ws, ipk, accountKey, accountId: s.account.id, username: s.account.username, tokenHash: s.session.token_hash,
      udp: dgram.createSocket("udp4"),
      openedAt: t, lastFromPage: t, lastPing: t,
      sec: { passed: 0, dropped: 0 }, floodSeconds: 0,
      masterBucket: new TokenBucket(rc.masterQueriesPerSecond, rc.masterQueriesPerSecond * 3),
      stats: { up: 0, down: 0, master: 0, notAllowed: 0, limited: 0, foreign: 0, backpressure: 0 },
      games: new Map(), // server address -> { at: ms of the last game datagram to it }
      closed: false,
    };
    sockets.add(r);
    tell("relay-open", { accountId: r.accountId });
    totals.opened++;
    r.udp.on("error", (e) => {
      log.warn("relay.udp_error", { user: r.username, error: e.message });
      shut(r, CLOSE.UDP_ERROR, "udp error");
    });
    r.udp.on("message", (msg, rinfo) => fromServer(r, msg, rinfo));
    r.udp.bind({ port: 0, address: rc.bindAddress });
    ws.on("message", (data, binary) => fromPage(r, data, binary));
    ws.on("close", (code) => cleanup(r, code));
    log.info("relay.open", { user: r.username, sockets: acct.count });
  }

  function sendToPage(r, from, payload) {
    const frame = Buffer.allocUnsafe(6 + payload.length);
    from.bytes.copy(frame, 0);
    frame.writeUInt16BE(from.port, 4);
    payload.copy(frame, 6);
    if (!r.ws.send(frame)) r.stats.backpressure++;
  }

  function fromPage(r, data, binary) {
    if (r.closed) return;
    if (!binary) return shut(r, CLOSE.TEXT, "binary messages only");
    if (data.length < 6) return shut(r, CLOSE.MALFORMED, "message under 6 bytes");
    r.lastFromPage = Date.now();
    const len = data.length - 6;
    const acct = groups.account.get(r.accountKey);
    const byIp = groups.ip.get(r.ipk);
    if (!takeAll([[acct.packets, 1], [byIp.packets, 1], [acct.bytes, len], [byIp.bytes, len]])) {
      r.sec.dropped++;
      r.stats.limited++;
      totals.dropped++;
      return;
    }
    r.sec.passed++;
    const port = data.readUInt16BE(4);
    const key = data[0] + "." + data[1] + "." + data[2] + "." + data[3] + ":" + port;
    const payload = data.subarray(6);
    if (key === master.key) return toMaster(r, payload);
    const entry = servers.byAddress.get(key);
    if (!entry) {
      r.stats.notAllowed++;
      totals.dropped++;
      return;
    }
    r.udp.send(payload, entry.target.port, entry.target.ip);
    r.stats.up++;
    totals.sent++;
    // a datagram that is not connectionless (-1 in its first 4 bytes) is the game's own traffic
    if (payload.length >= 4 && payload.readInt32LE(0) !== -1) {
      const g = r.games.get(entry.address.key);
      if (g) g.at = Date.now();
      else {
        r.games.set(entry.address.key, { at: Date.now() });
        tell("relay-game-start", { accountId: r.accountId, server: entry.address.key });
      }
    }
  }

  function toMaster(r, payload) {
    const q = parseMasterQuery(payload);
    if (!q) return;
    if (!r.masterBucket.take(1)) {
      r.stats.limited++;
      return;
    }
    const list = servers.listed(q.info.get("gamedir") || "").map((e) => ({ bytes: e.address.bytes, port: e.address.port, key: e.address.key }));
    const key = (parseInt(q.info.get("key") || "0", 16) || 0) >>> 0;
    for (const reply of buildMasterReplies(list, { fwgs: q.fwgs, key, seed: q.seed })) sendToPage(r, master, reply);
    r.stats.master++;
  }

  function fromServer(r, msg, rinfo) {
    if (r.closed) return;
    const entry = servers.byTarget.get(rinfo.address + ":" + rinfo.port);
    if (!entry) {
      r.stats.foreign++;
      return;
    }
    sendToPage(r, entry.address, msg);
    r.stats.down++;
    totals.received++;
  }

  function shut(r, code, reason) {
    if (r.closed) return;
    r.ws.close(code, reason);
  }

  function cleanup(r, code) {
    if (r.closed) return;
    r.closed = true;
    sockets.delete(r);
    try { r.udp.close(); } catch (e) { /* closed already */ }
    release("account", r.accountKey);
    release("ip", r.ipk);
    for (const key of r.games.keys()) tell("relay-game-end", { accountId: r.accountId, server: key });
    r.games.clear();
    tell("relay-close", { accountId: r.accountId });
    log.info("relay.close", {
      user: r.username, code, seconds: Math.round((Date.now() - r.openedAt) / 1000),
      up: r.stats.up, down: r.stats.down, master: r.stats.master,
      dropped: r.stats.notAllowed + r.stats.limited + r.stats.foreign + r.stats.backpressure,
    });
  }

  function recheck(filter) {
    for (const r of sockets) {
      if (filter && !filter(r)) continue;
      const s = auth.sessionByHash(r.tokenHash);
      if (!s) shut(r, CLOSE.SIGNED_OUT, "signed out");
      else if (s.banned) shut(r, CLOSE.SUSPENDED, "account suspended");
    }
  }

  const tick = setInterval(() => {
    const t = Date.now();
    for (const r of sockets) {
      if (r.closed) continue;
      for (const [key, g] of r.games) {
        if (t - g.at > 15000) {
          r.games.delete(key);
          tell("relay-game-end", { accountId: r.accountId, server: key });
        }
      }
      r.floodSeconds = r.sec.dropped > r.sec.passed ? r.floodSeconds + 1 : 0;
      r.sec.passed = 0;
      r.sec.dropped = 0;
      if (r.floodSeconds >= rc.abuseCloseSeconds) {
        log.warn("relay.flood", { user: r.username });
        shut(r, CLOSE.FLOOD, "too much traffic");
      } else if (t - r.lastFromPage > rc.idleSeconds * 1000) {
        shut(r, CLOSE.IDLE, "idle");
      } else if (t - r.ws.lastSeen > rc.pingSeconds * 2500) {
        r.ws.terminate();
      } else if (t - r.lastPing >= rc.pingSeconds * 1000) {
        r.ws.ping();
        r.lastPing = t;
      }
    }
  }, 1000);
  tick.unref();
  const checker = setInterval(() => recheck(), rc.sessionCheckSeconds * 1000);
  checker.unref();
  const sweeper = setInterval(() => {
    upgrades.sweep();
    sweepGroups();
  }, 60000);
  sweeper.unref();

  const listeners = {
    "session-ended": ({ tokenHash }) => recheck((r) => r.tokenHash === tokenHash),
    "account-sessions-ended": ({ accountId }) => recheck((r) => r.accountId === accountId),
    "account-banned": ({ id }) => recheck((r) => r.accountId === id),
    "account-deleted": ({ id }) => setImmediate(() => recheck((r) => r.accountId === id)),
  };
  for (const [name, fn] of Object.entries(listeners)) events.on(name, fn);

  async function stop() {
    clearInterval(tick);
    clearInterval(checker);
    clearInterval(sweeper);
    for (const [name, fn] of Object.entries(listeners)) events.off(name, fn);
    for (const r of sockets) shut(r, CLOSE.SHUTDOWN, "relay restarting");
    const until = Date.now() + 1000;
    while (sockets.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    for (const r of sockets) r.ws.terminate();
  }

  return {
    handleUpgrade, stop,
    stats: () => ({ sockets: sockets.size, ...totals }),
  };
}
