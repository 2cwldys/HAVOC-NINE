// H9 rally mode, the client side: the cars drawn and the two cameras. See h9_rallycar.h; the arithmetic is h9_rallycam_calc.h.
//
// THE CAR. A player is a car when his box says so (IsCarBox). The studio renderer then draws models/h9/rc_rally_xs.mdl in his place
// (StudioModelRenderer.cpp, StudioDrawCar): no human, no weapon. The model is the game's own, 46 long with its origin on the ground
// between the axles; this file gives it its yaw (the player's heading), its pitch and roll from four traces under the wheels
// (smoothed, with HL Rally's slide roll, brake dive and throttle squat for the local car), the front wheels' steering from the driver's wheel (another car's: how fast its heading turns), and the tyres' roll from the distance driven. The model
// is found with the studio API's Mod_ForName, so it needs no precache from the server (the server may precache it all the same,
// dlls/h9_rally_car.cpp, so a client without the file is told to fetch it).
//
// THE CAMERAS. cl_h9_rallycam 0 is the chase camera (HL Rally's: it looks along the way the car is GOING, 40 behind and 15 degrees down,
// pulled in by a trace so it never goes through a wall; h9_rallycam_zoom cycles 40, 70, 100, 35), 1 is the driver's seat (the bonnet: the
// car's own tilt, the car not drawn). The command h9_rallycam toggles them. The view's pitch the mouse gives is not used. The FOV is 90.
//
// THE STEERING (CL_CreateMove, input.cpp, with h9_rallysteer_calc.h). The heading is kept here, not in the view: see H9RallySteer_*.
#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "entity_state.h"
#include "cl_entity.h"
#include "com_model.h"
#include "r_studioint.h"
#include "ref_params.h"
#include "pm_defs.h"
#include "pmtrace.h"
#include "event_api.h"
#include "entity_types.h"

#include "h9_rallycar.h"
#include "h9_rallycam_calc.h"
#include "h9_racefx.h"
#include "h9_rallysteer_calc.h"

#include <string.h>
#include <stdlib.h>
#include <math.h>

extern engine_studio_api_t IEngineStudio;
extern bool g_iAlive; // entity.cpp

