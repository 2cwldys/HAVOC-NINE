// ---- H9 rally HUD: HL Rally's own layout, over h9_racehud_draw.h's canvas -------------------------------------------------------------
// While the local player is a rally car the HUD is HL Rally's (cl_dll/rallyhud.cpp, tri.cpp, rally_hud_radar.cpp and rally_vguifx.cpp of the
// HL Rally 1.1 source, read for behaviour and numbers only): the same elements, in the same places, in the same pixels. HL Rally lays the
// HUD out in plain pixels from the screen's edges (never scaled; it was made for 640x480 and up): the lap and the checkpoint counter from
// the top left, the place from the top's middle (minus 24), the three clocks from the top right (ScreenWidth - 176), the dial, the speed, the
// gear and the rev needle from the bottom right, the time left from the bottom left, the map from the bottom left (ScreenHeight - 173).
// At 16:9 every element keeps its offset from its own edge, as HL Rally's arithmetic with ScreenWidth and ScreenHeight does; only the
// middle (the place) moves with the width.
//
// The art is HL Rally's sprites; ours are not in the repository. What can be drawn with the numbers and letters this HUD already has is drawn
// (the digits are the seven-segment ones on HL Rally's 16 pixel cells, the words the dot font); the dials, the needle and the map are
// sprites that the game draws when the file is there (h9_rallyhud.cpp) and this file only lays out.
//
// No engine here: the test (tests/racehud_test.cpp) checks every number below against the HL Rally line it cites.
#pragma once

#include "h9_racehud_draw.h"

