// Golden cases for bot_briefcase.h (TS's own capture game, rcbot-patch CHANGE 12) and for the planner changes it needs
// (bot_objective.h: Bot::canTake, Obj::padReach). No game and no HL SDK needed.
//   cl /nologo /std:c++17 /EHsc /W4 /I<rcbot dlls folder> test_bot_briefcase.cpp
#include "bot_briefcase.h"

#include <cstdio>
#include <vector>

using namespace objplan;

static int g_fail = 0;
static int g_checks = 0;

#define CHECK(cond) do { g_checks++; if (!(cond)) { g_fail++; std::printf("FAIL line %d: %s\n", __LINE__, #cond); } } while (0)

static int oid(Kind k, int n) { return static_cast<int>(k) * 256 + n; }

static int countRole(const std::vector<Assign>& out, Role r)
{
	int n = 0;

	for (const Assign& a : out)
	{
		if (a.role == r)
			n++;
	}

	return n;
}

// The speed the game gives a player with this many free inventory slots (GetSpeedBySlots, reTS ts_gun.cpp)
static float gameSpeed(const int free)
{
	if (free > 80)
		return 330.0f;

	return static_cast<float>(static_cast<int>(static_cast<double>(1.0f / 81.0f) * free * 120.0f + 210));
}

// ---------------------------------------------------------------------------------------------------------------------
static void trackerCases()
{
	{   // a team's flag follows the messages
		brief::Tracker t;

		CHECK(!t.flag[1].seen && !t.flag[2].seen);
		CHECK(t.left(1, 0.0f) == -1.0f);

		t.onFlag(brief::A_BASE, 3, 1, 0, 1.0f);
		CHECK(t.flag[1].seen && t.flag[1].state == ST_HOME && t.flag[1].carrier == 0 && t.flag[1].flagId == 3);
		CHECK(!t.flag[2].seen);

		t.onFlag(brief::A_PICKUP, 3, 1, 7, 50.0f);
		CHECK(t.flag[1].state == ST_CARRIED && t.flag[1].carrier == 7 && t.flag[1].since == 50.0f);
		CHECK(t.left(1, 51.0f) == -1.0f);

		t.onFlag(brief::A_DROP, 3, 1, 7, 60.0f);
		CHECK(t.flag[1].state == ST_DROPPED && t.flag[1].carrier == 0);
		CHECK(std::fabs(t.left(1, 60.0f) - brief::FLAG_EXPIRY) < 1e-4f);
		CHECK(std::fabs(t.left(1, 72.5f) - 7.5f) < 1e-4f);
		CHECK(t.left(1, 99.0f) == 0.0f);                      // overdue: the base is about to seed it

		t.onFlag(brief::A_BASE, 3, 1, 0, 80.0f);              // returned or expired: the base seeds it again
		CHECK(t.flag[1].state == ST_HOME && t.left(1, 81.0f) == -1.0f);
	}

	{   // what the messages do not name is ignored
		brief::Tracker t;

		t.onFlag(brief::A_BASE, 5, 0, 0, 1.0f);               // neutral
		t.onFlag(brief::A_BASE, 5, 3, 0, 1.0f);               // a third team
		t.onFlag(brief::A_BASE, 5, 200, 0, 1.0f);
		CHECK(!t.flag[1].seen && !t.flag[2].seen);

		t.onFlag(9, 5, 2, 4, 1.0f);                           // an action nobody knows: seen, nothing moves
		CHECK(t.flag[2].state == ST_HOME);
	}

	{   // team numbers of players
		brief::Tracker t;

		CHECK(t.sideOf(5) == 0);
		t.onScore(5, 1);
		t.onScore(6, 2);
		t.onScore(7, 3);                                      // a third team or the spectators
		t.onScore(8, 0);
		CHECK(t.sideOf(5) == 1 && t.sideOf(6) == 2 && t.sideOf(7) == 0 && t.sideOf(8) == 0);

		t.forgetSlot(5);
		CHECK(t.sideOf(5) == 0 && t.sideOf(6) == 2);

		t.onScore(0, 1);                                      // not players
		t.onScore(brief::MAX_SLOT + 1, 1);
		t.onScore(-3, 1);
		CHECK(t.sideOf(0) == 0 && t.sideOf(brief::MAX_SLOT + 1) == 0 && t.sideOf(-3) == 0);
		t.forgetSlot(0);
		t.forgetSlot(9999);

		t.onScore(brief::MAX_SLOT, 2);
		CHECK(t.sideOf(brief::MAX_SLOT) == 2);
	}

	{   // the keys of the map
		brief::Tracker t;

		CHECK(t.ownerOf(40) == -1);
		t.onOwnerKey(40, 1);
		t.onOwnerKey(41, 2);
		t.onOwnerKey(42, 0);
		CHECK(t.ownerOf(40) == 1 && t.ownerOf(41) == 2 && t.ownerOf(42) == 0 && t.ownerOf(43) == -1);

		t.onOwnerKey(40, 2);                                  // the last key of an entity stands
		CHECK(t.ownerOf(40) == 2 && t.nKeys == 3);

		for (int i = 0; i < 100; i++)                         // a map with a great many: the table does not overrun
			t.onOwnerKey(100 + i, 1);
		CHECK(t.nKeys == brief::MAX_OWNER_KEYS);
		CHECK(t.ownerOf(40) == 2);

		t.resetMap();
		CHECK(t.nKeys == 0 && t.ownerOf(40) == -1 && !t.layoutOk && t.nextScan == 0.0f && !t.flag[1].seen);
	}

	{   // the log of what the messages said: only on a map that has briefcases, and a few lines
		brief::Tracker t;

		CHECK(!t.takeLog());
		t.onOwnerKey(40, 1);

		int lines = 0;

		for (int i = 0; i < 100; i++)
		{
			if (t.takeLog())
				lines++;
		}

		CHECK(lines == 40);
		t.resetMap();
		CHECK(!t.takeLog());
	}
}

