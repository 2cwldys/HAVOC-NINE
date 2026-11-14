// H9 rally mode's steering, the arithmetic alone (no engine call, no engine type), so tests/rallysteer_test.cpp can run it. The client's
// CL_CreateMove (input.cpp) feeds it what the player asked for this frame and the car's predicted velocity, and writes the heading it
// returns back as the view yaw: that yaw is what the server and the prediction read as the car's heading (pm_shared/h9_rally.cpp).
//
// What it is for. The mouse and the keys do not turn the car: they are an INPUT, the degrees the player asked to turn this frame. The
// heading is kept apart and follows that input through a filter that depends on how the car is going (its slip), so a slide damps the
// steering and a handbrake or power kicks the nose round. This is HL Rally's rule, written again here from its behaviour (input.cpp
// CL_CreateMove, the "steer_delta" block), not copied.
//
// Conventions: the engine's. A heading is a yaw in degrees, positive to the left. `delta` below is the filtered turn, positive to the LEFT,
// in degrees per REFERENCE FRAME (1/99 s: the rate HL Rally was driven at), so the numbers are the ones of that game.
//
// THE FILTER, and why it is written the way it is. HL Rally, once a frame on the ground, with s = |cos(slip angle)| (the nose against the
// velocity), n = 30 (32 while s < 0.96), a = the degrees the input turned this frame:
//     delta' = ( a * rev * s^6 + delta * (1 - s) + delta * (n - 1 + ...) ) / n  =  delta * q + a * rev * s^6 / n,   q = 1 - s / n
// and the heading changes by delta' * 25 * frametime. As a filter per FRAME it is a game of the frame rate: a constant mouse speed r
// (degrees a second) gives a = r / fps, so the heading rate comes out as r * 25 / fps * s^5, 0.25 r at 99 fps and 0.83 r at 30. We want the
// behaviour of 99 frames a second at any frame rate, so the frame is the REFERENCE frame and a step of dt seconds is m = 99 dt of them:
//     a_ref = (the input's degrees this step) / m           (the input per reference frame)
//     delta' = delta * q^m + (a_ref * rev * s^6 / n) * (1 - q^m) / (1 - q)  =  delta * q^m + a_ref * rev * s^5 * (1 - q^m)
// which is the frame filter applied m times with the same input, in closed form (q^m for a step of one reference frame is HL Rally's own
// factor, so at 99 fps this IS its filter), and is exact for any dt. Its resting value is a_ref * rev * s^5 whatever dt is: the steady heading
// rate is delta * 25 per second = r / 99 * 25 * s^5 = 0.2525 * r * s^5 at every frame rate. A step longer than one reference frame is cut into
// pieces of at most one, the terms below that are added once per frame in HL Rally (the handbrake, the power) being added once per piece.
#pragma once

#include <math.h>

