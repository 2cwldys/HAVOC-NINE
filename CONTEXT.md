# CONTEXT.md

Where things live, and what the build, export and engine scripts do, in order. The rules for working with them are in CLAUDE.md.

## Where things live

| Place | What it is |
|---|---|
| D:\GIT Storage\hl2te\dynamic-campaign | This repo. The Dynamic Campaign gamemode, packaged as an addon (addon.json and gamemodes\dynamiccampaign; the gma and gmaddir files suggest Garry's Mod). It also holds the MCP tooling, these notes, and tools.zip. |
| D:\Downloads\TSM | The source of truth for TS Match Mode (ts_matchmode.sma and .cfg) and for H9XASH. Holds build.bat, export.bat, xash3d-h9-patches\xash.bat and the generated folders export\ and H9XASH\. |
| D:\GIT Storage\ts_h9_team_elimination | The git working copy that export.bat mirrors export\ into. Commits need the user's OK. |
| D:\SteamLibrary\steamapps\common\Half-Life | The live install. The mod is ts\. The AMX Mod X folder is ts\addons\amxmodx (TSROOT in build.bat). hlds.exe runs the server. |
| D:\Downloads\TSM\xash3d-fwgs | The Xash3D FWGS engine source, a recursive git clone. Local branch h9, upstream origin/master. |
| D:\Downloads\TSM\AMXMODX | AMX Mod X master with H9's edits, branch h9. build.bat keeps its plugins in step. |
| D:\Downloads\TSM\ts3.0 | The stock TS 3.0 base (ts\). The user installs it from ts-3-final.exe. The scripts do not ship it. |
| D:\Downloads\TSM\rcbot-patch | The patched RCBot source, for TS team logic. |
| D:\Downloads\TSM\decompile_dll | Scratch area for the binary patches to reTS (mp.dll, tsx_amxx.dll). Not part of the build. |
| D:\Downloads\TSM\emsdk | The Emscripten SDK, for the planned browser build. Not started. Not part of the Windows build. |
| D:\GIT Storage\Aurora-Persistence | A BYOND (Space Station 13) project with its own build scripts: scripts\debug-compile.ps1 and scripts\db_update.ps1. |

## The TS pipeline, in order

1. `build.bat` (in D:\Downloads\TSM). Compiles, deploys, registers.
2. `xash.bat addons` (run by build.bat on a clean build). Copies the server side into H9XASH.
3. `export.bat` (run by build.bat on a clean build). Runs `xash.bat assets` first, then assembles export\ and mirrors it into the repo.

Separately, `xash.bat engine` builds the engine, and `xash.bat assemble` lays out a fresh H9XASH from the base game, reTS, the H9TE client, the overlay and the user's Valve files.

A typical change: edit the TSM sources, run `build.bat` (it deploys and exports), restart the server fully. Rebuild the engine only when the engine source changed.

## build.bat, step by step

The top of the file sets TSROOT to D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx. Edit it if the install moves. HLROOT is three levels up from it.

1. Stops if amxxpc.exe or the plugins folder is missing.
2. Targets: ts_matchmode, ts_probe, ts_advertise and ts_floatchat. `build.bat name` builds one plugin. `build.bat all` builds every .sma in the folder.
3. Copies each .sma into the game's scripting folder, and into AMXMODX\plugins.
4. Copies each .cfg into the game's configs folder. ts_advertise.cfg is created once and never overwritten, because it holds the Discord token.
5. Copies sound and resource files into the mod folder: sound\*.wav into ts\sound, sound\music into ts\sound\music, and likewise sound\death, sound\weapons and sound\start. resource\ goes to ts\resource. A sound name that a plugin uses must exist, or the map fails on load.
6. Copies textscheme\*_textscheme.txt into ts\. Copies vgui.dll and its patch into the Half-Life root. These carry the purple menu colours.
7. Installs the AmxxEasyHttp module, its CA file and easy_http.inc, but only when they are missing.
8. Copies rcbot's bot_config.ini to the Half-Life rcbot folder and to ts\addons\rcbot.
9. Compiles each target with amxxpc from the game's scripting folder, into compiled\. Copies the result to the plugins folder. A failed copy usually means the server is holding the file.
10. Registers each plugin in configs\plugins.ini. The file may not end with a newline, so a bare newline is written first, or two names would fuse together.
11. If hlds.exe is in the Half-Life root, deploys ts.bat, restore_originals.bat and discord-bot\ there.
12. On a clean build only: runs `xash.bat addons`, then `export.bat`.
13. Prints the summary, and reminds you to restart the server fully and run amx_tsm_debug.

ts_floatchat is built and exported, but never registered. That is on purpose.

## export.bat, step by step

Writes the package to D:\Downloads\TSM\export, then mirrors it into the repo. export\ is generated, so nothing in it is edited by hand.

- src\: the .sma files, build.bat, export.bat and xash.bat.
- docs\: COMMANDS.txt, MAP_ENTITIES.txt, FLOATED_PRECACHES.txt, and the docs folder (audio formats, engine differences, spawn points, networking, rich presence).
- The compiled plugins, copied from compiled\ and not from the server, so a failed build cannot ship an old binary.
- Configs: ts_matchmode.cfg, ts_advertise.cfg and ts_advertise.sma from TSM. The per-map spawn sets (configs\tsm_spawns_*.cfg) from the live install. game.cfg, server.cfg and listenserver.cfg from the live ts folder.
- At the package root: install-rcbot.bat. Under plugins\ and configs\: the Metamod plugins.ini, RCBot, the Discord bot, serverlist-bot (without its cfg and log), the presence art (presence\, which includes menucard.png and maps\), restore_originals.bat, models.bat, a fallback .gitignore, the class-icon sprite, the client UI, sounds, and the VGUI menu files.
- The map: the .bsp, the .map source, the skybox .tga files, and export-map\. h9_te_neuropolis.map is the one hand-built input that nothing else can recreate.
- compts\ (the ELO plugin, webserver and models) and webassembly-patch\.
- H9XASH\: `xash.bat assets` runs first, then a /MIR copy without valve\ (only extras.pk3 travels), logs, saves, config.cfg, ts_advertise.cfg, RCBot's player ids, or the Steam binaries.
- xash3d-h9-patches\ without deps and stage. xash3d-fwgs\ without .git, build and the waf files. AMXMODX\ without .git and build. SMAK\ from smak\.
- VERSION.txt. Its build number comes from the `#define TSM_BUILD` line in ts_matchmode.sma.
- Mirror into the repo: `robocopy /E /XO`, excluding .gitignore, bot_playerids.ini and export-map. Nothing is purged.

## xash.bat, step by step

Run it from D:\Downloads\TSM\xash3d-h9-patches. It works out the TSM folder from its own location. Modes: no argument (engine, assemble, addons), `engine`, `assemble`, `addons`, and `assets`.

### engine
1. Needs xash3d-fwgs\wscript. Downloads SDL2 2.32.10 into deps\ if it is missing.
2. If the engine is a git repo, applies its patches in order, skipping any already in place (`git apply --reverse --check` runs first). The webassembly patches come first: engine-library_suffix, engine, engine-mainui and freevgui. Then H9's: freevgui-h9-scheme, engine-h9-cloak, engine-h9-cmdbuf, engine-h9-chatmouse, engine-h9-suddendeath, engine-h9-xray and mainui-h9-gamestartup.
3. Configures waf only when build\c4che\_cache.py is missing, or when the cache points at a different SDL folder. The configure step uses release and --msvc_prerelease, because only a preview Visual Studio is installed.
4. Builds, then installs into stage\, which is cleared first.
5. Copies xash3d.exe, xash.dll, ref_gl.dll, menu.dll, filesystem_stdio.dll, vgui.dll, ref_soft.dll if present, and SDL2.dll into H9XASH. Copies valve\extras.pk3 into H9XASH\valve.
6. Writes ENGINE.txt.new (source, upstream commit, build commit, patch list), and merges it into ENGINE.txt with dllmerge.
7. Writes a `<dll>.patch` for xash.dll, ref_gl.dll, filesystem_stdio.dll, menu.dll and vgui.dll. Each holds what the DLL is, then the whole change against origin/master (the working tree is staged into a temporary index, so new files count), then a history block: when it was built, the working tree status, and the h9 commits that touch its paths. Each is merged with dllmerge.

### assemble (a fresh H9XASH)
1. Stock TS 3.0 from ts3.0\ts, but only files H9XASH does not have yet. Needs ts3.0\ts\liblist.gam.
2. reTS from export\reTS\ts, without addons.
3. The H9TE client from export\ts, without addons and cl_dlls. reTS's client.dll stays, because the engine does the cloak patch instead.
4. commands.cfg, built from COMMANDS.txt by make_commands_cfg.ps1. Then the overlay from xash3d-h9-patches\overlay. networking.ini is copied only when it is missing, because it is the player's own file.
5. Valve's Half-Life content from the Half-Life install, except extras.pk3.

### addons
Metamod, AMX Mod X (with ts_matchmode and the rest) and RCBot from the Half-Life install into H9XASH, without logs, bot_playerids.ini or ts_advertise.cfg. ts_advertise.cfg is copied from TSM only when H9XASH has none. The token is never copied from the live install.

### assets
export\ts into H9XASH with /XO, so edits made in H9XASH are kept. Then commands.cfg and the overlay again. export.bat runs this before it copies H9XASH.

## The .patch rules (dllmerge.ps1)

- A .patch has a header, which is kept as written. Then `== Patch history ==`, then the history blocks, then the diff body.
- Each history block starts with a `Generated` line, and ends with `Diff sha256 <hash>, the diff below.`.
- A new block is added only when it differs from the last one. The Generated line and the replaced-lines section are ignored in that comparison. An unchanged build adds nothing.
- Lines the old diff had and the new one does not are kept in the new history block, under "Lines of the previous diff that this build replaced, kept here:".
- The body is always replaced by the new diff.
- An empty new diff over a non-empty one is refused, and the file is left as it was. That usually means git failed, and writing it would erase the diff.
- ENGINE.txt is merged the same way, with no body.

## Gotchas that have bitten this project

- `sed -i` once flipped a 17,849-line CRLF file to LF. Use the exact-replace method in CLAUDE.md.
- The agent shell turns `\\` into `\`. Heredocs over about 8 KB were cut off.
- build.bat copies the .cfg files on every run, so server-side edits to them are lost. Edit the TSM copy.
- tsm_spawns_*.cfg exist only in the game folder, written by amx_tsm_spawn_save. export.bat copies them out, so the export is the only other copy.
- The Discord token lives only in the game folder's ts_advertise.cfg. TSM's copy must stay empty, because export.bat copies it.
- A running server locks the .amxx, so the copy into the plugins folder fails. build.bat says so when that happens.
- waf does not reconfigure by itself when the SDL path changes. A stale path caused LNK1104 on every build. Delete build\c4che to fix it.
- The repo copy of H9XASH is edited by hand, for configs and logs. export.bat keeps newer files, so a rebuild does not undo those edits.
- This machine's git is old. `git branch --show-current` does not exist here. Use `git rev-parse --abbrev-ref HEAD`.
- Visual Studio on this machine is a preview build (VS 2026 Insiders). The --msvc_prerelease flag exists for that.

## tools.zip

A barebones copy of the same tools for another project. It contains config.cmd (the paths and the KEEP_ONCE list), build.bat, export.bat, xash.bat (the engine and addons steps), dllmerge.ps1 (the same script, with one comment generalised) and README.md. It leaves out the project's plugin list, sounds, maps, the H9TE client, the stock base, the assemble and assets steps, and the web build. Its build, export, addons and missing-engine paths were run against a fake install. The engine build itself was not run.
