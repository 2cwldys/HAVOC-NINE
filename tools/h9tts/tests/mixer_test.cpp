// mixer_test -- the voice mixer of the client (reTS/cl_dll/h9_tts_mix.h): the rules it has always had, and the streamed lines.
//
// Every sample buffer is counted when the test makes it and when the mixer lets go of it: at the end nothing may be left over.
//
// build: tools\h9tts\tests\build_tests.bat      run: mixer_test.exe

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_made = 0, g_freed = 0;
#define H9TTS_MIX_FREE(p)       \
	do                          \
	{                           \
		if (p)                  \
		{                       \
			g_freed++;          \
			free(p);            \
		}                       \
	} while (0)

#define H9TTS_MIX_ALLOC(n) (g_made++, malloc(n))

#include "h9_tts_mix.h"

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

static short* Tone(int frames, short level)
{
	short* p = (short*)malloc((size_t)frames * sizeof(short));
	g_made++;
	for (int i = 0; i < frames; i++)
		p[i] = level;
	return p;
}

static Clip MakeClip(int speaker, int frames, short level, unsigned arrived = 0, int stream = 0, bool open = false, int limit = 4)
{
	Clip c;
	memset(&c, 0, sizeof(c));
	c.speaker = speaker;
	c.pcm = Tone(frames, level);
	c.frames = frames;
	c.gainL = 1.0f;
	c.gainR = 1.0f;
	c.priority = 1.0f;
	c.limit = limit;
	c.arrived = arrived;
	c.stream = stream;
	c.open = open;
	return c;
}

// Mixes n frames, a block of 100 at a time as the sound card's thread does (a waiting line starts at the start of a block), and returns the
// left channel's samples.
static void Run(Mixer& m, int frames, unsigned now, short* left, int* sounding = nullptr)
{
	short out[200];
	for (int at = 0; at < frames; at += 100)
	{
		const int n = frames - at < 100 ? frames - at : 100;
		const int s = m.Mix(out, n, now);
		if (sounding && at == 0)
			*sounding = s;
		for (int i = 0; i < n; i++)
			left[at + i] = out[2 * i];
	}
}

