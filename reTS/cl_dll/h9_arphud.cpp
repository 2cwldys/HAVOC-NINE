// ---- H9 ARP HUD -------------------------------------------------------------------------------------------------
// Apollo RP's HUD (the text at the left of the screen: the server's title and city, the wallet, the bank, the payday, the
// salary, the job, and the lines other plugins add) as panels on H9's purple art, for a server that sends it: the H9ArpHud user
// message. h9_arphud.h is the outline; docs\APOLLO_RP.txt section 2 is what a player sees and COMMANDS.txt the switches.
//
//   byte    op: 1 the lines of one HUD, 2 one HUD taken down, 3 every HUD taken down
//   op 1    byte hud (0 to 3, ARP's HUD_PRIM to HUD_QUAT), byte the number of this content, byte part (bits 0 to 3) with bit 7 on
//           the last part, byte lines in this part, then in part 0 only: short x, short y (the server's arp_hudN_x and _y in
//           thousandths, -1 centred); then each line: byte kind, string text
//   op 2    byte hud
//
// A HUD too long for one message comes in parts of one content. What the client holds of a HUD changes when the last part has
// come, and only then, so a part that was lost leaves the HUD as it was. A server is untrusted here: the size of a message, the
// number of lines and rows, how long a notice stays and how long a HUD is kept when nothing refreshes it are this client's own
// limits, whatever a message says. The game says it draws this with the userinfo key _h9arphud, which follows cl_h9_arphud.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "ts_hud.h"
#include "vgui_TeamFortressViewport.h"
#include "h9_vgui.h"
#include "vgui_H9Panel.h"
#include "h9_arphud.h"

#include <string.h>
#include <stdio.h>

