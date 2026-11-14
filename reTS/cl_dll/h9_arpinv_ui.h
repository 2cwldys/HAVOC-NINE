// ---- H9 ARP inventory and exchange: layout and what a click does --------------------------------------------------------------
// The geometry of the inventory window, the exchange window and the popups, and the rules of the mouse and the keys (select, drag a tile
// to another cell, out of the window to drop it, right-click for the menu, split, show, offer, seal). Pure: no engine in it, so a
// test can drive it (reTS\cl_dll\tests\test_arpinv.cpp). It never talks to the server itself: what a click means for the server is a
// command string in Ui::out, which the engine part sends (h9inv ...; DESIGN.md section 3.2).
#pragma once

#include "h9_arpinv_model.h"

#include <stdarg.h>
#include <stdlib.h>

namespace arpinv
{
// ---- text measure, set by the engine part (the glyph widths of the HUD font); 8 pixels a character without one
inline int (*g_textW)(const char*) = nullptr;
inline int TextW(const char* s)
{
	return g_textW ? g_textW(s) : (int)strlen(s) * 8;
}

// The players near enough to show an item to: filled by the engine part (the entities of this client), at most `max`.
struct Near
{
	int index; // the entity index the commands name
	char name[NAME_LEN];
};
inline int (*g_nearPlayers)(Near* out, int max) = nullptr;

struct IRect
{
	int x, y, w, h;
	IRect() : x(0), y(0), w(0), h(0) {}
	IRect(int X, int Y, int W, int H) : x(X), y(Y), w(W), h(H) {}
	bool Has(int px, int py) const { return px >= x && py >= y && px < x + w && py < y + h; }
	int R() const { return x + w; }
	int B() const { return y + h; }
};

struct InvMetrics
{
	int tile;     // an inventory cell
	int offerTile; // a cell of an exchange offer
	int gap;
	int pad;
	int ch;       // a character's height
	int btnH;
	int titleH;
	int infoW;
};

inline InvMetrics MetricsFor(int sh, int charH)
{
	InvMetrics m;
	const bool big = sh >= 700;
	// The cell grows with the screen, so that the name under the picture has the room it needs (h9_arpinv_draw.h, NameLines): the game's font is 19 pixels high
	// and about 7 wide, and a name is 77 pixels long on average. 96 pixels (three lines of the name) from 1000 pixels of height, 80 (two lines) from 700, and the 48
	// pixel cell of a smaller screen holds the picture alone.
	m.tile = sh >= 1000 ? 96 : (big ? 80 : 48);
	m.offerTile = big ? 52 : 40;
	m.gap = big ? 6 : 5;
	m.pad = big ? 16 : 12;
	m.ch = charH >= 8 ? charH : 12;
	m.btnH = m.ch + 12;
	m.titleH = m.ch + 26;
	m.infoW = big ? 270 : 210;
	return m;
}

const int ACT_BUTTONS = 5; // USE, DROP ONE, DROP ALL, SPLIT, SHOW TO (goods change hands by an exchange: E on the player)
const int MENU_MAX = 9;

struct InvLayout
{
	InvMetrics m;
	int sw, sh;
	bool trade;      // an exchange window stands beside the inventory
	bool search;     // a search window does (the two are never up together for one player: the search takes the place)
	int cols, totalRows, visRows, firstRow;
	int scols, stotalRows, svisRows, sfirstRow; // the same of the search window's grid
	// the inventory window
	IRect win, xBtn, grid, info, status, hint, tidy, scrollUp, scrollDn;
	IRect act[ACT_BUTTONS];
	// the exchange window
	IRect twin, tx, offerMine, offerTheirs, myMoney, theirMoney, quick[4], sealBtn, withdrawBtn, mySeal, theirSeal, tstatus;
	// the search window
	IRect swin, sx, sgrid, sscrollUp, sscrollDn, stakeOne, stakeAll, sclose, sstatus, shint;
	// his money: the row that says what his wallet holds and the buttons that take 10, 100 or all of it (only when the server has told his wallet)
	bool smoneyOn;
	IRect smoney, smoneyBtn[3];
	// the invitation
	IRect invite, accept, decline;

	InvLayout() : sw(0), sh(0), trade(false), search(false), cols(8), totalRows(0), visRows(0), firstRow(0), scols(6), stotalRows(0), svisRows(0), sfirstRow(0), smoneyOn(false)
	{
		memset(&m, 0, sizeof(m));
	}

	// the inventory window has no panel of the selected item beside its grid while another window stands beside it
	bool Compact() const { return trade || search; }

	IRect SCellRect(int idx) const
	{
		const int r = idx / scols - sfirstRow, c = idx % scols;
		return IRect(sgrid.x + c * (m.tile + m.gap), sgrid.y + r * (m.tile + m.gap), m.tile, m.tile);
	}
	// The visible cell of the searched player's grid at a point, -1 for none. cells is the length of his grid.
	int SCellAt(int px, int py, int cells) const
	{
		if (!search || !sgrid.Has(px, py))
			return -1;
		const int c = (px - sgrid.x) / (m.tile + m.gap);
		const int r = (py - sgrid.y) / (m.tile + m.gap);
		if (c >= scols || r >= svisRows)
			return -1;
		const int idx = (r + sfirstRow) * scols + c;
		if (idx >= cells || !SCellRect(idx).Has(px, py))
			return -1;
		return idx;
	}

