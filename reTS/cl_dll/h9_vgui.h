// ---- H9 VGUI ---------------------------------------------------------------------------------
// Panels a server plugin draws on an H9 player's screen: the VGUI twin of an AMX Mod X text menu
// (MENU), what a hudmessage says (NOTICE), a notice that stays and counts its own clock down
// (STATUS), and a layout of labels, images, buttons and progress bars (PANEL). One
// plugin-registered user message, H9Vgui, carries them; the client says it can draw them with the
// userinfo key _h9vgui (the protocol version), and the player's cl_h9_vgui 0 refuses them all.
// docs\H9_VGUI.txt is the design and the plugin author's guide.
//
// A server is untrusted here: every limit below is the client's own, whatever a message says. A
// panel never takes the cursor or the keyboard; its number keys come through the slot commands,
// and ESC closes the newest one.
#pragma once

#define H9V_PROTOCOL 2 // 2: STATUS

// Limits (docs\H9_VGUI.txt, 4d).
#define H9V_ID_LEN 24       // an id: 1-23 characters of a-z 0-9 . _ -
#define H9V_MAX_MENUS 8     // menu definitions kept at once
#define H9V_MAX_ROWS 16     // rows a menu
#define H9V_ROW_TEXT 32     // a row's label or detail, 31 characters
#define H9V_TITLE_LEN 64    // a menu's title or footer, 63 characters
#define H9V_MAX_NOTICES 6   // notices on screen at once
#define H9V_NOTICE_LEN 164  // a notice's text, 160 characters
#define H9V_MAX_PANELS 8    // server panels open at once
#define H9V_MAX_CTRLS 48    // controls a panel
#define H9V_CTRL_TEXT 128   // a control's text, 127 characters
#define H9V_MAX_MSG 192     // bytes an H9Vgui message may have
#define H9V_MAX_RATE 64     // H9Vgui messages read a second

// Ops: the first byte of every H9Vgui message.
enum
{
	H9V_OP_MENU = 1,
	H9V_OP_ROWS = 2,
	H9V_OP_TWIN = 3,
	H9V_OP_PANEL = 10,
	H9V_OP_CTRL = 11,
	H9V_OP_SET = 12,
	H9V_OP_SHOW = 13,
	H9V_OP_HIDE = 14,
	H9V_OP_CLOSE = 15,
	H9V_OP_COMMIT = 16,
	H9V_OP_NOTICE = 20,
	H9V_OP_STATUS = 21
};

// Anchors, relative to the safe area (docs\H9_VGUI.txt, 4c).
enum
{
	H9V_TL = 0,
	H9V_T,
	H9V_TR,
	H9V_L,
	H9V_C,
	H9V_R,
	H9V_BL,
	H9V_B,
	H9V_BR
};

// Row flags (ROWS).
#define H9V_ROW_DIM 1  // drawn dim, still pressable
#define H9V_ROW_RED 2  // drawn red
#define H9V_ROW_GAP 4  // a blank half row above it
#define H9V_ROW_HOT 8  // highlighted
#define H9V_ROW_OFF 16 // drawn dim, not pressable

// Menu and notice styles.
enum
{
	H9V_STYLE_PANEL = 0, // MENU: the tsm_panel art
	H9V_STYLE_BANNER,    // MENU: the tsm_banner art
	H9V_STYLE_PLAIN      // MENU: no art
};
enum
{
	H9V_NOTICE_TEXT = 0, // plain scheme text
	H9V_NOTICE_BANNER,   // on the tsm_banner art
	H9V_NOTICE_FLASH,    // large text, no art
	H9V_NOTICE_BAR       // on the tsm_banner art, with a progress bar
};

// Control types (CTRL). A text entry (5) is not drawn by this client.
enum
{
	H9V_CTRL_LABEL = 1,
	H9V_CTRL_IMAGE,
	H9V_CTRL_BUTTON,
	H9V_CTRL_PROGRESS
};

