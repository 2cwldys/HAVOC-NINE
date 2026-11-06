// node v2-view.mjs <model.mdl> <out prefix> [seq] [frame]
// Renders a model from both sides, the top, the front and a three-quarter, large, to look for missing faces.
import { readFileSync, writeFileSync } from "node:fs";
import { render, png } from "file:///D:/Downloads/TSM/smak/src/index.mjs";

const [model, prefix, seq = "0", frame = "0"] = process.argv.slice(2);
const src = readFileSync(model);
const views = {
  left: { view: "orbit", yaw: 90, pitch: 0 },
  right: { view: "orbit", yaw: -90, pitch: 0 },
  top: { view: "orbit", yaw: 0, pitch: 89 },
  front: { view: "orbit", yaw: 0, pitch: 0 },
  back: { view: "orbit", yaw: 180, pitch: 0 },
  q1: { view: "orbit", yaw: 55, pitch: 22 },
  q2: { view: "orbit", yaw: -55, pitch: 22 },
  under: { view: "orbit", yaw: 40, pitch: -35 },
};
for (const [name, v] of Object.entries(views)) {
  const img = render(src, { ...v, seq: Number(seq), frame: Number(frame), width: 1100, height: 560, zoom: 1.0 });
  writeFileSync(`${prefix}_${name}.png`, png(img.width, img.height, img.rgba));
}
console.log("done", prefix);
