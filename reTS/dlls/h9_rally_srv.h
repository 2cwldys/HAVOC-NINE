/***
*  h9_rally_srv.h -- the server's side of rally mode (h9_rally_srv.cpp; the movement is pm_shared/h9_rally.cpp).
***/
#pragma once

class CBasePlayer;

// Registers the cvar h9_rally; called once from GameDLLInit.
void H9RallyRegisterCvars();

// Called each frame for each living player (CBasePlayer::PostThink): makes his state match h9_rally.
void H9RallyServerThink(CBasePlayer* pl);
