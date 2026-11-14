// H9 rally mode, the client side: the cars drawn and the views. See h9_rallycar.h; the arithmetic is h9_rallycam_calc.h.
//
// THE CAR. A player is a car when his box says so (IsCarBox). The studio renderer then draws models/h9/rc_rally_xs.mdl in his place
// (StudioModelRenderer.cpp, StudioDrawCar): no human, no weapon. The model is the game's own, 46 long with its origin on the ground
// between the axles; this file gives it its yaw (the player's heading), its pitch and roll from HL Rally's five terrain probes (the local
// car) or the one under another car, with HL Rally's noise from the surface, slide roll, brake dive and throttle squat (the local car),
// the front wheels' steering from the driver's wheel (the local car only; another car's stay straight) and the tyres' roll. The model
// is found with the studio API's Mod_ForName, so it needs no precache from the server (the server may precache it all the same,
// dlls/h9_rally_car.cpp, so a client without the file is told to fetch it).
//
// THE VIEWS (HL Rally's `c` key goes round them: chase, bonnet, side camera, TV camera, interior). The default is the
// interior (the owner's choice; HL Rally starts in the chase view) and a new map starts in it again (HL Rally: in_camera.cpp:256-263).
//  chase     HL Rally's: it looks along the way the car is GOING, 40 behind and 15 degrees down, pulled in by a trace so it never goes through
//            a wall; h9_rallycam_zoom walks 70, 100, 35.
//  bonnet    on the car, 6 ahead and 15 up, the car's own tilt, the car drawn.   side   25 behind, 13.75 right and 10 up, the car drawn.
//  TV        HL Rally's (in_camera.cpp:645-715, 880-906): the map's info_camera nearest the car, every frame, looking at the car, with a FOV
//            that narrows with the distance (rallycam::TvFov). The cameras are read from the world's entity string when the level changes.
//  interior  the weapon's slot holds models/h9/rally_interior.mdl, a view model with a wheel, a speedometer and a rev counter on bone
//            controllers; the eye is 12 over the origin; a second view pass draws the rear-view mirror. Without the model it is the chase view.
// The view's pitch the mouse gives is not used. The FOV is 90.
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
#include "pm_shared.h"
#include "h9_rally.h"
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
const char* const INTERIOR_MODEL = "models/h9/rally_interior.mdl";
const char* const CHROME_MODEL = "models/h9/rally_interior_chrome.mdl";
const int MAX_SLOTS = 66;

cvar_t *s_cvView, *s_cvBack, *s_cvPivot, *s_cvPitch, *s_cvFov, *s_cvMouse, *s_cvRear, *s_cvChrome, *s_cvManual;

model_t* s_model = nullptr;
float s_nextModelTry = 0;
model_t* s_interior = nullptr;
float s_nextInteriorTry = 0;
model_t* s_chrome = nullptr;
float s_nextChromeTry = 0;
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
	rallycam::NoiseHold noise; // the body's noise (HL Rally draws it once a frame at 99 a second)
	float braketime;           // the local car's tyres under the brake
	// what the ground said this frame, before any noise or motion (the interior builds on it)
	bool rawValid;
	float rawPitch, rawRoll;
	float mulInterior; // the interior's roughness over this surface
	bool hasShock;     // the local car's suspension (HL Rally keeps these in statics, from the last frame it ran)
	float shock[4];
};
Slot s_slot[MAX_SLOTS];

// What the local driver is doing, from the steering (CL_CreateMove): the car's body leans, dives and squats by it, and the wheels turn by
// his wheel. Remote cars have none of it (the server sends no input), so they roll with a slide and no more.
struct Dyn
{
	bool have;
	float time;
	bool braking;   // the back key or the handbrake (g_braking || g_handbraking)
	bool throttle;  // the forward key
	bool back;      // the back key
	bool handbrake;
	float traction; // g_tractionloss, 0..1
	float wheel;    // HL Rally's steer_wheel_angle, positive to the right, +-10
	bool gbraking;  // g_braking alone (the tyres lock under it; `braking` above also has the handbrake, which squats the body)
	int reversing;  // g_reversing
};
Dyn s_dyn = {false, 0, false, false, false, false, 0, 0, false, 0};
H9RallyKeys s_lastKeys = {0, 0, 0, false, false, false, false, false, 0}; // the keys of the last CL_CreateMove (the sounds read them: h9_rallysnd.cpp)

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
rallycam::InteriorState s_int;
int s_zoomStep = 0;           // HL Rally's changedistance alias: where it is in 70, 100, 35
int s_viewNow = rallycam::VIEW_CHASE; // the view in force in this frame's refdef

// The TV camera's cameras (HL Rally's cam_origins, in_camera.cpp:719-721), read again when the level's name changes (:886-890), and the FOV the
// last TV frame asked for.
rallycam::V3 s_tvCams[rallycam::kTvMaxCams];
int s_tvCount = 0;
char s_tvLevel[80] = "";
float s_tvFov = 0.0f;
float s_specTvTime = -1.0f; // the client time of the last frame a spectator saw through the TV camera

void TvLoad()
{
	const char* lv = gEngfuncs.pfnGetLevelName ? gEngfuncs.pfnGetLevelName() : "";
	if (lv == nullptr)
		lv = "";
	if (stricmp(lv, s_tvLevel) == 0)
		return;
	snprintf(s_tvLevel, sizeof s_tvLevel, "%s", lv);
	s_tvCount = 0;
	cl_entity_t* world = gEngfuncs.GetEntityByIndex(0);
	if (world != nullptr && world->model != nullptr)
		s_tvCount = rallycam::TvParseCameras(world->model->entities, s_tvCams, rallycam::kTvMaxCams);
}
bool s_mirrorPending = false;

