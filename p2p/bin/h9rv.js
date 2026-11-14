#!/usr/bin/env node
// h9rv: the standalone runner of the rendezvous and relay service (lib/service.js).
//
//   node bin/h9rv.js --config relay.config.json            run the relay
//   node bin/h9rv.js --config relay.config.json --check    read the config and the hosts file, say what is wrong, start nothing
//   node bin/h9rv.js token <name> [--no-public] --hosts hosts.json
//                                                          make a host token, add its hash to the hosts file, print the token once
//   node bin/h9rv.js hosts list --hosts hosts.json         who has a token (never the tokens)
//   node bin/h9rv.js hosts remove <id> --hosts hosts.json  take a host's token away
//   --dev        development and tests only: dev.hosts and dev.accounts (bearer tokens) are read from the config
//   --quiet      no log lines          --stats   a stats line every 5 seconds
//
// Who may open a session is the config's auth: "tokens" (a hosts file the operator keeps) or "h9web" (havoc9.org link tokens, checked
// against an h9web). Without one of them, and without --dev, the service REFUSES TO START: no default credentials exist. A config
// or a hosts file that still holds the example's CHANGE-ME values is refused as well. The service writes nothing to disk; its logs
// are JSON lines on stdout. p2p/README.txt documents every key.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createService } from "../lib/service.js";
import { loadConfig } from "../lib/config.js";
import { hostsFileAuth, linkTokenAuth, addHost, listHosts, removeHost } from "../lib/auth.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--config", "--hosts"].includes(args[i - 1])));
const die = (text, code = 2) => { console.error("h9rv: " + text); process.exit(code); };

// ---- the hosts file by hand ------------------------------------------------------------------------------------------------

if (positional[0] === "token" || positional[0] === "hosts") {
  const hostsFile = val("--hosts");
  if (!hostsFile) die(positional[0] + " needs --hosts <hosts.json>");
  const file = path.resolve(hostsFile);
  try {
    if (positional[0] === "token") {
      if (!positional[1]) die("token needs a name: node bin/h9rv.js token Mike --hosts hosts.json");
      const r = addHost(file, { name: positional.slice(1).join(" "), publicOk: !flag("--no-public") });
      console.log("host " + r.id + " (" + positional.slice(1).join(" ") + ") added to " + file + ".");
      console.log("");
      console.log("Give this token to the host. It is shown once; the file holds only its hash:");
      console.log("");
      console.log("  " + r.token);
      console.log("");
      console.log("The relay picks the file up by itself within a few seconds (no restart).");
    } else if (positional[1] === "list") {
      const rows = listHosts(file);
      if (!rows.length) console.log("no hosts in " + file);
      for (const r of rows) console.log(String(r.id).padEnd(6) + String(r.name).padEnd(34) + (r.disabled ? "disabled  " : "          ") + (r.public ? "" : "no public list  ") + r.key);
    } else if (positional[1] === "remove" && positional[2]) {
      const n = removeHost(file, positional[2]);
      console.log(n ? "removed " + n + " token(s) of host " + positional[2] + " from " + file + "; its open sessions end within seconds" : "no host " + positional[2] + " in " + file);
    } else {
      die("hosts list | hosts remove <id>   (both with --hosts hosts.json)");
    }
  } catch (e) {
    die(String(e && e.message || e), 1);
  }
  process.exit(0);
}

// ---- the relay -------------------------------------------------------------------------------------------------------------

const configFile = val("--config");
if (!configFile) die("--config <relay.config.json> is needed (run.bat and run.sh start it)");
const dev = flag("--dev");
const { config, dir, problems } = loadConfig(configFile, { dev });
if (problems.length) {
  for (const p of problems) console.error("h9rv: " + p);
  process.exit(2);
}
if (config.enabled === false) {
  console.error("h9rv: enabled is false: nothing listens");
  process.exit(0);
}
const log = (event, fields) => { if (!flag("--quiet") && !flag("--check")) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields })); };

