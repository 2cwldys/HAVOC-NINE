// Golden cases for bot_objective.h. No game and no HL SDK needed.
//   cl /nologo /std:c++17 /EHsc /W4 /I<rcbot dlls folder> test_bot_objective.cpp
#include "bot_objective.h"

#include <cstdio>
#include <cstring>
#include <vector>

using namespace objplan;

static int g_fail = 0;
static int g_checks = 0;

#define CHECK(cond) do { g_checks++; if (!(cond)) { g_fail++; std::printf("FAIL line %d: %s\n", __LINE__, #cond); } } while (0)

static int oid(Kind k, int n) { return static_cast<int>(k) * 256 + n; }

static Obj point(int n, int owner, float x, float y, float z = 0.0f, int in1 = 0, int in2 = 0, int state = ST_QUIET, bool pathable = true)
{
	Obj o;
	o.id = oid(K_POINT, n);
	o.kind = K_POINT;
	o.number = n;
	o.owner = owner;
	o.x = x;
	o.y = y;
	o.z = z;
	o.radius = 384.0f;
	o.reach = 128.0f;
	o.state = state;
	o.nIn[1] = in1;
	o.nIn[2] = in2;
	o.pathable = pathable;
	return o;
}

static Obj zone(int n, int owner, float x, float y, float z = 0.0f, int in1 = 0, int in2 = 0, int state = ST_QUIET, bool pathable = true)
{
	Obj o = point(n, owner, x, y, z, in1, in2, state, pathable);
	o.id = oid(K_ZONE, n);
	o.kind = K_ZONE;
	o.radius = 128.0f;
	o.reach = 96.0f;
	return o;
}

static Obj uplink(float x, float y, int state = ST_HOME, int carrierSlot = 0, int carrierSide = 0)
{
	Obj o;
	o.id = oid(K_UPLINK, 1);
	o.kind = K_UPLINK;
	o.number = 1;
	o.x = x;
	o.y = y;
	o.state = state;
	o.carrierSlot = carrierSlot;
	o.carrierSide = carrierSide;
	return o;
}

static Obj flag(int side, float x, float y, int state = ST_HOME, int carrierSlot = 0, int carrierSide = 0)
{
	Obj o;
	o.id = oid(K_FLAG, side);
	o.kind = K_FLAG;
	o.number = side;
	o.owner = side;
	o.x = x;
	o.y = y;
	o.state = state;
	o.carrierSlot = carrierSlot;
	o.carrierSide = carrierSide;
	o.padX = x;
	o.padY = y;
	return o;
}

static std::vector<Bot> bots(int side, std::vector<float> xs, float y = 0.0f, int first = 1)
{
	std::vector<Bot> v;
	int slot = first;

	for (float x : xs)
	{
		Bot b;
		b.slot = slot++;
		b.side = side;
		b.x = x;
		b.y = y;
		b.z = 36.0f;
		v.push_back(b);
	}

	return v;
}

static std::vector<Bot> cat(std::vector<Bot> a, const std::vector<Bot>& b)
{
	a.insert(a.end(), b.begin(), b.end());
	return a;
}

static Params noFree()
{
	Params p;
	p.freePct = 0;
	p.maxNew = 99;
	return p;
}

static std::vector<Assign> run(Mode m, const std::vector<Obj>& objs, const std::vector<Bot>& bs, const Params& p)
{
	std::vector<Assign> out(bs.size());
	plan(m, objs.data(), static_cast<int>(objs.size()), bs.data(), static_cast<int>(bs.size()), p, out.data());
	return out;
}

static int countRole(const std::vector<Assign>& out, Role r)
{
	int n = 0;

	for (const Assign& a : out)
		n += (a.role == r) ? 1 : 0;

	return n;
}

static int countRoleObj(const std::vector<Assign>& out, Role r, int obj)
{
	int n = 0;

	for (const Assign& a : out)
		n += (a.role == r && a.obj == obj) ? 1 : 0;

	return n;
}

