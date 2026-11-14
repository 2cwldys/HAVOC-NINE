/***
*  h9_rally_shop_srv.h -- rally mode's car choice, money and parts: the rules, with no engine call (H9). h9_rally_srv.cpp keeps one
*  RallyShop per player and calls this; rally_test.cpp and race_test.cpp drive it alone.
*
*  HL Rally's rules (read for behaviour only; the file and line of each is in the comment of the function that has it):
*    money   $600 at join, cap $7000, +20 at a checkpoint, 800/600/400/200 for places 1 to 4 and +600 for every finisher.
*    buy     the cost is taken when there is more than the cost (strictly), the part takes the place of the one held in its class
*            (no refund), and the stats it adds are the sum of the parts held.
*    change  a car change drops every part (the money stays).
*  The contract with the client is pm_shared/h9_rally_shop.h.
***/
#pragma once

#include "../pm_shared/h9_rally_shop.h"

#ifndef H9RALLY_MATHS_ONLY
#define H9RALLY_MATHS_ONLY
#endif
#include "../pm_shared/h9_rally.h" // H9R_NUM_CARS

// What the server keeps of one player.
struct RallyShop
{
	bool chosen = false;   // HL Rally's pev->fuser1 != 0: he has a car and races; false: he is not in the race
	int cls = 0;           // the car he chose, 1..H9R_NUM_CARS (0 until he does)
	int money = 0;
	unsigned parts = 0;    // bit p: part p is held
};

// Join (every map): nothing chosen, $600. HL Rally's ClientPutInServer: pl->ResetMoney (); pl->AddMoney (600);
// (S:dlls/multiplay_gamerules.cpp:530-538, where `pl->pev->fuser1 = 0.0f` also makes "sure they don't spawn till they pick a car")
static inline void RallyShopJoin(RallyShop& s)
{
	s.chosen = false;
	s.cls = 0;
	s.parts = 0;
	s.money = 0;
	s.money += H9R_MONEY_START;
}

// +amount, to the cap. HL Rally's AddMoney: `pev->vuser3[0] += amount; if (pev->vuser3[0] > MAX_AMOUNT) = MAX_AMOUNT`
// (S:dlls/player.cpp:316, 339-351). Returns whether the figure changed.
static inline bool RallyShopAdd(RallyShop& s, int amount)
{
	const int before = s.money;
	s.money += amount;
	if (s.money > H9R_MONEY_CAP)
		s.money = H9R_MONEY_CAP;
	return s.money != before;
}

// HL Rally's RemoveMoney: `if (pev->vuser3[0] > amount) { pev->vuser3[0] -= amount; return true; } return false;`
// (S:dlls/player.cpp:355-368): STRICTLY more than the cost, so $300 does not buy a $300 part.
static inline bool RallyShopRemove(RallyShop& s, int amount)
{
	if (s.money > amount)
	{
		s.money -= amount;
		return true;
	}
	return false;
}

// What a checkpoint pays: +20 (S:dlls/rally_checkpoint.cpp:355 `pPlayer->AddMoney (20)`, the branch for a checkpoint that is not the
// line). The +100 the audit lists for the first car through is in HL Rally's lap-line branch under `if (pPlayer->pev->iuser4 == 1)`
// right after `iuser4` was set to 0 (rally_checkpoint.cpp:286-301): for a forward race it is never true, so HL Rally never pays it.
// Not paid here (kFirstThroughPays false); a server that wants it flips the constant.
static const bool kRallyFirstThroughPays = false;
static inline int RallyMoneyCheckpoint(bool firstThrough)
{
	return H9R_MONEY_CHECKPOINT + (kRallyFirstThroughPays && firstThrough ? H9R_MONEY_FIRST_THROUGH : 0);
}

// What a finish pays: the place's pay (1..4 only: HL Rally's `<= 5` guard lets a fifth place read past its four-entry array, a bug
// that is not copied) and 600 more. Every finisher gets the 600, "even if they didn't finish in the top 4" (rally_checkpoint.cpp:200-207,
// the branch is the one a racer crosses the last line in); a racer who does not finish gets nothing.
static inline int RallyMoneyFinish(int place)
{
	return (place >= 1 && place <= 4 ? g_h9RallyFinishPay[place - 1] : 0) + H9R_MONEY_FINISH_ALL;
}

