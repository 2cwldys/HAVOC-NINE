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

// ---- the wheels and the steering -------------------------------------------------------------------------------------------------

// The steering the front wheels show, in degrees, from the car's yaw rate (degrees a second): the keys turn a car 400 degrees a
// second at any speed (h9_rally.h), so the full lock is shown at that rate. Backwards the wheels turn the other way for the same
// turn of the nose, so the speed's sign is applied by the caller.
inline float SteerShown(float yawRate, float lockDeg, float fullRate)
{
	return Clamp(yawRate / fullRate, -1.0f, 1.0f) * lockDeg;
}

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

struct ChaseParams
{
	float back;    // behind the car
	float up;      // above its origin
	float ahead;   // the point looked at, in front of the car
	float lookUp;  // and above the ground there
	float tauBase; // the heading's lag on the road
	float tauSlide;// and what a full slide adds
	float slideAt; // the slip angle (degrees) that counts as a full slide
	float tauZ;    // the height's lag
	float minSpeed;// under this the car is not sliding, whatever its nose says
	ChaseParams() : back(70), up(26), ahead(18), lookUp(8), tauBase(0.04f), tauSlide(0.22f), slideAt(50), tauZ(0.10f), minSpeed(60) {}
};

struct ChaseState
{
	bool init;
	float yaw; // the camera's heading, lagging the car's
	float z;   // the car's height as the camera sees it
	ChaseState() : init(false), yaw(0), z(0) {}
};

// The angle between the nose and the way the car is going, in degrees (0 with no speed to speak of).
inline float SlipAngle(float headingYaw, const V3& vel, float minSpeed)
{
	const float sp = sqrtf(vel.x * vel.x + vel.y * vel.y);
	if (sp < minSpeed)
		return 0.0f;
	const float way = Deg(atan2f(vel.y, vel.x));
	float d = fabsf(AngleDelta(headingYaw, way));
	if (d > 90.0f) // backwards: the slip is measured from the tail
		d = 180.0f - d;
	return d;
}

// One step of the chase camera. `car` is the car's origin (on the ground), heading its yaw, vel its velocity. The camera looks at a
// point ahead of the car from behind and above it, its heading lagging the car's (more in a slide). The world is not asked here: the
// caller traces from `Anchor()` to the result and pulls it in with PullIn().
inline Pose ChaseStep(ChaseState& s, const V3& car, float heading, const V3& vel, float dt, const ChaseParams& p)
{
	if (!s.init || !(dt > 0.0f) || dt > 0.5f)
	{
		s.init = true;
		s.yaw = heading;
		s.z = car.z;
	}
	else
	{
		const float slide = Clamp(SlipAngle(heading, vel, p.minSpeed) / (p.slideAt > 1.0f ? p.slideAt : 1.0f), 0.0f, 1.0f);
		const float tau = p.tauBase + p.tauSlide * slide;
		s.yaw = Wrap180(s.yaw + AngleDelta(s.yaw, heading) * Alpha(dt, tau));
		s.z += (car.z - s.z) * Alpha(dt, p.tauZ);
	}
	const V3 behind(cosf(Rad(s.yaw)), sinf(Rad(s.yaw)), 0);
	const V3 nose(cosf(Rad(heading)), sinf(Rad(heading)), 0);
	Pose out;
	out.org = V3(car.x, car.y, s.z + p.up) - behind * p.back;
	const V3 look = V3(car.x, car.y, car.z + p.lookUp) + nose * p.ahead;
	const V3 d = look - out.org;
	const float h = sqrtf(d.x * d.x + d.y * d.y);
	out.yaw = Deg(atan2f(d.y, d.x));
	out.pitch = Deg(atan2f(-d.z, h)); // looking down is positive
	out.roll = 0;
	return out;
}

// Where the trace for the chase camera starts: above the car's middle, so a low roof or an arch does not put the camera in the car.
inline V3 ChaseAnchor(const V3& car, float lookUp) { return V3(car.x, car.y, car.z + lookUp + 4.0f); }

// The camera pulled in from a trace that hit at `fraction` of the way from the anchor to the camera: short of the wall by `margin`,
// and never closer to the anchor than `minDist` unless the wall is.
inline V3 PullIn(const V3& anchor, const V3& cam, float fraction, float margin, float minDist)
{
	if (fraction >= 1.0f)
		return cam;
	const V3 d = cam - anchor;
	const float len = d.Length();
	if (len < 1e-3f)
		return cam;
	float dist = len * (fraction < 0.0f ? 0.0f : fraction) - margin;
	const float floorDist = minDist < len * fraction ? minDist : len * fraction;
	if (dist < floorDist)
		dist = floorDist;
	if (dist < 0.0f)
		dist = 0.0f;
	return anchor + d * (dist / len);
}

struct FirstParams
{
	float ahead; // from the car's middle, along the nose
	float up;    // above its floor
	float tauYaw;
	float gain;  // of the car's tilt that the view takes
	FirstParams() : ahead(3), up(12), tauYaw(0.03f), gain(1.0f) {}
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
