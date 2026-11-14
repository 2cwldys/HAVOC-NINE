/***
*  race.h -- the race mode's face to the rest of the game (H9; h9-maps maps/race01/FINAL.md, contract 1).
*
*  The mode is on only in a map that has a race_rules entity; in any other map every function here answers
*  "no" and nothing in the game changes. The car (h9_car.cpp) is the caller these were written for.
***/
#pragma once

class CBasePlayer;
class Vector;

enum RaceState
{
	RACE_WAITING = 0, // nobody in yet, or the warm-up before a countdown
	RACE_COUNTDOWN,   // the lights; racers are held
	RACE_RACING,
	RACE_FINISHED,    // somebody has finished: the others have `finishwait` seconds, then the results show
};

// True in a map with a race_rules entity (and checkpoints that make a lap).
bool RaceActive();
// HL Rally's `kill` is the put-back: asks for one for this racer in rally mode. False when there is no rally race to put him back in.
bool RaceRallyAskPut(int index);
RaceState RaceGetState();
// Goes up by one each time a countdown begins (0 until the first): a car that sees it change goes to its
// driver's grid slot. The warm-up before it is free driving.
int RaceRound();

// True while this player must not drive: during the countdown, once he has finished or run out of time, and
// while the results show.
bool RaceHolds(CBasePlayer* pPlayer);
bool RaceFinishedCar(CBasePlayer* pPlayer); // rally mode: this racer has finished or run out of time, and his car brakes and coasts

// The player's grid slot, 1 = pole, given in the order players joined (the lowest slot free); 0 with no race.
int RacePlayerSlot(CBasePlayer* pPlayer);
// The race_grid entity with this slot: its place and its angles. False when the map has none.
bool RaceGridSlot(int slot, Vector& origin, Vector& angles);
// Where to put this player's car back: the race_respawn of the last checkpoint he passed (or of the nearest
// one before it that has a respawn); before his first checkpoint, and outside a race, his grid slot.
// False when the map has neither.
bool RaceRespawnPoint(CBasePlayer* pPlayer, Vector& origin, Vector& angles);
// Tell the race the player's car was just put somewhere else (grid, respawn), so that the jump is not read
// as a drive through the checkpoints between and the wrong-way watch begins again.
void RacePlaced(CBasePlayer* pPlayer);

// The free grid car with the lowest slot takes this player in (h9_car.cpp). False when he has a car, is dead, or
// the grid is full.
bool RaceSeatFree(CBasePlayer* pPlayer);

// Rally mode (race_rules key `vehicle "rally"`, or the cvar h9_rally 1..3 in any map with race_rules): a racer is a
// living player who IS the car (pm_shared/h9_rally.h), no h9_car is used, and every player who joins is a racer.
// The car class the race wants its players to drive as (1..3), 0 when the map's racers drive h9_cars or there is no
// race_rules. h9_rally_srv.cpp sets the physinfo key from it.
int RaceRallyClass();
// True when the map's own race_rules say `vehicle "rally"` (not the cvar h9_rally forcing it): a map made for HL Rally's cars, compiled
// with hull 1 as a point hull and clip brushes along its banks. h9_rally_srv.cpp sets the physinfo key "rhull" from it.
bool RaceRallyMapKey();
// True when the race is in rally mode (RaceRallyClass() > 0).
bool RaceRallyMode();

// The car menu's side of the race (h9_rally_srv.cpp's changecar/spectate/selectcar, HL Rally's respawn rules).
// True from the green light until the results table: HL Rally's m_RoundState == 1.
bool RaceRallyRunning();
// He has crossed the last line or run out of time: HL Rally's `pev->iuser3 == numlaps`.
bool RaceRallyDone(CBasePlayer* pPlayer);
// Out of the race until the next one starts (HL Rally's selectcar: "don't let them join this race again"); cleared when the next race is set up.
void RaceRallySitOut(int index, bool out);
bool RaceRallySittingOut(int index);
// The car on its grid slot, at rest, if the race has seated him.
void RaceRallyPutOnSlot(CBasePlayer* pPlayer);
// mp_joinmidrace (HL Rally's cvar, default 1): a player who picks a car in a running race joins it from lap 0.
bool RaceRallyJoinMidRace();

// The race_waypoint with this number (for the AI drivers of a later wave). False when the map has none.
bool RaceWaypoint(int number, Vector& origin, float& speed, float& spread);

// Registers mp_racelaps and mp_racewarmup; called once from GameDLLInit.
void RaceRegisterCvars();

