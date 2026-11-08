// The Combat Engineer's transporter pads, made with SMAK: models/tsm_tpad_1.mdl (MSR, blue) and models/tsm_tpad_2.mdl
// (Insurgent, red). A flat square pad 64 units across and 6 high, a dark metal plate with a ring and a cross of the side's
// light on its top and a stripe of it round the edge. One bone, one idle sequence; the plugin clips it with its own box.
//
//   node modelling/make-transporter.mjs [output folder, default models]     (needs the smak folder beside modelling)
//
// It writes tsm_tpad_1.mdl, tsm_tpad_2.mdl and, in out/, a sheet of views to look at before the pads go near the game.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMdl, indexed, check, sheet, png, workshop } from "../smak/src/index.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const OUT = process.argv[2] ?? join(HERE, "..", "models");
mkdirSync(OUT, { recursive: true });
mkdirSync(join(HERE, "out"), { recursive: true });

const SIDES = [
  { n: 1, light: [0.0, 0.67, 1.0] }, // MSR: the same blue as the side's x-ray glow
  { n: 2, light: [1.0, 0.24, 0.24] }, // Insurgent: red
];
const HALF = 32;
const HEIGHT = 6;

const FACE = { x: 0, y: 0, w: 64, h: 64 };
const EDGE = { x: 64, y: 0, w: 64, h: 16 };

for (const side of SIDES) {
  const canvas = workshop.sheet(128, 64);
  const mesh = workshop.shape(128, 64);
  const [lr, lg, lb] = side.light;
  const times = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
  canvas.zone(
    FACE,
    (u, v) => {
      const dx = u - 31.5;
      const dy = v - 31.5;
      const d = Math.hypot(dx, dy);
      // dark plate with a faint grid of panel seams
      const seam = u % 16 < 1 || v % 16 < 1 ? 0.7 : 1;
      let c = [0.16 * seam, 0.18 * seam, 0.2 * seam];
      // a glowing disc fading out from the middle, a bright ring, and a cross through the middle
      if (d < 20) c = times([lr, lg, lb], 0.18 + 0.32 * (1 - d / 20));
      if (d > 21 && d < 26) c = [lr, lg, lb];
      if (Math.abs(dx) < 1.6 || Math.abs(dy) < 1.6) if (d < 20) c = times([lr, lg, lb], 0.85);
      const fromEdge = Math.min(u, v, 63 - u, 63 - v);
      if (fromEdge < 3) c = times([lr, lg, lb], 0.7);
      return c;
    },
    0,
  );
  canvas.zone(EDGE, (u, v) => (v > 5 && v < 11 ? times([lr, lg, lb], 0.8) : [0.12, 0.13, 0.15]), 0);

  const face = (points, zone, inside) =>
    mesh.quad(...points.map((p, i) => mesh.V(p, [zone.x + [0, zone.w, zone.w, 0][i], zone.y + [0, 0, zone.h, zone.h][i]], 0)), inside);
  const middle = [0, 0, HEIGHT / 2];
  for (const [from, to] of [
    [[-HALF, -HALF], [HALF, -HALF]],
    [[HALF, -HALF], [HALF, HALF]],
    [[HALF, HALF], [-HALF, HALF]],
    [[-HALF, HALF], [-HALF, -HALF]],
  ])
    face([[...from, HEIGHT], [...to, HEIGHT], [...to, 0], [...from, 0]], EDGE, middle);
  face([[-HALF, -HALF, HEIGHT], [HALF, -HALF, HEIGHT], [HALF, HALF, HEIGHT], [-HALF, HALF, HEIGHT]], FACE, middle);
  face([[-HALF, -HALF, 0], [HALF, -HALF, 0], [HALF, HALF, 0], [-HALF, HALF, 0]], FACE, middle);

  const name = `tsm_tpad_${side.n}`;
  const mdl = buildMdl({
    name: `${name}.mdl`,
    bodyparts: [
      { name: "body", models: [{ name, meshes: [{ tris: mesh.tris.map((t) => t.map((p) => ({ ...p }))), texture: indexed(canvas.image(), `${name}.bmp`) }] }] },
    ],
  });
  const report = check(mdl, "goldsrc");
  for (const line of [...report.facts, ...report.warnings.map((w) => `WARN ${w}`), ...report.errors.map((e) => `ERROR ${e}`)]) console.log(line);
  if (report.errors.length) process.exit(1);
  writeFileSync(join(OUT, `${name}.mdl`), mdl);
  const views = sheet(mdl, {});
  writeFileSync(join(HERE, "out", `${name}_sheet.png`), png(views.width, views.height, views.rgba));
  console.log(`${join(OUT, name + ".mdl")} (${mdl.length} bytes)`);
}
