//=========== (C) Copyright 1999 Valve, L.L.C. All rights reserved. ===========
//
// The copyright to the contents herein is the property of Valve, L.L.C.
// The contents may be used and/or copied only with the written permission of
// Valve, L.L.C., or in accordance with the terms and conditions stipulated in
// the agreement/contract under which the contents have been supplied.
//
// Purpose: VGUI scoreboard
//
// $Workfile:     $
// $Date:         $
//
//-----------------------------------------------------------------------------
// $Log: $
//
// $NoKeywords: $
//=============================================================================
//
// Layout: every player on one screen, without scrolling, up to 64 players. Two columns side by
// side, one per TS team (team 1 left, team 2 right; free-for-all splits its one sorted list in
// two). A team with more players than its column holds continues in the other column's free rows
// under a "<team> (cont.)" header. Rows are 12 units high (640x480 units, YRES); when a layout
// needs more rows than fit, the rows get shorter, down to SB_MIN_ROW_TALL_PX, and past that the
// last row says "... N more". Each row: avatar, status, name, kills, deaths, assists, lives, ping,
// voice. Players with no team are listed in the strip at the bottom. The avatar cell carries a
// small link icon in its corner (H9 LINK ICONS below), and a double-click on a linked player's
// picture opens their havoc9.org profile (H9 PROFILES below).

#include <VGUI_LineBorder.h>

#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "entity_state.h"
#include "cl_entity.h"
#include "vgui_TeamFortressViewport.h"
#include "vgui_ScorePanel.h"
#include "vgui_helpers.h"
#include "vgui_loadtga.h"
#include "parsemsg.h" // H9 LINK ICONS: the H9Link message
#include <cmath>	  // H9 SCROLL: expf, the eased motion
#include "voice_status.h"
#include "vgui_SpectatorPanel.h"

extern hud_player_info_t g_PlayerInfoList[MAX_PLAYERS_HUD + 1];	   // player info from the engine
extern extra_player_info_t g_PlayerExtraInfo[MAX_PLAYERS_HUD + 1]; // additional player info sent directly to the client dll
team_info_t g_TeamInfo[MAX_TEAMS + 1];
int g_IsSpectator[MAX_PLAYERS_HUD + 1];
ScoreAvatar g_PlayerAvatars[MAX_PLAYERS_HUD + 1];
bool g_bScoreAssists = false;
bool g_bScoreLives = false; // H9 LIVES
bool g_bScoreClass = false; // H9 CLASS ICONS
bool g_bScorePool = false; // H9 POOL
int g_iScorePoolLeft[3] = {0, 0, 0};
int g_iScorePoolStart[3] = {0, 0, 0};
bool g_bScoreKills = false; // H9 KILLS
static bool s_bCellsKills = false; // H9 KILLS: what the cells were last placed for (PlaceCells)
static bool s_bCellsPool = false;  // H9 POOL: the same, for the lives column's title and width
static bool s_bCellsClass = false; // H9 CLASS ICONS: the same, for the class column's width

// ---- H9 BOARD: the name of the one list on a map without teams. H9's ts_matchmode sends it in
// H9Board (a string) to each player as he joins: "Roleplay" on a roleplay map, empty elsewhere.
// Without one, a map named like a roleplay map (rp_ or tsrp_ at the start, _rp_ or _tsrp_
// inside, the test ts_matchmode's roleplay_map uses) reads "Roleplay"; any other, "Free for all".
static char s_szBoardLabel[32];

int __MsgFunc_H9Board(const char* pszName, int iSize, void* pbuf)
{
	BEGIN_READ(pbuf, iSize);
	strncpy(s_szBoardLabel, READ_STRING(), sizeof(s_szBoardLabel) - 1);
	s_szBoardLabel[sizeof(s_szBoardLabel) - 1] = 0;
	return 1;
}

static const char* FreeForAllLabel()
{
	if (s_szBoardLabel[0])
		return s_szBoardLabel;
	const char* level = gEngfuncs.pfnGetLevelName();
	const char* map = level ? strrchr(level, '/') : NULL;
	map = map ? map + 1 : (level ? level : "");
	char lower[64];
	int n = 0;
	for (; map[n] && n < (int)sizeof(lower) - 1; n++)
		lower[n] = (char)tolower((unsigned char)map[n]);
	lower[n] = 0;
	if (!strncmp(lower, "rp_", 3) || !strncmp(lower, "tsrp_", 5) || strstr(lower, "_rp_") || strstr(lower, "_tsrp_"))
		return "Roleplay";
	return "Free for all";
}
// ---- end H9 BOARD

// Bitmaps a new picture replaced during the level: a cell may still hold one until its next fill, so
// they are freed with the level's own (ScorePanel::Initialize).
#define SB_MAX_RETIRED 256
static CAvatarBitmap* s_RetiredAvatars[SB_MAX_RETIRED];
static int s_iRetiredAvatars = 0;

// ---- H9 LINK ICONS ------------------------------------------------------------------------------
// Each row's avatar cell carries a small, half-transparent icon in its lower right corner (the
// whole cell in the shortest rows), docs/H9_PRESENCE.txt section 4b:
//   a green chain   h9_presence says the player is a proven havoc9.org account on this server
//                   (the H9Link message: byte slot, byte 1; the same players it names a picture
//                   for, their own or the site's default)
//   a red broken chain   anyone else: no account, a game that did not prove the player id, a
//                   Steam client, or a server without h9_presence (every row red there)
//   H9's helmet in grey  a bot, which never gets a chain: h9_presence says so (H9Link byte 2,
//                   from is_user_bot), and on a server without it *bot 1 in the userinfo does
// cl_h9_linkicons 0 leaves them out. The icons are gfx/vgui/h9_link.tga, h9_unlink.tga and
// h9_bot.tga (tools/make_link_icons.py, from H9's own drawing and helmet); a missing file is no
// icon.
enum
{
	SB_ICON_NONE = 0,
	SB_ICON_LINK,
	SB_ICON_UNLINK,
	SB_ICON_BOT,
	SB_ICON_KINDS
};
#define SB_ICON_ALPHA 200 // of 255: the icon over the picture, never quite opaque

static unsigned char s_PlayerLinked[MAX_PLAYERS_HUD + 1];

int __MsgFunc_H9Link(const char* pszName, int iSize, void* pbuf)
{
	BEGIN_READ(pbuf, iSize);
	const int slot = READ_BYTE();
	const int linked = READ_BYTE();
	if (slot > 0 && slot <= MAX_PLAYERS_HUD)
		s_PlayerLinked[slot] = linked == 2 ? 2 : linked ? 1 : 0;
	return 1;
}

// ---- H9 LEVELS ----------------------------------------------------------------------------------
// h9_presence's H9Level message (byte slot, byte level; 255 for none): a proven havoc9.org
// account's level, Lv 0 to 99 from the H9 ladder (docs/H9_COMPETITIVE.txt), drawn as its badge
// before the player's name (H9 LEVEL BADGES below), or as "Lv N" where that level's picture is
// missing. Bots and players without an account get none, and show nothing.
static unsigned char s_PlayerLevel[MAX_PLAYERS_HUD + 1]; // the level + 1; 0 for none

int __MsgFunc_H9Level(const char* pszName, int iSize, void* pbuf)
{
	BEGIN_READ(pbuf, iSize);
	const int slot = READ_BYTE();
	const int level = READ_BYTE();
	if (slot > 0 && slot <= MAX_PLAYERS_HUD)
		s_PlayerLevel[slot] = level <= 99 ? (unsigned char)(level + 1) : 0;
	return 1;
}

static struct
{
	const char* file;
	unsigned char* rgba; // wide * tall * 4, rows top first
	int wide;
	int tall;
	bool tried;
} s_LinkIcons[SB_ICON_KINDS] = {
	{NULL, NULL, 0, 0, true},
	{"gfx/vgui/h9_link.tga", NULL, 0, 0, false},
	{"gfx/vgui/h9_unlink.tga", NULL, 0, 0, false},
	{"gfx/vgui/h9_bot.tga", NULL, 0, 0, false},
};

// A 24- or 32-bit TGA, uncompressed or RLE, of at most 256 x 256, as RGBA rows top first; NULL
// for anything else.
static unsigned char* LoadIconTGA(const char* path, int* wide, int* tall)
{
	int len = 0;
	unsigned char* f = gEngfuncs.COM_LoadFile((char*)path, 5, &len);
	if (!f)
		return NULL;
	unsigned char* out = NULL;
	const int type = len > 18 ? f[2] : 0;
	const int bpp = len > 18 ? f[16] / 8 : 0;
	const int w = len > 18 ? f[12] | (f[13] << 8) : 0;
	const int h = len > 18 ? f[14] | (f[15] << 8) : 0;
	if ((type == 2 || type == 10) && f[1] == 0 && (bpp == 3 || bpp == 4) && w > 0 && h > 0 && w <= 256 && h <= 256)
	{
		const bool topFirst = (f[17] & 0x20) != 0;
		const unsigned char* p = f + 18 + f[0];
		const unsigned char* end = f + len;
		const unsigned char* px = NULL;
		const int total = w * h;
		int n = 0;
		bool ok = true;
		out = new unsigned char[total * 4];
		while (n < total && ok)
		{
			int count = 1;
			bool run = false;
			if (type == 10)
			{
				if (p >= end)
				{
					ok = false;
					break;
				}
				count = (*p & 0x7f) + 1;
				run = (*p & 0x80) != 0;
				p++;
			}
			for (int i = 0; i < count && n < total; i++, n++)
			{
				if (!run || i == 0)
				{
					if (p + bpp > end)
					{
						ok = false;
						break;
					}
					px = p;
					p += bpp;
				}
				const int x = n % w;
				const int y = topFirst ? n / w : h - 1 - n / w;
				unsigned char* o = out + (y * w + x) * 4;
				o[0] = px[2];
				o[1] = px[1];
				o[2] = px[0];
				o[3] = bpp == 4 ? px[3] : 255;
			}
		}
		if (!ok)
		{
			delete[] out;
			out = NULL;
		}
		else
		{
			*wide = w;
			*tall = h;
		}
	}
	gEngfuncs.COM_FreeFile(f);
	return out;
}

// The icon a slot's avatar cell carries.
static int LinkIconFor(int slot)
{
	static cvar_t* show = NULL;
	if (!show)
		show = gEngfuncs.pfnGetCvarPointer("cl_h9_linkicons");
	if (show && show->value == 0)
		return SB_ICON_NONE;
	if (s_PlayerLinked[slot] == 2)
		return SB_ICON_BOT;
	const char* bot = gEngfuncs.PlayerInfo_ValueForKey(slot, "*bot");
	if (bot && bot[0] == '1')
		return SB_ICON_BOT;
	return s_PlayerLinked[slot] ? SB_ICON_LINK : SB_ICON_UNLINK;
}

// ---- H9 PROFILES --------------------------------------------------------------------------------
// A double-click on a linked player's picture (the green chain: H9Link 1, and not a bot) opens their
// havoc9.org profile in the web browser, your own row's yours. The engine's h9_profile <slot>
// (engine-h9-avatars.patch) does it: the address is its own site and the account the server named
// for that slot's picture, opened the way the main menu's OPEN PAGE opens a page. A single click on
// such a picture mutes nobody, so a double-click never mutes the player; the rest of the row mutes
// as before. An engine without h9_profile (Steam's, the browser build) gets none of it, and there the
// picture mutes as every other cell does.
static bool EngineOpensProfiles()
{
	static int known = -1; // the engine's commands are all there before the board is first used
	if (known < 0)
	{
		known = 0;
		for (unsigned int cmd = gEngfuncs.GetFirstCmdFunctionHandle(); cmd; cmd = gEngfuncs.GetNextCmdFunctionHandle(cmd))
		{
			const char* name = gEngfuncs.GetCmdFunctionName(cmd);
			if (name && !strcmp(name, "h9_profile"))
			{
				known = 1;
				break;
			}
		}
	}
	return known == 1;
}

