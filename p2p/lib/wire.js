// The wire format of the P2P data plane: one UDP packet layout shared by the service (h9rv) and the helper (h9p2p).
//
//   off  size  field
//     0     1  magic   0xA9 (never 0xFF: a game packet pointed at this port is not mistaken for ours)
//     1     1  type    T.*
//     2     1  flags   F_HOST: the packet's ORIGIN role is the host side (see below); F_WANT_PEER: HELLO asks for PEER_INFO again
//     3     1  reserved, zero
//     4     4  flow    the flow id (a session's control flow for the host's own HELLO)
//     8     8  seq     per sender, per leg, per direction; never reused under one key (anti-replay window at the receiver)
//    16     n  payload
//  16+n     8  tag     first 8 bytes of HMAC-SHA256(key, bytes 0 .. 16+n-1)
//
// Which key signs a packet is decided by the leg it travels on, never by anything the packet says about itself:
//   host  <-> service   kH(flow) = HMAC-SHA256(hostKey, "h9p2p-h" + flow)      (the host's HELLO of its session: hostKey itself)
//   joiner <-> service  kJ(flow), random, given to the joiner when it redeems an invite
//   host  <-> joiner    pairKey(flow), random, given to both over the control plane (the direct path)
// F_HOST is part of the signed bytes and says which side originated the packet, so a packet cannot be reflected back at
// the side that made it. At the service F_HOST = 1 means the host leg, 0 the joiner leg.
//
// Nothing here answers a packet that does not verify: the callers drop it silently.

import crypto from "node:crypto";

export const MAGIC = 0xa9;
export const HEADER = 16;
export const TAG = 8;
export const MIN_PACKET = HEADER + TAG;
export const MAX_PAYLOAD = 1448; // 1500 - 20 (IPv4) - 8 (UDP) - HEADER - TAG - 0, rounded down; the game fragments at 1200

export const T = Object.freeze({ HELLO: 1, HELLO_ACK: 2, DATA: 3, PEER_INFO: 4, PUNCH: 5, PUNCH_ACK: 6, KEEPALIVE: 7, CLOSE: 8 });
export const F_HOST = 1;
export const F_WANT_PEER = 2;

// A HELLO is padded to this size so the answer is never larger than the question (no amplification).
export const MIN_HELLO = 96;

export function hmac(key, ...parts) {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
}

export function hostFlowKey(hostKey, flow) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(flow >>> 0, 0);
  return hmac(hostKey, "h9p2p-h", b);
}

export function encode({ type, flags = 0, flow, seq, payload = Buffer.alloc(0) }, key) {
  if (payload.length > MAX_PAYLOAD) throw new Error("wire: payload too large");
  const buf = Buffer.allocUnsafe(HEADER + payload.length + TAG);
  buf[0] = MAGIC;
  buf[1] = type;
  buf[2] = flags;
  buf[3] = 0;
  buf.writeUInt32BE(flow >>> 0, 4);
  buf.writeUInt32BE(Math.floor(seq / 4294967296) >>> 0, 8);
  buf.writeUInt32BE(seq >>> 0, 12);
  payload.copy(buf, HEADER);
  hmac(key, buf.subarray(0, HEADER + payload.length)).copy(buf, HEADER + payload.length, 0, TAG);
  return buf;
}

// The header of a packet, or null when it is not shaped like ours. The tag is NOT checked here.
export function decodeHeader(buf) {
  if (buf.length < MIN_PACKET || buf[0] !== MAGIC || buf[3] !== 0) return null;
  return {
    type: buf[1],
    flags: buf[2],
    host: (buf[2] & F_HOST) !== 0,
    wantPeer: (buf[2] & F_WANT_PEER) !== 0,
    flow: buf.readUInt32BE(4),
    seq: buf.readUInt32BE(8) * 4294967296 + buf.readUInt32BE(12),
    payloadLength: buf.length - MIN_PACKET,
  };
}

export function payloadOf(buf) {
  return buf.subarray(HEADER, buf.length - TAG);
}

export function verify(buf, key) {
  const want = hmac(key, buf.subarray(0, buf.length - TAG));
  return crypto.timingSafeEqual(want.subarray(0, TAG), buf.subarray(buf.length - TAG));
}

// A sliding window over the sequence numbers seen under one key in one direction. accept() answers whether
// the number is new, and records it; a number older than the window, or seen, is refused.
export class ReplayWindow {
  constructor(size = 1024) {
    this.size = size;
    this.top = -1;
    this.bits = new Uint8Array(size);
  }

  accept(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    if (this.top < 0) {
      this.top = seq;
      this.bits[seq % this.size] = 1;
      return true;
    }
    if (seq > this.top) {
      if (seq - this.top >= this.size) this.bits.fill(0);
      else for (let s = this.top + 1; s <= seq; s++) this.bits[s % this.size] = 0;
      this.top = seq;
      this.bits[seq % this.size] = 1;
      return true;
    }
    if (this.top - seq >= this.size) return false;
    const i = seq % this.size;
    if (this.bits[i]) return false;
    this.bits[i] = 1;
    return true;
  }
}

// ---- payload shapes -------------------------------------------------------------------------------------------

export function helloPayload(nonce) {
  const p = Buffer.alloc(MIN_HELLO - MIN_PACKET);
  nonce.copy(p, 0, 0, 8);
  return p;
}

export function ackPayload(ip, port, nonce) {
  const p = Buffer.alloc(14);
  ipToBytes(ip).copy(p, 0);
  p.writeUInt16BE(port, 4);
  nonce.copy(p, 6, 0, 8);
  return p;
}

export function parseAck(p) {
  if (p.length < 14) return null;
  return { ip: bytesToIp(p, 0), port: p.readUInt16BE(4), nonce: Buffer.from(p.subarray(6, 14)) };
}

export function peerPayload(ip, port) {
  const p = Buffer.alloc(6);
  ipToBytes(ip).copy(p, 0);
  p.writeUInt16BE(port, 4);
  return p;
}

export function parsePeer(p) {
  if (p.length < 6) return null;
  return { ip: bytesToIp(p, 0), port: p.readUInt16BE(4) };
}

export function ipToBytes(ip) {
  const b = Buffer.alloc(4);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) throw new Error("wire: not an IPv4 address: " + ip);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (n > 255) throw new Error("wire: not an IPv4 address: " + ip);
    b[i] = n;
  }
  return b;
}

export function bytesToIp(buf, off = 0) {
  return buf[off] + "." + buf[off + 1] + "." + buf[off + 2] + "." + buf[off + 3];
}

// An address a peer may be told to send punch packets to, or the service may latch: a public unicast IPv4 address.
// Private, loopback, link-local, multicast, reserved and the CGNAT shared range are refused unless allowPrivate is set
// (tests and LAN play).
export function publicUnicast(ip, allowPrivate = false) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (allowPrivate) return a !== 0 && a < 224;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}
