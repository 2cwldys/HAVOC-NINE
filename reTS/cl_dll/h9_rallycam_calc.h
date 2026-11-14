// H9 rally mode, the client's cameras and the car's drawn pose: the arithmetic alone, with no engine call and no engine type, so
// tests/rallycam_test.cpp can run it. h9_rallycar.cpp asks the engine (traces, the clock, the studio renderer) and uses this.
//
// Conventions (the engine's): X forward, Y left, Z up; angles in degrees; a heading is a yaw, positive to the left. A car's
// ENTITY angles are (pitch, yaw, roll) with pitch positive nose UP and roll positive LEFT SIDE UP: the studio renderer negates
// the entity's pitch before it builds the matrix (StudioSetUpTransform), so this is what that matrix turns into. A VIEW's angles
// are the engine's own: pitch positive looks DOWN, roll positive puts the right side down. EntityMatrixColumns() below is the
// studio matrix written out, so the test can hold the tilt and the axes to each other.
//
// Every easing here is frame-rate independent: a step of dt seconds moves 1 - exp(-dt / tau) of the way, so two half steps equal
// one whole one, and a camera at 200 frames a second ends where one at 30 does.
#pragma once

#include <math.h>
#include <string.h>

namespace rallycam
{

const float kPi = 3.14159265358979f;
inline float Rad(float d) { return d * (kPi / 180.0f); }
inline float Deg(float r) { return r * (180.0f / kPi); }

struct V3
{
	float x, y, z;
	V3() : x(0), y(0), z(0) {}
	V3(float X, float Y, float Z) : x(X), y(Y), z(Z) {}
	V3 operator+(const V3& o) const { return V3(x + o.x, y + o.y, z + o.z); }
	V3 operator-(const V3& o) const { return V3(x - o.x, y - o.y, z - o.z); }
	V3 operator*(float s) const { return V3(x * s, y * s, z * s); }
	float Dot(const V3& o) const { return x * o.x + y * o.y + z * o.z; }
	V3 Cross(const V3& o) const { return V3(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x); }
	float Length() const { return sqrtf(x * x + y * y + z * z); }
	V3 Unit() const
	{
		const float l = Length();
		return l > 1e-6f ? V3(x / l, y / l, z / l) : V3(0, 0, 1);
	}
};

inline float Clamp(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

// An angle brought into -180..180, and the shortest signed turn from a to b.
inline float Wrap180(float a)
{
	a = fmodf(a, 360.0f);
	if (a > 180.0f)
		a -= 360.0f;
	else if (a < -180.0f)
		a += 360.0f;
	return a;
}
inline float AngleDelta(float a, float b) { return Wrap180(b - a); }

// The share of the way to the goal a step of dt covers with time constant tau (no tau: all of it).
inline float Alpha(float dt, float tau)
{
	if (!(tau > 1e-5f))
		return 1.0f;
	if (!(dt > 0.0f))
		return 0.0f;
	return 1.0f - expf(-dt / tau);
}

// ---- who is a car ------------------------------------------------------------------------------------------------------------

// What every client can see of a player that is a car: its box. The server sets a player's box to (-16 -16 0) (16 16 16) in
// rally mode (dlls/h9_rally_srv.cpp) and the engine sends mins and maxs for every player, so no field is added. A standing, ducked
// or prone human is 36 or more high on one side of the origin or the other, and a box that starts at the origin is under 25 high
// for nothing but a car.
inline bool IsCarBox(const V3& mins, const V3& maxs)
{
	return mins.z > -0.5f && mins.z < 0.5f && maxs.z > 4.0f && maxs.z <= 24.0f && maxs.x > 4.0f && maxs.x <= 32.0f && mins.x < -4.0f && mins.x >= -32.0f;
}

// ---- the car's tilt on the ground ----------------------------------------------------------------------------------------------

struct Axes
{
	V3 f, l, n; // nose, left, up (unit, at right angles)
};

// The ground's plane read at four points of the car: heights at the front left, front right, rear left and rear right, at +-halfLen
// along the heading and +-halfWid across it (yaw in degrees). Returns the plane's normal, pointing up.
inline V3 NormalFromHeights(float yaw, float hFL, float hFR, float hRL, float hRR, float halfLen, float halfWid)
{
	const float cy = cosf(Rad(yaw)), sy = sinf(Rad(yaw));
	const V3 fwd(cy, sy, 0), left(-sy, cy, 0);
	const V3 pFL = fwd * halfLen + left * halfWid + V3(0, 0, hFL);
	const V3 pFR = fwd * halfLen - left * halfWid + V3(0, 0, hFR);
	const V3 pRL = fwd * -halfLen + left * halfWid + V3(0, 0, hRL);
	const V3 pRR = fwd * -halfLen - left * halfWid + V3(0, 0, hRR);
	// the cross of the two diagonals
	V3 n = (pFR - pRL).Cross(pFL - pRR);
	if (n.z < 0)
		n = n * -1.0f;
	return n.Unit();
}

// The entity angles (pitch nose up, roll left side up) that stand a model with its roof along `n` under the given yaw: exactly, not
// to a first order. In the car's own yaw frame the studio's matrix has an up of (sp cr, -sr, cr cp) (sp the studio's pitch, the nose-up
// pitch negated), so the roll comes from the normal's leftward part and the pitch from its forward part.
inline void EulerFromNormal(const V3& n, float yaw, float& pitchUp, float& rollLeftUp)
{
	const float cy = cosf(Rad(yaw)), sy = sinf(Rad(yaw));
	const float a = n.x * cy + n.y * sy;  // along the nose
	const float b = -n.x * sy + n.y * cy; // to the left
	rollLeftUp = Deg(asinf(Clamp(-b, -1.0f, 1.0f)));
	pitchUp = -Deg(atan2f(a, n.z));
}

// The studio matrix's three columns (the model's X, Y and Z in the world) for an entity's angles: the engine's AngleMatrix with the
// pitch negated first, as the studio renderer does. For the test to hold the tilt to.
inline Axes EntityMatrixColumns(float pitchUp, float yaw, float rollLeftUp)
{
	const float p = Rad(-pitchUp), y = Rad(yaw), r = Rad(rollLeftUp);
	const float sp = sinf(p), cp = cosf(p), sy = sinf(y), cy = cosf(y), sr = sinf(r), cr = cosf(r);
	Axes a;
	a.f = V3(cp * cy, cp * sy, -sp);
	a.l = V3(sp * sr * cy + cr * -sy, sp * sr * sy + cr * cy, sr * cp);
	a.n = V3(sp * cr * cy + -sr * -sy, sp * cr * sy + -sr * cy, cr * cp);
	return a;
}

// A view's forward, right and up for the engine's view angles (pitch positive looks down, roll positive puts the right side down).
inline Axes ViewVectors(float pitch, float yaw, float roll)
{
	const float p = Rad(pitch), y = Rad(yaw), r = Rad(roll);
	const float sp = sinf(p), cp = cosf(p), sy = sinf(y), cy = cosf(y), sr = sinf(r), cr = cosf(r);
	Axes a; // f forward, l RIGHT here is not used: l holds the LEFT, so the test can compare with a car's
	a.f = V3(cp * cy, cp * sy, -sp);
	const V3 right((-1 * sr * sp * cy + -1 * cr * -sy), (-1 * sr * sp * sy + -1 * cr * cy), -1 * sr * cp);
	a.l = right * -1.0f;
	a.n = V3(cr * sp * cy + -sr * -sy, cr * sp * sy + -sr * cy, cr * cp);
	return a;
}

// A tilt kept from frame to frame. A frame that is too long or a first frame takes the target whole.
struct Tilt
{
	bool init;
	float pitch, roll; // entity angles, as above
	Tilt() : init(false), pitch(0), roll(0) {}
};

inline void TiltStep(Tilt& t, float targetPitch, float targetRoll, float dt, float tau)
{
	const float lim = 50.0f;
	targetPitch = Clamp(targetPitch, -lim, lim);
	targetRoll = Clamp(targetRoll, -lim, lim);
	if (!t.init || !(dt > 0.0f) || dt > 0.5f)
	{
		t.init = true;
		t.pitch = targetPitch;
		t.roll = targetRoll;
		return;
	}
	const float a = Alpha(dt, tau);
	t.pitch += (targetPitch - t.pitch) * a;
	t.roll += (targetRoll - t.roll) * a;
}

// What the nose does in the air: it follows the way the car is going up or down, a little.
inline float AirPitch(float vz, float speedXY)
{
	return Clamp(Deg(atan2f(vz, speedXY + 60.0f)), -30.0f, 30.0f);
}

// ---- the body's motion (HL Rally's StudioModelRenderer, the local car) ----------------------------------------------------------


// The share of the velocity that goes to the RIGHT of the nose (-1..1), from the full speed as HL Rally does.
inline float RightShare(float yaw, const V3& vel)
{
	const float sp = vel.Length();
	if (sp < 1e-3f)
		return 0.0f;
	return (vel.x * sinf(Rad(yaw)) - vel.y * cosf(Rad(yaw))) / sp;
}

// The roll a slide gives, degrees (positive: left side up, so the body leans OUT of a slide to the right): the share times 25 while it is
// under 0.2, then times 2.5 and 5 more. At most 7.5.
inline float SlideRoll(float rightShare)
{
	float m = rightShare;
	if (fabsf(m) < 0.2f)
		return m * 25.0f;
	m *= 2.5f;
	return m > 0.0f ? m + 5.0f : m - 5.0f;
}

// What a car adds to the tilt it stands on, for speed above 20 u/s: the slide's roll; a nose that dips by speed / 150 degrees while the back key
// or the handbrake is down, and one that rises by 3.7 - speed / 200 while the throttle is down below 300 u/s. Entity pitch is positive nose UP.
inline void BodyMotion(float speed, float rightShare, bool braking, bool throttle, float& pitchUp, float& rollLeftUp)
{
	if (!(speed > 20.0f))
		return;
	rollLeftUp += SlideRoll(rightShare);
	if (braking)
		pitchUp -= speed / 150.0f;
	if (speed < 300.0f && throttle)
		pitchUp += 3.7f - speed / 200.0f;
}

// ---- the wheels and the steering -------------------------------------------------------------------------------------------------

// The steering the front wheels show, in degrees, from the car's yaw rate (degrees a second): the keys turn a car 400 degrees a
// second at any speed (h9_rally.h), so the full lock is shown at that rate. Backwards the wheels turn the other way for the same
// turn of the nose, so the speed's sign is applied by the caller.
inline float SteerShown(float yawRate, float lockDeg, float fullRate)
{
	return Clamp(yawRate / fullRate, -1.0f, 1.0f) * lockDeg;
}

// The front wheels' angle from the DRIVER'S wheel (HL Rally's steer_wheel_angle, +-10, positive to the right: StudioModelRenderer turns it into
// 127 + 15 * wheel on a byte, which is at full lock from 8.5 up). Degrees of lock, positive to the LEFT as the controller is.
inline float WheelShown(float wheelRight, float lockDeg) { return -Clamp(wheelRight / 8.5f, -1.0f, 1.0f) * lockDeg; }

// The model's steering controllers are bytes over -45..45 degrees.
inline int SteerByte(float deg, float rangeDeg)
{
	const float v = 127.5f + Clamp(deg / rangeDeg, -1.0f, 1.0f) * 127.5f;
	return (int)(v + 0.5f) > 255 ? 255 : (int)(v + 0.5f);
}

// How far the tyres have turned, as a share of a turn, for a distance rolled along the nose. The sequence is one turn over its whole length.
inline float RollPhase(float phase, float distance, float circumference)
{
	if (!(circumference > 1e-3f))
		return phase;
	phase += distance / circumference;
	phase -= floorf(phase);
	return phase;
}

// ---- the cameras ---------------------------------------------------------------------------------------------------------------

struct Pose
{
	V3 org;
	float pitch, yaw, roll; // view angles (pitch positive looks down)
	Pose() : pitch(0), yaw(0), roll(0) {}
};

// ---- HL Rally's chase camera ----
//
// Its rule (in_camera.cpp CAM_Think and view.cpp, as read for its behaviour): the camera looks ALONG a direction, not at a point. That
// direction's yaw is the one the car is GOING (its velocity's) while it goes faster than 5 u/s, else the nose's; its pitch is 15 degrees down
// plus the slope the velocity is on. The camera sits `dist` behind the car's origin (26 above it) along that direction, so in a slide the car
// turns in front of the camera, and in reverse the camera swings round. Every easing there is a per-FRAME one at ~99 frames a second; each
// is written here as a power of the reference frame (kRefFps), which at 99 fps is that very rule and at any other rate the same motion:
//   yaw       moves 1/4 of the way to the velocity's yaw per frame                        (0.75^m kept)
//   pitch     goal = (new + 8 old) / 9 per frame, and moves 1/4 of the way to the goal   (0.8889^m, 0.75^m)
//   distance  the wanted one is `back` (40; a command cycles 40 70 100 35) cut by a trace to wall*0.. - 8, never under 20; the camera comes
//             in 1/6 of the way a frame (wall) and goes out 1/30 (open), and each frame adds min(speed / 120, 2) which the easing then takes
//             off again: the distance rests at wanted + 6 * that, 12 more at 240 u/s.
//   (HL Rally's 1 degree snap, which makes the angle sit within a degree of its goal, is left out: it would be a different motion at each rate.)

const float kRefFps = 99.0f;
inline float RefAlpha(float dt, float keep) { return dt > 0.0f ? 1.0f - powf(keep, kRefFps * dt) : 0.0f; } // the share covered by dt when each reference frame keeps `keep`
inline float RefTau(float keep) { return -1.0f / (kRefFps * logf(keep)); }                                     // the time constant of that

struct ChaseParams
{
	float back;      // the wanted distance behind the car (HL Rally's cam_wishdist)
	float up;        // the view's base above the car's origin
	float wishPitch; // degrees down on top of the velocity's slope
	float minDist;   // the trace never brings the camera nearer than this (their c_mindistance)
	float margin;    // short of a wall by this
	float stillSpeed;// under this the camera follows the nose, not the velocity
	float tauZ;      // the height's lag (not HL Rally's: our origin steps up a kerb in one frame)
	ChaseParams() : back(40), up(26), wishPitch(15), minDist(20), margin(8), stillSpeed(5), tauZ(0.10f) {}
};

struct ChaseState
{
	bool init;
	float yaw, pitch;  // the camera's angles (pitch positive looks down)
	float pitchGoal;   // the pitch's own smoothed goal
	float dist;        // the distance now
	float z;           // the car's height as the camera sees it
	ChaseState() : init(false), yaw(0), pitch(0), pitchGoal(0), dist(0), z(0) {}
};

struct ChaseAim
{
	float yaw, pitch; // the direction wanted this frame (the pitch smoothed), what the pull-in trace goes along
};

// First half of a step: the direction wanted. The state's goal pitch moves. (Call ChaseFinish after it, once per frame.)
inline ChaseAim ChaseAimOf(ChaseState& s, float heading, const V3& vel, float dt, const ChaseParams& p)
{
	const float speedH = sqrtf(vel.x * vel.x + vel.y * vel.y);
	float yaw = heading, rawPitch = p.wishPitch;
	if (speedH > p.stillSpeed)
	{
		yaw = Deg(atan2f(vel.y, vel.x));
		rawPitch = p.wishPitch - Deg(atan2f(vel.z, speedH)); // a velocity going up looks less far down
	}
	if (!s.init || !(dt > 0.0f) || dt > 0.5f)
	{
		s.init = false; // ChaseFinish takes it from here
		s.yaw = yaw;
		s.pitchGoal = rawPitch;
		s.pitch = rawPitch;
	}
	else
		s.pitchGoal += (rawPitch - s.pitchGoal) * RefAlpha(dt, 8.0f / 9.0f);
	ChaseAim a;
	a.yaw = yaw;
	a.pitch = s.pitchGoal;
	return a;
}

// Where the pull-in trace goes: from the origin a little up to behind the camera's direction, once at the camera's height and once 16 above
// it (the car's own roof and an arch stay out of it). `wanted` is the distance asked for. The caller takes the smaller fraction of the two.
inline void ChaseTrace(const V3& car, const ChaseAim& a, float wanted, V3& start, V3& endLow, V3& endHigh)
{
	const Axes v = ViewVectors(a.pitch, a.yaw, 0.0f);
	start = V3(car.x, car.y, car.z + 8.0f);
	endLow = car - v.f * wanted;
	endHigh = endLow + v.n * 16.0f;
}

// Second half. `fraction` the trace's (1 nothing hit; below 0 the trace began inside the world: the distance is left as it is).
inline Pose ChaseFinish(ChaseState& s, const V3& car, const V3& vel, const ChaseAim& a, float fraction, float dt, const ChaseParams& p)
{
	float wantDist = p.back;
	if (fraction < 1.0f && fraction >= 0.0f)
	{
		wantDist = p.back * fraction - p.margin;
		if (wantDist < p.minDist)
			wantDist = p.minDist;
	}
	else if (fraction < 0.0f)
		wantDist = s.dist > 0.0f ? s.dist : p.back;
	const float add = Clamp(sqrtf(vel.x * vel.x + vel.y * vel.y) / 120.0f, 0.0f, 2.0f);
	if (!s.init || !(dt > 0.0f) || dt > 0.5f)
	{
		s.init = true;
		s.yaw = a.yaw;
		s.pitch = a.pitch;
		s.z = car.z;
		s.dist = wantDist + 6.0f * add;
	}
	else
	{
		s.yaw = Wrap180(s.yaw + AngleDelta(s.yaw, a.yaw) * RefAlpha(dt, 0.75f));
		s.pitch += (s.pitchGoal - s.pitch) * RefAlpha(dt, 0.75f);
		s.z += (car.z - s.z) * Alpha(dt, p.tauZ);
		if (fraction >= 0.0f)
		{
			// the distance: pulled in 1/6 a frame, let out 1/30, and `add` put on every frame
			const float keep = wantDist < s.dist ? 5.0f / 6.0f : 29.0f / 30.0f;
			const float rest = wantDist + add / (1.0f - keep);
			s.dist = rest + (s.dist - rest) * powf(keep, kRefFps * dt);
		}
	}
	const Axes v = ViewVectors(s.pitch, s.yaw, 0.0f);
	Pose out;
	out.org = V3(car.x, car.y, s.z + p.up) - v.f * s.dist;
	out.pitch = s.pitch;
	out.yaw = s.yaw;
	out.roll = 0;
	return out;
}

struct FirstParams // HL Rally's bonnet view: origin + 6 along the car's nose + 15 along its up, the car's own angles (yaw not lagged)
{
	float ahead; // from the car's middle, along the nose
	float up;    // above its floor
	float tauYaw;
	float gain;  // of the car's tilt that the view takes
	FirstParams() : ahead(6), up(15), tauYaw(0.0f), gain(1.0f) {}
};

struct FirstState
{
	bool init;
	float yaw;
	FirstState() : init(false), yaw(0) {}
};

// The driver's view: from the seat, in the car's own axes (so a car pitched up lifts the eye with it), the view tilted as the car is.
inline Pose FirstStep(FirstState& s, const V3& car, float heading, const Tilt& tilt, float dt, const FirstParams& p)
{
	if (!s.init || !(dt > 0.0f) || dt > 0.5f)
	{
		s.init = true;
		s.yaw = heading;
	}
	else
		s.yaw = Wrap180(s.yaw + AngleDelta(s.yaw, heading) * Alpha(dt, p.tauYaw));
	const Axes a = EntityMatrixColumns(tilt.pitch, s.yaw, tilt.roll);
	Pose out;
	out.org = car + a.f * p.ahead + a.n * p.up;
	out.yaw = s.yaw;
	out.pitch = -tilt.pitch * p.gain;
	out.roll = tilt.roll * p.gain;
	return out;
}

} // namespace rallycam
