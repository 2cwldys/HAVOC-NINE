// Tests of the ARP context menu's model, clicks and layout (h9_arpctx_model.h, h9_arpctx_ui.h). They need no game:
//   cl /std:c++17 /EHsc /I.. test_arpctx.cpp && test_arpctx.exe [<file of messages as hex, one a line>]
// (g++ -std=c++17 -I.. test_arpctx.cpp works too). Exit 0: every check passed.
// With a file of messages (the server's test run writes one: what ARP_H9Ctx really sent) the model reads them in order and prints the menu it ends with.
#include "../h9_arpctx_ui.h"

#include <stdio.h>
#include <string>
#include <vector>

using namespace arpctx;

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

// ---- message builders, written from docs\ARP_INVENTORY.txt 10 only
struct Msg
{
	std::vector<unsigned char> b;
	Msg& Byte(int v) { b.push_back((unsigned char)v); return *this; }
	Msg& Str(const char* s) { for (; *s; s++) b.push_back((unsigned char)*s); b.push_back(0); return *this; }
	const void* data() const { return b.data(); }
	int size() const { return (int)b.size(); }
};

static Msg Open(int serial, int flags, int page, int rows, const char* title, const char* sub = "")
{
	Msg m;
	m.Byte(1).Byte(serial).Byte(flags).Byte(page).Byte(rows).Str(title).Str(sub);
	return m;
}
struct RowDef
{
	int flags, key;
	const char* label;
	const char* note;
};
static Msg Rows(int serial, int first, const std::vector<RowDef>& rows)
{
	Msg m;
	m.Byte(2).Byte(serial).Byte(first).Byte((int)rows.size());
	for (const RowDef& r : rows)
		m.Byte(r.flags).Byte(r.key).Str(r.label).Str(r.note);
	return m;
}
static Msg Close(int serial, int reason)
{
	Msg m;
	m.Byte(3).Byte(serial).Byte(reason);
	return m;
}
static Msg Note(int serial, int level, const char* text)
{
	Msg m;
	m.Byte(4).Byte(serial).Byte(level).Str(text);
	return m;
}
static bool Feed(Model& md, const Msg& m, float now = 1.0f)
{
	return md.OnMessage(m.data(), m.size(), now);
}

static const std::vector<RowDef> kMain = {
	{F_ON, 1, "Trade", ""},
	{0, 2, "Search", "Cuff him first"},
	{F_ON, 3, "Cuff", "uses Cuffs"},
	{F_ON | F_MORE, 4, "Give money", ""},
	{F_ON | F_RED, 5, "Fine", ""},
	{F_ON | F_GAP, 10, "Back", ""},
};

static void Fill(Model& md, int serial = 7, float now = 1.0f)
{
	Feed(md, Open(serial, 0, 0, (int)kMain.size(), "Voss, Adrian", "to be shown"), now);
	Feed(md, Rows(serial, 0, kMain), now);
}

static IRect Safe(int sw, int sh)
{
	return IRect(0, sh * 136 / 480, sw, sh - sh * 136 / 480 - sh * 90 / 480);
}

