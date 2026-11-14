// ---- H9 race HUD: what it holds and how it is drawn ---------------------------------------------------------------------------------
// Everything the race HUD shows, over a Canvas that fills rectangles and does nothing else: the game gives it pfnFillRGBABlend
// (h9_racehud.cpp), a test gives it a picture in memory (tests\racehud_test.cpp, which also checks the arithmetic here). So the letters
// are a 5 by 7 dot font and the numbers a seven-segment display, both made of rectangles, at any size: no sprite and no font file is
// needed, and the test's pictures are what the game draws. The colours are those of the other H9 panels (h9_arpinv_draw.h): lit
// 182 145 234, rail 133 98 178, detail 166 154 192; the game moves the purples to the player's colour (h9_theme.h).
//
// Sizes are in units of `ps` pixels (PixelSize: 2 at 1280x720 and 1024x768, 3 at 1920x1080, 1 at 640x480): the HUD is laid out on a
// screen at least 300 units high and 500 wide, whatever the picture's shape.
//
// The layout is a small one: while racing, a piece in each corner (the lap and the place, the clocks, the map, the speed), each
// drawn on the game's picture with a dark edge and no panel behind it, and what comes and goes (the lights, a note, wrong way) small
// along the top's middle. The middle of the screen is the road's. Only the results, when the race is over, are a panel. The sizes to
// tune are together below (HUD_EDGE and the rest).
//
// No engine here.
#pragma once

#include "race.h" // the messages' numbers (dlls/race.h)

#include <math.h>
#include <stdio.h>
#include <string.h>

namespace racehud
{
struct Canvas
{
	virtual ~Canvas() {}
	virtual void Fill(int x, int y, int w, int h, int r, int g, int b, int a) = 0; // blended by a
	virtual int Width() = 0;
	virtual int Height() = 0;
};

struct Col
{
	int r, g, b;
};
const Col LIT = {182, 145, 234};
const Col RAIL = {133, 98, 178};
const Col DET = {166, 154, 192};
const Col TXT = {235, 230, 245};
const Col OKC = {96, 200, 120};
const Col WARN = {236, 204, 84};
const Col BAD = {236, 96, 96};
const Col DARK = {14, 10, 24};
const Col LAMP_OFF = {70, 22, 26};
const Col LAMP_RED = {240, 56, 48};
const Col LAMP_GREEN = {84, 232, 112};

const float SPEED_UNITS = 6.3f;    // units a second to one of the readout's: 1200 reads 190
const float RALLY_SPEED_UNITS = 3.0f; // the same in rally mode, HL Rally's: its HUD shows |velocity| / 3 (rallyhud.cpp), so 680 reads 227
const float RALLY_SPEED_FLOOR = 9.0f; // and shows 0 under 9
const float METRE_UNITS = 22.7f;   // units to a metre at that scale (6.3 * 3.6)
const float TOP_SPEED = 1200.0f;   // the gauge's end when the server names none
const float STAT_LIFE = 0.7f;      // seconds the panels stay with no status (it comes five times a second): short, so the TS HUD is back at once on foot
const float DOTS_LIFE = 2.0f;      // and the dots of the map with no positions
const float RESULTS_LIFE = 13.0f;  // the table (the server keeps it 12 s and then says the race waits again)
const float GO_TIME = 1.5f;        // the green lamps
const float NOTE_FADE = 0.4f;
const float CLOCK_SAME = 1.0f;     // the client's clock is the server's when they are this near
const float CLOCK_JUMP = 0.5f;

enum
{
	MAX_LINE = 512, // the server's RACE_MAX_MARKS
	MAX_CPS = 64,   // RACE_MAX_CHECKPOINTS
	MAX_DOTS = 32,
	MAX_ROWS = 32,
	NAME_LEN = 32,
	TABLE_ROWS = 12,
};

struct Pt
{
	short x, y; // the map's, divided by RACE_HUD_COORD
};

struct Dot
{
	int index, place;
	bool finished, retired;
	short x, y;
	int gap; // RACE_HUD_GAP units behind the first still racing; -1 not known
	char name[NAME_LEN];
};

struct Row
{
	int place, index, flags, lap;
	int total, best; // hundredths
	char name[NAME_LEN];
};

struct Model
{
	// the race, for everybody (H9RState)
	bool haveState = false;
	int state = RACE_WAITING, laps = 0, racers = 0;
	bool resultsUp = false;
	float t0 = 0, countdown = 5;

	// the server's clock is the client's plus this (ClockOffset)
	bool haveClock = false;
	float clock = 0;

	// this racer (H9RStat)
	bool haveStat = false;
	float statAt = 0; // the client's time it came
	int flags = 0, lap = 0, place = 0;
	float speed = 0, slip = 0, topSpeed = TOP_SPEED;
	float speedUnits = SPEED_UNITS, speedFloor = 0; // the readout's divisor, and the reading under which it shows 0 (rally mode changes both)
	float gauge = 0; // the speed the gauge shows: it follows `speed` smoothly
	float raceStart = 0, lapStart = 0, limitEnd = 0, limitLen = 0; // limitLen: the allowance, known before the start
	int bestCs = 0, totalCs = 0;

	// the last note (H9RNote)
	int noteKind = 0, noteA = 0, noteB = 0, noteFlags = 0, noteTime = 0, noteDiff = 0;
	float noteAt = 0;

	// the map (H9RLine)
	Pt line[MAX_LINE];
	int linePoints = 0, lineTotal = 0;
	Pt cps[MAX_CPS];
	int cpPoints = 0, cpTotal = 0;

	// the racers (H9RPos)
	Dot dots[MAX_DOTS];
	int dotCount = 0;
	float dotsAt = 0;
	bool haveDots = false;

