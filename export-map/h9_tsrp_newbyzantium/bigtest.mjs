// h9_tsrp_bigtest: how far past the +/-4096 box New Byzantium can reach, proved in the game before the city is built.
//
// A strip of floor 24000 units long, x -12000 to 12000, open to the sky; a lit pillar every 2048 units, so
// a player knows where they are; spawns at the middle and out to 11500 either way; and at the far end the
// things that travel over the network, each at its own distance: a shuttle (func_train) that runs the whole
// length, a door to open, a looping sound and a glow sprite.
//
// Past 4096 the game depends on two things H9's own: engine-h9-bigworld.patch, which turns the engine's
// big-world coordinates on for a world this wide, and the widened origin fields in ts\delta.lst. Walk it: a
// player at either end, the shuttle, the door, the sound and the sprite must all be where they are drawn.
//
//   node bigtest.mjs              write out\h9_tsrp_bigtest.map
//   node bigtest.mjs --compile    and compile it (Xash limits, BSP2)
//   node bigtest.mjs deploy       copy the .bsp into the game's ts\maps
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, M, WADS } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAME = "h9_tsrp_bigtest";
const COMPILERS = join(HERE, "..", "sdhlt-goldsrc-net", "tools"); // the set the lift is built with

const E = 12000;          // the strip's half length
const W = 512;            // its half width
const H = 768;            // the sky's height over the floor
const STEP = 2048;        // a pillar every so far
const T = { floor: "cd_mrbblack", pillar: "STEC_PANEL3", door: "cd_elevdoor", train: "DRKMTLT_WALL010", sky: "SKY" };

function build() {
  const outline = [[-E, -W], [E, -W], [E, W], [-E, W]];
  const shell = M.carvePlan([{ name: "strip", outline, floor: 0, ceiling: H, texture: { floor: T.floor, wall: T.sky, ceiling: T.sky } }], 64, {
    floor: T.floor, wall: T.sky, ceiling: T.sky,
  });

  const pillars = [];
  const entities = [];
  for (let x = -E + 512; x <= E - 512; x += STEP) {
    for (const y of [-W + 96, W - 160]) pillars.push(M.box([x - 32, y, 0], [x + 32, y + 64, 256], T.pillar));
    entities.push(M.light([x, 0, 320], { color: [255, 210, 170], brightness: 260 }));
  }

  // spawns: the middle, the old edge, past it, and the far ends
  for (const x of [0, -4000, 4000, -8000, 8000, -11500, 11500]) {
    entities.push(M.pointEntity("info_player_deathmatch", [x, -128, 40], { angles: `0 ${x < 0 ? 0 : 180} 0` }));
  }

  // the shuttle: end to end and back, always running
  entities.push(M.pointEntity("path_corner", [-11400, 256, 8], { targetname: "bt_far_west", target: "bt_far_east" }));
  entities.push(M.pointEntity("path_corner", [11400, 256, 8], { targetname: "bt_far_east", target: "bt_far_west" }));
  entities.push(M.brushEntity("func_train", [M.box([-11464, 192, 8], [-11336, 320, 104], T.train)], {
    targetname: "bt_shuttle", target: "bt_far_east", speed: 900, spawnflags: 0,
  }));
  entities.push(M.pointEntity("trigger_auto", [0, 0, 600], { target: "bt_shuttle", delay: 2 }));

  // at the far east end: a door that opens to anyone, a sound that loops, a sprite that glows
  entities.push(M.brushEntity("func_door", [M.box([10000, -96, 0], [10016, 96, 128], T.door)], {
    angles: "-90 0 0", speed: 120, wait: 3, lip: 8,
  }));
  entities.push(M.pointEntity("ambient_generic", [11000, 0, 64], { message: "ambience/drips.wav", health: 10, spawnflags: 2, pitch: 100 }));
  entities.push(M.pointEntity("env_sprite", [11500, 0, 300], {
    model: "sprites/glow04.spr", rendermode: 3, renderamt: 255, rendercolor: "160 120 255", scale: 1.5, spawnflags: 1,
  }));

  return {
    worldspawn: { wad: Object.values(WADS).filter(existsSync), skyname: "h9lift", MaxRange: 30000, message: "New Byzantium size test" },
    brushes: [...shell, ...pillars],
    entities,
  };
}

mkdirSync(OUT, { recursive: true });
const map = build();
writeFileSync(join(OUT, `${NAME}.map`), M.writeMap(map));
console.log(`  wrote ${NAME}.map: ${map.brushes.length} brushes, ${map.entities.length} entities`);

const flags = process.argv.slice(2);
if (flags.includes("--compile")) {
  const perTool = ["-engine", "xash", "-threads", "6"];
  const result = M.compileMap(join(OUT, `${NAME}.map`), {
    wads: Object.values(WADS).filter(existsSync),
    wadinclude: true,
    out: join(OUT, `${NAME}.bsp`),
    compilers: { folder: COMPILERS },
    args: { hlcsg: perTool, hlbsp: perTool, hlvis: [...perTool, "-fast"], hlrad: perTool },
    fast: true,
    vis: true,
    light: true,
    timeout: { hlcsg: 600000, hlbsp: 600000, hlvis: 600000, hlrad: 900000 },
    keep: false,
  });
  console.log(`  bsp: ${result.bsp ?? "none"}`);
  for (const line of result.errors) console.log(`  ERROR ${line}`);
  for (const line of result.warnings.slice(0, 10)) console.log(`  warn  ${line}`);
  if (result.leak) console.log(`  LEAK from ${result.leak.entity?.classname} at ${result.leak.at}`);
  for (const log of result.logs) console.log(`  ${log.tool}: ${log.code ?? "?"} in ${log.seconds.toFixed(1)}s`);
}
if (flags.includes("deploy")) {
  const dest = join(GAME_DIR, "ts", "maps", `${NAME}.bsp`);
  copyFileSync(join(OUT, `${NAME}.bsp`), dest);
  console.log(`  deployed to ${dest}`);
}
