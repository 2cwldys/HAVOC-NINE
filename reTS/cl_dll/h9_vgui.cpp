// ---- H9 VGUI ---------------------------------------------------------------------------------
// The H9Vgui message, what it opens, and the client's own limits on it. h9_vgui.h is the outline;
// docs\H9_VGUI.txt, section 4, the protocol.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "keydefs.h"
#include "ts_hud.h"
#include "vgui_TeamFortressViewport.h"
#include "h9_vgui.h"
#include "vgui_H9Panel.h"
#include "triangleapi.h" // WorldToScreen: a mark's place on the screen

#include <string.h>
#include <stdio.h>
#include <math.h>

extern Vector v_origin, v_angles; // view.cpp: the view of this frame

namespace
{
cvar_t* s_cvEnabled; // cl_h9_vgui: 0 refuses every server panel
cvar_t* s_cvInfo;    // _h9vgui: the userinfo key the server reads, the protocol version or 0
cvar_t* s_cvTop;     // cl_h9_vgui_top: where the safe area starts, in pixels from the top, 0 for the default
cvar_t* s_cvMarks;   // cl_h9_marks: 0 draws no mark, on the world or in the row
cvar_t* s_cvStrip;   // cl_h9_marks_strip: 0 draws no row of marks under the top stack
cvar_t* s_cvReinforce; // cl_h9_show_reinforce: 0 hides the line that counts down this side's next respawn wave
cvar_t* s_cvZones;   // tsm_show_zones: 0 draws no mark on the world, through the walls; the row under the top stack stays

bool s_bInited = false;

// MENU, ROWS and TWIN.
H9MenuDef s_Menus[H9V_MAX_MENUS];
struct Twin
{
	bool valid;
	char id[H9V_ID_LEN];
	int keys;
	int crc;
	float at;
};
Twin s_Pending;      // the TWIN waiting for its ShowMenu
bool s_bSkinned;     // a menu panel stands for CHudMenu's menu now
int s_iMenuOrder;    // when it opened, so ESC closes the newest thing
H9MenuDef s_Twinned; // the menu it shows

// NOTICE and STATUS.
H9NoticeDef s_Notices[H9V_MAX_NOTICES];
bool s_bNoticeDirty[H9V_MAX_NOTICES];
int s_iNoticeOrder[H9V_MAX_NOTICES]; // when its slot first came: the stack's order, kept across updates
int s_iNoticeLeft[H9V_MAX_NOTICES];  // the clock its panel shows, -1 for none

// MARK: the points of the world the server shows, by slot 1-32.
struct H9Mark
{
	bool used;
	int owner; // 0 nobody's, 1 and 2 a side's
	int state; // 0 quiet, 1 being taken, 2 contested
	int side;  // the side taking it while state is 1
	int pct;   // how far the capture has got, 0-100
	float x, y, z;
	char label[H9V_MARK_TEXT];
	float at; // when it last arrived: a mark nothing refreshes goes after H9V_MARK_LIFE
};
H9Mark s_Marks[H9V_MAX_MARKS + 1];
bool s_bMarksShown = false;                 // Frame() decided this frame's marks are drawn
int s_iStripY = 0, s_iStripTall = 0, s_iStripWide = 0; // the row of marks, Frame()'s place for it; 0 tall for none

// PANEL, CTRL, SET, SHOW, HIDE, CLOSE, COMMIT.
struct PanelSlot
{
	bool used;
	bool committed;
	bool building;
	bool shown;
	bool dirty;
	float opened;
	int order;
	H9PanelDef live;
	H9PanelDef build;
};
PanelSlot s_Panels[H9V_MAX_PANELS];

// The VGUI panels, children of the viewport, made when the viewport first exists.
CH9MenuPanel* s_pMenuPanel = nullptr;
CH9NoticePanel* s_pNoticePanels[H9V_MAX_NOTICES];
CH9ServerPanel* s_pServerPanels[H9V_MAX_PANELS];
vgui::Panel* s_pParent = nullptr;

int s_iOrder = 0;
float s_flLastHudDraw = -100.0f;
int s_iScreenWide = 0, s_iScreenTall = 0;
int s_iStackBottom = 0; // H9Vgui_StackBottom: where the top stack ends, 0 while it shows nothing
float s_flRateStart = 0.0f;
int s_iRateCount = 0;
bool s_bRateWarned = false;

inline int Max(int a, int b) { return a > b ? a : b; }
inline int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

bool Enabled()
{
	return s_cvEnabled && s_cvEnabled->value != 0.0f;
}

// CRC-16/CCITT-FALSE (polynomial 0x1021, start 0xFFFF): what a TWIN carries of its menu's text.
int Crc16(const char* text)
{
	unsigned int crc = 0xFFFF;
	for (const unsigned char* p = (const unsigned char*)text; *p; p++)
	{
		crc ^= (unsigned int)(*p) << 8;
		for (int b = 0; b < 8; b++)
			crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
		crc &= 0xFFFF;
	}
	return (int)crc;
}

// An id: 1-23 characters of a-z 0-9 . _ -, and, where a wildcard is allowed, one '*' at the end.
bool ReadId(char* out, bool wildcard)
{
	const char* s = READ_STRING();
	const int n = (int)strlen(s);
	if (n < 1 || n >= H9V_ID_LEN)
		return false;
	for (int i = 0; i < n; i++)
	{
		const char c = s[i];
		const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' ||
						(wildcard && c == '*' && i == n - 1);
		if (!ok)
			return false;
	}
	memcpy(out, s, n + 1);
	return true;
}

// A text: cut to its room, every character below 32 dropped (line breaks too, unless kept),
// and a titles.txt token looked up unless it names an art.
void ReadText(char* out, int size, bool lines, bool localise = true)
{
	const char* s = READ_STRING();
	int o = 0;
	for (; *s && o < size - 1; s++)
	{
		const unsigned char c = (unsigned char)*s;
		if (c < 32 && !(lines && c == '\n'))
			continue;
		out[o++] = (char)c;
	}
	out[o] = 0;
	if (localise && out[0] == '#')
	{
		// A titles.txt token, looked up as menu and HUD text are.
		char buf[H9V_CTRL_TEXT];
		CHudTextMessage::LocaliseTextString(out, buf, sizeof(buf));
		buf[sizeof(buf) - 1] = 0;
		strncpy(out, buf, size - 1);
		out[size - 1] = 0;
	}
}

int NextOrder()
{
	return ++s_iOrder;
}

// 255 through a notice's hold, then down to 0 over its fade; a status stays at 255.
int NoticeAlpha(const H9NoticeDef& n, float now)
{
	if (n.status)
		return 255;
	const float t = now - n.start;
	if (t < 0.0f || t <= n.hold)
		return 255;
	if (n.fade <= 0.0f)
		return 0;
	const float k = 1.0f - (t - n.hold) / n.fade;
	return k <= 0.0f ? 0 : Clamp((int)(k * 255.0f), 0, 255);
}

// A notice comes up over this many seconds from when its slot began to show; a status shows at once.
const float NOTICE_RISE = 0.35f;

// What the panel is drawn at: NoticeAlpha, less the rise at the start. NoticeAlpha alone says when a notice is over.
int NoticeDrawAlpha(const H9NoticeDef& n, float now)
{
	const int a = NoticeAlpha(n, now);
	if (n.status || a <= 0)
		return a;
	const float up = now - n.shown;
	if (up >= NOTICE_RISE)
		return a;
	return up <= 0.0f ? 0 : Clamp((int)(a * (up / NOTICE_RISE)), 0, 255);
}

// A status's clock now: its seconds at the start less the whole seconds since; -1 for none.
int NoticeClock(const H9NoticeDef& n, float now)
{
	if (!n.status || n.clock < 0)
		return -1;
	const float t = now > n.start ? now - n.start : 0.0f;
	return Max(0, n.clock - (int)t);
}

// A status's text with its clock in place of {t} (m:ss) and {s} (seconds); without a clock, the
// two are left out.
void FormatClock(char* out, int size, const char* text, int left)
{
	int o = 0;
	for (const char* p = text; *p && o < size - 1; p++)
	{
		if (p[0] == '{' && (p[1] == 't' || p[1] == 's') && p[2] == '}')
		{
			char num[16] = "";
			if (left >= 0 && p[1] == 't')
				snprintf(num, sizeof(num), "%d:%02d", left / 60, left % 60);
			else if (left >= 0)
				snprintf(num, sizeof(num), "%d", left);
			for (const char* q = num; *q && o < size - 1; q++)
				out[o++] = *q;
			p += 2;
			continue;
		}
		out[o++] = *p;
	}
	out[o] = 0;
}

void SendReply(const char* id, int ctl, const char* value)
{
	char cmd[96];
	snprintf(cmd, sizeof(cmd), "h9vgui %s %d %s", id, ctl, value);
	gEngfuncs.pfnServerCmd(cmd);
}

// ---- menus ------------------------------------------------------------------------------------

H9MenuDef* FindMenu(const char* id)
{
	for (H9MenuDef& m : s_Menus)
	{
		if (m.used && 0 == strcmp(m.id, id))
			return &m;
	}
	return nullptr;
}

H9MenuDef* NewMenu(const char* id)
{
	H9MenuDef* m = FindMenu(id);
	if (!m)
	{
		// A free slot, else the oldest.
		m = &s_Menus[0];
		for (H9MenuDef& c : s_Menus)
		{
			if (!c.used)
			{
				m = &c;
				break;
			}
			if (c.stamp < m->stamp)
				m = &c;
		}
	}
	memset(m, 0, sizeof(*m));
	m->used = true;
	strncpy(m->id, id, H9V_ID_LEN - 1);
	m->stamp = gHUD.m_flTime;
	return m;
}

void OpMenu()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false))
		return;
	const int keys = READ_SHORT() & 0x3FF;
	const int time = READ_CHAR();
	const int style = READ_BYTE();
	const int flags = READ_BYTE();
	char title[H9V_TITLE_LEN], footer[H9V_TITLE_LEN];
	ReadText(title, sizeof(title), false);
	ReadText(footer, sizeof(footer), false);
	if (!READ_OK())
		return;
	H9MenuDef* m = NewMenu(id);
	m->keys = keys;
	m->time = time;
	m->style = Clamp(style, 0, 2);
	m->flags = flags;
	strncpy(m->title, title, H9V_TITLE_LEN - 1);
	strncpy(m->footer, footer, H9V_TITLE_LEN - 1);
}

