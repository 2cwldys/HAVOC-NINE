// H9: the race's visual effects, client side. Every car the engine adds this frame (a model under models/h9/rc_, noted from
// HUD_AddEntity) gets, from one pass in HUD_DrawTransparentTriangles:
//   1. tyre marks laid on the ground behind its wheels, kept in one ring for all the cars;
//   2. spray puffs behind the rear wheels (dust, snow powder, splash, tyre smoke);
//   3. a blob shadow, fading with the height;
//   4. brake lights while it brakes;
// and, when cl_h9_raceweather says so, falling snow or rain around the camera (no car needed).
// What the server sends is in the two blending bytes of the car's entity (dlls/h9_car.cpp, "for every client"); the speed is not
// sent and is taken from the origin between frames. The arithmetic is in h9_racefx_calc.h; this file asks the engine and draws.
// The idea of what to show (skid marks, dust) comes from what HL Rally did; no code or asset of it is used.
#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "entity_state.h"
#include "cl_entity.h"
#include "triangleapi.h"
#include "com_model.h"
#include "event_api.h"
#include "pm_defs.h"
#include "pmtrace.h"

#include "h9_racefx.h"
#include "h9_racefx_calc.h"
#include "h9_rallyfx.h" // rally cars have HL Rally's own effects (h9_rallyfx.cpp) instead of the ones below
#include "h9_rallycar.h" // H9RallyCar_IsCarEntity, H9RallyCam_LocalIsCar

#include <string.h>
#include <math.h>

extern Vector v_origin, v_angles; // view.cpp: the view origin and angles of this frame

using namespace racefx;

