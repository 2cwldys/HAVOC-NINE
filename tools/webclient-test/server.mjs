// A small static server for trying the web client without the site's database or an account: the page's own files,
// the stage (engine, game, manifest, preload) and a few stubbed API routes the page reads. Used by smoke.mjs and perf.mjs.
//
//   const s = await startServer({ site, stage, port })   -> { url, close() }
//
// site   havoc9.org's folder (served at /; /webclient/ is its webclient folder)
// stage  make_webclient_game.py's output: engine/, game/, manifest.json, preload.json
// api    optional overrides for the stubbed routes: { auth: "H9SRV 1\n...", servers: {...} }
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".gif": "image/gif", ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".webp": "image/webp", ".woff2": "font/woff2",
};

// the servers the stubbed chain list names: one authenticated, one that runs something of its own
export const STUB_AUTH = "H9SRV 1\n127.0.0.1:27015 ok\n127.0.0.1:27016 mod\n";

// a solid 64 x 64 PNG, made here so the test needs no file
export function stubPicture(rgb = [140, 60, 200]) {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function startServer({ site, stage, port = 0, api = {} }) {
  const hits = [];
  const picture = stubPicture();
  const safe = (root, rel) => {
    const parts = decodeURIComponent(rel).split("/").filter((p) => p && p !== "." && p !== ".." && !p.includes(":") && !p.includes("\\"));
    return path.join(root, ...parts);
  };
  const resolve = (p) => {
    if (p.startsWith("/webclient/engine/") || p.startsWith("/webclient/game/") || p === "/webclient/manifest.json" || p === "/webclient/preload.json") {
      return safe(stage, p.slice("/webclient/".length));
    }
    return safe(site, p);
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    hits.push(req.method + " " + p);
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (p === "/api/presence/servers/auth") return send(200, api.auth || STUB_AUTH);
    if (p === "/api/servers") return send(200, JSON.stringify(api.servers || { servers: [{ name: "stub", address: "127.0.0.1:27015" }] }), "application/json");
    if (/^\/api\/presence\/avatar\/\d+\/\d+\.png$/.test(p)) {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": picture.length, "Cache-Control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : picture);
    }
    if (p.startsWith("/api/")) return send(404, "no such stub");
    let file = resolve(p === "/" ? "/index.html" : p);
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      const st = fs.statSync(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-cache" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch (e) {
      send(404, "not found");
    }
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + server.address().port;
      resolveStart({ url, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}
