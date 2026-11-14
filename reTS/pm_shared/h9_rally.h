/***
*  h9_rally.h -- "rally mode": the player IS the car (H9). The handling maths, its tuning table and the
*  surface-by-texture-name rules. This file knows nothing of the engine: dlls/tests/rally_test.cpp compiles it
*  alone and drives it. The part that moves the player through the world is pm_shared/h9_rally.cpp.
*
*  The method follows HL Rally's, and so do its numbers: they were measured from how HL Rally behaves with the
*  server's own settings (rally.cfg: sv_friction 0.25, sv_accelerate 0.085, sv_gravity 520, sv_airaccelerate 0.1,
*  sv_stepsize 4, sv_maxspeed 3000; config.cfg: cl_forwardspeed 10000; carinfo.txt: Acceleration/Handling/TopSpeed in
*  %). Behaviour and constants are facts about that game; the code, the structure, the names and every comment are
*  ours, and none of HL Rally's source (which carries no licence) is copied.
*
*  The handling, as differential equations (v is the velocity in the ground's plane, F the nose, R the right):
*    drag        dv = -0.25 v                        (sv_friction, on the ground only; none in the air)
*    sideways    the part of v along R decays at LAT per second, LAT = min(75, 75 * 30 / |v| * mods), where
*                mods = brake pedal 0.3, handbrake 0.05, throttle 0.85, throttle with a steering key 0.8 * align,
*                align^3, the car's handling factor |Handling - 40| / 50, the surface's grip; align = cos of the
*                slip angle, at least 0.05. The speed that took is given back along the nose.
*    slide       dv = -0.25 (1 - align) v, and the surface's own drag (dirt .04, grass .075, sand .05, snow .05,
*                road/street/rock -0.10), per second of the whole velocity
*    brakes      with the back key or the handbrake and no reverse: |v| falls by 150 * align a second
*    engine      the wish speed is TopSpeed * 15 (1200 for 80); the throttle adds 0.085 * that a second (102 for
*                80) while the speed along the nose is below it; no engine at all above the top gear's range
*    reverse     the back key below 40 u/s drives backwards with the same pull; at 40 it is a brake again, so reverse
*                tops out near 40 (and HL Rally's pull would stop at 100 in any case)
*    steering    the heading is the command's view yaw. HL Rally's client does not send the raw keys' turn: it filters the
*                steering heavily (its cl_dll/input.cpp) before the yaw is sent, so how fast the nose turns is the client's
*                to decide (cl_dll/input.cpp here); pmove only reads the yaw it is given. H9RallySteer below is the plain
*                400 degrees a second the old client used, kept for anything that still calls it
*  Top speed is therefore where the engine's pull meets the drag: pull / (0.25 + the surface's drag).
*
*  Units are Half-Life's (units, units a second). Left is positive: a heading's yaw grows to the left, and the
*  sideways speed `side` is positive to the left of the nose.
*
*  Everything the movement needs from one frame to the next is the player's own velocity, origin and view yaw,
*  which the engine already carries and predicts. Nothing is kept in a static or in an iuser/fuser/vuser field.
*  The only things the server tells the client are the physinfo key "rally" (a car class number, 0 off) and, for the debug line, "rdbg".
*
*  Where this file deliberately does NOT do as HL Rally does is marked "ours" below and listed in the commit.
***/
#pragma once

#include <math.h>
#include <string.h>

// ------------------------------------------------------------------------------------------------------------
//  THE TUNING TABLE. Every number that changes how the car drives is in this block. "HLR" is a value HL Rally
//  has (the file it comes from is named); "ours" is ours, with the reason.
// ------------------------------------------------------------------------------------------------------------

