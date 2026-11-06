// H9's server list: servers.json, the one list the relay, its master and /api/servers read.
//
//   { "servers": [
//       { "name": "HAVOC 9", "address": "203.0.113.10:27015" },
//       { "name": "HAVOC 9 test", "address": "203.0.113.10:27016", "target": "127.0.0.1:27016",
//         "gamedir": "ts", "listed": false, "notes": "anything; not read" }
//   ] }
//
//   address  the server's public IPv4:port, as players and the engine know it. Required, unique.
//   target   where the relay really sends (default: address). Use it when the relay runs on the
//            game server's own machine (127.0.0.1:port). Replies from target reach the page as
//            coming from address, so the engine, and the h9_clientid it salts with the address,
//            never see the difference.
//   gamedir  default config.gamedir ("ts"); the master lists a server only for its own gamedir
//   listed   default true; false keeps a server joinable through the relay but out of the
//            master's list and the website's
// The file is read again whenever it changes (checked every 2 seconds). A file that does not
// parse leaves the last good list in place; an entry that does not check out is skipped and
// logged.
//
// The status poller asks every server for A2S_INFO every status.pollSeconds and keeps the
// answers for /api/servers, in the JSON shape servers/index.html reads. A module may keep a server
// off that board (ctx.servers.hideFromBoard, lib/modules.js): the presence module hides private
// communities' servers. A module may also add fields to a server's entry (ctx.servers.annotateBoard):
// the presence module says whether the server is authenticated (auth: ok, rp, mod or off).

import fs from "node:fs";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { queryRules as defaultQueryRules } from "./a2s.js";

// "a.b.c.d:port" -> { ip, port, key, bytes } or null.
export function parseAddress(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(String(text || "").trim());
  if (!m) return null;
  const bytes = [m[1], m[2], m[3], m[4]].map(Number);
  const port = Number(m[5]);
  if (bytes.some((b) => b > 255) || port < 1 || port > 65535) return null;
  const ip = bytes.join(".");
  return { ip, port, key: ip + ":" + port, bytes: Buffer.from(bytes) };
}

// Addresses that can never be a game server: this-network, multicast, reserved and broadcast.
function unusable(a) {
  const first = a.bytes[0];
  return first === 0 || first >= 224;
}

export function validateServers(raw, { gamedir = "ts", master = null } = {}) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.servers) ? raw.servers : null;
  if (!list) return { entries: [], problems: ["no \"servers\" list"] };
  const entries = [];
  const problems = [];
  const seenAddress = new Set();
  const seenTarget = new Set();
  list.forEach((s, i) => {
    const where = "servers[" + i + "]";
    if (!s || typeof s !== "object") return problems.push(where + ": not an object");
    const address = parseAddress(s.address);
    if (!address) return problems.push(where + ": address must be IPv4:port");
    const target = s.target === undefined || s.target === "" ? address : parseAddress(s.target);
    if (!target) return problems.push(where + ": target must be IPv4:port");
    if (unusable(address) || unusable(target)) return problems.push(where + ": " + address.key + " cannot be a game server");
    if (master && (address.key === master.key || target.key === master.key)) return problems.push(where + ": that is the master's reserved address");
    if (seenAddress.has(address.key)) return problems.push(where + ": " + address.key + " is listed twice");
    if (seenTarget.has(target.key)) return problems.push(where + ": target " + target.key + " is used twice");
    const gd = s.gamedir === undefined ? gamedir : String(s.gamedir);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(gd)) return problems.push(where + ": bad gamedir");
    seenAddress.add(address.key);
    seenTarget.add(target.key);
    entries.push({
      name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 64) : null,
      address, target,
      gamedir: gd.toLowerCase(),
      listed: s.listed !== false,
    });
  });
  return { entries, problems };
}

export class ServerList extends EventEmitter {
  constructor({ file, gamedir = "ts", master = null, log = null, intervalMs = 2000 }) {
    super();
    this.file = file;
    this.gamedir = gamedir;
    this.master = master;
    this.log = log;
    this.intervalMs = intervalMs;
    this.setEntries([]);
    this.lastText = null;
    this.watching = false;
  }

