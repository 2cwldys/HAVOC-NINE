//========= Copyright (C) 1996-2002, Valve LLC, All rights reserved. ============
//
// Purpose:
//
// $NoKeywords: $
//=============================================================================

#pragma once

#include <VGUI_Panel.h>
#include <VGUI_TablePanel.h>
#include <VGUI_HeaderPanel.h>
#include <VGUI_TextGrid.h>
#include <VGUI_Label.h>
#include <VGUI_TextImage.h>
#include <VGUI_Bitmap.h>
#include <VGUI_Font.h>
#include "../game_shared/vgui_listbox.h"

#include <ctype.h>

#define MAX_SCORES 10
#define MAX_SCOREBOARD_TEAMS 5

// The cells of every scoreboard row, left to right.
#define SB_CELL_AVATAR 0  // the player's picture, or the default silhouette
#define SB_CELL_STATUS 1  // the TSPAward / spectating status, in short form
#define SB_CELL_NAME 2
#define SB_CELL_KILLS 3
#define SB_CELL_DEATHS 4
#define SB_CELL_ASSISTS 5
#define SB_CELL_LIVES 6   // H9 LIVES: lives left / the class's lives, from H9Lives
#define SB_CELL_PING 7
#define SB_CELL_VOICE 8
#define SB_NUM_CELLS 9

// Two columns side by side: team 1 left, team 2 right (free-for-all: places 1-32 left, the rest
// right). Each column has this many row widgets; 64 players with their team headers take at most
// 35 of them.
#define SB_NUM_COLUMNS 2
#define SB_ROWS_PER_COLUMN 40
#define SB_NUM_ROWS (SB_NUM_COLUMNS * SB_ROWS_PER_COLUMN)
// H9 SCROLL: the rows one column may hold when it scrolls (cl_h9_scoreboard_scroll): every
// player of a side with its header, and a header for each team that continues there.
#define SB_ROWS_LOGICAL (MAX_PLAYERS_HUD + 2 * MAX_SCOREBOARD_TEAMS + 4)

using namespace vgui;

class CTextImage2 : public Image
{
public:
	CTextImage2()
	{
		_image[0] = new TextImage("");
		_image[1] = new TextImage("");
	}

	~CTextImage2()
	{
		delete _image[0];
		delete _image[1];
	}

	TextImage* GetImage(int image)
	{
		return _image[image];
	}

	void getSize(int& wide, int& tall) override
	{
		int w1, w2, t1, t2;
		_image[0]->getTextSize(w1, t1);
		_image[1]->getTextSize(w2, t2);

		wide = w1 + w2;
		tall = V_max(t1, t2);
		setSize(wide, tall);
	}

	void doPaint(Panel* panel) override
	{
		_image[0]->doPaint(panel);
		_image[1]->doPaint(panel);
	}

	void setPos(int x, int y) override
	{
		_image[0]->setPos(x, y);

		int swide, stall;
		_image[0]->getSize(swide, stall);

		int wide, tall;
		_image[1]->getSize(wide, tall);
		_image[1]->setPos(x + wide, y + (stall * 0.9) - tall);
	}

	void setColor(Color color) override
	{
		_image[0]->setColor(color);
	}

	void setColor2(Color color)
	{
		_image[1]->setColor(color);
	}

private:
	TextImage* _image[2];
};

//-----------------------------------------------------------------------------
// Purpose: Custom label for the scoreboard's cells
//-----------------------------------------------------------------------------
class CLabelHeader : public Label
{
public:
	CLabelHeader() : Label("")
	{
		_dualImage = new CTextImage2();
		_dualImage->setColor2(Color(255, 170, 0, 0));
		_row = -2;
		_useFgColorAsImageColor = true;
		_offset[0] = 0;
		_offset[1] = 0;
	}

	~CLabelHeader()
	{
		delete _dualImage;
	}

	void setRow(int row)
	{
		_row = row;
	}

	void setFgColorAsImageColor(bool state)
	{
		_useFgColorAsImageColor = state;
	}

	void setText(int textBufferLen, const char* text) override
	{
		_dualImage->GetImage(0)->setText(text);

		// calculate the text size
		Font* font = _dualImage->GetImage(0)->getFont();
		_gap = 0;
		for (const char* ch = text; *ch != 0; ch++)
		{
			int a, b, c;
			font->getCharABCwide(*ch, a, b, c);
			_gap += (a + b + c);
		}

		_gap += XRES(5);
	}

	virtual void setText(const char* text)
	{
		// strip any non-alnum characters from the end
		char buf[512];
		strncpy(buf, text, sizeof(buf) - 1);
		buf[sizeof(buf) - 1] = 0;

		int len = strlen(buf);
		while (len && isspace(buf[--len]))
		{
			buf[len] = 0;
		}

		CLabelHeader::setText(0, buf);
	}

