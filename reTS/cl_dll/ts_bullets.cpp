/***
*  ts_bullets.cpp — the client bullet simulation, client.dll's manager object at 0x100eb678.
*
*  256 rounds of 0x5c bytes, then a count (+0x5c00). Recovered:
*    queue          FUN_10035c20 (from the fire core FUN_100450c0's realbullet branch, 0x10045a8b)
*    per frame      FUN_10034e60 -> FUN_10035b50 (last in HUD_DrawTransparentTriangles, 0x10056e59)
*    step           FUN_10035d40 (trace, impact, pierce), free FUN_10035d10
*    draw           FUN_10035010 (slow motion only), view cull FUN_100570b0, trail FUN_10046240
*    reset          FUN_10034eb0 -> FUN_10034f60 (the FX root's first frame, 0x10056de3)
*
*  The object also holds 32 cl_entity_t (+0x5c08) for drawing rounds as models: FUN_10035010 fills
*  one instead of drawing the sprite when the byte at +0x1d34d is set, and FUN_10034fa0 (from
*  HUD_CreateEntities through FUN_10034e80) hands them to the engine. Nothing in client.dll ever
*  sets that byte (FUN_10034f90 only clears it) or the model indices at +0x1d30c..+0x1d334, so
*  rounds are always sprites and that half is not reconstructed.
***/
#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "entity_state.h"
#include "cl_entity.h"
#include "triangleapi.h"
#include "com_model.h"
#include "event_api.h"
#include "r_efx.h" // dlight_t: the plasma lights
#include "pm_defs.h"
#include "ts_weapon_info.h" // get_ammo_info, get_range_multipler (shared with the server)
#include "ts_shared.h"      // GetBulletVelocityMult, FixedSlowMul
#include "ts_particles.h"   // the pool's sprite table, the bullet trail
#include "ts_bullets.h"

#include <string.h>
#include <math.h>

extern Vector v_origin, v_angles; // view.cpp: the view origin and angles of this frame
extern float v_frametime;         // view.cpp: pparams->frametime (client.dll 0x10191478)
extern float g_flClientSlow;      // ts_powerup_hud.cpp: the slow-motion scale (client.dll 0x100963e8)
extern bool g_bBulletTime;        // ts_powerup_hud.cpp: TSBTime (client.dll 0x1018d178)
extern int g_iTSRealBullet;       // ts_status.cpp: SrvSett id 0 (client.dll 0x1018d16c)
extern float g_tsLocalFov;        // entity.cpp: the live local field of view (the plasma's width in pixels)

struct TSClientBullet
{
	int owner;       // +0x00 the shooter's entity index, 0 = free slot
	Vector pos;      // +0x04 where the simulation has the round
	Vector start;    // +0x10 where this leg began (range falloff)
	Vector dir;      // +0x1c
	Vector drawPos;  // +0x28 where it is drawn (moved per frame, only while drawn)
	Vector trailPos; // +0x34 the end of the last trail piece
	float damage;    // +0x40
	int caliber;     // +0x44 get_ammo_info index
	int unused48;    // +0x48 never written
	float nextTrail; // +0x4c
	float nextStep;  // +0x50
	int mode;        // +0x54 the shot mode (wi+0x20); 2 = a pierce leg
	int unused58;    // +0x58 cleared on queue, never read
};

#define TSB_MAX_BULLETS 256

static TSClientBullet s_bullets[TSB_MAX_BULLETS];
static int s_count; // +0x5c00: rounds seen by the last update plus those queued since

bool TSBullets_RealBullet()
{
	return g_iTSRealBullet != 0 || g_flClientSlow < 0.99f;
}

