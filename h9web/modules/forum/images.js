// Profile pictures: what an upload must be, and what is kept of it.
//
// inspectPicture(bytes, { maxSide, maxFrames }) tells the format from the file's first bytes
// (never from its name or the type it was sent with), reads the size from the format's own
// header, and returns the picture with its metadata left out:
//   PNG   every chunk but IHDR, PLTE, IDAT, IEND and tRNS is dropped (text, eXIf, iCCP, time,
//         and the APNG animation chunks too, so an animated PNG keeps its first frame); the CRC
//         of every chunk kept is checked
//   JPEG  the APPn segments (EXIF and its GPS block, XMP, ICC, JFIF, thumbnails) and COM are
//         dropped; APP14 ("Adobe", colour transform flags and nothing else) stays, because a
//         CMYK picture decodes wrong without it
//   WebP  EXIF and XMP chunks are dropped, and any chunk WebP does not define; the VP8X flags
//         and the RIFF size are rewritten to match
//   GIF   Comment and Plain Text extensions are dropped (a Plain Text block with its Graphic
//         Control), and every Application extension but NETSCAPE2.0 and ANIMEXTS1.0 (looping);
//         XMP travels in an Application extension
// Anything after the format's own end (after IEND, EOI, the GIF trailer or the RIFF size) is
// dropped, so data appended to a picture (a "polyglot") is never stored. Nothing is decoded or
// re-encoded: the picture's pixels are the bytes that came in.
//
// Size limits come from the headers: the picture (a GIF's logical screen, a WebP's canvas) and
// every frame in it must fit in maxSide x maxSide, and a GIF or WebP may hold at most maxFrames
// frames, so a small file cannot unpack into a huge picture in a reader's browser.
//
// The result is { ok: true, type, ext, width, height, frames, data } or { ok: false, message }.

import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ICCP", "ANIM", "ANMF"]);
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const fail = (message) => ({ ok: false, message });
const DAMAGED = "The picture file is damaged or cut short.";

export function detectFormat(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && (buf.toString("latin1", 0, 6) === "GIF87a" || buf.toString("latin1", 0, 6) === "GIF89a")) return "gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

export function inspectPicture(buf, { maxSide = 512, maxFrames = 300 } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return fail("Choose a picture first.");
  const limits = { maxSide, maxFrames };
  switch (detectFormat(buf)) {
    case "png": return png(buf, limits);
    case "jpeg": return jpeg(buf, limits);
    case "gif": return gif(buf, limits);
    case "webp": return webp(buf, limits);
    default: return fail("Use a PNG, JPEG, WebP or GIF picture.");
  }
}

function sized(width, height, { maxSide }) {
  if (!(width > 0 && height > 0)) return fail(DAMAGED);
  if (width > maxSide || height > maxSide) return fail("The picture is " + width + " x " + height + ". Make it at most " + maxSide + " x " + maxSide + ".");
  return null;
}