// ---------------------------------------------------------------------------------------------------------------------
static void ruleCases()
{
	{   // the layout the bots play
		const int ok1[] = { 1, 2 };
		const int ok2[] = { 2, 1 };
		const int same[] = { 1, 1 };
		const int neutral[] = { 0, 0 };
		const int oneNeutral[] = { 1, 0 };
		const int unknown[] = { 1, -1 };
		const int three[] = { 1, 2, 3 };
		const int threeOk[] = { 1, 2, 1 };

		CHECK(brief::layoutSupported(ok1, 2) && brief::layoutSupported(ok2, 2));
		CHECK(!brief::layoutSupported(same, 2));
		CHECK(!brief::layoutSupported(neutral, 2));
		CHECK(!brief::layoutSupported(oneNeutral, 2));
		CHECK(!brief::layoutSupported(unknown, 2));
		CHECK(!brief::layoutSupported(three, 3));
		CHECK(!brief::layoutSupported(threeOk, 3));
		CHECK(!brief::layoutSupported(ok1, 1));
		CHECK(!brief::layoutSupported(ok1, 0));
		CHECK(!brief::layoutSupported(nullptr, 2));
	}

	{   // a flag's glow
		CHECK(brief::teamOfColor(125, 165, 210) == 1);        // blue, the first team
		CHECK(brief::teamOfColor(200, 90, 70) == 2);          // red
		CHECK(brief::teamOfColor(225, 205, 45) == 0);         // yellow, a third team
		CHECK(brief::teamOfColor(145, 215, 140) == 0);        // green, neutral
		CHECK(brief::teamOfColor(0, 0, 0) == 0);
		CHECK(brief::teamOfColor(40, 120, 255) == 0);         // the Recon's cloak is no flag
	}

	{   // how near a carrier stands to the middle of the brush
		CHECK(brief::padReach(8.0f, 8.0f) == brief::PAD_REACH_LEAST);
		CHECK(brief::padReach(64.0f, 200.0f) == 32.0f);       // half the smaller half-extent
		CHECK(brief::padReach(500.0f, 500.0f) == brief::PAD_REACH_MOST);
		CHECK(brief::padReach(0.0f, 0.0f) == brief::PAD_REACH_LEAST);
	}

	{   // a flag at its base
		CHECK(brief::atBase(0.0f, 0.0f, 0.0f, 0.0f, 64.0f, 64.0f));
		CHECK(brief::atBase(100.0f, -100.0f, 0.0f, 0.0f, 64.0f, 64.0f));   // within the box and the margin (64 + 48)
		CHECK(!brief::atBase(120.0f, 0.0f, 0.0f, 0.0f, 64.0f, 64.0f));
		CHECK(!brief::atBase(0.0f, 500.0f, 0.0f, 0.0f, 64.0f, 64.0f));
	}

	{   // the speed that tells a bot too heavy to carry: against the game's own formula, for every number of free slots
		for (int free = 0; free <= 85; free++)
			CHECK(brief::canTakeFlag(gameSpeed(free)) == (free >= 20));

		CHECK(brief::canTakeFlag(330.0f));
		CHECK(!brief::canTakeFlag(210.0f));
		CHECK(!brief::canTakeFlag(238.0f));
		CHECK(brief::canTakeFlag(239.0f));
		CHECK(brief::canTakeFlag(0.0f));                      // not set yet
		CHECK(brief::canTakeFlag(120.0f));                    // a slow or a freeze, not an inventory's
	}
}

