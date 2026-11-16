#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>

// The core per-player dispatch and the two entity/admin command handlers it calls (dll.cpp,
// entmover.cpp, admintools.cpp). Declared here so the console path can reuse them.
int DFClientCommand(edict_t *player);
int DFEntMover(edict_t *player);
int DFEntAdmin(edict_t *player);

// ======================================================================================
// HAVOC9 -- restore EntMod's console-command registration.
//
// The original EntMod registered every one of its commands with the engine (pfnAddServerCommand), so
// the commands appear in the console and run when typed. The reconstruction had dropped that and
// relied only on the ClientCommand hook. That still works for a REMOTE client (the client forwards an
// unknown command to the server, where the hook catches it with the player's own edict), but the
// commands never show up in the console and, on a LISTEN server, are not recognised when the host
// types them -- the exact "commands don't show / don't work" symptom. This registers them again.
//
// A registered command runs server-side with no client argument, so on a listen server (or the server
// console) it acts on the local host -- the operator at the keyboard. The operator is authorised, so
// the entity / save / train handlers run here directly, without the DF_admins check (that check still
// guards REMOTE clients, which arrive on the ClientCommand hook, not here). CMD_ARGV already holds the
// command name and its arguments when the handler runs.
// ======================================================================================

static const char *const kCmds[] = {
	"weapon_entmover",
	"e_add", "e_classname", "e_drop", "e_god", "e_kill", "e_render", "e_rotate",
	"e_rotate_x", "e_rotate_y", "e_rotate_z", "e_search", "e_show", "e_stack",
	"e_telestart", "e_teleend", "e_teledelete", "e_undo", "e_use",
	"es_start", "es_grab", "es_graball", "es_ungrab", "es_save", "es_load",
	"mm_start", "mm_grab", "mm_end",
	"t_select", "t_start", "t_end", "t_go",
	"entmod_create", "entmod_quickmake", "entmod_spawn", "entmod_spawn2", "entmod_spawnmodel",
	"entmod_keyvalue", "entmod_lookingat", "entmod_keys", "entmod_noclip", "entmod_worldcopy",
	"entmod_bomb", "entmod_addpack",
	"entmod_myid",
};

// The player a console-typed command acts on: on a listen server, the local host (the first in-game
// human). Returns NULL on a dedicated server with no local player.
static edict_t *console_player(void)
{
	for (int i = 1; i <= gpGlobals->maxClients; i++)
	{
		edict_t *e = INDEXENT(i);
		if (e && !e->free && (e->v.flags & FL_CLIENT) && !(e->v.flags & FL_FAKECLIENT))
			return e;
	}
	return NULL;
}

// One shared handler for every registered command.
static void entmod_console_cmd(void)
{
	edict_t *e = console_player();
	if (!e)
	{
		ALERT(at_console, "[EntMod] '%s' acts on a player; run it in-game.\n", CMD_ARGV(0));
		return;
	}
	if (H9HandleIdCommand(e))   // entmod_myid: print this player's ids
		return;
	if (DFEntMover(e))          // e_ / es_ / t_ / mm_ entity, save and train commands
		return;
	if (DFEntAdmin(e))          // the entmod_* entity operations
		return;
	DFClientCommand(e);         // fallback: the weapon_entmover equip path in dll.cpp (admin-gated)
}

void H9RegisterCommands(void)
{
	for (unsigned i = 0; i < sizeof(kCmds) / sizeof(kCmds[0]); i++)
		REG_SVR_COMMAND((char *)kCmds[i], entmod_console_cmd);
}
