/***
*  h9_rally_snd.cpp -- the sounds the server plays for a player who is a car (rally mode, H9): the horn and the landing. See h9_rally_snd.h.
*
*  The engine and every other car sound are on the client now (cl_dll/h9_rallysnd.cpp). The server cannot play an engine as HL Rally does: its sound
*  message carries a pitch of 0..255 percent (an engine of 22 kHz at HL Rally's top revs is 304), and a change of pitch only as often as the
*  server thinks and the network sends; the client's can change every frame.
*
*  The files are under sound/h9/rally/. A file is precached, and played, only when it is on disk; a missing one is silence, with no message.
*  Called from H9RallyServerThink (h9_rally_srv.cpp); ClientDisconnect drops a player's memory (H9RallySoundStop).
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "player.h"
#include "gamerules.h"
#include "h9_rally_snd.h"

#include <stdio.h>
#include <string.h>

namespace
{
const char* g_horn = NULL; // each is NULL when its file is not on disk
const char* g_land = NULL;

bool FileOnDisk(const char* path)
{
	int length = 0;
	byte* file = LOAD_FILE_FOR_ME((char*)path, &length);
	if (!file)
		return false;
	FREE_FILE(file);
	return true;
}

// The name when sound/<name> is on disk (and then precached), else NULL.
const char* Pick(const char* name)
{
	char path[160];
	snprintf(path, sizeof path, "sound/%s", name);
	if (!FileOnDisk(path))
		return NULL;
	PRECACHE_SOUND((char*)name);
	return name;
}

struct PlayerSnd
{
	bool active = false;
	bool wasGround = true;
	Vector prevOrigin;
	bool havePrev = false;
	float nextHorn = 0;
};
PlayerSnd g_snd[33];

PlayerSnd* Of(CBasePlayer* pl)
{
	const int i = ENTINDEX(pl->edict());
	return (i >= 1 && i <= 32) ? &g_snd[i] : NULL;
}
} // namespace

// Which files are there is read at every map's precache window, so a map without them costs two file reads.
void H9RallySoundPrecache()
{
	for (PlayerSnd& s : g_snd) // a new map: nobody has anything
		s = PlayerSnd();
	g_horn = Pick("h9/rally/horn.wav");
	g_land = Pick("h9/rally/car_lands.wav");
}

void H9RallySoundStop(CBasePlayer* pl)
{
	PlayerSnd* s = pl ? Of(pl) : NULL;
	if (s)
		*s = PlayerSnd();
}

void H9RallySoundThink(CBasePlayer* pl, int carClass)
{
	PlayerSnd* s = Of(pl);
	if (!s)
		return;
	entvars_t* pev = pl->pev;
	// not a car any more: a dead player, a spectator, the map's end
	if (!pl->IsAlive() || pev->iuser1 > 0 || g_fGameOver || carClass <= 0)
	{
		H9RallySoundStop(pl);
		return;
	}
	const float now = gpGlobals->time;
	const bool held = (pev->flags & FL_FROZEN) != 0; // the countdown: buttons are zero, nothing moves
	const bool grounded = (pev->flags & FL_ONGROUND) != 0 && pev->waterlevel < 2;

	if (!s->active) // the mode has just come on
	{
		*s = PlayerSnd();
		s->active = true;
		s->wasGround = grounded;
	}

	// a put-back or a teleport is not a landing
	const bool jumped = s->havePrev && (pev->origin - s->prevOrigin).Length() > 150.0f;
	s->prevOrigin = pev->origin;
	s->havePrev = true;

	// the horn: held, once at once and then every second (the horn key is IN_ATTACK2: nothing else to a car with no weapon; held zeroes it)
	if (g_horn && !held && RallySndHornStep((pev->button & IN_ATTACK2) != 0, s->nextHorn, now))
		EMIT_SOUND_DYN(pl->edict(), CHAN_WEAPON, g_horn, RSND_ONESHOT_VOL, ATTN_NORM, 0, PITCH_NORM);

	// the landing: every change from the air to the ground, the same sound every time (pm_shared.c:859)
	if (g_land && grounded && !s->wasGround && !jumped)
		EMIT_SOUND_DYN(pl->edict(), CHAN_AUTO, g_land, RSND_LAND_VOL, ATTN_NORM, 0, RSND_LAND_PITCH);
	s->wasGround = grounded;
}