static bool OpensProfile(int slot)
{
	if (slot < 1 || slot > MAX_PLAYERS_HUD || s_PlayerLinked[slot] != 1)
		return false;
	const char* bot = gEngfuncs.PlayerInfo_ValueForKey(slot, "*bot");
	if (bot && bot[0] == '1')
		return false;
	return EngineOpensProfiles();
}
// ---- end H9 PROFILES

// The icon over a cell's pixels (size x size RGBA): box-filtered from the icon's own size into the
// lower right corner, a little over half the cell, or the whole cell when the cell is 12 pixels or
// smaller, at SB_ICON_ALPHA of its own alpha.
static void LayLinkIcon(unsigned char* cell, int size, int kind)
{
	if (kind <= SB_ICON_NONE || kind >= SB_ICON_KINDS)
		return;
	if (!s_LinkIcons[kind].tried)
	{
		s_LinkIcons[kind].tried = true;
		s_LinkIcons[kind].rgba = LoadIconTGA(s_LinkIcons[kind].file, &s_LinkIcons[kind].wide, &s_LinkIcons[kind].tall);
	}
	const unsigned char* icon = s_LinkIcons[kind].rgba;
	if (!icon)
		return;
	const int iw = s_LinkIcons[kind].wide;
	const int it = s_LinkIcons[kind].tall;
	const int side = size <= 12 ? size : (size * 11 + 10) / 20;
	const int origin = size - side;
	for (int y = 0; y < side; y++)
	{
		const int sy0 = y * it / side;
		int sy1 = (y + 1) * it / side;
		if (sy1 <= sy0)
			sy1 = sy0 + 1;
		for (int x = 0; x < side; x++)
		{
			const int sx0 = x * iw / side;
			int sx1 = (x + 1) * iw / side;
			if (sx1 <= sx0)
				sx1 = sx0 + 1;
			int r = 0, g = 0, b = 0, a = 0, n = 0;
			for (int sy = sy0; sy < sy1; sy++)
			{
				for (int sx = sx0; sx < sx1; sx++)
				{
					const unsigned char* p = icon + (sy * iw + sx) * 4;
					r += p[0] * p[3];
					g += p[1] * p[3];
					b += p[2] * p[3];
					a += p[3];
					n++;
				}
			}
			if (!a)
				continue;
			const int alpha = a / n * SB_ICON_ALPHA / 255;
			unsigned char* o = cell + ((origin + y) * size + origin + x) * 4;
			o[0] = (unsigned char)((r / a * alpha + o[0] * (255 - alpha)) / 255);
			o[1] = (unsigned char)((g / a * alpha + o[1] * (255 - alpha)) / 255);
			o[2] = (unsigned char)((b / a * alpha + o[2] * (255 - alpha)) / 255);
		}
	}
}

// A pixel of the cell buffer CAvatarBitmap draws into before the icon goes over it.
static inline void SetCellPixel(unsigned char* cell, int size, int x, int y, int r, int g, int b)
{
	unsigned char* o = cell + (y * size + x) * 4;
	o[0] = (unsigned char)r;
	o[1] = (unsigned char)g;
	o[2] = (unsigned char)b;
	o[3] = 255;
}

// A picture's bitmap drawn with another icon: a cell may still hold it until its next fill, so it
// goes with the level's retired ones (past the limit it is let go rather than freed).
static void RetireLinkBitmap(CAvatarBitmap* bitmap)
{
	if (bitmap && s_iRetiredAvatars < SB_MAX_RETIRED)
		s_RetiredAvatars[s_iRetiredAvatars++] = bitmap;
}
// ---- end H9 LINK ICONS --------------------------------------------------------------------------

// ---- H9 LEVEL BADGES ----------------------------------------------------------------------------
// The badge before a leveled player's name: gfx/vgui/h9_levels/lv-<N>.tga for Lv 0 to 99 (64 x 64
// with alpha, drawn by modelling/make-level-badges.mjs, the art of havoc9.org's own badges), scaled
// to the avatar's size. Each picture is read once, on first use, and a level without one is "Lv N"
// text instead. The bitmaps are kept by level and size for the life of the client, as the
// silhouettes are: the row height only ever takes a few values.
#define SB_LEVELS 100
static struct
{
	unsigned char* rgba; // wide * tall * 4, rows top first
	int wide;
	int tall;
	bool tried;
} s_LevelPictures[SB_LEVELS];

#define SB_MAX_LEVEL_BITMAPS 512 // by level and size
static struct
{
	int level;
	int size;
	CLevelBitmap* bitmap;
} s_LevelBitmaps[SB_MAX_LEVEL_BITMAPS];
static int s_iLevelBitmaps = 0;

// The badge for a level at size x size; NULL when that level has no picture.
static CLevelBitmap* GetLevelBitmap(int level, int size)
{
	if (level < 0 || level >= SB_LEVELS || size < 1)
		return NULL;
	for (int i = 0; i < s_iLevelBitmaps; i++)
	{
		if (s_LevelBitmaps[i].level == level && s_LevelBitmaps[i].size == size)
			return s_LevelBitmaps[i].bitmap;
	}
	if (!s_LevelPictures[level].tried)
	{
		char path[64];
		snprintf(path, sizeof(path), "gfx/vgui/h9_levels/lv-%d.tga", level);
		s_LevelPictures[level].tried = true;
		s_LevelPictures[level].rgba = LoadIconTGA(path, &s_LevelPictures[level].wide, &s_LevelPictures[level].tall);
	}
	if (!s_LevelPictures[level].rgba)
		return NULL;
	int i = s_iLevelBitmaps;
	if (i < SB_MAX_LEVEL_BITMAPS)
		s_iLevelBitmaps++;
	else
		i = SB_MAX_LEVEL_BITMAPS - 1; // full: the last entry is redrawn (its old bitmap stays alive)
	s_LevelBitmaps[i].level = level;
	s_LevelBitmaps[i].size = size;
	s_LevelBitmaps[i].bitmap = new CLevelBitmap(size, s_LevelPictures[level].rgba, s_LevelPictures[level].wide, s_LevelPictures[level].tall);
	return s_LevelBitmaps[i].bitmap;
}
// ---- end H9 LEVEL BADGES ------------------------------------------------------------------------

// ---- H9 CLASS ICONS -------------------------------------------------------------------------------------------
// H9Class (H9's ts_matchmode) names a player's class icon as a frame of sprites/tsm_class.spr, the sheet the world
// icons over players' heads use. The column draws that frame scaled to one cell. The sheet is read once, on the first
// icon asked for: an IDSP version 2 sprite, 8-bit palette, frames stored single and top row first, palette index 255
// clear when the sprite is alpha-tested (texture format 3).
#define SB_CLASS_FRAMES 18
#define SB_CLASS_ICON 16 // pixels, square
static struct
{
	unsigned char* rgba;
	int wide;
	int tall;
} s_ClassFrames[SB_CLASS_FRAMES];
static bool s_bClassSheetTried = false;
static struct
{
	int frame;
	int size;
	CLevelBitmap* bitmap;
} s_ClassBitmaps[SB_CLASS_FRAMES * 4];
static int s_iClassBitmaps = 0;

static void LoadClassSheet()
{
	s_bClassSheetTried = true;
	int length = 0;
	byte* file = gEngfuncs.COM_LoadFile("sprites/tsm_class.spr", 5, &length);
	if (!file)
		return;
	if (length > 42 && memcmp(file, "IDSP", 4) == 0)
	{
		int version = 0, texFormat = 0, frames = 0;
		memcpy(&version, file + 4, 4);
		memcpy(&texFormat, file + 12, 4);
		memcpy(&frames, file + 28, 4);
		short colors = 0;
		memcpy(&colors, file + 40, 2);
		int off = 42;
		const byte* palette = file + off;
		off += colors * 3;
		if (version == 2 && colors > 0 && colors <= 256 && off < length)
		{
			for (int f = 0; f < frames && f < SB_CLASS_FRAMES; f++)
			{
				if (off + 20 > length)
					break;
				int group = 0, w = 0, h = 0;
				memcpy(&group, file + off, 4);
				memcpy(&w, file + off + 12, 4);
				memcpy(&h, file + off + 16, 4);
				off += 20;
				if (group != 0 || w < 1 || h < 1 || w > 256 || h > 256 || off + w * h > length)
					break;
				unsigned char* rgba = new unsigned char[w * h * 4];
				for (int i = 0; i < w * h; i++)
				{
					const int idx = file[off + i];
					rgba[i * 4 + 0] = idx < colors ? palette[idx * 3 + 0] : 0;
					rgba[i * 4 + 1] = idx < colors ? palette[idx * 3 + 1] : 0;
					rgba[i * 4 + 2] = idx < colors ? palette[idx * 3 + 2] : 0;
					rgba[i * 4 + 3] = (texFormat == 3 && idx == 255) ? 0 : 255;
				}
				off += w * h;
				s_ClassFrames[f].rgba = rgba;
				s_ClassFrames[f].wide = w;
				s_ClassFrames[f].tall = h;
			}
		}
	}
	gEngfuncs.COM_FreeFile(file);
}

// The icon for a sheet frame at size x size; NULL when the sheet has no such frame.
static CLevelBitmap* GetClassBitmap(int frame, int size)
{
	if (frame < 0 || frame >= SB_CLASS_FRAMES || size < 1)
		return NULL;
	for (int i = 0; i < s_iClassBitmaps; i++)
	{
		if (s_ClassBitmaps[i].frame == frame && s_ClassBitmaps[i].size == size)
			return s_ClassBitmaps[i].bitmap;
	}
	if (!s_bClassSheetTried)
		LoadClassSheet();
	if (!s_ClassFrames[frame].rgba)
		return NULL;
	int i = s_iClassBitmaps;
	if (i < SB_CLASS_FRAMES * 4)
		s_iClassBitmaps++;
	else
		i = SB_CLASS_FRAMES * 4 - 1; // full: the last entry is redrawn (its old bitmap stays alive)
	s_ClassBitmaps[i].frame = frame;
	s_ClassBitmaps[i].size = size;
	s_ClassBitmaps[i].bitmap = new CLevelBitmap(size, s_ClassFrames[frame].rgba, s_ClassFrames[frame].wide, s_ClassFrames[frame].tall);
	return s_ClassBitmaps[i].bitmap;
}
// ---- end H9 CLASS ICONS -------------------------------------------------------------------------------------

//-----------------------------------------------------------------------------
// Purpose: The engine hands a slot's havoc9.org picture here (engine-h9-avatars.patch, from the
//          H9Avatar message): RGBA pixels, row-major, at most 64 x 64, and the picture's version;
//          rgba NULL puts the silhouette back. Nothing else calls it, and an engine without the
//          patch never does, so the cell keeps the silhouette.
//-----------------------------------------------------------------------------
extern "C" void DLLEXPORT HUD_H9Avatar(int slot, int version, int wide, int tall, const unsigned char* rgba)
{
	if (slot < 1 || slot > MAX_PLAYERS_HUD)
		return;

	ScoreAvatar* avatar = &g_PlayerAvatars[slot];
	if (avatar->bitmap)
	{
		if (s_iRetiredAvatars < SB_MAX_RETIRED)
			s_RetiredAvatars[s_iRetiredAvatars++] = avatar->bitmap;
		avatar->bitmap = NULL; // past the limit it is let go rather than freed while a cell may hold it
	}
	delete[] avatar->pixels;
	avatar->pixels = NULL;
	avatar->wide = avatar->tall = avatar->version = 0;
	avatar->bitmapSize = 0;

	if (rgba && wide > 0 && tall > 0 && wide <= 64 && tall <= 64)
	{
		avatar->pixels = new unsigned char[wide * tall * 4];
		memcpy(avatar->pixels, rgba, wide * tall * 4);
		avatar->wide = wide;
		avatar->tall = tall;
		avatar->version = version;
	}
}

bool HUD_IsGame(const char* game);
bool EV_TFC_IsAllyTeam(int iTeam1, int iTeam2);

// Sizes in 640x480 units (XRES, YRES).
#define SB_BORDER 4
#define SB_COLUMN_GAP 8
#define SB_CELL_GAP 2
#define SB_TITLE_TALL 16
#define SB_HEADER_TALL 12
#define SB_ROW_TALL 12
#define SB_SPEC_TALL 12
#define SB_STATUS_WIDE 46
#define SB_NUMBER_WIDE 24 // kills, deaths, assists
#define SB_LIVES_WIDE 34  // H9 LIVES: "12/20"
#define SB_PING_WIDE 30
#define SB_VOICE_WIDE 16

