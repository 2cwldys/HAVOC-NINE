import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../lib/http.js";

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test("clientIp: no proxy trust uses the connection's own address, whatever the headers say", () => {
  assert.equal(clientIp(req("203.0.113.9", { "x-real-ip": "198.51.100.7" }), false), "203.0.113.9");
  assert.equal(clientIp(req("127.0.0.1", { "x-real-ip": "198.51.100.7" }), false), "127.0.0.1");
});

test("clientIp: nginx topology, X-Real-IP is believed from loopback only", () => {
  assert.equal(clientIp(req("127.0.0.1", { "x-real-ip": "198.51.100.7" }), true), "198.51.100.7");
  assert.equal(clientIp(req("::ffff:127.0.0.1", { "x-real-ip": "198.51.100.7" }), true), "198.51.100.7");
  // a peer that is not this machine cannot choose its address
  assert.equal(clientIp(req("203.0.113.9", { "x-real-ip": "198.51.100.7" }), true), "203.0.113.9");
});

test("clientIp: a bad or missing header falls back to the peer", () => {
  assert.equal(clientIp(req("127.0.0.1", { "x-real-ip": "not-an-ip" }), true), "127.0.0.1");
  assert.equal(clientIp(req("127.0.0.1", {}), true), "127.0.0.1");
  assert.equal(clientIp(req("127.0.0.1", { "x-real-ip": "198.51.100.7, 10.0.0.1" }), true), "127.0.0.1");
});

test("clientIp: tunnel topology reads the one header the edge sets, never X-Real-IP", () => {
  const t = "cf-connecting-ip";
  // cloudflared on loopback: the edge's header counts, a client-supplied X-Real-IP does not
  assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "198.51.100.7", "x-real-ip": "192.0.2.66" }), t), "198.51.100.7");
  assert.equal(clientIp(req("127.0.0.1", { "x-real-ip": "192.0.2.66" }), t), "127.0.0.1");
  assert.equal(clientIp(req("203.0.113.9", { "cf-connecting-ip": "198.51.100.7" }), t), "203.0.113.9");
});

test("clientIp: an unknown header name is refused", () => {
  assert.throws(() => clientIp(req("127.0.0.1", { "x-evil": "198.51.100.7" }), "x-evil"), /trustProxy/);
});

import { resolveConfig } from "../lib/config.js";

test("config: allowedOrigins must be https unless the origin is loopback or insecureCookies is set", () => {
  assert.doesNotThrow(() => resolveConfig({ allowedOrigins: ["https://havoc9.org"] }));
  assert.doesNotThrow(() => resolveConfig({ allowedOrigins: ["http://127.0.0.1:8090"] }));
  assert.throws(() => resolveConfig({ allowedOrigins: ["http://havoc9.org"] }), /use https/);
  assert.doesNotThrow(() => resolveConfig({ allowedOrigins: ["http://lan.example"], insecureCookies: true }));
});

test("config: trustProxy accepts only the known topologies", () => {
  for (const ok of [true, false, "x-real-ip", "cf-connecting-ip"]) assert.doesNotThrow(() => resolveConfig({ trustProxy: ok }));
  assert.throws(() => resolveConfig({ trustProxy: "x-forwarded-for" }), /trustProxy/);
  assert.throws(() => resolveConfig({ trustProxy: 1 }), /trustProxy/);
});
