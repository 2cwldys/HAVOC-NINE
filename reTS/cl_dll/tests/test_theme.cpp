// Tests of h9_theme_math.h: how a purple of H9's becomes the player's colour. No engine.
// Build: cl /std:c++17 /EHsc test_theme.cpp   (D:\temp\build_theme_test.bat)

#include "../h9_theme_math.h"

#include <stdio.h>
#include <stdlib.h>

using namespace h9theme;

static int g_checks = 0;
static int g_fails = 0;

#define CHECK(cond)                                                                    \
	do                                                                                 \
	{                                                                                  \
		g_checks++;                                                                    \
		if (!(cond))                                                                   \
		{                                                                              \
			g_fails++;                                                                 \
			printf("FAIL line %d: %s\n", __LINE__, #cond);                             \
		}                                                                              \
	} while (0)

struct Rgb
{
	int r, g, b;
};

// H9's purples: the colours of sprites/tsm_panel.spr and tsm_banner.spr, and of the constants of the panels, the ARP HUD and the inventory window.
static const Rgb kPurples[] = {
	{33, 30, 39}, {45, 40, 52}, {60, 54, 70}, {22, 19, 26}, {16, 10, 24}, {8, 7, 10}, {182, 145, 234}, {78, 56, 107}, {133, 98, 178},
	{138, 66, 196}, {166, 154, 192}, {140, 128, 164}, {223, 213, 245}, {235, 230, 245}, {14, 10, 24}, {240, 236, 250},
};

// What is not a purple of H9's: warnings, a need's bar, a team's colour, black, white, greys.
static const Rgb kOthers[] = {
	{236, 96, 96}, {96, 200, 120}, {236, 204, 84}, {0, 0, 255}, {0, 0, 200}, {255, 0, 0}, {255, 255, 255}, {0, 0, 0}, {128, 128, 128}, {200, 200, 200},
	{30, 144, 255}, {255, 140, 0}, {0, 255, 255},
};

static int Diff(int a, int b)
{
	return a > b ? a - b : b - a;
}

static float HueDiff(float a, float b)
{
	float d = a > b ? a - b : b - a;
	return d > 180.0f ? 360.0f - d : d;
}

int main()
{
	const int nPurples = (int)(sizeof(kPurples) / sizeof(kPurples[0]));
	const int nOthers = (int)(sizeof(kOthers) / sizeof(kOthers[0]));

	// the shipped colour moves nothing
	{
		const Shift sh = ShiftFor(138, 66, 196);
		CHECK(sh.identity);
		for (int i = 0; i < nPurples; i++)
		{
			int r = kPurples[i].r, g = kPurples[i].g, b = kPurples[i].b;
			Move(sh, r, g, b);
			CHECK(r == kPurples[i].r && g == kPurples[i].g && b == kPurples[i].b);
		}
	}

	// the arithmetic itself: to hsl and back is the same colour, to within a step of a channel
	for (int i = 0; i < nPurples; i++)
	{
		float h, s, l;
		ToHsl(kPurples[i].r, kPurples[i].g, kPurples[i].b, h, s, l);
		int r, g, b;
		FromHsl(h, s, l, r, g, b);
		CHECK(Diff(r, kPurples[i].r) <= 1 && Diff(g, kPurples[i].g) <= 1 && Diff(b, kPurples[i].b) <= 1);
		// H9's purples are in the hues the test takes for them, and are not greys
		CHECK(h >= PURPLE_HUE_LO && h <= PURPLE_HUE_HI);
		CHECK(s >= PURPLE_SAT_MIN);
	}
	for (int i = 0; i < nOthers; i++)
	{
		float h, s, l;
		ToHsl(kOthers[i].r, kOthers[i].g, kOthers[i].b, h, s, l);
		int r, g, b;
		FromHsl(h, s, l, r, g, b);
		CHECK(Diff(r, kOthers[i].r) <= 1 && Diff(g, kOthers[i].g) <= 1 && Diff(b, kOthers[i].b) <= 1);
	}

	// a green: every purple is a green of its own lightness, and nothing else moves
	{
		const Shift sh = ShiftFor(60, 200, 90);
		CHECK(!sh.identity);
		float ht, st, lt;
		ToHsl(60, 200, 90, ht, st, lt);
		for (int i = 0; i < nPurples; i++)
		{
			float h0, s0, l0;
			ToHsl(kPurples[i].r, kPurples[i].g, kPurples[i].b, h0, s0, l0);
			int r = kPurples[i].r, g = kPurples[i].g, b = kPurples[i].b;
			Move(sh, r, g, b);
			float h, s, l;
			ToHsl(r, g, b, h, s, l);
			CHECK(g >= r && g >= b);                 // the green channel leads
			CHECK(HueDiff(h, ht) <= 20.0f);          // the player's hue, each purple keeping its distance from the band's (255 to 275 degrees)
			CHECK(l > l0 - 0.01f && l < l0 + 0.01f); // the colour's own lightness
		}
		for (int i = 0; i < nOthers; i++)
		{
			int r = kOthers[i].r, g = kOthers[i].g, b = kOthers[i].b;
			Move(sh, r, g, b);
			CHECK(r == kOthers[i].r && g == kOthers[i].g && b == kOthers[i].b);
		}
	}

	// the highlight band's colour becomes the player's colour, hue and saturation (the lightness is the band's own)
	{
		const Rgb targets[] = {{40, 160, 255}, {255, 40, 40}, {255, 105, 180}, {230, 200, 20}, {20, 220, 200}, {110, 110, 160}};
		for (int t = 0; t < (int)(sizeof(targets) / sizeof(targets[0])); t++)
		{
			const Shift sh = ShiftFor(targets[t].r, targets[t].g, targets[t].b);
			int r = 138, g = 66, b = 196;
			Move(sh, r, g, b);
			float h, s, l, ht, st, lt;
			ToHsl(r, g, b, h, s, l);
			ToHsl(targets[t].r, targets[t].g, targets[t].b, ht, st, lt);
			CHECK(HueDiff(h, ht) < 3.0f);
			CHECK(s > st - 0.03f && s < st + 0.03f);
		}
	}

	// a grey, a white and a black take the colour out: every purple is a grey of its own lightness
	{
		const Rgb greys[] = {{128, 128, 128}, {255, 255, 255}, {0, 0, 0}, {40, 40, 40}};
		for (int t = 0; t < (int)(sizeof(greys) / sizeof(greys[0])); t++)
		{
			const Shift sh = ShiftFor(greys[t].r, greys[t].g, greys[t].b);
			CHECK(!sh.identity);
			for (int i = 0; i < nPurples; i++)
			{
				float h0, s0, l0;
				ToHsl(kPurples[i].r, kPurples[i].g, kPurples[i].b, h0, s0, l0);
				int r = kPurples[i].r, g = kPurples[i].g, b = kPurples[i].b;
				Move(sh, r, g, b);
				CHECK(r == g && g == b);
				CHECK(Diff(r, (int)(l0 * 255.0f + 0.5f)) <= 1);
			}
			for (int i = 0; i < nOthers; i++)
			{
				int r = kOthers[i].r, g = kOthers[i].g, b = kOthers[i].b;
				Move(sh, r, g, b);
				CHECK(r == kOthers[i].r && g == kOthers[i].g && b == kOthers[i].b);
			}
		}
	}

	// the edges of H9's purples: a hue just outside is left alone, one just inside moves; a grey with a trace of colour is a grey
	{
		const Shift sh = ShiftFor(60, 200, 90);
		int r, g, b;
		FromHsl(246.0f, 0.5f, 0.5f, r, g, b);
		int r2 = r, g2 = g, b2 = b;
		Move(sh, r2, g2, b2);
		CHECK(r2 == r && g2 == g && b2 == b);
		FromHsl(252.0f, 0.5f, 0.5f, r, g, b);
		r2 = r;
		g2 = g;
		b2 = b;
		Move(sh, r2, g2, b2);
		CHECK(!(r2 == r && g2 == g && b2 == b));
		int gr = 120, gg = 121, gb = 123; // a grey that leans to blue by less than the minimum saturation
		const int r3 = gr, g3 = gg, b3 = gb;
		Move(sh, gr, gg, gb);
		CHECK(gr == r3 && gg == g3 && gb == b3);
	}

	// no value of the player's makes a colour outside 0 to 255, or the same colour twice from a pair that differs by a whole hue
	{
		const int vals[] = {-50, 0, 1, 64, 138, 255, 300, 100000};
		for (int a = 0; a < 8; a++)
		{
			for (int c = 0; c < 8; c++)
			{
				const Shift sh = ShiftFor(vals[a], vals[c], vals[(a + c) % 8]);
				for (int i = 0; i < nPurples; i++)
				{
					int r = kPurples[i].r, g = kPurples[i].g, b = kPurples[i].b;
					Move(sh, r, g, b);
					CHECK(r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255);
				}
			}
		}
	}

	printf("%d checks, %d failed\n", g_checks, g_fails);
	return g_fails ? 1 : 0;
}
