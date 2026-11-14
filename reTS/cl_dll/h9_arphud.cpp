// ---- H9 ARP HUD -------------------------------------------------------------------------------------------------
// Apollo RP's HUD (the text at the left of the screen: the server's title and city, the wallet, the bank, the payday, the
// salary, the job, and the lines other plugins add) as panels on H9's purple art, for a server that sends it: the H9ArpHud user
// message. h9_arphud.h is the outline; docs\APOLLO_RP.txt section 2 is what a player sees and COMMANDS.txt the switches.
//
//   byte    op: 1 the lines of one HUD, 2 one HUD taken down, 3 every HUD taken down
//   op 1    byte hud (0 to 3, ARP's HUD_PRIM to HUD_QUAT), byte the number of this content, byte part (bits 0 to 3) with bit 7 on
//           the last part, byte lines in this part, then in part 0 only: short x, short y (the server's arp_hudN_x and _y in
//           thousandths, -1 centred); then each line: byte kind, string text
//   op 2    byte hud
//
// The kinds of line (HUDK_* of the server's include\ApolloRP_HUD.inc, which says the same): 0 extra, 1 title, 2 wallet, 3 bank,
// 4 payday, 5 salary, 6 job, 7 status, 8 need, 9 icon; a kind this client does not know is extra. The first HUD draws each kind as a line of
// its own, with a switch for it (cl_h9_arphud_<kind>); the second and third HUD draw their first line as a heading. A NEED is the
// text "<label>: <0 to 100>%" ("Hunger: 42%") and is drawn, in any HUD but the notice, as a row with a bar; one whose text is not in
// that form is drawn as the text it is. The run of needs that opens the second or third HUD is headed "Needs". A status line in the
// second or third HUD is a warning row, drawn red. The needs' switch (cl_h9_arphud_needs) is not one of the first HUD's: it takes
// the second or third HUD that holds needs away whole.
//
// An ICON line (kind 9) is the text "icon:<an item's name>" in the notice HUD: not a row but the picture the item has in sprites/h9_arpicons.spr
// (modelling/arpicons, vgui_H9Panel.h), drawn above the notice's box; the server sends it to a game that says _h9vgui 7 alone, and
// cl_h9_arphud_icon switches it.
//
// A PLAQUE is the notice HUD when one of its lines is of kind 10 to 16: what the player looks at (a property door, an NPC, a player). The heading is kind 10; 11 is a field
// ("<Label>: <value>"), 12 the affiliation, 13 and 14 the status (open, sealed), 15 a restriction, 16 a hint. It is drawn as a plate of one width on the panel art (cl_h9_arphud_plaque
// switches it; with 0 its lines are the plain notice they read as). docs\APOLLO_RP.txt, section 2, is what the server sends and why.
//
// A HUD too long for one message comes in parts of one content. What the client holds of a HUD changes when the last part has
// come, and only then, so a part that was lost leaves the HUD as it was. A server is untrusted here: the size of a message, the
// number of lines and rows, how long a notice stays and how long a HUD is kept when nothing refreshes it are this client's own
// limits, whatever a message says. The game says it draws this with the userinfo key _h9arphud, which follows cl_h9_arphud.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "ts_hud.h"
#include "vgui_TeamFortressViewport.h"
#include "h9_vgui.h"
#include "vgui_H9Panel.h"
#include "h9_arphud.h"

#include <string.h>
#include <stdio.h>

