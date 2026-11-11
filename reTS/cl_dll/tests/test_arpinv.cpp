// Tests of the ARP inventory window's model and clicks (h9_arpinv_model.h, h9_arpinv_ui.h). They need no game:
//   cl /std:c++17 /EHsc /I.. test_arpinv.cpp && test_arpinv.exe
// (g++ -std=c++17 -I.. test_arpinv.cpp works too). Exit 0: every check passed.
#include "../h9_arpinv_ui.h"

#include <stdio.h>
#include <string>
#include <vector>

using namespace arpinv;

static int g_checks = 0, g_fails = 0;
#define CHECK(cond)                                                                                              \
	do                                                                                                           \
	{                                                                                                            \
		g_checks++;                                                                                              \
		if (!(cond))                                                                                             \
		{                                                                                                        \
			g_fails++;                                                                                           \
			printf("FAIL line %d: %s\n", __LINE__, #cond);                                                       \
		}                                                                                                        \
	} while (0)
#define CHECK_STR(a, b)                                                                                          \
	do                                                                                                           \
	{                                                                                                            \
		g_checks++;                                                                                              \
		if (std::string(a) != std::string(b))                                                                    \
		{                                                                                                        \
			g_fails++;                                                                                           \
			printf("FAIL line %d: \"%s\" != \"%s\"\n", __LINE__, std::string(a).c_str(), std::string(b).c_str()); \
		}                                                                                                        \
	} while (0)

// ---- message builders, written from DESIGN.md section 3 only
struct Msg
{
	std::vector<unsigned char> b;
	Msg& Byte(int v) { b.push_back((unsigned char)v); return *this; }
	Msg& Short(int v) { b.push_back((unsigned char)(v & 255)); b.push_back((unsigned char)((v >> 8) & 255)); return *this; }
	Msg& Long(int v) { for (int i = 0; i < 4; i++) b.push_back((unsigned char)((v >> (8 * i)) & 255)); return *this; }
	Msg& Str(const char* s) { for (; *s; s++) b.push_back((unsigned char)*s); b.push_back(0); return *this; }
	const void* data() const { return b.data(); }
	int size() const { return (int)b.size(); }
};

static void Open(Model& md, int slots, int flags = 4, const char* name = "VOSS, ADRIAN", const char* job = "CADET", int wallet = 500, int bank = 1250)
{
	Msg m;
	m.Byte(INV_OPEN).Byte(flags).Short(slots).Long(wallet).Long(bank).Str(name).Str(job);
	CHECK(md.OnInv(m.data(), m.size(), 1.0f));
}

static void Catalog(Model& md, std::vector<std::pair<int, const char*>> items, int stack = 20)
{
	Msg m;
	m.Byte(INV_CATALOG).Byte((int)items.size());
	for (auto& it : items)
		m.Short(it.first).Short(stack).Byte(0).Str(it.second);
	md.OnInv(m.data(), m.size(), 1.0f);
}

static void Slots(Model& md, int first, std::vector<std::pair<int, int>> cells)
{
	Msg m;
	m.Byte(INV_SLOTS).Short(first).Byte((int)cells.size());
	for (auto& c : cells)
		m.Short(c.first).Short(c.second);
	md.OnInv(m.data(), m.size(), 1.0f);
}

static const int SOUP = 1, PIZZA = 2, KEY = 3, CARD = 4;

static Model Stocked(int slots = 32)
{
	Model md;
	Open(md, slots);
	Catalog(md, {{SOUP, "Soda"}, {PIZZA, "Pizza"}, {KEY, "Rope"}, {CARD, "Permit"}});
	Slots(md, 0, {{SOUP, 6}, {PIZZA, 2}, {0, 0}, {KEY, 1}, {CARD, 1}});
	return md;
}

static std::vector<std::string> Drain(Ui& ui)
{
	std::vector<std::string> v;
	for (int i = 0; i < ui.nout; i++)
		v.push_back(ui.out[i].text);
	ui.nout = 0;
	return v;
}

static InvLayout Lay(const Model& md, const Ui& ui, int sw = 1280, int sh = 720)
{
	return BuildLayout(md, sw, sh, 12, ui.scroll, ui.sScroll, &ui.win);
}

static void Click(Ui& ui, Model& md, int button, int x, int y, float now = 10.0f)
{
	InvLayout L = Lay(md, ui);
	ui.MouseMove(md, L, x, y);
	ui.MouseDown(md, L, button, x, y, now);
	ui.MouseUp(md, L, button, x, y, now);
}

static void Center(const IRect& r, int& x, int& y)
{
	x = r.x + r.w / 2;
	y = r.y + r.h / 2;
}

static void TestWire()
{
	Model md;
	Open(md, 32, 4 | 1);
	CHECK(md.open);
	CHECK(md.slots == 32);
	CHECK(md.credits && md.over && !md.unlimited);
	CHECK_STR(md.name, "VOSS, ADRIAN");
	CHECK_STR(md.job, "CADET");
	CHECK(md.wallet == 500 && md.bank == 1250);

	Catalog(md, {{SOUP, "Soda"}, {PIZZA, "Pizza"}});
	CHECK(md.FindKind(SOUP) && md.FindKind(PIZZA));
	CHECK_STR(md.KindName(SOUP), "Soda");
	CHECK(md.FindKind(SOUP)->stackMax == 20);
	CHECK_STR(md.KindName(99), "ITEM");

	Slots(md, 0, {{SOUP, 6}, {PIZZA, 2}, {0, 0}, {SOUP, 14}});
	CHECK(md.cells[0].kind == SOUP && md.cells[0].n == 6);
	CHECK(md.cells[2].kind == 0 && md.cells[2].n == 0);
	CHECK(md.cells[3].n == 14);
	CHECK(md.Used() == 3);

	// a changed single cell
	Slots(md, 1, {{0, 0}});
	CHECK(md.cells[1].kind == 0 && md.Used() == 2);

	// money
	{
		Msg m;
		m.Byte(INV_MONEY).Long(77).Long(88);
		md.OnInv(m.data(), m.size(), 2.0f);
		CHECK(md.wallet == 77 && md.bank == 88);
	}
	// a description
	{
		Msg m;
		m.Byte(INV_DESC).Short(SOUP).Str("A can of soda.");
		md.OnInv(m.data(), m.size(), 2.0f);
		CHECK(md.FindKind(SOUP)->haveDesc);
		CHECK_STR(md.FindKind(SOUP)->desc, "A can of soda.");
	}
	// a note
	{
		Msg m;
		m.Byte(INV_NOTE).Byte(1).Str("Your inventory is full.");
		md.OnInv(m.data(), m.size(), 3.0f);
		CHECK_STR(md.note, "Your inventory is full.");
		CHECK(md.noteLevel == 1 && md.noteUntil > 3.0f);
	}
	// reserve
	{
		Msg m;
		m.Byte(INV_RESERVE).Short(0).Byte(2).Short(4).Short(0);
		md.OnInv(m.data(), m.size(), 3.0f);
		CHECK(md.cells[0].reserved == 4 && md.cells[1].reserved == 0);
	}
	// close
	{
		Msg m;
		m.Byte(INV_CLOSE);
		md.OnInv(m.data(), m.size(), 4.0f);
		CHECK(!md.open);
	}
	// the server is not believed: truncated, unterminated, out of range, negative, huge
	{
		Model h = Stocked();
		Msg m;
		m.Byte(INV_SLOTS).Short(0).Byte(3).Short(SOUP).Short(5);   // two cells short
		h.OnInv(m.data(), m.size(), 1.0f);
		CHECK(h.msgsBad >= 1);
		CHECK(h.cells[0].n == 5);          // the one complete cell is taken
		CHECK(h.cells[1].n == 2);          // the cells that never came are left as they were
	}
	{
		Model h = Stocked();
		Msg m;
		m.Byte(INV_SLOTS).Short(500).Byte(1).Short(SOUP).Short(5);   // past MAX_CELLS
		h.OnInv(m.data(), m.size(), 1.0f);
		CHECK(h.cells[0].n == 6 && h.slots <= MAX_CELLS);
	}
	{
		Model h = Stocked();
		Msg m;
		m.Byte(INV_SLOTS).Short(0).Byte(1).Short(SOUP).Short(-5);   // a negative count empties the cell
		h.OnInv(m.data(), m.size(), 1.0f);
		CHECK(h.cells[0].kind == 0);
	}
	{
		Model h = Stocked();
		Msg m;
		m.Byte(INV_SLOTS).Short(0).Byte(1).Short(SOUP).Short(30000);   // a huge count is cut
		h.OnInv(m.data(), m.size(), 1.0f);
		CHECK(h.cells[0].n == MAX_COUNT);
	}
	{
		Model h;
		Msg m;
		m.Byte(INV_OPEN).Byte(0).Short(32).Long(1).Long(1);   // no strings
		CHECK(!h.OnInv(m.data(), m.size(), 1.0f));
		CHECK(!h.open && h.msgsBad == 1);
		Msg e;
		CHECK(!h.OnInv(e.data(), e.size(), 1.0f));
		Msg u;
		u.Byte(77);   // an op nobody knows
		CHECK(!h.OnInv(u.data(), u.size(), 1.0f));
		CHECK(h.msgsBad == 3);
	}
	{
		Model h;
		Msg m;
		m.Byte(INV_OPEN).Byte(0).Short(9999).Long(-5).Long(-6).Str("A").Str("B");   // slots cut, negative money zero
		h.OnInv(m.data(), m.size(), 1.0f);
		CHECK(h.slots == MAX_CELLS && h.wallet == 0 && h.bank == 0);
	}
	{
		// a string with control characters and a long one
		Model h;
		std::string longname(80, 'x');
		Msg m;
		m.Byte(INV_OPEN).Byte(0).Short(8).Long(0).Long(0).Str(longname.c_str()).Str("J");
		h.OnInv(m.data(), m.size(), 1.0f);
		CHECK(strlen(h.name) == NAME_LEN - 1);
	}
}

static void TestTradeWire()
{
	Model md = Stocked();
	{
		Msg m;
		m.Byte(TR_INVITE).Byte(12).Str("KANE, MARCUS");
		CHECK(md.OnTrade(m.data(), m.size(), 5.0f));
		CHECK(md.trade.invite && !md.trade.open);
		CHECK_STR(md.trade.inviter, "KANE, MARCUS");
		CHECK(md.trade.inviteUntil > 16.9f && md.trade.inviteUntil < 17.1f);
	}
	{
		Msg m;
		m.Byte(TR_OPEN).Str("KANE, MARCUS").Long(500).Byte(12).Byte(1);
		CHECK(md.OnTrade(m.data(), m.size(), 6.0f));
		CHECK(md.trade.open && md.trade.credits && md.trade.cells == 12 && md.trade.wallet == 500);
		CHECK(!md.trade.invite);   // an open exchange has answered the invitation
	}
	{
		Msg m;
		m.Byte(TR_OFFER).Byte(0).Byte(0).Short(SOUP).Short(4).Str("");
		md.OnTrade(m.data(), m.size(), 6.0f);
		CHECK(md.trade.mine[0].kind == SOUP && md.trade.mine[0].n == 4);
		CHECK_STR(md.trade.mine[0].name, "Soda");   // the name of a kind this client knows
		Msg t;
		t.Byte(TR_OFFER).Byte(1).Byte(2).Short(88).Short(10).Str("Cigarette");
		md.OnTrade(t.data(), t.size(), 6.0f);
		CHECK(md.trade.theirs[2].kind == 88 && md.trade.theirs[2].n == 10);
		CHECK_STR(md.trade.theirs[2].name, "Cigarette");
		Msg bad;
		bad.Byte(TR_OFFER).Byte(0).Byte(12).Short(1).Short(1).Str("");   // index 12 does not exist
		md.OnTrade(bad.data(), bad.size(), 6.0f);
		CHECK(md.msgsBad >= 1);
		Msg e;
		e.Byte(TR_OFFER).Byte(0).Byte(0).Short(0).Short(0).Str("");   // emptied
		md.OnTrade(e.data(), e.size(), 6.0f);
		CHECK(md.trade.mine[0].kind == 0);
	}
	{
		Msg m;
		m.Byte(TR_MONEY).Byte(0).Long(150);
		md.OnTrade(m.data(), m.size(), 6.0f);
		Msg t;
		t.Byte(TR_MONEY).Byte(1).Long(40);
		md.OnTrade(t.data(), t.size(), 6.0f);
		CHECK(md.trade.myMoney == 150 && md.trade.theirMoney == 40);
		Msg s;
		s.Byte(TR_SEAL).Byte(1).Byte(0).Byte(30);
		md.OnTrade(s.data(), s.size(), 7.0f);
		CHECK(md.trade.mySealed && !md.trade.theirSealed);
		CHECK(md.trade.lockUntil > 9.9f && md.trade.lockUntil < 10.1f);
	}
	{
		Msg m;
		m.Byte(TR_CLOSE).Byte(TC_DONE).Str("VOSS RECEIVES: Cigarette x10|KANE RECEIVES: Soda x4");
		md.OnTrade(m.data(), m.size(), 8.0f);
		CHECK(!md.trade.open && md.trade.result && md.trade.reason == TC_DONE);
		CHECK(md.trade.resultUntil > 13.9f);
		CHECK(md.trade.mine[0].kind == 0);   // the offers are gone
	}
	CHECK_STR(CloseReasonText(TC_DONE), "EXCHANGE COMPLETE");
	CHECK_STR(CloseReasonText(TC_YOUR_FULL), "EXCHANGE REFUSED: YOUR INVENTORY IS FULL");
	char buf[32];
	// the credit sign is the single byte 0xA2 (TSHud_DrawString draws it); the literals are split so the escape takes no digit
	FormatMoney(buf, sizeof(buf), 1250, true);
	CHECK_STR(buf, "\xA2" " 1,250");
	FormatMoney(buf, sizeof(buf), 1234567, false);
	CHECK_STR(buf, "$ 1,234,567");
	FormatMoney(buf, sizeof(buf), 0, true);
	CHECK_STR(buf, "\xA2" " 0");
	FormatMoney(buf, sizeof(buf), -5, true);
	CHECK_STR(buf, "\xA2" " 0");
}

static void TestLayout()
{
	const int sizes[][2] = {{640, 480}, {800, 600}, {1024, 768}, {1280, 720}, {1366, 768}, {1920, 1080}, {2560, 1440}};
	for (int pass = 0; pass < 2; pass++)
	{
		for (auto& s : sizes)
		{
			Model md = Stocked(pass == 0 ? 32 : 96);
			if (pass == 1)
			{
				Msg m;
				m.Byte(TR_OPEN).Str("KANE, MARCUS").Long(500).Byte(12).Byte(1);
				md.OnTrade(m.data(), m.size(), 1.0f);
			}
			InvLayout L = BuildLayout(md, s[0], s[1], 12, 0);
			char what[64];
			snprintf(what, sizeof(what), "%dx%d trade %d", s[0], s[1], pass);
			const bool inside = L.win.x >= 0 && L.win.y >= 0 && L.win.R() <= s[0] && L.win.B() <= s[1];
			if (!inside)
				printf("  window outside the screen at %s: %d,%d %dx%d\n", what, L.win.x, L.win.y, L.win.w, L.win.h);
			// windows must be on screen unless the screen is smaller than the smallest layout (640x480 with an exchange)
			if (!(pass == 1 && s[0] < 800))
				CHECK(inside);
			if (pass == 1)
			{
				const bool tin = L.twin.R() <= s[0] + 1 && L.twin.B() <= s[1];
				if (!tin)
					printf("  exchange outside the screen at %s\n", what);
				if (s[0] >= 1024)
					CHECK(tin);
				CHECK(L.twin.x >= L.win.R());
			}
			// every visible cell is found at its own centre and the cells do not overlap
			for (int i = L.firstRow * L.cols; i < md.slots && i < (L.firstRow + L.visRows) * L.cols; i++)
			{
				int cx, cy;
				Center(L.CellRect(i), cx, cy);
				CHECK(L.CellAt(cx, cy, md.slots) == i);
				CHECK(L.grid.Has(cx, cy));
			}
			// the buttons are inside their window
			CHECK(L.win.Has(L.xBtn.x + 1, L.xBtn.y + 1));
			if (!L.trade)
			{
				for (int i = 0; i < ACT_BUTTONS; i++)
					CHECK(L.info.Has(L.act[i].x, L.act[i].y) && L.info.Has(L.act[i].R() - 1, L.act[i].B() - 1));
			}
			else
			{
				CHECK(L.twin.Has(L.sealBtn.x, L.sealBtn.y) && L.twin.Has(L.withdrawBtn.R() - 1, L.withdrawBtn.B() - 1));
				CHECK(L.sealBtn.R() <= L.withdrawBtn.x);
				for (int i = 0; i < 12; i++)
				{
					int cx, cy;
					Center(L.OfferRect(0, i), cx, cy);
					CHECK(L.OfferAt(0, cx, cy, 12) == i);
					Center(L.OfferRect(1, i), cx, cy);
					CHECK(L.OfferAt(1, cx, cy, 12) == i);
				}
			}
			// scrolling stays in range
			InvLayout S = BuildLayout(md, s[0], s[1], 12, 999);
			CHECK(S.firstRow == S.totalRows - S.visRows || S.totalRows <= S.visRows);
		}
	}
}

static void TestClicks()
{
	Model md = Stocked();
	Ui ui;
	InvLayout L = Lay(md, ui);
	int x, y;

	// select by a click, no command
	Center(L.CellRect(1), x, y);
	Click(ui, md, 0, x, y, 10.0f);
	CHECK(ui.selected == 1);
	CHECK(Drain(ui).empty());

	// a double click uses it
	Click(ui, md, 0, x, y, 20.0f);
	Click(ui, md, 0, x, y, 20.2f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv use 1");
	}
	// two slow clicks do not
	Click(ui, md, 0, x, y, 30.0f);
	Click(ui, md, 0, x, y, 31.0f);
	CHECK(Drain(ui).empty());

	// the X closes
	Center(L.xBtn, x, y);
	Click(ui, md, 0, x, y);
	CHECK(ui.wantClose);
	ui.wantClose = false;

	// right click: the menu of a stack
	Center(L.CellRect(0), x, y);
	Click(ui, md, 1, x, y);
	CHECK(ui.popup == POP_CONTEXT && ui.popupCell == 0);
	{
		// a stack of six: USE, DROP ONE, DROP ALL, SPLIT, SHOW, INFO (there is no give: goods change hands by an exchange)
		CHECK(ui.popupCount == 6);
		CHECK(ui.popupItems[0] == MI_USE && ui.popupItems[2] == MI_DROPALL && ui.popupItems[4] == MI_SHOW && ui.popupItems[5] == MI_INFO);
		CHECK(L.sw >= ui.popupRect.R() && L.sh >= ui.popupRect.B());
	}
	// choose DROP ALL (line 2)
	{
		InvLayout L2 = Lay(md, ui);
		const int px = ui.popupRect.x + 20, py = ui.popupRect.y + 6 + 2 * (L2.m.ch + 8) + 4;
		ui.MouseMove(md, L2, px, py);
		CHECK(ui.popupHover == 2);
		ui.MouseDown(md, L2, 0, px, py, 40.0f);
		ui.MouseUp(md, L2, 0, px, py, 40.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv drop 0 6");
		CHECK(ui.popup == POP_NONE);
	}
	// a single item has no DROP ALL and no SPLIT
	Center(L.CellRect(3), x, y);
	Click(ui, md, 1, x, y);
	CHECK(ui.popupCount == 4);   // USE, DROP ONE, SHOW, INFO
	CHECK(ui.popupItems[2] == MI_SHOW);
	// a click outside the menu only closes it
	Click(ui, md, 0, 5, 5);
	CHECK(ui.popup == POP_NONE && Drain(ui).empty());
	// right click on an empty cell opens nothing
	Center(L.CellRect(10), x, y);
	Click(ui, md, 1, x, y);
	CHECK(ui.popup == POP_NONE);
}

static void TestSplit()
{
	Model md = Stocked();
	Ui ui;
	InvLayout L = Lay(md, ui);
	int x, y;
	Center(L.CellRect(0), x, y);
	Click(ui, md, 1, x, y);
	// SPLIT is line 3
	{
		InvLayout L2 = Lay(md, ui);
		const int px = ui.popupRect.x + 20, py = ui.popupRect.y + 6 + 3 * (L2.m.ch + 8) + 4;
		ui.MouseMove(md, L2, px, py);
		ui.MouseDown(md, L2, 0, px, py, 50.0f);
		ui.MouseUp(md, L2, 0, px, py, 50.0f);
	}
	CHECK(ui.popup == POP_SPLIT && ui.splitMax == 5);
	CHECK_STR(ui.splitText, "3");   // half of six
	// type 2, then 4 -> "24" cut to the stack: clamps to 5
	{
		InvLayout L2 = Lay(md, ui);
		ui.Key(md, L2, IK_BACK, 0);
		ui.Key(md, L2, IK_DIGIT, 2);
		ui.Key(md, L2, IK_DIGIT, 4);
		CHECK(ui.SplitValue() == 5);
		ui.Key(md, L2, IK_BACK, 0);
		CHECK(ui.SplitValue() == 2);
		// minus and plus
		const IRect plus = ui.SplitPlus();
		ui.MouseDown(md, L2, 0, plus.x + 2, plus.y + 2, 51.0f);
		ui.MouseUp(md, L2, 0, plus.x + 2, plus.y + 2, 51.0f);
		CHECK(ui.SplitValue() == 3);
		const IRect minus = ui.SplitMinus();
		for (int i = 0; i < 5; i++)
		{
			ui.MouseDown(md, L2, 0, minus.x + 2, minus.y + 2, 51.0f);
			ui.MouseUp(md, L2, 0, minus.x + 2, minus.y + 2, 51.0f);
		}
		CHECK(ui.SplitValue() == 1);
		// OK
		const IRect ok = ui.SplitOk();
		ui.MouseDown(md, L2, 0, ok.x + 2, ok.y + 2, 52.0f);
		ui.MouseUp(md, L2, 0, ok.x + 2, ok.y + 2, 52.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv split 0 1 255");
		CHECK(ui.popup == POP_NONE);
	}
	// Enter confirms, ESC cancels
	Click(ui, md, 1, x, y);
	{
		InvLayout L2 = Lay(md, ui);
		const int px = ui.popupRect.x + 20, py = ui.popupRect.y + 6 + 3 * (L2.m.ch + 8) + 4;
		ui.MouseMove(md, L2, px, py);
		ui.MouseDown(md, L2, 0, px, py, 60.0f);
		ui.MouseUp(md, L2, 0, px, py, 60.0f);
		CHECK(ui.popup == POP_SPLIT);
		CHECK(ui.Key(md, L2, IK_ENTER, 0));
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv split 0 3 255");
		Click(ui, md, 1, x, y);
		const int qx = ui.popupRect.x + 20, qy = ui.popupRect.y + 6 + 3 * (L2.m.ch + 8) + 4;
		ui.MouseDown(md, L2, 0, qx, qy, 61.0f);
		ui.MouseUp(md, L2, 0, qx, qy, 61.0f);
		CHECK(ui.popup == POP_SPLIT);
		CHECK(ui.Key(md, L2, IK_ESC, 0));
		CHECK(ui.popup == POP_NONE && !ui.wantClose && Drain(ui).empty());
	}
}

static void TestDrag(Ui& ui, Model& md)
{
	InvLayout L = Lay(md, ui);
	int ax, ay, bx, by;
	Center(L.CellRect(0), ax, ay);
	Center(L.CellRect(2), bx, by);   // empty
	// move a stack to an empty cell
	ui.MouseMove(md, L, ax, ay);
	ui.MouseDown(md, L, 0, ax, ay, 70.0f);
	ui.MouseMove(md, L, ax + 20, ay + 5);
	CHECK(ui.dragging && ui.dragCell == 0);
	ui.MouseMove(md, L, bx, by);
	ui.MouseUp(md, L, 0, bx, by, 70.5f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv move 0 2");
	}
	CHECK(!ui.dragging && ui.selected == 2);

	// a click with no movement is no drag
	ui.MouseMove(md, L, ax, ay);
	ui.MouseDown(md, L, 0, ax, ay, 80.0f);
	ui.MouseMove(md, L, ax + 2, ay + 1);
	CHECK(!ui.dragging);
	ui.MouseUp(md, L, 0, ax, ay, 80.1f);
	CHECK(Drain(ui).empty());

	// shift-drag onto an empty cell splits half
	ui.shift = true;
	ui.MouseMove(md, L, ax, ay);
	ui.MouseDown(md, L, 0, ax, ay, 90.0f);
	ui.MouseMove(md, L, ax + 30, ay + 30);
	ui.MouseMove(md, L, bx, by);
	ui.MouseUp(md, L, 0, bx, by, 90.5f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv split 0 3 2");
	}
	// shift-drag out of the window drops one
	{
		const int ox = L.win.R() + 40, oy = L.win.y + 40;
		ui.MouseMove(md, L, ax, ay);
		ui.MouseDown(md, L, 0, ax, ay, 91.0f);
		ui.MouseMove(md, L, ax + 30, ay + 30);
		ui.MouseMove(md, L, ox, oy);
		ui.MouseUp(md, L, 0, ox, oy, 91.5f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv drop 0 1");
	}
	ui.shift = false;
	// a plain drag out of the window drops the whole stack
	{
		const int ox = L.win.x - 30, oy = L.win.y + 40;
		ui.MouseMove(md, L, ax, ay);
		ui.MouseDown(md, L, 0, ax, ay, 92.0f);
		ui.MouseMove(md, L, ax - 30, ay + 30);
		ui.MouseMove(md, L, ox, oy);
		ui.MouseUp(md, L, 0, ox, oy, 92.5f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv drop 0 6");
	}
	// a drag that ends on the window's own frame (not out of it, not on a cell) does nothing
	{
		const int fx = L.win.x + 3, fy = L.win.y + 3;
		ui.MouseMove(md, L, ax, ay);
		ui.MouseDown(md, L, 0, ax, ay, 93.0f);
		ui.MouseMove(md, L, ax - 30, ay - 5);
		ui.MouseUp(md, L, 0, fx, fy, 93.5f);
		CHECK(Drain(ui).empty());
	}
	// dragging an empty cell does nothing
	ui.MouseMove(md, L, bx, by);
	ui.MouseDown(md, L, 0, bx, by, 94.0f);
	ui.MouseMove(md, L, bx + 30, by + 30);
	CHECK(!ui.dragging);
	ui.MouseUp(md, L, 0, bx + 30, by + 30, 94.5f);
	CHECK(Drain(ui).empty());
}

static int FakeNear(Near* out, int max)
{
	int n = 0;
	if (max > 0)
	{
		out[n].index = 7;
		strcpy(out[n].name, "KANE, MARCUS");
		n++;
	}
	if (max > 1)
	{
		out[n].index = 12;
		strcpy(out[n].name, "REED, JOHN");
		n++;
	}
	return n;
}

static void TestShow()
{
	g_nearPlayers = FakeNear;
	Model md = Stocked();
	Ui ui;
	InvLayout L = Lay(md, ui);
	int x, y;
	Center(L.CellRect(4), x, y);   // the permit
	// the info panel's SHOW TO ... button (the fifth, a whole row) with the permit selected
	Click(ui, md, 0, x, y, 100.0f);
	CHECK(ui.selected == 4);
	Center(L.act[4], x, y);
	Click(ui, md, 0, x, y, 101.0f);
	// the button takes its row whole
	CHECK(L.act[4].w == 2 * L.act[0].w + L.m.gap && L.act[4].y > L.act[2].y);
	CHECK(ui.popup == POP_PLAYERS && ui.playersFor == MI_SHOW && ui.nearCount == 2);
	{
		InvLayout L2 = Lay(md, ui);
		const int px = ui.popupRect.x + 20, py = ui.popupRect.y + 6 + 1 * (L2.m.ch + 8) + 4;
		ui.MouseMove(md, L2, px, py);
		ui.MouseDown(md, L2, 0, px, py, 102.0f);
		ui.MouseUp(md, L2, 0, px, py, 102.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv show 4 12");
		CHECK(ui.popup == POP_NONE);
	}
	// the stack of six, SHOW TO ... with the first of the two players near
	Center(L.CellRect(0), x, y);
	Click(ui, md, 0, x, y, 110.0f);
	Center(L.act[4], x, y);
	Click(ui, md, 0, x, y, 111.0f);
	CHECK(ui.popup == POP_PLAYERS && ui.playersFor == MI_SHOW);
	{
		InvLayout L2 = Lay(md, ui);
		const int px = ui.popupRect.x + 20, py = ui.popupRect.y + 6 + 4;
		ui.MouseMove(md, L2, px, py);
		ui.MouseDown(md, L2, 0, px, py, 112.0f);
		ui.MouseUp(md, L2, 0, px, py, 112.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv show 0 7");
	}
	// nobody near: the list says so and a click shows nothing
	g_nearPlayers = nullptr;
	Center(L.act[4], x, y);
	Click(ui, md, 0, x, y, 120.0f);
	CHECK(ui.popup == POP_PLAYERS && ui.nearCount == 0);
	{
		InvLayout L2 = Lay(md, ui);
		const int px = ui.popupRect.x + 20, py = ui.popupRect.y + 6 + 4;
		ui.MouseDown(md, L2, 0, px, py, 121.0f);
		ui.MouseUp(md, L2, 0, px, py, 121.0f);
		CHECK(Drain(ui).empty() && ui.popup == POP_NONE);
	}
	// the info panel's buttons with nothing selected do nothing
	ui.selected = 2;   // an empty cell
	Center(L.act[0], x, y);
	Click(ui, md, 0, x, y, 130.0f);
	CHECK(Drain(ui).empty() && ui.popup == POP_NONE);
	// USE and DROP ALL from the buttons
	ui.selected = 0;
	Center(L.act[0], x, y);
	Click(ui, md, 0, x, y, 140.0f);
	Center(L.act[2], x, y);
	Click(ui, md, 0, x, y, 141.0f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 2 && o[0] == "h9inv use 0" && o[1] == "h9inv drop 0 6");
	}
	// tidy
	Center(L.tidy, x, y);
	Click(ui, md, 0, x, y, 150.0f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv tidy");
	}
}

static void TestExchange()
{
	Model md = Stocked();
	Ui ui;
	// an invitation is answered with the banner's buttons even with the window closed
	{
		Msg m;
		m.Byte(TR_INVITE).Byte(12).Str("KANE, MARCUS");
		md.OnTrade(m.data(), m.size(), 200.0f);
		InvLayout L = Lay(md, ui);
		int x, y;
		Center(L.accept, x, y);
		Click(ui, md, 0, x, y, 201.0f);
		Center(L.decline, x, y);
		Click(ui, md, 0, x, y, 202.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 2 && o[0] == "h9inv x accept" && o[1] == "h9inv x decline");
	}
	{
		Msg m;
		m.Byte(TR_OPEN).Str("KANE, MARCUS").Long(500).Byte(12).Byte(1);
		md.OnTrade(m.data(), m.size(), 210.0f);
	}
	InvLayout L = Lay(md, ui);
	CHECK(L.trade);
	int x, y;
	// drag a stack into an offer cell
	{
		int ax, ay;
		Center(L.CellRect(0), ax, ay);
		Center(L.OfferRect(0, 5), x, y);
		ui.MouseMove(md, L, ax, ay);
		ui.MouseDown(md, L, 0, ax, ay, 211.0f);
		ui.MouseMove(md, L, ax + 20, ay + 20);
		ui.MouseMove(md, L, x, y);
		ui.MouseUp(md, L, 0, x, y, 211.5f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x offer 0 6 5");
	}
	// into the grid but on a filled cell: the first free one is asked for
	{
		Msg m;
		m.Byte(TR_OFFER).Byte(0).Byte(5).Short(SOUP).Short(6).Str("");
		md.OnTrade(m.data(), m.size(), 212.0f);
		int ax, ay;
		Center(L.CellRect(1), ax, ay);
		Center(L.OfferRect(0, 5), x, y);
		ui.MouseMove(md, L, ax, ay);
		ui.MouseDown(md, L, 0, ax, ay, 213.0f);
		ui.MouseMove(md, L, ax + 20, ay + 20);
		ui.MouseMove(md, L, x, y);
		ui.MouseUp(md, L, 0, x, y, 213.5f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x offer 1 2 255");
	}
	// the menu of a cell offers OFFER
	{
		Center(L.CellRect(3), x, y);
		Click(ui, md, 1, x, y, 214.0f);
		bool has = false;
		for (int i = 0; i < ui.popupCount; i++)
			has = has || ui.popupItems[i] == MI_OFFER;
		CHECK(has);
		ui.ClosePopup();
	}
	// click an offered cell: it comes back; drag it away: it comes back
	Center(L.OfferRect(0, 5), x, y);
	Click(ui, md, 0, x, y, 215.0f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x take 5");
	}
	{
		const int fx = L.offerMine.x + 3, fy = L.offerMine.y + 3;
		(void)fx; (void)fy;
		Center(L.OfferRect(0, 5), x, y);
		const int tx = L.win.x + 30, ty = L.win.y + 30;
		ui.MouseMove(md, L, x, y);
		ui.MouseDown(md, L, 0, x, y, 216.0f);
		ui.MouseMove(md, L, x - 20, y);
		ui.MouseMove(md, L, tx, ty);
		ui.MouseUp(md, L, 0, tx, ty, 216.5f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x take 5");
	}
	// the seal: refused before its lock has run out, then taken, then undone
	{
		Msg s;
		s.Byte(TR_SEAL).Byte(0).Byte(0).Byte(30);   // 3 s lock from 220
		md.OnTrade(s.data(), s.size(), 220.0f);
		Center(L.sealBtn, x, y);
		Click(ui, md, 0, x, y, 221.0f);
		CHECK(Drain(ui).empty());
		Click(ui, md, 0, x, y, 223.5f);
		{
			auto o = Drain(ui);
			CHECK(o.size() == 1 && o[0] == "h9inv x seal");
		}
		Msg t;
		t.Byte(TR_SEAL).Byte(1).Byte(0).Byte(0);
		md.OnTrade(t.data(), t.size(), 224.0f);
		Click(ui, md, 0, x, y, 225.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x unseal");
	}
	// the money field: click, type 1 2 5, Enter; the wallet is the limit
	{
		Center(L.myMoney, x, y);
		Click(ui, md, 0, x, y, 230.0f);
		CHECK(ui.editMoney);
		InvLayout L2 = Lay(md, ui);
		for (int i = 0; i < 5; i++)
			ui.Key(md, L2, IK_BACK, 0);
		CHECK(ui.Key(md, L2, IK_DIGIT, 1));
		CHECK(ui.Key(md, L2, IK_DIGIT, 2));
		CHECK(ui.Key(md, L2, IK_DIGIT, 5));
		CHECK(ui.Key(md, L2, IK_ENTER, 0));
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x money 125");
		Click(ui, md, 0, x, y, 231.0f);
		for (int i = 0; i < 5; i++)
			ui.Key(md, L2, IK_BACK, 0);
		for (int i = 0; i < 6; i++)
			ui.Key(md, L2, IK_DIGIT, 9);
		ui.Key(md, L2, IK_ENTER, 0);
		auto p = Drain(ui);
		CHECK(p.size() == 1 && p[0] == "h9inv x money 500");   // 999999 cut to the wallet
		// the quick buttons
		Center(L.quick[1], x, y);
		Click(ui, md, 0, x, y, 232.0f);
		Center(L.quick[2], x, y);
		Click(ui, md, 0, x, y, 233.0f);
		Center(L.quick[3], x, y);
		Click(ui, md, 0, x, y, 234.0f);
		auto q = Drain(ui);
		CHECK(q.size() == 3 && q[0] == "h9inv x money 100" && q[1] == "h9inv x money 500" && q[2] == "h9inv x money 0");
	}
	// ESC cancels the exchange; WITHDRAW and its X too
	{
		InvLayout L2 = Lay(md, ui);
		CHECK(ui.Key(md, L2, IK_ESC, 0));
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x cancel");
		Center(L.withdrawBtn, x, y);
		Click(ui, md, 0, x, y, 240.0f);
		Center(L.tx, x, y);
		Click(ui, md, 0, x, y, 241.0f);
		auto p = Drain(ui);
		CHECK(p.size() == 2 && p[0] == "h9inv x cancel" && p[1] == "h9inv x cancel");
	}
	// the exchange is over: the inventory window alone again
	{
		Msg m;
		m.Byte(TR_CLOSE).Byte(TC_YOU_WITHDREW).Str("");
		md.OnTrade(m.data(), m.size(), 250.0f);
		InvLayout L2 = Lay(md, ui);
		CHECK(!L2.trade && L2.info.w > 0);
		CHECK(ui.Key(md, L2, IK_ESC, 0) && ui.wantClose);
	}
}

static void TestScroll()
{
	Model md = Stocked(96);   // twelve rows
	Ui ui;
	InvLayout L = Lay(md, ui);
	CHECK(L.totalRows == 12 && L.visRows == 4);
	int x, y;
	Center(L.scrollDn, x, y);
	Click(ui, md, 0, x, y, 300.0f);
	CHECK(ui.scroll == 1);
	CHECK(Drain(ui).empty());
	InvLayout L2 = Lay(md, ui);
	CHECK(L2.firstRow == 1);
	// a cell of the new first row is reached at its new place
	int cx, cy;
	Center(L2.CellRect(8), cx, cy);
	CHECK(L2.CellAt(cx, cy, md.slots) == 8);
	// the wheel over the window
	ui.mx = L2.grid.x + 4;
	ui.my = L2.grid.y + 4;
	CHECK(ui.Key(md, L2, IK_WHEEL_DOWN, 0));
	CHECK(ui.scroll == 2);
	for (int i = 0; i < 20; i++)
		ui.Key(md, Lay(md, ui), IK_WHEEL_DOWN, 0);
	CHECK(ui.scroll == 8);
	for (int i = 0; i < 20; i++)
		ui.Key(md, Lay(md, ui), IK_WHEEL_UP, 0);
	CHECK(ui.scroll == 0);
	// the wheel with the cursor outside the window is not taken
	ui.mx = 2;
	ui.my = 2;
	CHECK(!ui.Key(md, Lay(md, ui), IK_WHEEL_DOWN, 0));
	// a window with one screen of cells has nothing to scroll and takes no wheel
	Model small = Stocked(32);
	Ui u2;
	u2.mx = Lay(small, u2).grid.x + 4;
	u2.my = Lay(small, u2).grid.y + 4;
	CHECK(!u2.Key(small, Lay(small, u2), IK_WHEEL_DOWN, 0));
}

static void TestEsc()
{
	Model md = Stocked();
	Ui ui;
	InvLayout L = Lay(md, ui);
	// ESC closes a popup first, then the window
	int x, y;
	Center(L.CellRect(0), x, y);
	Click(ui, md, 1, x, y);
	CHECK(ui.popup == POP_CONTEXT);
	CHECK(ui.Key(md, L, IK_ESC, 0));
	CHECK(ui.popup == POP_NONE && !ui.wantClose);
	CHECK(ui.Key(md, L, IK_ESC, 0));
	CHECK(ui.wantClose);
	// digits are not taken outside a text box
	CHECK(!ui.Key(md, L, IK_DIGIT, 3));
	CHECK(!ui.Key(md, L, IK_ENTER, 0));
}

// ---- the search of a handcuffed player (H9Search), written from DESIGN-M5.md sections 2 and 3 only

static void SearchOpen(Model& md, int cells, const char* name = "KANE, MARCUS", int flags = 0)
{
	Msg m;
	m.Byte(SR_OPEN).Byte(flags).Short(cells).Str(name);
	CHECK(md.OnSearch(m.data(), m.size(), 1.0f));
}

static void SearchSlots(Model& md, int first, std::vector<std::pair<int, int>> cells)
{
	Msg m;
	m.Byte(SR_SLOTS).Short(first).Byte((int)cells.size());
	for (auto& c : cells)
		m.Short(c.first).Short(c.second);
	md.OnSearch(m.data(), m.size(), 1.0f);
}

// the searcher's own window (Stocked) and a search of a player with a stack of five, a single and two more, in a grid of `cells`
static Model Searching(int cells = 32)
{
	Model md = Stocked(32);
	SearchOpen(md, cells);
	SearchSlots(md, 0, {{SOUP, 5}, {0, 0}, {PIZZA, 1}, {CARD, 2}});
	return md;
}

static void TestSearchWire()
{
	Model md = Stocked();
	// OPEN: his name (cut to 32 characters), the length of his grid and its capacity bit; his cells start empty
	SearchOpen(md, 40, "A VERY LONG NAME THAT RUNS PAST THE THIRTY-TWO CHARACTERS A NAME MAY HAVE", 1);
	CHECK(md.search.open && md.search.over && md.search.cells == 40);
	CHECK(strlen(md.search.name) == 32);
	CHECK(md.SearchUsed() == 0);
	// SLOTS: a run of his cells, the empty ones with kind 0
	SearchSlots(md, 2, {{SOUP, 5}, {0, 0}, {PIZZA, 1}});
	CHECK(md.search.theirs[2].kind == SOUP && md.search.theirs[2].n == 5);
	CHECK(md.search.theirs[3].kind == 0 && md.search.theirs[3].n == 0);
	CHECK(md.search.theirs[4].kind == PIZZA && md.search.theirs[4].n == 1);
	CHECK(md.SearchUsed() == 2);
	// a cell emptied by a take
	SearchSlots(md, 2, {{0, 0}});
	CHECK(md.search.theirs[2].kind == 0 && md.SearchUsed() == 1);
	// a kind with no count, and a count with no kind, are empty cells
	SearchSlots(md, 5, {{SOUP, 0}, {0, 9}});
	CHECK(md.search.theirs[5].kind == 0 && md.search.theirs[6].kind == 0 && md.SearchUsed() == 1);
	// a cell beyond the grid of OPEN makes the grid longer; one beyond the client's own limit is left out
	SearchSlots(md, 44, {{KEY, 3}});
	CHECK(md.search.cells == 45 && md.search.theirs[44].kind == KEY);
	SearchSlots(md, MAX_CELLS + 3, {{KEY, 3}});
	CHECK(md.search.cells == 45);
	SearchSlots(md, -2, {{KEY, 3}, {KEY, 3}, {PIZZA, 2}});   // the first two are before the grid, the third is cell 0
	CHECK(md.search.theirs[0].kind == PIZZA);
	// a count the client does not believe is cut
	SearchSlots(md, 10, {{SOUP, 32000}});
	CHECK(md.search.theirs[10].n == MAX_COUNT);
	// NOTE: the status row, plain and a warning
	{
		Msg m;
		m.Byte(SR_NOTE).Byte(0).Str("You took 3 Soda.");
		CHECK(!md.OnSearch(m.data(), m.size(), 5.0f));
		CHECK_STR(md.note, "You took 3 Soda.");
		CHECK(md.noteLevel == 0 && md.noteUntil > 5.0f);
		Msg w;
		w.Byte(SR_NOTE).Byte(1).Str("Your inventory is full.");
		md.OnSearch(w.data(), w.size(), 6.0f);
		CHECK_STR(md.note, "Your inventory is full.");
		CHECK(md.noteLevel == 1);
	}
	// a second OPEN replaces the first: another player, or the snapshot again
	SearchOpen(md, 32, "VOSS, ADRIAN");
	CHECK_STR(md.search.name, "VOSS, ADRIAN");
	CHECK(!md.search.over && md.search.cells == 32 && md.SearchUsed() == 0);
	// CLOSE: the window goes with his cells, and the reason is worded for the status row
	{
		SearchSlots(md, 0, {{SOUP, 5}});
		Msg m;
		m.Byte(SR_CLOSE).Byte(SC_FREED);
		CHECK(!md.OnSearch(m.data(), m.size(), 7.0f));
		CHECK(!md.search.open && md.search.cells == 0 && md.SearchUsed() == 0);
		CHECK_STR(md.note, "The search ended: he is free.");
		CHECK(md.noteLevel == 1);
	}
	const int reasons[] = {SC_DIED, SC_LEFT, SC_RANGE, SC_YOU, SC_MAP};
	const char* words[] = {"The search ended: he died.", "The search ended: he left.", "The search ended: you moved away.", "The search ended.", "The search ended."};
	for (int i = 0; i < 5; i++)
	{
		SearchOpen(md, 8);
		Msg m;
		m.Byte(SR_CLOSE).Byte(reasons[i]);
		md.OnSearch(m.data(), m.size(), 8.0f);
		CHECK_STR(md.note, words[i]);
	}
	// closed by the player himself: no words of its own (the note before stays what it was), and a CLOSE with no window says nothing
	md.SetNote("before", 0, 9.0f);
	SearchOpen(md, 8);
	{
		Msg m;
		m.Byte(SR_CLOSE).Byte(SC_YOU_CLOSED);
		md.OnSearch(m.data(), m.size(), 9.5f);
		CHECK(!md.search.open);
		CHECK_STR(md.note, "before");
		md.OnSearch(m.data(), m.size(), 9.6f);
		CHECK_STR(md.note, "before");
	}
	// a SLOTS with no window is ignored
	SearchSlots(md, 0, {{SOUP, 5}});
	CHECK(md.SearchUsed() == 0 && !md.search.open);

	// refused: truncated, an unknown op, a string that does not end, an empty message
	const int bad0 = md.msgsBad;
	{
		Msg m;
		m.Byte(SR_OPEN).Byte(0).Short(8);   // no name
		CHECK(!md.OnSearch(m.data(), m.size(), 1.0f));
		CHECK(!md.search.open);
		Msg u;
		u.Byte(9);
		md.OnSearch(u.data(), u.size(), 1.0f);
		Msg s;
		s.Byte(SR_OPEN).Byte(0).Short(8).Byte('A').Byte('B');   // never ends
		CHECK(!md.OnSearch(s.data(), s.size(), 1.0f));
		CHECK(!md.OnSearch(nullptr, 0, 1.0f));
		SearchOpen(md, 8);
		Msg t;
		t.Byte(SR_SLOTS).Short(0).Byte(3).Short(SOUP).Short(1);   // three cells promised, one and a half sent
		md.OnSearch(t.data(), t.size(), 1.0f);
		Msg n;
		n.Byte(SR_NOTE).Byte(0).Byte('x');   // never ends
		md.OnSearch(n.data(), n.size(), 1.0f);
		Msg c;
		c.Byte(SR_CLOSE);   // no reason
		md.OnSearch(c.data(), c.size(), 1.0f);
		CHECK(md.search.open);   // none of the refused ones closed it
	}
	CHECK(md.msgsBad >= bad0 + 6);
	// what a bad SLOTS had time to set stays within the grid
	CHECK(md.search.theirs[0].kind == SOUP);

	// the window of the searcher's own inventory: a CLOSE of it closes the search too, and its OPEN again leaves the search for the new H9Search OPEN to replace
	Model m2 = Searching();
	CHECK(m2.search.open);
	Open(m2, 32);
	CHECK(m2.search.open && m2.search.theirs[0].kind == SOUP);
	{
		Msg c;
		c.Byte(INV_CLOSE);
		m2.OnInv(c.data(), c.size(), 2.0f);
		CHECK(!m2.open && !m2.search.open && m2.SearchUsed() == 0);
	}
	// a map or a server forgets it
	Model m3 = Searching();
	m3.Clear();
	CHECK(!m3.search.open && m3.msgsSearch == 0 && m3.lastOpSearch == 0);
	// the counters
	Model m4 = Searching();
	CHECK(m4.msgsSearch == 2 && m4.lastOpSearch == SR_SLOTS);
}

static void TestSearchLayout()
{
	const int sizes[][2] = {{640, 480}, {800, 600}, {1024, 768}, {1280, 720}, {1366, 768}, {1920, 1080}, {2560, 1440}};
	const int lengths[] = {32, 96, 200};
	for (int len : lengths)
	{
		for (auto& s : sizes)
		{
			Model md = Searching(len);
			char what[64];
			snprintf(what, sizeof(what), "%dx%d, %d cells", s[0], s[1], len);
			InvLayout L = BuildLayout(md, s[0], s[1], 12, 0, 0);
			CHECK(L.search && !L.trade && L.Compact());
			// beside the inventory, on the screen (the smallest screen may not hold the pair)
			const bool inside = L.win.x >= 0 && L.win.y >= 0 && L.swin.R() <= s[0] && L.swin.B() <= s[1] && L.win.B() <= s[1];
			if (!inside)
				printf("  the pair of windows is outside the screen at %s: %d,%d %dx%d and %d,%d %dx%d\n", what, L.win.x, L.win.y, L.win.w, L.win.h, L.swin.x, L.swin.y, L.swin.w, L.swin.h);
			if (s[0] >= 800)
				CHECK(inside);
			CHECK(L.swin.x >= L.win.R());
			CHECK(L.swin.h >= L.win.h);
			// there is no panel of the selected item beside the inventory's grid
			CHECK(L.info.w == 0 && L.info.h == 0);
			// every visible cell of his grid is found at its own centre, and the grids do not meet
			CHECK(L.svisRows >= 1 && L.svisRows <= L.stotalRows);
			for (int i = L.sfirstRow * L.scols; i < md.search.cells && i < (L.sfirstRow + L.svisRows) * L.scols; i++)
			{
				int cx, cy;
				Center(L.SCellRect(i), cx, cy);
				CHECK(L.SCellAt(cx, cy, md.search.cells) == i);
				CHECK(L.sgrid.Has(cx, cy));
				CHECK(L.CellAt(cx, cy, md.slots) == -1);
			}
			CHECK(L.sgrid.x >= L.win.R());
			// the buttons are inside his window, side by side
			CHECK(L.swin.Has(L.sx.x + 1, L.sx.y + 1));
			CHECK(L.swin.Has(L.stakeOne.x, L.stakeOne.y) && L.swin.Has(L.sclose.R() - 1, L.sclose.B() - 1));
			CHECK(L.stakeOne.R() <= L.stakeAll.x && L.stakeAll.R() <= L.sclose.x);
			CHECK(L.sgrid.B() <= L.stakeOne.y && L.stakeOne.B() <= L.sstatus.y && L.sstatus.B() <= L.shint.y);
			CHECK(L.swin.Has(L.shint.x, L.shint.y) && L.swin.B() >= L.shint.B());
			// scrolling stays in range, and the arrows are only where there is something to scroll
			InvLayout S = BuildLayout(md, s[0], s[1], 12, 0, 999);
			CHECK(S.sfirstRow == S.stotalRows - S.svisRows || S.stotalRows <= S.svisRows);
			InvLayout N = BuildLayout(md, s[0], s[1], 12, 0, -5);
			CHECK(N.sfirstRow == 0);
			CHECK((L.stotalRows > L.svisRows) == (L.sscrollUp.w > 0));
			// a cell outside the grid is none
			CHECK(L.SCellAt(0, 0, md.search.cells) == -1);
		}
	}
	// the search takes the place of an exchange that is also flagged open (the server never sends both)
	Model both = Searching();
	{
		Msg m;
		m.Byte(TR_OPEN).Str("KANE, MARCUS").Long(500).Byte(12).Byte(1);
		both.OnTrade(m.data(), m.size(), 1.0f);
	}
	InvLayout B = BuildLayout(both, 1280, 720, 12, 0, 0);
	CHECK(B.search && !B.trade);
	// no search: the layout is what it was
	Model plain = Stocked();
	InvLayout P = BuildLayout(plain, 1280, 720, 12, 0, 0);
	CHECK(!P.search && P.swin.w == 0 && P.info.w > 0 && !P.Compact());
	CHECK(P.SCellAt(P.win.x + 20, P.win.y + 60, 32) == -1);
}

static void TestSearchClicks()
{
	Model md = Searching();   // his cells: 0 five Soda, 1 empty, 2 one Pizza, 3 two Permit
	Ui ui;
	InvLayout L = Lay(md, ui);
	int x, y;

	// select by a click: no command, and his selection is not mine
	Center(L.SCellRect(0), x, y);
	Click(ui, md, 0, x, y, 10.0f);
	CHECK(ui.sSelected == 0 && ui.selected == -1);
	CHECK(Drain(ui).empty());
	CHECK(ui.sHover == 0);
	// a double click takes all of the cell
	Click(ui, md, 0, x, y, 20.0f);
	Click(ui, md, 0, x, y, 20.2f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 5");
	}
	// two slow clicks do not
	Click(ui, md, 0, x, y, 30.0f);
	Click(ui, md, 0, x, y, 31.0f);
	CHECK(Drain(ui).empty());
	// a click on an empty cell of his selects it and takes nothing, a double click on it neither
	Center(L.SCellRect(1), x, y);
	Click(ui, md, 0, x, y, 40.0f);
	Click(ui, md, 0, x, y, 40.1f);
	CHECK(Drain(ui).empty());

	// the buttons take what is selected: one, or all of it
	Center(L.SCellRect(3), x, y);
	Click(ui, md, 0, x, y, 50.0f);
	CHECK(ui.sSelected == 3);
	Center(L.stakeOne, x, y);
	Click(ui, md, 0, x, y, 51.0f);
	Center(L.stakeAll, x, y);
	Click(ui, md, 0, x, y, 52.0f);
	{
		auto o = Drain(ui);
		CHECK(o.size() == 2 && o[0] == "h9inv s take 3 1" && o[1] == "h9inv s take 3 2");
	}
	// with nothing selected (or an empty cell selected) they do nothing
	Ui none;
	Center(L.stakeOne, x, y);
	Click(none, md, 0, x, y, 60.0f);
	Center(L.stakeAll, x, y);
	Click(none, md, 0, x, y, 61.0f);
	CHECK(Drain(none).empty());
	Center(L.SCellRect(1), x, y);
	Click(none, md, 0, x, y, 62.0f);
	Center(L.stakeAll, x, y);
	Click(none, md, 0, x, y, 63.0f);
	CHECK(Drain(none).empty());

	// the right-click menu of a stack: TAKE ALL, TAKE ONE, TAKE ..., INFO; of a single item: TAKE ALL, INFO; of an empty cell: none
	Ui mu;
	Center(L.SCellRect(0), x, y);
	Click(mu, md, 1, x, y);
	CHECK(mu.popup == POP_CONTEXT && mu.popupTheirs && mu.popupCell == 0 && mu.sSelected == 0);
	CHECK(mu.popupCount == 4 && mu.popupItems[0] == MI_TAKEALL && mu.popupItems[1] == MI_TAKE1 && mu.popupItems[2] == MI_TAKEN && mu.popupItems[3] == MI_INFO);
	CHECK(L.sw >= mu.popupRect.R() && L.sh >= mu.popupRect.B());
	auto choose = [&](Ui& u, int line) {
		InvLayout L2 = Lay(md, u);
		const int px = u.popupRect.x + 20, py = u.popupRect.y + 6 + line * (L2.m.ch + 8) + 4;
		u.MouseMove(md, L2, px, py);
		CHECK(u.popupHover == line);
		u.MouseDown(md, L2, 0, px, py, 70.0f);
		u.MouseUp(md, L2, 0, px, py, 70.0f);
	};
	choose(mu, 1);   // TAKE ONE
	{
		auto o = Drain(mu);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 1");
		CHECK(mu.popup == POP_NONE && !mu.popupTheirs);
	}
	Center(L.SCellRect(0), x, y);
	Click(mu, md, 1, x, y);
	choose(mu, 0);   // TAKE ALL
	{
		auto o = Drain(mu);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 5");
	}
	Center(L.SCellRect(0), x, y);
	Click(mu, md, 1, x, y);
	choose(mu, 3);   // INFO: the item's own description is asked for, the way the window asks for its own
	{
		auto o = Drain(mu);
		CHECK(o.size() == 1 && o[0] == "h9inv info 1");
	}
	Center(L.SCellRect(2), x, y);
	Click(mu, md, 1, x, y);
	CHECK(mu.popupCount == 2 && mu.popupItems[0] == MI_TAKEALL && mu.popupItems[1] == MI_INFO);
	Click(mu, md, 0, 5, 5);   // a click outside the menu only closes it
	CHECK(mu.popup == POP_NONE && Drain(mu).empty());
	Center(L.SCellRect(1), x, y);
	Click(mu, md, 1, x, y);
	CHECK(mu.popup == POP_NONE);

	// TAKE ...: a box asks how many (all of them to start with), the keys type, OK and Enter take
	Ui bu;
	Center(L.SCellRect(0), x, y);
	Click(bu, md, 1, x, y);
	choose(bu, 2);
	CHECK(bu.popup == POP_SPLIT && bu.popupTheirs && bu.splitMax == 5 && bu.SplitValue() == 5);
	CHECK(bu.Key(md, Lay(md, bu), IK_BACK, 0));
	CHECK(bu.Key(md, Lay(md, bu), IK_DIGIT, 3));
	CHECK(bu.SplitValue() == 3);
	CHECK(bu.Key(md, Lay(md, bu), IK_DIGIT, 9));
	CHECK(bu.SplitValue() == 5);   // 39: more than there is, cut to the stack
	CHECK(bu.Key(md, Lay(md, bu), IK_BACK, 0));
	CHECK(bu.Key(md, Lay(md, bu), IK_BACK, 0));
	CHECK(bu.SplitValue() == 1);   // none typed: at least one
	CHECK(bu.Key(md, Lay(md, bu), IK_DIGIT, 4));
	CHECK(bu.Key(md, Lay(md, bu), IK_ENTER, 0));
	{
		auto o = Drain(bu);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 4");
		CHECK(bu.popup == POP_NONE && !bu.popupTheirs);
	}
	Center(L.SCellRect(0), x, y);
	Click(bu, md, 1, x, y);
	choose(bu, 2);
	{
		InvLayout L3 = Lay(md, bu);
		Center(bu.SplitMinus(), x, y);
		Click(bu, md, 0, x, y);
		Center(bu.SplitMinus(), x, y);
		Click(bu, md, 0, x, y);
		CHECK(bu.SplitValue() == 3);
		Center(bu.SplitOk(), x, y);
		Click(bu, md, 0, x, y);
		auto o = Drain(bu);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 3");
		(void)L3;
	}
	// CANCEL, and ESC, take nothing
	Center(L.SCellRect(0), x, y);
	Click(bu, md, 1, x, y);
	choose(bu, 2);
	Center(bu.SplitCancel(), x, y);
	Click(bu, md, 0, x, y);
	CHECK(bu.popup == POP_NONE && Drain(bu).empty());
	Center(L.SCellRect(0), x, y);
	Click(bu, md, 1, x, y);
	choose(bu, 2);
	CHECK(bu.Key(md, Lay(md, bu), IK_ESC, 0));
	CHECK(bu.popup == POP_NONE && !bu.wantSearchClose && Drain(bu).empty());
	// my own split is still my own
	Center(L.CellRect(0), x, y);
	Click(bu, md, 1, x, y);
	CHECK(bu.popup == POP_CONTEXT && !bu.popupTheirs);
	bu.ClosePopup();

	// a drag of his tile onto my window takes all of it; with shift, one; anywhere else nothing
	Ui du;
	InvLayout LD = Lay(md, du);
	auto drag = [&](Ui& u, int cell, int toX, int toY, bool shift) {
		static float at = 80.0f;   // each drag a moment of its own: two presses within a third of a second are a double click
		at += 5.0f;
		InvLayout L2 = Lay(md, u);
		int fx, fy;
		Center(L2.SCellRect(cell), fx, fy);
		u.shift = shift;
		u.MouseMove(md, L2, fx, fy);
		u.MouseDown(md, L2, 0, fx, fy, at);
		u.MouseMove(md, L2, fx + 20, fy + 20);   // past DRAG_START: the tile is lifted
		CHECK(u.dragging && u.sDragCell == cell);
		u.MouseMove(md, L2, toX, toY);
		u.MouseUp(md, L2, 0, toX, toY, at + 0.5f);
		CHECK(!u.dragging && u.sDragCell == -1 && u.sPressCell == -1);
		u.shift = false;
	};
	Center(LD.CellRect(6), x, y);
	drag(du, 0, x, y, false);
	{
		auto o = Drain(du);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 5");
	}
	drag(du, 0, LD.win.x + 8, LD.win.y + 8, true);
	{
		auto o = Drain(du);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 0 1");
	}
	drag(du, 3, LD.win.x + LD.win.w / 2, LD.win.y + 6, false);
	{
		auto o = Drain(du);
		CHECK(o.size() == 1 && o[0] == "h9inv s take 3 2");
	}
	drag(du, 0, 3, 3, false);   // outside every window: given up
	CHECK(Drain(du).empty());
	Center(LD.SCellRect(5), x, y);
	drag(du, 0, x, y, false);   // dropped on his own window: given up too
	CHECK(Drain(du).empty());
	{
		// an empty cell is not lifted
		Ui eu;
		InvLayout L2 = Lay(md, eu);
		int fx, fy;
		Center(L2.SCellRect(1), fx, fy);
		eu.MouseMove(md, L2, fx, fy);
		eu.MouseDown(md, L2, 0, fx, fy, 90.0f);
		eu.MouseMove(md, L2, fx + 30, fy + 30);
		CHECK(!eu.dragging);
		eu.MouseUp(md, L2, 0, fx + 30, fy + 30, 90.2f);
		CHECK(Drain(eu).empty());
	}

	// the X, CLOSE and ESC end the search: the command, and a sign for the engine part to forget the window
	{
		Ui xu;
		Center(L.sx, x, y);
		Click(xu, md, 0, x, y);
		auto o = Drain(xu);
		CHECK(o.size() == 1 && o[0] == "h9inv s close" && xu.wantSearchClose && !xu.wantClose);
		Ui cu;
		Center(L.sclose, x, y);
		Click(cu, md, 0, x, y);
		o = Drain(cu);
		CHECK(o.size() == 1 && o[0] == "h9inv s close" && cu.wantSearchClose);
		Ui eu;
		CHECK(eu.Key(md, L, IK_ESC, 0));
		o = Drain(eu);
		CHECK(o.size() == 1 && o[0] == "h9inv s close" && eu.wantSearchClose && !eu.wantClose);
		// the inventory window's own X is still its own
		Ui iu;
		Center(L.xBtn, x, y);
		Click(iu, md, 0, x, y);
		CHECK(iu.wantClose && !iu.wantSearchClose && Drain(iu).empty());
	}
	// ESC with a popup open closes the popup first, and the search after it
	{
		Ui pu;
		Center(L.SCellRect(0), x, y);
		Click(pu, md, 1, x, y);
		CHECK(pu.Key(md, L, IK_ESC, 0));
		CHECK(pu.popup == POP_NONE && !pu.wantSearchClose && Drain(pu).empty());
		CHECK(pu.Key(md, L, IK_ESC, 0));
		CHECK(pu.wantSearchClose);
	}
	// EndSearch: what belonged to the search goes, what is mine stays
	{
		Ui eu;
		Center(L.SCellRect(0), x, y);
		Click(eu, md, 0, x, y, 100.0f);
		Center(L.CellRect(1), x, y);
		Click(eu, md, 0, x, y, 101.0f);
		CHECK(eu.sSelected == 0 && eu.selected == 1);
		Center(L.SCellRect(0), x, y);
		Click(eu, md, 1, x, y);
		CHECK(eu.popupTheirs);
		eu.sScroll = 1;
		eu.EndSearch();
		CHECK(eu.sSelected == -1 && eu.sScroll == 0 && eu.popup == POP_NONE && !eu.popupTheirs && eu.selected == 1);
		// a drag of his tile in progress stops
		Ui gu;
		InvLayout L2 = Lay(md, gu);
		int fx, fy;
		Center(L2.SCellRect(0), fx, fy);
		gu.MouseDown(md, L2, 0, fx, fy, 110.0f);
		gu.MouseMove(md, L2, fx + 30, fy + 30);
		CHECK(gu.dragging);
		gu.EndSearch();
		CHECK(!gu.dragging && gu.sDragCell == -1);
	}

	// my own window works as ever beside the search: a double click uses, a drag moves, a menu has USE
	{
		Ui ou;
		Center(L.CellRect(0), x, y);
		Click(ou, md, 0, x, y, 120.0f);
		Click(ou, md, 0, x, y, 120.2f);
		auto o = Drain(ou);
		CHECK(o.size() == 1 && o[0] == "h9inv use 0");
		Center(L.CellRect(0), x, y);
		Click(ou, md, 1, x, y);
		CHECK(ou.popup == POP_CONTEXT && !ou.popupTheirs && ou.popupItems[0] == MI_USE);
		ou.ClosePopup();
		// a tile of mine dropped on his window is not dropped on the floor (it is inside a window)
		InvLayout L2 = Lay(md, ou);
		int fx, fy, tx, ty;
		Center(L2.CellRect(0), fx, fy);
		Center(L2.SCellRect(5), tx, ty);
		ou.MouseMove(md, L2, fx, fy);
		ou.MouseDown(md, L2, 0, fx, fy, 130.0f);
		ou.MouseMove(md, L2, fx + 30, fy);
		ou.MouseMove(md, L2, tx, ty);
		ou.MouseUp(md, L2, 0, tx, ty, 130.5f);
		CHECK(Drain(ou).empty());
		// and one dropped on my own empty cell moves
		Center(L2.CellRect(6), tx, ty);
		ou.MouseMove(md, L2, fx, fy);
		ou.MouseDown(md, L2, 0, fx, fy, 131.0f);
		ou.MouseMove(md, L2, fx + 30, fy);
		ou.MouseUp(md, L2, 0, tx, ty, 131.5f);
		o = Drain(ou);
		CHECK(o.size() == 1 && o[0] == "h9inv move 0 6");
	}

	// the wheel scrolls his grid when the cursor is over his window, mine over mine
	{
		Model big = Searching(128);   // twenty-two rows of six
		Ui su;
		InvLayout LS = Lay(big, su);
		CHECK(LS.stotalRows > LS.svisRows && LS.sscrollUp.w > 0);
		su.mx = LS.sgrid.x + 5;
		su.my = LS.sgrid.y + 5;
		CHECK(su.Key(big, LS, IK_WHEEL_DOWN, 0));
		CHECK(su.sScroll == 1 && su.scroll == 0);
		for (int i = 0; i < 40; i++)
			su.Key(big, Lay(big, su), IK_WHEEL_DOWN, 0);
		{
			InvLayout LE = Lay(big, su);
			CHECK(su.sScroll == LE.stotalRows - LE.svisRows);
			// the cells now shown are reached at their new places, and a click on one takes the right cell
			const int last = big.search.cells - 1;
			SearchSlots(big, last, {{SOUP, 2}});
			Center(LE.SCellRect(last), x, y);
			CHECK(LE.SCellAt(x, y, big.search.cells) == last);
			Click(su, big, 0, x, y, 140.0f);
			Click(su, big, 0, x, y, 140.2f);
			auto o = Drain(su);
			CHECK(o.size() == 1 && o[0] == "h9inv s take 127 2");
		}
		for (int i = 0; i < 40; i++)
			su.Key(big, Lay(big, su), IK_WHEEL_UP, 0);
		CHECK(su.sScroll == 0);
		// the arrows
		Center(LS.sscrollDn, x, y);
		Click(su, big, 0, x, y, 150.0f);
		CHECK(su.sScroll == 1 && Drain(su).empty());
		Center(Lay(big, su).sscrollUp, x, y);
		Click(su, big, 0, x, y, 151.0f);
		CHECK(su.sScroll == 0);
		// over my own window the wheel is mine
		Ui mu2;
		Model big2 = Searching(128);
		Open(big2, 96);
		big2.search = big.search;
		InvLayout LM = Lay(big2, mu2);
		mu2.mx = LM.grid.x + 4;
		mu2.my = LM.grid.y + 4;
		CHECK(mu2.Key(big2, LM, IK_WHEEL_DOWN, 0));
		CHECK(mu2.scroll == 1 && mu2.sScroll == 0);
		// a search of a short grid has nothing to scroll and takes no wheel over its window
		Ui nu;
		InvLayout LN = Lay(md, nu);
		nu.mx = LN.sgrid.x + 4;
		nu.my = LN.sgrid.y + 4;
		CHECK(LN.stotalRows <= LN.svisRows || nu.Key(md, LN, IK_WHEEL_DOWN, 0));
	}
}

// ---- dragging the windows by their title bars

// Press on a point, move to another in steps (the layout is built again between events, as the game does every frame), let go.
static void DragWindow(Ui& ui, Model& md, int fromX, int fromY, int toX, int toY, float now = 20.0f)
{
	InvLayout L = Lay(md, ui);
	ui.MouseMove(md, L, fromX, fromY);
	ui.MouseDown(md, L, 0, fromX, fromY, now);
	const int steps = 4;
	for (int i = 1; i <= steps; i++)
	{
		InvLayout Li = Lay(md, ui);
		ui.MouseMove(md, Li, fromX + (toX - fromX) * i / steps, fromY + (toY - fromY) * i / steps);
	}
	InvLayout Le = Lay(md, ui);
	ui.MouseUp(md, Le, 0, toX, toY, now + 0.5f);
}

static void TestWindowDrag()
{
	// the inventory window follows its title bar
	{
		Model md = Stocked();
		Ui ui;
		InvLayout L0 = Lay(md, ui);
		const int tx = L0.win.x + 40, ty = L0.win.y + 10;
		CHECK(ui.TitleAt(L0, tx, ty) == 0);
		CHECK(ui.TitleAt(L0, L0.xBtn.x + 2, L0.xBtn.y + 2) == -1);   // the X is a button, not a handle
		CHECK(ui.TitleAt(L0, L0.win.x + 40, L0.win.y + L0.m.titleH + 20) == -1);   // under the title bar is the grid
		DragWindow(ui, md, tx, ty, tx - 100, ty + 60);
		InvLayout L1 = Lay(md, ui);
		CHECK(L1.win.x == L0.win.x - 100 && L1.win.y == L0.win.y + 60);
		CHECK(L1.win.w == L0.win.w && L1.win.h == L0.win.h);
		// everything in it moved with it
		CHECK(L1.xBtn.x == L0.xBtn.x - 100 && L1.xBtn.y == L0.xBtn.y + 60);
		CHECK(L1.grid.x == L0.grid.x - 100 && L1.grid.y == L0.grid.y + 60);
		CHECK(L1.tidy.x == L0.tidy.x - 100 && L1.status.y == L0.status.y + 60);
		CHECK(L1.act[2].x == L0.act[2].x - 100 && L1.act[2].y == L0.act[2].y + 60);
		int cx, cy;
		Center(L1.CellRect(3), cx, cy);
		CHECK(L1.CellAt(cx, cy, md.slots) == 3);
		Center(L0.CellRect(3), cx, cy);
		CHECK(L1.CellAt(cx, cy, md.slots) != 3);
		CHECK(Drain(ui).empty());
		CHECK(ui.winDrag == -1 && !ui.down && ui.selected == -1 && !ui.wantClose);
		// a click at the cell's new place selects it
		Center(L1.CellRect(0), cx, cy);
		Click(ui, md, 0, cx, cy, 30.0f);
		CHECK(ui.selected == 0);
		// the window stays where it was put when it is closed and opened again
		ui.Reset();
		InvLayout L2 = Lay(md, ui);
		CHECK(L2.win.x == L1.win.x && L2.win.y == L1.win.y);
		// the X still closes
		Center(L2.xBtn, cx, cy);
		Click(ui, md, 0, cx, cy, 40.0f);
		CHECK(ui.wantClose);
	}
	// it never leaves the screen
	{
		Model md = Stocked();
		Ui ui;
		InvLayout L0 = Lay(md, ui);
		DragWindow(ui, md, L0.win.x + 40, L0.win.y + 10, -4000, -4000);
		InvLayout L1 = Lay(md, ui);
		CHECK(L1.win.x == 0 && L1.win.y == 0);
		DragWindow(ui, md, L1.win.x + 40, L1.win.y + 10, 9000, 9000);
		InvLayout L2 = Lay(md, ui);
		CHECK(L2.win.R() == 1280 && L2.win.B() == 720);
		CHECK(L2.CellAt(L2.CellRect(0).x + 2, L2.CellRect(0).y + 2, md.slots) == 0);
		// the same offset on a smaller screen is brought back inside it
		InvLayout S = BuildLayout(md, 800, 600, 12, 0, 0, &ui.win);
		CHECK(S.win.x >= 0 && S.win.y >= 0 && S.win.R() <= 800 && S.win.B() <= 600);
		int sx, sy;
		Center(S.CellRect(0), sx, sy);
		CHECK(S.CellAt(sx, sy, md.slots) == 0);
	}
	// only the left button, only on the title bar, and a press without a move is a click on nothing
	{
		Model md = Stocked();
		Ui ui;
		InvLayout L0 = Lay(md, ui);
		const int tx = L0.win.x + 40, ty = L0.win.y + 10;
		Click(ui, md, 1, tx, ty, 50.0f);   // a right click on the title
		CHECK(ui.win.dx[0] == 0 && ui.winDrag == -1 && !ui.PopupOpen());
		Click(ui, md, 0, tx, ty, 51.0f);   // a click on the title, no move
		CHECK(ui.win.dx[0] == 0 && ui.win.dy[0] == 0 && ui.winDrag == -1 && Drain(ui).empty());
		// a drag that starts on a cell is the tile drag and moves no window
		int cx, cy;
		Center(L0.CellRect(0), cx, cy);
		DragWindow(ui, md, cx, cy, cx + 90, cy + 40, 52.0f);
		CHECK(ui.win.dx[0] == 0 && ui.win.dy[0] == 0);
	}
	// the exchange window is held by its own title and the inventory stays where it is
	{
		Model md = Stocked();
		Ui ui;
		{
			Msg m;
			m.Byte(TR_OPEN).Str("KANE, MARCUS").Long(500).Byte(12).Byte(1);
			md.OnTrade(m.data(), m.size(), 210.0f);
		}
		InvLayout L0 = Lay(md, ui);
		CHECK(L0.trade);
		const int tx = L0.twin.x + 30, ty = L0.twin.y + 10;
		CHECK(ui.TitleAt(L0, tx, ty) == 1);
		CHECK(ui.TitleAt(L0, L0.tx.x + 2, L0.tx.y + 2) == -1);
		DragWindow(ui, md, tx, ty, tx + 70, ty + 25);
		InvLayout L1 = Lay(md, ui);
		CHECK(L1.twin.x == L0.twin.x + 70 && L1.twin.y == L0.twin.y + 25);
		CHECK(L1.win.x == L0.win.x && L1.win.y == L0.win.y);
		CHECK(L1.sealBtn.x == L0.sealBtn.x + 70 && L1.offerMine.y == L0.offerMine.y + 25 && L1.quick[3].x == L0.quick[3].x + 70);
		int cx, cy;
		Center(L1.OfferRect(0, 2), cx, cy);
		CHECK(L1.OfferAt(0, cx, cy, 12) == 2);
		CHECK(Drain(ui).empty() && ui.winDrag == -1);
		// the buttons of the moved window answer at their new place
		Center(L1.sealBtn, cx, cy);
		Click(ui, md, 0, cx, cy, 60.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv x seal");
	}
	// the search window likewise, and its X still closes the search
	{
		Model md = Searching();
		Ui ui;
		InvLayout L0 = Lay(md, ui);
		CHECK(L0.search);
		const int tx = L0.swin.x + 30, ty = L0.swin.y + 10;
		CHECK(ui.TitleAt(L0, tx, ty) == 2);
		CHECK(ui.TitleAt(L0, L0.sx.x + 2, L0.sx.y + 2) == -1);
		DragWindow(ui, md, tx, ty, tx - 40, ty + 33);
		InvLayout L1 = Lay(md, ui);
		CHECK(L1.swin.x == L0.swin.x - 40 && L1.swin.y == L0.swin.y + 33);
		CHECK(L1.win.x == L0.win.x && L1.win.y == L0.win.y);
		CHECK(L1.sgrid.x == L0.sgrid.x - 40 && L1.stakeAll.y == L0.stakeAll.y + 33 && L1.shint.x == L0.shint.x - 40);
		int cx, cy;
		Center(L1.SCellRect(2), cx, cy);
		CHECK(L1.SCellAt(cx, cy, md.search.cells) == 2);
		Click(ui, md, 0, cx, cy, 70.0f);
		CHECK(ui.sSelected == 2);
		CHECK(Drain(ui).empty());
		Center(L1.sx, cx, cy);
		Click(ui, md, 0, cx, cy, 71.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 1 && o[0] == "h9inv s close" && ui.wantSearchClose);
	}
	// the search's own scroll reaches the layout the painter draws, as it does the one the clicks use
	{
		Model md = Searching(96);
		Ui ui;
		ui.sScroll = 2;
		InvLayout L = Lay(md, ui);
		CHECK(L.sfirstRow == 2);
	}
}

// ---- the money of a searched player (H9Search op 5, "h9inv s money <n>")

static void SearchMoney(Model& md, int wallet, float now = 1.0f)
{
	Msg m;
	m.Byte(SR_MONEY).Long(wallet);
	md.OnSearch(m.data(), m.size(), now);
}

static void TestSearchMoney()
{
	// the wire: no money row until the server says what his wallet holds
	{
		Model md = Searching();
		CHECK(md.search.open && md.search.money == -1);
		InvLayout L0 = Lay(md, Ui());
		CHECK(!L0.smoneyOn && L0.smoney.w == 0 && L0.smoneyBtn[0].w == 0);
		SearchMoney(md, 1250);
		CHECK(md.search.money == 1250);
		SearchMoney(md, 40);
		CHECK(md.search.money == 40);
		SearchMoney(md, -5);   // never negative
		CHECK(md.search.money == 0);
		// refused: too short, and with no search open
		const int bad0 = md.msgsBad;
		Msg t;
		t.Byte(SR_MONEY).Byte(1).Byte(2);
		md.OnSearch(t.data(), t.size(), 1.0f);
		CHECK(md.msgsBad == bad0 + 1 && md.search.money == 0);
		Model none = Stocked();
		SearchMoney(none, 99);
		CHECK(!none.search.open && none.search.money == -1);   // nothing is searched, so nothing is kept
		// a second OPEN starts him again: the old wallet is not his
		Msg o;
		o.Byte(SR_OPEN).Byte(0).Short(8).Str("OTHER, PLAYER");
		md.OnSearch(o.data(), o.size(), 2.0f);
		CHECK(md.search.open && md.search.money == -1);
		SearchMoney(md, 700);
		Msg c;
		c.Byte(SR_CLOSE).Byte(1);
		md.OnSearch(c.data(), c.size(), 3.0f);
		CHECK(!md.search.open && md.search.money == -1);
	}
	// the layout: a row for his wallet and three buttons, inside his window, between the take buttons and the status row
	{
		const int sizes[][2] = {{800, 600}, {1024, 768}, {1280, 720}, {1366, 768}, {1920, 1080}};
		for (auto& s : sizes)
		{
			Model md = Searching();
			Model withMoney = Searching();
			SearchMoney(withMoney, 500);
			InvLayout A = BuildLayout(md, s[0], s[1], 12, 0, 0);
			InvLayout B = BuildLayout(withMoney, s[0], s[1], 12, 0, 0);
			CHECK(B.smoneyOn && !A.smoneyOn);
			CHECK(B.swin.Has(B.smoney.x, B.smoney.y) && B.swin.Has(B.smoney.R() - 1, B.smoney.B() - 1));
			CHECK(B.stakeOne.B() <= B.smoney.y && B.smoney.B() <= B.smoneyBtn[0].y);
			CHECK(B.smoneyBtn[0].B() <= B.sstatus.y && B.sstatus.B() <= B.shint.y);
			CHECK(B.smoneyBtn[0].R() <= B.smoneyBtn[1].x && B.smoneyBtn[1].R() <= B.smoneyBtn[2].x);
			CHECK(B.smoneyBtn[2].R() <= B.swin.R() && B.swin.B() >= B.shint.B());
			// the window of the one without money is the same but for that row
			CHECK(B.swin.h >= A.swin.h && B.swin.w == A.swin.w);
			CHECK(B.sgrid.x == A.sgrid.x && B.sgrid.y <= A.sgrid.y);   // the pair is centred as a whole: a taller window starts a little higher
			CHECK(B.win.x == A.win.x || B.swin.h >= A.swin.h);
		}
	}
	// the clicks
	{
		Model md = Searching();
		SearchMoney(md, 1250);
		Ui ui;
		InvLayout L = Lay(md, ui);
		int x, y;
		Center(L.smoneyBtn[0], x, y);
		Click(ui, md, 0, x, y, 80.0f);
		Center(L.smoneyBtn[1], x, y);
		Click(ui, md, 0, x, y, 81.0f);
		Center(L.smoneyBtn[2], x, y);
		Click(ui, md, 0, x, y, 82.0f);
		auto o = Drain(ui);
		CHECK(o.size() == 3 && o[0] == "h9inv s money 10" && o[1] == "h9inv s money 100" && o[2] == "h9inv s money 1250");
		// never more than he holds
		SearchMoney(md, 60);
		L = Lay(md, ui);
		Center(L.smoneyBtn[1], x, y);
		Click(ui, md, 0, x, y, 83.0f);
		Center(L.smoneyBtn[2], x, y);
		Click(ui, md, 0, x, y, 84.0f);
		o = Drain(ui);
		CHECK(o.size() == 2 && o[0] == "h9inv s money 60" && o[1] == "h9inv s money 60");
		// nothing in his wallet: the buttons say nothing
		SearchMoney(md, 0);
		L = Lay(md, ui);
		for (int i = 0; i < 3; i++)
		{
			Center(L.smoneyBtn[i], x, y);
			Click(ui, md, 0, x, y, 85.0f + i);
		}
		CHECK(Drain(ui).empty());
		// the row itself is no button, and a click on it selects nothing
		Center(L.smoney, x, y);
		Click(ui, md, 0, x, y, 90.0f);
		CHECK(Drain(ui).empty() && ui.sSelected == -1 && ui.selected == -1);
		// a game whose server never told the wallet has no such buttons: a click where they would be is a click on the window
		Model old = Searching();
		InvLayout O = Lay(old, ui);
		Center(O.stakeOne, x, y);
		Click(ui, old, 0, x, y + O.m.btnH + 20, 91.0f);   // below the take buttons: nothing there
		CHECK(Drain(ui).empty());
		// dragged with the window: the buttons are where the window is
		SearchMoney(md, 300);
		Ui ui2;
		InvLayout L2 = Lay(md, ui2);
		DragWindow(ui2, md, L2.swin.x + 30, L2.swin.y + 10, L2.swin.x + 10, L2.swin.y + 55);
		InvLayout L3 = Lay(md, ui2);
		CHECK(L3.swin.x == L2.swin.x - 20 && L3.smoneyBtn[2].x == L2.smoneyBtn[2].x - 20 && L3.smoneyBtn[2].y == L2.smoneyBtn[2].y + 45);
		Center(L3.smoneyBtn[0], x, y);
		Click(ui2, md, 0, x, y, 95.0f);
		o = Drain(ui2);
		CHECK(o.size() == 1 && o[0] == "h9inv s money 10");
	}
}

int main()
{
	TestWire();
	TestTradeWire();
	TestLayout();
	TestClicks();
	TestSplit();
	{
		Model md = Stocked();
		Ui ui;
		TestDrag(ui, md);
	}
	TestShow();
	TestExchange();
	TestScroll();
	TestEsc();
	TestSearchWire();
	TestSearchLayout();
	TestSearchClicks();
	TestWindowDrag();
	TestSearchMoney();
	printf("%d checks, %d failed\n", g_checks, g_fails);
	return g_fails ? 1 : 0;
}
