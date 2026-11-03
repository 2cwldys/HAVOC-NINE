// score.mjs: New Byzantium's character in numbers beside the three cities it is measured against, by SMAK's
// map-character and the roleplay profile (smak\profiles\specialists-roleplay.mjs). The city is a Xash BSP2, which
// the command line does not read; bsp2.mjs reads it into the same shape, and the figures are worked out here.
//
//   node score.mjs        the table, and what the profile says of New Byzantium
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M, SMAK, GAME_DIR } from "../lib.mjs";
import { readAnyBsp } from "./bsp2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CITIES = {
  newbyzantium: join(HERE, "out", "h9_tsrp_newbyzantium.bsp"),
  alexandria: join(GAME_DIR, "ts_downloads", "maps", "alexandria_msr_b4v3.bsp"),
  paradise: join(HERE, "..", "..", "H9XASH", "ts", "maps", "paradisecity_revival_final.bsp"),
  xenon: "D:/GIT Storage/The-Specialists-Archive/map-resources/maps/xenoncity_true_b3v2.bsp",
};
const mod = await M.loadMod(join(SMAK, "profiles", "specialists-roleplay.mjs"), { game: GAME_DIR });
const rows = [];
for (const [name, file] of Object.entries(CITIES)) {
  const t = Date.now();
  const bsp = readAnyBsp(readFileSync(file));
  const c = M.characterOf(bsp, { mod });
  rows.push({ name, ...c, ...M.characterAgainst(c.figures, mod.character?.figures ? mod.character : null) });
  console.log(`  ${name}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
const names = ["offGrid", "sloped", "levels", "heightSpread", "textures", "props", "sounds", "music", "lights", "lampFaces", "lightMean", "shadow", "brightest"];
const lines = [];
const out = (l) => {
  lines.push(l);
  console.log(l);
};
out(`${"".padEnd(14)}${names.map((n) => n.slice(0, 11).padStart(12)).join("")}`);
for (const r of rows) out(`${r.name.padEnd(14)}${names.map((n) => String(r.figures[n] ?? "-").padStart(12)).join("")}`);
const ref = mod.character?.figures;
if (ref) out(`${"(q1-q3)".padEnd(14)}${names.map((n) => (ref[n] ? `${ref[n][0]}-${ref[n][2]}` : "-").padStart(12)).join("")}`);
for (const r of rows) {
  for (const t of r.plain ?? []) out(`PLAIN ${r.name}: ${t}`);
  if (r.warning) out(`WARN  ${r.name}: ${r.warning}`);
}
writeFileSync(join(HERE, "out", "score.txt"), lines.join("\n") + "\n");
