/***
*  rally_test.cpp -- rally mode's handling maths driven alone (pm_shared/h9_rally.h, no engine, no world).
*
*    cmake --build build-win32 --target rally_test --config Release
*    build-win32/dlls/Release/rally_test.exe
*
*  A flat plane, a car, a heading that the steering turns: the scenarios the owner's test will feel, as numbers.
*  It prints one line a check and ends with "PASS: n checks" (exit 0) or "FAIL: n of m checks" (exit 1).
***/
#define H9RALLY_MATHS_ONLY
#include "../../pm_shared/h9_rally.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static int g_checks = 0, g_failed = 0;

static void Check(bool ok, const char* what)
{
	g_checks++;
	if (!ok)
		g_failed++;
	printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
}

struct Sim
{
	const H9RallyCar* car = &g_h9RallyCars[0];
	int surface = H9RS_TARMAC;
	float vf = 0, vs = 0;  // body-axis speeds
	float heading = 0;     // degrees, left positive
	float x = 0, y = 0;    // the path
	float time = 0;
	float maxSlipDeg = 0;
	float slopeF = 0;
	float dt = 0.01f;

	void Step(float throttle, float steer, bool hand)
	{
		H9RallyInput in;
		in.throttle = throttle;
		in.steer = steer;
		in.handbrake = hand;
		H9RallyGround g;
		g.surface = surface;
		g.slopeF = slopeF;
		// the nose turns; the car's velocity does not, so it is now at an angle to the nose
		const float dpsi = H9RallySteer(vf, vs, steer, hand, throttle < 0, *car, dt);
		heading += dpsi;
		{
			const float a = dpsi * (float)(M_PI / 180.0);
			const float nf = vf * cosf(a) + vs * sinf(a);
			const float ns = -vf * sinf(a) + vs * cosf(a);
			vf = nf;
			vs = ns;
		}
		H9RallyGroundStep(vf, vs, in, g, *car, dt);
		const float h = heading * (float)(M_PI / 180.0);
		const float wx = vf * cosf(h) - vs * sinf(h);
		const float wy = vf * sinf(h) + vs * cosf(h);
		x += wx * dt;
		y += wy * dt;
		time += dt;
		if (fabsf(vf) > 50.0f)
		{
			const float slip = SlipDeg();
			if (slip > maxSlipDeg)
				maxSlipDeg = slip;
		}
	}
	void Run(float seconds, float throttle, float steer, bool hand)
	{
		const int n = (int)(seconds / dt + 0.5f);
		for (int i = 0; i < n; i++)
			Step(throttle, steer, hand);
	}
	float Speed() const { return sqrtf(vf * vf + vs * vs); }
	// the angle between the path and the nose, degrees
	float SlipDeg() const { return fabsf(atan2f(vs, vf)) * 180.0f / (float)M_PI; }
};

static bool Finite(float v)
{
	return std::isfinite(v);
}

