/***
*  car_test.cpp -- h9_car's handling, run with no game.
*
*  It compiles the plain functions of ../h9_car.cpp (H9CarStep, H9CarFallStep, the surface table) and nothing of
*  the game, drives the car through a few set pieces and prints what it did. It is in no CMake target; build it
*  by hand, from reTS/dlls/tests:
*
*    clang++ -std=c++17 -O1 car_test.cpp -o car_test.exe        (or: cl /std:c++17 /EHsc car_test.cpp)
*
*  It ends with "PASS" or with "FAIL" and the count of what was wrong (each named on its own line), and returns
*  that count.
***/
#define H9CAR_MATHS_ONLY
#include "../h9_car.cpp"

#include <initializer_list>
#include <stdio.h>
#include <stdlib.h>

static int g_failed = 0;

static void Expect(bool ok, const char* what)
{
	if (!ok)
	{
		g_failed++;
		printf("  WRONG: %s\n", what);
	}
}

static H9CarGround On(int surface, float depth = 0)
{
	H9CarGround g;
	g.grip = g.top = g.roll = g.loose = 0;
	H9SurfaceAdd(g, surface, depth);
	return g;
}

static H9CarTune Tune(float maxSpeed, float accel)
{
	H9CarTune t;
	t.maxSpeed = maxSpeed;
	t.accel = accel;
	return t;
}

// A car on a flat plane: where it is and which way it points.
struct Car
{
	H9CarMotion m;
	float x = 0, y = 0, yaw = 0; // degrees
	float travelled = 0;

	float Speed() const { return sqrtf(m.forward * m.forward + m.side * m.side); }
	// the way it goes, degrees
	float Path() const { return yaw + atan2f(m.side, m.forward) / H9_RAD; }
	float Drift() const { return atan2f(m.side, fabsf(m.forward)) / H9_RAD; }

	void Step(const H9CarTune& t, const H9CarInput& in, const H9CarGround& g, float dt)
	{
		yaw += H9CarStep(m, t, in, g, dt);
		const float c = cosf(yaw * H9_RAD), s = sinf(yaw * H9_RAD);
		const float vx = m.forward * c - m.side * s, vy = m.forward * s + m.side * c;
		x += vx * dt;
		y += vy * dt;
		travelled += sqrtf(vx * vx + vy * vy) * dt;
	}
};

static bool Finite(const Car& car)
{
	return isfinite(car.m.forward) && isfinite(car.m.side) && isfinite(car.m.steer) && isfinite(car.yaw) &&
		   isfinite(car.x) && isfinite(car.y) && isfinite(car.m.slip) && isfinite(car.m.hand);
}

static void TopSpeeds(const H9CarTune& t, const char* title)
{
	printf("\nTop speed and pulling away, %s (maxspeed %.0f, accel %.0f)\n", title, t.maxSpeed, t.accel);
	printf("  %-12s %8s %12s %14s\n", "surface", "top", "0 to 90%", "coast to stop");
	const struct
	{
		const char* name;
		int surface;
		float depth;
	} rows[] = {{"tarmac", H9SURF_TARMAC, 0}, {"gravel", H9SURF_GRAVEL, 0}, {"dirt", H9SURF_DIRT, 0},
		{"grass", H9SURF_GRASS, 0}, {"water film", H9SURF_WATER, 0}, {"water 28", H9SURF_WATER, 28.0f / 40},
		{"water 40+", H9SURF_WATER, 1}};
	float tarmac = 0;
	for (const auto& row : rows)
	{
		const H9CarGround g = On(row.surface, row.depth);
		Car car;
		H9CarInput in;
		in.push = 1;
		for (int i = 0; i < 6000; i++)
			car.Step(t, in, g, 0.01f);
		const float top = car.m.forward;
		Car again;
		float time = 0;
		while (again.m.forward < top * 0.9f && time < 60)
		{
			again.Step(t, in, g, 0.01f);
			time += 0.01f;
		}
		in.push = 0;
		float coast = 0;
		while (car.Speed() > 0 && coast < 60)
		{
			car.Step(t, in, g, 0.01f);
			coast += 0.01f;
		}
		printf("  %-12s %8.0f %10.1f s %12.1f s\n", row.name, top, time, coast);
		if (row.surface == H9SURF_TARMAC)
		{
			tarmac = top;
			Expect(fabsf(top - t.maxSpeed) < t.maxSpeed * 0.02f, "tarmac's top speed is maxspeed");
		}
		else
			Expect(top < tarmac, "every other surface is slower than tarmac");
	}
}