	IRect CellRect(int idx) const
	{
		const int r = idx / cols - firstRow, c = idx % cols;
		return IRect(grid.x + c * (m.tile + m.gap), grid.y + r * (m.tile + m.gap), m.tile, m.tile);
	}
	// The visible cell at a point, -1 for none. slots is the number of cells.
	int CellAt(int px, int py, int slots) const
	{
		if (!grid.Has(px, py))
			return -1;
		const int c = (px - grid.x) / (m.tile + m.gap);
		const int r = (py - grid.y) / (m.tile + m.gap);
		if (c >= cols || r >= visRows)
			return -1;
		const int idx = (r + firstRow) * cols + c;
		if (idx >= slots || !CellRect(idx).Has(px, py))
			return -1;
		return idx;
	}
	IRect OfferRect(int side, int i) const
	{
		const IRect& g = side == 0 ? offerMine : offerTheirs;
		const int r = i / 4, c = i % 4;
		return IRect(g.x + c * (m.offerTile + m.gap), g.y + r * (m.offerTile + m.gap), m.offerTile, m.offerTile);
	}
	int OfferAt(int side, int px, int py, int cells) const
	{
		const IRect& g = side == 0 ? offerMine : offerTheirs;
		if (!g.Has(px, py))
			return -1;
		for (int i = 0; i < cells && i < OFFER_CELLS; i++)
			if (OfferRect(side, i).Has(px, py))
				return i;
		return -1;
	}
};

inline int GridW(const InvMetrics& m, int cols)
{
	return cols * m.tile + (cols - 1) * m.gap;
}

inline int OfferGridW(const InvMetrics& m)
{
	return 4 * m.offerTile + 3 * m.gap;
}

// How far the player has dragged each window from where BuildLayout puts it: 0 the inventory window, 1 the exchange window, 2 the search window.
struct WinOffsets
{
	int dx[3], dy[3];
	WinOffsets()
	{
		for (int i = 0; i < 3; i++)
			dx[i] = dy[i] = 0;
	}
};

inline void ShiftRect(IRect& r, int dx, int dy)
{
	r.x += dx;
	r.y += dy;
}

// Moves one window and everything that is drawn or clicked in it, by the offset the player gave it, but never off the screen: a window that
// was dragged to the edge of a larger screen is brought back in when the screen is smaller.
inline void ShiftWindow(IRect& win, IRect* const* parts, int nparts, int sw, int sh, int dx, int dy)
{
	int nx = win.x + dx, ny = win.y + dy;
	const int maxX = sw - win.w, maxY = sh - win.h;
	if (nx > maxX)
		nx = maxX;
	if (nx < 0)
		nx = 0;
	if (ny > maxY)
		ny = maxY;
	if (ny < 0)
		ny = 0;
	const int mx = nx - win.x, my = ny - win.y;
	if (!mx && !my)
		return;
	ShiftRect(win, mx, my);
	for (int i = 0; i < nparts; i++)
		ShiftRect(*parts[i], mx, my);
}

inline void ApplyOffsets(InvLayout& L, const WinOffsets& o)
{
	{
		IRect* parts[] = {&L.xBtn, &L.grid, &L.info, &L.status, &L.hint, &L.tidy, &L.scrollUp, &L.scrollDn,
						  &L.act[0], &L.act[1], &L.act[2], &L.act[3], &L.act[4]};
		ShiftWindow(L.win, parts, (int)(sizeof(parts) / sizeof(parts[0])), L.sw, L.sh, o.dx[0], o.dy[0]);
	}
	if (L.trade)
	{
		IRect* parts[] = {&L.tx, &L.offerMine, &L.offerTheirs, &L.myMoney, &L.theirMoney, &L.quick[0], &L.quick[1], &L.quick[2], &L.quick[3],
						  &L.sealBtn, &L.withdrawBtn, &L.mySeal, &L.theirSeal, &L.tstatus};
		ShiftWindow(L.twin, parts, (int)(sizeof(parts) / sizeof(parts[0])), L.sw, L.sh, o.dx[1], o.dy[1]);
	}
	if (L.search)
	{
		IRect* parts[] = {&L.sx, &L.sgrid, &L.sscrollUp, &L.sscrollDn, &L.stakeOne, &L.stakeAll, &L.sclose, &L.sstatus, &L.shint,
									  &L.smoney, &L.smoneyBtn[0], &L.smoneyBtn[1], &L.smoneyBtn[2]};
		ShiftWindow(L.swin, parts, (int)(sizeof(parts) / sizeof(parts[0])), L.sw, L.sh, o.dx[2], o.dy[2]);
	}
}

// The geometry for this model, screen and scroll. slots is the number of cells to lay out. off, when given, is where the player dragged the windows to.
inline InvLayout BuildLayout(const Model& md, int sw, int sh, int charH, int scroll, int sscroll = 0, const WinOffsets* off = nullptr)
{
	InvLayout L;
	L.m = MetricsFor(sh, charH);
	L.sw = sw;
	L.sh = sh;
	const InvMetrics& m = L.m;
	L.search = md.search.open;
	L.trade = md.trade.open && !L.search;
	const bool compact = L.trade || L.search;

	// as many columns as fit the screen beside the exchange or the search window, down to four (three beside either)
	const int twW = m.pad * 2 + OfferGridW(m) * 2 + 44;
	const int infoW = compact ? 0 : (sw < 800 ? m.infoW - 20 : m.infoW);
	int cols = 8;
	int scols = 6;
	int invW = 0;
	int swW = 0;
	for (;;)
	{
		invW = m.pad * 2 + GridW(m, cols) + (infoW ? m.gap * 2 + infoW : 0);
		swW = m.pad * 2 + GridW(m, scols);
		const int total = invW + (L.trade ? 12 + twW : (L.search ? 12 + swW : 0));
		if (total <= sw - 8)
			break;
		if (L.search)
		{
			// the wider of the two grids loses a column first; neither goes below three
			if (cols > scols + 2)
				cols--;
			else if (scols > 3)
				scols--;
			else if (cols > 3)
				cols--;
			else
				break;
			continue;
		}
		if (cols <= (L.trade ? 3 : 4))
			break;
		cols--;
	}
	L.cols = cols;
	L.scols = scols;
	const int cells = md.slots < cols ? cols : md.slots;
	L.totalRows = (cells + cols - 1) / cols;
	// the rows that show: four, or more beside an exchange when the columns were cut, as many as the screen's height holds
	const int chrome = m.titleH + 8 + 8 + (m.ch + 8) + (m.ch + 6) + m.pad;
	int fit = (sh - 16 - chrome + m.gap) / (m.tile + m.gap);
	if (fit < 1)
		fit = 1;
	int maxVis = (compact && cols < 8) ? 8 : 4;
	if (maxVis > fit)
		maxVis = fit;
	L.visRows = L.totalRows < maxVis ? L.totalRows : maxVis;
	int maxFirst = L.totalRows - L.visRows;
	if (maxFirst < 0)
		maxFirst = 0;
	L.firstRow = scroll < 0 ? 0 : (scroll > maxFirst ? maxFirst : scroll);

	const int gridH = L.visRows * (m.tile + m.gap) - m.gap;
	const int infoNeed = (sh >= 700) ? 250 : 220;
	const int innerH = (infoW && gridH < infoNeed) ? infoNeed : gridH;
	const int statusH = m.ch + 8;
	const int hintH = m.ch + 6;
	const int winH = m.titleH + 8 + innerH + 8 + statusH + hintH + m.pad;

	// the search window's rows: as many as the inventory's and the screen's height allow, in its own columns, with a row of buttons under the grid
	int sgridH = 0, swinH = 0;
	if (L.search)
	{
		const int scells = md.search.cells < scols ? scols : md.search.cells;
		L.stotalRows = (scells + scols - 1) / scols;
		int sfit = (sh - 16 - (chrome + m.btnH + 8) + m.gap) / (m.tile + m.gap);
		if (sfit < 1)
			sfit = 1;
		const int sMaxVis = maxVis < sfit ? maxVis : sfit;
		L.svisRows = L.stotalRows < sMaxVis ? L.stotalRows : sMaxVis;
		int sMaxFirst = L.stotalRows - L.svisRows;
		if (sMaxFirst < 0)
			sMaxFirst = 0;
		L.sfirstRow = sscroll < 0 ? 0 : (sscroll > sMaxFirst ? sMaxFirst : sscroll);
		sgridH = L.svisRows * (m.tile + m.gap) - m.gap;
		L.smoneyOn = md.search.money >= 0;
		swinH = m.titleH + 8 + sgridH + 8 + m.btnH + 8 + (L.smoneyOn ? (m.ch + 8) + 4 + m.btnH + 8 : 0) + statusH + hintH + m.pad;
		if (swinH < winH)
			swinH = winH;
	}

	// the pair of windows is centred together
	const int totalW = invW + (L.trade ? 12 + twW : (L.search ? 12 + swW : 0));
	int wx = (sw - totalW) / 2;
	if (wx < 4)
		wx = 4;
	int wy = (sh - (swinH > winH ? swinH : winH)) / 2;
	if (wy < 8)
		wy = 8;
	L.win = IRect(wx, wy, invW, winH);
	const int xs = m.ch + 8;
	L.xBtn = IRect(L.win.R() - m.pad - xs + 6, L.win.y + 8, xs, xs);
	L.grid = IRect(L.win.x + m.pad, L.win.y + m.titleH + 8, GridW(m, cols), gridH);
	if (infoW)
		L.info = IRect(L.grid.R() + m.gap * 2, L.grid.y, infoW, innerH);
	L.status = IRect(L.win.x + m.pad, L.grid.y + innerH + 8, invW - m.pad * 2 - 76, statusH);
	L.hint = IRect(L.win.x + m.pad, L.status.B(), invW - m.pad * 2, hintH);
	L.tidy = IRect(L.win.R() - m.pad - 70, L.status.y - 2, 70, m.btnH);
	if (L.totalRows > L.visRows)
	{
		L.scrollUp = IRect(L.grid.R() + 1, L.grid.y, m.gap * 2 - 2, 18);
		L.scrollDn = IRect(L.grid.R() + 1, L.grid.B() - 18, m.gap * 2 - 2, 18);
	}
	if (infoW)
	{
		const int bw = (infoW - m.pad * 2 - m.gap) / 2;
		const int bh = m.btnH;
		const int rowsH = 3 * bh + 2 * m.gap;
		const int by = L.info.B() - m.pad / 2 - rowsH;
		for (int i = 0; i < ACT_BUTTONS; i++)
		{
			const int c = i % 2, r = i / 2;
			// the last button, alone in its row, takes the whole row
			const bool whole = (i == ACT_BUTTONS - 1) && (ACT_BUTTONS % 2 == 1);
			L.act[i] = IRect(L.info.x + m.pad + c * (bw + m.gap), by + r * (bh + m.gap), whole ? 2 * bw + m.gap : bw, bh);
		}
	}

	if (L.trade)
	{
		const int ox = L.win.R() + 12;
		const int og = m.titleH + 8 + m.ch + 6;
		const int gridH3 = 3 * m.offerTile + 2 * m.gap;
		const int twH = og + gridH3 + 8 + (m.ch + 10) + 6 + m.btnH + 8 + m.ch + 6 + (m.btnH + 6) + 8 + (m.ch + 6) + m.pad;
		L.twin = IRect(ox, wy, twW, twH < winH ? winH : twH);
		L.tx = IRect(L.twin.R() - m.pad - xs + 6, L.twin.y + 8, xs, xs);
		L.offerMine = IRect(L.twin.x + m.pad, L.twin.y + og, OfferGridW(m), gridH3);
		L.offerTheirs = IRect(L.twin.R() - m.pad - OfferGridW(m), L.twin.y + og, OfferGridW(m), gridH3);
		const int my = L.offerMine.B() + 8;
		L.myMoney = IRect(L.offerMine.x, my, OfferGridW(m), m.ch + 10);
		L.theirMoney = IRect(L.offerTheirs.x, my, OfferGridW(m), m.ch + 10);
		const int qy = L.myMoney.B() + 6;
		const int qw = (OfferGridW(m) - 3 * m.gap) / 4;
		for (int i = 0; i < 4; i++)
			L.quick[i] = IRect(L.offerMine.x + i * (qw + m.gap), qy, qw, m.btnH);
		const int sy = qy + m.btnH + 8;
		L.mySeal = IRect(L.offerMine.x, sy, OfferGridW(m), m.ch + 6);
		L.theirSeal = IRect(L.offerTheirs.x, sy, OfferGridW(m), m.ch + 6);
		const int by = L.mySeal.B() + 6;
		const int sealW = OfferGridW(m) + 24;
		L.sealBtn = IRect(L.twin.x + m.pad, by, sealW, m.btnH + 6);
		L.withdrawBtn = IRect(L.twin.R() - m.pad - 150, by, 150, m.btnH + 6);
		L.tstatus = IRect(L.twin.x + m.pad, L.sealBtn.B() + 8, twW - m.pad * 2, m.ch + 6);
	}

	if (L.search)
	{
		L.swin = IRect(L.win.R() + 12, wy, swW, swinH);
		L.sx = IRect(L.swin.R() - m.pad - xs + 6, L.swin.y + 8, xs, xs);
		L.sgrid = IRect(L.swin.x + m.pad, L.swin.y + m.titleH + 8, GridW(m, scols), sgridH);
		if (L.stotalRows > L.svisRows)
		{
			L.sscrollUp = IRect(L.sgrid.R() + 1, L.sgrid.y, m.gap * 2 - 2, 18);
			L.sscrollDn = IRect(L.sgrid.R() + 1, L.sgrid.B() - 18, m.gap * 2 - 2, 18);
		}
		const int inner = swW - m.pad * 2;
		const int bw = (inner - 2 * m.gap) / 3;
		const int by = L.sgrid.B() + 8;
		L.stakeOne = IRect(L.swin.x + m.pad, by, bw, m.btnH);
		L.stakeAll = IRect(L.stakeOne.R() + m.gap, by, bw, m.btnH);
		L.sclose = IRect(L.stakeAll.R() + m.gap, by, inner - 2 * bw - 2 * m.gap, m.btnH);
		int below = by + m.btnH + 8;
		if (L.smoneyOn)
		{
			L.smoney = IRect(L.swin.x + m.pad, below, inner, m.ch + 8);
			const int mb = L.smoney.B() + 4;
			for (int i = 0; i < 3; i++)
				L.smoneyBtn[i] = IRect(L.swin.x + m.pad + i * (bw + m.gap), mb, i == 2 ? inner - 2 * bw - 2 * m.gap : bw, m.btnH);
			below = mb + m.btnH + 8;
		}
		L.sstatus = IRect(L.swin.x + m.pad, below, inner, statusH);
		L.shint = IRect(L.swin.x + m.pad, L.sstatus.B(), inner, hintH);
	}

	if (off)
		ApplyOffsets(L, *off);

	// the invitation: a banner at the top of the screen
	const int iw = 420;
	L.invite = IRect((sw - iw) / 2, 70, iw, m.titleH + m.btnH + 28);
	L.accept = IRect(L.invite.x + 40, L.invite.B() - m.btnH - 10, 150, m.btnH);
	L.decline = IRect(L.invite.R() - 40 - 150, L.invite.B() - m.btnH - 10, 150, m.btnH);
	return L;
}

// ---- what a click does -------------------------------------------------------------------------------------------------------

struct Out
{
	char text[96];
};

enum Popup
{
	POP_NONE = 0,
	POP_CONTEXT,
	POP_SPLIT,
	POP_PLAYERS
};

enum Item // a line of the context menu
{
	MI_USE,
	MI_DROP1,
	MI_DROPALL,
	MI_SPLIT,
	MI_SHOW,
	MI_INFO,
	MI_OFFER,
	MI_TAKE1,   // the lines of the menu of a cell of the searched player's grid
	MI_TAKEALL,
	MI_TAKEN
};

inline const char* ItemText(int m)
{
	switch (m)
	{
	case MI_USE: return "USE";
	case MI_DROP1: return "DROP ONE";
	case MI_DROPALL: return "DROP ALL";
	case MI_SPLIT: return "SPLIT ...";
	case MI_SHOW: return "SHOW TO ...";
	case MI_INFO: return "INFO";
	case MI_OFFER: return "OFFER";
	case MI_TAKE1: return "TAKE ONE";
	case MI_TAKEALL: return "TAKE ALL";
	case MI_TAKEN: return "TAKE ...";
	default: return "";
	}
}

enum KeyId
{
	IK_NONE = 0,
	IK_ESC,
	IK_ENTER,
	IK_BACK,
	IK_DIGIT, // digit in Ui::Key's second argument
	IK_WHEEL_UP,
	IK_WHEEL_DOWN
};

const int DRAG_START = 5; // pixels the cursor must move with the button down before a tile is dragged

struct Ui
{
	int selected;
	int hover;
	int scroll;
	bool shift;
	int mx, my;
	bool down; // the left button
	int pressCell, pressOffer, pressX, pressY;
	bool dragging;
	int dragCell, dragOffer;
	float lastClickAt;
	int lastClickCell;
	// popups
	Popup popup;
	int popupCell;
	IRect popupRect;
	int popupItems[MENU_MAX];
	int popupCount;
	int popupHover;
	int playersFor; // MI_SHOW
	Near near[8];
	int nearCount;
	char splitText[8];
	int splitMax;
	// the money field of the exchange
	bool editMoney;
	char moneyText[12];
	// the search window: its own selection, hover, scroll, press and drag (a tile of HIS grid), and whether the popup is about one of his cells
	int sSelected, sHover, sScroll;
	int sPressCell, sDragCell;
	int sLastClickCell;
	float sLastClickAt;
	bool popupTheirs;
	// outputs
	Out out[10];
	int nout;
	bool wantClose; // the window's X, ESC or the open key: the engine part closes it
	bool wantOpenTrade;
	bool wantSearchClose; // the search window's X, CLOSE or ESC: the command is in out, and the engine part forgets the search
	// where the player dragged the windows to (kept while the game runs: Reset leaves it), and the window whose title bar is held, -1 for none
	WinOffsets win;
	int winDrag, winLastX, winLastY;

