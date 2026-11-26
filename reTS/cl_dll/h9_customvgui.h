// ---- h9_customvgui: H9's purple look, or The Specialists 3.0's own -----------------------------------------------------------------------
// h9_customvgui (saved, 1 as shipped). 1: H9's purple, as before. 0: TS 3.0's own colours and font (the values: h9_customvgui_rules.h):
//  - TS's own VGUI (its menus, the scoreboard, the team and class windows): the colours of Half-Life's text scheme files, which TS 3.0
//    uses, and Arial (vgui_SchemeManager.cpp); VGUI's sc_secondary3, the one scheme colour the viewport leaves to VGUI, is VGUI's own grey
//    (vgui_TeamFortressViewport.cpp). These are made once, with the viewport, when the game starts: a change is seen at the next start.
//  - H9's own panels, everything H9's VGUI draws (the menus, the notices, the match bar, Apollo RP's HUD and windows, the chat
//    bubbles, the marks): TS 3.0's HUD grey-blue in place of the purple, with white text (h9_theme.h, PanelText), at once.
//  - The TS HUD and its crosshair: TS 3.0's own colour where hud_r, hud_g and hud_b are H9's purple (ts_hud.cpp), at once.
//  - The console and chat text: Xash's own colour where con_color is H9's purple (Frame), at once.
// The main menu is the engine's own (H9's mainui) and stays as it is.
#pragma once

#include "hud.h"
#include "cl_util.h"
#include "h9_customvgui_rules.h"

namespace h9customvgui
{
inline cvar_t*& Cvar()
{
	static cvar_t* c = nullptr;
	return c;
}

// The cvar; once, from H9Vgui_Init (HUD_Init), so the engine finds it when it runs config.cfg.
inline void Init()
{
	Cvar() = CVAR_CREATE("h9_customvgui", "1", FCVAR_ARCHIVE);
}

// h9_customvgui is 0 now.
inline bool Stock()
{
	cvar_t* c = Cvar() ? Cvar() : gEngfuncs.pfnGetCvarPointer("h9_customvgui");
	return c != nullptr && c->value == 0.0f;
}

// The text colour of H9's own panels (vgui_H9Panel.cpp, h9_arphud.cpp, h9_chatbubble.cpp) with h9_customvgui 0: white, on TS 3.0's
// grey-blue. True when it gave the colour; false with h9_customvgui 1, where the text scheme's colour stands.
inline bool PanelText(int& r, int& g, int& b)
{
	if (!Stock())
		return false;
	r = 255;
	g = 255;
	b = 255;
	return true;
}

// h9_customvgui as the game started, for what is made once with the viewport. Xash makes the viewport (HUD_VidInit) before it runs
// config.cfg, so the value saved there is read from the file itself; without one, the cvar's own. Asked once, then held.
inline bool StockAtStart()
{
	static int held = -1;
	if (held < 0)
	{
		int saved = -1;
		int len = 0;
		char* text = (char*)gEngfuncs.COM_LoadFile("config.cfg", 5, &len);
		if (text)
		{
			saved = SavedValue(text, len);
			gEngfuncs.COM_FreeFile(text);
		}
		held = saved >= 0 ? (saved == 0 ? 1 : 0) : (Stock() ? 1 : 0);
	}
	return held == 1;
}

// Every client frame (HUD_Frame), in the menu too: the console colour, and a line when h9_customvgui changes. con_color is checked each
// frame because userconfig.cfg sets H9's purple a few frames after the start.
inline void Frame()
{
	static int last = -1;
	const int mode = Stock() ? 0 : 1;
	cvar_t* con = gEngfuncs.pfnGetCvarPointer("con_color");
	if (con != nullptr && con->string != nullptr)
	{
		if (mode == 0 && SameColour(con->string, CON_H9))
			gEngfuncs.Cvar_Set("con_color", CON_STOCK);
		else if (mode == 1 && last == 0 && SameColour(con->string, CON_STOCK))
			gEngfuncs.Cvar_Set("con_color", CON_H9);
	}
	if (last >= 0 && mode != last)
	{
		gEngfuncs.Con_Printf(mode == 0
								 ? "h9_customvgui 0: The Specialists 3.0's own colours. H9's panels, the HUD and the console change now; TS's own "
								   "menus and scoreboard the next time the game starts.\n"
								 : "h9_customvgui 1: H9's purple. H9's panels, the HUD and the console change now; TS's own menus and "
								   "scoreboard the next time the game starts.\n");
	}
	last = mode;
}
} // namespace h9customvgui
