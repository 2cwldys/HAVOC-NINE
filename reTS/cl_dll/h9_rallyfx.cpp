// H9 rally mode's visual effects, client side: HL Rally's own set for a rally car (see h9_rallyfx.h). The arithmetic is h9_rallyfx_calc.h's, each rule
// there with the line of HL Rally's source it is from; this file asks the engine and draws.
//
// Where it differs from HL Rally, and why:
//  - HL Rally runs these from its studio renderer for each player drawn. Ours runs once a frame from HUD_DrawTransparentTriangles for the cars the
//    race effects were told of (h9_racefx.cpp), in HL Rally's order: the dust and the skid step, then the shadow, flame and lamps, then the marks.
//  - Its dust is a temporary entity with its own update (FTENT_DUSTSPRITE in its HUD_TempEntUpdate). Ours makes the same temporary entity with the
//    engine's CL_TentEntAllocCustom and a callback that does that update and puts the puff where HL Rally's movement would have put it.
//  - Its car axes come from the entity's angles, tilt included. Ours are flat (the yaw only): a tilt moves a corner by about a unit.
//  - Every sprite is ours, under sprites/h9/rally/.
#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "entity_state.h"
#include "cl_entity.h"
#include "triangleapi.h"
#include "com_model.h"
#include "event_api.h"
#include "r_efx.h"
#include "dlight.h"
#include "pm_defs.h"
#include "pmtrace.h"
#include "parsemsg.h"
#include "r_studioint.h"

#include "h9_rallyfx.h"
#include "h9_rallyfx_calc.h"
#include "h9_rallycar.h"
#include "h9_rallysnd.h"

#include <string.h>
#include <stdio.h>
#include <math.h>

extern engine_studio_api_t IEngineStudio;

using namespace rallyfx;

