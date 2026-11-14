/***
*  h9_rally.cpp -- rally mode in pmove (H9): the player moves as a car. Compiled into both the server and the client
*  library (pm_shared is shared), so the server runs it and the client predicts the same step.
*
*  The method follows HL Rally's (the car is the player, moved by pmove: the heading is the command's view yaw, the
*  ground's slope is read with four traces under the body, the car's body is checked by traces from its middle out to
*  points around its outline, the texture under it picks the surface). The code, names and comments are ours; HL Rally's
*  source has no licence and none of it is copied. The handling itself is in h9_rally.h.
*
*  What it keeps from one frame to the next: only the player's own origin, velocity and the command's view angles,
*  which the engine already predicts. No statics, no iuser/fuser/vuser. The mode is on while the physinfo key "rally" is
*  a car class (1 on), which the server sets (dlls/h9_rally_glue in player.cpp) and the engine sends to the client in
*  the client data's physinfo string, the way TS's "mj" reaches pmove.
*
*  The hull: the point hull (usehull 2). Whatever hull sizes a map was compiled with, the world is then exact to the
*  point, and the body's 45 x 18 x 16 outline is the traces below, not a box: HL Rally's own maps drive unmodified.
***/
#include "Platform.h"
#include <assert.h>
#include "mathlib.h"
#include "cdll_dll.h"
#include "const.h"
#include "usercmd.h"
#include "pm_defs.h"
#include "pm_shared.h"
#include "pm_movevars.h"
#include "in_buttons.h"
#include "h9_rally.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

// pm_shared.cpp's own functions (not static there)
int PM_FlyMove();
bool PM_CheckStuck();
int PM_ClipVelocity(Vector in, Vector normal, Vector& out, float overbounce);
void PM_CheckVelocity();
bool PM_AddToTouched(pmtrace_t tr, Vector impactvelocity);

#ifndef CONTENTS_TRANSLUCENT
#define CONTENTS_TRANSLUCENT -15 // as pm_shared.cpp
#endif

