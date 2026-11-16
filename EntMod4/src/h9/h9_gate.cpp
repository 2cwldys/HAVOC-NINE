#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>
#include <ctype.h>
#include <stdio.h>

// ======================================================================================
// HAVOC9 gate -- when is EntMod active?
//
// EntMod is loaded on every map but stays INERT unless one of these is true:
//   1. the map name contains "entmap" (case-insensitive)  -- the naming convention for entmod maps,
//   2. the map name is one of the ';'-separated names in the `entmod_maps` cvar (operator list), or
//   3. the server operator set `entmod 1` (force the tools on for every map).
// So loading EntMod never changes a normal competitive map; only an entmap (by name), a listed map,
// or `entmod 1` turns the admin/entity tools on. HookMod gates itself the same way (src/HookMod).
//
// The "entmap" substring is the primary trigger and matches the AMXX de-auth side
// (h9_compete.sma / h9_presence.sma entmod_map(): containi(name,"entmap")!=-1 || entmod!=0), so a map
// that enables the tools is the same map that stops saving ranked XP/ELO -- no flap, decided once at
// level start. The decision is printed to the server console each map for easy diagnosis.
// ======================================================================================

static cvar_t entmod_cvar        = { "entmod", "0", FCVAR_SERVER };
static cvar_t entmod_maps_cvar   = { "entmod_maps", "the_betterthanbest_entmap;the_betterthanbest_entmap2", FCVAR_SERVER };
static cvar_t entmod_preset_cvar = { "entmod_preset", "", FCVAR_SERVER };   // auto-load this saved preset per map
static int    g_entmod_active    = 0;

// Does `map` contain the substring "entmap" (case-insensitive)? This is the naming convention for
// entmod maps and the primary activation trigger. Robust to any path/extension the engine may carry.
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

// Register the gate cvars once, at game-DLL init, so server.cfg can set `entmod` before the map loads.
void H9GameInit(void)
{
	CVAR_REGISTER(&entmod_cvar);
	CVAR_REGISTER(&entmod_maps_cvar);
	CVAR_REGISTER(&entmod_preset_cvar);
	ALERT(at_console, "[EntMod] loaded. entmod=%d entmod_maps='%s' (tools turn on by 'entmap' in the map name, the entmod_maps list, or entmod 1)\n",
		(int)CVAR_GET_FLOAT("entmod"), CVAR_GET_STRING("entmod_maps"));
}

// Decide active state at each level start (after the cvars and any per-map config are in effect).
void H9OnServerActivate(edict_t * /*pEdictList*/, int /*edictCount*/, int /*clientMax*/)
{
	const char *map  = STRING(gpGlobals->mapname);
	const char *list = CVAR_GET_STRING("entmod_maps");
	int by_cvar = (CVAR_GET_FLOAT("entmod") != 0.0f);
	int by_name = name_has_entmap(map);
	int by_list = map_in_list(map, list ? list : "");
	g_entmod_active = by_cvar || by_name || by_list;

	// Print the decision so it is obvious in the server console why the tools are on or off, and so
	// the exact map name the gate saw is visible for diagnosis.
	ALERT(at_console, "[EntMod] map '%s' -> tools %s  (entmod=%d, entmap-in-name=%d, in-list=%d)\n",
		map ? map : "(null)", g_entmod_active ? "ON" : "off", by_cvar, by_name, by_list);

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
