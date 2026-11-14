// Checks rally mode's steering arithmetic (h9_rallysteer_calc.h) with no game: the heading's steady rate and its step response at 30, 60,
// 99 and 200 frames a second, the same filter as HL Rally's per-frame one at 99, the speed gate, reverse, standstill, the damping of a
// slide, the handbrake's and the power's kick, the wheel and the gearbox.
//   cmake --build <dir> --target rallysteer_test --config Release, then run rallysteer_test
#include "../h9_rallysteer_calc.h"

#include <stdio.h>
#include <math.h>

using namespace rallysteer;

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
static bool Within(float a, float b, float rel) { return fabsf(a - b) <= rel * fabsf(b); }
static const float kDeg = 3.14159265358979f / 180.0f;

// Drives a car whose velocity follows its nose (no slip), at `speed`, with a constant input of `rate` degrees a second (left positive,
// `viaMouse` or keys) for `seconds` at `fps`. Returns the heading's change over the last `window` seconds, per second.
static float SteadyRate(float fps, float rate, float speed, float seconds, float window, bool reverse = false)
{
	State s;
	Reset(s, 0.0f);
	const float dt = 1.0f / fps;
	const int steps = (int)(seconds * fps + 0.5f);
	const int from = (int)((seconds - window) * fps + 0.5f);
	float headingAtFrom = 0, travelled = 0;
	for (int i = 0; i < steps; i++)
	{
		if (i == from)
			headingAtFrom = s.heading, travelled = 0;
		Input in;
		in.dt = dt;
		in.mouseYaw = rate * dt;
		const float h = s.heading * kDeg;
		const float sign = reverse ? -1.0f : 1.0f;
		in.velX = cosf(h) * speed * sign;
		in.velY = sinf(h) * speed * sign;
		const float before = s.heading;
		Step(s, in);
		if (i >= from)
		{
			float d = s.heading - before;
			if (d > 180.0f)
				d -= 360.0f;
			if (d < -180.0f)
				d += 360.0f;
			travelled += d;
		}
	}
	(void)headingAtFrom;
	return travelled / window;
}

// HL Rally's own per-frame filter, as it reads in input.cpp (written from its behaviour), for the same drive at a fixed frame rate: the
// frame's turn in degrees to the left from the input per frame `a` (left positive).
static float ReferenceRate(float fps, float rate, float speed, float seconds, float window)
{
	float heading = 0, delta = 0, travelled = 0;
	const float dt = 1.0f / fps;
	const int steps = (int)(seconds * fps + 0.5f);
	const int from = (int)((seconds - window) * fps + 0.5f);
	for (int i = 0; i < steps; i++)
	{
		const float a = rate * dt;
		const float sl = 1.0f; // velocity along the nose
		const int k = sl < 0.96f ? 2 : 0;
		delta = (a * powf(sl, 6) + delta * (1 - sl) + delta * (29 + k)) / (30 + k);
		const float turn = delta * 25.0f * dt;
		heading += turn;
		if (i >= from)
			travelled += turn;
		(void)speed;
	}
	return travelled / window;
}

