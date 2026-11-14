/***
*  h9_rally.h -- "rally mode": the player IS the car (H9). The handling maths, its tuning table and the
*  surface-by-texture-name rules. This file knows nothing of the engine: dlls/tests/rally_test.cpp compiles it
*  alone and drives it. The part that moves the player through the world is pm_shared/h9_rally.cpp.
*
*  The method follows HL Rally's (a player who drives is moved by pmove itself, so the server runs it and the
*  client predicts it, with no input lag; the car's heading is the player's view yaw; two speeds, along the nose
*  and across it, with the sideways one eaten by a friction that depends on the surface, on the pedals and on how
*  far the car already slides; a handbrake that lets that friction go; the texture under the car picks the
*  surface). The code, the structure, the names and every comment are ours, written from reading how it behaves,
*  not copied from it. HL Rally's source carries no licence, so nothing of it is in this file.
*
*  Units are Half-Life's (units, units a second). Left is positive: a heading's yaw grows to the left, and the
*  sideways speed `side` is positive to the left of the nose.
*
*  Everything the movement needs from one frame to the next is the player's own velocity, origin and view yaw,
*  which the engine already carries and predicts. Nothing is kept in a static or in an iuser/fuser/vuser field.
*  The only thing the server tells the client is the physinfo key "rally" (a car class number, 0 off).
***/
#pragma once

#include <math.h>
#include <string.h>

// ------------------------------------------------------------------------------------------------------------
//  THE TUNING TABLE. Every number that changes how the car drives is in this block.
// ------------------------------------------------------------------------------------------------------------

// What every car shares.
#define H9R_TRACTION 1100.0f    // u/s^2 of push (any direction) the tyres give at grip 1.0 (the traction circle's radius)
#define H9R_GRIP_AT_TOP 0.75f   // the share of the tyres' hold left at top speed: grip eases with speed
#define H9R_TAPER 0.35f         // the engine's pull falls off linearly over the last this-much of the top speed
#define H9R_COAST 50.0f         // u/s^2, the slowing with the throttle up ...
#define H9R_COAST_LIN 0.12f     // ... plus this much per second of the speed (engine braking, air)
#define H9R_BRAKE_TRACTION 0.95f // the brakes and the engine can use this much of the traction circle
#define H9R_REVERSE_PULL 0.55f  // reverse's pull, as a share of the engine's
#define H9R_REVERSE_ENTER 30.0f // S held at less than this speed forward stops braking and starts reversing
#define H9R_HAND_LAT 0.10f      // the sideways hold that is left with the handbrake on (HL Rally: 0.05)
#define H9R_HAND_BRAKE 260.0f   // u/s^2 the handbrake slows the car along its path, times the surface's grip
#define H9R_BRAKE_LAT 0.70f     // the sideways hold with the brake pedal down (the weight is forward, tyres lock)
#define H9R_SLIDE_LAT 0.70f     // the sideways hold once the car slides all the way (slip angle past ~50 degrees)
#define H9R_LAT_FLOOR 0.20f     // power never takes more than this share of the sideways hold away
#define H9R_STEER_MIN 0.35f     // the steering a standing car has, as a share of the full rate
#define H9R_STEER_FULL_SPEED 140.0f // speed at which the steering is full
#define H9R_STEER_AT_TOP 0.45f  // the steering left at top speed, as a share (a driver gives less lock)
#define H9R_STEER_HAND 1.7f     // the handbrake lets the tail round: steering is this much quicker, and does not ease
#define H9R_STEER_SLIDE 0.65f   // a sliding car's steering loses up to this share ...
#define H9R_STEER_SLIDE_FROM 25.0f // ... between this slip angle (degrees) and 45 degrees more
#define H9R_STEER_ICE 0.65f     // front wheels on a surface with no grip turn the car less (scale on mu below 1)

