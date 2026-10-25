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
M61 7). Two bytes remove that second ceiling; a player the plugin never gave room is still held
to 81 exactly as before. Bytes, reasoning and rollback: ts/dlls/mp.dll.patch.

mp.dll -- ts_matchmode can grant a powerup while nopowerup is 1:
reTS arms a powerup's Touch only from its first think, and only once nopowerup is off, so with
nopowerup 1 neither ts_createpwup nor ts_givepwup could ever hand one over -- and
ts_force_run_powerup never gave kung fu at all: it writes the running-powerup slot, and kung fu
is the player's own flag. A 7-byte hook in CTSPowerup::Spawn arms Touch at once for a powerup
carrying spawnflags bit 30, but only while the cvar tsm_enabled exists and is on -- that is,
only under ts_matchmode. Every other powerup, and every server without the mode, keeps stock
nopowerup. Same file: ts/dlls/mp.dll.patch, which carries both mp.dll patches.

tsx_amxx.dll (reTSX) -- Xash3D's bots count as bots:
tsx only put a bot in game when its auth id was BOT. Xash3D FWGS calls its bots ID_BOT, so there
every tsx native refused them ("[TSX] Player N is not ingame") and the plugin could not set them
up. ID_BOT now counts too, but only when the engine is Xash3D (the host_ver cvar exists), so GoldSrc
is unchanged. Details: ts/addons/amxmodx/modules/tsx_amxx.dll.patch.

Both are built from the shipped files, kept as mp.dll.original and tsx_amxx.dll.original, by
TSM\decompile_dll\build_patch_mp_slots.py, build_patch_mp_pwup.py (which stacks on it) and
build_patch_tsx_idbot.py. MANIFEST.tsv still lists the vendor's original hashes.