// the position of the bot with this slot in the array
static int at(const std::vector<Bot>& bs, int slot)
{
	for (size_t i = 0; i < bs.size(); i++)
	{
		if (bs[i].slot == slot)
			return static_cast<int>(i);
	}

	return -1;
}

// ---------------------------------------------------------------------------------------------------------------- assault
static void assaultCases()
{
	{   // no objectives, mode none: nobody
		auto out = run(MODE_ASSAULT, {}, bots(1, { 0, 100, 200 }), noFree());
		CHECK(countRole(out, R_NONE) == 3);
		out = run(MODE_NONE, { point(1, 0, 0, 0) }, bots(1, { 0, 100 }), noFree());
		CHECK(countRole(out, R_NONE) == 2);
	}
	{   // a neutral point takes two: the two nearest
		auto bs = bots(1, { 0, 50, 100, 150 });
		auto out = run(MODE_ASSAULT, { point(1, 0, 1000, 0) }, bs, noFree());
		CHECK(countRole(out, R_TAKE) == 2);
		CHECK(out[at(bs, 3)].role == R_TAKE && out[at(bs, 4)].role == R_TAKE);
	}
	{   // the other side's point takes three
		auto out = run(MODE_ASSAULT, { point(1, 2, 1000, 0) }, bots(1, { 0, 50, 100, 150, 200 }), noFree());
		CHECK(countRole(out, R_TAKE) == 3);
	}
	{   // a held point being worn down is retaken before a neutral one
		auto bs = bots(1, { 90 });
		auto out = run(MODE_ASSAULT, { point(1, 1, 0, 0, 0, 0, 1, ST_TAKEN), point(2, 0, 100, 0) }, bs, noFree());
		CHECK(out[0].role == R_RETAKE && out[0].obj == oid(K_POINT, 1));
	}
	{   // the cap on one point
		Params p = noFree();
		p.perObj = 2;
		auto out = run(MODE_ASSAULT, { point(1, 2, 5000, 0) }, bots(1, std::vector<float>(8, 0.0f)), p);
		CHECK(countRole(out, R_TAKE) == 2);
	}
	{   // the free share is kept: 25% of 8
		Params p;
		p.maxNew = 99;
		auto out = run(MODE_ASSAULT, { point(1, 2, 0, 0), point(2, 2, 500, 0), point(3, 0, 1000, 0) }, bots(1, std::vector<float>(8, 0.0f)), p);
		CHECK(countRole(out, R_NONE) >= 2);
	}
	{   // a side of three keeps nobody free
		Params p;
		p.maxNew = 99;
		auto out = run(MODE_ASSAULT, { point(1, 0, 5000, 0) }, bots(1, { 0, 10, 20 }), p);
		CHECK(countRole(out, R_TAKE) == 2);
	}
	{   // a point no waypoint leads to is skipped
		auto out = run(MODE_ASSAULT, { point(1, 0, 0, 0, 0, 0, 0, ST_QUIET, false), point(2, 0, 500, 0) }, bots(1, { 0, 10 }), noFree());
		for (const Assign& a : out)
			CHECK(a.role == R_NONE || a.obj == oid(K_POINT, 2));
	}
	{   // quiet held points are guarded only at the front: three held, one open, one guard at the nearest
		std::vector<Obj> objs = { point(1, 1, 0, 0), point(2, 1, 1000, 0), point(3, 1, 2000, 0), point(4, 0, 3000, 0) };
		auto out = run(MODE_ASSAULT, objs, bots(1, std::vector<float>(10, 2000.0f)), noFree());
		CHECK(countRole(out, R_HOLD) == 1);
		CHECK(countRoleObj(out, R_HOLD, oid(K_POINT, 3)) == 1);
	}
	{   // the sides are independent
		std::vector<Obj> objs = { point(1, 0, 0, 0) };
		auto both = run(MODE_ASSAULT, objs, cat(bots(1, { 0, 10 }), bots(2, { 0, 10, 20 }, 0.0f, 10)), noFree());
		auto one = run(MODE_ASSAULT, objs, bots(1, { 0, 10 }), noFree());
		CHECK(both[0].role == one[0].role && both[1].role == one[1].role);
		CHECK(countRole(both, R_TAKE) == 4);
	}
	{   // bots that cannot be planned get nothing
		auto bs = bots(1, { 0, 10, 20 });
		for (Bot& b : bs)
			b.planOk = false;
		auto out = run(MODE_ASSAULT, { point(1, 0, 0, 0) }, bs, noFree());
		CHECK(countRole(out, R_NONE) == 3);
	}
	{   // a bot with an enemy keeps its post and counts toward it
		auto bs = bots(1, { 0, 10, 20, 30 });
		bs[0].busy = true;
		bs[0].curObj = oid(K_POINT, 1);
		bs[0].curRole = R_TAKE;
		auto out = run(MODE_ASSAULT, { point(1, 0, 5000, 0) }, bs, noFree());
		CHECK(out[0].role == R_TAKE);
		CHECK(countRole(out, R_TAKE) == 2);
	}
	{   // a post is kept against a nearly as good one
		auto bs = bots(1, { 1040 });
		bs[0].curObj = oid(K_POINT, 2);
		bs[0].curRole = R_TAKE;
		auto out = run(MODE_ASSAULT, { point(1, 0, 1000, 0), point(2, 0, 1100, 0) }, bs, noFree());
		CHECK(out[0].obj == oid(K_POINT, 2));
	}
	{   // the change limit holds the rest back, told to wait and not to roam
		Params p;
		p.freePct = 0;
		p.perObj = 4;
		p.maxNew = 3;
		auto out = run(MODE_ASSAULT, { point(1, 0, 0, 0), point(2, 0, 1000, 0), point(3, 0, 2000, 0) }, bots(1, std::vector<float>(6, 0.0f)), p);
		CHECK(countRole(out, R_NONE) == 3);
		int later = 0;
		for (const Assign& a : out)
			later += a.later ? 1 : 0;
		CHECK(later == 3);
	}
	{   // each side has its own limit on changes
		Params p;
		p.freePct = 0;
		p.perObj = 4;
		p.maxNew = 1;
		auto out = run(MODE_ASSAULT, { point(1, 0, 0, 0), point(2, 0, 1000, 0) }, cat(bots(1, { 0, 10, 20 }), bots(2, { 0, 10, 20 }, 0.0f, 10)), p);
		int a = 0;
		int b = 0;
		for (size_t i = 0; i < out.size(); i++)
		{
			if (out[i].role != R_NONE)
				(i < 3 ? a : b)++;
		}
		CHECK(a == 1 && b == 1);
	}
	{   // nobody waits when there is nothing to do
		Params p;
		p.freePct = 0;
		p.maxNew = 0;
		auto out = run(MODE_ASSAULT, { point(1, 1, 0, 0) }, bots(1, { 0, 0, 0 }), p);
		for (const Assign& a : out)
			CHECK(!a.later);
	}
	{   // players of the side that are no bot of the plan lower the ask; the plan's own bots in the point do not
		auto bs = bots(1, { 5000, 5010, 5020, 5030 });
		auto out = run(MODE_ASSAULT, { point(1, 0, 0, 0, 0, 1, 0) }, bs, noFree());
		CHECK(countRole(out, R_TAKE) == 1);                  // one human inside: asks for 2 - 1
		bs = bots(1, { 0, 5010, 5020, 5030 });               // the first bot stands in the point and is that one inside
		out = run(MODE_ASSAULT, { point(1, 0, 0, 0, 0, 1, 0) }, bs, noFree());
		CHECK(countRole(out, R_TAKE) == 2);                  // the bot inside counts toward the post, and stays on it
		CHECK(out[0].role == R_TAKE);
	}
	{   // a point nearly taken needs no more bots than are in it
		auto bs = bots(1, { 0, 5010, 5020, 5030 });
		Obj p = point(1, 0, 0, 0, 0, 1, 0, ST_TAKEN);
		p.taker = 1;
		p.progress = 0.9f;
		auto out = run(MODE_ASSAULT, { p }, bs, noFree());
		CHECK(countRole(out, R_TAKE) == 1 && out[0].role == R_TAKE);
		p.progress = 0.3f;                                   // far from done: it asks for the usual two
		out = run(MODE_ASSAULT, { p }, bs, noFree());
		CHECK(countRole(out, R_TAKE) == 2);
	}
	{   // for side 2 the progress runs the other way: -0.9 is nearly taken
		auto bs = bots(2, { 0, 5010, 5020, 5030 });
		Obj p = point(1, 0, 0, 0, 0, 0, 1, ST_TAKEN);
		p.taker = 2;
		p.progress = -0.9f;
		auto out = run(MODE_ASSAULT, { p }, bs, noFree());
		CHECK(countRole(out, R_TAKE) == 1);
	}
	{   // a contested point draws one more bot than a neutral one with the same bots inside
		auto bs = bots(1, { 5000, 5010, 5020, 5030, 5040 });
		auto quiet = run(MODE_ASSAULT, { point(1, 0, 0, 0) }, bs, noFree());
		auto fight = run(MODE_ASSAULT, { point(1, 0, 0, 0, 0, 0, 1, ST_CONTESTED) }, bs, noFree());
		CHECK(countRole(quiet, R_TAKE) == 2 && countRole(fight, R_TAKE) == 3);
	}
	{   // the further a held point is worn down, the sooner it is retaken: the nearly lost one wins against a near neutral one
		auto bs = bots(1, { 600 });
		Obj worn = point(1, 1, 0, 0, 0, 0, 1, ST_TAKEN);
		worn.taker = 2;
		worn.progress = 0.1f;
		auto out = run(MODE_ASSAULT, { worn, point(2, 0, 600, 0) }, bs, noFree());
		CHECK(out[0].role == R_RETAKE);
	}
	{   // deterministic and free of the order of the bots
		std::vector<Obj> objs = { point(1, 0, 0, 0), point(2, 2, 900, 0) };
		auto bs = bots(1, { 0, 100, 200, 300, 400, 500, 600, 700 });
		Params p;
		p.seed = 7;
		p.maxNew = 99;
		auto a = run(MODE_ASSAULT, objs, bs, p);
		std::vector<Bot> rev(bs.rbegin(), bs.rend());
		auto b = run(MODE_ASSAULT, objs, rev, p);
		bool same = true;
		for (const Bot& bot : bs)
		{
			const Assign& x = a[at(bs, bot.slot)];
			const Assign& y = b[at(rev, bot.slot)];
			same = same && x.role == y.role && x.obj == y.obj;
		}
		CHECK(same);
	}
	{   // a pair the bot gave up is skipped
		Blocked blk[1] = { { 1, oid(K_POINT, 1) } };
		Params p = noFree();
		p.blocked = blk;
		p.nBlocked = 1;
		auto out = run(MODE_ASSAULT, { point(1, 0, 0, 0), point(2, 0, 5000, 0) }, bots(1, { 0 }), p);
		CHECK(out[0].obj == oid(K_POINT, 2));
	}
}

