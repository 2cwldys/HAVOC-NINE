/***
*  h9_rally.h -- "rally mode": the player IS the car (H9). The handling maths, its tuning table and the
*  surface-by-texture-name rules. This file knows nothing of the engine: dlls/tests/rally_test.cpp compiles it
*  alone and drives it. The part that moves the player through the world is pm_shared/h9_rally.cpp.
*
*  The aim is HL Rally's movement 1:1: whatever HL Rally does the car does, and whatever it does not do the car does
*  not. The behaviour and the constants are facts about that game (measured from how it behaves with the server's own
*  settings, rally.cfg: sv_friction 0.25, sv_accelerate 0.085, sv_gravity 520, sv_stepsize 4, sv_maxspeed 3000;
*  carinfo.txt: Acceleration/Handling/TopSpeed in %); the code, the structure, the names and every comment are ours,
*  and none of HL Rally's source (which carries no licence) is copied.
*
*  What one command does (pm_shared/h9_rally.cpp), in HL Rally's order:
*    half the gravity, the drag and the sideways hold (HERE: H9RallyFriction), the wall (PM_Crash), then on the ground the
*    engine's pull (HERE: H9RallyAccelerate) and the move, in the air the move and then the wall; where the car stands now;
*    the other half of the gravity.
*  Every term is applied once per command, as Euler: x -= x * k * dt with the command's own length. There are no sub-steps:
*  a long command holds a slow car harder than a short one does (the sideways hold flips the sign of the sideways speed
*  when LAT * dt is over 1), exactly as in HL Rally.
*
*  The handling, as the formulas HL Rally applies (v is the velocity, F the nose, R the right, all three-dimensional):
*    drag        v -= v/|v| * friction * |v| * dt                  (sv_friction, on the ground only; none in the air)
*    sideways    v -= R (v.R) LAT dt, LAT = min(friction * 300, friction * 300 * 30 / |v| * mods), where
*                mods = brake pedal 0.3, handbrake 0.05, throttle 0.85, throttle with a steering key 0.8 * align,
*                align^3, the car's handling factor |Handling - 40| / 50, the surface's grip; align = v.F / |v|, from 0.05 to 1
*                (its absolute value when reversing). The speed that took is given back along the nose.
*    slide       v -= v (1 - align) 0.25 dt, and the surface's own drag (dirt .04, grass .075, sand .05, snow .05,
*                road/street/rock -0.10): v -= v drag dt
*    brakes      with the back key or the handbrake and not reversing: v -= v/|v| * 150 * align * dt
*    engine      the wish speed is TopSpeed * 15 (1200 for 80); the throttle adds accelerate * dt * wish * friction while
*                the speed along the nose is below it
*    reverse     the back key below 40 u/s drives backwards with the same pull, which stops above 100 u/s
*    steering    the heading is the command's view yaw. HL Rally's client filters the steering heavily before the yaw is sent,
*                so how fast the nose turns is the client's to decide (cl_dll/input.cpp here); pmove only reads the yaw it is
*                given. H9RallySteer below is the plain 400 degrees a second the old client used, kept for anything that
*                still calls it
*  Top speed is therefore where the engine's pull meets the drag: pull / (friction + the surface's drag).
*
*  Units are Half-Life's (units, units a second). Left is positive: a heading's yaw grows to the left.
*
*  Everything the movement needs from one frame to the next is the player's own velocity, origin and view yaw,
*  which the engine already carries and predicts, and the car's tilt (vuser4 and vuser3.x, H9RallyTiltPack). Nothing is kept in a static.
*  The only things the server tells the client are the physinfo keys "rally" (a car class number, 0 off), "rfin" (1: this
*  car has finished its race) and, for the debug line, "rdbg".
***/
#pragma once

#include <math.h>
#include <string.h>

// ------------------------------------------------------------------------------------------------------------
//  THE TUNING TABLE. "HLR" is a value HL Rally has (the file it comes from is named); "ours" is ours, with the reason.
// ------------------------------------------------------------------------------------------------------------

