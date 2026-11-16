#include "plugin.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

// EntMod4 -- reconstructed: the metamod/game-DLL dispatch bridges and the DF* hook handlers
// (original dispatch.cpp). The m_* bridges run EntMod's DF* handler and, on MRES_IGNORED,
// fall through to the real game DLL via gpGamedllFuncs. Cmd_Arg* are the engine Cmd_* hooks
// that serve EntMod's injected client command when ModCmd is set. DFPlayerPreThink drives the
// entity-mover / path tools and the custom-weapon state machine; DFDispatchKeyValue / DFDispatchSpawn
// capture entity data into the es_ save table (Entities[]) for the admin save/load commands.

// ---- owned globals (see RECON_MANIFEST.txt) ----
char  mr_meta = 0;          // set by Meta_Attach (modmain.cpp); bridges branch on it
char  ModCmd  = 0;          // non-zero while an injected client command is being read
void *h_Library = 0;        // real-gamedll dlopen handle (OUT-1 trampolines only)

int ntfDidRegister = 0;
int ntfMsgIdMOTD = 0;
int ntfMsgIdServerName = 0;
int ntfMsgIdSecAmmoVal = 0;
int ntfMsgIdAmmoX = 0;
int ntfMsgIdWeaponList = 0;
int ntfMsgIdCurWeapon = 0;
int ntfMsgIdAmmoPickup = 0;
int ntfMsgIdWeapPickup = 0;
int ntfMsgIdScoreInfo = 0;
int ntfMsgIdBuildSt = 0;
int ntfMsgIdResetHUD = 0;
int gmsgShowMenu = 0;

int EntInfo[256];           // zeroed on worldspawn (DFDispatchSpawn)
int precached_models = 0;   // model index of sprites/laserbeam.spr

// sprites/zerogxplode.spr index (DAT_0042a9b4): no recovered symbol name, kept file-static here
// per the manifest. NOTE: entmover.cpp (EntMoverSpecial @0x51420) and admintools.cpp (DFEntAdmin
// @0x46fc0) reference this same index in the binary; as the contract exposes no shared symbol,
// each of those modules must obtain its own zerogxplode index.
static int s_zeroGExplodeModel = 0;

// Injected-command buffers backing Cmd_Arg* when ModCmd is set. The original keeps these in its data
// section (argc at DAT_0008dca4, argv[0] DAT_0008dca8, argv[1] DAT_0008e0a8, args DAT_0008e4a8). The
// writer that sets ModCmd and fills them is not in the reconstructed in-scope set, so they are kept
// file-static here matching the read sites; nothing in this module writes them.
static int  g_injArgc = 0;
static char g_injArgv0[1024];
static char g_injArgv1[1024];
static char g_injArgs[1024];

// DFClientCommand lives in dll.cpp (locally prototyped in dllapi.cpp). The faithful bridge uses its
// int return (the manifest expands dll.cpp's handler to the int-returning full body @0x534f0).
int DFClientCommand(edict_t *pent);

// ======================================================================================
// user messages + metamod bridges
// ======================================================================================

// DFRegisterUserMessages @0x337f0
void DFRegisterUserMessages(void)
{
	if (ntfDidRegister == 0)
	{
		ntfMsgIdMOTD       = REG_USER_MSG("MOTD", -1);
		ntfMsgIdServerName = REG_USER_MSG("ServerName", -1);
		ntfMsgIdSecAmmoVal = REG_USER_MSG("SecAmmoVal", 2);
		ntfMsgIdAmmoX      = REG_USER_MSG("AmmoX", 2);
		ntfMsgIdWeaponList = REG_USER_MSG("WeaponList", -1);
		ntfMsgIdCurWeapon  = REG_USER_MSG("CurWeapon", 3);
		ntfMsgIdAmmoPickup = REG_USER_MSG("AmmoPickup", 2);
		ntfMsgIdWeapPickup = REG_USER_MSG("WeapPickup", 1);
		ntfMsgIdScoreInfo  = REG_USER_MSG("ScoreInfo", 9);
		ntfMsgIdBuildSt    = REG_USER_MSG("BuildSt", 1);
		ntfMsgIdResetHUD   = REG_USER_MSG("ResetHUD", 1);
		gmsgShowMenu       = REG_USER_MSG("ShowMenu", -1);
	}
	ntfDidRegister = 1;
}

