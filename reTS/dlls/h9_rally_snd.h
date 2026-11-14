/***
*  h9_rally_snd.h -- the sounds of a player who is a car (rally mode, H9): the arithmetic, with no engine.
*  dlls/h9_rally_snd.cpp plays them; dlls/tests/rally_test.cpp drives this file alone.
*
*  The same set as the old vehicle's (dlls/h9_car.cpp, whose defines below are copied, not shared: that file is frozen),
*  but the revs come from HL Rally's own automatic gearbox (up above 190, down below 120 or 80, on the speed x 3.25 over
*  gear x 2: the shifts are near 117 u/s a gear), its revs 15..250, its volume rule and a straight pitch line over the revs.
*  Within a gear the revs rise with the speed, at each shift they drop.
***/
#pragma once

#include "race_rally.h" // H9RALLY_MATHS_ONLY: pm_shared/h9_rally.h's tuning table, RaceRallyDriveOf, RaceRallyTopSpeed

// ---- copied from dlls/h9_car.cpp (same values, same names with an RSND prefix) ----
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
// ---- the gearbox: HL Rally's (cl_dll/Rally_Effects.cpp renderCalculateRPMs), as numbers; the code is ours ----
#define RSND_SPEED_TO_CS 3.25f   // HLR: its "current speed" is the ground speed x 3.25
#define RSND_GEARS 6
#define RSND_UP 190.0f           // HLR: shift up when cs / (gear * 2) is above this ...
#define RSND_DOWN 120.0f         // ... down when it is below this and cs is over RSND_DOWN_FAST_CS ...
#define RSND_DOWN_LOW 80.0f      // ... or, at or under RSND_DOWN_FAST_CS, below this (so the low gears do not toggle)
#define RSND_DOWN_FAST_CS 550.0f
#define RSND_MOVING_CS 5.0f      // HLR: at or under this the box is in neutral (gear 0)
#define RSND_RPM_MIN 15.0f       // HLR: the revs are kept between 15 and 250
#define RSND_RPM_MAX 250.0f
#define RSND_RPM_RISE 1100.0f    // HLR: revs a second with the throttle down off the ground (or in neutral)
#define RSND_RPM_FALL 400.0f     // HLR: revs a second lost with it up
#define RSND_RPM_DELTA 550.0f    // HLR: the most the revs follow the speed by, a second
// ---- ours: the pitch of engine_loop.wav (100 = the wav's own rate) over HL Rally's revs. HL Rally plays its sample at
// 2000 + 260 * rpm Hz, which is a straight line in the revs; that line is laid from pitch 60 at the lowest revs (15) to 200
// at the highest (250), so pitch 100 is at rpm 82: a car in first gear going 50 u/s, the sample's own rate (the old table
// had the sample's rate low in the first gear too). A gear's shifts are at 190 down to 95..158, so a shift is 30 to 60 points.
#define RSND_PITCH_IDLE 60
#define RSND_PITCH_TOP 200

struct RallySndGearbox
{
	int gear = 0;
	float rpm = RSND_RPM_MIN;
	float old = RSND_RPM_MIN;
};

// The automatic gearbox for one frame: the ground speed (u/s), the throttle, whether the wheels are on the ground, the frame's
// length. Moves `gear` (0..6) and `rpm` (15..250).
static inline void RallySndGearStep(RallySndGearbox& b, float speed, bool throttle, bool grounded, float dt)
{
	const float cs = (speed < 0 ? -speed : speed) * RSND_SPEED_TO_CS;
	if (b.gear > 0)
	{
		const float a = cs / ((float)b.gear * 2.0f);
		if (a > RSND_UP)
			b.gear++;
		else if (a < RSND_DOWN)
		{
			if (cs > RSND_DOWN_FAST_CS)
				b.gear--;
			else if (a < RSND_DOWN_LOW)
				b.gear--;
		}
	}
	if (b.gear > RSND_GEARS)
		b.gear = RSND_GEARS;
	if (b.gear < 1)
		b.gear = cs > RSND_MOVING_CS ? 1 : 0;

	float rpm = b.rpm;
	if (!grounded || b.gear == 0 || cs < RSND_MOVING_CS)
		rpm += (throttle ? RSND_RPM_RISE : -RSND_RPM_FALL) * dt; // the needle runs free
	else
		rpm = cs / ((float)b.gear * 2.0f); // on the ground the revs are the speed's
	if (rpm < RSND_RPM_MIN)
	{
		b.old = RSND_RPM_MIN;
		rpm = RSND_RPM_MIN;
	}
	else
	{
		if (rpm > RSND_RPM_MAX)
			rpm = RSND_RPM_MAX;
		// follow the target at most RSND_RPM_DELTA a second, and a quarter of the way a frame (HLR's average)
		float delta = rpm - b.old;
		const float cap = RSND_RPM_DELTA * dt;
		if (delta > cap)
			delta = cap;
		else if (delta < -cap)
			delta = -cap;
		rpm = (b.old + (b.old + delta) * 3.0f) * 0.25f;
		if (rpm < RSND_RPM_MIN)
			rpm = RSND_RPM_MIN;
		else if (rpm > RSND_RPM_MAX)
			rpm = RSND_RPM_MAX;
	}
	b.rpm = rpm;
	b.old = rpm;
}

// The sample's pitch (100 = as recorded) for the revs.
static inline int RallySndPitch(float rpm)
{
	const float t = H9RClamp((rpm - RSND_RPM_MIN) / (RSND_RPM_MAX - RSND_RPM_MIN), 0.0f, 1.0f);
	return RSND_PITCH_IDLE + (int)((RSND_PITCH_TOP - RSND_PITCH_IDLE) * t + 0.5f);
}

// HL Rally's volume in percent-like units: 40 + rpm / 2 on the throttle, 20 + rpm / 3 without; here over 150 as 0..1.
static inline float RallySndVolume(float rpm, bool throttle)
{
	const float v = throttle ? 40.0f + rpm * 0.5f : 20.0f + rpm * (1.0f / 3.0f);
	return H9RClamp(v / 150.0f, 0.15f, 0.95f);
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