namespace racehud
{
// ---- HL Rally's colours (rallyhud.cpp) ---------------------------------------------------------------------------------------------------
const Col RH_ORANGE = {255, 75, 14};   // rallyhud.cpp:984 r = 255; g = 75; b = 14 (speed, gear, checkpoints, clocks)
const Col RH_WHITE = {255, 255, 255};  // :991 lap, :1068 place
const Col RH_GREY = {128, 128, 128};   // :1125 the finished lap's time, blinking
const Col RH_RED = {255, 0, 0};        // :1151 the time left
const Col RH_RADAR_OTHER = {255, 0, 0};  // rally_hud_radar.cpp:260 Color4f(1, 0, 0, 1)
const Col RH_RADAR_SELF = {0, 229, 0};   // :323 Color4f(0, 0.9, 0, 1)

const int RH_CELL = 16; // every number's step: the width of sprite number_0 (hud.txt: 16 x 19), lgnumber_0 is 16 x 37

// ---- DrawHudNumber2 (hud_redraw.cpp:327-410) --------------------------------------------------------------------------------------------
enum
{
	RH_DRAWZERO = 1,
	RH_2DIGITS = 2,
	RH_3DIGITS = 4,
};

// The cells it draws, left to right: a digit, or ' ' where it steps over a blank. A number that is not above 0 draws nothing unless DRAWZERO
// (then a 0 in its last cell). Returns the number of cells; `out` holds 8.
inline int NumberCells(int n, int flags, char* out)
{
	int c = 0;
	if (n > 0)
	{
		if (n >= 10000)
			out[c++] = (char)('0' + (n / 10000) % 10);
		if (n >= 1000)
			out[c++] = (char)('0' + (n / 1000) % 10);
		if (n >= 100)
			out[c++] = (char)('0' + (n / 100) % 10);
		else if (flags & RH_3DIGITS)
			out[c++] = ' ';
		if (n >= 10)
			out[c++] = (char)('0' + (n % 100) / 10);
		else if (flags & (RH_3DIGITS | RH_2DIGITS))
			out[c++] = ' ';
		out[c++] = (char)('0' + n % 10);
	}
	else if (flags & RH_DRAWZERO)
	{
		if (flags & RH_3DIGITS)
			out[c++] = ' ';
		if (flags & (RH_3DIGITS | RH_2DIGITS))
			out[c++] = ' ';
		out[c++] = '0';
	}
	out[c] = 0;
	return c;
}

// ---- the speed (rallyhud.cpp:961-987) ------------------------------------------------------------------------------------------------------
// Length(pmove->velocity) / 3, 0 under 9, into an int: truncated, never negative, no word for reverse.
inline int RallySpeedShown(float speed3d)
{
	float s = speed3d / 3.0f;
	if (s < 9)
		s = 0;
	return ClampI((int)s, 0, 999);
}

// ---- DrawTime (rallyhud.cpp:603-691) ---------------------------------------------------------------------------------------------------------
struct TimeParts
{
	bool none; // -1: "--:--:--"
	int min, sec, ms;
};

// DrawTime (float time, ...): -1 is "none"; else minutes, seconds, and the hundredths as the float is cut (t_Ms is an int).
inline TimeParts TimeOf(float time)
{
	TimeParts t = {false, 0, 0, 0};
	if (time == -1)
	{
		t.none = true;
		return t;
	}
	t.ms = (int)((time - (int)time) * 100);
	t.sec = ((int)time) % 60;
	t.min = ((int)time) / 60;
	return t;
}

// The same from hundredths, exact (a time the server measured: best lap, a lap's time).
inline TimeParts TimeOfCs(int cs)
{
	TimeParts t = {false, 0, 0, 0};
	if (cs < 0)
	{
		t.none = true;
		return t;
	}
	t.min = cs / 6000;
	t.sec = (cs / 100) % 60;
	t.ms = cs % 100;
	return t;
}

// The eight cells DrawTime draws, 16 pixels apart from x: minutes (two cells, DHN_2DIGITS: under ten the tens is BLANK, not 0), a colon,
// seconds (two cells, a 0 appended to the tens under ten), a colon, hundredths (the same). With no time: blank, '-', ':', '-', '-', ':', '-', '-'
// (the hyphens stand at x + 16, 48, 64, 96, 112; rallyhud.cpp:640-669).
inline void TimeCells(const TimeParts& t, char* out)
{
	if (t.none)
	{
		memcpy(out, " -:--:--", 9);
		return;
	}
	char c[8];
	NumberCells(t.min % 100, RH_2DIGITS | RH_DRAWZERO, c);
	out[0] = c[0];
	out[1] = c[1];
	out[2] = ':';
	NumberCells(t.sec, RH_2DIGITS | RH_DRAWZERO, c);
	out[3] = t.sec < 10 ? '0' : c[0];
	out[4] = c[1];
	out[5] = ':';
	NumberCells(t.ms, RH_2DIGITS | RH_DRAWZERO, c);
	out[6] = t.ms < 10 ? '0' : c[0];
	out[7] = c[1];
	out[8] = 0;
}

// The last lap's time stays 4 s from its lap's start, blinking (rallyhud.cpp:1117-1126): drawn grey while frac < 0.4 or frac > 0.8 of the
// second, off between.
inline bool LastLapShown(float sinceLapStart, int lastLapCs)
{
	return sinceLapStart < 4 && lastLapCs >= 0;
}
inline bool LastLapLit(float flTime)
{
	const float frac = flTime - (int)flTime;
	return frac < 0.4 || frac > 0.8;
}

// ---- the place (rallyhud.cpp:1057-1095) ------------------------------------------------------------------------------------------------------
struct PlaceDraw
{
	int cells;       // 1 or 2 digits
	char digit[2];
	int x;           // the first digit's x
	int suffixX;
	int suffix;      // 0 st, 1 nd, 2 rd, 3 th
};

inline PlaceDraw PlaceLayout(int screenWidth, int place)
{
	PlaceDraw p = {1, {'0', '0'}, 0, 0, 3};
	place = ClampI(place, 0, 99);
	const int tens = place / 10, leftover = place % 10;
	if (place < 10)
	{
		p.x = screenWidth / 2 - 24;
		p.digit[0] = (char)('0' + place);
		p.suffixX = p.x + 16;
	}
	else
	{
		p.cells = 2;
		p.x = screenWidth / 2 - 32;
		p.digit[0] = (char)('0' + tens);
		p.digit[1] = (char)('0' + leftover);
		p.suffixX = p.x + 32;
	}
	// :1080 `(leftover > 0) && (leftover < 4) && (tens != 1)`
	p.suffix = (leftover > 0 && leftover < 4 && tens != 1) ? leftover - 1 : 3;
	return p;
}

// ---- the checkpoint counter [n/m] (rallyhud.cpp:1030-1055) -----------------------------------------------------------------------------------
struct CpDraw
{
	int leftX, curX, slashX, totalX, rightX;
	int curCells; // 2 from 10
};

inline CpDraw CpLayout(int cur, int total)
{
	CpDraw d = {16, 0, 0, 0, 0, 1};
	int x = 16 + 8;
	d.curX = x;
	if (cur >= 10)
	{
		d.curCells = 2;
		x += RH_CELL * 2;
	}
	else
		x += RH_CELL;
	d.slashX = x;
	x += RH_CELL;
	d.totalX = x;
	x += total >= 10 ? RH_CELL * 2 : RH_CELL;
	d.rightX = x;
	return d;
}

// ---- the rev needle (tri.cpp:96-140) ---------------------------------------------------------------------------------------------------------
// A square of 150 (the needle's half-diagonal is hyp = 75 * sqrt 2) about (W - 78, H - 79), turned so that at rpm 45 it stands as the
// picture is; corners in the order bottom left, top left, top right, bottom right (texture 0,1 0,0 1,0 1,1).
inline void NeedleQuad(int screenWidth, int screenHeight, float rpm, float out[4][2])
{
	const float D = 0.0174532f; // tri.cpp's D
	const float cx = (float)(screenWidth - 78), cy = (float)(screenHeight - 79);
	const float needle = 75.0f;
	const float hyp = sqrtf(needle * needle + needle * needle);
	const float ofsX = sinf(rpm * D) * hyp, ofsY = cosf(rpm * D) * hyp;
	out[0][0] = cx - ofsX;
	out[0][1] = cy + ofsY;
	out[1][0] = cx - ofsY;
	out[1][1] = cy - ofsX;
	out[2][0] = cx + ofsX;
	out[2][1] = cy - ofsY;
	out[3][0] = cx + ofsY;
	out[3][1] = cy + ofsX;
}

// ---- the map and the radar (rally_hud_radar.cpp) -----------------------------------------------------------------------------------------------
// The map's picture is 128 x 128 at (20, H - 173); a car is a 8 x 8 square at (pos/2 + 22, (H - 45) - pos/2) where pos is a byte, the world
// coordinate / 32 + 128 (player.cpp:2591-2592 on the server).
inline int RadarMapX() { return 20; }
inline int RadarMapY(int screenHeight) { return screenHeight - 173; }

// Our racers' coordinates come divided by RACE_HUD_COORD; the byte as HL Rally's server writes it: int(origin / 32) + 128, as a byte (it wraps).
inline int RadarByte(int sentCoord)
{
	return ((int)((float)(sentCoord * RACE_HUD_COORD) / 32.0f) + 128) & 255;
}

// CHudRadar::Draw :190-205: moved a seventh of the way each frame; a car at byte (0, 0) is not drawn.
inline float RadarSmooth(float held, int target)
{
	return ((held * 6) + target) / 7;
}

inline void RadarOther(int screenHeight, float px, float py, int& x, int& y)
{
	x = (int)(px / 2 + 22);
	y = (int)((screenHeight - 45) + (py / -2));
}

// The player: thisplayerx = (pmove->origin[0] / 32) + 128 (an int), x = thisplayerx/2 + 22 (:314-319).
inline void RadarSelf(int screenHeight, float originX, float originY, int& x, int& y)
{
	const int tx = (int)(originX / 32) + 128, ty = (int)(originY / 32) + 128;
	x = tx / 2 + 22;
	y = (screenHeight - 45) + (ty / -2);
}

// ---- the countdown's numerals (rally_vguifx.cpp:612-662, 683-775; anim.txt [Numbers]) --------------------------------------------------------
// Four models, one after another at 0, 1, 2 and 3 s from the countdown's start: three, two, one, go. Each is put where the view looks
// (90 ahead, 5 up) and tumbles in over 0.6 s (a path of four nodes, positions times 4, angles interpolated the short way) and then stays until
// it has lived a second, lit by a white light of radius 40.
struct CountNode
{
	float pos[3]; // right, up, forward (before the scale)
	float ang[3];
	float time;
};
const CountNode COUNT_NODES[4] = {
	{{0, 20, 15}, {0, 0, 0}, 0.0f},
	{{0, 3, -5}, {-180, -180, -180}, 0.2f},
	{{0, 10, -10}, {-90, 0, -90}, 0.4f},
	{{0, 1, -15}, {0, 180, 0}, 0.6f},
};
const float COUNT_AHEAD = 90.0f;  // Origin=90, 5, 0 (forward, up, right)
const float COUNT_UP = 5.0f;
const float COUNT_RIGHT = 0.0f;
const float COUNT_SCALE = 4.0f;   // Scale=4.0
const float COUNT_LENGTH = 1.0f;  // Length=1.0: how long a numeral lives
const float COUNT_LIGHT = 40.0f;  // dl->radius = 40 (white, 0.1 s)
const float COUNT_SPAN = 4.0f;    // DoCountdown gives up 4 s after the start
const int COUNT_MODELS = 4;

inline const char* CountModelName(int n) // n 1..4
{
	static const char* const names[COUNT_MODELS] = {"three", "two", "one", "go"};
	return (n >= 1 && n <= COUNT_MODELS) ? names[n - 1] : "";
}

struct CountSeq
{
	float start;
	int done;
};

// One call of DoCountdown: the number (1..4) of the model to make now, or 0. `done` counts the models made; one at most each call
// (rally_vguifx.cpp:616-627): the clock is read against `done`, so the first comes at 0 s, the second at 1 s, the third at 2 s, GO at 3 s.
inline int CountNext(CountSeq& s, float now)
{
	if (s.start + COUNT_SPAN < now || s.done == COUNT_MODELS)
		return 0;
	if (now - s.start < (float)s.done)
		return 0;
	s.done++;
	return s.done;
}

inline void CountVectors(const float ang[3], float fwd[3], float right[3], float up[3])
{
	const float d2r = 3.14159265358979f / 180.0f;
	const float sp = sinf(ang[0] * d2r), cp = cosf(ang[0] * d2r), sy = sinf(ang[1] * d2r), cy = cosf(ang[1] * d2r);
	fwd[0] = cp * cy;
	fwd[1] = cp * sy;
	fwd[2] = -sp;
	right[0] = sy;
	right[1] = -cy;
	right[2] = 0;
	up[0] = sp * cy;
	up[1] = sp * sy;
	up[2] = cp;
}

// Where a numeral starts: the view origin, 90 ahead, 5 up (rally_vguifx.cpp:974-975).
inline void CountStart(const float viewOrg[3], const float viewAng[3], float out[3])
{
	float f[3], r[3], u[3];
	const float a[3] = {viewAng[0], viewAng[1], 0};
	CountVectors(a, f, r, u);
	for (int i = 0; i < 3; i++)
		out[i] = viewOrg[i] + f[i] * COUNT_AHEAD + u[i] * COUNT_UP + r[i] * COUNT_RIGHT;
}

inline float CountNormal(float a)
{
	return a > 180.0f ? a - 360.0f : (a < -180.0f ? a + 360.0f : a);
}

// EV_CustomAnimCallback (:683-775): the numeral's origin and angles `elapsed` seconds in, for the start it was made at and the view now.
inline void CountPose(float elapsed, const float startOrg[3], const float startAng[3], const float viewAng[3], float outOrg[3], float outAng[3])
{
	float f[3], r[3], u[3];
	const float a[3] = {viewAng[0], viewAng[1], 0};
	CountVectors(a, f, r, u);
	int i = 0;
	for (; i < COUNT_MODELS; i++)
		if (elapsed < COUNT_NODES[i].time)
			break;
	float org[2][3], ang[2][3];
	auto at = [&](int node, float* o, float* g) {
		const CountNode& n = COUNT_NODES[node];
		for (int k = 0; k < 3; k++)
		{
			o[k] = startOrg[k] + r[k] * (n.pos[0] * COUNT_SCALE) + u[k] * (n.pos[1] * COUNT_SCALE) + f[k] * (n.pos[2] * COUNT_SCALE);
			g[k] = startAng[k] + n.ang[k];
		}
	};
	if (i == COUNT_MODELS) // the end of the path: stays on its last node
	{
		at(COUNT_MODELS - 1, outOrg, outAng);
		return;
	}
	at(i, org[1], ang[1]);
	if (i == 0)
	{
		memcpy(outOrg, org[1], sizeof(float) * 3);
		memcpy(outAng, ang[1], sizeof(float) * 3);
		return;
	}
	at(i - 1, org[0], ang[0]);
	const float frac = (elapsed - COUNT_NODES[i - 1].time) / (COUNT_NODES[i].time - COUNT_NODES[i - 1].time);
	for (int k = 0; k < 3; k++)
	{
		outOrg[k] = org[0][k] + (org[1][k] - org[0][k]) * frac; // InterpolateVec
		// InterpolateAngles (PM_Math.c): both normalised once, the difference taken the short way, the result normalised
		const float a1 = CountNormal(ang[0][k]), a2 = CountNormal(ang[1][k]);
		float d = a2 - a1;
		if (d > 180)
			d -= 360;
		else if (d < -180)
			d += 360;
		outAng[k] = CountNormal(a1 + d * frac);
	}
}

// ---- what the rally HUD holds over the race model --------------------------------------------------------------------------------------------
struct RallyModel
{
	// each frame, from the car (h9_racehud.cpp)
	bool third = false;      // cam_thirdperson: the chase, bonnet and side views, not the interior
	float speed3d = 0;       // Length(pmove->velocity)
	int gear = 0;            // 0 N, 1..6 (the automatic box)
	bool reversing = false;  // g_reversing (input.cpp:869-875, 942-945)
	bool haveOrg = false;
	float org[3] = {0, 0, 0};
	bool mapSprite = false;  // sprites/h9/rally/maps/<map>.spr is there: the map is its picture and the radar's squares
	// kept
	int cpCur = 1;           // CurrentCheckpoint: 1 at a lap's start, +1 for each checkpoint (rallyhud.cpp:377, 421-425)
	int cpTotalNote = 0;     // TotalCheckpoints as the last checkpoint note gave it (its b + 1), until the line's own count is here
	int lastLapCs = -1;      // fLastLap: the lap just closed, -1 before one
	float radarX[MAX_DOTS] = {0}, radarY[MAX_DOTS] = {0}; // g_fPosx, g_fPosy
};

// g_reversing for the HUD from the keys and the speed (input.cpp:869-875: the back key under 40 u/s with the forward key up; :942-945 set only
// on the ground, so in the air it stays as it was).
inline bool RallyReversing(bool held, bool onGround, bool throttle, bool brake, float speed2d)
{
	if (!onGround)
		return held;
	return brake && !throttle && speed2d < 40.0f;
}

// ---- the layout (rallyhud.cpp, tri.cpp, rally_hud_radar.cpp) ---------------------------------------------------------------------------------
struct RallyLayout
{
	int dialsX, dialsY;   // :974-975 (W - 224, H - 232), 225 x 233
	int speedX, speedY;   // :980-981 (W - 52, H - 32)
	int gearX, gearY;     // :1182-1183 (W - 152, H - 32)
	int needleX, needleY; // tri.cpp:113-114 centre (W - 78, H - 79)
	int timeX;            // :1098 W - 176
	int totalY, totalLabelY, lapY, lapLabelY, bestY, bestLabelY; // 36 / 16, 80 / 60, 124 / 104
	int leftX, leftY;     // :1158 the time left (8, H - 32)
	int mapX, mapY;       // rally_hud_radar.cpp:152-153 (20, H - 173)
};

inline RallyLayout RallyLayoutFor(int W, int H)
{
	RallyLayout l;
	l.dialsX = W - 224;
	l.dialsY = H - 232;
	l.speedX = W - 52;
	l.speedY = H - 32;
	l.gearX = W - 152;
	l.gearY = H - 32;
	l.needleX = W - 78;
	l.needleY = H - 79;
	l.timeX = W - 176;
	l.totalLabelY = 16;
	l.totalY = 36;
	l.lapLabelY = 60;
	l.lapY = 80;
	l.bestLabelY = 104;
	l.bestY = 124;
	l.leftX = 8;
	l.leftY = H - 32;
	l.mapX = RadarMapX();
	l.mapY = RadarMapY(H);
	return l;
}

// ---- the painter -------------------------------------------------------------------------------------------------------------------------------
struct RallyPainter : Painter
{
	RallyModel& rm;
	const int ps0, o0, drop0;

