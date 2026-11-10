// ---- H9 chat bubbles --------------------------------------------------------------------------------------------
// The H9Say message and the boxes it draws. h9_chatbubble.h is the outline; docs\CHAT_BUBBLES.txt the protocol and the guide.
//
//   byte    the speaker's slot, 1 to MAX_PLAYERS; 0 (with a ttl of 0) takes every line down
//   byte    flags: bit 0, the line was said in team chat
//   short   how long the line stays, in tenths of a second; 0 takes the speaker's line down
//   short   how far away it shows, in units
//   byte    the top of the speaker's head above his origin standing, in units
//   byte    the same ducking
//   string  the words
//
// The client keeps each speaker's latest line. Every frame it picks the speaker whose body the crosshair is on (or near, to
// cl_h9_chatbubble_aim), checks that nothing solid stands between the eye and his head, projects the point just over his head
// onto the screen and puts a box there. A box is the banner art of the H9 panels (sprites/tsm_banner.spr through the panels'
// nine-slice), the text in the H9 Text fonts of the textscheme, a heading in the lit purple with the panels' rule under it. The
// art comes in three widths, so a session makes a handful of the panels' art bitmaps (each is kept for the life of the client).
//
// While the server's typing sprite (the "..." over a player writing) shows over a speaker, his box rests over the top of that
// sprite and not over his head, so the two never overlap (TypingSpriteTop). The player's own line is a box near the top of the
// screen; the game asks the server for it in the value of the userinfo key _h9chatbubble (InfoValue, cl_h9_chatbubble_own).
//
// Everything platform-specific is behind the engine's own API, so the web client compiles this file as it is.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "const.h"
#include "cl_entity.h"
#include "com_model.h"
#include "pmtrace.h"
#include "pm_defs.h"
#include "triangleapi.h"
#include "ts_hud.h"
#include "event_api.h"
#include "player_info.h"
#include "vgui_TeamFortressViewport.h"
#include "h9_vgui.h"
#include "vgui_H9Panel.h"
#include "h9_chatbubble.h"

#include <string.h>
#include <stdio.h>
#include <math.h>

extern Vector TS_AimEye();                // ts_reticle.cpp: the eye the aim trace uses
extern bool TS_PlayerSpectating(int idx); // ts_spectate.cpp: a player the Spectator table marks spectating

