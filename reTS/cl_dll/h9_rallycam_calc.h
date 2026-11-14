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

const float kRefFpsForSpin = 99.0f; // HL Rally's frame rate (see kRefFps below)

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

// The same from the four traced points themselves (HL Rally's five terrain probes, StudioModelRenderer.cpp:1295-1311: the sum of the two triangles'
// area vectors, which for any four points is half the cross of the diagonals), points at the front left, front right, rear left, rear right.
inline V3 NormalFromPoints(const V3& pFL, const V3& pFR, const V3& pRL, const V3& pRR)
{
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
	// HL Rally's decomposition (StudioModelRenderer.cpp:1367-1368, tAngles[PITCH] = atan2(r[2], r[0]) - 90 and tAngles[ROLL] = atan2(r[2], r[1]) - 90,
	// r the normal turned by the yaw: r[0] = a, r[1] = b), written for a normal that points up: each is the angle of the normal's share along
	// that axis, so a pure pitch or a pure roll is exact and a mixed one is 0.24 degrees off the matrix's own at 12 degrees. Signs are ours.
	rollLeftUp = -Deg(atan2f(b, n.z));
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

inline void TiltStep(Tilt& t, float targetPitch, float targetRoll, float dt, float tauPitch, float tauRoll)
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
	t.pitch += (targetPitch - t.pitch) * Alpha(dt, tauPitch);
	t.roll += (targetRoll - t.roll) * Alpha(dt, tauRoll);
}
inline void TiltStep(Tilt& t, float targetPitch, float targetRoll, float dt, float tau) { TiltStep(t, targetPitch, targetRoll, dt, tau, tau); }

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
// `tractionLoss` is HL Rally's g_tractionloss: the car's body (StudioModelRenderer.cpp:1432) does not squat while it is non-zero; the interior's
// (:1688-1690) has no such test, so its caller passes false.
inline void BodyMotion(float speed, float rightShare, bool braking, bool throttle, float& pitchUp, float& rollLeftUp, bool tractionLoss = false)
{
	if (!(speed > 20.0f))
		return;
	rollLeftUp += SlideRoll(rightShare);
	if (braking)
		pitchUp -= speed / 150.0f;
	if (speed < 300.0f && throttle && !tractionLoss)
		pitchUp += 3.7f - speed / 200.0f;
}

// ---- the wheels and the steering -------------------------------------------------------------------------------------------------

// The front wheels' steering byte, HL Rally's (StudioModelRenderer.cpp:2013 and :2016-2020: flYaw = steer_wheel_angle * -20 + 127 clamped to
// 0..255, then stored in a byte, which cuts the fraction). steer_wheel_angle is +-10, positive to the RIGHT, so full lock is from 6.35 up, and
// a straight wheel is 127. Another car's wheels are at 127 (:2060-2075).
inline int CarSteerByte(float wheelRight)
{
	float f = wheelRight * -20.0f + 127.0f;
	if (f > 255.0f)
		f = 255.0f;
	else if (f < 0.0f)
		f = 0.0f;
	return (int)f;
}

// The tyres' turn of the local car, as a multiple of the turn the distance driven gives (HL Rally's StudioProcessGait, StudioModelRenderer.cpp:2086-2110, which
// sets the wheel sequence's fps to the horizontal speed / 2.5): 1 and braketime 0 unless the back key is down and the forward key is not;
// then braketime counts a frame at a time (99 a second) and takes one fps off a frame, so the tyres come to a stop after speed / 2.5 frames
// (a factor 1 - 2.5 braketime / speed); reversing (the back key held under 40 u/s, the car starting backwards) turns them back; the handbrake
// stops them; a loss of traction spins them five times as fast. `braketime` is kept by the caller.
inline float WheelSpinFactor(float& braketime, float speedH, bool backKey, bool forwardKey, bool handbrake, float tractionLoss, float dt)
{
	const bool reversing = backKey && !forwardKey && speedH < 40.0f;
	const bool braking = backKey && !reversing; // g_braking is zeroed while the car starts in reverse
	float f = 1.0f;
	if (!braking || forwardKey)
		braketime = 0.0f;
	else
	{
		braketime += kRefFpsForSpin * dt;
		const float fps = speedH / 2.5f;
		f = (braketime < fps && fps > 1e-3f) ? (fps - braketime) / fps : 0.0f;
	}
	if (reversing)
		f = -f;
	if (handbrake)
		f = 0.0f;
	if (tractionLoss > 0.0f)
		f *= 5.0f;
	return f;
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
// plus the slope the velocity is on. The camera sits `dist` behind the car's origin (10 above it) along that direction, so in a slide the car
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
	float up;        // the view's pivot above the car's origin: HL Rally's 26 (view.cpp:547) less the 16 V_CalcViewRoll takes (:416) = 10
	float wishPitch; // degrees down on top of the velocity's slope
	float minDist;   // the trace never brings the camera nearer than this (their c_mindistance)
	float margin;    // short of a wall by this
	float stillSpeed;// under this the camera follows the nose, not the velocity
	ChaseParams() : back(40), up(10), wishPitch(15), minDist(20), margin(8), stillSpeed(5) {}
};

