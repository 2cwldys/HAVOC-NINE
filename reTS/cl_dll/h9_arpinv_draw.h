// ---- H9 ARP inventory and exchange: how it is drawn -------------------------------------------------------------------------------
// Every box and every word of the windows, over a InvCanvas: the engine part gives it FillRGBA and the HUD font (h9_arpinv.cpp), a test gives
// it a list of what was drawn (tests\render_arpinv.cpp, which writes the preview pictures). The panels are the purple of the other H9
// panels: lit 182 145 234, rail 133 98 178, detail 166 154 192.
#pragma once

#include "h9_arpinv_ui.h"

#include <ctype.h>

namespace arpinv
{
struct InvCanvas
{
	virtual ~InvCanvas() {}
	virtual void Fill(int x, int y, int w, int h, int r, int g, int b, int a) = 0;
	virtual void Text(int x, int y, int maxX, const char* s, int r, int g, int b) = 0; // stops before a glyph crosses maxX
	virtual int TextW(const char* s) = 0;
	virtual int CharH() = 0;
	virtual int Width() = 0;
	virtual int Height() = 0;
	virtual int IconFrame(const char* name) { (void)name; return -1; } // the frame of an item's picture, -1 for none
	virtual void Icon(int frame, int x, int y) { (void)frame; (void)x; (void)y; } // an ICON_PX square picture
};

const int ICON_PX = 32; // the side of a picture of sprites/h9_arpicons.spr (modelling/arpicons/make_arpicons.py)

struct Col
{
	int r, g, b;
};
const Col LIT = {182, 145, 234};
const Col RAIL = {133, 98, 178};
const Col DET = {166, 154, 192};
const Col TXT = {235, 230, 245};
const Col OKC = {96, 200, 120};
const Col WARN = {236, 204, 84};
const Col BAD = {236, 96, 96};
const Col DARK = {14, 10, 24};

struct InvPainter
{
	InvCanvas& cv;
	const Model& md;
	const Ui& ui;
	InvLayout L;
	float now;

	InvPainter(InvCanvas& c, const Model& m, const Ui& u, float t) : cv(c), md(m), ui(u), L(BuildLayout(m, c.Width(), c.Height(), c.CharH(), u.scroll, u.sScroll, &u.win)), now(t) {}

	// ---- text
	void Txt(int x, int y, const char* s, const Col& c, int maxX = 0) { cv.Text(x, y, maxX > 0 ? maxX : cv.Width(), s, c.r, c.g, c.b); }
	void TxtBold(int x, int y, const char* s, const Col& c, int maxX = 0)
	{
		Txt(x, y, s, c, maxX);
		Txt(x + 1, y, s, c, maxX > 0 ? maxX + 1 : 0);
	}
	void TxtCentre(const IRect& r, const char* s, const Col& c)
	{
		const int x = r.x + (r.w - cv.TextW(s)) / 2;
		const int y = r.y + (r.h - cv.CharH()) / 2;
		Txt(x < r.x ? r.x : x, y, s, c, r.R());
	}
	void TxtRight(int right, int y, const char* s, const Col& c) { Txt(right - cv.TextW(s), y, s, c, right + 1); }
	// The first of the texts that fits maxW pixels: the last of them when none does.
	const char* FitText(const char* const* options, int n, int maxW)
	{
		for (int i = 0; i < n; i++)
			if (cv.TextW(options[i]) <= maxW)
				return options[i];
		return options[n - 1];
	}

	// Breaks text at spaces into lines no wider than maxW; returns the lines made.
	int Wrap(const char* text, int maxW, char lines[][100], int maxLines)
	{
		int n = 0;
		char cur[100];
		cur[0] = 0;
		const char* p = text;
		while (*p && n < maxLines)
		{
			char word[64];
			int wl = 0;
			while (*p && *p != ' ' && wl < (int)sizeof(word) - 1)
				word[wl++] = *p++;
			word[wl] = 0;
			while (*p == ' ')
				p++;
			char trial[200];
			snprintf(trial, sizeof(trial), "%s%s%s", cur, cur[0] ? " " : "", word);
			if (cur[0] && cv.TextW(trial) > maxW)
			{
				strncpy(lines[n], cur, 99);
				lines[n][99] = 0;
				n++;
				if (n >= maxLines)
					return n;
				strncpy(cur, word, 99);
				cur[99] = 0;
			}
			else
			{
				strncpy(cur, trial, 99);
				cur[99] = 0;
			}
		}
		if (cur[0] && n < maxLines)
		{
			strncpy(lines[n], cur, 99);
			lines[n][99] = 0;
			n++;
		}
		return n;
	}