namespace
{

// ---- the budgets: every array is fixed, nothing is allocated in a frame ---------------------------------------------------------

const int MAX_CARS = 16;       // cars tracked at once
const int MAX_SEGS = 1500;     // tyre mark segments, all cars together
const int MAX_PUFFS = 300;     // live spray puffs, all cars together
const int MAX_FLAKES = 400;    // weather quads
const int FLAKE_TRACES = 20;   // one trace up per 20 flakes: the ceiling test's cost a frame
const float MARK_LIFE = 25.0f; // seconds
const float MARK_FADE = 8.0f;  // the last seconds of it, in which a mark goes
const float MARK_LIFT = 0.5f;  // above the ground, along its normal
const float MARK_DRAWDIST = 3000.0f;
const float PUFF_DRAWDIST = 3000.0f;

const char* const CAR_PREFIX = "models/h9/rc_";

// ---- cvars ----------------------------------------------------------------------------------------------------------------------

struct cvar_s* s_cvDebug = nullptr;
float s_debugNext = 0;
struct cvar_s *s_cvMaster, *s_cvMarks, *s_cvSpray, *s_cvShadow, *s_cvLights, *s_cvWeather;

bool Cv(struct cvar_s* cv)
{
	return cv != nullptr && On(cv->value);
}

// ---- the sprites (all of the game's own, in ts/sprites) -------------------------------------------------------------------------

enum SprId
{
	SPR_OMBRA, // the player's shadow blob (indexalpha, black): the shadow and the dark marks
	SPR_GLOW,  // a soft white glow (additive): pale scratches, brake lights, rain streaks
	SPR_DUST,  // dust (additive, 4 frames)
	SPR_SNOWY, // snow powder and flakes (additive, 3 frames)
	SPR_SMOKE, // black_smoke1 (additive, 7 frames): tyre smoke
	SPR_N
};

struct Spr
{
	const char* path;
	int handle;
	model_t* model;
	float nextTry; // a failed load is tried again after a while, not every frame
};

Spr s_spr[SPR_N] = {
	{"sprites/ombra.spr", 0, nullptr, 0},
	{"sprites/h9_glow.spr", 0, nullptr, 0},
	{"sprites/dust.spr", 0, nullptr, 0},
	{"sprites/snowy.spr", 0, nullptr, 0},
	{"sprites/black_smoke1.spr", 0, nullptr, 0},
};

float s_now = 0; // the client time of this frame

int SprFrames(int id)
{
	return (s_spr[id].model != nullptr && s_spr[id].model->numframes > 1) ? s_spr[id].model->numframes : 1;
}

// Loads (once) and binds a sprite's frame for the TriAPI; false when it cannot (the effect is then left out).
bool BindSpr(int id, int frame)
{
	Spr& s = s_spr[id];
	if (s.handle == 0)
	{
		if (s_now < s.nextTry)
			return false;
		s.handle = SPR_Load(s.path);
		if (s.handle == 0)
		{
			s.nextTry = s_now + 5.0f;
			return false;
		}
	}
	if (s.model == nullptr)
		s.model = (model_t*)gEngfuncs.GetSpritePointer((HSPRITE)s.handle);
	if (s.model == nullptr)
		return false;
	if (frame < 0 || frame >= SprFrames(id))
		frame = 0;
	return 0 != gEngfuncs.pTriAPI->SpriteTexture(s.model, frame);
}

// ---- the ground, by the engine's trace ------------------------------------------------------------------------------------------

// A trace straight down from `from` (+ up), at most `down` below it. A car (or a player) is a physent too and a trace that starts
// inside its box ends on it, so a hit on an entity with a studio model is not the ground: the trace goes on from under it.
struct EngineGround : Ground
{
	float up, down, step;
	EngineGround() : up(8), down(64), step(8) {}
	bool Down(const V3& from, V3& hit, V3& normal) override
	{
		Vector s(from.x, from.y, from.z + up);
		const Vector e(from.x, from.y, from.z - down);
		for (int tries = 0; tries < 5; tries++)
		{
			pmtrace_t* tr = gEngfuncs.PM_TraceLine((float*)&s, (float*)&e, PM_TRACELINE_PHYSENTSONLY, 2, -1);
			if (tr == nullptr || tr->fraction >= 1.0f || tr->allsolid)
				return false;
			if (tr->ent > 0)
			{
				physent_t* pe = gEngfuncs.pEventAPI->EV_GetPhysent(tr->ent);
				if (pe != nullptr && pe->studiomodel != nullptr)
				{
					s = Vector(s.x, s.y, tr->endpos[2] - step);
					if (s.z <= e.z)
						return false;
					continue;
				}
			}
			if (tr->startsolid && tr->fraction <= 0.0f)
				return false; // inside the world: there is no ground to speak of
			if (tr->plane.normal[2] < 0.35f)
				return false; // a wall, not the ground
			hit = V3(tr->endpos[0], tr->endpos[1], tr->endpos[2]);
			normal = V3(tr->plane.normal[0], tr->plane.normal[1], tr->plane.normal[2]);
			return true;
		}
		return false;
	}
};

// ---- the cars of this frame, noted by HUD_AddEntity -----------------------------------------------------------------------------

struct Pending
{
	int index;
	V3 origin;
	float yaw;
	int b0, b1;
	Dims dims;
	bool rally;       // a rally car (h9_rallycar.h): HL Rally's effects, not these
	bool local;       // ... and the player's own
	float vel[3];     // ... and its velocity (HL Rally's: the entity's history for another car)
};

Pending s_pend[MAX_CARS];
int s_nPend = 0;
bool s_rallySeen = false; // a rally car has been noted since the map began: the weather and the like of the race effects are not for it

// What is kept from frame to frame for each car.
struct CarSlot
{
	bool used;
	int index;
	float lastSeen;
	float lastTime;
	V3 lastOrigin;
	bool haveLast;
	float speedLen, accelLen; // car lengths a second, and per second
	WheelTrail trail[4];
	float emit[2];
	int puffs;
};

CarSlot s_slot[MAX_CARS];

CarSlot* FindSlot(int index)
{
	CarSlot* freeSlot = nullptr;
	for (int i = 0; i < MAX_CARS; i++)
	{
		if (s_slot[i].used && s_slot[i].index == index)
			return &s_slot[i];
		if (!s_slot[i].used && freeSlot == nullptr)
			freeSlot = &s_slot[i];
	}
	if (freeSlot != nullptr)
	{
		memset(freeSlot, 0, sizeof(*freeSlot));
		for (int w = 0; w < 4; w++)
			freeSlot->trail[w] = WheelTrail();
		freeSlot->used = true;
		freeSlot->index = index;
		freeSlot->lastSeen = s_now;
	}
	return freeSlot;
}

// ---- the things kept: marks, puffs, flakes -------------------------------------------------------------------------------------

Ring<Seg, MAX_SEGS> s_marks;

struct Puff
{
	bool live;
	unsigned char spr;  // SprId
	unsigned char slot; // the car it came from
	unsigned char r, g, b;
	V3 pos, vel;
	float born, life, size0, size1, alpha;
};

Puff s_puffs[MAX_PUFFS];
int s_puffNext = 0; // the ring's next, when it is full the oldest goes

struct Flake
{
	float x, y, z;
	float phase;
	bool known;   // its ceiling test has been done
	bool covered; // a ceiling close above it: it is not drawn
};

Flake s_flakes[MAX_FLAKES];
bool s_flakesInit = false;
int s_flakeCursor = 0;

struct ShadowDraw
{
	bool on;
	V3 c[4];
	float alpha;
};

ShadowDraw s_shadow[MAX_CARS];

float s_lastNow = -1.0f;

void ClearAll()
{
	s_nPend = 0;
	memset(s_slot, 0, sizeof(s_slot));
	s_marks.Clear();
	memset(s_puffs, 0, sizeof(s_puffs));
	s_puffNext = 0;
	s_flakesInit = false;
	s_flakeCursor = 0;
	memset(s_shadow, 0, sizeof(s_shadow));
	s_lastNow = -1.0f;
}

float Rnd(float lo, float hi)
{
	return gEngfuncs.pfnRandomFloat(lo, hi);
}

// ---- the view's axes -------------------------------------------------------------------------------------------------------------

V3 s_vFwd, s_vRight, s_vUp, s_eye;

void ViewAxes()
{
	Vector f, r, u;
	AngleVectors(v_angles, f, r, u);
	s_vFwd = V3(f.x, f.y, f.z);
	s_vRight = V3(r.x, r.y, r.z);
	s_vUp = V3(u.x, u.y, u.z);
	s_eye = V3(v_origin.x, v_origin.y, v_origin.z);
}

void Vtx(const V3& p, float s, float t)
{
	gEngfuncs.pTriAPI->TexCoord2f(s, t);
	gEngfuncs.pTriAPI->Vertex3f(p.x, p.y, p.z);
}

// A quad facing the view, half size `size`, inside a Begin(TRI_QUADS).
void BillboardQuad(const V3& pos, float size)
{
	const V3 up = s_vUp * size, right = s_vRight * size;
	Vtx(pos + up - right, 0, 0);
	Vtx(pos + up + right, 1, 0);
	Vtx(pos - up + right, 1, 1);
	Vtx(pos - up - right, 0, 1);
}

float Dist2(const V3& a, const V3& b)
{
	const V3 d = a - b;
	return d.Dot(d);
}

// ---- per car, per frame --------------------------------------------------------------------------------------------------------

// The speed from the origin between frames (interpolated by the engine, with the client's time). A first sight, a pause (no time
// has passed) or a jump (a teleport, a respawn at the grid) gives no new speed.
void UpdateSpeed(CarSlot& c, const Pending& p, float dt)
{
	if (!c.haveLast)
	{
		c.haveLast = true;
		c.lastOrigin = p.origin;
		c.lastTime = s_now;
		c.speedLen = c.accelLen = 0;
		return;
	}
	if (!(dt > 0.0001f))
		return; // paused: keep what it was
	const float len = p.dims.len;
	const float jump2 = Dist2(p.origin, c.lastOrigin);
	if (dt > 0.5f || jump2 > 64.0f * len * len)
	{
		for (int w = 0; w < 4; w++)
			c.trail[w].Break();
		c.speedLen = c.accelLen = 0;
	}
	else
	{
		const float raw = SpeedFrom(c.lastOrigin, p.origin, dt) / len;
		const float sm = 0.5f * raw + 0.5f * c.speedLen; // a little smoothing: the origin is a step a snapshot
		float acc = (sm - c.speedLen) / dt;
		acc = acc < -20.0f ? -20.0f : (acc > 20.0f ? 20.0f : acc);
		c.accelLen = 0.5f * acc + 0.5f * c.accelLen;
		c.speedLen = sm;
	}
	c.lastOrigin = p.origin;
	c.lastTime = s_now;
}

void LayMarks(CarSlot& c, const Pending& p, EngineGround& g)
{
	const MarkLook look = MarkFor(SurfaceOf(p.b1), SlipOf(p.b0), p.b1, c.speedLen, c.accelLen);
	const float spacing = 0.25f * p.dims.len;
	const float halfWidth = 0.5f * 1.3f * p.dims.tyreW * look.widthScale; // the sprite's soft edge: a quad a little wider than the tyre
	for (int w = 0; w < 4; w++)
	{
		const bool wanted = look.kind != MK_NONE && (look.allWheels || w == W_RL || w == W_RR);
		if (!wanted)
		{
			c.trail[w].Break();
			continue;
		}
		const V3 wp = LocalToWorld(p.origin, p.yaw, WheelLocal(p.dims, w));
		Seg seg;
		if (PlaceSegment(c.trail[w], wp, g, spacing, halfWidth, MARK_LIFT, s_now, MARK_LIFE, look, seg))
			s_marks.Push() = seg;
	}
}

void NewPuff(const SprayLook& sp, const V3& wheel, const V3& fwd, float speed, float len, int slot)
{
	Puff& q = s_puffs[s_puffNext];
	s_puffNext = (s_puffNext + 1) % MAX_PUFFS;
	q.live = true;
	q.spr = sp.kind == SP_DUST ? SPR_DUST : (sp.kind == SP_SMOKE ? SPR_SMOKE : SPR_SNOWY);
	q.slot = (unsigned char)slot;
	q.r = sp.r;
	q.g = sp.g;
	q.b = sp.b;
	const float j = 0.04f * len;
	q.pos = wheel + V3(Rnd(-j, j), Rnd(-j, j), Rnd(0.0f, j));
	const float side = 0.12f * len;
	q.vel = fwd * (-speed * sp.back) + V3(Rnd(-side, side), Rnd(-side, side), sp.up * len * Rnd(0.7f, 1.3f));
	q.born = s_now;
	q.life = sp.life * Rnd(0.8f, 1.2f);
	q.size0 = sp.size0 * len;
	q.size1 = sp.size1 * len;
	q.alpha = sp.alpha;
}

void Spray(CarSlot& c, const Pending& p, int slotIdx, int carsInView, bool haveGround, const V3& gHit, const V3& gN, float dt)
{
	const SprayLook sp = SprayFor(SurfaceOf(p.b1), SlipOf(p.b0), p.b1, c.speedLen);
	if (sp.kind == SP_NONE || !haveGround || !(dt > 0))
	{
		c.emit[0] = c.emit[1] = 0;
		return;
	}
	const int budget = PerCarBudget(MAX_PUFFS, carsInView);
	const float a = p.yaw * 3.14159265358979f / 180.0f;
	const V3 fwd(cosf(a), sinf(a), 0);
	const float speed = c.speedLen * p.dims.len;
	for (int i = 0; i < 2; i++)
	{
		V3 wp = LocalToWorld(p.origin, p.yaw, WheelLocal(p.dims, i == 0 ? W_RL : W_RR));
		wp.z = PlaneZ(gHit, gN, wp.x, wp.y) + 1.0f;
		int n = EmitCount(c.emit[i], sp.rate, dt, 6);
		for (; n > 0 && c.puffs < budget; n--)
		{
			NewPuff(sp, wp, fwd, speed, p.dims.len, slotIdx);
			c.puffs++;
		}
	}
}

void PlaceShadow(int k, const Pending& p, bool haveGround, const V3& gHit, const V3& gN)
{
	ShadowDraw& sd = s_shadow[k];
	sd.on = false;
	if (!haveGround)
		return;
	const float h = p.origin.z - PlaneZ(gHit, gN, p.origin.x, p.origin.y);
	const float alpha = ShadowAlpha(h, p.dims.len);
	if (alpha < 0.02f)
		return;
	const float a = p.yaw * 3.14159265358979f / 180.0f;
	V3 f(cosf(a), sinf(a), 0);
	f = f - gN * f.Dot(gN); // along the car, in the ground's plane
	const float fl = f.Length();
	if (!(fl > 1e-3f))
		return;
	f = f * (1.0f / fl);
	const V3 side = gN.Cross(f);
	// the bounds' middle is not the origin's: the origin is between the axles
	const float midX = 0.5f * (p.dims.mins.x + p.dims.maxs.x), midY = 0.5f * (p.dims.mins.y + p.dims.maxs.y);
	// the hit is on the plane right under the origin (the trace goes straight down from its x and y)
	const V3 c0 = gHit + f * midX + side * midY + gN * 1.0f; // side = the car's left
	const float hl = ShadowHalfLen(p.dims), hw = ShadowHalfWidth(p.dims);
	sd.c[0] = c0 + f * hl + side * hw;
	sd.c[1] = c0 + f * hl - side * hw;
	sd.c[2] = c0 - f * hl - side * hw;
	sd.c[3] = c0 - f * hl + side * hw;
	sd.alpha = alpha;
	sd.on = true;
}

// ---- the passes ------------------------------------------------------------------------------------------------------------------

void DrawDark(int nShadows)
{
	triangleapi_t* tri = gEngfuncs.pTriAPI;
	if (nShadows <= 0 && (s_marks.count == 0 || !Cv(s_cvMarks)))
		return; // nothing to draw: no car, no mark
	if (!BindSpr(SPR_OMBRA, 0))
		return;
	tri->RenderMode(kRenderTransTexture); // alpha-blended, not additive: a dark mark
	tri->CullFace(TRI_NONE);
	tri->Begin(TRI_QUADS);
	for (int i = 0; i < nShadows; i++)
	{
		const ShadowDraw& sd = s_shadow[i];
		if (!sd.on)
			continue;
		tri->Color4f(1.0f, 1.0f, 1.0f, sd.alpha);
		Vtx(sd.c[0], 0, 0);
		Vtx(sd.c[1], 1, 0);
		Vtx(sd.c[2], 1, 1);
		Vtx(sd.c[3], 0, 1);
	}
	if (Cv(s_cvMarks))
	{
		for (int i = 0; i < s_marks.count; i++)
		{
			const Seg& sg = s_marks.At(i);
			if (sg.pale)
				continue;
			const float a = sg.alpha * FadeFactor(s_now - sg.born, sg.life, MARK_FADE);
			if (a < 0.01f)
				continue;
			const V3 mid = (sg.c[0] + sg.c[2]) * 0.5f;
			const float d2 = Dist2(mid, s_eye);
			if (d2 > MARK_DRAWDIST * MARK_DRAWDIST)
				continue;
			// a little more lift the further away it is: the depth buffer has less to tell the mark from the ground
			const V3 lift = sg.n * (0.0006f * sqrtf(d2));
			tri->Color4f(sg.r / 255.0f, sg.g / 255.0f, sg.b / 255.0f, a);
			// u runs across the tyre, v is the sprite's middle row all along it: a ribbon with soft sides, no beads
			Vtx(sg.c[0] + lift, 0, 0.5f);
			Vtx(sg.c[1] + lift, 0, 0.5f);
			Vtx(sg.c[2] + lift, 1, 0.5f);
			Vtx(sg.c[3] + lift, 1, 0.5f);
		}
	}
	tri->End();
	tri->RenderMode(kRenderNormal);
}

// The pale marks and the brake lights: one additive sprite.
void DrawGlows(int nCars)
{
	triangleapi_t* tri = gEngfuncs.pTriAPI;
	const bool marks = Cv(s_cvMarks), lights = Cv(s_cvLights);
	if ((!marks || s_marks.count == 0) && (!lights || nCars == 0))
		return;
	if (!BindSpr(SPR_GLOW, 0))
		return;
	tri->RenderMode(kRenderTransAdd);
	tri->CullFace(TRI_NONE);
	tri->Begin(TRI_QUADS);
	if (marks)
	{
		for (int i = 0; i < s_marks.count; i++)
		{
			const Seg& sg = s_marks.At(i);
			if (!sg.pale)
				continue;
			const float a = sg.alpha * FadeFactor(s_now - sg.born, sg.life, MARK_FADE);
			if (a < 0.01f)
				continue;
			const V3 mid = (sg.c[0] + sg.c[2]) * 0.5f;
			const float d2 = Dist2(mid, s_eye);
			if (d2 > MARK_DRAWDIST * MARK_DRAWDIST)
				continue;
			const V3 lift = sg.n * (0.0006f * sqrtf(d2));
			tri->Color4f(sg.r / 255.0f * a, sg.g / 255.0f * a, sg.b / 255.0f * a, 1.0f);
			Vtx(sg.c[0] + lift, 0, 0.5f);
			Vtx(sg.c[1] + lift, 0, 0.5f);
			Vtx(sg.c[2] + lift, 1, 0.5f);
			Vtx(sg.c[3] + lift, 1, 0.5f);
		}
	}
	if (lights)
	{
		for (int i = 0; i < nCars; i++)
		{
			const Pending& p = s_pend[i];
			if (p.rally || !BrakeLightsOn(p.b1))
				continue;
			const float size = 0.05f * p.dims.len;
			for (int side = 0; side < 2; side++)
			{
				const V3 pos = LocalToWorld(p.origin, p.yaw, BrakeLightLocal(p.dims, side));
				tri->Color4f(1.0f, 0.12f, 0.08f, 1.0f);
				BillboardQuad(pos, size);
			}
		}
	}
	tri->End();
	tri->RenderMode(kRenderNormal);
}

void UpdatePuffs(float dt)
{
	for (int i = 0; i < MAX_CARS; i++)
		s_slot[i].puffs = 0;
	for (int i = 0; i < MAX_PUFFS; i++)
	{
		Puff& q = s_puffs[i];
		if (!q.live)
			continue;
		if (s_now - q.born >= q.life || s_now < q.born)
		{
			q.live = false;
			continue;
		}
		if (dt > 0)
		{
			q.pos = q.pos + q.vel * dt;
			const float drag = 1.0f - 1.8f * dt;
			q.vel = q.vel * (drag < 0 ? 0 : drag);
		}
		if (q.slot < MAX_CARS)
			s_slot[q.slot].puffs++;
	}
}

void DrawPuffs()
{
	triangleapi_t* tri = gEngfuncs.pTriAPI;
	tri->RenderMode(kRenderTransAdd);
	tri->CullFace(TRI_NONE);
	for (int i = 0; i < MAX_PUFFS; i++)
	{
		const Puff& q = s_puffs[i];
		if (!q.live)
			continue;
		if (Dist2(q.pos, s_eye) > PUFF_DRAWDIST * PUFF_DRAWDIST)
			continue;
		const float t = (s_now - q.born) / q.life;
		const float fade = (t < 0.12f ? t / 0.12f : 1.0f) * (1.0f - t) * q.alpha;
		if (fade < 0.01f)
			continue;
		const int nf = SprFrames(q.spr);
		int frame = (int)(t * (float)nf);
		frame = frame >= nf ? nf - 1 : frame;
		if (!BindSpr(q.spr, frame))
			continue;
		const float size = q.size0 + (q.size1 - q.size0) * t;
		tri->Begin(TRI_QUADS);
		tri->Color4f(q.r / 255.0f * fade, q.g / 255.0f * fade, q.b / 255.0f * fade, 1.0f);
		BillboardQuad(q.pos, size);
		tri->End();
	}
	tri->RenderMode(kRenderNormal);
}

// ---- weather ---------------------------------------------------------------------------------------------------------------------

const float BOX_HALF = 350.0f;  // the box of flakes round the camera: half its side
const float BOX_BELOW = 120.0f; // and how far it goes under and over the camera
const float BOX_ABOVE = 300.0f;

void ResetFlake(Flake& f)
{
	f.x = s_eye.x + Rnd(-BOX_HALF, BOX_HALF);
	f.y = s_eye.y + Rnd(-BOX_HALF, BOX_HALF);
	f.z = s_eye.z + Rnd(-BOX_BELOW, BOX_ABOVE);
	f.phase = Rnd(0.0f, 6.2831853f);
	f.known = false;
	f.covered = false;
}

void Weather(int mode, float dt)
{
	if (!s_flakesInit)
	{
		for (int i = 0; i < MAX_FLAKES; i++)
			ResetFlake(s_flakes[i]);
		s_flakesInit = true;
	}
	const float fall = mode == 2 ? 650.0f : 70.0f;
	const float span = BOX_ABOVE + BOX_BELOW;
	for (int i = 0; i < MAX_FLAKES; i++)
	{
		Flake& f = s_flakes[i];
		if (dt > 0)
		{
			f.z -= fall * dt;
			if (mode == 1)
			{
				f.phase += dt * 1.3f;
				f.x += sinf(f.phase) * 12.0f * dt;
				f.y += cosf(f.phase * 0.8f) * 12.0f * dt;
			}
		}
		bool moved = false;
		// the box follows the camera: a flake that leaves it comes in on the other side
		while (f.z < s_eye.z - BOX_BELOW)
			f.z += span;
		while (f.z > s_eye.z + BOX_ABOVE)
			f.z -= span;
		while (f.x < s_eye.x - BOX_HALF) { f.x += 2.0f * BOX_HALF; moved = true; }
		while (f.x > s_eye.x + BOX_HALF) { f.x -= 2.0f * BOX_HALF; moved = true; }
		while (f.y < s_eye.y - BOX_HALF) { f.y += 2.0f * BOX_HALF; moved = true; }
		while (f.y > s_eye.y + BOX_HALF) { f.y -= 2.0f * BOX_HALF; moved = true; }
		if (moved)
			f.known = false; // another column: its ceiling is to be tested again
	}
	// the ceiling test: a trace up from a flake's column, 20 flakes a frame, in turn; a ceiling within the box's height above the
	// camera covers the column and its flakes are not drawn (a tunnel, a garage, a roof)
	for (int k = 0; k < FLAKE_TRACES; k++)
	{
		Flake& f = s_flakes[s_flakeCursor];
		s_flakeCursor = (s_flakeCursor + 1) % MAX_FLAKES;
		Vector from(f.x, f.y, s_eye.z - 0.5f * BOX_BELOW);
		const Vector to(f.x, f.y, s_eye.z + BOX_ABOVE);
		pmtrace_t* tr = gEngfuncs.PM_TraceLine((float*)&from, (float*)&to, PM_TRACELINE_PHYSENTSONLY, 2, -1);
		f.covered = tr != nullptr && (tr->fraction < 1.0f || tr->startsolid || tr->allsolid);
		f.known = true;
	}
}

void DrawWeather(int mode)
{
	triangleapi_t* tri = gEngfuncs.pTriAPI;
	if (!BindSpr(mode == 2 ? SPR_GLOW : SPR_SNOWY, 0))
		return;
	tri->RenderMode(kRenderTransAdd);
	tri->CullFace(TRI_NONE);
	tri->Begin(TRI_QUADS);
	for (int i = 0; i < MAX_FLAKES; i++)
	{
		const Flake& f = s_flakes[i];
		if (!f.known || f.covered)
			continue;
		const V3 pos(f.x, f.y, f.z);
		if (mode == 2)
		{
			// a streak: upright, turned to the eye about the vertical
			const float dx = s_eye.x - f.x, dy = s_eye.y - f.y;
			const float dl = sqrtf(dx * dx + dy * dy);
			if (!(dl > 1.0f))
				continue;
			const V3 side(-dy / dl * 0.4f, dx / dl * 0.4f, 0);
			const V3 top = pos + V3(0, 0, 11.0f), bot = pos - V3(0, 0, 11.0f);
			tri->Color4f(0.45f, 0.5f, 0.6f, 1.0f);
			Vtx(top - side, 0, 0);
			Vtx(top + side, 1, 0);
			Vtx(bot + side, 1, 1);
			Vtx(bot - side, 0, 1);
		}
		else
		{
			tri->Color4f(0.9f, 0.92f, 1.0f, 1.0f);
			BillboardQuad(pos, 1.3f);
		}
	}
	tri->End();
	tri->RenderMode(kRenderNormal);
}

} // namespace