namespace
{

const char* const SPR_DIR = "sprites/h9/rally/";
const char* const CHROME_PATH = "models/h9/rc_rally_xs_chrome.mdl";
const int MAX_MARKS = 8192;
const int MAX_PUFF_TICKS = 6; // HL Rally frames' worth of puffs made in one client frame at most (a long frame must not flood the pool)

cvar_t *s_cvMarks, *s_cvSpray, *s_cvShadow, *s_cvLights, *s_cvChromeOn;
cvar_t *s_cvSkidTime, *s_cvShadowDiv;

bool Cv(cvar_t* c) { return c != nullptr && c->value >= 0.5f; }

// ---- the sprites: ours, each optional -------------------------------------------------------------------------------------------

struct Spr
{
	char path[96];
	int handle;
	model_t* model;
	float nextTry;
};
Spr s_spr[SP_N];
bool s_sprInit = false;

void InitSprNames()
{
	if (s_sprInit)
		return;
	s_sprInit = true;
	for (int i = 0; i < SP_N; i++)
	{
		snprintf(s_spr[i].path, sizeof(s_spr[i].path), "%s%s.spr", SPR_DIR, SprBase(i));
		s_spr[i].handle = 0;
		s_spr[i].model = nullptr;
		s_spr[i].nextTry = 0;
	}
}

// True when the file is on disk (the engine is never asked to load one that is not: it would say so in the console).
bool OnDisk(const char* path)
{
	int len = 0;
	char p[128];
	snprintf(p, sizeof(p), "%s", path);
	byte* data = gEngfuncs.COM_LoadFile(p, 5, &len);
	if (!data)
		return false;
	gEngfuncs.COM_FreeFile(data);
	return len > 0;
}

// The sprite's model, or null when the file is not there (looked for again every ten seconds).
model_t* Sprite(int id, float now)
{
	InitSprNames();
	if (id < 0 || id >= SP_N)
		return nullptr;
	Spr& s = s_spr[id];
	if (s.model != nullptr)
		return s.model;
	if (now < s.nextTry)
		return nullptr;
	s.nextTry = now + 10.0f;
	if (!OnDisk(s.path))
		return nullptr;
	s.handle = SPR_Load(s.path);
	if (s.handle == 0)
		return nullptr;
	s.model = (model_t*)gEngfuncs.GetSpritePointer((HSPRITE)s.handle);
	return s.model;
}

bool Bind(int id, float now)
{
	model_t* m = Sprite(id, now);
	return m != nullptr && 0 != gEngfuncs.pTriAPI->SpriteTexture(m, 0);
}

// ---- the world ------------------------------------------------------------------------------------------------------------------

V3 FromF(const float* v) { return V3(v[0], v[1], v[2]); }

// HL Rally's traces, from its origin (a unit over the floor) through the world alone, with a point hull; an end point is lifted by the hull's half
// height where it hit (kHlrHull).
struct EngWorld : SkidWorld
{
	void Trace(const V3& from, const V3& to, V3& end, V3& normal) override
	{
		float s[3] = {from.x, from.y, from.z}, e[3] = {to.x, to.y, to.z};
		pmtrace_t tr;
		gEngfuncs.pEventAPI->EV_PlayerTrace(s, e, PM_STUDIO_BOX | PM_WORLD_ONLY, -1, &tr);
		if (tr.fraction < 1.0f)
		{
			end = V3(tr.endpos[0], tr.endpos[1], tr.endpos[2] + kHlrHull);
			normal = V3(tr.plane.normal[0], tr.plane.normal[1], tr.plane.normal[2]);
		}
		else
		{
			end = to;
			normal = V3(0, 0, 0);
		}
	}
	const char* Texture(const V3& origin) override
	{
		float a[3] = {origin.x, origin.y, origin.z}, b[3] = {origin.x, origin.y, origin.z - 64.0f};
		return gEngfuncs.pEventAPI->EV_TraceTexture(0, a, b);
	}
};

// re:496-510 "OnGround Fix": a trace 5 down from the origin that hits a plane whose distance is not 0.
bool GroundNear(const V3& ho)
{
	float s[3] = {ho.x, ho.y, ho.z}, e[3] = {ho.x, ho.y, ho.z - 5.0f};
	pmtrace_t tr;
	gEngfuncs.pEventAPI->EV_PlayerTrace(s, e, PM_STUDIO_BOX | PM_WORLD_ONLY, -1, &tr);
	return tr.fraction < 1.0f && tr.plane.dist != 0.0f;
}

struct EngRng : Rng
{
	long Long(long lo, long hi) override { return (long)gEngfuncs.pfnRandomLong(lo, hi); }
	float Float(float lo, float hi) override { return gEngfuncs.pfnRandomFloat(lo, hi); }
};

// ---- what is kept ---------------------------------------------------------------------------------------------------------------

const int MAX_IDX = 40;
float s_dustAccum[MAX_IDX]; // HL Rally frames not yet made into puffs, for each car
bool s_headOn[MAX_IDX];     // the headlights each car's server says are on

// the local car
struct Local
{
	bool init;
	float prevRpm;
	SkidState skid;
	KeyLamp keys;
	LampState lamp;
	HeadState head;
	Local() : init(false), prevRpm(0) {}
};
Local s_local;
SkidList<MAX_MARKS> s_marks;

int s_exhaustIdx = 0;
float s_exhaustPos[3];
float s_exhaustAt = -10.0f;

struct ChromeCache
{
	model_t* model;
	float nextTry;
};
ChromeCache s_chrome = {nullptr, 0.0f};

void ClearAll()
{
	memset(s_dustAccum, 0, sizeof(s_dustAccum));
	memset(s_headOn, 0, sizeof(s_headOn));
	s_local = Local();
	s_marks.Clear();
	s_exhaustAt = -10.0f;
	s_chrome.model = nullptr;
	s_chrome.nextTry = 0.0f;
}

// ---- the dust: a temporary entity with HL Rally's own update -----------------------------------------------------------------------------

// en:660-695 for FTENT_DUSTSPRITE, called by the stock update after it has moved the puff with the velocity it had left over from the last frame;
// HL Rally scales that velocity first, so the move is made again with the new one.
void DustCallback(TEMPENTITY* te, float frametime, float currenttime)
{
	DustEnt e;
	e.baseScale = te->entity.baseline.scale;
	e.life0 = te->entity.baseline.fuser1;
	e.vel0 = FromF(te->entity.baseline.vuser1);
	e.vel = FromF(te->entity.baseline.origin);
	e.baseAmt = te->entity.baseline.renderamt;
	e.amt = te->entity.curstate.renderamt;
	e.scale = te->entity.curstate.scale;
	const V3 was = e.vel;
	DustUpdate(e, te->die - currenttime);
	te->entity.baseline.scale = e.baseScale;
	te->entity.baseline.fuser1 = e.life0;
	te->entity.baseline.vuser1[0] = e.vel0.x;
	te->entity.baseline.vuser1[1] = e.vel0.y;
	te->entity.baseline.vuser1[2] = e.vel0.z;
	te->entity.baseline.origin[0] = e.vel.x;
	te->entity.baseline.origin[1] = e.vel.y;
	te->entity.baseline.origin[2] = e.vel.z;
	te->entity.curstate.renderamt = e.amt;
	te->entity.curstate.scale = e.scale;
	if (frametime > 0.0f)
	{
		te->entity.origin[0] += (e.vel.x - was.x) * frametime;
		te->entity.origin[1] += (e.vel.y - was.y) * frametime;
		te->entity.origin[2] += (e.vel.z - was.z) * frametime;
	}
}

void SpawnPuff(const DustPuff& p, float now)
{
	model_t* m = Sprite(p.spr, now);
	if (m == nullptr)
		return;
	float org[3] = {p.pos.x, p.pos.y, p.pos.z};
	TEMPENTITY* te = gEngfuncs.pEfxAPI->CL_TentEntAllocCustom(org, m, 0, DustCallback);
	if (te == nullptr)
		return;
	te->flags |= FTENT_SPRCYCLE | FTENT_CLIENTCUSTOM;
	te->die = now + p.life;
	te->entity.curstate.scale = p.scale;
	te->entity.curstate.rendermode = kRenderTransAlpha;
	te->entity.curstate.renderfx = kRenderFxNone;
	const int amt = (int)(p.alpha * 255.0f);
	te->entity.curstate.renderamt = amt;
	te->entity.baseline.renderamt = amt;
	te->entity.baseline.origin[0] = p.vel.x;
	te->entity.baseline.origin[1] = p.vel.y;
	te->entity.baseline.origin[2] = p.vel.z;
	te->entity.baseline.scale = 0.0f; // not started: the first update takes the scale, the life and the velocity
	te->entity.curstate.frame = 0.0f;
}

// ---- drawing -------------------------------------------------------------------------------------------------------------------------

void Vtx(const V3& p, float s, float t)
{
	gEngfuncs.pTriAPI->TexCoord2f(s, t);
	gEngfuncs.pTriAPI->Vertex3f(p.x, p.y, p.z);
}

void QuadEnd()
{
	gEngfuncs.pTriAPI->End();
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_FRONT); // HL Rally puts the culling back after each of its draws
}