	// the results (H9RRes)
	Row rows[MAX_ROWS];
	int rowCount = 0, rowTotal = 0, rowLaps = 0;
	float rowsAt = 0;

	int local = 0; // the player's own index
};

// ---- arithmetic ---------------------------------------------------------------------------------------------------------------------

inline int ClampI(int v, int lo, int hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

inline float ClampF(float v, float lo, float hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

// m:ss.cc from hundredths of a second.
inline void FormatTime(char* out, size_t room, int cs)
{
	if (cs < 0)
		cs = 0;
	snprintf(out, room, "%d:%02d.%02d", cs / 6000, (cs / 100) % 60, cs % 100);
}

// +s.cc or -s.cc (m:ss.cc from a minute up).
inline void FormatDiff(char* out, size_t room, int cs)
{
	const char sign = cs < 0 ? '-' : '+';
	const int a = cs < 0 ? -cs : cs;
	if (a >= 6000)
		snprintf(out, room, "%c%d:%02d.%02d", sign, a / 6000, (a / 100) % 60, a % 100);
	else
		snprintf(out, room, "%c%d.%02d", sign, a / 100, a % 100);
}

// The hundredths a clock that started at `since` shows at `now` (both on the server's clock): what has passed, never negative.
inline int RunningCs(float now, float since)
{
	const float d = now - since;
	return d <= 0 ? 0 : (int)(d * 100.0f);
}

// 1ST, 2ND, 3RD, 4TH, 11TH, 21ST.
inline void Ordinal(char* out, size_t room, int place)
{
	const char* end = "TH";
	if (place % 100 < 11 || place % 100 > 13)
		end = place % 10 == 1 ? "ST" : (place % 10 == 2 ? "ND" : (place % 10 == 3 ? "RD" : "TH"));
	snprintf(out, room, "%d%s", place, end);
}

// The number the speed readout shows.
inline int SpeedShown(float units, float divisor = SPEED_UNITS, float zeroUnder = 0.0f)
{
	const float shown = fabsf(units) / divisor;
	return shown < zeroUnder ? 0 : (int)(shown + 0.5f);
}

// What to add to the client's time to have the server's, from a message that carries the server's `now`. The engine gives the client
// the server's own clock, a little behind (it draws the world between two updates), and then nothing is added: a clock on the HUD
// shows the moment the picture shows. Were the two not one clock (more than CLOCK_SAME apart), the difference is taken, and followed
// gently from then on so that one late message does not move every clock.
inline float ClockOffset(bool have, float held, float serverNow, float clientNow)
{
	const float d = serverNow - clientNow;
	if (fabsf(d) <= CLOCK_SAME)
		return 0;
	if (!have || fabsf(d - held) > CLOCK_JUMP)
		return d;
	return held + (d - held) * 0.1f;
}

// The start lights: five reds that light one after another over the countdown (all five through its last fifth), then five greens
// for GO_TIME.
struct Lamps
{
	bool show;
	int reds;   // 0 to 5
	bool green;
	int number; // the seconds to go, rounded up; 0 at the green
};

inline Lamps LampState(int state, float toGo, float countdown, float sinceGo)
{
	Lamps l = {false, 0, false, 0};
	if (state == RACE_COUNTDOWN && toGo > 0)
	{
		const float length = countdown > 0.1f ? countdown : 0.1f;
		const float done = ClampF((length - toGo) / length, 0, 1);
		l.show = true;
		l.reds = ClampI(1 + (int)(done * 5), 1, 5);
		l.number = (int)ceilf(toGo);
	}
	else if (state == RACE_COUNTDOWN || (state == RACE_RACING && sinceGo < GO_TIME))
	{
		l.show = true;
		l.green = true;
	}
	return l;
}

// The gauge's lit colour: the panels' purple, amber as the tyres let go, red when they slide.
inline Col SlipColour(float slip)
{
	slip = ClampF(slip, 0, 1);
	const Col& from = slip < 0.5f ? LIT : WARN;
	const Col& to = slip < 0.5f ? WARN : BAD;
	float k = slip < 0.5f ? (slip - 0.15f) / 0.35f : (slip - 0.5f) / 0.3f;
	k = ClampF(k, 0, 1);
	Col c = {from.r + (int)((to.r - from.r) * k), from.g + (int)((to.g - from.g) * k), from.b + (int)((to.b - from.b) * k)};
	return c;
}

// The gauge: a half ring over its centre, cut into `segments`, lit from the left by `frac`. For the point (dx, dy) from the centre
// (dy grows downwards): 0 outside, 1 a segment not lit, 2 a lit one. A segment lights when the needle has passed its middle.
inline int ArcCell(float dx, float dy, float rIn, float rOut, float frac, int segments)
{
	if (dy > 0)
		return 0;
	const float d2 = dx * dx + dy * dy;
	if (d2 < rIn * rIn || d2 > rOut * rOut)
		return 0;
	const float t = atan2f(-dy, -dx) / 3.14159265f; // 0 at the left end, 1 at the right
	const float s = t * segments;
	int seg = (int)s;
	if (seg >= segments)
		seg = segments - 1;
	const float in = s - seg;
	if (in < 0.14f || in > 0.86f)
		return 0; // the gap between two segments
	return (seg + 0.5f) / segments <= frac ? 2 : 1;
}

// The map's line fitted into a box: north up, the same scale both ways, in the middle.
struct MapFit
{
	bool valid;
	float scale;        // pixels to one of the line's units
	float minX, maxY;   // the line's west and north
	int left, top;      // where they are drawn
	int right, bottom;  // the box's far corner, for clamping
	int boxLeft, boxTop;
};

inline MapFit FitMap(const Pt* pts, int count, int boxX, int boxY, int boxW, int boxH)
{
	MapFit f = {false, 1, 0, 0, boxX, boxY, boxX + boxW - 1, boxY + boxH - 1, boxX, boxY};
	if (count < 2 || boxW < 2 || boxH < 2)
		return f;
	int minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
	for (int i = 1; i < count; i++)
	{
		minX = pts[i].x < minX ? pts[i].x : minX;
		maxX = pts[i].x > maxX ? pts[i].x : maxX;
		minY = pts[i].y < minY ? pts[i].y : minY;
		maxY = pts[i].y > maxY ? pts[i].y : maxY;
	}
	const float spanX = (float)(maxX - minX > 1 ? maxX - minX : 1);
	const float spanY = (float)(maxY - minY > 1 ? maxY - minY : 1);
	const float sx = (boxW - 1) / spanX, sy = (boxH - 1) / spanY;
	f.valid = true;
	f.scale = sx < sy ? sx : sy;
	f.minX = (float)minX;
	f.maxY = (float)maxY;
	f.left = boxX + (int)(((boxW - 1) - spanX * f.scale) * 0.5f + 0.5f);
	f.top = boxY + (int)(((boxH - 1) - spanY * f.scale) * 0.5f + 0.5f);
	return f;
}

// A point of the map in the box (one off the line's extent stays at the box's edge).
inline void MapPoint(const MapFit& f, float x, float y, int& px, int& py)
{
	px = ClampI(f.left + (int)floorf((x - f.minX) * f.scale + 0.5f), f.boxLeft, f.right);
	py = ClampI(f.top + (int)floorf((f.maxY - y) * f.scale + 0.5f), f.boxTop, f.bottom);
}

// The size of one unit of the layout, in pixels: by the screen's height, and less on a narrow screen so that it is never under 500
// units wide (the notes at the top's middle stand between the two top corners' pieces).
inline int PixelSize(int screenWidth, int screenHeight)
{
	const int byHeight = (screenHeight + 180) / 360, byWidth = screenWidth / 500;
	const int ps = byHeight < byWidth ? byHeight : byWidth;
	return ps < 1 ? 1 : ps;
}

// ---- the layout's sizes, to tune -------------------------------------------------------------------------------------------------------
// In units (a unit is PixelSize pixels: 2 at 1280x720) but for TOP_CLEAR. While racing the HUD is four small pieces in the screen's
// corners and nothing over the road; these say how small.
const int HUD_EDGE = 6;          // from the screen's sides to each corner's piece
const int MAP_SIZE = 50;         // the map's square, bottom left
const int MAP_EDGE = HUD_EDGE;
const int GAUGE_R = 27;          // the speed gauge's outer radius, bottom right
const int GAUGE_BAND = 4;        // and how thick its ring is
const int GAUGE_OFF_ALPHA = 150; // a segment of it that is not lit
const int LAMP_SIZE = 8;         // a start lamp, top centre
const int RESULTS_W = 230;       // the results' table
const int TOP_CLEAR = 28;        // pixels at the top right left to the game's own (TS's round timer at ScreenWidth - 72, 12; the fps counter)
const int EDGE_ALPHA = 235;      // the dark edge under everything that stands on the game's picture

inline bool MapShown(const Model& m)
{
	return m.linePoints >= 3 && m.linePoints >= m.lineTotal;
}

// The x of the map's right side, in pixels.
inline int MapRight(int screenWidth, int screenHeight)
{
	return (MAP_EDGE + MAP_SIZE) * PixelSize(screenWidth, screenHeight);
}

inline bool IsRacing(const Model& m, float now)
{
	return m.haveStat && now >= m.statAt - 0.5f && now - m.statAt < STAT_LIFE;
}

inline bool ResultsShown(const Model& m, float now)
{
	return m.rowTotal > 0 && m.rowCount >= m.rowTotal && now >= m.rowsAt - 0.5f && now - m.rowsAt < RESULTS_LIFE;
}

// ---- the dot font: 5 by 7, ' ' to '_' (small letters are drawn as capitals) --------------------------------------------------------

inline const unsigned char* Glyph(char ch)
{
	static const unsigned char font[64][7] = {
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, // space
		{0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04}, // !
		{0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00}, // "
		{0x0A, 0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x0A}, // #
		{0x04, 0x0F, 0x14, 0x0E, 0x05, 0x1E, 0x04}, // $
		{0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03}, // %
		{0x0C, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0D}, // &
		{0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00}, // '
		{0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02}, // (
		{0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08}, // )
		{0x00, 0x04, 0x15, 0x0E, 0x15, 0x04, 0x00}, // *
		{0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00}, // +
		{0x00, 0x00, 0x00, 0x00, 0x0C, 0x04, 0x08}, // ,
		{0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00}, // -
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C}, // .
		{0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00}, // /
		{0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}, // 0
		{0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E}, // 1
		{0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}, // 2
		{0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E}, // 3
		{0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}, // 4
		{0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E}, // 5
		{0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}, // 6
		{0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08}, // 7
		{0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}, // 8
		{0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C}, // 9
		{0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00}, // :
		{0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x04, 0x08}, // ;
		{0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02}, // <
		{0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00}, // =
		{0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08}, // >
		{0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04}, // ?
		{0x0E, 0x11, 0x01, 0x0D, 0x15, 0x15, 0x0E}, // @
		{0x0E, 0x11, 0x11, 0x11, 0x1F, 0x11, 0x11}, // A
		{0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E}, // B
		{0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E}, // C
		{0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C}, // D
		{0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F}, // E
		{0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10}, // F
		{0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F}, // G
		{0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11}, // H
		{0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E}, // I
		{0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C}, // J
		{0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11}, // K
		{0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F}, // L
		{0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11}, // M
		{0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11}, // N
		{0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E}, // O
		{0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10}, // P
		{0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D}, // Q
		{0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11}, // R
		{0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E}, // S
		{0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04}, // T
		{0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E}, // U
		{0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04}, // V
		{0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A}, // W
		{0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11}, // X
		{0x11, 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04}, // Y
		{0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F}, // Z
		{0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E}, // [
		{0x00, 0x10, 0x08, 0x04, 0x02, 0x01, 0x00}, // backslash
		{0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E}, // ]
		{0x04, 0x0A, 0x11, 0x00, 0x00, 0x00, 0x00}, // ^
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F}, // _
	};
	unsigned char c = (unsigned char)ch;
	if (c >= 'a' && c <= 'z')
		c = (unsigned char)(c - 'a' + 'A');
	if (c < 32 || c > 95)
		c = '?';
	return font[c - 32];
}

// A word's width in the dot font at `scale` pixels a dot.
inline int TextW(const char* s, int scale)
{
	const int n = (int)strlen(s);
	return n > 0 ? (n * 6 - 1) * scale : 0;
}

// The width of a string of the seven-segment display: digits `w` wide with `t` thick strokes; ':' and '.' are narrow.
inline int SegW(const char* s, int w, int t)
{
	const int gap = t + (t + 1) / 2;
	int x = 0;
	for (; *s; s++)
		x += ((*s == ':' || *s == '.') ? t : w) + gap;
	return x > 0 ? x - gap : 0;
}

// ---- the drawing --------------------------------------------------------------------------------------------------------------------

// ---- the drawing --------------------------------------------------------------------------------------------------------------------

struct Painter
{
	Canvas& cv;
	const Model& m;
	float now; // the client's time
	float sv;  // the server's
	int ps, W, H;
	int o;      // the dark edge's width, in pixels
	int drop;   // and how much wider it is below and to the right, as a shadow
	bool under; // drawing the dark edge: every rectangle is drawn dark and `o` larger on each side (Edged)
	int rects;

