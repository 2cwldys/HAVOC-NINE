// ---- H9 race HUD ----------------------------------------------------------------------------------------------------
// h9_racehud.h is the outline; dlls/race.h lists the messages, byte by byte; h9_racehud_draw.h holds what is kept (Model) and
// draws it. This file is the engine's side only: it reads the messages into the model, keeps the clock, and gives the painter
// a canvas of pfnFillRGBABlend.
//
// The clock. The server sends moments on its own clock (gpGlobals->time in race_rules' think) and its `now` with them. The
// engine gives this dll the same clock: the flTime of HUD_Redraw (gHUD.m_flTime) is the client's cl.time, which follows the
// time the server stamps on every update, a little behind it (the client draws the world between the last two updates).
// That is the clock the other timers of this HUD run on too (roundtime.cpp, ts_message.cpp), and a clock drawn from it shows
// the moment the picture shows. racehud::ClockOffset checks it on every message: while the two are within a second nothing
// is added, and were they ever not the one clock, the difference is.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "h9_theme.h"
#include "h9_racehud.h"
#include "h9_racehud_draw.h"

#include <string.h>
#include <stdio.h>

namespace
{
using namespace racehud;

#define H9RACE_MAX_MSG 192 // bytes a message may have

Model s_m;
cvar_t* s_cvOn;   // cl_h9_racehud
cvar_t* s_cvInfo; // _h9race: the userinfo key the server reads
bool s_bInited;

bool Enabled()
{
	return s_cvOn == nullptr || s_cvOn->value != 0.0f;
}

void TakeClock(float serverNow)
{
	s_m.clock = ClockOffset(s_m.haveClock, s_m.clock, serverNow, gEngfuncs.GetClientTime());
	s_m.haveClock = true;
}

// A player's name as the scoreboard has it, for a row or a dot.
void NameOf(int index, char* out, size_t room)
{
	out[0] = 0;
	if (index < 1 || index > MAX_PLAYERS)
		return;
	hud_player_info_t info;
	memset(&info, 0, sizeof(info));
	gEngfuncs.pfnGetPlayerInfo(index, &info);
	if (info.name)
		snprintf(out, room, "%s", info.name);
}

// byte state, byte flags, byte lap, byte laps, byte place, byte racers, short speed, byte slip, short top speed, float now,
// float the green light, float the lap's start, float the limit's end, long best lap, long total
int MsgStat(const char* pszName, int iSize, void* pbuf)
{
	if (iSize != RACE_MSG_STAT_SIZE)
		return 1;
	BEGIN_READ(pbuf, iSize);
	s_m.state = ClampI(READ_BYTE(), RACE_WAITING, RACE_FINISHED);
	s_m.flags = READ_BYTE();
	s_m.lap = READ_BYTE();
	s_m.laps = READ_BYTE();
	s_m.place = READ_BYTE();
	s_m.racers = READ_BYTE();
	s_m.speed = (float)READ_SHORT();
	s_m.slip = READ_BYTE() / 255.0f;
	s_m.topSpeed = (float)READ_SHORT();
	const float serverNow = READ_FLOAT();
	s_m.raceStart = READ_FLOAT();
	s_m.lapStart = READ_FLOAT();
	s_m.limitEnd = READ_FLOAT();
	s_m.bestCs = READ_LONG();
	s_m.totalCs = READ_LONG();
	TakeClock(serverNow);
	if (!IsRacing(s_m, gEngfuncs.GetClientTime()))
		s_m.gauge = s_m.speed; // he has just got in: the gauge does not sweep up from nothing
	s_m.haveStat = true;
	s_m.statAt = gEngfuncs.GetClientTime();
	return 1;
}

// byte state, byte results, byte laps, byte racers, float now, float t0, short the countdown's length in tenths
int MsgState(const char* pszName, int iSize, void* pbuf)
{
	if (iSize != RACE_MSG_STATE_SIZE)
		return 1;
	BEGIN_READ(pbuf, iSize);
	s_m.state = ClampI(READ_BYTE(), RACE_WAITING, RACE_FINISHED);
	s_m.resultsUp = READ_BYTE() != 0;
	s_m.laps = READ_BYTE();
	s_m.racers = READ_BYTE();
	const float serverNow = READ_FLOAT();
	s_m.t0 = READ_FLOAT();
	s_m.countdown = READ_SHORT() / 10.0f;
	TakeClock(serverNow);
	s_m.haveState = true;
	if (!s_m.resultsUp)
		s_m.rowCount = s_m.rowTotal = 0; // the table goes when the server says the race goes on (or waits again)
	if (s_m.state == RACE_WAITING || s_m.state == RACE_COUNTDOWN)
		s_m.noteKind = 0; // a note of the race before
	return 1;
}

// byte kind, byte a, byte b, byte flags, long time, long diff
int MsgNote(const char* pszName, int iSize, void* pbuf)
{
	if (iSize != RACE_MSG_NOTE_SIZE)
		return 1;
	BEGIN_READ(pbuf, iSize);
	s_m.noteKind = READ_BYTE();
	s_m.noteA = READ_BYTE();
	s_m.noteB = READ_BYTE();
	s_m.noteFlags = READ_BYTE();
	s_m.noteTime = READ_LONG();
	s_m.noteDiff = READ_LONG();
	s_m.noteAt = gEngfuncs.GetClientTime();
	return 1;
}

// byte kind (0 the line, 1 the checkpoints), short total, short first, byte count, then count times: short x, short y
int MsgLine(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 6 || iSize > H9RACE_MAX_MSG)
		return 1;
	BEGIN_READ(pbuf, iSize);
	const int kind = READ_BYTE();
	const int total = READ_SHORT();
	const int first = READ_SHORT();
	const int count = READ_BYTE();
	if (iSize != 6 + count * 4 || total < 0 || first < 0)
		return 1;
	if (kind == 0)
	{
		if (first == 0) // a new map's line
		{
			s_m.linePoints = 0;
			s_m.lineTotal = total > MAX_LINE ? MAX_LINE : total;
			s_m.cpPoints = s_m.cpTotal = 0;
			s_m.haveDots = false;
		}
		if (first != s_m.linePoints) // a part out of its turn: the line stays short and is not drawn
			return 1;
		for (int i = 0; i < count && s_m.linePoints < s_m.lineTotal; i++)
		{
			s_m.line[s_m.linePoints].x = (short)READ_SHORT();
			s_m.line[s_m.linePoints].y = (short)READ_SHORT();
			s_m.linePoints++;
		}
	}
	else if (kind == 1)
	{
		if (first == 0)
		{
			s_m.cpPoints = 0;
			s_m.cpTotal = total > MAX_CPS ? MAX_CPS : total;
		}
		if (first != s_m.cpPoints)
			return 1;
		for (int i = 0; i < count && s_m.cpPoints < s_m.cpTotal; i++)
		{
			s_m.cps[s_m.cpPoints].x = (short)READ_SHORT();
			s_m.cps[s_m.cpPoints].y = (short)READ_SHORT();
			s_m.cpPoints++;
		}
	}
	return 1;
}

