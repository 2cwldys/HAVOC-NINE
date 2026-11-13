/***
*  race_test.cpp -- a scripted race of three racers over the bookkeeping alone (race_book.cpp, no engine).
*
*    cmake --build build-win32 --target race_test --config Release
*    build-win32/dlls/Release/race_test.exe
*
*  It prints one line a check and ends with "PASS: n checks" (exit 0) or "FAIL: n of m checks" (exit 1).
***/
#include "../race_book.h"

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

	if (g_failed)
		printf("FAIL: %d of %d checks\n", g_failed, g_checks);
	else
		printf("PASS: %d checks\n", g_checks);
	return g_failed ? 1 : 0;
}