	Ui() { Reset(); }

	void Reset()
	{
		selected = -1;
		hover = -1;
		scroll = 0;
		shift = false;
		mx = my = 0;
		down = false;
		pressCell = pressOffer = -1;
		pressX = pressY = 0;
		dragging = false;
		dragCell = dragOffer = -1;
		lastClickAt = -10.0f;
		lastClickCell = -1;
		popup = POP_NONE;
		popupCell = -1;
		popupRect = IRect();
		popupCount = 0;
		popupHover = -1;
		playersFor = 0;
		nearCount = 0;
		splitText[0] = 0;
		splitMax = 0;
		editMoney = false;
		moneyText[0] = 0;
		sSelected = sHover = -1;
		sScroll = 0;
		sPressCell = sDragCell = -1;
		sLastClickCell = -1;
		sLastClickAt = -10.0f;
		popupTheirs = false;
		winDrag = -1;
		winLastX = winLastY = 0;
		nout = 0;
		wantClose = false;
		wantOpenTrade = false;
		wantSearchClose = false;
	}

	// The search window has gone, closed by the player or by the server: what belonged to it goes with it.
	void EndSearch()
	{
		if (sDragCell >= 0)
			dragging = false;
		sSelected = sHover = -1;
		sScroll = 0;
		sPressCell = sDragCell = -1;
		sLastClickCell = -1;
		if (popupTheirs)
			ClosePopup();
	}