// Rows never get shorter than this, in pixels.
#define SB_MIN_ROW_TALL_PX 8

// The silhouette's colours: light on dark, H9's purple greys.
#define SB_AVATAR_BG_R 46
#define SB_AVATAR_BG_G 42
#define SB_AVATAR_BG_B 58
#define SB_AVATAR_FG_R 150
#define SB_AVATAR_FG_G 140
#define SB_AVATAR_FG_B 172


//-----------------------------------------------------------------------------
// CAvatarBitmap
//-----------------------------------------------------------------------------

CAvatarBitmap::CAvatarBitmap(int size, const unsigned char* rgba, int wide, int tall, int icon)
{
	if (size < 1)
		size = 1;
	setSize(size, size);
	setColor(Color(255, 255, 255, 0));

	// H9 LINK ICONS: the cell's pixels go to a buffer first, the icon over them, then to the bitmap
	unsigned char* cell = new unsigned char[size * size * 4];

	if (rgba && wide > 0 && tall > 0)
	{
		// A picture, box-filtered to the cell and laid over the silhouette's background.
		for (int y = 0; y < size; y++)
		{
			const int sy0 = y * tall / size;
			int sy1 = (y + 1) * tall / size;
			if (sy1 <= sy0)
				sy1 = sy0 + 1;

			for (int x = 0; x < size; x++)
			{
				const int sx0 = x * wide / size;
				int sx1 = (x + 1) * wide / size;
				if (sx1 <= sx0)
					sx1 = sx0 + 1;

				int r = 0, g = 0, b = 0, n = 0;
				for (int sy = sy0; sy < sy1; sy++)
				{
					for (int sx = sx0; sx < sx1; sx++)
					{
						const unsigned char* p = rgba + (sy * wide + sx) * 4;
						const int a = p[3];
						r += (p[0] * a + SB_AVATAR_BG_R * (255 - a)) / 255;
						g += (p[1] * a + SB_AVATAR_BG_G * (255 - a)) / 255;
						b += (p[2] * a + SB_AVATAR_BG_B * (255 - a)) / 255;
						n++;
					}
				}
				SetCellPixel(cell, size, x, y, r / n, g / n, b / n);
			}
		}
	}
	else
	{
		// The default silhouette: head and shoulders, 4x4 supersampled.
		for (int y = 0; y < size; y++)
		{
			for (int x = 0; x < size; x++)
			{
				int cover = 0;
				for (int sy = 0; sy < 4; sy++)
				{
					for (int sx = 0; sx < 4; sx++)
					{
						const float px = (x + (sx + 0.5f) / 4.0f) / size;
						const float py = (y + (sy + 0.5f) / 4.0f) / size;

						const float hx = px - 0.5f;
						const float hy = py - 0.37f;
						const bool head = hx * hx + hy * hy <= 0.19f * 0.19f;

						const float bx = (px - 0.5f) / 0.36f;
						const float by = (py - 1.04f) / 0.42f;
						const bool body = bx * bx + by * by <= 1.0f;

						if (head || body)
							cover++;
					}
				}
				const int r = SB_AVATAR_BG_R + (SB_AVATAR_FG_R - SB_AVATAR_BG_R) * cover / 16;
				const int g = SB_AVATAR_BG_G + (SB_AVATAR_FG_G - SB_AVATAR_BG_G) * cover / 16;
				const int b = SB_AVATAR_BG_B + (SB_AVATAR_FG_B - SB_AVATAR_BG_B) * cover / 16;
				SetCellPixel(cell, size, x, y, r, g, b);
			}
		}
	}

	// H9 LINK ICONS: the icon, then the whole cell to the bitmap, opaque
	LayLinkIcon(cell, size, icon);
	for (int y = 0; y < size; y++)
	{
		for (int x = 0; x < size; x++)
		{
			const unsigned char* p = cell + (y * size + x) * 4;
			setRGBA(x, y, p[0], p[1], p[2], 255);
		}
	}
	delete[] cell;
}


//-----------------------------------------------------------------------------
// CLevelBitmap (H9 LEVEL BADGES)
//-----------------------------------------------------------------------------

// The picture area-filtered to size x size: each pixel the alpha-weighted mean of the source area
// it covers, a source pixel partly inside counted by the part inside. Fully clear pixels take the
// colour of the badge's soft edge, so a filtered draw never darkens the rim.
CLevelBitmap::CLevelBitmap(int size, const unsigned char* rgba, int wide, int tall)
{
	if (size < 1)
		size = 1;
	setSize(size, size);
	setColor(Color(255, 255, 255, 0));

	unsigned char* cell = new unsigned char[size * size * 4];
	memset(cell, 0, size * size * 4);
	float edgeR = 0, edgeG = 0, edgeB = 0, edgeA = 0;
	if (rgba && wide > 0 && tall > 0)
	{
		const float stepX = (float)wide / size;
		const float stepY = (float)tall / size;
		for (int y = 0; y < size; y++)
		{
			const float y0 = y * stepY, y1 = (y + 1) * stepY;
			for (int x = 0; x < size; x++)
			{
				const float x0 = x * stepX, x1 = (x + 1) * stepX;
				float r = 0, g = 0, b = 0, a = 0, area = 0;
				for (int sy = (int)y0; sy < tall && sy < y1; sy++)
				{
					const float wy = V_min(y1, (float)(sy + 1)) - V_max(y0, (float)sy);
					for (int sx = (int)x0; sx < wide && sx < x1; sx++)
					{
						const float w = (V_min(x1, (float)(sx + 1)) - V_max(x0, (float)sx)) * wy;
						const unsigned char* p = rgba + (sy * wide + sx) * 4;
						r += p[0] * p[3] * w;
						g += p[1] * p[3] * w;
						b += p[2] * p[3] * w;
						a += p[3] * w;
						area += w;
					}
				}
				if (a <= 0 || area <= 0)
					continue;
				unsigned char* o = cell + (y * size + x) * 4;
				o[0] = (unsigned char)V_min(255.0f, r / a + 0.5f);
				o[1] = (unsigned char)V_min(255.0f, g / a + 0.5f);
				o[2] = (unsigned char)V_min(255.0f, b / a + 0.5f);
				o[3] = (unsigned char)V_min(255.0f, a / area + 0.5f);
				if (o[3] < 255)
				{
					edgeR += o[0] * o[3];
					edgeG += o[1] * o[3];
					edgeB += o[2] * o[3];
					edgeA += o[3];
				}
			}
		}
	}
	const int fillR = edgeA > 0 ? (int)(edgeR / edgeA) : 255;
	const int fillG = edgeA > 0 ? (int)(edgeG / edgeA) : 255;
	const int fillB = edgeA > 0 ? (int)(edgeB / edgeA) : 255;
	for (int y = 0; y < size; y++)
	{
		for (int x = 0; x < size; x++)
		{
			const unsigned char* p = cell + (y * size + x) * 4;
			if (p[3])
				setRGBA(x, y, p[0], p[1], p[2], p[3]);
			else
				setRGBA(x, y, fillR, fillG, fillB, 0);
		}
	}
	delete[] cell;
}

// Silhouettes by size. Bitmaps upload their texture once, so each size is its own bitmap; the row
// height only ever takes a few values, and they are kept for the life of the client.
#define SB_MAX_SILHOUETTES 24 // H9 LINK ICONS: by size and by icon
static struct
{
	int size;
	int icon;
	CAvatarBitmap* bitmap;
} s_Silhouettes[SB_MAX_SILHOUETTES];

static CAvatarBitmap* GetSilhouette(int size, int icon = SB_ICON_NONE)
{
	int i;
	for (i = 0; i < SB_MAX_SILHOUETTES && s_Silhouettes[i].bitmap; i++)
	{
		if (s_Silhouettes[i].size == size && s_Silhouettes[i].icon == icon)
			return s_Silhouettes[i].bitmap;
	}
	if (i == SB_MAX_SILHOUETTES)
		i = SB_MAX_SILHOUETTES - 1; // full: the last entry is redrawn (its old bitmap stays alive)
	s_Silhouettes[i].size = size;
	s_Silhouettes[i].icon = icon;
	s_Silhouettes[i].bitmap = new CAvatarBitmap(size, NULL, 0, 0, icon);
	return s_Silhouettes[i].bitmap;
}

// Fonts by height and weight, kept for the life of the client.
#define SB_MAX_FONTS 16
static struct
{
	int tall;
	int weight;
	Font* font;
} s_Fonts[SB_MAX_FONTS];

Font* ScorePanel::GetFontForTall(int tall, int weight)
{
	if (tall < 6)
		tall = 6;
	int i;
	for (i = 0; i < SB_MAX_FONTS && s_Fonts[i].font; i++)
	{
		if (s_Fonts[i].tall == tall && s_Fonts[i].weight == weight)
			return s_Fonts[i].font;
	}
	if (i == SB_MAX_FONTS)
		i = SB_MAX_FONTS - 1;
	s_Fonts[i].tall = tall;
	s_Fonts[i].weight = weight;
	s_Fonts[i].font = new Font("Arial", tall, 0, 0, weight, false, false, false, false);
	return s_Fonts[i].font;
}


//-----------------------------------------------------------------------------
// ScorePanel::HitTestPanel.
//-----------------------------------------------------------------------------

void ScorePanel::HitTestPanel::internalMousePressed(MouseCode code)
{
	for (int i = 0; i < _inputSignalDar.getCount(); i++)
	{
		_inputSignalDar[i]->mousePressed(code, this);
	}
}



