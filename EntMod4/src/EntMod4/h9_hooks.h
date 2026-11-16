#pragma once

// ======================================================================================
// EntMod4 -- H9 integration seams.
//
// The faithful EntMod reconstruction in src/EntMod4 is kept as close to the original plugin
// as possible. Where HAVOC9 needs to change behaviour, the original calls one of the small
// hooks declared here instead of carrying H9-specific code inline. The implementations live
// in src/h9 (the HAVOC9 build) -- or in h9_hooks_null.cpp for a pure, upstream-identical
// build. This keeps src/EntMod4 clean and the H9 additions in one place.
//
// Include after extdll.h (edict_t must be defined).
// ======================================================================================

// entadmin.cpp CheckAdmin: in addition to the engine auth id (GETPLAYERAUTHID), should this
// DF_admins.txt field-1 value also be accepted as matching this player? The H9 build accepts the
// custom Xash id published in the "h9_clientid" userinfo key. Returns 1 on match, 0 otherwise.
int H9AdminIdMatch(edict_t *player, const char *field1);

// entmod_myid console command (src/h9/h9_admin.cpp): a player types "entmod_myid" in their own
// console and EntMod privately prints their engine auth id (SteamID / ID_...) and h9_clientid back to
// that one player, so they can add themselves to DF_admins.txt. Needs no admin and works on any map
// (you use it before you are an admin). Returns 1 if it handled the command (supercede), else 0.
// Called from mClientCommand before the gate so it is always available.
int H9HandleIdCommand(edict_t *player);

// ---- H9 gate (src/h9/h9_gate.cpp): EntMod is inert unless this is an entmap or `entmod 1`. ----
void H9GameInit(void);                                              // DFGameDLLInit: register cvars + commands
void H9OnServerActivate(edict_t *pEdictList, int edictCount, int clientMax);  // compute active at level start
int  H9EntModActive(void);                                          // gate the command / mover hooks (1 = active)

// Restore EntMod's console-command registration (src/h9/h9_cmds.cpp) so the commands show in the
// console and run on a listen server / server console. Called once from H9GameInit.
void H9RegisterCommands(void);