// m_DispatchSpawn @0x33950
// The original !mr_meta branch tail-called the standalone shim's own real-gamedll Dispatch* trampoline
// (OUT-2, not built in the metamod configuration); here both branches reach the real game DLL through
// gpGamedllFuncs, the only path available to this build.
int m_DispatchSpawn(edict_t *pent)
{
	if (mr_meta == 0)
		return gpGamedllFuncs->dllapi_table->pfnSpawn(pent);
	if (DFDispatchSpawn(pent) != 0)
		return 0;
	return gpGamedllFuncs->dllapi_table->pfnSpawn(pent);
}

// m_DispatchUse @0x339a0
void m_DispatchUse(edict_t *pActivator, edict_t *pCaller)
{
	if (mr_meta == 0)
	{
		gpGamedllFuncs->dllapi_table->pfnUse(pActivator, pCaller);
		return;
	}
	if (DFDispatchUse(pActivator, pCaller) != 0)
		return;
	gpGamedllFuncs->dllapi_table->pfnUse(pActivator, pCaller);
}

// m_DispatchTouch @0x33a10
void m_DispatchTouch(edict_t *pToucher, edict_t *pTouched)
{
	if (mr_meta == 0)
	{
		gpGamedllFuncs->dllapi_table->pfnTouch(pToucher, pTouched);
		return;
	}
	if (DFDispatchTouch(pToucher, pTouched) != 0)
		return;
	gpGamedllFuncs->dllapi_table->pfnTouch(pToucher, pTouched);
}

// m_DispatchKeyValue @0x33a80
void m_DispatchKeyValue(edict_t *pent, KeyValueData *pkvd)
{
	if (mr_meta == 0)
	{
		gpGamedllFuncs->dllapi_table->pfnKeyValue(pent, pkvd);
		return;
	}
	if (DFDispatchKeyValue(pent, pkvd) != 0)
		return;
	gpGamedllFuncs->dllapi_table->pfnKeyValue(pent, pkvd);
}

// m_ClientCommand @0x33af0
void m_ClientCommand(edict_t *pent)
{
	if (mr_meta == 0)
	{
		gpGamedllFuncs->dllapi_table->pfnClientCommand(pent);
		return;
	}
	if (DFClientCommand(pent) != 0)
		return;
	gpGamedllFuncs->dllapi_table->pfnClientCommand(pent);
	ModCmd = 0;
}

// Cmd_Argv @0x33b50
const char *Cmd_Argv(int argc)
{
	if (ModCmd == 0 || argc > 1)
	{
		if (mr_meta)
			gpMetaGlobals->mres = MRES_HANDLED;
		return g_engfuncs.pfnCmd_Argv(argc);
	}
	const char *r = (argc == 1) ? g_injArgv1 : g_injArgv0;
	if (mr_meta)
		gpMetaGlobals->mres = MRES_SUPERCEDE;
	return r;
}

// Cmd_Argc @0x33bd0
int Cmd_Argc(void)
{
	if (ModCmd == 0)
	{
		if (mr_meta)
			gpMetaGlobals->mres = MRES_HANDLED;
		return g_engfuncs.pfnCmd_Argc();
	}
	if (mr_meta)
		gpMetaGlobals->mres = MRES_SUPERCEDE;
	return g_injArgc;
}

// Cmd_Args @0x33c30
const char *Cmd_Args(void)
{
	if (ModCmd != 0)
	{
		if (mr_meta)
			gpMetaGlobals->mres = MRES_SUPERCEDE;
		return g_injArgs;
	}
	if (mr_meta)
		gpMetaGlobals->mres = MRES_HANDLED;
	return g_engfuncs.pfnCmd_Args();
}

// ======================================================================================
// DF* game-DLL hook handlers
// ======================================================================================

