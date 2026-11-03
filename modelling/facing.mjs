import { K, load, POSE, lineup } from "./lib.mjs";
import { writeFileSync } from "node:fs";
const src = load("merc");
// red where the normal points -x, blue where it points +x
const { mdl } = K.paint(src, ({ n }) => (n[0] < 0 ? [0.9, 0.1, 0.1] : [0.1, 0.2, 0.9]), { pose: POSE });
const img = lineup([["yaw 0", mdl], ["yaw 180", mdl]], { yaws: [0], zoom: 1.5, width: 300, cols: 2 });
writeFileSync("out/facing.png", K.png(img.width, img.height, img.rgba));
console.log("out/facing.png: RED = normal -x, BLUE = normal +x");
