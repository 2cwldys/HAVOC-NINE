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
| 16 | `engine-h9-presence.patch` | `cl_main.c`, `client.h`, `host.c`, `game_launch\game.rc`, `cl_presence.c` (new), `game_launch\havoc9.ico` (new, binary) | Discord Rich Presence: `CL_Presence_Init/Frame/Shutdown/ServerReply`, the exe icon swap to `havoc9.ico`. **Applies after #15** -- its `CL_InitLocal` registration hunk is numbered against the file state *after* userid's own registration line exists. See `docs\RICH_PRESENCE.txt`. Since 2026-11-05 also the modes' names for every build (`CL_H9_ModeName`, `CL_H9_ServerMode`, `CL_H9_StampServerMode`, built into the browser build too) and the stamp of an Xash server's reply with its `mode` for the server browser (`CL_ParseStatusMessage`) |
| 17 | `mainui-h9-sprayui.patch` | `3rdparty\mainui\menus\PlayerSetup.cpp` | Customize screen's logo picker: `Reload()` now chains up so it resyncs with console-side `spray`/`spray off`; `WriteNewLogo()` saves a colored pick back to the shelf file itself (`logos\<name>.<ext>`) instead of a now-unread `remapped.*`; a synthetic `none` row lets a player keep a hand-dropped `tempdecal.wad` as-is, visible and selectable instead of only an incidental, non-durable display fallback. Independent of `mainui-h9-gamestartup.patch` -- different function, no ordering dependency between the two |
| 17a | `mainui-h9-hover.patch` | `3rdparty/mainui/BaseMenu.cpp` | a hover sound: `uiSounds[SND_MOVE]` names `media/launch_move1.wav` |
| 18 | `engine-h9-autoconfig.patch` | `sv_main.c` (`SV_Init`), `sv_init.c` (`SV_ActivateServer`) | `h9_autoconfig` (default on): a second, independent per-map cfg lookup in its own `mapconfigs/<mapname>.cfg` folder, separate from the existing mapper-facing `maps/<mapname>_load.cfg` convention. The exec is queued right after `pfnServerActivate`, so the cfg runs after Metamod/AMXX plugins register their cvars and run their own configs, and overrides them. Server-host-facing, same audience as `engine-h9-userid.patch`. Independent of every other patch in this list -- no ordering dependency |
| 19 | `engine-h9-deltabits.patch` | `net_encode.c` (`Delta_ParseField`, new `Delta_H9WidenIndexField`) | widens `delta.lst`'s model-index fields (`viewmodel`, `modelindex`, `weaponmodel`) to `MAX_MODEL_BITS` and entity-index fields (`aiment`, `event_t.entindex`, `entity_state_t.skin`) to `MAX_ENTITY_BITS` (+1 when signed), `owner` to `MAX_CLIENT_BITS + 1`, when the local `delta.lst` is parsed. The server sends its tables to clients, so clients follow. Never touches `Delta_ParseTableField`: a client must use exactly the widths the server sends. Independent of every other patch -- no ordering dependency |
| 20 | `engine-h9-concolor.patch` | `dll_int/cl_game.c` | `pfnDrawConsoleString`: a string with no colour set is drawn in con_color (GoldSrc's way), so every chat line is, not white |
| 21 | `engine-h9-consolemusic.patch` | `sound/s_stream.c` | the main menu's music plays on while the console is open over the menu |
| 22 | `engine-h9-chatinput.patch` | `dll_int/cl_game.c`, `console.c` | the say: line under the chat lines, not at the top left |
| 23 | `engine-h9-bigworld.patch` | `server/sv_init.c` | big-world coordinates on for a map past +/-4096 |
| 24 | `engine-h9-websound.patch` | `sound/s_main.c` (`S_UpdateChannels`, `S_ClearBuffer`), `platform/platform.h`, `platform/sdl2/s_sdl2.c` | the browser build only (`#if XASH_EMSCRIPTEN`): the mixer skips the time a long frame already played instead of painting into it, and mixes at least 0.2 s ahead whatever `_snd_mixahead` says; its output is played by the page's AudioWorklet on a thread of its own (`Module.audio`), SDL's device the fallback. The Windows build compiles as before |
| 25 | `engine-h9-cvarresync.patch` | `common/cvar.c` (`Cvar_SanitizeAndSet`) | setting a cvar to the string it already holds reads its value from that string again, as GoldSrc does, so a value the client DLL wrote directly (the HL SDK camera's `cam_idealpitch`/`cam_idealyaw`/`cam_idealdist`, `cam_snapto`) can be set back. Independent of every other patch -- no other patch touches `cvar.c` |
| 26 | `engine-h9-webmenu.patch` | `client/avi/avi_ffmpeg.c` (a new `#elif XASH_EMSCRIPTEN` branch), `common/system.c` (`Sys_Quit`), `platform/sdl2/vid_sdl2.c` (`Platform_Minimize_f`) | the browser build only: the main menu's background video (the CIN_MENUBG work) decoded by the page (`Module.video`, client.js) and drawn through the same `GL_UpdateTexture`/`R_DrawStretchPic` calls as the FFmpeg branch; `Sys_Quit` stops the frames and tells the page (`Module.callbacks.gameQuit`, with whether an error ended it) instead of longjmp-ing to a jump buffer the browser build never set; `minimize` asks the page (`Module.callbacks.gameMinimize`). The FFmpeg branch and the Windows build are untouched. Independent of every other patch -- no other patch touches these files |
| 27 | `engine-h9-phsbudget.patch` | `common/mod_bmodel.c` (`Mod_CalcPHS`) | no PHS for a world whose PHS would take more than 192 MB (New Byzantium's 46,744 leaves: 521 MB, which froze a 32-bit listen server or ran it out of memory while the map loaded), or whose rows would take more than 8 GB of merging (a later New Byzantium build, draft vis, 60% of its leaves seen from the average leaf: about 1,300 GB, hours of a frozen load); sounds and PAS messages then reach every player, by `Mod_FatPVS`'s own fallback. Below the budget the compressed PHS is sized in a first pass and allocated once instead of reallocated for every row. Independent of every other patch -- no other patch touches `mod_bmodel.c` |
| 28 | `engine-h9-motd.patch` | `client/cl_motd.c` and `client/cl_motd.h` (new), `cl_main.c` (`CL_ClearState`, `CL_Disconnect`, `Host_ClientFrame`, `CL_Init`, `CL_Shutdown`, an include), `cl_view.c` (`V_PostRender`), `parse/cl_parse.c` (`CL_ParseUserMessage`), `input/in_keys.c` (`Key_Event`), `input/input.c` (`IN_MouseEvent`, `IN_Commands`, `IN_ActivateMouse`), `common/http/net_http_xash.c` (`HTTP_GetToMemoryEx`, a public-address check in `HTTP_FileResolveNS`, a CA check before TLS), `common/http/net_http_tls.c`/`.h` (`HTTP_TlsVerifies`), `common/net_ws.h` (and `HTTP_MemoryStatus`, the status a memory request's answer had, for its callback) | the splash MOTD: the engine takes the `H9Motd` user message `h9_motd.sma` sends, holds TS's `MOTD` text while the splash loads, shows a server's picture (fetched over https, capped at 2 MB and 2048 px a side) or a web page, shown inside the panel through `h9webview.dll` (xash3d-h9-patches\webview, Microsoft Edge WebView2, loaded by the engine when it is there), with the page's picture or text and OPEN PAGE (system browser after a confirmation showing the address, on a click only) when the page cannot be shown; and it hands the text to the client library when the splash fails; in the browser build `Module.motd` (client.js) shows it and answers with `h9_motd_result`. `cl_h9_motd 0` turns it off; `cl_h9_motd_wine` lets Wine and Proton show pages. **Applies after the whole chain**: its `cl_main.c` include hunk sits after `client.h`, clear of the context of `engine.patch`'s `msr_webauth.h` hunk (an include placed right after `msr_webauth.h` broke that patch's reverse check), and its other hunks are clear of cloak/userid/presence's. It also carries the engine's panel kit and registry (`cl_motd.h`: the `H9UI_*` drawing calls, `H9UI_AddPanel`), which #29's prompt registers with, and keeps the server's name from TS's own `ServerName` message (`H9UI_ServerName`). See `docs\H9_MOTD.txt` |
| 29 | `engine-h9-travel.patch` | `client/cl_travel.c` (new), `client.h` (the `CL_Travel_Init` prototype, after `SCR_DrawNetGraph`'s), `cl_main.c` (`CL_Init`, right after `VID_Init`) | `h9_travel <a.b.c.d:port> [name]`: a server's offer to send the player to another server (h9_community.sma's portals), which the engine shows as its own YES/NO prompt and only the player can accept; the connect then runs from the engine's command buffer. IPv4 only, no loopback/private/CGNAT/link-local address unless the current server is on one, never multicast or reserved; one offer at a time, 10 s between offers, 4 offers per server in 120 s; `cl_h9_travel` (default 1) and the userinfo key `_h9travel` that tells servers it is there. In the browser build the page (`Module.travel`, client.js) says which addresses its relay reaches. **Applies after #28**: it registers its prompt with #28's panel registry and draws with its kit (`cl_motd.h`), and never touches `cl_motd.c`/`.h` (a later patch changing #28's new files would break #28's reverse check). See `docs\H9_COMMUNITIES.txt` section 9 |
| 30 | `engine-h9-slots128.patch` | `common/xash3d_types.h`, `common/protocol.h`, `common/net_buffer.c` (`svc_strings`), `common/net_encode.c` (new `Delta_H9SlotField`, called at the end of `Delta_ParseField`), `server/server.h`, `server/sv_client.c` (`SV_ConnectClient`, `SV_FullClientUpdate`, the voice routing), `server/sv_frame.c` (`SV_EmitPings`), `server/sv_game.c` (`pfnVoice_Get/SetClientListening`), `server/sv_init.c` (`SV_InitGame`), `client/parse/cl_parse.c` (`CL_UpdateUserinfo`, `CL_UpdateUserPings`, the svc switch), `client/cl_main.c` (the connect packet's `ext`) | built for 128 player slots: `MAX_CLIENT_BITS` 7 (`MAX_CLIENTS` 128), so `maxplayers` goes to 128. A server of 32 slots or fewer sends exactly what it did: `svc_updateuserinfo` and `svc_pings` keep their 5-bit slot (`MAX_CLIENT_BITS_LEGACY`), which GoldSrc's pings also need on the client. A server of more sends `svc_h9updateuserinfo` (54) and `svc_h9pings` (55), the same messages with the slot as a byte; widens the delta fields that hold a player slot (`owner`, `clientdata_t.iuser2`) to 8 bits; keeps a packet entity ring of half the entities a frame (170 MiB at 64 slots instead of 340); and refuses a client that does not set `NET_EXT_H9_SLOTS128` (bit 24 of the connect `ext`) with a message naming havoc9.org/downloads. The voice listeners are a bit array over every slot (one `uint` aliased slot 33 onto slot 1). `MAX_GOLDSRC_EDICTS` stays sized for 32. **Applies after the whole chain**: `net_encode.c`'s slot step is its own function, clear of #19's hunks; at 32 slots or fewer it narrows #19's `owner` (`MAX_CLIENT_BITS + 1`, 8 bits now) back to 6. See `docs\PLAYER_LIMIT_128.txt` |
| 31 | `mainui-h9-slots128.patch` | `3rdparty/mainui/sdk_includes/common/xash3d_types.h` | the menu's copy of `MAX_CLIENT_BITS`: Create Game takes up to 128 players. Independent of the other mainui patches |
| 32 | `engine-h9-idproof.patch` | `client/cl_idproof.c` (new), `client.h` (a `CL_H9Id_Init` section after `cl_qparse.c`'s), `cl_main.c` (`CL_Init`, right after `CL_LoadProgs`) | the presence ID proof's client half (docs/H9_PRESENCE.txt section 8): the device id in `device_id.ini`, the userinfo key `_h9idv`, and `h9_idchallenge` answered with HMAC-SHA256 keyed with `cl_h9_userid` |
| 33 | `engine-h9-avatars.patch` | `client/cl_avatar.c` (new), `client.h` (a `CL_Avatar_*` section before `cl_efrag.c`'s), `cl_main.c` (the end of `CL_Init`), `parse/cl_parse.c` (`CL_ParseUserMessage`, after `ScreenFade`) | players' havoc9.org pictures on the scoreboard: `H9Avatar` (slot, account, version), fetched from havoc9.org only (or the local test site `cl_h9_site` names), cached in `downloads/h9avatars` under the site's name, handed to client.dll's `HUD_H9Avatar`; a picture that could not be fetched is asked for again (15 s, 60 s, 5 min, then every 10 min, while a slot names it; one not there or no use, 10 min), each failure one console line, and at once on a new `H9Avatar` or another `cl_h9_site` (an H9UI panel's Frame does the asking again); `h9_profile <slot>` opens the slot's account's havoc9.org profile in the web browser (the scoreboard's double-click), the account `H9Account` (slot, account; `CL_ParseUserMessage` takes it after `H9Avatar`, prototype `CL_Avatar_Account` in `client.h`) names, else `H9Avatar`'s. **Applies after #32** (its `CL_Init` line follows #32's) |
| 34 | `engine-h9-shellwhite.patch` | `ref/gl/gl_studio.c` (`R_StudioSetupSkin`) | the glow shell's pass binds `tr.whiteTexture` when the chrome sprite (`sprites/shellchrome.spr`, `cl_sprite_shell`) is not loaded, so the shell is its rendercolor alone and not the model's last skin. Covers the engine's own glow shell, #10's x-ray and The Specialists' client renderer, which all draw the shell through `R_StudioDrawPoints`. Independent of every other patch: its hunk is clear of `engine.patch`'s and #10's in the same file |
| 35 | `engine-h9-consoleoverlay.patch` | `client/console.c` (`Con_DrawNotify`, `Con_Init`) | `con_shownotify` (default 0): the console's last few lines are not drawn over the game; the console history is unchanged, and `con_shownotify 1` restores the overlay. The chat/say line in the same function still draws. **Applies after the whole chain** -- its context is the post-`engine-h9-chatinput.patch` `Con_DrawNotify` and `Con_Init`. No other patch after chatinput touches `console.c`. |
| 36 | `engine-h9-webquit.patch` | `common/cmd.c` (`Cbuf_AddTextToBuffer`, `Cmd_ExecuteStringWithPrivilegeCheck`) | the browser build only (`#if XASH_EMSCRIPTEN`): once the host has shut down (`host.shutdown_issued`), no command text is queued and no command runs. `Sys_Quit` (#26) leaves the module loaded for the page, and client.js still called `Cmd_ExecuteString("disconnect")` from its pagehide handler after quitting; tokenizing then freed the previous command's arguments a second time (`Mem_FreeBlockSmall: not allocated or double freed`, cmd.c `Cmd_TokenizeString`), because `Host_ShutdownWithReason` had already freed `host.mempool`. The Windows build compiles as before. Its hunks sit at the top of both functions, clear of the context of `engine.patch`'s two `cmd.c` hunks (which end on the first line of `Cbuf_AddText`'s and `Cmd_ExecuteString`'s bodies) and of #7's (the queue size at the top of the file) |
| 37 | `engine-h9-typing.patch` | `client/input/in_keys.c` (`Key_SetKeyDest`, new `Key_H9TypingServer`, `Key_H9Typing` and `Key_H9TypingFrame` above it), `client/input/input.c` (`Host_InputFrame` calls `Key_H9TypingFrame`) | the client command `h9_typing 1` when the chat line (`key_message`) opens and `h9_typing 0` when it closes, sent or not, every time, and `h9_typing 1` again every 2 seconds while the line stays open, to a server whose game registered the `H9Typing` user message (ts_floatchat.sma's bubble); any other server is told nothing. `messagemode`/`messagemode2` are the engine's own client commands and never reach the server, on GoldSrc or Xash. **Applies after the whole chain**; #28 also touches `in_keys.c` (`Key_Event`), clear of this hunk |
| 38 | `engine-h9-brushshell.patch` | `ref/gl/gl_rsurf.c` (`R_DrawBrushModel`, new `R_DrawBrushShell` above it) | `kRenderFxGlowShell` on a brush entity: its faces drawn once more after its own pass, pushed out 1 + renderamt/128 units along each face's plane, through the chrome sprite (white without it, as #34 does for models), additive, in its rendercolor. GoldSrc and Xash draw the glow shell on studio models only; ts_matchmode sends its siege objectives (func_wall) this per viewer. Independent of every other patch -- no other patch touches `gl_rsurf.c` |
| 39 | `engine-h9-serverfog.patch` | `ref/gl/gl_rmain.c` (new `R_FogAllowed`, `R_AllowFog`, `R_DrawFog`), `ref/gl/gl_draw.c` (`R_Set2DMode`), `ref/gl/gl_local.h` (its prototype after `R_DrawFog`'s) | the server's movevars fog (#9's sudden-death bog) is drawn whatever `gl_fog` says: The Specialists' client.dll registers a `gl_fog` of its own (default 0, its switch for a map's `ts_fog`) and `Cvar_Get` gives the existing engine cvar that default, so the engine's fog switch is 0 whenever no config sets it back. `gl_fog` still governs water fog and a map's `ts_fog` (TriAPI). Independent of every other patch: its hunks are clear of #9's `R_CheckFog` hunk and of `engine.patch`'s `gl_local.h` hunks |
| 40 | `engine-h9-listen.patch` | `client/cl_h9listen.c` (new), `client.h` (a `CL_H9Listen_Init` section before `cl_pmove.c`'s), `cl_main.c` (`CL_InitLocal`, after `cl_fixtimerate`) | a listen server's own player in presence (docs/H9_PRESENCE.txt section 8a): `h9_idlisten <a.b.c.d:port> [<nonce>]`, answered only over loopback, salts `h9_clientid` with the address the listen server reports as (sent with `CL_UpdateInfo`) and, with a nonce, answers the ID proof with S = that address; the userinfo key `_h9idl` says the game has it. Builds `cl_idproof.c`'s hashing into its own file (`H9_IDPROOF_SELFTEST`) rather than touching #32. **Applies after the whole chain**; its hunks are clear of every other patch's (`cl_main.c` and `client.h` are touched by many, none within three lines of these) |
| 41 | `engine-h9-reliableburst.patch` | `server/sv_frame.c` (`SV_UpdateUserInfo`, new `SV_BroadcastReliable` after it, `SV_UpdateToReliableMessages`), `server/sv_client.c` (`SV_DropClient`'s notification), `server/server.h` (the prototype after `SV_FullClientUpdate`'s) | a userinfo update enters `sv.reliable_datagram` only whole (written apart first; the room check counts the ~24 bytes around the userinfo, not 6), else it waits a frame with `FCL_RESEND_USERINFO` set; a dropped player's update spills into each client's own reliable stream when the shared buffer is full; an overflowed `sv.reliable_datagram` is dropped (and every spawned player's userinfo resent) rather than copied out cut off. **Applies after the whole chain**; #33 (slots128) touches `SV_FullClientUpdate` and `sv_frame.c`'s pings, not these lines |
| 42 | `engine-h9-link.patch` | `client/cl_h9link.c` (new), `client.h` (a `CL_H9Link_Init` section after `cl_remap.c`'s), `cl_main.c` (the end of `CL_InitLocal`, after `cl_list_messages`) | this game's id in `user_id.ini` sealed for the Windows user with DPAPI (`CryptProtectData`, crypt32 loaded at run time, an entropy of its own), read by the engine itself; `cl_h9_userid` loses `FCVAR_ARCHIVE` and gains `FCVAR_READ_ONLY` at run time (#15's definition line is untouched), so config.cfg no longer keeps it and no config sets it; a plain `id=` line (older builds, `enter_userid.cmd`) is sealed on load and `user_id.ini.bak` deleted. `h9_link [open|cancel]`: a device code from h9web (`GET /api/link/start`, `/poll`), the account's player id and a link token sealed on approval, `h9_clientid` salted again while connected; `h9_unlink` (privileged); a linked game asks `GET /api/link/status` once a start, and in a game again a few seconds into each map and every 5 minutes, and unlinks when h9web says so. The link belongs to the site that made it (`site=` in the record, always canonical): the status check asks that site only, while `cl_h9_site` points to it, only its answer unlinks, and `h9_unlink` tells it. `cl_h9_site` is read leniently (no scheme, a trailing slash) and said in the console. A record with an id and no link asks the site to adopt it (`/api/link/adopt`, the ID proof with S = `h9link-adopt`). Cvars `_h9lnk` (userinfo), `_h9link_account`, `_h9link_flow`, `_h9link_code`, `_h9link_text`, `_h9link_site` for the menu; an in-game panel in #28's registry. Windows only, never the browser build. **Applies after the whole chain**; its hunks are clear of every other patch's |
| 43 | `mainui-h9-link.patch` | `3rdparty/mainui/menus/Main.cpp` (new `CMenuH9LinkDialog` and `CMenuH9LinkButton` above `CMenuMain`, `H9LinkCb`, two members, the end of `_Init`) | Link your Account / Unlink your Account in the main menu's column directly below Change Game, above Quit (`H9LinkPlace`, after `VidInit`), with the scoreboard's chain beside it (`gfx/vgui/h9_link.tga` green, `h9_unlink.tga` red), all read from #42's cvars: no network call. Hidden in an engine without `_h9lnk`; compiled out of the browser build (`__EMSCRIPTEN__`). Clear of `engine-mainui.patch`'s `VidInit` hunks |
| 44 | `mainui-h9-default64.patch` | `3rdparty/mainui/menus/CreateGame.cpp` (`maxClients.onCvarGet`) | Create Game's Max players starts at 64 (for a `maxplayers` of 1 or less). Made against HEAD's `"16"`, so it carries the untracked `"16"` -> `"32"` hand-edit that sat in the working tree before it. Independent of every other patch |
| 45 | `engine-h9-serverinfo.patch` | `server/sv_client.c` (`SV_Info`), `client/cl_main.c` (`CL_ParseGoldSrcStatusMessage`) | the server's info reply names its bots (`bots`, a line that sat in the working tree in no patch) and says `auth` 1 while the cvar `h9_require_account` (h9_presence's) is 1; a GoldSrc server's A2S_INFO, whose player count holds the bots, reaches mainui with `numcl` the people alone and `bots` apart. Since 2026-11-05 the info reply also carries `desc`, the game description (cut to 31), and a GoldSrc reply's description names the `mode` key mainui is given (`CL_H9_ServerMode`, #16's). **Applies after the whole chain**; clear of #30's and #41's `sv_client.c` hunks. Needs #16 for `CL_H9_ServerMode` |
| 46 | `mainui-h9-browser.patch` | `3rdparty/mainui/menus/ServerBrowser.cpp` | the server browser shows "humans/max (+N bots)", counts a server with bots on it as not empty and its bots against its slots, sorts people then bots, and draws `gfx/shell/h9_account` (the overlay's, an H9 original) in a new image column beside the lock for a server whose info says `auth` 1. Regenerated 2026-11-04 with the server browser's chain column (`COLUMN_CHAIN`, after the favourite column): `gfx/vgui/h9_link.tga`, green, for a server havoc9.org names ok or rp, and `gfx/vgui/h9_unlink.tga`, red and broken, for any other once the list was read; no chain before that, on a LAN list, or on an engine without `_h9srv_gen` (`engine-h9-serverauth.patch` supplies it). A roleplay server's name carries `[UNRANKED: roleplay]`. `RefreshList` asks the engine (`h9_servers`) and `Draw` makes the rows' chains again when `_h9srv_gen` changes. Regenerated 2026-11-05 with the Mode column (`COLUMN_MODE`, between the name and the map; `mode` is the info's key, `ModeCmp` sorts it; the info buffer is 576, room for the key after a full reply). Independent of every other patch (the key is the engine's: #16 and #45) |
| 47 | `engine-h9-largeaddress.patch` | `game_launch/wscript` (`build`) | the launcher (`xash3d.exe`, H9XASH's `HAVOC 9.exe`) linked `/LARGEADDRESSAWARE` when the build is 32-bit Windows with MSVC: on 64-bit Windows the process, the game or a `-dedicated` server, has 4 GB of address space instead of 2. Only the executable carries the flag; no DLL is relinked. A 64-bit or non-MSVC build links as before. A changed wscript makes waf reconfigure once by itself on the next build. Independent of every other patch: none touches `game_launch/wscript` (#16 changes `game.rc` beside it) |
| 48 | `engine-h9-joinscreen.patch` | `client/cl_h9join.c` (new), `client.h` (a `CL_H9Join_Init` section before `cl_tent.c`'s), `cl_main.c` (`CL_CheckClientState`, `CL_CheckForResend`, `CL_Connect_f`, `CL_Disconnect`, `CL_Reconnect_f`, `CL_Retry_f`, `CL_ErrorMsg`, `CL_ReadNetMessage`'s timeout, `CL_ProcessFile`, `CL_PrecacheResources`, `CL_InitLocal`), `parse/cl_parse.c` (`CL_ParseServerData`, `CL_RegisterResources`, `svc_changing`), `parse/cl_parse_gs.c` (`svc_disconnect`), `common/http/net_http_xash.c` (new `HTTP_FileProgress` after `HTTP_Run`), `common/net_ws.h` (its prototype) | the join screen: with a menu that exports the connection progress hooks (`UI_EXTENDED_FUNCTIONS`, mainui-h9-joinscreen.patch), a join (connect, retry, this game's own server) and a map change (`svc_changing`, the server's reconnect) keep the menu up over its own background until the game is in (`ca_active`), in place of upstream's console (`CL_Connect_f`'s TESTTEST lines); the stage, the overall bar (`scr_loading`: 5 connecting, 15 server info, up to 50 by the bytes downloaded, 55 the map, up to 90 by the resources precached, 95 spawning) and the file downloading with n of N, KB of KB and its own bar, over HTTP fast download (`HTTP_FileProgress`) or the netchan, in the read-only private cvars `_h9join`, `_h9join_stage`, `_h9join_server`, `_h9join_file` and `_h9join_fileprog`; the precache draws a frame every 0.15 s. A join or a game the server or the engine ends with a reason (refused, kicked, timed out, a file that could not come or is missing) puts it in `_h9_drop` for the menu, with OK. `CL_ErrorMsg` returns before showing anything for an Xash reject (`disconnect`), which formats no text of its own (upstream showed its uninitialized buffer). `cl_h9_joinscreen 0`, a demo, a timedemo, a background map or a menu without the hooks: upstream's behaviour. Upstream called the hooks once and took them back (d2a8cfe6, the menu stayed up over demos) |
| 49 | `mainui-h9-joinscreen.patch` | `3rdparty/mainui/menus/ConnectionProgress.cpp` (rewritten), `3rdparty/mainui/BaseMenu.cpp` (`UI_StartBackGroundMap`) | the join screen: `CMenuConnectionProgress` as a 640 x 240 panel in the menu's colours (`uiPromptBgColor`, stroke `uiInputFgColor`) over the menu's own background or video, full screen, with the server, the stage, the overall bar, the file line and its bar, and CANCEL (ESC too: `http_clear` and `disconnect`); the console key opens the console in its place. The engine's hooks bring it up (`Connect`, `ChangeLevel`) and take it down (`Disconnect`, or `_h9join` 0 as the game comes in); with the menu down it opens the main menu under itself first (the menu's last window never closes), and a join that ends with `_h9_drop` shows it in a message box. No background map starts while `_h9join` is 1 (the menu's first draw comes during a join when the game starts with +connect). Needs engine-h9-joinscreen.patch for the cvars; without them it shows only its first stage |
| 50 | `engine-h9-deltacounter.patch` | `server/sv_frame.c` (new `SV_H9RebaseClientEntities` above `SV_WriteEntitiesToClient`, its call after the frame's `qsort`) | `svs.next_client_entities`, the packet entity ring's counter, grows by every entity of every frame built for a real client, and at 0x7FFFFFFE `SV_WriteEntitiesToClient` reconnects every client ("Server will restart due delta is outdated"): within one to two hours on a full 64-slot server. At 0x40000000 it is brought down by a multiple of the ring's size, and every client's stored frames with it: a frame still in the ring keeps its slot and stays a delta base, a frame already rolled off stays rolled off (at 0). No type, protocol or other file changes; the wrap check stays as a backstop. Independent of every other patch: its hunks are clear of #30's (`SV_EmitPings`) and #41's (`SV_UpdateUserInfo` and after) |
| 51 | `engine-h9-overflowlog.patch` | `common/h9_overflowlog.c` (new), `common/sys_con.c` (two prototypes after the includes, `Con_Printfv`, new `Con_H9Unprinted`, the early returns of `Con_Printf`, `Con_DPrintf` and `Con_Reportf`) | every console message, printed or held back (developer level, no console), is matched against the engine's overflow and limit messages; a match is appended to `<game>/logs/h9_overflow.log` (`ts\logs`) with the date and time, the side (server, listen or client) and the map, whatever `-dev` or `-log` say. The same message (its first 24 characters) at most once in 10 s, with the count held back; at most 2000 lines a run; C stdio, opened and closed for each line. A held-back developer message is formatted only when its format string matches. Independent of every other patch: no other patch touches `sys_con.c` |
| 52 | `engine-h9-vguitype.patch` | `client/vgui/vgui_draw.c` (`VGUI_IsInGame`) | the VGUI panels stay painted while the chat line is open. The VGUI support library paints only when the engine says the player is in the game, which was `cls.key_dest == key_game`, so every VGUI panel (TS's scoreboard and menus, H9's match bar, banners and menus) vanished while a say key's chat line was open and came back when it closed; `key_message` now counts as in the game too, as on GoldSrc. The console and the menu still hide them. Independent of every other patch |
| 53 | `engine-h9-serverauth.patch` | `client/cl_h9auth.c` (new), `client.h` (`CL_H9Srv_Init` after `CL_Escape_f`), `cl_main.c` (`CL_Init`, after `S_Init`) | the server browser's chain asks havoc9.org and never the servers. `h9_servers` (a restricted command, once in 20 seconds at the most; `cl_h9_servers 0` turns it off) fetches `/api/presence/servers/auth` with `HTTP_GetToMemoryEx` (https with the certificate checked for havoc9.org; `cl_h9_site` names a local test site, as for the pictures) and puts the answer in two cvars the menu reads: `_h9srv` (" address=c address=c ", c o for ok, r for a roleplay map, m for modified) and `_h9srv_gen` (0 until an answer was read). The browser build compiles none of it. The menu's half is in `mainui-h9-browser.patch`. Independent of every other patch |
| 54 | `engine-h9-intro.patch` | `client/cl_video.c` (cvars `ts_intro` and `ts_intro_vol`, `SCR_SkipStartupVideo`, the intro skipped in `SCR_NextMovie` when it is 0), `client/client.h`, `client/input/in_keys.c` (`Key_Event`), `client/sound/s_stream.c` (`S_StartBackgroundTrack`) | the intro video before the main menu: `ts_intro` (archived, 1), `ts_intro_vol` (archived, 1: how loud it is), any key or mouse button skips a startup video |
| 55 | `engine-h9-glowfix.patch` | `ref/gl/gl_draw.c` (`R_Set2DMode`) | MSR's bloom: `GL_MODULATE` is bound before the compose, so a glowing mesh (lamps, the RepuTengu glasses) is no longer drawn as a white square |
| 57 | `engine-h9-upscale.patch` | `ref/gl/gl_upscale.c` (new), `ref/gl/gl_fbo.c` (`GL_BlitTarget`), `ref/gl/gl_opengl.c` (two cvars, their registration, `R_Shutdown`), `ref/gl/gl_local.h` | `h9_upscale` 0 or 1 and `h9_upscale_sharp` 0 to 1 (0.84): with `h9_upscale` on, the scene target's blit into the screen target (`GL_BlitTarget` asks `GL_UpscaleBlit` first) is drawn by AMD FidelityFX Super Resolution 1.0 instead: EASU into a target of the screen's size and RCAS from it, or RCAS alone at `r_scene_scale` 1, as GLSL 1.10 shaders through the ARB shader objects `gl_opengl.c` loaded and nothing called. The plain blit when it is off, when the scene is bigger than the screen and whenever the upscaler cannot work (one console line, no retry until `h9_upscale` goes to 0 and 1). AMD's MIT notice is in `gl_upscale.c` and in `overlay/ref_gl.FSR1-LICENSE.txt`. The OpenGL ES and WebGL renderers compile `gl_upscale.c` to a stub (the cvars stay). **Applies after the whole chain**: its hunks in `gl_fbo.c`, `gl_opengl.c` and `gl_local.h` sit clear of every hunk of `engine.patch` (the lines of `GL_BindScreenTarget`, the cvar block and the registration block are its), so every earlier patch still reverse-checks as in place. See `docs\H9_UPSCALE.txt` |

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

### 2026-11-01 -- engine-h9-motd.patch (regenerated: the page shown inside the game)

The user wants a server's web page displayed as the MOTD, as Source games do, not only offered as a
link. FWGS has no HTML renderer, so the page is hosted by Microsoft Edge WebView2, through a small
helper of H9's own: `h9webview.dll`, built from `xash3d-h9-patches\webview\h9webview.cpp` by
`webview\build_webview.bat` (32-bit MSVC, static CRT, the WebView2 SDK 1.0.4258.31 from NuGet in
`deps\`, its loader linked in statically: the DLL imports only urlmon, ole32, oleaut32, advapi32,
user32 and kernel32; 226,304 bytes then, 248,320 with the proxy below, which adds ws2_32). `xash.bat`'s engine step builds it into `stage\webview` and
copies the DLL, its `.patch` (which carries its whole source) and the SDK's licence into H9XASH.

`cl_motd.c` loads the helper by its full path beside `HAVOC 9.exe` and calls it by name
(`H9WV_ApiVersion`, `H9WV_Runtime`, `H9WV_Wine`, `H9WV_Open`, `H9WV_Place`, `H9WV_Close`). A page splash
is a new state, `H9M_PAGE`: the view is made hidden in the game's own window (`R_GetWindowHandle`),
the page's picture is fetched alongside, and the panel opens with the page once it has loaded; it
keeps the title, "Web page at <host>" (the page's host as it navigates) and CLOSE (ESC) around it, with
no OPEN PAGE. The view's child window is placed over the panel's body every frame and hidden whenever
the panel is not up, the console or the menu is, or the confirm box is (which takes the page's new
windows too). When the page cannot be shown -- no helper, no runtime, exclusive full screen (Xash
minimizes the window when it loses the keyboard, `VID_RestoreScreenResolution`), Wine or Proton
without `cl_h9_motd_wine`, a failed or HTTP-error first load, nothing within 10 s, or a view that stops
later -- the panel is the fallback: "This page could not be shown here.", the picture or the held
text, OPEN PAGE; the reason goes to the console. Reports from the helper arrive inside the game's
message loop and are only noted; the frame acts on them. `IN_ActivateMouse` now asks
`CL_Motd_KeepsMouse` first, because clicking into the page takes the window's focus and focus coming
back would otherwise turn mouse-look on under the panel. `CL_Shutdown` resets the splash so the view
closes while the window still exists. The helper's lockdown is listed in `h9webview.cpp` and
`docs\H9_MOTD.txt`.

Also: the address check refuses localhost's family and the usual private names (.local, .lan,
.internal and the like), as the helper, the plugin and the web client now do.

Made, as before, with `diff -u` of the five edited files against copies taken before any of this
work, and the two new files against /dev/null; the new hunks (`CL_Shutdown`, `IN_ActivateMouse`) sit
clear of presence's and chatmouse's contexts. Verified: a reverse check of all 30 patches in
`xash.bat`'s order, all in place, after the coordinator's phsbudget work budget too; a forward check
and apply on copies of the five files as they were before, the same text as the live tree; syntax-only
compiles of `cl_motd.c`, `cl_main.c` and `input.c` with clang, native (the build's own flags) and
wasm32 (the browser build's), clean. The helper was built for real and driven from a hidden test
window against the installed runtime (156.0.4314.58): google.com and github.com (which refuses
framing) load; http, an IP address and localhost are refused before anything starts; an expired
certificate, a 404, an unknown host and an https-to-http redirect each report a failure. Not built:
the engine (`xash.bat engine`), left to the user's schedule; nothing was run in the game.

### 2026-11-01 -- engine-h9-motd.patch (regenerated: the security audit's findings)

Three findings from the security audit of the splash MOTD, fixed in the same patch.

1. "No IP address" was a rule about how a host is spelled, so `0x7f.1` (which the resolver reads as
   127.0.0.1) or any DNS name pointing into the player's network got past it. Now the address is judged
   after it is resolved. The picture: `HTTP_GetToMemoryEx( ..., HTTP_MEM_PUBLIC_ONLY | HTTP_MEM_VERIFY_TLS )`
   (`net_ws.h`); `HTTP_FileResolveNS` refuses an address that is not public unicast (loopback, private,
   link-local, CGNAT, benchmarking, documentation, multicast, reserved; IPv6 outside global unicast, its
   documentation/Teredo/ORCHID blocks, and the IPv4 inside a mapped, NAT64 or 6to4 address held to the IPv4
   rules), on the first request and on every redirect. The address checked is the one the socket connects
   to (`file->addr`), so the name cannot be re-pointed in between. The embedded page: `h9webview.dll` now
   runs a CONNECT-only proxy on 127.0.0.1 and starts WebView2 with `--proxy-server` to it,
   `--proxy-bypass-list=<-loopback>` (loopback goes through it too) and
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; the proxy resolves each host itself,
   refuses the whole name when any address is not public, and tunnels to the address it checked. Plain
   http through it is refused. That covers every connection of the page, not only navigations: frames,
   subresources, fetch and WebSockets. The navigation rules stay as the first line.
2. The picture's https fetch no longer proceeds unverified: `HTTP_TlsVerifies()` (`net_http_tls.c`) is
   true only with a CA bundle loaded and `http_tls_insecure` off, and a `HTTP_MEM_VERIFY_TLS` request is
   refused otherwise (and refused for plain http). The bundle H9XASH loads is `cacert.pem` from
   `valve\extras.pk3` (the engine's `FS_LoadFile( http_tls_cafile )`, default `cacert.pem`): no other
   `cacert.pem` is in H9XASH's search path; the "4 certificate(s) ... failed to parse" warning comes from
   that bundle, the rest of which loads.
3. `client.js`: the auditor's own change (outside `motdOverlay`) is kept.

Also: under Wine, the console line for a missing runtime now points to Microsoft's Evergreen Standalone
Installer run in the prefix (winetricks has no WebView2 verb).

Made and verified as before: `diff -u` against the pre-edit copies (the four HTTP-client files were clean
at HEAD and are now in the patch), a reverse check of all 30 patches in `xash.bat`'s order, all in place,
a forward round trip on the pre-edit copies, the same text as the live tree; syntax-only compiles of
`cl_motd.c`, `net_http_xash.c` and `net_http_tls.c`, native and wasm32, clean. The helper rebuilt and
driven from the hidden test window: google.com, github.com and example.com load through the proxy;
localtest.me (127.0.0.1) and 10.0.0.1.nip.io fail ("it leads to a private or reserved address"); `0x7f.1`
is refused before anything starts. Not built: the engine.

### 2026-11-01 -- engine-h9-travel.patch (new), engine-h9-motd.patch (regenerated: panels and the server's name)

`h9_travel`, the engine half of `docs\H9_COMMUNITIES.txt` section 9: a server's offer to send the player
to another server, which only the player can accept. FWGS refuses `connect` from a server (it is
`CMD_PRIVILEGED`), so until now a community portal could only print an address to type.

- `client/cl_travel.c` (new): `h9_travel <a.b.c.d:port> [name]`, registered with `Cmd_AddCommand` (not
  restricted, so a server's stufftext reaches it). It never connects by itself. It puts up a prompt the
  engine draws: "Travel to <name>?", the address, "Offered by the server you are on: <its name>, <the
  address the netchan is connected to>", a 15 s countdown, YES (Y) and NO (N). Only Y, Enter or a click
  on YES runs `connect <address>` through `Cbuf_AddText`; N, Esc, NO, 15 s, a new map or a disconnect drop
  it. Refused with an "H9 TRAVEL:" console line: `cl_h9_travel 0` (new; archived, privileged, default 1);
  anything but a strict IPv4 address and port (decimal octets without leading zeros, no names, port
  1-65535); a loopback, private, CGNAT or link-local address unless the current server is itself on one,
  and multicast or reserved always; a second offer while one is up; one less than 10 s after the last
  ended; a fifth from the same server within 120 s. Dropped silently: the server the player is on, not in
  play, a demo. The userinfo key `_h9travel` ("1" while `cl_h9_travel` is on, "0" when off) tells a server
  the command is there. The browser build asks the page (`Module.travel.reachable`, client.js, from
  `/api/servers` and the page's JOIN list) whether its relay reaches the address; for one it does not,
  the prompt says so and offers only OK.
- `client.h`: the `CL_Travel_Init` prototype, after `SCR_DrawNetGraph`'s. `cl_main.c`: `CL_Travel_Init()`
  in `CL_Init`, right after `VID_Init()`, clear of every other patch's context.
- `engine-h9-motd.patch`, regenerated for it. A later patch cannot change `cl_motd.c` (a new file in the
  motd patch, whose reverse check needs it byte for byte), so the motd patch carries what the prompt
  needs. `cl_motd.h` exports the panel kit (`H9UI_Fill`, `H9UI_Line`, `H9UI_Button`, ...) and a registry,
  `H9UI_AddPanel`: each registered panel gets the keys, the mouse and a frame before the splash, is drawn
  above it and is reset with it; `CL_Motd_Active` counts them, and the embedded page is hidden while one
  is up. It also keeps the server's name from TS's own `ServerName` user message (the hostname, sent at
  every join; an FWGS server's serverinfo has no hostname) for `H9UI_ServerName`, cleared on disconnect;
  the message still goes on to the client library.

Made with `diff -u`: the travel patch against copies of `cl_main.c` and `client.h` taken with the whole
chain applied, motd included. For the motd change the travel patch was taken out (`git apply --reverse`),
the motd patch regenerated from its own pre-edit copies and the travel patch put back, so neither carries
the other's lines. Verified: the reverse check of all 31 patches in `xash.bat`'s order, all in place; a
forward round trip of the last two (both taken out, then applied again in order), the 13 files they touch
byte for byte the same; syntax-only compiles of `cl_motd.c` and `cl_travel.c`, native and wasm32, clean;
the address rules extracted into a unit test, 32 cases passing. `h9_community.sma` sends `h9_travel` to a
client with `_h9travel "1"` (amxxpc clean). Not built: the engine.

### 2026-11-01 -- engine-h9-slots128.patch (new), mainui-h9-slots128.patch (new)

The engine half of `docs\PLAYER_LIMIT_128.txt`: built for 128 player slots, servers to run at 64, every
default still 32.

- `MAX_CLIENT_BITS` 7, `MAX_CLIENTS` 128 (`common/xash3d_types.h`, and the menu's copy in its own patch).
  `SV_InitGame`'s clamp, every array sized by it and the server browser's filter follow.
- The two messages that carry a slot in `MAX_CLIENT_BITS` bits keep 5 (`MAX_CLIENT_BITS_LEGACY`, new in
  `protocol.h`) on a server of 32 slots or fewer, so it sends exactly what it did, and GoldSrc's pings,
  which reuse `CL_UpdateUserPings`, stay right. A server of more slots sends `svc_h9updateuserinfo` (54)
  and `svc_h9pings` (55), the same messages with the slot as a byte (54 and 55 were unused in Xash's
  protocol; GoldSrc's 54 and 55 are parsed on their own path). The width cannot follow `svc_serverdata`'s
  maxclients: the reliable broadcast reaches a client before it.
- An older or stock client cannot read them, so a server of more than 32 slots refuses any client without
  `NET_EXT_H9_SLOTS128` (bit 24 of the connect `ext`, which the client now sets on every non-loopback
  connect) with "This server needs a newer H9XASH: download it from https://havoc9.org/downloads/ ...". The
  local client of a listen server is exempt. Older servers ignore the bit.
- The voice listeners were one `uint` a client, `BIT( i )` past 31 shifting out of range: a bit array of
  `MAX_CLIENTS` bits with `SV_LISTENER_TEST/SET/CLEAR`.
- `net_encode.c`: `Delta_H9SlotField`, at the end of `Delta_ParseField`, sizes the fields that hold a
  player slot (`entity_state_t`/`entity_state_player_t` `owner`, `clientdata_t` `iuser2`, the spectator's
  target): 8 bits on a server of more than 32 slots; at 32 or fewer `owner` goes back to the 6 bits
  `engine-h9-deltabits.patch` gave it before `MAX_CLIENT_BITS` changed, and `iuser2` keeps delta.lst's
  width, so `delta.lst` itself is unchanged. It is a function of its own, after the field is parsed,
  because every line of `Delta_H9WidenIndexField` and its call belong to #19's hunks (a first version that
  edited them broke #19's reverse check).
- `SV_InitGame`: past 32 slots the packet entity ring holds half the entities a frame (`NUM_PACKET_ENTITIES
  / 2`): 170 MiB at 64 slots and 340 at 128, in a 32-bit server's 2 GB; at 32 or fewer it is as before. A
  delta base that has rolled off the ring is already sent as a full update.
- `MAX_GOLDSRC_EDICTS` keeps `MAX_CLIENTS_LEGACY * 15`: GoldSrc servers have 32 slots at most.

Made with `diff -u` against copies of the eleven files taken with the whole chain applied (travel
included); the mainui patch the same way, LF like the other mainui patches. Verified: the reverse check of
all 33 patches in `xash.bat`'s order, all in place; the new patch forward on the pre-edit copies, and a
round trip, the eleven files byte for byte the same (line endings aside); syntax-only compiles of the eight
changed `.c` files, native clean; the wasm32 checks fail only on the new names (`MAX_CLIENTS_LEGACY`,
`svc_h9pings`, ...) because that checker reads `webclient-build`'s copy of the headers, which the web
build syncs before it builds. Not built: the engine (one coordinated engine build after this phase).

### 2026-11-02 -- engine-h9-idproof.patch (new), engine-h9-avatars.patch (new)

The engine halves of two H9 features whose server and site halves were already built: the presence ID
proof (docs\H9_PRESENCE.txt section 8) and the scoreboard's pictures (docs\PLAYER_LIMIT_128.txt 11.7).

`engine-h9-idproof.patch`:
- `client/cl_idproof.c` (new). SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) of its own: FWGS has MD5
  only. A device id of 16 bytes from the OS (`RtlGenRandom` from advapi32, which the engine already
  links; `/dev/urandom` elsewhere), made on first use and kept in `device_id.ini` in the root folder
  (`g_fsapi.GetRootDirectory`); a file there that holds no valid id is left alone and the proof stays
  off. The cvar `_h9idv` (`FCVAR_USERINFO|FCVAR_PRIVILEGED`) is 1 while the id is there, so the key is in
  the userinfo the server reads. `h9_idchallenge <nonce>` is an ordinary command, so a server's
  stufftext runs it (no filtered prefix); it answers only while connected, a nonce of 32 lowercase hex,
  with a `cl_h9_userid` of 32 lowercase hex, at most four times a minute, with the client command
  `h9_idproof <nonce> <devmask> <proof>` (`CL_ServerCommand`). The browser build compiles neither.
- `client.h`: `CL_H9Id_Init`'s prototype in a section of its own after `cl_qparse.c`'s. `cl_main.c`:
  `CL_H9Id_Init()` in `CL_Init` right after the client library is loaded, clear of #28's lines.

`engine-h9-avatars.patch`:
- `client/cl_avatar.c` (new). The message `H9Avatar`, of fixed size 9 (byte slot, long account, long
  version), is read in `CL_ParseUserMessage` beside `ScreenShake` and `ScreenFade`; one of another size
  goes on to the client library as before. The address is built here from `https://havoc9.org`
  (`cl_h9_site` may name `http://127.0.0.1:<port>` or `http://localhost:<port>` for testing, nothing
  else; both cvars `FCVAR_PRIVILEGED`). `HTTP_GetToMemoryEx` with `HTTP_MEM_PUBLIC_ONLY |
  HTTP_MEM_VERIFY_TLS` (none for the local test site), four at once, 32 KB at most; the PNG's own header
  must say 64 x 64 or less before imagelib decodes it (`FS_LoadImage`, `Image_Process` to RGBA). The file
  is kept as `downloads/h9avatars/<account>_<version>.png` (stage-h9xash.ps1 leaves `downloads` out of the
  package) and read from there next time. The pixels go to the client library's `HUD_H9Avatar( slot,
  version, wide, tall, rgba )`, looked up with `COM_GetProcAddress` (NULL clears the slot); a library
  without it gets nothing. A picture that failed is not asked again this session. `cl_h9_avatars 0` turns
  it off.
- `client.h`: the `CL_Avatar_*` section before `cl_efrag.c`'s. `cl_main.c`: `CL_Avatar_Init()` at the end
  of `CL_Init`, after #32's line and outside its context. `parse/cl_parse.c`: the `H9Avatar` branch after
  `ScreenFade`, away from #28's `CL_Motd_UserMessage` lines.

Made with Python's difflib (three lines of context, `diff --git` headers as git writes them) against
copies of `cl_main.c`, `client.h` and `cl_parse.c` taken with the whole chain applied, slots128 included;
the avatars patch against copies taken after the idproof patch. Verified: the reverse check of all 35
patches in `xash.bat`'s order, all in place; a round trip of the two (both taken out, then applied again
in order), the five files byte for byte the same; MSVC syntax-only compiles (`/Zs`, the arguments waf
recorded) of `cl_idproof.c`, `cl_avatar.c`, `cl_main.c` and `cl_parse.c`, clean; the hashing part of
`cl_idproof.c` compiled alone (`H9_IDPROOF_SELFTEST`) and checked against FIPS 180-4, RFC 4231 and the
proof vectors of docs\H9_PRESENCE.txt section 8, all equal.

### 2026-11-02 -- engine-h9-shellwhite.patch (new)

kRenderFxGlowShell's second pass (`R_StudioRenderModel`, #10's `R_StudioDrawXray`, and The Specialists'
own `StudioRenderModel`, which takes the sprite from `IEngineStudio.GetChromeSprite()`) binds
`sprites/shellchrome.spr` with `TriSpriteTexture` and forces `STUDIO_NF_CHROME`, and `R_StudioSetupSkin`
then binds nothing for each mesh. H9 shipped no `shellchrome.spr` (it is one of the engine's built-in
sprites, `cl_default_sprites` in `cl_tent.c`, which no map or game DLL names, so the Valve-asset audit
never listed it): `cl_sprite_shell` was NULL, `TriSpriteTexture( NULL )` returns 0 without a bind, and
every shell was drawn with the last skin texture the model had drawn, tinted by the rendercolor. That is
the "glow locked to yellow" report: `.stim`'s white glow showed the skin's yellow, `.ammo`'s yellow a
darker yellow, and a model whose last mesh is a green hat glowed green for both.

The fix is twofold: H9XASH\valve now ships an original `sprites/shellchrome.spr` (SMAK, see
valve\REPLACEMENTS.md), and this patch is the engine's fallback for an install without it:
`R_StudioSetupSkin`, under `STUDIO_NF_CHROME`, binds `tr.whiteTexture` when
`GetDefaultSprite( REF_CHROME_SPRITE )` is not a loaded sprite. With the sprite there nothing changes.

Made with `git diff --no-index` against a copy of `gl_studio.c` taken with the whole chain applied
(idproof and avatars included), the paths rewritten to `ref/gl/gl_studio.c`. Verified: the reverse check
on the live tree; forward on the pre-edit copy and a round trip, the file byte for byte the same (line
endings aside).

### 2026-11-02 -- engine-h9-consoleoverlay.patch (new)

The console's top-left overlay (`Con_DrawNotify`) redraws the last few lines of console output
over the game; those lines are not the console history. Added `con_shownotify` (archived client
cvar, default 0): the notify lines are not drawn over the game, while the same lines remain in
the console. `con_shownotify 1` restores the overlay. The chat/say input line is drawn by the
same function and is not affected.

Made with `git diff --no-index` against a copy of `console.c` taken with the whole chain applied
(`engine-h9-chatinput.patch` included), paths rewritten to `engine/client/console.c`. Verified:
reverse check on the live tree; forward on the pre-edit copy with `core.autocrlf=false` and a
byte-for-byte match; the full chain's 36 existing patches reverse-check clean, and the new patch
reverse-checks clean as the 37th. Built: `xash.bat engine` rebuilt and installed `xash.dll`
(SHA256 `755845531AE9CA5A036BE4598552D8FAFF49AD5A24D1323DA09D8ACF61E54846`, 3,972,096
bytes); all 37 patches reported in place.

### 2026-11-02 -- engine-h9-webquit.patch (new)

Quitting the web client (the menu's Quit or X, or `quit` in the console) went back to the site's front
page with "Xash Error: Mem_FreeBlockSmall: not allocated or double freed (free at
..\engine\common\cmd.c:590)". In the browser build `Sys_Quit` (#26) runs `Host_ShutdownWithReason`,
which frees `host.mempool` (`Cmd_TokenizeString`'s `cmd_argv` strings are `copystring`s in it) but
leaves `cmd_argc` as it was, then stops the main loop and tells the page, and the module stays
loaded. client.js's `gameQuit` goes to the front page; its `pagehide` handler then still called
`Cmd_ExecuteString("disconnect")` (`disconnectNow`, which only skips a stopped game), and
`Cmd_TokenizeString` freed the previous command's arguments a second time.

`Cbuf_AddTextToBuffer` and `Cmd_ExecuteStringWithPrivilegeCheck` now return at once when
`host.shutdown_issued` is set, under `#if XASH_EMSCRIPTEN`: those two are behind both of the page's
ways in (`Cbuf_AddText` and `Cmd_ExecuteString`, exported by `engine.patch`), and no frame runs after
the shutdown, so nothing that could still run is dropped. No caller of either runs during
`Host_ShutdownWithReason` itself (checked: the `Cmd_ExecuteString` and `Cbuf_Execute` callers are
input, demo, menu, renderer start-up and server client commands). The guard is not put in
`Cbuf_AddText` or `Cmd_ExecuteString` themselves: `engine.patch`'s two `cmd.c` hunks end on the first
line of those functions' bodies, and a line added there broke its reverse check (tried first; the chain
check caught it).

Made with `git diff -- engine/common/cmd.c` (no earlier uncommitted change in that file; #7 is
committed). Verified: the reverse check on the live tree; forward on the pre-edit copy with
`core.autocrlf=false`, the result byte for byte the same; the full chain's 37 earlier patches
reverse-check clean, and the new patch reverse-checks clean as the 38th.
Built: the web client, from a fresh-clone snapshot of the repository by build-webclient.cmd with the
chain of 42 (this patch and the four after it): xash.wasm 4,808,270 bytes, SHA-1
`bd82a24a21a613d057a498099941ec47d2dc51d6`, both guards in its `cmd.c`. Not yet run in a browser. The
Windows build compiles this patch out; H9XASH\ENGINE.txt lists it from the next `xash.bat engine`.

### 2026-11-02 -- engine-h9-typing.patch (new), engine-h9-brushshell.patch (new)

**engine-h9-typing.patch.** ts_floatchat.sma's "typing" bubble never showed: it hooked
`messagemode`/`messagemode2` with `register_clcmd`, and those are the engine's own client commands
(`Con_MessageMode_f`/`Con_MessageMode2_f` in `console.c`) that run on the client and are never sent
to the server -- the same on GoldSrc. `Key_SetKeyDest`, the one function every change of `key_dest`
goes through on the desktop, now notes whether the chat line (`key_message`) was open before and is
after, and on a change `Key_H9Typing` sets the userinfo key `_h9typing` to "1" or "0" in the
userinfo string and, while connected, sends it with `CL_UpdateInfo` (the `_h9travel` pattern of #29).
A key beginning with `_` reaches the server's game (`ClientUserInfoChanged`) and is not passed on to
other players. Closing the line without sending, or a menu or the console taking over, all go
through `Key_SetKeyDest`, so the key is "0" again before the next connect. A stock server ignores
the key.

**engine-h9-brushshell.patch.** The per-viewer glow ts_matchmode now puts on the siege objectives
(blue to defend, red to attack, white for no side) is `kRenderFxGlowShell` in the entity state, and
an objective is a brush (`func_wall`): the glow shell is drawn only by the studio renderers
(`gl_studio.c`, `r_studio.c`). `R_DrawBrushModel`, after its own pass and before the transform is
reset, calls `R_DrawBrushShell` for a brush with that renderfx: every surface's polys again, each
vertex pushed out along the surface's plane (negated for `SURF_PLANEBACK`) by
`H9_BRUSH_SHELL_PUSH` (1) + renderamt/128 units, textured with the chrome sprite (or `tr.whiteTexture`
when `sprites/shellchrome.spr` is not loaded) with world-planar coordinates scrolling with client
time, `GL_MODULATE` by the rendercolor, blended `GL_SRC_ALPHA, GL_ONE`, depth test on and depth
writes off, fog off for the pass; sky surfaces are skipped. Texture units past 0 are cleaned up
first, and the pass leaves blend off, depth writes on, `GL_REPLACE` and the colour white. ref_soft is
not changed.

Both made with `git diff --no-index` against copies of the two files taken with the whole chain
applied (38 patches, `engine-h9-webquit.patch` the last), paths rewritten. Verified: each reverse-checks
on the live tree; forward on its pre-edit copy with `core.autocrlf=false`, the result byte for byte the
live file; the 38 earlier patches all reverse-check clean with both in place. Built: `xash.bat engine`
rebuilt and installed `xash.dll` (SHA256 `24074E779B17D076B65F9FDC90FFD981A0C4D3754CE2FBA07219101112A87593`, 3,972,096 bytes) and `ref_gl.dll`
(SHA256 `D67F913932E537FF36BC13DF761D3161BE9C0936FAD1130AA3D1DC8BA3D03B91`, 1,095,680 bytes); all 40 patches reported in place.

### 2026-11-02 -- engine-h9-serverfog.patch (new)

The user: sudden death's thick green fog does not show. Traced end to end:
- ts_matchmode: `sudden_fog(true)` runs in the block that turns sudden death on (the same one that shows
  SUDDEN DEATH and starts the x-ray) and sets `h9_fog_r/g/b/density` to `tsm_sudden_fog_*` (40, 140, 45, 90)
  with `set_cvar_num`, which AMX Mod X turns into `Cvar_DirectSet` on the engine's own cvars; round start
  and a clock pushed back above the mark zero them.
- #9 (`engine-h9-suddendeath.patch`, in place, in the shipped xash.dll and ref_gl.dll): `SV_H9ServerFog`
  packs the four into `svgame.movevars.fog_settings` at the top of every `SV_Physics` and sets
  `host.movevars_changed`; `SV_UpdateMovevars` sends the delta on the reliable datagram; `fog_settings` is
  field 27 of FWGS's built-in `movevars_t` delta (32 bits); `CL_ParseMovevars` copies it into
  `clgame.movevars`, which is ref_gl's `gp_movevars`; `R_CheckFog` turns `RI.fogEnabled` on for any non-zero
  value; `R_DrawFog` draws GL_EXP fog before the world (density 90: 0.0035 a unit, half fog at 200 units).
  No other patch touches that path: #10 (x-ray) and #34 (shellwhite) only toggle fog around their own
  passes through `R_AllowFog`; #35 (consoleoverlay) is `console.c` alone.
- The one switch in the way: `R_DrawFog`, `R_AllowFog` and `R_Set2DMode` all require ref_gl's `gl_fog`. TS's
  client.dll (reTS `CHud::Init`) registers `gl_fog` itself with a default of 0 (its own switch: 0 hides a
  map's `ts_fog`), and FWGS's `Cvar_Get` sets an existing cvar to the new registrant's default, so the engine's
  fog switch goes to 0 the moment client.dll loads and comes back only if a config read afterwards says
  `gl_fog 1`. A player whose config has no `gl_fog` line, or who turned TS's map fog off with `gl_fog 0`,
  never sees the bog.

The fix: `R_FogAllowed()` -- `gl_fog`, or the server's fog (`RI.fogEnabled` with `fog_settings` non-zero) --
in place of `gl_fog.value` in `R_DrawFog`, `R_AllowFog` and `R_Set2DMode`. `gl_fog` still decides water fog
and a map's `ts_fog` (`TriFog` is untouched). If the bog still does not show with this in, the client's
`[H9 fog debug]` line (#9, `developer 1`) says whether the value reaches the client at all.

Made with `git diff --no-index` against copies of the three files taken with the whole chain applied (38
patches, brushshell the last), paths rewritten. Verified: reverse check on the live tree; forward on the
pre-edit copies with `core.autocrlf=false` and a round trip, the three files byte for byte the live ones;
the 40 patches in `xash.bat`'s list all reverse-check clean with it in place; MSVC `/Zs` of `gl_rmain.c`
and `gl_draw.c` with waf's recorded arguments, exit 0. Not yet built.

### 2026-11-02 -- engine-h9-listen.patch (new)

The user wants presence on Create Game servers, for the player hosting as for anyone joining. The player
who starts a listen server joins it over loopback, which has no address: `ID_GetMD5ForAddressEx` salts
`h9_clientid` with nothing for `NA_LOOPBACK`, and `cl_idproof.c` signs S = `NET_AdrToString` = "loopback",
so h9web, which keys both to the address the server reports as, knew neither.

The fix asks the server, which knows the address it reports as, to say it: h9_presence 1.4 sends its own
loopback player `h9_idlisten <address>` (and `h9_idlisten <address> <nonce>` in place of `h9_idchallenge`).
`cl_h9listen.c` answers only a loopback connection (never a demo), so no server elsewhere can choose what
a player salts with or signs; it writes the address back in its one form, salts `h9_clientid` with it
through `ID_GetMD5ForAddressEx` (the remote joiner's value exactly), sends the change with `CL_UpdateInfo`,
and with a nonce answers `h9_idproof <nonce> <devmask> <proof>`, as cl_idproof.c does, at most four times a
minute. The userinfo key `_h9idl` "1" says the game has it. `cl_idproof.c` (a whole-file patch, #32) is not
touched: the new file includes its hashing part with `H9_IDPROOF_SELFTEST` defined and reads
`device_id.ini` itself, on first need (a first run makes the file after this init).

Made with `mkpatch.py` (difflib, three lines of context) against copies of `cl_main.c` and `client.h` taken
with the whole chain applied (41 patches, serverfog the last), plus the new file. Verified: the 42 patches
in `xash.bat`'s list all reverse-check clean with it in place; MSVC `/Zs` of `cl_h9listen.c` and `cl_main.c`
with waf's recorded arguments, exit 0.

### 2026-11-02 -- engine-h9-reliableburst.patch (new)

A Create Game server of 64 slots fell over, client and server together, the moment its player joined a
side and the match mode put 63 bots on sides, renamed them and spawned them at once. Every one of those
renames marks the bot `FCL_RESEND_USERINFO`, and `SV_UpdateToReliableMessages` writes the updates into
`sv.reliable_datagram` (16 KB, shared by every client) while `MSG_GetNumBytesLeft` >= the userinfo's
length + 6. The update is the userinfo plus about 24 bytes (command, slot, userid, the active bit, the
digest), so near a full buffer the last one ran past its end: `MSG_WriteUBitLong` then stops at the
buffer's end and marks it overflowed, nothing checked `sv.reliable_datagram`'s overflow, and its bits,
the cut-off update and whatever followed in the buffer, went into every client's reliable stream. 31
bots' updates fit in 16 KB; 63 do not, which is why 32 slots never showed it.

Now `SV_UpdateUserInfo` writes the update into a buffer of its own and copies it into the shared one only
whole; one that does not fit keeps `FCL_RESEND_USERINFO` and goes in a later frame (the updates were
already queued that way when there was no room at all, so the same burst now spreads over a few frames).
The room check counts 32 bytes around the userinfo. `SV_DropClient`'s notification goes through the new
`SV_BroadcastReliable`: into the shared buffer when it fits whole, else into each connected client's own
reliable stream. And `SV_UpdateToReliableMessages` drops an overflowed `sv.reliable_datagram` (pause,
stufftext, decals, lightstyles and the rest still write into it directly) with an error line, marking every
spawned player for a userinfo resend, instead of copying it out cut off. A server of 32 slots or fewer
sends the same messages as before, in the same frames unless the buffer was that full.

Made with `diff -u` against copies of the three files taken with the whole chain applied (42 patches,
listen the last). Verified: reverse check on the live tree; forward on the pre-edit copies with
`core.autocrlf=false`, the three files byte for byte the live ones; the 43 patches in `xash.bat`'s list all
reverse-check clean with it in place.

### 2026-11-02 -- engine-h9-typing.patch (regenerated: a client command, not a userinfo key)

The first version set the userinfo key `_h9typing` on every opening and closing of the chat line.
The user's first test: the bubble showed once, then not again for a long while. FWGS's userinfo
flood protection (`SV_ShouldUpdateUserinfo` in `sv_client.c`: `sv_userinfo_penalty_time` 0.3,
`_multiplier` 2, `_attempts` 4) counts every userinfo change, so two a chat line (open, close)
trip it within a few lines, and from then on the changes inside a growing window are dropped
before the game ever hears them. Exempting the key in the server would still have sent a full
userinfo update to every player and run TS's and the plugins' userinfo handlers on every
keystroke of the chat line, for what is an event, not part of who a player is.

So `Key_H9Typing` now sends the client command `h9_typing 1` / `h9_typing 0` (`CL_ServerCommand`,
reliable, in order, every time; nothing in the userinfo). It is sent only while connected and not
in a demo, and only to a server whose game registered the `H9Typing` user message
(`Key_H9TypingServer`, a look-up in `clgame.msg`): ts_floatchat.sma registers it and never sends
it, so a server without the plugin -- a stock one, a GoldSrc one -- is never sent a command it
would answer with "Unknown command". (A name linked by an earlier server keeps its number until a
message of the new server takes that number, so a stock server visited right after an H9 one may
still be sent the command; it prints nothing but that line in the console.) ts_floatchat keeps
reading `_h9typing` for a client with the first version of this patch.

Every way the line closes goes through `Key_SetKeyDest` -- Enter and Escape (`Key_Message`), the
console, the menu, a level change or a disconnect (`cl_main.c`, `cl_parse.c`, `cl_gameui.c`) -- so
each sends `h9_typing 0` while connected. The user's second report, a bubble left up after Escape,
was the first version's `_h9typing 0` dropped by that same penalty, with no "say" after it to take
the bubble down. And as a safety net the open line is said again: `Key_H9TypingFrame`, called from
`Host_InputFrame` every frame, sends `h9_typing 1` again every `H9_TYPING_KEEPALIVE` (2) seconds
while the chat line stays open, so ts_floatchat lets a bubble go after a few seconds with no word
(a close it never heard), and a line still open across a level change is said again on the new one.

Regenerated with `git diff --no-index` against pre-edit copies of `in_keys.c` and `input.c` (the
whole chain applied up to #36; #28 touches both files, #8 `input.c`, all clear of these hunks); no
later patch touches either file. Verified: reverse check
on the live tree; forward on the pre-edit copy with `core.autocrlf=false`, the result byte for byte
the live file; the 46 patches in `xash.bat`'s list all reverse-check clean with it in place.

### 2026-11-02 -- engine-h9-link.patch (new), mainui-h9-link.patch (new), mainui-h9-default64.patch (new)

The user: link the downloaded game to a havoc9.org account in game, with no id typed or pasted, and
keep the id "salted and hashed" rather than in plain text; a Link your Account button in the main menu
that turns into Unlink account once linked, with the scoreboard's chain beside it; not in the web
client. And, separately, Create Game's Max players at 64.

**engine-h9-link.patch.** `client/cl_h9link.c` (new) owns `user_id.ini` from now on. The id is sealed
with `CryptProtectData` (crypt32.dll, loaded at run time: the engine does not link it) for the Windows
user, with an entropy of the file's own, and kept as `protected=<hex>` under `[client]`; records of
other Windows users (or of the other system of a dual boot) are kept as they were, three at most. The
record inside holds the id and, once linked, the linked id, the account's username and the link token.
A plain `id=` line (older builds, `enter_userid.cmd`, a hand edit) is taken as the id and sealed at
once, and `user_id.ini.bak` (an older id in plain text) is deleted. The engine sets `cl_h9_userid`
from it: `CL_H9Link_Init`, at the end of `CL_InitLocal` (after #15 registered the cvar, before any
config runs), takes `FCVAR_ARCHIVE` off the cvar and sets `FCVAR_READ_ONLY` at run time, so #15's
definition line is not touched (that would break #15's reverse check) while config.cfg stops keeping
the id and no stale `cl_h9_userid` line in config.cfg or `userid_resolved.cfg` can set it; the value
goes in with `Cvar_DirectFullSet`. Per-server salting (identification.c) and the ID proof (#32, #40)
read `cl_h9_userid` as before.

`h9_link` asks h9web for a device code (`GET /api/link/start`, then `GET /api/link/poll` every
interval; the engine's HTTP client is GET only and reads a body only from a 200, so h9web answers 200
with a status for every outcome), shows it (mainui's dialog in the menu; in a game, a panel in #28's
registry and then a one-line notice), opens `<site>/link/?code=` on `h9_link open` (the player's
alone: `open` and `cancel` from a server's stufftext are ignored), and on approval seals the account's
player id, its username and the link token, sets `cl_h9_userid` and, connected to a server whose
`h9_clientid` the connect packet set, salts it again and sends it (loopback is left to #40). A server
may send `h9_link` (h9_link.sma's `.link`): it only puts up a code, at most three in ten minutes and
never while one is up. `h9_unlink` is privileged: a new random id, h9web told. A linked game asks
`GET /api/link/status` once a start, 10 s in, and unlinks itself when h9web says the link is gone
(REVOKE on the ACCOUNT page, or the player id reset). While the menu is up and nothing is connected,
`user_id.ini` is looked at every 2 s (a stat), so a deleted or changed file shows in the menu at once.
The cvars `_h9lnk` (userinfo: servers read it), `_h9link_account`, `_h9link_flow`, `_h9link_code` and
`_h9link_text` carry the state to the menu. The site is `https://havoc9.org` with the certificate
checked; `cl_h9_site` may name the local test site, as for #33. Windows only (Wine and Proton run the
same calls in Wine's crypt32); the browser build gets an empty `CL_H9Link_Init`.

**mainui-h9-link.patch.** `menus/Main.cpp`: `CMenuH9LinkButton`, a `CMenuPicButton` at the top of the
column (above the console button's place, or in it while that is hidden), named Link your Account or
Unlink account from `_h9lnk` and hidden when the engine has no `_h9lnk`; it draws
`gfx/vgui/h9_link.tga` (green, linked) or `gfx/vgui/h9_unlink.tga` (red, broken) after its text, the
presence agent's scoreboard icons. Not linked, it opens `CMenuH9LinkDialog` (a `CMenuYesNoMessageBox`
that reads `_h9link_flow`, `_h9link_code` and `_h9link_text` every frame; OPEN PAGE runs `h9_link
open`, CANCEL `h9_link cancel`); linked, the main menu's yes/no box asks, then runs `h9_unlink`. All
under `#if !defined( __EMSCRIPTEN__ )`. Its hunks sit before `CMenuMain`, in its member lists, after
`HazardCourseDialogCb` and at the end of `_Init`: clear of `engine-mainui.patch`'s `VidInit` hunks.

**mainui-h9-default64.patch.** `menus/CreateGame.cpp`, `maxClients.onCvarGet`: `SetBuffer( "64" )`
for a `maxplayers` of 1 or less. The working tree held an untracked hand-edit there ("16" -> "32",
in no patch); this patch is made against HEAD's "16", so a clean rebuild gets 64 and the loose edit
is gone.

Made with a temporary index: before the edits, `git read-tree HEAD` and `git add` of `cl_main.c` and
`client.h` into an index of its own (the whole chain's state of those files), `git add -N` of the new
file, then `git diff` against that index; the mainui patches with `git diff HEAD` in the submodule
(Main.cpp was unchanged from HEAD, CreateGame.cpp is diffed from HEAD on purpose). LF, as every patch
here. Verified: forward `git apply --check` and a real apply on pre-edit copies (`core.autocrlf=false`
for the engine files, `true` for mainui's CRLF files), the results byte for byte the live files; the
46 patches in `xash.bat`'s list all reverse-check clean with the three in place. The store and the
parsing built alone (`H9_LINK_SELFTEST`, MSVC /W4, 32-bit) and run against a scratch folder: 59
checks (DPAPI round trips, the entropy, the plain id's migration and `.bak`, the link record, an id
changed or kept by `enter_userid.cmd`, other users' records, the JSON reader, the user code, and the
device hash against docs\H9_PRESENCE.txt's test vector), all pass.

**engine-h9-userinfo.patch.** A player's userinfo as the server keeps it (`sv_client_t.userinfo`,
`server.h`) is `H9_MAX_USERINFO`, twice `MAX_INFO_STRING`, and `pfnSetClientKeyValue` (`sv_game.c`)
writes a player's own buffer to that size. At 256 bytes FWGS's `Info_SetValueForKey` removes the key
it is writing and saves nothing when the new value does not fit. TS keeps a player's team in the
"team" infokey (`ChangePlayerTeam`, read back at the respawn), so with the long team name "middle sea
republic" a human, whose userinfo carries the engine's, H9's and the game's keys, lost the team on the
respawn after joining and landed on the emptiest team, the spectators. Bots, with half the keys, never
did. `SV_FullClientUpdate` (`sv_client.c`) copies the whole buffer, strips the `_` keys as before, and
cuts a userinfo still longer than `MAX_INFO_STRING` to the keys a client reads of another player
(`SV_UserinfoForOthers`: name, model, topcolor, bottomcolor, team, skin, *hltv, *sid). Every client,
old ones included, still gets at most what its `player_info_t` keeps; `player_info_t` is unchanged,
since the studio API hands it to client.dll.

Made with a temporary index: before the edits, `git read-tree HEAD` and `git add` of the three files
into an index of their own (the whole chain's state of them), then `git diff` against that index. LF.
Verified: `git apply --reverse --check` in the live tree, a forward `git apply --check` on pre-edit
copies, and all 46 patches in `xash.bat`'s list reverse-check clean with this one in place.

### 2026-11-02 -- engine-h9-link.patch, mainui-h9-link.patch, engine-h9-presence.patch, engine-h9-avatars.patch (regenerated), engine-h9-serverinfo.patch (new), mainui-h9-browser.patch (new)

The user's batch after the 2:40 reset (the link agent's items 11 and 12, and the engine half of item 6).

**engine-h9-link.patch (regenerated: the link's site).** A link made on the local test site
(`cl_h9_site "http://127.0.0.1:8090"`) and checked later against havoc9.org, which does not know its
token, made the game drop the link and the id with it. The sealed record now holds `site=`, the site
the code came from (`https://havoc9.org` or a local test site, checked by `H9L_IsSite`; a linked
record from before, with none, is havoc9.org's). The start's status check asks that site alone, and
only while `cl_h9_site` points to it (otherwise one console line, and the link and the id stay);
`H9L_StatusAnswer` acts only on an answer whose address starts with that site; `h9_unlink` tells
that site. Every request goes through `H9L_GetAt( site, ... )`. The code's flow keeps its own site
(`flow_site`): polled there, and the site of the link it makes. The texts name the site the game
really talks to, and a new read-only cvar `_h9link_site` gives it to the menu (the code's site while
one is up, else the link's, else `cl_h9_site`'s). Only the new-file section was regenerated (git's
own `/dev/null` diff of `cl_h9link.c`); the `cl_main.c` and `client.h` hunks are as they were. The
store's test build (`H9_LINK_SELFTEST`) gained the site cases: 66 checks, all pass.

**mainui-h9-link.patch (regenerated).** The button moves from the top of the column to the row
directly below Change Game, above Quit: `CMenuMain::H9LinkPlace`, called right after `VidInit` (in
`_VidInit` and `DisconnectCb`), moves every shown button above Quit (and the console button, which
`developer` may show later) up one row and puts Link your Account in the row it left; an engine
without `_h9lnk` keeps the column as it was. Texts: "Link your Account" (hint "Link this game to
your havoc9.org account") and "Unlink your Account" (hint "This game is linked to your havoc9.org
account"). The dialogs name `_h9link_site`. `engine-mainui.patch`'s `VidInit` hunks are untouched.

**engine-h9-presence.patch (regenerated).** The Discord card's activity has a party, `"party":{"size":
[people, slots]}`, from the server's own status reply (`numcl` is the people, bots apart), so the card
reads "N of 64". Only the `cl_presence.c` new-file section changed.

**engine-h9-avatars.patch (regenerated).** The cached picture's name holds the site
(`downloads/h9avatars/havoc9_<account>_<version>.png`, `local<port>_...` for the test site), so a
test site's pictures never pass for havoc9.org's; the failed list is for one `cl_h9_site` and starts
over when it changes; each picture that fails says so once in the console, with its address. Only
the `cl_avatar.c` new-file section changed.

**engine-h9-serverinfo.patch (new).** `SV_Info`'s `bots` key sat in the working tree in no patch (the
shipped xash.dll had it, a clean rebuild would not): this patch carries it, made against the chain's
own `sv_client.c` (HEAD through #30, #41 and the userinfo patch, checked equal to the working tree
less that line), and adds `auth` "1" while `h9_require_account` is 1 (7 bytes of the 512, before the
hostname, which is cut to what is left). `CL_ParseGoldSrcStatusMessage` gives mainui `numcl` as
players less bots and `bots` apart; the NetAPI answer below it keeps GoldSrc's count.

**mainui-h9-browser.patch (new).** `server_t` reads `bots` and `auth`; the players column shows
"1/64 (+63 bots)" (180 wide); `IsEmpty` is no people and no bots, `IsFull` people and bots at the
slots; the players sort goes by people, then bots; `COLUMN_ACCOUNT`, an image column after the lock,
shows `gfx/shell/h9_account` (16 x 16, H9's purple person on black like the lock, drawn by
tools\make_account_icon.py into the overlay's ts\gfx\shell) for a server whose info says `auth` 1.

Made: the serverinfo patch with a temporary index holding the chain's `sv_client.c` (the working
tree less the loose line) and the pre-edit `cl_main.c`; the mainui patches with `git diff HEAD`
(neither file has another patch's change); the regenerated sections with `git diff --no-index
/dev/null <file>`, spliced in place of the old section, every other section byte for byte. Verified:
the chain's patches rebuilt `sv_client.c` and `cl_main.c` from HEAD to exactly the pre-images; each
new or regenerated patch round-trips (reversed and applied again on scratch copies of its files,
with the repo's `.gitattributes` and `core.autocrlf`, byte for byte the live files); all 49 patches
in `xash.bat`'s list reverse-check clean.

### 2026-11-02 -- engine-h9-link.patch, engine-h9-avatars.patch (regenerated: cl_h9_site read leniently; adopting a held id)

The user's first try: the game said it could not reach havoc9.org, because its config had
`cl_h9_site ""`, and an unquoted `cl_h9_site http://127.0.0.1:8090` is cut at `//` by the console
(a comment), leaving `http:`. And a game whose id is already an account's (the server proves it, the
scoreboard's chain is green) still offered Link your Account, because its record had no token.

**cl_h9_site.** `H9L_SiteOf` (`cl_h9link.c`, in the store part, so the test build has it) takes
`http://127.0.0.1:<port>`, `http://localhost:<port>`, the same without the scheme, in any case,
with spaces and slashes at the end; anything else is havoc9.org. What it gives is canonical
(`http://host:port`), the only form a record's `site=` holds (the updater reads it too). The port
must be 1 to 65535 with no leading zero (`H9L_LocalSite`, and `H9Av_LocalSite` alike). Two seconds
after start (once the configs have run) and whenever the cvar changes, the console says the site
in use (`H9 SITE: ...`), or why a value was not taken: cut at `//`, or not a local test site.
`cl_avatar.c`'s `H9Av_Site` reads the cvar the same way for the scoreboard's pictures.

**Adopting.** A record with an id and no link asks the site in use, ten seconds after start and
while the main menu is up, once for each id and site (again a minute after a try with no answer):
`GET /api/link/adopt/nonce`, then `GET /api/link/adopt` with key = HMAC-SHA256(the id,
"h9adopt-key1"), first 32 hex, and `H9_IdProof`'s devmask and proof for that nonce with S =
`h9link-adopt` (`cl_idproof.c`'s formulas; the raw id never travels). "linked" brings the account
and a token for the device the proof unmasks: the record takes `linked=`, `account=`, `token=` and
`site=`, is sealed and written, and `_h9lnk` turns 1, so the menu reads Unlink your Account.
"unknown" (an install's own random id) is quiet; a refusal (second_device, suspended, bad_proof) is
one console line. `H9L_DeviceRead` reads `device_id.ini` for both this and the device hash. h9web's
half: `lib/link.js` and `lib/clientids.js` (h9web\README.txt section 19).

Made with git's `/dev/null` diff of each new file spliced in place of its old section, every other
section byte for byte. Verified: both round-trip on scratch copies with the repo's line-ending
rules; all 49 patches reverse-check clean; the store's test build gained `H9L_SiteOf`'s cases: 73
checks, all pass.

### 2026-11-02 -- engine-h9-largeaddress.patch (new)

The user asked for HAVOC 9.exe to get all the memory it can. It is a 32-bit PE whose header lacks
IMAGE_FILE_LARGE_ADDRESS_AWARE (characteristics 0x0102), so the game and a `-dedicated` server had
2 GB of address space on 64-bit Windows; docs\PLAYER_LIMIT_128.txt section 13 counts what fills it
(the packet entity ring alone is 170 MiB at 64 slots and 340 at 128, beside the map, the DLLs, AMX
Mod X and RCBot).

game_launch's `bld.program` passes `linkflags = ['/LARGEADDRESSAWARE']` when DEST_OS is win32,
DEST_CPU x86 and COMPILER_CC msvc (this build's configuration, `build\c4che\game_launch_cache.py`),
so link.exe sets the flag (0x20) in the exe's header. A process's address space follows its
executable's flag alone: xash.dll, the renderers, menu.dll, mp.dll, client.dll, Metamod-R, AMX Mod
X, its modules and RCBot are not relinked, and their own header flags mean nothing to Windows. The
changed wscript makes waf's reconfigure tool run configure once on the next build; nothing else is
needed.

At run time nothing changes until the lower 2 GB is used up or too fragmented for a block: Windows
allocates bottom-up, so addresses above 2 GB are handed out only where the process used to fail
with out of memory. The known hazard there (section 13): on 32-bit Xash a string_t is the string's
address minus a static "" in xash.dll (`SV_AllocString`, `SV_MakeString`), so a string allocated
more than 2 GB above it is a negative string_t. The arithmetic wraps back to the right address;
only a signed test on one misbehaves. A scan of reTS (dlls, cl_dll, game_shared, pm_shared),
Metamod-R, AMX Mod X (core and modules), RCBot and every H9 plugin found two, neither on a live path. AMX Mod X's
`find_ent_by_model` skips an entity whose `v.model` is not `> 0` (modules\engine\entity.cpp:1446).
`v.model` comes from `sv.model_precache` (sv_game.c:250, 5159), inside xash.dll's own image, a
small positive offset; only a model string a plugin allocated itself (fakemeta's `set_pev(pev_model,
...)`) could go negative, and `find_ent_by_model` would then miss that entity. No enabled plugin
calls `find_ent_by_model`. H9's plugins pass `EngFunc_AllocString` results straight to
`CreateNamedEntity` and `set_pev`, never into a comparison. The pointer side: RCBot hashes an edict
pointer as `((int)(pLocation)) % MAX_LOCATION_HASHES` (rcbot-upstream dlls\bot.h:631, 642), which
would index below its table for an edict above 2 GB; nothing calls `AddLocation` or `GetLocation`,
and the edicts are one block allocated when the game DLL loads (sv_game.c:5342). RCBot's
`(int)ptr - (int)&string[0]` (bot.cpp:2161) is a difference inside one array, right at any address.

Made: the change in the working tree, then `git diff --cached HEAD` through a temporary index
(read-tree HEAD, add the file); it is the file's only change. Verified: reverse check on the live
tree; round trip on HEAD's file with the file's `eol=lf` (forward gives the live file byte for
byte, reverse gives HEAD's bytes); all 50 patches in xash.bat's list reverse-check clean.
Built: the next `xash.bat engine` run (the link agent's, 2026-11-02 20:14, exit 0) found it in
place, ran waf's configure once for the changed wscript and relinked the launcher. HAVOC 9.exe
then has characteristics 0x0122 (0x0102 before) in H9XASH, in the stage and, through export.bat,
in export\H9XASH and the git copy; the newest history block of `HAVOC 9.exe.patch` carries the
wscript diff.

### 2026-11-02 -- engine-h9-avatars.patch (regenerated: h9_profile)

The scoreboard's double-click on a linked player's picture opens their havoc9.org profile in the
web browser. `cl_avatar.c` keeps, for each slot, the account the last `H9Avatar` named and the
userid of the slot's player then; `h9_profile <slot>`, a restricted command (a server's stufftext
cannot run it; H9's client.dll can), opens `<site>/api/link/profile/<account>` with
`Platform_ShellExecute`, as OPEN PAGE opens the link page. The site is `H9Av_Site()` (havoc9.org, or
`cl_h9_site`'s local test site); the server gives the account's number and nothing else. Another
player in the slot (another userid), no account, or account 2147483647 (the site's default picture,
everybody's) opens nothing and says why in one console line, and a burst of clicks opens one page.
The browser build has no `h9_profile`. h9web's half: `GET /api/link/profile/:account`
(`lib/link.js`) sends the browser on to the account's forum profile. reTS's half: the scoreboard's
`mouseDoublePressed` (`cl_dll\vgui_ScorePanel.cpp`, H9 PROFILES), which runs `h9_profile` only when
the engine has the command.

Made with git's `/dev/null` diff of `cl_avatar.c` spliced in place of its old section, every other
section byte for byte. Verified: `cl /Zs` with the build's own flags (`build\compile_commands.json`);
the patch round-trips on scratch copies with the repo's line-ending rules; all 50 patches
reverse-check clean; built into xash.dll with the `cl_h9_site` and adopting changes.

### 2026-11-03 -- engine-h9-avatars.patch, engine-h9-link.patch (regenerated: H9Account for h9_profile; the adopt wait)

**H9Account.** h9_presence 1.7 sends each linked player's own account number in a new user message,
`H9Account` (byte slot, long account; 0 none), from h9web's answer's `accounts`, which names the
slots `avatars` names (the green chain), a player on the site's default picture included. Before
it, a player with the default picture came only as `H9Avatar`'s account 2147483647, everybody's,
and `h9_profile` could not open their profile. `CL_ParseUserMessage` (`parse/cl_parse.c`) takes
`H9Account` (size 5) after `H9Avatar` and hands it to `CL_Avatar_Account` (`cl_avatar.c`, prototype
in `client.h`), which keeps the account and the userid of the slot's player then. `h9_profile`
takes `H9Account`'s account for the player now in the slot, else `H9Avatar`'s; a server with an
older h9_presence works as before.

**The adopt wait.** A try to adopt the held id that got no answer waits a minute before the next.
A changed `cl_h9_site` (or id) now starts over at once, while the main menu is up, instead of
waiting out the minute of a try made of the site before (`cl_h9link.c`, the frame's adopt block).

Made: `cl_avatar.c` and `cl_h9link.c` with git's `/dev/null` diff spliced in place of their
sections; `cl_parse.c`'s and `client.h`'s sections of engine-h9-avatars.patch with
`regen_modified.py` (D:\temp\link-work): the file as this patch leaves it, taken from the live
tree by reversing the later patches that touch it (engine-h9-listen.patch and engine-h9-link.patch,
for `client.h`) and then this one, the change made there, git's diff of the two as the new section,
and the later patches put back on top, checked to give the live file plus the change. Every other
section byte for byte. Verified: `cl /Zs` of the three sources with the build's own flags; both
patches round-trip on scratch copies with the repo's line-ending rules; all 50 patches reverse-check
clean; the link store's test build 73/73.

### 2026-11-03 -- engine-h9-motd.patch, engine-h9-avatars.patch (regenerated: pictures asked for again)

The user's report: a scoreboard picture that did not come at the first try (the site restarted for a
second, a timeout) never came that session, as a failed picture was not asked for again until the game
restarted, and h9_presence names a picture again only when it changes.

**engine-h9-motd.patch.** `HTTP_MemoryStatus` (`common/http/net_http_xash.c`, prototype in
`common/net_ws.h`): called from an `http_memory_cb_t`, the HTTP status the request's answer had, 0 for
none (no answer, a timeout, a refused or broken connection). `httpfile_t` keeps `mem_status`, set where
the status line is read; `HTTP_FreeFile` holds it while the callback runs. Nothing else changes.

**engine-h9-avatars.patch.** `cl_avatar.c`: a picture that could not be fetched (status 0, 429, a 5xx)
is asked for again while a slot still names it, 15 s, 60 s and 5 minutes after its first, second and
third failed tries, then every 10 minutes; one the site does not have or that is no use (another status,
or a body that is no PNG of at most 64 x 64) waits 10 minutes, not the session. The slots that wanted a
picture keep wanting it after a failure; a picture nobody names any more is not tried again. A new
`H9Avatar` for a slot forgets the failure of the picture it names and asks at once, the same picture or
not (h9_presence's table starts afresh each map, so the map's first answer names every slot again), and
another `cl_h9_site` starts the list over. Each failure is one console line, with "trying again in N s"
or "asked again in 600 s". The asking again runs in the Frame of an H9UI panel that is never up
(`cl_motd.h`'s registry, once a second while a slot waits), whose Reset forgets the slots' wants on a new
map and the slots' accounts on another server. Four fetches at once, as before.

Made: `cl_avatar.c` with git's `/dev/null` diff spliced in place of its section; `net_http_xash.c`'s and
`net_ws.h`'s sections of engine-h9-motd.patch with `regen_modified.py` (no later patch touches them).
Every other section byte for byte. Verified: `cl /Zs` of both sources with the build's own flags; both
patches round-trip on scratch copies with the repo's line-ending rules; all 50 patches reverse-check
clean.

### 2026-11-03 -- engine-h9-link.patch (regenerated: the link's status asked again during play)

A REVOKE on the site reached the game only at its next start (the status check ran once a start), so a
revoked game kept its id, proved it again at the next challenge, and went green again in game. Now a
linked game in a game (`cls.state == ca_active`) asks its link's site again `H9L_STATUS_MAP` (5) seconds
into each map (the H9UI panel's Reset) and every `H9L_STATUS_EVERY` (300) seconds, one ask at a time
(`status_asking`), through `H9L_StatusCheck`, which the start's check uses too: only while `cl_h9_site`
points to the link's own site, as before. On "unlinked" the game drops its id as at a start
(`H9L_DropLink`: a new id, `_h9lnk` 0, `h9_clientid` salted again), and h9_presence 1.7's id_changed
turns the chain red on every scoreboard at once. h9web's `linkStatusPerIp` (60 in 10 minutes) holds
about twenty games behind one address at that pace.

Made with git's `/dev/null` diff of `cl_h9link.c` spliced in place of its section, every other section
byte for byte. Verified: `cl /Zs` with the build's own flags; the store's test build 73/73; the patch
round-trips on scratch copies with the repo's line-ending rules; all 50 patches reverse-check clean.

### 2026-11-03 -- engine-h9-joinscreen.patch (new), mainui-h9-joinscreen.patch (new), engine-h9-motd.patch (regenerated: eight panels)

Joining a server showed the console (upstream's `CL_Connect_f` "TESTTEST" lines) and then the menu
until the server info, with no bar at all: `scr_loading` never moved and the menu's connection progress
hooks, exported by mainui since 2017, were never called (upstream called them in cb417a3d and reverted it
in d2a8cfe6 because the menu then stayed up over demos). Now the menu stays up from the moment a join
starts until the player is in the game, as GoldSrc's loading dialog does, with H9's purple panel over the
menu's own background or video.

**engine-h9-joinscreen.patch.** `cl_h9join.c` (new): the hooks into the join, which set `scr_loading`
and five read-only private cvars the menu reads each frame (`_h9join`, `_h9join_stage`,
`_h9join_server`, `_h9join_file`, `_h9join_fileprog`) and `_h9_drop`, the reason a join or a game ended.
Begin (connect, retry, this game's own server) and ChangeLevel (`svc_changing`, and the server's
`reconnect` after the disconnect it makes for a connection past `ca_connected`) raise the screen;
`CL_ParseServerData` then leaves the menu up for a join the file began; the precache's stages draw a
frame every 0.15 s from inside their one long frame; `CL_CheckClientState` takes the screen down at
`ca_active`. The downloads come from `HTTP_FileProgress` (new in `net_http_xash.c`: the first file of
the HTTP queue being fetched to disk, its name, bytes and size) or from the netchan's `host.downloadfile`
and `scr_download` with the size from the resource list, in an H9UI panel's Frame that is never up
(`cl_motd.h`'s registry, raised from 4 panels to 8 in engine-h9-motd.patch). A reason comes from
`CL_ErrorMsg` (refusals, kicks), a GoldSrc `svc_disconnect`, the timeout, a file the server could not
send and a missing resource the map needs, with color codes and line ends cleaned out; a reason older
than 15 s explains no disconnect, and one that cleans to nothing keeps the one before it. `CL_ErrorMsg`
also returns before showing anything when nothing was formatted: an Xash server's reject (`disconnect`)
follows the errormsg that said why, and upstream showed its uninitialized buffer for it. Nothing changes
for a demo, a timedemo, a background map (this game's own server's, `sv_background`, as well), with
`cl_h9_joinscreen 0` or with a menu without the hooks.

**mainui-h9-joinscreen.patch.** `ConnectionProgress.cpp` rewritten as the screen (row 49);
`UI_StartBackGroundMap` starts no background map while `_h9join` is 1.

**engine-h9-motd.patch.** `H9UI_MAX_PANELS` 8 (the motd, the link, the avatars and the join screen
are four already).

Made: both new patches with git's own diff between snapshots of the touched files as the chain left them
and the files now, in scratch repositories with the source repositories' line-ending rules
(`cl_h9join.c` from `/dev/null`); `cl_motd.c`'s section of engine-h9-motd.patch with `regen_newfile.py`,
every other section byte for byte. Verified: `cl /Zs` with the build's own flags of every touched source
(`cl_h9join.c` with `cl_avatar.c`'s); both new patches and engine-h9-motd.patch round-trip on scratch
copies with the repos' line-ending rules; all 52 patches reverse-check clean.

### 2026-11-03 -- engine-h9-deltacounter.patch (new), engine-h9-overflowlog.patch (new)

The user approved both, from the overflow list in docs\PLAYER_LIMIT_128.txt.

**deltacounter.** Each frame built for a real client takes `frame_ents.num_entities` places from
`svs.next_client_entities`, an int that only grows; the frame keeps its first place, and its
entities sit at (first + i) modulo the ring's size. At 0x7FFFFFFE `SV_WriteEntitiesToClient`
resets it and sends every client `SV_FinalMessage("Server will restart due delta is outdated",
reconnect)`. Its comment counts on more than a week; at 64 players, cl_updaterate 30 and about
250 entities in view it is 480,000 places a second, the wrap in about 75 minutes (bots get no
frames, so no bot test reaches it). `SV_H9RebaseClientEntities` runs when the counter reaches
0x40000000: shift = ((next - ring) / ring) * ring, a multiple of the ring and at most next - ring.
Every client's SV_UPDATE_BACKUP frames lose the shift, or go to 0 when they start at or below it,
and the counter loses it too. A frame still in the ring (first > next - ring) starts above the
shift, keeps its ring slot (the shift is a multiple of the ring) and passes
`SV_EmitPacketEntities`' rolled-off test exactly as before; a frame already rolled off fails it as
before, at its new value or at 0. Nothing else changes: no type, no protocol, no other file; the
old wrap check stays, unreachable, as a backstop. `Con_Reportf` (-dev 2) names each rebase.

**overflowlog.** The user has no copy of the overflow text, so the next one is kept by itself.
`H9_OverflowLog` (new `common/h9_overflowlog.c`) matches a message's text, in any case, against
"overflow" (every buffer's overflow, "overflowed", "would overflow"), "too long (more than",
"limit exceeded", "no free edicts", "not enough free beams", "bytes, it written", "delta is
outdated", "out of date entities", "too many entities in visible packet list", "illegible server
message" and "svc_bad", and appends a match to `<gamefolder>/logs/h9_overflow.log` relative to the
root FS_Init makes current: the date and time, server (dedicated), listen or client, the map
(`GameState->levelName` while a server runs here, else the client's `clgame.mapname`) and the text
without colour codes. The same message, its first 24 characters (one overflow for many players
is one message), is written at most once in 10 seconds, with the count held back since its last
line; 2000 lines a run at most. C stdio, opened and closed for each line, so the line is on disk
before a crash and no engine allocator is used (any thread may print); `logs` is made with
`_mkdir`/`mkdir`. Nothing is written before gameinfo.txt is read (`FI`, `GI` and the game folder
set). sys_con.c: `Con_Printfv` passes every printed message; `Con_H9Unprinted` takes the ones the
console does not print: `Con_DPrintf` below -dev 1 and `Con_Reportf` below -dev 2 format a
message only when its format string already matches (no cost to the rest), and `Con_Printf`
without a console formats every message, as printing would have, so a Host_Error ("%s: %s") is
caught.

Made: deltacounter from a snapshot of `sv_frame.c` as the whole chain leaves it (#30 and #41 in
it): the snapshot's blob as the file's entry in a temporary index read from HEAD, then `git diff`
of the working tree. overflowlog: both paths added to a temporary index read from HEAD (no other
patch touches `sys_con.c`, so HEAD is its snapshot), `git diff --cached HEAD`. Verified: both
reverse-check on the live tree; both round-trip on scratch copies with the files' `eol=lf`
(forward gives the live files byte for byte, reverse gives the snapshots and removes the new
file); all 54 patches in xash.bat's list reverse-check clean; `cl /Zs` with the configured
compiler, flags and defines (`build\c4che\engine_cache.py`, plus the client's `XASH_SDL=2`) on
`sv_frame.c`, `sys_con.c` and `h9_overflowlog.c`: no errors, no warnings. Not built here: they go
into the link agent's next `xash.bat engine` run. xash.bat's xash.dll description line is now
8,158 of cmd's 8,191 characters.

### 2026-11-03 -- engine-h9-vguitype.patch (new)

The user: the VGUI disappears when a say key (Y, or U for say_team) is pressed, and appears again when
the typing is done.

Cause. `XashPaint` (`3rdparty/freevgui/platform/xash3d-fwgs/app.cpp`) returns at once unless the engine's
`IsInGame()` is true, and `VGUI_IsInGame` (`client/vgui/vgui_draw.c`) answered `cls.state == ca_active &&
cls.key_dest == key_game`. The chat line sets `cls.key_dest` to `key_message`, so while it was open nothing
the VGUI draws was painted: TS's scoreboard and menus and all of H9's panels (the match bar, banners and
menus). The client's own HUD elements, which `V_PostRender` draws before `VGui_Paint` whatever the key
destination, stayed on screen. `XashPaint` is the only user of `IsInGame` in the VGUI library.

Fix. `key_message` counts as in the game too, as on GoldSrc, the same call engine-h9-chatmouse.patch makes
for the mouse. The console (`key_console`) and the menu (`key_menu`) still hide the VGUI.

Made: the file was clean in git and no other patch touches it, so `git diff` of the working tree for
`engine/client/vgui/vgui_draw.c`. Verified: it reverse-checks on the live tree; forward on a scratch copy of
the HEAD blob gives the live file (git apply outside the repo wrote CRLF into the scratch copy; with the CRs
ignored the files are the same) and reverse gives the blob back; all 55 patches in xash.bat's list
reverse-check clean. xash.bat's xash.dll description line holds only the patch's name, and is now 8,184 of
cmd's 8,191 characters. The browser build takes the change with its next rebuild (same file).

### 2026-11-04 -- engine-h9-serverauth.patch (new), mainui-h9-browser.patch (regenerated)

The user: the server browser shows no green or red chain for whether a server is authenticated (the chain the
scoreboard draws for a linked player, and the main menu's link button).

Design (docs\H9_PRESENCE.txt section 4d). h9web judges each game server that reports to it (modules/presence/preset.js):
ok while it runs H9's official preset, rp on a roleplay map (authenticated, nothing ranked), mod when it runs anything
beside the preset, opt when its operator set h9_authenticated 0. It publishes the verdicts at
/api/presence/servers/auth, and the engine reads that: the browser asks the site and never the servers, because a
server cannot say that it is authenticated.

Engine (engine-h9-serverauth.patch). The new `client/cl_h9auth.c`: the restricted command `h9_servers` fetches the list
(`HTTP_GetToMemoryEx`, as cl_avatar.c fetches pictures: havoc9.org over https with its certificate checked and to a public
address only; `cl_h9_site` names a local test site) at most once in 20 seconds, and puts what it read in `_h9srv` and
`_h9srv_gen`. An answer that is not "H9SRV 1" first is not read, and a site that does not answer leaves the list as it was
(one console line). `CL_H9Srv_Init` is called from `CL_Init`, between `S_Init` and `Voice_Init`, and declared in client.h
after `CL_Escape_f`: both places are away from every other patch's hunks. The browser build compiles none of it
(`XASH_EMSCRIPTEN`), so its menu has no `_h9srv_gen` and draws no chain.

Menu (mainui-h9-browser.patch, regenerated). `ServerBrowser.cpp`: a `COLUMN_CHAIN` after the favourite column, drawn with
`CELL_IMAGE_TRANS` (the pictures have an alpha channel), `gfx/vgui/h9_link.tga` for ok and rp, `gfx/vgui/h9_unlink.tga`
for the rest; `H9ChainOf` reads the two cvars (0 for nothing known: before the list was read, on an engine without it, on
the LAN list). A roleplay server's name is shown with `[UNRANKED: roleplay]` after it (`server_t::title`; sorting still
uses `name`). `RefreshList` runs `h9_servers` (the browser refreshes every 20 seconds and on the Refresh button), and
`Draw` makes the rows' chains again when `_h9srv_gen` changes. The change is folded into the browser patch because it
edits the same enum, cell functions and column setup: a separate patch made the browser patch fail its reverse check
(its context lines had changed), which `xash.bat` would have stopped on at the next engine build. The same trap
moved the engine edits away from the avatars patch's lines in cl_main.c and client.h (first tried right after
`CL_Avatar_Init` and `CL_Avatar_Account`).

Made: the browser patch is `git diff` of the working ServerBrowser.cpp against the mainui commit origin/master records
(bb47191c), as xash.bat's workdiffsub makes it (the file with the old patch reversed was the upstream blob, CRs ignored);
engine-h9-serverauth.patch is a diff of snapshots of cl_main.c and client.h taken before the edit, plus cl_h9auth.c as a
new file. Verified: both new or changed patches reverse-check on the live trees and apply forward onto scratch copies of
the pre-edit files (the browser patch onto the upstream blob, giving the working file); all 56 patches in xash.bat's list
reverse-check clean; `cl /Zs` with the build's flags is clean on cl_h9auth.c, cl_main.c and ServerBrowser.cpp. xash.bat:
the call after vguitype, the printed list, the xash.dll description (the new name only, and three phrases elsewhere in
it are a few words shorter to make room: 8,188 of cmd's 8,191 characters) and menu.dll's.

Built 2026-11-04 (`xash.bat engine`, then `build.bat h9_presence`, whose export carried it to the git copy): every patch
"in place", no error; the one compiler warning (cl_sprite.c C5287) is not from this change. xash.dll 1A9ED0D91860 and
menu.dll 9FE1D638009B hold `h9_servers`, `H9 SERVERS`, `_h9srv_gen` and the chain's picture names. xash.dll.patch and
menu.dll.patch keep their notes as earlier builds wrote them (dllmerge) and carry the new diff, which is where the change is.

### 2026-11-04 -- engine-h9-avatars.patch and engine-h9-serverauth.patch (regenerated): the web client gets the scoreboard's pictures and the server browser's chain; WEB_PARITY.json and tools\webclient-sync.mjs (new)

Why. The browser build compiles out the engine's HTTP, so cl_avatar.c (pictures) and cl_h9auth.c (the chain's list) did
nothing there: the web scoreboard kept its silhouette and the web server browser drew no chain, though the web client's
menu has the same chain column and the same `client.dll`. Nothing made a native-only feature need a web half, and nothing
rebuilt the browser engine when the patches changed (export.bat only repackages what is already in webclient-bin).

Pictures (engine-h9-avatars.patch, `client/cl_avatar.c`, a new file, so only its chunk of the patch changed; the three other
chunks, cl_main.c, client.h and cl_parse.c, are byte for byte as they were). `H9Av_Show` moved out of the native-only block so
both builds share it. The browser branch: `H9Av_PageWant` (an `EM_JS` into `Module.avatar.want( slot, account, version )`),
`H9Av_WebPath` (`downloads/h9avatars/web_<account>_<version>.png`), `H9Av_WebShow` (`FS_LoadFile`, then `H9Av_Show`: the same
PNG check, 64 x 64 at most and 32 KB, and the same `HUD_H9Avatar`), and the restricted command
`h9_avatar_page <slot> <account> <version>`, which shows the picture in a slot that still waits for exactly that account and
version. `CL_Avatar_Message` in the browser build: the silhouette for account 0, a picture the page wrote earlier at once,
else the silhouette and a request to the page. The page (`havoc9.org\webclient\client.js`, `avatarFeed`) fetches
`/api/presence/avatar/<account>/<version>.png` from its own site, writes the file into the engine's memory disk and runs
`h9_avatar_page` for each slot waiting for it; a picture that cannot be fetched is tried again after 15 s, 60 s and 5 minutes.
`h9_profile` stays native-only.

Chain (engine-h9-serverauth.patch). The engine side is unchanged in code: one comment in `client/cl_h9auth.c` now says the
browser build's list comes from the page. The page (`chainFeed`) reads `/api/presence/servers/auth` when the engine is up and
every 30 seconds, sets `_h9srv` and `_h9srv_gen` with `set` (cvars the browser build does not register, so they are plain
user cvars), and defines `h9_servers` as an alias for `wait`, which the menu runs on every refresh. The list is cut at a whole
entry before a command line could reach 2047 characters, which the engine drops.

Parity (new). `xash3d-h9-patches\WEB_PARITY.json` says, for each H9 patch that compiles code out of the browser build
(`#if !XASH_EMSCRIPTEN`), what the web client does in its place: avatars (bridged), serverauth (page-fed), motd (bridged) and
four native-only with their reasons (idproof, joinscreen, link, listen). `tools\webclient-sync.mjs` stops at a patch with such
code and no entry, at an engine call into a `Module.*` object that neither the page's engine config nor a patch provides, and at
an entry whose marker is not in client.js. The same program rebuilds the browser engine and client library when the engine
tree, the patch chain (xash.bat's `call :patch` list and each patch's text), the client library's sources or the build scripts
changed, lays out the stage, copies webclient-bin, the stage, the web tools and the page into the git mirror, publishes the
page to this PC's local site, runs `tools\webclient-test\smoke.mjs` in a headless browser, and records the inputs in
`webclient-bin\INPUTS.json`. CLAUDE.md says to finish every engine, client-library or page change with it.

Made: the new `cl_avatar.c` chunk and the `cl_h9auth.c` chunk were cut into their patches from the working files
(`regen_new_file`: nothing else in either patch moved). Verified: all 56 patches in xash.bat's list reverse-check clean.

### 2026-11-04 -- engine-h9-webwarm.patch (new): the browser build fetches what a join reads before it reads it

Why. In the browser build a game file comes over the network the first time the engine reads it, and the engine waits for
it where it stands. `CL_PrecacheResources` reads everything the server listed in one call ("inside one frame",
cl_h9join.c), so a join held the page still for as long as every file took together: measured in a real join through the
local site's relay (tools\webclient-test\perf.mjs with join.mjs), 499 files and 269 MB (three music tracks of 52, 26 and
20 MB, about thirty 2 to 3 MB player models, the map, hundreds of sounds), one task of 46 seconds with no frame, no sound
mixed (a 46 second hole in the audio callback) and no key read. That is the freeze and "crash" a player saw on joining.

Engine. The new `client/cl_h9warm.c` (browser build only; the native build has `CL_H9Warm_Ready` return true). The two callers
of `CL_PrecacheResources`, `CL_ParseResourceList` (cl_parse.c) and `CL_ProcessFile` (cl_main.c), ask `CL_H9Warm_Ready()`
first. In the browser build it builds the list of resources the precache will read and nothing has loaded (models, sounds
with their sound/, generic files and event scripts; not a model's `*N` parts of the world), hands it to the page
(`Module.warm.want`, an `EM_JS`) and returns false: the callers go on without precaching, as they do for a download still
to come. The panel this file registers (the H9UI registry, first use, so no CL_Init hunk) runs each frame: it puts the page's
counts on the join screen's own cvars (`_h9join_stage` Downloading, `_h9join_file` "game files n of N MB", `_h9join_fileprog`,
`scr_loading` between 15 and 50), and when the page says it is done it makes the call the callers would have made
(`CL_PrecacheResources`, `CL_RegisterResources`, the fragments). A page without Module.warm answers -1 and nothing waits; a
page that takes more than 900 seconds is cancelled and the join reads the rest itself; a disconnect or a new server
(the panel's Reset) cancels it. The call sites are single lines away from every other patch's hunks: nothing in the chain
needed regenerating.

Page. `havoc9.org\webclient\client.js` `warmFeed`: want(list) looks each name up in the manifest (the game's folder, then
valve), skips files already read or already fetched, and fetches the rest six at a time into the preload's memory
(`warm`), which `lazyFile` reads before it asks the network; state, done, total, kb and cancel are what the engine polls.

Also (not a patch). `havoc9.org\webclient\settings.json` runs `gl_vbo 1` at start: the renderer's batched world drawing, off
by default and marked "known to be glitchy". Measured in the same join, ingame, 1280 x 800: 602 draw calls and 11,868 GL calls
a frame against 2,108 and 31,824; the page's main thread 58% busy against 96%, the browser's GPU process 52% against 88%;
frame time p95 16.8 ms against 33.3 ms; audio gaps over two buffers 1 against 10 in 30 seconds. `gl_vbo 0` in the console
turns it off.

Made: `make_webwarm_patch.py` from snapshots of cl_main.c, client.h and cl_parse.c taken before the three one-line edits, and
the new file. xash.bat: the call after serverauth, the printed list and the xash.dll description (the name in, two asides
out: 8,141 of cmd's 8,191 characters). Verified: all 57 patches reverse-check clean.

### 2026-11-04 -- engine-h9-webwarm.patch (no change): the server's 60 second limit on a join, found with a throttled first visit

A first visit has nothing cached, so the whole 300 MB of a join comes over the page's connection, and the Xash server has a
limit of its own for that: `sv_connect_timeout` (60 seconds; `SV_CheckTimeouts` in server/sv_main.c). A client that has not
spawned that long after it connected is dropped as timed out, however many packets it still sends: the rule looks at when the
connection began, which only the connect itself and a map change move, not at what arrives. With `sv_connect_timeout_ban` 1
(the default) its address is then banned with `addip` for `sv_connect_timeout_ban_time` (2) minutes, and a browser player's
address is the relay's: that bans every browser player of the server at once.

Seen with the page's fetch held to 3 MB/s (CDP network emulation: tools/webclient-test/perf.mjs --fresh --script prefetch.mjs with
H9_THROTTLE_MBPS=3, an empty cache): the join
was cancelled about 60 seconds in, the page's warm state flipping to done with 48 of 429 files fetched (the engine cancels the
fetch when the client is dropped), with no line in the engine log. An earlier run on a busy machine ended the same way: no spawn,
and the relay closed the idle socket 180 seconds later. The old synchronous join had the same limit (46 seconds measured on a
fast local link; a slower link failed), so this is not new; the pre-fetch only made it visible.

Not an engine change. H9's overlay ts/server.cfg (H9XASH's and the git copy's too) now sets `sv_connect_timeout 600` and
`sv_connect_timeout_ban 0`, and havoc9.org/webclient/DEPLOY.txt section 7, docs/H9WEB_ADMIN.txt and docs/HAVOC9_SETUP.txt list them
with the other settings a server for browser players needs (sv_connect_max_per_ip 0, sv_query_rate_limit 30, sv_timeout 120). With
them the same throttled join ran past 230 seconds without being cancelled. A server without them (the VPS until its config is
deployed) still drops a browser join at 60 seconds. Open: the music tracks are about a third of the 300 MB; a browser build that
did not precache sound/music would join in a fraction of the time (an engine change, not made).

### 2026-11-04 -- engine-h9-joinscreen.patch and mainui-h9-joinscreen.patch (regenerated): the join screen's downloads together

Native client. The join screen showed the file coming (its name, n of N, KB of KB, its own bar) and an overall bar, and the overall
bar stood at 15 for the whole of the downloads: it went by `cls.dl.nTotalToTransfer - cls.dl.nRemainingToTransfer`, and
`nRemainingToTransfer` is set once, to the total, in `CL_StartResourceDownloading` (cl_parse.c) and nothing lowers it (the fields are
GoldSrc's download statistics, which this port keeps and never fills). Now `client/cl_h9join.c` counts the bytes itself: the files that
have finished (each one's size, when the next name appears) and the one coming, against `cls.dl.nTotalToTransfer` (the resource list's
estimate), and the speed over the last seconds. The overall bar goes from 15 to 50 by those bytes (by the files, with the one coming,
while the total is not known). A new read-only cvar `_h9join_total` carries the line the web client's download box has:
"4.0 MB of 27 MB   23 MB to go   about 12 s left", with "so far" alone when the total is not known, empty without a download.
`menus/ConnectionProgress.cpp` shows it in a line of its own under the overall bar; the file line and its bar moved down by 6 and 4
pixels of the menu's 1024 x 768.

Checked: the totals code, as it stands in cl_h9join.c, built with stand-ins for the engine's types and run through simulated joins (three
files at 2 MB/s with a known total, with an unknown one, and with one file of unknown size): the line, the time left and the bar come
out as intended. Not checked in a live download: the servers here have no file this client lacks, so the screen itself has not been
seen with a download on it. The browser build compiles the same code and has nothing to show it on (its own box is client.js's
downloadBox; WEB_PARITY.json keeps the patch native-only). Made: regen_new_file.py for cl_h9join.c, and git's own diff of
ConnectionProgress.cpp for the menu patch (no other patch changes that file). Verified: all 57 patches reverse-check clean.

### 2026-11-04 -- engine-h9-websound.patch (regenerated, a second file): the browser's audio device buffer

The browser build opened its audio device with the 1024 samples (21 ms) the Windows build uses. The page plays that callback through
SDL's ScriptProcessorNode, which runs on the page's main thread, the thread every game frame runs on: a callback waits for the frame in
progress, and one that comes more than a buffer late leaves nothing to play (a click or a hole, and on the player's PC a repeating
chunk). A held key made it loud: the scoreboard open (TAB) or walking (W) makes frames longer, and on a slower PC they no longer fit.
Measured with tools/webclient-test/perf.mjs --script holdkey.mjs, the same 8 seconds each, the page's CPU slowed three times (CDP): an
underrun is a buffer that plays later than the one before it ended. With 1024 samples (21 ms): the first window, idle, 56 underruns
and 0.85 s of silence; TAB held 114 and 4.6 s; W held 77 and 1.7 s; TAB held again 112 and 2.3 s. With 2048 samples (43 ms): 6 and
0.16 s; TAB 29 and 1.5 s (the first draw of the scoreboard still costs a hole of about 180 ms); W 11 and 0.35 s; TAB again 6 and
0.17 s. At full speed on the author's PC the old buffer had 0 to 7 buffers late by more than one buffer with a key held, so the
trouble is a PC whose frames leave little room: the audio callback is delivered by the same thread, and a frame in progress holds it.
The remaining fix, not made, is the audio on a thread of its own (an AudioWorklet fed from the mixer), which needs a new audio
backend for the browser build.

`engine/platform/sdl2/s_sdl2.c`: `.samples = 2048` under `XASH_EMSCRIPTEN`, 1024 elsewhere; a second chunk of this patch (no other patch
changes the file). Verified: all 57 patches reverse-check clean.

### 2026-11-04 -- engine-h9-websound.patch (regenerated, three files): the browser's sound on a thread of its own

The 2048-sample buffer above helped a slower PC and did not cure it: SDL plays the mixer through a ScriptProcessorNode, a callback on the
page's main thread, so a frame in progress, or the browser's own work for a held key, still held the callback and left a hole in the
sound. The browser build now gives the mixer's output to the page, which plays it from an AudioWorklet (havoc9.org/webclient/h9audio.js),
a thread of its own. SDL's device stays the fallback where the page has no `Module.audio`, or the browser no AudioWorklet or secure context.

`engine/platform/sdl2/s_sdl2.c`, under `XASH_EMSCRIPTEN`:
  * `SNDDMA_Init` asks the page (`H9A_PageInit` -> `Module.audio.init`). When it answers, the backend is "page audio thread": a ring of
    65536 stereo frames for the mixer, and nothing opened in SDL.
  * `SNDDMA_BeginPainting` gives the mixer the audio clock as it stands: every frame the audio thread has played, not reduced to the ring.
    `S_GetSoundtime` only unwraps a position that comes back round and counts the wraps it sees, so a clock that jumped by more than a ring
    between two readings (the worklet begins seconds after the engine; a frame stalls for longer than the 1.5 s ring) would leave the mixer's
    time a whole ring behind the worklet's for good, and every push would be late. The first build had the clock reduced to the ring: the
    worklet played silence and its own counters said so (pushed 0.00 s), which is how it was found.
  * `SNDDMA_Submit` sends the frames painted since the last time, with their place in the stream, as floats (`H9A_PagePush` ->
    `Module.audio.push(from, pcm)`); `SNDDMA_H9Flush` (called by `S_ClearBuffer`) drops what the worklet holds.
  * Past 2^30 frames (about 6.7 hours of sound) the clock starts over (`H9A_PageRebase`), as `S_GetSoundtime`'s own 32 bit guard does.
`engine/client/sound/s_main.c`: `S_ClearBuffer` calls `SNDDMA_H9Flush`. `engine/platform/platform.h`: its declaration. The page:
`audioFeed` in havoc9.org/webclient/client.js builds `Module.audio` (init, position, push, flush, activate, close, rebase, stats), and
h9audio.js is the worklet, which keeps no clock of its own: its place in the stream is the audio clock (`currentFrame`) less a base.

Measured with tools/webclient-test/perf.mjs --script holdkey.mjs (the page's CPU slowed three times, a music track playing, 5 seconds
each): idle, TAB held and W held each had 0 frames starved and 5.0 seconds sent; the scoreboard held showed 10 long tasks (615 ms) and a
frame of 117 ms, and the sound did not notice. Verified: all 57 patches reverse-check clean.


### 2026-11-05 -- engine-h9-presence.patch (regenerated): the card names Assault

The Discord card's details line knows the Assault mode (ts_assault.amxx, docs/GAME_MODES.txt). In `H9P_Mode` in `cl_presence.c` the server's
`tsm_pres_mode` key "assault" and the map prefix `h9_as_` both name it "Assault" (a row in each table), and `H9P_Activity` runs the Uplink's
progress branch for it too: `tsm_pres_prog` for Assault is "1/2/5" (side 1's points, side 2's, all of them), and the line reads
"Assault - points: MSR 2, Insurgents 1 of 5" where Capture the Uplink's reads "zones". A client without this engine shows an Assault server as
"Deathmatch" on its card (an unknown key with no known prefix falls through to it); the website and the in-game browser name it from the
server's own report and need no new engine (h9_presence.sma mode_name and detail_line, h9web modules/presence/modes.js).

The same entry also names TS's own capture game by the map's name, after the roleplay check: `ctb_` at the start of a name or `_ctb_` anywhere in it
reads "Capture the Briefcase", `ctf_` or `_ctf_` "Capture the Flag" (the `h9_ctb_` and `h9_ctf_` rows of the prefix table stay). TS has one such
game, its flag is the briefcase (reTS `dlls/ts_briefcase.h`: CTSBriefcase, "the CTF base + flag registry"; the stock `ctb_deadheat` is two
`ts_briefcase` entities and a worldspawn `gamemode 2`), so the two names play alike and only the card's word differs; ts_matchmode's name rule
(`capture_map`), h9_presence.sma's mirror and h9web's modes.js say the same.

Only the `cl_presence.c` new-file section changed (604 -> 616 lines, blob `b2879013`), rebuilt from the live file; the `cl_main.c`, `client.h`,
`host.c`, `game.rc` and `havoc9.ico` sections are untouched. No other patch touches `cl_presence.c`. Nothing was added to the chain, so the
`xash.dll` description line in `xash.bat` is as long as it was. Verified: `git apply --reverse --check` of the whole patch in place against the
live tree.

### 2026-11-05 -- engine-h9-presence.patch, engine-h9-serverinfo.patch and mainui-h9-browser.patch (regenerated): the server browser's Mode column, and the card names Capture the Flag

The in-game server browser (the game's and the web client's, which share mainui) has a **Mode** column between Name and Map: Team Elimination, Siege,
Capture the Uplink, Wave Survival, Mech Warrior, Assault, Capture the Flag, Capture the Briefcase, Roleplay, Match Mode, Deathmatch, Team Deathmatch.
It is named by the list the Discord card already used, now one function for both.

**engine-h9-presence.patch** (`cl_presence.c`, `client.h`, `cl_main.c`). The two tables and the naming rule left `H9P_Mode`, which is inside the
Windows-only block, for `CL_H9_ModeName( map, key, siege )` outside it, so the browser build has them too: NULL when nothing names the mode, which
`H9P_Mode` turns into "Deathmatch" as before. New beside it: `h9p_keys` has the key `ctf` ("Capture the Flag"; ts_ctf.amxx publishes
`tsm_pres_mode` "ctf"), `CL_H9_KeyFromDescription` (a game description to a mode key, the rule of `keyFromDescription()` in h9web's modes.js),
`CL_H9_ServerMode( map, desc, teamplay )` (the browser's word: the card's names, else Team Deathmatch for a teamplay server, else Deathmatch) and
`CL_H9_StampServerMode( info, size )`, which sets the `mode` key of an Xash server's info reply from its `map`, `desc` and `team` keys when the
string has room (no warning when it has not: the browser then shows no mode for that server). `CL_ParseStatusMessage` calls it right after
`CL_Presence_ServerReply`, one more `+` line in that hunk; `client.h` gets the three prototypes in its presence section. `H9P_Activity` runs the Uplink/Assault progress branch
for `ctf` as well: `tsm_pres_prog` is "1/2/3" (side 1's captures, side 2's, the captures that win) and the line reads "Capture the Flag - captures:
MSR 2, Insurgents 1 (first to 3)". The `cl_presence.c` new-file section was rebuilt from the live file (616 -> 721 lines, blob `904e97b7`); the other sections
changed only by the lines named here (`cl_main.c` hunk numbers +1 after it, `client.h` +3 lines).

**engine-h9-serverinfo.patch** (`sv_client.c`, `cl_main.c`). `SV_Info` adds `desc`, the game DLL's `pfnGetGameDescription()` cut to 31 characters, before the
hostname (which is cut to what is left, as before); an H9 server's description is its mode ("Capture the Uplink", "Siege 2/5"). In
`CL_ParseGoldSrcStatusMessage` the game description that was read and dropped is kept in `desc` in both reply formats, and `mode` is set from it and the map
(`CL_H9_ServerMode`) before the hostname. The patch was rebuilt from scratch copies of the two files in the state the chain has them at #45 (presence's new
line in), old patch reversed, new edits in. **Needs #16 now** for `CL_H9_ServerMode`; it applies after it in `xash.bat`'s list, as before.

**mainui-h9-browser.patch** (`menus/ServerBrowser.cpp`). `COLUMN_MODE` between the name and the map, `server_t::mode` read from the info's `mode`, `ModeCmp` and the sort case, `GetCellText`, and `info[576]` in
place of 512 so the key survives a reply that filled its 512. The columns were re-laid so the hostname is cut off less: the chain icon first and the
name beside it at the left edge, the lock, account and favourite icons after the name; the icon columns 20 units wide (a 16 unit icon), the chain's 28
(a gap before the name), in place of 32 each, the players column 160 and the ping 90 in place of 180 and 120, and the rest shared 0.48 name, 0.22 mode, 0.22 map. Regenerated with `git diff HEAD`
in the mainui repo as before.

Nothing was added to the chain, so the `xash.dll` description line in `xash.bat` is as long as it was (8,141 characters on the line, 8,188 as cmd counts
them) and no description text there was changed (it still names #45's bots and auth flag; the changes of this entry are described here and in
`docs\RICH_PRESENCE.txt`). Verified: all 57 patches of `xash.bat`'s list reverse-check in place against the live tree (`git apply --reverse --check`);
`xash.bat engine` built clean (the one warning, `cl_sprite.c`, is upstream's); the browser build follows with `node tools\webclient-sync.mjs`.
A web client player needs nothing: the page loads the engine it was built with, which carries all of it. An older client has no Mode column and shows
nothing wrong; an older server sends no `desc` and its row is named by its map alone.

### 2026-11-05 -- engine-h9-presence.patch, engine-h9-serverinfo.patch, mainui-h9-joinscreen.patch (regenerated) and mainui-h9-browser.patch: the release gate

A server of H9 refuses a player whose game is another release than its own, and says where to get the right one; the game's box then offers to open the
page. docs\H9_RELEASE.txt has the whole of it. A release is the first word of `ts\h9_release.txt` (laid from `xash3d-h9-patches\overlay\ts\`).

**engine-h9-serverinfo.patch.** A new file, `engine/common/h9_release.c` (`H9_Release()`: the first word of `h9_release.txt` in the game folder, read once, 31
characters at most), and in `sv_client.c` the function `SV_H9ReleaseRefusal` above `SV_ConnectClient` and a block in it right after the userinfo is copied
(before the password): with `h9_require_release` (a cvar of h9_presence's, as `h9_require_account` is) above 0 and the joiner not the local client, the
server's release (`h9_plugin_release`, the plugins', else the folder's) is compared with the userinfo key `_h9rel`; a joiner of H9's game (any key of the
form `_h9...` or `h9_...`) with another release, or none, is refused through `SV_RejectConnection` with "Your HAVOC 9 is out of date (...): update it from
https://havoc9.org/downloads/" (his release older, or none) or "This server runs an older HAVOC 9 (...)" (his newer); at 2 every joiner must match. A
server that knows no release asks for none. The patch was rebuilt from scratch copies of the files in the state the chain has them at #45, as before.

**engine-h9-presence.patch.** `CL_Presence_Init` registers the read-only cvar `_h9rel` (userinfo, privileged) and sets it from `H9_Release()`, so every join
carries the release. The browser build gets the same lines (the web client reads the file from its stage). The key is also written into the userinfo with
`Info_SetValueForKey( CL_Userinfo(), ... )`, as `_h9travel` and `h9_clientid` are: `Cvar_DirectFullSet` changes the cvar and never the userinfo (only the ordinary
setters, through `Cvar_UpdateInfo`, do), so without that line the cvar read "2026.11.05" in the console while the connect packet carried no `_h9rel`, and a server
holding its players to one release refused every H9 client as out of date, the right release included. Found by tools\webclient-test\gate.mjs, which joins a
server whose release it sets over rcon; `setinfo` in the console lists the keys a client sends.

**mainui-h9-joinscreen.patch.** `CMenuConnectionProgress::End()`: a refusal whose text names `havoc9.org/downloads` (this gate's, and the 128-slot server's
"needs a newer H9XASH") is shown in a two-button box, OPEN HAVOC9.ORG (`EngFuncs::ShellExecute`, on a click) and Close, in place of `UI_ShowMessageBox`'s OK.
Only the `menus/ConnectionProgress.cpp` section of the patch was replaced (`git diff HEAD`); the `BaseMenu.cpp` section is as it was.

**mainui-h9-browser.patch.** The chain column is 28 units wide (a gap before the name), the other icon columns 20.

Nothing was added to the chain (the `xash.dll` description line in `xash.bat` is as long as it was); the descriptions there still name #45's bots and auth flag,
and this entry is the record. h9_presence.sma registers `h9_require_release` (1) and `h9_plugin_release` (the release build.bat writes into
`include\h9_release.inc` from the overlay's h9_release.txt) and logs a package mismatch.

### 2026-11-09 -- engine-h9-intro.patch (new): the intro video before the main menu, ts_intro, any key skips it

`media/StartupVids.txt` names `media/ts_intro.avi` (the original Specialists intro, cut to 21 s, MJPEG with PCM sound); the engine plays the startup videos before
the main menu shows, and stock FWGS skips one only with escape and has no switch. `cl_video.c`: the archived cvar `ts_intro` (1), registered in
`SCR_InitCinematic` (before `config.cfg` runs, so a saved 0 holds), and `SCR_NextMovie` steps past an entry whose name holds `ts_intro.` while it is 0, so with 0
the list ends at once and the menu shows; `SCR_SkipStartupVideo` (declared in `client.h`): while a startup video plays (a flag `SCR_NextMovie` sets when it starts one from the list, so not one the `movie`
command plays; it prints "ts_intro: startup video skipped") it goes to the next one. `in_keys.c`, `Key_Event`: right after `Key_Rotate`, a key or mouse button going down (not the console key) calls it and
returns. `SCR_PlayCinematic` sets the video's volume (`AVI_VOLUME`, 0 to 255) from the archived cvar `ts_intro_vol` (1) when the file is the intro: 1 is the video as recorded, 0 silent, 0.5 half, a number above 1 is 1. `s_stream.c`, `S_StartBackgroundTrack`: the track's source (the key destination it plays under) is the menu's while a cinematic plays. userconfig.cfg
starts the menu music (`exec menu_music_resolved.cfg`) a few frames after the intro starts; the key destination then is the movie's (key_game), so the track
was recorded as game music, stayed paused behind `snd.streaming` while the video played and, once the menu showed, was paused for good by the rule that a game
track does not play in the menu: no menu music after the intro. Now it waits behind the movie's sound and plays when the menu shows. Made from before and
after copies of the four files in the state the chain has them at #53; five hunks in cl_video.c, one each in client.h, in_keys.c (five lines clear of
engine-h9-motd.patch's hunk there) and s_stream.c (clear of engine-h9-consolemusic.patch's). Added to the end of the chain in `xash.bat` and to the `xash.dll` description line as a bare
name (that line is 8,174 of cmd's 8,191 characters now). The browser build compiles the same code; it has no FFmpeg, so a movie does not start there and the
menu shows as before.

### 2026-11-09 -- engine-h9-glowfix.patch (new): GL_MODULATE bound before the bloom compose

MSR's bloom (`GL_GlowPass`, `ref/gl/gl_fbo.c`) weights each blur tap with its vertex colour and set no texture environment; `R_StudioRestoreRenderer` leaves
`GL_REPLACE` bound (upstream) and the viewmodel is the last studio draw of a first-person frame, so the compose ran under `GL_REPLACE` on desktop GL: the vertex
colour was dropped, the 9 taps of each of four passes were added at full strength, and every additive mesh (the streetlamps of the meridian maps, the glasses of
the RepuTengu models, ceiling lights) was blown out to a flat white rounded square 125 to 150 px wide at 1080p with a soft halo. `gl2_shim` (the browser) ignores
`glTexEnv`, so the browser build always modulated and looked right. `R_Set2DMode` (`gl_draw.c`), the only caller of `GL_BindScreenTarget` and so of the compose,
now binds `GL_MODULATE` first. The line is not in `gl_fbo.c` itself, where `GL_GlowPass` would be the natural place: the bloom is added by `engine.patch`, whose
reverse check fails once a later patch changes a line inside its hunk there. Made from before and after copies of `gl_draw.c`; one hunk, far from
`engine-h9-serverfog.patch`'s. Added to the end of the chain in `xash.bat` and to the `ref_gl.dll` description.

### 2026-11-09 -- engine-h9-presence.patch (changed): a CL_Presence_Frame stub for the dedicated build

`Host_Frame` (`host.c`) calls `CL_Presence_Frame()`, which `cl_presence.c` defines in the client; the dedicated build (`waf configure -d`, `linux/build-linux.sh engine`) has no client code and stopped at the link with `undefined reference to CL_Presence_Frame`. `engine/common/dedicated.c`, where the dedicated build keeps its client stubs, now has an empty `CL_Presence_Frame` after the `CL_Disconnect` stub: one hunk added to this patch, and no other patch touches `dedicated.c`. The file is compiled only into the `-d` build, so `HAVOC 9.exe`, `xash.dll` and the browser engine are unchanged by it.

### 2026-11-11 -- engine-h9-framesize.patch (new): a client's frame is built in 48 KB

`SV_SendClientDatagram` (`sv_frame.c`) wrote a client's whole update for one frame (the time, the clientdata, the entities in view and the unreliable data queued for the client) into a
`MAX_DATAGRAM` buffer of 16,384 bytes, and a frame that passed it was cleared and not sent: "Datagram overflowed for <name>". The first update after a spawn holds every entity in view
whole, about 10 bytes each and a player about 30, so a spawn that sees 1,500 map entities (the open parts of New Byzantium, the plazas of the hive) passed it: the client got no update and no
delta base, and the next update was whole again. The owner's `logs\h9_overflow.log` has it at his spawns on h9_tsrp_newbyzantium (2026-11-08) and h9_tsrp_hive (2026-11-11), and in the
game it is a model that keeps running its legs while the view does not update. The netchan is not what limits it: `SV_GetFragmentSize( FRAGSIZE_UNRELIABLE )` is `NET_MAX_MESSAGE` (about
192 KB), `Netchan_TransmitBits` splits the datagram into packets, and a client puts a split packet back together up to `NET_MAX_FRAGMENT` (65,535 bytes; `XASH_LOW_MEMORY` is 0 on every
H9 build, the browser's too). The buffer is now `SV_H9_FRAME_MAX`, three times `MAX_DATAGRAM` (49,152 bytes: the most a frame holds is 2,048 entities (`MAX_VISIBLE_PACKET`) at 12 bytes,
a player in each of 128 slots at 40 and a full client queue of 16 KB, about 46 KB), with a compile-time check that it stays under `NET_MAX_FRAGMENT`. `cl->datagram` and `sv.datagram`,
the queues the game and the plugins write unreliable messages into, keep their 16 KB. engine-h9-entbudget.patch (spreading the entities new to a client over several updates) stays a
proposal (`xash3d-h9-patches\proposals`). One hunk in `sv_frame.c` at `SV_SendClientDatagram`, made from a copy of the file as the chain leaves it (`git apply --check` clean), built
2026-11-11 15:30. Added to the end of the chain in `xash.bat` and to the `xash.dll` description line (that line is 8,159 of cmd's 8,191 characters now: the line is ONE cmd command, its fifth
argument counts too, and the text about the menu's video lost words for room). A dedicated server on Linux carries it with its next engine build. Not tried in a game: a spawn that sees more
than 16 KB should now get its first update.

### 2026-11-13 -- engine-h9-upscale.patch (new): h9_upscale, AMD FSR 1 in place of the scene's blit

The scene target is carried into the screen target by one `glBlitFramebuffer` (`GL_BlitTarget`, called from `GL_BindScreenTarget` in `ref/gl/gl_fbo.c`).
`GL_BlitTarget` now asks `GL_UpscaleBlit` (new `ref/gl/gl_upscale.c`) first when its source is the scene target and its destination the screen target.
With `h9_upscale` on, FSR 1's EASU, and RCAS when `h9_upscale_sharp` is above 0, draw the frame as GLSL 1.10 shaders through the ARB shader-object pointers
`gl_opengl.c` already loaded and nothing called; a false answer (off, a scene bigger than the screen, anything the upscaler cannot do: one console line, no
retry until `h9_upscale` goes to 0 and 1) leaves the old blit to run. The cvars are defined after `gl_fbo_nearest` (`FCVAR_GLCONFIG`, "0" and "0.84") and
registered after its registration; `R_Shutdown` calls `GL_UpscaleShutdown` after `GL_FreeRenderTargets`. The OpenGL ES and WebGL renderers (`XASH_GLES`)
compile the file to a stand-in that says once that the renderer has no upscaler, and `WEB_PARITY.json` has the entry (native-only).

Why the hook is four inserted lines at the top of `GL_BlitTarget` and not in `GL_BindScreenTarget`, where the blit is called: the bloom's lines there
(`if( tr.targets.glowDrawn )` and `GL_ComposeGlow();` with their three lines of context, 588 to 596 in the file as the chain leaves it) are a hunk of
`engine.patch`, whose reverse check in `xash.bat` fails once a later patch changes a line inside a hunk or cuts one in two. Every other hunk of
`engine.patch` in the three files was kept clear the same way: the two cvar lines go in after line 13 (its hunk is at 41 to 52), the registration after
`gl_fbo_nearest`'s (its hunk is at 1254 to 1263), and the extern lines and prototypes in `gl_local.h` outside its hunks at 200, 358 and 820. Checked with
`git apply --reverse --check` of `engine.patch` and the 46 `engine-h9-*.patch` files of the root chain against the tree with this patch applied: every one
in place, as on the tree without it; the patch applies forward to pristine copies of the three files and gives the work files' bytes, and
`patch --binary -p1 --dry-run` agrees.

Built privately, from a copy of the tree with the engine's own configuration: `ref_gl.dll` for 32-bit Windows with the five `gl_sprite.c` warnings the
unpatched tree gives and none more; `libref_gl.so` for Linux i386 and x86-64 and `ref_gles3compat` with no warning. The file's real source runs on a real
OpenGL context in a test harness (an RTX 3070 driver and Mesa's llvmpipe: 35 life-cycle and fallback checks, 22 picture checks against a CPU reference of
EASU and RCAS) and compiles clean with gcc and clang. Not run in the game. `docs\H9_UPSCALE.txt` has the rest. AMD's licence text is in the header of
`gl_upscale.c` and in `overlay\ref_gl.FSR1-LICENSE.txt` (assemble lays it beside `ref_gl.dll`). Added to the end of the chain in `xash.bat`, to its ENGINE.txt
list and to the `ref_gl.dll` description (the `xash.dll` line is not touched).
