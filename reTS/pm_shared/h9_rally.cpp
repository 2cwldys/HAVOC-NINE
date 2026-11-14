/***
*  h9_rally.cpp -- rally mode in pmove (H9): the player moves as a car. Compiled into both the server and the client
*  library (pm_shared is shared), so the server runs it and the client predicts the same step.
*
*  The aim is HL Rally's movement 1:1 (the car is the player, moved by pmove: the heading is the command's view yaw, the
*  ground's slope is read with four traces under the body, the car's body is checked by traces from its middle out to
*  points around its outline, the texture under it picks the surface). The code, names and comments are ours; HL Rally's
*  source has no licence and none of it is copied. The handling itself is in h9_rally.h.
*
*  One command, in HL Rally's order: the car is looked for on the ground (a trace 2 down along its up, 16 straight down when it
*  is at rest: any hit is ground), its tilt is read from four traces, then half the gravity; on the ground the drag and the
*  sideways hold, the body against the world (PM_Crash), the engine's pull and the move (a straight trace; a kerb or a wall: the
*  slide against the step-up along the car's up, the stepped one winning a tie); in the air the move and then the body against
*  the world; where the car stands now; the other half of the gravity. Everything is applied once per command with the command's
*  own length: there are no sub-steps and no snapping to the ground.
*
*  What it keeps from one frame to the next: only the player's own origin, velocity and the command's view angles,
*  which the engine already predicts. No statics that change the movement, no iuser/fuser/vuser. The mode is on while the
*  physinfo key "rally" is a car class (1 on), which the server sets (dlls/h9_rally_srv.cpp) and the engine sends to the
*  client in the client data's physinfo string, the way TS's "mj" reaches pmove. The key "rdbg" (1) turns on the debug line;
*  "rfin" (1) says the car has finished its race.
*
*  Where this is NOT HL Rally's (the one difference): HL Rally remembers the car's tilt from the frame before (in vuser1 and in
*  the angles) and looks for the ground along it. pmove here keeps no state, so the "frame before" tilt is read again with
*  the same four traces made straight down from the car's place, and the ground is looked for along that.
*
*  What does NOT limit a car here, so that nothing of The Specialists' on-foot movement holds it: the car's wish speed is
*  its own stat (h9_rally.h), never pmove->maxspeed (the loadout changes that); the time scale (fuser1, TS's slow motion)
*  is ignored; there is no water check at all (as HL Rally's: waterlevel stays 0); the held state is FL_FROZEN alone.
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
bool PM_CheckStuck();
void PM_CheckVelocity();
bool PM_AddToTouched(pmtrace_t tr, Vector impactvelocity);

float g_h9RallyCrashAmount = 0; // velocity along the wall's normal at the last body check, 0 when no wall

namespace
{
inline float Dot3(const Vector& a, const Vector& b)
{
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline Vector Cross3(const Vector& a, const Vector& b)
{
	return Vector(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
}

inline Vector MA(const Vector& a, float s, const Vector& b)
{
	return Vector(a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]);
}

inline float Len3(const Vector& v)
{
	return sqrtf(Dot3(v, v));
}

inline Vector Neg(const Vector& v)
{
	return Vector(-v[0], -v[1], -v[2]);
}

pmtrace_t Trace(const Vector& a, const Vector& b)
{
	Vector s = a, e = b;
	return pmove->PM_PlayerTrace(s, e, PM_NORMAL, -1);
}

// What one command did, for the debug line (physinfo "rdbg" 1, server only). Nothing here reaches the movement.
struct Dbg
{
	bool stuck = false;
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
	bool toss = false;
	float fuser1 = 1.0f, engineFrametime = 0;
	float dt = 0;
};

// The car's own axes for a heading and a tilt (HLR keeps them in pmove->forward, ->right and the angles). `right` is HL's right.
struct Axes
{
	Vector fwd, right, up;
};
Axes AxesOf(float pitch, float yaw, float roll)
{
	Axes a;
	AngleVectors(Vector(pitch, yaw, roll), &a.fwd, &a.right, &a.up);
	return a;
}

// The ground's tilt (HLR rally.c PM_PlayerAngles): four traces along `up` from 4 above to 16 below the origin, at 8 to the side and
// 12 to the front or the back of a car whose axes are `ax`. Their ends give a plane; the plane in the car's yaw gives the pitch and
// the roll.
void ReadTilt(const Axes& ax, float yaw, float& pitch, float& roll)
{
	const Vector r8 = MA(Vector(0, 0, 0), H9R_TILT_SIDE, ax.right);
	const Vector f12 = MA(Vector(0, 0, 0), H9R_TILT_FRONT, ax.fwd);
	const Vector ofsFR = r8 + f12;              // front, right
	const Vector ofsFL = f12 - r8;              // front, left
	const Vector ofs[4] = {ofsFR, Neg(ofsFR), ofsFL, Neg(ofsFL)}; // f1, b2, f2, b1
	Vector end[4];
	for (int i = 0; i < 4; i++)
	{
		const Vector from = MA(MA(pmove->origin, H9R_TILT_FROM, ax.up), 1.0f, ofs[i]);
		const Vector to = MA(MA(pmove->origin, -H9R_TILT_TO, ax.up), 1.0f, ofs[i]);
		end[i] = Trace(from, to).endpos;
	}
	const float f1[3] = {end[0][0], end[0][1], end[0][2]}, b2[3] = {end[1][0], end[1][1], end[1][2]};
	const float f2[3] = {end[2][0], end[2][1], end[2][2]}, b1[3] = {end[3][0], end[3][1], end[3][2]};
	H9RallyTilt(f1, f2, b1, b2, yaw, &pitch, &roll);
}

// Where the car stands (HLR pm_shared.c PM_CatagorizePosition): a trace from the origin 2 down along the car's up (16 straight down
// when the car is under 5 u/s); anything at all it hits is ground, and a car going up faster than 1800 is in the air. Sets
// pmove->onground and returns how far below the origin the hit was (for the debug line).
float Categorize(const Vector& up)
{
	float gap = 0;
	const Vector o = pmove->origin;
	Vector point;
	if (Len3(pmove->velocity) > H9R_SLOW_SPEED)
		point = MA(o, -H9R_GROUND_REACH, up);
	else
		point = Vector(o[0], o[1], o[2] - H9R_GROUND_REACH_SLOW);

	if (pmove->velocity[2] > H9R_LIFT_VZ)
	{
		pmove->onground = -1;
	}
	else
	{
		pmtrace_t tr = Trace(o, point);
		pmove->onground = H9RallyIsGround(tr.fraction < 1.0f ? tr.ent : -1, pmove->velocity[2]) ? tr.ent : -1;
		gap = tr.fraction * Len3(Vector(point[0] - o[0], point[1] - o[1], point[2] - o[2]));
		if (pmove->onground != -1)
			pmove->waterjumptime = 0;
		if (tr.ent > 0)
			PM_AddToTouched(tr, pmove->velocity); // standing on an entity other than the world
	}
	return gap;
}

// The car's body against the world (HLR PM_Crash + PM_CarWorldCollision): the outline is traced at the place the move is going
// to (origin + velocity * dt), from the body's middle (8 above, along the car's up) out to the points of h9_rally.h's grid, on the
// sides the car goes toward (all four at rest, or at 10 u/s and under). The nearest hit (a trace that starts inside something is
// the nearest) is the wall; in the air a plane with nz over 0.3 passes (it is ground to land on). Else the velocity is reflected
// off it whether the car goes into it or away from it, kept by (2 + cos) / 3, and the origin is pushed back by how far the
// outline reached into it.
void Crash(const Axes& ax, Dbg& d)
{
	g_h9RallyCrashAmount = 0; // HL Rally's CL_CrashAmount (rally.c:693): the client's wall-hit sound reads it
	const Vector v = pmove->velocity;
	const Vector dest = MA(pmove->origin, pmove->frametime, v);
	const Vector left = Neg(ax.right);
	const Vector center = MA(dest, H9R_TRACE_GAP, ax.up);

	const H9RallySides sides = H9RallyCrashSides(Dot3(v, ax.fwd), Dot3(v, left), Len3(v));
	float pts[64][3];
	const int np = H9RallyCrashPoints(sides, pmove->movevars->stepsize, pts, 64);

	pmtrace_t best;
	bool have = false;
	Vector bestPoint;
	float bestFrac = 1.0f;
	for (int i = 0; i < np; i++)
	{
		const Vector p = MA(MA(MA(dest, pts[i][0], ax.fwd), pts[i][1], left), pts[i][2], ax.up);
		pmtrace_t t = Trace(center, p);
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
	if (n[2] < 0.3f) // rally.c:711: not for ground
		g_h9RallyCrashAmount = Dot3(v, n);
	if (H9RallyCrashIgnores(pmove->onground != -1, n[2]))
		return;

	float vel[3] = {v[0], v[1], v[2]}, nn[3] = {n[0], n[1], n[2]};
	H9RallyCrashVelocity(vel, nn);
	pmove->velocity = Vector(vel[0], vel[1], vel[2]);

	// out of the wall by the depth the outline went into it
	const Vector pene(best.endpos[0] - bestPoint[0], best.endpos[1] - bestPoint[1], best.endpos[2] - bestPoint[2]);
	const Vector want = Vector(pmove->origin[0] + pene[0], pmove->origin[1] + pene[1], pmove->origin[2] + pene[2]);
	pmtrace_t push = Trace(pmove->origin, want);
	d.pushed = Len3(pene) > 0.01f;
	d.pushDist = Len3(pene);
	pmove->origin = push.endpos;
}

// The car's own FlyMove (HLR rally.c PM_FlyMove): up to four bumps against the planes in the way. In the air, or when the entity's
// friction is not 1, on a walking car, every plane met clips the carried velocity (h9_rally.h's H9RallyClipPlanesAir); on the
// ground the stock multi-plane slide at 1.1, with the crease between two planes. No epsilon zeroing, no blocked flags.
int FlyMove(bool walking)
{
	const int kMaxPlanes = 5;
	float planes[kMaxPlanes][3];
	int numplanes = 0;
	Vector primal = pmove->velocity, original = pmove->velocity;
	float allFraction = 0;
	float timeLeft = pmove->frametime;

	for (int bump = 0; bump < 4; bump++)
	{
		if (!pmove->velocity[0] && !pmove->velocity[1] && !pmove->velocity[2])
			break;
		const Vector end = MA(pmove->origin, timeLeft, pmove->velocity);
		pmtrace_t tr = Trace(pmove->origin, end);
		allFraction += tr.fraction;
		if (tr.allsolid)
		{
			pmove->velocity = Vector(0, 0, 0);
			return 4;
		}
		if (tr.fraction > 0)
		{
			pmove->origin = tr.endpos;
			original = pmove->velocity;
			numplanes = 0;
		}
		if (tr.fraction == 1)
			break;
		PM_AddToTouched(tr, pmove->velocity);
		timeLeft -= timeLeft * tr.fraction;
		if (numplanes >= kMaxPlanes)
		{
			pmove->velocity = Vector(0, 0, 0);
			break;
		}
		planes[numplanes][0] = tr.plane.normal[0];
		planes[numplanes][1] = tr.plane.normal[1];
		planes[numplanes][2] = tr.plane.normal[2];
		numplanes++;

		if (walking && (pmove->onground == -1 || pmove->friction != 1.0f))
		{
			float orig[3] = {original[0], original[1], original[2]}, out[3];
			H9RallyClipPlanesAir(orig, planes, numplanes, out);
			pmove->velocity = Vector(out[0], out[1], out[2]);
			original = pmove->velocity;
		}
		else
		{
			int i;
			for (i = 0; i < numplanes; i++)
			{
				float in[3] = {original[0], original[1], original[2]}, out[3];
				H9RallyClip(in, planes[i], H9R_CLIP_WALL, out);
				pmove->velocity = Vector(out[0], out[1], out[2]);
				int j;
				for (j = 0; j < numplanes; j++)
					if (j != i)
					{
						const Vector pj(planes[j][0], planes[j][1], planes[j][2]);
						if (Dot3(pmove->velocity, pj) < 0)
							break; // moving against this plane
					}
				if (j == numplanes)
					break; // no other plane was in the way
			}
			if (i == numplanes)
			{
				// the crease between two planes
				if (numplanes != 2)
				{
					pmove->velocity = Vector(0, 0, 0);
					break;
				}
				const Vector p0(planes[0][0], planes[0][1], planes[0][2]), p1(planes[1][0], planes[1][1], planes[1][2]);
				const Vector dir = Cross3(p0, p1);
				const float along = Dot3(dir, pmove->velocity);
				pmove->velocity = Vector(dir[0] * along, dir[1] * along, dir[2] * along);
			}
			// turned back against where it was going: stop dead rather than tremble in a corner
			if (Dot3(pmove->velocity, primal) <= 0)
			{
				pmove->velocity = Vector(0, 0, 0);
				break;
			}
		}
	}
	if (allFraction == 0)
		pmove->velocity = Vector(0, 0, 0);
	return 0;
}

float Dist2XY(const Vector& a, const Vector& b)
{
	return (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);
}

// The move (HLR rally.c PM_MoveToDest): straight to the place when nothing is in the way; else the slide and the same move from a
// step up along the car's up (and back down the same step), whichever went farther in the plane, the stepped one on a tie.
void MoveToDest(const Vector& up, Dbg& d)
{
	const Vector org0 = pmove->origin;
	const Vector vel0 = pmove->velocity;
	const Vector dest = MA(org0, pmove->frametime, vel0);
	pmtrace_t tr = Trace(org0, dest);
	if (tr.fraction == 1)
	{
		pmove->origin = tr.endpos;
		return;
	}
	// (HL Rally returns here when the car was not on the ground; the move is only called on the ground)

	FlyMove(true); // the slide
	const Vector slideOrg = pmove->origin, slideVel = pmove->velocity;
	pmove->origin = org0;
	pmove->velocity = vel0;

	const float step = pmove->movevars->stepsize;
	pmtrace_t upTr = Trace(org0, MA(org0, step, up));
	if (!upTr.startsolid && !upTr.allsolid)
		pmove->origin = upTr.endpos;
	FlyMove(true); // the same from the step
	pmtrace_t downTr = Trace(pmove->origin, MA(pmove->origin, -step, up));
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

// PM_PushEntity: the origin goes as far along `push` as it can
pmtrace_t PushEntity(const Vector& push)
{
	const Vector end = Vector(pmove->origin[0] + push[0], pmove->origin[1] + push[1], pmove->origin[2] + push[2]);
	pmtrace_t tr = Trace(pmove->origin, end);
	pmove->origin = tr.endpos;
	if (tr.fraction < 1.0f && !tr.allsolid)
		PM_AddToTouched(tr, pmove->velocity);
	return tr;
}

void AddCorrectGravity(float entGravity)
{
	pmove->velocity[2] = H9RallyGravityHalf(pmove->velocity[2], entGravity, pmove->movevars->gravity, pmove->frametime);
	pmove->velocity[2] += pmove->basevelocity[2] * pmove->frametime;
	pmove->basevelocity[2] = 0;
	PM_CheckVelocity();
}

void FixupGravityVelocity(float entGravity)
{
	pmove->velocity[2] = H9RallyGravityHalf(pmove->velocity[2], entGravity, pmove->movevars->gravity, pmove->frametime);
	PM_CheckVelocity();
}

// A held car (the countdown) is a tossed player in HL Rally (movetype TOSS: PM_Physics_Toss and no drive): it falls, stops dead on
// a floor with nz over 0.7 and slides on a steeper plane.
void PhysicsToss(Dbg& d)
{
	if (pmove->velocity[2] > 0)
		pmove->onground = -1;
	if (pmove->onground != -1 && pmove->basevelocity[0] == 0 && pmove->basevelocity[1] == 0 && pmove->basevelocity[2] == 0 &&
		pmove->velocity[0] == 0 && pmove->velocity[1] == 0 && pmove->velocity[2] == 0)
		return;
	PM_CheckVelocity();

	// gravity added whole, the move with the base velocity folded in
	const float entGravity = pmove->gravity != 0 ? pmove->gravity : 1.0f;
	pmove->velocity[2] -= entGravity * pmove->movevars->gravity * pmove->frametime;
	pmove->velocity[2] += pmove->basevelocity[2] * pmove->frametime;
	pmove->basevelocity[2] = 0;
	PM_CheckVelocity();

	pmove->velocity = pmove->velocity + pmove->basevelocity;
	PM_CheckVelocity();
	const Vector move = Vector(pmove->velocity[0] * pmove->frametime, pmove->velocity[1] * pmove->frametime, pmove->velocity[2] * pmove->frametime);
	pmove->velocity = pmove->velocity - pmove->basevelocity;

	pmtrace_t tr = PushEntity(move);
	PM_CheckVelocity();

	if (tr.allsolid)
	{
		pmove->onground = tr.ent;
		pmove->velocity = Vector(0, 0, 0);
		return;
	}
	if (tr.fraction == 1)
		return;

	float in[3] = {pmove->velocity[0], pmove->velocity[1], pmove->velocity[2]}, out[3];
	const float nn[3] = {tr.plane.normal[0], tr.plane.normal[1], tr.plane.normal[2]};
	H9RallyClip(in, nn, 1.0f, out);
	pmove->velocity = Vector(out[0], out[1], out[2]);
	if (tr.plane.normal[2] > H9R_TOSS_STOP_NZ)
	{
		// a car that is not bounced stops dead on a floor
		pmove->onground = tr.ent;
		pmove->velocity = Vector(0, 0, 0);
	}
	d.toss = true;
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
					  "water=%d held=%d hull=%d maxspd=%.0f cmaxspd=%.0f ft=%.4f(eng %.4f) fuser1=%.2f fric=%.2f pull=%.2f stuck=%d "
					  "want=%.2f got=%.2f stepped=%d pushed=%d(%.2f) org0z=%.1f toss=%d\n",
					  who, now, o[0], o[1], o[2], sqrtf(v[0] * v[0] + v[1] * v[1]), v[2], d.grounded ? 1 : 0, d.gap, d.normal[0], d.normal[1],
					  d.normal[2], d.tex, g_h9RallySurfaces[d.surface].name, pmove->waterlevel, held ? 1 : 0, pmove->usehull, pmove->maxspeed,
					  pmove->clientmaxspeed, d.dt, d.engineFrametime, d.fuser1, pmove->friction, d.pull, d.stuck ? 1 : 0, d.wanted, d.got,
					  d.stepped ? 1 : 0, d.pushed ? 1 : 0, d.pushDist, org0[2], d.toss ? 1 : 0);
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
	pmove->waterlevel = 0; // no water check: HL Rally's PM_CheckWater call is commented out
	pmove->watertype = CONTENTS_EMPTY;

	const bool held = H9RallyHeld(pmove->flags);
	heldOut = held;

	if (dt <= 0)
		return;

	// the heading: the view's yaw, as HL Rally. (The client turns it with the steering keys: cl_dll/input.cpp.)
	float yaw = pmove->cmd.viewangles[1];
	pmove->angles[1] = yaw;
	if (pmove->angles[1] > 180.0f)
		pmove->angles[1] -= 360.0f;
	yaw = pmove->angles[1];

	// stuck: no move (as HL Rally)
	if (PM_CheckStuck())
	{
		d.stuck = true;
		return;
	}

	// the keys: the client's decisions, as HL Rally's server reads them
	const float speed0H = sqrtf(pmove->velocity[0] * pmove->velocity[0] + pmove->velocity[1] * pmove->velocity[1]);
	H9RallyInput in;
	in.forward = (pmove->cmd.buttons & IN_FORWARD) != 0;
	in.back = (pmove->cmd.buttons & IN_BACK) != 0;
	in.hand = (pmove->cmd.buttons & IN_JUMP) != 0;
	in.steering = (pmove->cmd.buttons & (IN_LEFT | IN_RIGHT)) != 0; // the client sets these for the side keys too
	const char* fin = pmove->PM_Info_ValueForKey(pmove->physinfo, "rfin");
	if (fin && atoi(fin) != 0)
		in = H9RallyFinishKeys(speed0H); // the finish: the back key while it is over 20 u/s, then nothing
	if (held)
		in = H9RallyInput(); // a held car is not driven
	const float fmove = H9RallyForwardMove(in, speed0H);

	// the tilt as the frame before left it (see the top of the file), and the axes from it with this command's yaw
	float pitch0 = 0, roll0 = 0;
	ReadTilt(AxesOf(0, yaw, 0), yaw, pitch0, roll0);
	Axes ax0 = AxesOf(pitch0, yaw, roll0); // pmove->forward and ->right, and the up that Categorize looks along
	pmove->angles[0] = pitch0;
	pmove->angles[2] = roll0;

	// --- where the car stands ---------------------------------------------------------------------------------
	d.gap = Categorize(ax0.up);

	// --- the tilt of the ground (PM_PlayerAngles): on the ground it is read again, in the air it is flat ---------------
	Vector stepUp = Vector(0, 0, 1);
	if (pmove->onground != -1)
	{
		float pitch = 0, roll = 0;
		ReadTilt(ax0, yaw, pitch, roll);
		pmove->angles[0] = pitch;
		pmove->angles[2] = roll;
		stepUp = AxesOf(pitch, yaw, roll).up;
	}
	d.normal = stepUp;
	const Axes axNow = AxesOf(pmove->angles[0], yaw, pmove->angles[2]); // the body's axes (the angles as they stand)

	if (pmove->onground == -1)
		pmove->flFallVelocity = -pmove->velocity[2];
	d.grounded = pmove->onground != -1;

	const float entGravity = pmove->gravity != 0 ? pmove->gravity : 1.0f;
	const float wish = H9RallyWish(car);
	const float friction = pmove->movevars->friction;

	// the surface under the car, by the texture's name: looked for straight down from the origin
	H9RallySurface su = g_h9RallySurfaces[H9RS_NEUTRAL];
	float extraDrag = 0;
	auto Surface = [&]() {
		const char* tex = pmove->PM_TraceTexture(pmove->onground, pmove->origin, Vector(pmove->origin[0], pmove->origin[1], pmove->origin[2] - 64.0f));
		if (tex)
		{
			snprintf(d.tex, sizeof d.tex, "%s", tex);
			d.surface = H9RallySurfaceByName(tex, &extraDrag);
		}
		else
		{
			d.surface = H9RS_NEUTRAL;
			extraDrag = 0;
		}
		su = g_h9RallySurfaces[d.surface];
	};
	auto Friction = [&]() {
		Surface();
		d.pull = pmove->friction;
		float v[3] = {pmove->velocity[0], pmove->velocity[1], pmove->velocity[2]};
		const float f[3] = {ax0.fwd[0], ax0.fwd[1], ax0.fwd[2]}, r[3] = {ax0.right[0], ax0.right[1], ax0.right[2]};
		H9RallyFriction(v, f, r, in, fmove, su.lat, su.drag + extraDrag, H9RallyHandling(car), friction, dt);
		pmove->velocity = Vector(v[0], v[1], v[2]);
	};

	if (held)
	{
		// the countdown: HL Rally's movetype TOSS
		PhysicsToss(d);
		AddCorrectGravity(entGravity);
		if (pmove->onground != -1)
			Friction();
		PM_CheckVelocity();
		if (pmove->onground == -1)
		{
			pmove->velocity = pmove->velocity + pmove->basevelocity;
			FlyMove(false);
			Crash(axNow, d);
		}
	}
	else
	{
		AddCorrectGravity(entGravity);
		if (pmove->onground != -1)
			Friction();
		PM_CheckVelocity();

		if (pmove->onground != -1)
		{
			Crash(axNow, d);

			// the drive: the engine's pull, the base velocity, and the move (not under 1 u/s)
			const float hs = sqrtf(pmove->velocity[0] * pmove->velocity[0] + pmove->velocity[1] * pmove->velocity[1]);
			if (fmove != 0 && !(fmove > 0 && hs >= H9R_GEAR_CAP))
			{
				float v[3] = {pmove->velocity[0], pmove->velocity[1], pmove->velocity[2]};
				float dir[3] = {ax0.fwd[0], ax0.fwd[1], ax0.fwd[2]};
				H9RNormalize(dir);
				if (fmove < 0)
					for (int i = 0; i < 3; i++)
						dir[i] = -dir[i];
				H9RallyAccelerate(v, dir, wish, pmove->movevars->accelerate, pmove->friction, dt, fmove);
				pmove->velocity = Vector(v[0], v[1], v[2]);
			}
			pmove->velocity = pmove->velocity + pmove->basevelocity;
			const Vector org1 = pmove->origin;
			const float spd = Len3(pmove->velocity);
			d.wanted = spd * dt;
			if (spd >= 1.0f)
				MoveToDest(stepUp, d);
			d.got = Len3(Vector(pmove->origin[0] - org1[0], pmove->origin[1] - org1[1], pmove->origin[2] - org1[2]));
		}
		else
		{
			// the air: nothing drives it and nothing slows it; the move, then the body against the world
			pmove->velocity = pmove->velocity + pmove->basevelocity;
			const Vector org1 = pmove->origin;
			d.wanted = Len3(pmove->velocity) * dt;
			FlyMove(true);
			d.got = Len3(Vector(pmove->origin[0] - org1[0], pmove->origin[1] - org1[1], pmove->origin[2] - org1[2]));
			Crash(axNow, d);
		}
	}

	// --- where the car stands now ---------------------------------------------------------------------------
	Categorize(stepUp);
	pmove->velocity = pmove->velocity - pmove->basevelocity;
	FixupGravityVelocity(entGravity);
	PM_CheckVelocity();
	if (pmove->onground != -1)
		pmove->flFallVelocity = 0;
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