// A corner at full lock, the speed held by the throttle: the radius of the path once it has settled, the angle
// between nose and path, and the speed it could hold.
static void Corner(const H9CarTune& t, int surface, float speed, float dt, float& radius, float& drift, float& held,
	float& slip, bool power = true)
{
	const H9CarGround g = On(surface);
	Car car;
	car.m.forward = speed;
	H9CarInput in;
	in.turn = 1;
	float pathBefore = 0, time = 0, sumSpeed = 0, sumDrift = 0, sumSlip = 0;
	int count = 0;
	const float settle = 4.0f, measure = 2.0f;
	while (time < settle + measure)
	{
		in.push = power && car.Speed() < speed ? 1 : 0;
		if (!power)
			car.m.forward = sqrtf(speed * speed > car.m.side * car.m.side ? speed * speed - car.m.side * car.m.side : 0);
		car.Step(t, in, g, dt);
		time += dt;
		if (time >= settle)
		{
			if (count == 0)
				pathBefore = car.Path();
			sumSpeed += car.Speed();
			sumDrift += car.Drift();
			sumSlip += car.m.slip;
			count++;
		}
	}
	held = sumSpeed / count;
	drift = sumDrift / count;
	slip = sumSlip / count;
	const float turned = fabsf(car.Path() - pathBefore) * H9_RAD;
	radius = turned > 0.0001f ? held * (count - 1) * dt / turned : 0;
	Expect(Finite(car), "a corner keeps every number finite");
}

static void Corners(const H9CarTune& t, const char* title, const float* speeds, int count)
{
	printf("\nA steady corner at full lock, %s (maxspeed %.0f); the throttle holds the speed where it can\n", title, t.maxSpeed);
	printf("  %-8s %6s | %8s %8s %8s %6s | %s\n", "surface", "speed", "radius", "held", "nose in", "slip", "the radius with no slide (wheelbase / tan lock)");
	const int surfaces[] = {H9SURF_TARMAC, H9SURF_GRAVEL, H9SURF_DIRT, H9SURF_GRASS, H9SURF_WATER};
	for (int surface : surfaces)
	{
		for (int i = 0; i < count; i++)
		{
			float radius, drift, held, slip;
			Corner(t, surface, speeds[i], 0.01f, radius, drift, held, slip);
			const float lock = t.maxTurn * (1 - 0.45f * H9Clamp(held / t.maxSpeed, 0, 1));
			printf("  %-8s %6.0f | %8.0f %8.0f %7.1f deg %6.2f | %.0f\n", g_h9Surfaces[surface].name, speeds[i], radius, held,
				-drift, slip, t.wheelbase / tanf(lock * H9_RAD));
		}
	}
}

static void Handbrake(const H9CarTune& t, int surface, float from, float held = 1.0f)
{
	const H9CarGround g = On(surface);
	Car car;
	car.m.forward = from;
	H9CarInput in;
	in.turn = 1;
	in.handbrake = true;
	float peakSlip = 0;
	for (int i = 0; i < (int)(held * 100 + 0.5f); i++)
	{
		car.Step(t, in, g, 0.01f);
		peakSlip = car.m.slip > peakSlip ? car.m.slip : peakSlip;
	}
	const float nose = car.yaw, path = car.Path(), far = car.travelled, left = car.Speed();
	in.handbrake = false; // let go, power on, wheels straight: how long until it goes where it points
	in.turn = 0;
	in.push = 1;
	float bite = 0;
	while (fabsf(car.Drift()) > 2 && bite < 5)
	{
		car.Step(t, in, g, 0.01f);
		bite += 0.01f;
	}
	printf("  %-8s %6.0f %4.1f s | %7.0f deg %7.0f deg %8.0f %8.0f %6.2f | %6.2f s %7.0f deg %7.0f\n", g_h9Surfaces[surface].name, from, held, nose,
		path, far, left, peakSlip, bite, car.yaw, car.Speed());
	Expect(Finite(car), "a handbrake turn keeps every number finite");
	Expect(nose > path + 10, "with the handbrake the nose comes round more than the path");
	Expect(left < from * 0.75f, "the handbrake takes a good part of the speed");
	Expect(left > from * 0.15f, "and leaves enough of it to drive out of the corner");
	Expect(bite < 1.5f, "grip is back within a second and a half of letting the handbrake go");
}

