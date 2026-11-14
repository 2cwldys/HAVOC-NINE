/***
*  race_test.cpp -- a scripted race of three racers over the bookkeeping alone (race_book.cpp, no engine).
*
*    cmake --build build-win32 --target race_test --config Release
*    build-win32/dlls/Release/race_test.exe
*
*  It prints one line a check and ends with "PASS: n checks" (exit 0) or "FAIL: n of m checks" (exit 1).
***/
#include "../race_book.h"
#include "../race_rally.h"
#include "../h9_rally_shop_srv.h"

#include <cstdio>

static int g_checks = 0, g_failed = 0;

static void Check(bool ok, const char* what)
{
	g_checks++;
	if (!ok)
		g_failed++;
	printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
}

static bool Near(float a, float b)
{
	return a - b < 0.001f && b - a < 0.001f;
}

int main()
{
	// A track of four checkpoints (the line and three more), two laps. Racers 11, 12 and 13.
	RaceBook book;
	book.Configure(4, 2);
	Check(book.Add(11) && book.Add(12) && book.Add(13), "three racers join");
	Check(book.Add(12) && book.Count() == 3, "joining twice changes nothing");
	Check(book.Enter(11, 0, 5.0f) == RACE_EV_NONE, "nothing counts before the green light");

	book.Start(100.0f);
	const RaceRacer* a = book.Find(11);
	const RaceRacer* b = book.Find(12);
	const RaceRacer* c = book.Find(13);
	Check(a && b && c && a->next == 1 && a->lap == 0 && a->last == -1, "at the start everyone waits for checkpoint 1");

	// off the grid, over the line: nothing counted
	Check(book.Enter(11, 0, 101.0f) == RACE_EV_START, "A crosses the line off the grid");
	Check(book.Enter(12, 0, 101.2f) == RACE_EV_START, "B crosses the line off the grid");
	Check(book.Enter(13, 0, 101.4f) == RACE_EV_START, "C crosses the line off the grid");
	Check(a->passed == 0 && a->lap == 0, "the first crossing closes no lap");

	// wrong order: 2 before 1 is ignored, and so is 3
	Check(book.Enter(13, 2, 103.0f) == RACE_EV_IGNORED, "C cuts to checkpoint 2: ignored");
	Check(book.Enter(13, 3, 104.0f) == RACE_EV_IGNORED, "C cuts to checkpoint 3: ignored");
	Check(c->passed == 0 && c->next == 1 && c->last == -1, "C has still passed nothing");
	// the line again before checkpoint 1: he came back over it
	Check(book.Enter(13, 0, 105.0f) == RACE_EV_WRONGWAY && c->wrongWay, "C comes back over the line: wrong way");
	Check(c->lap == 0 && c->passed == 0, "and that closes no lap");

	Check(book.Enter(11, 1, 110.0f, 5.0f) == RACE_EV_CHECKPOINT, "A passes checkpoint 1");
	Check(a->next == 2 && a->last == 1 && a->passed == 1 && Near(a->split, 10.0f) && Near(a->bonus, 5.0f), "A's split at 1 is 10 s, bonus 5 s");
	Check(book.Enter(12, 1, 111.0f) == RACE_EV_CHECKPOINT, "B passes checkpoint 1");
	Check(book.Enter(13, 1, 115.0f) == RACE_EV_CHECKPOINT && !c->wrongWay, "C passes checkpoint 1, and the warning ends");

	// places: by checkpoints passed, then by the distance left to the next
	book.Progress(11, 900.0f, 0.1f);
	book.Progress(12, 400.0f, 0.1f);
	book.Progress(13, 100.0f, 0.1f);
	book.Rank();
	Check(c->place == 1 && b->place == 2 && a->place == 3, "same checkpoint, the nearest to the next one leads: C 1, B 2, A 3");

	Check(book.Enter(11, 2, 120.0f) == RACE_EV_CHECKPOINT, "A passes checkpoint 2");
	book.Progress(11, 2000.0f, 0.1f);
	book.Rank();
	Check(a->place == 1 && c->place == 2 && b->place == 3, "a checkpoint more beats any distance: A 1, C 2, B 3");

	// the same checkpoint entered again: A backs into 2
	Check(book.Enter(11, 2, 121.0f) == RACE_EV_WRONGWAY, "A backs into checkpoint 2: wrong way");
	Check(a->passed == 2 && a->next == 3, "and it is not counted twice");
	Check(book.Enter(11, 0, 122.0f) == RACE_EV_IGNORED && a->lap == 0, "A cuts to the line before 3: ignored, no lap");

	Check(book.Enter(11, 3, 130.0f) == RACE_EV_CHECKPOINT, "A passes checkpoint 3");
	Check(book.Enter(11, 0, 140.0f) == RACE_EV_LAP, "A closes lap 1");
	Check(a->lap == 1 && Near(a->lastLap, 40.0f) && Near(a->bestLap, 40.0f) && a->next == 1, "A's lap 1 is 40 s (from the green light)");

	Check(book.Enter(12, 2, 125.0f) == RACE_EV_CHECKPOINT && book.Enter(12, 3, 136.0f) == RACE_EV_CHECKPOINT, "B passes 2 and 3");
	Check(book.Enter(12, 0, 146.0f) == RACE_EV_LAP && Near(b->bestLap, 46.0f), "B closes lap 1 in 46 s");
	Check(book.Enter(13, 2, 130.0f) == RACE_EV_CHECKPOINT && book.Enter(13, 3, 142.0f) == RACE_EV_CHECKPOINT, "C passes 2 and 3");
	Check(book.Enter(13, 0, 155.0f) == RACE_EV_LAP && c->lap == 1, "C closes lap 1");

	// the wrong-way watch: B drives away from checkpoint 1 for more than two seconds
	book.Progress(12, 500.0f, 0.1f);
	for (int i = 1; i <= 15; i++)
		book.Progress(12, 500.0f + i * 20.0f, 0.1f); // 200 units a second away, 1.5 s
	Check(!b->wrongWay, "B away from his checkpoint for 1.5 s: no warning yet");
	for (int i = 16; i <= 22; i++)
		book.Progress(12, 500.0f + i * 20.0f, 0.1f);
	Check(b->wrongWay, "B away for more than 2 s: wrong way");
	book.Progress(12, 900.0f, 0.1f);
	Check(!b->wrongWay, "B turns round: the warning ends");
	// standing still is neither
	for (int i = 0; i < 40; i++)
		book.Progress(13, 700.0f, 0.1f);
	Check(!c->wrongWay, "C standing still for 4 s: no warning");

	// lap 2: B is the faster now and overtakes A
	Check(book.Enter(12, 1, 150.0f) == RACE_EV_CHECKPOINT, "B passes 1 on lap 2");
	Check(b->hasSplitDiff && Near(b->split, 4.0f) && Near(b->splitDiff, 4.0f - 11.0f), "B's split at 1: 4 s, 7 s under his best lap's");
	Check(book.Enter(11, 1, 152.0f) == RACE_EV_CHECKPOINT, "A passes 1 on lap 2");
	Check(book.Enter(12, 2, 158.0f) == RACE_EV_CHECKPOINT && book.Enter(12, 3, 166.0f) == RACE_EV_CHECKPOINT, "B passes 2 and 3");
	Check(book.Enter(11, 2, 162.0f) == RACE_EV_CHECKPOINT, "A passes 2");
	book.Rank();
	Check(b->place == 1 && a->place == 2 && c->place == 3, "on lap 2: B 1, A 2, C 3");

	Check(book.Enter(12, 0, 176.0f) == RACE_EV_FINISH, "B finishes");
	Check(b->finished && b->lap == 2 && b->finishPlace == 1 && Near(b->total, 76.0f) && Near(b->bestLap, 30.0f), "B: 2 laps, 76 s in all, best lap 30 s");
	Check(book.Enter(12, 1, 180.0f) == RACE_EV_NONE && b->lap == 2, "a finished racer counts nothing more");
	Check(book.Enter(11, 3, 172.0f) == RACE_EV_CHECKPOINT && book.Enter(11, 0, 184.0f) == RACE_EV_FINISH, "A finishes");
	Check(a->finishPlace == 2 && Near(a->total, 84.0f) && Near(a->bestLap, 40.0f) && Near(a->lastLap, 44.0f), "A: second, 84 s, best lap 40 s, last 44 s");
	Check(book.FinishedCount() == 2 && book.StillRacing() == 1, "two finished, one still racing");

	// C runs out of time
	book.Retire(13);
	book.Rank();
	Check(c->retired && !c->finished && book.StillRacing() == 0, "C is retired");
	Check(b->place == 1 && a->place == 2 && c->place == 3, "the result: B, A, C");
	const RaceRacer* order[RACE_MAX_RACERS];
	const int n = book.Order(order, RACE_MAX_RACERS);
	Check(n == 3 && order[0]->id == 12 && order[1]->id == 11 && order[2]->id == 13, "the table lists 12, 11, 13");

	// one who leaves, and a new race
	book.Remove(13);
	Check(book.Count() == 2 && book.Find(13) == nullptr, "C leaves");
	book.Start(300.0f);
	Check(a->lap == 0 && !a->finished && a->passed == 0 && a->bestLap == 0 && book.FinishedCount() == 0, "a new race starts from nothing");

	// the line alone (no other checkpoint): each crossing after the first closes a lap
	RaceBook oval;
	oval.Configure(1, 2);
	oval.Add(1);
	oval.Start(0.0f);
	Check(oval.Enter(1, 0, 1.0f) == RACE_EV_START && oval.Enter(1, 0, 21.0f) == RACE_EV_LAP && oval.Enter(1, 0, 40.0f) == RACE_EV_FINISH, "a track with the line alone: start, lap, finish");

	// the swept test: a move that jumps a thin trigger still passes through it
	const float mins[3] = {0, -256, 0}, maxs[3] = {16, 256, 128};
	const float before[3] = {-50, 10, 30}, after[3] = {40, 20, 30}, beside[3] = {-50, 400, 30}, besideOn[3] = {40, 410, 30};
	const float inside[3] = {8, 0, 64}, over[3] = {-50, 10, 300}, overOn[3] = {40, 20, 300};
	Check(RaceSegmentInBox(before, after, mins, maxs), "a move of 90 units through a trigger 16 thick meets it");
	Check(!RaceSegmentInBox(beside, besideOn, mins, maxs), "a move past its end does not");
	Check(!RaceSegmentInBox(over, overOn, mins, maxs), "nor one over it");
	Check(RaceSegmentInBox(inside, inside, mins, maxs), "standing inside meets it");
	Check(!RaceSegmentInBox(before, before, mins, maxs), "standing outside does not");
	Check(RaceSegmentInBox(after, before, mins, maxs), "the same move backwards meets it too");

	// ── rally mode: the racer is the player (race_rally.h) ──
	Check(RaceVehicleKeyIsRally("rally") && RaceVehicleKeyIsRally("Rally") && RaceVehicleKeyIsRally("RALLY"), "vehicle \"rally\" in any case is rally mode");
	Check(!RaceVehicleKeyIsRally("car") && !RaceVehicleKeyIsRally("") && !RaceVehicleKeyIsRally(nullptr) && !RaceVehicleKeyIsRally("rallye") && !RaceVehicleKeyIsRally("ral"), "car, nothing and near misses are the h9_car");
	Check(RaceRallyClassFor(false, 0) == 0 && RaceRallyClassFor(true, 0) == 1, "no cvar: the key decides (car 0, rally class 1)");
	Check(RaceRallyClassFor(false, 1) == 1 && RaceRallyClassFor(false, 3) == 3 && RaceRallyClassFor(true, 2) == 2, "h9_rally 1..3 forces rally, whatever the key, and picks the class");
	Check(RaceRallyClassFor(false, 99) == 10 && RaceRallyClassFor(false, 9) == 9 && RaceRallyClassFor(true, -1) == 1 && RaceRallyClassFor(false, -1) == 0, "an out-of-range cvar is clamped; a negative one is off");

	// slots: the lowest free, in the order players come and go
	{
		bool used[9] = {};
		int slots[5];
		for (int i = 0; i < 4; i++)
		{
			slots[i] = RaceLowestFreeSlot(used, 4);
			used[slots[i]] = true;
		}
		Check(slots[0] == 1 && slots[1] == 2 && slots[2] == 3 && slots[3] == 4, "four players take slots 1, 2, 3, 4 in order");
		Check(RaceLowestFreeSlot(used, 4) == 0, "a full grid has no slot");
		used[2] = false;
		Check(RaceLowestFreeSlot(used, 4) == 2, "the one who left gives slot 2 back and the next takes it");
		used[2] = true;
		used[1] = false;
		used[3] = false;
		Check(RaceLowestFreeSlot(used, 4) == 1, "two free: the lowest first");
		Check(RaceLowestFreeSlot(used, 0) == 0, "no grid, no slot");
	}
	Check(RaceRallySkin(1) == 0 && RaceRallySkin(8) == 7 && RaceRallySkin(9) == 0 && RaceRallySkin(10) == 1 && RaceRallySkin(0) == 0, "skin = (slot - 1) % 8");

	// the checkpoints, with a player for racer: his origin is on the floor, his pev is 16 high, the box has a margin of 8
	{
		RaceBook rb;
		rb.Configure(3, 1);
		rb.Add(5);
		rb.Start(10.0f);
		const float cm[3][3] = {{-8, -200, -8}, {992, -200, -8}, {1992, -200, -8}}; // boxes 16 thick, 400 wide, 144 high, margins in
		const float cx[3][3] = {{8, 200, 136}, {1008, 200, 136}, {2008, 200, 136}};
		float at[3] = {-300, 0, 2}, from[3];
		unsigned long long inside = 0;
		int counted = 0;
		RaceEvent last = RACE_EV_NONE;
		for (int step = 0; step < 200 && at[0] < 2400; step++) // a car at 500 u/s, 100 frames a second would be 5 u a frame; here 12
		{
			from[0] = at[0];
			from[1] = at[1];
			from[2] = at[2];
			at[0] += 12;
			unsigned long long now = 0;
			for (int n = 0; n < 3; n++)
				if (RaceSegmentInBox(from, at, cm[n], cx[n]))
				{
					now |= 1ULL << n;
					if (!(inside & (1ULL << n)))
					{
						last = rb.Enter(5, n, 10.0f + step * 0.1f);
						if (last != RACE_EV_NONE && last != RACE_EV_IGNORED)
							counted++;
					}
				}
			inside = now;
		}
		const RaceRacer* r = rb.Find(5);
		Check(r && r->last == 2 && r->passed == 2 && counted == 3, "a player's origin driving the line, 1 and 2 passes all three boxes in order");
	}

	// the two state bytes other clients read
	{
		// heading east (yaw 0), 400 u/s along it
		RaceRallyDrive a = RaceRallyDriveOf(400, 0, 0, false, false, false, 2);
		Check(a.speed > 399.9f && a.speed < 400.1f && a.slip == 0 && a.blending0 == 0 && a.blending1 == 2, "straight at 400: speed 400, no slip, surface dirt only");
		// sliding: 300 along, 300 to the left (45 degrees): slip = sin 45 = 0.707, byte 180
		RaceRallyDrive b = RaceRallyDriveOf(300, 300, 0, false, false, false, 0);
		Check(b.slip > 0.70f && b.slip < 0.72f && b.blending0 >= 179 && b.blending0 <= 181, "45 degrees of slide: slip 0.707, byte 180");
		// heading north (yaw 90): the same velocity east is all sideways
		RaceRallyDrive c = RaceRallyDriveOf(400, 0, 90, false, false, false, 0);
		Check(c.speed > -0.1f && c.speed < 0.1f && c.slip > 0.99f && c.blending0 == 255, "heading north, moving east: all sideways, slip 255");
		RaceRallyDrive d = RaceRallyDriveOf(400, 0, 0, true, true, true, 6);
		Check(d.blending1 == (6 | 8 | 16 | 32), "air 8, braking 16 (back above reverse speed), handbrake 32 and the surface in the low 3 bits");
		RaceRallyDrive e = RaceRallyDriveOf(20, 0, 0, false, true, false, 0);
		Check((e.blending1 & 16) == 0, "the back key below 40 u/s is reverse, not braking");
		RaceRallyDrive f = RaceRallyDriveOf(-100, 0, 0, false, false, false, 0);
		Check(f.speed < -99.9f && f.slip == 0, "going backwards along the nose: negative speed, no slip");
		RaceRallyDrive g = RaceRallyDriveOf(10, 10, 0, false, false, false, 0);
		Check(g.slip == 0, "below 30 u/s there is no slip to draw");
	}
	Check(RaceSurfaceByte(H9RS_ROAD, false) == 0 && RaceSurfaceByte(H9RS_NEUTRAL, false) == 0 && RaceSurfaceByte(H9RS_DIRT, false) == 2 &&
		RaceSurfaceByte(H9RS_SAND, false) == 2 && RaceSurfaceByte(H9RS_GRASS, false) == 3 && RaceSurfaceByte(H9RS_SNOW, false) == 5 &&
		RaceSurfaceByte(H9RS_DIRT, true) == 4, "rally surfaces map to the effects' ids: tarmac 0, dirt and sand 2, grass 3, water 4, snow 5");
	Check(RaceSurfaceByte(H9RallySurfaceByName("road_main"), false) == 0 && RaceSurfaceByte(H9RallySurfaceByName("+0grass2"), false) == 3, "texture names go through to the same bytes");
	{
		const float top = RaceRallyTopSpeed(1);
		Check(top > 679.0f && top < 681.0f, "the gauge's end for class 1 is the road's top speed, 680");
	}

	// the put-back key (HL Rally's `k`): at once on the press, a second's rest after one taken, no repeat while held, no automatic put-back
	{
		RacePutKey k;
		Check(!k.Press(false, 10.0f), "put-back: no press, no put-back");
		Check(k.Press(true, 10.0f), "put-back: the press puts the car back at once");
		Check(!k.Press(true, 10.5f) && !k.Press(true, 12.0f), "put-back: holding the key does not repeat it");
		Check(!k.Press(false, 10.6f) && !k.Press(true, 10.99f), "put-back: a press inside the second after one does nothing");
		Check(!k.Press(false, 11.0f) && k.Press(true, 11.0f), "put-back: and from a second after the first it works again");
		Check(!k.Press(false, 11.5f) && !k.Press(true, 11.9f), "put-back: the refused press at 10.99 did not push the next one back");
	}

	// the put-back's counter (HL Rally's ClientKill, S:dlls/client.cpp:404-405): back one when no respawn was found
	{
		RaceBook b;
		b.Configure(4, 2);
		b.Add(1);
		b.Start(0);
		b.Enter(1, 0, 1); // off the grid
		b.Enter(1, 1, 2);
		b.Enter(1, 2, 3);
		Check(b.Find(1)->next == 3 && b.Find(1)->last == 2 && b.Find(1)->passed == 2, "put-back: after checkpoints 1 and 2 the next is 3");
		Check(b.RollBack(1) && b.Find(1)->next == 2 && b.Find(1)->last == 1 && b.Find(1)->passed == 1, "put-back: the counter goes back one, he must pass 2 again");
		Check(b.Enter(1, 2, 4) == RACE_EV_CHECKPOINT && b.Find(1)->next == 3, "put-back: passing 2 again counts and goes on");
		b.RollBack(1);
		b.RollBack(1);
		Check(b.Find(1)->next == 1 && b.Find(1)->last == -1 && !b.RollBack(1), "put-back: back to the first checkpoint, and no further (HL Rally's increment at 0 is not copied)");
	}

	// the car menu's money (HL Rally: S:dlls/player.cpp:314-382, S:dlls/rally_checkpoint.cpp:180-207, 355)
	{
		RallyShop p;
		RallyShopJoin(p);
		Check(p.money == 600 && !p.chosen && p.cls == 0 && p.parts == 0, "money: $600 at join, nothing chosen, no parts");
		RallyShopChange(p, 2);
		RallyShopBuy(p, 0);
		RallyShopJoin(p);
		Check(p.money == 600 && !p.chosen && p.parts == 0, "money: joining again (a new map) is $600 and nothing held, whatever he had");
		Check(RallyMoneyCheckpoint(false) == 20, "money: +20 at a checkpoint");
		Check(RallyMoneyCheckpoint(true) == 20, "money: and +20 only for the first car through (HL Rally's +100 is dead code: iuser4 == 1 after it was set to 0)");
		Check(RallyMoneyFinish(1) == 1400 && RallyMoneyFinish(2) == 1200 && RallyMoneyFinish(3) == 1000 && RallyMoneyFinish(4) == 800,
			"money: a finish pays 800/600/400/200 for places 1 to 4 and 600 more to every finisher (1400, 1200, 1000, 800)");
		Check(RallyMoneyFinish(5) == 600 && RallyMoneyFinish(9) == 600 && RallyMoneyFinish(0) == 600,
			"money: a fifth place or later gets the 600 and no place pay (HL Rally's out-of-range read of scores[4] is not copied)");
		RallyShop q;
		RallyShopJoin(q);
		Check(RallyShopAdd(q, 20) && q.money == 620, "money: add changes the figure and says so");
		q.money = 6990;
		Check(RallyShopAdd(q, 100) && q.money == 7000, "money: the cap is $7000");
		Check(!RallyShopAdd(q, 20) && q.money == 7000, "money: at the cap an addition changes nothing (nothing to send)");
		// a whole race for one car: 3 laps of 4 checkpoints (the line + 3): checkpoints 1, 2, 3 each lap, the line closes the first two laps with no pay
		RallyShop r;
		RallyShopJoin(r);
		for (int lap = 0; lap < 3; lap++)
			for (int cp = 1; cp <= 3; cp++)
				RallyShopAdd(r, RallyMoneyCheckpoint(false));
		RallyShopAdd(r, RallyMoneyFinish(2));
		Check(r.money == 600 + 9 * 20 + 1200, "money: nine checkpoints and a second place come to 600 + 180 + 1200");
	}

	// the shop: buy rules (HL Rally's client.cpp:919-1058, player.cpp:355-368)
	{
		RallyShop p;
		RallyShopJoin(p);
		Check(RallyShopBuy(p, 0) == 2 && p.money == 600, "buy: with no car chosen nothing is sold and nothing is charged");
		RallyShopChange(p, 1);
		Check(RallyShopBuy(p, 99) == 1 && RallyShopBuy(p, -1) == 1, "buy: a part that does not exist is refused");
		Check(RallyShopBuy(p, 8) == 3 && p.money == 600 && p.parts == 0, "buy: $600 does not buy a $4500 turbo, and nothing is taken");
		Check(RallyShopBuy(p, 0) == 0 && p.money == 300 && p.parts == (1u << 0), "buy: street tyres ($300) are charged and held");
		Check(RallyShopBuy(p, 3) == 0 && p.money == 100, "buy: money strictly above the cost buys (300 > 200): $100 left");
		RallyShop e;
		RallyShopJoin(e);
		RallyShopChange(e, 1);
		e.money = 300;
		Check(RallyShopBuy(e, 0) == 3 && e.money == 300, "buy: exactly the price is not enough (HL Rally's `money > cost`): $300 does not buy a $300 part");
		e.money = 301;
		Check(RallyShopBuy(e, 0) == 0 && e.money == 1, "buy: $301 does");
		// one part to a class: the new part replaces the one held, the old is not refunded
		RallyShop t;
		RallyShopJoin(t);
		RallyShopChange(t, 4);
		t.money = 7000;
		Check(RallyShopBuy(t, 0) == 0 && RallyShopHandlingAdd(t.parts) == 3, "buy: street tyres add 3 handling");
		Check(RallyShopBuy(t, 2) == 0 && RallyShopHandlingAdd(t.parts) == 7 && t.parts == (1u << 2) && t.money == 7000 - 300 - 700,
			"buy: rally tyres take the place of the street ones: 7 handling, not 10; both prices paid, no refund");
		Check(RallyShopBuy(t, 1) == 0 && RallyShopHandlingAdd(t.parts) == 5 && t.parts == (1u << 1),
			"buy: a worse part in the class replaces the better one too, as HL Rally's swap does (5, not 7)");
		Check(RallyShopBuy(t, 5) == 0 && RallyShopBuy(t, 8) == 0 && RallyShopTopAdd(t.parts) == 8 + 15 && RallyShopHandlingAdd(t.parts) == 5,
			"buy: classes are independent: a turbo-back (+8 top) and a single turbo (+15 top) add up to 23, the tyres still 5");
		t.money = 3000;
		const int before = t.money;
		Check(RallyShopBuy(t, 5) == 0 && t.money == before - 800 && RallyShopTopAdd(t.parts) == 23, "buy: the part already held is charged again and changes nothing");
		// a car change drops every part and keeps the money
		const int kept = t.money;
		Check(RallyShopChange(t, 6) && t.parts == 0 && t.money == kept && t.cls == 6 && t.chosen, "change: a new car has no parts, the money stays");
		Check(RallyShopHandlingAdd(t.parts) == 0 && RallyShopTopAdd(t.parts) == 0, "change: so the physinfo additions go to 0 and 0");
		t.chosen = false; // spectate / selectcar
		Check(RallyShopBuy(t, 0) == 2, "buy: after spectate (no car chosen) nothing is sold");
	}

	// the respawn rules of a car choice (HL Rally's client.cpp:872-892)
	{
		Check(RallyJoinRuleFor(false, false, true) == RALLY_JOIN_NOW && RallyJoinRuleFor(false, true, false) == RALLY_JOIN_NOW,
			"join: before the race starts the car appears now, whatever else is set");
		Check(RallyJoinRuleFor(true, false, true) == RALLY_JOIN_LAP0, "join: a race running, not finished, mp_joinmidrace 1: he is in it from lap 0");
		Check(RallyJoinRuleFor(true, false, false) == RALLY_JOIN_OUT, "join: a race running and mp_joinmidrace 0: he waits for the next");
		Check(RallyJoinRuleFor(true, true, true) == RALLY_JOIN_OUT, "join: a race running and he has finished (or used selectcar): observer until the next");
	}

	if (g_failed)
		printf("FAIL: %d of %d checks\n", g_failed, g_checks);
	else
		printf("PASS: %d checks\n", g_checks);
	return g_failed ? 1 : 0;
}
