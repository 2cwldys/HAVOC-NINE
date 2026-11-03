// "Sync your Discord": a player links their Discord account to their HAVOC 9 account, once, under
// ACCOUNT, and gets the registered role in H9's Discord. Only an admin can free a link (for a player
// who lost their Discord account and needs to link a new one); freeing takes the role away. Players
// cannot replace or unlink a link themselves. README.txt, section 18.
//
// One Discord application, used two ways: its OAuth2 (scope identify, nothing more) for the link,
// and its bot's token, through Discord's REST API, to give and take the role
//   PUT / DELETE /guilds/{guild}/members/{user}/roles/{role}   with an audit-log reason.
//
// The flow
//   1. POST /api/discord/sync (signed in; the Origin check applies): a random state, and a random
//      binding value set as the cookie __Host-h9_dsync (HttpOnly, Secure, SameSite=Lax, Path=/,
//      10 minutes). Both are stored as their SHA-256 with the account's id, for one use and 10
//      minutes; the answer is Discord's authorize address, and the page goes there.
//   2. GET /api/discord/callback?code&state: Discord sends the player back here. The session cookie
//      is SameSite=Strict, so it is not sent on that return from discord.com; the account is found
//      by the state. The binding cookie is Lax, so it is sent on that top-level return, and it must
//      match the state's (compared in constant time): a state started in one browser cannot be
//      finished in another, so nobody can get another player to link that player's Discord to
//      their own account. The state is used up and the cookie cleared on every return, whatever
//      happens. A missing, wrong or expired cookie or state links nothing and ends on the same
//      "start again from ACCOUNT" page; a refused cookie is audited. Otherwise the code is
//      exchanged for a token, /users/@me read, the link stored and the token dropped (never
//      stored). The answer is a small page that sends the browser on to /account/ itself, a
//      same-site navigation that carries the session cookie again.
//   3. The role is given at once when the player is in the guild; otherwise the link waits
//      ("pending") and the reconcile gives the role once they join.
// The reconcile runs every reconcileMinutes: it gives and takes the role to match the links and
// the accounts (a suspension takes it away when suspensionRemovesRole; lifting the suspension gives
// it back when restoreOnUnsuspend), takes it from a deleted or freed account, and, only when
// removeUnlinked is on, from members holding it with no link (staff may give it by hand). Events in
// this process act at once; the admin command's changes wait for the reconcile.
//
// At rest: a link's Discord user id and display name are sealed with h9web's data key
// (ctx.dataKey, lib/datakey.js; AES-256-GCM), and the user id is found through a keyed index
// (user_index), so a copy of the database alone does not say which Discord account belongs to
// which player. Links from before that are sealed at the next start. Should the data key be
// another than the one the links were sealed with (data.key lost or swapped), Discord linking
// switches itself off, leaves the links as they are and says so in the log; putting the right
// data.key back brings them back. The audit log names a Discord account by a short prefix of
// its index, never by its id or name.
//
// The same bot also carries a community's chat to a Discord channel and back, when an H9 site admin
// bridged them (the presence module, docs\H9_COMMUNITIES.txt section 4a; "the community relay",
// below): only this module holds the token.
//
// Settings (config.json "moduleSettings": { "discord": { ... } }): enabled, clientId, guildId,
// roleId, redirectUri, inviteUrl, reconcileMinutes, removeUnlinked, suspensionRemovesRole,
// restoreOnUnsuspend, dropUnreadable, secretsFile, apiBase, authorizeUrl, relayPollSeconds,
// relaySendMs. The secrets, clientSecret and botToken,
// live in their own file (secretsFile, mode 0600, never in git, never logged); without that file,
// or without clientId and guildId, Discord linking is off and everything else runs.
//
//   GET  /api/discord/status            (signed in) { enabled, link, inviteUrl }
//   POST /api/discord/sync              (signed in) { url }
//   GET  /api/discord/callback          (Discord's return) a page that goes on to /account/
//   GET  /api/discord/links/:name       (admin) that account's link
//   POST /api/discord/links/:name/free  (admin) take the role, drop the link
//   POST /api/discord/reconcile         (admin) run the reconcile now
//   GET  /api/discord/admin             (admin) whether it is on, counts, the last reconcile

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULTS = Object.freeze({
  enabled: true,
  clientId: "",
  guildId: "",
  roleId: "1566395367036035123",
  redirectUri: "https://havoc9.org/api/discord/callback",
  inviteUrl: "https://discord.gg/b76pqqVsNY",
  reconcileMinutes: 15,
  removeUnlinked: false,
  // only when data.key is lost for good: links sealed with another key are deleted at start
  dropUnreadable: false,
  suspensionRemovesRole: true,
  restoreOnUnsuspend: true,
  secretsFile: "",
  apiBase: "https://discord.com/api/v10",
  authorizeUrl: "https://discord.com/oauth2/authorize",
  accountPath: "/account/",
  // the community relay: how often each bridged channel is read, and the least time between two of
  // the bot's messages in one channel (lines that come meanwhile go together)
  relayPollSeconds: 3,
  relaySendMs: 1200,
});