	// ---- boxes
	void FillBox(const IRect& r, const Col& c, int a)
	{
		if (r.w > 0 && r.h > 0)
			cv.Fill(r.x, r.y, r.w, r.h, c.r, c.g, c.b, a);
	}
	void FrameBox(const IRect& r, const Col& c, int a, int t = 1)
	{
		cv.Fill(r.x, r.y, r.w, t, c.r, c.g, c.b, a);
		cv.Fill(r.x, r.B() - t, r.w, t, c.r, c.g, c.b, a);
		cv.Fill(r.x, r.y, t, r.h, c.r, c.g, c.b, a);
		cv.Fill(r.R() - t, r.y, t, r.h, c.r, c.g, c.b, a);
	}
	// the corner brackets of every H9 panel
	void CornerMarks(const IRect& r, const Col& c)
	{
		const int n = 14, t = 2;
		cv.Fill(r.x, r.y, n, t, c.r, c.g, c.b, 255);
		cv.Fill(r.x, r.y, t, n, c.r, c.g, c.b, 255);
		cv.Fill(r.R() - n, r.y, n, t, c.r, c.g, c.b, 255);
		cv.Fill(r.R() - t, r.y, t, n, c.r, c.g, c.b, 255);
		cv.Fill(r.x, r.B() - t, n, t, c.r, c.g, c.b, 255);
		cv.Fill(r.x, r.B() - n, t, n, c.r, c.g, c.b, 255);
		cv.Fill(r.R() - n, r.B() - t, n, t, c.r, c.g, c.b, 255);
		cv.Fill(r.R() - t, r.B() - n, t, n, c.r, c.g, c.b, 255);
	}
	void PanelBox(const IRect& r)
	{
		const Col dark = {16, 12, 28};
		FillBox(r, dark, 228);
		FrameBox(r, RAIL, 160);
		CornerMarks(r, LIT);
	}
	void PushButton(const IRect& r, const char* label, bool enabled, bool hot)
	{
		const Col dark = {10, 8, 18};
		if (enabled && hot)
			FillBox(r, LIT, 95);
		else if (enabled)
			FillBox(r, RAIL, 45);
		else
			FillBox(r, dark, 200);
		FrameBox(r, enabled ? LIT : RAIL, enabled ? 220 : 90);
		TxtCentre(r, label, enabled ? TXT : DET);
	}

	// ---- items
	// A tile: the item's picture or monogram, its count, its name. reserved is the count a cell's open exchange holds.
	void DrawTile(const IRect& r, int kindId, int n, int reserved, bool selected, bool hot, bool showName)
	{
		FillBox(r, DARK, 235);
		if (kindId == 0)
		{
			FrameBox(r, RAIL, 60);
			return;
		}
		const Col* pal[8] = {&LIT, &OKC, &WARN, &RAIL, &BAD, &DET, &TXT, &LIT};
		const Col hue = *pal[(kindId * 7 + 3) % 8];
		const char* name = md.KindName(kindId);

		const int ch = cv.CharH();
		const int nameH = showName ? ch + 4 : 0;
		const IRect icon(r.x + 5, r.y + 5, r.w - 10, r.h - 10 - nameH);
		const int frame = cv.IconFrame(name);
		if (frame >= 0 && icon.w >= ICON_PX - 4 && icon.h >= ICON_PX - 8)
		{
			cv.Icon(frame, icon.x + (icon.w - ICON_PX) / 2, icon.y + (icon.h - ICON_PX) / 2);
		}
		else
		{
			FillBox(icon, hue, 55);
			FrameBox(icon, hue, 150);
			char mono[3] = {0, 0, 0};
			mono[0] = (char)toupper((unsigned char)name[0]);
			const char* second = strchr(name, ' ');
			mono[1] = (char)(second && second[1] ? toupper((unsigned char)second[1]) : (strlen(name) > 1 ? tolower((unsigned char)name[1]) : 0));
			TxtCentre(icon, mono, TXT);
			TxtCentre(IRect(icon.x + 1, icon.y, icon.w, icon.h), mono, TXT);
		}
		if (showName)
			Txt(r.x + 3, r.B() - ch - 2, name, DET, r.R() - 2);
		if (n > 1)
		{
			char cnt[12];
			snprintf(cnt, sizeof(cnt), "x%d", n);
			const int w = cv.TextW(cnt);
			FillBox(IRect(r.R() - w - 5, r.y + 2, w + 4, ch + 2), DARK, 230);
			Txt(r.R() - w - 3, r.y + 3, cnt, TXT);
		}
		if (reserved > 0)
		{
			FillBox(r, DARK, 140);
			Txt(r.x + 4, r.y + 4, "HELD", WARN, r.R() - 2);
		}
		if (selected)
			FrameBox(r, LIT, 255, 2);
		else if (hot)
			FrameBox(r, LIT, 200);
		else
			FrameBox(r, RAIL, 150);
	}

