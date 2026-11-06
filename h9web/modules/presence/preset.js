// The official preset, and what the server browser's chain says (docs\H9_PRESENCE.txt, section 4d).
//
// A game server is AUTHENTICATED while it reports to h9web with a live key and runs the official
// preset: every AMX Mod X plugin and module and every Metamod plugin its report lists is on the
// allowlist kept here (presence_preset: the kind, the file's name and the SHA-256 of its bytes). A
// roleplay map is exempt from that check and rates nothing. A server that runs anything else is
// "modified": it is not blocked, kicked or hidden, it simply is not authenticated, so the game's
// browser draws it a red broken chain and its matches are not rated (compete.js answers a start 409
// not_rated). The list is the server's own word, so it catches unofficial setups and mistakes, not a
// determined operator with a modified h9_presence.
//
//   code  chain  rated  what it means
//   ok    green  yes    reporting, and everything it lists is on the allowlist (or none is kept)
//   rp    green  no     reporting, on a roleplay map: the check does not apply and nothing is rated
//   mod   red    no     reporting, but something it lists is off the allowlist, or it listed nothing
//   opt   red    no     reporting, and its operator set h9_authenticated 0 (the report says authenticated: false):
//                       the server asked not to be authenticated or rated. 1, the default, asks for nothing: the
//                       site judges what the server runs, and a server can never be more authenticated than that
//   off   red    no     not reporting: not enrolled, silent, or a server this module keeps private
//
// GET /api/presence/servers/auth is the game's browser's read (cl_h9auth.c): the line "H9SRV 1", then
// "<address> <code>" for each reporting server that is not private, ok, rp, mod or opt; a server that is
// not listed is off.
//
// An empty allowlist keeps no preset: every reporting server is "ok" until an admin imports one
// (bin/preset-seed.js makes the file from a build's presets).

import { roleplayMap } from "./modes.js";

export const KINDS = Object.freeze({ amxx: "AMX Mod X plugin", module: "AMX Mod X module", meta: "Metamod plugin" });
const HEX64 = /^[0-9a-f]{64}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9_. +()-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null);
const idOf = (kind, file, sha) => kind + "|" + file.toLowerCase() + "|" + sha;
const cleanVersion = (v) => (typeof v === "string" ? v.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 24) : "");

/**
 * A report's "plugins" as a clean list [{ k, f, v, h }]: k amxx, module or meta; f the file's name;
 * v its version, as text; h the SHA-256 of its bytes as 64 hex, or "" when the server could not read
 * the file. Null when it is not a list of that shape or is longer than max.
 */
export function readComponents(raw, max) {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return null;
    const f = typeof c.f === "string" ? c.f.trim() : "";
    const h = typeof c.h === "string" ? c.h.trim().toLowerCase() : "";
    if (!Object.hasOwn(KINDS, c.k) || !FILE.test(f) || (h && !HEX64.test(h))) return null;
    const id = idOf(c.k, f, h);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ k: c.k, f, v: cleanVersion(c.v), h });
  }
  return out;
}

/** Allowlist entries from an admin's import, or throws what is wrong with the one at fault. */
export function readEntries(raw, max, bad) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) throw bad("entries: a list of 1 to " + max + " files.");
  const out = [];
  raw.forEach((e, i) => {
    const where = "entries[" + i + "]: ";
    if (!e || typeof e !== "object" || Array.isArray(e)) throw bad(where + "an object { kind, file, sha256 }.");
    const file = typeof e.file === "string" ? e.file.trim() : "";
    const sha = typeof e.sha256 === "string" ? e.sha256.trim().toLowerCase() : "";
    if (!Object.hasOwn(KINDS, e.kind)) throw bad(where + "kind is amxx, module or meta.");
    if (!FILE.test(file)) throw bad(where + "file is a file's name, with no folder.");
    if (!HEX64.test(sha)) throw bad(where + "sha256 is 64 hex characters.");
    if (e.optional !== undefined && typeof e.optional !== "boolean") throw bad(where + "optional is true or false.");
    const note = typeof e.note === "string" ? e.note.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
    out.push({ kind: e.kind, file, sha256: sha, version: cleanVersion(e.version), optional: e.optional === true, note: note || null });
  });
  return out;
}