static void Stopping(const H9CarTune& t)
{
	printf("\nStopping from 900 with S held (brake %.0f), and with the handbrake alone, wheels straight\n", t.brake);
	printf("  %-8s %10s %8s | %10s %8s\n", "surface", "distance", "time", "handbrake", "time");
	const int surfaces[] = {H9SURF_TARMAC, H9SURF_GRAVEL, H9SURF_DIRT, H9SURF_GRASS, H9SURF_WATER};
	for (int surface : surfaces)
	{
		const H9CarGround g = On(surface);
		float distance[2], time[2];
		for (int how = 0; how < 2; how++)
		{
			Car car;
			car.m.forward = 900;
			H9CarInput in;
			in.push = how == 0 ? -1 : 0;
			in.handbrake = how == 1;
			time[how] = 0;
			while (car.m.forward > H9CAR_CRAWL && time[how] < 30)
			{
				car.Step(t, in, g, 0.01f);
				time[how] += 0.01f;
			}
			distance[how] = car.travelled;
		}
		printf("  %-8s %10.0f %6.2f s | %10.0f %6.2f s\n", g_h9Surfaces[surface].name, distance[0], time[0], distance[1], time[1]);
	}
}

// The ground along a straight, for the jumps: its height at a distance.
typedef float (*Profile)(float x);

static float Crest(float x) // race01's: up 640, flat 128, down 640, 56 high; it starts at 1000
{
	x -= 1000;
	if (x <= 0 || x >= 1408)
		return 0;
	if (x < 640)
		return 56 * x / 640;
	if (x <= 768)
		return 56;
	return 56 * (1408 - x) / 640;
}

static float Kicker(float x) // the same ramp with nothing after its lip
{
	x -= 1000;
	if (x <= 0 || x >= 640)
		return 0;
	return 56 * x / 640;
}

static float Steep(float x) // a ramp of 20 degrees, 112 high, nothing after its lip
{
	x -= 1000;
	if (x <= 0 || x >= 308)
		return 0;
	return 112 * x / 308;
}

static float Downhill(float x) // flat, then 10 degrees down for good
{
	return x < 1000 ? 0 : -(x - 1000) * 0.176f;
}

static float Kerbs(float x) // a kerb of 12 up, and one down again
{
	return x >= 1000 && x < 2000 ? 12.0f : 0.0f;
}

