// Checks rally mode's client sounds (h9_rallysnd_calc.h) with no game. Every expected number is worked out by hand from HL Rally's own lines (the
// source is not in this repository; "rs" is cl_dll/rally_sound.cpp, "re" cl_dll/Rally_Effects.cpp, "in" cl_dll/input.cpp, "hud" cl_dll/rallyhud.cpp,
// "cdll" cl_dll/cdll_int.cpp), written as plain numbers, never by calling the function under test to make them.
//   cmake --build <dir> --target rallysnd_test --config Release, then run rallysnd_test
#include "../h9_rallysnd_calc.h"

#include <stdio.h>
#include <math.h>
#include <string.h>

using namespace rallysnd;

static int g_failed = 0, g_checked = 0;
#define CHECK(what) \
	do \
	{ \
		g_checked++; \
		if (!(what)) \
		{ \
			g_failed++; \
			printf("FAILED line %d: %s\n", __LINE__, #what); \
		} \
	} while (0)

static bool Near(float a, float b, float eps) { return fabsf(a - b) <= eps; }

int main()
{
	// ---- the local engine's pitch: rs:333 FSOUND_SetFrequency(2000 + rpm*260), over the file's rate ----
	// rpm 15 -> 5900 Hz, rpm 100 -> 28000 Hz, rpm 250 -> 67000 Hz.
	CHECK(LocalHz(15) == 5900 && LocalHz(100) == 28000 && LocalHz(250) == 67000);
	// a 44100 Hz file: 5900/44100 = 13.38 %, 28000/44100 = 63.49 %, 67000/44100 = 151.93 %
	CHECK(PitchFor(LocalHz(15), 44100) == 13);
	CHECK(PitchFor(LocalHz(100), 44100) == 63);
	CHECK(PitchFor(LocalHz(250), 44100) == 152);
	// a 22050 Hz file: 5900/22050 = 26.76 %, 67000/22050 = 303.85 %: past the 255 the server's byte holds
	CHECK(PitchFor(LocalHz(15), 22050) == 27);
	CHECK(PitchFor(LocalHz(250), 22050) == 304);
	// a 48000 Hz file at rpm 100: 28000/48000 = 58.33 %
	CHECK(PitchFor(LocalHz(100), 48000) == 58);
	// the engine takes no pitch under 2 as itself
	CHECK(PitchFor(100, 44100) == kMinPitch && kMinPitch == 2);
	CHECK(PitchFor(5000, 0) == 100); // a rate that is not known: as recorded (the caller does not play such a file)

	// ---- the local engine's volume: rs:323-331, integer divisions, FMOD's 0..255 ----
	// not accelerating (the revs not falling): 20 + rpm/3. rpm 100: 20 + 33 = 53; rpm 15: 20 + 5 = 25; rpm 250: 20 + 83 = 103
	CHECK(Near(LocalVolumeFmod(100, 0), 53.0f, 1e-4f));
	CHECK(Near(LocalVolumeFmod(15, 0), 25.0f, 1e-4f));
	CHECK(Near(LocalVolumeFmod(250, 0), 103.0f, 1e-4f));
	// accelerating > 0 (the flag is 2): 40 + rpm/2. rpm 100: 90; rpm 15: 40 + 7 = 47 (15/2 is 7); rpm 250: 165
	CHECK(Near(LocalVolumeFmod(100, 2), 90.0f, 1e-4f));
	CHECK(Near(LocalVolumeFmod(15, 2), 47.0f, 1e-4f));
	CHECK(Near(LocalVolumeFmod(250, 2), 165.0f, 1e-4f));
	// as the engine's 0..1: 53/255 = 0.2078, 90/255 = 0.3529, no floor, no 1.7 times
	CHECK(Near(VolumeFor(LocalVolumeFmod(100, 0)), 0.2078f, 1e-3f));
	CHECK(Near(VolumeFor(LocalVolumeFmod(100, 2)), 0.3529f, 1e-3f));
	CHECK(VolumeFor(300.0f) == 1.0f && VolumeFor(-5.0f) == 0.0f);
	// the cap (rs:329): a number over 255 is 255 (reachable only by a bigger rpm than the game's)
	CHECK(LocalVolumeFmod(900, 2) == 255.0f);

	// ---- N3b: the flag the volume reads (re:373-376), left by the revs' fall of one frame ----
	CHECK(Accelerating(100.0f, 97.0f) == 2);  // 100 > 97 + 2 = 99
	CHECK(Accelerating(100.0f, 98.0f) == 0);  // 100 > 100 is false: a fall of exactly 2 is not a fall
	CHECK(Accelerating(100.0f, 100.0f) == 0); // steady
	CHECK(Accelerating(100.0f, 150.0f) == 0); // rising
	CHECK(Accelerating(120.0f, 60.0f) == 2);  // a shift

	// ---- the whine: rs:337-347 ----
	// rpm 100: 10 + 33 = 43, at any speed under 500
	CHECK(Near(WhineVolumeFmod(100, 0.0f), 43.0f, 1e-4f));
	CHECK(Near(WhineVolumeFmod(100, 499.0f), 43.0f, 1e-4f));
	// at 500: 43 * ((-1000 + 1500) / 600) = 43 * 0.83333 = 35.833; at 600: 43 * (300/600) = 21.5; at 750: 0; past it never negative
	CHECK(Near(WhineVolumeFmod(100, 500.0f), 35.8333f, 1e-3f));
	CHECK(Near(WhineVolumeFmod(100, 600.0f), 21.5f, 1e-3f));
	CHECK(Near(WhineVolumeFmod(100, 750.0f), 0.0f, 1e-3f));
	CHECK(WhineVolumeFmod(100, 900.0f) == 0.0f);
	// frequency: 4000 + rpm*30 + speed*80, truncated. rpm 100, 400 u/s: 4000 + 3000 + 32000 = 39000. rpm 15, 123.456 u/s: 4000 + 450 + 9876.48 = 14326.48 -> 14326
	CHECK(WhineHz(100, 400.0f) == 39000);
	CHECK(WhineHz(15, 123.456f) == 14326);
	// the whine file is 44100 Hz: 39000/44100 = 88.43 % -> 88
	CHECK(PitchFor(WhineHz(100, 400.0f), 44100) == 88);

	// ---- the other cars: rs:543-551 ----
	// 25 + rpm/4, at most 75: rpm 100 -> 50; rpm 15 -> 25 + 3 = 28; rpm 250 -> 25 + 62 = 87 -> 75; rpm 200 -> 75 exactly
	CHECK(Near(RemoteVolumeFmod(100), 50.0f, 1e-4f));
	CHECK(Near(RemoteVolumeFmod(15), 28.0f, 1e-4f));
	CHECK(Near(RemoteVolumeFmod(250), 75.0f, 1e-4f));
	CHECK(Near(RemoteVolumeFmod(200), 75.0f, 1e-4f));
	// 2000 + rpm*220: rpm 100 -> 24000 Hz; rpm 15 -> 5300; a 44100 Hz file: 24000/44100 = 54.42 % -> 54
	CHECK(RemoteHz(100) == 24000 && RemoteHz(15) == 5300);
	CHECK(PitchFor(RemoteHz(100), 44100) == 54);

	// ---- the other cars' guessed revs: re:1670-1705 ----
	{
		// standing (speed 0, no countdown): revs = 15, then (state*3 + 15)/4: 3.75, then (11.25 + 15)/4 = 6.5625
		float st = 0.0f;
		float r = RemoteRevs(st, 0.0f, false, 0.01f, 0.0f, 0.0f);
		CHECK(Near(r, 3.75f, 1e-4f) && Near(st, 3.75f, 1e-4f));
		r = RemoteRevs(st, 0.0f, false, 0.01f, 0.0f, 0.0f);
		CHECK(Near(r, 6.5625f, 1e-4f));
		for (int i = 0; i < 60; i++)
			r = RemoteRevs(st, 0.0f, false, 0.01f, 0.0f, 0.0f);
		CHECK(Near(r, 15.0f, 0.01f)); // it settles at the idle
		// 200 u/s: cs = 250, gear = int(250/250) + 1 = 2, revs = 125; from a state of 0: (0 + 125)/4 = 31.25
		st = 0.0f;
		r = RemoteRevs(st, 200.0f, false, 0.01f, 0.0f, 0.0f);
		CHECK(Near(r, 31.25f, 1e-4f));
		// 199.9 u/s: cs = 249.875, gear 1, revs 249.875: from a state of 100: (300 + 249.875)/4 = 137.46875
		st = 100.0f;
		r = RemoteRevs(st, 199.9f, false, 0.01f, 0.0f, 0.0f);
		CHECK(Near(r, 137.46875f, 1e-3f));
		// countdown, standing (speed 2 or less): revs = state + rand(400..1100) * frametime: 100 + 800 * 0.01 = 108 -> (300 + 108)/4 = 102
		st = 100.0f;
		r = RemoteRevs(st, 0.0f, true, 0.01f, 800.0f, 0.0f);
		CHECK(Near(r, 102.0f, 1e-4f));
		// ... and over 250 it bounces: state 250 + 1100 * 0.01 = 261 > 250 -> state = 250, revs = 100 + 50 = 150 -> (750 + 150)/4 = 225
		st = 250.0f;
		r = RemoteRevs(st, 0.0f, true, 0.01f, 1100.0f, 50.0f);
		CHECK(Near(r, 225.0f, 1e-4f) && Near(st, 225.0f, 1e-4f));
		// the revs are the int part: 137.46875 -> 137, which is what the sound takes
		CHECK((int)137.46875f == 137);
	}

	// ---- the four nearest cars: rs:461-516 ----
	{
		const float d[6] = {500, 100, 300, 50, 200, 400}; // cars 0..5
		Slots s;
		SlotsReset(s);
		for (int i = 0; i < 6; i++)
			SlotsOffer(s, 4, i, d[i]);
		bool in[6] = {false, false, false, false, false, false};
		for (int k = 0; k < s.n; k++)
			in[s.car[k]] = true;
		// the nearest four are 50 (3), 100 (1), 200 (4), 300 (2)
		CHECK(s.n == 4 && in[1] && in[2] && in[3] && in[4] && !in[0] && !in[5]);
		CHECK(Near(s.maxDist, 300.0f, 1e-4f));
		// another order gives the same four
		Slots t;
		SlotsReset(t);
		const int order[6] = {5, 4, 3, 2, 1, 0};
		for (int i = 0; i < 6; i++)
			SlotsOffer(t, 4, order[i], d[order[i]]);
		bool in2[6] = {false, false, false, false, false, false};
		for (int k = 0; k < t.n; k++)
			in2[t.car[k]] = true;
		CHECK(t.n == 4 && in2[1] && in2[2] && in2[3] && in2[4] && !in2[0] && !in2[5]);
		// fewer cars than the cap: all of them; the cap 1: only the nearest
		Slots u;
		SlotsReset(u);
		SlotsOffer(u, 4, 7, 10.0f);
		SlotsOffer(u, 4, 8, 20.0f);
		CHECK(u.n == 2);
		Slots v;
		SlotsReset(v);
		for (int i = 0; i < 6; i++)
			SlotsOffer(v, 1, i, d[i]);
		CHECK(v.n == 1 && v.car[0] == 3);
		// a cap of 0 holds none
		Slots w;
		SlotsReset(w);
		SlotsOffer(w, 0, 1, 10.0f);
		CHECK(w.n == 0);
	}

	// ---- the squeal: re:1132-1138 ----
	{
		float next = 0.0f;
		// fast enough (over 60): plays, and not again for half a second
		CHECK(SquealStep(next, 1.0f, 70.0f, 0.0f) && Near(next, 1.5f, 1e-5f));
		CHECK(!SquealStep(next, 1.2f, 70.0f, 0.0f));
		CHECK(!SquealStep(next, 1.5f, 70.0f, 0.0f)); // next < now is false at the moment itself
		// slow and not sliding: nothing; slow and sliding (|temp_vec[YAW]| over 0.15): plays
		CHECK(!SquealStep(next, 1.6f, 50.0f, 0.1f));
		CHECK(SquealStep(next, 1.6f, 50.0f, 0.2f) && Near(next, 2.1f, 1e-5f));
		CHECK(SquealStep(next, 2.2f, 40.0f, -0.2f));
		CHECK(!SquealStep(next, 2.8f, 60.0f, 0.15f)); // 60 is not over 60, 0.15 is not over 0.15
	}

	// ---- the surfaces: re:1114-1142 ----
	CHECK(SkidSurfaceOf("road1") == SKID_TARMAC && SkidSurfaceOf("ASPHALT") == SKID_TARMAC && SkidSurfaceOf("") == SKID_TARMAC);
	CHECK(SkidSurfaceOf("GRAS2") == SKID_DIRT && SkidSurfaceOf("roadgras") == SKID_DIRT && SkidSurfaceOf("Dirt_a") == SKID_DIRT);
	CHECK(SkidSurfaceOf("mud3") == SKID_DIRT && SkidSurfaceOf("SOIL") == SKID_DIRT && SkidSurfaceOf("3DMROAD1") == SKID_DIRT);
	CHECK(SkidSurfaceOf("sandy") == SKID_SAND && SkidSurfaceOf("DESERT_2") == SKID_SAND);
	CHECK(SkidSurfaceOf("snow1") == SKID_SNOW && SkidSurfaceOf("SNOWROAD") == SKID_SNOW);
	CHECK(SkidSurfaceOf("noskid_road") == SKID_NONE && SkidSurfaceOf("NOSKID") == SKID_NONE);
	CHECK(SkidSurfaceOf("snow_dirt") == SKID_DIRT); // dirt is asked before snow
	// only the plain surface squeals: dirt, sand and snow have no sound at all
	CHECK(SKID_TARMAC != SKID_DIRT && SKID_TARMAC != SKID_SAND && SKID_TARMAC != SKID_SNOW);

	// ---- the mark's gate: re:1085-1112 (the squeal plays only while it is true) ----
	{
		// braking at 100 u/s on the ground, not the first time, in gear 3
		CHECK(MarkGate(true, false, 3, 100.0f, 0, true, false, false, 0.0f, false));
		// the revs falling (the flag 2, NOT the throttle) at 100 u/s
		CHECK(MarkGate(true, false, 3, 100.0f, 2, false, false, false, 0.0f, false));
		// throttle held at steady revs (the flag 0): no mark
		CHECK(!MarkGate(true, false, 3, 100.0f, 0, false, false, false, 0.0f, false));
		// at 200 u/s or more the accelerating/braking clause is off ...
		CHECK(!MarkGate(true, false, 3, 200.0f, 2, true, false, false, 0.0f, false));
		// ... but the handbrake and a lost traction still lay one at any speed over 25
		CHECK(MarkGate(true, false, 3, 300.0f, 0, false, true, false, 0.0f, false));
		CHECK(MarkGate(true, false, 3, 300.0f, 0, false, false, true, 0.0f, false));
		CHECK(!MarkGate(true, false, 3, 25.0f, 0, false, true, false, 0.0f, false)); // 25 is not over 25
		// a slide (|temp_vec[YAW]| over 0.45) at any speed, but not while reversing
		CHECK(MarkGate(true, false, 3, 300.0f, 0, false, false, false, 0.5f, false));
		CHECK(MarkGate(true, false, 3, 300.0f, 0, false, false, false, -0.5f, false));
		CHECK(!MarkGate(true, false, 3, 300.0f, 0, false, false, false, 0.5f, true));
		CHECK(!MarkGate(true, false, 3, 300.0f, 0, false, false, false, 0.45f, false));
		// never in the air, on the first pass, or in neutral
		CHECK(!MarkGate(false, false, 3, 100.0f, 0, true, false, false, 0.0f, false));
		CHECK(!MarkGate(true, true, 3, 100.0f, 0, true, false, false, 0.0f, false));
		CHECK(!MarkGate(true, false, 0, 100.0f, 0, true, false, false, 0.0f, false));
	}

	// ---- the backfire: re:1546-1556 and in:893-896, re:304-305 ----
	{
		// the forward key while the last frame's flag was 2 and the last rpms over 140
		CHECK(BackfireOnThrottle(true, 2, 141.0f));
		CHECK(!BackfireOnThrottle(true, 2, 140.0f));
		CHECK(!BackfireOnThrottle(true, 0, 200.0f));
		CHECK(!BackfireOnThrottle(false, 2, 200.0f));
		// a downshift only: the gear fell
		CHECK(BackfireOnDownshift(3, 2) && !BackfireOnDownshift(2, 2) && !BackfireOnDownshift(2, 3));
		Backfire b;
		float fade = -1.0f;
		// nothing raised: nothing plays
		CHECK(!BackfireFrame(b, 1.0f, fade) && fade == 0.0f);
		// raised at 1.0: plays at once (the window is 0, so 0 < 1.0), the window runs to 1.15, the flame at full
		BackfireRaise(b, 2);
		CHECK(BackfireFrame(b, 1.0f, fade) && Near(b.time, 1.15f, 1e-5f) && Near(fade, 1.0f, 1e-4f) && b.g == -2);
		// 0.075 s on: no new sound, the flame at half
		CHECK(!BackfireFrame(b, 1.075f, fade) && Near(fade, 0.5f, 1e-3f));
		// raised again at 1.1, inside the window: no sound, but the window is pushed to 1.25
		BackfireRaise(b, 1);
		CHECK(!BackfireFrame(b, 1.1f, fade) && Near(b.time, 1.25f, 1e-5f));
		// over at 1.3: the flag is cleared, and a raise at 1.31 plays again
		CHECK(!BackfireFrame(b, 1.3f, fade) && fade == 0.0f && b.g == 0);
		BackfireRaise(b, 1);
		CHECK(BackfireFrame(b, 1.31f, fade));
		CHECK(Near(kBackfireTime, 0.15f, 1e-6f));
	}

	// ---- the wall: cdll:195-204 ----
	{
		CHECK(HitFile(-50.0f) && HitFile(30.0f) && HitFile(-99.9f));   // over -100: hitwall1
		CHECK(!HitFile(-100.0f) && !HitFile(-400.0f));                 // not over -100: hitwall2
		float last = -1.0f;
		CHECK(!HitStep(0.0f, last, 5000.0f)); // no crash amount, no sound
		CHECK(HitStep(-50.0f, last, 1000.0f) && last == 1000.0f);
		CHECK(!HitStep(-50.0f, last, 1200.0f)); // inside 300 ms
		CHECK(!HitStep(-50.0f, last, 1300.0f)); // 1000 < 1300 - 300 is false
		CHECK(HitStep(-50.0f, last, 1301.0f));
		CHECK(HitStep(30.0f, last, 2000.0f)); // a positive amount (leaving the wall) is also a crash: any nonzero
		CHECK(Near(kHitVol, 0.75f, 1e-6f));
	}

	CHECK(Near(kOneShotVol, 0.7843f, 1e-3f)); // rs:134 volume * vol * 200 on a 255 scale

	// ---- the finish voice: hud:497-505 ----
	CHECK(FinishVoice(0) == FINISH_CONGRATS && FinishVoice(1) == FINISH_CONGRATS);
	CHECK(FinishVoice(2) == FINISH_SECOND && FinishVoice(3) == FINISH_THIRD);
	CHECK(FinishVoice(4) == FINISH_NEXTTIME && FinishVoice(12) == FINISH_NEXTTIME);

	// ---- the file headers' rates ----
	{
		unsigned char wav[64];
		memset(wav, 0, sizeof(wav));
		memcpy(wav, "RIFF", 4);
		memcpy(wav + 8, "WAVE", 4);
		memcpy(wav + 12, "fmt ", 4);
		wav[16] = 16; // chunk size
		wav[20] = 1;  // PCM
		wav[22] = 1;  // mono
		wav[24] = 0x22; // 22050 = 0x5622
		wav[25] = 0x56;
		wav[34] = 16; // bits
		memcpy(wav + 36, "data", 4);
		wav[40] = 4;
		int rate, ch, bits;
		CHECK(!WavScan(wav, 48, rate, ch, bits) && rate == 22050 && ch == 1 && bits == 16); // no cue chunk: Xash3D will not loop it
		CHECK(WavRate(wav, 48) == 22050 && FileRate(wav, 48) == 22050);
		// the same with a cue chunk after the data (as the staged loops have): found
		unsigned char wav2[80];
		memset(wav2, 0, sizeof(wav2));
		memcpy(wav2, wav, 48);
		memcpy(wav2 + 48, "cue ", 4);
		wav2[52] = 4;
		CHECK(WavScan(wav2, 60, rate, ch, bits) && rate == 22050);
		// 44100 = 0xAC44, 48000 = 0xBB80
		wav[24] = 0x44;
		wav[25] = 0xAC;
		CHECK(WavRate(wav, 48) == 44100);
		wav[24] = 0x80;
		wav[25] = 0xBB;
		CHECK(WavRate(wav, 48) == 48000);
		// not a wave: 0
		CHECK(WavRate((const unsigned char*)"not a wave file at all", 22) == 0);
		// an mp3: HL Rally's 206_engine.mp3 starts ff fb 90 c4 (MPEG 1 layer III 128 kbps 44.1 kHz)
		const unsigned char mp3[] = {0xff, 0xfb, 0x90, 0xc4, 0, 0, 0, 0};
		CHECK(Mp3Rate(mp3, 8) == 44100 && FileRate(mp3, 8) == 44100);
		// 48 kHz is the index 1 of MPEG 1 (0x94), 32 kHz index 2 (0x98); MPEG 2 (ff f3) 22.05 kHz
		const unsigned char m48[] = {0xff, 0xfb, 0x94, 0xc4};
		const unsigned char m32[] = {0xff, 0xfb, 0x98, 0xc4};
		const unsigned char m22[] = {0xff, 0xf3, 0x90, 0xc4};
		CHECK(Mp3Rate(m48, 4) == 48000 && Mp3Rate(m32, 4) == 32000 && Mp3Rate(m22, 4) == 22050);
		// after an ID3v2 tag of 10 bytes (a header only, size 0) and some padding
		const unsigned char tagged[] = {'I', 'D', '3', 3, 0, 0, 0, 0, 0, 2, 0, 0, 0xff, 0xfb, 0x90, 0xc4};
		CHECK(Mp3Rate(tagged, sizeof(tagged)) == 44100);
		const unsigned char junk[] = {1, 2, 3, 4, 5, 6, 7, 8};
		CHECK(FileRate(junk, 8) == 0);
	}

	printf("%d checks, %d failed\n", g_checked, g_failed);
	if (g_failed == 0)
		printf("PASS: rally sounds arithmetic\n");
	return g_failed == 0 ? 0 : 1;
}