namespace
{
#define H9ARP_HUDS 4          // ARP's HUD_PRIM, HUD_SEC, HUD_TER and HUD_QUAT
#define H9ARP_NOTICE 3        // the one that is a short notice
#define H9ARP_MAX_MSG 192     // bytes an H9ArpHud message may have
#define H9ARP_MAX_RATE 48     // messages read a second
#define H9ARP_MAX_LINES 24    // lines of one HUD that are kept
#define H9ARP_LINE_LEN 192    // a line's room, with its end
#define H9ARP_MAX_ROWS 48     // rows of one panel
#define H9ARP_LIFE 150.0f     // seconds a HUD is kept when nothing refreshes it (the server sends again at least once a minute)
#define H9ARP_HOLD 3.0f       // seconds a notice stays
#define H9ARP_FADE 0.25f      // seconds a panel takes to come up or go
#define H9ARP_NEED_WARN 75    // a need at or above this is in the warning colour, and has a mark on its bar
#define H9ARP_NEED_CRIT 90    // a second mark: the need is critical
#define H9ARP_NEED_LABEL 24   // characters of a need's label that are kept

// The kinds of line (HUDK_* of the server's ApolloRP_HUD.inc), and the cvar of each.
enum
{
	KIND_EXTRA = 0,
	KIND_TITLE,
	KIND_WALLET,
	KIND_BANK,
	KIND_PAYDAY,
	KIND_SALARY,
	KIND_JOB,
	KIND_STATUS,
	KIND_COUNT,             // the kinds of the first HUD, each with a switch of its own
	KIND_NEED = KIND_COUNT, // a need, "<label>: <0 to 100>%": a row with a bar in any HUD but the notice; its switch is cl_h9_arphud_needs
	KIND_ICON,              // an item's picture: "icon:<item>" in the notice, drawn above it and not as a row; its switch is cl_h9_arphud_icon
	KIND_PLQ_HEAD,          // the plaque: its heading, and a line that is a field, the affiliation, the status (open, sealed), a restriction and a hint (cl_h9_arphud_plaque)
	KIND_PLQ_ROW,
	KIND_PLQ_TAG,
	KIND_PLQ_OPEN,
	KIND_PLQ_SEALED,
	KIND_PLQ_WARN,
	KIND_PLQ_HINT
};
// the numbers of the server's include\ApolloRP_HUD.inc (HUDK_*)
static_assert(KIND_NEED == 8 && KIND_ICON == 9 && KIND_PLQ_HEAD == 10 && KIND_PLQ_HINT == 16, "the line kinds are the server's numbers");

const char* const kKindCvars[KIND_COUNT] = {"cl_h9_arphud_extra", "cl_h9_arphud_title", "cl_h9_arphud_wallet", "cl_h9_arphud_bank",
	"cl_h9_arphud_payday", "cl_h9_arphud_salary", "cl_h9_arphud_job", "cl_h9_arphud_status"};
const char* const kKindWhat[KIND_COUNT] = {"the lines other plugins add: jail status, the zone, others", "the title and the city",
	"the wallet", "the bank", "the payday countdown", "the salary", "the job", "the dead, account loading and server malfunction lines"};

const char* const kPanelCvars[H9ARP_HUDS] = {"cl_h9_arphud_left", "cl_h9_arphud_top", "cl_h9_arphud_side", "cl_h9_arphud_notice"};
const char* const kPanelWhat[H9ARP_HUDS] = {"HUD 1: the title, wallet, bank, payday, salary, job and the lines other plugins add",
	"HUD 2: ARP's second HUD (stock arp.cfg: top right): the needs, hunger and thirst, as bars",
	"HUD 3: ARP's third HUD (stock arp.cfg: right; the out-of-character chat)",
	"HUD 4: the short notices (what you look at, ammo loaded up, and so on)"};

// ---- the look: the colours and sizes the panels are drawn with, all in this block ----------------------------------
// H9's purples, the values of vgui_H9Panel.cpp. The text itself is the textscheme's Primary Button Text colour (TextColour).
const int LIT_R = 182, LIT_G = 145, LIT_B = 234;   // the heading: the rail's lit purple
const int DET_R = 166, DET_G = 154, DET_B = 192;   // a label before its value
const int RAIL_R = 133, RAIL_G = 98, RAIL_B = 178; // the rail: the line under the heading, and the frame of a bar

// A need's bar: green when it is met, yellow half way to the warning level, red from the warning level up (NeedColour).
const int OK_R = 96, OK_G = 200, OK_B = 120;
const int MID_R = 236, MID_G = 204, MID_B = 84;
const int BAD_R = 236, BAD_G = 96, BAD_B = 96;       // also a need's number from the warning level up, and a warning row
const int MARK_R = 240, MARK_G = 236, MARK_B = 250;  // the marks on a bar, at the warning and the critical level
const int MARK_ALPHA = 170;
const int TRACK_ALPHA = 160;                         // the dark track of a bar: the alpha the progress bars of H9's panels have

// A need's row, "Hunger  [#####-----]  42%": the least gap between its parts, the bar's width in rows and its least and most in
// pixels, the bar's height in percent of the font's (and its least), the part of a row's room the labels may take, in percent.
const int NEED_GAP_MIN = 6;
const int NEED_BAR_MIN_ROWS = 2, NEED_BAR_MIN_PX = 24;
const int NEED_BAR_MAX_ROWS = 6, NEED_BAR_MAX_PX = 48;
const int NEED_BAR_TALL_PERCENT = 60, NEED_BAR_TALL_MIN = 6;
const int NEED_LABEL_PERCENT = 40;

// The art scales at cl_h9_vgui_scale 1, of the screen height / 480: the panels' on the tsm_panel art, a little under the menus'
// 0.51 so a HUD that stays on the screen takes less of it, and the notice's on the tsm_banner art, as every notice is.
const float PANEL_SCALE = 0.40f;
const float NOTICE_SCALE = 0.45f;

// While TS's weapon select is open (the five columns at the top left, with their headers and the cursor's name) the panel at the top of the
// left column stands in a smaller size (cl_h9_arphud_shrink): it starts this far down the font ladder and takes this share of the art's
// scale, and goes back to its size when the select shuts.
const int SHRINK_FONT_STEP = 2;
const float SHRINK_ART = 0.75f;

const int PANEL_MARGIN = 16; // pixels between a panel and the side of the screen
const int BAR_GAP = 8;       // pixels between the weapon bar and a panel that stands under it

// The plaque (what the player looks at: a property door, an NPC, a player) is one plate of a fixed width on the HUD panel art, drawn in the same purples. Its words are upper case,
// its heading has a rail under it, each field is a label and a value, the affiliation and the status are badges. All of its colours and sizes are in this block.
const float PLAQUE_SCALE = 0.45f;       // the art's scale at cl_h9_vgui_scale 1, of the screen height / 480: the notice's
const int PLAQUE_WIDE_PERCENT = 26;     // the plate's width in percent of the screen's, and no narrower than PLAQUE_WIDE_MIN pixels nor wider than PLAQUE_WIDE_MAX_PERCENT of the screen
const int PLAQUE_WIDE_MIN = 200;
const int PLAQUE_WIDE_MAX_PERCENT = 45;
const int PLAQUE_TALL_PERCENT = 50;     // the most of the screen's height it takes; rows that still do not fit at the smallest font are left out
const float PLAQUE_HOLD = 2.5f;         // seconds it stays once the server stops sending it (the server sends again at least every 2 s while the player looks)
const int PLAQUE_LABEL_PERCENT = 46;    // the most of a row's width the labels may take, in percent
const int PLAQUE_HEAD_LINES = 3;        // lines of the heading that are kept
const int PLAQUE_VALUE_LINES = 3;       // lines of a field's value that are kept
const int PLAQUE_BADGE_ALPHA = 70;      // the fill behind a badge's text
const int PLAQUE_MAX_FIELDS = 8;
const int PLAQUE_MAX_HINTS = 2;
const int PLAQUE_LABEL_LEN = 24;
const int PLAQUE_MAX_ROWS = 24;
// ---- end the look ----------------------------------------------------------------------------------------------------

struct Line
{
	int kind;
	char text[H9ARP_LINE_LEN];
};

// One HUD as the client holds it, and how it is drawn.
struct HudSlot
{
	bool have;        // lines are held
	bool hasNeed;     // one of them is a need
	bool plaque;      // one of them is a plaque's heading (kind KIND_PLQ_HEAD)
	int x, y;         // the server's place, in thousandths; -1 centred
	int count;
	Line lines[H9ARP_MAX_LINES];
	float at;         // client time the lines last came; a notice stays from then
	int msgs;         // contents that came whole
	// the content being put together from parts
	bool building;
	int gen;
	int expect;
	int bcount;
	int bx, by;
	Line blines[H9ARP_MAX_LINES];
	// the panel
	bool dirty;       // what it shows must be laid out again
	bool laidOut;     // it has rows to draw
	float alpha;      // 0 to 255
	float barPush;    // how far the weapon bar pushes a top panel of the left column down from where it stands without the bar, eased
	bool shrunk;      // laid out in the smaller size: the weapon select is open and this is the panel at the top of the left column
	int stickyWide[2]; // the widest it has been, in pixels, so its art does not need a new size for each number; [1] in the smaller size
	const char* why;  // what keeps it off the screen, for cl_h9_arphud_list
};

cvar_t* s_cvMaster;                   // cl_h9_arphud: 0 gets the text HUD
cvar_t* s_cvPanel[H9ARP_HUDS];        // cl_h9_arphud_left, _top, _side, _notice
cvar_t* s_cvKind[KIND_COUNT];         // cl_h9_arphud_extra, _title, _wallet, _bank, _payday, _salary, _job, _status
cvar_t* s_cvNeeds;                    // cl_h9_arphud_needs: the needs, as bars
cvar_t* s_cvIcon;                     // cl_h9_arphud_icon: the picture of a dropped item above its notice
cvar_t* s_cvPlaque;                   // cl_h9_arphud_plaque: what the player looks at as a plaque
cvar_t* s_cvShrink;                   // cl_h9_arphud_shrink: the first panel in a smaller size while the weapon select is open
cvar_t* s_cvInfo;                     // _h9arphud: the userinfo key the server reads, 1 or 0
cvar_t* s_cvVgui;                     // cl_h9_vgui

bool s_bInited = false;
HudSlot s_Huds[H9ARP_HUDS];
float s_flLastDraw = -100.0f;
float s_flLastThink = 0.0f;
float s_flRateStart = 0.0f;
int s_iRateCount = 0;
int s_iMsgs = 0;                      // messages read since this server
int s_iDropped = 0;                   // messages refused (rate, size, off)
float s_flLastMsg = -1.0f;
int s_iScreenWide = 0, s_iScreenTall = 0;
float s_flScale = 0.0f;
unsigned int s_uiSwitches = 0xFFFFFFFFu;

inline int Max(int a, int b) { return a > b ? a : b; }
inline int Min(int a, int b) { return a < b ? a : b; }
inline int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline int Round(float f) { return (int)(f + 0.5f); }

bool On(const cvar_t* cv)
{
	return !cv || cv->value != 0.0f;
}

// The master switch, and cl_h9_vgui: a game that draws no H9 panel at all draws no HUD panel either.
bool Enabled()
{
	if (!s_cvVgui)
		s_cvVgui = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui");
	return On(s_cvMaster) && On(s_cvVgui);
}

// What the switches are now, one bit each: when it changes every panel is laid out again.
unsigned int Switches()
{
	unsigned int bits = 0;
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		if (On(s_cvPanel[i]))
			bits |= 1u << i;
	}
	for (int i = 0; i < KIND_COUNT; i++)
	{
		if (On(s_cvKind[i]))
			bits |= 1u << (H9ARP_HUDS + i);
	}
	if (On(s_cvNeeds))
		bits |= 1u << (H9ARP_HUDS + KIND_COUNT);
	if (On(s_cvPlaque))
		bits |= 1u << (H9ARP_HUDS + KIND_COUNT + 1);
	return bits;
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

// The scale of an art on this screen: base x (screen height / 480) x cl_h9_vgui_scale.
float ArtScale(float base)
{
	return ((float)ScreenHeight / 480.0f) * base * UserScale();
}

void TextColour(int& r, int& g, int& b)
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

// A text's width in the font. The VGUI font measures a byte above 127 (the title's guillemets, in a Latin-1 view) as nothing,
// reading it as a negative character, though the surface draws it, so each is counted as the width of an "o".
int TextWide(vgui::Font* font, const char* text)
{
	if (!font || !text || !text[0])
		return 0;
	char run[H9ARP_LINE_LEN];
	int n = 0, wide = 0;
	const int high = H9TextWide(font, "o");
	for (const char* p = text;; p++)
	{
		const unsigned char c = (unsigned char)*p;
		if (c >= 128 || c == 0)
		{
			run[n] = 0;
			wide += H9TextWide(font, run);
			n = 0;
			if (c == 0)
				break;
			wide += high;
			continue;
		}
		if (n < (int)sizeof(run) - 1)
			run[n++] = (char)c;
	}
	return wide;
}

// A text as lines no wider than availW, at most maxOut of them: at the spaces, a word wider than a line cut where the line ends (the rule of CH9ArpHudPanel::Wrap, into the
// caller's lines). What does not fit in maxOut lines is left out.
int WrapText(vgui::Font* font, const char* text, int availW, char (*out)[H9ARP_LINE_LEN], int maxOut)
{
	int n = 0;
	char cur[H9ARP_LINE_LEN];
	char cand[H9ARP_LINE_LEN];
	char piece[H9ARP_LINE_LEN];
	int curLen = 0;
	bool full = false;
	cur[0] = 0;

	const char* p = text;
	while (*p && !full)
	{
		while (*p == ' ')
			p++;
		if (!*p)
			break;
		const char* w = p;
		while (*p && *p != ' ')
			p++;
		const int wl = Min((int)(p - w), H9ARP_LINE_LEN - 1);

		// the word at the end of this line, if it fits there
		int cl = 0;
		if (curLen)
		{
			memcpy(cand, cur, curLen);
			cl = curLen;
			cand[cl++] = ' ';
		}
		if (cl + wl <= H9ARP_LINE_LEN - 1)
		{
			memcpy(cand + cl, w, wl);
			cl += wl;
			cand[cl] = 0;
			if (TextWide(font, cand) <= availW)
			{
				memcpy(cur, cand, cl + 1);
				curLen = cl;
				continue;
			}
		}

		// the line is full: it goes, and the word starts the next, cut where it is wider than a line
		if (curLen)
		{
			memcpy(out[n], cur, curLen);
			out[n][curLen] = 0;
			n++;
			curLen = 0;
			cur[0] = 0;
			if (n >= maxOut)
			{
				full = true;
				break;
			}
		}
		int start = 0;
		for (;;)
		{
			int take = wl - start;
			memcpy(piece, w + start, take);
			piece[take] = 0;
			while (take > 1 && TextWide(font, piece) > availW)
				piece[--take] = 0;
			start += take;
			if (start >= wl)
			{
				memcpy(cur, piece, take + 1);
				curLen = take;
				break;
			}
			memcpy(out[n], piece, take + 1);
			n++;
			if (n >= maxOut)
			{
				full = true;
				break;
			}
		}
	}
	if (curLen && n < maxOut)
	{
		memcpy(out[n], cur, curLen);
		out[n][curLen] = 0;
		n++;
	}
	return n;
}

// ASCII letters to upper case, in place: a byte above 127 (the credit sign) and everything else stays.
void Upper(char* text)
{
	for (; *text; text++)
	{
		if (*text >= 'a' && *text <= 'z')
			*text = (char)(*text - 'a' + 'A');
	}
}

// "<Label>: <value>" split at the first ": ". A text with no label is all value, and the label is empty.
void SplitLabel(const char* text, char* label, int labelSize, char* value, int valueSize)
{
	const char* colon = strstr(text, ": ");
	if (colon && (colon - text) < labelSize)
	{
		memcpy(label, text, colon - text);
		label[colon - text] = 0;
		const char* v = colon + 2;
		while (*v == ' ')
			v++;
		const int len = Min((int)strlen(v), valueSize - 1);
		memcpy(value, v, len);
		value[len] = 0;
		return;
	}
	label[0] = 0;
	const int len = Min((int)strlen(text), valueSize - 1);
	memcpy(value, text, len);
	value[len] = 0;
}

// ---- a need: a line that is a bar ------------------------------------------------------------------------------------

// A need's line, "<label>: <0 to 100>%": its label (spaces off both ends, no more than H9ARP_NEED_LABEL characters) and its value (a
// number over 100 is 100). False when the text is not in that form, or has a line break in it, and then the line is drawn as the text
// it is.
bool ParseNeed(const char* text, char* label, int labelSize, int& value)
{
	if (strchr(text, '\n'))
		return false;
	int end = (int)strlen(text);
	while (end > 0 && text[end - 1] == ' ')
		end--;
	if (end < 4 || text[end - 1] != '%')
		return false;
	int p = end - 1;
	int digits = 0, v = 0, scale = 1;
	while (p > 0 && digits < 3 && text[p - 1] >= '0' && text[p - 1] <= '9')
	{
		p--;
		digits++;
		v += (text[p] - '0') * scale;
		scale *= 10;
	}
	if (digits == 0)
		return false;
	while (p > 0 && text[p - 1] == ' ')
		p--;
	if (p < 2 || text[p - 1] != ':')
		return false;
	p--;
	int start = 0;
	while (start < p && text[start] == ' ')
		start++;
	while (p > start && text[p - 1] == ' ')
		p--;
	if (p <= start)
		return false;
	const int len = Min(Min(p - start, H9ARP_NEED_LABEL), labelSize - 1);
	memcpy(label, text + start, len);
	label[len] = 0;
	value = Min(v, 100);
	return true;
}

inline int Lerp(int a, int b, int num, int den)
{
	return a + (b - a) * num / den;
}

// The colour of a need's bar: green at 0, yellow half way to the warning level, red from the warning level up.
void NeedColour(int value, int& r, int& g, int& b)
{
	const int v2 = Clamp(value, 0, H9ARP_NEED_WARN) * 2;
	if (v2 <= H9ARP_NEED_WARN)
	{
		r = Lerp(OK_R, MID_R, v2, H9ARP_NEED_WARN);
		g = Lerp(OK_G, MID_G, v2, H9ARP_NEED_WARN);
		b = Lerp(OK_B, MID_B, v2, H9ARP_NEED_WARN);
	}
	else
	{
		r = Lerp(MID_R, BAD_R, v2 - H9ARP_NEED_WARN, H9ARP_NEED_WARN);
		g = Lerp(MID_G, BAD_G, v2 - H9ARP_NEED_WARN, H9ARP_NEED_WARN);
		b = Lerp(MID_B, BAD_B, v2 - H9ARP_NEED_WARN, H9ARP_NEED_WARN);
	}
}

// ---- what a HUD says, ready to lay out ----------------------------------------------------------------------------

enum
{
	SEG_TEXT = 0,
	SEG_TITLE,
	SEG_GAP,
	SEG_NEED,  // a need: text is its label and value its bar
	SEG_ALERT  // a warning row
};

struct Seg
{
	int style;
	int value;
	char text[H9ARP_LINE_LEN];
};
const int MAX_SEGS = 96;

// The lines of a HUD as segments to lay out: the switch of each kind of line applied (to the first HUD, whose lines they are),
// a line split at its line breaks, the first line of the second and third HUD a heading as the first HUD's title is, every blank
// line a gap, and no gap at the ends or twice in a row. A need is a row with a bar, and when it opens the second or third HUD the
// heading is "Needs"; a status line in those two is a warning row. A second or third HUD that holds a need is shown or not as
// cl_h9_arphud_needs says, whole; in the first HUD a need is one row among the others and the switch is its own.
int Collect(int hud, Seg* out, int max)
{
	const HudSlot& s = s_Huds[hud];
	const bool headed = hud != 0 && hud != H9ARP_NOTICE; // the second and third HUD: the first line is a heading
	if (headed && s.hasNeed && !On(s_cvNeeds))
		return 0;
	int n = 0;
	bool first = true;
	for (int i = 0; i < s.count && n < max; i++)
	{
		const Line& l = s.lines[i];
		const int kind = (l.kind >= 0 && l.kind <= KIND_ICON) ? l.kind : KIND_EXTRA;
		if (kind == KIND_ICON) // a picture, not a row: PictureItem finds it
			continue;
		if (hud == 0 && !On(kind == KIND_NEED ? s_cvNeeds : s_cvKind[kind]))
			continue;

		char label[H9ARP_LINE_LEN];
		int value = 0;
		if (kind == KIND_NEED && hud != H9ARP_NOTICE && ParseNeed(l.text, label, sizeof(label), value))
		{
			if (first && headed && n + 1 < max)
			{
				Seg& h = out[n++];
				h.style = SEG_TITLE;
				h.value = 0;
				memcpy(h.text, "Needs", 6);
			}
			first = false;
			if (n < max)
			{
				Seg& g = out[n++];
				g.style = SEG_NEED;
				g.value = value;
				memcpy(g.text, label, strlen(label) + 1);
			}
			continue;
		}

		const char* p = l.text;
		for (;;)
		{
			const char* e = strchr(p, '\n');
			const char* a = p;
			const char* b = e ? e : p + strlen(p);
			while (a < b && *a == ' ')
				a++;
			while (b > a && b[-1] == ' ')
				b--;
			if (n < max)
			{
				Seg& g = out[n];
				const int len = Min((int)(b - a), H9ARP_LINE_LEN - 1);
				memcpy(g.text, a, len);
				g.text[len] = 0;
				g.value = 0;
				if (len == 0)
				{
					g.style = SEG_GAP;
				}
				else
				{
					const bool heading = (hud == 0) ? kind == KIND_TITLE : (hud != H9ARP_NOTICE && first);
					g.style = heading ? SEG_TITLE : ((headed && kind == KIND_STATUS) ? SEG_ALERT : SEG_TEXT);
					first = false;
				}
				if (g.style != SEG_GAP || (n > 0 && out[n - 1].style != SEG_GAP))
					n++;
			}
			if (!e)
				break;
			p = e + 1;
		}
	}
	while (n > 0 && out[n - 1].style == SEG_GAP)
		n--;
	return n;
}

// ---- the plaque: what the server says, ready to lay out ----------------------------------------------------------------

// The rows of a laid-out plaque (CH9ArpHudPanel::PRow)
enum
{
	PR_HEAD = 0,
	PR_FIELD,
	PR_HINT,
	PR_GAP
};

// One field of a plaque: a label and a value (both upper case), and the kind that says how it is drawn.
struct PlqField
{
	int kind; // KIND_PLQ_ROW, _TAG, _OPEN, _SEALED or _WARN
	char label[PLAQUE_LABEL_LEN];
	char value[H9ARP_LINE_LEN];
};

struct PlqModel
{
	char head[H9ARP_LINE_LEN];
	int count;
	PlqField fields[PLAQUE_MAX_FIELDS];
	int hints;
	char hint[PLAQUE_MAX_HINTS][H9ARP_LINE_LEN];
};

bool IsPlaqueKind(int kind)
{
	return kind >= KIND_PLQ_HEAD && kind <= KIND_PLQ_HINT;
}

// The notice HUD's lines as a plaque. The first KIND_PLQ_HEAD line is the heading. A field's label and value are the line's "<Label>: <value>" in upper case; a status
// line says OPEN or SEALED by its kind, whatever its words (the server says "Locked" and "Unlocked" to a game that does not draw the plaque); a hint keeps its case. Any
// other line is left out. False when there is no heading.
bool BuildPlaque(const HudSlot& s, PlqModel& m)
{
	memset(&m, 0, sizeof(m));
	bool head = false;
	for (int i = 0; i < s.count; i++)
	{
		const Line& l = s.lines[i];
		if (!IsPlaqueKind(l.kind))
			continue;
		if (l.kind == KIND_PLQ_HEAD)
		{
			if (!head)
			{
				head = true;
				memcpy(m.head, l.text, strlen(l.text) + 1);
				Upper(m.head);
			}
		}
		else if (l.kind == KIND_PLQ_HINT)
		{
			if (m.hints < PLAQUE_MAX_HINTS)
				memcpy(m.hint[m.hints++], l.text, strlen(l.text) + 1);
		}
		else if (m.count < PLAQUE_MAX_FIELDS)
		{
			PlqField& f = m.fields[m.count++];
			f.kind = l.kind;
			SplitLabel(l.text, f.label, sizeof(f.label), f.value, sizeof(f.value));
			if (l.kind == KIND_PLQ_OPEN || l.kind == KIND_PLQ_SEALED)
			{
				memcpy(f.value, l.kind == KIND_PLQ_OPEN ? "OPEN" : "SEALED", l.kind == KIND_PLQ_OPEN ? 5 : 7);
				if (!f.label[0])
					memcpy(f.label, "STATUS", 7);
			}
			Upper(f.label);
			Upper(f.value);
		}
	}
	return head;
}

// ---- the panel ----------------------------------------------------------------------------------------------------

enum
{
	ROW_TEXT = 0,
	ROW_TITLE,
	ROW_GAP,
	ROW_CONT, // the second and later rows of a long text, drawn whole
	ROW_NEED, // a need: the label, a bar and the number
	ROW_ALERT // a warning, in red; the later rows of a long one too
};

// One HUD on H9's art: the tsm_panel art for a HUD, the tsm_banner art for the notice, the text in the textscheme's fonts (the
// "H9 Text" ladder, stepped down while the rows do not fit), a heading in the rail's lit purple with a rail under it as a menu's
// title has, a label before its value dimmer than the value. It sizes itself to its rows, within 24% of the width (the notice 40%)
// and 55% of the height, wrapping the lines that are wider and leaving out the rows that still do not fit at the smallest font.
// A need is a row of its own kind: the label (the widest label sets the column), a bar on a dark track in the colour NeedColour gives
// its value with a mark at the warning and the critical level, and the number; the bar takes what the label and the number leave.
class CH9ArpHudPanel : public CH9Surface
{
public:
	explicit CH9ArpHudPanel(bool notice)
		: m_bPlaque(false), m_bLabelCut(false), m_iPRows(0), m_iLabelW(0), m_iGap(0), m_iPad(0), m_bNotice(notice), m_pFont(nullptr), m_iRowTall(16), m_iRows(0),
		  m_iNeedLabelW(0), m_iNeedNumW(0), m_iNeedGap(0), m_iNeedBar(0)
	{
		m_bPlainBox = !notice; // the art missing: a dark box behind a HUD, nothing but a shadow behind a notice
		memset(m_Rows, 0, sizeof(m_Rows));
		memset(m_PRows, 0, sizeof(m_PRows));
	}

