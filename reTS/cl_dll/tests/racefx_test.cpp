// Checks the race effects' arithmetic (h9_racefx_calc.h) with no game: which surface and state leaves which mark and which spray,
// where a mark's segments go for a car driven in a circle (spacing, width, under the right wheels, none in the air), the ring's
// wrap, the fade's end, the speed from positions, the shadow, the brake lights and the budgets.
//   cmake --build <dir> --target racefx_test --config Release, then run racefx_test
#include "../h9_racefx_calc.h"
#include "racefx_rally_checks.h"

#include <stdio.h>
#include <math.h>

using namespace racefx;

static int g_failed = 0, g_checked = 0;
#define CHECK(what) \
	do \
	{ \
		g_checked++; \
		if (!(what)) \
		{ \
			g_failed++; \
			printf("FAILED line %d: %s\n", __LINE__, #what); \
		} \
	} while (0)

static bool Near(float a, float b, float eps) { return fabsf(a - b) <= eps; }

// a flat ground at z = 0, and a slope that rises along x
struct Flat : Ground
{
	int calls;
	Flat() : calls(0) {}
	bool Down(const V3& from, V3& hit, V3& n) override
	{
		calls++;
		hit = V3(from.x, from.y, 0);
		n = V3(0, 0, 1);
		return true;
	}
};
struct Slope : Ground // z = 0.5 x, normal (-0.5, 0, 1) normalised
{
	bool Down(const V3& from, V3& hit, V3& n) override
	{
		hit = V3(from.x, from.y, 0.5f * from.x);
		const float l = sqrtf(1.25f);
		n = V3(-0.5f / l, 0, 1.0f / l);
		return true;
	}
};
struct Pit : Ground // no ground below x > 1000 (a drop to the void)
{
	bool Down(const V3& from, V3& hit, V3& n) override
	{
		if (from.x > 1000)
			return false;
		hit = V3(from.x, from.y, 0);
		n = V3(0, 0, 1);
		return true;
	}
};

static Dims FullCar() { return DimsFromBounds(V3(-90, -40, 0), V3(121, 40, 50)); } // 211 long
static Dims SmallCar() { return DimsFromBounds(V3(-36, -16, 0), V3(48.4f, 16, 20)); } // 0.4 of it

struct Drive
{
	int segs;
	float minGap, maxGap, minW, maxW;
	float maxRadiusErr; // of the segments' end middles from the rear wheel's circle
	float maxLenErr;
	int rejected;
};

// A car driven round a circle of radius R (centre of the car's origin), the nose along the tangent, `steps` frames; for each
// rear wheel (wheel index w) the segments are checked to lie where that wheel runs.
static Drive Circle(const Dims& d, Ground& g, const MarkLook& look, float R, float lenPerFrame, int steps, int wheel, int flagsAir)
{
	Drive r;
	r.segs = 0;
	r.minGap = 1e9f;
	r.maxGap = 0;
	r.minW = 1e9f;
	r.maxW = 0;
	r.maxRadiusErr = 0;
	r.maxLenErr = 0;
	r.rejected = 0;
	WheelTrail t;
	const float spacing = 0.25f * d.len;
	const float halfW = 0.5f * 1.3f * d.tyreW * look.widthScale;
	V3 lastMid;
	bool haveMid = false;
	for (int i = 0; i < steps; i++)
	{
		const float ang = (float)i * lenPerFrame / R; // radians on the circle
		const V3 origin(R * cosf(ang), R * sinf(ang), 0);
		const float yaw = (ang + 3.14159265f / 2) * 180.0f / 3.14159265f; // the tangent, anticlockwise
		const V3 wp = LocalToWorld(origin, yaw, WheelLocal(d, wheel));
		if (flagsAir)
		{
			t.Break();
			continue;
		}
		Seg s;
		if (!PlaceSegment(t, wp, g, spacing, halfW, 0.5f, 10.0f, 25.0f, look, s))
			continue;
		r.segs++;
		const V3 mid = (s.c[0] + s.c[2]) * 0.5f; // the end's middle
		// the wheel's circle: the wheel's own distance from the circle's centre
		const V3 w0 = LocalToWorld(V3(R, 0, 0), 90.0f, WheelLocal(d, wheel));
		const float rw = sqrtf(w0.x * w0.x + w0.y * w0.y);
		const float rm = sqrtf(mid.x * mid.x + mid.y * mid.y);
		const float err = fabsf(rm - rw);
		r.maxRadiusErr = err > r.maxRadiusErr ? err : r.maxRadiusErr;
		const float w = (s.c[1] - s.c[2]).Length(), w2 = (s.c[0] - s.c[3]).Length();
		for (int k = 0; k < 2; k++)
		{
			const float ww = k == 0 ? w : w2;
			r.minW = ww < r.minW ? ww : r.minW;
			r.maxW = ww > r.maxW ? ww : r.maxW;
		}
		if (haveMid)
		{
			const float gap = (mid - lastMid).Length();
			r.minGap = gap < r.minGap ? gap : r.minGap;
			r.maxGap = gap > r.maxGap ? gap : r.maxGap;
		}
		lastMid = mid;
		haveMid = true;
		// each segment's own start touches the last one's end: a ribbon, no gap
		(void)w2;
		if ((s.c[0] - s.c[3]).Length() < 1e-3f)
			r.rejected++;
	}
	return r;
}

int main()
{
	// ---- the car's size from its bounds -----------------------------------------------------------------------------------------
	{
		const Dims d = FullCar(), s = SmallCar();
		CHECK(d.ok && s.ok);
		CHECK(Near(d.len, 211, 1e-3f) && Near(d.width, 80, 1e-3f));
		CHECK(Near(d.tyreW, 0.12f * 80, 1e-3f));
		CHECK(Near(s.len / d.len, 0.4f, 0.01f));
		// the small car's tyres and axles are the full car's, scaled
		CHECK(Near(s.tyreW / d.tyreW, 0.4f, 0.01f));
		CHECK(Near(s.halfTrack / d.halfTrack, 0.4f, 0.02f));
		CHECK(!DimsFromBounds(V3(0, 0, 0), V3(0, 0, 0)).ok);   // a model with no bounds: no car
		CHECK(!DimsFromBounds(V3(0, 0, 0), V3(1e6f, 40, 40)).ok);
		// the wheels: rear ones behind the front ones, left and right either side, the tyre's outer side at the body's side
		const V3 rl = WheelLocal(d, W_RL), rr = WheelLocal(d, W_RR), fl = WheelLocal(d, W_FL);
		CHECK(rl.x < fl.x && Near(rl.x, rr.x, 1e-4f));
		CHECK(rl.y > 0 && rr.y < 0 && Near(rl.y, -rr.y, 1e-4f));
		CHECK(Near(rl.y + 0.5f * d.tyreW, 0.5f * d.width, 1e-3f));
		// yaw 90 puts the nose along +Y
		const V3 w = LocalToWorld(V3(10, 20, 3), 90.0f, V3(5, 0, 0));
		CHECK(Near(w.x, 10, 1e-3f) && Near(w.y, 25, 1e-3f) && Near(w.z, 3, 1e-3f));
	}

	// ---- the speed from positions ------------------------------------------------------------------------------------------------
	{
		CHECK(Near(SpeedFrom(V3(0, 0, 0), V3(3, 4, 99), 0.5f), 10.0f, 1e-3f)); // along the plane
		CHECK(SpeedFrom(V3(0, 0, 0), V3(3, 4, 0), 0.0f) == 0.0f);                // paused
		CHECK(SpeedFrom(V3(0, 0, 0), V3(3, 4, 0), -1.0f) == 0.0f);
	}

	// ---- which surface and state gives which mark -----------------------------------------------------------------------------------
	{
		// tarmac: nothing while the tyres grip, rubber while sliding, braking hard or on the handbrake
		CHECK(MarkFor(SURF_TARMAC, 0.1f, 0, 1.0f, 0).kind == MK_NONE);
		CHECK(MarkFor(SURF_TARMAC, 0.6f, 0, 1.0f, 0).kind == MK_RUBBER);
		CHECK(MarkFor(SURF_TARMAC, 0.0f, BIT_BRAKE, 1.0f, 0).kind == MK_RUBBER);
		CHECK(MarkFor(SURF_TARMAC, 0.0f, BIT_HAND, 1.0f, 0).kind == MK_RUBBER);
		CHECK(MarkFor(SURF_TARMAC, 0.0f, BIT_BRAKE, 0.1f, 0).kind == MK_NONE); // crawling: no
		CHECK(MarkFor(SURF_TARMAC, 0.9f, 0, 0.0f, 0).kind == MK_NONE);        // standing: no
		CHECK(MarkFor(SURF_TARMAC, 0.9f, 0, 1.0f, 0).alpha > MarkFor(SURF_TARMAC, 0.3f, 0, 1.0f, 0).alpha);
		CHECK(!MarkFor(SURF_TARMAC, 0.6f, 0, 1.0f, 0).allWheels);
		// gravel, dirt, grass: ruts while sliding, or pulling away from low speed
		CHECK(MarkFor(SURF_GRAVEL, 0.0f, 0, 1.0f, 0).kind == MK_NONE);
		CHECK(MarkFor(SURF_GRAVEL, 0.5f, 0, 1.0f, 0).kind == MK_RUT);
		CHECK(MarkFor(SURF_DIRT, 0.0f, 0, 0.5f, 1.0f).kind == MK_RUT);
		CHECK(MarkFor(SURF_GRASS, 0.0f, 0, 3.0f, 1.0f).kind == MK_NONE); // fast and not sliding: no
		CHECK(MarkFor(SURF_GRAVEL, 0.5f, 0, 1.0f, 0).alpha < MarkFor(SURF_SNOW, 0.0f, 0, 1.0f, 0).alpha); // fainter than snow
		// snow: always, on the ground, moving; the four tyres
		const MarkLook sn = MarkFor(SURF_SNOW, 0.0f, 0, 0.5f, 0);
		CHECK(sn.kind == MK_SNOW && sn.allWheels);
		CHECK(MarkFor(SURF_SNOW, 0.0f, 0, 0.0f, 0).kind == MK_NONE); // standing still: none
		// ice: thin pale scratches while sliding
		CHECK(MarkFor(SURF_ICE, 0.1f, 0, 1.0f, 0).kind == MK_NONE);
		const MarkLook ic = MarkFor(SURF_ICE, 0.6f, 0, 1.0f, 0);
		CHECK(ic.kind == MK_SCRATCH && ic.pale && ic.widthScale < 0.5f);
		// none in the air, none in water, on any surface
		for (int s = 0; s < 7; s++)
		{
			CHECK(MarkFor(s, 1.0f, BIT_AIR | BIT_BRAKE | BIT_HAND, 2.0f, 1.0f).kind == MK_NONE);
			if (s == SURF_WATER)
				CHECK(MarkFor(s, 1.0f, BIT_BRAKE, 2.0f, 1.0f).kind == MK_NONE);
		}
		CHECK(SurfaceOf(5 | BIT_AIR | BIT_HAND) == SURF_SNOW);
		CHECK(Near(SlipOf(255), 1.0f, 1e-6f) && SlipOf(0) == 0.0f);
	}

	// ---- a car driven in a circle on snow ---------------------------------------------------------------------------------------------
	{
		const Dims d = FullCar();
		const MarkLook look = MarkFor(SURF_SNOW, 0.0f, 0, 1.0f, 0);
		const float R = 4.0f * d.len;
		const float step = 0.01f * d.len; // a frame's travel, well under the spacing (a segment is laid at the first frame past it)
		const int frames = (int)(2.0f * 3.14159265f * R / step) + 1; // one full lap
		Flat g;
		const float tyreHalf = 0.5f * 1.3f * d.tyreW;
		for (int wheel = 0; wheel < 4; wheel++)
		{
			Drive r = Circle(d, g, look, R, step, frames, wheel, 0);
			// a lap of the wheel's circle, a segment each quarter length
			const V3 w0 = LocalToWorld(V3(R, 0, 0), 90.0f, WheelLocal(d, wheel));
			const float rw = sqrtf(w0.x * w0.x + w0.y * w0.y);
			const float expect = 2.0f * 3.14159265f * rw / (0.25f * d.len);
			CHECK(r.segs >= (int)expect - 3 && r.segs <= (int)expect + 3);
			CHECK(r.maxRadiusErr < 0.01f * R);                          // under the wheel
			CHECK(Near(r.minW, 2 * tyreHalf, 0.01f) && Near(r.maxW, 2 * tyreHalf, 0.01f)); // the tyre's width (times the soft edge's 1.3)
			CHECK(r.minGap > 0.24f * d.len && r.maxGap < 0.28f * d.len); // a segment every quarter length
		}
		// the ground is asked once a segment, not once a frame
		g.calls = 0;
		Circle(d, g, look, R, step, frames, W_RL, 0);
		CHECK(g.calls < frames / 3);
		// in the air: none at all
		Flat g2;
		Drive air = Circle(d, g2, look, R, step, frames, W_RL, 1);
		CHECK(air.segs == 0 && g2.calls == 0);
	}
	// the same circle with the small car: the same count, the quarter length of its own length
	{
		const Dims d = SmallCar(), big = FullCar();
		const MarkLook look = MarkFor(SURF_SNOW, 0.0f, 0, 1.0f, 0);
		const float R = 4.0f * d.len;
		const float step = 0.01f * d.len;
		const int frames = (int)(2.0f * 3.14159265f * R / step) + 1;
		Flat g;
		Drive r = Circle(d, g, look, R, step, frames, W_RR, 0);
		CHECK(r.segs > 40);
		CHECK(Near(r.minW, 0.4f * 2 * 0.5f * 1.3f * big.tyreW, 0.05f));
	}

	// ---- a mark on a slope follows it, lifted along the normal ------------------------------------------------------------------------
	{
		const Dims d = FullCar();
		Slope g;
		WheelTrail t;
		const MarkLook look = MarkFor(SURF_SNOW, 0.0f, 0, 1.0f, 0);
		Seg s;
		bool got = false;
		for (int i = 0; i < 40 && !got; i++)
			got = PlaceSegment(t, V3((float)i * 10.0f, 0, 0), g, 0.25f * d.len, 5.0f, 0.5f, 1.0f, 25.0f, look, s);
		CHECK(got);
		bool onSlope = true;
		for (int k = 0; k < 4; k++)
		{
			// the corner is above the slope by 0.5 along the normal (and a little more up for the width's own slope: none, it is across)
			const V3 c = s.c[k];
			const float l = sqrtf(1.25f);
			const V3 n(-0.5f / l, 0, 1.0f / l);
			const float h = (c - V3(c.x, c.y, 0.5f * c.x)).Dot(n); // distance to the plane along its normal
			onSlope = onSlope && Near(h, 0.5f, 1e-3f);
		}
		CHECK(onSlope);
		CHECK(Near(s.n.z, 1.0f / sqrtf(1.25f), 1e-4f));
	}

	// ---- a drop to nothing breaks the mark; the next one starts afresh ----------------------------------------------------------------
	{
		Pit g;
		WheelTrail t;
		const MarkLook look = MarkFor(SURF_SNOW, 0.0f, 0, 1.0f, 0);
		Seg s;
		int n = 0;
		for (int i = 0; i < 100; i++)
			if (PlaceSegment(t, V3((float)i * 20.0f, 0, 0), g, 40.0f, 5.0f, 0.5f, 1.0f, 25.0f, look, s))
			{
				n++;
				CHECK(s.c[1].x <= 1000.5f + 20.0f);
			}
		CHECK(n > 10 && !t.have); // the last frames were over the pit: the trail is broken
		// a jump of many spacings starts a new mark, not a streak across the map
		Flat f;
		WheelTrail t2;
		PlaceSegment(t2, V3(0, 0, 0), f, 10.0f, 5.0f, 0.5f, 1.0f, 25.0f, look, s);
		PlaceSegment(t2, V3(5, 0, 0), f, 10.0f, 5.0f, 0.5f, 1.0f, 25.0f, look, s);
		CHECK(!PlaceSegment(t2, V3(5000, 0, 0), f, 10.0f, 5.0f, 0.5f, 1.0f, 25.0f, look, s));
		CHECK(PlaceSegment(t2, V3(5020, 0, 0), f, 10.0f, 5.0f, 0.5f, 1.0f, 25.0f, look, s));
		CHECK(s.c[0].x > 4000); // starting at the new place
	}

	// ---- the ring wraps, oldest first -----------------------------------------------------------------------------------------------------
	{
		static Ring<Seg, 1500> ring; // the game's size
		for (int i = 0; i < 1500; i++)
			ring.Push().born = (float)i;
		CHECK(ring.count == 1500 && ring.At(0).born == 0 && ring.At(1499).born == 1499);
		ring.Push().born = 1500; // overwrites the oldest
		CHECK(ring.count == 1500 && ring.At(0).born == 1 && ring.At(1499).born == 1500);
		for (int i = 0; i < 4000; i++)
			ring.Push().born = (float)(2000 + i);
		CHECK(ring.count == 1500 && ring.At(0).born == 2000 + 4000 - 1500 && ring.At(1499).born == 2000 + 3999);
		ring.Clear();
		CHECK(ring.count == 0);
	}

	// ---- the fade -------------------------------------------------------------------------------------------------------------------
	{
		CHECK(FadeFactor(0, 25, 8) == 1.0f);
		CHECK(FadeFactor(16.9f, 25, 8) == 1.0f);
		CHECK(Near(FadeFactor(21, 25, 8), 0.5f, 1e-5f));
		CHECK(FadeFactor(25, 25, 8) == 0.0f);
		CHECK(FadeFactor(30, 25, 8) == 0.0f);
		CHECK(FadeFactor(-1, 25, 8) == 0.0f); // born in the future (the clock went back)
		float prev = 2.0f;
		bool mono = true;
		for (float a = 0; a < 25; a += 0.25f)
		{
			const float f = FadeFactor(a, 25, 8);
			mono = mono && f <= prev + 1e-6f;
			prev = f;
		}
		CHECK(mono);
	}

	// ---- the spray ----------------------------------------------------------------------------------------------------------------------
	{
		CHECK(SprayFor(SURF_GRAVEL, 0.5f, 0, 1.5f).kind == SP_DUST);
		CHECK(SprayFor(SURF_DIRT, 0.5f, 0, 1.5f).kind == SP_DUST);
		CHECK(SprayFor(SURF_GRAVEL, 0.5f, 0, 1.5f).r > SprayFor(SURF_GRAVEL, 0.5f, 0, 1.5f).b); // tan
		CHECK(SprayFor(SURF_GRAVEL, 0.9f, 0, 1.5f).rate > SprayFor(SURF_GRAVEL, 0.1f, 0, 1.5f).rate); // with the slide
		CHECK(SprayFor(SURF_GRAVEL, 0.5f, 0, 2.0f).rate > SprayFor(SURF_GRAVEL, 0.5f, 0, 0.5f).rate); // with the speed
		CHECK(SprayFor(SURF_SNOW, 0.9f, 0, 1.5f).kind == SP_SNOW);
		CHECK(SprayFor(SURF_SNOW, 0.9f, 0, 1.5f).rate > SprayFor(SURF_SNOW, 0.0f, 0, 1.5f).rate * 2.0f); // strong when sliding
		CHECK(SprayFor(SURF_SNOW, 0.0f, 0, 1.5f).b >= 250);                                              // white
		CHECK(SprayFor(SURF_WATER, 0.0f, 0, 1.5f).kind == SP_WATER);
		CHECK(SprayFor(SURF_WATER, 0.0f, 0, 1.5f).up > SprayFor(SURF_GRAVEL, 0.5f, 0, 1.5f).up * 2.0f); // more vertical
		CHECK(SprayFor(SURF_TARMAC, 0.2f, 0, 1.5f).kind == SP_NONE);
		CHECK(SprayFor(SURF_TARMAC, 0.9f, 0, 1.5f).kind == SP_SMOKE);
		CHECK(SprayFor(SURF_GRAVEL, 0.5f, BIT_AIR, 1.5f).kind == SP_NONE);
		CHECK(SprayFor(SURF_GRAVEL, 0.5f, 0, 0.0f).kind == SP_NONE);
		CHECK(SprayFor(SURF_ICE, 0.9f, 0, 1.5f).kind == SP_NONE);
		float acc = 0;
		int total = 0;
		for (int i = 0; i < 100; i++) // 100 frames of 10 ms at 30 a second: 30 puffs
			total += EmitCount(acc, 30.0f, 0.01f, 6);
		CHECK(total >= 29 && total <= 30); // the part not whole is carried, so within one of it
		CHECK(acc >= 0.0f && acc < 1.0f);
		acc = 0;
		CHECK(EmitCount(acc, 1000.0f, 1.0f, 6) == 6); // capped
		acc = 0;
		CHECK(EmitCount(acc, 30.0f, 0.0f, 6) == 0); // a paused frame: none
		CHECK(PerCarBudget(300, 1) == 300 && PerCarBudget(300, 3) == 100 && PerCarBudget(300, 0) == 300);
		CHECK(PerCarBudget(300, 16) * 16 <= 300 + 16 * 24 && PerCarBudget(300, 100) == 24);
		// the height on a slope
		CHECK(Near(PlaneZ(V3(0, 0, 0), V3(-0.4472136f, 0, 0.8944272f), 10, 0), 5.0f, 1e-3f));
		CHECK(Near(PlaneZ(V3(0, 0, 7), V3(0, 0, 1), 10, 20), 7.0f, 1e-6f));
	}

	// ---- the shadow and the brake lights ------------------------------------------------------------------------------------------------
	{
		const Dims d = FullCar();
		CHECK(Near(ShadowAlpha(0, d.len), 0.75f, 1e-5f));
		CHECK(ShadowAlpha(d.len * 0.5f, d.len) < ShadowAlpha(0, d.len));
		CHECK(ShadowAlpha(d.len, d.len) == 0.0f && ShadowAlpha(5 * d.len, d.len) == 0.0f);
		CHECK(ShadowAlpha(-3, d.len) == ShadowAlpha(0, d.len));
		CHECK(ShadowHalfLen(d) > 0.5f * d.len && ShadowHalfWidth(d) > 0.5f * d.width);
		CHECK(!BrakeLightsOn(0) && !BrakeLightsOn(BIT_AIR) && BrakeLightsOn(BIT_BRAKE) && BrakeLightsOn(BIT_HAND) && BrakeLightsOn(BIT_BRAKE | 5));
		const V3 a = BrakeLightLocal(d, 0), b = BrakeLightLocal(d, 1);
		CHECK(Near(a.x, d.mins.x + 0.01f * d.len, 1e-4f) && Near(a.x, b.x, 1e-6f)); // the rear face
		CHECK(Near(a.y, 0.35f * d.width, 1e-4f) && Near(b.y, -0.35f * d.width, 1e-4f));
		CHECK(Near(a.z, 0.45f * d.height, 1e-4f));
		const Dims s = SmallCar();
		CHECK(Near(BrakeLightLocal(s, 0).y / a.y, 0.4f, 0.02f)); // scaled with the car
	}

	// ---- the rally effects (h9_rallyfx_calc.h): HL Rally's numbers ----
	rallychecks::Run(g_failed, g_checked);

	// ---- the switches --------------------------------------------------------------------------------------------------------------------
	CHECK(On(1.0f) && !On(0.0f) && !On(0.49f) && On(0.5f) && On(2.0f));

	printf("%s: %d checks, %d failed\n", g_failed == 0 ? "PASS" : "FAIL", g_checked, g_failed);
	return g_failed == 0 ? 0 : 1;
}
