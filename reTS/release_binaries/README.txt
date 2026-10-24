reTS v0.0.2-22-g08620706 with Metamod-R and AMX Mod X (reTSX), for a Windows TS 3.0 server

  ts/dlls/mp.dll, ts/cl_dlls/client.dll, ts/delta.lst, ts/resource/trackerscheme.res   reTS v0.0.2-22-g08620706
  ts/addons/metamod/dlls/metamod.dll   Metamod-R (buildchain drop-in, hlds-dropin-windows-i386-v1.0.9.zip), and a
                                       plugins.ini that loads AMX Mod X
  ts/addons/amxmodx/                   AMX Mod X 1.10 (same drop-in), with the core (amxmodx_mm.dll),
                                       reTSX (tsx_amxx.dll) and the reTS gamedata from the AMX Mod X
                                       fork's tsx-ts3 (756873eb)

Installing:
1. Move Half-Life/ts/addons somewhere else, and back up ts/dlls and ts/cl_dlls.
2. Copy this zip's ts folder over Half-Life/ts.
3. From your old addons, bring back what is yours:
   - addons/metamod/plugins.ini: your other Metamod plugins (RCBot, ...), next to the amxmodx line
   - addons/amxmodx/configs: users.ini, and your lines in plugins.ini, modules.ini, amxx.cfg
   - third-party modules (addons/amxmodx/modules) and your plugins' data files
   - your plugin sources (.sma): put them in addons/amxmodx/scripting and recompile them with
     compile.exe there, then copy the .amxx files to addons/amxmodx/plugins
4. Start the server.

Why the whole set: stock AMX Mod X's TS module and Ham Sandwich use TS 3.0's memory offsets and
function slots, which reTS does not have. reTSX asks reTS for player data instead, and the reTS
gamedata gives Ham Sandwich reTS's own slots.

MANIFEST.tsv lists every file with its sha256.
