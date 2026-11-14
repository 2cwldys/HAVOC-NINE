// The standalone relay's config file (relay.config.json): reading it, and the checks that stop a start with something unfinished in it.
// Every key is optional except where the checks below say (lib/service.js DEFAULTS has the rest; p2p/README.txt documents each key).

import fs from "node:fs";
import path from "node:path";
import { PLACEHOLDER } from "./auth.js";

function placeholders(v, where, out) {
  if (typeof v === "string") {
    if (v.toUpperCase().startsWith(PLACEHOLDER)) out.push(where);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) placeholders(x, where ? where + "." + k : k, out);
  }
}

const portOk = (p) => Number.isInteger(p) && p >= 0 && p <= 65535;

// -> { config, dir, problems }. dir is the folder of the file: relative paths in the config (hostsFile, tls) are relative to it.
export function loadConfig(file, { dev = false } = {}) {
  const full = path.resolve(file);
  const dir = path.dirname(full);
  const problems = [];
  let config = {};
  let text = null;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (e) {
    problems.push("cannot read " + full + " (" + (e.code || e.message) + ")");
  }
  if (text !== null) {
    try {
      config = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (e) {
      problems.push(full + " is not valid JSON (" + e.message + ")");
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    problems.push(full + " must hold one JSON object");
    config = {};
  }
  const left = [];
  placeholders(config, "", left);
  for (const w of left) problems.push(w + " still says " + PLACEHOLDER + ": put your own value there");

  if (config.publicPorts && (config.publicPorts.range || config.publicPorts.max)) problems.push("publicPorts is not implemented yet: leave publicPorts.range empty and publicPorts.max 0");
  const udp = config.publicUdp || {};
  if (config.enabled !== false) {
    if (!dev || config.publicUdp) {
      if (typeof udp.host !== "string" || !udp.host || udp.host === "0.0.0.0") problems.push("publicUdp.host must be the name or address that players reach this machine by (not empty, not 0.0.0.0)");
      else if (!portOk(udp.port) || udp.port === 0) problems.push("publicUdp.port must be the UDP port players reach (1 to 65535)");
    }
    const b = config.bind || {};
    for (const [what, port] of [["bind.http.port", b.http && b.http.port], ["bind.udp.port", b.udp && b.udp.port]]) {
      if (port !== undefined && !portOk(port)) problems.push(what + " must be a port number");
    }
    const a = config.auth;
    if (!dev) {
      if (!a || typeof a !== "object") problems.push("auth is missing: { \"mode\": \"tokens\", \"hostsFile\": \"hosts.json\" } or { \"mode\": \"h9web\", \"url\": \"https://havoc9.org\" }");
      else if (a.mode === "tokens") {
        if (typeof a.hostsFile !== "string" || !a.hostsFile) problems.push("auth.hostsFile must name the hosts file (for example \"hosts.json\")");
      } else if (a.mode === "h9web") {
        if (typeof a.url !== "string" || !/^https?:\/\/[^/\s]+/.test(a.url)) problems.push("auth.url must be the address of an h9web, for example \"https://havoc9.org\"");
      } else problems.push("auth.mode must be \"tokens\" or \"h9web\"");
    }
    const tls = b.http && b.http.tls;
    if (tls) {
      for (const k of ["cert", "key"]) {
        if (typeof tls[k] !== "string" || !tls[k]) problems.push("bind.http.tls." + k + " must name a PEM file");
        else if (!fs.existsSync(path.resolve(dir, tls[k]))) problems.push("bind.http.tls." + k + ": no file " + path.resolve(dir, tls[k]));
      }
    }
  }
  return { config, dir, problems };
}