// EntInfo3 player block. NOTE: the decompile indexes the per-player state with a 0xfd30-byte stride and
// reads mover / path-tool edit fields far beyond playerstate_t's current single adminflags member. The
// contract's playerstate_t is intentionally a stub ("grown as the entity-tool modules land"), so these
// raw-offset accessors mirror the original binary's layout and are memory-safe only once playerstate_t
// is grown to 0xfd30 bytes. Reconstructed to the binary; see deviations[].
static inline char  *EB(int idx)          { return (char *)EntInfo3 + idx * 0xfd30; }
static inline int   &EIi(int idx, int o)  { return *(int *)(EB(idx) + o); }
static inline float &EIf(int idx, int o)  { return *(float *)(EB(idx) + o); }
static inline int   &NWi(int idx, int o)  { return *(int *)(NewWeapons + idx * 0x48 + o); }

// DFPlayerPreThink @0x52150
int DFPlayerPreThink(edict_t *player)
{
	if (STRING(player->v.netname)[0] == '\0')
		return 0;
	if (!FStrEq(STRING(player->v.classname), "player"))
		return 0;

	int idx = ENTINDEX(player);

	// path recorder: drop a path_corner at the player every half second while armed (EIi +0x14 counter)
	if (EIi(idx, 0x14) != 0 && IsAlive(player) && EIf(idx, 0x18) + 0.5f <= gpGlobals->time)
	{
		int cnt = EIi(idx, 0x14);
		char *nm = EB(idx);
		edict_t *e = AddGameEntity(UTIL_VarArgs("path_corner:targetname:%s_%i:target:%s_%i",
		                                        nm, cnt, nm, cnt + 1));
		if (e)
			e->v.origin = player->v.origin;
		ClientPrint2(player, 1, UTIL_VarArgs("%s_%i\n", nm, cnt));
		EIi(idx, 0x14) = cnt + 1;
		EIf(idx, 0x18) = gpGlobals->time;
	}

	// multi-entity bind: carry each bound entity with the player's motion (slots at +0xd318, 0x30 each)
	if (EIi(idx, 0x2c) != 0)
	{
		for (int i = 0; i < EIi(idx, 0x1c); i++)
		{
			char *slot = EB(idx) + 0xd318 + i * 0x30;
			edict_t *e = INDEXENT(*(int *)(slot + 0xc));
			if (!UTIL_IsValidEntity(e))
			{
				*(int *)(slot + 0xc) = 0;
			}
			else if (!FStrEq(STRING(e->v.classname), "worldspawn"))
			{
				Vector no(
					(*(float *)(slot + 0x14) - EIf(idx, 0x74)) + player->v.origin.x,
					(*(float *)(slot + 0x18) - EIf(idx, 0x78)) + player->v.origin.y,
					(*(float *)(slot + 0x1c) - EIf(idx, 0x7c)) + player->v.origin.z);
				e->v.origin = no;
				SET_ORIGIN(e, no);
			}
		}
	}

	// single/dual bind modes (EIi +0x80): 1 = translate, 2 = translate + face the player
	if (EIi(idx, 0x80) == 1)
	{
		static const int targetOff[2] = { 0x24, 0x28 };
		for (int t = 0; t < 2; t++)
		{
			if (EIi(idx, targetOff[t]) == 0)
				continue;
			edict_t *e = INDEXENT(EIi(idx, targetOff[t]));
			if (!UTIL_IsValidEntity(e))
			{
				EIi(idx, targetOff[t]) = 0;
				EIi(idx, 0x80) = 0;
			}
			else if (!FStrEq(STRING(e->v.classname), "worldspawn"))
			{
				Vector no(
					(EIf(idx, 0x84) - EIf(idx, 0x90)) + player->v.origin.x,
					(EIf(idx, 0x88) - EIf(idx, 0x94)) + player->v.origin.y,
					(EIf(idx, 0x8c) - EIf(idx, 0x98)) + player->v.origin.z);
				e->v.origin = no;
				SET_ORIGIN(e, no);
			}
		}
	}
	else if (EIi(idx, 0x80) == 2)
	{
		if (EIi(idx, 0x24) != 0)
		{
			edict_t *e = INDEXENT(EIi(idx, 0x24));
			if (!UTIL_IsValidEntity(e))
			{
				EIi(idx, 0x24) = 0;
				EIi(idx, 0x80) = 0;
			}
			else if (!FStrEq(STRING(e->v.classname), "worldspawn"))
			{
				e->v.origin.x = EIf(idx, 0x84);
				e->v.origin.y = EIf(idx, 0x88);
				e->v.origin.z = EIf(idx, 0x8c);
				Vector so(EIf(idx, 0x7c), EIf(idx, 0x80), EIf(idx, 0x84));
				SET_ORIGIN(e, so);
				Vector dir = player->v.origin - e->v.origin;
				e->v.angles = UTIL_VecToAngles(dir);
			}
		}
	}

	// custom-weapon state machine (NewWeapons id >= 0x5a marks the entity-mover weapon)
	if (NWi(idx, 0) >= 0x5a)
	{
		unsigned int btn = player->v.button;
		player->v.button = btn & 0xffffdfffu;   // clear the reload bit each frame

		// special fire (bit 0x800)
		if ((btn & 0x800) != 0)
		{
			if (NWi(idx, 8) != 0 || !IsAlive(player))
			{
				if ((player->v.button & 0x800) == 0 || !IsAlive(player))
					goto sp_notheld;
				goto sp_held2;
			}
			player->v.button &= 0xfffff7ffu;
			NWi(idx, 8) = 1;
			WeaponSpecial(player);
		}
		else
		{
		sp_notheld:
			if (NWi(idx, 8) == 1)
			{
				NWi(idx, 8) = 0;
			}
			else
			{
			sp_held2:
				if (player->v.button & 0x800)
				{
					if (NWi(idx, 8) == 1 && IsAlive(player))
					{
						NWi(idx, 8) = 1;
						player->v.button &= 0xfffff7ffu;
					}
				}
			}
		}

		// primary fire (bit 0x1)
		if ((player->v.button & 1) != 0)
		{
			if (NWi(idx, 4) != 0 || !IsAlive(player))
			{
				if ((player->v.button & 1) == 0 || !IsAlive(player))
					goto pr_off;
				goto pr_cont;
			}
			player->v.button &= ~1u;
			NWi(idx, 4) = 1;
			PrimaryAttack(player);
		}
		else
		{
		pr_off:
			if (NWi(idx, 4) == 1)
			{
				NWi(idx, 4) = 0;
				PrimaryAttackOff(player);
			}
			else
			{
			pr_cont:
				if ((player->v.button & 1) == 0 || NWi(idx, 4) != 1 || !IsAlive(player))
				{
					PrimaryIdle(player);
				}
				else
				{
					NWi(idx, 4) = 1;
					player->v.button &= ~1u;
					PrimaryContinue(player);
				}
			}
		}
		PrimaryAlways(player);
	}

	if (NWi(idx, 0) >= 0x5a)
		WeaponCheck(player);
	if (NWi(idx, 0) >= 0x5a && !IsAlive(player))
	{
		if (NWi(idx, 4) != 0)
			WeaponForceOff(player);
		WeaponHolster(player);
		NWi(idx, 0) = NWi(idx, 0x1c);
	}
	return 0;
}