//-----------------------------------------------------------------------------
// Purpose: Create the ScoreBoard panel
//-----------------------------------------------------------------------------
ScorePanel::ScorePanel(int x, int y, int wide, int tall) : Panel(x, y, wide, tall)
{
	CSchemeManager* pSchemes = gViewPort->GetSchemeManager();
	SchemeHandle_t hTitleScheme = pSchemes->getSchemeHandle("Scoreboard Title Text");
	Font* tfont = pSchemes->getFont(hTitleScheme);

	setBgColor(0, 0, 0, 96);
	m_iHighlightRow = -1;
	m_pRowFont = NULL;
	m_pHeadFont = NULL;
	m_iFontRowTall = 0;
	m_pSilhouette = NULL;
	m_iAvatarSize = 0;
	m_iNumBlocks = 0;
	m_iNumSpec = 0;
	m_iShowscoresHeld = 0;
	memset(m_Rows, 0, sizeof(m_Rows));
	// ---- H9 SCROLL
	memset(m_Lists, 0, sizeof(m_Lists));
	memset(m_iRowY, 0, sizeof(m_iRowY));
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		m_flScroll[c] = m_flScrollTarget[c] = 0.0f;
		m_iScrollMax[c] = 0;
	}
	// ---- end H9 SCROLL

	LineBorder* border = new LineBorder(Color(60, 60, 60, 128));
	setBorder(border);
	setPaintBorderEnabled(true);

	// Columns, side by side.
	const int edge = XRES(SB_BORDER);
	const int colGap = XRES(SB_COLUMN_GAP);
	m_iColumnWide = (wide - edge * 2 - colGap * (SB_NUM_COLUMNS - 1)) / SB_NUM_COLUMNS;
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
		m_iColumnX[c] = edge + c * (m_iColumnWide + colGap);

	// Top to bottom: title line, column titles, the rows, the spectator strip.
	const int gap = YRES(2);
	const int titleTall = YRES(SB_TITLE_TALL);
	const int headTall = YRES(SB_HEADER_TALL);
	const int specTall = YRES(SB_SPEC_TALL);
	const int titleY = gap;
	const int headY = titleY + titleTall;
	const int specY = tall - gap - specTall;
	m_iRowsTop = headY + headTall + gap;
	m_iRowsTall = specY - gap - m_iRowsTop;

	// The title: the server name on the left, the map and player count on the right, clear of
	// the close button.
	const int closeWide = XRES(12 + 4);
	m_TitleLabel.setFont(GetFontForTall(titleTall * 85 / 100, 700));
	m_TitleLabel.setText("");
	m_TitleLabel.setBgColor(0, 0, 0, 255);
	m_TitleLabel.setFgColor(Scheme::sc_primary1);
	m_TitleLabel.setContentAlignment(vgui::Label::a_west);
	m_TitleLabel.setBounds(edge, titleY, wide / 2, titleTall);
	m_TitleLabel.setContentFitted(false);
	m_TitleLabel.setParent(this);

	m_TitleInfo.setFont(GetFontForTall(headTall * 85 / 100, 0));
	m_TitleInfo.setText("");
	m_TitleInfo.setBgColor(0, 0, 0, 255);
	m_TitleInfo.setFgColor(Scheme::sc_primary1);
	m_TitleInfo.setContentAlignment(vgui::Label::a_east);
	m_TitleInfo.setBounds(wide / 2, titleY, wide / 2 - edge - closeWide, titleTall);
	m_TitleInfo.setContentFitted(false);
	m_TitleInfo.setParent(this);

	// The column titles, once per column.
	// The frags' and the real kills' titles follow H9 KILLS (PlaceCells sets them again).
	static const char* s_szCellTitles[SB_NUM_CELLS] = {"", "", "NAME", "", "K", "", "D", "A", "LIVES", "PING", ""};
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		for (int k = 0; k < SB_NUM_CELLS; k++)
		{
			CLabelHeader* pLabel = &m_HeaderLabels[c][k];
			pLabel->setFont(GetFontForTall(headTall * 85 / 100, 0));
			pLabel->setText(s_szCellTitles[k]);
			pLabel->setBgColor(0, 0, 0, 255);
			pLabel->setFgColor(Scheme::sc_primary1);
			pLabel->setContentAlignment(k == SB_CELL_NAME ? Label::a_west : Label::a_east);
			pLabel->setContentFitted(false);
			pLabel->setParent(this);
		}
	}

	// ---- H9 SCROLL: each column's clip panel, under its pinned first row (PlaceClips sizes it),
	// and its scroll indicator, a thin half-transparent bar at the column's right edge.
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		m_RowClip[c].setParent(this);
		m_RowClip[c].setPaintBackgroundEnabled(false);
		m_RowClip[c].setBgColor(0, 0, 0, 255);
		m_ScrollBar[c].setParent(this);
		m_ScrollBar[c].setBgColor(220, 220, 220, 150);
		m_ScrollBar[c].setVisible(false);
	}
	// ---- end H9 SCROLL

	// The row widgets. Each starts hidden; FillGrid places and fills the ones in use. Widget 0 of
	// a column sits on the board; the others in the column's clip panel (H9 SCROLL).
	for (int r = 0; r < SB_NUM_ROWS; r++)
	{
		for (int k = 0; k < SB_NUM_CELLS; k++)
		{
			CLabelHeader* pLabel = &m_Cells[r][k];
			pLabel->setContentFitted(false);
			pLabel->setRow(r);
			pLabel->addInputSignal(this);
			pLabel->setBgColor(0, 0, 0, 255);
			if (r % SB_ROWS_PER_COLUMN == 0)
				pLabel->setParent(this);
			else
				pLabel->setParent(&m_RowClip[r / SB_ROWS_PER_COLUMN]);
			pLabel->setVisible(false);
		}
	}

	// The spectator strip.
	m_pSpecFont = GetFontForTall(specTall * 85 / 100, 0);
	m_SpecLabel.setFont(m_pSpecFont);
	m_SpecLabel.setText("");
	m_SpecLabel.setBgColor(0, 0, 0, 255);
	m_SpecLabel.setFgColor(150, 150, 150, 0);
	m_SpecLabel.setContentAlignment(vgui::Label::a_west);
	m_SpecLabel.setBounds(edge, specY, wide - edge * 2, specTall);
	m_SpecLabel.setContentFitted(false);
	m_SpecLabel.setParent(this);

	m_iRowTall = YRES(SB_ROW_TALL);
	if (m_iRowTall < SB_MIN_ROW_TALL_PX)
		m_iRowTall = SB_MIN_ROW_TALL_PX;
	PlaceCells(m_iRowTall);
	UpdateFonts(m_iRowTall);

	// Add the hit test panel. It is invisible and traps mouse clicks so we can go into squelch mode.
	m_HitTestPanel.setBgColor(0, 0, 0, 255);
	m_HitTestPanel.setParent(this);
	m_HitTestPanel.setBounds(0, 0, wide, tall);
	m_HitTestPanel.addInputSignal(this);

	m_pCloseButton = new CommandButton("x", wide - XRES(12 + 4), YRES(2), XRES(12), YRES(12));
	m_pCloseButton->setParent(this);
	m_pCloseButton->addActionSignal(new CMenuHandler_StringCommandWatch("-showscores", true));
	m_pCloseButton->setBgColor(0, 0, 0, 255);
	m_pCloseButton->setFgColor(255, 255, 255, 0);
	m_pCloseButton->setFont(tfont);
	m_pCloseButton->setBoundKey((char)255);
	m_pCloseButton->setContentAlignment(Label::a_center);

	Initialize();
}


//-----------------------------------------------------------------------------
// Purpose: Called each time a new level is started.
//-----------------------------------------------------------------------------
void ScorePanel::Initialize()
{
	// Clear out scoreboard data
	m_iLastKilledBy = 0;
	m_fLastKillTime = 0;
	m_iPlayerNum = 0;
	m_iNumTeams = 0;
	memset(g_PlayerExtraInfo, 0, sizeof g_PlayerExtraInfo);
	memset(g_TeamInfo, 0, sizeof g_TeamInfo);
	g_bScoreAssists = false;
	g_bScoreLives = false; // H9 LIVES
	g_bScoreClass = false; // H9 CLASS ICONS
	g_bScorePool = false;  // H9 POOL
	memset(g_iScorePoolLeft, 0, sizeof g_iScorePoolLeft);
	memset(g_iScorePoolStart, 0, sizeof g_iScorePoolStart);
	g_bScoreKills = false; // H9 KILLS: until this level's server says its frags are points
	s_szBoardLabel[0] = 0; // H9 BOARD: until this level's server says
	extern void TS_ClearSpectatorTable(); // ts_spectate.cpp; client.dll 0x1005d5a0 clears it here
	TS_ClearSpectatorTable();

	// Pictures belong to this level's players: the cells let go of them, then they are freed.
	for (int r = 0; r < SB_NUM_ROWS; r++)
		m_Cells[r][SB_CELL_AVATAR].setImage(NULL);
	for (int i = 0; i <= MAX_PLAYERS_HUD; i++)
	{
		delete[] g_PlayerAvatars[i].pixels;
		delete g_PlayerAvatars[i].bitmap;
		memset(&g_PlayerAvatars[i], 0, sizeof(g_PlayerAvatars[i]));
	}
	for (int i = 0; i < s_iRetiredAvatars; i++)
		delete s_RetiredAvatars[i];
	s_iRetiredAvatars = 0;
	memset(s_PlayerLinked, 0, sizeof(s_PlayerLinked)); // H9 LINK ICONS: until h9_presence says
	memset(s_PlayerLevel, 0, sizeof(s_PlayerLevel));   // H9 LEVELS: the same
}

bool HACK_GetPlayerUniqueID(int iPlayer, char playerID[16])
{
	return 0 != gEngfuncs.GetPlayerUniqueID(iPlayer, playerID); // TODO remove after testing
}

// A player slot in use: the engine has a name for it and an entity.
static bool ScorePlayerValid(int i)
{
	return g_PlayerInfoList[i].name != NULL && gEngfuncs.GetEntityByIndex(i) != NULL;
}

// Score order: more kills first, then fewer deaths, then the lower slot.
static bool ScoreBefore(int a, int b)
{
	if (g_PlayerExtraInfo[a].frags != g_PlayerExtraInfo[b].frags)
		return g_PlayerExtraInfo[a].frags > g_PlayerExtraInfo[b].frags;
	if (g_PlayerExtraInfo[a].deaths != g_PlayerExtraInfo[b].deaths)
		return g_PlayerExtraInfo[a].deaths < g_PlayerExtraInfo[b].deaths;
	return a < b;
}

static void ScoreSortPlayers(int* players, int count)
{
	for (int i = 1; i < count; i++)
	{
		const int p = players[i];
		int j = i - 1;
		while (j >= 0 && ScoreBefore(p, players[j]))
		{
			players[j + 1] = players[j];
			j--;
		}
		players[j + 1] = p;
	}
}

//-----------------------------------------------------------------------------
// Purpose: Recalculate the internal scoreboard data
//-----------------------------------------------------------------------------
void ScorePanel::Update()
{
	// Set the title
	m_TitleLabel.setText(gViewPort->m_szServerName);

	gViewPort->GetAllPlayersInfo();

	if (gHUD.m_Teamplay)
		SortTeams();
	BuildBlocks();

	// The rows: as many as a column holds at the nominal height, more (and shorter) rows until
	// every player fits or the rows reach their floor, and past that the "... N more" row.
	int nominal = YRES(SB_ROW_TALL);
	if (nominal < SB_MIN_ROW_TALL_PX)
		nominal = SB_MIN_ROW_TALL_PX;
	int capacity = V_max(2, m_iRowsTall / nominal);
	if (capacity > SB_ROWS_PER_COLUMN)
		capacity = SB_ROWS_PER_COLUMN;

	static ColumnFill s_Columns[SB_NUM_COLUMNS];
	bool fits = FlowBlocks(capacity, s_Columns, false);
	while (!fits && capacity < SB_ROWS_PER_COLUMN && m_iRowsTall / (capacity + 1) >= SB_MIN_ROW_TALL_PX)
	{
		capacity++;
		fits = FlowBlocks(capacity, s_Columns, false);
	}
	if (!fits)
	{
		// ---- H9 SCROLL: past the shortest rows, a side keeps its own column and scrolls in it
		// (a free-for-all list is split between the two); "... N more" only with scrolling off.
		static cvar_t* scroll = NULL;
		if (!scroll)
			scroll = gEngfuncs.pfnGetCvarPointer("cl_h9_scoreboard_scroll");
		if (!scroll || scroll->value != 0)
		{
			int cap = SB_ROWS_LOGICAL;
			if (m_iNumBlocks == 1)
				cap = V_max(capacity, (m_Blocks[0].count + 1) / 2 + 2);
			FlowBlocks(cap, s_Columns, true);
		}
		else
			FlowBlocks(capacity, s_Columns, true);
		// ---- end H9 SCROLL
	}

	for (int c = 0; c < SB_NUM_COLUMNS; c++)
		m_Lists[c] = s_Columns[c]; // H9 SCROLL: MapRows puts them on the row widgets

	const int rowTall = V_min(nominal, m_iRowsTall / capacity);
	if (rowTall != m_iRowTall || s_bCellsKills != g_bScoreKills || s_bCellsPool != g_bScorePool || s_bCellsClass != g_bScoreClass) // H9 KILLS: the K column comes or goes; H9 POOL: the lives column is retitled
	{
		m_iRowTall = rowTall;
		PlaceCells(rowTall);
	}
	// ---- H9 SCROLL: how far each column can scroll at this row height, the scroll held inside it
	PlaceClips();
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		const int content = V_max(0, m_Lists[c].used - 1) * m_iRowTall;
		m_iScrollMax[c] = V_max(0, content - (m_iRowsTall - m_iRowTall));
		if (m_flScrollTarget[c] > m_iScrollMax[c])
			m_flScrollTarget[c] = (float)m_iScrollMax[c];
		if (m_flScroll[c] > m_iScrollMax[c])
			m_flScroll[c] = (float)m_iScrollMax[c];
	}
	MapRows();
	PlaceScrollBars();
	// ---- end H9 SCROLL
	UpdateFonts(rowTall);
	UpdateAvatarBitmaps(V_max(4, rowTall - 2));

	FillGrid();

	if (gViewPort->m_pSpectatorPanel->m_menuVisible)
	{
		m_pCloseButton->setVisible(true);
	}
	else
	{
		m_pCloseButton->setVisible(false);
	}
}