namespace
{
const int MSG_MIN = 9;          // bytes an H9Say message has at least
const int MSG_MAX = 192;        // and at most
const int TEXT_MAX = 160;       // bytes of words kept
const int MAX_RATE = 24;        // lines a second, from everyone together
const int MAX_SHOWN = 4;        // boxes on screen at once
const int MAX_CAND = 24;        // speakers weighed in a frame
const int WRAP_LINES = 24;      // lines the wrap may make before it cuts
const int LINE_LEN = 168;       // bytes of one line
const int TIP_GAP = 2;          // pixels between the pointer's tip and the point over the head
const float HEAD_GAP = 6.0f;    // units over the top of the head
const float FADE_OUT = 0.8f;    // seconds a line fades out over, with cl_h9_chatbubble_fade
const float FADE_IN = 0.12f;    // seconds a box comes up over when it begins to show
const float HOLD_MAX = 30.0f;   // seconds a line stays at most
const float DEFAULT_STAND = 36.0f;
const float DEFAULT_DUCK = 22.0f;
const char* const TYPING_SPRITE = "sprites/tsm_typing.spr";
const float TYPING_HALF_H = 48.0f; // half the height of a frame of the typing sprite, in units at scale 1 (128 x 96 pixels, ts_floatchat's FC_SPR_HALF_H)
const float MAX_LIFT = 64.0f;      // the most the typing sprite raises a box over the head, whatever the server's sprite says
const float INFO_GAP = 2.0f;       // seconds between two writes of _h9chatbubble: the server ignores a userinfo update that follows another within 0.6 s

// H9's purples (vgui_H9Panel.cpp): the lit purple of titles, numbers and the art's brackets, and the rail's.
const int LIT_R = 182, LIT_G = 145, LIT_B = 234;
const int RAIL_R = 133, RAIL_G = 98, RAIL_B = 178;

// The switches, all saved. s_Switches below is the table cl_h9_chatbubble_list prints.
cvar_t* s_cvOn;        // cl_h9_chatbubble: 0 leaves the words to the server's hudmessage
cvar_t* s_cvAimed;     // cl_h9_chatbubble_aimed: 1 only the speaker under the crosshair, 0 every speaker in view
cvar_t* s_cvAim;       // cl_h9_chatbubble_aim: how near the crosshair must be, in percent of the screen height
cvar_t* s_cvRange;     // cl_h9_chatbubble_range: farthest a line shows, 0 is the server's say
cvar_t* s_cvBox;       // cl_h9_chatbubble_box: the panel art behind the words
cvar_t* s_cvName;      // cl_h9_chatbubble_name: the speaker's name as a heading
cvar_t* s_cvTeamColor; // cl_h9_chatbubble_teamcolor: his team's colour on the name and the pointer
cvar_t* s_cvPointer;   // cl_h9_chatbubble_pointer: the pointer from the box to the head
cvar_t* s_cvFade;      // cl_h9_chatbubble_fade: fade out at the end of a line
cvar_t* s_cvLines;     // cl_h9_chatbubble_lines: most lines of words in a box
cvar_t* s_cvHold;      // cl_h9_chatbubble_hold: seconds a line stays, 0 is the server's say
cvar_t* s_cvScale;     // cl_h9_chatbubble_scale: the text's size
cvar_t* s_cvTeam;      // cl_h9_chatbubble_team: lines said in team chat
cvar_t* s_cvOwn;       // cl_h9_chatbubble_own: 1 asks the server for your own line, shown near the top of the screen
cvar_t* s_cvTyping;    // cl_h9_chatbubble_typing: the server's typing sprite over a player writing
cvar_t* s_cvInfo;      // _h9chatbubble: the userinfo key the server reads: 0 this game does not draw the words, 1 it does, 1s it does and asks for its own line

struct Switch
{
	cvar_t** cv;
	const char* name;
	const char* def;
	const char* what;
};
const Switch s_Switches[] = {
	{&s_cvOn, "cl_h9_chatbubble", "1", "1 draws what players say in a box over their heads, 0 leaves it to the server's hudmessage"},
	{&s_cvAimed, "cl_h9_chatbubble_aimed", "1", "1 only the speaker your crosshair is on, 0 every speaker in view (4 boxes at most)"},
	{&s_cvAim, "cl_h9_chatbubble_aim", "4", "how near the crosshair must be to a speaker's body, in percent of the screen height (0 to 25)"},
	{&s_cvRange, "cl_h9_chatbubble_range", "0", "the farthest a line shows, in units (never beyond the server's fc_range); 0 is the server's"},
	{&s_cvBox, "cl_h9_chatbubble_box", "1", "1 the H9 panel art behind the words, 0 the words alone"},
	{&s_cvName, "cl_h9_chatbubble_name", "0", "1 the speaker's name as a heading over the words"},
	{&s_cvTeamColor, "cl_h9_chatbubble_teamcolor", "1", "1 the speaker's team colours his name and the pointer (the scoreboard's colours)"},
	{&s_cvPointer, "cl_h9_chatbubble_pointer", "1", "1 a pointer from the box down to the head"},
	{&s_cvFade, "cl_h9_chatbubble_fade", "1", "1 fade out over the last 0.8 s of a line, 0 vanish at its end"},
	{&s_cvLines, "cl_h9_chatbubble_lines", "3", "most lines of words in a box (1 to 5); what does not fit is cut with ..."},
	{&s_cvHold, "cl_h9_chatbubble_hold", "0", "seconds a line stays (1 to 30); 0 is the server's"},
	{&s_cvScale, "cl_h9_chatbubble_scale", "1", "text size, 0.5 to 2: steps at 0.55, 0.7, 0.9 (normal) and 1.4 (large)"},
	{&s_cvTeam, "cl_h9_chatbubble_team", "1", "1 shows lines said in team chat"},
	{&s_cvOwn, "cl_h9_chatbubble_own", "0", "1 asks the server for your own line, shown near the top of the screen (the server's fc_self 1 sends it to everyone); needs cl_h9_chatbubble 1"},
	{&s_cvTyping, "cl_h9_chatbubble_typing", "1", "1 shows the server's typing bubble over a player writing, 0 hides it"},
};

bool s_bInited = false;
float s_flRateStart = 0.0f;
int s_iRateCount = 0;
float s_flLastDraw = -100.0f; // when the HUD last drew this element: the boxes hide when it stops

// The latest line of each speaker.
struct SpokenLine
{
	bool used;
	bool team;
	char text[TEXT_MAX + 4];
	float start; // client time it arrived
	float ttl;   // seconds the server said
	float range;
	float stand, duck;
};
SpokenLine s_Lines[MAX_PLAYERS + 1];
bool s_bShownLast[MAX_PLAYERS + 1]; // a box showed for the speaker last frame
bool s_bShownNext[MAX_PLAYERS + 1];
float s_flShownSince[MAX_PLAYERS + 1];
int s_iAimed = 0; // the speaker the aimed box showed for last frame: a little more room to stay on him
int s_iTypingEnt[MAX_PLAYERS + 1]; // the entity index of each player's typing sprite, as HUD_AddEntity last saw it drawn; 0 for none
float s_flInfoAt = -100.0f;        // client time of the last write of _h9chatbubble

inline int Max(int a, int b) { return a > b ? a : b; }
inline int Min(int a, int b) { return a < b ? a : b; }
inline int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline int Round(float f) { return (int)(f + 0.5f); }

bool On(cvar_t* cv)
{
	return cv && cv->value != 0.0f;
}

float Val(cvar_t* cv, float lo, float hi, float def)
{
	float v = cv ? cv->value : def;
	return v < lo ? lo : (v > hi ? hi : v);
}

bool Enabled()
{
	return On(s_cvOn);
}

// The words as a box will have them: a control character is a space, a run of spaces is one, the ends are trimmed and the
// line is cut to size - 1 bytes, never inside a multi-byte character. False when nothing is left.
bool CleanText(const char* in, char* out, int size)
{
	int n = 0;
	bool space = true;
	for (; *in && n < size - 1; in++)
	{
		unsigned char c = (unsigned char)*in;
		if (c < 32 || c == 127)
			c = ' ';
		if (c == ' ')
		{
			if (!space)
			{
				out[n++] = ' ';
				space = true;
			}
			continue;
		}
		space = false;
		out[n++] = (char)c;
	}
	// the cut fell inside a multi-byte character: the character goes
	if (*in && (((unsigned char)*in) & 0xC0) == 0x80)
	{
		while (n > 0 && (((unsigned char)out[n - 1]) & 0xC0) == 0x80)
			n--;
		if (n > 0)
			n--;
	}
	while (n > 0 && out[n - 1] == ' ')
		n--;
	out[n] = 0;
	return n > 0;
}

// How long a line stays: the player's own say (cl_h9_chatbubble_hold) or else the server's.
float HoldOf(const SpokenLine& line)
{
	const float own = s_cvHold ? s_cvHold->value : 0.0f;
	if (own > 0.0f)
		return own < 1.0f ? 1.0f : (own > HOLD_MAX ? HOLD_MAX : own);
	return line.ttl;
}

void StoreLine(int slot, const char* text, bool team, float ttl, float range, float stand, float duck)
{
	SpokenLine& line = s_Lines[slot];
	line.used = true;
	line.team = team;
	strncpy(line.text, text, sizeof(line.text) - 1);
	line.text[sizeof(line.text) - 1] = 0;
	line.start = gHUD.m_flTime;
	line.ttl = ttl;
	line.range = range;
	line.stand = stand;
	line.duck = duck;
}

void ClearLines()
{
	memset(s_Lines, 0, sizeof(s_Lines));
	memset(s_bShownLast, 0, sizeof(s_bShownLast));
	memset(s_bShownNext, 0, sizeof(s_bShownNext));
	s_iAimed = 0;
}

// ---- the message ------------------------------------------------------------------------------------------------

int __MsgFunc_H9Say(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < MSG_MIN || iSize > MSG_MAX || !Enabled())
		return 1;

	// At most MAX_RATE lines a second from everyone together; the rest are dropped.
	const float now = gHUD.m_flTime;
	if (now - s_flRateStart >= 1.0f || now < s_flRateStart)
	{
		s_flRateStart = now;
		s_iRateCount = 0;
	}
	if (++s_iRateCount > MAX_RATE)
		return 1;