// byte flags, byte count, then count times: byte index, byte place and flags, short x, short y, short gap
int MsgPos(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 2 || iSize > H9RACE_MAX_MSG)
		return 1;
	BEGIN_READ(pbuf, iSize);
	const int flags = READ_BYTE();
	const int count = READ_BYTE();
	if (iSize != 2 + count * 8)
		return 1;
	if (flags & RACE_PF_FIRST)
		s_m.dotCount = 0;
	for (int i = 0; i < count && s_m.dotCount < MAX_DOTS; i++)
	{
		Dot& d = s_m.dots[s_m.dotCount++];
		d.index = READ_BYTE();
		const int place = READ_BYTE();
		d.place = place & RACE_PP_PLACE;
		d.finished = (place & RACE_PP_FINISHED) != 0;
		d.retired = (place & RACE_PP_RETIRED) != 0;
		d.x = (short)READ_SHORT();
		d.y = (short)READ_SHORT();
		const int gap = READ_SHORT() & 0xFFFF;
		d.gap = gap == 0xFFFF ? -1 : gap;
		NameOf(d.index, d.name, sizeof(d.name));
	}
	s_m.haveDots = true;
	s_m.dotsAt = gEngfuncs.GetClientTime();
	return 1;
}

// byte first row, byte rows, byte laps, byte count, then count times: byte place, byte index, byte flags, byte lap, long total,
// long best lap
int MsgRes(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 4 || iSize > H9RACE_MAX_MSG)
		return 1;
	BEGIN_READ(pbuf, iSize);
	const int first = READ_BYTE();
	const int total = READ_BYTE();
	const int laps = READ_BYTE();
	const int count = READ_BYTE();
	if (iSize != 4 + count * 12)
		return 1;
	if (first == 0)
	{
		s_m.rowCount = 0;
		s_m.rowTotal = total > MAX_ROWS ? MAX_ROWS : total;
		s_m.rowLaps = laps;
	}
	if (first != s_m.rowCount)
		return 1;
	for (int i = 0; i < count && s_m.rowCount < s_m.rowTotal; i++)
	{
		Row& r = s_m.rows[s_m.rowCount++];
		r.place = READ_BYTE();
		r.index = READ_BYTE();
		r.flags = READ_BYTE();
		r.lap = READ_BYTE();
		r.total = READ_LONG();
		r.best = READ_LONG();
		NameOf(r.index, r.name, sizeof(r.name));
	}
	s_m.rowsAt = gEngfuncs.GetClientTime();
	return 1;
}

