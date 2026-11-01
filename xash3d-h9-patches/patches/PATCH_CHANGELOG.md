# Patch changelog -- required reading and required editing

**Any agent or session that adds, edits, regenerates, splits, merges, or
removes a `.patch` file in this folder MUST add a dated entry to the log at
the bottom of this file in the same turn, before considering that work done.**
Not a suggestion -- this file exists because skipping it already broke a real
build. See 2026-10-23 below for exactly what that looked like.

## Why this file exists

`xash3d-h9-patches\xash.bat` re-verifies every patch here against the live
`xash3d-fwgs` source on **every build** (its `:patch` subroutine): it tries
`git apply --reverse --check`, and if that succeeds the patch is "in place"
and gets skipped; if it fails, it tries a forward `git apply` instead and
**stops the entire build** if that also fails.

That means a patch file only has to be *technically correct* once: the moment
its content drifts from reality -- another patch gets inserted before it in
the chain and shifts its line numbers, the file it touches gets rewritten by
a *different*, already-committed change on the `h9` branch, or someone hand-
edits the live source without regenerating the matching `.patch` -- it fails
silently (no error) **until the next full rebuild**, which then breaks for
whoever runs it, with no clue which of the 10+ patches is actually stale.
Reading this log before touching a patch, and writing an entry after, is the
only thing that keeps that lag from turning into exactly this.

Two different kinds of "patch" exist in this project and this file is only
about the first kind:
- **Tracked `.patch` files in this folder** -- re-verified on every build as
  described above. This log covers these.
- **Already-committed changes on the `h9` branch** (`git log --oneline` in
  `xash3d-fwgs`, e.g. `engine-h9-spraywad.patch`, `engine-h9-cloak.patch`'s
  own commit) -- baked into the branch, never re-verified by `xash.bat`,
  and a legitimate way for an earlier session's patch to become permanent.
  `git log` is the source of truth for these, not this file. But a *tracked*
  patch generated before one of these commits landed can go stale against it
  without anyone touching the tracked patch at all -- that is exactly what
  happened to `engine-h9-spraypicker.patch` below.

## Current patches, in `xash.bat` apply order

