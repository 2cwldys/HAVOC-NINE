// ---- H9 ARP inventory and exchange: the engine's part ----------------------------------------------------------------------------
// h9_arpinv.h is the outline; the model and the rules of the clicks are h9_arpinv_model.h and h9_arpinv_ui.h, the drawing h9_arpinv_draw.h.
// Here: the two messages, the canvas that draws with FillRGBA and the HUD font (so the web client compiles this file as it is), the
// cursor, the mouse, the keys and the commands.
//
// An item's tile shows its picture: a 32 x 32 frame of sprites/h9_arpicons.spr named in sprites/h9_arpicons.txt (one line a picture: the
// item's name, a bar, the frame number; modelling/arpicons/make_arpicons.py makes both). An item with no picture there is a monogram in a
// colour of its name.

#include "hud.h"
#include "cl_util.h"
#include "ts_hud.h"
#include "cl_entity.h"
#include "keydefs.h"
#include "vgui_TeamFortressViewport.h"
#include "player_info.h"
#include "h9_arpinv.h"
#include "h9_arpinv_draw.h"
#include "h9_theme.h" // the colour the player gives H9's panels in place of the purple

#include <stdio.h>
#include <string.h>

void IN_GetMousePos(int* mx, int* my);
extern int mouse_oldbuttonstate; // inputw32.cpp: the mouse buttons as the last IN_MouseEvent saw them
bool TS_VGUIMenuUp();            // vgui_TeamFortressViewport.cpp: a VGUI window that owns the cursor is up

