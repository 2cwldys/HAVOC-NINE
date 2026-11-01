// Player ids.
//
// Every account has a random uid (16 bytes, hex), made at sign-up and never changed. Its player
// id is
//     HMAC-SHA256(secrets.playerIdKey, "h9web player id v1" NUL uid), first 32 hex characters
// so it is stable for the account's whole life, cannot be worked out from the uid or the
// database without the key, and has the shape of H9XASH's own ids (32 lowercase hex, as in
// user_id.ini). The web client sets cl_h9_userid to it.
//
// What a game server sees is what the engine sends (engine-h9-userid.patch,
// ID_GetMD5ForAddressEx): h9_clientid = MD5(cl_h9_userid as text + the server's 4 IPv4 bytes),
// lowercase hex. serverClientId() computes the same value, for the account page.

import crypto from "node:crypto";

export function newUid() {
  return crypto.randomBytes(16).toString("hex");
}

export function derivePlayerId(key, uid) {
  if (!/^[0-9a-f]{32}$/.test(String(uid))) throw new Error("playerid: bad uid");
  return crypto.createHmac("sha256", key).update("h9web player id v1\u0000").update(uid, "ascii").digest("hex").slice(0, 32);
}

export function serverClientId(playerId, ipBytes) {
  return crypto.createHash("md5").update(Buffer.from(playerId, "ascii")).update(Buffer.from(ipBytes)).digest("hex");
}
