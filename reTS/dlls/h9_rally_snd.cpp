/***
*  h9_rally_snd.cpp -- the sounds of a player who is a car (rally mode, H9). The same set as dlls/h9_car.cpp's, on the
*  player: the engine loop by gear, the skid loops by surface, a pop, the horn, a landing, a wall, a splash, the
*  starter. The arithmetic is h9_rally_snd.h's. Called from H9RallyServerThink (h9_rally_srv.cpp), which stops them when
*  the mode goes off or he dies; ClientDisconnect stops them too.
*
*  Channels (an entity's own, so one player's sounds do not touch another's). The engine is CHAN_STATIC and the skid is
*  CHAN_STREAM: nothing of The Specialists' player uses either, so a pain grunt (CHAN_VOICE), a wade or swim sound
*  (CHAN_VOICE, CHAN_BODY), a splat (CHAN_ITEM) or a weapon (CHAN_WEAPON) never cuts a loop. The horn is CHAN_WEAPON (he
*  has no weapon in the car); the starter CHAN_ITEM (as h9_car's); landings, hits, splash and pops CHAN_AUTO. All at
*  ATTN_NORM: the driver's own client plays his entity's sounds at full volume wherever the camera is, the others hear
*  them fall off with the distance.
*
*  A sound file is used when it is on disk (sound/h9/race/, made by h9-maps art/race/rc-sounds.mjs), else a stock one
*  where there is one that will do, else nothing, as h9_car does.
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "player.h"
#include "gamerules.h"
#include "h9_rally_snd.h"

#include <stdio.h>
#include <string.h>
#include <math.h>

namespace
{
const char* g_engine = NULL; // the loop
const char* g_start = NULL;
const char* g_land = NULL;
const char* g_hit[2] = {NULL, NULL};
const char* g_skid[3] = {NULL, NULL, NULL}; // hard, loose, snow
const char* g_backfire[2] = {NULL, NULL};
const char* g_horn = NULL;
const char* g_splash = NULL;

bool FileOnDisk(const char* path)
{
	int length = 0;
	byte* file = LOAD_FILE_FOR_ME((char*)path, &length);
	if (!file)
		return false;
	FREE_FILE(file);
	return true;
}

// The name when sound/<name> is on disk, else the stand-in (may be NULL). The one chosen is precached.
const char* Pick(const char* name, const char* standIn)
{
	char path[160];
	snprintf(path, sizeof path, "sound/%s", name);
	const char* use = FileOnDisk(path) ? name : standIn;
	if (use)
		PRECACHE_SOUND((char*)use);
	return use;
}

struct PlayerSnd
{
	bool active = false;
	// the engine
	bool loop = false;
	float loopAt = 0; // the engine loop starts then (after the starter), or at once on a throttle press
	float revs = 0;
	int sentPitch = 0;
	float sentVol = 0;
	// the skid
	int skid = -1;
	float skidSince = 0;
	int skidPitch = 0;
	float skidVol = 0;
	bool skidTurn = false;
	// the road
	int surface = 0;
	float nextLook = 0;
	// one frame to the next
	float prevSpeed = 0;
	float fallSpeed = 0; // the fastest fall since he left the ground
	bool wasGround = true;
	bool wasWet = false;
	bool wasThrottle = false;
	bool hornDown = false;
	Vector prevOrigin;
	bool havePrev = false;
	float nextSound = 0, nextHorn = 0, nextBackfire = 0, nextHit = 0, nextSplash = 0;
};
PlayerSnd g_snd[33];

PlayerSnd* Of(CBasePlayer* pl)
{
	const int i = ENTINDEX(pl->edict());
	return (i >= 1 && i <= 32) ? &g_snd[i] : NULL;
}

void Emit(CBasePlayer* pl, int chan, const char* name, float vol, int pitch)
{
	if (name)
		EMIT_SOUND_DYN(pl->edict(), chan, name, vol, ATTN_NORM, 0, pitch);
}
} // namespace

// Which files are there is read at every map's precache window, so a map without them costs a handful of file reads.
void H9RallySoundPrecache()
{
	for (PlayerSnd& s : g_snd) // a new map: nobody is playing anything
		s = PlayerSnd();
	g_engine = Pick("h9/race/engine_loop.wav", "plats/ttrain2.wav");
	g_start = Pick("h9/race/start.wav", "plats/vehicle_ignition.wav");
	g_land = Pick("h9/race/land.wav", "plats/ttrain_brake1.wav");
	g_hit[0] = Pick("h9/race/hit1.wav", "debris/metal2.wav");
	g_hit[1] = Pick("h9/race/hit2.wav", g_hit[0]);
	g_skid[0] = Pick("h9/race/skid_tarmac.wav", NULL); // no stock skid: silent without ours
	g_skid[1] = Pick("h9/race/skid_gravel.wav", NULL);
	g_skid[2] = Pick("h9/race/skid_snow.wav", NULL);
	g_backfire[0] = Pick("h9/race/backfire1.wav", NULL);
	g_backfire[1] = Pick("h9/race/backfire2.wav", g_backfire[0]);
	g_horn = Pick("h9/race/horn.wav", NULL);
	g_splash = Pick("h9/race/splash.wav", NULL);
}

void H9RallySoundStop(CBasePlayer* pl)
{
	PlayerSnd* s = pl ? Of(pl) : NULL;
	if (!s || !s->active) // nothing of his plays
		return;
	if (g_engine)
		STOP_SOUND(pl->edict(), CHAN_STATIC, g_engine);
	for (int k = 0; k < 3; k++)
		if (g_skid[k])
			STOP_SOUND(pl->edict(), CHAN_STREAM, g_skid[k]);
	*s = PlayerSnd();
}

static int SurfaceUnder(CBasePlayer* pl)
{
	entvars_t* pev = pl->pev;
	if (pev->waterlevel >= 1)
		return RaceSurfaceByte(H9RS_NEUTRAL, true);
	TraceResult tr;
	UTIL_TraceLine(pev->origin + Vector(0, 0, 1), pev->origin - Vector(0, 0, 64), ignore_monsters, pl->edict(), &tr);
	const char* name = NULL;
	if (tr.flFraction < 1.0f)
	{
		edict_t* hit = tr.pHit && !FNullEnt(tr.pHit) ? tr.pHit : ENT(0);
		name = TRACE_TEXTURE(hit, pev->origin + Vector(0, 0, 1), pev->origin - Vector(0, 0, 64));
		if (!name && hit != ENT(0))
			name = TRACE_TEXTURE(ENT(0), pev->origin + Vector(0, 0, 1), pev->origin - Vector(0, 0, 64));
	}
	if (name && (*name == '-' || *name == '+') && name[1])
		name += 2;
	return RaceSurfaceByte(H9RallySurfaceByName(name), false);
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
	float dt = gpGlobals->frametime;
	if (dt <= 0 || dt > 0.1f)
		dt = 0.05f;
	const bool held = (pev->flags & FL_FROZEN) != 0; // the countdown: buttons are zero, nothing moves

	if (!s->active) // the mode has just come on: the starter, then the loop
	{
		*s = PlayerSnd();
		s->active = true;
		s->loopAt = now + RSND_START_TIME;
		Emit(pl, CHAN_ITEM, g_start, 0.8f, PITCH_NORM);
	}

	const float top = RaceRallyTopSpeed(carClass);
	const float speed = sqrtf(pev->velocity.x * pev->velocity.x + pev->velocity.y * pev->velocity.y);
	const bool wet = pev->waterlevel >= 1;
	const bool grounded = (pev->flags & FL_ONGROUND) != 0 && pev->waterlevel < 2;
	const bool throttle = !held && (pev->button & IN_FORWARD) != 0;
	const bool back = !held && (pev->button & IN_BACK) != 0;
	const bool hand = !held && (pev->button & IN_JUMP) != 0;

	// a put-back or a teleport is not a crash
	const bool jumped = s->havePrev && (pev->origin - s->prevOrigin).Length() > 150.0f;
	s->prevOrigin = pev->origin;
	s->havePrev = true;
	if (jumped)
	{
		s->prevSpeed = speed;
		s->fallSpeed = 0;
		s->wasGround = grounded;
		s->wasWet = wet;
	}

	if (now >= s->nextLook || now < s->nextLook - 1.0f)
	{
		s->nextLook = now + 0.25f;
		s->surface = SurfaceUnder(pl);
	}

	// the horn: a press, once per RSND_HORN_GAP (IN_ATTACK2 is nothing else to a car with no weapon; held zeroes it)
	const bool horn = (pev->button & IN_ATTACK2) != 0;
	if (horn && !s->hornDown && g_horn && now >= s->nextHorn)
	{
		s->nextHorn = now + RSND_HORN_GAP;
		Emit(pl, CHAN_WEAPON, g_horn, 1.0f, PITCH_NORM);
	}
	s->hornDown = horn;

	// the landing, and the wall
	if (!grounded)
		s->fallSpeed = fmaxf(s->fallSpeed, -pev->velocity.z);
	bool landed = false;
	if (grounded && !s->wasGround && !jumped)
	{
		landed = true;
		const float v = RallySndLandVolume(s->fallSpeed);
		if (v > 0)
			Emit(pl, CHAN_AUTO, g_land, v, v > 0.8f ? 90 : 100 + RANDOM_LONG(0, 20));
	}
	if (grounded)
		s->fallSpeed = 0;
	if (grounded && s->wasGround && !landed && !held && !jumped && now >= s->nextHit)
	{
		const float v = RallySndHitVolume(s->prevSpeed, s->prevSpeed - speed);
		if (v > 0)
		{
			s->nextHit = now + RSND_HIT_GAP;
			Emit(pl, CHAN_AUTO, g_hit[RANDOM_LONG(0, 1)], v, 90 + RANDOM_LONG(0, 20));
		}
	}
	// the splash: the wheels first in the water at speed
	if (wet && !s->wasWet && g_splash && speed > RSND_SPLASH_SPEED && now >= s->nextSplash)
	{
		s->nextSplash = now + RSND_SPLASH_GAP;
		Emit(pl, CHAN_AUTO, g_splash, H9RClamp(0.5f + speed / 800.0f, 0.5f, 1.0f), 90 + RANDOM_LONG(0, 20));
	}
	s->wasGround = grounded;
	s->wasWet = wet;
	s->prevSpeed = speed;

	// a pop: the throttle let go at speed
	if (s->wasThrottle && !throttle && !back && grounded && g_backfire[0] && speed > RSND_BACKFIRE_SPEED * top &&
		now >= s->nextBackfire && RANDOM_FLOAT(0, 1) < RSND_BACKFIRE_CHANCE)
	{
		s->nextBackfire = now + RSND_BACKFIRE_GAP;
		Emit(pl, CHAN_AUTO, g_backfire[RANDOM_LONG(0, 1)], RANDOM_FLOAT(0.7f, 0.95f), 90 + RANDOM_LONG(0, 30));
	}
	s->wasThrottle = throttle;

	// the revs, from the gearbox
	const float target = RallySndRevs(speed, top, throttle);
	s->revs = RallySndApproach(target, s->revs, dt);
	const int pitch = RallySndPitch(s->revs);
	const float vol = RallySndVolume(s->revs, throttle);

	if (!s->loop && g_engine && (now >= s->loopAt || throttle))
	{
		EMIT_SOUND_DYN(pl->edict(), CHAN_STATIC, g_engine, vol, ATTN_NORM, 0, pitch);
		s->loop = true;
		s->sentPitch = pitch;
		s->sentVol = vol;
	}

	// the skid loop
	const int kind = RallySndSkidKind(s->surface);
	const RaceRallyDrive d = RaceRallyDriveOf(pev->velocity.x, pev->velocity.y, pev->v_angle.y, !grounded, back, hand, s->surface);
	const bool wantSkid = RallySndSkid(s->skid >= 0, grounded, speed, d.slip, hand);
	const float skidVol = RallySndSkidVolume(d.slip, speed, hand);
	const int skidPitch = RallySndSkidPitch(speed, top);
	if (s->skid >= 0)
	{
		if (!wantSkid)
		{
			STOP_SOUND(pl->edict(), CHAN_STREAM, g_skid[s->skid]);
			s->skid = -1;
		}
		else if (kind != s->skid && g_skid[kind] && now >= s->skidSince + RSND_SKID_SWAP)
		{
			STOP_SOUND(pl->edict(), CHAN_STREAM, g_skid[s->skid]);
			EMIT_SOUND_DYN(pl->edict(), CHAN_STREAM, g_skid[kind], skidVol, ATTN_NORM, 0, skidPitch);
			s->skid = kind;
			s->skidSince = now;
			s->skidVol = skidVol;
			s->skidPitch = skidPitch;
		}
	}
	else if (wantSkid && g_skid[kind])
	{
		EMIT_SOUND_DYN(pl->edict(), CHAN_STREAM, g_skid[kind], skidVol, ATTN_NORM, 0, skidPitch);
		s->skid = kind;
		s->skidSince = now;
		s->skidVol = skidVol;
		s->skidPitch = skidPitch;
	}

	// pitch and volume changes: one message at most per RSND_GAP, the engine's and the skid's taking turns
	const bool engineChange = s->loop && RallySndWorthSending(pitch, s->sentPitch, vol, s->sentVol, RSND_PITCH_STEP, RSND_VOL_STEP);
	const bool skidChange = s->skid >= 0 && RallySndWorthSending(skidPitch, s->skidPitch, skidVol, s->skidVol, RSND_PITCH_STEP * 2, RSND_VOL_STEP * 1.5f);
	if (now >= s->nextSound && (engineChange || skidChange))
	{
		const bool skid = skidChange && (!engineChange || s->skidTurn);
		s->nextSound = now + RSND_GAP;
		s->skidTurn = !skid;
		if (skid)
		{
			EMIT_SOUND_DYN(pl->edict(), CHAN_STREAM, g_skid[s->skid], skidVol, ATTN_NORM, SND_CHANGE_PITCH | SND_CHANGE_VOL, skidPitch);
			s->skidPitch = skidPitch;
			s->skidVol = skidVol;
		}
		else
		{
			EMIT_SOUND_DYN(pl->edict(), CHAN_STATIC, g_engine, vol, ATTN_NORM, SND_CHANGE_PITCH | SND_CHANGE_VOL, pitch);
			s->sentPitch = pitch;
			s->sentVol = vol;
		}
	}
}
