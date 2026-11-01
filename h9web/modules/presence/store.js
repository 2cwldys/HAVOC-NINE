// Every SQL statement the presence module runs, prepared once. Times are unix seconds on
// h9web's own clock; migrations.js describes the tables.

export function createStore(db) {
  const q = {
    settings: db.prepare("SELECT * FROM presence_settings WHERE account_id = ?"),
    putSettings: db.prepare(`INSERT INTO presence_settings (account_id, show_game, show_where, show_web, show_site, show_playtime,
      show_last_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET show_game = excluded.show_game, show_where = excluded.show_where,
        show_web = excluded.show_web, show_site = excluded.show_site, show_playtime = excluded.show_playtime,
        show_last_seen = excluded.show_last_seen, updated_at = excluded.updated_at`),
    lastEnded: db.prepare("SELECT max(ended_at) AS t FROM presence_sessions WHERE account_id = ?"),

    server: db.prepare("SELECT * FROM presence_servers WHERE server = ?"),
    putServer: db.prepare(`INSERT INTO presence_servers (server, map, mode, detail, last_report, last_ts) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server) DO UPDATE SET map = excluded.map, mode = excluded.mode, detail = excluded.detail,
        last_report = excluded.last_report, last_ts = excluded.last_ts`),
    serverInfo: db.prepare("UPDATE presence_servers SET name = ?, humans = ?, max = ? WHERE server = ?"),

    online: db.prepare("SELECT * FROM presence_online WHERE account_id = ? AND server = ?"),
    onlineOn: db.prepare("SELECT * FROM presence_online WHERE server = ?"),
    onlineOf: db.prepare("SELECT * FROM presence_online WHERE account_id = ? ORDER BY since, server"),
    activeAccounts: db.prepare("SELECT DISTINCT account_id FROM presence_online WHERE plugin_at IS NOT NULL OR relay = 1"),
    pluginStale: db.prepare("SELECT * FROM presence_online WHERE plugin_at IS NOT NULL AND plugin_at < ?"),
    awayExpired: db.prepare("SELECT * FROM presence_online WHERE plugin_at IS NULL AND relay = 0 AND away_at IS NOT NULL AND away_at < ?"),
    relayRows: db.prepare("SELECT * FROM presence_online WHERE relay = 1"),
    heldAccounts: db.prepare("SELECT DISTINCT account_id FROM presence_online WHERE held = 1"),
    servedServers: db.prepare("SELECT DISTINCT server FROM presence_online"),
    insertOnline: db.prepare(`INSERT INTO presence_online (account_id, server, since, last_at, plugin_at, away_at, relay, proven, held,
      credited, device, net, seen_by, name, seconds, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateOnline: db.prepare(`UPDATE presence_online SET last_at = ?, plugin_at = ?, away_at = ?, relay = ?, proven = ?, held = ?,
      credited = ?, device = ?, net = ?, seen_by = ?, name = ?, seconds = ?, slot = ? WHERE account_id = ? AND server = ?`),
    deleteOnline: db.prepare("DELETE FROM presence_online WHERE account_id = ? AND server = ?"),

    insertSession: db.prepare(`INSERT INTO presence_sessions (account_id, server, started_at, ended_at, seconds, seen_by, name)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    sessionsOf: db.prepare("SELECT * FROM presence_sessions WHERE account_id = ? ORDER BY ended_at DESC, id DESC LIMIT ?"),
    pruneSessions: db.prepare("DELETE FROM presence_sessions WHERE ended_at < ?"),
    moveSessions: db.prepare("UPDATE presence_sessions SET account_id = ? WHERE account_id = ?"),

    addPlaytime: db.prepare(`INSERT INTO presence_playtime (account_id, server, seconds, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, server) DO UPDATE SET seconds = seconds + excluded.seconds,
        first_seen = min(first_seen, excluded.first_seen), last_seen = max(last_seen, excluded.last_seen)`),
    playtimeOf: db.prepare("SELECT * FROM presence_playtime WHERE account_id = ? ORDER BY seconds DESC, server"),
    totalsOf: db.prepare(`SELECT count(*) AS servers, COALESCE(sum(seconds), 0) AS seconds, min(first_seen) AS first_seen,
      max(last_seen) AS last_seen FROM presence_playtime WHERE account_id = ?`),
    deletePlaytime: db.prepare("DELETE FROM presence_playtime WHERE account_id = ?"),

    devicesOf: db.prepare("SELECT * FROM presence_devices WHERE account_id = ? ORDER BY first_seen, device"),
    device: db.prepare("SELECT * FROM presence_devices WHERE account_id = ? AND device = ?"),
    deviceCount: db.prepare("SELECT count(*) AS n FROM presence_devices WHERE account_id = ?"),
    putDevice: db.prepare(`INSERT INTO presence_devices (account_id, device, status, first_seen, last_seen, set_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, device) DO UPDATE SET status = excluded.status, set_by = excluded.set_by`),
    touchDevice: db.prepare("UPDATE presence_devices SET last_seen = max(last_seen, ?) WHERE account_id = ? AND device = ?"),
    deleteDevice: db.prepare("DELETE FROM presence_devices WHERE account_id = ? AND device = ?"),
    clearDevices: db.prepare("DELETE FROM presence_devices WHERE account_id = ?"),
    moveDevices: db.prepare(`INSERT OR IGNORE INTO presence_devices (account_id, device, status, first_seen, last_seen, set_by)
      SELECT ?, device, status, first_seen, last_seen, set_by FROM presence_devices WHERE account_id = ?`),

    openFlag: db.prepare("SELECT * FROM presence_flags WHERE account_id = ? AND kind = ? AND about = ? AND status = 'open'"),
    insertFlag: db.prepare(`INSERT INTO presence_flags (account_id, kind, about, server, other_server, device, net_known, detail, first_at, last_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    bumpFlag: db.prepare(`UPDATE presence_flags SET last_at = ?, count = count + 1, server = COALESCE(?, server),
      other_server = COALESCE(?, other_server), net_known = COALESCE(?, net_known), detail = COALESCE(?, detail) WHERE id = ?`),
    flag: db.prepare("SELECT f.*, a.username FROM presence_flags f JOIN accounts a ON a.id = f.account_id WHERE f.id = ?"),
    flagsByStatus: db.prepare(`SELECT f.*, a.username FROM presence_flags f JOIN accounts a ON a.id = f.account_id
      WHERE f.status = ? ORDER BY f.last_at DESC, f.id DESC LIMIT ? OFFSET ?`),
    flagsAll: db.prepare(`SELECT f.*, a.username FROM presence_flags f JOIN accounts a ON a.id = f.account_id
      ORDER BY f.last_at DESC, f.id DESC LIMIT ? OFFSET ?`),
    countByStatus: db.prepare("SELECT count(*) AS n FROM presence_flags WHERE status = ?"),
    countAll: db.prepare("SELECT count(*) AS n FROM presence_flags"),
    flagsOf: db.prepare("SELECT * FROM presence_flags WHERE account_id = ? ORDER BY last_at DESC, id DESC LIMIT 50"),
    resolveFlag: db.prepare("UPDATE presence_flags SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ? WHERE id = ? AND status = 'open'"),
    resolveFlagsAbout: db.prepare(`UPDATE presence_flags SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ?
      WHERE account_id = ? AND kind = ? AND about = ? AND status = 'open'`),
    pruneFlags: db.prepare("DELETE FROM presence_flags WHERE status = 'resolved' AND resolved_at < ?"),
    moveFlags: db.prepare("UPDATE presence_flags SET account_id = ? WHERE account_id = ?"),
    closeOpenFlags: db.prepare(`UPDATE presence_flags SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ?
      WHERE account_id = ? AND status = 'open'`),

    netKnown: db.prepare("SELECT 1 AS k FROM presence_nets WHERE account_id = ? AND net = ? AND last_seen >= ?"),
    touchNet: db.prepare(`INSERT INTO presence_nets (account_id, net, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, net) DO UPDATE SET last_seen = max(last_seen, excluded.last_seen)`),
    pruneNets: db.prepare("DELETE FROM presence_nets WHERE last_seen < ?"),
    netCount: db.prepare("SELECT count(*) AS n FROM presence_nets WHERE account_id = ?"),
    moveNets: db.prepare(`INSERT OR IGNORE INTO presence_nets (account_id, net, first_seen, last_seen)
      SELECT ?, net, first_seen, last_seen FROM presence_nets WHERE account_id = ?`),
    clearNets: db.prepare("DELETE FROM presence_nets WHERE account_id = ?"),
  };

  const row = (r) => [r.last_at, r.plugin_at, r.away_at, r.relay, r.proven, r.held, r.credited, r.device, r.net, r.seen_by, r.name, r.seconds,
    r.slot === undefined ? null : r.slot];

  return {
    // { show_game, ... } with 1, 0 or null, or null when the account never chose
    settings: (accountId) => q.settings.get(accountId) || null,
    putSettings: (accountId, c, at) => q.putSettings.run(accountId, c.show_game, c.show_where, c.show_web, c.show_site, c.show_playtime, c.show_last_seen, at),
    lastEnded: (accountId) => q.lastEnded.get(accountId).t || null,

    server: (server) => q.server.get(server) || null,
    putServer: (server, s) => q.putServer.run(server, s.map, s.mode, s.detail, s.lastReport, s.lastTs),
    serverInfo: (server, name, humans, max) => q.serverInfo.run(name, humans, max, server),

    online: (accountId, server) => q.online.get(accountId, server) || null,
    onlineOn: (server) => q.onlineOn.all(server),
    onlineOf: (accountId) => q.onlineOf.all(accountId),
    activeAccounts: () => q.activeAccounts.all().map((r) => r.account_id),
    pluginStale: (cutoff) => q.pluginStale.all(cutoff),
    awayExpired: (cutoff) => q.awayExpired.all(cutoff),
    relayRows: () => q.relayRows.all(),
    heldAccounts: () => q.heldAccounts.all().map((r) => r.account_id),
    servedServers: () => q.servedServers.all().map((r) => r.server),
    insertOnline: (r) => q.insertOnline.run(r.account_id, r.server, r.since, ...row(r)),
    updateOnline: (r) => q.updateOnline.run(...row(r), r.account_id, r.server),
    deleteOnline: (accountId, server) => q.deleteOnline.run(accountId, server),

    insertSession: (r, endedAt) => q.insertSession.run(r.account_id, r.server, r.since, endedAt, r.seconds, r.seen_by, r.name),
    sessionsOf: (accountId, limit) => q.sessionsOf.all(accountId, limit),
    pruneSessions: (cutoff) => Number(q.pruneSessions.run(cutoff).changes),

    addPlaytime: (accountId, server, seconds, at) => q.addPlaytime.run(accountId, server, seconds, at, at),
    playtimeOf: (accountId) => q.playtimeOf.all(accountId),
    totalsOf: (accountId) => q.totalsOf.get(accountId),

    devicesOf: (accountId) => q.devicesOf.all(accountId),
    device: (accountId, device) => q.device.get(accountId, device) || null,
    deviceCount: (accountId) => q.deviceCount.get(accountId).n,
    putDevice: (accountId, device, status, at, by = null) => q.putDevice.run(accountId, device, status, at, at, by),
    touchDevice: (accountId, device, at) => q.touchDevice.run(at, accountId, device),
    deleteDevice: (accountId, device) => Number(q.deleteDevice.run(accountId, device).changes),
    clearDevices: (accountId) => Number(q.clearDevices.run(accountId).changes),

    openFlag: (accountId, kind, about) => q.openFlag.get(accountId, kind, about) || null,
    insertFlag: (f) => Number(q.insertFlag.run(f.account_id, f.kind, f.about, f.server, f.other_server, f.device, f.net_known, f.detail, f.at, f.at).lastInsertRowid),
    bumpFlag: (id, f) => q.bumpFlag.run(f.at, f.server, f.other_server, f.net_known, f.detail, id),
    flag: (id) => q.flag.get(id) || null,
    flags: (status, limit, offset) => (status === "all" ? q.flagsAll.all(limit, offset) : q.flagsByStatus.all(status, limit, offset)),
    flagCount: (status) => (status === "all" ? q.countAll.get().n : q.countByStatus.get(status).n),
    flagsOf: (accountId) => q.flagsOf.all(accountId),
    resolveFlag: (id, at, by, note) => Number(q.resolveFlag.run(at, by, note, id).changes),
    resolveFlagsAbout: (accountId, kind, about, at, by, note) => q.resolveFlagsAbout.run(at, by, note, accountId, kind, about),
    pruneFlags: (cutoff) => Number(q.pruneFlags.run(cutoff).changes),

    netKnown: (accountId, net, cutoff) => !!q.netKnown.get(accountId, net, cutoff),
    touchNet: (accountId, net, at) => q.touchNet.run(accountId, net, at, at),
    pruneNets: (cutoff) => Number(q.pruneNets.run(cutoff).changes),
    netCount: (accountId) => q.netCount.get(accountId).n,

    // An admin moved an account's player id to another account: its presence history goes with it.
    // Open sessions are ended by the caller first; each account keeps its own switch. The moving
    // account's open flags are closed first (with a note), so they cannot collide with the other
    // account's open ones, and move with the rest as history.
    moveHistory(from, to, at, by) {
      q.moveSessions.run(to, from);
      for (const p of q.playtimeOf.all(from)) q.addPlaytime.run(to, p.server, p.seconds, p.first_seen, p.last_seen);
      q.deletePlaytime.run(from);
      q.moveDevices.run(to, from);
      q.clearDevices.run(from);
      q.closeOpenFlags.run(at, by, "closed when the player id moved to another account", from);
      q.moveFlags.run(to, from);
      q.moveNets.run(to, from);
      q.clearNets.run(from);
    },
  };
}
