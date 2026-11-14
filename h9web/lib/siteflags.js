// Which parts of the site are open: the download area and the web client.
//
// config.site gives the starting values ({ downloads: true, webclient: true }). An admin changes them without a restart, from the admin
// panel (SITE) or POST /api/admin/site, and the change is kept in <dataDir>/site-flags.json, which wins over config.site until a part is
// put back by an admin. A closed part is greyed out by the pages (GET /api/site) and refused by the server: nginx asks
// GET /api/site/gate/<part> for every request to /downloads/files/ and /webclient/ (havoc9.org/deploy/nginx-setup.sh), and the relay of the
// web client's game traffic is closed with the web client.

import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./http.js";

export const SITE_PARTS = ["downloads", "webclient"];
const NOTE_MAX = 200;

export function createSiteFlags({ config, log }) {
  const file = path.join(config.dataDir, "site-flags.json");
  const start = {};
  for (const part of SITE_PARTS) start[part] = config.site?.[part] !== false;
  let stamp = null;
  let saved = {};

  function load() {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch (e) {
      st = null;
    }
    const now = st ? st.mtimeMs + ":" + st.size : null;
    if (now === stamp) return;
    stamp = now;
    saved = {};
    if (!st) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const part of SITE_PARTS) {
        const v = raw?.[part];
        if (v && typeof v === "object") saved[part] = { enabled: v.enabled !== false, note: typeof v.note === "string" ? v.note.slice(0, NOTE_MAX) : "" };
      }
    } catch (e) {
      log?.warn("siteflags.unreadable", { file, error: e.message });
      saved = {};
    }
  }

  function snapshot() {
    load();
    const out = {};
    for (const part of SITE_PARTS) out[part] = { enabled: saved[part] ? saved[part].enabled : start[part], note: saved[part]?.note || "" };
    return out;
  }

  function isOpen(part) {
    return snapshot()[part]?.enabled !== false;
  }

  /** Set one part's state (and the note the page shows while it is closed). Returns the snapshot. */
  function set(part, enabled, note) {
    if (!SITE_PARTS.includes(part)) throw new HttpError(400, "bad_request", "The parts are " + SITE_PARTS.join(" and ") + ".");
    if (typeof enabled !== "boolean") throw new HttpError(400, "bad_request", "enabled must be true or false.");
    if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX)) throw new HttpError(400, "bad_request", "The note is at most " + NOTE_MAX + " characters.");
    load();
    const next = { ...saved, [part]: { enabled, note: note === undefined ? saved[part]?.note || "" : note.trim() } };
    const all = {};
    for (const p of SITE_PARTS) all[p] = next[p] || { enabled: start[p], note: "" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    fs.renameSync(tmp, file);
    stamp = null;
    return snapshot();
  }

  return { snapshot, isOpen, set, file };
}

export function registerSiteRoutes(router, { flags, auth, audit }) {
  // what the pages read to grey a part out
  router.get("/api/site", async (req, res, rc) => {
    rc.json(200, flags.snapshot(), { "Cache-Control": "public, max-age=10" });
  });

  // what nginx asks (auth_request) before it serves a request to a gated part: 204 open, 403 closed (auth_request denies on 401 and 403 only); never cached
  router.get("/api/site/gate/:part", async (req, res, rc) => {
    const part = rc.params.part;
    if (!SITE_PARTS.includes(part)) throw new HttpError(404, "not_found", "No such part.");
    const open = flags.isOpen(part);
    rc.send(open ? 204 : 403, "", "text/plain; charset=utf-8", { "Cache-Control": "no-store" });
  });

  // an admin closes or opens a part
  router.post("/api/admin/site", auth.requireRole("admin", async (req, res, rc) => {
    const body = await rc.body({ maxBytes: 1024 });
    const snap = flags.set(String(body?.part || ""), body?.enabled, body?.note);
    audit.record({ actor: rc.account, action: "site." + body.part, target: null, detail: JSON.stringify({ enabled: snap[body.part].enabled, note: snap[body.part].note }) });
    rc.json(200, { ok: true, site: snap });
  }));
}
