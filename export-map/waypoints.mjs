// RCBot's waypoints for the city, the same route the map itself travels: SMAK reads the compiled
// map, walks it, lays waypoints on the walked floor and writes the bot's .rcw file.
//
//     node waypoints.mjs             generate into out\ (.rcw and a plan to look at)
//     node waypoints.mjs deploy      and copy it into the places the bot reads (below)
//
// THE WALK IS SEEDED WITH THE MAP'S OWN SPAWNS. ts_matchmode places players at the tsm_spawn points
// of configs\tsm_spawns_h9_te_neuropolis.cfg, so spawn entities are not in the .bsp at all (see
// README.txt) -- and the walkers of SMAK's waypoints.mjs walk nothing without a place to start
// ("no place to start: nothing was walked"). The spawn points are handed to the walk as `from`, one
// point each; they are feet positions the way the plugin sets them.
//
// WHERE THE BOT LOOKS. RCBot reads its paths through its bot folder (dlls/globals.cpp
// ReadBotFolder(): <gamedir>\rcbot_folder.ini, else "rcbot") -- which is "rcbot" beside each game
// folder, since there is no rcbot_folder.ini in ts\ on this machine. Both installs that run the
// map carry the whole bot folder at their roots:
//
//   live (hlds):    Half-Life\rcbot\waypoints\ts\<map>.rcw   (hlds's working folder is Half-Life\)
//   H9XASH (xash):  H9XASH\rcbot\waypoints\ts\<map>.rcw      (h9xash -dedicated runs from H9XASH\)
//
// The copies under ts\addons\rcbot\waypoints\ are the shipped pack, not what the bot reads (only
// h9_te_meridian of H9's own maps is missing there, and it is present in both bot folders). The
// visibility table the bot makes the first time the map loads goes to rcbot\visibility\ts\ beside
// them, which is pre-made on both sides; the .rcw carries RCW_READ_VISIBILITY to say it is owed.
//
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { K, M, OUT, MAP_NAME, GAME_DIR, spawnPoints } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The compiled city the game runs: the same bytes in out\, the Steam install and H9XASH. */
const BSP = join(OUT, `${MAP_NAME}.bsp`);

/** Every install that runs the map has its bot folder at its root. */
const BOT_FOLDERS = [join(GAME_DIR, "rcbot"), join(HERE, "..", "H9XASH", "rcbot")];

const name = MAP_NAME;

const deploy = process.argv.includes("deploy");

if (!existsSync(BSP)) {
  console.error(`no compiled map at ${BSP} -- run \`node make.mjs compile\` first.`);
  process.exit(1);
}

const spawns = spawnPoints();
if (!spawns.length) {
  console.error(`no spawns in configs\\tsm_spawns_${name}.cfg -- nothing to start the walk from.`);
  process.exit(1);
}

/*
 * SPACING AND THE WALK GRID. This city is far bigger than anything the 1024 waypoints RCBot has room
 * for can cover at SMAK's defaults (waypoints.mjs's auto-widen gives up at spacing 763, eight tries
 * from 160, and this map still overflows past 1220). Two settings, each probed against the kinds:
 *   cell 16     the walk's grid (8 by default). A coarser walk smooths the piece boundaries, which
 *               takes the corner waypoints from 643 to 503 -- corners are what the map cannot shed,
 *               they barely move with spacing. It costs nothing in kinds: every jump, flight, opening
 *               and start survives.
 *   spacing 1000  the waypoints on the street (160 by default). What fits: 1032 at 900, 1013 at 1000.
 * Over that the bot's own cap is hard: bot_const.h MAX_WAYPOINTS = 1024 is the size of its waypoint
 * array, and WaypointLoad reads count records into it unchecked, so a longer file is memory damage,
 * not a big waypoint map.
 * The auto-widen still runs as a backstop (most is left at RCBot's 1024) but cannot save this map
 * alone: nine widenings from 160 do not reach 1000, so the spacing is handed in explicitly.
 */
const SPACING = 1000;
const CELL = 16;

console.log(`\n  ${name}: walking (the walk seeded with ${spawns.length} spawn points)...`);
const bsp = M.readBsp(readFileSync(BSP));