	void Say(const char* fmt, ...)
	{
		if (nout >= (int)(sizeof(out) / sizeof(out[0])))
			return;
		va_list ap;
		va_start(ap, fmt);
		vsnprintf(out[nout].text, sizeof(out[nout].text), fmt, ap);
		va_end(ap);
		nout++;
	}

	// ---- helpers
	static int CellN(const Model& md, int cell)
	{
		return (cell >= 0 && cell < MAX_CELLS) ? md.cells[cell].n : 0;
	}

	bool PopupOpen() const { return popup != POP_NONE; }

	void ClosePopup()
	{
		popup = POP_NONE;
		popupHover = -1;
		popupTheirs = false;
	}

	// The lines the menu of a cell has.
	int BuildMenu(const Model& md, int cell, int* items) const
	{
		int n = 0;
		const Cell& c = md.cells[cell];
		items[n++] = MI_USE;
		items[n++] = MI_DROP1;
		if (c.n > 1)
			items[n++] = MI_DROPALL;
		if (c.n > 1)
			items[n++] = MI_SPLIT;
		items[n++] = MI_SHOW;
		if (md.trade.open)
			items[n++] = MI_OFFER;
		items[n++] = MI_INFO;
		return n;
	}

	// A popup rectangle that fits on the screen and has the width of its widest line.
	IRect FitPopup(const InvLayout& L, int x, int y, int lines, int widest) const
	{
		const int w = widest + 40 < 150 ? 150 : widest + 40;
		const int h = lines * (L.m.ch + 8) + 12;
		int px = x, py = y;
		if (px + w > L.sw - 4)
			px = L.sw - 4 - w;
		if (py + h > L.sh - 4)
			py = L.sh - 4 - h;
		if (px < 4)
			px = 4;
		if (py < 4)
			py = 4;
		return IRect(px, py, w, h);
	}