// The server's settings while a rally map runs (dlls/h9_rally_srv.cpp sets these cvars; pmove reads them live from
// pmove->movevars, so a server that sets others drives with those). They are also what the gauge's top speed is worked out from.
#define H9R_FRICTION 0.25f       // HLR rally.cfg sv_friction
#define H9R_ACCELERATE 0.085f    // HLR rally.cfg sv_accelerate: the pull is this * the wish speed, per second
#define H9R_GRAVITY 520.0f       // HLR rally.cfg sv_gravity
#define H9R_STEP_UP 4.0f         // HLR rally.cfg sv_stepsize: the highest kerb driven over (and the body check's lowest height)

// The car
#define H9R_WISH_PER_STAT 15.0f  // HLR pm_shared.c: the wish speed (maxspeed) is the TopSpeed stat * 15
#define H9R_LAT_MAX_PER_FRICTION 300.0f // HLR rally.c: LAT_MAX = sv_friction * 300
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
#define H9R_FINISH_BRAKE_SPEED 20.0f  // HLR input.cpp: after the finish the back key is held while the speed is over this, then let go
#define H9R_STEER_RATE 400.0f    // HLR input.cpp: cl_yawspeed 500, capped at 400; degrees a second, whatever the speed

// The world
#define H9R_LIFT_VZ 1800.0f      // HLR pm_shared.c PM_CatagorizePosition: going up faster than this the car is off the ground
#define H9R_FL_FROZEN (1 << 12)  // const.h's FL_FROZEN: the race's hold. The only thing that holds a car (h9_rally.cpp asserts it)
#define H9R_GROUND_REACH 2.0f    // HLR PM_CatagorizePosition: the ground is looked for this far below the origin, along the car's up ...
#define H9R_GROUND_REACH_SLOW 16.0f // ... and this far straight down when the car is (nearly) at rest
#define H9R_SLOW_SPEED 5.0f      // HLR: at or under this speed the longer reach is used
#define H9R_CRASH_SPEED 10.0f    // HLR PM_CarWorldCollision: sides away from the velocity are culled only above this speed
#define H9R_WALL_BACKOFF 1.2f    // HLR rally.c PM_Crash: v -= n (v.n) 1.2, whether the car goes into the wall or away from it
#define H9R_CLIP_FLOOR 0.9f      // HLR rally.c PM_FlyMove: a plane with nz over this is a floor (overbounce 1) in the air branch
#define H9R_CLIP_WALL 1.1f       // HLR rally.c PM_FlyMove: every other plane is clipped at this overbounce
#define H9R_TOSS_STOP_NZ 0.7f    // HLR pm_shared.c PM_Physics_Toss: a floor this flat stops a tossed car dead

// The terrain trace of the car's tilt (HLR rally.c): four traces from 4 above to 16 below the origin, along the car's up, at
// 8 to the side and 12 to the front or the back of it
#define H9R_TILT_SIDE 8.0f
#define H9R_TILT_FRONT 12.0f
#define H9R_TILT_FROM 4.0f
#define H9R_TILT_TO 16.0f

// The body, for what a wall can touch. HL Rally's car is 45 long, 18 wide, 16 high.
#define H9R_LENGTH 45.0f
#define H9R_WIDTH 18.0f
#define H9R_HEIGHT 16.0f
#define H9R_TRACE_GAP 8.0f       // HLR rally.c TRACE_GAP
#define H9R_VIEW_HEIGHT 14.0f   // ours: the eye above the wheels' ground, until the chase camera of the car model takes over

