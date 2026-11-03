// The main menu's own art, drawn here, into xash3d-h9-patches\overlay\ts\gfx\shell (xash.bat copies the
// overlay into H9XASH; pass "deploy" to copy them into H9XASH\ts\gfx\shell now as well):
//
//   cls_n, cls_f, cls_d   the close button at the top right: normal, focused, pressed
//   min_n, min_f, min_d   the minimize button beside it
//   conback               the console's background: dark rusted steel plates, seams and rivets, and in its
//                         bottom right the purple H9 helmet, LAMBDA32 in H9XASH\valve\gfx.wad
//
// The buttons are in the menu's purple (gfx\shell\colors.lst). They take the place of the ones in FWGS's
// extras.pk3: the game folder's gfx\shell is searched before it. A preview of each goes to PREVIEW_DIR as a
// .png when that is set.
//
//   node tools\make_shell_art.mjs [deploy]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const TSM = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(TSM, "xash3d-h9-patches", "overlay", "ts", "gfx", "shell");
const DEPLOY = join(TSM, "H9XASH", "ts", "gfx", "shell");
const GFX_WAD = join(TSM, "H9XASH", "valve", "gfx.wad");

/** A picture lump (type 0x42) out of a WAD3, as RGBA; palette index 255 is see-through. */
function wadPicture(file, lump) {
  const b = readFileSync(file);
  if (b.toString("latin1", 0, 4) !== "WAD3") throw new Error(`${file} is not a WAD3`);
  const count = b.readInt32LE(4), dir = b.readInt32LE(8);
  for (let i = 0; i < count; i++) {
    const e = dir + i * 32;
    if (b[e + 12] !== 0x42 || b.toString("latin1", e + 16, e + 32).replace(/\0.*$/s, "").toUpperCase() !== lump) continue;
    const at = b.readInt32LE(e), w = b.readInt32LE(at), h = b.readInt32LE(at + 4);
    const pixels = at + 8, palette = pixels + w * h + 2;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const c = b[pixels + p];
      rgba.set([b[palette + c * 3], b[palette + c * 3 + 1], b[palette + c * 3 + 2], c === 255 ? 0 : 255], p * 4);
    }
    return { w, h, rgba };
  }
  throw new Error(`no picture ${lump} in ${file}`);
}

/** An uncompressed 32-bit TGA, top row first. */
function tga(w, h, rgba) {
  const b = Buffer.alloc(18 + w * h * 4);
  b[2] = 2;
  b.writeUInt16LE(w, 12);
  b.writeUInt16LE(h, 14);
  b[16] = 32;
  b[17] = 8 | 32; // 8 alpha bits, top-left origin
  for (let i = 0; i < w * h; i++) {
    b[18 + i * 4] = rgba[i * 4 + 2];
    b[19 + i * 4] = rgba[i * 4 + 1];
    b[20 + i * 4] = rgba[i * 4];
    b[21 + i * 4] = rgba[i * 4 + 3];
  }
  return b;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);

// ---- the buttons -----------------------------------------------------------------------------------------
const B = 32;
/** The purple of each state: fill, rim, glyph. */
const STATES = {
  n: { fill: [74, 40, 116], rim: [138, 66, 196], glyph: [214, 190, 255] },
  f: { fill: [118, 58, 178], rim: [186, 116, 255], glyph: [246, 236, 255] },
  d: { fill: [48, 26, 78], rim: [110, 52, 160], glyph: [176, 140, 230] },
};
/** How far a point is inside the glyph: an X for close, a bar for minimize. */
const GLYPHS = {
  cls: (x, y) => {
    const u = x - B / 2, v = y - B / 2;
    if (Math.abs(u) > 7.5 || Math.abs(v) > 7.5) return 0;
    const d = Math.min(Math.abs(u - v), Math.abs(u + v)) / Math.SQRT2;
    return smooth(2.1, 1.2, d);
  },
  min: (x, y) => smooth(1.0, 0, Math.max(Math.abs(x - B / 2) - 7.5, Math.abs(y - 21) - 1.6)),
};
function button(glyph, state) {
  const s = STATES[state];
  const px = new Uint8ClampedArray(B * B * 4);
  for (let y = 0; y < B; y++)
    for (let x = 0; x < B; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // a rounded square, 1 px in from the edge, a 2 px rim
      const qx = Math.abs(cx - B / 2) - (B / 2 - 6), qy = Math.abs(cy - B / 2) - (B / 2 - 6);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 5;
      const inside = smooth(0.7, -0.7, d);
      const rim = smooth(-3.2, -1.6, d);
      // lit a little from the top
      let c = mix(s.fill, s.rim, rim);
      c = mix(c, [0, 0, 0], 0.25 * (cy / B));
      c = mix(c, s.glyph, glyph(cx, cy));
      const i = (y * B + x) * 4;
      px.set([...c.map(Math.round), Math.round(inside * 235)], i);
    }
  return px;
}

// ---- the console's background ------------------------------------------------------------------------------
const hash = (x, y, s) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function noise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
const fbm = (x, y, s, octaves = 5) => {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) (v += amp * noise(x * f, y * f, s + o * 17)), (amp *= 0.5), (f *= 2);
  return v / (1 - 0.5 ** octaves);
};