	void OpenContext(const Model& md, const InvLayout& L, int cell, int x, int y)
	{
		if (cell < 0 || md.cells[cell].kind == 0)
		{
			ClosePopup();
			return;
		}
		selected = cell;
		popup = POP_CONTEXT;
		popupCell = cell;
		popupCount = BuildMenu(md, cell, popupItems);
		int widest = 0;
		for (int i = 0; i < popupCount; i++)
		{
			const int w = TextW(ItemText(popupItems[i]));
			if (w > widest)
				widest = w;
		}
		popupRect = FitPopup(L, x, y, popupCount, widest);
		popupHover = -1;
	}

	void OpenPlayers(const InvLayout& L, int cell, int which)
	{
		playersFor = which;
		nearCount = g_nearPlayers ? g_nearPlayers(near, 8) : 0;
		if (nearCount < 0)
			nearCount = 0;
		popup = POP_PLAYERS;
		popupCell = cell;
		int widest = TextW("NO PLAYER NEAR");
		for (int i = 0; i < nearCount; i++)
		{
			const int w = TextW(near[i].name);
			if (w > widest)
				widest = w;
		}
		popupRect = FitPopup(L, popupRect.x, popupRect.y, (nearCount ? nearCount : 1) + 1, widest);
		popupHover = -1;
	}

	void OpenSplit(const Model& md, const InvLayout& L, int cell)
	{
		const int n = CellN(md, cell);
		if (n < 2)
			return;
		popup = POP_SPLIT;
		popupCell = cell;
		splitMax = n - 1;
		snprintf(splitText, sizeof(splitText), "%d", n / 2);
		popupRect = FitPopup(L, popupRect.x, popupRect.y, 5, 150);
		popupRect.w = 230;
		popupHover = -1;
	}

	// ---- the cells of the searched player's grid: what a right click on one offers, and what each line asks of the server
	int BuildMenuTheirs(const Model& md, int cell, int* items) const
	{
		int n = 0;
		const Cell& c = md.search.theirs[cell];
		items[n++] = MI_TAKEALL;
		if (c.n > 1)
		{
			items[n++] = MI_TAKE1;
			items[n++] = MI_TAKEN;
		}
		items[n++] = MI_INFO;
		return n;
	}

	void OpenContextTheirs(const Model& md, const InvLayout& L, int cell, int x, int y)
	{
		if (cell < 0 || cell >= MAX_CELLS || md.search.theirs[cell].kind == 0)
		{
			ClosePopup();
			return;
		}
		sSelected = cell;
		popup = POP_CONTEXT;
		popupTheirs = true;
		popupCell = cell;
		popupCount = BuildMenuTheirs(md, cell, popupItems);
		int widest = 0;
		for (int i = 0; i < popupCount; i++)
		{
			const int w = TextW(ItemText(popupItems[i]));
			if (w > widest)
				widest = w;
		}
		popupRect = FitPopup(L, x, y, popupCount, widest);
		popupHover = -1;
	}

	// The box that asks how many of a cell of his to take.
	void OpenTake(const Model& md, const InvLayout& L, int cell)
	{
		const int n = (cell >= 0 && cell < MAX_CELLS) ? md.search.theirs[cell].n : 0;
		if (n < 2)
			return;
		popup = POP_SPLIT;
		popupTheirs = true;
		popupCell = cell;
		splitMax = n;
		snprintf(splitText, sizeof(splitText), "%d", n);
		popupRect = FitPopup(L, popupRect.x, popupRect.y, 5, 150);
		popupRect.w = 230;
		popupHover = -1;
	}

	void RunTheirs(const Model& md, const InvLayout& L, int item, int cell)
	{
		const Cell& c = md.search.theirs[cell];
		switch (item)
		{
		case MI_TAKEALL:
			Say("h9inv s take %d %d", cell, c.n);
			break;
		case MI_TAKE1:
			Say("h9inv s take %d 1", cell);
			break;
		case MI_TAKEN:
			OpenTake(md, L, cell);
			return;
		case MI_INFO:
		{
			const Kind* k = md.FindKind(c.kind);
			if (k)
				Say("h9inv info %d", k->id);
			sSelected = cell;
			break;
		}
		}
		ClosePopup();
	}

	// The OK of the box that splits a cell of mine or takes some of a cell of his.
	void CommitSplit()
	{
		if (popupTheirs)
			Say("h9inv s take %d %d", popupCell, SplitValue());
		else
			Say("h9inv split %d %d 255", popupCell, SplitValue());
		ClosePopup();
	}

	// The command that ends the search, and the sign for the engine part to forget it.
	void CloseSearch()
	{
		Say("h9inv s close");
		wantSearchClose = true;
	}

	// The count a split box holds, clamped to 1..splitMax.
	int SplitValue() const
	{
		int v = atoi(splitText);
		if (v < 1)
			v = 1;
		if (v > splitMax)
			v = splitMax;
		return v;
	}

