// Puts the service together: settings, secrets, the database and its migrations, the shared
// auth layer, the core routes, the audit log, username changes and the admin panel's routes, the
// relay, the server list, the game servers' view of each account (clientids.js), linking a game
// to an account (link.js), and the modules.
// server.js runs it; the tests make their own on a free port.

import http from "node:http";
import fs from "node:fs";
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
import { createSiteFlags, registerSiteRoutes } from "./siteflags.js";
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
  const siteFlags = createSiteFlags({ config, log: log.child("site") });
  // Who may use the site while maintenance mode is on: an admin, or an account carrying the
  // forum's DEVELOPER flag (modules/forum, table forum_developers -- admins give and take it).
  //
  // The table is read directly rather than through the module, because this has to answer before
  // any module route runs, and it is guarded: a service configured without the forum module has
  // no such table, and then nobody is a developer and admins still pass.
  // Prepared on first use, not here: the forum module creates forum_developers when it loads,
  // which happens further down, so preparing now would always throw and quietly leave every
  // developer locked out.
  let developerRow;
  function mayUseClosedSite(account, banned) {
    if (!account || banned) return false;
    if (auth.roleAtLeast(account, "admin")) return true;
    if (developerRow === undefined) {
      try {
        developerRow = db.prepare("SELECT 1 AS yes FROM forum_developers WHERE account_id = ?");
      } catch (e) {
        developerRow = null;   // no forum module: nobody is a developer, admins still pass
      }
    }
    if (!developerRow) return false;
    try {
      return !!developerRow.get(account.id);
    } catch (e) {
      return false;
    }
  }

  registerSiteRoutes(router, { flags: siteFlags, auth, audit, mayUseClosedSite });
  const links = createLinks({ db, accounts, audit, config, events, clientIds, log: log.child("link") });
  registerLinkRoutes(router, { auth, links, limits, accounts, confirmAdmin: adminRoutes.confirmAdmin });
  const relay = createRelay({ config, auth, servers, events, log: log.child("relay") });
  const modules = await loadModules({
    names: config.modules, dir: config.modulesDir, router, db, auth, accounts, audit, events, config, log, backupDir,
    servers, status, clientIds, confirmAdmin: adminRoutes.confirmAdmin, dataKey,
  });

  // ---- maintenance mode ----------------------------------------------------------------
  //
  // With the "site" part closed (admin panel -> SITE, or POST /api/admin/site), a visitor gets
  // maintenance.html wherever they go and the header links lead nowhere. An admin browses
  // normally.
  //
  // The allow list is the point of this function. Closing the site must not lock out the people
  // who can reopen it, so signing in has to keep working for everyone -- you cannot know someone
  // is an admin until they have signed in. What stays open is the sign-in exchange and the files
  // a page needs to render; everything else is the maintenance page.
  //
  // Static files are allowed by extension rather than by path because the maintenance page and
  // the sign-in page both need CSS, fonts, the helmet and their scripts, and listing every one
  // would rot. They are inert: a visitor who fetches styles.css learns nothing.
  const MAINT_API = new Set(["/api/login", "/api/logout", "/api/me", "/api/site"]);
  const MAINT_STATIC = /\.(css|js|mjs|png|gif|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)$/i;

  // config.devStatic is a map of url prefix -> mount ({ dir, listing }), not a folder, so the
  // page has to be looked up through the mount for "/". In production Caddy serves the site and
  // this returns null: there the pretty page comes from the Caddyfile's gate_maintenance, and
  // what h9web answers is only ever an API request or a direct hit, where one line is enough.
  function maintPagePath() {
    const mounts = config.devStatic;
    if (!mounts || typeof mounts !== "object") return null;
    const root = mounts["/"];
    const dir = typeof root === "string" ? root : root?.dir;
    return typeof dir === "string" && dir ? path.join(dir, "maintenance.html") : null;
  }

  function maintenanceHeld(req, res) {
    if (siteFlags.isOpen("site")) return false;

    const url = String(req.url || "/");
    const pathname = url.split("?")[0];

    if (MAINT_API.has(pathname)) return false;
    // /api/site/gate/<part> is what the web server asks before serving anything, maintenance
    // included. Holding it here would answer Caddy's forward_auth with 503 instead of 204 or
    // 403, breaking the gate it is asking about: the site would fail rather than close.
    if (pathname.startsWith("/api/site/")) return false;
    if (MAINT_STATIC.test(pathname)) return false;
    // the sign-in page itself, so an admin can reach the form
    if (/^\/account\/login\/?(index\.html)?$/.test(pathname)) return false;
    if (pathname === "/maintenance.html") return false;

    // an admin passes straight through. A broken or absent session is simply not an admin:
    // this must never throw, or closing the site would take the whole service down with it.
    try {
      const s = auth.sessionFromRequest(req);
      if (s && mayUseClosedSite(s.account, s.banned)) return false;
    } catch (e) {
      // not signed in, or an unreadable cookie: treated as a visitor
    }

    let body = "";
    try {
      const p = maintPagePath();
      body = p ? fs.readFileSync(p, "utf8") : "";
      if (!body) throw new Error("no maintenance.html to serve from here");
    } catch (e) {
      // maintenance.html missing: say the same thing in one line rather than serve a 404,
      // which would look like the site is broken instead of closed on purpose
      body = "<!DOCTYPE html><meta charset=\"utf-8\"><title>Under maintenance</title>"
        + "<body style=\"background:#0b0b0f;color:#e8e6f0;font-family:system-ui,sans-serif;text-align:center;padding:18vh 20px\">"
        + "<h1>UNDER MAINTENANCE</h1><p>This website is currently under maintenance. "
        + "Thank you for your patience and understanding.</p>";
    }
    res.writeHead(503, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "3600",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    try {
      if (maintenanceHeld(req, res)) return;
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
    if (pathname === config.relay.path && !siteFlags.isOpen("webclient")) refuseUpgrade(socket, 503); // the web client is closed: so is its relay
    else if (pathname === config.relay.path) relay.handleUpgrade(req, socket, head);
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

  return { config, log, db, events, siteFlags, accounts, clientIds, confirmAdmin: adminRoutes.confirmAdmin, dataKey, auth, audit, renames, links, limits, servers, status, relay, router, modules, server, listen, stop };
}