	Painter(Canvas& c, const Model& model, float clientTime)
		: cv(c), m(model), now(clientTime), sv(clientTime + model.clock), ps(PixelSize(c.Width(), c.Height())), W(c.Width()), H(c.Height()),
		  o((PixelSize(c.Width(), c.Height()) + 1) / 2), drop(PixelSize(c.Width(), c.Height()) / 2), under(false), rects(0)
	{
	}

	void Fill(int x, int y, int w, int h, const Col& c, int a)
	{
		if (w <= 0 || h <= 0 || a <= 0)
			return;
		if (a > 255)
			a = 255;
		if (under)
			cv.Fill(x - o, y - o, w + 2 * o + drop, h + 2 * o + drop, DARK.r, DARK.g, DARK.b, a * EDGE_ALPHA / 255);
		else
			cv.Fill(x, y, w, h, c.r, c.g, c.b, a);
		rects++;
	}

	// What `draw` draws, over its own dark edge: once dark and a little larger, then as it is. For everything that stands on the game's
	// picture with no panel behind it, so that it reads over snow and over night alike.
	template <class F>
	void Edged(F draw)
	{
		under = true;
		draw();
		under = false;
		draw();
	}

	// A word in the dot font, its top left at (x, y), `scale` pixels a dot. Stops before a letter that would cross maxX (0: no limit).
	// Returns the x after it.
	int Text(int x, int y, const char* s, int scale, const Col& c, int a = 255, int maxX = 0)
	{
		for (; *s; s++)
		{
			if (maxX > 0 && x + 5 * scale > maxX)
				break;
			const unsigned char* g = Glyph(*s);
			for (int row = 0; row < 7; row++)
			{
				const int bits = g[row];
				for (int col = 0; col < 5;)
				{
					if (!(bits & (0x10 >> col)))
					{
						col++;
						continue;
					}
					int run = 1;
					while (col + run < 5 && (bits & (0x10 >> (col + run))))
						run++;
					Fill(x + col * scale, y + row * scale, run * scale, scale, c, a);
					col += run;
				}
			}
			x += 6 * scale;
		}
		return x;
	}
	void TextCentre(int cx, int y, const char* s, int scale, const Col& c, int a = 255) { Text(cx - TextW(s, scale) / 2, y, s, scale, c, a); }
	void TextRight(int right, int y, const char* s, int scale, const Col& c, int a = 255) { Text(right - TextW(s, scale), y, s, scale, c, a); }