namespace
{
#define H9ARP_HUDS 4          // ARP's HUD_PRIM, HUD_SEC, HUD_TER and HUD_QUAT
#define H9ARP_NOTICE 3        // the one that is a short notice
#define H9ARP_MAX_MSG 192     // bytes an H9ArpHud message may have
#define H9ARP_MAX_RATE 48     // messages read a second
#define H9ARP_MAX_LINES 24    // lines of one HUD that are kept
#define H9ARP_LINE_LEN 192    // a line's room, with its end
#define H9ARP_MAX_ROWS 48     // rows of one panel
#define H9ARP_LIFE 150.0f     // seconds a HUD is kept when nothing refreshes it (the server sends again at least once a minute)
#define H9ARP_HOLD 3.0f       // seconds a notice stays
#define H9ARP_FADE 0.25f      // seconds a panel takes to come up or go

// The kinds of line (HUDK_* of the server's ApolloRP_HUD.inc), and the cvar of each.
enum
{
	KIND_EXTRA = 0,
	KIND_TITLE,
	KIND_WALLET,
	KIND_BANK,
	KIND_PAYDAY,
	KIND_SALARY,
	KIND_JOB,
	KIND_STATUS,
	KIND_COUNT
};

const char* const kKindCvars[KIND_COUNT] = {"cl_h9_arphud_extra", "cl_h9_arphud_title", "cl_h9_arphud_wallet", "cl_h9_arphud_bank",
	"cl_h9_arphud_payday", "cl_h9_arphud_salary", "cl_h9_arphud_job", "cl_h9_arphud_status"};
const char* const kKindWhat[KIND_COUNT] = {"the lines other plugins add: hunger, jail status, the zone, others", "the title and the city",
	"the wallet", "the bank", "the payday countdown", "the salary", "the job", "the dead, account loading and server malfunction lines"};

const char* const kPanelCvars[H9ARP_HUDS] = {"cl_h9_arphud_left", "cl_h9_arphud_top", "cl_h9_arphud_side", "cl_h9_arphud_notice"};
const char* const kPanelWhat[H9ARP_HUDS] = {"HUD 1: the title, wallet, bank, payday, salary, job and the lines other plugins add",
	"HUD 2: ARP's second HUD (stock arp.cfg: top right)", "HUD 3: ARP's third HUD (stock arp.cfg: right; the out-of-character chat)",
	"HUD 4: the short notices (what you look at, ammo loaded up, and so on)"};

// H9's purples, the values of vgui_H9Panel.cpp. The text itself is the textscheme's Primary Button Text colour (TextColour).
const int LIT_R = 182, LIT_G = 145, LIT_B = 234;   // the heading: the rail's lit purple
const int DET_R = 166, DET_G = 154, DET_B = 192;   // a label before its value
const int RAIL_R = 133, RAIL_G = 98, RAIL_B = 178; // the rail: the line under the heading

// The art scales at cl_h9_vgui_scale 1, of the screen height / 480: the panels' on the tsm_panel art, a little under the menus'
// 0.51 so a HUD that stays on the screen takes less of it, and the notice's on the tsm_banner art, as every notice is.
const float PANEL_SCALE = 0.40f;
const float NOTICE_SCALE = 0.45f;

struct Line
{
	int kind;
	char text[H9ARP_LINE_LEN];
};

// One HUD as the client holds it, and how it is drawn.
struct HudSlot
{
	bool have;        // lines are held
	int x, y;         // the server's place, in thousandths; -1 centred
	int count;
	Line lines[H9ARP_MAX_LINES];
	float at;         // client time the lines last came; a notice stays from then
	int msgs;         // contents that came whole
	// the content being put together from parts
	bool building;
	int gen;
	int expect;
	int bcount;
	int bx, by;
	Line blines[H9ARP_MAX_LINES];
	// the panel
	bool dirty;       // what it shows must be laid out again
	bool laidOut;     // it has rows to draw
	float alpha;      // 0 to 255
	int stickyWide;   // the widest it has been, in pixels, so its art does not need a new size for each number
	const char* why;  // what keeps it off the screen, for cl_h9_arphud_list
};

cvar_t* s_cvMaster;                   // cl_h9_arphud: 0 gets the text HUD
cvar_t* s_cvPanel[H9ARP_HUDS];        // cl_h9_arphud_left, _top, _side, _notice
cvar_t* s_cvKind[KIND_COUNT];         // cl_h9_arphud_extra, _title, _wallet, _bank, _payday, _salary, _job, _status
cvar_t* s_cvInfo;                     // _h9arphud: the userinfo key the server reads, 1 or 0
cvar_t* s_cvVgui;                     // cl_h9_vgui

bool s_bInited = false;
HudSlot s_Huds[H9ARP_HUDS];
float s_flLastDraw = -100.0f;
float s_flLastThink = 0.0f;
float s_flRateStart = 0.0f;
int s_iRateCount = 0;
int s_iMsgs = 0;                      // messages read since this server
int s_iDropped = 0;                   // messages refused (rate, size, off)
float s_flLastMsg = -1.0f;
int s_iScreenWide = 0, s_iScreenTall = 0;
float s_flScale = 0.0f;
unsigned int s_uiSwitches = 0xFFFFFFFFu;

inline int Max(int a, int b) { return a > b ? a : b; }
inline int Min(int a, int b) { return a < b ? a : b; }
inline int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline int Round(float f) { return (int)(f + 0.5f); }

bool On(const cvar_t* cv)
{
	return !cv || cv->value != 0.0f;
}

// The master switch, and cl_h9_vgui: a game that draws no H9 panel at all draws no HUD panel either.
bool Enabled()
{
	if (!s_cvVgui)
		s_cvVgui = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui");
	return On(s_cvMaster) && On(s_cvVgui);
}

// What the switches are now, one bit each: when it changes every panel is laid out again.
unsigned int Switches()
{
	unsigned int bits = 0;
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		if (On(s_cvPanel[i]))
			bits |= 1u << i;
	}
	for (int i = 0; i < KIND_COUNT; i++)
	{
		if (On(s_cvKind[i]))
			bits |= 1u << (H9ARP_HUDS + i);
	}
	return bits;
}

float UserScale()
{
	float f = CVAR_GET_FLOAT("cl_h9_vgui_scale");
	if (f <= 0.0f)
		f = 1.0f;
	if (f < 0.5f)
		f = 0.5f;
	if (f > 2.0f)
		f = 2.0f;
	return f;
}

// The scale of an art on this screen: base x (screen height / 480) x cl_h9_vgui_scale.
float ArtScale(float base)
{
	return ((float)ScreenHeight / 480.0f) * base * UserScale();
}

void TextColour(int& r, int& g, int& b)
{
	r = 223;
	g = 213;
	b = 245;
	if (gViewPort)
	{
		CSchemeManager* sm = gViewPort->GetSchemeManager();
		int a = 0;
		sm->getFgColor(sm->getSchemeHandle("Primary Button Text"), r, g, b, a);
	}
}

// A text's width in the font. The VGUI font measures a byte above 127 (the title's guillemets, in a Latin-1 view) as nothing,
// reading it as a negative character, though the surface draws it, so each is counted as the width of an "o".
int TextWide(vgui::Font* font, const char* text)
{
	if (!font || !text || !text[0])
		return 0;
	char run[H9ARP_LINE_LEN];
	int n = 0, wide = 0;
	const int high = H9TextWide(font, "o");
	for (const char* p = text;; p++)
	{
		const unsigned char c = (unsigned char)*p;
		if (c >= 128 || c == 0)
		{
			run[n] = 0;
			wide += H9TextWide(font, run);
			n = 0;
			if (c == 0)
				break;
			wide += high;
			continue;
		}
		if (n < (int)sizeof(run) - 1)
			run[n++] = (char)c;
	}
	return wide;
}

