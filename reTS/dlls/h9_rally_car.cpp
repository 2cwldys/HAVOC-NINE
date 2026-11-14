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

#define H9_RALLY_CAR_MODEL "models/h9/rc_rally_xs.mdl"

void H9RallyCarPrecache()
{
	if (CVAR_GET_FLOAT("h9_rally") < 0.5f)
		return;
	int len = 0;
	byte* f = LOAD_FILE_FOR_ME((char*)H9_RALLY_CAR_MODEL, &len);
	if (f == nullptr)
		return;
	FREE_FILE(f);
	PRECACHE_MODEL((char*)H9_RALLY_CAR_MODEL);
}
