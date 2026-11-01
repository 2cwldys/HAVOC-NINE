// RFC 6455 details of lib/websocket.js, driven byte by byte from a raw TCP client.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { checkUpgrade, acceptUpgrade, refuseUpgrade, encodeFrame, acceptKey, WebSocketConnection } from "../lib/websocket.js";

const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);

// Reads the server's (unmasked) frames off a socket.
function reader(socket, initial = Buffer.alloc(0)) {
  let buf = initial;
  const frames = [];
  const waiters = [];
  let ended = false;
  const pump = () => {
    for (;;) {
      if (buf.length < 2) break;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) break;
      frames.push({ fin: !!(buf[0] & 0x80), opcode: buf[0] & 0x0f, masked: !!(buf[1] & 0x80), payload: buf.subarray(off, off + len) });
      buf = buf.subarray(off + len);
    }
    while (waiters.length && (frames.length || ended)) waiters.shift()();
  };
  socket.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
  socket.on("close", () => { ended = true; pump(); });
  pump();
  return {
    next: (ms = 2000) => new Promise((resolve, reject) => {
      const take = () => (frames.length ? resolve(frames.shift()) : reject(new Error("connection ended")));
      if (frames.length || ended) return take();
      const timer = setTimeout(() => reject(new Error("no frame within " + ms + " ms")), ms);
      waiters.push(() => { clearTimeout(timer); take(); });
    }),
    closed: new Promise((resolve) => socket.on("close", resolve)),
  };
}

