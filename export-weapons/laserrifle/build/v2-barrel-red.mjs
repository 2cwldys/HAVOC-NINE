import { readFileSync, writeFileSync } from "node:fs";
import { readFbx, importModel, render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const data = JSON.parse(readFileSync("D:/Downloads/TSM/laserrifle/out2/gun.json", "utf8"));
const lod = process.argv[2] ?? "v";
const mat = process.argv[3] ?? "Barrel";
const tris = data.lods[lod].tris.filter((t) => t[0].mat === mat);
console.log("tris", tris.length);
// importModel wants a scene; borrow the FBX scene shell and give it our groups; our coordinates are already in game space
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const rgb = new Uint8Array(64 * 64 * 3).fill(190);
const one = { ...scene, groups: [{ object: "x", group: "x", material: "laser", tris: tris.map((tri) => tri.map((c) => ({ p: [-c.p[0], -c.p[1], c.p[2]], uv: [0.5, 0.5], n: [0, 0, 1] }))) }] };
const { mdl } = importModel(one, { name: "x.mdl", pictures: { laser: { width: 64, height: 64, rgb } }, fit: 30, origin: "base", turn: 180, maxTextureSize: 64 });
for (const [name, yaw, pitch] of [["fl", 35, 20], ["left", 90, 0]]) {
  const img = render(mdl, { view: "orbit", yaw, pitch, zoom: 1.0, width: 900, height: 520 });
  writeFileSync(`D:/temp/lr/bred_${mat}_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok");