	RallyPainter(Canvas& c, const Model& model, RallyModel& rally, float clientTime)
		: Painter(c, model, clientTime), rm(rally), ps0(ps), o0(o), drop0(drop)
	{
		// HL Rally's pixels are single pixels: the dark edge under the figures is one
		o = 1;
		drop = 0;
	}

	// One cell of a number or a word (a figure in its 16-wide box, `large` the tall ones of the lap and the place).
	void Cell(int x, int y, char ch, bool large, const Col& col)
	{
		static const unsigned char masks[10] = {0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};
		const int w = 12, h = large ? 33 : 17, t = large ? 3 : 2, dx = 2, dy = large ? 2 : 1;
		if (ch >= '0' && ch <= '9')
			SegDigit(x + dx, y + dy, w, h, t, masks[ch - '0'], col, 255, SEG_JOINED);
		else if (ch == ':')
		{
			const int hh = (h - 3 * t) / 2, full = 3 * t + 2 * hh;
			Fill(x + 7, y + dy + full / 3 - t / 2, t, t, col, 255);
			Fill(x + 7, y + dy + full * 2 / 3 - t / 2, t, t, col, 255);
		}
		else if (ch == '-')
			SegDigit(x + dx, y + dy, w, h, t, 0x40, col, 255, SEG_CUT);
		else if (ch == 'R' || ch == 'N')
		{
			const char s[2] = {ch, 0};
			Text(x + 3, y + 2, s, 2, col);
		}
	}

