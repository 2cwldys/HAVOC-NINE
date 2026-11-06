import { readFileSync, writeFileSync } from "node:fs";
import { render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const src = readFileSync("D:/Downloads/TSM/H9XASH/ts/models/v_m4.mdl");
for (const [name, seq, frame] of [["idle", 0, 0], ["stock", 15, 12]]) {
  const img = render(src, { view: "first", seq, frame, width: 900, height: 650 });
  writeFileSync(`D:/temp/lr/donor_m4_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("ok");
