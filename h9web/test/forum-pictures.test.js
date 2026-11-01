import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { startApp, request, signup, until, ORIGIN } from "./helpers.js";
import { DEFAULTS } from "../modules/forum/index.js";
import { inspectPicture } from "../modules/forum/images.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "modules");
const ROOMY = { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 };
const LIMITS = { maxSide: 512, maxFrames: 300 };
const has = (buf, text) => buf.includes(typeof text === "string" ? Buffer.from(text, "latin1") : text);

// ---- tiny pictures, built byte by byte --------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}
function png(w, h, { before = [], extra = [], after = Buffer.alloc(0), noise = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x40);
  // noise does not compress, for a picture of a known size
  let seed = 12345;
  if (noise) for (let i = 0; i < raw.length; i++) raw[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), ...before, pngChunk("IDAT", zlib.deflateSync(raw)), ...extra, pngChunk("IEND", Buffer.alloc(0)), after]);
}

function jpegSegment(marker, data) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}
// EXIF with a GPS block: IFD0 points (tag 0x8825) at a GPS IFD holding GPSLatitudeRef "N" and
// GPSLatitude 51 30 26.64
function gpsExif() {
  const t = Buffer.alloc(80);
  t.write("II", 0, "latin1");
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8);
  t.writeUInt16LE(0x8825, 10);
  t.writeUInt16LE(4, 12);
  t.writeUInt32LE(1, 14);
  t.writeUInt32LE(26, 18);
  t.writeUInt32LE(0, 22);
  t.writeUInt16LE(2, 26);
  t.writeUInt16LE(1, 28);
  t.writeUInt16LE(2, 30);
  t.writeUInt32LE(2, 32);
  t.write("N\0", 36, "latin1");
  t.writeUInt16LE(2, 40);
  t.writeUInt16LE(5, 42);
  t.writeUInt32LE(3, 44);
  t.writeUInt32LE(56, 48);
  t.writeUInt32LE(0, 52);
  [[51, 1], [30, 1], [2664, 100]].forEach(([n, d], i) => {
    t.writeUInt32LE(n, 56 + i * 8);
    t.writeUInt32LE(d, 60 + i * 8);
  });
  return jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]));
}
function jpeg(w, h, { segments = [], after = Buffer.alloc(0) } = {}) {
  const sof = Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const sos = Buffer.from([1, 1, 0, 0, 63, 0]);
  const coded = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), ...segments,
    jpegSegment(0xdb, Buffer.alloc(65, 1)), jpegSegment(0xc0, sof), jpegSegment(0xc4, Buffer.alloc(20, 2)), jpegSegment(0xda, sos), coded,
    Buffer.from([0xff, 0xd9]), after,
  ]);
}

