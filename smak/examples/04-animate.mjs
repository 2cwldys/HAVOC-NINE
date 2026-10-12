// A model's animations read as numbers, changed, and written back: one replaced where it stands, one added after
// the others, with a sound set off on one of its frames.
//
//   node examples/04-animate.mjs <model.mdl> [animation name or number, default 0] [bone name, default the first with a parent] [output folder, default out]
//
// A frame is, for every bone, six numbers: where it is from its parent (x, y, z) and how it is turned about x, y and
// z (radians). So an animation is frames[frame][bone][0..5], and making one is arithmetic on those numbers.
// The game asks for a weapon's animations by NUMBER, in the order `smak info` lists them: replace one where it is,
// or add after the last; never reorder.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { readSequence, replaceSequence, addSequence, bones, sequences, events, check, strip, png } from "../src/index.mjs";

const [file, seq = "0", boneName, OUT = "out"] = process.argv.slice(2);
if (!file) { console.error("usage: node examples/04-animate.mjs <model.mdl> [animation] [bone] [output folder]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const src = readFileSync(file), which = /^\d+$/.test(seq) ? Number(seq) : seq, all = bones(src);
const b = boneName ? all.findIndex((x) => x.name === boneName) : all.findIndex((x) => x.parent >= 0);
if (b < 0) { console.error(`no bone ${boneName}: it has ${all.map((x) => x.name).join(", ")}`); process.exit(1); }
const old = readSequence(src, which);
console.log(`${old.name}: ${old.frames.length} frames at ${old.fps} fps; moving the bone ${all[b].name}`);

// ── replaced where it stands: the same motion at half the speed, eased in and out ──
// (frames in between are mixed number by number, which is right for the small turn between two neighbours)
const at = (frames, t) => { const i = Math.min(frames.length - 1, Math.floor(t)), j = Math.min(frames.length - 1, i + 1), k = t - i; return frames[i].map((v, n) => v.map((x, c) => x + (frames[j][n][c] - x) * k)); };
const ease = (u) => u * u * (3 - 2 * u), N = Math.max(2, old.frames.length * 2 - 1);
const slow = Array.from({ length: N }, (_, f) => at(old.frames, ease(f / (N - 1)) * (old.frames.length - 1)));
let mdl = replaceSequence(src, which, { frames: slow });

// ── added after the others: one bone swung through a sine on top of the animation's first frame ──
const base = old.frames[0], swing = Array.from({ length: 31 }, (_, f) => base.map((v, n) => (n === b ? [v[0], v[1], v[2], v[3], v[4] + 0.35 * Math.sin(2 * Math.PI * f / 30), v[5]] : v)));
mdl = addSequence(mdl, { name: "smak_swing", fps: 30, loops: true, frames: swing, events: [{ frame: 15, event: 5004, options: "weapons/swing.wav" }] });

const r = check(mdl); if (r.errors.length) { console.error(r.errors.join("\n")); process.exit(1); }
const to = join(OUT, `${basename(file, ".mdl")}_animated.mdl`);
writeFileSync(to, mdl);
const list = sequences(mdl), added = list.length - 1;
console.log(`${to}: animation ${old.index} "${old.name}" now ${list[old.index].frames} frames; animation ${added} "${list[added].name}" added, with ${events(mdl, added).length} event`);
for (const [name, o] of [["animate_replaced", { seq: old.index }], ["animate_added", { seq: added }]]) {
  const img = strip(mdl, { ...o, count: 8, view: process.env.VIEW, body: Number(process.env.BODY ?? 0) });
  writeFileSync(join(OUT, `${name}.png`), png(img.width, img.height, img.rgba));
}
console.log(`${OUT}: animate_replaced.png, animate_added.png`);