	// A run of cells from x, 16 apart.
	void Cells(int x, int y, const char* cells, bool large, const Col& col)
	{
		for (; *cells; cells++, x += RH_CELL)
			Cell(x, y, *cells, large, col);
	}

	// DrawHudNumber2 at (x, y). Returns the x after it.
	int Number(int x, int y, int flags, int n, bool large, const Col& col)
	{
		char cells[8];
		const int c = NumberCells(n, flags, cells);
		Cells(x, y, cells, large, col);
		return x + c * RH_CELL;
	}

	void Time(int x, int y, const TimeParts& t, const Col& col)
	{
		char cells[9];
		TimeCells(t, cells);
		Cells(x, y, cells, false, col);
	}

	void Label(int x, int y, const char* word, const Col& col) { Text(x, y, word, 2, col); }

	// :961-987 the speed, and :1187-1215 the gear. Always drawn: the dials are the sprite's, these are the numbers on it.
	void Speed3()
	{
		const RallyLayout l = RallyLayoutFor(W, H);
		Edged([&] {
			Number(l.speedX, l.speedY, RH_3DIGITS | RH_DRAWZERO, RallySpeedShown(rm.speed3d), false, RH_ORANGE);
			if (rm.reversing)
				Cell(l.gearX, l.gearY, 'R', false, RH_ORANGE);
			else if (rm.gear == 0)
				Cell(l.gearX, l.gearY, 'N', false, RH_ORANGE);
			else
				Number(l.gearX, l.gearY, RH_DRAWZERO, rm.gear, false, RH_ORANGE);
		});
	}