	// ---- the windows
	void DrawTitle(const IRect& win, const IRect& xBtn, const char* title, const char* right)
	{
		const InvMetrics& m = L.m;
		TxtBold(win.x + m.pad, win.y + 10, title, LIT);
		if (right && right[0])
			TxtRight(xBtn.x - 12, win.y + 11, right, DET);
		cv.Fill(win.x + m.pad, win.y + m.titleH - 4, win.w - m.pad * 2, 1, RAIL.r, RAIL.g, RAIL.b, 200);
		FillBox(xBtn, RAIL, 40);
		FrameBox(xBtn, LIT, 220);
		TxtCentre(xBtn, "X", TXT);
	}

	void DrawInventory()
	{
		const InvMetrics& m = L.m;
		PanelBox(L.win);

		const int used = md.Used();
		const bool full = !md.unlimited && used >= md.slots && md.slots > 0;
		// the use of the cells, beside the title
		char count[32];
		if (full)
			snprintf(count, sizeof(count), "FULL  %d / %d", used, md.slots);
		else if (md.unlimited)
			snprintf(count, sizeof(count), "%d", used);
		else
			snprintf(count, sizeof(count), "%d / %d", used, md.slots);
		// who he is and what he has, as much as fits to the right of that
		char r0[160], r1[160], r2[96], r3[64], wal[32], bank[32];
		FormatMoney(wal, sizeof(wal), md.wallet, md.credits);
		FormatMoney(bank, sizeof(bank), md.bank, md.credits);
		snprintf(r0, sizeof(r0), "%s  |  %s  |  WALLET %s  BANK %s", md.name, md.job, wal, bank);
		snprintf(r1, sizeof(r1), "%s  |  WALLET %s  BANK %s", md.name, wal, bank);
		snprintf(r2, sizeof(r2), "WALLET %s  BANK %s", wal, bank);
		snprintf(r3, sizeof(r3), "WALLET %s", wal);
		const char* ropts[4] = {md.job[0] ? r0 : r1, r1, r2, r3};
		const int titleEnd = L.win.x + m.pad + cv.TextW("INVENTORY") + 14 + cv.TextW(count) + 16;
		DrawTitle(L.win, L.xBtn, "INVENTORY", FitText(ropts, 4, L.xBtn.x - 12 - titleEnd));
		Txt(L.win.x + m.pad + cv.TextW("INVENTORY") + 14, L.win.y + 11, count, full ? WARN : DET);

		// the cells
		const bool dragging = ui.dragging && ui.dragCell >= 0;
		for (int i = L.firstRow * L.cols; i < md.slots && i < (L.firstRow + L.visRows) * L.cols; i++)
		{
			const IRect r = L.CellRect(i);
			const Cell& c = md.cells[i];
			const bool lifted = dragging && ui.dragCell == i;
			DrawTile(r, lifted ? 0 : c.kind, c.n, c.reserved, i == ui.selected, i == ui.hover && !lifted, true);
			if (lifted)
				FrameBox(r, LIT, 120);
		}
		if (L.totalRows > L.visRows)
		{
			PushButton(L.scrollUp, "^", L.firstRow > 0, false);
			PushButton(L.scrollDn, "v", L.firstRow + L.visRows < L.totalRows, false);
		}

		// the selected item
		if (!L.Compact())
		{
			PanelBox(L.info);
			const Cell* sel = (ui.selected >= 0 && ui.selected < MAX_CELLS && md.cells[ui.selected].kind != 0) ? &md.cells[ui.selected] : nullptr;
			const int ix = L.info.x + m.pad, iy = L.info.y + 8;
			Txt(ix, iy, "SELECTED", LIT);
			if (sel)
			{
				const Kind* k = md.FindKind(sel->kind);
				TxtBold(ix, iy + m.ch + 6, md.KindName(sel->kind), TXT, L.info.R() - 8);
				char line[64];
				snprintf(line, sizeof(line), "IN HAND: %d", sel->n);
				Txt(ix, iy + 2 * m.ch + 10, line, DET);
				if (sel->reserved > 0)
					Txt(ix, iy + 3 * m.ch + 12, "HELD BY AN EXCHANGE", WARN, L.info.R() - 8);
				const char* desc = (k && k->haveDesc) ? k->desc : "...";
				char lines[5][100];
				const int nl = Wrap(desc, L.info.w - m.pad * 2, lines, 5);
				for (int i = 0; i < nl; i++)
					Txt(ix, iy + (4 + i) * m.ch + 14, lines[i], TXT, L.info.R() - 6);
			}
			else
			{
				char lines[5][100];
				const int nl = Wrap("CLICK AN ITEM TO SELECT IT. DRAG A TILE TO ANOTHER CELL TO MOVE OR COMBINE IT, OR OUT OF THE WINDOW TO DROP IT.", L.info.w - m.pad * 2, lines, 5);
				for (int i = 0; i < nl; i++)
					Txt(ix, iy + (2 + i) * m.ch + 8, lines[i], DET, L.info.R() - 6);
			}
			const char* labels[ACT_BUTTONS] = {"USE", "DROP ONE", "DROP ALL", "SPLIT ...", "SHOW TO ..."};
			const char* shorter[ACT_BUTTONS] = {"USE", "DROP 1", "DROP ALL", "SPLIT", "SHOW TO"};
			for (int i = 0; i < ACT_BUTTONS; i++)
			{
				bool on = sel != nullptr && sel->reserved < sel->n;
				if (i == 3)
					on = on && sel->n >= 2;
				const char* word = cv.TextW(labels[i]) + 10 <= L.act[i].w ? labels[i] : shorter[i];
				PushButton(L.act[i], word, on, on && L.act[i].Has(ui.mx, ui.my) && ui.popup == POP_NONE);
			}
		}
		else if (ui.selected >= 0 && md.cells[ui.selected].kind != 0 && !(now < md.noteUntil && md.note[0]))
		{
			const Cell& c = md.cells[ui.selected];
			char sel[96];
			snprintf(sel, sizeof(sel), "%s x%d", md.KindName(c.kind), c.n);
			Txt(L.status.x, L.status.y + L.status.h - m.ch - 2, sel, TXT);
		}

		// the status row, the hint and the tidy button
		if (now < md.noteUntil && md.note[0])
			Txt(L.status.x, L.status.y + 2, md.note, md.noteLevel ? WARN : TXT, L.status.R());
		PushButton(L.tidy, "TIDY", true, L.tidy.Has(ui.mx, ui.my) && ui.popup == POP_NONE);
		const char* hints[4] = {"LEFT-CLICK SELECTS   RIGHT-CLICK GIVES ORDERS   DOUBLE-CLICK USES   SHIFT-DRAG SPLITS   ESC CLOSES",
			"CLICK SELECTS   RIGHT-CLICK MENU   DOUBLE-CLICK USES   SHIFT-DRAG SPLITS   ESC CLOSES", "RIGHT-CLICK MENU   DOUBLE-CLICK USES   ESC CLOSES",
			"RIGHT-CLICK MENU   ESC CLOSES"};
		const char* thints[3] = {"DRAG A TILE INTO YOUR OFFER   RIGHT-CLICK FOR MORE   ESC WITHDRAWS", "DRAG TILES INTO YOUR OFFER   ESC WITHDRAWS", "ESC WITHDRAWS"};
		const char* shints[3] = {"DRAG HIS TILES HERE TO TAKE THEM   ESC ENDS THE SEARCH", "DRAG HIS TILES HERE   ESC ENDS THE SEARCH", "ESC ENDS THE SEARCH"};
		const char* hint = L.search ? FitText(shints, 3, L.win.w - 2 * m.pad) : (L.trade ? FitText(thints, 3, L.win.w - 2 * m.pad) : FitText(hints, 4, L.win.w - 2 * m.pad));
		Txt(L.hint.x, L.hint.y + 1, hint, DET, L.win.R() - m.pad);
	}

