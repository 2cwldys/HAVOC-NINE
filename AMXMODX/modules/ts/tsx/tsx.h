// vim: set ts=4 sw=4 tw=99 noet:
//
// AMX Mod X, based on AMX Mod by Aleksander Naszko ("OLO").
// Copyright (C) The AMX Mod X Development Team.
// Copyright (C) 2004 Lukasz Wlasinski.
//
// This software is licensed under the GNU General Public License, version 3 or higher.
// Additional exceptions apply. For full license details, see LICENSE.txt or visit:
//     https://alliedmods.net/amxmodx-license

//
// TSX Module
//

#ifndef TSX_H
#define TSX_H

#include "amxxmodule.h"
#include "CMisc.h"
#include "CRank.h"
#include <IGameConfigs.h>
#include <HLTypeConversion.h>
#include "rets_api.h"

#define RANK_SVERSION "0.2"

#define GET_PLAYER_POINTER(e)   (&players[ENTINDEX(e)])
#define GET_PLAYER_POINTER_I(i) (&players[i])

#ifndef GETPLAYERAUTHID
#define GETPLAYERAUTHID   (*g_engfuncs.pfnGetPlayerAuthId)
#endif

#define STUNT_NONE 0
#define STUNT_DUCK 1
#define STUNT_ROLL 2
#define STUNT_DIVE 3
#define STUNT_GETUP 4
#define STUNT_FLIP 5

extern AMX_NATIVE_INFO stats_Natives[];
extern AMX_NATIVE_INFO base_Natives[];

extern int gmsgResetHUD;
extern int gmsgWeaponInfo;
extern int gmsgClipInfo;
extern int gmsgScoreInfo;
extern int gmsgTSHealth;
extern int gmsgTSState;

extern int gmsgWStatus;
extern int gmsgTSCash;
extern int gmsgTSSpace;
extern int gmsgPwUp;
extern int gmsgDeathMsg;

void Client_ResetHUD_End(void*);
void Client_WeaponInfo(void*);
void Client_ClipInfo(void*);
void Client_ScoreInfo(void*);
void Client_TeamInfo(void*);
void Client_TSHealth_End(void*);
void Client_TSState(void*);
void Client_WStatus(void* mValue);
void Client_TSCash(void* mValue);
void Client_TSSpace(void* mValue);
void Client_PwUp(void* mValue);
void Client_DeathMsg(void* mValue);

typedef void (*funEventCall)(void*);
extern funEventCall modMsgsEnd[MAX_REG_MSGS];
extern funEventCall modMsgs[MAX_REG_MSGS];
extern void (*function)(void*);
extern void (*endfunction)(void*);

extern cvar_t *tsstats_maxsize;
extern cvar_t* tsstats_rank;
extern cvar_t* tsstats_reset;

extern RankSystem g_rank;
extern CPlayer players[TSX_MAX_PLAYERS + 1];

extern CPlayer* mPlayer;
extern int mPlayerIndex;
extern int mState;

extern bool is_theonemode;
extern bool rankBots;

extern int g_death_info;
extern int g_damage_info;

struct weapon_t {
	bool melee; // 
	char name[24];
	char logname[24];
	int bonus;
	bool custom;
};

extern int gKnifeOffset;

extern weapon_t weaponData[TSMAX_WEAPONS];

extern IGameConfig *CommonConfig;
extern IGameConfig *MainConfig;

#define GET_OFFSET(classname, member)												\
	static int member = -1;															\
	if (member == -1)																\
	{                                                                               \
		TypeDescription type;                                                       \
		if (!CommonConfig || !CommonConfig->GetOffsetByClass(classname, #member, &type) || type.fieldOffset < 0)\
		{																			\
			MF_LogError(amx, AMX_ERR_NATIVE, "Invalid %s offset. Native %s is disabled", #member, __FUNCTION__);\
			return 0;																\
		}																			\
		member = type.fieldOffset;                                                  \
	}

#define GET_SIGNATURE(name, function)												\
	static void *function = nullptr;												\
	if (!function)																	\
	{																				\
		if (!MainConfig || !MainConfig->GetMemSig(name, &function) || !function)	\
		{																			\
			MF_LogError(amx, AMX_ERR_NATIVE, "Invalid %s signature. Native %s is disabled", name, __FUNCTION__);\
			return 0;																\
		}																			\
	}

// reTS, the source rebuild of The Specialists 3.0, keeps the player state TSX reads at no offset the
// gamedata knows and exports ReTS_GetInterface (rets_api.h) for it instead. ReTS() is that interface
// when the game library exports it, else NULL: the natives then read TS 3.0's members by gamedata.
const rets_interface_t *ReTS();

// On reTS a native that needs a function this reTS leaves NULL refuses, as reTSX does.
#define RETS_REQUIRE(rets, fn)														\
	if (!(rets)->fn)																\
	{																			\
		MF_LogError(amx, AMX_ERR_NATIVE, "Native %s is not supported by this reTS", __FUNCTION__);\
		return 0;																	\
	}

void UpdateSpeed(CPlayer *pPlayer);
void EndSpeed(CPlayer *pPlayer);

bool isModuleActive();
bool ignoreBots (edict_t *pEnt, edict_t *pOther = NULL);

#endif //TSX_H