	// One figure of the seven-segment display in the box (x, y, w, h), strokes t thick. Only the lit strokes are drawn (a stroke that
	// is off, drawn faintly, is a dark blot on the game's picture). SEG_JOINED: the strokes meet at the corners, which reads better
	// small, and a 1 stands in the middle of its box. SEG_CUT: the strokes stop short of the corners.
	enum
	{
		SEG_JOINED = 0,
		SEG_CUT,
	};
	void SegDigit(int x, int y, int w, int h, int t, int mask, const Col& c, int a, int style)
	{
		const int hh = (h - 3 * t) / 2; // an upright stroke's length between two level ones
		const int midY = y + t + hh, lowY = y + 2 * t + hh;
		const int j = style == SEG_JOINED ? t : 0; // how far a stroke runs into the corners
		const int right = (style == SEG_JOINED && mask == 0x06) ? x + (w - t) / 2 : x + w - t;
		struct R
		{
			int x, y, w, h;
		};
		const R seg[7] = {
			{x + t - j, y, w - 2 * t + 2 * j, t},             // a: top
			{right, y + t - j, t, hh + 2 * j},                // b: upper right
			{right, lowY - j, t, hh + 2 * j},                 // c: lower right
			{x + t - j, lowY + hh, w - 2 * t + 2 * j, t},     // d: bottom
			{x, lowY - j, t, hh + 2 * j},                     // e: lower left
			{x, y + t - j, t, hh + 2 * j},                    // f: upper left
			{x + t - j, midY, w - 2 * t + 2 * j, t},          // g: middle
		};
		for (int i = 0; i < 7; i++)
			if (mask & (1 << i))
				Fill(seg[i].x, seg[i].y, seg[i].w, seg[i].h, c, a);
	}

