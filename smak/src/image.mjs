// Pictures: RGB images cut down to the 256 colours a studio model's texture holds, and PNG and BMP files
// written and read, with nothing but Node's own zlib.
//
//   an image    { width, height, rgb }                    three bytes a pixel
//   a texture   { name, width, height, pixels, palette }  one palette index a pixel, 768 bytes of palette
import { deflateSync, inflateSync } from "node:zlib";

const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function png(width, height, rgba) {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** A PNG file read: { width, height, rgba }. Eight bits a channel, not interlaced: grey, RGB, palette, with or without alpha. */
export function unpng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
  let o = 8, width = 0, height = 0, kind = 6, pal = null, trns = null; const data = [];
  while (o < buf.length) {
    const n = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + n);
    if (type === "IHDR") { width = d.readUInt32BE(0); height = d.readUInt32BE(4); kind = d[9]; if (d[8] !== 8 || d[12]) throw new Error("a PNG of 8 bits a channel and not interlaced is what is read: save it so"); }
    else if (type === "PLTE") pal = d; else if (type === "tRNS") trns = d; else if (type === "IDAT") data.push(d);
    o += 12 + n;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[kind], stride = width * ch, raw = inflateSync(Buffer.concat(data)), rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++], line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0, q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
      line[x] = raw[p++] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0);
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, v = line.subarray(x * ch, x * ch + ch);
      if (kind === 3) { rgba[i] = pal[v[0] * 3]; rgba[i + 1] = pal[v[0] * 3 + 1]; rgba[i + 2] = pal[v[0] * 3 + 2]; rgba[i + 3] = trns && v[0] < trns.length ? trns[v[0]] : 255; }
      else if (kind === 0 || kind === 4) { rgba[i] = rgba[i + 1] = rgba[i + 2] = v[0]; rgba[i + 3] = kind === 4 ? v[1] : 255; }
      else { rgba[i] = v[0]; rgba[i + 1] = v[1]; rgba[i + 2] = v[2]; rgba[i + 3] = kind === 6 ? v[3] : 255; }
    }
    prev = line;
  }
  return { width, height, rgba };
}
/** A palette image as RGBA; with `masked`, the last colour of the palette is see-through, as in the engine. */
export function rgbaOf({ width, height, pixels, palette }, masked = false) {
  const o = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) { const p = pixels[i]; o[i * 4] = palette[p * 3]; o[i * 4 + 1] = palette[p * 3 + 1]; o[i * 4 + 2] = palette[p * 3 + 2]; o[i * 4 + 3] = masked && p === 255 ? 0 : 255; }
  return o;
}

// ── texture: smaller, and down to 256 colours ──────────────────────────────
export function shrink({ width, height, rgb }, k) {
  const w = Math.floor(width / k), h = Math.floor(height / k), out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let a = 0; for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) a += rgb[((y * k + j) * width + x * k + i) * 3 + c];
    out[(y * w + x) * 3 + c] = Math.round(a / (k * k));
  }
  return { width: w, height: h, rgb: out };
}
/** An image as a texture: median cut over the colours in use (counted in 6 bits a channel), down to `most`. */
export function indexed({ width, height, rgb }, name, most = 256) {
  const count = new Map();
  const key = (i) => (rgb[i] >> 2) << 12 | (rgb[i + 1] >> 2) << 6 | rgb[i + 2] >> 2;
  for (let i = 0; i < rgb.length; i += 3) { const k = key(i); let e = count.get(k); if (!e) count.set(k, e = { n: 0, c: [0, 0, 0] }); e.n++; e.c[0] += rgb[i]; e.c[1] += rgb[i + 1]; e.c[2] += rgb[i + 2]; }
  const colours = [...count.values()].map((e) => ({ n: e.n, c: e.c.map((v) => v / e.n) }));
  const span = (box) => { let best = { w: -1 }; for (let a = 0; a < 3; a++) { let lo = 255, hi = 0; for (const e of box) { lo = Math.min(lo, e.c[a]); hi = Math.max(hi, e.c[a]); } if (hi - lo > best.w) best = { w: hi - lo, a }; } return best; };
  let boxes = [{ list: colours, ...span(colours) }];
  while (boxes.length < most) {
    const box = boxes.filter((x) => x.list.length > 1).sort((x, y) => y.w - x.w)[0]; if (!box) break;
    const l = box.list.sort((x, y) => x.c[box.a] - y.c[box.a]), half = l.reduce((a, e) => a + e.n, 0) / 2;
    let i = 0, n = 0; while (i < l.length - 1 && n + l[i].n <= half) n += l[i++].n; i = Math.max(1, i);
    boxes = boxes.filter((x) => x !== box).concat([l.slice(0, i), l.slice(i)].map((list) => ({ list, ...span(list) })));
  }
  const palette = new Uint8Array(768), where = new Map();
  boxes.forEach((box, i) => { const n = box.list.reduce((a, e) => a + e.n, 0); for (let a = 0; a < 3; a++) palette[i * 3 + a] = Math.round(box.list.reduce((s, e) => s + e.c[a] * e.n, 0) / n); });
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const k = key(i * 3); let p = where.get(k);
    if (p === undefined) { let d = 1e9; for (let j = 0; j < boxes.length; j++) { const e = (palette[j * 3] - rgb[i * 3]) ** 2 + (palette[j * 3 + 1] - rgb[i * 3 + 1]) ** 2 + (palette[j * 3 + 2] - rgb[i * 3 + 2]) ** 2; if (e < d) { d = e; p = j; } } where.set(k, p); }
    pixels[i] = p;
  }
  return { name, width, height, pixels, palette };
}

