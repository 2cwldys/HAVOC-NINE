#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>

// EntMod4 -- reconstructed: the game-DLL (DLL_FUNCTIONS) hook handlers that EntMod fills directly
// (the entity-dispatch hooks live in dispatch.cpp and are wired as thunks in dllapi.cpp).
// DFGameDLLInit @0x52130, DFClientConnect @0x53900, DFClientCommand @0x534f0, DFStartFrame @0x53b50.

char moddir[256] = "ts";
int firstserverframe = 0;

// Plugin version/identity cvar; registered in DFGameDLLInit. (read-only marker)
cvar_t DF_entversion = { "DF_entversion", "4", FCVAR_SERVER };

// NewWeapons per-player slot (0x48 bytes, defined in weaponcore.cpp): +0 state/id (0x5a = the
// entity-mover weapon is active), +4 attack-held flag, +0x14 saved viewmodel, +0x18 saved
// weaponmodel, +0x1c underlying real-weapon id. Accessed here by the same byte offsets the binary uses.
#define NW(idx, off) (*(int *)(NewWeapons + (idx) * 0x48 + (off)))

// pfnGameInit: register the version cvar. The original also set moddir, but in its game-DLL-shim
// init (not built in the Metamod config), so we learn the game dir here -- CheckAdmin needs it to
// find addons/EntMod/DF_admins.txt before any client connects.
void DFGameDLLInit(void)
{
	GET_GAME_DIR(moddir);
	CVAR_REGISTER(&DF_entversion);
	H9GameInit();   // H9: register the entmod / entmod_maps gate cvars (src/h9/h9_gate.cpp)
	RETURN_META(MRES_IGNORED);
}

// pfnClientConnect: register EntMod's user messages (once) and clear this player's per-player block.
qboolean DFClientConnect(edict_t *player, const char *name, const char *address, char reject[128])
{
	DFRegisterUserMessages();

	int idx = ENTINDEX(player);
	unsigned char *eb = EntInfo3[idx].raw;   // start of this player's 0xfd30 block

	EntInfo3[idx].adminflags = 0;            // +0xfd2c
	*(int *)(eb + 0x24) = 0;
	*(int *)(eb + 0x28) = 0;
	*(int *)(eb + 0x80) = 0;
	*(int *)(eb + 0x30) = 0;
	NW(idx, 0) = 0;
	*(int *)(eb + 0xc8) = 0;
	memset(eb + 0xcc, 0, 0xcc00);
	memset(eb + 0xcccc, 0, 0x198 * 4);

	CLIENT_PRINTF(player, print_console, "This server is running Ent Mod v4 by:\n");
	CLIENT_PRINTF(player, print_console, "Drunken_F00l / remortal -- adminop.net\n");

	RETURN_META_VALUE(MRES_IGNORED, TRUE);
}

void DFClientDisconnect(edict_t *player)
{
	RETURN_META(MRES_IGNORED);
}

void DFClientPutInServer(edict_t *player)
{
	RETURN_META(MRES_IGNORED);
}

// pfnClientCommand: admin entity/mover commands first (and blocked from the game DLL), then the
// custom entity-mover weapon's equip / special / switch-back handling; everything else passes through.
int DFClientCommand(edict_t *player)
{
	if (IsAdmin(player, 0))
	{
		if (DFEntMover(player))
			return 1;
		if (DFEntAdmin(player))
			return 1;
	}

	const char *cmd = Cmd_Argv(0);
	int idx = ENTINDEX(player);

	// "_special": fire the active custom weapon's special (the entmover family is state >= 0x5a).
	if (FStrEq(cmd, "_special") && NW(idx, 0) > 0x59)
	{
		WeaponSpecial(player);
		return 1;
	}

	// "weapon_entmover": equip the entity-mover weapon (admin, alive, not already equipped).
	if (FStrEq(cmd, "weapon_entmover") && IsAlive(player) && IsAdmin(player, 0) && NW(idx, 0) != 0x5a)
	{
		if (NW(idx, 0) > 0x59)
		{
			if (NW(idx, 4))
				WeaponForceOff(player);
			WeaponHolster(player);
		}
		if (NW(idx, 0) < 0x5a)
		{
			NW(idx, 0x18) = player->v.weaponmodel;
			NW(idx, 0x14) = player->v.viewmodel;
		}
		NW(idx, 0) = 0x5a;
		NW(idx, 4) = 0;
		WeaponDeploy(player);
		return 1;
	}

	// Entmover weapon active and the player selects the underlying real weapon: holster the tool and
	// restore their weapon/view models.
	if (NW(idx, 0) >= 0x5a)
	{
		const char *under = DFWeaponForId(NW(idx, 0x1c));
		if (FStrEq(Cmd_Argv(0), under))
		{
			if (NW(idx, 4))
				WeaponForceOff(player);
			WeaponHolster(player);
			NW(idx, 0) = NW(idx, 0x1c);
			player->v.weaponmodel = NW(idx, 0x18);
			player->v.viewmodel = NW(idx, 0x14);
			NW(idx, 0x18) = 0;
		}
	}

	return 0;
}

// pfnStartFrame: every 10 seconds, re-read DF_admins.txt for every client so admin status (and a
// changed _entpass) is picked up live.
void DFStartFrame(void)
{
	firstserverframe = 1;

	if (NextAdminCheck < gpGlobals->time)
	{
		for (int i = 0; i <= gpGlobals->maxClients; i++)
		{
			edict_t *e = INDEXENT(i);
			if (e)
				CheckAdmin(e);
		}
		NextAdminCheck = gpGlobals->time + 10.0f;
	}

	RETURN_META(MRES_IGNORED);
}