namespace
{
using namespace arpinv;

const int MSG_MAX = 192;         // bytes a message of the server may have
const int MSG_RATE = 64;         // messages a second that are read
const int CMD_RATE = 10;         // commands a second that are sent
const float NEAR_RANGE = 170.0f; // units: who the SHOW TO list names

Model s_md;
Ui s_ui;
cvar_t* s_cvWant;
bool s_bInited = false;

float s_flMsgStart = 0.0f;
int s_iMsgCount = 0;
float s_flCmdStart = 0.0f;
int s_iCmdCount = 0;
int s_iPrevButtons = 0;
int s_iIgnoreButtons = 0;
int s_iDescAsked = 0;
float s_flDescAt = -100.0f;

// the pictures of items, where there are any
HSPRITE s_hIcons = 0;
struct IconName
{
	char name[NAME_LEN];
	int frame;
};
IconName s_icons[256];
int s_nIcons = 0;

void LoadIcons()
{
	s_hIcons = 0;
	s_nIcons = 0;
	byte* data = gEngfuncs.COM_LoadFile((char*)"sprites/h9_arpicons.txt", 5, nullptr);
	if (!data)
		return;
	s_hIcons = SPR_Load("sprites/h9_arpicons.spr");
	const char* p = (const char*)data;
	while (*p && s_nIcons < (int)(sizeof(s_icons) / sizeof(s_icons[0])))
	{
		char line[96];
		int l = 0;
		while (*p && *p != '\n' && *p != '\r')
		{
			if (l < (int)sizeof(line) - 1)
				line[l++] = *p;
			p++;
		}
		line[l] = 0;
		while (*p == '\n' || *p == '\r')
			p++;
		char* bar = strchr(line, '|');
		if (!bar || line[0] == '/' || line[0] == '#')
			continue;
		*bar = 0;
		IconName& ic = s_icons[s_nIcons];
		strncpy(ic.name, line, NAME_LEN - 1);
		ic.name[NAME_LEN - 1] = 0;
		ic.frame = atoi(bar + 1);
		s_nIcons++;
	}
	gEngfuncs.COM_FreeFile(data);
}

// ---- the canvas: this client's own drawing -------------------------------------------------------------------------------------

struct EngineCanvas : InvCanvas
{
	// Every colour is taken in the colour the player has given H9's panels (h9_theme.h: a purple moves, a red, green or yellow does not).
	// The engine's pfnFillRGBA adds the colour to the picture (additive), so a dark box darkens nothing and the world shows through the
	// window; pfnFillRGBABlend blends by the alpha, which is what the boxes of the window are drawn for. An engine without it keeps the old call.
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
	int IconFrame(const char* name) override
	{
		if (s_hIcons == 0)
			return -1;
		for (int i = 0; i < s_nIcons; i++)
			if (0 == strcmp(s_icons[i].name, name))
				return s_icons[i].frame;
		return -1;
	}
	void Icon(int frame, int x, int y) override
	{
		SPR_Set(s_hIcons, 255, 255, 255);
		SPR_DrawHoles(frame, x, y, nullptr); // index 255 is transparent
	}
};
EngineCanvas s_Canvas;

int MeasureHook(const char* s)
{
	return s_Canvas.TextW(s);
}

InvLayout CurrentLayout()
{
	return BuildLayout(s_md, ScreenWidth, ScreenHeight, s_Canvas.CharH(), s_ui.scroll, s_ui.sScroll, &s_ui.win);
}

// ---- commands ---------------------------------------------------------------------------------------------------------------------

void SendNow(const char* text)
{
	char cmd[128];
	snprintf(cmd, sizeof(cmd), "%s", text);
	gEngfuncs.pfnServerCmd(cmd);
}

void FlushCommands()
{
	const float now = gHUD.m_flTime;
	if (now - s_flCmdStart >= 1.0f || now < s_flCmdStart)
	{
		s_flCmdStart = now;
		s_iCmdCount = 0;
	}
	int sent = 0;
	while (sent < s_ui.nout && s_iCmdCount < CMD_RATE)
	{
		SendNow(s_ui.out[sent].text);
		s_iCmdCount++;
		sent++;
	}
	// what the second's budget could not carry waits for the next frame
	for (int i = sent; i < s_ui.nout; i++)
		s_ui.out[i - sent] = s_ui.out[i];
	s_ui.nout -= sent;
}

// ---- open and close ---------------------------------------------------------------------------------------------------------------

void UpdateCursor()
{
	if (gViewPort)
		gViewPort->UpdateCursorState();
}

void CloseWindow(bool tell)
{
	if (s_md.open && tell)
		SendNow("h9inv close"); // the server ends a search that was open with it
	s_md.open = false;
	s_md.ClearSearch();
	s_ui.Reset();
	s_iPrevButtons = 0;
	s_iIgnoreButtons = 0;
	UpdateCursor();
}

void ProcessUi()
{
	if (s_ui.wantClose)
	{
		s_ui.wantClose = false;
		if (s_md.trade.open)
			SendNow("h9inv x cancel");
		CloseWindow(true);
		return;
	}
	if (s_ui.wantSearchClose)
	{
		// the player ended the search (its command is in the queue): the window goes at once, and the server's answer finds nothing open
		s_ui.wantSearchClose = false;
		s_md.ClearSearch();
		s_ui.EndSearch();
	}
	FlushCommands();
}

// ---- the messages -----------------------------------------------------------------------------------------------------------------

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

int __MsgFunc_H9Inv(const char* pszName, int iSize, void* pbuf)
{
	if (!MessageAllowed(iSize) || !H9ArpInv_Wanted())
		return 1;
	const bool wasOpen = s_md.open;
	const bool opened = s_md.OnInv(pbuf, iSize, gHUD.m_flTime);
	if (opened && !wasOpen)
	{
		s_ui.Reset();
		s_iPrevButtons = mouse_oldbuttonstate;
		s_iIgnoreButtons = mouse_oldbuttonstate; // a button that was down when the window came up is not a click on it
		UpdateCursor();
	}
	else if (wasOpen && !s_md.open)
	{
		s_ui.Reset();
		UpdateCursor();
	}
	return 1;
}

int __MsgFunc_H9Trade(const char* pszName, int iSize, void* pbuf)
{
	if (!MessageAllowed(iSize) || !H9ArpInv_Wanted())
		return 1;
	const bool opened = s_md.OnTrade(pbuf, iSize, gHUD.m_flTime);
	if (opened && s_md.trade.open && !s_md.open)
		SendNow("h9inv open"); // the exchange needs the inventory to drag from: the snapshot opens the window
	return 1;
}

int __MsgFunc_H9Search(const char* pszName, int iSize, void* pbuf)
{
	if (!MessageAllowed(iSize) || !H9ArpInv_Wanted())
		return 1;
	const bool opened = s_md.OnSearch(pbuf, iSize, gHUD.m_flTime);
	if (opened)
	{
		// a search of another player, or the snapshot sent again: his cells are new, so what the window held of the last ones goes
		s_ui.EndSearch();
		if (!s_md.open)
			SendNow("h9inv open"); // the search stands beside the inventory: the snapshot opens the window
	}
	else if (!s_md.search.open)
	{
		s_ui.EndSearch(); // a CLOSE
	}
	return 1;
}

// ---- who is near ------------------------------------------------------------------------------------------------------------------

int NearPlayers(Near* out, int max)
{
	cl_entity_t* lp = gEngfuncs.GetLocalPlayer();
	if (!lp)
		return 0;
	int n = 0;
	const int maxClients = gEngfuncs.GetMaxClients();
	for (int i = 1; i <= maxClients && n < max; i++)
	{
		if (i == lp->index)
			continue;
		cl_entity_t* e = gEngfuncs.GetEntityByIndex(i);
		if (!e || !e->player || !g_PlayerInfoList[i].name || !g_PlayerInfoList[i].name[0])
			continue;
		if (e->curstate.messagenum < lp->curstate.messagenum) // not in this frame's view: out of range or sight
			continue;
		const Vector d = e->origin - lp->origin;
		if (d.Length() > NEAR_RANGE)
			continue;
		out[n].index = i;
		strncpy(out[n].name, g_PlayerInfoList[i].name, NAME_LEN - 1);
		out[n].name[NAME_LEN - 1] = 0;
		n++;
	}
	return n;
}

// ---- the HUD element --------------------------------------------------------------------------------------------------------------

class CHudH9ArpInv : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE; // always: the element has the invitation and the result to draw as well
		return true;
	}
	bool VidInit() override
	{
		// a new map is a new server: no window carries over, and the catalog is forgotten (the server sends it again on open)
		const bool wasOpen = s_md.open;
		s_md.Clear();
		s_ui.Reset();
		s_iPrevButtons = 0;
		s_iIgnoreButtons = 0;
		s_iDescAsked = 0;
		LoadIcons();
		if (wasOpen)
			UpdateCursor();
		return true;
	}
	void InitHUDData() override
	{
		const bool wasOpen = s_md.open;
		s_md.Clear();
		s_ui.Reset();
		if (wasOpen)
			UpdateCursor();
	}
	void Think() override
	{
		const float now = gHUD.m_flTime;
		if (s_md.open)
		{
			// the window is not for the dead, the spectators or an intermission
			if (TSHud_PlayerPartsHidden() || gHUD.m_iIntermission)
			{
				CloseWindow(true);
				return;
			}
			const InvLayout L = CurrentLayout();
			int mx = 0, my = 0;
			IN_GetMousePos(&mx, &my);
			s_ui.MouseMove(s_md, L, mx, my);
			// the description of the selected item, asked for once
			if (s_ui.selected >= 0 && s_ui.selected < MAX_CELLS && s_md.cells[s_ui.selected].kind != 0)
			{
				const Kind* k = s_md.FindKind(s_md.cells[s_ui.selected].kind);
				if (k && !k->haveDesc && (s_iDescAsked != k->id || now - s_flDescAt > 4.0f))
				{
					char cmd[40];
					snprintf(cmd, sizeof(cmd), "h9inv info %d", k->id);
					SendNow(cmd);
					s_iDescAsked = k->id;
					s_flDescAt = now;
				}
			}
			ProcessUi();
		}
		// an invitation or a result that has run its time is gone
		if (s_md.trade.invite && !s_md.trade.open && now > s_md.trade.inviteUntil)
			s_md.trade.invite = false;
		if (s_md.trade.result && now > s_md.trade.resultUntil)
			s_md.trade.result = false;
	}
	bool Draw(float flTime) override
	{
		InvPainter p(s_Canvas, s_md, s_ui, flTime);
		p.DrawAll();
		return true;
	}
};
CHudH9ArpInv s_Hud;

