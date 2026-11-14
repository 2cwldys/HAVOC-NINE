// h9p2p file mode: the host helper driven by the AMX Mod X plugin h9_p2p.amxx through three files in the game's data folder.
//
//   h9_p2p_state.txt  written by the plugin, whole, every 10 s while h9_p2p is 1: key=value lines, the last one end=1.
//                     v enabled stopping public direct relay direct_public require_account service ttl uses name map players
//                     maxplayers password time end. The helper reads it every second and ignores a file that does not end in end=1.
//   h9_p2p_cmd.txt    appended by the plugin: "<unix time> <number> <command>", the command being
//                     invite <label> [direct] [account] | kick <n> | revoke <invite> | close | public <0|1> | quit.
//                     The helper reads from where it stopped, drops a line older than 30 s, and empties the file when it has read it all.
//   h9_p2p_out.txt    appended by the helper: "<unix time> <type> [re=<number>] <fields>" with the types
//                       status      <text>                     (the first word of the text names it: beat, opened, closed, public ...)
//                       invite      <code> <label> id=<id> ttl=<s> uses=<n> exp=<unix> [snap]
//                       invite-end  <id> <used|revoked|expired|closed>
//                       joiner      <n> <label> <account|-> <invite id|-> <relay|direct> [public] [snap]
//                       left        <n> <reason>
//                       error       <text>
//                     re=<number> is the number of the command the line answers; snap marks a line that repeats what is already known
//                     (written again after the file is emptied when it grows past 32 KB). The helper empties the file when it starts.
//
// The helper keeps ONE session open at the service while the state says enabled=1 and is fresh (60 s; 180 s when the plugin said
// stopping=1, because a map change also ends the plugin for a while). It closes the session when enabled goes to 0, when the state
// goes stale, and on a close command (which leaves it closed until the next invite, or until h9_p2p goes 0 and 1 again). While
// public=1 it posts the listing every 15 s. It never reads a secret from the files: the host token comes from its own options.
//
// Nothing here prints a code, a key or the token to the console; the plugin shows the invite codes.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { HostHelper } from "./helper.js";
import { normaliseCode, formatCode } from "./codes.js";

export const FILES = Object.freeze({ state: "h9_p2p_state.txt", cmd: "h9_p2p_cmd.txt", out: "h9_p2p_out.txt", pid: "h9_p2p_helper.pid" });

const ROTATE_BYTES = 32 * 1024;
const CMD_TRUNCATE_BYTES = 4096;
const CMD_MAX_AGE_S = 30;

const printable = (s, max) => String(s === undefined || s === null ? "" : s).replace(/[^\x20-\x7e]/g, "?").slice(0, max);
// one word: what a file line cannot be confused by (the plugin splits on blanks)
const word = (s, max, fallback) => {
  const w = printable(s, max).trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.@:+-]/g, "?");
  return w || fallback;
};

// ---- the state file ----------------------------------------------------------------------------------------------------------

// Text of the state file -> the settings, or null when it is not a complete state (a write in progress, or another file).
export function parseState(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines[lines.length - 1] !== "end=1") return null;
  const kv = Object.create(null);
  for (const l of lines) {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1);
  }
  if (!/^\d+$/.test(kv.v || "")) return null;
  const num = (k, d, lo, hi) => {
    const n = Number(kv[k]);
    return kv[k] !== undefined && kv[k] !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d;
  };
  const flag = (k, d) => (kv[k] === undefined ? d : kv[k] === "1");
  return {
    v: num("v", 1, 0, 999),
    enabled: flag("enabled", false),
    stopping: flag("stopping", false),
    public: flag("public", false),
    direct: flag("direct", true),
    relay: flag("relay", true),
    directPublic: flag("direct_public", false),
    requireAccount: flag("require_account", false),
    service: printable(kv.service, 200).trim(),
    ttl: num("ttl", 600, 10, 900),
    uses: num("uses", 1, 1, 8),
    name: printable(kv.name, 64).trim(),
    map: printable(kv.map, 32).replace(/[^A-Za-z0-9_.+-]/g, ""),
    players: num("players", 0, 0, 128),
    max: num("maxplayers", 0, 0, 128),
    password: flag("password", false),
    time: num("time", 0, 0, 4e9),
  };
}

