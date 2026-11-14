// Draws the ARP context menu for a few situations and screens into a list of drawing operations (one JSON file each), which tools\render_arpinv.py turns into pictures. It
// uses the very Painter the game draws with, over a canvas that records instead of drawing, and the messages are built the way the server's ARP_H9Ctx sends them:
//   cl /std:c++17 /EHsc /I.. render_arpctx.cpp && render_arpctx.exe <output folder>
// A cross at the middle of each picture is the crosshair, and the little arrow the mouse cursor, which comes up there.
#include "../h9_arpctx_ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

using namespace arpctx;

// The HUD font of the game, the engine's creditsfont (valve/gfx.wad, lump CREDITSFONT: 19 pixels high, a width for each character): the scenes measure and cut text with it, so
// that what fits in the picture is what fits in the game. Without the file the font is 8 pixels wide and 12 high.
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

struct Recorder : CtxCanvas
{
	int w, h;
	bool real;
	std::string out;
	Recorder(int W, int H) : w(W), h(H), real(g_fontH > 0) {}

	void Fill(int x, int y, int fw, int fh, int r, int g, int b, int a) override
	{
		char b2[96];
		snprintf(b2, sizeof(b2), "[\"f\",%d,%d,%d,%d,%d,%d,%d,%d],\n", x, y, fw, fh, r, g, b, a);
		out += b2;
	}
	void Glyph(int x, int y, unsigned char c, int r, int g, int b)
	{
		char b2[64];
		if (c >= 0x80)
			snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"\\u00%02x\",%d,%d,%d],\n", x, y, c, r, g, b);
		else if (c == '"' || c == '\\')
			snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"\\%c\",%d,%d,%d],\n", x, y, c, r, g, b);
		else
			snprintf(b2, sizeof(b2), "[\"t\",%d,%d,\"%c\",%d,%d,%d],\n", x, y, c, r, g, b);
		out += b2;
	}
	// a glyph at a time, each where the widths before it put it, and none that crosses maxX (as the engine cuts)
	void Text(int x, int y, int maxX, const char* s, int r, int g, int b) override
	{
		int cx = x;
		for (const char* p = s; *p && *p != '\n'; p++)
		{
			const int cw = real ? FontWidth((unsigned char)*p) : 8;
			if (cx + cw > maxX)
				break;
			if (*p != ' ')
				Glyph(cx, y, (unsigned char)*p, r, g, b);
			cx += cw;
		}
	}
	int TextW(const char* s) override
	{
		int n = 0;
		for (const char* p = s; *p && *p != '\n'; p++)
			n += real ? FontWidth((unsigned char)*p) : 8;
		return n;
	}
	int CharH() override { return real ? g_fontH : 12; }
	int Width() override { return w; }
	int Height() override { return h; }
};

static int MeasureHook(const char* s)
{
	int n = 0;
	for (const char* p = s; *p && *p != '\n'; p++)
		n += g_fontH > 0 ? FontWidth((unsigned char)*p) : 8;
	return n;
}

// ---- messages, written from docs\ARP_INVENTORY.txt 10 only
struct Msg
{
	std::vector<unsigned char> b;
	Msg& Byte(int v) { b.push_back((unsigned char)v); return *this; }
	Msg& Str(const char* s) { for (; *s; s++) b.push_back((unsigned char)*s); b.push_back(0); return *this; }
};
struct RowDef
{
	int flags, key;
	const char* label;
	const char* note;
};
static void Menu(Model& md, int serial, int page, const char* title, const char* sub, const std::vector<RowDef>& rows, float now = 1.0f)
{
	Msg o;
	o.Byte(OP_OPEN).Byte(serial).Byte(0).Byte(page).Byte((int)rows.size()).Str(title).Str(sub);
	md.OnMessage(o.b.data(), (int)o.b.size(), now);
	// the rows in messages of at most 188 bytes, as the server cuts them
	for (size_t i = 0; i < rows.size();)
	{
		size_t size = 4, cnt = 0;
		while (i + cnt < rows.size())
		{
			const size_t row = 2 + strlen(rows[i + cnt].label) + 1 + strlen(rows[i + cnt].note) + 1;
			if (cnt > 0 && size + row > 188)
				break;
			size += row;
			cnt++;
		}
		Msg r;
		r.Byte(OP_ROWS).Byte(serial).Byte((int)i).Byte((int)cnt);
		for (size_t k = 0; k < cnt; k++)
			r.Byte(rows[i + k].flags).Byte(rows[i + k].key).Str(rows[i + k].label).Str(rows[i + k].note);
		md.OnMessage(r.b.data(), (int)r.b.size(), now);
		i += cnt;
	}
}