void OpRows()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false))
		return;
	H9MenuDef* m = FindMenu(id);
	const int count = READ_BYTE();
	H9MenuRow rows[H9V_MAX_ROWS];
	int got = 0;
	for (int i = 0; i < count && i < H9V_MAX_ROWS; i++)
	{
		H9MenuRow& row = rows[got++];
		row.key = READ_BYTE();
		row.flags = READ_BYTE();
		ReadText(row.label, sizeof(row.label), false);
		ReadText(row.detail, sizeof(row.detail), false);
		if (row.key < 0 || row.key > 10)
			row.key = 0;
	}
	if (!READ_OK() || !m)
		return;
	for (int i = 0; i < got && m->numRows < H9V_MAX_ROWS; i++)
		m->rows[m->numRows++] = rows[i];
}

void OpTwin()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false))
		return;
	const int keys = READ_SHORT() & 0x3FF;
	const int crc = READ_SHORT() & 0xFFFF;
	if (!READ_OK())
		return;
	s_Pending.valid = true;
	memcpy(s_Pending.id, id, sizeof(id));
	s_Pending.keys = keys;
	s_Pending.crc = crc;
	s_Pending.at = gHUD.m_flTime;
}

// ---- notices ----------------------------------------------------------------------------------

void StoreNotice(const char* slot, H9NoticeDef& n);

