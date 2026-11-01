// What each account's h9_clientid is on a game server, for modules that read what game servers
// send (modules/presence). Only core has the player ids, so only core builds the lookup; a module
// sees the ids a server sends, never a player id.
//
//   clientIdIndex(address) -> { get(h9_clientid) -> account id, has(h9_clientid), size }
//     for the server at address ("a.b.c.d:port").
//
// The engine salts with the 4 IPv4 bytes the client connects to (not the port), so the lookup is
// kept per IP: two servers on one address share it. Player ids are worked out once, the lookups
// on first use per IP (at most 64 kept). account-created and account-deleted keep both up to
// date in this process, account-player-id (a reset or moved id) rebuilds them; an account made or
// deleted by another process (the admin script) is noticed by the accounts' count and highest id,
// looked at once a minute, which rebuilds them too.

import { derivePlayerId, serverClientId } from "./playerid.js";
import { parseAddress } from "./servers.js";

export function createClientIds({ db, secrets, events, recheckMs = 60000, now = Date.now }) {
  const all = db.prepare("SELECT id, uid FROM accounts");
  const one = db.prepare("SELECT id, uid FROM accounts WHERE id = ?");
  const stamp = db.prepare("SELECT count(*) AS n, COALESCE(max(id), 0) AS m FROM accounts");
  const stampText = () => {
    const s = stamp.get();
    return s.n + ":" + s.m;
  };
  let pids = null; // account id -> player id
  const byIp = new Map(); // "a.b.c.d" -> { bytes, map: Map(h9_clientid -> account id) }
  let known = null;
  let restamp = false;
  let checkedAt = 0;

  function build() {
    pids = new Map();
    for (const r of all.iterate()) pids.set(r.id, derivePlayerId(secrets.playerIdKey, r.uid));
    byIp.clear();
    known = stampText();
    restamp = false;
    checkedAt = now();
  }

  function fresh() {
    if (!pids) return build();
    if (restamp) {
      known = stampText();
      restamp = false;
      checkedAt = now();
      return;
    }
    if (now() - checkedAt < recheckMs) return;
    checkedAt = now();
    if (stampText() !== known) build();
  }

  function clientIdIndex(address) {
    const a = parseAddress(address);
    if (!a) throw new Error("clientIdIndex: " + address + " is not IPv4:port");
    fresh();
    let entry = byIp.get(a.ip);
    if (!entry) {
      const map = new Map();
      for (const [id, pid] of pids) map.set(serverClientId(pid, a.bytes), id);
      if (byIp.size >= 64) byIp.delete(byIp.keys().next().value);
      entry = { bytes: a.bytes, map };
      byIp.set(a.ip, entry);
    }
    const map = entry.map;
    return Object.freeze({ get: (clientId) => map.get(clientId), has: (clientId) => map.has(clientId), size: map.size });
  }

  if (events) {
    events.on("account-created", ({ id }) => {
      if (!pids) return;
      const r = one.get(id);
      if (!r) return;
      const pid = derivePlayerId(secrets.playerIdKey, r.uid);
      pids.set(id, pid);
      for (const e of byIp.values()) e.map.set(serverClientId(pid, e.bytes), id);
      restamp = true;
    });
    // sent before the row goes: the stamp is taken again on the next look
    events.on("account-deleted", ({ id }) => {
      if (!pids) return;
      const pid = pids.get(id);
      pids.delete(id);
      if (pid) for (const e of byIp.values()) e.map.delete(serverClientId(pid, e.bytes));
      restamp = true;
    });
    events.on("account-player-id", () => {
      pids = null;
    });
  }

  return { clientIdIndex };
}