static IRect Safe(int sw, int sh)
{
	return IRect(0, sh * 136 / 480, sw, sh - sh * 136 / 480 - sh * 90 / 480);
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

// the crosshair, and the mouse cursor (an arrow of a few boxes) at the middle of the screen
static void CrossAndCursor(Recorder& rec, int w, int h)
{
	const int cx = w / 2, cy = h / 2;
	rec.Fill(cx - 8, cy, 6, 1, 255, 255, 255, 200);
	rec.Fill(cx + 3, cy, 6, 1, 255, 255, 255, 200);
	rec.Fill(cx, cy - 8, 1, 6, 255, 255, 255, 200);
	rec.Fill(cx, cy + 3, 1, 6, 255, 255, 255, 200);
	for (int i = 0; i < 9; i++)
		rec.Fill(cx + 4, cy + 4 + i, 1 + (i < 6 ? i / 2 : 6 - i / 2), 1, 255, 255, 255, 230);
}

static void Scene(const char* dir, const char* name, int w, int h, Model& md, int hover, float now, float scale = 1.0f)
{
	Recorder rec(w, h);
	CrossAndCursor(rec, w, h);
	Ui ui;
	ui.hover = hover;
	Painter p(rec, md, ui, now, Safe(w, h), scale);
	p.DrawAll();
	Write(dir, name, rec, w, h);
}

int main(int argc, char** argv)
{
	const char* dir = argc > 1 ? argv[1] : ".";
	const bool font = LoadGameFont();
	printf("the game's HUD font: %s\n", font ? "read (creditsfont)" : "not found, the scenes use 8 x 12");
	g_textW = MeasureHook;

	// the first page for a civilian who holds Cuffs, a Rope and money, and no Tape (the rows the server's plugin builds)
	const std::vector<RowDef> civilian = {
		{F_ON, 1, "Trade", ""},
		{0, 2, "Search", "Cuff him first"},
		{F_ON, 3, "Cuff", "uses Cuffs"},
		{F_ON, 4, "Tie", ""},
		{0, 5, "Tape mouth", "You have no Tape"},
		{F_MORE, 6, "Fine", "Police only"},
		{F_ON | F_MORE, 7, "Give money", ""},
		{F_ON | F_MORE, 8, "Show license or card", ""},
	};
	{
		Model md;
		Menu(md, 3, 0, "VOSS, ADRIAN", "", civilian);
		Scene(dir, "01_first_page_1280x720", 1280, 720, md, 0, 2.0f);
		Scene(dir, "02_first_page_800x600", 800, 600, md, 0, 2.0f);
		Scene(dir, "03_first_page_640x480", 640, 480, md, 0, 2.0f);
		Scene(dir, "04_first_page_1920x1080_scale15", 1920, 1080, md, 2, 2.0f, 1.5f);
		// a greyed row clicked: the reason is said under the rows
		md.SetStatus("Cuff him first", 1, 2.0f);
		Scene(dir, "05_greyed_row_clicked", 1280, 720, md, 1, 3.0f);
	}
	// a policeman, the player in front of him cuffed: Search is on and Trade is off, Free in place of Cuff, a fine is possible
	{
		Model md;
		Menu(md, 4, 0, "KANE, MARCUS", "",
			{{0, 1, "Trade", "He is cuffed: search him"},
			 {F_ON, 2, "Search", ""},
			 {F_ON, 3, "Free", ""},
			 {F_ON, 4, "Tie", ""},
			 {F_ON, 5, "Tape mouth", "uses a roll"},
			 {F_ON | F_MORE, 6, "Fine", ""},
			 {F_ON | F_MORE, 7, "Give money", ""},
			 {0, 8, "Show license or card", "No license or card"}});
		Scene(dir, "06_police_on_cuffed_1280x720", 1280, 720, md, 1, 2.0f);
	}
	// a bot in front of the player: nothing but money can be done to it
	{
		Model md;
		Menu(md, 5, 0, "HALE, JOSS", "",
			{{0, 1, "Trade", "Bots cannot trade"},
			 {0, 2, "Search", "Cuff him first"},
			 {0, 3, "Cuff", "You have no Cuffs"},
			 {0, 4, "Tie", "You have no Rope"},
			 {0, 5, "Tape mouth", "You have no Tape"},
			 {F_MORE, 6, "Fine", "Police only"},
			 {F_ON | F_MORE, 7, "Give money", ""},
			 {0, 8, "Show license or card", "Bots cannot see it"}});
		Scene(dir, "07_bot_target_1280x720", 1280, 720, md, -1, 2.0f);
	}
	// the page of a fine, and of money in credits (the credit sign is the byte 0xA2)
	{
		Model md;
		Menu(md, 6, 1, "FINE", "KANE, MARCUS",
			{{F_ON, 1, "$50", ""}, {F_ON, 2, "$100", ""}, {0, 3, "$250", "He cannot pay"}, {0, 4, "$500", "He cannot pay"}, {0, 5, "$1000", "He cannot pay"}, {F_ON | F_GAP, 10, "Back", ""}});
		Scene(dir, "08_fine_page_1280x720", 1280, 720, md, 1, 2.0f);
		Model gm;
		Menu(gm, 7, 2, "GIVE MONEY", "VOSS, ADRIAN",
			{{F_ON, 1, "\xA2" "10", ""}, {F_ON, 2, "\xA2" "50", ""}, {F_ON, 3, "\xA2" "100", ""}, {F_ON, 4, "\xA2" "500", ""}, {0, 5, "\xA2" "1000", "You have less"}, {F_ON | F_GAP, 10, "Back", ""}});
		Scene(dir, "09_give_page_credits_1280x720", 1280, 720, gm, 2, 2.0f);
	}
	// the page of a show
	{
		Model md;
		Menu(md, 8, 3, "SHOW", "VOSS, ADRIAN", {{F_ON, 1, "Permitted License", ""}, {F_ON, 2, "ATM Card", ""}, {F_ON, 3, "Phone Prepaid Card", ""}, {F_ON | F_GAP, 10, "Back", ""}});
		Scene(dir, "10_show_page_1280x720", 1280, 720, md, 0, 2.0f);
	}
	// a full first page: the 8 entries of the plugin and 4 of other plugins, one with a label and a note too long
	{
		Model md;
		std::vector<RowDef> rows = civilian;
		rows.push_back({F_ON, 9, "Shove", ""});
		rows.push_back({0, 10, "Salute", "Not now"});
		rows.push_back({F_ON, 0, "A label that is far too lo", "a note that is a good deal l"});
		rows.push_back({F_ON, 0, "Filler", ""});
		Menu(md, 9, 0, "A NAME THAT IS LONGER THAN THE ROOM", "", rows);
		Scene(dir, "11_twelve_rows_640x480", 640, 480, md, 9, 2.0f);
		Scene(dir, "12_twelve_rows_1280x720", 1280, 720, md, 9, 2.0f);
	}
	return 0;
}