// ---------------------------------------------------------------------------------------------------------------- uplink
static std::vector<Obj> zones3(int o1 = 0, int o2 = 0, int o3 = 0)
{
	return { zone(1, o1, 1000, 0), zone(2, o2, 2000, 0), zone(3, o3, 3000, 0) };
}

static std::vector<Obj> join(std::vector<Obj> a, Obj b)
{
	a.push_back(b);
	return a;
}

static void uplinkCases()
{
	{   // the free uplink is fetched by the two nearest
		auto bs = bots(1, { 500, 100, 300, 50 });
		auto out = run(MODE_UPLINK, join(zones3(), uplink(0, 0)), bs, noFree());
		CHECK(countRole(out, R_FETCH) == 2);
		CHECK(out[at(bs, 2)].role == R_FETCH && out[at(bs, 4)].role == R_FETCH);
	}
	{   // the rest are left to fight: the zones are not guarded
		auto out = run(MODE_UPLINK, join(zones3(1, 1, 0), uplink(0, 0)), bots(1, { 0, 0, 0, 0, 0 }), noFree());
		CHECK(countRole(out, R_FETCH) == 2);
		CHECK(countRole(out, R_HOLD) == 0);
	}
	{   // a dropped uplink that flies home in a second is not walked to
		Obj up = uplink(0, 0, ST_DROPPED);
		up.left = 1.0f;
		auto out = run(MODE_UPLINK, join(zones3(), up), bots(1, { 0, 10, 20 }), noFree());
		CHECK(countRole(out, R_FETCH) == 0);
		up.left = 12.0f;
		out = run(MODE_UPLINK, join(zones3(), up), bots(1, { 0, 10, 20 }), noFree());
		CHECK(countRole(out, R_FETCH) == 2);
	}
	{   // a bot carrier goes for the cheapest zone with nobody against it; three escort and one clears that zone
		std::vector<Obj> zs = { zone(1, 0, 500, 0, 0, 0, 2), zone(2, 0, 1500, 0), zone(3, 1, 100, 0) };
		Obj up = uplink(0, 0, ST_CARRIED, 1, 1);
		auto bs = bots(1, { 0, 40, 80, 120, 160 });
		bs[0].carryingObj = up.id;
		auto out = run(MODE_UPLINK, join(zs, up), bs, noFree());
		CHECK(out[0].role == R_CARRY && out[0].target == oid(K_ZONE, 2));    // zone 1 has two against, zone 3 is ours
		CHECK(countRole(out, R_ESCORT) == 3);
		CHECK(countRoleObj(out, R_CLEAR, oid(K_ZONE, 2)) == 1);
	}
	{   // a carrier keeps its zone against one a little better, and leaves it when it fills with enemies
		std::vector<Obj> zs = { zone(1, 0, 1000, 0), zone(2, 0, 1100, 0) };
		Obj up = uplink(0, 0, ST_CARRIED, 1, 1);
		Bot b;
		b.slot = 1;
		b.side = 1;
		b.z = 36.0f;
		b.carryingObj = up.id;
		b.curObj = up.id;
		b.curRole = R_CARRY;
		b.curTarget = oid(K_ZONE, 2);
		std::vector<Bot> one = { b };
		auto out = run(MODE_UPLINK, join(zs, up), one, noFree());
		CHECK(out[0].target == oid(K_ZONE, 2));
		one[0].curTarget = oid(K_ZONE, 1);
		zs[0].nIn[2] = 3;
		out = run(MODE_UPLINK, join(zs, up), one, noFree());
		CHECK(out[0].target == oid(K_ZONE, 2));
	}
	{   // a zone the plugin says the carrier is denied in costs more
		std::vector<Obj> zs = { zone(1, 0, 1000, 0, 0, 0, 0, ST_CONTESTED), zone(2, 0, 1200, 0) };
		Obj up = uplink(0, 0, ST_CARRIED, 1, 1);
		Bot b;
		b.slot = 1;
		b.side = 1;
		b.z = 36.0f;
		b.carryingObj = up.id;
		std::vector<Bot> one = { b };
		auto out = run(MODE_UPLINK, join(zs, up), one, noFree());
		CHECK(out[0].target == oid(K_ZONE, 2));
	}
	{   // a carrier is never freed
		Obj up = uplink(0, 0, ST_CARRIED, 3, 1);
		auto bs = bots(1, std::vector<float>(8, 0.0f));
		bs[2].carryingObj = up.id;
		Params p;
		p.freePct = 90;
		p.maxNew = 99;
		auto out = run(MODE_UPLINK, join(zones3(), up), bs, p);
		CHECK(out[2].role == R_CARRY);
	}
	{   // a human carrier is escorted, and no zone is cleared for him
		Obj up = uplink(50, 0, ST_CARRIED, 20, 1);
		auto out = run(MODE_UPLINK, join(zones3(), up), bots(1, { 0, 40, 80, 120, 160 }), noFree());
		CHECK(countRole(out, R_ESCORT) == 3);
		CHECK(countRole(out, R_CLEAR) == 0);
	}
	{   // the other side's carrier is hunted
		Obj up = uplink(1500, 0, ST_CARRIED, 20, 2);
		auto out = run(MODE_UPLINK, join(zones3(1, 1, 0), up), bots(1, { 0, 100, 200, 300, 400, 500 }), noFree());
		CHECK(countRole(out, R_HUNT) == 3);
		CHECK(countRole(out, R_HOLD) == 0);
	}
	{   // no uplink: no orders; both sides get plans
		auto out = run(MODE_UPLINK, zones3(), bots(1, { 0, 10, 20 }), noFree());
		CHECK(countRole(out, R_NONE) == 3);
		out = run(MODE_UPLINK, join(zones3(), uplink(0, 0)), cat(bots(1, { 0, 10, 20 }), bots(2, { 0, 10, 20 }, 0.0f, 10)), noFree());
		int a = 0;
		int b = 0;
		for (size_t i = 0; i < out.size(); i++)
		{
			if (out[i].role == R_FETCH)
				(i < 3 ? a : b)++;
		}
		CHECK(a == 2 && b == 2);
	}
}

