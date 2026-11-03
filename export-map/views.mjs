// Look at the map. Lots of angles, not one.
//
//     node views.mjs                        the standard sweep: every level, every landmark
//     node views.mjs 1600 -20 -400          a ring of views around one point
//     node views.mjs 1600 -20 -400 320      the same, at a radius of 320
//
// WHY THIS EXISTS. Geometry faults in this map have been found by the person playing it and missed
// by every numeric check written here -- a staircase whose foot does not meet the floor, a pane
// resting on air, two stairwells sharing one hole. A probe answers the question it was asked;
// a picture shows the question you did not think to ask.
//
// So: render before changing anything, render after, and look at both. drawMap uses the map's own
// lightmaps, so what comes out is what a player sees, not a wireframe.
//
// Output goes to out/views/ as .png, named so they sort into a sensible order.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { K, M, OUT, MAP_NAME } from "./lib.mjs";

const W = 760;
const H = 560;
const BRIGHT = 3.0;   // the undercity is nearly black at 1.0 and nothing can be judged in it

const bsp = M.readBsp(readFileSync(join(OUT, `${MAP_NAME}.bsp`)));
const dir = join(OUT, "views");
try {
  rmSync(dir, { recursive: true });
} catch {}
mkdirSync(dir, { recursive: true });

let n = 0;
const shot = (name, from, to) => {
  try {
    const img = M.drawMap(bsp, { from, to, width: W, height: H, brightness: BRIGHT });
    const file = join(dir, `${String(++n).padStart(2, "0")}-${name}.png`);
    writeFileSync(file, K.png(img.width, img.height, img.rgba));
    console.log(`  ${file}`);
  } catch (e) {
    console.log(`  ${name}: FAILED -- ${e.message}`);
  }
};

/** Eight views around a point, looking in at it, plus one from above and one from below. */
const ring = (label, at, radius = 384, rise = 96) => {
  const [x, y, z] = at;
  const ways = [
    ["n", 0, 1], ["ne", 0.7, 0.7], ["e", 1, 0], ["se", 0.7, -0.7],
    ["s", 0, -1], ["sw", -0.7, -0.7], ["w", -1, 0], ["nw", -0.7, 0.7],
  ];
  for (const [name, dx, dy] of ways) {
    shot(`${label}-from-${name}`, [x + dx * radius, y + dy * radius, z + rise], [x, y, z]);
  }
  shot(`${label}-from-above`, [x, y, z + radius], [x, y, z]);
  shot(`${label}-from-below`, [x, y, z - radius * 0.6], [x, y, z]);
};

const arg = process.argv.slice(2).map(Number);
if (arg.length >= 3 && arg.every(Number.isFinite)) {
  ring("spot", [arg[0], arg[1], arg[2]], arg[3] ?? 384);
  console.log(`\n  ${n} view(s) of ${arg.slice(0, 3)} in ${dir}\n`);
} else {
  /*
   * THE STANDARD SWEEP: the places this map has gone wrong before, at the height a player is at.
   *
   * Each is a landmark rather than a coordinate nobody will recognise, so a picture can be matched
   * to what somebody describes in words. Add to this whenever a new fault turns up somewhere that
   * was not being looked at.
   */
  const PLACES = [
    ["city-centre", [1600, 300, 64]],
    ["shaft-west", [944, -24, -64]],
    ["shaft-centre", [1640, -24, -64]],
    ["shaft-east", [2336, -24, -64]],
    ["shaft-centre-foot", [1600, -20, -440]],
    ["undercity-spine", [1600, -600, -440]],
    ["treatment-pit", [1600, 1500, -440]],
    ["shanty-middle", [1600, -600, -1010]],
    ["shanty-well-north", [1616, 616, -1010]],
    ["nexus-steps", [1600, 2200, 64]],
    ["nexus-hall", [1600, 2600, 300]],
    ["west-hall", [-640, 0, 64]],
    ["east-hall", [3576, 0, 64]],
    ["dome-roof", [1600, 300, 1100]],
  ];
  for (const [label, at] of PLACES) ring(label, at);
  console.log(`\n  ${n} view(s) in ${dir}\n`);
}