// Fonts (CTRL): the textscheme schemes they are drawn in.
enum
{
	H9V_FONT_TEXT = 0, // Primary Button Text
	H9V_FONT_TITLE,    // Primary Button Text, in the title colour
	H9V_FONT_DETAIL,   // Briefing Text
	H9V_FONT_FLASH     // Title Font
};

struct H9MenuRow
{
	int key; // 1-10 (10 is the 0 key), 0 for a row without a key
	int flags;
	char label[H9V_ROW_TEXT];
	char detail[H9V_ROW_TEXT];
};

struct H9MenuDef
{
	bool used;
	char id[H9V_ID_LEN];
	int keys; // bit 0 = key 1 ... bit 9 = key 0
	int time;
	int style;
	int flags;
	char title[H9V_TITLE_LEN];
	char footer[H9V_TITLE_LEN];
	H9MenuRow rows[H9V_MAX_ROWS];
	int numRows;
	float stamp; // when it was last defined, for reuse of the oldest slot
};

struct H9NoticeDef
{
	bool used;
	char slot[H9V_ID_LEN];
	int style;
	int anchor;
	int y; // thousandths of the screen height, with H9V_C; else unused
	int r, g, b;
	float hold, fade;
	int value; // 0-1000 for a bar, -1 for none
	char text[H9V_NOTICE_LEN]; // a status's {t} (m:ss) and {s} (seconds) are its clock
	float start;
	bool status; // a STATUS: stays until its slot is replaced or cleared, stacks first
	int clock;   // a status's clock in seconds at start, -1 for none
};

struct H9CtrlDef
{
	bool used;
	int type;
	int anchor;
	int x, y, w, h;
	int font;
	int align; // 0 left, 1 centre, 2 right
	int r, g, b, a; // a 0: the scheme's colour
	int flags;      // 1 hidden, 2 disabled
	int key;        // 0, or the number key 1-10 that presses it
	int value;      // a progress bar's 0-1000
	char text[H9V_CTRL_TEXT];
};

struct H9PanelDef
{
	bool used;
	char id[H9V_ID_LEN];
	int flags;
	int anchor;
	int x, y, w, h;
	char art[H9V_CTRL_TEXT];
	int timeout;
	H9CtrlDef ctrls[H9V_MAX_CTRLS + 1]; // by control number, 1-48
};

// From CHud::Init: hooks H9Vgui, registers cl_h9_vgui, cl_h9_vgui_scale, cl_h9_vgui_top and the
// _h9vgui userinfo key, and adds the HUD element that keeps the panels in step every frame.
void H9Vgui_Init();

// From CHudMenu::MsgFunc_ShowMenu, once a menu's text has arrived whole: true when an H9 MENU
// stands for it (a TWIN came just before it with the same keys and the CRC of this text), and
// CHudMenu then draws no text. Any other menu ends the panel that stood for the last one.
bool H9Vgui_MenuArrived(int keys, const char* text);

// From CHudMenu whenever its menu goes away: a menu with no keys, its time running out, a choice.
void H9Vgui_MenuGone();

// From CHudMenu::Draw: true while a panel stands for the text menu.
bool H9Vgui_MenuSkinned();

// From TeamFortressViewport::KeyInput: ESC closes the newest server panel; true when it did, and
// the key goes no further.
bool H9Vgui_KeyInput(bool down, int keynum);

// From the slot commands (ammo.cpp), after the text menu: a number key bound to a button of an
// open server panel. True when it was taken.
bool H9Vgui_TakesSlot(int slot);

// The safe area (docs\H9_VGUI.txt, 4c), in screen pixels: what is left of the screen once a thin
// top margin and the bottom band (the chat and TS's HUD) are taken out.
void H9Vgui_SafeArea(int& x0, int& y0, int& x1, int& y1);

// The pixel row just under what the H9 VGUI shows in the top stack (the notices and the panels
// anchored along the top) this frame, 0 while it shows nothing there: on a server whose match mode
// draws it, CHudTSMessage::Draw puts TS's own top notices beneath it.
int H9Vgui_StackBottom();
// ---- end H9 VGUI ------------------------------------------------------------------------------