// Ground and engine
#define H9R_FRICTION 0.25f       // HLR rally.cfg sv_friction: 1/s of the whole velocity, on the ground
#define H9R_ACCELERATE 0.085f    // HLR rally.cfg sv_accelerate: the pull is this * the wish speed, per second
#define H9R_WISH_PER_STAT 15.0f  // HLR pm_shared.c: the wish speed (maxspeed) is the TopSpeed stat * 15
#define H9R_GEAR_CAP 738.0f      // HLR: past this (gear 6 at 200 rpm) the client's gearbox sends no throttle: the pull stops
#define H9R_LAT_MAX 75.0f        // HLR rally.c: sv_friction * 300, 1/s
#define H9R_LAT_SPEED 30.0f      // HLR rally.c: the sideways rate is LAT_MAX * 30 / speed, so it eases as speed grows
#define H9R_LAT_BRAKE 0.3f       // HLR rally.c: the sideways hold with the back key down
#define H9R_LAT_HAND 0.05f       // HLR rally.c: with the handbrake (the jump key)
#define H9R_LAT_THROTTLE 0.85f   // HLR rally.c: with the throttle down
#define H9R_LAT_THROTTLE_STEER 0.8f // HLR rally.c: with the throttle and a steering key, times the alignment
#define H9R_ALIGN_MIN 0.05f      // HLR rally.c: the alignment is never less than this
#define H9R_HANDLING_REF 40.0f   // HLR rally.c: the handling factor is |Handling - 40| / 50
#define H9R_HANDLING_DIV 50.0f
#define H9R_SLIDE_DRAG 0.25f     // HLR rally.c: a slide costs this * (1 - align) of the velocity a second
#define H9R_BRAKE_DECEL 150.0f   // HLR rally.c: u/s^2 * align of extra slowing with the back key or the handbrake
#define H9R_REVERSE_ENTER 40.0f  // HLR input.cpp: the back key means reverse below this speed, a brake above
#define H9R_REVERSE_PULL_LIMIT 100.0f // HLR rally.c PM_Accelerate: no pull backwards once the speed is past this
#define H9R_STEER_RATE 400.0f    // HLR input.cpp: cl_yawspeed 500, capped at 400; degrees a second, whatever the speed

// The world
#define H9R_GRAVITY 520.0f       // HLR rally.cfg sv_gravity: the car falls at this whatever sv_gravity is
#define H9R_STEP_UP 4.0f         // HLR rally.cfg sv_stepsize: the highest kerb driven over
#define H9R_LIFT_VZ 1800.0f      // HLR pm_shared.c PM_CatagorizePosition: going up faster than this the car is off the ground
#define H9R_FL_FROZEN (1 << 12)  // const.h's FL_FROZEN: the race's hold. The only thing that holds a car (h9_rally.cpp asserts it)
#define H9R_GROUND_REACH 2.0f    // HLR PM_CatagorizePosition: the ground is looked for this far below the origin ...
#define H9R_GROUND_REACH_SLOW 16.0f // ... and this far when the car is (nearly) at rest
#define H9R_SLOW_SPEED 5.0f      // HLR: at or under this speed the longer reach is used
#define H9R_GROUND_MIN_NORMAL 0.3f // ours: a hit flatter than this (nz) is a wall, not ground; HLR takes any hit
#define H9R_FOLLOW 2.0f          // ours: a car that hugs the ground follows it at most this far down (HLR: no follow at all)
#define H9R_FOLLOW_VN 40.0f      // ours: ... and only while it moves away from the ground slower than this (a ramp's lip flies)
#define H9R_CRASH_SPEED 10.0f    // HLR PM_CarWorldCollision: sides away from the velocity are culled only above this speed
#define H9R_WALL_BOUNCE 0.2f     // HLR rally.c PM_Crash: the speed into a wall comes back at 0.2 (v - 1.2 (v.n) n)
// and the crash keeps (2 + cos(angle the wall turned the car)) / 3 of the speed: 1/3 head on, all of it grazing
#define H9R_AIR_DRAG 0.0f        // HLR: no friction off the ground
#define H9R_AIR_PULL_SPEED 0.0f  // HLR: forwardmove is 0 in the air, so sv_airaccelerate 0.1 gives nothing
// Water: HL Rally has none (its PM_CheckWater call is commented out), so a car in water drives as on dry ground. The movement
// still sets pmove->waterlevel, which the server's 3-second deep-water watch and the splash sound read.

// The body, for the ground's tilt and for what a wall can touch. HL Rally's car is 45 long, 18 wide, 16 high.
#define H9R_LENGTH 45.0f
#define H9R_WIDTH 18.0f
#define H9R_HEIGHT 16.0f
#define H9R_VIEW_HEIGHT 14.0f   // ours: the eye above the wheels' ground, until the chase camera of the car model takes over

