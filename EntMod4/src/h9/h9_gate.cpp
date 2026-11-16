#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>
#include <stdio.h>

// ======================================================================================
// HAVOC9 gate -- when is EntMod active?
//
// EntMod is loaded on every map but stays INERT unless this is a designated "entmap" or the server
// operator set the `entmod` cvar to 1. So loading EntMod never changes a normal competitive map;
// only an entmap or `entmod 1` turns the admin/entity tools on. HookMod gates itself the same way
// off the same two cvars (see src/HookMod). The ranked de-auth that stops XP/ELO being saved is
// handled on the AMXX/backend side off the `entmod` cvar and the entmap name (h9_compete.sma /
// modes.js entmodMap()), so it never flaps a live server.
// ======================================================================================

static cvar_t entmod_cvar        = { "entmod", "0", FCVAR_SERVER };
static cvar_t entmod_maps_cvar   = { "entmod_maps", "the_betterthanbest_entmap;the_betterthanbest_entmap2", FCVAR_SERVER };
static cvar_t entmod_preset_cvar = { "entmod_preset", "", FCVAR_SERVER };   // auto-load this saved preset per map
static int    g_entmod_active    = 0;

// Is `map` one of the ';'-separated names in `list` (case-insensitive)?
static int map_in_list(const char *map, const char *list)
{
	char buf[512];
	strncpy(buf, list, sizeof(buf) - 1);
	buf[sizeof(buf) - 1] = '\0';
	for (char *tok = strtok(buf, ";"); tok; tok = strtok(NULL, ";"))
		if (strcasecmp(tok, map) == 0)
			return 1;
	return 0;
}

// Register the gate cvars once, at game-DLL init, so server.cfg can set `entmod` before the map loads.
void H9GameInit(void)
{
	CVAR_REGISTER(&entmod_cvar);
	CVAR_REGISTER(&entmod_maps_cvar);
	CVAR_REGISTER(&entmod_preset_cvar);
}

// Decide active state at each level start (after the cvars and any per-map config are in effect).
void H9OnServerActivate(edict_t * /*pEdictList*/, int /*edictCount*/, int /*clientMax*/)
{
	const char *map  = STRING(gpGlobals->mapname);
	const char *list = CVAR_GET_STRING("entmod_maps");
	g_entmod_active = (CVAR_GET_FLOAT("entmod") != 0.0f) || map_in_list(map, list ? list : "");

	// Save-preset: when active, auto-load the map's chosen preset so an admin's entities persist
	// across map loads with no manual es_load. `entmod_preset <name>` replays
	// addons/EntMod/entsave/<map>_<name>.txt (exactly what the es_save command writes); empty = off.
	// Those files are plain text, so a preset can be edited by hand and changed at whim.
	if (g_entmod_active)
	{
		const char *preset = CVAR_GET_STRING("entmod_preset");
		if (preset && preset[0])
		{
			char relname[160];
			snprintf(relname, sizeof(relname), "%s_%s.txt", map, preset);
			DFLoadEntFile(relname, false);
		}
	}
}

int H9EntModActive(void)
{
	return g_entmod_active;
}
