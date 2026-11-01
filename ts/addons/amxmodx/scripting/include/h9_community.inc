// h9_community.inc -- havoc9.org's presence and communities, for AMX Mod X plugins
//
// Two plugins answer these natives. Both go in plugins.ini, in this order, above any plugin that
// includes this file:
//   h9_presence.amxx    the h9p_ natives: this server's enrollment with havoc9.org (its key, its
//                       address, its public server id) and signing a call to h9web with the key
//   h9_community.amxx   the h9c_ natives: the server's community, the data each account keeps in
//                       that community, and finding an account
// docs\H9_COMMUNITIES.txt is the guide, and holds the trust model.
//
// A plugin that should still load without them sets a native filter (set_native_filter) that
// lets every h9p_ and h9c_ native go unbound, as tsm_api.inc describes for its own, and calls
// none of them unless LibraryExists("h9_community", LibType_Library). h9_community.sma defines
// H9C_CORE before including this file, and so only takes the constants and the h9p_ natives.
//
// LATENCY. Every h9c_ call is one HTTPS request to havoc9.org, answered through the callback you
// name: usually 50 to 300 ms later, never in the same frame, and up to 15 seconds later (the
// request's timeout) when havoc9.org is slow or away, with H9C_ERROR. Nothing here waits. Read
// what a player needs once they are in (see H9C_NOT_HERE), keep it in your plugin, and write it
// back when it changes, not on every event.
//
// WHO MAY READ AND WRITE. The data belongs to the community: a server reaches only its own
// community's, and one in no community gets H9C_DENIED. Each call is signed with the server's
// own key, and h9web takes the player's account from its h9_clientid and checks it against
// h9_presence's own report: the player has to be in game on this server, now. The community's
// owner can make a server read-only (writes get H9C_DENIED), ask for players whose game proves
// its H9 id, see every write with the server that made it, and put any account's values, or
// all of them, back as they were at any time in the last 30 days. Revoking a server's key on
// havoc9.org stops all of it at once.
//
// LIMITS (h9web's defaults, enforced by h9web):
//   key        1 to 32 characters of a-z 0-9 _ . -
//   value      text (UTF-8) of at most 512 bytes; keep numbers as text. "" is a value;
//              h9c_delete removes a key.
//   keys       64 per account in each community; 200000 values per community
//   calls      per server, 600 reads and 300 writes a minute; per account, 60 writes a minute;
//              and here, at most 24 calls in flight at once (a call over that is refused)
// Over a limit, the callback has H9C_LIMIT.
//
// CONFLICTS. Each value has a version: 0 while it is not there, then 1, 2, 3, one more with each
// write. h9c_set and h9c_delete with version -1 write over whatever is there: the last write
// wins. Given the version you read, they write only if nobody has written since; otherwise the
// callback has H9C_CONFLICT, with the value and the version there now, to merge and try again.

#if defined _h9_community_included
	#endinput
#endif
#define _h9_community_included

/* ---- what a callback's status says ------------------------------------------------------ */

#define H9C_OK          0   // done
#define H9C_NOT_FOUND   1   // h9c_get: the key is not there (value "", version 0); h9c_find: no such account
#define H9C_CONFLICT    2   // the version given is not the one there: value and version are what is there now
#define H9C_DENIED      3   // not allowed: no community, a read-only server, a banned account, or a
                            // community that wants a game that proves the player's H9 id
#define H9C_LIMIT       4   // over a limit: the value's size, the keys per account, the community's
                            // store, or the calls a minute
#define H9C_ERROR       5   // havoc9.org did not answer, or not as expected: try again later
#define H9C_NO_ACCOUNT  6   // the player's h9_clientid is no havoc9.org account's
#define H9C_NOT_HERE    7   // h9web has not seen the player here yet: h9_presence reports a player
                            // a few seconds after they join, so ask again 10 seconds later

/* ---- h9_presence.amxx ------------------------------------------------------------------- */

/** Whether this server has a live key: enrolled and approved, or a hand-made one. */
native h9p_ready();

/** This server's address as h9web knows it (ip:port). Returns false while it has none. */
native h9p_server(out[], len);

/** This server's public id on havoc9.org (10 characters). Returns false while it has none. */
native h9p_server_id(out[], len);

/** h9web's presence API: h9_presence_url without its /report (https://havoc9.org/api/presence). */
native h9p_api(out[], len);

/**
 * The live key's HMAC-SHA256 of body, as 64 lowercase hex characters, for a call's
 * X-H9-Signature header. The key itself never leaves h9_presence. Returns false without a live key.
 */
native h9p_sign(const body[], out[], len);

/** 16 random hex characters, for a signed call's nonce. */
native h9p_nonce(out[], len);

/** Asks h9_presence to report within a few seconds (h9web has something for this server's players). */
native h9p_report_soon();

/** Whether h9web says this player's account is muted on this server's community. */
native h9p_muted(id);

#if !defined H9C_CORE

/* ---- h9_community.amxx ------------------------------------------------------------------ */

/** Whether this server is in a community and h9_community has heard from h9web lately. */
native h9c_ready();

/** This server's public id on havoc9.org, as h9p_server_id. Returns false while it has none. */
native h9c_server_id(out[], len);

/** This server's community's short name (havoc9.org/community/?c=name); "" when in none. Returns whether in one. */
native h9c_community(out[], len);

/**
 * Reads one of a player's values in this server's community.
 *
 *     public my_get(id, status, const key[], const value[], version, data)
 *
 * id is 0 in the callback when the player left before the answer came (or the slot is someone
 * else's now). status H9C_OK: value and version; H9C_NOT_FOUND: "" and 0.
 *
 * @return  true when the call went out (the callback will run), false when it could not: this
 *          server has no live key, id is not a player here with an h9_clientid, the key is not
 *          a valid name, the callback is "" or too many calls are in flight.
 */
native h9c_get(id, const key[], const callback[], data = 0);

/**
 * Writes one of a player's values in this server's community.
 *
 *     public my_set(id, status, const key[], const value[], version, data)
 *
 * status H9C_OK: version is the new version, value is "". H9C_CONFLICT: value and version are
 * what is there now. callback "" for none.
 *
 * @param version   -1: write over whatever is there; the version you read: only if it is still
 *                  that one (0: only if the key is not there yet)
 * @return          as h9c_get, and false for a value over 1023 bytes
 */
native h9c_set(id, const key[], const value[], version = -1, const callback[] = "", data = 0);

/** Removes one of a player's values; as h9c_set (version is 0 after it). */
native h9c_delete(id, const key[], version = -1, const callback[] = "", data = 0);

/**
 * Where an account is: the exact username first, then up to four that start with name, this
 * community's players before the rest. Each account's own privacy switches apply. The callback
 * runs once for each account found, index 0 to count - 1, or once with count 0:
 *
 *     public my_find(status, index, count, const username[], const state[], const server[], const address[], same_community, data)
 *
 * state is "game" (in game; server and address are "" when the account hides where), "web"
 * (the H9 web client's menu), "site" (on havoc9.org) or "offline". same_community is true when
 * that server is in this server's community.
 *
 * @return  true when the call went out, false when it could not
 */
native h9c_find(const name[], const callback[], data = 0);

#endif