namespace rallysteer
{

const float kRefFps = 99.0f;   // the frame rate HL Rally was driven at (fps_max 99): the filter's frame
const float kGain = 25.0f;     // heading degrees a second per unit of delta
const float kKeyRate = 400.0f; // the side keys' raw input, degrees a second (cl_yawspeed 500 is capped at 400 there)
const float kStopSpeed = 5.0f; // at or under this horizontal speed (u/s) the car does not turn at all
const float kFullSpeed = 100.0f; // and it turns by speed / this up to it
const float kWheelMax = 10.0f;   // steer_wheel_angle's limit, degrees
const float kWheelCentre = 20.0f; // and its recentring, units a second

inline float Clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float Wrap360(float a)
{
	a = fmodf(a, 360.0f);
	return a < 0.0f ? a + 360.0f : a;
}
inline float Wrap180(float a)
{
	a = fmodf(a, 360.0f);
	if (a > 180.0f)
		a -= 360.0f;
	else if (a < -180.0f)
		a += 360.0f;
	return a;
}

// The gearbox and the revs that the power term reads, from the speed, as HL Rally's (Rally_Effects.cpp renderCalculateRPMs, automatic).
struct Gearbox
{
	int gear = 0;
	float rpm = 15.0f, oldRpm = 15.0f;
};

// One step. `speedH` the horizontal speed, `onGround`, `revving` the throttle is down (or the back key while reversing), `tractionLoss` 0..1
// from the last steering step (the revs run free while the tyres slip).
inline void GearboxStep(Gearbox& g, float speedH, bool onGround, bool revving, float tractionLoss, float dt)
{
	const float cs = speedH * 3.25f; // "currentspeed"
	const int oldGear = g.gear;
	{
		const float autoSpeed = g.gear > 0 ? cs / (float)(g.gear * 2) : (cs > 0.0f ? 1e9f : 0.0f);
		if (autoSpeed > 190.0f)
			g.gear++;
		else if (autoSpeed < 120.0f && g.gear > 0)
		{
			if (cs > 550.0f)
				g.gear--;
			else if (autoSpeed < 80.0f)
				g.gear--;
		}
		if (g.gear > 6)
			g.gear = 6;
		else if (g.gear < 1)
			g.gear = cs > 5.0f ? 1 : 0;
	}
	(void)oldGear;
	float rpm = g.rpm;
	if (!onGround || g.gear == 0 || tractionLoss > 0.0f || cs < 5.0f)
	{
		if (revving)
			rpm += tractionLoss > 0.0f ? (15.0f + (tractionLoss / (float)(g.gear > 0 ? g.gear : 1)) * 300.0f) * dt : 1100.0f * dt;
		else
			rpm -= 400.0f * dt;
	}
	else
		rpm = cs / (float)(g.gear * 2);
	if (rpm < 10.0f)
	{
		g.oldRpm = 10.0f;
		rpm = 15.0f;
	}
	else if (rpm > 250.0f)
	{
		g.oldRpm = 250.0f;
		rpm = 201.0f;
	}
	else
	{
		float d = dt > 1e-5f ? (rpm - g.oldRpm) / dt : 0.0f;
		d = Clampf(d, -550.0f, 550.0f) * dt;
		rpm = g.oldRpm + d;
		// (old + 3 new) / 4 per reference frame
		const float w = 1.0f - powf(0.25f, kRefFps * dt);
		rpm = g.oldRpm + (rpm - g.oldRpm) * w;
	}
	g.rpm = Clampf(rpm, 15.0f, 250.0f);
	g.oldRpm = g.rpm;
}

struct State
{
	bool init = false;
	float heading = 0;  // the car's heading, 0..360
	float delta = 0;    // the filtered turn, positive to the left, degrees per reference frame
	float wheel = 0;    // the steering wheel's angle as HL Rally keeps it: positive to the RIGHT, +-10
	float tractionLoss = 0;
	Gearbox box;
};

struct Input
{
	float dt = 0;
	float keyYaw = 0;   // the degrees the side keys asked for this step (positive to the left)
	float mouseYaw = 0; // and the mouse (already zero in the air)
	float velX = 0, velY = 0, velZ = 0; // the car's velocity, predicted
	bool onGround = true;
	bool throttle = false; // the forward key
	bool brake = false;    // the back key
	bool handbrake = false; // the jump key
};

struct Output
{
	float heading;
	float slide;     // SlidingDirection: velocity's share to the right of the nose (-1..1)
	float cosSlip;   // s
	bool reversing;
};

// Start again from this heading: a respawn, a teleport, the first frame. The filter and the gearbox are cleared (HL Rally does the same when
// the engine forces the angles), the wheel is kept.
inline void Reset(State& s, float heading)
{
	s.init = true;
	s.heading = Wrap360(heading);
	s.delta = 0;
	s.tractionLoss = 0;
	s.box = Gearbox();
}

// The turn a step's input is worth in the wheel, degrees to the right of the steering wheel: HL Rally's steer_wheel_angle. It moves by the
// input's degrees (a share of them, more when the wheel is nearly straight, less at speed once past 5) and recentres at 20 a second.
inline void WheelStep(State& s, float inputLeft, float speedH, float dt)
{
	float w = s.wheel;
	const float c = kWheelCentre * dt;
	if (w > 0.0f)
		w = w > c ? w - c : 0.0f;
	else if (w < 0.0f)
		w = w < -c ? w + c : 0.0f;
	const float accelRight = -inputLeft;
	const float lowMul = fabsf(w) < 3.0f ? 1.5f : 1.0f;
	if (speedH > 400.0f && !(w < 5.0f))
		w += accelRight * lowMul / 15.0f;
	else
		w += accelRight * lowMul / 10.0f;
	s.wheel = Clampf(w, -kWheelMax, kWheelMax);
}

// One step of the steering. Returns the new heading in out.heading.
inline Output Step(State& s, const Input& in)
{
	Output out;
	out.slide = 0;
	out.cosSlip = 1;
	out.reversing = false;
	if (!s.init)
		Reset(s, s.heading);
	float dt = in.dt;
	if (!(dt > 0.0f))
	{
		out.heading = s.heading;
		return out;
	}
	if (dt > 0.1f)
		dt = 0.1f;
	const float speedH = sqrtf(in.velX * in.velX + in.velY * in.velY);
	const float speed3 = sqrtf(speedH * speedH + in.velZ * in.velZ);
	const float inputLeft = in.keyYaw + in.mouseYaw;

	WheelStep(s, inputLeft, speedH, dt);

	float turnGate = 0.0f;
	if (speedH > kStopSpeed)
		turnGate = speedH < kFullSpeed ? speedH / kFullSpeed : 1.0f;

	const float deltaBefore = s.delta;
	if (in.onGround)
	{
		const float hy = s.heading * (3.14159265358979f / 180.0f);
		const float fx = cosf(hy), fy = sinf(hy);   // the nose
		const float rx = fy, ry = -fx;               // its right
		float cosSlip = 0.0f, slideRear = 0.0f, slideFront = 0.0f;
		if (speedH > 1e-3f)
		{
			// HL Rally measures against the full velocity; the horizontal part is what the car's heading can say anything about
			cosSlip = (in.velX * fx + in.velY * fy) / speedH;
			slideRear = (in.velX * rx + in.velY * ry) / speedH;
			// the front wheels' slide: their direction is the heading turned by wheel * 2.5 (HL Rally adds it to the yaw as it stands)
			const float fy2 = (s.heading + s.wheel * 2.5f) * (3.14159265358979f / 180.0f);
			slideFront = (in.velX * sinf(fy2) + in.velY * -cosf(fy2)) / speedH;
		}
		float slide = fabsf(slideFront) < fabsf(slideRear) ? slideFront : slideRear; // the smaller of the two
		const bool rev = cosSlip < 0.0f;
		const float reversing = rev ? -1.0f : 1.0f;
		const float s1 = fabsf(cosSlip);
		const int skid = s1 < 0.96f ? 2 : 0;
		const float n = (float)(30 + skid);

		float a = inputLeft; // degrees to the left this step
		if (in.brake && !rev)
			a *= 1.5f;

		// the power oversteer's gate: the revs and the slip, HL Rally's bands (below 500 u/s one, above another)
		const float rpm = s.box.rpm;
		bool power = false;
		float powerRate = 0.0f;
		float traction = 0.0f;
		const float absSlide = fabsf(slide);
		if (speedH < 500.0f)
		{
			if (((rpm > 145.0f && in.throttle) || rpm > 165.0f) && absSlide > 0.05f && absSlide < 0.85f && s.box.gear != 0)
			{
				power = true;
				powerRate = 7.5f;
				traction = absSlide > 0.3f ? 1.0f : absSlide;
			}
		}
		else
		{
			if (((rpm > 150.0f && in.throttle) || rpm > 170.0f) && absSlide > 0.2f && absSlide < 0.85f && s.box.gear != 0)
			{
				power = true;
				powerRate = 4.5f;
				traction = absSlide > 0.4f ? 1.0f : absSlide / 3.0f;
			}
		}
		s.tractionLoss = traction;

		// the kick terms (per second, in delta's units; positive slide = velocity to the right of the nose: the nose turns to the LEFT)
		float kick = 0.0f;
		if (in.handbrake)
			kick += slide * 6.0f * (absSlide < 0.65f ? 1.0f : 0.5f);
		if (power)
			kick += slide * powerRate * reversing;

		// the filter, one reference frame at a time at most
		const float m = kRefFps * dt;
		const int pieces = m <= 1.0f ? 1 : (int)ceilf(m);
		const float h = m / (float)pieces; // reference frames in a piece
		const float q = 1.0f - s1 / n;
		const float qh = powf(q, h);
		const float aRef = a / m;
		const float s5 = powf(s1, 5.0f);
		for (int i = 0; i < pieces; i++)
		{
			s.delta += kick / kRefFps * h; // the kick: its rate (units a second) over the piece's time
			s.delta = s.delta * qh + aRef * reversing * s5 * (1.0f - qh);
		}
		out.slide = slide;
		out.cosSlip = cosSlip;
		out.reversing = rev;
	}
	else
		s.tractionLoss = 0.0f;

	// the heading: delta is degrees per reference frame, so kGain * delta degrees a second
	const float turn = 0.5f * (deltaBefore + s.delta) * kGain * dt * turnGate;
	s.heading = Wrap360(s.heading + turn);

	GearboxStep(s.box, speedH, in.onGround, in.throttle || (in.brake && speed3 < 40.0f), s.tractionLoss, dt);
	out.heading = s.heading;
	return out;
}

} // namespace rallysteer