	// Lays the segments out and sizes the panel; false when nothing is left to show. stickyWide is the widest the panel has been (in this
	// size). shrunk lays it out in the smaller size of the weapon select (SHRINK_FONT_STEP, SHRINK_ART).
	bool Setup(const Seg* segs, int count, int& stickyWide, bool shrunk);

	// Lays a plaque out: a plate of a fixed width, the rows its model gives. False when nothing is left to show. Setup() and this are the two ways the panel is laid out;
	// the one that ran last is what paint() draws.
	bool SetupPlaque(const PlqModel& m);

protected:
	void paint() override;

private:
	struct Row
	{
		int style;
		int value; // a need's 0 to 100
		char text[H9ARP_LINE_LEN];
	};

	void AddRow(int style, const char* text, int len, int value = 0)
	{
		if (m_iRows >= H9ARP_MAX_ROWS)
			return;
		Row& r = m_Rows[m_iRows++];
		r.style = style;
		r.value = value;
		len = Min(len, H9ARP_LINE_LEN - 1);
		memcpy(r.text, text, len);
		r.text[len] = 0;
	}

	void Wrap(int style, const char* text, int availW);
	void BuildRows(const Seg* segs, int count, int availW);

	// A row's height; a heading's last row has the rail under it, and a gap is half a row.
	int RowHeight(int i) const
	{
		const Row& r = m_Rows[i];
		if (r.style == ROW_GAP)
			return m_iRowTall / 2;
		int h = m_iRowTall;
		if (r.style == ROW_TITLE && (i + 1 >= m_iRows || m_Rows[i + 1].style != ROW_TITLE))
			h += m_iRowTall / 3;
		return h;
	}

