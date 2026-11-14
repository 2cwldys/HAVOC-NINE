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
const float kWheelThreshold = 12.0f; // cl_steer_threshold: the recentring acts only inside it (the wheel's limit is 10, so always)

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

// The gearbox and the revs that the throttle and the power term read, from the speed, as HL Rally's (Rally_Effects.cpp renderCalculateRPMs:
// 252-377). The automatic box shifts by the speed (lines 270-301); the manual one (rally_manual) does not shift by itself: the gear is what
// the gearup and geardown commands left it (input.cpp:471-486), -1 is reverse, 0 neutral, 1 to 6.
struct Gearbox
{
	int gear = 0;
	float rpm = 15.0f, oldRpm = 15.0f;
};

// The commands' own rules (input.cpp:471-486): only in the manual box; up to 6 and down to -1.
inline bool GearUp(Gearbox& g, bool manual)
{
	if (manual && g.gear < 6)
	{
		g.gear++;
		return true;
	}
	return false;
}
inline bool GearDown(Gearbox& g, bool manual)
{
	if (manual && g.gear > -1)
	{
		g.gear--;
		return true; // (HL Rally also sets g_backfire = 2: the exhaust's pop, an effect)
	}
	return false;
}

// One step. `speedH` the horizontal speed, `onGround`, `revving` the throttle is down (HL Rally's g_accelerating, or the accelerator held
// while reversing: g_reversing == 2), `tractionLoss` 0..1 from the last steering step (the revs run free while the tyres slip). `manual`
// is rally_manual; `countdown` (the race's hold) puts the automatic box in neutral (:298-300).
inline void GearboxStep(Gearbox& g, float speedH, bool onGround, bool revving, float tractionLoss, float dt, bool manual = false, bool countdown = false)
{
	const float cs = speedH * 3.25f; // "currentspeed"
	if (!manual)
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
		if (countdown)
			g.gear = 0;
	}
	float rpm = g.rpm;
	if (!onGround || g.gear == 0 || tractionLoss > 0.0f || cs < 5.0f)
	{
		if (revving)
			rpm += tractionLoss > 0.0f ? (15.0f + (tractionLoss / (float)(g.gear != 0 ? g.gear : 1)) * 300.0f) * dt : 1100.0f * dt;
		else
			rpm -= 400.0f * dt;
	}
	else
		rpm = g.gear == -1 ? cs : cs / (float)(g.gear * 2);
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

// ---- the throttle: the forward move the client sends (input.cpp:869-1001) ----------------------------------------------------------
//
// HL Rally does not send "a key is down": it works the forward move out from the revs and the speed, every frame, on the ground, and the
// movement (rally.c:518-537) reads its size as the wish speed and its sign as the direction. Every read of a key in input.cpp goes through
// CL_KeyState, which gives 0.25 .. 0.75 for a press or a release inside the frame and CLEARS those impulses, so only the first read of
// a key in a frame sees the fraction and every later one sees 1 if it is down and 0 if not. The first reads are the "is it pressed at all"
// tests (:871, :877, :890); the reads that multiply the move (:948, :950, :998) come after them, so the fraction never reaches the move
// (audit row 5 said it did: it does not). The caller gives both: `Frac` the first read, `Down` the one after it.
struct DriveIn
{
	bool manual = false;     // rally_manual
	bool onGround = true;    // pmove->onground != -1
	bool klook = false;      // in_klook.state & 1 (the INS key: the forward key then looks)
	int gear = 0;            // the gearbox's
	float rpm = 15.0f;       // rpms
	float speedH = 0.0f;     // the horizontal length of pmove->velocity
	float backFrac = 0, backDown = 0, fwdFrac = 0, fwdDown = 0;
	int reversing = 0;       // g_reversing as the last frame left it (it is not touched in the air)
};
struct DriveOut
{
	float forwardmove = 0.0f; // cmd->forwardmove before the maxspeed clip, signed
	int reversing = 0;        // g_reversing: 0, 1 (the car is going backwards on the back key's say), 2 (and the accelerator is down)
	bool accelerating = false; // g_accelerating: the throttle key is down (not in the manual box's reverse)
	bool braking = false;     // g_braking
	bool isReverse = false;
};