// DFPlayerPostThink @0x52e80
int DFPlayerPostThink(edict_t *player)
{
	if (STRING(player->v.netname)[0] != '\0' && FStrEq(STRING(player->v.classname), "player"))
	{
		int idx = ENTINDEX(player);
		if (NWi(idx, 0) >= 0x5a)
			player->v.button &= 0xffffdfffu;
	}
	return 0;
}

// DFDispatchKeyValue @0x52f00 -- capture entity keyvalues into the es_ save buffer (Entities[idx] +0x40).
// NOTE: the original's __sprintf_chk / __strcat_chk format strings and its shared scratch buffer were
// not recoverable from the decompile; the colon-delimited "key:value" form is reconstructed from what
// AddGameEntity (@0x54d90) parses back with strtok(":"), and a local temp replaces the scratch global.
int DFDispatchKeyValue(edict_t *pent, KeyValueData *pkvd)
{
	const char *key = pkvd->szKeyName;
	const char *value = pkvd->szValue;
	int idx = ENTINDEX(pent);

	if (FStrEq(key, "classname"))
	{
		strncpy(Entities + idx * 0x640, value, 0x40);
		Entities[idx * 0x640 + 0x3f] = 0;
		return 0;
	}

	if (FStrEq(key, "rendermode") || FStrEq(key, "renderamt") ||
	    FStrEq(key, "rendercolor") || FStrEq(key, "renderfx"))
		return 0;

	bool record = true;
	if (strtol(value, NULL, 10) == 0 && firstserverframe == 0)
	{
		static const char *const transient[] = {
			"invisible_finished", "invincible_finished", "no_grenades_2", "no_grenades_1",
			"ammo_detpack", "ammo_medikit", "ammo_cells", "ammo_rockets", "ammo_nails",
			"ammo_shells", "armorclass", "armorvalue", "armortype", "lives", "frags",
			"remove_item_group", "remove_item_no", "axhitme", "items",
			"restore_spawngroup", "remove_spawngroup", "restore_spawnpoint", "remove_spawnpoint",
			"restore_group_no", "remove_group_no", "inactivate_group_no", "activate_group_no",
			"restore_goal_no", "remove_goal_no", "inactivate_goal_no", "activate_goal_no"
		};
		for (unsigned i = 0; i < sizeof(transient) / sizeof(transient[0]); i++)
		{
			if (FStrEq(key, transient[i]))
			{
				record = false;
				break;
			}
		}
	}

	char *ebuf = Entities + idx * 0x640 + 0x40;
	if (ebuf[0] == '\0')
	{
		snprintf(ebuf, 0x5fe, "%s:%s", key, value);
	}
	else if (record)
	{
		char kv[1024];
		snprintf(kv, sizeof(kv), ":%s:%s", key, value);
		if (strlen(ebuf) + strlen(kv) < 0x5fe)
			strcat(ebuf, kv);
	}
	return 0;
}

