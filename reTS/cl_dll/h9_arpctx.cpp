// ---- H9 ARP context menu: the engine's part -------------------------------------------------------------------------------------------------
// h9_arpctx.h is the outline; the model and the rules of the clicks are h9_arpctx_model.h and h9_arpctx_ui.h, the drawing h9_arpctx_ui.h's Painter.
// Here: the message, the canvas that draws with the engine's blended fill and the HUD font, the cursor, the mouse, the keys and the
// commands.

#include "hud.h"
#include "cl_util.h"
#include "ts_hud.h"
#include "keydefs.h"
#include "vgui_TeamFortressViewport.h"
#include "h9_arpctx.h"
#include "h9_arpctx_ui.h"
#include "h9_arpinv.h"  // H9ArpInv_SyncMouse
#include "h9_vgui.h"    // H9Vgui_SafeArea
#include "h9_theme.h"   // the colour the player gives H9's panels in place of the purple

#include <stdio.h>
#include <string.h>

void IN_GetMousePos(int* mx, int* my);
extern int mouse_oldbuttonstate; // inputw32.cpp: the mouse buttons as the last IN_MouseEvent saw them

namespace
{
using namespace arpctx;

const int MSG_RATE = 64;                // messages a second that are read
const int CMD_RATE = 10;                // commands a second that are sent
const float MAX_OPEN_SECONDS = 90.0f;   // a menu the server has not answered for this long is taken down: the server shuts every menu it knows, so this is for one it lost

Model s_md;
Ui s_ui;
cvar_t* s_cvWant;
bool s_bInited = false;
bool s_bDemo = false;       // cl_h9_ctxmenu_test: a menu of the client's own, whose choices send nothing
float s_flDemoUntil = 0.0f;

float s_flMsgStart = 0.0f;
int s_iMsgCount = 0;
float s_flCmdStart = 0.0f;
int s_iCmdCount = 0;
int s_iPrevButtons = 0;
int s_iIgnoreButtons = 0;

float UserScale()
{
	float f = CVAR_GET_FLOAT("cl_h9_vgui_scale");
	if (f <= 0.0f)
		f = 1.0f;
	return f < 0.5f ? 0.5f : (f > 2.0f ? 2.0f : f);
}

// ---- the canvas: this client's own drawing ---------------------------------------------------------------------------------------------

struct EngineCanvas : CtxCanvas
{
	// Every colour is taken in the colour the player has given H9's panels (h9_theme.h: a purple moves, a red, green or yellow does not). The engine's pfnFillRGBA
	// adds the colour to the picture, so a dark box darkens nothing; pfnFillRGBABlend blends by the alpha, which is what the boxes of the menu are drawn for.
	void Fill(int x, int y, int w, int h, int r, int g, int b, int a) override
	{
		h9theme::Tint(r, g, b);
		if (gEngfuncs.pfnFillRGBABlend)
			gEngfuncs.pfnFillRGBABlend(x, y, w, h, r, g, b, a);
		else
			FillRGBA(x, y, w, h, r, g, b, a);
	}
	void Text(int x, int y, int maxX, const char* s, int r, int g, int b) override
	{
		h9theme::Tint(r, g, b);
		TSHud_DrawString(x, y, maxX, s, r, g, b);
	}
	int TextW(const char* s) override { return TSHud_StringWidth(s); }
	int CharH() override { return gHUD.m_scrinfo.iCharHeight > 0 ? gHUD.m_scrinfo.iCharHeight : 12; }
	int Width() override { return ScreenWidth; }
	int Height() override { return ScreenHeight; }
};
EngineCanvas s_Canvas;

int MeasureHook(const char* s)
{
	return s_Canvas.TextW(s);
}

IRect SafeRect()
{
	int x0 = 0, y0 = 0, x1 = ScreenWidth, y1 = ScreenHeight;
	H9Vgui_SafeArea(x0, y0, x1, y1);
	return IRect(x0, y0, x1 - x0, y1 - y0);
}

CtxLayout CurrentLayout()
{
	return BuildLayout(s_md, ScreenWidth, ScreenHeight, s_Canvas.CharH(), UserScale(), SafeRect(), true);
}

// ---- commands --------------------------------------------------------------------------------------------------------------------------

void SendNow(const char* text)
{
	char cmd[64];
	snprintf(cmd, sizeof(cmd), "%s", text);
	gEngfuncs.pfnServerCmd(cmd);
}

// The queue goes out, a few a second. A demo menu sends nothing: a choice is said in its status line, and a close ends it.
void FlushCommands()
{
	const float now = gHUD.m_flTime;
	if (now - s_flCmdStart >= 1.0f || now < s_flCmdStart)
	{
		s_flCmdStart = now;
		s_iCmdCount = 0;
	}
	int sent = 0;
	while (sent < s_ui.nout && (s_bDemo || s_iCmdCount < CMD_RATE))
	{
		if (s_bDemo)
		{
			if (0 == strncmp(s_ui.out[sent], "h9ctx pick ", 11))
			{
				const int idx = atoi(strrchr(s_ui.out[sent], ' ') + 1);
				char text[STATUS_LEN];
				snprintf(text, sizeof(text), "Demo: you chose %s.", (idx >= 0 && idx < s_md.numRows) ? s_md.rows[idx].label : "?");
				s_md.SetStatus(text, 0, now);
			}
		}
		else
		{
			SendNow(s_ui.out[sent]);
			s_iCmdCount++;
		}
		sent++;
	}
	// what the second's budget could not carry waits for the next frame
	for (int i = sent; i < s_ui.nout; i++)
		memcpy(s_ui.out[i - sent], s_ui.out[i], sizeof(s_ui.out[i]));
	s_ui.nout -= sent;
}

// ---- open and close --------------------------------------------------------------------------------------------------------------------

void UpdateCursor()
{
	if (gViewPort)
		gViewPort->UpdateCursorState();
}

// The menu comes down. A button that is held when it does is no click on whatever lies under it (the inventory window, when it stands behind the menu).
void CloseMenu(bool tell, int buttons)
{
	if (s_md.open && tell && !s_bDemo)
	{
		char cmd[32];
		snprintf(cmd, sizeof(cmd), "h9ctx close %d", s_md.serial);
		SendNow(cmd);
	}
	s_md.Clear();
	s_ui.Reset();
	s_bDemo = false;
	s_iPrevButtons = 0;
	s_iIgnoreButtons = 0;
	H9ArpInv_SyncMouse(buttons);
	UpdateCursor();
}

void OpenedNow()
{
	s_ui.Reset();
	s_iPrevButtons = mouse_oldbuttonstate;
	s_iIgnoreButtons = mouse_oldbuttonstate; // a button that was down when the menu came up is not a click on it
	UpdateCursor();
}

// What the clicks and the keys asked for: the menu is taken down when the player closed it, and the commands go out.
void ProcessUi(int buttons)
{
	if (s_ui.wantClose)
	{
		FlushCommands();
		CloseMenu(false, buttons);
		return;
	}
	FlushCommands();
}

// ---- the message -----------------------------------------------------------------------------------------------------------------------

bool MessageAllowed(int size)
{
	if (size <= 0 || size > MSG_MAX)
		return false;
	const float now = gHUD.m_flTime;
	if (now - s_flMsgStart >= 1.0f || now < s_flMsgStart)
	{
		s_flMsgStart = now;
		s_iMsgCount = 0;
	}
	return ++s_iMsgCount <= MSG_RATE;
}

int __MsgFunc_H9Ctx(const char* pszName, int iSize, void* pbuf)
{
	if (!MessageAllowed(iSize) || !H9ArpCtx_Wanted())
		return 1;
	const bool wasOpen = s_md.open;
	const int wasSerial = s_md.serial;
	if (s_bDemo)
	{
		// the server's menu replaces the demo
		s_md.Clear();
		s_bDemo = false;
	}
	s_md.OnMessage(pbuf, iSize, gHUD.m_flTime);
	if (s_md.open && !wasOpen)
		OpenedNow();
	else if (s_md.open && s_md.serial != wasSerial)
		s_ui.Reset(); // a new page: nothing of the last is under the mouse
	else if (wasOpen && !s_md.open)
		CloseMenu(false, mouse_oldbuttonstate);
	return 1;
}

// ---- the HUD element -------------------------------------------------------------------------------------------------------------------

class CHudH9ArpCtx : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE; // always: the menu is drawn while it is open
		return true;
	}
	bool VidInit() override
	{
		// a new map is a new server: no menu carries over
		const bool wasOpen = s_md.open;
		s_md.Clear();
		s_ui.Reset();
		s_bDemo = false;
		s_iPrevButtons = 0;
		s_iIgnoreButtons = 0;
		if (wasOpen)
			UpdateCursor();
		return true;
	}
	void InitHUDData() override
	{
		const bool wasOpen = s_md.open;
		s_md.Clear();
		s_ui.Reset();
		s_bDemo = false;
		if (wasOpen)
			UpdateCursor();
	}
	void Think() override
	{
		if (!s_md.open)
			return;
		const float now = gHUD.m_flTime;
		// the menu is not for the dead, the spectators or an intermission, and not for one the server has stopped answering
		if (TSHud_PlayerPartsHidden() || gHUD.m_iIntermission || now - s_md.openedAt > MAX_OPEN_SECONDS || now < s_md.openedAt || (s_bDemo && now > s_flDemoUntil))
		{
			CloseMenu(true, mouse_oldbuttonstate);
			return;
		}
		const CtxLayout L = CurrentLayout();
		int mx = 0, my = 0;
		IN_GetMousePos(&mx, &my);
		s_ui.MouseMove(s_md, L, mx, my);
		ProcessUi(mouse_oldbuttonstate);
	}
	bool Draw(float flTime) override
	{
		if (!s_md.open)
			return true;
		Painter p(s_Canvas, s_md, s_ui, flTime, SafeRect(), UserScale());
		p.DrawAll();
		return true;
	}
};
CHudH9ArpCtx s_Hud;