// The car driven straight over a profile, the way CH9Car::Settle does it: a trace down under each axle from over
// the wheel's last ground, H9CarFallStep for the height, and the landing's loss.
static void Jump(const H9CarTune& t, const char* name, Profile profile, float speed, float dt, bool report = true)
{
	const float frontDist = 75, rearDist = 75, radius = 20, maxStep = 12, track = 88;
	const float along[4] = {frontDist, frontDist, -rearDist, -rearDist};
	const float across[4] = {-track / 2, track / 2, -track / 2, track / 2};
	H9CarMotion m;
	m.forward = speed;
	H9CarHeight h;
	H9CarGround g = On(H9SURF_TARMAC);
	H9CarInput in;
	in.push = 1;
	float x = 0, pitch = 0;
	float wheelGround[4] = {0, 0, 0, 0};
	// the longest time off the ground is the jump: where it began, how long, how far, how high over the ground
	float began = 0, now = 0, nowAir = 0, nowApex = 0, nowLip = speed;
	float flight = 0, airborne = 0, far = 0, apex = 0, speedAtLip = speed, impactMost = 0, lowest = 0;
	bool ok = true;
	float time = 0;
	while (x < 6000 && time < 20)
	{
		g.pitch = pitch;
		g.airborne = h.airborne;
		H9CarStep(m, t, in, g, dt);
		x += m.forward * dt;
		float ground[4], floor;
		bool touching[4];
		for (int i = 0; i < 4; i++)
		{
			const float z = profile(x + along[i]);
			touching[i] = z <= wheelGround[i] + maxStep + 1 && z >= wheelGround[i] - (radius * 2 + 8);
			ground[i] = touching[i] ? z : h.z - radius;
		}
		const int count = H9CarFloor(h, ground, touching, along, across, frontDist + rearDist, track, floor);
		const bool was = h.contact;
		const float impact = H9CarFallStep(h, count, floor, m.forward * h.slopeAlong - m.side * h.slopeAcross, g.gravity, dt);
		if (impact > H9CAR_LAND)
			m.forward *= H9CarLanding(impact);
		impactMost = impact > impactMost ? impact : impactMost;
		for (int i = 0; i < 4; i++)
			wheelGround[i] = touching[i] ? ground[i] : h.z;
		if (count)
			pitch += (atan2f(ground[0] - ground[2], frontDist + rearDist) / H9_RAD - pitch) * H9Clamp(dt * 10, 0, 1);
		if (was && !h.contact)
		{
			began = x;
			now = nowAir = nowApex = 0;
			nowLip = m.forward;
		}
		if (!h.contact)
		{
			now += dt;
			nowAir += h.airborne ? dt : 0;
			const float over = h.z - profile(x);
			nowApex = over > nowApex ? over : nowApex;
		}
		if (!was && h.contact && now > flight)
		{
			flight = now;
			airborne = nowAir;
			far = x - began;
			apex = nowApex;
			speedAtLip = nowLip;
		}
		const float under = h.z - profile(x);
		lowest = under < lowest ? under : lowest;
		ok = ok && isfinite(h.z) && isfinite(h.fall) && isfinite(m.forward);
		time += dt;
	}
	if (report)
		printf("  %-22s %6.0f %6.3f | %7.0f %7.2f s %7.2f s %8.0f %7.1f %8.0f %8.0f\n", name, speed, dt, speedAtLip, flight,
			airborne, far, apex, impactMost, m.forward);
	Expect(ok, "a jump keeps every number finite");
	Expect(h.contact && fabsf(h.z - profile(x)) < 1, "after the jump the car is on the ground again");
	Expect(lowest > -30, "the car never sinks into the ground");
	Expect(m.forward > speed * 0.5f, "a landing does not stop the car");
	if (profile == Kerbs)
		Expect(airborne == 0, "a kerb does not put the car in the air");
	if (profile == Crest && dt < 0.05f) // flights at 10 frames a second are a few frames long: too coarse to compare
		Expect(impactMost < H9CAR_LAND, "race01's crest costs no speed");
}

// Every button at random, every surface, at one frame length: nothing may come out that is not a number, a car
// nobody powers on flat ground may never gain speed, and none may pass its top speed.
static void Random(const H9CarTune& t, float dt, unsigned seed)
{
	srand(seed);
	Car car;
	car.m.forward = t.maxSpeed;
	H9CarInput in;
	H9CarGround g = On(H9SURF_TARMAC);
	bool finite = true, noGain = true, underTop = true, slipInRange = true;
	float worstGain = 0;
	const int steps = (int)(600 / dt) < 400000 ? (int)(600 / dt) : 400000;
	for (int i = 0; i < steps; i++)
	{
		if (rand() % 40 == 0)
		{
			in.turn = rand() % 3 - 1;
			in.handbrake = rand() % 4 == 0;
			in.push = rand() % 3 - 1;
			if (rand() % 3 == 0)
				g = On(rand() % H9SURF_COUNT, (rand() % 100) / 100.0f);
			g.airborne = rand() % 10 == 0;
		}
		const bool coasting = in.push == 0;
		const float before = car.Speed();
		car.Step(t, in, g, dt);
		const float after = car.Speed();
		finite = finite && Finite(car);
		if (coasting && after > before + 0.01f)
		{
			noGain = false;
			worstGain = after - before > worstGain ? after - before : worstGain;
		}
		// S pulls a standing car backwards, W forwards: the only gains allowed, and never past the top speed
		if (!coasting && after > before + t.accel * dt * 1.01f + 0.01f)
		{
			noGain = false;
			worstGain = after - before > worstGain ? after - before : worstGain;
		}
		underTop = underTop && after <= (t.maxSpeed > t.backSpeed ? t.maxSpeed : t.backSpeed) * 1.001f + 0.01f;
		slipInRange = slipInRange && car.m.slip >= 0 && car.m.slip <= 1 && car.m.hand >= 0 && car.m.hand <= 1;
		if (!finite)
			break;
	}
	printf("  dt %.3f: %d steps, finite %s, no speed from sliding %s (worst gain %.3f), under top speed %s\n", dt, steps,
		finite ? "yes" : "NO", noGain ? "yes" : "NO", worstGain, underTop ? "yes" : "NO");
	Expect(finite, "random driving keeps every number finite");
	Expect(noGain, "the car never gains speed but from its engine");
	Expect(underTop, "the car never passes maxspeed");
	Expect(slipInRange, "slip and handbrake stay between 0 and 1");
}