// ---- the model -------------------------------------------------------------------------------------------------------------------------
static void TestParse()
{
	Model md;
	CHECK(!md.open);
	CHECK(Feed(md, Open(7, 0, 0, 6, "Voss, Adrian", "to be shown")));
	CHECK(md.open);
	CHECK(md.serial == 7);
	CHECK(md.numRows == 0);
	CHECK(Feed(md, Rows(7, 0, kMain)));
	CHECK(md.numRows == 6);
	CHECK_STR(md.title, "Voss, Adrian");
	CHECK_STR(md.sub, "to be shown");
	CHECK_STR(md.rows[0].label, "Trade");
	CHECK(md.rows[0].On());
	CHECK(!md.rows[1].On());
	CHECK_STR(md.rows[1].note, "Cuff him first");
	CHECK((md.rows[3].flags & F_MORE) != 0);
	CHECK((md.rows[4].flags & F_RED) != 0);
	CHECK((md.rows[5].flags & F_GAP) != 0);
	CHECK(md.rows[5].key == 10);
	CHECK(md.RowOfKey(1) == 0);
	CHECK(md.RowOfKey(10) == 5);
	CHECK(md.RowOfKey(9) == -1);
	CHECK(md.msgsBad == 0);

	// rows in two messages
	Model m2;
	Feed(m2, Open(9, 0, 0, 6, "A"));
	std::vector<RowDef> first(kMain.begin(), kMain.begin() + 3), second(kMain.begin() + 3, kMain.end());
	CHECK(Feed(m2, Rows(9, 0, first)));
	CHECK(m2.numRows == 3);
	CHECK(Feed(m2, Rows(9, 3, second)));
	CHECK(m2.numRows == 6);
	CHECK_STR(m2.rows[5].label, "Back");

	// the second message must continue where the first ended
	Model m3;
	Feed(m3, Open(9, 0, 0, 6, "A"));
	CHECK(!Feed(m3, Rows(9, 2, second)));
	CHECK(m3.numRows == 0);
	CHECK(m3.msgsBad == 1);
}

static void TestRefreshAndPages()
{
	Model md;
	Fill(md, 7, 1.0f);
	md.SetStatus("Not now.", 1, 1.0f);
	// a refresh: the same menu, the rows replaced, the open time kept
	Feed(md, Open(7, 1, 0, 2, "Voss, Adrian"), 5.0f);
	CHECK(md.open && md.refreshed && md.serial == 7);
	CHECK(md.openedAt == 1.0f);
	CHECK(md.numRows == 0);
	Feed(md, Rows(7, 0, {{F_ON, 1, "Trade", ""}, {0, 2, "Search", "He is busy"}}), 5.0f);
	CHECK(md.numRows == 2);
	CHECK_STR(md.status, "Not now.");
	// a new page: a new serial, a new menu
	Feed(md, Open(8, 0, 1, 2, "Fine", "Voss"), 6.0f);
	CHECK(md.open && !md.refreshed && md.serial == 8 && md.page == 1);
	CHECK(md.openedAt == 6.0f);
	CHECK(md.status[0] == 0);
	// a refresh of a serial that is not the one up is a new menu
	Feed(md, Open(9, 1, 0, 1, "X"), 7.0f);
	CHECK(md.serial == 9 && !md.refreshed);
	// rows of another menu are not taken
	CHECK(!Feed(md, Rows(8, 0, {{F_ON, 1, "A", ""}})));
	CHECK(md.numRows == 0);
}

static void TestCloseAndNote()
{
	Model md;
	Fill(md, 7);
	CHECK(!Feed(md, Close(8, 3)));
	CHECK(md.open);
	CHECK(Feed(md, Close(7, 3)));
	CHECK(!md.open);
	CHECK(md.lastClose == 3);
	CHECK(!Feed(md, Close(7, 3))); // nothing is up

	Fill(md, 7);
	CHECK(Feed(md, Close(0, 1))); // 0 closes whatever is up
	CHECK(!md.open);

	Fill(md, 7);
	CHECK(Feed(md, Note(7, 1, "He is busy."), 2.0f));
	CHECK_STR(md.status, "He is busy.");
	CHECK(md.statusLevel == 1);
	CHECK(md.HasStatus(3.0f));
	CHECK(!md.HasStatus(2.0f + STATUS_SECONDS + 0.1f));
	CHECK(!Feed(md, Note(8, 1, "Other."), 2.0f));
	CHECK_STR(md.status, "He is busy.");
	md.Clear();
	CHECK(!Feed(md, Note(7, 1, "Nobody."), 2.0f));
}