void OpNotice()
{
	char slot[H9V_ID_LEN];
	if (!ReadId(slot, false))
		return;
	H9NoticeDef n;
	memset(&n, 0, sizeof(n));
	n.style = Clamp(READ_BYTE(), 0, 3);
	n.anchor = READ_BYTE();
	n.y = READ_SHORT();
	n.r = READ_BYTE();
	n.g = READ_BYTE();
	n.b = READ_BYTE();
	n.hold = READ_BYTE() / 10.0f;
	n.fade = READ_BYTE() / 10.0f;
	n.value = READ_SHORT();
	ReadText(n.text, sizeof(n.text), true);
	if (!READ_OK())
		return;
	n.clock = -1;
	StoreNotice(slot, n);
}

// A status (protocol 2): a notice that stays, its clock counted here. Slot, style, colour, the
// clock's seconds (-1 for none), text.
void OpStatus()
{
	char slot[H9V_ID_LEN];
	if (!ReadId(slot, false))
		return;
	H9NoticeDef n;
	memset(&n, 0, sizeof(n));
	n.style = Clamp(READ_BYTE(), 0, 3);
	n.r = READ_BYTE();
	n.g = READ_BYTE();
	n.b = READ_BYTE();
	n.clock = Max(-1, READ_SHORT());
	ReadText(n.text, sizeof(n.text), true);
	if (!READ_OK())
		return;
	n.status = true;
	n.anchor = H9V_T;
	n.y = -1;
	n.value = -1;
	StoreNotice(slot, n);
}

// A notice or a status into its slot.
void StoreNotice(const char* slot, H9NoticeDef& n)
{
	// cl_h9_show_reinforce 0: the wave countdown (the server's "tsm.wave" notice) is never shown; its slot is cleared as an empty notice does
	if (s_cvReinforce && s_cvReinforce->value == 0.0f && 0 == strcmp(slot, "tsm.wave"))
		n.text[0] = 0;
	n.used = true;
	strncpy(n.slot, slot, H9V_ID_LEN - 1);
	n.slot[H9V_ID_LEN - 1] = 0;
	n.start = gHUD.m_flTime;

	// The same slot replaces, as a hudmessage channel does; else a free one, else the oldest.
	int at = -1;
	for (int i = 0; i < H9V_MAX_NOTICES && at < 0; i++)
	{
		if (s_Notices[i].used && 0 == strcmp(s_Notices[i].slot, slot))
			at = i;
	}
	const bool replaces = at >= 0;
	if (n.text[0] == 0)
	{
		// An empty notice clears its slot.
		if (replaces)
			s_Notices[at].used = false;
		return;
	}
	// A notice that replaces one still showing keeps that one's rise (a bar sent every tick must not come up again each time);
	// any other comes up from now.
	n.shown = (replaces && NoticeAlpha(s_Notices[at], n.start) > 0) ? s_Notices[at].shown : n.start;
	for (int i = 0; i < H9V_MAX_NOTICES && at < 0; i++)
	{
		if (!s_Notices[i].used)
			at = i;
	}
	if (at < 0)
	{
		// All taken: the oldest notice goes, and a status only when there are nothing but.
		for (int i = 0; i < H9V_MAX_NOTICES; i++)
		{
			if (at < 0 || (s_Notices[at].status && !s_Notices[i].status) ||
				(s_Notices[at].status == s_Notices[i].status && s_Notices[i].start < s_Notices[at].start))
				at = i;
		}
	}
	s_Notices[at] = n;
	s_bNoticeDirty[at] = true;
	s_iNoticeLeft[at] = -2;
	if (!replaces)
		s_iNoticeOrder[at] = NextOrder();
}

// ---- panels -----------------------------------------------------------------------------------

PanelSlot* FindPanel(const char* id)
{
	for (PanelSlot& p : s_Panels)
	{
		if (p.used && 0 == strcmp(p.live.id, id))
			return &p;
	}
	return nullptr;
}

void ClosePanel(PanelSlot& p)
{
	p.used = false;
	p.committed = false;
	p.building = false;
	p.shown = false;
}

void OpPanel()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false))
		return;
	const int flags = READ_BYTE();
	const int anchor = READ_BYTE();
	const int x = READ_SHORT();
	const int y = READ_SHORT();
	const int w = READ_SHORT();
	const int h = READ_SHORT();
	char art[H9V_CTRL_TEXT];
	ReadText(art, sizeof(art), false, false);
	const int timeout = READ_BYTE();
	if (!READ_OK())
		return;

	PanelSlot* p = FindPanel(id);
	if (!p)
	{
		for (PanelSlot& c : s_Panels)
		{
			if (!c.used)
			{
				p = &c;
				break;
			}
		}
		if (!p)
			return; // eight open already: the client's limit
		memset(p, 0, sizeof(*p));
		p->used = true;
		memcpy(p->live.id, id, sizeof(id));
	}
	memset(&p->build, 0, sizeof(p->build));
	p->build.used = true;
	memcpy(p->build.id, id, sizeof(id));
	p->build.flags = flags;
	p->build.anchor = Clamp(anchor, 0, 8);
	p->build.x = x;
	p->build.y = y;
	p->build.w = Max(0, w);
	p->build.h = Max(0, h);
	strncpy(p->build.art, art, sizeof(p->build.art) - 1);
	p->build.timeout = timeout;
	p->building = true;
}

void OpCtrl()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false))
		return;
	H9CtrlDef c;
	memset(&c, 0, sizeof(c));
	const int number = READ_BYTE();
	c.type = READ_BYTE();
	c.anchor = Clamp(READ_BYTE(), 0, 8);
	c.x = READ_SHORT();
	c.y = READ_SHORT();
	c.w = Max(0, READ_SHORT());
	c.h = Max(0, READ_SHORT());
	c.font = Clamp(READ_BYTE(), 0, 3);
	c.align = Clamp(READ_BYTE(), 0, 2);
	c.r = READ_BYTE();
	c.g = READ_BYTE();
	c.b = READ_BYTE();
	c.a = READ_BYTE();
	c.flags = READ_BYTE();
	c.key = READ_BYTE();
	ReadText(c.text, sizeof(c.text), false, c.type != H9V_CTRL_IMAGE);
	if (!READ_OK())
		return;
	if (number < 1 || number > H9V_MAX_CTRLS || c.type < H9V_CTRL_LABEL || c.type > H9V_CTRL_PROGRESS)
		return; // a text entry, or nothing this client draws
	if (c.key < 0 || c.key > 10)
		c.key = 0;
	c.used = true;

	PanelSlot* p = FindPanel(id);
	if (!p)
		return;
	if (!p->building)
	{
		// A control after the COMMIT: the panel is built again from what it shows.
		p->build = p->live;
		p->building = true;
	}
	p->build.ctrls[number] = c;
}

