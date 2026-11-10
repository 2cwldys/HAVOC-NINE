// bot_briefcase.h -- what rcbot knows of TS's own capture game, the briefcase (rcbot-patch CHANGE 12).
//
// No plugin publishes anything on a ctb_ or ctf_ map: the game DLL keeps a flag's state in its own private members. What
// reaches a server-side bot is the user message TSFlag (a base flag spawned, a flag taken, a flag dropped, and who
// carries it), the ScoreInfo message that gives each player's team number, the key ownerteam that a map names a base's
// team with, and the entities: ts_briefcase (the base, a brush) and ts_flag (a flag while it lies loose). This file keeps
// the part of it that needs no engine: the state those messages add up to, and the rules that turn it and the entities
// into the rows objplan::plan (bot_objective.h) works on. It knows nothing of the engine, the HL SDK or CBot, so it can be
// tested on its own (rcbot-patch\test\test_bot_briefcase.cpp). bot.cpp reads the entities and fills the rows
// (STOCK CAPTURE GAME, over CBot::ObjSide).
//
// Teams are TS's team numbers: the index of a team in the map's team list, plus one, as the scoreboard, a base's
// ownerteam key and the TSFlag message count them. A map of two teams has the numbers 1 and 2, which are the sides
// objplan::plan takes.
#ifndef BOT_BRIEFCASE_H
#define BOT_BRIEFCASE_H

#include <algorithm>
#include <cmath>

#include "bot_objective.h"

namespace brief
{
	constexpr int MAX_SLOT = objplan::MAX_BOTS;       // an edict index of a player, 1 to MAX_SLOT
	constexpr int MAX_OWNER_KEYS = 32;                // entities that named an ownerteam on this map
	constexpr float FLAG_EXPIRY = 20.0f;              // a dropped flag goes home this long after it was dropped (CTSFlag::Spawn)
	constexpr float SLOT_SPEED_FREE20 = 239.0f;       // the speed 20 free inventory slots give (GetSpeedBySlots)
	constexpr float SLOT_SPEED_LEAST = 200.0f;        // below this a bot's speed is no inventory's: a freeze, a slow
	constexpr float PAD_REACH_LEAST = 16.0f;          // a carrier stands this near the middle of a base, at least
	constexpr float PAD_REACH_MOST = 72.0f;           // and at most
	constexpr float AT_BASE_MARGIN = 48.0f;           // a flag this far outside a base's box still lies at the base

	// The user message TSFlag: its first byte.
	enum Action : int { A_BASE = 0, A_PICKUP = 1, A_DROP = 2 };

	// One team's flag as the TSFlag messages have it.
	struct FlagRec
	{
		bool seen = false;        // a TSFlag message has named it since the map began
		int state = objplan::ST_HOME;
		int flagId = 0;
		int carrier = 0;          // ST_CARRIED: the carrier's edict index
		float since = 0.0f;       // when it last changed hands
	};

	struct Tracker
	{
		int teamOf[MAX_SLOT + 1] = {};                  // a player's team number, 0 not known; by edict index
		int keyEdict[MAX_OWNER_KEYS] = {};              // the ownerteam keys of the map: the entity, and its value
		int keyTeam[MAX_OWNER_KEYS] = {};
		int nKeys = 0;
		FlagRec flag[3];                                // by team number

		// the bases, found once a map
		float nextScan = 0.0f;
		bool layoutOk = false;
		bool layoutLogged = false;
		float baseX[3] = {}, baseY[3] = {}, baseZ[3] = {};  // the middle of the box, and the floor under it
		float baseHalfX[3] = {}, baseHalfY[3] = {};

		// the log lines of what the messages said, the first of them on a map that has briefcases: how the server owner sees that the
		// messages arrive
		int logLeft = 40;
		bool heavyLogged[3] = {};   // a side's bots too heavy to take a flag, said once a map

		void resetMap()
		{
			*this = Tracker();
		}

		// the key ownerteam of an entity as the map names it: 1 and 2 the teams, 0 neutral
		void onOwnerKey(const int edict, const int team)
		{
			for (int i = 0; i < nKeys; i++)
			{
				if (keyEdict[i] == edict)
				{
					keyTeam[i] = team;
					return;
				}
			}

			if (nKeys < MAX_OWNER_KEYS)
			{
				keyEdict[nKeys] = edict;
				keyTeam[nKeys] = team;
				nKeys++;
			}
		}

		// -1 when the map named none
		int ownerOf(const int edict) const
		{
			for (int i = 0; i < nKeys; i++)
			{
				if (keyEdict[i] == edict)
					return keyTeam[i];
			}

			return -1;
		}

		// ScoreInfo: the team number of a player
		void onScore(const int slot, const int teamNumber)
		{
			if (slot >= 1 && slot <= MAX_SLOT)
				teamOf[slot] = teamNumber;
		}

		void forgetSlot(const int slot)
		{
			if (slot >= 1 && slot <= MAX_SLOT)
				teamOf[slot] = 0;
		}

		bool takeLog()
		{
			if (nKeys == 0 || logLeft <= 0)
				return false;

			logLeft--;
			return true;
		}

		// 1 or 2, 0 when he is on neither (not known, a spectator, a third team)
		int sideOf(const int slot) const
		{
			if (slot < 1 || slot > MAX_SLOT)
				return 0;

			return (teamOf[slot] == 1 || teamOf[slot] == 2) ? teamOf[slot] : 0;
		}

