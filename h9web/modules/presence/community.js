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
//   PATCH  /api/presence/communities/:slug              staff: { name, chat, chatProof, dataProof, joinMode,
//                                                       visibility, whitelist, whitelistProof }; the owner
//                                                       also chatOpen (the web chat open to every account)
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
//   GET    /api/presence/communities/:slug/chat?since=N members (with chatOpen, every account signed in)
//   POST   /api/presence/communities/:slug/chat         the same: { text }
//   DELETE /api/presence/communities/:slug/chat/:id     staff
//   GET    /api/presence/communities/:slug/data/log     staff: ?username=
//   POST   /api/presence/communities/:slug/data/rollback   owner: { to, username }
// Membership (the owner and its admins always belong):
//   POST   /api/presence/communities/:slug/join         signed in: join (open), ask (request), or
//                                                       take an invitation (any mode)
//   POST   /api/presence/communities/:slug/leave        signed in: leave, or withdraw a request
//   POST   /api/presence/communities/:slug/invitation/decline   the invited account
//   GET    /api/presence/communities/:slug/members      members: the list; staff also requests, invites
//   POST   /api/presence/communities/:slug/requests/:username/approve | refuse   staff
//   POST   /api/presence/communities/:slug/invites      staff: { username }
//   DELETE /api/presence/communities/:slug/invites/:username   staff
//   DELETE /api/presence/communities/:slug/members/:username   staff (an admin: the owner only)
// H9's site admins, H9-wide:
//   PUT  /api/presence/communities/:slug/discord   { channel }  bridge the community's chat with a
//                                       Discord channel (null: no bridge), through the discord module
//   GET  /api/presence/admin/sanctions   POST /api/presence/admin/sanctions   (as above)
//   POST /api/presence/admin/sanctions/:id/revoke   POST /api/presence/admin/announce { text }
// Every staff and admin action goes into the audit log, member changes by staff included.
//
// Visibility: listed (on the list), unlisted (by link), private (members and H9's site admins only;
// its servers are left out of the public lists, the site's server board and /find for anyone not a
// member). Members-only servers (whitelist): the answer to a report kicks whoever is not a member.
// The web chat is the members'; the owner may open it to every signed-in account (chatOpen), except
// in a private community.
// The Discord bridge (docs\H9_COMMUNITIES.txt section 4a): an H9 site admin names a Discord channel
// for a community; every chat line and announcement of the community but Discord's own goes there
// ("discord-relay-out"), and the channel's lines come back ("discord-relay-in") as [Discord] lines
// to every server on the community's relay and to the web chat. The discord module, which alone
// holds the bot's token, does the talking to Discord.

import crypto from "node:crypto";
import { cleanText } from "./modes.js";

const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;
const CHANNEL = /^[0-9]{17,20}$/;
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

