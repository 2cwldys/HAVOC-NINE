// Signed calls from game servers, other than the report (which has its own replay rule): enrollment
// status, and the community calls (poll, chat, find, shared data, claim). Each is
//
//   POST, Content-Type: application/json
//   X-H9-Server: <ip:port>            the address the server enrolled with, or servers.json's
//   X-H9-Signature: <hex HMAC-SHA256(key as its 64 ASCII characters, raw body)>
//   { "v": 1, "server": "<ip:port>", "ts": <unix seconds>, "nonce": "<16 to 64 hex>", ... }
//
// ts must be within clockSkewSeconds of h9web's clock, and a nonce is taken once: it is kept in
// presence_nonces for 10 minutes (the database, so a restart forgets none). Calls may overlap, so
// unlike reports they need not carry a later ts than the last.

import crypto from "node:crypto";
import { addressKey } from "./keys.js";

const SIGNATURE = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{16,64}$/;

export function createServerAuth({ db, HttpError, settings, now }) {
  const q = {
    seen: db.prepare("INSERT OR IGNORE INTO presence_nonces (server, nonce, at) VALUES (?, ?, ?)"),
    prune: db.prepare("DELETE FROM presence_nonces WHERE at < ?"),
  };

  function readRaw(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        req.resume();
        return reject(new HttpError(415, "unsupported_media_type", "Send JSON (Content-Type: application/json)."));
      }
      const length = req.headers["content-length"];
      if (length !== undefined && Number(length) > maxBytes) {
        req.resume();
        return reject(new HttpError(413, "payload_too_large", "The request is too large."));
      }
      const chunks = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > maxBytes) {
          done = true;
          req.resume();
          return reject(new HttpError(413, "payload_too_large", "The request is too large."));
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks));
      });
      req.on("error", () => {
        if (!done) {
          done = true;
          reject(new HttpError(400, "bad_request", "The request could not be read."));
        }
      });
    });
  }

  // { server, body, kind }: kind is that of the candidate key that signed it. candidates(server)
  // gives [{ key, kind }]; none means the server has no key at all.
  async function verify(req, candidates, { maxBytes = settings.maxBodyBytes } = {}) {
    const raw = await readRaw(req, maxBytes);
    const server = addressKey(req.headers["x-h9-server"]);
    if (!server) throw new HttpError(400, "bad_server", "X-H9-Server must be the server's address (IPv4:port).");
    const keys = candidates(server);
    if (!keys.length) throw new HttpError(403, "no_key", "This server has no key: it enrolls first.");
    const signature = String(req.headers["x-h9-signature"] || "").trim().toLowerCase();
    const given = SIGNATURE.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
    let kind = null;
    for (const k of keys) {
      const expected = crypto.createHmac("sha256", k.key).update(raw).digest();
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        kind = k.kind;
        break;
      }
    }
    if (!kind) throw new HttpError(401, "bad_signature", "The signature does not match this server's key.");
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      throw new HttpError(400, "bad_request", "Not valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "Send a JSON object.");
    if (body.v !== 1) throw new HttpError(400, "bad_version", "This h9web reads version 1.");
    if (addressKey(body.server) !== server) throw new HttpError(400, "server_mismatch", "The body names another server than X-H9-Server.");
    const t = now();
    if (!Number.isSafeInteger(body.ts) || Math.abs(t - body.ts) > settings.clockSkewSeconds) {
      throw new HttpError(401, "stale", "The time is more than " + settings.clockSkewSeconds + " seconds from h9web's clock. Check the game server's clock.");
    }
    if (typeof body.nonce !== "string" || !NONCE.test(body.nonce)) throw new HttpError(400, "bad_request", "A nonce of 16 to 64 hex characters.");
    if (!Number(q.seen.run(server, body.nonce, t).changes)) throw new HttpError(409, "replay", "That call was made already.");
    return { server, body, kind };
  }

  function prune(t) {
    return Number(q.prune.run(t - 600).changes);
  }

  return { readRaw, verify, prune };
}