let svc = null;
let auth = null;
let hostsAuth = null;
let authText = "development tokens of the config (--dev)";
if (!dev) {
  if (config.auth.mode === "tokens") {
    const hostsPath = path.resolve(dir, config.auth.hostsFile);
    try {
      hostsAuth = hostsFileAuth({ file: hostsPath, log, onRemoved: (id) => svc && svc.closeAccountSessions(id, "host-removed") });
    } catch (e) {
      if (e && e.code === "ENOENT") die("the hosts file " + hostsPath + " does not exist: copy hosts.example.json to it, then  node bin/h9rv.js token <name> --hosts " + hostsPath);
      for (const p of (e && e.problems) || [String(e && e.message || e)]) console.error("h9rv: " + hostsPath + ": " + p);
      process.exit(2);
    }
    auth = hostsAuth;
    authText = "tokens (" + hostsPath + ", " + hostsAuth.size() + " host" + (hostsAuth.size() === 1 ? "" : "s") + ")";
  } else {
    // the site's address is read from the environment (run.bat and run.sh fill it from relay.site.ini): the operator's setting, never a key of the config file
    const site = String(process.env.H9RV_SITE_URL || "").trim();
    if (!/^https?:\/\/[^/\s]+/.test(site)) die("auth.mode h9web needs the address of the site in the environment variable H9RV_SITE_URL: write  H9RV_SITE_URL=https://havoc9.org  in relay.site.ini beside relay.config.json (README.txt, auth)");
    auth = linkTokenAuth({ statusUrl: site.replace(/\/+$/, "") + "/api/link/status?token=" });
    authText = "havoc9.org link tokens (checked against " + site + ")";
  }
}

svc = createService({ config, auth, log });
const cfg = svc.config;
const tls = cfg.bind.http.tls;

if (flag("--check")) {
  console.log("h9rv: the config and the hosts file are fine; nothing was started.");
  console.log("  who may host:   " + authText);
  console.log("  control plane:  " + (tls ? "https" : "http") + " on " + cfg.bind.http.host + ":" + cfg.bind.http.port);
  console.log("  data plane:     UDP on " + cfg.bind.udp.host + ":" + cfg.bind.udp.port + ", players are told " + cfg.publicUdp.host + ":" + cfg.publicUdp.port);
  console.log("  switches:       relay " + (cfg.relay.enabled ? "on" : "off") + ", direct " + (cfg.direct.enabled ? "on" : "off") + ", public list " + (cfg.listing.enabled ? "on" : "off"));
  if (!tls && cfg.bind.http.host !== "127.0.0.1" && cfg.bind.http.host !== "::1") console.log("  NOTE: plain http on a public address: invite codes and session keys cross the network in the clear. Put TLS in front (README.txt).");
  process.exit(0);
}

// The counters, to a caller on this machine only (a test or an operator with a shell); never to the network.
const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"];
const handler = (req, res) => {
  if (req.method === "GET" && req.url === "/v1/stats" && isLocal(req)) {
    const body = JSON.stringify(svc.stats());
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    return res.end(body);
  }
  return svc.handleHttp(req, res);
};
const server = tls
  ? https.createServer({ cert: fs.readFileSync(path.resolve(dir, tls.cert)), key: fs.readFileSync(path.resolve(dir, tls.key)) }, handler)
  : http.createServer(handler);
server.headersTimeout = 10000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 5000;

let udp;
try {
  udp = await svc.start();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.bind.http.port, cfg.bind.http.host, resolve);
  });
} catch (e) {
  die("cannot listen: " + String(e && e.message || e) + " (is another relay, or the game, on that port?)", 1);
}
log("listening", { http: { host: cfg.bind.http.host, port: server.address().port, tls: !!tls }, udp: udp.udp, auth: dev ? "dev" : config.auth.mode, listing: cfg.listing.enabled });

if (hostsAuth) setInterval(() => hostsAuth.recheck(), 5000).unref();
const down = async () => {
  server.close();
  await svc.stop();
  process.exit(0);
};
process.on("SIGINT", down);
process.on("SIGTERM", down);
if (flag("--stats")) setInterval(() => log("stats", svc.stats()), 5000).unref();
