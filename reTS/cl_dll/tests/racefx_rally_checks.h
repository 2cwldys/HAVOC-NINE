// The rally effects' checks (h9_rallyfx_calc.h), included by racefx_test.cpp after its CHECK macro. Every expected number is HL Rally's, from the
// line named beside it ("re" cl_dll/Rally_Effects.cpp, "en" cl_dll/entity.cpp, "in" cl_dll/input.cpp of the HL Rally source).
#pragma once

#include "../h9_rallyfx_calc.h"

#include <stdio.h>

namespace rallychecks
{

using rallyfx::V3;

// Fixed "random": Long gives the upper end (or the lower when `low`), Float the middle.
struct FixedRng : rallyfx::Rng
{
	bool low;
	long forced; // when >= 0, Long returns this
	int calls;
	FixedRng() : low(false), forced(-1), calls(0) {}
	long Long(long lo, long hi) override
	{
		calls++;
		if (forced >= 0)
			return forced;
		return low ? lo : hi;
	}
	float Float(float lo, float hi) override
	{
		calls++;
		return 0.5f * (lo + hi);
	}
};

// A flat ground at z = 0, the texture it says.
struct FlatWorld : rallyfx::SkidWorld
{
	const char* tex;
	int traces;
	FlatWorld() : tex("tarmac01"), traces(0) {}
	void Trace(const V3& from, const V3& to, V3& end, V3& normal) override
	{
		traces++;
		if (from.z >= 0.0f && to.z <= 0.0f)
		{
			end = V3(from.x, from.y, 0.0f);
			normal = V3(0, 0, 1);
		}
		else
		{
			end = to;
			normal = V3(0, 0, 0);
		}
	}
	const char* Texture(const V3&) override { return tex; }
};

inline bool Close(float a, float b, float eps = 1e-3f) { return fabsf(a - b) <= eps; }
inline bool CloseV(const V3& a, const V3& b, float eps = 1e-3f) { return Close(a.x, b.x, eps) && Close(a.y, b.y, eps) && Close(a.z, b.z, eps); }

inline void Run(int& failed, int& checked)
{
#define RCHECK(what) \
	do \
	{ \
		checked++; \
		if (!(what)) \
		{ \
			failed++; \
			printf("FAILED rally line %d: %s\n", __LINE__, #what); \
		} \
	} while (0)
	using namespace rallyfx;

	// ---- the frame rate: HL Rally's 99 -----------------------------------------------------------------------------------------------
	RCHECK(Close(Ticks(1.0f / 99.0f), 1.0f) && Close(Ticks(1.0f / 30.0f), 99.0f / 30.0f) && Ticks(0.0f) == 0.0f);

	// ---- which dust (re:690-757) -----------------------------------------------------------------------------------------------------
	{
		FixedRng r;
		DustSel s = DustSelect("DIRT1", false, 0, r); // lowered, then strstr "dirt": r_dirt, scale 0.9, alpha 0.6 (re:698-702)
		RCHECK(s.spr == SP_DIRT && Close(s.alpha, 0.6f) && Close(s.scaleMul, 0.9f));
		RCHECK(DustSelect("mud_2", false, 0, r).spr == SP_DIRT && DustSelect("cliff", false, 0, r).spr == SP_DIRT);
		s = DustSelect("Gras_01", false, 0, r); // r_grass, scale_mul 0.25, alpha 1 (re:703-708)
		RCHECK(s.spr == SP_GRASS && Close(s.scaleMul, 0.25f) && Close(s.alpha, 1.0f));
		s = DustSelect("roadgras", false, 0, r); // contains "gras": grass for the dust, though the mark is dirt's
		RCHECK(s.spr == SP_GRASS);
		s = DustSelect("DESERT3", false, 0, r); // r_sand, 0.9, alpha 1 (re:709-712)
		RCHECK(s.spr == SP_SAND && Close(s.scaleMul, 0.9f) && Close(s.alpha, 1.0f));
		RCHECK(DustSelect("sand1", false, 0, r).spr == SP_SAND);
		// snow: RandomLong(0, 10) > 4 gives dirt or snow at scale 0.0125 and alpha 1; else smoke at 1 and 0.25 (re:713-732)
		r.low = false; // Long = 10 each time: first test passes, second passes: dirt
		s = DustSelect("snow02", false, 0, r);
		RCHECK(s.spr == SP_DIRT && Close(s.scaleMul, 0.0125f) && Close(s.alpha, 1.0f));
		r.forced = 0; // 0 is not over 4: smoke
		s = DustSelect("snow02", false, 0, r);
		RCHECK(s.spr == SP_SMOKE && Close(s.scaleMul, 1.0f) && Close(s.alpha, 0.25f));
		struct Seq : Rng
		{
			int n;
			Seq() : n(0) {}
			long Long(long, long) override { return n++ == 0 ? 10 : 0; } // first passes, second does not: snow
			float Float(float a, float b) override { return 0.5f * (a + b); }
		} seq;
		s = DustSelect("snow", false, 0, seq);
		RCHECK(s.spr == SP_SNOW && Close(s.scaleMul, 0.0125f));
		// no texture class: nothing, unless skidding: smoke 0.65, alpha 0.4, with the traction loss alpha = 0.4 x loss + 0.1 capped at 0.4 (re:733-748)
		RCHECK(DustSelect("asphalt", false, 0, r).spr == SP_NONE);
		s = DustSelect("asphalt", true, 0, r);
		RCHECK(s.spr == SP_SMOKE && Close(s.scaleMul, 0.65f) && Close(s.alpha, 0.4f));
		RCHECK(Close(DustSelect("asphalt", true, 0.3f, r).alpha, 0.4f * 0.3f + 0.1f));
		RCHECK(Close(DustSelect("asphalt", true, 1.0f, r).alpha, 0.4f)); // 0.5 capped
		RCHECK(DustSelect(NULL, true, 0, r).spr == SP_NONE); // no texture under the car: no dust (re:683)
	}

	// ---- the puffs (re:761-820) ------------------------------------------------------------------------------------------------------
	{
		FixedRng r; // Long gives the top, Float 1.05
		const V3 o(100, 200, 50), f = Fwd(0), rt = Right(0), up = Up();
		const V3 vel(300, 0, 0);
		DustSel dirt = {SP_DIRT, 0.9f, 0.6f};
		DustPuff p[4];
		RCHECK(DustPuffs(dirt, true, false, 300.0f, true, o, f, rt, up, vel, r, p) == 4);
		// the points: up 1.5, 9 to the right, 19 back / 10 forward (re:773-779); yaw 0 has the right at -y
		RCHECK(CloseV(p[0].pos, V3(100 - 19, 200 - 9, 51.5f)));
		RCHECK(CloseV(p[1].pos, V3(100 - 19, 200 + 9, 51.5f)));
		RCHECK(CloseV(p[2].pos, V3(100 + 10, 200 - 9, 51.5f)));
		RCHECK(CloseV(p[3].pos, V3(100 + 10, 200 + 9, 51.5f)));
		// smoke_size = 300 x 0.002 x 1.05 = 0.63, x spr_scale_mul 0.9 (re:798-806, 811)
		RCHECK(Close(p[0].scale, 0.63f * 0.9f));
		// the velocity: v x 0.97 + RandomLong(v2D / -30, v2D / 30) = 291 + 10; z gets RandomLong(0, v2D / 10) = 30 (re:786-790)
		RCHECK(Close(p[0].vel.x, 300.0f * 0.97f + 10.0f) && Close(p[0].vel.y, 10.0f) && Close(p[0].vel.z, 30.0f));
		// life 1; the front wheels' is 0.75 and then 0.75 of that again, and their size 0.75 (re:809-813)
		RCHECK(Close(p[0].life, 1.0f) && Close(p[1].life, 1.0f) && Close(p[2].life, 0.75f) && Close(p[3].life, 0.5625f));
		RCHECK(Close(p[2].scale, 0.63f * 0.75f * 0.9f));
		RCHECK(Close(p[0].alpha, 0.6f) && p[0].spr == SP_DIRT);
		// another car: two puffs, life 0.6, scale mul 0.9 / 0.6, the velocity 0.85 and v2D / 20 (re:768-772, 791-795)
		RCHECK(DustPuffs(dirt, false, false, 300.0f, true, o, f, rt, up, vel, r, p) == 2);
		RCHECK(Close(p[0].life, 0.6f) && Close(p[0].scale, 0.63f * (0.9f / 0.6f)));
		RCHECK(Close(p[0].vel.x, 300.0f * 0.85f + 15.0f) && Close(p[0].vel.z, 20.0f));
		// the interior's record is made as another car's (re:768)
		RCHECK(DustPuffs(dirt, true, true, 300.0f, true, o, f, rt, up, vel, r, p) == 2);
		// none at 30 or under, none in the air (re:759)
		RCHECK(DustPuffs(dirt, true, false, 30.0f, true, o, f, rt, up, vel, r, p) == 0);
		RCHECK(DustPuffs(dirt, true, false, 300.0f, false, o, f, rt, up, vel, r, p) == 0);
		DustSel none = {SP_NONE, 0.9f, 1.0f};
		RCHECK(DustPuffs(none, true, false, 300.0f, true, o, f, rt, up, vel, r, p) == 0);
		// the size is held to 0.05..1.5 (re:798-806)
		RCHECK(Close(DustPuffs(dirt, true, false, 1000.0f, true, o, f, rt, up, V3(1000, 0, 0), r, p), 4.0f) && Close(p[0].scale, 1.5f * 0.9f));
	}

	// ---- the tempent's own update (en:660-695) -----------------------------------------------------------------------------------------
	{
		DustEnt e = {};
		e.scale = 0.5f;
		e.vel = V3(100, 0, 0);
		e.baseAmt = e.amt = 153; // 0.6 x 255
		DustUpdate(e, 1.0f); // the first update: the life left is the life
		RCHECK(Close(e.baseScale, 0.5f) && Close(e.life0, 1.0f) && CloseV(e.vel0, V3(100, 0, 0)));
		RCHECK(e.amt == 153 && CloseV(e.vel, V3(100, 0, 0)) && Close(e.scale, 0.01f));
		DustUpdate(e, 0.5f); // half the life left: the alpha, the speed by it; the scale 0.01 + (1 - 0.5) x 0.5
		RCHECK(e.amt == 76 && CloseV(e.vel, V3(50, 0, 0)) && Close(e.scale, 0.26f));
		DustUpdate(e, 0.0f);
		RCHECK(e.amt == 0 && Close(e.vel.x, 0.0f) && Close(e.scale, 0.51f));
		DustEnt o = {}; // another car's puff: life 0.6, the scale begins under the least and is held to it (en:688-689)
		o.scale = 0.9f;
		o.vel = V3(10, 0, 0);
		o.baseAmt = o.amt = 100;
		DustUpdate(o, 0.6f);
		RCHECK(Close(o.scale, 0.00125f));
		DustUpdate(o, 0.0f);
		RCHECK(Close(o.scale, 0.01f + 0.6f * 0.9f));
	}

	// ---- the skid mark's direction and texture (re:1396-1427, 1064-1068, 1100-1140) --------------------------------------------------------
	{
		float a[3];
		VecToAngles(V3(0, 500, 0), a);
		RCHECK(a[0] == 0.0f && a[1] == 90.0f);
		VecToAngles(V3(0, -500, 0), a);
		RCHECK(a[1] == 270.0f);
		VecToAngles(V3(500, 0, 100), a); // pitch atan(0.2) = 11.3 degrees, cut to 11
		RCHECK(a[0] == 11.0f && a[1] == 0.0f);
		VecToAngles(V3(500, 0, -100), a); // -11 + 360
		RCHECK(a[0] == 349.0f);
		VecToAngles(V3(0, 0, 5), a);
		RCHECK(a[0] == 90.0f && a[1] == 0.0f);
		// the direction of travel crossed with the ground: the car's right, whatever the heading (HL Rally's own: always the world's X)
		RCHECK(CloseV(SkidRight(V3(0, 500, 0), V3(0, 0, 1)), V3(1, 0, 0)));
		RCHECK(CloseV(SkidRight(V3(500, 0, 0), V3(0, 0, 1)), V3(0, -1, 0)));
		RCHECK(CloseV(SkidRight(V3(-300, -300, 0), V3(0, 0, 1)), V3(-0.70710678f, 0.70710678f, 0)));
		RCHECK(SkidTexOf("tarmac") == SKT_ROAD && SkidTexOf("ROADGRAS1") == SKT_DIRT && SkidTexOf("dirt") == SKT_DIRT && SkidTexOf("mud") == SKT_DIRT &&
			SkidTexOf("soil") == SKT_DIRT && SkidTexOf("3dmroad") == SKT_DIRT && SkidTexOf("Gras") == SKT_DIRT);
		RCHECK(SkidTexOf("sand") == SKT_SAND && SkidTexOf("desert") == SKT_SAND && SkidTexOf("snow") == SKT_SNOW);
		RCHECK(SkidTexOf("noskid_road") == SKT_NONE && SkidTexOf("noskidgras") == SKT_NONE); // noskid is looked for first
		RCHECK(SkidSpr(SKT_ROAD) == SP_SKID && SkidSpr(SKT_DIRT) == SP_SKID_DIRT && SkidSpr(SKT_SAND) == SP_SKID_SAND && SkidSpr(SKT_SNOW) == SP_SKID_SNOW);
	}

	// ---- the skid step (re:1004-1245) ------------------------------------------------------------------------------------------------
	{
		FlatWorld w;
		SkidState st;
		SkidQuad q[4];
		SkidInput in = {};
		in.origin = V3(0, 0, 0);
		in.yaw = 90.0f; // heading +Y: fwd (0,1,0), right (1,0,0)
		in.vel = V3(0, 300, 0);
		in.onGround = true;
		in.gear = 2;
		in.tractionLoss = true; // the gate: speed over 25 and traction lost
		// the first time through: nothing laid, even with the gate open, and the first-time flag drops (re:1226-1229)
		RCHECK(SkidStep(st, in, w, q) == 0 && !st.first && !st.skidding);
		// the back right corner has not moved 15: nothing
		in.origin = V3(0, 10, 0);
		RCHECK(SkidStep(st, in, w, q) == 0);
		in.origin = V3(0, 30, 0); // moved over 15 from the saved point
		RCHECK(SkidStep(st, in, w, q) == 4 && st.skidding);
		// the points: back right corner (-22 back, 12 right) = (12, 8), 7 forward and 3 left: (9, 15, 0) + (0, 30) -> (9, 15)... for origin y 30:
		// BACK_RIGHT = (12, 8); + fwd 7 = (12, 15); + right * -3 = (9, 15)
		RCHECK(CloseV(q[0].v[0], V3(9, 15, 0)));
		// BACK_LEFT = (-12, 8); + fwd 7 = (-12, 15); + right * 3 = (-9, 15)
		RCHECK(CloseV(q[1].v[0], V3(-9, 15, 0)));
		// FRONT_RIGHT = (12, 52); + fwd * -8.4 = (12, 43.6); + right * -3 = (9, 43.6)
		RCHECK(CloseV(q[2].v[0], V3(9, 43.6f, 0)));
		RCHECK(CloseV(q[3].v[0], V3(-9, 43.6f, 0)));
		// the second vertex of each is the last step's point (re:1171); the width goes along the angles' cross: X, 4 wide, the right wheels' one way
		RCHECK(CloseV(q[0].v[1], V3(9, -15, 0)) && CloseV(q[0].v[2], V3(9 - 4, -15, 0)));
		RCHECK(CloseV(q[0].v[3], q[0].v[0] + V3(-4, 0, 0)) && CloseV(q[1].v[3], q[1].v[0] + V3(4, 0, 0)));
		RCHECK(CloseV(q[2].v[3], q[2].v[0] + V3(-4, 0, 0)) && CloseV(q[3].v[3], q[3].v[0] + V3(4, 0, 0)));
		RCHECK(q[0].tex == SKT_ROAD);
		// driving along X: the width goes along Y, 4 wide as on any heading (HL Rally's own are lines here; not kept)
		SkidState sx;
		FlatWorld w2;
		in.yaw = 0.0f;
		in.vel = V3(300, 0, 0);
		in.origin = V3(0, 0, 0);
		SkidStep(sx, in, w2, q);
		in.origin = V3(40, 0, 0);
		RCHECK(SkidStep(sx, in, w2, q) == 4);
		RCHECK(CloseV(q[0].v[3], q[0].v[0] + V3(0, 4, 0)) && CloseV(q[1].v[3], q[1].v[0] + V3(0, -4, 0)));
		// no gate, no mark: nothing, and the position is kept (re:1226-1240)
		SkidState sg;
		in.gear = 0; // MarkGate: gear 0 gives none
		in.origin = V3(0, 0, 0);
		SkidStep(sg, in, w2, q);
		in.origin = V3(40, 0, 0);
		const int n0 = SkidStep(sg, in, w2, q);
		RCHECK(n0 == 0 && !sg.skidding && CloseV(sg.last[0], V3(25, -9, 0)));
		// the gate is the squeal's: the same answer for the same inputs
		in.gear = 2;
		in.tractionLoss = false;
		in.vel = V3(300, 0, 0);
		in.accelerating = 0;
		in.braking = false;
		in.handbraking = false;
		in.origin = V3(80, 0, 0);
		SkidState sh;
		SkidStep(sh, in, w2, q);
		in.origin = V3(120, 0, 0);
		RCHECK(rallysnd::MarkGate(true, false, 2, 300.0f, 0, false, false, false, 1.0f - 1.0f, false) == (SkidStep(sh, in, w2, q) == 4));
		in.handbraking = true;
		in.origin = V3(160, 0, 0);
		RCHECK(SkidStep(sh, in, w2, q) == 4); // the handbrake above 25
		in.vel = V3(10, 0, 0);
		in.origin = V3(200, 0, 0);
		RCHECK(SkidStep(sh, in, w2, q) == 0 && !sh.skidding); // under 20: no skidding at all (re:1009-1013)
		// a noskid texture: nothing laid, skidding true, the positions not kept (re:1118-1119)
		SkidState sn;
		FlatWorld wn;
		wn.tex = "NOSKID_road";
		in.vel = V3(0, 300, 0);
		in.yaw = 90.0f;
		in.handbraking = true;
		in.origin = V3(0, 0, 0);
		SkidStep(sn, in, wn, q);
		const V3 keep = sn.last[0];
		in.origin = V3(0, 40, 0);
		RCHECK(SkidStep(sn, in, wn, q) == 0 && sn.skidding && CloseV(sn.last[0], keep));
		// the texture of a mark is by the surface: dirt
		SkidState sd;
		FlatWorld wd;
		wd.tex = "dirt_road1";
		in.origin = V3(0, 0, 0);
		SkidStep(sd, in, wd, q);
		in.origin = V3(0, 40, 0);
		RCHECK(SkidStep(sd, in, wd, q) == 4 && q[0].tex == SKT_DIRT);
	}

	// ---- the mark list (re:299-337) ----------------------------------------------------------------------------------------------------
	{
		SkidList<8> l;
		SkidQuad q;
		for (int i = 0; i < 4; i++)
			q.v[i] = V3((float)i, 0, 0);
		q.tex = SKT_ROAD;
		l.Push(q, 100.0f, kSkidLife); // 45 s
		RCHECK(l.count == 1 && Close(l.At(0).die, 145.0f));
		l.Purge(144.9f, V3(0, 0, 0));
		RCHECK(l.count == 1); // no fade: it is whole until its time
		l.Purge(145.1f, V3(0, 0, 0));
		RCHECK(l.count == 0);
		l.Push(q, 100.0f, kSkidLife);
		l.Purge(101.0f, V3(3500, 0, 0)); // 3000 units from the player: let go (re:305)
		RCHECK(l.count == 0);
		l.Push(q, 100.0f, 0.0f); // a life of 0: it never goes
		l.Purge(100000.0f, V3(0, 0, 0));
		RCHECK(l.count == 1);
		for (int i = 0; i < 20; i++)
			l.Push(q, 100.0f, kSkidLife);
		RCHECK(l.count == 8); // full: the oldest goes
	}

	// ---- the brake and reverse lamps (re:1252-1450) ----------------------------------------------------------------------------------------
	{
		LampState s;
		const float dt = 1.0f / 99.0f; // HL Rally's frame
		RCHECK(!LampStep(s, false, false, dt) && s.brightness == 0.0f); // nothing lit, nothing drawn
		RCHECK(LampStep(s, true, false, dt) && Close(s.brightness, 0.06f) && s.wasBraking); // +0.06 a frame (re:1297-1301)
		for (int i = 0; i < 20; i++)
			LampStep(s, true, false, dt);
		RCHECK(Close(s.brightness, 0.6f)); // capped at 0.6
		for (int i = 0; i < 7; i++)
			RCHECK(LampStep(s, false, false, dt)); // -0.08 a frame
		RCHECK(Close(s.brightness, 0.6f - 7 * 0.08f, 1e-3f));
		RCHECK(LampStep(s, false, false, dt) && s.brightness == 0.0f); // the last frame, at 0
		RCHECK(!LampStep(s, false, false, dt)); // then none
		RCHECK(s.wasBraking); // the colour stays red until the reverse key
		LampStep(s, false, true, dt); // reversing: the colour is the reverse lamps'
		RCHECK(!s.wasBraking && Close(s.brightness, 0.06f));
		LampStep(s, true, true, dt); // both: reversing wins (re:1281-1286)
		RCHECK(!s.wasBraking);
		// time-based: 0.1 s of braking from 10 ms frames or from 33 ms frames rises the same, and a long frame is capped
		LampState a, b;
		for (int i = 0; i < 10; i++)
			LampStep(a, true, false, 0.01f);
		for (int i = 0; i < 3; i++)
			LampStep(b, true, false, 0.0333333f);
		RCHECK(Close(a.brightness, 0.594f, 0.003f) && Close(b.brightness, 0.594f, 0.003f));
		LampState c;
		LampStep(c, true, false, 1.0f);
		RCHECK(Close(c.brightness, 0.6f));
		// the geometry: the xsara's numbers (carinfo.txt), yaw 0 (fwd +x, right -y)
		const LampDims d = LampXsara();
		RCHECK(Close(d.dst, 21.165f) && Close(d.width, 5.373f) && Close(d.height, 9.62f));
		const Lamps g = LampGeometry(V3(0, 0, 0), Fwd(0), Right(0), Up(), d, true);
		RCHECK(CloseV(g.q[0].v[0], V3(-21.165f, -5.373f, 9.62f)));
		RCHECK(CloseV(g.q[0].v[1], V3(-21.165f, -5.373f, 9.62f * 0.8f)));
		RCHECK(CloseV(g.q[0].v[2], V3(-21.165f, -5.373f * 1.4f, 9.62f * 0.8f)));
		RCHECK(CloseV(g.q[0].v[3], V3(-21.165f, -5.373f * 1.4f, 9.62f)));
		RCHECK(CloseV(g.q[1].v[0], V3(-21.165f, 5.373f, 9.62f)) && CloseV(g.q[1].v[3], V3(-21.165f, 5.373f * 1.4f, 9.62f)));
		RCHECK(CloseV(g.elight[0], g.q[0].v[3]) && CloseV(g.elight[1], g.q[1].v[3]));
		const Lamps rv = LampGeometry(V3(0, 0, 0), Fwd(0), Right(0), Up(), d, false); // reverse lamps at 0.92 of the width
		RCHECK(Close(rv.q[0].v[0].y, -5.373f * 0.92f));
		const LampColour red = LampColourFor(true, 0.5f), wh = LampColourFor(false, 0.5f);
		RCHECK(Close(red.r, 1.0f) && Close(red.g, 0.1f) && Close(red.b, 0.1f) && red.lr == 120 && red.lg == 2 && red.lb == 2);
		RCHECK(Close(wh.r, 0.9f) && Close(wh.g, 0.9f) && Close(wh.b, 1.0f) && wh.lr == 100 && wh.lg == 100 && wh.lb == 100);
		RCHECK(Close(kElightRadius, 2.0f));
	}

	// ---- the keys the lamps read (in:868-962) --------------------------------------------------------------------------------------------
	{
		KeyLamp k;
		KeyLampStep(k, true, false, true, 10.0f); // back key, slow, on the ground: reversing, not braking
		RCHECK(k.reversing && !k.braking);
		KeyLampStep(k, true, false, true, 100.0f); // back key at speed: braking
		RCHECK(!k.reversing && k.braking);
		KeyLampStep(k, true, true, true, 10.0f); // the forward key too: not reversing
		RCHECK(!k.reversing && k.braking);
		KeyLampStep(k, true, false, true, 10.0f);
		KeyLampStep(k, true, false, false, 10.0f); // in the air: braking = the key, reversing as it was
		RCHECK(k.reversing && k.braking);
		KeyLampStep(k, false, false, true, 10.0f); // released on the ground
		RCHECK(!k.reversing && !k.braking);
	}

	// ---- the headlights (re:1452-1489) ----------------------------------------------------------------------------------------------------
	{
		HeadState h;
		const float dt = 1.0f / 99.0f;
		RCHECK(!HeadStep(h, dt)); // off, dark: none
		h.on = true;
		for (int i = 0; i < 5; i++)
			HeadStep(h, dt);
		RCHECK(Close(h.brightness, 0.5f, 1e-3f)); // +0.1 a frame
		for (int i = 0; i < 20; i++)
			HeadStep(h, dt);
		RCHECK(Close(h.brightness, 1.0f));
		h.on = false;
		for (int i = 0; i < 4; i++)
			HeadStep(h, dt);
		RCHECK(Close(h.brightness, 0.6f, 1e-3f) && HeadStep(h, dt)); // -0.1 a frame, still made while it fades
		HeadState h2;
		h2.on = true;
		HeadStep(h2, 1.0f / 30.0f);
		RCHECK(Close(h2.brightness, 0.33f, 1e-3f)); // a slower frame goes further: time-based
		unsigned char c[3];
		HeadColour(1.0f, c);
		RCHECK(c[0] == 160 && c[1] == 160 && c[2] == 150);
		HeadColour(0.5f, c);
		RCHECK(c[0] == 80 && c[1] == 80 && c[2] == 75);
		RCHECK(CloseV(HeadOrigin(V3(0, 0, 0), Fwd(90), Right(90), Up()), V3(1, 195, 1)));
		RCHECK(Close(kHeadRadius, 220.0f));
	}

	// ---- the shadow (re:828-955) ---------------------------------------------------------------------------------------------------------
	{
		const V3 o(0, 0, 0);
		ShadowCorners c = ShadowRect(o, Fwd(0), Right(0), true, 0.0f);
		RCHECK(Close((c.c[2] - c.c[1]).Length(), 24.0f) && Close((c.c[1] - c.c[0]).Length(), 44.0f)); // 44 x 24
		RCHECK(CloseV(c.c[0], V3(22, 12, 0)) && CloseV(c.c[2], V3(-22, -12, 0)));
		c = ShadowRect(o, Fwd(0), Right(0), false, 50.0f); // in the air: height / 5 along, height / 10 across, each side
		RCHECK(Close((c.c[1] - c.c[0]).Length(), 44.0f - 2.0f * 10.0f) && Close((c.c[2] - c.c[1]).Length(), 24.0f - 2.0f * 5.0f));
		FlatWorld w;
		ShadowVert v[kShadowMaxVerts];
		c = ShadowRect(o, Fwd(0), Right(0), true, 0.0f);
		int n = ShadowGrid(c, Fwd(0), Right(0), 4, w, v, kShadowMaxVerts);
		RCHECK(n == 4 * 4 * 4); // 4 x 4 quads
		RCHECK(w.traces == 4 * (2 + 2 * 4)); // a strip: two on its left edge and a pair for each of its 4 steps
		RCHECK(v[0].u == 0.0f && v[0].v == 0.0f && Close(v[1].v, 0.25f));
		RCHECK(Close(v[0].p.z, 0.0f) && Close(v[3].p.z, 0.1f)); // the left edge's end points as traced, the others 0.1 over
		RCHECK(Close(v[n - 2].u, 1.0f) && Close(v[n - 2].v, 1.0f)); // the last corner
		RCHECK(ShadowGrid(c, Fwd(0), Right(0), 99, w, v, kShadowMaxVerts) == kShadowMaxDiv * kShadowMaxDiv * 4);
		RCHECK(ShadowGrid(c, Fwd(0), Right(0), 0, w, v, kShadowMaxVerts) == 0);
	}

	// ---- the exhaust flame (re:1537-1640) ------------------------------------------------------------------------------------------------
	{
		V3 q[12];
		const V3 o(10, 20, 30), r(0, -1, 0), u(0, 0, 1);
		FlameQuads(o, r, u, 0.1f, q); // fade 0.1: i = 0, no turn
		RCHECK(CloseV(q[0], o + r * -2 + u * -2) && CloseV(q[1], o + r * 2 + u * -2) && CloseV(q[2], o + r * 2 + u * 2) && CloseV(q[3], o + r * -2 + u * 2));
		RCHECK(CloseV(q[4], o + u * -2) && CloseV(q[5], o + r * -4 + u * -2) && CloseV(q[6], o + u * 2) && CloseV(q[7], o + r * 4 + u * 2));
		RCHECK(CloseV(q[8], o + u * 2) && CloseV(q[9], o + r * -4 + u * 2) && CloseV(q[10], o + u * -2) && CloseV(q[11], o + r * 4 + u * -2));
		FlameQuads(o, r, u, 1.0f, q); // fade 1: int(4) clamped to 3: the corners turn by three places
		RCHECK(CloseV(q[3], o + r * -2 + u * -2) && CloseV(q[0], o + r * 2 + u * -2) && CloseV(q[1], o + r * 2 + u * 2) && CloseV(q[2], o + r * -2 + u * 2));
		FlameQuads(o, r, u, 0.6f, q); // int(2.4) = 2
		RCHECK(CloseV(q[2], o + r * -2 + u * -2) && CloseV(q[3], o + r * 2 + u * -2) && CloseV(q[0], o + r * 2 + u * 2) && CloseV(q[1], o + r * -2 + u * 2));
		RCHECK(CloseV(FlameOrigin(V3(1, 2, 3), V3(100, 0, 0), 0.01f), V3(2, 2, 3))); // the attachment plus a frame's travel
		// the flame's fade comes from the sound's window (rallysnd::BackfireFrame): 1 at the start, 0 at 0.15 s
		rallysnd::Backfire b;
		rallysnd::BackfireRaise(b, 1);
		float fade = 0;
		rallysnd::BackfireFrame(b, 10.0f, fade);
		RCHECK(Close(fade, 1.0f));
		rallysnd::BackfireFrame(b, 10.075f, fade);
		RCHECK(Close(fade, 0.5f, 1e-3f));
		rallysnd::BackfireFrame(b, 10.2f, fade);
		RCHECK(fade == 0.0f);
	}

	// ---- the sprite names ---------------------------------------------------------------------------------------------------------------
	RCHECK(0 == strcmp(SprBase(SP_SKID), "r_skid") && 0 == strcmp(SprBase(SP_FLARE), "flare3") && 0 == strcmp(SprBase(SP_FLASH), "muzzleflash3") &&
		0 == strcmp(SprBase(SP_SHADOW), "r_shadow") && 0 == strcmp(SprBase(SP_SMOKE), "r_smoke"));
#undef RCHECK
}

} // namespace rallychecks
