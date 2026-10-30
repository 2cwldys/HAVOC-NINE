These .dll edits are done with reTS, which is considered decompiled and recompiled The Specialists source code.
Allowing the ability to no longer fight with conflicting userinfo or causing client userinfo overflow crashes with custom playermodel enforcement.

mp_teammodels_force:
1 (default) - you can only use your own team's models. If you pick one with model x it sticks, and changing your name or anything else in your userinfo no longer rerolls it like TS 3.0 does
2 - any model except the other teams' models. This is the one for your custom model plugins
0 - any model at all, enemy team models included. Your plugin handles everything

For our purposes, we use 0 with plugin enforcement.

mp.dll -- ts_setuserslots decides a player's room:
reTS checked every weapon give against a fixed 81 slots of carried weight on top of the room the
plugin grants, so a kit past 81 always lost a piece -- the Heavy's is 87 (M60 70, Glock-20C 10,
M61 7). The reTS source build has no second ceiling: the room the plugin grants is the only
limit, and a player the plugin never gave room is still held to 81 exactly as before.

mp.dll -- ts_matchmode can grant a powerup while nopowerup is 1:
reTS arms a powerup's Touch only from its first think, and only once nopowerup is off, so with
nopowerup 1 neither ts_createpwup nor ts_givepwup could ever hand one over -- and
ts_force_run_powerup never gave kung fu at all: it writes the running-powerup slot, and kung fu
is the player's own flag. CTSPowerUp::Spawn now arms Touch at once for a powerup carrying
spawnflags bit 30, but only while the cvar tsm_enabled exists and is on -- that is, only under
ts_matchmode. Every other powerup, and every server without the mode, keeps stock nopowerup.

mp.dll -- a disarm puts the weapon away:
a disarm used to clear the weapon item and leave the player holding a gun with nothing owned
behind it. It now holsters to bare hands. A stackable spare, or a single whose akimbo is also
owned, still keeps the remainder, as TS does.

mp.dll -- interface 5 and 6:
the source defines interface 6; the deployed reTSX module asks for 5. ReTS_GetInterface serves a
version-5 copy of the same table, so every ReTS native still resolves.

mp.dll -- 2026-10-29 upstream commits:
moving fire now penalises only the M60 and the Barrett, and gunshot and ricochet pitch is
unclamped (400 at normal speed), as TS 3.0 plays them.

Bytes, reasoning and rollback: ts/dlls/mp.dll.patch.

tsx_amxx.dll (reTSX) -- Xash3D's bots count as bots:
tsx only put a bot in game when its auth id was BOT. Xash3D FWGS calls its bots ID_BOT, so there
every tsx native refused them ("[TSX] Player N is not ingame") and the plugin could not set them
up. ID_BOT now counts too, but only when the engine is Xash3D (the host_ver cvar exists), so GoldSrc
is unchanged. Details: ts/addons/amxmodx/modules/tsx_amxx.dll.patch.

mp.dll is now built from the reTS source tree by scripts\build-win32-dropin.ps1 with
RETS_REBUILD=1 (xash.bat's assemble step sets it). release_binaries\ts\ keeps the previous
release DLL with its two binary patches -- build_patch_mp_slots.py, then build_patch_mp_pwup.py
(which stacks on it), starting from mp.dll.original -- for rollback. tsx_amxx.dll is still
built from the shipped file, kept as tsx_amxx.dll.original, by build_patch_tsx_idbot.py.
MANIFEST.tsv still lists the vendor's original hashes.

The GoldSrc package gets the same pair: export.bat copies reTS\binaries\ts\dlls\mp.dll and
reTS\binaries\ts\cl_dlls\client.dll (with their .patch docs) into export\ts\, so the non-Xash
package carries the disarm fix and the 2026-10-29 upstream commits too.
