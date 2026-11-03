// Scratch: are the gear zones actually painted, and with what colours?
import { paintSheet, STYLE_MSR } from "./mech-gear.mjs";

const { S, Z } = paintSheet(STYLE_MSR);
const img = S.image();
console.log("image keys:", Object.keys(img), img.width, img.height);
for (const [k, z] of Object.entries(Z)) {
  const i = (Math.floor(z.y + z.h / 2) * img.width + Math.floor(z.x + z.w / 2)) * (img.rgba ? 4 : 3);
  const arr = img.rgb ?? img.rgba;
  const c = [arr[i], arr[i + 1], arr[i + 2]];
  console.log(`${k.padEnd(6)} zone [${z.x},${z.y},${z.w},${z.h}] px ${z.px ?? "?"}  centre rgb ${c.join(",")}`);
}
