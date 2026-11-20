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

// The same id in seven base36 characters, which is what the engine sends once it carries
// ID_Base36_7 (xash3d-h9-patches/pending/engine-h9-clientid7). h9_clientid is a userinfo value,
// and userinfo is one 256-byte string shared by every key the client sets, so the full 32 hex
// spent an eighth of it on a single key.
//
// Seven HEX would have been the obvious shortening and is not safe: 16^7 is 268 million, and
// clientIdIndex() below looks an id up against EVERY account rather than the players on the
// server, so the birthday bound bites at about nineteen thousand accounts and a clash means one
// account silently resolving to another. 36^7 is 78 billion, which is 292 times the room in the
// same seven characters. Base62 would be larger still and is wrong here, because ids are
// compared after toLowerCase() (modules/presence/community.js), which would fold the alphabet
// back down and break matching at the same time.
//
// Both sides take the first 8 bytes of the digest big-endian, reduce modulo 36^7, and emit seven
// digits most significant first. The engine must agree byte for byte; a mismatch rejects every
// client and looks exactly like a bad id.
const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const B36_7 = 78364164096n; // 36^7

export function serverClientId7(playerId, ipBytes) {
  const digest = crypto.createHash("md5").update(Buffer.from(playerId, "ascii")).update(Buffer.from(ipBytes)).digest();
  let v = digest.readBigUInt64BE(0) % B36_7;
  let out = "";
  for (let i = 0; i < 7; i++) {
    out = B36[Number(v % 36n)] + out;
    v /= 36n;
  }
  return out;
}