const SNOWFLAKE = /^[0-9]{5,25}$/;
const STATE_SECONDS = 600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// The binding cookie. __Host-: Secure, Path=/, no Domain, so only this exact host sets and reads it.
// SameSite=Lax: sent on Discord's top-level GET back to the callback, unlike the session cookie.
const BINDING = "__Host-h9_dsync";
const bindingCookie = (value, maxAge) => BINDING + "=" + value + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax";

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// whether a cookie's value hashes to the stored hash, compared in constant time
function sameHash(value, storedHex) {
  if (!value || !TOKEN.test(value) || typeof storedHex !== "string" || !/^[0-9a-f]{64}$/.test(storedHex)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(value), "hex"), Buffer.from(storedHex, "hex"));
}
const ROBOT = "(discord sync)";
const stoppers = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const now = () => Math.floor(Date.now() / 1000);

export default {
  name: "discord",
  migrations: [
    {
      version: 1,
      description: "Discord links and sign-in states",
      up(db) {
        db.exec(`
          CREATE TABLE discord_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER UNIQUE REFERENCES accounts(id) ON DELETE SET NULL,
            discord_user_id TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            linked_at INTEGER NOT NULL,
            linked_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
            role_state TEXT NOT NULL DEFAULT 'pending' CHECK (role_state IN ('pending', 'granted', 'withheld')),
            checked_at INTEGER
          );
          CREATE TABLE discord_states (
            state_hash TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
          );
        `);
      },
    },
    {
      version: 2,
      description: "a binding cookie's hash with each state",
      up(db) {
        // states live 10 minutes: the ones made before this are dropped, not converted
        db.exec(`
          DROP TABLE discord_states;
          CREATE TABLE discord_states (
            state_hash TEXT PRIMARY KEY,
            binding_hash TEXT NOT NULL,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
          );
        `);
      },
    },
    {
      version: 3,
      description: "Discord user ids and names sealed with the data key",
      up(db) {
        // the sealed columns: user_index (the keyed index, unique), user_box and name_box. A
        // migration has no key, so rows from before keep their clear columns until setup seals
        // them and empties those columns.
        db.exec(`
          CREATE TABLE discord_links_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER UNIQUE REFERENCES accounts(id) ON DELETE SET NULL,
            user_index TEXT UNIQUE,
            user_box TEXT,
            name_box TEXT,
            discord_user_id TEXT UNIQUE,
            display_name TEXT,
            linked_at INTEGER NOT NULL,
            linked_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
            role_state TEXT NOT NULL DEFAULT 'pending' CHECK (role_state IN ('pending', 'granted', 'withheld')),
            checked_at INTEGER
          );
          INSERT INTO discord_links_v3 (id, account_id, discord_user_id, display_name, linked_at, linked_by, role_state, checked_at)
            SELECT id, account_id, discord_user_id, display_name, linked_at, linked_by, role_state, checked_at FROM discord_links;
          DROP TABLE discord_links;
          ALTER TABLE discord_links_v3 RENAME TO discord_links;
        `);
      },
    },
  ],

  async setup(ctx) {
    const s = { ...DEFAULTS, ...ctx.settings };
    for (const k of ["clientId", "guildId", "roleId"]) {
      if (s[k] !== "" && !SNOWFLAKE.test(String(s[k]))) throw new Error("discord: moduleSettings.discord." + k + " must be a Discord id (digits)");
      s[k] = String(s[k]);
    }
    if (!(Number(s.reconcileMinutes) >= 1)) throw new Error("discord: moduleSettings.discord.reconcileMinutes must be 1 or more");
    if (!(Number(s.relayPollSeconds) >= 1)) throw new Error("discord: moduleSettings.discord.relayPollSeconds must be 1 or more");
    if (!(Number(s.relaySendMs) >= 250)) throw new Error("discord: moduleSettings.discord.relaySendMs must be 250 or more");
    const { HttpError } = ctx.http;
    const { log, auth, db } = ctx;
    const secretsFile = s.secretsFile ? path.resolve(s.secretsFile) : path.join(ctx.dataDir, "secrets.json");

    // The secrets: read once, never logged; the file's mode is checked as h9web's own secrets' is.
    function readSecrets() {
      if (!fs.existsSync(secretsFile)) return null;
      if (process.platform !== "win32" && fs.statSync(secretsFile).mode & 0o077) {
        log.warn("discord.secrets.mode", { file: secretsFile, fix: "chmod 600" });
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
      } catch (e) {
        log.warn("discord.secrets.unreadable", { file: secretsFile });
        return null;
      }
      if (!parsed || typeof parsed.clientSecret !== "string" || !parsed.clientSecret || typeof parsed.botToken !== "string" || !parsed.botToken) {
        log.warn("discord.secrets.incomplete", { file: secretsFile, needs: "clientSecret, botToken" });
        return null;
      }
      return { clientSecret: parsed.clientSecret, botToken: parsed.botToken };
    }
    const secrets = s.enabled ? readSecrets() : null;
    let on = !!(s.enabled && secrets && s.clientId && s.guildId && s.roleId);
    if (!on) {
      log.info("discord.off", { reason: !s.enabled ? "enabled is false" : !secrets ? "no secrets file at " + secretsFile : "clientId, guildId or roleId missing" });
    }

    // ---- the links at rest: sealed with the data key -------------------------------------------
    const box = ctx.dataKey;
    if (!box) throw new Error("discord: this h9web gives modules no data key (lib/datakey.js)");
    const USER = "discord.user";
    const NAME = "discord.name";
    const userIndex = (userId) => box.index(String(userId), USER);
    // how the audit log names a Discord account: a prefix of its index, never its id or name
    const tagOf = (userId) => "Discord account #" + userIndex(userId).slice(0, 12);
    // a row with its Discord user id and display name opened; null for both when a value does
    // not open (unreadable is then true)
    function unseal(row) {
      if (!row) return null;
      try {
        return { ...row, discord_user_id: box.open(row.user_box, USER), display_name: box.open(row.name_box, NAME), unreadable: false };
      } catch (e) {
        return { ...row, discord_user_id: null, display_name: null, unreadable: true };
      }
    }

    const q = {
      linkForRow: db.prepare("SELECT * FROM discord_links WHERE account_id = ?"),
      linkByIndex: db.prepare("SELECT * FROM discord_links WHERE user_index = ?"),
      linkRows: db.prepare("SELECT * FROM discord_links ORDER BY id"),
      insert: db.prepare("INSERT INTO discord_links (account_id, user_index, user_box, name_box, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)"),
      clearOld: db.prepare("SELECT id, discord_user_id, display_name FROM discord_links WHERE user_box IS NULL AND discord_user_id IS NOT NULL"),
      sealOld: db.prepare("UPDATE discord_links SET user_index = ?, user_box = ?, name_box = ?, discord_user_id = NULL, display_name = NULL WHERE id = ?"),
      state: db.prepare("UPDATE discord_links SET role_state = ?, checked_at = ? WHERE id = ?"),
      orphan: db.prepare("UPDATE discord_links SET account_id = NULL WHERE id = ?"),
      drop: db.prepare("DELETE FROM discord_links WHERE id = ?"),
      count: db.prepare("SELECT count(*) AS n, coalesce(sum(role_state = 'pending' AND account_id IS NOT NULL), 0) AS pending, coalesce(sum(account_id IS NULL), 0) AS orphans FROM discord_links"),
      stateInsert: db.prepare("INSERT INTO discord_states (state_hash, binding_hash, account_id, expires_at) VALUES (?, ?, ?, ?)"),
      stateTake: db.prepare("DELETE FROM discord_states WHERE state_hash = ? RETURNING account_id, binding_hash, expires_at"),
      statesForAccount: db.prepare("DELETE FROM discord_states WHERE account_id = ?"),
      statesExpired: db.prepare("DELETE FROM discord_states WHERE expires_at <= ?"),
    };
    // the links as the code below reads them: opened
    q.linkFor = { get: (accountId) => unseal(q.linkForRow.get(accountId)) };
    q.linkByUser = { get: (userId) => unseal(q.linkByIndex.get(userIndex(userId))) };
    q.links = { all: () => q.linkRows.all().map(unseal) };

    // links from before the data key: sealed now, their clear columns emptied
    {
      const old = q.clearOld.all();
      if (old.length) {
        ctx.transaction(() => {
          for (const r of old) q.sealOld.run(userIndex(r.discord_user_id), box.seal(r.discord_user_id, USER), box.seal(r.display_name || "", NAME), r.id);
        });
        // the clear values' old pages leave the write-ahead log too (secure_delete clears the file's)
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        log.info("discord.sealed", { links: old.length, note: "older backups still hold them in the clear: delete them once this start is checked" });
      }
    }
    // links sealed with another data key: linking stays off, and the links stay as they are,
    // until the data.key they were sealed with is back. With dropUnreadable (the data key is lost
    // for good), they are deleted instead, and their players link again.
    {
      const other = q.linkRows.all().filter((r) => box.keyIdOf(r.user_box) !== box.keyId);
      if (other.length && s.dropUnreadable === true) {
        const drop = db.prepare("DELETE FROM discord_links WHERE id = ?");
        ctx.transaction(() => { for (const r of other) drop.run(r.id); });
        ctx.audit.record({ actorName: ROBOT, action: "discord.dropped", detail: other.length + " links that another data key sealed (dropUnreadable)" });
        log.warn("discord.dropped", { links: other.length, note: "their players link again; take dropUnreadable out of config.json" });
      } else if (other.length) {
        on = false;
        log.error("discord.datakey", {
          links: other.length, sealedWith: [...new Set(other.map((r) => box.keyIdOf(r.user_box) || "none"))].join(","), thisKey: box.keyId,
          fix: "put back the data.key these links were sealed with and restart; Discord linking is off until then (README section 10)",
        });
      }
    }

    // ---- Discord's REST API, minding its rate limits ------------------------------------------

    // { status, data } or { status: 0 } when Discord cannot be reached. A 429 is waited out (its
    // Retry-After, or the body's retry_after) and tried again, up to `attempts` times, unless the
    // wait is longer than maxWait seconds; then the 429 is the answer.
    async function discord(method, route, { bearer, form, json, reason, attempts = 3, maxWait = 30, bot = true } = {}) {
      for (let i = 1; ; i++) {
        const headers = { "User-Agent": "h9web (https://havoc9.org, 1)", Accept: "application/json" };
        if (bearer) headers.Authorization = "Bearer " + bearer;
        else if (bot) headers.Authorization = "Bot " + secrets.botToken;
        if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason.slice(0, 400));
        let body;
        if (form) {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          body = new URLSearchParams(form).toString();
        } else if (json) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(json);
        }
        let r;
        try {
          r = await fetch(s.apiBase + route, { method, headers, body, signal: AbortSignal.timeout(10000) });
        } catch (e) {
          return { status: 0, data: null };
        }
        let data = null;
        if (r.status !== 204) {
          try {
            data = await r.json();
          } catch (e) {
            data = null;
          }
        }
        if (r.status === 429) {
          const wait = Math.max(Number(r.headers.get("retry-after")) || 0, Number(data && data.retry_after) || 0, 0.05);
          log.warn("discord.rate_limited", { route: route.replace(/[0-9]{5,}/g, ":id"), wait, global: r.headers.get("x-ratelimit-global") || undefined });
          if (i >= attempts || wait > maxWait) return { status: 429, data, retryAfter: wait };
          await sleep(Math.ceil(wait * 1000));
          continue;
        }
        return { status: r.status, data };
      }
    }

    const rolePath = (userId) => "/guilds/" + s.guildId + "/members/" + userId + "/roles/" + s.roleId;
    const robot = (action, target, detail) => ctx.audit.record({ actorName: ROBOT, action, target, detail });

    // Gives or takes the role. "member" when done (or already so), "absent" when the user is not in
    // the guild, "failed" otherwise (a 429 past the wait, a network or permission problem).
    async function setRole(userId, give, reason, opts) {
      const r = await discord(give ? "PUT" : "DELETE", rolePath(userId), { reason, ...opts });
      if (r.status === 204 || r.status === 200) return "member";
      if (r.status === 404 && r.data && (r.data.code === 10007 || r.data.code === 10013)) return "absent";
      log.warn("discord.role.failed", { give, status: r.status, code: r.data && r.data.code });
      return "failed";
    }

    const accountWants = (account) => !!account && !(s.suspensionRemovesRole && ctx.accounts.isBanned(account));

    // ---- the reconcile ---------------------------------------------------------------------------

    let running = null;
    let lastRun = null;

    async function reconcileOnce() {
      const summary = { at: iso(now()), checked: 0, given: 0, taken: 0, pending: 0, failed: 0, unlinkedTaken: 0 };
      q.statesExpired.run(now());
      for (const link of q.links.all()) {
        summary.checked++;
        if (link.unreadable) {
          summary.failed++;
          continue;
        }
        const account = link.account_id ? ctx.accounts.getById(link.account_id) : null;
        const want = link.account_id !== null && accountWants(account);
        const member = await discord("GET", "/guilds/" + s.guildId + "/members/" + link.discord_user_id);
        if (member.status === 404) {
          if (link.account_id === null) q.drop.run(link.id);
          else q.state.run(want ? "pending" : "withheld", now(), link.id);
          if (want) summary.pending++;
          continue;
        }
        if (member.status !== 200 || !member.data || !Array.isArray(member.data.roles)) {
          summary.failed++;
          continue;
        }
        const has = member.data.roles.includes(s.roleId);
        if (want && !has) {
          const done = await setRole(link.discord_user_id, true, "HAVOC 9 account " + account.username + " is linked");
          if (done === "member") {
            q.state.run("granted", now(), link.id);
            summary.given++;
            robot("discord.role.give", account, "to " + tagOf(link.discord_user_id) + " (reconcile)");
          } else summary.failed++;
        } else if (!want && has) {
          const done = await setRole(link.discord_user_id, false, link.account_id === null ? "HAVOC 9 link freed or account deleted" : "HAVOC 9 account suspended");
          if (done === "member" || done === "absent") {
            summary.taken++;
            if (link.account_id === null) q.drop.run(link.id);
            else q.state.run("withheld", now(), link.id);
            robot("discord.role.take", account, "from " + tagOf(link.discord_user_id) + " (reconcile)");
          } else summary.failed++;
        } else if (link.account_id === null) {
          q.drop.run(link.id);
        } else {
          q.state.run(want ? "granted" : "withheld", now(), link.id);
        }
      }
      const current = q.links.all();
      // with a link that does not open, its member would look unlinked: nobody's role goes then
      if (s.removeUnlinked && current.some((l) => l.unreadable)) log.warn("discord.reconcile.unlinked_skipped", { reason: "a link does not open with this data key" });
      else if (s.removeUnlinked) {
        const linked = new Set(current.filter((l) => l.account_id !== null).map((l) => l.discord_user_id));
        let after = "0";
        for (let pages = 0; pages < 50; pages++) {
          const list = await discord("GET", "/guilds/" + s.guildId + "/members?limit=1000&after=" + after);
          if (list.status !== 200 || !Array.isArray(list.data) || !list.data.length) break;
          for (const m of list.data) {
            const id = m.user && m.user.id;
            if (id && Array.isArray(m.roles) && m.roles.includes(s.roleId) && !linked.has(id)) {
              if ((await setRole(id, false, "No HAVOC 9 account is linked to this Discord account")) === "member") {
                summary.unlinkedTaken++;
                robot("discord.role.take", null, "from " + tagOf(id) + ", which has no link");
              }
            }
          }
          after = list.data[list.data.length - 1].user.id;
          if (list.data.length < 1000) break;
        }
      }
      lastRun = summary;
      if (summary.given || summary.taken || summary.failed || summary.unlinkedTaken) log.info("discord.reconcile", summary);
      return summary;
    }

    // one at a time: a second call waits for the running one
    function reconcile() {
      if (!running) running = reconcileOnce().finally(() => { running = null; });
      return running;
    }

    if (on) {
      const timer = setInterval(() => reconcile().catch((e) => log.warn("discord.reconcile.error", { error: e.message })), Math.round(Number(s.reconcileMinutes) * 60000));
      timer.unref();
      stoppers.add(() => clearInterval(timer));
    }

    // ---- the community relay (the presence module; docs\H9_COMMUNITIES.txt section 4a) ----------
    // The presence module names the channels H9's site admins bridged with a community
    // ("discord-relay-watch" { channels: [{ channel, after }] }) and hands over the lines for them
    // ("discord-relay-out" { channel, kind, tag, name, text }). This module posts those lines, at
    // most one message a channel every relaySendMs (lines that come meanwhile go together, up to 50
    // waiting), with every mention switched off (allowed_mentions), link previews off, and
    // Discord's markdown escaped; and it reads each channel every relayPollSeconds, handing
    // people's new messages (never a bot's, a webhook's or a system message, so never its own)
    // back as "discord-relay-in" { channel, id, name, text, at }, mentions written out as @name,
    // #channel and @role. "discord-relay-status" { channel, ok, error } says how a channel
    // answers; "discord-relay-ready" asks presence for its list again. It needs the bot in the
    // channel with View Channel, Read Message History and Send Messages, and the bot's MESSAGE
    // CONTENT intent on in Discord's developer portal: without it every message reads empty.
    const relayOn = !!(s.enabled && secrets);
    const relay = new Map(); // channel id -> { after, outbox, sending, nextSend, flush, wait, failing }
    let relayPolling = false;

    function relayWatch(e) {
      if (!relayOn || !e || !Array.isArray(e.channels)) return;
      const want = new Map();
      for (const w of e.channels) {
        const id = w && String(w.channel || "");
        if (!SNOWFLAKE.test(id)) continue;
        want.set(id, w.after && SNOWFLAKE.test(String(w.after)) ? String(w.after) : null);
      }
      for (const [id, ch] of relay) {
        if (want.has(id)) continue;
        if (ch.flush) clearTimeout(ch.flush);
        relay.delete(id);
      }
      for (const [id, after] of want) {
        if (!relay.has(id)) relay.set(id, { after, outbox: [], sending: false, nextSend: 0, flush: null, wait: 0, failing: null });
      }
    }

    function relayFine(id, ch) {
      ch.wait = 0;
      if (ch.failing !== false) {
        ch.failing = false;
        ctx.events.emit("discord-relay-status", { channel: id, ok: true, error: null });
      }
    }

    function relayTrouble(id, ch, r, error) {
      const why = error || (r.status === 0 ? "unreachable" : r.status === 401 ? "bad_token" : r.status === 403 ? "no_access"
        : r.status === 404 ? "no_such_channel" : r.status === 429 ? "rate_limited" : "http_" + r.status);
      ch.wait = Date.now() + (r.status === 429 ? Math.ceil((r.retryAfter || 5) * 1000) : r.status === 0 ? 10000 : 60000);
      if (ch.failing !== why) {
        ch.failing = why;
        log.warn("discord.relay", { channel: id, error: why });
        ctx.events.emit("discord-relay-status", { channel: id, ok: false, error: why });
      }
    }

    // a person's message as plain text, or null when it is not relayed
    function relayText(m) {
      if (!m.author || m.author.bot || m.webhook_id || (m.type !== 0 && m.type !== 19)) return null;
      const names = new Map((Array.isArray(m.mentions) ? m.mentions : []).map((u) => [String(u.id), u.global_name || u.username || "someone"]));
      let text = String(m.content || "")
        .replace(/<@!?([0-9]+)>/g, (x, uid) => "@" + (names.get(uid) || "someone"))
        .replace(/<@&[0-9]+>/g, "@role")
        .replace(/<#[0-9]+>/g, "#channel")
        .replace(/<a?:([A-Za-z0-9_]+):[0-9]+>/g, ":$1:")
        .replace(/<t:([0-9]+)(:[A-Za-z])?>/g, (x, sec) => new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace("T", " "));
      if (text.trim()) return text;
      if (Array.isArray(m.attachments) && m.attachments.length) return "(an attachment)";
      if (Array.isArray(m.sticker_items) && m.sticker_items.length) return "(a sticker)";
      return "";
    }

    async function relayPoll() {
      if (!relayOn || relayPolling) return;
      relayPolling = true;
      try {
        for (const [id, ch] of relay) {
          if (Date.now() < ch.wait) continue;
          const route = "/channels/" + id + "/messages?limit=" + (ch.after ? "50&after=" + ch.after : "1");
          const r = await discord("GET", route, { attempts: 1, maxWait: 5 });
          if (r.status !== 200 || !Array.isArray(r.data)) {
            relayTrouble(id, ch, r);
            continue;
          }
          const first = !ch.after;
          const list = r.data.filter((m) => m && SNOWFLAKE.test(String(m.id))).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          let empty = false;
          for (const m of list) {
            ch.after = String(m.id);
            // the first read only finds where the channel is: nothing from before is relayed
            if (first) continue;
            const text = relayText(m);
            if (text === null) continue;
            if (!text) {
              empty = true;
              continue;
            }
            const name = String((m.member && m.member.nick) || m.author.global_name || m.author.username || "someone");
            ctx.events.emit("discord-relay-in", { channel: id, id: String(m.id), name, text, at: Math.floor(Date.parse(m.timestamp) / 1000) || now() });
          }
          // a person's message with nothing in it at all: the bot cannot read message content
          if (empty) relayTrouble(id, ch, { status: 200 }, "message_content_intent");
          else relayFine(id, ch);
        }
      } finally {
        relayPolling = false;
      }
    }

    // Discord's markdown taken literally; @ escaped too, though allowed_mentions already pings nobody
    const relayEscape = (t) => String(t).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\\*_~`|<>#\[\]()@]/g, "\\$&");

    function relayLine(e) {
      const text = relayEscape(e.text || "").slice(0, 1500).trim();
      if (!text) return null;
      if (e.kind === "announce") return "**" + relayEscape("[" + (e.tag || "H9") + "]") + "** " + text;
      return "**" + relayEscape("[" + (e.tag || "") + "] " + (e.name || "")) + ":** " + text;
    }

    async function relayFlush(id, ch) {
      if (ch.sending || !ch.outbox.length || relay.get(id) !== ch) return;
      const wait = ch.nextSend - Date.now();
      if (wait > 0) {
        if (!ch.flush) {
          ch.flush = setTimeout(() => {
            ch.flush = null;
            relayFlush(id, ch);
          }, wait);
          ch.flush.unref();
        }
        return;
      }
      ch.sending = true;
      let content = "";
      while (ch.outbox.length && content.length + 1 + ch.outbox[0].length <= 1900) content += (content ? "\n" : "") + ch.outbox.shift();
      if (!content) content = ch.outbox.shift().slice(0, 1900);
      try {
        const r = await discord("POST", "/channels/" + id + "/messages", { json: { content, allowed_mentions: { parse: [] }, flags: 4 }, attempts: 3, maxWait: 10 });
        if (r.status === 200) relayFine(id, ch);
        else relayTrouble(id, ch, r);
      } finally {
        ch.sending = false;
        ch.nextSend = Date.now() + Number(s.relaySendMs);
        if (ch.outbox.length) relayFlush(id, ch);
      }
    }

    function relayOut(e) {
      if (!relayOn || !e) return;
      const id = String(e.channel || "");
      const ch = relay.get(id);
      if (!ch) return;
      const line = relayLine(e);
      if (!line) return;
      ch.outbox.push(line);
      if (ch.outbox.length > 50) ch.outbox.splice(0, ch.outbox.length - 50);
      relayFlush(id, ch);
    }

    if (relayOn) {
      ctx.events.on("discord-relay-watch", relayWatch);
      ctx.events.on("discord-relay-out", relayOut);
      const timer = setInterval(() => relayPoll().catch((e) => log.warn("discord.relay.error", { error: e.message })), Math.round(Number(s.relayPollSeconds) * 1000));
      timer.unref();
      stoppers.add(() => {
        clearInterval(timer);
        ctx.events.off("discord-relay-watch", relayWatch);
        ctx.events.off("discord-relay-out", relayOut);
        for (const ch of relay.values()) if (ch.flush) clearTimeout(ch.flush);
        relay.clear();
      });
      ctx.events.emit("discord-relay-ready", {});
    } else {
      log.info("discord.relay.off", { reason: !s.enabled ? "enabled is false" : "no secrets file at " + secretsFile });
    }

    // ---- this process's own account changes, at once ---------------------------------------------

    function soon(fn) {
      if (!on) return;
      setImmediate(() => fn().catch((e) => log.warn("discord.event.error", { error: e.message })));
    }
    ctx.events.on("account-deleted", () => soon(reconcile));
    ctx.events.on("account-banned", ({ id }) => soon(async () => {
      const link = q.linkFor.get(id);
      if (!link || link.unreadable || !s.suspensionRemovesRole) return;
      if ((await setRole(link.discord_user_id, false, "HAVOC 9 account suspended", { attempts: 2, maxWait: 5 })) !== "failed") {
        q.state.run("withheld", now(), link.id);
        robot("discord.role.take", ctx.accounts.getById(id), "from " + tagOf(link.discord_user_id) + " (suspended)");
      }
    }));
    ctx.events.on("account-unbanned", ({ id }) => soon(async () => {
      const link = q.linkFor.get(id);
      if (!link || link.unreadable || !s.restoreOnUnsuspend) return;
      const done = await setRole(link.discord_user_id, true, "HAVOC 9 account no longer suspended", { attempts: 2, maxWait: 5 });
      if (done === "member") {
        q.state.run("granted", now(), link.id);
        robot("discord.role.give", ctx.accounts.getById(id), "to " + tagOf(link.discord_user_id) + " (suspension lifted)");
      } else if (done === "absent") q.state.run("pending", now(), link.id);
    }));

    // ---- routes ------------------------------------------------------------------------------------

    const r = ctx.router;
    const off = () => new HttpError(503, "discord_off", "Discord linking is not switched on.");
    const linkView = (link) => (link ? { discordUser: link.discord_user_id, displayName: link.display_name, linked: iso(link.linked_at), role: link.role_state } : null);
    const syncLimit = new ctx.limits.RateLimiter({ max: 10, windowSeconds: 3600, blockSeconds: 1800, maxBlockSeconds: 3600 });

    r.get("/api/discord/status", auth.requireSession(async (req, res, rc) => {
      rc.json(200, { enabled: on, link: linkView(q.linkFor.get(rc.account.id)), inviteUrl: s.inviteUrl || null });
    }));

    r.post("/api/discord/sync", auth.requireSession(async (req, res, rc) => {
      if (!on) throw off();
      const a = rc.account;
      if (q.linkFor.get(a.id)) throw new HttpError(409, "already_linked", "This account is linked to a Discord account already. Only an admin can free it, for a player who lost that Discord account.");
      const lim = syncLimit.hit("a:" + a.id);
      if (!lim.ok) throw new HttpError(429, "rate_limited", "Too many tries. Wait a while and try again.", { headers: { "Retry-After": String(lim.retryAfter) }, body: { retryAfter: lim.retryAfter } });
      const state = crypto.randomBytes(32).toString("base64url");
      const binding = crypto.randomBytes(32).toString("base64url");
      q.statesForAccount.run(a.id);
      q.stateInsert.run(sha256(state), sha256(binding), a.id, now() + STATE_SECONDS);
      const u = new URL(s.authorizeUrl);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", s.clientId);
      u.searchParams.set("scope", "identify");
      u.searchParams.set("redirect_uri", s.redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("prompt", "consent");
      rc.json(200, { url: u.href }, { "Set-Cookie": bindingCookie(binding, STATE_SECONDS) });
    }));

    // The page Discord sends the player back to. It never shows anything secret, and it says what
    // happened only through the outcome word it hands to the ACCOUNT page.
    function landing(res, outcome) {
      const target = s.accountPath + "?discord=" + outcome + "#discord";
      const html = "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        + "<meta http-equiv=\"refresh\" content=\"0;url=" + target + "\"><title>HAVOC9</title></head>"
        + "<body><p>Back to <a href=\"" + target + "\">your account</a>.</p></body></html>";
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
        // the binding cookie is cleared on every return, whatever happened
        "Set-Cookie": bindingCookie("", 0),
      });
      res.end(html);
    }

    r.get("/api/discord/callback", async (req, res, rc) => {
      const state = String(rc.query.get("state") || "");
      const code = String(rc.query.get("code") || "");
      // the state goes at first sight, used or not: it never works twice
      const taken = TOKEN.test(state) ? q.stateTake.get(sha256(state)) : null;
      if (!taken || taken.expires_at <= now()) return landing(res, "restart");
      const account = ctx.accounts.getById(taken.account_id);
      if (!account || ctx.accounts.isBanned(account)) return landing(res, "restart");
      // the browser coming back must be the one that pressed SYNC
      const binding = cookieValue(req, BINDING);
      if (!sameHash(binding, taken.binding_hash)) {
        const why = binding ? "the browser's binding cookie did not match" : "no binding cookie came back";
        ctx.audit.record({ actorName: ROBOT, action: "discord.link.refused", target: account, detail: why + ": a sign-in with Discord finished outside the browser that started it" });
        log.warn("discord.link.refused", { user: account.username, cookie: binding ? "wrong" : "missing" });
        return landing(res, "restart");
      }
      if (!on) return landing(res, "off");
      if (rc.query.get("error") || !code || code.length > 200) return landing(res, "cancelled");
      if (q.linkFor.get(account.id)) return landing(res, "already");
      const token = await discord("POST", "/oauth2/token", {
        bot: false, attempts: 1,
        form: { client_id: s.clientId, client_secret: secrets.clientSecret, grant_type: "authorization_code", code, redirect_uri: s.redirectUri },
      });
      const access = token.status === 200 && token.data && typeof token.data.access_token === "string" ? token.data.access_token : null;
      if (!access) {
        log.warn("discord.link.token_failed", { user: account.username, status: token.status });
        return landing(res, "error");
      }
      const me = await discord("GET", "/users/@me", { bearer: access, attempts: 2, maxWait: 5 });
      if (me.status !== 200 || !me.data || !SNOWFLAKE.test(String(me.data.id || ""))) {
        log.warn("discord.link.user_failed", { user: account.username, status: me.status });
        return landing(res, "error");
      }
      const userId = String(me.data.id);
      const display = String(me.data.global_name || me.data.username || userId).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
      const linked = ctx.transaction(() => {
        if (q.linkFor.get(account.id)) return "already";
        const other = q.linkByUser.get(userId);
        if (other && other.account_id !== null) return "taken";
        // a freed link of this Discord account whose role is still on its way out is replaced
        if (other) q.drop.run(other.id);
        q.insert.run(account.id, userIndex(userId), box.seal(userId, USER), box.seal(display, NAME), now(), account.id);
        return "linked";
      });
      if (linked !== "linked") return landing(res, linked);
      ctx.audit.record({ actor: account, action: "discord.link", target: account, detail: tagOf(userId) });
      log.info("discord.link", { user: account.username });
      const link = q.linkFor.get(account.id);
      const done = await setRole(userId, true, "HAVOC 9 account " + account.username + " linked", { attempts: 2, maxWait: 5 });
      if (done === "member") {
        q.state.run("granted", now(), link.id);
        return landing(res, "linked");
      }
      return landing(res, "pending");
    });

    const admin = (h) => auth.requireRole("admin", h);

    r.get("/api/discord/admin", admin(async (req, res, rc) => {
      const c = q.count.get();
      rc.json(200, { enabled: on, links: c.n - c.orphans, pending: c.pending, freeing: c.orphans, lastReconcile: lastRun, reconcileMinutes: Number(s.reconcileMinutes), removeUnlinked: !!s.removeUnlinked });
    }));

    r.get("/api/discord/links/:name", admin(async (req, res, rc) => {
      const account = ctx.accounts.getByUsername(rc.params.name);
      if (!account) throw new HttpError(404, "not_found", "No such account.");
      rc.json(200, { enabled: on, link: linkView(q.linkFor.get(account.id)) });
    }));

    r.post("/api/discord/links/:name/free", admin(async (req, res, rc) => {
      const body = await rc.body({ optional: true });
      const account = ctx.accounts.getByUsername(rc.params.name);
      if (!account) throw new HttpError(404, "not_found", "No such account.");
      const link = q.linkFor.get(account.id);
      if (!link) return rc.json(200, { ok: true, changed: false });
      const reason = typeof body.reason === "string" ? body.reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) : "";
      // the link goes now, so the player can link another Discord account at once; the role goes
      // now when Discord answers, or at the next reconcile
      q.orphan.run(link.id);
      let removed = !on || link.unreadable ? "later" : await setRole(link.discord_user_id, false, "HAVOC 9 link freed by an admin", { attempts: 2, maxWait: 5 });
      if (removed === "member" || removed === "absent") q.drop.run(link.id);
      else removed = "later";
      const which = link.unreadable ? "a Discord link that does not open with this data key" : tagOf(link.discord_user_id);
      ctx.audit.record({ actor: rc.account, action: "discord.free", target: account, detail: which + (reason ? ": " + reason : "") });
      log.info("discord.free", { by: rc.account.username, user: account.username });
      rc.json(200, { ok: true, changed: true, role: removed === "later" ? "at the next reconcile" : "removed" });
    }));

    r.post("/api/discord/reconcile", admin(async (req, res, rc) => {
      if (!on) throw off();
      rc.json(200, { ok: true, summary: await reconcile() });
    }));
  },

  async stop() {
    for (const stop of stoppers) stop();
    stoppers.clear();
  },
};
