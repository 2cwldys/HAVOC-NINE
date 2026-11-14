// ---- H9 buy window ----------------------------------------------------------------------------------------------
// The H9Buy message and what this client does with it. h9_buywindow.h is the outline; docs\LOADOUT_REWORK.txt (section 12) the protocol.
//
//   byte    op       1: a buy window is open (or its time is stated again), 2: it is over
//   short   seconds  how long the window lasts from now (op 1)
//   byte    flags    bit 0: put the equipment menu up now (op 1)
//
// The window is a state of this client: open or not, when it runs out, whether the server asked for the menu and the menu is not up
// yet, and whether the menu now up is the window's. The rules on that state are in Window and take what they need of the game in Env,
// so they can be tried without a game; the HUD element at the bottom reads the game into an Env every frame and does what Window says.
//
// What a window changes, and nothing else changes while none is open (the server opens one for a player who is alive on a side: in warmup
// and ready-up, in the freeze before a round, and after a respawn wave when loadouts are not final):
//   - the buy key (TS_Buy) puts the equipment menu up for a player who is alive and playing;
//   - a menu the window put up stays up when the weapon bar draws (it closes any other menu a living player has up), and a respawn's
//     ResetHUD does not take it down;
//   - when the server asks, the menu comes up by itself (cl_h9_buyauto 1), once the player is alive and playing, the HUD is drawn and
//     no other menu (a server's text menu such as the class menu, or a VGUI window) is up;
//   - when the window is over, or runs out, the menu it put up goes down and the cursor goes back to the game.
// A menu the spectate wait put up is never the window's: it is left to the rules it always had.
//
// Everything is the engine's own API, so the web client compiles this file as it is.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "ts_hud.h"
#include "h9_buywindow.h"

#include <string.h>
#include <stdio.h>

bool TS_VGUIMenuUp(); // vgui_TeamFortressViewport.cpp: a VGUI window that owns the cursor is up

namespace
{
const int MSG_MIN = 4;           // bytes an H9Buy message has at least: the op, the seconds, the flags
const int SECONDS_MAX = 900;     // the longest window this client believes, whatever a message says
const float MARGIN = 5.0f;       // seconds past the end the server announced that the client waits for its close
const float WANT_GAP = 3.0f;     // seconds between two requests for the menu to come up by itself that the client takes
const int MAX_RATE = 8;          // messages a second that are read; the rest are dropped

enum
{
	OP_OPEN = 1,
	OP_CLOSE = 2
};
enum
{
	FLAG_AUTO = 1
};

// What the window needs to know of the game in a frame.
struct Env
{
	float now;       // client time
	bool menuUp;     // the equipment menu is up
	bool spectating; // the local player is spectating
	bool playing;    // the local player is alive and not spectating
	bool hudShown;   // the HUD is drawn: nohud is 0, the HUD is not hidden, no intermission
	bool otherMenu;  // a server's text menu or a VGUI window is up
	bool autoOn;     // cl_h9_buyauto is not 0
};

enum Act
{
	ACT_NONE,
	ACT_OPEN_MENU,  // put the equipment menu up for the window
	ACT_CLOSE_MENU  // take the equipment menu down
};

struct Window
{
	bool open = false;         // a window is open
	float start = 0.0f;        // client time of the message that last stated it
	float expire = 0.0f;       // client time after which the client takes it as over, if no close has come
	bool want = false;         // the server asked for the menu to come up and it has not
	bool owned = false;        // the menu now up is the window's
	float lastWant = -100.0f;  // client time of the last request taken

	void Clear()
	{
		open = false;
		want = false;
		owned = false;
		start = 0.0f;
		expire = 0.0f;
		lastWant = -100.0f;
	}

	// H9Buy op 1. A request for the menu is taken at most once in WANT_GAP seconds.
	void OnOpen(int secs, int flags, float now)
	{
		if (secs < 1)
			secs = 1;
		if (secs > SECONDS_MAX)
			secs = SECONDS_MAX;
		open = true;
		start = now;
		expire = now + (float)secs + MARGIN;
		if ((flags & FLAG_AUTO) != 0 && (now - lastWant >= WANT_GAP || now < lastWant))
		{
			want = true;
			lastWant = now;
		}
	}

	// The window is over (H9Buy op 2, or it ran out): the menu it put up goes down.
	Act End()
	{
		const Act act = owned ? ACT_CLOSE_MENU : ACT_NONE;
		open = false;
		want = false;
		owned = false;
		return act;
	}

	// The menu came up for the window (by itself, or by the buy key).
	void MenuOpened()
	{
		owned = true;
		want = false;
	}

	// The menu went down, whoever closed it. A close of the window's menu is the player's answer: it is not asked for again.
	void MenuClosed()
	{
		if (owned)
		{
			owned = false;
			want = false;
		}
	}

	bool KeepsMenu() const
	{
		return open && owned;
	}

