/***
*  rally_test.cpp -- rally mode's handling maths driven alone (pm_shared/h9_rally.h, no engine, no world).
*
*    cmake --build build-win32 --target rally_test --config Release
*    build-win32/dlls/Release/rally_test.exe
*
*  A flat plane, a car, a heading that the steering turns. Besides the checks of what the car should do, a small
*  reference integrator (Ref below) written straight from the description at the top of h9_rally.h, in world
*  coordinates with 1 ms steps and none of the header's structure, is run beside the header's model: its speed
*  against time on a straight, and the slip angle in a full-lock turn, must agree within 5%.
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

// The model under test: the header's body-axis step, with the nose turned by the header's steering.
struct Sim
{
	const H9RallyCar* car = &g_h9RallyCars[0];
	int surface = H9RS_NEUTRAL;
	float vf = 0, vs = 0;  // body-axis speeds
	float heading = 0;     // degrees, left positive
	float x = 0, y = 0;    // the path
	float time = 0;
	float maxSlipDeg = 0;
	float slopeF = 0;
	float dt = 0.01f;

	void Step(bool forward, bool back, float steer, bool hand)
	{
		H9RallyInput in;
		in.forward = forward;
		in.back = back;
		in.hand = hand;
		in.steering = steer != 0;
		H9RallyGround g;
		g.surface = surface;
		g.slopeF = slopeF;
		// the nose turns; the car's velocity does not, so it is now at an angle to the nose
		const float dpsi = H9RallySteer(steer, dt);
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
		if (Speed() > 50.0f)
		{
			const float slip = SlipDeg();
			if (slip > maxSlipDeg)
				maxSlipDeg = slip;
		}
	}
	void Run(float seconds, bool forward, bool back, float steer, bool hand)
	{
		const int n = (int)(seconds / dt + 0.5f);
		for (int i = 0; i < n; i++)
			Step(forward, back, steer, hand);
	}
	float Speed() const { return sqrtf(vf * vf + vs * vs); }
	// the angle between the path and the nose, degrees, 0 to 180
	float SlipDeg() const { return fabsf(atan2f(vs, vf)) * 180.0f / (float)M_PI; }
};

// The reference: HL Rally's ground physics as the description gives them, in world coordinates, Euler steps of 1 ms.
// Written from the description alone (not from the header's code): it shares no function with the model above.
struct Ref
{
	double vx = 0, vy = 0, heading = 0; // degrees
	double latSurf, dragSurf;
	double wish, handling;
	double t = 0;
	Ref(int surface, const H9RallyCar& car)
	{
		const double lat[] = {1, 1, 0.5, 0.35, 0.4, 0.315};
		const double drag[] = {0, -0.10, 0.04, 0.075, 0.05, 0.05};
		latSurf = lat[surface];
		dragSurf = drag[surface];
		wish = car.topStat * 15.0;
		handling = fabs(car.handlingStat - 40.0) / 50.0;
	}
	double Speed() const { return sqrt(vx * vx + vy * vy); }
	double SlipDeg() const
	{
		const double h = heading * M_PI / 180.0;
		const double vf = vx * cos(h) + vy * sin(h), vl = -vx * sin(h) + vy * cos(h);
		return fabs(atan2(vl, vf)) * 180.0 / M_PI;
	}
	void Step(double dt, bool throttle, double steerKeys)
	{
		// the view turns
		heading += steerKeys * 400.0 * dt;
		const double h = heading * M_PI / 180.0;
		const double fx = cos(h), fy = sin(h);  // the nose
		const double rx = sin(h), ry = -cos(h); // the right
		const double speed0 = sqrt(vx * vx + vy * vy);
		double align = speed0 > 1 ? (vx * fx + vy * fy) / speed0 : 1.0;
		if (align < 0.05) align = 0.05;
		if (align > 1) align = 1;
		double lat = (speed0 > 0.001 ? 75.0 * 30.0 / speed0 : 1e9);
		if (throttle) lat *= 0.85;
		if (throttle && steerKeys != 0) lat *= 0.8 * align;
		lat *= align * align * align;
		lat *= handling;
		lat *= latSurf;
		if (lat > 75.0) lat = 75.0;
		// friction
		vx -= vx * 0.25 * dt;
		vy -= vy * 0.25 * dt;
		// sideways
		const double before = sqrt(vx * vx + vy * vy);
		const double side = vx * rx + vy * ry;
		vx -= rx * side * lat * dt;
		vy -= ry * side * lat * dt;
		const double extra = before - sqrt(vx * vx + vy * vy);
		vx += fx * extra;
		vy += fy * extra;
		// slide and surface
		const double k = 1.0 - (0.25 * (1.0 - align) + dragSurf) * dt;
		vx *= k;
		vy *= k;
		// engine
		if (throttle)
		{
			const double add = wish - (vx * fx + vy * fy);
			double pull = 0.085 * wish * dt;
			if (pull > add) pull = add;
			if (add > 0 && sqrt(vx * vx + vy * vy) < 738.0)
			{
				vx += fx * pull;
				vy += fy * pull;
			}
		}
		t += dt;
	}
};

int main()
{
	char what[256];
	const H9RallyCar& xsara = g_h9RallyCars[0];

	// --- top speed: the pull meets the drag --------------------------------------------------------------
	// expected = wish * 0.085 / (0.25 + the surface's drag); the pull is 102 u/s^2 for 80
	printf("      top speed (u/s) and time to 90%% of it, after 60 s, Xsara:\n");
	float topOn[H9RS_COUNT];
	for (int su = 0; su < H9RS_COUNT; su++)
	{
		Sim s;
		s.surface = su;
		float t90 = -1;
		float want = H9RallyWish(xsara) * H9R_ACCELERATE / (H9R_FRICTION + g_h9RallySurfaces[su].drag);
		for (int i = 0; i < 6000; i++)
		{
			s.Step(true, false, 0, false);
			if (t90 < 0 && s.vf >= 0.9f * want)
				t90 = s.time;
		}
		topOn[su] = s.vf;
		snprintf(what, sizeof what, "%-12s top %6.1f (pull/drag says %6.1f), 90%% in %4.1f s", g_h9RallySurfaces[su].name, s.vf, want, t90);
		printf("      %s\n", what);
		Check(fabsf(s.vf - want) < 0.03f * want, what);
	}
	Check(fabsf(topOn[H9RS_NEUTRAL] - 408.0f) < 3.0f, "neutral surface: top speed 408 u/s (102 / 0.25), the 400 HL Rally drives at");
	Check(fabsf(topOn[H9RS_SNOW] - 340.0f) < 3.0f, "snow: 340 u/s (102 / 0.30)");
	Check(fabsf(topOn[H9RS_ROAD] - 680.0f) < 8.0f, "road: 680 u/s (102 / 0.15)");
	Check(fabsf(topOn[H9RS_SAND] - 340.0f) < 3.0f, "sand: 340 u/s (HL Rally's sand: drag +0.05)");
	Check(topOn[H9RS_GRASS] < topOn[H9RS_SAND] && topOn[H9RS_SAND] <= topOn[H9RS_DIRT] && topOn[H9RS_DIRT] < topOn[H9RS_NEUTRAL] &&
			  topOn[H9RS_NEUTRAL] < topOn[H9RS_ROAD],
		  "top speed order: grass < sand < dirt < neutral < road");
	Check(topOn[H9RS_GRAVEL] < topOn[H9RS_NEUTRAL] && topOn[H9RS_PACKED] < topOn[H9RS_NEUTRAL] && topOn[H9RS_CONCRETE] > topOn[H9RS_NEUTRAL] &&
			  topOn[H9RS_CONCRETE] < topOn[H9RS_ROAD],
		  "our extra surfaces sit between HL Rally's: gravel and packed dirt under neutral, concrete between neutral and road");

	for (int c = 0; c < H9R_NUM_CARS; c++)
	{
		Sim s;
		s.car = &g_h9RallyCars[c];
		s.Run(60, true, false, 0, false);
		const float want = H9RallyWish(*s.car) * H9R_ACCELERATE / H9R_FRICTION;
		snprintf(what, sizeof what, "car %s (%.0f/%.0f/%.0f): neutral top %.0f, pull/drag says %.0f", s.car->name, s.car->accelStat,
				 s.car->handlingStat, s.car->topStat, s.vf, want);
		Check(fabsf(s.vf - want) < 0.02f * want, what);
	}

	// --- speed against time on a straight, against the reference (5%) ----------------------------------------
	{
		const int surfaces[3] = {H9RS_NEUTRAL, H9RS_SNOW, H9RS_ROAD};
		const float times[5] = {2, 5, 10, 20, 40};
		for (int si = 0; si < 3; si++)
		{
			Sim m;
			m.surface = surfaces[si];
			Ref r(surfaces[si], xsara);
			float worst = 0;
			float t = 0;
			for (int ti = 0; ti < 5; ti++)
			{
				while (t < times[ti] - 1e-6f)
				{
					for (int k = 0; k < 10; k++)
						r.Step(0.001, true, 0);
					m.Step(true, false, 0, false);
					t += 0.01f;
				}
				const float err = fabsf(m.vf - (float)r.Speed()) / (float)r.Speed();
				if (err > worst)
					worst = err;
			}
			snprintf(what, sizeof what, "%s straight: speed at 2, 5, 10, 20 and 40 s within 5%% of the reference (worst %.2f%%, ours %.1f, reference %.1f at 40 s)",
					 g_h9RallySurfaces[surfaces[si]].name, worst * 100.0f, m.vf, (float)r.Speed());
			Check(worst < 0.05f, what);
		}
	}

	// --- a full-lock turn with the throttle on: the slip angle against the reference ---------------------------
	{
		const int surfaces[2] = {H9RS_SNOW, H9RS_ROAD};
		for (int si = 0; si < 2; si++)
		{
			Sim m;
			m.surface = surfaces[si];
			Ref r(surfaces[si], xsara);
			// both start at the same moment: 300 u/s straight ahead, as a car in a corner's approach
			m.vf = 300;
			r.vx = 300;
			float t = 0;
			const float marks[4] = {0.1f, 0.25f, 0.5f, 1.0f};
			char line[256] = "";
			float worst = 0;
			for (int mi = 0; mi < 4; mi++)
			{
				while (t < marks[mi] - 1e-6f)
				{
					for (int k = 0; k < 10; k++)
						r.Step(0.001, true, 1.0);
					m.Step(true, false, 1.0f, false);
					t += 0.01f;
				}
				const float a = m.SlipDeg(), b = (float)r.SlipDeg();
				const float err = fabsf(a - b) / fmaxf(b, 1.0f);
				if (err > worst)
					worst = err;
				char one[48];
				snprintf(one, sizeof one, " %.2fs: %.1f/%.1f", marks[mi], a, b);
				strncat(line, one, sizeof line - strlen(line) - 1);
			}
			snprintf(what, sizeof what, "%s full lock, throttle on, slip (ours/reference):%s", g_h9RallySurfaces[surfaces[si]].name, line);
			printf("      %s\n", what);
			snprintf(what, sizeof what, "%s full lock with throttle: slip angle within 5%% of the reference (worst %.1f%%)", g_h9RallySurfaces[surfaces[si]].name, worst * 100.0f);
			Check(worst < 0.05f, what);
		}
	}

	// --- the turn: loose ground slides more --------------------------------------------------------------------
	{
		float slip[H9RS_COUNT];
		for (int su = 0; su < H9RS_COUNT; su++)
		{
			Sim s;
			s.surface = su;
			s.vf = 300.0f;
			s.Run(0.1f, true, false, 1, false);
			slip[su] = s.SlipDeg();
		}
		snprintf(what, sizeof what, "after 0.1 s of full lock at 300: ice slips %.0f deg, snow %.0f, grass %.0f, sand %.0f, dirt %.0f, neutral %.0f, road %.0f",
				 slip[H9RS_ICE], slip[H9RS_SNOW], slip[H9RS_GRASS], slip[H9RS_SAND], slip[H9RS_DIRT], slip[H9RS_NEUTRAL], slip[H9RS_ROAD]);
		Check(slip[H9RS_ICE] > slip[H9RS_SNOW] && slip[H9RS_SNOW] > slip[H9RS_NEUTRAL] && slip[H9RS_GRASS] > slip[H9RS_DIRT] && slip[H9RS_DIRT] > slip[H9RS_NEUTRAL], what);
		Check(slip[H9RS_SAND] > slip[H9RS_DIRT], "sand (lat 0.4) slides more than dirt (0.5)");
	}

	// --- the handbrake ----------------------------------------------------------------------------------------
	{
		Sim a, b;
		a.vf = b.vf = 400.0f;
		a.Run(0.1f, false, false, 1, false);
		b.Run(0.1f, false, false, 1, true);
		snprintf(what, sizeof what, "handbrake turn: the path trails the nose by %.0f deg against %.0f without it (and %.0f against %.0f u/s)", b.SlipDeg(), a.SlipDeg(), b.Speed(), a.Speed());
		Check(b.SlipDeg() > a.SlipDeg() && b.Speed() < a.Speed(), what);
		Sim t1, t2;
		t1.surface = t2.surface = H9RS_ROAD;
		t1.vf = t2.vf = 600;
		t1.Run(0.4f, false, false, 1, false);
		t2.Run(0.4f, false, false, 1, true);
		Check(t2.maxSlipDeg > t1.maxSlipDeg, "handbrake lets the tail round on the road too");
	}

	// --- stopping: handbrake or back key, against the reference ---------------------------------------------------
	{
		Sim t;
		t.surface = H9RS_NEUTRAL;
		t.vf = 408;
		while (t.vf > 2.0f && t.time < 30)
			t.Step(false, false, 0, true);
		const float dHand = t.x;
		const float tHand = t.time;
		// the reference: drag 0.25 and the 150 a second along the velocity (aligned: all of it)
		double v = 408, x = 0, tt = 0;
		while (v > 2.0 && tt < 30)
		{
			v -= v * 0.25 * 0.001;
			v -= 150.0 * 0.001;
			x += v * 0.001;
			tt += 0.001;
		}
		snprintf(what, sizeof what, "handbrake stop from 408 on neutral: %.0f units in %.2f s (reference %.0f in %.2f s)", dHand, tHand, (float)x, (float)tt);
		Check(fabsf(dHand - (float)x) < 0.05f * (float)x && dHand > 250 && dHand < 600, what);
		Sim bk;
		bk.vf = 408;
		while (bk.vf > H9R_REVERSE_ENTER && bk.time < 30)
			bk.Step(false, true, 0, false);
		snprintf(what, sizeof what, "back key brakes while above %.0f u/s: from 408 it is down to %.0f in %.2f s over %.0f units", H9R_REVERSE_ENTER, bk.vf, bk.time, bk.x);
		Check(bk.vf <= H9R_REVERSE_ENTER + 5 && bk.time < 3.5f, what);
		Sim c;
		c.vf = 408;
		c.Run(10, false, false, 0, false);
		snprintf(what, sizeof what, "lifting off: after 10 s the car has coasted from 408 to %.0f (exp(-0.25 t) says %.0f)", c.vf, 408.0f * expf(-2.5f));
		Check(fabsf(c.vf - 408.0f * expf(-2.5f)) < 4.0f, what);
	}

	// --- reverse -------------------------------------------------------------------------------------------------
	{
		Sim r;
		r.Run(12, false, true, 0, false);
		snprintf(what, sizeof what, "reverse from rest ends at %.0f u/s, backwards, about 40 (the client sends reverse only below 40 u/s, and above it the back key brakes)", r.vf);
		Check(r.vf < -35.0f && r.vf > -50.0f, what);
	}

	// --- steering --------------------------------------------------------------------------------------------------
	{
		Check(fabsf(H9RallySteer(1, 0.01f) - 4.0f) < 1e-4f, "steering: 400 degrees a second, 4 degrees in a 10 ms frame, at any speed");
		Check(H9RallySteer(0, 0.5f) == 0, "steering: no key, no turn");
		Check(fabsf(H9RallySteer(1, 0.02f) + H9RallySteer(-1, 0.02f)) < 1e-5f, "steering: left and right turn alike");
	}

	// --- slopes --------------------------------------------------------------------------------------------------
	{
		Sim flat, up, down;
		up.slopeF = -150.0f; // gravity along a climb (520 * sin 17 degrees)
		down.slopeF = 150.0f;
		flat.Run(60, true, false, 0, false);
		up.Run(60, true, false, 0, false);
		down.Run(60, true, false, 0, false);
		Check(up.vf < flat.vf * 0.8f && down.vf > flat.vf * 1.2f, "slopes: uphill slower, downhill faster than the flat");
	}

	// --- left and right alike ------------------------------------------------------------------------------------
	{
		for (int su = 0; su < H9RS_COUNT; su += 2)
		{
			Sim l, r;
			l.surface = r.surface = su;
			l.vf = r.vf = 300;
			l.Run(2.0f, true, false, 1, false);
			r.Run(2.0f, true, false, -1, false);
			snprintf(what, sizeof what, "left and right mirror each other (%s)", g_h9RallySurfaces[su].name);
			Check(fabsf(l.vf - r.vf) < 0.01f && fabsf(l.vs + r.vs) < 0.01f && fabsf(l.heading + r.heading) < 0.001f &&
					  fabsf(l.y + r.y) < 0.05f && fabsf(l.x - r.x) < 0.05f,
				  what);
		}
	}

	// --- a frame's length does not change the car ----------------------------------------------------------------
	{
		Sim a, b;
		a.dt = 0.005f;
		b.dt = 0.025f;
		a.vf = b.vf = 300;
		a.Run(1.0f, true, false, 1, false);
		b.Run(1.0f, true, false, 1, false);
		a.Run(2.0f, true, false, 0, false);
		b.Run(2.0f, true, false, 0, false);
		snprintf(what, sizeof what, "5 ms and 25 ms frames agree (speed %.0f against %.0f)", a.Speed(), b.Speed());
		Check(fabsf(a.Speed() - b.Speed()) < 0.05f * a.Speed(), what);
	}

	// --- never NaN, never faster than it can be -----------------------------------------------------------------
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
			const float base = fmaxf(start, 1350.0f * H9R_ACCELERATE / 0.14f) * 1.06f;
			bool fw = false, bk = false, hb = false;
			float st = 0;
			for (int i = 0; i < 1500; i++)
			{
				if (i % 37 == 0)
				{
					fw = (rand() % 2) == 0;
					bk = !fw && (rand() % 2) == 0;
					st = (float)(rand() % 3 - 1);
					hb = (rand() % 4) == 0;
					s.dt = 0.001f + (float)(rand() % 50) * 0.001f;
				}
				s.Step(fw, bk, st, hb);
				if (!std::isfinite(s.vf) || !std::isfinite(s.vs) || !std::isfinite(s.heading) || !std::isfinite(s.x) || !std::isfinite(s.y))
					finite = false;
				if (s.Speed() > base + fabsf(s.slopeF) * s.time + 1.0f)
				{
					if (bounded)
						printf("     run %d step %d: speed %.0f over %.0f (start %.0f, surface %d, slope %.0f)\n", run, i, s.Speed(), base + fabsf(s.slopeF) * s.time, start, s.surface, s.slopeF);
					bounded = false;
				}
			}
		}
		Check(finite, "400 random drives with 1 to 50 ms frames: no NaN, no infinity");
		Check(bounded, "the same drives never gain speed the engine and the slope cannot give");
		Sim z;
		z.dt = 0.0f;
		z.Step(true, false, 1, true);
		Check(std::isfinite(z.vf) && std::isfinite(z.heading), "a zero-length frame is harmless");
	}

	// --- the texture names ---------------------------------------------------------------------------------------
	{
		struct
		{
			const char* name;
			int want;
			float drag;
		} names[] = {
			{"wntr_snow1", H9RS_SNOW, 0}, {"wntr_cliff2", H9RS_NEUTRAL, 0}, {"wntr_ground", H9RS_NEUTRAL, 0}, {"WNTR_SNOW", H9RS_SNOW, 0},
			{"sand01", H9RS_SAND, 0}, {"desert_rock", H9RS_SAND, -0.10f}, {"{sand_dune", H9RS_SAND, 0}, {"dirt2", H9RS_DIRT, 0},
			{"mud_brown", H9RS_DIRT, 0}, {"gras03", H9RS_GRASS, 0}, {"road_dash", H9RS_ROAD, 0}, {"street_a", H9RS_ROAD, 0},
			{"rock_big", H9RS_ROAD, 0}, {"dirt_road", H9RS_DIRT, -0.10f}, {"ice1", H9RS_ICE, 0}, {"wntr_ice", H9RS_ICE, 0},
			{"gravel_a", H9RS_GRAVEL, 0}, {"conc02", H9RS_CONCRETE, 0}, {"metalplate01", H9RS_METAL, 0}, {"plate_floor", H9RS_METAL, 0},
			{"pack_dirt", H9RS_PACKED, 0}, {"+0snow", H9RS_SNOW, 0}, {"-0sand", H9RS_SAND, 0}, {"office01", H9RS_NEUTRAL, 0},
			{"police", H9RS_NEUTRAL, 0}, {"template", H9RS_NEUTRAL, 0}, {"asphalt", H9RS_ROAD, 0}, {"", H9RS_NEUTRAL, 0},
			{"unknown_wall", H9RS_NEUTRAL, 0},
		};
		bool all = true;
		for (const auto& n : names)
		{
			float d = 0;
			const int got = H9RallySurfaceByName(n.name, &d);
			if (got != n.want || fabsf(d - n.drag) > 1e-5f)
			{
				all = false;
				printf("     \"%s\": wanted %s (+%.2f), got %s (+%.2f)\n", n.name, g_h9RallySurfaces[n.want].name, n.drag, g_h9RallySurfaces[got].name, d);
			}
		}
		Check(all, "texture names map to surfaces (HL Rally's rules, and the new ones)");
		Check(H9RallySurfaceByName(nullptr) == H9RS_NEUTRAL, "no name is neutral");
	}

	// --- walls -----------------------------------------------------------------------------------------------------
	{
		Check(fabsf(H9RallyCrashKeep(-1.0f) - 1.0f / 3.0f) < 1e-5f, "a head-on crash keeps a third of the speed");
		Check(fabsf(H9RallyCrashKeep(1.0f) - 1.0f) < 1e-5f, "grazing a wall keeps all of it");
	}

	// --- numbers for the report -------------------------------------------------------------------------------------
	{
		printf("      lap of 35500 units, throttle held, no corners (a lower bound), from a standing start:\n");
		const int surfaces[3] = {H9RS_NEUTRAL, H9RS_SNOW, H9RS_ROAD};
		for (int si = 0; si < 3; si++)
		{
			Sim s;
			s.surface = surfaces[si];
			while (s.x < 35500.0f && s.time < 600)
				s.Step(true, false, 0, false);
			printf("        %-8s %.0f s\n", g_h9RallySurfaces[surfaces[si]].name, s.time);
		}
	}

	if (g_failed)
	{
		printf("FAIL: %d of %d checks\n", g_failed, g_checks);
		return 1;
	}
	printf("PASS: %d checks\n", g_checks);
	return 0;
}