void ApplySet(H9PanelDef& d, int number, int what, int value, const char* text, int r, int g, int b, int a)
{
	H9CtrlDef& c = d.ctrls[number];
	if (!c.used)
		return;
	switch (what)
	{
	case 1:
		strncpy(c.text, text, sizeof(c.text) - 1);
		c.text[sizeof(c.text) - 1] = 0;
		break;
	case 2:
		c.flags = value ? (c.flags & ~1) : (c.flags | 1);
		break;
	case 3:
		c.flags = value ? (c.flags & ~2) : (c.flags | 2);
		break;
	case 4:
		c.value = Clamp(value, 0, 1000);
		break;
	case 5:
		c.r = r;
		c.g = g;
		c.b = b;
		c.a = a;
		break;
	case 6:
		if (c.type == H9V_CTRL_IMAGE)
		{
			strncpy(c.text, text, sizeof(c.text) - 1);
			c.text[sizeof(c.text) - 1] = 0;
		}
		break;
	default:
		break;
	}
}

void OpSet()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false))
		return;
	const int number = READ_BYTE();
	const int what = READ_BYTE();
	int value = 0, r = 0, g = 0, b = 0, a = 0;
	char text[H9V_CTRL_TEXT];
	text[0] = 0;
	switch (what)
	{
	case 1:
	case 6:
		ReadText(text, sizeof(text), false, what == 1);
		break;
	case 2:
	case 3:
		value = READ_BYTE();
		break;
	case 4:
		value = READ_SHORT();
		break;
	case 5:
		r = READ_BYTE();
		g = READ_BYTE();
		b = READ_BYTE();
		a = READ_BYTE();
		break;
	default:
		return;
	}
	if (!READ_OK() || number < 1 || number > H9V_MAX_CTRLS)
		return;
	PanelSlot* p = FindPanel(id);
	if (!p)
		return;
	if (p->committed)
	{
		ApplySet(p->live, number, what, value, text, r, g, b, a);
		p->dirty = true;
	}
	if (p->building)
		ApplySet(p->build, number, what, value, text, r, g, b, a);
}

void OpShowHide(bool show)
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false) || !READ_OK())
		return;
	PanelSlot* p = FindPanel(id);
	if (p && p->committed)
	{
		if (show && !p->shown)
			p->order = NextOrder();
		p->shown = show;
	}
}

void OpClose()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, true) || !READ_OK())
		return;
	const int n = (int)strlen(id);
	const bool all = id[n - 1] == '*';
	for (PanelSlot& p : s_Panels)
	{
		if (!p.used)
			continue;
		if (all ? 0 == strncmp(p.live.id, id, n - 1) : 0 == strcmp(p.live.id, id))
			ClosePanel(p);
	}
}

void OpCommit()
{
	char id[H9V_ID_LEN];
	if (!ReadId(id, false) || !READ_OK())
		return;
	PanelSlot* p = FindPanel(id);
	if (!p || !p->building)
		return;
	p->live = p->build;
	p->building = false;
	if (!p->committed || !p->shown)
	{
		p->opened = gHUD.m_flTime;
		p->order = NextOrder();
	}
	p->committed = true;
	p->shown = true;
	p->dirty = true;
}

// MARK: BYTE slot (0 takes every mark down), BYTE owner (3 takes this one down), BYTE state, BYTE side, BYTE pct,
// SHORT x, y, z, STRING label.
void OpMark()
{
	const int slot = READ_BYTE();
	const int owner = READ_BYTE();
	const int state = READ_BYTE();
	const int side = READ_BYTE();
	const int pct = READ_BYTE();
	const int x = READ_SHORT();
	const int y = READ_SHORT();
	const int z = READ_SHORT();
	char label[H9V_MARK_TEXT];
	ReadText(label, sizeof(label), false, false);
	if (!READ_OK() || slot < 0 || slot > H9V_MAX_MARKS || owner > 3)
		return;
	if (slot == 0)
	{
		for (H9Mark& m : s_Marks)
			m.used = false;
		return;
	}
	H9Mark& m = s_Marks[slot];
	if (owner == 3)
	{
		m.used = false;
		return;
	}
	m.used = true;
	m.owner = owner;
	m.state = Clamp(state, 0, 2);
	m.side = Clamp(side, 0, 2);
	m.pct = Clamp(pct, 0, 100);
	m.x = (float)x;
	m.y = (float)y;
	m.z = (float)z;
	memcpy(m.label, label, sizeof(m.label));
	m.label[sizeof(m.label) - 1] = 0;
	m.at = gHUD.m_flTime;
}

// ---- the message ------------------------------------------------------------------------------

