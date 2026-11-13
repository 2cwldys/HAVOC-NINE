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
RaceState RaceGetState();
// Goes up by one each time a countdown begins (0 until the first): a car that sees it change goes to its
// driver's grid slot. The warm-up before it is free driving.
int RaceRound();

// True while this player must not drive: during the countdown, once he has finished or run out of time, and
// while the results show.
bool RaceHolds(CBasePlayer* pPlayer);

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

// The race_waypoint with this number (for the AI drivers of a later wave). False when the map has none.
bool RaceWaypoint(int number, Vector& origin, float& speed, float& spread);

// Registers mp_racelaps and mp_racewarmup; called once from GameDLLInit.
void RaceRegisterCvars();
