// compete.js -- rated play on H9's servers: compts's Elo and its scoreboard, tied to havoc9.org
// accounts. docs\H9_COMPETITIVE.txt is the guide.
//
// A rated server runs h9_compete.amxx beside h9_presence. Its calls are signed like the
// community's (serverauth.js: the server's key, a time within clockSkewSeconds, a one-time nonce):
//   POST /api/presence/compete/start    a match begins: the map, the ladder, who is on which side
//   POST /api/presence/compete/kills    while it runs, numbered batches: who is there, the kills
//   POST /api/presence/compete/end      how it ended, and each player's side, rounds and time
//   POST /api/presence/compete/rating   ratings and ranks for say /rank in game
//
// The rule is compts's (xjiro's Competitive TS, MIT), as its README states it:
//   a kill       the killer +1, the victim -1
//   a headshot   the killer +1 more
//   the bonus    killing a better player: +1 for each 100 points between them, and the victim
//                loses half of that bonus too (compts's code had the bonus the wrong way round)
//   a match      a rated ts_matchmode match: +100 to each winner, -70 to each loser; a leaver and
//                a side that forfeits lose
//   staying away 30 days without a counted kill or match cost 10 points a day
// Team kills, suicides, and kills by or of anyone not proven move nothing. Nobody goes below 0.
// One account counts at most pairKillsPerDay kills on one other a day; past that a kill is kept
// for the record and rates nothing.
//
// Proven: an account that presence has in game on this server and verified now (a proof that
// answered a nonce h9web issued in the last proofMaxAgeSeconds, or the relay's signed-in socket)
// and not held for being in two places at once. Nothing is kept about anyone else.
//
// Scopes, fixed when a match starts:
//   "s:<address>"  the server's own table, always
//   "c:<id>"       its community's ladder, when the community's staff turned the ladder on and
//                  ticked this server (COUNTS FOR THE LADDER)
//   "n"            the H9 ladder, when an H9 site admin marked the server NETWORK LADDER
// Ladders: "match" (ts_matchmode's matches, results and kills) and "dm" (TS's own deathmatch
// maps: kills only, each map one match for the history).
//
// A void takes back exactly what a match gave and took in the scopes voided (compete_deltas).
//
// Levels, Lv 0 to 99, one per account, from the H9 ladder's match table ("n", "match"); no rated
// match there is Lv 0. H9's site admins pick the rule (POST /api/presence/compete/levels):
//   "elo"     Lv = (rating - eloBase) / eloPerLevel + 1, rounded down, from 1 to 99: it moves up
//             and down with the rating
//   "career"  Lv = the square root of (experience / xpPerLevel), rounded down, from 1 to 99. Each
//             match the H9 ladder rates gives each player who played it out (matchXp + winXp
//             for a win) x their kills-to-deaths factor x their rating / 1000 (each factor kept
//             within its admin-set bounds); a leaver gets none. It only rises (a void takes back
//             the voided match's experience)
// Each account's level is kept in compete_levels and worked out again whenever its rating, its
// experience or the settings change. The presence report's answer gives the in-game level of each
// proven player ("levels", index.js), which h9_presence sends to every client as H9Level.

import { cleanMap, cleanText } from "./modes.js";

const CLIENT_ID = /^[0-9a-f]{32}$/;
const LADDERS = ["match", "dm"];
const HOWS = ["finished", "forfeit", "cancelled"];
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null);
const whole = (v, max = 1e9) => (Number.isSafeInteger(v) && v >= 0 ? Math.min(v, max) : 0);
const kindOf = (scope) => (scope === "n" ? "network" : scope.startsWith("c:") ? "community" : "server");

export const COMPETE_DEFAULTS = Object.freeze({
  startElo: 1000,
  killPoints: 1,
  headshotPoints: 1,
  bonusPer: 100,
  winPoints: 100,
  lossPoints: 70,
  decayAfterDays: 30,
  decayPerDay: 10,
  pairKillsPerDay: 30,
  minRounds: 3,
  minSeconds: 300,
  networkMinPerSide: 2,
  abandonHours: 6,
  disputeHours: 48,
  maxKillsPerCall: 150,
  maxPlayers: 128,
  pageSize: 50,
  matchesShown: 20,
  limits: Object.freeze({
    callsPerServer: Object.freeze({ max: 240, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    staffPerAccount: Object.freeze({ max: 120, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 600 }),
    disputePerAccount: Object.freeze({ max: 10, windowSeconds: 86400, blockSeconds: 3600, maxBlockSeconds: 86400 }),
  }),
});

const RANGES = {
  startElo: [0, 100000], killPoints: [0, 1000], headshotPoints: [0, 1000], bonusPer: [1, 100000],
  winPoints: [0, 10000], lossPoints: [0, 10000], decayAfterDays: [1, 3650], decayPerDay: [0, 10000],
  pairKillsPerDay: [1, 100000], minRounds: [1, 100], minSeconds: [0, 86400], networkMinPerSide: [1, 64],
  abandonHours: [1, 168], disputeHours: [1, 720], maxKillsPerCall: [1, 1000], maxPlayers: [2, 256],
  pageSize: [10, 200], matchesShown: [1, 100],
};

// moduleSettings.presence.compete, each with a default (COMPETE_DEFAULTS).
export function competeSettings(raw = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("presence: moduleSettings.presence.compete must be an object");
  const c = { ...COMPETE_DEFAULTS, ...raw, limits: {} };
  for (const [k, def] of Object.entries(COMPETE_DEFAULTS.limits)) c.limits[k] = { ...def, ...((raw.limits && raw.limits[k]) || {}) };
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) throw new Error("presence: moduleSettings.presence.compete." + k + " must be a whole number from " + lo + " to " + hi);
  }
  for (const [k, l] of Object.entries(c.limits)) {
    for (const f of ["max", "windowSeconds", "blockSeconds", "maxBlockSeconds"]) {
      if (typeof l[f] !== "number" || !(l[f] > 0)) throw new Error("presence: moduleSettings.presence.compete.limits." + k + "." + f + " must be a number above 0");
    }
  }
  return c;
}

// The levels' settings, as the site admins set them; any key not set takes its default here.
export const LEVEL_DEFAULTS = Object.freeze({
  rule: "elo",
  eloBase: 800,
  eloPerLevel: 20,
  matchXp: 100,
  winXp: 50,
  kdaMin: 0.5,
  kdaMax: 2,
  eloMultMin: 0.5,
  eloMultMax: 2,
  xpPerLevel: 50,
});

const LEVEL_RANGES = {
  eloBase: [0, 100000], eloPerLevel: [1, 10000], matchXp: [0, 100000], winXp: [0, 100000],
  kdaMin: [0, 100], kdaMax: [0, 100], eloMultMin: [0, 100], eloMultMax: [0, 100], xpPerLevel: [1, 1000000],
};