// Air, landing, water, walls, slopes.
#define H9R_AIR_DRAG 0.03f      // 1/s lost in the air
#define H9R_AIR_STEER 0.30f     // the share of the steering that works in the air
#define H9R_STICK_NORMAL 130.0f // u/s a car may lift off the ground's normal before it is airborne (a crest throws it)
#define H9R_STEP_UP 8.0f        // the highest kerb the car drives up without stopping (the body check is above it)
#define H9R_LAND_LOSS 0.00020f  // the speed lost on landing: this much per u/s of the impact above H9R_LAND_SOFT, as a share
#define H9R_LAND_SOFT 220.0f
#define H9R_LAND_MAX 0.30f      // at most this share of the speed
#define H9R_WALL_BOUNCE 0.18f   // how much of the speed into a wall comes back out
#define H9R_WALL_SCRAPE 0.55f   // the share of the along-wall speed kept when hit square (a glancing hit keeps nearly all)
#define H9R_WATER_WHEELS_DRAG 1.1f // 1/s extra drag, wheels in water
#define H9R_WATER_DEEP_DRAG 2.6f   // 1/s drag with the body in water
#define H9R_WATER_DEEP_GRAV 0.25f  // gravity's share on a car floating (it sinks slowly)

// The body, for the ground's tilt and for what a wall can touch. HL Rally's car is 45 long, 18 wide, 16 high.
#define H9R_LENGTH 45.0f
#define H9R_WIDTH 18.0f
#define H9R_HEIGHT 16.0f
#define H9R_VIEW_HEIGHT 14.0f   // the eye above the wheels' ground, until the chase camera of the car model takes over

// The cars. The class number is the physinfo value ("rally" "1" is the first), top speeds in HL Rally's range.
struct H9RallyCar
{
	const char* name;
	float top;       // u/s on tarmac, the most the engine takes the car to
	float engine;    // u/s^2, the pull from rest
	float brake;     // u/s^2 the brakes slow the car at the tyres' limit
	float reverseTop;
	float steerRate; // degrees a second at full steering
	float grip;      // scale on every surface's hold
};
#define H9R_NUM_CARS 3
static const H9RallyCar g_h9RallyCars[H9R_NUM_CARS] = {
	{"rally", 1150.0f, 320.0f, 1000.0f, 330.0f, 105.0f, 1.00f},
	{"sprint", 1350.0f, 350.0f, 1000.0f, 340.0f, 115.0f, 0.94f}, // fastest, a nervous one
	{"heavy", 1050.0f, 290.0f, 1050.0f, 300.0f, 95.0f, 1.08f},   // slowest, holds best
};

// The surfaces. mu: the tyres' hold (1 tarmac). roll: extra slowing, 1/s of the speed. top: the share of the car's top
// speed it reaches here. scrub: 1/s of the speed a slide costs, per unit of sin(slip angle).
enum H9RallySurfaceId
{
	H9RS_TARMAC = 0,
	H9RS_CONCRETE,
	H9RS_METAL,
	H9RS_PACKED,
	H9RS_GRAVEL,
	H9RS_DIRT,
	H9RS_GRASS,
	H9RS_SNOW,
	H9RS_ICE,
	H9RS_SAND,
	H9RS_COUNT
};
struct H9RallySurface
{
	const char* name;
	float mu, roll, top, scrub;
};
static const H9RallySurface g_h9RallySurfaces[H9RS_COUNT] = {
	{"tarmac", 1.00f, 0.00f, 1.00f, 0.55f},
	{"concrete", 0.95f, 0.00f, 1.00f, 0.55f},
	{"metal plate", 0.70f, 0.00f, 1.00f, 0.50f}, // slick: wet steel
	{"packed dirt", 0.62f, 0.05f, 0.96f, 0.65f},
	{"gravel", 0.50f, 0.12f, 0.90f, 0.70f},
	{"dirt", 0.50f, 0.17f, 0.90f, 0.70f},  // HL Rally: lateral friction x0.5
	{"grass", 0.35f, 0.30f, 0.85f, 0.85f}, // HL Rally: x0.35 and the most drag after sand
	{"snow", 0.32f, 0.18f, 0.90f, 0.70f},  // HL Rally: x0.315
	{"ice", 0.12f, 0.02f, 1.00f, 0.25f},   // not in HL Rally: nearly nothing to hold on to
	{"sand", 0.40f, 0.65f, 0.62f, 0.95f},  // HL Rally: x0.4; soft, so slow and it digs in
};