// The cars: HL Rally's stat triples (carinfo.txt, in %). Acceleration is read by nothing in HL Rally's movement and
// by nothing here. The class number is the physinfo value ("rally" "1" is the first); the first three keep their numbers.
struct H9RallyCar
{
	const char* name;
	float accelStat;    // carinfo.txt Acceleration: unused by HL Rally's movement, kept for the record
	float handlingStat; // carinfo.txt Handling: the sideways hold is x |Handling - 40| / 50
	float topStat;      // carinfo.txt TopSpeed: the wish speed is x 15
};
#define H9R_NUM_CARS 10
static const H9RallyCar g_h9RallyCars[H9R_NUM_CARS] = {
	{"xsara", 80.0f, 80.0f, 80.0f},        // carinfo.txt Citroen xsara, 80/80/80
	{"accent", 85.0f, 75.0f, 80.0f},       // Hyundai accent, 85/75/80: looser
	{"locust", 80.0f, 90.0f, 70.0f},       // Foam locust, 80/90/70: holds best, slowest
	{"evo7", 90.0f, 80.0f, 70.0f},         // Mitsubishi evo7, 90/80/70
	{"206", 85.0f, 85.0f, 70.0f},          // Peugeot 206, 85/85/70
	{"octavia", 75.0f, 75.0f, 90.0f},      // Skoda octavia, 75/75/90
	{"fabia", 75.0f, 75.0f, 90.0f},        // Skoda fabia, 75/75/90
	{"impreza2002", 80.0f, 85.0f, 75.0f},  // Subaru impreza2002, 80/85/75
	{"celica", 80.0f, 75.0f, 85.0f},       // Toyota celica, 80/75/85
	{"corolla", 80.0f, 70.0f, 90.0f},      // Toyota corolla, 80/70/90
};

// A car with the stat % the player's parts add (HL Rally adds the parts' values to the stats it gives pmove: dlls/client.cpp:1044
// `pev->vuser4 = pev->vuser4 + vUpdates`, then PM_SetStats; pmove reads vuser4[1] and [2], pm_shared/pm_shared.c:1982-1984 and :1787).
// Here the server sends the sums in the physinfo keys "rh" (handling) and "rt" (top speed); Acceleration's are read by nothing, as in HL Rally.
static inline H9RallyCar H9RallyCarWithParts(const H9RallyCar& base, int handlingAdd, int topAdd)
{
	H9RallyCar c = base;
	c.handlingStat += (float)handlingAdd;
	c.topStat += (float)topAdd;
	return c;
}

static inline float H9RallyWish(const H9RallyCar& c)
{
	return c.topStat * H9R_WISH_PER_STAT;
}
static inline float H9RallyHandling(const H9RallyCar& c)
{
	return fabsf(c.handlingStat - H9R_HANDLING_REF) / H9R_HANDLING_DIV;
}

// The surfaces: HL Rally has these and no others. lat: the sideways hold's scale. drag: extra 1/s of the velocity (negative
// speeds the car up).
enum H9RallySurfaceId
{
	H9RS_NEUTRAL = 0, // HLR: any other name: no change
	H9RS_ROAD,        // HLR: "road", "street", "rock" (on their own): drag -0.10
	H9RS_DIRT,        // HLR: "dirt", "mud": lat 0.5, drag +0.04
	H9RS_GRASS,       // HLR: "gras": lat 0.35, drag +0.075
	H9RS_SAND,        // HLR: "sand", "desert": lat 0.4, drag +0.05
	H9RS_SNOW,        // HLR: "snow": lat 0.315, drag +0.05
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
};

// ------------------------------------------------------------------------------------------------------------
//  The surface a texture name stands for. HL Rally's rules, exactly: the name loses a leading "-0" or "+0" (two characters)
//  and then one of "{", "!", "~" or a space, is cut to 12 characters, and is matched CASE-SENSITIVELY against lower-case words:
//  "dirt" or "mud", else "gras", else "sand" or "desert", else "snow"; then, on top of whichever matched, "road", "street"
//  or "rock" take 0.10 off the drag. A name that matches nothing is neutral.
// ------------------------------------------------------------------------------------------------------------
static inline bool H9RallyHas(const char* name, const char* needle)
{
	return strstr(name, needle) != 0;
}

