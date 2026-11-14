// ---- H9 ARP inventory and exchange: the engine's part ----------------------------------------------------------------------------
// h9_arpinv.h is the outline; the model and the rules of the clicks are h9_arpinv_model.h and h9_arpinv_ui.h, the drawing h9_arpinv_draw.h.
// Here: the two messages, the canvas that draws with FillRGBA and the HUD font (so the web client compiles this file as it is), the
// cursor, the mouse, the keys and the commands.
//
// An item's tile shows its picture: a 32 x 32 frame of sprites/h9_arpicons.spr named in sprites/h9_arpicons.txt (one line a picture: the
// item's name, a bar, the frame number; modelling/arpicons/make_arpicons.py makes both; h9_arpinv_icons.h reads the list). An item with no
// picture there is a monogram in a colour of its name. The list and the sheet are read in this element's VidInit, which CHud::VidInit calls by
// name (H9ArpInv_VidInit): the elements that register through AddHudElem are not members of CHud, and its VidInit does not walk the list.

#include "hud.h"
#include "cl_util.h"
#include "ts_hud.h"
#include "cl_entity.h"
#include "keydefs.h"
#include "vgui_TeamFortressViewport.h"
#include "player_info.h"
#include "h9_arpinv.h"
#include "h9_arpinv_draw.h"
#include "h9_arpinv_icons.h"
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
const char* const ICONS_SHEET = "sprites/h9_arpicons.spr";
const char* const ICONS_LIST = "sprites/h9_arpicons.txt";
HSPRITE s_hIcons = 0;    // the sheet; 0 when it, or the list that names its frames, could not be had
IconList s_icons;        // the names of the frames
int s_iIconsBytes = -1;  // the size of the list's file, -1 when it could not be read
int s_iIconFrames = 0;   // the frames the engine says the sheet has
int s_iIconsRead = 0;    // times the list and the sheet have been asked for since the game started: a map's start, a restart of the video