// ---- what a HUD says, ready to lay out ----------------------------------------------------------------------------

enum
{
	SEG_TEXT = 0,
	SEG_TITLE,
	SEG_GAP
};

struct Seg
{
	int style;
	char text[H9ARP_LINE_LEN];
};
const int MAX_SEGS = 96;

// The lines of a HUD as segments to lay out: the switch of each kind of line applied (to the first HUD, whose lines they are),
// a line split at its line breaks, the first line of the second and third HUD a heading as the first HUD's title is, every blank
// line a gap, and no gap at the ends or twice in a row.
int Collect(int hud, Seg* out, int max)
{
	const HudSlot& s = s_Huds[hud];
	int n = 0;
	bool first = true;
	for (int i = 0; i < s.count && n < max; i++)
	{
		const Line& l = s.lines[i];
		const int kind = (l.kind >= 0 && l.kind < KIND_COUNT) ? l.kind : KIND_EXTRA;
		if (hud == 0 && !On(s_cvKind[kind]))
			continue;
		const char* p = l.text;
		for (;;)
		{
			const char* e = strchr(p, '\n');
			const char* a = p;
			const char* b = e ? e : p + strlen(p);
			while (a < b && *a == ' ')
				a++;
			while (b > a && b[-1] == ' ')
				b--;
			if (n < max)
			{
				Seg& g = out[n];
				const int len = Min((int)(b - a), H9ARP_LINE_LEN - 1);
				memcpy(g.text, a, len);
				g.text[len] = 0;
				if (len == 0)
				{
					g.style = SEG_GAP;
				}
				else
				{
					const bool heading = (hud == 0) ? kind == KIND_TITLE : (hud != H9ARP_NOTICE && first);
					g.style = heading ? SEG_TITLE : SEG_TEXT;
					first = false;
				}
				if (g.style != SEG_GAP || (n > 0 && out[n - 1].style != SEG_GAP))
					n++;
			}
			if (!e)
				break;
			p = e + 1;
		}
	}
	while (n > 0 && out[n - 1].style == SEG_GAP)
		n--;
	return n;
}

// ---- the panel ----------------------------------------------------------------------------------------------------

enum
{
	ROW_TEXT = 0,
	ROW_TITLE,
	ROW_GAP,
	ROW_CONT // the second and later rows of a long text, drawn whole
};

// One HUD on H9's art: the tsm_panel art for a HUD, the tsm_banner art for the notice, the text in the textscheme's fonts (the
// "H9 Text" ladder, stepped down while the rows do not fit), a heading in the rail's lit purple with a rail under it as a menu's
// title has, a label before its value dimmer than the value. It sizes itself to its rows, within 24% of the width (the notice 40%)
// and 55% of the height, wrapping the lines that are wider and leaving out the rows that still do not fit at the smallest font.
class CH9ArpHudPanel : public CH9Surface
{
public:
	explicit CH9ArpHudPanel(bool notice) : m_bNotice(notice), m_pFont(nullptr), m_iRowTall(16), m_iRows(0)
	{
		m_bPlainBox = !notice; // the art missing: a dark box behind a HUD, nothing but a shadow behind a notice
		memset(m_Rows, 0, sizeof(m_Rows));
	}

	// Lays the segments out and sizes the panel; false when nothing is left to show. stickyWide is the widest the panel has been.
	bool Setup(const Seg* segs, int count, int& stickyWide);

protected:
	void paint() override;

private:
	struct Row
	{
		int style;
		char text[H9ARP_LINE_LEN];
	};

	void AddRow(int style, const char* text, int len)
	{
		if (m_iRows >= H9ARP_MAX_ROWS)
			return;
		Row& r = m_Rows[m_iRows++];
		r.style = style;
		len = Min(len, H9ARP_LINE_LEN - 1);
		memcpy(r.text, text, len);
		r.text[len] = 0;
	}

	void Wrap(int style, const char* text, int availW);
	void BuildRows(const Seg* segs, int count, int availW);

	// A row's height; a heading's last row has the rail under it, and a gap is half a row.
	int RowHeight(int i) const
	{
		const Row& r = m_Rows[i];
		if (r.style == ROW_GAP)
			return m_iRowTall / 2;
		int h = m_iRowTall;
		if (r.style == ROW_TITLE && (i + 1 >= m_iRows || m_Rows[i + 1].style != ROW_TITLE))
			h += m_iRowTall / 3;
		return h;
	}

