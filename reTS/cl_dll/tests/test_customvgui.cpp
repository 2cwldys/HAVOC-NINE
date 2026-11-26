// h9_customvgui's rules (h9_customvgui_rules.h), without the engine: the scheme colours put back, the face asked for, the HUD colour, the
// console colour's reading and the saved value read from a config file. Build: cl /std:c++17 /EHsc test_customvgui.cpp (Windows, where
// StockFace changes a face), or g++ -std=c++17 test_customvgui.cpp (elsewhere, where it does not).
#include "../h9_customvgui_rules.h"

#include <stdio.h>
#include <string.h>

static int g_checks = 0;
static int g_failed = 0;

static void Check(bool ok, const char* what)
{
	g_checks++;
	if (!ok)
	{
		g_failed++;
		printf("FAIL: %s\n", what);
	}
}

static bool Colour(const unsigned char c[4], int r, int g, int b, int a)
{
	return c[0] == r && c[1] == g && c[2] == b && c[3] == a;
}

static int Saved(const char* text)
{
	return h9customvgui::SavedValue(text, (int)strlen(text));
}

int main()
{
	using namespace h9customvgui;

	// the three colours H9's text scheme files carry are Half-Life's again
	unsigned char text[4] = {223, 213, 245, 255};
	StockSchemeColour(text);
	Check(Colour(text, 255, 170, 0, 255), "H9's text colour is Half-Life's orange");
	unsigned char behind[4] = {26, 14, 40, 141};
	StockSchemeColour(behind);
	Check(Colour(behind, 0, 0, 0, 141), "the colour behind the text is Half-Life's translucent black");
	unsigned char lit[4] = {138, 66, 196, 67};
	StockSchemeColour(lit);
	Check(Colour(lit, 255, 170, 0, 67), "a lit row is Half-Life's");
	// every other colour of the files is Half-Life's already and stays
	unsigned char white[4] = {255, 255, 255, 255};
	StockSchemeColour(white);
	Check(Colour(white, 255, 255, 255, 255), "the armed text's white stays");
	unsigned char clear[4] = {0, 0, 0, 0};
	StockSchemeColour(clear);
	Check(Colour(clear, 0, 0, 0, 0), "a clear colour stays");
	unsigned char nearly[4] = {223, 213, 245, 254};
	StockSchemeColour(nearly);
	Check(Colour(nearly, 223, 213, 245, 254), "a colour with another alpha is not one of H9's");
	unsigned char twice[4] = {223, 213, 245, 255};
	StockSchemeColour(twice);
	StockSchemeColour(twice);
	Check(Colour(twice, 255, 170, 0, 255), "put back twice is the same");

	// the face: Arial asked for as Helvetica on Windows only
#ifdef _WIN32
	Check(0 == strcmp(StockFace("Arial"), "Helvetica"), "Arial is asked for as Helvetica");
	Check(0 == strcmp(StockFace("arial"), "Helvetica"), "the name's case does not matter");
	Check(0 == strcmp(StockFace("ARIAL"), "Helvetica"), "upper case too");
#else
	Check(0 == strcmp(StockFace("Arial"), "Arial"), "away from Windows Arial is asked for as it is");
#endif
	Check(0 == strcmp(StockFace("Arial Black"), "Arial Black"), "another face that starts with Arial stays");
	Check(0 == strcmp(StockFace("Aria"), "Aria"), "a shorter name stays");
	Check(0 == strcmp(StockFace("Square721 BT"), "Square721 BT"), "another face stays");
	Check(0 == strcmp(StockFace(""), ""), "no name stays");

	// H9's panels take TS 3.0's HUD grey-blue
	Check(STOCK_R == HUD_STOCK_R && STOCK_G == HUD_STOCK_G && STOCK_B == HUD_STOCK_B, "the panels' colour is TS 3.0's HUD grey-blue");

	// the HUD colour: H9's purple is TS 3.0's own; any other is the player's
	int r = 190, g = 160, b = 255;
	StockHudColour(r, g, b);
	Check(r == 125 && g == 150 && b == 165, "H9's HUD purple is TS 3.0's 125 150 165");
	r = 200, g = 50, b = 50;
	StockHudColour(r, g, b);
	Check(r == 200 && g == 50 && b == 50, "a player's own HUD colour stays");
	r = 190, g = 160, b = 254;
	StockHudColour(r, g, b);
	Check(r == 190 && g == 160 && b == 254, "a colour next to the purple stays");

	// con_color as the engine holds it
	Check(SameColour("190 140 255", CON_H9), "con_color is H9's purple");
	Check(SameColour(" 190  140 255 ", CON_H9), "spaces do not matter");
	Check(!SameColour("190 140 254", CON_H9), "another colour is not");
	Check(!SameColour("190 140", CON_H9), "two numbers are not a colour");
	Check(!SameColour("190 140 255 1", CON_H9), "four numbers are not this colour");
	Check(!SameColour("", CON_H9), "nothing is not a colour");
	Check(SameColour("240 180 24", CON_STOCK), "Xash's own colour");

	// the saved value in config.cfg
	Check(Saved("") == -1, "an empty file sets none");
	Check(Saved("hud_r \"190\"\r\nh9_customvgui \"0\"\r\nvolume \"0.5\"\r\n") == 0, "the engine's line saves 0");
	Check(Saved("h9_customvgui \"1\"\n") == 1, "and 1");
	Check(Saved("h9_customvgui 0\n") == 0, "without quotes");
	Check(Saved("  H9_CUSTOMVGUI \"0\"") == 0, "indented, in capitals, at the end of the file without a line end");
	Check(Saved("h9_customvgui \"2\"\n") == 1, "any number but 0 is 1");
	Check(Saved("h9_customvgui \"0.0\"\n") == 0, "0.0 is 0");
	Check(Saved("h9_customvgui_other \"0\"\nh9_customvguis 0\n") == -1, "a longer name is another cvar");
	Check(Saved("// h9_customvgui \"0\"\n") == -1, "a comment sets nothing");
	Check(Saved("h9_customvgui \"0\"\nh9_customvgui \"1\"\n") == 1, "the last line counts");
	Check(Saved("h9_customvgui \"\"\n") == -1, "no number sets nothing");
	Check(Saved("echo h9_customvgui 0\n") == -1, "the name inside another command is not the cvar");
	const char cut[] = "h9_customvgui \"0\"";
	Check(h9customvgui::SavedValue(cut, 14) == -1, "only the bytes it is given are read");

	printf("%d checks, %d failed\n", g_checks, g_failed);
	return g_failed == 0 ? 0 : 1;
}