// ---- the commands -----------------------------------------------------------------------------------------------------------------

void CmdToggle()
{
	if (!H9ArpInv_Wanted())
	{
		gEngfuncs.Con_Printf("cl_h9_arpinv is 0: Apollo RP's inventory stays the text menu (say /inventory)\n");
		return;
	}
	if (s_md.open)
		CloseWindow(true);
	else
		SendNow("h9inv open");
}

void CmdAccept()
{
	SendNow("h9inv x accept");
}

void CmdDecline()
{
	SendNow("h9inv x decline");
}

void CmdState()
{
	gEngfuncs.Con_Printf("ARP inventory: %s; cl_h9_arpinv %d; %d H9Inv, %d H9Trade and %d H9Search message(s) read, %d refused\n", s_md.open ? "OPEN" : "closed",
		s_cvWant ? (int)s_cvWant->value : 1, s_md.msgsInv, s_md.msgsTrade, s_md.msgsSearch, s_md.msgsBad);
	if (s_md.msgsInv == 0)
		gEngfuncs.Con_Printf("  no H9Inv message has been read on this map (the server has no inventory window: arp_h9_inv_window or arp_h9_vgui is 0, or this is not a roleplay map)\n");
	else
		gEngfuncs.Con_Printf("  cells %d, used %d, wallet %d, bank %d, credits %d; last H9Inv op %d, last H9Trade op %d\n", s_md.slots, s_md.Used(), s_md.wallet, s_md.bank,
			s_md.credits ? 1 : 0, s_md.lastOpInv, s_md.lastOpTrade);
	gEngfuncs.Con_Printf("  exchange: %s%s\n", s_md.trade.open ? "OPEN with " : "none", s_md.trade.open ? s_md.trade.partner : "");
	gEngfuncs.Con_Printf("  search: %s%s", s_md.search.open ? "OPEN on " : "none", s_md.search.open ? s_md.search.name : "");
	if (s_md.search.open)
		gEngfuncs.Con_Printf(" (%d cells, %d with something%s)", s_md.search.cells, s_md.SearchUsed(), s_md.search.over ? ", over capacity" : "");
	gEngfuncs.Con_Printf("; last H9Search op %d\n", s_md.lastOpSearch);
}
} // namespace