  setEntries(entries) {
    this.entries = entries;
    this.byAddress = new Map(entries.map((e) => [e.address.key, e]));
    this.byTarget = new Map(entries.map((e) => [e.target.key, e]));
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if (this.lastText !== "") {
        if (this.log) this.log.warn("servers.missing", { file: this.file, note: "the relay reaches no server until it exists" });
        this.lastText = "";
        this.setEntries([]);
        this.emit("change", this.entries);
      }
      return false;
    }
    if (text === this.lastText) return true;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      if (this.log) this.log.error("servers.unreadable", { file: this.file, error: e.message, kept: this.entries.length });
      this.lastText = text;
      return false;
    }
    const { entries, problems } = validateServers(raw, { gamedir: this.gamedir, master: this.master });
    for (const p of problems) if (this.log) this.log.warn("servers.skipped", { problem: p });
    this.lastText = text;
    this.setEntries(entries);
    if (this.log) this.log.info("servers.loaded", { count: entries.length });
    this.emit("change", this.entries);
    return true;
  }

  watch() {
    if (this.watching) return;
    this.watching = true;
    fs.watchFile(this.file, { interval: this.intervalMs, persistent: false }, () => this.load());
  }

  stop() {
    if (this.watching) fs.unwatchFile(this.file);
    this.watching = false;
  }

  // The servers the master lists for a gamedir ("" = every gamedir).
  listed(gamedir = "") {
    const gd = String(gamedir || "").toLowerCase();
    return this.entries.filter((e) => e.listed && (!gd || e.gamedir === gd));
  }
}

const A2S_INFO = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("TSource Engine Query\0", "latin1")]);

function readString(buf, at) {
  const end = buf.indexOf(0, at.i);
  if (end < 0) throw new Error("short");
  const s = buf.subarray(at.i, end).toString("utf8");
  at.i = end + 1;
  return s;
}

function cleanText(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
}

// An A2S_INFO answer: { kind: "ip" | "gs", name, map, folder, mode, players, max, bots }, or
// { challenge } for a challenge reply, or null.
export function parseInfoReply(buf) {
  if (buf.length < 6 || buf.readInt32LE(0) !== -1) return null;
  const type = buf[4];
  const at = { i: 5 };
  try {
    if (type === 0x41 && buf.length >= 9) return { challenge: buf.subarray(5, 9) };
    if (type === 0x49) {
      at.i++; // protocol
      const name = readString(buf, at), map = readString(buf, at), folder = readString(buf, at), mode = readString(buf, at);
      at.i += 2; // app id
      const players = buf[at.i], max = buf[at.i + 1], bots = buf[at.i + 2];
      if (bots === undefined) return null;
      return { kind: "ip", name: cleanText(name), map: cleanText(map), folder: cleanText(folder), mode: cleanText(mode), players, max, bots };
    }
    if (type === 0x6d) {
      readString(buf, at); // address
      const name = readString(buf, at), map = readString(buf, at), folder = readString(buf, at), mode = readString(buf, at);
      const players = buf[at.i], max = buf[at.i + 1];
      if (max === undefined) return null;
      at.i += 3; // players, max, protocol
      at.i += 3; // server type, environment, visibility
      let bots = 0;
      const isMod = buf[at.i++];
      if (isMod === 1) {
        readString(buf, at);
        readString(buf, at);
        at.i += 1 + 4 + 4 + 1 + 1;
      }
      at.i++; // vac
      if (at.i < buf.length) bots = buf[at.i];
      return { kind: "gs", name: cleanText(name), map: cleanText(map), folder: cleanText(folder), mode: cleanText(mode), players, max, bots };
    }
  } catch (e) {
    return null;
  }
  return null;
}

export class StatusPoller {
  constructor({ servers, log = null, pollSeconds = 30, timeoutMs = 1500, expireSeconds = 120, rulesSeconds = 60, gamedir = "ts", queryRules = defaultQueryRules }) {
    this.servers = servers;
    this.log = log;
    this.pollMs = pollSeconds * 1000;
    this.timeoutMs = timeoutMs;
    this.expireMs = expireSeconds * 1000;
    this.rulesMs = rulesSeconds * 1000;
    this.queryRules = queryRules;
    this.gamedir = gamedir;
    // target key -> { sentAt, answer, answeredAt, ping, missedAt, rulesAt, rulesBusy, requireAccount }
    this.state = new Map();
    this.boardFilters = new Set(); // modules' fn(address) -> true: not on the board
    this.boardNotes = new Set(); // modules' fn(address) -> an object of fields for the server's board entry, or null
    this.socket = null;
    this.timer = null;
  }

  // Whether a module's filter keeps the server at this address off the board. A filter that
  // throws hides nothing.
  hiddenFromBoard(address) {
    for (const fn of this.boardFilters) {
      try {
        if (fn(address)) return true;
      } catch (e) {
        /* that module's own trouble */
      }
    }
    return false;
  }

  // What the modules add to the entry of the server at this address: their objects merged, a module's
  // that throws adding nothing. The poller's own fields always win.
  notesFor(address) {
    let out = {};
    for (const fn of this.boardNotes) {
      try {
        const note = fn(address);
        if (note && typeof note === "object") out = { ...out, ...note };
      } catch (e) {
        /* that module's own trouble */
      }
    }
    return out;
  }

