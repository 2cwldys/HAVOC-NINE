/***
*  h9_rally_srv.h -- the server's side of rally mode (h9_rally_srv.cpp; the movement is pm_shared/h9_rally.cpp).
***/
#pragma once

class CBasePlayer;

// Registers the cvar h9_rally; called once from GameDLLInit.
void H9RallyRegisterCvars();

// Called each frame for each living player (CBasePlayer::PostThink): makes his state match h9_rally.
void H9RallyServerThink(CBasePlayer* pl);

// The cvar h9_rally as a class: 0 off, 1 to 3 (race.cpp lets it force rally mode in a map with race_rules).
int H9RallyCvarClass();
