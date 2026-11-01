// Test helpers: a service on a free port in a temporary folder, an HTTP client with full
// control of the headers, raw WebSocket upgrades, and small UDP servers to relay to.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { resolveConfig } from "../lib/config.js";
import { createApp } from "../lib/app.js";

export const ORIGIN = "https://havoc9.test";

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  }
  return out;
}

export async function startApp(overrides = {}, { servers = [], modulesDir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-test-"));
  const serversFile = path.join(dir, "servers.json");
  fs.writeFileSync(serversFile, JSON.stringify({ servers }));
  const raw = merge({
    allowedOrigins: [ORIGIN],
    dataDir: path.join(dir, "data"),
    serversFile,
    scrypt: { ln: 10, r: 8, p: 1 },
    status: { pollSeconds: 1, timeoutMs: 500, expireSeconds: 30 },
    relay: { sessionCheckSeconds: 1 },
  }, overrides);
  if (modulesDir) raw.modulesDir = modulesDir;
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));
  const config = resolveConfig(raw, dir);
  const logs = [];
  const app = await createApp(config, { logSink: (level, line) => logs.push(line), logLevel: "debug" });
  const addr = await app.listen(0, "127.0.0.1");
  const base = "http://127.0.0.1:" + addr.port;
  return {
    app, base, port: addr.port, dir, logs, config, serversFile, configFile,
    async close() {
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// { status, json, headers, setCookie: [..], cookie: "name=value" or null }
export function request(base, method, pathname, { body, cookie, origin = ORIGIN, headers = {}, ip, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin) h.origin = origin;
    if (cookie) h.cookie = cookie;
    if (ip) h["x-real-ip"] = ip;
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      h["content-type"] = contentType || "application/json";
      h["content-length"] = payload.length;
    }
    const req = http.request(base + pathname, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        const setCookie = [].concat(res.headers["set-cookie"] || []);
        const first = setCookie[0] ? setCookie[0].split(";")[0] : null;
        resolve({ status: res.statusCode, json, text, headers: res.headers, setCookie, cookie: first && !first.endsWith("=") ? first : null });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function signup(base, username, password = "correct horse battery staple", opts = {}) {
  const r = await request(base, "POST", "/api/signup", { body: { username, password }, ...opts });
  if (r.status !== 201) throw new Error("signup failed: " + r.status + " " + r.text);
  return r.cookie;
}

// A raw upgrade: { status } when refused, { status: 101, socket, head } when accepted.
export function rawUpgrade(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method: "GET",
      headers: {
        connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"), ...headers,
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode, socket, head, headers: res.headers }));
    req.on("error", reject);
    req.end();
  });
}

// The browser side of the relay: Node's own WebSocket (undici), with the cookie and Origin set.
export function openRelay(port, cookie, { origin = ORIGIN, pathname = "/webclient/relay" } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + pathname, { headers: { cookie, origin } });
    ws.binaryType = "arraybuffer";
    const inbox = [];
    const waiters = [];
    ws.addEventListener("message", (e) => {
      const m = new Uint8Array(e.data);
      const w = waiters.shift();
      if (w) w(m); else inbox.push(m);
    });
    ws.closed = new Promise((res) => ws.addEventListener("close", (e) => res({ code: e.code, reason: e.reason })));
    ws.next = (ms = 2000) => new Promise((res, rej) => {
      if (inbox.length) return res(inbox.shift());
      const timer = setTimeout(() => {
        const i = waiters.indexOf(fn);
        if (i >= 0) waiters.splice(i, 1);
        rej(new Error("no message within " + ms + " ms"));
      }, ms);
      const fn = (m) => { clearTimeout(timer); res(m); };
      waiters.push(fn);
    });
    ws.inbox = inbox;
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket refused")), { once: true });
  });
}

export function frame(address, payload) {
  const [ip, port] = address.split(":");
  const out = new Uint8Array(6 + payload.length);
  out.set(ip.split(".").map(Number), 0);
  out[4] = Number(port) >> 8;
  out[5] = Number(port) & 255;
  out.set(payload, 6);
  return out;
}

export function unframe(m) {
  return { address: Array.from(m.subarray(0, 4)).join(".") + ":" + ((m[4] << 8) | m[5]), payload: Buffer.from(m.subarray(6)) };
}

// A UDP server on 127.0.0.1 that answers every datagram with "echo:" + the datagram.
export function udpEcho() {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.received = [];
    s.on("message", (msg, rinfo) => {
      s.received.push({ msg, rinfo });
      s.send(Buffer.concat([Buffer.from("echo:"), msg]), rinfo.port, rinfo.address);
    });
    s.bind(0, "127.0.0.1", () => resolve(s));
  });
}

// A UDP server that answers A2S_INFO like an Xash server does.
export function fakeGameServer({ name = "Test Server", map = "h9_te_neuropolis", mode = "Match Mode", players = 3, max = 16, bots = 1 } = {}) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.on("message", (msg, rinfo) => {
      if (msg.length >= 25 && msg.subarray(4, 24).toString("latin1") === "TSource Engine Query") {
        const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 49])];
        for (const t of [name, map, "ts", mode]) parts.push(Buffer.from(t + "\0", "utf8"));
        parts.push(Buffer.from([0, 0, players, max, bots, 0x64, 0x6c, 0, 0]), Buffer.from("0.21\0"));
        s.send(Buffer.concat(parts), rinfo.port, rinfo.address);
      }
    });
    s.bind(0, "127.0.0.1", () => resolve(s));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 3000, step = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met within " + ms + " ms");
    await sleep(step);
  }
}