static void TestHostile()
{
	Model md;
	// too big
	std::vector<unsigned char> big(300, 1);
	CHECK(!md.OnMessage(big.data(), (int)big.size(), 1.0f));
	CHECK(md.msgsBad == 1);
	CHECK(!md.OnMessage(nullptr, 0, 1.0f));
	CHECK(!md.OnMessage("\x00", 1, 1.0f));
	CHECK(!md.OnMessage("\x63", 1, 1.0f));
	// a serial of 0, an OPEN cut short, a string with no end
	CHECK(!Feed(md, Open(0, 0, 0, 1, "A")));
	CHECK(!md.OnMessage("\x01\x05\x00\x00\x02" "abc", 8, 1.0f));
	CHECK(!md.open);
	// more rows than the client holds, and a key out of range
	std::vector<RowDef> many;
	for (int i = 0; i < 20; i++)
		many.push_back({F_ON, 99, "R", "n"});
	Feed(md, Open(3, 0, 0, 20, "T"));
	Feed(md, Rows(3, 0, many));
	CHECK(md.numRows == ROWS_MAX);
	CHECK(md.rows[0].key == 0);
	// long strings are cut, control bytes and bytes above 126 are question marks, the credit sign stays
	std::string longLabel(80, 'x');
	Model m2;
	Feed(m2, Open(4, 0, 0, 1, std::string(80, 'T').c_str(), std::string(80, 'S').c_str()));
	Feed(m2, Rows(4, 0, {{F_ON, 1, longLabel.c_str(), "a\x01z\xC3\xA9\xA2" "9"}}));
	CHECK((int)strlen(m2.title) == TITLE_LEN - 1);
	CHECK((int)strlen(m2.rows[0].label) == LABEL_LEN - 1);
	CHECK_STR(m2.rows[0].note, std::string("a?z??") + "\xA2" + "9");
	// the number of rows an OPEN announces bounds the rows taken
	Model m3;
	Feed(m3, Open(5, 0, 0, 2, "T"));
	Feed(m3, Rows(5, 0, {{F_ON, 1, "a", ""}, {F_ON, 2, "b", ""}, {F_ON, 3, "c", ""}}));
	CHECK(m3.numRows == 2);
	// a thousand random messages, and the model holds together
	unsigned seed = 12345;
	auto rnd = [&]() { seed = seed * 1664525u + 1013904223u; return (int)((seed >> 16) & 255); };
	Model m4;
	Feed(m4, Open(1, 0, 0, 3, "T"));
	for (int n = 0; n < 20000; n++)
	{
		unsigned char buf[200];
		const int len = rnd() % 190 + 1;
		for (int i = 0; i < len; i++)
			buf[i] = (unsigned char)rnd();
		if (n % 3 == 0)
			buf[0] = (unsigned char)(1 + rnd() % 4);
		if (n % 7 == 0 && len > 1)
			buf[1] = 1;
		m4.OnMessage(buf, len, (float)n);
		CHECK(m4.numRows >= 0 && m4.numRows <= ROWS_MAX);
		CHECK(m4.title[TITLE_LEN - 1] == 0 && m4.sub[TITLE_LEN - 1] == 0);
		if (!m4.open)
			Feed(m4, Open(1, 0, 0, 3, "T"));
	}
}

// ---- the clicks ------------------------------------------------------------------------------------------------------------------------
static CtxLayout LayoutOf(const Model& md, int sw = 1024, int sh = 768, float scale = 1.0f)
{
	return BuildLayout(md, sw, sh, 19, scale, Safe(sw, sh), true);
}