namespace
{

const char* const CAR_MODEL = "models/h9/rc_rally_xs.mdl";
const int MAX_SLOTS = 66;

cvar_t *s_cvCam, *s_cvBack, *s_cvUp, *s_cvPitch, *s_cvFov, *s_cvMouse;

model_t* s_model = nullptr;
float s_nextModelTry = 0;
model_t* s_hiddenViewModel = nullptr; // the weapon's model, kept while it is hidden

// What is kept for each car from frame to frame.
struct Slot
{
	bool have; // a previous frame is known
	float time;
	rallycam::V3 org;
	float yaw;
	rallycam::Tilt tilt;
	float phase;
	float steer; // degrees shown
};
Slot s_slot[MAX_SLOTS];

// What the local driver is doing, from the steering (CL_CreateMove): the car's body leans, dives and squats by it, and the wheels turn by
// his wheel. Remote cars have none of it (the server sends no input), so they roll with a slide and no more.
struct Dyn
{
	bool have;
	float time;
	bool braking, throttle;
	float wheel; // HL Rally's steer_wheel_angle, positive to the right, +-10
};
Dyn s_dyn = {false, 0, false, false, 0};
H9RallyKeys s_lastKeys = {0, 0, 0, false, false, false}; // the keys of the last CL_CreateMove (the sounds read them: h9_rallysnd.cpp)

// The local car's predicted state, from the refdef of the last frame (what CL_CreateMove of the next one reads).
struct Note
{
	bool have;
	float time;
	rallycam::V3 org, vel;
	bool onGround;
};
Note s_note = {false, 0, rallycam::V3(), rallycam::V3(), true};

// The steering's own state: the heading and the filter.
rallysteer::State s_steer;
float s_steerWritten = 0; // the yaw CL_CreateMove last wrote as the view's
float s_steerBegin = 0;   // the heading handed out by Begin this frame
bool s_mouseActive = false;

rallycam::ChaseState s_chase;
rallycam::FirstState s_first;

// The local player's refdef of this frame, for the car to be drawn where the camera saw it.
float s_viewTime = -1.0f;
rallycam::V3 s_viewOrg;
float s_viewYaw = 0;

// "rally" in the physinfo, once a frame
float s_rallyTime = -1.0f;
int s_rallyClass = 0;

bool Cv(cvar_t* c) { return c != nullptr && c->value >= 0.5f; }
float CvF(cvar_t* c, float def) { return c != nullptr ? c->value : def; }

int LocalRallyClass()
{
	const float now = gEngfuncs.GetClientTime();
	if (now != s_rallyTime)
	{
		s_rallyTime = now;
		const char* k = gEngfuncs.PhysInfo_ValueForKey("rally");
		s_rallyClass = k ? atoi(k) : 0;
	}
	return s_rallyClass;
}

model_t* CarModel()
{
	if (s_model != nullptr)
		return s_model;
	const float now = gEngfuncs.GetClientTime();
	if (now < s_nextModelTry)
		return nullptr;
	model_t* m = IEngineStudio.Mod_ForName ? IEngineStudio.Mod_ForName(CAR_MODEL, 0) : nullptr;
	if (m != nullptr && IEngineStudio.Mod_Extradata(m) != nullptr)
		s_model = m;
	else
		s_nextModelTry = now + 10.0f; // a model that is not there is asked for again in a while, not every frame
	return s_model;
}

// The model's own size: the tyres and the tilt's four points come from it.
void CarSize(float& len, float& width)
{
	len = 45.0f;
	width = 18.0f;
	if (s_model != nullptr)
	{
		const float l = s_model->maxs.x - s_model->mins.x, w = s_model->maxs.y - s_model->mins.y;
		if (l >= 8.0f && w >= 4.0f && l < 1024.0f && w < 1024.0f)
		{
			len = l;
			width = w;
		}
	}
}

// The height of the ground under (x, y), looking from `up` above `z` to `down` below it. A car (a player) is a physent with a studio
// model and is not the ground: the trace goes on from under it.
bool GroundZ(float x, float y, float z, float up, float down, float& out)
{
	Vector s(x, y, z + up);
	const Vector e(x, y, z - down);
	for (int tries = 0; tries < 4; tries++)
	{
		pmtrace_t* tr = gEngfuncs.PM_TraceLine((float*)&s, (float*)&e, PM_TRACELINE_PHYSENTSONLY, 2, -1);
		if (tr == nullptr || tr->fraction >= 1.0f || tr->allsolid)
			return false;
		if (tr->ent > 0)
		{
			physent_t* pe = gEngfuncs.pEventAPI->EV_GetPhysent(tr->ent);
			if (pe != nullptr && pe->studiomodel != nullptr)
			{
				s = Vector(s.x, s.y, tr->endpos[2] - 1.0f);
				if (s.z <= e.z)
					return false;
				continue;
			}
		}
		if (tr->startsolid && tr->fraction <= 0.0f)
			return false;
		if (tr->plane.normal[2] < 0.35f)
			return false; // a wall, not ground
		out = tr->endpos[2];
		return true;
	}
	return false;
}

// A trace from `a` to `b` through the world and its solid things (a car or a player is passed through): how far along it got, 0..1, 1 when
// nothing is in the way, and -1 when it started inside the world.
float TraceShare(const rallycam::V3& a, const rallycam::V3& b)
{
	using namespace rallycam;
	Vector s(a.x, a.y, a.z);
	const Vector e(b.x, b.y, b.z);
	const float whole = (b - a).Length();
	for (int tries = 0; tries < 4; tries++)
	{
		pmtrace_t* tr = gEngfuncs.PM_TraceLine((float*)&s, (float*)&e, PM_TRACELINE_PHYSENTSONLY, 2, -1);
		if (tr == nullptr || tr->fraction >= 1.0f)
			return 1.0f;
		physent_t* pe = tr->ent > 0 ? gEngfuncs.pEventAPI->EV_GetPhysent(tr->ent) : nullptr;
		if (pe != nullptr && pe->studiomodel != nullptr)
		{
			s = Vector(tr->endpos[0], tr->endpos[1], tr->endpos[2]);
			continue;
		}
		if (tr->allsolid || tr->startsolid)
			return -1.0f;
		const V3 hit(tr->endpos[0], tr->endpos[1], tr->endpos[2]);
		return whole > 1e-3f ? Clamp((hit - a).Length() / whole, 0.0f, 1.0f) : 0.0f;
	}
	return 1.0f;
}

// Brings a car's slot up to `time`: the wheels' roll, the steering, the tilt. Once for each time: a second call in the same frame (the
// camera and then the draw) changes nothing.
Slot& Update(int index, const rallycam::V3& org, float yaw, float time, const rallycam::V3& vel, const Dyn* dyn)
{
	using namespace rallycam;
	if (index < 0 || index >= MAX_SLOTS)
		index = 0;
	Slot& s = s_slot[index];
	const float dt = time - s.time;
	if (s.have && dt <= 0.0f && dt > -0.5f)
		return s; // this frame again (or the clock stepped back a hair)
	const bool fresh = !s.have || dt > 0.25f || dt < 0.0f || (org - s.org).Length() > 160.0f;

	float len, width;
	CarSize(len, width);

	// tyres and steering
	if (!fresh)
	{
		const V3 nose(cosf(Rad(yaw)), sinf(Rad(yaw)), 0);
		const V3 d = org - s.org;
		s.phase = RollPhase(s.phase, d.Dot(nose), 0.5f * len); // the tyres' circumference is about half the car's length
		float goal;
		if (dyn != nullptr && dyn->have)
			goal = WheelShown(dyn->wheel, 32.0f); // the driver's own wheel
		else
		{
			// another car: from how fast its nose turns (the keys at most 100 a second), the other way when it goes backwards
			const float rate = AngleDelta(s.yaw, yaw) / dt;
			goal = SteerShown(rate, 32.0f, 100.0f) * (vel.x * nose.x + vel.y * nose.y < 0.0f ? -1.0f : 1.0f);
		}
		s.steer += (goal - s.steer) * Alpha(dt, 0.03f);
	}
	else
	{
		s.phase = 0;
		s.steer = 0;
	}

	// tilt: the ground under four points, front and rear and either side, a car's wheels' places
	const float hl = 0.30f * len, hw = 0.40f * width;
	const float cy = cosf(Rad(yaw)), sy = sinf(Rad(yaw));
	const float px[4] = {hl, hl, -hl, -hl}, py[4] = {hw, -hw, hw, -hw}; // FL FR RL RR
	float h[4] = {0, 0, 0, 0};
	bool got[4];
	int n = 0;
	float sum = 0;
	for (int i = 0; i < 4; i++)
	{
		const float wx = org.x + cy * px[i] - sy * py[i], wy = org.y + sy * px[i] + cy * py[i];
		got[i] = GroundZ(wx, wy, org.z, 8.0f, 24.0f, h[i]);
		if (got[i])
		{
			n++;
			sum += h[i];
		}
	}
	float tp, tr, tau;
	if (n == 0)
	{
		// in the air: the nose follows the way the car goes, slowly
		tp = AirPitch(vel.z, sqrtf(vel.x * vel.x + vel.y * vel.y));
		tr = 0;
		tau = 0.30f;
	}
	else
	{
		for (int i = 0; i < 4; i++)
			if (!got[i])
				h[i] = sum / (float)n; // a wheel over an edge takes the others' mean
		EulerFromNormal(NormalFromHeights(yaw, h[0], h[1], h[2], h[3], hl, hw), yaw, tp, tr);
		// what HL Rally adds to the ground's tilt: the slide's roll, the dive under the brake, the squat on the throttle
		BodyMotion(vel.Length(), RightShare(yaw, vel), dyn != nullptr && dyn->have && dyn->braking, dyn != nullptr && dyn->have && dyn->throttle, tp, tr);
		tau = RefTau(0.9f); // (new + 9 old) / 10 a frame at 99 frames a second
	}
	TiltStep(s.tilt, tp, tr, fresh ? 0.0f : dt, tau);

	s.have = true;
	s.time = time;
	s.org = org;
	s.yaw = yaw;
	return s;
}

// Where the local car is this frame, by the refdef when there was one.
void LocalPose(const cl_entity_t* ent, rallycam::V3& org, float& yaw)
{
	if (s_viewTime == gEngfuncs.GetClientTime())
	{
		org = s_viewOrg;
		yaw = s_viewYaw;
		return;
	}
	org = rallycam::V3(ent->origin[0], ent->origin[1], ent->origin[2]);
	float va[3];
	gEngfuncs.GetViewAngles(va);
	yaw = va[1];
}

void Cmd_Toggle()
{
	const int now = Cv(s_cvCam) ? 1 : 0;
	gEngfuncs.Cvar_SetValue("cl_h9_rallycam", now ? 0.0f : 1.0f);
	gEngfuncs.Con_Printf("h9_rallycam: %s\n", now ? "chase camera" : "driver's seat");
}

// h9_rallycam_zoom: HL Rally's chase_zoom.cfg, the distance behind the car 40, 70, 100, 35 and round.
void Cmd_Zoom()
{
	static const float steps[4] = {40.0f, 70.0f, 100.0f, 35.0f};
	const float now = CvF(s_cvBack, 40.0f);
	int at = 0;
	for (int i = 1; i < 4; i++)
		if (fabsf(steps[i] - now) < fabsf(steps[at] - now))
			at = i;
	const float next = steps[(at + 1) % 4];
	gEngfuncs.Cvar_SetValue("cl_h9_rallycam_dist", next);
	gEngfuncs.Con_Printf("h9_rallycam_zoom: %.0f units behind the car\n", next);
}

// The local driver's inputs of this frame, or none when the steering has not run lately.
const Dyn* DynPtr()
{
	const float now = gEngfuncs.GetClientTime();
	return s_dyn.have && now - s_dyn.time < 0.25f && now >= s_dyn.time - 0.05f ? &s_dyn : nullptr;
}

// The local car's last predicted state, or none when it is old (the refdef has not been drawn for a while).
bool FreshNote()
{
	const float now = gEngfuncs.GetClientTime();
	return s_note.have && now - s_note.time < 0.25f && now >= s_note.time - 0.05f;
}

} // namespace

