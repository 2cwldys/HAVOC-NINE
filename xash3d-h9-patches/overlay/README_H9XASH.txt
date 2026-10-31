===============================================================================
 H9XASH -- The Specialists 3.0 with the H9TE client, on Xash3D FWGS
===============================================================================

 What this is
 ------------
 A ready-to-run Xash3D FWGS install of The Specialists 3.0 with H9's client on
 top: reTS game libraries, H9's maps, models, sounds and sprites, and the purple
 UI. It is built in layers, each one over the last:

   1. Stock TS 3.0          the original 2007 install (ts-3-final.exe)
   2. reTS                  the rebuilt game libraries: cl_dlls\client.dll,
                            dlls\mp.dll, delta.lst (its own Metamod/AMXX bundle
                            is left out: layer 6 brings H9's)
   3. H9TE client           H9's ts\ content, purple textschemes and resource\
   4. Xash overlay          gameinfo.txt, userconfig.cfg, gfx\shell\colors.lst,
                            this file, h9xash.bat
   5. Engine                Xash3D FWGS, 32-bit, built from xash3d-fwgs\ with the
                            webassembly patches and H9's own (below)
   6. Server side           Metamod, AMXX with ts_matchmode, and RCBot -- the live
                            Steam install's ts\addons and rcbot\, so a listen server
                            here runs H9 matches with bots exactly as Steam TS does

 ts_advertise.cfg here is an EMPTY template on purpose: the real one holds the
 Discord bot token, and a local test server would post its matches to Discord. Put
 a token in this copy only if that is what you want; it is never overwritten, and
 it is git-ignored.

 NO HALF-LIFE NEEDED
 -------------------
 valve\ here is H9's own, not Half-Life's: replacements made for HAVOC 9 for every
 Half-Life file TS and its maps use, under the same names, and Xash's own
 extras.pk3. valve\REPLACEMENTS.md lists each one and where it comes from. Nothing
 copies Half-Life's files in. Keep valve\ next to HAVOC 9.exe: without it the game
 stops at once with "couldn't load gfx.wad".

 Starting the game
 -----------------
     h9xash.bat                     main menu, with a random menu track
     h9xash.bat -dev 2 -log         the same, with a full engine.log
     h9xash.bat +map h9_te_neuropolis

 h9xash.bat picks the menu track from ts\menu_music.txt (one file per line from
 ts\sound\music\), and the menu background video from ts\menu_bg_videos.txt (one file
 per line from ts\media\, same format) -- add more .avi files there to have it pick a
 different one each launch. Set ui_background_video 0 to turn the video off entirely.
 Then it runs  HAVOC 9.exe -game ts -console .

 Command reference
 -----------------
 Type exec commands in the game console to print the command reference: the text of
 COMMANDS.txt, line for line.

 Discord rich presence
 ---------------------
 Show what you are playing on your Discord profile: the map, the players and the
 bots, and on a siege map the progress. It is on by default, while the Discord desktop
 app is open. To turn it off, put this in the console, or in ts\userconfig.cfg to
 keep it:

     ts_richpresence 0

 Set it back to 1 to turn it on again. docs\RICH_PRESENCE.txt has what the card
 shows.

 Finding servers and joining them
 --------------------------------
 The Internet tab shows the FWGS public list, plus any server lists named in
 networking.ini, which sits next to h9xash.bat:

     [client]
     list_static=https://example.org
     list_bot=http://127.0.0.1:8081
     steam_broker=0

 Every launch rewrites ts\xashcomm.lst and ts\networking_resolved.cfg from that
 file, so edit networking.ini and start the game again. A server list is a small text
 file the game fetches from <address>/v1/servers/ts. Each line is "ip host:port" for
 an Xash server. list_bot points at the H9 list bot (TSM serverlist-bot\), a small
 service that tracks which servers are actually up -- docs\NETWORKING.txt section 7
 has its setup and a port it's best to avoid on Windows. docs\NETWORKING.txt has the
 full guide: the file format, how to run a list on your own machine for testing, and
 the Steam trade-offs.

 Steam
 -----
 H9XASH is not a Steam game, so Steam does not know it until you add it:

   * Non-Steam shortcut. Close Steam, then run h9_add_to_steam.ps1 from this folder.
     Use -DryRun first to see what it would change. It adds a HAVOC 9 entry that
     starts h9xash.bat. Or add it by hand: Steam > Add a Game > Add a Non-Steam
     Game, choose h9xash.bat, and rename it HAVOC 9.

   * Steam broker, for servers that need Steam sign-in. The broker is NOT in this
     folder. Put steam_broker.exe and steam_api.dll in a steam\ folder next to
     h9xash.bat, set steam_broker=1 in networking.ini, and keep Steam running and
     logged in. While the broker runs, Steam may file the game under Spacewar (480)
     instead of HAVOC 9, because the broker is the program that starts Steam's
     session. The AppID is set in networking.ini, under [broker].

 What is different from the Steam install
 ----------------------------------------
 * The purple VGUI colours are built into the engine's own vgui.dll (FWGS ships
   freevgui, an open VGUI1, so Valve's patched vgui.dll does not apply here).
   Patch: TSM\xash3d-h9-patches\patches\freevgui-h9-scheme.patch.
 * The cloak on your own model: the Steam install binary-patches client.dll; here
   the engine does the same job for any client.dll. The cvar cl_h9_cloakfix
   (default 1) turns it off. Patch: TSM\xash3d-h9-patches\patches\engine-h9-cloak.patch.
 * The menu track plays: FWGS's menu asks for media\gamestartup on its first
   frame, and the engine stops the playing track before it finds TS has none.
   It now asks only when the game has one, as GoldSrc's menu does.
   Patch: TSM\xash3d-h9-patches\patches\mainui-h9-gamestartup.patch.
 * exec takes a whole config, as GoldSrc's does: the command buffer holds 256 KB
   (ts_matchmode.cfg is about 86 KB).
   Patch: TSM\xash3d-h9-patches\patches\engine-h9-cmdbuf.patch.
 * The mouse still turns your view while you type in say or say_team, as on
   GoldSrc. Patch: TSM\xash3d-h9-patches\patches\engine-h9-chatmouse.patch.
 * Sudden death: every living enemy glows through walls, Insurgents red and MSR
   blue (renderfx 64, drawn with the depth test off), and the map fogs over from
   the server's h9_fog_* cvars. Patches: engine-h9-xray.patch and
   engine-h9-suddendeath.patch, in TSM\xash3d-h9-patches\patches.
 * Xash's main menu reads gfx\shell\colors.lst, not resource\trackerscheme.res;
   the purple colours are carried over there. The menu background is still H9's
   resource\background tiles.
 * gameinfo.txt sets max_edicts 2048 for H9's maps. Xash rewrites gameinfo.txt
   when liblist.gam is newer, so leave liblist.gam's date alone.

 Patched DLLs
 ------------
 Every DLL here that differs from its upstream build has <name>.patch beside it:

   xash.dll, ref_gl.dll,         source diffs against FWGS master, written by
   filesystem_stdio.dll,         xash.bat on every engine build, so they always
   menu.dll, vgui.dll            match the binaries next to them
   ts\dlls\mp.dll                reTS: the 81-slot carry ceiling lifted (2 bytes),
                                 and ts_matchmode's powerup grant under nopowerup 1
                                 (only while tsm_enabled is on)
   ts\addons\amxmodx\modules\    reTSX: Xash's ID_BOT bots count as bots
     tsx_amxx.dll
   rcbot\dlls\rcbot_mm.dll       rcbot-ts-teams.patch (teams, follow, cloak)

 Rebuilding
 ----------
 This folder is GENERATED by TSM\xash3d-h9-patches\xash.bat and exported to git by export.bat.
 Edit the sources in TSM, never the copy here:

     xash.bat engine      build the engine from TSM\xash3d-fwgs (MSVC, 32-bit)
     xash.bat assemble    lay the layers into TSM\H9XASH
     xash.bat addons      refresh only the server side (build.bat runs this
                          after every deploy)
     xash.bat assets      refresh only the client files from export\ts and the
                          overlay (export.bat runs this before it copies
                          H9XASH; a file newer here is kept)
     xash.bat             all of it

 Not here yet: 64-bit, and the browser build (emsdk) -- the webassembly patches
 are applied to the engine source already.
