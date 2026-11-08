// The transporter pads' direction arrows, made with SMAK: models/tsm_tpad_arrow_1.mdl (MSR, blue) and tsm_tpad_arrow_2.mdl
// (Insurgent, red). Three flat chevrons lying 7 units above the floor (on the pad's top), their tips toward +X, that run toward
// the tip and start again: the plugin turns the model by the yaw from one pad to the other, so the chevrons always run to it.
//
//   node modelling/make-transporter-arrow.mjs [output folder, default models]     (needs the smak folder beside modelling)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMdl, indexed, check, sheet, png, workshop } from "../smak/src/index.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const OUT = process.argv[2] ?? join(HERE, "..", "models");
mkdirSync(OUT, { recursive: true });
mkdirSync(join(HERE, "out"), { recursive: true });

const SIDES = [
  { n: 1, light: [0.0, 0.67, 1.0] },
  { n: 2, light: [1.0, 0.24, 0.24] },
];
const Z = 7; // just above the pad's top (6)
const SPACING = 16;
const CHEVRONS = 3;
const FRAMES = 12;

for (const side of SIDES) {
  const canvas = workshop.sheet(16, 16);
  const mesh = workshop.shape(16, 16);
  canvas.zone({ x: 0, y: 0, w: 16, h: 16 }, () => side.light, 0);
  const V = (x, y) => mesh.V([x, y, Z], [8, 8], 0);
  const middle = [0, 0, 0];
  // a bar from a to b, 2.5 units either side of its line
  const bar = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const nx = (-dy / len) * 2.5;
    const ny = (dx / len) * 2.5;
    mesh.quad(V(a[0] + nx, a[1] + ny), V(b[0] + nx, b[1] + ny), V(b[0] - nx, b[1] - ny), V(a[0] - nx, a[1] - ny), middle);
  };
  const bones = [];
  for (let i = 0; i < CHEVRONS; i++) {
    const cx = -SPACING + i * SPACING;
    const before = mesh.tris.length;
    bar([cx - 8, -14], [cx + 6, 0]);
    bar([cx + 6, 0], [cx - 8, 14]);
    for (let t = before; t < mesh.tris.length; t++) mesh.tris[t] = mesh.tris[t].map((p) => ({ ...p, bone: `chev${i}` }));
    bones.push({ name: `chev${i}`, parent: -1 });
  }
  const frame = (f) => bones.map(() => [(SPACING * f) / FRAMES, 0, 0, 0, 0, 0]);
  const name = `tsm_tpad_arrow_${side.n}`;
  const mdl = buildMdl({
    name: `${name}.mdl`,
    bones,
    bodyparts: [{ name: "body", models: [{ name, meshes: [{ tris: mesh.tris, texture: indexed(canvas.image(), `${name}.bmp`) }] }] }],
    sequences: [{ name: "run", fps: 10, loops: true, frames: Array.from({ length: FRAMES }, (_, f) => frame(f)) }],
  });
  const report = check(mdl, "goldsrc");
  for (const line of [...report.facts, ...report.warnings.map((w) => `WARN ${w}`), ...report.errors.map((e) => `ERROR ${e}`)]) console.log(line);
  if (report.errors.length) process.exit(1);
  writeFileSync(join(OUT, `${name}.mdl`), mdl);
  const views = sheet(mdl, { seq: "run", frame: 0 });
  writeFileSync(join(HERE, "out", `${name}_sheet.png`), png(views.width, views.height, views.rgba));
  console.log(`${join(OUT, name + ".mdl")} (${mdl.length} bytes)`);
}