// ------------------------------------------------------------------------------------------------------------
//  The surface a texture name stands for. HL Rally's maps use these (substrings, any case): "dirt" and "mud",
//  "gras", "sand" and "desert", "snow"; "road", "street" and "rock" are hard ground. The winter set's "wntr_*"
//  is snow except "wntr_cliff" (rock). New: "ice", "gravel", "pack", "conc", "metal"/"plate"; a name that matches
//  nothing is tarmac. The marks a name may begin with are passed over first ("{", "!", "~", "+0", "-0").
// ------------------------------------------------------------------------------------------------------------
static inline bool H9RallyHas(const char* lower, const char* needle)
{
	return strstr(lower, needle) != 0;
}

// A word of its own in the name ("ice", "ice2", "wntr_ice"): not the middle of "office" or "police".
static inline bool H9RallyWord(const char* lower, const char* word)
{
	const size_t w = strlen(word);
	for (const char* p = lower; (p = strstr(p, word)) != 0; p++)
	{
		const bool before = p == lower || !(p[-1] >= 'a' && p[-1] <= 'z');
		const bool after = !(p[w] >= 'a' && p[w] <= 'z');
		if (before && after)
			return true;
	}
	return false;
}

static inline int H9RallySurfaceByName(const char* name)
{
	char low[40];
	int n = 0;
	if (!name)
		return H9RS_TARMAC;
	while (*name)
	{
		const char c = *name;
		const bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
		if ((c == '+' || c == '-') && name[1])
			name += 2;
		else if (!letter)
			name++;
		else
			break;
	}
	for (; *name && n < (int)sizeof(low) - 1; name++)
		low[n++] = (*name >= 'A' && *name <= 'Z') ? (char)(*name + 32) : *name;
	low[n] = 0;

	if (H9RallyWord(low, "ice"))
		return H9RS_ICE;
	if (H9RallyHas(low, "sand") || H9RallyHas(low, "desert"))
		return H9RS_SAND;
	if (H9RallyHas(low, "snow"))
		return H9RS_SNOW;
	if (H9RallyHas(low, "metal") || H9RallyWord(low, "plate") || H9RallyHas(low, "steel"))
		return H9RS_METAL;
	if (H9RallyHas(low, "pack"))
		return H9RS_PACKED;
	if (H9RallyHas(low, "dirt") || H9RallyHas(low, "mud"))
		return H9RS_DIRT;
	if (H9RallyHas(low, "gras") || H9RallyHas(low, "verge") || H9RallyHas(low, "hill"))
		return H9RS_GRASS;
	if (H9RallyHas(low, "gravel") || H9RallyHas(low, "grav") || H9RallyHas(low, "pebb"))
		return H9RS_GRAVEL;
	if (H9RallyHas(low, "conc"))
		return H9RS_CONCRETE;
	if (H9RallyHas(low, "road") || H9RallyHas(low, "street") || H9RallyHas(low, "rock") || H9RallyHas(low, "tarmac") ||
		H9RallyHas(low, "asph"))
		return H9RS_TARMAC;
	if (strncmp(low, "wntr", 4) == 0)
		return H9RallyHas(low, "cliff") ? H9RS_TARMAC : H9RS_SNOW;
	return H9RS_TARMAC;
}

