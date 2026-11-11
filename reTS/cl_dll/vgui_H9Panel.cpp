// ---- H9 VGUI: the panels -----------------------------------------------------------------------
// vgui_H9Panel.h says what each class is; docs\H9_VGUI.txt, sections 2c and 4c, the sizes and
// places they are given.

#include "hud.h"
#include "cl_util.h"
#include "vgui_TeamFortressViewport.h"
#include "vgui_H9Panel.h"
#include "h9_theme.h" // the colour the player gives the panels in place of the purple

#include <string.h>
#include <stdio.h>

namespace
{
inline int H9Min(int a, int b) { return a < b ? a : b; }
inline int H9Max(int a, int b) { return a > b ? a : b; }
inline int H9Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline int H9Round(float f) { return (int)(f + 0.5f); }

// H9's purples. The text itself is the textscheme's Primary Button Text colour (H9TextColour).
const int LIT_R = 182, LIT_G = 145, LIT_B = 234;    // titles, numbers: the rail's lit purple
const int DIM_R = 140, DIM_G = 128, DIM_B = 164;    // a dim row, a footer
const int DET_R = 166, DET_G = 154, DET_B = 192;    // a row's detail
const int RED_R = 236, RED_G = 96, RED_B = 96;      // a red row
const int RAIL_R = 133, RAIL_G = 98, RAIL_B = 178;  // the rail: lines, frames, bars
const int HOT_R = 138, HOT_G = 66, HOT_B = 196;     // a highlighted row's band
const int BOX_R = 16, BOX_G = 10, BOX_B = 24;       // the art's surround: a panel without art

// ---- the arts ----------------------------------------------------------------------------------

struct ArtSlot
{
	const char* name;
	const char* path;
	int insetL, insetT, insetR, insetB, corner; // measured from the frames (docs\H9_VGUI.txt, 2b)
	bool tried;
	bool ok;
	CH9Art art;
};

ArtSlot s_arts[] = {
	{"#panel", "sprites/tsm_panel.spr", 36, 16, 34, 16, 68, false, false, {}},
	{"#banner", "sprites/tsm_banner.spr", 22, 18, 22, 10, 32, false, false, {}},
};

int Int32At(const unsigned char* p)
{
	return (int)((unsigned int)p[0] | ((unsigned int)p[1] << 8) | ((unsigned int)p[2] << 16) | ((unsigned int)p[3] << 24));
}

// An IDSP version 2 sprite's first frame, as the engine reads it: the palette's index 255 is
// transparent in an alpha-test sprite.
bool LoadSprite(const char* path, CH9Art& out)
{
	int len = 0;
	unsigned char* file = gEngfuncs.COM_LoadFile(path, 5, &len);
	if (!file)
		return false;

	bool ok = false;
	if (len > 830 && 0 == memcmp(file, "IDSP", 4) && Int32At(file + 4) == 2 && Int32At(file + 28) >= 1 &&
		(file[40] | (file[41] << 8)) == 256 && Int32At(file + 810) == 0)
	{
		const int format = Int32At(file + 12);
		const int wide = Int32At(file + 822);
		const int tall = Int32At(file + 826);
		if (wide > 0 && tall > 0 && wide <= 1024 && tall <= 1024 && 830 + wide * tall <= len)
		{
			const unsigned char* pal = file + 42;
			const unsigned char* px = file + 830;
			out.rgba = new unsigned char[wide * tall * 4];
			for (int i = 0; i < wide * tall; i++)
			{
				const int v = px[i];
				out.rgba[i * 4] = pal[v * 3];
				out.rgba[i * 4 + 1] = pal[v * 3 + 1];
				out.rgba[i * 4 + 2] = pal[v * 3 + 2];
				out.rgba[i * 4 + 3] = (format == 3 && v == 255) ? 0 : 255;
			}
			out.wide = wide;
			out.tall = tall;
			ok = true;
		}
	}
	gEngfuncs.COM_FreeFile(file);
	return ok;
}

// The bitmaps already made, by art, size and scale, each kept for the life of the client: VGUI1
// frees no texture, and the engine keeps every one it is given. The panels round their sizes
// (Layout), so few are made; past MAX_BITMAPS a new size draws without its art.
// The art is made in the colour the player has given the panels (h9_theme.h). A new colour makes every size again, and the old ones stay with the
// engine, so no more than MAX_RECOLOURS colours do that in one game: past it the art keeps the colour it has until the game is restarted.
struct BitmapSlot
{
	const CH9Art* art;
	int wide, tall, scale100;
	CH9ArtBitmap* bitmap;
};
const int MAX_BITMAPS = 64;
const int MAX_RECOLOURS = 12;
BitmapSlot s_bitmaps[MAX_BITMAPS];
int s_numBitmaps = 0;
bool s_bBitmapsFull = false;
int s_bitmapColour = -1;      // h9theme::Generation() the bitmaps were made in, -1 before the first
int s_numRecoloured = 0;      // times a new colour has made them again
bool s_bRecolourFull = false;

// Where a destination pixel samples the art, along one axis of the nine-slice.
int SliceMap(int d, int dsize, int dc, int sc, int ssize)
{
	if (d < dc)
		return H9Min(sc - 1, d * sc / dc);
	if (d >= dsize - dc)
		return ssize - 1 - H9Min(sc - 1, (dsize - 1 - d) * sc / dc);
	const int mid = H9Max(1, dsize - 2 * dc);
	const int smid = ssize - 2 * sc;
	return H9Clamp(sc + (d - dc) * smid / mid, 0, ssize - 1);
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

// The art scales at cl_h9_vgui_scale 1, of the screen height / 480: a menu's and a panel's on the
// tsm_panel art, and a notice's and a banner panel's on the tsm_banner art.
const float H9_MENU_SCALE = 0.51f;
const float H9_BANNER_SCALE = 0.45f;

// The scale of an art on this screen: base x (screen height / 480) x cl_h9_vgui_scale.
float ArtScale(float base)
{
	return ((float)ScreenHeight / 480.0f) * base * UserScale();
}

void H9TextColour(int& r, int& g, int& b)
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

// Moves a rect into the safe area, and, for a passive panel, off the crosshair box.
void Place(int& x, int& y, int wide, int tall)
{
	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	x = (wide >= sx1 - sx0) ? sx0 : H9Clamp(x, sx0, sx1 - wide);
	y = (tall >= sy1 - sy0) ? sy0 : H9Clamp(y, sy0, sy1 - tall);

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

// A built-in art's name ("#panel", "#banner") from a control's text: nothing else is loaded.
const CH9Art* BuiltinArt(const char* name)
{
	if (!name || name[0] != '#')
		return nullptr;
	return CH9Art::Find(name);
}

// ---- the pictures of items: the sheet (sprites/h9_arpicons.spr), its names (sprites/h9_arpicons.txt) and the bitmaps made of its frames

const int PICTURE_PX = 32;          // the side of a frame of the sheet
const int MAX_PICTURE_NAMES = 256;  // as many as the inventory window reads (h9_arpinv.cpp)
const int MAX_PICTURE_BITMAPS = 160;

struct PictureName
{
	char name[40];
	int frame;
};
PictureName s_pictureNames[MAX_PICTURE_NAMES];
int s_numPictureNames = 0;
bool s_bPicturesTried = false;
unsigned char* s_pictureSheet = nullptr; // the sprite file, kept for the life of the client: a frame is read from it when it is wanted
int s_pictureSheetLen = 0;
int s_pictureFrames = 0;

// The names and the sheet, read once. A sheet that is not a version 2 sprite of 256 colours, or a name list without it, is none.
void LoadPictures()
{
	if (s_bPicturesTried)
		return;
	s_bPicturesTried = true;

	int len = 0;
	unsigned char* file = gEngfuncs.COM_LoadFile("sprites/h9_arpicons.spr", 5, &len);
	if (!file)
		return;
	if (len > 830 && 0 == memcmp(file, "IDSP", 4) && Int32At(file + 4) == 2 && (file[40] | (file[41] << 8)) == 256 && Int32At(file + 28) >= 1)
	{
		s_pictureSheet = new unsigned char[len];
		memcpy(s_pictureSheet, file, len);
		s_pictureSheetLen = len;
		s_pictureFrames = Int32At(file + 28);
	}
	gEngfuncs.COM_FreeFile(file);
	if (!s_pictureSheet)
		return;

	unsigned char* txt = gEngfuncs.COM_LoadFile("sprites/h9_arpicons.txt", 5, &len);
	if (!txt)
		return;
	const int total = H9Min(len, 65536);
	for (int p = 0; p < total && s_numPictureNames < MAX_PICTURE_NAMES;)
	{
		char line[96];
		int l = 0;
		while (p < total && txt[p] != '\n' && txt[p] != '\r')
		{
			if (l < (int)sizeof(line) - 1)
				line[l++] = (char)txt[p];
			p++;
		}
		line[l] = 0;
		while (p < total && (txt[p] == '\n' || txt[p] == '\r'))
			p++;
		char* bar = strchr(line, '|');
		if (!bar || line[0] == '/' || line[0] == '#')
			continue;
		*bar = 0;
		PictureName& n = s_pictureNames[s_numPictureNames];
		strncpy(n.name, line, sizeof(n.name) - 1);
		n.name[sizeof(n.name) - 1] = 0;
		n.frame = atoi(bar + 1);
		s_numPictureNames++;
	}
	gEngfuncs.COM_FreeFile(txt);
}

// A frame of the sheet as RGBA, PICTURE_PX square: the palette's index 255 is transparent in an alpha-test sprite. False for a frame that is
// not there or not of that size.
bool PictureFrameRGBA(int frame, unsigned char* out)
{
	if (!s_pictureSheet || frame < 0 || frame >= s_pictureFrames)
		return false;
	const unsigned char* file = s_pictureSheet;
	const int format = Int32At(file + 12);
	const unsigned char* pal = file + 42;
	int off = 810;
	for (int f = 0; f <= frame; f++)
	{
		if (off + 20 > s_pictureSheetLen || Int32At(file + off) != 0)
			return false;
		const int w = Int32At(file + off + 12), h = Int32At(file + off + 16);
		if (w != PICTURE_PX || h != PICTURE_PX || off + 20 + w * h > s_pictureSheetLen)
			return false;
		if (f == frame)
		{
			const unsigned char* px = file + off + 20;
			for (int i = 0; i < w * h; i++)
			{
				const int v = px[i];
				out[i * 4] = pal[v * 3];
				out[i * 4 + 1] = pal[v * 3 + 1];
				out[i * 4 + 2] = pal[v * 3 + 2];
				out[i * 4 + 3] = (format == 3 && v == 255) ? 0 : 255;
			}
			return true;
		}
		off += 20 + w * h;
	}
	return false;
}

// A frame at a whole number of times its size, nearest neighbour (it is pixel art).
class CH9PictureBitmap : public vgui::Bitmap
{
public:
	CH9PictureBitmap(const unsigned char* rgba, int times)
	{
		const int side = PICTURE_PX * times;
		setSize(side, side);
		setColor(vgui::Color(255, 255, 255, 0));
		for (int y = 0; y < side; y++)
		{
			for (int x = 0; x < side; x++)
			{
				const unsigned char* p = rgba + ((y / times) * PICTURE_PX + (x / times)) * 4;
				setRGBA(x, y, p[0], p[1], p[2], p[3]);
			}
		}
	}
	void SetAlpha(int alpha) { setColor(vgui::Color(255, 255, 255, 255 - H9Clamp(alpha, 0, 255))); }
};

// Each bitmap is kept for the life of the client, as the art's are: VGUI1 frees no texture.
struct PictureSlot
{
	int frame, times;
	CH9PictureBitmap* bitmap;
};
PictureSlot s_pictureBitmaps[MAX_PICTURE_BITMAPS];
int s_numPictureBitmaps = 0;

CH9PictureBitmap* PictureBitmap(int frame, int times)
{
	for (int i = 0; i < s_numPictureBitmaps; i++)
	{
		if (s_pictureBitmaps[i].frame == frame && s_pictureBitmaps[i].times == times)
			return s_pictureBitmaps[i].bitmap;
	}
	unsigned char rgba[PICTURE_PX * PICTURE_PX * 4];
	if (s_numPictureBitmaps >= MAX_PICTURE_BITMAPS || !PictureFrameRGBA(frame, rgba))
		return nullptr;
	PictureSlot& slot = s_pictureBitmaps[s_numPictureBitmaps++];
	slot.frame = frame;
	slot.times = times;
	slot.bitmap = new CH9PictureBitmap(rgba, times);
	return slot.bitmap;
}
} // namespace

// ---- CH9Art -----------------------------------------------------------------------------------

const CH9Art* CH9Art::Find(const char* name)
{
	if (!name)
		return nullptr;
	for (ArtSlot& a : s_arts)
	{
		if (0 != strcmp(name, a.name))
			continue;
		if (!a.tried)
		{
			a.tried = true;
			a.ok = LoadSprite(a.path, a.art);
			if (a.ok)
			{
				a.art.insetL = a.insetL;
				a.art.insetT = a.insetT;
				a.art.insetR = a.insetR;
				a.art.insetB = a.insetB;
				a.art.corner = a.corner;
			}
			else
			{
				gEngfuncs.Con_DPrintf("H9 VGUI: %s could not be read; panels draw without it\n", a.path);
			}
		}
		return a.ok ? &a.art : nullptr;
	}
	return nullptr;
}

// ---- CH9ArtBitmap -----------------------------------------------------------------------------

CH9ArtBitmap::CH9ArtBitmap(const CH9Art* art, int wide, int tall, float scale)
{
	setSize(wide, tall);
	setColor(vgui::Color(255, 255, 255, 0));

	const int c = H9Max(1, H9Min(art->corner, H9Min(art->wide, art->tall) / 2));
	const int dcx = H9Clamp(H9Round(c * scale), 1, H9Max(1, wide / 2));
	const int dcy = H9Clamp(H9Round(c * scale), 1, H9Max(1, tall / 2));

	// In the player's colour (h9_theme.h). The art has a few colours, so the last few moved are kept in a small table.
	h9theme::Generation();
	int seen[32];
	unsigned char moved[32][3];
	for (int i = 0; i < 32; i++)
		seen[i] = -1;
	for (int y = 0; y < tall; y++)
	{
		const int sy = SliceMap(y, tall, dcy, c, art->tall);
		for (int x = 0; x < wide; x++)
		{
			const int sx = SliceMap(x, wide, dcx, c, art->wide);
			const unsigned char* p = art->rgba + (sy * art->wide + sx) * 4;
			int r = p[0], g = p[1], b = p[2];
			if (p[3] != 0)
			{
				const int key = (r << 16) | (g << 8) | b;
				const int slot = (r * 7 + g * 13 + b * 29) & 31;
				if (seen[slot] != key)
				{
					int mr = r, mg = g, mb = b;
					h9theme::TintHeld(mr, mg, mb);
					seen[slot] = key;
					moved[slot][0] = (unsigned char)mr;
					moved[slot][1] = (unsigned char)mg;
					moved[slot][2] = (unsigned char)mb;
				}
				r = moved[slot][0];
				g = moved[slot][1];
				b = moved[slot][2];
			}
			setRGBA(x, y, r, g, b, p[3]);
		}
	}
}

void CH9ArtBitmap::SetAlpha(int alpha)
{
	setColor(vgui::Color(255, 255, 255, 255 - H9Clamp(alpha, 0, 255)));
}

CH9ArtBitmap* H9ArtBitmap(const CH9Art* art, int wide, int tall, float scale)
{
	if (!art || wide < 4 || tall < 4 || wide > 4096 || tall > 4096)
		return nullptr;

	// A new colour for the panels makes every size again (the old bitmaps are dropped from the table, and stay with the engine).
	const int colour = h9theme::Generation();
	if (colour != s_bitmapColour)
	{
		const bool first = s_bitmapColour < 0;
		s_bitmapColour = colour;
		if (!first)
		{
			if (s_numRecoloured >= MAX_RECOLOURS)
			{
				if (!s_bRecolourFull)
				{
					s_bRecolourFull = true;
					gEngfuncs.Con_Printf("H9 VGUI: the panels' art has been made again in a new colour %d times; it keeps the colour it has until the game is restarted\n",
						MAX_RECOLOURS);
				}
			}
			else
			{
				s_numRecoloured++;
				s_numBitmaps = 0;
				s_bBitmapsFull = false;
			}
		}
	}
	const int s100 = H9Round(scale * 100.0f);
	for (int i = 0; i < s_numBitmaps; i++)
	{
		const BitmapSlot& b = s_bitmaps[i];
		if (b.art == art && b.wide == wide && b.tall == tall && b.scale100 == s100)
			return b.bitmap;
	}

	if (s_numBitmaps >= MAX_BITMAPS)
	{
		if (!s_bBitmapsFull)
		{
			s_bBitmapsFull = true;
			gEngfuncs.Con_DPrintf("H9 VGUI: %d panel sizes drawn; a new size draws without its art\n", MAX_BITMAPS);
		}
		return nullptr;
	}
	CH9ArtBitmap* bitmap = new CH9ArtBitmap(art, wide, tall, scale);
	BitmapSlot& slot = s_bitmaps[s_numBitmaps++];
	slot.art = art;
	slot.wide = wide;
	slot.tall = tall;
	slot.scale100 = s100;
	slot.bitmap = bitmap;
	return bitmap;
}

// ---- fonts ------------------------------------------------------------------------------------

vgui::Font* H9Font(int which, int step)
{
	// The H9 panels' own ladders, four steps each, in textscheme\*_textscheme.txt: three quarters of the size of the scheme
	// the stock ladder (the second table of each pair) takes at the same step. A scheme file without them (a game folder
	// that has not been updated) gets the stock schemes at the same steps.
	static const char* const kText[] = {"H9 Text 1", "H9 Text 2", "H9 Text 3", "H9 Text 4"};
	static const char* const kDetail[] = {"H9 Detail 1", "H9 Detail 2", "H9 Detail 3", "H9 Detail 4"};
	static const char* const kFlash[] = {"H9 Flash 1", "H9 Flash 2", "H9 Flash 3", "H9 Flash 4"};
	static const char* const kTextStock[] = {"Primary Button Text", "CommandMenu Text", "Scoreboard Text", "Scoreboard Small Text"};
	static const char* const kDetailStock[] = {"Briefing Text", "Scoreboard Text", "Scoreboard Small Text", "Scoreboard Small Text"};
	static const char* const kFlashStock[] = {"Title Font", "Primary Button Text", "CommandMenu Text", "Scoreboard Text"};
	if (!gViewPort)
		return nullptr;
	step = H9Clamp(step, 0, 3);
	const char* name = (which == H9V_FONT_DETAIL) ? kDetail[step] : (which == H9V_FONT_FLASH) ? kFlash[step] : kText[step];
	const char* stock = (which == H9V_FONT_DETAIL) ? kDetailStock[step] : (which == H9V_FONT_FLASH) ? kFlashStock[step] : kTextStock[step];
	CSchemeManager* sm = gViewPort->GetSchemeManager();
	SchemeHandle_t handle = sm->getSchemeHandle(name);
	if (handle == 0) // not in this scheme file (the lookup answers the first scheme for a name it does not know)
		handle = sm->getSchemeHandle(stock);
	return sm->getFont(handle);
}

int H9FontTall(vgui::Font* font)
{
	return font ? H9Max(1, font->getTall()) : 12;
}

// A text's width in the font. The VGUI font measures a byte above 127 (the credit sign Apollo RP shows for money, the title's
// guillemets, in a Latin-1 view) as nothing, reading it as a negative character, though the surface draws it, so each is
// counted as the width of an "o". A text with none is measured whole, as before.
int H9TextWide(vgui::Font* font, const char* text)
{
	if (!font || !text || !text[0])
		return 0;
	char run[256];
	int n = 0, wide = 0, tall = 0, high = -1;
	for (const char* p = text;; p++)
	{
		const unsigned char c = (unsigned char)*p;
		if (c >= 128 || c == 0 || n == (int)sizeof(run) - 1)
		{
			if (n > 0)
			{
				int w = 0;
				run[n] = 0;
				font->getTextSize(run, w, tall);
				wide += w;
				n = 0;
			}
			if (c == 0)
				break;
			if (c >= 128)
			{
				if (high < 0)
				{
					int w = 0;
					font->getTextSize("o", w, tall);
					high = w;
				}
				wide += high;
				continue;
			}
		}
		run[n++] = (char)c;
	}
	return wide;
}

// ---- CH9Surface -------------------------------------------------------------------------------

CH9Surface::CH9Surface() : vgui::Panel(0, 0, 64, 64), m_pArt(nullptr), m_flScale(1.0f), m_iAlpha(255), m_bPlainBox(true)
{
	setPaintBorderEnabled(false);
	setPaintBackgroundEnabled(true);
	setPaintEnabled(true);
	setVisible(false);
}

void CH9Surface::SetArt(const CH9Art* art, float scale)
{
	m_pArt = art;
	m_flScale = scale;
}

void CH9Surface::SetAlpha(int alpha)
{
	m_iAlpha = H9Clamp(alpha, 0, 255);
}

void CH9Surface::ContentBox(int& x0, int& y0, int& x1, int& y1)
{
	int wide, tall;
	getSize(wide, tall);
	if (m_pArt)
	{
		x0 = H9Round(m_pArt->insetL * m_flScale);
		y0 = H9Round(m_pArt->insetT * m_flScale);
		x1 = wide - H9Round(m_pArt->insetR * m_flScale);
		y1 = tall - H9Round(m_pArt->insetB * m_flScale);
	}
	else
	{
		x0 = 8;
		y0 = 6;
		x1 = wide - 8;
		y1 = tall - 6;
	}
}

vgui::Panel* CH9Surface::isWithinTraverse(int x, int y)
{
	return nullptr;
}

void CH9Surface::paintBackground()
{
	int wide, tall;
	getSize(wide, tall);
	if (m_pArt)
	{
		CH9ArtBitmap* bitmap = H9ArtBitmap(m_pArt, wide, tall, m_flScale);
		if (bitmap)
		{
			bitmap->SetAlpha(m_iAlpha);
			bitmap->setPos(0, 0);
			bitmap->doPaint(this);
			return;
		}
	}
	if (m_bPlainBox)
		Box(0, 0, wide, tall, BOX_R, BOX_G, BOX_B, 210);
}

void CH9Surface::Text(vgui::Font* font, int x, int y, const char* text, int r, int g, int b)
{
	if (!font || !text || !text[0])
		return;
	h9theme::Tint(r, g, b); // every colour of the panels is taken in the player's colour (h9_theme.h)
	drawSetTextFont(font);
	drawSetTextColor(r, g, b, 255 - m_iAlpha);
	drawSetTextPos(x, y);
	drawPrintText(text, (int)strlen(text));
}

void CH9Surface::Box(int x0, int y0, int x1, int y1, int r, int g, int b, int alpha)
{
	const int a = alpha * m_iAlpha / 255;
	h9theme::Tint(r, g, b);
	drawSetColor(r, g, b, 255 - H9Clamp(a, 0, 255));
	drawFilledRect(x0, y0, x1, y1);
}

void CH9Surface::Frame(int x0, int y0, int x1, int y1, int r, int g, int b, int alpha)
{
	const int a = alpha * m_iAlpha / 255;
	h9theme::Tint(r, g, b);
	drawSetColor(r, g, b, 255 - H9Clamp(a, 0, 255));
	drawOutlinedRect(x0, y0, x1, y1);
}

// ---- the pictures of items --------------------------------------------------------------------

int H9ItemPicture(const char* itemName)
{
	LoadPictures();
	if (!itemName || !itemName[0])
		return -1;
	for (int i = 0; i < s_numPictureNames; i++)
	{
		if (0 == strcmp(s_pictureNames[i].name, itemName))
			return s_pictureNames[i].frame;
	}
	return -1;
}

CH9PicturePanel::CH9PicturePanel() : m_iFrame(-1), m_iTimes(1), m_iSide(PICTURE_PX)
{
	m_bPlainBox = false;
	setSize(m_iSide, m_iSide);
}

bool CH9PicturePanel::SetPicture(int frame, int times)
{
	times = H9Clamp(times, 1, 6);
	if (!PictureBitmap(frame, times))
		return false;
	m_iFrame = frame;
	m_iTimes = times;
	m_iSide = PICTURE_PX * times;
	setSize(m_iSide, m_iSide);
	return true;
}

void CH9PicturePanel::paint()
{
	CH9PictureBitmap* bitmap = PictureBitmap(m_iFrame, m_iTimes);
	if (!bitmap)
		return;
	bitmap->SetAlpha(m_iAlpha);
	bitmap->setPos(0, 0);
	bitmap->doPaint(this);
}

// ---- CH9MenuPanel -----------------------------------------------------------------------------

CH9MenuPanel::CH9MenuPanel() : m_pFont(nullptr), m_pDetail(nullptr), m_iRowTall(16), m_iDetailTall(12), m_iNumberWide(16), m_bFooter(false)
{
	memset(&m_Def, 0, sizeof(m_Def));
}

void CH9MenuPanel::SetMenu(const H9MenuDef& def)
{
	m_Def = def;
	Layout();
}

void CH9MenuPanel::Layout()
{
	const CH9Art* art = nullptr;
	if (m_Def.style != H9V_STYLE_PLAIN)
		art = CH9Art::Find(m_Def.style == H9V_STYLE_BANNER ? "#banner" : "#panel");
	const float s = ArtScale(H9_MENU_SCALE);
	SetArt(art, s);

	int wide = H9Round((art ? art->wide : 256) * s);
	int tall = H9Round((art ? art->tall : 256) * s);
	const int inL = art ? H9Round(art->insetL * s) : 8, inT = art ? H9Round(art->insetT * s) : 6;
	const int inR = art ? H9Round(art->insetR * s) : 8, inB = art ? H9Round(art->insetB * s) : 6;

	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	const int maxWide = H9Max(64, ScreenWidth * 38 / 100 - 24); // short of the crosshair box

	// The rows' height with a given pair of fonts: title, rows (a gap row is half more), footer.
	auto height = [&](vgui::Font* font, vgui::Font* detail, bool footer) -> int {
		const int row = H9FontTall(font) + H9FontTall(font) / 5;
		int h = 0;
		if (m_Def.title[0])
			h += row + row / 3;
		for (int i = 0; i < m_Def.numRows; i++)
			h += row + ((m_Def.rows[i].flags & H9V_ROW_GAP) ? row / 2 : 0);
		if (footer)
			h += H9FontTall(detail) + row / 3;
		return h;
	};

	// The first fonts the rows fit in; the footer goes before the fonts get smaller.
	bool footer = m_Def.footer[0] != 0;
	int step = 0;
	for (; step < 3; step++)
	{
		vgui::Font* f = H9Font(H9V_FONT_TEXT, step);
		vgui::Font* d = H9Font(H9V_FONT_DETAIL, step);
		if (height(f, d, footer) <= tall - inT - inB)
			break;
		if (footer && height(f, d, false) <= tall - inT - inB)
		{
			footer = false;
			break;
		}
	}
	if (step == 3)
	{
		step = 2;
		footer = false;
	}
	m_pFont = H9Font(H9V_FONT_TEXT, step);
	m_pDetail = H9Font(H9V_FONT_DETAIL, step);
	m_bFooter = footer;
	m_iRowTall = H9FontTall(m_pFont) + H9FontTall(m_pFont) / 5;
	m_iDetailTall = H9FontTall(m_pDetail);
	m_iNumberWide = H9TextWide(m_pFont, "0. ") + 2;

	// Taller only when the smallest fonts still do not fit: inside the safe area when it has the
	// room, else on down over the chat band (a phone's screen), so no row is ever cut off.
	const int need = height(m_pFont, m_pDetail, m_bFooter);
	if (need > tall - inT - inB)
		tall = H9Max(tall, H9Min(ScreenHeight - sy0, need + inT + inB));

	// Wider when a row needs it: text is never squeezed. In steps of 8 px, so a menu whose counts
	// change makes few sizes of art.
	int widest = H9TextWide(m_pFont, m_Def.title);
	for (int i = 0; i < m_Def.numRows; i++)
	{
		const H9MenuRow& r = m_Def.rows[i];
		int w = (r.key ? m_iNumberWide : 0) + H9TextWide(m_pFont, r.label);
		if (r.detail[0])
			w += m_iNumberWide / 2 + H9TextWide(m_pDetail, r.detail);
		widest = H9Max(widest, w);
	}
	if (m_bFooter)
		widest = H9Max(widest, H9TextWide(m_pDetail, m_Def.footer));
	if (widest > wide - inL - inR)
		wide = H9Min(maxWide, (widest + inL + inR + 7) / 8 * 8);

	setSize(wide, tall);

	// The left column, as the AMX text menus are: 16 px in, the top at 0.34 of the height.
	int x = 16;
	int y = H9Max(sy0, ScreenHeight * 34 / 100);
	if (y + tall > sy1)
		y = H9Max(sy0, sy1 - tall);
	Place(x, y, wide, tall);
	setPos(x, y);
}

void CH9MenuPanel::paint()
{
	int x0, y0, x1, y1;
	ContentBox(x0, y0, x1, y1);
	int tr, tg, tb;
	H9TextColour(tr, tg, tb);
	const int fontTall = H9FontTall(m_pFont);
	const int line = H9Max(1, m_iRowTall / 14);

	int y = y0;
	if (m_Def.title[0])
	{
		Text(m_pFont, x0, y + (m_iRowTall - fontTall) / 2, m_Def.title, LIT_R, LIT_G, LIT_B);
		y += m_iRowTall;
		Box(x0, y + m_iRowTall / 8, x1, y + m_iRowTall / 8 + line, RAIL_R, RAIL_G, RAIL_B, 255);
		y += m_iRowTall / 3;
	}

	for (int i = 0; i < m_Def.numRows; i++)
	{
		const H9MenuRow& r = m_Def.rows[i];
		if (r.flags & H9V_ROW_GAP)
			y += m_iRowTall / 2;

		const bool keyed = r.key >= 1 && r.key <= 10;
		const bool pressable = keyed && (m_Def.keys & (1 << (r.key - 1))) != 0 && (r.flags & H9V_ROW_OFF) == 0;
		const bool dim = !pressable || (r.flags & H9V_ROW_DIM) != 0;

		if (r.flags & H9V_ROW_HOT)
			Box(x0 - 4, y, x1 + 4, y + m_iRowTall, HOT_R, HOT_G, HOT_B, 96);

		const int ty = y + (m_iRowTall - fontTall) / 2;
		int lx = x0;
		if (keyed)
		{
			char number[4];
			snprintf(number, sizeof(number), "%d.", r.key % 10);
			if (dim)
				Text(m_pFont, x0, ty, number, DIM_R, DIM_G, DIM_B);
			else
				Text(m_pFont, x0, ty, number, LIT_R, LIT_G, LIT_B);
			lx = x0 + m_iNumberWide;
		}

		if (r.flags & H9V_ROW_RED)
			Text(m_pFont, lx, ty, r.label, RED_R, RED_G, RED_B);
		else if (dim)
			Text(m_pFont, lx, ty, r.label, DIM_R, DIM_G, DIM_B);
		else
			Text(m_pFont, lx, ty, r.label, tr, tg, tb);

		if (r.detail[0])
		{
			const int dx = lx + H9TextWide(m_pFont, r.label) + m_iNumberWide / 2;
			const int dy = y + (m_iRowTall - m_iDetailTall) / 2;
			if (dim)
				Text(m_pDetail, dx, dy, r.detail, DIM_R, DIM_G, DIM_B);
			else
				Text(m_pDetail, dx, dy, r.detail, DET_R, DET_G, DET_B);
		}
		y += m_iRowTall;
	}

	if (m_bFooter)
		Text(m_pDetail, x0, y1 - m_iDetailTall, m_Def.footer, DIM_R, DIM_G, DIM_B);
}

// ---- CH9NoticePanel ---------------------------------------------------------------------------

CH9NoticePanel::CH9NoticePanel() : m_pFont(nullptr), m_iLineTall(16), m_iLines(0)
{
	m_bPlainBox = false;
	memset(&m_Def, 0, sizeof(m_Def));
	memset(m_szLines, 0, sizeof(m_szLines));
}

void CH9NoticePanel::SetNotice(const H9NoticeDef& def)
{
	m_Def = def;
	m_iLines = 0;
	const char* p = m_Def.text;
	while (m_iLines < 6)
	{
		const char* e = strchr(p, '\n');
		const int n = H9Min(e ? (int)(e - p) : (int)strlen(p), H9V_NOTICE_LEN - 1);
		memcpy(m_szLines[m_iLines], p, n);
		m_szLines[m_iLines][n] = 0;
		m_iLines++;
		if (!e)
			break;
		p = e + 1;
	}
}

void CH9NoticePanel::Layout(int maxTall)
{
	const bool hasArt = m_Def.style == H9V_NOTICE_BANNER || m_Def.style == H9V_NOTICE_BAR;
	const CH9Art* art = hasArt ? CH9Art::Find("#banner") : nullptr;
	const int which = (m_Def.style == H9V_NOTICE_FLASH) ? H9V_FONT_FLASH : H9V_FONT_TEXT;
	const bool bar = m_Def.style == H9V_NOTICE_BAR && m_Def.value >= 0;
	const float s0 = ArtScale(H9_BANNER_SCALE);
	float s = s0;

	int wide = 0, tall = 0;
	for (int pass = 0; pass < 2; pass++)
	{
		SetArt(art, s);
		int inL = 8, inT = 4, inR = 8, inB = 4;
		if (art)
		{
			inL = H9Round(art->insetL * s);
			inT = H9Round(art->insetT * s);
			inR = H9Round(art->insetR * s);
			inB = H9Round(art->insetB * s);
			wide = H9Round(art->wide * s);
			tall = H9Round(art->tall * s);
		}

		// The first font the lines fit in; then the panel grows to them.
		int step = 0, need = 0;
		for (; step < 4; step++)
		{
			m_pFont = H9Font(which, step);
			m_iLineTall = H9FontTall(m_pFont) + H9FontTall(m_pFont) / 8;
			need = m_iLines * m_iLineTall + (bar ? H9Max(4, m_iLineTall / 3) + 4 : 0);
			if (!art || need <= tall - inT - inB)
				break;
		}
		if (step == 4)
			step = 3;
		int widest = 0;
		for (int i = 0; i < m_iLines; i++)
			widest = H9Max(widest, H9TextWide(m_pFont, m_szLines[i]));
		if (art)
		{
			// In steps of 16 px of width, so notices of every length make few sizes of art. A
			// single line is no taller than its text and the art's corners: a slim banner, so
			// several stack above the crosshair.
			if (m_iLines == 1)
				tall = H9Max(need + inT + inB, H9Round(2 * art->corner * s));
			else
				tall = H9Max(tall, need + inT + inB);
			wide = H9Max(wide, (widest + inL + inR + 15) / 16 * 16);
		}
		else
		{
			tall = need + inT + inB;
			wide = widest + inL + inR + 2;
		}
		wide = H9Min(wide, ScreenWidth / 2);

		// The banner keeps above the line it was given, at half its art's size at most.
		if (pass == 0 && art && maxTall > 0 && tall > maxTall && s > s0 * 0.5f)
		{
			s = s0 * (float)maxTall / (float)tall;
			if (s < s0 * 0.5f)
				s = s0 * 0.5f;
			continue;
		}
		break;
	}
	setSize(H9Max(8, wide), H9Max(8, tall));
}

void CH9NoticePanel::paint()
{
	int x0, y0, x1, y1;
	ContentBox(x0, y0, x1, y1);
	int r = m_Def.r, g = m_Def.g, b = m_Def.b;
	if (r == 0 && g == 0 && b == 0)
		H9TextColour(r, g, b);

	const bool bar = m_Def.style == H9V_NOTICE_BAR && m_Def.value >= 0;
	const int barTall = bar ? H9Max(4, m_iLineTall / 3) : 0;
	const int block = m_iLines * m_iLineTall + (bar ? barTall + 4 : 0);
	int y = y0 + H9Max(0, (y1 - y0 - block) / 2);
	const int fontTall = H9FontTall(m_pFont);
	for (int i = 0; i < m_iLines; i++)
	{
		const int w = H9TextWide(m_pFont, m_szLines[i]);
		const int x = x0 + H9Max(0, (x1 - x0 - w) / 2);
		const int ty = y + (m_iLineTall - fontTall) / 2;
		if (!m_pArt)
			Text(m_pFont, x + 1, ty + 1, m_szLines[i], 0, 0, 0); // a shadow, for text over the world
		Text(m_pFont, x, ty, m_szLines[i], r, g, b);
		y += m_iLineTall;
	}
	if (bar)
	{
		y += 4;
		Box(x0, y, x1, y + barTall, 0, 0, 0, 160);
		const int fill = x0 + (x1 - x0) * H9Clamp(m_Def.value, 0, 1000) / 1000;
		if (fill > x0)
			Box(x0, y, fill, y + barTall, r, g, b, 255);
		Frame(x0, y, x1, y + barTall, RAIL_R, RAIL_G, RAIL_B, 255);
	}
}

// ---- CH9ServerPanel ---------------------------------------------------------------------------

CH9ServerPanel::CH9ServerPanel() : m_flUnit(1.0f)
{
	memset(&m_Def, 0, sizeof(m_Def));
}

void CH9ServerPanel::SetDef(const H9PanelDef& def)
{
	m_Def = def;
	Layout();
}

void CH9ServerPanel::Layout()
{
	const CH9Art* art = BuiltinArt(m_Def.art);
	const bool banner = art && 0 == strcmp(m_Def.art, "#banner");
	const float s = ArtScale(banner ? H9_BANNER_SCALE : H9_MENU_SCALE);
	SetArt(art, s);
	m_flUnit = ((float)ScreenHeight / 480.0f) * UserScale();

	int wide = m_Def.w > 0 ? H9Round(m_Def.w * m_flUnit) : (art ? H9Round(art->wide * s) : H9Round(200 * m_flUnit));
	int tall = m_Def.h > 0 ? H9Round(m_Def.h * m_flUnit) : (art ? H9Round(art->tall * s) : H9Round(100 * m_flUnit));
	wide = H9Clamp(wide, 16, ScreenWidth * 45 / 100);
	tall = H9Clamp(tall, 16, ScreenHeight * 55 / 100);

	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	const int anchor = H9Clamp(m_Def.anchor, 0, 8);
	int x, y;
	switch (anchor % 3)
	{
	case 0:
		x = sx0 + 16;
		break;
	case 1:
		x = (sx0 + sx1 - wide) / 2;
		break;
	default:
		x = sx1 - 16 - wide;
		break;
	}
	switch (anchor / 3)
	{
	case 0:
		y = sy0;
		break;
	case 1:
		y = (sy0 + sy1 - tall) / 2;
		break;
	default:
		y = sy1 - tall;
		break;
	}
	x += H9Round(m_Def.x * m_flUnit);
	y += H9Round(m_Def.y * m_flUnit);
	setSize(wide, tall);
	Place(x, y, wide, tall);
	setPos(x, y);
}

void CH9ServerPanel::CtrlRect(const H9CtrlDef& c, int& x0, int& y0, int& x1, int& y1)
{
	int bx0, by0, bx1, by1;
	ContentBox(bx0, by0, bx1, by1);
	const int w = H9Clamp(H9Round(c.w * m_flUnit), 1, H9Max(1, bx1 - bx0));
	const int h = H9Clamp(H9Round(c.h * m_flUnit), 1, H9Max(1, by1 - by0));
	int x, y;
	switch (H9Clamp(c.anchor, 0, 8) % 3)
	{
	case 0:
		x = bx0;
		break;
	case 1:
		x = (bx0 + bx1 - w) / 2;
		break;
	default:
		x = bx1 - w;
		break;
	}
	switch (H9Clamp(c.anchor, 0, 8) / 3)
	{
	case 0:
		y = by0;
		break;
	case 1:
		y = (by0 + by1 - h) / 2;
		break;
	default:
		y = by1 - h;
		break;
	}
	x0 = x + H9Round(c.x * m_flUnit);
	y0 = y + H9Round(c.y * m_flUnit);
	x1 = x0 + w;
	y1 = y0 + h;
}

void CH9ServerPanel::paint()
{
	int tr, tg, tb;
	H9TextColour(tr, tg, tb);
	for (int i = 1; i <= H9V_MAX_CTRLS; i++)
	{
		const H9CtrlDef& c = m_Def.ctrls[i];
		if (!c.used || (c.flags & 1))
			continue;
		const bool disabled = (c.flags & 2) != 0;
		int x0, y0, x1, y1;
		CtrlRect(c, x0, y0, x1, y1);

		int r = tr, g = tg, b = tb;
		if (c.a > 0)
		{
			r = c.r;
			g = c.g;
			b = c.b;
		}
		else if (c.font == H9V_FONT_TITLE)
		{
			r = LIT_R;
			g = LIT_G;
			b = LIT_B;
		}
		if (disabled)
		{
			r = DIM_R;
			g = DIM_G;
			b = DIM_B;
		}

		switch (c.type)
		{
		case H9V_CTRL_LABEL:
		case H9V_CTRL_BUTTON:
		{
			char text[H9V_CTRL_TEXT + 8];
			if (c.type == H9V_CTRL_BUTTON && c.key >= 1 && c.key <= 10)
				snprintf(text, sizeof(text), "%d. %s", c.key % 10, c.text);
			else
				snprintf(text, sizeof(text), "%s", c.text);
			if (c.type == H9V_CTRL_BUTTON)
			{
				Box(x0, y0, x1, y1, BOX_R, BOX_G, BOX_B, 150);
				Frame(x0, y0, x1, y1, RAIL_R, RAIL_G, RAIL_B, disabled ? 120 : 255);
			}
			vgui::Font* font = H9Font(c.font == H9V_FONT_TITLE ? H9V_FONT_TEXT : c.font, 0);
			const int w = H9TextWide(font, text);
			const int th = H9FontTall(font);
			int x = x0 + (c.type == H9V_CTRL_BUTTON ? 4 : 0);
			if (c.align == 1 || c.type == H9V_CTRL_BUTTON)
				x = x0 + H9Max(0, (x1 - x0 - w) / 2);
			else if (c.align == 2)
				x = x1 - w;
			Text(font, x, y0 + (y1 - y0 - th) / 2, text, r, g, b);
			break;
		}
		case H9V_CTRL_PROGRESS:
		{
			Box(x0, y0, x1, y1, 0, 0, 0, 160);
			const int fill = x0 + (x1 - x0) * H9Clamp(c.value, 0, 1000) / 1000;
			if (fill > x0)
			{
				if (c.a > 0)
					Box(x0, y0, fill, y1, c.r, c.g, c.b, 255);
				else
					Box(x0, y0, fill, y1, LIT_R, LIT_G, LIT_B, 255);
			}
			Frame(x0, y0, x1, y1, RAIL_R, RAIL_G, RAIL_B, 255);
			break;
		}
		case H9V_CTRL_IMAGE:
		{
			const CH9Art* art = BuiltinArt(c.text);
			CH9ArtBitmap* bitmap = H9ArtBitmap(art, x1 - x0, y1 - y0, m_flScale);
			if (bitmap)
			{
				bitmap->SetAlpha(m_iAlpha);
				bitmap->setPos(x0, y0);
				bitmap->doPaint(this);
			}
			break;
		}
		default:
			break;
		}
	}
}
// ---- end H9 VGUI ------------------------------------------------------------------------------
