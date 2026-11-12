// Draws the ARP inventory and exchange windows for a few situations and screens into a list of drawing operations (one JSON file each), which
// tools\render_arpinv.py turns into pictures. It uses the very InvPainter the game draws with, over a canvas that records instead of drawing:
//   cl /std:c++17 /EHsc /I.. render_arpinv.cpp && render_arpinv.exe <output folder>
#include "../h9_arpinv_draw.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

using namespace arpinv;

// sprites/h9_arpicons.txt as the game reads it: an item's name, a bar, the frame
static std::vector<std::pair<std::string, int>> g_icons;
static void LoadIcons()
{
	const char* path = getenv("ARPICONS_TXT");
	FILE* f = fopen(path ? path : "D:/Downloads/TSM/modelling/arpicons/out/h9_arpicons.txt", "rb");
	if (!f)
		return;
	char line[160];
	while (fgets(line, sizeof(line), f))
	{
		char* bar = strchr(line, '|');
		if (!bar || line[0] == '#')
			continue;
		*bar = 0;
		g_icons.push_back(std::make_pair(std::string(line), atoi(bar + 1)));
	}
	fclose(f);
}

// The HUD font of the game, the engine's creditsfont (valve/gfx.wad, lump CREDITSFONT: 19 pixels high, a width for each character): the scenes that say
// "real font" measure and cut text with it, so that what fits in the picture is what fits in the game. Without the file the font is 8 pixels wide and 12 high.
static int g_fontW[256];
static int g_fontH = 0;
static bool LoadGameFont()
{
	const char* env = getenv("ARP_GFXWAD");
	const char* const tries[2] = {env, "D:/Downloads/TSM/H9XASH/valve/gfx.wad"};
	for (int t = 0; t < 2; t++)
	{
		FILE* f = tries[t] ? fopen(tries[t], "rb") : nullptr;
		if (!f)
			continue;
		std::vector<unsigned char> b;
		unsigned char buf[8192];
		size_t got;
		while ((got = fread(buf, 1, sizeof(buf), f)) > 0)
			b.insert(b.end(), buf, buf + got);
		fclose(f);
		auto i32 = [&](size_t o) { return (int)((unsigned)b[o] | ((unsigned)b[o + 1] << 8) | ((unsigned)b[o + 2] << 16) | ((unsigned)b[o + 3] << 24)); };
		if (b.size() < 12 || memcmp(b.data(), "WAD3", 4) != 0)
			continue;
		const int n = i32(4), table = i32(8);
		for (int k = 0; k < n && table + (size_t)(k + 1) * 32 <= b.size(); k++)
		{
			const size_t e = table + (size_t)k * 32;
			char name[17] = {0};
			memcpy(name, &b[e + 16], 16);
			if (strcmp(name, "CREDITSFONT") != 0)
				continue;
			const size_t at = (size_t)i32(e);
			if (at + 16 + 256 * 4 > b.size())
				continue;
			g_fontH = i32(at + 12);
			for (int c = 0; c < 256; c++)
				g_fontW[c] = (int)(short)(b[at + 16 + c * 4 + 2] | (b[at + 16 + c * 4 + 3] << 8));
			return g_fontH > 0;
		}
	}
	return false;
}
// the width of a character as TSHud_StringWidth counts it: the credit sign (0xA2) as a "c"
static int FontWidth(unsigned char c)
{
	return g_fontW[c == 0xA2 ? 'c' : c];
}

