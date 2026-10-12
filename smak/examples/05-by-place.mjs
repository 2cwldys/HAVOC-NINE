// A model changed by place: worn and struck where a point is on its body, whatever texture that falls on, and loose
// pieces of it taken off. For characters, monsters, vehicles: anything with more than one texture.
//
//   node examples/05-by-place.mjs <model.mdl> [output folder, default out] [--seq <animation to stand in>] [--drop 59,36]
//
// It prints the model's loose pieces first. Give some of their numbers to --drop to see the model without them.
// To look at the results turning and moving beside the original: `node bin/smak.mjs view <output folder> <model.mdl>`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { paint, surface, spot, pieces, dropTriangles, sequences, box, sub, check, lineup, png, workshop as W } from "../src/index.mjs";

const args = process.argv.slice(2), flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const seqArg = flag("seq"), dropArg = flag("drop"), [file, OUT = "out"] = args;
if (!file) { console.error("usage: node examples/05-by-place.mjs <model.mdl> [output folder] [--seq n] [--drop ids]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const src = readFileSync(file), name = basename(file).replace(/\.mdl$/i, "");
// the pose everything is measured in: an animation in which the model stands as it is usually seen
const seqs = sequences(src), idle = seqs.findIndex((s) => /idle/i.test(s.name)), pose = { seq: seqArg !== undefined ? (isNaN(seqArg) ? seqArg : Number(seqArg)) : idle >= 0 ? idle : seqs.length ? 0 : null, frame: 0 };
const clamp = (v) => Math.min(1, Math.max(0, v));

// ── 1. what it is made of ──
const P = pieces(src, pose);
console.log("  id  texture                 tris   middle (x y z)        size (x y z)");
for (const p of P.list.filter((x) => x.tris >= 6)) console.log(`${String(p.id).padStart(4)}  ${String(p.tex).padEnd(22)} ${String(p.tris).padStart(5)}   ${p.mid.join(" ").padEnd(20)}  ${p.mx.map((v, a) => (v - p.mn[a]).toFixed(1)).join(" ")}`);

// ── 2. worn by place: dirt from the ground up, soot in patches, and three strikes on its front ──
const surf = surface(src, pose), b = box(surf.map((s) => s.p)), tall = b.mx[2] - b.mn[2], wide = Math.max(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1]);
const mid = b.mn.map((v, a) => (v + b.mx[a]) / 2), k = 72 / Math.max(tall, wide);                 // noise sized to the model, as if it were a person
const strikes = [[0.15, 0.72], [-0.2, 0.6], [0.05, 0.45]].map(([y, z]) => spot(surf, [b.mx[0] + tall, mid[1] + y * wide, b.mn[2] + z * tall], [1, 0, 0])).filter(Boolean);
const R = tall * 0.012;
const { mdl: worn, shared } = paint(src, ({ p, n, rgb }) => {
  let c = rgb; const lum = (c[0] + c[1] + c[2]) / 3, zf = (p[2] - b.mn[2]) / tall;
  const dirt = clamp((clamp(1 - zf / 0.3) ** 1.4 * 0.9 + clamp(n[2]) * 0.2) * (0.4 + 1.2 * W.fbm3(p, 0.9 * k, 3)));
  c = W.mix(c, W.times([0.36, 0.31, 0.24], 0.55 + 0.9 * lum), dirt * 0.85);
  c = W.mix(c, [0.05, 0.045, 0.04], clamp((W.fbm3(p, 0.32 * k, 21, 3) - 0.6) * 5.5) * 0.9);
  for (const s of strikes) {
    const d = Math.hypot(...sub(p, s.p)) / R; if (d > 3) continue;
    c = W.mix(c, W.times(c, 0.35), clamp(1 - d / 3) * 0.6);                                     // a smudge
    if (d < 1.15) c = W.mix(c, [0.7, 0.71, 0.72], W.step(1.15, 0.75, d) * 0.85);                // a ring of bare stuff
    if (d < 0.62) c = W.mix(c, [0.02, 0.02, 0.02], W.step(0.62, 0.42, d));                      // the hole
  }
  return c;
}, { pose });
const mirrored = Object.entries(shared).filter(([, v]) => v > 0.05).map(([t, v]) => `${t} ${Math.round(v * 100)}%`);
if (mirrored.length) console.log(`\nworn by two places of the body at once (a mark on one shows on the other): ${mirrored.join(", ")}`);

// ── 3. pieces taken off ──
const list = [["as it was", src], ["worn", worn]], ids = (dropArg ?? "").split(",").filter(Boolean).map(Number);
writeFileSync(join(OUT, `${name}_worn.mdl`), worn);
if (ids.length) {
  const { mdl, gone } = dropTriangles(src, (t) => ids.includes(P.of(t)), pose);
  writeFileSync(join(OUT, `${name}_stripped.mdl`), mdl); list.push([`without ${ids.join(" ")}`, mdl]); console.log(`\n${gone} triangles taken off`);
}
for (const [label, mdl] of list.slice(1)) { const r = check(mdl); console.log(`${label}: ${r.errors.length ? r.errors.join("; ") : "fit for goldsrc"}`); }
const img = lineup(list, pose);
writeFileSync(join(OUT, `${name}_by_place.png`), png(img.width, img.height, img.rgba));
console.log(`\n${join(OUT, `${name}_by_place.png`)}: look at it. A piece that left a gap is part of the body, not gear on it.`);