// Reads the list and the sheet. A name whose frame is not one of the sheet's is not kept (its tile is a monogram), and a list with no sheet gives no
// picture at all.
void LoadIcons()
{
	s_iIconsRead++;
	s_hIcons = 0;
	s_iIconFrames = 0;
	s_iIconsBytes = -1;
	s_icons.Clear();
	int len = 0;
	byte* data = gEngfuncs.COM_LoadFile((char*)ICONS_LIST, 5, &len);
	if (!data)
		return;
	s_iIconsBytes = len;
	s_hIcons = SPR_Load(ICONS_SHEET);
	s_iIconFrames = s_hIcons ? SPR_Frames(s_hIcons) : 0;
	s_icons.Parse((const char*)data, s_iIconFrames > 0 ? s_iIconFrames : -1);
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
	int IconFrame(const char* name) override { return s_hIcons == 0 ? -1 : s_icons.Find(name); }
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

// ---- the test window --------------------------------------------------------------------------------------------------------------

// cl_h9_arpinv_test draws, for a few seconds and by the very painter the window is drawn with, a window of tiles of a handful of items and one of an item
// that has no picture: what the pictures look like in this engine, with no server and no item needed.
struct TestWindow
{
	Model md;
	Ui ui;
	float until;
};
TestWindow* s_pTest = nullptr;

void EndTest()
{
	delete s_pTest;
	s_pTest = nullptr;
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
		EndTest();
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
		if (s_pTest)
		{
			if (flTime >= s_pTest->until || s_md.open)
			{
				EndTest();
			}
			else
			{
				InvPainter t(s_Canvas, s_pTest->md, s_pTest->ui, flTime);
				t.DrawAll();
			}
		}
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

bool SameNoCase(const char* a, const char* b)
{
	for (; *a && *b; a++, b++)
	{
		if (tolower((unsigned char)*a) != tolower((unsigned char)*b))
			return false;
	}
	return *a == *b;
}

// What the window knows of the pictures: whether the list and the sheet were had, the room a tile gives a picture, which of the items the server has named
// have one, the first tiles of the window, and, for a name the command was given, how that name comes out.
void PrintPictures(const char* asked)
{
	if (s_iIconsRead == 0)
		gEngfuncs.Con_Printf("  pictures: not read yet: the list and the sheet are read when a map starts (the HUD's VidInit), and that has not run\n");
	else if (s_iIconsBytes < 0)
		gEngfuncs.Con_Printf("  pictures: NONE: %s could not be read, so every tile is a monogram (read %d time(s))\n", ICONS_LIST, s_iIconsRead);
	else if (s_hIcons == 0)
		gEngfuncs.Con_Printf("  pictures: NONE: %s (%d bytes) was read but the sheet %s could not be loaded, so every tile is a monogram (read %d time(s))\n", ICONS_LIST,
			s_iIconsBytes, ICONS_SHEET, s_iIconsRead);
	else
		gEngfuncs.Con_Printf("  pictures: %s is sprite %d with %d frame(s) of %d x %d; %s (%d bytes) names %d item(s), %d refused; read %d time(s)\n", ICONS_SHEET, (int)s_hIcons,
			s_iIconFrames, SPR_Width(s_hIcons, 0), SPR_Height(s_hIcons, 0), ICONS_LIST, s_iIconsBytes, s_icons.count, s_icons.refused, s_iIconsRead);

	const int ch = s_Canvas.CharH();
	const InvMetrics m = MetricsFor(ScreenHeight, ch);
	const IRect tile(0, 0, m.tile, m.tile);
	const int lines = NameLines(tile, ch);
	const IRect beside = PictureArea(tile, ch, lines);
	const int layout = PictureLayout(tile, ch, true);
	gEngfuncs.Con_Printf("  a tile is %d px on this %d x %d screen and the HUD font %d px high: %d x %d is left for a picture over %d line(s) of the name and %d x %d without them (it needs %d x %d): %s\n",
		m.tile, ScreenWidth, ScreenHeight, ch, beside.w, beside.h, lines, PictureArea(tile, ch, 0).w, PictureArea(tile, ch, 0).h, ICON_PX - 4, ICON_PX - 8,
		layout == PIC_WITH_NAME ? "the picture stands over the name" : (layout == PIC_ALONE ? "the picture stands alone, the name is left out" : "no room: a monogram"));

	char list[200];
	list[0] = 0;
	int named = 0, without = 0;
	for (int i = 0; i < MAX_KINDS; i++)
	{
		const Kind& k = s_md.kinds[i];
		if (!k.used)
			continue;
		named++;
		if (s_Canvas.IconFrame(k.name) >= 0)
			continue;
		without++;
		if (strlen(list) + strlen(k.name) + 3 < sizeof(list))
		{
			if (list[0])
				strcat(list, ", ");
			strcat(list, k.name);
		}
	}
	if (named)
		gEngfuncs.Con_Printf("  the server has named %d item(s) on this map: %d with a picture, %d without%s%s\n", named, named - without, without, without ? ": " : "", list);

	char tiles[200];
	tiles[0] = 0;
	int shown = 0;
	for (int i = 0; i < s_md.slots && i < MAX_CELLS && shown < 5; i++)
	{
		if (s_md.cells[i].kind == 0)
			continue;
		const char* nm = s_md.KindName(s_md.cells[i].kind);
		const int f = s_Canvas.IconFrame(nm);
		const size_t used = strlen(tiles);
		if (used + 48 >= sizeof(tiles))
			break;
		if (f >= 0)
			snprintf(tiles + used, sizeof(tiles) - used, "%s%s -> frame %d", shown ? ", " : "", nm, f);
		else
			snprintf(tiles + used, sizeof(tiles) - used, "%s%s -> none", shown ? ", " : "", nm);
		shown++;
	}
	if (shown)
		gEngfuncs.Con_Printf("  the first tiles: %s\n", tiles);

	if (asked[0])
	{
		const int frame = s_Canvas.IconFrame(asked);
		if (frame >= 0)
		{
			gEngfuncs.Con_Printf("  \"%s\": frame %d of %d, so its tile shows that picture\n", asked, frame, s_iIconFrames);
		}
		else
		{
			char mono[3];
			Monogram(asked, mono);
			const char* spelled = nullptr;
			for (int i = 0; i < s_icons.count; i++)
			{
				if (SameNoCase(s_icons.entries[i].name, asked))
					spelled = s_icons.entries[i].name;
			}
			if (s_hIcons == 0)
				gEngfuncs.Con_Printf("  \"%s\": no picture, because none are loaded; its tile is the monogram \"%s\"\n", asked, mono);
			else if (spelled)
				gEngfuncs.Con_Printf("  \"%s\": no picture, the list spells it \"%s\" and compares names exactly; its tile is the monogram \"%s\"\n", asked, spelled, mono);
			else
				gEngfuncs.Con_Printf("  \"%s\": no picture, the list has no such name; its tile is the monogram \"%s\"\n", asked, mono);
		}
	}
}

// cl_h9_arpinv_state [item name]
void CmdState()
{
	gEngfuncs.Con_Printf("ARP inventory: %s; cl_h9_arpinv %d; %d H9Inv, %d H9Trade and %d H9Search message(s) read, %d refused\n", s_md.open ? "OPEN" : "closed",
		s_cvWant ? (int)s_cvWant->value : 1, s_md.msgsInv, s_md.msgsTrade, s_md.msgsSearch, s_md.msgsBad);
	char asked[NAME_LEN];
	asked[0] = 0;
	for (int i = 1; i < gEngfuncs.Cmd_Argc(); i++)
	{
		const size_t used = strlen(asked);
		if (used + 2 >= sizeof(asked))
			break;
		snprintf(asked + used, sizeof(asked) - used, "%s%s", used ? " " : "", gEngfuncs.Cmd_Argv(i));
	}
	PrintPictures(asked);
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

// cl_h9_arpinv_test [seconds]: see TestWindow
void CmdTest()
{
	if (s_md.open)
	{
		gEngfuncs.Con_Printf("cl_h9_arpinv_test: close the inventory window first\n");
		return;
	}
	float seconds = 12.0f;
	if (gEngfuncs.Cmd_Argc() > 1)
		seconds = (float)atof(gEngfuncs.Cmd_Argv(1));
	seconds = seconds < 2.0f ? 2.0f : (seconds > 60.0f ? 60.0f : seconds);
	EndTest();
	s_pTest = new TestWindow;
	Model& md = s_pTest->md;
	md.open = true;
	md.credits = true;
	md.slots = 16;
	md.wallet = 1250;
	md.bank = 3130;
	snprintf(md.name, sizeof(md.name), "ICON TEST");
	snprintf(md.job, sizeof(md.job), "cl_h9_arpinv_test");
	static const char* const names[16] = {"Flashlight", "Soda", "Pizza", "Colt M4A1", "Cuffs", "Rope", "First Aid Kit", "Zippo Lighter", "9mm Parabellum Ammo", "Laser Rifle",
		"PPSh-41", "Door C2", "Lockpick", "Beer", "ATM Card", "No Such Item"};
	for (int i = 0; i < 16; i++)
	{
		md.SetKind(i + 1, 20, names[i]);
		md.cells[i].kind = i + 1;
		md.cells[i].n = (i % 3 == 1) ? i + 1 : 1;
	}
	s_pTest->until = gHUD.m_flTime + seconds;
	gEngfuncs.Con_Printf("cl_h9_arpinv_test: a window of 16 tiles for %.0f seconds; the last is an item with no picture and shows its monogram (cl_h9_arpinv_state says what is loaded)\n",
		seconds);
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
	gEngfuncs.pfnAddCommand("cl_h9_arpinv_test", CmdTest);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

void H9ArpInv_VidInit()
{
	s_Hud.VidInit();
}

bool H9ArpInv_IsUp()
{
	return s_md.open;
}

void H9ArpInv_SyncMouse(int buttons)
{
	s_iPrevButtons = buttons;
	s_iIgnoreButtons = buttons;
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
