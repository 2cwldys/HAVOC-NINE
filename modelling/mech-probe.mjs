// Landmark probe for the ED-209 mech skins. Read-only against the original; writes
// pictures to out\mech_probe\. Not part of any variant -- a measuring stick.
//
//     node mech-probe.mjs
//
// Answers what the painting needs and that cannot be guessed:
//   * which way he faces (+x, measured: the front view's surfaces are the +x-normals)
//   * the body's x / y / z ranges, and the centre-line profile at each height
//   * the palette: the saturated entries (lights, hazard stripes) and the grey ramp
import { K, load, savePng, surface, POSE, lineup } from "./lib.mjs";

const src = load("ed209_ts");
const s = surface(src);

const range = (get) => {
  const v = s.map(get).sort((a, b) => a - b);
  return [v[0], v[Math.floor(v.length / 2)], v[v.length - 1]];
};

console.log("surface points:", s.length);
console.log("  x [min, med, max]:", range((q) => q.p[0]).map((n) => n.toFixed(1)).join("  "));
console.log("  y [min, med, max]:", range((q) => q.p[1]).map((n) => n.toFixed(1)).join("  "));
console.log("  z [min, med, max]:", range((q) => q.p[2]).map((n) => n.toFixed(1)).join("  "));

// ── the centre line, in 4-unit z buckets ───────────────────────────────────
// For |y| < 3: how many points sit at that height, where the body's front-most
// surface is there, and how much of it faces forward (n[0] > 0.5) -- that last
// column is where a chest plate or a face grille lives.
const buckets = new Map();
for (const q of s) {
  if (Math.abs(q.p[1]) > 3) continue;
  const b = Math.floor(q.p[2] / 4) * 4;
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(q);
}
const med = (v) => (v.length ? v[Math.floor(v.length / 2)].toFixed(1) : "-");
console.log("\n  z-bucket    n   x(all,med)   x(front,med)   n(front)");
for (const [b, qs] of [...buckets].sort((a, x) => a[0] - x[0])) {
  const xs = qs.map((q) => q.p[0]).sort((a, x) => a - x);
  const front = qs.filter((q) => q.n[0] > 0.5).map((q) => q.p[0]).sort((a, x) => a - x);
  console.log(`  ${String(b).padStart(7)}  ${String(qs.length).padStart(4)}  ${med(xs).padStart(11)}  ${med(front).padStart(13)}  ${String(front.length).padStart(8)}`);
}

// ── the palette ────────────────────────────────────────────────────────────
// The sheet is 8-bit paletted: everything worn uses one of 256 entries. The
// saturated ones are the lights and the hazard stripes; the rest is the grey ramp
// the panels are drawn in.
const t = K.textureOf(src, "ed209_sheet0.bmp");
const flat = typeof t.palette[0] === "number";
const at = (i) => (flat ? [t.palette[i * 3] / 255, t.palette[i * 3 + 1] / 255, t.palette[i * 3 + 2] / 255]
                        : [t.palette[i][0] / 255, t.palette[i][1] / 255, t.palette[i][2] / 255]);
const N = flat ? t.palette.length / 3 : t.palette.length;
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

// how much of the sheet wears each entry
const used = new Array(N).fill(0);
for (const px of t.pixels) used[px]++;

console.log(`\npalette entries: ${N}   masked flag: ${t.flags & 64 ? "yes" : "no"}`);
console.log("\n  entry   r    g    b    lum    pixels used");
for (let i = 0; i < N; i++) {
  const c = at(i);
  const mx = Math.max(...c), mn = Math.min(...c);
  if (mx - mn > 0.08) {
    console.log(`  ${String(i).padStart(5)}  ${c[0].toFixed(2)} ${c[1].toFixed(2)} ${c[2].toFixed(2)}  ${lum(c).toFixed(2)}   ${String(used[i]).padStart(8)}`);
  }
}
console.log("\n  the ten most-used entries overall:");
for (const [i, n] of used.map((n, i) => [i, n]).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const c = at(i);
  console.log(`  ${String(i).padStart(5)}  ${c[0].toFixed(2)} ${c[1].toFixed(2)} ${c[2].toFixed(2)}  ${lum(c).toFixed(2)}   ${String(n).padStart(8)}`);
}

// ── the islands: every panel on the sheet, where it is in pixels and on the body ──
const isl = K.uvIslands(src, POSE);
const mine = isl.list.filter((e) => e.tex === "ed209_sheet0.bmp");
console.log(`\nislands on ed209_sheet0.bmp (${mine.length}):`);
console.log("    id  tris   box [x0 y0 x1 y1]              mid x y z             n x y z            bones");
for (const e of mine) {
  const f = (v) => v.map((n) => n.toFixed(1).padStart(6)).join(" ");
  const tris = Array.isArray(e.tris) ? e.tris.length : e.tris;
  console.log(`  ${String(e.id).padStart(4)}  ${String(tris).padStart(4)}   [${f(e.box)}]  ${f(e.mid)}   ${f(e.n)}  ${e.bones.slice(0, 3).join(",")}`);
}

// ── height and side bands, so a zone can be named by eye ───────────────────
// Every pixel takes the colour of the band its body position falls in: eight
// bands of z from red at the soles to magenta at the dome, eight of y from
// red at his right hand to magenta at his left.
const RAMP = [[1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0.4, 1], [0.6, 0, 1], [1, 0, 1]];
const band = (v, lo, hi) => RAMP[Math.min(7, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * 8)))];

const { mdl: byZ } = K.paint(src, ({ p }) => band(p[2], -36, 48), { pose: POSE });
savePng("mech_probe/bands_z.png", lineup([["z bands: red=soles .. magenta=dome", byZ]], { yaws: [0, 135], zoom: 1.6, width: 380, cols: 2 }));

const { mdl: byY } = K.paint(src, ({ p }) => band(p[1], -40, 40), { pose: POSE });
savePng("mech_probe/bands_y.png", lineup([["y bands: red=his right .. magenta=his left", byY]], { yaws: [0], zoom: 1.6, width: 380, cols: 1 }));

const { mdl, shared } = K.paint(src, ({ n, rgb }) => {
  if (n[0] > 0.5) return [1, 0.08, 0.08];    // faces towards +x
  if (n[0] < -0.5) return [0.08, 0.08, 1];   // faces towards -x
  return rgb;
}, { pose: POSE });

for (const [name, sh] of Object.entries(shared)) {
  console.log(`  ${name}: ${(sh * 100).toFixed(0)}% of its pixels are worn by two places at once`);
}

savePng("mech_probe/front_sign.png", lineup([["probe", mdl]], { yaws: [0, 90, 180], zoom: 1.6, width: 380, cols: 3 }));
console.log("wrote out/mech_probe/front_sign.png  (front, right side, back -- whichever is red faces +x)");