| # | Patch | Files | Purpose |
|---|-------|-------|---------|
| 1 | `engine-library_suffix.patch` | `3rdparty/library_suffix` | webassembly patch, library suffix part |
| 2 | `engine.patch` | engine-wide | webassembly patch, engine part |
| 3 | `engine-mainui.patch` | `3rdparty/mainui` | webassembly patch, mainui part |
| 4 | `freevgui.patch` | `3rdparty/freevgui` | upstream freevgui |
| 5 | `freevgui-h9-scheme.patch` | `3rdparty/freevgui` | H9's VGUI color scheme |
| 5a | `freevgui-h9-fonts.patch` | `3rdparty/freevgui` (`platform/win32/font.cpp`) | the game's own fonts: `<game>\resource\fonts\*.ttf/.otf` registered privately, `fonts.txt` there mapping requested faces onto them (docs/CUSTOM_FONT.txt) |
| 6 | `engine-h9-cloak.patch` | `cl_frame.c`, `cl_main.c`, `cl_view.c`, `client.h` | server-side cloak shown on your own model |
| 7 | `engine-h9-cmdbuf.patch` | `cmd.c` | command buffer holding H9's configs |
| 8 | `engine-h9-chatmouse.patch` | `input.c` | mouse-look stays on while typing in chat |
| 9 | `engine-h9-suddendeath.patch` | `server.h`, `sv_main.c`, `sv_phys.c`, `gl_rmain.c` | sudden-death fog: `h9_fog_*` server cvars into `movevars.fog_settings`, read back client-side |
| 10 | `engine-h9-xray.patch` | `gl_studio.c` | renderfx 64: sudden death's glow shells drawn through walls |
| 11 | `engine-h9-sprguard.patch` | `cl_sprite.c`, `dll_int/cl_game.c` | sprite query family answers 0 on a bad/unloaded HSPRITE instead of crashing |
| 12 | `engine-h9-spraypicker.patch` | `cl_main.c` (`CL_CreateResourceList`) | the bitmap picked from `ts\logos` is remapped into the player's own `tempdecal.wad`, sent under every protocol |
| 13 | `engine-h9-spraycmd.patch` | `cl_main.c` (new `CL_Spray_f`, registered in `CL_InitLocal`) | the `spray` console command: list/equip/unequip from the `ts\logos` shelf. **Applies after #12** -- its hunks assume spraypicker's `CL_CreateResourceList` rewrite already shifted the file |
| 14 | `mainui-h9-gamestartup.patch` | `3rdparty/mainui/BaseMenu.cpp` | menu startup behavior |
| 15 | `engine-h9-userid.patch` | `cl_main.c`, `client.h`, `identification.c` | `cl_h9_userid`: a plain, regenerable client id, salted per destination server via `ID_GetMD5ForAddressEx`, sent as userinfo key `h9_clientid`. **Applies after #12/#13** -- its `CL_InitLocal` registration hunk and connect-packet hunk are numbered against the file state *after* spraypicker+spraycmd. See `docs\CUSTOM_XASH_USERID.txt` |
| 16 | `engine-h9-presence.patch` | `cl_main.c`, `client.h`, `host.c`, `game_launch\game.rc`, `cl_presence.c` (new), `game_launch\havoc9.ico` (new, binary) | Discord Rich Presence: `CL_Presence_Init/Frame/Shutdown/ServerReply`, the exe icon swap to `havoc9.ico`. **Applies after #15** -- its `CL_InitLocal` registration hunk is numbered against the file state *after* userid's own registration line exists. See `docs\RICH_PRESENCE.txt` |
| 17 | `mainui-h9-sprayui.patch` | `3rdparty\mainui\menus\PlayerSetup.cpp` | Customize screen's logo picker: `Reload()` now chains up so it resyncs with console-side `spray`/`spray off`; `WriteNewLogo()` saves a colored pick back to the shelf file itself (`logos\<name>.<ext>`) instead of a now-unread `remapped.*`; a synthetic `none` row lets a player keep a hand-dropped `tempdecal.wad` as-is, visible and selectable instead of only an incidental, non-durable display fallback. Independent of `mainui-h9-gamestartup.patch` -- different function, no ordering dependency between the two |
| 17a | `mainui-h9-hover.patch` | `3rdparty/mainui/BaseMenu.cpp` | a hover sound: `uiSounds[SND_MOVE]` names `media/launch_move1.wav` |
| 18 | `engine-h9-autoconfig.patch` | `sv_main.c` (`SV_Init`), `sv_init.c` (`SV_ActivateServer`) | `h9_autoconfig` (default on): a second, independent per-map cfg lookup in its own `mapconfigs/<mapname>.cfg` folder, separate from the existing mapper-facing `maps/<mapname>_load.cfg` convention. The exec is queued right after `pfnServerActivate`, so the cfg runs after Metamod/AMXX plugins register their cvars and run their own configs, and overrides them. Server-host-facing, same audience as `engine-h9-userid.patch`. Independent of every other patch in this list -- no ordering dependency |
| 19 | `engine-h9-deltabits.patch` | `net_encode.c` (`Delta_ParseField`, new `Delta_H9WidenIndexField`) | widens `delta.lst`'s model-index fields (`viewmodel`, `modelindex`, `weaponmodel`) to `MAX_MODEL_BITS` and entity-index fields (`aiment`, `event_t.entindex`, `entity_state_t.skin`) to `MAX_ENTITY_BITS` (+1 when signed), `owner` to `MAX_CLIENT_BITS + 1`, when the local `delta.lst` is parsed. The server sends its tables to clients, so clients follow. Never touches `Delta_ParseTableField`: a client must use exactly the widths the server sends. Independent of every other patch -- no ordering dependency |
| 20 | `engine-h9-concolor.patch` | `dll_int/cl_game.c` | `pfnDrawConsoleString`: a string with no colour set is drawn in con_color (GoldSrc's way), so every chat line is, not white |
| 21 | `engine-h9-consolemusic.patch` | `sound/s_stream.c` | the main menu's music plays on while the console is open over the menu |
| 22 | `engine-h9-chatinput.patch` | `dll_int/cl_game.c`, `console.c` | the say: line under the chat lines, not at the top left |
| 23 | `engine-h9-bigworld.patch` | `server/sv_init.c` | big-world coordinates on for a map past +/-4096 |
| 24 | `engine-h9-websound.patch` | `sound/s_main.c` (`S_UpdateChannels`) | the browser build only (`#if XASH_EMSCRIPTEN`): the mixer skips the time a long frame already played instead of painting into it, and mixes at least 0.2 s ahead whatever `_snd_mixahead` says. The Windows build compiles as before |
| 25 | `engine-h9-cvarresync.patch` | `common/cvar.c` (`Cvar_SanitizeAndSet`) | setting a cvar to the string it already holds reads its value from that string again, as GoldSrc does, so a value the client DLL wrote directly (the HL SDK camera's `cam_idealpitch`/`cam_idealyaw`/`cam_idealdist`, `cam_snapto`) can be set back. Independent of every other patch -- no other patch touches `cvar.c` |
| 26 | `engine-h9-webmenu.patch` | `client/avi/avi_ffmpeg.c` (a new `#elif XASH_EMSCRIPTEN` branch), `common/system.c` (`Sys_Quit`), `platform/sdl2/vid_sdl2.c` (`Platform_Minimize_f`) | the browser build only: the main menu's background video (the CIN_MENUBG work) decoded by the page (`Module.video`, client.js) and drawn through the same `GL_UpdateTexture`/`R_DrawStretchPic` calls as the FFmpeg branch; `Sys_Quit` stops the frames and tells the page (`Module.callbacks.gameQuit`, with whether an error ended it) instead of longjmp-ing to a jump buffer the browser build never set; `minimize` asks the page (`Module.callbacks.gameMinimize`). The FFmpeg branch and the Windows build are untouched. Independent of every other patch -- no other patch touches these files |
| 27 | `engine-h9-phsbudget.patch` | `common/mod_bmodel.c` (`Mod_CalcPHS`) | no PHS for a world whose PHS would take more than 192 MB (New Byzantium's 46,744 leaves: 521 MB, which froze a 32-bit listen server or ran it out of memory while the map loaded), or whose rows would take more than 8 GB of merging (a later New Byzantium build, draft vis, 60% of its leaves seen from the average leaf: about 1,300 GB, hours of a frozen load); sounds and PAS messages then reach every player, by `Mod_FatPVS`'s own fallback. Below the budget the compressed PHS is sized in a first pass and allocated once instead of reallocated for every row. Independent of every other patch -- no other patch touches `mod_bmodel.c` |
| 28 | `engine-h9-motd.patch` | `client/cl_motd.c` and `client/cl_motd.h` (new), `cl_main.c` (`CL_ClearState`, `CL_Disconnect`, `Host_ClientFrame`, `CL_Init`, an include), `cl_view.c` (`V_PostRender`), `parse/cl_parse.c` (`CL_ParseUserMessage`), `input/in_keys.c` (`Key_Event`), `input/input.c` (`IN_MouseEvent`, `IN_Commands`) | the splash MOTD: the engine takes the `H9Motd` user message `h9_motd.sma` sends, holds TS's `MOTD` text while the splash loads, shows a server's picture (fetched over https, capped at 2 MB and 2048 px a side) or, for a web page, its picture or text with OPEN PAGE (system browser after a confirmation showing the address, on a click only), and hands the text to the client library when the splash fails; in the browser build `Module.motd` (client.js) shows it and answers with `h9_motd_result`. `cl_h9_motd 0` turns it off. **Applies after the whole chain**: its `cl_main.c` include hunk sits after `client.h`, clear of the context of `engine.patch`'s `msr_webauth.h` hunk (an include placed right after `msr_webauth.h` broke that patch's reverse check), and its other hunks are clear of cloak/userid/presence's. See `docs\H9_MOTD.txt` |

Not tracked here (already committed on `h9`, see `git log` in `xash3d-fwgs`):
`engine-h9-spraywad.patch` (the classic-HL "whatever's in tempdecal.wad IS
the spray" rewrite of `CL_CreateResourceList` that spraypicker above now
further builds on), and the webassembly/cloak/cmdbuf/chatmouse base commits
referenced by name in some of the rows above.

There's an existing (informal, undocumented-until-now) convention for this
exact situation: `patches\retired\` is where a tracked `.patch` file goes
once its content is permanently committed on `h9` and it no longer needs
`xash.bat`'s per-build reverse-check -- a historical copy, not a delete.
`engine-h9-spraywad.patch` went through exactly this (its commit date and
the file's retirement both land on 2026-10-23), which is how it was found
while investigating the entry below: safe in `git log`, but its retired copy
is currently an orphan in `export\` and the git mirror (robocopy's plain copy
mode never deletes a destination file that's gone from source) -- harmless,
just a stale leftover, not evidence of lost work.

Still currently uncommitted in the live `xash3d-fwgs` working tree, with
**no tracked patch file at all yet**: a menu-background-video struct
addition (`gameui_static_t.menubg_*` in `client.h`). Real, intentional
in-progress work -- not garbage, do not revert it -- but because it isn't
captured as a patch, `git stash`/`git checkout --` on `client.h` will
silently drop it, and a clean rebuild from scratch will not reproduce it.
If you touch this feature, this is a good time to give it its own tracked
patch instead of leaving it as loose working-tree state (presence, just
above, used to be in the exact same spot -- see the 2026-10-23 log entry for
how that one got fixed).

## Entry format

```
### YYYY-MM-DD -- <patch name(s)>
What changed, why, and what you verified (forward `git apply --check`,
reverse `git apply --reverse --check`, and/or a real `xash.bat` run).
```

## Log

### 2026-10-23 -- engine-h9-spraypicker.patch, engine-h9-spraycmd.patch (fixed), engine-h9-userid.patch (new)

A routine build (verifying new, unrelated `cl_h9_userid` engine edits) failed
on `engine-h9-spraypicker.patch` with "does not apply -- resolve it by hand."
Root cause, found by reading the patch's expected old-side content against
the real file: `engine-h9-spraypicker.patch` had gone stale. It was generated
against code that still had the pre-`engine-h9-spraywad.patch` sanitize/remap
logic in `CL_CreateResourceList` (an older `.patch` file's own base), but
`engine-h9-spraywad.patch` is an *already-committed* change on `h9` that
rewrote that same function to the simpler classic-HL form first -- so by the
time anyone ran a full chain rebuild, spraypicker's expected context no
longer existed anywhere. Nobody edited `engine-h9-spraypicker.patch` when
spraywad landed; it just quietly stopped matching reality and nothing
surfaced that until the next full rebuild.

While fixing it, found a second, related problem: `engine-h9-spraycmd.patch`
was a byte-for-byte duplicate of content that had *also* ended up folded into
the real uncommitted spray-picker hand-edit sitting in the working tree (the
`CL_Spray_f` command function and its registration) -- a leftover from before
that command was absorbed into the picker feature, never removed from
`xash.bat`'s chain. Left as-is, it would have either errored the same way or
silently double-applied once spraypicker was fixed.

Fix: regenerated `engine-h9-spraypicker.patch` to contain only the
`CL_CreateResourceList` remap rewrite (matching the current, post-spraywad
baseline), and regenerated `engine-h9-spraycmd.patch` to contain only the
`CL_Spray_f` function + its `Cmd_AddCommand` registration, correctly numbered
to apply *after* the fixed spraypicker. Verified both forward (`git apply
--check`) and reverse (`git apply --reverse --check`) against a from-clean-
HEAD reconstruction, not just against whatever happened to be in the working
tree at the time.

Also added `engine-h9-userid.patch` (new feature, see `docs
\CUSTOM_XASH_USERID.txt`) and registered it at the end of the chain. Its
`CL_InitLocal` registration hunk originally shared an anchor line
(immediately after `cl_ticket_generator`'s own registration) with the
uncommitted, not-yet-patched Discord-presence hook mentioned above -- moved
it to anchor after `cl_autorecord`'s registration instead so it does not
depend on presence's position at all. Verified forward+reverse against a
from-clean-HEAD-plus-spraypicker-plus-spraycmd reconstruction in a scratch
dir, not against hand-derived line arithmetic (got that arithmetic wrong
twice while working this out -- do not trust it, always verify against real
file content or a real `git apply --check`).

### 2026-10-23 -- engine-h9-presence.patch (new)

While adding `docs\CUSTOM_XASH_USERID.txt` to `export.bat`'s doc-copy list,
noticed `docs\RICH_PRESENCE.txt` was already there, describing Discord Rich
Presence as a finished, on-by-default, shipped feature (`ts_richpresence`
cvar, referenced from `ts\userconfig.cfg`). Checked: the feature was real and
fully wired (`CL_Presence_Frame()` called every frame from `host.c`'s
`Host_Frame`, confirmed via grep, not a stub) -- but it existed *only* as
uncommitted working-tree state across `cl_main.c`, `client.h`, `host.c`,
`game_launch\game.rc`, plus the untracked `cl_presence.c` (498 lines) and
`game_launch\havoc9.ico`. Exactly the risk flagged in the entry above: no
tracked patch, so `git stash`/`git checkout --`/a fresh clone would silently
lose a feature documented as already shipped.

Fixed the same way as spraypicker/spraycmd/userid above: captured a clean,
isolated patch via a from-clean-HEAD scratch reconstruction (chain-applying
the existing patches first, then adding just the presence hunks on top,
rather than diffing the live tree directly -- the live tree has userid,
menubg, and presence all mixed into the same two files). Verified forward
(`git apply --check`) and reverse (`git apply --reverse --check`) against
that reconstruction and against the real tree. Registered at the end of the
chain, after `engine-h9-userid.patch` (its `CL_InitLocal` hunk assumes
userid's registration line already exists).

### 2026-10-24 -- mainui-h9-sprayui.patch (temporary diagnostic added)

The user reports the new "none" entry from the 2026-10-23 entry below still
doesn't show in-game, despite every static check passing: the object file
and the linked `menu.dll` are both timestamped after the source edit (genuine
recompile, not a stale/cached build), no second `menu.dll` exists anywhere in
`H9XASH\` (no shadow copy), `cl_logofile` defaults to `"lambda"` which is a
real file (not an unmatched-cvar stuck state), `hideLogos` cannot be forced
true, `AddItem(logo)` is correctly reached, "Customize" has exactly one entry
point in the whole menu tree and it routes to the edited class, and
`CStringVectorModel` is a dynamic `CUtlVector` with no fixed capacity the
real logo files could be filling. Static analysis is exhausted.

Added a temporary `Con_Printf` at the end of `CLogosListModel::Update()`
printing the final row count, matching this project's own established
pattern (`engine-h9-suddendeath.patch`'s fog debug print) for exactly this
situation: get the one missing data point from a live session instead of
guessing further. Remove once the user confirms what it prints.

### 2026-10-23 -- mainui-h9-sprayui.patch (new)

Part of a separate, larger multi-codebase bug-fix pass (seven reported-broken
items across `ts_matchmode.sma`, this engine, RCBot, and waypoint data -- see
that session's plan file for the full account). This entry covers only the
patch-tracking side of the mainui piece.

Three real findings in `PlayerSetup.cpp`'s Customize-screen logo picker, none
previously tracked as a patch at all (this file had zero prior uncommitted
changes before this session -- confirmed via `git diff --stat` before
touching it, so this is a clean, newly-captured patch, not an untangling):
`Reload()` never chained up to `CMenuFramework::Reload()` (unlike sibling
menus), so the picker's selection went stale after a console-side `spray`
command on any visit after the first each session; `WriteNewLogo()` baked a
chosen color into pixels and saved to a fixed `logos\remapped.*`, a filename
the current engine's `CL_CreateResourceList()` no longer reads at all (it
converts `logos\<cl_logofile>.<cl_logoext>` directly) -- so a colored pick
through the menu was silently never used; and there was no menu entry at all
for "keep whatever's already in tempdecal.wad," by design gap rather than
bug, added as a new synthetic `none` catalog row.

Fixed the `WriteNewLogo` contract by writing straight to `filename` (the
same path `GetFullPath` already computes) instead of a separate
`remapped.*` file -- deliberately overwrites the shelf's own bitmap with the
recolored version, since `logos\*.*` is per-player customizable state, not a
read-only catalog. Caught one latent crash risk while adding the `none` row:
`UpdateLogo()` calls `CBMP::LoadFile()` then unconditionally dereferences the
result (`GetBitmapHdr()`) with no null check -- harmless today because every
real catalog entry corresponds to an actual file, but the new `none` entry
has none, so it needed the same `pos < 0`-style early-out the function
already uses, not a fix to the missing null check itself (left alone,
out of scope, every other call site still assumes a real file exists).

Verified forward (`git apply --check`) and reverse (`git apply --reverse
--check`) against the live submodule tree; confirmed the diff is exactly
these edits (`git diff --stat`, 5 hunks, no surrounding contamination)
before capturing it.

**Open suspicion, not yet confirmed:** the user raised that the sudden-death
green fog bug (investigated at length earlier, root cause never confirmed --
see session history) may be the same class of problem: a tracked patch
(`engine-h9-suddendeath.patch`, touches `server.h`, `sv_main.c`, `sv_phys.c`,
`gl_rmain.c`) silently going stale or incomplete relative to some other
change, rather than the plugin-side logic being wrong (which was already
proven correct by direct tracing). As of this entry, `engine-h9-suddendeath
.patch` reverse-checks cleanly ("in place") against the current tree, so it
is *not* currently stale in the way spraypicker was -- but that only proves
its tracked hunks match current content, not that those hunks still capture
the complete original feature. Worth a dedicated look before resuming that
investigation: diff the patch's own hunks against what the fog feature
actually needs to do, rather than re-tracing the plugin side again.

### 2026-10-26 -- engine-h9-autoconfig.patch (added earlier this day, now revised), engine-h9-deltabits.patch (new)

`engine-h9-autoconfig.patch` was added earlier on 2026-10-26 without a log
entry; this entry covers both its addition and today's revision. As first
written it queued `exec mapconfigs/<map>.cfg` in `SV_SpawnServer`, beside
`maps/<map>_load.cfg`. That ran too early: reTS's `CWorld::Precache` ->
`InstallGameRules` does `exec game.cfg` + `SERVER_EXECUTE` during worldspawn
(`reTS\dlls\gamerules.cpp:220-221`), flushing the whole buffer -- mapconfig
included -- before `pfnServerActivate`, which is where Metamod/AMXX run
`plugin_init`/`plugin_cfg` (AMXMODX `meta_api.cpp:681-684`). A cfg setting a
plugin cvar (`tsm_no_weapons 1`) hit "Unknown command", and the plugins'
global configs then ran after it and won. The exec now sits right after
`pfnServerActivate` in `SV_ActivateServer`, using `sv.name`. The `sv_main.c`
hunk only changed its comment and cvar help text.

Procedure (editing the .patch alone would have stopped the build: the old
hunks were in the tree, so neither the reverse check nor the forward apply
would succeed): reverted the old patch from the tree with `git apply
--reverse`, confirmed `sv_init.c` was back at HEAD and `sv_main.c` carried
only `engine-h9-suddendeath.patch`'s `SV_H9FogCvars();` line, made the edits,
then regenerated from `git diff` with suddendeath's hunk removed from the
`sv_main.c` section and no `diff --git`/`index` lines (the format every other
tracked patch uses).

`engine-h9-deltabits.patch` is new. `delta.lst` (TS/reTS ship the same file)
sends `viewmodel`, `modelindex` and `weaponmodel` in 10 bits, and
`Delta_ClampIntegerField` silently pins any larger value to 1023 (the warning
is `_DEBUG` only). `h9_tsrp_hive` reserves model slots 1..873 for its own
brush models before the game precaches anything, so every model past #1023 --
non-primary weapons and ~359 props/sprites -- drew as model #1023. The patch
raises those fields to `MAX_MODEL_BITS`, entity-index fields to
`MAX_ENTITY_BITS` (+1 signed), and `owner` to `MAX_CLIENT_BITS + 1`, at parse
time in `Delta_ParseField`, printing one console line per widened field per
run. Nothing else in the chain touches `net_encode.c`.

Verified: both patches reverse-check in place; round trip for each (`git
apply --reverse`, file back at HEAD, `git apply --check`, `git apply`, in
place again); then a reverse check of every patch in `xash.bat`'s order --
the four webassembly patches and all 19 here -- all in place. Registered
`engine-h9-deltabits.patch` in `xash.bat` after autoconfig, and added both
to its ENGINE.txt list and the `xash.dll` description.

### 2026-10-28 -- engine-h9-presence.patch (regenerated)

The card's details line now names every mode instead of only siege or "Match
Mode". New `H9P_Mode()` in `cl_presence.c`, in order: the server's
`tsm_pres_mode` key ("siege", "uplink", "survival", "mechwarrior"; a
non-empty `tsm_pres_siege` still means Siege, for older plugins); then the
map's name -- `h9_te_` Team Elimination, `h9_siege_` Siege, `h9_up_` Capture
the Uplink, `h9_mw_` Mech Warrior, `h9_ws_` Wave Survival, `h9_dm_`
Deathmatch, `h9_tdm_` Team Deathmatch, `h9_ctb_` Capture the Briefcase,
`h9_ctf_` Capture the Flag, and a name starting `rp_`/`tsrp_` or holding
`_rp_`/`_tsrp_` Roleplay; then "match" from an H9 server is Match Mode; and
anything else (a stock `ts_` map) is Deathmatch. `H9P_Activity()` adds the
progress `tsm_pres_prog` carries: each side's zones in Capture the Uplink,
the wave in Wave Survival. ts_matchmode 1.54-modes2 publishes
`tsm_pres_mode` as "match"/"siege"/the claimed mode's key whenever
`tsm_enabled` is on.

Only the `cl_presence.c` new-file section changed (498 -> 591 lines, blob
`ee2632a5`), rebuilt from the live file; the `cl_main.c`, `client.h`,
`host.c`, `game.rc` and `havoc9.ico` sections are untouched. Verified:
reverse check in place against the live tree; round trip (`git apply
--reverse`, `cl_presence.c` gone, `git apply --check`, `git apply`) with every
file byte-identical afterwards. No other patch touches `cl_presence.c`.

### 2026-10-31 -- freevgui-h9-fonts.patch (new)

VGUI1 text (the chat, menus, scoreboard, MOTD) took its fonts from Windows by
name, so only an installed font could be used. `FontPlat_Win32::init` in
`platform/win32/font.cpp` now, once per process: registers every `.ttf`/`.otf`
in `<exe dir>\<game>\resource\fonts` and `valve\resource\fonts` with
`AddFontResourceExA(FR_PRIVATE)` (the game is taken from `-game` on the command
line, `valve` without one); reads `fonts.txt` there (the game's, else valve's),
whose `font <asked> = <face> [size <percent>] [weight <n>]` lines map a requested
face onto another; and creates the GDI font in the mapped face, height and
weight. The font keeps the name and size it was asked for, which is what
freevgui's font cache matches on. Lines not starting with `font` (the console
line, comments) are ignored. See docs/CUSTOM_FONT.txt.

Made against freevgui HEAD c83f47f (freevgui.patch and freevgui-h9-scheme.patch
already committed there); the only file touched is `platform/win32/font.cpp`,
which neither earlier patch changes. Registered in `xash.bat` after the scheme
patch, in its ENGINE.txt list and the `vgui.dll` description. Verified: reverse
check in place against the live tree; round trip (`git apply --reverse`, file back
at HEAD, `git apply --check`, `git apply`, byte-identical, in place again); `xash.bat
engine` lists it in place and builds vgui.dll with font.cpp clean under werror.

### 2026-10-31 -- engine-h9-concolor.patch (new)

TS's chat sets a text colour once and then draws each of its lines with
`DrawConsoleString`. FWGS's `pfnDrawConsoleString` used the set colour for one
string and reset it to white, so only the first chat line came out in the set
colour and the rest white. GoldSrc draws a console string with no colour set in
the player's con_color. Now `pfnDrawConsoleString` uses the colour set by
`pfnDrawSetTextColor` for the next string only, and draws a string with none set
(alpha 0: never set, or used by the string before) in `g_color_table[7]`, the
console's colour from con_color.

Made with `git diff` against xash3d-fwgs HEAD 17c23c81; `cl_game.c` had no
uncommitted change from another patch (sprguard's part of it is committed).
Registered last in `xash.bat`, after deltabits, and in its ENGINE.txt list and
the `xash.dll` description. Verified: reverse check in place against the live
tree; round trip (`git apply --reverse`, `cl_game.c` back at HEAD, `git apply
--check`, `git apply`, byte-identical, in place again); `xash.bat engine` lists
it in place and builds xash.dll with `cl_game.c` clean.

### 2026-10-31 -- engine-h9-consolemusic.patch (new)

`S_StreamBackgroundTrack` stopped feeding the background track whenever the
console was open: a track started from the menu (the main menu's `mp3 loop`) is
paused when `key_dest` is anything but `key_menu`, and the console is
`key_console`; on a background map the console paused it outright. Opening the
console over the main menu froze the music until it closed. Now a menu track
plays while `key_dest` is `key_menu` or `key_console`, and the background-map
branch no longer pauses for the console; a track started in a game still pauses
in the menu as before.

Made with `git diff` against xash3d-fwgs HEAD 17c23c81; no other patch touches
`s_stream.c`. Registered last in `xash.bat`, after concolor, and in its
ENGINE.txt list and the `xash.dll` description. Verified: reverse check in place
against the live tree; round trip (`git apply --reverse`, `s_stream.c` back at
HEAD, `git apply`, byte-identical, in place again); `xash.bat engine` lists it
in place and builds xash.dll with `s_stream.c` clean.

### 2026-10-31 -- engine-h9-chatinput.patch (new)

The line typed into with `messagemode` / `messagemode2` (say:, say_team:) was
drawn by `Con_DrawNotify` at the top left of the screen, below the notify lines,
unless the client exports Xash's `pfnChatInputPosition`, which no GoldSrc client
does, TS's included; TS's chat lines are at the bottom left. Now the client's
DrawConsoleString is `pfnDrawConsoleStringNoted`, a wrapper beside the
`gEngfuncs` table that notes, per frame (`host.framecount`), the left edge and
bottom of the strings drawn in the lower-left area (x under a third of the width,
y below half the height: the chat) and then calls `pfnDrawConsoleString`;
`CL_ChatLinesPosition` hands the position over. `Con_ChatInputPosition`, used
by both `Con_DrawNotify` (the line) and the input rect for on-screen keyboards,
lets the client's `HUD_ChatInputPosition` move it first; when that leaves it
where it was, the line goes under the chat lines, or with none on screen where
the HL SDK's chat area ends (x 10, one line above the 60-pixel HUD margin).
"Leaves it where it was" matters: reTS's client.dll exports the HL SDK's own
`HUD_ChatInputPosition`, which moves the line only while spectating, so a rule
of "only for clients without the export" (the first version) never applied
under H9XASH. The HUD is drawn before the console overlay in `V_PostRender`, so
the position is from the same frame.

A wrapper rather than lines in `pfnDrawConsoleString`, because that function is
engine-h9-concolor.patch's hunk: a second patch inside it would make concolor
fail `xash.bat`'s reverse check (the first try did exactly that and stopped the
build at concolor). Made from snapshots of the two files as the tree had them
(cl_game.c carrying concolor uncommitted). `CL_ChatLinesPosition` is declared in
`console.c` rather than `client.h`, which other patches change. Registered after
consolemusic, last in `xash.bat`, and in its ENGINE.txt list and the `xash.dll`
description. Verified: concolor, consolemusic and chatinput all reverse-check in
place together against the live tree; round trip (`git apply --reverse`, both
files back to their snapshots, `git apply`, byte-identical); `xash.bat engine`
lists every patch in place and builds xash.dll with both files clean.

### 2026-10-31 -- mainui-h9-hover.patch (new)

The menu plays `uiStatic.sounds[SND_MOVE]` when the pointer moves onto another
item (`CMenuItemsHolder::MouseMove`) and when the arrow keys move the cursor
(`CMenuItemsHolder::Key`), but FWGS's `uiSounds[]` leaves that slot empty, so the
menu had no hover sound. The patch names `media/launch_move1.wav` for it; as for
the other menu sounds, a missing `media/` file is looked for under
`sound/common/`, where valve_replacements' `tools/make_menu_sounds.mjs` writes it.
`SND_ROLLOVER` stays empty: nothing in mainui plays it.

Made from a snapshot of `BaseMenu.cpp` as the tree had it (an uncommitted hunk at
its lines 36-43 from another patch, well away from `uiSounds[]`); LF line
endings, as the index stores the file and the other mainui patches are.
Registered in `xash.bat` after mainui-h9-sprayui, in its ENGINE.txt list and the
`menu.dll` description. Verified: it and engine-mainui, mainui-h9-gamestartup and
mainui-h9-sprayui all reverse-check in place together against the live tree;
round trip (`git apply --reverse`, `BaseMenu.cpp` back to its snapshot, `git
apply`, byte-identical); `xash.bat engine` lists it in place and builds menu.dll
with `BaseMenu.cpp` clean.

### 2026-10-31 -- engine-h9-presence.patch (regenerated)

The Discord card showed mixed-up values ("Siege 6", "Alive: MSR 6/siege"):
`H9P_Activity` kept the pointers from eight `Info_ValueForKey` calls, but that
function returns one of four static buffers it reuses in turn, so the last four
reads wrote over the first four (side 1's total became the mode key, the siege
progress an alive count). Each value is now copied into its own local buffer as
it is read, and the attacking side and the mode are worked out after the copies.

Only the `cl_presence.c` new-file section changed (591 -> 596 lines, blob
`88907ed4`), rebuilt from the live file; the other sections are untouched.
Verified: reverse check in place against the live tree.

### 2026-10-31 -- engine-h9-bigworld.patch (new)

A map wider than the stock +/-4096 box (New Byzantium) needs two things past it. WRITE_COORD, which carries
the positions of temp entities, sounds and the like, is a 16-bit count of eighths of a unit (+/-4096) unless
the engine's ENGINE_WRITE_LARGE_COORD feature is on (whole units, +/-32768); and the origin fields of
`ts\delta.lst` (entities 16 bits / 8, players 18 / 32, events 16 / 8: +/-4096) are widened alongside this
patch (to 19 / 8, 21 / 32, 19 / 8; clientdata 23 / 128, custom entities 19 / 8: +/-32768), the server
sending its tables to every client. Engine features come from a game's physics interface, which TS has
not, so `SV_SpawnServer` now turns ENGINE_WRITE_LARGE_COORD on itself when the world model's bounds reach
past +/-4096, and off again for a map that fits (only if it turned it on, so a game that asks for it keeps
it). The features reach each client in svc_serverdata, as before.

Made from a snapshot of `sv_init.c` as the tree had it (engine-h9-autoconfig.patch's hunk in
`SV_ActivateServer` is far from this one, by the world's load); both reverse-check in place together.
Registered last in `xash.bat`, after chatinput, in its ENGINE.txt list and the `xash.dll` description.
Verified: reverse check in place against the live tree.

Also `sv_game.c`'s `pfnWriteCoord`: with big-world coordinates on, the first test map
(h9_tsrp_bigtest) was stuck in TS's slow motion. The game DLL's own user messages are read by its client
library, whose READ_COORD divides by 8 whatever the engine does, so a value TS sends with WRITE_COORD came
out an eighth of itself. A coordinate written into a user message (`svgame.msg_index` 0 and up) keeps the
classic eighths now; the engine's own messages (temp entities and the like, read by the engine) take
big-world's whole units.

### 2026-11-01 -- engine-h9-websound.patch (new)

For the browser build of the engine (the H9 web client, havoc9.org\webclient). A frame in a browser can
run long: a game file is fetched the first time the engine reads it, and many players draw through
software WebGL. When a frame outlasts `_snd_mixahead`, the sound device has played past `paintedtime`;
`S_UpdateChannels` then painted from the old `paintedtime`, into ring-buffer space the device had
already played, and that late sound was heard a whole buffer later: doubled sounds, garble in a fight.
Quake's mixer moved `paintedtime` up to `soundtime` in that case; this tree had lost that. The patch
puts it back after `S_GetSoundtime`. It also mixes at least 0.2 s ahead, whatever `_snd_mixahead`
says: a first version gave the cvar a default of 0.2, but TS 3.0's own config.cfg, the one a new
browser player starts with, sets `_snd_mixahead "0.1"`, and the browser's log showed 0.1 in force.
The cvar keeps its 0.12 default and its definition is untouched.

Both changes are inside `#if XASH_EMSCRIPTEN`, so the Windows build compiles exactly as before (the
catch-up would help a native hitch too; it was kept to the browser so H9XASH is unaffected). Written
for H9 from the description in havoc9.org\webclient\DEPLOY.txt section 11; no file of the msr-web kit
was copied.

Made with `diff -u` against xash3d-fwgs HEAD's `s_main.c` (no other patch, tracked or webassembly,
touches that file, so it cannot overlap another patch's context). Registered last in `xash.bat`, after
bigworld, in its ENGINE.txt list and the `xash.dll` description. Verified: `git apply --check` against
the live tree; applied; reverse check in place; round trip (`git apply --reverse`, `s_main.c` back at
HEAD, `git apply --check`, `git apply`, byte-identical); then a reverse check of every patch in
`xash.bat`'s order, all in place. Built for the browser with emsdk 6.0.12 (`waf build`, werror on,
clean) in a copy of the tree, webclient-build\xash3d-fwgs, and run in Opera GX: the engine reaches the
main menu with the mixer up ("Using SDL audio driver: emscripten @ 44100 Hz").