void DrawShadow(float yaw, const V3& ho, bool onGround, float now)
{
	if (!Cv(s_cvShadow))
		return;
	int div = s_cvShadowDiv != nullptr ? (int)s_cvShadowDiv->value : 4;
	if (div < 1)
		return;
	if (!Bind(SP_SHADOW, now))
		return;
	EngWorld w;
	const V3 f = Fwd(yaw), r = Right(yaw);
	float height = 0.0f;
	if (!onGround)
	{
		// re:870-880: a trace 96 down from 3 over the origin: the shadow shrinks by the height over the ground
		V3 end, nrm;
		w.Trace(ho + V3(0, 0, kTraceHeight), ho + V3(0, 0, kTraceHeight - 96.0f), end, nrm);
		height = (ho - end).Length();
	}
	const ShadowCorners sc = ShadowRect(ho, f, r, onGround, height);
	static ShadowVert v[kShadowMaxVerts];
	const int n = ShadowGrid(sc, f, r, div, w, v, kShadowMaxVerts);
	if (n < 4)
		return;
	gEngfuncs.pTriAPI->SpriteTexture(s_spr[SP_SHADOW].model, 0);
	gEngfuncs.pTriAPI->RenderMode(kRenderTransTexture);
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->Brightness(1);
	gEngfuncs.pTriAPI->Color4f(1.0f, 1.0f, 1.0f, 1.0f); // HL Rally sets none: whatever the last draw left
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	for (int i = 0; i < n; i++)
		Vtx(v[i].p, v[i].u, v[i].v);
	QuadEnd();
}

void DrawFlame(const V3& origin, const V3& right, const V3& up, float fade, float now)
{
	if (!Bind(SP_FLASH, now))
		return;
	V3 q[12];
	FlameQuads(origin, right, up, fade, q);
	gEngfuncs.pTriAPI->RenderMode(kRenderTransAdd);
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	gEngfuncs.pTriAPI->Color4f(fade, fade, fade, 1.0f);
	gEngfuncs.pTriAPI->Brightness(1);
	static const float uv[4][2] = {{0, 0}, {0, 1}, {1, 1}, {1, 0}};
	for (int i = 0; i < 12; i++)
		Vtx(q[i], uv[i % 4][0], uv[i % 4][1]);
	QuadEnd();
}

