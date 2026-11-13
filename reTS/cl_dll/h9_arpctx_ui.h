// ---- H9 ARP context menu: layout, what a click does, how it is drawn --------------------------------------------------------------------
// The geometry of the menu, the rules of the mouse and the keys (a click on a row chooses it, a click on a greyed row says why it cannot be, a right click, ESC or a
// click outside closes it, the number keys choose), and every box and word of it over a CtxCanvas: the engine part gives the canvas FillRGBA and the HUD font
// (h9_arpctx.cpp), a test gives it a list of what was drawn (tests\render_arpctx.cpp, which writes the preview pictures). Pure: no engine in it.
// The commands a choice makes are strings in Ui::out, which the engine part sends ("h9ctx pick <serial> <index>", "h9ctx close <serial>").
//
// Where it stands: just right of the crosshair, its middle at the height of it. The player is looking at the one the menu is about, and the mouse cursor comes
// up in the middle of the screen, so the first row is a short move to the right; on a screen too narrow for that it stands left of the crosshair.
#pragma once

#include "h9_arpctx_model.h"

#include <ctype.h>
#include <stdlib.h>

namespace arpctx
{
// what the line under the rows says when no refusal is on it
static const char kHint[] = "Click or press the number. ESC closes.";

// text measure, set by the engine part (the glyph widths of the HUD font); 8 pixels a character without one
inline int (*g_textW)(const char*) = nullptr;
inline int TextW(const char* s)
{
	return g_textW ? g_textW(s) : (int)strlen(s) * 8;
}

struct IRect
{
	int x, y, w, h;
	IRect() : x(0), y(0), w(0), h(0) {}
	IRect(int X, int Y, int W, int H) : x(X), y(Y), w(W), h(H) {}
	bool Has(int px, int py) const { return px >= x && py >= y && px < x + w && py < y + h; }
	int R() const { return x + w; }
	int B() const { return y + h; }
};

struct Metrics
{
	int ch;     // the font's height
	int pad;    // the margin inside the panel
	int gap;    // between a row's parts
	int rowH;
	int badge;  // the square with a row's number key
	int titleH; // without the line under the heading
	int lineH;  // the status line and the hint
};

// userScale is the player's cl_h9_vgui_scale: it moves the margins, the rows and the width, not the game's font.
inline Metrics MetricsFor(int sh, int charH, float userScale)
{
	const float f = userScale < 0.5f ? 0.5f : (userScale > 2.0f ? 2.0f : userScale);
	const bool big = sh >= 700;
	Metrics m;
	m.ch = charH >= 8 ? charH : 12;
	m.pad = (int)((big ? 12 : 9) * f + 0.5f);
	m.gap = (int)((big ? 10 : 7) * f + 0.5f);
	m.rowH = m.ch + (int)((big ? 12 : 8) * f + 0.5f);
	m.badge = m.ch + 4;
	m.titleH = m.ch + (int)((big ? 14 : 10) * f + 0.5f);
	m.lineH = m.ch + (int)((big ? 8 : 6) * f + 0.5f);
	return m;
}

struct CtxLayout
{
	Metrics m;
	int sw, sh;
	int n;               // rows
	bool lineOn;         // the status line (or the hint) is drawn
	bool subOn;          // the line under the heading is
	IRect panel, title, line;
	IRect row[ROWS_MAX];

	CtxLayout() : sw(0), sh(0), n(0), lineOn(false), subOn(false) { memset(&m, 0, sizeof(m)); }