// The cars: HL Rally's stat triples (carinfo.txt, in %). Acceleration is read by nothing in HL Rally's movement and
// by nothing here. The class number is the physinfo value ("rally" "1" is the first).
struct H9RallyCar
{
	const char* name;
	float accelStat;    // carinfo.txt Acceleration: unused by HL Rally's movement, kept for the record
	float handlingStat; // carinfo.txt Handling: the sideways hold is x |Handling - 40| / 50
	float topStat;      // carinfo.txt TopSpeed: the wish speed is x 15
};
#define H9R_NUM_CARS 3
static const H9RallyCar g_h9RallyCars[H9R_NUM_CARS] = {
	{"xsara", 80.0f, 80.0f, 80.0f},   // carinfo.txt Xsara, 80/80/80
	{"accent", 85.0f, 75.0f, 80.0f},  // carinfo.txt Accent, 85/75/80: looser
	{"locust", 80.0f, 90.0f, 70.0f},  // carinfo.txt Locust, 80/90/70: holds best, slowest
};

static inline float H9RallyWish(const H9RallyCar& c)
{
	return c.topStat * H9R_WISH_PER_STAT;
}
static inline float H9RallyHandling(const H9RallyCar& c)
{
	return fabsf(c.handlingStat - H9R_HANDLING_REF) / H9R_HANDLING_DIV;
}

// The surfaces. lat: the sideways hold's scale. drag: extra 1/s of the velocity (negative speeds the car up).
// The first four rows are HL Rally's (rally.c, by substring of the texture name); the others are ours, placed between.
enum H9RallySurfaceId
{
	H9RS_NEUTRAL = 0, // HLR: any other name: no change
	H9RS_ROAD,        // HLR: "road", "street", "rock": drag -0.10
	H9RS_DIRT,        // HLR: "dirt", "mud": lat 0.5, drag +0.04
	H9RS_GRASS,       // HLR: "gras": lat 0.35, drag +0.075
	H9RS_SAND,        // HLR: "sand", "desert": lat 0.4, drag +0.05
	H9RS_SNOW,        // HLR: "snow": lat 0.315, drag +0.05
	H9RS_CONCRETE,    // ours
	H9RS_METAL,       // ours
	H9RS_PACKED,      // ours
	H9RS_GRAVEL,      // ours
	H9RS_ICE,         // ours
	H9RS_COUNT
};
struct H9RallySurface
{
	const char* name;
	float lat, drag;
};
static const H9RallySurface g_h9RallySurfaces[H9RS_COUNT] = {
	{"neutral", 1.00f, 0.00f},
	{"road", 1.00f, -0.10f},
	{"dirt", 0.50f, 0.04f},
	{"grass", 0.35f, 0.075f},
	{"sand", 0.40f, 0.05f},
	{"snow", 0.315f, 0.05f},
	{"concrete", 1.00f, -0.05f},  // ours: a hard road, a little less rolling-free than "road"
	{"metal plate", 0.70f, 0.00f}, // ours: slick, between neutral and dirt
	{"packed dirt", 0.70f, 0.02f}, // ours: between neutral and dirt
	{"gravel", 0.55f, 0.035f},     // ours: just looser than dirt's 0.5 on grip, a little less drag
	{"ice", 0.08f, 0.00f},         // ours: nearly nothing to hold on to (snow is 0.315), and no extra drag
};

// ------------------------------------------------------------------------------------------------------------
//  The surface a texture name stands for. HL Rally's rules, substrings in any case, tried in its order: "dirt" or
//  "mud", "gras", "sand" or "desert", "snow"; then, on top of whichever matched, "road", "street" or "rock" take 0.10
//  off the drag. Ours, tried first: "ice" (as a word), "metal"/"plate"/"steel", "pack", "grav"/"pebb", "conc". A name
//  that matches nothing is neutral. The marks a name may begin with are passed over first ("{", "!", "~", "+0", "-0").
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

