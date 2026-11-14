/***
*  h9_car.cpp -- h9_car, a car a player drives (H9; vehicles/DESIGN.md in h9-maps, phase 1).
*
*  A point entity with a studio model. A player who presses +use on it takes the wheel: he is hidden and held
*  inside it, his weapons are put away, and he sees the car from a camera that follows it. W and S drive and
*  brake, A and D steer, jump is the handbrake, +use gets out beside the car, and R held a second puts a stuck car
*  back where it last stood on four wheels touching nothing.
*
*  The car is an arcade car, not a rigid body (the method of Diffusion's func_car, written anew here): its
*  steering is one angle, and its nose turns about its rear axle as a bicycle does (yaw rate = speed * tan(steer) /
*  wheelbase). Each frame it moves itself: a hull trace and the bumper traces stop it at walls (it slides along
*  one it meets at a slant), and four traces down, one under each wheel, set its height, its pitch and its roll.
*  A rise the wheels cannot climb (more than "maxstep") is a wall. Gravity along the slope slows it uphill.
*
*  Its handling is a rally car's (the method of HL Rally's car, written anew here). Its speed is two numbers, along
*  its nose and across it, so its path need not be where it points. The tyres pull the path round to the nose with
*  what the ground under them gives (H9CAR_GRIP, by the surface, by the "grip" key): a corner that asks for more
*  (speed squared * tan(steer) / wheelbase) leaves the car drifting wide with its nose turned in, and the drift
*  scrubs speed off. The handbrake lets the rear go: the nose comes round fast about the front while the path goes
*  on. Power on gravel or dirt steps the rear out a little; lifting tucks it back in. The surface is read from the
*  name of the texture under each wheel (g_h9SurfaceNames; race01's FINAL.md, contract 1) and from the water a
*  wheel stands in; a name the table does not know drives as tarmac. In the air (no wheel down, or the body more
*  than H9CAR_AIRGAP over its wheels' ground) nothing steers or drives it: it keeps the speed it left with, rises
*  and falls with the slope it left, and loses a little speed by how hard it lands. All of this is in the plain
*  functions H9CarStep and H9CarFallStep, which dlls/tests/car_test.cpp also compiles and runs with no game.
*
*  For other code (a race's sounds, smoke, a speedometer): pev->fuser4 is how much the tyres slide (not fuser1: the sound code lowers the pitch of an entity by its fuser1), 0 to 1, and
*  pev->fuser2 the speed along the nose, negative backwards; pev->fuser3 is its top speed ("maxspeed").
*
*  It takes the player's controls through CBasePlayer::m_pTank, the hook func_tank uses: while it is set the
*  player's weapons do nothing (ItemPostFrame), his death and his respawn call Use(USE_OFF), and every PostThink
*  asks OnControls() whether he is still at the wheel (Use(USE_SET, 2)). So nothing in player.cpp changes.
*  TS calls PlayerUse from ImpulseCommands, inside ItemPostFrame, which returns at once while m_pTank is set: the
*  player code never sees +use in the car, so the car reads it itself (a press, after the one that got him in).
*  While he drives, the driver is SOLID_NOT and the car is his owner, so that the car's traces pass through him
*  (he rides inside it, and TS gives a player back his solid each frame).
*
*  The model's bone controllers 0 and 1 turn the left and the right front wheel (degrees of steer: one controller
*  turns one bone), and its sequence 0 rolls every wheel once a cycle: it is played at the wheels' turns a second,
*  backwards when the car reverses. A model with neither still drives (h9-maps art/h9-car.mjs makes car.mdl so).
*
*  Keys (units are Half-Life's; speeds in units a second):
*    model          the studio model (default models/h9/car.mdl); a car whose model is not on disk is removed
*    maxspeed 900   backspeed 300   accel 450   brake 1200   coast 150 (the slowing with nothing pressed)
*    maxturn 35     (the front wheels' greatest angle, degrees)   turnrate 150 (degrees a second)
*    frontdist 75   reardist 75   (the axles from the origin)   track 88 (between the wheels of one axle)
*    length 200   width 100   height 64   (the body, for collision; the origin is on the ground, at the middle)
*    radius 20      (the wheels')   maxstep 12 (the highest rise the wheels climb)
*    enginesnd      the engine's loop (default plats/ttrain2.wav, pitched by speed)
*    grip 1         (all the tyres' hold, a scale: 0.8 a looser car, 1.3 one on rails)
*    slide 1        (how fast a slide bleeds away, a scale: under 1 long drifts, over 1 it bites back at once)
*    handbrake 1    (how much the handbrake lets the rear go and slows the car, a scale; 0 turns it off)
*    gravity 800    (the fall, and the pull along a slope; less makes longer jumps)
***/
#ifndef H9CAR_MATHS_ONLY // the test harness compiles the plain functions alone, with none of the game's headers
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "monsters.h"
#include "weapons.h"
#include "player.h"
#include "gamerules.h"
#include "race.h"
#endif

#include <math.h>
#include <string.h>

#define H9CAR_GRAVITY 800.0f   // sv_gravity's default: the fall, and the pull along a slope ("gravity")
#define H9CAR_CRAWL 20.0f      // under this speed the car counts as standing still
#define H9CAR_SLOPE 3.0f       // degrees: a gentler slope does not roll the car
#define H9CAR_PUSH 25.0f       // the least speed while pushed into a wall, so it slides along it
#define H9CAR_RESET_HOLD 1.0f  // seconds R is held to put a stuck car back at its last safe place
#define H9CAR_EXIT_GAP 24.0f   // between the body and the player who gets out
#define H9CAR_CAM_BACK 300.0f  // the camera, behind the car
#define H9CAR_CAM_UP 110.0f    // and above its origin
#define H9CAR_CAM_LOOK 40.0f   // it looks at this height over the origin
#define H9CAR_GRIP 1100.0f     // the pull across the car that tarmac's tyres give, units a second squared
#define H9CAR_SLIDING 0.85f    // a tyre that slides already gives this much of it ("slide" scales it)
#define H9CAR_SCRUB 0.6f       // how much of the tyres' pull, in a slide, goes against the speed
#define H9CAR_SLIP_OPEN 35.0f  // degrees between nose and path at which steering stops turning the nose further in
#define H9CAR_SLIP_HAND 50.0f  // and this much further with the handbrake on
#define H9CAR_HAND_BRAKE 0.2f  // the handbrake slows the car by this share of "brake": it holds the rear wheels only
#define H9CAR_HAND_REAR 0.65f  // and takes this share of the tyres' hold across the car away
#define H9CAR_HAND_YAW 1.6f    // and brings the nose round this much faster
#define H9CAR_BOG 2.0f         // over a surface's top speed the car loses this share of the excess a second
#define H9CAR_SUBSTEP 0.02f    // the longest step the handling takes at once: a longer frame is cut into several
#define H9CAR_AIRGAP 4.0f      // the body this far over its wheels' ground is in the air
#define H9CAR_LAND 250.0f      // a landing harder than this (units a second, down) costs speed
#define H9CAR_LOOK 0.1f        // seconds between two readings of the texture under one wheel
#define H9_RAD 0.017453292f    // a degree, in radians

static float H9Approach(float target, float value, float step)
{
	if (value < target)
		return value + step < target ? value + step : target;
	return value - step > target ? value - step : target;
}

static float H9Clamp(float value, float low, float high)
{
	return value < low ? low : (value > high ? high : value);
}

//=========================================================
// The surfaces. One table: what each gives the tyres. A wheel's surface is found by the start of its floor
// texture's name (H9SurfaceByName), and a wheel standing in water is on water whatever the bed is made of.
//=========================================================
enum
{
	H9SURF_TARMAC,
	H9SURF_GRAVEL,
	H9SURF_DIRT,
	H9SURF_GRASS,
	H9SURF_WATER,
	H9SURF_COUNT
};

struct H9Surface
{
	const char* name;
	float grip;  // of tarmac's hold across the car; braking and pulling away follow it too
	float top;   // the share of "maxspeed" the car reaches on it
	float roll;  // the slowing it adds, units a second squared, when the car coasts or is over that top speed
	float loose; // how much the rear steps out under power: 0 none, 1 gravel
};

static const H9Surface g_h9Surfaces[H9SURF_COUNT] = {
	{"tarmac", 1.00f, 1.00f, 0, 0},
	{"gravel", 0.70f, 0.92f, 40, 1.0f},
	{"dirt", 0.60f, 0.88f, 60, 1.0f},
	{"grass", 0.45f, 0.72f, 150, 0.4f},
	{"water", 0.55f, 0.50f, 400, 0}, // a film of it; H9SurfaceAdd deepens it
};
#define H9CAR_DEEP_TOP 0.25f   // water a wheel's height deep: the top speed's share
#define H9CAR_DEEP_ROLL 900.0f // and the slowing

