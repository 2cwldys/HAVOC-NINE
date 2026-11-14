WAYPOINT COVERAGE TOOLS -- measuring and filling the bots' waypoints on H9's objective maps
============================================================================================

RCBot walks only along a map's waypoints (rcbot\waypoints\ts\<map>.rcw). With objective play on (docs\BOT_OBJECTIVES.txt,
rcbot-patch README CHANGE 11) it sends bots to the Assault points, the Uplink zones and the uplink, the flags and pads. A
post with no waypoint near it is played badly or not at all. These tools measure that, and add the waypoints that are
missing. They are plain Node scripts (Node 24, no packages), single thread, a few seconds a map.

Put the folder at tools\waypoints\ of the project (the doc text says so) or run it from anywhere: every path is read from
the project through the environment variables below, with these defaults.

    H9_TSM         D:/Downloads/TSM
    SMAK           <H9_TSM>/smak                      SMAK is READ ONLY here: its BSP reader, its space of a compiled map
                                                      (a player's hull walked over the map, door by door) and its .rcw reader
    H9_MAPS        <H9_TSM>/H9XASH/ts/maps            <map>.bsp
    H9_CFG         <H9_TSM>/H9XASH/ts/addons/amxmodx/configs        tsm_assault_/tsm_uplink_/tsm_ctf_/tsm_spawns_<map>.cfg
    H9_MAPCFG      <H9_TSM>/H9XASH/ts/mapconfigs      a map's own cvars (tsm_as_radius, tsm_cap_radius, tsm_cf_pad_radius)
    H9_WAYPOINTS   <H9_TSM>/H9XASH/rcbot/waypoints/ts    the .rcw files measured, and the input of lay.mjs

FILES
    h9wp.mjs       the shared part: where the files are; the objectives of a map as the plugins read them; the .rcw file
                   (read with SMAK's strict reader, written by its own writer: SMAK's stops at 1024 waypoints, the patched bot
                   holds 4096 and h9_as_lift has 1263); RCBot's own searches copied from rcbot-patch\src\bot.cpp (the
                   bucket-of-256 nearest-waypoint search, ObjFillRingWaypoints, ObjWaypointUsable); and a player's walk.
    coverage.mjs   the measurement. node coverage.mjs [map ...] [--rcw-dir DIR] [--json FILE]
    lay.mjs        the filling. node lay.mjs <map ...> | --all [--out DIR] [--in FILE] [--through-doors]
    check.mjs      the check of a result on its own. node check.mjs <map> <file> [--orig FILE] [--allow-doors] [--reach]
    show.mjs       a text picture of the floor around an objective. node show.mjs <map> <AS1|CAP2|UPLINK|PAD1|x,y,z>
                   [--rcw FILE] [--orig FILE] [--span 320] [--cell 16]
    README.txt     this file

WHERE THE OBJECTIVES COME FROM (what each plugin reads; a config's line wins over the map's entity of the same number)
    Assault   configs\tsm_assault_<map>.cfg  tsm_as_zone <n> <x> <y> <z> [radius]   else entities tsm_as_<n> (radius
              tsm_as_radius, 384; a brush is as wide as it is)
    Uplink    configs\tsm_uplink_<map>.cfg   tsm_cap <n> <x> <y> <z> [radius], tsm_uplink_at <x> <y> <z>   else entities
              tsm_cap_<n> (radius tsm_cap_radius, 128) and tsm_uplink
    Flags     configs\tsm_ctf_<map>.cfg      tsm_cf_pad <side> <x> <y> <z>            else entities tsm_flag_<side>
    Spawns    configs\tsm_spawns_<map>.cfg   tsm_spawn <side> <x> <y> <z> <pitch> <yaw> [tier]   (tier 0 the base)
    The mode of a map is its name's prefix (h9_as_, h9_up_, h9_ctf_), else which config it has. The h9_as_ and h9_ctf_ maps
    still carry the Uplink's tsm_cap_N entities: they are not read there (their mapconfig says tsm_uplink_mode 0).

WHAT COVERAGE MEASURES, per objective (the rule of each is the rule in bot.cpp, so a number here is what the bot sees)
    ring      goal waypoints within 0.6 of the radius across the floor and within 72 of floor + 36 (no ladder, lift, jump,
              crouch, teleport, stunt, aiming or other special flag), at most 12, nearest the middle first; how many a ring
              wants (ringWant: 3 to 6 by its size, so that up to 4 bots spread); none inside: the nearest waypoint within 400
              of the middle, one in sight first, and the last stretch walked straight (and whether a player walks it)
    uplink    the nearest waypoint within 400 of the mark (origin + 36), one in sight first; the last stretch
    pad       the same for the flag standing on it, and the guard ring (0.6 of 192) around it
    reach     from the waypoints nearest the tier-0 spawns of each side, along the paths (they are one way where a drop is),
              every goal waypoint is reached (forward) and reaches a spawn again (back): "R" both, "r" forward only, "b" back
              only, "-" neither; two letters, side 1 and side 2
    spawns    for each side and tier: the spawns whose nearest waypoint (within 400) does not exist, the farthest nearest one,
              how many waypoints are reached from the group and reach it
    STATUS    OK, THIN, OUTSIDE, NONE, UNREACHED, FAR (docs\BOT_OBJECTIVES.txt, "Waypoints")

