# Deviations from TS 3.0

reTS matches the original's external interface (see CLAUDE.md). This file lists where it does not match
the original: first the additions made on purpose, then the differences the build forces. coverage.py
reports each added cvar or export as EXTRA; this file is why that is expected.

## Deliberate

Each of these leaves the original's behaviour as the default unless it says otherwise.

### mp_teammodels_force (server cvar, default 1)

TS 3.0's `CHalfLifeTeamplay::ClientUserInfoChanged` (ts_i386.so 0xd4d18) compares the client's `model`
key to the team name, and on any mismatch writes a random model from the team's `mp_teammodels` list
(`CTSGameRules::GetPlayerModel`, 0x69a08). Team names never match a model, so any userinfo change (a
name change, a rate change) re-rolls the player's model, and a plugin that sets custom models has to set
it again after each one. Every write goes out to every client.

The value is how much the server forces the model:

- `0`: off. The server never writes the `model` key: not on a userinfo change (neither TS 3.0's
  multiplayer check nor its teamplay re-roll) and not on a team change. A plugin, or the player, owns
  it; keeping players off the other team's models is then the plugin's job. For match plugins that give
  each class its own models, which `mp_teammodels` (three per team, fifteen characters each) cannot list.
- `1`: the original behaviour.
- `2`: a model from the player's own team list is kept, and the pick remembered
  (`CBasePlayer::m_iPlayerModel`). Any other model, the other teams' included, is put back to the team
  model the player already had instead of a new random one. A team change (`ChangePlayerTeam`) still
  stamps a random one from the new team's list, as the original does.

Code: `dlls/game.cpp` (the cvar), `dlls/teamplay_gamerules.cpp` (the teamplay gates and
`ChangePlayerTeam`), `dlls/multiplay_gamerules.cpp` (the multiplayer check, for `0`).
Requested by a server operator running model plugins under teamplay, 2026-10-15.

### PPSh-41 (weapon 39) and caliber 14

