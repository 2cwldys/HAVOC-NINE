import { readFileSync } from "node:fs";
import { M } from "../lib.mjs";
const map = M.readMap(readFileSync("out/h9_as_wasteland.map", "utf8"));
for (const [cx, cy] of [[5,394],[-990,-140],[1977,-18]]) {
  console.log("=== cluster", cx, cy);
  for (const e of map.entities) {
    if (!e.brushes) continue;
    for (const b of e.brushes) {
      const pts = b.faces.flatMap((f) => f.points);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), zs = pts.map((p) => p[2]);
      const mx = (Math.min(...xs)+Math.max(...xs))/2, my = (Math.min(...ys)+Math.max(...ys))/2;
      if (Math.hypot(mx-cx, my-cy) > 110) continue;
      console.log([Math.min(...xs),Math.min(...ys),Math.min(...zs)].map(Math.round), [Math.max(...xs),Math.max(...ys),Math.max(...zs)].map(Math.round), [...new Set(b.faces.map(f=>f.texture))].join(","));
    }
  }
}
