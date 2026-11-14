/***
*  h9_rally_srv.h -- the server's side of rally mode (h9_rally_srv.cpp; the movement is pm_shared/h9_rally.cpp).
***/
#pragma once

class CBasePlayer;

// Registers the cvar h9_rally; called once from GameDLLInit.
void H9RallyRegisterCvars();

// Called each frame for each living player (CBasePlayer::PostThink): makes his state match h9_rally.
void H9RallyServerThink(CBasePlayer* pl);

// UpdateClientData: a car's tilt (pev->vuser4, vuser3.x: pm_shared/h9_rally.h's H9RallyTiltPack) goes to the client's prediction in the client
// data. The weapon channel of The Specialists uses the same fields for a gun in the hand, which a car has none of.
void H9RallyClientData(const edict_t* ent, struct clientdata_s* cd);

// The cvar h9_rally as a class: 0 off, 1 to 10 (race.cpp lets it force rally mode in a map with race_rules).
int H9RallyCvarClass();