// What the move would be at `speedH` and `rpm` when the throttle key is down (input.cpp:985-990, cl_forwardspeed): 10000 from a stand;
// below 50 u/s or with the revs under 200 the speed plus 30 * rpm * 78 / speed (a push that is large while the revs are high and the car
// is slow); else the speed alone. Past the engine's limit this is the speed, and the movement has nothing to add.
inline float ThrottleMove(float speedH, float rpm)
{
	if (speedH == 0.0f)
		return 10000.0f;
	if (rpm < 200.0f || speedH < 50.0f)
		return speedH + (rpm * 30.0f) / (speedH / 78.0f);
	return speedH;
}

inline DriveOut DriveStep(const DriveIn& in)
{
	DriveOut o;
	o.reversing = in.reversing;
	// :871-875: the back key is read here when the car is slow (the first read, so its fraction counts), the gear -1 of the manual box is
	// reverse whatever the speed
	const bool slow = in.speedH < 40.0f;
	bool isReverse = (slow && in.backFrac > 0.0f && !in.manual) || (in.manual && in.gear == -1);
	// :877: g_braking reads the back key again; when the slow test above already read it that is the second read
	o.braking = (slow ? in.backDown : in.backFrac) > 0.0f;
	// :890-902: the throttle key (its first read) overrides a reverse; in the manual box not in gear -1
	if (in.fwdFrac > 0.0f && (!in.manual || in.gear != -1))
	{
		isReverse = false;
		o.accelerating = true;
	}
	o.isReverse = isReverse;
	if (!in.onGround)
		return o; // :939: the air has no move at all (g_reversing keeps its value)

	float move = 0.0f;
	if (isReverse)
	{
		o.braking = false;
		o.reversing = 1;
		move -= 10000.0f * (in.manual ? in.fwdDown : in.backDown); // :948-950
		if (in.manual && in.fwdDown > 0.0f)
			o.reversing = 2;
		else if (in.backDown > 0.0f)
			o.reversing = 2;
	}
	else
		o.reversing = 0;
	// :965-1000: the automatic box always, the manual one in a forward gear; not with the forward key held as the look key
	if (!in.klook && ((in.gear > 0 && in.manual) || !in.manual))
	{
		const float m = ThrottleMove(in.speedH, in.rpm) * in.fwdDown;
		move += o.reversing != 0 ? m * 0.5f : m; // :994-999 (a reverse has the forward key up, so this is 0 there)
	}
	o.forwardmove = move;
	return o;
}

// The short the usercmd carries: HL Rally adds a float to a short (a wrap for 20 000 and over, which the speed term reaches under 1.4 u/s
// on a revving car); here the move is cut to the short's range instead of wrapped.
inline float CmdForwardMove(float move)
{
	return Clampf(move, -32767.0f, 32767.0f);
}

struct State
{
	bool init = false;
	float heading = 0;  // the car's heading, 0..360
	float delta = 0;    // the filtered turn, positive to the left, degrees per reference frame
	float wheel = 0;    // the steering wheel's angle as HL Rally keeps it: positive to the RIGHT, +-10
	float tractionLoss = 0;
	Gearbox box;
	int reversing = 0; // g_reversing (input.cpp:944-963), kept from frame to frame: the air does not touch it
};

struct Input
{
	float dt = 0;
	float keyYaw = 0;   // the degrees the side keys asked for this step (positive to the left)
	float mouseYaw = 0; // and the mouse (already zero in the air)
	float velX = 0, velY = 0, velZ = 0; // the car's velocity, predicted
	bool onGround = true;
	bool throttle = false; // g_accelerating: the forward key is down (not in the manual box's reverse)
	bool brake = false;    // g_braking (DriveStep: the back key, but not while the car starts in reverse)
	bool handbrake = false; // the jump key
	// the revs' inputs (the throttle, DriveStep): the accelerator as the gearbox reads it, the box's mode and the race's hold
	bool revving = false;   // g_accelerating, or the accelerator down while reversing (g_reversing == 2)
	bool manual = false;    // rally_manual
	bool countdown = false; // the race's hold: the automatic box is in neutral
	// the car's tilt as the last command left it (HL Rally's pmove->vuser1, read at input.cpp:1056), degrees, in AngleVectors' convention;
	// without it the car is taken as level
	bool haveTilt = false;
	float tiltPitch = 0, tiltRoll = 0;
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
	// HL Rally's two tests, one after the other and NOT clamped at 0 (input.cpp:1016-1021, cl_steer_center_speed 20, cl_steer_threshold 12):
	// a wheel under one step from centre is taken across 0 by the first and brought back by the second, so it stays where it is; a wheel
	// further out comes in by a step; and a small negative one is carried over to a small positive one.
	if (w > 0.0f && w < kWheelThreshold)
		w -= c;
	if (w < 0.0f && w > -kWheelThreshold)
		w += c;
	const float accelRight = -inputLeft;
	const float lowMul = fabsf(w) < 3.0f ? 1.5f : 1.0f;
	if (speedH > 400.0f && !(w < 5.0f))
		w += accelRight * lowMul / 15.0f;
	else
		w += accelRight * lowMul / 10.0f;
	s.wheel = Clampf(w, -kWheelMax, kWheelMax);
}