	int Height() const
	{
		int h = 0;
		for (int i = 0; i < m_iRows; i++)
			h += RowHeight(i);
		return h;
	}

	// the width a need row asks for
	int NeedWide() const { return m_iNeedLabelW + m_iNeedGap + m_iNeedBar + m_iNeedGap + m_iNeedNumW; }

	// A plaque's rows: the heading's lines, a field's lines (its label on the first; a badge is drawn round the lines of the value), the hint's lines, and gaps.
	struct PRow
	{
		int style;
		int kind;   // a field's kind
		bool first; // the first line of its heading or field
		bool last;  // the last
		int span;   // on a first line: how many lines the heading or field has
		char label[PLAQUE_LABEL_LEN];
		char text[H9ARP_LINE_LEN];
	};

	void AddPRow(int style, int kind, bool first, bool last, int span, const char* label, const char* text)
	{
		if (m_iPRows >= PLAQUE_MAX_ROWS)
			return;
		PRow& r = m_PRows[m_iPRows++];
		r.style = style;
		r.kind = kind;
		r.first = first;
		r.last = last;
		r.span = span;
		int ll = Min((int)strlen(label), PLAQUE_LABEL_LEN - 1);
		memcpy(r.label, label, ll);
		r.label[ll] = 0;
		while (ll > 1 && TextWide(m_pFont, r.label) > m_iLabelW)
			r.label[--ll] = 0;
		const int len = Min((int)strlen(text), H9ARP_LINE_LEN - 1);
		memcpy(r.text, text, len);
		r.text[len] = 0;
	}

	void BuildPlaqueRows(const PlqModel& m, int availW);
	void PaintPlaque();

	// a field of these kinds is drawn as a badge
	static bool IsBadge(int kind) { return kind == KIND_PLQ_TAG || kind == KIND_PLQ_OPEN || kind == KIND_PLQ_SEALED; }

	int PRowHeight(int i) const
	{
		const PRow& r = m_PRows[i];
		if (r.style == PR_GAP)
			return m_iRowTall / 2;
		int h = m_iRowTall;
		if (r.style == PR_HEAD && r.last)
			h += m_iRowTall / 3; // the rail under the heading
		if (r.style == PR_FIELD && IsBadge(r.kind))
		{
			if (r.first)
				h += m_iPad / 2;
			if (r.last)
				h += m_iPad / 2;
		}
		return h;
	}

	int PHeight() const
	{
		int h = 0;
		for (int i = 0; i < m_iPRows; i++)
			h += PRowHeight(i);
		return h;
	}

	bool m_bPlaque;   // laid out as a plaque
	bool m_bLabelCut; // a label is wider than its column at this font
	int m_iPRows;
	int m_iLabelW;    // the plaque's label column
	int m_iGap;       // between the label column and the values
	int m_iPad;       // a badge's padding
	PRow m_PRows[PLAQUE_MAX_ROWS];

