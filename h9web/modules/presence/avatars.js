// Players' pictures for the in-game scoreboard (docs\PLAYER_LIMIT_128.txt section 11.7): an
// account's forum profile picture, as a 64 x 64 PNG. The game names a picture by account and a
// version that fits a 32-bit number (gameVersion: the forum's version, milliseconds, modulo
// 2^31 - 1); a new picture is a new version, so an address never changes what it serves.
//
// The forum keeps a picture as it was uploaded (PNG, JPEG, WebP or GIF, at most 512 x 512,
// modules\forum\images.js) and decodes none. This file decodes PNG (every colour type and bit
// depth, interlaced too) and GIF (its first frame), crops the middle square, scales it to 64 x 64
// (an area average, weighted by alpha, or the nearest pixel for a smaller picture) and writes an
// RGBA PNG. A JPEG or WebP picture has no game picture yet: the scoreboard keeps the silhouette.

import zlib from "node:zlib";

export const AVATAR_SIDE = 64;
export const GAME_TYPES = new Set(["image/png", "image/gif"]);
export const gameVersion = (version) => Number(version) % 2147483647;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 2048;

// ---- PNG --------------------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Undoes the scanline filters of one (sub)image in place: rows of 1 + lineBytes bytes.
function unfilter(data, offset, lineBytes, rows, bpp) {
  const out = Buffer.alloc(lineBytes * rows);
  for (let y = 0; y < rows; y++) {
    const type = data[offset + y * (lineBytes + 1)];
    const src = offset + y * (lineBytes + 1) + 1;
    const dst = y * lineBytes;
    for (let x = 0; x < lineBytes; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - lineBytes + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - lineBytes + x - bpp] : 0;
      let v;
      if (type === 0) v = raw;
      else if (type === 1) v = raw + a;
      else if (type === 2) v = raw + b;
      else if (type === 3) v = raw + ((a + b) >> 1);
      else if (type === 4) v = raw + paeth(a, b, c);
      else throw new Error("bad filter");
      out[dst + x] = v & 255;
    }
  }
  return out;
}

// One sample of a row as 0..255.
function sample(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return row[index * 2];
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * (index % perByte + 1);
  const v = (byte >> shift) & ((1 << depth) - 1);
  return Math.round((v * 255) / ((1 << depth) - 1));
}

// The raw (not scaled) sample, for palette indices and tRNS comparisons.
function rawSample(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return (row[index * 2] << 8) | row[index * 2 + 1];
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * (index % perByte + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let p = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (p + 12 <= buf.length) {
    const length = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    if (p + 12 + length > buf.length) throw new Error("cut short");
    const body = buf.subarray(p + 8, p + 8 + length);
    if (type === "IHDR") ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + length;
  }
  if (!ihdr || !idat.length) throw new Error("no image");
  const { width, height, depth, color, interlace } = ihdr;
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) throw new Error("bad size");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (color === 3 && !palette)) throw new Error("unsupported");
  const data = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (width * channels * 2 + 1) * height * 2 + 1024 });
  const bpp = Math.max(1, (channels * depth) >> 3);
  const rgba = Buffer.alloc(width * height * 4);

  const put = (row, x, tx, ty) => {
    const o = (ty * width + tx) * 4;
    if (color === 3) {
      const i = rawSample(row, x, depth);
      rgba[o] = palette[i * 3] || 0;
      rgba[o + 1] = palette[i * 3 + 1] || 0;
      rgba[o + 2] = palette[i * 3 + 2] || 0;
      rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
      return;
    }
    if (color === 0 || color === 4) {
      const g = sample(row, x * channels, depth);
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
      rgba[o + 3] = color === 4 ? sample(row, x * channels + 1, depth) : trns && trns.length >= 2 && rawSample(row, x, depth) === trns.readUInt16BE(0) ? 0 : 255;
      return;
    }
    rgba[o] = sample(row, x * channels, depth);
    rgba[o + 1] = sample(row, x * channels + 1, depth);
    rgba[o + 2] = sample(row, x * channels + 2, depth);
    if (color === 6) rgba[o + 3] = sample(row, x * channels + 3, depth);
    else {
      const key = trns && trns.length >= 6;
      rgba[o + 3] = key && rawSample(row, x * 3, depth) === trns.readUInt16BE(0) && rawSample(row, x * 3 + 1, depth) === trns.readUInt16BE(2) &&
        rawSample(row, x * 3 + 2, depth) === trns.readUInt16BE(4) ? 0 : 255;
    }
  };

  // Adam7: seven passes of a smaller image each; one pass of the whole image otherwise
  const passes = interlace === 1
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const lineBytes = Math.ceil((pw * channels * depth) / 8);
    if (offset + (lineBytes + 1) * ph > data.length) throw new Error("cut short");
    const pass = unfilter(data, offset, lineBytes, ph, bpp);
    offset += (lineBytes + 1) * ph;
    for (let y = 0; y < ph; y++) {
      const row = pass.subarray(y * lineBytes, (y + 1) * lineBytes);
      for (let x = 0; x < pw; x++) put(row, x, x0 + x * dx, y0 + y * dy);
    }
  }
  return { width, height, rgba };
}