// Returns the surface; `extraDrag` (may be null) gets the drag HL Rally's road/street/rock rule adds on top of it.
static inline int H9RallySurfaceByName(const char* name, float* extraDrag = 0)
{
	char low[40];
	int n = 0;
	if (extraDrag)
		*extraDrag = 0;
	if (!name)
		return H9RS_NEUTRAL;
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

	const bool roadish = H9RallyHas(low, "road") || H9RallyHas(low, "street") || H9RallyHas(low, "rock");
	int id = -1;
	if (H9RallyWord(low, "ice"))
		id = H9RS_ICE;
	else if (H9RallyHas(low, "metal") || H9RallyWord(low, "plate") || H9RallyHas(low, "steel"))
		id = H9RS_METAL;
	else if (H9RallyHas(low, "pack"))
		id = H9RS_PACKED;
	else if (H9RallyHas(low, "grav") || H9RallyHas(low, "pebb"))
		id = H9RS_GRAVEL;
	else if (H9RallyHas(low, "conc"))
		id = H9RS_CONCRETE;
	else if (H9RallyHas(low, "dirt") || H9RallyHas(low, "mud"))
		id = H9RS_DIRT;
	else if (H9RallyHas(low, "gras"))
		id = H9RS_GRASS;
	else if (H9RallyHas(low, "sand") || H9RallyHas(low, "desert"))
		id = H9RS_SAND;
	else if (H9RallyHas(low, "snow"))
		id = H9RS_SNOW;
	if (id < 0)
	{
		if (roadish || H9RallyHas(low, "tarmac") || H9RallyHas(low, "asph")) // ours: tarmac and asphalt are roads
			return H9RS_ROAD;
		return H9RS_NEUTRAL;
	}
	if (roadish && extraDrag)
		*extraDrag = -0.10f;
	return id;
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
	bool forward = false;  // the throttle key
	bool back = false;     // the back key: a brake above H9R_REVERSE_ENTER, reverse below it
	bool hand = false;     // the handbrake (the jump key)
	bool steering = false; // a steering key is down (left or right)
};

// The ground under the car, as the frame sees it.
struct H9RallyGround
{
	int surface = H9RS_NEUTRAL;
	float extraDrag = 0;  // 1/s added to the surface's: HL Rally's road rule on top of a looser surface
	float latScale = 1;   // a scale of the sideways hold (1: none)
	float pullScale = 1;  // pmove->friction: HL Rally multiplies the engine's pull by it (func_friction areas)
	float slopeF = 0;     // u/s^2 gravity pulls along the nose (negative uphill)
	float slopeS = 0;     // and across it, positive to the left
};

// What a frame did, for sounds and smoke.
struct H9RallyResult
{
	float lat = 0; // the sideways rate used last, 1/s
};