static const struct
{
	const char* start;
	int surface;
} g_h9SurfaceNames[] = {
	{"tarmac", H9SURF_TARMAC}, {"road", H9SURF_TARMAC}, {"start", H9SURF_TARMAC}, {"gravel", H9SURF_GRAVEL},
	{"dirt", H9SURF_DIRT}, {"grass", H9SURF_GRASS}, {"verge", H9SURF_GRASS}, {"hill", H9SURF_GRASS},
	{"water", H9SURF_WATER},
};

// The surface a texture's name stands for. The marks a name may begin with are passed over first ("~", "{", "!",
// "*", "+0" and "-0" with their digit or letter), and capitals count as small letters. A name the table does not
// know, or none, is tarmac.
static int H9SurfaceByName(const char* name)
{
	if (!name)
		return H9SURF_TARMAC;
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
	for (const auto& known : g_h9SurfaceNames)
	{
		const char *a = name, *b = known.start;
		while (*b && (*a | 0x20) == *b) // the table's names are small letters
		{
			a++;
			b++;
		}
		if (!*b)
			return known.surface;
	}
	return H9SURF_TARMAC;
}

// What the car has under it: the mean of its grounded wheels, the slope, and whether it is in the air.
struct H9CarGround
{
	float grip = 1, top = 1, roll = 0, loose = 0;
	float pitch = 0; // the body's, nose up, degrees: gravity pulls along it
	float gravity = H9CAR_GRAVITY;
	bool airborne = false;
};

// One wheel's surface added to a sum (H9CarGround's four numbers; divide by the wheels counted). `depth` is how
// deep the wheel stands in water, 0 dry to 1 its whole height.
static void H9SurfaceAdd(H9CarGround& sum, int surface, float depth)
{
	if (surface < 0 || surface >= H9SURF_COUNT)
		surface = H9SURF_TARMAC;
	const H9Surface& s = g_h9Surfaces[surface];
	float top = s.top, roll = s.roll;
	if (surface == H9SURF_WATER)
	{
		depth = H9Clamp(depth, 0, 1);
		top += (H9CAR_DEEP_TOP - top) * depth;
		roll += (H9CAR_DEEP_ROLL - roll) * depth;
	}
	sum.grip += s.grip;
	sum.top += top;
	sum.roll += roll;
	sum.loose += s.loose;
}

struct H9CarTune // the keys the handling reads
{
	float maxSpeed = 900, backSpeed = 300, accel = 450, brake = 1200, coast = 150;
	float maxTurn = 35, turnRate = 150, wheelbase = 150;
	float grip = 1, slide = 1, handbrake = 1;
};

struct H9CarInput
{
	int push = 0; // the throttle: 1 W, -1 S, 0 neither
	int turn = 0; // 1 left, -1 right
	bool handbrake = false;
};

struct H9CarMotion
{
	float forward = 0; // the speed along the nose; negative backwards
	float side = 0;    // the speed across it, positive to the left: 0 while the tyres hold
	float steer = 0;   // the front wheels, degrees, positive to the left
	float hand = 0;    // the handbrake, 0 off to 1 on: on in a tenth of a second, off over a third
	float slip = 0;    // how much the tyres slide, 0 to 1 (for sounds and smoke)
};

// One short step of the handling (H9CarStep cuts a frame into these). It returns the turn of the nose, degrees.
// Nothing in it adds speed but the engine and a downhill slope: the turn of the nose and the tyres' pull only
// turn the speed, and a slide takes some away.
static float H9CarStepOnce(H9CarMotion& m, const H9CarTune& t, const H9CarInput& in, const H9CarGround& g, float dt)
{
	const float maxSpeed = t.maxSpeed > 1 ? t.maxSpeed : 1;
	m.hand = H9Approach(in.handbrake ? 1.0f : 0.0f, m.hand, dt * (in.handbrake ? 10.0f : 3.0f));

	// less lock at speed, as a driver gives it; the wheels ease back when let go
	const float lock = t.maxTurn * (1 - 0.45f * H9Clamp(fabsf(m.forward) / maxSpeed, 0, 1));
	const float target = in.turn == 0 ? 0 : (in.turn > 0 ? lock : -lock);
	m.steer = H9Approach(target, m.steer, t.turnRate * (target == 0 ? 1.5f : 1.0f) * dt);

	if (g.airborne) // nothing touches the ground: it keeps the speed it has, both ways, and the nose stays
	{
		m.slip = H9Approach(0, m.slip, dt * 5);
		return 0;
	}

	const float surface = H9Clamp(g.grip, 0, 1);
	const float traction = 0.5f + 0.5f * surface; // pulling away on a loose surface
	const float bite = 0.25f + 0.75f * surface;   // and braking on one
	const float cap = maxSpeed * H9Clamp(g.top, 0.05f, 1);
	float slow = 0; // what slows it along its path, whichever way that goes

	// A crawl (under H9CAR_CRAWL) counts as standing still when choosing between braking and driving off: otherwise a
	// speed a hair over 0 (the slope's pull on a floor read at -0.001 degrees) is braked to 0 every frame, the pull
	// puts the hair back, and S (or W) never reverses it.
	if (in.push > 0)
	{
		if (m.forward < -H9CAR_CRAWL)
			slow += t.brake * bite;
		else
		{
			if (m.forward < 0)
				m.forward = 0;
			if (m.forward < cap)
				m.forward += t.accel * traction * dt * (1 - m.forward / cap);
		}
	}
	else if (in.push < 0)
	{
		if (m.forward > H9CAR_CRAWL)
			slow += t.brake * bite;
		else
		{
			if (m.forward > 0)
				m.forward = 0;
			m.forward -= t.accel * traction * dt;
		}
	}
	else
		slow += t.coast + g.roll;
	slow += t.brake * H9CAR_HAND_BRAKE * H9Clamp(t.handbrake, 0, 2) * bite * m.hand;

	float speed = sqrtf(m.forward * m.forward + m.side * m.side);
	if (speed > cap) // grass, water: the ground holds it back to what it lets a car do
		slow += g.roll + (speed - cap) * H9CAR_BOG;
	if (slow > 0 && speed > 0)
	{
		const float left = speed - slow * dt > 0 ? (speed - slow * dt) / speed : 0;
		m.forward *= left;
		m.side *= left;
	}
	if (in.push == 0 && sqrtf(m.forward * m.forward + m.side * m.side) < H9CAR_CRAWL) // let go, it stops
		m.forward = m.side = 0;
	// gravity along the slope (uphill slows, downhill speeds up), only on a real slope: a floor read a hair off level
	// must not push (Diffusion lets a slope roll the car only past 10 degrees)
	if (fabsf(g.pitch) > H9CAR_SLOPE)
		m.forward -= g.gravity * sinf(g.pitch * H9_RAD) * dt;
	m.forward = H9Clamp(m.forward, -t.backSpeed, maxSpeed);
	m.side = H9Clamp(m.side, -maxSpeed, maxSpeed);

	// The nose. It turns as a bicycle's does about the rear axle. `beta` is the angle from the way the car points
	// (or backs) to the way it goes, positive when it goes to the left of it: turning the nose left makes it less.
	speed = sqrtf(m.forward * m.forward + m.side * m.side);
	float dir = m.forward >= 0 ? 1.0f : -1.0f;
	float beta = speed > 0.01f ? atan2f(m.side * dir, m.forward * dir) : 0;
	const float wheelbase = t.wheelbase > 1 ? t.wheelbase : 1;
	const float hold = H9CAR_GRIP * g.grip * t.grip; // what the tyres can pull across the car
	const float hand = m.hand * H9Clamp(t.handbrake, 0, 1.4f);
	const float loose = in.push * dir > 0 ? g.loose : 0; // power on a loose surface
	// with the handbrake the car comes round about its front wheels, which roll at the whole speed, not only at the
	// part of it along the nose
	const float rolling = m.forward + (dir * speed - m.forward) * H9Clamp(hand, 0, 1);
	float yawRate = rolling * tanf(m.steer * H9_RAD) / wheelbase; // radians a second
	const float asked = fabsf(m.forward * yawRate);              // the pull across the car this corner asks for
	if (yawRate * beta <= 0)
	{
		// The steering is opening the slide (or there is none yet). The further the nose is already inside the path,
		// the less it turns further in: a corner taken too fast settles into a drift at a steady angle instead of
		// spinning. The handbrake, and power on a loose surface, bring the nose round faster and let it go further.
		const float open = (H9CAR_SLIP_OPEN + H9CAR_SLIP_HAND * H9Clamp(hand, 0, 1) + 10 * loose) * H9_RAD;
		const float over = hold > 1 ? H9Clamp((asked / hold - 0.5f) * 2, 0, 1) : 1; // from half of what the tyres hold
		yawRate *= (1 + H9CAR_HAND_YAW * hand + 0.3f * loose * over) * H9Clamp(1 - fabsf(beta) / open, 0, 1);
	}
	const float turn = H9Clamp(yawRate * dt, -0.5f, 0.5f);
	const float c = cosf(turn), s = sinf(turn);
	const float ahead = m.forward * c + m.side * s; // the speed stays where it was in the world: the nose turned under it
	m.side = m.side * c - m.forward * s;
	m.forward = ahead;

	// The tyres. They turn the path round to the nose, by as much as their hold allows in this step, and leave its
	// speed alone: while the corner asks for less than they hold, the whole of the turn is taken up each step and the
	// car goes where it points, as it always did. What is left over is the slide, and it scrubs speed off.
	float sliding = 0;
	if (speed > 0.01f)
	{
		dir = m.forward >= 0 ? 1.0f : -1.0f;
		beta = atan2f(m.side * dir, m.forward * dir);
		const float wide = fabsf(beta);
		// the rear let go: by the handbrake, and a little by power on a loose surface
		float pull = hold * H9Clamp(1 - H9CAR_HAND_REAR * hand, 0.05f, 1) * (1 - 0.2f * loose);
		float back = pull * dt / (speed > 1 ? speed : 1);
		// tyres that slide already hold less than tyres that roll: by what they could not take up in this step, from
		// nothing to 10 degrees of it
		const float broken = H9Clamp((wide - back) / (10 * H9_RAD), 0, 1);
		pull *= 1 + (H9Clamp(H9CAR_SLIDING * t.slide, 0.05f, 3) - 1) * broken;
		back = pull * dt / (speed > 1 ? speed : 1);
		const float kept = wide > back ? wide - back : 0;
		speed -= pull * sinf(kept) * H9CAR_SCRUB * dt;
		if (speed < 0)
			speed = 0;
		m.forward = dir * speed * cosf(kept);
		m.side = dir * speed * sinf(beta < 0 ? -kept : kept);
		sliding = H9Clamp(kept / (25 * H9_RAD), 0, 1) * H9Clamp(speed / 200, 0, 1);
	}
	m.slip += (sliding - m.slip) * H9Clamp(dt * 12, 0, 1);
	return turn / H9_RAD;
}

