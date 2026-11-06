// compete.js -- rated play on H9's servers: compts's Elo and its scoreboard, tied to havoc9.org
// accounts. docs\H9_COMPETITIVE.txt is the guide.
//
// A rated server runs h9_compete.amxx beside h9_presence. Its calls are signed like the
// community's (serverauth.js: the server's key, a time within clockSkewSeconds, a one-time nonce):
//   POST /api/presence/compete/start    a match begins: the map, the ladder, who is on which side
//   POST /api/presence/compete/kills    while it runs, numbered batches: who is there, the kills
//   POST /api/presence/compete/end      how it ended, and each player's side, rounds and time
//   POST /api/presence/compete/rating   the ratings told to everyone when a player joins
//   POST /api/presence/compete/rank     one account's rank, for a game's .rank (h9_rank.amxx)
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
// Scopes, fixed when a match starts; none at all on a server an H9 site admin marked UNRANKED, and
// no match at all on a roleplay map (the start answers 409 not_rated):
//   "s:<address>"  the server's own table
//   "c:<id>"       its community's ladder, when the community's staff turned the ladder on and
//                  ticked this server (COUNTS FOR THE LADDER)
//   "n"            the H9 ladder, for every server enrolled with havoc9.org
// Ladders: "match" (ts_matchmode's matches, results and kills) and "dm" (TS's own deathmatch
// maps: kills only, each map one match for the history).
//
// A void takes back exactly what a match gave and took in the scopes voided (compete_deltas);
// voiding the H9 ladder's takes back the career experience the match gave (compete_xp) too.
//
// Bots never count: a bot proves nothing, so a kill of one or by one is dropped before any stats or
// ratings (applyKill), the kills-to-deaths figure that career experience uses counts only those
// stats, and a match with bots on its sides, at its start or its end, has no rated result (its
// proven players still have the experience for playing it out, without a win's).
//
// Seasons: an H9 site admin's RESET (POST /api/presence/compete/season/reset, typed "RESET") copies
// the database into <dataDir>/backups first, archives every table's final standings as that
// season's (compete_season_standings), and starts the next season with nobody rated: no ratings.
// The career, the levels and their experience, is the account's over every season and stays. Each
// account's next rated kill or match starts a rating again from startElo. The matches stay, each
// with the season it was played in. SEASON 1 (POST .../season/restart, typed "SEASON 1", the
// database copied first too) sets the seasons back: the archived ones go with their standings, and
// the season under way becomes season 1 from when it started.
//
// Levels, Lv 0 to 99, one per account: the career's. Its experience (compete_xp, and the admins'
// adjustments, compete_adjustments) comes from play that counts for the H9 ladder, so from every
// mode on every enrolled server but not from roleplay maps or UNRANKED servers:
//   a kill   killXp to the killer of a proven player (not a team kill, not past the pair cap)
//   a match  to each proven player who plays it out (half its rounds or more, not leaving) in a
//            match that finished and lasted minSeconds, and on a deathmatch map to each one who
//            was there at its end and played minSeconds of it: (matchXp, and winXp for a result
//            rated on the H9 ladder and won) x their kills-to-deaths factor x their H9 ladder
//            rating / 1000, each factor kept within its admin-set bounds
// Lv = 1 + (experience / xpBase) ^ (1 / xpPower), rounded down, from 1 to 99; Lv 0 with none. Play
// only raises it (a void takes back the voided match's experience, and a season's reset keeps it).
// H9's site admins set the tuning (POST /api/presence/compete/levels, which answers with
// levelEstimate's road to Lv 99) and adjust an account's experience or a table's rating (POST
// .../accounts/:name/adjust). Each account's level is kept in compete_levels and worked out again
// whenever its experience or the settings change.
// Where it shows (publicLevel), for every account whatever its switches: the presence report's
// answer, per proven player ("levels", index.js), which h9_presence sends to every client as
// H9Level; the presence views, which the forum and the site draw as a badge, with eloOf, the H9
// ladder's MATCH rating, beside it as the ELO figure; the ladder; .rank. Lv 0 shows as Lv 0 unless
// the admins turn showZero off.
//
// Integrity, what the site holds a server to whatever its plugin says (docs\H9_COMPETITIVE.txt, "Integrity"). A server's plugin is
// code on a machine its operator controls, so nothing a plugin sends is believed beyond what the site can check on its own:
//   * rated play is asked again at every call that adds to a match, not only at its start: a server that stops being
//     authenticated mid-match (or is marked UNRANKED, or is a listen server) has the whole match voided, what it gave before too
//   * a listen server (Create Game) feeds no ladder and gives no experience unless listenRated is on: its plugin runs on a
//     player's own PC, where nothing can vouch for what it sends
//   * no match, and no player in it, makes more kills than a match or a hand can (matchKillsPerMinute, playerKillsPerMinute and
//     killBurst, counted from the match's start by the site's own clock); the excess is dropped and an audit entry made
//   * a match whose rounds ran faster than minRoundSeconds each is not rated, and a player's seconds never exceed the match's
//   * an account earns at most xpPerDayMax experience, and gains at most eloGainPerDayMax points on the H9 ladder, in a UTC day
//   * the oddities (a kill rate no hand makes, a void) go to the audit log, once an hour for each kind and server
// Every limit is a setting, and 0 turns one off.

import path from "node:path";
import { cleanMap, cleanText, roleplayMap } from "./modes.js";
import { backupDatabase } from "../../lib/db.js";

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
  // integrity (see the header): a listen server rated like any other (1) or not at all (0); the kills a whole match can make in a
  // minute, one player can, and the burst allowed on top of the rate; the shortest average round; the most experience and the most
  // H9 ladder points gained an account is given in a UTC day
  listenRated: 0,
  matchKillsPerMinute: 120,
  playerKillsPerMinute: 12,
  killBurst: 40,
  minRoundSeconds: 20,
  xpPerDayMax: 6000,
  eloGainPerDayMax: 1500,
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
  listenRated: [0, 1], matchKillsPerMinute: [0, 100000], playerKillsPerMinute: [0, 10000], killBurst: [0, 100000],
  minRoundSeconds: [0, 3600], xpPerDayMax: [0, 100000000], eloGainPerDayMax: [0, 100000000],
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
  showZero: true,
  matchXp: 100,
  winXp: 50,
  kdaMin: 0.5,
  kdaMax: 2,
  eloMultMin: 0.5,
  eloMultMax: 2,
  killXp: 1,
  xpBase: 20,
  xpPower: 2.3,
});

const LEVEL_RANGES = {
  matchXp: [0, 100000], winXp: [0, 100000],
  kdaMin: [0, 100], kdaMax: [0, 100], eloMultMin: [0, 100], eloMultMax: [0, 100],
  killXp: [0, 1000], xpBase: [1, 1000000], xpPower: [1, 5],
};

// A typical hour of active play, for the LEVELS tab's estimate (levelEstimate): this many matches
// or deathmatch maps, this share of them with a result rated on the H9 ladder, this share of those
// won, and this many kills between proven players, at a kills-to-deaths factor of 1 and a rating of
// 1000.
export const TYPICAL_HOUR = Object.freeze({ matches: 3, ratedShare: 0.5, winShare: 0.5, kills: 40 });
export const ESTIMATE_LEVELS = Object.freeze([10, 25, 50, 75, 99]);