	// The search window: the cells of the handcuffed player as he sees them, beside the inventory; a tile is taken by a drag onto the inventory,
	// a double click, a right click or the buttons under his grid.
	void DrawSearch()
	{
		const InvMetrics& m = L.m;
		const Search& s = md.search;
		PanelBox(L.swin);

		// the use of his cells beside the title, and his name to the right of that as far as it fits
		const int used = md.SearchUsed();
		char count[40];
		if (s.over)
			snprintf(count, sizeof(count), "OVER CAPACITY  %d", used);
		else if (used == 1)
			snprintf(count, sizeof(count), "1 ITEM");
		else
			snprintf(count, sizeof(count), "%d ITEMS", used);
		const char* ropts[2] = {s.name, ""};
		const int titleEnd = L.swin.x + m.pad + cv.TextW("SEARCHING") + 14 + cv.TextW(count) + 16;
		DrawTitle(L.swin, L.sx, "SEARCHING", FitText(ropts, 2, L.sx.x - 12 - titleEnd));
		Txt(L.swin.x + m.pad + cv.TextW("SEARCHING") + 14, L.swin.y + 11, count, s.over ? WARN : DET);

		// his cells
		const bool dragging = ui.dragging && ui.sDragCell >= 0;
		for (int i = L.sfirstRow * L.scols; i < s.cells && i < (L.sfirstRow + L.svisRows) * L.scols; i++)
		{
			const IRect r = L.SCellRect(i);
			const Cell& c = s.theirs[i];
			const bool lifted = dragging && ui.sDragCell == i;
			DrawTile(r, lifted ? 0 : c.kind, c.n, 0, i == ui.sSelected, i == ui.sHover && !lifted, true);
			if (lifted)
				FrameBox(r, LIT, 120);
		}
		if (used == 0 && s.cells > 0)
		{
			const int w = cv.TextW("NOTHING ON HIM") + 28, h = m.ch + 12;
			const IRect cap(L.sgrid.x + (L.sgrid.w - w) / 2, L.sgrid.y + (L.sgrid.h - h) / 2, w, h);
			FillBox(cap, DARK, 235);
			FrameBox(cap, RAIL, 200);
			TxtCentre(cap, "NOTHING ON HIM", DET);
		}
		if (L.stotalRows > L.svisRows)
		{
			PushButton(L.sscrollUp, "^", L.sfirstRow > 0, false);
			PushButton(L.sscrollDn, "v", L.sfirstRow + L.svisRows < L.stotalRows, false);
		}

		// the buttons act on the tile that is selected
		const Cell* sel = (ui.sSelected >= 0 && ui.sSelected < MAX_CELLS && s.theirs[ui.sSelected].kind != 0) ? &s.theirs[ui.sSelected] : nullptr;
		const bool free = ui.popup == POP_NONE;
		PushButton(L.stakeOne, "TAKE ONE", sel != nullptr, sel != nullptr && free && L.stakeOne.Has(ui.mx, ui.my));
		PushButton(L.stakeAll, "TAKE ALL", sel != nullptr, sel != nullptr && free && L.stakeAll.Has(ui.mx, ui.my));
		PushButton(L.sclose, "CLOSE", true, free && L.sclose.Has(ui.mx, ui.my));

		// his money: what his wallet holds, and the buttons that take some of it
		if (L.smoneyOn)
		{
			char amount[32], line[64];
			FormatMoney(amount, sizeof(amount), s.money, md.credits);
			snprintf(line, sizeof(line), "HIS %s  %s", md.credits ? "CREDITS" : "CASH", amount);
			const Col dark = {10, 8, 18};
			FillBox(L.smoney, dark, 210);
			FrameBox(L.smoney, RAIL, 160);
			Txt(L.smoney.x + 6, L.smoney.y + 4, line, s.money > 0 ? TXT : DET, L.smoney.R() - 4);
			const bool have = s.money > 0;
			const char* full[3] = {"TAKE 10", "TAKE 100", "TAKE ALL"};
			const char* brief[3] = {"10", "100", "ALL"};
			for (int i = 0; i < 3; i++)
			{
				const char* opts[2] = {full[i], brief[i]};
				PushButton(L.smoneyBtn[i], FitText(opts, 2, L.smoneyBtn[i].w - 8), have, have && free && L.smoneyBtn[i].Has(ui.mx, ui.my));
			}
		}

		// the status row: the last word of the server, else the selected tile
		if (now < md.noteUntil && md.note[0])
		{
			Txt(L.sstatus.x, L.sstatus.y + 2, md.note, md.noteLevel ? WARN : TXT, L.sstatus.R());
		}
		else if (sel)
		{
			char line[96];
			snprintf(line, sizeof(line), "%s x%d", md.KindName(sel->kind), sel->n);
			Txt(L.sstatus.x, L.sstatus.y + 2, line, TXT, L.sstatus.R());
		}
		const char* hints[3] = {"DRAG A TILE TO YOUR INVENTORY   SHIFT-DRAG TAKES ONE   DOUBLE-CLICK TAKES ALL   ESC ENDS THE SEARCH",
			"DRAG A TILE TO YOUR INVENTORY   DOUBLE-CLICK TAKES ALL   ESC ENDS IT", "DOUBLE-CLICK TAKES ALL   ESC ENDS IT"};
		Txt(L.shint.x, L.shint.y + 1, FitText(hints, 3, L.swin.w - 2 * m.pad), DET, L.swin.R() - m.pad);
	}