static void Names()
{
	const struct
	{
		const char* name;
		int surface;
	} cases[] = {{"tarmac01", H9SURF_TARMAC}, {"ROAD_LINE", H9SURF_TARMAC}, {"startgrid", H9SURF_TARMAC},
		{"gravel2", H9SURF_GRAVEL}, {"~gravel_wet", H9SURF_GRAVEL}, {"{GRAVEL", H9SURF_GRAVEL}, {"+0dirt_a", H9SURF_DIRT},
		{"-2Dirt", H9SURF_DIRT}, {"+A~dirt", H9SURF_DIRT}, {"grass", H9SURF_GRASS}, {"verge_l", H9SURF_GRASS},
		{"HILLSIDE", H9SURF_GRASS}, {"!water1", H9SURF_WATER}, {"*water", H9SURF_WATER}, {"water", H9SURF_WATER},
		{"concrete", H9SURF_TARMAC}, {"", H9SURF_TARMAC}, {"+", H9SURF_TARMAC}, {"~", H9SURF_TARMAC},
		{"mygravel", H9SURF_TARMAC}, {"gra", H9SURF_TARMAC}, {NULL, H9SURF_TARMAC}};
	bool ok = true;
	for (const auto& one : cases)
	{
		if (H9SurfaceByName(one.name) != one.surface)
		{
			ok = false;
			printf("  WRONG: \"%s\" read as %s\n", one.name ? one.name : "(none)", g_h9Surfaces[H9SurfaceByName(one.name)].name);
		}
	}
	printf("\nTexture names: %d read, %s\n", (int)(sizeof(cases) / sizeof(cases[0])), ok ? "all as the table says" : "SOME WRONG");
	Expect(ok, "texture names give the surfaces of contract 1");
}

