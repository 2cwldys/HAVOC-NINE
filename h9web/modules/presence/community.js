// Communities: a havoc9.org account's group of enrolled servers, run by its owner and the admins
// the owner names, with cross-server features. docs\H9_COMMUNITIES.txt is the guide and holds the
// trust model.
//
// Game servers (signed calls, serverauth.js; h9_community.sma makes them):
//   POST /api/presence/server/poll      { since, hold }  long-poll: chat and announcements for its
//                                       community (and H9-wide announcements), whether to report
//                                       now (a kick or a sanction waits), its community's servers
//   POST /api/presence/server/chat      { id, text }     a player's line to the community channel
//   POST /api/presence/server/find      { q }            where an account is, community first
//   POST /api/presence/server/data/get  { id | account, keys }
//   POST /api/presence/server/data/set  { id, key, value, version }
//   POST /api/presence/server/claim                      a one-time code to link the server
// The site (signed in; staff = the owner, its admins, and H9's site admins):
//   GET    /api/presence/communities                    the list
//   POST   /api/presence/communities  { slug, name }    make one, owned by you
//   GET    /api/presence/communities/:slug              its servers and who is on them
//   PATCH  /api/presence/communities/:slug              staff: { name, chat, chatProof, dataProof }
//   DELETE /api/presence/communities/:slug              owner: { confirm }
//   POST   /api/presence/communities/:slug/claim        staff: { code, tag }  link a server
//   POST   /api/presence/communities/:slug/servers/:serverId   staff: { tag, readOnly }
//   DELETE /api/presence/communities/:slug/servers/:serverId   staff: unlink
//   POST   /api/presence/communities/:slug/staff        owner: { username }
//   DELETE /api/presence/communities/:slug/staff/:username     owner
//   GET    /api/presence/communities/:slug/sanctions    staff
//   POST   /api/presence/communities/:slug/sanctions    staff: { username, kind ban|mute|kick, reason, days }
//   POST   /api/presence/communities/:slug/sanctions/:id/revoke   staff
//   POST   /api/presence/communities/:slug/announce     staff: { text }
//   GET    /api/presence/communities/:slug/chat?since=N signed in
//   POST   /api/presence/communities/:slug/chat         signed in: { text }
//   DELETE /api/presence/communities/:slug/chat/:id     staff
//   GET    /api/presence/communities/:slug/data/log     staff: ?username=
//   POST   /api/presence/communities/:slug/data/rollback   owner: { to, username }
// H9's site admins, H9-wide:
//   GET  /api/presence/admin/sanctions   POST /api/presence/admin/sanctions   (as above)
//   POST /api/presence/admin/sanctions/:id/revoke   POST /api/presence/admin/announce { text }
// Every staff and admin action goes into the audit log.

import crypto from "node:crypto";
import { cleanText } from "./modes.js";

const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,11}$/;
const DATA_KEY = /^[a-z0-9_.-]{1,32}$/;
const CLIENT_ID = /^[0-9a-f]{32}$/;
const CLAIM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null);