The roster has one weapon TS 3.0 does not: `TSW_PPSH41` (39), a submachine gun with a 71-round drum
(`dlls/ts_weapon_info.cpp`, after the original's rows). TS 3.0's ids are 0 to 37. Id 38 is left empty
(`TSW_UNUSED`: an empty row, no weapon) because AMX Mod X's TSX keeps its thrown knife's stats at 38 ("not a
game id"), so no game weapon has that number; `TSW_COUNT` is 41 since the laser rifle (below). The PPSh-41's row is the AK47's taken whole, so
its animation blocks, hold stance and events are the AK47's (its `models/h9/{v,p,w}_ppsh41.mdl` are TS's AK47
models with the gun's meshes swapped), then its own name, models, sound (`h9/ppsh41/fire.wav`), shell, clip,
fire type 9 (SMG), rate, caliber, price and Sparta values (26.35 damage, 85% of the UMP's). The ammo table
gains caliber 14, 7.62 x 25mm (71 rounds a buy, 213 carried). The client has the matching buy-menu row (SMGs),
weapon-bar cell and icon, and fire sound. H9 packages ship the models, sound and icon; a server precaches the
weapon's files with every other weapon's, so it needs them. The server registers a read-only `h9_ppsh41` cvar
(1) (`dlls/game.cpp`): a plugin that finds it knows this game library has the weapon (ts_matchmode gives the
UMP in its place where it does not).

What it breaks, against the original and plugins built for it:

- The original client has no id 39: it has no buy-menu or weapon-bar row for the PPSh-41, and reads an id
  past its table as slot 0. A player on one only gets the PPSh-41 from a plugin or the ground, and CustomWP
  (`SendWeaponParams`) never broadcasts it (it stops at 37). `customweapons` lines for 39 load and save, and
  act on the server.
- `CTSGun::m_items` has two more elements (38 is empty), so the members after it move. reTSX does not read
  them by offset (`ReTS_GetInterface` takes the weapon id, which is range-checked against the weapon count).
- A plugin or module that sizes a table by TS 3.0's 38 weapons must know 39. H9's TSX does: weapon 39 is the
  PPSh-41, the thrown knife stays 38, and kung fu's own stats slot moved from 39 to 40 (AMX Mod X's
  `modules/ts/tsx`, `tsconst.inc`'s TSW_PPSH41).
- The PPSh-41 is not in the random SMG pickup (`weapon_rpg` on a stock map), so none reaches an original
  client that way.

### Laser rifle (weapon 40) and caliber 15 (plasma cells)

A second weapon TS 3.0 does not have: `TSW_LASERRIFLE` (40), an energy weapon (`dlls/ts_weapon_info.cpp`, after the
PPSh-41; `TSW_COUNT` is 41). Its row is the M4A1's taken whole, so its animation blocks, the gunbash (coldcock:
35 damage, anim block entry 15) and its draw, shot and reload sequences are the M4A1's (`models/h9/{v,p,w}_laserrifle.mdl`
are TS's M4A1 models with the gun's meshes swapped), then its own name, models, sound (`h9/laserrifle/fire.wav`),
no shell, a 35-cell clip, 800 rounds a minute, fire modes 7 (full auto, single and burst), caliber 15, price 5200,
weight 40, a built-in scope (right click zooms to 32, then 8, as the Barrett; the scope overlay is blue) and Sparta
values (35 damage, a little over the M4A1's 33). The ammo table gains caliber 15, "Plasma Cell" (35 cells a buy, 140
carried, a pierce decay of 0: a bolt stops at the first thing it meets, and flies at 700 x 40 units a second in
slow motion). The server registers a read-only `h9_laserrifle` cvar (1): ts_matchmode gives the M4A1 in its
place where it does not, and its Officer class carries the laser rifle (`tsm_class7`).

It is an energy weapon, and the client draws none of a bullet's presentation for it (`cl_dll/ev_ts.cpp`,
`cl_dll/ts_bullets.cpp`; only a shot of caliber 15 is affected, no other weapon's): no brass, no gun smoke, no pellet
sprite or white streak in slow motion, no bullet hole or ricochet. A shot draws a green bolt that runs from the muzzle
to where it lands with a trail that holds at full brightness for a moment behind the head and then fades, the head
resting at the end for a moment, at every time scale (`TSPlasma_Bolt`; a round of the client bullet simulation is drawn
the same way as it flies, stepped every frame, with a piece of trail each frame and the last piece laid to the impact),
every ribbon, head and flash kept between a least and a most number of pixels across at its own distance from the eye
(a bolt a few thousand units out is under a pixel wide in units, and a hand across next to the muzzle; the engine draws
an additive triangle with GL fog off, so a map's fog does not thin it), a green flash at the muzzle with a faint green light (a dynamic light,
for every shooter, so that it shows in the dark), a scorch decal (`{smscorch1..3`), a green flash and light and its own
hit sound (`h9/laserrifle/hit1..3.wav`) where it lands, on a wall and on a player alike, and an energy cell sound
over the reload (`h9/laserrifle/reload.wav`, `EV_TSReload`). Sprites: `sprites/laserrifle_{muzzle,trail,bolt,hit}.spr`
and the weapon's picture `sprites/weapons/laserrifle.spr`, drawn by `laserrifle/build/make_sprites.py`. The scope overlay
(`cl_dll/ts_scope.cpp`) tints the view blue and frames it in one flat blue: `sprites/laserscope.spr` is the stock
`quarterscope.spr` with its last palette entry recoloured (`laserrifle/build/make_scope.py`), and the side bars are
drawn from the same sprite's solid corner, so the bars and the mask match exactly.

What it breaks, against the original and plugins built for it:

- The original client has no id 40 (see the PPSh-41): no buy-menu or weapon-bar row, and `CustomWP` never broadcasts
  it. Its caliber 15 is a row the original's ammo table has but leaves empty.
- `CTSGun::m_items` has one more element. A plugin or module that sizes a table by the weapon count must know 40:
  H9's TSX does (weapon 40 is the laser rifle, kung fu's own stats slot moved from 40 to 41; `modules/ts/tsx`,
  `tsconst.inc`'s TSW_LASERRIFLE). The first custom weapon id in TSX is 42 now (it was 41).
- The weapon models are adapted from a CC BY 4.0 Sketchfab model (`laserrifle_ATTRIBUTION.txt`).

### Mech rocket launcher (weapon 41)

A third weapon TS 3.0 does not have: `TSW_MECHROCKET` (41; `TSW_COUNT` is 42), a shoulder-fired rocket launcher for the
Mech class. It is weapon 41 of the one `weapon_tsgun`, as every TS weapon is (there is no `weapon_h9_mechrocket` entity).
Its row (`dlls/ts_weapon_info.cpp`, after the laser rifle) is the M4A1's taken whole, so its animation blocks (idle 0,
reload 1, draw 2, shots 3 and 4, the last-round shot 4) and its draw, shot and reload sequences are the M4A1's;
`models/h9/{v,p,w}_mechrocket.mdl` keep that layout. A server that does not find all three files on disk gives the row
the M4A1's models (`TSMechRocketResolveAssets`, run at the head of both weapon precache lists). The row's own values: the
name "Mech Rocket", no fire sound, no shell, a four-rocket clip (one salvo), 1.5 s from a salvo to the next pull, 3.0 s to
reload (the length of the viewmodel's reload sequence), a salvo of four rockets 0.12 s apart (`iSalvo`, `flStagger`: two
fields at the end of `s_weapon_info`, 0 in every other row), fire modes 6 (burst, the volley and the default, and semi, one rocket a
pull: `TSDefaultFireMode` prefers burst; the generic burst machine, which queues rounds in `m_burstOrPhase`, is skipped for this weapon, and
the client's ammo box shows Volley and Single), fire type 0 (in no weapon restriction category), caliber 8 (the Barrett's 50BMG: all sixteen
calibers are taken, and caliber 13, the M60E3's belt, would make the Mech's M60 reserve the launcher's too; the client's ammo box names the
reserve "Missile" for this weapon), weight 10 (it fits beside the M60E3's 70), price 0 and no
buy menu row, no scope, attachment, right-click stance or gunbash, and the combat feel 6.0 view kick, no spread.

A pull (`CTSGun::MechRocketFire`) launches a salvo: `iSalvo` rockets (what a partial clip holds, if that is fewer),
`flStagger` seconds apart. Every rocket (`MechRocketShot`) spends a round, plays the ordinary fire event (the viewmodel
animation, a large muzzle flash `sprites/h9_rocket_flash.spr` and the gun smoke; `EV_TSFire` draws no brass and fires no
bullet for this weapon) and, on the server, launches `CMechRocket` (`dlls/ts_mechrocket.cpp`) from the eye along the aim
with the launch sound `weapons/rocketfire1.wav` at the player's pitch. The first rocket of a pull goes along the aim, the
others stray up to `h9_mechrocket_spread` degrees from the aim they find when they leave, and sound on `CHAN_AUTO` (the sound
is 0.43 s long; on `CHAN_WEAPON` each would cut the one before it). The rockets after the first are `WeaponIdle`'s
(`MechRocketSalvoStep`): the number still to leave is `m_burstOrPhase`, the slot the burst uses, which the prediction
already carries (clientdata `vuser2.x`), so the client predicts the whole salvo; the next rocket leaves when the primary
timer, set to the stagger, has run out. The salvo asks nothing more of the trigger, ends if the player holsters, dies, runs
out of rounds or goes under water, and `Reload` refuses while it is up. The aim kick (`TS_AddViewRecoil`, `VKickback`) comes
once, after the last rocket, so that the rockets leave along the aim the pull found. The rocket flies straight (MOVETYPE_FLY) at `h9_mechrocket_speed` with a
`TE_BEAMFOLLOW` smoke trail (`sprites/h9_rocket_smoke.spr`) and goes off on the first thing it touches or after 10 s: a
`TSExplosion` of `h9_mechrocket_damage` at the middle, full out to a quarter of `h9_mechrocket_radius` and nothing past the
radius, the explosion sprite (`sprites/h9_rocket_boom.spr`) and TS's own explosion effect and sound. A rocket that reaches
the sky is removed without a blast. The player who fired it is not hurt by it, or pushed, unless `h9_mechrocket_selfdamage`
is 1. TS gives a living player no knockback from a hit (`CBaseMonster::TakeDamage`), so after the blast `MechRocketPush` raises
the velocity of every living player in the radius that the game rules say the thrower may hurt (`FPlayerCanTakeDamage`: friendly
fire off spares a teammate), with a clear line to the blast and on `MOVETYPE_WALK`: `h9_mechrocket_push` units a second along
the ground away from the middle (the way the rocket flew for a player right on it) and `h9_mechrocket_lift` up, both with the
damage's falloff, held to 1000 units a second; a player the blast kills gets TS's own death launch instead. The
kill feed names it "Mech Rocket". A file the art needs that is not on disk is replaced by a stock one (the smoke by
`sprites/steam1.spr`, the explosion by `sprites/zerogxplode.spr`, the rocket by `models/rpgrocket.mdl` and then
`models/shrapnel.mdl`, the flash by the ordinary muzzle sprite, the launch sound by silence); nothing that is not on disk is
precached. The weapon is deleted, not dropped, when its owner dies, drops it or is disarmed (`h9_mechrocket_nodrop`, 1).

The cvars (`dlls/game.cpp`): `h9_mechrocket` (1, read-only in effect: a plugin tells a library with the weapon from one
without), `h9_mechrocket_damage` (200), `_radius` (260), `_speed` (1100), `_rate` (1.5, from a salvo's last rocket to the
next pull), `_clip` (4), `_salvo` (4), `_stagger` (0.12), `_spread` (2.5 degrees), `_reload` (3.0), `_nodrop` (1),
`_selfdamage` (0), `_push` (400) and `_lift` (250). The clip, rate, reload, salvo and stagger are copied into the weapon table
every rules think (`TSMechRocketSyncCvars`, through `TS_ApplyMechRocketSetting`, which clamps them) and, when one
changes, sent to every client as `SrvSett` ids 5 to 9 (clip, rate in ms, reload in ms, salvo, stagger in ms; to a joiner
by `InitHUD`), because the client's prediction reads its own copy of the table: its reload fills the clip to `iClip`, its
salvo counts down `iSalvo` rockets at `flStagger`. The client keeps what it heard and puts it in the row again whenever it
builds the table (`compile_weapons_info`, the first prediction of every map). The server's clip, timers and reserve still
overwrite the prediction every frame.

What it breaks, against the original and plugins built for it: the original client has no id 41 (see the PPSh-41) and
drops the `SrvSett` ids above 3 (harmless); `s_weapon_info` has two more fields; `CTSGun::m_items` has one more element; a plugin or module that sizes a table by the weapon count must know 41 (H9's TSX
keeps kung fu's own stats slot at 41 and must move it to 42).

### A marked Mech lets go of no weapon (server)

ts_matchmode sets `pev->fuser4` to 1 on a player of its Mech class each time it hands the kit over (match mode on); a library without the plugin never sees
the mark, and a player without it is TS's own. `CBasePlayer::DropWeapon` (`dlls/ts_gun.cpp`), the one entry for the drop key, `drop_<n>`, a melee disarm
and the death scatter, returns at its head for a marked player: with the server cvar `tsm_loadoutrework` on for every drop (and `PickUpWeapon` takes
no dropped weapon for him), and with `tsm_mech_nodrop` on (1 by default, a cvar of the plugin) for the disarm (type -2) and for every weapon (types 1 to
41), so that a melee hit does nothing to him and his death throws none of his weapons. The CTF briefcase (`drop_0`) and the flag dropped bare-handed are
no weapons and still go. The plugin refuses the drop key and the weapon bar's drop for his M60 and launcher on its own too.

### h9_customweapons (the PPSh-41 and the laser rifle, on or off)

A server cvar TS 3.0 does not have, `h9_customweapons` (`dlls/game.cpp`, FCVAR_SERVER, default 1). 1 plays the weapons H9
adds to TS 3.0's roster (id 39 on: today the PPSh-41 and the laser rifle; `TS_IsCustomWeapon` is the id range, so a
weapon added later is behind the cvar at once); 0 is TS 3.0's own roster. EVERY weapon H9 adds is gated by this cvar:
a new one needs its stand-in gun in ts_matchmode's `custom_standin` and its presence test in `custom_present`, and
nothing else of the gate. The gate:

- the server refuses to pick either up, by the buy, a world gun or a give (`CBasePlayer::PickUpWeapon`);
- the client's buy menu leaves them out (`CHudTSBuyMenu::Restricted`). The server tells it with `SrvSett` id 4 (0 or 1),
  to everyone when the cvar changes and to a joiner with the other settings (`CTSGameRules::Think`, `InitHUD`). The
  client takes 0 until the server says 1, so a server that never sends it (an original TS 3.0) shows neither;
- ts_matchmode gives its classes the UMP and the M4A1 in their place, as it does where the game library has neither
  (`lo_wpn`). It is read when a loadout is given, so a change reaches the loadouts at the next arming.

What it breaks, against the original and plugins built for it: the original client reads `SrvSett` ids 0 to 3 only and
drops an id above 3, which is harmless; a weapon already carried when the cvar is turned off stays carried until it is
lost.

### TS's top notices beneath the H9 VGUI stack (client)

TS 3.0 draws its top-row notices ("<name> is The Specialist", the killing sprees) from 32 px down, 16 px
lower for each live one. On a server whose match mode draws a VGUI stack at the top of the screen (the match
bar and banners, `docs/H9_VGUI.txt`), H9's client draws those notices beneath the stack instead: each is moved
down by how far the stack's bottom edge is below 32 px (`H9Vgui_StackBottom()` in `cl_dll/h9_vgui.cpp`; the draw
is `CHudTSMessage::Draw` in `cl_dll/ts_message.cpp`). With no stack on screen, as on every server that sends
none, they are where TS puts them. The stack itself starts 1.5% of the screen height down (16 px at 1080;
`cl_h9_vgui_top` sets it in pixels), where the original left its top band to these notices.