//-----------------------------------------------------------------------------
// Purpose: Recalculate the team totals
//-----------------------------------------------------------------------------
void ScorePanel::SortTeams()
{
	// clear out team scores
	int i;
	for (i = 1; i <= m_iNumTeams; i++)
	{
		if (!g_TeamInfo[i].scores_overriden)
			g_TeamInfo[i].frags = g_TeamInfo[i].deaths = 0;
		g_TeamInfo[i].ping = g_TeamInfo[i].packetloss = 0;
	}

	// recalc the team scores
	for (i = 1; i < MAX_PLAYERS_HUD; i++)
	{
		if (g_PlayerInfoList[i].name == NULL)
			continue; // empty player slot, skip

		if (g_PlayerExtraInfo[i].teamname[0] == 0)
			continue; // skip over players who are not in a team

		// find what team this player is in
		int j;
		for (j = 1; j <= m_iNumTeams; j++)
		{
			if (!stricmp(g_PlayerExtraInfo[i].teamname, g_TeamInfo[j].name))
				break;
		}
		if (j > m_iNumTeams) // player is not in a team, skip to the next guy
			continue;

		if (!g_TeamInfo[j].scores_overriden)
		{
			g_TeamInfo[j].frags += g_PlayerExtraInfo[i].frags;
			g_TeamInfo[j].deaths += g_PlayerExtraInfo[i].deaths;
		}

		g_TeamInfo[j].ping += g_PlayerInfoList[i].ping;
		g_TeamInfo[j].packetloss += g_PlayerInfoList[i].packetloss;

		if (0 != g_PlayerInfoList[i].thisplayer)
			g_TeamInfo[j].ownteam = true;
		else
			g_TeamInfo[j].ownteam = false;

		// Set the team's number (used for team colors)
		g_TeamInfo[j].teamnumber = g_PlayerExtraInfo[i].teamnumber;
	}

	// find team ping/packetloss averages
	for (i = 1; i <= m_iNumTeams; i++)
	{
		g_TeamInfo[i].already_drawn = false;

		if (g_TeamInfo[i].players > 0)
		{
			g_TeamInfo[i].ping /= g_TeamInfo[i].players;	   // use the average ping of all the players in the team as the teams ping
			g_TeamInfo[i].packetloss /= g_TeamInfo[i].players; // use the average ping of all the players in the team as the teams ping
		}
	}
}

//-----------------------------------------------------------------------------
// Purpose: The blocks to show, in order: free-for-all, one sorted list; teams,
//          one per team in team-number order. Players without a team go to the
//          spectator strip.
//-----------------------------------------------------------------------------
void ScorePanel::BuildBlocks()
{
	m_iNumBlocks = 0;
	m_iNumSpec = 0;

	if (!gHUD.m_Teamplay)
	{
		ScoreBlock& block = m_Blocks[m_iNumBlocks++];
		block.team = 0;
		block.count = 0;
		for (int i = 1; i < MAX_PLAYERS_HUD; i++)
		{
			if (ScorePlayerValid(i))
				block.players[block.count++] = i;
		}
		ScoreSortPlayers(block.players, block.count);
		return;
	}

	// teams with players, by team number (an unnumbered team last)
	int order[MAX_TEAMS + 1];
	int numTeams = 0;
	for (int t = 1; t <= m_iNumTeams && t <= MAX_TEAMS; t++)
	{
		if (g_TeamInfo[t].players < 1 || g_TeamInfo[t].name[0] == 0)
			continue;
		const int key = g_TeamInfo[t].teamnumber > 0 ? g_TeamInfo[t].teamnumber : 0x7fff;
		int j = numTeams - 1;
		while (j >= 0)
		{
			const int other = g_TeamInfo[order[j]].teamnumber > 0 ? g_TeamInfo[order[j]].teamnumber : 0x7fff;
			if (other <= key)
				break;
			order[j + 1] = order[j];
			j--;
		}
		order[j + 1] = t;
		numTeams++;
	}

	bool placed[MAX_PLAYERS_HUD + 1] = {};
	for (int n = 0; n < numTeams && m_iNumBlocks < MAX_SCOREBOARD_TEAMS + 1; n++)
	{
		const int t = order[n];
		ScoreBlock& block = m_Blocks[m_iNumBlocks++];
		block.team = t;
		block.count = 0;
		for (int i = 1; i < MAX_PLAYERS_HUD; i++)
		{
			if (!ScorePlayerValid(i) || placed[i])
				continue;
			if (stricmp(g_PlayerExtraInfo[i].teamname, g_TeamInfo[t].name))
				continue;
			block.players[block.count++] = i;
			placed[i] = true;
		}
		ScoreSortPlayers(block.players, block.count);
	}

	for (int i = 1; i < MAX_PLAYERS_HUD; i++)
	{
		if (ScorePlayerValid(i) && !placed[i])
			m_iSpecPlayers[m_iNumSpec++] = i;
	}
}

//-----------------------------------------------------------------------------
// Purpose: Lay the blocks into the columns, capacity rows each. First every
//          block in its own column (block 1 left, block 2 right, the rest
//          wherever there are fewer rows), as far as it fits; then each block's
//          overflow in the other column, under a "(cont.)" header. Returns true
//          when every player has a row. With truncate set it always fills the
//          columns, and the last row says how many did not fit.
//-----------------------------------------------------------------------------
bool ScorePanel::FlowBlocks(int capacity, ColumnFill* cols, bool truncate)
{
	int home[MAX_SCOREBOARD_TEAMS + 1];
	int next[MAX_SCOREBOARD_TEAMS + 1];
	bool headed[MAX_SCOREBOARD_TEAMS + 1];

	for (int c = 0; c < SB_NUM_COLUMNS; c++)
		cols[c].used = 0;

	auto push = [&](int col, int kind, int index)
	{
		ScoreRow& row = cols[col].rows[cols[col].used++];
		row.kind = kind;
		row.index = index;
	};

	for (int b = 0; b < m_iNumBlocks; b++)
	{
		const ScoreBlock& block = m_Blocks[b];
		int col = b < SB_NUM_COLUMNS ? b : (cols[0].used <= cols[1].used ? 0 : 1);
		if (cols[col].used + 2 > capacity)
			col = 1 - col;
		home[b] = col;
		next[b] = 0;
		headed[b] = false;

		// a header needs room for itself and a player
		if (cols[col].used + 2 > capacity)
			continue;
		push(col, ROW_TEAM, block.team);
		headed[b] = true;
		while (next[b] < block.count && cols[col].used < capacity)
			push(col, ROW_PLAYER, block.players[next[b]++]);
	}

	int dropped = 0;
	for (int b = 0; b < m_iNumBlocks; b++)
	{
		const ScoreBlock& block = m_Blocks[b];
		int col = 1 - home[b];
		for (int tries = 0; tries < SB_NUM_COLUMNS && next[b] < block.count; tries++, col = 1 - col)
		{
			if (cols[col].used + 2 > capacity)
				continue;
			push(col, headed[b] ? ROW_CONT : ROW_TEAM, block.team);
			headed[b] = true;
			while (next[b] < block.count && cols[col].used < capacity)
				push(col, ROW_PLAYER, block.players[next[b]++]);
		}
		dropped += block.count - next[b];
	}

	if (0 == dropped)
		return true;
	if (!truncate)
		return false;

	// "... N more" as the last row of the right column (the left one while the right is empty)
	const int col = cols[1].used > 0 ? 1 : 0;
	if (cols[col].used >= capacity)
	{
		if (cols[col].rows[cols[col].used - 1].kind == ROW_PLAYER)
			dropped++;
		cols[col].used--;
	}
	push(col, ROW_MORE, dropped);
	return true;
}

//-----------------------------------------------------------------------------
// Purpose: The cells' places within a column, and the column titles', for rows
//          of rowTall pixels. The avatar cell is square: as wide as a row is high.
//-----------------------------------------------------------------------------
void ScorePanel::PlaceCells(int rowTall)
{
	const int gap = XRES(SB_CELL_GAP);
	m_iCellWide[SB_CELL_AVATAR] = rowTall;
	m_iCellWide[SB_CELL_STATUS] = XRES(SB_STATUS_WIDE);
	s_bCellsClass = g_bScoreClass;
	m_iCellWide[SB_CELL_CLASS] = g_bScoreClass ? SB_CLASS_ICON + 2 : 0; // H9 CLASS ICONS
	// ---- H9 KILLS: while the frags are points, the frags column is SCORE (as wide as LIVES, for its
	// title) and the real kills get a K column of their own; on any other server that has no width.
	s_bCellsKills = g_bScoreKills;
	m_iCellWide[SB_CELL_KILLS] = XRES(g_bScoreKills ? SB_LIVES_WIDE : SB_NUMBER_WIDE);
	m_iCellWide[SB_CELL_KCOUNT] = g_bScoreKills ? XRES(SB_NUMBER_WIDE) : 0;
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		m_HeaderLabels[c][SB_CELL_KILLS].setText(g_bScoreKills ? "SCORE" : "K");
		m_HeaderLabels[c][SB_CELL_KCOUNT].setText(g_bScoreKills ? "K" : "");
	}
	// ---- end H9 KILLS
	m_iCellWide[SB_CELL_DEATHS] = XRES(SB_NUMBER_WIDE);
	m_iCellWide[SB_CELL_ASSISTS] = XRES(SB_NUMBER_WIDE);
	m_iCellWide[SB_CELL_LIVES] = XRES(SB_LIVES_WIDE); // H9 LIVES
	m_iCellWide[SB_CELL_PING] = XRES(SB_PING_WIDE);
	m_iCellWide[SB_CELL_VOICE] = V_max(XRES(SB_VOICE_WIDE), 16); // the speaker icons are 16x16

	// ---- H9 POOL: where a side's lives are one pool the column is titled REINFORCEMENTS: the longest of that, REINFORCE and
	// REINF whose width costs the names no more than 55% of theirs, the column widened to hold it.
	s_bCellsPool = g_bScorePool;
	const char* livesTitle = "LIVES";
	if (g_bScorePool)
	{
		static const char* const s_szPoolTitles[] = {"REINFORCEMENTS", "REINFORCE", "REINF"};
		int others = gap * 2;
		for (int k = 0; k < SB_NUM_CELLS; k++)
		{
			if (k != SB_CELL_NAME && k != SB_CELL_LIVES)
				others += m_iCellWide[k];
		}
		const int livesWide = m_iCellWide[SB_CELL_LIVES];
		const int nameWide = V_max(XRES(24), m_iColumnWide - others - livesWide);
		Font* font = GetFontForTall(YRES(SB_HEADER_TALL) * 85 / 100, 0);
		for (int i = 0; i < 3; i++)
		{
			int w = 0, h = 0;
			font->getTextSize(s_szPoolTitles[i], w, h);
			const int need = w + XRES(4);
			livesTitle = s_szPoolTitles[i];
			if (need <= livesWide)
				break;
			if (need - livesWide <= nameWide * 55 / 100)
			{
				m_iCellWide[SB_CELL_LIVES] = need;
				break;
			}
		}
	}
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
		m_HeaderLabels[c][SB_CELL_LIVES].setText(livesTitle);
	// ---- end H9 POOL

	int fixed = gap * 2;
	for (int k = 0; k < SB_NUM_CELLS; k++)
	{
		if (k != SB_CELL_NAME)
			fixed += m_iCellWide[k];
	}
	m_iCellWide[SB_CELL_NAME] = V_max(XRES(24), m_iColumnWide - fixed);

	int x = 0;
	for (int k = 0; k < SB_NUM_CELLS; k++)
	{
		m_iCellX[k] = x;
		x += m_iCellWide[k];
		// the gap that splits a row in two comes after the class icon: the icon belongs to the name's side (it has no width where no class is sent)
		if (k == SB_CELL_AVATAR || k == SB_CELL_CLASS)
			x += gap;
	}

	const int headTall = YRES(SB_HEADER_TALL);
	const int headY = m_iRowsTop - YRES(2) - headTall;
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		for (int k = 0; k < SB_NUM_CELLS; k++)
			m_HeaderLabels[c][k].setBounds(m_iColumnX[c] + m_iCellX[k], headY, m_iCellWide[k], headTall);
	}
}

