// Can one .bsp hold every picture the three cities wear? The classic GoldSrc limit is 512 texture names; the
// Xash engine on this server reads 2048. The compilers are the unknown, so this asks them directly: a throwaway
// map with one small brush per texture, compiled with the same wads the merge will use.
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { M } from "../lib.mjs";
import { COMPILERS } from "../lib.mjs";
import { CITIES, readCity } from "./probe.mjs";
import { WADS } from "./wads.mjs";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const names = new Set();
for (const name of Object.keys(CITIES)) for (const texture of texturesOf(readCity(CITIES[name]).map)) names.add(texture);

function texturesOf(map) {
  const all = new Set();
  const take = (brushes) => {
    for (const brush of brushes ?? []) for (const face of brush.faces ?? []) all.add(face.texture);
  };
  take(map.brushes);
  for (const entity of map.entities ?? []) take(entity.brushes);
  return all;
}

const list = [...names].sort().filter((t) => !["ORIGIN", "AAATRIGGER", "MARB052", "PO_HTLCARPET"].includes(t.toUpperCase()));
const brushes = list.map((texture, index) => {
  const x = (index % 60) * 32 - 900;
  const y = Math.floor(index / 60) * 32 - 250;
  return M.box([x, y, -8192], [x + 16, y + 16, -8176], texture);
});

const map = {
  worldspawn: { wad: Object.values(WADS), skyname: "blue", MaxRange: "8192" },
  brushes,
  entities: [],
};
const file = join(OUT, "texcount.map");
mkdirSync(OUT, { recursive: true });
writeFileSync(file, M.writeMap(map));
console.log(`${list.length} textures, ${brushes.length} brushes -> ${file}`);

const result = M.compileMap(file, {
  wads: Object.values(WADS).filter(existsSync),
  wadinclude: true,
  out: join(OUT, "texcount.bsp"),
  fast: true,
  vis: false,
  light: false,
  compilers: { folder: COMPILERS },
});
console.log("bsp:", result.bsp);
console.log("errors:", result.errors?.length ? result.errors.join("\n  ") : "none");
console.log("warnings:", result.warnings?.slice(0, 8).join("\n  ") ?? "none");