	// A string of figures, ':', '.', '-', '+', '/' and spaces on the seven-segment display. Returns the x after it.
	int Seg(int x, int y, const char* s, int w, int h, int t, const Col& c, int a = 255, int style = SEG_JOINED)
	{
		static const unsigned char masks[10] = {0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};
		const int gap = t + (t + 1) / 2;
		const int hh = (h - 3 * t) / 2;
		const int full = 3 * t + 2 * hh; // the height really drawn
		for (; *s; s++)
		{
			const char ch = *s;
			if (ch >= '0' && ch <= '9')
				SegDigit(x, y, w, h, t, masks[ch - '0'], c, a, style);
			else if (ch == ':')
			{
				Fill(x, y + full / 3 - t / 2, t, t, c, a);
				Fill(x, y + full * 2 / 3 - t / 2, t, t, c, a);
			}
			else if (ch == '.')
				Fill(x, y + full - t, t, t, c, a);
			else if (ch == '-')
				SegDigit(x, y, w, h, t, 0x40, c, a, SEG_CUT);
			else if (ch == '+')
			{
				SegDigit(x, y, w, h, t, 0x40, c, a, SEG_CUT);
				Fill(x + (w - t) / 2, y + t + hh - (w - 2 * t - t) / 2, t, w - 2 * t, c, a);
			}
			else if (ch == '/')
			{
				const int steps = full / t > 0 ? full / t : 1;
				for (int i = 0; i < steps; i++)
					Fill(x + (w - t) * (steps - 1 - i) / (steps > 1 ? steps - 1 : 1), y + i * t, t, t, c, a);
			}
			x += ((ch == ':' || ch == '.') ? t : w) + gap;
		}
		return x - gap;
	}
	void SegRight(int right, int y, const char* s, int w, int h, int t, const Col& c, int a = 255) { Seg(right - SegW(s, w, t), y, s, w, h, t, c, a); }
	void SegCentre(int cx, int y, const char* s, int w, int h, int t, const Col& c, int a = 255, int style = SEG_JOINED) { Seg(cx - SegW(s, w, t) / 2, y, s, w, h, t, c, a, style); }

	// A panel: the dark box of the H9 windows with the rail along its top. Only the results have one.
	void Panel(int x, int y, int w, int h, int a = 255, int dark = 176)
	{
		Fill(x, y, w, h, DARK, dark * a / 255);
		Fill(x, y, w, ps, RAIL, 230 * a / 255);
		Fill(x, y + h - 1, w, 1, RAIL, 90 * a / 255);
	}

	// A disc, in rows.
	void Disc(int cx, int cy, int r, const Col& c, int a)
	{
		for (int dy = -r; dy <= r; dy++)
		{
			const int half = (int)sqrtf((float)(r * r - dy * dy) + 0.5f);
			Fill(cx - half, cy + dy, half * 2 + 1, 1, c, a);
		}
	}

	// A straight line `t` pixels thick, as runs of rectangles.
	void Line(int x0, int y0, int x1, int y1, int t, const Col& c, int a)
	{
		const int dx = x1 - x0, dy = y1 - y0;
		const int adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
		const int half = t / 2;
		if (adx >= ady)
		{
			// along x: one rectangle for each row the line stands on
			if (dx < 0)
			{
				Line(x1, y1, x0, y0, t, c, a);
				return;
			}
			int start = x0, row = y0;
			for (int x = x0; x <= x1; x++)
			{
				const int y = adx > 0 ? y0 + (dy * (x - x0) + (dy >= 0 ? adx / 2 : -adx / 2)) / adx : y0;
				if (y != row)
				{
					Fill(start - half, row - half, x - start + t - 1, t, c, a);
					start = x;
					row = y;
				}
			}
			Fill(start - half, row - half, x1 - start + t, t, c, a);
		}
		else
		{
			if (dy < 0)
			{
				Line(x1, y1, x0, y0, t, c, a);
				return;
			}
			int start = y0, colm = x0;
			for (int y = y0; y <= y1; y++)
			{
				const int x = x0 + (dx * (y - y0) + (dx >= 0 ? ady / 2 : -ady / 2)) / ady;
				if (x != colm)
				{
					Fill(colm - half, start - half, t, y - start + t - 1, c, a);
					start = y;
					colm = x;
				}
			}
			Fill(colm - half, start - half, t, y1 - start + t, c, a);
		}
	}

	bool DotsFresh() const { return m.haveDots && now - m.dotsAt <= DOTS_LIFE && now >= m.dotsAt - 0.5f; }

	// ---- the parts: four small pieces in the corners while racing, each on the game's picture with a dark edge and no panel, and
	// what comes and goes along the top's middle. Nothing stands over the road.

