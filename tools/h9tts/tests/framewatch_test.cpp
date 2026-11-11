// framewatch_test -- the frame-time watch of the Kokoro voices (reTS/cl_dll/h9_tts_framewatch.h): fed frame times, it must say "fewer threads" when the
// game's frames get longer while the helper works, and say nothing for a small rise, a short line, or a stall.
//
// build: tools\h9tts\tests\build_tests.bat      run: framewatch_test.exe

#include <stdio.h>

#include "h9_tts_framewatch.h"

using namespace h9tts;

static int g_fail = 0;
#define CHECK(c, ...)                                  \
	do                                                 \
	{                                                  \
		if (!(c))                                      \
		{                                              \
			printf("FAIL line %d: ", __LINE__);        \
			printf(__VA_ARGS__);                       \
			printf("\n");                              \
			g_fail++;                                  \
		}                                              \
	} while (0)

// idle frames, then a line of n frames at speakingMs; returns true when the watch asked for fewer threads during it (it does so when the line ends)
static bool Line(FrameWatch& w, int idleFrames, double idleMs, int frames, double speakingMs)
{
	bool fewer = false;
	for (int i = 0; i < idleFrames; i++)
		fewer = w.Frame(idleMs / 1000.0, false) || fewer;
	for (int i = 0; i < frames; i++)
		fewer = w.Frame(speakingMs / 1000.0, true) || fewer;
	fewer = w.Frame(idleMs / 1000.0, false) || fewer; // the first frame after the line closes it
	return fewer;
}

int main()
{
	// a slow rise (12.5 percent): the third slow line asks for fewer threads, and not before
	{
		FrameWatch w;
		for (int i = 0; i < 200; i++)
			w.Frame(0.008, false);
		bool a = Line(w, 30, 8.0, 20, 9.0);
		bool b = Line(w, 30, 8.0, 20, 9.0);
		bool c = Line(w, 30, 8.0, 20, 9.0);
		CHECK(!a && !b && c, "slow lines: %d %d %d, ratio %.3f", a, b, c, w.LastRatio());
		CHECK(w.Decisions() == 1 && w.SlowInHistory() == 0, "one decision, the history starts again");
	}
	// 6 percent: never
	{
		FrameWatch w;
		for (int i = 0; i < 200; i++)
			w.Frame(0.008, false);
		bool any = false;
		for (int k = 0; k < 20; k++)
			any = Line(w, 30, 8.0, 20, 8.5) || any;
		CHECK(!any && w.Decisions() == 0, "a rise of 6 percent says nothing");
	}
	// slow and fast lines mixed: three slow of the last five needed
	{
		FrameWatch w;
		for (int i = 0; i < 200; i++)
			w.Frame(0.008, false);
		bool any = false;
		for (int k = 0; k < 5; k++)
			any = Line(w, 30, 8.0, 20, (k % 2) ? 8.2 : 9.5) || any; // slow, fast, slow, fast, slow: three of five
		CHECK(any, "three slow lines of five asks for fewer");
	}
	// short lines and a baseline that is too young say nothing
	{
		FrameWatch w;
		for (int i = 0; i < 50; i++)
			w.Frame(0.008, false);
		bool any = false;
		for (int k = 0; k < 6; k++)
			any = Line(w, 5, 8.0, 20, 12.0) || any;
		CHECK(!any, "a baseline of under 120 frames says nothing");
		FrameWatch v;
		for (int i = 0; i < 200; i++)
			v.Frame(0.008, false);
		for (int k = 0; k < 6; k++)
			any = Line(v, 10, 8.0, 5, 12.0) || any;
		CHECK(!any, "lines of 5 frames say nothing");
	}
	// a stall (a map change, a hitch over a quarter of a second) counts for nothing
	{
		FrameWatch w;
		for (int i = 0; i < 200; i++)
			w.Frame(0.008, false);
		bool any = false;
		for (int k = 0; k < 6; k++)
		{
			for (int i = 0; i < 20; i++)
				any = w.Frame(i == 7 ? 0.9 : 0.008, true) || any;
			any = w.Frame(0.008, false) || any;
			for (int i = 0; i < 30; i++)
				w.Frame(0.008, false);
		}
		CHECK(!any && w.Decisions() == 0, "a stall is ignored");
	}
	printf("framewatch_test: %d failure(s)\n", g_fail);
	return g_fail ? 1 : 0;
}