// One line of the command file -> { t, seq, verb, args } or null.
export function parseCommand(line) {
  const parts = String(line).trim().split(/\s+/);
  if (parts.length < 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  return { t: Number(parts[0]), seq: Number(parts[1]), verb: parts[2].toLowerCase(), args: parts.slice(3).map((a) => printable(a, 64)) };
}

// ---- the controller ----------------------------------------------------------------------------------------------------------

export class HostIpc extends EventEmitter {
  // opts: dir (the data folder), service ("" = the state's), token, game { host, port }, bindAddress, allowPrivatePeers,
  //       staleMs (60 s), stoppingMs (180 s), idleExitMs (0 = never), tickMs, log (a function taking one line of text), makeHost (tests)
  constructor(opts) {
    super();
    this.o = {
      service: "", token: "", game: { host: "127.0.0.1", port: 27015 }, bindAddress: "0.0.0.0", allowPrivatePeers: false,
      staleMs: 60000, stoppingMs: 180000, idleExitMs: 0, tickMs: 250, stateEveryMs: 1000, listingEveryMs: 15000, beatEveryMs: 30000, log: () => {},
      makeHost: (o) => new HostHelper(o), ...opts,
    };
    const d = this.o.dir;
    this.paths = { state: path.join(d, FILES.state), cmd: path.join(d, FILES.cmd), out: path.join(d, FILES.out), pid: path.join(d, FILES.pid) };
    this.state = null; // the last complete state read
    this.lastStateRead = 0;
    this.lastFresh = Date.now();
    this.host = null; // the HostHelper of the open session
    this.opening = null;
    this.closedByHost = false;
    this.nextOpenAt = 0;
    this.openFailures = 0;
    this.lastOpenError = "";
    this.joiners = new Map(); // n -> { n, flow, label, account, invite, path, public }
    this.byFlow = new Map();
    this.invites = new Map(); // id -> { id, code, label, exp (unix s), usesLeft, ttl }
    this.nextN = 1;
    this.cmdOff = 0;
    this.chain = Promise.resolve();
    this.pub = { listed: false, disabled: false, busy: false, nextAt: 0, error: "", failing: false };
    this.lastBeat = 0;
    this.lastPid = 0;
    this.noted = new Map(); // text -> time: a message is said again only after a minute
    this.waitingWhy = "";
    this.stopped = false;
    this.timer = null;
    this.lastEnabled = null;
  }

  // ---- output ------------------------------------------------------------------------------------------------------------------

  unix() {
    return Math.floor(Date.now() / 1000);
  }

  // one line of the journal for the plugin; text is already free of secrets
  emitLine(type, text, re) {
    let line = this.unix() + " " + type + " " + (re ? "re=" + re + " " : "") + printable(text, 200);
    line = line.trimEnd();
    try {
      fs.appendFileSync(this.paths.out, line + "\n");
    } catch (e) {
      this.say("cannot write " + this.paths.out + ": " + e.code);
    }
  }

  say(text) {
    try { this.o.log(text); } catch (e) { /* a logger that throws must not stop the helper */ }
  }

  // an error the host should read once a minute at most, however often it happens
  note(type, text, re) {
    const key = type + "|" + text;
    const t = Date.now();
    if (!re && this.noted.has(key) && t - this.noted.get(key) < 60000) return;
    this.noted.set(key, t);
    this.emitLine(type, text, re);
    this.say(text);
  }

  // ---- life ---------------------------------------------------------------------------------------------------------------------

  // Throws { code: "running", pid } when another helper of this folder is up (its pid file is fresh).
  start() {
    fs.mkdirSync(this.o.dir, { recursive: true });
    const other = this.runningPid();
    if (other) throw Object.assign(new Error("a helper is already running for this folder (pid " + other + ")"), { code: "running", pid: other });
    fs.writeFileSync(this.paths.out, "");
    try { this.cmdOff = fs.statSync(this.paths.cmd).size; } catch (e) { this.cmdOff = 0; }
    this.writePid();
    this.emitLine("status", "started pid=" + process.pid + " v=1");
    this.say("helper started; waiting for the game's state file in " + this.o.dir);
    this.timer = setInterval(() => this.tick(), this.o.tickMs);
    return this;
  }

  runningPid() {
    try {
      const t = fs.readFileSync(this.paths.pid, "latin1");
      const pid = Number((/pid=(\d+)/.exec(t) || [])[1]);
      const at = Number((/time=(\d+)/.exec(t) || [])[1]);
      if (pid && pid !== process.pid && this.unix() - at < 20) return pid;
    } catch (e) { /* no pid file */ }
    return 0;
  }

  writePid() {
    this.lastPid = Date.now();
    try { fs.writeFileSync(this.paths.pid, "pid=" + process.pid + "\ntime=" + this.unix() + "\n"); } catch (e) { /* the folder is gone: the next write tells */ }
  }

  async stop(reason = "stopped") {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.closeSession(reason);
    this.emitLine("status", "stopped " + reason);
    try {
      const t = fs.readFileSync(this.paths.pid, "latin1");
      if (new RegExp("pid=" + process.pid + "\\b").test(t)) fs.unlinkSync(this.paths.pid);
    } catch (e) { /* already gone */ }
    this.emit("stopped", reason);
  }

  // ---- the loop ---------------------------------------------------------------------------------------------------------------

  tick() {
    if (this.stopped) return;
    const t = Date.now();
    this.readCommands();
    if (t - this.lastStateRead >= this.o.stateEveryMs) {
      this.lastStateRead = t;
      this.readState();
    }
    this.reconcile();
    this.sweep(t);
    this.listingTick(t);
    if (t - this.lastBeat >= this.o.beatEveryMs) this.beat(t);
    if (t - this.lastPid >= 5000) this.writePid();
  }

  readState() {
    let text;
    try {
      text = fs.readFileSync(this.paths.state, "latin1");
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES") return; // not there, or being written
      this.note("error", "cannot read the game's state file: " + e.code);
      return;
    }
    const st = parseState(text);
    if (!st) return; // a write in progress: the next look has it
    if (st.v > 1) this.note("error", "the state file is version " + st.v + " and this helper reads version 1: update the helper");
    this.state = st;
  }

  // enabled, fresh, and not closed by the host
  freshness() {
    const st = this.state;
    if (!st) return { fresh: false, why: "no state file from the game yet" };
    const age = this.unix() - st.time;
    const limit = (st.stopping ? this.o.stoppingMs : this.o.staleMs) / 1000;
    if (age >= limit || age < -30) return { fresh: false, why: st.stopping ? "the game stopped and did not come back (" + age + " s)" : "the game's state file is stale (" + age + " s)" };
    return { fresh: true, why: "" };
  }

  reconcile() {
    const st = this.state;
    const { fresh, why } = this.freshness();
    if (fresh) this.lastFresh = Date.now();
    const enabled = !!(st && st.enabled);
    if (this.lastEnabled !== enabled) {
      if (enabled) this.closedByHost = false; // h9_p2p went 0 then 1: a closed path opens again
      this.lastEnabled = enabled;
    }
    const want = enabled && fresh && !this.closedByHost;
    if (!want) {
      const reason = !st ? "waiting for the game" : !enabled ? "h9_p2p is 0" : !fresh ? why : "closed by h9_p2p_close";
      if (this.host) {
        this.closeSession(reason).catch(() => {});
      } else if (!this.closedByHost && this.waitingWhy !== reason) {
        this.waitingWhy = reason;
        this.emitLine("status", "waiting " + reason);
        this.say("waiting: " + reason);
      }
      if (!fresh && this.o.idleExitMs > 0 && Date.now() - this.lastFresh > this.o.idleExitMs) {
        this.stop("the game has been gone for " + Math.round(this.o.idleExitMs / 60000) + " min").catch(() => {});
      }
      return;
    }
    this.waitingWhy = "";
    if (!this.host && !this.opening && Date.now() >= this.nextOpenAt) this.ensureSession().catch(() => {});
  }

  sweep(t) {
    const now = Math.floor(t / 1000);
    for (const inv of [...this.invites.values()]) {
      if (inv.exp > 0 && inv.exp <= now) {
        this.invites.delete(inv.id);
        this.emitLine("invite-end", inv.id + " expired");
      }
    }
    try {
      if (fs.statSync(this.paths.out).size > ROTATE_BYTES) this.rotate();
    } catch (e) { /* no file yet */ }
  }

  // the journal is emptied; what is still true is written again, marked snap, so a plugin that starts later knows it
  rotate() {
    try { fs.writeFileSync(this.paths.out, ""); } catch (e) { return; }
    this.emitLine("status", "rotated");
    for (const inv of this.invites.values()) this.writeInvite(inv, 0, true);
    for (const j of this.joiners.values()) this.writeJoiner(j, true);
  }

  beat(t) {
    this.lastBeat = t;
    const pub = !this.host ? "off" : this.pub.disabled ? "refused" : this.pub.listed ? "listed" : this.state && this.state.public ? "pending" : "off";
    this.emitLine("status", "beat " + (this.host ? "open" : "closed") + " invites=" + this.invites.size + " joiners=" + this.joiners.size + " public=" + pub);
  }

  // ---- the session ---------------------------------------------------------------------------------------------------------------

  // Resolves with the open HostHelper, or null (the reason is in lastOpenError).
  async ensureSession(waitMs = 0) {
    if (this.host) return this.host;
    const stateOk = this.state && this.state.enabled && this.freshness().fresh;
    if (!stateOk) { this.lastOpenError = "the game's path is not enabled (h9_p2p 1)"; return null; }
    if (!this.opening) {
      this.opening = this.openSession().finally(() => { this.opening = null; });
    }
    if (waitMs > 0) {
      await Promise.race([this.opening.catch(() => {}), new Promise((r) => setTimeout(r, waitMs))]);
    }
    return this.host;
  }

  async openSession() {
    const st = this.state;
    const service = this.o.service || (st && st.service) || "";
    if (!service) {
      this.lastOpenError = "no relay address: set service= in p2p.ini (or h9_p2p_service in the game)";
      this.note("error", this.lastOpenError);
      this.nextOpenAt = Date.now() + 15000;
      return;
    }
    if (!this.o.token) {
      this.lastOpenError = "no host token: set token= in p2p.ini";
      this.note("error", this.lastOpenError);
      this.nextOpenAt = Date.now() + 15000;
      return;
    }
    const h = this.o.makeHost({
      service, token: this.o.token, game: this.o.game, name: st.name, direct: st.direct, relay: st.relay,
      allowPrivatePeers: this.o.allowPrivatePeers, bindAddress: this.o.bindAddress,
    });
    h.on("error", (e) => this.note("error", "socket: " + printable(e && e.message, 80)));
    h.on("joiner", (j) => this.onJoiner(h, j));
    h.on("path", (p) => this.onPath(h, p));
    h.on("gone", (g) => this.onGone(h, g));
    h.on("session-lost", (g) => this.onSessionLost(h, g && g.reason));
    try {
      await h.open();
    } catch (e) {
      if (h.session) { try { await h.close(); } catch (e2) { /* the service times the session out */ } }
      this.openFailures++;
      let backoff = Math.min(60000, 5000 * 2 ** Math.min(this.openFailures - 1, 4));
      let why;
      if (e.status === 401) why = "the relay refused the host token (401): check token= in p2p.ini";
      else if (e.status === 403) why = "the relay does not let this token open a path (403)";
      else if (e.status === 429) { why = "the relay says slow down (429)"; backoff = Math.max(backoff, (e.retryAfter || 30) * 1000); }
      else if (e.status) why = "the relay answered " + e.status;
      else why = "cannot reach the relay: " + printable(e.code || e.message, 60);
      this.lastOpenError = why;
      this.note("error", why);
      this.nextOpenAt = Date.now() + backoff;
      return;
    }
    this.openFailures = 0;
    this.host = h;
    this.pub = { listed: false, disabled: false, busy: false, nextAt: 0, error: "", failing: false };
    this.emitLine("status", "opened session=" + printable(h.session, 6) + " direct=" + (h.direct ? 1 : 0) + " relay=" + (h.relay ? 1 : 0));
    this.say("the path is open (" + (h.relay ? "relay" : "no relay") + (h.direct ? ", direct allowed" : ", relay only") + ")");
    this.emit("opened", h);
  }

  async closeSession(reason) {
    const h = this.host;
    if (!h) return;
    this.host = null;
    if (this.pub.listed) { try { await this.postListing(h, { public: false }); } catch (e) { /* best effort */ } }
    for (const j of this.joiners.values()) this.emitLine("left", j.n + " " + word(reason, 40, "closed"));
    this.joiners.clear();
    this.byFlow.clear();
    for (const inv of this.invites.values()) this.emitLine("invite-end", inv.id + " closed");
    this.invites.clear();
    this.pub = { listed: false, disabled: false, busy: false, nextAt: 0, error: "", failing: false };
    try { await h.close(); } catch (e) { /* the service times the session out */ }
    this.emitLine("status", "closed " + printable(reason, 80));
    this.say("the path is closed: " + reason);
    this.emit("closed", reason);
  }

  onSessionLost(h, reason) {
    if (h !== this.host) return;
    this.host = null;
    for (const j of this.joiners.values()) this.emitLine("left", j.n + " session_lost");
    this.joiners.clear();
    this.byFlow.clear();
    for (const inv of this.invites.values()) this.emitLine("invite-end", inv.id + " closed");
    this.invites.clear();
    this.pub = { listed: false, disabled: false, busy: false, nextAt: 0, error: "", failing: false };
    h.close().catch(() => {});
    this.nextOpenAt = Date.now() + 2000;
    this.note("error", "the relay forgot this path" + (reason ? " (" + printable(reason, 40) + ")" : "") + ": opening it again; invites made before are gone");
  }

  // ---- friends -------------------------------------------------------------------------------------------------------------------

  onJoiner(h, j) {
    if (h !== this.host) return;
    const n = this.nextN++;
    const rec = {
      n, flow: j.flow, label: word(j.public ? "public" : j.label, 24, "friend"), account: j.account && j.account.name ? word(j.account.name, 32, "?") : "-",
      invite: j.invite ? word(j.invite, 16, "-") : "-", path: "relay", public: !!j.public,
    };
    this.joiners.set(n, rec);
    this.byFlow.set(j.flow, n);
    const inv = j.invite ? this.invites.get(j.invite) : null;
    if (inv && !j.public) {
      inv.usesLeft--;
      if (inv.usesLeft <= 0) {
        this.invites.delete(inv.id);
        this.emitLine("invite-end", inv.id + " used");
      }
    }
    this.writeJoiner(rec, false);
    this.say(rec.label + " joined" + (rec.account !== "-" ? " (account " + rec.account + ")" : "") + ", number " + n);
  }

  onPath(h, p) {
    if (h !== this.host) return;
    const n = this.byFlow.get(p.flow);
    const rec = n && this.joiners.get(n);
    if (!rec || rec.path === p.path) return;
    rec.path = p.path;
    this.writeJoiner(rec, false);
    this.say(rec.label + " is now " + (p.path === "direct" ? "direct" : "through the relay"));
  }

  onGone(h, g) {
    if (h !== this.host) return;
    const n = this.byFlow.get(g.flow);
    if (!n) return;
    const rec = this.joiners.get(n);
    this.byFlow.delete(g.flow);
    this.joiners.delete(n);
    this.emitLine("left", n + " " + word(g.reason, 40, "gone"));
    if (rec) this.say(rec.label + " left (" + printable(g.reason, 40) + ")");
  }

  writeJoiner(j, snap) {
    this.emitLine("joiner", [j.n, j.label, j.account, j.invite, j.path].join(" ") + (j.public ? " public" : "") + (snap ? " snap" : ""));
  }

  writeInvite(inv, re, snap) {
    this.emitLine("invite", [inv.code, inv.label, "id=" + inv.id, "ttl=" + inv.ttl, "uses=" + inv.usesLeft, "exp=" + inv.exp].join(" ") + (snap ? " snap" : ""), re);
  }

  // ---- the listing -----------------------------------------------------------------------------------------------------------------

  listingBody(st) {
    return {
      public: true, name: st.name || "game", map: st.map, players: st.players, max: st.max, password: st.password,
      requireAccount: st.requireAccount, directPublic: !!(st.directPublic && st.direct),
    };
  }

  postListing(h, body) {
    return h.listing(body);
  }

  listingTick(t) {
    const h = this.host;
    if (!h || this.pub.busy) return;
    const st = this.state;
    const wantPublic = !!(st && st.enabled && st.public) && !this.closedByHost;
    if (!wantPublic) {
      if (this.pub.listed) {
        this.pub.busy = true;
        this.pub.listed = false;
        this.postListing(h, { public: false }).catch(() => {}).finally(() => {
          this.pub.busy = false;
          this.emitLine("status", "public off");
        });
      }
      this.pub.disabled = false;
      this.pub.error = "";
      this.pub.nextAt = 0;
      return;
    }
    if (this.pub.disabled || t < this.pub.nextAt) return;
    this.pub.busy = true;
    this.postListing(h, this.listingBody(st)).then((r) => this.onListingAnswer(h, r), (e) => this.onListingFailure(h, e)).finally(() => { this.pub.busy = false; });
  }

  onListingAnswer(h, r) {
    if (h !== this.host) return;
    const t = Date.now();
    this.pub.failing = false;
    if (r.status === 200 && r.json && r.json.ok) {
      this.pub.nextAt = t + this.o.listingEveryMs;
      if (!this.pub.listed) {
        this.pub.listed = true;
        this.pub.error = "";
        this.emitLine("status", "public listed " + word(r.json.id, 24, "-"));
        this.say("the game is on the relay's public list");
      }
      return;
    }
    const why = r.json && r.json.error ? printable(r.json.error, 60) : "";
    if (r.status === 401) {
      this.onSessionLost(h, "listing: unauthorized");
    } else if (r.status === 403 || r.status === 404) {
      this.pub.disabled = true;
      this.note("error", "the relay does not list games (" + r.status + (why ? ": " + why : "") + "): the game stays unlisted until the path opens again");
    } else if (r.status === 429) {
      this.pub.nextAt = t + Math.max(15, r.retryAfter || 15) * 1000;
    } else {
      this.pub.nextAt = t + 60000;
      this.note("error", "the relay refused the public listing (" + r.status + (why ? ": " + why : "") + ")");
    }
  }

  onListingFailure(h, e) {
    if (h !== this.host) return;
    this.pub.nextAt = Date.now() + this.o.listingEveryMs;
    if (!this.pub.failing) {
      this.pub.failing = true;
      this.note("error", "the public listing could not be posted: " + printable(e && (e.code || e.message), 60));
    }
  }

  // ---- commands -------------------------------------------------------------------------------------------------------------------

  readCommands() {
    let size;
    try { size = fs.statSync(this.paths.cmd).size; } catch (e) { return; }
    if (size < this.cmdOff) this.cmdOff = 0;
    if (size === this.cmdOff) return;
    let buf;
    try {
      const fd = fs.openSync(this.paths.cmd, "r");
      try {
        buf = Buffer.alloc(size - this.cmdOff);
        fs.readSync(fd, buf, 0, buf.length, this.cmdOff);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) { return; }
    const text = buf.toString("latin1");
    const cut = text.lastIndexOf("\n");
    if (cut < 0) return; // a line the plugin is still writing
    this.cmdOff += cut + 1;
    for (const raw of text.slice(0, cut).split("\n")) {
      if (!raw.trim()) continue;
      const c = parseCommand(raw);
      if (!c) { this.note("error", "a line of the command file is not a command"); continue; }
      if (this.unix() - c.t > CMD_MAX_AGE_S) { this.emitLine("error", "dropped a stale '" + printable(c.verb, 12) + "' command", c.seq); continue; }
      this.chain = this.chain.then(() => this.runCommand(c)).catch((e) => this.emitLine("error", "'" + printable(c.verb, 12) + "' failed: " + printable(e && e.message, 80), c.seq));
    }
    if (this.cmdOff >= CMD_TRUNCATE_BYTES) {
      try {
        if (fs.statSync(this.paths.cmd).size === this.cmdOff) { fs.writeFileSync(this.paths.cmd, ""); this.cmdOff = 0; }
      } catch (e) { /* the plugin has it open: the next look tries again */ }
    }
  }

  findInvite(key) {
    if (this.invites.has(key)) return this.invites.get(key);
    const code = normaliseCode(key);
    if (code) for (const inv of this.invites.values()) if (normaliseCode(inv.code) === code) return inv;
    return null;
  }

  async runCommand(c) {
    switch (c.verb) {
      case "invite": return this.cmdInvite(c);
      case "kick": return this.cmdKick(c);
      case "revoke": return this.cmdRevoke(c);
      case "close": return this.cmdClose(c);
      case "public": return this.cmdPublic(c);
      case "quit": this.emitLine("status", "quit asked", c.seq); return this.stop("stopped on request");
      default: return this.emitLine("error", "unknown command '" + printable(c.verb, 12) + "'", c.seq);
    }
  }

  async cmdInvite(c) {
    const label = word(c.args[0], 24, "friend");
    const flags = new Set(c.args.slice(1).map((a) => a.toLowerCase()));
    this.closedByHost = false;
    const h = await this.ensureSession(20000);
    if (!h) return this.emitLine("error", "no invite: " + (this.lastOpenError || "the path is not open yet"), c.seq);
    const st = this.state;
    const direct = flags.has("direct") && !!st.direct && !!h.direct;
    let inv;
    try {
      inv = await h.invite({ ttl: st.ttl, uses: st.uses, label, requireAccount: flags.has("account") || st.requireAccount, direct });
    } catch (e) {
      const why = e.status === 429 ? "the relay says slow down" + (e.retryAfter ? " (" + e.retryAfter + " s)" : "") : e.status === 401 ? "the relay forgot this path" : e.message;
      return this.emitLine("error", "no invite: " + printable(why, 100), c.seq);
    }
    const rec = {
      id: word(inv.id, 16, "?"), code: formatCode(normaliseCode(inv.code) || "0000000000"), label,
      exp: this.unix() + (Number(inv.ttl) || st.ttl), usesLeft: Number(inv.uses) || 1, ttl: Number(inv.ttl) || st.ttl,
    };
    this.invites.set(rec.id, rec);
    this.writeInvite(rec, c.seq, false);
    this.say("invite for " + label + " made (id " + rec.id + "): the game's console has the code");
  }

  async cmdKick(c) {
    const n = Number(c.args[0]);
    const rec = this.joiners.get(n);
    if (!rec || !this.host) return this.emitLine("error", "no friend has the number " + printable(c.args[0], 8), c.seq);
    await this.host.kick(rec.flow);
    this.emitLine("status", "kicked " + n, c.seq);
  }

  async cmdRevoke(c) {
    const key = c.args[0] || "";
    const inv = this.findInvite(key);
    if (!this.host) return this.emitLine("error", "there is no open path to revoke on", c.seq);
    const id = inv ? inv.id : key;
    const r = await this.host.revoke({ invite: id });
    if (inv) {
      this.invites.delete(inv.id);
      this.emitLine("invite-end", inv.id + " revoked");
    }
    if (inv || (r && r.revoked > 0)) this.emitLine("status", "revoked " + word(id, 16, "?"), c.seq);
    else this.emitLine("error", "no such invite", c.seq);
  }

  async cmdClose(c) {
    await this.closeSession("h9_p2p_close");
    this.closedByHost = true;
    this.waitingWhy = "closed by h9_p2p_close";
    this.emitLine("status", "closed by h9_p2p_close: every friend and every invite is gone; h9_p2p_invite opens the path again", c.seq);
  }

  async cmdPublic(c) {
    const on = c.args[0] === "1";
    if (this.state) this.state.public = on;
    if (on) { this.pub.nextAt = 0; this.pub.disabled = false; }
    this.emitLine("status", "public listing " + (on ? "on" : "off"), c.seq);
  }
}