// ----------------------------------------------------------------------------------------------------------------------------

void H9RallyCam_Init()
{
	s_cvCam = CVAR_CREATE("cl_h9_rallycam", "0", FCVAR_ARCHIVE); // 0 chase, 1 the driver's seat
	s_cvBack = CVAR_CREATE("cl_h9_rallycam_dist", "40", FCVAR_ARCHIVE); // HL Rally's cam_wishdist
	s_cvUp = CVAR_CREATE("cl_h9_rallycam_up", "26", FCVAR_ARCHIVE);
	s_cvPitch = CVAR_CREATE("cl_h9_rallycam_pitch", "15", FCVAR_ARCHIVE); // degrees down, on top of the velocity's slope
	s_cvFov = CVAR_CREATE("cl_h9_rallycam_fov", "90", FCVAR_ARCHIVE);     // in a car; 0 leaves the player's own
	s_cvMouse = CVAR_CREATE("cl_h9_rally_mouse", "1.0", FCVAR_ARCHIVE);   // scales the mouse's steering
	gEngfuncs.pfnAddCommand("h9_rallycam", Cmd_Toggle);
	gEngfuncs.pfnAddCommand("h9_rallycam_zoom", Cmd_Zoom);
}

void H9RallyCam_VidInit()
{
	s_model = nullptr;
	s_hiddenViewModel = nullptr;
	s_nextModelTry = 0;
	memset(s_slot, 0, sizeof(s_slot));
	for (int i = 0; i < MAX_SLOTS; i++)
		s_slot[i].tilt = rallycam::Tilt();
	s_chase = rallycam::ChaseState();
	s_first = rallycam::FirstState();
	s_viewTime = -1.0f;
	s_rallyTime = -1.0f;
	s_note.have = false;
	s_dyn.have = false;
	s_steer = rallysteer::State();
	s_mouseActive = false;
}

