// Where people actually stand: every start, every teleport destination, and the plugin's spawn config.
//
// A city's brush box is mostly shell and slab; the band people live in is what has to be kept clear when
// three cities are stacked. This prints that band per city, and what it would take to make the three bands
// disjoint in Z inside the engine's ±4096.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GAME_DIR } from "../lib.mjs";
import { CITIES, readCity } from "./probe.mjs";

const STARTS = ["info_player_start", "info_player_deathmatch", "info_player_terrorist", "info_player_counterterrorist"];
const DESTINATIONS = ["info_teleport_destination", "info_target"];
const AXES = ["x", "y", "z"];
const r = (v) => Math.round(v);

const originOf = (entity) => {
  const origin = String(entity.origin ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  return origin.length === 3 && origin.every(Number.isFinite) ? origin : null;
};

for (const name of Object.keys(CITIES)) {
  const city = readCity(CITIES[name]);
  const entities = city.map.entities ?? [];
  console.log(`\n=== ${city.file}`);

  for (const cls of STARTS) {
    const found = entities.filter((e) => e.classname === cls).map(originOf).filter(Boolean);
    if (!found.length) continue;
    console.log(`  ${cls}: ${found.length}`);
    const zs = found.map((p) => p[2]).sort((a, b) => a - b);
    console.log(`    z ${zs[0]} .. ${zs[zs.length - 1]}   at ${found.slice(0, 6).map((p) => p.map(r).join(",")).join("  ")}`);
  }

  for (const cls of DESTINATIONS) {
    const found = entities.filter((e) => e.classname === cls).map(originOf).filter(Boolean);
    if (found.length) console.log(`  ${cls}: ${found.length}  z ${found.map((p) => p[2]).sort((a, b) => a - b).slice(0, 4).join(", ")} ...`);
  }

  const cfg = join(GAME_DIR, "ts", "addons", "amxmodx", "configs", `tsm_spawns_${city.file.replace(/\.map$/, "")}.cfg`);
  if (existsSync(cfg)) {
    const lines = readFileSync(cfg, "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("tsm_spawn"));
    const pts = lines.map((l) => l.trim().split(/\s+/).slice(2, 5).map(Number));
    console.log(`  tsm spawns cfg: ${pts.length}  z ${Math.min(...pts.map((p) => p[2]))} .. ${Math.max(...pts.map((p) => p[2]))}`);
  } else {
    console.log(`  tsm spawns cfg: none (${cfg.split(/[\\/]/).pop()})`);
  }

  const teleports = entities.filter((e) => e.classname === "trigger_teleport");
  const pushes = entities.filter((e) => e.classname === "trigger_push");
  console.log(`  triggers: teleport ${teleports.length}, push ${pushes.length}, hurt ${entities.filter((e) => e.classname === "trigger_hurt").length}, multiple ${entities.filter((e) => e.classname === "trigger_multiple").length}`);
}

// The stack arithmetic: three playable bands, each from the lowest start to the highest start plus a head.
const bands = [];
for (const name of Object.keys(CITIES)) {
  const city = readCity(CITIES[name]);
  const pts = (city.map.entities ?? []).filter((e) => STARTS.includes(e.classname)).map(originOf).filter(Boolean);
  if (!pts.length) continue;
  const zs = pts.map((p) => p[2]);
  bands.push({ name, lo: Math.min(...zs), hi: Math.max(...zs) });
}
console.log("\n=== start bands, as built");
for (const b of bands) console.log(`  ${b.name.padEnd(12)} z ${r(b.lo)} .. ${r(b.hi)}  (${r(b.hi - b.lo)} tall)`);
console.log(`  sum of spans ${r(bands.reduce((s, b) => s + (b.hi - b.lo), 0))}   legal budget 8192`);