	// Top left: the lap, the place, and under them how far behind the first this racer is (or that he has finished, or is out).
	void Place()
	{
		if (m.state != RACE_RACING && m.state != RACE_FINISHED)
			return;
		const bool finished = (m.flags & RACE_SF_FINISHED) != 0, retired = (m.flags & RACE_SF_RETIRED) != 0;
		const int u = ps;
		const int x = HUD_EDGE * u, y = HUD_EDGE * u;
		char lap[8], laps[8], place[8], racers[8], third[24];
		snprintf(lap, sizeof(lap), "%d", ClampI(m.lap, 0, 99));
		snprintf(laps, sizeof(laps), "/%d", ClampI(m.laps, 0, 99));
		if (m.place > 0)
			snprintf(place, sizeof(place), "%d", ClampI(m.place, 0, 99));
		else
			snprintf(place, sizeof(place), "-");
		snprintf(racers, sizeof(racers), "/%d", ClampI(m.racers, 0, 99));
		Col thirdCol = DET;
		third[0] = 0;
		if (finished || retired)
		{
			snprintf(third, sizeof(third), "%s", finished ? "FINISHED" : "OUT OF TIME");
			thirdCol = finished ? OKC : BAD;
		}
		else if (m.place > 1 && DotsFresh())
		{
			for (int i = 0; i < m.dotCount; i++)
				if (m.dots[i].index == m.local && m.dots[i].gap >= 0)
					snprintf(third, sizeof(third), "+%dM", ClampI((int)(m.dots[i].gap * (float)RACE_HUD_GAP / METRE_UNITS + 0.5f), 0, 9999));
		}
		const Col placeCol = m.place == 1 ? WARN : TXT;
		Edged([&] {
			// a small word, a large number, and what it is out of small again, all standing on one line
			const int vx = x + 22 * u;
			Text(x, y + 7 * u, "LAP", u, DET);
			Text(Text(vx, y, lap, 2 * u, TXT), y + 7 * u, laps, u, DET);
			Text(x, y + 25 * u, "POS", u, DET);
			Text(Text(vx, y + 18 * u, place, 2 * u, placeCol), y + 25 * u, racers, u, DET);
			if (third[0])
				Text(x, y + 36 * u, third, u, thirdCol);
		});
	}

	// Top right: the clocks, a line each, their right sides in line.
	void Clocks()
	{
		if (m.state != RACE_RACING && m.state != RACE_FINISHED)
			return;
		const bool finished = (m.flags & RACE_SF_FINISHED) != 0, retired = (m.flags & RACE_SF_RETIRED) != 0;
		struct Entry
		{
			const char* label;
			char value[24];
			Col col;
		};
		Entry lines[5];
		int n = 0;
		auto add = [&](const char* label, int cs, bool none, const Col& col) {
			lines[n].label = label;
			if (none)
				snprintf(lines[n].value, sizeof(lines[n].value), "-:--.--");
			else
				FormatTime(lines[n].value, sizeof(lines[n].value), cs);
			lines[n].col = col;
			n++;
		};
		add("TIME", finished ? m.totalCs : RunningCs(sv, m.raceStart), false, TXT);
		if (!finished && !retired)
			add("LAP", RunningCs(sv, m.lapStart), false, TXT);
		add("BEST", m.bestCs, m.bestCs <= 0, LIT);
		if (!finished && !retired && m.limitEnd > 0)
		{
			const int left = RunningCs(m.limitEnd, sv);
			add("LEFT", left, false, left < 1000 ? BAD : WARN);
		}
		if (!finished && !retired && m.state == RACE_FINISHED && m.t0 > 0)
			add("ENDS", RunningCs(m.t0, sv), false, WARN);

		const int u = ps;
		const int right = W - HUD_EDGE * u;
		const int top = TOP_CLEAR + 2 * u > HUD_EDGE * u ? TOP_CLEAR + 2 * u : HUD_EDGE * u;
		// in the dot font, not the seven-segment figures: strokes this thin are only their own dark edge over snow
		int widest = 0;
		for (int i = 0; i < n; i++)
		{
			const int w = TextW(lines[i].value, u);
			widest = w > widest ? w : widest;
		}
		Edged([&] {
			for (int i = 0; i < n; i++)
			{
				const int ry = top + i * 10 * u;
				TextRight(right - widest - 5 * u, ry, lines[i].label, u, DET);
				TextRight(right, ry, lines[i].value, u, lines[i].col);
			}
		});
	}

	// Bottom right: the speed, under a small gauge.
	void Speed()
	{
		const int u = ps;
		const int r = GAUGE_R * u;
		const int cx = W - HUD_EDGE * u - r;
		const int labelY = H - HUD_EDGE * u - 7 * u;
		const int cy = labelY - 2 * u; // the gauge's foot
		const float rOut = (float)r, rIn = (float)(r - GAUGE_BAND * u);
		const float top = m.topSpeed > 100 ? m.topSpeed : TOP_SPEED;
		const float frac = ClampF(fabsf(m.gauge) / top, 0, 1);
		const Col lit = SlipColour(m.slip);
		const int segments = 16;
		char text[16];
		snprintf(text, sizeof(text), "%d", ClampI(SpeedShown(m.speed, m.speedUnits, m.speedFloor), 0, 999));
		const bool back = m.speed < -20;
		Edged([&] {
			for (int dy = -r; dy <= 0; dy++)
			{
				int runStart = 0, runKind = 0;
				for (int dx = -r; dx <= r + 1; dx++)
				{
					const int kind = dx <= r ? ArcCell((float)dx, (float)dy, rIn, rOut, frac, segments) : 0;
					if (kind == runKind)
						continue;
					if (runKind == 2)
						Fill(cx + runStart, cy + dy, dx - runStart, 1, lit, 255);
					else if (runKind == 1)
						Fill(cx + runStart, cy + dy, dx - runStart, 1, RAIL, under ? 255 : GAUGE_OFF_ALPHA);
					runStart = dx;
					runKind = kind;
				}
			}
			SegCentre(cx, cy - 14 * u, text, 8 * u, 14 * u, 2 * u, TXT);
			TextCentre(cx, labelY, back ? "REVERSE" : "KM/H", u, back ? WARN : DET);
			// the slip, also as a mark at each end of the gauge's foot
			if (m.slip > 0.15f)
			{
				Fill(cx - r, cy + 3 * u, 3 * u, 2 * u, lit, 255);
				Fill(cx + r - 3 * u, cy + 3 * u, 3 * u, 2 * u, lit, 255);
			}
		});
	}

