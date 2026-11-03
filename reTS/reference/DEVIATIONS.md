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
game id"), so no game weapon has that number; `TSW_COUNT` is 40. The PPSh-41's row is the AK47's taken whole, so
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

### TS's top notices beneath the H9 VGUI stack (client)

TS 3.0 draws its top-row notices ("<name> is The Specialist", the killing sprees) from 32 px down, 16 px
lower for each live one. On a server whose match mode draws a VGUI stack at the top of the screen (the match
bar and banners, `docs/H9_VGUI.txt`), H9's client draws those notices beneath the stack instead: each is moved
down by how far the stack's bottom edge is below 32 px (`H9Vgui_StackBottom()` in `cl_dll/h9_vgui.cpp`; the draw
is `CHudTSMessage::Draw` in `cl_dll/ts_message.cpp`). With no stack on screen, as on every server that sends
none, they are where TS puts them. The stack itself starts 1.5% of the screen height down (16 px at 1080;
`cl_h9_vgui_top` sets it in pixels), where the original left its top band to these notices.

### ReTS_GetInterface (server export)

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