	int Height() const
	{
		int h = 0;
		for (int i = 0; i < m_iRows; i++)
			h += RowHeight(i);
		return h;
	}

	bool m_bNotice;
	vgui::Font* m_pFont;
	int m_iRowTall;
	int m_iRows;
	Row m_Rows[H9ARP_MAX_ROWS];
};

// A text as rows no wider than availW: at the spaces, and a word wider than a row cut where the row ends. The first row has the
// text's style; a text's later rows are ROW_CONT, a heading's stay a heading.
void CH9ArpHudPanel::Wrap(int style, const char* text, int availW)
{
	const int contStyle = (style == ROW_TEXT) ? ROW_CONT : style;
	char cur[H9ARP_LINE_LEN];
	char cand[H9ARP_LINE_LEN];
	char piece[H9ARP_LINE_LEN];
	int curLen = 0;
	bool firstRow = true;
	cur[0] = 0;

	const char* p = text;
	while (*p)
	{
		while (*p == ' ')
			p++;
		if (!*p)
			break;
		const char* w = p;
		while (*p && *p != ' ')
			p++;
		const int wl = (int)(p - w);

		// the word at the end of this row, if it fits there
		int cl = 0;
		if (curLen)
		{
			memcpy(cand, cur, curLen);
			cl = curLen;
			cand[cl++] = ' ';
		}
		const int room = H9ARP_LINE_LEN - 1 - cl;
		if (wl <= room)
		{
			memcpy(cand + cl, w, wl);
			cl += wl;
			cand[cl] = 0;
			if (TextWide(m_pFont, cand) <= availW)
			{
				memcpy(cur, cand, cl + 1);
				curLen = cl;
				continue;
			}
		}

		// the row is full: it goes, and the word starts the next, which is cut where the word is wider than a row
		if (curLen)
		{
			AddRow(firstRow ? style : contStyle, cur, curLen);
			firstRow = false;
			curLen = 0;
			cur[0] = 0;
		}
		int start = 0;
		for (;;)
		{
			int take = Min(wl - start, H9ARP_LINE_LEN - 1);
			memcpy(piece, w + start, take);
			piece[take] = 0;
			if (TextWide(m_pFont, piece) <= availW)
			{
				memcpy(cur, piece, take + 1);
				curLen = take;
				break;
			}
			while (take > 1)
			{
				take--;
				piece[take] = 0;
				if (TextWide(m_pFont, piece) <= availW)
					break;
			}
			AddRow(firstRow ? style : contStyle, piece, take);
			firstRow = false;
			start += take;
			if (start >= wl)
				break;
		}
	}
	if (curLen)
		AddRow(firstRow ? style : contStyle, cur, curLen);
}

void CH9ArpHudPanel::BuildRows(const Seg* segs, int count, int availW)
{
	m_iRows = 0;
	for (int i = 0; i < count; i++)
	{
		if (segs[i].style == SEG_GAP)
			AddRow(ROW_GAP, "", 0);
		else
			Wrap(segs[i].style == SEG_TITLE ? ROW_TITLE : ROW_TEXT, segs[i].text, availW);
	}
	while (m_iRows > 0 && m_Rows[m_iRows - 1].style == ROW_GAP)
		m_iRows--;
}

bool CH9ArpHudPanel::Setup(const Seg* segs, int count, int& stickyWide)
{
	const CH9Art* art = CH9Art::Find(m_bNotice ? "#banner" : "#panel");
	const float s = ArtScale(m_bNotice ? NOTICE_SCALE : PANEL_SCALE);
	SetArt(art, s);

	int inL = 8, inT = 6, inR = 8, inB = 6, corner = 0;
	if (art)
	{
		inL = Round(art->insetL * s);
		inT = Round(art->insetT * s);
		inR = Round(art->insetR * s);
		inB = Round(art->insetB * s);
		corner = Round(art->corner * s);
	}
	const int maxWide = m_bNotice ? Max(160, ScreenWidth * 40 / 100) : Max(120, ScreenWidth * 24 / 100);
	const int maxTall = ScreenHeight * 55 / 100;
	const int availW = Max(40, maxWide - inL - inR);

	// The first font the rows fit in; at the smallest the rows that do not fit are left out.
	int need = 0;
	for (int step = 0; step < 4; step++)
	{
		m_pFont = H9Font(H9V_FONT_TEXT, step);
		m_iRowTall = H9FontTall(m_pFont) + H9FontTall(m_pFont) / 5;
		BuildRows(segs, count, availW);
		need = Height();
		if (need <= maxTall - inT - inB)
			break;
	}
	while (m_iRows > 1 && need > maxTall - inT - inB)
	{
		m_iRows--;
		need = Height();
	}
	while (m_iRows > 0 && m_Rows[m_iRows - 1].style == ROW_GAP)
		m_iRows--;
	if (m_iRows <= 0)
		return false;
	need = Height();

	// In steps of 16 px of width, and no narrower than it has been, so the HUDs of every length and number make few sizes of art
	// (the art keeps one bitmap for each size, for good); in steps of 8 of height.
	int widest = 0;
	for (int i = 0; i < m_iRows; i++)
	{
		if (m_Rows[i].style != ROW_GAP)
			widest = Max(widest, TextWide(m_pFont, m_Rows[i].text));
	}
	int wide = widest + inL + inR + 2;
	int tall = need + inT + inB;
	if (art)
	{
		wide = Max(wide, 2 * corner + 8);
		tall = Max(tall, 2 * corner + 4);
	}
	wide = Min((wide + 15) / 16 * 16, Max(wide, maxWide));
	wide = Max(wide, Min(stickyWide, maxWide));
	stickyWide = wide;
	tall = Min((tall + 7) / 8 * 8, Max(tall, ScreenHeight * 60 / 100));
	setSize(Max(8, wide), Max(8, tall));
	return true;
}