// ---------------------------------------------------------------------------------------------------------
// Plasma: what the laser rifle fires instead of a bullet (H9 addition).
//
// The laser rifle is an energy weapon. A shot of it has none of a bullet's presentation: no brass, no pellet
// sprite, no white streak, no bullet hole, no ricochet. It draws a green bolt, a bright head that runs from the
// muzzle to where the shot lands, with a trail behind it that holds a moment and then fades out, at every time
// scale (the shot is the turret's slow motion trail, in the one colour, and not only in slow motion). A round the
// bullet simulation holds (slow motion, or realbullet) is drawn the same way as it flies, and its trail is
// carried on to the place it landed. A shot also lights the place it was fired from, and the place it lands, with
// a faint green light, so that it shows in the dark.
//
// Everything here is drawn with the triangle API in the transparent pass, last in TSBullets_Update. The engine
// draws an additive triangle with GL fog off, so a map's fog does not thin a bolt. A bolt keeps a width on the
// screen: its width in units would be under a pixel a few thousand units out (and a hand across next to the
// muzzle), so each end of a ribbon, each head and each flash is widened or narrowed to a number of pixels at its
// own distance from the eye.
// ---------------------------------------------------------------------------------------------------------
#define TSPLASMA_BEAMS 320
#define TSPLASMA_FLASHES 32

static const float PLASMA_SPEED = 14000.0f; // units a second the head of an instant shot runs at
static const float PLASMA_HOLD = 0.07f;     // seconds a point of an instant shot stays at full brightness after the head passed it
static const float PLASMA_FADE = 0.26f;     // seconds it then takes to go out
static const float PLASMA_SEGMENT = 0.40f;  // seconds a trail piece of a flying round takes to go out
static const float PLASMA_LAND = 0.10f;     // seconds the head of an instant shot stays at its end, going out
static const float PLASMA_FLASH = 0.26f;    // seconds an impact flash lasts

// the colour of the plasma: green, with a little blue in it
static const float PLASMA_R = 0.16f, PLASMA_G = 1.0f, PLASMA_B = 0.50f;

struct TSPlasmaBeam
{
	bool used;
	bool run;      // an instant shot, its head still running (else a trail piece that only fades)
	Vector a, b;   // the shot's two ends
	float born;
	float len;
	float hold;    // seconds a point stays at full brightness from the head passing it (from birth, for a piece)
	float fade;    // seconds from then to that point gone
};

struct TSPlasmaFlash
{
	bool used;
	Vector pos;
	float born;
};

// one of a ribbon's two layers: `half` units out to each side, but at least `lo` and at most `hi` pixels, `gain` bright
struct TSPlasmaLayer
{
	float half, lo, hi, gain;
};
static const TSPlasmaLayer s_plasmaLayers[2] = {{3.4f, 3.0f, 9.0f, 0.55f}, {1.1f, 1.0f, 3.0f, 1.0f}};

static TSPlasmaBeam s_plasmaBeams[TSPLASMA_BEAMS];
static TSPlasmaFlash s_plasmaFlashes[TSPLASMA_FLASHES];
static bool s_plasmaMissing[4]; // trail, head, flash: a sprite that could not be loaded is not asked for again

static void TSPlasma_Reset()
{
	memset(s_plasmaBeams, 0, sizeof(s_plasmaBeams));
	memset(s_plasmaFlashes, 0, sizeof(s_plasmaFlashes));
	memset(s_plasmaMissing, 0, sizeof(s_plasmaMissing));
}

static TSPlasmaBeam* PlasmaBeamSlot()
{
	TSPlasmaBeam* oldest = &s_plasmaBeams[0];
	for (int i = 0; i < TSPLASMA_BEAMS; i++)
	{
		if (!s_plasmaBeams[i].used)
			return &s_plasmaBeams[i];
		if (s_plasmaBeams[i].born < oldest->born)
			oldest = &s_plasmaBeams[i];
	}
	return oldest;
}

// A shot of the laser rifle from `a` to where it lands, `b`: the head runs along it, the trail follows.
void TSPlasma_Bolt(const float* a, const float* b)
{
	const Vector va(a[0], a[1], a[2]), vb(b[0], b[1], b[2]);
	const float len = (vb - va).Length();
	if (len < 1.0f)
		return;
	TSPlasmaBeam* s = PlasmaBeamSlot();
	s->used = true;
	s->run = true;
	s->a = va;
	s->b = vb;
	s->born = gEngfuncs.GetClientTime();
	s->len = len;
	s->hold = PLASMA_HOLD;
	s->fade = PLASMA_FADE;
}

