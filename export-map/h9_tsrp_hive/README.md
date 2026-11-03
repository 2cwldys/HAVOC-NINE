# h9_tsrp_hive — Paradise City + Alexandria + Xenon City in one map

Three decompiled city maps merged into one `.map` and joined by travel zones. Built with SMAK 0.25's
map model; the kit itself is only read.

- `out/h9_tsrp_hive.map` — the merged map, 14.17 MB, 18,234 world brushes, 1,706 entities.
- `out/h9_tsrp_hive.bsp` — the compiled map (BSP2, Xash limits).
- `out/tsm_spawns_h9_tsrp_hive.cfg` — 64 spawns for `ts_matchmode`: 32 per team, each team in its home city
  (team 1 Paradise City, team 2 Xenon City).
- `merge.mjs` — builds the map from the three sources, repairs the decompiler's geometry, adds the travel
  zones and the texture lights.
- `spawns.mjs` — proves and writes the spawn config against the merged map.
- `portals.mjs` — draws the three animated travel-zone sprites and copies them into `H9XASH\ts\sprites`.
- `texlights.mjs` — finds the textures that light each city in its original `.bsp`, into `texlights.json`.
- `calibrate.mjs` — measures the merged compile's light round each texture light that starts from a guess,
  against the city's original, for `texlights.mjs`'s `SCALES`.
- `waypoints.mjs` — RCBot's waypoints for the three cities and the six portals, into `out/h9_tsrp_hive.rcw`
  (more than stock RCBot's 1024: the map needs the patched RCBot).

## The stack

None of the three cities leaves room beside another, so they are stacked on the z axis and reached by
teleport. The default layout cuts Alexandria's dead 2.4 km rock slab off at z = -1600 (its own coordinates)
and adds a `NULL` cap, which puts all three cities inside the engine's ±4096 box:

| city | z range (merged) | shift |
|---|---|---|
| Xenon City | 411 .. 4040 | +955 |
| Paradise City | -1488 .. 411 | +2077 |
| Alexandria | -4040 .. -1488 | -2440 (slab cut at -1600) |

World extents: `-3968 -4036 -4040` to `3792 4040 4040` (7760 × 8076 × 8080).

`node merge.mjs --no-cut` keeps the cities whole (10,592 units tall, Alexandria's bunker and slab
included). That layout needs the raised-limit compiler **and** an engine that writes coordinates wider than
16 bits; the default cut layout runs in an ordinary ±4096 engine.

## The travel zones

Three two-way links, one between each pair of cities. Each end is a travel zone: a 48 × 48 × 64
`trigger_teleport` on the floor with an animated portal turning over it, in the colour of the city it leads
to (Paradise amber, Alexandria blue, Xenon teal). Walking in lands you 80 units in front of the other city's
zone back, facing away from it, so arriving never sends you straight back out.

| link | zone (x y floor) | yaw | zone (x y floor) | yaw |
|---|---|---|---|---|
| Paradise ↔ Alexandria | `pc` 1653 2676 -564 | 28 | `al` -922 -3187 -2360 | 90 |
| Paradise ↔ Xenon | `pc` -54 -1033 -1036 | 91 | `xe` -2812 -98 554 | 1 |
| Xenon ↔ Alexandria | `xe` 506 -1093 979 | 180 | `al` -765 1526 -2824 | 91 |

Entity names are `hive_<city>_pad_<to>` (the trigger), `hive_<city>_portal_<to>` (the sprite) and
`hive_<city>_arrive_<from>` (the `info_teleport_destination`). `merge.mjs` proves every zone and arrival
against the city's space model (floor, headroom, dry, no brush entity in the way, a clear line between them)
and stops the build on any that fails.

The portals are the map's own: `portals.mjs` draws `sprites/h9_portal_<city>.spr` (64 × 64, 24 frames,
additive, one loop every two seconds). A named `env_sprite` starts switched off unless spawnflag 1 is set,
so every portal sets it.

## Bots

`node waypoints.mjs` lays RCBot's waypoints over the three cities as one set (SMAK's `waypointsOf`, on the
merged brush source) and joins the six travel zones into it: a waypoint in the middle of each zone, flagged
TELEPORT, whose one path goes to the waypoint at its partner's arrival point; no other waypoint or path
touches a zone. RCBot's A* charges nothing for a path out of a TELEPORT waypoint, so a bot bound for another
city walks into a portal and goes on from where it lands.

- Doors and breakables are as they stand in the game: a door that nothing in the map ever opens is a wall to
  the walk (209 door names), and so is every `func_breakable`; a door a button or trigger opens is walked
  through.