// ---- GIF, its first frame -----------------------------------------------------------------------

// GIF's LZW: the first count palette indices of the image data.
function lzw(data, minSize, count) {
  const out = new Uint8Array(count);
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  const stack = new Uint8Array(4097);
  let size = minSize + 1;
  let dict = eoi + 1;
  let bits = 0;
  let acc = 0;
  let p = 0;
  let n = 0;
  let old = -1;
  while (n < count) {
    while (bits < size && p < data.length) {
      acc |= data[p++] << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minSize + 1;
      dict = eoi + 1;
      old = -1;
      continue;
    }
    if (code === eoi) break;
    if (old < 0) {
      if (code >= clear) break;
      out[n++] = code;
      old = code;
      continue;
    }
    let sp = 0;
    let c = code;
    if (code === dict) {
      stack[sp++] = first[old];
      c = old;
    } else if (code > dict) break;
    while (c > eoi) {
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    stack[sp++] = c;
    const head = code === dict ? first[old] : first[code];
    while (sp > 0 && n < count) out[n++] = stack[--sp];
    if (dict < 4096) {
      prefix[dict] = old;
      suffix[dict] = head;
      first[dict] = first[old];
      dict++;
      if (dict === 1 << size && size < 12) size++;
    }
    old = code;
  }
  return out;
}

export function decodeGif(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 13 || !/^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) throw new Error("not a GIF");
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) throw new Error("bad size");
  const flags = buf[10];
  let p = 13;
  let global = null;
  if (flags & 0x80) {
    const n = 3 << ((flags & 7) + 1);
    global = buf.subarray(p, p + n);
    p += n;
  }
  let transparent = -1;
  while (p < buf.length) {
    const block = buf[p++];
    if (block === 0x21) {
      const label = buf[p++];
      if (label === 0xf9 && buf[p] >= 4) {
        if (buf[p + 1] & 1) transparent = buf[p + 4];
      }
      while (p < buf.length && buf[p]) p += buf[p] + 1;
      p++;
    } else if (block === 0x2c) {
      const left = buf.readUInt16LE(p);
      const top = buf.readUInt16LE(p + 2);
      const w = buf.readUInt16LE(p + 4);
      const h = buf.readUInt16LE(p + 6);
      const f = buf[p + 8];
      p += 9;
      let table = global;
      if (f & 0x80) {
        const n = 3 << ((f & 7) + 1);
        table = buf.subarray(p, p + n);
        p += n;
      }
      if (!table) throw new Error("no colours");
      const minSize = buf[p++];
      if (minSize < 1 || minSize > 11) throw new Error("bad code size");
      const chunks = [];
      while (p < buf.length && buf[p]) {
        chunks.push(buf.subarray(p + 1, p + 1 + buf[p]));
        p += buf[p] + 1;
      }
      const indices = lzw(Buffer.concat(chunks), minSize, w * h);
      const rgba = Buffer.alloc(width * height * 4);
      // interlaced rows come in four passes
      const order = [];
      if (f & 0x40) {
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) order.push(y);
      } else for (let y = 0; y < h; y++) order.push(y);
      for (let i = 0; i < order.length; i++) {
        const ty = top + order[i];
        if (ty >= height) continue;
        for (let x = 0; x < w; x++) {
          const tx = left + x;
          if (tx >= width) continue;
          const c = indices[i * w + x];
          if (c === transparent) continue;
          const o = (ty * width + tx) * 4;
          rgba[o] = table[c * 3] || 0;
          rgba[o + 1] = table[c * 3 + 1] || 0;
          rgba[o + 2] = table[c * 3 + 2] || 0;
          rgba[o + 3] = 255;
        }
      }
      return { width, height, rgba };
    } else if (block === 0x3b) break;
    else throw new Error("damaged");
  }
  throw new Error("no image");
}

// ---- the square, and the PNG it is written as ---------------------------------------------------

// The middle square of the picture, side x side.
export function square(img, side = AVATAR_SIDE) {
  const s = Math.min(img.width, img.height);
  const ox = Math.floor((img.width - s) / 2);
  const oy = Math.floor((img.height - s) / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    const sy0 = oy + Math.floor((y * s) / side);
    const sy1 = Math.max(sy0 + 1, oy + Math.floor(((y + 1) * s) / side));
    for (let x = 0; x < side; x++) {
      const sx0 = ox + Math.floor((x * s) / side);
      const sx1 = Math.max(sx0 + 1, ox + Math.floor(((x + 1) * s) / side));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const w = img.rgba[i + 3];
          r += img.rgba[i] * w;
          g += img.rgba[i + 1] * w;
          b += img.rgba[i + 2] * w;
          a += w;
          n++;
        }
      }
      const o = (y * side + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: side, height: side, rgba: out };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.rgba.copy(raw, y * (img.width * 4 + 1) + 1, y * img.width * 4, (y + 1) * img.width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// A stored picture's bytes, of the forum's type, as the game's 64 x 64 PNG.
export function gamePicture(bytes, type) {
  const img = type === "image/gif" ? decodeGif(bytes) : decodePng(bytes);
  return encodePng(square(img, AVATAR_SIDE));
}
