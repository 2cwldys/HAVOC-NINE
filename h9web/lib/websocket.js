// WebSocket, server side (RFC 6455), as much as the relay needs: binary messages, the
// opening and closing handshakes, ping and pong, fragmented messages, and the limits.
//
// Not offered: extensions (permessage-deflate is never accepted, so frames never carry RSV
// bits) and subprotocols. Text messages are parsed but the relay refuses them (close 1003).
// Every frame from the client must be masked; one that is not, a reserved bit, an unknown
// opcode, a control frame over 125 bytes or in pieces, or a message over maxMessage ends the
// connection with the matching close code (1002, 1009). Writes past maxPendingBytes waiting
// on a slow client are dropped (send() returns false): the relay's datagrams are UDP anyway.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { statusText } from "./http.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EMPTY = Buffer.alloc(0);
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function tokens(header) {
  return String(header || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
}

// { ok: true, key } for a valid version 13 upgrade request, or { ok: false, status, headers }.
export function checkUpgrade(req) {
  if (req.method !== "GET") return { ok: false, status: 400 };
  if (!tokens(req.headers.upgrade).includes("websocket")) return { ok: false, status: 400 };
  if (!tokens(req.headers.connection).includes("upgrade")) return { ok: false, status: 400 };
  if (String(req.headers["sec-websocket-version"] || "").trim() !== "13") {
    return { ok: false, status: 426, headers: { "Sec-WebSocket-Version": "13" } };
  }
  const key = String(req.headers["sec-websocket-key"] || "").trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16) return { ok: false, status: 400 };
  return { ok: true, key };
}

// Answers an upgrade request with a plain HTTP status and closes the connection.
export function refuseUpgrade(socket, status, headers = {}) {
  if (socket.destroyed) return;
  let head = "HTTP/1.1 " + status + " " + statusText(status) + "\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n";
  for (const [k, v] of Object.entries(headers)) head += k + ": " + String(v).replace(/[\r\n]/g, "") + "\r\n";
  socket.end(head + "\r\n");
  setTimeout(() => socket.destroy(), 2000).unref();
}

export function acceptUpgrade(socket, key) {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
}

// One frame. mask (4 bytes) is for a client; the server sends unmasked frames.
export function encodeFrame(opcode, payload = EMPTY, { fin = true, mask = null } = {}) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, Buffer.from(mask), body]);
}

function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

// Events: "message" (Buffer, isBinary), "pong", "close" (code, reason). code is 1006 when the
// connection ended without a closing handshake.
export class WebSocketConnection extends EventEmitter {
  constructor(socket, head, { maxMessage = 65536, maxPendingBytes = 1048576 } = {}) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.maxPendingBytes = maxPendingBytes;
    this.state = OPEN;
    this.failed = false;
    this.buf = EMPTY;
    this.fragments = [];
    this.fragLen = 0;
    this.fragOpcode = -1;
    this.closeCode = 1006;
    this.closeReason = "";
    this.sentClose = false;
    this.gotClose = false;
    this.closeTimer = null;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on("data", (d) => this.onData(d));
    socket.on("end", () => { if (!socket.destroyed) socket.end(); });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.onSocketClose());
    // bytes that came with the upgrade request: read after the caller has its listeners on
    if (head && head.length) process.nextTick(() => this.onData(Buffer.from(head)));
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  onData(chunk) {
    if (this.failed || this.state === CLOSED) return;
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.failed && this.state !== CLOSED && this.readFrame()) { /* one frame per pass */ }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    if (b[0] & 0x70) return this.fail(1002, "reserved bits set");
    if (!(b[1] & 0x80)) return this.fail(1002, "frame not masked");
    const control = (opcode & 0x08) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (control) {
      if (opcode !== 8 && opcode !== 9 && opcode !== 10) return this.fail(1002, "unknown opcode");
      if (!fin) return this.fail(1002, "control frame in pieces");
      if (len > 125) return this.fail(1002, "control frame too long");
    } else if (opcode > 2) {
      return this.fail(1002, "unknown opcode");
    }
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) return this.fail(1009, "message too big");
      len = b.readUInt32BE(6);
      offset = 10;
    }
    if (!control && this.fragLen + len > this.maxMessage) return this.fail(1009, "message too big");
    const end = offset + 4 + len;
    if (b.length < end) return false;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[offset + 4 + i] ^ b[offset + (i & 3)];
    this.buf = b.length === end ? EMPTY : b.subarray(end);
    if (control) this.onControl(opcode, payload);
    else this.onDataFrame(opcode, fin, payload);
    return true;
  }

  onDataFrame(opcode, fin, payload) {
    if (opcode === 0) {
      if (this.fragOpcode < 0) return this.fail(1002, "continuation with no message");
      this.fragments.push(payload);
      this.fragLen += payload.length;
      if (!fin) return true;
      const op = this.fragOpcode;
      const message = Buffer.concat(this.fragments, this.fragLen);
      this.fragments = [];
      this.fragLen = 0;
      this.fragOpcode = -1;
      return this.deliver(op, message);
    }
    if (this.fragOpcode >= 0) return this.fail(1002, "new message inside one in pieces");
    if (!fin) {
      this.fragOpcode = opcode;
      this.fragments = [payload];
      this.fragLen = payload.length;
      return true;
    }
    return this.deliver(opcode, payload);
  }

  deliver(opcode, message) {
    if (this.state === OPEN) this.emit("message", message, opcode === 2);
    return true;
  }

  onControl(opcode, payload) {
    if (opcode === 9) {
      if (this.state === OPEN) this.write(encodeFrame(10, payload));
      return;
    }
    if (opcode === 10) {
      this.emit("pong", payload);
      return;
    }
    let code = 1005;
    let reason = "";
    if (payload.length === 1) return this.fail(1002, "close frame of one byte");
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this.fail(1002, "bad close code");
      try {
        reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
      } catch (e) {
        return this.fail(1007, "close reason not UTF-8");
      }
    }
    this.gotClose = true;
    if (!this.sentClose) {
      this.closeCode = code;
      this.closeReason = reason;
      this.sendClose(code === 1005 ? 1000 : code, "");
    }
    this.state = CLOSING;
    this.socket.end();
  }

  write(frame) {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(frame);
  }

  sendClose(code, reason) {
    if (this.sentClose) return;
    this.sentClose = true;
    const text = Buffer.from(String(reason || "").replace(/[^\x20-\x7e]/g, "").slice(0, 120), "ascii");
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.write(encodeFrame(8, payload));
  }

  fail(code, why) {
    this.failed = true;
    this.buf = EMPTY;
    if (this.state === OPEN) {
      this.state = CLOSING;
      this.closeCode = code;
      this.closeReason = why;
      this.sendClose(code, "");
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    return false;
  }

  // Sends one binary message; false when it was not sent (closing, or the client is too far
  // behind).
  send(data) {
    if (this.state !== OPEN) return false;
    if (this.socket.writableLength > this.maxPendingBytes) return false;
    this.write(encodeFrame(2, data));
    return true;
  }

  ping() {
    if (this.state === OPEN) this.write(encodeFrame(9, EMPTY));
  }

  close(code = 1000, reason = "") {
    if (this.state !== OPEN) return;
    this.state = CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
    this.sendClose(code, reason);
    this.closeTimer = setTimeout(() => this.socket.destroy(), 3000);
    this.closeTimer.unref();
  }

  terminate() {
    this.socket.destroy();
  }

  onSocketClose() {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.emit("close", this.sentClose || this.gotClose ? this.closeCode : 1006, this.closeReason);
  }
}