// One piece of the trail of a flying round, from where the last piece ended: it only fades.
static void TSPlasma_Piece(const Vector& a, const Vector& b)
{
	const float len = (b - a).Length();
	if (len < 0.5f)
		return;
	TSPlasmaBeam* s = PlasmaBeamSlot();
	s->used = true;
	s->run = false;
	s->a = a;
	s->b = b;
	s->born = gEngfuncs.GetClientTime();
	s->len = len;
	s->hold = 0.0f;
	s->fade = PLASMA_SEGMENT;
}

// A faint green light where a shot was fired from: one light for each shooter, so that a burst keeps
// renewing the same one, for a tenth of a second.
void TSPlasma_MuzzleLight(int shooter, const float* pos)
{
	dlight_t* dl = gEngfuncs.pEfxAPI->CL_AllocDlight(5000 + shooter);
	if (dl == nullptr)
		return;
	dl->origin[0] = pos[0];
	dl->origin[1] = pos[1];
	dl->origin[2] = pos[2];
	dl->radius = 165.0f;
	dl->color.r = 12;
	dl->color.g = 110;
	dl->color.b = 48;
	dl->die = gEngfuncs.GetClientTime() + 0.10f;
	dl->decay = 700.0f;
}

// Where a shot landed: a flash of green light on the surface, and a faint light there.
void TSPlasma_Impact(const float* pos)
{
	TSPlasmaFlash* s = &s_plasmaFlashes[0];
	for (int i = 0; i < TSPLASMA_FLASHES; i++)
	{
		if (!s_plasmaFlashes[i].used) { s = &s_plasmaFlashes[i]; break; }
		if (s_plasmaFlashes[i].born < s->born) s = &s_plasmaFlashes[i];
	}
	s->used = true;
	s->pos = Vector(pos[0], pos[1], pos[2]);
	s->born = gEngfuncs.GetClientTime();

	dlight_t* dl = gEngfuncs.pEfxAPI->CL_AllocDlight(0);
	if (dl != nullptr)
	{
		dl->origin[0] = pos[0];
		dl->origin[1] = pos[1];
		dl->origin[2] = pos[2];
		dl->radius = 85.0f;
		dl->color.r = 16;
		dl->color.g = 125;
		dl->color.b = 54;
		dl->die = gEngfuncs.GetClientTime() + 0.12f;
		dl->decay = 600.0f;
	}
}

// Binds one of the plasma sprites (frame 0); false when it is not there. `slot` indexes s_plasmaMissing.
static bool PlasmaBind(const char* name, int slot)
{
	if (s_plasmaMissing[slot])
		return false;
	const int idx = TSParticles_Sprite(name, kRenderTransAdd);
	if (idx < 0)
	{
		s_plasmaMissing[slot] = true;
		return false;
	}
	model_t* model = (model_t*)gEngfuncs.GetSpritePointer(TSParticles_SpriteHandle(idx));
	return model != nullptr && 0 != gEngfuncs.pTriAPI->SpriteTexture(model, 0);
}

// The world size of one screen pixel one unit from the eye, for the field of view in use.
static float PlasmaPixel()
{
	float fov = (g_tsLocalFov > 0.0f) ? g_tsLocalFov : (float)gHUD.m_iFOV;
	if (fov < 5.0f || fov > 175.0f)
		fov = 90.0f;
	const float width = (ScreenWidth > 0) ? (float)ScreenWidth : 1280.0f;
	return 2.0f * tanf(fov * (3.14159265f / 360.0f)) / width;
}

// `base` units across, but at least `lo` and at most `hi` pixels across at `p`'s distance from the eye.
static float PlasmaWidth(const Vector& p, float base, float lo, float hi, float pixel)
{
	const float one = (p - v_origin).Length() * pixel; // one pixel there, in units
	if (base < lo * one)
		return lo * one;
	if (base > hi * one)
		return hi * one;
	return base;
}

// The width direction of a ribbon along `dir` at `p`: across the line of sight, so that it always faces the view.
static Vector PlasmaSide(const Vector& dir, const Vector& p, const Vector& fallback)
{
	const Vector toEye = v_origin - p;
	Vector side(dir.y * toEye.z - dir.z * toEye.y, dir.z * toEye.x - dir.x * toEye.z, dir.x * toEye.y - dir.y * toEye.x);
	const float l = side.Length();
	if (l < 1e-3f)
		return fallback;
	return side * (1.0f / l);
}

