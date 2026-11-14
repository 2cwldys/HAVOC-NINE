// ---- H9 VGUI: the colour of the panels, the arithmetic --------------------------------------------------------------------------------
// H9's panels are purple: the art of sprites/tsm_panel.spr and tsm_banner.spr, the rail, the headings, the highlights, the inventory window.
// A player may give them another colour (h9_theme.h: cl_h9_vgui_r, _g and _b), and this is how a purple of H9's becomes it. The colour the
// player names is the colour of the highlight band, 138 66 196 as shipped. A colour of H9's drawing that is one of its purples (a hue from
// 248 to 284 degrees, and not a grey) is moved to the hue of the player's colour and its saturation is scaled by the player's colour's over
// the shipped one's, at its own lightness. So the shipped colour leaves every colour as it was, a grey takes the colour out of the panels,
// and what is not a purple (a warning's red, a need's green and yellow, a team's colour, the pictures of items) is not touched.
//
// No engine here: tests\test_theme.cpp builds this file alone.
#pragma once

#include <math.h>

namespace h9theme
{
const int SHIPPED_R = 138, SHIPPED_G = 66, SHIPPED_B = 196; // the colour of the highlight band, H9's purple
const float PURPLE_HUE_LO = 248.0f, PURPLE_HUE_HI = 284.0f; // degrees: the hues of H9's purples run from 255 to 275
const float PURPLE_SAT_MIN = 0.08f;                         // below it a colour is a grey

inline int ClampInt(int v, int lo, int hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

inline float ClampFloat(float v, float lo, float hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

// The colour as hue (degrees, 0 to 360), saturation and lightness (0 to 1).
inline void ToHsl(int r, int g, int b, float& h, float& s, float& l)
{
	const float fr = r / 255.0f, fg = g / 255.0f, fb = b / 255.0f;
	const float mx = fr > fg ? (fr > fb ? fr : fb) : (fg > fb ? fg : fb);
	const float mn = fr < fg ? (fr < fb ? fr : fb) : (fg < fb ? fg : fb);
	l = (mx + mn) * 0.5f;
	const float d = mx - mn;
	if (d < 0.0001f)
	{
		h = 0.0f;
		s = 0.0f;
		return;
	}
	s = l > 0.5f ? d / (2.0f - mx - mn) : d / (mx + mn);
	if (mx == fr)
		h = (fg - fb) / d + (fg < fb ? 6.0f : 0.0f);
	else if (mx == fg)
		h = (fb - fr) / d + 2.0f;
	else
		h = (fr - fg) / d + 4.0f;
	h *= 60.0f;
}

inline float HslChannel(float p, float q, float t)
{
	if (t < 0.0f)
		t += 1.0f;
	if (t > 1.0f)
		t -= 1.0f;
	if (t < 1.0f / 6.0f)
		return p + (q - p) * 6.0f * t;
	if (t < 0.5f)
		return q;
	if (t < 2.0f / 3.0f)
		return p + (q - p) * (2.0f / 3.0f - t) * 6.0f;
	return p;
}

inline void FromHsl(float h, float s, float l, int& r, int& g, int& b)
{
	if (s <= 0.0f)
	{
		r = g = b = ClampInt((int)(l * 255.0f + 0.5f), 0, 255);
		return;
	}
	const float q = l < 0.5f ? l * (1.0f + s) : l + s - l * s;
	const float p = 2.0f * l - q;
	const float hk = h / 360.0f;
	r = ClampInt((int)(HslChannel(p, q, hk + 1.0f / 3.0f) * 255.0f + 0.5f), 0, 255);
	g = ClampInt((int)(HslChannel(p, q, hk) * 255.0f + 0.5f), 0, 255);
	b = ClampInt((int)(HslChannel(p, q, hk - 1.0f / 3.0f) * 255.0f + 0.5f), 0, 255);
}

// How the purples move for a player's colour.
struct Shift
{
	bool identity;     // the shipped colour: nothing moves
	float hue;         // degrees added to a purple's hue
	float saturation;  // what a purple's saturation is multiplied by
};

inline Shift ShiftFor(int r, int g, int b)
{
	Shift sh;
	r = ClampInt(r, 0, 255);
	g = ClampInt(g, 0, 255);
	b = ClampInt(b, 0, 255);
	sh.identity = (r == SHIPPED_R && g == SHIPPED_G && b == SHIPPED_B);
	sh.hue = 0.0f;
	sh.saturation = 1.0f;
	if (sh.identity)
		return sh;

	float hp, sp, lp, ht, st, lt;
	ToHsl(SHIPPED_R, SHIPPED_G, SHIPPED_B, hp, sp, lp);
	ToHsl(r, g, b, ht, st, lt);
	if (st < 0.02f) // a grey has no hue: the panels lose their colour
	{
		sh.saturation = 0.0f;
		return sh;
	}
	sh.hue = ht - hp;
	sh.saturation = st / sp;
	return sh;
}

// A colour of H9's drawing, moved by the shift if it is one of H9's purples; any other colour is left as it is.
inline void Move(const Shift& sh, int& r, int& g, int& b)
{
	if (sh.identity)
		return;
	float h, s, l;
	ToHsl(r, g, b, h, s, l);
	if (s < PURPLE_SAT_MIN || h < PURPLE_HUE_LO || h > PURPLE_HUE_HI)
		return;
	h = fmodf(h + sh.hue, 360.0f);
	if (h < 0.0f)
		h += 360.0f;
	s = ClampFloat(s * sh.saturation, 0.0f, 1.0f);
	FromHsl(h, s, l, r, g, b);
}
} // namespace h9theme