// ---------------------------------------------------------------------------------------------------------------- flags
static std::vector<Obj> flagsBase(int s1 = ST_HOME, int s2 = ST_HOME, int c1Slot = 0, int c1Side = 0, int c2Slot = 0, int c2Side = 0)
{
	return { flag(1, 0, 1500, s1, c1Slot, c1Side), flag(2, 0, -1500, s2, c2Slot, c2Side) };
}

static void flagCases()
{
	{   // attack and defence at the start
		auto out = run(MODE_CTF, flagsBase(), bots(1, std::vector<float>(6, 0.0f), 1400.0f), noFree());
		CHECK(countRoleObj(out, R_FETCH, oid(K_FLAG, 2)) == 2);
		CHECK(countRoleObj(out, R_GUARD, oid(K_FLAG, 1)) == 2);
	}
	{   // a dropped enemy flag is fetched
		auto out = run(MODE_CTF, flagsBase(ST_HOME, ST_DROPPED), bots(1, std::vector<float>(5, 0.0f), 100.0f), noFree());
		CHECK(countRole(out, R_FETCH) == 2);
	}
	{   // a dropped enemy flag about to fly home is not
		auto objs = flagsBase(ST_HOME, ST_DROPPED);
		objs[1].left = 1.5f;
		auto out = run(MODE_CTF, objs, bots(1, std::vector<float>(5, 0.0f), 100.0f), noFree());
		CHECK(countRole(out, R_FETCH) == 0);
	}
	{   // our dropped flag is returned by the nearest
		auto objs = flagsBase(ST_DROPPED);
		objs[0].y = 300.0f;
		auto bs = cat(cat(bots(1, { 0 }, 1000.0f, 1), bots(1, { 0 }, 400.0f, 2)), bots(1, { 0 }, -800.0f, 3));
		auto out = run(MODE_CTF, objs, bs, noFree());
		CHECK(countRole(out, R_RETURN) == 1 && out[at(bs, 2)].role == R_RETURN);
	}
	{   // the other side carries ours: three hunt
		auto objs = flagsBase(ST_CARRIED, ST_HOME, 20, 2);
		objs[0].y = 0.0f;
		auto out = run(MODE_CTF, objs, bots(1, { 0, 10, 20, 30, 40, 50 }, -100.0f), noFree());
		CHECK(countRole(out, R_HUNT) == 3);
	}
	{   // our carrier carries; two escort
		auto objs = flagsBase(ST_HOME, ST_CARRIED, 0, 0, 1, 1);
		objs[1].y = 0.0f;
		auto bs = bots(1, { 0, 10, 20, 30, 40, 50 }, -50.0f);
		bs[0].carryingObj = objs[1].id;
		auto out = run(MODE_CTF, objs, bs, noFree());
		CHECK(out[0].role == R_CARRY && out[0].obj == oid(K_FLAG, 2));
		CHECK(countRole(out, R_ESCORT) == 2);
	}
	{   // the free share never frees a fetcher
		auto bs = bots(1, std::vector<float>(4, 0.0f), 100.0f);
		bs[0].curObj = oid(K_FLAG, 2);
		bs[0].curRole = R_FETCH;
		Params p;
		p.freePct = 75;
		p.maxNew = 99;
		auto out = run(MODE_CTF, flagsBase(ST_HOME, ST_DROPPED), bs, p);
		CHECK(out[0].role == R_FETCH);
	}
}