// A ribbon from p0 to p1, `half0` / `half1` wide each side at its two ends, its brightness `i0` at p0 and `i1` at p1
// (additive: brightness is the colour, the triangle API ignoring alpha for an additive sprite).
static void PlasmaRibbon(triangleapi_t* tri, const Vector& p0, const Vector& p1, float i0, float i1, float half0,
	float half1, const Vector& fallback)
{
	Vector dir = p1 - p0;
	const float len = dir.Length();
	if (len < 0.01f)
		return;
	dir = dir * (1.0f / len);
	const Vector s0 = PlasmaSide(dir, p0, fallback) * half0;
	const Vector s1 = PlasmaSide(dir, p1, fallback) * half1;
	const Vector c[4] = {p1 - s1, p1 + s1, p0 + s0, p0 - s0};
	const float u[4] = {0, 1, 1, 0};
	const float v[4] = {0, 0, 1, 1};
	const float in[4] = {i1, i1, i0, i0};
	for (int k = 0; k < 4; k++)
	{
		tri->Color4f(PLASMA_R * in[k], PLASMA_G * in[k], PLASMA_B * in[k], 1.0f);
		tri->TexCoord2f(u[k], v[k]);
		tri->Vertex3fv((float*)&c[k]);
	}
}

// One layer of a ribbon between two points of a shot, each end at the width its own distance asks for.
static void PlasmaSpan(triangleapi_t* tri, const TSPlasmaLayer& layer, float pixel, const Vector& p0, const Vector& p1,
	float i0, float i1, const Vector& fallback)
{
	PlasmaRibbon(tri, p0, p1, i0 * layer.gain, i1 * layer.gain, PlasmaWidth(p0, layer.half, layer.lo, layer.hi, pixel),
		PlasmaWidth(p1, layer.half, layer.lo, layer.hi, pixel), fallback);
}

// How bright a point of a shot is: full until `hold` seconds after the head passed it, then going out over `fade`
// seconds. `since` is the shot's age less the time its head took to reach the point.
static float PlasmaIntensity(float since, float hold, float fade)
{
	const float v = 1.0f - (since - hold) / fade;
	return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}

// A view-facing quad of half size `size` at `pos`, brightness `i`.
static void PlasmaQuad(triangleapi_t* tri, const Vector& pos, float size, float i, const Vector& right, const Vector& up)
{
	const Vector r = right * size, u = up * size;
	const Vector c[4] = {pos + u - r, pos + u + r, pos - u + r, pos - u - r};
	static const float s_s[4] = {0, 1, 1, 0}, s_t[4] = {0, 0, 1, 1};
	for (int k = 0; k < 4; k++)
	{
		tri->Color4f(PLASMA_R * i, PLASMA_G * i, PLASMA_B * i, 1.0f);
		tri->TexCoord2f(s_s[k], s_t[k]);
		tri->Vertex3fv((float*)&c[k]);
	}
}

// A view-facing head of a bolt (also drawn for a flying round by TSB_Draw): the glow, and a smaller bright core.
static void PlasmaHead(const Vector& pos, const Vector& right, const Vector& up, float alpha)
{
	if (!PlasmaBind("sprites/laserrifle_bolt.spr", 1))
		return;
	const float pixel = PlasmaPixel();
	triangleapi_t* tri = gEngfuncs.pTriAPI;
	tri->RenderMode(kRenderTransAdd);
	tri->CullFace(TRI_NONE);
	tri->Begin(TRI_QUADS);
	PlasmaQuad(tri, pos, PlasmaWidth(pos, 7.0f, 4.0f, 14.0f, pixel), alpha, right, up);
	PlasmaQuad(tri, pos, PlasmaWidth(pos, 3.2f, 2.0f, 6.0f, pixel), alpha, right, up);
	tri->End();
	tri->RenderMode(kRenderNormal);
}

