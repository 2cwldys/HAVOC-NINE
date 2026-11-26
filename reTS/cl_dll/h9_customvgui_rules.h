// ---- h9_customvgui: the rules, without the engine ----------------------------------------------------------------------------------------
// What h9_customvgui 0 changes, as values: the colours H9 put in place of The Specialists 3.0's own, and the reading of a saved config. No
// engine call here, so tests\test_customvgui.cpp runs it as it is; h9_customvgui.h applies it.
#pragma once

#include <stdlib.h>

namespace h9customvgui
{
// TS 3.0's HUD grey-blue (its config.cfg's hud_r, hud_g and hud_b): the colour H9's own panels take in place of the purple
// (h9_theme.h), with white text (PanelText in h9_customvgui.h).
const int STOCK_R = 125;
const int STOCK_G = 150;
const int STOCK_B = 165;

// The three colours H9's text scheme files (TSM\textscheme\*_textscheme.txt) carry in place of Half-Life's (valve\*_textscheme.txt, which
// TS 3.0 uses: it ships none of its own). Every other colour in the files is Half-Life's already.
struct SchemeSwap
{
	unsigned char h9[4];
	unsigned char stock[4];
};

const SchemeSwap SCHEME_SWAPS[] = {
	{{223, 213, 245, 255}, {255, 170, 0, 255}}, // the text (FgColor)
	{{26, 14, 40, 141}, {0, 0, 0, 141}},        // behind it (BgColor)
	{{138, 66, 196, 67}, {255, 170, 0, 67}},    // a lit row (BgColorArmed)
};

// A colour of a text scheme file as TS 3.0 has it: one of H9's three is put back, any other is left as it is.
inline void StockSchemeColour(unsigned char c[4])
{
	for (const SchemeSwap& s : SCHEME_SWAPS)
	{
		if (c[0] == s.h9[0] && c[1] == s.h9[1] && c[2] == s.h9[2] && c[3] == s.h9[3])
		{
			c[0] = s.stock[0];
			c[1] = s.stock[1];
			c[2] = s.stock[2];
			c[3] = s.stock[3];
			return;
		}
	}
}

// The face a scheme asks VGUI for, as TS 3.0 draws it. On Windows H9's fonts.txt (ts\resource\fonts) draws the face "Arial" as Square
// 721; Windows gives "Helvetica" as Arial itself (its font substitutes), which fonts.txt does not name, so Arial is asked for as Helvetica.
// Elsewhere fonts.txt is not read, and a face is asked for as it is.
inline const char* StockFace(const char* face)
{
#ifdef _WIN32
	const char* arial = "arial";
	int i = 0;
	for (; face[i] && arial[i]; i++)
	{
		const char c = (face[i] >= 'A' && face[i] <= 'Z') ? (char)(face[i] - 'A' + 'a') : face[i];
		if (c != arial[i])
			return face;
	}
	if (!face[i] && !arial[i])
		return "Helvetica";
#endif
	return face;
}

// The TS HUD colour (hud_r, hud_g, hud_b, and its crosshair) as TS 3.0 shows it: H9's purple, which H9XASH's userconfig.cfg sets at every
// start, is TS 3.0's own, which its config.cfg carries; any other colour is the player's own and stays.
const int HUD_H9_R = 190, HUD_H9_G = 160, HUD_H9_B = 255;
const int HUD_STOCK_R = 125, HUD_STOCK_G = 150, HUD_STOCK_B = 165;

inline void StockHudColour(int& r, int& g, int& b)
{
	if (r == HUD_H9_R && g == HUD_H9_G && b == HUD_H9_B)
	{
		r = HUD_STOCK_R;
		g = HUD_STOCK_G;
		b = HUD_STOCK_B;
	}
}

// The console and chat text (con_color): H9's purple, which userconfig.cfg sets, and Xash's own.
const char* const CON_H9 = "190 140 255";
const char* const CON_STOCK = "240 180 24";

// The colour "r g b" (as con_color holds it) is the colour `want` ("r g b").
inline bool SameColour(const char* have, const char* want)
{
	int h[3], w[3];
	char* end = nullptr;
	const char* p = have;
	const char* q = want;
	for (int i = 0; i < 3; i++)
	{
		h[i] = (int)strtol(p, &end, 10);
		if (end == p)
			return false;
		p = end;
		w[i] = (int)strtol(q, &end, 10);
		if (end == q)
			return false;
		q = end;
	}
	while (*p == ' ' || *p == '\t')
		p++;
	return *p == 0 && h[0] == w[0] && h[1] == w[1] && h[2] == w[2];
}

// The h9_customvgui a config file saves (the engine writes it as: h9_customvgui "0"), in the first `len` bytes of `text`: 0, 1 for any
// other number, or -1 when the file sets none. The last line that sets it counts, as the engine runs them in order; a comment does not.
inline int SavedValue(const char* text, int len)
{
	const char* name = "h9_customvgui";
	const int nameLen = 13;
	int value = -1;
	int i = 0;
	while (i < len)
	{
		int start = i;
		while (i < len && text[i] != '\n')
			i++;
		int end = i; // the line is [start, end)
		i++;
		while (start < end && (text[start] == ' ' || text[start] == '\t'))
			start++;
		if (end - start <= nameLen)
			continue;
		bool same = true;
		for (int k = 0; k < nameLen && same; k++)
		{
			const char c = text[start + k];
			same = ((c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c) == name[k];
		}
		const char after = text[start + nameLen];
		if (!same || (after != ' ' && after != '\t' && after != '"'))
			continue;
		int p = start + nameLen;
		while (p < end && (text[p] == ' ' || text[p] == '\t' || text[p] == '"'))
			p++;
		char number[16];
		int n = 0;
		while (p < end && n < 15 && ((text[p] >= '0' && text[p] <= '9') || text[p] == '.' || text[p] == '-'))
			number[n++] = text[p++];
		number[n] = 0;
		if (n > 0)
			value = atof(number) == 0.0 ? 0 : 1;
	}
	return value;
}
} // namespace h9customvgui
