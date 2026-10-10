===============================================================================
 TS MATCH MODE -- SERVER PACKAGE
===============================================================================

 Everything needed to run team elimination match mode on The Specialists 3.0,
 laid out in the same shape as a Half-Life install.

 THIS FOLDER IS GENERATED. Do not edit anything in it. export.bat rebuilds it
 from the sources on every clean build, so hand edits are lost without warning.
 Edit D:\Downloads\TSM instead.

 See VERSION.txt for which build this is.


===============================================================================
 WHAT IS IN HERE
===============================================================================

 src\                         the plugin source and its build scripts
   ts_matchmode.sma           the match mode itself
   ts_probe.sma               a diagnostic plugin, not required
   build.bat                  compile + deploy; edit TSROOT at the top
   export.bat                 regenerates this package

 ts\                          drops straight over the mod folder
   game.cfg                   REQUIRED -- see below
   server.cfg
   listenserver.cfg
   addons\amxmodx\plugins\    the compiled plugin
   addons\amxmodx\configs\    ts_matchmode.cfg and the per-map spawn sets
   addons\amxmodx\scripting\  source, so the server can recompile itself
   addons\metamod\plugins.ini loads AMXX and rcbot

 rcbot\                       drops into the Half-Life folder, NOT into ts\
   dlls\rcbot_mm.dll          win32, PATCHED -- fixes bots attacking their
                                own team. Stock rcbot decides TS teams by comparing
                                player model strings, so teammates wearing different
                                models read as enemies.
   dlls\rcbot_mm.so           linux, STOCK. Using it brings the bug back.
   waypoints\ts\              TS waypoints -- bots cannot navigate without them
   *.ini                      rcbot's own configuration

 docs\COMMANDS.txt            every console command this plugin provides


===============================================================================
 INSTALLING ON ANOTHER MACHINE
===============================================================================

 Assuming Half-Life is at  <HL>  and the mod at  <HL>\ts :

 1. AMX Mod X 1.8.2 and Metamod must already be installed and working.
    Confirm with  meta list  and  amxx version  before going further.

 2. Copy  ts\      over  <HL>\ts
    Copy  rcbot\   over  <HL>\rcbot          <-- beside ts, not inside it

 3. Add the plugin to  <HL>\ts\addons\amxmodx\configs\plugins.ini :

        ts_matchmode.amxx

 4. Check  addons\metamod\plugins.ini  has both lines, rcbot second:

        win32   addons\amxmodx\dlls\amxmodx_mm.dll
        win32   ..\rcbot\dlls\rcbot_mm.dll

    rcbot declares PT_STARTUP, so it must be present when the server starts.
    It cannot be loaded later with  meta load .

 5. Start the server and run  amx_tsm_debug . The BUILD line should match
    VERSION.txt. If it does not, the old binary is still loaded.


===============================================================================
 ts\game.cfg IS NOT OPTIONAL
===============================================================================

 TS chooses its gamerules ONCE per map load, inside CWorld::Precache, and the
 first thing it does there is exec game.cfg:

     exec game.cfg
     g_teamplay = DecideGamePlay(mapname, mp_teamplay)
     if (g_teamplay > 0) -> CHalfLifeTeamplay      teams work
     else                -> CHalfLifeMultiplay     teams are a no-op

 On CHalfLifeMultiplay every team function is an inherited stub: GetTeamIndex
 always returns -1, GetIndexedTeamName always returns "", and ChangePlayerTeam
 is a single ret. So  jointeam  silently does nothing, get_user_team reads -1,
 no TeamInfo message is ever sent, and the scoreboard has nothing to draw.

 server.cfg cannot do this job. hlds execs server.cfg only AFTER the first map
 has spawned, so mp_teamplay arrives after the decision was already made.
 game.cfg is read at the only moment that matters.

 mp_teamlist and mp_teammodels are in there for the same reason: the
 CHalfLifeTeamplay constructor parses them immediately after game.cfg runs, and
 nothing re-reads them for the life of the map. Changing either at runtime has
 no effect until the next map load.


===============================================================================
 TWO THINGS THAT WILL WASTE YOUR AFTERNOON
===============================================================================

 Team names are capped at 15 usable characters.
     TS copies the name with  strncpy(m_szTeamName, pTeamName, 16)  and does
     not terminate it. A name of exactly 16 characters leaves no room for the
     terminator and corrupts every later comparison -- that side then cannot be
     joined by anyone, silently. "insurrectionists" is exactly 16, which is why
     the internal name is "insurgents". Display names are set separately with
     tsm_team2_label and can be as long as you like.

 Waypoints are required for bots.
     rcbot will not navigate a map without  rcbot\waypoints\ts\<mapname>.rcw .
     44 TS maps ship with one. For anything else, use  rcbot autowaypoint 1
     and walk the map. h9_te_neuropolis is NOT among the bundled set.