void DrawLamps(int index, const V3& ho, float yaw, const LampState& ls, float now)
{
	if (!Bind(SP_FLARE, now))
		return;
	const Lamps g = LampGeometry(ho, Fwd(yaw), Right(yaw), Up(), LampXsara(), ls.wasBraking);
	const LampColour c = LampColourFor(ls.wasBraking, ls.brightness);
	// the sprite is additive: HL Rally gives the brightness as the alpha, which the additive mode may not use; the colour times it is the same
	gEngfuncs.pTriAPI->RenderMode(kRenderTransAdd);
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	gEngfuncs.pTriAPI->Brightness(1);
	gEngfuncs.pTriAPI->Color4f(c.r * ls.brightness, c.g * ls.brightness, c.b * ls.brightness, 1.0f);
	static const float uv[4][2] = {{0, 0}, {0, 1}, {1, 1}, {1, 0}};
	for (int l = 0; l < 2; l++)
		for (int i = 0; i < 4; i++)
			Vtx(g.q[l].v[i], uv[i][0], uv[i][1]);
	QuadEnd();
	// the two lights HL Rally makes at the quads' last vertices (re:1389-1392, 1442-1447): radius 2, die in a tenth of a second
	for (int l = 0; l < 2; l++)
	{
		dlight_t* dl = gEngfuncs.pEfxAPI->CL_AllocElight(index * 2 + l);
		if (dl == nullptr)
			continue;
		dl->origin[0] = g.elight[l].x;
		dl->origin[1] = g.elight[l].y;
		dl->origin[2] = g.elight[l].z;
		dl->radius = kElightRadius;
		dl->color.r = c.lr;
		dl->color.g = c.lg;
		dl->color.b = c.lb;
		dl->die = now + 0.1f;
	}
}

void DrawMarks(float now)
{
	if (s_marks.count == 0)
		return;
	gEngfuncs.pTriAPI->RenderMode(kRenderTransTexture);
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->Brightness(1);
	static const float uv[4][2] = {{0, 0}, {0, 1}, {1, 1}, {1, 0}};
	for (int tex = 0; tex < 4; tex++)
	{
		bool any = false;
		for (int i = 0; i < s_marks.count && !any; i++)
			any = s_marks.At(i).tex == tex;
		if (!any || !Bind(SkidSpr(tex), now))
			continue;
		gEngfuncs.pTriAPI->Color4f(1.0f, 1.0f, 1.0f, 1.0f); // HL Rally sets none
		gEngfuncs.pTriAPI->Begin(TRI_QUADS);
		for (int i = 0; i < s_marks.count; i++)
		{
			const auto& it = s_marks.At(i);
			if (it.tex != tex)
				continue;
			for (int j = 0; j < 4; j++)
				Vtx(V3(it.v[j].x, it.v[j].y, it.v[j].z + kSkidLift), uv[j][0], uv[j][1]);
		}
		gEngfuncs.pTriAPI->End();
	}
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_FRONT);
}

// ---- the headlights' message -------------------------------------------------------------------------------------------------------------

// byte entity index, byte on (HL Rally's Flashlight message, rallyhud.cpp:232-258)
int MsgLight(const char* pszName, int iSize, void* pbuf)
{
	BEGIN_READ(pbuf, iSize);
	const int idx = READ_BYTE();
	const int on = READ_BYTE();
	H9RallyFx_SetHeadlight(idx, on != 0);
	return 1;
}

cvar_t* Find(cvar_t*& cache, const char* name)
{
	if (cache == nullptr)
		cache = gEngfuncs.pfnGetCvarPointer(name);
	return cache;
}

} // namespace

// ---- the public part -----------------------------------------------------------------------------------------------------------------

void H9RallyFx_Init()
{
	InitSprNames();
	s_cvSkidTime = CVAR_CREATE("cl_h9_rallyfx_skidtime", "45", FCVAR_ARCHIVE); // HL Rally's rally_skidmarktime, as its config and manual have it
	s_cvShadowDiv = CVAR_CREATE("cl_h9_rallyfx_shadowdiv", "4", FCVAR_ARCHIVE); // HL Rally's rally_shadows: the shadow's subdivisions
	gEngfuncs.pfnHookUserMsg("H9RLight", MsgLight);
	ClearAll();
}