int __MsgFunc_H9Vgui(const char* pszName, int iSize, void* pbuf)
{
	if (iSize <= 0 || iSize > H9V_MAX_MSG || !Enabled())
		return 1;

	// At most H9V_MAX_RATE a second; the rest are dropped, and said once.
	const float now = gHUD.m_flTime;
	if (now - s_flRateStart >= 1.0f || now < s_flRateStart)
	{
		s_flRateStart = now;
		s_iRateCount = 0;
	}
	if (++s_iRateCount > H9V_MAX_RATE)
	{
		if (!s_bRateWarned)
		{
			s_bRateWarned = true;
			gEngfuncs.Con_Printf("H9 VGUI: the server sends more than %d panel messages a second; the rest are dropped\n", H9V_MAX_RATE);
		}
		return 1;
	}

	BEGIN_READ(pbuf, iSize);
	switch (READ_BYTE())
	{
	case H9V_OP_MENU:
		OpMenu();
		break;
	case H9V_OP_ROWS:
		OpRows();
		break;
	case H9V_OP_TWIN:
		OpTwin();
		break;
	case H9V_OP_PANEL:
		OpPanel();
		break;
	case H9V_OP_CTRL:
		OpCtrl();
		break;
	case H9V_OP_SET:
		OpSet();
		break;
	case H9V_OP_SHOW:
		OpShowHide(true);
		break;
	case H9V_OP_HIDE:
		OpShowHide(false);
		break;
	case H9V_OP_CLOSE:
		OpClose();
		break;
	case H9V_OP_COMMIT:
		OpCommit();
		break;
	case H9V_OP_NOTICE:
		OpNotice();
		break;
	case H9V_OP_STATUS:
		OpStatus();
		break;
	case H9V_OP_MARK:
		OpMark();
		break;
	default:
		break;
	}
	return 1;
}

// ---- every frame ------------------------------------------------------------------------------

void CloseAll()
{
	s_bSkinned = false;
	s_Pending.valid = false;
	for (H9NoticeDef& n : s_Notices)
		n.used = false;
	for (PanelSlot& p : s_Panels)
		ClosePanel(p);
	for (H9MenuDef& m : s_Menus)
		m.used = false;
	for (H9Mark& m : s_Marks)
		m.used = false;
	s_iStripTall = 0;
}

// ---- marks: where and how big ----------------------------------------------------------------

// One screen unit of a mark: the screen height over 480, and the player's cl_h9_vgui_scale, half of it.
float MarkUnit()
{
	float f = CVAR_GET_FLOAT("cl_h9_vgui_scale");
	if (f < 0.5f)
		f = 0.5f;
	if (f > 2.0f)
		f = 2.0f;
	return ((float)ScreenHeight / 480.0f) * f * 0.5f;
}

// A mark's badge, in pixels across.
int MarkSize()
{
	return Max(16, (int)(30.0f * MarkUnit()));
}

// The frame round a badge, in pixels.
int MarkEdge(int size)
{
	return Max(2, size / 9);
}

bool MarksOn()
{
	return Enabled() && s_cvMarks && s_cvMarks->value != 0.0f;
}

// Whether the marks are drawn on the world, through the walls (tsm_show_zones, on until it is set to 0). The row of them under
// the top stack is cl_h9_marks_strip's.
bool ZonesOn()
{
	return !s_cvZones || s_cvZones->value != 0.0f;
}

// A badge's width in pixels: the square its size gives, or wider where its label (a word such as UPLINK) needs it, with room
// either side of the letters, so a long label sits inside its own frame and never runs into the next badge.
int BadgeWide(const H9Mark& m, int size)
{
	int text = 0;
	for (const char* p = m.label; *p; p++)
		text += gHUD.m_scrinfo.charWidths[(unsigned char)*p];
	if (text > 0)
		text++; // the label is drawn twice, a pixel apart
	return Max(size, text + 2 * Max(3, size / 5));
}

// The space between two badges of the row, frame to frame: a few pixels, so the frames of neighbours never touch.
int StripGap(int size)
{
	return 2 * MarkEdge(size) + Max(3, size / 5);
}

// Where a point of the world lands on the screen, and whether it is in view. A point out of view (to a side, above, below
// or behind) is pinned to the screen's edge, in its direction from the middle.
void MarkScreen(const H9Mark& m, int& sx, int& sy, bool& inView)
{
	Vector pos(m.x, m.y, m.z);
	float screen[3] = {0, 0, 0};
	const bool behind = 0 != gEngfuncs.pTriAPI->WorldToScreen((float*)&pos, screen);
	if (!behind && fabsf(screen[0]) <= 1.0f && fabsf(screen[1]) <= 1.0f)
	{
		sx = (int)((1.0f + screen[0]) * 0.5f * (float)ScreenWidth);
		sy = (int)((1.0f - screen[1]) * 0.5f * (float)ScreenHeight);
		inView = true;
		return;
	}
	inView = false;
	Vector fwd, right, up;
	AngleVectors(v_angles, fwd, right, up);
	const Vector rel = pos - v_origin;
	float dx = DotProduct(rel, right);
	float dy = DotProduct(rel, up);
	if (fabsf(dx) < 1.0f && fabsf(dy) < 1.0f)
	{
		dx = 0.0f; // straight behind the player: the bottom edge
		dy = -1.0f;
	}
	const float margin = (float)MarkSize();
	const float mx = (float)ScreenWidth * 0.5f - margin;
	const float my = (float)ScreenHeight * 0.5f - margin;
	const float k = (fabsf(dx) * my > fabsf(dy) * mx) ? mx / fabsf(dx) : my / fabsf(dy);
	sx = ScreenWidth / 2 + (int)(dx * k);
	sy = ScreenHeight / 2 - (int)(dy * k);
}

// The panels, made under the viewport the first time it exists (and again if it was replaced).
bool EnsurePanels()
{
	if (!gViewPort)
		return false;
	if (s_pParent == gViewPort && s_pMenuPanel)
		return true;
	s_pParent = gViewPort;
	s_pMenuPanel = new CH9MenuPanel();
	s_pMenuPanel->setParent(gViewPort);
	for (int i = 0; i < H9V_MAX_NOTICES; i++)
	{
		s_pNoticePanels[i] = new CH9NoticePanel();
		s_pNoticePanels[i]->setParent(gViewPort);
	}
	for (int i = 0; i < H9V_MAX_PANELS; i++)
	{
		s_pServerPanels[i] = new CH9ServerPanel();
		s_pServerPanels[i]->setParent(gViewPort);
	}
	return true;
}

