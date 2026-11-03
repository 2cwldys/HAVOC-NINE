// Linking a downloaded game (H9XASH) to an account: the game shows a short code, the player
// approves it on havoc9.org/link/ while signed in, and the game is handed the account's player id.
// Nobody types or pastes a player id. The shape is RFC 8628's device authorization grant.
//
// The game's side (engine-h9-link.patch, docs\CUSTOM_XASH_USERID.txt). The engine's HTTP client
// sends GET only and reads a body only from a 200, so these four are GETs that answer 200 with a
// status for every outcome the game acts on:
//   GET /api/link/start?v=1&device=<32 hex>&os=windows|wine
//       { status: "ok", userCode: "WDJB-MJHT", deviceCode, interval, expiresIn, linkUrl }
//       { status: "busy", retryAfter }       too many codes asked for from this address
//   GET /api/link/poll?code=<deviceCode>
//       { status: "pending" }                not approved yet
//       { status: "slow_down", interval }    asked again before interval seconds had passed
//       { status: "approved", playerId, account, token }   once: the code is spent by it
//       { status: "denied" }                 the player pressed NOT ME, or the account is suspended
//       { status: "expired" }                no such code, out of time, or already spent
//   GET /api/link/status?token=<token>       once a start of a linked game
//       { status: "linked", account }  or  { status: "unlinked" }  (revoked, or the id was reset)
//   GET /api/link/unlink?token=<token>       h9_unlink in the game: { status: "unlinked" }
//   GET /api/link/adopt/nonce?v=1            { status: "ok", nonce } (or busy): one use, adoptNonceSeconds
//   GET /api/link/adopt?v=1&key=&nonce=&devmask=&proof=&os=
//       a game whose id is already an account's (enter_userid.cmd, an id from before linking) asks
//       to be linked by it, with presence's ID proof (docs\H9_PRESENCE.txt section 8): key is
//       adoptKey(the player id) (lib/clientids.js), devmask and proof are cl_idproof.c's for this
//       nonce with S = "h9link-adopt". The raw id never travels.
//       { status: "linked", account, token }   a link, bound to the device the proof unmasks
//       { status: "unknown" }                  the id is no account's
//       { status: "refused", reason }          stale (no such nonce, or used), bad_proof,
//                                              suspended, second_device (presence's rule: the
//                                              account's id is bound to another device)
//   GET /api/link/profile/<account>          the scoreboard's double-click on a linked player's
//       picture (the engine's h9_profile, engine-h9-avatars.patch), opened in the web browser:
//       302 to the account's forum profile, /forum/user/?u=<username>, whose card shows only what
//       the account's privacy switches let others see (its playtime under SHOW MY PLAYTIME); 404
//       for no such account. The account is the number the game server named for the picture.
// The site's side (havoc9.org/link/ and the account page), signed in:
//   GET  /api/link/code?code=WDJB-MJHT       what the code would link: { code, label, os,
//                                            created, expiresIn, sameNetwork }
//   POST /api/link/approve { code }          200 { ok }
//   POST /api/link/deny    { code }          200 { ok }
//   GET  /api/link/devices                   { devices: [{ id, label, os, device, linked, lastSeen }] }
//   POST /api/link/devices/:id/revoke        200 { ok }
//
// What is kept. A code waiting for approval lives in memory only, for codeSeconds (10 minutes): the
// SHA-256 of its device code, its user code, the game's device hash and system, and the requesting
// address's limiter key, which the approval page compares with the browser's own to say whether the
// code was made on the same network. A restart forgets every waiting code. A completed link is a row
// of account_links: the account, the SHA-256 of the link token the game holds (the token itself is
// sent once, in the approved poll, and kept nowhere here), the device hash the game sent (presence's
// form, SHA-256("h9device1:" + the device id), first 32 hex), the label, when it was made and when
// the game last checked in. Every completed link, REVOKE and h9_unlink goes into the audit log.
//
// The player id stays in core (lib/accounts.js): it leaves only in the approved poll, to the holder
// of the device code the signed-in owner approved. Adopting hands out no player id: the game proves
// it holds one already, and gets a link token for it. Whoever holds an account's player id is that
// account to H9's servers already, so adopting grants nothing new; it is rate-limited, refused to a
// suspended account and to a device presence has not bound to the account, and audit-logged. A changed player id (resetPlayerId,
// movePlayerId) ends every link of the account: the games hold a dead id, and their next status
// check unlinks them. Events, for modules in this process:
//   account-link   { id, link, device }            a game was linked
//   account-unlink { id, link, device, reason }    revoked | unlinked | replaced | player-id