//-----------------------------------------------------------------------------
// Purpose: The row fonts for rows of rowTall pixels.
//-----------------------------------------------------------------------------
void ScorePanel::UpdateFonts(int rowTall)
{
	if (rowTall == m_iFontRowTall)
		return;
	m_iFontRowTall = rowTall;
	m_pRowFont = GetFontForTall(rowTall * 85 / 100, 0);
	m_pHeadFont = GetFontForTall(rowTall * 85 / 100, 700);
}

//-----------------------------------------------------------------------------
// Purpose: The silhouette, and every player's picture, at size x size.
//-----------------------------------------------------------------------------
void ScorePanel::UpdateAvatarBitmaps(int size)
{
	if (size == m_iAvatarSize)
		return;
	m_iAvatarSize = size;
	m_pSilhouette = GetSilhouette(size);

	// pictures drawn at the old size: the cells let go of them, then they are redrawn on use
	for (int r = 0; r < SB_NUM_ROWS; r++)
		m_Cells[r][SB_CELL_AVATAR].setImage(NULL);
	for (int i = 0; i <= MAX_PLAYERS_HUD; i++)
	{
		if (g_PlayerAvatars[i].bitmap && g_PlayerAvatars[i].bitmapSize != size)
		{
			delete g_PlayerAvatars[i].bitmap;
			g_PlayerAvatars[i].bitmap = NULL;
		}
	}
}

//-----------------------------------------------------------------------------
// Purpose: text, cut with ".." to fit wide pixels in font.
//-----------------------------------------------------------------------------
void ScorePanel::FitText(Font* font, const char* text, int wide, char* out, int outSize)
{
	int a, b, c;
	int dots = 0;
	font->getCharABCwide('.', a, b, c);
	dots = (a + b + c) * 2;

	int total = 0;
	int len = 0;
	int fitLen = 0; // characters that fit with ".." after them
	for (const char* ch = text; *ch && len < outSize - 3; ch++, len++)
	{
		font->getCharABCwide((unsigned char)*ch, a, b, c);
		total += a + b + c;
		if (total + dots <= wide)
			fitLen = len + 1;
	}

	if (total <= wide && text[len] == 0)
	{
		strncpy(out, text, outSize - 1);
		out[outSize - 1] = 0;
		return;
	}

	memcpy(out, text, fitLen);
	out[fitLen] = '.';
	out[fitLen + 1] = '.';
	out[fitLen + 2] = 0;
}

void ScorePanel::FillGrid()
{
	// update highlight position
	int x, y;
	getApp()->getCursorPos(x, y);
	cursorMoved(x, y, this);

	// remove highlight row if we're not in squelch mode
	if (!GetClientVoiceMgr()->IsInSquelchMode())
	{
		m_iHighlightRow = -1;
	}

	// The speaker icons follow the rows: every row attaches its player's again below.
	GetClientVoiceMgr()->DetachBanButtons();

	for (int r = 0; r < SB_NUM_ROWS; r++)
		FillRow(r);

	FillSpectators();

	// map and player count
	char szMap[64];
	const char* level = gEngfuncs.pfnGetLevelName();
	const char* base = level ? strrchr(level, '/') : NULL;
	strncpy(szMap, base ? base + 1 : (level ? level : ""), sizeof(szMap) - 1);
	szMap[sizeof(szMap) - 1] = 0;
	char* ext = strrchr(szMap, '.');
	if (ext)
		*ext = 0;

	int players = 0;
	for (int i = 1; i < MAX_PLAYERS_HUD; i++)
	{
		if (ScorePlayerValid(i))
			players++;
	}

	char szInfo[128];
	snprintf(szInfo, sizeof(szInfo), "%s    %d/%d", szMap, players, gEngfuncs.GetMaxClients());
	m_TitleInfo.setText(szInfo);
}

//-----------------------------------------------------------------------------
// Purpose: Place and fill row widget r from m_Rows[r].
//-----------------------------------------------------------------------------
void ScorePanel::FillRow(int r)
{
	const ScoreRow& row = m_Rows[r];

	if (row.kind == ROW_NONE)
	{
		for (int k = 0; k < SB_NUM_CELLS; k++)
			m_Cells[r][k].setVisible(false);
		return;
	}

	const int col = r / SB_ROWS_PER_COLUMN;
	// H9 SCROLL: widget 0 of a column sits on the board, the others inside its clip panel
	const int x0 = (r % SB_ROWS_PER_COLUMN == 0) ? m_iColumnX[col] : 0;
	const int y = m_iRowY[r];

	for (int k = 0; k < SB_NUM_CELLS; k++)
	{
		CLabelHeader* pLabel = &m_Cells[r][k];
		pLabel->setVisible(true);
		pLabel->setText2("");
		pLabel->setImage(NULL);
		pLabel->setTailImage(NULL, 0); // H9 LEVEL BADGES
		pLabel->setFgColorAsImageColor(true);
		pLabel->setFont(m_pRowFont);
		pLabel->setTextOffset(0, 0);
		pLabel->setBounds(x0 + m_iCellX[k], y, m_iCellWide[k], m_iRowTall);
		pLabel->setBgColor(0, 0, 0, 255);
		pLabel->setFgColor(Scheme::sc_primary1);
		if (k == SB_CELL_NAME || k == SB_CELL_STATUS)
			pLabel->setContentAlignment(vgui::Label::a_west);
		else if (k == SB_CELL_AVATAR || k == SB_CELL_VOICE || k == SB_CELL_CLASS)
			pLabel->setContentAlignment(vgui::Label::a_center);
		else
			pLabel->setContentAlignment(vgui::Label::a_east);
		pLabel->setText("");
	}

	CLabelHeader* pName = &m_Cells[r][SB_CELL_NAME];
	char sz[128];
	char szFit[128];

	if (row.kind == ROW_TEAM || row.kind == ROW_CONT || row.kind == ROW_MORE)
	{
		// One wide label from the avatar cell to the end of the name cell.
		const int left = m_iCellX[SB_CELL_AVATAR];
		const int wide = m_iCellX[SB_CELL_CLASS] + m_iCellWide[SB_CELL_CLASS] - left;
		pName->setBounds(x0 + left, y, wide, m_iRowTall);
		m_Cells[r][SB_CELL_AVATAR].setVisible(false);
		m_Cells[r][SB_CELL_STATUS].setVisible(false);
		m_Cells[r][SB_CELL_VOICE].setVisible(false);
		m_Cells[r][SB_CELL_CLASS].setVisible(false);

		if (row.kind == ROW_MORE)
		{
			snprintf(sz, sizeof(sz), "... %d more", row.index);
			pName->setFgColor(150, 150, 150, 0);
			pName->setText(sz);
			for (int k = SB_CELL_KILLS; k <= SB_CELL_PING; k++)
				m_Cells[r][k].setVisible(false);
			return;
		}

		const team_info_t* team = row.index > 0 ? &g_TeamInfo[row.index] : NULL;
		int tr = 223, tg = 213, tb = 245; // free-for-all: the scheme's text colour
		if (team)
		{
			tr = iTeamColors[team->teamnumber % iNumberOfTeamColors][0];
			tg = iTeamColors[team->teamnumber % iNumberOfTeamColors][1];
			tb = iTeamColors[team->teamnumber % iNumberOfTeamColors][2];
		}

		// the block's players, for the free-for-all count and the assist total
		const ScoreBlock* block = NULL;
		for (int b = 0; b < m_iNumBlocks; b++)
		{
			if (m_Blocks[b].team == row.index)
				block = &m_Blocks[b];
		}
		const int count = block ? block->count : 0;

		const char* name = team ? gViewPort->GetTeamName(team->teamnumber) : FreeForAllLabel(); // H9 BOARD
		if (!name || !name[0])
			name = team ? team->name : "";
		if (row.kind == ROW_CONT)
			snprintf(sz, sizeof(sz), "%s (cont.)", name);
		else
			snprintf(sz, sizeof(sz), "%s (%d)", name, team ? team->players : count);

		for (int k = 0; k < SB_NUM_CELLS; k++)
		{
			m_Cells[r][k].setFont(m_pHeadFont);
			m_Cells[r][k].setFgColor(tr, tg, tb, 0);
			m_Cells[r][k].setBgColor(tr, tg, tb, 215);
		}
		FitText(m_pHeadFont, sz, wide, szFit, sizeof(szFit));
		pName->setText(szFit);

		if (row.kind == ROW_CONT || !team)
		{
			for (int k = SB_CELL_KILLS; k <= SB_CELL_PING; k++)
				m_Cells[r][k].setBgColor(0, 0, 0, 255);
			if (row.kind == ROW_CONT)
				pName->setBgColor(0, 0, 0, 255);
			return;
		}

		snprintf(sz, sizeof(sz), "%d", team->frags);
		m_Cells[r][SB_CELL_KILLS].setText(sz);
		// ---- H9 KILLS: the team's real kills, summed from H9Kills
		if (g_bScoreKills && block)
		{
			int kills = 0;
			for (int i = 0; i < block->count; i++)
				kills += g_PlayerExtraInfo[block->players[i]].kills;
			snprintf(sz, sizeof(sz), "%d", kills);
			m_Cells[r][SB_CELL_KCOUNT].setText(sz);
		}
		// ---- end H9 KILLS
		snprintf(sz, sizeof(sz), "%d", team->deaths);
		m_Cells[r][SB_CELL_DEATHS].setText(sz);
		if (g_bScoreAssists && block)
		{
			int assists = 0;
			for (int i = 0; i < block->count; i++)
				assists += g_PlayerExtraInfo[block->players[i]].assists;
			snprintf(sz, sizeof(sz), "%d", assists);
			m_Cells[r][SB_CELL_ASSISTS].setText(sz);
		}
		// ---- H9 POOL: a side whose lives are one pool shows the pool, what is left of what the round started with
		if (g_bScorePool && row.index >= 1 && row.index <= 2 && g_iScorePoolStart[row.index] > 0)
		{
			snprintf(sz, sizeof(sz), "%d/%d", g_iScorePoolLeft[row.index], g_iScorePoolStart[row.index]);
			m_Cells[r][SB_CELL_LIVES].setText(sz);
		}
		// ---- H9 LIVES: the team's lives left out of all its players' lives, summed from H9Lives
		else if (g_bScoreLives && block)
		{
			int left = 0, lives = 0;
			bool endless = false;
			for (int i = 0; i < block->count; i++)
			{
				const extra_player_info_t* e = &g_PlayerExtraInfo[block->players[i]];
				if (e->lives_max <= 0)
					continue;
				if (e->lives_left == SB_LIVES_ENDLESS)
				{
					endless = true;
					continue;
				}
				left += e->lives_left;
				lives += e->lives_max;
			}
			if (endless)
				m_Cells[r][SB_CELL_LIVES].setText("-");
			else if (lives > 0)
			{
				snprintf(sz, sizeof(sz), "%d/%d", left, lives);
				m_Cells[r][SB_CELL_LIVES].setText(sz);
			}
		}
		// ---- end H9 LIVES
		snprintf(sz, sizeof(sz), "%d", team->ping);
		m_Cells[r][SB_CELL_PING].setText(sz);
		return;
	}

	// ROW_PLAYER
	const int slot = row.index;
	const hud_player_info_t* pl_info = &g_PlayerInfoList[slot];
	const extra_player_info_t* extra = &g_PlayerExtraInfo[slot];
	const int teamColor = extra->teamnumber % iNumberOfTeamColors;
	int fr = iTeamColors[teamColor][0];
	int fg = iTeamColors[teamColor][1];
	int fb = iTeamColors[teamColor][2];

	extern int g_iTSPlayerAward[];
	extern bool TS_PlayerSpectating(int idx);
	const int award = g_iTSPlayerAward[slot];

	// dead players dimmed
	if (award == 1)
	{
		fr = 110;
		fg = 110;
		fb = 110;
	}

	int br = 0, bg = 0, bb = 0, ba = 255;
	if (0 != pl_info->thisplayer)
	{
		// the local player's row: white on the team colour
		br = iTeamColors[teamColor][0];
		bg = iTeamColors[teamColor][1];
		bb = iTeamColors[teamColor][2];
		ba = 196;
		fr = fg = fb = 255;
	}
	else if (slot == m_iLastKilledBy && 0 != m_fLastKillTime && m_fLastKillTime > gHUD.m_flTime)
	{
		// Killer's name
		br = 255;
		ba = 255 - ((float)15 * (float)(m_fLastKillTime - gHUD.m_flTime));
	}

	for (int k = 0; k < SB_NUM_CELLS; k++)
	{
		m_Cells[r][k].setFgColor(fr, fg, fb, 0);
		m_Cells[r][k].setBgColor(br, bg, bb, ba);
	}

	// the picture, or the silhouette, with the cell's link icon (H9 LINK ICONS)
	CLabelHeader* pAvatar = &m_Cells[r][SB_CELL_AVATAR];
	ScoreAvatar* avatar = &g_PlayerAvatars[slot];
	const int icon = LinkIconFor(slot);
	vgui::Image* image = GetSilhouette(m_iAvatarSize, icon);
	if (avatar->pixels)
	{
		if (avatar->bitmap && avatar->bitmapIcon != icon)
		{
			RetireLinkBitmap(avatar->bitmap);
			avatar->bitmap = NULL;
		}
		if (!avatar->bitmap)
		{
			avatar->bitmap = new CAvatarBitmap(m_iAvatarSize, avatar->pixels, avatar->wide, avatar->tall, icon);
			avatar->bitmapSize = m_iAvatarSize;
			avatar->bitmapIcon = icon;
		}
		image = avatar->bitmap;
	}
	pAvatar->setFgColorAsImageColor(false);
	pAvatar->setImage(image);

	// client.dll's FillGrid (0x1005e212) shows the player's TSPAward byte in its status column: 1
	// DEAD, 2 3 KILLS, 3 6 KILLS, 4 SPECIALIST, 5 UNSTOPPABLE, 10 THE ONE (each kill tier in its own
	// green), 11 WAITING; any other value WAITING while the Spectator table marks him, else
	// nothing. The narrow column takes them in short form.
	//
	// H9 LEVELS: a proven havoc9.org account's level badge, the avatar's size (H9 LEVEL BADGES), sits
	// at the right end of this column, beside the name and not in it: no name moves for it, and a
	// status too long for what the badge leaves is cut with ".."; "Lv N" before the name where that
	// level's picture is missing
	const int level = slot > 0 && slot <= MAX_PLAYERS_HUD && s_PlayerLevel[slot] ? s_PlayerLevel[slot] - 1 : -1;
	CLevelBitmap* levelBadge = level >= 0 ? GetLevelBitmap(level, m_iAvatarSize) : NULL;
	CLabelHeader* pStatus = &m_Cells[r][SB_CELL_STATUS];
	const char* status = "";
	switch (award)
	{
	case 1: status = "DEAD"; break;
	case 2: status = "3K"; pStatus->setFgColor(0x7d, 0xff, 0x7d, 5); break;
	case 3: status = "6K"; pStatus->setFgColor(0x87, 0xff, 0x87, 5); break;
	case 4: status = "SPEC"; pStatus->setFgColor(0x91, 0xff, 0x91, 5); break;
	case 5: status = "UNSTOP"; pStatus->setFgColor(0x9b, 0xff, 0x9b, 5); break;
	case 10: status = "ONE"; pStatus->setFgColor(0xaf, 0xff, 0xaf, 5); break;
	case 11: status = "WAIT"; break;
	default: status = TS_PlayerSpectating(slot) ? "WAIT" : ""; break;
	}
	const int badgeRoom = levelBadge ? m_iAvatarSize + XRES(SB_CELL_GAP) * 2 : 0;
	FitText(m_pRowFont, status, m_iCellWide[SB_CELL_STATUS] - badgeRoom, szFit, sizeof(szFit));
	pStatus->setText(szFit);
	pStatus->setTailImage(levelBadge, XRES(SB_CELL_GAP));

	char szNamed[160];
	if (level >= 0 && !levelBadge)
		snprintf(szNamed, sizeof(szNamed), "Lv %d  %s", level, pl_info->name ? pl_info->name : "");
	else
		snprintf(szNamed, sizeof(szNamed), "%s", pl_info->name ? pl_info->name : "");
	FitText(m_pRowFont, szNamed, m_iCellWide[SB_CELL_NAME] - XRES(2), szFit, sizeof(szFit));
	pName->setText(szFit);

	snprintf(sz, sizeof(sz), "%d", extra->frags);
	m_Cells[r][SB_CELL_KILLS].setText(sz);
	if (g_bScoreKills) // H9 KILLS: the real kills, beside the points
	{
		snprintf(sz, sizeof(sz), "%d", extra->kills);
		m_Cells[r][SB_CELL_KCOUNT].setText(sz);
	}
	snprintf(sz, sizeof(sz), "%d", extra->deaths);
	m_Cells[r][SB_CELL_DEATHS].setText(sz);
	if (g_bScoreAssists)
	{
		snprintf(sz, sizeof(sz), "%d", extra->assists);
		m_Cells[r][SB_CELL_ASSISTS].setText(sz);
	}
	// ---- H9 LIVES: lives left out of the class's lives; "-" on a side that never runs out
	if (g_bScoreLives && extra->lives_max > 0)
	{
		if (extra->lives_left == SB_LIVES_ENDLESS)
			strcpy(sz, "-");
		else
			snprintf(sz, sizeof(sz), "%d/%d", extra->lives_left, extra->lives_max);
		m_Cells[r][SB_CELL_LIVES].setText(sz);
	}
	// ---- end H9 LIVES

	// ---- H9 CLASS ICONS: the class icon the server named for this player, none for one it did not
	if (g_bScoreClass && extra->h9class > 0)
	{
		const int size = m_iRowTall < SB_CLASS_ICON ? m_iRowTall : SB_CLASS_ICON;
		CLevelBitmap* icon = GetClassBitmap(extra->h9class - 1, size);
		if (icon)
		{
			m_Cells[r][SB_CELL_CLASS].setFgColorAsImageColor(false);
			m_Cells[r][SB_CELL_CLASS].setImage(icon);
		}
	}
	// ---- end H9 CLASS ICONS

	const char* bot = gEngfuncs.PlayerInfo_ValueForKey(slot, "*bot");
	if (bot && bot[0] == '1')
		strcpy(sz, "BOT");
	else
		snprintf(sz, sizeof(sz), "%d", pl_info->ping);
	m_Cells[r][SB_CELL_PING].setText(sz);

	GetClientVoiceMgr()->UpdateSpeakerImage(&m_Cells[r][SB_CELL_VOICE], slot);
}

