/***
*  rally_test.cpp -- rally mode's handling maths driven alone (pm_shared/h9_rally.h, no engine, no world).
*
*    cmake --build build-win32 --target rally_test --config Release
*    build-win32/dlls/Release/rally_test.exe
*
*  A flat plane, a car, a heading that the steering turns. Every number a changed row expects is worked out from HL Rally's formula
*  (the file and line it comes from are in the comment of the check, from the audit C:/tmp/h9/parity/movement.md), not read
*  back from the header. A small reference integrator (Ref below) written straight from the description at the top of h9_rally.h,
*  in world coordinates and none of the header's structure, is run beside the header's model: its speed against time on a
*  straight, and the slip angle in a full-lock turn, must agree within 5%.
*  It prints one line a check and ends with "PASS: n checks" (exit 0) or "FAIL: n of m checks" (exit 1).
***/
#define H9RALLY_MATHS_ONLY
#include "../../pm_shared/h9_rally.h"
#include "../h9_rally_snd.h"
#include "../race_rally.h"
#include "../h9_rally_shop_srv.h"
#include "../../cl_dll/h9_rallysteer_calc.h" // the client's throttle: the forward move the command carries

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

static const float kMvFriction = H9R_FRICTION; // rally.cfg sv_friction, what pmove reads live

// The model under test: the header's friction and pull on a flat plane, a velocity in world coordinates, a nose that the
// steering turns. One call is one command, of `dt` seconds: the frame rate is part of the model, as in HL Rally.
struct Sim
{
	const H9RallyCar* car = &g_h9RallyCars[0];
	int surface = H9RS_NEUTRAL;
	float v[3] = {0, 0, 0}; // the velocity, world
	float heading = 0;      // degrees, left positive
	float x = 0, y = 0;     // the path
	float time = 0;
	float maxSlipDeg = 0;
	float dt = 0.01f;
	float pmFriction = 1.0f; // pmove->friction (func_friction)
	float lat = 0;
	// the client's half, as HL Rally's: the gearbox (automatic) and the forward move worked out from it (input.cpp:869-1001, h9_rallysteer_calc.h)
	rallysteer::Gearbox box;
	int reversing = 0;
	float fmove = 0;

	// the speed along the nose and across it (left positive)
	float Vf() const
	{
		const float h = heading * (float)(M_PI / 180.0);
		return v[0] * cosf(h) + v[1] * sinf(h);
	}
	float Vs() const
	{
		const float h = heading * (float)(M_PI / 180.0);
		return -v[0] * sinf(h) + v[1] * cosf(h);
	}
	void SetBody(float vf, float vs)
	{
		const float h = heading * (float)(M_PI / 180.0);
		v[0] = vf * cosf(h) - vs * sinf(h);
		v[1] = vf * sinf(h) + vs * cosf(h);
		v[2] = 0;
	}

