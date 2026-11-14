/***
*  h9_rally_srv.cpp -- the server's side of rally mode (H9): the cvar and the per-player switch.
*
*  h9_rally 0 is off (the default). 1, 2 or 3 turns on rally mode for every player, who then drives as that car
*  class (pm_shared/h9_rally.h's table: 1 rally, 2 sprint, 3 heavy): the player IS the car, moved by pmove on both
*  sides (pm_shared/h9_rally.cpp). The only thing the client needs from here is the physinfo key "rally", which the
*  engine sends in the client data. Each frame this makes the player's state match the cvar: the key, no weapons, the
*  car's size for other entities, and, when the mode goes off, the standing size and a lift out of the floor.
*  A race map in rally mode (race.cpp) asks for class 1 through RaceRallyClass() when the cvar is 0. The grid, the
*  holds and the car's model are the race's (race.cpp), not this file's.
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "player.h"
#include "h9_rally_srv.h"
#include "h9_rally_snd.h"
#include "h9_rally_car.h"
#include "race.h"

float GetSpeedBySlots(CBasePlayer* pPlayer); // ts_gun.cpp

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static cvar_t h9_rally = {"h9_rally", "0", FCVAR_SERVER};
// 1: each rally player's movement prints one line every half second to the server console (pm_shared/h9_rally.cpp, DebugLine).
// pmove reaches no cvar of ours, so the flag goes to it in the physinfo key "rdbg", as "rally" does.
static cvar_t h9_rally_debug = {"h9_rally_debug", "0", 0};

// What a car is told its speed limit is: nothing of The Specialists' loadout (SetPlayerSpeed: 0..330) may clamp it. Rally's own
// movement does not read maxspeed (the wish speed is the car's stat), but PM_CheckParamters scales the command by it first.
#define H9RALLY_MAXSPEED 3000.0f // HL Rally's sv_maxspeed

void H9RallyRegisterCvars()
{
	CVAR_REGISTER(&h9_rally);
	CVAR_REGISTER(&h9_rally_debug);
}

int H9RallyCvarClass()
{
	const int v = (int)h9_rally.value;
	return v < 0 ? 0 : (v > 3 ? 3 : v);
}

// The class asked for: the cvar's, else the one a race map in rally mode (race_rules `vehicle "rally"`) gives, else off.
static int WantedClass()
{
	const int v = H9RallyCvarClass();
	return v > 0 ? v : RaceRallyClass();
}

// A number in this player's physinfo (0 when the key is not there).
static int PhysInt(edict_t* ent, const char* key)
{
	char* info = (char*)g_engfuncs.pfnGetPhysicsInfoString(ent);
	const char* v = g_engfuncs.pfnInfoKeyValue(info, key);
	return v ? atoi(v) : 0;
}

// The class this player's physinfo says he is in.
static int CurrentClass(edict_t* ent)
{
	return PhysInt(ent, "rally");
}

void H9RallyServerThink(CBasePlayer* pl)
{
	const int want = WantedClass();
	const int cur = CurrentClass(pl->edict());

	if (want == cur && want == 0)
	{
		H9RallySoundStop(pl); // cheap when nothing plays
		return;
	}

	entvars_t* pev = pl->pev;
	if (want != cur)
	{
		char buf[8];
		snprintf(buf, sizeof buf, "%d", want);
		g_engfuncs.pfnSetPhysicsKeyValue(pl->edict(), "rally", buf);
		if (cur == 0 && want != 0)
		{
			pev->flags &= ~FL_DUCKING;
			pev->velocity = Vector(0, 0, 0);
			pev->friction = 1.0f; // a stunt's friction stays on a player in multiplayer, and the car's pull is x friction
		}
		else if (want == 0)
		{
			// out of the car: the standing hull's origin is 36 above the floor the car's origin was on
			UTIL_SetSize(pev, VEC_HULL_MIN, VEC_HULL_MAX);
			UTIL_SetOrigin(pev, pev->origin + Vector(0, 0, 36));
			pev->view_ofs = VEC_VIEW;
			pev->viewmodel = 0; // the interior's model is not a weapon's
			pl->SetPlayerSpeed(GetSpeedBySlots(pl)); // the loadout's speed again (a car's maxspeed is 3000)
			H9RallySoundStop(pl); // the mode went off (the cvar to 0, or the race's vehicle changed): no loop is left
			return;
		}
	}

	// the debug line's switch
	const int wantDebug = h9_rally_debug.value != 0 ? 1 : 0;
	if (PhysInt(pl->edict(), "rdbg") != wantDebug)
		g_engfuncs.pfnSetPhysicsKeyValue(pl->edict(), "rdbg", wantDebug ? "1" : "0");

	// nothing of the loadout holds a car: a sane maxspeed for pev and for the client's prediction (a player with every item
	// gone can be left with 0, and TS only sets it on loadout events). The slow motion's factor (fuser1) is ignored by pmove.
	if (pev->maxspeed != H9RALLY_MAXSPEED)
	{
		pev->maxspeed = H9RALLY_MAXSPEED;
		g_engfuncs.pfnSetClientMaxspeed(pl->edict(), H9RALLY_MAXSPEED);
	}

	// in the car: no weapons, and the car's size for whatever else in the world touches the player
	if (pl->m_pActiveItem)
		pl->RemoveAllItems(false);
	// the view model slot holds the interior (a wheel, a speedometer and a rev counter drawn by the client) when its file is there, else nothing
	{
		const char* interior = H9RallyInteriorModel();
		pev->viewmodel = interior != nullptr ? MAKE_STRING(interior) : 0;
	}
	pev->weaponmodel = 0;
	if (pev->maxs.z != 16.0f || pev->maxs.x != 16.0f || pev->mins.z != 0.0f)
		UTIL_SetSize(pev, Vector(-16, -16, 0), Vector(16, 16, 16));

	// his sounds: the engine by gear, skids, landings, walls, the horn (h9_rally_snd.cpp)
	H9RallySoundThink(pl, want);
}
