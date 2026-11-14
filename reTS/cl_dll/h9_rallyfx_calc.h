// H9 rally mode's visual effects, the arithmetic alone (no engine call, no engine type), so tests/racefx_test.cpp can run it.
// cl_dll/h9_rallyfx.cpp feeds it the car's state and draws what it says.
//
// What this is. HL Rally draws its car effects on the CLIENT, each frame, from cl_dll/Rally_Effects.cpp ("re" below), its temporary-entity
// update (cl_dll/entity.cpp, "en") and its input code ("in"). The numbers below are facts about that game's behaviour, read from its source;
// the code and every comment are ours. Each function names the file and line its rule comes from.
//
// Frame rate. HL Rally's per-frame constants (the brake light's +0.06 and -0.08 a frame, the headlight's 0.1, the dust's four puffs a frame)
// were tuned at about 99 frames a second (fps_max 100 in its config). Each is here a rate that is HL Rally's at 99 and time-based at any other:
// Ticks(dt) is the number of HL Rally frames a client frame of `dt` seconds stands for.
#pragma once

#include "h9_racefx_calc.h"
#include "h9_rallysnd_calc.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

namespace rallyfx
{

using racefx::V3;

const float kHlrFps = 99.0f;
inline float Ticks(float dt) { return dt * kHlrFps; }

// HL Rally's car origin is a unit over the floor (its hull is one unit each way above and below the origin); ours is on it (cl_dll/
// h9_rallycar.cpp SurfaceUnder). Every HL Rally trace here starts at the origin lifted by this and every end point it finds is lifted by it again
// (the hull's own half height), so the marks and the shadow are as far over the ground as HL Rally's.
const float kHlrHull = 1.0f;

// The car's axes for a yaw (re:557-558 AngleVectors, flat: no pitch and no roll here; the entity's own are the engine's).
inline V3 Fwd(float yawDeg)
{
	const float a = yawDeg * 3.14159265358979f / 180.0f;
	return V3(cosf(a), sinf(a), 0.0f);
}
inline V3 Right(float yawDeg)
{
	const float a = yawDeg * 3.14159265358979f / 180.0f;
	return V3(sinf(a), -cosf(a), 0.0f);
}
inline V3 Up() { return V3(0.0f, 0.0f, 1.0f); }

// HL Rally's VectorNormalize: a vector of no length stays as it is.
inline V3 Normalize(const V3& v)
{
	const float l = v.Length();
	return l > 0.0f ? v * (1.0f / l) : v;
}

// A texture name's letters in lower case (HL Rally lowers the engine's string in place before every strstr).
inline void Lower(const char* in, char* out, size_t cap)
{
	size_t i = 0;
	for (; in && in[i] && i + 1 < cap; i++)
		out[i] = (in[i] >= 'A' && in[i] <= 'Z') ? (char)(in[i] + 32) : in[i];
	out[i] = 0;
}
inline bool Has(const char* low, const char* word) { return strstr(low, word) != NULL; }

// The engine's random numbers, as an interface so the test can give fixed ones. Long is pfnRandomLong(lo, hi) (both ends inclusive), Float is
// pfnRandomFloat(lo, hi).
struct Rng
{
	virtual long Long(long lo, long hi) = 0;
	virtual float Float(float lo, float hi) = 0;
};

// ---- the sprites -----------------------------------------------------------------------------------------------------------------------

// Our file for each of HL Rally's (sprites/h9/rally/<base>.spr); the table in the report says which of HL Rally's it stands for.
enum SprId
{
	SP_SKID,      // r_skid.spr
	SP_SKID_DIRT, // r_skid_dirt.spr
	SP_SKID_SAND, // r_skid_sand.spr
	SP_SKID_SNOW, // r_skid_snow.spr
	SP_DIRT,      // r_dirt.spr
	SP_GRASS,     // r_grass.spr
	SP_SAND,      // r_sand.spr
	SP_SNOW,      // r_snow.spr
	SP_SMOKE,     // r_smoke.spr
	SP_FLARE,     // flare3.spr
	SP_SHADOW,    // r_shadow.spr
	SP_FLASH,     // muzzleflash3.spr
	SP_N,
	SP_NONE = -1
};
inline const char* SprBase(int id)
{
	static const char* const names[SP_N] = {"r_skid", "r_skid_dirt", "r_skid_sand", "r_skid_snow", "r_dirt", "r_grass", "r_sand", "r_snow", "r_smoke", "flare3", "r_shadow", "muzzleflash3"};
	return (id >= 0 && id < SP_N) ? names[id] : "";
}

// ---- the dust and the tyre smoke (re:661-822 renderPlayerDust) ---------------------------------------------------------------------------

struct DustSel
{
	int spr;        // SprId, SP_NONE for no dust
	float scaleMul; // spr_scale_mul
	float alpha;    // spr_alpha
};

// The sprite for the texture 64 units under the car (re:690-757). `tex` null: the trace found no texture and nothing is drawn (re:683 `if (tmp)`).
// `skidding` is bIsSkidding as the last frame's skid step left it (renderPlayerDust runs before renderPlayerCheckSkid in re:1873-1880's order,
// re:496-500 renderPlayer), `tractionLoss` is g_tractionloss.
inline DustSel DustSelect(const char* tex, bool skidding, float tractionLoss, Rng& rng)
{
	DustSel s = {SP_NONE, 0.9f, 1.0f};
	if (tex == NULL)
		return s;
	char low[64];
	Lower(tex, low, sizeof(low));
	if (Has(low, "dirt") || Has(low, "mud") || Has(low, "cliff"))
	{
		s.spr = SP_DIRT;
		s.alpha = 0.6f;
	}
	else if (Has(low, "gras"))
	{
		s.spr = SP_GRASS;
		s.scaleMul = 0.25f;
		s.alpha = 1.0f;
	}
	else if (Has(low, "sand") || Has(low, "desert"))
	{
		s.spr = SP_SAND;
	}
	else if (Has(low, "snow"))
	{
		if (rng.Long(0, 10) > 4)
		{
			s.spr = rng.Long(0, 10) > 4 ? SP_DIRT : SP_SNOW;
			s.scaleMul = 0.0125f;
		}
		else
		{
			s.spr = SP_SMOKE;
			s.scaleMul = 1.0f;
			s.alpha = 0.25f;
		}
	}
	else if (skidding)
	{
		s.spr = SP_SMOKE;
		s.scaleMul = 0.65f;
		s.alpha = 0.4f;
		if (tractionLoss != 0.0f)
		{
			s.alpha = s.alpha * tractionLoss + 0.1f;
			if (s.alpha > 0.4f)
				s.alpha = 0.4f;
		}
	}
	return s;
}

struct DustPuff
{
	V3 pos, vel;
	float scale; // smoke_size * spr_scale_mul, the sprite's scale
	float alpha; // 0..1
	float life;  // seconds
	int spr;
};

// One HL Rally frame's puffs for one car (re:761-820): none unless the speed is over 30 on the ground. Four wheels for the local car (back right,
// back left, front right, front left), two for another car (the back ones), whose life is 0.6 and whose scale is divided by 0.6. `vel` is the car's
// velocity; `v2D` the length of its horizontal part. Returns how many puffs were made.
inline int DustPuffs(const DustSel& sel, bool local, bool interior, float v2D, bool onGround, const V3& origin, const V3& fwd, const V3& right, const V3& up,
	const V3& vel, Rng& rng, DustPuff out[4])
{
	if (sel.spr == SP_NONE || !(v2D > 30.0f) || !onGround)
		return 0;
	float scaleMul = sel.scaleMul, life = 1.0f;
	const V3 pt[4] = {
		origin + up * 1.5f + right * 9.0f - fwd * 19.0f, // back
		origin + up * 1.5f - right * 9.0f - fwd * 19.0f,
		origin + up * 1.5f + right * 9.0f + fwd * 10.0f, // front
		origin + up * 1.5f - right * 9.0f + fwd * 10.0f,
	};
	int n = 4;
	if (!local || interior)
	{
		n = 2;
		life *= 0.6f;
		scaleMul /= 0.6f;
	}
	for (int i = 0; i < n; i++)
	{
		V3 v = vel;
		if (local)
		{
			// RandomLong takes whole numbers: the float limits are cut at the decimal point
			v.x = v.x * 0.97f + (float)rng.Long((long)(v2D / -30.0f), (long)(v2D / 30.0f));
			v.y = v.y * 0.97f + (float)rng.Long((long)(v2D / -30.0f), (long)(v2D / 30.0f));
			v.z = v.z * 0.97f + (float)rng.Long(0, (long)(v2D / 10.0f));
		}
		else
		{
			v.x = v.x * 0.85f + (float)rng.Long((long)(v2D / -20.0f), (long)(v2D / 20.0f));
			v.y = v.y * 0.85f + (float)rng.Long((long)(v2D / -20.0f), (long)(v2D / 20.0f));
			v.z = v.z * 0.85f + (float)rng.Long(0, (long)(v2D / 15.0f));
		}
		float size = v2D * 0.002f * rng.Float(0.9f, 1.2f);
		if (size < 0.05f)
			size = 0.05f;
		else if (size > 1.5f)
			size = 1.5f;
		if (i >= 2) // the front wheels' dust lasts less: the life is cut again for each of them (it compounds)
		{
			life = life * 0.75f;
			size = size * 0.75f;
		}
		DustPuff& p = out[i];
		p.pos = pt[i];
		p.vel = v;
		p.scale = size * scaleMul;
		p.alpha = sel.alpha;
		p.life = life;
		p.spr = sel.spr;
	}
	return n;
}

// The temporary entity's own update for a puff (en:660-695, FTENT_DUSTSPRITE): the fields are those of the entity, by what HL Rally stores in them.
struct DustEnt
{
	float baseScale; // baseline.scale: 0 until the first update
	float life0;     // baseline.fuser1: the life left at the first update
	V3 vel0;         // baseline.vuser1: the velocity the puff was made with
	V3 vel;          // baseline.origin: the velocity the movement uses
	int baseAmt;     // baseline.renderamt
	int amt;         // curstate.renderamt
	float scale;     // curstate.scale
};
// `life` is the seconds the puff has left (die - the client's time). Fades the alpha with the life left, slows the puff by it and grows the scale
// to the made one over the life (a first update starts from the scale the puff was made with).
inline void DustUpdate(DustEnt& e, float life)
{
	if (e.baseScale == 0.0f)
	{
		e.baseScale = e.scale;
		e.life0 = life;
		e.vel0 = e.vel;
	}
	if (!(e.life0 > 0.0f))
		return;
	const float left = life / e.life0;
	e.amt = (int)((float)e.baseAmt * left);
	e.vel = e.vel0 * left;
	e.scale = 0.01f + ((e.life0 + (-life / e.life0)) * e.baseScale);
	if (e.scale < 0.00125f)
		e.scale = 0.00125f; // a tiny scale would be drawn full size
}

// ---- the skid marks (re:1004-1245 renderPlayerCheckSkid, re:299-337 renderSkidmarks) ------------------------------------------------------

const float kSkidLengthOfs = 7.0f;  // SKID_LENGTH_OFS
const float kSkidWidthOfs = 3.0f;   // SKID_WIDTH_OFS
const float kTraceHeight = 3.0f;    // TRACE_HEIGHT
const float kTraceLength = 56.0f;   // TRACE_LENGTH
const float kSkidStep = 15.0f;      // a mark is laid when the back right corner has moved more than this
const float kSkidWidth = 4.0f;      // each quad's width
const float kSkidLift = 1.0f;       // drawn this far over the ground (re:343 `z + 1.0f`)
const float kSkidDrawRange = 3000.0f; // a mark further than this from the player is let go
const float kSkidLife = 45.0f;      // rally_skidmarktime (config.cfg and the manual; the code's own default is 30)

enum SkidTex
{
	SKT_ROAD = 0, // r_skid
	SKT_DIRT,     // r_skid_dirt
	SKT_SAND,     // r_skid_sand
	SKT_SNOW,     // r_skid_snow
	SKT_NONE = -1 // noskid: nothing is laid
};
// re:1100-1140, by the same words the squeal reads (h9_rallysnd_calc.h SkidSurfaceOf).
inline int SkidTexOf(const char* tex)
{
	switch (rallysnd::SkidSurfaceOf(tex))
	{
	case rallysnd::SKID_NONE: return SKT_NONE;
	case rallysnd::SKID_DIRT: return SKT_DIRT;
	case rallysnd::SKID_SAND: return SKT_SAND;
	case rallysnd::SKID_SNOW: return SKT_SNOW;
	default: return SKT_ROAD;
	}
}
inline int SkidSpr(int skidTex)
{
	switch (skidTex)
	{
	case SKT_DIRT: return SP_SKID_DIRT;
	case SKT_SAND: return SP_SKID_SAND;
	case SKT_SNOW: return SP_SKID_SNOW;
	default: return SP_SKID;
	}
}

// re:1396-1427 vectoangles: the velocity's pitch and yaw in whole degrees (cut, not rounded), 0..359.
inline void VecToAngles(const V3& v, float ang[3])
{
	float yaw, pitch;
	if (v.y == 0.0f && v.x == 0.0f)
	{
		yaw = 0.0f;
		pitch = v.z > 0.0f ? 90.0f : 270.0f;
	}
	else
	{
		yaw = (float)(int)(atan2((double)v.y, (double)v.x) * (180.0 / 3.14159265358979323846));
		if (yaw < 0.0f)
			yaw += 360.0f;
		const double fwd = sqrt((double)v.x * v.x + (double)v.y * v.y);
		pitch = (float)(int)(atan2((double)v.z, fwd) * (180.0 / 3.14159265358979323846));
		if (pitch < 0.0f)
			pitch += 360.0f;
	}
	ang[0] = pitch;
	ang[1] = yaw;
	ang[2] = 0.0f;
}

// re:1064-1068: the mark's width direction. HL Rally crosses the ANGLES (pitch, yaw, 0 in degrees, not a direction) with the ground's normal and
// normalizes. On level ground that is (yaw, -pitch, 0) normalized, so it is the world's X axis for any heading but 0: a mark is 4 wide along X
// whatever way the car goes (and a line, no width, when the car drives along X). Kept as HL Rally has it.
inline V3 SkidRight(const V3& vel, const V3& normal)
{
	float r[3];
	VecToAngles(vel, r);
	const V3 a(r[0], r[1], r[2]);
	return Normalize(a.Cross(normal));
}

// What the ground says, for the skid step: a point trace (no hit: the end point and a normal of zero), and the texture under the car.
struct SkidWorld
{
	virtual void Trace(const V3& from, const V3& to, V3& endpos, V3& normal) = 0;
	virtual const char* Texture(const V3& origin) = 0; // 64 units down from the origin; null when none
};

struct SkidState
{
	bool first;     // bSkid_FirstTime
	bool skidding;  // bIsSkidding
	V3 last[4];     // vSkid_last_pos: rear right, rear left, front right, front left
	V3 lastRight;   // vSkid_last_right
	SkidState() : first(true), skidding(false) {}
};
struct SkidQuad
{
	V3 v[4];
	int tex; // SkidTex
};
struct SkidInput
{
	V3 origin;
	float yaw;
	V3 vel;
	bool onGround;
	int gear;
	int accelerating; // g_accelerating as the revs left it (rallysnd::Accelerating)
	bool braking, handbraking, tractionLoss, reversing;
};

// One frame of renderPlayerCheckSkid for the LOCAL car (another car, and the interior's record, leave at the first test with no mark). Returns how
// many quads were made (0 or 4) into `out`. The gate is rallysnd::MarkGate, the one the squeal uses.
inline int SkidStep(SkidState& s, const SkidInput& in, SkidWorld& w, SkidQuad out[4])
{
	const float speed2D = sqrtf(in.vel.x * in.vel.x + in.vel.y * in.vel.y);
	if (speed2D < 20.0f)
	{
		s.skidding = false;
		return 0;
	}
	const V3 f = Fwd(in.yaw), r = Right(in.yaw);
	const V3 o = in.origin;
	const V3 corner[4] = {o + f * 22.0f - r * 12.0f, o - f * 22.0f - r * 12.0f, o - f * 22.0f + r * 12.0f, o + f * 22.0f + r * 12.0f}; // FL BL BR FR
	const V3 d = s.last[0] - corner[2];
	if (!(d.Length() > kSkidStep || s.first))
		return 0;
	const V3 vn = Normalize(in.vel);
	const V3 tv = vn - f;
	const V3 z3(0, 0, kTraceHeight), down(0, 0, -kTraceLength);
	V3 pt[4], n, nrm;
	V3 start = corner[2] + f * kSkidLengthOfs - r * kSkidWidthOfs + z3; // rear right
	w.Trace(start, start + down, pt[0], n);
	start = corner[1] + f * kSkidLengthOfs + r * kSkidWidthOfs + z3; // rear left
	w.Trace(start, start + down, pt[1], n);
	start = corner[3] + f * (-kSkidLengthOfs * 1.2f) - r * kSkidWidthOfs + z3; // front right
	w.Trace(start, start + down, pt[2], n);
	start = corner[0] + f * (-kSkidLengthOfs * 1.2f) + r * kSkidWidthOfs + z3; // front left: its normal is the one the width is taken from
	w.Trace(start, start + down, pt[3], nrm);
	const V3 right = SkidRight(in.vel, nrm);

	s.skidding = false;
	int made = 0;
	if (rallysnd::MarkGate(in.onGround, s.first, in.gear, speed2D, in.accelerating, in.braking, in.handbraking, in.tractionLoss, tv.y, in.reversing))
	{
		s.skidding = true;
		const char* tex = w.Texture(in.origin);
		const int kind = tex != NULL ? SkidTexOf(tex) : SKT_NONE;
		if (kind == SKT_NONE)
			return 0; // noskid: HL Rally leaves the function here; the positions are not kept
		for (int q = 0; q < 4; q++)
		{
			const float sgn = (q == 0 || q == 2) ? -1.0f : 1.0f; // the right wheels' marks go one way, the left's the other
			out[q].v[0] = pt[q];
			out[q].v[1] = s.last[q];
			out[q].v[2] = s.last[q] + s.lastRight * (sgn * kSkidWidth);
			out[q].v[3] = pt[q] + right * (sgn * kSkidWidth);
			out[q].tex = kind;
		}
		made = 4;
	}
	else
	{
		s.first = false;
	}
	for (int q = 0; q < 4; q++)
		s.last[q] = pt[q];
	s.lastRight = right;
	return made;
}

// The list the marks are kept in (re:299-337): first in, first out; the oldest is dropped when its time is up or it is over 3000 units from the
// player. `Q` is the capacity: HL Rally has none (a malloc each); ours drops the oldest when full.
template <int Q>
struct SkidList
{
	struct Item
	{
		V3 v[4];
		float die;
		int tex;
	};
	Item item[Q];
	int head, count;
	SkidList() : head(0), count(0) {}
	void Clear() { head = count = 0; }
	void Push(const SkidQuad& q, float now, float life)
	{
		if (count == Q)
		{
			head = (head + 1) % Q;
			count--;
		}
		Item& it = item[(head + count) % Q];
		for (int i = 0; i < 4; i++)
			it.v[i] = q.v[i];
		it.tex = q.tex;
		it.die = life > 0.0f ? now + life : 0.0f; // a life of 0 never goes (re:1156 `if (cvar) time = now + cvar`)
		count++;
	}
	const Item& At(int i) const { return item[(head + i) % Q]; }
	// re:303-311: from the head, while its die time is set and past or its first vertex is far from the player.
	void Purge(float now, const V3& player)
	{
		while (count > 0)
		{
			const Item& it = item[head];
			if (!(it.die != 0.0f && (now > it.die || (it.v[0] - player).Length() > kSkidDrawRange)))
				break;
			head = (head + 1) % Q;
			count--;
		}
	}
};

// ---- the brake and reverse lamps (re:1252-1450 renderPlayerBrakeLights) ------------------------------------------------------------------

const float kLampUp = 0.06f;    // brightness a frame while braking or reversing, at 99 a second
const float kLampDown = 0.08f;  // and while neither
const float kLampMax = 0.6f;

struct LampState
{
	float brightness; // fBrightness
	bool wasBraking;  // bWasBraking: the colour is red unless the reverse key came last
	LampState() : brightness(0), wasBraking(false) {}
};
// One client frame of `dt` seconds. True when the lamps are to be drawn this frame (HL Rally draws while anything of it is lit, and the last frame
// at brightness 0). The braking key makes red, reversing makes it bluish white, and reversing wins when both are on (re:1305-1309).
inline bool LampStep(LampState& s, bool braking, bool reversing, float dt)
{
	if (braking)
		s.wasBraking = true;
	if (reversing)
		s.wasBraking = false;
	if (!(braking || reversing || s.brightness > 0.0f))
	{
		s.brightness = 0.0f;
		return false;
	}
	const float k = Ticks(dt);
	if (!(braking || reversing))
		s.brightness -= kLampDown * k;
	else
		s.brightness += kLampUp * k;
	if (s.brightness > kLampMax)
		s.brightness = kLampMax;
	else if (s.brightness < 0.0f)
		s.brightness = 0.0f;
	return true;
}

// carinfo.txt of HL Rally's xsara (BrakeLightDst, Width, Height), the car our rc_rally_xs.mdl is made like: the lamps sit here for every class that
// drives that body.
struct LampDims
{
	float dst, width, height;
};
inline LampDims LampXsara()
{
	LampDims d = {21.165f, 5.373f, 9.62f};
	return d;
}

struct LampQuad
{
	V3 v[4];
};
struct Lamps
{
	LampQuad q[2];  // right lamp, left lamp
	V3 elight[2];   // where the entity lights go: the last vertex of each quad
};
// re:1325-1440. The right lamp is at +right * width (width * 0.92 for the reverse lamps), the left at -right * width; each quad runs from 1 to 1.4
// times that across and from 0.8 to 1 times the height up, a unit of it 21 behind the origin.
inline Lamps LampGeometry(const V3& origin, const V3& fwd, const V3& right, const V3& up, const LampDims& d, bool wasBraking)
{
	Lamps l;
	const V3 W = right * (wasBraking ? d.width : d.width * 0.92f);
	const V3 F = fwd * -d.dst;
	const V3 U = up * d.height;
	// right lamp (re:1342-1372): origin + W + F + U, then down to 0.8 U, across to 1.4 W, and up to U again
	l.q[0].v[0] = origin + W + F + U;
	l.q[0].v[1] = origin + W + F + U * 0.8f;
	l.q[0].v[2] = origin + W * 1.4f + F + U * 0.8f;
	l.q[0].v[3] = origin + W * 1.4f + F + U;
	l.elight[0] = l.q[0].v[3];
	// left lamp (re:1394-1437)
	l.q[1].v[0] = origin - W + F + U;
	l.q[1].v[1] = origin - W + F + U * 0.8f;
	l.q[1].v[2] = origin - W * 1.4f + F + U * 0.8f;
	l.q[1].v[3] = origin - W * 1.4f + F + U;
	l.elight[1] = l.q[1].v[3];
	return l;
}
// The lamps' colour on the additive sprite and the two entity lights' bytes (re:1346-1352, 1375-1387): red (1, .1, .1) braking, (.9, .9, 1)
// reversing; the lights 240 x the brightness in red (2 in green and blue) braking, 200 x it in all three reversing; radius 2.
struct LampColour
{
	float r, g, b;           // the quad's colour, to be multiplied by the brightness
	unsigned char lr, lg, lb; // the entity light's colour bytes
};
inline LampColour LampColourFor(bool wasBraking, float brightness)
{
	LampColour c;
	if (wasBraking)
	{
		c.r = 1.0f;
		c.g = 0.1f;
		c.b = 0.1f;
		c.lr = (unsigned char)(int)(brightness * 240.0f);
		c.lg = 2;
		c.lb = 2;
	}
	else
	{
		c.r = 0.9f;
		c.g = 0.9f;
		c.b = 1.0f;
		c.lr = c.lg = c.lb = (unsigned char)(int)(brightness * 200.0f);
	}
	return c;
}
const float kElightRadius = 2.0f;

// ---- the headlights (re:1452-1489 renderPlayerHeadLights) ----------------------------------------------------------------------------------

const float kHeadStep = 0.1f;       // brightness a frame, at 99 a second
const float kHeadRadius = 220.0f;
const float kHeadForward = 195.0f;
struct HeadState
{
	float brightness;
	bool on;
	HeadState() : brightness(0), on(false) {}
};
// True when the light is to be made this frame (while it is on or still fading). The brightness goes 0..1 by 0.1 a frame at 99.
inline bool HeadStep(HeadState& s, float dt)
{
	if (!(s.brightness > 0.0f || s.on))
		return false;
	const float k = Ticks(dt) * kHeadStep;
	s.brightness += s.on ? k : -k;
	if (s.brightness > 1.0f)
		s.brightness = 1.0f;
	else if (s.brightness < 0.0f)
		s.brightness = 0.0f;
	return true;
}
// The light's place (a unit to the right, 195 ahead, a unit up from the origin) and colour bytes (160, 160, 150 x the brightness).
inline V3 HeadOrigin(const V3& origin, const V3& fwd, const V3& right, const V3& up) { return origin + right + fwd * kHeadForward + up; }
inline void HeadColour(float brightness, unsigned char c[3])
{
	c[0] = (unsigned char)(int)(160.0f * brightness);
	c[1] = (unsigned char)(int)(160.0f * brightness);
	c[2] = (unsigned char)(int)(150.0f * brightness);
}

// ---- the shadow (re:828-955 renderPlayerShadows) -----------------------------------------------------------------------------------------

const float kShadowDown = 2056.0f;
const int kShadowMaxDiv = 8; // rally_shadows is the subdivisions (4); an extreme value is held here (144 traces a car)

struct ShadowCorners
{
	V3 c[4]; // front left, back left, back right, front right
};
// The 44 x 24 rectangle of the car (22 forward and back, 12 to each side), shrunk toward the middle when in the air by height / 5 along the car and
// height / 10 across (re:567-571, 861-905).
inline ShadowCorners ShadowRect(const V3& origin, const V3& fwd, const V3& right, bool onGround, float height)
{
	ShadowCorners s;
	s.c[0] = origin + fwd * 22.0f - right * 12.0f;
	s.c[1] = origin - fwd * 22.0f - right * 12.0f;
	s.c[2] = origin - fwd * 22.0f + right * 12.0f;
	s.c[3] = origin + fwd * 22.0f + right * 12.0f;
	if (!onGround)
	{
		s.c[0] = s.c[0] + fwd * -(height / 5.0f) + right * (height / 10.0f);
		s.c[1] = s.c[1] + fwd * (height / 5.0f) + right * (height / 10.0f);
		s.c[2] = s.c[2] + fwd * (height / 5.0f) + right * -(height / 10.0f);
		s.c[3] = s.c[3] + fwd * -(height / 5.0f) + right * -(height / 10.0f);
	}
	return s;
}

struct ShadowVert
{
	V3 p;
	float u, v;
};
const int kShadowMaxVerts = kShadowMaxDiv * kShadowMaxDiv * 4;
// The shadow's quads, `div` x `div` of them, each corner traced down 2056 to the world (re:915-947, drawn there as `div` quad strips). Writes four
// vertices a quad (top at j - 1, bottom at j - 1, bottom at j, top at j), the texture running 0..1 over the width (u) and length (v). The two
// left-hand vertices of a strip are the traces' end points as they are, the others a tenth over (re:921-943). Returns the vertex count.
inline int ShadowGrid(const ShadowCorners& sc, const V3& fwd, const V3& right, int div, SkidWorld& w, ShadowVert* out, int cap)
{
	if (div < 1)
		return 0;
	if (div > kShadowMaxDiv)
		div = kShadowMaxDiv;
	const float width = (sc.c[2] - sc.c[1]).Length();
	const float length = (sc.c[1] - sc.c[0]).Length();
	const float incW = width / (float)div, incL = length / (float)div;
	const V3 z3(0, 0, kTraceHeight), down(0, 0, -kShadowDown);
	int n = 0;
	for (int i = 0; i < div; i++)
	{
		const float texTop = (1.0f / (float)div) * (float)i, texBottom = (1.0f / (float)div) * (float)(i + 1);
		V3 top, bottom, nrm;
		V3 from = sc.c[0] + fwd * -(incL * (float)i) + z3;
		w.Trace(from, from + down, top, nrm);
		from = sc.c[0] + fwd * -(incL * (float)(i + 1)) + z3;
		w.Trace(from, from + down, bottom, nrm);
		V3 prevTop = top, prevBottom = bottom;
		for (int j = 1; j <= div; j++)
		{
			const float texW = (1.0f / (float)div) * (float)j;
			V3 curTop, curBottom;
			from = top + right * (incW * (float)j) + z3;
			w.Trace(from, from + down, curTop, nrm);
			curTop.z += 0.1f;
			from = bottom + right * (incW * (float)j) + z3;
			w.Trace(from, from + down, curBottom, nrm);
			curBottom.z += 0.1f;
			if (n + 4 > cap)
				return n;
			const float texW0 = (1.0f / (float)div) * (float)(j - 1);
			out[n++] = {prevTop, texW0, texTop};
			out[n++] = {prevBottom, texW0, texBottom};
			out[n++] = {curBottom, texW, texBottom};
			out[n++] = {curTop, texW, texTop};
			prevTop = curTop;
			prevBottom = curBottom;
		}
	}
	return n;
}

// ---- the exhaust flame (re:1537-1640 renderPlayerExhaust) --------------------------------------------------------------------------------

// Three additive quads of muzzleflash3, 4 across, at the exhaust: one centred, two beside it a quad's width to each side (re:1585-1630); the
// vertices of each are rotated by one of four steps as the flame fades, so the picture turns as it dies. `fade` is 1 as the pop starts and 0 as it
// ends (rallysnd's BackfireFrame, HL Rally's flamefade). Returns 12 vertices, in the order the sprite's corners are given (0,0)(0,1)(1,1)(1,0).
inline void FlameQuads(const V3& origin, const V3& right, const V3& up, float fade, V3 out[12])
{
	int i = (int)(fade * 4.0f);
	if (i > 3)
		i = 3;
	else if (i < 0)
		i = 0;
	// the offsets of each corner of each quad, in `right` and `up` units (right, up)
	static const float off[3][4][2] = {
		{{-2, -2}, {2, -2}, {2, 2}, {-2, 2}},
		{{0, -2}, {-4, -2}, {0, 2}, {4, 2}},
		{{0, 2}, {-4, 2}, {0, -2}, {4, -2}},
	};
	for (int q = 0; q < 3; q++)
		for (int k = 0; k < 4; k++)
		{
			int j = i + k;
			if (j > 3)
				j -= 4;
			out[q * 4 + j] = origin + right * off[q][k][0] + up * off[q][k][1];
		}
}
// re:1531-1534: where the flame is: the exhaust's attachment plus a frame's travel (attachments are a frame late).
inline V3 FlameOrigin(const V3& attachment0, const V3& vel, float frametime) { return attachment0 + vel * frametime; }

// ---- the reverse and brake keys as the lamps and the gate see them -------------------------------------------------------------------------

// in:868-962 CL_CreateMove. The back key gives g_braking 1 first; then on the ground, when the horizontal speed is under 40 and the back key is down
// and the forward key is not, it is reversing (g_reversing 1 or 2) and not braking. In the air neither is touched, so they stay as they were.
struct KeyLamp
{
	bool braking, reversing;
	KeyLamp() : braking(false), reversing(false) {}
};
inline void KeyLampStep(KeyLamp& s, bool back, bool forward, bool onGround, float speed2D)
{
	s.braking = back; // g_braking = key
	bool isReverse = speed2D < 40.0f && back;
	if (forward)
		isReverse = false;
	if (onGround)
	{
		if (isReverse)
		{
			s.braking = false;
			s.reversing = true;
		}
		else
			s.reversing = false;
	}
}

} // namespace rallyfx
