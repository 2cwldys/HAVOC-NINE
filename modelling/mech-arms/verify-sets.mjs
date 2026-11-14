// A check of the side sets: only the band zone may differ between them, and the band's flat colour must be the side's own.
//   node verify-sets.mjs <models/matchmode folder of a game folder> <weapon: mechminigun|mechrocket>
import { readFileSync, existsSync } from "node:fs";
import { K } from "./common.mjs";
import { zones as mgZones } from "./minigun.mjs";
import { sameGeometry } from "./check-solid.mjs";

const [dir, weapon] = process.argv.slice(2);
const Z = mgZones(512).BAND;
const rgbOf = (mdl) => {
  const t = K.textureOf(mdl, 0);
  return { w: t.width, h: t.height, at: (x, y) => { const i = t.pixels[y * t.width + x]; return [t.palette[i * 3], t.palette[i * 3 + 1], t.palette[i * 3 + 2]]; } };
};
const fileOf = (s) => (existsSync(`${dir}/${s}/h9/v_${weapon}.mdl`) ? `${dir}/${s}/h9/v_${weapon}.mdl` : `${dir}/${s}/v_${weapon}.mdl`);
const sets = Object.fromEntries(["msr", "insurgent", "default"].map((s) => [s, rgbOf(readFileSync(fileOf(s)))]));
const near = (a, b, t = 18) => a.every((v, i) => Math.abs(v - b[i]) <= t);
for (const [name, want] of [["msr", [60, 120, 255]], ["insurgent", [80, 200, 90]]]) {
  const got = sets[name].at(Z.x + 12, Z.y + 60);
  console.log(`${name}: band centre ${got.join(",")} wanted ${want.join(",")} ${near(got, want) ? "OK" : "OFF"}`);
}
const d = sets.default.at(Z.x + 12, Z.y + 60), d2 = sets.default.at(Z.x + 12, Z.y + 70);
console.log(`default: band pixels ${d.join(",")} / ${d2.join(",")} (hazard yellow and black)`);
for (const [a, b] of [["msr", "default"], ["insurgent", "default"]]) {
  let n = 0, outside = 0, box = [1e9, 1e9, -1, -1];
  for (let y = 0; y < sets[a].h; y++) for (let x = 0; x < sets[a].w; x++) {
    const p = sets[a].at(x, y), q = sets[b].at(x, y);
    if (!near(p, q, 3)) {
      n++;
      box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      if (x < Z.x - 1 || x > Z.x + Z.w || y < Z.y - 1 || y > Z.y + Z.h) outside++;
    }
  }
  console.log(`${a} vs ${b}: ${n} pixels differ, ${outside} outside the band zone, box ${box.join(",")}`);
}
// the sets are one shape with three pictures: everything in the file before the picture's pixels is the same
for (const s of ["msr", "insurgent"]) {
  const differs = sameGeometry(readFileSync(fileOf("default")), readFileSync(fileOf(s)));
  console.log(`${s} vs default: same shape, only the picture differs: ${differs ? `NO, ${differs}` : "yes"}`);
  if (differs) process.exitCode = 1;
}
