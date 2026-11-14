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
#include "race.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static cvar_t h9_rally = {"h9_rally", "0", FCVAR_SERVER};

void H9RallyRegisterCvars()
{
	CVAR_REGISTER(&h9_rally);
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

// The class this player's physinfo says he is in.
static int CurrentClass(edict_t* ent)
{
	char* info = (char*)g_engfuncs.pfnGetPhysicsInfoString(ent);
	const char* v = g_engfuncs.pfnInfoKeyValue(info, "rally");
	return v ? atoi(v) : 0;
}

void H9RallyServerThink(CBasePlayer* pl)
{
	const int want = WantedClass();
	const int cur = CurrentClass(pl->edict());

	if (want == cur && want == 0)
		return;

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
		}
		else if (want == 0)
		{
			// out of the car: the standing hull's origin is 36 above the floor the car's origin was on
			UTIL_SetSize(pev, VEC_HULL_MIN, VEC_HULL_MAX);
			UTIL_SetOrigin(pev, pev->origin + Vector(0, 0, 36));
			pev->view_ofs = VEC_VIEW;
			return;
		}
	}

	// in the car: no weapons, and the car's size for whatever else in the world touches the player
	if (pl->m_pActiveItem)
		pl->RemoveAllItems(false);
	pev->viewmodel = 0;
	pev->weaponmodel = 0;
	if (pev->maxs.z != 16.0f || pev->maxs.x != 16.0f || pev->mins.z != 0.0f)
		UTIL_SetSize(pev, Vector(-16, -16, 0), Vector(16, 16, 16));
}
