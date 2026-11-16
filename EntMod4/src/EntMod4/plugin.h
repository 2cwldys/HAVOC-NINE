#pragma once
#include <extdll.h>
#include <meta_api.h>
#ifdef _WIN32
#include <string.h>
#ifndef strcasecmp
#define strcasecmp  _stricmp
#define strncasecmp _strnicmp
#endif
#endif

// ======================================================================================
// EntMod4 -- reconstructed source: shared declarations.
// g_engfuncs / gpGlobals / gpMetaGlobals come from the SDK headers (defined in h_export.cpp
// and modmain.cpp); the engine call macros (GETPLAYERAUTHID, ENTINDEX, ...) come from
// enginecallbacks.h. This header declares EntMod's own globals and cross-module functions.
// ======================================================================================

// The game directory ("ts"), set once from GET_GAME_DIR in DFGameDLLInit (dll.cpp).
extern char moddir[256];

// Per-player EntMod state. Original: a global array EntInfo3[], 0xfd30 bytes per player, the admin
// flags at offset +0xfd2c. The block MUST stay 0xfd30 bytes: dispatch.cpp (EB) and the entity-tool
// modules index it as EntInfo3 + idx*0xfd30 + <field>, so a smaller struct would make every such
// access run off the end of the array. The entity-mover / rotate / train / multi-move / undo /
// weapon editing fields live inside `raw` and are given names as they are reconstructed.
// Index is ENTINDEX(player), 1..gpGlobals->maxClients.
#define ENT_MAXPLAYERS 33
#define ENTINFO3_STRIDE 0xfd30
struct playerstate_t
{
	unsigned char raw[0xfd2c];   // entity-tool editing state (named per field as reconstructed)
	int adminflags;              // DF_admins.txt flags (0 = not an admin), at the original +0xfd2c
};
extern playerstate_t EntInfo3[ENT_MAXPLAYERS];

extern float NextAdminCheck;   // entadmin.cpp: next server time to re-read DF_admins.txt
extern int   firstserverframe; // dll.cpp

// ---- admin system (entadmin.cpp) ----
void CheckAdmin(edict_t *player);          // read DF_admins.txt, set this player's admin flags
int  IsAdmin(edict_t *player, int flags);  // flags==0 -> "any admin?"; else test the flag bits

// ---- util (util.cpp) ----
int  UTIL_IsValidEntity(edict_t *pent);

// ---- entity-tool command handlers: reconstructed in later modules; stubbed for now (stubs.cpp) ----
int  DFEntMover(edict_t *player);   // weapon_entmover / mover commands
int  DFEntAdmin(edict_t *player);   // entmod_* admin/entity commands

// Shared declaration contract for the parallel body reconstruction (globals + cross-module procs).
#include "entmod_decl.h"