	// Once a frame while a window is open.
	Act Frame(const Env& e)
	{
		if (!open)
			return ACT_NONE;
		if (e.now > expire || e.now + 1.0f < start)
			return End();
		// A spectating player's menu is the spectate wait's, whoever put it up
		if (e.spectating)
			owned = false;
		if (!want)
			return ACT_NONE;
		if (!e.autoOn)
		{
			want = false;
			return ACT_NONE;
		}
		// Not before the player is alive and playing, the HUD is drawn and no other menu is up: the request waits
		if (!e.playing || !e.hudShown || e.otherMenu)
			return ACT_NONE;
		if (e.menuUp)
		{
			// a menu of the spectate wait that the player took into the freeze with him: it stays, as the window's
			owned = true;
			want = false;
			return ACT_NONE;
		}
		return ACT_OPEN_MENU;
	}
};

Window s_win;
cvar_t* s_cvAuto; // cl_h9_buyauto: 0 never puts the menu up by itself, 1 does when the server asks

// What the command prints of the messages read.
int s_iRead = 0;
int s_iLastOp = 0;
int s_iLastSecs = 0;
int s_iLastFlags = 0;
float s_flLastAt = 0.0f;
float s_flRateStart = 0.0f;
int s_iRateCount = 0;
bool s_bInited = false;

Env ReadEnv()
{
	Env e;
	e.now = gEngfuncs.GetClientTime();
	e.menuUp = gHUD.m_TSBuyMenu.IsUp();
	e.spectating = gHUD.m_Spectate.IsActive();
	e.playing = !TSHud_PlayerPartsHidden();
	e.hudShown = !gHUD.m_iIntermission && !TSHud_NoHud() && (gHUD.m_iHideHUDDisplay & HIDEHUD_ALL) == 0;
	e.otherMenu = gHUD.m_Menu.m_fMenuDisplayed || TS_VGUIMenuUp();
	e.autoOn = s_cvAuto == nullptr || s_cvAuto->value != 0.0f;
	return e;
}

void PutMenuUp()
{
	// a weapon select left open would take the next fire key under the menu
	gHUD.m_TSWeaponBar.CloseSelect();
	gHUD.m_TSBuyMenu.Open(true);
	if (gHUD.m_TSBuyMenu.IsUp())
		s_win.MenuOpened();
}

void Do(Act act)
{
	if (act == ACT_OPEN_MENU)
		PutMenuUp();
	else if (act == ACT_CLOSE_MENU && gHUD.m_TSBuyMenu.IsUp())
		gHUD.m_TSBuyMenu.Close();
}

// ---- the message ------------------------------------------------------------------------------------------------

int __MsgFunc_H9Buy(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < MSG_MIN)
		return 1;

	const float now = gEngfuncs.GetClientTime();
	if (now - s_flRateStart >= 1.0f || now < s_flRateStart)
	{
		s_flRateStart = now;
		s_iRateCount = 0;
	}
	if (++s_iRateCount > MAX_RATE)
		return 1;

	BEGIN_READ(pbuf, iSize);
	const int op = READ_BYTE();
	const int secs = READ_SHORT();
	const int flags = READ_BYTE();

	s_iRead++;
	s_iLastOp = op;
	s_iLastSecs = secs;
	s_iLastFlags = flags;
	s_flLastAt = now;

	if (op == OP_OPEN)
		s_win.OnOpen(secs, flags, now);
	else if (op == OP_CLOSE)
		Do(s_win.End());
	return 1;
}

// cl_h9_buywindow: what this client knows of the window, for finding out why a menu did or did not come up.
void CmdState()
{
	const float now = gEngfuncs.GetClientTime();
	gEngfuncs.Con_Printf("buy window: %s", s_win.open ? "OPEN" : "closed");
	if (s_win.open)
		gEngfuncs.Con_Printf(", %.0f s before this game takes it as over", s_win.expire - now);
	gEngfuncs.Con_Printf("\n");
	gEngfuncs.Con_Printf("  menu: %s%s; the server asked for it to come up: %s\n", gHUD.m_TSBuyMenu.IsUp() ? "up" : "down",
		s_win.KeepsMenu() ? " (the window's)" : "", s_win.want ? "yes, and it has not yet" : "no");
	gEngfuncs.Con_Printf("  cl_h9_buyauto %d; player: %s%s; other menu up: %s\n", s_cvAuto ? (int)s_cvAuto->value : 1,
		gHUD.m_Spectate.IsActive() ? "spectating" : (TSHud_PlayerPartsHidden() ? "dead" : "playing"), TSHud_NoHud() ? ", nohud" : "",
		(gHUD.m_Menu.m_fMenuDisplayed || TS_VGUIMenuUp()) ? "yes" : "no");
	if (s_iRead == 0)
		gEngfuncs.Con_Printf("  no H9Buy message has been read on this map (the server has no buy window for this game, or has the rework off)\n");
	else
		gEngfuncs.Con_Printf("  %d H9Buy message(s) read; the last, %.1f s ago: op %d, %d s, flags %d\n", s_iRead, now - s_flLastAt, s_iLastOp,
			s_iLastSecs, s_iLastFlags);
}

class CHudH9BuyWindow : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE;
		return true;
	}
	bool VidInit() override
	{
		// a new map is a new server state: no window carries over, and the menu has been closed with it (CHudTSBuyMenu::VidInit)
		s_win.Clear();
		s_iRead = 0;
		s_flRateStart = 0.0f;
		s_iRateCount = 0;
		return true;
	}
	void Think() override
	{
		if (!s_win.open)
			return;
		Do(s_win.Frame(ReadEnv()));
	}
};
CHudH9BuyWindow s_Hud;
} // namespace

// ---- the hooks --------------------------------------------------------------------------------------------------

void H9BuyWindow_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvAuto = CVAR_CREATE("cl_h9_buyauto", "1", FCVAR_ARCHIVE);
	gEngfuncs.pfnHookUserMsg("H9Buy", __MsgFunc_H9Buy);
	gEngfuncs.pfnAddCommand("cl_h9_buywindow", CmdState);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

bool H9BuyWindow_Open()
{
	return s_win.open;
}

bool H9BuyWindow_KeepsMenu()
{
	return s_win.KeepsMenu();
}

void H9BuyWindow_OpenMenu()
{
	PutMenuUp();
}

void H9BuyWindow_MenuClosed()
{
	s_win.MenuClosed();
}
// ---- end H9 buy window ------------------------------------------------------------------------------------------