	// Bottom left: the lap's line from above, the checkpoints, the racers. The line alone, with its dark edge.
	void Minimap()
	{
		if (!MapShown(m))
			return;
		const int u = ps;
		const int size = MAP_SIZE * u;
		const int x = MAP_EDGE * u, y = H - MAP_EDGE * u - size;
		const int pad = 3 * u; // room for a dot that stands on the line's outermost point
		const MapFit f = FitMap(m.line, m.linePoints, x + pad, y + pad, size - 2 * pad, size - 2 * pad);
		if (!f.valid)
			return;
		const int t = u < 2 ? 2 : u;
		Edged([&] {
			int px0, py0;
			MapPoint(f, m.line[m.linePoints - 1].x, m.line[m.linePoints - 1].y, px0, py0);
			for (int i = 0; i < m.linePoints; i++)
			{
				int px, py;
				MapPoint(f, m.line[i].x, m.line[i].y, px, py);
				Line(px0, py0, px, py, t, TXT, 255);
				px0 = px;
				py0 = py;
			}
		});
		// the checkpoints: a tick each; the start and finish line a white square with a dark middle
		for (int i = m.cpPoints - 1; i >= 0; i--)
		{
			int px, py;
			MapPoint(f, m.cps[i].x, m.cps[i].y, px, py);
			if (i == 0)
			{
				const int s = 2 * u;
				Fill(px - s - o, py - s - o, 2 * (s + o) + 1, 2 * (s + o) + 1, DARK, 255);
				Fill(px - s, py - s, 2 * s + 1, 2 * s + 1, TXT, 255);
				Fill(px - s + u, py - s + u, 2 * (s - u) + 1, 2 * (s - u) + 1, DARK, 255);
			}
			else
				Fill(px - u, py - u, 2 * u + 1, 2 * u + 1, LIT, 255);
		}
		if (!DotsFresh())
			return;
		// the others, then the first, then the player
		for (int pass = 0; pass < 3; pass++)
		{
			for (int i = 0; i < m.dotCount; i++)
			{
				const Dot& d = m.dots[i];
				const bool own = d.index == m.local;
				const bool first = d.place == 1 && !own;
				if ((pass == 2) != own || (!own && (pass == 1) != first))
					continue;
				int px, py;
				MapPoint(f, d.x, d.y, px, py);
				const int r = own ? 2 * u : u + u / 2;
				Disc(px, py, r + o, DARK, 255);
				Disc(px, py, r, own ? OKC : (first ? WARN : TXT), d.finished || d.retired ? 130 : 255);
			}
		}
	}

	// Top centre: the warm-up's seconds, the start lights, the countdown, GO.
	void StartLights()
	{
		if (!m.haveState)
			return;
		const int u = ps;
		const int cx = W / 2, y = HUD_EDGE * u;
		if (m.state == RACE_WAITING)
		{
			if (m.t0 <= 0)
				return;
			const int left = (int)ceilf(m.t0 - sv);
			if (left <= 0 || left > 999)
				return;
			char text[40];
			snprintf(text, sizeof(text), "RACE STARTS IN %d", left);
			Edged([&] { TextCentre(cx, y, text, u, WARN); });
			return;
		}
		const Lamps l = LampState(m.state, m.t0 - sv, m.countdown, sv - m.t0);
		if (!l.show)
			return;
		const int lamp = LAMP_SIZE * u, gap = 3 * u;
		const int x = cx - (5 * lamp + 4 * gap) / 2;
		const int lowY = y + lamp + 3 * u; // where the number and GO stand
		char text[8];
		snprintf(text, sizeof(text), "%d", ClampI(l.number, 0, 99));
		Edged([&] {
			for (int i = 0; i < 5; i++)
			{
				const bool on = l.green || i < l.reds;
				Disc(x + i * (lamp + gap) + lamp / 2, y + lamp / 2, lamp / 2, l.green ? LAMP_GREEN : (on ? LAMP_RED : LAMP_OFF), 255);
			}
			if (l.green)
				TextCentre(cx, lowY, "GO!", 3 * u, LAMP_GREEN);
			else
				SegCentre(cx, lowY, text, 12 * u, 20 * u, 3 * u, LAMP_RED);
		});
	}