bool H9RallyCar_IsCarState(const entity_state_t* st)
{
	if (st == nullptr)
		return false;
	using namespace rallycam;
	return IsCarBox(V3(st->mins[0], st->mins[1], st->mins[2]), V3(st->maxs[0], st->maxs[1], st->maxs[2]));
}

bool H9RallyCar_IsCarEntity(const cl_entity_t* ent)
{
	return ent != nullptr && ent->player && H9RallyCar_IsCarState(&ent->curstate);
}

bool H9RallyCam_LocalIsCar()
{
	return LocalRallyClass() > 0 && g_iAlive && 0 == g_iUser1 && 0 == gEngfuncs.IsSpectateOnly();
}

bool H9RallyCam_ChaseActive()
{
	return H9RallyCam_LocalIsCar() && !Cv(s_cvCam);
}

void H9RallyCar_AddEntity(int type, cl_entity_t* ent)
{
	using namespace rallycam;
	if (type != ET_PLAYER || ent == nullptr || ent->index <= 0 || !H9RallyCar_IsCarEntity(ent))
		return;
	model_t* m = CarModel();
	if (m == nullptr)
		return;
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	const bool isLocal = local != nullptr && local->index == ent->index;
	V3 org(ent->origin[0], ent->origin[1], ent->origin[2]);
	float yaw = ent->angles[1];
	if (isLocal)
		LocalPose(ent, org, yaw);
	V3 vel(ent->curstate.velocity[0], ent->curstate.velocity[1], ent->curstate.velocity[2]);
	if (isLocal && FreshNote())
		vel = s_note.vel; // the predicted one
	Update(ent->index, org, yaw, gEngfuncs.GetClientTime(), vel, isLocal ? DynPtr() : nullptr);
	H9RaceFx_NoteEntity(ent, CAR_MODEL, m); // tyre marks, spray, shadow and brake lights, from the blending bytes the server sets
}

