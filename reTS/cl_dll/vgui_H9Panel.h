// ---- H9 VGUI: the panels -----------------------------------------------------------------------
// What h9_vgui.cpp shows for a server: the twin of an AMX text menu (CH9MenuPanel), a notice
// (CH9NoticePanel) and a plugin's own layout (CH9ServerPanel). Each draws its art, the
// sprites/tsm_panel.spr or sprites/tsm_banner.spr frame through a nine-slice, and its text in the
// textscheme fonts, and none of them ever takes the mouse or the keyboard (docs\H9_VGUI.txt).
#pragma once

#include <VGUI_Panel.h>
#include <VGUI_Bitmap.h>
#include <VGUI_Font.h>
#include <VGUI_Color.h>

#include "h9_vgui.h"

// A built-in art: frame 0 of a sprite as RGBA, and where its text goes, in art pixels.
struct CH9Art
{
	int wide;
	int tall;
	unsigned char* rgba; // wide * tall * 4
	int insetL, insetT, insetR, insetB; // the content box: inside the rail and the brackets
	int corner;                         // the nine-slice corner: chamfer, rim and a bracket's arm

	// "#panel" or "#banner", read from the sprite once; NULL when the sprite is missing or broken.
	static const CH9Art* Find(const char* name);
};

// An art resampled to a size in pixels through its nine-slice: the corners at the art's scale,
// the edges stretched along their length, the middle both ways. Nearest-neighbour, the art being
// pixel art. Each is kept for the life of the client, per art and size (H9ArtBitmap), since
// VGUI1 frees no texture; NULL once 64 sizes are made.
class CH9ArtBitmap : public vgui::Bitmap
{
public:
	CH9ArtBitmap(const CH9Art* art, int wide, int tall, float scale);
	void SetAlpha(int alpha); // 255 opaque
};
CH9ArtBitmap* H9ArtBitmap(const CH9Art* art, int wide, int tall, float scale);

// The base of every H9 panel: its art behind it, its text in the scheme fonts, deaf to input.
class CH9Surface : public vgui::Panel
{
public:
	CH9Surface();

	void SetArt(const CH9Art* art, float scale); // NULL for a plain dark box
	void SetAlpha(int alpha);                    // 255 opaque
	void ContentBox(int& x0, int& y0, int& x1, int& y1);

	// Never under the cursor, so a click always reaches what is behind it.
	vgui::Panel* isWithinTraverse(int x, int y) override;

protected:
	void paintBackground() override;

	void Text(vgui::Font* font, int x, int y, const char* text, int r, int g, int b);
	void Box(int x0, int y0, int x1, int y1, int r, int g, int b, int alpha);
	void Frame(int x0, int y0, int x1, int y1, int r, int g, int b, int alpha);

	const CH9Art* m_pArt;
	float m_flScale;
	int m_iAlpha;
	bool m_bPlainBox; // without art: a dark box behind (a menu, a panel), or nothing (a notice)
};

// The fonts every panel draws in: the textscheme's schemes, stepped down when text must fit.
vgui::Font* H9Font(int which, int step);
int H9TextWide(vgui::Font* font, const char* text);
int H9FontTall(vgui::Font* font);

// The twin of an AMX text menu: a title, numbered rows with details, a footer, on the panel art.
class CH9MenuPanel : public CH9Surface
{
public:
	CH9MenuPanel();
	void SetMenu(const H9MenuDef& def);
	void Layout(); // size from the art and the text, place in the left column of the safe area
	const char* Id() const { return m_Def.id; }

protected:
	void paint() override;

private:
	H9MenuDef m_Def;
	vgui::Font* m_pFont;
	vgui::Font* m_pDetail;
	int m_iRowTall;
	int m_iDetailTall;
	int m_iNumberWide;
	bool m_bFooter;
};

// A notice: one to six lines on the banner art, plain, large (a flash) or over a progress bar.
class CH9NoticePanel : public CH9Surface
{
public:
	CH9NoticePanel();
	void SetNotice(const H9NoticeDef& def);
	void Layout(int maxTall); // its size; a banner's scale comes down to keep within maxTall (0: none)
	const H9NoticeDef& Def() const { return m_Def; }

protected:
	void paint() override;

private:
	H9NoticeDef m_Def;
	vgui::Font* m_pFont;
	int m_iLineTall;
	int m_iLines;
	char m_szLines[6][H9V_NOTICE_LEN];
};

// A plugin's own panel: labels, built-in images, buttons on number keys and progress bars.
class CH9ServerPanel : public CH9Surface
{
public:
	CH9ServerPanel();
	void SetDef(const H9PanelDef& def);
	void Layout();
	const H9PanelDef& Def() const { return m_Def; }
	H9PanelDef& EditDef() { return m_Def; }

protected:
	void paint() override;

private:
	void CtrlRect(const H9CtrlDef& c, int& x0, int& y0, int& x1, int& y1);
	H9PanelDef m_Def;
	float m_flUnit; // pixels a virtual unit
};
// ---- end H9 VGUI ------------------------------------------------------------------------------