int main()
{
	// ---- a whole line: fades in and out, ends, the mixer is idle
	{
		Mixer m;
		CHECK(m.Submit(MakeClip(1, 4000, 10000), 0) == Mixer::kStarted, "first line starts");
		short buf[5000];
		Run(m, 5000, 0, buf);
		CHECK(buf[0] > 0 && buf[0] < 1000, "fade in starts low: %d", buf[0]);
		CHECK(buf[2000] == 10000, "steady level: %d", buf[2000]);
		CHECK(buf[3999] < 1000, "fade out ends low: %d", buf[3999]);
		CHECK(buf[4001] == 0 && m.Idle(), "the line ended");
	}

	// ---- two speakers together, the same speaker one after the other
	{
		Mixer m;
		CHECK(m.Submit(MakeClip(1, 3000, 1000), 0) == Mixer::kStarted, "speaker 1");
		CHECK(m.Submit(MakeClip(2, 3000, 2000), 0) == Mixer::kStarted, "speaker 2 together");
		CHECK(m.Playing() == 2, "two voices");
		CHECK(m.Submit(MakeClip(1, 3000, 3000), 0) == Mixer::kWaiting, "speaker 1 again waits");
		short buf[4000];
		Run(m, 4000, 0, buf);
		CHECK(m.Playing() == 1 && m.VoicesOf(1) == 1, "the waiting line took speaker 1's voice when it ended");
	}

	// ---- the voice limit, the waiting list, a line that waited too long
	{
		Mixer m;
		for (int s = 1; s <= 2; s++)
			CHECK(m.Submit(MakeClip(s, 20000, 500, 0, 0, false, 2), 0) == Mixer::kStarted, "start %d", s);
		CHECK(m.Submit(MakeClip(3, 2000, 500, 0, 0, false, 2), 0) == Mixer::kWaiting, "limit 2: the third waits");
		short buf[10];
		Run(m, 10, kMixMaxWaitMs + 100, buf);
		CHECK(m.Waiting() == 0, "a line that waited more than %d ms is dropped", kMixMaxWaitMs);
		m.StopAll();
		short big[2000];
		Run(m, 2000, 0, big);
		CHECK(m.Idle(), "stop fades everything out");
	}

	// ---- a streamed line: the first piece, appended pieces, the end
	{
		Mixer m;
		CHECK(m.Submit(MakeClip(7, 1000, 8000, 0, 5, true), 0) == Mixer::kStarted, "the streamed line starts with its first piece");
		short buf[3000];
		Run(m, 500, 0, buf);
		CHECK(buf[300] == 8000, "plays the first piece: %d", buf[300]);
		// the voice reaches the end of the first piece: silence, but still there
		Run(m, 1000, 0, buf);
		CHECK(buf[700] == 0 && m.Playing() == 1, "waiting for the next piece: voice still active, %d voices", m.Playing());
		CHECK(buf[400] > 7000, "no fade-out put on the end of an open piece: %d", buf[400]);
		CHECK(m.Append(7, 5, Tone(2000, 6000), 2000, false), "append a piece");
		Run(m, 1000, 0, buf);
		CHECK(buf[500] == 6000, "the appended piece is played: %d", buf[500]);
		CHECK(m.Append(7, 5, Tone(500, 4000), 500, true), "append the last piece");
		Run(m, 3000, 0, buf);
		bool silent = true;
		for (int i = 1700; i < 3000; i++)
			silent = silent && buf[i] == 0;
		CHECK(silent && m.Idle(), "the line ends after its last piece");
		CHECK(!m.Append(7, 5, Tone(100, 1), 100, true), "a line that is over takes no more");
	}

	// ---- a streamed line that waits for its speaker, and is appended while it waits
	{
		Mixer m;
		CHECK(m.Submit(MakeClip(3, 1500, 1000), 0) == Mixer::kStarted, "a whole line of speaker 3");
		CHECK(m.Submit(MakeClip(3, 1000, 5000, 0, 9, true), 0) == Mixer::kWaiting, "the streamed line waits for the speaker's voice");
		CHECK(m.Append(3, 9, Tone(1000, 5000), 1000, true), "it can be appended while it waits");
		short buf[6000];
		Run(m, 6000, 0, buf);
		CHECK(m.Idle(), "both lines were played: %d voices, %d waiting", m.Playing(), m.Waiting());
	}

	// ---- a streamed line that is replaced: the maker is told
	{
		Mixer m;
		CHECK(m.Submit(MakeClip(4, 1000, 1000), 0) == Mixer::kStarted, "speaker 4 is busy");
		CHECK(m.Submit(MakeClip(4, 800, 3000, 0, 11, true), 0) == Mixer::kWaiting, "a streamed line waits");
		CHECK(m.Submit(MakeClip(4, 900, 4000), 0) == Mixer::kWaiting, "a newer line of his replaces the waiting one");
		CHECK(!m.Append(4, 11, Tone(500, 3000), 500, false), "the replaced stream is gone: Append says so");
		m.Clear();
	}

	// ---- stop while a streamed voice is starved
	{
		Mixer m;
		m.Submit(MakeClip(6, 500, 2000, 0, 3, true), 0);
		short buf[2000];
		Run(m, 700, 0, buf);
		m.StopAll();
		Run(m, 1000, 0, buf);
		CHECK(m.Idle() && !m.Append(6, 3, Tone(100, 1), 100, false), "a stop ends an open voice and closes its stream");
	}

	// ---- nothing is left over
	CHECK(g_made == g_freed, "%d buffers made, %d let go of", g_made, g_freed);
	printf("mixer_test: %d failure(s), %d buffers made and let go of\n", g_fail, g_freed);
	return g_fail ? 1 : 0;
}