bool H9RallyCar_Pose(cl_entity_t* ent, const entity_state_t* st, H9RallyCarDraw& out)
{
	using namespace rallycam;
	if (ent == nullptr || st == nullptr)
		return false;
	model_t* m = CarModel();
	if (m == nullptr)
		return false;
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	const bool isLocal = local != nullptr && local->index == ent->index;
	V3 org(ent->origin[0], ent->origin[1], ent->origin[2]);
	float yaw = ent->angles[1];
	if (isLocal)
		LocalPose(ent, org, yaw);
	V3 vel(st->velocity[0], st->velocity[1], st->velocity[2]);
	if (isLocal && FreshNote())
		vel = s_note.vel;
	Slot& s = Update(ent->index, org, yaw, gEngfuncs.GetClientTime(), vel, isLocal ? DynPtr() : nullptr);
	out.model = m;
	out.origin[0] = org.x;
	out.origin[1] = org.y;
	out.origin[2] = org.z;
	out.angles[0] = s.tilt.pitch;
	out.angles[1] = yaw;
	out.angles[2] = s.tilt.roll;
	out.skin = st->skin & 255;
	out.steerByte = SteerByte(s.steer, 45.0f);
	out.phase = s.phase;
	return true;
}

bool H9RallyCam_Apply(ref_params_s* pp, cl_entity_t* view)
{
	using namespace rallycam;
	if (pp == nullptr || !H9RallyCam_LocalIsCar())
	{
		s_chase.init = false;
		s_first.init = false;
		if (view != nullptr && s_hiddenViewModel != nullptr && view->model == nullptr)
			view->model = s_hiddenViewModel; // out of the car: the weapon's model as it was
		s_hiddenViewModel = nullptr;
		return false;
	}
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	if (local == nullptr)
		return false;
	model_t* m = CarModel();

	const V3 car(pp->simorg[0], pp->simorg[1], pp->simorg[2]);
	const V3 vel(pp->simvel[0], pp->simvel[1], pp->simvel[2]);
	const float heading = pp->cl_viewangles[1]; // the heading IS the view's yaw (pm_shared/h9_rally.cpp); the pitch is the mouse's and is not used
	const float dt = pp->frametime;
	const float now = gEngfuncs.GetClientTime();

	s_viewTime = now;
	s_viewOrg = car;
	s_viewYaw = heading;
	H9RallySteer_NoteView(pp->simorg, pp->simvel, 0 != pp->onground, now);
	const Slot& slot = Update(local->index, car, heading, now, vel, DynPtr());

	Pose pose;
	if (Cv(s_cvCam))
	{
		FirstParams fp;
		pose = FirstStep(s_first, car, heading, slot.tilt, dt, fp);
		s_chase.init = false;
	}
	else
	{
		ChaseParams cp;
		cp.back = Clamp(CvF(s_cvBack, 40.0f), 20.0f, 400.0f);
		cp.up = Clamp(CvF(s_cvUp, 26.0f), 0.0f, 200.0f);
		cp.wishPitch = Clamp(CvF(s_cvPitch, 15.0f), -60.0f, 80.0f);
		const ChaseAim aim = ChaseAimOf(s_chase, heading, vel, dt, cp);
		s_first.init = false;

		// never through the world: HL Rally's two traces from just above the origin to where the camera wants to be, one at the camera's own
		// height and one 16 above it; the nearer wall decides. Another car or a player on the way is passed through.
		V3 start, endLow, endHigh;
		ChaseTrace(car, aim, cp.back, start, endLow, endHigh);
		const float fl = TraceShare(start, endLow), fh = TraceShare(start, endHigh);
		const float fraction = (fl < 0.0f || fh < 0.0f) ? -1.0f : (fl < fh ? fl : fh);
		pose = ChaseFinish(s_chase, car, vel, aim, fraction, dt, cp);
	}

	pp->vieworg[0] = pose.org.x;
	pp->vieworg[1] = pose.org.y;
	pp->vieworg[2] = pose.org.z;
	pp->viewangles[0] = pose.pitch;
	pp->viewangles[1] = pose.yaw;
	pp->viewangles[2] = pose.roll;
	AngleVectors(pp->viewangles, pp->forward, pp->right, pp->up);

	// the weapon's model is not drawn in a car
	if (view != nullptr)
	{
		if (view->model != nullptr)
			s_hiddenViewModel = view->model;
		view->model = nullptr;
	}

	// the race effects need the local car noted even where the engine does not offer it to HUD_AddEntity (the driver's seat)
	if (m != nullptr && H9RallyCar_IsCarEntity(local))
		H9RaceFx_NoteEntity(local, CAR_MODEL, m);
	return true;
}