// ---- the hooks --------------------------------------------------------------------------------------------------------------------

void H9ArpInv_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvWant = CVAR_CREATE("cl_h9_arpinv", "1", FCVAR_ARCHIVE);
	g_textW = MeasureHook;
	g_nearPlayers = NearPlayers;
	gEngfuncs.pfnHookUserMsg("H9Inv", __MsgFunc_H9Inv);
	gEngfuncs.pfnHookUserMsg("H9Trade", __MsgFunc_H9Trade);
	gEngfuncs.pfnHookUserMsg("H9Search", __MsgFunc_H9Search);
	gEngfuncs.pfnAddCommand("cl_h9_inventory", CmdToggle);
	gEngfuncs.pfnAddCommand("cl_h9_trade_accept", CmdAccept);
	gEngfuncs.pfnAddCommand("cl_h9_trade_decline", CmdDecline);
	gEngfuncs.pfnAddCommand("cl_h9_arpinv_state", CmdState);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

bool H9ArpInv_IsUp()
{
	return s_md.open;
}

bool H9ArpInv_Wanted()
{
	return s_cvWant == nullptr || s_cvWant->value != 0.0f;
}

void H9ArpInv_HandleMouse(int buttons)
{
	if (!s_md.open)
		return;
	const int changed = buttons ^ s_iPrevButtons;
	const int pressed = changed & buttons;
	const int released = changed & ~buttons;
	s_iPrevButtons = buttons;
	const int ignored = s_iIgnoreButtons;
	s_iIgnoreButtons &= buttons; // a button let go is no longer ignored

	int mx = 0, my = 0;
	IN_GetMousePos(&mx, &my);
	const InvLayout L = CurrentLayout();
	const float now = gHUD.m_flTime;
	s_ui.MouseMove(s_md, L, mx, my);
	for (int b = 0; b < 2; b++)
	{
		const int bit = 1 << b;
		if ((pressed & bit) && !(ignored & bit))
			s_ui.MouseDown(s_md, L, b, mx, my, now);
		if ((released & bit) && !(ignored & bit))
			s_ui.MouseUp(s_md, L, b, mx, my, now);
	}
	ProcessUi();
}

bool H9ArpInv_KeyInput(bool down, int keynum)
{
	if (keynum == K_SHIFT)
	{
		s_ui.shift = down;
		return false; // the game sees shift as well
	}
	if (!s_md.open)
		return false;

	KeyId key = IK_NONE;
	int digit = 0;
	if (keynum == K_ESCAPE)
		key = IK_ESC;
	else if (keynum == K_ENTER || keynum == K_KP_ENTER)
		key = IK_ENTER;
	else if (keynum == K_BACKSPACE)
		key = IK_BACK;
	else if (keynum == K_MWHEELUP)
		key = IK_WHEEL_UP;
	else if (keynum == K_MWHEELDOWN)
		key = IK_WHEEL_DOWN;
	else if (keynum >= '0' && keynum <= '9')
	{
		key = IK_DIGIT;
		digit = keynum - '0';
	}
	if (key == IK_NONE)
		return false;

	// a key goes to the window on its press; the release of a key the window took goes nowhere
	if (!down)
		return (key == IK_ESC || key == IK_ENTER || key == IK_BACK || key == IK_WHEEL_UP || key == IK_WHEEL_DOWN ||
			(key == IK_DIGIT && (s_ui.popup == POP_SPLIT || s_ui.editMoney)));
	const InvLayout L = CurrentLayout();
	const bool taken = s_ui.Key(s_md, L, key, digit);
	ProcessUi();
	return taken;
}
// ---- end H9 ARP inventory ---------------------------------------------------------------------------------------------------------