### H9 notices come up (client)

A server panel's notice (a banner, flash or bar in place of a hudmessage, `docs/H9_VGUI.txt`) comes up over
0.35 s when it appears, and fades out when it ends. A notice that replaces one still showing keeps the first
one's rise, so a bar sent every tick does not come up again each time; a status shows at once (`NoticeDrawAlpha` in
`cl_dll/h9_vgui.cpp`). The original has no such panels: a hudmessage appears at full strength.

### The colour of the H9 panels (client)

An H9 addition with no counterpart in TS 3.0. The H9 panels (the menus, banners and notices, the match bar, Apollo RP's HUD, the chat
bubbles and the inventory window) are purple, and `cl_h9_vgui_r`, `cl_h9_vgui_g` and `cl_h9_vgui_b` (0 to 255, saved; `cl_h9_vgui_color`
sets the three) give them another colour: the colour of the highlight band, 138 66 196 as shipped, which changes nothing. Every colour of
H9's drawing that is one of its purples (a hue of 248 to 284 degrees, not a grey) takes the hue of the player's colour and a saturation scaled
to it, at its own lightness (`cl_dll/h9_theme_math.h`, tested by `cl_dll/tests/test_theme.cpp`); the panel art is made again in the colour
(`H9ArtBitmap`, no more than twelve times a game, since VGUI1 frees no texture). A warning's red, a need's bar, a team's colour and the
pictures of items are not moved, and neither are TS's own menus, whose colours are the text scheme files'.

