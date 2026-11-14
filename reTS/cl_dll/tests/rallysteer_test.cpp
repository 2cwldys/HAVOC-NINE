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
	// ---- I6: the wheel's two recentring tests, one after the other, with no stop at 0 (input.cpp:1016-1021) ----
	{
		State w;
		Reset(w, 0.0f);
		const float steps[8] = {0.1f, -0.1f, 1.0f, -1.0f, 0.0f, 0.15f, -0.19f, 11.0f};
		const float want[8] = {0.1f, 0.1f, 0.8f, -0.8f, 0.0f, 0.15f, 0.01f, 10.0f}; // (held at the limit, 10) c = 20 * 0.01 = 0.2
		for (int i = 0; i < 8; i++)
		{
			w.wheel = steps[i];
			WheelStep(w, 0.0f, 0.0f, 0.01f);
			CHECK(Near(w.wheel, want[i], 1e-5f));
		}
	}

	// ---- I10: the heading turns by the new delta alone, not the mean of the old and the new (input.cpp:1228-1250) ----
	{
		State a;
		Reset(a, 0.0f);
		Input in;
		in.dt = 1.0f / 99.0f;
		in.mouseYaw = 0.5f;
		in.velX = 300;
		Step(a, in);
		CHECK(Near(a.heading, a.delta * 25.0f * in.dt, 1e-6f));
		CHECK(Near(a.delta, 0.5f / 30.0f, 2e-3f * 0.5f)); // the filter's first frame: a / 30
	}

	// ---- I11: the slide is measured against the heading with this frame's input already in it (input.cpp:1056-1074) ----
	{
		State a;
		Reset(a, 0.0f);
		Input in;
		in.dt = 1.0f / 99.0f;
		in.mouseYaw = 10.0f; // 10 degrees to the left in one reference frame, with the car going along the old heading
		in.velX = 300;
		const Output o = Step(a, in);
		CHECK(Near(o.cosSlip, cosf(10.0f * kDeg), 1e-4f));
		CHECK(o.slide > 0.0f); // the velocity is to the right of a nose that has turned left
	}

	// ---- I12: the brake's 1.5 is not applied while the car starts in reverse (back key, under 40 u/s, forward key up: input.cpp:870-876, 1095) ----
	{
		// g_braking and g_accelerating come from DriveStep (the back key and the forward key held, on the ground, at this horizontal speed)
		auto Delta = [&](float speed, bool brake, bool throttle) {
			DriveIn di;
			di.speedH = speed;
			di.backFrac = di.backDown = brake ? 1.0f : 0.0f;
			di.fwdFrac = di.fwdDown = throttle ? 1.0f : 0.0f;
			const DriveOut d = DriveStep(di);
			State a;
			Reset(a, 0.0f);
			Input in;
			in.dt = 1.0f / 99.0f;
			in.mouseYaw = 0.5f;
			in.velX = speed;
			in.brake = d.braking;
			in.throttle = d.accelerating;
			Step(a, in);
			return a.delta;
		};
		CHECK(Near(Delta(30.0f, true, false), Delta(30.0f, false, false), 1e-6f));            // reverse start: none
		CHECK(Near(Delta(30.0f, true, true), 1.5f * Delta(30.0f, false, false), 1e-5f));      // forward key down too: braking
		CHECK(Near(Delta(100.0f, true, false), 1.5f * Delta(100.0f, false, false), 1e-5f));   // 40 u/s or more: braking
		CHECK(Near(Delta(39.9f, true, false), Delta(39.9f, false, false), 1e-6f));
	}

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
			Step(s, in);
			const float t = Wrap180(s.heading);
			// HL Rally turns by the NEW steer_delta alone (input.cpp:1228-1250: viewangles = oldangles - steer_delta * 25 * frametime)
			return t / (s.delta * kGain * in.dt);
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
		// it is not clamped at 0 (input.cpp:1016-1021): it comes to rest within one step of centre, where it stays
		const float rest = s.wheel;
		CHECK(fabsf(rest) <= kWheelCentre / 60.0f + 1e-4f);
		for (int i = 0; i < 40; i++)
			Step(s, in);
		CHECK(Near(s.wheel, rest, 1e-4f));
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

	// ---- rows 3, 4, 5, I14: the throttle, the forward move the client sends (input.cpp:869-1001) ----
	{
		// the number a held throttle key makes (:985-990)
		CHECK(Near(ThrottleMove(0.0f, 15.0f), 10000.0f, 1e-3f));                      // from a stand: 10000 (:985-986)
		CHECK(Near(ThrottleMove(30.0f, 100.0f), 30.0f + 100.0f * 30.0f / (30.0f / 78.0f), 0.01f)); // under 200 revs: 30 + 7800 = 7830 (:987-988)
		CHECK(Near(ThrottleMove(30.0f, 100.0f), 7830.0f, 0.01f));
		CHECK(Near(ThrottleMove(400.0f, 108.3f), 400.0f + 108.3f * 30.0f * 78.0f / 400.0f, 0.01f)); // gear 6 at 400 u/s: about 1032, below the 1200 wish (audit row 4)
		CHECK(Near(ThrottleMove(300.0f, 201.0f), 300.0f, 1e-3f));                     // revs 200 and up with 50 u/s: the speed alone (:989-990)
		CHECK(Near(ThrottleMove(40.0f, 250.0f), 40.0f + 250.0f * 30.0f * 78.0f / 40.0f, 0.1f)); // under 50 u/s the revs term stays even at 250 (:987)
		CHECK(Near(ThrottleMove(50.0f, 199.0f), 50.0f + 199.0f * 30.0f / (50.0f / 78.0f), 0.1f) && Near(ThrottleMove(50.0f, 200.0f), 50.0f, 1e-4f));
		CHECK(Near(ThrottleMove(49.9f, 250.0f), 49.9f + 250.0f * 30.0f / (49.9f / 78.0f), 0.5f));

		DriveIn d;
		d.rpm = 100.0f;
		d.speedH = 30.0f;
		d.fwdFrac = d.fwdDown = 1.0f;
		DriveOut o = DriveStep(d);
		CHECK(Near(o.forwardmove, 7830.0f, 0.01f) && o.accelerating && o.reversing == 0);
		// row 5 as audited was wrong: CL_KeyState clears the impulses at its first read (:612 key->state &= 1), and the first read is the `> 0` test
		// (:890), so the read that multiplies the move (:998) sees 1 or 0, never 0.25, 0.5 or 0.75. A key pressed and held this frame gives the whole move
		d.fwdFrac = 0.5f;
		d.fwdDown = 1.0f;
		o = DriveStep(d);
		CHECK(Near(o.forwardmove, 7830.0f, 0.01f)); // not half
		// pressed and released inside the frame: counted as pressed (g_accelerating) but its move is 0
		d.fwdFrac = 0.25f;
		d.fwdDown = 0.0f;
		o = DriveStep(d);
		CHECK(o.forwardmove == 0.0f && o.accelerating);
		// released this frame: first read 0
		d.fwdFrac = d.fwdDown = 0.0f;
		o = DriveStep(d);
		CHECK(o.forwardmove == 0.0f && !o.accelerating);

		// reverse: the back key below 40 u/s, forward key up (:871, :942-950): -10000, g_braking off, g_reversing 2 (the back key is down)
		DriveIn r;
		r.speedH = 10.0f;
		r.backFrac = r.backDown = 1.0f;
		DriveOut ro = DriveStep(r);
		CHECK(Near(ro.forwardmove, -10000.0f, 1e-3f) && ro.reversing == 2 && !ro.braking && ro.isReverse);
		// from 40 u/s the back key is the brake: no move, g_braking on
		r.speedH = 40.0f;
		ro = DriveStep(r);
		CHECK(ro.forwardmove == 0.0f && ro.braking && ro.reversing == 0 && !ro.isReverse);
		// the forward key overrides the back key's reverse (:890-893), the move is the throttle's
		r.speedH = 10.0f;
		r.fwdFrac = r.fwdDown = 1.0f;
		r.rpm = 100.0f;
		ro = DriveStep(r);
		CHECK(ro.forwardmove > 0.0f && !ro.isReverse && ro.accelerating && ro.reversing == 0);
		// a tap of the back key under 40 u/s: reverse is chosen (first read 0.25) but the key is not down for the multiply: move 0, g_reversing 1
		DriveIn t;
		t.speedH = 10.0f;
		t.backFrac = 0.25f;
		t.backDown = 0.0f;
		const DriveOut to = DriveStep(t);
		CHECK(to.forwardmove == 0.0f && to.reversing == 1);
		// in the air: no move at all (:939), g_reversing is left as it was, g_braking and g_accelerating are still set
		DriveIn a;
		a.onGround = false;
		a.speedH = 200.0f;
		a.rpm = 100.0f;
		a.fwdFrac = a.fwdDown = 1.0f;
		a.backFrac = a.backDown = 1.0f;
		a.reversing = 1;
		const DriveOut ao = DriveStep(a);
		CHECK(ao.forwardmove == 0.0f && ao.reversing == 1 && ao.accelerating && ao.braking);
		// the INS key (+klook): no throttle move (:965)
		DriveIn k;
		k.speedH = 10.0f;
		k.fwdFrac = k.fwdDown = 1.0f;
		k.klook = true;
		CHECK(DriveStep(k).forwardmove == 0.0f);
		// the move is a short in the command: held to its range here (HL Rally's float to short wraps)
		CHECK(Near(CmdForwardMove(35100.0f), 32767.0f, 1e-3f) && Near(CmdForwardMove(-35100.0f), -32767.0f, 1e-3f) && Near(CmdForwardMove(1200.0f), 1200.0f, 1e-3f));
	}

	// ---- I15: the manual gearbox (rally_manual, gearup, geardown: input.cpp:471-486, 871-872, 890-891, 947-957, 965-975; Rally_Effects.cpp:268-301, 333-336) ----
	{
		Gearbox g;
		CHECK(!GearUp(g, false) && g.gear == 0 && !GearDown(g, false) && g.gear == 0); // only in the manual box
		for (int i = 0; i < 8; i++)
			GearUp(g, true);
		CHECK(g.gear == 6); // up to 6 (:473)
		for (int i = 0; i < 9; i++)
			GearDown(g, true);
		CHECK(g.gear == -1); // down to -1 (:481)
		g.gear = 3;
		// the manual box does not shift by itself: 200 u/s in gear 3 is 650 / 6 = 108 revs, however long it runs
		for (int i = 0; i < 400; i++)
			GearboxStep(g, 200.0f, true, false, 0.0f, 1.0f / 99.0f, true);
		CHECK(g.gear == 3 && Near(g.rpm, 200.0f * 3.25f / 6.0f, 0.5f));
		// gear -1 (reverse): the revs are the speed itself (Rally_Effects.cpp:333-334)
		Gearbox rv;
		rv.gear = -1;
		for (int i = 0; i < 400; i++)
			GearboxStep(rv, 50.0f, true, false, 0.0f, 1.0f / 99.0f, true);
		CHECK(rv.gear == -1 && Near(rv.rpm, 50.0f * 3.25f, 0.5f));
		// in neutral the revs run free with the accelerator (+1100 a second)
		Gearbox n;
		for (int i = 0; i < 60; i++)
			GearboxStep(n, 0.0f, true, true, 0.0f, 1.0f / 99.0f, true);
		CHECK(n.gear == 0 && n.rpm > 100.0f); // (the revs rise by at most 550 a second, before the filter)
		// the automatic box in the race's hold is in neutral (:298-300)
		Gearbox c;
		for (int i = 0; i < 50; i++)
			GearboxStep(c, 200.0f, true, false, 0.0f, 1.0f / 99.0f, false, true);
		CHECK(c.gear == 0);

		// the move in the manual box
		DriveIn m;
		m.manual = true;
		m.speedH = 100.0f;
		m.rpm = 120.0f;
		m.fwdFrac = m.fwdDown = 1.0f;
		m.gear = 0;
		CHECK(DriveStep(m).forwardmove == 0.0f);                                   // neutral: nothing (:965-968)
		m.gear = 3;
		CHECK(Near(DriveStep(m).forwardmove, ThrottleMove(100.0f, 120.0f), 1e-3f)); // a forward gear: the throttle's number
		m.gear = -1;
		const DriveOut mo = DriveStep(m);
		CHECK(Near(mo.forwardmove, -10000.0f, 1e-3f) && mo.reversing == 2 && mo.isReverse && !mo.accelerating); // gear -1: the FORWARD key reverses, at any speed
		// the back key in the manual box is only the brake (:871 needs !manual), also at a crawl
		DriveIn b;
		b.manual = true;
		b.gear = 2;
		b.speedH = 10.0f;
		b.backFrac = b.backDown = 1.0f;
		const DriveOut bo = DriveStep(b);
		CHECK(bo.forwardmove == 0.0f && bo.braking && !bo.isReverse);
	}

	// ---- I18: after the finish the drive block is skipped; only the revs go on (input.cpp:818-835) ----
	{
		State s;
		Reset(s, 90.0f);
		s.box.gear = 3;
		s.box.rpm = 100.0f;
		s.box.oldRpm = 100.0f;
		const float heading = s.heading;
		for (int i = 0; i < 200; i++)
			FrozenStep(s, 200.0f, 0.0f, true, 1.0f / 99.0f, false, false);
		CHECK(s.heading == heading && s.delta == 0.0f); // not turned
		CHECK(s.box.rpm != 100.0f && s.box.gear >= 1);  // the revs followed the speed
		State off; // a car that has no steering state yet is not touched
		FrozenStep(off, 200.0f, 0.0f, true, 0.01f, false, false);
		CHECK(!off.init && off.box.gear == 0);
	}

	// ---- I11: the slip is taken on the car's tilted axes and the whole velocity (input.cpp:1056-1068) ----
	{
		// a level car at heading 0 with a velocity (100, 50, 30): the right is (0, -1, 0), |v| = 116.19, so the slide is -50 / 116.19 and the
		// share along the nose 100 / 116.19 (not the horizontal 50 / 111.8 an older version took)
		State a;
		Reset(a, 0.0f);
		Input in;
		in.dt = 1.0f / 99.0f;
		in.velX = 100.0f;
		in.velY = 50.0f;
		in.velZ = 30.0f;
		Output o = Step(a, in);
		const float v3 = sqrtf(100.0f * 100.0f + 50.0f * 50.0f + 30.0f * 30.0f);
		CHECK(Near(o.slide, -50.0f / v3, 1e-4f) && Near(o.cosSlip, 100.0f / v3, 1e-4f));
		// a car on a 20 degree slope going straight up it: its nose (pitch -20 in AngleVectors' convention: nose up) is along the velocity, no slip
		State b;
		Reset(b, 0.0f);
		Input up;
		up.dt = 1.0f / 99.0f;
		up.velX = 200.0f * cosf(20.0f * kDeg);
		up.velZ = 200.0f * sinf(20.0f * kDeg);
		up.haveTilt = true;
		up.tiltPitch = -20.0f;
		o = Step(b, up);
		CHECK(Near(o.cosSlip, 1.0f, 1e-4f) && Near(o.slide, 0.0f, 1e-4f));
		// the same without the tilt: the nose is taken level, 20 degrees off the velocity: cos 20 degrees
		State c;
		Reset(c, 0.0f);
		up.haveTilt = false;
		o = Step(c, up);
		CHECK(Near(o.cosSlip, cosf(20.0f * kDeg), 1e-4f));
		// AngleVectors' own values: pitch 30 (nose down), yaw 90, roll 0: forward (0, cos30, -sin30), right (1, 0, 0)
		float f[3], r[3];
		AxesOfAngles(30.0f, 90.0f, 0.0f, f, r);
		CHECK(Near(f[0], 0.0f, 1e-5f) && Near(f[1], cosf(30.0f * kDeg), 1e-5f) && Near(f[2], -0.5f, 1e-5f) && Near(r[0], 1.0f, 1e-5f) && Near(r[1], 0.0f, 1e-5f) && Near(r[2], 0.0f, 1e-5f));
		// roll 30 at yaw 0: the right tips down: (0, -cos30, -sin30)
		AxesOfAngles(0.0f, 0.0f, 30.0f, f, r);
		CHECK(Near(r[1], -cosf(30.0f * kDeg), 1e-5f) && Near(r[2], -0.5f, 1e-5f));
	}

	printf("%d checks, %d failed\n", g_checked, g_failed);
	if (g_failed == 0)
		printf("PASS: rally steering arithmetic\n");
	return g_failed == 0 ? 0 : 1;
}