struct ChaseState
{
	bool init;
	float yaw, pitch;  // the camera's angles (pitch positive looks down)
	float pitchGoal;   // the pitch's own smoothed goal
	float dist;        // the distance now
	ChaseState() : init(false), yaw(0), pitch(0), pitchGoal(0), dist(0) {}
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
		s.dist = wantDist + 6.0f * add;
	}
	else
	{
		s.yaw = Wrap180(s.yaw + AngleDelta(s.yaw, a.yaw) * RefAlpha(dt, 0.75f));
		s.pitch += (s.pitchGoal - s.pitch) * RefAlpha(dt, 0.75f);
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
	// the height is the car's own, not eased: HL Rally eases none in third person (view.cpp:813 `if (!CL_IsThirdPerson())` guards its stair smoothing)
	out.org = V3(car.x, car.y, car.z + p.up) - v.f * s.dist;
	out.pitch = s.pitch;
	out.yaw = s.yaw;
	out.roll = 0;
	return out;
}

// A camera that sits on the car, in its own axes, and takes the car's tilt as the view's angles: HL Rally's bonnet (cam_viewmode 2,
// view.cpp:729-737: simorg + forward * 6 + up * 15) and its side camera (cam_viewmode 3, view.cpp:739-746: forward * -25 + right * 13.75 +
// up * 10), both with vLocalAngles, the car's own angles with its heading not lagged, and the car drawn.
struct FirstParams
{
	float ahead; // from the car's origin, along the nose
	float side;  // to the car's RIGHT
	float up;    // along the car's roof
	float tauYaw;
	float gain;  // of the car's tilt that the view takes
	FirstParams() : ahead(6), side(0), up(15), tauYaw(0.0f), gain(1.0f) {}
	static FirstParams Bonnet() { return FirstParams(); }
	static FirstParams Side()
	{
		FirstParams p;
		p.ahead = -25.0f;
		p.side = 13.75f;
		p.up = 10.0f;
		return p;
	}
};

struct FirstState
{
	bool init;
	float yaw;
	FirstState() : init(false), yaw(0) {}
};

// The view from the car: the origin in the car's own axes (so a car pitched up lifts the eye with it), the view tilted as the car is.
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
	out.org = car + a.f * p.ahead + a.l * -p.side + a.n * p.up; // (a.l is the LEFT)
	out.yaw = s.yaw;
	out.pitch = -tilt.pitch * p.gain;
	out.roll = tilt.roll * p.gain;
	return out;
}

// ---- the views, and the key that goes round them ----
//
// HL Rally's `c` key (rally.cfg: alias changeview, with chasecam, bonnetcam, sidecam, tvcam and interior) goes: chase, bonnet, side camera, TV
// camera, interior, chase... Ours has no TV camera (it needs info_camera entities in the map: HL Rally's CAM_TV_Mode), so it goes chase, bonnet,
// side, interior, chase; and without the interior's model, chase, bonnet, side, chase.
enum RallyView
{
	VIEW_CHASE = 0,
	VIEW_TV = 1, // HL Rally's cam_viewmode numbers; the TV camera is not made
	VIEW_BONNET = 2,
	VIEW_SIDE = 3,
	VIEW_INTERIOR = 4
};

inline int NextView(int now, bool haveInterior)
{
	switch (now)
	{
	case VIEW_CHASE: return VIEW_BONNET;
	case VIEW_BONNET: return VIEW_SIDE;
	case VIEW_SIDE: return haveInterior ? VIEW_INTERIOR : VIEW_CHASE;
	default: return VIEW_CHASE; // the interior, the TV camera, anything else
	}
}

// The view in force: the interior without its model is the chase camera; the TV camera is the chase camera.
inline int ViewInForce(int wanted, bool haveInterior)
{
	if (wanted == VIEW_INTERIOR)
		return haveInterior ? VIEW_INTERIOR : VIEW_CHASE;
	if (wanted == VIEW_BONNET || wanted == VIEW_SIDE)
		return wanted;
	return VIEW_CHASE;
}

// The car is seen from outside (the engine then draws the local player): every view but the interior.
inline bool ViewShowsCar(int inForce) { return inForce != VIEW_INTERIOR; }