	bool m_bNotice;
	vgui::Font* m_pFont;
	int m_iRowTall;
	int m_iRows;
	int m_iNeedLabelW; // the need rows' columns: the label (the widest), the gap, the bar (at least), the number
	int m_iNeedNumW;
	int m_iNeedGap;
	int m_iNeedBar;
	Row m_Rows[H9ARP_MAX_ROWS];
};

// A text as rows no wider than availW: at the spaces, and a word wider than a row cut where the row ends. The first row has the
// text's style; a text's later rows are ROW_CONT, a heading's stay a heading.
void CH9ArpHudPanel::Wrap(int style, const char* text, int availW)
{
	const int contStyle = (style == ROW_TEXT) ? ROW_CONT : style;
	char cur[H9ARP_LINE_LEN];
	char cand[H9ARP_LINE_LEN];
	char piece[H9ARP_LINE_LEN];
	int curLen = 0;
	bool firstRow = true;
	cur[0] = 0;

	const char* p = text;
	while (*p)
	{
		while (*p == ' ')
			p++;
		if (!*p)
			break;
		const char* w = p;
		while (*p && *p != ' ')
			p++;
		const int wl = (int)(p - w);

		// the word at the end of this row, if it fits there
		int cl = 0;
		if (curLen)
		{
			memcpy(cand, cur, curLen);
			cl = curLen;
			cand[cl++] = ' ';
		}
		const int room = H9ARP_LINE_LEN - 1 - cl;
		if (wl <= room)
		{
			memcpy(cand + cl, w, wl);
			cl += wl;
			cand[cl] = 0;
			if (TextWide(m_pFont, cand) <= availW)
			{
				memcpy(cur, cand, cl + 1);
				curLen = cl;
				continue;
			}
		}

		// the row is full: it goes, and the word starts the next, which is cut where the word is wider than a row
		if (curLen)
		{
			AddRow(firstRow ? style : contStyle, cur, curLen);
			firstRow = false;
			curLen = 0;
			cur[0] = 0;
		}
		int start = 0;
		for (;;)
		{
			int take = Min(wl - start, H9ARP_LINE_LEN - 1);
			memcpy(piece, w + start, take);
			piece[take] = 0;
			if (TextWide(m_pFont, piece) <= availW)
			{
				memcpy(cur, piece, take + 1);
				curLen = take;
				break;
			}
			while (take > 1)
			{
				take--;
				piece[take] = 0;
				if (TextWide(m_pFont, piece) <= availW)
					break;
			}
			AddRow(firstRow ? style : contStyle, piece, take);
			firstRow = false;
			start += take;
			if (start >= wl)
				break;
		}
	}
	if (curLen)
		AddRow(firstRow ? style : contStyle, cur, curLen);
}

void CH9ArpHudPanel::BuildRows(const Seg* segs, int count, int availW)
{
	m_iRows = 0;

	// The need rows' columns: the widest label (no more than NEED_LABEL_PERCENT of the room), the number at its widest, and the bar in
	// what is left, between its least and most.
	int labelW = 0;
	bool needs = false;
	for (int i = 0; i < count; i++)
	{
		if (segs[i].style == SEG_NEED)
		{
			needs = true;
			labelW = Max(labelW, TextWide(m_pFont, segs[i].text));
		}
	}
	m_iNeedLabelW = Min(labelW, availW * NEED_LABEL_PERCENT / 100);
	m_iNeedNumW = needs ? TextWide(m_pFont, "100%") : 0;
	m_iNeedGap = needs ? Max(NEED_GAP_MIN, m_iRowTall / 2) : 0;
	m_iNeedBar = needs ? Clamp(availW - m_iNeedLabelW - m_iNeedNumW - 2 * m_iNeedGap, Max(NEED_BAR_MIN_PX, m_iRowTall * NEED_BAR_MIN_ROWS),
							   Max(NEED_BAR_MAX_PX, m_iRowTall * NEED_BAR_MAX_ROWS))
					   : 0;

	for (int i = 0; i < count; i++)
	{
		if (segs[i].style == SEG_GAP)
		{
			AddRow(ROW_GAP, "", 0);
		}
		else if (segs[i].style == SEG_NEED)
		{
			char label[H9ARP_LINE_LEN];
			int len = (int)strlen(segs[i].text);
			memcpy(label, segs[i].text, len + 1);
			while (len > 1 && TextWide(m_pFont, label) > m_iNeedLabelW)
				label[--len] = 0;
			AddRow(ROW_NEED, label, len, segs[i].value);
		}
		else
		{
			Wrap(segs[i].style == SEG_TITLE ? ROW_TITLE : (segs[i].style == SEG_ALERT ? ROW_ALERT : ROW_TEXT), segs[i].text, availW);
		}
	}
	while (m_iRows > 0 && m_Rows[m_iRows - 1].style == ROW_GAP)
		m_iRows--;
}

bool CH9ArpHudPanel::Setup(const Seg* segs, int count, int& stickyWide, bool shrunk)
{
	m_bPlaque = false;
	m_bPlainBox = !m_bNotice;
	m_iPRows = 0;
	const CH9Art* art = CH9Art::Find(m_bNotice ? "#banner" : "#panel");
	const float s = ArtScale(m_bNotice ? NOTICE_SCALE : PANEL_SCALE) * (shrunk ? SHRINK_ART : 1.0f);
	SetArt(art, s);

	int inL = 8, inT = 6, inR = 8, inB = 6, corner = 0;
	if (art)
	{
		inL = Round(art->insetL * s);
		inT = Round(art->insetT * s);
		inR = Round(art->insetR * s);
		inB = Round(art->insetB * s);
		corner = Round(art->corner * s);
	}
	const int maxWide = m_bNotice ? Max(160, ScreenWidth * 40 / 100) : Max(120, ScreenWidth * 24 / 100);
	const int maxTall = ScreenHeight * 55 / 100;
	const int availW = Max(40, maxWide - inL - inR);

	// The first font the rows fit in (the smaller size starts further down the ladder); at the smallest the rows that do not fit are left
	// out.
	int need = 0;
	for (int step = shrunk ? SHRINK_FONT_STEP : 0; step < 4; step++)
	{
		m_pFont = H9Font(H9V_FONT_TEXT, step);
		m_iRowTall = H9FontTall(m_pFont) + H9FontTall(m_pFont) / 5;
		BuildRows(segs, count, availW);
		need = Height();
		if (need <= maxTall - inT - inB)
			break;
	}
	while (m_iRows > 1 && need > maxTall - inT - inB)
	{
		m_iRows--;
		need = Height();
	}
	while (m_iRows > 0 && m_Rows[m_iRows - 1].style == ROW_GAP)
		m_iRows--;
	if (m_iRows <= 0)
		return false;
	need = Height();

	// In steps of 16 px of width, and no narrower than it has been, so the HUDs of every length and number make few sizes of art
	// (the art keeps one bitmap for each size, for good); in steps of 8 of height.
	int widest = 0;
	for (int i = 0; i < m_iRows; i++)
	{
		if (m_Rows[i].style == ROW_NEED)
			widest = Max(widest, NeedWide());
		else if (m_Rows[i].style != ROW_GAP)
			widest = Max(widest, TextWide(m_pFont, m_Rows[i].text));
	}
	int wide = widest + inL + inR + 2;
	int tall = need + inT + inB;
	if (art)
	{
		wide = Max(wide, 2 * corner + 8);
		tall = Max(tall, 2 * corner + 4);
	}
	wide = Min((wide + 15) / 16 * 16, Max(wide, maxWide));
	wide = Max(wide, Min(stickyWide, maxWide));
	stickyWide = wide;
	tall = Min((tall + 7) / 8 * 8, Max(tall, ScreenHeight * 60 / 100));
	setSize(Max(8, wide), Max(8, tall));
	return true;
}

// The plaque's rows at the current font (m_pFont, m_iRowTall) in availW pixels: the heading wrapped, then each field with its value wrapped in what the label column
// leaves (less the badge's padding), then the hints, a half row apart from the fields.
void CH9ArpHudPanel::BuildPlaqueRows(const PlqModel& m, int availW)
{
	m_iPRows = 0;
	char lines[3][H9ARP_LINE_LEN];

	// the label column: the widest label, held to PLAQUE_LABEL_PERCENT of the row
	int labelNeed = 0;
	for (int i = 0; i < m.count; i++)
		labelNeed = Max(labelNeed, TextWide(m_pFont, m.fields[i].label));
	const int labelCap = availW * PLAQUE_LABEL_PERCENT / 100;
	m_iLabelW = Min(labelNeed, labelCap);
	m_bLabelCut = labelNeed > labelCap;
	m_iGap = labelNeed ? Max(6, m_iRowTall / 2) : 0;
	m_iPad = Max(3, m_iRowTall / 3);

	int n = WrapText(m_pFont, m.head, availW, lines, PLAQUE_HEAD_LINES);
	for (int i = 0; i < n; i++)
		AddPRow(PR_HEAD, 0, i == 0, i == n - 1, n, "", lines[i]);

	const int valueX = m_iLabelW + m_iGap;
	for (int i = 0; i < m.count; i++)
	{
		const PlqField& f = m.fields[i];
		const int w = Max(20, availW - valueX - (IsBadge(f.kind) ? 2 * m_iPad : 0));
		n = WrapText(m_pFont, f.value, w, lines, PLAQUE_VALUE_LINES);
		if (n == 0)
		{
			AddPRow(PR_FIELD, f.kind, true, true, 1, f.label, "");
			continue;
		}
		for (int k = 0; k < n; k++)
			AddPRow(PR_FIELD, f.kind, k == 0, k == n - 1, n, k == 0 ? f.label : "", lines[k]);
	}

	if (m.hints > 0)
		AddPRow(PR_GAP, 0, true, true, 1, "", "");
	for (int i = 0; i < m.hints; i++)
	{
		n = WrapText(m_pFont, m.hint[i], availW, lines, 2);
		for (int k = 0; k < n; k++)
			AddPRow(PR_HINT, 0, k == 0, k == n - 1, n, "", lines[k]);
	}
	while (m_iPRows > 0 && m_PRows[m_iPRows - 1].style == PR_GAP)
		m_iPRows--;
}

bool CH9ArpHudPanel::SetupPlaque(const PlqModel& m)
{
	m_bPlaque = true;
	m_bPlainBox = true; // the art missing: a dark box behind the plate
	m_iRows = 0;

	const CH9Art* art = CH9Art::Find("#panel");
	const float s = ArtScale(PLAQUE_SCALE);
	SetArt(art, s);

	int inL = 8, inT = 6, inR = 8, inB = 6, corner = 0;
	if (art)
	{
		inL = Round(art->insetL * s);
		inT = Round(art->insetT * s);
		inR = Round(art->insetR * s);
		inB = Round(art->insetB * s);
		corner = Round(art->corner * s);
	}

	// A plate of one width for the screen, so the art has few sizes (it keeps one bitmap for each, for good): only its height follows the rows.
	const int maxWide = Max(120, ScreenWidth * PLAQUE_WIDE_MAX_PERCENT / 100);
	int wide = Clamp(ScreenWidth * PLAQUE_WIDE_PERCENT / 100, PLAQUE_WIDE_MIN, maxWide);
	wide = Min((wide + 15) / 16 * 16, maxWide);
	if (art)
		wide = Max(wide, 2 * corner + 8);
	const int availW = Max(40, wide - inL - inR - 2);
	const int maxTall = ScreenHeight * PLAQUE_TALL_PERCENT / 100;

	// The first font the rows fit in, with the labels whole; at the smallest the rows that do not fit are left out.
	int need = 0;
	for (int step = 0; step < 4; step++)
	{
		m_pFont = H9Font(H9V_FONT_TEXT, step);
		m_iRowTall = H9FontTall(m_pFont) + H9FontTall(m_pFont) / 5;
		BuildPlaqueRows(m, availW);
		need = PHeight();
		if (need <= maxTall - inT - inB && !m_bLabelCut)
			break;
	}
	while (m_iPRows > 1 && need > maxTall - inT - inB)
	{
		m_iPRows--;
		need = PHeight();
	}
	while (m_iPRows > 0 && m_PRows[m_iPRows - 1].style == PR_GAP)
		m_iPRows--;
	if (m_iPRows <= 0)
		return false;
	need = PHeight();

	int tall = need + inT + inB;
	if (art)
		tall = Max(tall, 2 * corner + 4);
	tall = Min((tall + 7) / 8 * 8, Max(tall, ScreenHeight * 60 / 100));
	setSize(Max(8, wide), Max(8, tall));
	return true;
}

// The plate: the heading in the lit purple with its rail, each field a dim label and a value in the text colour, the badges (the affiliation, open or sealed) a frame and a
// wash round their text, a restricted line in the warning red, the hints dim.
void CH9ArpHudPanel::PaintPlaque()
{
	int x0, y0, x1, y1;
	ContentBox(x0, y0, x1, y1);
	int tr, tg, tb;
	TextColour(tr, tg, tb);
	const int fontTall = H9FontTall(m_pFont);
	const int line = Max(1, m_iRowTall / 14);
	const int valueX = x0 + m_iLabelW + m_iGap;

	int y = y0;
	for (int i = 0; i < m_iPRows; i++)
	{
		const PRow& r = m_PRows[i];
		const int h = PRowHeight(i);
		if (r.style == PR_GAP)
		{
			y += h;
			continue;
		}
		const bool badge = r.style == PR_FIELD && IsBadge(r.kind);
		const int ty = y + ((badge && r.first) ? m_iPad / 2 : 0) + (m_iRowTall - fontTall) / 2;

		if (r.style == PR_HEAD)
		{
			Text(m_pFont, x0, ty, r.text, LIT_R, LIT_G, LIT_B);
			if (r.last)
				Box(x0, y + m_iRowTall + m_iRowTall / 8, x1, y + m_iRowTall + m_iRowTall / 8 + line, RAIL_R, RAIL_G, RAIL_B, 255);
		}
		else if (r.style == PR_HINT)
		{
			Text(m_pFont, x0, ty, r.text, DET_R, DET_G, DET_B);
		}
		else
		{
			// the tones: the label, the text, and for a badge its frame
			int lr = DET_R, lg = DET_G, lb = DET_B;
			int vr = tr, vg = tg, vb = tb;
			int fr = RAIL_R, fg = RAIL_G, fb = RAIL_B;
			if (r.kind == KIND_PLQ_TAG)
			{
				const bool civilian = 0 == strcmp(r.text, "CIVILIAN") || 0 == strcmp(r.text, "PROLETARIAN");
				vr = civilian ? DET_R : LIT_R;
				vg = civilian ? DET_G : LIT_G;
				vb = civilian ? DET_B : LIT_B;
				fr = civilian ? DET_R : RAIL_R;
				fg = civilian ? DET_G : RAIL_G;
				fb = civilian ? DET_B : RAIL_B;
			}
			else if (r.kind == KIND_PLQ_OPEN)
			{
				vr = fr = OK_R;
				vg = fg = OK_G;
				vb = fb = OK_B;
			}
			else if (r.kind == KIND_PLQ_SEALED)
			{
				vr = fr = MID_R;
				vg = fg = MID_G;
				vb = fb = MID_B;
			}
			else if (r.kind == KIND_PLQ_WARN)
			{
				lr = vr = BAD_R;
				lg = vg = BAD_G;
				lb = vb = BAD_B;
			}

			if (r.first && r.label[0])
				Text(m_pFont, x0, ty, r.label, lr, lg, lb);
			if (badge)
			{
				if (r.first)
				{
					int bw = 0, bh = 0;
					for (int j = i; j < i + r.span && j < m_iPRows; j++)
					{
						bw = Max(bw, TextWide(m_pFont, m_PRows[j].text));
						bh += PRowHeight(j);
					}
					const int bx1 = Min(x1, valueX + bw + 2 * m_iPad);
					Box(valueX, y + 1, bx1, y + bh - 1, fr, fg, fb, PLAQUE_BADGE_ALPHA);
					Frame(valueX, y + 1, bx1, y + bh - 1, fr, fg, fb, 255);
				}
				Text(m_pFont, valueX + m_iPad, ty, r.text, vr, vg, vb);
			}
			else
			{
				Text(m_pFont, valueX, ty, r.text, vr, vg, vb);
			}
		}
		y += h;
	}
}

void CH9ArpHudPanel::paint()
{
	if (m_bPlaque)
	{
		PaintPlaque();
		return;
	}
	int x0, y0, x1, y1;
	ContentBox(x0, y0, x1, y1);
	int tr, tg, tb;
	TextColour(tr, tg, tb);
	const int fontTall = H9FontTall(m_pFont);
	const int line = Max(1, m_iRowTall / 14);

	// A notice is centred in its banner, a HUD's rows start at the top of the content box.
	int y = y0;
	if (m_bNotice)
		y = y0 + Max(0, (y1 - y0 - Height()) / 2);

	for (int i = 0; i < m_iRows; i++)
	{
		const Row& r = m_Rows[i];
		const int h = RowHeight(i);
		if (r.style == ROW_GAP)
		{
			y += h;
			continue;
		}
		const int ty = y + (m_iRowTall - fontTall) / 2;

		if (m_bNotice)
		{
			const int w = TextWide(m_pFont, r.text);
			const int x = x0 + Max(0, (x1 - x0 - w) / 2);
			if (!m_pArt)
				Text(m_pFont, x + 1, ty + 1, r.text, 0, 0, 0); // a shadow, for text over the world
			Text(m_pFont, x, ty, r.text, tr, tg, tb);
		}
		else if (r.style == ROW_TITLE)
		{
			Text(m_pFont, x0, ty, r.text, LIT_R, LIT_G, LIT_B);
			if (h > m_iRowTall)
				Box(x0, y + m_iRowTall + m_iRowTall / 8, x1, y + m_iRowTall + m_iRowTall / 8 + line, RAIL_R, RAIL_G, RAIL_B, 255);
		}
		else if (r.style == ROW_ALERT)
		{
			Text(m_pFont, x0, ty, r.text, BAD_R, BAD_G, BAD_B);
		}
		else if (r.style == ROW_NEED)
		{
			// "Hunger  [#######-----]  42%": the bar on a dark track, filled to the value in the colour of the value, a mark at the
			// warning and the critical level, the rail's frame over it; the number at the right, red from the warning level up
			char num[8];
			snprintf(num, sizeof(num), "%d%%", r.value);
			const int bx0 = x0 + m_iNeedLabelW + m_iNeedGap;
			const int bx1 = x1 - m_iNeedNumW - m_iNeedGap;
			const int bh = Max(NEED_BAR_TALL_MIN, fontTall * NEED_BAR_TALL_PERCENT / 100);
			const int by0 = y + (m_iRowTall - bh) / 2;
			const int by1 = by0 + bh;
			int cr, cg, cb;
			NeedColour(r.value, cr, cg, cb);

			Text(m_pFont, x0, ty, r.text, DET_R, DET_G, DET_B);
			Box(bx0, by0, bx1, by1, 0, 0, 0, TRACK_ALPHA);
			const int fill = bx0 + (bx1 - bx0) * r.value / 100;
			if (fill > bx0)
				Box(bx0, by0, fill, by1, cr, cg, cb, 255);
			const int marks[2] = {H9ARP_NEED_WARN, H9ARP_NEED_CRIT};
			for (int k = 0; k < 2; k++)
			{
				const int mx = bx0 + (bx1 - bx0) * marks[k] / 100;
				Box(mx, by0, mx + line, by1, MARK_R, MARK_G, MARK_B, MARK_ALPHA);
			}
			Frame(bx0, by0, bx1, by1, RAIL_R, RAIL_G, RAIL_B, 255);
			if (r.value >= H9ARP_NEED_WARN)
				Text(m_pFont, x1 - TextWide(m_pFont, num), ty, num, BAD_R, BAD_G, BAD_B);
			else
				Text(m_pFont, x1 - TextWide(m_pFont, num), ty, num, tr, tg, tb);
		}
		else
		{
			// "Wallet: $500": the label dimmer than the value
			const char* colon = (r.style == ROW_TEXT) ? strstr(r.text, ": ") : nullptr;
			if (colon && (colon - r.text) <= 24 && colon[2])
			{
				char label[32];
				const int ll = (int)(colon - r.text) + 1;
				memcpy(label, r.text, ll);
				label[ll] = 0;
				Text(m_pFont, x0, ty, label, DET_R, DET_G, DET_B);
				Text(m_pFont, x0 + TextWide(m_pFont, label) + TextWide(m_pFont, " "), ty, colon + 2, tr, tg, tb);
			}
			else
			{
				Text(m_pFont, x0, ty, r.text, tr, tg, tb);
			}
		}
		y += h;
	}
}

CH9ArpHudPanel* s_pPanels[H9ARP_HUDS];
CH9PicturePanel* s_pPicture = nullptr; // a dropped item's picture, above the notice
vgui::Panel* s_pParent = nullptr;

// The panels, made under the viewport the first time it exists (and again if it was replaced).
bool EnsurePanels()
{
	if (!gViewPort)
		return false;
	if (s_pParent == gViewPort && s_pPanels[0])
		return true;
	s_pParent = gViewPort;
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		s_pPanels[i] = new CH9ArpHudPanel(i == H9ARP_NOTICE);
		s_pPanels[i]->setParent(gViewPort);
		s_Huds[i].dirty = true;
	}
	s_pPicture = new CH9PicturePanel();
	s_pPicture->setParent(gViewPort);
	return true;
}