// Returns the surface; `extraDrag` (may be null) gets the drag HL Rally's road/street/rock rule adds on top of it.
static inline int H9RallySurfaceByName(const char* name, float* extraDrag = 0)
{
	char cut[13];
	int n = 0;
	if (extraDrag)
		*extraDrag = 0;
	if (!name)
		return H9RS_NEUTRAL;
	if ((*name == '-' || *name == '+') && name[1])
		name += 2;
	if (*name == '{' || *name == '!' || *name == '~' || *name == ' ')
		name++;
	for (; *name && n < 12; name++)
		cut[n++] = *name;
	cut[n] = 0;

	const bool roadish = H9RallyHas(cut, "road") || H9RallyHas(cut, "street") || H9RallyHas(cut, "rock");
	int id = -1;
	if (H9RallyHas(cut, "dirt") || H9RallyHas(cut, "mud"))
		id = H9RS_DIRT;
	else if (H9RallyHas(cut, "gras"))
		id = H9RS_GRASS;
	else if (H9RallyHas(cut, "sand") || H9RallyHas(cut, "desert"))
		id = H9RS_SAND;
	else if (H9RallyHas(cut, "snow"))
		id = H9RS_SNOW;
	if (id < 0)
		return roadish ? H9RS_ROAD : H9RS_NEUTRAL;
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

static inline float H9RDot(const float a[3], const float b[3])
{
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
static inline float H9RLen(const float a[3])
{
	return sqrtf(H9RDot(a, a));
}
// HL's VectorNormalize: a vector of no length stays as it is
static inline float H9RNormalize(float a[3])
{
	const float l = H9RLen(a);
	if (l != 0.0f)
	{
		const float k = 1.0f / l;
		a[0] *= k;
		a[1] *= k;
		a[2] *= k;
	}
	return l;
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

// The pull's wish speed (HLR rally.c PM_DriveMove:518-537): the size of the command's forward move (wishvel = forward * fmove, wishspeed =
// its length), cut to the server's top speed. HL Rally cuts to pmove->maxspeed, which it sets to the car's TopSpeed * 15; here the car's
// own wish is the cut (a loadout's maxspeed says nothing about a car), so the two are the same number. The command's forwardmove is the
// client's (cl_dll/h9_rallysteer_calc.h DriveStep), as in HL Rally; pmove does not invent one from the buttons.
static inline float H9RallyWishSpeed(float forwardmove, float carWish)
{
	const float w = fabsf(forwardmove);
	return w > carWish ? carWish : w;
}

// What the finish does to the keys (HLR input.cpp:818-835): the back key alone while the car is over 20 u/s, then nothing at all. The
// client sends no forward move after the finish (its whole drive block is skipped), so the server takes it as 0.
static inline H9RallyInput H9RallyFinishKeys(float horizontalSpeed)
{
	H9RallyInput in;
	in.back = horizontalSpeed > H9R_FINISH_BRAKE_SPEED;
	return in;
}

// What the friction left behind, for the sounds and smoke.
struct H9RallyFrictionResult
{
	float lat = 0;   // the sideways rate used (LATERAL_FRICTION), 1/s
	float align = 1; // the alignment (the cosine of the slip angle, 0.05 to 1)
};

// HL Rally's PM_Friction, on the ground. `v` is the velocity (three-dimensional), `fwd` and `right` the car's axes (unit,
// including the ground's tilt), `fmove` the forward move (its sign: reverse), `surfLat` and `surfDrag` the surface's, `handling`
// the car's factor, `mvFriction` sv_friction and `dt` the command's length. Euler, once.
static inline H9RallyFrictionResult H9RallyFriction(float v[3], const float fwdIn[3], const float rightIn[3], const H9RallyInput& in,
													float fmove, float surfLat, float surfDrag, float handling, float mvFriction, float dt)
{
	H9RallyFrictionResult res;
	float speed = H9RLen(v);
	if (speed < 1e-9f)
		return res; // HLR divides by it: the velocity turns to NaN and is zeroed; it is zero anyway
	const float latMax = mvFriction * H9R_LAT_MAX_PER_FRICTION;
	float lat = latMax * (1.0f / (speed / H9R_LAT_SPEED));
	float align = H9RDot(v, fwdIn) / speed;
	if (fmove < 0)
		align = fabsf(align);
	align = H9RClamp(align, H9R_ALIGN_MIN, 1.0f);
	if (in.back)
		lat *= H9R_LAT_BRAKE;
	if (in.hand)
		lat *= H9R_LAT_HAND;
	if (in.forward)
		lat *= H9R_LAT_THROTTLE;
	if (in.forward && in.steering)
		lat *= H9R_LAT_THROTTLE_STEER * align;
	lat *= align * align * align;
	lat *= handling;
	lat *= surfLat;
	if (lat > latMax)
		lat = latMax;
	res.lat = lat;
	res.align = align;

	float fwd[3] = {fwdIn[0], fwdIn[1], fwdIn[2]}, right[3] = {rightIn[0], rightIn[1], rightIn[2]};
	H9RNormalize(fwd);
	H9RNormalize(right);

	float vn[3] = {v[0], v[1], v[2]};
	H9RNormalize(vn);
	for (int i = 0; i < 3; i++)
		v[i] -= vn[i] * mvFriction * speed * dt;

	speed = H9RLen(v);
	const float latfric = H9RDot(v, right);
	for (int i = 0; i < 3; i++)
		v[i] -= right[i] * latfric * lat * dt;
	speed = speed - H9RLen(v); // what the sideways hold took, given back along the nose
	for (int i = 0; i < 3; i++)
	{
		v[i] += fwd[i] * speed;
		v[i] -= (v[i] * (-align + 1.0f) * dt) * H9R_SLIDE_DRAG;
		v[i] -= (v[i] * surfDrag) * dt;
	}

	vn[0] = v[0];
	vn[1] = v[1];
	vn[2] = v[2];
	H9RNormalize(vn);
	if (fmove >= 0 && (in.back || in.hand))
		for (int i = 0; i < 3; i++)
			v[i] -= (vn[i] * H9R_BRAKE_DECEL) * align * dt;
	return res;
}

// HL Rally's PM_Accelerate: the pull along `wishdir` (unit; the nose, or its opposite for reverse) up to `wishspeed`. `pmFriction` is
// pmove->friction (a func_friction area), unclamped. Backwards, none once the car is over 100 u/s.
static inline void H9RallyAccelerate(float v[3], const float wishdir[3], float wishspeed, float accel, float pmFriction, float dt, float fmove)
{
	const float current = H9RDot(v, wishdir);
	const float add = wishspeed - current;
	if (add <= 0)
		return;
	float pull = accel * dt * wishspeed * pmFriction;
	if (pull > add)
		pull = add;
	if (fmove < 0 && H9RLen(v) > H9R_REVERSE_PULL_LIMIT)
		pull = 0;
	for (int i = 0; i < 3; i++)
		v[i] += pull * wishdir[i];
}

// The two halves of the gravity around the move (HLR pm_shared.c PM_AddCorrectGravity and PM_FixupGravityVelocity), and the base
// velocity's z that is folded into the first.
static inline float H9RallyGravityHalf(float vz, float entGravity, float mvGravity, float dt)
{
	return vz - entGravity * mvGravity * 0.5f * dt;
}

// The car's tilt from the four terrain points (HLR rally.c PM_PlayerAngles): `f1`, `f2`, `b1`, `b2` are the ends of the four traces,
// front right, front left, back right and back left of a car heading `yawDegrees`. Gives the pitch and the roll to put in the angles.
static inline void H9RallyTilt(const float f1[3], const float f2[3], const float b1[3], const float b2[3], float yawDegrees, float* pitch, float* roll)
{
	float du[3], dv[3], n1[3], n2[3];
	for (int i = 0; i < 3; i++)
	{
		du[i] = b2[i] - f1[i];
		dv[i] = b2[i] - f2[i];
	}
	n1[0] = du[1] * dv[2] - du[2] * dv[1];
	n1[1] = du[2] * dv[0] - du[0] * dv[2];
	n1[2] = du[0] * dv[1] - du[1] * dv[0];
	for (int i = 0; i < 3; i++)
	{
		du[i] = f1[i] - b2[i];
		dv[i] = f1[i] - b1[i];
	}
	n2[0] = du[1] * dv[2] - du[2] * dv[1];
	n2[1] = du[2] * dv[0] - du[0] * dv[2];
	n2[2] = du[0] * dv[1] - du[1] * dv[0];
	float n[3];
	for (int i = 0; i < 3; i++)
		n[i] = (n1[i] + n2[i]) * 0.5f;
	const double ang = (double)yawDegrees * 0.0174532;
	const double r0 = n[0] * cos(ang) + n[1] * sin(ang);
	const double r1 = -(n[0] * sin(ang)) + n[1] * cos(ang);
	const double r2 = n[2];
	const double rad = 180.0 / 3.14159265358979323846;
	*pitch = (float)((atan2(r2, r0) * rad - 90.0) * -1.0);
	*roll = (float)(atan2(r2, r1) * rad - 90.0);
}

// The tilt kept from one command to the next. HL Rally keeps the car's angles (pitch, yaw, roll) of the command before in vuser1 and
// looks for the ground along them (rally.c PM_PlayerAngles:161), and its client reads them for the slip (input.cpp:1056). The fields
// that are predicted and networked for a player and that nothing of The Specialists' reads in a car (no weapons) are vuser4 (the three
// angles) and vuser3.x (a mark that says the angles are ours: dlls/h9_rally_srv.cpp copies both into the client data of a car). The
// wire carries a field as a signed 10-bit integer (game/ts/delta.lst), so the angles go in half degrees (180 degrees is 360, inside
// 511). `mark` and `ang` are the two fields as a pmove has them.
#define H9R_TILT_MARK 211.0f
#define H9R_TILT_SCALE 2.0f
static inline float H9RallyWrap180(float a)
{
	a = fmodf(a, 360.0f);
	if (a > 180.0f)
		a -= 360.0f;
	else if (a < -180.0f)
		a += 360.0f;
	return a;
}
static inline void H9RallyTiltPack(float pitch, float yaw, float roll, float* mark, float ang[3])
{
	*mark = H9R_TILT_MARK;
	ang[0] = floorf(H9RallyWrap180(pitch) * H9R_TILT_SCALE + 0.5f);
	ang[1] = floorf(H9RallyWrap180(yaw) * H9R_TILT_SCALE + 0.5f);
	ang[2] = floorf(H9RallyWrap180(roll) * H9R_TILT_SCALE + 0.5f);
}
// False when the fields are not a car's tilt (never written: a weapon's values, or zero).
static inline bool H9RallyTiltUnpack(float mark, const float ang[3], float* pitch, float* yaw, float* roll)
{
	if (fabsf(mark - H9R_TILT_MARK) > 0.01f)
		return false;
	*pitch = ang[0] / H9R_TILT_SCALE;
	*yaw = ang[1] / H9R_TILT_SCALE;
	*roll = ang[2] / H9R_TILT_SCALE;
	return true;
}
// What the stored tilt is in the air (rally.c PM_PlayerAngles:254-255): pitch and roll cleared, the yaw left as it was.

// A plane clips a velocity (HLR PM_ClipVelocity): the part into the plane, times the overbounce, comes off. No epsilon: a small
// component is left as it is.
static inline void H9RallyClip(const float in[3], const float normal[3], float overbounce, float out[3])
{
	const float backoff = H9RDot(in, normal) * overbounce;
	for (int i = 0; i < 3; i++)
		out[i] = in[i] - normal[i] * backoff;
}

// What the planes a move met do to the velocity in the air, or when the entity's friction is not 1 (HLR PM_FlyMove's first branch):
// every plane in turn, floors (nz over 0.9) at overbounce 1 and carried into the next, the others at 1.1 off the carried velocity
// (not carried). `original` is carried; `out` is the velocity the last plane left.
static inline void H9RallyClipPlanesAir(float original[3], const float planes[][3], int numplanes, float out[3])
{
	float next[3] = {original[0], original[1], original[2]};
	for (int i = 0; i < numplanes; i++)
	{
		if (planes[i][2] > H9R_CLIP_FLOOR)
		{
			H9RallyClip(original, planes[i], 1.0f, next);
			original[0] = next[0];
			original[1] = next[1];
			original[2] = next[2];
		}
		else
			H9RallyClip(original, planes[i], H9R_CLIP_WALL, next);
	}
	out[0] = next[0];
	out[1] = next[1];
	out[2] = next[2];
}

// What a wall does to a car (HLR PM_Crash), whenever the body's trace meets it: the velocity loses 1.2 of its part along the
// wall's normal, into the wall or away from it, then the whole is scaled by (2 + cos) / 3, cos the angle the wall turned it.
static inline float H9RallyCrashKeep(float cosTurned)
{
	return (cosTurned + 2.0f) / 3.0f;
}
static inline void H9RallyCrashVelocity(float v[3], const float normal[3])
{
	const float old[3] = {v[0], v[1], v[2]};
	const float backoff = H9RDot(v, normal);
	for (int i = 0; i < 3; i++)
		v[i] -= normal[i] * backoff * H9R_WALL_BACKOFF;
	float a[3] = {v[0], v[1], v[2]}, b[3] = {old[0], old[1], old[2]};
	H9RNormalize(a);
	H9RNormalize(b);
	const float keep = H9RallyCrashKeep(H9RDot(a, b));
	for (int i = 0; i < 3; i++)
		v[i] *= keep;
}

// How far the heading turns this frame, in degrees (positive: to the left), by the plain rule of 400 degrees a second at any
// speed (HL Rally's CL_AdjustAngles before its client filters the steering: that filter is the client's, cl_dll/input.cpp).
// `steerInput` is the keys: left 1, right -1, or in between when a key was pressed or let go within the frame.
static inline float H9RallySteer(float steerInput, float dt)
{
	return steerInput * H9R_STEER_RATE * dt;
}

// ------------------------------------------------------------------------------------------------------------
//  The decisions the pmove side makes, as plain functions (so rally_test drives them with no engine).
// ------------------------------------------------------------------------------------------------------------

// Held (the countdown): the race's FL_FROZEN, and nothing else. HL Rally rewrites maxspeed every frame; The
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

// Is the car on the ground? HL Rally: the trace found anything at all (`hitEnt` is the entity it hit, -1 for none), and the car is
// not shooting up faster than 1800. No test of how steep the hit is.
static inline bool H9RallyIsGround(int hitEnt, float velocityZ)
{
	if (velocityZ > H9R_LIFT_VZ)
		return false;
	return hitEnt != -1;
}

// The kerb retry: the slide's and the stepped-up move's distances (squared, in the plane). HL Rally keeps the slide only when it
// went farther: on a tie the stepped move wins.
static inline bool H9RallySteppedWins(float slideDist2, float steppedDist2)
{
	return !(slideDist2 > steppedDist2);
}

// A body contact HL Rally's PM_Crash lets pass: in the air, a plane with nz over 0.3. On the ground nothing passes.
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
// apart over 37 (5 points), at the heights stepsize, stepsize + 8, ... while under the car's 16 (4 and 12 at sv_stepsize 4; none
// from a stepsize of 16). Returns how many were written.
static inline int H9RallyCrashPoints(const H9RallySides& sides, float stepsize, float out[][3], int maxPoints)
{
	int n = 0;
	const float half = H9R_LENGTH * 0.5f, halfW = H9R_WIDTH * 0.5f;
	int row = 0;
	for (int v = (int)stepsize; v < (int)H9R_HEIGHT; v += (int)H9R_TRACE_GAP, row++)
	{
		const float z = stepsize + H9R_TRACE_GAP * (float)row;
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
// The car's tilt as the last command left it (H9RallyTiltPack's fields of the predicted pmove): for the client's slip share. False when none.
bool H9RallyStoredTilt(float* pitch, float* yaw, float* roll);
#endif