	// The row at a point, -1 for none.
	int RowAt(int px, int py) const
	{
		for (int i = 0; i < n; i++)
			if (row[i].Has(px, py))
				return i;
		return -1;
	}
};

// A copy of a text in capitals (the credit sign and every other byte above 127 stay as they are).
inline void Upper(const char* s, char* out, int cap)
{
	int i = 0;
	for (; s[i] && i < cap - 1; i++)
		out[i] = (char)((unsigned char)s[i] < 128 ? toupper((unsigned char)s[i]) : s[i]);
	out[i] = 0;
}

inline int MaxInt(int a, int b)
{
	return a > b ? a : b;
}
inline int MinInt(int a, int b)
{
	return a < b ? a : b;
}

// The geometry of the open menu on a screen of sw x sh, whose font is charH high, inside the safe area (the engine part gives it H9Vgui_SafeArea's). A status line
// (or the hint under the rows) takes a line of its own.
inline CtxLayout BuildLayout(const Model& md, int sw, int sh, int charH, float userScale, const IRect& safe, bool lineOn)
{
	CtxLayout L;
	L.sw = sw;
	L.sh = sh;
	L.m = MetricsFor(sh, charH, userScale);
	const Metrics m = L.m;
	L.n = md.numRows;
	L.lineOn = lineOn;
	L.subOn = md.sub[0] != 0;

	// the width: the widest row, the heading, at least a little, at most half the screen
	char head[TITLE_LEN], sub[TITLE_LEN];
	Upper(md.title, head, sizeof(head));
	Upper(md.sub, sub, sizeof(sub));
	int wide = MaxInt(TextW(head), L.subOn ? TextW(sub) : 0) + 2 * m.pad + 3;
	const int arrowW = TextW(">");
	for (int i = 0; i < md.numRows; i++)
	{
		const Row& r = md.rows[i];
		int w = m.pad + m.badge + m.gap + TextW(r.label) + m.pad;
		if (r.note[0])
			w += 2 * m.gap + TextW(r.note);
		if (r.flags & F_MORE)
			w += m.gap + arrowW;
		wide = MaxInt(wide, w);
	}
	// the line under the rows is read whole: the panel is as wide as the hint
	if (lineOn)
		wide = MaxInt(wide, TextW(kHint) + 2 * m.pad + 3);
	const int minW = (int)(sh >= 700 ? 230 : 190);
	wide = MaxInt(wide, minW);
	wide = MinInt(wide, MaxInt(minW, sw / 2));

	// the height; when it is more than the safe area holds the rows, the heading and the line close up to the font's own height and a little, and when even that is
	// too much (twelve rows on a small screen) the menu may stand over the whole screen
	int gaps = 0;
	for (int i = 0; i < md.numRows; i++)
		if (md.rows[i].flags & F_GAP)
			gaps++;
	auto height = [&](const Metrics& k) {
		const int title = k.titleH + (L.subOn ? k.ch + 2 : 0);
		return title + md.numRows * k.rowH + gaps * (k.rowH / 2) + (lineOn ? k.lineH : 0) + k.pad / 2;
	};
	int high = height(L.m);
	IRect area = safe;
	if (high > area.h)
	{
		L.m.rowH = MinInt(L.m.rowH, m.ch + 2);
		L.m.titleH = MinInt(L.m.titleH, m.ch + 4);
		L.m.lineH = MinInt(L.m.lineH, m.ch + 2);
		L.m.pad = MinInt(L.m.pad, 6);
		high = height(L.m);
	}
	if (high > area.h)
		area = IRect(0, 4, sw, sh - 8);
	const Metrics& k = L.m;
	const int titleH = k.titleH + (L.subOn ? k.ch + 2 : 0);
	const int lineH = lineOn ? k.lineH : 0;

	// where: right of the crosshair at its height, left of it when there is no room, and inside the area
	const int gapX = MaxInt(24, sw / 40);
	int x = sw / 2 + gapX;
	if (x + wide > safe.R())
		x = sw / 2 - gapX - wide;
	if (x < safe.x)
		x = safe.x;
	int y = sh / 2 - high / 2;
	if (y + high > area.B())
		y = area.B() - high;
	if (y < area.y)
		y = area.y;

	L.panel = IRect(x, y, wide, high);
	L.title = IRect(x, y, wide, titleH);
	int ry = y + titleH;
	for (int i = 0; i < md.numRows; i++)
	{
		if (md.rows[i].flags & F_GAP)
			ry += k.rowH / 2;
		L.row[i] = IRect(x, ry, wide, k.rowH);
		ry += k.rowH;
	}
	L.line = IRect(x, ry, wide, lineH);
	return L;
}

// the keys the menu takes
enum KeyId
{
	IK_NONE = 0,
	IK_ESC,
	IK_DIGIT,
	IK_WHEEL
};

struct Ui
{
	int hover;       // the row under the mouse, -1 for none
	char out[4][40]; // commands to send
	int nout;
	bool wantClose;  // the player closed the menu: its command is in the queue and the engine part takes it down