static void TestClicks()
{
	Model md;
	Fill(md, 7);
	Ui ui;
	CtxLayout L = LayoutOf(md);
	// a click on an enabled row chooses it
	const IRect r0 = L.row[0];
	CHECK(ui.MouseDown(md, L, 0, r0.x + 20, r0.y + 5, 2.0f));
	CHECK(ui.nout == 1);
	CHECK_STR(ui.out[0], "h9ctx pick 7 0");
	CHECK(!ui.wantClose);
	// a click on a greyed row says why, and sends nothing
	ui.Reset();
	const IRect r1 = L.row[1];
	ui.MouseDown(md, L, 0, r1.x + 20, r1.y + 5, 2.0f);
	CHECK(ui.nout == 0);
	CHECK_STR(md.status, "Cuff him first");
	CHECK(md.statusLevel == 1);
	CHECK(md.HasStatus(3.0f));
	// a click on the heading does nothing
	ui.Reset();
	md.status[0] = 0;
	ui.MouseDown(md, L, 0, L.title.x + 20, L.title.y + 3, 2.0f);
	CHECK(ui.nout == 0 && !ui.wantClose && md.status[0] == 0);
	// a click outside the panel closes the menu
	ui.MouseDown(md, L, 0, L.panel.x - 10, L.panel.y + 4, 2.0f);
	CHECK(ui.wantClose);
	CHECK_STR(ui.out[0], "h9ctx close 7");
	// a right click, anywhere, closes it
	ui.Reset();
	ui.MouseDown(md, L, 1, r0.x + 20, r0.y + 5, 2.0f);
	CHECK(ui.wantClose && ui.nout == 1);
	CHECK_STR(ui.out[0], "h9ctx close 7");
	// a button that is neither is the menu's and does nothing
	ui.Reset();
	CHECK(ui.MouseDown(md, L, 2, r0.x + 20, r0.y + 5, 2.0f));
	CHECK(ui.nout == 0 && !ui.wantClose);
	// a menu that is not up takes nothing
	Model closed;
	ui.Reset();
	CHECK(!ui.MouseDown(closed, L, 0, 10, 10, 2.0f));
	CHECK(ui.nout == 0);
	// hover follows the mouse, and only over a row
	ui.Reset();
	ui.MouseMove(md, L, r1.x + 4, r1.y + 4);
	CHECK(ui.hover == 1);
	ui.MouseMove(md, L, L.panel.x - 5, r1.y);
	CHECK(ui.hover == -1);
	// the commands queued are bounded
	ui.Reset();
	for (int i = 0; i < 10; i++)
		ui.MouseDown(md, L, 0, r0.x + 20, r0.y + 5, 2.0f);
	CHECK(ui.nout == 4);
}

static void TestKeys()
{
	Model md;
	Fill(md, 7);
	Ui ui;
	// a number with an enabled row
	CHECK(ui.Key(md, IK_DIGIT, 3, 2.0f));
	CHECK(ui.nout == 1);
	CHECK_STR(ui.out[0], "h9ctx pick 7 2");
	// the 0 key is the row with key 10
	ui.Reset();
	CHECK(ui.Key(md, IK_DIGIT, 0, 2.0f));
	CHECK_STR(ui.out[0], "h9ctx pick 7 5");
	// a number with a greyed row says why
	ui.Reset();
	CHECK(ui.Key(md, IK_DIGIT, 2, 2.0f));
	CHECK(ui.nout == 0);
	CHECK_STR(md.status, "Cuff him first");
	// a number with no row is the menu's all the same, and sends nothing
	ui.Reset();
	md.status[0] = 0;
	CHECK(ui.Key(md, IK_DIGIT, 9, 2.0f));
	CHECK(ui.nout == 0 && md.status[0] == 0);
	// ESC closes
	ui.Reset();
	CHECK(ui.Key(md, IK_ESC, 0, 2.0f));
	CHECK(ui.wantClose);
	CHECK_STR(ui.out[0], "h9ctx close 7");
	// the wheel is taken and does nothing; another key is not taken
	ui.Reset();
	CHECK(ui.Key(md, IK_WHEEL, 0, 2.0f));
	CHECK(ui.nout == 0);
	CHECK(!ui.Key(md, IK_NONE, 0, 2.0f));
	// a menu that is not up takes no key
	Model closed;
	CHECK(!ui.Key(closed, IK_DIGIT, 1, 2.0f));
	CHECK(!ui.Key(closed, IK_ESC, 0, 2.0f));
}