// The car's nose and right for angles (pitch, yaw, roll) in degrees: GoldSrc's AngleVectors (pitch positive looks down). HL Rally takes the slip
// against these (input.cpp:1056-1068: tangles = pmove->vuser1 with the yaw of the view, then AngleVectors).
inline void AxesOfAngles(float pitch, float yaw, float roll, float f[3], float r[3])
{
	const float k = 3.14159265358979f / 180.0f;
	const float sy = sinf(yaw * k), cy = cosf(yaw * k);
	const float sp = sinf(pitch * k), cp = cosf(pitch * k);
	const float sr = sinf(roll * k), cr = cosf(roll * k);
	f[0] = cp * cy;
	f[1] = cp * sy;
	f[2] = -sp;
	r[0] = -sr * sp * cy + cr * sy;
	r[1] = -sr * sp * sy - cr * cy;
	r[2] = -sr * cp;
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
		// HL Rally measures the slide against viewangles[YAW] as it stands when the block runs: the heading plus THIS frame's input
		// (input.cpp:1056-1074). The input of a reference frame is a_ref; at 99 frames a second that is this frame's, as there.
		const float mRef = kRefFps * dt;
		const float yawNow = s.heading + inputLeft / (mRef > 1e-6f ? mRef : 1.0f);
		// the nose and the right of the car's own, tilted axes, and the whole (three-dimensional) velocity: on a slope the slide share is
		// the smaller by the slope's cosine, as in HL Rally. Without a tilt the car is level.
		const float tp = in.haveTilt ? in.tiltPitch : 0.0f, tr = in.haveTilt ? in.tiltRoll : 0.0f;
		float fN[3], rN[3], fF[3], rF[3];
		AxesOfAngles(tp, yawNow, tr, fN, rN);
		AxesOfAngles(tp, yawNow + s.wheel * 2.5f, tr, fF, rF); // the front wheels: the heading turned by wheel * 2.5 (HL Rally adds it to the yaw as it stands)
		float cosSlip = 0.0f, slideRear = 0.0f, slideFront = 0.0f;
		if (speed3 > 1e-3f)
		{
			cosSlip = (in.velX * fN[0] + in.velY * fN[1] + in.velZ * fN[2]) / speed3;
			slideRear = (in.velX * rN[0] + in.velY * rN[1] + in.velZ * rN[2]) / speed3;
			slideFront = (in.velX * rF[0] + in.velY * rF[1] + in.velZ * rF[2]) / speed3;
		}
		float slide = fabsf(slideFront) < fabsf(slideRear) ? slideFront : slideRear; // the smaller of the two
		const bool rev = cosSlip < 0.0f;
		const float reversing = rev ? -1.0f : 1.0f;
		const float s1 = fabsf(cosSlip);
		const int skid = s1 < 0.96f ? 2 : 0;
		const float n = (float)(30 + skid);

		float a = inputLeft; // degrees to the left this step
		// input.cpp:1095 `if (g_braking && reversing != -1)`: `brake` here is g_braking (DriveStep's), which is 0 while the car starts in reverse
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
	// input.cpp:1228-1250: the NEW steer_delta alone (not the mean of the old and the new)
	(void)deltaBefore;
	const float turn = s.delta * kGain * dt * turnGate;
	s.heading = Wrap360(s.heading + turn);

	GearboxStep(s.box, speedH, in.onGround, in.revving, s.tractionLoss, dt, in.manual, in.countdown);
	out.heading = s.heading;
	return out;
}

// After the race's finish HL Rally's CL_CreateMove skips its whole drive block (input.cpp:818-835: no steering, no move, the view angles
// as they stand), but its renderer still turns the revs by the speed (renderCalculateRPMs). This is that and nothing else.
inline void FrozenStep(State& s, float velX, float velY, bool onGround, float dt, bool manual, bool countdown)
{
	if (!s.init)
		return;
	if (dt > 0.1f)
		dt = 0.1f;
	GearboxStep(s.box, sqrtf(velX * velX + velY * velY), onGround, false, s.tractionLoss, dt, manual, countdown);
}

} // namespace rallysteer
