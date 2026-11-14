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
	CHECK(IsCarBox(V3(-16, -16, 0), V3(16, 16, 16)));           // rally mode's box (dlls/h9_rally_srv.cpp)
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
		CHECK(NearV(m.n, n, 1e-3f));
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

	// ---- the chase camera ----
	{
		ChaseParams cp; // 70 back, 26 up, 18 ahead
		ChaseState st;
		const V3 car(100, 200, 40);
		// steady: the heading is east; the camera is 70 west of the car, 26 above its origin, looking down a little at the point 18 ahead
		Pose p = ChaseStep(st, car, 0.0f, V3(300, 0, 0), 0.0f, cp);
		CHECK(NearV(p.org, V3(30, 200, 66), 1e-3f));
		CHECK(Near(p.yaw, 0.0f, 1e-3f));
		CHECK(p.pitch > 0.0f && p.pitch < 30.0f);                  // looks down
		CHECK(Near(p.pitch, Deg(atanf((66.0f - 48.0f) / 88.0f)), 1e-2f)); // at the point (118, 200, 48)
		CHECK(Near(p.roll, 0.0f, 1e-6f));
		// the car in the picture's middle: the line of sight passes the point 18 ahead
		const Axes v = ViewVectors(p.pitch, p.yaw, p.roll);
		const V3 toLook = V3(118, 200, 48) - p.org;
		CHECK(NearV(v.f * toLook.Length(), toLook, 1e-2f));

		// the heading turns 90 degrees left at once: the camera's heading is behind it, and gets there
		ChaseState s2;
		ChaseStep(s2, car, 0.0f, V3(300, 0, 0), 0.0f, cp);
		const float dt = 1.0f / 60.0f;
		Pose q = ChaseStep(s2, car, 90.0f, V3(300, 0, 0), dt, cp);
		CHECK(s2.yaw > 0.0f && s2.yaw < 45.0f); // part of the way after one frame
		for (int i = 0; i < 60; i++)
			q = ChaseStep(s2, car, 90.0f, V3(0, 300, 0), dt, cp);
		CHECK(Near(s2.yaw, 90.0f, 0.5f));
		CHECK(NearV(q.org, V3(100, 130, 66), 0.5f)); // 70 south of the car now
	}
	// the lag grows in a slide: the same turn, the car going sideways, is slower
	{
		ChaseParams cp;
		ChaseState road, slide;
		const V3 car(0, 0, 0);
		ChaseStep(road, car, 0.0f, V3(500, 0, 0), 0.0f, cp);
		ChaseStep(slide, car, 0.0f, V3(500, 0, 0), 0.0f, cp);
		for (int i = 0; i < 4; i++)
		{
			ChaseStep(road, car, 60.0f, V3(500, 0, 0), 1.0f / 60.0f, cp);    // nose turned, going where it points: no slip? (it still goes east)
			ChaseStep(slide, car, 60.0f, V3(0, 500, 0) * 1.0f, 1.0f / 60.0f, cp); // going north, nose at 60
		}
		CHECK(SlipAngle(60.0f, V3(0, 500, 0), 60.0f) > 25.0f && SlipAngle(60.0f, V3(0, 500, 0), 60.0f) < 35.0f);
		CHECK(SlipAngle(60.0f, V3(500 * cosf(Rad(60)), 500 * sinf(Rad(60)), 0), 60.0f) < 0.01f);
		// the slide's camera is further behind the car's heading than the one with a straight track would be
		ChaseState straight;
		ChaseStep(straight, car, 0.0f, V3(500, 0, 0), 0.0f, cp);
		for (int i = 0; i < 4; i++)
			ChaseStep(straight, car, 60.0f, V3(500 * cosf(Rad(60)), 500 * sinf(Rad(60)), 0), 1.0f / 60.0f, cp);
		CHECK(slide.yaw < straight.yaw - 0.5f);
		// backwards is not a slide: the slip is measured from the tail
		CHECK(SlipAngle(0.0f, V3(-300, 0, 0), 60.0f) < 0.01f);
		// no speed, no slide
		CHECK(Near(SlipAngle(10.0f, V3(5, 0, 0), 60.0f), 0.0f, 1e-6f));
	}
	// the camera is the same at 30 and at 200 frames a second
	{
		ChaseParams cp;
		float endYaw30 = 0, endYaw200 = 0;
		V3 endOrg30, endOrg200; // the camera's place relative to the car
		for (int pass = 0; pass < 2; pass++)
		{
			const int fps = pass == 0 ? 30 : 200;
			ChaseState s;
			const float dt = 1.0f / (float)fps;
			float heading = 0;
			V3 car(0, 0, 0);
			Pose last;
			ChaseStep(s, car, 0.0f, V3(400, 0, 0), 0.0f, cp);
			// a second of steering left at 200 degrees a second, then half a second straight, the car at 400 u/s all the way
			for (int i = 0; i < fps * 3 / 2; i++)
			{
				const float t = (float)(i + 1) * dt;
				heading = t < 1.0f ? 200.0f * t : 200.0f;
				car = V3(car.x + cosf(Rad(heading)) * 400.0f * dt, car.y + sinf(Rad(heading)) * 400.0f * dt, 0);
				last = ChaseStep(s, car, heading, V3(cosf(Rad(heading)) * 400.0f, sinf(Rad(heading)) * 400.0f, 0), dt, cp);
			}
			if (pass == 0)
			{
				endYaw30 = last.yaw;
				endOrg30 = last.org - car;
			}
			else
			{
				endYaw200 = last.yaw;
				endOrg200 = last.org - car;
			}
		}
		CHECK(Near(endYaw30, endYaw200, 1.5f));
		CHECK(NearV(endOrg30, endOrg200, 3.0f));
	}
	// no jitter: at 200 fps, a car moving steadily gives a camera that moves steadily (no step in the camera's own velocity)
	{
		ChaseParams cp;
		ChaseState s;
		const float dt = 1.0f / 200.0f;
		V3 car(0, 0, 0);
		ChaseStep(s, car, 0.0f, V3(500, 0, 0), 0.0f, cp);
		V3 prev;
		float maxJump = 0;
		for (int i = 0; i < 400; i++)
		{
			car.x += 500.0f * dt;
			const Pose p = ChaseStep(s, car, 0.0f, V3(500, 0, 0), dt, cp);
			if (i > 0)
			{
				const float step = (p.org - prev).Length();
				const float jump = fabsf(step - 500.0f * dt);
				if (jump > maxJump)
					maxJump = jump;
			}
			prev = p.org;
		}
		CHECK(maxJump < 1e-3f);
	}
	// the height follows the car's with a lag (a kerb is not a jolt) and gets there
	{
		ChaseParams cp;
		ChaseState s;
		ChaseStep(s, V3(0, 0, 0), 0.0f, V3(), 0.0f, cp);
		Pose p = ChaseStep(s, V3(0, 0, 4), 0.0f, V3(), 1.0f / 60.0f, cp);
		CHECK(p.org.z > 26.0f && p.org.z < 26.0f + 4.0f * 0.3f);
		for (int i = 0; i < 120; i++)
			p = ChaseStep(s, V3(0, 0, 4), 0.0f, V3(), 1.0f / 60.0f, cp);
		CHECK(Near(p.org.z, 30.0f, 0.05f));
	}
	// a first frame (or one after a pause) puts the camera straight behind, no sweep
	{
		ChaseParams cp;
		ChaseState s;
		const Pose p = ChaseStep(s, V3(0, 0, 0), 135.0f, V3(), 5.0f, cp);
		CHECK(Near(s.yaw, 135.0f, 1e-4f));
		CHECK(p.org.x > 0.0f && p.org.y < 0.0f); // behind a car facing north-west is south-east
	}

	// ---- the pull-in ----
	{
		const V3 anchor(0, 0, 30), cam(-70, 0, 56);
		CHECK(NearV(PullIn(anchor, cam, 1.0f, 4, 8), cam, 1e-6f)); // nothing hit
		const float len = (cam - anchor).Length();
		const V3 in = PullIn(anchor, cam, 0.5f, 4, 8);
		CHECK(Near((in - anchor).Length(), len * 0.5f - 4.0f, 1e-3f)); // short of the wall by the margin
		// a wall hard against the car: never closer than the wall allows, nor behind the anchor
		const V3 tight = PullIn(anchor, cam, 0.02f, 4, 8);
		CHECK((tight - anchor).Length() <= len * 0.02f + 1e-4f);
		CHECK((tight - anchor).Length() >= 0.0f);
		// a wall a little way off: the minimum distance holds
		const V3 near = PullIn(anchor, cam, 0.12f, 4, 8);
		CHECK(Near((near - anchor).Length(), 8.0f, 1e-3f) || (near - anchor).Length() > 8.0f - 1e-3f);
		// the direction is kept
		CHECK(Near((in - anchor).Unit().Dot((cam - anchor).Unit()), 1.0f, 1e-5f));
	}

	// ---- the steering and the tyres ----
	CHECK(Near(SteerShown(0, 32, 400), 0, 1e-6f));
	CHECK(Near(SteerShown(400, 32, 400), 32, 1e-4f));   // turning left at the full rate: full left lock
	CHECK(Near(SteerShown(-800, 32, 400), -32, 1e-4f)); // never past the lock
	CHECK(Near(SteerShown(200, 32, 400), 16, 1e-4f));
	CHECK(SteerByte(0, 45) == 128 || SteerByte(0, 45) == 127);
	CHECK(SteerByte(45, 45) == 255);
	CHECK(SteerByte(-45, 45) == 0);
	CHECK(SteerByte(100, 45) == 255);
	CHECK(SteerByte(22.5f, 45) > 190 && SteerByte(22.5f, 45) < 194);
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