// ---------------------------------------------------------------------------------------------------------------- validity
static void validityCases()
{
	Obj open = point(1, 2, 0, 0);
	Obj mine = point(2, 1, 0, 0);
	CHECK(roleValid(&open, R_TAKE, 1, 1));
	CHECK(!roleValid(&mine, R_TAKE, 1, 1));
	CHECK(roleValid(&mine, R_HOLD, 1, 1));
	CHECK(!roleValid(&mine, R_RETAKE, 1, 1));         // quiet and empty
	mine.nIn[2] = 1;
	CHECK(roleValid(&mine, R_RETAKE, 1, 1));
	mine.nIn[2] = 0;
	mine.state = ST_TAKEN;
	mine.taker = 1;                                    // its own side building it back up: no threat
	CHECK(!roleValid(&mine, R_RETAKE, 1, 1));
	mine.taker = 2;
	CHECK(roleValid(&mine, R_RETAKE, 1, 1));
	Obj up = uplink(0, 0, ST_CARRIED, 5, 2);
	CHECK(roleValid(&up, R_HUNT, 1, 1));
	CHECK(!roleValid(&up, R_FETCH, 1, 1));
	CHECK(!roleValid(&up, R_ESCORT, 1, 1));
	CHECK(!roleValid(nullptr, R_TAKE, 1, 1));
	Obj f = flag(1, 0, 0, ST_DROPPED);
	CHECK(roleValid(&f, R_RETURN, 1, 1));
	CHECK(roleValid(&f, R_FETCH, 2, 1));
	CHECK(!roleValid(&f, R_FETCH, 1, 1));
	CHECK(!roleValid(&f, R_GUARD, 1, 1));              // it is not at home
	f.left = 1.0f;
	CHECK(!roleValid(&f, R_RETURN, 1, 1));              // it flies home first
}

static void timing()
{
	// 128 bots, 30 objectives: nothing near a frame's budget
	std::vector<Obj> objs;
	for (int i = 1; i <= 24; i++)
		objs.push_back(point(i, i % 3, static_cast<float>(i * 400), static_cast<float>((i % 5) * 300)));
	std::vector<Bot> bs = cat(bots(1, std::vector<float>(64, 100.0f)), bots(2, std::vector<float>(64, 9000.0f), 0.0f, 65));
	Params p;
	std::vector<Assign> out(bs.size());
	int sum = 0;

	for (int i = 0; i < 100; i++)
	{
		plan(MODE_ASSAULT, objs.data(), static_cast<int>(objs.size()), bs.data(), static_cast<int>(bs.size()), p, out.data());
		sum += countRole(out, R_TAKE);
	}

	CHECK(sum > 0);
}

int main()
{
	assaultCases();
	uplinkCases();
	flagCases();
	validityCases();
	timing();
	std::printf("%d checks, %d failed\n", g_checks, g_fail);
	return g_fail == 0 ? 0 : 1;
}