// ---- the commands ----------------------------------------------------------------------------------------------------------------------

// cl_h9_ctxmenu_state
void CmdState()
{
	gEngfuncs.Con_Printf("ARP context menu: %s; cl_h9_ctxmenu %d; %d OPEN, %d ROWS, %d CLOSE and %d NOTE message(s) read, %d refused\n", s_md.open ? "OPEN" : "closed",
		s_cvWant ? (int)s_cvWant->value : 1, s_md.msgsOpen, s_md.msgsRows, s_md.msgsClose, s_md.msgsNote, s_md.msgsBad);
	if (s_md.open)
	{
		gEngfuncs.Con_Printf("  serial %d, page %d, \"%s\" (%s), %d of %d row(s)%s\n", s_md.serial, s_md.page, s_md.title, s_md.sub, s_md.numRows, s_md.announced,
			s_bDemo ? ", a demo" : "");
		for (int i = 0; i < s_md.numRows; i++)
			gEngfuncs.Con_Printf("  %2d key %2d flags %d  %-24s %s\n", i, s_md.rows[i].key, s_md.rows[i].flags, s_md.rows[i].label, s_md.rows[i].note);
		const CtxLayout L = CurrentLayout();
		gEngfuncs.Con_Printf("  the panel is %d x %d at %d, %d on a %d x %d screen\n", L.panel.w, L.panel.h, L.panel.x, L.panel.y, ScreenWidth, ScreenHeight);
	}
	else if (s_md.lastClose >= 0)
	{
		gEngfuncs.Con_Printf("  the last CLOSE said %d\n", s_md.lastClose);
	}
}