struct Recorder : InvCanvas
{
	int w, h;
	bool real; // measured and cut with the game's font
	std::string out;
	Recorder(int W, int H, bool realFont = false) : w(W), h(H), real(realFont && g_fontH > 0) {}
	int IconFrame(const char* name) override
	{
		for (size_t i = 0; i < g_icons.size(); i++)
			if (g_icons[i].first == name)
				return g_icons[i].second;
		return -1;
	}
	void Icon(int frame, int x, int y) override
	{
		char b2[64];
		snprintf(b2, sizeof(b2), "[\"i\",%d,%d,%d],\n", frame, x, y);
		out += b2;
	}
	void Fill(int x, int y, int fw, int fh, int r, int g, int b, int a) override
	{
		char b2[96];
		snprintf(b2, sizeof(b2), "[\"f\",%d,%d,%d,%d,%d,%d,%d,%d],\n", x, y, fw, fh, r, g, b, a);
		out += b2;
	}
	void Text(int x, int y, int maxX, const char* s, int r, int g, int b) override
	{
		if (real)
		{
			// the game's font: a glyph at a time, each where the widths before it put it, and none that crosses maxX
			int cx = x;
			for (const char* p = s; *p && *p != '\n'; p++)
			{
				const int cw = FontWidth((unsigned char)*p);
				if (cx + cw > maxX)
					break;
				char one[2] = {*p, 0};
				if (*p != ' ')
					Glyph(cx, y, one, r, g, b);
				cx += cw;
			}
			return;
		}
		// cut as the engine does: stop before a glyph crosses maxX
		std::string t;
		int cx = x;
		for (const char* p = s; *p && *p != '\n'; p++)
		{
			if (cx + 8 > maxX)
				break;
			t += *p;
			cx += 8;
		}
		std::string esc;
		for (char c : t)
		{
			if (c == '"' || c == '\\')
				esc += '\\';
			if ((unsigned char)c >= 0x80)
			{
				// a byte above 127 is Latin-1 in the HUD text (0xA2 is the credit sign), written as a JSON unicode escape
				char u[8];
				snprintf(u, sizeof(u), "\\u00%02x", (unsigned char)c);
				esc += u;
				continue;
			}
			esc += c;
		}
		char b2[64];
		snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"", x, y);
		out += b2;
		out += esc;
		snprintf(b2, sizeof(b2), "\",%d,%d,%d],\n", r, g, b);
		out += b2;
	}
	int TextW(const char* s) override
	{
		if (!real)
			return (int)strlen(s) * 8;
		int n = 0;
		for (const char* p = s; *p && *p != '\n'; p++)
			n += FontWidth((unsigned char)*p);
		return n;
	}
	int CharH() override { return real ? g_fontH : 12; }
	int Width() override { return w; }
	int Height() override { return h; }

	// one glyph as an operation of its own
	void Glyph(int x, int y, const char* ch, int r, int g, int b)
	{
		char b2[64];
		const unsigned char c = (unsigned char)ch[0];
		if (c >= 0x80)
		{
			// a byte above 127 is Latin-1 in the HUD text (0xA2 is the credit sign), written as a JSON unicode escape
			snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"\\u00%02x\",%d,%d,%d],\n", x, y, c, r, g, b);
		}
		else if (c == '"' || c == '\\')
		{
			snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"\\%c\",%d,%d,%d],\n", x, y, c, r, g, b);
		}
		else
		{
			snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"%c\",%d,%d,%d],\n", x, y, c, r, g, b);
		}
		out += b2;
	}
};

struct Msg
{
	std::vector<unsigned char> b;
	Msg& Byte(int v) { b.push_back((unsigned char)v); return *this; }
	Msg& Short(int v) { b.push_back((unsigned char)(v & 255)); b.push_back((unsigned char)((v >> 8) & 255)); return *this; }
	Msg& Long(int v) { for (int i = 0; i < 4; i++) b.push_back((unsigned char)((v >> (8 * i)) & 255)); return *this; }
	Msg& Str(const char* s) { for (; *s; s++) b.push_back((unsigned char)*s); b.push_back(0); return *this; }
};

static Model Stocked(int slots, bool credits)
{
	Model md;
	{
		Msg m;
		m.Byte(INV_OPEN).Byte(credits ? 4 : 0).Short(slots).Long(500).Long(1250).Str("VOSS, ADRIAN").Str("CADET");
		md.OnInv(m.b.data(), (int)m.b.size(), 1.0f);
	}
	const char* names[] = {"Soda", "Pizza", "Hamburger", "Milk", "Beer", "Cigarette", "Zippo Lighter", "Rope", "Tape", "Flashlight", "First Aid Kit", "Phone Prepaid Card", "Permitted License", "Restricted License"};
	{
		Msg m;
		m.Byte(INV_CATALOG).Byte(14);
		for (int i = 0; i < 14; i++)
			m.Short(i + 1).Short(20).Byte(0).Str(names[i]);
		md.OnInv(m.b.data(), (int)m.b.size(), 1.0f);
	}
	{
		Msg m;
		m.Byte(INV_SLOTS).Short(0).Byte(14);
		const int n[14] = {3, 2, 1, 2, 6, 12, 1, 1, 1, 1, 2, 1, 1, 1};
		for (int i = 0; i < 14; i++)
			m.Short(i + 1).Short(n[i]);
		md.OnInv(m.b.data(), (int)m.b.size(), 1.0f);
	}
	{
		Msg m;
		m.Byte(INV_DESC).Short(4).Str("A box of milk, it heals 15 hunger and, with thirst on, 30 thirst.");
		md.OnInv(m.b.data(), (int)m.b.size(), 1.0f);
		Msg r;
		r.Byte(INV_RESERVE).Short(4).Byte(1).Short(6);
		md.OnInv(r.b.data(), (int)r.b.size(), 1.0f);
	}
	return md;
}