//-----------------------------------------------------------------------------
// Purpose: "Spectators (N): name, name ... +N", cut to the strip's width.
//-----------------------------------------------------------------------------
void ScorePanel::FillSpectators()
{
	if (0 == m_iNumSpec)
	{
		m_SpecLabel.setText("");
		return;
	}

	int wide, tall;
	m_SpecLabel.getSize(wide, tall);
	Font* font = m_pSpecFont;

	char sz[1024];
	snprintf(sz, sizeof(sz), "Spectators (%d): ", m_iNumSpec);

	auto width = [&](const char* text)
	{
		int total = 0;
		for (const char* ch = text; *ch; ch++)
		{
			int a, b, c;
			font->getCharABCwide((unsigned char)*ch, a, b, c);
			total += a + b + c;
		}
		return total;
	};

	for (int i = 0; i < m_iNumSpec; i++)
	{
		const char* name = g_PlayerInfoList[m_iSpecPlayers[i]].name;
		char next[1024];
		snprintf(next, sizeof(next), "%s%s%s", sz, i > 0 ? ", " : "", name ? name : "");

		char more[32];
		snprintf(more, sizeof(more), " ... +%d", m_iNumSpec - i - 1);
		const bool last = i == m_iNumSpec - 1;
		if (width(next) + (last ? 0 : width(more)) > wide)
		{
			snprintf(more, sizeof(more), " ... +%d", m_iNumSpec - i);
			strncat(sz, more, sizeof(sz) - strlen(sz) - 1);
			break;
		}
		strncpy(sz, next, sizeof(sz) - 1);
		sz[sizeof(sz) - 1] = 0;
	}
	m_SpecLabel.setText(sz);
}

//-----------------------------------------------------------------------------
// Purpose: Recalculate the existing teams in the match
//-----------------------------------------------------------------------------
void ScorePanel::RebuildTeams()
{
	// clear out player counts from teams
	int i;
	for (i = 1; i <= m_iNumTeams; i++)
	{
		g_TeamInfo[i].players = 0;
	}

	// rebuild the team list
	gViewPort->GetAllPlayersInfo();
	m_iNumTeams = 0;
	for (i = 1; i < MAX_PLAYERS_HUD; i++)
	{
		if (g_PlayerInfoList[i].name == NULL)
			continue;

		if (g_PlayerExtraInfo[i].teamname[0] == 0)
			continue; // skip over players who are not in a team

		// is this player in an existing team?
		int j;
		for (j = 1; j <= m_iNumTeams; j++)
		{
			if (g_TeamInfo[j].name[0] == '\0')
				break;

			if (!stricmp(g_PlayerExtraInfo[i].teamname, g_TeamInfo[j].name))
				break;
		}

		if (j > m_iNumTeams)
		{ // they aren't in a listed team, so make a new one
			// search through for an empty team slot
			for (j = 1; j <= m_iNumTeams; j++)
			{
				if (g_TeamInfo[j].name[0] == '\0')
					break;
			}
			m_iNumTeams = V_max(j, m_iNumTeams);

			strncpy(g_TeamInfo[j].name, g_PlayerExtraInfo[i].teamname, MAX_TEAM_NAME);
			g_TeamInfo[j].players = 0;
		}

		g_TeamInfo[j].players++;
	}

	// clear out any empty teams
	for (i = 1; i <= m_iNumTeams; i++)
	{
		if (g_TeamInfo[i].players < 1)
			memset(&g_TeamInfo[i], 0, sizeof(team_info_t));
	}

	// Update the scoreboard
	Update();
}


//-----------------------------------------------------------------------------
// Purpose: Setup highlights for player names in scoreboard
//-----------------------------------------------------------------------------
void ScorePanel::DeathMsg(int killer, int victim)
{
	// if we were the one killed,  or the world killed us, set the scoreboard to indicate suicide
	if (victim == m_iPlayerNum || killer == 0)
	{
		m_iLastKilledBy = 0 != killer ? killer : m_iPlayerNum;
		m_fLastKillTime = gHUD.m_flTime + 10; // display who we were killed by for 10 seconds

		if (killer == m_iPlayerNum)
			m_iLastKilledBy = m_iPlayerNum;
	}
}


void ScorePanel::Open()
{
	ResetScroll(); // H9 SCROLL: every opening starts at the top
	RebuildTeams();
	setVisible(true);
	m_HitTestPanel.setVisible(true);
}

// ---- H9 SCROLL ----------------------------------------------------------------------------------
// A column whose rows do not fit even at the shortest row height scrolls (cl_h9_scoreboard_scroll,
// default 1): while the board is held open the mouse wheel moves the column under the pointer, or
// both columns when there is no pointer, three rows a notch, and PgUp/PgDn a page. The motion is
// eased, the rows are clipped to the column, the team header stays pinned at the top, and a thin
// bar at a scrolling column's edge shows where in it the board is. Closing the board resets it.

#define SB_SCROLL_NOTCH_ROWS 3
#define SB_SCROLL_EASE 14.0f // the share of the distance left closed per second, as a rate

// The row widgets from the column lists and the scroll: widget 0 of a column shows its first row,
// pinned at the top of the rows; the others show the rows from the scroll position on.
void ScorePanel::MapRows()
{
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		const ColumnFill& list = m_Lists[c];
		const int base = c * SB_ROWS_PER_COLUMN;
		const int scroll = (int)(m_flScroll[c] + 0.5f);
		const int first = m_iRowTall > 0 ? scroll / m_iRowTall : 0;
		for (int i = 0; i < SB_ROWS_PER_COLUMN; i++)
		{
			ScoreRow& row = m_Rows[base + i];
			const int logical = (i == 0) ? 0 : 1 + first + (i - 1);
			if (logical < list.used)
			{
				row = list.rows[logical];
				m_iRowY[base + i] = (i == 0) ? m_iRowsTop : (logical - 1) * m_iRowTall - scroll;
			}
			else
				row.kind = ROW_NONE;
		}
	}
}