	void DrawTrade()
	{
		const InvMetrics& m = L.m;
		const Trade& t = md.trade;
		PanelBox(L.twin);
		char who[96], with[64];
		snprintf(who, sizeof(who), "%s <-> %s", md.name, t.partner);
		snprintf(with, sizeof(with), "WITH %s", t.partner);
		const char* wopts[3] = {who, with, ""};
		DrawTitle(L.twin, L.tx, "EXCHANGE OF GOODS", FitText(wopts, 3, L.tx.x - 12 - (L.twin.x + m.pad + cv.TextW("EXCHANGE OF GOODS") + 16)));

		Txt(L.offerMine.x, L.offerMine.y - m.ch - 4, "YOUR OFFER", DET);
		Txt(L.offerTheirs.x, L.offerTheirs.y - m.ch - 4, "THEIR OFFER", DET);
		TxtCentre(IRect(L.offerMine.R(), L.offerMine.y + L.offerMine.h / 2 - m.ch, L.offerTheirs.x - L.offerMine.R(), m.ch * 2), "< >", LIT);
		for (int side = 0; side < 2; side++)
		{
			for (int i = 0; i < t.cells && i < OFFER_CELLS; i++)
			{
				const Offer& o = side == 0 ? t.mine[i] : t.theirs[i];
				const IRect r = L.OfferRect(side, i);
				const bool hot = side == 0 && i == L.OfferAt(0, ui.mx, ui.my, t.cells);
				DrawTile(r, o.kind, o.n, 0, false, hot, false);
			}
		}

		// the money
		const char* what = t.credits ? "CREDITS" : "CASH";
		char buf[48], amount[32];
		const Col dark = {10, 8, 18};
		FillBox(L.myMoney, dark, 210);
		FrameBox(L.myMoney, ui.editMoney ? LIT : RAIL, 200);
		if (ui.editMoney)
			snprintf(buf, sizeof(buf), "%s  %s_", what, ui.moneyText);
		else
		{
			FormatMoney(amount, sizeof(amount), t.myMoney, t.credits);
			snprintf(buf, sizeof(buf), "%s  %s", what, amount);
		}
		Txt(L.myMoney.x + 6, L.myMoney.y + 5, buf, TXT, L.myMoney.R() - 4);
		FillBox(L.theirMoney, dark, 210);
		FrameBox(L.theirMoney, RAIL, 120);
		FormatMoney(amount, sizeof(amount), t.theirMoney, t.credits);
		snprintf(buf, sizeof(buf), "%s  %s", what, amount);
		Txt(L.theirMoney.x + 6, L.theirMoney.y + 5, buf, TXT, L.theirMoney.R() - 4);
		const char* qlab[4] = {"+10", "+100", "ALL", "0"};
		for (int i = 0; i < 4; i++)
			PushButton(L.quick[i], qlab[i], true, L.quick[i].Has(ui.mx, ui.my) && ui.popup == POP_NONE);

		// the seals
		char seal[64];
		snprintf(seal, sizeof(seal), "YOU: %s", t.mySealed ? "SEALED" : "NOT SEALED");
		FillBox(L.mySeal, t.mySealed ? OKC : dark, t.mySealed ? 40 : 200);
		FrameBox(L.mySeal, t.mySealed ? OKC : RAIL, 200);
		TxtCentre(L.mySeal, seal, t.mySealed ? OKC : DET);
		snprintf(seal, sizeof(seal), "%s: %s", t.partner, t.theirSealed ? "SEALED" : "NOT SEALED");
		FillBox(L.theirSeal, t.theirSealed ? OKC : dark, t.theirSealed ? 40 : 200);
		FrameBox(L.theirSeal, t.theirSealed ? OKC : RAIL, 200);
		TxtCentre(L.theirSeal, seal, t.theirSealed ? OKC : DET);

		const float wait = t.lockUntil - now;
		const bool canSeal = !t.mySealed && wait <= 0.0f;
		char sealLabel[48];
		if (t.mySealed)
			snprintf(sealLabel, sizeof(sealLabel), "SEALED - CLICK TO UNSEAL");
		else if (wait > 0.0f)
			snprintf(sealLabel, sizeof(sealLabel), "SEAL EXCHANGE (%.1f)", wait);
		else
			snprintf(sealLabel, sizeof(sealLabel), "SEAL EXCHANGE");
		PushButton(L.sealBtn, sealLabel, canSeal || t.mySealed, (canSeal || t.mySealed) && L.sealBtn.Has(ui.mx, ui.my) && ui.popup == POP_NONE);
		PushButton(L.withdrawBtn, "WITHDRAW", true, L.withdrawBtn.Has(ui.mx, ui.my) && ui.popup == POP_NONE);
		const char* notes[3] = {"ANY CHANGE BREAKS BOTH SEALS; THE SEAL WAITS 3 S AFTER A CHANGE", "A CHANGE BREAKS BOTH SEALS (3 S WAIT)", "A CHANGE BREAKS THE SEALS"};
		Txt(L.tstatus.x, L.tstatus.y, FitText(notes, 3, L.twin.w - 2 * m.pad), DET, L.twin.R() - m.pad);
	}