// A members-only server's kick message: as reasonText, with / and = for the join link, and longer.
// h9_presence 1.2 keeps both in the reason it hands the kick command.
export function kickText(value) {
  return String(value || "").replace(/[^A-Za-z0-9 .,:!?()\/=-]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

const JOIN_MODES = ["open", "request", "invite"];
const VISIBILITIES = ["listed", "unlisted", "private"];

function claimCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CLAIM_ALPHABET[b[i] % CLAIM_ALPHABET.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

export function createCommunity(deps) {
  const { db, s, log, router, auth, accounts, serverAuth, enrollment, limit, ipKey, audit, store } = deps;
  const events = deps.events || null;
  const { HttpError } = deps.http;
  const now = deps.now;
  const tx = deps.transaction;

  const q = {
    community: db.prepare("SELECT * FROM presence_communities WHERE slug = ?"),
    communityById: db.prepare("SELECT * FROM presence_communities WHERE id = ?"),
    communities: db.prepare(`SELECT c.*, a.username AS owner, (SELECT count(*) FROM presence_community_servers x WHERE x.community_id = c.id) AS servers,
      (SELECT count(*) FROM presence_community_members m WHERE m.community_id = c.id) AS members
      FROM presence_communities c LEFT JOIN accounts a ON a.id = c.owner_id WHERE c.visibility = 'listed' ORDER BY c.name COLLATE NOCASE LIMIT 500`),
    mine: db.prepare(`SELECT c.*, (SELECT count(*) FROM presence_community_members m WHERE m.community_id = c.id) AS members FROM presence_communities c
      WHERE c.owner_id = ? OR EXISTS (SELECT 1 FROM presence_community_members m WHERE m.community_id = c.id AND m.account_id = ?)
      OR EXISTS (SELECT 1 FROM presence_community_staff s WHERE s.community_id = c.id AND s.account_id = ?) ORDER BY c.name COLLATE NOCASE LIMIT 100`),
    invitationsOf: db.prepare(`SELECT c.slug, c.name, i.created_at, b.username AS by_name FROM presence_community_invites i
      JOIN presence_communities c ON c.id = i.community_id LEFT JOIN accounts b ON b.id = i.invited_by WHERE i.account_id = ? ORDER BY i.created_at DESC LIMIT 100`),
    requestsOf: db.prepare(`SELECT c.slug, c.name, r.created_at FROM presence_community_requests r JOIN presence_communities c ON c.id = r.community_id
      WHERE r.account_id = ? ORDER BY r.created_at DESC LIMIT 100`),
    member: db.prepare("SELECT 1 AS k FROM presence_community_members WHERE community_id = ? AND account_id = ?"),
    memberAdd: db.prepare("INSERT OR IGNORE INTO presence_community_members (community_id, account_id, joined_at, added_by) VALUES (?, ?, ?, ?)"),
    memberRemove: db.prepare("DELETE FROM presence_community_members WHERE community_id = ? AND account_id = ?"),
    memberCount: db.prepare("SELECT count(*) AS n FROM presence_community_members WHERE community_id = ?"),
    membersOf: db.prepare(`SELECT m.account_id, m.joined_at, a.username FROM presence_community_members m JOIN accounts a ON a.id = m.account_id
      WHERE m.community_id = ? ORDER BY a.username_key LIMIT 2000`),
    request: db.prepare("SELECT * FROM presence_community_requests WHERE community_id = ? AND account_id = ?"),
    requestAdd: db.prepare("INSERT OR IGNORE INTO presence_community_requests (community_id, account_id, created_at) VALUES (?, ?, ?)"),
    requestRemove: db.prepare("DELETE FROM presence_community_requests WHERE community_id = ? AND account_id = ?"),
    requestsFor: db.prepare(`SELECT r.created_at, a.username FROM presence_community_requests r JOIN accounts a ON a.id = r.account_id
      WHERE r.community_id = ? ORDER BY r.created_at LIMIT 500`),
    invite: db.prepare("SELECT * FROM presence_community_invites WHERE community_id = ? AND account_id = ?"),
    inviteAdd: db.prepare("INSERT OR REPLACE INTO presence_community_invites (community_id, account_id, invited_by, created_at) VALUES (?, ?, ?, ?)"),
    inviteRemove: db.prepare("DELETE FROM presence_community_invites WHERE community_id = ? AND account_id = ?"),
    invitesFor: db.prepare(`SELECT i.created_at, a.username, b.username AS by_name FROM presence_community_invites i JOIN accounts a ON a.id = i.account_id
      LEFT JOIN accounts b ON b.id = i.invited_by WHERE i.community_id = ? ORDER BY i.created_at LIMIT 500`),
    ownedBy: db.prepare("SELECT count(*) AS n FROM presence_communities WHERE owner_id = ?"),
    insertCommunity: db.prepare("INSERT INTO presence_communities (slug, name, owner_id, created_at) VALUES (?, ?, ?, ?)"),
    updateCommunity: db.prepare(`UPDATE presence_communities SET name = ?, chat = ?, chat_proof = ?, data_proof = ?, join_mode = ?, visibility = ?,
      whitelist = ?, whitelist_proof = ?, chat_open = ? WHERE id = ?`),
    byDiscord: db.prepare("SELECT * FROM presence_communities WHERE discord_channel = ?"),
    discordAll: db.prepare("SELECT discord_channel, discord_last FROM presence_communities WHERE discord_channel IS NOT NULL"),
    setDiscord: db.prepare("UPDATE presence_communities SET discord_channel = ?, discord_by = ?, discord_at = ?, discord_last = NULL WHERE id = ?"),
    discordLast: db.prepare("UPDATE presence_communities SET discord_last = ? WHERE id = ?"),
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

  // Members: the owner and the admins always; everyone else by a row in presence_community_members.
  // H9's site admins are not members, but may see and do whatever a member may.
  const belongs = (accountId, c) => !!accountId && (c.owner_id === accountId || !!q.member.get(c.id, accountId) || !!q.isStaff.get(c.id, accountId));
  const mustMember = (account, c) => {
    if (!account || !(belongs(account.id, c) || isSiteAdmin(account))) throw new HttpError(403, "members_only", "Only this community's members may do that.");
  };
  // The web chat: members and H9's site admins; while the owner keeps it open (chat_open), every
  // signed-in account too, except in a private community.
  const mayWebChat = (account, c) => !!account && ((c.chat_open === 1 && c.visibility !== "private") || belongs(account.id, c) || isSiteAdmin(account));
  const mustWebChat = (account, c) => {
    if (!mayWebChat(account, c)) throw new HttpError(403, "members_only", "Only this community's members may use its chat.");
  };

  function communityOfServer(server) {
    const cs = q.serverRow.get(server);
    if (!cs) return null;
    const c = q.communityById.get(cs.community_id);
    return c ? { ...c, tag: cs.tag, readOnly: cs.read_only === 1 } : null;
  }

  // A private community's server, left out of the public lists and of /find for non-members.
  function privateCommunityOf(server) {
    const c = communityOfServer(server);
    return c && c.visibility === "private" ? c : null;
  }

  // Whether the server is members-only: the answer to its reports says so ("members": true), and
  // the plugin then lists its players with no usable h9_clientid too, by slot.
  function membersOnly(server) {
    const c = communityOfServer(server);
    return !!(c && c.whitelist === 1);
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
  // account, a waiting one-off kick, or anyone a members-only server turns away; { mute: true }
  // for a muted account. entries: [{ slot, accountId, device, proven }] for every player the report
  // listed with a slot; accountId is null for one whose h9_clientid is no account's, or who had
  // none (listed by slot alone, which the plugin does on a members-only server).
  function reportActions(server, entries) {
    const c = communityOfServer(server);
    const cid = c ? c.id : null;
    const gate = !!(c && c.whitelist === 1);
    const t = now();
    const out = {};
    for (const e of entries) {
      if (!e.slot) continue;
      if (e.accountId) {
        const ban = sanctioned(e.accountId, cid, "ban", e.device);
        if (ban) {
          out[e.slot] = { kick: reasonText("Banned" + (ban.community_id ? " from " + (c ? c.name : "this community") : " from H9") + (ban.reason ? ": " + ban.reason : "")) };
          continue;
        }
      }
      if (gate) {
        const refusal = gateRefusal(c, e);
        if (refusal) {
          out[e.slot] = { kick: refusal };
          continue;
        }
      }
      if (!e.accountId) continue;
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

  // A members-only server's answer for one player: null to let in, else the kick's reason. The
  // owner, the community's admins and H9's site admins always get in as members; with
  // whitelist_proof every one of them needs a game that proved the player id (proven: the
  // plugin's proof, or the web client's relay), since an h9_clientid alone can be copied.
  function gateRefusal(c, e) {
    const forMembers = kickText("This server is for members of " + c.name + ". Join at havoc9.org/community/?c=" + c.slug);
    const account = e.accountId ? accounts.getById(e.accountId) : null;
    if (!account) return forMembers;
    if (!(belongs(account.id, c) || isStaff(account, c))) return forMembers;
    if (c.whitelist_proof === 1 && !e.proven) return kickText("This server is for members of " + c.name + " whose game proves their H9 id.");
    return null;
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

  // The community's servers, with who is on each as each player's switches allow (deps.playersOn
  // counts a private community's servers too: only its members and site admins see this).
  function serversView(c) {
    if (!c) return [];
    return q.serversOf.all(c.id).map((r) => {
      const info = deps.serverInfo(r.server);
      return {
        serverId: enrollment.serverIdFor(r.server), tag: r.tag, address: r.server, name: info.name, map: info.map, mode: info.mode,
        humans: info.humans, max: info.max, bots: info.bots, readOnly: r.read_only === 1, players: deps.playersOn(r.server),
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
      servers: serversView(c),
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
    // the community's Discord channel, when one is bridged: every line but those from Discord
    if (c && c.discord_channel && source !== "discord" && events) {
      events.emit("discord-relay-out", { channel: c.discord_channel, kind, tag, name, text });
    }
    return id;
  }

  // ---- the Discord bridge ------------------------------------------------------------------------

  const relayStatus = new Map(); // channel -> { ok, error, at }: how the channel last answered

  // the bridged channels, for the discord module to read, each from the last message relayed
  function discordWatch() {
    if (!events) return;
    events.emit("discord-relay-watch", { channels: q.discordAll.all().map((r) => ({ channel: r.discord_channel, after: r.discord_last || null })) });
  }

  // A person's line in a bridged channel: to every server on the community's relay and to its web
  // chat, as [Discord] name: text, with the game chat's own cleaning. Lines older than 10 minutes (a
  // gap while h9web was down) and lines past discordInPerCommunity are dropped.
  function fromDiscord(m) {
    if (!m || typeof m.channel !== "string") return;
    const c = q.byDiscord.get(m.channel);
    if (!c) return;
    if (typeof m.id === "string" && /^[0-9]{1,20}$/.test(m.id)) q.discordLast.run(m.id, c.id);
    if (c.chat !== 1) return;
    if (Number.isFinite(m.at) && now() - m.at > 600) return;
    try {
      limit("discordInPerCommunity", "c:" + c.id);
    } catch (e) {
      return;
    }
    const text = chatText(m.text, s.chatMaxChars);
    const name = chatText(m.name, 32).replace(/[\[\]:]/g, "").trim() || "someone";
    if (!text) return;
    post(c, { kind: "chat", source: "discord", tag: "Discord", account: null, name, text });
  }

  const relayListeners = {
    "discord-relay-in": (m) => {
      try {
        fromDiscord(m);
      } catch (e) {
        log.warn("presence.discord_in", { error: e.message });
      }
    },
    "discord-relay-ready": () => discordWatch(),
    "discord-relay-status": (e) => {
      if (e && typeof e.channel === "string") relayStatus.set(e.channel, { ok: !!e.ok, error: e.error || null, at: iso(now()) });
    },
  };
  if (events) for (const [name, fn] of Object.entries(relayListeners)) events.on(name, fn);
  discordWatch();

  // H9's site admins bridge a community's chat with a Discord channel, by its id, or stop it (null).
  router.put("/api/presence/communities/:slug/discord", auth.requireRole("admin", async (req, res, rc) => {
    limit("communityPerAccount", "a:" + rc.account.id);
    const c = communityOrThrow(rc.params.slug);
    const body = await rc.body();
    const channel = body.channel === null || body.channel === "" ? null : typeof body.channel === "string" ? body.channel.trim() : undefined;
    if (channel === undefined || (channel !== null && !CHANNEL.test(channel))) {
      throw new HttpError(400, "bad_request", "channel is the Discord channel's id (17 to 20 digits), or null for no bridge.");
    }
    if (channel) {
      const other = q.byDiscord.get(channel);
      if (other && other.id !== c.id) throw new HttpError(409, "in_use", "That channel is bridged with " + other.name + " already.");
    }
    q.setDiscord.run(channel, channel ? rc.account.id : null, channel ? now() : null, c.id);
    record(rc, "community.discord", c, "community " + c.slug, channel ? "bridged with Discord channel " + channel : "no Discord bridge");
    discordWatch();
    rc.json(200, communityView(q.communityById.get(c.id), rc.account));
  }));

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
    // who asks: optional, the asking player's h9_clientid, an account in game on this server. A
    // private community's servers show only to its members.
    let asker = null;
    if (body.id !== undefined) {
      try {
        asker = presentAccount(server, body.id).account;
      } catch (e) {
        asker = null;
      }
    }
    const ids = [];
    const exact = accounts.getByUsername(name);
    if (exact) ids.push(exact.id);
    for (const r of q.findPrefix.all(name.toLowerCase().replace(/[!%_]/g, "!$&") + "%")) if (!ids.includes(r.id)) ids.push(r.id);
    const results = [];
    for (const id of ids.slice(0, 5)) {
      const a = accounts.getById(id);
      if (!a) continue;
      const place = deps.publicPlace(a.id);
      let shown = place && place.server ? place.server : null;
      const hidden = shown ? privateCommunityOf(shown) : null;
      if (hidden && !(asker && (belongs(asker.id, hidden) || isSiteAdmin(asker)))) shown = null;
      const cs = shown ? q.serverRow.get(shown) : null;
      results.push({
        username: a.username, state: place ? place.state : "offline",
        server: shown ? place.name : null, address: shown,
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

  // What the viewer is to the community.
  function meIn(c, viewer) {
    if (!viewer) return { signedIn: false };
    return {
      signedIn: true, member: belongs(viewer.id, c), staff: isStaff(viewer, c), owner: isOwner(viewer, c), siteAdmin: isSiteAdmin(viewer), chat: mayWebChat(viewer, c),
      invited: !!q.invite.get(c.id, viewer.id), requested: !!q.request.get(c.id, viewer.id), banned: !!sanctioned(viewer.id, c.id, "ban"),
    };
  }

  // A private community, to someone who may not see it: its name and how to get in, nothing else.
  // null when even that is not shown (no invitation or request, and by invitation only).
  function stubView(c, viewer) {
    const me = meIn(c, viewer);
    if (c.join_mode === "invite" && !me.invited && !me.requested) return null;
    return { slug: c.slug, name: c.name, visibility: "private", joinMode: c.join_mode, private: true, me };
  }

  function communityView(c, viewer) {
    const me = meIn(c, viewer);
    if (c.visibility === "private" && !me.member && !me.siteAdmin) return stubView(c, viewer);
    return {
      slug: c.slug, name: c.name, created: iso(c.created_at),
      owner: c.owner_id ? (accounts.getById(c.owner_id) || {}).username || null : null,
      staff: q.staff.all(c.id).map((r) => r.username),
      chat: c.chat === 1, chatProof: c.chat_proof === 1, dataProof: c.data_proof === 1, chatOpen: c.chat_open === 1,
      joinMode: c.join_mode, visibility: c.visibility, whitelist: c.whitelist === 1, whitelistProof: c.whitelist_proof === 1,
      discord: !!c.discord_channel,
      ...(me.siteAdmin ? { discordChannel: c.discord_channel || null, discordStatus: (c.discord_channel && relayStatus.get(c.discord_channel)) || null } : {}),
      members: q.memberCount.get(c.id).n,
      servers: serversView(c),
      me,
    };
  }

  // The listed communities; signed in, also the viewer's own (any visibility), invitations and
  // requests waiting.
  router.get("/api/presence/communities", auth.optionalSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const out = { communities: q.communities.all().map((c) => ({ slug: c.slug, name: c.name, owner: c.owner, servers: c.servers, members: c.members, joinMode: c.join_mode })) };
    if (rc.account) {
      const id = rc.account.id;
      out.mine = q.mine.all(id, id, id).map((c) => ({ slug: c.slug, name: c.name, visibility: c.visibility, members: c.members, owner: c.owner_id === id }));
      out.invitations = q.invitationsOf.all(id).map((r) => ({ slug: r.slug, name: r.name, by: r.by_name || null, created: iso(r.created_at) }));
      out.requests = q.requestsOf.all(id).map((r) => ({ slug: r.slug, name: r.name, created: iso(r.created_at) }));
    }
    rc.json(200, out);
  }));

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
      tx(() => {
        q.insertCommunity.run(slug, name, rc.account.id, now());
        q.memberAdd.run(q.community.get(slug).id, rc.account.id, now(), null);
      });
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
    const view = communityView(communityOrThrow(rc.params.slug), rc.account);
    if (!view) throw new HttpError(404, "not_found", "No such community.");
    rc.json(200, view);
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
    const whitelist = flag(body.whitelist, c.whitelist);
    const whitelistProof = flag(body.whitelistProof, c.whitelist_proof);
    const chatOpen = flag(body.chatOpen, c.chat_open);
    if ([chat, chatProof, dataProof, whitelist, whitelistProof, chatOpen].includes(null)) {
      throw new HttpError(400, "bad_request", "chat, chatProof, dataProof, whitelist, whitelistProof and chatOpen are true or false.");
    }
    if (chatOpen !== c.chat_open && !isOwner(rc.account, c)) {
      throw new HttpError(403, "forbidden", "Only this community's owner may open its chat to everyone, or close it again.");
    }
    const joinMode = body.joinMode === undefined ? c.join_mode : body.joinMode;
    const visibility = body.visibility === undefined ? c.visibility : body.visibility;
    if (!JOIN_MODES.includes(joinMode)) throw new HttpError(400, "bad_request", "joinMode is open, request or invite.");
    if (!VISIBILITIES.includes(visibility)) throw new HttpError(400, "bad_request", "visibility is listed, unlisted or private.");
    q.updateCommunity.run(name, chat, chatProof, dataProof, joinMode, visibility, whitelist, whitelistProof, chatOpen, c.id);
    if (deps.refresh) deps.refresh();
    if (whitelist !== c.whitelist || whitelistProof !== c.whitelist_proof) askReports(c.id);
    record(rc, "community.settings", c, "community " + c.slug, JSON.stringify({ name, chat, chatProof, dataProof, joinMode, visibility, whitelist, whitelistProof, chatOpen }));
    rc.json(200, communityView(q.communityById.get(c.id), rc.account));
  }));

  router.delete("/api/presence/communities/:slug", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustOwner(rc.account, c);
    const body = await rc.body({ optional: true });
    if (String(body.confirm || "").toLowerCase() !== c.slug) throw new HttpError(400, "confirm", "Type the community's short name in confirm.");
    q.deleteCommunity.run(c.id);
    record(rc, "community.delete", c, "community " + c.slug);
    if (c.discord_channel) discordWatch();
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
    tx(() => {
      q.addStaff.run(c.id, a.id, rc.account.id, now());
      q.memberAdd.run(c.id, a.id, now(), rc.account.id);
      q.requestRemove.run(c.id, a.id);
      q.inviteRemove.run(c.id, a.id);
    });
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
    mustWebChat(rc.account, c);
    const since = Math.max(0, Number.parseInt(rc.query.get("since") || "0", 10) || 0);
    const rows = q.forWeb.all(since, now() - s.chatRetentionDays * 86400, c.id).reverse();
    rc.json(200, {
      chat: c.chat === 1, staff: isStaff(rc.account, c), last: rows.length ? rows[rows.length - 1].id : since,
      messages: rows.map((m) => ({ id: m.id, kind: m.kind, source: m.source, tag: m.tag, name: m.name, text: m.text, at: iso(m.created_at) })),
    });
  }));
  router.post("/api/presence/communities/:slug/chat", auth.requireSession(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustWebChat(rc.account, c);
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

  // ---- membership ------------------------------------------------------------------------------

  const memberRoute = (handler) => auth.requireSession(async (req, res, rc) => {
    limit("membershipPerAccount", "a:" + rc.account.id);
    return handler(req, res, rc);
  });

  // A private community one may not even know of answers as if it were not there.
  function reachable(c, account) {
    if (c.visibility !== "private" || belongs(account.id, c) || isSiteAdmin(account)) return c;
    if (!stubView(c, account)) throw new HttpError(404, "not_found", "No such community.");
    return c;
  }

  // Join: an open community at once; a request-mode one asks its staff; an invitation is taken in
  // any mode. Banned (here or H9-wide): never.
  router.post("/api/presence/communities/:slug/join", memberRoute(async (req, res, rc) => {
    const c = reachable(communityOrThrow(rc.params.slug), rc.account);
    const a = rc.account;
    let status = "member";
    if (!belongs(a.id, c)) {
      if (sanctioned(a.id, c.id, "ban")) throw new HttpError(403, "banned", "You are banned from this community.");
      const t = now();
      if (q.invite.get(c.id, a.id) || c.join_mode === "open") {
        tx(() => {
          q.memberAdd.run(c.id, a.id, t, null);
          q.inviteRemove.run(c.id, a.id);
          q.requestRemove.run(c.id, a.id);
        });
      } else if (c.join_mode === "request") {
        q.requestAdd.run(c.id, a.id, t);
        status = "requested";
      } else {
        throw new HttpError(403, "invite_only", "This community takes members by invitation only.");
      }
    }
    rc.json(200, { ok: true, status, community: communityView(c, a) });
  }));

  // Leave, or withdraw a request. The owner stays: a community always has its owner.
  router.post("/api/presence/communities/:slug/leave", memberRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    const a = rc.account;
    if (c.owner_id === a.id) throw new HttpError(409, "owner", "The owner cannot leave. Delete the community instead.");
    tx(() => {
      q.memberRemove.run(c.id, a.id);
      q.removeStaff.run(c.id, a.id);
      q.requestRemove.run(c.id, a.id);
    });
    rc.json(200, { ok: true });
  }));

  router.post("/api/presence/communities/:slug/invitation/decline", memberRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    q.inviteRemove.run(c.id, rc.account.id);
    rc.json(200, { ok: true });
  }));

  // The members: to members, staff and site admins; staff also see requests and invitations.
  router.get("/api/presence/communities/:slug/members", auth.requireSession(async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    const c = communityOrThrow(rc.params.slug);
    mustMember(rc.account, c);
    const staffIds = new Set(q.staff.all(c.id).map((r) => r.account_id));
    const out = {
      members: q.membersOf.all(c.id).map((r) => ({
        username: r.username, joined: iso(r.joined_at), role: r.account_id === c.owner_id ? "owner" : staffIds.has(r.account_id) ? "admin" : "member",
      })),
    };
    if (isStaff(rc.account, c)) {
      out.requests = q.requestsFor.all(c.id).map((r) => ({ username: r.username, created: iso(r.created_at) }));
      out.invites = q.invitesFor.all(c.id).map((r) => ({ username: r.username, by: r.by_name || null, created: iso(r.created_at) }));
    }
    rc.json(200, out);
  }));

  router.post("/api/presence/communities/:slug/requests/:username/:decision", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const decision = rc.params.decision;
    if (decision !== "approve" && decision !== "refuse") throw new HttpError(404, "not_found", "approve or refuse.");
    const a = accountOrThrow(rc.params.username);
    if (!q.request.get(c.id, a.id)) throw new HttpError(404, "not_found", "No such request.");
    if (decision === "approve") {
      if (sanctioned(a.id, c.id, "ban")) throw new HttpError(403, "banned", "That account is banned here.");
      tx(() => {
        q.memberAdd.run(c.id, a.id, now(), rc.account.id);
        q.requestRemove.run(c.id, a.id);
      });
    } else {
      q.requestRemove.run(c.id, a.id);
    }
    record(rc, "community.member." + decision, c, "community " + c.slug, null, a);
    rc.json(200, { ok: true });
  }));

  router.post("/api/presence/communities/:slug/invites", staffRoute(async (req, res, rc) => {
    limit("invitePerAccount", "a:" + rc.account.id);
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const body = await rc.body();
    const a = accountOrThrow(body.username);
    if (belongs(a.id, c)) throw new HttpError(409, "member", "That account is a member already.");
    if (sanctioned(a.id, c.id, "ban")) throw new HttpError(403, "banned", "That account is banned here.");
    q.inviteAdd.run(c.id, a.id, rc.account.id, now());
    record(rc, "community.member.invite", c, "community " + c.slug, null, a);
    rc.json(201, { ok: true });
  }));

  router.delete("/api/presence/communities/:slug/invites/:username", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const a = accountOrThrow(rc.params.username);
    q.inviteRemove.run(c.id, a.id);
    record(rc, "community.member.uninvite", c, "community " + c.slug, null, a);
    rc.json(200, { ok: true });
  }));

  // Staff remove a member; only the owner removes an admin (who stops being one), and nobody the owner.
  router.delete("/api/presence/communities/:slug/members/:username", staffRoute(async (req, res, rc) => {
    const c = communityOrThrow(rc.params.slug);
    mustStaff(rc.account, c);
    const a = accountOrThrow(rc.params.username);
    if (a.id === c.owner_id) throw new HttpError(403, "forbidden", "The owner is always a member.");
    if (q.isStaff.get(c.id, a.id) && !isOwner(rc.account, c)) throw new HttpError(403, "forbidden", "Only the owner removes an admin.");
    tx(() => {
      q.memberRemove.run(c.id, a.id);
      q.removeStaff.run(c.id, a.id);
    });
    record(rc, "community.member.remove", c, "community " + c.slug, null, a);
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
    if (events) for (const [name, fn] of Object.entries(relayListeners)) events.off(name, fn);
  }

  return { reportActions, sanctioned, communityOfServer, privateCommunityOf, membersOnly, sweep, stop };
}