void CH9ArpHudPanel::paint()
{
	int x0, y0, x1, y1;
	ContentBox(x0, y0, x1, y1);
	int tr, tg, tb;
	TextColour(tr, tg, tb);
	const int fontTall = H9FontTall(m_pFont);
	const int line = Max(1, m_iRowTall / 14);

	// A notice is centred in its banner, a HUD's rows start at the top of the content box.
	int y = y0;
	if (m_bNotice)
		y = y0 + Max(0, (y1 - y0 - Height()) / 2);

	for (int i = 0; i < m_iRows; i++)
	{
		const Row& r = m_Rows[i];
		const int h = RowHeight(i);
		if (r.style == ROW_GAP)
		{
			y += h;
			continue;
		}
		const int ty = y + (m_iRowTall - fontTall) / 2;

		if (m_bNotice)
		{
			const int w = TextWide(m_pFont, r.text);
			const int x = x0 + Max(0, (x1 - x0 - w) / 2);
			if (!m_pArt)
				Text(m_pFont, x + 1, ty + 1, r.text, 0, 0, 0); // a shadow, for text over the world
			Text(m_pFont, x, ty, r.text, tr, tg, tb);
		}
		else if (r.style == ROW_TITLE)
		{
			Text(m_pFont, x0, ty, r.text, LIT_R, LIT_G, LIT_B);
			if (h > m_iRowTall)
				Box(x0, y + m_iRowTall + m_iRowTall / 8, x1, y + m_iRowTall + m_iRowTall / 8 + line, RAIL_R, RAIL_G, RAIL_B, 255);
		}
		else
		{
			// "Wallet: $500": the label dimmer than the value
			const char* colon = (r.style == ROW_TEXT) ? strstr(r.text, ": ") : nullptr;
			if (colon && (colon - r.text) <= 24 && colon[2])
			{
				char label[32];
				const int ll = (int)(colon - r.text) + 1;
				memcpy(label, r.text, ll);
				label[ll] = 0;
				Text(m_pFont, x0, ty, label, DET_R, DET_G, DET_B);
				Text(m_pFont, x0 + TextWide(m_pFont, label) + TextWide(m_pFont, " "), ty, colon + 2, tr, tg, tb);
			}
			else
			{
				Text(m_pFont, x0, ty, r.text, tr, tg, tb);
			}
		}
		y += h;
	}
}

CH9ArpHudPanel* s_pPanels[H9ARP_HUDS];
vgui::Panel* s_pParent = nullptr;

// The panels, made under the viewport the first time it exists (and again if it was replaced).
bool EnsurePanels()
{
	if (!gViewPort)
		return false;
	if (s_pParent == gViewPort && s_pPanels[0])
		return true;
	s_pParent = gViewPort;
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		s_pPanels[i] = new CH9ArpHudPanel(i == H9ARP_NOTICE);
		s_pPanels[i]->setParent(gViewPort);
		s_Huds[i].dirty = true;
	}
	return true;
}

// ---- the message ---------------------------------------------------------------------------------------------------

// Every HUD taken down, the lines and the panels both.
void ClearAll()
{
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		HudSlot& s = s_Huds[i];
		s.have = false;
		s.building = false;
		s.count = 0;
		s.dirty = true;
		s.laidOut = false;
		s.alpha = 0.0f;
		s.stickyWide = 0;
		s.why = "nothing sent";
	}
}