	void DrawPopup()
	{
		if (ui.popup == POP_NONE)
			return;
		const InvMetrics& m = L.m;
		PanelBox(ui.popupRect);
		if (ui.popup == POP_CONTEXT)
		{
			for (int i = 0; i < ui.popupCount; i++)
			{
				const IRect r(ui.popupRect.x + 4, ui.popupRect.y + 6 + i * (m.ch + 8), ui.popupRect.w - 8, m.ch + 8);
				if (i == ui.popupHover)
					FillBox(r, LIT, 90);
				Txt(r.x + 12, r.y + 4, ItemText(ui.popupItems[i]), TXT, r.R() - 4);
			}
		}
		else if (ui.popup == POP_PLAYERS)
		{
			if (ui.nearCount == 0)
				Txt(ui.popupRect.x + 14, ui.popupRect.y + 10, "NO PLAYER NEAR", DET, ui.popupRect.R() - 4);
			for (int i = 0; i < ui.nearCount; i++)
			{
				const IRect r(ui.popupRect.x + 4, ui.popupRect.y + 6 + i * (m.ch + 8), ui.popupRect.w - 8, m.ch + 8);
				if (i == ui.popupHover)
					FillBox(r, LIT, 90);
				Txt(r.x + 12, r.y + 4, ui.near[i].name, TXT, r.R() - 4);
			}
			Txt(ui.popupRect.x + 14, ui.popupRect.B() - m.ch - 6, "SHOW TO:", LIT);
		}
		else if (ui.popup == POP_SPLIT)
		{
			char head[64];
			const int kind = ui.popupTheirs ? md.search.theirs[ui.popupCell].kind : md.cells[ui.popupCell].kind;
			snprintf(head, sizeof(head), "%s %s", ui.popupTheirs ? "TAKE" : "SPLIT", md.KindName(kind));
			TxtBold(ui.popupRect.x + 12, ui.popupRect.y + 10, head, LIT, ui.popupRect.R() - 6);
			PushButton(ui.SplitMinus(), "-", true, false);
			PushButton(ui.SplitPlus(), "+", true, false);
			const Col dark = {10, 8, 18};
			FillBox(ui.SplitField(), dark, 220);
			FrameBox(ui.SplitField(), LIT, 200);
			char v[24];
			snprintf(v, sizeof(v), "%s_", ui.splitText);
			TxtCentre(ui.SplitField(), v, TXT);
			PushButton(ui.SplitOk(), "OK", true, false);
			PushButton(ui.SplitCancel(), "CANCEL", true, false);
		}
	}