// DFDispatchThink @0x534b0
int DFDispatchThink(edict_t *pent)
{
	return 0;
}

// DFDispatchUse @0x534c0
int DFDispatchUse(edict_t *pActivator, edict_t *pCaller)
{
	return 0;
}

// DFDispatchTouch @0x534d0
int DFDispatchTouch(edict_t *pToucher, edict_t *pTouched)
{
	return 0;
}

// DFDispatchBlocked @0x534e0
int DFDispatchBlocked(edict_t *pBlocked, edict_t *pOther)
{
	return 0;
}

// DFServerDeactivate @0x537d0
void DFServerDeactivate(void)
{
}

// DFServerActivate @0x537e0 (decompile drops the unused hook args)
void DFServerActivate(edict_t *pEdictList, int edictCount, int clientMax)
{
}

// DFDispatchSpawn @0x537f0
int DFDispatchSpawn(edict_t *pent)
{
	int idx = ENTINDEX(pent);
	strncpy(Entities + idx * 0x640, STRING(pent->v.classname), 0x40);
	Entities[idx * 0x640 + 0x3f] = 0;

	if (FStrEq(STRING(pent->v.classname), "worldspawn"))
	{
		memset(EntInfo, 0, sizeof(EntInfo));
		memset(Entities, 0, 0x190000);
		firstserverframe = 0;
		NextAdminCheck = 0;
		precached_models    = PRECACHE_MODEL("sprites/laserbeam.spr");
		s_zeroGExplodeModel = PRECACHE_MODEL("sprites/zerogxplode.spr");
		PRECACHE_MODEL("sprites/exit1.spr");
		PRECACHE_MODEL("sprites/enter1.spr");
		PRECACHE_SOUND("buttons/bell1.wav");
		WeaponPrecache();
	}
	return 0;
}