// One frame on the ground. `vf` is the speed along the nose (negative backwards) and `vs` the speed across it
// (positive to the left), both in the ground's plane. The frame is cut into steps of 5 ms at most: HL Rally's own
// steps are its frames' lengths and a long one overshoots (ours: the sideways decay is exponential, so a slow frame
// gives the same car as a fast one).
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

	const int sid = (g.surface >= 0 && g.surface < H9RS_COUNT) ? g.surface : H9RS_NEUTRAL;
	const H9RallySurface& su = g_h9RallySurfaces[sid];
	const float wish = H9RallyWish(car);
	const float handling = H9RallyHandling(car);
	const float surfDrag = su.drag + g.extraDrag;

	for (int k = 0; k < steps; k++)
	{
		const float s0 = sqrtf(vf * vf + vs * vs);
		// the client sends the back key as "reverse" while it is nearly at rest, and not otherwise
		const bool reversing = in.back && !in.forward && s0 < H9R_REVERSE_ENTER;

		// alignment: the cosine of the slip angle, at least 0.05 (and the car's reverse counts as straight)
		float align = s0 > 1.0f ? (reversing ? fabsf(vf) : vf) / s0 : 1.0f;
		align = H9RClamp(align, H9R_ALIGN_MIN, 1.0f);

		// --- the sideways rate (HL Rally's LATERAL_FRICTION) ---
		float mods = 1.0f;
		if (in.back)
			mods *= H9R_LAT_BRAKE;
		if (in.hand)
			mods *= H9R_LAT_HAND;
		if (in.forward)
			mods *= H9R_LAT_THROTTLE;
		if (in.forward && in.steering)
			mods *= H9R_LAT_THROTTLE_STEER * align;
		mods *= align * align * align;
		mods *= handling;
		mods *= su.lat * g.latScale;
		float lat = s0 > 0.001f ? H9R_LAT_MAX * H9R_LAT_SPEED / s0 * mods : H9R_LAT_MAX;
		if (lat > H9R_LAT_MAX)
			lat = H9R_LAT_MAX;
		res.lat = lat;

		// --- ground drag ---
		const float dragKeep = expf(-H9R_FRICTION * h);
		vf *= dragKeep;
		vs *= dragKeep;

		// --- the sideways speed decays; what it took is given back along the nose ---
		const float s1 = sqrtf(vf * vf + vs * vs);
		vs *= expf(-lat * h);
		const float s2 = sqrtf(vf * vf + vs * vs);
		vf += s1 - s2;

		// --- a slide, and the surface ---
		const float keep = expf(-(H9R_SLIDE_DRAG * (1.0f - align) + surfDrag) * h);
		vf *= keep;
		vs *= keep;

		// --- the brakes: the back key above reverse speed, or the handbrake ---
		if ((in.back && !reversing) || in.hand)
		{
			const float s = sqrtf(vf * vf + vs * vs);
			if (s > 0.0001f)
			{
				const float cut = H9R_BRAKE_DECEL * align * h;
				const float f = cut >= s ? 0.0f : (s - cut) / s;
				vf *= f;
				vs *= f;
			}
		}

		// --- the slope ---
		vf += g.slopeF * h;
		vs += g.slopeS * h;

		// --- the engine (HL Rally's PM_Accelerate after the friction) ---
		const float sh = sqrtf(vf * vf + vs * vs);
		if (in.forward)
		{
			if (sh < H9R_GEAR_CAP)
			{
				const float addspeed = wish - vf;
				if (addspeed > 0)
				{
					float pull = H9R_ACCELERATE * wish * h * g.pullScale;
					if (pull > addspeed)
						pull = addspeed;
					vf += pull;
				}
			}
		}
		else if (reversing)
		{
			if (sh <= H9R_REVERSE_PULL_LIMIT)
			{
				const float addspeed = wish + vf; // the speed along the wish direction (backwards) is -vf
				if (addspeed > 0)
				{
					float pull = H9R_ACCELERATE * wish * h * g.pullScale;
					if (pull > addspeed)
						pull = addspeed;
					vf -= pull;
				}
			}
		}
		else if (!in.back && !in.hand && sh < 1.0f)
		{
			// nothing pressed and nearly stopped: HL Rally does not move a car slower than 1 u/s
			vf = 0;
			vs = 0;
		}
	}
	return res;
}

// How far the heading turns this frame, in degrees (positive: to the left), by the plain rule of 400 degrees a second at any
// speed (HL Rally's CL_AdjustAngles before its client filters the steering: that filter is the client's, cl_dll/input.cpp).
// `steerInput` is the keys: left 1, right -1, or in between when a key was pressed or let go within the frame.
static inline float H9RallySteer(float steerInput, float dt)
{
	return steerInput * H9R_STEER_RATE * dt;
}

// What a wall does to a car (HL Rally's PM_Crash). `vn` is the velocity's part along the wall's normal (negative:
// into the wall). Returns the new velocity's share kept, given the cosine between the new direction and the old.
static inline float H9RallyCrashKeep(float cosTurned)
{
	return (cosTurned + 2.0f) / 3.0f;
}

// ------------------------------------------------------------------------------------------------------------
//  The decisions the pmove side makes, as plain functions (so rally_test drives them with no engine).
// ------------------------------------------------------------------------------------------------------------

// Held (the countdown, after the finish): the race's FL_FROZEN, and nothing else. HL Rally rewrites maxspeed every frame; The
// Specialists changes it with the loadout, so a low or zero maxspeed says nothing about the race.
static inline bool H9RallyHeld(int flags)
{
	return (flags & H9R_FL_FROZEN) != 0;
}

