// The P2P join path as an h9web module (h9web/README.txt, section 20): hosts of a listen game open a session and mint short invites,
// friends redeem them, anybody may take a guest invite from the public list of games, and the service relays between the two ends
// or introduces them for a direct path. The service itself is p2p/lib/service.js, in the p2p folder beside h9web (the same code
// bin/h9rv.js runs standalone); this file is only the glue to h9web's router, accounts and events.
//
// Off by default and clean when off: with moduleSettings.p2p.enabled not true the module registers no route, opens no UDP socket and
// does not even read the relay's code. With it on but unfinished (no public name for the UDP port, no relay code) it logs why and stays off.
//
//   config.json:  "modules": ["forum", "discord", "presence", "p2p"],
//                 "moduleSettings": { "p2p": { "enabled": true,
//                     "publicUdp": { "host": "play.havoc9.org", "port": 27248 },   what players are told: a DNS-only name
//                     "bind": { "udp": { "host": "0.0.0.0", "port": 27248 } } } }
//   ufw:          ufw allow 27248/udp
//
// The host's credential is the account's link token (the one a linked game holds), checked against h9web's own GET /api/link/status on
// this machine (kept a minute). A signed-in visitor of the site needs no token to ask the public list for a guest invite: the session
// cookie says who it is.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// [method, the path under /api/p2p, the service's own path, whether h9web's CSRF guard stands in front].
// The host's and the friend's helpers are not browsers and send no Origin, so their routes are open to it: every host call is signed
// and a redeem needs a code. The two routes a page calls keep the guard. The public list is also mounted without "v1", the way the site's page asks.
const ROUTES = [
  ["get", "/v1/health", "/v1/health", false],
  ["post", "/v1/host/open", "/v1/host/open", false],
  ["post", "/v1/host/invite", "/v1/host/invite", false],
  ["post", "/v1/host/poll", "/v1/host/poll", false],
  ["post", "/v1/host/revoke", "/v1/host/revoke", false],
  ["post", "/v1/host/close", "/v1/host/close", false],
  ["post", "/v1/host/listing", "/v1/host/listing", false],
  ["post", "/v1/join/redeem", "/v1/join/redeem", false],
  ["get", "/v1/public", "/v1/public", false],
  ["post", "/v1/public/join", "/v1/public/join", true],
  ["get", "/public", "/v1/public", false],
  ["post", "/public/join", "/v1/public/join", true],
];

async function loadRelayCode(settings) {
  const dir = settings.libDir ? path.resolve(String(settings.libDir)) : path.resolve(HERE, "..", "..", "..", "p2p", "lib");
  for (const f of ["service.js", "auth.js"]) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(path.join(dir, f) + " is missing: the relay's code is the folder p2p/ that sits beside h9web/ (or set moduleSettings.p2p.libDir)");
  }
  const service = await import(pathToFileURL(path.join(dir, "service.js")).href);
  const auth = await import(pathToFileURL(path.join(dir, "auth.js")).href);
  return { createService: service.createService, linkTokenAuth: auth.linkTokenAuth };
}

export default {
  name: "p2p",

  async setup(ctx) {
    const st = ctx.settings;
    if (st.enabled !== true) {
      ctx.log.info("p2p.off", { why: "moduleSettings.p2p.enabled is not true" });
      return; // no route, no socket
    }
    const pub = st.publicUdp || {};
    if (!st.allowPrivatePeers && (typeof pub.host !== "string" || !pub.host || ["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(pub.host) || /^CHANGE-ME/i.test(pub.host))) {
      ctx.log.error("p2p.off", { why: "moduleSettings.p2p.publicUdp.host must be the DNS-only name or the address that players reach this machine's UDP port by" });
      return;
    }
    let code;
    try {
      code = await loadRelayCode(st);
    } catch (e) {
      ctx.log.error("p2p.off", { why: String(e && e.message) });
      return;
    }

    // where this h9web answers on this machine, learnt from the requests it gets (the link check goes there); settings.statusBase overrides it
    let local = null;
    const statusBase = () => (st.statusBase ? String(st.statusBase).replace(/\/+$/, "") : local);
    const auth = code.linkTokenAuth({
      statusUrl: () => (statusBase() ? statusBase() + "/api/link/status?token=" : null),
      resolve: async (username) => {
        const acct = ctx.accounts.getByUsername(String(username));
        if (!acct || ctx.accounts.isBanned(acct)) return null;
        return { id: acct.id, name: acct.username };
      },
    });
    // only what the operator set goes in; the rest is the service's defaults (p2p/lib/service.js, DEFAULTS)
    const config = {};
    for (const k of ["publicUdp", "direct", "relay", "listing", "limits", "publicPorts", "allowPrivatePeers"]) if (st[k] !== undefined) config[k] = st[k];
    if (st.bind && st.bind.udp) config.bind = { udp: st.bind.udp };
    let svc;
    try {
      svc = code.createService({
        config,
        auth,
        log: (event, fields) => ctx.log.info(event, fields),
        clientAddress: (req) => req.h9ip || "",
        clientAccount: async (req) => {
          const s = ctx.auth.sessionFromRequest(req);
          return s && !s.banned ? { id: s.account.id, name: s.account.username } : null;
        },
      });
    } catch (e) {
      ctx.log.error("p2p.off", { why: String(e && e.message) });
      return;
    }
    try {
      await svc.start();
    } catch (e) {
      ctx.log.error("p2p.off", { why: "the UDP socket could not be opened: " + String(e && e.message) });
      return;
    }
    this.svc = svc;

    for (const [method, mounted, own, csrf] of ROUTES) {
      ctx.router[method]("/api/p2p" + mounted, async (req, res, rc) => {
        if (req.socket.localPort) local = "http://127.0.0.1:" + req.socket.localPort;
        req.h9ip = rc.ip;
        req.url = own;
        return svc.handleHttp(req, res);
      }, csrf ? undefined : { csrf: false });
    }

    // an account that is suspended, deleted, signed out everywhere or loses a linked game loses its sessions at once, as the web client's sockets do
    const drop = ({ id, accountId }) => svc.closeAccountSessions(id !== undefined ? id : accountId);
    const unlinked = (e) => { auth.forget(); drop(e); };
    this.listeners = { "account-banned": drop, "account-deleted": drop, "account-sessions-ended": drop, "account-unlink": unlinked };
    for (const [name, fn] of Object.entries(this.listeners)) ctx.events.on(name, fn);
    this.events = ctx.events;
    ctx.log.info("p2p.on", { udp: st.bind && st.bind.udp ? st.bind.udp.port : 27248, listing: svc.config.listing.enabled });
  },

  async stop() {
    if (this.listeners && this.events) for (const [name, fn] of Object.entries(this.listeners)) this.events.off(name, fn);
    if (this.svc) await this.svc.stop();
  },
};