// Every shot and trail piece, head and impact flash: once a frame, from TSBullets_Update.
static void TSPlasma_Draw()
{
	const float now = gEngfuncs.GetClientTime();
	Vector fwd, right, up;
	AngleVectors(v_angles, fwd, right, up);
	triangleapi_t* tri = gEngfuncs.pTriAPI;
	const float pixel = PlasmaPixel();

	// the trails: a wide soft glow and a narrow bright core, brightest at the head
	bool any = false;
	for (int i = 0; i < TSPLASMA_BEAMS; i++)
	{
		TSPlasmaBeam* s = &s_plasmaBeams[i];
		if (!s->used)
			continue;
		const float age = now - s->born;
		const float over = (s->run ? s->len / PLASMA_SPEED : 0.0f) + s->hold + s->fade;
		if (age < 0.0f || age > over)
		{
			s->used = false;
			continue;
		}
		any = true;
	}
	if (any && PlasmaBind("sprites/laserrifle_trail.spr", 0))
	{
		tri->RenderMode(kRenderTransAdd);
		tri->CullFace(TRI_NONE);
		for (int layer = 0; layer < 2; layer++)
		{
			const TSPlasmaLayer& lay = s_plasmaLayers[layer];
			tri->Begin(TRI_QUADS);
			for (int i = 0; i < TSPLASMA_BEAMS; i++)
			{
				TSPlasmaBeam* s = &s_plasmaBeams[i];
				if (!s->used)
					continue;
				const float age = now - s->born;
				if (s->run)
				{
					// the head has run PLASMA_SPEED x age; a point x along the shot is full until `hold` after the head
					// passed it and out `fade` later, so the shot is a ramp up to `mid` and full from there to the head
					const Vector dir = (s->b - s->a) * (1.0f / s->len);
					const float head = (PLASMA_SPEED * age < s->len) ? PLASMA_SPEED * age : s->len;
					float tail = PLASMA_SPEED * (age - s->hold - s->fade);
					if (tail < 0.0f)
						tail = 0.0f;
					if (tail >= head)
						continue;
					float mid = PLASMA_SPEED * (age - s->hold);
					if (mid < tail)
						mid = tail;
					if (mid > head)
						mid = head;
					const float iTail = PlasmaIntensity(age - tail / PLASMA_SPEED, s->hold, s->fade);
					const float iMid = PlasmaIntensity(age - mid / PLASMA_SPEED, s->hold, s->fade);
					const float iHead = PlasmaIntensity(age - head / PLASMA_SPEED, s->hold, s->fade);
					PlasmaSpan(tri, lay, pixel, s->a + dir * tail, s->a + dir * mid, iTail, iMid, up);
					PlasmaSpan(tri, lay, pixel, s->a + dir * mid, s->a + dir * head, iMid, iHead, up);
				}
				else
				{
					const float k = PlasmaIntensity(age, s->hold, s->fade);
					PlasmaSpan(tri, lay, pixel, s->a, s->b, k, k, up);
				}
			}
			tri->End();
		}
		tri->RenderMode(kRenderNormal);
	}

	// the heads of the shots: running, then resting at the end for a moment, a little off the surface it hit
	for (int i = 0; i < TSPLASMA_BEAMS; i++)
	{
		TSPlasmaBeam* s = &s_plasmaBeams[i];
		if (!s->used || !s->run)
			continue;
		const float age = now - s->born;
		const Vector dir = (s->b - s->a) * (1.0f / s->len);
		const float run = PLASMA_SPEED * age;
		if (run < s->len)
		{
			PlasmaHead(s->a + dir * run, right, up, 1.0f);
			continue;
		}
		const float landed = (run - s->len) / PLASMA_SPEED; // seconds since it arrived
		if (landed < PLASMA_LAND)
			PlasmaHead(s->b - dir * 2.0f, right, up, 1.0f - landed / PLASMA_LAND);
	}

	// the impact flashes: a star of light that swells and goes out
	any = false;
	for (int i = 0; i < TSPLASMA_FLASHES; i++)
	{
		TSPlasmaFlash* f = &s_plasmaFlashes[i];
		if (f->used && now - f->born > PLASMA_FLASH)
			f->used = false;
		any = any || f->used;
	}
	if (any && PlasmaBind("sprites/laserrifle_hit.spr", 2))
	{
		tri->RenderMode(kRenderTransAdd);
		tri->CullFace(TRI_NONE);
		tri->Begin(TRI_QUADS);
		for (int i = 0; i < TSPLASMA_FLASHES; i++)
		{
			TSPlasmaFlash* f = &s_plasmaFlashes[i];
			if (!f->used)
				continue;
			const float t = (now - f->born) / PLASMA_FLASH;
			PlasmaQuad(tri, f->pos, PlasmaWidth(f->pos, 5.0f + 11.0f * t, 5.0f, 40.0f, pixel), (1.0f - t) * (1.0f - t),
				right, up);
		}
		tri->End();
		tri->RenderMode(kRenderNormal);
	}
}