// A line's text: cut to its room, every character below 32 dropped except the line break. The bytes above 127 go through as they
// are: the title's guillemets are drawn if the font has them.
void ReadText(char* out, int size)
{
	const char* s = READ_STRING();
	int o = 0;
	for (; *s && o < size - 1; s++)
	{
		const unsigned char c = (unsigned char)*s;
		if (c < 32 && c != '\n')
			continue;
		out[o++] = (char)c;
	}
	out[o] = 0;
}

void OpContent(float now)
{
	const int hud = READ_BYTE();
	const int gen = READ_BYTE();
	const int partByte = READ_BYTE();
	const int count = READ_BYTE();
	const int part = partByte & 15;
	const bool last = (partByte & 128) != 0;
	int x = -1, y = -1;
	if (part == 0)
	{
		x = READ_SHORT();
		y = READ_SHORT();
	}
	if (!READ_OK() || hud < 0 || hud >= H9ARP_HUDS || count < 1 || count > H9ARP_MAX_LINES)
		return;

	Line lines[H9ARP_MAX_LINES];
	for (int i = 0; i < count; i++)
	{
		lines[i].kind = READ_BYTE();
		ReadText(lines[i].text, sizeof(lines[i].text));
	}
	if (!READ_OK())
		return;

	HudSlot& s = s_Huds[hud];
	if (part == 0)
	{
		s.building = true;
		s.gen = gen;
		s.expect = 1;
		s.bcount = 0;
		s.bx = x;
		s.by = y;
	}
	else if (!s.building || s.gen != gen || s.expect != part)
	{
		// a part is missing: what the HUD holds stays until a whole content comes
		s.building = false;
		return;
	}
	else
	{
		s.expect = part + 1;
	}
	for (int i = 0; i < count && s.bcount < H9ARP_MAX_LINES; i++)
		s.blines[s.bcount++] = lines[i];

	if (!last)
		return;

	s.building = false;
	s.count = s.bcount;
	s.x = s.bx;
	s.y = s.by;
	memcpy(s.lines, s.blines, sizeof(Line) * s.bcount);
	s.have = true;
	s.at = now;
	s.dirty = true;
	s.msgs++;
}

int __MsgFunc_H9ArpHud(const char* pszName, int iSize, void* pbuf)
{
	if (iSize <= 0 || iSize > H9ARP_MAX_MSG || !Enabled())
	{
		s_iDropped++;
		return 1;
	}

	// At most H9ARP_MAX_RATE a second; the rest are dropped.
	const float now = gHUD.m_flTime;
	if (now - s_flRateStart >= 1.0f || now < s_flRateStart)
	{
		s_flRateStart = now;
		s_iRateCount = 0;
	}
	if (++s_iRateCount > H9ARP_MAX_RATE)
	{
		s_iDropped++;
		return 1;
	}

	BEGIN_READ(pbuf, iSize);
	switch (READ_BYTE())
	{
	case 1:
		OpContent(now);
		break;
	case 2:
	{
		const int hud = READ_BYTE();
		if (READ_OK() && hud >= 0 && hud < H9ARP_HUDS)
		{
			s_Huds[hud].have = false;
			s_Huds[hud].building = false;
		}
		break;
	}
	case 3:
		for (int i = 0; i < H9ARP_HUDS; i++)
		{
			s_Huds[i].have = false;
			s_Huds[i].building = false;
		}
		break;
	default:
		break;
	}
	s_iMsgs++;
	s_flLastMsg = now;
	return 1;
}

// ---- every frame -----------------------------------------------------------------------------------------------------

// _h9arphud is what the server reads: 1 while this game draws the HUD as panels, else 0.
void SyncUserinfo()
{
	if (!s_cvInfo)
		return;
	const char* want = Enabled() ? "1" : "0";
	if (!s_cvInfo->string || 0 != strcmp(s_cvInfo->string, want))
		gEngfuncs.Cvar_Set("_h9arphud", want);
}

