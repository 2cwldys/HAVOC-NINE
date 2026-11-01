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
// answers for /api/servers, in the JSON shape servers/index.html reads.

import fs from "node:fs";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";

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
  constructor({ servers, log = null, pollSeconds = 30, timeoutMs = 1500, expireSeconds = 120, gamedir = "ts" }) {
    this.servers = servers;
    this.log = log;
    this.pollMs = pollSeconds * 1000;
    this.timeoutMs = timeoutMs;
    this.expireMs = expireSeconds * 1000;
    this.gamedir = gamedir;
    this.state = new Map(); // target key -> { sentAt, answer, answeredAt, ping }
    this.socket = null;
    this.timer = null;
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

  send(entry, extra) {
    if (!this.socket) return;
    const st = this.state.get(entry.target.key) || {};
    st.sentAt = Date.now();
    this.state.set(entry.target.key, st);
    this.socket.send(extra ? Buffer.concat([A2S_INFO, extra]) : A2S_INFO, entry.target.port, entry.target.ip);
  }

  poll() {
    for (const e of this.servers.entries) this.send(e);
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

  // The servers that answered lately, in the shape servers/index.html reads.
  snapshot() {
    const t = Date.now();
    const servers = [];
    for (const e of this.servers.entries) {
      if (!e.listed) continue;
      const st = this.state.get(e.target.key);
      if (!st || !st.answer || t - st.answeredAt > this.expireMs) continue;
      const a = st.answer;
      servers.push({
        address: e.address.key, kind: a.kind, name: e.name || a.name || e.address.key, map: a.map, mode: a.mode,
        players: a.players, max: a.max, bots: a.bots, ping_ms: st.ping,
      });
    }
    return { gamedir: this.gamedir, generated: new Date(t).toISOString().replace(/\.\d+Z$/, "Z"), servers };
  }
}