	IRect SplitMinus() const { return IRect(popupRect.x + 12, popupRect.y + 40, 26, 22); }
	IRect SplitPlus() const { return IRect(popupRect.R() - 12 - 26, popupRect.y + 40, 26, 22); }
	IRect SplitField() const { return IRect(popupRect.x + 44, popupRect.y + 40, popupRect.w - 88, 22); }
	IRect SplitOk() const { return IRect(popupRect.x + 12, popupRect.B() - 34, (popupRect.w - 36) / 2, 24); }
	IRect SplitCancel() const { return IRect(popupRect.R() - 12 - (popupRect.w - 36) / 2, popupRect.B() - 34, (popupRect.w - 36) / 2, 24); }

	void Run(const Model& md, const InvLayout& L, int item, int cell)
	{
		const Cell& c = md.cells[cell];
		const Kind* k = md.FindKind(c.kind);
		switch (item)
		{
		case MI_USE:
			Say("h9inv use %d", cell);
			break;
		case MI_DROP1:
			Say("h9inv drop %d 1", cell);
			break;
		case MI_DROPALL:
			Say("h9inv drop %d %d", cell, c.n);
			break;
		case MI_SPLIT:
			OpenSplit(md, L, cell);
			return;
		case MI_SHOW:
			OpenPlayers(L, cell, MI_SHOW);
			return;
		case MI_INFO:
			if (k)
				Say("h9inv info %d", k->id);
			selected = cell;
			break;
		case MI_OFFER:
			Say("h9inv x offer %d %d 255", cell, c.n - c.reserved > 0 ? c.n - c.reserved : c.n);
			break;
		}
		ClosePopup();
	}

	// ---- the mouse

	// The window whose title bar is at a point (not the button in it that closes the window): 0 the inventory, 1 the exchange, 2 the search, -1 none.
	// The windows beside the inventory are drawn over it, so they answer first.
	int TitleAt(const InvLayout& L, int x, int y) const
	{
		const int th = L.m.titleH;
		if (L.search && IRect(L.swin.x, L.swin.y, L.swin.w, th).Has(x, y) && !L.sx.Has(x, y))
			return 2;
		if (L.trade && IRect(L.twin.x, L.twin.y, L.twin.w, th).Has(x, y) && !L.tx.Has(x, y))
			return 1;
		if (IRect(L.win.x, L.win.y, L.win.w, th).Has(x, y) && !L.xBtn.Has(x, y))
			return 0;
		return -1;
	}

	// The held window follows the cursor: its offset changes by what the cursor moved, and ShiftWindow keeps it on the screen.
	void MoveWindow(const InvLayout& L, int which, int ddx, int ddy)
	{
		const IRect& r = which == 0 ? L.win : (which == 1 ? L.twin : L.swin);
		int nx = r.x + ddx, ny = r.y + ddy;
		const int maxX = L.sw - r.w, maxY = L.sh - r.h;
		if (nx > maxX)
			nx = maxX;
		if (nx < 0)
			nx = 0;
		if (ny > maxY)
			ny = maxY;
		if (ny < 0)
			ny = 0;
		win.dx[which] += nx - r.x;
		win.dy[which] += ny - r.y;
	}

	void MouseMove(const Model& md, const InvLayout& L, int x, int y)
	{
		mx = x;
		my = y;
		if (winDrag >= 0)
		{
			if (down)
			{
				MoveWindow(L, winDrag, x - winLastX, y - winLastY);
				winLastX = x;
				winLastY = y;
			}
			else
				winDrag = -1;
			return;
		}
		hover = L.CellAt(x, y, md.slots);
		sHover = L.SCellAt(x, y, md.search.cells);
		if (popup == POP_CONTEXT || popup == POP_PLAYERS)
		{
			popupHover = -1;
			const int lines = popup == POP_CONTEXT ? popupCount : (nearCount ? nearCount : 1);
			for (int i = 0; i < lines; i++)
			{
				const IRect r(popupRect.x + 4, popupRect.y + 6 + i * (L.m.ch + 8), popupRect.w - 8, L.m.ch + 8);
				if (r.Has(x, y))
					popupHover = i;
			}
		}
		if (down && !dragging && (pressCell >= 0 || pressOffer >= 0 || sPressCell >= 0))
		{
			const int dx = x - pressX, dy = y - pressY;
			if (dx * dx + dy * dy >= DRAG_START * DRAG_START)
			{
				if (pressCell >= 0 && md.cells[pressCell].kind != 0)
				{
					dragging = true;
					dragCell = pressCell;
				}
				else if (pressOffer >= 0 && md.trade.mine[pressOffer].kind != 0)
				{
					dragging = true;
					dragOffer = pressOffer;
				}
				else if (sPressCell >= 0 && sPressCell < MAX_CELLS && md.search.theirs[sPressCell].kind != 0)
				{
					dragging = true;
					sDragCell = sPressCell;
				}
			}
		}
	}