WHAT LAY ADDS (constants at the top of lay.mjs)
    for each ring with fewer goal waypoints that are on the bots' graph (reached from the bases and back) than ringWant
    wants: waypoints on the ring's own floor (within 20 of it, reached by a flood on a grid of 16 within 0.6 of the radius
    of the middle), away from walls (24 of room where there is, 16, then 8), never in water over the ankles, on a belt, a
    moving platform, a hurt or push brush, on the top of something that breaks, or within 24 of another waypoint; the
    middle first, then each the farthest from those there are (at least 0.45 of the hold distance, 48 to 112);
    on the uplink spot and on each pad: a waypoint on the mark (unless one within 60 that sees it already stands there, on the
    graph), and for a pad a guard ring of two;
    beside any spawn whose nearest waypoint is over 200 away.
    PATHS from each new waypoint, both ways, to the plain waypoints (no flag but an informing one) and new ones within 400, the
    nearest first, up to 5, none where two shorter ones go round (1.1), each a line that
      - a player walks both ways: steps up of 18 at the most, down of 18, a floor not steeper than 0.7, FINE (2) units at a
        time on SMAK's space of the compiled map with every door a wall and every breakable a wall;
      - has room beside it (12, less near an end that stands in less room): the hull fits 12 units to each side;
      - a bot at one end sees the other (the line between the origins touches nothing solid);
      - is no place of the kinds above.
    CHAINS: when new waypoints reach no waypoint of the graph by such a line, a Dijkstra over the grid of 16 from them to the
    graph (cost the length, more where there is little room; at most 300000 cells within 2600 units) is pulled tight into
    legs of at most 160 that such a line walks, a waypoint at the end of each, never within 28 of a door; the chain is
    joined the same way. Nothing is found when the room is walled off (every door a wall): see DOORS.
    NEVER: a waypoint moved, deleted, reflagged or renumbered (the first 50, where the bots roam to, stay as they are);
    two old waypoints joined; a drop, a ladder, a jump or a crouch; a door (but --through-doors); a file but the one in the
    folder given by --out (it refuses the input's own name). Flags of every new waypoint: 0.
    The file's header flag W_FILE_FL_READ_VISIBILITY (bit 0) is set, so rcbot works the visibility table out when the map
    next loads and saves the .rcw again with the bit clear.

THE VISIBILITY FILE (.rcv2) is not made here. The format says a table is ceil(count^2 / 8) bytes and rcbot ignores one of
another size, so the old file of a changed map is dead; rcbot works the table out again on the map's first load (a trace for
each pair within 2048: a few seconds for 1300 waypoints) and writes it, with the engine's own traces. A table worked out from
SMAK's trace of the world alone (export-map\rcbot_vis.mjs does that for the city maps) differed from the shipped
h9_as_drainage.rcv2 in 826 of its 35900 visible pairs (it saw 823 more), so none is made here. Delete
H9XASH\rcbot\visibility\ts\<map>.rcv2 when the new .rcw goes in; the file rcbot writes replaces it.

DOORS. A bot never opens a +USE door (spawnflag 256): rcbot has no code for a door but a breakable one (CHANGE 6). When no
door-free walk joins an objective to the rest of the map, lay.mjs waypoints the room inside, leaves it unjoined and says
SEALED. h9_as_neuropolis is the case: the two doors named tsm_eng_door (x -608..-416 and 3488..3680, y -1536..-1504; the
Combat Engineer class opens them, ts_matchmode.sma fw_door_use) are the only way into the rooms of Assault points 1 and 6, which
SMAK's reachOf, with jumps, drops and ladders, confirms. --through-doors lays the chain through the door too (one path a door,
one waypoint each side of it, never in it): it is a second file, to be chosen by the owner.

HOW A RESULT IS CHECKED (check.mjs, which shares no state with lay.mjs)
    1. the file reads (SMAK's strict reader), is the map's, holds at most 4096 waypoints
    2. nothing old changed; the old paths of each waypoint are still the start of its list
    3. each new waypoint: flags 0, feet on a floor of the map, none of the kinds above, no other waypoint within 20
    4. each path with a new end: once, a way back, walked both ways, room, clear to the eye, no hazard, no door
    5. --reach: SMAK's reachOf (steps, drops, jumps, ladders, every door but the engineer doors open) from the spawns walks to
       each new waypoint's floor. Waypoints in a room only a door opens to are warned about, not failed.
    The walk test was also tried on the maps' own waypoints: of 2105 random pairs of old waypoints (60 to 300 apart, one level)
    with no line of sight between them, none passes it; of 1500 old two-way level paths on each of h9_up_drainage and
    h9_as_neuropolis, 58 and 47 percent pass every rule here (SMAK's own rule leaves less room beside a path), so the rules are
    stricter than the ones the old waypoints were made by.

LIMITS
    Nothing here has been run with a live bot. The tools measure what the code reads and walk what a player walks; a bot
    steers by its own rules and can still stick at a corner. Moving platforms (func_train, func_plat), lifts and ladders are
    not modelled; a waypoint is never laid on one, and a path never uses one. An objective on a lift needs the waypoints the
    walker already laid. The walk takes a breakable as a wall. A map with a map-made door that opens by a button is a wall.

NEW MAP
    1. objectives: configs\tsm_<mode>_<map>.cfg, or tsm_as_N / tsm_cap_N / tsm_flag_N entities, and tsm_spawns_<map>.cfg
    2. a .rcw for it: export-map\waypoints.mjs (SMAK's walker), seeded with the spawns
    3. node coverage.mjs <map>; node lay.mjs <map> --out D:\temp\x; node check.mjs <map> D:\temp\x\rcbot\waypoints\ts\<map>.rcw --reach
    4. look at what it did: D:\temp\x\_added\<map>.txt, node show.mjs <map> AS1 --rcw <the new file>
    5. copy the .rcw to Half-Life\rcbot\waypoints\ts\ and build; delete the map's old .rcv2
    A new mode or a new kind of objective: coverage.mjs measures from the same rules as bot.cpp (the OBJ table in h9wp.mjs);
    when CHANGE 11's constants change, change that table.
