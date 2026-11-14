// H9 rally mode, the client side: the cars drawn and the two cameras. See h9_rallycar.h; the arithmetic is h9_rallycam_calc.h.
//
// THE CAR. A player is a car when his box says so (IsCarBox). The studio renderer then draws models/h9/rc_rally_xs.mdl in his place
// (StudioModelRenderer.cpp, StudioDrawCar): no human, no weapon. The model is the game's own, 46 long with its origin on the ground
// between the axles; this file gives it its yaw (the player's heading), its pitch and roll from four traces under the wheels
// (smoothed), the front wheels' steering from how fast the heading turns, and the tyres' roll from the distance driven. The model
// is found with the studio API's Mod_ForName, so it needs no precache from the server (the server may precache it all the same,
// dlls/h9_rally_car.cpp, so a client without the file is told to fetch it).
//
// THE CAMERAS. cl_h9_rallycam 0 is the chase camera (behind and above, looking a little ahead, its heading lagging the car's more in
// a slide, pulled in by a trace so it never goes through a wall), 1 is the driver's seat (the car's own tilt, the car not drawn).
// The command h9_rallycam toggles it. The view's pitch the mouse gives is not used: the camera sets its own.
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

#include <string.h>
#include <stdlib.h>
#include <math.h>

extern engine_studio_api_t IEngineStudio;
extern bool g_iAlive; // entity.cpp

namespace
{

const char* const CAR_MODEL = "models/h9/rc_rally_xs.mdl";
const int MAX_SLOTS = 66;

cvar_t *s_cvCam, *s_cvBack, *s_cvUp, *s_cvAhead;

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

// Brings a car's slot up to `time`: the wheels' roll, the steering, the tilt. Once for each time: a second call in the same frame (the
// camera and then the draw) changes nothing.
Slot& Update(int index, const rallycam::V3& org, float yaw, float time, const rallycam::V3& vel)
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
		const float rate = AngleDelta(s.yaw, yaw) / dt;
		const float goal = SteerShown(rate, 32.0f, 400.0f);
		s.steer += (goal - s.steer) * Alpha(dt, 0.06f);
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
		tau = 0.07f;
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

} // namespace

// ----------------------------------------------------------------------------------------------------------------------------

void H9RallyCam_Init()
{
	s_cvCam = CVAR_CREATE("cl_h9_rallycam", "0", FCVAR_ARCHIVE); // 0 chase, 1 the driver's seat
	s_cvBack = CVAR_CREATE("cl_h9_rallycam_back", "70", FCVAR_ARCHIVE);
	s_cvUp = CVAR_CREATE("cl_h9_rallycam_up", "26", FCVAR_ARCHIVE);
	s_cvAhead = CVAR_CREATE("cl_h9_rallycam_ahead", "18", FCVAR_ARCHIVE);
	gEngfuncs.pfnAddCommand("h9_rallycam", Cmd_Toggle);
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
	const V3 vel(ent->curstate.velocity[0], ent->curstate.velocity[1], ent->curstate.velocity[2]);
	Update(ent->index, org, yaw, gEngfuncs.GetClientTime(), vel);
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
	const V3 vel(st->velocity[0], st->velocity[1], st->velocity[2]);
	Slot& s = Update(ent->index, org, yaw, gEngfuncs.GetClientTime(), vel);
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
	const Slot& slot = Update(local->index, car, heading, now, vel);

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
		cp.back = Clamp(CvF(s_cvBack, 70.0f), 20.0f, 400.0f);
		cp.up = Clamp(CvF(s_cvUp, 26.0f), 0.0f, 200.0f);
		cp.ahead = Clamp(CvF(s_cvAhead, 18.0f), 0.0f, 200.0f);
		pose = ChaseStep(s_chase, car, heading, vel, dt, cp);
		s_first.init = false;

		// never through the world: from above the car's middle to where the camera would be. Another car or a player on the way is passed through.
		const V3 anchor = ChaseAnchor(car, cp.lookUp);
		Vector s(anchor.x, anchor.y, anchor.z);
		const Vector e(pose.org.x, pose.org.y, pose.org.z);
		pmtrace_t* tr = nullptr;
		for (int tries = 0; tries < 4; tries++)
		{
			tr = gEngfuncs.PM_TraceLine((float*)&s, (float*)&e, PM_TRACELINE_PHYSENTSONLY, 2, -1);
			if (tr == nullptr || tr->fraction >= 1.0f)
				break;
			physent_t* pe = tr->ent > 0 ? gEngfuncs.pEventAPI->EV_GetPhysent(tr->ent) : nullptr;
			if (pe != nullptr && pe->studiomodel != nullptr)
			{
				s = Vector(tr->endpos[0], tr->endpos[1], tr->endpos[2]);
				continue;
			}
			break;
		}
		if (tr != nullptr && tr->fraction < 1.0f)
		{
			// the last leg's fraction is of that leg: take it as a share of the whole way from the anchor
			const V3 hit(tr->endpos[0], tr->endpos[1], tr->endpos[2]);
			const float whole = (pose.org - anchor).Length();
			const float got = (hit - anchor).Length();
			pose.org = PullIn(anchor, pose.org, whole > 1e-3f ? got / whole : 0.0f, 4.0f, 8.0f);
		}
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