// ── pictures with holes, and files of other kinds ──────────────────────────
/** RGBA as an image: the alpha is dropped. */
export function rgbOf({ width, height, rgba }) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
  return { width, height, rgb };
}
/**
 * RGBA as a texture with holes, for a mesh drawn masked (the texture's flag 64): 255 colours, and the last one of the
 * palette where the picture is see-through (alpha under 128). `key` is the colour written there, which nobody sees.
 */
export function masked({ width, height, rgba }, name, key = [0, 0, 255]) {
  const img = rgbOf({ width, height, rgba }), solid = Array.from({ length: width * height }, (_, i) => rgba[i * 4 + 3] >= 128), first = solid.indexOf(true);
  // a hole takes a colour the picture already has, so it costs the palette nothing
  if (first >= 0) for (let i = 0; i < solid.length; i++) if (!solid[i]) img.rgb.set(img.rgb.subarray(first * 3, first * 3 + 3), i * 3);
  const t = indexed(img, name, 255);
  for (let i = 0; i < solid.length; i++) if (!solid[i]) t.pixels[i] = 255;
  t.palette.set(key, 765);
  return { ...t, flags: 64 };
}
/** A texture as a BMP file of 8 bits: its palette as it is, index for index (what a model's texture was made from). */
export function bmp({ width, height, pixels, palette }) {
  const row = (width + 3) & ~3, out = Buffer.alloc(54 + 1024 + row * height);
  out.write("BM", 0, "latin1"); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54 + 1024, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(width, 18); out.writeInt32LE(height, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(8, 28); out.writeUInt32LE(row * height, 34); out.writeUInt32LE(256, 46);
  for (let i = 0; i < 256; i++) { out[54 + i * 4] = palette[i * 3 + 2]; out[54 + i * 4 + 1] = palette[i * 3 + 1]; out[54 + i * 4 + 2] = palette[i * 3]; }
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(out, 54 + 1024 + (height - 1 - y) * row);
  return out;
}
/** A BMP file read, not compressed: of 8 bits, a texture { width, height, pixels, palette } with its palette kept as it is; of 24 or 32, an image { width, height, rgb }. */
export function unbmp(buf) {
  if (buf.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP file");
  const at = buf.readUInt32LE(10), head = buf.readUInt32LE(14), width = buf.readInt32LE(18), h = buf.readInt32LE(22), height = Math.abs(h), bits = buf.readUInt16LE(28);
  if (buf.readUInt32LE(30) !== 0 || ![8, 24, 32].includes(bits)) throw new Error("a BMP of 8, 24 or 32 bits, not compressed, is what is read");
  const row = ((width * bits + 31) >> 5) << 2, line = (y) => at + (h > 0 ? height - 1 - y : y) * row;
  if (bits === 8) {
    const used = buf.readUInt32LE(46) || 256, palette = new Uint8Array(768), pixels = new Uint8Array(width * height);
    for (let i = 0; i < used; i++) { const o = 14 + head + i * 4; palette[i * 3] = buf[o + 2]; palette[i * 3 + 1] = buf[o + 1]; palette[i * 3 + 2] = buf[o]; }
    for (let y = 0; y < height; y++) pixels.set(buf.subarray(line(y), line(y) + width), y * width);
    return { width, height, pixels, palette };
  }
  const rgb = new Uint8Array(width * height * 3), step = bits / 8;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const o = line(y) + x * step; rgb[(y * width + x) * 3] = buf[o + 2]; rgb[(y * width + x) * 3 + 1] = buf[o + 1]; rgb[(y * width + x) * 3 + 2] = buf[o]; }
  return { width, height, rgb };
}
/**
 * A picture file (PNG or BMP) as a texture for a model. A BMP of 8 bits keeps its palette index for index; anything else is
 * cut down to 256 colours, or, with `holes` and a see-through PNG, to 255 and the last for the holes (see masked).
 */
export function textureFrom(buf, name, { holes = false } = {}) {
  if (buf.toString("latin1", 0, 2) === "BM") { const b = unbmp(buf); return b.pixels ? { name, ...b } : indexed(b, name); }
  const img = unpng(buf);
  return holes && img.rgba.some((v, i) => i % 4 === 3 && v < 128) ? masked(img, name) : indexed(rgbOf(img), name);
}
