// Encryption at rest for the few stored values that must be read back but that a copy of the
// database alone should not give away (README.txt section 7, "The data key"). What uses it: a
// Discord link's Discord user id and display name (modules/discord).
//
//   seal(text, purpose)    "h9e1.<key id>.<nonce>.<ciphertext and tag>", the parts in base64url
//   open(sealed, purpose)  the text; throws a DataKeyError when the value was sealed with another
//                          key ("other_key"), for another purpose or was changed ("damaged"), or
//                          is not a sealed value at all ("not_sealed")
//   index(text, purpose)   a keyed hash (HMAC-SHA256, 64 hex), so a value can be looked up and
//                          kept unique without being stored in the clear
//   keyIdOf(sealed)        the key id a sealed value names, or null
//   keyId                  8 hex characters naming this key (not secret: a hash of the key)
// AES-256-GCM with a random 12-byte nonce for every value, and purpose as the additional data,
// so a value copied into another column does not open there. The encryption key and the index
// key are derived from the file's key with HKDF-SHA256, each for its own use.
//
// The key file: <dataDir>/data.key unless config.dataKeyFile names another place. 32 random
// bytes in base64, made on the first start with mode 0600 ("wx": never over a file another
// process made) and never written again. It sits apart from the database and from its backups/
// folder, so a copy of the database or of a backup opens nothing. Losing it loses only what was
// sealed with it (the Discord links: players link again). A damaged file stops the start, as a
// damaged secrets.json does: a new key would leave every sealed value unreadable.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PREFIX = "h9e1";
const PURPOSE = /^[a-z][a-z0-9._-]{0,63}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEY_TEXT = /^[A-Za-z0-9+/]{43}=$/;

export class DataKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function additionalData(purpose) {
  if (typeof purpose !== "string" || !PURPOSE.test(purpose)) throw new Error("datakey: bad purpose " + purpose);
  return Buffer.from(PREFIX + "|" + purpose, "utf8");
}

export function createDataBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("datakey: a 32-byte key is needed");
  const derive = (info) => Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), info, 32));
  const encKey = derive("h9web data key v1: encryption");
  const idxKey = derive("h9web data key v1: index");
  const keyId = crypto.createHash("sha256").update("h9web data key id v1\u0000").update(key).digest("hex").slice(0, 8);

  function seal(text, purpose) {
    const ad = additionalData(purpose);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", encKey, iv);
    c.setAAD(ad);
    const body = Buffer.concat([c.update(String(text), "utf8"), c.final(), c.getAuthTag()]);
    return PREFIX + "." + keyId + "." + iv.toString("base64url") + "." + body.toString("base64url");
  }

  function parts(sealed) {
    const p = typeof sealed === "string" ? sealed.split(".") : [];
    if (p.length !== 4 || p[0] !== PREFIX || !/^[0-9a-f]{8}$/.test(p[1]) || !B64URL.test(p[2]) || !B64URL.test(p[3])) return null;
    return p;
  }

  function open(sealed, purpose) {
    const ad = additionalData(purpose);
    const p = parts(sealed);
    if (!p) throw new DataKeyError("not_sealed", "not a sealed value");
    if (p[1] !== keyId) throw new DataKeyError("other_key", "sealed with another data key (" + p[1] + "; this one is " + keyId + ")");
    const iv = Buffer.from(p[2], "base64url");
    const body = Buffer.from(p[3], "base64url");
    if (iv.length !== 12 || body.length < 16) throw new DataKeyError("damaged", "a damaged sealed value");
    const d = crypto.createDecipheriv("aes-256-gcm", encKey, iv);
    d.setAAD(ad);
    d.setAuthTag(body.subarray(body.length - 16));
    try {
      return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
    } catch (e) {
      throw new DataKeyError("damaged", "a sealed value that does not open: changed, or sealed for another purpose");
    }
  }

  function index(text, purpose) {
    return crypto.createHmac("sha256", idxKey).update(additionalData(purpose)).update("\u0000").update(String(text), "utf8").digest("hex");
  }

  function keyIdOf(sealed) {
    const p = parts(sealed);
    return p ? p[1] : null;
  }

  return Object.freeze({ keyId, seal, open, index, keyIdOf });
}

function readKey(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  const key = Buffer.from(text, "base64");
  if (!KEY_TEXT.test(text) || key.length !== 32) {
    throw new Error("datakey: " + file + " is not a data key (32 bytes in base64). Restore it from the backup; a new key would leave every value sealed with the old one unreadable.");
  }
  return key;
}

// The key in file, made first when create is set and there is none. The service calls this
// with create = true; nothing else makes the file.
export function loadDataKey(file, { create = false, log } = {}) {
  if (fs.existsSync(file)) {
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077 && log) log.warn("datakey.mode", { file, mode: mode.toString(8), fix: "chmod 600" });
    }
    return readKey(file);
  }
  if (!create) throw new Error("datakey: " + file + " does not exist. Start the service once first; it makes the file.");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return readKey(file);
    throw e;
  }
  try {
    fs.writeSync(fd, crypto.randomBytes(32).toString("base64") + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (log) log.warn("datakey.created", { file, todo: "back this file up offline now, apart from the database's backups" });
  return readKey(file);
}