void SyncUserinfo()
{
	if (!s_cvInfo)
		return;
	char want[8];
	snprintf(want, sizeof(want), "%d", Enabled() ? H9V_PROTOCOL : 0);
	if (!s_cvInfo->string || 0 != strcmp(s_cvInfo->string, want))
		gEngfuncs.Cvar_Set("_h9vgui", want);
}

void Frame()
{
	s_iStackBottom = 0;
	SyncUserinfo();
	if (!Enabled())
		CloseAll();
	if (!EnsurePanels())
		return;

	const float now = gHUD.m_flTime;
	const bool resized = ScreenWidth != s_iScreenWide || ScreenHeight != s_iScreenTall;
	s_iScreenWide = ScreenWidth;
	s_iScreenTall = ScreenHeight;

	// Drawn only while the HUD is: not in an intermission, not with the HUD hidden, not under the
	// scoreboard.
	const bool hud = (now - s_flLastHudDraw) < 0.5f && now >= s_flLastHudDraw && !gHUD.m_iIntermission;
	const bool board = gViewPort->IsScoreBoardVisible();
	const bool shown = Enabled() && hud && !board;

	// The menu: up while CHudMenu still has the menu it stands for.
	if (s_bSkinned && !gHUD.m_Menu.m_fMenuDisplayed)
		s_bSkinned = false;
	if (s_bSkinned && resized)
		s_pMenuPanel->Layout();
	s_pMenuPanel->setVisible(shown && s_bSkinned);

	// The notices: gone when faded; the ones at the top stack from the top of the safe area, the
	// statuses first, then the rest, oldest first.
	const bool noHud = TSHud_NoHud();
	int order[H9V_MAX_NOTICES], count = 0;
	for (int i = 0; i < H9V_MAX_NOTICES; i++)
	{
		if (s_Notices[i].used && NoticeAlpha(s_Notices[i], now) <= 0)
			s_Notices[i].used = false;
		if (!s_Notices[i].used)
		{
			s_pNoticePanels[i]->setVisible(false);
			continue;
		}
		order[count++] = i;
	}
	auto before = [](int a, int b) {
		if (s_Notices[a].status != s_Notices[b].status)
			return s_Notices[a].status;
		return s_iNoticeOrder[a] < s_iNoticeOrder[b];
	};
	for (int a = 1; a < count; a++)
	{
		for (int b = a; b > 0 && before(order[b], order[b - 1]); b--)
		{
			const int t = order[b];
			order[b] = order[b - 1];
			order[b - 1] = t;
		}
	}
	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	int stackY = sy0;
	int stackEnd = 0; // the lowest edge of what shows in the top stack
	bool first = true;
	for (int k = 0; k < count; k++)
	{
		const int i = order[k];
		CH9NoticePanel* p = s_pNoticePanels[i];
		const H9NoticeDef& n = s_Notices[i];
		// A status's clock counts down here, a second at a time, from the one message.
		const int left = NoticeClock(n, now);
		if (left != s_iNoticeLeft[i])
		{
			s_iNoticeLeft[i] = left;
			s_bNoticeDirty[i] = true;
		}
		if (s_bNoticeDirty[i] || resized)
		{
			H9NoticeDef shown = n;
			if (n.status)
				FormatClock(shown.text, sizeof(shown.text), n.text, left);
			p->SetNotice(shown);
			// The first banner at the top keeps above 0.25 of the height, where the engine's centre
			// print and a stats plugin's kill lines begin, where the band leaves it 40 px for that.
			const bool atTop = n.anchor != H9V_C;
			const int room = ScreenHeight / 4 - stackY;
			p->Layout(atTop && first && room >= 40 ? room : 0);
			s_bNoticeDirty[i] = false;
		}
		int wide, tall;
		p->getSize(wide, tall);
		int x = (ScreenWidth - wide) / 2, y;
		if (n.anchor == H9V_C)
		{
			y = Clamp(n.y, 0, 1000) * ScreenHeight / 1000 - tall / 2;
			// Not over the crosshair: above it if there is room, else below it.
			const int cy0 = ScreenHeight / 2 - ScreenHeight * 6 / 100, cy1 = ScreenHeight / 2 + ScreenHeight * 6 / 100;
			if (y < cy1 && y + tall > cy0)
				y = (cy0 - 4 - tall >= sy0) ? cy0 - 4 - tall : cy1 + 4;
			y = Clamp(y, sy0, Max(sy0, sy1 - tall));
		}
		else
		{
			// The stack goes on below the crosshair box when the next one would reach into it.
			y = stackY;
			const int cy0 = ScreenHeight / 2 - ScreenHeight * 6 / 100, cy1 = ScreenHeight / 2 + ScreenHeight * 6 / 100;
			const int cx0 = ScreenWidth / 2 - ScreenWidth * 12 / 100, cx1 = ScreenWidth / 2 + ScreenWidth * 12 / 100;
			if (y < cy1 && y + tall > cy0 && x < cx1 && x + wide > cx0)
				y = cy1 + 4;
			stackY = y + tall + 4;
			first = false;
		}
		p->setPos(x, y);
		p->SetAlpha(NoticeDrawAlpha(n, now));
		p->setVisible(shown && !noHud);
		if (shown && !noHud && n.anchor != H9V_C)
			stackEnd = Max(stackEnd, y + tall);
	}

	// The server panels: their time out, then each where its anchor puts it.
	for (int i = 0; i < H9V_MAX_PANELS; i++)
	{
		PanelSlot& s = s_Panels[i];
		CH9ServerPanel* p = s_pServerPanels[i];
		if (s.used && s.committed && s.live.timeout > 0 && now - s.opened > (float)s.live.timeout)
			ClosePanel(s);
		if (!s.used || !s.committed)
		{
			p->setVisible(false);
			continue;
		}
		if (s.dirty || resized)
		{
			p->SetDef(s.live);
			s.dirty = false;
		}
		p->setVisible(shown && !noHud && s.shown);
		// A panel anchored along the top, still in the top quarter and reaching into the middle half of the screen, where the stack is
		// centred, belongs to the top stack. One in a corner that stops short of the middle half (the Officer's waiting list at the top
		// right) is beside the stack and pushes nothing down: the row of marks keeps its place as the list grows and shrinks.
		if (shown && !noHud && s.shown && s.live.anchor >= H9V_TL && s.live.anchor <= H9V_TR)
		{
			int px, py, pw, ph;
			p->getPos(px, py);
			p->getSize(pw, ph);
			if (py < ScreenHeight / 4 && px < ScreenWidth * 3 / 4 && px + pw > ScreenWidth / 4)
				stackEnd = Max(stackEnd, py + ph);
		}
	}

	// The marks: the ones nothing has refreshed go; the row of them goes under the notices, and TS's own notices beneath it.
	int marks = 0;
	for (int i = 1; i <= H9V_MAX_MARKS; i++)
	{
		if (s_Marks[i].used && now - s_Marks[i].at > H9V_MARK_LIFE)
			s_Marks[i].used = false;
		if (s_Marks[i].used)
			marks++;
	}
	s_bMarksShown = shown && !noHud && MarksOn() && marks > 0;
	s_iStripTall = 0;
	if (s_bMarksShown && marks >= 2 && s_cvStrip && s_cvStrip->value != 0.0f)
	{
		const int size = Max(12, MarkSize() * 3 / 4);
		const int gap = StripGap(size);
		int across = 0;
		for (int i = 1; i <= H9V_MAX_MARKS; i++)
			if (s_Marks[i].used)
				across += BadgeWide(s_Marks[i], size);
		s_iStripWide = across + (marks - 1) * gap;
		s_iStripTall = size + 2 * MarkEdge(size) + 2 + Max(3, size / 8) + 2; // the badge, its frame and the bar under it
		s_iStripY = stackEnd > 0 ? stackEnd + 2 : sy0;
		stackEnd = s_iStripY + s_iStripTall;
	}
	s_iStackBottom = stackEnd > 0 ? stackEnd + 4 : 0;
}