// One frame of the handling: throttle, brake, steering, the turn of the nose, the slide. It changes `m` and
// returns the turn of the nose in degrees. A long frame is cut into steps of H9CAR_SUBSTEP at most, so that the
// car drives the same at 20 frames a second as at 1000.
static float H9CarStep(H9CarMotion& m, const H9CarTune& t, const H9CarInput& in, const H9CarGround& g, float dt)
{
	if (!(dt > 0))
		return 0;
	int steps = (int)ceilf(dt / H9CAR_SUBSTEP);
	steps = steps < 1 ? 1 : (steps > 50 ? 50 : steps);
	float turn = 0;
	for (int i = 0; i < steps; i++)
		turn += H9CarStepOnce(m, t, in, g, dt / steps);
	return turn;
}

// The body's height over a frame.
struct H9CarHeight
{
	float z = 0;
	float fall = 0;        // the vertical speed while off the ground (negative down); 0 on it
	float climb = 0;       // the vertical speed the ground gives it while on it: what it leaves the ground with
	float slopeAlong = 0;  // the ground's rise a unit forward, under the four wheels when all four last stood on it
	float slopeAcross = 0; // and a unit to the right
	bool contact = true;   // on the ground, the frame before
	bool airborne = false; // no wheel down, or the body more than H9CAR_AIRGAP over its wheels' ground
};

// The height of the ground under the car's middle, from what its wheels found (`ground`, for those `touching`;
// `along` and `across` are each wheel's place forward and to the right of the middle). It returns how many wheels
// touch. With all four down it is their mean, and the slope they stand on is kept. With some in the air (the
// front over a ramp's lip) the others say where the middle would be were that slope to go on: so the body rides
// off a lip along the ramp's line until its last wheel leaves, instead of dropping to its rear wheels' height.
// With none, the slope is forgotten, and a car that lands on two wheels stands at their height.
static int H9CarFloor(H9CarHeight& h, const float ground[4], const bool touching[4], const float along[4],
	const float across[4], float wheelbase, float track, float& floor)
{
	int count = 0;
	for (int i = 0; i < 4; i++)
		count += touching[i] ? 1 : 0;
	if (count == 4) // the wheels are front left, front right, rear left, rear right
	{
		h.slopeAlong = ((ground[0] + ground[1]) / 2 - (ground[2] + ground[3]) / 2) / (wheelbase > 1 ? wheelbase : 1);
		h.slopeAcross = ((ground[1] + ground[3]) / 2 - (ground[0] + ground[2]) / 2) / (track > 1 ? track : 1);
	}
	else if (count == 0)
		h.slopeAlong = h.slopeAcross = 0;
	float sum = 0;
	for (int i = 0; i < 4; i++)
	{
		if (touching[i])
			sum += ground[i] - (count < 4 ? along[i] * h.slopeAlong + across[i] * h.slopeAcross : 0);
	}
	floor = count ? sum / count : h.z;
	return count;
}

// One frame of the body's height. `wheels` is how many wheels found ground and `floor` the ground under the
// car's middle (H9CarFloor); `rate` is the vertical speed that ground gives the car (its speed over the slope
// under it). The body always flies the arc its vertical speed and gravity give, and is on the ground when that
// arc would take it into the floor: so it follows a slope down without leaving it, leaves a ramp's lip with the
// rise the ramp gave it, and goes light over a crest. It returns how hard it landed, units a second (0 when it
// did not land this frame).
static float H9CarFallStep(H9CarHeight& h, int wheels, float floor, float rate, float gravity, float dt)
{
	if (!(dt > 0)) // placed, not moved: on its wheels' ground when it has any
	{
		if (wheels > 0)
		{
			h.z = floor;
			h.fall = 0;
			h.contact = true;
		}
		h.airborne = wheels == 0;
		return 0;
	}
	float impact = 0;
	if (h.contact)
		h.fall = h.climb;
	h.fall -= gravity * dt;
	const float z = h.z + h.fall * dt;
	if (wheels > 0 && z <= floor)
	{
		if (!h.contact)
		{
			impact = rate - h.fall > 0 ? rate - h.fall : 0;
			h.climb = rate;
		}
		else // eased, so that a kerb's one frame of slope does not throw the car up
			h.climb += (rate - h.climb) * H9Clamp(dt * 20, 0, 1);
		h.z = floor;
		h.fall = 0;
		h.contact = true;
	}
	else
	{
		h.z = z;
		h.contact = false;
	}
	h.airborne = wheels == 0 || h.z - floor > H9CAR_AIRGAP;
	return impact;
}

// The share of its speed a landing leaves the car: a soft one all of it, the hardest two thirds.
static float H9CarLanding(float impact)
{
	return 1 - H9Clamp((impact - H9CAR_LAND) / 1500, 0, 0.35f);
}

#ifndef H9CAR_MATHS_ONLY

//=========================================================
// The camera a driver looks through: an entity with the car's model drawn fully transparent (an entity with no
// model, or one marked EF_NODRAW, is not sent to the client, and SET_VIEW needs it sent), placed by the car.
//=========================================================
class CH9CarCamera : public CBaseEntity
{
public:
	void Spawn() override
	{
		pev->classname = MAKE_STRING("h9_car_camera");
		pev->movetype = MOVETYPE_NOCLIP;
		pev->solid = SOLID_NOT;
		pev->rendermode = kRenderTransTexture;
		pev->renderamt = 0;
		pev->takedamage = DAMAGE_NO;
	}
	int ObjectCaps() override { return FCAP_DONT_SAVE; }
};
LINK_ENTITY_TO_CLASS(h9_car_camera, CH9CarCamera);

//=========================================================
// The car.
//=========================================================
class CH9Car : public CBaseAnimating
{
public:
	void Spawn() override;
	void Precache() override;
	bool KeyValue(KeyValueData* pkvd) override;
	int ObjectCaps() override { return (CBaseAnimating::ObjectCaps() & ~FCAP_ACROSS_TRANSITION) | FCAP_IMPULSE_USE; }
	void Use(CBaseEntity* pActivator, CBaseEntity* pCaller, USE_TYPE useType, float value) override;
	bool OnControls(entvars_t* pevTest) override;

	void EXPORT DriveThink();
	void Step(const char* by);

private:
	friend class CRacePick;
	void PutAt(const Vector& origin, float yaw);
	CBasePlayer* Driver();
	void TakeWheel(CBasePlayer* pPlayer);
	void LeaveWheel(CBasePlayer* pPlayer);
	bool ExitSpot(CBasePlayer* pPlayer, Vector& spot);
	void Steer(CBasePlayer* pDriver, float dt);
	bool Move(float dt);
	bool Blocked(const Vector& from, const Vector& move, TraceResult& hit);
	void Settle(float dt);
	void LookUnder(int wheel, const TraceResult& tr, const Vector& above, const Vector& below);
	void PlaceCamera(float dt);
	void FitBox();
	void Sound();