describe("websocket server", () => {
  let server;
  let port;
  const events = [];
  const open = [];

  before(async () => {
    server = http.createServer();
    server.on("upgrade", (req, socket, head) => {
      // as lib/app.js does: a client that drops the connection (the tests' own, at the end) is no error
      socket.on("error", () => socket.destroy());
      const v = checkUpgrade(req);
      if (!v.ok) return refuseUpgrade(socket, v.status, v.headers);
      acceptUpgrade(socket, v.key);
      const ws = new WebSocketConnection(socket, head, { maxMessage: 1000 });
      ws.on("message", (m, binary) => {
        events.push({ type: "message", m, binary });
        ws.send(Buffer.concat([Buffer.from(binary ? "bin:" : "txt:"), m]));
      });
      ws.on("close", (code) => events.push({ type: "close", code }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    for (const s of open) s.destroy();
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  async function connect(extra = Buffer.alloc(0)) {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect(port, "127.0.0.1");
    open.push(socket);
    await new Promise((r) => socket.once("connect", r));
    socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n");
    if (extra.length) socket.write(extra);
    // the 101 answer, and whatever frames came in the same read, handed to the reader at once
    const { head, rest } = await new Promise((resolve) => {
      let text = Buffer.alloc(0);
      const on = (d) => {
        text = Buffer.concat([text, d]);
        const end = text.indexOf("\r\n\r\n");
        if (end >= 0) {
          socket.off("data", on);
          resolve({ head: text.subarray(0, end).toString(), rest: text.subarray(end + 4) });
        }
      };
      socket.on("data", on);
    });
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.ok(head.includes("Sec-WebSocket-Accept: " + acceptKey(key)));
    assert.ok(!/Sec-WebSocket-Extensions/i.test(head), "no extension is ever accepted");
    return { socket, r: reader(socket, rest) };
  }

  test("the accept key of RFC 6455 section 1.3", () => {
    assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("binary, text, and the 16-bit length form", async () => {
    const { socket, r } = await connect();
    socket.write(encodeFrame(2, Buffer.from([1, 2, 3]), { mask: MASK }));
    let f = await r.next();
    assert.equal(f.opcode, 2);
    assert.equal(f.masked, false, "server frames are not masked");
    assert.deepEqual([...f.payload], [...Buffer.from("bin:"), 1, 2, 3]);
    socket.write(encodeFrame(1, Buffer.from("hi"), { mask: MASK }));
    f = await r.next();
    assert.equal(f.payload.toString(), "txt:hi");
    const big = crypto.randomBytes(600);
    socket.write(encodeFrame(2, big, { mask: MASK }));
    f = await r.next();
    assert.deepEqual(f.payload.subarray(4), big);
    socket.destroy();
  });

  test("a message in fragments, with a ping between them; data sent with the upgrade", async () => {
    const early = encodeFrame(2, Buffer.from("early"), { mask: MASK });
    const { socket, r } = await connect(early);
    assert.equal((await r.next()).payload.toString(), "bin:early");
    socket.write(encodeFrame(2, Buffer.from("ab"), { fin: false, mask: MASK }));
    socket.write(encodeFrame(9, Buffer.from("png"), { mask: MASK }));
    socket.write(encodeFrame(0, Buffer.from("cd"), { fin: false, mask: MASK }));
    socket.write(encodeFrame(0, Buffer.from("ef"), { mask: MASK }));
    const pong = await r.next();
    assert.equal(pong.opcode, 10);
    assert.equal(pong.payload.toString(), "png");
    assert.equal((await r.next()).payload.toString(), "bin:abcdef");
    socket.destroy();
  });

  test("closing handshake: the server echoes the client's close", async () => {
    const { socket, r } = await connect();
    const body = Buffer.alloc(2);
    body.writeUInt16BE(1000);
    socket.write(encodeFrame(8, body, { mask: MASK }));
    const f = await r.next();
    assert.equal(f.opcode, 8);
    assert.equal(f.payload.readUInt16BE(0), 1000);
    await r.closed;
  });

  const failures = [
    ["an unmasked frame", () => encodeFrame(2, Buffer.from("x")), 1002],
    ["reserved bits", () => { const f = encodeFrame(2, Buffer.from("x"), { mask: MASK }); f[0] |= 0x40; return f; }, 1002],
    ["an unknown opcode", () => encodeFrame(3, Buffer.from("x"), { mask: MASK }), 1002],
    ["a control frame over 125 bytes", () => encodeFrame(9, Buffer.alloc(126), { mask: MASK }), 1002],
    ["a control frame in pieces", () => encodeFrame(9, Buffer.alloc(1), { fin: false, mask: MASK }), 1002],
    ["a continuation with no message", () => encodeFrame(0, Buffer.from("x"), { mask: MASK }), 1002],
    ["a message over the limit", () => encodeFrame(2, Buffer.alloc(1001), { mask: MASK }), 1009],
    ["a 64-bit length over the limit, refused from its header", () => {
      const f = Buffer.alloc(14);
      f[0] = 0x82; f[1] = 0xff; f.writeUInt32BE(1, 2); f.writeUInt32BE(0, 6);
      return f;
    }, 1009],
    ["fragments adding up over the limit", () => Buffer.concat([
      encodeFrame(2, Buffer.alloc(600), { fin: false, mask: MASK }),
      encodeFrame(0, Buffer.alloc(600), { mask: MASK }),
    ]), 1009],
  ];
  for (const [what, make, code] of failures) {
    test("refused: " + what + " (close " + code + ")", async () => {
      const { socket, r } = await connect();
      socket.write(make());
      const f = await r.next();
      assert.equal(f.opcode, 8);
      assert.equal(f.payload.readUInt16BE(0), code);
      await r.closed;
    });
  }

  test("upgrade requests that are not version 13 or not well formed", async () => {
    const send = (headers) => new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/ws", headers: { connection: "Upgrade", upgrade: "websocket", ...headers } });
      req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      req.on("upgrade", (res, s) => { s.destroy(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(await send({ "sec-websocket-version": "12", "sec-websocket-key": crypto.randomBytes(16).toString("base64") }), 426);
    assert.equal(await send({ "sec-websocket-version": "13", "sec-websocket-key": "short" }), 400);
    assert.equal(await send({ "sec-websocket-version": "13" }), 400);
  });
});