void H9RallyFx_VidInit()
{
	InitSprNames();
	for (int i = 0; i < SP_N; i++)
	{
		s_spr[i].handle = 0; // handles change with every map load
		s_spr[i].model = nullptr;
		s_spr[i].nextTry = 0;
	}
	ClearAll();
}

void H9RallyFx_SetHeadlight(int index, bool on)
{
	if (index > 0 && index < MAX_IDX)
		s_headOn[index] = on;
}

void H9RallyFx_NoteExhaust(int index, const float attachment0[3])
{
	s_exhaustIdx = index;
	s_exhaustPos[0] = attachment0[0];
	s_exhaustPos[1] = attachment0[1];
	s_exhaustPos[2] = attachment0[2];
	s_exhaustAt = gEngfuncs.GetClientTime();
}

model_s* H9RallyFx_CarChrome()
{
	Find(s_cvChromeOn, "cl_h9_rally_chrome"); // the cvar h9_rallycar.cpp makes: HL Rally's rally_chrome, 1
	if (!Cv(s_cvChromeOn))
		return nullptr;
	if (s_chrome.model != nullptr)
		return s_chrome.model;
	const float now = gEngfuncs.GetClientTime();
	if (now < s_chrome.nextTry)
		return nullptr;
	s_chrome.nextTry = now + 10.0f;
	if (!OnDisk(CHROME_PATH) || IEngineStudio.Mod_ForName == nullptr)
		return nullptr;
	model_t* m = IEngineStudio.Mod_ForName(CHROME_PATH, 0);
	if (m != nullptr && IEngineStudio.Mod_Extradata(m) != nullptr)
		s_chrome.model = m;
	return s_chrome.model;
}