### H9 panels a quarter smaller, a side's reinforcements, and marks through the walls (client)

All three are H9 additions with no counterpart in TS 3.0, and all three act only for a server that sends the H9
user messages (`docs/H9_VGUI.txt`):

* The H9 panels (the match mode's menus, banners, notices and the match bar) are built three quarters of the
  size they were: `H9_MENU_SCALE` 0.68 -> 0.51 and `H9_BANNER_SCALE` 0.60 -> 0.45 in `cl_dll/vgui_H9Panel.cpp`,
  with `cl_h9_vgui_scale` on top as before, and their text is drawn from three ladders of four font schemes
  ("H9 Text 1-4", "H9 Detail 1-4", "H9 Flash 1-4") added to the text scheme files (TS's own schemes are left
  as they were; a scheme file without the ladders gives the stock schemes at the same steps).
* `H9Pool` (user message, byte side, short left, short start): a mode that keeps ONE pool of lives for a side
  (the assault mode, which calls its lives REINFORCEMENTS) sends each side's pool, and the scoreboard's team rows
  show it in the lives column as `left/start`, the column titled REINFORCEMENTS (or REINFORCE, or REINF, the longest
  that costs the names no more than 40% of their width, `PlaceCells` in `cl_dll/vgui_ScorePanel.cpp`); the players' own cells are blank because the server sends every player's `H9Lives` as 0 then.
* The `H9Vgui` op MARK (22, protocol 3; `cl_dll/h9_vgui.cpp`): a point of the world a mode wants every player to
  know of is drawn on the screen where it lands, through walls, as a badge in its owner's colour with a bar
  while it is being taken, pinned to the screen's edge while out of view, and as a row of the same badges
  under the top notices (`cl_h9_marks`, `cl_h9_marks_strip`, both 1, saved). The userinfo `_h9vgui` now says 3.
  The original has nothing like it: a TS server shows objectives with the `Objective` message (a compass icon and a
  label at a fixed colour, only on teamplay game modes above 1), which a plugin can still send to a game that
  does not draw marks.

### The ammo box after a HUD reset (server)

TS 3.0's `CTSGun::UpdateClientData` (ts_i386.so 0x758c8) sends `WeaponInfo` when the weapon type (gun+0x97a)
or the caliber's reserve (gun+0x9b4) differs from the last one sent, and a gun that holds kung fu sends it on
a type change alone. The original client puts its ammo box on kung fu at `ResetHUD` and at `VidInit`
(client.dll 0x1004cd7e, 0x1004cc55), so a life that starts on kung fu needs no message. reTS's client kept the
last gun's text through both, so the box stayed on the last gun's name, ammo type and fire mode. The client
now resets as the original does (`cl_dll/ts_ammo.cpp`).

Two things go beyond the original's server. `CBasePlayer::UpdateClientData` clears a held gun's `WeaponInfo`
and `WStatus` caches where it sends `ResetHUD`, so a gun that is still out (a `fullupdate`, a plugin
`spawn()` of a living player) tells the client again what it holds; the original leaves the box on kung fu
until the type changes. And `TSSelectWeaponType` (the `weapon_<N>` command) clears the `WeaponInfo` cache
after a pick, so choosing the weapon already held, kung fu included, sends `WeaponInfo` again. With
`cl_thirdpersonswitch` 1 that resend turns third person on when the weapon is kung fu.

Code: `dlls/player.cpp`, `dlls/ts_gun.cpp`, `cl_dll/ts_ammo.cpp`.

### ReTS_GetInterface (server export)### ReTS_GetInterface (server export)

A versioned struct of get/set functions for the player fields AMX Mod X's TS module touches (cash, slow
motion, kevlar, free slots and the rest), so it does not depend on member offsets. reTSX, the TS module in
goldsrc-net's AMX Mod X fork, uses it whenever the game library exports it. Not in the original; it exists
because of the layout differences below. Detail: CLAUDE.md §4a, `dlls/rets_api.h`.