void TSBullets_Reset()
{
	memset(s_bullets, 0, sizeof(s_bullets));
	s_count = 0;
	TSPlasma_Reset();
}

// FUN_10035c20: the first free slot takes the round; with none free it is dropped.
void TSBullets_Fire(int owner, const float* src, const float* dir, float damage, int caliber, int mode,
	const float* visualStart)
{
	for (int i = 0; i < TSB_MAX_BULLETS; i++)
	{
		TSClientBullet* b = &s_bullets[i];
		if (b->owner != 0)
			continue;
		b->owner = owner;
		b->dir = Vector(dir[0], dir[1], dir[2]);
		b->damage = damage;
		b->caliber = caliber;
		b->start = Vector(src[0], src[1], src[2]);
		b->pos = b->start;
		b->drawPos = b->start;
		b->trailPos = b->start;
		if (visualStart != nullptr)
		{
			b->drawPos = Vector(visualStart[0], visualStart[1], visualStart[2]);
			b->trailPos = b->drawPos;
		}
		b->nextTrail = 0.0f;
		b->nextStep = 0.0f;
		b->mode = mode;
		b->unused58 = 0;
		s_count++;
		return;
	}
}

// FUN_10035d40: move the round one step. The step is the round's speed (caliber speed unit x 40,
// times the slow-motion bullet multiplier) over the update interval (the frame time when that is
// under 0.001). A hit lays the impact; a round with more than 5 damage left after the range
// falloff and the caliber's factor goes on through up to 48 units of anything that is not solid
// there, as the server's bullets do, else it is freed.
static void TSB_Step(TSClientBullet* b, pmtrace_t* tr)
{
	const s_ammo_info* ai = get_ammo_info(b->caliber);
	const float velMult = GetBulletVelocityMult(g_flClientSlow, g_bBulletTime ? 1 : 0);
	float dt = b->nextStep - gEngfuncs.GetClientTime();
	if (dt < 0.001f)
		dt = v_frametime;
	const Vector vel = b->dir * ((float)ai->iSpeedUnit * 40.0f) * dt * velMult;

	event_api_t* ev = gEngfuncs.pEventAPI;
	gEngfuncs.PM_PointContents(b->pos, nullptr); // client.dll makes this call and discards the result
	ev->EV_SetUpPlayerPrediction(0, 1);
	ev->EV_PushPMStates();
	ev->EV_SetSolidPlayers(b->owner - 1);
	ev->EV_SetTraceHull(2);
	Vector end = b->pos + vel;
	ev->EV_PlayerTrace(b->pos, end, PM_STUDIO_BOX, -1, tr);

	bool done = false;
	if (tr->fraction == 1.0f)
	{
		b->pos = b->pos + vel;
	}
	else
	{
		done = true;
		b->pos = tr->endpos;
		const float dist = (b->start - b->pos).Length();
		// a pierce leg falls off over 300 units, any other shot over its caliber's range unit
		const float idx = (b->mode == 2) ? dist * (1.0f / 300.0f) * 10.0f
		                                 : dist / ((float)ai->iRangeUnit * 10.0f) * 10.0f;
		float damage = get_range_multipler((int)idx) * b->damage;
		Vector hitEnd = b->pos + vel;
		EV_TSBulletHit(b->owner, b->pos, hitEnd, *tr, b->mode, b->caliber);
		damage = damage * ai->flFactor2;

		if (b->mode != 2 && b->mode != 1 && damage > 5.0f)
		{
			const float depth = (damage < 48.0f) ? damage : 48.0f;
			Vector exitPos = Vector(tr->endpos) + b->dir * depth;
			if (gEngfuncs.PM_PointContents(exitPos, nullptr) != CONTENTS_SOLID)
			{
				Vector face = tr->endpos;
				b->pos = exitPos;
				b->start = exitPos;
				b->damage = damage;
				b->mode = 2;
				// the far face, traced back from where the round comes out
				ev->EV_SetTraceHull(2);
				ev->EV_PlayerTrace(exitPos, face, PM_NORMAL, -1, tr);
				if (tr->fraction != 1.0f)
					EV_TSBulletHit(b->owner, exitPos, face, *tr, 2, b->caliber);
				done = false;
			}
		}
	}
	ev->EV_PopPMStates();

	if (done)
	{
		if (b->caliber == TS_CALIBER_PLASMA)
			TSPlasma_Piece(b->trailPos, b->pos); // the trail goes on to where the round landed
		memset(b, 0, sizeof(*b));
	}
}

