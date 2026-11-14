/***
*  h9_rally_snd.h -- the sounds the SERVER plays for a player who is a car (rally mode, H9): the horn and the landing, the two HL Rally also has the
*  server play. Everything else (the engine, the whine, the squeal, the backfire, the wall, the race voices) is the client's, cl_dll/h9_rallysnd.cpp,
*  with the arithmetic in cl_dll/h9_rallysnd_calc.h: HL Rally plays them on the client every frame, and so does this.
*  dlls/h9_rally_snd.cpp plays these two; dlls/tests/rally_test.cpp drives this file alone.
*
*  HL Rally: the horn (+horn sets fuser2; dlls/rally_horn.cpp, every 0.09 s: if the key is held and fHornTime has passed, a message to everyone and
*  fHornTime = time + 1) repeats once a second while held, the first press at once. The landing (pm_shared/pm_shared.c:859) is
*  PM_PlaySound(CHAN_AUTO, "car_lands.wav", 0.2, ATTN_NORM, 0, 100) on every change from the air to the ground, whatever the speed.
***/
#pragma once

#define RSND_HORN_REPEAT 1.0f     // dlls/rally_horn.cpp: seconds between two horns while the key is held
#define RSND_ONESHOT_VOL 0.7843f  // HL Rally's fmodPlay3D: volume * vol * 200 on FMOD's 255 scale, 200/255, for a vol of 1
#define RSND_LAND_VOL 0.2f        // pm_shared.c:859
#define RSND_LAND_PITCH 100

// The horn, as rally_horn.cpp does it: `next` is fHornTime. True when the horn is to sound now.
static inline bool RallySndHornStep(bool held, float& next, float now)
{
	if (held && next < now)
	{
		next = now + RSND_HORN_REPEAT;
		return true;
	}
	return false;
}

// ---- the engine's side (h9_rally_snd.cpp) ----
class CBasePlayer;
void H9RallySoundPrecache();                           // ClientPrecache: the horn and the landing, each only when its file is on disk
void H9RallySoundThink(CBasePlayer* pl, int carClass); // each frame of a player in rally mode (carClass 1..3)
void H9RallySoundStop(CBasePlayer* pl);                // he leaves the mode, dies or disconnects: what he held is dropped