// ---- the message ---------------------------------------------------------------------------------------------------

// Every HUD taken down, the lines and the panels both.
void ClearAll()
{
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		HudSlot& s = s_Huds[i];
		s.have = false;
		s.hasNeed = false;
		s.plaque = false;
		s.building = false;
		s.count = 0;
		s.dirty = true;
		s.laidOut = false;
		s.alpha = 0.0f;
		s.barPush = 0.0f;
		s.shrunk = false;
		s.stickyWide[0] = s.stickyWide[1] = 0;
		s.why = "nothing sent";
	}
	if (s_pPicture)
		s_pPicture->setVisible(false);
}

// A line's text: cut to its room, every character below 32 dropped except the line break. The bytes above 127 go through as they
// are: the title's guillemets are drawn if the font has them.
void ReadText(char* out, int size)
{
	const char* s = READ_STRING();
	int o = 0;
	for (; *s && o < size - 1; s++)
	{
		const unsigned char c = (unsigned char)*s;
		if (c < 32 && c != '\n')
			continue;
		out[o++] = (char)c;
	}
	out[o] = 0;
}

void OpContent(float now)
{
	const int hud = READ_BYTE();
	const int gen = READ_BYTE();
	const int partByte = READ_BYTE();
	const int count = READ_BYTE();
	const int part = partByte & 15;
	const bool last = (partByte & 128) != 0;
	int x = -1, y = -1;
	if (part == 0)
	{
		x = READ_SHORT();
		y = READ_SHORT();
	}
	if (!READ_OK() || hud < 0 || hud >= H9ARP_HUDS || count < 1 || count > H9ARP_MAX_LINES)
		return;

	Line lines[H9ARP_MAX_LINES];
	for (int i = 0; i < count; i++)
	{
		lines[i].kind = READ_BYTE();
		ReadText(lines[i].text, sizeof(lines[i].text));
	}
	if (!READ_OK())
		return;

	HudSlot& s = s_Huds[hud];
	if (part == 0)
	{
		s.building = true;
		s.gen = gen;
		s.expect = 1;
		s.bcount = 0;
		s.bx = x;
		s.by = y;
	}
	else if (!s.building || s.gen != gen || s.expect != part)
	{
		// a part is missing: what the HUD holds stays until a whole content comes
		s.building = false;
		return;
	}
	else
	{
		s.expect = part + 1;
	}
	for (int i = 0; i < count && s.bcount < H9ARP_MAX_LINES; i++)
		s.blines[s.bcount++] = lines[i];

	if (!last)
		return;

	s.building = false;
	s.count = s.bcount;
	s.x = s.bx;
	s.y = s.by;
	memcpy(s.lines, s.blines, sizeof(Line) * s.bcount);
	s.hasNeed = false;
	s.plaque = false;
	for (int i = 0; i < s.count; i++)
	{
		if (s.lines[i].kind == KIND_NEED)
			s.hasNeed = true;
		if (s.lines[i].kind == KIND_PLQ_HEAD)
			s.plaque = true;
	}
	s.have = true;
	s.at = now;
	s.dirty = true;
	s.msgs++;
}