The current struct is version 6 (v6 appended `PowerUpTouch`; v5 only changed `PowerupTime` to `int`, and
every earlier slot kept its offset). The shipped `tsx_amxx.dll` still requests version 5, so
`ReTS_GetInterface` also answers 5 with a second copy of the table whose `version` field reads 5. A v5
caller never reads the appended slot, so the prefix is safe. Builds that raise the version again must keep
appending, not inserting, or the v5 alias has to be dropped together with the module.

### g_pGameRules exported on Windows (server export)

AMX Mod X's fakemeta finds the game rules object for its get/set_gamerules_* natives by the name
`@g_pGameRules` on Linux, and on Windows by a byte signature of Counter-Strike's `CWorld::Precache`,
which matches neither TS 3.0's VC6 build nor reTS's. reTS's `mp.dll` exports `g_pGameRules` by name
(`dlls/gamerules.cpp`, a linker export per arch, since the decorated name differs), and the AMX Mod X
fork's tsx-ts3 gamedata (`common.games/globalvars-rets.txt`, selected by `ReTS_GetInterface`) looks it up
that way on Windows. TS 3.0's `mp.dll` exports no such name; the public fork finds it there by a signature
of TS 3.0's own code (`common.games/globalvars-ts.txt`).

On Linux this is no deviation: TS 3.0's `ts_i386.so` exports every symbol, `g_pGameRules` included;
reTS builds with hidden visibility, so in the stripped Linux libraries the packages ship it could not be
found (AMX Mod X also reads an unstripped library's full symbol table, which is why dev builds worked).
`dlls/gamerules.h` gives `g_pGameRules` default visibility to export it the same way.

## Forced by the build

None of these were chosen. They follow from building TS's code with a modern compiler on Half-Life
Updated, and they break anything that reaches into the game library by address instead of by name.

### Member offsets

reTS's objects do not have TS 3.0's memory layout, so a field is not at the offset the original has it at:

- gcc 2.96, which built TS 3.0, put the vtable pointer at `+0x60` in each object; every modern compiler
  puts it at `+0`, which moves every field before it.
- Half-Life Updated's base classes have members the 2007 SDK did not.
- On amd64 and arm64 pointers are 8 bytes, which moves every field after the first pointer.

Offsets are moved toward the original's where feasible, and recovered offsets stay in the code as
comments, but an exact match is not reachable. `scripts/coverage/offsets.py` maps original offsets to
reTS's, per architecture.

What it breaks: an AMX Mod X plugin or module that reads or writes TS 3.0 offsets directly
(`get_pdata`/`set_pdata`, stock TSX) reads the wrong fields on reTS. reTSX avoids this through
`ReTS_GetInterface`; a plugin that pokes offsets itself has no fix short of the layout matching.

### Vtable slots

reTS keeps the original's virtuals in the original's order, plus a few that every Half-Life Updated mod
has (listed in CLAUDE.md: the virtual destructor, `MyTogglePointer`, the HL25 sentence virtuals on
`CBaseToggle`, the client-prediction virtuals on `CBasePlayerItem`, `DoRetireWeapon`). Those shift the
slot numbers after them, so Ham Sandwich's stock TS gamedata hooks the wrong functions. reTS has its own,
`gamedata/common.games/virtual.games/ts/offsets-rets.txt` in the AMX Mod X fork, written by
`scripts/coverage/hamdata.py` and selected by the `ReTS_GetInterface` export.

### State kept differently

A few values are the same as the original's to a plugin calling the game, but are not stored the way the
original stores them, so even a matched offset would not hold them:

- Free slots: reTS derives the count from what the player carries; setting it stores the difference in
  `CBasePlayer::m_iFreeSlotsAdjust`. Like the original's counter it is not clamped, so with more slots
  set a player can carry over 81 slots' worth (an M60, a grenade and a pistol, 87).
- Slow motion: the original keeps a registry of slowed players in the game rules; reTS re-applies slow
  motion each frame and keeps no such array (`CTSGameRules::TogglePlayerFromSlow`).
