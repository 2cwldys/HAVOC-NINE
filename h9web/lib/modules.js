// The module registry: how a feature such as the forum plugs into h9web without editing the
// core. README.txt, "Extension points", is the guide; in short:
//
//   modules/<name>/index.js  default-exports
//     {
//       name: "<name>",                    the folder's name: a-z, 0-9 and -, not reserved
//       pages: true,                       optional: also route /<name> and /<name>/...
//       migrations: [ { version: 1, description, up(db) { db.exec("CREATE TABLE <name>_...") } } ],
//       async setup(ctx) { ctx.router.get("/api/<name>/things", ...) },
//       async stop() { ... }               optional
//     }
//   config.json: "modules": ["<name>"]  (only listed modules load, in that order)
//
// A module's router only takes /api/<name>/... (and /<name>/... with pages: true), so a module
// cannot shadow a core route or another module's. Its migrations run before its setup, under
// its own name in schema_migrations.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { migrate, transaction } from "./db.js";
import { HttpError, sendJson, readJson, clientIp } from "./http.js";
import { RateLimiter, TokenBucket, ipKey } from "./ratelimit.js";

const RESERVED = new Set(["api", "core", "account", "accounts", "assets", "webclient", "relay", "auth", "servers", "me",
  "login", "logout", "signup", "password", "player", "admin", "static", "play", "downloads", "join", "museum", "credits"]);

// ctx.servers: servers.json's entries as plain values, and what the status poller last heard.
//   get(address)    { name, address, listed, gamedir } or null
//   listed()        the entries with listed true
//   status(address) { name, map, mode, players, max, bots } from the server's last A2S answer
//                   (within status.expireSeconds), or null
export function serversHook({ servers, status }) {
  const view = (e) => Object.freeze({ name: e.name, address: e.address.key, listed: e.listed, gamedir: e.gamedir });
  return Object.freeze({
    get: (address) => {
      const e = servers.byAddress.get(String(address));
      return e ? view(e) : null;
    },
    listed: () => servers.listed("").map(view),
    status: (address) => {
      const e = servers.byAddress.get(String(address));
      const st = e && status ? status.state.get(e.target.key) : null;
      if (!st || !st.answer || Date.now() - st.answeredAt > status.expireMs) return null;
      const a = st.answer;
      return Object.freeze({ name: a.name, map: a.map, mode: a.mode, players: a.players, max: a.max, bots: a.bots });
    },
  });
}

export async function loadModules({ names, dir, router, db, auth, accounts, audit, events, config, log, backupDir, servers, status, clientIds, confirmAdmin }) {
  const serverView = servers ? serversHook({ servers, status }) : null;
  const loaded = [];
  for (const name of names) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(name) || RESERVED.has(name)) {
      throw new Error("modules: \"" + name + "\" is not a usable module name");
    }
    const file = path.join(dir, name, "index.js");
    if (!fs.existsSync(file)) throw new Error("modules: " + file + " does not exist");
    const mod = (await import(pathToFileURL(file).href)).default;
    if (!mod || mod.name !== name) throw new Error("modules: " + file + " must default-export { name: \"" + name + "\", ... }");
    const mlog = log.child(name);
    migrate(db, name, mod.migrations || [], { backupDir, log: mlog });
    const prefixes = ["/api/" + name];
    if (mod.pages) prefixes.push("/" + name);
    const ctx = Object.freeze({
      name,
      router: router.scoped(prefixes),
      db,
      transaction: (fn) => transaction(db, fn),
      auth: Object.freeze({
        ROLES: auth.ROLES,
        requireSession: auth.requireSession,
        requireRole: auth.requireRole,
        optionalSession: auth.optionalSession,
        roleAtLeast: auth.roleAtLeast,
        checkSameOrigin: auth.checkSameOrigin,
        sessionFromRequest: auth.sessionFromRequest,
        // site activity (lib/auth.js): the last signed-in request of an account, and who made one lately
        lastActive: auth.lastActive,
        activeSince: auth.activeSince,
        // inside an admin-only route: the acting admin's own password, sent with the request
        // (lib/admin.js); the admin's accounts row read again, or a 400, 403 or 429 thrown
        confirmAdmin,
      }),
      accounts: Object.freeze({
        getById: accounts.getById,
        getByUsername: accounts.getByUsername,
        publicView: accounts.publicView,
        isBanned: accounts.isBanned,
        // what a game server sends as an account's h9_clientid (lib/clientids.js), and the id
        // proof, the player id changes and the in-game name rule (lib/accounts.js)
        clientIdIndex: clientIds ? clientIds.clientIdIndex : undefined,
        verifyIdProof: accounts.verifyIdProof,
        resetPlayerId: accounts.resetPlayerId,
        movePlayerId: accounts.movePlayerId,
        nameInUse: accounts.nameInUse,
      }),
      http: Object.freeze({ HttpError, sendJson, readJson, clientIp: (req) => clientIp(req, config.trustProxy) }),
      limits: Object.freeze({ RateLimiter, TokenBucket, ipKey }),
      // a moderator's or admin's action, into the audit log (lib/audit.js)
      audit: Object.freeze({ record: audit.record }),
      servers: serverView,
      events,
      log: mlog,
      settings: Object.freeze({ ...(config.moduleSettings[name] || {}) }),
      site: Object.freeze({ origins: config.allowedOrigins.slice() }),
      dataDir: path.join(config.dataDir, "modules", name),
    });
    if (typeof mod.setup === "function") await mod.setup(ctx);
    loaded.push({ name, mod });
    log.info("module.loaded", { module: name });
  }
  return {
    names: loaded.map((m) => m.name),
    async stop() {
      for (const m of loaded.reverse()) {
        if (typeof m.mod.stop === "function") {
          try { await m.mod.stop(); } catch (e) { log.warn("module.stop", { module: m.name, error: e.message }); }
        }
      }
    },
  };
}