int __MsgFunc_H9ArpHud(const char* pszName, int iSize, void* pbuf)
{
	if (iSize <= 0 || iSize > H9ARP_MAX_MSG || !Enabled())
	{
		s_iDropped++;
		return 1;
	}

	// At most H9ARP_MAX_RATE a second; the rest are dropped.
	const float now = gHUD.m_flTime;
	if (now - s_flRateStart >= 1.0f || now < s_flRateStart)
	{
		s_flRateStart = now;
		s_iRateCount = 0;
	}
	if (++s_iRateCount > H9ARP_MAX_RATE)
	{
		s_iDropped++;
		return 1;
	}

	BEGIN_READ(pbuf, iSize);
	switch (READ_BYTE())
	{
	case 1:
		OpContent(now);
		break;
	case 2:
	{
		const int hud = READ_BYTE();
		if (READ_OK() && hud >= 0 && hud < H9ARP_HUDS)
		{
			s_Huds[hud].have = false;
			s_Huds[hud].building = false;
		}
		break;
	}
	case 3:
		for (int i = 0; i < H9ARP_HUDS; i++)
		{
			s_Huds[i].have = false;
			s_Huds[i].building = false;
		}
		break;
	default:
		break;
	}
	s_iMsgs++;
	s_flLastMsg = now;
	return 1;
}

// ---- every frame -----------------------------------------------------------------------------------------------------

// _h9arphud is what the server reads: 1 while this game draws the HUD as panels, else 0.
void SyncUserinfo()
{
	if (!s_cvInfo)
		return;
	const char* want = Enabled() ? "1" : "0";
	if (!s_cvInfo->string || 0 != strcmp(s_cvInfo->string, want))
		gEngfuncs.Cvar_Set("_h9arphud", want);
}

// The column and the row (0 to 2) of the nearest corner or side of the safe area to the place the server gave a HUD (arp_hudN_x and
// _y, thousandths, -1 centred).
int PanelCol(const HudSlot& s)
{
	return (s.x < 0) ? 1 : (s.x < 330 ? 0 : (s.x > 660 ? 2 : 1));
}

int PanelRow(const HudSlot& s)
{
	return (s.y < 0) ? 1 : (s.y < 330 ? 0 : (s.y > 660 ? 2 : 1));
}

// The y the top panels of the left column start at to stand under the weapon bar (ts_weaponbar.cpp), which draws in pixels of its own
// over the columns a panel of this width covers: where the bar ends there and a gap, 0 when the bar draws nothing. The bar's bottom is
// the same with the select open and shut (CHudTSWeaponBar::DrawnBottom), so a panel does not move when the select opens.
int BarClearance(int x0, int x1)
{
	const int bottom = gHUD.m_TSWeaponBar.DrawnBottom(x0, x1);
	return bottom > 0 ? bottom + BAR_GAP : 0;
}

// The push of the weapon bar (pixels) goes to its target in about a fifth of a second, so a panel slides when the bar gains or loses
// a row, or opens with cl_showequipment 0, instead of jumping; within a pixel of it, it is there.
float EasePush(float cur, float target, float dt)
{
	const float d = target - cur;
	if (d > -1.0f && d < 1.0f)
		return target;
	const float k = dt * 14.0f;
	return cur + d * (k > 1.0f ? 1.0f : k);
}

// Where a HUD goes, from the place the server gave it: the nearest of three columns and three rows of the safe area. The top row of
// a side column starts clear of what the HUD draws there (the powerup label at the left, the round time and the kill feed at the
// right), and the left one also under the weapon bar (barClear: the y the bar ends at and a gap, 0 when it draws nothing); the top row
// of the middle column starts beneath the stack of notices, the bottom row stands on the bottom band, and the middle row is the height
// the server asked for. A panel stacks under the one already in its column, and one in the middle column keeps off the crosshair box.
// A panel that does not fit below the bar is held inside the safe area, over the bar.
void PlacePanel(const HudSlot& s, int wide, int tall, int barClear, int colBottom[3], int& x, int& y)
{
	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	const int margin = PANEL_MARGIN;
	const int col = PanelCol(s);
	const int row = PanelRow(s);

	x = (col == 0) ? margin : (col == 2 ? ScreenWidth - wide - margin : (ScreenWidth - wide) / 2);
	if (row == 0)
	{
		y = Max(sy0, col == 2 ? 104 : 32);
		if (col == 1)
			y = Max(y, H9Vgui_StackBottom());
		else if (col == 0)
			y = Max(y, barClear);
	}
	else if (row == 2)
	{
		y = (col == 1 && s.y >= 0) ? s.y * ScreenHeight / 1000 : sy1 - tall;
	}
	else
	{
		y = (s.y >= 0) ? s.y * ScreenHeight / 1000 : (sy0 + sy1 - tall) / 2;
	}
	y = Max(y, colBottom[col]);
	if (y + tall > sy1)
		y = Max(sy0, sy1 - tall);

	if (col == 1)
	{
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
	colBottom[col] = y + tall + 6;
}

// The item the notice's ICON line names ("icon:<item>"), "" for none.
const char* PictureItem()
{
	const HudSlot& s = s_Huds[H9ARP_NOTICE];
	for (int i = 0; i < s.count; i++)
	{
		if (s.lines[i].kind == KIND_ICON && 0 == strncmp(s.lines[i].text, "icon:", 5))
			return s.lines[i].text + 5;
	}
	return "";
}

// The picture of a dropped item above the notice: the picture the sheet has for the item the notice's ICON line names, at a whole number of
// times its 32 pixels that grows with the screen, centred over the notice's box, below it when the top of the screen leaves no room; there
// while the notice is, and fading as it does.
void UpdatePicture(float userScale)
{
	if (!s_pPicture)
		return;
	CH9ArpHudPanel* np = s_pPanels[H9ARP_NOTICE];
	const HudSlot& ns = s_Huds[H9ARP_NOTICE];
	bool show = false;
	if (np && np->isVisible() && On(s_cvIcon) && ns.have)
	{
		const int frame = H9ItemPicture(PictureItem());
		const int times = Clamp(Round((float)ScreenHeight / 360.0f * userScale), 1, 4);
		if (frame >= 0 && s_pPicture->SetPicture(frame, times))
		{
			int nx, ny, nw, nh, sx0, sy0, sx1, sy1;
			np->getPos(nx, ny);
			np->getSize(nw, nh);
			H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
			const int side = s_pPicture->Side(), gap = 4;
			const int px = Clamp(nx + (nw - side) / 2, 0, Max(0, ScreenWidth - side));
			int py = ny - side - gap;
			if (py < sy0)
				py = ny + nh + gap;
			if (py + side <= sy1)
			{
				s_pPicture->setPos(px, py);
				s_pPicture->SetAlpha((int)ns.alpha);
				show = true;
			}
		}
	}
	s_pPicture->setVisible(show);
}

void Frame()
{
	SyncUserinfo();
	if (!Enabled())
		ClearAll();
	if (!EnsurePanels())
		return;

	const float now = gHUD.m_flTime;
	float dt = now - s_flLastThink;
	s_flLastThink = now;
	if (dt < 0.0f || dt > 0.2f)
		dt = 0.0f;

	// What changes the layout: the screen, the panels' scale, the switches.
	const float scale = UserScale();
	const unsigned int switches = Switches();
	const bool relayout = ScreenWidth != s_iScreenWide || ScreenHeight != s_iScreenTall || scale != s_flScale || switches != s_uiSwitches;
	s_iScreenWide = ScreenWidth;
	s_iScreenTall = ScreenHeight;
	s_flScale = scale;
	s_uiSwitches = switches;

	// Drawn only while the HUD is, as the other H9 panels are: not in an intermission, not with the HUD hidden, not under the
	// scoreboard, not with nohud, not over the buy menu.
	const bool hudDrawn = (now - s_flLastDraw) < 0.5f && now >= s_flLastDraw && !gHUD.m_iIntermission;
	const bool board = gViewPort->IsScoreBoardVisible();
	const bool shown = Enabled() && hudDrawn && !board && !TSHud_NoHud() && !gHUD.m_TSBuyMenu.IsUp();
	const bool menu = gHUD.m_Menu.m_fMenuDisplayed;

	// The weapon select open and drawn: the panel at the top of the left column stands in its smaller size meanwhile (the tests of the bar's
	// own Draw are in DrawnBottom: nothing is drawn while dead, spectating, with nohud or under a buy window).
	const bool selecting = On(s_cvShrink) && gHUD.m_TSWeaponBar.IsSelecting() && gHUD.m_TSWeaponBar.DrawnBottom() > 0;

	static Seg segs[MAX_SEGS];
	int colBottom[3] = {0, 0, 0};
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		HudSlot& s = s_Huds[i];
		CH9ArpHudPanel* p = s_pPanels[i];
		if (relayout)
		{
			s.dirty = true;
			s.stickyWide[0] = s.stickyWide[1] = 0; // its width was a width at the old scale
		}
		if (s.have && (now < s.at || now - s.at > H9ARP_LIFE))
			s.have = false; // nothing has refreshed it: the server is gone quiet

		const bool shrink = selecting && i != H9ARP_NOTICE && PanelCol(s) == 0 && PanelRow(s) == 0;
		if (shrink != s.shrunk)
		{
			s.shrunk = shrink;
			s.dirty = true;
		}

		// the notice HUD that holds a plaque is drawn as one while cl_h9_arphud_plaque is 1, on the same panel
		const bool plq = i == H9ARP_NOTICE && s.plaque && On(s_cvPlaque);

		const char* why = nullptr;
		if (!Enabled())
			why = "cl_h9_arphud or cl_h9_vgui is 0";
		else if (!s.have)
			why = "no lines held";
		else if (!On(s_cvPanel[i]))
			why = "its switch is 0";
		else if (!shown)
			why = "the HUD is not drawn (menu, scoreboard, nohud, intermission or master off)";
		else if (i == H9ARP_NOTICE && now - s.at > (plq ? PLAQUE_HOLD : H9ARP_HOLD))
			why = plq ? "the plaque has run out" : "the notice has run out";
		else if (plq && TSHud_PlayerPartsHidden())
			why = "dead or spectating (the plaque is a living player's)";
		else if (s.hasNeed && i != 0 && i != H9ARP_NOTICE && TSHud_PlayerPartsHidden())
			why = "dead or spectating (the needs are a living player's)";

		// Laid out again when what it shows has changed, while it is wanted.
		if (!why && s.dirty)
		{
			if (plq)
			{
				static PlqModel model;
				s.laidOut = BuildPlaque(s, model) && p->SetupPlaque(model);
			}
			else
			{
				const int n = Collect(i, segs, MAX_SEGS);
				s.laidOut = n > 0 && p->Setup(segs, n, s.stickyWide[s.shrunk ? 1 : 0], s.shrunk);
			}
			s.dirty = false;
		}
		if (!why && !s.laidOut)
			why = "every line of it is switched off";

		int px = 0, py = 0, wide = 0, tall = 0;
		p->getSize(wide, tall);
		if (!why)
		{
			if (PanelCol(s) == 0 && PanelRow(s) == 0)
			{
				// A top panel of the left column stands under the weapon bar: where it stands without the bar, and where the bar
				// puts it. The bar's push (the difference) is taken at once while the panel is not showing or the screen changed,
				// and slides to a new one while it is, so only a change of where the bar ends moves the panel; the panels under it
				// in the column move with it, and it is never lower than the safe area allows.
				int stack[3] = {colBottom[0], colBottom[1], colBottom[2]};
				int underX, underY, sx0, sy0, sx1, sy1;
				H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
				PlacePanel(s, wide, tall, 0, colBottom, px, py);
				PlacePanel(s, wide, tall, BarClearance(PANEL_MARGIN, PANEL_MARGIN + wide), stack, underX, underY);
				const float want = (float)(underY - py);
				s.barPush = (s.alpha < 1.0f || relayout) ? want : EasePush(s.barPush, want, dt);
				py = Min(py + (int)(s.barPush + 0.999f), Max(sy0, sy1 - tall));
				colBottom[0] = py + tall + 6;
			}
			else
			{
				PlacePanel(s, wide, tall, 0, colBottom, px, py);
			}
			// Not over a menu: the text menu and the menu panel stand at the left from a quarter of the height down.
			if (menu && px < ScreenWidth / 3 && py + tall > ScreenHeight / 4)
				why = "a menu is open at the left";
			else
				p->setPos(px, py);
		}

		s.why = why ? why : "shown";
		if (!shown)
			s.alpha = 0.0f;
		else if (!why)
			s.alpha = (s.alpha + 255.0f * dt / H9ARP_FADE > 255.0f) ? 255.0f : s.alpha + 255.0f * dt / H9ARP_FADE;
		else
			s.alpha = (s.alpha - 255.0f * dt / H9ARP_FADE < 0.0f) ? 0.0f : s.alpha - 255.0f * dt / H9ARP_FADE;
		p->SetAlpha((int)s.alpha);
		p->setVisible(s.alpha >= 1.0f && s.laidOut);
	}

	UpdatePicture(scale);
}