// ---- the public part -------------------------------------------------------------------------------------------------------------

void H9RaceFx_Init()
{
	s_cvMaster = CVAR_CREATE("cl_h9_racefx", "1", FCVAR_ARCHIVE);
	s_cvDebug = CVAR_CREATE("cl_h9_racefx_debug", "0", 0);
	s_cvMarks = CVAR_CREATE("cl_h9_racefx_marks", "1", FCVAR_ARCHIVE);
	s_cvSpray = CVAR_CREATE("cl_h9_racefx_spray", "1", FCVAR_ARCHIVE);
	s_cvShadow = CVAR_CREATE("cl_h9_racefx_shadow", "1", FCVAR_ARCHIVE);
	s_cvLights = CVAR_CREATE("cl_h9_racefx_lights", "1", FCVAR_ARCHIVE);
	s_cvWeather = CVAR_CREATE("cl_h9_raceweather", "0", 0); // 0 none, 1 snow, 2 rain; a map's config sets it, it is not kept
	ClearAll();
	H9RallyFx_Init(); // HL Rally's effects for rally cars: its cvars and the headlights' message
}

void H9RaceFx_VidInit()
{
	ClearAll();
	s_rallySeen = false;
	H9RallyFx_VidInit();
	for (int i = 0; i < SPR_N; i++)
	{
		s_spr[i].handle = 0; // handles change with every map load
		s_spr[i].model = nullptr;
		s_spr[i].nextTry = 0;
	}
}