// ---- the steering ----------------------------------------------------------------------------------------------------------------

void H9RallySteer_NoteView(const float simorg[3], const float simvel[3], bool onGround, float time)
{
	s_note.have = true;
	s_note.time = time;
	s_note.org = rallycam::V3(simorg[0], simorg[1], simorg[2]);
	s_note.vel = rallycam::V3(simvel[0], simvel[1], simvel[2]);
	s_note.onGround = onGround;
}

float H9RallySteer_Begin(float viewYaw)
{
	using namespace rallysteer;
	// a yaw that is not the one last written was set by the engine (the server's fixangle: a respawn, a teleport): start again from it
	if (!s_steer.init || fabsf(Wrap180(viewYaw - s_steerWritten)) > 0.1f)
		Reset(s_steer, viewYaw);
	s_steerBegin = s_steer.heading;
	s_mouseActive = true;
	return s_steer.heading;
}

void H9RallySteer_Idle()
{
	s_steer.init = false;
	s_mouseActive = false;
	s_dyn.have = false;
}

bool H9RallySteer_MouseActive() { return s_mouseActive; }
bool H9RallySteer_OnGround() { return !FreshNote() || s_note.onGround; }
float H9RallySteer_MouseScale() { return CvF(s_cvMouse, 1.0f); }

