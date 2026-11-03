// look.mjs: pictures of the source cities from their own spawn points, for the design study (STUDY.md).
//   node look.mjs <out folder>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GAME_DIR, K, M } from "../lib.mjs";

const OUTDIR = process.argv[2];
const CITIES = {
  alexandria: join(GAME_DIR, "ts_downloads", "maps", "alexandria_msr_b4v3.bsp"),
  paradise: "D:/Downloads/TSM/H9XASH/ts/maps/paradisecity_revival_final.bsp",
  xenon: "D:/GIT Storage/The-Specialists-Archive/map-resources/maps/xenoncity_true_b3v2.bsp",
};
const folders = [join(GAME_DIR, "ts"), join(GAME_DIR, "ts_downloads"), join(GAME_DIR, "valve")];
mkdirSync(OUTDIR, { recursive: true });
for (const [name, file] of Object.entries(CITIES)) {
  if (!existsSync(file)) { console.log(name, "missing"); continue; }
  const bsp = M.readBsp(readFileSync(file));
  const ents = bsp.entities.map((pairs) => Object.fromEntries(pairs));
  const spawns = ents.filter((e) => /info_player_(deathmatch|start)|info_player_team/.test(e.classname ?? ""));
  // street views: from the city's own lights, spread over it, each looking a different way
  const lamps = ents.filter((e) => e.classname === "light" && e.origin);
  const spread = lamps.filter((_, i) => i % Math.max(1, Math.floor(lamps.length / 9)) === 0).slice(0, 9);
  const pick = spawns.length && process.argv[3] !== "lamps" ? spawns.filter((_, i) => i % Math.max(1, Math.floor(spawns.length / 6)) === 0).slice(0, 6)
    : spread.map((e, i) => ({ ...e, angles: `0 ${i * 97 % 360} 0` }));
  pick.forEach((e, i) => {
    const o = String(e.origin).split(/\s+/).map(Number);
    const yaw = ((Number(String(e.angles ?? "0 0 0").split(/\s+/)[1]) || 0) * Math.PI) / 180;
    const from = [o[0], o[1], o[2] + 28];
    const to = [o[0] + Math.cos(yaw) * 600, o[1] + Math.sin(yaw) * 600, o[2] + 40];
    try {
      const img = M.drawMap(bsp, { from, to, width: 480, height: 300, brightness: 1.4, folders, entities: "game", labels: false });
      writeFileSync(join(OUTDIR, `${name}-${i}.png`), K.png(img.width, img.height, img.rgba));
    } catch (err) { console.log(name, i, "FAILED", err.message); }
  });
  console.log(name, spawns.length, "spawns, drew", pick.length);
}