export function createPreset(deps) {
  const { db, s, now, HttpError, log, enrollment, isPrivate, router, limit, ipKey } = deps;
  // whether the site's own status poll hears the server answer (index.js hands it over); a server it cannot poll is never alive
  const alive = typeof deps.alive === "function" ? deps.alive : () => false;
  const startedAt = now();
  const tx = deps.transaction;
  const q = {
    all: db.prepare("SELECT * FROM presence_preset ORDER BY kind, file, added_at"),
    put: db.prepare(`INSERT INTO presence_preset (kind, file, sha256, version, optional, note, added_by, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, file, sha256) DO UPDATE SET version = excluded.version, optional = excluded.optional, note = excluded.note`),
    remove: db.prepare("DELETE FROM presence_preset WHERE kind = ? AND file = ? AND sha256 = ?"),
    clearOfficial: db.prepare("DELETE FROM presence_preset WHERE optional = 0"),
    setComponents: db.prepare("UPDATE presence_servers SET plugins = ?, plugins_at = ? WHERE server = ?"),
    setOptedOut: db.prepare("UPDATE presence_servers SET opted_out = ? WHERE server = ?"),
    row: db.prepare("SELECT server, name, map, humans, last_report, plugins, plugins_at, opted_out FROM presence_servers WHERE server = ?"),
    fresh: db.prepare("SELECT server, name, map, humans, last_report, plugins, plugins_at, opted_out FROM presence_servers WHERE last_report >= ? ORDER BY server LIMIT 1000"),
  };

  let list = null; // id -> entry, rebuilt after a change, and every cacheSeconds (the command line tool writes the table too)
  let names = null; // "kind|file" of every entry: the file is known, its bytes may not be
  let loadedAt = 0;
  function load() {
    loadedAt = now();
    list = new Map();
    names = new Set();
    for (const r of q.all.all()) {
      list.set(idOf(r.kind, r.file, r.sha256), r);
      names.add(r.kind + "|" + r.file.toLowerCase());
    }
    return list;
  }
  const allowed = () => (list && now() - loadedAt < s.cacheSeconds ? list : load());
  const kept = () => allowed().size;

  /** The stored list of a server's report, or null when it never gave a usable one. */
  function componentsOf(row) {
    if (!row || !row.plugins || row.plugins === "!") return null;
    try {
      const parsed = JSON.parse(row.plugins);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /** What in a list is not on the allowlist, each with the reason. */
  function offenders(components) {
    const a = allowed();
    const bad = [];
    for (const c of components) {
      if (!c.h) bad.push({ ...c, why: "its file could not be read" });
      else if (!a.has(idOf(c.k, c.f, c.h))) bad.push({ ...c, why: names.has(c.k + "|" + c.f.toLowerCase()) ? "not the official file (another hash)" : "not on the official list" });
    }
    return bad;
  }

  /** Whether a server's last plugin list is the official preset: { ok, why, bad }. With no preset kept there is nothing to judge. */
  function compliance(row) {
    if (row && row.opted_out === 1) return { ok: false, why: "its operator set h9_authenticated 0", bad: [] };
    if (kept() === 0) return { ok: true, why: "no preset is kept", bad: [] };
    const components = componentsOf(row);
    if (components === null) {
      return { ok: false, why: row && row.plugins === "!" ? "its plugin list could not be read" : "it has not reported its plugin list", bad: [] };
    }
    const bad = offenders(components);
    return bad.length ? { ok: false, why: "something it runs is off the official list", bad } : { ok: true, why: "the official preset", bad: [] };
  }

  /**
   * How long a server's last report counts as reporting. h9_presence reports every tick, h9_presence_interval
   * (60 seconds by default), so authFreshSeconds is many ticks, enough for a map to load or the site to restart.
   * A server whose last report said nobody was on it gets authQuietSeconds when that is longer: an h9_presence
   * that skips an empty server's tick sends its report only with its plugin list, every 20 minutes.
   */
  const freshFor = (row) => (row.humans === 0 ? Math.max(s.authFreshSeconds, s.authQuietSeconds) : s.authFreshSeconds);

  /**
   * Whether a server still counts as reporting. A report is current for freshFor(row) seconds; past that the server keeps what
   * its last report earned for as long as it is alive, the site's own status poll hearing it answer, up to authHoldSeconds.
   * A verdict rests on what the server's report said, not on the clock: a gap between reports (a map loading, a plugin that
   * reports an empty server rarely, a failed request) takes nothing away from a server that is there. The time this site
   * itself was not running is not counted against any server.
   */
  function reporting(row, t, server) {
    const age = t - Math.max(row.last_report, startedAt);
    if (age <= freshFor(row)) return true;
    return age <= s.authHoldSeconds && alive(server);
  }

  /** { code: "ok" | "rp" | "mod" | "off", why, bad? } for a server, from its last report. */
  function verdict(server, t = now(), row = q.row.get(server)) {
    if (!row || !reporting(row, t, server)) return { code: "off", why: "not reporting" };
    const key = enrollment.reportKey(server);
    if (!key.key || key.state !== "active") return { code: "off", why: "not enrolled" };
    if (row.opted_out === 1) return { code: "opt", why: "its operator set h9_authenticated 0: nothing is rated" };
    if (roleplayMap(row.map)) return { code: "rp", why: "roleplay map: nothing is rated" };
    const c = compliance(row);
    return c.ok ? { code: "ok", why: c.why } : { code: "mod", why: c.why, bad: c.bad };
  }

  /**
   * Whether rated play may count on a server: what it runs is the official preset. The call that asks is
   * signed with the server's key, so it is enrolled; a roleplay map is compete.js's own check.
   */
  const rated = (server) => compliance(q.row.get(server)).ok;

  /**
   * What a report says for the verdict: its "plugins" are kept (an unusable list is kept as unusable), and
   * authenticated: false, which h9_presence sends while the server's h9_authenticated is 0, opts the server out.
   */
  function noteReport(server, raw, authenticated, t) {
    q.setOptedOut.run(authenticated === false ? 1 : 0, server);
    if (raw === undefined) return;
    const components = readComponents(raw, s.presetMaxComponents);
    if (components === null) {
      log.warn("presence.preset_unreadable", { server });
      q.setComponents.run("!", t, server);
      return;
    }
    q.setComponents.run(JSON.stringify(components), t, server);
  }

  function publicText(t) {
    const lines = ["H9SRV 1"];
    for (const r of q.fresh.all(t - s.authHoldSeconds)) {
      if (isPrivate(r.server)) continue;
      const v = verdict(r.server, t, r);
      if (v.code !== "off") lines.push(r.server + " " + v.code);
    }
    return lines.join("\n") + "\n";
  }

  function entryView(r) {
    return { kind: r.kind, file: r.file, sha256: r.sha256, version: r.version || null, optional: !!r.optional, note: r.note, addedAt: iso(r.added_at) };
  }

  function adminView(t) {
    const servers = q.fresh.all(t - s.authHoldSeconds).map((r) => {
      const v = verdict(r.server, t, r);
      return {
        server: r.server, serverId: enrollment.serverIdFor(r.server), name: r.name, map: r.map, code: v.code, why: v.why,
        listedAt: iso(r.plugins_at), reportedAt: iso(r.last_report), private: !!isPrivate(r.server),
        offending: (v.bad || []).map((c) => ({ kind: c.k, file: c.f, version: c.v || null, sha256: c.h || null, why: c.why })),
      };
    });
    return { enforced: kept() > 0, freshSeconds: s.authFreshSeconds, quietSeconds: s.authQuietSeconds, holdSeconds: s.authHoldSeconds, entries: q.all.all().map(entryView), servers };
  }

  // The game's browser's read: small, public, and cached like the other public reads.
  router.get("/api/presence/servers/auth", async (req, res, rc) => {
    limit("readPerIp", ipKey(rc.ip));
    rc.send(200, publicText(now()), "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=" + s.cacheSeconds });
  });

  // The admins' side: index.js hands over its admin() wrapper and its audit record once both exist.
  function registerAdmin(admin, record) {
    router.get("/api/presence/admin/preset", admin(async (req, res, rc) => {
      rc.json(200, adminView(now()));
    }));
    // { mode: "add" | "replace", entries: [{ kind, file, sha256, version?, optional?, note? }] }. "add" keeps
    // what is there (older builds' hashes stay official); "replace" first drops every entry that is not
    // optional. An entry that is there already takes the new version, optional flag and note.
    router.post("/api/presence/admin/preset/import", admin(async (req, res, rc) => {
      const body = await rc.body({ maxBytes: 524288 });
      const mode = body.mode === undefined ? "add" : body.mode;
      if (mode !== "add" && mode !== "replace") throw new HttpError(400, "bad_request", "mode: add or replace.");
      const entries = readEntries(body.entries, s.presetMaxEntries, (m) => new HttpError(400, "bad_request", m));
      const t = now();
      tx(() => {
        if (mode === "replace") q.clearOfficial.run();
        for (const e of entries) q.put.run(e.kind, e.file, e.sha256, e.version || null, e.optional ? 1 : 0, e.note, rc.account.id, t);
      });
      load();
      record(rc, "presence.preset.import", null, "preset", entries.length + " file(s), " + mode);
      rc.json(200, { ok: true, imported: entries.length, mode, total: kept() });
    }));
    router.post("/api/presence/admin/preset/remove", admin(async (req, res, rc) => {
      const body = await rc.body();
      const file = typeof body.file === "string" ? body.file.trim() : "";
      const sha = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
      if (!Object.hasOwn(KINDS, body.kind) || !FILE.test(file) || !HEX64.test(sha)) throw new HttpError(400, "bad_request", "kind, file and sha256 of the entry to remove.");
      const r = q.remove.run(body.kind, file, sha);
      if (!r.changes) throw new HttpError(404, "not_found", "No such entry.");
      load();
      record(rc, "presence.preset.remove", null, "preset", body.kind + " " + file + " " + sha.slice(0, 12));
      rc.json(200, { ok: true, total: kept() });
    }));
  }

  return { verdict, rated, noteReport, publicText, adminView, registerAdmin, reload: load, size: kept };
}