float H9RallySteer_End(float viewYaw, const H9RallyKeys& k)
{
	using namespace rallysteer;
	Input in;
	in.dt = k.frametime;
	in.keyYaw = kKeyRate * k.frametime * (Clampf(k.left, 0.0f, 1.0f) - Clampf(k.right, 0.0f, 1.0f));
	in.mouseYaw = Wrap180(viewYaw - s_steerBegin); // the mouse turned the view this far to the left
	in.throttle = k.throttle;
	in.brake = k.brake;
	in.handbrake = k.handbrake;
	const bool fresh = FreshNote();
	in.onGround = !fresh || s_note.onGround;
	if (fresh)
	{
		in.velX = s_note.vel.x;
		in.velY = s_note.vel.y;
		in.velZ = s_note.vel.z;
		static rallycam::V3 lastOrg;
		static bool haveOrg = false;
		if (haveOrg && (s_note.org - lastOrg).Length() > 100.0f)
		{
			// a jump of more than 100 units in a frame is a teleport or a respawn: the filter starts again
			s_steer.delta = 0;
			s_steer.tractionLoss = 0;
			s_steer.box = Gearbox();
		}
		lastOrg = s_note.org;
		haveOrg = true;
	}
	if (!in.onGround)
		in.mouseYaw = 0.0f;
	const Output out = Step(s_steer, in);
	s_steerWritten = out.heading;
	s_mouseActive = false;
	s_dyn.have = true;
	s_dyn.time = gEngfuncs.GetClientTime();
	s_dyn.braking = k.brake || k.handbrake;
	s_dyn.throttle = k.throttle;
	s_dyn.wheel = s_steer.wheel;
	s_lastKeys = k;
	return out.heading;
}

bool H9RallyCar_LocalSpeed(float& speed3d, float& alongNose)
{
	if (!H9RallyCam_LocalIsCar() || !FreshNote())
		return false;
	speed3d = s_note.vel.Length();
	const float h = (s_steer.init ? s_steer.heading : 0.0f) * (3.14159265f / 180.0f);
	alongNose = s_note.vel.x * cosf(h) + s_note.vel.y * sinf(h);
	return true;
}

float H9RallyCam_Fov()
{
	const float f = CvF(s_cvFov, 90.0f);
	return H9RallyCam_LocalIsCar() && f > 1.0f ? f : 0.0f;
}

// What the sounds (h9_rallysnd.cpp) read of the local car: the steering's gearbox and the predicted state, and the keys of the last command.
bool H9RallyCar_DriveNote(H9RallyDriveNote& o)
{
	memset(&o, 0, sizeof(o));
	if (!H9RallyCam_LocalIsCar() || !s_steer.init)
		return false;
	o.rpm = s_steer.box.rpm;
	o.gear = s_steer.box.gear;
	o.tractionLoss = s_steer.tractionLoss;
	o.valid = FreshNote();
	o.onGround = !o.valid || s_note.onGround;
	if (o.valid)
	{
		o.vel[0] = s_note.vel.x;
		o.vel[1] = s_note.vel.y;
		o.vel[2] = s_note.vel.z;
		o.org[0] = s_note.org.x;
		o.org[1] = s_note.org.y;
		o.org[2] = s_note.org.z;
	}
	o.heading = s_steer.heading;
	o.carClass = LocalRallyClass();
	o.throttle = s_lastKeys.throttle;
	o.brake = s_lastKeys.brake;
	o.handbrake = s_lastKeys.handbrake;
	return true;
}