### 2026-11-01 -- engine-h9-cvarresync.patch (new)

Third-person camera cvars set from the console could stay where the client had put them. The HL SDK
camera that TS's client keeps (reTS `cl_dll\in_camera.cpp`) writes `cam_idealpitch`, `cam_idealyaw` and
`cam_idealdist` through the cvar pointer in `CAM_Think` (`->value`, the string untouched), and its
`snapto` command flips `cam_snapto->value`. `Cvar_SanitizeAndSet` returned early when the new string
equalled the stored one, so after `+camin`/`+camout`/`+campitchup`/`+cammousemove`/`snapto` had moved a
value, setting the string the cvar still held (`cam_idealdist 100`, `cam_snapto 0`) changed nothing.
GoldSrc's `Cvar_DirectSet` copies the string and re-reads the value on every set. Now the early return
first reads the value from the string again and calls `Cvar_Changed` when it differs; the string, the
userinfo and the "changed to" broadcast stay as before. This covers the console, configs,
`Cvar_Set`/`Cvar_SetValue` from the DLLs and the menu (all through `Cvar_DirectSet`). The `set` and
`reset` commands (`Cvar_Set2`, FWGS's own, not in GoldSrc) keep their own early return.

Note for whoever reads this about the camera: TS's camera does not use `cam_idealdist` for the
position, and it uses `cam_back`/`cam_right`/`cam_up` only while `cl_camtype` is 3 (reTS `view.cpp`,
`V_CalcNormalRefdef`); types 0, 1, 2 and anything else are fixed offsets. That is a client rule, the
same on GoldSrc, not something this patch changes.

Made with `git diff` against xash3d-fwgs HEAD 17c23c81 (`cvar.c` had no uncommitted change; no other
patch, tracked or webassembly, touches it). Registered last in `xash.bat`, after websound, in its
ENGINE.txt list and the `xash.dll` description. Verified: reverse check in place against the live tree;
round trip (`git apply --reverse`, `cvar.c` back at HEAD, `git apply --check`, `git apply`,
byte-identical, in place again); `xash.bat engine` (run with `JOBS=6`) lists all 27 patches in place,
compiles `cvar.c` without a warning and installs xash.dll into H9XASH.

### 2026-11-01 -- engine-h9-webmenu.patch (new)

For the browser build (the H9 web client). Two things the browser build lacked, both inside
`XASH_EMSCRIPTEN` so the Windows build compiles exactly as before.

The main menu's background video. The CIN_MENUBG work (uncommitted in the tree: `cl_gameui.c`'s
`UI_PrecacheMenuBgVideo`/`UI_DrawMenuBgVideo`, mainui's `BackgroundBitmap.cpp`) plays
`media/<ui_background_video_file>` through the AVI functions, which the browser build compiled as
`avi_ffmpeg.c`'s no-FFmpeg stubs, so the menu showed its plain colour. A new `#elif XASH_EMSCRIPTEN`
branch, between the FFmpeg branch and the stubs, implements the same functions with the page as the
decoder: `AVI_OpenVideo` asks `Module.video.open(path)` (EM_JS) for a handle and the picture size,
`AVI_Think` asks `Module.video.frame` to write the current picture into `Avi->dst` as RGBA when it
has a new one, then uploads it with `GL_UpdateTexture( ..., PF_RGBA_32 )` and draws it with
`R_DrawStretchPic`, setting the same render mode and colour first as the FFmpeg branch does. The page
loops the video itself (`AVI_REWIND` only reports whether it is active); no sound. `AVI_Initailize`
is left as it is, so it still reports no AVI support and `AVI_LoadVideo`'s cinematics stay off: only
the menu background, which `cl_gameui.c` opens directly, uses the branch. H9's menu video is an MJPEG
AVI (each frame a complete JPEG), which client.js decodes with the browser's own JPEG decoder.

Quit and minimize. The browser build's `Host_Main` sets no jump buffer (`setjmp` is under
`!XASH_EMSCRIPTEN`), so `Sys_Quit`'s `Host_ExitInMain` longjmp-ed to an unset buffer after the
shutdown while the main loop went on calling the freed engine: the menu's X, Quit and the console's
quit left a dead canvas. In the browser build `Sys_Quit` now cancels the main loop, calls
`Module.callbacks.gameQuit( error )` (error is 1 when `Sys_Error` brought it there, `HOST_ERR_FATAL`)
and ends the call with `emscripten_exit_with_live_runtime()`, which does not return, as `Sys_Quit`
must not. `Platform_Minimize_f` (the menu's minimize button) calls `Module.callbacks.gameMinimize()`
instead of `SDL_MinimizeWindow`, which a page cannot do. client.js answers: back to the site's front
page, or the error on screen; minimize leaves full screen.

Made with `diff -u`: `system.c` and `vid_sdl2.c` against HEAD (no uncommitted change in either);
`avi_ffmpeg.c` against a snapshot of the file as the tree had it, with the CIN_MENUBG work, so only
the new branch is in the patch. Its hunk is about 60 lines from the CIN_MENUBG work's nearest change
(`avi[3]`) and has none of its lines as context, and it applies to HEAD's file as well. No other patch,
tracked or webassembly, touches the three files. Registered last in `xash.bat`, after cvarresync, in
its ENGINE.txt list and the `xash.dll` description. Verified: reverse check in place against the live
tree; forward check and apply on copies of the three files as they were before the change, each then
identical to the live file; a reverse check of all 28 patches in `xash.bat`'s order, all in place. Not
yet built: no emcc build was allowed while a map compile ran.

### 2026-11-01 -- engine-h9-phsbudget.patch (new)

New Byzantium froze a listen server, or ran it out of memory, while the map loaded. A multiplayer
server builds the world's PHS (`Mod_CalcPHS`, called when `svs.maxclients > 1`): it decompresses every
leaf's PVS and ORs together the rows of every leaf each one sees, in one allocation of
`rowbytes * (numleafs + 1) * 2` bytes, then compresses the result into an array that grew by one
`Mem_Realloc` per row. Both grow with the square of the leaf count: for New Byzantium's 46,744 leaves
that is 521 MB at once in a 32-bit process, and each realloc copying all the rows before it. The hive
(23,797 leaves) needs 135 MB and loads.

Past a budget of 192 MB, between the two, no PHS is built and the console says so. `Mod_FatPVS`
already treats every leaf as audible when it is asked for a PHS the world does not have, so sounds and
PAS messages reach every player: more traffic on a big map, nothing wrong. Below the budget the
compressed rows are measured in a first pass and the array is allocated once, so a large map's PHS no
longer costs a quadratic amount of copying. The budget is a constant in `Mod_CalcPHS`.

Made with `diff -u` against HEAD's `mod_bmodel.c` (no uncommitted change in it; no other patch, tracked
or webassembly, touches the file). Registered last in `xash.bat`, after webmenu, in its ENGINE.txt list
and the `xash.dll` description. Verified: reverse check in place against the live tree; forward check on
a copy of the file as it was before the change.

