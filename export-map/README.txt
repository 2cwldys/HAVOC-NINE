=================================================================================
 export-map\ -- growing h9_te_neuropolis into a sunken city
=================================================================================

 The working folder for the map, as modelling\ is for the models. SMAK itself is
 the kit in ..\smak and stays exactly as it came; this is where our own scripts,
 output and notes live.

 THE ORIGINAL IS NEVER WRITTEN TO. The hand-built map in the game folder is only
 ever READ. Everything this folder makes goes to out\. The one exception is
 `make.mjs deploy`, which copies the finished .bsp into the game and keeps a
 backup of the old one first -- and it only happens when you type it.

   lib.mjs         where everything is: SMAK, the game, the wads, the compilers
   roundtrip.mjs   THE GATE: proves the base map survives a read and a write
   compilers.mjs   the SDHLT compilers, copied under the names SMAK looks for
   textures.mjs    what there is to build with, and what the base already wears
   city.mjs        what gets added to the base -- the city itself
   make.mjs        the whole loop: read, grow, check, draw, compile, deploy
   out\            everything written. GENERATED -- delete it freely.

 Node 18 or later. SMAK has no dependencies.


=================================================================================
 START HERE
=================================================================================

     node roundtrip.mjs          proves the base survives being read and written
     node compilers.mjs          puts the compilers where SMAK can find them
     node textures.mjs           what there is to build with
     node make.mjs               check and draw -- seconds, no compile
     node make.mjs compile       build the .bsp into out\
     node make.mjs compile fast  a rough draft: quicker light, rougher
     node make.mjs deploy        compile, then copy it into the game

 Look at out\*_plan.png and out\*_reach.png after every run. They cost a tenth
 of a second and catch what a compile takes minutes to tell you, or never does.


=================================================================================
 THE THINGS THAT CATCH PEOPLE OUT
=================================================================================

 1. THE SPAWNS ARE NOT IN THE MAP. ts_matchmode puts players at the points in
    configs\tsm_spawns_h9_te_neuropolis.cfg, so they are nowhere in the .map
    file and NOTHING WILL WARN YOU if a wall is built through one. lib.mjs
    reads them with spawnPoints() and make.mjs hands them to grow(); hold the
    two base areas still around them. The cfg is written by amx_tsm_spawn_save
    whenever the spawn points are re-saved in game, so check it before a build:
    it now holds sixteen per team (32 lines). Team 1 fills about x -843..-329,
    y -326..-945, team 2 about x 3555..3883, y 323..981, all at z 36.

 2. SMAK CANNOT READ .rmf OR .jmf. J.A.C.K.'s native file is not understood --
    only .map. So once the city is grown, h9_te_neuropolis.rmf is out of date.
    To go on hand-editing, import out\h9_te_neuropolis.map into J.A.C.K.; that
    loses what only the .rmf holds, such as visgroups and saved cameras.

 3. CARVE, DO NOT PLACE WALLS. carve(rooms, wall, textures) takes boxes of EMPTY
    SPACE and wraps them in rock. What is not a room is rock, so a map built this
    way cannot leak -- which is the commonest way a GoldSrc map fails. A doorway
    or a window is one more small room through the rock between two.

 4. EVERYTHING WITHIN 4096 OF THE ORIGIN, on each axis. GoldSrc sends positions
    in 16 bits at eighths of a unit, and that is as far as it reaches.

 5. ADD AT THE END, CHANGE NOTHING. grow() appends to brushes and entities and
    leaves what was already there alone. That is what keeps the base yours.


=================================================================================
 THE COMPILERS
=================================================================================

 SMAK runs the four GoldSrc compilers and looks for them by their VHLT names:
 hlcsg_x64.exe, hlbsp_x64.exe, hlvis_x64.exe, hlrad_x64.exe, with their tool
 textures beside them as zhlt.wad.

 This machine has SDHLT -- seedee's fork, which the base map was built with --
 and everything in it carries an "sd" prefix, so SMAK finds nothing. SDHLT takes
 the same arguments, so compilers.mjs simply copies the five files under the
 names SMAK expects, into compilers\. It touches neither smak\ nor SDHLT itself.

 Run it again whenever SDHLT is updated; it copies only what has changed.

 TEXTURES TRAVEL INSIDE THE .bsp. The base map was compiled with -nowadtextures,
 so the server needs no .wad files beside it. SMAK's name for the same thing is
 wadinclude: true, which make.mjs passes. Confirm it on any build with:

     node ..\smak\bin\smak.mjs map-info out\h9_te_neuropolis.bsp

 and look for "with their pixels inside the map, 0 wanted from .wad files".