// { settings, problems }: raw's values where they are good, the defaults elsewhere, and the names
// of the values that were not.
export function levelSettings(raw = {}) {
  const settings = { ...LEVEL_DEFAULTS };
  const problems = [];
  for (const k of Object.keys(LEVEL_DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    if (k === "rule") {
      if (v === "elo" || v === "career") settings.rule = v;
      else problems.push(k);
      continue;
    }
    const n = Number(v);
    const [lo, hi] = LEVEL_RANGES[k];
    if (Number.isFinite(n) && n >= lo && n <= hi) settings[k] = n;
    else problems.push(k);
  }
  if (settings.kdaMin > settings.kdaMax) problems.push("kdaMin");
  if (settings.eloMultMin > settings.eloMultMax) problems.push("eloMultMin");
  return { settings, problems };
}

// deps: db, transaction, router, auth, accounts (clientIdIndex, getById, getByUsername), serverAuth,
// enrollment, community, limit (presence's limiter), ipKey, audit, log, http: { HttpError },
// limits: { RateLimiter }, now (unix seconds), settings (presence's), privacyOf(accountId),
// serverName(address)
export function createCompete(deps) {
  const { db, router, auth, accounts, serverAuth, enrollment, community, limit, ipKey, log, now } = deps;
  const { HttpError } = deps.http;
  const tx = deps.transaction;
  const audit = deps.audit && typeof deps.audit.record === "function" ? deps.audit : null;
  const c = competeSettings((deps.settings && deps.settings.compete) || {});
  const shownByDefault = !deps.settings || !deps.settings.privacy || deps.settings.privacy.playtime !== false ? 1 : 0;
  const clientIdIndex = typeof accounts.clientIdIndex === "function" ? accounts.clientIdIndex : null;
  const privacyOf = deps.privacyOf;
  const serverName = deps.serverName || ((key) => key);

  const limiters = {};
  for (const [k, v] of Object.entries(c.limits)) limiters[k] = new deps.limits.RateLimiter(v);
  let hits = 0;
  function own(name, key) {
    if (++hits % 1000 === 0) for (const l of Object.values(limiters)) l.sweep();
    const r = limiters[name].hit(key);
    if (!r.ok) {
      throw new HttpError(429, "rate_limited", "Too many requests. Try again in " + r.retryAfter + " seconds.", {
        headers: { "Retry-After": String(r.retryAfter) },
      });
    }
  }

  // An account's playtime switch (docs\H9_PRESENCE.txt section 6) decides whether its numbers
  // show; NULL in presence_settings follows the module's default.
  const VISIBLE = "COALESCE(ps.show_playtime, " + shownByDefault + ") = 1";
  const q = {
    online: db.prepare("SELECT plugin_at, relay, proven, held FROM presence_online WHERE account_id = ? AND server = ?"),
    server: db.prepare("SELECT * FROM compete_servers WHERE server = ?"),
    ensureServer: db.prepare("INSERT OR IGNORE INTO compete_servers (server) VALUES (?)"),
    setNetwork: db.prepare("UPDATE compete_servers SET network = ?, network_by = ?, network_at = ? WHERE server = ?"),
    setCounts: db.prepare("UPDATE compete_servers SET ladder_community = ? WHERE server = ?"),
    touchServer: db.prepare("UPDATE compete_servers SET last_match = ? WHERE server = ?"),
    ladder: db.prepare("SELECT ladder FROM compete_communities WHERE community_id = ?"),
    setLadder: db.prepare("INSERT INTO compete_communities (community_id, ladder, set_by, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(community_id) DO UPDATE SET ladder = excluded.ladder, set_by = excluded.set_by, set_at = excluded.set_at"),
    communityBySlug: db.prepare("SELECT * FROM presence_communities WHERE slug = ?"),
    communityById: db.prepare("SELECT * FROM presence_communities WHERE id = ?"),
    isStaff: db.prepare("SELECT 1 AS x FROM presence_community_staff WHERE community_id = ? AND account_id = ?"),
    isMember: db.prepare("SELECT 1 AS x FROM presence_community_members WHERE community_id = ? AND account_id = ?"),
    linkedTo: db.prepare("SELECT community_id FROM presence_community_servers WHERE server = ?"),
    insertMatch: db.prepare(`INSERT INTO compete_matches (server, community_id, scopes, ladder, map, mode, started_at, last_at, humans, bots)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    match: db.prepare("SELECT * FROM compete_matches WHERE id = ?"),
    openOn: db.prepare("SELECT * FROM compete_matches WHERE server = ? AND status = 'open'"),
    openBefore: db.prepare("SELECT * FROM compete_matches WHERE status = 'open' AND last_at < ?"),
    progress: db.prepare("UPDATE compete_matches SET seq = ?, last_at = ?, kills = kills + ?, unrated_kills = unrated_kills + ? WHERE id = ?"),
    close: db.prepare("UPDATE compete_matches SET status = 'over', how = ?, ended_at = ?, why = ? WHERE id = ?"),
    finish: db.prepare(`UPDATE compete_matches SET status = 'over', how = ?, winner = ?, score1 = ?, score2 = ?, rounds = ?,
      rated = ?, why = ?, ended_at = ?, last_at = ?, bots = MAX(COALESCE(bots, 0), ?) WHERE id = ?`),
    setScopes: db.prepare("UPDATE compete_matches SET scopes = ? WHERE id = ?"),
    voided: db.prepare("UPDATE compete_matches SET status = 'voided', scopes = '', voided_by = ?, voided_at = ?, void_note = ? WHERE id = ?"),
    player: db.prepare("SELECT * FROM compete_players WHERE match_id = ? AND account_id = ?"),
    ensurePlayer: db.prepare("INSERT OR IGNORE INTO compete_players (match_id, account_id, side) VALUES (?, ?, ?)"),
    side: db.prepare("UPDATE compete_players SET side = ? WHERE match_id = ? AND account_id = ? AND ? > 0"),
    stats: db.prepare(`UPDATE compete_players SET kills = kills + ?, deaths = deaths + ?, headshots = headshots + ?, teamkills = teamkills + ?
      WHERE match_id = ? AND account_id = ?`),
    endPlayer: db.prepare("UPDATE compete_players SET side = CASE WHEN ? > 0 THEN ? ELSE side END, rounds = ?, seconds = ?, left_early = ? WHERE match_id = ? AND account_id = ?"),
    result: db.prepare("UPDATE compete_players SET result = ? WHERE match_id = ? AND account_id = ?"),
    place: db.prepare("UPDATE compete_players SET place = ? WHERE id = ?"),
    players: db.prepare("SELECT * FROM compete_players WHERE match_id = ? ORDER BY side, kills DESC, deaths ASC, id"),
    countPlayers: db.prepare("SELECT COUNT(*) AS n FROM compete_players WHERE match_id = ?"),
    ensureRating: db.prepare("INSERT OR IGNORE INTO compete_ratings (scope, ladder, account_id, elo, last_at) VALUES (?, ?, ?, ?, ?)"),
    rating: db.prepare("SELECT * FROM compete_ratings WHERE scope = ? AND ladder = ? AND account_id = ?"),
    rateKill: db.prepare(`UPDATE compete_ratings SET elo = MAX(0, elo + ?), kills = kills + ?, headshots = headshots + ?, deaths = deaths + ?,
      last_at = ?, decayed_at = NULL WHERE scope = ? AND ladder = ? AND account_id = ?`),
    rateResult: db.prepare(`UPDATE compete_ratings SET elo = MAX(0, elo + ?), wins = wins + ?, losses = losses + ?, matches = matches + 1,
      last_at = ?, decayed_at = NULL WHERE scope = ? AND ladder = ? AND account_id = ?`),
    unrate: db.prepare(`UPDATE compete_ratings SET elo = MAX(0, elo - ?), kills = MAX(0, kills - ?), deaths = MAX(0, deaths - ?),
      headshots = MAX(0, headshots - ?), wins = MAX(0, wins - ?), losses = MAX(0, losses - ?), matches = MAX(0, matches - ?)
      WHERE scope = ? AND ladder = ? AND account_id = ?`),
    delta: db.prepare(`INSERT INTO compete_deltas (match_id, scope, account_id, delta, kills, deaths, headshots, wins, losses, matches)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(match_id, scope, account_id) DO UPDATE SET delta = delta + excluded.delta,
      kills = kills + excluded.kills, deaths = deaths + excluded.deaths, headshots = headshots + excluded.headshots,
      wins = wins + excluded.wins, losses = losses + excluded.losses, matches = matches + excluded.matches`),
    deltas: db.prepare("SELECT * FROM compete_deltas WHERE match_id = ?"),
    dropDeltas: db.prepare("DELETE FROM compete_deltas WHERE match_id = ? AND scope = ?"),
    pairHit: db.prepare("INSERT INTO compete_pairs (day, killer, victim, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, killer, victim) DO UPDATE SET n = n + 1"),
    pair: db.prepare("SELECT n FROM compete_pairs WHERE day = ? AND killer = ? AND victim = ?"),
    prunePairs: db.prepare("DELETE FROM compete_pairs WHERE day < ?"),
    idle: db.prepare("SELECT scope, ladder, account_id, elo, last_at, decayed_at FROM compete_ratings WHERE last_at < ?"),
    decay: db.prepare("UPDATE compete_ratings SET elo = ?, decayed_at = ? WHERE scope = ? AND ladder = ? AND account_id = ?"),
    board: db.prepare(`SELECT r.*, a.username, lv.level AS level FROM compete_ratings r JOIN accounts a ON a.id = r.account_id
      LEFT JOIN presence_settings ps ON ps.account_id = r.account_id LEFT JOIN compete_levels lv ON lv.account_id = r.account_id
      WHERE r.scope = ? AND r.ladder = ? AND ${VISIBLE} ORDER BY r.elo DESC, r.kills DESC, a.id ASC LIMIT ? OFFSET ?`),
    boardCount: db.prepare(`SELECT COUNT(*) AS n FROM compete_ratings r LEFT JOIN presence_settings ps ON ps.account_id = r.account_id
      WHERE r.scope = ? AND r.ladder = ? AND ${VISIBLE}`),
    above: db.prepare(`SELECT COUNT(*) AS n FROM compete_ratings r LEFT JOIN presence_settings ps ON ps.account_id = r.account_id
      WHERE r.scope = ? AND r.ladder = ? AND r.elo > ? AND r.account_id <> ? AND ${VISIBLE}`),
    ratingsOf: db.prepare("SELECT * FROM compete_ratings WHERE account_id = ? ORDER BY scope, ladder"),
    matchesOf: db.prepare(`SELECT m.*, p.side, p.kills AS p_kills, p.deaths AS p_deaths, p.headshots AS p_headshots, p.result AS p_result, p.place AS p_place
      FROM compete_players p JOIN compete_matches m ON m.id = p.match_id
      WHERE p.account_id = ? AND m.status <> 'voided' ORDER BY m.started_at DESC, m.id DESC LIMIT ?`),
    deltaOf: db.prepare("SELECT delta FROM compete_deltas WHERE match_id = ? AND scope = ? AND account_id = ?"),
    serversList: db.prepare(`SELECT cs.*, (SELECT MAX(started_at) FROM compete_matches m WHERE m.server = cs.server) AS last
      FROM compete_servers cs ORDER BY last DESC`),
    addDispute: db.prepare("INSERT INTO compete_disputes (match_id, account_id, reason, at) VALUES (?, ?, ?, ?)"),
    openDispute: db.prepare("SELECT id FROM compete_disputes WHERE match_id = ? AND account_id = ? AND status = 'open'"),
    dispute: db.prepare("SELECT * FROM compete_disputes WHERE id = ?"),
    disputes: db.prepare(`SELECT d.*, a.username FROM compete_disputes d LEFT JOIN accounts a ON a.id = d.account_id
      WHERE (? = 'all' OR d.status = ?) ORDER BY d.id DESC LIMIT 100`),
    resolveDispute: db.prepare("UPDATE compete_disputes SET status = 'resolved', resolved_by = ?, resolved_at = ?, note = ? WHERE id = ?"),
    cfgAll: db.prepare("SELECT key, value FROM compete_config"),
    cfgPut: db.prepare(`INSERT INTO compete_config (key, value, set_by, set_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`),
    xpPut: db.prepare("INSERT OR REPLACE INTO compete_xp (match_id, account_id, xp) VALUES (?, ?, ?)"),
    xpSum: db.prepare(`SELECT COALESCE(SUM(x.xp), 0) AS xp FROM compete_xp x JOIN compete_matches m ON m.id = x.match_id
      WHERE x.account_id = ? AND m.status <> 'voided'`),
    xpOfMatch: db.prepare("SELECT account_id FROM compete_xp WHERE match_id = ?"),
    xpDrop: db.prepare("DELETE FROM compete_xp WHERE match_id = ?"),
    levelPut: db.prepare(`INSERT INTO compete_levels (account_id, level, xp, rule, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET level = excluded.level, xp = excluded.xp, rule = excluded.rule, updated_at = excluded.updated_at`),
    levelGet: db.prepare("SELECT level, xp, rule FROM compete_levels WHERE account_id = ?"),
    levelAccounts: db.prepare("SELECT account_id FROM compete_ratings WHERE scope = 'n' AND ladder = 'match' UNION SELECT account_id FROM compete_levels"),
  };

  const day = (t) => Math.floor(t / 86400);
  const isSiteAdmin = (account) => !!account && auth.roleAtLeast(account, "admin");
  const isStaff = (account, cm) => !!account && (cm.owner_id === account.id || isSiteAdmin(account) || !!q.isStaff.get(cm.id, account.id));
  const isMember = (account, cm) => !!account && (isStaff(account, cm) || !!q.isMember.get(cm.id, account.id));

  // In game on this server, verified and counted, as presence keeps it (index.js, counts()).
  function provenNow(server, accountId) {
    const r = q.online.get(accountId, server);
    return !!r && (r.plugin_at !== null || r.relay === 1) && (r.proven === 1 || r.relay === 1) && r.held === 0;
  }

  // The scopes a match on this server counts in, from the flags as they are now.
  function scopesFor(server) {
    const keys = ["s:" + server];
    const sv = q.server.get(server);
    const link = q.linkedTo.get(server);
    const communityId = link ? link.community_id : null;
    if (communityId && sv && sv.ladder_community === communityId) {
      const l = q.ladder.get(communityId);
      if (l && l.ladder === 1) keys.push("c:" + communityId);
    }
    if (sv && sv.network === 1) keys.push("n");
    return { keys, communityId };
  }

  function rating(scope, ladder, accountId, t) {
    q.ensureRating.run(scope, ladder, accountId, c.startElo, t);
    return q.rating.get(scope, ladder, accountId);
  }

  // ---- levels -------------------------------------------------------------------------------------

  function levelConfig() {
    const raw = {};
    for (const r of q.cfgAll.all()) raw[r.key] = r.value;
    return levelSettings(raw).settings;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function levelFrom(cfg, h9, xp) {
    if (!h9 || !h9.matches) return 0;
    if (cfg.rule === "career") return clamp(Math.floor(Math.sqrt(xp / cfg.xpPerLevel)), 1, 99);
    return clamp(Math.floor((h9.elo - cfg.eloBase) / cfg.eloPerLevel) + 1, 1, 99);
  }

  // Works an account's level out again and keeps it.
  function relevel(accountId, t = now(), cfg = levelConfig()) {
    const xp = q.xpSum.get(accountId).xp;
    const level = levelFrom(cfg, q.rating.get("n", "match", accountId), xp);
    q.levelPut.run(accountId, level, xp, cfg.rule, t);
    return level;
  }

  function relevelAll(t = now()) {
    const cfg = levelConfig();
    const ids = q.levelAccounts.all().map((r) => r.account_id);
    tx(() => {
      for (const id of ids) relevel(id, t, cfg);
    });
    return ids.length;
  }

  function levelOf(accountId) {
    const r = q.levelGet.get(accountId);
    return r ? r.level : 0;
  }

  // The report answer's "levels": { "<slot>": level } for each proven player (index.js). A slot not
  // named shows no level: no havoc9.org account, a game that did not prove the player id, a bot.
  function levelsFor(slots) {
    const out = {};
    for (const e of slots) if (e.slot && e.accountId && e.proven) out[e.slot] = levelOf(e.accountId);
    return out;
  }

  // A career's experience for one rated match on the H9 ladder, as the settings have it.
  function matchXp(cfg, row, won, elo) {
    const kda = clamp(((row ? row.kills : 0) + 1) / ((row ? row.deaths : 0) + 1), cfg.kdaMin, cfg.kdaMax);
    const mult = clamp(elo / 1000, cfg.eloMultMin, cfg.eloMultMax);
    return Math.max(0, Math.round((cfg.matchXp + (won ? cfg.winXp : 0)) * kda * mult));
  }

  // ---- reading what a server sends ----------------------------------------------------------------

  function readRoster(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > c.maxPlayers) throw new HttpError(400, "bad_request", "players: at most " + c.maxPlayers + " entries.");
    const out = [];
    for (const e of list) {
      if (!Array.isArray(e) || !CLIENT_ID.test(String(e[0]))) throw new HttpError(400, "bad_request", "players: [h9_clientid, side] entries.");
      out.push([e[0], e[1] === 1 || e[1] === 2 ? e[1] : 0]);
    }
    return out;
  }

  function readKills(list) {
    if (!Array.isArray(list) || list.length > c.maxKillsPerCall) throw new HttpError(400, "bad_request", "kills: at most " + c.maxKillsPerCall + " a call.");
    return list.map((e) => {
      if (!Array.isArray(e) || !CLIENT_ID.test(String(e[0])) || !CLIENT_ID.test(String(e[1]))) {
        throw new HttpError(400, "bad_request", "kills: [killer h9_clientid, victim h9_clientid, headshot, teamkill] entries.");
      }
      return [e[0], e[1], e[2] === 1, e[3] === 1];
    });
  }

  function readEnd(list) {
    if (!Array.isArray(list) || list.length > c.maxPlayers * 2) throw new HttpError(400, "bad_request", "players: at most " + c.maxPlayers * 2 + " entries.");
    return list.map((e) => {
      if (!Array.isArray(e) || !CLIENT_ID.test(String(e[0]))) throw new HttpError(400, "bad_request", "players: [h9_clientid, side, rounds, seconds, left] entries.");
      return { id: e[0], side: e[1] === 1 || e[1] === 2 ? e[1] : 0, rounds: whole(e[2], 1000), seconds: whole(e[3], 86400 * 7), left: e[4] === 1 };
    });
  }

  async function signed(req, rc, maxBytes) {
    limit("serverCallsPerIp", ipKey(rc.ip));
    if (!clientIdIndex) throw new HttpError(503, "not_ready", "h9web cannot read players' ids yet.");
    const v = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes });
    own("callsPerServer", v.server);
    return v;
  }

  function openMatch(server, id) {
    const m = Number.isSafeInteger(id) ? q.match.get(id) : null;
    if (!m || m.server !== server) throw new HttpError(404, "no_match", "No such match on this server.");
    return m;
  }

  // A proven account seen in this match gets a row; nobody else does.
  function see(m, server, accountId, side) {
    if (!provenNow(server, accountId)) return !!q.player.get(m.id, accountId);
    q.ensurePlayer.run(m.id, accountId, side);
    q.side.run(side, m.id, accountId, side);
    return true;
  }

  // ---- the rule ---------------------------------------------------------------------------------

  function applyKill(m, server, index, [kid, vid, hs, tk], t, touched) {
    const ka = index.get(kid);
    const va = index.get(vid);
    if (!ka || !va || ka === va) return false;
    if (!provenNow(server, ka) || !provenNow(server, va)) return false;
    see(m, server, ka, 0);
    see(m, server, va, 0);
    if (tk) {
      q.stats.run(0, 0, 0, 1, m.id, ka);
      return false;
    }
    q.stats.run(1, 0, hs ? 1 : 0, 0, m.id, ka);
    q.stats.run(0, 1, 0, 0, m.id, va);
    const d = day(t);
    q.pairHit.run(d, ka, va);
    if (q.pair.get(d, ka, va).n > c.pairKillsPerDay) return true;
    for (const scope of m.scopes.split(" ").filter(Boolean)) {
      const rk = rating(scope, m.ladder, ka, t);
      const rv = rating(scope, m.ladder, va, t);
      const bonus = Math.floor(Math.max(0, rv.elo - rk.elo) / c.bonusPer);
      const gain = c.killPoints + bonus + (hs ? c.headshotPoints : 0);
      const loss = Math.min(rv.elo, c.killPoints + Math.floor(bonus / 2));
      q.rateKill.run(gain, 1, hs ? 1 : 0, 0, t, scope, m.ladder, ka);
      q.rateKill.run(-loss, 0, 0, 1, t, scope, m.ladder, va);
      q.delta.run(m.id, scope, ka, gain, 1, 0, hs ? 1 : 0, 0, 0, 0);
      q.delta.run(m.id, scope, va, -loss, 0, 1, 0, 0, 0, 0);
      if (scope === "n" && touched) {
        touched.add(ka);
        touched.add(va);
      }
    }
    return true;
  }

  // The end of a match: the result for the history, and on the MATCH ladder its points where the
  // match rules hold. Returns { rated, why }.
  function finish(m, server, index, { how, winner, score1, score2, rounds, players, others, bots }, t) {
    const sides = { 1: { proven: [], unproven: others[1] }, 2: { proven: [], unproven: others[2] } };
    for (const p of players) {
      const acct = index.get(p.id);
      const known = acct ? (provenNow(server, acct) ? see(m, server, acct, p.side) : !!q.player.get(m.id, acct)) : false;
      if (!known) {
        if (p.side) sides[p.side].unproven++;
        continue;
      }
      q.endPlayer.run(p.side, p.side, p.rounds, p.seconds, p.left ? 1 : 0, m.id, acct);
      if (p.side) sides[p.side].proven.push({ acct, rounds: p.rounds, left: p.left });
    }

    if (m.ladder === "dm") {
      const rows = q.players.all(m.id).sort((a, b) => b.kills - b.deaths - (a.kills - a.deaths) || b.kills - a.kills || a.id - b.id);
      rows.forEach((r, i) => q.place.run(i + 1, r.id));
      q.finish.run(how, 0, null, null, null, 0, "deathmatch: kills only", t, t, bots, m.id);
      return { rated: false, why: "deathmatch: kills only" };
    }

    let why = null;
    if (how === "cancelled") why = "the match was cancelled";
    else if (!winner) why = "the match had no winner";
    else if (bots > 0) why = "bots played";
    else if (rounds < c.minRounds) why = "fewer than " + c.minRounds + " rounds";
    else if (t - m.started_at < c.minSeconds) why = "shorter than " + Math.ceil(c.minSeconds / 60) + " minutes";

    const half = Math.ceil(rounds / 2);
    const counts = (p) => (p.left ? p.rounds >= 1 : p.rounds >= half);
    if (how !== "cancelled" && winner) {
      for (const s of [1, 2]) {
        for (const p of sides[s].proven) {
          const r = p.left && p.rounds >= 1 ? "left" : counts(p) ? (s === winner ? "win" : "loss") : null;
          q.result.run(r, m.id, p.acct);
        }
      }
    }

    let rated = false;
    const refusals = [];
    const cfg = levelConfig();
    for (const scope of m.scopes.split(" ").filter(Boolean)) {
      let no = why;
      if (!no) {
        const n1 = sides[1].proven.filter(counts).length;
        const n2 = sides[2].proven.filter(counts).length;
        if (scope === "n") {
          if (sides[1].unproven + sides[2].unproven > 0) no = "on the H9 ladder every player must be proven";
          else if (n1 < c.networkMinPerSide || n2 < c.networkMinPerSide) no = "the H9 ladder needs " + c.networkMinPerSide + " proven players a side";
        } else if (n1 < 1 || n2 < 1) {
          no = "each side needs a proven player";
        }
      }
      if (no) {
        refusals.push(kindOf(scope) + ": " + no);
        continue;
      }
      rated = true;
      for (const s of [1, 2]) {
        for (const p of sides[s].proven) {
          if (!counts(p)) continue;
          const won = !p.left && s === winner;
          const now0 = rating(scope, m.ladder, p.acct, t);
          const pts = won ? c.winPoints : -Math.min(now0.elo, c.lossPoints);
          q.rateResult.run(pts, won ? 1 : 0, won ? 0 : 1, t, scope, m.ladder, p.acct);
          q.delta.run(m.id, scope, p.acct, pts, 0, 0, 0, won ? 1 : 0, won ? 0 : 1, 1);
          if (scope === "n" && !p.left) q.xpPut.run(m.id, p.acct, matchXp(cfg, q.player.get(m.id, p.acct), won, q.rating.get("n", m.ladder, p.acct).elo));
        }
      }
    }
    for (const s of [1, 2]) for (const p of sides[s].proven) relevel(p.acct, t, cfg);
    const text = why || (refusals.length ? refusals.join("; ") : null);
    q.finish.run(how, winner, whole(score1, 1000), whole(score2, 1000), rounds, rated ? 1 : 0, text, t, t, bots, m.id);
    return { rated, why: text };
  }

  function closeMatch(m, how, t, why) {
    q.close.run(how, t, why, m.id);
  }

  // Takes back what a match gave and took, in the scopes named (all of them: null).
  function voidMatch(m, scopes, actor, note, t) {
    const all = m.scopes.split(" ").filter(Boolean);
    const drop = scopes ? all.filter((k) => scopes.includes(k)) : all;
    for (const d of q.deltas.all(m.id)) {
      if (!drop.includes(d.scope)) continue;
      q.unrate.run(d.delta, d.kills, d.deaths, d.headshots, d.wins, d.losses, d.matches, d.scope, m.ladder, d.account_id);
    }
    const relevelled = new Set();
    if (drop.includes("n")) {
      for (const d of q.deltas.all(m.id)) if (d.scope === "n") relevelled.add(d.account_id);
      for (const r of q.xpOfMatch.all(m.id)) relevelled.add(r.account_id);
      q.xpDrop.run(m.id);
    }
    for (const k of drop) q.dropDeltas.run(m.id, k);
    const keep = all.filter((k) => !drop.includes(k));
    if (keep.length && scopes) q.setScopes.run(keep.join(" "), m.id);
    else q.voided.run(actor ? actor.id : null, t, note || null, m.id);
    for (const id of relevelled) relevel(id, t);
  }

  // ---- the game server's calls ------------------------------------------------------------------

  router.post("/api/presence/compete/start", async (req, res, rc) => {
    const { server, body } = await signed(req, rc, 16384);
    if (!LADDERS.includes(body.ladder)) throw new HttpError(400, "bad_request", "ladder: match or dm.");
    const roster = readRoster(body.players);
    const t = now();
    const { keys, communityId } = scopesFor(server);
    const index = clientIdIndex(server);
    let id = 0;
    let proven = 0;
    tx(() => {
      for (const open of q.openOn.all(server)) closeMatch(open, "cancelled", t, "another match started");
      q.ensureServer.run(server);
      q.touchServer.run(t, server);
      id = Number(q.insertMatch.run(server, communityId, keys.join(" "), body.ladder, cleanMap(body.map), cleanText(body.mode, 48) || null,
        t, t, whole(body.humans, 1000), whole(body.bots, 1000)).lastInsertRowid);
      const m = q.match.get(id);
      for (const [cid, side] of roster) {
        const acct = index.get(cid);
        if (acct && see(m, server, acct, side)) proven++;
      }
    });
    enrollment.serverIdFor(server);
    log.info("presence.compete.start", { server, match: id, ladder: body.ladder, scopes: keys.map(kindOf).join(","), proven });
    rc.json(200, { ok: true, match: id, scopes: keys.map(kindOf), proven });
  }, { csrf: false });

  router.post("/api/presence/compete/kills", async (req, res, rc) => {
    const { server, body } = await signed(req, rc, 16384);
    const m = openMatch(server, body.match);
    if (m.status !== "open") throw new HttpError(409, "match_over", "That match is over.");
    if (!Number.isSafeInteger(body.seq) || body.seq < 1) throw new HttpError(400, "bad_request", "seq: the batch's number, from 1.");
    if (body.seq <= m.seq) return rc.json(200, { ok: true, duplicate: true, seq: m.seq });
    if (body.seq !== m.seq + 1) throw new HttpError(409, "out_of_order", "Send batch " + (m.seq + 1) + " first.");
    const roster = readRoster(body.players);
    const kills = readKills(body.kills === undefined ? [] : body.kills);
    const t = now();
    const index = clientIdIndex(server);
    let counted = 0;
    let unrated = 0;
    const touched = new Set();
    tx(() => {
      for (const [cid, side] of roster) {
        const acct = index.get(cid);
        if (acct) see(m, server, acct, side);
      }
      for (const k of kills) {
        if (applyKill(m, server, index, k, t, touched)) counted++;
        else unrated++;
      }
      q.progress.run(body.seq, t, counted, unrated, m.id);
      if (touched.size) {
        const cfg = levelConfig();
        for (const id of touched) relevel(id, t, cfg);
      }
    });
    rc.json(200, { ok: true, seq: body.seq, counted, unrated });
  }, { csrf: false });

  router.post("/api/presence/compete/end", async (req, res, rc) => {
    const { server, body } = await signed(req, rc, 16384);
    const m = openMatch(server, body.match);
    if (m.status !== "open") return rc.json(200, { ok: true, duplicate: true, rated: m.rated === 1, why: m.why });
    if (body.seq !== undefined && body.seq !== m.seq) throw new HttpError(409, "out_of_order", "Batch " + (m.seq + 1) + " has not arrived.");
    const r = body.result && typeof body.result === "object" ? body.result : {};
    if (!HOWS.includes(r.how)) throw new HttpError(400, "bad_request", "result.how: finished, forfeit or cancelled.");
    const players = readEnd(body.players === undefined ? [] : body.players);
    const o = body.others && typeof body.others === "object" ? body.others : {};
    const t = now();
    const index = clientIdIndex(server);
    let out = null;
    tx(() => {
      out = finish(m, server, index, {
        how: r.how, winner: r.winner === 1 || r.winner === 2 ? r.winner : 0, score1: r.score1, score2: r.score2,
        rounds: whole(r.rounds, 1000), players, others: { 1: whole(o["1"], 1000), 2: whole(o["2"], 1000) }, bots: whole(body.bots, 1000),
      }, t);
    });
    // each proven player's change in this match, by slot-free id: the server scope and the H9 ladder
    const changes = {};
    for (const p of players) {
      const acct = index.get(p.id);
      if (!acct || !q.player.get(m.id, acct)) continue;
      const d = (scope) => {
        const row = q.deltaOf.get(m.id, scope, acct);
        return row ? row.delta : null;
      };
      changes[p.id] = { server: d("s:" + server), network: d("n") };
    }
    log.info("presence.compete.end", { server, match: m.id, how: r.how, rated: out.rated });
    rc.json(200, { ok: true, match: m.id, rated: out.rated, why: out.why, changes });
  }, { csrf: false });

  router.post("/api/presence/compete/rating", async (req, res, rc) => {
    const { server, body } = await signed(req, rc, 4096);
    const ladder = body.ladder === "dm" ? "dm" : "match";
    if (!Array.isArray(body.ids) || body.ids.length > 64 || !body.ids.every((x) => CLIENT_ID.test(String(x)))) {
      throw new HttpError(400, "bad_request", "ids: at most 64 h9_clientids.");
    }
    const index = clientIdIndex(server);
    const out = {};
    for (const cid of body.ids) {
      const acct = index.get(cid);
      if (!acct || !provenNow(server, acct)) {
        out[cid] = null;
        continue;
      }
      out[cid] = {
        public: !!privacyOf(acct).playtime,
        server: standing("s:" + server, ladder, acct),
        network: standing("n", ladder, acct),
      };
    }
    rc.json(200, { ok: true, ladder, players: out });
  }, { csrf: false });

  function standing(scope, ladder, accountId) {
    const r = q.rating.get(scope, ladder, accountId);
    if (!r) return null;
    return { elo: r.elo, rank: q.above.get(scope, ladder, r.elo, accountId).n + 1 };
  }

  // ---- the site's reads ---------------------------------------------------------------------------

  const publicHeaders = () => ({ "Cache-Control": "public, max-age=" + (deps.settings.cacheSeconds || 0) });

  // A scope as the site names it: "network", "c:<community short name>" or "s:<server id>". A
  // private community's ladder, and its servers' tables, are for its members.
  function scopeFor(name, viewer) {
    const v = String(name || "network");
    if (v === "network" || v === "n") return { key: "n", kind: "network", name: "H9 ladder", isPublic: true, manage: isSiteAdmin(viewer) ? { network: true } : null };
    if (v.startsWith("c:")) {
      const cm = q.communityBySlug.get(v.slice(2).toLowerCase());
      if (!cm) throw new HttpError(404, "not_found", "No such community.");
      if (cm.visibility === "private" && !isMember(viewer, cm)) throw new HttpError(404, "not_found", "No such community.");
      const l = q.ladder.get(cm.id);
      return {
        key: "c:" + cm.id, kind: "community", name: cm.name, slug: cm.slug, ladder: !!(l && l.ladder === 1),
        isPublic: cm.visibility !== "private", manage: isStaff(viewer, cm) ? { ladder: true } : null,
      };
    }
    if (v.startsWith("s:")) {
      const row = enrollment.byServerId(v.slice(2));
      if (!row) throw new HttpError(404, "not_found", "No such server.");
      const priv = community.privateCommunityOf(row.server);
      if (priv && !isMember(viewer, priv)) throw new HttpError(404, "not_found", "No such server.");
      const sv = q.server.get(row.server);
      return { key: "s:" + row.server, kind: "server", name: serverName(row.server), serverId: row.server_id, network: !!(sv && sv.network === 1), isPublic: !priv, manage: isSiteAdmin(viewer) ? { network: true } : null };
    }
    throw new HttpError(400, "bad_request", "scope: network, c:<community> or s:<server id>.");
  }

  // How the site names a stored scope, for one viewer: null when that viewer may not see it.
  function scopeView(key, viewer) {
    if (key === "n") return { scope: "network", kind: "network", name: "H9 ladder" };
    if (key.startsWith("c:")) {
      const cm = q.communityById.get(Number(key.slice(2)));
      if (!cm || (cm.visibility === "private" && !isMember(viewer, cm))) return null;
      return { scope: "c:" + cm.slug, kind: "community", name: cm.name };
    }
    const server = key.slice(2);
    const priv = community.privateCommunityOf(server);
    if (priv && !isMember(viewer, priv)) return null;
    return { scope: "s:" + enrollment.serverIdFor(server), kind: "server", name: serverName(server) };
  }

  const ladderOf = (v) => (v === "dm" ? "dm" : "match");
  const line = (r, rank) => ({
    rank, username: r.username, level: r.level === null || r.level === undefined ? 0 : r.level, elo: r.elo, kills: r.kills, deaths: r.deaths, headshots: r.headshots,
    wins: r.wins, losses: r.losses, matches: r.matches, lastPlayed: iso(r.last_at),
  });

  router.get("/api/presence/compete/board", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const sc = scopeFor(rc.query.get("scope"), rc.account);
    const ladder = ladderOf(rc.query.get("ladder"));
    const page = Math.max(1, Math.min(100000, Number.parseInt(rc.query.get("page") || "1", 10) || 1));
    const total = q.boardCount.get(sc.key, ladder).n;
    const rows = q.board.all(sc.key, ladder, c.pageSize, (page - 1) * c.pageSize);
    const { key, isPublic, ...shown } = sc;
    rc.json(200, {
      scope: shown, ladder, page, pages: Math.max(1, Math.ceil(total / c.pageSize)), total,
      players: rows.map((r, i) => line(r, (page - 1) * c.pageSize + i + 1)),
    }, isPublic && !sc.manage ? publicHeaders() : undefined);
  }));

  function playerView(account, viewer, everything) {
    const priv = everything ? { playtime: true, where: true, lastSeen: true } : privacyOf(account.id);
    const out = { username: account.username, level: null, ratings: null, matches: null };
    if (priv.playtime) {
      out.level = levelOf(account.id);
      out.ratings = [];
      for (const r of q.ratingsOf.all(account.id)) {
        const sv = scopeView(r.scope, viewer);
        if (!sv) continue;
        out.ratings.push({ ...sv, ladder: r.ladder, ...line({ ...r, username: account.username }, q.above.get(r.scope, r.ladder, r.elo, account.id).n + 1) });
      }
    }
    if (priv.where && priv.lastSeen) {
      out.matches = [];
      for (const m of q.matchesOf.all(account.id, c.matchesShown)) {
        const priv2 = community.privateCommunityOf(m.server);
        if (priv2 && !isMember(viewer, priv2)) continue;
        const d = q.deltaOf.get(m.id, "s:" + m.server, account.id);
        out.matches.push({
          id: m.id, ladder: m.ladder, map: m.map, mode: m.mode, server: serverName(m.server), started: iso(m.started_at), ended: iso(m.ended_at),
          status: m.status, how: m.how, rated: m.rated === 1, side: m.side, result: m.p_result, place: m.p_place,
          kills: m.p_kills, deaths: m.p_deaths, headshots: m.p_headshots, change: d ? d.delta : null,
        });
      }
    }
    return out;
  }

  router.get("/api/presence/compete/player/:username", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const a = accounts.getByUsername(rc.params.username);
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    const self = !!rc.account && rc.account.id === a.id;
    rc.json(200, playerView(a, rc.account, self || isSiteAdmin(rc.account)));
  }));

  router.get("/api/presence/compete/me", auth.requireSession(async (req, res, rc) => {
    rc.json(200, playerView(rc.account, rc.account, true));
  }));

  router.get("/api/presence/compete/match/:id", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const m = q.match.get(Number.parseInt(rc.params.id, 10) || 0);
    if (!m) throw new HttpError(404, "not_found", "No such match.");
    const priv = community.privateCommunityOf(m.server);
    if (priv && !isMember(rc.account, priv)) throw new HttpError(404, "not_found", "No such match.");
    const admin = isSiteAdmin(rc.account);
    const scopes = m.scopes.split(" ").filter(Boolean);
    const players = q.players.all(m.id).map((p) => {
      const a = p.account_id ? accounts.getById(p.account_id) : null;
      const shown = a && (admin || (rc.account && rc.account.id === a.id) || privacyOf(a.id).where);
      const change = {};
      for (const k of scopes) {
        const d = p.account_id ? q.deltaOf.get(m.id, k, p.account_id) : null;
        change[kindOf(k)] = d ? d.delta : null;
      }
      return {
        name: a ? (shown ? a.username : "a hidden player") : "a deleted player", linked: !!shown,
        side: p.side, kills: p.kills, deaths: p.deaths, headshots: p.headshots, teamkills: p.teamkills,
        rounds: p.rounds, seconds: p.seconds, result: p.result, place: p.place, change,
      };
    });
    const cm = m.community_id ? q.communityById.get(m.community_id) : null;
    const mine = !!rc.account && q.player.get(m.id, rc.account.id);
    rc.json(200, {
      id: m.id, ladder: m.ladder, map: m.map, mode: m.mode, server: serverName(m.server), serverId: enrollment.serverIdFor(m.server),
      community: cm && (cm.visibility !== "private" || isMember(rc.account, cm)) ? { slug: cm.slug, name: cm.name } : null,
      scopes: scopes.map(kindOf), started: iso(m.started_at), ended: iso(m.ended_at), status: m.status, how: m.how,
      winner: m.winner, score: m.score1 === null ? null : [m.score1, m.score2], rounds: m.rounds, rated: m.rated === 1, why: m.why,
      kills: m.kills, unratedKills: m.unrated_kills,
      players,
      canDispute: !!mine && m.status === "over" && now() - (m.ended_at || m.started_at) <= c.disputeHours * 3600,
      canVoid: admin || (cm ? isStaff(rc.account, cm) && scopes.includes("c:" + cm.id) : false),
    });
  }));

  router.get("/api/presence/compete/servers", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const out = [];
    for (const r of q.serversList.all()) {
      const priv = community.privateCommunityOf(r.server);
      if (priv && !isMember(rc.account, priv)) continue;
      const link = q.linkedTo.get(r.server);
      const cm = link ? q.communityById.get(link.community_id) : null;
      const l = cm ? q.ladder.get(cm.id) : null;
      out.push({
        serverId: enrollment.serverIdFor(r.server), name: serverName(r.server), network: r.network === 1,
        community: cm ? { slug: cm.slug, name: cm.name, ladder: !!(l && l.ladder === 1), counts: r.ladder_community === cm.id } : null,
        lastMatch: iso(r.last || r.last_match),
      });
    }
    rc.json(200, { servers: out });
  }));

  // ---- staff and admins -----------------------------------------------------------------------------

  const staffRoute = (handler) => auth.requireSession(async (req, res, rc) => {
    own("staffPerAccount", String(rc.account.id));
    return handler(req, res, rc);
  });
  const record = (rc, action, subject, detail) => {
    if (audit) audit.record({ actor: rc.account, action, subject, detail: detail || null });
  };

  // NETWORK LADDER: an H9 site admin's, for one server at a time.
  router.post("/api/presence/compete/servers/:serverId", staffRoute(async (req, res, rc) => {
    if (!isSiteAdmin(rc.account)) throw new HttpError(403, "forbidden", "Only H9's site admins mark servers for the H9 ladder.");
    const row = enrollment.byServerId(rc.params.serverId);
    if (!row) throw new HttpError(404, "not_found", "No such server.");
    const body = await rc.body();
    if (typeof body.network !== "boolean") throw new HttpError(400, "bad_request", "network: true or false.");
    q.ensureServer.run(row.server);
    q.setNetwork.run(body.network ? 1 : 0, rc.account.id, now(), row.server);
    record(rc, "presence.server.compete", row.server, body.network ? "network ladder on" : "network ladder off");
    rc.json(200, { ok: true, serverId: row.server_id, network: body.network });
  }));

  function communityOrThrow(slug, account) {
    const cm = q.communityBySlug.get(String(slug || "").toLowerCase());
    if (!cm || !isStaff(account, cm)) throw new HttpError(cm ? 403 : 404, cm ? "forbidden" : "not_found", cm ? "Only this community's staff may do that." : "No such community.");
    return cm;
  }

  // LADDER: the community's staff turn its ladder on or off.
  router.post("/api/presence/compete/communities/:slug", staffRoute(async (req, res, rc) => {
    const cm = communityOrThrow(rc.params.slug, rc.account);
    const body = await rc.body();
    if (typeof body.ladder !== "boolean") throw new HttpError(400, "bad_request", "ladder: true or false.");
    q.setLadder.run(cm.id, body.ladder ? 1 : 0, rc.account.id, now());
    record(rc, "community.compete", cm.slug, body.ladder ? "ladder on" : "ladder off");
    rc.json(200, { ok: true, ladder: body.ladder });
  }));

  // COUNTS FOR THE LADDER: per linked server.
  router.post("/api/presence/compete/communities/:slug/servers/:serverId", staffRoute(async (req, res, rc) => {
    const cm = communityOrThrow(rc.params.slug, rc.account);
    const row = enrollment.byServerId(rc.params.serverId);
    const link = row ? q.linkedTo.get(row.server) : null;
    if (!row || !link || link.community_id !== cm.id) throw new HttpError(404, "not_found", "That server is not linked to this community.");
    const body = await rc.body();
    if (typeof body.counts !== "boolean") throw new HttpError(400, "bad_request", "counts: true or false.");
    q.ensureServer.run(row.server);
    q.setCounts.run(body.counts ? cm.id : null, row.server);
    record(rc, "community.server.compete", cm.slug + " " + row.server_id, body.counts ? "counts for the ladder" : "does not count");
    rc.json(200, { ok: true, counts: body.counts });
  }));

  // A void: an H9 site admin's in every scope, a community's staff only on their own ladder.
  router.post("/api/presence/compete/matches/:id/void", staffRoute(async (req, res, rc) => {
    const m = q.match.get(Number.parseInt(rc.params.id, 10) || 0);
    if (!m) throw new HttpError(404, "not_found", "No such match.");
    if (m.status === "voided") throw new HttpError(409, "voided", "That match is void already.");
    const body = await rc.body();
    const note = cleanText(body.note, 200);
    const admin = isSiteAdmin(rc.account);
    const cm = m.community_id ? q.communityById.get(m.community_id) : null;
    let only = null;
    if (!admin) {
      if (!cm || !isStaff(rc.account, cm) || !m.scopes.split(" ").includes("c:" + cm.id)) {
        throw new HttpError(403, "forbidden", "Only H9's site admins, or the staff of a community whose ladder it counts on, void a match.");
      }
      only = ["c:" + cm.id];
    }
    tx(() => voidMatch(m, only, rc.account, note, now()));
    record(rc, admin ? "presence.compete.void" : "community.compete.void", "match " + m.id, note || null);
    rc.json(200, { ok: true, match: m.id, status: q.match.get(m.id).status });
  }));

  // DISPUTE: a player of the match, within disputeHours of its end.
  router.post("/api/presence/compete/matches/:id/dispute", staffRoute(async (req, res, rc) => {
    own("disputePerAccount", String(rc.account.id));
    const m = q.match.get(Number.parseInt(rc.params.id, 10) || 0);
    if (!m || !q.player.get(m.id, rc.account.id)) throw new HttpError(404, "not_found", "No match of yours by that number.");
    if (m.status !== "over" || now() - (m.ended_at || m.started_at) > c.disputeHours * 3600) {
      throw new HttpError(409, "too_late", "A match can be disputed for " + c.disputeHours + " hours after it ends.");
    }
    if (q.openDispute.get(m.id, rc.account.id)) throw new HttpError(409, "disputed", "You have disputed this match already.");
    const body = await rc.body();
    const reason = cleanText(body.reason, 300);
    if (!reason) throw new HttpError(400, "bad_request", "Say what is wrong with it.");
    const id = Number(q.addDispute.run(m.id, rc.account.id, reason, now()).lastInsertRowid);
    log.info("presence.compete.dispute", { match: m.id, user: rc.account.username });
    rc.json(201, { ok: true, dispute: id });
  }));

  router.get("/api/presence/compete/disputes", auth.requireRole("admin", async (req, res, rc) => {
    const status = ["open", "resolved", "all"].includes(rc.query.get("status")) ? rc.query.get("status") : "open";
    rc.json(200, {
      disputes: q.disputes.all(status, status).map((d) => ({
        id: d.id, match: d.match_id, username: d.username || "a deleted player", reason: d.reason, at: iso(d.at),
        status: d.status, resolvedAt: iso(d.resolved_at), note: d.note,
      })),
    });
  }));

  router.post("/api/presence/compete/disputes/:id/resolve", auth.requireRole("admin", async (req, res, rc) => {
    const d = q.dispute.get(Number.parseInt(rc.params.id, 10) || 0);
    if (!d) throw new HttpError(404, "not_found", "No such dispute.");
    const body = await rc.body();
    const note = cleanText(body.note, 200) || null;
    q.resolveDispute.run(rc.account.id, now(), note, d.id);
    record(rc, "presence.compete.dispute.resolve", "match " + d.match_id, note);
    rc.json(200, { ok: true });
  }));

  // LEVELS: H9's site admins pick the rule and its tuning (the admin panel's LEVELS tab); every
  // account's level is worked out again at once.
  router.get("/api/presence/compete/levels", auth.requireRole("admin", async (req, res, rc) => {
    rc.json(200, { settings: levelConfig(), defaults: LEVEL_DEFAULTS, rules: ["elo", "career"] });
  }));

  router.post("/api/presence/compete/levels", auth.requireRole("admin", async (req, res, rc) => {
    const body = await rc.body();
    const { settings, problems } = levelSettings({ ...levelConfig(), ...body });
    if (problems.length) throw new HttpError(400, "bad_request", "Not a usable value: " + problems.join(", ") + ".");
    const t = now();
    tx(() => {
      for (const k of Object.keys(LEVEL_DEFAULTS)) q.cfgPut.run(k, String(settings[k]), rc.account.id, t);
    });
    const accounts = relevelAll(t);
    record(rc, "presence.compete.levels", "levels", "rule " + settings.rule);
    rc.json(200, { ok: true, settings, accounts });
  }));

  // ---- housekeeping ---------------------------------------------------------------------------------

  // A match nobody has heard of for abandonHours ends as abandoned (its kills stay counted); a
  // rating idle past decayAfterDays loses decayPerDay a day, once for each day, never below 0.
  function sweep(t = now()) {
    let abandoned = 0;
    let decayed = 0;
    tx(() => {
      for (const m of q.openBefore.all(t - c.abandonHours * 3600)) {
        closeMatch(m, "abandoned", t, "the server stopped reporting it");
        abandoned++;
      }
      const today = day(t);
      for (const r of q.idle.all(t - c.decayAfterDays * 86400)) {
        const first = day(r.last_at) + c.decayAfterDays;
        const from = r.decayed_at === null ? first : Math.max(first, r.decayed_at);
        const days = today - from;
        if (days <= 0) continue;
        q.decay.run(Math.max(0, r.elo - days * c.decayPerDay), today, r.scope, r.ladder, r.account_id);
        if (r.scope === "n" && r.ladder === "match") relevel(r.account_id, t);
        decayed++;
      }
      q.prunePairs.run(today - 2);
    });
    if (abandoned || decayed) log.info("presence.compete.sweep", { abandoned, decayed });
    return { abandoned, decayed };
  }

  let timer = null;
  function start() {
    try { relevelAll(); } catch (e) { log.error("presence.compete.levels", { error: e.message }); }
    try { sweep(); } catch (e) { log.error("presence.compete.sweep", { error: e.message }); }
    timer = setInterval(() => {
      try { sweep(); } catch (e) { log.error("presence.compete.sweep", { error: e.message }); }
    }, 600 * 1000);
    timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { settings: c, sweep, start, stop, scopesFor, provenNow, levelOf, levelsFor, relevelAll };
}