function png(buf, limits) {
  const kept = [PNG_SIGNATURE];
  let p = 8;
  let width = 0;
  let height = 0;
  let idat = false;
  let ended = false;
  while (p + 12 <= buf.length) {
    const length = buf.readUInt32BE(p);
    if (length > 0x7fffffff || p + 12 + length > buf.length) return fail(DAMAGED);
    const type = buf.toString("latin1", p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(DAMAGED);
    if (p === 8) {
      if (type !== "IHDR" || length !== 13) return fail(DAMAGED);
      width = buf.readUInt32BE(p + 8);
      height = buf.readUInt32BE(p + 12);
    }
    if (PNG_KEEP.has(type)) {
      if (zlib.crc32(buf.subarray(p + 4, p + 8 + length)) !== buf.readUInt32BE(p + 8 + length)) return fail(DAMAGED);
      kept.push(buf.subarray(p, p + 12 + length));
      if (type === "IDAT") idat = true;
    } else if ((type.charCodeAt(0) & 0x20) === 0) {
      // an unknown critical chunk: a decoder must understand it, so it cannot be dropped
      return fail("This PNG uses a feature browsers do not show.");
    }
    p += 12 + length;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || !idat) return fail(DAMAGED);
  return sized(width, height, limits) || { ok: true, type: "image/png", ext: "png", width, height, frames: 1, data: Buffer.concat(kept) };
}

function jpeg(buf, limits) {
  const kept = [buf.subarray(0, 2)];
  let p = 2;
  let width = 0;
  let height = 0;
  let frame = false;
  let scan = false;
  for (;;) {
    if (p >= buf.length || buf[p] !== 0xff) return fail(DAMAGED);
    while (p < buf.length && buf[p] === 0xff) p++;
    if (p >= buf.length) return fail(DAMAGED);
    const marker = buf[p++];
    if (marker === 0xd9) {
      kept.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return fail(DAMAGED);
    if (p + 2 > buf.length) return fail(DAMAGED);
    const length = buf.readUInt16BE(p);
    if (length < 2 || p + length > buf.length) return fail(DAMAGED);
    const segment = buf.subarray(p - 2, p + length);
    if (JPEG_SOF.has(marker)) {
      if (length < 8) return fail(DAMAGED);
      height = buf.readUInt16BE(p + 3);
      width = buf.readUInt16BE(p + 5);
      frame = true;
      kept.push(segment);
    } else if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xee) kept.push(segment);
    } else if (marker !== 0xfe) {
      kept.push(segment);
    }
    p += length;
    if (marker === 0xda) {
      // the scan's coded data runs to the next marker that is not a stuffed 0xFF00 or a restart
      if (!frame) return fail(DAMAGED);
      scan = true;
      const start = p;
      for (;;) {
        p = buf.indexOf(0xff, p);
        if (p < 0 || p + 1 >= buf.length) return fail(DAMAGED);
        const next = buf[p + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
          p += next === 0xff ? 1 : 2;
          continue;
        }
        break;
      }
      kept.push(buf.subarray(start, p));
    }
  }
  if (!frame || !scan) return fail(DAMAGED);
  return sized(width, height, limits) || { ok: true, type: "image/jpeg", ext: "jpg", width, height, frames: 1, data: Buffer.concat(kept) };
}

// The end of a run of GIF data sub-blocks starting at q (just past its 0 terminator), or -1.
function subBlocksEnd(buf, q) {
  for (;;) {
    if (q >= buf.length) return -1;
    const n = buf[q];
    q += 1 + n;
    if (n === 0) return q;
  }
}

function gif(buf, limits) {
  if (buf.length < 13) return fail(DAMAGED);
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  if (p > buf.length) return fail(DAMAGED);
  const tooBig = sized(width, height, limits);
  if (tooBig) return tooBig;
  const kept = [buf.subarray(0, p)];
  let frames = 0;
  let control = null;
  let ended = false;
  while (p < buf.length) {
    const introducer = buf[p];
    if (introducer === 0x3b) {
      kept.push(buf.subarray(p, p + 1));
      ended = true;
      break;
    }
    if (introducer === 0x21) {
      if (p + 2 >= buf.length) return fail(DAMAGED);
      const label = buf[p + 1];
      const end = subBlocksEnd(buf, p + 2);
      if (end < 0) return fail(DAMAGED);
      const block = buf.subarray(p, end);
      if (label === 0xf9) {
        control = block;
      } else if (label === 0xff) {
        const id = buf[p + 2] === 11 && p + 14 <= buf.length ? buf.toString("latin1", p + 3, p + 14) : "";
        if (id === "NETSCAPE2.0" || id === "ANIMEXTS1.0") kept.push(block);
      } else if (label === 0x01) {
        control = null;
      }
      p = end;
      continue;
    }
    if (introducer === 0x2c) {
      if (p + 10 > buf.length) return fail(DAMAGED);
      const left = buf.readUInt16LE(p + 1);
      const top = buf.readUInt16LE(p + 3);
      const w = buf.readUInt16LE(p + 5);
      const h = buf.readUInt16LE(p + 7);
      const local = buf[p + 9];
      let q = p + 10;
      if (local & 0x80) q += 3 * (1 << ((local & 7) + 1));
      q += 1;
      if (q > buf.length) return fail(DAMAGED);
      const end = subBlocksEnd(buf, q);
      if (end < 0) return fail(DAMAGED);
      if (!(w > 0 && h > 0)) return fail(DAMAGED);
      if (left + w > limits.maxSide || top + h > limits.maxSide) {
        return fail("A frame of this GIF reaches past " + limits.maxSide + " x " + limits.maxSide + ". Make it smaller.");
      }
      if (++frames > limits.maxFrames) return fail("The GIF has more than " + limits.maxFrames + " frames. Shorten it.");
      if (control) kept.push(control);
      control = null;
      kept.push(buf.subarray(p, end));
      p = end;
      continue;
    }
    return fail(DAMAGED);
  }
  if (!ended || !frames) return fail(DAMAGED);
  return { ok: true, type: "image/gif", ext: "gif", width, height, frames, data: Buffer.concat(kept) };
}