// ---------------------------------------------------------------------------------------------------------------------
static brief::FlagSeen seen(bool present, bool atBase = false, bool carrierOk = false)
{
	brief::FlagSeen s;

	s.present = present;
	s.atBase = atBase;
	s.carrierOk = carrierOk;
	return s;
}

static void flagNowCases()
{
	brief::Tracker t;

	{   // messages seen: HOME
		brief::FlagRec r;

		r.seen = true;
		r.state = ST_HOME;

		brief::FlagNow n = brief::flagNow(r, seen(true, true), 10.0f, 1, t);
		CHECK(n.valid && n.state == ST_HOME && n.onEntity);

		n = brief::flagNow(r, seen(false), 10.0f, 1, t);                       // between a capture or a return and the base seeding it
		CHECK(n.valid && n.state == ST_HOME && !n.onEntity);
	}

	{   // messages seen: carried
		brief::FlagRec r;

		r.seen = true;
		r.state = ST_CARRIED;
		r.carrier = 7;

		brief::FlagNow n = brief::flagNow(r, seen(false, false, true), 10.0f, 1, t);
		CHECK(n.valid && n.state == ST_CARRIED && n.carrier == 7 && !n.onEntity);

		n = brief::flagNow(r, seen(false, false, false), 10.0f, 1, t);         // the carrier is gone and nothing lies loose: unknown
		CHECK(!n.valid);

		n = brief::flagNow(r, seen(true, false, true), 10.0f, 1, t);           // a loose flag is not carried, whatever the messages said
		CHECK(n.valid && n.state == ST_DROPPED && n.onEntity);

		n = brief::flagNow(r, seen(true, true, true), 10.0f, 1, t);
		CHECK(n.valid && n.state == ST_HOME && n.onEntity);
	}

	{   // messages seen: dropped
		brief::Tracker tr;

		tr.onFlag(brief::A_DROP, 4, 2, 9, 100.0f);

		brief::FlagNow n = brief::flagNow(tr.flag[2], seen(true, false), 105.0f, 2, tr);
		CHECK(n.valid && n.state == ST_DROPPED && n.onEntity && std::fabs(n.left - 15.0f) < 1e-4f);

		n = brief::flagNow(tr.flag[2], seen(true, true), 105.0f, 2, tr);       // dropped where the base is: still dropped
		CHECK(n.state == ST_DROPPED);

		n = brief::flagNow(tr.flag[2], seen(false), 125.0f, 2, tr);            // expired: on its way home
		CHECK(n.valid && n.state == ST_HOME && !n.onEntity);
	}

	{   // no message yet (rcbot came after the map began): the entities alone
		brief::FlagRec r;

		brief::FlagNow n = brief::flagNow(r, seen(true, true), 10.0f, 1, t);
		CHECK(n.valid && n.state == ST_HOME && n.onEntity);

		n = brief::flagNow(r, seen(true, false), 10.0f, 1, t);
		CHECK(n.valid && n.state == ST_DROPPED && n.onEntity && n.left == -1.0f);

		n = brief::flagNow(r, seen(false), 10.0f, 1, t);                       // carried by someone, or not seeded: nothing to say
		CHECK(!n.valid);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The rows the game's state makes, as bot.cpp (ObjAddBriefFlag) makes them. Two bases 4000 apart, like ctb_deadheat's: team 1
// at x -2000, team 2 at x +2000, a loose flag lying at its base unless said otherwise.
static const float BASE_X[3] = { 0.0f, -2000.0f, 2000.0f };

struct World
{
	brief::Tracker t;
	float now = 100.0f;
	bool present[3] = { false, true, true };     // a ts_flag of the team's colour is in the world
	float lx[3] = { 0.0f, -2000.0f, 2000.0f };   // where it lies
	float cx[3] = { 0.0f, 0.0f, 0.0f };          // where its carrier is
	bool carrierOk[3] = { false, false, false };

	World()
	{
		t.onFlag(brief::A_BASE, 1, 1, 0, 1.0f);
		t.onFlag(brief::A_BASE, 2, 2, 0, 1.0f);
	}

	std::vector<Obj> rows() const
	{
		std::vector<Obj> v;

		for (int team = 1; team <= 2; team++)
		{
			brief::FlagSeen s;

			s.present = present[team];
			s.atBase = present[team] && brief::atBase(lx[team], 0.0f, BASE_X[team], 0.0f, 64.0f, 64.0f);
			s.carrierOk = carrierOk[team];

			const brief::FlagNow n = brief::flagNow(t.flag[team], s, now, team, t);

			if (!n.valid)
				continue;

			Obj o;

			o.id = oid(K_FLAG, team);
			o.kind = K_FLAG;
			o.number = team;
			o.owner = team;
			o.radius = 192.0f;
			o.reach = 72.0f;
			o.state = n.state;
			o.left = n.left;
			o.padX = BASE_X[team];
			o.padReach = brief::padReach(64.0f, 64.0f);
			o.x = n.state == ST_CARRIED ? cx[team] : (n.onEntity ? lx[team] : BASE_X[team]);

			if (n.state == ST_CARRIED)
			{
				o.carrierSlot = n.carrier;
				o.carrierSide = 3 - team;
			}

			o.pathable = n.state == ST_CARRIED || n.onEntity;
			v.push_back(o);
		}

		return v;
	}
};

static std::vector<Bot> sideOf(int team, int n, int first)
{
	std::vector<Bot> v;

	for (int i = 0; i < n; i++)
	{
		Bot b;

		b.slot = first + i;
		b.side = team;
		b.x = BASE_X[team] + (team == 1 ? 150.0f : -150.0f) * static_cast<float>(i + 1);
		v.push_back(b);
	}

	return v;
}

static std::vector<Bot> both(int perSide)
{
	std::vector<Bot> a = sideOf(1, perSide, 1);
	const std::vector<Bot> b = sideOf(2, perSide, 1 + perSide);

	a.insert(a.end(), b.begin(), b.end());
	return a;
}

static std::vector<Assign> run(const World& w, const std::vector<Bot>& bots, const Params& p = Params())
{
	const std::vector<Obj> rows = w.rows();
	std::vector<Assign> out(bots.size());

	plan(MODE_CTF, rows.data(), static_cast<int>(rows.size()), bots.data(), static_cast<int>(bots.size()), p, out.data());
	return out;
}

// how many bots of a side have a role
static int sideRole(const std::vector<Assign>& out, const std::vector<Bot>& bots, int sideNo, Role r)
{
	int n = 0;

	for (size_t i = 0; i < bots.size(); i++)
	{
		if (bots[i].side == sideNo && out[i].role == r)
			n++;
	}

	return n;
}

static void padCases()
{
	// the carrier of team 2's flag is of team 1 and turns it in at team 1's pad, whichever pad each flag publishes
	World w;

	w.t.onFlag(brief::A_PICKUP, 2, 2, 3, 120.0f);
	w.carrierOk[2] = true;
	w.present[2] = false;
	w.cx[2] = -1000.0f;

	const std::vector<Obj> rows = w.rows();

	CHECK(rows.size() == 2);

	const Obj* carried = nullptr;

	for (const Obj& o : rows)
	{
		if (o.id == oid(K_FLAG, 2))
			carried = &o;
	}

	CHECK(carried != nullptr && carried->state == ST_CARRIED && carried->carrierSide == 1);

	const Obj* pad = padFor(rows.data(), static_cast<int>(rows.size()), *carried);

	CHECK(pad != nullptr && pad->owner == 1 && pad->padX == BASE_X[1]);   // not the pad the flag came from

	// the same for H9's rows, where a flag publishes its own pad (tsm_flag vuser1)
	Obj a;
	Obj b;

	a.kind = K_FLAG; a.owner = 1; a.padX = -100.0f; a.id = oid(K_FLAG, 1);
	b.kind = K_FLAG; b.owner = 2; b.padX = 100.0f; b.id = oid(K_FLAG, 2);
	b.state = ST_CARRIED; b.carrierSlot = 4; b.carrierSide = 1;

	const Obj h9[] = { b, a };

	pad = padFor(h9, 2, h9[0]);
	CHECK(pad != nullptr && pad->padX == -100.0f);

	// and for the other side's carrier
	Obj c = a;

	c.state = ST_CARRIED; c.carrierSlot = 9; c.carrierSide = 2;

	const Obj h9b[] = { a, c, b };

	pad = padFor(h9b, 3, h9b[1]);
	CHECK(pad != nullptr && pad->padX == 100.0f);

	// no pad to give
	Obj none = b;

	none.carrierSide = 0;
	CHECK(padFor(h9, 2, none) == nullptr);

	const Obj only[] = { b };

	CHECK(padFor(only, 1, only[0]) == nullptr);              // the carrier's side has no flag among the objectives

	Obj ring;

	ring.kind = K_ZONE;
	ring.carrierSide = 1;
	CHECK(padFor(h9, 2, ring) == nullptr);                   // the uplink and the rings have no pad of the kind
}

static void scenarioCases()
{
	{   // both flags at their bases: each side fetches the other's and guards its own
		World w;
		const std::vector<Bot> bots = both(8);
		const std::vector<Assign> out = run(w, bots);

		for (int s = 1; s <= 2; s++)
		{
			CHECK(sideRole(out, bots, s, R_FETCH) == 2);
			CHECK(sideRole(out, bots, s, R_GUARD) == 2);
			CHECK(sideRole(out, bots, s, R_NONE) == 4);      // a quarter free, and the bots no post needs
		}

		for (size_t i = 0; i < bots.size(); i++)
		{
			if (out[i].role == R_FETCH)
				CHECK(out[i].obj == oid(K_FLAG, 3 - bots[i].side));
			if (out[i].role == R_GUARD)
				CHECK(out[i].obj == oid(K_FLAG, bots[i].side));
		}
	}

	{   // the restraint: a quarter of a side is left to fight, none of a small one
		World w;
		const std::vector<Bot> bots = both(3);
		const std::vector<Assign> out = run(w, bots);

		CHECK(countRole(out, R_FETCH) + countRole(out, R_GUARD) == 6);
	}

	{   // a team-1 bot carries team 2's flag: its side escorts, team 2 hunts it and still fetches the flag it has not lost
		World w;
		std::vector<Bot> bots = both(8);

		w.t.onFlag(brief::A_PICKUP, 2, 2, 3, 120.0f);
		w.carrierOk[2] = true;
		w.present[2] = false;
		w.cx[2] = -1000.0f;
		bots[2].carryingObj = oid(K_FLAG, 2);                // slot 3 is the team 1 bot that took it

		Params p;

		p.maxNew = 99;                                       // all of it at once: at most four bots of a side change post in a plan

		const std::vector<Assign> out = run(w, bots, p);

		CHECK(out[2].role == R_CARRY && out[2].obj == oid(K_FLAG, 2));
		CHECK(sideRole(out, bots, 1, R_ESCORT) == 2);
		CHECK(sideRole(out, bots, 1, R_CARRY) == 1);
		CHECK(sideRole(out, bots, 2, R_HUNT) == 3);
		CHECK(sideRole(out, bots, 2, R_FETCH) == 2);         // team 1's flag is still at its base
		CHECK(sideRole(out, bots, 1, R_GUARD) == 2);
	}

	{   // a person carries it: the bots of his side escort him all the same
		World w;
		const std::vector<Bot> bots = both(8);

		w.t.onFlag(brief::A_PICKUP, 2, 2, 20, 120.0f);       // slot 20 is nobody the bots know: a player
		w.carrierOk[2] = true;
		w.present[2] = false;
		w.cx[2] = -900.0f;

		const std::vector<Assign> out = run(w, bots);

		CHECK(sideRole(out, bots, 1, R_ESCORT) == 2);
		CHECK(sideRole(out, bots, 2, R_HUNT) == 3);
	}

	{   // a dropped flag of the bots' own side is returned by one of them
		World w;
		const std::vector<Bot> bots = both(8);

		w.t.onFlag(brief::A_DROP, 1, 1, 12, 110.0f);         // team 1's flag, dropped by its enemy carrier
		w.present[1] = true;
		w.lx[1] = 500.0f;
		w.now = 112.0f;

		const std::vector<Assign> out = run(w, bots);

		CHECK(sideRole(out, bots, 1, R_RETURN) == 1);
		CHECK(sideRole(out, bots, 1, R_GUARD) == 0);         // nothing at the base to guard
		CHECK(sideRole(out, bots, 1, R_FETCH) == 2);         // and the other flag is still wanted
		CHECK(sideRole(out, bots, 2, R_FETCH) == 2);         // team 2 fetches team 1's flag where it lies
	}

	{   // a dropped flag that is about to go home is not worth a walk
		World w;
		const std::vector<Bot> bots = both(8);

		w.t.onFlag(brief::A_DROP, 1, 1, 12, 110.0f);
		w.present[1] = true;
		w.lx[1] = 500.0f;
		w.now = 128.0f;                                      // 2 seconds left of 20

		const std::vector<Assign> out = run(w, bots);

		CHECK(countRole(out, R_RETURN) == 0);
		CHECK(sideRole(out, bots, 2, R_FETCH) == 0);
	}

	{   // between a capture and the base seeding the flag again nothing lies to be walked onto: no post for it
		World w;
		const std::vector<Bot> bots = both(8);

		w.present[1] = false;                                // team 1's flag: the messages say home, no entity yet

		const std::vector<Assign> out = run(w, bots);

		CHECK(sideRole(out, bots, 1, R_GUARD) == 0);
		CHECK(sideRole(out, bots, 2, R_FETCH) == 0);
		CHECK(sideRole(out, bots, 1, R_FETCH) == 2);
		CHECK(sideRole(out, bots, 2, R_GUARD) == 2);
	}

	{   // a bot too heavy to take a flag is never sent for one, though it stands nearest
		World w;
		std::vector<Bot> bots = both(8);

		for (size_t i = 0; i < bots.size(); i++)
		{
			if (bots[i].side == 1)
				bots[i].x = 1900.0f - 50.0f * static_cast<float>(i);   // the last of team 1 stand next to team 2's flag
		}

		const std::vector<Assign> light = run(w, bots);

		std::vector<Bot> heavy = bots;

		for (size_t i = 0; i < heavy.size(); i++)
		{
			if (heavy[i].side == 1 && light[i].role == R_FETCH)
				heavy[i].canTake = false;
		}

		const std::vector<Assign> out = run(w, heavy);

		CHECK(sideRole(light, bots, 1, R_FETCH) == 2);
		CHECK(sideRole(out, heavy, 1, R_FETCH) == 2);

		for (size_t i = 0; i < heavy.size(); i++)
		{
			if (!heavy[i].canTake)
				CHECK(out[i].role != R_FETCH);
		}

		// a heavy bot may still return its own flag: only the taking is out
		World d;

		d.t.onFlag(brief::A_DROP, 1, 1, 12, 110.0f);
		d.lx[1] = -1900.0f;
		d.now = 112.0f;

		std::vector<Bot> allHeavy = both(8);

		for (Bot& b : allHeavy)
			b.canTake = false;

		const std::vector<Assign> o2 = run(d, allHeavy);

		CHECK(countRole(o2, R_FETCH) == 0);
		CHECK(sideRole(o2, allHeavy, 1, R_RETURN) == 1);
	}

	{   // a carrier in a fight keeps carrying
		World w;
		std::vector<Bot> bots = both(8);

		w.t.onFlag(brief::A_PICKUP, 2, 2, 5, 120.0f);
		w.carrierOk[2] = true;
		w.present[2] = false;
		w.cx[2] = -1500.0f;
		bots[4].carryingObj = oid(K_FLAG, 2);
		bots[4].busy = true;

		const std::vector<Assign> out = run(w, bots);

		CHECK(out[4].role == R_CARRY);
	}

	{   // the first plan of a map puts every bot on a post at once; later plans change at most maxNew a side
		World w;
		const std::vector<Bot> bots = both(16);
		Params p;

		p.maxNew = 99;

		const std::vector<Assign> first = run(w, bots, p);

		CHECK(sideRole(first, bots, 1, R_FETCH) + sideRole(first, bots, 1, R_GUARD) == 4);

		p.maxNew = 1;

		const std::vector<Assign> slow = run(w, bots, p);

		CHECK(sideRole(slow, bots, 1, R_FETCH) + sideRole(slow, bots, 1, R_GUARD) == 1);
	}
}

int main()
{
	trackerCases();
	ruleCases();
	flagNowCases();
	padCases();
	scenarioCases();

	std::printf("%d checks, %d failed\n", g_checks, g_fail);
	return g_fail == 0 ? 0 : 1;
}
