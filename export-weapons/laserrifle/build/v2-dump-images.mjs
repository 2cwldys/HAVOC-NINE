import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
mkdirSync("D:/temp/lr/emb", { recursive: true });
for (const m of scene.materials) {
  if (m.image === undefined) continue;
  const im = scene.images[m.image];
  const bytes = Buffer.from(im.bytes);
  const ext = bytes[0] === 0xff ? "jpg" : "png";
  writeFileSync(`D:/temp/lr/emb/${m.name}.${ext}`, bytes);
  console.log(m.name, m.image, ext, bytes.length);
}