// Every colour is taken in the colour the player has given H9's panels (h9_theme.h: a purple moves; a red, a green or a yellow does
// not). pfnFillRGBABlend blends by the alpha; an engine without it has only the call that adds the colour to the picture, and
// there the dark boxes are left out (they would only lighten what is behind them).
struct EngineCanvas : Canvas
{
	void Fill(int x, int y, int w, int h, int r, int g, int b, int a) override
	{
		if (gEngfuncs.pfnFillRGBABlend)
		{
			h9theme::TintHeld(r, g, b);
			gEngfuncs.pfnFillRGBABlend(x, y, w, h, r, g, b, a);
		}
		else if (r + g + b > 120)
		{
			h9theme::TintHeld(r, g, b);
			FillRGBA(x, y, w, h, r, g, b, a);
		}
	}
	int Width() override { return ScreenWidth; }
	int Height() override { return ScreenHeight; }
};
EngineCanvas s_Canvas;

// _h9race is what the server reads: 1 while this game draws the race HUD, else 0.
void SyncUserinfo()
{
	if (!s_cvInfo)
		return;
	const char* want = Enabled() ? "1" : "0";
	if (!s_cvInfo->string || 0 != strcmp(s_cvInfo->string, want))
		gEngfuncs.Cvar_Set(RACE_HUD_INFOKEY, want);
}

class CHudH9Race : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE;
		return true;
	}
	bool VidInit() override { return true; }
	bool Draw(float flTime) override
	{
		if (!Enabled())
			return true;
		// the gauge follows the speed: most of the way in a tenth of a second
		const float dt = ClampF((float)gHUD.m_flTimeDelta, 0, 0.1f);
		s_m.gauge += (s_m.speed - s_m.gauge) * ClampF(dt * 12.0f, 0, 1);
		cl_entity_t* player = gEngfuncs.GetLocalPlayer();
		s_m.local = player ? player->index : 0;
		h9theme::Refresh(); // the player's colour, once for the whole HUD
		Painter painter(s_Canvas, s_m, flTime);
		painter.Paint();
		return true;
	}
	void Think() override { SyncUserinfo(); }
	void InitHUDData() override
	{
		// A new map, or a new server: what moves is forgotten (its times are on a clock that has begun again). The lap's line
		// is kept: the server sends it once to a player, and a new map's first part takes the old one away.
		s_m.haveState = s_m.haveStat = s_m.haveDots = s_m.haveClock = false;
		s_m.clock = 0;
		s_m.noteKind = 0;
		s_m.rowCount = s_m.rowTotal = 0;
		s_m.dotCount = 0;
		s_m.gauge = s_m.speed = 0;
	}
};
CHudH9Race s_Hud;
} // namespace

bool H9RaceHud_Driving()
{
	return s_bInited && Enabled() && racehud::IsRacing(s_m, gHUD.m_flTime);
}

int H9RaceHud_ChatLeft()
{
	if (!H9RaceHud_Driving() || !racehud::MapShown(s_m))
		return 10;
	return racehud::MapRight(ScreenWidth, ScreenHeight) + 10;
}

void H9RaceHud_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvOn = CVAR_CREATE("cl_h9_racehud", "1", FCVAR_ARCHIVE);
	s_cvInfo = CVAR_CREATE(RACE_HUD_INFOKEY, Enabled() ? "1" : "0", FCVAR_USERINFO);
	gEngfuncs.pfnHookUserMsg("H9RStat", MsgStat);
	gEngfuncs.pfnHookUserMsg("H9RState", MsgState);
	gEngfuncs.pfnHookUserMsg("H9RNote", MsgNote);
	gEngfuncs.pfnHookUserMsg("H9RLine", MsgLine);
	gEngfuncs.pfnHookUserMsg("H9RPos", MsgPos);
	gEngfuncs.pfnHookUserMsg("H9RRes", MsgRes);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}
// ---- end H9 race HUD --------------------------------------------------------------------------------------------------