	BEGIN_READ(pbuf, iSize);
	const int slot = READ_BYTE();
	const int flags = READ_BYTE();
	const int ttl = READ_SHORT();
	const int range = READ_SHORT();
	const int stand = READ_BYTE();
	const int duck = READ_BYTE();
	const char* words = READ_STRING();
	if (!READ_OK() || slot < 0 || slot > MAX_PLAYERS)
		return 1;

	// ttl 0 takes a line down: slot 0 every line, else that speaker's.
	if (ttl <= 0)
	{
		if (slot == 0)
			ClearLines();
		else
			s_Lines[slot].used = false;
		return 1;
	}
	if (slot < 1 || !words)
		return 1;

	char text[TEXT_MAX + 4];
	if (!CleanText(words, text, TEXT_MAX + 1))
		return 1;

	float seconds = ttl / 10.0f;
	if (seconds > HOLD_MAX)
		seconds = HOLD_MAX;
	StoreLine(slot, text, (flags & 1) != 0, seconds, (float)Clamp(range, 64, 16384), (float)stand, (float)duck);
	return 1;
}

// ---- where a speaker is on the screen ---------------------------------------------------------------------------

struct Probe
{
	cl_entity_t* ent;
	Vector head;    // the point just over the top of his head: what the line of sight and the aim are measured to
	float dist;     // units from the eye to him
	float hx, hy;   // that point on the screen, in pixels
	float bx, by;   // where the box rests, on the screen: that point, or the one over his typing sprite while it shows
	float fy;       // his feet on the screen (y), the bottom of his body
	bool feetOk;    // the feet are in front of the view
};

// The typing sprite the server puts over a player writing is an entity owned by him, made once and kept; EF_NODRAW takes it out of the
// packet when he is not writing. HUD_AddEntity notes the ones it lets through (H9ChatBubble_NoteEntity). This says whether the speaker's
// sprite shows now, and if so how high its top edge is: the entity is still his (its index may have been reused), in this frame's
// packet, not hidden, and the player still wants it drawn (cl_h9_chatbubble_typing).
bool TypingSpriteTop(int slot, const cl_entity_t* lp, float& top)
{
	if (!On(s_cvTyping) || slot < 1 || slot > MAX_PLAYERS || s_iTypingEnt[slot] <= 0)
		return false;
	const cl_entity_t* spr = gEngfuncs.GetEntityByIndex(s_iTypingEnt[slot]);
	if (!spr || spr->curstate.owner != slot || !spr->model || 0 != strcmp(spr->model->name, TYPING_SPRITE))
		return false;
	if (spr->curstate.messagenum < lp->curstate.messagenum || 0 != (spr->curstate.effects & EF_NODRAW))
		return false;

	// A scale of 0 draws a sprite at its own size. Its frames are centred on its origin.
	float scale = spr->curstate.scale;
	if (scale <= 0.0f)
		scale = 1.0f;
	else if (scale > 4.0f)
		scale = 4.0f;
	top = spr->origin.z + TYPING_HALF_H * scale;
	return true;
}

// The height a box rests at over a speaker: HEAD_GAP over the point just over his head (headZ already has it), or over the top of his typing
// sprite when that is higher (spriteTop; hasSprite says there is one), by at most MAX_LIFT.
float RestHeight(float headZ, bool hasSprite, float spriteTop)
{
	if (!hasSprite)
		return headZ;
	const float over = spriteTop + HEAD_GAP;
	if (!(over > headZ))
		return headZ;
	return over > headZ + MAX_LIFT ? headZ + MAX_LIFT : over;
}

// Whether the speaker is a player this frame's packet has, drawn and not spectating, and if so where his head is.
bool Locate(int slot, float stand, float duck, cl_entity_t* lp, const Vector& eye, Probe& p)
{
	cl_entity_t* ent = gEngfuncs.GetEntityByIndex(slot);
	if (!ent || 0 == ent->player)
		return false;
	// not in the packet of this frame (out of the PVS, or gone)
	if (ent->curstate.messagenum < lp->curstate.messagenum)
		return false;
	if (0 != (ent->curstate.effects & EF_NODRAW))
		return false;
	// cloaked: drawn too faint to be seen
	if (ent->curstate.rendermode != 0 && ent->curstate.renderamt <= 16)
		return false;
	if (TS_PlayerSpectating(slot))
		return false;

	const bool ducking = ent->curstate.usehull == 1;
	float top = ducking ? duck : stand;
	if (top < 8.0f)
		top = ducking ? DEFAULT_DUCK : DEFAULT_STAND;
	if (ent->curstate.scale >= 0.1f)
		top *= ent->curstate.scale;

	p.ent = ent;
	p.head = ent->origin;
	p.head.z += top + HEAD_GAP;
	p.dist = (ent->origin - eye).Length();

	float scr[3];
	if (0 != gEngfuncs.pTriAPI->WorldToScreen((float*)&p.head, scr))
		return false;
	p.hx = (1.0f + scr[0]) * 0.5f * (float)ScreenWidth;
	p.hy = (1.0f - scr[1]) * 0.5f * (float)ScreenHeight;

	// The box rests there, or higher while his typing sprite shows. A rest point that cannot be projected (behind the view) leaves it there.
	p.bx = p.hx;
	p.by = p.hy;
	float spriteTop = 0.0f;
	const bool hasSprite = TypingSpriteTop(slot, lp, spriteTop);
	const float restZ = RestHeight(p.head.z, hasSprite, spriteTop);
	if (restZ > p.head.z)
	{
		Vector rest = p.head;
		rest.z = restZ;
		float rs[3];
		if (0 == gEngfuncs.pTriAPI->WorldToScreen((float*)&rest, rs))
		{
			p.bx = (1.0f + rs[0]) * 0.5f * (float)ScreenWidth;
			p.by = (1.0f - rs[1]) * 0.5f * (float)ScreenHeight;
		}
	}

	Vector feet = ent->origin;
	feet.z += ducking ? -18.0f : -36.0f; // the hull's floor, standing and ducking
	p.feetOk = 0 == gEngfuncs.pTriAPI->WorldToScreen((float*)&feet, scr);
	p.fy = p.feetOk ? (1.0f - scr[1]) * 0.5f * (float)ScreenHeight : p.hy;
	return true;
}