// Where a HUD goes, from the place the server gave it (arp_hudN_x and _y, thousandths, -1 centred): the nearest of three columns
// and three rows of the safe area. The top row of a side column starts clear of what the HUD draws there (the powerup label at the
// left, the round time and the kill feed at the right), the top row of the middle column beneath the stack of notices, the bottom
// row stands on the bottom band, and the middle row is the height the server asked for. A panel stacks under the one already in
// its column, and one in the middle column keeps off the crosshair box.
void PlacePanel(const HudSlot& s, int wide, int tall, int colBottom[3], int& x, int& y)
{
	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	const int margin = 16;
	const int col = (s.x < 0) ? 1 : (s.x < 330 ? 0 : (s.x > 660 ? 2 : 1));
	const int row = (s.y < 0) ? 1 : (s.y < 330 ? 0 : (s.y > 660 ? 2 : 1));

	x = (col == 0) ? margin : (col == 2 ? ScreenWidth - wide - margin : (ScreenWidth - wide) / 2);
	if (row == 0)
	{
		y = Max(sy0, col == 2 ? 104 : 32);
		if (col == 1)
			y = Max(y, H9Vgui_StackBottom());
	}
	else if (row == 2)
	{
		y = (col == 1 && s.y >= 0) ? s.y * ScreenHeight / 1000 : sy1 - tall;
	}
	else
	{
		y = (s.y >= 0) ? s.y * ScreenHeight / 1000 : (sy0 + sy1 - tall) / 2;
	}
	y = Max(y, colBottom[col]);
	if (y + tall > sy1)
		y = Max(sy0, sy1 - tall);

	if (col == 1)
	{
		const int cx0 = ScreenWidth / 2 - ScreenWidth * 12 / 100, cx1 = ScreenWidth / 2 + ScreenWidth * 12 / 100;
		const int cy0 = ScreenHeight / 2 - ScreenHeight * 6 / 100, cy1 = ScreenHeight / 2 + ScreenHeight * 6 / 100;
		if (x < cx1 && x + wide > cx0 && y < cy1 && y + tall > cy0)
		{
			if (cy0 - 4 - tall >= sy0)
				y = cy0 - 4 - tall;
			else if (cy1 + 4 + tall <= sy1)
				y = cy1 + 4;
		}
	}
	colBottom[col] = y + tall + 6;
}

void Frame()
{
	SyncUserinfo();
	if (!Enabled())
		ClearAll();
	if (!EnsurePanels())
		return;

	const float now = gHUD.m_flTime;
	float dt = now - s_flLastThink;
	s_flLastThink = now;
	if (dt < 0.0f || dt > 0.2f)
		dt = 0.0f;

	// What changes the layout: the screen, the panels' scale, the switches.
	const float scale = UserScale();
	const unsigned int switches = Switches();
	const bool relayout = ScreenWidth != s_iScreenWide || ScreenHeight != s_iScreenTall || scale != s_flScale || switches != s_uiSwitches;
	s_iScreenWide = ScreenWidth;
	s_iScreenTall = ScreenHeight;
	s_flScale = scale;
	s_uiSwitches = switches;

	// Drawn only while the HUD is, as the other H9 panels are: not in an intermission, not with the HUD hidden, not under the
	// scoreboard, not with nohud, not over the buy menu.
	const bool hudDrawn = (now - s_flLastDraw) < 0.5f && now >= s_flLastDraw && !gHUD.m_iIntermission;
	const bool board = gViewPort->IsScoreBoardVisible();
	const bool shown = Enabled() && hudDrawn && !board && !TSHud_NoHud() && !gHUD.m_TSBuyMenu.IsUp();
	const bool menu = gHUD.m_Menu.m_fMenuDisplayed;

	static Seg segs[MAX_SEGS];
	int colBottom[3] = {0, 0, 0};
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		HudSlot& s = s_Huds[i];
		CH9ArpHudPanel* p = s_pPanels[i];
		if (relayout)
		{
			s.dirty = true;
			s.stickyWide = 0; // its width was a width at the old scale
		}
		if (s.have && (now < s.at || now - s.at > H9ARP_LIFE))
			s.have = false; // nothing has refreshed it: the server is gone quiet

		const char* why = nullptr;
		if (!Enabled())
			why = "cl_h9_arphud or cl_h9_vgui is 0";
		else if (!s.have)
			why = "no lines held";
		else if (!On(s_cvPanel[i]))
			why = "its switch is 0";
		else if (!shown)
			why = "the HUD is not drawn (menu, scoreboard, nohud, intermission or master off)";
		else if (i == H9ARP_NOTICE && now - s.at > H9ARP_HOLD)
			why = "the notice has run out";

		// Laid out again when what it shows has changed, while it is wanted.
		if (!why && s.dirty)
		{
			const int n = Collect(i, segs, MAX_SEGS);
			s.laidOut = n > 0 && p->Setup(segs, n, s.stickyWide);
			s.dirty = false;
		}
		if (!why && !s.laidOut)
			why = "every line of it is switched off";

		int px = 0, py = 0, wide = 0, tall = 0;
		p->getSize(wide, tall);
		if (!why)
		{
			PlacePanel(s, wide, tall, colBottom, px, py);
			// Not over a menu: the text menu and the menu panel stand at the left from a quarter of the height down.
			if (menu && px < ScreenWidth / 3 && py + tall > ScreenHeight / 4)
				why = "a menu is open at the left";
			else
				p->setPos(px, py);
		}

		s.why = why ? why : "shown";
		if (!shown)
			s.alpha = 0.0f;
		else if (!why)
			s.alpha = (s.alpha + 255.0f * dt / H9ARP_FADE > 255.0f) ? 255.0f : s.alpha + 255.0f * dt / H9ARP_FADE;
		else
			s.alpha = (s.alpha - 255.0f * dt / H9ARP_FADE < 0.0f) ? 0.0f : s.alpha - 255.0f * dt / H9ARP_FADE;
		p->SetAlpha((int)s.alpha);
		p->setVisible(s.alpha >= 1.0f && s.laidOut);
	}
}