// ---- the layout ------------------------------------------------------------------------------------------------------------------------
static void TestLayout()
{
	static const int screens[][2] = {{640, 480}, {800, 600}, {1024, 768}, {1280, 720}, {1280, 1024}, {1920, 1080}, {2560, 1080}, {3840, 2160}};
	static const float scales[] = {0.5f, 1.0f, 1.5f, 2.0f};
	Model md;
	Fill(md, 7);
	for (const auto& s : screens)
	{
		for (float f : scales)
		{
			const int sw = s[0], sh = s[1];
			const IRect safe = Safe(sw, sh);
			const CtxLayout L = BuildLayout(md, sw, sh, 19, f, safe, true);
			// inside the safe area, and at most half the screen wide
			CHECK(L.panel.x >= safe.x && L.panel.R() <= safe.R());
			CHECK(L.panel.y >= safe.y && L.panel.B() <= safe.B());
			CHECK(L.panel.w <= sw / 2 || L.panel.w <= 230);
			// right of the crosshair, its middle near its height
			CHECK(L.panel.x > sw / 2);
			CHECK(L.panel.y <= sh / 2 && L.panel.B() >= sh / 2);
			// the rows are inside the panel, in order, not touching
			CHECK(L.n == md.numRows);
			for (int i = 0; i < L.n; i++)
			{
				CHECK(L.row[i].x >= L.panel.x && L.row[i].R() <= L.panel.R());
				CHECK(L.row[i].y >= L.title.B() && L.row[i].B() <= L.panel.B());
				if (i > 0)
					CHECK(L.row[i].y >= L.row[i - 1].B());
			}
			// a gap before the last row
			CHECK(L.row[5].y - L.row[4].B() >= L.m.rowH / 2);
			// every point of a row finds that row
			CHECK(L.RowAt(L.row[2].x + 5, L.row[2].y + 2) == 2);
			CHECK(L.RowAt(L.panel.x - 3, L.row[2].y) == -1);
		}
	}
	// the scale moves the rows
	const CtxLayout a = LayoutOf(md, 1024, 768, 0.5f), b = LayoutOf(md, 1024, 768, 2.0f);
	CHECK(b.m.rowH > a.m.rowH);
	CHECK(b.panel.h > a.panel.h);

	// a screen too narrow for the panel on the right puts it on the left of the crosshair
	Model wide;
	Feed(wide, Open(2, 0, 0, 1, "A very long heading of a character name"));
	Feed(wide, Rows(2, 0, {{F_ON, 1, "A row with a label of some length", "and a note that is long as well"}}));
	const CtxLayout n = BuildLayout(wide, 640, 480, 19, 1.0f, Safe(640, 480), true);
	CHECK(n.panel.R() <= 640);
	CHECK(n.panel.x < 320);

	// twelve rows still fit a small screen
	Model full;
	Feed(full, Open(3, 0, 0, 12, "Twelve"));
	std::vector<RowDef> twelve;
	for (int i = 0; i < 12; i++)
		twelve.push_back({F_ON, i < 9 ? i + 1 : (i == 9 ? 10 : 0), "Row", ""});
	Feed(full, Rows(3, 0, twelve));
	CHECK(full.numRows == 12);
	const CtxLayout t = BuildLayout(full, 640, 480, 19, 1.0f, Safe(640, 480), true);
	CHECK(t.panel.y >= 0 && t.panel.B() <= 480);
	CHECK(t.row[11].B() <= t.panel.B());
	// and the menu of the rows of the first page fits the safe area of that screen at every scale
	for (float f : scales)
	{
		const CtxLayout q = BuildLayout(md, 640, 480, 19, f, Safe(640, 480), true);
		CHECK(q.panel.y >= Safe(640, 480).y && q.panel.B() <= Safe(640, 480).B());
	}
}