// cl_h9_ctxmenu_test [seconds]: a menu of the client's own for a few seconds, drawn by the very painter the game's is drawn by, with the cursor up; no server is needed
// and a choice sends nothing. It shows what the menu looks like with the player's colour and scale.
void CmdTest()
{
	if (s_md.open && !s_bDemo)
	{
		gEngfuncs.Con_Printf("cl_h9_ctxmenu_test: a menu of the server's is up\n");
		return;
	}
	float seconds = 20.0f;
	if (gEngfuncs.Cmd_Argc() > 1)
		seconds = (float)atof(gEngfuncs.Cmd_Argv(1));
	seconds = seconds < 2.0f ? 2.0f : (seconds > 120.0f ? 120.0f : seconds);
	DemoMenu(s_md, gHUD.m_flTime);
	s_bDemo = true;
	s_flDemoUntil = gHUD.m_flTime + seconds;
	OpenedNow();
	gEngfuncs.Con_Printf("cl_h9_ctxmenu_test: a menu of %d rows for %.0f seconds (a click or a number chooses, ESC or a right click closes; nothing is sent)\n", s_md.numRows, seconds);
}
} // namespace

// ---- the hooks -------------------------------------------------------------------------------------------------------------------------

void H9ArpCtx_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvWant = CVAR_CREATE("cl_h9_ctxmenu", "1", FCVAR_ARCHIVE);
	arpctx::g_textW = MeasureHook;
	gEngfuncs.pfnHookUserMsg("H9Ctx", __MsgFunc_H9Ctx);
	gEngfuncs.pfnAddCommand("cl_h9_ctxmenu_state", CmdState);
	gEngfuncs.pfnAddCommand("cl_h9_ctxmenu_test", CmdTest);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