// FUN_100570b0: on screen enough to draw. Within 300 units always; further out only in front of
// the view and inside a cone that widens a little with distance.
static bool TSB_InView(const Vector& p, const Vector& fwd, const Vector& right, const Vector& up)
{
	Vector d = p - v_origin; // FUN_10057270: the view origin (the camera in third person)
	const float dist = d.Length();
	if (dist <= 300.0f)
		return true;
	d = d * (1.0f / dist);
	if (DotProduct(fwd, d) < 0.0f)
		return false;
	const float side = fabs(DotProduct(right, d));
	const float height = fabs(DotProduct(up, d));
	const float spread = (dist * (1.0f / 8192.0f) * 0.2f + 1.0f) * (side + height * 0.5f);
	return spread <= 0.9f;
}

static void TSB_Quad(triangleapi_t* tri, Vector a, Vector b, Vector c, Vector d)
{
	tri->TexCoord2f(0, 0);
	tri->Vertex3fv(a);
	tri->TexCoord2f(1, 0);
	tri->Vertex3fv(b);
	tri->TexCoord2f(1, 1);
	tri->Vertex3fv(c);
	tri->TexCoord2f(0, 1);
	tri->Vertex3fv(d);
}

// FUN_10035010: draw one round (called only in slow motion) and move its drawn position on.
// The sprite is sprites/shotgun_pellets.spr, additive, half-size 1 - slow^2 (at least 0.15):
// two crossed streaks 5..25 units either side of it along its direction (slow x 37.5; none for
// caliber 3) and a camera-facing quad. Within about 3 units of the view (squared distance under
// 10) it fades. cl_wavedetail above 0 lays a trail piece from the last one every 0.01 s of slowed
// time (0x10035a66).
static void TSB_Draw(TSClientBullet* b, int sprite, const Vector& fwd, const Vector& right, const Vector& up)
{
	// The laser rifle's round: a green bolt and its trail, not a pellet sprite and a white streak. It is drawn at
	// every time scale and wherever it is, and its trail is not held back by cl_wavedetail: a piece is laid each
	// frame from where the last one ended to the head, and the step that lands the round carries the trail on to
	// the impact.
	if (b->caliber == TS_CALIBER_PLASMA)
	{
		const Vector toHead = v_origin - b->drawPos;
		float glow = DotProduct(toHead, toHead);
		glow = (glow < 10.0f) ? glow * 0.1f : 1.0f;
		PlasmaHead(b->drawPos, right, up, glow);
		const float plasmaMult = GetBulletVelocityMult(g_flClientSlow, g_bBulletTime ? 1 : 0);
		b->drawPos = b->drawPos + b->dir * ((float)get_ammo_info(b->caliber)->iSpeedUnit * 40.0f * plasmaMult * v_frametime);
		if ((b->drawPos - b->trailPos).Length() >= 3.0f)
		{
			TSPlasma_Piece(b->trailPos, b->drawPos);
			b->trailPos = b->drawPos;
		}
		return;
	}

	if (!TSB_InView(b->drawPos, fwd, right, up))
		return;

	float size = 1.0f - g_flClientSlow * g_flClientSlow;
	if (size < 0.15f)
		size = 0.15f;
	// client.dll measures this from its first-person view origin (0x10190b28); v_origin is that
	// point in first person
	const Vector toView = v_origin - b->drawPos;
	float alpha = DotProduct(toView, toView);
	alpha = (alpha < 10.0f) ? alpha * 0.1f : 1.0f;

	if (sprite >= 0)
	{
		triangleapi_t* tri = gEngfuncs.pTriAPI;
		model_t* model = (model_t*)gEngfuncs.GetSpritePointer(TSParticles_SpriteHandle(sprite));
		if (model != nullptr && 0 != tri->SpriteTexture(model, 0))
		{
			tri->RenderMode(kRenderTransAdd);
			tri->CullFace(TRI_NONE);
			tri->Begin(TRI_QUADS);
			tri->Color4f(1.0f, 1.0f, 1.0f, alpha);
			if (b->caliber != 3)
			{
				float len = g_flClientSlow * 37.5f;
				if (len < 5.0f)
					len = 5.0f;
				else if (len > 25.0f)
					len = 25.0f;
				const Vector head = b->drawPos + b->dir * len;
				const Vector tail = b->drawPos - b->dir * len;
				const Vector u = up * size;
				const Vector r = right * size;
				TSB_Quad(tri, head - u, head + u, tail + u, tail - u);
				TSB_Quad(tri, head - r, head + r, tail + r, tail - r);
			}
			// FUN_10050080 with no velocity: the camera-facing quad
			const Vector u = up * size;
			const Vector r = right * size;
			TSB_Quad(tri, b->drawPos + u - r, b->drawPos + u + r, b->drawPos - u + r, b->drawPos - u - r);
			tri->End();
			tri->RenderMode(kRenderNormal);
		}
	}

	const float velMult = GetBulletVelocityMult(g_flClientSlow, g_bBulletTime ? 1 : 0);
	const float speed = (float)get_ammo_info(b->caliber)->iSpeedUnit * 40.0f * velMult * v_frametime;
	b->drawPos = b->drawPos + b->dir * speed;

	static cvar_t* s_waveDetail = nullptr;
	if (s_waveDetail == nullptr)
		s_waveDetail = gEngfuncs.pfnGetCvarPointer("cl_wavedetail");
	if (s_waveDetail != nullptr && s_waveDetail->value > 0.0f && gEngfuncs.GetClientTime() > b->nextTrail)
	{
		const float wait = FixedSlowMul(g_flClientSlow) * 0.01f; // FUN_10056fa0(0.01)
		b->nextTrail = gEngfuncs.GetClientTime() + wait;
		TSP_BulletTrail(b->drawPos, b->trailPos, size, alpha);
		b->trailPos = b->drawPos;
	}
}