// Whether the crosshair (the middle of the screen) is on the speaker's body or within tolPx pixels of it: a rectangle from
// over his head to his feet, as wide as a quarter of that on each side of his middle.
bool Aimed(const Probe& p, float tolPx)
{
	if (!p.feetOk)
		return false;
	const float cx = (float)ScreenWidth * 0.5f, cy = (float)ScreenHeight * 0.5f;
	float h = p.fy - p.hy;
	if (h < 4.0f)
		h = 4.0f;
	const float halfW = h * 0.26f + tolPx;
	return fabsf(cx - p.hx) <= halfW && cy >= p.hy - tolPx && cy <= p.fy + tolPx;
}

// How far the crosshair is from the middle of his body, squared, in pixels: the nearest speaker is the one aimed at.
float AimScore(const Probe& p)
{
	const float cx = (float)ScreenWidth * 0.5f, cy = (float)ScreenHeight * 0.5f;
	const float mid = (p.hy + p.fy) * 0.5f;
	return (cx - p.hx) * (cx - p.hx) + (cy - mid) * (cy - mid);
}

// Whether no wall, door or other solid thing stands between the eye and the point: glass does not count, and a player in the
// way does not either (the trace goes on past him). The point is just over a head, so a ceiling above it leaves a little slack.
bool LineClear(cl_entity_t* lp, const Vector& eye, const Vector& to)
{
	gEngfuncs.pEventAPI->EV_PushPMStates();
	gEngfuncs.pEventAPI->EV_SetTraceHull(2);
	Vector from = eye;
	bool clear = false;
	for (int i = 0; i < 4; i++)
	{
		pmtrace_t tr;
		gEngfuncs.pEventAPI->EV_PlayerTrace((float*)&from, (float*)&to, PM_STUDIO_IGNORE | PM_GLASS_IGNORE, lp->index, &tr);
		if (tr.fraction >= 0.95f)
		{
			clear = true;
			break;
		}
		cl_entity_t* hit = gEngfuncs.GetEntityByIndex(gEngfuncs.pEventAPI->EV_IndexFromTrace(&tr));
		if (!hit || 0 == hit->player)
			break;
		const Vector way = to - from;
		const float len = way.Length();
		if (len < 24.0f)
			break;
		from = tr.endpos + way * (16.0f / len);
	}
	gEngfuncs.pEventAPI->EV_PopPMStates();
	return clear;
}

// ---- what the player asked for ----------------------------------------------------------------------------------

struct BubbleStyle
{
	bool aimed, box, name, teamColor, pointer, fade;
	int lines;
	int fontKind, fontStep;
	float aimPct;
};

BubbleStyle ReadStyle()
{
	BubbleStyle st;
	st.aimed = On(s_cvAimed);
	st.box = On(s_cvBox);
	st.name = On(s_cvName);
	st.teamColor = On(s_cvTeamColor);
	st.pointer = On(s_cvPointer);
	st.fade = On(s_cvFade);
	st.lines = (int)Val(s_cvLines, 1.0f, 5.0f, 3.0f);
	st.aimPct = Val(s_cvAim, 0.0f, 25.0f, 4.0f);

	// The text ladder of the panels (H9 Text 1-4), or the flash ladder's largest for the largest size.
	const float scale = Val(s_cvScale, 0.5f, 2.0f, 1.0f);
	if (scale >= 1.4f)
	{
		st.fontKind = H9V_FONT_FLASH;
		st.fontStep = 0;
	}
	else
	{
		st.fontKind = H9V_FONT_TEXT;
		st.fontStep = scale >= 0.9f ? 0 : (scale >= 0.7f ? 1 : (scale >= 0.55f ? 2 : 3));
	}
	return st;
}

float UserScale()
{
	float f = CVAR_GET_FLOAT("cl_h9_vgui_scale");
	if (f <= 0.0f)
		f = 1.0f;
	return f < 0.5f ? 0.5f : (f > 2.0f ? 2.0f : f);
}

