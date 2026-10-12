// A model made from nothing: a banded wooden crate with a lid that opens, written as a .mdl, checked and drawn.
// It needs no game files:   node examples/01-new-model.mjs [output folder, default out]
//
// The pattern is the one every new model follows:
//   1. a sheet to paint the texture on and a shape to build the triangles with (src/workshop.mjs)
//   2. the picture cut to 256 colours (indexed)
//   3. buildMdl: bones, bodyparts, animations
//   4. check, then look at it (sheet, strip) before it goes near a game
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildMdl, indexed, check, sheet, strip, png, workshop } from "../src/index.mjs";

const OUT = process.argv[2] ?? "out";
mkdirSync(OUT, { recursive: true });
const { wood, iron, rivet, times, bell } = workshop;

// ── the picture: 128x64, a plank face on the left, the banded edge of the lid on the right ──
const S = workshop.sheet(128, 64), M = workshop.shape(128, 64);
const FACE = { x: 0, y: 0, w: 64, h: 64 }, RIM = { x: 64, y: 0, w: 64, h: 16 };
S.zone(FACE, (u, v) => {
  // four planks, darker in the gaps between them, an iron band round the edge with a rivet in each corner
  const plank = Math.floor(v / 16), gap = bell((v % 16) - 0.5, 1.2), edge = Math.min(u, v, 63 - u, 63 - v);
  let c = times(wood(u / 6, v / 6 + plank * 3, 1, 7 + plank), 1 - 0.55 * gap);
  if (edge < 7) c = iron(u / 8, v / 8, 1.1 - 0.25 * bell(edge - 6.5, 1), 3);
  for (const [cx, cy] of [[4, 4], [59, 4], [4, 59], [59, 59]]) { const r = rivet(u, v, cx, cy, 2.2); if (r?.light) c = times(iron(u, v, 1, 5), 1.6 * r.light); else if (r?.shadow) c = times(c, 1 - r.shadow); }
  return c;
}, 0);
S.zone(RIM, (u, v) => iron(u / 8, v / 4, 1.15 - 0.3 * bell(v - 8, 6), 9), 0);

// ── the shape: a box of 24 units, its lid a part of its own (part 1) so that it can go on a bone of its own ──
const SIZE = 24, H = 18, LID = 3, h = SIZE / 2;
const corner = (p, t, part) => M.V(p, t, part);
/** A flat face from four points given clockwise or not: the shape builder turns it to face away from `inside`. */
const face = (pts, zone, inside, part = 0) => M.quad(...pts.map((p, i) => corner(p, [zone.x + [0, zone.w, zone.w, 0][i], zone.y + [0, 0, zone.h, zone.h][i]], part)), inside);
const box = (z0, z1, sideZone, part) => {
  const mid = [0, 0, (z0 + z1) / 2];
  for (const [a, b] of [[[-h, -h], [h, -h]], [[h, -h], [h, h]], [[h, h], [-h, h]], [[-h, h], [-h, -h]]]) face([[...a, z1], [...b, z1], [...b, z0], [...a, z0]], sideZone, mid, part);
  face([[-h, -h, z1], [h, -h, z1], [h, h, z1], [-h, h, z1]], FACE, mid, part);
  face([[-h, -h, z0], [h, -h, z0], [h, h, z0], [-h, h, z0]], FACE, mid, part);
};
box(0, H, FACE, 0);
box(H, H + LID, RIM, 1);

// ── the model: two bones (the lid hinges on the back edge, +x being the front) and two animations ──
const bones = [{ name: "crate", parent: -1 }, { name: "lid", parent: 0, pos: [-h, 0, H] }];
const tris = M.tris.map((t) => t.map((c) => ({ ...c, bone: c.part ? "lid" : "crate" })));
const lidAt = (angle) => [[0, 0, 0, 0, 0, 0], [-h, 0, H, 0, angle, 0]];   // for each bone: x y z, then the turn about x y z
const open = Array.from({ length: 16 }, (_, f) => lidAt(-1.9 * (0.5 - 0.5 * Math.cos(Math.PI * f / 15))));
const mdl = buildMdl({
  name: "crate.mdl", bones,
  bodyparts: [{ name: "body", models: [{ name: "crate", meshes: [{ tris, texture: indexed(S.image(), "crate.bmp") }] }] }],
  sequences: [{ name: "idle", fps: 10, loops: true, frames: [lidAt(0)] }, { name: "open", fps: 20, loops: false, frames: open }],
});

const report = check(mdl, "goldsrc");
for (const line of [...report.facts, ...report.warnings.map((w) => `WARN ${w}`), ...report.errors.map((e) => `ERROR ${e}`)]) console.log(line);
if (report.errors.length) process.exit(1);
writeFileSync(join(OUT, "crate.mdl"), mdl);
const views = sheet(mdl, { seq: "open", frame: 15 }), anim = strip(mdl, { seq: "open", count: 4, yaw: 60, pitch: 25 });
writeFileSync(join(OUT, "crate_sheet.png"), png(views.width, views.height, views.rgba));
writeFileSync(join(OUT, "crate_open.png"), png(anim.width, anim.height, anim.rgba));
console.log(`${join(OUT, "crate.mdl")} (${mdl.length} bytes), crate_sheet.png, crate_open.png`);
