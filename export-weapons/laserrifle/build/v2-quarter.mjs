import { readFileSync, writeFileSync } from "node:fs";
import { readSpr, spriteFrameRgba } from "file:///D:/Downloads/TSM/smak/src/maps/sprites.mjs";
import { png } from "file:///D:/Downloads/TSM/smak/src/image.mjs";
const spr = readSpr(readFileSync("D:/Downloads/TSM/H9XASH/ts/sprites/quarterscope.spr"));
const { frames, palette, ...rest } = spr;
console.log(JSON.stringify(rest), "frames", frames.length, "frame0", frames[0].width, frames[0].height, "palette[0..3]", [...palette.slice(0, 9)], "palette[255]", [...palette.slice(765, 768)]);
const img = spriteFrameRgba(spr, 0);
writeFileSync("D:/temp/lr/quarterscope.png", png(img.width, img.height, img.rgba));
// histogram of indices
const hist = new Map();
for (const v of frames[0].pixels) hist.set(v, (hist.get(v) ?? 0) + 1);
console.log([...hist].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}:${n}`).join(" "));