	// Top centre, where the lights were: wrong way, and under it the last note (a split, a lap, the finish, out of time), a line of
	// small words and a line with the time.
	void Notes()
	{
		const int u = ps;
		const int cx = W / 2;
		const bool wrong = (m.flags & RACE_SF_WRONGWAY) != 0;
		// under GO while that is up (a note in the race's first second and a half)
		const bool lamps = m.haveState && LampState(m.state, m.t0 - sv, m.countdown, sv - m.t0).show;
		const int top = (lamps ? HUD_EDGE + LAMP_SIZE + 3 + 21 + 3 : HUD_EDGE) * u;
		if (wrong && fmodf(now, 0.6f) < 0.4f)
			Edged([&] { TextCentre(cx, top, "WRONG WAY", 2 * u, BAD); });
		if (m.noteKind == 0 || now < m.noteAt - 0.5f)
			return;
		const float life = m.noteKind == RACE_NOTE_FINISH ? 5.0f : (m.noteKind == RACE_NOTE_OUTOFTIME ? 4.0f : 3.0f);
		const float age = now - m.noteAt;
		if (age >= life)
			return;
		const int a = (int)(255 * ClampF((life - age) / NOTE_FADE, 0, 1));
		const int y = top + (wrong ? 17 : 11) * u; // under the lights' place, and under "wrong way" when that is up
		const int dw = 8 * u, dh = 13 * u, dt = 2 * u;
		char text[48], value[24], beside[24];
		Col besideCol = TXT;
		beside[0] = 0;
		switch (m.noteKind)
		{
		case RACE_NOTE_CHECKPOINT:
		case RACE_NOTE_LAP:
		{
			const bool lap = m.noteKind == RACE_NOTE_LAP;
			const bool diff = (m.noteFlags & RACE_NF_DIFF) != 0, best = lap && (m.noteFlags & RACE_NF_BEST) != 0;
			if (lap)
				snprintf(text, sizeof(text), best ? "LAP %d/%d - BEST LAP" : "LAP %d/%d", m.noteA, m.noteB);
			else
				snprintf(text, sizeof(text), "CHECKPOINT %d/%d", m.noteA, m.noteB);
			FormatTime(value, sizeof(value), m.noteTime);
			if (diff)
			{
				FormatDiff(beside, sizeof(beside), m.noteDiff);
				besideCol = m.noteDiff <= 0 ? OKC : BAD;
			}
			const int tw = SegW(value, dw, dt), bw = TextW(beside, 2 * u);
			const int x = cx - (tw + (bw ? 10 * u + bw : 0)) / 2;
			Edged([&] {
				TextCentre(cx, y, text, u, best ? LIT : DET, a);
				// the time, and beside it what it is against the best
				Seg(x, y + 10 * u, value, dw, dh, dt, TXT, a);
				if (bw)
					Text(x + tw + 10 * u, y + 10 * u, beside, 2 * u, besideCol, a);
			});
			break;
		}
		case RACE_NOTE_FINISH:
		{
			Ordinal(beside, sizeof(beside), m.noteA);
			FormatTime(value, sizeof(value), m.noteTime);
			const int tw = SegW(value, dw, dt), bw = TextW(beside, 2 * u);
			const int x = cx - (bw + 10 * u + tw) / 2;
			Edged([&] {
				TextCentre(cx, y, "FINISHED", u, OKC, a);
				Text(x, y + 10 * u, beside, 2 * u, m.noteA == 1 ? WARN : TXT, a);
				Seg(x + bw + 10 * u, y + 10 * u, value, dw, dh, dt, TXT, a);
			});
			break;
		}
		case RACE_NOTE_OUTOFTIME:
			Edged([&] { TextCentre(cx, y, "OUT OF TIME", 2 * u, BAD, a); });
			break;
		default:
			break;
		}
	}

	// The middle of the screen: the results, and nothing else while they are up (the race is over; there is no road to see).
	void Results()
	{
		const int u = ps;
		int n = m.rowCount < TABLE_ROWS ? m.rowCount : TABLE_ROWS;
		int own = -1;
		for (int i = 0; i < m.rowCount; i++)
			if (m.rows[i].index == m.local)
				own = i;
		const int w = RESULTS_W * u < W - 16 * u ? RESULTS_W * u : W - 16 * u;
		const int rowH = 11 * u;
		const int h = 43 * u + n * rowH;
		const int x = (W - w) / 2;
		int y = (H - h) / 2 - 10 * u;
		if (y < 8 * u)
			y = 8 * u;
		Panel(x, y, w, h, 255, 225);
		TextCentre(W / 2, y + 7 * u, "RACE RESULTS", 2 * u, LIT);
		const int cPlace = x + 25 * u, cName = x + 32 * u, cBest = x + w - 7 * u, cTime = cBest - 54 * u;
		const int hy = y + 26 * u;
		TextRight(cPlace, hy, "POS", u, DET);
		Text(cName, hy, "DRIVER", u, DET);
		TextRight(cTime, hy, "TIME", u, DET);
		TextRight(cBest, hy, "BEST LAP", u, DET);
		Fill(x + 5 * u, hy + 9 * u, w - 10 * u, 1, RAIL, 200);
		int ry = hy + 13 * u;
		for (int row = 0; row < n; row++)
		{
			const Row& r = m.rows[(row == n - 1 && own >= n) ? own : row];
			const bool mine = r.index == m.local;
			if (mine)
			{
				Fill(x + 3 * u, ry - u, w - 6 * u, rowH, LIT, 46);
				Fill(x + 3 * u, ry - u, 2 * u, rowH, LIT, 255);
			}
			char text[32];
			snprintf(text, sizeof(text), "%d", r.place);
			TextRight(cPlace, ry + u, text, u, r.place == 1 ? WARN : TXT);
			const bool finished = (r.flags & RACE_RF_FINISHED) != 0;
			const int st = u;
			int nameEnd;
			if (finished)
			{
				FormatTime(text, sizeof(text), r.total);
				SegRight(cTime, ry, text, 6 * u, 9 * u, st, r.place == 1 ? WARN : TXT);
				nameEnd = cTime - SegW(text, 6 * u, st) - 4 * u;
			}
			else
			{
				char lap[24];
				snprintf(lap, sizeof(lap), "%s  LAP %d/%d", (r.flags & RACE_RF_RETIRED) ? "OUT" : "DNF", r.lap, m.rowLaps);
				TextRight(cTime, ry + u, lap, u, BAD);
				nameEnd = cTime - TextW(lap, u) - 4 * u;
			}
			Text(cName, ry + u, r.name[0] ? r.name : "?", u, mine ? TXT : DET, 255, nameEnd);
			if (r.best > 0)
			{
				FormatTime(text, sizeof(text), r.best);
				SegRight(cBest, ry, text, 6 * u, 9 * u, st, LIT);
			}
			else
				SegRight(cBest, ry, "-:--.--", 6 * u, 9 * u, st, RAIL);
			ry += rowH;
		}
	}

	void Paint()
	{
		if (ResultsShown(m, now))
		{
			Results();
			return;
		}
		StartLights();
		if (!IsRacing(m, now))
			return;
		Place();
		Clocks();
		Minimap();
		Speed();
		Notes();
	}
};
} // namespace racehud
