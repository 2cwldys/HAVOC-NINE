// Enrollment: how a game server gets its key without anyone typing one in.
//
//   1. The plugin POSTs /api/presence/enroll { v: 1, port } (or { server: "ip:port" }) over HTTPS.
//      With enrollSameIp (the default) the address is the caller's own IP: a server can only ask
//      for its own address. h9web answers { key, code, serverId }: the key is INACTIVE.
//   2. The plugin publishes the code in its FCVAR_SERVER cvar h9_presence_enroll and asks
//      /api/presence/enroll/status, signed with the new key. h9web asks that exact ip:port for
//      A2S_RULES over UDP (a2s.js); the code in the answer proves the address answers to whoever
//      holds the key. A code anyone reads from the rules is worth nothing without the key, and a
//      key for an address the asker does not run never sees its code there.
//   3. Proven: a server on servers.json goes live at once; any other waits for an admin
//      (enrollAutoApprove switches that off). The plugin keeps the key in its data folder and
//      clears the cvar.
// An address that already has a live key keeps it until a new enrollment is proven; then the new
// key replaces it, the audit log says so and admins get a re_enrolled flag. A live key with no
// report for enrollStaleDays expires; an enrollment not proven within enrollPendingMinutes is
// forgotten. A hand-made key (presence-key.js, server-keys.json) always wins over an enrolled one.
//
// Keys are never stored: each is HMAC-SHA256(<module data>/enroll-key, "srvkey1:" address ":"
// salt), and only the salt is in the database, so a copy of the database alone signs nothing.
// Losing enroll-key only makes every enrolled server enroll again, by itself.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addressKey } from "./keys.js";
import { queryRules as defaultQueryRules } from "./a2s.js";

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomText(n) {
  const bytes = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return s;
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

export function loadEnrollKey(dir, log) {
  const file = path.join(dir, "enroll-key");
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
    if (log) log.warn("presence.enroll_key_replaced", { file, effect: "every enrolled server enrolls again" });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

export function createEnrollment(deps) {
  const { db, s, log, router, auth, servers, keys, serverAuth, limit, ipKey, audit } = deps;
  const { HttpError } = deps.http;
  const now = deps.now;
  const tx = deps.transaction;
  const queryRules = deps.queryRules || defaultQueryRules;
  let secret = null;

  const q = {
    row: db.prepare("SELECT * FROM presence_enrolled WHERE server = ?"),
    byId: db.prepare("SELECT * FROM presence_enrolled WHERE server_id = ?"),
    insert: db.prepare("INSERT INTO presence_enrolled (server, server_id, created_at) VALUES (?, ?, ?)"),
    pend: db.prepare("UPDATE presence_enrolled SET pend_salt = ?, pend_code = ?, pend_at = ?, probe_at = NULL WHERE server = ?"),
    probe: db.prepare("UPDATE presence_enrolled SET probe_at = ? WHERE server = ?"),
    promote: db.prepare(`UPDATE presence_enrolled SET live_salt = pend_salt, live_since = ?, approved = ?, approved_by = NULL,
      pend_salt = NULL, pend_code = NULL, pend_at = NULL WHERE server = ?`),
    approve: db.prepare("UPDATE presence_enrolled SET approved = 1, approved_by = ? WHERE server = ?"),
    revoke: db.prepare("UPDATE presence_enrolled SET live_salt = NULL, live_since = NULL, approved = 0, pend_salt = NULL, pend_code = NULL, pend_at = NULL WHERE server = ?"),
    block: db.prepare("UPDATE presence_enrolled SET blocked = ? WHERE server = ?"),
    reported: db.prepare("UPDATE presence_enrolled SET last_report = ? WHERE server = ?"),
    staleLive: db.prepare("SELECT server FROM presence_enrolled WHERE live_salt IS NOT NULL AND COALESCE(last_report, live_since) < ?"),
    stalePend: db.prepare("UPDATE presence_enrolled SET pend_salt = NULL, pend_code = NULL, pend_at = NULL WHERE pend_at IS NOT NULL AND pend_at < ?"),
    list: db.prepare("SELECT * FROM presence_enrolled ORDER BY created_at DESC LIMIT 500"),
    flag: db.prepare("SELECT * FROM presence_server_flags WHERE server = ? AND kind = ? AND status = 'open'"),
    flagAdd: db.prepare("INSERT INTO presence_server_flags (server, kind, detail, first_at, last_at) VALUES (?, ?, ?, ?, ?)"),
    flagBump: db.prepare("UPDATE presence_server_flags SET last_at = ?, count = count + 1, detail = ? WHERE id = ?"),
    flagResolve: db.prepare("UPDATE presence_server_flags SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE server = ? AND kind = ? AND status = 'open'"),
    flags: db.prepare("SELECT * FROM presence_server_flags WHERE status = 'open' ORDER BY last_at DESC LIMIT 200"),
  };

  function keyFrom(server, salt) {
    if (!secret) secret = loadEnrollKey(deps.dataDir, log);
    return crypto.createHmac("sha256", secret).update("srvkey1:" + server + ":" + salt).digest("hex");
  }

  function ensureRow(server) {
    let row = q.row.get(server);
    if (row) return row;
    for (let i = 0; i < 5 && !row; i++) {
      try {
        q.insert.run(server, randomText(10), now());
      } catch (e) {
        if (!/UNIQUE/.test(String(e.message))) throw e;
      }
      row = q.row.get(server);
    }
    if (!row) throw new Error("presence: no server id could be made");
    return row;
  }

  function serverIdFor(server) {
    return ensureRow(server).server_id;
  }

  // The key a report must be signed with, and whether it may report: a hand-made key for a server
  // on servers.json; an enrolled one once proven and approved.
  function reportKey(server) {
    const manual = servers && servers.get(server) ? keys.get(server) : null;
    if (manual) return { key: manual, state: "active", manual: true };
    const row = q.row.get(server);
    if (!row || !row.live_salt) return { key: null, state: row && row.pend_salt ? "not_enrolled" : null };
    return { key: keyFrom(server, row.live_salt), state: row.approved ? "active" : "pending_approval" };
  }

  // Every key that may sign a signed server call: the live one (hand-made or enrolled, approved),
  // and with pending, a pending enrollment's as well (the status call only).
  function candidates(server, { pending = false } = {}) {
    const out = [];
    const r = reportKey(server);
    if (r.key && (r.state === "active" || pending)) out.push({ key: r.key, kind: r.state === "active" ? "live" : "unapproved" });
    if (pending) {
      const row = q.row.get(server);
      if (row && row.pend_salt) out.push({ key: keyFrom(server, row.pend_salt), kind: "pending" });
    }
    return out;
  }

  function serverFlag(server, kind, detail) {
    const t = now();
    const open = q.flag.get(server, kind);
    if (open) q.flagBump.run(t, detail, open.id);
    else q.flagAdd.run(server, kind, detail, t, t);
  }

  function markReport(server, t) {
    q.reported.run(t, server);
  }

  // Whether the rules at the address show the enrollment's code.
  async function prove(server, codeHash) {
    const [ip, port] = server.split(":");
    const rules = await queryRules(ip, Number(port), { timeoutMs: s.enrollProbeTimeoutMs });
    if (!rules) return false;
    const shown = String(rules.get("h9_presence_enroll") || "").trim();
    return shown.length >= 8 && sha256(shown) === codeHash;
  }

  function statusOf(row) {
    if (!row) return "unknown";
    if (row.blocked) return "blocked";
    if (row.live_salt) return row.approved ? "active" : "pending_approval";
    if (row.pend_salt) return "pending_proof";
    return "unknown";
  }

  router.post("/api/presence/enroll", async (req, res, rc) => {
    limit("enrollPerIp", ipKey(rc.ip));
    const body = await rc.body({ maxBytes: 1024 });
    const caller = String(rc.ip || "");
    let server = null;
    if (body.server !== undefined) server = addressKey(body.server);
    else if (Number.isInteger(body.port) && body.port >= 1 && body.port <= 65535) server = addressKey(caller + ":" + body.port);
    if (!server) throw new HttpError(400, "bad_request", "Send { port } from the server itself, or { server: \"ip:port\" }.");
    if (s.enrollSameIp && server.split(":")[0] !== caller) {
      throw new HttpError(403, "address_mismatch", "A server enrolls its own address: this request comes from another one.");
    }
    limit("enrollPerAddress", server);
    const t = now();
    const salt = crypto.randomBytes(16).toString("hex");
    const code = "h9-" + randomText(12);
    let row;
    tx(() => {
      row = ensureRow(server);
      if (row.blocked) return;
      q.pend.run(salt, sha256(code), t, server);
    });
    if (row.blocked) throw new HttpError(403, "blocked", "This address may not enroll. Ask H9's admins.");
    log.info("presence.enroll_asked", { server });
    rc.json(200, { ok: true, server, serverId: row.server_id, key: keyFrom(server, salt), code, status: "pending_proof", checkAfter: 5 });
  }, { csrf: false });

  router.post("/api/presence/enroll/status", async (req, res, rc) => {
    limit("enrollPerIp", ipKey(rc.ip));
    const { server, kind } = await serverAuth.verify(req, (srv) => candidates(srv, { pending: true }), { maxBytes: 2048 });
    let row = q.row.get(server);
    if (kind === "pending" && row && row.pend_salt) {
      const t = now();
      const due = !row.probe_at || t - row.probe_at >= s.enrollProbeSeconds;
      if (due) {
        q.probe.run(t, server);
        if (await prove(server, row.pend_code)) {
          // on servers.json, auto-approval on, or an address an admin approved before: live at once
          const listed = !!(servers && servers.get(server));
          const replacing = !!row.live_salt;
          const approved = listed || s.enrollAutoApprove || (replacing && row.approved === 1) ? 1 : 0;
          tx(() => {
            q.promote.run(t, approved, server);
            if (replacing) serverFlag(server, "re_enrolled", "a new key replaced the live one");
            if (!approved) serverFlag(server, "pending_approval", "enrolled; not on servers.json");
          });
          if (audit) audit.record({ actorName: "(enrollment)", action: replacing ? "presence.server.reenroll" : "presence.server.enroll", targetName: server, subject: "server " + row.server_id, detail: approved ? "live" : "waiting for approval" });
          log.info("presence.enrolled", { server, approved, replacing });
          row = q.row.get(server);
        }
      }
    }
    const status = statusOf(row);
    rc.json(200, { ok: true, server, serverId: row ? row.server_id : null, status, key: kind === "pending" ? "pending" : "live", retryAfter: status === "pending_proof" ? s.enrollProbeSeconds : 300 });
  }, { csrf: false });

  // ---- admins ------------------------------------------------------------------------------------

  const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null);
  const view = (r) => ({
    serverId: r.server_id, address: r.server, status: statusOf(r), listed: !!(servers && servers.get(r.server)), manual: !!keys.get(r.server),
    created: iso(r.created_at), live: iso(r.live_since), lastReport: iso(r.last_report), pending: iso(r.pend_at), blocked: !!r.blocked,
  });
  const byServerId = (id) => {
    const r = q.byId.get(String(id));
    if (!r) throw new HttpError(404, "not_found", "No such server.");
    return r;
  };
  const adminRoute = (handler) => auth.requireRole("admin", async (req, res, rc) => {
    limit("adminPerAccount", "a:" + rc.account.id);
    return handler(req, res, rc);
  });
  const record = (rc, action, r, detail) => {
    if (audit) audit.record({ actor: rc.account, action, targetName: r.server, subject: "server " + r.server_id, detail: detail || null });
  };

  router.get("/api/presence/admin/servers", adminRoute(async (req, res, rc) => {
    const want = rc.query.get("status") || "all";
    const list = q.list.all().map(view).filter((v) => want === "all" || v.status === want);
    rc.json(200, { servers: list, flags: q.flags.all().map((f) => ({ id: f.id, server: f.server, kind: f.kind, detail: f.detail, first: iso(f.first_at), last: iso(f.last_at), count: f.count })) });
  }));
  router.post("/api/presence/admin/servers/:serverId/approve", adminRoute(async (req, res, rc) => {
    const r = byServerId(rc.params.serverId);
    if (!r.live_salt) throw new HttpError(409, "not_proven", "This server has no proven key to approve.");
    tx(() => {
      q.approve.run(rc.account.id, r.server);
      q.flagResolve.run(now(), rc.account.id, r.server, "pending_approval");
    });
    record(rc, "presence.server.approve", r);
    rc.json(200, { ok: true, server: view(q.row.get(r.server)) });
  }));
  router.post("/api/presence/admin/servers/:serverId/revoke", adminRoute(async (req, res, rc) => {
    const r = byServerId(rc.params.serverId);
    q.revoke.run(r.server);
    record(rc, "presence.server.revoke", r);
    rc.json(200, { ok: true, server: view(q.row.get(r.server)) });
  }));
  router.post("/api/presence/admin/servers/:serverId/block", adminRoute(async (req, res, rc) => {
    const r = byServerId(rc.params.serverId);
    tx(() => {
      q.revoke.run(r.server);
      q.block.run(1, r.server);
    });
    record(rc, "presence.server.block", r);
    rc.json(200, { ok: true, server: view(q.row.get(r.server)) });
  }));
  router.post("/api/presence/admin/servers/:serverId/unblock", adminRoute(async (req, res, rc) => {
    const r = byServerId(rc.params.serverId);
    q.block.run(0, r.server);
    record(rc, "presence.server.unblock", r);
    rc.json(200, { ok: true, server: view(q.row.get(r.server)) });
  }));
  router.post("/api/presence/admin/servers/:serverId/flags/resolve", adminRoute(async (req, res, rc) => {
    const r = byServerId(rc.params.serverId);
    for (const kind of ["re_enrolled", "pending_approval"]) q.flagResolve.run(now(), rc.account.id, r.server, kind);
    record(rc, "presence.server.flags_resolve", r);
    rc.json(200, { ok: true });
  }));

  // Every sweep: live keys with no report for enrollStaleDays expire, unproven enrollments go.
  function sweep(t) {
    const stale = q.staleLive.all(t - s.enrollStaleDays * 86400);
    for (const r of stale) {
      q.revoke.run(r.server);
      log.info("presence.enroll_expired", { server: r.server });
    }
    q.stalePend.run(t - s.enrollPendingMinutes * 60);
    return stale.length;
  }

  function start() {
    secret = loadEnrollKey(deps.dataDir, log);
  }

  // The enrolled or hand-keyed server's row, for the views: { serverId, approved } or null.
  function enrolled(server) {
    const r = q.row.get(server);
    return r && r.live_salt && !r.blocked ? { serverId: r.server_id, approved: !!r.approved } : null;
  }

  return { reportKey, candidates, serverIdFor, markReport, enrolled, sweep, start, byServerId: (id) => q.byId.get(String(id)) || null };
}