// Each column's clip panel: the rows area under its pinned first row.
void ScorePanel::PlaceClips()
{
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
		m_RowClip[c].setBounds(m_iColumnX[c], m_iRowsTop + m_iRowTall, m_iColumnWide, V_max(0, m_iRowsTall - m_iRowTall));
}

// The bar at the right edge of a scrolling column: its length the share of the rows in view, its
// place the share scrolled. Hidden on a column that fits.
void ScorePanel::PlaceScrollBars()
{
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		if (m_iScrollMax[c] <= 0)
		{
			m_ScrollBar[c].setVisible(false);
			continue;
		}
		const int view = V_max(1, m_iRowsTall - m_iRowTall);
		const int content = view + m_iScrollMax[c];
		const int barTall = V_max(YRES(8), view * view / content);
		const int barY = m_iRowsTop + m_iRowTall + (int)((view - barTall) * (m_flScroll[c] / m_iScrollMax[c]));
		const int barWide = V_max(2, XRES(2));
		m_ScrollBar[c].setBounds(m_iColumnX[c] + m_iColumnWide - barWide, barY, barWide, barTall);
		m_ScrollBar[c].setVisible(true);
	}
}

extern bool g_iVisibleMouse; // inputw32.cpp

// A wheel notch (dir -1 up, 1 down) or, with page, a PgUp/PgDn. True when a column moved, so the
// key does no more (the wheel changes no weapon); false when the board has nothing to scroll.
bool ScorePanel::ScrollInput(int dir, bool page)
{
	if (!isVisible())
		return false;

	int only = -1; // the column under the pointer, when there is a pointer
	if (g_iVisibleMouse)
	{
		int cx, cy;
		getApp()->getCursorPos(cx, cy);
		screenToLocal(cx, cy);
		for (int c = 0; c < SB_NUM_COLUMNS; c++)
		{
			if (cx >= m_iColumnX[c] && cx < m_iColumnX[c] + m_iColumnWide)
				only = c;
		}
	}

	bool used = false;
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		if ((only >= 0 && c != only) || m_iScrollMax[c] <= 0)
			continue;
		const int step = page ? V_max(m_iRowTall, m_iRowsTall - m_iRowTall * 2) : m_iRowTall * SB_SCROLL_NOTCH_ROWS;
		float target = m_flScrollTarget[c] + dir * step;
		if (target < 0)
			target = 0;
		if (target > m_iScrollMax[c])
			target = (float)m_iScrollMax[c];
		m_flScrollTarget[c] = target;
		used = true;
	}
	return used;
}

// Every frame while the board is up: each column eases toward where it was sent, closing the same
// share of the distance left each moment, so a run of notches flows instead of jumping.
void ScorePanel::ScrollThink()
{
	if (!isVisible())
		return;
	float dt = (float)gHUD.m_flTimeDelta;
	if (dt <= 0.0f || dt > 0.1f)
		dt = 0.016f;
	const float share = 1.0f - expf(-dt * SB_SCROLL_EASE);

	bool moved = false;
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
	{
		const float diff = m_flScrollTarget[c] - m_flScroll[c];
		if (diff == 0.0f)
			continue;
		if (fabsf(diff) < 0.5f)
			m_flScroll[c] = m_flScrollTarget[c];
		else
			m_flScroll[c] += diff * share;
		moved = true;
	}
	if (moved)
	{
		MapRows();
		FillGrid();
		PlaceScrollBars();
	}
}

void ScorePanel::ResetScroll()
{
	for (int c = 0; c < SB_NUM_COLUMNS; c++)
		m_flScroll[c] = m_flScrollTarget[c] = 0.0f;
}
// ---- end H9 SCROLL ------------------------------------------------------------------------------


void ScorePanel::mousePressed(MouseCode code, Panel* panel)
{
	if (gHUD.m_iIntermission)
		return;

	if (!GetClientVoiceMgr()->IsInSquelchMode())
	{
		GetClientVoiceMgr()->StartSquelchMode();
		m_HitTestPanel.setVisible(false);
	}
	else if (ProfileSlotAt(panel) > 0)
	{
		// H9 PROFILES: a linked player's picture opens their profile on a double-click, and mutes nobody
	}
	else if (m_iHighlightRow >= 0 && m_Rows[m_iHighlightRow].kind == ROW_PLAYER)
	{
		// mouse has been pressed, toggle mute state
		int iPlayer = m_Rows[m_iHighlightRow].index;
		if (iPlayer > 0)
		{
			// print text message
			hud_player_info_t* pl_info = &g_PlayerInfoList[iPlayer];

			if (pl_info && pl_info->name && '\0' != pl_info->name[0])
			{
				char string[256];
				if (GetClientVoiceMgr()->IsPlayerBlocked(iPlayer))
				{
					char string1[1024];

					// remove mute
					GetClientVoiceMgr()->SetPlayerBlockedState(iPlayer, false);

					sprintf(string1, CHudTextMessage::BufferedLocaliseTextString("#Unmuted"), pl_info->name);
					sprintf(string, "%c** %s\n", HUD_PRINTTALK, string1);

					gHUD.m_TextMessage.MsgFunc_TextMsg(NULL, strlen(string) + 1, string);
				}
				else
				{
					char string1[1024];
					char string2[1024];

					// mute the player
					GetClientVoiceMgr()->SetPlayerBlockedState(iPlayer, true);

					sprintf(string1, CHudTextMessage::BufferedLocaliseTextString("#Muted"), pl_info->name);
					sprintf(string2, "%s", CHudTextMessage::BufferedLocaliseTextString("#No_longer_hear_that_player"));
					sprintf(string, "%c** %s %s\n", HUD_PRINTTALK, string1, string2);

					gHUD.m_TextMessage.MsgFunc_TextMsg(NULL, strlen(string) + 1, string);
				}
			}
		}
	}
}

// ---- H9 PROFILES: the slot a press on this panel opens the profile of: a linked player's picture
// cell; 0 for any other panel.
int ScorePanel::ProfileSlotAt(Panel* panel)
{
	for (int r = 0; r < SB_NUM_ROWS; r++)
	{
		if (panel != &m_Cells[r][SB_CELL_AVATAR])
			continue;
		if (m_Rows[r].kind != ROW_PLAYER || !OpensProfile(m_Rows[r].index))
			return 0;
		return m_Rows[r].index;
	}
	return 0;
}

void ScorePanel::mouseDoublePressed(MouseCode code, Panel* panel)
{
	if (gHUD.m_iIntermission || code != MOUSE_LEFT)
		return;
	const int slot = ProfileSlotAt(panel);
	if (slot <= 0)
		return;
	char cmd[32];
	snprintf(cmd, sizeof(cmd), "h9_profile %d", slot);
	gEngfuncs.pfnClientCmd(cmd);
}
// ---- end H9 PROFILES

void ScorePanel::cursorMoved(int x, int y, Panel* panel)
{
	if (!GetClientVoiceMgr()->IsInSquelchMode())
		return;

	// The labels report their own coordinates; the cursor's screen position is what the cells
	// are tested against.
	int sx, sy;
	getApp()->getCursorPos(sx, sy);

	// look for which cell the mouse is currently over
	for (int r = 0; r < SB_NUM_ROWS; r++)
	{
		if (m_Rows[r].kind != ROW_PLAYER)
			continue;
		for (int k = 0; k < SB_NUM_CELLS; k++)
		{
			if (m_Cells[r][k].isVisible() && m_Cells[r][k].isWithin(sx, sy))
			{
				MouseOverCell(r, k);
				return;
			}
		}
	}
	m_iHighlightRow = -1;
}

//-----------------------------------------------------------------------------
// Purpose: Handles mouse movement over a cell
// Input  : row - the row widget
//			col - the cell
//-----------------------------------------------------------------------------
void ScorePanel::MouseOverCell(int row, int col)
{
	m_iHighlightRow = -1;

	// don't act on teams
	if (m_Rows[row].kind != ROW_PLAYER)
		return;

	// don't act on disconnected players or ourselves
	hud_player_info_t* pl_info = &g_PlayerInfoList[m_Rows[row].index];
	if (!pl_info->name || '\0' == pl_info->name[0])
		return;

	if (0 != pl_info->thisplayer && 0 == gEngfuncs.IsSpectateOnly())
		return;

	// setup the new highlight
	m_iHighlightRow = row;
}

//-----------------------------------------------------------------------------
// Purpose: Label paint functions - take into account current highligh status
//-----------------------------------------------------------------------------
void CLabelHeader::paintBackground()
{
	Color oldBg;
	getBgColor(oldBg);

	if (gViewPort->GetScoreBoard()->m_iHighlightRow == _row)
	{
		setBgColor(134, 91, 19, 0);
	}

	Panel::paintBackground();

	setBgColor(oldBg);
}


//-----------------------------------------------------------------------------
// Purpose: Label paint functions - take into account current highligh status
//-----------------------------------------------------------------------------
void CLabelHeader::paint()
{
	Color oldFg;
	getFgColor(oldFg);

	if (gViewPort->GetScoreBoard()->m_iHighlightRow == _row)
	{
		setFgColor(255, 255, 255, 0);
	}

	// draw text
	int x, y, iwide, itall;
	getTextSize(iwide, itall);
	calcAlignment(iwide, itall, x, y);
	_dualImage->setPos(x, y);

	int x1, y1;
	_dualImage->GetImage(1)->getPos(x1, y1);
	_dualImage->GetImage(1)->setPos(_gap, y1);

	_dualImage->doPaint(this);

	// get size of the panel and the image
	if (_image)
	{
		Color imgColor;
		getFgColor(imgColor);
		if (_useFgColorAsImageColor)
		{
			_image->setColor(imgColor);
		}

		_image->getSize(iwide, itall);
		calcAlignment(iwide, itall, x, y);
		_image->setPos(x, y);
		_image->doPaint(this);
	}

	// H9 LEVEL BADGES: the tail picture at the right edge, centred on the cell's height
	if (_tailImage)
	{
		int twide, ttall, cwide, ctall;
		_tailImage->getSize(twide, ttall);
		getSize(cwide, ctall);
		_tailImage->setPos(cwide - twide - _tailGap, (ctall - ttall) / 2);
		_tailImage->doPaint(this);
	}

	setFgColor(oldFg[0], oldFg[1], oldFg[2], oldFg[3]);
}


void CLabelHeader::calcAlignment(int iwide, int itall, int& x, int& y)
{
	// calculate alignment ourselves, since vgui is so broken
	int wide, tall;
	getSize(wide, tall);

	x = 0, y = 0;

	// align left/right
	switch (_contentAlignment)
	{
	// left
	case Label::a_northwest:
	case Label::a_west:
	case Label::a_southwest:
	{
		x = 0;
		break;
	}

	// center
	case Label::a_north:
	case Label::a_center:
	case Label::a_south:
	{
		x = (wide - iwide) / 2;
		break;
	}

	// right
	case Label::a_northeast:
	case Label::a_east:
	case Label::a_southeast:
	{
		x = wide - iwide;
		break;
	}
	}

	// top/down
	switch (_contentAlignment)
	{
	// top
	case Label::a_northwest:
	case Label::a_north:
	case Label::a_northeast:
	{
		y = 0;
		break;
	}

	// center
	case Label::a_west:
	case Label::a_center:
	case Label::a_east:
	{
		y = (tall - itall) / 2;
		break;
	}

	// south
	case Label::a_southwest:
	case Label::a_south:
	case Label::a_southeast:
	{
		y = tall - itall;
		break;
	}
	}

	// don't clip to Y
	//	if (y < 0)
	//	{
	//		y = 0;
	//	}
	if (x < 0)
	{
		x = 0;
	}

	x += _offset[0];
	y += _offset[1];
}