const gce = () => Buffer.from([0x21, 0xf9, 4, 0x04, 10, 0, 0, 0]);
function subBlocks(text) {
  return Buffer.concat([Buffer.from([text.length]), Buffer.from(text, "latin1"), Buffer.from([0])]);
}
function gif(w, h, frames, { frame = [w, h], at = [0, 0], comment, xmp, plainText, loop = true, after } = {}) {
  const parts = [Buffer.from("GIF89a", "latin1")];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80;
  parts.push(lsd, Buffer.from([0, 0, 0, 255, 255, 255]));
  if (loop) parts.push(Buffer.from([0x21, 0xff]), subBlocks("NETSCAPE2.0").subarray(0, 12), Buffer.from([3, 1, 0, 0, 0]));
  if (comment) parts.push(Buffer.from([0x21, 0xfe]), subBlocks(comment));
  if (xmp) parts.push(Buffer.from([0x21, 0xff]), subBlocks("XMP DataXMP").subarray(0, 12), subBlocks(xmp));
  if (plainText) parts.push(gce(), Buffer.from([0x21, 0x01, 12, ...new Array(12).fill(0)]), subBlocks(plainText));
  for (let i = 0; i < frames; i++) {
    const d = Buffer.alloc(10);
    d[0] = 0x2c;
    d.writeUInt16LE(at[0], 1);
    d.writeUInt16LE(at[1], 3);
    d.writeUInt16LE(frame[0], 5);
    d.writeUInt16LE(frame[1], 7);
    parts.push(gce(), d, Buffer.from([2, 2, 0x4c, 0x01, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  if (after) parts.push(after);
  return Buffer.concat(parts);
}

function riff(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function vp8l(w, h) {
  const b = Buffer.alloc(10);
  b[0] = 0x2f;
  b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  return riff("VP8L", b);
}
function vp8x(flags, w, h) {
  const b = Buffer.alloc(10);
  b[0] = flags;
  b.writeUIntLE(w - 1, 4, 3);
  b.writeUIntLE(h - 1, 7, 3);
  return riff("VP8X", b);
}
function anmf(w, h) {
  const b = Buffer.alloc(16);
  b.writeUIntLE(w - 1, 6, 3);
  b.writeUIntLE(h - 1, 9, 3);
  b.writeUIntLE(100, 12, 3);
  return riff("ANMF", Buffer.concat([b, vp8l(w, h)]));
}
function webp(chunks, after = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, after]);
}

// ---- the checker ------------------------------------------------------------------------------

test("pictures: PNG keeps IHDR, PLTE, IDAT, IEND and tRNS only, and nothing after IEND", () => {
  const input = png(40, 30, {
    before: [pngChunk("tEXt", Buffer.from("Comment\0<script>alert(1)</script>", "latin1")), pngChunk("eXIf", Buffer.from("MM\0*GPS", "latin1")),
      pngChunk("tRNS", Buffer.from([0, 0, 0, 0, 0, 0]))],
    extra: [pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>", "latin1")), pngChunk("tIME", Buffer.alloc(7))],
    after: Buffer.from("PK\x03\x04 zip polyglot <html>", "latin1"),
  });
  const r = inspectPicture(input, LIMITS);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([r.type, r.width, r.height, r.frames], ["image/png", 40, 30, 1]);
  for (const gone of ["tEXt", "eXIf", "iTXt", "tIME", "<script>", "xmpmeta", "PK\x03\x04", "<html>"]) assert.ok(!has(r.data, gone), gone);
  assert.ok(has(r.data, "tRNS"), "tRNS stays");
  assert.ok(r.data.subarray(-12).equals(pngChunk("IEND", Buffer.alloc(0))), "ends at IEND");
  assert.equal(inspectPicture(r.data, LIMITS).data.equals(r.data), true, "the result checks out as it is");
  const badCrc = Buffer.from(png(4, 4));
  badCrc[33 - 4] ^= 0xff;
  assert.equal(inspectPicture(badCrc, LIMITS).ok, false, "a damaged chunk");
  assert.equal(inspectPicture(png(4, 4, { before: [pngChunk("ABCD", Buffer.alloc(3))] }), LIMITS).ok, false, "an unknown critical chunk");
  assert.match(inspectPicture(png(600, 10), LIMITS).message, /at most 512 x 512/);
  assert.equal(inspectPicture(png(4, 4).subarray(0, 50), LIMITS).ok, false, "cut short");
});

test("pictures: JPEG loses its EXIF (with the GPS block), XMP, comments and anything after EOI", () => {
  const xmp = jpegSegment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>camera</x:xmpmeta>", "latin1"));
  const com = jpegSegment(0xfe, Buffer.from("<html><script>alert(1)</script></html>", "latin1"));
  const adobe = jpegSegment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"));
  const input = jpeg(64, 48, { segments: [gpsExif(), xmp, com, adobe], after: Buffer.from("<script>alert(1)</script>", "latin1") });
  assert.ok(has(input, "Exif") && has(input, Buffer.from([0x25, 0x88])), "the test picture carries EXIF with a GPS pointer");
  const r = inspectPicture(input, LIMITS);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([r.type, r.width, r.height], ["image/jpeg", 64, 48]);
  for (const gone of ["Exif", "JFIF", "xmpmeta", "<script>", "<html>", Buffer.from([0xff, 0xe1]), Buffer.from([0xff, 0xe0]), Buffer.from([0xff, 0xfe])]) {
    assert.ok(!has(r.data, gone), String(gone));
  }
  assert.ok(has(r.data, "Adobe"), "APP14 stays: CMYK pictures need it");
  assert.ok(has(r.data, Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a, 0xff, 0xd9])), "the coded data and EOI are untouched");
  assert.ok(r.data.subarray(-2).equals(Buffer.from([0xff, 0xd9])));
  assert.equal(inspectPicture(r.data, LIMITS).data.equals(r.data), true);
  assert.equal(inspectPicture(jpeg(64, 48).subarray(0, 60), LIMITS).ok, false, "cut short");
  assert.match(inspectPicture(jpeg(2000, 10), LIMITS).message, /2000 x 10/);
});

test("pictures: GIF keeps its frames and NETSCAPE2.0, loses comments, XMP, plain text and trailing data", () => {
  const input = gif(100, 80, 3, { comment: "<script>alert(1)</script>", xmp: "<x:xmpmeta>gps</x:xmpmeta>", plainText: "hello", after: Buffer.from("<html>", "latin1") });
  const r = inspectPicture(input, LIMITS);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([r.type, r.width, r.height, r.frames], ["image/gif", 100, 80, 3]);
  assert.ok(has(r.data, "NETSCAPE2.0"), "looping stays");
  for (const gone of ["<script>", "XMP DataXMP", "xmpmeta", "hello", "<html>"]) assert.ok(!has(r.data, gone), gone);
  assert.equal(r.data.filter((b, i) => b === 0x21 && r.data[i + 1] === 0xf9).length >= 3, true, "each frame keeps its graphic control");
  assert.equal(r.data.at(-1), 0x3b, "ends at the trailer");
  assert.equal(inspectPicture(r.data, LIMITS).data.equals(r.data), true);
  assert.match(inspectPicture(gif(513, 10, 1), LIMITS).message, /513 x 10/, "the logical screen is checked");
  assert.match(inspectPicture(gif(100, 100, 1, { frame: [300, 300], at: [300, 0] }), LIMITS).message, /frame/, "every frame must fit");
  assert.match(inspectPicture(gif(10, 10, 301), LIMITS).message, /more than 300 frames/);
  assert.equal(inspectPicture(gif(10, 10, 300), LIMITS).frames, 300);
  assert.equal(inspectPicture(gif(10, 10, 0), LIMITS).ok, false, "no frame at all");
  assert.equal(inspectPicture(gif(10, 10, 2).subarray(0, 40), LIMITS).ok, false, "cut short");
  // the classic GIF/JavaScript polyglot: the header doubles as script; its "screen" is 10799 wide
  const poly = Buffer.concat([Buffer.from("GIF89a/*", "latin1"), Buffer.alloc(30, 0x20), Buffer.from("*/=alert(1);", "latin1")]);
  assert.equal(inspectPicture(poly, LIMITS).ok, false);
});

test("pictures: WebP loses EXIF, XMP and unknown chunks, with its flags and size rewritten", () => {
  const still = inspectPicture(webp([vp8l(64, 32)]), LIMITS);
  assert.deepEqual([still.ok, still.type, still.width, still.height, still.frames], [true, "image/webp", 64, 32, 1]);
  const input = webp([vp8x(0x02 | 0x04 | 0x08 | 0x10, 200, 100), riff("ANIM", Buffer.alloc(6)), anmf(200, 100), anmf(100, 50),
    riff("EXIF", Buffer.from("MM\0*GPS data", "latin1")), riff("XMP ", Buffer.from("<x:xmpmeta/>", "latin1")), riff("ZZZZ", Buffer.from("<script>", "latin1"))],
  Buffer.from("trailing <html>", "latin1"));
  const r = inspectPicture(input, LIMITS);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([r.width, r.height, r.frames], [200, 100, 2]);
  for (const gone of ["EXIF", "XMP ", "xmpmeta", "ZZZZ", "<script>", "<html>"]) assert.ok(!has(r.data, gone), gone);
  assert.equal(r.data[20] & 0x0c, 0, "the EXIF and XMP flags are cleared");
  assert.equal(r.data[20] & 0x12, 0x12, "animation and alpha stay");
  assert.equal(r.data.readUInt32LE(4), r.data.length - 8, "the RIFF size matches");
  assert.equal(inspectPicture(r.data, LIMITS).data.equals(r.data), true);
  assert.match(inspectPicture(webp([vp8x(0x02, 600, 100), anmf(100, 100)]), LIMITS).message, /600 x 100/);
  const many = [vp8x(0x02, 10, 10)];
  for (let i = 0; i < 301; i++) many.push(anmf(10, 10));
  assert.match(inspectPicture(webp(many), LIMITS).message, /more than 300 frames/);
  assert.equal(inspectPicture(webp([vp8x(0x02, 10, 10), anmf(20, 20)]), LIMITS).ok, false, "a frame outside the canvas");
});

test("pictures: SVG, HTML, text and empty files are refused", () => {
  for (const bad of [
    "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    "<?xml version=\"1.0\"?><svg/>",
    "<html><body>hi</body></html>",
    "BM fake bitmap",
    "",
  ]) {
    const r = inspectPicture(Buffer.from(bad, "latin1"), LIMITS);
    assert.equal(r.ok, false, bad);
  }
  assert.match(inspectPicture(Buffer.from("<svg/>"), LIMITS).message, /PNG, JPEG, WebP or GIF/);
});

// ---- the routes -------------------------------------------------------------------------------

function send(base, method, p, { bytes, type, cookie, origin = ORIGIN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin) h.origin = origin;
    if (cookie) h.cookie = cookie;
    if (type) h["content-type"] = type;
    if (bytes) h["content-length"] = bytes.length;
    const req = http.request(base + p, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString("utf8")); } catch (e) { /* bytes */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

describe("profile pictures over HTTP", () => {
  let t;
  let user;
  let mod;
  let adm;
  let other;
  const forumLimits = () => Object.fromEntries(Object.keys(DEFAULTS.limits).map((k) => [k, ROOMY]));
  const account = async (name, role) => {
    const cookie = await signup(t.base, name);
    const a = t.app.accounts.getByUsername(name);
    if (role) t.app.accounts.setRole(a.id, role);
    return { cookie, id: a.id, name };
  };
  before(async () => {
    t = await startApp({
      modules: ["forum"],
      limits: { signupPerIp: ROOMY, loginPerIp: ROOMY, loginPerUser: ROOMY },
      moduleSettings: { forum: { limits: { ...forumLimits(), picture: { max: 6, windowSeconds: 3600, blockSeconds: 1800, maxBlockSeconds: 1800 } }, pictureMaxBytes: 65536, picturesAtOnce: 1 } },
    }, { modulesDir: MODULES });
    user = await account("Trinity");
    other = await account("Switch");
    mod = await account("Morpheus", "moderator");
    adm = await account("Oracle", "admin");
  });
  after(async () => {
    await t.close();
  });

  test("the defaults: 10 MB, 512 x 512, 300 frames, four formats", () => {
    assert.equal(DEFAULTS.pictureMaxBytes, 10 * 1024 * 1024);
    assert.equal(DEFAULTS.pictureMaxSide, 512);
    assert.equal(DEFAULTS.pictureMaxFrames, 300);
  });

  test("upload, serve with the checked type and the safe headers, replace, remove", async () => {
    const input = png(32, 32, { before: [pngChunk("tEXt", Buffer.from("Comment\0secret", "latin1"))] });
    const up = await send(t.base, "PUT", "/api/forum/avatar", { bytes: input, type: "image/png", cookie: user.cookie });
    assert.equal(up.status, 200, up.body.toString());
    const pic = up.json.picture;
    assert.deepEqual([pic.type, pic.width, pic.height, pic.frames, pic.id], ["image/png", 32, 32, 1, user.id]);
    const file = path.join(t.dir, "data", "modules", "forum", "avatars", user.id + "-" + pic.v + ".png");
    assert.ok(fs.existsSync(file), "kept under the data folder");
    assert.ok(!has(fs.readFileSync(file), "secret"), "stored without the metadata");
    const got = await send(t.base, "GET", "/api/forum/avatars/" + user.id + "?v=" + pic.v);
    assert.equal(got.status, 200);
    assert.ok(got.body.equals(fs.readFileSync(file)));
    assert.equal(got.headers["content-type"], "image/png");
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.match(got.headers["content-security-policy"], /^default-src 'none'/);
    assert.equal(got.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal((await send(t.base, "GET", "/api/forum/avatars/" + user.id + "?v=1")).headers["cache-control"], "no-cache", "an old version is not cached for good");
    const again = await send(t.base, "GET", "/api/forum/avatars/" + user.id + "?v=" + pic.v, { headers: { "if-none-match": got.headers.etag } });
    assert.equal(again.status, 304);
    const head = await send(t.base, "HEAD", "/api/forum/avatars/" + user.id + "?v=" + pic.v);
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    const mine = await request(t.base, "GET", "/api/forum/avatar", { cookie: user.cookie });
    assert.equal(mine.json.picture.v, pic.v);
    assert.deepEqual(mine.json.limits.types, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
    // replaced by an animated GIF: a new version, the old file gone
    const anim = await send(t.base, "PUT", "/api/forum/avatar", { bytes: gif(64, 64, 5), type: "image/gif", cookie: user.cookie });
    assert.equal(anim.status, 200);
    assert.notEqual(anim.json.picture.v, pic.v);
    assert.equal(anim.json.picture.frames, 5);
    await until(() => !fs.existsSync(file));
    assert.equal((await send(t.base, "GET", "/api/forum/avatars/" + user.id + "?v=" + anim.json.picture.v)).headers["content-type"], "image/gif");
    // shown beside the posts and on the profile
    const th = await request(t.base, "POST", "/api/forum/categories/general/threads", { cookie: user.cookie, body: { title: "With a face", body: "hi" } });
    const view = await request(t.base, "GET", "/api/forum/threads/" + th.json.thread.id);
    assert.deepEqual(view.json.posts[0].by.picture, { id: user.id, v: anim.json.picture.v, bytes: anim.json.picture.bytes, frames: 5, type: "image/gif" });
    assert.equal((await request(t.base, "GET", "/api/forum/users/Trinity")).json.user.picture.v, anim.json.picture.v);
    const gone = await request(t.base, "DELETE", "/api/forum/avatar", { cookie: user.cookie });
    assert.equal(gone.json.changed, true);
    assert.equal((await send(t.base, "GET", "/api/forum/avatars/" + user.id)).status, 404);
  });

  test("refused: other types, SVG sent as a picture, too large, broken", async () => {
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>");
    for (const type of ["image/svg+xml", "text/html", "application/json", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const r = await send(t.base, "PUT", "/api/forum/avatar", { bytes: svg, type, cookie: user.cookie });
      assert.equal(r.status, 415, type);
    }
    const lie = await send(t.base, "PUT", "/api/forum/avatar", { bytes: svg, type: "image/png", cookie: user.cookie });
    assert.equal(lie.status, 400, "the bytes decide, not the type it was sent as");
    assert.match(lie.json.message, /PNG, JPEG, WebP or GIF/);
    const big = await send(t.base, "PUT", "/api/forum/avatar", { bytes: Buffer.alloc(70000, 1), type: "image/png", cookie: user.cookie });
    assert.equal(big.status, 413);
    const broken = await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8).subarray(0, 40), type: "image/png", cookie: user.cookie });
    assert.equal(broken.status, 400);
    const jpg = await send(t.base, "PUT", "/api/forum/avatar", { bytes: jpeg(16, 16, { segments: [gpsExif()] }), type: "image/png", cookie: other.cookie });
    assert.equal(jpg.status, 200, "a JPEG sent as image/png is stored as the JPEG it is");
    assert.equal(jpg.json.picture.type, "image/jpeg");
    assert.equal((await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(4, 4), type: "image/png" })).status, 401);
  });

  test("CSRF: a cross-site upload or removal is refused, and stores nothing", async () => {
    const before = t.app.db.prepare("SELECT count(*) AS n FROM forum_avatars").get().n;
    for (const how of [{ origin: "https://evil.example" }, { origin: null }, { headers: { "sec-fetch-site": "cross-site" } }]) {
      const r = await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: mod.cookie, ...how });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, "csrf");
      const d = await send(t.base, "DELETE", "/api/forum/avatar", { cookie: other.cookie, ...how });
      assert.equal(d.status, 403);
    }
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM forum_avatars").get().n, before);
  });

  test("moderators remove pictures of members below them, and it is audited", async () => {
    await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: mod.cookie });
    const remove = (who, name) => request(t.base, "POST", "/api/forum/avatars/" + name + "/remove", { cookie: who.cookie, body: { reason: "Not for here" } });
    assert.equal((await remove(user, "Switch")).status, 403, "users cannot");
    assert.equal((await remove(mod, "Morpheus")).status, 403, "not your own: that is under ACCOUNT");
    const peer = await account("Seraph", "moderator");
    await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: peer.cookie });
    assert.equal((await remove(mod, "Seraph")).status, 403, "a moderator never acts on a moderator");
    const r = await remove(mod, "Switch");
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, true);
    assert.equal((await send(t.base, "GET", "/api/forum/avatars/" + other.id)).status, 404);
    assert.equal((await remove(adm, "Seraph")).status, 200, "an admin acts on a moderator");
    const rows = t.app.db.prepare("SELECT * FROM audit_log WHERE action = 'forum.picture.remove' ORDER BY id").all();
    assert.deepEqual(rows.map((x) => [x.actor_name, x.target_name, x.detail]), [["Morpheus", "Switch", "Not for here"], ["Oracle", "Seraph", "Not for here"]]);
  });

  test("one upload at a time, uploads per account, and a deleted account's file goes", async () => {
    // an upload that never finishes holds the one place
    const slow = http.request(t.base + "/api/forum/avatar", {
      method: "PUT", headers: { origin: ORIGIN, cookie: user.cookie, "content-type": "image/png", "content-length": 5000 },
    });
    slow.on("error", () => {});
    slow.write(Buffer.alloc(100));
    await new Promise((r) => setTimeout(r, 100));
    const busy = await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: adm.cookie });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers["retry-after"], "5");
    slow.destroy();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: adm.cookie })).status, 200, "the place is free again");
    // six uploads an hour for this test (ten by default)
    const spare = await account("Ghost");
    let status = 0;
    for (let i = 0; i < 7; i++) status = (await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: spare.cookie })).status;
    assert.equal(status, 429);
    const doomed = await account("Kid");
    const up = await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(8, 8), type: "image/png", cookie: doomed.cookie });
    const file = path.join(t.dir, "data", "modules", "forum", "avatars", doomed.id + "-" + up.json.picture.v + ".png");
    assert.ok(fs.existsSync(file));
    t.app.accounts.remove(doomed.id);
    await until(() => !fs.existsSync(file));
  });
});

describe("profile pictures: the disk quota", () => {
  test("a picture past the quota is refused with 507", async () => {
    const t = await startApp({
      modules: ["forum"],
      limits: { signupPerIp: ROOMY },
      moduleSettings: { forum: { pictureQuotaBytes: 400 } },
    }, { modulesDir: MODULES });
    try {
      const a = await signup(t.base, "Apoc");
      const b = await signup(t.base, "Tank");
      assert.equal((await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(4, 4), type: "image/png", cookie: a })).status, 200);
      const full = await send(t.base, "PUT", "/api/forum/avatar", { bytes: png(20, 20, { noise: true }), type: "image/png", cookie: b });
      assert.equal(full.status, 507);
      assert.equal(full.json.error, "storage_full");
    } finally {
      await t.close();
    }
  });
});
