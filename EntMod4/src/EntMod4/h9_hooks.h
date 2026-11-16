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

// ---- H9 gate (src/h9/h9_gate.cpp): EntMod is inert unless this is an entmap or `entmod 1`. ----
void H9GameInit(void);                                              // DFGameDLLInit: register entmod/entmod_maps
void H9OnServerActivate(edict_t *pEdictList, int edictCount, int clientMax);  // compute active at level start
int  H9EntModActive(void);                                          // gate the command / mover hooks (1 = active)
