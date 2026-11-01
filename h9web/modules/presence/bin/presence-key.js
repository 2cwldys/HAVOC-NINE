#!/usr/bin/env node
// presence-key: the per-server keys game servers sign their presence reports with. Run it as the
// service's user, with the service's config, so the key file belongs to the service:
//
//   sudo -u h9web node /opt/h9web/modules/presence/bin/presence-key.js --config /etc/h9web/config.json <command>
//
// Commands:
//   add <address>       a key for the server at <address> (IPv4:port, as servers.json lists it),
//                       printed this once
//   rotate <address>    a new key for it; the old one stops working at once (within a second)
//   remove <address>    no key for it any more: its reports are refused
//   list                the servers that have a key, and when each was made (never the keys)
//
// The keys live in <dataDir>/modules/presence/server-keys.json (mode 0600). The service reads the
// file again when it changes, so nothing needs a restart. A key is never taken as an argument and
// never shown again after it is made: lost, it is rotated.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../../lib/config.js";
import { validateServers } from "../../../lib/servers.js";
import { addressKey, newKey, keysPath, readKeys, writeKeys } from "../keys.js";

const USAGE = "usage: presence-key [--config FILE] <add|rotate|remove|list> [address]";

function fail(message) {
  console.error("presence-key: " + message);
  process.exit(1);
}

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  if (v === undefined) fail(name + " needs a value");
  return v;
}

let config;
try {
  config = loadConfig(option("--config") || process.env.H9WEB_CONFIG);
} catch (e) {
  fail(e.message);
}
const command = args.shift();
if (!command) fail(USAGE);
if (typeof process.getuid === "function" && process.getuid() === 0) {
  fail("run this as the service's user (sudo -u h9web ...), so the key file stays readable by the service and no one else");
}

const file = keysPath(path.join(config.dataDir, "modules", "presence"));
let keys;
try {
  keys = readKeys(file);
} catch (e) {
  fail(e.message);
}

function listedAddresses() {
  try {
    const { entries } = validateServers(JSON.parse(fs.readFileSync(config.serversFile, "utf8")), { gamedir: config.gamedir });
    return new Set(entries.map((e) => e.address.key));
  } catch (e) {
    return null;
  }
}

function addressArg() {
  const raw = args.shift();
  const a = addressKey(raw);
  if (!a) fail("give the server's address as IPv4:port, as servers.json lists it (not a host name)");
  return a;
}

function printKey(address, key, verb) {
  const listed = listedAddresses();
  console.log(verb + " the presence key for " + address + ". It is shown this once:");
  console.log("");
  console.log("    h9_presence_server \"" + address + "\"");
  console.log("    h9_presence_key \"" + key + "\"");
  console.log("");
  console.log("Put both lines in that game server's addons/amxmodx/configs/h9_presence.cfg");
  console.log("(docs/H9_PRESENCE.txt). Never commit the key or paste it anywhere public;");
  console.log("whoever has it can report players onto that server. Lost: run rotate.");
  if (listed && !listed.has(address)) {
    console.log("");
    console.log("NOTE: " + address + " is not on " + config.serversFile + " yet, and reports from a server");
    console.log("that is not on the list are refused. Add it there too.");
  }
}

switch (command) {
  case "add": {
    const a = addressArg();
    if (keys.has(a)) fail(a + " has a key already (made " + (keys.get(a).created || "earlier") + "). Use rotate for a new one.");
    const key = newKey();
    keys.set(a, { key, created: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    writeKeys(file, keys);
    printKey(a, key, "Made");
    break;
  }
  case "rotate": {
    const a = addressArg();
    if (!keys.has(a)) fail(a + " has no key yet. Use add.");
    const key = newKey();
    keys.set(a, { key, created: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    writeKeys(file, keys);
    printKey(a, key, "Rotated");
    console.log("");
    console.log("The old key no longer works: put the new one in the game server's h9_presence.cfg");
    console.log("and restart the server (or change map) before its next report.");
    break;
  }
  case "remove": {
    const a = addressArg();
    if (!keys.has(a)) fail(a + " has no key.");
    keys.delete(a);
    writeKeys(file, keys);
    console.log("Removed the presence key for " + a + ". Its reports are refused from now on.");
    break;
  }
  case "list": {
    if (!keys.size) {
      console.log("No server has a presence key. (" + file + ")");
      break;
    }
    const listed = listedAddresses();
    for (const [a, e] of [...keys].sort(([x], [y]) => x.localeCompare(y))) {
      console.log(a.padEnd(22) + " made " + (e.created || "?") + (listed && !listed.has(a) ? "   (not on servers.json)" : ""));
    }
    break;
  }
  default:
    fail(USAGE);
}