// HL Rally's chase_zoom.cfg: `changedistance` is an alias that walks middle (70), far (100), close (35), middle..., whatever the distance is now
// (the first is the autoexec's 40, which is never returned to). `step` counts presses.
inline float ChaseZoomDistance(int& step)
{
	static const float d[3] = {70.0f, 100.0f, 35.0f};
	const float v = d[step % 3];
	step = (step + 1) % 3;
	return v;
}

// ---- the interior (HL Rally's models/interior.mdl, a view model) ----
//
// The eye is the player's view height less what V_CalcViewRoll takes: VEC_VIEW 28, viewheight 28 - 16 (view.cpp:416, :544-545) = 12 over the
// car's origin; the model's origin is simorg + viewheight, whose z is 28 - 17 (view.cpp:417, :761-763), less 1 (:782) and plus 1 at viewsize 110
// (:786-789, config.cfg viewsize 110) = 11.
const float kInteriorEyeUp = 12.0f;
const float kInteriorModelUp = 11.0f;
// the model is drawn 9 degrees off the view's pitch (StudioModelRenderer.cpp:1734-1736)
const float kInteriorModelPitchOffset = 9.0f;

// the terrain probes (StudioModelRenderer.cpp:1258-1259: right * 8, forward * 12; :1091 testdepth 2, :1106-1110 from +2 to -2 along the car's roof)
const float kProbeForward = 12.0f;
const float kProbeRight = 8.0f;
const float kProbeReach = 2.0f;

// A string has this word in it (the texture's name, which HL Rally lower-cases first, :1349-1354).
inline bool HasWord(const char* tex, const char* word)
{
	if (tex == nullptr || word == nullptr || !*word)
		return false;
	const int n = (int)strlen(word);
	for (const char* p = tex; *p; p++)
	{
		int i = 0;
		while (i < n && p[i] && (p[i] | 0x20) == word[i])
			i++;
		if (i == n)
			return true;
	}
	return false;
}

// The roughness of the surface under the car: HL Rally's rough_mul. 0.006 on anything but a road; on a "road" texture that is not also dirt, grass or
// snow ("roadgras" is grass) 0.002 for the car's body (:1356-1361) and 0.003 for the interior (:1620-1625).
inline float RoughMul(const char* tex, bool interior)
{
	if (HasWord(tex, "dirt") || HasWord(tex, "gras") || HasWord(tex, "snow"))
		return 0.006f;
	if (HasWord(tex, "road"))
		return interior ? 0.003f : 0.002f;
	return 0.006f;
}

// The noise's amplitude, degrees: the speed (3D) up to 300 times rough_mul (:1370-1378). `unit` is a draw in -1..1.
inline float RoughAngle(float spd, float mul, float unit)
{
	return Clamp(spd, 0.0f, 300.0f) * mul * unit;
}

// The steering wheel's wobble, in controller bytes: none under 10 u/s, then +-2 rough_mul speed up to 500 (:1631-1637).
inline float WheelRough(float spd, float mul, float unit)
{
	if (spd < 10.0f)
		return 0.0f;
	return 2.0f * mul * (spd < 500.0f ? spd : 500.0f) * unit;
}

// HL Rally draws its noise once a frame, at 99 frames a second; the same white noise at that rate is held for the time between: a draw is due when a
// reference frame (1/99 s) has gone by.
struct NoiseHold
{
	float acc;
	float a, b, c; // three unit values in -1..1
	NoiseHold() : acc(1.0f), a(0), b(0), c(0) {}
};
inline bool NoiseDue(NoiseHold& n, float dt)
{
	n.acc += dt;
	if (n.acc < 1.0f / kRefFps)
		return false;
	n.acc -= 1.0f / kRefFps;
	if (n.acc > 1.0f / kRefFps)
		n.acc = 0.0f;
	return true;
}

// A float stored in a byte, as the engine sees what HL Rally's code (a 2003 compiler) left in a controller: the fraction is cut and the low 8 bits
// kept, so a negative value wraps (-5 is 251).
inline int ControllerByte(float f) { return ((int)f) & 255; }

// The speedometer's controller: -speed / 3.1 + 12, held between -250 and -5 (StudioModelRenderer.cpp:1533-1537; speed is the full velocity).
inline int SpeedoController(float speed3d)
{
	float f = -speed3d / 3.1f + 12.0f;
	if (f < -250.0f)
		f = -250.0f;
	if (f > -5.0f)
		f = -5.0f;
	return ControllerByte(f);
}