void H9RallyFx_Frame(const H9RallyFxCar* cars, int n, float now, float dt)
{
	Find(s_cvMarks, "cl_h9_racefx_marks");
	Find(s_cvSpray, "cl_h9_racefx_spray");
	Find(s_cvShadow, "cl_h9_racefx_shadow");
	Find(s_cvLights, "cl_h9_racefx_lights");
	cl_entity_t* localEnt = gEngfuncs.GetLocalPlayer();

	H9RallyDriveNote note;
	const bool haveNote = H9RallyCar_DriveNote(note);
	const H9RallyFxCar* localCar = nullptr;
	for (int i = 0; i < n; i++)
		if (cars[i].local)
			localCar = &cars[i];
	const bool localOn = localCar != nullptr && haveNote;
	if (!localOn)
		s_local = Local(); // no car of his own: the lamps and the lights go out, the marks' first step starts again (HL Rally: a new car)
	const bool anything = n > 0 || s_marks.count > 0;
	if (!anything)
		return;

	// the traces below all go through the world with a point hull
	gEngfuncs.pEventAPI->EV_SetUpPlayerPrediction(0, 1);
	gEngfuncs.pEventAPI->EV_PushPMStates();
	gEngfuncs.pEventAPI->EV_SetTraceHull(2);

	EngWorld world;
	EngRng rng;
	const bool dustOn = Cv(s_cvSpray), marksOn = Cv(s_cvMarks), lightsOn = Cv(s_cvLights);

	// ---- per car: the dust and (local) the revs, the keys and the skid step ------------------------------------------------------
	bool onGround[64];
	V3 vel[64];
	if (n > 64)
		n = 64;
	for (int i = 0; i < n; i++)
	{
		const H9RallyFxCar& c = cars[i];
		const V3 ho(c.origin[0], c.origin[1], c.origin[2] + kHlrHull);
		vel[i] = FromF(c.vel);
		const bool isLocal = localOn && &c == localCar;
		if (isLocal)
		{
			if (note.valid)
				vel[i] = FromF(note.vel);
			onGround[i] = note.onGround;
		}
		else
			onGround[i] = GroundNear(ho);
		const float v2D = sqrtf(vel[i].x * vel[i].x + vel[i].y * vel[i].y);
		const float yaw = isLocal ? note.heading : c.yaw;
		const V3 f = Fwd(yaw), r = Right(yaw), u = Up();

		// the revs' flag, as the sounds read it (the revs of this frame against the last frame's)
		int accelerating = 0;
		if (isLocal)
		{
			if (!s_local.init)
			{
				s_local.init = true;
				s_local.prevRpm = note.rpm;
			}
			accelerating = rallysnd::Accelerating(s_local.prevRpm, note.rpm);
			s_local.prevRpm = note.rpm;
			KeyLampStep(s_local.keys, note.brake, note.throttle, note.onGround, v2D);
		}

		// the dust and the tyre smoke (re:661-822), before the skid step: it reads the last frame's bIsSkidding
		if (dustOn && c.index > 0 && c.index < MAX_IDX)
		{
			if (v2D > 30.0f && onGround[i])
			{
				float& acc = s_dustAccum[c.index];
				acc += Ticks(dt);
				int ticks = (int)acc;
				acc -= (float)ticks;
				if (ticks > MAX_PUFF_TICKS)
					ticks = MAX_PUFF_TICKS;
				if (ticks > 0)
				{
					const char* tex = world.Texture(ho);
					for (; ticks > 0; ticks--)
					{
						const DustSel sel = DustSelect(tex, isLocal && s_local.skid.skidding, isLocal ? note.tractionLoss : 0.0f, rng);
						DustPuff p[4];
						const int np = DustPuffs(sel, isLocal, false, v2D, onGround[i], ho, f, r, u, vel[i], rng, p);
						for (int k = 0; k < np; k++)
							SpawnPuff(p[k], now);
					}
				}
			}
			else
				s_dustAccum[c.index] = 0.0f;
		}

		if (isLocal && marksOn)
		{
			SkidInput in = {};
			in.origin = ho;
			in.yaw = yaw;
			in.vel = vel[i];
			in.onGround = note.onGround;
			in.gear = note.gear;
			in.accelerating = accelerating;
			// g_reversing and g_braking, the same as the sounds' (h9_rallysnd.cpp): on the ground at under 40 with the back key and not the forward one
			in.reversing = s_local.keys.reversing;
			in.braking = s_local.keys.braking;
			in.handbraking = note.handbrake;
			in.tractionLoss = note.tractionLoss > 0.0f;
			SkidQuad q[4];
			const int made = SkidStep(s_local.skid, in, world, q);
			const float life = s_cvSkidTime != nullptr ? s_cvSkidTime->value : kSkidLife;
			for (int k = 0; k < made; k++)
				s_marks.Push(q[k], now, life);
		}
	}

	// ---- drawn: the shadows, the flame, the lamps, the headlights, then the marks (re:482-496, 299-337) ---------------------------
	for (int i = 0; i < n; i++)
	{
		const H9RallyFxCar& c = cars[i];
		const bool isLocal = localOn && &c == localCar;
		const float yaw = isLocal ? note.heading : c.yaw;
		const V3 ho(c.origin[0], c.origin[1], c.origin[2] + kHlrHull);
		DrawShadow(yaw, ho, onGround[i], now);
		if (!isLocal)
			continue;
		// the exhaust flame, for the 0.15 s the sounds' backfire window lasts: only where the car's model gave an exhaust this frame
		const float fade = H9RallySnd_BackfireFade();
		if (fade > 0.0f && s_exhaustIdx == c.index && now - s_exhaustAt < 0.1f)
			DrawFlame(FlameOrigin(FromF(s_exhaustPos), vel[i], dt), Right(yaw), Up(), fade, now);
		// the brake and reverse lamps
		if (lightsOn && LampStep(s_local.lamp, s_local.keys.braking, s_local.keys.reversing, dt))
			DrawLamps(c.index, ho, yaw, s_local.lamp, now);
		// the headlights
		s_local.head.on = c.index > 0 && c.index < MAX_IDX && s_headOn[c.index];
		if (lightsOn && HeadStep(s_local.head, dt))
		{
			dlight_t* dl = gEngfuncs.pEfxAPI->CL_AllocDlight(c.index);
			if (dl != nullptr)
			{
				const V3 o = HeadOrigin(ho, Fwd(yaw), Right(yaw), Up());
				unsigned char col[3];
				HeadColour(s_local.head.brightness, col);
				dl->origin[0] = o.x;
				dl->origin[1] = o.y;
				dl->origin[2] = o.z;
				dl->radius = kHeadRadius;
				dl->color.r = col[0];
				dl->color.g = col[1];
				dl->color.b = col[2];
				dl->die = now + 0.1f;
			}
		}
	}
	if (localEnt != nullptr)
		s_marks.Purge(now, FromF(localEnt->origin));
	DrawMarks(now);

	gEngfuncs.pEventAPI->EV_PopPMStates();
}