	void MouseDown(const Model& md, const InvLayout& L, int button, int x, int y, float now)
	{
		mx = x;
		my = y;
		// a pending invitation answers first
		if (md.trade.invite && !md.trade.open && L.invite.Has(x, y))
		{
			if (button == 0 && L.accept.Has(x, y))
				Say("h9inv x accept");
			else if (button == 0 && L.decline.Has(x, y))
				Say("h9inv x decline");
			return;
		}

		if (popup != POP_NONE)
		{
			if (popupRect.Has(x, y))
			{
				if (button == 0)
					PopupClick(md, L, x, y);
				return;
			}
			ClosePopup(); // a click outside only closes it
			return;
		}

		if (editMoney && !L.myMoney.Has(x, y))
			CommitMoney(md);

		if (button == 1)
		{
			const int cell = L.CellAt(x, y, md.slots);
			if (cell >= 0)
			{
				OpenContext(md, L, cell, x, y);
				return;
			}
			const int theirs = L.SCellAt(x, y, md.search.cells);
			if (theirs >= 0)
				OpenContextTheirs(md, L, theirs, x, y);
			return;
		}
		if (button != 0)
			return;

		down = true;
		pressX = x;
		pressY = y;
		pressCell = pressOffer = sPressCell = -1;
		dragging = false;

		if (L.xBtn.Has(x, y))
		{
			wantClose = true;
			down = false;
			return;
		}
		// the title bar of a window takes hold of it: the cursor drags it until the button is let go
		const int held = TitleAt(L, x, y);
		if (held >= 0)
		{
			winDrag = held;
			winLastX = x;
			winLastY = y;
			return;
		}
		if (L.tidy.Has(x, y))
		{
			Say("h9inv tidy");
			down = false;
			return;
		}
		if (L.totalRows > L.visRows)
		{
			if (L.scrollUp.Has(x, y))
			{
				ScrollBy(md, L, -1);
				down = false;
				return;
			}
			if (L.scrollDn.Has(x, y))
			{
				ScrollBy(md, L, 1);
				down = false;
				return;
			}
		}
		if (L.search)
		{
			if (L.sx.Has(x, y) || L.sclose.Has(x, y))
			{
				CloseSearch();
				down = false;
				return;
			}
			if (L.stotalRows > L.svisRows)
			{
				if (L.sscrollUp.Has(x, y))
				{
					ScrollTheirs(md, L, -1);
					down = false;
					return;
				}
				if (L.sscrollDn.Has(x, y))
				{
					ScrollTheirs(md, L, 1);
					down = false;
					return;
				}
			}
			if (L.stakeOne.Has(x, y) || L.stakeAll.Has(x, y))
			{
				down = false;
				if (sSelected >= 0 && sSelected < MAX_CELLS && md.search.theirs[sSelected].kind != 0)
					Say("h9inv s take %d %d", sSelected, L.stakeOne.Has(x, y) ? 1 : md.search.theirs[sSelected].n);
				return;
			}
			if (L.smoneyOn)
			{
				for (int i = 0; i < 3; i++)
				{
					if (!L.smoneyBtn[i].Has(x, y))
						continue;
					down = false;
					// 10, 100 or all that he has: never more than the server last said he holds
					int v = i == 0 ? 10 : (i == 1 ? 100 : md.search.money);
					if (v > md.search.money)
						v = md.search.money;
					if (v > 0)
						Say("h9inv s money %d", v);
					return;
				}
				if (L.smoney.Has(x, y))
				{
					down = false;
					return;
				}
			}
			const int theirs = L.SCellAt(x, y, md.search.cells);
			if (theirs >= 0)
			{
				sPressCell = theirs;
				sSelected = theirs;
				// a second click on the same cell of his in a moment takes all of it
				if (theirs == sLastClickCell && now - sLastClickAt < 0.35f && md.search.theirs[theirs].kind != 0)
				{
					Say("h9inv s take %d %d", theirs, md.search.theirs[theirs].n);
					sLastClickCell = -1;
					down = false;
					sPressCell = -1;
					return;
				}
				sLastClickCell = theirs;
				sLastClickAt = now;
				return;
			}
		}
		if (!L.trade)
		{
			for (int i = 0; i < ACT_BUTTONS; i++)
			{
				if (!L.act[i].Has(x, y))
					continue;
				down = false;
				if (selected < 0 || md.cells[selected].kind == 0)
					return;
				const int map[ACT_BUTTONS] = {MI_USE, MI_DROP1, MI_DROPALL, MI_SPLIT, MI_SHOW};
				popupRect = IRect(x, y, 0, 0);
				Run(md, L, map[i], selected);
				return;
			}
		}
		else
		{
			if (L.tx.Has(x, y) || L.withdrawBtn.Has(x, y))
			{
				Say("h9inv x cancel");
				down = false;
				return;
			}
			if (L.sealBtn.Has(x, y))
			{
				down = false;
				if (md.trade.mySealed)
					Say("h9inv x unseal");
				else if (now >= md.trade.lockUntil)
					Say("h9inv x seal");
				return;
			}
			if (L.myMoney.Has(x, y))
			{
				down = false;
				editMoney = true;
				snprintf(moneyText, sizeof(moneyText), "%d", md.trade.myMoney);
				return;
			}
			for (int i = 0; i < 4; i++)
			{
				if (!L.quick[i].Has(x, y))
					continue;
				down = false;
				int v = md.trade.myMoney;
				if (i == 0)
					v += 10;
				else if (i == 1)
					v += 100;
				else if (i == 2)
					v = md.trade.wallet;
				else
					v = 0;
				if (v > md.trade.wallet)
					v = md.trade.wallet;
				Say("h9inv x money %d", v);
				return;
			}
			const int oc = L.OfferAt(0, x, y, md.trade.cells);
			if (oc >= 0)
			{
				pressOffer = oc;
				return;
			}
		}

		const int cell = L.CellAt(x, y, md.slots);
		if (cell >= 0)
		{
			pressCell = cell;
			selected = cell;
			// a second click on the same cell in a moment uses it
			if (cell == lastClickCell && now - lastClickAt < 0.35f && md.cells[cell].kind != 0)
			{
				Say("h9inv use %d", cell);
				lastClickCell = -1;
				down = false;
				pressCell = -1;
				return;
			}
			lastClickCell = cell;
			lastClickAt = now;
		}
	}

	void MouseUp(const Model& md, const InvLayout& L, int button, int x, int y, float now)
	{
		(void)now;
		mx = x;
		my = y;
		if (button == 0 && winDrag >= 0)
		{
			winDrag = -1;
			down = false;
			return;
		}
		if (button != 0 || !down)
		{
			if (button == 0)
				down = false;
			return;
		}
		down = false;
		const bool was = dragging;
		dragging = false;
		const int fromCell = dragCell, fromOffer = dragOffer, fromTheirs = sDragCell, clickedOffer = pressOffer;
		dragCell = dragOffer = sDragCell = -1;
		pressCell = pressOffer = sPressCell = -1;
		if (!was)
		{
			// a click on one of my own offered cells takes it back
			if (clickedOffer >= 0 && md.trade.mine[clickedOffer].kind != 0)
				Say("h9inv x take %d", clickedOffer);
			return;
		}

		if (fromTheirs >= 0)
		{
			// a tile of his dropped on my inventory window is taken (shift: one of it); anywhere else the drag is given up
			if (fromTheirs < MAX_CELLS && md.search.theirs[fromTheirs].kind != 0 && L.win.Has(x, y))
				Say("h9inv s take %d %d", fromTheirs, shift ? 1 : md.search.theirs[fromTheirs].n);
			return;
		}

		if (fromCell >= 0)
		{
			const Cell& c = md.cells[fromCell];
			const int target = L.CellAt(x, y, md.slots);
			if (target >= 0 && target != fromCell)
			{
				if (shift && md.cells[target].kind == 0 && c.n > 1)
					Say("h9inv split %d %d %d", fromCell, c.n / 2, target);
				else
					Say("h9inv move %d %d", fromCell, target);
				selected = target;
				return;
			}
			if (L.trade && L.offerMine.Has(x, y))
			{
				const int oc = L.OfferAt(0, x, y, md.trade.cells);
				const int n = shift ? 1 : (c.n - c.reserved > 0 ? c.n - c.reserved : c.n);
				Say("h9inv x offer %d %d %d", fromCell, n, (oc >= 0 && md.trade.mine[oc].kind == 0) ? oc : 255);
				return;
			}
			const bool insideWindow = L.win.Has(x, y) || (L.trade && L.twin.Has(x, y)) || (L.search && L.swin.Has(x, y));
			if (!insideWindow)
			{
				Say("h9inv drop %d %d", fromCell, shift ? 1 : c.n);
				return;
			}
			return;
		}
		if (fromOffer >= 0)
		{
			// an offered cell dragged away from the offer area comes back
			if (!L.offerMine.Has(x, y))
				Say("h9inv x take %d", fromOffer);
		}
	}