// ------------------------------------------------------------------------------------------------------------
//  The maths.
// ------------------------------------------------------------------------------------------------------------
static inline float H9RClamp(float v, float lo, float hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

static inline const H9RallyCar& H9RallyCarByClass(int cls) // cls is the physinfo value, 1 on
{
	int i = cls - 1;
	if (i < 0)
		i = 0;
	if (i >= H9R_NUM_CARS)
		i = H9R_NUM_CARS - 1;
	return g_h9RallyCars[i];
}

struct H9RallyInput
{
	float throttle = 0;   // 1 forward key, -1 back key (brake, then reverse), 0 neither
	float steer = 0;      // 1 left, -1 right (only the steering function reads it)
	bool handbrake = false;
};

// The ground under the car, as the frame sees it.
struct H9RallyGround
{
	int surface = H9RS_TARMAC;
	float slopeF = 0;     // u/s^2 gravity pulls along the nose (negative uphill)
	float slopeS = 0;     // and across it, positive to the left
	float extraDrag = 0;  // 1/s, water on the wheels
	float topScale = 1;   // the share of the speed the surface may be driven at (water), times the surface's own
	float gripScale = 1;  // the share of the surface's hold (water on the road)
};

// What one frame did, for sounds and smoke.
struct H9RallyResult
{
	float slip = 0;       // 0 gripping .. 1 sliding fully
	float tractionUsed = 0;
};

// The traction the tyres have at this speed (u/s^2).
static inline float H9RallyTraction(const H9RallyCar& car, float mu, float speed)
{
	const float easing = 1.0f - (1.0f - H9R_GRIP_AT_TOP) * H9RClamp(speed / car.top, 0, 1);
	return H9R_TRACTION * mu * car.grip * easing;
}

// One frame on the ground. `vf` is the speed along the nose (negative backwards) and `vs` the speed across it
// (positive to the left), both in the ground's plane. The frame is cut into steps of 5 ms at most so that a
// slow frame gives the same car as a fast one.
static inline H9RallyResult H9RallyGroundStep(float& vf, float& vs, const H9RallyInput& in, const H9RallyGround& g,
											   const H9RallyCar& car, float dt)
{
	H9RallyResult res;
	int steps = (int)ceilf(dt / 0.005f);
	if (steps < 1)
		steps = 1;
	if (steps > 40)
		steps = 40;
	const float h = dt / (float)steps;

	const int sid = (g.surface >= 0 && g.surface < H9RS_COUNT) ? g.surface : H9RS_TARMAC;
	const H9RallySurface& su = g_h9RallySurfaces[sid];
	const float mu = su.mu * g.gripScale;
	const float topHere = car.top * su.top * g.topScale;

	for (int k = 0; k < steps; k++)
	{
		const float speed = sqrtf(vf * vf + vs * vs);
		const float traction = H9RallyTraction(car, mu, speed);
		const float usable = traction * H9R_BRAKE_TRACTION;

		// --- along the nose: the engine, the brakes, the coast ---------------------------------------------
		float along = 0; // u/s^2 the pedals ask for, signed
		bool braking = false;
		if (in.throttle > 0)
		{
			if (vf < -H9R_REVERSE_ENTER)
			{
				along = car.brake; // W while rolling backwards: the brakes
				braking = true;
			}
			else if (vf < topHere)
			{
				const float taper = H9RClamp((topHere - vf) / (H9R_TAPER * topHere), 0, 1);
				along = car.engine * taper;
			}
		}
		else if (in.throttle < 0)
		{
			if (vf > H9R_REVERSE_ENTER)
			{
				along = -car.brake;
				braking = true;
			}
			else
			{
				const float rt = car.reverseTop * su.top;
				const float taper = H9RClamp((rt + vf) / (H9R_TAPER * rt), 0, 1);
				along = -car.engine * H9R_REVERSE_PULL * taper;
			}
		}
		else
		{
			// nothing pressed: the car coasts
			const float c = (H9R_COAST + H9R_COAST_LIN * fabsf(vf));
			along = vf > 0 ? -c : (vf < 0 ? c : 0);
			if (fabsf(along) * h > fabsf(vf))
				along = -vf / h;
		}
		along = H9RClamp(along, -usable, usable);
		if (in.handbrake && vf != 0)
		{
			const float hb = H9R_HAND_BRAKE * mu;
			along += vf > 0 ? -hb : hb;
		}
		float vfNew = vf + along * h;
		// brakes and the handbrake stop the car, they do not push it backwards
		if ((braking || in.handbrake || in.throttle == 0) && vf != 0 && ((vf > 0) != (vfNew > 0)))
			vfNew = 0;
		vf = vfNew;

		// rolling resistance and the soft ground: proportional to speed, on both axes
		const float res_rate = su.roll + g.extraDrag;
		if (res_rate > 0)
		{
			const float keep = expf(-res_rate * h);
			vf *= keep;
			vs *= keep;
		}

		// the slope's pull (gravity along the plane)
		vf += g.slopeF * h;
		vs += g.slopeS * h;

		// --- across the nose: the tyres hold the car's path to its heading -----------------------------------
		const float sp = sqrtf(vf * vf + vs * vs);
		const float slipSin = sp > 1.0f ? fabsf(vs) / sp : 0.0f;
		// slip: 0 under sin 0.25 (about 15 degrees), 1 from sin 0.75
		const float slip = H9RClamp((slipSin - 0.25f) / 0.5f, 0, 1);
		float latMul = 1.0f - (1.0f - H9R_SLIDE_LAT) * slip;
		if (in.handbrake)
			latMul *= H9R_HAND_LAT;
		else if (braking)
			latMul *= H9R_BRAKE_LAT;
		const float latLimit = traction * latMul;
		// power and brakes use the same tyre: the sideways hold is what the circle has left
		const float used = fabsf(along);
		float lat = sqrtf(fmaxf(0.0f, latLimit * latLimit - used * used));
		if (lat < latLimit * H9R_LAT_FLOOR)
			lat = latLimit * H9R_LAT_FLOOR;
		res.slip = slip > res.slip ? slip : res.slip;
		res.tractionUsed = used / (traction + 1e-3f);

		const float vs0 = vs;
		const float dv = lat * h;
		if (fabsf(vs) <= dv)
			vs = 0;
		else
			vs += vs > 0 ? -dv : dv;

		// The sideways speed that was eaten turned the path toward the nose: it did not vanish. The path keeps the
		// speed it had, less what a slide costs (scrub, by the surface), and never more than it had.
		if (vs0 != vs && sp > 1.0f)
		{
			const float pure = sqrtf(vf * vf + vs * vs);
			float target = sp * (1.0f - su.scrub * h * slipSin);
			if (target > sp)
				target = sp;
			if (target > pure)
			{
				const float room = target * target - vs * vs;
				const float nf = sqrtf(room > 0 ? room : 0);
				vf = vf < 0 || (vf == 0 && in.throttle < 0) ? -nf : nf;
			}
		}
	}
	return res;
}

// How far the heading turns this frame, in degrees (positive: to the left). `vf` is the speed along the nose, `vs` across it.
// The client turns its view yaw by this while the steering keys are down; the server then reads the heading
// from the command's view angles, like HL Rally. Nothing in it needs the ground.
static inline float H9RallySteer(float vf, float vs, float steerInput, bool handbrake, bool backing, const H9RallyCar& car, float dt)
{
	if (steerInput == 0)
		return 0;
	const float speed = fabsf(vf);
	float rate = car.steerRate;
	rate *= H9R_STEER_MIN + (1.0f - H9R_STEER_MIN) * H9RClamp(speed / H9R_STEER_FULL_SPEED, 0, 1);
	if (handbrake)
		rate *= H9R_STEER_HAND;
	else
	{
		rate *= 1.0f - (1.0f - H9R_STEER_AT_TOP) * H9RClamp(speed / car.top, 0, 1);
		// a car that already slides sideways answers the wheel less (the front tyres have little left to give)
		const float slipDeg = (speed + fabsf(vs)) > 40.0f ? fabsf(atan2f(vs, fabsf(vf))) * 57.29578f : 0.0f;
		rate *= 1.0f - H9R_STEER_SLIDE * H9RClamp((slipDeg - H9R_STEER_SLIDE_FROM) / 45.0f, 0, 1);
	}
	float delta = steerInput * rate * dt;
	if (backing && vf < -5.0f) // backing up on purpose (the back key down): the nose goes the other way
		delta = -delta;
	return delta;
}

// The surface's effect on the steering: wheels without grip turn the car less (the client cannot know the surface,
// so this is for the server's own use and tests).
static inline float H9RallySteerGripScale(float mu)
{
	return mu >= 1.0f ? 1.0f : H9R_STEER_ICE + (1.0f - H9R_STEER_ICE) * H9RClamp(mu, 0, 1);
}

// The speed lost landing: `impact` is how fast the car came onto the ground, u/s, along its normal. Returns the
// share of its speed to keep.
static inline float H9RallyLandKeep(float impact)
{
	if (impact <= H9R_LAND_SOFT)
		return 1.0f;
	float loss = (impact - H9R_LAND_SOFT) * H9R_LAND_LOSS;
	if (loss > H9R_LAND_MAX)
		loss = H9R_LAND_MAX;
	return 1.0f - loss;
}

// ------------------------------------------------------------------------------------------------------------
//  The pmove side (pm_shared/h9_rally.cpp). Not part of the engine-free test.
// ------------------------------------------------------------------------------------------------------------
#ifndef H9RALLY_MATHS_ONLY
int H9RallyClass();    // the physinfo "rally" value read in pmove: 0 off, 1.. a car class
bool H9RallyActive();  // rally mode, for this player, this command
void H9RallyMove();    // the command's whole movement
#endif
