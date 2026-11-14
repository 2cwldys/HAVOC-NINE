/***
*  h9_rally_car.cpp -- rally mode (H9): the car's model for the clients.
*
*  A client draws a player that is a car as models/h9/rc_rally_xs.mdl (cl_dll/h9_rallycar.cpp). It finds the model by itself, so
*  nothing here is needed to draw; but a model the server precaches is one a client without the file is told about, and one a
*  client is certain to have loaded. Called from ClientPrecache() (the world's precache window), and only while h9_rally is on and
*  the file is there, so a game without the model, or without rally mode, is unchanged.
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "h9_rally_car.h"
#include "h9_rally_snd.h"

#define H9_RALLY_CAR_MODEL "models/h9/rc_rally_xs.mdl"
#define H9_RALLY_INTERIOR_MODEL "models/h9/rally_interior.mdl"
#define H9_RALLY_INTERIOR_CHROME "models/h9/rally_interior_chrome.mdl"

static bool s_interiorPrecached = false;

// True when the engine finds the file in the game folder or a fallback folder (a precache of a missing file stops the map).
static bool FileThere(const char* name)
{
	int len = 0;
	byte* f = LOAD_FILE_FOR_ME((char*)name, &len);
	if (f == nullptr)
		return false;
	FREE_FILE(f);
	return true;
}

const char* H9RallyInteriorModel() { return s_interiorPrecached ? H9_RALLY_INTERIOR_MODEL : nullptr; }

void H9RallyCarPrecache()
{
	// Always, not only while h9_rally is on: a race map in rally mode (race_rules vehicle "rally") has the cvar at 0 and
	// race_rules may not have spawned yet in this precache window. Only files that are on disk, so a game without
	// them, or a map that never uses rally mode, loses a few file reads.
	H9RallySoundPrecache();
	// the interior's model and its windscreen overlay: optional, each only when it is there (without the first the views skip the interior)
	s_interiorPrecached = false;
	if (FileThere(H9_RALLY_INTERIOR_MODEL))
	{
		PRECACHE_MODEL((char*)H9_RALLY_INTERIOR_MODEL);
		s_interiorPrecached = true;
		if (FileThere(H9_RALLY_INTERIOR_CHROME))
			PRECACHE_MODEL((char*)H9_RALLY_INTERIOR_CHROME);
	}
	if (!FileThere(H9_RALLY_CAR_MODEL))
		return;
	PRECACHE_MODEL((char*)H9_RALLY_CAR_MODEL);
}

// HL Rally's info_camera (dlls/player.cpp:5084-5099): an invisible point the TV camera sits at. The client reads the cameras from the map's own
// entity string (cl_dll/h9_rallycam_calc.h, TvParseCameras), so this only lets the entity exist on the server.
class CInfoCamera : public CPointEntity
{
public:
	void Spawn() override
	{
		UTIL_SetOrigin(pev, pev->origin);
		pev->solid = SOLID_NOT;
		pev->effects = EF_NODRAW;
		pev->v_angle = g_vecZero;
	}
};

LINK_ENTITY_TO_CLASS(info_camera, CInfoCamera);