	void DrawDrag()
	{
		if (!ui.dragging)
			return;
		const InvMetrics& m = L.m;
		if (ui.sDragCell >= 0 && ui.sDragCell < MAX_CELLS)
		{
			// a tile of his: my inventory window takes it
			const Cell& c = md.search.theirs[ui.sDragCell];
			if (c.kind != 0)
				DrawTile(IRect(ui.mx - m.tile / 2, ui.my - m.tile / 2, m.tile, m.tile), c.kind, c.n, 0, true, false, true);
			if (L.win.Has(ui.mx, ui.my))
			{
				FrameBox(L.win, OKC, 255, 2);
				Txt(ui.mx + m.tile / 2 + 8, ui.my - m.ch / 2, ui.shift ? "TAKE ONE" : "TAKE", OKC);
			}
			return;
		}
		// where it would land: a cell, the offer, the world
		if (ui.dragCell >= 0)
		{
			const int target = L.CellAt(ui.mx, ui.my, md.slots);
			if (target >= 0 && target != ui.dragCell)
				FrameBox(L.CellRect(target), OKC, 255, 2);
			else if (L.trade && L.offerMine.Has(ui.mx, ui.my))
				FrameBox(L.offerMine, OKC, 255, 2);
			else if (!L.win.Has(ui.mx, ui.my) && !(L.trade && L.twin.Has(ui.mx, ui.my)) && !(L.search && L.swin.Has(ui.mx, ui.my)))
				Txt(ui.mx + 14, ui.my + 14, ui.shift ? "DROP ONE" : "DROP", BAD);
		}
		const Cell* c = ui.dragCell >= 0 ? &md.cells[ui.dragCell] : nullptr;
		int kind = c ? c->kind : 0, n = c ? c->n : 0;
		if (ui.dragOffer >= 0)
		{
			kind = md.trade.mine[ui.dragOffer].kind;
			n = md.trade.mine[ui.dragOffer].n;
		}
		if (kind != 0)
			DrawTile(IRect(ui.mx - m.tile / 2, ui.my - m.tile / 2, m.tile, m.tile), kind, n, 0, true, false, true);
	}