// How far below the origin the ground is looked for (HL Rally's PM_CatagorizePosition).
static inline float H9RallyGroundReach(float speed)
{
	return speed > H9R_SLOW_SPEED ? H9R_GROUND_REACH : H9R_GROUND_REACH_SLOW;
}

// Is this trace ground? HL Rally: any hit is, none when the car is shooting up faster than 1800. Ours: a trace that starts
// inside something is ground too (the car is on a sliver; the stuck check frees it), and a hit flatter than
// H9R_GROUND_MIN_NORMAL is a wall.
static inline bool H9RallyIsGround(bool startsolid, float fraction, float normalZ, float velocityZ)
{
	if (velocityZ > H9R_LIFT_VZ)
		return false;
	if (startsolid)
		return true;
	return fraction < 1.0f && normalZ >= H9R_GROUND_MIN_NORMAL;
}

// The kerb retry: the slide's and the stepped-up move's distances (squared, in the plane). HL Rally keeps the slide only when it
// went farther: on a tie the stepped move wins.
static inline bool H9RallySteppedWins(float slideDist2, float steppedDist2)
{
	return !(slideDist2 > steppedDist2);
}

// A body contact HL Rally's PM_Crash lets pass: in the air, a plane a car could land on (nz > 0.3). On the ground nothing passes.
static inline bool H9RallyCrashIgnores(bool grounded, float normalZ)
{
	return !grounded && normalZ > 0.3f;
}

// The sides of the body whose traces are made. At rest (3-D speed 10 or less) all four; above it, the front or the back (the
// one the car goes toward) and the left or the right. `vf` is the velocity along the nose (positive forward), `vl` across it
// (positive to the left), `speed3` the whole velocity's length. HL Rally culls the front when v.forward < 0 else the back, and
// the right when v.right < 0 (moving left) else the left.
struct H9RallySides
{
	bool front = true, back = true, left = true, right = true;
};
static inline H9RallySides H9RallyCrashSides(float vf, float vl, float speed3)
{
	H9RallySides s;
	if (speed3 > H9R_CRASH_SPEED)
	{
		if (vf < 0)
			s.front = false;
		else
			s.back = false;
		if (vl > 0)
			s.right = false;
		else
			s.left = false;
	}
	return s;
}

// The points the body is traced out to, from its middle (8 above the origin): (along the nose, to the left, height above the
// origin). HL Rally's grid: along the front and the back 4.8 apart at 25.2 wide (4 points, the corner's 2 in), along the sides 8
// apart over 37 (5 points), at the heights 4 and 12. Returns how many were written.
static inline int H9RallyCrashPoints(const H9RallySides& sides, float out[][3], int maxPoints)
{
	int n = 0;
	const float half = H9R_LENGTH * 0.5f, halfW = H9R_WIDTH * 0.5f;
	for (int h = 0; h < 2; h++)
	{
		const float z = H9R_STEP_UP + 8.0f * (float)h;
		for (int u = 0; u < 4; u++)
		{
			if (sides.front && n < maxPoints)
			{
				out[n][0] = half;
				out[n][1] = halfW - 2.0f - 4.8f * (float)u;
				out[n++][2] = z;
			}
			if (sides.back && n < maxPoints)
			{
				out[n][0] = -half;
				out[n][1] = -halfW + 2.0f + 4.8f * (float)u;
				out[n++][2] = z;
			}
		}
		for (int u = 0; u < 5; u++)
		{
			const float x = -half + 8.0f + 8.0f * (float)u;
			if (sides.right && n < maxPoints)
			{
				out[n][0] = x;
				out[n][1] = -halfW;
				out[n++][2] = z;
			}
			if (sides.left && n < maxPoints)
			{
				out[n][0] = x;
				out[n][1] = halfW;
				out[n++][2] = z;
			}
		}
	}
	return n;
}

// ------------------------------------------------------------------------------------------------------------
//  The pmove side (pm_shared/h9_rally.cpp). Not part of the engine-free test.
// ------------------------------------------------------------------------------------------------------------
#ifndef H9RALLY_MATHS_ONLY
int H9RallyClass();    // the physinfo "rally" value read in pmove: 0 off, 1.. a car class
bool H9RallyActive();  // rally mode, for this player, this command
void H9RallyMove();    // the command's whole movement
#endif