// FUN_10034e60 / FUN_10035b50. A round is stepped when its time comes: every 0.1 s with realbullet
// 0, every 0.05 s with realbullet 1, every frame otherwise (and a plasma round every frame, so that what
// is drawn of it does not stop short of where it lands). In slow motion each is then drawn,
// including one freed by its step this frame (client.dll draws the cleared slot too: at most one
// frame of a tiny pellet sprite at the world origin, kept as the original does it).
void TSBullets_Update()
{
	TSPlasma_Draw(); // the plasma shots and trails go on after the rounds that made them are gone
	if (s_count == 0)
		return;

	const int sprite = TSParticles_Sprite("sprites/shotgun_pellets.spr", kRenderTransAdd);
	Vector fwd, right, up;
	AngleVectors(v_angles, fwd, right, up); // the FX root's AngleVectors (0x10056f60)

	s_count = 0;
	pmtrace_t tr;
	for (int i = 0; i < TSB_MAX_BULLETS; i++)
	{
		TSClientBullet* b = &s_bullets[i];
		if (b->owner == 0)
			continue;
		if (b->nextStep < gEngfuncs.GetClientTime())
		{
			const float now = gEngfuncs.GetClientTime();
			b->nextStep = now;
			if (g_iTSRealBullet >= 0 && g_iTSRealBullet < 2 && b->caliber != TS_CALIBER_PLASMA)
				b->nextStep = 0.1f / (float)(g_iTSRealBullet + 1) + now;
			TSB_Step(b, &tr);
		}
		if (g_flClientSlow < 0.99f || b->caliber == TS_CALIBER_PLASMA)
			TSB_Draw(b, sprite, fwd, right, up);
		s_count++;
	}
}