// The career experience a level needs: xpBase x (level - 1) ^ xpPower, and at least 1 (Lv 1 is any
// experience at all).
export const xpForLevel = (cfg, level) => Math.max(1, Math.ceil(cfg.xpBase * Math.pow(Math.max(0, level - 1), cfg.xpPower)));

// Hours of the typical hour to reach each of ESTIMATE_LEVELS on the career rule, at these settings.
export function levelEstimate(cfg) {
  const h = TYPICAL_HOUR;
  const perMatch = cfg.matchXp + h.ratedShare * h.winShare * cfg.winXp;
  const xpPerHour = h.matches * perMatch + h.kills * cfg.killXp;
  return {
    typical: { ...h, xpPerHour: Math.round(xpPerHour) },
    levels: ESTIMATE_LEVELS.map((level) => {
      const xp = xpForLevel(cfg, level);
      return { level, xp, hours: xpPerHour > 0 ? Math.round(xp / xpPerHour) : null };
    }),
  };
}

// { settings, problems }: raw's values where they are good, the defaults elsewhere, and the names
// of the values that were not.
export function levelSettings(raw = {}) {
  const settings = { ...LEVEL_DEFAULTS };
  const problems = [];
  for (const k of Object.keys(LEVEL_DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    if (k === "showZero") {
      if (v === true || v === "true" || v === 1 || v === "1") settings.showZero = true;
      else if (v === false || v === "false" || v === 0 || v === "0") settings.showZero = false;
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

  // Rank data, the career level and the tables, shows for every account: SHOW MY PLAYTIME hides
  // playtime and presence only (docs\H9_PRESENCE.txt section 6).
  const VISIBLE = "1 = 1";
  const q = {
    online: db.prepare("SELECT plugin_at, relay, proven, held FROM presence_online WHERE account_id = ? AND server = ?"),
    server: db.prepare("SELECT * FROM compete_servers WHERE server = ?"),
    ensureServer: db.prepare("INSERT OR IGNORE INTO compete_servers (server) VALUES (?)"),
    setUnranked: db.prepare("UPDATE compete_servers SET unranked = ?, unranked_by = ?, unranked_at = ? WHERE server = ?"),
    serverMatches: db.prepare("SELECT * FROM compete_matches WHERE server = ? AND started_at >= ? AND started_at <= ? AND status <> 'voided' ORDER BY id"),
    enrolledList: db.prepare(`SELECT e.server, e.server_id, e.approved, e.blocked, cs.unranked, cs.unranked_at,
      (SELECT MAX(started_at) FROM compete_matches m WHERE m.server = e.server) AS last
      FROM presence_enrolled e LEFT JOIN compete_servers cs ON cs.server = e.server
      WHERE e.blocked = 0 ORDER BY (last IS NULL), last DESC, e.created_at DESC LIMIT 500`),
    adjustPut: db.prepare(`INSERT INTO compete_adjustments (account_id, field, scope, ladder, before, after, note, by_id, at, season)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    adjustsOf: db.prepare(`SELECT ad.*, a.username AS by_name FROM compete_adjustments ad LEFT JOIN accounts a ON a.id = ad.by_id
      WHERE ad.account_id = ? ORDER BY ad.at DESC, ad.id DESC LIMIT 50`),
    setElo: db.prepare("UPDATE compete_ratings SET elo = ?, decayed_at = NULL WHERE scope = ? AND ladder = ? AND account_id = ?"),
    standingsDropAll: db.prepare("DELETE FROM compete_season_standings"),
    seasonsDropAll: db.prepare("DELETE FROM compete_seasons"),
    seasonOne: db.prepare("INSERT INTO compete_seasons (id, started_at) VALUES (1, ?)"),
    matchesSeasonOne: db.prepare("UPDATE compete_matches SET season = 1"),
    adjustmentsSeasonOne: db.prepare("UPDATE compete_adjustments SET season = 1"),
    setCounts: db.prepare("UPDATE compete_servers SET ladder_community = ? WHERE server = ?"),
    touchServer: db.prepare("UPDATE compete_servers SET last_match = ? WHERE server = ?"),
    ladder: db.prepare("SELECT ladder FROM compete_communities WHERE community_id = ?"),
    setLadder: db.prepare("INSERT INTO compete_communities (community_id, ladder, set_by, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(community_id) DO UPDATE SET ladder = excluded.ladder, set_by = excluded.set_by, set_at = excluded.set_at"),
    communityBySlug: db.prepare("SELECT * FROM presence_communities WHERE slug = ?"),
    communityById: db.prepare("SELECT * FROM presence_communities WHERE id = ?"),
    isStaff: db.prepare("SELECT 1 AS x FROM presence_community_staff WHERE community_id = ? AND account_id = ?"),
    isMember: db.prepare("SELECT 1 AS x FROM presence_community_members WHERE community_id = ? AND account_id = ?"),
    linkedTo: db.prepare("SELECT community_id FROM presence_community_servers WHERE server = ?"),
    insertMatch: db.prepare(`INSERT INTO compete_matches (server, community_id, scopes, ladder, map, mode, started_at, last_at, humans, bots, season)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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
    playerAssists: db.prepare("UPDATE compete_players SET assists = ? WHERE match_id = ? AND account_id = ?"),
    rateAssists: db.prepare("UPDATE compete_ratings SET assists = COALESCE(assists, 0) + ? WHERE scope = ? AND ladder = ? AND account_id = ?"),
    deltaAssists: db.prepare(`INSERT INTO compete_deltas (match_id, scope, account_id, delta, kills, deaths, headshots, wins, losses, matches, assists)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?) ON CONFLICT(match_id, scope, account_id) DO UPDATE SET assists = assists + excluded.assists`),
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
      headshots = MAX(0, headshots - ?), wins = MAX(0, wins - ?), losses = MAX(0, losses - ?), matches = MAX(0, matches - ?),
      assists = CASE WHEN assists IS NULL THEN NULL ELSE MAX(0, assists - ?) END
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
    matchesOf: db.prepare(`SELECT m.*, p.side, p.kills AS p_kills, p.deaths AS p_deaths, p.headshots AS p_headshots, p.assists AS p_assists, p.result AS p_result, p.place AS p_place
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
    xpAdd: db.prepare(`INSERT INTO compete_xp (match_id, account_id, xp) VALUES (?, ?, ?)
      ON CONFLICT(match_id, account_id) DO UPDATE SET xp = xp + excluded.xp`),
    xpPlayed: db.prepare(`SELECT COALESCE(SUM(x.xp), 0) AS xp FROM compete_xp x JOIN compete_matches m ON m.id = x.match_id
      WHERE x.account_id = ? AND m.status <> 'voided'`),
    xpAdjusted: db.prepare("SELECT COALESCE(SUM(after - before), 0) AS xp FROM compete_adjustments WHERE account_id = ? AND field = 'xp'"),
    xpOfMatch: db.prepare("SELECT account_id FROM compete_xp WHERE match_id = ?"),
    xpDrop: db.prepare("DELETE FROM compete_xp WHERE match_id = ?"),
    // what an account has been given since a UTC day began, for the daily limits: experience, and points gained on the H9 ladder
    xpToday: db.prepare(`SELECT COALESCE(SUM(x.xp), 0) AS n FROM compete_xp x JOIN compete_matches m ON m.id = x.match_id
      WHERE x.account_id = ? AND m.status <> 'voided' AND m.started_at >= ?`),
    eloToday: db.prepare(`SELECT COALESCE(SUM(CASE WHEN d.delta > 0 THEN d.delta ELSE 0 END), 0) AS n FROM compete_deltas d
      JOIN compete_matches m ON m.id = d.match_id WHERE d.account_id = ? AND d.scope = 'n' AND m.status <> 'voided' AND m.started_at >= ?`),
    levelPut: db.prepare(`INSERT INTO compete_levels (account_id, level, xp, rule, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET level = excluded.level, xp = excluded.xp, rule = excluded.rule, updated_at = excluded.updated_at`),
    levelGet: db.prepare("SELECT level, xp, rule FROM compete_levels WHERE account_id = ?"),
    levelAccounts: db.prepare(`SELECT account_id FROM compete_ratings WHERE scope = 'n' AND ladder = 'match' UNION SELECT account_id FROM compete_levels
      UNION SELECT account_id FROM compete_xp UNION SELECT account_id FROM compete_adjustments WHERE field = 'xp'`),
    seasonNow: db.prepare("SELECT * FROM compete_seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1"),
    seasonById: db.prepare("SELECT * FROM compete_seasons WHERE id = ?"),
    seasonsPast: db.prepare("SELECT * FROM compete_seasons WHERE ended_at IS NOT NULL ORDER BY id DESC"),
    seasonFirst: db.prepare("INSERT OR IGNORE INTO compete_seasons (id, started_at) VALUES (1, ?)"),
    seasonEnd: db.prepare("UPDATE compete_seasons SET ended_at = ?, ended_by = ?, backup = ? WHERE id = ?"),
    seasonNew: db.prepare("INSERT INTO compete_seasons (id, started_at) VALUES (?, ?)"),
    archive: db.prepare(`INSERT INTO compete_season_standings (season_id, scope, ladder, rank, account_id, elo, kills, deaths, headshots, wins, losses, matches, level, assists)
      SELECT ?, r.scope, r.ladder, ROW_NUMBER() OVER (PARTITION BY r.scope, r.ladder ORDER BY r.elo DESC, r.kills DESC, r.account_id ASC),
        r.account_id, r.elo, r.kills, r.deaths, r.headshots, r.wins, r.losses, r.matches, COALESCE(lv.level, 0), r.assists
      FROM compete_ratings r LEFT JOIN compete_levels lv ON lv.account_id = r.account_id`),
    pastBoard: db.prepare(`SELECT st.*, a.username FROM compete_season_standings st LEFT JOIN accounts a ON a.id = st.account_id
      LEFT JOIN presence_settings ps ON ps.account_id = st.account_id
      WHERE st.season_id = ? AND st.scope = ? AND st.ladder = ? AND (st.account_id IS NULL OR ${VISIBLE}) ORDER BY st.rank LIMIT ? OFFSET ?`),
    pastCount: db.prepare(`SELECT COUNT(*) AS n FROM compete_season_standings st LEFT JOIN presence_settings ps ON ps.account_id = st.account_id
      WHERE st.season_id = ? AND st.scope = ? AND st.ladder = ? AND (st.account_id IS NULL OR ${VISIBLE})`),
    clearRatings: db.prepare("DELETE FROM compete_ratings"),
    clearDeltas: db.prepare("DELETE FROM compete_deltas"),
    clearLevels: db.prepare("DELETE FROM compete_levels"),
    clearPairs: db.prepare("DELETE FROM compete_pairs"),
  };

  // The season under way (season 1 until the first reset).
  function currentSeason() {
    let s = q.seasonNow.get();
    if (!s) {
      q.seasonFirst.run(now());
      s = q.seasonNow.get() || q.seasonById.get(1);
    }
    return s;
  }
  const seasonView = (s) => ({ number: s.id, started: iso(s.started_at), ended: iso(s.ended_at) });

  const day = (t) => Math.floor(t / 86400);
  const isSiteAdmin = (account) => !!account && auth.roleAtLeast(account, "admin");
  const isStaff = (account, cm) => !!account && (cm.owner_id === account.id || isSiteAdmin(account) || !!q.isStaff.get(cm.id, account.id));
  const isMember = (account, cm) => !!account && (isStaff(account, cm) || !!q.isMember.get(cm.id, account.id));

  // In game on this server, verified and counted, as presence keeps it (index.js, counts()).
  function provenNow(server, accountId) {
    const r = q.online.get(accountId, server);
    return !!r && (r.plugin_at !== null || r.relay === 1) && (r.proven === 1 || r.relay === 1) && r.held === 0;
  }

  // The scopes a match on this server counts in, from the flags as they are now: its own table, its
  // community's ladder where the staff count it, and the H9 ladder; none at all on a server an H9
  // site admin marked UNRANKED.
  function scopesFor(server) {
    const sv = q.server.get(server);
    const link = q.linkedTo.get(server);
    const communityId = link ? link.community_id : null;
    if (sv && sv.unranked === 1) return { keys: [], communityId };
    const keys = ["s:" + server];
    if (communityId && sv && sv.ladder_community === communityId) {
      const l = q.ladder.get(communityId);
      if (l && l.ladder === 1) keys.push("c:" + communityId);
    }
    keys.push("n");
    return { keys, communityId };
  }

  const unrankedServer = (server) => {
    const sv = q.server.get(server);
    return !!sv && sv.unranked === 1;
  };

  // ---- integrity: what the site holds a server to, whatever its plugin says ------------------------

  // Why rated play does not count on this server now, or null when it does. Asked when a match starts and again by every call
  // that adds to it, so a server that stops being rated under a match loses the match, not only its next one.
  function ratedWhy(server, map) {
    if (roleplayMap(map)) return "Roleplay maps are not rated.";
    if (unrankedServer(server)) return "This server is UNRANKED on havoc9.org: its matches are not rated.";
    // not authenticated (preset.js): it runs something beside H9's official preset, has not listed what it runs, or its operator
    // set h9_authenticated 0
    if (deps.authentic && !deps.authentic(server)) {
      return "This server is not authenticated (it does not run H9's official preset, or its operator set h9_authenticated 0): its matches are not rated.";
    }
    // a listen server's plugin runs on a player's own PC: nothing there vouches for what it sends
    if (!c.listenRated && enrollment.isListen(server)) {
      return "A listen server (Create Game) is not rated: its plugin runs on a player's own PC, where nothing can vouch for what it sends.";
    }
    return null;
  }

  // An oddity is logged, and written to the audit log for an admin to read, once an hour for each kind and server. It blocks
  // nothing itself.
  const oddities = new Map();
  function oddity(kind, server, subject, detail, t) {
    const key = kind + "|" + server;
    if (oddities.size > 1000) oddities.clear();
    if (oddities.has(key) && t - oddities.get(key) < 3600) return;
    oddities.set(key, t);
    log.warn("presence.compete." + kind, { server, subject, detail });
    if (audit) audit.record({ actorName: "(compete)", action: "presence.compete." + kind, targetName: server, subject, detail });
  }

  // A match that was rated when it began and is not now is taken back whole and closed: what it gave before is no more trusted
  // than what it would give next.
  function dropMatch(m, why, t) {
    tx(() => voidMatch(m, null, null, why, t));
    if (audit) audit.record({ actorName: "(compete)", action: "presence.compete.void", targetName: m.server, subject: "match " + m.id, detail: why });
    log.warn("presence.compete.void", { server: m.server, match: m.id, why });
  }

  // The most kills a match, or a player in it, can have made t seconds in: the burst, and the rate for each minute since it began.
  const killsAllowed = (m, t, rate) => c.killBurst + Math.floor((rate * Math.max(0, t - m.started_at)) / 60);

  // What an account may still be given today (UTC), of experience and of H9 ladder points; Infinity with the limit off.
  const dayStart = (t) => day(t) * 86400;
  const xpRoom = (acct, t) => (c.xpPerDayMax > 0 ? Math.max(0, c.xpPerDayMax - q.xpToday.get(acct, dayStart(t)).n) : Infinity);
  const eloRoom = (acct, t) => (c.eloGainPerDayMax > 0 ? Math.max(0, c.eloGainPerDayMax - q.eloToday.get(acct, dayStart(t)).n) : Infinity);

  // Experience into a match, as far as the account's day allows.
  function giveXp(matchId, acct, xp, t, server) {
    const room = xpRoom(acct, t);
    const give = Math.min(xp, room);
    if (give < xp && server) oddity("capped", server, "account " + acct, "an account reached its day's experience limit (xpPerDayMax " + c.xpPerDayMax + ")", t);
    if (give > 0) q.xpAdd.run(matchId, acct, give);
  }

  function rating(scope, ladder, accountId, t) {
    q.ensureRating.run(scope, ladder, accountId, c.startElo, t);
    return q.rating.get(scope, ladder, accountId);
  }

  // ---- levels -------------------------------------------------------------------------------------

  // the settings as stored, read once and again after each change
  let cfgCache = null;
  function levelConfig() {
    if (cfgCache) return cfgCache;
    const raw = {};
    for (const r of q.cfgAll.all()) raw[r.key] = r.value;
    cfgCache = levelSettings(raw).settings;
    return cfgCache;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // The level is the career's: Lv 1 + (xp / xpBase) ^ (1 / xpPower), rounded down, from 1 to 99;
  // Lv 0 with no experience at all. The ELO rating is the skill figure beside it, never the level.
  function levelFrom(cfg, xp) {
    return xp > 0 ? clamp(1 + Math.floor(Math.pow(xp / cfg.xpBase, 1 / cfg.xpPower) + 1e-9), 1, 99) : 0;
  }

  // An account's career experience: every match's (kills and its end) that is not voided, and the
  // admins' adjustments; never below 0.
  const careerXp = (accountId) => Math.max(0, q.xpPlayed.get(accountId).xp + q.xpAdjusted.get(accountId).xp);

  // Works an account's level out again and keeps it.
  function relevel(accountId, t = now(), cfg = levelConfig()) {
    const xp = careerXp(accountId);
    const level = levelFrom(cfg, xp);
    q.levelPut.run(accountId, level, xp, "career", t);
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

  // The level shown, to everyone and in game: Lv 0 too unless the admins turn showZero off (then
  // null). No privacy switch hides it.
  function publicLevel(accountId) {
    const level = levelOf(accountId);
    if (level === 0 && !levelConfig().showZero) return null;
    return level;
  }

  // The H9 ladder's MATCH rating, the ELO figure beside the badge (null with no rating there yet).
  function eloOf(accountId) {
    const r = q.rating.get("n", "match", accountId);
    return r ? r.elo : null;
  }

  // ---- an account's rank: the RANK block and .rank -------------------------------------------------

  // Kills per death, to two places; a player with no deaths has their kills.
  const kdOf = (kills, deaths) => (deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills);

  // One rating row as the rank readouts show it: the rating, the place among the players the table
  // shows, and this season's numbers there; assists null until a server that counts them reports a
  // match there.
  function ladderLine(r, accountId) {
    return {
      elo: r.elo, place: q.above.get(r.scope, r.ladder, r.elo, accountId).n + 1,
      matches: r.matches, wins: r.wins, losses: r.losses,
      kills: r.kills, deaths: r.deaths, headshots: r.headshots, assists: r.assists === undefined ? null : r.assists, kd: kdOf(r.kills, r.deaths),
    };
  }

  // The RANK block of the ACCOUNT page and the forum profile (presence.js, renderRank), the same for
  // everyone: the career level and its experience, and this season's standing on the H9 ladder's
  // MATCH table (h9, ladderLine's; null with no rating there yet). rule is always "career".
  function rankOf(accountId) {
    const r = q.rating.get("n", "match", accountId);
    return {
      season: seasonView(currentSeason()),
      level: publicLevel(accountId),
      rule: "career",
      xp: careerXp(accountId),
      h9: r ? ladderLine(r, accountId) : null,
    };
  }

  // One account's whole rank, for GET /api/presence/compete/rank/:username and a game's .rank, the
  // same for everyone: the career level and its experience, the H9 ladder's MATCH rating (elo), this
  // season, and each table the viewer may see (onlyScopes: just those keys, as a game's readout
  // has them; a private community's only to its members).
  function rankView(account, { viewer = null, onlyScopes = null } = {}) {
    const ladders = [];
    for (const r of q.ratingsOf.all(account.id)) {
      if (onlyScopes && !onlyScopes.includes(r.scope)) continue;
      const sv = scopeView(r.scope, viewer);
      if (!sv) continue;
      ladders.push({ ...sv, ladder: r.ladder, ...ladderLine(r, account.id) });
    }
    // the H9 ladder first, then servers' tables, then communities'; MATCH before DM in each
    const order = { network: 0, server: 1, community: 2 };
    ladders.sort((a, b) => order[a.kind] - order[b.kind] || (a.ladder === b.ladder ? 0 : a.ladder === "match" ? -1 : 1) || String(a.name).localeCompare(String(b.name)));
    return {
      username: account.username, private: false,
      level: publicLevel(account.id), rule: "career", xp: careerXp(account.id), elo: eloOf(account.id),
      season: seasonView(currentSeason()), ladders,
    };
  }

  // The report answer's "levels": { "<slot>": level } for each proven player (index.js). A slot not
  // named shows no level: no havoc9.org account, a game that did not prove the player id, a bot,
  // Lv 0 with showZero off.
  function levelsFor(slots) {
    const out = {};
    for (const e of slots) {
      if (!e.slot || !e.accountId || !e.proven) continue;
      const lv = publicLevel(e.accountId);
      if (lv !== null) out[e.slot] = lv;
    }
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

  // [h9_clientid, side, rounds, seconds, left, assists]: assists a whole number, or null (or left
  // out) from a server that counts none
  function readEnd(list) {
    if (!Array.isArray(list) || list.length > c.maxPlayers * 2) throw new HttpError(400, "bad_request", "players: at most " + c.maxPlayers * 2 + " entries.");
    return list.map((e) => {
      if (!Array.isArray(e) || !CLIENT_ID.test(String(e[0]))) throw new HttpError(400, "bad_request", "players: [h9_clientid, side, rounds, seconds, left, assists] entries.");
      return {
        id: e[0], side: e[1] === 1 || e[1] === 2 ? e[1] : 0, rounds: whole(e[2], 1000), seconds: whole(e[3], 86400 * 7), left: e[4] === 1,
        assists: Number.isSafeInteger(e[5]) && e[5] >= 0 ? Math.min(e[5], 10000) : null,
      };
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
    // No hand scores faster than playerKillsPerMinute in one match: the rest are not counted at all.
    if (c.playerKillsPerMinute > 0 && q.player.get(m.id, ka).kills >= killsAllowed(m, t, c.playerKillsPerMinute)) {
      oddity("kill_rate", server, "match " + m.id, "an account made more kills in this match than a player can (" + c.playerKillsPerMinute + " a minute): the rest are not counted", t);
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
      // on the H9 ladder what an account gains in a day has a limit; the kill itself still counts
      const gained = scope === "n" ? Math.min(gain, eloRoom(ka, t)) : gain;
      q.rateKill.run(gained, 1, hs ? 1 : 0, 0, t, scope, m.ladder, ka);
      q.rateKill.run(-loss, 0, 0, 1, t, scope, m.ladder, va);
      q.delta.run(m.id, scope, ka, gained, 1, 0, hs ? 1 : 0, 0, 0, 0);
      q.delta.run(m.id, scope, va, -loss, 0, 1, 0, 0, 0, 0);
      if (scope === "n" && touched) {
        touched.add(ka);
        touched.add(va);
      }
    }
    const cfg = levelConfig();
    if (cfg.killXp > 0 && m.scopes.split(" ").includes("n")) {
      giveXp(m.id, ka, cfg.killXp, t, server);
      if (touched) touched.add(ka);
    }
    return true;
  }

  // The H9 ladder's rating a player's experience is weighed by: their table for this ladder, the
  // start rating before they have one.
  const ratingFor = (acct, ladder) => (q.rating.get("n", ladder, acct) || { elo: c.startElo }).elo;

  // A player's assists in a match, as its end report counts them: theirs in the match, and summed
  // like kills into each of the match's tables (a table row made for them when they have some), with
  // the match's share kept for a void.
  function addAssists(m, acct, n, t) {
    q.playerAssists.run(n, m.id, acct);
    for (const scope of m.scopes.split(" ").filter(Boolean)) {
      if (n > 0) rating(scope, m.ladder, acct, t);
      q.rateAssists.run(n, scope, m.ladder, acct);
      if (n > 0) q.deltaAssists.run(m.id, scope, acct, n);
    }
  }

  // The end of a match: the result for the history, and on the MATCH ladder its points where the
  // match rules hold. Returns { rated, why }.
  function finish(m, server, index, { how, winner, score1, score2, rounds, oneRound, players, others, bots }, t) {
    const sides = { 1: { proven: [], unproven: others[1] }, 2: { proven: [], unproven: others[2] } };
    // the assists go in once the match's results have made their table rows
    const assisted = [];
    const assistsIn = () => { for (const [acct, n] of assisted) addAssists(m, acct, n, t); };
    const ended = []; // every proven player the end names: { acct, seconds, left }
    const cfg = levelConfig();
    // the career's experience at the end: only where the match counts for the H9 ladder, only for
    // a match that finished and lasted minSeconds
    const xpHere = m.scopes.split(" ").includes("n") && how !== "cancelled" && t - m.started_at >= c.minSeconds;
    // no player was in a match longer than it ran
    const secondsCap = Math.max(0, t - m.started_at) + 60;
    for (const p of players) {
      const acct = index.get(p.id);
      const known = acct ? (provenNow(server, acct) ? see(m, server, acct, p.side) : !!q.player.get(m.id, acct)) : false;
      if (!known) {
        if (p.side) sides[p.side].unproven++;
        continue;
      }
      const seconds = Math.min(p.seconds, secondsCap);
      q.endPlayer.run(p.side, p.side, p.rounds, seconds, p.left ? 1 : 0, m.id, acct);
      if (p.assists !== null) assisted.push([acct, p.assists]);
      if (p.side) sides[p.side].proven.push({ acct, rounds: p.rounds, left: p.left });
      ended.push({ acct, seconds, left: p.left });
    }

    if (m.ladder === "dm") {
      const rows = q.players.all(m.id).sort((a, b) => b.kills - b.deaths - (a.kills - a.deaths) || b.kills - a.kills || a.id - b.id);
      rows.forEach((r, i) => q.place.run(i + 1, r.id));
      assistsIn();
      // a deathmatch map's experience: each proven player there at its end who played minSeconds
      // of it, as a match gives, with no win in it
      if (xpHere) {
        for (const e of ended) {
          if (e.left || e.seconds < c.minSeconds) continue;
          giveXp(m.id, e.acct, matchXp(cfg, q.player.get(m.id, e.acct), false, ratingFor(e.acct, "dm")), t, server);
        }
      }
      for (const e of ended) relevel(e.acct, t, cfg);
      q.finish.run(how, 0, null, null, null, 0, "deathmatch: kills only", t, t, bots, m.id);
      return { rated: false, why: "deathmatch: kills only" };
    }

    let why = null;
    if (how === "cancelled") why = "the match was cancelled";
    else if (!winner) why = "the match had no winner";
    else if (Math.max(bots, m.bots || 0) > 0) why = "bots played"; // at the start or at the end
    else if (rounds < (oneRound ? 1 : c.minRounds)) why = oneRound ? "no round was played" : "fewer than " + c.minRounds + " rounds"; // a mode that plays one round (Assault, Capture the Flag) is rated on that round and the minimum time
    else if (t - m.started_at < c.minSeconds) why = "shorter than " + Math.ceil(c.minSeconds / 60) + " minutes";
    else if (c.minRoundSeconds > 0 && rounds > 0 && (t - m.started_at) / rounds < c.minRoundSeconds) why = "its rounds ran faster than a round can be played";

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
    let ratedN = false;
    const refusals = [];
    for (const scope of m.scopes.split(" ").filter(Boolean)) {
      let no = why;
      if (!no) {
        const n1 = sides[1].proven.filter(counts).length;
        const n2 = sides[2].proven.filter(counts).length;
        if (scope === "n") {
          if (n1 < c.networkMinPerSide || n2 < c.networkMinPerSide) no = "the H9 ladder needs " + c.networkMinPerSide + " proven players a side";
        } else if (n1 < 1 || n2 < 1) {
          no = "each side needs a proven player";
        }
      }
      if (no) {
        refusals.push(kindOf(scope) + ": " + no);
        continue;
      }
      rated = true;
      if (scope === "n") ratedN = true;
      for (const s of [1, 2]) {
        for (const p of sides[s].proven) {
          if (!counts(p)) continue;
          const won = !p.left && s === winner;
          const now0 = rating(scope, m.ladder, p.acct, t);
          const pts = won ? (scope === "n" ? Math.min(c.winPoints, eloRoom(p.acct, t)) : c.winPoints) : -Math.min(now0.elo, c.lossPoints);
          q.rateResult.run(pts, won ? 1 : 0, won ? 0 : 1, t, scope, m.ladder, p.acct);
          q.delta.run(m.id, scope, p.acct, pts, 0, 0, 0, won ? 1 : 0, won ? 0 : 1, 1);
        }
      }
    }
    assistsIn();
    // the match's experience: each proven player who played it out (half its rounds, not left),
    // rated or not; the win's share only for a result rated on the H9 ladder
    if (xpHere) {
      for (const s of [1, 2]) {
        for (const p of sides[s].proven) {
          if (p.left || !counts(p)) continue;
          const won = ratedN && s === winner;
          giveXp(m.id, p.acct, matchXp(cfg, q.player.get(m.id, p.acct), won, ratingFor(p.acct, m.ladder)), t, server);
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
      q.unrate.run(d.delta, d.kills, d.deaths, d.headshots, d.wins, d.losses, d.matches, d.assists || 0, d.scope, m.ladder, d.account_id);
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
    const notRated = ratedWhy(server, body.map);
    if (notRated) throw new HttpError(409, "not_rated", notRated);
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
        t, t, whole(body.humans, 1000), whole(body.bots, 1000), currentSeason().id).lastInsertRowid);
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
    const notRated = ratedWhy(server, m.map);
    if (notRated) {
      dropMatch(m, notRated, now());
      throw new HttpError(409, "not_rated", notRated + " The match is voided.");
    }
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
    // no match makes more kills than matchKillsPerMinute (and the burst) allow by now: past that the batch is not heard
    const room = c.matchKillsPerMinute > 0 ? Math.max(0, killsAllowed(m, t, c.matchKillsPerMinute) - m.kills - m.unrated_kills) : kills.length;
    const heard = room < kills.length ? kills.slice(0, room) : kills;
    if (heard.length < kills.length) {
      oddity("kill_rate", server, "match " + m.id, (kills.length - heard.length) + " kills of a batch are more than a match can have made by now (" + c.matchKillsPerMinute + " a minute): they are not counted", t);
    }
    tx(() => {
      for (const [cid, side] of roster) {
        const acct = index.get(cid);
        if (acct) see(m, server, acct, side);
      }
      for (const k of heard) {
        if (applyKill(m, server, index, k, t, touched)) counted++;
        else unrated++;
      }
      unrated += kills.length - heard.length;
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
    const notRated = ratedWhy(server, m.map);
    if (notRated) {
      dropMatch(m, notRated, now());
      throw new HttpError(409, "not_rated", notRated + " The match is voided.");
    }
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
        rounds: whole(r.rounds, 1000), oneRound: r.oneRound === 1 || r.oneRound === true, players, others: { 1: whole(o["1"], 1000), 2: whole(o["2"], 1000) }, bots: whole(body.bots, 1000),
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
        public: true,
        server: standing("s:" + server, ladder, acct),
        network: standing("n", ladder, acct),
      };
    }
    rc.json(200, { ok: true, ladder, players: out });
  }, { csrf: false });

  // A game's .rank (h9_rank.sma): { asker, id } for a player on this server, by h9_clientid, or
  // { asker, name } for an account by its username. account is rankView's for this server's tables
  // and the H9 ladder, or null: an id that is no account proven here ("not signed in"), or a name
  // that is no account (unknown). The asker is who typed it, proven on this server or none: a
  // private community's server table shows in the answer only to a member of that community.
  router.post("/api/presence/compete/rank", async (req, res, rc) => {
    const { server, body } = await signed(req, rc, 2048);
    const index = clientIdIndex(server);
    const askerId = CLIENT_ID.test(String(body.asker || "")) ? index.get(String(body.asker)) : null;
    const asker = askerId && provenNow(server, askerId) ? accounts.getById(askerId) : null;
    let target = null;
    if (body.id !== undefined && body.id !== null) {
      if (!CLIENT_ID.test(String(body.id))) throw new HttpError(400, "bad_request", "id: an h9_clientid.");
      const acct = index.get(String(body.id));
      if (acct && provenNow(server, acct)) target = accounts.getById(acct);
      if (!target) {
        rc.json(200, { ok: true, account: null });
        return;
      }
    } else if (typeof body.name === "string" && body.name.trim() && body.name.length <= 64) {
      target = accounts.getByUsername(body.name.trim());
      if (!target) {
        rc.json(200, { ok: true, account: null, unknown: true });
        return;
      }
    } else {
      throw new HttpError(400, "bad_request", "Give id (an h9_clientid) or name (a username, at most 64 characters).");
    }
    rc.json(200, { ok: true, account: rankView(target, { viewer: asker, onlyScopes: ["n", "s:" + server] }) });
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
    if (v === "network" || v === "n") return { key: "n", kind: "network", name: "H9 ladder", isPublic: true, manage: isSiteAdmin(viewer) ? { disputes: true } : null };
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
      return { key: "s:" + row.server, kind: "server", name: serverName(row.server), serverId: row.server_id, unranked: !!(sv && sv.unranked === 1), isPublic: !priv, manage: isSiteAdmin(viewer) ? { unranked: true } : null };
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
    rank, username: r.username, level: r.level ? r.level : levelConfig().showZero ? 0 : null, elo: r.elo, kills: r.kills, deaths: r.deaths, headshots: r.headshots,
    assists: r.assists === undefined ? null : r.assists,
    wins: r.wins, losses: r.losses, matches: r.matches, lastPlayed: iso(r.last_at),
  });

  // A table, this season's or (season=N) an archived one's final standings.
  router.get("/api/presence/compete/board", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const sc = scopeFor(rc.query.get("scope"), rc.account);
    const ladder = ladderOf(rc.query.get("ladder"));
    const page = Math.max(1, Math.min(100000, Number.parseInt(rc.query.get("page") || "1", 10) || 1));
    const cur = currentSeason();
    const asked = Number.parseInt(rc.query.get("season") || "0", 10) || 0;
    const season = asked && asked !== cur.id ? q.seasonById.get(asked) : cur;
    if (!season) throw new HttpError(404, "not_found", "No such season.");
    let total;
    let players;
    if (season.id === cur.id) {
      total = q.boardCount.get(sc.key, ladder).n;
      players = q.board.all(sc.key, ladder, c.pageSize, (page - 1) * c.pageSize).map((r, i) => line(r, (page - 1) * c.pageSize + i + 1));
    } else {
      total = q.pastCount.get(season.id, sc.key, ladder).n;
      players = q.pastBoard.all(season.id, sc.key, ladder, c.pageSize, (page - 1) * c.pageSize).map((r, i) => ({
        ...line({ ...r, username: r.username || "a deleted player", last_at: null, level: r.level }, (page - 1) * c.pageSize + i + 1),
        deleted: !r.username,
      }));
    }
    const { key, isPublic, ...shown } = sc;
    rc.json(200, {
      scope: shown, ladder, page, pages: Math.max(1, Math.ceil(total / c.pageSize)), total, players,
      season: seasonView(season), currentSeason: cur.id,
    }, isPublic && !sc.manage ? publicHeaders() : undefined);
  }));

  router.get("/api/presence/compete/seasons", async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    rc.json(200, { current: seasonView(currentSeason()), past: q.seasonsPast.all().map(seasonView) }, publicHeaders());
  });

  // The ladder's player page: the level and every table it may show to this viewer, whatever the
  // account's switches; its matches (where and when it played) only while SHOW WHICH SERVER AND MAP
  // and SHOW WHEN I WAS LAST SEEN let others see them (everything: the account itself, a site admin).
  function playerView(account, viewer, everything) {
    const priv = everything ? { playtime: true, where: true, lastSeen: true } : privacyOf(account.id);
    const out = { username: account.username, level: publicLevel(account.id), elo: eloOf(account.id), ratings: [], matches: null };
    for (const r of q.ratingsOf.all(account.id)) {
      const sv = scopeView(r.scope, viewer);
      if (!sv) continue;
      out.ratings.push({ ...sv, ladder: r.ladder, ...line({ ...r, username: account.username }, q.above.get(r.scope, r.ladder, r.elo, account.id).n + 1) });
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
          kills: m.p_kills, deaths: m.p_deaths, headshots: m.p_headshots, assists: m.p_assists, change: d ? d.delta : null,
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

  // One account's rank (rankView), read-only, the same for everyone but for a private community's
  // tables, which only its members see: so only an answer to a reader who is not signed in is cached.
  router.get("/api/presence/compete/rank/:username", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const a = accounts.getByUsername(String(rc.params.username || "").slice(0, 64));
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    rc.json(200, rankView(a, { viewer: rc.account || null }), rc.account ? undefined : publicHeaders());
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
        side: p.side, kills: p.kills, deaths: p.deaths, headshots: p.headshots, assists: p.assists, teamkills: p.teamkills,
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
    if (rc.query.get("all") === "1" && isSiteAdmin(rc.account)) {
      // every enrolled server, for the admin panel's UNRANKED switches
      for (const r of q.enrolledList.all()) {
        out.push({ serverId: r.server_id, name: serverName(r.server), unranked: r.unranked === 1, unrankedAt: r.unranked === 1 ? iso(r.unranked_at) : null, approved: r.approved === 1, lastMatch: iso(r.last) });
      }
      return rc.json(200, { servers: out });
    }
    for (const r of q.serversList.all()) {
      const priv = community.privateCommunityOf(r.server);
      if (priv && !isMember(rc.account, priv)) continue;
      const link = q.linkedTo.get(r.server);
      const cm = link ? q.communityById.get(link.community_id) : null;
      const l = cm ? q.ladder.get(cm.id) : null;
      out.push({
        serverId: enrollment.serverIdFor(r.server), name: serverName(r.server), unranked: r.unranked === 1,
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

  // UNRANKED: an H9 site admin's, for one server at a time. { unranked: true } and the server feeds
  // no table from then on: its open match ends, cancelled, and its next ones are refused. With
  // void: { from, to } (unix seconds or ISO times) and confirm: "VOID", every match it started in
  // that time that is not voided already is voided, as one void each. { unranked: false } counts
  // it again from then on. Audited as presence.compete.server.unranked.
  const timeOf = (v) => (Number.isSafeInteger(v) ? v : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Math.floor(Date.parse(v) / 1000) : null);
  router.post("/api/presence/compete/servers/:serverId", staffRoute(async (req, res, rc) => {
    if (!isSiteAdmin(rc.account)) throw new HttpError(403, "forbidden", "Only H9's site admins mark servers UNRANKED.");
    const row = enrollment.byServerId(rc.params.serverId);
    if (!row) throw new HttpError(404, "not_found", "No such server.");
    const body = await rc.body();
    if (typeof body.unranked !== "boolean") throw new HttpError(400, "bad_request", "unranked: true or false.");
    let range = null;
    if (body.void !== undefined && body.void !== null) {
      const from = timeOf(body.void && body.void.from);
      const to = timeOf(body.void && body.void.to);
      if (from === null || to === null || from > to) throw new HttpError(400, "bad_request", "void: { from, to }, the times of the matches to void, from before to.");
      if (body.confirm !== "VOID") throw new HttpError(400, "bad_request", "Type VOID to confirm voiding the server's matches.");
      range = { from, to };
    }
    const note = cleanText(body.note, 200) || null;
    const t = now();
    let voided = 0;
    tx(() => {
      q.ensureServer.run(row.server);
      q.setUnranked.run(body.unranked ? 1 : 0, rc.account.id, t, row.server);
      if (body.unranked) for (const open of q.openOn.all(row.server)) closeMatch(open, "cancelled", t, "the server was marked UNRANKED");
      if (range) {
        for (const m of q.serverMatches.all(row.server, range.from, range.to)) {
          voidMatch(m, null, rc.account, note || "the server was marked UNRANKED", t);
          voided++;
        }
      }
    });
    record(rc, "presence.compete.server.unranked", row.server, (body.unranked ? "UNRANKED" : "ranked again") +
      (range ? "; " + voided + " matches voided, " + iso(range.from) + " to " + iso(range.to) : "") + (note ? ": " + note : ""));
    rc.json(200, { ok: true, serverId: row.server_id, unranked: body.unranked, voided });
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

  // LEVELS: H9's site admins set the career's tuning (the admin panel's LEVELS tab); the answer
  // holds the road to Lv 99 it gives (levelEstimate), and every account's level is worked out again
  // at once.
  router.get("/api/presence/compete/levels", auth.requireRole("admin", async (req, res, rc) => {
    rc.json(200, { settings: levelConfig(), defaults: LEVEL_DEFAULTS, estimate: levelEstimate(levelConfig()) });
  }));

  router.post("/api/presence/compete/levels", auth.requireRole("admin", async (req, res, rc) => {
    const body = await rc.body();
    const { settings, problems } = levelSettings({ ...levelConfig(), ...body });
    if (problems.length) throw new HttpError(400, "bad_request", "Not a usable value: " + problems.join(", ") + ".");
    const t = now();
    tx(() => {
      for (const k of Object.keys(LEVEL_DEFAULTS)) q.cfgPut.run(k, String(settings[k]), rc.account.id, t);
    });
    cfgCache = null;
    const accounts = relevelAll(t);
    record(rc, "presence.compete.levels", "levels", "career: xpBase " + settings.xpBase + ", xpPower " + settings.xpPower + ", killXp " + settings.killXp + ", matchXp " + settings.matchXp + ", winXp " + settings.winXp);
    rc.json(200, { ok: true, settings, accounts, estimate: levelEstimate(settings) });
  }));

  // RESET THE COMPETITIVE SEASON: an H9 site admin's, typed "RESET". The database is copied into
  // <dataDir>/backups first (the copy a migration makes too); then, at once, the season's final
  // standings are archived, it ends, the next one starts, and nobody is rated.
  const stampOf = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  router.post("/api/presence/compete/season/reset", auth.requireRole("admin", async (req, res, rc) => {
    const body = await rc.body();
    if (body.confirm !== "RESET") throw new HttpError(400, "bad_request", "Type RESET to confirm.");
    const file = typeof db.location === "function" ? db.location() : null;
    if (!file) throw new HttpError(503, "no_backup", "The database has no file to copy first, so nothing was reset.");
    const season = currentSeason();
    const t = now();
    const backup = path.join(path.dirname(file), "backups", "pre-season-reset-" + season.id + "-" + stampOf(t) + ".db");
    backupDatabase(db, backup);
    tx(() => {
      q.archive.run(season.id);
      q.seasonEnd.run(t, rc.account.id, path.basename(backup), season.id);
      q.seasonNew.run(season.id + 1, t);
      q.clearRatings.run();
      q.clearDeltas.run();
      q.clearLevels.run();
      q.clearPairs.run();
    });
    // the career's experience stays (the account's, over every season): levels from it again
    relevelAll(t);
    record(rc, "presence.compete.season.reset", "season " + season.id, "archived; season " + (season.id + 1) + " started; the database was copied to " + path.basename(backup) + " first");
    log.info("presence.compete.season_reset", { ended: season.id, started: season.id + 1, backup: path.basename(backup) });
    rc.json(200, { ok: true, ended: season.id, season: seasonView(q.seasonById.get(season.id + 1)), backup: path.basename(backup) });
  }));

  // SEASONS BACK TO SEASON 1: an H9 site admin's, typed "SEASON 1". The database is copied into
  // <dataDir>/backups first; then every archived season goes, with its final standings, and the season
  // under way becomes season 1 from when it started: its tables, the levels and every account's career
  // experience stay as they are, and every match counts as season 1's.
  router.post("/api/presence/compete/season/restart", auth.requireRole("admin", async (req, res, rc) => {
    const body = await rc.body();
    if (body.confirm !== "SEASON 1") throw new HttpError(400, "bad_request", "Type SEASON 1 to confirm.");
    const file = typeof db.location === "function" ? db.location() : null;
    if (!file) throw new HttpError(503, "no_backup", "The database has no file to copy first, so nothing was changed.");
    const season = currentSeason();
    const t = now();
    const backup = path.join(path.dirname(file), "backups", "pre-season-1-from-" + season.id + "-" + stampOf(t) + ".db");
    backupDatabase(db, backup);
    tx(() => {
      q.standingsDropAll.run();
      q.seasonsDropAll.run();
      q.seasonOne.run(season.started_at);
      q.matchesSeasonOne.run();
      q.adjustmentsSeasonOne.run();
    });
    record(rc, "presence.compete.season.restart", "season " + season.id + " to 1", "seasons 1 to " + season.id + " set back to season 1, the season under way since " + iso(season.started_at) +
      "; the archived standings dropped; the database was copied to " + path.basename(backup) + " first");
    log.info("presence.compete.season_restart", { was: season.id, backup: path.basename(backup) });
    rc.json(200, { ok: true, was: season.id, season: seasonView(q.seasonById.get(1)), backup: path.basename(backup) });
  }));

  // ---- an account's rank in the admin panel ---------------------------------------------------------

  // A moderator sees an account's whole rank (GET); an H9 site admin changes it (POST .../adjust): a
  // table's rating set or moved, or the career's experience, with a note and their own password, never
  // on their own account or another admin's. Every change is kept (compete_adjustments), audited
  // against the account (presence.compete.adjust, in its trail), and the level is worked out at once.
  const adjustView = (r) => ({
    at: iso(r.at), by: r.by_name || null, field: r.field, ladder: r.ladder, before: r.before, after: r.after, note: r.note,
    table: r.scope ? (r.scope === "n" ? "H9 ladder" : (scopeView(r.scope, null) || { name: r.scope }).name) : null,
  });
  const adjustable = (actor, a) => isSiteAdmin(actor) && a.id !== actor.id && !auth.roleAtLeast(a, "admin");

  router.get("/api/presence/compete/accounts/:name", auth.requireRole("moderator", async (req, res, rc) => {
    const a = accounts.getByUsername(String(rc.params.name || "").slice(0, 64));
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    rc.json(200, {
      rank: rankView(a, { viewer: rc.account }),
      xp: { total: careerXp(a.id), played: Math.max(0, q.xpPlayed.get(a.id).xp), adjusted: q.xpAdjusted.get(a.id).xp },
      next: (() => {
        const lv = levelOf(a.id);
        return lv >= 99 ? null : { level: lv + 1, xp: xpForLevel(levelConfig(), lv + 1) };
      })(),
      adjustments: q.adjustsOf.all(a.id).map(adjustView),
      can: { adjust: adjustable(rc.account, a) },
    });
  }));

  router.post("/api/presence/compete/accounts/:name/adjust", auth.requireRole("admin", async (req, res, rc) => {
    own("staffPerAccount", String(rc.account.id));
    const body = await rc.body();
    const a = accounts.getByUsername(String(rc.params.name || "").slice(0, 64));
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    if (!adjustable(rc.account, a)) throw new HttpError(403, "forbidden", "Not on your own account, nor on another admin's.");
    if (body.field !== "elo" && body.field !== "xp") throw new HttpError(400, "bad_request", "field: elo (a table's rating) or xp (the career's experience).");
    const hasSet = body.set !== undefined && body.set !== null;
    const hasBy = body.by !== undefined && body.by !== null;
    if (hasSet === hasBy || !Number.isSafeInteger(hasSet ? body.set : body.by)) {
      throw new HttpError(400, "bad_request", "Give set (the new value) or by (what to add; below 0 takes away), a whole number.");
    }
    const note = cleanText(body.note, 200);
    if (!note || note.length < 3) throw new HttpError(400, "invalid_note", "Give a note of 3 to 200 characters: why the rank is changed.");
    let key = null;
    let ladder = null;
    if (body.field === "elo") {
      key = scopeFor(body.scope || "network", rc.account).key;
      ladder = body.ladder === "dm" ? "dm" : "match";
    }
    if (typeof auth.confirmAdmin !== "function") throw new HttpError(503, "not_ready", "This h9web cannot check an admin's password here.");
    const actor = await auth.confirmAdmin(rc, body.password);
    const t = now();
    let before = 0;
    let after = 0;
    tx(() => {
      if (body.field === "elo") {
        before = rating(key, ladder, a.id, t).elo;
        after = clamp(hasSet ? body.set : before + body.by, 0, 100000);
        q.setElo.run(after, key, ladder, a.id);
      } else {
        before = careerXp(a.id);
        after = clamp(hasSet ? body.set : before + body.by, 0, 100000000);
      }
      q.adjustPut.run(a.id, body.field, key, ladder, before, after, note, actor.id, t, currentSeason().id);
      relevel(a.id, t);
    });
    const what = body.field === "elo"
      ? (key === "n" ? "H9 ladder" : (scopeView(key, actor) || { name: key }).name) + " " + ladder.toUpperCase() + " rating"
      : "career XP";
    if (audit) audit.record({ actor, action: "presence.compete.adjust", target: a, subject: "rank", detail: what + " " + before + " -> " + after + ": " + note });
    log.info("presence.compete.adjust", { by: actor.username, user: a.username, field: body.field, before, after });
    rc.json(200, { ok: true, field: body.field, before, after, level: levelOf(a.id), rank: rankView(a, { viewer: actor }) });
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

  return { settings: c, sweep, start, stop, scopesFor, provenNow, levelOf, publicLevel, eloOf, rankOf, levelsFor, relevelAll };
}
