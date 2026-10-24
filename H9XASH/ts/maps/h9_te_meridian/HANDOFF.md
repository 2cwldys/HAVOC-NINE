# h9_te_meridian

A small siege map for The Specialists, made for Havoc9's ts_matchmode: a bank heist at night in an art-deco bank.
The insurgents (team 2) come in from the street; the MSR (team 1) defend from the loading dock behind the bank.

## Install

The folders in this package match the server's layout under `Half-Life/`:

| File | Goes to | Who needs it |
|---|---|---|
| `ts/maps/h9_te_meridian.bsp` | `ts/maps/` | server and clients (the server sends it) |
| `ts/addons/amxmodx/configs/tsm_spawns_h9_te_meridian.cfg` | `ts/addons/amxmodx/configs/` | server |
| `rcbot/waypoints/ts/h9_te_meridian.rcw` | `rcbot/waypoints/ts/` | server (bots) |

Nothing else is needed:
- All of the map's own textures are inside the .bsp. It asks only for `specialists.wad` and `halflife.wad`.
- The sky (`LMcity_1`), the models and the sounds all ship with The Specialists or Half-Life.

## The map

- **Street** (spawn of the insurgents in the alley at its south-west end): the bank's front under a MERIDIAN neon
  sign and an entrance pavilion. Across the road are lit shops, a newsstand, a bus shelter and a car. A stair at
  the west end goes down to the safe-deposit level.
- **Banking hall:** a marble floor with a compass rose and a four-faced clock (the middle of the map), eight
  columns, a skylight, and a mezzanine on three sides reached by two grand stairs. The teller counter with its cage
  is here.
- **Wings:** offices, an archive and a boardroom on the upper floors.
- **Below:** the deposit room, the vault hall with its round vault door, and the strongroom.
- **Loading dock** (spawn of the MSR): a truck pit, armoured vans, crates, a ramp down to the vault tunnel and a fire
  escape up to the records room.

**Three ways from one side to the other:** the hall floor, the mezzanine, and the vault level.

**Breakables:** the glass and the crates break and come back after 45 seconds (`respawntime 45`).

**Props:** 45 stock `ts_model`s. The solid ones (couches, tables, boxes, vans, car) have CLIP boxes, because a
ts_model by itself does not block players.

## Objectives (siege)

Built for the plugin as it is in 2cwldys/ts_h9_team_elimination on 2026-10-21. They are taken in order, and only
the last one ends the round.

| Objective | Entity | What it is | When taken (fires) | Reset relay |
|---|---|---|---|---|
| 1 | `tsm_obj_1` (func_wall) | the teller cage gate | `obj1_fall`: opens the counter and its stair down to the vault | — |
| 2 | `tsm_obj_2` (func_wall) | the round vault door | `obj2_fall`: shows the door swung open, with sparks | `tsm_obj_2_reset` hides that again |
| 3 | `tsm_obj_3` (func_wall) | the safe in the strongroom, with a briefcase on it | `obj3_fall`: shows the safe open | `tsm_obj_3_reset` hides that again |

There is no Engineer door. None of the objective pieces is a class the Breacher can force.

## Spawns

- **Spawn points:** 8 `info_player_deathmatch` on the dock (team 1) and 8 in the alley (team 2), plus one
  `info_player_start`.
- **Without the cfg:** the plugin's automatic split already puts each side on its own end.
- **With the cfg:** it adds the facing of each spawn.
- **Distances:** the two sides' nearest spawns are 1713 units apart, and neither side can see the other's spawns.
- **To the clock:** the walk is 1315 from one side and 1440 from the other, 9.5% apart.

## Bots

`h9_te_meridian.rcw` holds 462 RCBot waypoints, generated for RCBot 1.51b13's format with the objectives open.
On the map's first load the bot works out its visibility table and saves it, so `rcbot/visibility/ts/` must be
writable. Doors, lifts, cover and sniper spots carry no special waypoints.

## Please test

1. The light level: is it too dark anywhere?
2. The stairs: the east stair's two flights, the open-tread fire escape, and the stairs out of the dock's truck pit.
3. A full heist (`amx_tsm_obj`, `amx_tsm_siege_plant`): each objective body disappears, the open vault door and
   the open safe show, and all of it is back the next round.
4. The teller cage bars draw with their holes.
5. Bots move around the whole map, including the vault level.

## Source

`source/h9_te_meridian.map` opens in J.A.C.K. or Hammer with `source/meridian.wad` (the map's own textures) plus
`specialists.wad` and `halflife.wad`. Compile with `-wadinclude meridian.wad` so those textures stay inside the
.bsp.

`preview/` holds pictures of the map.