- Lifts and trains are not ridden (RCBot cannot ride a `func_train`), so a bot does not reach every floor:
  Xenon's floors above and below its spawn floor, and Alexandria's two halves (Midgar and Golgotha), hang on
  them. Paradise's bots leave home by both of its portals and reach all of Paradise, Alexandria's south half
  and Xenon's lower level; Xenon's bots leave by their portal to Alexandria and reach its north half.
  Wherever a portal puts a bot, another portal is within walking reach.
- Paradise's way down to its portal to Xenon is a jump over the railing at the end of a tunnel, 233 down;
  the walk takes it and SMAK's paths do not, so the script joins it along the walk's own route (a JUMP
  waypoint, and one where it lands).
- 1,678 waypoints at a spacing of 160: more than stock RCBot's 1024 (which reads a longer file past the end
  of its array), so the map needs the patched RCBot (`rcbot-patch`, CHANGE 6: 4096 a map).

`node waypoints.mjs deploy` copies the `.rcw` into `<Half-Life>\rcbot\waypoints\ts\` and
`H9XASH\rcbot\waypoints\ts\`. RCBot works the visibility table out on the map's first load
(`rcbot\visibility\ts\h9_tsrp_hive.rcv2`).

## Compiling

The map is far past BSP29's limits (122,132 faces; BSP29 allows 65,535 vertices) and SDHLT v1.2.0 has no
BSP2 switch: its hlbsp stops at `Exceeded MAX_MAP_VERTS`. Xash's own limits accommodate it (524,288 verts,
262,144 faces, 131,072 planes, 524,288 clipnodes), so it is compiled in SDHLT's Xash mode, which writes BSP2:

```
node merge.mjs                 # rewrite out/h9_tsrp_hive.map
node spawns.mjs                # rewrite out/tsm_spawns_h9_tsrp_hive.cfg from it
node merge.mjs --compile --compilers "D:/Downloads/TSM/export-map/sdhlt-goldsrc-net/tools" --xash
```

`--compile` is the draft: fast vis, full bounced rad. `--full` adds full vis (hours on this map); `--bsp` is
hlcsg + hlbsp only (geometry and the final leak check). `--xash` gives every tool `-engine xash`: vis and rad
refuse the BSP2 hlbsp wrote without it. The `--compilers` folder is searched for `hlcsg.exe`, `hlbsp.exe`,
`hlvis.exe`, `hlrad.exe` (or the `_x64` / `sdHL*` names SMAK recognises); `HIVE_COMPILERS` or `VHLT_DIR`
does the same without the flag. Use `sdhlt-goldsrc-net\tools`: the hlvis in
`compilers-xash\sdhlt-v1.3.1-xash` dies on this map with a stack buffer overrun.

**Temp space:** the compilers write the 25 MB intermediate BSP and four 30 MB hull files under `%TEMP%`.
With 4.9 MB free on C: hlcsg ended in `Error: File write failure`; point `TEMP`/`TMP` at a drive with room
(D:, for example) before compiling.

## What was repaired in the decompiled sources

- 8 Alexandria brushes with one `!seawater` face among solids → contents settled.
- 24 brush entities carrying both an `origin` key and an ORIGIN brush → redundant key stripped.
- 9 sub-unit sliver brushes, 7 no-volume brushes, 3 open brushes whose polygons ran to ±1048576 → pruned.
- 10 brushes with near-duplicate planes → duplicate face removed.
- 29 empty Alexandria brush entities dropped.
- All face plane points re-pointed within 32 units of their brush (same plane, winding and texture axes),
  so hlcsg's bounds stay sane.
- Per-city name prefixes `pc_` / `al_` / `xe_` on `targetname`, `target`, `master`, `killtarget`,
  `LaserTarget` and `multi_manager` keys, a name a `multi_manager` fires more than once (`oven_hurt#1`)
  keeping its `#1`, and on a `path_corner`'s or `path_track`'s `message`, the name it fires as a train passes.
- Alexandria's lab gate (`midgar.lab.gate.one`) opens from the console panel beside it, `labentbutton`: a
  `func_door` that does not move and fires the gate each time it toggles. The source left it with a name and
  no Use flag, so nothing reached it; it gets the flag (256) beside its toggle (32).
