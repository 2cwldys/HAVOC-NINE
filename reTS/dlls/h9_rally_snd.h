/***
*  h9_rally_snd.h -- the sounds of a player who is a car (rally mode, H9): the arithmetic, with no engine.
*  dlls/h9_rally_snd.cpp plays them; dlls/tests/rally_test.cpp drives this file alone.
*
*  The same set as the old vehicle's (dlls/h9_car.cpp, whose defines below are copied, not shared: that file is frozen),
*  but the revs come from a gearbox, as HL Rally's cars have: six gears over the car's real speed range (the road's top
*  speed, race_rally.h's RaceRallyTopSpeed: 680 for the Xsara; sand and snow top out near 340, neutral ground near 408,
*  which is gear 4 and 5 of six). Within a gear the revs rise with the speed, at each shift they drop.
***/
#pragma once

#include "race_rally.h" // H9RALLY_MATHS_ONLY: pm_shared/h9_rally.h's tuning table, RaceRallyDriveOf, RaceRallyTopSpeed

// ---- copied from dlls/h9_car.cpp (same values, same names with an RSND prefix) ----
#define RSND_PITCH_IDLE 60       // the engine loop's pitch (100 = as recorded) at idle revs
#define RSND_PITCH_TOP 200       // and flat out
#define RSND_GAP 0.1f            // seconds between two sound-change messages of one player (10 a second)
#define RSND_PITCH_STEP 2        // a pitch change smaller than this is not sent
#define RSND_VOL_STEP 0.04f      // nor a volume change smaller than this
#define RSND_START_TIME 0.95f    // seconds the starter sample runs before the engine loop takes over
#define RSND_SKID_SPEED 120.0f   // the least speed a slip-skid starts at (it holds to half of it)
#define RSND_SKID_ON 0.25f       // the slip at which the skid loop starts
#define RSND_SKID_OFF 0.15f      // and under which it stops
#define RSND_SKID_SWAP 0.3f      // the least seconds before a skid loop is swapped for another surface's
#define RSND_BACKFIRE_SPEED 0.6f // a pop needs this share of top speed when the throttle is let go
#define RSND_BACKFIRE_CHANCE 0.6f
#define RSND_BACKFIRE_GAP 1.5f
#define RSND_HORN_GAP 0.6f
#define RSND_HIT_GAP 0.25f
#define RSND_SPLASH_SPEED 150.0f
#define RSND_SPLASH_GAP 1.0f
#define RSND_LAND_MIN 250.0f     // h9_car's H9CAR_LAND: down speed a landing thump needs
// ---- ours ----
#define RSND_HAND_SPEED 80.0f    // the handbrake skids from this speed (it holds to half of it)
#define RSND_HIT_MIN 100.0f      // the speed one frame must take off the car, on the ground, for a wall hit (u/s)
#define RSND_HIT_SHARE 0.2f      // and this share of the speed it had
#define RSND_REV_UP 5.0f         // revs a second the smoothed revs gain
#define RSND_REV_DOWN 6.0f       // and lose (a shift's drop is heard)
#define RSND_COAST 0.8f          // coasting revs are this share of the throttle's
#define RSND_LAUNCH 0.35f        // revs of the throttle pressed at a standstill
#define RSND_SHIFT_DROP 0.35f    // revs just after a shift (the first gear starts at 0)
#define RSND_GEARS 6

// The speed at which each gear ends, as a share of the top speed: the lower gears are shorter.
static const float g_rsndGearEnd[RSND_GEARS] = {0.12f, 0.25f, 0.38f, 0.52f, 0.72f, 1.0f};

// The gear (0..5) for a speed, and how far through it (0..1) the speed is.
static inline int RallySndGear(float speed, float top, float* frac)
{
	if (speed < 0)
		speed = -speed;
	const float share = top > 1 ? speed / top : 0;
	float lo = 0;
	for (int g = 0; g < RSND_GEARS; g++)
	{
		const float hi = g_rsndGearEnd[g];
		if (share < hi || g == RSND_GEARS - 1)
		{
			if (frac)
				*frac = H9RClamp((share - lo) / (hi - lo), 0.0f, 1.0f);
			return g;
		}
		lo = hi;
	}
	return RSND_GEARS - 1;
}

