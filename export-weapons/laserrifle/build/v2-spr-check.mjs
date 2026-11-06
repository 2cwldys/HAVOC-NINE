import { readFileSync, writeFileSync } from "node:fs";
import { readSpr, spriteFrameRgba } from "file:///D:/Downloads/TSM/smak/src/maps/sprites.mjs";
import { png } from "file:///D:/Downloads/TSM/smak/src/image.mjs";
const base = "D:/Downloads/TSM/laserrifle/out2/overlay/sprites/";
const ref = readSpr(readFileSync("D:/Downloads/TSM/H9XASH/ts/sprites/weapons/ak47.spr"));
const refm = readSpr(readFileSync("D:/Downloads/TSM/H9XASH/ts/sprites/gun_muzzle2.spr"));
for (const [f, r] of [["weapons/laserrifle.spr", ref], ["laserrifle_muzzle.spr", refm], ["laserrifle_trail.spr", refm], ["laserrifle_bolt.spr", refm], ["laserrifle_hit.spr", refm]]) {
  const s = readSpr(readFileSync(base + f));
  const { frames, palette, ...rest } = s;
  console.log(f.padEnd(26), JSON.stringify(rest), "frames", frames.length, "| same type/format as ref:", s.type === r.type && s.format === r.format);
  const img = spriteFrameRgba(s, 0);
  writeFileSync(`D:/temp/lr/spr_${f.replace(/[\/]/g, "_")}.png`, png(img.width, img.height, img.rgba));
}