	// tuning (keys)
	float m_flMaxSpeed = 900, m_flBackSpeed = 300, m_flAccel = 450, m_flBrake = 1200, m_flCoast = 150;
	float m_flMaxTurn = 35, m_flTurnRate = 150;
	float m_flFrontDist = 75, m_flRearDist = 75, m_flTrack = 88;
	float m_flLength = 200, m_flWidth = 100, m_flHeight = 64;
	float m_flRadius = 20, m_flMaxStep = 12;
	float m_flGrip = 1, m_flSlide = 1, m_flHandbrake = 1, m_flGravity = H9CAR_GRAVITY;
	string_t m_iszEngine = 0;
	int m_iSlot = 0; // "slot": its place on a race's grid (1 = pole); 0 is a car of no race

	// state
	Vector m_vecHome = g_vecZero; // where the mapper put it: its grid place
	float m_flHomeYaw = 0;
	int m_iRound = 0;             // the race's round it was last put on the grid for
	int m_iRaceState = 0;         // the race's state, the frame before
	bool m_bHeld = false;         // the race holds it (countdown, finished): no drive
	bool m_bGhost = false;        // held after its race (finished, out of time): it rolls to a stop and nothing hits it
	float m_flUseHeld = 0;        // seconds +use has been held in a race: a second of it gets him out
	EHANDLE m_hDriver;
	EHANDLE m_hCamera;
	H9CarMotion m_car;       // its speed along the nose and across it, its steering, how much it slides
	H9CarGround m_ground;    // what its wheels stood on, the last Settle
	H9CarHeight m_height;    // its height, and its vertical speed off the ground
	float m_flYaw = 0;       // the heading
	float m_flPitch = 0;     // nose up, degrees
	float m_flRoll = 0;
	float m_flLastThink = 0;
	float m_flNextSound = 0;
	bool m_bEngineOn = false;
	bool m_bGrounded = true;
	int m_iLastButtons = 0; // the driver's, the command before: a +use press gets him out
	bool m_bUsePressed = false;
	float m_flLastDt = 0;
	int m_iPush = 0;           // the driver's throttle: 1 W, -1 S, 0 neither
	bool m_bAllWheels = true;  // all four wheels on the ground, the last Settle
	Vector m_vecSafe = g_vecZero; // the last place it stood on four wheels, touching nothing (R held puts it back)
	float m_flSafeYaw = 0;
	bool m_bHasSafe = false;
	Vector m_vecPending = g_vecZero; // a place on its way to becoming the safe one
	float m_flPendingYaw = 0, m_flPendingAt = 0;
	bool m_bPending = false;
	float m_flResetHeld = 0;   // seconds R has been held
	float m_flEntered = 0;
	float m_flNextReport = 0; // developer 1: what the car sees, twice a second
	float m_flLastHit = 1;
	int m_iHitBy = -1, m_iLastHitBy = -1; // which trace stopped it: 0 the hull, 1-6 the bumper rays, 7-10 the flank's
	float m_flLastHitTime = -1;
	char m_szLastHit[32] = "";
	float m_flWheelGround[4] = {0, 0, 0, 0}; // each wheel's ground, the frame before: its trace starts over it
	float m_flFrontGround = 0, m_flRearGround = 0; // under each axle: the bumper rays go at a height over it
	int m_iWheelSurface[4] = {0, 0, 0, 0};     // each wheel's surface (H9SURF_), read every H9CAR_LOOK seconds
	float m_flWheelDepth[4] = {0, 0, 0, 0};    // how deep it stands in water, 0 dry to 1 its whole height
	float m_flWheelLook[4] = {0, 0, 0, 0};     // when it is read next
};
LINK_ENTITY_TO_CLASS(h9_car, CH9Car);

bool CH9Car::KeyValue(KeyValueData* pkvd)
{
	struct Key
	{
		const char* name;
		float* value;
	};
	const Key keys[] = {
		{"maxspeed", &m_flMaxSpeed}, {"backspeed", &m_flBackSpeed}, {"accel", &m_flAccel}, {"brake", &m_flBrake},
		{"coast", &m_flCoast}, {"maxturn", &m_flMaxTurn}, {"turnrate", &m_flTurnRate}, {"frontdist", &m_flFrontDist},
		{"reardist", &m_flRearDist}, {"track", &m_flTrack}, {"length", &m_flLength}, {"width", &m_flWidth},
		{"height", &m_flHeight}, {"radius", &m_flRadius}, {"maxstep", &m_flMaxStep}, {"grip", &m_flGrip},
		{"slide", &m_flSlide}, {"handbrake", &m_flHandbrake}, {"gravity", &m_flGravity},
	};
	for (const Key& key : keys)
	{
		if (FStrEq(pkvd->szKeyName, key.name))
		{
			*key.value = atof(pkvd->szValue);
			return true;
		}
	}
	if (FStrEq(pkvd->szKeyName, "slot"))
	{
		m_iSlot = atoi(pkvd->szValue);
		return true;
	}
	if (FStrEq(pkvd->szKeyName, "enginesnd"))
	{
		m_iszEngine = ALLOC_STRING(pkvd->szValue);
		return true;
	}
	return CBaseAnimating::KeyValue(pkvd);
}

// True when the engine finds the file in the game folder or a fallback folder (a precache of a missing file
// stops the map).
static bool H9FileOnDisk(const char* name)
{
	int length = 0;
	byte* file = LOAD_FILE_FOR_ME((char*)name, &length);
	if (!file)
		return false;
	FREE_FILE(file);
	return true;
}

void CH9Car::Precache()
{
	if (FStringNull(pev->model))
		pev->model = MAKE_STRING("models/h9/car.mdl");
	if (FStringNull(m_iszEngine))
		m_iszEngine = MAKE_STRING("plats/ttrain2.wav");
	if (H9FileOnDisk(STRING(pev->model)))
		PRECACHE_MODEL((char*)STRING(pev->model));
	PRECACHE_SOUND((char*)STRING(m_iszEngine));
	PRECACHE_SOUND("plats/ttrain_start1.wav");
	PRECACHE_SOUND("plats/ttrain_brake1.wav");
	PRECACHE_SOUND("plats/vehicle_ignition.wav");
	PRECACHE_SOUND("debris/metal2.wav");
}

void CH9Car::Spawn()
{
	Precache();
	if (!H9FileOnDisk(STRING(pev->model)))
	{
		ALERT(at_error, "h9_car at %.0f %.0f %.0f: its model %s is not on disk; removed\n", pev->origin.x,
			pev->origin.y, pev->origin.z, STRING(pev->model));
		UTIL_Remove(this);
		return;
	}
	SET_MODEL(edict(), STRING(pev->model));
	pev->movetype = MOVETYPE_NONE; // it moves itself, in DriveThink
	pev->solid = SOLID_BBOX;
	pev->takedamage = DAMAGE_NO;
	pev->sequence = 0;
	ResetSequenceInfo();
	pev->frame = 0;
	pev->framerate = 0;
	m_flYaw = pev->angles.y;
	for (float& z : m_flWheelGround)
		z = pev->origin.z;
	m_flFrontGround = m_flRearGround = pev->origin.z;
	m_flMaxTurn = H9Clamp(m_flMaxTurn, 1, 60);
	m_flMaxStep = H9Clamp(m_flMaxStep, 0, 32);
	m_flGravity = H9Clamp(m_flGravity, 50, 4000);
	m_height.z = pev->origin.z;
	FitBox();
	Settle(0);
	m_vecHome = pev->origin;
	m_flHomeYaw = m_flYaw;
	pev->iuser4 = m_iSlot; // the race reads its driver's grid slot here
	m_vecSafe = pev->origin; // where the mapper put it is the first safe place
	m_flSafeYaw = m_flYaw;
	m_bHasSafe = true;
	m_flLastThink = gpGlobals->time;
	SetThink(&CH9Car::DriveThink);
	pev->nextthink = gpGlobals->time + 0.1;
}

CBasePlayer* CH9Car::Driver()
{
	CBaseEntity* pEntity = m_hDriver;
	if (!pEntity || !pEntity->IsPlayer())
		return NULL;
	return static_cast<CBasePlayer*>(pEntity);
}

// The player's PostThink asks this every frame while m_pTank is the car: false lets him go (Use(USE_OFF)).
bool CH9Car::OnControls(entvars_t* pevTest)
{
	CBasePlayer* pDriver = Driver();
	return pDriver && pDriver->pev == pevTest;
}

