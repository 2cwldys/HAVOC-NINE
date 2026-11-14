// The race's visual effects, the arithmetic alone: no engine call, no engine type, so the test (tests/racefx_test.cpp) can run it.
// The tyre marks (which surface and state gives which mark, where a segment goes given the wheel and the ground, the ring they
// are kept in, how they fade), the spray (which surface gives which puffs, how many), the shadow, the brake lights and the
// weather's budget. h9_racefx.cpp is the part that asks the engine and draws. Units are the game's; every size is a part of the
// car's length, width or height, taken from the model's own bounds, so a car of any scale gets the same look.
#pragma once

#include <math.h>
#include <string.h>

namespace racefx
{

// ---- a vector, with no engine's -------------------------------------------------------------------------------------------------

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
};

inline float Clamp01(float v)
{
	return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// ---- what the server sends (h9_car.cpp: pev->blending[0], [1]) -----------------------------------------------------------------

enum Surface // the low 3 bits of blending[1] (H9SURF_ on the server)
{
	SURF_TARMAC = 0,
	SURF_GRAVEL = 1,
	SURF_DIRT = 2,
	SURF_GRASS = 3,
	SURF_WATER = 4,
	SURF_SNOW = 5,
	SURF_ICE = 6
};
enum StateBits // the rest of blending[1]
{
	BIT_AIR = 8,
	BIT_BRAKE = 16,
	BIT_HAND = 32
};

inline int SurfaceOf(int b1) { return b1 & 7; }
inline float SlipOf(int b0) { return (float)(b0 & 255) / 255.0f; }

// A cvar's value as a switch; the cvars give 0 or 1 (a float on the wire, so anything under a half is off).
inline bool On(float v) { return v >= 0.5f; }

// ---- the car's size, from its model's bounds -----------------------------------------------------------------------------------

// The model's origin is on the ground between the axles and its nose is along +X (the entity's yaw).
struct Dims
{
	float len, width, height; // of the bounds
	V3 mins, maxs;
	float rearX, frontX;      // the axles, in the car's own X
	float halfTrack;          // the tyres' centre line, in the car's own Y
	float tyreW;              // a tyre's width
	bool ok;
};

inline Dims DimsFromBounds(const V3& mins, const V3& maxs)
{
	Dims d;
	memset(&d, 0, sizeof(d));
	d.mins = mins;
	d.maxs = maxs;
	d.len = maxs.x - mins.x;
	d.width = maxs.y - mins.y;
	d.height = maxs.z - mins.z;
	// a car is longer than wide; a bound that is not there (or a model with no bounds loaded yet) gives no car at all
	d.ok = d.len >= 8.0f && d.width >= 4.0f && d.height >= 2.0f && d.len < 4096.0f && d.width < 4096.0f && d.height < 4096.0f;
	d.rearX = mins.x + 0.22f * d.len;   // the axles stand in from the ends
	d.frontX = maxs.x - 0.20f * d.len;
	d.tyreW = 0.12f * d.width;
	d.halfTrack = 0.5f * d.width - 0.5f * d.tyreW; // the tyre's outer side at the body's side
	return d;
}

enum Wheel4 // the same order as the model's bones: fl, fr, rl, rr
{
	W_FL = 0,
	W_FR = 1,
	W_RL = 2,
	W_RR = 3
};

// A wheel's place in the car's own axes (X nose, Y left), on the ground under it: Z is the model's origin's.
inline V3 WheelLocal(const Dims& d, int w)
{
	const float x = (w == W_FL || w == W_FR) ? d.frontX : d.rearX;
	const float y = (w == W_FL || w == W_RL) ? d.halfTrack : -d.halfTrack;
	return V3(x, y, 0);
}

// The car's own axes to the world's, by the yaw alone (the mark and the spray lie on the ground, which the traces find).
inline V3 LocalToWorld(const V3& origin, float yawDeg, const V3& local)
{
	const float a = yawDeg * 3.14159265358979f / 180.0f, c = cosf(a), s = sinf(a);
	return V3(origin.x + local.x * c - local.y * s, origin.y + local.x * s + local.y * c, origin.z + local.z);
}

// The speed along the ground (the map's plane) between two frames; 0 when time has not moved.
inline float SpeedFrom(const V3& prev, const V3& cur, float dt)
{
	if (!(dt > 0.0001f))
		return 0;
	const float dx = cur.x - prev.x, dy = cur.y - prev.y;
	return sqrtf(dx * dx + dy * dy) / dt;
}

// ---- the tyre marks -------------------------------------------------------------------------------------------------------------

enum MarkKind
{
	MK_NONE = 0,
	MK_RUBBER,  // tarmac: black rubber
	MK_RUT,     // gravel, dirt, grass: a faint dark rut
	MK_SNOW,    // snow: pressed track
	MK_SCRATCH  // ice: a thin pale scratch (drawn additive)
};

struct MarkLook
{
	MarkKind kind;
	float alpha;       // 0..1 at birth
	float widthScale;  // of the tyre's width
	bool allWheels;    // the four tyres (snow), else the two rear ones
	unsigned char r, g, b; // the tint (a black sprite stays black under it: see h9_racefx.cpp)
	bool pale;         // drawn additive, for what is lighter than the ground
};

inline float SlideStart() { return 0.25f; } // "sliding": over this part of the slip

// What the car leaves on the ground this frame. speedLen is the speed in car lengths a second, accelLen its change a second.
inline MarkLook MarkFor(int surf, float slip, int flags, float speedLen, float accelLen)
{
	MarkLook m;
	memset(&m, 0, sizeof(m));
	m.kind = MK_NONE;
	m.widthScale = 1;
	m.r = m.g = m.b = 20;
	if ((flags & BIT_AIR) != 0 || surf == SURF_WATER || speedLen < 0.06f)
		return m;
	const bool sliding = slip > SlideStart();
	const float slide = Clamp01((slip - SlideStart()) / 0.5f);
	switch (surf)
	{
	case SURF_TARMAC:
	{
		const bool brake = (flags & BIT_BRAKE) != 0 && speedLen > 0.4f;
		const bool hand = (flags & BIT_HAND) != 0 && speedLen > 0.3f;
		if (!sliding && !brake && !hand)
			return m;
		m.kind = MK_RUBBER;
		float a = 0.30f + 0.55f * slide;
		if (brake || hand)
			a += 0.25f;
		m.alpha = a > 0.85f ? 0.85f : a;
		return m;
	}
	case SURF_GRAVEL:
	case SURF_DIRT:
	case SURF_GRASS:
		// faint ruts while sliding, or while pulling away from low speed (the wheels spinning)
		if (!sliding && !(speedLen < 1.0f && accelLen > 0.3f))
			return m;
		m.kind = MK_RUT;
		m.alpha = 0.22f + 0.30f * slide;
		m.r = 70;
		m.g = 55;
		m.b = 40;
		return m;
	case SURF_SNOW:
		m.kind = MK_SNOW;
		m.alpha = 0.50f + 0.30f * slide;
		m.allWheels = true;
		m.r = 70;
		m.g = 80;
		m.b = 100;
		return m;
	case SURF_ICE:
		if (!sliding)
			return m;
		m.kind = MK_SCRATCH;
		m.alpha = 0.35f + 0.35f * slide;
		m.widthScale = 0.35f;
		m.pale = true;
		m.r = m.g = m.b = 230;
		return m;
	}
	return m;
}

// The ring the marks live in: a segment is a quad of four corners on the ground, a normal to lift it by, a birth and a life.
struct Seg
{
	V3 c[4]; // start left, end left, end right, start right
	V3 n;    // the ground's normal here
	float born, life, alpha;
	unsigned char r, g, b;
	bool pale;
};

template <class T, int N>
struct Ring
{
	T items[N];
	int head; // where the next goes
	int count;
	Ring() : head(0), count(0) {}
	void Clear()
	{
		head = 0;
		count = 0;
	}
	T& Push() // the oldest is overwritten once the ring is full
	{
		T& r = items[head];
		head = (head + 1) % N;
		if (count < N)
			count++;
		return r;
	}
	// i = 0 is the oldest
	T& At(int i) { return items[(head - count + i + 2 * N) % N]; }
	const T& At(int i) const { return items[(head - count + i + 2 * N) % N]; }
};

// How much of a mark is left: whole for most of its life, then down to nothing at its end.
inline float FadeFactor(float age, float life, float fadeSpan)
{
	if (!(age >= 0) || !(life > 0) || age >= life)
		return 0;
	const float left = life - age;
	return left >= fadeSpan ? 1.0f : left / fadeSpan;
}

// The ground under a point, whatever finds it (the engine's trace in the game, a plane in the test).
struct Ground
{
	virtual bool Down(const V3& from, V3& hit, V3& normal) = 0;
	virtual ~Ground() {}
};

// One wheel's mark in the making: the last point laid and the corners the next segment starts from.
struct WheelTrail
{
	bool have;
	V3 pos, n;
	bool haveCorners;
	V3 cornerL, cornerR;
	WheelTrail() : have(false), haveCorners(false) {}
	void Break() // the mark stops here (in the air, off the surface, a teleport): the next one starts afresh
	{
		have = false;
		haveCorners = false;
	}
};

// Lays the next segment of a wheel's mark when the wheel has travelled `spacing` since the last point. No ground query unless
// it has: the cost is one trace a segment, not one a frame. Returns true when `out` was filled. `lift` is the distance
// above the ground along its normal; halfWidth is half the quad's width.
inline bool PlaceSegment(WheelTrail& t, const V3& wheelWorld, Ground& g, float spacing, float halfWidth, float lift, float now,
	float life, const MarkLook& look, Seg& out)
{
	if (t.have)
	{
		const V3 d = wheelWorld - t.pos;
		const float dist2 = d.x * d.x + d.y * d.y; // along the plane: the ground's height is not travel
		if (dist2 < spacing * spacing)
			return false;
		if (dist2 > 64.0f * spacing * spacing) // a jump (a teleport, a lost frame): a new mark, not a streak across the map
			t.Break();
	}
	V3 hit, nrm;
	if (!g.Down(wheelWorld, hit, nrm))
	{
		t.Break();
		return false;
	}
	const V3 p = hit + nrm * lift;
	if (!t.have)
	{
		t.have = true;
		t.pos = p;
		t.n = nrm;
		t.haveCorners = false;
		return false;
	}
	V3 dir = p - t.pos;
	const float dl = dir.Length();
	if (!(dl > 1e-3f))
		return false;
	dir = dir * (1.0f / dl);
	V3 side = dir.Cross(nrm);
	const float sl = side.Length();
	if (!(sl > 1e-3f))
	{
		t.Break();
		return false;
	}
	side = side * (halfWidth / sl);
	const V3 endL = p + side, endR = p - side;
	V3 startL, startR;
	if (t.haveCorners)
	{
		startL = t.cornerL;
		startR = t.cornerR;
	}
	else
	{
		startL = t.pos + side;
		startR = t.pos - side;
	}
	out.c[0] = startL;
	out.c[1] = endL;
	out.c[2] = endR;
	out.c[3] = startR;
	out.n = nrm;
	out.born = now;
	out.life = life;
	out.alpha = look.alpha;
	out.r = look.r;
	out.g = look.g;
	out.b = look.b;
	out.pale = look.pale;
	t.pos = p;
	t.n = nrm;
	t.cornerL = endL;
	t.cornerR = endR;
	t.haveCorners = true;
	return true;
}

// ---- the spray ------------------------------------------------------------------------------------------------------------------

enum SprayKind
{
	SP_NONE = 0,
	SP_DUST,  // gravel, dirt, grass
	SP_SNOW,  // snow powder
	SP_WATER, // a splash
	SP_SMOKE  // tyre smoke on tarmac
};

struct SprayLook
{
	SprayKind kind;
	float rate;                // puffs a second from one driven wheel
	unsigned char r, g, b;
	float alpha;               // 0..1 at birth
	float life;                // seconds
	float size0, size1;        // a puff's half size at birth and at its end, in car lengths
	float up;                  // its upward speed, in car lengths a second
	float back;                // its speed backwards, as a part of the car's speed
};

inline SprayLook SprayFor(int surf, float slip, int flags, float speedLen)
{
	SprayLook s;
	memset(&s, 0, sizeof(s));
	s.kind = SP_NONE;
	if ((flags & BIT_AIR) != 0 || speedLen < 0.10f)
		return s;
	const float fast = Clamp01(speedLen / 2.0f); // two lengths a second is full
	switch (surf)
	{
	case SURF_GRAVEL:
	case SURF_DIRT:
	{
		const float p = fast * (0.35f + 0.65f * slip);
		s.kind = SP_DUST;
		s.rate = 45.0f * p;
		s.r = 200;
		s.g = 170;
		s.b = 120;
		s.alpha = 0.55f;
		s.life = 1.1f;
		s.size0 = 0.04f;
		s.size1 = 0.16f;
		s.up = 0.12f;
		s.back = 0.15f;
		break;
	}
	case SURF_GRASS:
	{
		if (slip <= SlideStart())
			break;
		s.kind = SP_DUST;
		s.rate = 25.0f * fast * slip;
		s.r = 120;
		s.g = 140;
		s.b = 90;
		s.alpha = 0.45f;
		s.life = 0.9f;
		s.size0 = 0.035f;
		s.size1 = 0.12f;
		s.up = 0.10f;
		s.back = 0.12f;
		break;
	}
	case SURF_SNOW:
	{
		s.kind = SP_SNOW;
		s.rate = 60.0f * fast * (0.35f + 0.65f * slip);
		s.r = 235;
		s.g = 242;
		s.b = 255;
		s.alpha = 0.60f;
		s.life = 1.3f;
		s.size0 = 0.04f;
		s.size1 = 0.18f;
		s.up = 0.14f;
		s.back = 0.18f;
		break;
	}
	case SURF_WATER:
	{
		s.kind = SP_WATER;
		s.rate = 55.0f * fast;
		s.r = 190;
		s.g = 210;
		s.b = 230;
		s.alpha = 0.50f;
		s.life = 0.8f;
		s.size0 = 0.03f;
		s.size1 = 0.10f;
		s.up = 0.45f; // more vertical
		s.back = 0.06f;
		break;
	}
	case SURF_TARMAC:
	{
		if (slip <= 0.5f) // tyre smoke only when the tyres really slide
			break;
		s.kind = SP_SMOKE;
		s.rate = 50.0f * Clamp01((slip - 0.45f) / 0.55f) * Clamp01(speedLen);
		s.r = 205;
		s.g = 205;
		s.b = 205;
		s.alpha = 0.50f;
		s.life = 1.4f;
		s.size0 = 0.05f;
		s.size1 = 0.20f;
		s.up = 0.10f;
		s.back = 0.10f;
		break;
	}
	}
	if (s.rate < 1.0f)
		s.kind = SP_NONE;
	return s;
}

// A rate over a step, with the part that is not whole kept for the next frame; never more than `cap` at once.
inline int EmitCount(float& accum, float rate, float dt, int cap)
{
	if (!(dt > 0) || !(rate > 0))
		return 0;
	accum += rate * dt;
	int n = (int)accum;
	accum -= (float)n;
	if (n > cap)
		n = cap;
	return n;
}

// How many puffs one car may have alive when `cars` cars are in view out of a total of `total`.
inline int PerCarBudget(int total, int cars)
{
	const int share = total / (cars < 1 ? 1 : cars);
	return share < 24 ? 24 : share;
}

// Where, along the plane the ground's trace gave, a point is: its height there. A flat ground (normal up) gives hit.z.
inline float PlaneZ(const V3& hit, const V3& n, float x, float y)
{
	if (n.z < 0.2f)
		return hit.z;
	return hit.z - ((x - hit.x) * n.x + (y - hit.y) * n.y) / n.z;
}

// ---- the shadow -----------------------------------------------------------------------------------------------------------------

// The blob's opacity: full on the ground, gone when the car is a length up.
inline float ShadowAlpha(float heightAbove, float len)
{
	if (!(len > 0))
		return 0;
	const float h = heightAbove < 0 ? 0 : heightAbove;
	return 0.75f * Clamp01(1.0f - h / len);
}

// The blob's half sizes: along the car and across it, a little over the body.
inline float ShadowHalfLen(const Dims& d) { return 0.58f * d.len; }
inline float ShadowHalfWidth(const Dims& d) { return 0.62f * d.width; }

// ---- the brake lights -----------------------------------------------------------------------------------------------------------

inline bool BrakeLightsOn(int flags) { return (flags & (BIT_BRAKE | BIT_HAND)) != 0; }

// The two glows' places in the car's own axes: the rear face, 35% of the width either side, 45% of the height.
inline V3 BrakeLightLocal(const Dims& d, int side) // side 0 left (+Y), 1 right
{
	const float y = (side == 0 ? 1.0f : -1.0f) * 0.35f * d.width;
	return V3(d.mins.x + 0.01f * d.len, y, d.mins.z + 0.45f * d.height);
}

} // namespace racefx