const CW = 1024, CH = 768;
const STEEL = [44, 40, 46];
const RUST_DARK = [62, 30, 16];
const RUST = [118, 58, 24];
const PURPLE = [40, 18, 60];
function conback() {
  const px = new Uint8ClampedArray(CW * CH * 4);
  const PW = 256, PH = 192; // the plates
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) {
      const row = Math.floor(y / PH);
      // every other row of plates offset by half a plate, like a hull's
      const ox = row % 2 ? PW / 2 : 0;
      const px0 = (((x + ox) % PW) + PW) % PW, py0 = y % PH;
      const plate = Math.floor((x + ox) / PW) * 7 + row * 13;
      // the plate's own tone, and its brushed grain
      const tone = 0.85 + 0.3 * hash(plate, 1, 3);
      const grain = 0.92 + 0.16 * fbm(x / 160, y / 3, 11, 3);
      let c = STEEL.map((v) => v * tone * grain);
      // corrosion: blotches of rust, darker at their edges, streaking down from the seams and rivets
      const blot = fbm(x / 90, y / 70, 21 + plate);
      const streak = fbm(x / 9, y / 140, 31) * smooth(PH * 0.75, 0, py0);
      const rust = smooth(0.48, 0.78, blot * 0.75 + streak * 0.45);
      const pit = fbm(x / 6, y / 6, 41, 3);
      c = mix(c, mix(RUST_DARK, RUST, smooth(0.35, 0.8, pit)), rust * 0.9);
      // the seams: a dark groove, lit along its lower edge
      const sx = Math.min(px0, PW - px0), sy = Math.min(py0, PH - py0);
      const seam = Math.min(sx, sy);
      c = mix(c, [10, 8, 10], smooth(3, 0.5, seam));
      if (py0 >= 2 && py0 < 4) c = mix(c, [84, 74, 84], 0.25);
      // rivets along each edge, every 32 px
      for (const [rx, ry] of [
        [Math.round(px0 / 32) * 32, 10],
        [Math.round(px0 / 32) * 32, PH - 10],
        [10, Math.round(py0 / 32) * 32],
        [PW - 10, Math.round(py0 / 32) * 32],
      ]) {
        if (rx < 10 || rx > PW - 10 || ry < 10 || ry > PH - 10) continue;
        const d = Math.hypot(px0 - rx, py0 - ry);
        if (d < 4.5) {
          const lit = clamp(0.5 - (px0 - rx + (py0 - ry)) / 9);
          c = mix([22, 18, 20], [96, 82, 86], lit) .map((v, k) => v * smooth(4.5, 3.2, d) + c[k] * (1 - smooth(4.5, 3.2, d)));
        } else if (d < 6.5) c = mix(c, [14, 10, 12], smooth(6.5, 4.5, d) * 0.6);
      }
      // grime and a purple cast from the menu, dark at the edges, so the letters over it read
      c = mix(c, [0, 0, 0], 0.35 * fbm(x / 200, y / 200, 51));
      c = mix(c, PURPLE, 0.22);
      const vig = Math.hypot((x - CW / 2) / (CW / 2), (y - CH / 2) / (CH / 2));
      c = c.map((v) => v * (0.82 - 0.3 * smooth(0.6, 1.4, vig)));
      px.set([...c.map(Math.round), 255], (y * CW + x) * 4);
    }
  stampHelmet(px);
  return px;
}

/** The H9 helmet in the bottom right, its pixels kept square (HELMET_SCALE to one), a soft shadow under it. */
const HELMET_SCALE = 4, HELMET_MARGIN = 28;
function stampHelmet(px) {
  const helmet = wadPicture(GFX_WAD, "LAMBDA32");
  const w = helmet.w * HELMET_SCALE, h = helmet.h * HELMET_SCALE;
  const x0 = CW - HELMET_MARGIN - w, y0 = CH - HELMET_MARGIN - h;
  const alphaAt = (x, y) => {
    const hx = Math.floor((x - x0) / HELMET_SCALE), hy = Math.floor((y - y0) / HELMET_SCALE);
    if (hx < 0 || hy < 0 || hx >= helmet.w || hy >= helmet.h) return 0;
    return helmet.rgba[(hy * helmet.w + hx) * 4 + 3] / 255;
  };
  const R = 6; // the shadow's blur, offset down and right by 4
  for (let y = y0 - R; y < y0 + h + R + 4; y++)
    for (let x = x0 - R; x < x0 + w + R + 4; x++) {
      let a = 0, n = 0;
      for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) (a += alphaAt(x - 4 + dx, y - 4 + dy)), n++;
      const i = (y * CW + x) * 4;
      for (let k = 0; k < 3; k++) px[i + k] *= 1 - 0.6 * (a / n);
    }
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const p = (Math.floor((y - y0) / HELMET_SCALE) * helmet.w + Math.floor((x - x0) / HELMET_SCALE)) * 4;
      const a = helmet.rgba[p + 3] / 255;
      const i = (y * CW + x) * 4;
      for (let k = 0; k < 3; k++) px[i + k] = px[i + k] * (1 - a) + helmet.rgba[p + k] * a;
    }
}

mkdirSync(OUT, { recursive: true });
const made = [];
const put = (name, w, h, rgba) => {
  writeFileSync(join(OUT, `${name}.tga`), tga(w, h, rgba));
  if (process.env.PREVIEW_DIR) writeFileSync(join(process.env.PREVIEW_DIR, `${name}.png`), png(w, h, rgba));
  made.push(`${name}.tga`);
};
for (const g of ["cls", "min"]) for (const st of ["n", "f", "d"]) put(`${g}_${st}`, B, B, button(GLYPHS[g], st));
put("conback", CW, CH, conback());
console.log(`  ${made.join(", ")} into ${OUT}`);
if (process.argv.includes("deploy")) {
  mkdirSync(DEPLOY, { recursive: true });
  for (const f of made) copyFileSync(join(OUT, f), join(DEPLOY, f));
  console.log(`  copied into ${DEPLOY}`);
}
