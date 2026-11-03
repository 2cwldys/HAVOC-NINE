// spots.mjs: views of the things a build changed, found in the map it wrote: doors of each picture, the litter,
// the radios, the stair halls' arches. Each is looked at from the open side, at a player's eye height.
//
//   node spots.mjs <set>        into out\renders\<set>-spots
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";
import { readAnyBsp } from "./bsp2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = "h9_tsrp_newbyzantium";
const set = process.argv[2] ?? "latest";
const dir = join(HERE, "out", "renders", `${set}-spots`);
mkdirSync(dir, { recursive: true });
const bsp = readAnyBsp(readFileSync(join(HERE, "out", `${NAME}.bsp`)));
const map = M.readMap(readFileSync(join(HERE, "out", `${NAME}.map`), "utf8"));
const folders = [join(HERE, "..", "out"), join(GAME_DIR, "ts"), join(HERE, "..", "..", "H9XASH", "ts"), join(HERE, "..", "..", "H9XASH", "valve")];
const open = (p) => {
  const leaf = M.leafAt(bsp, p);
  return bsp.leaves[leaf]?.contents === -1;
};
let n = 0;
const shot = (label, from, to) => {
  try {
    const img = M.drawMap(bsp, { from, to, width: 800, height: 480, brightness: from[2] < -100 ? 3 : 1.8, folders, entities: "game", labels: false, models: true });
    writeFileSync(join(dir, `${String(++n).padStart(2, "0")}-${label}.png`), K.png(img.width, img.height, img.rgba));
  } catch (e) {
    console.log(`  ${label}: FAILED -- ${e.message}`);
  }
};
/** A view of a box from whichever side of it is open, `back` units off, at eye height over its floor. */
const lookAt = (label, min, max, back = 176) => {
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2] + 56];
  const thinX = max[0] - min[0] < max[1] - min[1];
  const ways = thinX ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  for (const [dx, dy] of ways) {
    const eye = [c[0] + dx * back, c[1] + dy * back, min[2] + 64];
    if (open(eye)) shot(label, eye, c);
  }
};
const shapeOf = (e) => {
  const s = e.brushes.map((b) => M.shapeOf(b));
  return [[0, 1, 2].map((i) => Math.min(...s.map((x) => x.min[i]))), [0, 1, 2].map((i) => Math.max(...s.map((x) => x.max[i])))];
};
// doors: a few of each picture, the first at street level under the upper city where there is one
const doors = map.entities.filter((e) => /^func_door$/.test(e.classname));
const byPic = new Map();
for (const e of doors) {
  const pic = e.brushes[0].faces.map((f) => f.texture).find((t) => !/^(metal5|wooddark|MJSTTRIM01)$/i.test(t)) ?? e.brushes[0].faces[0].texture;
  if (!byPic.has(pic)) byPic.set(pic, []);
  byPic.get(pic).push(shapeOf(e));
}
for (const [pic, list] of byPic) {
  list.sort((a, b) => Math.max(Math.abs(a[0][0]), Math.abs(a[0][1])) - Math.max(Math.abs(b[0][0]), Math.abs(b[0][1])));
  for (const [min, max] of list.slice(0, 2)) lookAt(`door-${pic.replace(/[{]/g, "")}`, min, max);
}
// litter and radios
const props = map.entities.filter((e) => e.classname === "ts_model").map((e) => ({ model: e.model, at: e.origin.split(" ").map(Number) }));
for (const want of ["qk_trash", "re_dirt", "xen_trashcanb", "GPC_PALLETS", "cg_box03", "cg_radio01", "grammo"]) {
  const list = props.filter((p) => p.model.includes(want)).slice(0, 2);
  for (const p of list) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7]]) {
      const eye = [p.at[0] + dx * 192, p.at[1] + dy * 192, p.at[2] + 72];
      if (open(eye) && open([p.at[0] + dx * 96, p.at[1] + dy * 96, p.at[2] + 48])) {
        shot(`prop-${want}`, eye, [p.at[0], p.at[1], p.at[2] + 16]);
        break;
      }
    }
  }
}
console.log(`  ${n} views in ${dir}`);