	Ui() { Reset(); }

	void Reset()
	{
		hover = -1;
		nout = 0;
		wantClose = false;
		memset(out, 0, sizeof(out));
	}

	void Queue(const char* fmt, int a, int b)
	{
		if (nout >= 4)
			return;
		snprintf(out[nout], sizeof(out[nout]), fmt, a, b);
		nout++;
	}

	void MouseMove(const Model& md, const CtxLayout& L, int mx, int my)
	{
		hover = md.open ? L.RowAt(mx, my) : -1;
	}

	// The row is chosen, or says why it cannot be.
	void Choose(Model& md, int idx, float now)
	{
		if (idx < 0 || idx >= md.numRows)
			return;
		const Row& r = md.rows[idx];
		if (r.On())
			Queue("h9ctx pick %d %d", md.serial, idx);
		else
			md.SetStatus(r.note[0] ? r.note : "That is not available now.", 1, now);
	}

	void Close(Model& md)
	{
		Queue("h9ctx close %d", md.serial, 0);
		wantClose = true;
	}

	// A press of a mouse button (0 the left one, 1 the right one). Returns true when it was the menu's.
	bool MouseDown(Model& md, const CtxLayout& L, int button, int mx, int my, float now)
	{
		if (!md.open)
			return false;
		if (button == 1)
		{
			Close(md);
			return true;
		}
		if (button != 0)
			return true;
		const int idx = L.RowAt(mx, my);
		if (idx >= 0)
			Choose(md, idx, now);
		else if (!L.panel.Has(mx, my))
			Close(md);
		return true;
	}

	// A key press. Every digit is the menu's while it is up, with a row for it or not, so that a mistyped number does not change the player's weapon.
	bool Key(Model& md, KeyId key, int digit, float now)
	{
		if (!md.open)
			return false;
		if (key == IK_ESC)
		{
			Close(md);
			return true;
		}
		if (key == IK_DIGIT)
		{
			Choose(md, md.RowOfKey(digit == 0 ? 10 : digit), now);
			return true;
		}
		return key == IK_WHEEL;
	}
};

struct CtxCanvas
{
	virtual ~CtxCanvas() {}
	virtual void Fill(int x, int y, int w, int h, int r, int g, int b, int a) = 0;
	virtual void Text(int x, int y, int maxX, const char* s, int r, int g, int b) = 0; // stops before a glyph crosses maxX
	virtual int TextW(const char* s) = 0;
	virtual int CharH() = 0;
	virtual int Width() = 0;
	virtual int Height() = 0;
};

struct Col
{
	int r, g, b;
};
const Col LIT = {182, 145, 234};
const Col RAIL = {133, 98, 178};
const Col DET = {166, 154, 192};
const Col TXT = {235, 230, 245};
const Col WARN = {236, 204, 84};
const Col BAD = {236, 96, 96};
const Col DARK = {14, 10, 24};
const Col HEAD = {34, 22, 56};
const Col BAND = {138, 66, 196}; // the highlight band: the colour the player's cl_h9_vgui_color names
const Col WHITE = {255, 255, 255};
const Col OFF = {112, 104, 132}; // a greyed row
const Col OFFNOTE = {150, 136, 172};

struct Painter
{
	CtxCanvas& cv;
	const Model& md;
	const Ui& ui;
	CtxLayout L;
	float now;

	Painter(CtxCanvas& c, const Model& m, const Ui& u, float t, const IRect& safe, float userScale) : cv(c), md(m), ui(u), now(t)
	{
		L = BuildLayout(m, c.Width(), c.Height(), c.CharH(), userScale, safe, true);
	}

	void Txt(int x, int y, const char* s, const Col& c, int maxX) { cv.Text(x, y, maxX, s, c.r, c.g, c.b); }