const made = M.waypointsOf(bsp, {
  // Each spawn is a place to start, as reachOf takes it: [x, y, z], where the feet are.
  from: spawns.map((spawn) => spawn.at),
  spacing: SPACING,
  cell: CELL,
  // tsm_eng_door (two of them, +USE-only, class-gated by ts_matchmode.sma -- see
  // fw_door_use) taken as closed for the walk, same as a door that needs a key the
  // walker can never have. Without this, every door on the map is walked as already
  // open (the default), so the walk never finds -- and RCBot's own stuck/A*-reroute
  // never gets to use -- any route that doesn't go straight through one of these two,
  // regardless of whether the class standing at it can actually open it.
  shut: ["tsm_eng_door"],
});

for (const fact of made.facts) console.log(`     ${fact}`);
for (const warning of made.warnings) console.log(`     WARN  ${warning}`);
const flagged = (bit) => made.waypoints.filter((waypoint) => waypoint.flags & bit).length;
console.log(
  `     ${made.waypoints.length} waypoints: ${made.reach.starts.length} to start from,`
    + ` ${flagged(M.RCW_FLAGS.LADDER)} ladders, ${flagged(M.RCW_FLAGS.JUMP)} jumps,`
    + ` ${flagged(M.RCW_FLAGS.CROUCH)} crouching, at a spacing of ${Math.round(made.spacing)}`,
);

/*
 * THE .rcw, and the plan of it to look at: a cross at every waypoint (yellow at a place to start,
 * blue a ladder, magenta a jump, cyan crouching, red the rest) and its paths (green both ways,
 * orange one way, drawn half way to the one it reaches).
 */
const bytes = M.writeRcw(made.waypoints, { mapName: name });
const rcw = join(OUT, `${name}.rcw`);
writeFileSync(rcw, bytes);
console.log(`  wrote     ${rcw}  (${bytes.length} bytes)`);

const lines = [];
made.waypoints.forEach((waypoint, number) => {
  for (const to of waypoint.paths) {
    const other = made.waypoints[to];
    const both = other.paths.includes(number);
    const end = both
      ? other.origin
      : waypoint.origin.map((value, axis) => (value + other.origin[axis]) / 2);
    lines.push({
      from: waypoint.origin.slice(0, 2),
      to: end.slice(0, 2),
      colour: both ? [60, 200, 60] : [255, 150, 0],
    });
  }
});
for (const waypoint of made.waypoints) {
  const [x, y] = waypoint.origin;
  const colour = (waypoint.flags & M.RCW_FLAGS.LADDER)
    ? [40, 140, 255]
    : (waypoint.flags & M.RCW_FLAGS.JUMP)
      ? [255, 0, 255]
      : (waypoint.flags & M.RCW_FLAGS.CROUCH)
        ? [0, 230, 230]
        : (waypoint.kind === "start")
          ? [255, 255, 0]
          : [230, 40, 40];
  lines.push(
    { from: [x - 8, y - 8], to: [x + 8, y + 8], colour },
    { from: [x - 8, y + 8], to: [x + 8, y - 8], colour },
  );
}
const pngTo = join(OUT, `${name}_waypoints.png`);
const picture = M.planOf(bsp, { lines, entities: false });
writeFileSync(pngTo, K.png(picture.width, picture.height, picture.rgba));
console.log(`  wrote     ${pngTo}  ${picture.width}x${picture.height}`);

/*
 * DEPLOY, when asked: every place the bot reads, keeping a copy of anything that was there -- the
 * backups folder takes it, in this folder's usual way (out\<name>.bsp.before-smak keeps the map's
 * old copy the same way). A missing file backs up nothing, so the first deploy moves nothing.
 */
if (deploy) {
  let moved = 0;
  for (const bot of BOT_FOLDERS) {
    const to = join(bot, "waypoints", "ts", `${name}.rcw`);
    if (existsSync(to)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
      const keep = join(HERE, "..", "backups", `waypoints-${name}-${stamp}`);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(keep, { recursive: true });
      copyFileSync(to, join(keep, `${name}.rcw`));
      console.log(`  kept the old one: ${join(keep, `${name}.rcw`)}`);
    }
    copyFileSync(rcw, to);
    console.log(`  deployed  ${to}`);
    moved++;
  }
  console.log(`  ${moved} bot folder(s) updated. The bot makes its visibility table (rcbot\\visibility\\ts\\${name}.rcv)`
    + " on the first map load, then rewrites the .rcw without the owed-visibility bit.");
} else {
  console.log("\n  Generated into out\\. `node waypoints.mjs deploy` copies it into the bot folders.");
}
console.log("");