- One sky (`blue`) and one sun (Alexandria's `light_environment`); the other two suns were dropped.
- Alexandria's own map-authored `ts_groundweapon` pickups (5) dropped entirely: they sit 40-88 units above
  the nearest floor in the raw decompile itself, not something this merge introduces.
- `func_illusionary` fence/grate meshes (24 across Alexandria and Xenon) reclassified to `func_wall`:
  `func_illusionary` is non-solid by engine design regardless of texture, so these rendered correctly but
  had no collision at all in the decompiled source.
- Alexandria's 3 tube "jump assist" `trigger_push` entities, orphaned brushless in the b4v3 decompile,
  regeometered from a newer decompile (`alexandria_msr_b5.bsp`) of the same map: confirmed byte-identical
  coordinate frame between the two (no transform needed) via two independent landmarks, so the real brush
  geometry is grafted in verbatim. A 4th orphan (`spawn.push`) was left alone: its geometry sits entirely
  below the z=-1600 cut, inside the bunker this layout already removes.
- Xenon: a leaning wall the decompiler wrote on off-grid planes, with see-through cracks, is snapped back
  onto the original map's two whole-unit planes (27 faces across 24 brushes), and two tapering sliver brushes
  in front of a `cyberwall1` wall are dropped so the wall itself shows. Each repair first checks the brushes
  it expects and stops the build if they differ.
- hlrad runs with real bounce lighting (no `-fast`) while hlvis stays fast: large areas were pitch black
  under the original all-fast draft compile. hlvis's `-fast` and hlrad's `-fast` are independent flags on
  the same tools; passing `args.hlvis` only keeps the auto-added `-fast` off hlrad's own argv.
- Texture lights: each city was compiled with a texture-light list (a `lights.rad`) that did not ship with
  it, so the textures it lit (Alexandria's spotlights, grates and signs, Xenon's shop signs) would light
  nothing here. The merged map carries one `info_texlights`: the cities' own keys, plus the emitters
  `texlights.mjs` finds in each city's original compile of the very source merged here (textures whose
  faces are lit at full brightness all over), at the kit's calibrated value where it has one and otherwise
  at a starting value for its kind, scaled by what `calibrate.mjs` measured. 82 in all; a texture no face
  wears is left out. The originals are `alexandria_msr_b4v3.bsp` (Steam `ts_downloads`),
  `paradisecity_revival_final.bsp` and `xenoncity_true_b3v2.bsp` (the Specialists Archive's
  map-resources); a later release of a city is lit differently and is no measure of this one.
- Texture substitutes: `MARB052` → `CDS_TILEFWHITE`, `PO_HTLCARPET` → `GREENCARPET`.
- Every city is enclosed in an invisible 4-unit `NULL` shell just inside its own bounds. The decompiled
  Alexandria shell leaks to the void on its own; with the shells, every point entity is inside a sealed box.
  The shell stays thin because hlcsg lets the later brush win: a thicker one buries the real faces at a
  city's edge and opens see-through walls. The build stops if any drawn face lies inside a shell.

`checkPlan` still reports 482 brushes with a zero-area face (decompiler leftovers). They are kept on
purpose: those face planes bound their brushes, and hlcsg accepts them.

## Assets

The cities' props, sprites and sounds are their own, not TS 3.0's. The 47 models and 49 sounds H9XASH
lacked were copied into `H9XASH\ts` from the Steam TS install (`ts`, `ts_downloads`) and from
github.com/The-Specialists-Archive/map-resources; `ambience/jd_guitar.wav` is in neither and stays silent.
They are third-party map assets. The 27 Half-Life sounds the cities' doors, buttons, trains and sparks pick
by number (`common/null.wav`, `doors/doormove4.wav` and the rest) are H9's own, made with SMAK, in
`H9XASH\valve` (`valve\REPLACEMENTS.md`); the tree, `models/h9/pi_treeb.mdl`, is H9's own too.

## Deploying

```
copy out\h9_tsrp_hive.bsp            D:\Downloads\TSM\H9XASH\ts\maps\
copy out\h9_tsrp_hive.map            D:\Downloads\TSM\H9XASH\ts\maps\
copy out\tsm_spawns_h9_tsrp_hive.cfg D:\Downloads\TSM\H9XASH\ts\addons\amxmodx\configs\
```

`node portals.mjs` writes the portal sprites into `H9XASH\ts\sprites` itself, and `node waypoints.mjs deploy`
the bots' waypoints into the bot folders.
`H9XASH\ts\mapconfigs\h9_tsrp_hive.cfg` sets `tsm_no_weapons 1`; with `h9_autoconfig 1` the engine runs it
once the map's plugins are up. `D:\Downloads\TSM\export.bat` then copies H9XASH to the git working copy.
The merged map does not replace any existing map file.
