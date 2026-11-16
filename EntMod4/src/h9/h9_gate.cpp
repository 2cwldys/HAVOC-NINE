#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>
#include <ctype.h>
#include <stdio.h>

// ======================================================================================
// HAVOC9 gate -- when is EntMod active?
//
// EntMod is loaded on every map but stays INERT unless one of these is true:
//   1. the map name contains "entmap" (case-insensitive) -- the entmod-map naming convention,
//   2. the map name is in the `entmod_maps` cvar (operator list), or
//   3. the operator set `entmod_force 1` (force the tools on for every map).
//
// The `entmod` cvar is a STATE READOUT, not an input: the gate sets it to 1 on a map where the tools
// are live and 0 otherwise, so `entmod` in the console tells you at a glance whether EntMod is on.
// (Force the tools on with `entmod_force 1`, not by setting `entmod` -- `entmod` is overwritten each
// map from the computed state, which also avoids a value sticking across maps.) While active the
// server de-ranks (no XP/ELO) via the AMXX entmod_map() gate, which keys off the same "entmap" name
// and the entmod cvar, so a map that enables the tools is the same map that stops saving ranked play.
// The decision is printed to the server console each map.
// ======================================================================================

static cvar_t entmod_cvar        = { "entmod", "0", FCVAR_SERVER };        // STATE readout (set by the gate)
static cvar_t entmod_force_cvar  = { "entmod_force", "0", FCVAR_SERVER };  // operator input: force tools on everywhere
static cvar_t entmod_maps_cvar   = { "entmod_maps", "the_betterthanbest_entmap;the_betterthanbest_entmap2", FCVAR_SERVER };
static cvar_t entmod_preset_cvar = { "entmod_preset", "", FCVAR_SERVER };  // auto-load this saved preset per map
static int    g_entmod_active    = 0;

// Does `map` contain the substring "entmap" (case-insensitive)? The entmod-map naming convention and
// the primary activation trigger. Robust to any path/extension the engine may carry on the name.
static int name_has_entmap(const char *map)
{
	if (!map)
		return 0;
	char buf[160];
	size_t i = 0;
	for (; map[i] && i < sizeof(buf) - 1; i++)
		buf[i] = (char)tolower((unsigned char)map[i]);
	buf[i] = '\0';
	return strstr(buf, "entmap") != NULL;
}

// Is `map` one of the ';'-separated names in `list` (case-insensitive exact match)?
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

// Register the gate cvars and restore the console-command registration, at game-DLL init.
void H9GameInit(void)
{
	CVAR_REGISTER(&entmod_cvar);
	CVAR_REGISTER(&entmod_force_cvar);
	CVAR_REGISTER(&entmod_maps_cvar);
	CVAR_REGISTER(&entmod_preset_cvar);
	H9RegisterCommands();   // make EntMod's commands show in the console and run (src/h9/h9_cmds.cpp)
	ALERT(at_console, "[EntMod] loaded. entmod_maps='%s'. Tools turn on by 'entmap' in the map name, the entmod_maps list, or entmod_force 1.\n",
		CVAR_GET_STRING("entmod_maps"));
}

// Decide active state at each level start (after the cvars and any per-map config are in effect).
void H9OnServerActivate(edict_t * /*pEdictList*/, int /*edictCount*/, int /*clientMax*/)
{
	const char *map  = STRING(gpGlobals->mapname);
	const char *list = CVAR_GET_STRING("entmod_maps");
	int by_force = (CVAR_GET_FLOAT("entmod_force") != 0.0f);
	int by_name  = name_has_entmap(map);
	int by_list  = map_in_list(map, list ? list : "");
	g_entmod_active = by_force || by_name || by_list;

	// Reflect the computed state in the `entmod` cvar so the console shows whether the tools are live.
	CVAR_SET_FLOAT("entmod", g_entmod_active ? 1.0f : 0.0f);

	// Print the decision so it is obvious in the server console why the tools are on or off, and so the
	// exact map name the gate saw is visible for diagnosis.
	ALERT(at_console, "[EntMod] map '%s' -> tools %s  (entmod_force=%d, entmap-in-name=%d, in-list=%d)\n",
		map ? map : "(null)", g_entmod_active ? "ON" : "off", by_force, by_name, by_list);

	// Save-preset: when active, auto-load the map's chosen preset so an admin's entities persist across
	// map loads with no manual es_load. `entmod_preset <name>` replays
	// addons/EntMod/entsave/<map>_<name>.txt (exactly what the es_save command writes); empty = off.
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