	void DrawAll()
	{
		if (!md.open)
			return;
		const Metrics& m = L.m;
		const IRect& p = L.panel;

		// the panel: a dark box, a rail on its left edge, a heading band
		cv.Fill(p.x, p.y, p.w, p.h, DARK.r, DARK.g, DARK.b, 214);
		cv.Fill(p.x, p.y, p.w, 1, RAIL.r, RAIL.g, RAIL.b, 200);
		cv.Fill(p.x, p.B() - 1, p.w, 1, RAIL.r, RAIL.g, RAIL.b, 200);
		cv.Fill(p.R() - 1, p.y, 1, p.h, RAIL.r, RAIL.g, RAIL.b, 200);
		cv.Fill(L.title.x + 3, L.title.y + 1, L.title.w - 4, L.title.h - 1, HEAD.r, HEAD.g, HEAD.b, 220);
		cv.Fill(p.x, p.y, 3, p.h, LIT.r, LIT.g, LIT.b, 255);

		// the heading: the player the menu is about, and the line under it
		char head[TITLE_LEN], sub[TITLE_LEN];
		Upper(md.title, head, sizeof(head));
		Upper(md.sub, sub, sizeof(sub));
		const int tx = p.x + 3 + m.pad;
		Txt(tx, L.title.y + (m.titleH - m.ch) / 2, head, LIT, p.R() - m.pad);
		Txt(tx + 1, L.title.y + (m.titleH - m.ch) / 2, head, LIT, p.R() - m.pad + 1);
		if (L.subOn)
			Txt(tx, L.title.y + m.titleH - 1, sub, DET, p.R() - m.pad);

		// the rows
		const int arrowW = cv.TextW(">");
		for (int i = 0; i < md.numRows; i++)
		{
			const Row& r = md.rows[i];
			const IRect& rr = L.row[i];
			const bool on = r.On();
			const bool hot = on && ui.hover == i;
			if (hot)
				cv.Fill(rr.x + 3, rr.y, rr.w - 4, rr.h, BAND.r, BAND.g, BAND.b, 165);
			const int ty = rr.y + (rr.h - m.ch) / 2;

			// the number key
			const int bx = rr.x + 3 + m.pad / 2, by = rr.y + (rr.h - m.badge) / 2;
			cv.Fill(bx, by, m.badge, m.badge, on ? 60 : 36, on ? 40 : 30, on ? 100 : 56, 200);
			if (r.key >= 1)
			{
				char k[3];
				snprintf(k, sizeof(k), "%d", r.key == 10 ? 0 : r.key);
				Txt(bx + (m.badge - cv.TextW(k)) / 2, ty, k, on ? LIT : OFF, bx + m.badge);
			}

			// the label, and at the right the note and the arrow of a page of choices
			const Col& lab = on ? ((r.flags & F_RED) ? BAD : (hot ? WHITE : TXT)) : OFF;
			const int lx = bx + m.badge + m.gap;
			int right = rr.R() - m.pad;
			if (r.flags & F_MORE)
			{
				Txt(right - arrowW, ty, ">", on ? LIT : OFF, rr.R());
				right -= arrowW + m.gap;
			}
			if (r.note[0])
			{
				const int nw = cv.TextW(r.note);
				int nx = right - nw;
				const int minX = lx + cv.TextW(r.label) + m.gap;
				if (nx < minX)
					nx = minX;
				Txt(nx, ty, r.note, on ? DET : OFFNOTE, right + 1);
			}
			Txt(lx, ty, r.label, lab, right);
		}

		// the line under the rows: a refusal the server or a click on a greyed row gave, else what the keys do
		if (L.lineOn)
		{
			const int ly = L.line.y + (L.line.h - m.ch) / 2;
			if (md.HasStatus(now))
				Txt(p.x + 3 + m.pad, ly, md.status, md.statusLevel ? WARN : TXT, p.R() - m.pad);
			else
				Txt(p.x + 3 + m.pad, ly, kHint, OFF, p.R() - m.pad);
		}
	}
};
} // namespace arpctx