  start() {
    if (this.socket) return;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("error", (e) => { if (this.log) this.log.warn("status.socket", { error: e.message }); });
    this.socket.on("message", (msg, rinfo) => this.onMessage(msg, rinfo));
    this.socket.bind(0);
    this.socket.unref();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref();
    setTimeout(() => this.poll(), 200).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* already closed */ }
    }
    this.socket = null;
  }

  // A query, and when it goes unanswered for timeoutMs, one more; when that goes unanswered too
  // the server is marked missed (offline on the board until it answers again). A challenge's
  // follow-up (extra) rides on the timer of the query it answers.
  send(entry, extra, retry = false) {
    if (!this.socket) return;
    const key = entry.target.key;
    const st = this.state.get(key) || {};
    const at = Date.now();
    st.sentAt = at;
    this.state.set(key, st);
    this.socket.send(extra ? Buffer.concat([A2S_INFO, extra]) : A2S_INFO, entry.target.port, entry.target.ip);
    if (extra) return;
    const timer = setTimeout(() => {
      const now = this.state.get(key);
      if (!now || !this.socket || (now.answeredAt || 0) >= at) return;
      if (!retry) return this.send(entry, null, true);
      now.missedAt = Date.now();
    }, this.timeoutMs);
    timer.unref();
  }

  poll() {
    for (const e of this.servers.entries) this.send(e);
    // the rules half a round later, so a server's per-address query limit is not hit by both
    setTimeout(() => this.pollRules(), Math.min(this.pollMs / 2, 15000)).unref();
  }

  // h9_require_account from each answering server's rules (A2S_RULES), at most every rulesSeconds;
  // a server that does not answer its rules counts as not requiring an account.
  pollRules() {
    const t = Date.now();
    for (const e of this.servers.entries) {
      const st = this.state.get(e.target.key);
      if (!st || !st.answer || st.rulesBusy || this.offline(st, t) || t - (st.rulesAt || 0) < this.rulesMs) continue;
      st.rulesBusy = true;
      Promise.resolve()
        .then(() => this.queryRules(e.target.ip, e.target.port, { timeoutMs: this.timeoutMs, retries: 0 }))
        .then((rules) => {
          st.requireAccount = !!rules && String(rules.get("h9_require_account") || "").trim() === "1";
        }, () => {
          st.requireAccount = false;
        })
        .finally(() => {
          st.rulesAt = Date.now();
          st.rulesBusy = false;
        });
    }
  }

  onMessage(msg, rinfo) {
    const key = rinfo.address + ":" + rinfo.port;
    const entry = this.servers.byTarget.get(key);
    if (!entry) return;
    const answer = parseInfoReply(msg);
    if (!answer) return;
    if (answer.challenge) return this.send(entry, answer.challenge);
    const st = this.state.get(key) || {};
    st.answer = answer;
    st.answeredAt = Date.now();
    st.ping = st.sentAt ? Math.max(0, st.answeredAt - st.sentAt) : null;
    this.state.set(key, st);
  }

  // Whether a server has stopped answering: its last query and the retry went unanswered, or it
  // has been silent for two rounds of queries (a poller that could not send at all).
  offline(st, t = Date.now()) {
    return (st.missedAt || 0) > (st.answeredAt || 0) || t - (st.answeredAt || 0) > 2 * this.pollMs + 2 * this.timeoutMs;
  }

  // The servers that answered lately, in the shape servers/index.html reads. A server that answers
  // is named as it names itself (its hostname), and servers.json's name stands in only for one
  // that does not. One that stopped answering stays on the board as online: false (players and
  // ping gone) for expireSeconds after its last answer, then leaves it; it is back with its next
  // answer.
  snapshot() {
    const t = Date.now();
    const servers = [];
    for (const e of this.servers.entries) {
      if (!e.listed || this.hiddenFromBoard(e.address.key)) continue;
      const st = this.state.get(e.target.key);
      if (!st || !st.answer || t - st.answeredAt > this.expireMs) continue;
      const a = st.answer;
      if (this.offline(st, t)) {
        servers.push({
          ...this.notesFor(e.address.key),
          address: e.address.key, kind: a.kind, name: e.name || a.name || e.address.key, map: a.map, mode: a.mode,
          players: 0, max: a.max, bots: 0, ping_ms: null, online: false, requireAccount: !!st.requireAccount,
        });
        continue;
      }
      servers.push({
        ...this.notesFor(e.address.key),
        address: e.address.key, kind: a.kind, name: a.name || e.name || e.address.key, map: a.map, mode: a.mode,
        players: a.players, max: a.max, bots: a.bots, ping_ms: st.ping, online: true, requireAccount: !!st.requireAccount,
      });
    }
    return { gamedir: this.gamedir, generated: new Date(t).toISOString().replace(/\.\d+Z$/, "Z"), servers };
  }
}