	// :997-1025 the lap: the word at (25, 16), the numbers at (20, 56) and (56, 56) and the slash between.
	void Lap()
	{
		Edged([&] {
			Text(25, 16, "LAP", 3, RH_WHITE);
			Number(20, 56, RH_DRAWZERO, ClampI(m.lap, 0, 99), true, RH_WHITE);
			Line(36 + 17, 56 + 3, 36 + 4, 56 + 40, 3, RH_WHITE, 255); // the slash (sprite 21 x 44)
			Number(56, 56, RH_DRAWZERO, ClampI(m.laps, 0, 99), true, RH_WHITE);
		});
	}

	// :1028-1055 [n/m] at (16, 106), orange.
	void Checkpoints()
	{
		const int total = m.cpTotal > 0 ? m.cpTotal : rm.cpTotalNote;
		const CpDraw d = CpLayout(rm.cpCur, total);
		const int y = 106;
		Edged([&] {
			Text(d.leftX, y + 2, "[", 2, RH_ORANGE);
			Number(d.curX, y, (d.curCells == 2 ? RH_2DIGITS : 0) | RH_DRAWZERO, ClampI(rm.cpCur, 0, 99), false, RH_ORANGE);
			Text(d.slashX, y + 2, "/", 2, RH_ORANGE);
			Number(d.totalX, y, RH_DRAWZERO, ClampI(total, 0, 99), false, RH_ORANGE);
			Text(d.rightX, y + 2, "]", 2, RH_ORANGE);
		});
	}

