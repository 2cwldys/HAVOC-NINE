//========= Copyright © 1996-2002, Valve LLC, All rights reserved. ============
//
// Purpose: 
//
// $NoKeywords: $
//=============================================================================

#pragma once

#include "../dlls/cdll_dll.h"

enum 
{ 
	// player slots 1 to MAX_PLAYERS: the HUD's loops run i < MAX_PLAYERS_HUD
	MAX_PLAYERS_HUD = MAX_PLAYERS + 1,
	MAX_TEAMS = 64,
	MAX_TEAM_NAME = 32, // the server's TEAM_NAME_LENGTH; the original's is 16
};

#define MAX_SCORES					10
#define MAX_SCOREBOARD_TEAMS		5

#define NUM_ROWS		(MAX_PLAYERS_HUD + (MAX_SCOREBOARD_TEAMS * 2))

#define MAX_SERVERNAME_LENGTH	64
#define MAX_TEAMNAME_SIZE 32