// The local player's refdef of this frame, for the car to be drawn where the camera saw it.
float s_viewTime = -1.0f;
rallycam::V3 s_viewOrg;
float s_viewYaw = 0;

// "rally" in the physinfo, once a frame
float s_rallyTime = -1.0f;
int s_rallyClass = 0;

bool Cv(cvar_t* c) { return c != nullptr && c->value >= 0.5f; }

// The race's hold (the grid, the countdown): the client data's flags carry FL_FROZEN, and pmove has them.
bool Held() { return pmove != nullptr && H9RallyHeld(pmove->flags); }
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

// A model by name, looked up again every 10 seconds while it is not there (a file that is missing is not asked for every frame).
model_t* FindModel(const char* name, model_t*& cache, float& nextTry)
{
	if (cache != nullptr)
		return cache;
	const float now = gEngfuncs.GetClientTime();
	if (now < nextTry)
		return nullptr;
	model_t* m = IEngineStudio.Mod_ForName ? IEngineStudio.Mod_ForName(name, 0) : nullptr;
	if (m != nullptr && IEngineStudio.Mod_Extradata(m) != nullptr)
		cache = m;
	else
		nextTry = now + 10.0f;
	return cache;
}

model_t* CarModel() { return FindModel(CAR_MODEL, s_model, s_nextModelTry); }
model_t* InteriorModel() { return FindModel(INTERIOR_MODEL, s_interior, s_nextInteriorTry); }
model_t* ChromeModel() { return FindModel(CHROME_MODEL, s_chrome, s_nextChromeTry); }

// The view the player wants and the one in force (the interior needs its model).
int ViewInForce() { return rallycam::ViewInForce((int)(CvF(s_cvView, (float)rallycam::VIEW_INTERIOR) + 0.5f), InteriorModel() != nullptr); }

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

// The hull the probes trace: HL Rally's EV_SetTraceHull(0) (StudioModelRenderer.cpp:1193), the hull its car moves in. On a rally map that is
// the physics' own (physinfo "rhull": usehull 0, BSP hull 1 with the clip brushes; pm_shared/h9_rally.cpp); elsewhere the point hull.
int ProbeHull()
{
	const char* v = gEngfuncs.PhysInfo_ValueForKey("rhull");
	return (v != nullptr && atoi(v) != 0) ? 0 : 2;
}