int main()
{
	// --- top speed on tarmac, by car ---------------------------------------------------------------------
	for (int c = 0; c < H9R_NUM_CARS; c++)
	{
		Sim s;
		s.car = &g_h9RallyCars[c];
		float t90 = -1;
		for (int i = 0; i < 2500; i++)
		{
			s.Step(1, 0, false);
			if (t90 < 0 && s.vf >= 0.9f * s.car->top)
				t90 = s.time;
		}
		char what[160];
		snprintf(what, sizeof what, "car %s: tarmac top speed within 3%% of %.0f (got %.0f)", s.car->name, s.car->top, s.vf);
		Check(s.vf > s.car->top * 0.97f && s.vf <= s.car->top + 0.5f, what);
		snprintf(what, sizeof what, "car %s: 90%% of top in 3 to 10 seconds (%.1f s)", s.car->name, t90);
		Check(t90 > 3.0f && t90 < 10.0f, what);
		snprintf(what, sizeof what, "car %s: top speed in HL Rally's range 1050 to 1350", s.car->name);
		Check(s.car->top >= 1050 && s.car->top <= 1350, what);
	}

	// --- the surfaces: top speed and the order of grip -----------------------------------------------------
	float topOn[H9RS_COUNT];
	for (int su = 0; su < H9RS_COUNT; su++)
	{
		Sim s;
		s.surface = su;
		s.Run(40, 1, 0, false);
		topOn[su] = s.vf;
	}
	Check(topOn[H9RS_SAND] < 0.75f * topOn[H9RS_TARMAC], "sand: top speed under 75% of tarmac's");
	Check(topOn[H9RS_SAND] < topOn[H9RS_GRASS] && topOn[H9RS_GRASS] < topOn[H9RS_DIRT], "sand slower than grass, grass slower than dirt");
	Check(topOn[H9RS_GRAVEL] < topOn[H9RS_TARMAC] && topOn[H9RS_SNOW] < topOn[H9RS_TARMAC], "gravel and snow slower than tarmac");
	Check(g_h9RallySurfaces[H9RS_TARMAC].mu >= g_h9RallySurfaces[H9RS_CONCRETE].mu &&
			  g_h9RallySurfaces[H9RS_CONCRETE].mu > g_h9RallySurfaces[H9RS_PACKED].mu &&
			  g_h9RallySurfaces[H9RS_PACKED].mu > g_h9RallySurfaces[H9RS_DIRT].mu &&
			  g_h9RallySurfaces[H9RS_DIRT].mu > g_h9RallySurfaces[H9RS_GRASS].mu &&
			  g_h9RallySurfaces[H9RS_SNOW].mu > g_h9RallySurfaces[H9RS_ICE].mu,
		  "grip order: tarmac, concrete, packed dirt, dirt, grass, snow, ice");
	{
		Sim ice;
		ice.surface = H9RS_ICE;
		ice.Run(60, 1, 0, false);
		Check(ice.vf > 0.8f * ice.car->top, "ice: it still gets to speed, slowly");
	}

	// --- a turn at speed: ice slides more than tarmac ------------------------------------------------------
	{
		float slip[H9RS_COUNT];
		float turned[H9RS_COUNT];
		for (int su = 0; su < H9RS_COUNT; su++)
		{
			Sim s;
			s.surface = su;
			s.vf = 700.0f;
			s.Run(1.5f, 1, 1, false); // power on, full left
			slip[su] = s.maxSlipDeg;
			turned[su] = s.heading;
		}
		char what[200];
		snprintf(what, sizeof what, "turn at 700: ice slips %.0f deg, tarmac %.0f deg (ice more, over 20)", slip[H9RS_ICE], slip[H9RS_TARMAC]);
		Check(slip[H9RS_ICE] > slip[H9RS_TARMAC] * 2.0f && slip[H9RS_ICE] > 20.0f, what);
		snprintf(what, sizeof what, "turn at 700: grass %.0f and snow %.0f slip more than tarmac %.0f", slip[H9RS_GRASS], slip[H9RS_SNOW], slip[H9RS_TARMAC]);
		Check(slip[H9RS_GRASS] > slip[H9RS_TARMAC] && slip[H9RS_SNOW] > slip[H9RS_TARMAC], what);
		Check(slip[H9RS_TARMAC] < 20.0f, "turn at 700 on tarmac: the car grips (slip under 20 degrees)");
		Check(turned[H9RS_TARMAC] > 20.0f, "turn at 700: the nose does come round");
	}

	// --- the handbrake rotates the car ----------------------------------------------------------------------
	{
		Sim a, b;
		a.vf = b.vf = 800.0f;
		a.Run(1.0f, 0, 1, false);
		b.Run(1.0f, 0, 1, true);
		char what[200];
		snprintf(what, sizeof what, "handbrake turn: nose turns %.0f deg against %.0f without", b.heading, a.heading);
		Check(b.heading > a.heading * 1.4f, what);
		snprintf(what, sizeof what, "handbrake turn: the path trails the nose by up to %.0f deg (over 35); %.0f without", b.maxSlipDeg, a.maxSlipDeg);
		Check(b.maxSlipDeg > 35.0f && b.maxSlipDeg > a.maxSlipDeg * 2, what);
		Check(b.Speed() < a.Speed(), "handbrake turn: it costs speed");
	}

	// --- stopping --------------------------------------------------------------------------------------------
	{
		Sim t;
		t.vf = t.car->top;
		float x0 = t.x;
		while (t.vf > 1.0f && t.time < 30)
			t.Step(-1, 0, false);
		const float d = t.x - x0;
		char what[200];
		snprintf(what, sizeof what, "braking from top on tarmac: %.0f units in %.1f s (300 to 1500, under 5 s)", d, t.time);
		Check(d > 300.0f && d < 1500.0f && t.time < 5.0f, what);
		Check(t.vf >= 0.0f && t.vf < 2.0f, "braking stops the car, it does not push it back");
		Sim i;
		i.surface = H9RS_ICE;
		i.vf = i.car->top;
		x0 = i.x;
		while (i.vf > 1.0f && i.time < 60)
			i.Step(-1, 0, false);
		snprintf(what, sizeof what, "braking on ice takes %.0f units, over 3x tarmac's %.0f", i.x - x0, d);
		Check(i.x - x0 > 3.0f * d, what);

		Sim c;
		c.vf = c.car->top;
		c.Run(10, 0, 0, false);
		char what2[120];
		snprintf(what2, sizeof what2, "lifting off: after 10 s the car is at %.0f of %.0f (coasting, slower than braking)", c.vf, c.car->top);
		Check(c.vf < c.car->top * 0.2f && c.vf > 0, what2);
	}

	// --- reverse ---------------------------------------------------------------------------------------------
	{
		Sim r;
		r.Run(12, -1, 0, false);
		char what[160];
		snprintf(what, sizeof what, "reverse from rest ends at %.0f, backwards, within %.0f", r.vf, r.car->reverseTop);
		Check(r.vf < -0.9f * r.car->reverseTop && r.vf >= -r.car->reverseTop - 0.5f, what);
		Sim fwd, rev;
		fwd.vf = 300;
		rev.vf = -300;
		fwd.Run(0.5f, 0, 1, false);
		rev.Run(0.5f, -1, 1, false);
		Check(fwd.heading > 0 && rev.heading < 0, "backing up with the wheel left turns the nose to the right");
	}

	// --- steering ---------------------------------------------------------------------------------------------
	{
		const H9RallyCar& car = g_h9RallyCars[0];
		const float still = H9RallySteer(0, 0, 1, false, false, car, 1.0f);
		const float mid = H9RallySteer(140, 0, 1, false, false, car, 1.0f);
		const float top = H9RallySteer(car.top, 0, 1, false, false, car, 1.0f);
		const float hand = H9RallySteer(car.top, 0, 1, true, false, car, 1.0f);
		Check(still > 0 && still < mid, "steering: a standing car turns, slowly");
		Check(top < mid && top > 0, "steering: less at top speed than at 140");
		Check(hand > mid, "steering: the handbrake turns it faster than anything");
		Check(H9RallySteer(500, 0, 0, false, false, car, 1.0f) == 0, "steering: no key, no turn");
		Check(fabsf(H9RallySteer(500, 0, 1, false, false, car, 1.0f) + H9RallySteer(500, 0, -1, false, false, car, 1.0f)) < 1e-4f, "steering: left and right turn alike");
	}

	// --- slopes -----------------------------------------------------------------------------------------------
	{
		Sim flat, up, down, flat8;
		up.slopeF = -250.0f; // gravity along a climb
		down.slopeF = 250.0f;
		flat.Run(30, 1, 0, false);
		up.Run(30, 1, 0, false);
		down.Run(8, 1, 0, false);
		flat8.Run(8, 1, 0, false);
		Check(up.vf < flat.vf * 0.95f, "uphill: slower than the flat");
		Check(down.vf > flat8.vf, "downhill: quicker away than the flat");
		Sim glide;
		glide.vf = 600;
		glide.slopeF = 250;
		glide.Run(2, 0, 0, false);
		Check(glide.vf > 600.0f, "rolling down a slope with the throttle up: it speeds up");
	}

	// --- left and right alike -------------------------------------------------------------------------------------
	{
		for (int su = 0; su < H9RS_COUNT; su += 3)
		{
			Sim l, r;
			l.surface = r.surface = su;
			l.vf = r.vf = 600;
			l.Run(2.0f, 1, 1, false);
			r.Run(2.0f, 1, -1, false);
			char what[160];
			snprintf(what, sizeof what, "left and right mirror each other (%s)", g_h9RallySurfaces[su].name);
			Check(fabsf(l.vf - r.vf) < 0.01f && fabsf(l.vs + r.vs) < 0.01f && fabsf(l.heading + r.heading) < 0.001f &&
					  fabsf(l.y + r.y) < 0.05f && fabsf(l.x - r.x) < 0.05f,
				  what);
			Sim lh, rh;
			lh.surface = rh.surface = su;
			lh.vf = rh.vf = 600;
			lh.Run(1.5f, 0, 1, true);
			rh.Run(1.5f, 0, -1, true);
			snprintf(what, sizeof what, "left and right mirror each other with the handbrake (%s)", g_h9RallySurfaces[su].name);
			Check(fabsf(lh.vf - rh.vf) < 0.01f && fabsf(lh.vs + rh.vs) < 0.01f, what);
		}
	}

	// --- a frame's length does not change the car -----------------------------------------------------------------
	{
		Sim a, b;
		a.dt = 0.005f;
		b.dt = 0.025f;
		a.vf = b.vf = 500;
		a.Run(3, 1, 1, false);
		b.Run(3, 1, 1, false);
		char what[200];
		snprintf(what, sizeof what, "5 ms and 25 ms frames agree (speed %.0f against %.0f, heading %.0f against %.0f)", a.vf, b.vf, a.heading, b.heading);
		Check(fabsf(a.vf - b.vf) < 0.04f * a.vf && fabsf(a.heading - b.heading) < 0.06f * fabsf(a.heading) + 1.0f, what);
	}

	// --- never NaN, never faster than it can be ------------------------------------------------------------------
	{
		srand(12345);
		bool finite = true, bounded = true;
		for (int run = 0; run < 400 && finite && bounded; run++)
		{
			Sim s;
			s.car = &g_h9RallyCars[run % H9R_NUM_CARS];
			s.surface = run % H9RS_COUNT;
			s.vf = (float)(rand() % 2600 - 1300) * 0.8f;
			s.vs = (float)(rand() % 1200 - 600);
			s.slopeF = (float)(rand() % 600 - 300);
			const float start = s.Speed();
						float tr = 0, st = 0;
			const float base = fmaxf(start, s.car->top) * 1.06f;
			bool hb = false;
			for (int i = 0; i < 1500; i++)
			{
				if (i % 37 == 0)
				{
					tr = (float)(rand() % 3 - 1);
					st = (float)(rand() % 3 - 1);
					hb = (rand() % 4) == 0;
					s.dt = 0.001f + (float)(rand() % 50) * 0.001f;
				}
				s.Step(tr, st, hb);
				if (!Finite(s.vf) || !Finite(s.vs) || !Finite(s.heading) || !Finite(s.x) || !Finite(s.y))
					finite = false;
				const float limit = base + fabsf(s.slopeF) * s.time + 1.0f;
				if (s.Speed() > limit)
				{
					if (bounded)
						printf("     run %d step %d: speed %.0f over %.0f (start %.0f, surface %d, slope %.0f)\n", run, i, s.Speed(), limit, start, s.surface, s.slopeF);
					bounded = false;
				}
			}
		}
		Check(finite, "400 random drives with 1 to 50 ms frames: no NaN, no infinity");
		Check(bounded, "the same drives never gain speed the engine and the slope cannot give");
		Sim z;
		z.dt = 0.0f;
		z.Step(1, 1, true);
		Check(Finite(z.vf) && Finite(z.heading), "a zero-length frame is harmless");
	}

	// --- the texture names -----------------------------------------------------------------------------------------
	{
		struct
		{
			const char* name;
			int want;
		} names[] = {
			{"wntr_snow1", H9RS_SNOW}, {"wntr_cliff2", H9RS_TARMAC}, {"wntr_ground", H9RS_SNOW}, {"WNTR_SNOW", H9RS_SNOW},
			{"sand01", H9RS_SAND}, {"desert_rock", H9RS_SAND}, {"{sand_dune", H9RS_SAND}, {"dirt2", H9RS_DIRT},
			{"mud_brown", H9RS_DIRT}, {"gras03", H9RS_GRASS}, {"road_dash", H9RS_TARMAC}, {"street_a", H9RS_TARMAC},
			{"rock_big", H9RS_TARMAC}, {"ice1", H9RS_ICE}, {"wntr_ice", H9RS_ICE}, {"gravel_a", H9RS_GRAVEL},
			{"conc02", H9RS_CONCRETE}, {"metalplate01", H9RS_METAL}, {"plate_floor", H9RS_METAL}, {"pack_dirt", H9RS_PACKED},
			{"+0snow", H9RS_SNOW}, {"-0sand", H9RS_SAND}, {"office01", H9RS_TARMAC}, {"police", H9RS_TARMAC},
			{"template", H9RS_TARMAC}, {"asphalt", H9RS_TARMAC}, {"", H9RS_TARMAC}, {"unknown_wall", H9RS_TARMAC},
		};
		bool all = true;
		for (const auto& n : names)
		{
			const int got = H9RallySurfaceByName(n.name);
			if (got != n.want)
			{
				all = false;
				printf("     \"%s\": wanted %s, got %s\n", n.name, g_h9RallySurfaces[n.want].name, g_h9RallySurfaces[got].name);
			}
		}
		Check(all, "texture names map to surfaces (HL Rally's rules, the winter set and the new ones)");
		Check(H9RallySurfaceByName(nullptr) == H9RS_TARMAC, "no name is tarmac");
	}

	// --- landing ---------------------------------------------------------------------------------------------------
	{
		Check(H9RallyLandKeep(100) == 1.0f, "a soft landing costs nothing");
		const float hard = H9RallyLandKeep(800);
		Check(hard < 1.0f && hard >= 1.0f - H9R_LAND_MAX - 1e-4f, "a hard landing costs speed, never more than the cap");
		Check(H9RallyLandKeep(5000) >= 1.0f - H9R_LAND_MAX - 1e-4f, "the loss is capped");
	}

	if (g_failed)
	{
		printf("FAIL: %d of %d checks\n", g_failed, g_checks);
		return 1;
	}
	printf("PASS: %d checks\n", g_checks);
	return 0;
}