// ---- marks: drawing --------------------------------------------------------------------------

void SideColour(int side, int& r, int& g, int& b)
{
	if (side == 1)
	{
		r = 0;
		g = 170;
		b = 255;
	}
	else if (side == 2)
	{
		r = 255;
		g = 70;
		b = 60;
	}
	else
	{
		r = 225;
		g = 225;
		b = 225;
	}
}

// One badge centred on cx, cy: the label on the owner's colour (yellow and white by turns while it is contested), and under
// it, while a side is taking it, the bar of how far it has got in that side's colour.
void DrawBadge(int cx, int cy, int size, const H9Mark& m, bool blink, int alpha)
{
	int r, g, b;
	SideColour(m.owner, r, g, b);
	if (m.state == 2 && blink)
	{
		r = 255;
		g = 220;
		b = 80;
	}
	const int half = size / 2;
	const int edge = MarkEdge(size);
	const int across = BadgeWide(m, size);
	const int left = cx - across / 2;
	// The owner's colour as a frame round a dark fill of it: the label is drawn additively, so it shows only over a dark ground.
	gEngfuncs.pfnFillRGBABlend(left - edge, cy - half - edge, across + 2 * edge, size + 2 * edge, r, g, b, alpha);
	gEngfuncs.pfnFillRGBABlend(left, cy - half, across, size, r * 25 / 100, g * 25 / 100, b * 25 / 100, alpha);

	int wide = 0;
	for (const char* p = m.label; *p; p++)
		wide += gHUD.m_scrinfo.charWidths[(unsigned char)*p];
	// twice, a pixel apart, for a heavier letter
	const int tx = cx - wide / 2, ty = cy - gHUD.m_scrinfo.iCharHeight / 2;
	TSHud_DrawString(tx, ty, ScreenWidth, m.label, 255, 255, 255);
	TSHud_DrawString(tx + 1, ty, ScreenWidth, m.label, 255, 255, 255);

	if (m.state != 0 && m.pct > 0)
	{
		const int bar = Max(3, size / 8);
		int tr, tg, tb;
		SideColour(m.side, tr, tg, tb);
		const int by = cy + half + edge + 2;
		gEngfuncs.pfnFillRGBABlend(left, by, across, bar, 0, 0, 0, alpha * 190 / 255);
		gEngfuncs.pfnFillRGBABlend(left, by, across * m.pct / 100, bar, tr, tg, tb, alpha);
	}
}

// The marks, every HUD frame: each on its point of the world (or the edge of the screen), and the row under the stack.
void DrawMarks(float now)
{
	if (!s_bMarksShown)
		return;
	const bool blink = ((int)(now * 4.0f) & 1) != 0;
	const int size = MarkSize();
	for (int i = 1; i <= H9V_MAX_MARKS && ZonesOn(); i++)
	{
		const H9Mark& m = s_Marks[i];
		if (!m.used)
			continue;
		int sx, sy;
		bool inView;
		MarkScreen(m, sx, sy, inView);
		const int badge = inView ? size : size * 3 / 4;
		// a wide label keeps its whole frame on the screen
		const int room = BadgeWide(m, badge) / 2 + MarkEdge(badge);
		sx = Clamp(sx, room, ScreenWidth - room);
		DrawBadge(sx, sy, badge, m, blink, inView ? 235 : 180);
	}

	if (s_iStripTall > 0)
	{
		const int small = Max(12, size * 3 / 4);
		const int gap = StripGap(small);
		int left = (ScreenWidth - s_iStripWide) / 2;
		const int y = s_iStripY + MarkEdge(small) + small / 2;
		for (int i = 1; i <= H9V_MAX_MARKS; i++)
		{
			const H9Mark& m = s_Marks[i];
			if (!m.used)
				continue;
			const int across = BadgeWide(m, small);
			DrawBadge(left + across / 2, y, small, m, blink, 235);
			left += across + gap;
		}
	}
}

