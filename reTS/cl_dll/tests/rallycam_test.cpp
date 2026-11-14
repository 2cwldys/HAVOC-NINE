// Checks rally mode's camera and tilt arithmetic (h9_rallycam_calc.h) with no game: which boxes are cars, the tilt from four heights
// held against the studio's own matrix and the view's own vectors, the easings' frame-rate independence, the chase camera's place
// and lag, the pull-in, the driver's seat, the steering bytes and the tyres' roll.
//   cmake --build <dir> --target rallycam_test --config Release, then run rallycam_test
#include "../h9_rallycam_calc.h"

#include <stdio.h>
#include <math.h>

using namespace rallycam;

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
static bool NearV(const V3& a, const V3& b, float eps) { return (a - b).Length() <= eps; }

// A ground that is a plane z = a x + b y + c, read at four points of a car at (cx, cy) heading yaw.
struct PlaneGround
{
	float a, b, c;
	float At(float x, float y) const { return a * x + b * y + c; }
};

static V3 NormalOn(const PlaneGround& g, float cx, float cy, float yaw, float hl, float hw)
{
	const float co = cosf(Rad(yaw)), si = sinf(Rad(yaw));
	auto H = [&](float px, float py) { return g.At(cx + co * px - si * py, cy + si * px + co * py); };
	return NormalFromHeights(yaw, H(hl, hw), H(hl, -hw), H(-hl, hw), H(-hl, -hw), hl, hw);
}