void CH9Car::Use(CBaseEntity* pActivator, CBaseEntity* pCaller, USE_TYPE useType, float value)
{
	if (!pActivator || !pActivator->IsPlayer())
		return;
	CBasePlayer* pPlayer = static_cast<CBasePlayer*>(pActivator);
	CBasePlayer* pDriver = Driver();

	if (useType == USE_OFF) // +use while driving, death, respawn: the player code clears m_pTank after this
	{
		if (pPlayer == pDriver)
			LeaveWheel(pPlayer);
		return;
	}
	// The per-frame "still at the controls" call. It runs at the client's clock (Xash's SV_RunCmd sets
	// gpGlobals->time to the client's timebase for PlayerPostThink), not the server's, so the car must not step on
	// it: a dt taken across the two clocks comes out negative or zero for whole seconds. It only keeps a +use press,
	// which a short tap could make and undo between two of the car's thinks.
	if (useType == USE_SET && value == 2)
	{
		if (pPlayer == pDriver)
		{
			const int buttons = pPlayer->pev->button;
			if ((buttons & IN_USE) && !(m_iLastButtons & IN_USE))
				m_bUsePressed = true;
			m_iLastButtons = buttons;
		}
		return;
	}
	if (pDriver || !pPlayer->IsAlive() || pPlayer->m_pTank != NULL)
		return;
	TakeWheel(pPlayer);
}

