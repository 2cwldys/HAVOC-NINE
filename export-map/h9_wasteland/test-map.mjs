import { readFileSync } from "node:fs";
import { M } from "../lib.mjs";
const map = M.readMap(readFileSync("out/h9_te_wasteland.map", "utf8"));
console.log("brushes", map.brushes.length, "entities", map.entities.length);
const plan = M.checkPlan(map, { textures: [] });
console.log("errors", plan.errors.length);
for (const e of plan.errors.slice(0, 2)) console.log(e);
const detail = map.entities.find((e) => (e.classname ?? e.properties?.classname) === "func_detail");
console.log("detail", detail && Object.keys(detail), detail?.brushes?.length);
const b = detail.brushes.find((br) => {
  const pts = br.points ?? br.faces?.flatMap?.((f) => f.points ?? []) ?? [];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return Math.abs(Math.min(...xs) + 1358) < 6 && Math.abs(Math.min(...ys) + 1718) < 6;
});
console.log("found", !!b, b && Object.keys(b));
console.log(JSON.stringify(b, null, 1).slice(0, 1200));
