// What the map scripts share: where SMAK is, where the game's maps and textures are, and where
// the compilers live.
//
// Modelled on modelling/lib.mjs, which does the same job for models. The two rules are the same:
// SMAK is read and never written to, and NOTHING is written into the game folder except by an
// explicit deploy step. Everything else goes to out/.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- edit these if the install moves ---------------------------------------
const GAME = "D:/SteamLibrary/steamapps/common/Half-Life";
const SDHLT = "D:/SteamLibrary/steamapps/common/JACK/SDHLT";
// ----------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, "out");
/** Where the renamed copies of the compilers go: see compilers.mjs and README.txt. */
export const COMPILERS = join(HERE, "compilers");
export const SDHLT_DIR = resolve(process.env.SDHLT_DIR ?? SDHLT);
export const GAME_DIR = resolve(process.env.HL_DIR ?? GAME);
export const TS_MAPS = join(GAME_DIR, "ts", "maps");

const kit = resolve(process.env.SMAK ?? join(HERE, "..", "smak"));
if (!existsSync(join(kit, "src/index.mjs"))) {
  console.error(`SMAK is not at ${kit}.\nPut the kit there, or set the SMAK environment variable to its folder.`);
  process.exit(1);
}
export const K = await import(pathToFileURL(join(kit, "src/index.mjs")).href);
/** The map half of the kit, which is what everything here uses. */
export const M = K.maps;
export const SMAK = kit;

/** The map this folder exists to grow. */
export const MAP_NAME = "h9_te_neuropolis";
/*
 * THE BASE MAP IS A SOURCE FILE HERE, not the copy sitting in the game's maps folder.
 *
 * It used to be read straight out of ts/maps/, which put the one irreplaceable input to this whole
 * pipeline in a directory that deploys write to. It was overwritten exactly once, by a deploy that
 * copied the GENERATED map over it under the same name -- after which a build would have grown a
 * city on top of a city that already had one, compounding every run, with nothing to say so.
 *
 * In base/ it is version-controlled, it travels with the scripts that read it, and nothing that
 * writes to the game folder can reach it.
 */
export const BASE_MAP = join(HERE, "base", `${MAP_NAME}.map`);

/*
 * The texture files the city is built from.
 *
 * The base map names ten of them in worldspawn's `wad` key. These are the ones that matter for a
 * sunken cyberpunk city; the rest stay listed so nothing already placed loses its picture.
 */
export const WADS = {
  halflife: join(GAME_DIR, "valve", "halflife.wad"),
  liquids: join(GAME_DIR, "valve", "liquids.wad"),
  decals: join(GAME_DIR, "valve", "decals.wad"),
  xeno: join(GAME_DIR, "valve", "xeno.wad"),
  techno: join(GAME_DIR, "ts", "techno.wad"),
  cyberdynamics: join(GAME_DIR, "ts", "cyberdynamics.wad"),
  avp2: join(GAME_DIR, "ts", "avp2.wad"),
  specialists: join(GAME_DIR, "ts", "specialists.wad"),
  submerged: join(GAME_DIR, "ts", "submerged.wad"),
};

/** Every wad above that is actually on disk, as paths. */
export const wadList = () => Object.values(WADS).filter((w) => existsSync(w));

/** The base map, read into { worldspawn, brushes, entities }. */
export function readBase(file = BASE_MAP) {
  if (!existsSync(file)) {
    console.error(`No map at ${file}.\nFix GAME at the top of lib.mjs, or set HL_DIR.`);
    process.exit(1);
  }
  return M.readMap(readFileSync(file, "utf8"));
}

/**
 * The spawn points ts_matchmode places players on, read from its config.
 *
 * These are NOT info_player_start entities: the plugin puts players at these coordinates itself,
 * so they do not appear in the .map at all and nothing in the map file will warn when the city
 * grows over one. They are read here so the scripts can hold the bases still around them.
 */
export function spawnPoints() {
  const cfg = join(GAME_DIR, "ts", "addons", "amxmodx", "configs", `tsm_spawns_${MAP_NAME}.cfg`);
  if (!existsSync(cfg)) return [];
  return readFileSync(cfg, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((w) => w[0] === "tsm_spawn" && w.length >= 7)
    .map((w) => ({
      team: Number(w[1]),
      at: [Number(w[2]), Number(w[3]), Number(w[4])],
      pitch: Number(w[5]),
      yaw: Number(w[6]),
    }));
}

/** The box a list of points sits in, grown by `pad` on each side. */
export function around(points, pad = 0) {
  const min = [0, 1, 2].map((a) => Math.min(...points.map((p) => p[a])) - pad);
  const max = [0, 1, 2].map((a) => Math.max(...points.map((p) => p[a])) + pad);
  return { min, max };
}