	void PopupClick(const Model& md, const InvLayout& L, int x, int y)
	{
		if (popup == POP_CONTEXT)
		{
			for (int i = 0; i < popupCount; i++)
			{
				const IRect r(popupRect.x + 4, popupRect.y + 6 + i * (L.m.ch + 8), popupRect.w - 8, L.m.ch + 8);
				if (r.Has(x, y))
				{
					if (popupTheirs)
						RunTheirs(md, L, popupItems[i], popupCell);
					else
						Run(md, L, popupItems[i], popupCell);
					return;
				}
			}
			return;
		}
		if (popup == POP_PLAYERS)
		{
			const int lines = nearCount ? nearCount : 1;
			for (int i = 0; i < lines; i++)
			{
				const IRect r(popupRect.x + 4, popupRect.y + 6 + i * (L.m.ch + 8), popupRect.w - 8, L.m.ch + 8);
				if (!r.Has(x, y))
					continue;
				if (i < nearCount)
				{
					const int cell = popupCell;
					if (cell >= 0 && md.cells[cell].kind != 0)
					{
						Say("h9inv show %d %d", cell, near[i].index);
					}
				}
				ClosePopup();
				return;
			}
			return;
		}
		if (popup == POP_SPLIT)
		{
			if (SplitMinus().Has(x, y))
			{
				const int v = SplitValue() - 1;
				snprintf(splitText, sizeof(splitText), "%d", v < 1 ? 1 : v);
			}
			else if (SplitPlus().Has(x, y))
			{
				const int v = SplitValue() + 1;
				snprintf(splitText, sizeof(splitText), "%d", v > splitMax ? splitMax : v);
			}
			else if (SplitOk().Has(x, y))
				CommitSplit();
			else if (SplitCancel().Has(x, y))
				ClosePopup();
		}
	}

	void CommitMoney(const Model& md)
	{
		editMoney = false;
		int v = atoi(moneyText);
		if (v < 0)
			v = 0;
		if (v > md.trade.wallet)
			v = md.trade.wallet;
		Say("h9inv x money %d", v);
	}

	void ScrollBy(const Model& md, const InvLayout& L, int rows)
	{
		(void)md;
		int s = scroll + rows;
		int maxFirst = L.totalRows - L.visRows;
		if (maxFirst < 0)
			maxFirst = 0;
		if (s < 0)
			s = 0;
		if (s > maxFirst)
			s = maxFirst;
		scroll = s;
	}

	void ScrollTheirs(const Model& md, const InvLayout& L, int rows)
	{
		(void)md;
		int s = sScroll + rows;
		int maxFirst = L.stotalRows - L.svisRows;
		if (maxFirst < 0)
			maxFirst = 0;
		if (s < 0)
			s = 0;
		if (s > maxFirst)
			s = maxFirst;
		sScroll = s;
	}

	// ---- the keys. Returns true when the key was taken (the game does not see it).
	bool Key(const Model& md, const InvLayout& L, KeyId key, int digit)
	{
		if (key == IK_ESC)
		{
			if (popup != POP_NONE)
			{
				ClosePopup();
				return true;
			}
			if (editMoney)
			{
				editMoney = false;
				return true;
			}
			if (L.search)
			{
				CloseSearch(); // ESC ends the search first, and the inventory window stays
				return true;
			}
			if (md.trade.open)
			{
				Say("h9inv x cancel");
				return true;
			}
			wantClose = true;
			return true;
		}
		if (key == IK_WHEEL_UP || key == IK_WHEEL_DOWN)
		{
			if (L.search && L.stotalRows > L.svisRows && L.swin.Has(mx, my))
			{
				ScrollTheirs(md, L, key == IK_WHEEL_UP ? -1 : 1);
				return true;
			}
			if (L.totalRows > L.visRows && L.win.Has(mx, my))
			{
				ScrollBy(md, L, key == IK_WHEEL_UP ? -1 : 1);
				return true;
			}
			return false;
		}
		if (popup == POP_SPLIT)
		{
			if (key == IK_DIGIT)
			{
				const size_t len = strlen(splitText);
				if (len + 1 < sizeof(splitText) && len < 4)
				{
					splitText[len] = (char)('0' + digit);
					splitText[len + 1] = 0;
				}
				return true;
			}
			if (key == IK_BACK)
			{
				const size_t len = strlen(splitText);
				if (len > 0)
					splitText[len - 1] = 0;
				return true;
			}
			if (key == IK_ENTER)
			{
				CommitSplit();
				return true;
			}
			return false;
		}
		if (editMoney)
		{
			if (key == IK_DIGIT)
			{
				const size_t len = strlen(moneyText);
				if (len + 1 < sizeof(moneyText) && len < 9)
				{
					moneyText[len] = (char)('0' + digit);
					moneyText[len + 1] = 0;
				}
				return true;
			}
			if (key == IK_BACK)
			{
				const size_t len = strlen(moneyText);
				if (len > 0)
					moneyText[len - 1] = 0;
				return true;
			}
			if (key == IK_ENTER)
			{
				CommitMoney(md);
				return true;
			}
			return false;
		}
		return false;
	}
};
} // namespace arpinv
// ---- end H9 ARP inventory layout and clicks ---------------------------------------------------------------------------------