// ---- the drawing -----------------------------------------------------------------------------------------------------------------------
struct Op
{
	char kind;
	int x, y, w, h, r, g, b, a;
	int maxX;
	std::string text;
};
struct Rec : CtxCanvas
{
	int w, h;
	std::vector<Op> ops;
	Rec(int W, int H) : w(W), h(H) {}
	void Fill(int x, int y, int fw, int fh, int r, int g, int b, int a) override { ops.push_back({'f', x, y, fw, fh, r, g, b, a, 0, ""}); }
	void Text(int x, int y, int maxX, const char* s, int r, int g, int b) override { ops.push_back({'t', x, y, 0, 0, r, g, b, 255, maxX, s}); }
	int TextW(const char* s) override { return arpctx::TextW(s); }
	int CharH() override { return 19; }
	int Width() override { return w; }
	int Height() override { return h; }
};

static int CountText(const Rec& r, const char* text)
{
	int n = 0;
	for (const Op& o : r.ops)
		if (o.kind == 't' && o.text == text)
			n++;
	return n;
}

static void TestPaint()
{
	Model md;
	Fill(md, 7);
	Ui ui;
	Rec rec(1024, 768);
	Painter p(rec, md, ui, 2.0f, Safe(1024, 768), 1.0f);
	p.DrawAll();
	CHECK(CountText(rec, "Trade") == 1);
	CHECK(CountText(rec, "Search") == 1);
	CHECK(CountText(rec, "Cuff him first") == 1);
	CHECK(CountText(rec, "VOSS, ADRIAN") == 2); // drawn twice: the heading is bold
	CHECK(CountText(rec, "TO BE SHOWN") == 1);
	// a greyed row is not drawn in the colour of an enabled one
	int searchR = -1, tradeR = -1;
	for (const Op& o : rec.ops)
	{
		if (o.kind == 't' && o.text == "Search")
			searchR = o.r;
		if (o.kind == 't' && o.text == "Trade")
			tradeR = o.r;
	}
	CHECK(searchR == OFF.r && tradeR == TXT.r);
	// a red row is red
	for (const Op& o : rec.ops)
		if (o.kind == 't' && o.text == "Fine")
			CHECK(o.r == BAD.r && o.g == BAD.g);
	// nothing is drawn right of the panel, and no text is cut at a place right of it
	for (const Op& o : rec.ops)
	{
		if (o.kind == 't')
			CHECK(o.maxX <= p.L.panel.R() + 1);
		if (o.kind == 'f')
			CHECK(o.x + o.w <= p.L.panel.R() && o.y + o.h <= p.L.panel.B() + 1 && o.x >= p.L.panel.x);
	}
	// the hint, until a status replaces it
	CHECK(CountText(rec, "Click or press the number. ESC closes.") == 1);
	md.SetStatus("He is busy.", 1, 2.0f);
	Rec rec2(1024, 768);
	Painter p2(rec2, md, ui, 2.5f, Safe(1024, 768), 1.0f);
	p2.DrawAll();
	CHECK(CountText(rec2, "He is busy.") == 1);
	CHECK(CountText(rec2, "Click or press the number. ESC closes.") == 0);
	// the hovered enabled row has the band under it, a greyed one has none
	auto bands = [&](int hover) {
		Ui u;
		u.hover = hover;
		Rec r(1024, 768);
		Painter pp(r, md, u, 2.0f, Safe(1024, 768), 1.0f);
		pp.DrawAll();
		int n = 0;
		for (const Op& o : r.ops)
			if (o.kind == 'f' && o.r == BAND.r && o.g == BAND.g && o.b == BAND.b)
				n++;
		return n;
	};
	CHECK(bands(-1) == 0);
	CHECK(bands(0) == 1);
	CHECK(bands(1) == 0);
	// a menu that is closed draws nothing
	Model off;
	Rec rec3(1024, 768);
	Painter p3(rec3, off, ui, 2.0f, Safe(1024, 768), 1.0f);
	p3.DrawAll();
	CHECK(rec3.ops.empty());
	// the credit sign is drawn as the byte it is
	Model cs;
	Feed(cs, Open(2, 0, 0, 1, "T"));
	Feed(cs, Rows(2, 0, {{F_ON, 1, "\xA2" "100", ""}}));
	Rec rec4(1024, 768);
	Painter p4(rec4, cs, ui, 2.0f, Safe(1024, 768), 1.0f);
	p4.DrawAll();
	CHECK(CountText(rec4, "\xA2" "100") == 1);
}