static void OpenTrade(Model& md, float now)
{
	Msg m;
	m.Byte(TR_OPEN).Str("KANE, MARCUS").Long(500).Byte(12).Byte(1);
	md.OnTrade(m.b.data(), (int)m.b.size(), now);
	Msg a;
	a.Byte(TR_OFFER).Byte(0).Byte(0).Short(5).Short(4).Str("");
	md.OnTrade(a.b.data(), (int)a.b.size(), now);
	Msg b;
	b.Byte(TR_OFFER).Byte(0).Byte(1).Short(11).Short(1).Str("");
	md.OnTrade(b.b.data(), (int)b.b.size(), now);
	Msg c;
	c.Byte(TR_OFFER).Byte(1).Byte(0).Short(6).Short(10).Str("Cigarette");
	md.OnTrade(c.b.data(), (int)c.b.size(), now);
	Msg d;
	d.Byte(TR_OFFER).Byte(1).Byte(1).Short(2).Short(2).Str("Pizza");
	md.OnTrade(d.b.data(), (int)d.b.size(), now);
	Msg e;
	e.Byte(TR_MONEY).Byte(0).Long(150);
	md.OnTrade(e.b.data(), (int)e.b.size(), now);
	Msg s;
	s.Byte(TR_SEAL).Byte(0).Byte(1).Byte(0);
	md.OnTrade(s.b.data(), (int)s.b.size(), now);
}

static void Write(const char* dir, const char* name, Recorder& r, int w, int h)
{
	std::string path = std::string(dir) + "\\" + name + ".json";
	FILE* f = fopen(path.c_str(), "wb");
	if (!f)
	{
		printf("cannot write %s\n", path.c_str());
		return;
	}
	fprintf(f, "{\"w\":%d,\"h\":%d,\"ops\":[\n%s[\"f\",0,0,0,0,0,0,0,0]]}\n", w, h, r.out.c_str());
	fclose(f);
	printf("wrote %s (%d bytes of operations)\n", path.c_str(), (int)r.out.size());
}

static void Scene(const char* dir, const char* name, int w, int h, Model& md, Ui& ui, float now, bool realFont = false)
{
	Recorder rec(w, h, realFont);
	InvPainter p(rec, md, ui, now);
	p.DrawAll();
	Write(dir, name, rec, w, h);
}

static Near FakeNear1 = {7, "KANE, MARCUS"};
static int NearHook(Near* out, int max)
{
	int n = 0;
	if (max > 0)
		out[n++] = FakeNear1;
	if (max > 1)
	{
		out[n].index = 12;
		strcpy(out[n].name, "REED, JOHN");
		n++;
	}
	return n;
}