import crypto from "node:crypto";
import { HttpError } from "./http.js";
import { ipKey } from "./ratelimit.js";

// RFC 8628's user code alphabet: no vowels, so no words; no digits, so no 0/O or 1/I mix-ups.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const LABELS = { windows: "H9XASH on Windows", wine: "H9XASH under Wine or Proton" };
// the "server" the adopt proof signs, in place of a game server's address
const ADOPT_S = "h9link-adopt";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function newUserCode() {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length]; // 256 = 12 * 20 + 16: a 1.07 bias at most, on 34.6 bits
  return code;
}

// what a player typed: case, spaces and the hyphen do not matter
export function normalizeUserCode(text) {
  const s = String(text || "").toUpperCase().replace(/[\s-]/g, "");
  return USER_CODE.test(s) ? s : null;
}

export const showUserCode = (code) => code.slice(0, 4) + "-" + code.slice(4);

function limited(result) {
  const minutes = Math.max(1, Math.ceil(result.retryAfter / 60));
  return new HttpError(429, "rate_limited", "Too many tries. Wait " + minutes + " minute" + (minutes === 1 ? "" : "s") + " and try again.", {
    headers: { "Retry-After": String(result.retryAfter) },
    body: { retryAfter: result.retryAfter },
  });
}

export function createLinks({ db, accounts, audit, config, events, log, clientIds, now = Date.now }) {
  const settings = config.link;
  const q = {
    insert: db.prepare("INSERT INTO account_links (account_id, token_hash, device, os, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    byToken: db.prepare("SELECT * FROM account_links WHERE token_hash = ?"),
    byId: db.prepare("SELECT * FROM account_links WHERE id = ?"),
    ofAccount: db.prepare("SELECT * FROM account_links WHERE account_id = ? ORDER BY created_at DESC, id DESC"),
    sameDevice: db.prepare("SELECT * FROM account_links WHERE account_id = ? AND device = ?"),
    touch: db.prepare("UPDATE account_links SET last_seen_at = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM account_links WHERE id = ?"),
  };
  const emit = (name, data) => { if (events) events.emit(name, data); };

  const byDevice = new Map(); // SHA-256 of the device code -> the waiting code
  const byUser = new Map();   // user code -> the same record
  const adoptNonces = new Map(); // nonce -> { expiresAt, ipKey }

  function forget(rec) {
    byDevice.delete(rec.deviceHash);
    if (byUser.get(rec.userCode) === rec) byUser.delete(rec.userCode);
  }

  function sweep(t = now()) {
    for (const rec of byDevice.values()) if (rec.expiresAt <= t) forget(rec);
    for (const [nonce, n] of adoptNonces) if (n.expiresAt <= t) adoptNonces.delete(nonce);
  }
  const sweeper = setInterval(() => sweep(), 60000);
  sweeper.unref();

  function waiting(code, t = now()) {
    const rec = byUser.get(code);
    if (!rec || rec.expiresAt <= t || rec.state === "spent") return null;
    return rec;
  }

  // ---- the game's side ----------------------------------------------------------------

  function start({ ip, device, os }) {
    const t = now();
    sweep(t);
    const key = ipKey(ip);
    let mine = 0;
    for (const rec of byDevice.values()) if (rec.ipKey === key && rec.state === "pending") mine++;
    if (mine >= settings.maxPendingPerIp || byDevice.size >= settings.maxPending) {
      return { status: "busy", retryAfter: settings.intervalSeconds * 12 };
    }
    let userCode;
    do userCode = newUserCode(); while (byUser.has(userCode));
    const deviceCode = crypto.randomBytes(32).toString("base64url");
    const rec = {
      deviceHash: sha256(deviceCode),
      userCode,
      createdAt: t,
      expiresAt: t + settings.codeSeconds * 1000,
      interval: settings.intervalSeconds,
      lastPollAt: 0,
      ipKey: key,
      device: HEX32.test(String(device || "")) ? String(device) : null,
      os: Object.hasOwn(LABELS, os) ? os : null,
      state: "pending",
      accountId: null,
    };
    byDevice.set(rec.deviceHash, rec);
    byUser.set(userCode, rec);
    return {
      status: "ok",
      userCode: showUserCode(userCode),
      deviceCode,
      interval: rec.interval,
      expiresIn: settings.codeSeconds,
      linkUrl: config.allowedOrigins[0] + "/link/?code=" + showUserCode(userCode),
    };
  }

  // The answer to one poll. The approved answer is given once, and makes the link row.
  function poll(deviceCode) {
    const t = now();
    const rec = DEVICE_CODE.test(String(deviceCode || "")) ? byDevice.get(sha256(String(deviceCode))) : null;
    if (!rec || rec.state === "spent") return { status: "expired" };
    if (rec.expiresAt <= t) {
      forget(rec);
      return { status: "expired" };
    }
    if (rec.state === "denied") {
      forget(rec);
      return { status: "denied" };
    }
    if (rec.state === "pending") {
      // a game that asks faster than it was told waits longer from then on (RFC 8628, 3.5)
      const early = rec.lastPollAt && t - rec.lastPollAt < rec.interval * 1000 - 500;
      rec.lastPollAt = t;
      if (early) {
        rec.interval += 5;
        return { status: "slow_down", interval: rec.interval };
      }
      return { status: "pending" };
    }
    // approved: the account is read again, as it is now
    const account = accounts.getById(rec.accountId);
    rec.state = "spent";
    forget(rec);
    if (!account) return { status: "expired" };
    if (accounts.isBanned(account)) return { status: "denied" };
    const token = makeLink(account, rec.device, rec.os, "account.link", t);
    return { status: "approved", playerId: accounts.playerId(account), account: account.username, token };
  }

  // A link row for the account and the game's device (replacing that device's older link), in the
  // audit log as action; the token the game keeps, which this side keeps only as a hash.
  function makeLink(account, device, os, action, t = now()) {
    const token = crypto.randomBytes(32).toString("base64url");
    const label = LABELS[os] || "H9XASH";
    const seconds = Math.floor(t / 1000);
    let replaced = [];
    if (device) replaced = q.sameDevice.all(account.id, device);
    for (const old of replaced) q.remove.run(old.id);
    const id = Number(q.insert.run(account.id, sha256(token), device, Object.hasOwn(LABELS, os) ? os : null, label, seconds, seconds).lastInsertRowid);
    for (const old of replaced) emit("account-unlink", { id: account.id, link: old.id, device: old.device, reason: "replaced" });
    audit.record({ actor: account, action, target: account, subject: "link " + id,
      detail: label + (device ? ", device " + device.slice(0, 8) : "") + (replaced.length ? ", replacing link " + replaced.map((r) => r.id).join(", ") : ""), at: seconds });
    if (log) log.info(action === "account.link" ? "link.made" : "link.adopted", { user: account.username, link: id });
    emit("account-link", { id: account.id, link: id, device });
    return token;
  }

  // ---- adopting the id a game holds ---------------------------------------------------------

  function adoptNonce({ ip }) {
    const t = now();
    sweep(t);
    if (adoptNonces.size >= settings.maxPending) return { status: "busy", retryAfter: 60 };
    const nonce = crypto.randomBytes(16).toString("hex");
    adoptNonces.set(nonce, { expiresAt: t + settings.adoptNonceSeconds * 1000, ipKey: ipKey(ip) });
    return { status: "ok", nonce };
  }

  // presence's rule, when the presence module is there: the first device that proves an account's
  // id is bound to it, and another needs an admin's allow (modules/presence, presence_devices)
  let devicesQ = null;
  function otherDevice(accountId, device) {
    if (devicesQ === null) {
      try {
        devicesQ = {
          count: db.prepare("SELECT count(*) AS n FROM presence_devices WHERE account_id = ?"),
          has: db.prepare("SELECT 1 AS x FROM presence_devices WHERE account_id = ? AND device = ?"),
        };
      } catch (e) {
        devicesQ = false; // no presence module: no device rule
      }
    }
    if (!devicesQ) return false;
    return devicesQ.count.get(accountId).n > 0 && !devicesQ.has.get(accountId, device);
  }

  // { result, accountId }: accountId is set once the key names an account, for the caller's limits
  function adopt({ key, nonce, devmask, proof, os }, refusedHit) {
    const t = now();
    if (!HEX32.test(String(key || "")) || !HEX32.test(String(nonce || "")) || !HEX32.test(String(devmask || "")) || !/^[0-9a-f]{64}$/.test(String(proof || ""))) {
      return { result: { status: "refused", reason: "bad_request" } };
    }
    const issued = adoptNonces.get(nonce);
    adoptNonces.delete(nonce);
    if (!issued || issued.expiresAt <= t) return { result: { status: "refused", reason: "stale" } };
    const accountId = clientIds ? clientIds.adoptIndex().get(key) : undefined;
    if (!accountId) return { result: { status: "unknown" } };
    const account = accounts.getById(accountId);
    if (!account) return { result: { status: "unknown" } };
    if (refusedHit && !refusedHit(accountId, false)) return { result: { status: "busy", retryAfter: 600 }, accountId };
    if (accounts.isBanned(account)) return { result: { status: "refused", reason: "suspended" }, accountId };
    const v = accounts.verifyIdProof(accountId, { nonce, server: ADOPT_S, devmask, proof });
    if (!v.valid) {
      if (refusedHit) refusedHit(accountId, true);
      if (log) log.warn("link.adopt.bad_proof", { user: account.username });
      return { result: { status: "refused", reason: "bad_proof" }, accountId };
    }
    if (otherDevice(accountId, v.device)) {
      audit.record({ actor: account, action: "account.link.adopt.refused", target: account, subject: "device " + v.device.slice(0, 8),
        detail: "the account's id is bound to another device (presence): an admin may allow this one" });
      return { result: { status: "refused", reason: "second_device" }, accountId };
    }
    const token = makeLink(account, v.device, os, "account.link.adopt", t);
    return { result: { status: "linked", account: account.username, token }, accountId };
  }

  function status(token) {
    const row = TOKEN.test(String(token || "")) ? q.byToken.get(sha256(String(token))) : null;
    if (!row) return { status: "unlinked" };
    const account = accounts.getById(row.account_id);
    if (!account) return { status: "unlinked" };
    q.touch.run(nowSeconds(), row.id);
    return { status: "linked", account: account.username };
  }

  function drop(row, reason, actor) {
    q.remove.run(row.id);
    const account = accounts.getById(row.account_id);
    if (account && actor !== null) {
      audit.record({ actor: actor || account, action: reason === "revoked" ? "account.link.revoke" : "account.link.unlink",
        target: account, subject: "link " + row.id, detail: row.label + (row.device ? ", device " + row.device.slice(0, 8) : "") });
    }
    emit("account-unlink", { id: row.account_id, link: row.id, device: row.device, reason });
  }

  // h9_unlink: the game says it has let go of the id
  function unlinkByToken(token) {
    const row = TOKEN.test(String(token || "")) ? q.byToken.get(sha256(String(token))) : null;
    if (row) {
      drop(row, "unlinked");
      if (log) log.info("link.unlinked", { link: row.id });
    }
    return { status: "unlinked" };
  }

  // ---- the site's side ------------------------------------------------------------------

  function codeView(rec, ip) {
    return {
      code: showUserCode(rec.userCode),
      label: LABELS[rec.os] || "H9XASH",
      os: rec.os,
      created: new Date(rec.createdAt).toISOString(),
      expiresIn: Math.max(0, Math.ceil((rec.expiresAt - now()) / 1000)),
      sameNetwork: rec.ipKey === ipKey(ip),
    };
  }

  function lookup(text) {
    const code = normalizeUserCode(text);
    const rec = code ? waiting(code) : null;
    return { code, rec };
  }

  function approve(account, rec) {
    if (rec.state !== "pending") throw new HttpError(409, "code_used", "That code has been answered already. Ask the game for a new one.");
    rec.state = "approved";
    rec.accountId = account.id;
  }

  function deny(account, rec) {
    if (rec.state !== "pending") throw new HttpError(409, "code_used", "That code has been answered already. Ask the game for a new one.");
    rec.state = "denied";
    audit.record({ actor: account, action: "account.link.deny", target: account, subject: "code " + showUserCode(rec.userCode),
      detail: (LABELS[rec.os] || "H9XASH") + (rec.device ? ", device " + rec.device.slice(0, 8) : "") });
  }

  // The scoreboard's double-click: an account number's forum profile, as the path the browser is
  // sent on to, or null for no such account (2147483647, the site's default picture, is nobody's).
  function profilePath(text) {
    const id = typeof text === "string" && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
    const account = id > 0 && id <= 2147483647 ? accounts.getById(id) : null;
    return account ? "/forum/user/?u=" + encodeURIComponent(account.username) : null;
  }

  function devices(accountId) {
    return q.ofAccount.all(accountId).map((r) => ({
      id: r.id, label: r.label, os: r.os, device: r.device ? r.device.slice(0, 8) : null,
      linked: iso(r.created_at), lastSeen: iso(r.last_seen_at),
    }));
  }

  function revoke(account, linkId) {
    const row = q.byId.get(linkId);
    if (!row || row.account_id !== account.id) throw new HttpError(404, "not_found", "No such linked game on this account.");
    drop(row, "revoked", account);
    if (log) log.info("link.revoked", { user: account.username, link: row.id });
  }

  // a new player id: every linked game holds the old one
  if (events) {
    events.on("account-player-id", ({ id }) => {
      for (const row of q.ofAccount.all(id)) drop(row, "player-id", null);
    });
  }

  return {
    start, poll, status, unlinkByToken, codeView, lookup, approve, deny, devices, revoke, sweep,
    adoptNonce, adopt, profilePath,
    pendingCount: () => byDevice.size,
    stop() { clearInterval(sweeper); },
  };
}

export function registerLinkRoutes(router, { auth, links, limits }) {
  const hit = (limiter, key) => {
    const r = limiter.hit(key);
    if (!r.ok) throw limited(r);
  };

  // ---- the game ----
  router.get("/api/link/start", async (req, res, rc) => {
    const lim = limits.linkStartPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) return rc.json(200, { status: "busy", retryAfter: lim.retryAfter });
    rc.json(200, links.start({ ip: rc.ip, device: rc.query.get("device"), os: rc.query.get("os") }));
  });

  router.get("/api/link/poll", async (req, res, rc) => {
    const lim = limits.linkPollPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) return rc.json(200, { status: "slow_down", interval: Math.max(5, lim.retryAfter) });
    rc.json(200, links.poll(rc.query.get("code")));
  });

  router.get("/api/link/status", async (req, res, rc) => {
    const lim = limits.linkStatusPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) return rc.json(200, { status: "busy", retryAfter: lim.retryAfter });
    rc.json(200, links.status(rc.query.get("token")));
  });

  router.get("/api/link/unlink", async (req, res, rc) => {
    const lim = limits.linkStatusPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) return rc.json(200, { status: "busy", retryAfter: lim.retryAfter });
    rc.json(200, links.unlinkByToken(rc.query.get("token")));
  });

  router.get("/api/link/adopt/nonce", async (req, res, rc) => {
    const lim = limits.linkAdoptPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) return rc.json(200, { status: "busy", retryAfter: lim.retryAfter });
    rc.json(200, links.adoptNonce({ ip: rc.ip }));
  });

  // per address, every try; per account, the proofs that did not check out (checked before each
  // try of that account, counted after a refusal)
  router.get("/api/link/adopt", async (req, res, rc) => {
    const lim = limits.linkAdoptPerIp.hit(ipKey(rc.ip));
    if (!lim.ok) return rc.json(200, { status: "busy", retryAfter: lim.retryAfter });
    const q = rc.query;
    const refusedHit = (accountId, count) => {
      const key = "a:" + accountId;
      return (count ? limits.linkAdoptPerAccount.hit(key) : limits.linkAdoptPerAccount.check(key)).ok;
    };
    const { result } = links.adopt({ key: q.get("key"), nonce: q.get("nonce"), devmask: q.get("devmask"), proof: q.get("proof"), os: q.get("os") }, refusedHit);
    rc.json(200, result);
  });

  // The scoreboard's double-click on a linked player's picture: the engine opens
  // <site>/api/link/profile/<account> in the web browser, and the browser is sent on to the
  // account's forum profile. No session: the browser may not be signed in.
  router.get("/api/link/profile/:account", async (req, res, rc) => {
    hit(limits.linkProfilePerIp, ipKey(rc.ip));
    const to = links.profilePath(rc.params.account);
    if (!to) throw new HttpError(404, "not_found", "No such account.");
    rc.send(302, "", "text/plain; charset=utf-8", { Location: to, "Cache-Control": "no-store" });
  });

  // ---- the site, signed in ----
  // Every look at a code counts, per account and per address, so a code cannot be guessed.
  function found(rc, text) {
    hit(limits.linkCodePerAccount, "a:" + rc.account.id);
    hit(limits.linkCodePerIp, ipKey(rc.ip));
    const { code, rec } = links.lookup(text);
    if (!code) throw new HttpError(400, "bad_code", "That is not a code: it is 8 letters, like WDJB-MJHT.");
    if (!rec) throw new HttpError(404, "no_code", "No game is waiting with that code: it may have run out (10 minutes). Ask the game for a new one.");
    return rec;
  }

  router.get("/api/link/code", auth.requireSession(async (req, res, rc) => {
    const rec = found(rc, rc.query.get("code"));
    rc.json(200, links.codeView(rec, rc.ip));
  }));

  router.post("/api/link/approve", auth.requireSession(async (req, res, rc) => {
    const body = await rc.body();
    const rec = found(rc, typeof body.code === "string" ? body.code : "");
    links.approve(rc.account, rec);
    rc.json(200, { ok: true });
  }));

  router.post("/api/link/deny", auth.requireSession(async (req, res, rc) => {
    const body = await rc.body();
    const rec = found(rc, typeof body.code === "string" ? body.code : "");
    links.deny(rc.account, rec);
    rc.json(200, { ok: true });
  }));

  router.get("/api/link/devices", auth.requireSession(async (req, res, rc) => {
    rc.json(200, { devices: links.devices(rc.account.id) });
  }));

  router.post("/api/link/devices/:id/revoke", auth.requireSession(async (req, res, rc) => {
    hit(limits.linkRevokePerAccount, "a:" + rc.account.id);
    const id = /^[1-9][0-9]{0,15}$/.test(rc.params.id) ? Number(rc.params.id) : 0;
    links.revoke(rc.account, id);
    rc.json(200, { ok: true });
  }));
}