// ── The client's race HUD (cl_dll/h9_racehud.cpp draws it; race.cpp sends it). The client includes this file. ──
//
// A game that has the HUD says so with the userinfo key _h9race "1" (the way of _h9vgui and _h9arphud: nothing is
// typed at the server, so a server without the race answers nothing). Such a player gets the six user messages
// below and none of the race's text messages; any other player keeps the text HUD.
//
// Times. A clock that runs (the race, the lap, the time left, the countdown) is sent as the moment it started or
// ends on the server's clock, a float, with the server's `now` beside it: the client counts by itself between two
// messages and a late message moves nothing. A time that is over (a split, a lap, a total) is sent in hundredths
// of a second, a long: what is shown is what was measured.
//
//   H9RStat   35 bytes, to a racer, unreliable, RACE_HUD_STATUS_EVERY:
//             byte state (RaceState), byte flags (RACE_SF_*), byte lap (the one he drives, from 1), byte laps,
//             byte place, byte racers, short speed (units a second along the nose), byte slip (0..255),
//             short top speed of his car, float now, float the green light, float his lap's start,
//             float when his time runs out (0: no limit), long best lap (0: none), long total (0 until he finishes)
//   H9RState  14 bytes, to everybody with the HUD, reliable, when any of it changes:
//             byte state, byte results (1 while the table is up), byte laps, byte racers, float now,
//             float t0 (WAITING: when the countdown begins, 0 with nobody in; COUNTDOWN: the green light;
//             RACING: the green light; FINISHED: when the others' time is up), short the countdown's length, tenths
//   H9RNote   12 bytes, to a racer, reliable, when it happens:
//             byte kind (RACE_NOTE_*), byte a, byte b, byte flags (RACE_NF_*), long time, long diff (hundredths)
//             CHECKPOINT: a its number, b the last number, time the split, diff against his best lap (NF_DIFF)
//             LAP: a laps closed, b laps, time the lap, diff against his best before it (NF_DIFF), NF_BEST
//             FINISH: a his place, b racers, time his total, diff his best lap
//             OUTOFTIME: a the lap he was on, b laps
//   H9RLine   to everybody with the HUD, reliable, once (a part each frame): the lap's line and the checkpoints
//             byte kind (0 the line's points in order, 1 the checkpoints' middles in order), short total,
//             short first, byte count, then count times: short x, short y (the map's, divided by RACE_HUD_COORD)
//             A part with kind 0 and first 0 begins a new map: what the client held is dropped.
//   H9RPos    to a racer, unreliable, RACE_HUD_POS_EVERY: where every racer is
//             byte flags (RACE_PF_FIRST: drop the list held), byte count, then count times: byte player index,
//             byte place (low 6 bits; RACE_PP_FINISHED, RACE_PP_RETIRED), short x, short y,
//             short the way behind the first still racing, in RACE_HUD_GAP units (0xFFFF: not known)
//   H9RRes    to everybody with the HUD, reliable, when the results show:
//             byte first row, byte rows, byte laps, byte count, then count times: byte place, byte player index,
//             byte flags (RACE_RF_*), byte lap, long total, long best lap (hundredths)
#define RACE_HUD_INFOKEY "_h9race"
#define RACE_HUD_STATUS_EVERY 0.2f
#define RACE_HUD_POS_EVERY 0.25f

enum
{
	RACE_HUD_COORD = 8,        // a map coordinate is sent divided by this
	RACE_HUD_GAP = 4,          // and a gap by this
	RACE_HUD_LINE_POINTS = 40, // points in one H9RLine (6 + 40 * 4 bytes; a user message holds 192)
	RACE_HUD_POS_RACERS = 23,  // racers in one H9RPos (2 + 23 * 8)
	RACE_HUD_RES_ROWS = 15,    // rows in one H9RRes (4 + 15 * 12)

	RACE_MSG_STAT_SIZE = 39,
	RACE_MSG_STATE_SIZE = 14,
	RACE_MSG_NOTE_SIZE = 12,

	RACE_SF_WRONGWAY = 1,
	RACE_SF_FINISHED = 2,
	RACE_SF_RETIRED = 4,

	RACE_NOTE_CHECKPOINT = 1,
	RACE_NOTE_LAP,
	RACE_NOTE_FINISH,
	RACE_NOTE_OUTOFTIME,
	RACE_NF_DIFF = 1,
	RACE_NF_BEST = 2,

	RACE_PF_FIRST = 1,
	RACE_PP_PLACE = 0x3f,
	RACE_PP_RETIRED = 0x40,
	RACE_PP_FINISHED = 0x80,

	RACE_RF_FINISHED = 1,
	RACE_RF_RETIRED = 2,
};

// Registers the six messages; called from LinkUserMessages.
void RaceLinkUserMessages();