int main(int argc, char** argv)
{
	const char* dir = argc > 1 ? argv[1] : ".";
	LoadIcons();
	const bool font = LoadGameFont();
	printf("the game's HUD font: %s\n", font ? "read (creditsfont)" : "not found, the scenes with it use 8 x 12");
	g_nearPlayers = NearHook;
	g_textW = [](const char* s) { return (int)strlen(s) * 8; };

	// 1. the plain window, credits, a cell selected, one cell held by an exchange
	{
		Model md = Stocked(32, true);
		Ui ui;
		ui.selected = 3;
		ui.hover = 4;
		Msg n;
		n.Byte(INV_NOTE).Byte(0).Str("You have picked up 2 Soda.");
		md.OnInv(n.b.data(), (int)n.b.size(), 5.0f);
		Scene(dir, "01_inventory_1280x720", 1280, 720, md, ui, 6.0f);
		Scene(dir, "02_inventory_800x600", 800, 600, md, ui, 6.0f);
		Scene(dir, "03_inventory_640x480", 640, 480, md, ui, 6.0f);
	}
	// 4. full, cash wording
	{
		Model md = Stocked(14, false);
		Ui ui;
		ui.selected = 5;
		Msg n;
		n.Byte(INV_NOTE).Byte(1).Str("Your inventory is full.");
		md.OnInv(n.b.data(), (int)n.b.size(), 5.0f);
		Scene(dir, "04_inventory_full_cash", 1280, 720, md, ui, 6.0f);
	}
	// 5. the menu of a stack, 6. the split box, 7. the list of players, 8. a tile being dragged out of the window
	{
		Model md = Stocked(32, true);
		Ui ui;
		InvLayout L = BuildLayout(md, 1280, 720, 12, 0);
		const IRect c = L.CellRect(4);
		ui.MouseMove(md, L, c.x + 20, c.y + 20);
		ui.MouseDown(md, L, 1, c.x + 20, c.y + 20, 10.0f);
		ui.MouseMove(md, L, ui.popupRect.x + 20, ui.popupRect.y + 6 + 1 * 20 + 4);
		Scene(dir, "05_context_menu", 1280, 720, md, ui, 11.0f);
		ui.ClosePopup();
		ui.OpenSplit(md, L, 5);
		Scene(dir, "06_split_box", 1280, 720, md, ui, 11.0f);
		ui.ClosePopup();
		ui.selected = 12;
		ui.OpenPlayers(L, 12, MI_SHOW);
		Scene(dir, "07_show_to_list", 1280, 720, md, ui, 11.0f);
		ui.ClosePopup();
		const IRect d = L.CellRect(5);
		ui.shift = false;
		ui.MouseMove(md, L, d.x + 20, d.y + 20);
		ui.MouseDown(md, L, 0, d.x + 20, d.y + 20, 12.0f);
		ui.MouseMove(md, L, L.win.R() + 60, L.win.y + 80);
		Scene(dir, "08_drag_to_drop", 1280, 720, md, ui, 12.5f);
	}
	// 9. the exchange
	{
		Model md = Stocked(32, true);
		OpenTrade(md, 20.0f);
		Ui ui;
		InvLayout L = BuildLayout(md, 1280, 720, 12, 0);
		ui.selected = 1;
		ui.mx = L.sealBtn.x + 10;
		ui.my = L.sealBtn.y + 10;
		Scene(dir, "09_exchange_1280x720", 1280, 720, md, ui, 25.0f);
		Scene(dir, "10_exchange_1024x768", 1024, 768, md, ui, 25.0f);
		Scene(dir, "11_exchange_800x600", 800, 600, md, ui, 25.0f);
		ui.editMoney = true;
		strcpy(ui.moneyText, "12");
		Scene(dir, "12_exchange_money_edit", 1280, 720, md, ui, 25.0f);
		Msg done;
		done.Byte(TR_CLOSE).Byte(TC_DONE).Str("VOSS RECEIVES: Cigarette x10, Pizza x2|KANE RECEIVES: Beer x4, First Aid Kit x1, \xA2" "150");
		md.OnTrade(done.b.data(), (int)done.b.size(), 26.0f);
		Scene(dir, "13_exchange_complete", 1280, 720, md, ui, 27.0f);
	}
	// 14. the invitation, window closed
	{
		Model md = Stocked(32, true);
		md.open = false;
		Msg inv;
		inv.Byte(TR_INVITE).Byte(12).Str("Kane, Marcus");
		md.OnTrade(inv.b.data(), (int)inv.b.size(), 30.0f);
		Ui ui;
		Scene(dir, "14_invitation", 1280, 720, md, ui, 33.0f);
	}
	// 15 to 20. the search of a handcuffed player
	{
		Model md = Stocked(32, true);
		{
			Msg m;
			m.Byte(SR_OPEN).Byte(0).Short(32).Str("KANE, MARCUS");
			md.OnSearch(m.b.data(), (int)m.b.size(), 40.0f);
			Msg s;
			s.Byte(SR_SLOTS).Short(0).Byte(12);
			const int k[12] = {1, 2, 0, 9, 6, 7, 0, 0, 13, 3, 10, 11};
			const int n[12] = {20, 3, 0, 2, 10, 1, 0, 0, 1, 1, 4, 2};
			for (int i = 0; i < 12; i++)
				s.Short(k[i]).Short(n[i]);
			md.OnSearch(s.b.data(), (int)s.b.size(), 40.0f);
			Msg t;
			t.Byte(SR_NOTE).Byte(0).Str("You took 3 Soda.");
			md.OnSearch(t.b.data(), (int)t.b.size(), 41.0f);
			Msg mo;
			mo.Byte(SR_MONEY).Long(1250);
			md.OnSearch(mo.b.data(), (int)mo.b.size(), 41.0f);
		}
		Ui ui;
		InvLayout L = BuildLayout(md, 1280, 720, 12, 0, 0);
		ui.sSelected = 1;
		ui.selected = 4;
		ui.mx = L.SCellRect(3).x + 10;
		ui.my = L.SCellRect(3).y + 10;
		ui.sHover = 3;
		Scene(dir, "15_search_1280x720", 1280, 720, md, ui, 42.0f);
		Scene(dir, "16_search_1024x768", 1024, 768, md, ui, 42.0f);
		Scene(dir, "17_search_800x600", 800, 600, md, ui, 42.0f);
		Scene(dir, "18_search_640x480", 640, 480, md, ui, 42.0f);

		// the menu of a stack of his, and the box that asks how many
		Ui mu;
		const IRect c = L.SCellRect(0);
		mu.MouseMove(md, L, c.x + 20, c.y + 20);
		mu.MouseDown(md, L, 1, c.x + 20, c.y + 20, 50.0f);
		mu.MouseMove(md, L, mu.popupRect.x + 20, mu.popupRect.y + 6 + 1 * 20 + 4);
		Scene(dir, "19_search_menu", 1280, 720, md, mu, 51.0f);
		mu.ClosePopup();
		mu.OpenContextTheirs(md, L, 0, c.x + 20, c.y + 20);
		mu.OpenTake(md, L, 0);
		Scene(dir, "20_search_take_box", 1280, 720, md, mu, 52.0f);

		// one of his tiles dragged onto the inventory
		Ui du;
		const IRect d = L.SCellRect(4);
		du.shift = false;
		du.MouseMove(md, L, d.x + 20, d.y + 20);
		du.MouseDown(md, L, 0, d.x + 20, d.y + 20, 60.0f);
		du.MouseMove(md, L, L.win.x + 200, L.win.y + 150);
		Scene(dir, "21_search_drag", 1280, 720, md, du, 61.0f);

		// the windows dragged by their title bars: the inventory to the left and down, his window up and to the right
		Ui gu;
		gu.win.dx[0] = -120;
		gu.win.dy[0] = 40;
		gu.win.dx[2] = 90;
		gu.win.dy[2] = -30;
		Scene(dir, "27_search_windows_dragged", 1280, 720, md, gu, 62.0f);

		// nothing in his wallet: the buttons are dead
		Model poor = md;
		Msg zero;
		zero.Byte(SR_MONEY).Long(0);
		poor.OnSearch(zero.b.data(), (int)zero.b.size(), 63.0f);
		Ui pu;
		Scene(dir, "28_search_no_money", 1280, 720, poor, pu, 64.0f);
	}
	// 22. a handcuffed player with nothing on him, 23. a long grid over capacity (the arrows), scrolled
	{
		Model md = Stocked(32, true);
		Msg m;
		m.Byte(SR_OPEN).Byte(0).Short(32).Str("REED, JOHN");
		md.OnSearch(m.b.data(), (int)m.b.size(), 70.0f);
		Msg t;
		t.Byte(SR_NOTE).Byte(0).Str("He has nothing on him.");
		md.OnSearch(t.b.data(), (int)t.b.size(), 70.0f);
		Ui ui;
		Scene(dir, "22_search_nothing", 1280, 720, md, ui, 71.0f);

		Model big = Stocked(32, true);
		Msg o;
		o.Byte(SR_OPEN).Byte(1).Short(96).Str("A LONG NAME, ADRIAN VOSS THE SECOND");
		big.OnSearch(o.b.data(), (int)o.b.size(), 72.0f);
		Msg s;
		s.Byte(SR_SLOTS).Short(0).Byte(40);
		for (int i = 0; i < 40; i++)
			s.Short((i % 3 == 2) ? 0 : (i % 14) + 1).Short((i % 3 == 2) ? 0 : 1 + (i * 7) % 15);
		big.OnSearch(s.b.data(), (int)s.b.size(), 72.0f);
		Ui bu;
		bu.sScroll = 2;
		bu.sSelected = 14;
		Scene(dir, "23_search_long_over_capacity", 1280, 720, big, bu, 73.0f);
	}
	// 29 to 32. The owner's screen, with the game's own font (creditsfont, 19 pixels high): the 96 pixel tiles with a picture and the name under it, the header's CREDITS
	// (arp_h9_credits 1) and WALLET with the dollar sign (0), a 48 pixel tile of a screen under 700 pixels high, which holds the picture alone, and an exchange
	{
		Model md = Stocked(32, true);
		Ui ui;
		ui.selected = 9; // the Flashlight
		ui.hover = 3;
		Scene(dir, "29_inventory_1920x1080_credits_real_font", 1920, 1080, md, ui, 6.0f, true);
		Model cash = Stocked(32, false);
		Scene(dir, "30_inventory_1920x1080_cash_real_font", 1920, 1080, cash, ui, 6.0f, true);
		Scene(dir, "31_inventory_800x600_credits_real_font", 800, 600, md, ui, 6.0f, true);
		OpenTrade(md, 20.0f);
		Scene(dir, "32_exchange_1920x1080_real_font", 1920, 1080, md, ui, 25.0f, true);
	}
	return 0;
}