// ---- cl_h9_arphud_list -------------------------------------------------------------------------------------------------

void PrintSwitch(const cvar_t* cv, const char* name, const char* what)
{
	gEngfuncs.Con_Printf("  %-22s %d   %s\n", name, (cv && cv->value != 0.0f) ? 1 : 0, what);
}

void CmdList()
{
	gEngfuncs.Con_Printf("Apollo RP's HUD as panels. 1 shows a thing, 0 hides it. Each is saved.\n");
	PrintSwitch(s_cvMaster, "cl_h9_arphud", "the master: 0 gets the server's text HUD instead of every panel");
	gEngfuncs.Con_Printf("  (cl_h9_vgui is %s: 0 turns every H9 panel off, these too, and the game gets the text HUD)\n",
		On(s_cvVgui) ? "1" : "0");
	gEngfuncs.Con_Printf("The panels. A panel that is 0 is not shown and its lines are not drawn anywhere else:\n");
	for (int i = 0; i < H9ARP_HUDS; i++)
		PrintSwitch(s_cvPanel[i], kPanelCvars[i], kPanelWhat[i]);
	gEngfuncs.Con_Printf("The kinds of line, in the first panel (cl_h9_arphud_left) only:\n");
	for (int i = 0; i < KIND_COUNT; i++)
		PrintSwitch(s_cvKind[i], kKindCvars[i], kKindWhat[i]);

	const float now = gHUD.m_flTime;
	gEngfuncs.Con_Printf("What the server sends. The key it reads, _h9arphud, is \"%s\" in this game", s_cvInfo && s_cvInfo->string ? s_cvInfo->string : "?");
	gEngfuncs.Con_Printf(" (arp_hudstate on the server says what it read). %d message(s) read since you joined", s_iMsgs);
	if (s_flLastMsg >= 0.0f)
		gEngfuncs.Con_Printf(", the last %.1f s ago", now - s_flLastMsg);
	gEngfuncs.Con_Printf(", %d refused.\n", s_iDropped);
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		const HudSlot& s = s_Huds[i];
		if (s.have)
			gEngfuncs.Con_Printf("  HUD %d: %d line(s), %d update(s), the last %.1f s ago; %s\n", i + 1, s.count, s.msgs, now - s.at, s.why ? s.why : "");
		else
			gEngfuncs.Con_Printf("  HUD %d: nothing held; %s\n", i + 1, s.why ? s.why : "");
	}
}

class CHudH9ArpHud : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE;
		return true;
	}
	bool VidInit() override
	{
		return true;
	}
	bool Draw(float flTime) override
	{
		s_flLastDraw = flTime;
		return true;
	}
	void Think() override
	{
		Frame();
	}
	void InitHUDData() override
	{
		// a new map, or a new server: the server sends everything again
		ClearAll();
		s_iMsgs = 0;
		s_iDropped = 0;
		s_flLastMsg = -1.0f;
	}
};
CHudH9ArpHud s_Hud;
} // namespace

// ---- the hooks -------------------------------------------------------------------------------------------------------

void H9ArpHud_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvMaster = CVAR_CREATE("cl_h9_arphud", "1", FCVAR_ARCHIVE);
	for (int i = 0; i < H9ARP_HUDS; i++)
		s_cvPanel[i] = CVAR_CREATE(kPanelCvars[i], "1", FCVAR_ARCHIVE);
	for (int i = 0; i < KIND_COUNT; i++)
		s_cvKind[i] = CVAR_CREATE(kKindCvars[i], "1", FCVAR_ARCHIVE);
	s_cvVgui = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui");
	s_cvInfo = CVAR_CREATE("_h9arphud", Enabled() ? "1" : "0", FCVAR_USERINFO);
	ClearAll();
	gEngfuncs.pfnHookUserMsg("H9ArpHud", __MsgFunc_H9ArpHud);
	gEngfuncs.pfnAddCommand("cl_h9_arphud_list", CmdList);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}
// ---- end H9 ARP HUD ---------------------------------------------------------------------------------------------------
