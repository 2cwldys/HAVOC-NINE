// Presence: which havoc9.org accounts are in game on H9's servers now, for how long they have
// played, and the small perks that follow (a "plays in game" badge, playtime, last seen, online
// now). h9web's module registry loads it when config.json lists it ("modules": ["presence"]).
// README.txt beside this file is the guide; docs\H9_PRESENCE.txt covers the game servers, the
// engine's side of the id proof, and what all of it does and does not protect against.
//
// Where presence comes from:
//   * a game server running h9_presence.sma POSTs a signed snapshot of its players to
//     /api/presence/report: each player's h9_clientid, name, join time and time in game, plus the
//     map, the mode and the mode's progress, worked out the way the engine's Discord card works
//     them out. Core's clientIdIndex(server) maps an h9_clientid to the account whose player id
//     gives that value on that server; an id no account gives is dropped on the spot, never
//     stored and never logged, together with its name.
//     A player whose engine answered the plugin's challenge also carries a proof that it holds
//     the raw player id (an HMAC of the plugin's nonce and the server's address) and its device,
//     masked; core's verifyIdProof checks it. Only a proven sighting is verified and counted. An
//     unproven one (an old client, or a copied h9_clientid) shows as unverified and counts for
//     nothing; with requireProof it is dropped.
//   * the web client's relay, which knows the signed-in account behind every relay socket: the
//     events relay-game-start and relay-game-end { accountId, server }. Verified by the session.
//
// Rules on top: the first device that proves an account's id is bound to it, and a proof from
// another device is refused and flagged (an admin may allow it); an account counted on one server
// is held (not shown, not counted) anywhere else at the same time, and flagged; a player missing
// from a report is away, and back within rejoinSeconds the same session goes on (a map change).
//
// The routes:
//   POST /api/presence/report                 game servers only: X-H9-Server, X-H9-Signature
//   GET  /api/presence/now                    who is playing where (accounts that show it)
//   GET  /api/presence/accounts?u=a,b,c       several accounts at once (a forum thread's authors)
//   GET  /api/presence/account/:username      one account's card
//   GET  /api/presence/me                     signed in: everything about your own presence
//   GET  /api/presence/settings               signed in: your privacy switches
//   POST /api/presence/settings               signed in: { game, where, web, site, playtime,
//                                             lastSeen }, any of them, true or false
// Admins (the admin panel's hooks; every change goes into the audit log):
//   GET  /api/presence/admin/flags?status=open|resolved|all&page=N
//   POST /api/presence/admin/flags/:id/resolve                         { note }
//   GET  /api/presence/admin/accounts/:username                        devices, flags, sessions
//   POST /api/presence/admin/accounts/:username/devices/:device/allow  { note }
//   POST /api/presence/admin/accounts/:username/devices/:device/unbind { note }
//   POST /api/presence/admin/accounts/:username/move-id   { to, confirm, password }   (core hooks)
//   POST /api/presence/admin/accounts/:username/reset-id  { confirm, keepDevices, password }   (core hooks)
//   (password: the acting admin's own, checked by core's confirmAdmin)
// An account's state, highest first: in game (the plugin or the relay), in the web client's menu
// (a relay socket open, on no listed server), on the site (a signed-in request lately), offline
// (with when it was last seen). Six switches per account decide what others see: that it is in
// game, which server and map, the web client, the site, its playtime, and last seen. Every public
// read honours them; the account itself always sees all of it (/me), and admins see what an admin
// action needs (the flags, the account view). Servers marked "listed": false in servers.json never
// appear in a public read. A report that asks for names gets, per player slot, the account name a
// verified player plays under, or that a name is an account's (the plugin applies them).
//
// The report's authentication: X-H9-Signature is HMAC-SHA256 over the raw body, keyed with that
// server's own key (keys.js; bin/presence-key.js makes it). The body's ts must be within
// clockSkewSeconds of h9web's clock and later than the last report accepted from that server,
// which refuses a replayed or reordered report, also across restarts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations.js";
import { createStore } from "./store.js";
import { KeyStore, keysPath, addressKey } from "./keys.js";
import { modeFor, keyFromDescription, cleanMap, cleanText } from "./modes.js";
import { createServerAuth } from "./serverauth.js";
import { createEnrollment } from "./enroll.js";
import { createCommunity } from "./community.js";

export { MIGRATIONS };