int main()
{
	// ---- the steady heading rate: the same at every frame rate, and HL Rally's at 99 ----
	{
		const float fps[4] = {30, 60, 99, 200};
		const float rate = 120.0f;
		float r[4];
		for (int i = 0; i < 4; i++)
			r[i] = SteadyRate(fps[i], rate, 300.0f, 4.0f, 1.0f);
		const float expect = rate * kGain / kRefFps; // 0.2525 * 120 = 30.3 deg/s
		printf("steady heading rate for %.0f deg/s of input: 30fps %.3f, 60fps %.3f, 99fps %.3f, 200fps %.3f (expected %.3f)\n", rate, r[0], r[1], r[2], r[3], expect);
		for (int i = 0; i < 4; i++)
			CHECK(Within(r[i], expect, 0.05f));
		for (int i = 0; i < 4; i++)
			CHECK(Within(r[i], r[2], 0.05f));
		// and HL Rally's own filter at 99 fps gives the same
		const float ref99 = ReferenceRate(99.0f, rate, 300.0f, 4.0f, 1.0f);
		printf("HL Rally's per-frame filter at 99 fps: %.3f\n", ref99);
		CHECK(Within(r[2], ref99, 0.03f));
		// the keys' 400 degrees a second: about 100 a second
		const float keys = SteadyRate(99.0f, 400.0f, 300.0f, 4.0f, 1.0f);
		CHECK(Within(keys, 400.0f * 25.0f / 99.0f, 0.05f));
		// the other way
		CHECK(SteadyRate(60.0f, -rate, 300.0f, 4.0f, 1.0f) < -0.9f * expect);
	}

	// ---- the step response (the filter's time constant about 0.3 s) is the same at every frame rate ----
	{
		const float fps[4] = {30, 60, 99, 200};
		float turned[4];
		for (int i = 0; i < 4; i++)
		{
			State s;
			Reset(s, 0.0f);
			const float dt = 1.0f / fps[i];
			const int steps = (int)(0.5f * fps[i] + 0.5f);
			for (int j = 0; j < steps; j++)
			{
				Input in;
				in.dt = dt;
				in.mouseYaw = 200.0f * dt;
				const float h = s.heading * kDeg;
				in.velX = cosf(h) * 300.0f;
				in.velY = sinf(h) * 300.0f;
				Step(s, in);
			}
			turned[i] = Wrap180(s.heading);
		}
		printf("heading after 0.5 s of a 200 deg/s input: 30fps %.2f, 60fps %.2f, 99fps %.2f, 200fps %.2f\n", turned[0], turned[1], turned[2], turned[3]);
		for (int i = 0; i < 4; i++)
			CHECK(Within(turned[i], turned[2], 0.05f));
	}

	// ---- the same mouse movement, in one frame or in many, turns the car as far ----
	{
		State a, b;
		Reset(a, 10.0f);
		Reset(b, 10.0f);
		Input in;
		in.velX = 300;
		in.velY = 0;
		// a turned car with the velocity fixed: s changes the same way for both, so keep the heading's slip out of it: velocity along the heading
		const float h = 10.0f * kDeg;
		in.velX = cosf(h) * 300.0f;
		in.velY = sinf(h) * 300.0f;
		// three seconds of 3 degrees a frame at 60 fps against 6 degrees a frame at 30
		for (int i = 0; i < 20; i++)
		{
			Input x = in;
			x.dt = 1.0f / 60.0f;
			x.mouseYaw = 1.0f;
			Step(a, x);
			if ((i & 1) == 1)
			{
				Input y = in;
				y.dt = 1.0f / 30.0f;
				y.mouseYaw = 2.0f;
				Step(b, y);
			}
		}
		CHECK(a.delta > 0 && b.delta > 0);
		CHECK(Within(a.delta, b.delta, 0.06f));
	}

	// ---- the speed gate ----
	{
		auto Turn = [&](float speed) {
			State s;
			Reset(s, 0.0f);
			// delta first settled by driving at a speed that turns fully, then the speed changes: the gate is on the heading
			Input in;
			in.dt = 1.0f / 99.0f;
			in.mouseYaw = 1.0f;
			for (int i = 0; i < 300; i++)
			{
				in.velX = 300;
				in.velY = 0;
				Step(s, in);
			}
			s.heading = 0;
			in.mouseYaw = 0;
			in.velX = speed;
			in.velY = 0;
			in.dt = 1.0f / 99.0f;
			const float d0 = s.delta;
			Step(s, in);
			const float t = Wrap180(s.heading);
			return t / (d0 * kGain * in.dt);
		};
		CHECK(Near(Turn(4.0f), 0.0f, 1e-4f));
		CHECK(Near(Turn(5.0f), 0.0f, 1e-4f)); // 5 or less: none
		CHECK(Near(Turn(50.0f), 0.5f, 0.03f));
		CHECK(Near(Turn(25.0f), 0.25f, 0.03f));
		CHECK(Near(Turn(100.0f), 1.0f, 0.03f));
		CHECK(Near(Turn(600.0f), 1.0f, 0.03f));
	}

	// ---- no turn at a standstill, whatever is asked ----
	{
		State s;
		Reset(s, 77.0f);
		Input in;
		in.dt = 1.0f / 60.0f;
		in.mouseYaw = 5.0f;
		for (int i = 0; i < 120; i++)
			Step(s, in);
		CHECK(Near(s.heading, 77.0f, 1e-3f));
	}

	// ---- reverse: the same input turns the nose the other way ----
	{
		const float fwd = SteadyRate(99.0f, 100.0f, 200.0f, 4.0f, 1.0f, false);
		const float back = SteadyRate(99.0f, 100.0f, 200.0f, 4.0f, 1.0f, true);
		printf("100 deg/s of input: forward %.3f, in reverse %.3f\n", fwd, back);
		CHECK(fwd > 20.0f);
		CHECK(back < -20.0f);
		CHECK(Within(-back, fwd, 0.05f));
	}

	// ---- damping in a slide: with the velocity 60 degrees off the nose the same input turns it a thirtieth as much (s^5) ----
	{
		State straight, slide;
		Reset(straight, 0.0f);
		Reset(slide, 0.0f);
		Input in;
		in.dt = 1.0f / 99.0f;
		in.mouseYaw = 1.0f;
		for (int i = 0; i < 400; i++)
		{
			in.velX = 300;
			in.velY = 0;
			straight.heading = 0.0f; // the nose held still, so that the slip stays what it is
			Step(straight, in);
			in.velX = 300 * cosf(60.0f * kDeg);
			in.velY = 300 * sinf(60.0f * kDeg); // the nose stays near 0 for this look: only the first steps matter
			slide.heading = 0.0f;               // hold the nose still so the slip stays 60
			Step(slide, in);
		}
		printf("delta straight %.4f, in a 60 degree slide %.4f\n", straight.delta, slide.delta);
		CHECK(straight.delta > 0.9f);
		CHECK(slide.delta < straight.delta * 0.1f);
		CHECK(slide.delta > 0.0f);
	}

	// ---- the delta persists in a slide (it decays by s / 30 per frame, not by 1/30): a nearly sideways car goes on turning ----
	{
		State s;
		Reset(s, 0.0f);
		s.delta = 3.0f;
		Input in;
		in.dt = 1.0f / 99.0f;
		in.velX = 0;
		in.velY = 300; // sideways: s = 0
		for (int i = 0; i < 99; i++)
		{
			s.heading = 0.0f; // the nose held still
			Step(s, in);
		}
		CHECK(s.delta > 2.9f);
		State t;
		Reset(t, 0.0f);
		t.delta = 3.0f;
		in.velX = 300;
		in.velY = 0; // straight: it dies away in about 0.3 s
		for (int i = 0; i < 99; i++)
		{
			t.heading = 0.0f;
			Step(t, in);
		}
		CHECK(t.delta < 0.2f);
	}

	// ---- the handbrake's kick: the nose turns the way the car is going to the side of it, and more with the key ----
	{
		auto Run = [&](float slideSide, bool brake) {
			State s;
			Reset(s, 0.0f);
			Input in;
			in.dt = 1.0f / 99.0f;
			in.handbrake = brake;
			// velocity: 400 along the nose and slideSide to the right (positive: to the right)
			for (int i = 0; i < 40; i++)
			{
				in.velX = 400;
				in.velY = -slideSide;
				s.heading = 0.0f;
				Step(s, in);
			}
			return s.delta;
		};
		const float rightOn = Run(120.0f, true), rightOff = Run(120.0f, false);
		const float leftOn = Run(-120.0f, true);
		printf("delta after 40 frames, going to the right of the nose: handbrake %.4f, none %.4f; to the left, handbrake %.4f\n", rightOn, rightOff, leftOn);
		CHECK(rightOn > rightOff + 0.01f);  // to the right of the nose: the nose turns left (positive)
		CHECK(leftOn < -0.01f);
		CHECK(rightOff < rightOn); // (with the engine's revs high a coasting car is kicked a little by the power term too)
	}

	// ---- the power's kick: only with the revs up, in its slip band, with a gear; the same sign ----
	{
		State s;
		Reset(s, 0.0f);
		Input in;
		in.dt = 1.0f / 99.0f;
		in.throttle = true;
		in.velX = 400;
		in.velY = 0;
		for (int i = 0; i < 60; i++)
			Step(s, in); // the gears climb
		CHECK(s.box.gear >= 3);
		CHECK(s.box.rpm > 145.0f);
		const float before = s.delta;
		for (int i = 0; i < 40; i++)
		{
			in.velX = 400;
			in.velY = -120; // to the right of the nose, slide 0.29
			s.heading = 0.0f;
			Step(s, in);
		}
		printf("power oversteer: delta %.4f -> %.4f (gear %d, revs %.0f)\n", before, s.delta, s.box.gear, s.box.rpm);
		CHECK(s.delta > before + 0.01f);
		// off the throttle (and revs under 165) it does not
		State t;
		Reset(t, 0.0f);
		Input off = in;
		off.throttle = false;
		for (int i = 0; i < 60; i++)
		{
			off.velX = 400;
			off.velY = 0;
			Step(t, off);
		}
		t.box.rpm = 120.0f;
		for (int i = 0; i < 10; i++)
		{
			off.velX = 400;
			off.velY = -120;
			t.heading = 0.0f;
			t.box.rpm = 120.0f;
			Step(t, off);
		}
		CHECK(Near(t.delta, 0.0f, 1e-4f));
	}

	// ---- the wheel: the keys take it to +-10 at once, it recentres at 20 a second ----
	{
		State s;
		Reset(s, 0.0f);
		Input in;
		in.dt = 1.0f / 60.0f;
		in.velX = 300;
		in.keyYaw = 400.0f * in.dt; // left
		for (int i = 0; i < 30; i++)
			Step(s, in);
		CHECK(Near(s.wheel, -kWheelMax, 1e-3f)); // positive is to the right
		in.keyYaw = 0;
		for (int i = 0; i < 15; i++) // a quarter of a second: 5 units
			Step(s, in);
		CHECK(Near(s.wheel, -kWheelMax + 5.0f, 0.2f));
		for (int i = 0; i < 40; i++)
			Step(s, in);
		CHECK(Near(s.wheel, 0.0f, 1e-3f));
		// the same at any frame rate: half a second of keys takes it to the limit at 30 and at 200 fps
		State a, b;
		Reset(a, 0.0f);
		Reset(b, 0.0f);
		for (int i = 0; i < 15; i++)
		{
			Input x;
			x.dt = 1.0f / 30.0f;
			x.velX = 300;
			x.keyYaw = -400.0f * x.dt;
			Step(a, x);
		}
		for (int i = 0; i < 100; i++)
		{
			Input x;
			x.dt = 1.0f / 200.0f;
			x.velX = 300;
			x.keyYaw = -400.0f * x.dt;
			Step(b, x);
		}
		CHECK(Near(a.wheel, kWheelMax, 1e-3f) && Near(b.wheel, kWheelMax, 1e-3f));
	}

	// ---- the gearbox: the gear in 0..6, the revs in 15..250, and no gear at a standstill ----
	{
		Gearbox g;
		for (int i = 0; i < 300; i++)
		{
			GearboxStep(g, 700.0f * (float)i / 300.0f, true, true, 0, 1.0f / 99.0f);
			CHECK(g.gear >= 0 && g.gear <= 6 && g.rpm >= 15.0f && g.rpm <= 250.0f);
		}
		CHECK(g.gear >= 4);
		Gearbox z;
		GearboxStep(z, 0.0f, true, false, 0, 1.0f / 99.0f);
		CHECK(z.gear == 0);
	}

	printf("%d checks, %d failed\n", g_checked, g_failed);
	if (g_failed == 0)
		printf("PASS: rally steering arithmetic\n");
	return g_failed == 0 ? 0 : 1;
}