	void setText2(const char* text)
	{
		_dualImage->GetImage(1)->setText(text);
	}

	void getTextSize(int& wide, int& tall) override
	{
		_dualImage->getSize(wide, tall);
	}

	void setFgColor(int r, int g, int b, int a) override
	{
		Label::setFgColor(r, g, b, a);
		Color color(r, g, b, a);
		_dualImage->setColor(color);
		_dualImage->setColor2(color);
		repaint();
	}

	void setFgColor(Scheme::SchemeColor sc) override
	{
		int r, g, b, a;
		Label::setFgColor(sc);
		Label::getFgColor(r, g, b, a);

		// Call the r,g,b,a version so it sets the color in the dualImage..
		setFgColor(r, g, b, a);
	}

	void setFont(Font* font) override
	{
		_dualImage->GetImage(0)->setFont(font);
	}

	void setFont2(Font* font)
	{
		_dualImage->GetImage(1)->setFont(font);
	}

	// this adjust the absolute position of the text after alignment is calculated
	void setTextOffset(int x, int y)
	{
		_offset[0] = x;
		_offset[1] = y;
	}

	void paint() override;
	void paintBackground() override;
	void calcAlignment(int iwide, int itall, int& x, int& y);

private:
	CTextImage2* _dualImage;
	int _row;
	int _gap;
	int _offset[2];
	bool _useFgColorAsImageColor;
};

//-----------------------------------------------------------------------------
// Purpose: An avatar picture as the scoreboard draws it: an opaque square bitmap
//          the size of one avatar cell. Built from a picture's RGBA pixels scaled
//          to the cell, or, with no pixels, the default silhouette.
//-----------------------------------------------------------------------------
class CAvatarBitmap : public vgui::Bitmap
{
public:
	// icon: the link icon laid over a corner (H9 LINK ICONS in vgui_ScorePanel.cpp), 0 for none
	CAvatarBitmap(int size, const unsigned char* rgba, int wide, int tall, int icon = 0);
};

// A player's picture for the avatar cell, by player slot. pixels is NULL until a picture for the
// slot has been fetched, and the cell shows the default silhouette until then (always, on a
// server that sends no pictures). version is the picture's version as the server announced it,
// so a changed picture is fetched again. bitmap is pixels drawn at bitmapSize, the cell size it
// was last drawn for; the scoreboard rebuilds it when the cell size changes.
struct ScoreAvatar
{
	unsigned char* pixels; // wide * tall * 4 bytes, RGBA, row-major
	int wide;
	int tall;
	int version;
	CAvatarBitmap* bitmap;
	int bitmapSize;
	int bitmapIcon; // the link icon bitmap was drawn with (H9 LINK ICONS)
};

extern ScoreAvatar g_PlayerAvatars[MAX_PLAYERS_HUD + 1];

// Set when this map's server has sent an H9Assists message; until then the assists column and
// the team assist totals stay empty (stock servers count no assists).
extern bool g_bScoreAssists;

// ---- H9 LIVES: set while this map's server counts lives (H9's ts_matchmode, H9Lives); until then
// the lives column and the team lives totals stay empty.
extern bool g_bScoreLives;
#define SB_LIVES_ENDLESS 255 // lives left on a side that never runs out

class ScoreTablePanel;

#include "../game_shared/vgui_grid.h"
#include "../game_shared/vgui_defaultinputsignal.h"

//-----------------------------------------------------------------------------
// Purpose: Scoreboard back panel
//-----------------------------------------------------------------------------
class ScorePanel : public Panel, public vgui::CDefaultInputSignal
{
private:
	// Default panel implementation doesn't forward mouse messages when there is no cursor and we need them.
	class HitTestPanel : public Panel
	{
	public:
		void internalMousePressed(MouseCode code) override;
	};

	// What a row widget shows.
	enum
	{
		ROW_NONE = 0, // hidden
		ROW_TEAM,	  // a team's header: name, (players), K, D, A, average ping
		ROW_CONT,	  // a team continued from the other column: "<team> (cont.)"
		ROW_PLAYER,	  // one player
		ROW_MORE,	  // "... N more" when the rows are full
	};

	struct ScoreRow
	{
		int kind;
		int index; // ROW_TEAM, ROW_CONT: the g_TeamInfo index (0 for free-for-all); ROW_PLAYER: the
				   // player slot; ROW_MORE: how many players did not fit
	};

