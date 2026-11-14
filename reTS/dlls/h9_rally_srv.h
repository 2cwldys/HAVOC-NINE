/***
*  h9_rally_srv.h -- the server's side of rally mode (h9_rally_srv.cpp; the movement is pm_shared/h9_rally.cpp).
***/
#pragma once

class CBasePlayer;

// Registers the cvar h9_rally; called once from GameDLLInit.
void H9RallyRegisterCvars();

// The engine's pfnPM_Move (dlls/cbase.cpp): PM_Move, and then the command's line in the log (cvar h9_rally_log, rallylog/srv_*.txt).
void H9RallyPMMove(struct playermove_s* ppmove, qboolean server);

// Called each frame for each living player (CBasePlayer::PostThink): makes his state match h9_rally.
void H9RallyServerThink(CBasePlayer* pl);

// UpdateClientData: a car's tilt (pev->vuser4, vuser3.x: pm_shared/h9_rally.h's H9RallyTiltPack) goes to the client's prediction in the client
// data. The weapon channel of The Specialists uses the same fields for a gun in the hand, which a car has none of.
void H9RallyClientData(const edict_t* ent, struct clientdata_s* cd);

// The cvar h9_rally as a class: 0 off, 1 to 10 (race.cpp lets it force rally mode in a map with race_rules).
int H9RallyCvarClass();

// True when this player is a rally car now (his physinfo's rally class).
bool H9RallyIsCar(edict_t* ent);
int H9RallyCurrentClass(edict_t* ent); // the class his physinfo says (1..10), 0 when he is not a car

// ---- the car menu's server side: per-player car, money and parts (pm_shared/h9_rally_shop.h is the contract with the client) ----
// Registers H9RMoney, H9RParts and H9RCar; called from LinkUserMessages.
void H9RallyLinkUserMessages();
// The player's car class: the cvar h9_rally (1..10) when set, else the car he chose, else the map's (race_rules vehicle "rally": 1); 0 off.
int H9RallyClassOf(int index);
// HL Rally's fuser1 != 0: he has chosen a car and is in the race. Nobody who has not is on the roster (race.cpp).
bool H9RallyChosen(int index);
// What his parts add to the stats (physinfo "rt": top speed %), for the gauge's end.
int H9RallyTopAdd(int index);
// ClientPutInServer (every map) and ClientDisconnect: the money is $600 again, nothing chosen, no parts.
void H9RallyShopJoin(int index);
void H9RallyShopLeave(int index);
// The joiner's first frame (CTSGameRules::InitHUD): H9RMoney, H9RParts, H9RCar and VGUIMenu MENU_INTRO, in a rally race map only.
void H9RallyJoinMessages(CBasePlayer* pl);
// ClientCommand: changecar, spectate, selectcar, buy. True when the command is one of these in a rally race map (handled, whatever came of it).
bool H9RallyCommand(CBasePlayer* pl, const char* cmd);
// The "respawn" command (fire to play): true when it is refused (no car chosen: the menu opens again; sitting out the race: the wait line).
bool H9RallyRespawnRefused(CBasePlayer* pl);
// The observer is let into play now, past the respawn gate (a chosen car, the next race).
void H9RallyLeaveObserver(CBasePlayer* pl);
// Money from the race: a checkpoint that is not the line, and a finish with his place.
void H9RallyMoneyCheckpoint(int index);
void H9RallyMoneyFinish(int index, int place);
