/***
*  h9_rally.cpp -- rally mode in pmove (H9): the player moves as a car. Compiled into both the server and the client
*  library (pm_shared is shared), so the server runs it and the client predicts the same step.
*
*  The method follows HL Rally's (the car is the player, moved by pmove: the heading is the command's view yaw, the
*  ground's slope is read with four traces under the body, the car's body is checked by traces from its middle out to
*  points around its outline, the texture under it picks the surface). The code, names and comments are ours; HL Rally's
*  source has no licence and none of it is copied. The handling itself is in h9_rally.h.
*
*  One command, in HL Rally's order: where the car stands (a trace 2 down, 16 when it is at rest: any hit is ground), the
*  ground's handling or the air's gravity, the body against the world at the place the move is going to (PM_Crash), the
*  move (a straight trace; a kerb or a wall: the slide against the step-up along the car's up, the stepped one winning a
*  tie), and where the car stands now.
*
*  What it keeps from one frame to the next: only the player's own origin, velocity and the command's view angles,
*  which the engine already predicts. No statics that change the movement, no iuser/fuser/vuser. The mode is on while the
*  physinfo key "rally" is a car class (1 on), which the server sets (dlls/h9_rally_srv.cpp) and the engine sends to the
*  client in the client data's physinfo string, the way TS's "mj" reaches pmove. The key "rdbg" (1) turns on the debug line.
*
*  What does NOT limit a car here, so that nothing of The Specialists' on-foot movement holds it: the car's wish speed is
*  its own stat (h9_rally.h), never pmove->maxspeed (the loadout changes that); the time scale (fuser1, TS's slow motion)
*  is ignored; water is only a level, it changes nothing; the held state is FL_FROZEN alone.
*
*  The hull: the point hull (usehull 2). Whatever hull sizes a map was compiled with, the world is then exact to the
*  point, and the body's 45 x 18 x 16 outline is the traces below, not a box: HL Rally's own maps drive unmodified.
*  Other players are physents with boxes: the cars are boxes to each other, as in HL Rally (its players are SOLID_SLIDEBOX).
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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static_assert(H9R_FL_FROZEN == FL_FROZEN, "h9_rally.h's copy of FL_FROZEN");

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
const float kFloorNormal = 0.55f; // a plane flatter than this is flat enough to average with its neighbours for the car's tilt

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

inline float Len3(const Vector& v)
{
	return sqrtf(Dot3(v, v));
}

pmtrace_t Trace(const Vector& a, const Vector& b)
{
	Vector s = a, e = b;
	return pmove->PM_PlayerTrace(s, e, PM_NORMAL, -1);
}

// What one command did, for the debug line (physinfo "rdbg" 1, server only). Nothing here reaches the movement.
struct Dbg
{
	bool stuck = false, freed = false, lifted = false;
	bool pushed = false;
	float pushDist = 0;
	float wanted = 0, got = 0; // the last move: the distance the velocity asked for and the origin covered
	bool grounded = false;
	float gap = 0;
	Vector normal = Vector(0, 0, 1);
	char tex[20] = "";
	int surface = 0;
	float pull = 1.0f;
	bool stepped = false;
	float fuser1 = 1.0f, engineFrametime = 0;
	float dt = 0;
};

// the water at the wheels (waterlevel 1) and with the body in it (2): only the level, nothing in the movement reads it
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

// Where the car stands (HL Rally's PM_CatagorizePosition): a trace from the origin 2 down (16 when the car is at rest or
// under 5 u/s); any hit that is not a wall is ground, a trace that starts in something too, and a car going up faster than
// 1800 is in the air.
struct Cat
{
	bool ground = false;
	bool hit = false;     // a real hit (not a trace that started solid)
	Vector normal = Vector(0, 0, 1);
	Vector endpos;
	float gap = 0;        // how far below the origin the ground is
	int ent = -1;
};

Cat Categorize()
{
	Cat c;
	c.endpos = pmove->origin;
	const float reach = H9RallyGroundReach(Len3(pmove->velocity));
	const Vector o = pmove->origin;
	pmtrace_t t = Trace(o, Vector(o[0], o[1], o[2] - reach));
	if (!H9RallyIsGround(t.startsolid != 0 || t.allsolid != 0, t.fraction, t.plane.normal[2], pmove->velocity[2]))
		return c;
	c.ground = true;
	if (t.startsolid || t.allsolid)
	{
		c.ent = t.ent >= 0 ? t.ent : 0;
		return c;
	}
	c.hit = true;
	c.ent = t.ent;
	c.normal = t.plane.normal;
	c.endpos = t.endpos;
	c.gap = t.fraction * reach;
	return c;
}

// The plane under the car as it tilts: the middle's (from Categorize), averaged with the planes under four points of the body
// when they are all ground and agree (HL Rally reads the terrain with four traces).
Vector GroundNormal(const Cat& cat, const Vector& heading)
{
	if (!cat.hit)
		return Vector(0, 0, 1);
	Vector n = cat.normal;
	if (n[2] < kFloorNormal)
		return n;
	const Vector& o = pmove->origin;
	const Vector left = Vector(-heading[1], heading[0], 0);
	Vector sum = n;
	for (int i = 0; i < 4; i++)
	{
		const float fx = (i & 1) ? 1.0f : -1.0f, fy = (i & 2) ? 1.0f : -1.0f;
		Vector p = MA(MA(o, fx * H9R_LENGTH * 0.4f, heading), fy * H9R_WIDTH * 0.4f, left);
		pmtrace_t t = Trace(Vector(p[0], p[1], p[2] + 6.0f), Vector(p[0], p[1], p[2] - 8.0f));
		if (t.fraction < 1.0f && !t.startsolid && t.plane.normal[2] >= kFloorNormal)
			sum = sum + Vector(t.plane.normal[0], t.plane.normal[1], t.plane.normal[2]);
	}
	const Vector avg = Unit(sum);
	if (Dot3(avg, n) > 0.8f) // a trace that found a different thing altogether is not the ground's tilt
		n = avg;
	return n;
}

// The car's body against the world (HL Rally's PM_Crash + PM_CarWorldCollision), before the move: the outline is traced at the
// place the move is going to (origin + velocity * dt), from the body's middle (8 above) out to the points of h9_rally.h's grid
// (heights 4 and 12), on the sides the car goes toward (all four at rest, or at 10 u/s and under). The nearest hit is the
// wall: on the ground every plane counts, in the air a plane flatter than 0.3 is ground to land on and passes. The car's
// speed into the wall is taken out (HL Rally's reflection), and the origin is pushed back by how far the outline reached into
// it, no further: a car that touches a wall without being in it is left alone, so it can drive away.
void BodyAgainstWorld(const Vector& heading, const Vector& up, bool grounded, float dt, Dbg& d)
{
	const Vector v = pmove->velocity;
	const Vector dest = MA(pmove->origin, dt, v);
	const Vector left = Unit(Cross3(up, heading));
	const Vector fwd = Cross3(left, up);
	const Vector center = MA(dest, 8.0f, up);

	const H9RallySides sides = H9RallyCrashSides(Dot3(v, fwd), Dot3(v, left), Len3(v));
	float pts[64][3];
	const int np = H9RallyCrashPoints(sides, pts, 64);

	pmtrace_t best;
	bool have = false;
	Vector bestPoint;
	float bestFrac = 1.0f;
	for (int i = 0; i < np; i++)
	{
		const Vector p = MA(MA(MA(dest, pts[i][0], fwd), pts[i][1], left), pts[i][2], up);
		pmtrace_t t = Trace(center, p);
		if (t.allsolid || t.startsolid) // the middle itself in something: no plane to push from (the stuck check's business)
			continue;
		if (t.fraction < bestFrac)
		{
			bestFrac = t.fraction;
			best = t;
			bestPoint = p;
			have = true;
		}
	}
	if (!have)
		return;
	const Vector n = best.plane.normal;
	if (H9RallyCrashIgnores(grounded, n[2]))
		return;

	// the speed into the wall: HL Rally's v - 1.2 (v.n) n, then the whole scaled by (2 + cos) / 3. (Ours: only when the car goes
	// into the wall; HL Rally also reflects a velocity that leaves it, which only happens to a car already in the wall.)
	const float vn = Dot3(v, n);
	if (vn < 0)
	{
		const Vector turned = MA(v, -vn * (1.0f + H9R_WALL_BOUNCE), n);
		const float lo = Len3(v), ln = Len3(turned);
		const float c = (lo > 1e-3f && ln > 1e-3f) ? Dot3(v, turned) / (lo * ln) : 1.0f;
		const float keep = H9RallyCrashKeep(c);
		pmove->velocity = Vector(turned[0] * keep, turned[1] * keep, turned[2] * keep);
	}

	// out of the wall by the depth the outline went into it
	const Vector pene(best.endpos[0] - bestPoint[0], best.endpos[1] - bestPoint[1], best.endpos[2] - bestPoint[2]);
	const Vector want = Vector(pmove->origin[0] + pene[0], pmove->origin[1] + pene[1], pmove->origin[2] + pene[2]);
	pmtrace_t push = Trace(pmove->origin, want);
	d.pushed = Len3(pene) > 0.01f;
	d.pushDist = Len3(pene);
	pmove->origin = push.endpos;
}

// Inside something (a sliver of the map under the road, a seam, another car's box): the stock check only tries an eighth of a
// unit around. The car is lifted out, as far up as its own height and a little more, else moved out sideways, and drives on.
bool FreeTheCar(Dbg& d)
{
	for (float lift = 1.0f; lift <= H9R_HEIGHT + 2.0f; lift += 1.0f)
	{
		Vector test = pmove->origin;
		test[2] += lift;
		pmtrace_t tr;
		if (pmove->PM_TestPlayerPosition(test, &tr) == -1)
		{
			pmove->origin = test;
			d.lifted = true;
			return true;
		}
	}
	for (float r = 4.0f; r <= 32.0f; r *= 2.0f)
	{
		for (int k = 0; k < 8; k++)
		{
			const float a = (float)k * (float)(M_PI / 4.0);
			Vector test = pmove->origin;
			test[0] += cosf(a) * r;
			test[1] += sinf(a) * r;
			pmtrace_t tr;
			if (pmove->PM_TestPlayerPosition(test, &tr) == -1)
			{
				pmove->origin = test;
				d.lifted = true;
				return true;
			}
		}
	}
	return false;
}

float Dist2XY(const Vector& a, const Vector& b)
{
	return (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);
}

// The move (HL Rally's PM_MoveToDest): straight to the place when nothing is in the way; else, on the ground, the slide and the
// same move from a step up along the car's up, whichever went farther, the stepped one on a tie.
void MoveCar(bool grounded, const Vector& up, float dt, Dbg& d)
{
	const Vector org0 = pmove->origin;
	const Vector vel0 = pmove->velocity;
	const Vector dest = MA(org0, dt, vel0);
	pmtrace_t tr = Trace(org0, dest);
	if (tr.fraction >= 1.0f && !tr.allsolid)
	{
		pmove->origin = tr.endpos;
		return;
	}
	if (!grounded)
	{
		PM_FlyMove();
		return;
	}

	PM_FlyMove(); // the slide
	const Vector slideOrg = pmove->origin, slideVel = pmove->velocity;
	pmove->origin = org0;
	pmove->velocity = vel0;

	pmtrace_t upTr = Trace(org0, MA(org0, H9R_STEP_UP, up));
	if (!upTr.startsolid && !upTr.allsolid)
		pmove->origin = upTr.endpos;
	PM_FlyMove(); // the same from the step
	pmtrace_t downTr = Trace(pmove->origin, MA(pmove->origin, -H9R_STEP_UP, up));
	if (!downTr.startsolid && !downTr.allsolid)
		pmove->origin = downTr.endpos;

	if (H9RallySteppedWins(Dist2XY(slideOrg, org0), Dist2XY(pmove->origin, org0)))
	{
		pmove->velocity[2] = slideVel[2]; // the stepped move's own velocity, the slide's climb or fall
		d.stepped = true;
	}
	else
	{
		pmove->origin = slideOrg;
		pmove->velocity = slideVel;
	}
}

void DebugLine(const Dbg& d, bool held, const Vector& org0)
{
	static float s_next[33]; // debug only: when each player's next line is due
	const int who = pmove->player_index >= 0 && pmove->player_index < 33 ? pmove->player_index : 0;
	const float now = (float)pmove->Sys_FloatTime();
	if (now < s_next[who] && now > s_next[who] - 5.0f)
		return;
	s_next[who] = now + 0.5f;
	const Vector& o = pmove->origin;
	const Vector& v = pmove->velocity;
	pmove->Con_Printf("rallydbg p%d t=%.2f org=(%.1f %.1f %.1f) spd=%.1f vz=%.1f gnd=%d gap=%.1f n=(%.2f %.2f %.2f) tex=%s surf=%s "
					  "water=%d held=%d hull=%d maxspd=%.0f cmaxspd=%.0f ft=%.4f(eng %.4f) fuser1=%.2f fric=%.2f pull=%.2f stuck=%d freed=%d "
					  "lift=%d want=%.2f got=%.2f stepped=%d pushed=%d(%.2f) org0z=%.1f\n",
					  who, now, o[0], o[1], o[2], sqrtf(v[0] * v[0] + v[1] * v[1]), v[2], d.grounded ? 1 : 0, d.gap, d.normal[0], d.normal[1],
					  d.normal[2], d.tex, g_h9RallySurfaces[d.surface].name, pmove->waterlevel, held ? 1 : 0, pmove->usehull, pmove->maxspeed,
					  pmove->clientmaxspeed, d.dt, d.engineFrametime, d.fuser1, pmove->friction, d.pull, d.stuck ? 1 : 0, d.freed ? 1 : 0,
					  d.lifted ? 1 : 0, d.wanted, d.got, d.stepped ? 1 : 0, d.pushed ? 1 : 0, d.pushDist, org0[2]);
}

void MoveInner(Dbg& d, bool& heldOut, Vector& org0Out)
{
	const H9RallyCar& car = H9RallyCarByClass(H9RallyClass());
	d.fuser1 = pmove->fuser1;
	d.engineFrametime = pmove->frametime;

	// the time scale is not the car's: TS's slow motion (fuser1, 0 freezes) scales frametime before we are called, so the
	// command's own length is used
	const float dt = pmove->cmd.msec * 0.001f;
	pmove->frametime = dt;
	d.dt = dt;

	pmove->usehull = 2; // the point hull
	pmove->flags &= ~FL_DUCKING;
	pmove->bInDuck = false;
	pmove->view_ofs[2] = H9R_VIEW_HEIGHT;
	org0Out = pmove->origin;

	const bool held = H9RallyHeld(pmove->flags);
	heldOut = held;

	if (dt <= 0)
		return;
	if (PM_CheckStuck())
	{
		d.stuck = true;
		d.freed = FreeTheCar(d);
		if (!d.freed)
		{
			pmove->velocity = Vector(0, 0, 0); // nothing around is free: the race's own watch puts the car back on the track
			return;
		}
	}

	// the heading: the view's yaw, as HL Rally. (The client turns it with the steering keys: cl_dll/input.cpp.)
	const float yaw = pmove->cmd.viewangles[1] * (float)(M_PI / 180.0);
	const Vector heading(cosf(yaw), sinf(yaw), 0);
	pmove->angles[1] = pmove->cmd.viewangles[1];

	// the pedals (PM_CheckParamters has scaled forwardmove by maxspeed, so the buttons are what is trusted)
	H9RallyInput in;
	if (!held)
	{
		in.forward = (pmove->cmd.buttons & IN_FORWARD) != 0;
		in.back = (pmove->cmd.buttons & IN_BACK) != 0;
		in.hand = (pmove->cmd.buttons & IN_JUMP) != 0;
		in.steering = (pmove->cmd.buttons & (IN_LEFT | IN_RIGHT)) != 0; // the client sets these for the side keys too
	}
	// a held car (the countdown, after the finish) stands on its handbrake, and a slope does not roll it off the grid
	if (held)
		in.hand = true;

	CheckWater();
	const float grav = H9R_GRAVITY * (pmove->gravity != 0 ? pmove->gravity : 1.0f); // not sv_gravity: the car falls as in HL Rally

	// --- where the car stands ---------------------------------------------------------------------------------
	const Cat cat = Categorize();
	const bool grounded = cat.ground;
	d.grounded = grounded;
	d.gap = cat.gap;
	Vector up(0, 0, 1);
	if (grounded)
		up = GroundNormal(cat, heading);
	d.normal = up;
	const Vector preVelocity = pmove->velocity;

	if (grounded)
	{
		const Vector n = up;
		const Vector f = Unit(MA(heading, -Dot3(heading, n), n));
		const Vector l = Unit(Cross3(n, f));

		// the surface from the texture's name under the car
		H9RallyGround g;
		const char* tex = pmove->PM_TraceTexture(cat.ent >= 0 ? cat.ent : 0, Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] + 1.0f),
												 Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] - 64.0f));
		if (tex)
		{
			if (*tex == '-' || *tex == '+')
				tex += 2;
			snprintf(d.tex, sizeof d.tex, "%s", tex);
			g.surface = H9RallySurfaceByName(tex, &g.extraDrag);
		}
		d.surface = g.surface;
		g.pullScale = H9RClamp(pmove->friction, 0.1f, 2.0f); // func_friction: HL Rally's pull is x pmove->friction (a stuck 0 would stop a car)
		d.pull = g.pullScale;

		const Vector gv(0, 0, -grav);
		const Vector gt = MA(gv, -Dot3(gv, n), n); // gravity along the plane
		g.slopeF = Dot3(gt, f);
		g.slopeS = Dot3(gt, l);
		if (held)
			g.slopeF = g.slopeS = 0;

		const float vn0 = Dot3(pmove->velocity, n);
		float vf = Dot3(pmove->velocity, f), vs = Dot3(pmove->velocity, l);
		H9RallyGroundStep(vf, vs, in, g, car, dt);
		// across the plane: the ground holds the car, but a car that is leaving it (a ramp's lip, a crest) keeps going away, with
		// gravity's share on it; a car that is 2 or more above it (the long reach at rest) falls
		float vn = 0;
		if (vn0 > 0)
			vn = fmaxf(0.0f, vn0 - grav * n[2] * dt);
		if (cat.gap > H9R_FOLLOW + 0.5f)
			vn = fminf(vn0, 0.0f) - grav * dt;
		pmove->velocity = MA(MA(Vector(f[0] * vf, f[1] * vf, f[2] * vf), vs, l), vn, n);
	}
	else
	{
		// in the air: nothing drives it and nothing slows it (HL Rally has no friction off the ground); gravity
		pmove->velocity[2] -= grav * dt;
	}

	PM_CheckVelocity();

	// --- the body against the world, then the move ------------------------------------------------------------
	BodyAgainstWorld(heading, up, grounded, dt, d);

	const Vector org1 = pmove->origin;
	const Vector vel1 = pmove->velocity;
	MoveCar(grounded, up, dt, d);
	d.wanted = Len3(vel1) * dt;
	d.got = Len3(Vector(pmove->origin[0] - org1[0], pmove->origin[1] - org1[1], pmove->origin[2] - org1[2]));

	// --- where the car stands now: ground it hugs (at most 2 units, and only moving away slowly) or lands on ---
	const Cat now = Categorize();
	bool nowGround = now.ground;
	if (now.hit && now.gap <= H9R_FOLLOW + 0.001f)
	{
		const float vn = Dot3(pmove->velocity, now.normal);
		if (vn < H9R_FOLLOW_VN)
		{
			pmove->origin = now.endpos;
			if (vn != 0)
				pmove->velocity = MA(pmove->velocity, -vn, now.normal);
		}
	}
	(void)preVelocity;

	PM_CheckVelocity();
	pmove->onground = nowGround ? (now.ent >= 0 ? now.ent : 0) : -1;
	if (nowGround)
		pmove->waterjumptime = 0;
	CheckWater();
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
	Dbg d;
	bool held = false;
	Vector org0 = pmove->origin;
	MoveInner(d, held, org0);
	if (pmove->server)
	{
		const char* dbg = pmove->PM_Info_ValueForKey(pmove->physinfo, "rdbg");
		if (dbg && atoi(dbg) != 0)
			DebugLine(d, held, org0);
	}
}