void CH9Car::TakeWheel(CBasePlayer* pPlayer)
{
	m_hDriver = pPlayer;
	pPlayer->m_pTank = this;
	if (pPlayer->m_pActiveItem)
		pPlayer->m_pActiveItem->Holster();
	pPlayer->pev->weaponmodel = 0;
	pPlayer->pev->viewmodel = 0;
	pPlayer->m_iHideHUD |= HIDEHUD_WEAPONS;
	// Not FL_FROZEN (EnableControl(false)): Xash's SV_ParseClientMove zeroes a frozen player's buttons, and the car
	// drives on them. He is held by being put back inside the car every frame instead.
	pPlayer->pev->effects |= EF_NODRAW;
	pPlayer->pev->solid = SOLID_NOT;
	pPlayer->pev->movetype = MOVETYPE_NOCLIP;
	pPlayer->pev->velocity = g_vecZero;
	pPlayer->pev->takedamage = DAMAGE_NO;
	pPlayer->pev->owner = edict(); // the car's traces pass through him
	UTIL_SetOrigin(pPlayer->pev, pev->origin + Vector(0, 0, 40));
	m_iLastButtons = pPlayer->pev->button;
	m_bUsePressed = false;
	m_flEntered = gpGlobals->time;

	if (!m_hCamera)
	{
		CBaseEntity* pCamera = GetClassPtr((CH9CarCamera*)NULL);
		pCamera->Spawn();
		SET_MODEL(pCamera->edict(), STRING(pev->model));
		UTIL_SetSize(pCamera->pev, g_vecZero, g_vecZero);
		m_hCamera = pCamera;
	}
	PlaceCamera(0);
	SET_VIEW(pPlayer->edict(), m_hCamera->edict());
	pPlayer->m_hViewEntity = m_hCamera;

	ClientPrint(pPlayer->pev, HUD_PRINTCENTER, "W/S drive, A/D steer, jump is the handbrake, use gets out\nstuck? hold R");
	EMIT_SOUND_DYN(edict(), CHAN_ITEM, "plats/vehicle_ignition.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
	EMIT_SOUND_DYN(edict(), CHAN_STATIC, STRING(m_iszEngine), 0.6, ATTN_NORM, 0, 70);
	m_bEngineOn = true;
	m_flLastThink = gpGlobals->time;
	pev->nextthink = gpGlobals->time;
}

// Beside the car, left or right, then behind, ahead, and on its roof: the first place a standing player fits.
bool CH9Car::ExitSpot(CBasePlayer* pPlayer, Vector& spot)
{
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, right = gpGlobals->v_right;
	const float side = m_flWidth / 2 + 16 + H9CAR_EXIT_GAP;
	const float back = m_flLength / 2 + 16 + H9CAR_EXIT_GAP;
	const Vector stand = Vector(0, 0, 37); // a standing player's origin over the floor
	const Vector spots[] = {
		pev->origin - right * side + stand,
		pev->origin + right * side + stand,
		pev->origin - forward * back + stand,
		pev->origin + forward * back + stand,
		pev->origin + Vector(0, 0, m_flHeight + 1) + stand,
	};
	for (const Vector& candidate : spots)
	{
		TraceResult tr;
		UTIL_TraceHull(candidate, candidate, dont_ignore_monsters, human_hull, edict(), &tr);
		if (!tr.fAllSolid && !tr.fStartSolid)
		{
			spot = candidate;
			return true;
		}
	}
	return false;
}

void CH9Car::LeaveWheel(CBasePlayer* pPlayer)
{
	Vector spot;
	if (!ExitSpot(pPlayer, spot))
		spot = pev->origin + Vector(0, 0, m_flHeight + 38); // on the roof, the last resort
	pPlayer->pev->effects &= ~EF_NODRAW;
	if (pPlayer->pev->owner == edict())
		pPlayer->pev->owner = NULL;
	pPlayer->pev->solid = SOLID_SLIDEBOX;
	pPlayer->pev->movetype = MOVETYPE_WALK;
	pPlayer->pev->velocity = g_vecZero;
	pPlayer->EnableControl(true);
	UTIL_SetOrigin(pPlayer->pev, spot);
	if (pPlayer->IsAlive())
	{
		pPlayer->pev->takedamage = DAMAGE_AIM;
		pPlayer->pev->angles = Vector(0, m_flYaw, 0);
		pPlayer->pev->v_angle = pPlayer->pev->angles;
		pPlayer->pev->fixangle = 1;
		pPlayer->EquipWeapon();
	}
	pPlayer->m_iHideHUD &= ~HIDEHUD_WEAPONS; // dead too: nothing else gives the weapons' HUD back
	SET_VIEW(pPlayer->edict(), pPlayer->edict());
	pPlayer->m_hViewEntity = NULL;
	m_hDriver = NULL;
	if (m_iSlot > 0 && RaceActive()) // a race car: he is a player again in the lobby, and the car waits on the grid
	{
		if (pPlayer->IsAlive())
			g_pGameRules->GetPlayerSpawnSpot(pPlayer);
		PutAt(m_vecHome, m_flHomeYaw);
	}
	STOP_SOUND(edict(), CHAN_STATIC, STRING(m_iszEngine));
	m_bEngineOn = false;
}

// Throttle, brake, steering and handbrake from the driver's buttons, and what they do to the car's speed and
// its heading over the ground the wheels last stood on (H9CarStep).
void CH9Car::Steer(CBasePlayer* pDriver, float dt)
{
	const int buttons = pDriver && !m_bHeld ? pDriver->pev->button : 0;
	if (m_bGhost) // its race is over: it brakes to a stop by itself
	{
		m_car.forward = H9Approach(0, m_car.forward, m_flBrake * 0.6f * dt);
		m_car.side = H9Approach(0, m_car.side, m_flBrake * 0.6f * dt);
	}
	else if (m_bHeld)
		m_car.forward = m_car.side = 0;
	const bool ahead = (buttons & IN_FORWARD) != 0, back = (buttons & IN_BACK) != 0;
	const bool left = (buttons & IN_MOVELEFT) != 0, right = (buttons & IN_MOVERIGHT) != 0;
	H9CarInput in;
	in.push = ahead == back ? 0 : (ahead ? 1 : -1);
	in.turn = left == right ? 0 : (left ? 1 : -1);
	in.handbrake = (buttons & IN_JUMP) != 0;
	m_iPush = in.push;

	H9CarTune tune;
	tune.maxSpeed = m_flMaxSpeed;
	tune.backSpeed = m_flBackSpeed;
	tune.accel = m_flAccel;
	tune.brake = m_flBrake;
	tune.coast = m_flCoast;
	tune.maxTurn = m_flMaxTurn;
	tune.turnRate = m_flTurnRate;
	tune.wheelbase = m_flFrontDist + m_flRearDist;
	tune.grip = m_flGrip;
	tune.slide = m_flSlide;
	tune.handbrake = m_flHandbrake;

	m_ground.pitch = m_flPitch;
	m_ground.gravity = m_flGravity;
	m_ground.airborne = !m_bGrounded;
	m_flYaw = UTIL_AngleMod(m_flYaw + H9CarStep(m_car, tune, in, m_ground, dt));
}

// Whether the car, standing at `from`, would hit something on `move`: a hull trace through its middle and line
// traces from the corners that lead, at a wheel's climb over the ground and at the body's middle. A car that
// slides goes partly sideways, so the side that leads has its rays too.
bool CH9Car::Blocked(const Vector& from, const Vector& move, TraceResult& hit)
{
	memset(&hit, 0, sizeof(hit));
	hit.flFraction = 1;
	m_iHitBy = -1;
	if (move.Length() < 0.001f)
		return false;
	const Vector way = move.Normalize();
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, right = gpGlobals->v_right;
	const float ahead = DotProduct(move, forward) >= 0 ? 1 : -1;
	const Vector lead = move.Normalize() * 4; // a margin, so it stops short of the wall rather than in it

	TraceResult tr;
	// a hull through the middle, its foot well over the wheels' climb (a slope rises under its ends); one that starts
	// in something (a wall it already touches on a turn) says nothing, and the rays below do the work
	const Vector lift = Vector(0, 0, 32 + m_flMaxStep + 12); // large_hull is 64 tall, centred
	UTIL_TraceHull(from + lift, from + lift + move, dont_ignore_monsters, large_hull, edict(), &tr);
	if (!tr.fStartSolid && tr.flFraction < hit.flFraction && DotProduct(tr.vecPlaneNormal, way) < -0.1f)
	{
		hit = tr;
		m_iHitBy = 0;
	}

	const float halfLength = m_flLength / 2, halfWidth = m_flWidth / 2;
	// the rays at heights over the ground under the leading axle, so that they follow a slope instead of meeting it
	const float base = (ahead > 0 ? m_flFrontGround : m_flRearGround) - from.z;
	const float heights[] = {base + m_flMaxStep + 2, base + m_flHeight / 2};
	for (int level = 0; level < 2; level++)
	{
		const float z = heights[level];
		for (int side = -1; side <= 1; side++)
		{
			const Vector corner = from + forward * (halfLength * ahead) + right * (halfWidth * side * 0.95f) + Vector(0, 0, z);
			UTIL_TraceLine(corner, corner + move + lead, dont_ignore_monsters, edict(), &tr);
			// a ray that starts inside something (a bumper already in a ramp's side) or meets a face it moves away from
			// says nothing: only a face that stands against the way it goes stops it
			if (!tr.fStartSolid && !tr.fAllSolid && tr.flFraction < hit.flFraction && DotProduct(tr.vecPlaneNormal, way) < -0.1f)
			{
				hit = tr;
				m_iHitBy = 1 + level * 3 + (side + 1); // 1-3 the low rays (left, middle, right), 4-6 the high ones
			}
		}
	}
	// sliding: the flank that leads, at its middle and at its trailing corner (the bumper rays have the other
	// corner), each at heights over the ground nearest to it
	const float sideways = DotProduct(way, right);
	if (fabsf(sideways) > 0.2f)
	{
		const float flank = sideways > 0 ? 1.0f : -1.0f;
		const float trailing = (ahead > 0 ? m_flRearGround : m_flFrontGround) - from.z;
		const float along[] = {0, -halfLength * ahead * 0.95f};
		const float bases[] = {(base + trailing) / 2, trailing};
		for (int place = 0; place < 2; place++)
		{
			const float levels[] = {bases[place] + m_flMaxStep + 2, bases[place] + m_flHeight / 2};
			for (int level = 0; level < 2; level++)
			{
				const Vector start = from + forward * along[place] + right * (halfWidth * flank) + Vector(0, 0, levels[level]);
				UTIL_TraceLine(start, start + move + lead, dont_ignore_monsters, edict(), &tr);
				if (!tr.fStartSolid && !tr.fAllSolid && tr.flFraction < hit.flFraction && DotProduct(tr.vecPlaneNormal, way) < -0.1f)
				{
					hit = tr;
					m_iHitBy = 7 + place * 2 + level; // 7-8 the flank's middle (low, high), 9-10 its trailing corner
				}
			}
		}
	}
	return hit.flFraction < 1;
}

// One frame's travel, along the nose and across it, sliding along a wall met at a slant. True when it hit
// something.
bool CH9Car::Move(float dt)
{
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, left = -gpGlobals->v_right;
	const Vector velocity = forward * m_car.forward + left * m_car.side;
	const Vector move = velocity * dt;
	TraceResult hit;
	const bool blocked = Blocked(pev->origin, move, hit);
	if (blocked) // the last real stop, kept for the report
	{
		m_flLastHit = hit.flFraction;
		m_iLastHitBy = m_iHitBy;
		snprintf(m_szLastHit, sizeof(m_szLastHit), "%s", hit.pHit ? STRING(hit.pHit->v.classname) : "?");
		m_flLastHitTime = gpGlobals->time;
	}
	if (!blocked)
	{
		UTIL_SetOrigin(pev, pev->origin + move);
		return false;
	}
	// up to where it hit, then what is left of the move along the wall
	const float speedBefore = velocity.Length();
	Vector normal = hit.vecPlaneNormal;
	normal.z = 0;
	if (normal.Length() < 0.01f)
		normal = -move.Normalize();
	normal = normal.Normalize();
	const float headOn = fabsf(DotProduct(move.Normalize(), normal));
	const int way = m_car.forward > 0 ? 1 : -1;
	// The wall takes all of its speed into it, the slide's too, and what is left runs along the wall, less by how
	// squarely it hit (as before: all of it lost head on, little at a graze).
	Vector along = velocity - normal * DotProduct(velocity, normal);
	if (along.Length() > 0.01f)
		along = along.Normalize() * (speedBefore * (1 - headOn));
	else
		along = g_vecZero;
	m_car.forward = DotProduct(along, forward);
	m_car.side = DotProduct(along, left);
	// still pushed the way it went: it keeps a crawl, so that it goes on sliding along the wall instead of sticking to
	// it (Diffusion's "in case if stuck": 25)
	if (m_iPush == way && fabsf(m_car.forward) < H9CAR_PUSH)
		m_car.forward = H9CAR_PUSH * way;
	Vector slide = move * (1 - hit.flFraction);
	slide = slide - normal * DotProduct(slide, normal);
	TraceResult again;
	if (slide.Length() > 0.1f && !Blocked(pev->origin, slide, again))
		UTIL_SetOrigin(pev, pev->origin + slide);
	if (speedBefore - sqrtf(m_car.forward * m_car.forward + m_car.side * m_car.side) > 300)
		EMIT_SOUND_DYN(edict(), CHAN_BODY, "debris/metal2.wav", 1, ATTN_NORM, 0, 90 + RANDOM_LONG(0, 20));
	return true;
}

// What one wheel stands on, kept until it is looked at again (H9CAR_LOOK): the surface its floor texture's name
// stands for, and how deep the wheel is in water. `tr` is the wheel's trace down, from `above` to `below`.
void CH9Car::LookUnder(int wheel, const TraceResult& tr, const Vector& above, const Vector& below)
{
	if (gpGlobals->time < m_flWheelLook[wheel] && gpGlobals->time > m_flWheelLook[wheel] - 1)
		return;
	m_flWheelLook[wheel] = gpGlobals->time + H9CAR_LOOK + wheel * 0.01f; // not all four in one frame
	// the texture of the brush entity the trace met, or the world's
	edict_t* floor = tr.pHit && !FNullEnt(tr.pHit) ? tr.pHit : ENT(0);
	const char* name = TRACE_TEXTURE(floor, above, below);
	if (!name && floor != ENT(0))
		name = TRACE_TEXTURE(ENT(0), above, below);
	m_iWheelSurface[wheel] = H9SurfaceByName(name);
	m_flWheelDepth[wheel] = 0;
	const Vector foot = tr.vecEndPos + Vector(0, 0, 1);
	if (UTIL_PointContents(foot) == CONTENTS_WATER)
	{
		const float tall = m_flRadius > 1 ? m_flRadius * 2 : 2;
		m_iWheelSurface[wheel] = H9SURF_WATER;
		m_flWheelDepth[wheel] = H9Clamp((UTIL_WaterLevel(foot, foot.z, foot.z + tall) - tr.vecEndPos.z) / tall, 0, 1);
	}
}

// The wheels on the ground: four traces down set the height, the pitch and the roll, and say what the tyres
// stand on; with none it flies (H9CarFallStep).
void CH9Car::Settle(float dt)
{
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, right = gpGlobals->v_right;
	const float along[4] = {m_flFrontDist, m_flFrontDist, -m_flRearDist, -m_flRearDist};
	const float across[4] = {-m_flTrack / 2, m_flTrack / 2, -m_flTrack / 2, m_flTrack / 2}; // left, right
	float ground[4];
	bool touching[4];
	H9CarGround under;
	under.grip = under.top = under.roll = under.loose = 0;
	for (int i = 0; i < 4; i++)
	{
		Vector wheel = pev->origin + forward * along[i] + right * across[i];
		wheel.z = m_flWheelGround[i]; // from its own ground: on a slope a wheel is well above or below the middle
		TraceResult tr;
		const Vector above = wheel + Vector(0, 0, m_flMaxStep + 1), below = wheel - Vector(0, 0, m_flRadius * 2 + 8);
		UTIL_TraceLine(above, below, ignore_monsters, edict(), &tr);
		touching[i] = tr.flFraction < 1 && !tr.fStartSolid;
		ground[i] = touching[i] ? tr.vecEndPos.z : pev->origin.z - m_flRadius;
		if (touching[i])
		{
			LookUnder(i, tr, above, below);
			H9SurfaceAdd(under, m_iWheelSurface[i], m_flWheelDepth[i]);
		}
	}

	const float wheelbase = m_flFrontDist + m_flRearDist > 1 ? m_flFrontDist + m_flRearDist : 1;
	const float track = m_flTrack > 1 ? m_flTrack : 1;
	Vector origin = pev->origin;
	m_height.z = origin.z;
	float floor;
	const int count = H9CarFloor(m_height, ground, touching, along, across, wheelbase, track, floor);
	// the vertical speed the ground gives it: its speed over the slope under it (its side speed is to the left)
	const float rate = m_car.forward * m_height.slopeAlong - m_car.side * m_height.slopeAcross;
	const float impact = H9CarFallStep(m_height, count, floor, rate, m_flGravity, dt);
	origin.z = m_height.z;
	m_bGrounded = !m_height.airborne;
	m_bAllWheels = count == 4;
	if (impact > H9CAR_LAND) // a hard landing takes some of its speed
	{
		const float kept = H9CarLanding(impact);
		m_car.forward *= kept;
		m_car.side *= kept;
		EMIT_SOUND_DYN(edict(), CHAN_BODY, "plats/ttrain_brake1.wav", 0.7, ATTN_NORM, 0, 120);
	}
	if (count > 0) // what the tyres stand on: the mean of the wheels that are down
	{
		m_ground.grip = under.grip / count;
		m_ground.top = under.top / count;
		m_ground.roll = under.roll / count;
		m_ground.loose = under.loose / count;
	}

	const float ease = dt > 0 ? H9Clamp(dt * 10, 0, 1) : 1;
	if (count > 0)
	{
		const float pitch = atan2f((ground[0] + ground[1]) / 2 - (ground[2] + ground[3]) / 2, wheelbase) * (180 / M_PI);
		const float roll = atan2f((ground[1] + ground[3]) / 2 - (ground[0] + ground[2]) / 2, track) * (180 / M_PI);
		m_flPitch += (pitch - m_flPitch) * ease;
		m_flRoll += (roll - m_flRoll) * ease;
	}
	else
	{
		// in the air the nose follows the arc a little (up while it rises, down while it falls) and the body levels,
		// slowly: it comes down close to flat, on its wheels
		const float speed = sqrtf(m_car.forward * m_car.forward + m_car.side * m_car.side);
		const float arc = atan2f(m_height.fall, speed > 300 ? speed : 300) * (180 / M_PI) * (m_car.forward < 0 ? -1 : 1);
		m_flPitch += (H9Clamp(arc * 0.4f, -12, 12) - m_flPitch) * ease * 0.3f;
		m_flRoll += (0 - m_flRoll) * ease * 0.3f;
	}
	UTIL_SetOrigin(pev, origin);
	pev->angles = Vector(m_flPitch, m_flYaw, m_flRoll);
	// the next frame's wheel traces start over these; a wheel in the air hangs from the body
	for (int i = 0; i < 4; i++)
		m_flWheelGround[i] = touching[i] ? ground[i] : origin.z;
	m_flFrontGround = (m_flWheelGround[0] + m_flWheelGround[1]) / 2;
	m_flRearGround = (m_flWheelGround[2] + m_flWheelGround[3]) / 2;
}

// The bounding box: a box stays square to the world in the engine, so it is the one that holds the turned body.
void CH9Car::FitBox()
{
	const float c = fabsf(cosf(m_flYaw * (M_PI / 180))), s = fabsf(sinf(m_flYaw * (M_PI / 180)));
	const float hx = c * m_flLength / 2 + s * m_flWidth / 2;
	const float hy = s * m_flLength / 2 + c * m_flWidth / 2;
	UTIL_SetSize(pev, Vector(-hx, -hy, 0), Vector(hx, hy, m_flHeight));
}

// Behind and above the car, catching up with it (it lags on a turn, so the car is seen turning), looking at it.
void CH9Car::PlaceCamera(float dt)
{
	CBaseEntity* pCamera = m_hCamera;
	if (!pCamera)
		return;
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector look = pev->origin + Vector(0, 0, H9CAR_CAM_LOOK);
	Vector goal = pev->origin - gpGlobals->v_forward * H9CAR_CAM_BACK + Vector(0, 0, H9CAR_CAM_UP);
	TraceResult tr; // never behind a wall
	UTIL_TraceLine(look, goal, ignore_monsters, edict(), &tr);
	goal = look + (goal - look) * (tr.flFraction > 0.1f ? tr.flFraction - 0.05f : 0.05f);
	const float ease = dt > 0 ? H9Clamp(dt * 6, 0, 1) : 1;
	const Vector at = pCamera->pev->origin + (goal - pCamera->pev->origin) * ease;
	UTIL_SetOrigin(pCamera->pev, at);
	Vector angles = UTIL_VecToAngles(look - at);
	angles.x = -angles.x; // a view's pitch is the other way round
	pCamera->pev->angles = angles;
	pCamera->pev->v_angle = angles;
}

// The engine's pitch follows the speed.
void CH9Car::Sound()
{
	if (!m_bEngineOn || gpGlobals->time < m_flNextSound)
		return;
	m_flNextSound = gpGlobals->time + 0.1f;
	const int pitch = 70 + (int)(90 * H9Clamp(fabsf(m_car.forward) / (m_flMaxSpeed > 1 ? m_flMaxSpeed : 1), 0, 1));
	EMIT_SOUND_DYN(edict(), CHAN_STATIC, STRING(m_iszEngine), 0.6, ATTN_NORM, SND_CHANGE_PITCH | SND_CHANGE_VOL, pitch);
}

// Put somewhere, level and at rest (the grid, a respawn, the last safe place).
void CH9Car::PutAt(const Vector& origin, float yaw)
{
	UTIL_SetOrigin(pev, origin);
	m_flYaw = yaw;
	m_car = H9CarMotion();
	m_height = H9CarHeight();
	m_height.z = origin.z;
	m_flPitch = m_flRoll = 0;
	for (float& z : m_flWheelGround)
		z = origin.z;
	m_flFrontGround = m_flRearGround = origin.z;
	m_bPending = false;
	pev->angles = Vector(0, yaw, 0);
}

void CH9Car::DriveThink()
{
	Step("think");
	CBasePlayer* pDriver = Driver();
	// every frame while it moves or is driven; at rest, ten times a second
	const bool resting = !pDriver && m_car.forward == 0 && m_car.side == 0 && m_bGrounded && m_height.contact;
	pev->nextthink = gpGlobals->time + (resting ? 0.1f : 0.01f);
}

// One frame of the car, from its think alone.
void CH9Car::Step(const char* by)
{
	float dt = gpGlobals->time - m_flLastThink; // the server's clock only: Step runs from the think alone
	m_flLastThink = gpGlobals->time;
	dt = H9Clamp(dt, 0, 0.1f);
	m_flLastDt = dt;

	CBasePlayer* pDriver = Driver();
	if (m_hDriver && (!pDriver || !pDriver->IsAlive() || pDriver->m_pTank != this)) // left, died or was taken out
	{
		if (pDriver && pDriver->m_pTank == NULL && !(pDriver->pev->effects & EF_NODRAW))
			pDriver = NULL; // already let go by LeaveWheel
		else if (pDriver)
		{
			pDriver->m_pTank = NULL;
			LeaveWheel(pDriver);
			pDriver = NULL;
		}
		m_hDriver = NULL;
		STOP_SOUND(edict(), CHAN_STATIC, STRING(m_iszEngine));
		m_bEngineOn = false;
	}

	if (pDriver) // +use gets him out: a fresh press (kept by the PostThink call), not the one that got him in
	{
		const bool pressed = m_bUsePressed;
		m_bUsePressed = false;
		// In a race a tap does not throw the race away: while it runs +use must be held a second, and a racer the
		// race holds (the countdown; finished, until the results are over) stays in, so that he is in the results.
		const bool racing = m_iSlot > 0 && RaceActive() && RaceGetState() != RACE_WAITING;
		bool out = pressed && gpGlobals->time > m_flEntered + 0.3f;
		if (racing)
		{
			out = false;
			if (m_bHeld)
				m_flUseHeld = 0;
			else
			{
				if (pressed)
					ClientPrint(pDriver->pev, HUD_PRINTCENTER, "Hold use for a second to leave the race");
				m_flUseHeld = (pDriver->pev->button & IN_USE) ? m_flUseHeld + dt : 0;
				out = m_flUseHeld >= 1.0f;
			}
		}
		if (out)
		{
			m_flUseHeld = 0;
			pDriver->m_pTank = NULL;
			LeaveWheel(pDriver);
			pDriver = NULL;
		}
	}

	// In a race map: the countdown calls the car to its grid place and holds it; when the results are over its
	// driver is a player again.
	m_bHeld = false;
	if (m_iSlot > 0 && RaceActive())
	{
		const int state = RaceGetState();
		if (pDriver && state == RACE_WAITING && m_iRaceState == RACE_FINISHED)
		{
			pDriver->m_pTank = NULL;
			LeaveWheel(pDriver);
			pDriver = NULL;
		}
		else if (pDriver)
		{
			if (RaceRound() != m_iRound)
			{
				m_iRound = RaceRound();
				PutAt(m_vecHome, m_flHomeYaw);
				RacePlaced(pDriver);
			}
			m_bHeld = RaceHolds(pDriver);
		}
		m_iRaceState = state;
		m_bGhost = pDriver && m_bHeld && state != RACE_COUNTDOWN;
		// With nobody in it, it is not on the track at all: the others drive through its grid place. One whose race
		// is over is a ghost: seen through, and the others drive through it to the line.
		if (pDriver)
		{
			pev->effects &= ~EF_NODRAW;
			pev->solid = m_bGhost ? SOLID_NOT : SOLID_BBOX;
			pev->rendermode = m_bGhost ? kRenderTransTexture : kRenderNormal;
			pev->renderamt = m_bGhost ? 110 : 0;
		}
		else
		{
			pev->effects |= EF_NODRAW;
			pev->solid = SOLID_NOT;
			pev->rendermode = kRenderNormal;
			pev->renderamt = 0;
		}
	}

	if (dt > 0)
	{
		Steer(pDriver, dt);
		const bool hit = Move(dt);
		// R held a second: back to the last place it stood on four wheels touching nothing, level and at rest
		// (Diffusion's reset); it keeps that place's heading
		if (pDriver && (pDriver->pev->button & IN_RELOAD))
			m_flResetHeld += dt;
		else
			m_flResetHeld = 0;
		if (m_flResetHeld >= H9CAR_RESET_HOLD && m_bHasSafe)
		{
			m_flResetHeld = 0;
			Vector place, angles;
			if (m_iSlot > 0 && RaceActive() && RaceRespawnPoint(pDriver, place, angles)) // in a race: after the last checkpoint passed
			{
				PutAt(place, angles.y);
				RacePlaced(pDriver);
			}
			else
			{
				PutAt(m_vecSafe, m_flSafeYaw);
				if (m_iSlot > 0 && RaceActive())
					RacePlaced(pDriver);
			}
			EMIT_SOUND_DYN(edict(), CHAN_ITEM, "plats/vehicle_ignition.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
		}
		else if (!hit && m_bAllWheels && m_height.contact)
		{
			// a place a second old, and safe the whole second since: not the spot just before it got stuck
			if (!m_bPending)
			{
				m_vecPending = pev->origin;
				m_flPendingYaw = m_flYaw;
				m_flPendingAt = gpGlobals->time;
				m_bPending = true;
			}
			else if (gpGlobals->time >= m_flPendingAt + 1.0f)
			{
				m_vecSafe = m_vecPending;
				m_flSafeYaw = m_flPendingYaw;
				m_bHasSafe = true;
				m_bPending = false;
			}
		}
		else
			m_bPending = false;
		Settle(dt);
		FitBox();
		SetBoneController(0, m_car.steer);
		SetBoneController(1, m_car.steer);
		// the roll: one cycle is one turn of the wheels, so the rate is turns a second times the cycle's length
		const float cycle = m_flFrameRate > 0 ? 256.0f / m_flFrameRate : 1.0f;
		pev->framerate = m_car.forward / (2 * M_PI * (m_flRadius > 1 ? m_flRadius : 1)) * cycle;
		StudioFrameAdvance(dt);
		if (pev->frame < 0) // StudioFrameAdvance wraps a loop only forwards
			pev->frame += 256 * (1 + (int)(-pev->frame / 256));
		pev->fuser4 = m_car.slip; // for other code: how much the tyres slide, and the speed along the nose
		pev->fuser2 = m_car.forward;
		pev->fuser3 = m_flMaxSpeed; // and its top speed, for a gauge's end (the race HUD)
	}

	if (pDriver)
	{
		pDriver->pev->weaponmodel = 0;
		pDriver->pev->viewmodel = 0;
		pDriver->pev->velocity = g_vecZero;
		pDriver->pev->solid = SOLID_NOT;
		pDriver->pev->owner = edict();
		UTIL_SetOrigin(pDriver->pev, pev->origin + Vector(0, 0, 40)); // he rides inside: the sounds and the PVS follow
		PlaceCamera(dt);
		Sound();
		if (CVAR_GET_FLOAT("developer") > 0 && gpGlobals->time >= m_flNextReport)
		{
			m_flNextReport = gpGlobals->time + 0.5f;
			// three lines: the engine cuts a console message at about 190 characters
			char line[160];
			snprintf(line, sizeof(line), "h9_car: buttons %x dt %.3f speed %.0f steer %.1f yaw %.0f grounded %d\n",
				pDriver->pev->button, m_flLastDt, m_car.forward, m_car.steer, m_flYaw, m_bGrounded ? 1 : 0);
			ClientPrint(pDriver->pev, HUD_PRINTCONSOLE, line);
			snprintf(line, sizeof(line), "  side %.0f slip %.2f hand %.1f; wheels %s %s %s %s grip %.2f top %.2f; fall %.0f\n",
				m_car.side, m_car.slip, m_car.hand, g_h9Surfaces[m_iWheelSurface[0]].name, g_h9Surfaces[m_iWheelSurface[1]].name,
				g_h9Surfaces[m_iWheelSurface[2]].name, g_h9Surfaces[m_iWheelSurface[3]].name, m_ground.grip, m_ground.top,
				m_height.fall);
			ClientPrint(pDriver->pev, HUD_PRINTCONSOLE, line);
			snprintf(line, sizeof(line), "  stop %.1fs ago by %d on %s at %.2f; z %.1f pitch %.1f ground %.1f/%.1f\n",
				m_flLastHitTime < 0 ? -1.0f : gpGlobals->time - m_flLastHitTime, m_iLastHitBy, m_szLastHit, m_flLastHit,
				pev->origin.z, m_flPitch, m_flFrontGround, m_flRearGround);
			ClientPrint(pDriver->pev, HUD_PRINTCONSOLE, line);
		}
	}
}

// race_pick: a buggy on show in a race map's lobby. A player who presses +use on it becomes that buggy on the grid:
// the free grid car with the lowest slot takes this one's skin and takes him in. When the race is over, or when he
// gets out, he is a player in the lobby again (CH9Car::LeaveWheel).
class CRacePick : public CBaseAnimating
{
public:
	void Spawn() override;
	int ObjectCaps() override { return (CBaseAnimating::ObjectCaps() & ~FCAP_ACROSS_TRANSITION) | FCAP_IMPULSE_USE; }
	void Use(CBaseEntity* pActivator, CBaseEntity* pCaller, USE_TYPE useType, float value) override;
};
LINK_ENTITY_TO_CLASS(race_pick, CRacePick);

void CRacePick::Spawn()
{
	if (FStringNull(pev->model))
		pev->model = MAKE_STRING("models/h9/rc_car.mdl");
	if (!H9FileOnDisk(STRING(pev->model)))
	{
		ALERT(at_error, "race_pick: its model %s is not on disk; removed\n", STRING(pev->model));
		UTIL_Remove(this);
		return;
	}
	PRECACHE_MODEL((char*)STRING(pev->model));
	SET_MODEL(edict(), STRING(pev->model));
	pev->movetype = MOVETYPE_NONE;
	pev->solid = SOLID_BBOX;
	pev->takedamage = DAMAGE_NO;
	UTIL_SetSize(pev, Vector(-72, -72, 0), Vector(72, 72, 76));
}

void CRacePick::Use(CBaseEntity* pActivator, CBaseEntity* pCaller, USE_TYPE useType, float value)
{
	if (!pActivator || !pActivator->IsPlayer() || !RaceActive())
		return;
	CBasePlayer* pPlayer = static_cast<CBasePlayer*>(pActivator);
	if (!pPlayer->IsAlive() || pPlayer->m_pTank != NULL)
		return;
	if (RaceGetState() == RACE_FINISHED) // somebody has finished: he would be held, then put out with the rest
	{
		ClientPrint(pPlayer->pev, HUD_PRINTCENTER, "This race is ending: choose when it is over");
		return;
	}
	CH9Car* pFree = NULL;
	CBaseEntity* pEntity = NULL;
	while ((pEntity = UTIL_FindEntityByClassname(pEntity, "h9_car")) != NULL)
	{
		CH9Car* pCar = static_cast<CH9Car*>(pEntity);
		if (pCar->m_iSlot <= 0)
			continue;
		if (pCar->Driver())
		{
			if (pCar->pev->skin == pev->skin)
			{
				ClientPrint(pPlayer->pev, HUD_PRINTCENTER, "That buggy is taken: choose another");
				return;
			}
			continue;
		}
		if (!pFree || pCar->m_iSlot < pFree->m_iSlot)
			pFree = pCar;
	}
	if (!pFree)
	{
		ClientPrint(pPlayer->pev, HUD_PRINTCENTER, "The grid is full: wait for the next race");
		return;
	}
	pFree->pev->skin = pev->skin;
	pFree->PutAt(pFree->m_vecHome, pFree->m_flHomeYaw);
	pFree->TakeWheel(pPlayer);
}
#endif // H9CAR_MATHS_ONLY