	void DrawInvite()
	{
		const Trade& t = md.trade;
		if (!t.invite || t.open || now > t.inviteUntil)
			return;
		const InvMetrics& m = L.m;
		PanelBox(L.invite);
		char head[96];
		snprintf(head, sizeof(head), "%s OFFERS YOU AN EXCHANGE", t.inviter);
		for (char* p = head; *p; p++)
			*p = (char)toupper((unsigned char)*p);
		TxtCentre(IRect(L.invite.x, L.invite.y + 6, L.invite.w, m.ch + 8), head, LIT);
		char sub[96];
		snprintf(sub, sizeof(sub), md.open ? "CLICK ACCEPT, OR PRESS E AT HIM. THE OFFER LAPSES IN %d S" : "PRESS E AT HIM TO ACCEPT. THE OFFER LAPSES IN %d S", (int)(t.inviteUntil - now) + 1);
		TxtCentre(IRect(L.invite.x, L.invite.y + 8 + m.ch + 6, L.invite.w, m.ch + 6), sub, DET);
		PushButton(L.accept, "ACCEPT", md.open, md.open && L.accept.Has(ui.mx, ui.my));
		PushButton(L.decline, "DECLINE", md.open, md.open && L.decline.Has(ui.mx, ui.my));
	}

	void DrawResult()
	{
		const Trade& t = md.trade;
		if (!t.result || now > t.resultUntil)
			return;
		const InvMetrics& m = L.m;
		const Col& c = t.reason == TC_DONE ? OKC : BAD;
		char lines[3][100];
		int nl = 0;
		if (t.summary[0])
		{
			char buf[SUMMARY_LEN];
			strncpy(buf, t.summary, sizeof(buf) - 1);
			buf[sizeof(buf) - 1] = 0;
			char* p = buf;
			while (p && *p && nl < 3)
			{
				char* bar = strchr(p, '|');
				if (bar)
					*bar = 0;
				strncpy(lines[nl], p, 99);
				lines[nl][99] = 0;
				nl++;
				p = bar ? bar + 1 : nullptr;
			}
		}
		const int w = 520, h = m.titleH + 12 + nl * (m.ch + 6) + 16;
		const IRect r((cv.Width() - w) / 2, (cv.Height() - h) / 2 - 20, w, h);
		const Col dark = {8, 8, 16};
		FillBox(r, dark, 235);
		FrameBox(r, c, 255, 2);
		TxtCentre(IRect(r.x, r.y + 8, r.w, m.ch + 8), CloseReasonText(t.reason), c);
		for (int i = 0; i < nl; i++)
			TxtCentre(IRect(r.x, r.y + m.titleH + 4 + i * (m.ch + 6), r.w, m.ch + 6), lines[i], TXT);
	}

	// Everything of this frame, in the order it stacks.
	void DrawAll()
	{
		DrawInvite();
		if (md.open)
		{
			DrawInventory();
			if (L.trade)
				DrawTrade();
			else if (L.search)
				DrawSearch();
			DrawPopup();
			DrawDrag();
		}
		DrawResult(); // over everything: the word on an exchange that has just ended
	}
};
} // namespace arpinv
// ---- end H9 ARP inventory drawing -------------------------------------------------------------------------------------------------