	// :1057-1095 the place, in the views that show the car: large digits and the suffix.
	void PlaceDigits()
	{
		const PlaceDraw p = PlaceLayout(W, m.place > 0 ? m.place : 1);
		static const char* const suffix[4] = {"ST", "ND", "RD", "TH"};
		Edged([&] {
			for (int i = 0; i < p.cells; i++)
				Cell(p.x + i * RH_CELL, 16, p.digit[i], true, RH_WHITE);
			Text(p.suffixX, 16, suffix[p.suffix], 3, RH_WHITE);
		});
	}

	// :1097-1135 the three clocks.
	void Clocks3()
	{
		const RallyLayout l = RallyLayoutFor(W, H);
		const float sv_ = sv;
		const bool started = (m.state == RACE_RACING || m.state == RACE_FINISHED) && m.raceStart > 0 && sv_ >= m.raceStart;
		TimeParts total = TimeOf(-1), lap = TimeOf(-1), best = m.bestCs > 0 ? TimeOfCs(m.bestCs) : TimeOf(-1);
		Col lapCol = RH_ORANGE;
		bool lapDraw = true;
		if (started)
		{
			total = TimeOf(sv_ - m.raceStart);
			if (LastLapShown(sv_ - m.lapStart, rm.lastLapCs))
			{
				lap = TimeOfCs(rm.lastLapCs);
				lapCol = RH_GREY;
				lapDraw = LastLapLit(now);
			}
			else if (m.lapStart > 0)
				lap = TimeOf(sv_ - m.lapStart);
		}
		Edged([&] {
			Label(l.timeX, l.totalLabelY, "TOTAL TIME", RH_ORANGE);
			Time(l.timeX, l.totalY, total, RH_ORANGE);
			Label(l.timeX, l.lapLabelY, "CURRENT LAP", RH_ORANGE);
			if (lapDraw)
				Time(l.timeX, l.lapY, lap, lapCol);
			Label(l.timeX, l.bestLabelY, "BEST LAP", RH_ORANGE);
			Time(l.timeX, l.bestY, best, RH_ORANGE);
		});
	}