### 2026-11-01 -- engine-h9-phsbudget.patch (work budget)

A later New Byzantium build froze the load again, with this patch in place. Its world has 26,388
leaves, so the PHS needs only 166 MB and passed the memory budget; but it was compiled with a draft
vis (`-fast`), and from the average leaf 15,842 leaves (60%) are visible. Building the PHS merges one
row of 3,300 bytes for every visible leaf of every leaf: about 1,300 GB of OR operations, hours of a
server at 100% of one core with nothing logged after "Building PHS...".

`Mod_CalcPHS` now also counts the visible leaves from the compressed PVS before allocating anything
(its zero runs skipped; a leaf without visinfo counts as seeing every leaf, as `Mod_DecompressPVS`
treats it) and builds no PHS when the merging would pass 8 GB, a few seconds of work. The console
names both numbers. The memory budget is unchanged.

Made with `git diff HEAD -- engine/common/mod_bmodel.c` (still the only patch touching the file).
Verified: reverse check in place against the live tree; a dedicated server from the repo's H9XASH,
with xash.dll built from the h9 tree minus the unfinished engine-h9-motd.patch, loaded the build in
8 seconds ("PHS not built: 26389 leaves see 15841 leaves each on average, 1284 GB of merging, past
the 8 GB budget"), where the previous xash.dll stopped at "Building PHS...".

### 2026-11-01 -- engine-h9-motd.patch (new)

The splash MOTD (docs\H9_MOTD.txt): a server host can show a picture or a web page at join in place of
TS's text MOTD, the way Source servers do, off unless the host turns it on. The server side is
`h9_motd.sma`; this patch is the client side, in the engine so that it works whatever client library
is loaded and in both builds.

Transport. `h9_motd.sma` registers the `H9Motd` user message and sends it to each H9 client (those
with the `h9_clientid` userinfo key) on its first `PlayerPreThink` of a map, which runs before the
game's own `PreThink` -> `UpdateClientData` -> `InitHUD` -> `SendMOTDToClient`; a user message sent
from `client_putinserver` is dropped by `SV_Multicast` (the client is not `cs_spawned` yet). The
message comes in parts like TS's MOTD (a byte, 1 on the last part, then a string) and makes an info
string: type (image or page), show (connect or map), the picture's and the page's addresses, the
title, and asked (the player typed motd). `cl_motd.c` parses it itself: `Info_ValueForKey` stops
values at 127 characters. `CL_ParseUserMessage` hands every user message to `CL_Motd_UserMessage`
after reading its bytes, next to the engine's own ScreenShake/ScreenFade handling: `H9Motd` never
reaches the client library (which has no handler for it), and TS's `MOTD` parts are held while a
splash loads, dropped once it shows, and dispatched to the client library as they came
(`CL_DispatchUserMessage`) when it fails, so the player then gets TS's text window. A client without
this patch skips `H9Motd` (no pfn) and shows the text.

Native build. The picture is fetched with `HTTP_GetToMemory` (mbedTLS, cacert.pem from extras.pk3),
refused over 2 MB, refused over 2048 px a side from its header before decoding, decoded by imagelib
(PNG, TGA, BMP) and drawn by `CL_Motd_Draw` from `V_PostRender`, after `VGui_Paint`. A page cannot be
drawn: its picture, or the held text, with OPEN PAGE, which shows the whole address and opens
`Platform_ShellExecute` on a click of OPEN IN BROWSER only. While it is up `Key_Event` and
`IN_MouseEvent` give it the keys and clicks (the console key excepted; the release of anything it
took is its too), `IN_Commands` turns the game's mouse off (`IN_DeactivateMouse`) and back on after,
and sends no look events; it draws its own pointer when VGUI has not shown the system's. Addresses
must be https with a host name; 10 s for the picture, then the text. `CL_ClearState` takes it down at
a new map; `CL_Disconnect` clears the once-a-connection flag.

Browser build. `CL_Motd_Frame` hands it to the page (`EM_JS` -> `Module.motd.show`, client.js), which
answers with the restricted command `h9_motd_result 1|0`; no answer in 10 s, or no `Module.motd`, and
the text is shown.

Made with `diff -u` of `cl_main.c`, `cl_view.c`, `parse/cl_parse.c`, `input/in_keys.c` and
`input/input.c` against copies taken before the change (the tree as the whole chain leaves it), and
the two new files against /dev/null. Registered last in `xash.bat`, after phsbudget, in its
ENGINE.txt list and the `xash.dll` description. Verified: a reverse check of all 30 patches in
`xash.bat`'s order against the live tree, all in place (a first cut put the `cl_main.c` include right
after `msr_webauth.h`, which broke `engine.patch`'s reverse check, hence its place after `client.h`);
a forward check and apply on a copy of the five files as they were before, the result the same text
as the live tree; a syntax-only compile of `cl_motd.c` and the five edited files with clang, once in
cl mode with the native build's own include paths and defines (build\compile_commands.json) and once
for wasm32-emscripten with the browser build's: no error, and no warning in `cl_motd.c`. Not built:
the engine build (`xash.bat engine`) and the browser build are left to the user's schedule.