// A chat line's text as it may travel: no control or colour characters (Xash's ^0 to ^9), no %
// (a client formats chat text, and a % in it would be read as a format), no leading # (a
// localisation token), white space collapsed, at most max characters.
export function chatText(value, max) {
  const t = cleanText(String(value || "").replace(/\^[0-9]/g, "").replace(/%/g, " "), max).replace(/^#+/, "").trim();
  return t;
}

// A kick or ban reason as it goes into a server command: letters, digits and a few marks only.
export function reasonText(value) {
  return String(value || "").replace(/[^A-Za-z0-9 .,:!?()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function claimCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CLAIM_ALPHABET[b[i] % CLAIM_ALPHABET.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

export function createCommunity(deps) {
  const { db, s, log, router, auth, accounts, serverAuth, enrollment, limit, ipKey, audit, store } = deps;
  const { HttpError } = deps.http;
  const now = deps.now;
  const tx = deps.transaction;

  const q = {
    community: db.prepare("SELECT * FROM presence_communities WHERE slug = ?"),
    communityById: db.prepare("SELECT * FROM presence_communities WHERE id = ?"),
    communities: db.prepare(`SELECT c.*, a.username AS owner, (SELECT count(*) FROM presence_community_servers x WHERE x.community_id = c.id) AS servers
      FROM presence_communities c LEFT JOIN accounts a ON a.id = c.owner_id ORDER BY c.name COLLATE NOCASE LIMIT 500`),
    ownedBy: db.prepare("SELECT count(*) AS n FROM presence_communities WHERE owner_id = ?"),
    insertCommunity: db.prepare("INSERT INTO presence_communities (slug, name, owner_id, created_at) VALUES (?, ?, ?, ?)"),
    updateCommunity: db.prepare("UPDATE presence_communities SET name = ?, chat = ?, chat_proof = ?, data_proof = ? WHERE id = ?"),
    deleteCommunity: db.prepare("DELETE FROM presence_communities WHERE id = ?"),
    staff: db.prepare("SELECT s.account_id, a.username FROM presence_community_staff s JOIN accounts a ON a.id = s.account_id WHERE s.community_id = ? ORDER BY a.username_key"),
    isStaff: db.prepare("SELECT 1 AS k FROM presence_community_staff WHERE community_id = ? AND account_id = ?"),
    addStaff: db.prepare("INSERT OR IGNORE INTO presence_community_staff (community_id, account_id, added_by, added_at) VALUES (?, ?, ?, ?)"),
    removeStaff: db.prepare("DELETE FROM presence_community_staff WHERE community_id = ? AND account_id = ?"),
    serversOf: db.prepare("SELECT * FROM presence_community_servers WHERE community_id = ? ORDER BY tag COLLATE NOCASE"),
    recentServers: db.prepare("SELECT server FROM presence_servers WHERE last_report >= ?"),
    serverRow: db.prepare("SELECT * FROM presence_community_servers WHERE server = ?"),
    link: db.prepare("INSERT INTO presence_community_servers (server, community_id, tag, linked_at, linked_by) VALUES (?, ?, ?, ?, ?)"),
    updateServer: db.prepare("UPDATE presence_community_servers SET tag = ?, read_only = ? WHERE server = ?"),
    unlink: db.prepare("DELETE FROM presence_community_servers WHERE server = ?"),
    claimAdd: db.prepare("INSERT INTO presence_claims (code_hash, server, expires_at) VALUES (?, ?, ?)"),
    claim: db.prepare("SELECT * FROM presence_claims WHERE code_hash = ? AND expires_at > ?"),
    claimUse: db.prepare("DELETE FROM presence_claims WHERE code_hash = ?"),
    claimPrune: db.prepare("DELETE FROM presence_claims WHERE expires_at <= ?"),
    sanction: db.prepare(`SELECT * FROM presence_sanctions WHERE account_id = ? AND kind = ? AND revoked_at IS NULL
      AND (until IS NULL OR until > ?) AND (community_id IS NULL OR community_id = ?) ORDER BY community_id IS NULL DESC LIMIT 1`),
    sanctionByDevice: db.prepare(`SELECT s.* FROM presence_sanctions s JOIN presence_devices d ON d.account_id = s.account_id
      WHERE d.device = ? AND s.kind = 'ban' AND s.revoked_at IS NULL AND (s.until IS NULL OR s.until > ?)
      AND (s.community_id IS NULL OR s.community_id = ?) LIMIT 1`),
    sanctionAdd: db.prepare("INSERT INTO presence_sanctions (community_id, account_id, kind, reason, created_by, created_at, until) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    sanctionGet: db.prepare("SELECT * FROM presence_sanctions WHERE id = ?"),
    sanctionRevoke: db.prepare("UPDATE presence_sanctions SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL"),
    sanctionsOf: db.prepare(`SELECT s.*, a.username, b.username AS by_name FROM presence_sanctions s JOIN accounts a ON a.id = s.account_id
      LEFT JOIN accounts b ON b.id = s.created_by WHERE s.community_id IS ? ORDER BY s.id DESC LIMIT 200`),
    kickAdd: db.prepare("INSERT INTO presence_kicks (community_id, account_id, reason, created_at) VALUES (?, ?, ?, ?)"),
    kickFor: db.prepare(`SELECT * FROM presence_kicks WHERE account_id = ? AND done_at IS NULL AND created_at > ?
      AND (community_id IS NULL OR community_id = ?) ORDER BY id LIMIT 1`),
    kickDone: db.prepare("UPDATE presence_kicks SET done_at = ? WHERE id = ?"),
    kickPrune: db.prepare("DELETE FROM presence_kicks WHERE created_at < ?"),
    message: db.prepare(`INSERT INTO presence_messages (community_id, kind, source, server, tag, account_id, name, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    lastId: db.prepare("SELECT COALESCE(max(id), 0) AS id FROM presence_messages"),
    forServer: db.prepare(`SELECT * FROM presence_messages WHERE id > ? AND deleted_at IS NULL AND created_at >= ?
      AND ((community_id = ? AND (kind = 'announce' OR server IS NULL OR server <> ?)) OR (community_id IS NULL AND kind = 'announce'))
      ORDER BY id LIMIT 50`),
    forWeb: db.prepare(`SELECT * FROM presence_messages WHERE id > ? AND deleted_at IS NULL AND created_at >= ?
      AND (community_id = ? OR (community_id IS NULL AND kind = 'announce')) ORDER BY id DESC LIMIT 100`),
    messageGet: db.prepare("SELECT * FROM presence_messages WHERE id = ?"),
    messageDelete: db.prepare("UPDATE presence_messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL"),
    messagePrune: db.prepare("DELETE FROM presence_messages WHERE created_at < ?"),
    findPrefix: db.prepare("SELECT id FROM accounts WHERE username_key LIKE ? ESCAPE '!' ORDER BY username_key LIMIT 5"),
    data: db.prepare("SELECT * FROM presence_data WHERE community_id = ? AND account_id = ? AND key = ?"),
    dataCount: db.prepare("SELECT count(*) AS n FROM presence_data WHERE community_id = ? AND account_id = ?"),
    dataRows: db.prepare("SELECT count(*) AS n FROM presence_data WHERE community_id = ?"),
    dataPut: db.prepare(`INSERT INTO presence_data (community_id, account_id, key, value, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(community_id, account_id, key) DO UPDATE SET value = excluded.value, version = excluded.version,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    dataDelete: db.prepare("DELETE FROM presence_data WHERE community_id = ? AND account_id = ? AND key = ?"),
    dataLogAdd: db.prepare(`INSERT INTO presence_data_log (community_id, account_id, key, old_value, new_value, old_version, new_version, server, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    dataLog: db.prepare(`SELECT l.*, a.username FROM presence_data_log l JOIN accounts a ON a.id = l.account_id
      WHERE l.community_id = ? AND (? IS NULL OR l.account_id = ?) ORDER BY l.id DESC LIMIT 200`),
    dataSince: db.prepare(`SELECT * FROM presence_data_log WHERE community_id = ? AND at > ? AND (? IS NULL OR account_id = ?)
      ORDER BY id`),
    dataLogPrune: db.prepare("DELETE FROM presence_data_log WHERE at < ?"),
  };

  // ---- who may do what ---------------------------------------------------------------------------

  const isSiteAdmin = (account) => auth.roleAtLeast(account, "admin");
  const isOwner = (account, c) => !!account && (c.owner_id === account.id || isSiteAdmin(account));
  const isStaff = (account, c) => !!account && (isOwner(account, c) || !!q.isStaff.get(c.id, account.id));

  function communityOrThrow(slug) {
    const c = q.community.get(String(slug || "").toLowerCase());
    if (!c) throw new HttpError(404, "not_found", "No such community.");
    return c;
  }
  const mustStaff = (account, c) => { if (!isStaff(account, c)) throw new HttpError(403, "forbidden", "Only this community's admins may do that."); };
  const mustOwner = (account, c) => { if (!isOwner(account, c)) throw new HttpError(403, "forbidden", "Only this community's owner may do that."); };

  function communityOfServer(server) {
    const cs = q.serverRow.get(server);
    if (!cs) return null;
    const c = q.communityById.get(cs.community_id);
    return c ? { ...c, tag: cs.tag, readOnly: cs.read_only === 1 } : null;
  }

  function record(rc, action, c, subject, detail, target = null) {
    if (audit) audit.record({ actor: rc.account, action, target, targetName: target ? null : c ? c.slug : null, subject, detail: detail || null });
  }

  function accountOrThrow(name) {
    const a = typeof name === "string" ? accounts.getByUsername(name) : null;
    if (!a) throw new HttpError(404, "not_found", "No such account.");
    return a;
  }

  // ---- sanctions ---------------------------------------------------------------------------------

  // A ban or mute in force for the account here: the community's own or H9-wide. A ban also
  // follows the account's proven devices onto any other account.
  function sanctioned(accountId, communityId, kind, device = null) {
    const t = now();
    const r = q.sanction.get(accountId, kind, t, communityId);
    if (r) return r;
    if (kind === "ban" && device) return q.sanctionByDevice.get(device, t, communityId) || null;
    return null;
  }

  // What a report's answer tells the plugin to do with each slot: { kick: reason } for a banned
  // account or a waiting one-off kick, { mute: true } for a muted one. entries: [{ slot, accountId,
  // device }] for every player whose h9_clientid is an account's, proven or not.
  function reportActions(server, entries) {
    const c = communityOfServer(server);
    const cid = c ? c.id : null;
    const t = now();
    const out = {};
    for (const e of entries) {
      if (!e.slot) continue;
      const ban = sanctioned(e.accountId, cid, "ban", e.device);
      if (ban) {
        out[e.slot] = { kick: reasonText("Banned" + (ban.community_id ? " from " + (c ? c.name : "this community") : " from H9") + (ban.reason ? ": " + ban.reason : "")) };
        continue;
      }
      const kick = q.kickFor.get(e.accountId, t - 3600, cid);
      if (kick) {
        q.kickDone.run(t, kick.id);
        out[e.slot] = { kick: reasonText("Kicked" + (kick.reason ? ": " + kick.reason : "")) };
        continue;
      }
      if (sanctioned(e.accountId, cid, "mute")) out[e.slot] = { mute: true };
    }
    return out;
  }

  // ---- the long-poll -----------------------------------------------------------------------------

  const waiters = new Map(); // server -> { finish, communityId }
  const wantReport = new Set(); // servers that should report now

  function wake(communityId) {
    for (const w of waiters.values()) if (communityId === null || w.communityId === communityId) w.finish();
  }

  // A sanction or a kick changed: the servers it concerns report at their next poll, so the answer
  // to that report carries it (H9-wide: every server that reported in the last 10 minutes).
  function askReports(communityId) {
    const list = communityId === null ? q.recentServers.all(now() - 600).map((r) => r.server) : q.serversOf.all(communityId).map((r) => r.server);
    for (const server of list) wantReport.add(server);
    wake(communityId);
  }

  function lineOf(m, c) {
    if (m.kind === "announce") return "[" + (m.tag || "H9") + "] " + m.text;
    return "[" + m.tag + "] " + m.name + ": " + m.text;
  }

  function messagesFor(server, c, since) {
    const t = now();
    const rows = q.forServer.all(since, t - s.chatRetentionDays * 86400, c ? c.id : -1, server);
    return rows.map((m) => ({ id: m.id, kind: m.kind, source: m.source, line: lineOf(m, c) }));
  }

  function serversView(c, nowView) {
    if (!c) return [];
    const live = new Map();
    for (const e of nowView().servers) live.set(e.server.address, e);
    return q.serversOf.all(c.id).map((r) => {
      const e = live.get(r.server);
      const info = deps.serverInfo(r.server);
      return {
        serverId: enrollment.serverIdFor(r.server), tag: r.tag, address: r.server, name: info.name, map: info.map, mode: info.mode,
        humans: info.humans, max: info.max, readOnly: r.read_only === 1, players: e ? e.players.map((p) => p.username) : [],
      };
    });
  }

  router.post("/api/presence/server/poll", async (req, res, rc) => {
    limit("serverCallsPerIp", ipKey(rc.ip));
    const { server, body } = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes: 2048 });
    limit("pollPerServer", server);
    const c = communityOfServer(server);
    let since = Number.isSafeInteger(body.since) && body.since >= 0 ? body.since : q.lastId.get().id;
    let messages = messagesFor(server, c, since);
    const hold = body.hold === 0 ? 0 : s.pollHoldSeconds;
    if (!messages.length && !wantReport.has(server) && hold > 0) {
      await new Promise((resolve) => {
        const old = waiters.get(server);
        if (old) old.finish();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (waiters.get(server) === entry) waiters.delete(server);
          resolve();
        };
        const entry = { finish, communityId: c ? c.id : null };
        const timer = setTimeout(finish, hold * 1000);
        waiters.set(server, entry);
        // the response's close: the caller went away before the answer
        res.on("close", finish);
      });
      messages = messagesFor(server, c, since);
    }
    if (messages.length) since = messages[messages.length - 1].id;
    const report = wantReport.delete(server);
    rc.json(200, {
      ok: true, last: since, messages, report, serverId: enrollment.serverIdFor(server),
      community: c ? { slug: c.slug, name: c.name, tag: c.tag, chat: c.chat === 1, readOnly: c.readOnly } : null,
      servers: serversView(c, deps.nowView),
    });
  }, { csrf: false });

  // ---- chat --------------------------------------------------------------------------------------

  const lastChat = new Map(); // account id -> ms of its last line (the cooldown)

  function cooldown(accountId) {
    const t = Date.now();
    const last = lastChat.get(accountId) || 0;
    if (t - last < s.chatCooldownSeconds * 1000) {
      const wait = Math.ceil((s.chatCooldownSeconds * 1000 - (t - last)) / 1000);
      throw new HttpError(429, "rate_limited", "Wait " + wait + " seconds between lines.", { headers: { "Retry-After": String(wait) } });
    }
    if (lastChat.size > 10000) lastChat.clear();
    lastChat.set(accountId, t);
  }

  function post(c, { kind, source, server, tag, account, name, text }) {
    const t = now();
    const id = Number(q.message.run(c ? c.id : null, kind, source, server || null, tag, account ? account.id : null, name, text, t).lastInsertRowid);
    wake(c ? c.id : null);
    return id;
  }

  // The account behind a player on this server: the h9_clientid must be an account's, and that
  // account in game here now by the plugin's own report.
  function presentAccount(server, id) {
    if (typeof id !== "string" || !CLIENT_ID.test(id.toLowerCase())) throw new HttpError(400, "bad_request", "id is the player's h9_clientid.");
    const accountId = accounts.clientIdIndex ? accounts.clientIdIndex(server).get(id.toLowerCase()) : undefined;
    if (accountId === undefined || accountId === null) throw new HttpError(403, "not_an_account", "That player has no havoc9.org account.");
    const row = store.online(accountId, server);
    if (!row || row.plugin_at === null) throw new HttpError(403, "not_here", "That account is not in game on this server.");
    const account = accounts.getById(accountId);
    if (!account) throw new HttpError(403, "not_an_account", "That player has no havoc9.org account.");
    return { account, row, verified: row.proven === 1 || row.relay === 1 };
  }

  router.post("/api/presence/server/chat", async (req, res, rc) => {
    limit("serverCallsPerIp", ipKey(rc.ip));
    const { server, body } = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes: 4096 });
    limit("chatPerServer", server);
    const c = communityOfServer(server);
    if (!c) throw new HttpError(403, "no_community", "This server is in no community.");
    if (c.chat !== 1) throw new HttpError(403, "chat_off", "This community's chat is off.");
    const who = presentAccount(server, body.id);
    if (c.chat_proof === 1 && !who.verified) throw new HttpError(403, "unverified", "This community's chat needs a game that proves the player id.");
    if (sanctioned(who.account.id, c.id, "ban") || sanctioned(who.account.id, c.id, "mute")) throw new HttpError(403, "muted", "Muted.");
    limit("chatPerAccount", "a:" + who.account.id);
    cooldown(who.account.id);
    const text = chatText(body.text, s.chatMaxChars);
    if (!text) throw new HttpError(400, "bad_request", "Nothing to say.");
    const id = post(c, { kind: "chat", source: "game", server, tag: c.tag, account: who.account, name: who.account.username, text });
    rc.json(200, { ok: true, id, line: "[" + c.tag + "] " + who.account.username + ": " + text });
  }, { csrf: false });

  // ---- find --------------------------------------------------------------------------------------

  router.post("/api/presence/server/find", async (req, res, rc) => {
    limit("serverCallsPerIp", ipKey(rc.ip));
    const { server, body } = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes: 2048 });
    limit("findPerServer", server);
    const name = cleanText(body.q, 32);
    if (!name) throw new HttpError(400, "bad_request", "Who? { q: name }");
    const c = communityOfServer(server);
    const ids = [];
    const exact = accounts.getByUsername(name);
    if (exact) ids.push(exact.id);
    for (const r of q.findPrefix.all(name.toLowerCase().replace(/[!%_]/g, "!$&") + "%")) if (!ids.includes(r.id)) ids.push(r.id);
    const results = [];
    for (const id of ids.slice(0, 5)) {
      const a = accounts.getById(id);
      if (!a) continue;
      const place = deps.publicPlace(a.id);
      const cs = place && place.server ? q.serverRow.get(place.server) : null;
      results.push({
        username: a.username, state: place ? place.state : "offline",
        server: place && place.server ? place.name : null, address: place && place.server ? place.server : null,
        tag: cs ? cs.tag : null, community: !!(c && cs && cs.community_id === c.id),
      });
    }
    results.sort((x, y) => (y.community === x.community ? 0 : y.community ? 1 : -1));
    rc.json(200, { ok: true, results });
  }, { csrf: false });

  // ---- shared data -------------------------------------------------------------------------------

  function dataView(r) {
    return r ? { value: r.value, version: r.version, updated: iso(r.updated_at) } : { value: null, version: 0, updated: null };
  }

  router.post("/api/presence/server/data/get", async (req, res, rc) => {
    limit("serverCallsPerIp", ipKey(rc.ip));
    const { server, body } = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes: 4096 });
    limit("dataReadPerServer", server);
    const c = communityOfServer(server);
    if (!c) throw new HttpError(403, "no_community", "This server is in no community.");
    let account;
    if (body.id !== undefined) account = presentAccount(server, body.id).account;
    else account = accountOrThrow(body.account);
    const keys = Array.isArray(body.keys) ? body.keys : [body.key];
    if (!keys.length || keys.length > 16 || keys.some((k) => typeof k !== "string" || !DATA_KEY.test(k))) {
      throw new HttpError(400, "bad_request", "keys: 1 to 16 names of a to z, 0 to 9, _ . - (32 at most).");
    }
    const values = {};
    for (const k of keys) values[k] = dataView(q.data.get(c.id, account.id, k));
    rc.json(200, { ok: true, account: account.username, values });
  }, { csrf: false });

  router.post("/api/presence/server/data/set", async (req, res, rc) => {
    limit("serverCallsPerIp", ipKey(rc.ip));
    const { server, body } = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes: 4096 });
    limit("dataWritePerServer", server);
    const c = communityOfServer(server);
    if (!c) throw new HttpError(403, "no_community", "This server is in no community.");
    if (c.readOnly) throw new HttpError(403, "read_only", "This server may only read its community's data.");
    const who = presentAccount(server, body.id);
    if (c.data_proof === 1 && !who.verified) throw new HttpError(403, "unverified", "This community's data needs a game that proves the player id.");
    if (sanctioned(who.account.id, c.id, "ban")) throw new HttpError(403, "banned", "Banned.");
    const key = body.key;
    if (typeof key !== "string" || !DATA_KEY.test(key)) throw new HttpError(400, "bad_request", "key: a to z, 0 to 9, _ . - (32 at most).");
    const value = body.value;
    if (value !== null && (typeof value !== "string" || Buffer.byteLength(value) > s.dataValueMax)) {
      throw new HttpError(413, "too_large", "A value is a string of at most " + s.dataValueMax + " bytes, or null to delete.");
    }
    if (body.version !== undefined && !(Number.isSafeInteger(body.version) && body.version >= 0)) throw new HttpError(400, "bad_request", "version: the version you read (0: not there yet).");
    limit("dataWritePerAccount", c.id + ":" + who.account.id);
    const t = now();
    let out;
    tx(() => {
      const cur = q.data.get(c.id, who.account.id, key);
      const curVersion = cur ? cur.version : 0;
      if (body.version !== undefined && body.version !== curVersion) {
        out = { status: 409, body: { error: "conflict", message: "Changed since you read it.", value: cur ? cur.value : null, version: curVersion } };
        return;
      }
      if (!cur && value !== null) {
        if (q.dataCount.get(c.id, who.account.id).n >= s.dataKeysPerAccount) {
          out = { status: 413, body: { error: "too_many_keys", message: "At most " + s.dataKeysPerAccount + " keys per account." } };
          return;
        }
        if (q.dataRows.get(c.id).n >= s.dataRowsPerCommunity) {
          out = { status: 507, body: { error: "community_full", message: "This community's store is full." } };
          return;
        }
      }
      const version = curVersion + 1;
      if (value === null) {
        if (cur) q.dataDelete.run(c.id, who.account.id, key);
      } else {
        q.dataPut.run(c.id, who.account.id, key, value, version, t, server);
      }
      q.dataLogAdd.run(c.id, who.account.id, key, cur ? cur.value : null, value, curVersion, value === null && !cur ? 0 : version, server, t);
      out = { status: 200, body: { ok: true, version: value === null ? 0 : version } };
    });
    rc.json(out.status, out.body);
  }, { csrf: false });

  // ---- the link code a server shows in its console -----------------------------------------------

  router.post("/api/presence/server/claim", async (req, res, rc) => {
    limit("serverCallsPerIp", ipKey(rc.ip));
    const { server } = await serverAuth.verify(req, (srv) => enrollment.candidates(srv), { maxBytes: 2048 });
    limit("claimPerServer", server);
    const code = claimCode();
    q.claimAdd.run(sha256(code), server, now() + s.claimMinutes * 60);
    rc.json(200, { ok: true, code, minutes: s.claimMinutes });
  }, { csrf: false });

  // ---- the site ----------------------------------------------------------------------------------

  const staffRoute = (handler) => auth.requireSession(async (req, res, rc) => {
    limit("communityPerAccount", "a:" + rc.account.id);
    return handler(req, res, rc);
  });

  function communityView(c, viewer) {
    return {
      slug: c.slug, name: c.name, created: iso(c.created_at),
      owner: c.owner_id ? (accounts.getById(c.owner_id) || {}).username || null : null,
      staff: q.staff.all(c.id).map((r) => r.username),
      chat: c.chat === 1, chatProof: c.chat_proof === 1, dataProof: c.data_proof === 1,
      servers: serversView(c, deps.nowView),
      me: viewer ? { signedIn: true, staff: isStaff(viewer, c), owner: isOwner(viewer, c) } : { signedIn: false },
    };
  }

  router.get("/api/presence/communities", async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    rc.json(200, { communities: q.communities.all().map((c) => ({ slug: c.slug, name: c.name, owner: c.owner, servers: c.servers })) });
  });

  router.post("/api/presence/communities", staffRoute(async (req, res, rc) => {
    const body = await rc.body();
    const slug = String(body.slug || "").trim().toLowerCase();
    const name = cleanText(body.name, 40);
    if (!SLUG.test(slug)) throw new HttpError(400, "bad_slug", "The short name: 3 to 32 of a to z, 0 to 9 and -, starting with a letter or digit.");
    if (!name) throw new HttpError(400, "bad_request", "Give it a name.");
    if (!isSiteAdmin(rc.account) && q.ownedBy.get(rc.account.id).n >= s.communitiesPerAccount) {
      throw new HttpError(409, "too_many", "An account owns at most " + s.communitiesPerAccount + " communities.");
    }
    try {
      q.insertCommunity.run(slug, name, rc.account.id, now());
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, "taken", "That short name is taken.");
      throw e;
    }
    const c = q.community.get(slug);
    record(rc, "community.create", c, "community " + slug, name);
    rc.json(201, communityView(c, rc.account));
  }));

  router.get("/api/presence/communities/:slug", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    rc.json(200, communityView(communityOrThrow(rc.params.slug), rc.account));
  }));

  router.patch("/api/presence/communities/:slug", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const body = await rc.body();
    const name = body.name !== undefined ? cleanText(body.name, 40) : c.name;
    if (!name) throw new HttpError(400, "bad_request", "Give it a name.");
    const flag = (v, cur) => (v === undefined ? cur : v === true ? 1 : v === false ? 0 : null);
    const chat = flag(body.chat, c.chat);
    const chatProof = flag(body.chatProof, c.chat_proof);
    const dataProof = flag(body.dataProof, c.data_proof);
    if ([chat, chatProof, dataProof].includes(null)) throw new HttpError(400, "bad_request", "chat, chatProof and dataProof are true or false.");
    q.updateCommunity.run(name, chat, chatProof, dataProof, c.id);
    record(rc, "community.settings", c, "community " + c.slug, JSON.stringify({ name, chat, chatProof, dataProof }));
    rc.json(200, communityView(q.communityById.get(c.id), rc.account));
  }));

  router.delete("/api/presence/communities/:slug", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustOwner(rc.account, c);
    const body = await rc.body({ optional: true });
    if (String(body.confirm || "").toLowerCase() !== c.slug) throw new HttpError(400, "confirm", "Type the community's short name in confirm.");
    q.deleteCommunity.run(c.id);
    record(rc, "community.delete", c, "community " + c.slug);
    rc.json(200, { ok: true });
  }));

  router.post("/api/presence/communities/:slug/claim", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const body = await rc.body();
    const code = String(body.code || "").trim().toLowerCase();
    const tag = String(body.tag || "").trim();
    if (!TAG.test(tag)) throw new HttpError(400, "bad_tag", "A tag: 1 to 12 letters, digits, space, _ . -");
    const claim = q.claim.get(sha256(code), now());
    if (!claim) throw new HttpError(404, "bad_code", "That code is wrong or has run out. Ask the server for a new one.");
    const linked = q.serverRow.get(claim.server);
    if (linked && linked.community_id !== c.id) throw new HttpError(409, "linked_elsewhere", "That server is in another community. Its owner unlinks it first.");
    tx(() => {
      q.claimUse.run(claim.code_hash);
      if (linked) q.updateServer.run(tag, linked.read_only, claim.server);
      else q.link.run(claim.server, c.id, tag, now(), rc.account.id);
    });
    record(rc, "community.server.link", c, "server " + enrollment.serverIdFor(claim.server), claim.server + " as " + tag);
    rc.json(200, communityView(c, rc.account));
  }));

  function communityServer(c, serverId) {
    const e = enrollment.byServerId(serverId);
    const r = e ? q.serverRow.get(e.server) : null;
    if (!r || r.community_id !== c.id) throw new HttpError(404, "not_found", "No such server in this community.");
    return r;
  }

  router.post("/api/presence/communities/:slug/servers/:serverId", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const r = communityServer(c, rc.params.serverId);
    const body = await rc.body();
    const tag = body.tag !== undefined ? String(body.tag).trim() : r.tag;
    if (!TAG.test(tag)) throw new HttpError(400, "bad_tag", "A tag: 1 to 12 letters, digits, space, _ . -");
    if (body.readOnly !== undefined && typeof body.readOnly !== "boolean") throw new HttpError(400, "bad_request", "readOnly is true or false.");
    const ro = body.readOnly === undefined ? r.read_only : body.readOnly ? 1 : 0;
    q.updateServer.run(tag, ro, r.server);
    record(rc, "community.server.update", c, "server " + rc.params.serverId, "tag " + tag + (ro ? ", read-only" : ""));
    rc.json(200, communityView(c, rc.account));
  }));

  router.delete("/api/presence/communities/:slug/servers/:serverId", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const r = communityServer(c, rc.params.serverId);
    q.unlink.run(r.server);
    record(rc, "community.server.unlink", c, "server " + rc.params.serverId);
    rc.json(200, communityView(c, rc.account));
  }));

  router.post("/api/presence/communities/:slug/staff", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustOwner(rc.account, c);
    const body = await rc.body();
    const a = accountOrThrow(body.username);
    q.addStaff.run(c.id, a.id, rc.account.id, now());
    record(rc, "community.staff.add", c, "community " + c.slug, null, a);
    rc.json(200, communityView(c, rc.account));
  }));

  router.delete("/api/presence/communities/:slug/staff/:username", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustOwner(rc.account, c);
    const a = accountOrThrow(rc.params.username);
    q.removeStaff.run(c.id, a.id);
    record(rc, "community.staff.remove", c, "community " + c.slug, null, a);
    rc.json(200, communityView(c, rc.account));
  }));

  // Sanctions: ban and mute stay until revoked or until "days"; kick is once, on the account's
  // next report anywhere in the scope (within an hour).
  function sanctionsView(communityId) {
    const t = now();
    return q.sanctionsOf.all(communityId).map((r) => ({
      id: r.id, username: r.username, kind: r.kind, reason: r.reason, by: r.by_name, created: iso(r.created_at), until: iso(r.until),
      active: !r.revoked_at && (!r.until || r.until > t), revoked: iso(r.revoked_at),
    }));
  }

  async function addSanction(rc, c) {
    const body = await rc.body();
    const a = accountOrThrow(body.username);
    if (!["ban", "mute", "kick"].includes(body.kind)) throw new HttpError(400, "bad_request", "kind is ban, mute or kick.");
    const reason = reasonText(body.reason);
    if (body.days !== undefined && !(Number.isInteger(body.days) && body.days >= 1 && body.days <= 3650)) throw new HttpError(400, "bad_request", "days: 1 to 3650, or none for until revoked.");
    if (c && isOwner(a, c) && !isSiteAdmin(rc.account)) throw new HttpError(403, "forbidden", "Not the owner.");
    if (isSiteAdmin(a) && !isSiteAdmin(rc.account)) throw new HttpError(403, "forbidden", "Not an H9 admin.");
    const t = now();
    const cid = c ? c.id : null;
    let id;
    if (body.kind === "kick") id = Number(q.kickAdd.run(cid, a.id, reason || null, t).lastInsertRowid);
    else id = Number(q.sanctionAdd.run(cid, a.id, body.kind, reason || null, rc.account.id, t, body.days ? t + body.days * 86400 : null).lastInsertRowid);
    askReports(cid);
    record(rc, (c ? "community" : "presence") + ".sanction." + body.kind, c, c ? "community " + c.slug : "H9-wide", reason + (body.days ? " (" + body.days + " days)" : ""), a);
    return id;
  }

  async function revokeSanction(rc, c) {
    const r = q.sanctionGet.get(Number(rc.params.id));
    if (!r || (c ? r.community_id !== c.id : r.community_id !== null)) throw new HttpError(404, "not_found", "No such sanction here.");
    q.sanctionRevoke.run(now(), rc.account.id, r.id);
    askReports(c ? c.id : null);
    record(rc, (c ? "community" : "presence") + ".sanction.revoke", c, "sanction " + r.id, r.kind, accounts.getById(r.account_id));
  }

  router.get("/api/presence/communities/:slug/sanctions", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    rc.json(200, { sanctions: sanctionsView(c.id) });
  }));
  router.post("/api/presence/communities/:slug/sanctions", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const id = await addSanction(rc, c);
    rc.json(201, { ok: true, id, sanctions: sanctionsView(c.id) });
  }));
  router.post("/api/presence/communities/:slug/sanctions/:id/revoke", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    await revokeSanction(rc, c);
    rc.json(200, { ok: true, sanctions: sanctionsView(c.id) });
  }));

  router.post("/api/presence/communities/:slug/announce", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const body = await rc.body();
    const text = chatText(body.text, s.chatMaxChars);
    if (!text) throw new HttpError(400, "bad_request", "Nothing to announce.");
    const id = post(c, { kind: "announce", source: "admin", tag: cleanText(c.name, 20) || c.slug, account: rc.account, name: rc.account.username, text });
    record(rc, "community.announce", c, "community " + c.slug, text);
    rc.json(201, { ok: true, id });
  }));

  // the web chatbox
  router.get("/api/presence/communities/:slug/chat", auth.requireSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const c = communityOrThrow(rc.params.slug);
    const since = Math.max(0, Number.parseInt(rc.query.get("since") || "0", 10) || 0);
    const rows = q.forWeb.all(since, now() - s.chatRetentionDays * 86400, c.id).reverse();
    rc.json(200, {
      chat: c.chat === 1, staff: isStaff(rc.account, c), last: rows.length ? rows[rows.length - 1].id : since,
      messages: rows.map((m) => ({ id: m.id, kind: m.kind, source: m.source, tag: m.tag, name: m.name, text: m.text, at: iso(m.created_at) })),
    });
  }));
  router.post("/api/presence/communities/:slug/chat", auth.requireSession(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    if (c.chat !== 1) throw new HttpError(403, "chat_off", "This community's chat is off.");
    if (sanctioned(rc.account.id, c.id, "ban") || sanctioned(rc.account.id, c.id, "mute")) throw new HttpError(403, "muted", "You are muted in this community.");
    limit("chatWebPerAccount", "a:" + rc.account.id);
    cooldown(rc.account.id);
    const body = await rc.body();
    const text = chatText(body.text, s.chatMaxChars);
    if (!text) throw new HttpError(400, "bad_request", "Nothing to say.");
    const id = post(c, { kind: "chat", source: "web", tag: "Web", account: rc.account, name: rc.account.username, text });
    rc.json(201, { ok: true, id });
  }));
  router.delete("/api/presence/communities/:slug/chat/:id", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const m = q.messageGet.get(Number(rc.params.id));
    if (!m || m.community_id !== c.id) throw new HttpError(404, "not_found", "No such message here.");
    q.messageDelete.run(now(), rc.account.id, m.id);
    record(rc, "community.chat.delete", c, "message " + m.id, m.name + ": " + m.text);
    rc.json(200, { ok: true });
  }));

  // the shared data's history, and putting it back
  router.get("/api/presence/communities/:slug/data/log", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const who = rc.query.get("username") ? accountOrThrow(rc.query.get("username")) : null;
    const id = who ? who.id : null;
    rc.json(200, { log: q.dataLog.all(c.id, id, id).map((r) => ({ id: r.id, username: r.username, key: r.key, old: r.old_value, value: r.new_value, version: r.new_version, server: r.server, at: iso(r.at) })) });
  }));
  router.post("/api/presence/communities/:slug/data/rollback", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustOwner(rc.account, c);
    const body = await rc.body();
    const to = Date.parse(body.to);
    if (!Number.isFinite(to)) throw new HttpError(400, "bad_request", "to: the time to go back to (ISO 8601).");
    const at = Math.floor(to / 1000);
    if (at < now() - s.dataLogRetentionDays * 86400) throw new HttpError(400, "too_old", "The history goes back " + s.dataLogRetentionDays + " days.");
    const who = body.username ? accountOrThrow(body.username) : null;
    const id = who ? who.id : null;
    const t = now();
    let restored = 0;
    tx(() => {
      const first = new Map(); // account + key -> the first change after `to`: what was there then
      for (const r of q.dataSince.all(c.id, at, id, id)) {
        const k = r.account_id + "\u0000" + r.key;
        if (!first.has(k)) first.set(k, r);
      }
      for (const r of first.values()) {
        const cur = q.data.get(c.id, r.account_id, r.key);
        const curVersion = cur ? cur.version : 0;
        if (r.old_value === null) {
          if (cur) q.dataDelete.run(c.id, r.account_id, r.key);
        } else {
          q.dataPut.run(c.id, r.account_id, r.key, r.old_value, curVersion + 1, t, "rollback");
        }
        q.dataLogAdd.run(c.id, r.account_id, r.key, cur ? cur.value : null, r.old_value, curVersion, r.old_value === null ? 0 : curVersion + 1, "rollback", t);
        restored++;
      }
    });
    record(rc, "community.data.rollback", c, "community " + c.slug, "to " + new Date(to).toISOString() + (who ? " for " + who.username : "") + ", " + restored + " keys", who);
    rc.json(200, { ok: true, restored });
  }));

  // ---- H9's site admins --------------------------------------------------------------------------

  const adminRoute = (handler) => auth.requireRole("admin", async (req, res, rc) => {
    limit("adminPerAccount", "a:" + rc.account.id);
    return handler(req, res, rc);
  });
  router.get("/api/presence/admin/sanctions", adminRoute(async (req, res, rc) => rc.json(200, { sanctions: sanctionsView(null) })));
  router.post("/api/presence/admin/sanctions", adminRoute(async (req, res, rc) => {
    const id = await addSanction(rc, null);
    rc.json(201, { ok: true, id, sanctions: sanctionsView(null) });
  }));
  router.post("/api/presence/admin/sanctions/:id/revoke", adminRoute(async (req, res, rc) => {
    await revokeSanction(rc, null);
    rc.json(200, { ok: true, sanctions: sanctionsView(null) });
  }));
  router.post("/api/presence/admin/announce", adminRoute(async (req, res, rc) => {
    const body = await rc.body();
    const text = chatText(body.text, s.chatMaxChars);
    if (!text) throw new HttpError(400, "bad_request", "Nothing to announce.");
    const id = post(null, { kind: "announce", source: "admin", tag: "H9", account: rc.account, name: rc.account.username, text });
    record(rc, "presence.announce", null, "H9-wide", text);
    rc.json(201, { ok: true, id });
  }));

  function sweep(t) {
    q.messagePrune.run(t - s.chatRetentionDays * 86400);
    q.dataLogPrune.run(t - s.dataLogRetentionDays * 86400);
    q.claimPrune.run(t);
    q.kickPrune.run(t - 86400);
  }

  function stop() {
    for (const w of [...waiters.values()]) w.finish();
  }

  return { reportActions, sanctioned, communityOfServer, sweep, stop };
}