		// TSFlag: what happened to a team's flag. teamPlus1 is the flag's team number; the carrier's edict index comes
		// with a pickup and a drop. A capture and a return send no message of their own: the base seeds the flag again
		// and that says A_BASE.
		void onFlag(const int action, const int flagId, const int teamPlus1, const int carrier, const float now)
		{
			if (teamPlus1 != 1 && teamPlus1 != 2)
				return;

			FlagRec& f = flag[teamPlus1];

			f.seen = true;
			f.flagId = flagId;
			f.since = now;

			switch (action)
			{
			case A_BASE:
				f.state = objplan::ST_HOME;
				f.carrier = 0;
				break;
			case A_PICKUP:
				f.state = objplan::ST_CARRIED;
				f.carrier = carrier;
				break;
			case A_DROP:
				f.state = objplan::ST_DROPPED;
				f.carrier = 0;
				break;
			default:
				break;
			}
		}

		// The seconds before a team's dropped flag goes home, -1 when it is not dropped
		float left(const int team, const float now) const
		{
			if ((team != 1 && team != 2) || !flag[team].seen || flag[team].state != objplan::ST_DROPPED)
				return -1.0f;

			return std::max(0.0f, FLAG_EXPIRY - (now - flag[team].since));
		}
	};

	inline Tracker g_Brief;

	// A team's number by the glow colour of its loose flag (CTSFlag::Spawn: blue for the first team, red for the second).
	// 0 for any other colour.
	inline int teamOfColor(const float r, const float g, const float b)
	{
		auto same = [](const float a, const float c) { return std::fabs(a - c) < 2.0f; };

		if (same(r, 125.0f) && same(g, 165.0f) && same(b, 210.0f))
			return 1;
		if (same(r, 200.0f) && same(g, 90.0f) && same(b, 70.0f))
			return 2;

		return 0;
	}

	// The map's bases: exactly two briefcases, one for team 1 and one for team 2. owners are the keys the map gave them (-1
	// none, 0 neutral). A neutral base, two for one team or a third team is a game the bots do not play.
	inline bool layoutSupported(const int* owners, const int n)
	{
		if (owners == nullptr || n != 2)
			return false;

		return (owners[0] == 1 && owners[1] == 2) || (owners[0] == 2 && owners[1] == 1);
	}

	// How near the middle of its base a carrier stands: inside the brush, which scores by touch.
	inline float padReach(const float halfX, const float halfY)
	{
		return std::max(PAD_REACH_LEAST, std::min(PAD_REACH_MOST, 0.5f * std::min(halfX, halfY)));
	}

	// Whether a flag lies at a base: across the floor within the box and a margin of it.
	inline bool atBase(const float fx, const float fy, const float bx, const float by, const float halfX, const float halfY)
	{
		return std::fabs(fx - bx) <= halfX + AT_BASE_MARGIN && std::fabs(fy - by) <= halfY + AT_BASE_MARGIN;
	}

	// A player takes a flag only with 20 free inventory slots (CBasePlayer::TakeFlag), and the game sets his speed by the
	// slots he has left: 210 + 120 * free / 81, cut to a whole number. 239 is 20 free slots. A speed under 200 is not an
	// inventory's (a freeze, a slow): nothing is known, and the bot may try.
	inline bool canTakeFlag(const float maxspeed)
	{
		return maxspeed < SLOT_SPEED_LEAST || maxspeed >= SLOT_SPEED_FREE20;
	}

	// What the entities say of one team's flag this second.
	struct FlagSeen
	{
		bool present = false;     // a ts_flag of its colour is in the world: the flag is loose
		bool atBase = false;      // and lies at its base
		bool carrierOk = false;   // the carrier the messages name is a living player
	};

	// A team's flag as a row of the plan: where it stands, who carries it, and whether anything can be walked onto.
	struct FlagNow
	{
		bool valid = false;
		int state = objplan::ST_HOME;
		int carrier = 0;
		float left = -1.0f;
		bool onEntity = false;    // loose, with an entity to walk to
	};

	// Puts the messages and the entities together. The entities win where they disagree (a loose flag is not carried).
	// A flag missing for a moment between a capture or a return and its base seeding it again is at its base but has nothing
	// to walk onto; one of which nothing is known is not a row.
	inline FlagNow flagNow(const FlagRec& r, const FlagSeen& e, const float now, const int team, const Tracker& t)
	{
		FlagNow n;

		if (r.seen)
		{
			if (e.present)
			{
				n.valid = true;
				n.onEntity = true;

				if (r.state == objplan::ST_DROPPED)
				{
					n.state = objplan::ST_DROPPED;
					n.left = t.left(team, now);
				}
				else if (r.state == objplan::ST_HOME)
					n.state = objplan::ST_HOME;
				else
					n.state = e.atBase ? objplan::ST_HOME : objplan::ST_DROPPED;
			}
			else if (r.state == objplan::ST_CARRIED)
			{
				if (e.carrierOk)
				{
					n.valid = true;
					n.state = objplan::ST_CARRIED;
					n.carrier = r.carrier;
				}
			}
			else
			{
				n.valid = true;
				n.state = objplan::ST_HOME;
			}

			return n;
		}

		if (e.present)
		{
			n.valid = true;
			n.onEntity = true;
			n.state = e.atBase ? objplan::ST_HOME : objplan::ST_DROPPED;
		}

		return n;
	}
}

#endif // BOT_BRIEFCASE_H