// The banner art's scale: the notices' (docs\H9_VGUI.txt, 2c), so the corners match the panels.
float BannerScale()
{
	return ((float)ScreenHeight / 480.0f) * 0.45f * UserScale();
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

// The speaker's team colour, the scoreboard's and the team box's (iTeamColors), else the lit purple.
void TeamColour(int slot, const BubbleStyle& st, int& r, int& g, int& b)
{
	r = LIT_R;
	g = LIT_G;
	b = LIT_B;
	if (!st.teamColor || gHUD.m_iTeamplay == 0 || slot < 1 || slot > MAX_PLAYERS)
		return;
	const int tn = g_PlayerExtraInfo[slot].teamnumber;
	if (tn >= 1 && tn < iNumberOfTeamColors)
	{
		r = iTeamColors[tn][0];
		g = iTeamColors[tn][1];
		b = iTeamColors[tn][2];
	}
}

// ---- the words, broken into lines -------------------------------------------------------------------------------

// Ends the text with "..." and cuts it from the end until it is no wider than maxW, never inside a multi-byte character.
void Ellipsize(vgui::Font* font, char* text, int maxW)
{
	char tmp[LINE_LEN + 4];
	int len = (int)strlen(text);
	for (;;)
	{
		memcpy(tmp, text, len);
		memcpy(tmp + len, "...", 4);
		if (len == 0 || H9TextWide(font, tmp) <= maxW)
			break;
		len--;
		while (len > 0 && (((unsigned char)text[len]) & 0xC0) == 0x80)
			len--;
	}
	strncpy(text, tmp, LINE_LEN - 1);
	text[LINE_LEN - 1] = 0;
}

// Breaks the words into lines no wider than maxW pixels in the font, at spaces; a word wider than a line is broken between its
// characters. At most maxLines lines: when words are left over the last line ends in "...". Returns the lines made.
int Wrap(vgui::Font* font, const char* text, int maxW, int maxLines, char (*out)[LINE_LEN])
{
	int n = 0;
	char cur[LINE_LEN];
	cur[0] = 0;
	const char* p = text;
	while (*p)
	{
		if (n >= WRAP_LINES)
			break;
		while (*p == ' ')
			p++;
		if (!*p)
			break;
		const char* e = p;
		while (*e && *e != ' ')
			e++;
		char word[LINE_LEN];
		const int wl = Min((int)(e - p), LINE_LEN - 1);
		memcpy(word, p, wl);
		word[wl] = 0;

		char cand[LINE_LEN * 2];
		if (cur[0])
			snprintf(cand, sizeof(cand), "%s %s", cur, word);
		else
			snprintf(cand, sizeof(cand), "%s", word);
		if (H9TextWide(font, cand) <= maxW && (int)strlen(cand) < LINE_LEN)
		{
			strcpy(cur, cand);
			p = e;
			continue;
		}
		if (cur[0])
		{
			strcpy(out[n++], cur);
			cur[0] = 0;
			continue; // the word again, on a fresh line
		}

		// The word alone is wider than a line: the longest start of it that fits, whole characters only.
		int best = 0;
		for (int i = 1; i <= wl; i++)
		{
			if (i < wl && (((unsigned char)word[i]) & 0xC0) == 0x80)
				continue;
			const char save = word[i];
			word[i] = 0;
			const int w = H9TextWide(font, word);
			word[i] = save;
			if (w > maxW)
				break;
			best = i;
		}
		if (best == 0)
		{
			best = 1;
			while (best < wl && (((unsigned char)word[best]) & 0xC0) == 0x80)
				best++;
		}
		memcpy(out[n], word, best);
		out[n][best] = 0;
		n++;
		p += best;
	}
	if (cur[0] && n < WRAP_LINES)
		strcpy(out[n++], cur);

	if (n > maxLines)
	{
		n = maxLines;
		Ellipsize(font, out[n - 1], maxW);
	}
	return n;
}

// ---- the box ----------------------------------------------------------------------------------------------------

class CH9BubblePanel : public CH9Surface
{
public:
	CH9BubblePanel() : m_pFont(nullptr), m_iLineTall(14), m_iLines(0), m_bHeading(false), m_iNameR(LIT_R), m_iNameG(LIT_G), m_iNameB(LIT_B)
	{
		memset(&m_Key, 0, sizeof(m_Key));
		memset(m_szName, 0, sizeof(m_szName));
		memset(m_szLines, 0, sizeof(m_szLines));
	}

	// The words and the style, laid out: sets the box's size. Where it goes is the caller's.
	void Set(const BubbleStyle& st, const char* name, const char* text, int nr, int ng, int nb);

protected:
	void paint() override;

private:
	struct Key
	{
		const CH9Art* art;
		vgui::Font* font;
		int s100, screenW, lines;
		bool box, heading;
		char text[TEXT_MAX + 4];
		char name[40];
	};
	Key m_Key;
	vgui::Font* m_pFont;
	int m_iLineTall;
	int m_iLines;
	bool m_bHeading;
	int m_iNameR, m_iNameG, m_iNameB;
	char m_szName[LINE_LEN];
	char m_szLines[WRAP_LINES][LINE_LEN];
};

void CH9BubblePanel::Set(const BubbleStyle& st, const char* name, const char* text, int nr, int ng, int nb)
{
	m_iNameR = nr;
	m_iNameG = ng;
	m_iNameB = nb;

	const CH9Art* art = st.box ? CH9Art::Find("#banner") : nullptr;
	const float s = BannerScale();
	m_bPlainBox = st.box; // the art missing, the box is the panels' plain dark one
	SetArt(art, s);
	vgui::Font* font = H9Font(st.fontKind, st.fontStep);

	Key key;
	memset(&key, 0, sizeof(key));
	key.art = art;
	key.font = font;
	key.s100 = Round(s * 100.0f);
	key.screenW = ScreenWidth;
	key.lines = st.lines;
	key.box = st.box;
	key.heading = name && name[0];
	strncpy(key.text, text, sizeof(key.text) - 1);
	if (key.heading)
		strncpy(key.name, name, sizeof(key.name) - 1);
	if (0 == memcmp(&key, &m_Key, sizeof(key)))
		return;
	m_Key = key;

	m_pFont = font;
	m_iLineTall = H9FontTall(font) + H9FontTall(font) / 8;
	m_bHeading = key.heading;

	// Insets: the art's content box (as the notices have it), else the plain box's.
	int inL = 8, inT = 6, inR = 8, inB = 6, natural = 0;
	if (art)
	{
		inL = Round(art->insetL * s);
		inT = Round(art->insetT * s);
		inR = Round(art->insetR * s);
		inB = Round(art->insetB * s);
		natural = Round(art->wide * s);
	}
	const int maxBoxW = Min(Max(natural, ScreenWidth * (st.fontKind == H9V_FONT_FLASH ? 40 : 30) / 100), Max(64, ScreenWidth - 16));
	const int contentMax = Max(24, maxBoxW - inL - inR);

	m_iLines = Wrap(font, text, contentMax, st.lines, m_szLines);
	int widest = 0;
	for (int i = 0; i < m_iLines; i++)
		widest = Max(widest, H9TextWide(font, m_szLines[i]));
	m_szName[0] = 0;
	if (m_bHeading)
	{
		strncpy(m_szName, name, sizeof(m_szName) - 1);
		if (H9TextWide(font, m_szName) > contentMax)
			Ellipsize(font, m_szName, contentMax);
		widest = Max(widest, H9TextWide(font, m_szName));
	}

	const int need = m_iLines * m_iLineTall + (m_bHeading ? m_iLineTall + m_iLineTall / 3 : 0);
	const int rows = m_iLines + (m_bHeading ? 1 : 0);
	int wide, tall;
	if (art)
	{
		// As a notice's: a single row is a slim banner, any more at least the art's own height. The width is one of three,
		// so the panels make few bitmaps of the art.
		tall = rows == 1 ? Max(need + inT + inB, Round(2 * art->corner * s)) : Max(Round(art->tall * s), need + inT + inB);
		const int c1 = natural;
		const int c3 = Max(c1, maxBoxW);
		const int c2 = ((c1 + c3) / 2 + 7) / 8 * 8;
		const int want = widest + inL + inR;
		wide = want <= c1 ? c1 : (want <= c2 ? c2 : c3);
	}
	else
	{
		tall = need + inT + inB;
		wide = widest + inL + inR + 2;
	}
	setSize(Max(8, wide), Max(8, tall));
}

void CH9BubblePanel::paint()
{
	int x0, y0, x1, y1;
	ContentBox(x0, y0, x1, y1);
	int wide, tall;
	getSize(wide, tall);
	if (m_bPlainBox && !m_pArt)
		Frame(0, 0, wide, tall, RAIL_R, RAIL_G, RAIL_B, 255);

	int tr, tg, tb;
	TextColour(tr, tg, tb);
	const int fontTall = H9FontTall(m_pFont);
	const bool shadow = !m_pArt && !m_bPlainBox; // words alone, over the world
	const int headTall = m_bHeading ? m_iLineTall + m_iLineTall / 3 : 0;
	const int block = m_iLines * m_iLineTall + headTall;
	int y = y0 + Max(0, (y1 - y0 - block) / 2);

	// The heading as the panels' menus have their title: the lit colour, a rule under it in the rail's.
	if (m_bHeading)
	{
		const int w = H9TextWide(m_pFont, m_szName);
		const int x = x0 + Max(0, (x1 - x0 - w) / 2);
		const int ty = y + (m_iLineTall - fontTall) / 2;
		if (shadow)
			Text(m_pFont, x + 1, ty + 1, m_szName, 0, 0, 0);
		Text(m_pFont, x, ty, m_szName, m_iNameR, m_iNameG, m_iNameB);
		y += m_iLineTall;
		const int line = Max(1, m_iLineTall / 14);
		Box(x0, y + m_iLineTall / 8, x1, y + m_iLineTall / 8 + line, RAIL_R, RAIL_G, RAIL_B, 255);
		y += m_iLineTall / 3;
	}

	for (int i = 0; i < m_iLines; i++)
	{
		const int w = H9TextWide(m_pFont, m_szLines[i]);
		const int x = x0 + Max(0, (x1 - x0 - w) / 2);
		const int ty = y + (m_iLineTall - fontTall) / 2;
		if (shadow)
			Text(m_pFont, x + 1, ty + 1, m_szLines[i], 0, 0, 0);
		Text(m_pFont, x, ty, m_szLines[i], tr, tg, tb);
		y += m_iLineTall;
	}
}

// The pointer from the box down to the head: a small triangle, tip down.
class CH9BubbleTail : public CH9Surface
{
public:
	CH9BubbleTail() : m_iR(LIT_R), m_iG(LIT_G), m_iB(LIT_B)
	{
		m_bPlainBox = false;
	}
	void Set(int wide, int tall, int r, int g, int b)
	{
		m_iR = r;
		m_iG = g;
		m_iB = b;
		setSize(wide, tall);
	}

protected:
	void paint() override
	{
		int wide, tall;
		getSize(wide, tall);
		for (int i = 0; i < tall; i++)
		{
			const int w = Max(1, wide * (tall - i) / tall);
			const int x = (wide - w) / 2;
			Box(x, i, x + w, i + 1, m_iR, m_iG, m_iB, 255);
		}
	}

private:
	int m_iR, m_iG, m_iB;
};

CH9BubblePanel* s_pBox[MAX_SHOWN];
CH9BubbleTail* s_pTail[MAX_SHOWN];
vgui::Panel* s_pParent = nullptr;

// The boxes, made under the viewport the first time it exists (and again if it was replaced).
bool EnsurePanels()
{
	if (!gViewPort)
		return false;
	if (s_pParent == gViewPort && s_pBox[0])
		return true;
	s_pParent = gViewPort;
	for (int k = 0; k < MAX_SHOWN; k++)
	{
		s_pBox[k] = new CH9BubblePanel();
		s_pBox[k]->setParent(gViewPort);
		s_pTail[k] = new CH9BubbleTail();
		s_pTail[k]->setParent(gViewPort);
	}
	return true;
}

void HideAll()
{
	for (int k = 0; k < MAX_SHOWN; k++)
	{
		if (s_pBox[k])
			s_pBox[k]->setVisible(false);
		if (s_pTail[k])
			s_pTail[k]->setVisible(false);
	}
}

// ---- every frame ------------------------------------------------------------------------------------------------

struct Rc
{
	int x, y, w, h;
};

bool Overlaps(int x, int y, int w, int h, const Rc& r)
{
	return x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y;
}

// Sets box k for a speaker and puts it where it goes: pr is the speaker's place on the screen, null for the player's own line
// (near the top of the screen). False when it does not show (faded out, or no room that is clear of the other boxes).
bool Show(int k, int slot, const Probe* pr, const BubbleStyle& st, float now, Rc* placed)
{
	const SpokenLine& line = s_Lines[slot];
	s_bShownNext[slot] = true;

	// Faded out at the end of the line if the player wants it, and in over a moment when it begins to show.
	float a = 1.0f;
	const float remaining = HoldOf(line) - (now - line.start);
	if (st.fade && remaining < FADE_OUT)
		a = remaining / FADE_OUT;
	if (!s_bShownLast[slot])
		s_flShownSince[slot] = now;
	const float up = now - s_flShownSince[slot];
	if (up < FADE_IN)
		a *= up / FADE_IN;
	const int alpha = Clamp((int)(a * 255.0f), 0, 255);
	if (alpha <= 0)
		return false;

	int nr, ng, nb;
	TeamColour(slot, st, nr, ng, nb);
	const char* name = "";
	if (st.name && g_PlayerInfoList[slot].name)
		name = g_PlayerInfoList[slot].name;
	CH9BubblePanel* box = s_pBox[k];
	box->Set(st, name, line.text, nr, ng, nb);
	int bw, bh;
	box->getSize(bw, bh);

	int sx0, sy0, sx1, sy1;
	H9Vgui_SafeArea(sx0, sy0, sx1, sy1);
	const int minTop = Max(sy0, H9Vgui_StackBottom()); // beneath the notices and the panels of the top stack

	// The pointer's size: a small triangle, a pixel unit of the marks' size.
	const float unit = ((float)ScreenHeight / 480.0f) * UserScale() * 0.5f;
	const int tw = Max(8, (int)(16.0f * unit)) | 1;
	const int th = st.pointer ? Max(4, tw / 2) : 0;

	int x, y, hx = 0;
	bool pointer = false;
	if (!pr)
	{
		x = (ScreenWidth - bw) / 2;
		y = Max(minTop, ScreenHeight * 30 / 100);
	}
	else
	{
		hx = (int)pr->bx;
		const int hy = (int)pr->by;
		x = Clamp(hx - bw / 2, 4, Max(4, ScreenWidth - 4 - bw));
		y = hy - TIP_GAP - th - bh;
		bool moved = false;

		// above the chat and the HUD's bottom band
		if (y + bh > sy1)
		{
			y = sy1 - bh;
			moved = true;
		}
		// off the crosshair
		const int cx0 = ScreenWidth / 2 - ScreenWidth * 6 / 100, cx1 = ScreenWidth / 2 + ScreenWidth * 6 / 100;
		const int cy0 = ScreenHeight / 2 - ScreenHeight * 4 / 100, cy1 = ScreenHeight / 2 + ScreenHeight * 4 / 100;
		if (x < cx1 && x + bw > cx0 && y < cy1 && y + bh > cy0 && cy0 - 4 - bh >= minTop)
		{
			y = cy0 - 4 - bh;
			moved = true;
		}
		// off the boxes already placed: above them
		for (int pass = 0; pass < 3; pass++)
		{
			for (int i = 0; i < k; i++)
			{
				if (Overlaps(x, y, bw, bh, placed[i]))
				{
					y = placed[i].y - bh - 2;
					moved = true;
				}
			}
		}
		// beneath the top stack
		if (y < minTop)
		{
			y = minTop;
			moved = true;
		}
		pointer = st.pointer && !moved && hx >= x + bw / 8 && hx <= x + bw - bw / 8;
	}
	for (int i = 0; i < k; i++)
	{
		if (Overlaps(x, y, bw, bh, placed[i]))
			return false;
	}

	box->SetAlpha(alpha);
	box->setPos(x, y);
	box->setVisible(true);
	if (pointer)
	{
		s_pTail[k]->Set(tw, th, nr, ng, nb);
		s_pTail[k]->SetAlpha(alpha);
		s_pTail[k]->setPos(hx - tw / 2, y + bh - 1);
		s_pTail[k]->setVisible(true);
	}
	else
	{
		s_pTail[k]->setVisible(false);
	}
	placed[k].x = x;
	placed[k].y = y;
	placed[k].w = bw;
	placed[k].h = bh;
	return true;
}

struct Cand
{
	int slot;
	Probe probe;
	float key;
};

// Picks the speakers to show and places a box for each. Returns the boxes shown.
int Compose(float now)
{
	cl_entity_t* lp = gEngfuncs.GetLocalPlayer();
	if (!lp)
		return 0;
	const int local = lp->index;
	const Vector eye = TS_AimEye();
	const BubbleStyle st = ReadStyle();
	const float userRange = s_cvRange ? s_cvRange->value : 0.0f;

	Cand cand[MAX_CAND];
	int n = 0, own = 0;
	for (int slot = 1; slot <= MAX_PLAYERS; slot++)
	{
		SpokenLine& line = s_Lines[slot];
		if (!line.used)
			continue;
		const float age = now - line.start;
		if (age < 0.0f || age >= HoldOf(line))
		{
			line.used = false;
			continue;
		}
		if (line.team && !On(s_cvTeam))
			continue;
		// His own line is shown whenever the server sent it: it sends it to a player who asked (cl_h9_chatbubble_own) or to everyone
		// (fc_self 1), and a line that was not sent never gets here.
		if (slot == local)
		{
			own = slot;
			continue;
		}

		Probe p;
		if (!Locate(slot, line.stand, line.duck, lp, eye, p))
			continue;
		float range = line.range;
		if (userRange > 0.0f && userRange < range)
			range = userRange;
		if (p.dist > range)
			continue;

		float key;
		if (st.aimed)
		{
			float tol = (float)ScreenHeight * st.aimPct / 100.0f;
			if (slot == s_iAimed)
				tol = tol * 1.6f + 2.0f; // the one already shown keeps his box a little past the edge
			if (!Aimed(p, tol))
				continue;
			key = AimScore(p);
		}
		else
		{
			if (p.hx < 0.0f || p.hx > (float)ScreenWidth || p.hy < 0.0f || p.hy > (float)ScreenHeight)
				continue;
			key = p.dist;
		}
		if (n < MAX_CAND)
		{
			int at = n;
			while (at > 0 && cand[at - 1].key > key)
			{
				cand[at] = cand[at - 1];
				at--;
			}
			cand[at].slot = slot;
			cand[at].probe = p;
			cand[at].key = key;
			n++;
		}
	}

	memset(s_bShownNext, 0, sizeof(s_bShownNext));
	Rc placed[MAX_SHOWN];
	int shown = 0;
	if (own)
	{
		if (Show(shown, own, nullptr, st, now, placed))
			shown++;
	}

	// The nearest to the crosshair (or, with every speaker in view, the nearest to the eye) that can be seen: a trace for each.
	int firstShown = 0;
	const int cap = st.aimed ? Min(MAX_SHOWN, shown + 1) : MAX_SHOWN;
	for (int i = 0, traces = 0; i < n && shown < cap && traces < 8; i++, traces++)
	{
		if (!LineClear(lp, eye, cand[i].probe.head))
			continue;
		if (Show(shown, cand[i].slot, &cand[i].probe, st, now, placed))
		{
			if (!firstShown)
				firstShown = cand[i].slot;
			shown++;
		}
	}

	s_iAimed = st.aimed ? firstShown : 0;
	memcpy(s_bShownLast, s_bShownNext, sizeof(s_bShownLast));
	return shown;
}

// The boxes show while the HUD does: not with nohud, not dead or spectating, not under the scoreboard, not in an intermission.
bool ShowingNow()
{
	if (!gViewPort || gViewPort->IsScoreBoardVisible() || gHUD.m_iIntermission)
		return false;
	return !TSHud_NoHud() && !TSHud_PlayerPartsHidden();
}

void Update(float now)
{
	int shown = 0;
	if (Enabled() && EnsurePanels() && ShowingNow())
		shown = Compose(now);
	else
		memset(s_bShownLast, 0, sizeof(s_bShownLast));
	for (int k = shown; k < MAX_SHOWN; k++)
	{
		if (s_pBox[k])
			s_pBox[k]->setVisible(false);
		if (s_pTail[k])
			s_pTail[k]->setVisible(false);
	}
}

// What the userinfo key _h9chatbubble says, which the server reads (docs\CHAT_BUBBLES.txt, section 1): "0" when this game does not
// draw the words itself (cl_h9_chatbubble 0), so the server sends the hudmessage; "1" when it does; "1s" when it does and the player
// also asks for his own line (cl_h9_chatbubble_own 1). The first character is all an older server reads, and it reads "1s" as "1":
// the game is drawn for as before, only its own line is not sent. The key has no more room than a byte, as a userinfo is full.
const char* InfoValue()
{
	if (!Enabled())
		return "0";
	return On(s_cvOwn) ? "1s" : "1";
}

// _h9chatbubble follows cl_h9_chatbubble and cl_h9_chatbubble_own. The server ignores a userinfo update that follows another within
// 0.6 s (sv_userinfo_penalty_time times its multiplier) and reads the key again only at its next resend of the player's info, about a
// second later, and a client that keeps changing it is held back for longer: so the key is written at most once in INFO_GAP seconds,
// always with what the switches say by then.
void SyncUserinfo()
{
	if (!s_cvInfo)
		return;
	const char* want = InfoValue();
	if (s_cvInfo->string && 0 == strcmp(s_cvInfo->string, want))
		return;
	const float now = gEngfuncs.GetClientTime();
	if (now >= s_flInfoAt && now - s_flInfoAt < INFO_GAP)
		return;
	s_flInfoAt = now;
	gEngfuncs.Cvar_Set("_h9chatbubble", want);
}

// ---- the commands -----------------------------------------------------------------------------------------------

// cl_h9_chatbubble_list: every switch and its value.
void CmdList()
{
	const char* sent = s_cvInfo && s_cvInfo->string ? s_cvInfo->string : "0";
	gEngfuncs.Con_Printf("chat bubbles: %s; the server %s the words as a hudmessage (_h9chatbubble %s%s%s)\n", Enabled() ? "on" : "off",
		Enabled() ? "does not send you" : "sends you", sent, 0 == strcmp(sent, InfoValue()) ? "" : ", about to be sent as ",
		0 == strcmp(sent, InfoValue()) ? "" : InfoValue());
	for (const Switch& sw : s_Switches)
	{
		gEngfuncs.Con_Printf("  %-28s %-5s (%s)  %s\n", sw.name, *sw.cv && (*sw.cv)->string ? (*sw.cv)->string : "?", sw.def, sw.what);
	}
	int held = 0;
	for (int i = 1; i <= MAX_PLAYERS; i++)
	{
		if (s_Lines[i].used)
			held++;
	}
	gEngfuncs.Con_Printf("  %d line(s) held now. cl_h9_chatbubble_test <words> puts words over the player your crosshair is on, else over you.\n", held);
}

// cl_h9_chatbubble_test <words>: a line of your own making, for 10 seconds, over the player the crosshair is on (a player in view
// within the aim tolerance, at least 4 percent), else over you.
void CmdTest()
{
	const int argc = gEngfuncs.Cmd_Argc();
	if (argc < 2)
	{
		gEngfuncs.Con_Printf("usage: cl_h9_chatbubble_test <words>   (the words over the player your crosshair is on, else over you, for 10 seconds)\n");
		return;
	}
	char joined[256];
	joined[0] = 0;
	for (int i = 1; i < argc; i++)
	{
		if (joined[0])
			strncat(joined, " ", sizeof(joined) - strlen(joined) - 1);
		strncat(joined, gEngfuncs.Cmd_Argv(i), sizeof(joined) - strlen(joined) - 1);
	}
	char text[TEXT_MAX + 4];
	if (!CleanText(joined, text, sizeof(text)))
		return;
	cl_entity_t* lp = gEngfuncs.GetLocalPlayer();
	if (!lp)
	{
		gEngfuncs.Con_Printf("chat bubbles: not in a game\n");
		return;
	}
	const BubbleStyle st = ReadStyle();
	const Vector eye = TS_AimEye();
	int best = lp->index;
	float bestKey = 1.0e30f;
	for (int slot = 1; slot <= MAX_PLAYERS && slot <= gEngfuncs.GetMaxClients(); slot++)
	{
		if (slot == lp->index)
			continue;
		Probe p;
		if (!Locate(slot, 0.0f, 0.0f, lp, eye, p))
			continue;
		const float tol = (float)ScreenHeight * (st.aimPct < 4.0f ? 4.0f : st.aimPct) / 100.0f;
		if (!Aimed(p, tol))
			continue;
		const float key = AimScore(p);
		if (key < bestKey)
		{
			bestKey = key;
			best = slot;
		}
	}
	StoreLine(best, text, false, 10.0f, 4096.0f, 0.0f, 0.0f);
	gEngfuncs.Con_Printf("chat bubbles: test line over %s%s\n", best == lp->index ? "you" : (g_PlayerInfoList[best].name ? g_PlayerInfoList[best].name : "a player"),
		Enabled() ? "" : " (cl_h9_chatbubble is 0: nothing shows)");
}

class CHudH9ChatBubble : public CHudBase
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
		Update(flTime);
		return true;
	}
	void Think() override
	{
		SyncUserinfo();
		// The HUD stopped drawing (hidden, or an intermission): the boxes must not stay up on their own.
		if (gEngfuncs.GetClientTime() - s_flLastDraw > 0.3f)
			HideAll();
	}
	void InitHUDData() override
	{
		ClearLines(); // a new map, or a new server
		memset(s_iTypingEnt, 0, sizeof(s_iTypingEnt));
	}
};
CHudH9ChatBubble s_Hud;
} // namespace