static void TestDemo()
{
	Model md;
	DemoMenu(md, 3.0f);
	CHECK(md.open && md.numRows == 8 && md.announced == 8);
	CHECK_STR(md.rows[0].label, "Trade");
	CHECK(md.rows[0].On() && !md.rows[1].On());
	CHECK(md.rows[7].key == 8);
	const CtxLayout L = LayoutOf(md);
	CHECK(L.n == 8 && L.panel.x > 512);
}

// ---- the server's own messages -----------------------------------------------------------------------------------------------------------
static int FromHex(const char* s)
{
	auto v = [](char c) { return c >= '0' && c <= '9' ? c - '0' : (c >= 'a' && c <= 'f' ? c - 'a' + 10 : (c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1)); };
	return v(s[0]) < 0 || v(s[1]) < 0 ? -1 : v(s[0]) * 16 + v(s[1]);
}

// A file of messages as hex, a line each ("R|<player>|<hex>" lines as the test run writes them are read too): fed in order to one model; the menu it ends with is printed.
static void ReadWire(const char* path)
{
	FILE* f = fopen(path, "rb");
	if (!f)
	{
		printf("SKIP the wire file %s: it cannot be read\n", path);
		return;
	}
	Model md;
	char line[1024];
	int n = 0, bad = 0;
	while (fgets(line, sizeof(line), f))
	{
		std::string s(line);
		while (!s.empty() && (s.back() == '\n' || s.back() == '\r'))
			s.pop_back();
		if (s.empty())
			continue;
		const size_t bar = s.rfind('|');
		if (bar != std::string::npos)
			s = s.substr(bar + 1);
		std::vector<unsigned char> b;
		for (size_t i = 0; i + 1 < s.size(); i += 2)
		{
			const int v = FromHex(s.c_str() + i);
			if (v < 0)
				break;
			b.push_back((unsigned char)v);
		}
		const int before = md.msgsBad;
		md.OnMessage(b.data(), (int)b.size(), (float)n);
		if (md.msgsBad != before)
			bad++;
		n++;
	}
	fclose(f);
	CHECK(n > 0);
	CHECK(bad == 0);
	printf("WIRE %d message(s), %d refused; open=%d serial=%d page=%d title=\"%s\" sub=\"%s\" rows=%d\n", n, bad, md.open ? 1 : 0, md.serial, md.page, md.title, md.sub, md.numRows);
	for (int i = 0; i < md.numRows; i++)
		printf("WIRE ROW %d key=%d flags=%d label=\"%s\" note=\"%s\"\n", i, md.rows[i].key, md.rows[i].flags, md.rows[i].label, md.rows[i].note);
}

// ---- the hooks in the client's own sources -----------------------------------------------------------------------------------------------
static std::string ReadFile(const char* path)
{
	FILE* f = fopen(path, "rb");
	if (!f)
		return std::string();
	std::string s;
	char buf[8192];
	size_t got;
	while ((got = fread(buf, 1, sizeof(buf), f)) > 0)
		s.append(buf, got);
	fclose(f);
	return s;
}

