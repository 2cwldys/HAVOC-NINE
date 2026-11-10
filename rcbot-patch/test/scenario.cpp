// A look at what the planner does with a few made-up maps. Prints; asserts nothing.
//   cl /nologo /std:c++17 /EHsc /I<rcbot dlls folder> scenario.cpp
#include "bot_objective.h"

#include <cstdio>
#include <vector>

using namespace objplan;

static const char* roleName(Role r)
{
	static const char* n[] = { "none", "TAKE", "RETAKE", "HOLD", "FETCH", "CARRY", "ESCORT", "HUNT", "RETURN", "GUARD", "CLEAR" };
	return n[r];
}

static Obj ring(Kind k, int n, int owner, float x, float y, float radius, float reach)
{
	Obj o;
	o.kind = k;
	o.number = n;
	o.id = static_cast<int>(k) * 256 + n;
	o.owner = owner;
	o.x = x;
	o.y = y;
	o.radius = radius;
	o.reach = reach;
	return o;
}

static void show(const char* title, const std::vector<Obj>& objs, Mode mode, const std::vector<Bot>& bots, const Params& p)
{
	std::vector<Assign> out(bots.size());
	plan(mode, objs.data(), static_cast<int>(objs.size()), bots.data(), static_cast<int>(bots.size()), p, out.data());
	std::printf("== %s\n", title);

	for (int side = 1; side <= 2; side++)
	{
		std::printf("  side %d:", side);

		for (size_t i = 0; i < bots.size(); i++)
		{
			if (bots[i].side != side)
				continue;

			if (out[i].role == R_NONE)
				std::printf(" [%d free%s]", bots[i].slot, out[i].later ? "/wait" : "");
			else
				std::printf(" [%d %s@%d%s]", bots[i].slot, roleName(out[i].role), out[i].obj & 255, out[i].target ? "->zone" : "");
		}

		std::printf("\n");
	}
}

int main()
{
	// Assault: six points in a row, side 1 spawns at the left, side 2 at the right
	std::vector<Obj> pts;

	for (int i = 0; i < 6; i++)
		pts.push_back(ring(K_POINT, i + 1, 0, 1000.0f * i, 0.0f, 384.0f, 128.0f));

	std::vector<Bot> bs;

	for (int i = 0; i < 10; i++)
	{
		Bot a;
		a.slot = 1 + i;
		a.side = 1;
		a.x = -500.0f + 20.0f * i;
		a.z = 36.0f;
		bs.push_back(a);
		Bot b;
		b.slot = 20 + i;
		b.side = 2;
		b.x = 5500.0f - 20.0f * i;
		b.z = 36.0f;
		bs.push_back(b);
	}

	Params first;
	first.maxNew = 99;
	show("assault, round start (all neutral)", pts, MODE_ASSAULT, bs, first);

	// side 1 holds the first three, point 4 is being taken by side 2, point 3 contested
	pts[0].owner = 1;
	pts[1].owner = 1;
	pts[2].owner = 1;
	pts[2].state = ST_CONTESTED;
	pts[2].nIn[1] = 1;
	pts[2].nIn[2] = 2;
	pts[3].state = ST_TAKEN;
	pts[3].taker = 2;
	pts[3].progress = -0.4f;
	pts[3].nIn[2] = 2;
	show("assault, mid round", pts, MODE_ASSAULT, bs, Params());

	// Uplink: three zones, the uplink at the middle
	std::vector<Obj> up;

	for (int i = 0; i < 3; i++)
		up.push_back(ring(K_ZONE, i + 1, 0, -2000.0f + 2000.0f * i, 800.0f, 128.0f, 96.0f));

	Obj u;
	u.kind = K_UPLINK;
	u.number = 1;
	u.id = static_cast<int>(K_UPLINK) * 256 + 1;
	u.x = 0.0f;
	show("uplink, at its post", [&] { auto v = up; v.push_back(u); return v; }(), MODE_UPLINK, bs, first);

	u.state = ST_CARRIED;
	u.carrierSlot = 3;
	u.carrierSide = 1;
	bs[4].carryingObj = u.id;   // slot 3
	show("uplink, side 1 carries it (slot 3)", [&] { auto v = up; v.push_back(u); return v; }(), MODE_UPLINK, bs, Params());
	return 0;
}