void H9RaceFx_NoteEntity(struct cl_entity_s* ent, const char* modelname, const struct model_s* model)
{
	if (ent == nullptr || modelname == nullptr || !Cv(s_cvMaster))
		return;
	if (0 != strncmp(modelname, CAR_PREFIX, strlen(CAR_PREFIX)))
		return;
	if (ent->index <= 0)
		return;
	// not the driver's camera: it wears the car's model, drawn fully transparent, behind and above the car (h9_car.cpp)
	if (ent->curstate.rendermode != kRenderNormal && ent->curstate.renderamt == 0)
		return;
	for (int i = 0; i < s_nPend; i++)
		if (s_pend[i].index == ent->index)
			return; // once a frame
	if (s_nPend >= MAX_CARS)
		return;
	// the size, from the model's own bounds; the entity's box when the model has none (yet)
	V3 mins, maxs;
	bool fromModel = false;
	const model_t* sizeModel = model != nullptr ? model : ent->model;
	if (sizeModel != nullptr)
	{
		mins = V3(sizeModel->mins.x, sizeModel->mins.y, sizeModel->mins.z);
		maxs = V3(sizeModel->maxs.x, sizeModel->maxs.y, sizeModel->maxs.z);
		fromModel = DimsFromBounds(mins, maxs).ok;
	}
	if (!fromModel)
	{
		mins = V3(ent->curstate.mins.x, ent->curstate.mins.y, ent->curstate.mins.z);
		maxs = V3(ent->curstate.maxs.x, ent->curstate.maxs.y, ent->curstate.maxs.z);
	}
	Pending& p = s_pend[s_nPend];
	p.dims = DimsFromBounds(mins, maxs);
	if (!p.dims.ok)
		return; // no size, no car
	p.index = ent->index;
	p.origin = V3(ent->origin.x, ent->origin.y, ent->origin.z);
	p.yaw = ent->angles.y;
	p.b0 = ent->curstate.blending[0];
	p.b1 = ent->curstate.blending[1];
	p.rally = ent->player != 0 && H9RallyCar_IsCarEntity(ent);
	p.local = false;
	p.vel[0] = p.vel[1] = p.vel[2] = 0.0f;
	if (p.rally)
	{
		s_rallySeen = true;
		const cl_entity_t* me = gEngfuncs.GetLocalPlayer();
		p.local = me != nullptr && me->index == ent->index;
		// another car's velocity as HL Rally takes it (Rally_Effects.cpp:524-546): the last two entries of the entity's position history, the
		// difference over their times. The local car's is replaced in H9RallyFx_Frame by the prediction's.
		const int cp = ent->current_position & HISTORY_MASK, pp = (cp + HISTORY_MAX - 1) & HISTORY_MASK;
		const float at = ent->ph[cp].animtime - ent->ph[pp].animtime;
		if (at > 0.0001f)
			for (int i = 0; i < 3; i++)
				p.vel[i] = (ent->ph[cp].origin[i] - ent->ph[pp].origin[i]) / at;
		else
		{
			p.vel[0] = ent->curstate.velocity[0];
			p.vel[1] = ent->curstate.velocity[1];
			p.vel[2] = ent->curstate.velocity[2];
		}
	}
	s_nPend++;
}