// ---- cl_h9_arphud_list -------------------------------------------------------------------------------------------------

void PrintSwitch(const cvar_t* cv, const char* name, const char* what)
{
	gEngfuncs.Con_Printf("  %-22s %d   %s\n", name, (cv && cv->value != 0.0f) ? 1 : 0, what);
}

void CmdList()
{
	gEngfuncs.Con_Printf("Apollo RP's HUD as panels. 1 shows a thing, 0 hides it. Each is saved.\n");
	PrintSwitch(s_cvMaster, "cl_h9_arphud", "the master: 0 gets the server's text HUD instead of every panel");
	gEngfuncs.Con_Printf("  (cl_h9_vgui is %s: 0 turns every H9 panel off, these too, and the game gets the text HUD)\n",
		On(s_cvVgui) ? "1" : "0");
	gEngfuncs.Con_Printf("The panels. A panel that is 0 is not shown and its lines are not drawn anywhere else:\n");
	for (int i = 0; i < H9ARP_HUDS; i++)
		PrintSwitch(s_cvPanel[i], kPanelCvars[i], kPanelWhat[i]);
	gEngfuncs.Con_Printf("The kinds of line, in the first panel (cl_h9_arphud_left) only:\n");
	for (int i = 0; i < KIND_COUNT; i++)
		PrintSwitch(s_cvKind[i], kKindCvars[i], kKindWhat[i]);
	gEngfuncs.Con_Printf("The needs (hunger, and thirst where a server has it), as rows with a bar in the second panel (cl_h9_arphud_top):\n");
	PrintSwitch(s_cvNeeds, "cl_h9_arphud_needs", "the needs panel; 0 hides it, the status rows under the bars with it");
	gEngfuncs.Con_Printf("The picture of a dropped item, above its notice (a server of Apollo RP's H9 additions sends it to a game that says _h9vgui 7):\n");
	PrintSwitch(s_cvIcon, "cl_h9_arphud_icon", "the picture above the notice of an item on the floor");
	gEngfuncs.Con_Printf("What you look at (a property door, an NPC, a player), as a plaque in the notice's place:\n");
	PrintSwitch(s_cvPlaque, "cl_h9_arphud_plaque", "the plaque; 0 draws what the server sends as the plain notice it reads as");
	gEngfuncs.Con_Printf("The first panel while TS's weapon select (the five columns at the top left) is open:\n");
	PrintSwitch(s_cvShrink, "cl_h9_arphud_shrink", "a smaller size meanwhile, its own again when the select shuts");

	const float now = gHUD.m_flTime;
	gEngfuncs.Con_Printf("What the server sends. The key it reads, _h9arphud, is \"%s\" in this game", s_cvInfo && s_cvInfo->string ? s_cvInfo->string : "?");
	gEngfuncs.Con_Printf(" (arp_hudstate on the server says what it read). %d message(s) read since you joined", s_iMsgs);
	if (s_flLastMsg >= 0.0f)
		gEngfuncs.Con_Printf(", the last %.1f s ago", now - s_flLastMsg);
	gEngfuncs.Con_Printf(", %d refused.\n", s_iDropped);
	for (int i = 0; i < H9ARP_HUDS; i++)
	{
		const HudSlot& s = s_Huds[i];
		if (s.have)
			gEngfuncs.Con_Printf("  HUD %d: %d line(s), %d update(s), the last %.1f s ago; %s\n", i + 1, s.count, s.msgs, now - s.at, s.why ? s.why : "");
		else
			gEngfuncs.Con_Printf("  HUD %d: nothing held; %s\n", i + 1, s.why ? s.why : "");
	}
}

class CHudH9ArpHud : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE;
		return true;
	}
	bool VidInit() override
	{
		return true;
	}
	bool Draw(float flTime) override
	{
		s_flLastDraw = flTime;
		return true;
	}
	void Think() override
	{
		Frame();
	}
	void InitHUDData() override
	{
		// a new map, or a new server: the server sends everything again
		ClearAll();
		s_iMsgs = 0;
		s_iDropped = 0;
		s_flLastMsg = -1.0f;
	}
};
CHudH9ArpHud s_Hud;
} // namespace

// ---- the hooks -------------------------------------------------------------------------------------------------------

void H9ArpHud_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvMaster = CVAR_CREATE("cl_h9_arphud", "1", FCVAR_ARCHIVE);
	for (int i = 0; i < H9ARP_HUDS; i++)
		s_cvPanel[i] = CVAR_CREATE(kPanelCvars[i], "1", FCVAR_ARCHIVE);
	for (int i = 0; i < KIND_COUNT; i++)
		s_cvKind[i] = CVAR_CREATE(kKindCvars[i], "1", FCVAR_ARCHIVE);
	s_cvNeeds = CVAR_CREATE("cl_h9_arphud_needs", "1", FCVAR_ARCHIVE);
	s_cvIcon = CVAR_CREATE("cl_h9_arphud_icon", "1", FCVAR_ARCHIVE);
	s_cvPlaque = CVAR_CREATE("cl_h9_arphud_plaque", "1", FCVAR_ARCHIVE);
	s_cvShrink = CVAR_CREATE("cl_h9_arphud_shrink", "1", FCVAR_ARCHIVE);
	s_cvVgui = gEngfuncs.pfnGetCvarPointer("cl_h9_vgui");
	s_cvInfo = CVAR_CREATE("_h9arphud", Enabled() ? "1" : "0", FCVAR_USERINFO);
	ClearAll();
	gEngfuncs.pfnHookUserMsg("H9ArpHud", __MsgFunc_H9ArpHud);
	gEngfuncs.pfnAddCommand("cl_h9_arphud_list", CmdList);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}
// ---- end H9 ARP HUD ---------------------------------------------------------------------------------------------------