// ---- the hooks --------------------------------------------------------------------------------------------------

void H9ChatBubble_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	for (const Switch& sw : s_Switches)
		*sw.cv = CVAR_CREATE(sw.name, sw.def, FCVAR_ARCHIVE);
	s_cvInfo = CVAR_CREATE("_h9chatbubble", InfoValue(), FCVAR_USERINFO);
	gEngfuncs.pfnHookUserMsg("H9Say", __MsgFunc_H9Say);
	gEngfuncs.pfnAddCommand("cl_h9_chatbubble_list", CmdList);
	gEngfuncs.pfnAddCommand("cl_h9_chatbubble_test", CmdTest);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

bool H9ChatBubble_HideEntity(const char* modelname)
{
	if (!modelname || !s_cvTyping || s_cvTyping->value != 0.0f)
		return false;
	return 0 == strcmp(modelname, TYPING_SPRITE);
}

void H9ChatBubble_NoteEntity(const struct cl_entity_s* ent, const char* modelname)
{
	if (!ent || !modelname || 0 != strcmp(modelname, TYPING_SPRITE))
		return;
	// The plugin sets the sprite's owner to the player it is over, and the game sends an entity's owner only when it is a player.
	if (ent->curstate.owner >= 1 && ent->curstate.owner <= MAX_PLAYERS && ent->index > 0)
		s_iTypingEnt[ent->curstate.owner] = ent->index;
}
