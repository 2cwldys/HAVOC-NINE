===============================================================================
 export-map\ -- growing h9_te_neuropolis into a sunken city
===============================================================================

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


===============================================================================
 START HERE
===============================================================================

     node roundtrip.mjs          proves the base survives being read and written
     node compilers.mjs          puts the compilers where SMAK can find them
     node textures.mjs           what there is to build with
     node make.mjs               check and draw -- seconds, no compile
     node make.mjs compile       build the .bsp into out\
     node make.mjs compile fast  a rough draft: quicker light, rougher
     node make.mjs deploy        compile, then copy it into the game

 Look at out\*_plan.png and out\*_reach.png after every run. They cost a tenth
 of a second and catch what a compile takes minutes to tell you, or never does.


===============================================================================
 THE THINGS THAT CATCH PEOPLE OUT
===============================================================================

 1. THE SPAWNS ARE NOT IN THE MAP. ts_matchmode puts players at the sixteen
    points in configs\tsm_spawns_h9_te_neuropolis.cfg, so they are nowhere in
    the .map file and NOTHING WILL WARN YOU if a wall is built through one.
    lib.mjs reads them with spawnPoints() and make.mjs hands them to grow();
    hold the two base areas still around them. Team 1 is around y +730..+900,
    team 2 around y -430..-900, all at z 36.

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


===============================================================================
 THE COMPILERS
===============================================================================

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


===============================================================================
 WHAT IS PROVEN
===============================================================================

 The baseline, before a single brush was added:

   roundtrip.mjs  21 brushes, 3 entities, 124 faces, 11 textures, all identical
                  after a read and a write, and stable on a second write
   checkPlan      0 errors, 0 warnings, no way out to the void
   compile        all four compilers code 0, about two seconds
   the result     407360 bytes -- the same size as the .bsp J.A.C.K. made
   textures       10 of 10 inside the map, 0 wanted from .wad files

 So the pipeline is equivalent to the one that built the map in the first place.
 Anything that breaks after this is the city, not the plumbing.