	// One column's run of rows while the layout is built, and (m_Lists) as it is shown.
	struct ColumnFill
	{
		int used;
		ScoreRow rows[SB_ROWS_LOGICAL]; // H9 SCROLL: room for a column that scrolls
	};

	// A team, or the whole free-for-all list, in the order its players are shown.
	struct ScoreBlock
	{
		int team; // g_TeamInfo index; 0 for free-for-all
		int count;
		int players[MAX_PLAYERS_HUD];
	};

	Label m_TitleLabel;	 // the server name
	Label m_TitleInfo;	 // map and player count, right-aligned
	Label m_SpecLabel;	 // "Spectators (N): name, name ... +N"

	CLabelHeader m_HeaderLabels[SB_NUM_COLUMNS][SB_NUM_CELLS]; // the column titles, once per column
	CLabelHeader m_Cells[SB_NUM_ROWS][SB_NUM_CELLS];
	ScoreRow m_Rows[SB_NUM_ROWS]; // row widget r: column r / SB_ROWS_PER_COLUMN

	ScorePanel::HitTestPanel m_HitTestPanel;
	CommandButton* m_pCloseButton;

	// Geometry, in pixels, from the panel size (the constructor) and the row height (each layout).
	int m_iColumnX[SB_NUM_COLUMNS];
	int m_iColumnWide;
	int m_iRowsTop;
	int m_iRowsTall;
	int m_iRowTall;
	int m_iCellX[SB_NUM_CELLS]; // within a column
	int m_iCellWide[SB_NUM_CELLS];

	// Fonts for the current row height, and the silhouette drawn at the current avatar size.
	Font* m_pRowFont;
	Font* m_pHeadFont;
	Font* m_pSpecFont;
	int m_iFontRowTall;
	CAvatarBitmap* m_pSilhouette;
	int m_iAvatarSize;

	ScoreBlock m_Blocks[MAX_SCOREBOARD_TEAMS + 1];
	int m_iNumBlocks;

	// ---- H9 SCROLL: a column longer than the board scrolls, instead of ending in "... N more".
	// Row widget 0 of a column shows the column's first row (its team header), pinned; the others
	// show the rows from the scroll position on, inside the column's clip panel.
	ColumnFill m_Lists[SB_NUM_COLUMNS]; // every row each column holds
	Panel m_RowClip[SB_NUM_COLUMNS];	// the rows under the pinned one, clipped to the column
	Panel m_ScrollBar[SB_NUM_COLUMNS];	// the thin indicator at a scrolling column's edge
	int m_iRowY[SB_NUM_ROWS];			// each row widget's y within its parent
	float m_flScroll[SB_NUM_COLUMNS];	// how far each column is scrolled as drawn, in pixels
	float m_flScrollTarget[SB_NUM_COLUMNS];
	int m_iScrollMax[SB_NUM_COLUMNS];	// 0 when the column fits
	void MapRows();
	void PlaceClips();
	void PlaceScrollBars();
	// ---- end H9 SCROLL
	int m_iSpecPlayers[MAX_PLAYERS_HUD];
	int m_iNumSpec;

	void BuildBlocks();
	bool FlowBlocks(int capacity, ColumnFill* columns, bool truncate);
	void PlaceCells(int rowTall);
	void UpdateFonts(int rowTall);
	void UpdateAvatarBitmaps(int size);
	void FillRow(int r);
	void FillSpectators();
	void FitText(Font* font, const char* text, int wide, char* out, int outSize);
	Font* GetFontForTall(int tall, int weight);

public:
	int m_iNumTeams;
	int m_iPlayerNum;
	int m_iShowscoresHeld;
	int m_iHighlightRow; // the row widget under the mouse in squelch mode, or -1
	int m_iLastKilledBy;
	int m_fLastKillTime;

public:
	ScorePanel(int x, int y, int wide, int tall);

	void Update();

	void SortTeams();
	void RebuildTeams();

	void FillGrid();

	void DeathMsg(int killer, int victim);

	void Initialize();

	void Open();

	void MouseOverCell(int row, int col);
	int ProfileSlotAt(Panel* panel); // H9 PROFILES: the slot a double-click on this panel opens, or 0

	// ---- H9 SCROLL
	bool ScrollInput(int dir, bool page); // a wheel notch or a page key; true when the board took it
	void ScrollThink();					  // every frame while the board is up: the eased motion
	void ResetScroll();
	// ---- end H9 SCROLL

	// InputSignal overrides.
public:
	void mousePressed(MouseCode code, Panel* panel) override;
	void mouseDoublePressed(MouseCode code, Panel* panel) override; // H9 PROFILES
	void cursorMoved(int x, int y, Panel* panel) override;

	friend class CLabelHeader;
};
