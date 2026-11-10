// bot_objective.h -- the part of objective play (rcbot-patch CHANGE 11) that decides who goes where.
//
// A pure function: objectives, bots and settings go in, one post per bot comes out. It knows nothing of the
// engine, the HL SDK or CBot, it allocates nothing, and the same input gives the same answer whatever the
// order of the arrays, so it can be tested on its own (rcbot-patch\test\test_bot_objective.cpp). bot.cpp
// fills the arrays from what ts_assault, ts_uplink and ts_ctf publish on their entities (BOT OBJECTIVES,
// over CBot::ObjPlay), and from the briefcase game that TS itself plays on a ctb_ or ctf_ map (bot_briefcase.h;
// STOCK CAPTURE GAME, over CBot::ObjSide), and gives each bot the post that comes out.
//
// Sides are 1 and 2 (pev->team); 0 is nobody. A slot is the bot's edict index, which is also what the
// plugins publish for a carrier.
#ifndef BOT_OBJECTIVE_H
#define BOT_OBJECTIVE_H

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace objplan
{
	constexpr int MAX_BOTS = 128;     // a slot count, as MAX_PLAYERS in bot_const.h
	constexpr int MAX_DEMANDS = 96;   // posts one side asks for at once

	enum Mode : std::uint8_t { MODE_NONE = 0, MODE_ASSAULT, MODE_UPLINK, MODE_CTF };

	// The kinds of objective. A point is one of Assault's, a zone one of the Uplink's; the uplink and a flag
	// are carried things.
	enum Kind : std::uint8_t { K_NONE = 0, K_POINT, K_ZONE, K_UPLINK, K_FLAG };

	// What a bot does at its post.
	//   TAKE    stands in a point or a zone the other side holds or nobody does, until it is its own
	//   RETAKE  stands in a point of its side that the other side is wearing down
	//   HOLD    stands in a quiet point of its side that is near the front
	//   CLEAR   goes to the zone its side's carrier is heading for and kills whoever stands in it
	//   FETCH   walks onto the uplink, or the other side's flag, where it lies
	//   CARRY   carries what it has taken to a zone, or to its side's pad
	//   ESCORT  stays with its side's carrier
	//   HUNT    goes after the other side's carrier
	//   RETURN  walks onto its own side's dropped flag
	//   GUARD   stands near its own flag at its pad
	enum Role : std::uint8_t { R_NONE = 0, R_TAKE, R_RETAKE, R_HOLD, R_FETCH, R_CARRY, R_ESCORT, R_HUNT, R_RETURN, R_GUARD, R_CLEAR };

	// State of a point or a zone, as the plugins publish it (pev->iuser2).
	enum : int { ST_QUIET = 0, ST_TAKEN = 1, ST_CONTESTED = 2 };
	// State of the uplink or a flag: at its post or pad, carried, dropped where it lies.
	enum : int { ST_HOME = 0, ST_CARRIED = 1, ST_DROPPED = 2 };

	constexpr float OBJ_DZ_WEIGHT = 2.5f;           // a unit of height costs this many units of walking
	constexpr float OBJ_PRIO_UNITS = 1200.0f;       // one point of priority is worth this much walking
	constexpr float OBJ_STAY_BONUS = 900.0f;        // a bot keeps its post unless another is this much better
	constexpr int OBJ_DEFAULT_PER_OBJ = 4;          // most bots on one point or zone
	constexpr int OBJ_DEFAULT_FREE_PCT = 25;        // percent of a side's bots left to fight and roam as before
	constexpr int OBJ_DEFAULT_MAX_NEW = 4;          // bots of a side that may take a new post in one plan
	constexpr float OBJ_ZONE_ENEMY_COST = 1500.0f;  // a zone costs a carrier this much more for each enemy in it
	constexpr float OBJ_ZONE_CONTEST_COST = 400.0f; // and this much while the plugin says the carrier is denied there
	constexpr float OBJ_ZONE_SWITCH_MARGIN = 400.0f;// a carrier changes its zone only for one this much better
	constexpr float OBJ_FINISHING_LEFT = 0.25f;     // a point that is this near taken needs no more bots
	constexpr float OBJ_FLIES_HOME_SOON = 3.0f;     // a dropped item that flies home this soon is not worth the walk

	struct Obj
	{
		int id = 0;               // kind * 256 + number; the same objective keeps its id when its entity is made again
		Kind kind = K_NONE;
		int number = 0;           // a point's or a zone's number; the side whose flag it is; 1 for the uplink
		int owner = 0;            // point or zone: 0, 1, 2. A flag: the side whose flag it is. The uplink: 0
		float x = 0.0f, y = 0.0f, z = 0.0f;   // a ring: its floor point. A carried thing: its origin
		float radius = 0.0f;      // a ring: how far across the floor counts as in it. A flag: how near a guard stands
		float reach = 128.0f;     // a ring: how far above or below its floor still counts
		int state = 0;            // ST_QUIET.. for a point or a zone, ST_HOME.. for the uplink and a flag
		int taker = 0;            // point or zone, ST_TAKEN: the side taking it
		float progress = 0.0f;    // point: -1 to +1, side 1 holding it in full at +1. Zone: the carrier's hold, 0 to 1
		int nIn[3] = { 0, 0, 0 }; // players inside a ring, by side (index 1 and 2)
		int carrierSlot = 0;      // uplink or flag, ST_CARRIED: who carries it, and for which side
		int carrierSide = 0;
		float left = -1.0f;       // uplink or flag, ST_DROPPED: seconds before it flies home, -1 for none
		float padX = 0.0f, padY = 0.0f, padZ = 0.0f;   // a flag: its pad
		float padReach = 0.0f;    // a flag: how near its pad counts as at it, 0 for the setting's (tsm_cf_pad_radius)
		bool scoreReady = false;  // a flag, ST_CARRIED: its carrier would score at his pad now
		bool pathable = true;     // a waypoint leads to it
	};

	struct Bot
	{
		int slot = 0;
		int side = 0;
		float x = 0.0f, y = 0.0f, z = 0.0f;
		bool planOk = true;       // alive, started, no roamer, in no squad
		bool busy = false;        // has an enemy: keeps what it has and is given nothing new
		bool canTake = true;      // may be sent to take a flag: TS lets a player take one only with free inventory slots
		int curObj = 0;           // the post it has: objective id, role, and the zone a carrier goes for
		Role curRole = R_NONE;
		int curTarget = 0;
		int carryingObj = 0;      // id of the uplink or flag it carries, else 0
	};

	struct Blocked { int slot; int obj; };   // a bot that gave an objective up: not sent there again for a while

	struct Params
	{
		int freePct = OBJ_DEFAULT_FREE_PCT;
		int perObj = OBJ_DEFAULT_PER_OBJ;
		int maxNew = OBJ_DEFAULT_MAX_NEW;
		std::uint32_t seed = 0;
		const Blocked* blocked = nullptr;
		int nBlocked = 0;
	};

	struct Assign
	{
		int obj = 0;              // the objective id, 0 for none
		Role role = R_NONE;
		int target = 0;           // CARRY: the zone the carrier goes for
		bool later = false;       // wanted a post but the change limit held it back: wait a moment, do not roam
	};

	inline float flatDist(const float ax, const float ay, const float bx, const float by)
	{
		const float dx = ax - bx;
		const float dy = ay - by;
		return std::sqrt(dx * dx + dy * dy);
	}

	// The walk from a bot to an objective: across the floor, with height counted dearer.
	inline float walkTo(const Bot& b, const Obj& o)
	{
		return flatDist(b.x, b.y, o.x, o.y) + OBJ_DZ_WEIGHT * std::fabs(b.z - o.z);
	}

	inline std::uint32_t hashSlot(const int slot, const std::uint32_t seed)
	{
		std::uint32_t h = static_cast<std::uint32_t>(slot) * 2654435761u + seed * 40503u + 12345u;
		h ^= h >> 15;
		h *= 2246822519u;
		h ^= h >> 13;
		return h;
	}

	inline bool isRing(const Obj& o)
	{
		return o.kind == K_POINT || o.kind == K_ZONE;
	}

	inline bool isCarriable(const Obj& o)
	{
		return o.kind == K_UPLINK || o.kind == K_FLAG;
	}

	// A dropped thing that is about to fly home: nobody need walk to it.
	inline bool leavingSoon(const Obj& o)
	{
		return o.state == ST_DROPPED && o.left >= 0.0f && o.left < OBJ_FLIES_HOME_SOON;
	}

	// Whether the other side is at a point of this side's: a player of it inside, or its hold wearing the point down.
	inline bool underAttack(const Obj& o, const int side)
	{
		return o.nIn[3 - side] > 0 || (o.state == ST_TAKEN && o.taker == 3 - side);
	}

	// Whether a role at an objective still makes sense for a bot of this side. The planner carries a post over by it, and
	// each bot's own upkeep drops a post by it.
	inline bool roleValid(const Obj* o, const Role role, const int side, const int slot)
	{
		if (o == nullptr)
			return false;

		const int other = 3 - side;

		switch (role)
		{
		case R_TAKE:
			return isRing(*o) && o->pathable && o->owner != side;
		case R_CLEAR:
			return isRing(*o) && o->pathable;
		case R_RETAKE:
			return o->kind == K_POINT && o->pathable && o->owner == side && underAttack(*o, side);
		case R_HOLD:
			return isRing(*o) && o->pathable && o->owner == side;
		case R_FETCH:
			if (o->kind == K_UPLINK)
				return o->state != ST_CARRIED && o->pathable && !leavingSoon(*o);
			if (o->kind == K_FLAG)
				return o->owner != side && o->state != ST_CARRIED && o->pathable && !leavingSoon(*o);
			return false;
		case R_CARRY:
			return isCarriable(*o) && o->state == ST_CARRIED && o->carrierSlot == slot;
		case R_ESCORT:
			return isCarriable(*o) && o->state == ST_CARRIED && o->carrierSide == side && o->carrierSlot != slot;
		case R_HUNT:
			if (o->kind == K_UPLINK)
				return o->state == ST_CARRIED && o->carrierSide == other;
			if (o->kind == K_FLAG)
				return o->owner == side && o->state == ST_CARRIED && o->carrierSide == other;
			return false;
		case R_RETURN:
			return o->kind == K_FLAG && o->owner == side && o->state == ST_DROPPED && o->pathable && !leavingSoon(*o);
		case R_GUARD:
			return o->kind == K_FLAG && o->owner == side && o->state == ST_HOME && o->pathable;
		default:
			return false;
		}
	}

	// What an uplink carrier goes for: the zone its side does not hold that costs least (the walk, a fixed cost for each enemy
	// inside, more while the plugin says the carrier is denied there), kept unless another is clearly better. Returns an
	// objective id, 0 for none left.
	inline int chooseTarget(const Bot& carrier, const Obj* objs, const int nObjs, const int side, const int prevTarget)
	{
		const int other = 3 - side;
		int best = 0;
		float bestCost = 1e18f;
		float prevCost = -1.0f;

		for (int i = 0; i < nObjs; i++)
		{
			const Obj& z = objs[i];

			if (z.kind != K_ZONE || z.owner == side || !z.pathable)
				continue;

			const float cost = walkTo(carrier, z) + OBJ_ZONE_ENEMY_COST * static_cast<float>(z.nIn[other]) +
				(z.state == ST_CONTESTED ? OBJ_ZONE_CONTEST_COST : 0.0f);

			if (z.id == prevTarget)
				prevCost = cost;

			if (cost < bestCost || (cost == bestCost && z.id < best))
			{
				best = z.id;
				bestCost = cost;
			}
		}

		if (prevCost >= 0.0f && prevCost <= bestCost + OBJ_ZONE_SWITCH_MARGIN)
			return prevTarget;

		return best;
	}

	// How many bots of a side stand in a ring (the plugin's own test: across the floor within the radius, and within
	// reach above or below the floor point).
	inline int botsInside(const Obj& o, const Bot* bots, const int nBots, const int side)
	{
		int n = 0;

		for (int i = 0; i < nBots; i++)
		{
			if (bots[i].side != side)
				continue;

			if (flatDist(bots[i].x, bots[i].y, o.x, o.y) > o.radius)
				continue;

			const float dz = bots[i].z - o.z;

			if (dz < -o.reach || dz > o.reach)
				continue;

			n++;
		}

		return n;
	}

	struct Demand
	{
		const Obj* obj;
		Role role;
		int want;
		float prio;
	};

	inline void addDemand(Demand* d, int& n, const Obj& o, const Role role, const int want, const float prio)
	{
		if (n >= MAX_DEMANDS || want < 1)
			return;

		d[n].obj = &o;
		d[n].role = role;
		d[n].want = want;
		d[n].prio = prio;
		n++;
	}

	inline const Obj* findKind(const Obj* objs, const int nObjs, const Kind kind, const int owner)
	{
		for (int i = 0; i < nObjs; i++)
		{
			if (objs[i].kind == kind && (owner == 0 || objs[i].owner == owner))
				return &objs[i];
		}

		return nullptr;
	}

	// Where the carrier of a flag turns it in: the pad of the flag that the carrier's side owns (the flag carried is the other
	// side's). nullptr when the side has no flag among the objectives, or the objective is no flag.
	inline const Obj* padFor(const Obj* objs, const int nObjs, const Obj& carried)
	{
		if (carried.kind != K_FLAG || (carried.carrierSide != 1 && carried.carrierSide != 2))
			return nullptr;

		return findKind(objs, nObjs, K_FLAG, carried.carrierSide);
	}

	inline int assaultDemands(Demand* d, const int side, const Obj* objs, const int nObjs, const Bot* bots, const int nBots)
	{
		int n = 0;
		const int other = 3 - side;
		const Obj* quiet[64];
		int nQuiet = 0;
		int nHeld = 0;
		int nOpen = 0;

		for (int i = 0; i < nObjs; i++)
		{
			const Obj& o = objs[i];

			if (o.kind != K_POINT || !o.pathable)
				continue;

			if (o.owner == side)
				nHeld++;
			else
				nOpen++;
		}

		for (int i = 0; i < nObjs; i++)
		{
			const Obj& o = objs[i];

			if (o.kind != K_POINT || !o.pathable)
				continue;

			// my side's hold on it: +1 in full, 0 neutral, -1 the other side's in full
			const float q = o.progress * (side == 1 ? 1.0f : -1.0f);
			const int mineIn = botsInside(o, bots, nBots, side);
			const int others = std::max(0, o.nIn[side] - mineIn);   // players of this side in it that are no bot of the plan
			const bool enemyIn = o.nIn[other] > 0;

			if (o.owner != side)
			{
				// worn down to neutral first and built up after, so the other side's point asks for one more
				int base = (o.owner == other) ? 3 : 2;

				if (enemyIn)
					base++;

				float prio = 1.0f;

				if (o.owner == other)
					prio += 0.3f;
				if (o.state == ST_CONTESTED)
					prio += 0.5f;
				if (q > 0.3f)
					prio += 0.4f;

				int want = std::max(1, base - others);

				// nearly taken with nobody against it: the bots there stay, no more come
				if (o.state == ST_TAKEN && o.taker == side && !enemyIn && (1.0f - q) <= OBJ_FINISHING_LEFT)
					want = std::max(1, mineIn);

				addDemand(d, n, o, R_TAKE, want, prio);
			}
			else if (underAttack(o, side))
			{
				// the further the other side has worn it down, the sooner
				const float wear = std::max(0.0f, std::min(1.0f, 1.0f - q));
				const int base = o.nIn[other] >= 3 ? 3 : 2;

				addDemand(d, n, o, R_RETAKE, std::max(1, base - others), 2.0f + wear);
			}
			else if (nQuiet < 64)
			{
				quiet[nQuiet++] = &o;
			}
		}

		// a quiet point of the side's is guarded only at the front: the ones nearest a point not held yet
		if (nQuiet > 0 && nOpen > 0)
		{
			float nearest[64];

			for (int k = 0; k < nQuiet; k++)
			{
				nearest[k] = 1e18f;

				for (int i = 0; i < nObjs; i++)
				{
					const Obj& o = objs[i];

					if (o.kind == K_POINT && o.pathable && o.owner != side)
						nearest[k] = std::min(nearest[k], flatDist(o.x, o.y, quiet[k]->x, quiet[k]->y));
				}
			}

			// the nearest first; a tie goes to the lower id
			int order[64];

			for (int k = 0; k < nQuiet; k++)
				order[k] = k;

			std::sort(order, order + nQuiet, [&](const int a, const int b)
				{
					if (nearest[a] != nearest[b])
						return nearest[a] < nearest[b];

					return quiet[a]->id < quiet[b]->id;
				});

			const int guards = std::max(1, nHeld / 2);

			for (int k = 0; k < nQuiet && k < guards; k++)
				addDemand(d, n, *quiet[order[k]], R_HOLD, 1, 0.3f);
		}

		return n;
	}

	inline int uplinkDemands(Demand* d, const int side, const Obj* objs, const int nObjs, const Obj* carrierTarget)
	{
		int n = 0;
		const Obj* up = findKind(objs, nObjs, K_UPLINK, 0);

		if (up == nullptr)
			return 0;

		if (up->state != ST_CARRIED)
		{
			if (up->pathable && !leavingSoon(*up))
				addDemand(d, n, *up, R_FETCH, 2, 3.0f);
		}
		else if (up->carrierSide == side)
		{
			addDemand(d, n, *up, R_ESCORT, 3, 2.5f);

			if (carrierTarget != nullptr && carrierTarget->kind == K_ZONE)
				addDemand(d, n, *carrierTarget, R_CLEAR, 1, 1.5f);
		}
		else
		{
			addDemand(d, n, *up, R_HUNT, 3, 3.0f);
		}

		return n;
	}

	inline int flagDemands(Demand* d, const int side, const Obj* objs, const int nObjs)
	{
		int n = 0;
		const int other = 3 - side;
		const Obj* own = findKind(objs, nObjs, K_FLAG, side);
		const Obj* enemy = findKind(objs, nObjs, K_FLAG, other);

		if (enemy != nullptr)
		{
			if (enemy->state == ST_HOME && enemy->pathable)
				addDemand(d, n, *enemy, R_FETCH, 2, 2.0f);
			else if (enemy->state == ST_DROPPED && enemy->pathable && !leavingSoon(*enemy))
				addDemand(d, n, *enemy, R_FETCH, 2, 3.0f);
			else if (enemy->state == ST_CARRIED && enemy->carrierSide == side)
				addDemand(d, n, *enemy, R_ESCORT, 2, 2.5f);
		}

		if (own != nullptr)
		{
			if (own->state == ST_HOME && own->pathable)
				addDemand(d, n, *own, R_GUARD, 2, 1.5f);
			else if (own->state == ST_DROPPED && own->pathable && !leavingSoon(*own))
				addDemand(d, n, *own, R_RETURN, 1, 4.0f);
			else if (own->state == ST_CARRIED && own->carrierSide == other)
				addDemand(d, n, *own, R_HUNT, 3, 3.5f);
		}

		return n;
	}

	struct Pair
	{
		float cost;
		int slot;
		int bot;     // index into the bots array
		int demand;
	};

	// One post for each bot, in the order of the bots array. A bot without one (R_NONE) is left to the stock behaviour; with
	// `later` set it waits a moment first.
	//
	// Per side, the sides independent of each other:
	//   1. a carrier carries, never freed and never counted against the change limit
	//   2. a bot with an enemy keeps its post while it still makes sense, and is given nothing new
	//   3. a share of the side (freePct) is left to fight and roam as before, the same bots for a seed; a bot fetching or
	//      returning something is never one of them
	//   4. what the objectives ask for (assaultDemands, uplinkDemands, flagDemands), each with places and a priority
	//   5. the cheapest bot and post first (the walk less the priority, less a bonus for the post it has), while the post
	//      has places left; at most maxNew bots of the side take a post they did not have
	inline void plan(const Mode mode, const Obj* objs, const int nObjs, const Bot* bots, const int nBots, const Params& p, Assign* out)
	{
		for (int i = 0; i < nBots; i++)
			out[i] = Assign();

		if (mode == MODE_NONE || objs == nullptr || nObjs <= 0 || bots == nullptr || nBots <= 0 || nBots > MAX_BOTS)
			return;

		static Pair pairs[MAX_BOTS * MAX_DEMANDS];
		static Demand demands[MAX_DEMANDS];
		bool deferred[MAX_BOTS] = {};

		for (int side = 1; side <= 2; side++)
		{
			int changes = 0;
			int mine[MAX_BOTS];
			int nMine = 0;

			for (int i = 0; i < nBots; i++)
			{
				if (bots[i].side == side)
					mine[nMine++] = i;
			}

			if (nMine == 0)
				continue;

			std::sort(mine, mine + nMine, [&](const int a, const int b) { return bots[a].slot < bots[b].slot; });

			auto byId = [&](const int id) -> const Obj*
			{
				if (id == 0)
					return nullptr;

				for (int k = 0; k < nObjs; k++)
				{
					if (objs[k].id == id)
						return &objs[k];
				}

				return nullptr;
			};

			// 1. carriers
			const Obj* carrierTarget = nullptr;

			for (int k = 0; k < nMine; k++)
			{
				const int i = mine[k];
				const Obj* o = byId(bots[i].carryingObj);

				if (o != nullptr && o->state == ST_CARRIED && o->carrierSlot == bots[i].slot)
				{
					out[i].obj = o->id;
					out[i].role = R_CARRY;
					out[i].target = 0;

					if (o->kind == K_UPLINK)
					{
						out[i].target = chooseTarget(bots[i], objs, nObjs, side, bots[i].curTarget);
						carrierTarget = byId(out[i].target);
					}
				}
			}

			// 2. who can be given a post
			int cand[MAX_BOTS];
			int nCand = 0;

			for (int k = 0; k < nMine; k++)
			{
				const int i = mine[k];

				if (out[i].role != R_NONE || !bots[i].planOk)
					continue;

				if (bots[i].busy)
				{
					const Obj* cur = byId(bots[i].curObj);

					if (cur != nullptr && roleValid(cur, bots[i].curRole, side, bots[i].slot))
					{
						out[i].obj = cur->id;
						out[i].role = bots[i].curRole;
						out[i].target = 0;
					}

					continue;
				}

				cand[nCand++] = i;
			}

			// 3. the free share
			const int nFree = nMine * p.freePct / 100;
			bool isFree[MAX_BOTS] = {};
			int ranked[MAX_BOTS];

			for (int k = 0; k < nCand; k++)
				ranked[k] = cand[k];

			std::sort(ranked, ranked + nCand, [&](const int a, const int b)
				{
					const std::uint32_t ha = hashSlot(bots[a].slot, p.seed);
					const std::uint32_t hb = hashSlot(bots[b].slot, p.seed);

					if (ha != hb)
						return ha < hb;

					return bots[a].slot < bots[b].slot;
				});

			int freed = 0;

			for (int k = 0; k < nCand && freed < nFree; k++)
			{
				const int i = ranked[k];

				if ((bots[i].curRole == R_FETCH || bots[i].curRole == R_RETURN) && roleValid(byId(bots[i].curObj), bots[i].curRole, side, bots[i].slot))
					continue;

				isFree[i] = true;
				freed++;
			}

			// 4. what is asked for
			int nDemands = 0;

			switch (mode)
			{
			case MODE_ASSAULT:
				nDemands = assaultDemands(demands, side, objs, nObjs, bots, nBots);
				break;
			case MODE_UPLINK:
				nDemands = uplinkDemands(demands, side, objs, nObjs, carrierTarget);
				break;
			case MODE_CTF:
				nDemands = flagDemands(demands, side, objs, nObjs);
				break;
			default:
				break;
			}

			// 5. the cheapest first
			int nPairs = 0;

			for (int di = 0; di < nDemands; di++)
			{
				for (int k = 0; k < nCand; k++)
				{
					const int i = cand[k];

					if (isFree[i])
						continue;

					bool blocked = false;

					for (int b = 0; b < p.nBlocked; b++)
					{
						if (p.blocked[b].slot == bots[i].slot && p.blocked[b].obj == demands[di].obj->id)
							blocked = true;
					}

					if (blocked)
						continue;

					// a bot too heavy to carry a flag can stand on it all day
					if (demands[di].role == R_FETCH && demands[di].obj->kind == K_FLAG && !bots[i].canTake)
						continue;

					float cost = walkTo(bots[i], *demands[di].obj) - demands[di].prio * OBJ_PRIO_UNITS;

					if (bots[i].curObj == demands[di].obj->id && bots[i].curRole == demands[di].role)
						cost -= OBJ_STAY_BONUS;

					pairs[nPairs].cost = cost;
					pairs[nPairs].slot = bots[i].slot;
					pairs[nPairs].bot = i;
					pairs[nPairs].demand = di;
					nPairs++;
				}
			}

			std::sort(pairs, pairs + nPairs, [](const Pair& a, const Pair& b)
				{
					if (a.cost != b.cost)
						return a.cost < b.cost;
					if (a.slot != b.slot)
						return a.slot < b.slot;

					return a.demand < b.demand;
				});

			for (int pi = 0; pi < nPairs; pi++)
			{
				const int i = pairs[pi].bot;
				const Demand& dm = demands[pairs[pi].demand];

				if (out[i].role != R_NONE)
					continue;

				int onRole = 0;
				int onObj = 0;

				for (int k = 0; k < nMine; k++)
				{
					const Assign& a = out[mine[k]];

					if (a.obj == dm.obj->id)
					{
						onObj++;

						if (a.role == dm.role)
							onRole++;
					}
				}

				if (onRole >= dm.want)
					continue;

				if ((dm.role == R_TAKE || dm.role == R_RETAKE || dm.role == R_HOLD || dm.role == R_CLEAR) && onObj >= p.perObj)
					continue;

				if (!(bots[i].curObj == dm.obj->id && bots[i].curRole == dm.role))
				{
					if (changes >= p.maxNew)
					{
						deferred[i] = true;
						continue;
					}

					changes++;
				}

				out[i].obj = dm.obj->id;
				out[i].role = dm.role;
				out[i].target = 0;
			}
		}

		for (int i = 0; i < nBots; i++)
		{
			if (deferred[i] && out[i].role == R_NONE)
				out[i].later = true;
		}
	}
}

#endif // BOT_OBJECTIVE_H
