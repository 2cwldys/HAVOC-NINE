// Puts the service together: settings, secrets, the database and its migrations, the shared
// auth layer, the core routes, the audit log, username changes and the admin panel's routes, the
// relay, the server list, the game servers' view of each account (clientids.js), linking a game
// to an account (link.js), and the modules.
// server.js runs it; the tests make their own on a free port.

import http from "node:http";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createLogger } from "./log.js";
import { loadSecrets } from "./config.js";
import { openDatabase, migrate, CORE_MIGRATIONS } from "./db.js";
import { PasswordHasher } from "./passwords.js";
import { createAccounts } from "./accounts.js";
import { createAuth } from "./auth.js";
import { RateLimiter } from "./ratelimit.js";
import { Router, HttpError, sendError } from "./http.js";
import { registerCoreRoutes } from "./api.js";
import { ServerList, StatusPoller, parseAddress } from "./servers.js";
import { createRelay } from "./relay.js";
import { refuseUpgrade } from "./websocket.js";
import { loadModules } from "./modules.js";
import { serveStatic } from "./static.js";
import { createAudit } from "./audit.js";
import { createRenames, registerRenameRoutes } from "./renames.js";
import { registerAdminRoutes } from "./admin.js";
import { createClientIds } from "./clientids.js";
import { loadDataKey, createDataBox } from "./datakey.js";
import { createLinks, registerLinkRoutes } from "./link.js";

export async function createApp(config, { logSink, logLevel } = {}) {
  const log = createLogger("h9web", { level: logLevel || config.logLevel, sink: logSink });
  if (config.insecureCookies) log.warn("config.insecure_cookies", { note: "session cookies without Secure: for a test without HTTPS only" });
  const secrets = loadSecrets(config.dataDir, { create: true, log });
  // encryption at rest for modules' stored values (lib/datakey.js); the raw key stays here
  const dataKey = createDataBox(loadDataKey(config.dataKeyFile || path.join(config.dataDir, "data.key"), { create: true, log }));
  const db = openDatabase(path.join(config.dataDir, "h9web.db"));
  const backupDir = path.join(config.dataDir, "backups");
  migrate(db, "core", CORE_MIGRATIONS, { backupDir, log });

  const events = new EventEmitter();
  events.setMaxListeners(50);
  const hasher = new PasswordHasher({ pepper: secrets.passwordPepper, ...config.scrypt });
  const accounts = createAccounts({ db, hasher, secrets, config, events });
  const clientIds = createClientIds({ db, secrets, events });
  const auth = createAuth({ db, config, accounts, events });
  const audit = createAudit({ db, retentionDays: config.admin.auditRetentionDays });
  audit.prune();
  const limits = {};
  for (const [name, opts] of Object.entries(config.limits)) limits[name] = new RateLimiter(opts);

  const servers = new ServerList({ file: config.serversFile, gamedir: config.gamedir, master: parseAddress(config.relay.master), log: log.child("servers") });
  servers.load();
  servers.watch();
  const status = new StatusPoller({ servers, log: log.child("status"), gamedir: config.gamedir, ...config.status });
  status.start();

  const router = new Router({ log, csrfGuard: auth.checkSameOrigin, trustProxy: config.trustProxy });
  registerCoreRoutes(router, { auth, accounts, limits, servers, status, config, log: log.child("api") });
  const renames = createRenames({ db, accounts, audit, config, events });
  registerRenameRoutes(router, { auth, renames, limits, config, log: log.child("account") });
  const adminRoutes = registerAdminRoutes(router, { db, auth, accounts, renames, audit, limits, config, log: log.child("admin") });
  const links = createLinks({ db, accounts, audit, config, events, clientIds, log: log.child("link") });
  registerLinkRoutes(router, { auth, links, limits, accounts, confirmAdmin: adminRoutes.confirmAdmin });
  const relay = createRelay({ config, auth, servers, events, log: log.child("relay") });
  const modules = await loadModules({
    names: config.modules, dir: config.modulesDir, router, db, auth, accounts, audit, events, config, log, backupDir,
    servers, status, clientIds, confirmAdmin: adminRoutes.confirmAdmin, dataKey,
  });

  const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      if (serveStatic(req, res, config.devStatic)) return;
      sendError(res, new HttpError(404, "not_found", "Nothing here."));
    } catch (e) {
      log.error("request.error", { error: e.message });
      if (!res.headersSent) sendError(res, new HttpError(500, "server_error", "Something went wrong on our side."));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    let pathname = "";
    try { pathname = new URL(req.url, "http://h9web.invalid").pathname; } catch (e) { /* refused below */ }
    if (pathname === config.relay.path) relay.handleUpgrade(req, socket, head);
    else refuseUpgrade(socket, 404);
  });
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  const housekeeping = setInterval(() => {
    const swept = auth.sweep();
    if (swept) log.info("sessions.swept", { count: swept });
    const aged = audit.prune();
    if (aged) log.info("audit.pruned", { count: aged });
    accounts.pruneHolds();
    for (const l of Object.values(limits)) l.sweep();
  }, 3600000);
  housekeeping.unref();
  hasher.warm().catch((e) => log.warn("hasher.warm", { error: e.message }));

  function listen(port = config.listen.port, host = config.listen.host) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const a = server.address();
        log.info("listening", { address: a.address + ":" + a.port, relay: config.relay.path, servers: servers.entries.length, modules: modules.names.join(",") || "none" });
        resolve(a);
      });
    });
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(housekeeping);
    links.stop();
    await relay.stop();
    status.stop();
    servers.stop();
    await modules.stop();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    db.close();
    log.info("stopped");
  }

  return { config, log, db, events, accounts, clientIds, confirmAdmin: adminRoutes.confirmAdmin, dataKey, auth, audit, renames, links, limits, servers, status, relay, router, modules, server, listen, stop };
}