void H9ArpCtx_VidInit()
{
	s_Hud.VidInit();
}

bool H9ArpCtx_IsUp()
{
	return s_md.open;
}

bool H9ArpCtx_Wanted()
{
	return s_cvWant == nullptr || s_cvWant->value != 0.0f;
}

void H9ArpCtx_HandleMouse(int buttons)
{
	if (!s_md.open)
		return;
	const int changed = buttons ^ s_iPrevButtons;
	const int pressed = changed & buttons;
	s_iPrevButtons = buttons;
	const int ignored = s_iIgnoreButtons;
	s_iIgnoreButtons &= buttons; // a button let go is no longer ignored

	int mx = 0, my = 0;
	IN_GetMousePos(&mx, &my);
	const CtxLayout L = CurrentLayout();
	const float now = gHUD.m_flTime;
	s_ui.MouseMove(s_md, L, mx, my);
	for (int b = 0; b < 2; b++)
	{
		const int bit = 1 << b;
		if ((pressed & bit) && !(ignored & bit))
			s_ui.MouseDown(s_md, L, b, mx, my, now);
	}
	ProcessUi(buttons);
}

bool H9ArpCtx_KeyInput(bool down, int keynum)
{
	if (!s_md.open)
		return false;

	KeyId key = IK_NONE;
	int digit = 0;
	if (keynum == K_ESCAPE)
		key = IK_ESC;
	else if (keynum == K_MWHEELUP || keynum == K_MWHEELDOWN)
		key = IK_WHEEL;
	else if (keynum >= '0' && keynum <= '9')
	{
		key = IK_DIGIT;
		digit = keynum - '0';
	}
	if (key == IK_NONE)
		return false;

	// a key goes to the menu on its press; the release of a key the menu took goes nowhere
	if (!down)
		return true;
	const bool taken = s_ui.Key(s_md, key, digit, gHUD.m_flTime);
	ProcessUi(mouse_oldbuttonstate);
	return taken;
}
// ---- end H9 ARP context menu -----------------------------------------------------------------------------------------------------------