int main()
{
	// ---- who is a car ----
	CHECK(IsCarBox(V3(-5, -5, -1), V3(5, 5, 1)));               // rally mode's box, HL Rally's (dlls/h9_rally_srv.cpp)
	CHECK(IsCarBox(V3(-5.125f, -5, -1), V3(5, 4.875f, 1.125f))); // sent at 1/8 unit: still a car
	CHECK(IsCarBox(V3(-16, -16, 0), V3(16, 16, 16)));           // the first version's box
	CHECK(!IsCarBox(V3(-16, -16, -36), V3(16, 16, 36)));        // a standing player
	CHECK(!IsCarBox(V3(-16, -16, -18), V3(16, 16, 18)));        // a ducked one
	CHECK(!IsCarBox(V3(-16, -16, 0), V3(16, 16, 72)));          // the human hull
	CHECK(!IsCarBox(V3(-16, -16, 0), V3(16, 16, 56)));          // a prone / sliding one
	CHECK(!IsCarBox(V3(0, 0, 0), V3(0, 0, 0)));                 // no box
	CHECK(IsCarBox(V3(-16.01f, -16, 0), V3(16, 15.99f, 16.01f))); // sent at 1/8 unit: still a car

	// ---- the tilt: flat ground gives no tilt ----
	{
		const V3 n = NormalFromHeights(37.0f, 5, 5, 5, 5, 14, 8);
		float p, r;
		EulerFromNormal(n, 37.0f, p, r);
		CHECK(Near(p, 0, 1e-3f) && Near(r, 0, 1e-3f));
		CHECK(NearV(n, V3(0, 0, 1), 1e-5f));
	}

	// ---- a ramp rising ahead (heading +x, 20 degrees) lifts the nose, and the studio's matrix has the plane's normal for its roof ----
	{
		const float slope = tanf(Rad(20.0f));
		PlaneGround g = {slope, 0, 0};
		const V3 n = NormalOn(g, 100, 50, 0.0f, 14, 8);
		float p, r;
		EulerFromNormal(n, 0.0f, p, r);
		CHECK(Near(p, 20.0f, 0.01f)); // nose up 20
		CHECK(Near(r, 0.0f, 0.01f));
		const Axes m = EntityMatrixColumns(p, 0.0f, r);
		CHECK(NearV(m.n, n, 1e-4f));
		CHECK(Near(m.f.z, sinf(Rad(20.0f)), 1e-4f)); // the nose rises
	}
	// the same ramp driven DOWN it (heading 180): the nose is down
	{
		const float slope = tanf(Rad(20.0f));
		PlaneGround g = {slope, 0, 0};
		const V3 n = NormalOn(g, 100, 50, 180.0f, 14, 8);
		float p, r;
		EulerFromNormal(n, 180.0f, p, r);
		CHECK(Near(p, -20.0f, 0.01f));
		CHECK(Near(r, 0.0f, 0.01f));
	}
	// a ground that rises to the car's LEFT (heading +x, left is +y): left side up, positive roll
	{
		const float slope = tanf(Rad(15.0f));
		PlaneGround g = {0, slope, 0};
		const V3 n = NormalOn(g, 0, 0, 0.0f, 14, 8);
		float p, r;
		EulerFromNormal(n, 0.0f, p, r);
		CHECK(Near(p, 0.0f, 0.01f));
		CHECK(Near(r, 15.0f, 0.01f));
		const Axes m = EntityMatrixColumns(p, 0.0f, r);
		CHECK(NearV(m.n, n, 1e-4f));
		CHECK(m.l.z > 0.2f); // the left side is the high one
	}
	// any heading on a steep plane: the matrix's roof is the plane's normal, its nose is level with the heading, and it is a rotation
	for (int yaw = -180; yaw < 180; yaw += 23)
	{
		PlaneGround g = {0.21f, -0.33f, 7};
		const V3 n = NormalOn(g, 300, -120, (float)yaw, 13.5f, 8.2f);
		float p, r;
		EulerFromNormal(n, (float)yaw, p, r);
		const Axes m = EntityMatrixColumns(p, (float)yaw, r);
		// HL Rally's own formula (StudioModelRenderer.cpp:1334-1336 and 1367-1368): the normal turned by the yaw, then the angle of each share
		// (the matrix's roof is now only near the plane's normal: the two differ by under a degree on this slope)
		{
			const double ang = yaw * 0.0174532925199433;
			const double r0 = n.x * cos(ang) + n.y * sin(ang), r1 = -(n.x * sin(ang)) + n.y * cos(ang), r2 = n.z;
			CHECK(Near(p, (float)(atan2(r2, r0) * 180 / 3.14159265358979 - 90), 1e-3f));
			CHECK(Near(r, (float)(atan2(r2, r1) * 180 / 3.14159265358979 - 90), 1e-3f));
		}
		CHECK(NearV(m.n, n, 0.02f));
		CHECK(Near(m.f.Dot(m.n), 0.0f, 1e-4f) && Near(m.f.Dot(m.l), 0.0f, 1e-4f) && Near(m.l.Dot(m.n), 0.0f, 1e-4f));
		CHECK(Near(m.f.Length(), 1.0f, 1e-4f) && Near(m.l.Length(), 1.0f, 1e-4f));
		const float way = Deg(atan2f(m.f.y, m.f.x));
		CHECK(Near(fabsf(AngleDelta(way, (float)yaw)), 0.0f, 0.01f)); // the nose points where the car is heading
	}

	// ---- the driver's view takes the car's tilt: the view's vectors are the car's ----
	{
		PlaneGround g = {0.3f, 0.18f, 0};
		const V3 n = NormalOn(g, 0, 0, 70.0f, 14, 8);
		float p, r;
		EulerFromNormal(n, 70.0f, p, r);
		const Axes a = EntityMatrixColumns(p, 70.0f, r);
		Tilt t;
		t.init = true;
		t.pitch = p;
		t.roll = r;
		FirstState fs;
		FirstParams fp;
		const Pose pose = FirstStep(fs, V3(0, 0, 0), 70.0f, t, 0.0f, fp);
		const Axes v = ViewVectors(pose.pitch, pose.yaw, pose.roll);
		CHECK(NearV(v.f, a.f, 1e-3f));
		CHECK(NearV(v.l, a.l, 1e-3f));
		CHECK(NearV(v.n, a.n, 1e-3f));
		// the eye is above the floor along the car's own up and ahead along its nose
		CHECK(NearV(pose.org, a.f * fp.ahead + a.n * fp.up, 1e-3f));
	}

	// ---- smoothing is frame-rate independent ----
	CHECK(Near(Alpha(0.0f, 0.1f), 0.0f, 1e-7f));
	CHECK(Near(Alpha(1.0f, 0.0f), 1.0f, 1e-7f));
	{
		// two half steps are one whole one
		const float a1 = Alpha(0.02f, 0.07f);
		const float a2 = Alpha(0.01f, 0.07f);
		CHECK(Near(1.0f - (1.0f - a2) * (1.0f - a2), a1, 1e-6f));
	}
	{
		// a tilt that has to go from 0 to 20 degrees in one second of constant target ends in the same place at 30 and at 200 fps
		Tilt t30, t200;
		TiltStep(t30, 0, 0, 0.0f, 0.07f);
		TiltStep(t200, 0, 0, 0.0f, 0.07f);
		for (int i = 0; i < 30; i++)
			TiltStep(t30, 20, -10, 1.0f / 30.0f, 0.07f);
		for (int i = 0; i < 200; i++)
			TiltStep(t200, 20, -10, 1.0f / 200.0f, 0.07f);
		CHECK(Near(t30.pitch, t200.pitch, 1e-3f));
		CHECK(Near(t30.roll, t200.roll, 1e-3f));
		CHECK(t30.pitch > 19.9f && t30.roll < -9.9f);
		// the limit
		Tilt big;
		TiltStep(big, 80, -80, 0.0f, 0.1f);
		CHECK(Near(big.pitch, 50, 1e-4f) && Near(big.roll, -50, 1e-4f));
		// a first frame, or one after a long gap, takes the target whole
		Tilt late;
		TiltStep(late, 3, 4, 0.0f, 0.1f);
		TiltStep(late, 10, 11, 0.9f, 0.1f);
		CHECK(Near(late.pitch, 10, 1e-4f));
	}

	// ---- the chase camera (HL Rally's: it looks along the velocity, 40 behind, 15 down) ----
	// one step of the whole camera with no wall: the aim, then the finish
	struct Cam
	{
		ChaseState st;
		ChaseParams cp;
		Pose Step(const V3& car, float heading, const V3& vel, float dt, float fraction = 1.0f)
		{
			const ChaseAim a = ChaseAimOf(st, heading, vel, dt, cp);
			return ChaseFinish(st, car, vel, a, fraction, dt, cp);
		}
	};
	{
		Cam c;
		const V3 car(100, 200, 40);
		// standing still, heading east: 40 west of the car, 10 up (HL Rally's pivot: view.cpp:547 +26 and :416 -16), looking 15 down along the nose
		Pose p = c.Step(car, 0.0f, V3(), 0.0f);
		const Axes v = ViewVectors(p.pitch, p.yaw, p.roll);
		CHECK(Near(p.yaw, 0.0f, 1e-3f) && Near(p.pitch, 15.0f, 1e-3f) && Near(p.roll, 0.0f, 1e-6f));
		CHECK(NearV(p.org, V3(100, 200, 50) - v.f * 40.0f, 1e-3f));
		// the camera looks along the direction it sits on: the point 10 over the car's origin is on the line of sight 40 ahead of it
		CHECK(NearV(p.org + v.f * 40.0f, V3(100, 200, 50), 1e-3f));
		// going 240 u/s east: the distance rests 12 further (6 * min(240 / 120, 2))
		for (int i = 0; i < 400; i++)
			p = c.Step(car, 0.0f, V3(240, 0, 0), 1.0f / 99.0f);
		CHECK(Near(c.st.dist, 52.0f, 0.05f));
		CHECK(Near(p.yaw, 0.0f, 0.05f) && Near(p.pitch, 15.0f, 0.05f));
		// faster adds no more
		for (int i = 0; i < 400; i++)
			c.Step(car, 0.0f, V3(900, 0, 0), 1.0f / 99.0f);
		CHECK(Near(c.st.dist, 52.0f, 0.05f));
		// a velocity climbing 20 degrees: the camera's pitch is 15 - 20 = -5 (it looks a little up, along the slope)
		const V3 up20(300 * cosf(Rad(20)), 0, 300 * sinf(Rad(20)));
		Cam d;
		for (int i = 0; i < 600; i++)
			d.Step(car, 0.0f, up20, 1.0f / 99.0f);
		CHECK(Near(d.st.pitch, -5.0f, 0.1f));
	}
	// it follows the VELOCITY: in a slide the nose turns in front of the camera, and in reverse the camera swings round
	{
		Cam c;
		const V3 car(0, 0, 0);
		// the nose at 30 degrees, the car going north: the camera sits behind the travel
		for (int i = 0; i < 300; i++)
			c.Step(car, 30.0f, V3(0, 300, 0), 1.0f / 99.0f);
		CHECK(Near(c.st.yaw, 90.0f, 0.1f));
		// reverse: the nose east, the car going west: the camera's yaw goes to 180
		Cam r;
		for (int i = 0; i < 300; i++)
			r.Step(car, 0.0f, V3(-300, 0, 0), 1.0f / 99.0f);
		CHECK(Near(Wrap180(r.st.yaw - 180.0f), 0.0f, 0.1f));
		// under 5 u/s it goes back to the nose
		Cam s;
		for (int i = 0; i < 300; i++)
			s.Step(car, 120.0f, V3(4, 0, 0), 1.0f / 99.0f);
		CHECK(Near(s.st.yaw, 120.0f, 0.1f));
	}
	// the easing: a quarter of the way to the new yaw per reference frame, the same at any frame rate
	{
		Cam c;
		const V3 car(0, 0, 0);
		c.Step(car, 0.0f, V3(300, 0, 0), 0.0f);
		c.Step(car, 0.0f, V3(0, 300, 0), 1.0f / 99.0f); // the velocity turns 90 degrees at once: 22.5 of it in one reference frame
		CHECK(Near(c.st.yaw, 22.5f, 0.01f));
		CHECK(Near(RefTau(0.75f), 0.0351f, 0.0005f));
		// 0.1 s at 30, 60, 100 and 200 fps ends in the same place
		float y2[4];
		const int f2[4] = {30, 60, 100, 200};
		for (int k = 0; k < 4; k++)
		{
			Cam e;
			e.Step(car, 0.0f, V3(300, 0, 0), 0.0f);
			for (int i = 0; i < f2[k] / 10; i++)
				e.Step(car, 0.0f, V3(0, 300, 0), 1.0f / (float)f2[k]);
			y2[k] = e.st.yaw;
		}
		for (int k = 1; k < 4; k++)
			CHECK(Near(y2[k], y2[0], 0.05f));
		// the pitch goal's (new + 8 old) / 9
		Cam f;
		f.Step(car, 0.0f, V3(), 0.0f); // pitch 15
		const V3 climb(300 * cosf(Rad(30)), 0, 300 * sinf(Rad(30))); // goal -15
		f.Step(car, 0.0f, climb, 1.0f / 99.0f);
		CHECK(Near(f.st.pitchGoal, 15.0f + (-15.0f - 15.0f) / 9.0f, 0.01f));
	}
	// no jitter: at 200 fps, a car moving steadily gives a camera that moves steadily
	{
		Cam c;
		const float dt = 1.0f / 200.0f;
		V3 car(0, 0, 0);
		for (int i = 0; i < 400; i++) // settle
		{
			car.x += 500.0f * dt;
			c.Step(car, 0.0f, V3(500, 0, 0), dt);
		}
		V3 prev;
		float maxJump = 0;
		for (int i = 0; i < 400; i++)
		{
			car.x += 500.0f * dt;
			const Pose p = c.Step(car, 0.0f, V3(500, 0, 0), dt);
			if (i > 0)
			{
				const float jump = fabsf((p.org - prev).Length() - 500.0f * dt);
				if (jump > maxJump)
					maxJump = jump;
			}
			prev = p.org;
		}
		CHECK(maxJump < 1e-3f);
	}
	// the pull-in: a wall at 30 takes the camera in to wall - 8 (never under 20), coming in 1/6 a frame and going out 1/30
	{
		Cam c;
		const V3 car(0, 0, 0);
		c.Step(car, 0.0f, V3(), 0.0f);
		CHECK(Near(c.st.dist, 40.0f, 1e-4f));
		for (int i = 0; i < 200; i++)
			c.Step(car, 0.0f, V3(), 1.0f / 99.0f, 0.75f); // wall at 30: wanted 22
		CHECK(Near(c.st.dist, 22.0f, 0.05f));
		for (int i = 0; i < 200; i++)
			c.Step(car, 0.0f, V3(), 1.0f / 99.0f, 0.4f); // wall at 16: 20 is the least
		CHECK(Near(c.st.dist, 20.0f, 0.05f));
		// in: most of the way in 0.1 s; out: about a third of the way in 0.1 s
		Cam in, out;
		in.Step(car, 0.0f, V3(), 0.0f);
		out.Step(car, 0.0f, V3(), 0.0f);
		for (int i = 0; i < 200; i++)
			out.Step(car, 0.0f, V3(), 1.0f / 99.0f, 0.5f);
		for (int i = 0; i < 10; i++)
			in.Step(car, 0.0f, V3(), 1.0f / 100.0f, 0.5f); // 0.1 s, in
		CHECK(in.st.dist < 40.0f - 12.0f * 0.8f);
		const float from = out.st.dist;
		for (int i = 0; i < 10; i++)
			out.Step(car, 0.0f, V3(), 1.0f / 100.0f, 1.0f); // 0.1 s, out
		CHECK(out.st.dist > from + 0.2f * (40.0f - from) && out.st.dist < from + 0.5f * (40.0f - from));
		// frame-rate independent
		Cam a, b;
		a.Step(car, 0.0f, V3(), 0.0f);
		b.Step(car, 0.0f, V3(), 0.0f);
		for (int i = 0; i < 30; i++)
			a.Step(car, 0.0f, V3(), 1.0f / 30.0f, 0.5f);
		for (int i = 0; i < 200; i++)
			b.Step(car, 0.0f, V3(), 1.0f / 200.0f, 0.5f);
		CHECK(Near(a.st.dist, b.st.dist, 0.05f));
		// the trace's ends: from the origin 8 up to the camera, and 16 over it
		V3 st, lo, hi;
		ChaseAim aim;
		aim.yaw = 0.0f;
		aim.pitch = 15.0f;
		ChaseTrace(V3(10, 20, 30), aim, 40.0f, st, lo, hi);
		CHECK(NearV(st, V3(10, 20, 38), 1e-4f));
		CHECK(Near((lo - V3(10, 20, 30)).Length(), 40.0f, 1e-3f) && lo.x < 10.0f && lo.z > 30.0f);
		CHECK(Near((hi - lo).Length(), 16.0f, 1e-3f));
		// inside the world: the distance stays
		Cam w;
		w.Step(car, 0.0f, V3(), 0.0f);
		for (int i = 0; i < 50; i++)
			w.Step(car, 0.0f, V3(), 1.0f / 99.0f, 0.5f);
		const float held = w.st.dist;
		for (int i = 0; i < 50; i++)
			w.Step(car, 0.0f, V3(), 1.0f / 99.0f, -1.0f);
		CHECK(Near(w.st.dist, held, 1e-4f));
	}
	// the camera is the same at 30 and at 200 frames a second
	{
		float endYaw[2] = {0, 0};
		V3 endOrg[2];
		for (int pass = 0; pass < 2; pass++)
		{
			const int fps = pass == 0 ? 30 : 200;
			Cam c;
			const float dt = 1.0f / (float)fps;
			float heading = 0;
			V3 car(0, 0, 0);
			Pose last;
			c.Step(car, 0.0f, V3(400, 0, 0), 0.0f);
			// a second of steering left at 100 degrees a second, then half a second straight, the car at 400 u/s all the way
			for (int i = 0; i < fps * 3 / 2; i++)
			{
				const float t = (float)(i + 1) * dt;
				heading = t < 1.0f ? 100.0f * t : 100.0f;
				car = V3(car.x + cosf(Rad(heading)) * 400.0f * dt, car.y + sinf(Rad(heading)) * 400.0f * dt, 0);
				last = c.Step(car, heading, V3(cosf(Rad(heading)) * 400.0f, sinf(Rad(heading)) * 400.0f, 0), dt);
			}
			endYaw[pass] = last.yaw;
			endOrg[pass] = last.org - car;
		}
		CHECK(Near(endYaw[0], endYaw[1], 1.5f));
		CHECK(NearV(endOrg[0], endOrg[1], 3.0f));
	}
	// the height is the car's own at once (HL Rally eases none in third person, view.cpp:813): a kerb of 4 is 4 on the very next frame
	{
		Cam c;
		c.Step(V3(0, 0, 0), 0.0f, V3(), 0.0f);
		Pose p = c.Step(V3(0, 0, 4), 0.0f, V3(), 1.0f / 60.0f);
		V3 base = p.org + ViewVectors(p.pitch, p.yaw, 0).f * c.st.dist;
		CHECK(Near(base.z, 14.0f, 1e-3f));
	}
	// a first frame (or one after a pause) puts the camera straight behind, no sweep
	{
		Cam c;
		const Pose p = c.Step(V3(0, 0, 0), 135.0f, V3(), 5.0f);
		CHECK(Near(c.st.yaw, 135.0f, 1e-4f));
		CHECK(p.org.x > 0.0f && p.org.y < 0.0f); // behind a car facing north-west is south-east
	}

	// ---- the driver's seat: HL Rally's bonnet, 6 ahead and 15 up ----
	{
		FirstParams fp;
		CHECK(Near(fp.ahead, 6.0f, 1e-6f) && Near(fp.up, 15.0f, 1e-6f));
		FirstState fs;
		Tilt t;
		t.init = true;
		const Pose p = FirstStep(fs, V3(0, 0, 0), 90.0f, t, 0.0f, fp);
		CHECK(NearV(p.org, V3(0, 6, 15), 1e-3f));
		fs.yaw = 0; // a turn is not lagged
		const Pose q = FirstStep(fs, V3(0, 0, 0), 120.0f, t, 1.0f / 99.0f, fp);
		CHECK(Near(q.yaw, 120.0f, 1e-3f));
	}

	// ---- the side camera: HL Rally's view.cpp:739-746, forward * -25 + right * 13.75 + up * 10 ----
	{
		const FirstParams sp = FirstParams::Side();
		CHECK(Near(sp.ahead, -25.0f, 1e-6f) && Near(sp.side, 13.75f, 1e-6f) && Near(sp.up, 10.0f, 1e-6f));
		FirstState fs;
		Tilt t;
		t.init = true;
		const Pose p = FirstStep(fs, V3(0, 0, 0), 90.0f, t, 0.0f, sp); // heading north: forward is +y, right is +x
		CHECK(NearV(p.org, V3(13.75f, -25.0f, 10.0f), 1e-3f));
		// tilted: the offset is along the car's own axes
		Tilt u;
		u.init = true;
		u.pitch = 20.0f;
		u.roll = -10.0f;
		FirstState fs2;
		const Pose q = FirstStep(fs2, V3(5, 6, 7), 30.0f, u, 0.0f, sp);
		const Axes a = EntityMatrixColumns(20.0f, 30.0f, -10.0f);
		CHECK(NearV(q.org, V3(5, 6, 7) + a.f * -25.0f + a.l * -13.75f + a.n * 10.0f, 1e-3f));
	}

	// ---- the views: the `c` key goes chase, bonnet, side, [TV,] interior (rally.cfg changeview) ----
	{
		CHECK(NextView(VIEW_CHASE, true) == VIEW_BONNET && NextView(VIEW_BONNET, true) == VIEW_SIDE);
		CHECK(NextView(VIEW_SIDE, true) == VIEW_INTERIOR && NextView(VIEW_INTERIOR, true) == VIEW_CHASE);
		CHECK(NextView(VIEW_SIDE, false) == VIEW_CHASE); // no model: the interior is skipped
		CHECK(ViewInForce(VIEW_INTERIOR, false) == VIEW_CHASE && ViewInForce(VIEW_INTERIOR, true) == VIEW_INTERIOR);
		CHECK(ViewInForce(VIEW_TV, true) == VIEW_CHASE && ViewInForce(VIEW_SIDE, false) == VIEW_SIDE);
		CHECK(!ViewShowsCar(VIEW_INTERIOR) && ViewShowsCar(VIEW_CHASE) && ViewShowsCar(VIEW_BONNET) && ViewShowsCar(VIEW_SIDE));
		// chase_zoom.cfg: middle 70, far 100, close 35, middle 70 ...
		int step = 0;
		CHECK(Near(ChaseZoomDistance(step), 70.0f, 1e-6f) && Near(ChaseZoomDistance(step), 100.0f, 1e-6f));
		CHECK(Near(ChaseZoomDistance(step), 35.0f, 1e-6f) && Near(ChaseZoomDistance(step), 70.0f, 1e-6f));
	}

	// ---- the terrain probes' points give the tilt, as the diagonals do ----
	{
		PlaneGround g = {0.21f, -0.33f, 7};
		const float cy = cosf(Rad(40.0f)), sy = sinf(Rad(40.0f));
		auto P = [&](float px, float py) {
			const float x = 300 + cy * px - sy * py, y = -120 + sy * px + cy * py;
			return V3(x, y, g.At(x, y));
		};
		const V3 n1 = NormalFromPoints(P(kProbeForward, kProbeRight), P(kProbeForward, -kProbeRight), P(-kProbeForward, kProbeRight), P(-kProbeForward, -kProbeRight));
		const V3 n2 = NormalOn(g, 300, -120, 40.0f, kProbeForward, kProbeRight);
		CHECK(NearV(n1, n2, 1e-4f));
		CHECK(Near(kProbeForward, 12.0f, 1e-6f) && Near(kProbeRight, 8.0f, 1e-6f) && Near(kProbeReach, 2.0f, 1e-6f)); // :1091, :1258-1259
	}

	// ---- the roughness: the texture rule, the noise's size, the wheel's wobble (StudioModelRenderer.cpp:1338-1378, 1602-1650) ----
	{
		CHECK(Near(RoughMul("dirt1", false), 0.006f, 1e-7f) && Near(RoughMul("GRASS", true), 0.006f, 1e-7f) && Near(RoughMul("snow2", false), 0.006f, 1e-7f));
		CHECK(Near(RoughMul("road01", false), 0.002f, 1e-7f) && Near(RoughMul("ROAD01", true), 0.003f, 1e-7f));
		CHECK(Near(RoughMul("roadgras", false), 0.006f, 1e-7f)); // it is grass first
		CHECK(Near(RoughMul("concrete", true), 0.006f, 1e-7f) && Near(RoughMul(nullptr, false), 0.006f, 1e-7f));
		CHECK(Near(RoughAngle(150.0f, 0.006f, 1.0f), 0.9f, 1e-5f));
		CHECK(Near(RoughAngle(1000.0f, 0.006f, 1.0f), 1.8f, 1e-5f) && Near(RoughAngle(1000.0f, 0.002f, -1.0f), -0.6f, 1e-5f)); // +-1.8, +-0.6 at 300 and over
		CHECK(Near(WheelRough(5.0f, 0.006f, 1.0f), 0.0f, 1e-7f));
		CHECK(Near(WheelRough(200.0f, 0.003f, 1.0f), 1.2f, 1e-5f) && Near(WheelRough(900.0f, 0.006f, -1.0f), -6.0f, 1e-5f)); // up to +-6 bytes on dirt
		// the noise is drawn at HL Rally's 99 a second at any frame rate
		const int fps[4] = {60, 99, 200, 300};
		for (int k = 0; k < 4; k++)
		{
			NoiseHold n;
			int draws = 0;
			for (int i = 0; i < fps[k] * 10; i++)
				if (NoiseDue(n, 1.0f / (float)fps[k]))
					draws++;
			if (fps[k] <= 99)
				CHECK(draws >= fps[k] * 10 - 12);
			else
				CHECK(draws > 975 && draws < 1000);
		}
	}

	// ---- the interior's controllers, with the byte's wrap (StudioModelRenderer.cpp:1533-1544, 1632, 1717-1726) ----
	{
		CHECK(SpeedoController(0.0f) == 251);   // -5 at rest wraps to 251: the needle at -4.7 degrees
		CHECK(SpeedoController(100.0f) == 236); // -20.26 cut to -20
		CHECK(SpeedoController(812.5f) == 6 && SpeedoController(5000.0f) == 6); // held at -250: byte 6, the needle at -293 degrees
		CHECK(TachoController(15.0f) == 238 && TachoController(100.0f) == 136 && TachoController(250.0f) == 1 && TachoController(0.0f) == 0);
		CHECK(Near(WheelController(0.0f, 0.0f), 127.0f, 1e-6f) && Near(WheelController(2.0f, 0.0f), 157.0f, 1e-6f));
		CHECK(Near(WheelController(10.0f, 0.0f), 255.0f, 1e-6f) && Near(WheelController(-10.0f, 3.0f), 0.0f, 1e-6f));
		CHECK(Near(WheelController(8.0f, 0.0f), 247.0f, 1e-6f) && Near(WheelController(8.5f, 0.0f), 254.5f, 1e-4f)); // full lock from 8.47
		CHECK(ControllerByte(-5.0f) == 251 && ControllerByte(-0.9f) == 0 && ControllerByte(255.0f) == 255);
	}

	// ---- the interior's filter: (new + 9 old) / 10 a reference frame, 9 degrees off for the model, the wheel's (new + old) / 2 ----
	{
		InteriorState st;
		InteriorOut o = InteriorStep(st, true, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 15.0f, 0.0f); // the first frame takes the target whole
		o = InteriorStep(st, true, 10.0f, -5.0f, 0.0f, 0.0f, 0.0f, 15.0f, 1.0f / 99.0f);
		CHECK(Near(st.pitchHist, 1.0f, 1e-3f) && Near(st.rollHist, -0.5f, 1e-3f));
		CHECK(Near(o.camPitch, -1.0f, 1e-3f) && Near(o.camRoll, -0.5f, 1e-3f)); // the view's pitch is the tilt's, turned about (a nose up looks up)
		CHECK(Near(o.modelPitch, 1.0f - 9.0f, 1e-3f) && Near(o.modelRoll, -0.5f, 1e-3f));
		CHECK(o.speedo == 251 && o.tacho == 238 && o.wheel == 127);
		// the wheel to 255 from 127: half the way in a frame
		InteriorState w;
		InteriorStep(w, true, 0, 0, 0.0f, 0.0f, 0, 15, 0.0f);
		o = InteriorStep(w, true, 0, 0, 10.0f, 0.0f, 0, 15, 1.0f / 99.0f);
		CHECK(o.wheel == 191);
		// the same after a tenth of a second at 60 and 200 frames a second
		float ends[2];
		const int rates[2] = {60, 200};
		for (int k = 0; k < 2; k++)
		{
			InteriorState q;
			InteriorStep(q, true, 0, 0, 0, 0, 0, 15, 0.0f);
			for (int i = 0; i < rates[k] / 10; i++)
				InteriorStep(q, true, 10.0f, 0, 0, 0, 0, 15, 1.0f / (float)rates[k]);
			ends[k] = q.pitchHist;
		}
		CHECK(Near(ends[0], ends[1], 1e-3f) && Near(ends[0], 10.0f * (1.0f - powf(0.9f, 9.9f)), 1e-2f));
		// in the air the pitch sinks 4.4 a second and the roll stays; no wobble in the wheel
		InteriorState a;
		InteriorStep(a, true, 3.0f, 2.0f, 0, 0, 0, 15, 0.0f);
		o = InteriorStep(a, false, 9.0f, 9.0f, 0, 5.0f, 0, 15, 0.5f);
		CHECK(Near(a.pitchHist, 3.0f - 2.2f, 1e-4f) && Near(a.rollHist, 2.0f, 1e-6f));
	}

	// ---- the body: HL Rally's filters (new + 4 old) / 5 for the pitch and (new + 3 old) / 4 for the roll (:1440-1441), in the air 12.4 / 20.4 a second ----
	{
		Tilt t;
		TiltStep(t, 0, 0, 0.0f, RefTau(0.8f), RefTau(0.75f));
		TiltStep(t, 10, 10, 1.0f / 99.0f, RefTau(0.8f), RefTau(0.75f));
		CHECK(Near(t.pitch, 2.0f, 1e-3f) && Near(t.roll, 2.5f, 1e-3f));
		float p = 0, r = 0;
		AirDrift(p, r, true, 0.1f);
		CHECK(Near(p, -1.24f, 1e-4f) && Near(r, -1.24f, 1e-4f)); // nose down, roll away from 0 (to the negative side at exactly 0)
		p = 0;
		r = 5.0f;
		AirDrift(p, r, false, 0.1f);
		CHECK(Near(p, -2.04f, 1e-4f) && Near(r, 6.24f, 1e-4f));
		// no squat while the tyres slip (:1432), and the interior's has no such test
		float pit = 0, rol = 0;
		BodyMotion(100.0f, 0.0f, false, true, pit, rol, true);
		CHECK(Near(pit, 0.0f, 1e-6f));
	}

	// ---- the front wheels' steering byte (:2013-2020): 127 - 20 * the wheel, held 0..255, cut ----
	CHECK(CarSteerByte(0.0f) == 127 && CarSteerByte(3.0f) == 67 && CarSteerByte(-3.0f) == 187);
	CHECK(CarSteerByte(10.0f) == 0 && CarSteerByte(-10.0f) == 255 && CarSteerByte(6.35f) == 0 && CarSteerByte(-6.0f) == 247);
	CHECK(CarSteerByte(0.5f) == 117 && CarSteerByte(-0.025f) == 127);

	// ---- the tyres' turn (StudioProcessGait): a factor of the rolling the speed gives ----
	// WheelSpinFactor(braketime, speed, braking, accelerating, reversing, handbrake, traction, dt): HL Rally's g_braking, g_accelerating, g_reversing,
	// g_handbraking and g_tractionloss as the steering leaves them (StudioModelRenderer.cpp:2086-2128)
	{
		float bt = 0;
		CHECK(Near(WheelSpinFactor(bt, 200.0f, false, true, false, false, 0.0f, 0.01f), 1.0f, 1e-6f));
		CHECK(Near(WheelSpinFactor(bt, 200.0f, false, false, false, true, 0.0f, 0.01f), 0.0f, 1e-6f)); // the handbrake stops them (:2111)
		CHECK(Near(WheelSpinFactor(bt, 200.0f, false, true, false, false, 0.5f, 0.01f), 5.0f, 1e-6f)); // a slide: five times (:2115)
		CHECK(Near(WheelSpinFactor(bt, 30.0f, false, false, true, false, 0.0f, 0.01f), -1.0f, 1e-6f)); // reversing (g_braking is 0 then): turned back (:2105)
		// braking at 200 u/s: fps = 80, so after 40 reference frames half of it is left, after 80 none (:2089-2102)
		bt = 0;
		float f = 1.0f;
		for (int i = 0; i < 40; i++)
			f = WheelSpinFactor(bt, 200.0f, true, false, false, false, 0.0f, 1.0f / 99.0f);
		CHECK(Near(f, 0.5f, 0.02f));
		for (int i = 0; i < 40; i++)
			f = WheelSpinFactor(bt, 200.0f, true, false, false, false, 0.0f, 1.0f / 99.0f);
		CHECK(Near(f, 0.0f, 0.02f));
		// the throttle pressed with the brake takes the lock off (:2089)
		CHECK(Near(WheelSpinFactor(bt, 200.0f, true, true, false, false, 0.0f, 0.01f), 1.0f, 1e-6f) && Near(bt, 0.0f, 1e-6f));
	}

	// ---- S13: how fast the tyres turn for the speed ----
	// HL Rally plays whlRotate at fps = speed / 2.5 (StudioModelRenderer.cpp:2091). Measured on models/player/xsara/xsara.mdl with the SMAK kit
	// (info: sequences 1 to 3 are 19 frames; poseAt of WHEEL-LefBack over the 19 frames: steps of -22.25, -18.20, -17.80, -18.20 degrees a frame,
	// -360.00 in all): one full turn per 19 frames.
	{
		CHECK(Near(kWheelFramesPerTurn, 19.0f, 1e-6f));
		CHECK(Near(WheelDegPerSecPerSpeed(), 360.0f / (19.0f * 2.5f), 1e-4f) && Near(WheelDegPerSecPerSpeed(), 7.5789f, 1e-3f));
		CHECK(Near(kWheelCircumference, 47.5f, 1e-4f)); // a turn per 47.5 units rolled
		// 100 u/s for one second: 2.105 turns
		CHECK(Near(RollPhase(0.0f, 100.0f * 1.0f, kWheelCircumference), 100.0f / 47.5f - 2.0f, 1e-4f));
		// and the turn per second is the same degrees whatever the step: a tenth of a second ten times equals one second
		float ph = 0.0f;
		for (int i = 0; i < 10; i++)
			ph = RollPhase(ph, 100.0f * 0.1f, kWheelCircumference);
		CHECK(Near(ph * 360.0f, 100.0f * WheelDegPerSecPerSpeed() - 720.0f, 1e-2f));
		// our model's roll sequence (rc_rally_xs.mdl: 31 frames, wheel_rl turns 12 degrees a frame, 360 over 30 steps) is one turn over the sequence
		CHECK(Near(12.0f * 30.0f, 360.0f, 1e-6f));
	}

	// ---- S14: the suspension (StudioModelRenderer.cpp:896-915, 1449-1463): (fraction - 0.5) * 4 on four named bones ----
	{
		CHECK(Near(ShockOffset(0.5f), 0.0f, 1e-6f) && Near(ShockOffset(1.0f), 2.0f, 1e-6f) && Near(ShockOffset(0.0f), -2.0f, 1e-6f));
		CHECK(Near(ShockOffset(0.75f), 1.0f, 1e-6f)); // an origin a unit over the floor: 3 of the 4 units, +1
		// ours is on the floor, so the trace starts 3 over and ends 1 under: the same 4 units, the floor at 3 of them
		CHECK(Near(kShockFrom + kShockTo, 4.0f, 1e-6f) && Near((kShockFrom - 0.0f) / (kShockFrom + kShockTo), 0.75f, 1e-6f));
		CHECK(0 == strcmp(kShockBone[0], "SHOCK-RghFron") && 0 == strcmp(kShockBone[1], "SHOCK-LefFron") && 0 == strcmp(kShockBone[2], "SHOCK-LefBack") &&
			  0 == strcmp(kShockBone[3], "SHOCK-RghBack"));
	}

	// ---- the mirror (view.cpp:1287-1302): a third wide from the top edge, ScreenHeight / 6.5 high, pitch and roll + 180 ----
	{
		const MirrorView m = MirrorOf(1920, 1080, 5.0f, 3.0f);
		CHECK(m.x == 640 && m.y == 0 && m.w == 640 && m.h == 166);
		CHECK(Near(m.pitch, 185.0f, 1e-4f) && Near(m.roll, 183.0f, 1e-4f));
		const MirrorView n = MirrorOf(1024, 768, 200.0f, 190.0f); // over 360 comes back by 360
		CHECK(n.x == 341 && n.w == 341 && n.h == 118 && Near(n.pitch, 20.0f, 1e-4f) && Near(n.roll, 10.0f, 1e-4f));
	}

	// ---- the interior's heights: the eye 12 over the car, the model 11 (view.cpp:416-417, 544-545, 761-763, 782-789) ----
	CHECK(Near(kInteriorEyeUp, 28.0f - 16.0f, 1e-6f) && Near(kInteriorModelUp, 28.0f - 17.0f - 1.0f + 1.0f, 1e-6f));

	// ---- the body's motion: roll in a slide (at most 7.5), dive under the brake, squat on the throttle below 300 ----
	{
		CHECK(Near(SlideRoll(0.0f), 0.0f, 1e-6f));
		CHECK(Near(SlideRoll(0.1f), 2.5f, 1e-4f));
		CHECK(Near(SlideRoll(1.0f), 7.5f, 1e-4f) && Near(SlideRoll(-1.0f), -7.5f, 1e-4f));
		CHECK(fabsf(SlideRoll(0.7f)) < 7.5f && SlideRoll(0.7f) > SlideRoll(0.3f));
		// the share to the right of the nose: heading east, going south-east is to the right
		CHECK(RightShare(0.0f, V3(300, -300, 0)) > 0.7f && RightShare(0.0f, V3(300, 300, 0)) < -0.7f);
		CHECK(Near(RightShare(0.0f, V3(300, 0, 0)), 0.0f, 1e-6f) && Near(RightShare(0.0f, V3()), 0.0f, 1e-6f));
		// and the body leans out of it: going to the right of the nose rolls the left side up (positive)
		float pit = 0, rol = 0;
		BodyMotion(400.0f, RightShare(0.0f, V3(300, -300, 0)), false, false, pit, rol);
		CHECK(rol > 5.0f && Near(pit, 0.0f, 1e-6f));
		pit = rol = 0;
		BodyMotion(600.0f, 0.0f, true, false, pit, rol); // braking at 600: 4 degrees nose down
		CHECK(Near(pit, -4.0f, 1e-4f));
		pit = rol = 0;
		BodyMotion(100.0f, 0.0f, false, true, pit, rol); // throttle at 100: 3.7 - 0.5 up
		CHECK(Near(pit, 3.2f, 1e-4f));
		pit = rol = 0;
		BodyMotion(400.0f, 0.0f, false, true, pit, rol); // no squat from 300 up
		CHECK(Near(pit, 0.0f, 1e-6f));
		pit = rol = 0;
		BodyMotion(15.0f, 0.5f, true, true, pit, rol); // nothing at 20 or less
		CHECK(Near(pit, 0.0f, 1e-6f) && Near(rol, 0.0f, 1e-6f));
		// the tilt's smoothing is (new + 9 old) / 10 a reference frame: one frame at 99 fps moves a tenth of the way
		Tilt t;
		TiltStep(t, 0, 0, 0.0f, RefTau(0.9f));
		TiltStep(t, 10, 0, 1.0f / 99.0f, RefTau(0.9f));
		CHECK(Near(t.pitch, 1.0f, 1e-3f));
	}

	// ---- the tyres ----
	{
		// 100 units along a tyre of 23 round is 4.35 turns; the phase is the fraction of one
		float ph = 0;
		for (int i = 0; i < 10; i++)
			ph = RollPhase(ph, 10.0f, 23.0f);
		CHECK(Near(ph, 100.0f / 23.0f - 4.0f, 1e-3f));
		// backwards turns it back, and never goes negative
		float b = RollPhase(0.0f, -5.0f, 23.0f);
		CHECK(b >= 0.0f && b < 1.0f && Near(b, 1.0f - 5.0f / 23.0f, 1e-4f));
		// driven in a different number of steps, the same
		float p1 = 0, p2 = 0;
		for (int i = 0; i < 30; i++)
			p1 = RollPhase(p1, 400.0f / 30.0f, 23.0f);
		for (int i = 0; i < 200; i++)
			p2 = RollPhase(p2, 400.0f / 200.0f, 23.0f);
		CHECK(Near(p1, p2, 1e-3f) || Near(fabsf(p1 - p2), 1.0f, 1e-3f));
	}

	// ---- in the air, the nose follows the way the car goes, within a limit ----
	CHECK(Near(AirPitch(0, 400), 0.0f, 1e-4f));
	CHECK(AirPitch(300, 300) > 0.0f && AirPitch(-300, 300) < 0.0f);
	CHECK(AirPitch(9999, 0) <= 30.0f && AirPitch(-9999, 0) >= -30.0f);

	// ---- angles ----
	CHECK(Near(Wrap180(190.0f), -170.0f, 1e-4f) && Near(Wrap180(-190.0f), 170.0f, 1e-4f) && Near(Wrap180(720.0f), 0.0f, 1e-3f));
	CHECK(Near(AngleDelta(170.0f, -170.0f), 20.0f, 1e-4f) && Near(AngleDelta(-170.0f, 170.0f), -20.0f, 1e-4f));

	if (g_failed == 0)
		printf("PASS: %d checks\n", g_checked);
	else
		printf("FAIL: %d of %d checks failed\n", g_failed, g_checked);
	return g_failed == 0 ? 0 : 1;
}