// One trace of HL Rally's terrain probes (TerrainTrace, StudioModelRenderer.cpp:1086-1140: EV_PlayerTrace, PM_NORMAL, ignore -1, after
// EV_SetTraceHull(0), :1193-1195): from `from` to `to` through the world and the physents. Another car or player is a physent with a studio model
// and STOPS the trace, as in HL Rally (a car's tilt on another car's roof). HL Rally never excludes anything (ignore -1): the local player is not
// among the physents there, the engine's prediction leaves out the player it predicts. Ours skips the local player's own physent as well, in case
// this engine's list holds it (it is found by its entity index in `info`); that is the only difference. True when anything is hit; the end point
// is where it stopped, `to` when nothing was in the way.
bool Probe(const rallycam::V3& from, const rallycam::V3& to, rallycam::V3& endpos, rallycam::V3& normal)
{
	using namespace rallycam;
	Vector s(from.x, from.y, from.z);
	const Vector e(to.x, to.y, to.z);
	const V3 dir = (to - from).Unit();
	endpos = to;
	normal = V3(0, 0, 1);
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	const int self = local != nullptr ? local->index : -1;
	for (int tries = 0; tries < 4; tries++)
	{
		pmtrace_t* tr = gEngfuncs.PM_TraceLine((float*)&s, (float*)&e, PM_TRACELINE_PHYSENTSONLY, ProbeHull(), -1);
		if (tr == nullptr || tr->fraction >= 1.0f)
			return false;
		if (tr->ent > 0)
		{
			physent_t* pe = gEngfuncs.pEventAPI->EV_GetPhysent(tr->ent);
			if (pe != nullptr && pe->studiomodel != nullptr && pe->info == self)
			{
				s = Vector(tr->endpos[0] + dir.x, tr->endpos[1] + dir.y, tr->endpos[2] + dir.z);
				if ((V3(s.x, s.y, s.z) - from).Dot(dir) >= (to - from).Length())
					return false;
				continue;
			}
		}
		// HL Rally keeps whatever the trace hit, a start inside a clip brush or a wall included (TerrainTrace: only ent -1 is air)
		endpos = V3(tr->endpos[0], tr->endpos[1], tr->endpos[2]);
		normal = V3(tr->plane.normal[0], tr->plane.normal[1], tr->plane.normal[2]);
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

// The surface's name 64 units under the car (StudioModelRenderer.cpp:1340-1354), for the roughness. HL Rally's origin is a unit over the floor (its
// hull is +-1 high), ours is on it: the trace starts a unit up, so it begins where HL Rally's does.
const char* SurfaceUnder(const rallycam::V3& org)
{
	float a[3] = {org.x, org.y, org.z + 1.0f}, b[3] = {org.x, org.y, org.z - 64.0f};
	return gEngfuncs.pEventAPI->EV_TraceTexture(0, a, b);
}

float Unit() { return gEngfuncs.pfnRandomFloat(-1.0f, 1.0f); }

// Brings a car's slot up to `time`: the wheels' roll and the tilt. Once for each time: a second call in the same frame (the camera and then the
// draw) changes nothing. `local` is the player's own car (five probes, the filter, the body's motion, the wheels' rules); another car has the one
// probe under it, the tilt as it is and nothing else of HL Rally's. `prevAnglesHlr` are the angles the server last sent for another car.
Slot& Update(int index, const rallycam::V3& org, float yaw, float time, const rallycam::V3& vel, const Dyn* dyn, bool local, const float* prevAnglesHlr)
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
	const float vh = sqrtf(vel.x * vel.x + vel.y * vel.y);
	const V3 nose(cosf(Rad(yaw)), sinf(Rad(yaw)), 0);

	// the tyres' turn
	if (!fresh)
	{
		(void)len;
		const float circ = kWheelCircumference; // HL Rally's wheel sequence turns once per 47.5 units of speed-seconds (h9_rallycam_calc.h)
		if (local && dyn != nullptr && dyn->have)
		{
			// HL Rally's rules for its own car (StudioProcessGait): by the horizontal speed, locked by the brake, stopped by the handbrake,
			// turned back when starting in reverse, five times as fast in a slide
			const float f = WheelSpinFactor(s.braketime, vh, dyn->gbraking, dyn->throttle, dyn->reversing != 0, dyn->handbrake, dyn->traction, dt);
			s.phase = RollPhase(s.phase, f * vh * dt, circ);
		}
		else
			s.phase = RollPhase(s.phase, (org - s.org).Dot(nose), circ); // another car: the distance driven along the nose
	}
	else
	{
		s.phase = 0;
		s.braketime = 0;
	}

	// the ground: HL Rally's probes. The local car's five are at +-8 across and +-12 along the axes of the physics' tilt, each from 2 over to
	// 2 under along its roof; "in the air" is all five missing. Another car's one probe is straight down, and its tilt is that plane's normal.
	V3 up(0, 0, 1), fwd(cosf(Rad(yaw)), sinf(Rad(yaw)), 0), right(sinf(Rad(yaw)), -cosf(Rad(yaw)), 0);
	float sp, sy, sr;
	if (local && H9RallyStoredTilt(&sp, &sy, &sr))
	{
		// HL Rally aims the probes along AngleVectors(pmove->vuser1) (StudioModelRenderer.cpp:1224 and :1552): the physics' tilt of the last
		// predicted command, never the drawn tilt. Aiming them along the drawn (filtered) tilt fed it back into itself: once tilted, the probes
		// missed a flat floor and their misses lay on the same tilted plane, so the view stayed rolled (-55 degrees on flat ground, 2026-11-14 log).
		const Axes ax = ViewVectors(sp, sy, sr);
		up = ax.n;
		fwd = ax.f;
		right = ax.l * -1.0f;
	}
	V3 pe, ne;
	bool airborne = !Probe(org + up * kProbeReach, org - up * kProbeReach, pe, ne);
	V3 normal = ne;
	if (local)
	{
		const V3 corner[4] = {fwd * kProbeForward + right * kProbeRight,  // front right
							  fwd * -kProbeForward + right * -kProbeRight, // back left
							  fwd * kProbeForward + right * -kProbeRight, // front left
							  fwd * -kProbeForward + right * kProbeRight}; // back right
		V3 pt[4], nn;
		for (int i = 0; i < 4; i++)
			if (Probe(org + up * kProbeReach + corner[i], org - up * kProbeReach + corner[i], pt[i], nn))
				airborne = false;
		normal = NormalFromPoints(pt[2], pt[0], pt[1], pt[3]); // FL FR RL RR
	}

	const float spd = vel.Length();
	float tp = 0, tr = 0;
	s.rawValid = false;
	if (!airborne)
	{
		const char* tex = SurfaceUnder(org);
		const float mulBody = RoughMul(tex, false);
		s.mulInterior = RoughMul(tex, true);
		EulerFromNormal(normal, yaw, tp, tr);
		s.rawPitch = tp;
		s.rawRoll = tr;
		s.rawValid = true;
		// the noise (a draw once a reference frame, held between)
		if (NoiseDue(s.noise, dt > 0.0f ? dt : 0.0f))
		{
			s.noise.a = Unit();
			s.noise.b = Unit();
		}
		tp += RoughAngle(spd, mulBody, s.noise.a);
		tr += RoughAngle(spd, mulBody, s.noise.b);
		if (local)
		{
			// what HL Rally adds to the ground's tilt: the slide's roll, the dive under the brake, the squat on the throttle (not in a slide)
			BodyMotion(spd, RightShare(yaw, vel), dyn != nullptr && dyn->have && dyn->braking, dyn != nullptr && dyn->have && dyn->throttle, tp, tr,
					   dyn != nullptr && dyn->have && dyn->traction > 0.0f);
			// (new + 4 old) / 5 for the pitch and (new + 3 old) / 4 for the roll, a reference frame (StudioModelRenderer.cpp:1440-1441)
			TiltStep(s.tilt, tp, tr, fresh ? 0.0f : dt, RefTau(0.8f), RefTau(0.75f));
		}
		else
			TiltStep(s.tilt, tp, tr, 0.0f, 0.0f); // another car has no filter: the angles are the ground's with the noise
	}
	else
	{
		if (!s.tilt.init || fresh)
			TiltStep(s.tilt, 0.0f, 0.0f, 0.0f, 0.0f);
		else if (local)
		{
			float p = s.tilt.pitch, r = s.tilt.roll;
			AirDrift(p, r, true, dt);
			s.tilt.pitch = Clamp(p, -50.0f, 50.0f);
			s.tilt.roll = Clamp(r, -50.0f, 50.0f);
		}
		else
		{
			// another car: from the angles the server sent (HL Rally's pitch has the other sign)
			float p = prevAnglesHlr != nullptr ? -prevAnglesHlr[0] : 0.0f, r = prevAnglesHlr != nullptr ? prevAnglesHlr[2] : 0.0f;
			AirDrift(p, r, false, dt);
			s.tilt.pitch = Clamp(p, -50.0f, 50.0f);
			s.tilt.roll = Clamp(r, -50.0f, 50.0f);
		}
	}

	if (local)
	{
		// the suspension's four traces, along the filtered tilt's axes (StudioModelRenderer.cpp:1440-1463, and :1483-1497 in the air)
		const Axes ax = EntityMatrixColumns(s.tilt.pitch, yaw, s.tilt.roll);
		const V3 u = ax.n, f = ax.f, r = ax.l * -1.0f;
		const V3 corner[4] = {f * kProbeForward + r * kProbeRight,   // front right
							  f * -kProbeForward + r * -kProbeRight, // back left
							  f * kProbeForward + r * -kProbeRight,  // front left
							  f * -kProbeForward + r * kProbeRight}; // back right
		float val[4]; // in the tilt's order: FR, BL, FL, BR
		for (int i = 0; i < 4; i++)
		{
			float frac = TraceShare(org + u * kShockFrom + corner[i], org - u * kShockTo + corner[i]); // 1 when nothing is hit, -1 when it starts inside
			if (frac < 0.0f)
				frac = 0.0f; // HL Rally's trace.fraction is 0 then
			val[i] = ShockOffset(frac);
		}
		s.shock[0] = val[0]; // frontRight
		s.shock[1] = val[2]; // frontLeft
		s.shock[2] = val[1]; // backLeft
		s.shock[3] = val[3]; // backRight
		s.hasShock = true;
	}

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

// h9_rallycam: HL Rally's `changeview` (its `c` key): the next view of chase, bonnet, side, TV, interior.
void Cmd_View()
{
	const int next = rallycam::NextView(ViewInForce(), InteriorModel() != nullptr);
	gEngfuncs.Cvar_SetValue("cl_h9_rallyview", (float)next);
	static const char* const names[5] = {"chase camera", "TV camera", "bonnet camera", "side camera", "interior"};
	gEngfuncs.Con_Printf("h9_rallycam: %s\n", names[next >= 0 && next < 5 ? next : 0]);
}

// h9_rallycam_zoom: HL Rally's chase_zoom.cfg, the distance behind the car 70, 100, 35 and round (the 40 it starts at is not come back to).
void Cmd_Zoom()
{
	const float next = rallycam::ChaseZoomDistance(s_zoomStep);
	gEngfuncs.Cvar_SetValue("cl_h9_rallycam_dist", next);
	gEngfuncs.Con_Printf("h9_rallycam_zoom: %.0f units behind the car\n", next);
}

// +h9_camdistance, -h9_camdistance: HL Rally's +camdistance (its `i` key): held, the mouse moves the camera in and out and does not steer. HL Rally
// starts it only in a third-person view (every view but the interior); the key's release always ends it.
bool s_zoomHeld = false;
void Cmd_ZoomStart()
{
	s_zoomHeld = H9RallyCam_LocalIsCar() && rallycam::ViewShowsCar(ViewInForce());
}
void Cmd_ZoomEnd()
{
	s_zoomHeld = false;
}

// h9_gearup, h9_geardown: HL Rally's gearup and geardown (input.cpp:471-486), which only do anything in the manual box (up to 6, down to -1).
void Cmd_GearUp()
{
	rallysteer::GearUp(s_steer.box, Cv(s_cvManual));
}
void Cmd_GearDown()
{
	rallysteer::GearDown(s_steer.box, Cv(s_cvManual));
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

// ---- the log (pm_shared/h9_rallylog.h): the input model's frame, one CSV line to rallylog/cl_<map>_<date-time>.txt ----------------------------

static cvar_t* s_cvLog = nullptr;       // cl_h9_rally_log
static H9RallyLogFile s_logFile;
static H9RallyClientRec s_logRec;       // filled over the frame: the throttle, the steering, the camera; written by H9RallyLog_Frame
static bool s_logReopen = true;         // a new map: a new file
static char s_logMap[64] = "";
static float s_logTime = 0;

void H9RallyLog_Frame(const struct usercmd_s* cmd, float frametime)
{
	if (s_cvLog == nullptr || s_cvLog->value == 0.0f)
	{
		s_logFile.Close();
		s_logReopen = true;
		return;
	}
	if (cmd == nullptr)
		return;
	const float now = gEngfuncs.GetClientTime();
	// the level's name: "maps/rc_dunevalley.bsp"
	const char* lv = gEngfuncs.pfnGetLevelName ? gEngfuncs.pfnGetLevelName() : "";
	char map[64];
	{
		const char* b = lv ? lv : "";
		const char* sl = strrchr(b, '/');
		if (sl)
			b = sl + 1;
		snprintf(map, sizeof map, "%s", b);
		char* dot = strrchr(map, '.');
		if (dot)
			*dot = 0;
	}
	if (s_logReopen || !s_logFile.IsOpen() || strcmp(map, s_logMap) != 0 || now + 1.0f < s_logTime)
	{
		if (!s_logFile.IsOpen() && s_logFile.capped && !s_logReopen && strcmp(map, s_logMap) == 0 && now + 1.0f >= s_logTime)
			return; // this map's file is full
		snprintf(s_logMap, sizeof s_logMap, "%s", map);
		s_logReopen = false;
		s_logFile.Open(gEngfuncs.pfnGetGameDirectory(), "cl", map, H9RALLYLOG_CL_HEADER);
	}
	s_logTime = now;
	if (!s_logFile.IsOpen())
		return;

	H9RallyClientRec& r = s_logRec;
	r.time = now;
	r.frametime = frametime;
	r.keyFwd = (cmd->buttons & IN_FORWARD) != 0;
	r.keyBack = (cmd->buttons & IN_BACK) != 0;
	r.keyLeft = (cmd->buttons & (IN_LEFT | IN_MOVELEFT)) != 0;
	r.keyRight = (cmd->buttons & (IN_RIGHT | IN_MOVERIGHT)) != 0;
	r.keyJump = (cmd->buttons & IN_JUMP) != 0;
	r.keyLeftFrac = s_lastKeys.left;
	r.keyRightFrac = s_lastKeys.right;
	r.fwdSent = cmd->forwardmove;
	r.side = cmd->sidemove;
	r.up = cmd->upmove;
	r.buttons = cmd->buttons;
	r.yawSent = cmd->viewangles[1];
	r.tractionLoss = s_steer.tractionLoss;
	r.steerDelta = s_steer.delta;
	r.wheel = s_steer.wheel;
	r.rpmAfter = s_steer.box.rpm;
	r.gearAfter = s_steer.box.gear;
	float tp = 0, ty = 0, tr = 0;
	r.tiltValid = H9RallyStoredTilt(&tp, &ty, &tr) ? 1 : 0;
	r.tiltP = tp;
	r.tiltY = ty;
	r.tiltR = tr;
	r.noteFresh = s_note.have && s_note.time == s_viewTime ? 1 : 0;
	char line[900];
	H9RallyLogFormatCl(line, sizeof line, r);
	s_logFile.Line(line);
}

void H9RallyCam_Init()
{
	s_cvLog = CVAR_CREATE("cl_h9_rally_log", "0", FCVAR_ARCHIVE); // 0 (the default): no log; 1 (the command `cl_h9_rally_log 1`): the input model's frames to rallylog/cl_<map>_<date-time>.txt
	s_cvView = CVAR_CREATE("cl_h9_rallyview", "4", 0); // 0 chase, 2 bonnet, 3 side, 4 interior; a new map sets it to 4 (HL Rally: chase)
	s_cvBack = CVAR_CREATE("cl_h9_rallycam_dist", "40", FCVAR_ARCHIVE); // HL Rally's cam_wishdist
	s_cvPivot = CVAR_CREATE("cl_h9_rallycam_pivot", "10", FCVAR_ARCHIVE); // the chase camera's pivot above the car's origin (26 - 16 in HL Rally)
	s_cvPitch = CVAR_CREATE("cl_h9_rallycam_pitch", "15", FCVAR_ARCHIVE); // degrees down, on top of the velocity's slope
	s_cvFov = CVAR_CREATE("cl_h9_rallycam_fov", "90", FCVAR_ARCHIVE);     // in a car; 0 leaves the player's own
	s_cvMouse = CVAR_CREATE("cl_h9_rally_mouse", "1.0", FCVAR_ARCHIVE);   // scales the mouse's steering
	s_cvRear = CVAR_CREATE("cl_h9_rally_rearview", "1", FCVAR_ARCHIVE);   // HL Rally's rally_rearview: the mirror, in the interior view
	s_cvChrome = CVAR_CREATE("cl_h9_rally_chrome", "1", FCVAR_ARCHIVE);   // HL Rally's rally_chrome: the windscreen's overlay in the interior view
	s_cvManual = CVAR_CREATE("cl_h9_rally_manual", "0", FCVAR_ARCHIVE);   // HL Rally's rally_manual: the gearbox is the driver's (h9_gearup, h9_geardown)
	gEngfuncs.pfnAddCommand("h9_gearup", Cmd_GearUp);
	gEngfuncs.pfnAddCommand("h9_geardown", Cmd_GearDown);
	gEngfuncs.pfnAddCommand("h9_rallycam", Cmd_View);
	gEngfuncs.pfnAddCommand("h9_rallycam_zoom", Cmd_Zoom);
	gEngfuncs.pfnAddCommand("+h9_camdistance", Cmd_ZoomStart);
	gEngfuncs.pfnAddCommand("-h9_camdistance", Cmd_ZoomEnd);
}

void H9RallyCam_VidInit()
{
	s_model = nullptr;
	s_interior = nullptr;
	s_chrome = nullptr;
	s_hiddenViewModel = nullptr;
	s_nextModelTry = 0;
	s_nextInteriorTry = 0;
	s_nextChromeTry = 0;
	memset(s_slot, 0, sizeof(s_slot));
	for (int i = 0; i < MAX_SLOTS; i++)
	{
		s_slot[i].tilt = rallycam::Tilt();
		s_slot[i].noise = rallycam::NoiseHold();
	}
	s_chase = rallycam::ChaseState();
	s_first = rallycam::FirstState();
	s_int = rallycam::InteriorState();
	s_viewTime = -1.0f;
	s_rallyTime = -1.0f;
	s_note.have = false;
	s_dyn.have = false;
	s_logReopen = true; // a new map: a new log file
	s_steer = rallysteer::State();
	s_mouseActive = false;
	s_mirrorPending = false;
	// HL Rally puts the view back to its default on every map (in_camera.cpp:256-263); ours is the interior
	if (s_cvView != nullptr)
		gEngfuncs.Cvar_SetValue("cl_h9_rallyview", (float)rallycam::VIEW_INTERIOR);
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

bool H9RallyCar_ModeOn()
{
	return LocalRallyClass() > 0;
}

bool H9RallyCam_LocalIsCar()
{
	return LocalRallyClass() > 0 && g_iAlive && 0 == g_iUser1 && 0 == gEngfuncs.IsSpectateOnly();
}

bool H9RallyCam_ZoomHeld()
{
	return s_zoomHeld && H9RallyCam_ChaseActive();
}

void H9RallyCam_ZoomMouse(int dy)
{
	const float now = CvF(s_cvBack, 40.0f);
	const float next = rallycam::ChaseZoomMouse(now, dy);
	if (next != now)
		gEngfuncs.Cvar_SetValue("cl_h9_rallycam_dist", next);
}

bool H9RallyCam_ChaseActive()
{
	return H9RallyCam_LocalIsCar() && rallycam::ViewShowsCar(ViewInForce());
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
	Update(ent->index, org, yaw, gEngfuncs.GetClientTime(), vel, isLocal ? DynPtr() : nullptr, isLocal, ent->prevstate.angles);
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
	const Dyn* dyn = isLocal ? DynPtr() : nullptr;
	Slot& s = Update(ent->index, org, yaw, gEngfuncs.GetClientTime(), vel, dyn, isLocal, ent->prevstate.angles);
	out.model = m;
	out.origin[0] = org.x;
	out.origin[1] = org.y;
	out.origin[2] = org.z;
	out.angles[0] = s.tilt.pitch;
	out.angles[1] = yaw;
	out.angles[2] = s.tilt.roll;
	out.skin = st->skin & 255;
	out.steerByte = dyn != nullptr ? CarSteerByte(dyn->wheel) : 127; // another car's wheels are straight
	out.phase = s.phase;
	out.hasShock = isLocal && s.hasShock;
	for (int i = 0; i < 4; i++)
		out.shock[i] = s.shock[i];
	return true;
}

bool H9RallyCam_Apply(ref_params_s* pp, cl_entity_t* view)
{
	using namespace rallycam;
	// A spectator in a rally race (HL Rally, in_camera.cpp:276-290 and 645-656: g_iUser1 forces the TV camera, on the player g_iUser2 follows;
	// the eye, aim and FOV are the TV camera's own). Only a car is followed: the player's own view setting is not touched. A spectator with
	// nobody to follow (roaming) keeps TS's own view; HL Rally would aim at entity 0 there.
	if (pp != nullptr && !H9RallyCam_LocalIsCar() && g_iUser1 != 0 && g_iUser2 > 0)
	{
		cl_entity_t* target = gEngfuncs.GetEntityByIndex(g_iUser2);
		if (target != nullptr && H9RallyCar_IsCarEntity(target))
		{
			s_chase.init = false;
			s_first.init = false;
			s_int.init = false;
			s_mirrorPending = false;
			TvLoad();
			const V3 at(target->origin[0], target->origin[1], target->origin[2]); // pl->origin (in_camera.cpp:651)
			const V3 eye = TvPickCamera(s_tvCams, s_tvCount, at);
			const Pose pose = TvAim(eye, at);
			s_tvFov = TvFov((at - eye).Length());
			s_specTvTime = gEngfuncs.GetClientTime();
			pp->vieworg[0] = pose.org.x;
			pp->vieworg[1] = pose.org.y;
			pp->vieworg[2] = pose.org.z;
			pp->viewangles[0] = pose.pitch;
			pp->viewangles[1] = pose.yaw;
			pp->viewangles[2] = 0.0f;
			AngleVectors(pp->viewangles, pp->forward, pp->right, pp->up);
			return true;
		}
	}
	if (pp == nullptr || !H9RallyCam_LocalIsCar())
	{
		s_chase.init = false;
		s_first.init = false;
		s_int.init = false;
		s_mirrorPending = false;
		if (view != nullptr && s_hiddenViewModel != nullptr && (view->model == nullptr || view->model == s_interior))
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
	const Slot& slot = Update(local->index, car, heading, now, vel, DynPtr(), true, local->prevstate.angles);

	const int viewNow = ViewInForce();
	s_viewNow = viewNow;
	Pose pose;
	bool interior = false;
	InteriorOut io;
	if (viewNow == VIEW_INTERIOR)
	{
		interior = true;
		s_chase.init = false;
		s_first.init = false;
		// HL Rally's interior (StudioModelRenderer.cpp:1524-1743): the ground's tilt with the noise of the surface (its own, a little less on a road)
		// and the body's motion (no test for a slide in the squat), filtered (new + 9 old) / 10; the wheel, the speedo and the tacho on bone controllers
		const float spd = vel.Length();
		const Dyn* dyn = DynPtr();
		if (NoiseDue(s_int.noise, dt > 0.0f ? dt : 0.0f))
		{
			s_int.noise.a = Unit();
			s_int.noise.b = Unit();
			s_int.noise.c = Unit();
		}
		float tp = slot.rawValid ? slot.rawPitch : s_int.pitchHist, tr = slot.rawValid ? slot.rawRoll : s_int.rollHist;
		const float mul = slot.mulInterior > 0.0f ? slot.mulInterior : 0.006f;
		if (slot.rawValid)
		{
			tp += RoughAngle(spd, mul, s_int.noise.a);
			tr += RoughAngle(spd, mul, s_int.noise.b);
			BodyMotion(spd, RightShare(heading, vel), dyn != nullptr && dyn->braking, dyn != nullptr && dyn->throttle, tp, tr, false);
		}
		io = InteriorStep(s_int, 0 != pp->onground, tp, tr, dyn != nullptr ? dyn->wheel : 0.0f, WheelRough(spd, mul, s_int.noise.c), spd, s_steer.box.rpm, dt);
		pose.org = V3(car.x, car.y, car.z + kInteriorEyeUp);
		pose.yaw = heading;
		pose.pitch = io.camPitch;
		pose.roll = io.camRoll;
	}
	else if (viewNow == VIEW_TV)
	{
		// HL Rally's TV camera: the nearest info_camera is the eye, which looks at the car's origin (in_camera.cpp:880-906, 658-669), with the
		// FOV from the distance (:682-713)
		s_int.init = false;
		s_first.init = false;
		s_chase.init = false;
		TvLoad();
		const V3 eye = TvPickCamera(s_tvCams, s_tvCount, car);
		pose = TvAim(eye, car);
		s_tvFov = TvFov((car - eye).Length());
	}
	else if (viewNow == VIEW_BONNET || viewNow == VIEW_SIDE)
	{
		s_int.init = false;
		pose = FirstStep(s_first, car, heading, slot.tilt, dt, viewNow == VIEW_BONNET ? FirstParams::Bonnet() : FirstParams::Side());
		s_chase.init = false;
	}
	else
	{
		s_int.init = false;
		ChaseParams cp;
		cp.back = Clamp(CvF(s_cvBack, 40.0f), rallycam::kZoomMouseMin, rallycam::kZoomMouseMax);
		cp.up = Clamp(CvF(s_cvPivot, 10.0f), 0.0f, 200.0f);
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

	// for the log: the tilt shown (the camera's, and the body's: the interior model's, else the car's own filtered tilt)
	s_logRec.camPitch = pose.pitch;
	s_logRec.camRoll = pose.roll;
	s_logRec.modelPitch = interior ? io.modelPitch : slot.tilt.pitch;
	s_logRec.modelRoll = interior ? io.modelRoll : slot.tilt.roll;
	s_logRec.viewMode = viewNow;
	for (int i = 0; i < 3; i++)
	{
		s_logRec.org[i] = pp->simorg[i];
		s_logRec.vel[i] = pp->simvel[i];
	}

	// the weapon's slot: the interior in the interior view, nothing else (TS's weapon code has no say in a car)
	if (view != nullptr)
	{
		if (view->model != nullptr && view->model != s_interior)
			s_hiddenViewModel = view->model;
		if (interior)
		{
			view->model = s_interior;
			view->origin[0] = car.x;
			view->origin[1] = car.y;
			view->origin[2] = car.z + kInteriorModelUp;
			view->angles[0] = io.modelPitch;
			view->angles[1] = heading;
			view->angles[2] = io.modelRoll;
			view->curstate.sequence = 0;
			view->curstate.body = 0;
			view->curstate.skin = 0;
			view->curstate.frame = 0;
			view->curstate.rendermode = kRenderNormal;
			view->curstate.renderamt = 255;
			view->curstate.renderfx = kRenderFxNone;
			const int c[3] = {io.wheel, io.speedo, io.tacho};
			for (int i = 0; i < 4; i++)
			{
				const byte b = i < 3 ? (byte)c[i] : (byte)127;
				view->curstate.controller[i] = b;
				view->latched.prevcontroller[i] = b; // no easing between frames: HL Rally sets both (:1728-1730)
			}
		}
		else
			view->model = nullptr;
	}

	// the race effects need the local car noted even where the engine does not offer it to HUD_AddEntity (the interior)
	if (m != nullptr && H9RallyCar_IsCarEntity(local))
		H9RaceFx_NoteEntity(local, CAR_MODEL, m);
	return true;
}

// ---- the rear-view mirror: HL Rally's second view pass (view.cpp:1257-1330) -------------------------------------------------------

void H9RallyCam_MirrorBegin(ref_params_s* pp)
{
	s_mirrorPending = false;
	if (pp == nullptr || !H9RallyCam_LocalIsCar() || s_viewTime != gEngfuncs.GetClientTime() || s_viewNow != rallycam::VIEW_INTERIOR || !Cv(s_cvRear))
		return;
	pp->nextView = 1; // the engine calls the refdef again, for a second picture
	s_mirrorPending = true;
}

bool H9RallyCam_MirrorPass(ref_params_s* pp)
{
	if (pp == nullptr || !s_mirrorPending || pp->nextView != 1)
		return false;
	s_mirrorPending = false;
	const rallycam::MirrorView mv = rallycam::MirrorOf(ScreenWidth, ScreenHeight, pp->viewangles[0], pp->viewangles[2]);
	pp->viewport[0] = mv.x;
	pp->viewport[1] = mv.y;
	pp->viewport[2] = mv.w;
	pp->viewport[3] = mv.h;
	pp->viewangles[0] = mv.pitch;
	pp->viewangles[2] = mv.roll;
	pp->nextView = 0;
	return true;
}

// The studio renderer draws the interior view model: its overlay, when there is one (HL Rally's models/interior_chrome.mdl, StudioModelRenderer.cpp:
// 2585-2627, drawn after the model, added to it, on the same bones).
model_s* H9RallyCam_InteriorChrome(const model_s* drawn)
{
	if (drawn == nullptr || drawn != s_interior || !Cv(s_cvChrome))
		return nullptr;
	return ChromeModel();
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
	in.throttle = k.accelerating;
	in.brake = k.braking;
	in.handbrake = k.handbrake;
	in.revving = k.accelerating || k.reversing == 2; // renderCalculateRPMs:318-331: the accelerator, or the accelerator held while reversing
	in.manual = Cv(s_cvManual);
	in.countdown = Held();
	{
		float tp, ty, tr;
		in.haveTilt = H9RallyStoredTilt(&tp, &ty, &tr); // the last command's tilt, as HL Rally reads vuser1 (input.cpp:1056)
		in.tiltPitch = tp;
		in.tiltRoll = tr;
	}
	const bool fresh = FreshNote();
	in.onGround = !fresh || s_note.onGround;
	if (fresh)
	{
		in.velX = s_note.vel.x;
		in.velY = s_note.vel.y;
		in.velZ = s_note.vel.z;
	}
	if (!in.onGround)
		in.mouseYaw = 0.0f;
	s_logRec.steerKeyYaw = in.keyYaw;
	s_logRec.steerMouseYaw = in.mouseYaw;
	s_logRec.heading0 = s_steerBegin;
	const Output out = Step(s_steer, in);
	s_steerWritten = out.heading;
	s_mouseActive = false;
	s_dyn.have = true;
	s_dyn.time = gEngfuncs.GetClientTime();
	s_dyn.braking = k.braking || k.handbrake;
	s_dyn.gbraking = k.braking;
	s_dyn.throttle = k.accelerating;
	s_dyn.reversing = k.reversing;
	s_dyn.back = k.brake;
	s_dyn.handbrake = k.handbrake;
	s_dyn.traction = s_steer.tractionLoss;
	s_dyn.wheel = s_steer.wheel;
	s_lastKeys = k;
	return out.heading;
}

// ---- the throttle -------------------------------------------------------------------------------------------------------------------

bool H9RallyDrive_Finished()
{
	const char* k = gEngfuncs.PhysInfo_ValueForKey("rfin");
	return k != nullptr && atoi(k) != 0;
}

H9RallyDriveResult H9RallyDrive_Move(const H9RallyDriveKeys& k)
{
	rallysteer::DriveIn in;
	in.manual = Cv(s_cvManual);
	in.klook = k.klook;
	in.gear = s_steer.box.gear;
	in.rpm = s_steer.box.rpm;
	const bool fresh = FreshNote();
	in.onGround = !fresh || s_note.onGround;
	in.speedH = fresh ? sqrtf(s_note.vel.x * s_note.vel.x + s_note.vel.y * s_note.vel.y) : 0.0f;
	in.backFrac = k.backFrac;
	in.backDown = k.backDown;
	in.fwdFrac = k.fwdFrac;
	in.fwdDown = k.fwdDown;
	in.reversing = s_steer.reversing;
	const rallysteer::DriveOut o = rallysteer::DriveStep(in);
	s_steer.reversing = o.reversing;
	// for the log: what the throttle saw and decided
	s_logRec.rpm = in.rpm;
	s_logRec.gear = in.gear;
	s_logRec.speedH = in.speedH;
	s_logRec.onGround = in.onGround ? 1 : 0;
	s_logRec.reversing = o.reversing;
	s_logRec.accelerating = o.accelerating ? 1 : 0;
	s_logRec.braking = o.braking ? 1 : 0;
	H9RallyDriveResult r;
	r.forwardmove = rallysteer::CmdForwardMove(o.forwardmove);
	r.accelerating = o.accelerating;
	r.braking = o.braking;
	r.reversing = o.reversing;
	return r;
}

void H9RallyDrive_Frozen(float frametime)
{
	const bool fresh = FreshNote();
	rallysteer::FrozenStep(s_steer, fresh ? s_note.vel.x : 0.0f, fresh ? s_note.vel.y : 0.0f, !fresh || s_note.onGround, frametime, Cv(s_cvManual), Held());
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
	if (s_specTvTime >= 0.0f && gEngfuncs.GetClientTime() - s_specTvTime < 0.25f && gEngfuncs.GetClientTime() >= s_specTvTime && s_tvFov > 0.0f)
		return s_tvFov; // a spectator's TV camera, the same lens
	if (H9RallyCam_LocalIsCar() && s_viewNow == rallycam::VIEW_TV && s_tvFov > 0.0f)
		return s_tvFov; // HL Rally's TV camera sets its own FOV (in_camera.cpp:693-713)
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
	o.manual = Cv(s_cvManual);
	o.reversing = s_steer.reversing;
	o.throttle = s_lastKeys.throttle;
	o.brake = s_lastKeys.brake;
	o.handbrake = s_lastKeys.handbrake;
	return true;
}
