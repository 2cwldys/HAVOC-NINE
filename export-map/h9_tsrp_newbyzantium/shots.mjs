// shots.mjs: the compiled city drawn from inside, the same places every time, so a build can be judged
// against the one before it.
//
//   node shots.mjs <set>                    the standard places into out\renders\<set>
//   node shots.mjs <set> ring x y z [r]     eight views round a point, one from above, one from below
//   node shots.mjs <set> at name fx fy fz tx ty tz   one view from a point towards another
//
// It reads the full city (Xash BSP2) through bsp2.mjs, with the map's own lightmaps, so a picture is what a
// player sees. The undercity is drawn brighter, or nothing could be judged in it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";
import { readAnyBsp } from "./bsp2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = "h9_tsrp_newbyzantium";
const [set = "latest", mode, ...rest] = process.argv.slice(2);
const dir = join(HERE, "out", "renders", set);
mkdirSync(dir, { recursive: true });
const bsp = readAnyBsp(readFileSync(join(HERE, "out", `${NAME}.bsp`)));
const folders = [join(HERE, "..", "out"), join(GAME_DIR, "ts"), join(HERE, "..", "..", "H9XASH", "ts"), join(HERE, "..", "..", "H9XASH", "valve")];

let n = 0;
function shot(label, from, to, brightness = from[2] < -100 ? 3 : 1.8) {
  try {
    const img = M.drawMap(bsp, { from, to, width: 800, height: 480, brightness, folders, entities: "game", labels: false });
    const file = join(dir, `${String(++n).padStart(2, "0")}-${label}.png`);
    writeFileSync(file, K.png(img.width, img.height, img.rgba));
    console.log(`  ${file}`);
  } catch (e) {
    console.log(`  ${label}: FAILED -- ${e.message}`);
  }
}

/** The places the user has walked and named, and one or two in every district, at a player's height. */
export const PLACES = [
  ["nexus-doors", [0, -760, 420], [0, 0, 500]],
  ["nexus-hall", [0, -380, 420], [0, 150, 440]],
  ["nexus-hall-up", [-250, -250, 400], [0, 0, 1100]],
  ["well-steps", [0, -1600, 120], [0, 0, 700]],
  ["well-floor", [-1300, -1300, 120], [0, 0, 600]],
  ["mese", [-1800, 1870, 1126], [1200, 1870, 1216]],
  ["mese-floor", [-1800, 1870, 1200], [-1100, 1870, 1056]],
  ["upper-bridge", [0, 1500, 1126], [0, 500, 1196]],
  ["basilica", [1888, -2650, 1116], [1888, -3400, 1456]],
  ["ministry", [-3360, -1888, 1116], [-3800, -1888, 1150]],
  ["ward-ring", [-1792, -1700, 764], [-1792, 1200, 764]],
  ["avenue-n", [0, 1800, 60], [0, 4000, 220]],
  ["avenue-gallery", [150, 2600, 236], [150, 4200, 300]],
  ["ascent-n", [400, 2100, 60], [400, 2500, 700]],
  ["under-mese-door-a", [1872, -1000, 60], [1872, -1192, 80]],
  ["under-mese-door-b", [2000, 1360, 60], [2168, 1360, 80]],
  ["under-mese-street", [1900, 1300, 60], [1900, 2400, 100]],
  ["precinct-lobby-n", [-300, 2600, 60], [-650, 2800, 60]],
  ["stacks-well", [-672, 3600, 40], [-672, 4300, 1400]],
  ["stacks-street", [-2000, 2592, 60], [-3000, 2592, 100]],
  ["heights-garden", [3700, 4000, 60], [4400, 4600, 300]],
  ["heights-street", [2000, 2592, 60], [3000, 2592, 100]],
  ["bazaar-hall", [3500, -600, 60], [4600, -600, 120]],
  ["infirmary-street", [2600, -2560, 60], [3600, -2560, 100]],
  ["gate-avenue", [0, -2500, 60], [0, -4500, 200]],
  ["foundry-hall", [-3500, -3500, 60], [-4600, -4600, 200]],
  ["works-street", [-2272, -1000, 60], [-2272, 1000, 100]],
  ["rookery-hall", [-3700, 3600, 50], [-4400, 4300, 500]],
  ["ring-road", [-3200, -2000, 60], [-3200, 1000, 100]],
  ["ringplaza-n", [0, 3000, 60], [0, 3450, 60]],
  ["sewer-main", [0, 2000, -644], [0, 4000, -644]],
  ["sewer-ring", [-3200, 0, -644], [-3200, 2000, -644]],
  ["cistern", [-1400, -1400, -800], [400, 400, -760]],
  ["canal", [-2600, -6200, 120], [800, -7000, 60]],
  ["south-gate", [0, -5000, 60], [0, -6500, 200]],
];

if (mode === "ring") {
  const [x, y, z, r = 384] = rest.map(Number);
  const ways = [["n", 0, 1], ["ne", 0.7, 0.7], ["e", 1, 0], ["se", 0.7, -0.7], ["s", 0, -1], ["sw", -0.7, -0.7], ["w", -1, 0], ["nw", -0.7, 0.7]];
  for (const [w, dx, dy] of ways) shot(`ring-${w}`, [x + dx * r, y + dy * r, z + 96], [x, y, z]);
  shot("ring-above", [x, y, z + r], [x + 1, y, z]);
  shot("ring-below", [x, y, z - r * 0.6], [x + 1, y, z]);
} else if (mode === "at") {
  const [label, ...v] = rest;
  const p = v.map(Number);
  shot(label, p.slice(0, 3), p.slice(3, 6));
} else {
  for (const [label, from, to] of PLACES) shot(label, from, to);
}
console.log(`  ${n} views in ${dir}`);