int main()
{
	const H9CarTune stock;                    // the keys' defaults: maxspeed 900, accel 450
	const H9CarTune race = Tune(1200, 600);   // what the race map is expected to set

	Names();
	TopSpeeds(stock, "the defaults");
	TopSpeeds(race, "the race map's keys");

	const float stockSpeeds[] = {300, 540, 700, 900};
	const float raceSpeeds[] = {300, 600, 900, 1200};
	Corners(stock, "the defaults", stockSpeeds, 4);
	Corners(race, "the race map's keys", raceSpeeds, 4);

	// as it drove before: on tarmac, up to 60% of the top speed, full lock makes no slide and the old radius
	{
		float radius, drift, held, slip;
		Corner(stock, H9SURF_TARMAC, 540, 0.01f, radius, drift, held, slip);
		const float old = stock.wheelbase / tanf(stock.maxTurn * (1 - 0.45f * 0.6f) * H9_RAD);
		printf("\nAs before on tarmac: full lock at 540 (60%% of 900) turns on %.0f, the old car on %.0f; nose in %.2f deg, slip %.2f\n",
			radius, old, -drift, slip);
		Expect(fabsf(radius - old) < old * 0.03f, "at 60% of top speed on tarmac the radius is the old car's");
		Expect(fabsf(drift) < 0.5f && slip < 0.02f, "at 60% of top speed on tarmac nothing slides");
	}

	printf("\nPower on a loose surface: full lock at 600 on the race keys, throttle held against throttle lifted (speed kept)\n");
	printf("  %-8s | %10s %10s | %10s %10s\n", "surface", "nose in", "radius", "lifted", "radius");
	for (int surface : {H9SURF_TARMAC, H9SURF_GRAVEL, H9SURF_DIRT, H9SURF_GRASS})
	{
		float radius[2], drift[2], held, slip;
		Corner(race, surface, 600, 0.01f, radius[0], drift[0], held, slip);
		Corner(race, surface, 600, 0.01f, radius[1], drift[1], held, slip, false);
		printf("  %-8s | %9.1f deg %10.0f | %9.1f deg %10.0f\n", g_h9Surfaces[surface].name, -drift[0], radius[0], -drift[1], radius[1]);
		if (surface == H9SURF_GRAVEL || surface == H9SURF_DIRT)
			Expect(-drift[0] > -drift[1] + 1, "on gravel and dirt the rear steps out more with the power on");
	}

	printf("\nA handbrake turn: full lock with the handbrake held, then let go with the power on and the wheels straight\n");
	printf("  %-8s %6s %6s | %8s %8s %8s %8s %6s | %8s %8s %7s\n", "surface", "from", "held", "nose", "path", "distance", "speed", "slip",
		"grip back", "nose", "speed");
	for (int surface : {H9SURF_TARMAC, H9SURF_GRAVEL, H9SURF_DIRT, H9SURF_GRASS})
		Handbrake(race, surface, 700);
	Handbrake(race, H9SURF_TARMAC, 400, 0.5f);
	Handbrake(race, H9SURF_TARMAC, 1000, 1.5f);
	Handbrake(race, H9SURF_GRAVEL, 1000, 1.5f);
	Handbrake(stock, H9SURF_TARMAC, 700);

	Stopping(stock);

	printf("\nJumps, driven straight with the power on (race keys); the crest is race01's: up 640, flat 128, down 640, 56 high\n");
	printf("  %-22s %6s %6s | %7s %9s %9s %8s %7s %8s %8s\n", "ground", "speed", "dt", "at lip", "off ground", "\"in air\"",
		"distance", "apex", "landing", "speed");
	for (float dt : {0.01f, 0.001f, 0.1f})
	{
		Jump(race, "crest", Crest, 1200, dt);
		Jump(race, "crest", Crest, 900, dt);
		Jump(race, "crest", Crest, 400, dt);
		Jump(race, "ramp, then nothing", Kicker, 1200, dt);
		// at 10 frames a second the car goes 120 units a frame and the ramp rises 43 under it: more than the wheels'
		// traces reach up (maxstep), in the game as here, where the bumper rays would stop it as at a wall
		if (dt < 0.05f)
			Jump(race, "20 deg ramp, then nothing", Steep, 1200, dt);
		Jump(race, "flat, then 10 deg down", Downhill, 1200, dt);
		Jump(race, "a kerb of 12, up, down", Kerbs, 600, dt);
	}
	Jump(race, "crest, backwards", Crest, 0, 0.01f, false);

	printf("\nThe same corner at three frame lengths (race keys, tarmac, 1200 and 600)\n");
	for (float speed : {1200.0f, 600.0f})
	{
		float radius[3], drift[3];
		const float dts[3] = {0.001f, 0.01f, 0.1f};
		for (int i = 0; i < 3; i++)
		{
			float held, slip;
			Corner(race, H9SURF_TARMAC, speed, dts[i], radius[i], drift[i], held, slip);
			printf("  speed %4.0f dt %.3f: radius %6.0f, nose in %5.1f deg\n", speed, dts[i], radius[i], -drift[i]);
		}
		Expect(fabsf(radius[0] - radius[2]) < radius[1] * 0.08f, "a corner is the same at 1000 frames a second as at 10");
	}

	printf("\nTen minutes of random buttons on every surface\n");
	Random(stock, 0.001f, 1);
	Random(stock, 0.01f, 2);
	Random(stock, 0.1f, 3);
	Random(race, 0.013f, 4);
	H9CarTune odd = race; // keys a mapper might mistype
	odd.grip = 0;
	odd.slide = 0;
	odd.handbrake = 5;
	odd.wheelbase = 0;
	Random(odd, 0.01f, 5);
	odd.grip = 50;
	odd.slide = 50;
	odd.maxSpeed = 0;
	Random(odd, 0.01f, 6);

	if (g_failed)
		printf("\nFAIL: %d wrong\n", g_failed);
	else
		printf("\nPASS\n");
	return g_failed;
}