// The stats the parts held add (stat %): HL Rally's m_vUpgrades summed into vuser4 (client.cpp:1044).
static inline int RallyShopHandlingAdd(unsigned parts)
{
	int sum = 0;
	for (int p = 0; p < H9R_NUM_PARTS; p++)
		if (parts & (1u << p))
			sum += g_h9RallyParts[p].handling;
	return sum;
}
static inline int RallyShopTopAdd(unsigned parts)
{
	int sum = 0;
	for (int p = 0; p < H9R_NUM_PARTS; p++)
		if (parts & (1u << p))
			sum += g_h9RallyParts[p].top;
	return sum;
}
static inline int RallyShopAccelAdd(unsigned parts) // read by nothing in the movement, as in HL Rally
{
	int sum = 0;
	for (int p = 0; p < H9R_NUM_PARTS; p++)
		if (parts & (1u << p))
			sum += g_h9RallyParts[p].accel;
	return sum;
}

// `buy p`. HL Rally's handler (client.cpp:919-1058): the cost comes out first (RemoveMoney; with too little nothing happens), then
// `pPlayer->m_vUpgrades[iClass]` is swapped for the new part's and only the difference goes into the stats: a part replaces the one held
// in its class, whichever is better, and the old one is not refunded. Buying the part already held takes the money again and changes
// nothing. A part before a car is chosen is refused here (HL Rally's client never sends one: its Customise button is hidden until a car is
// picked, and the server's next changecar would drop the part but keep the charge).
// Returns 0 bought, 1 no such part, 2 no car chosen, 3 not enough money.
static inline int RallyShopBuy(RallyShop& s, int part)
{
	if (part < 0 || part >= H9R_NUM_PARTS)
		return 1;
	if (!s.chosen)
		return 2;
	if (!RallyShopRemove(s, g_h9RallyParts[part].cost))
		return 3;
	const int cls = g_h9RallyParts[part].partClass;
	for (int p = 0; p < H9R_NUM_PARTS; p++)
		if (g_h9RallyParts[p].partClass == cls)
			s.parts &= ~(1u << p);
	s.parts |= 1u << part;
	return 0;
}

// `changecar c` (HL Rally: an unknown model returns before anything changes, client.cpp:850-851; a known one zeroes the upgrades,
// :866-867, sets his car and `pev->fuser1 = 1`, :870). The money stays. False for a class that is no car.
static inline bool RallyShopChange(RallyShop& s, int cls)
{
	if (cls < 1 || cls > H9R_NUM_CARS)
		return false;
	s.cls = cls;
	s.parts = 0;
	s.chosen = true;
	return true;
}

// The class a player drives as: the server's cvar override when set (1..10), else the car he chose, else what the map says
// (`global`: the race_rules vehicle's class, 0 when the map is not a rally one).
static inline int RallyEffectiveClass(int cvarClass, int mapClass, const RallyShop& s)
{
	if (cvarClass > 0)
		return cvarClass;
	if (mapClass <= 0)
		return 0;
	return s.cls > 0 ? s.cls : mapClass;
}

// Whether a car change or a join is applied now, as a lap-0 racer, or waits (HL Rally's changecar, client.cpp:872-892):
//   no race running (m_RoundState != 1): Spawn() now;
//   running, not finished, mp_joinmidrace set: he joins the race;
//   running otherwise (finished, or a selectcar's "don't let them join this race again", or no mid-race joining): observer.
enum RallyJoinRule
{
	RALLY_JOIN_NOW = 0, // the car appears now, at his slot (no race is running)
	RALLY_JOIN_LAP0,    // a race is running and he is in it from lap 0
	RALLY_JOIN_OUT,     // a race is running and he is out of it until the next
};
static inline int RallyJoinRuleFor(bool raceRunning, bool doneOrSittingOut, bool joinMidRace)
{
	if (!raceRunning)
		return RALLY_JOIN_NOW;
	return (!doneOrSittingOut && joinMidRace) ? RALLY_JOIN_LAP0 : RALLY_JOIN_OUT;
}
