// ---- H9 VGUI: the colour of the panels, the cvars ------------------------------------------------------------------------------------
// cl_h9_vgui_r, cl_h9_vgui_g and cl_h9_vgui_b (0 to 255, saved) are the colour a player gives H9's panels in place of the purple: the
// colour of the highlight band, 138 66 196 as shipped (h9_theme_math.h says how every purple of H9's drawing follows it). cl_h9_vgui_color
// sets the three at once: "cl_h9_vgui_color 40 160 255", "cl_h9_vgui_color #28a0ff", "cl_h9_vgui_color default", and prints them with no
// argument. The cvars are read through a settle time, so a colour typed as three commands is one change, and a change is made once:
// Generation() counts them, for what is made once for a colour (the panel art, vgui_H9Panel.cpp). Every H9 drawing that goes through
// CH9Surface (vgui_H9Panel.cpp), and the inventory window's canvas (h9_arpinv.cpp), takes its colours through Tint().
#pragma once

#include "hud.h"
#include "cl_util.h"
#include "h9_theme_math.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace h9theme
{
const float SETTLE = 0.4f; // seconds the cvars must keep a value before the panels take it

struct State
{
	bool started;
	int applied;      // 0xRRGGBB the colours are moved to now
	int pending;      // what the cvars say; once it has held for SETTLE it is applied
	float pendingAt;  // client time it was first seen
	int generation;   // how many colours have been applied
	Shift shift;
	cvar_t* r;
	cvar_t* g;
	cvar_t* b;
};

inline State& Held()
{
	static State s = {};
	return s;
}

inline int PackColour(int r, int g, int b)
{
	return (ClampInt(r, 0, 255) << 16) | (ClampInt(g, 0, 255) << 8) | ClampInt(b, 0, 255);
}

// The cvars and the command; once, from H9Vgui_Init.
inline void CmdColour()
{
	State& s = Held();
	const int argc = gEngfuncs.Cmd_Argc();
	int r = -1, g = -1, b = -1;
	bool shown = false;
	if (argc >= 4)
	{
		r = atoi(gEngfuncs.Cmd_Argv(1));
		g = atoi(gEngfuncs.Cmd_Argv(2));
		b = atoi(gEngfuncs.Cmd_Argv(3));
	}
	else if (argc == 2)
	{
		const char* a = gEngfuncs.Cmd_Argv(1);
		char word[16];
		int n = 0;
		for (; a[n] && n < 15; n++)
			word[n] = (a[n] >= 'A' && a[n] <= 'Z') ? (char)(a[n] - 'A' + 'a') : a[n];
		word[n] = 0;
		unsigned int rgb = 0;
		if (0 == strcmp(word, "default") || 0 == strcmp(word, "reset"))
		{
			r = SHIPPED_R;
			g = SHIPPED_G;
			b = SHIPPED_B;
		}
		else if (word[0] == '#' && n == 7 && 1 == sscanf(word + 1, "%6x", &rgb))
		{
			r = (int)((rgb >> 16) & 255);
			g = (int)((rgb >> 8) & 255);
			b = (int)(rgb & 255);
		}
		else
		{
			shown = true; // not a colour: say what the command takes
		}
	}
	else
	{
		shown = true;
	}

	if (shown || r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
	{
		const int cr = s.r ? (int)(s.r->value + 0.5f) : SHIPPED_R;
		const int cg = s.g ? (int)(s.g->value + 0.5f) : SHIPPED_G;
		const int cb = s.b ? (int)(s.b->value + 0.5f) : SHIPPED_B;
		gEngfuncs.Con_Printf("cl_h9_vgui_color: the colour of H9's panels is %d %d %d (shipped %d %d %d).\n"
							 "  cl_h9_vgui_color <r> <g> <b> (each 0 to 255), cl_h9_vgui_color #rrggbb or cl_h9_vgui_color default;\n"
							 "  the same as the cvars cl_h9_vgui_r, cl_h9_vgui_g and cl_h9_vgui_b.\n",
			cr, cg, cb, SHIPPED_R, SHIPPED_G, SHIPPED_B);
		return;
	}
	char value[8];
	snprintf(value, sizeof(value), "%d", r);
	gEngfuncs.Cvar_Set("cl_h9_vgui_r", value);
	snprintf(value, sizeof(value), "%d", g);
	gEngfuncs.Cvar_Set("cl_h9_vgui_g", value);
	snprintf(value, sizeof(value), "%d", b);
	gEngfuncs.Cvar_Set("cl_h9_vgui_b", value);
}

inline void Init()
{
	State& s = Held();
	s.r = CVAR_CREATE("cl_h9_vgui_r", "138", FCVAR_ARCHIVE);
	s.g = CVAR_CREATE("cl_h9_vgui_g", "66", FCVAR_ARCHIVE);
	s.b = CVAR_CREATE("cl_h9_vgui_b", "196", FCVAR_ARCHIVE);
	gEngfuncs.pfnAddCommand("cl_h9_vgui_color", CmdColour);
}

inline void Use(State& s, int key)
{
	s.applied = key;
	s.shift = ShiftFor((key >> 16) & 255, (key >> 8) & 255, key & 255);
	s.generation++;
}

// Reads the cvars: the colour they name is applied once it has stood for SETTLE seconds (the first one at once).
inline void Refresh()
{
	State& s = Held();
	if (!s.r || !s.g || !s.b)
	{
		s.r = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui_r");
		s.g = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui_g");
		s.b = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui_b");
	}
	const int key = (s.r && s.g && s.b) ? PackColour((int)(s.r->value + 0.5f), (int)(s.g->value + 0.5f), (int)(s.b->value + 0.5f))
										: PackColour(SHIPPED_R, SHIPPED_G, SHIPPED_B);
	const float now = gEngfuncs.GetClientTime();
	if (!s.started)
	{
		s.started = true;
		s.pending = key;
		s.pendingAt = now;
		Use(s, key);
		return;
	}
	if (key == s.applied)
	{
		s.pending = key;
		return;
	}
	if (key != s.pending || now < s.pendingAt)
	{
		s.pending = key;
		s.pendingAt = now;
		return;
	}
	if (now - s.pendingAt >= SETTLE)
		Use(s, key);
}

// The number of colours applied since the game began: the art is made again when it changes.
inline int Generation()
{
	Refresh();
	return Held().generation;
}

// A colour of H9's drawing as the player's: one of H9's purples is moved, any other colour is left as it is.
inline void Tint(int& r, int& g, int& b)
{
	Refresh();
	Move(Held().shift, r, g, b);
}

// The same without reading the cvars again: for a loop over many colours after one Generation() or Tint().
inline void TintHeld(int& r, int& g, int& b)
{
	Move(Held().shift, r, g, b);
}
} // namespace h9theme