const u24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

function webp(buf, limits) {
  if (buf.length < 20) return fail(DAMAGED);
  const end = 8 + buf.readUInt32LE(4);
  if (end < 20 || end > buf.length) return fail(DAMAGED);
  const kept = [];
  let p = 12;
  let extended = null;
  let width = 0;
  let height = 0;
  let frames = 0;
  let stills = 0;
  while (p + 8 <= end) {
    const fourcc = buf.toString("latin1", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (p + 8 + size > end) return fail(DAMAGED);
    const body = buf.subarray(p + 8, p + 8 + size);
    const whole = Buffer.from(buf.subarray(p, Math.min(p + 8 + size + (size & 1), end)));
    if (p === 12 && fourcc !== "VP8 " && fourcc !== "VP8L" && fourcc !== "VP8X") return fail(DAMAGED);
    if (fourcc === "VP8X") {
      if (p !== 12 || size < 10) return fail(DAMAGED);
      extended = whole;
      width = 1 + u24(body, 4);
      height = 1 + u24(body, 7);
    } else if (fourcc === "VP8 ") {
      if (size < 10 || body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) return fail(DAMAGED);
      const w = body.readUInt16LE(6) & 0x3fff;
      const h = body.readUInt16LE(8) & 0x3fff;
      const tooBig = sized(w, h, limits);
      if (tooBig) return tooBig;
      if (!extended) {
        width = w;
        height = h;
      }
      stills++;
    } else if (fourcc === "VP8L") {
      if (size < 5 || body[0] !== 0x2f) return fail(DAMAGED);
      const w = 1 + ((body[1] | (body[2] << 8)) & 0x3fff);
      const h = 1 + (((body[2] >> 6) | (body[3] << 2) | (body[4] << 10)) & 0x3fff);
      const tooBig = sized(w, h, limits);
      if (tooBig) return tooBig;
      if (!extended) {
        width = w;
        height = h;
      }
      stills++;
    } else if (fourcc === "ANMF") {
      if (!extended || size < 16) return fail(DAMAGED);
      const x = 2 * u24(body, 0);
      const y = 2 * u24(body, 3);
      const w = 1 + u24(body, 6);
      const h = 1 + u24(body, 9);
      if (x + w > width || y + h > height) return fail(DAMAGED);
      if (++frames > limits.maxFrames) return fail("The picture has more than " + limits.maxFrames + " frames. Shorten it.");
    }
    if (WEBP_KEEP.has(fourcc)) kept.push(whole);
    p += 8 + size + (size & 1);
  }
  if (!stills && !frames) return fail(DAMAGED);
  if (!extended && stills !== 1) return fail(DAMAGED);
  const tooBig = sized(width, height, limits);
  if (tooBig) return tooBig;
  // no EXIF (0x08) or XMP (0x04) chunk is left, so their flags go too
  if (extended) extended[8] &= ~0x0c;
  const chunks = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + chunks.length, 4);
  header.write("WEBP", 8, "latin1");
  return { ok: true, type: "image/webp", ext: "webp", width, height, frames: frames || 1, data: Buffer.concat([header, chunks]) };
}