class CHudH9Vgui : public CHudBase
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
		s_flLastHudDraw = flTime;
		DrawMarks(flTime);
		return true;
	}
	void Think() override
	{
		Frame();
	}
	void Reset() override
	{
		// A respawn closes the server panels that do not ask to stay (PANEL flag 2).
		for (PanelSlot& p : s_Panels)
		{
			if (p.used && (p.live.flags & 2) == 0)
				ClosePanel(p);
		}
	}
	void InitHUDData() override
	{
		CloseAll(); // a new map, or a new server
	}
};
CHudH9Vgui s_Hud;
} // namespace

// ---- the hooks --------------------------------------------------------------------------------

void H9Vgui_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvEnabled = CVAR_CREATE("cl_h9_vgui", "1", FCVAR_ARCHIVE);
	CVAR_CREATE("cl_h9_vgui_scale", "1", FCVAR_ARCHIVE);
	s_cvTop = CVAR_CREATE("cl_h9_vgui_top", "0", FCVAR_ARCHIVE);
	s_cvMarks = CVAR_CREATE("cl_h9_marks", "1", FCVAR_ARCHIVE);
	s_cvStrip = CVAR_CREATE("cl_h9_marks_strip", "1", FCVAR_ARCHIVE);
	s_cvZones = CVAR_CREATE("tsm_show_zones", "1", FCVAR_ARCHIVE);
	s_cvReinforce = CVAR_CREATE("cl_h9_show_reinforce", "1", FCVAR_ARCHIVE);
	s_cvInfo = CVAR_CREATE("_h9vgui", Enabled() ? "1" : "0", FCVAR_USERINFO);
	gEngfuncs.pfnHookUserMsg("H9Vgui", __MsgFunc_H9Vgui);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

bool H9Vgui_MenuArrived(int keys, const char* text)
{
	const bool pending = s_Pending.valid && gHUD.m_flTime - s_Pending.at < 2.0f && gHUD.m_flTime >= s_Pending.at;
	s_Pending.valid = false;
	s_bSkinned = false;
	if (!pending || !Enabled() || !text || (keys & 0x3FF) != s_Pending.keys || Crc16(text) != s_Pending.crc)
		return false;
	const H9MenuDef* m = FindMenu(s_Pending.id);
	if (!m || m->numRows <= 0 || !EnsurePanels())
		return false;
	s_Twinned = *m;
	s_pMenuPanel->SetMenu(s_Twinned);
	s_bSkinned = true;
	s_iMenuOrder = NextOrder();
	return true;
}

void H9Vgui_MenuGone()
{
	s_bSkinned = false;
}

bool H9Vgui_MenuSkinned()
{
	return s_bSkinned && Enabled();
}

bool H9Vgui_KeyInput(bool down, int keynum)
{
	if (!down || keynum != K_ESCAPE || !Enabled())
		return false;

	// The newest open thing: the menu, or a server panel.
	int best = -1, bestOrder = 0;
	if (s_bSkinned && gHUD.m_Menu.m_fMenuDisplayed)
	{
		best = H9V_MAX_PANELS; // the menu
		bestOrder = s_iMenuOrder;
	}
	for (int i = 0; i < H9V_MAX_PANELS; i++)
	{
		const PanelSlot& p = s_Panels[i];
		if (p.used && p.committed && p.shown && (best < 0 || p.order > bestOrder))
		{
			best = i;
			bestOrder = p.order;
		}
	}
	if (best < 0)
		return false;
	if (best == H9V_MAX_PANELS)
	{
		// The menu goes, with the text menu under it: the number keys are the weapons' again. The
		// server is told nothing; its menu runs out as an ignored text menu would.
		s_bSkinned = false;
		gHUD.m_Menu.m_fMenuDisplayed = false;
		gHUD.m_Menu.m_iFlags &= ~HUD_ACTIVE;
		return true;
	}
	char id[H9V_ID_LEN];
	memcpy(id, s_Panels[best].live.id, sizeof(id));
	ClosePanel(s_Panels[best]);
	SendReply(id, 0, "close");
	return true;
}

bool H9Vgui_TakesSlot(int slot)
{
	if (!Enabled() || slot < 1 || slot > 10)
		return false;
	// The newest panel with an enabled, visible button on that key.
	int best = -1, bestCtl = 0, bestOrder = 0;
	for (int i = 0; i < H9V_MAX_PANELS; i++)
	{
		const PanelSlot& p = s_Panels[i];
		if (!p.used || !p.committed || !p.shown || (best >= 0 && p.order < bestOrder))
			continue;
		if (!s_pServerPanels[i] || !s_pServerPanels[i]->isVisible())
			continue;
		for (int c = 1; c <= H9V_MAX_CTRLS; c++)
		{
			const H9CtrlDef& d = p.live.ctrls[c];
			if (d.used && d.type == H9V_CTRL_BUTTON && d.key == slot && (d.flags & 3) == 0)
			{
				best = i;
				bestCtl = c;
				bestOrder = p.order;
				break;
			}
		}
	}
	if (best < 0)
		return false;
	SendReply(s_Panels[best].live.id, bestCtl, "1");
	return true;
}

void H9Vgui_SafeArea(int& x0, int& y0, int& x1, int& y1)
{
	// The top is a thin margin, 1.5% of the height (16 px at 1080): the notice stack and the panels
	// anchored along the top start there, and TS's own top notices (32 px down, 16 px for each live
	// one) are drawn beneath whatever the stack holds (H9Vgui_StackBottom). The bottom band is the
	// chat, 60 px plus seven of the HUD font's lines above the bottom, and TS's HUD under it.
	int top = (s_cvTop && s_cvTop->value > 0.0f) ? (int)s_cvTop->value : Max(8, ScreenHeight * 15 / 1000);
	const int bottom = 60 + 7 * Max(12, gHUD.m_scrinfo.iCharHeight) + 10;
	top = Clamp(top, 0, ScreenHeight / 2);
	x0 = 0;
	y0 = top;
	x1 = ScreenWidth;
	y1 = Max(top + 32, ScreenHeight - bottom);
}

int H9Vgui_StackBottom()
{
	return s_iStackBottom;
}
// ---- end H9 VGUI ------------------------------------------------------------------------------