namespace
{
const float kFloorNormal = 0.55f; // a plane flatter than this is ground (about 56 degrees)

inline float Dot3(const Vector& a, const Vector& b)
{
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline Vector Cross3(const Vector& a, const Vector& b)
{
	return Vector(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
}

inline Vector Unit(const Vector& v)
{
	const float l = sqrtf(Dot3(v, v));
	return l > 1e-6f ? Vector(v[0] / l, v[1] / l, v[2] / l) : Vector(0, 0, 1);
}

inline Vector MA(const Vector& a, float s, const Vector& b)
{
	return Vector(a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]);
}

pmtrace_t Trace(const Vector& a, const Vector& b)
{
	Vector s = a, e = b;
	return pmove->PM_PlayerTrace(s, e, PM_NORMAL, -1);
}

// the water at the wheels (waterlevel 1) and with the body in it (2)
void CheckWater()
{
	pmove->waterlevel = 0;
	pmove->watertype = CONTENTS_EMPTY;
	Vector p = pmove->origin;
	p[2] += 2.0f;
	int cont = pmove->PM_PointContents(p, NULL);
	if (cont <= CONTENTS_WATER && cont > CONTENTS_TRANSLUCENT)
	{
		pmove->watertype = cont;
		pmove->waterlevel = 1;
		p[2] = pmove->origin[2] + H9R_HEIGHT * 0.6f;
		cont = pmove->PM_PointContents(p, NULL);
		if (cont <= CONTENTS_WATER && cont > CONTENTS_TRANSLUCENT)
			pmove->waterlevel = 2;
	}
}

// Where the car stands: the plane under it (from four traces under the body's corners, as HL Rally reads the
// terrain, falling back to the one under the middle), and whether it is ground at all.
struct Under
{
	bool ground = false;
	Vector normal = Vector(0, 0, 1);
	int ent = -1;
};

Under LookDown(const Vector& heading)
{
	Under u;
	const Vector& o = pmove->origin;
	pmtrace_t mid = Trace(Vector(o[0], o[1], o[2] + 2.0f), Vector(o[0], o[1], o[2] - 3.0f));
	if (mid.fraction >= 1.0f || mid.startsolid || mid.plane.normal[2] < kFloorNormal)
		return u;
	u.ground = true;
	u.ent = mid.ent;
	u.normal = mid.plane.normal;

	// the average of the planes under four points of the body, when each is ground
	const Vector left = Vector(-heading[1], heading[0], 0);
	Vector sum = u.normal;
	int n = 1;
	for (int i = 0; i < 4; i++)
	{
		const float fx = (i & 1) ? 1.0f : -1.0f, fy = (i & 2) ? 1.0f : -1.0f;
		Vector p = MA(MA(o, fx * H9R_LENGTH * 0.4f, heading), fy * H9R_WIDTH * 0.4f, left);
		pmtrace_t t = Trace(Vector(p[0], p[1], p[2] + 6.0f), Vector(p[0], p[1], p[2] - 8.0f));
		if (t.fraction < 1.0f && !t.startsolid && t.plane.normal[2] >= kFloorNormal)
		{
			sum = sum + Vector(t.plane.normal[0], t.plane.normal[1], t.plane.normal[2]);
			n++;
		}
	}
	const Vector avg = Unit(sum);
	if (Dot3(avg, u.normal) > 0.8f) // a trace that found a different thing altogether is not the ground's tilt
		u.normal = avg;
	return u;
}

// The car's body against the world: traces from the body's middle out to points on its outline, only on the sides
// the car is moving toward. The deepest one pushes the car out and takes the speed that went into the wall.
void BodyAgainstWorld(const Vector& heading, const Vector& up, bool grounded)
{
	const Vector left = Unit(Cross3(up, heading));
	const Vector fwd = Cross3(left, up);
	const Vector center = MA(pmove->origin, 12.0f, up);
	const float L = H9R_LENGTH * 0.5f, W = H9R_WIDTH * 0.5f;
	const float heights[2] = {9.0f - 12.0f, 15.0f - 12.0f};

	const float vf = Dot3(pmove->velocity, fwd), vl = Dot3(pmove->velocity, left);
	const bool moving = sqrtf(vf * vf + vl * vl) > 8.0f;
	const bool front = !moving || vf >= 0, back = !moving || vf <= 0;
	const bool lft = !moving || vl >= 0, rgt = !moving || vl <= 0;

	float best = 1.0f;
	float bestPen = 0;
	Vector bestN(0, 0, 0);

	// points on the outline: (along the nose, across it)
	float pts[64][2];
	int np = 0;
	if (front || back)
	{
		for (float y = -W; y <= W + 0.1f; y += W * 0.5f)
		{
			if (front && np < 60)
			{
				pts[np][0] = L;
				pts[np++][1] = y;
			}
			if (back && np < 60)
			{
				pts[np][0] = -L;
				pts[np++][1] = y;
			}
		}
	}
	for (float x = -L + L * 0.25f; x <= L - L * 0.25f + 0.1f; x += L * 0.5f)
	{
		if (lft && np < 60)
		{
			pts[np][0] = x;
			pts[np++][1] = W;
		}
		if (rgt && np < 60)
		{
			pts[np][0] = x;
			pts[np++][1] = -W;
		}
	}

	for (int h = 0; h < 2; h++)
	{
		for (int i = 0; i < np; i++)
		{
			Vector p = MA(MA(MA(center, pts[i][0], fwd), pts[i][1], left), heights[h], up);
			pmtrace_t t = Trace(center, p);
			if (t.fraction >= 1.0f || t.allsolid || t.startsolid)
				continue;
			// a plane a car can drive on is the road, not a wall (a ramp met nose first, a bump under a corner)
			if (t.plane.normal[2] > 0.7f)
				continue;
			if (t.fraction < best)
			{
				best = t.fraction;
				const Vector d = p - center;
				bestPen = (1.0f - t.fraction) * sqrtf(Dot3(d, d));
				bestN = t.plane.normal;
			}
		}
	}
	if (best >= 1.0f)
		return;

	// out of the wall, as far as the world lets it go
	const Vector want = MA(pmove->origin, bestPen + 0.5f, bestN);
	pmtrace_t push = Trace(pmove->origin, want);
	pmove->origin = push.endpos;

	const float vn = Dot3(pmove->velocity, bestN);
	if (vn < 0)
	{
		const float speed = sqrtf(Dot3(pmove->velocity, pmove->velocity));
		const float into = speed > 1.0f ? -vn / speed : 0; // 0 glancing .. 1 square on
		const float keep = 1.0f - (1.0f - H9R_WALL_SCRAPE) * into;
		const Vector tangent = MA(pmove->velocity, -vn, bestN);
		pmove->velocity = MA(Vector(tangent[0] * keep, tangent[1] * keep, tangent[2] * keep), -vn * H9R_WALL_BOUNCE, bestN);
	}
	(void)grounded;
}

bool CarHeld()
{
	return (pmove->flags & FL_FROZEN) != 0 || pmove->maxspeed < 2.0f;
}
} // namespace

// The car class this player is in (0: not in rally mode). Read from the physinfo string on both sides.
int H9RallyClass()
{
	const char* v = pmove->PM_Info_ValueForKey(pmove->physinfo, "rally");
	return v ? atoi(v) : 0;
}

bool H9RallyActive()
{
	if (H9RallyClass() <= 0)
		return false;
	if (pmove->dead || pmove->spectator || pmove->iuser1 > 0)
		return false;
	return pmove->movetype == MOVETYPE_WALK;
}

// One command of driving: the whole of the car's movement.
void H9RallyMove()
{
	const H9RallyCar& car = H9RallyCarByClass(H9RallyClass());
	const float dt = pmove->frametime;

	pmove->usehull = 2; // the point hull
	pmove->flags &= ~FL_DUCKING;
	pmove->bInDuck = false;
	pmove->view_ofs[2] = H9R_VIEW_HEIGHT;

	if (dt <= 0)
		return;
	if (PM_CheckStuck())
	{
		pmove->velocity = Vector(0, 0, 0);
		return;
	}

	// the heading: the view's yaw, as HL Rally. (The client turns it with the steering keys: cl_dll/input.cpp.)
	const float yaw = pmove->cmd.viewangles[1] * (float)(M_PI / 180.0);
	const Vector heading(cosf(yaw), sinf(yaw), 0);
	pmove->angles[1] = pmove->cmd.viewangles[1];

	// the pedals
	H9RallyInput in;
	if (!CarHeld())
	{
		if (pmove->cmd.buttons & IN_FORWARD)
			in.throttle += 1;
		if (pmove->cmd.buttons & IN_BACK)
			in.throttle -= 1;
		if (pmove->cmd.forwardmove > 10 && in.throttle == 0)
			in.throttle = 1;
		if (pmove->cmd.forwardmove < -10 && in.throttle == 0)
			in.throttle = -1;
		in.handbrake = (pmove->cmd.buttons & IN_JUMP) != 0;
	}

	CheckWater();
	const float grav = pmove->movevars->gravity * (pmove->gravity != 0 ? pmove->gravity : 1.0f);

	// --- where the car stands, and whether the ground still holds it ---------------------------------------
	Under under = LookDown(heading);
	bool grounded = under.ground;
	if (grounded && Dot3(pmove->velocity, under.normal) > H9R_STICK_NORMAL)
		grounded = false; // a crest throws it
	const Vector preVelocity = pmove->velocity;

	if (pmove->waterlevel >= 2)
	{
		// the body in water: it floats and sinks slowly, drags hard and the engine hardly pushes it
		const float keep = expf(-H9R_WATER_DEEP_DRAG * dt);
		pmove->velocity[0] *= keep;
		pmove->velocity[1] *= keep;
		pmove->velocity[2] = pmove->velocity[2] * keep - grav * H9R_WATER_DEEP_GRAV * dt;
		const float vf = Dot3(pmove->velocity, heading);
		const float lim = car.top * 0.2f;
		if (in.throttle != 0 && fabsf(vf) < lim)
		{
			pmove->velocity[0] += heading[0] * in.throttle * car.engine * 0.5f * dt;
			pmove->velocity[1] += heading[1] * in.throttle * car.engine * 0.5f * dt;
		}
		grounded = false;
	}
	else if (grounded)
	{
		const Vector n = under.normal;
		const Vector f = Unit(MA(heading, -Dot3(heading, n), n));
		const Vector l = Unit(Cross3(n, f));

		// the surface from the texture's name under the car
		H9RallyGround g;
		const char* tex = pmove->PM_TraceTexture(under.ent, Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] + 1.0f),
												 Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] - 64.0f));
		if (tex)
		{
			if (*tex == '-' || *tex == '+')
				tex += 2;
			g.surface = H9RallySurfaceByName(tex);
		}
		if (pmove->waterlevel >= 1)
		{
			g.extraDrag = H9R_WATER_WHEELS_DRAG;
			g.gripScale = 0.5f;
			g.topScale = 0.55f;
		}

		const Vector gv(0, 0, -grav);
		const Vector gt = MA(gv, -Dot3(gv, n), n); // gravity along the plane
		g.slopeF = Dot3(gt, f);
		g.slopeS = Dot3(gt, l);

		float vf = Dot3(pmove->velocity, f), vs = Dot3(pmove->velocity, l);
		H9RallyGroundStep(vf, vs, in, g, car, dt);
		pmove->velocity = MA(Vector(f[0] * vf, f[1] * vf, f[2] * vf), vs, l);
	}
	else
	{
		// in the air: nothing drives or steers it; gravity and a little air
		const float keep = expf(-H9R_AIR_DRAG * dt);
		pmove->velocity[0] *= keep;
		pmove->velocity[1] *= keep;
		pmove->velocity[2] -= grav * dt;
	}

	PM_CheckVelocity();

	// --- the move -----------------------------------------------------------------------------------------
	const Vector org0 = pmove->origin;
	const Vector vel0 = pmove->velocity;
	PM_FlyMove();

	const float wanted = sqrtf(vel0[0] * vel0[0] + vel0[1] * vel0[1]) * dt;
	const float got = sqrtf((pmove->origin[0] - org0[0]) * (pmove->origin[0] - org0[0]) + (pmove->origin[1] - org0[1]) * (pmove->origin[1] - org0[1]));
	if (grounded && got < wanted * 0.98f)
	{
		// Something in the way. A kerb: try again from H9R_STEP_UP higher and take whichever goes farther along the ground.
		const Vector flatOrg = pmove->origin, flatVel = pmove->velocity;
		pmove->origin = org0;
		pmove->velocity = vel0;
		pmtrace_t up = Trace(org0, Vector(org0[0], org0[1], org0[2] + H9R_STEP_UP));
		if (!up.startsolid && !up.allsolid)
		{
			pmove->origin = up.endpos;
			PM_FlyMove();
			pmtrace_t down = Trace(pmove->origin, Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] - H9R_STEP_UP - 2.0f));
			bool good = !down.startsolid && !down.allsolid;
			if (good && down.fraction < 1.0f && down.plane.normal[2] < kFloorNormal)
				good = false; // came down on a wall's top edge
			if (good)
				pmove->origin = down.endpos;
			const float dFlat = (flatOrg[0] - org0[0]) * (flatOrg[0] - org0[0]) + (flatOrg[1] - org0[1]) * (flatOrg[1] - org0[1]);
			const float dUp = (pmove->origin[0] - org0[0]) * (pmove->origin[0] - org0[0]) + (pmove->origin[1] - org0[1]) * (pmove->origin[1] - org0[1]);
			if (!good || dFlat >= dUp)
			{
				pmove->origin = flatOrg;
				pmove->velocity = flatVel;
			}
		}
		else
		{
			pmove->origin = flatOrg;
			pmove->velocity = flatVel;
		}
	}

	// --- ground again: stay on it down a slope, land from the air ----------------------------------------
	bool nowGround = false;
	Vector nowNormal(0, 0, 1);
	int nowEnt = -1;
	{
		const float reach = grounded ? 6.0f : 2.0f;
		pmtrace_t t = Trace(Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] + 1.0f),
							Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] - reach));
		if (t.fraction < 1.0f && !t.startsolid && !t.allsolid && t.plane.normal[2] >= kFloorNormal)
		{
			const Vector n = t.plane.normal;
			const float away = Dot3(pmove->velocity, n);
			if (grounded)
			{
				if (away <= H9R_STICK_NORMAL)
				{
					nowGround = true;
					pmove->origin = t.endpos;
					if (away < 0)
						pmove->velocity = MA(pmove->velocity, -away, n);
				}
			}
			else
			{
				const float impact = -Dot3(preVelocity, n);
				if (impact > 0 || away <= 0)
				{
					nowGround = true;
					const float keep = H9RallyLandKeep(impact);
					pmove->velocity = MA(pmove->velocity, -fminf(0.0f, away), n);
					pmove->velocity[0] *= keep;
					pmove->velocity[1] *= keep;
					pmove->velocity[2] *= keep;
					pmove->origin = t.endpos;
				}
			}
			nowNormal = n;
			nowEnt = t.ent;
		}
	}

	BodyAgainstWorld(heading, nowGround ? nowNormal : Vector(0, 0, 1), nowGround);

	PM_CheckVelocity();
	pmove->onground = nowGround ? nowEnt : -1;
	if (nowGround)
		pmove->waterjumptime = 0;
	CheckWater();
}
