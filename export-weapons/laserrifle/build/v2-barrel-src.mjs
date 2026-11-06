import { readFileSync, writeFileSync } from "node:fs";
import { readFbx, importModel, render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const pick = (process.argv[2] ?? "Barrel").split(",");
const groups = scene.groups.filter((g) => pick.includes(g.material));
// a light grey flat picture so the shape reads
const rgb = new Uint8Array(64 * 64 * 3).fill(190);
const one = { ...scene, groups: groups.map((g) => ({ ...g, material: "laser", tris: g.tris.map((tri) => tri.map((c) => ({ ...c, uv: [0.5, 0.5] }))) })) };
const { mdl } = importModel(one, { name: "x.mdl", pictures: { laser: { width: 64, height: 64, rgb } }, fit: 30, origin: "base", turn: 180, maxTextureSize: 64 });
for (const [name, yaw, pitch] of [["fl", 35, 20], ["left", 90, 0], ["top", 90, 80], ["front", 0, 5]]) {
  const img = render(mdl, { view: "orbit", yaw, pitch, zoom: 1.0, width: 900, height: 520 });
  writeFileSync(`D:/temp/lr/bsrc_${pick[0]}_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok", groups.map((g) => g.material + ":" + g.tris.length));