// The tachometer's controller: -rpm * 1.2, held at -255 and over (:1541-1544).
inline int TachoController(float rpm)
{
	float f = -rpm * 1.2f;
	if (f < -255.0f)
		f = -255.0f;
	return ControllerByte(f);
}

// The wheel's value before the byte: steer_wheel_angle * 15 + 127 and the wobble, held 0..255 (:1632-1637, 1708, 1717-1721).
inline float WheelController(float wheelRight, float wobble)
{
	const float f = wheelRight * 15.0f + 127.0f + wobble;
	return f > 255.0f ? 255.0f : (f < 0.0f ? 0.0f : f);
}

// What the interior keeps from frame to frame (HL Rally's statics pitch_hist, roll_hist, LastflYaw).
struct InteriorState
{
	bool init;
	float pitchHist, rollHist; // the filtered tilt, entity convention (pitch nose up, roll left side up)
	float wheelLast;           // the last wheel value (0..255)
	NoiseHold noise;
	InteriorState() : init(false), pitchHist(0), rollHist(0), wheelLast(127.0f) {}
};

struct InteriorOut
{
	float camPitch, camRoll;     // the view's angles (pitch positive looks down)
	float modelPitch, modelRoll; // the view model's entity angles (pitch nose up, as V_CalcGunAngle's -viewpitch)
	int wheel, speedo, tacho;    // the three controllers' bytes
};

// One frame. `tPitch`, `tRoll`: the ground's tilt with the noise and the body's motion added (pitchUp, rollLeftUp). On the ground the view is
// (new + 9 old) / 10 of it (:1696-1697, a reference frame; `onGround` is pmove->onground != -1); in the air the pitch sinks 4.4 degrees a second and
// the roll is kept (:1710). The model's pitch is the view's -9 (:1734-1736).
inline InteriorOut InteriorStep(InteriorState& s, bool onGround, float tPitch, float tRoll, float wheelRight, float wheelWobble, float speed3d, float rpm, float dt)
{
	if (!s.init)
	{
		s.init = true;
		s.pitchHist = tPitch;
		s.rollHist = tRoll;
		s.wheelLast = WheelController(wheelRight, 0.0f);
	}
	if (onGround)
	{
		const float a = RefAlpha(dt, 0.9f);
		s.pitchHist += (tPitch - s.pitchHist) * a;
		s.rollHist += (tRoll - s.rollHist) * a;
	}
	else
		s.pitchHist += -4.4f * dt;
	float wheel = WheelController(wheelRight, onGround ? wheelWobble : 0.0f);
	wheel = s.wheelLast + (wheel - s.wheelLast) * RefAlpha(dt, 0.5f); // (new + old) / 2 a reference frame (:1723)
	s.wheelLast = wheel;
	InteriorOut o;
	o.camPitch = -s.pitchHist;
	o.camRoll = s.rollHist;
	o.modelPitch = s.pitchHist - kInteriorModelPitchOffset;
	o.modelRoll = s.rollHist;
	o.wheel = (int)wheel & 255;
	o.speedo = SpeedoController(speed3d);
	o.tacho = TachoController(rpm);
	return o;
}

// What the body does in the air (StudioModelRenderer.cpp:1475-1482 and :1505-1508 for the local car; :1501-1508 for another, from the angles the
// server last sent): the nose sinks 12.4 degrees a second (20.4 for another car), the roll grows away from 0 by 12.4 a second. Entity convention
// (pitch nose up, roll left side up): HL Rally's pitch has the other sign.
inline void AirDrift(float& pitchUp, float& rollLeftUp, bool local, float dt)
{
	pitchUp -= (local ? 12.4f : 20.4f) * dt;
	if (rollLeftUp > 0.0f)
		rollLeftUp += 12.4f * dt;
	else
		rollLeftUp -= 12.4f * dt;
}

// ---- the mirror (HL Rally's second view pass, view.cpp:1257-1330) ----
struct MirrorView
{
	int x, y, w, h;
	float pitch, roll;
};

// The rectangle: a third of the screen wide, from the top edge, ScreenHeight / 6.5 high, and the view turned to look backwards: pitch and roll + 180,
// each taken back under 360 when over it (the yaw is the car's).
inline MirrorView MirrorOf(int screenW, int screenH, float pitch, float roll)
{
	MirrorView m;
	m.x = screenW / 3;
	m.y = 0;
	m.w = screenW / 3;
	m.h = (int)(screenH / 6.5f);
	m.pitch = pitch + 180.0f;
	if (m.pitch > 360.0f)
		m.pitch -= 360.0f;
	m.roll = roll + 180.0f;
	if (m.roll > 360.0f)
		m.roll -= 360.0f;
	return m;
}

} // namespace rallycam