void H9RaceFx_Draw()
{
	if (!Cv(s_cvMaster))
	{
		s_nPend = 0;
		return;
	}
	s_now = gEngfuncs.GetClientTime();
	if (s_lastNow >= 0.0f && s_now < s_lastNow)
		ClearAll(); // the client's clock went back: a new map or a demo's rewind; nothing of before belongs now
	float dt = s_lastNow < 0.0f ? 0.0f : s_now - s_lastNow;
	if (dt > 0.25f)
		dt = 0.25f; // a stall must not throw the puffs across the map
	s_lastNow = s_now;
	ViewAxes();

	const int nCars = s_nPend;
	UpdatePuffs(dt);

	const bool doMarks = Cv(s_cvMarks), doSpray = Cv(s_cvSpray), doShadow = Cv(s_cvShadow);
	for (int k = 0; k < nCars; k++)
	{
		const Pending& p = s_pend[k];
		s_shadow[k].on = false;
		if (p.rally)
			continue; // HL Rally's effects (h9_rallyfx.cpp), below
		CarSlot* c = FindSlot(p.index);
		if (c == nullptr)
			continue; // more cars than slots: this one has no effects
		const int slotIdx = (int)(c - s_slot);
		const float stepDt = c->haveLast ? s_now - c->lastTime : 0.0f;
		c->lastSeen = s_now;
		UpdateSpeed(*c, p, stepDt);

		EngineGround g;
		g.up = 0.5f * p.dims.height;
		g.down = 0.6f * p.dims.len;
		g.step = 0.2f * p.dims.height;
		if (doMarks && stepDt > 0.0f)
			LayMarks(*c, p, g);

		if (doSpray || doShadow)
		{
			// one trace a car a frame, from the origin: the shadow and the spray's height share it
			EngineGround gc;
			gc.up = 0.5f * p.dims.height;
			gc.down = 1.0f * p.dims.len;
			gc.step = 0.2f * p.dims.height;
			V3 hit, nrm;
			const bool have = gc.Down(p.origin, hit, nrm);
			if (doShadow)
				PlaceShadow(k, p, have, hit, nrm);
			if (doSpray)
				Spray(*c, p, slotIdx, nCars, have, hit, nrm, stepDt);
		}
	}
	// a car not seen for a moment is let go (its marks stay and fade by themselves)
	for (int i = 0; i < MAX_CARS; i++)
		if (s_slot[i].used && s_now - s_slot[i].lastSeen > 1.5f)
			s_slot[i].used = false;

	if (s_cvDebug != nullptr && s_cvDebug->value != 0 && s_now >= s_debugNext)
	{
		// cl_h9_racefx_debug 1: once a second, what the effects see (cars this frame, marks kept, the dark sprite, a car's bytes)
		s_debugNext = s_now + 1.0f;
		const bool dark = BindSpr(SPR_OMBRA, 0);
		gEngfuncs.Con_Printf("racefx: cars %d, marks %d, puffs on %d, ombra %s (handle %d), car0 at %.0f %.0f %.0f len %.1f slip %d state %d speed %.1f lengths/s\n",
			nCars, s_marks.count, doSpray ? 1 : 0, dark ? "bound" : "NOT bound", (int)s_spr[SPR_OMBRA].handle,
			nCars > 0 ? s_pend[0].origin.x : 0.0f, nCars > 0 ? s_pend[0].origin.y : 0.0f, nCars > 0 ? s_pend[0].origin.z : 0.0f,
			nCars > 0 ? s_pend[0].dims.len : 0.0f, nCars > 0 ? s_pend[0].b0 : 0, nCars > 0 ? s_pend[0].b1 : 0,
			nCars > 0 && FindSlot(s_pend[0].index) != nullptr ? FindSlot(s_pend[0].index)->speedLen : 0.0f);
	}
	int nRace = 0; // the cars that are not rally cars: only these have the shadow, brake lights and spray of this file
	for (int k = 0; k < nCars; k++)
		if (!s_pend[k].rally)
			nRace++;
	DrawDark(doShadow && nRace > 0 ? nCars : 0);
	DrawGlows(nCars);
	if (doSpray)
		DrawPuffs();

	// the weather and the water spray are this file's own, HL Rally has none: not in rally mode (the local player is a rally car, or one was seen)
	const int weather = (int)(s_cvWeather != nullptr ? s_cvWeather->value + 0.5f : 0.0f);
	if ((weather == 1 || weather == 2) && !s_rallySeen && !H9RallyCam_LocalIsCar())
	{
		Weather(weather, dt);
		DrawWeather(weather);
	}

	// HL Rally's effects for the rally cars: the local car's skid marks, the dust and the shadow of each, the lamps, the headlights, the flame
	H9RallyFxCar rc[MAX_CARS];
	int nRally = 0;
	for (int k = 0; k < nCars; k++)
	{
		const Pending& p = s_pend[k];
		if (!p.rally)
			continue;
		H9RallyFxCar& r = rc[nRally++];
		r.index = p.index;
		r.local = p.local;
		r.origin[0] = p.origin.x;
		r.origin[1] = p.origin.y;
		r.origin[2] = p.origin.z;
		r.yaw = p.yaw;
		r.vel[0] = p.vel[0];
		r.vel[1] = p.vel[1];
		r.vel[2] = p.vel[2];
	}
	if (s_rallySeen || nRally > 0)
		H9RallyFx_Frame(rc, nRally, s_now, dt);
	s_nPend = 0;
}
