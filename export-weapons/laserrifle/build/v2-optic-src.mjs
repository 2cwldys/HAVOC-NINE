// The file's own optic, unreduced, as a model: to see what its rear looks like.
import { readFileSync, writeFileSync } from "node:fs";
import { readFbx, importModel, render, png, unpng, rgbOf } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
import { buildAtlas, remapUV } from "./atlas.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const TEX = "D:/temp/lr/tex";
const groups = scene.groups.filter((g) => /^Optic|^Reticles/.test(g.object));
const names = [...new Set(groups.map((g) => g.material))];
const FLAT = { "Material.007": [0.22, 0.52, 1.0] };
const images = [], materials = [];
for (const n of names) {
  if (FLAT[n]) materials.push({ name: n, colour: FLAT[n] });
  else { images.push({ bytes: readFileSync(`${TEX}/${n}.png`) }); materials.push({ name: n, image: images.length - 1 }); }
}
const sc = { images, materials, groups };
const { image, cells } = buildAtlas(sc, { size: 512 });
const one = { ...scene, groups: groups.map((g) => ({ ...g, material: "laser", tris: g.tris.map((tri) => tri.map((c) => ({ ...c, uv: remapUV(c, cells.get(g.material), 512) }))) })) };
const { mdl } = importModel(one, { name: "optic.mdl", pictures: { laser: image }, fit: 30, origin: "base", turn: 180, maxTextureSize: 512 });
writeFileSync("D:/temp/lr/optic_src.mdl", mdl);
for (const [name, yaw, pitch] of [["rear", 180, 10], ["rear_l", 150, 20], ["front", 0, 10]]) {
  for (const cull of [true, false]) {
    const img = render(mdl, { view: "orbit", yaw, pitch, zoom: 1.0, width: 700, height: 460, cull });
    writeFileSync(`D:/temp/lr/osrc_${name}_${cull ? "c" : "nc"}.png`, png(img.width, img.height, img.rgba));
  }
}
console.log("ok", groups.map((g) => `${g.object}|${g.material}:${g.tris.length}`).join(" "));