static void TestHooks()
{
	const std::string hud = ReadFile("../hud.cpp"), vp = ReadFile("../vgui_TeamFortressViewport.cpp"), in = ReadFile("../inputw32.cpp"), vg = ReadFile("../h9_vgui.cpp"),
		vgh = ReadFile("../h9_vgui.h"), ctx = ReadFile("../h9_arpctx.cpp"), cm = ReadFile("../CMakeLists.txt"), invc = ReadFile("../h9_arpinv.cpp");
	if (hud.empty() || vp.empty() || in.empty() || vg.empty() || ctx.empty())
	{
		printf("SKIP the hooks: the client sources are not beside the tests\n");
		return;
	}
	auto fn = [&](const std::string& text, const char* head) {
		const size_t at = text.find(head);
		if (at == std::string::npos)
			return std::string();
		const size_t end = text.find("\n}\n", at);
		return text.substr(at, end == std::string::npos ? std::string::npos : end - at);
	};
	// CHud::Init and CHud::VidInit name the menu (the HUD elements are not members; tests\check_vidinit.py says the same)
	const std::string init = fn(hud, "void CHud::Init()"), vid = fn(hud, "void CHud::VidInit()");
	CHECK(init.find("H9ArpCtx_Init();") != std::string::npos);
	CHECK(vid.find("H9ArpCtx_VidInit();") != std::string::npos);
	// the cursor, the keys (before the inventory's) and the mouse buttons (before the inventory's)
	CHECK(vp.find("H9ArpInv_IsUp() || H9ArpCtx_IsUp()") != std::string::npos);
	const size_t kc = vp.find("H9ArpCtx_KeyInput(down, keynum)"), ki = vp.find("H9ArpInv_KeyInput(down, keynum)");
	CHECK(kc != std::string::npos && ki != std::string::npos && kc < ki);
	const size_t mc = in.find("H9ArpCtx_HandleMouse(mstate)"), mi = in.find("H9ArpInv_HandleMouse(mstate)");
	CHECK(mc != std::string::npos && mi != std::string::npos && mc < mi);
	CHECK(in.find("else if (H9ArpInv_IsUp() && !TS_VGUIMenuUp())") != std::string::npos);
	// the protocol: 10 with the menu, 9 without it, 5 without the inventory window
	CHECK(vgh.find("#define H9V_PROTOCOL 10") != std::string::npos);
	CHECK(vgh.find("#define H9V_PROTOCOL_NO_CTXMENU 9") != std::string::npos);
	CHECK(vg.find("H9ArpCtx_Wanted() ? H9V_PROTOCOL : H9V_PROTOCOL_NO_CTXMENU") != std::string::npos);
	CHECK(vg.find("H9V_PROTOCOL_NO_INVENTORY") != std::string::npos);
	// the element's VidInit does something, and the bridge calls it
	CHECK(ctx.find("bool VidInit() override") != std::string::npos && ctx.find("void H9ArpCtx_VidInit()") != std::string::npos && ctx.find("s_Hud.VidInit();") != std::string::npos);
	// the files are in the build
	CHECK(cm.find("h9_arpctx.cpp") != std::string::npos && cm.find("h9_arpctx_ui.h") != std::string::npos && cm.find("h9_arpctx_model.h") != std::string::npos);
	// the inventory window gives the mouse state back
	CHECK(invc.find("void H9ArpInv_SyncMouse(int buttons)") != std::string::npos);
	// the message and the commands the plugin and the client agree on
	CHECK(ctx.find("\"H9Ctx\"") != std::string::npos);
	CHECK(ctx.find("\"h9ctx close %d\"") != std::string::npos);
	const std::string ui = ReadFile("../h9_arpctx_ui.h");
	CHECK(ui.find("\"h9ctx pick %d %d\"") != std::string::npos && ui.find("\"h9ctx close %d\"") != std::string::npos);
}

int main(int argc, char** argv)
{
	// the game's HUD font is about 6 pixels a character on average; the engine part gives the layout its real widths
	arpctx::g_textW = [](const char* s) { return (int)strlen(s) * 6; };
	TestParse();
	TestRefreshAndPages();
	TestCloseAndNote();
	TestHostile();
	TestClicks();
	TestKeys();
	TestLayout();
	TestPaint();
	TestDemo();
	TestHooks();
	if (argc > 1)
		ReadWire(argv[1]);
	printf("%d checks, %d failed\n", g_checks, g_fails);
	return g_fails ? 1 : 0;
}