	void Step(bool forward, bool back, float steer, bool hand)
	{
		H9RallyInput in;
		in.forward = forward;
		in.back = back;
		in.hand = hand;
		in.steering = steer != 0;
		heading += H9RallySteer(steer, dt); // the view's yaw moves the nose; the velocity does not turn
		const float h = heading * (float)(M_PI / 180.0);
		const float fwd[3] = {cosf(h), sinf(h), 0};
		const float right[3] = {sinf(h), -cosf(h), 0};
		const float hs = sqrtf(v[0] * v[0] + v[1] * v[1]);
		// the command's forward move: the client works it out before the step from the speed and revs it has (the last frame's), and it
		// arrives in the command (the movevars' maxspeed 3000 cuts it; the car's own wish cuts it again in the pull)
		rallysteer::DriveIn di;
		di.gear = box.gear;
		di.rpm = box.rpm;
		di.speedH = hs;
		di.fwdFrac = di.fwdDown = forward ? 1.0f : 0.0f;
		di.backFrac = di.backDown = back ? 1.0f : 0.0f;
		di.reversing = reversing;
		const rallysteer::DriveOut dout = rallysteer::DriveStep(di);
		reversing = dout.reversing;
		fmove = rallysteer::Clampf(dout.forwardmove, -3000.0f, 3000.0f);
		const H9RallyFrictionResult fr = H9RallyFriction(v, fwd, right, in, fmove, g_h9RallySurfaces[surface].lat, g_h9RallySurfaces[surface].drag,
														 H9RallyHandling(*car), kMvFriction, dt);
		lat = fr.lat;
		const float wishspeed = H9RallyWishSpeed(fmove, H9RallyWish(*car));
		if (wishspeed > 0.0f)
		{
			float dir[3] = {fwd[0], fwd[1], fwd[2]};
			if (fmove < 0)
				for (int i = 0; i < 3; i++)
					dir[i] = -dir[i];
			H9RallyAccelerate(v, dir, wishspeed, H9R_ACCELERATE, pmFriction, dt, fmove);
		}
		// the gearbox moves on with the speed the step left (the renderer's renderCalculateRPMs, once a frame)
		rallysteer::GearboxStep(box, sqrtf(v[0] * v[0] + v[1] * v[1]), true, dout.accelerating || dout.reversing == 2, 0.0f, dt);
		x += v[0] * dt;
		y += v[1] * dt;
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
	float Speed() const { return sqrtf(v[0] * v[0] + v[1] * v[1]); }
	// the angle between the path and the nose, degrees, 0 to 180
	float SlipDeg() const { return fabsf(atan2f(Vs(), Vf())) * 180.0f / (float)M_PI; }
};

// The reference: HL Rally's ground physics as the description gives them, in world coordinates, Euler steps of the same length.
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
		double align = speed0 > 1e-9 ? (vx * fx + vy * fy) / speed0 : 1.0;
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
	char what[512];
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
			if (t90 < 0 && s.Vf() >= 0.9f * want)
				t90 = s.time;
		}
		topOn[su] = s.Vf();
		snprintf(what, sizeof what, "%-12s top %6.1f (pull/drag says %6.1f), 90%% in %4.1f s", g_h9RallySurfaces[su].name, s.Vf(), want, t90);
		printf("      %s\n", what);
		Check(fabsf(s.Vf() - want) < 0.03f * want, what);
	}
	Check(fabsf(topOn[H9RS_NEUTRAL] - 408.0f) < 3.0f, "neutral surface: top speed 408 u/s (102 / 0.25), the 400 HL Rally drives at");
	Check(fabsf(topOn[H9RS_SNOW] - 340.0f) < 3.0f, "snow: 340 u/s (102 / 0.30)");
	Check(fabsf(topOn[H9RS_ROAD] - 680.0f) < 8.0f, "road: 680 u/s (102 / 0.15)");
	Check(fabsf(topOn[H9RS_SAND] - 340.0f) < 3.0f, "sand: 340 u/s (HL Rally's sand: drag +0.05)");
	Check(topOn[H9RS_GRASS] < topOn[H9RS_SAND] && topOn[H9RS_SAND] <= topOn[H9RS_DIRT] && topOn[H9RS_DIRT] < topOn[H9RS_NEUTRAL] &&
			  topOn[H9RS_NEUTRAL] < topOn[H9RS_ROAD],
		  "top speed order: grass < sand < dirt < neutral < road");

	for (int c = 0; c < H9R_NUM_CARS; c++)
	{
		Sim s;
		s.car = &g_h9RallyCars[c];
		s.Run(60, true, false, 0, false);
		const float want = H9RallyWish(*s.car) * H9R_ACCELERATE / H9R_FRICTION;
		snprintf(what, sizeof what, "car %s (%.0f/%.0f/%.0f): neutral top %.0f, pull/drag says %.0f", s.car->name, s.car->accelStat,
				 s.car->handlingStat, s.car->topStat, s.Vf(), want);
		Check(fabsf(s.Vf() - want) < 0.02f * want, what);
	}

	// --- row 15: the cars, carinfo.txt's ten, the first three where they were ---------------------------------------------------
	{
		struct
		{
			const char* name;
			int a, h, t;
		} want[10] = {{"xsara", 80, 80, 80}, {"accent", 85, 75, 80}, {"locust", 80, 90, 70}, {"evo7", 90, 80, 70}, {"206", 85, 85, 70},
					  {"octavia", 75, 75, 90}, {"fabia", 75, 75, 90}, {"impreza2002", 80, 85, 75}, {"celica", 80, 75, 85}, {"corolla", 80, 70, 90}};
		bool all = H9R_NUM_CARS == 10;
		for (int i = 0; i < 10 && all; i++)
		{
			const H9RallyCar& c = H9RallyCarByClass(i + 1);
			all = strcmp(c.name, want[i].name) == 0 && (int)c.accelStat == want[i].a && (int)c.handlingStat == want[i].h && (int)c.topStat == want[i].t;
		}
		Check(all, "cars: carinfo.txt's ten (accel/handling/top), classes 1 to 3 xsara, accent, locust as before, the seven new ones after");
		Check(strcmp(H9RallyCarByClass(0).name, "xsara") == 0 && strcmp(H9RallyCarByClass(99).name, "corolla") == 0, "cars: a class out of range is clamped");
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
					r.Step(0.01, true, 0);
					m.Step(true, false, 0, false);
					t += 0.01f;
				}
				const float err = fabsf(m.Vf() - (float)r.Speed()) / (float)r.Speed();
				if (err > worst)
					worst = err;
			}
			snprintf(what, sizeof what, "%s straight: speed at 2, 5, 10, 20 and 40 s within 5%% of the reference (worst %.2f%%, ours %.1f, reference %.1f at 40 s)",
					 g_h9RallySurfaces[surfaces[si]].name, worst * 100.0f, m.Vf(), (float)r.Speed());
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
			m.SetBody(300, 0);
			r.vx = 300;
			float t = 0;
			const float marks[4] = {0.1f, 0.25f, 0.5f, 1.0f};
			char line[256] = "";
			float worst = 0;
			for (int mi = 0; mi < 4; mi++)
			{
				while (t < marks[mi] - 1e-6f)
				{
					r.Step(0.01, true, 1.0);
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
			s.SetBody(300.0f, 0);
			s.Run(0.1f, true, false, 1, false);
			slip[su] = s.SlipDeg();
		}
		snprintf(what, sizeof what, "after 0.1 s of full lock at 300: snow slips %.0f deg, grass %.0f, sand %.0f, dirt %.0f, neutral %.0f, road %.0f",
				 slip[H9RS_SNOW], slip[H9RS_GRASS], slip[H9RS_SAND], slip[H9RS_DIRT], slip[H9RS_NEUTRAL], slip[H9RS_ROAD]);
		Check(slip[H9RS_SNOW] > slip[H9RS_NEUTRAL] && slip[H9RS_GRASS] > slip[H9RS_DIRT] && slip[H9RS_DIRT] > slip[H9RS_NEUTRAL], what);
		Check(slip[H9RS_SAND] > slip[H9RS_DIRT], "sand (lat 0.4) slides more than dirt (0.5)");
	}

	// --- the handbrake ----------------------------------------------------------------------------------------
	{
		Sim a, b;
		a.SetBody(400.0f, 0);
		b.SetBody(400.0f, 0);
		a.Run(0.1f, false, false, 1, false);
		b.Run(0.1f, false, false, 1, true);
		snprintf(what, sizeof what, "handbrake turn: the path trails the nose by %.0f deg against %.0f without it (and %.0f against %.0f u/s)", b.SlipDeg(), a.SlipDeg(), b.Speed(), a.Speed());
		Check(b.SlipDeg() > a.SlipDeg() && b.Speed() < a.Speed(), what);
		Sim t1, t2;
		t1.surface = t2.surface = H9RS_ROAD;
		t1.SetBody(600, 0);
		t2.SetBody(600, 0);
		t1.Run(0.4f, false, false, 1, false);
		t2.Run(0.4f, false, false, 1, true);
		Check(t2.maxSlipDeg > t1.maxSlipDeg, "handbrake lets the tail round on the road too");
	}

	// --- stopping: handbrake or back key, against the reference ---------------------------------------------------
	{
		Sim t;
		t.surface = H9RS_NEUTRAL;
		t.SetBody(408, 0);
		while (t.Vf() > 2.0f && t.time < 30)
			t.Step(false, false, 0, true);
		const float dHand = t.x;
		const float tHand = t.time;
		// the reference: drag 0.25 and the 150 a second along the velocity (aligned: all of it), Euler at 10 ms
		double v = 408, x = 0, tt = 0;
		while (v > 2.0 && tt < 30)
		{
			v -= v * 0.25 * 0.01;
			v -= 150.0 * 0.01;
			x += v * 0.01;
			tt += 0.01;
		}
		snprintf(what, sizeof what, "handbrake stop from 408 on neutral: %.0f units in %.2f s (reference %.0f in %.2f s)", dHand, tHand, (float)x, (float)tt);
		Check(fabsf(dHand - (float)x) < 0.05f * (float)x && dHand > 250 && dHand < 600, what);
		Sim bk;
		bk.SetBody(408, 0);
		while (bk.Vf() > H9R_REVERSE_ENTER && bk.time < 30)
			bk.Step(false, true, 0, false);
		snprintf(what, sizeof what, "back key brakes while above %.0f u/s: from 408 it is down to %.0f in %.2f s over %.0f units", H9R_REVERSE_ENTER, bk.Vf(), bk.time, bk.x);
		Check(bk.Vf() <= H9R_REVERSE_ENTER + 5 && bk.time < 3.5f, what);
		Sim c;
		c.SetBody(408, 0);
		c.Run(10, false, false, 0, false);
		const float euler = 408.0f * powf(1.0f - 0.25f * 0.01f, 1000.0f);
		snprintf(what, sizeof what, "lifting off: after 10 s the car has coasted from 408 to %.0f ((1 - 0.25 dt)^1000 says %.0f)", c.Vf(), euler);
		Check(fabsf(c.Vf() - euler) < 1.0f, what);
	}

	// --- reverse (row 7) -------------------------------------------------------------------------------------------
	{
		Sim r;
		r.Run(12, false, true, 0, false);
		snprintf(what, sizeof what, "reverse from rest ends at %.0f u/s, backwards, about 40 (the client sends reverse only below 40 u/s, and above it the back key brakes)", r.Vf());
		Check(r.Vf() < -35.0f && r.Vf() > -50.0f, what);
		// HLR input.cpp:871 velocity < 40 && back, decided when the command is built: once, on the speed the car has
		auto Move = [](float speed, bool fwdKey, bool backKey) {
			rallysteer::DriveIn di;
			di.speedH = speed;
			di.fwdFrac = di.fwdDown = fwdKey ? 1.0f : 0.0f;
			di.backFrac = di.backDown = backKey ? 1.0f : 0.0f;
			return rallysteer::DriveStep(di).forwardmove;
		};
		Check(Move(39.99f, false, true) < 0 && Move(40.0f, false, true) == 0 && Move(400.0f, false, true) == 0,
			  "reverse: the back key means reverse below 40 u/s of horizontal speed and is only the brake from 40 (input.cpp:871, :942-950)");
		Check(Move(10.0f, true, true) > 0 && Move(10.0f, false, false) == 0, "reverse: the throttle overrides the back key (input.cpp:890-893); no key, no move");
		// the pull backwards stops once the car is over 100 u/s (HLR rally.c:1007-1011), the forward pull does not
		float v1[3] = {-150, 0, 0}, v2[3] = {150, 0, 0};
		const float back1[3] = {-1, 0, 0}, fwd1[3] = {1, 0, 0};
		H9RallyAccelerate(v1, back1, 1200, 0.085f, 1.0f, 0.01f, -10000);
		H9RallyAccelerate(v2, fwd1, 1200, 0.085f, 1.0f, 0.01f, 10000);
		Check(v1[0] == -150.0f && fabsf(v2[0] - (150.0f + 0.085f * 1200 * 0.01f)) < 1e-3f, "reverse: no pull backwards over 100 u/s; forward pull 1.02 per 10 ms frame");
	}

	// --- rows 26 and 64: the brakes are not applied while reversing (HLR rally.c:1184 `if (forwardmove >= 0)`) ------------------
	{
		H9RallyInput hand;
		hand.hand = true;
		const float fwd[3] = {1, 0, 0}, right[3] = {0, -1, 0};
		float a[3] = {-30, 0, 0}, b[3] = {-30, 0, 0};
		H9RallyFriction(a, fwd, right, hand, -10000.0f, 1.0f, 0.0f, 0.8f, kMvFriction, 0.01f); // handbrake while reversing: no brake
		H9RallyFriction(b, fwd, right, hand, 0.0f, 1.0f, 0.0f, 0.8f, kMvFriction, 0.01f);     // handbrake with no move: the brake
		// at -30 u/s going backwards, align is |v.f| / |v| = 1 when reversing; the drag takes 0.25 dt of it and the brake 150 align dt = 1.5 more
		Check(fabsf(a[0] - (-30.0f * (1.0f - 0.0025f))) < 0.01f, "handbrake while reversing does not brake (HL Rally brakes only when forwardmove >= 0)");
		// not reversing the same velocity has align = 0.05 (it is going backwards against the nose): 150 * 0.05 * dt = 0.075 against the velocity's direction
		Check(fabsf(b[0] - (-30.0f * (1.0f - 0.0025f) * (1.0f - 0.95f * 0.0025f) + 0.075f)) < 0.005f, "with forwardmove 0 the handbrake brakes by 150 * align * dt (align 0.05 here: 0.075 u/s in 10 ms, after the drag and the slide's)");
		// and over a long press, overshooting: HL's brake takes 1.5 u/s from a car at 2 u/s in one frame, which reverses it
		float c[3] = {2, 0, 0};
		H9RallyFriction(c, fwd, right, hand, 0.0f, 1.0f, 0.0f, 0.8f, kMvFriction, 0.01f);
		Check(c[0] < 0.6f && c[0] > 0.4f, "the brake is not clamped at zero: it takes 150 * 0.01 = 1.5 off 2 u/s in a frame (it overshoots under 1.5)");
		float d[3] = {1, 0, 0};
		H9RallyFriction(d, fwd, right, hand, 0.0f, 1.0f, 0.0f, 0.8f, kMvFriction, 0.01f);
		Check(d[0] < 0, "and a car at 1 u/s is sent backwards by it: HL Rally's overshoot, not ours");
	}

	// --- steering --------------------------------------------------------------------------------------------------
	{
		Check(fabsf(H9RallySteer(1, 0.01f) - 4.0f) < 1e-4f, "steering: 400 degrees a second, 4 degrees in a 10 ms frame, at any speed");
		Check(H9RallySteer(0, 0.5f) == 0, "steering: no key, no turn");
		Check(fabsf(H9RallySteer(1, 0.02f) + H9RallySteer(-1, 0.02f)) < 1e-5f, "steering: left and right turn alike");
	}

	// --- left and right alike ------------------------------------------------------------------------------------
	{
		for (int su = 0; su < H9RS_COUNT; su += 2)
		{
			Sim l, r;
			l.surface = r.surface = su;
			l.SetBody(300, 0);
			r.SetBody(300, 0);
			l.Run(2.0f, true, false, 1, false);
			r.Run(2.0f, true, false, -1, false);
			snprintf(what, sizeof what, "left and right mirror each other (%s)", g_h9RallySurfaces[su].name);
			Check(fabsf(l.Vf() - r.Vf()) < 0.05f && fabsf(l.Vs() + r.Vs()) < 0.05f && fabsf(l.heading + r.heading) < 0.001f &&
					  fabsf(l.y + r.y) < 0.2f && fabsf(l.x - r.x) < 0.2f,
				  what);
		}
	}

	// --- rows 20 and 54: the sideways hold is Euler, once per command, with the command's length -------------------------
	// HLR rally.c:1164-1169: velocity -= right * (velocity.right) * LATERAL_FRICTION * frametime, i.e. the sideways speed times
	// (1 - LAT dt). At 40 u/s, handling 0.8, no key: LAT = 75 * (1 / (40 / 30)) * 0.8 = 45 (rally.c:1043-1047, 1104), whose keep per frame
	// is 0.55 at 100 fps and 0.25 at 60 fps; at 20 u/s LAT is held at the 75 of LAT_MAX and the keep is 0.25 at 100 fps and -0.25 at 60 fps.
	{
		const float fps[2] = {100.0f, 60.0f};
		const float speeds[2] = {40.0f, 20.0f};
		for (int si = 0; si < 2; si++)
			for (int fi = 0; fi < 2; fi++)
			{
				const float dt = 1.0f / fps[fi];
				Sim s;
				s.dt = dt;
				// a nose-aligned car with a small sideways speed (so align and the speed stay what they are)
				s.SetBody(speeds[si], 0.4f);
				const float vs0 = s.Vs();
				s.Step(false, false, 0, false);
				// per HL: the drag takes (1 - 0.25 dt) of all of v, then the sideways hold (1 - LAT dt), then the slide's (1 - align) 0.25 dt
				const float sp0 = sqrtf(speeds[si] * speeds[si] + 0.16f);
				const float align = fmaxf(0.05f, speeds[si] / sp0);
				const float latWant = fminf(75.0f, 75.0f * 30.0f / sp0 * align * align * align * 0.8f);
				const float keepWant = (1.0f - 0.25f * dt) * (1.0f - latWant * dt) * (1.0f - (1.0f - align) * 0.25f * dt);
				const float gotKeep = s.Vs() / vs0;
				snprintf(what, sizeof what, "sideways keep per frame at %.0f u/s (LAT %.1f), %.0f fps: %.3f, HL's (1 - LAT dt) says %.3f", speeds[si], s.lat, fps[fi], gotKeep, keepWant);
				Check(fabsf(s.lat - latWant) < 0.05f && fabsf(gotKeep - keepWant) < 0.002f, what);
			}
		// the audit's numbers: LAT 45 keeps 0.55 at 100 fps and 0.25 at 60 fps; LAT 75 keeps -0.25 at 60 fps (it flips sign)
		Check(fabsf((1 - 45.0f / 100) - 0.55f) < 1e-6f && fabsf((1 - 45.0f / 60) - 0.25f) < 1e-6f && fabsf((1 - 75.0f / 60) + 0.25f) < 1e-6f,
			  "the audit's per-frame keeps follow from (1 - LAT dt): 0.55 and 0.25 for LAT 45, -0.25 for LAT 75 at 60 fps");
		// and so a frame's length does change the car: the same slide at 100 and 60 fps does not end the same
		Sim a, b;
		a.dt = 0.01f;
		b.dt = 1.0f / 60.0f;
		a.SetBody(40, 6);
		b.SetBody(40, 6);
		a.Run(0.05f, false, false, 0, false);
		b.Run(0.05f, false, false, 0, false);
		snprintf(what, sizeof what, "Euler per command: the sideways speed left after 0.05 s is %.4f at 100 fps and %.4f at 60 fps (not the same car)", a.Vs(), b.Vs());
		Check(fabsf(a.Vs() - b.Vs()) > 0.002f && a.Vs() > 0 && b.Vs() > 0, what);
	}

	// --- row 32: the live friction: LAT_MAX follows sv_friction ---------------------------------------------------------------------
	{
		const float fwd[3] = {1, 0, 0}, right[3] = {0, -1, 0};
		float v[3] = {20, 5, 0};
		const H9RallyFrictionResult lo = H9RallyFriction(v, fwd, right, H9RallyInput(), 0.0f, 1.0f, 0.0f, 1.0f, 0.25f, 0.01f);
		float w[3] = {20, 5, 0};
		const H9RallyFrictionResult hi = H9RallyFriction(w, fwd, right, H9RallyInput(), 0.0f, 1.0f, 0.0f, 1.0f, 4.0f, 0.01f);
		Check(fabsf(lo.lat - 75.0f) < 1e-3f && fabsf(hi.lat - 1200.0f) < 1e-2f, "sv_friction is read live: LAT_MAX is friction * 300 (75 at 0.25, 1200 at 4)");
	}

	// --- row 27: a car at rest on a slope rolls, and the zeroing is gone ---------------------------------------------------------------
	// HLR rally.c:545-551 only skips the move under 1 u/s; the velocity is kept. On a 10 degree plane gravity along it is 520 sin 10 = 90.3 u/s^2
	// and nothing holds the car: its speed follows v' = a - 0.25 v, a / 0.25 (1 - e^-0.25 t), about 80 u/s after a second. The plane is the
	// ideal one: what gravity pushes into the floor is taken out each command, as the trace's slide does it.
	{
		const float th = 10.0f * (float)(M_PI / 180.0);
		const float n[3] = {sinf(th), 0, cosf(th)}; // the plane's normal (tilted toward +x)
		const float fwd[3] = {cosf(th), 0, -sinf(th)}; // the nose down the slope
		const float right[3] = {0, -1, 0};
		float v[3] = {0, 0, 0};
		const float dt = 0.01f;
		float first = 0;
		for (int i = 0; i < 100; i++)
		{
			v[2] = H9RallyGravityHalf(v[2], 1.0f, 520.0f, dt);
			H9RallyFriction(v, fwd, right, H9RallyInput(), 0.0f, 1.0f, 0.0f, 0.8f, kMvFriction, dt);
			v[2] = H9RallyGravityHalf(v[2], 1.0f, 520.0f, dt);
			const float into = H9RDot(v, n);
			for (int k = 0; k < 3; k++)
				v[k] -= n[k] * into;
			if (i == 0)
				first = H9RLen(v);
		}
		const float a = 520.0f * sinf(th);
		const float want = a / 0.25f * (1.0f - powf(1.0f - 0.25f * dt, 100.0f));
		snprintf(what, sizeof what, "a parked car on a 10 degree slope rolls: %.1f u/s after 1 s (a = %.1f, a/0.25 (1 - (1 - 0.25 dt)^100) = %.1f); the old zeroing kept it still", H9RLen(v), a, want);
		Check(fabsf(H9RLen(v) - want) < 0.03f * want && first > 0.5f && H9RLen(v) > 50.0f, what);
		// and a car with nothing pressed under 1 u/s is not zeroed by the friction
		float slow[3] = {0.4f, 0, 0};
		H9RallyFriction(slow, fwd, right, H9RallyInput(), 0.0f, 1.0f, 0.0f, 0.8f, kMvFriction, 0.01f);
		Check(slow[0] > 0.3f, "nothing zeroes a car under 1 u/s: the friction leaves 0.4 u/s about 0.4");
	}

	// --- row 28: no snapping to the ground: a car leaves a crest when the ground falls away faster than gravity -------------------------
	// The ground falls at v tan(a) u/s under a car going v u/s; the car (vz = 0 at the crest) falls 520 t^2 / 2, so it stands
	// s t - 260 t^2 above the ground, at most s^2 / 1040 (HLR has no follow: pm_shared.c:875 "this valve crap is no longer needed"). The
	// ground test looks 2 units down (pm_shared.c:808-815), so the car is in the air only once the gap passes 2.
	// The audit's example, 5 degrees at 400 u/s, drops the ground 35 u/s: a gap of at most 1.18, inside the 2-unit reach, so even HL Rally's car
	// stays on the ground there; a 10 degree lip (70.5 u/s, up to 4.78) is the one that flies.
	{
		const float dt = 0.01f;
		const float angles[2] = {5.0f, 10.0f};
		float peak[2];
		for (int ai = 0; ai < 2; ai++)
		{
			const float s = 400.0f * tanf(angles[ai] * (float)(M_PI / 180.0));
			float z = 0, vz = 0, zs = 0, maxGap = 0;
			int airborneFrames = 0;
			for (int i = 0; i < 100; i++)
			{
				vz = H9RallyGravityHalf(vz, 1.0f, 520.0f, dt);
				z += vz * dt;
				vz = H9RallyGravityHalf(vz, 1.0f, 520.0f, dt);
				zs -= s * dt;
				if (z < zs) // the car would be in the ground: it stands on it (the trace stops it)
				{
					z = zs;
					vz = -s; // along the slope
				}
				const float gap = z - zs;
				if (gap > maxGap)
					maxGap = gap;
				if (gap > H9R_GROUND_REACH)
					airborneFrames++;
			}
			peak[ai] = maxGap;
			const float want = s * s / (2.0f * 520.0f);
			snprintf(what, sizeof what, "%.0f degree lip at 400 u/s (ground drops %.1f u/s): the car stands up to %.2f above it (s^2 / 2g = %.2f), %d frames beyond the 2-unit reach",
					 angles[ai], s, maxGap, want, airborneFrames);
			Check(fabsf(maxGap - want) < 0.08f, what);
		}
		Check(peak[0] < H9R_GROUND_REACH && peak[1] > H9R_GROUND_REACH, "a 5 degree lip stays inside the ground reach; a 10 degree one leaves the ground, and nothing snaps it back");
	}

	// --- row 29: the gravity in two halves around the move ------------------------------------------------------------------
	// HLR pm_shared.c:476-496: half before, half after, the move with the mid-frame velocity: after n frames of a fall the height is
	// exactly g t^2 / 2 (the whole-before form, ours until now, fell g dt t / 2 more: 2.6 u after a second at 100 fps)
	{
		const float dt = 0.01f;
		float z = 0, vz = 0;
		for (int i = 0; i < 100; i++)
		{
			vz = H9RallyGravityHalf(vz, 1.0f, 520.0f, dt);
			z += vz * dt;
			vz = H9RallyGravityHalf(vz, 1.0f, 520.0f, dt);
		}
		snprintf(what, sizeof what, "free fall for 1 s at 100 fps in two halves: %.4f down (g t^2 / 2 = 260), speed %.2f (520)", -z, -vz);
		Check(fabsf(z + 260.0f) < 0.01f && fabsf(vz + 520.0f) < 0.01f, what);
		Check(fabsf(H9RallyGravityHalf(0, 0.5f, 800.0f, 0.01f) + 2.0f) < 1e-5f, "the half gravity takes the entity's gravity and sv_gravity: 0.5 * 800 * 0.5 * 0.01 = 2");
	}

	// --- rows 9 and 11: the engine's pull ---------------------------------------------------------------------------------------------------
	{
		const float fwd[3] = {1, 0, 0};
		float a[3] = {0, 0, 0}, b[3] = {0, 0, 0}, c[3] = {0, 0, 0}, d[3] = {0, 0, 0};
		H9RallyAccelerate(a, fwd, 1200, 0.085f, 1.0f, 0.01f, 10000);
		H9RallyAccelerate(b, fwd, 1200, 0.085f, 0.05f, 0.01f, 10000);
		H9RallyAccelerate(c, fwd, 1200, 0.085f, 3.0f, 0.01f, 10000);
		H9RallyAccelerate(d, fwd, 1200, 0.17f, 1.0f, 0.01f, 10000); // sv_accelerate read live
		Check(fabsf(a[0] - 1.02f) < 1e-4f && fabsf(b[0] - 0.051f) < 1e-4f && fabsf(c[0] - 3.06f) < 1e-4f && fabsf(d[0] - 2.04f) < 1e-4f,
			  "pull = accelerate * dt * wishspeed * pmove->friction, unclamped: 1.02 at friction 1, 0.051 at 0.05, 3.06 at 3 (rally.c:1001); accelerate live");
		float e[3] = {1199.5f, 0, 0};
		H9RallyAccelerate(e, fwd, 1200, 0.085f, 1.0f, 0.01f, 10000);
		Check(fabsf(e[0] - 1200.0f) < 1e-3f, "the pull stops at the wish speed (addspeed)");
	}

	// --- rows 24 and 25: the texture names ----------------------------------------------------------------------------------------------------
	// HLR pm_shared.c:328-359 and rally.c:1112: the name loses "-0"/"+0" (two characters) and one of { ! ~ space, is cut to 12 characters,
	// and is matched case-sensitively with strstr against lower-case words; the first four rows, then road/street/rock on top.
	{
		struct
		{
			const char* name;
			int want;
			float drag;
		} names[] = {
			{"wntr_snow1", H9RS_SNOW, 0}, {"wntr_cliff2", H9RS_NEUTRAL, 0}, {"wntr_ground", H9RS_NEUTRAL, 0}, {"WNTR_SNOW", H9RS_NEUTRAL, 0},
			{"sand01", H9RS_SAND, 0}, {"desert_rock", H9RS_SAND, -0.10f}, {"{sand_dune", H9RS_SAND, 0}, {"dirt2", H9RS_DIRT, 0},
			{"DIRT_1", H9RS_NEUTRAL, 0}, {"Sand", H9RS_NEUTRAL, 0}, {"mud_brown", H9RS_DIRT, 0}, {"gras03", H9RS_GRASS, 0}, {"road_dash", H9RS_ROAD, 0},
			{"street_a", H9RS_ROAD, 0}, {"rock_big", H9RS_ROAD, 0}, {"dirt_road", H9RS_DIRT, -0.10f}, {"+0snow", H9RS_SNOW, 0}, {"-0sand", H9RS_SAND, 0},
			{"+0~snow", H9RS_SNOW, 0}, {"!dirt", H9RS_DIRT, 0}, {" mud", H9RS_DIRT, 0},
			{"abcdefghijsand", H9RS_NEUTRAL, 0}, // the word starts at the 11th character: cut away at 12
			{"abcdefghsand", H9RS_SAND, 0},      // and ends at the 12th: kept
			{"office01", H9RS_NEUTRAL, 0}, {"template", H9RS_NEUTRAL, 0},
			{"road_tarmac", H9RS_ROAD, 0}, {"tarmac_pit", H9RS_NEUTRAL, 0}, {"asphalt", H9RS_NEUTRAL, 0}, {"gravel_track", H9RS_NEUTRAL, 0},
			{"stand_conc", H9RS_NEUTRAL, 0}, {"pole_metal", H9RS_NEUTRAL, 0}, {"ice1", H9RS_NEUTRAL, 0}, {"pack_dirt", H9RS_DIRT, 0}, {"", H9RS_NEUTRAL, 0},
			{"-", H9RS_NEUTRAL, 0}, {"unknown_wall", H9RS_NEUTRAL, 0},
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
		Check(all, "texture names map to HL Rally's surfaces only: case-sensitive, 12 characters, no invented surfaces (tarmac, gravel, concrete, metal, ice are neutral)");
		Check(H9RallySurfaceByName(nullptr) == H9RS_NEUTRAL, "no name is neutral");
		Check(H9RS_COUNT == 6, "the surfaces are neutral, road, dirt, grass, sand, snow: six");
	}

	// --- row 40: walls -------------------------------------------------------------------------------------------------------------------------
	// HLR rally.c:733-740: velocity -= normal * (velocity.normal) * 1.2 whenever the body trace meets the wall, going in or away
	{
		Check(fabsf(H9RallyCrashKeep(-1.0f) - 1.0f / 3.0f) < 1e-5f, "a head-on crash keeps a third of the speed");
		Check(fabsf(H9RallyCrashKeep(1.0f) - 1.0f) < 1e-5f, "grazing a wall keeps all of it");
		const float n[3] = {1, 0, 0};
		float v[3] = {-400, 0, 0};
		H9RallyCrashVelocity(v, n); // first contact: -400 -> -400 + 480 = +80, kept 1/3: +26.67
		const float first = v[0];
		H9RallyCrashVelocity(v, n); // the next frame still touching: 26.67 - 32 = -5.33, kept 1/3: -1.78
		const float second = v[0];
		snprintf(what, sizeof what, "head-on at 400: +%.2f after the first contact (80 / 3), %.2f after the second frame's (-5.33 / 3): the wall scrubs, it does not let go", first, second);
		Check(fabsf(first - 80.0f / 3.0f) < 0.01f && fabsf(second - (80.0f / 3.0f - 1.2f * 80.0f / 3.0f) / 3.0f) < 0.01f && second < 0, what);
		// a graze: 400 along the wall, 40 into it
		float g[3] = {-40, 400, 0};
		H9RallyCrashVelocity(g, n);
		const float tx = -40 + 48, ty = 400; // the reflection: -40 - 1.2 * (-40) = +8
		const float len = sqrtf(tx * tx + ty * ty), lo = sqrtf(40.0f * 40.0f + 400.0f * 400.0f);
		const float c = (tx * -40 + ty * 400) / (len * lo);
		const float keep = (c + 2.0f) / 3.0f;
		Check(fabsf(g[0] - tx * keep) < 0.01f && fabsf(g[1] - ty * keep) < 0.01f && keep > 0.99f, "a graze keeps the along-wall speed by (2 + cos) / 3: nearly all of it for a 11 degree turn");
		float away[3] = {50, 0, 0};
		H9RallyCrashVelocity(away, n);
		Check(away[0] < 0, "a car already leaving the wall is turned back too (HL Rally reflects whenever the trace hits)");
		float zero[3] = {0, 0, 0};
		H9RallyCrashVelocity(zero, n);
		Check(zero[0] == 0 && zero[1] == 0 && zero[2] == 0, "a car at rest against a wall stays at rest (no NaN)");
	}

	// --- rows 45 and 46: the car's own clipping ------------------------------------------------------------------------------------------------
	// HLR pm_shared.c:441-473 (no epsilon zeroing) and rally.c:787-966: air or friction != 1: every plane, floors (nz over 0.9) at
	// overbounce 1 and carried on, the others at 1.1 off the carried velocity and not carried on
	{
		const float n[3] = {0, 0, 1};
		float out[3];
		const float inv[3] = {100, 0.03f, -0.05f};
		H9RallyClip(inv, n, 1.0f, out);
		Check(out[0] == 100.0f && out[1] == 0.03f && out[2] == 0.0f, "clip: no epsilon zeroing (a 0.03 u/s component is left; TS's PM_ClipVelocity would zero it)");
		const float wall[3] = {1, 0, 0};
		const float in2[3] = {-10, 0, 0};
		H9RallyClip(in2, wall, 1.1f, out);
		Check(fabsf(out[0] - 1.0f) < 1e-5f, "a wall clips at 1.1: -10 into it comes back +1");
		float planes[2][3] = {{1, 0, 0}, {0, 1, 0}};
		float orig[3] = {-10, -10, 0}, res[3];
		H9RallyClipPlanesAir(orig, planes, 2, res);
		Check(fabsf(res[0] - -10.0f) < 1e-5f && fabsf(res[1] - 1.0f) < 1e-5f, "two walls in the air: the last plane's 1.1 clip of the carried (unchanged) velocity, as HL Rally's quirk has it");
		float planes2[2][3] = {{0, 0, 1}, {1, 0, 0}};
		float orig2[3] = {-10, 0, -20}, res2[3];
		H9RallyClipPlanesAir(orig2, planes2, 2, res2);
		Check(fabsf(res2[2]) < 1e-5f && fabsf(res2[0] - 1.0f) < 1e-5f && orig2[2] == 0.0f, "a floor (nz over 0.9) clips at 1 and is carried to the next plane");
		float planes3[1][3] = {{0.8f, 0, 0.6f}};
		float res3[3], c3[3] = {0, 0, -10};
		H9RallyClipPlanesAir(c3, planes3, 1, res3);
		const float back3 = -6.0f * 1.1f; // v.n = -6, at 1.1 (nz 0.6 is not over 0.9)
		Check(fabsf(res3[2] - (-10.0f - 0.6f * back3)) < 1e-4f, "a 53 degree plane (nz 0.6) is a wall to the clip: overbounce 1.1");
	}

	// --- rows 35 and 36: the tilt -----------------------------------------------------------------------------------------------------------------
	// HLR rally.c:150-259: four terrain points at 8 to the side and 12 ahead/behind; two cross-product triangles averaged; pitch and roll
	// from the normal turned into the car's yaw. Flat: nothing. A rise ahead of 10 degrees: pitch -10 (the engine's pitch is positive down).
	{
		float pitch = 99, roll = 99;
		const float flat1[3] = {12, -8, 0}, flat2[3] = {12, 8, 0}, flat3[3] = {-12, -8, 0}, flat4[3] = {-12, 8, 0};
		H9RallyTilt(flat1, flat2, flat3, flat4, 0, &pitch, &roll);
		Check(fabsf(pitch) < 0.01f && fabsf(roll) < 0.01f, "tilt: flat ground gives no pitch and no roll");
		const float t = tanf(10.0f * (float)(M_PI / 180.0));
		// yaw 0: forward +x, right -y. Terrain rising ahead: z = t x
		const float f1[3] = {12, -8, 12 * t}, f2[3] = {12, 8, 12 * t}, b1[3] = {-12, -8, -12 * t}, b2[3] = {-12, 8, -12 * t};
		H9RallyTilt(f1, f2, b1, b2, 0, &pitch, &roll);
		snprintf(what, sizeof what, "tilt: a 10 degree rise ahead gives pitch %.2f (nose up is negative) and roll %.2f", pitch, roll);
		Check(fabsf(pitch + 10.0f) < 0.05f && fabsf(roll) < 0.05f, what);
		// rising to the car's left (+y): z = t y
		const float g1[3] = {12, -8, -8 * t}, g2[3] = {12, 8, 8 * t}, g3[3] = {-12, -8, -8 * t}, g4[3] = {-12, 8, 8 * t};
		H9RallyTilt(g1, g2, g3, g4, 0, &pitch, &roll);
		snprintf(what, sizeof what, "tilt: ground rising 10 degrees to the left gives roll %.2f and pitch %.2f", roll, pitch);
		Check(fabsf(fabsf(roll) - 10.0f) < 0.05f && fabsf(pitch) < 0.05f, what);
		// the same rise, the car turned 90 degrees (facing +y): the rise that was ahead is now at its side
		H9RallyTilt(f1, f2, b1, b2, 90.0f, &pitch, &roll);
		Check(fabsf(pitch) < 0.05f && fabsf(fabsf(roll) - 10.0f) < 0.05f, "tilt: the terrain's normal is turned into the car's heading: facing +y the +x rise is a roll");
	}

	// --- rows 3, 4, 5: the pull is the command's forward move (rally.c:518-540), with no gear cap of ours ----------------------------------------------
	{
		const H9RallyCar& x = g_h9RallyCars[0]; // xsara, wish 80 * 15 = 1200
		// wishspeed = |fmove|, cut to the car's top speed (rally.c:530-537: the cut is pmove->maxspeed, TopSpeed * 15)
		Check(H9RallyWishSpeed(0.0f, H9RallyWish(x)) == 0.0f && H9RallyWishSpeed(500.0f, H9RallyWish(x)) == 500.0f && H9RallyWishSpeed(-500.0f, H9RallyWish(x)) == 500.0f,
			  "wish speed: the size of the command's forward move; 0 is no pull");
		Check(H9RallyWishSpeed(3000.0f, H9RallyWish(x)) == 1200.0f && H9RallyWishSpeed(-10000.0f, H9RallyWish(x)) == 1200.0f,
			  "wish speed: cut to the car's top speed, 1200 for TopSpeed 80, forwards and backwards");
		// gear 6 at 400 u/s: the client sends 400 + 108.3 * 30 * 78 / 400 = 1033.5 (input.cpp:988), under the 1200: the pull is accel * dt * 1033.5
		const float fm = 400.0f + 108.3f * 30.0f * 78.0f / 400.0f;
		float v[3] = {400, 0, 0};
		const float dir[3] = {1, 0, 0};
		H9RallyAccelerate(v, dir, H9RallyWishSpeed(fm, H9RallyWish(x)), H9R_ACCELERATE, 1.0f, 0.01f, fm);
		Check(fabsf(v[0] - (400.0f + 0.085f * 0.01f * fm)) < 1e-3f, "pull in gear 6 at 400 u/s: the wish is the client's 1033, not the car's 1200");
		// revs 200 and up and 50 u/s: the client sends the speed itself (input.cpp:990), the pull has nothing to add: the cap needs no rule of ours
		float w[3] = {800, 0, 0};
		H9RallyAccelerate(w, dir, H9RallyWishSpeed(800.0f, H9RallyWish(x)), H9R_ACCELERATE, 1.0f, 0.01f, 800.0f);
		Check(w[0] == 800.0f, "revs up: the move is the speed along the nose, so there is no pull (the gear cap of an earlier version needs no code)");
		// slipping sideways the speed along the nose is less than the speed: the same move then does pull, a little (HL Rally's own behaviour)
		float u[3] = {600, 300, 0};
		const float hs = sqrtf(600.0f * 600.0f + 300.0f * 300.0f);
		H9RallyAccelerate(u, dir, H9RallyWishSpeed(hs, H9RallyWish(x)), H9R_ACCELERATE, 1.0f, 0.01f, hs);
		Check(u[0] > 600.0f, "a slide with the revs up: the move is the whole speed, the nose has less of it, so there is a pull");
		// the reverse move: the back key under 40 u/s sends -10000 -> wish 1200 along -nose, until the car is over 100 u/s backwards (rally.c:1007-1011)
		float b[3] = {-10, 0, 0};
		const float back[3] = {-1, 0, 0};
		H9RallyAccelerate(b, back, H9RallyWishSpeed(-10000.0f, H9RallyWish(x)), H9R_ACCELERATE, 1.0f, 0.01f, -10000.0f);
		Check(fabsf(b[0] - (-10.0f - 0.085f * 0.01f * 1200.0f)) < 1e-4f, "reverse pull: accel * dt * the 1200 wish");
	}

	// --- row 36 / I11: the tilt kept in vuser4 and vuser3.x (h9_rally.h H9RallyTiltPack; HL Rally keeps it in vuser1: rally.c:218, :254-255) -------------------
	{
		float mark, ang[3], p, y, r;
		H9RallyTiltPack(-12.3f, 91.0f, 7.26f, &mark, ang);
		Check(H9RallyTiltUnpack(mark, ang, &p, &y, &r) && fabsf(p - (-12.5f)) < 1e-4f && fabsf(y - 91.0f) < 1e-4f && fabsf(r - 7.5f) < 1e-4f,
			  "tilt: pitch, yaw and roll survive the field in half degrees");
		Check(!H9RallyTiltUnpack(0.0f, ang, &p, &y, &r) && !H9RallyTiltUnpack(1.0f, ang, &p, &y, &r), "tilt: a field that is not marked (a weapon's value, zero) is no tilt");
		bool wire = true; // the wire carries a signed 10 bit integer (game/ts/delta.lst): -512 to 511
		for (float yaw = -180.0f; yaw <= 180.0f; yaw += 7.0f)
		{
			H9RallyTiltPack(270.0f - yaw, yaw, yaw, &mark, ang);
			for (int i = 0; i < 3; i++)
				if (ang[i] < -512.0f || ang[i] > 511.0f || ang[i] != floorf(ang[i]))
					wire = false;
		}
		Check(wire && mark < 511.0f, "tilt: every packed value is an integer inside the wire's 10 bits, the mark too");
		H9RallyTiltPack(359.0f, -181.0f, 0.0f, &mark, ang);
		H9RallyTiltUnpack(mark, ang, &p, &y, &r);
		Check(fabsf(p - (-1.0f)) < 1e-4f && fabsf(y - 179.0f) < 1e-4f, "tilt: angles are wrapped to -180..180 before they are packed");
		// in the air the pitch and roll go to 0 and the yaw stays (rally.c:254-255): what pmove packs is H9RallyTiltPack(0, yaw0, 0)
		H9RallyTiltPack(0.0f, 33.0f, 0.0f, &mark, ang);
		H9RallyTiltUnpack(mark, ang, &p, &y, &r);
		Check(p == 0.0f && r == 0.0f && fabsf(y - 33.0f) < 1e-4f, "tilt: in the air pitch and roll are 0 and the yaw is kept");
	}

	// --- row 58: the finish ----------------------------------------------------------------------------------------------------------------------------
	// HLR input.cpp:818-832: after the line the back key alone while the horizontal speed is over 20, then no key
	{
		const H9RallyInput fast = H9RallyFinishKeys(120.0f), slow = H9RallyFinishKeys(20.0f), still = H9RallyFinishKeys(0);
		Check(fast.back && !fast.forward && !fast.hand && !fast.steering && !slow.back && !still.back && !slow.forward,
			  "finish: over 20 u/s the back key alone, at 20 and under no key at all");
		// the client sends no forward move after the finish (its drive block is skipped, input.cpp:818-835), whatever the speed: pmove takes it as 0
		// (pm_shared/h9_rally.cpp), so the 20 to 40 u/s band is the brake, not the reverse pull the older rule made of the back key
		Check(fast.back && slow.back == false && H9RallyWishSpeed(0.0f, 1200.0f) == 0.0f, "finish: no forward move at any speed, so no pull and no reverse");
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
			s.SetBody((float)(rand() % 2600 - 1300) * 0.8f, (float)(rand() % 1200 - 600));
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
					s.dt = 0.005f + (float)(rand() % 20) * 0.001f; // 5 to 24 ms commands: the sideways hold stays under LAT dt 2
				}
				s.Step(fw, bk, st, hb);
				if (!std::isfinite(s.v[0]) || !std::isfinite(s.v[1]) || !std::isfinite(s.heading) || !std::isfinite(s.x) || !std::isfinite(s.y))
					finite = false;
				if (s.Speed() > base + 1.0f)
				{
					if (bounded)
						printf("     run %d step %d: speed %.0f over %.0f (start %.0f, surface %d)\n", run, i, s.Speed(), base, start, s.surface);
					bounded = false;
				}
			}
		}
		Check(finite, "400 random drives with 5 to 24 ms commands: no NaN, no infinity");
		Check(bounded, "the same drives never gain speed the engine cannot give");
		Sim z;
		z.dt = 0.0f;
		z.Step(true, false, 1, true);
		Check(std::isfinite(z.v[0]) && std::isfinite(z.heading), "a zero-length frame is harmless");
	}


	// --- sounds: the horn and the landing, the two the server plays (dlls/h9_rally_snd.h) -----------------------------
	{
		// HL Rally's horn (dlls/rally_horn.cpp): held, once at once, then every second; the key up plays nothing
		float next = 0.0f;
		Check(RallySndHornStep(true, next, 5.0f) && fabsf(next - 6.0f) < 1e-5f, "sound: the horn sounds at once when the key goes down");
		Check(!RallySndHornStep(true, next, 5.5f), "sound: and not again inside the second");
		Check(!RallySndHornStep(false, next, 6.5f), "sound: not without the key");
		Check(RallySndHornStep(true, next, 6.01f) && fabsf(next - 7.01f) < 1e-4f, "sound: held, it repeats once a second");
		Check(fabsf(RSND_HORN_REPEAT - 1.0f) < 1e-6f, "sound: the repeat is 1 second (rally_horn.cpp: fHornTime = time + 1)");
		// pm_shared.c:859: every landing at 0.2, pitch 100; a one-shot's 200/255 (rally_sound.cpp:134)
		Check(fabsf(RSND_LAND_VOL - 0.2f) < 1e-6f && RSND_LAND_PITCH == 100, "sound: a landing is 0.2 at pitch 100");
		Check(fabsf(RSND_ONESHOT_VOL - 200.0f / 255.0f) < 1e-3f, "sound: a one-shot is 200/255 of the file's volume");
	}


	// --- the decisions pmove makes (pm_shared/h9_rally.h) ---------------------------------------------------------
	{
		Check(!H9RallyHeld(0) && H9RallyHeld(H9R_FL_FROZEN) && H9RallyHeld(H9R_FL_FROZEN | 0x1) && !H9RallyHeld(~H9R_FL_FROZEN),
			"held: FL_FROZEN holds a car and nothing else does (maxspeed is not even an argument)");
		Check(H9RallyGroundReach(0) == 16.0f && H9RallyGroundReach(5.0f) == 16.0f && H9RallyGroundReach(5.1f) == 2.0f && H9RallyGroundReach(700) == 2.0f,
			"ground: the reach is 16 at rest (5 u/s or under) and 2 above");
		// row 35, HLR pm_shared.c:808-840: any hit at all is ground (`onground = tr.ent`), whatever its slope; none is air; only going up faster than 1800 is air
		Check(H9RallyIsGround(0, 0) && H9RallyIsGround(0, 180) && H9RallyIsGround(7, 0), "ground: any hit is ground, going up at 180 included (the old limit)");
		Check(H9RallyIsGround(0, 1800) && !H9RallyIsGround(0, 1800.5f), "ground: only above 1800 up is the car in the air");
		Check(!H9RallyIsGround(-1, 0), "ground: no hit is air");
		Check(H9RallyIsGround(0, -300), "ground: a car going down onto it is on it");
		Check(H9RallySteppedWins(10, 10) && H9RallySteppedWins(5, 10) && !H9RallySteppedWins(10.5f, 10), "kerb: the stepped move wins a tie, the slide only if it went farther");
		Check(!H9RallyCrashIgnores(true, 1.0f) && !H9RallyCrashIgnores(true, 0.9f) && H9RallyCrashIgnores(false, 0.5f) && !H9RallyCrashIgnores(false, 0.2f) &&
				  !H9RallyCrashIgnores(false, 0.3f) && H9RallyCrashIgnores(false, 0.31f),
			"crash: on the ground no plane passes; in the air a plane with nz over 0.3 does");
		{
			const H9RallySides rest = H9RallyCrashSides(3, 2, 3.6f);
			const H9RallySides fl = H9RallyCrashSides(200, 50, 206.0f);
			const H9RallySides br = H9RallyCrashSides(-200, -50, 206.0f);
			const H9RallySides edge = H9RallyCrashSides(7, 7, 10.0f);
			Check(rest.front && rest.back && rest.left && rest.right && edge.front && edge.back && edge.left && edge.right,
				"crash: at 10 u/s and under all four sides are traced");
			Check(fl.front && !fl.back && fl.left && !fl.right && br.back && !br.front && br.right && !br.left,
				"crash: above it only the sides the car goes toward");
			float p[64][3];
			const int nAll = H9RallyCrashPoints(rest, 4.0f, p, 64);
			float lowest = 1000, hz4 = 0, hz12 = 0;
			bool inside = true;
			for (int i = 0; i < nAll; i++)
			{
				lowest = fminf(lowest, p[i][2]);
				inside = inside && fabsf(p[i][0]) <= H9R_LENGTH * 0.5f + 0.01f && fabsf(p[i][1]) <= H9R_WIDTH * 0.5f + 0.01f;
				if (p[i][2] == 4.0f)
					hz4++;
				if (p[i][2] == 12.0f)
					hz12++;
			}
			const int nTwo = H9RallyCrashPoints(fl, 4.0f, p, 64);
			Check(nAll == 2 * (4 + 4 + 5 + 5) && nTwo == 2 * (4 + 5), "crash: 4 points on a front or back, 5 on a side, at two heights");
			Check(inside && hz4 == hz12 && hz4 + hz12 == (float)nAll, "crash: the points are on the 45 x 18 outline at heights 4 and 12");
			Check(lowest >= 4.0f && lowest > 2.0f, "crash: no trace goes lower than 4 above the origin (a 1-2 unit raised strip is no wall)");
			// the heights follow sv_stepsize (rally.c's `for (v = stepsize; v < CarHeight; v += 8)`): 12 gives one row, 18 none
			Check(H9RallyCrashPoints(rest, 12.0f, p, 64) == 18 && p[0][2] == 12.0f && H9RallyCrashPoints(rest, 18.0f, p, 64) == 0,
				"crash: the heights are sv_stepsize, sv_stepsize + 8 ... while under 16: one row at 12, none at 18");
		}
		// the gauge's speed
		{
			Check(RaceRallyGaugeSpeed(300) == 300 && RaceRallyGaugeSpeed(-4.9f) == 0 && RaceRallyGaugeSpeed(0.5f) == 0.5f,
				"gauge: positive nose-first, zero in the dead band");
			Check(RaceRallyGaugeSpeed(-30) == -30 && RaceRallyGaugeSpeed(-5.1f) == -5.1f, "gauge: negative only below -5 u/s");
			const RaceRallyDrive d = RaceRallyDriveOf(100, 0, 0, false, false, false, 0);
			Check(d.speed == 100, "gauge: moving along the nose reads positive");
			const RaceRallyDrive e = RaceRallyDriveOf(-3, 1, 0, false, false, false, 0);
			Check(RaceRallyGaugeSpeed(e.speed) == 0, "gauge: 3 u/s backwards (a wall's bounce) does not read REVERSE");
		}
	}

	// --- the car menu: a car for each player, and what parts add to it (h9_rally_shop_srv.h; HL Rally's client.cpp changecar/buy) ---------
	{
		// the class a player drives as: the cvar wins, else his own choice, else the map's, else off
		RallyShop none, chose;
		RallyShopJoin(none);
		RallyShopJoin(chose);
		RallyShopChange(chose, 7);
		Check(RallyEffectiveClass(0, 1, none) == 1, "class: a map's rally race gives a player who has not chosen the map's class (1)");
		Check(RallyEffectiveClass(0, 1, chose) == 7, "class: a player who chose a car drives that car, not the map's");
		Check(RallyEffectiveClass(4, 4, chose) == 4 && RallyEffectiveClass(4, 1, none) == 4, "class: the cvar h9_rally > 0 is a server override that wins over his choice");
		Check(RallyEffectiveClass(0, 0, chose) == 0, "class: no rally map and no cvar: nobody is a car");
		RallyShop other;
		RallyShopJoin(other);
		RallyShopChange(other, 3);
		Check(RallyEffectiveClass(0, 1, chose) != RallyEffectiveClass(0, 1, other), "class: two players drive two different classes at once");
		Check(!RallyShopChange(other, 0) && !RallyShopChange(other, H9R_NUM_CARS + 1) && other.cls == 3, "class: a number that is no car changes nothing");

		// parts: HL Rally's numbers (customise.txt) summed, handling and top into the stats, acceleration into nothing
		Check(g_h9RallyParts[2].cost == 700 && g_h9RallyParts[2].handling == 7 && g_h9RallyParts[5].cost == 800 && g_h9RallyParts[5].top == 8 &&
				  g_h9RallyParts[8].cost == 4500 && g_h9RallyParts[8].top == 15 && g_h9RallyParts[8].accel == 15 && g_h9RallyParts[9].cost == 3200 &&
				  g_h9RallyParts[9].top == 8,
			"parts: the table has customise.txt's rows (Rally tyres $700 +7 handling, Turbo-Back $800 +8 top, Single turbo $4500 +15/+15, Twin $3200 +8/+15)");
		Check(RallyShopHandlingAdd(1u << 2) == 7 && RallyShopTopAdd(1u << 5) == 8 && RallyShopHandlingAdd((1u << 2) | (1u << 5)) == 7 &&
				  RallyShopTopAdd((1u << 5) | (1u << 8)) == 23 && RallyShopAccelAdd((1u << 6) | (1u << 8)) == 19,
			"parts: the sums over the parts held (handling 7; top 8 + 15 = 23; acceleration 4 + 15 = 19)");

		const H9RallyCar& base = H9RallyCarByClass(1);
		const H9RallyCar plus = H9RallyCarWithParts(base, 7, 8);
		Check(plus.handlingStat == base.handlingStat + 7 && plus.topStat == base.topStat + 8 && plus.accelStat == base.accelStat,
			"physinfo rh/rt: the car's handling and top stats take the additions, acceleration is left (nothing reads it, as in HL Rally)");
		// worked out from HL Rally's formulas: wish = top x 15 (pm_shared.c:1787), the sideways hold = |handling - 40| / 50
		Check(fabsf(H9RallyWish(plus) - (80.0f + 8.0f) * 15.0f) < 0.01f && fabsf(H9RallyHandling(plus) - fabsf(87.0f - 40.0f) / 50.0f) < 1e-5f,
			"physinfo rh/rt: xsara with +7 handling and +8 top has wish 88 x 15 = 1320 and a hold of 47 / 50");
		Check(fabsf(H9RallyWish(H9RallyCarWithParts(base, 0, 0)) - H9RallyWish(base)) < 1e-6f &&
				  fabsf(H9RallyHandling(H9RallyCarWithParts(base, 0, 0)) - H9RallyHandling(base)) < 1e-6f,
			"physinfo rh/rt: no parts (0, 0) is the car as it was");
		Check(H9RallyWish(H9RallyCarWithParts(H9RallyCarByClass(6), 0, 0)) > H9RallyWish(H9RallyCarWithParts(H9RallyCarByClass(3), 0, 0)),
			"physinfo rh/rt: another class has its own stats beside the first (octavia is faster than locust)");
		Check(RaceRallyTopSpeed(1, 8) > RaceRallyTopSpeed(1) && fabsf(RaceRallyTopSpeed(1, 0) - RaceRallyTopSpeed(1)) < 1e-4f &&
				  fabsf(RaceRallyTopSpeed(1, 8) / RaceRallyTopSpeed(1) - 88.0f / 80.0f) < 1e-4f,
			"gauge: the end of the gauge follows the player's class and his top parts (class 1 +8 is 88/80 of 680)");
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