// The revs wanted (0 idle .. 1 flat out): the gear's share, lower while coasting, up to a launch's with the throttle
// pressed at a standstill. `speed` is the car's speed over the ground (either way), `top` RaceRallyTopSpeed.
static inline float RallySndRevs(float speed, float top, bool throttle)
{
	float frac = 0;
	const int gear = RallySndGear(speed, top, &frac);
	float revs = gear == 0 ? frac : RSND_SHIFT_DROP + (1.0f - RSND_SHIFT_DROP) * frac;
	if (!throttle)
		return revs * RSND_COAST;
	const float a = speed < 0 ? -speed : speed;
	if (a < 25.0f) // the throttle at a standstill revs the engine, the less as the car gets going
	{
		const float launch = RSND_LAUNCH * (1.0f - a / 25.0f);
		if (revs < launch)
			revs = launch;
	}
	return revs;
}

static inline float RallySndApproach(float target, float value, float dt)
{
	const float step = (target > value ? RSND_REV_UP : RSND_REV_DOWN) * dt;
	if (value < target)
		return value + step < target ? value + step : target;
	return value - step > target ? value - step : target;
}

static inline int RallySndPitch(float revs)
{
	return RSND_PITCH_IDLE + (int)((RSND_PITCH_TOP - RSND_PITCH_IDLE) * H9RClamp(revs, 0.0f, 1.0f) + 0.5f);
}

// A little lower when coasting.
static inline float RallySndVolume(float revs, bool throttle)
{
	const float v = 0.45f + 0.45f * H9RClamp(revs, 0.0f, 1.0f);
	return throttle ? v : v * 0.85f;
}

// The skid loop for a surface byte (race_rally.h's RaceSurfaceByte): 0 hard ground, 1 loose ground, 2 snow and ice.
// Those are the three files, skid_tarmac, skid_gravel and skid_snow.
static inline int RallySndSkidKind(int surfaceByte)
{
	switch (surfaceByte)
	{
	case 0: return 0;                    // road, concrete, metal, neutral
	case 4: case 5: case 6: return 2;    // water, snow, ice
	default: return 1;                   // gravel, dirt, grass (sand and packed dirt are dirt)
	}
}

// Is the skid on? A slide (slip over the on level, off under the off level: the gap is a hysteresis) above a speed, or
// the handbrake above a smaller one, on the ground. `slip` is RaceRallyDrive's, 0..1.
static inline bool RallySndSkid(bool playing, bool grounded, float speed, float slip, bool hand)
{
	if (!grounded)
		return false;
	const float k = playing ? 0.5f : 1.0f;
	if (hand && speed > RSND_HAND_SPEED * k)
		return true;
	return speed > RSND_SKID_SPEED * k && slip > (playing ? RSND_SKID_OFF : RSND_SKID_ON);
}

// The skid's volume and pitch from its slip and speed (h9_car's).
static inline float RallySndSkidVolume(float slip, float speed, bool hand)
{
	float s = slip;
	if (hand && s < 0.4f)
		s = 0.4f;
	return H9RClamp((0.25f + 0.65f * H9RClamp((s - RSND_SKID_OFF) / 0.6f, 0.0f, 1.0f)) * H9RClamp(speed / 400.0f, 0.35f, 1.0f), 0.0f, 0.95f);
}
static inline int RallySndSkidPitch(float speed, float top)
{
	return 90 + (int)(25 * H9RClamp(top > 1 ? speed / top : 0, 0.0f, 1.0f));
}

// A wall: one frame took `lost` u/s off a car that went `before` u/s, on the ground. The volume of the hit, 0 for none.
static inline float RallySndHitVolume(float before, float lost)
{
	if (lost < RSND_HIT_MIN || lost < before * RSND_HIT_SHARE)
		return 0;
	return H9RClamp(0.4f + (lost - RSND_HIT_MIN) / 400.0f * 0.6f, 0.4f, 1.0f);
}

// A landing: `down` u/s of falling speed just before the ground. The volume of the thump, 0 for none.
static inline float RallySndLandVolume(float down)
{
	if (down <= RSND_LAND_MIN)
		return 0;
	return H9RClamp(0.45f + (down - RSND_LAND_MIN) / 1000.0f * 0.55f, 0.45f, 1.0f);
}

// A change of pitch or volume is worth a message.
static inline bool RallySndWorthSending(int pitch, int sentPitch, float vol, float sentVol, int pitchStep, float volStep)
{
	return (pitch > sentPitch ? pitch - sentPitch : sentPitch - pitch) >= pitchStep ||
		   (vol > sentVol ? vol - sentVol : sentVol - vol) >= volStep;
}

// ---- the engine's side (h9_rally_snd.cpp) ----
class CBasePlayer;
void H9RallySoundPrecache();                           // ClientPrecache: our sounds that are on disk (and the stock stand-ins)
void H9RallySoundThink(CBasePlayer* pl, int carClass); // each frame of a player in rally mode (carClass 1..3)
void H9RallySoundStop(CBasePlayer* pl);                // everything of his stops: left the mode, died, disconnected