=================================================================================
 RCBOT'S WAYPOINTS -- waypoints.mjs
=================================================================================

 RCBot (the metamod plugin the servers run) walks a map by its waypoints alone:
 a file of points the bot may stand on, and which it may move between. This
 script makes one for the city from the compiled .bsp, with SMAK's waypoint
 engine (smak\src\maps\waypoints.mjs).

     node waypoints.mjs           generate into out\ (.rcw + a plan to look at)
     node waypoints.mjs deploy    and copy it into the places the bot reads

 Two things the kit did not figure out on its own for THIS map:

 - THE WALK IS SEEDED WITH THE SPAWNS. There are no spawn entities in the
   .bsp (see 1. above), and the walk goes nowhere without a place to start --
   so all the tsm_spawn points are handed in as starting places.

 - THE SIZES, probed against the kinds of waypoint SMAK lays. This city is too
   big for the 1024 waypoints RCBot has room for (bot_const.h MAX_WAYPOINTS,
   the size of its array; a longer file would overflow it at load) at SMAK's
   defaults: any spacing between 300 and 1200 units leaves 1150+ points, held
   up by ~640 CORNER waypoints, which barely respond to spacing. Making the
   walk's grid coarser (cell 8 -> 16) smooths the walk's pieces and drops the
   corners to ~500 with every jump, flight and opening surviving; spacing 1000
   then fits: 1013 points, 98 of them to jump from, 150 at the ends of 75
   flights and ramps, 71 in openings, 490 corners, 32 at the spawns.

 Where the bot looks -- its bot folder is "rcbot" beside each game folder
 (there is no rcbot_folder.ini in ts\), so NOT the copies under ts\addons\rcbot,
 which are only the shipped pack:

   live (hlds):    Half-Life\rcbot\waypoints\ts\h9_te_neuropolis.rcw
   H9XASH (xash):  H9XASH\rcbot\waypoints\ts\h9_te_neuropolis.rcw

 deploy copies to both, and if a .rcw is already there it moves it to
 ..\backups\waypoints-h9_te_neuropolis-<stamp>\ first. The visibility table
 beside them (rcbot\visibility\ts\<map>.rcv) is not ours to make: the .rcw
 carries the owed-visibility bit, and the bot works the table out on the
 FIRST map load, then rewrites the .rcw without the bit. So the first load is
 slower, and the .rcw it loads afterwards is its own, not ours.

 The plan it draws, out\h9_te_neuropolis_waypoints.png, is the map from above
 with a cross at each waypoint (yellow at a spawn, magenta to jump from, blue
 a ladder, cyan crouching, red the rest) and paths (green both ways, orange
 one way). Ladders came out at 0 -- the city has none a bot may climb; drops
 and jumps carry the heights. The 15+8 points the walk could not route to or
 back from (the WARN lines) are left out of the file: a bot sent anywhere else
 could not get home.

 The waypoints follow the .bsp in out\, so REGENERATE them after every compile
 that changes the map -- node waypoints.mjs, then node waypoints.mjs deploy.


=================================================================================
 WHAT IS PROVEN
=================================================================================

 The baseline, before a single brush was added:

   roundtrip.mjs  21 brushes, 3 entities, 124 faces, 11 textures, all identical
                  after a read and a write, and stable on a second write
   checkPlan      0 errors, 0 warnings, no way out to the void
   compile        all four compilers code 0, about two seconds
   the result     407360 bytes -- the same size as the .bsp J.A.C.K. made
   textures       10 of 10 inside the map, 0 wanted from .wad files

 So the pipeline is equivalent to the one that built the map in the first place.
 Anything that breaks after this is the city, not the plumbing.