	// :1150-1180 the time left, in red at the bottom left: the others' 30 seconds once the first has finished, or the allowance of the
	// time-extension mode (our limit's end).
	void TimeLeft()
	{
		const RallyLayout l = RallyLayoutFor(W, H);
		const bool started = (m.state == RACE_RACING || m.state == RACE_FINISHED) && m.raceStart > 0 && sv >= m.raceStart;
		if (m.state == RACE_FINISHED && m.t0 > 0 && sv > m.t0 - 30)
			Edged([&] { Time(l.leftX, l.leftY, TimeOf(m.t0 - sv), RH_RED); });
		else if (m.limitEnd > 0 && started)
			Edged([&] { Time(l.leftX, l.leftY, TimeOf(m.limitEnd - sv), RH_RED); });
	}

	// rally_hud_radar.cpp:190-345 the squares over the map's picture (the picture is the game's, drawn before this).
	void RadarSquares()
	{
		int n = 0;
		for (int i = 0; i < m.dotCount && n < MAX_DOTS; i++)
		{
			if (m.dots[i].index == m.local)
				continue;
			const int bx = RadarByte(m.dots[i].x), by = RadarByte(m.dots[i].y);
			if (bx == 0 && by == 0)
			{
				rm.radarX[n] = rm.radarY[n] = 0;
				n++;
				continue;
			}
			rm.radarX[n] = RadarSmooth(rm.radarX[n], bx);
			rm.radarY[n] = RadarSmooth(rm.radarY[n], by);
			n++;
		}
		if (rm.mapSprite && DotsFresh())
		{
			for (int i = 0; i < n; i++)
			{
				if (rm.radarX[i] == 0 && rm.radarY[i] == 0)
					continue;
				int x, y;
				RadarOther(H, rm.radarX[i], rm.radarY[i], x, y);
				Square(x, y, RH_RADAR_OTHER);
			}
		}
		if (rm.mapSprite && rm.haveOrg)
		{
			int x, y;
			RadarSelf(H, rm.org[0], rm.org[1], x, y);
			Square(x, y, RH_RADAR_SELF);
		}
	}

	// An 8 x 8 square about (x, y) with its corners cut (HL Rally's is a dot cut from its number sprite).
	void Square(int x, int y, const Col& c)
	{
		Fill(x - 4, y - 3, 8, 6, c, 255);
		Fill(x - 3, y - 4, 6, 8, c, 255);
	}

	void Paint()
	{
		if (ResultsShown(m, now)) // not HL Rally's (its table is the scoreboard's): kept, see the report
		{
			o = o0;
			drop = drop0;
			Results();
			return;
		}
		Speed3();
		if (IsRacing(m, now))
		{
			Lap();
			Checkpoints();
			if (rm.third)
				PlaceDigits();
			Clocks3();
			TimeLeft();
		}
		RadarSquares();
		if (!rm.mapSprite)
		{
			o = o0; // our lap line is drawn as before, in the old units
			drop = drop0;
			Minimap();
		}
	}
};
} // namespace racehud