export const DEFAULTS = Object.freeze({
  // the privacy switches for an account that has not chosen: whether others see that it is in
  // game, on which server and map, in the web client's menu, on the site, its playtime (and the
  // badge), and when it was last seen
  privacy: Object.freeze({ game: true, where: true, web: true, site: true, playtime: true, lastSeen: true }),
  // a signed-in request this recent puts an account "on the site"
  siteActiveSeconds: 300,
  // true: a sighting without a valid proof of the player id is dropped; false: it shows as
  // unverified and counts for nothing (the setting until the engine answers challenges)
  requireProof: false,
  // answer a report that asks for names (h9_presence_names on the game server): a verified account
  // plays under its username, and nobody else under a registered name
  inGameNames: true,
  // the largest report body taken (nginx's location /api/ allows 16k)
  maxBodyBytes: 16384,
  maxPlayers: 128,
  // a report's ts may be this far from h9web's clock, either way
  clockSkewSeconds: 120,
  // a server that has not reported for this long: its players' sessions end
  sessionTimeoutSeconds: 180,
  // a player missing from a report and back within this long goes on with the same session
  rejoinSeconds: 120,
  // the most playtime one gap between two sightings counts (at most sessionTimeoutSeconds)
  maxCreditSeconds: 150,
  // a proof answers a nonce the plugin made; one issued longer ago than this is refused
  proofMaxAgeSeconds: 86400,
  sweepSeconds: 30,
  sessionRetentionDays: 90,
  // the coarse network hashes, and resolved flags, are deleted after this long
  netRetentionDays: 30,
  flagRetentionDays: 90,
  // names in one GET /api/presence/accounts
  batchMax: 50,
  // public reads: kept this long in memory, and sent with Cache-Control max-age
  cacheSeconds: 15,
  // the site's map pictures on disk (the web root's assets/maps), and their URL; a map with no
  // <map>.png there is shown as text
  mapPicturesDir: null,
  mapPicturesUrl: "/assets/maps/",
  // enrollment (enroll.js): the caller's IP must be the address it enrolls; a server not on
  // servers.json goes live without an admin; a live key with no report this long expires; an
  // unproven enrollment is forgotten after this long; the rules are asked at most this often, and
  // waited for this long
  enrollSameIp: true,
  enrollAutoApprove: false,
  enrollStaleDays: 30,
  enrollPendingMinutes: 60,
  enrollProbeSeconds: 10,
  enrollProbeTimeoutMs: 2500,
  // communities (community.js): how long a poll is held open; chat lines' length, the time kept and
  // the wait between two lines of one account; the shared data's limits and how long its history is
  // kept; communities an account may own; how long a server's link code lasts
  pollHoldSeconds: 20,
  chatMaxChars: 120,
  chatRetentionDays: 7,
  chatCooldownSeconds: 2,
  dataValueMax: 512,
  dataKeysPerAccount: 64,
  dataRowsPerCommunity: 200000,
  dataLogRetentionDays: 30,
  communitiesPerAccount: 3,
  claimMinutes: 15,
  limits: Object.freeze({
    reportPerIp: Object.freeze({ max: 120, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    reportPerServer: Object.freeze({ max: 40, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    readPerIp: Object.freeze({ max: 300, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    settingsPerAccount: Object.freeze({ max: 20, windowSeconds: 600, blockSeconds: 300, maxBlockSeconds: 3600 }),
    adminPerAccount: Object.freeze({ max: 120, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    enrollPerIp: Object.freeze({ max: 30, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 21600 }),
    enrollPerAddress: Object.freeze({ max: 10, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 21600 }),
    serverCallsPerIp: Object.freeze({ max: 1200, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    pollPerServer: Object.freeze({ max: 120, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    chatPerServer: Object.freeze({ max: 60, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    chatPerAccount: Object.freeze({ max: 12, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    chatWebPerAccount: Object.freeze({ max: 12, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    findPerServer: Object.freeze({ max: 60, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    dataReadPerServer: Object.freeze({ max: 600, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    dataWritePerServer: Object.freeze({ max: 300, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    dataWritePerAccount: Object.freeze({ max: 60, windowSeconds: 60, blockSeconds: 30, maxBlockSeconds: 300 }),
    claimPerServer: Object.freeze({ max: 10, windowSeconds: 3600, blockSeconds: 600, maxBlockSeconds: 3600 }),
    communityPerAccount: Object.freeze({ max: 120, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
  }),
});

const WHOLE = {
  maxBodyBytes: [1024, 1048576], maxPlayers: [1, 1024], clockSkewSeconds: [5, 3600], sessionTimeoutSeconds: [30, 86400],
  rejoinSeconds: [1, 86400], siteActiveSeconds: [30, 86400], maxCreditSeconds: [1, 86400], proofMaxAgeSeconds: [60, 2592000], sweepSeconds: [1, 3600],
  sessionRetentionDays: [1, 3650], netRetentionDays: [1, 365], flagRetentionDays: [1, 3650], batchMax: [1, 500], cacheSeconds: [0, 3600],
  enrollStaleDays: [1, 3650], enrollPendingMinutes: [1, 10080], enrollProbeSeconds: [1, 3600], enrollProbeTimeoutMs: [100, 30000],
  pollHoldSeconds: [0, 25], chatMaxChars: [10, 160], chatRetentionDays: [1, 365], chatCooldownSeconds: [0, 600],
  dataValueMax: [16, 4096], dataKeysPerAccount: [1, 1024], dataRowsPerCommunity: [100, 10000000], dataLogRetentionDays: [1, 365],
  communitiesPerAccount: [1, 100], claimMinutes: [1, 1440],
};

export function presenceSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw, limits: {}, privacy: { ...DEFAULTS.privacy, ...(raw.privacy || {}) } };
  for (const [k, def] of Object.entries(DEFAULTS.limits)) s.limits[k] = { ...def, ...((raw.limits && raw.limits[k]) || {}) };
  for (const [k] of PRIVACY) {
    if (typeof s.privacy[k] !== "boolean") throw new Error("presence: moduleSettings.presence.privacy." + k + " must be true or false");
  }
  for (const k of Object.keys(s.privacy)) {
    if (!PRIVACY.some(([p]) => p === k)) throw new Error("presence: moduleSettings.presence.privacy has no switch " + k);
  }
  for (const k of ["requireProof", "inGameNames", "enrollSameIp", "enrollAutoApprove"]) {
    if (typeof s[k] !== "boolean") throw new Error("presence: moduleSettings.presence." + k + " must be true or false");
  }
  for (const [k, [lo, hi]] of Object.entries(WHOLE)) {
    if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) throw new Error("presence: moduleSettings.presence." + k + " must be a whole number from " + lo + " to " + hi);
  }
  if (s.maxCreditSeconds > s.sessionTimeoutSeconds) throw new Error("presence: maxCreditSeconds must not be above sessionTimeoutSeconds");
  if (s.mapPicturesDir !== null && (typeof s.mapPicturesDir !== "string" || !path.isAbsolute(s.mapPicturesDir))) {
    throw new Error("presence: moduleSettings.presence.mapPicturesDir must be an absolute path, or null");
  }
  if (typeof s.mapPicturesUrl !== "string" || !/^\/[A-Za-z0-9._~\/-]*\/$/.test(s.mapPicturesUrl)) {
    throw new Error("presence: moduleSettings.presence.mapPicturesUrl must be a path that starts and ends with /");
  }
  for (const [k, l] of Object.entries(s.limits)) {
    for (const f of ["max", "windowSeconds", "blockSeconds", "maxBlockSeconds"]) {
      if (typeof l[f] !== "number" || !(l[f] > 0)) throw new Error("presence: moduleSettings.presence.limits." + k + "." + f + " must be a number above 0");
    }
  }
  return s;
}

// The key the coarse network signal is hashed with: <module data>/net-key, 32 random bytes made on
// the first start (mode 0600). Losing it only means the networks seen before read as new.
export function loadNetKey(dir, log) {
  const file = path.join(dir, "net-key");
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
    if (log) log.warn("presence.net_key_replaced", { file });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

// The privacy switches: [name in the API, column in presence_settings].
const PRIVACY = [["game", "show_game"], ["where", "show_where"], ["web", "show_web"], ["site", "show_site"],
  ["playtime", "show_playtime"], ["lastSeen", "show_last_seen"]];
const CLIENT_ID = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const NET = /^[0-9a-f.:]{1,45}$/;
const PLUGIN = 1;
const RELAY = 2;
const VIA = { 1: "game", 2: "web", 3: "both" };
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null);
const whole = (v) => Number.isSafeInteger(v) && v >= 0;

// A row's state (migrations.js): in game now, verified, and counted.
const active = (r) => r.plugin_at !== null || r.relay === 1;
const verified = (r) => r.proven === 1 || r.relay === 1;
const counts = (r) => active(r) && verified(r) && r.held === 0;

// The module, from what it needs. setup() below gives it ctx's parts; the tests give it the same
// parts, core's hooks included, with a clock of their own and a stand-in for site activity.
//   deps: { db, transaction, router, auth, accounts, servers, events, audit, log, settings,
//           dataDir, http: { HttpError }, limits: { RateLimiter, ipKey }, now }
//   core hooks (README.txt, "Core hooks"):
//     accounts.clientIdIndex(address) -> { get(h9_clientid) -> account id }
//     accounts.verifyIdProof(accountId, { nonce, server, devmask, proof }) -> { valid, device }
//     accounts.resetPlayerId(accountId), accounts.movePlayerId(fromId, toId)
//     auth.confirmAdmin(rc, password): the acting admin's own password, before either of those
//     servers: { get(address), status(address) }
export function createPresence(deps) {
  const { db, router, auth, accounts, events, log } = deps;
  const { HttpError } = deps.http;
  const { RateLimiter, ipKey } = deps.limits;
  const servers = deps.servers && typeof deps.servers.get === "function" ? deps.servers : null;
  const hook = (name) => (typeof accounts[name] === "function" ? accounts[name] : null);
  const clientIdIndex = hook("clientIdIndex");
  const verifyIdProof = hook("verifyIdProof");
  const resetPlayerId = hook("resetPlayerId");
  const movePlayerId = hook("movePlayerId");
  const nameInUse = hook("nameInUse");
  const lastActive = typeof auth.lastActive === "function" ? auth.lastActive : null;
  const activeSince = typeof auth.activeSince === "function" ? auth.activeSince : null;
  const confirmAdmin = typeof auth.confirmAdmin === "function" ? auth.confirmAdmin : null;
  const audit = deps.audit && typeof deps.audit.record === "function" ? deps.audit : null;
  const s = presenceSettings(deps.settings || {});
  const nowMs = deps.now || Date.now;
  const now = () => Math.floor(nowMs() / 1000);
  const tx = deps.transaction;
  const store = createStore(db);
  const keys = new KeyStore(keysPath(deps.dataDir), { log });
  const serverAuth = createServerAuth({ db, HttpError, settings: s, now });
  let netKey = null;

  const limiters = {};
  for (const [k, v] of Object.entries(s.limits)) limiters[k] = new RateLimiter(v);
  let hits = 0;
  function limit(name, key) {
    if (++hits % 1000 === 0) for (const l of Object.values(limiters)) l.sweep();
    const r = limiters[name].hit(key);
    if (!r.ok) {
      throw new HttpError(429, "rate_limited", "Too many requests. Try again in " + r.retryAfter + " seconds.", {
        headers: { "Retry-After": String(r.retryAfter) },
      });
    }
  }

  // Enrollment (keys without anyone typing them) and communities: their own files, sharing this
  // module's store, limits and signed-call checks.
  const enrollment = createEnrollment({
    db, s, log, router, auth, servers, keys, serverAuth, limit, ipKey, audit, http: deps.http, now, transaction: tx,
    dataDir: deps.dataDir, queryRules: deps.queryRules,
  });
  const community = createCommunity({
    db, s, log, router, auth, accounts, serverAuth, enrollment, limit, ipKey, audit, store, http: deps.http, now, transaction: tx,
    nowView: () => nowView(), publicPlace: (id) => publicPlace(id), serverInfo: (key) => serverInfo(key),
  });

  // A refused report is logged once a minute per server and reason, and never with its body,
  // its signature or anything from it.
  const quiet = new Map();
  function refused(status, code, message, fields) {
    const k = (fields.server || fields.ip || "") + " " + code;
    const t = nowMs();
    if (!quiet.has(k) || t - quiet.get(k) > 60000) {
      if (quiet.size > 1000) quiet.clear();
      quiet.set(k, t);
      log.warn("presence.report_refused", { reason: code, ...fields });
    }
    return new HttpError(status, code, message);
  }

  // ---- the views' caches -------------------------------------------------------------------------

  const views = new Map(); // account id -> { at, card }
  let nowCache = null;
  function changed(accountIds) {
    nowCache = null;
    if (!accountIds) views.clear();
    else for (const id of accountIds) views.delete(id);
  }

  const pictures = new Map(); // map -> { url, at }
  function pictureFor(map) {
    if (!map || !s.mapPicturesDir) return null;
    const t = nowMs();
    const hit = pictures.get(map);
    if (hit && t - hit.at < 300000) return hit.url;
    let url = null;
    try {
      if (fs.statSync(path.join(s.mapPicturesDir, map + ".png")).isFile()) url = s.mapPicturesUrl + map + ".png";
    } catch (e) {
      url = null;
    }
    if (pictures.size > 500) pictures.clear();
    pictures.set(map, { url, at: t });
    return url;
  }

  // A server as the reads show it. Listed: on servers.json with listed true, or enrolled and approved
  // by an admin (enroll.js). Its name: servers.json's, its status answer's, or its own report's.
  function serverView(key) {
    const e = servers ? servers.get(key) : null;
    const st = e && typeof servers.status === "function" ? servers.status(key) : null;
    const en = e ? null : enrollment.enrolled(key);
    const own = e && e.name ? null : store.server(key);
    return { name: (e && e.name) || (st && st.name) || (own && own.name) || key, address: key, listed: e ? e.listed !== false : !!(en && en.approved) };
  }

  // A server's name, map, mode and player counts, for a community's list of servers.
  function serverInfo(key) {
    const t = now();
    const sv = serverView(key);
    const g = gameOn(key, t);
    const row = store.server(key);
    const st = servers && typeof servers.status === "function" ? servers.status(key) : null;
    const fresh = row && t - row.last_report <= s.sessionTimeoutSeconds;
    return {
      name: sv.name, map: g.map, mode: g.mode,
      humans: fresh && row.humans !== null ? row.humans : st ? st.players - (st.bots || 0) : null,
      max: fresh && row.max !== null ? row.max : st ? st.max : null,
    };
  }

  // Where an account is, as anyone may see it (its switches): { state: "game", server, name } on a
  // listed server it shows; { state: "game", server: null } in game where it hides which server;
  // { state } otherwise. For /find in game.
  function publicPlace(accountId) {
    const account = accounts.getById(accountId);
    if (!account) return null;
    const priv = privacyOf(accountId);
    const st = stateFor(account, priv, now());
    if (st.state !== "game") return { state: st.state };
    if (!priv.where) return { state: "game", server: null };
    return { state: "game", server: st.row.server, name: serverView(st.row.server).name };
  }

  // What a server is playing: its last report while it is fresh, else what the status poller
  // last heard from it, named the way the Discord card names it.
  function gameOn(key, t) {
    const row = store.server(key);
    if (row && t - row.last_report <= s.sessionTimeoutSeconds) {
      return { map: row.map, mode: row.mode || (row.map ? modeFor(row.map) : null), detail: row.detail || null };
    }
    const st = servers && typeof servers.status === "function" ? servers.status(key) : null;
    const map = st ? cleanMap(st.map) : null;
    if (map) return { map, mode: modeFor(map, keyFromDescription(st.mode)), detail: null };
    return { map: null, mode: null, detail: null };
  }

  // Which of an account's open rows anyone may see: the counted one on a listed server; failing
  // that, an unverified one on a listed server, but only when the account is verified nowhere
  // (an unverified sighting beside a verified one is most likely a copied id).
  function pick(rows) {
    const live = rows.filter(active);
    const listed = (r) => serverView(r.server).listed;
    const counted = live.find((r) => counts(r) && listed(r));
    if (counted) return { row: counted, verified: true };
    if (live.some(verified)) return null;
    const unverified = live.find(listed);
    return unverified ? { row: unverified, verified: false } : null;
  }

  // ---- privacy and states ------------------------------------------------------------------------

  // An account's privacy switches: its own choices, and moduleSettings.presence.privacy for the rest.
  function privacyOf(accountId) {
    const r = store.settings(accountId);
    const out = {};
    for (const [k, col] of PRIVACY) out[k] = r && (r[col] === 0 || r[col] === 1) ? r[col] === 1 : s.privacy[k];
    return out;
  }
  const EVERYTHING = Object.freeze(Object.fromEntries(PRIVACY.map(([k]) => [k, true])));

  // The web client: the relay sockets open per account (relay-open / relay-close), and when the
  // last one closed. In memory, as the relay's sockets do not outlive the process either.
  const webSockets = new Map(); // account id -> sockets open
  const webClosed = new Map(); // account id -> unix seconds the last one closed

  function siteAt(accountId) {
    const v = lastActive ? lastActive(accountId) : null;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  }

  // Where an account is, as others may see it under its switches, highest first:
  //   game     in game on a listed server (the plugin or the relay); with "where", its server,
  //            map and mode
  //   web      the web client open, on no listed server (its menu)
  //   site     a signed-in request to the site within siteActiveSeconds
  //   offline  with "lastSeen", when it was last seen in any of the kinds above it shows
  // The downloaded game in its own main menu reports to nobody, so it reads as offline.
  // A hidden kind never shows through "last seen": a session still open counts from the one
  // before it, the site only when "site" is shown.
  function stateFor(account, priv, t) {
    const rows = store.onlineOf(account.id);
    if (priv.game) {
      const p = pick(rows);
      if (p) return { state: "game", row: p.row, verified: p.verified };
    }
    const webInGame = rows.some((r) => r.relay === 1 && serverView(r.server).listed);
    if (priv.web && (webSockets.get(account.id) || 0) > 0 && !webInGame) return { state: "web" };
    const site = siteAt(account.id);
    if (priv.site && site !== null && t - site <= s.siteActiveSeconds) return { state: "site" };
    let last = null;
    if (priv.lastSeen) {
      const game = rows.some(active) ? store.lastEnded(account.id) : store.totalsOf(account.id).last_seen;
      last = Math.max(game || 0, webClosed.get(account.id) || 0, priv.site && site ? site : 0) || null;
    }
    return { state: "offline", lastSeen: last };
  }

  // A session in game: since when and how long; with where, also the server, map, mode and picture.
  function playingView(row, t, isVerified, where = true) {
    const out = { since: iso(row.since), minutes: Math.max(0, Math.floor((t - row.since) / 60)), verified: isVerified };
    if (!where) return out;
    const sv = serverView(row.server);
    const g = gameOn(row.server, t);
    return { server: { name: sv.name, address: sv.address }, map: g.map, mode: g.mode, detail: g.detail, mapPicture: pictureFor(g.map), ...out };
  }

  // One account as anyone may see it: the card (GET /api/presence/account/:username); the batch
  // read sends the same without "servers". A field its switches hide is null.
  function cardView(account) {
    const cached = views.get(account.id);
    const tms = nowMs();
    if (cached && tms - cached.at < s.cacheSeconds * 1000) return cached.card;
    const t = now();
    const priv = privacyOf(account.id);
    const st = stateFor(account, priv, t);
    const totals = priv.playtime ? store.totalsOf(account.id) : null;
    const card = {
      username: account.username,
      state: st.state,
      online: st.state === "game",
      playing: st.state === "game" ? playingView(st.row, t, st.verified, priv.where) : null,
      badge: !!(totals && totals.servers > 0),
      playtimeSeconds: totals ? totals.seconds : null,
      firstSeen: totals ? iso(totals.first_seen) : null,
      lastSeen: st.state === "offline" ? iso(st.lastSeen) : null,
      servers: totals && priv.where ? store.playtimeOf(account.id).filter((x) => serverView(x.server).listed).slice(0, 5).map((x) => {
        const sv = serverView(x.server);
        return { server: { name: sv.name, address: sv.address }, seconds: x.seconds };
      }) : [],
    };
    if (views.size > 5000) views.clear();
    views.set(account.id, { at: tms, card });
    return card;
  }

  function compactView(account) {
    const { servers: ignored, ...rest } = cardView(account);
    return rest;
  }

  function stateOf(r) {
    if (!active(r)) return "away";
    if (!verified(r)) return "unverified";
    return r.held ? "held" : "counted";
  }

  function rowView(r, t) {
    return {
      ...playingView(r, t, verified(r)), state: stateOf(r), listed: serverView(r.server).listed, name: r.name,
      seconds: r.seconds, via: VIA[r.seen_by] || null,
    };
  }

  // Everything about an account's own presence, whatever its switches: what /api/presence/me sends.
  function ownView(account) {
    const t = now();
    const totals = store.totalsOf(account.id);
    const st = stateFor(account, EVERYTHING, t);
    return {
      username: account.username,
      state: st.state,
      privacy: privacyOf(account.id),
      defaults: { ...s.privacy },
      badge: totals.servers > 0,
      online: store.onlineOf(account.id).filter(active).map((r) => rowView(r, t)),
      playtimeSeconds: totals.seconds,
      firstSeen: iso(totals.first_seen),
      lastSeen: iso(totals.last_seen),
      devices: store.devicesOf(account.id).length,
      servers: store.playtimeOf(account.id).map((x) => {
        const sv = serverView(x.server);
        return { server: { name: sv.name, address: sv.address }, listed: sv.listed, seconds: x.seconds, firstSeen: iso(x.first_seen), lastSeen: iso(x.last_seen) };
      }),
      sessions: store.sessionsOf(account.id, 10).map((x) => ({
        server: { name: serverView(x.server).name, address: x.server }, started: iso(x.started_at), ended: iso(x.ended_at),
        seconds: x.seconds, name: x.name, via: VIA[x.seen_by] || null,
      })),
    };
  }

  // Who is where, for "who's playing" and "online now": in game by server (or, with "where"
  // hidden, in game somewhere), in the web client's menu, and on the site; each account under its
  // own switches. At most 200 names in each list.
  function nowView() {
    const tms = nowMs();
    if (nowCache && tms - nowCache.at < s.cacheSeconds * 1000) return nowCache.data;
    const t = now();
    const byServer = new Map();
    const elsewhere = [];
    const web = [];
    const site = [];
    let players = 0;
    const seen = new Set();
    function consider(accountId) {
      if (seen.has(accountId)) return;
      seen.add(accountId);
      const account = accounts.getById(accountId);
      if (!account) return;
      const priv = privacyOf(accountId);
      const st = stateFor(account, priv, t);
      if (st.state === "game") {
        players++;
        const who = { username: account.username, since: iso(st.row.since), minutes: Math.max(0, Math.floor((t - st.row.since) / 60)), verified: st.verified };
        if (!priv.where) {
          if (elsewhere.length < 200) elsewhere.push(who);
          return;
        }
        let entry = byServer.get(st.row.server);
        if (!entry) {
          const sv = serverView(st.row.server);
          const g = gameOn(st.row.server, t);
          entry = { server: { name: sv.name, address: sv.address }, map: g.map, mode: g.mode, detail: g.detail, mapPicture: pictureFor(g.map), players: [] };
          byServer.set(st.row.server, entry);
        }
        if (entry.players.length < 200) entry.players.push(who);
      } else if (st.state === "web") {
        if (web.length < 200) web.push({ username: account.username });
      } else if (st.state === "site") {
        if (site.length < 200) site.push({ username: account.username });
      }
    }
    for (const id of store.activeAccounts()) consider(id);
    for (const [id, n] of webSockets) if (n > 0) consider(id);
    if (activeSince) for (const id of activeSince(t - s.siteActiveSeconds) || []) consider(id);
    const bySince = (a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.username.localeCompare(b.username));
    for (const e of byServer.values()) e.players.sort(bySince);
    elsewhere.sort(bySince);
    web.sort((a, b) => a.username.localeCompare(b.username));
    site.sort((a, b) => a.username.localeCompare(b.username));
    const list = [...byServer.values()].sort((a, b) => b.players.length - a.players.length || a.server.name.localeCompare(b.server.name));
    const data = { generated: iso(t), players, servers: list, elsewhere, web, site };
    nowCache = { at: tms, data };
    return data;
  }

  // ---- sessions, playtime, flags -----------------------------------------------------------------

  // Counts the time since the row was last counted, at most maxCreditSeconds, into the session
  // and the account's playtime on that server, when the row counts; last_at moves to t either way,
  // so a row that starts counting later (proven, or no longer held) counts from then.
  function credit(row, t) {
    if (counts(row)) {
      const add = Math.max(0, Math.min(t - row.last_at, s.maxCreditSeconds));
      row.seconds += add;
      row.credited = 1;
      store.addPlaytime(row.account_id, row.server, add, t);
    }
    row.last_at = Math.max(row.last_at, t);
  }

  function countingElsewhere(accountId, server) {
    return store.onlineOf(accountId).some((r) => r.server !== server && counts(r));
  }

  // A new session. From the plugin, since is the player's join time (no more than a day back)
  // and what is counted at once is the time in game the server reports, at most one gap's worth.
  function startRow(accountId, server, t, { plugin = false, relay = false, proven = false, device = null, net = null, joined, time, name = null, slot = null }) {
    let since = t;
    if (plugin && whole(joined) && joined > 0) since = Math.min(t, Math.max(joined, t - 86400));
    const row = {
      account_id: accountId, server, since, last_at: t, plugin_at: plugin ? t : null, away_at: null, relay: relay ? 1 : 0,
      proven: proven ? 1 : 0, held: 0, credited: 0, device, net, seen_by: (plugin ? PLUGIN : 0) | (relay ? RELAY : 0),
      name: name || null, seconds: 0, slot: slot || null,
    };
    if (verified(row) && countingElsewhere(accountId, server)) row.held = 1;
    if (counts(row)) {
      const played = whole(time) ? time : t - since;
      row.seconds = plugin ? Math.max(0, Math.min(t - since, played, s.maxCreditSeconds)) : 0;
      row.credited = 1;
      store.addPlaytime(accountId, server, row.seconds, t);
    }
    store.insertOnline(row);
    log.debug("presence.session_start", { account: accountId, server, via: VIA[row.seen_by], verified: verified(row) });
    return row;
  }

  // A finished session is kept only when it counted time: an unverified or held one leaves no trace.
  function endRow(row, endedAt) {
    if (row.credited) store.insertSession(row, Math.max(row.since, endedAt));
    store.deleteOnline(row.account_id, row.server);
    log.debug("presence.session_end", { account: row.account_id, server: row.server, seconds: row.seconds });
  }

  // One open flag per account, kind and subject; a repeat counts and moves last_at.
  function raise(accountId, kind, about, f, t) {
    const open = store.openFlag(accountId, kind, about);
    const fields = { at: t, server: f.server || null, other_server: f.other || null, net_known: f.netKnown === undefined || f.netKnown === null ? null : f.netKnown ? 1 : 0, detail: f.detail || null };
    if (open) {
      store.bumpFlag(open.id, fields);
      return;
    }
    store.insertFlag({ account_id: accountId, kind, about, device: f.device || null, ...fields });
    log.warn("presence.flag", { kind, account: accountId, server: f.server || undefined });
  }

  function netKnown(accountId, net, t) {
    return net ? store.netKnown(accountId, net, t - s.netRetentionDays * 86400) : null;
  }

  // At most one of an account's verified rows counts: the one counting already, else the earliest.
  // The others are held; a held row whose account counts nowhere any more is promoted and counts
  // from now. Two places at once, or a verified place beside an unverified one, raises a flag.
  function resolve(accountId, t) {
    const live = store.onlineOf(accountId).filter(active);
    const ver = live.filter(verified);
    const keeper = ver.find((r) => r.held === 0) || ver[0] || null;
    for (const r of ver) {
      const held = r === keeper ? 0 : 1;
      if (r.held === held) continue;
      r.held = held;
      if (!held) r.last_at = t;
      store.updateOnline(r);
    }
    if (ver.length > 1) {
      const other = ver.find((r) => r !== keeper);
      raise(accountId, "concurrent", "concurrent", { server: keeper.server, other: other.server, detail: "verified on two servers at once; only the first counts" }, t);
    } else if (keeper) {
      const copy = live.find((r) => !verified(r));
      if (copy) raise(accountId, "concurrent", "concurrent", { server: keeper.server, other: copy.server, detail: "verified on one server, unverified on another (a copied h9_clientid?)" }, t);
    }
  }

  function netHash(prefix) {
    if (!netKey) netKey = loadNetKey(deps.dataDir, log);
    return crypto.createHmac("sha256", netKey).update("net1:" + prefix.toLowerCase()).digest("hex").slice(0, 16);
  }

  // ---- the report --------------------------------------------------------------------------------

  function readRaw(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        req.resume();
        return reject(new HttpError(415, "unsupported_media_type", "Send JSON (Content-Type: application/json)."));
      }
      const length = req.headers["content-length"];
      if (length !== undefined && Number(length) > maxBytes) {
        req.resume();
        return reject(new HttpError(413, "payload_too_large", "The report is too large."));
      }
      const chunks = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > maxBytes) {
          done = true;
          req.resume();
          return reject(new HttpError(413, "payload_too_large", "The report is too large."));
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks));
      });
      req.on("error", () => {
        if (!done) {
          done = true;
          reject(new HttpError(400, "bad_request", "The report could not be read."));
        }
      });
    });
  }

  // The players a report lists, checked; a malformed one refuses the whole report. A report that
  // asks for names may also list players with no h9_clientid ({ slot, name } only): they are
  // there for the name check alone, and are never stored or logged.
  function readPlayers(list, withNames) {
    if (!Array.isArray(list)) throw new HttpError(400, "bad_request", "players must be a list.");
    if (list.length > s.maxPlayers) throw new HttpError(413, "too_many_players", "At most " + s.maxPlayers + " players a report.");
    const out = [];
    for (const p of list) {
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "bad_request", "Each player must be an object.");
      if (p.slot !== undefined && !(Number.isSafeInteger(p.slot) && p.slot >= 1 && p.slot <= 255)) throw new HttpError(400, "bad_request", "slot must be a player slot, 1 to 255.");
      if (p.id === undefined && withNames && p.slot !== undefined) {
        out.push({ id: null, slot: p.slot, name: cleanText(p.name, 64), proof: null, net: null });
        continue;
      }
      const id = typeof p.id === "string" ? p.id.toLowerCase() : "";
      if (!CLIENT_ID.test(id)) throw new HttpError(400, "bad_request", "Each player needs an id of 32 hex characters.");
      if (p.joined !== undefined && !whole(p.joined)) throw new HttpError(400, "bad_request", "joined must be a unix time.");
      if (p.time !== undefined && !whole(p.time)) throw new HttpError(400, "bad_request", "time must be whole seconds.");
      let proof = null;
      if (p.nonce !== undefined || p.devmask !== undefined || p.proof !== undefined) {
        if (!HEX32.test(p.nonce) || !HEX32.test(p.devmask) || !SIGNATURE.test(p.proof)) {
          throw new HttpError(400, "bad_request", "A proof needs nonce and devmask (32 hex) and proof (64 hex).");
        }
        proof = { nonce: p.nonce, devmask: p.devmask, proof: p.proof };
      }
      if (p.net !== undefined && (typeof p.net !== "string" || !NET.test(p.net.toLowerCase()))) throw new HttpError(400, "bad_request", "net must be an address prefix.");
      out.push({ id, slot: p.slot, name: cleanText(p.name, 64), joined: p.joined, time: p.time, proof, net: proof && p.net ? p.net : null });
    }
    return out;
  }

  async function report(req, res, rc) {
    limit("reportPerIp", ipKey(rc.ip));
    if (!clientIdIndex || !servers) throw new HttpError(503, "not_ready", "This h9web has no presence support in its core yet.");
    const raw = await readRaw(req, s.maxBodyBytes);
    const server = addressKey(req.headers["x-h9-server"]);
    if (!server) throw refused(400, "bad_server", "X-H9-Server must be the server's address as servers.json lists it (IPv4:port).", { ip: rc.ip });
    // its key: a hand-made one (presence-key.js), or the one it enrolled with (enroll.js)
    const rk = enrollment.reportKey(server);
    if (!rk.key) {
      if (!servers.get(server) && rk.state !== "not_enrolled") throw refused(403, "unknown_server", "That server is neither on h9web's server list nor enrolled.", { server, ip: rc.ip });
      throw refused(403, rk.state === "not_enrolled" ? "not_enrolled" : "no_key", "That server has no live key: it enrolls first.", { server, ip: rc.ip });
    }
    const signature = String(req.headers["x-h9-signature"] || "").trim().toLowerCase();
    const expected = crypto.createHmac("sha256", rk.key).update(raw).digest();
    const given = SIGNATURE.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw refused(401, "bad_signature", "The report's signature does not match this server's key.", { server, ip: rc.ip });
    }
    if (rk.state === "pending_approval") throw refused(403, "pending_approval", "An H9 admin has not approved this server yet.", { server });
    // authentic from here on: only now does it count against the server's own limit
    limit("reportPerServer", server);

    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      throw new HttpError(400, "bad_request", "The report is not valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "Send a JSON object.");
    if (body.v !== 1) throw new HttpError(400, "bad_version", "This h9web reads report version 1.");
    if (addressKey(body.server) !== server) throw new HttpError(400, "server_mismatch", "The body names another server than X-H9-Server.");
    const t = now();
    if (!whole(body.ts) || Math.abs(t - body.ts) > s.clockSkewSeconds) {
      throw refused(401, "stale", "The report's time is more than " + s.clockSkewSeconds + " seconds from h9web's clock. Check the game server's clock.", { server });
    }
    const last = store.server(server);
    if (last && body.ts <= last.last_ts) throw refused(409, "replay", "A report as new or newer has already been accepted from this server.", { server });
    const withNames = body.names === true;
    const players = readPlayers(body.players, withNames);
    const map = cleanMap(body.map);
    const mode = cleanText(body.mode, 48) || null;
    const detail = cleanText(body.detail, 96) || null;

    // An id listed twice is dropped both times: the server cannot say which is real.
    const count = new Map();
    for (const p of players) if (p.id) count.set(p.id, (count.get(p.id) || 0) + 1);
    const index = clientIdIndex(server);
    const sightings = new Map(); // account id -> { p, proven, device, net }
    const refusals = []; // [account id, kind, about, fields]
    const slots = []; // [{ slot, accountId, device }]: every account here, for its bans, kicks and mutes
    for (const p of players) {
      if (!p.id || count.get(p.id) !== 1) continue;
      const accountId = index.get(p.id);
      // an id no account gives on this server: dropped here, never stored or logged
      if (accountId === undefined || accountId === null) continue;
      if (sightings.has(accountId) || !accounts.getById(accountId)) continue;
      const placed = { slot: p.slot || null, accountId, device: null };
      slots.push(placed);
      if (p.proof && verifyIdProof) {
        const v = verifyIdProof(accountId, { ...p.proof, server });
        if (v && v.valid) placed.device = v.device;
        if (!v || !v.valid) {
          refusals.push([accountId, "bad_proof", server, { server, detail: "the proof does not match the account's player id" }]);
          continue;
        }
        const issued = parseInt(p.proof.nonce.slice(0, 8), 16);
        if (t - issued > s.proofMaxAgeSeconds || issued - t > s.clockSkewSeconds) {
          refusals.push([accountId, "stale_proof", server, { server, detail: "the proof answers a nonce issued " + (t - issued) + " seconds ago" }]);
          continue;
        }
        sightings.set(accountId, { p, proven: true, device: v.device, net: p.net ? netHash(p.net) : null });
      } else {
        if (s.requireProof) continue;
        sightings.set(accountId, { p, proven: false, device: null, net: null });
      }
    }

    const touched = new Set();
    tx(() => {
      store.putServer(server, { map, mode, detail, lastReport: t, lastTs: body.ts });
      store.serverInfo(server, cleanText(body.name, 64) || null, whole(body.humans) ? Math.min(body.humans, 255) : null, whole(body.max) ? Math.min(body.max, 255) : null);
      enrollment.markReport(server, t);
      for (const [accountId, kind, about, f] of refusals) raise(accountId, kind, about, f, t);
      // the first device that proves an account's id is bound to it; any other is refused
      for (const [accountId, sg] of sightings) {
        if (!sg.proven) continue;
        sg.netKnown = netKnown(accountId, sg.net, t);
        if (store.device(accountId, sg.device)) {
          store.touchDevice(accountId, sg.device, t);
        } else if (store.deviceCount(accountId) === 0) {
          store.putDevice(accountId, sg.device, "bound", t);
        } else {
          raise(accountId, "second_device", sg.device, { server, device: sg.device, netKnown: sg.netKnown, detail: "a device that is not this account's proved its player id" }, t);
          sightings.delete(accountId);
          continue;
        }
        if (sg.net) store.touchNet(accountId, sg.net, t);
      }
      const rows = new Map(store.onlineOn(server).map((r) => [r.account_id, r]));
      for (const [accountId, sg] of sightings) {
        const p = sg.p;
        const row = rows.get(accountId);
        if (row) {
          // back from away: the gap is not counted
          if (!active(row)) row.last_at = t;
          else credit(row, t);
          row.plugin_at = t;
          row.away_at = null;
          row.proven = sg.proven ? 1 : 0;
          if (sg.proven) {
            row.device = sg.device;
            if (sg.net) row.net = sg.net;
          }
          row.seen_by |= PLUGIN;
          if (p.name) row.name = p.name;
          if (p.slot) row.slot = p.slot;
          store.updateOnline(row);
        } else {
          startRow(accountId, server, t, { plugin: true, proven: sg.proven, device: sg.device, net: sg.net, joined: p.joined, time: p.time, name: p.name, slot: p.slot });
        }
        touched.add(accountId);
      }
      for (const [accountId, row] of rows) {
        if (sightings.has(accountId) || row.plugin_at === null) continue;
        // not on the server any more, or refused: it left after the last report (or is away)
        credit(row, t);
        row.plugin_at = null;
        row.proven = 0;
        if (!row.relay) row.away_at = t;
        store.updateOnline(row);
        touched.add(accountId);
      }
      for (const accountId of touched) resolve(accountId, t);
    });
    changed(touched);
    log.debug("presence.report", { server, players: players.length, matched: sightings.size });
    const reply = { ok: true, players: players.length, serverId: enrollment.serverIdFor(server), actions: community.reportActions(server, slots) };
    if (withNames && s.inGameNames && verifyIdProof) reply.names = nameDecisions(players, count, index, sightings, server);
    rc.json(200, reply);
  }

  // What each slot of a report that asked for names is to be called, for the plugin to apply on
  // H9's game-mode maps (h9_presence.sma decides which maps):
  //   { set: "<username>" }  the slot is an account, verified: a proof of its player id, or the
  //                          relay's signed-in session on this server, and no refusal. Always the
  //                          account's current username, so a rename on the site follows.
  //   { taken: true }        anyone else whose name is an account's username, or a name held after
  //                          a rename, without regard to case and look-alikes (core's nameInUse)
  // A slot with neither may keep its name.
  function nameDecisions(players, count, index, sightings, server) {
    const out = {};
    for (const p of players) {
      if (!p.slot) continue;
      const accountId = p.id && count.get(p.id) === 1 ? index.get(p.id) : undefined;
      const sg = accountId !== undefined && accountId !== null ? sightings.get(accountId) : null;
      let vouched = !!(sg && sg.p === p && sg.proven);
      if (sg && sg.p === p && !vouched) {
        const row = store.online(accountId, server);
        vouched = !!(row && row.relay === 1);
      }
      const account = vouched ? accounts.getById(accountId) : null;
      if (account) out[p.slot] = { set: account.username };
      else if (nameInUse && p.name && nameInUse(p.name)) out[p.slot] = { taken: true };
    }
    return out;
  }

  // ---- the relay's events (web client players) ---------------------------------------------------

  function relayStart(e) {
    const server = addressKey(e && e.server);
    const accountId = e && Number.isSafeInteger(e.accountId) ? e.accountId : null;
    if (!server || !accountId || !servers || !servers.get(server) || !accounts.getById(accountId)) return;
    const t = now();
    tx(() => {
      const row = store.online(accountId, server);
      if (row) {
        if (!active(row)) row.last_at = t;
        else credit(row, t);
        row.relay = 1;
        row.away_at = null;
        row.seen_by |= RELAY;
        store.updateOnline(row);
      } else {
        startRow(accountId, server, t, { relay: true });
      }
      resolve(accountId, t);
    });
    changed([accountId]);
  }

  function relayEnd(e) {
    const server = addressKey(e && e.server);
    const accountId = e && Number.isSafeInteger(e.accountId) ? e.accountId : null;
    if (!server || !accountId) return;
    const t = now();
    tx(() => {
      const row = store.online(accountId, server);
      if (!row || !row.relay) return;
      credit(row, t);
      row.relay = 0;
      if (row.plugin_at !== null) store.updateOnline(row);
      else endRow(row, t);
      resolve(accountId, t);
    });
    changed([accountId]);
  }

  // A relay socket opened or closed: the web client is open while an account has one.
  function relaySocket(e, step) {
    const accountId = e && Number.isSafeInteger(e.accountId) ? e.accountId : null;
    if (!accountId) return;
    const n = Math.max(0, (webSockets.get(accountId) || 0) + step);
    if (n) webSockets.set(accountId, n);
    else {
      webSockets.delete(accountId);
      if (step < 0) webClosed.set(accountId, now());
    }
    changed([accountId]);
  }

  // ---- housekeeping ------------------------------------------------------------------------------

  // Every sweepSeconds: a server silent for sessionTimeoutSeconds ends its players' sessions at its
  // last report; a player away longer than rejoinSeconds ends at the time it went; the relay's
  // players are counted; a server gone from servers.json ends its sessions; held rows whose
  // account counts nowhere are promoted; old sessions, network hashes and resolved flags go.
  function sweep() {
    const t = now();
    let ended = 0;
    const affected = new Set();
    tx(() => {
      for (const row of store.pluginStale(t - s.sessionTimeoutSeconds)) {
        row.plugin_at = null;
        row.proven = 0;
        affected.add(row.account_id);
        if (row.relay) store.updateOnline(row);
        else {
          endRow(row, row.last_at);
          ended++;
        }
      }
      for (const row of store.awayExpired(t - s.rejoinSeconds)) {
        endRow(row, row.away_at);
        affected.add(row.account_id);
      }
      for (const row of store.relayRows()) {
        credit(row, t);
        store.updateOnline(row);
      }
      if (servers) {
        for (const server of store.servedServers()) {
          const en = enrollment.enrolled(server);
          if (servers.get(server) || (en && en.approved)) continue;
          for (const row of store.onlineOn(server)) {
            endRow(row, row.last_at);
            affected.add(row.account_id);
            ended++;
          }
        }
      }
      for (const id of new Set([...affected, ...store.heldAccounts()])) resolve(id, t);
      store.pruneSessions(t - s.sessionRetentionDays * 86400);
      store.pruneNets(t - s.netRetentionDays * 86400);
      store.pruneFlags(t - s.flagRetentionDays * 86400);
      enrollment.sweep(t);
      community.sweep(t);
      serverAuth.prune(t);
    });
    changed(null);
    if (ended) log.info("presence.sessions_timed_out", { count: ended });
    return ended;
  }

  // The relay's sockets do not outlive a restart: its players' rows from before are over.
  function forgetRelay() {
    const t = now();
    tx(() => {
      const ids = new Set();
      for (const row of store.relayRows()) {
        row.relay = 0;
        ids.add(row.account_id);
        if (row.plugin_at !== null) store.updateOnline(row);
        else endRow(row, row.last_at);
      }
      for (const id of ids) resolve(id, t);
    });
  }

  // Ends every open session of an account (an admin moved or reset its player id).
  function endAll(accountId, t) {
    for (const row of store.onlineOf(accountId)) {
      credit(row, t);
      endRow(row, t);
    }
  }

  // ---- the admin panel's hooks -------------------------------------------------------------------

  function flagView(f) {
    return {
      id: f.id, username: f.username, kind: f.kind,
      server: f.server ? serverView(f.server).name : null, serverAddress: f.server, otherServer: f.other_server ? serverView(f.other_server).name : null,
      device: f.device, networkKnown: f.net_known === null || f.net_known === undefined ? null : f.net_known === 1, detail: f.detail,
      first: iso(f.first_at), last: iso(f.last_at), count: f.count, status: f.status, resolved: iso(f.resolved_at), note: f.note,
    };
  }

  function adminAccountView(account) {
    const t = now();
    const own = ownView(account);
    return {
      ...own,
      online: store.onlineOf(account.id).map((r) => ({ ...rowView(r, t), device: r.device, network: r.net ? "seen" : null })),
      devices: store.devicesOf(account.id).map((d) => ({ device: d.device, status: d.status, firstSeen: iso(d.first_seen), lastSeen: iso(d.last_seen) })),
      flags: store.flagsOf(account.id).map((f) => flagView({ ...f, username: account.username })),
      networks: store.netCount(account.id),
    };
  }

  function target(name) {
    const a = accounts.getByUsername(name);
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    return a;
  }

  function record(rc, action, account, subject, detail) {
    if (audit) audit.record({ actor: rc.account, action, target: account, subject, detail });
    log.info("presence.admin", { action, by: rc.account.username, user: account ? account.username : undefined });
  }

  const note = (body) => cleanText(body.note, 300) || null;
  const admin = (handler) => auth.requireRole("admin", async (req, res, rc) => {
    limit("adminPerAccount", "a:" + rc.account.id);
    return handler(req, res, rc);
  });

  router.get("/api/presence/admin/flags", admin(async (req, res, rc) => {
    const status = rc.query.get("status") || "open";
    if (!["open", "resolved", "all"].includes(status)) throw new HttpError(400, "bad_request", "status is open, resolved or all.");
    const page = Math.max(1, Math.min(10000, Number.parseInt(rc.query.get("page") || "1", 10) || 1));
    const total = store.flagCount(status);
    rc.json(200, { status, page, pages: Math.max(1, Math.ceil(total / 50)), total, flags: store.flags(status, 50, (page - 1) * 50).map(flagView) });
  }));

  router.post("/api/presence/admin/flags/:id/resolve", admin(async (req, res, rc) => {
    const body = await rc.body({ optional: true });
    const id = Number(rc.params.id);
    const f = Number.isSafeInteger(id) ? store.flag(id) : null;
    if (!f) throw new HttpError(404, "not_found", "No such flag.");
    if (f.status !== "open") throw new HttpError(409, "already_resolved", "That flag is resolved already.");
    store.resolveFlag(id, now(), rc.account.id, note(body));
    record(rc, "presence.flag.resolve", accounts.getById(f.account_id), "flag " + id + " (" + f.kind + ")", note(body));
    rc.json(200, { ok: true });
  }));

  router.get("/api/presence/admin/accounts/:username", admin(async (req, res, rc) => {
    rc.json(200, adminAccountView(target(rc.params.username)));
  }));

  router.post("/api/presence/admin/accounts/:username/devices/:device/allow", admin(async (req, res, rc) => {
    const body = await rc.body({ optional: true });
    const account = target(rc.params.username);
    const device = String(rc.params.device).toLowerCase();
    if (!HEX32.test(device)) throw new HttpError(400, "bad_request", "A device is 32 hex characters, as the flag shows it.");
    const t = now();
    tx(() => {
      const known = store.device(account.id, device);
      store.putDevice(account.id, device, known && known.status === "bound" ? "bound" : "allowed", t, rc.account.id);
      store.resolveFlagsAbout(account.id, "second_device", device, t, rc.account.id, "device allowed" + (note(body) ? ": " + note(body) : ""));
    });
    record(rc, "presence.device.allow", account, "device " + device.slice(0, 12), note(body));
    changed([account.id]);
    rc.json(200, { ok: true, devices: store.devicesOf(account.id).map((d) => ({ device: d.device, status: d.status })) });
  }));

  router.post("/api/presence/admin/accounts/:username/devices/:device/unbind", admin(async (req, res, rc) => {
    const body = await rc.body({ optional: true });
    const account = target(rc.params.username);
    const device = String(rc.params.device).toLowerCase();
    if (!HEX32.test(device)) throw new HttpError(400, "bad_request", "A device is 32 hex characters.");
    if (!store.deleteDevice(account.id, device)) throw new HttpError(404, "not_found", "That device is not on this account.");
    record(rc, "presence.device.unbind", account, "device " + device.slice(0, 12), note(body));
    changed([account.id]);
    rc.json(200, { ok: true, devices: store.devicesOf(account.id).map((d) => ({ device: d.device, status: d.status })) });
  }));

  const confirmed = (body, account) => typeof body.confirm === "string" && body.confirm.trim().toLowerCase() === account.username.toLowerCase();

  router.post("/api/presence/admin/accounts/:username/move-id", admin(async (req, res, rc) => {
    if (!movePlayerId || !confirmAdmin) throw new HttpError(503, "not_ready", "This h9web's core cannot move a player id yet.");
    const body = await rc.body();
    const from = target(rc.params.username);
    if (!confirmed(body, from)) throw new HttpError(400, "confirm", "Type the account's username in confirm to move its player id.");
    const to = typeof body.to === "string" ? accounts.getByUsername(body.to) : null;
    if (!to) throw new HttpError(404, "not_found", "No account to move the player id to.");
    if (to.id === from.id) throw new HttpError(400, "bad_request", "That is the same account.");
    await confirmAdmin(rc, body.password);
    const t = now();
    tx(() => {
      endAll(from.id, t);
      endAll(to.id, t);
      store.moveHistory(from.id, to.id, t, rc.account.id);
      movePlayerId(from.id, to.id);
    });
    record(rc, "presence.id.move", from, "player id and presence history to " + to.username, note(body));
    changed(null);
    rc.json(200, { ok: true, from: from.username, to: to.username });
  }));

  router.post("/api/presence/admin/accounts/:username/reset-id", admin(async (req, res, rc) => {
    if (!resetPlayerId || !confirmAdmin) throw new HttpError(503, "not_ready", "This h9web's core cannot reset a player id yet.");
    const body = await rc.body();
    const account = target(rc.params.username);
    if (!confirmed(body, account)) throw new HttpError(400, "confirm", "Type the account's username in confirm to reset its player id.");
    await confirmAdmin(rc, body.password);
    const keepDevices = body.keepDevices !== false;
    const t = now();
    tx(() => {
      endAll(account.id, t);
      if (!keepDevices) store.clearDevices(account.id);
      resetPlayerId(account.id);
    });
    record(rc, "presence.id.reset", account, "player id", (keepDevices ? "devices kept" : "devices cleared") + (note(body) ? ": " + note(body) : ""));
    changed(null);
    rc.json(200, { ok: true, keepDevices });
  }));

  // ---- the public routes -------------------------------------------------------------------------

  const publicHeaders = () => ({ "Cache-Control": "public, max-age=" + s.cacheSeconds });

  router.post("/api/presence/report", report, { csrf: false });

  router.get("/api/presence/now", async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    rc.json(200, nowView(), publicHeaders());
  });

  router.get("/api/presence/accounts", async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const names = [];
    const seen = new Set();
    for (const part of rc.query.getAll("u").join(",").split(",")) {
      const n = part.trim();
      if (!n) continue;
      if (n.length > 64) throw new HttpError(400, "bad_request", "A username is at most 64 characters.");
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      names.push(n);
      if (names.length > s.batchMax) throw new HttpError(400, "too_many", "At most " + s.batchMax + " names at once.");
    }
    if (!names.length) throw new HttpError(400, "bad_request", "Name the accounts: ?u=name1,name2");
    const out = {};
    for (const n of names) {
      const a = accounts.getByUsername(n);
      out[n] = a ? compactView(a) : null;
    }
    rc.json(200, { accounts: out }, publicHeaders());
  });

  router.get("/api/presence/account/:username", async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const a = accounts.getByUsername(rc.params.username);
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    rc.json(200, cardView(a), publicHeaders());
  });

  router.get("/api/presence/me", auth.requireSession(async (req, res, rc) => {
    rc.json(200, ownView(rc.account));
  }));

  // The privacy switches: GET gives the account's, POST changes any of them.
  router.get("/api/presence/settings", auth.requireSession(async (req, res, rc) => {
    rc.json(200, { privacy: privacyOf(rc.account.id), defaults: { ...s.privacy } });
  }));

  router.post("/api/presence/settings", auth.requireSession(async (req, res, rc) => {
    limit("settingsPerAccount", "a:" + rc.account.id);
    const body = await rc.body();
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => !PRIVACY.some(([p]) => p === k) || typeof body[k] !== "boolean")) {
      throw new HttpError(400, "bad_request", "Send switches as true or false: " + PRIVACY.map(([p]) => p).join(", ") + ".");
    }
    const was = store.settings(rc.account.id) || {};
    const cols = {};
    for (const [k, col] of PRIVACY) cols[col] = k in body ? (body[k] ? 1 : 0) : (was[col] === 0 || was[col] === 1 ? was[col] : null);
    store.putSettings(rc.account.id, cols, now());
    changed([rc.account.id]);
    log.info("presence.privacy", { user: rc.account.username, changed: keys.map((k) => k + "=" + (body[k] ? "on" : "off")).join(",") });
    rc.json(200, { ok: true, privacy: privacyOf(rc.account.id) });
  }));

  // ---- start and stop ----------------------------------------------------------------------------

  let timer = null;
  const listeners = {
    "relay-game-start": (e) => { try { relayStart(e); } catch (err) { log.error("presence.relay_event", { error: err.message }); } },
    "relay-game-end": (e) => { try { relayEnd(e); } catch (err) { log.error("presence.relay_event", { error: err.message }); } },
    "relay-open": (e) => relaySocket(e, 1),
    "relay-close": (e) => relaySocket(e, -1),
    "account-deleted": () => setImmediate(() => changed(null)),
  };

  function start() {
    for (const [name, present] of [["accounts.clientIdIndex", clientIdIndex], ["servers", servers]]) {
      if (!present) log.warn("presence.core_hook_missing", { hook: name, effect: "reports are refused with 503" });
    }
    if (!verifyIdProof) log.warn("presence.core_hook_missing", { hook: "accounts.verifyIdProof", effect: "proofs cannot be checked: every sighting is unverified, and no names are given" });
    if (!nameInUse) log.warn("presence.core_hook_missing", { hook: "accounts.nameInUse", effect: "registered names are not protected in game" });
    if (!lastActive || !activeSince) log.warn("presence.core_hook_missing", { hook: "auth.lastActive/activeSince", effect: "nobody shows as on the site" });
    if (!confirmAdmin) log.warn("presence.core_hook_missing", { hook: "auth.confirmAdmin", effect: "move-id and reset-id answer 503" });
    netKey = loadNetKey(deps.dataDir, log);
    enrollment.start();
    forgetRelay();
    if (events) for (const [name, fn] of Object.entries(listeners)) events.on(name, fn);
    timer = setInterval(() => {
      try { sweep(); } catch (e) { log.error("presence.sweep", { error: e.message }); }
    }, s.sweepSeconds * 1000);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (events) for (const [name, fn] of Object.entries(listeners)) events.off(name, fn);
    community.stop();
  }

  return { settings: s, store, keys, enrollment, community, start, stop, sweep, nowView, cardView, compactView, ownView };
}

let instance = null;

export default {
  name: "presence",
  migrations: MIGRATIONS,
  async setup(ctx) {
    instance = createPresence({
      db: ctx.db,
      transaction: ctx.transaction,
      router: ctx.router,
      auth: ctx.auth,
      accounts: ctx.accounts,
      servers: ctx.servers || null,
      events: ctx.events,
      audit: ctx.audit || null,
      log: ctx.log,
      settings: ctx.settings,
      dataDir: ctx.dataDir,
      http: ctx.http,
      limits: ctx.limits,
    });
    instance.start();
  },
  async stop() {
    if (instance) instance.stop();
    instance = null;
  },
};
