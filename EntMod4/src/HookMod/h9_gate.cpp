#include "hookmod.h"
#include <string.h>
#include <ctype.h>

// ======================================================================================
// HAVOC9 gate -- HookMod is loaded on every map but INERT unless one of these is true:
//   1. the map name contains "entmap" (case-insensitive), the entmod-map naming convention,
//   2. the map name is in the `entmod_maps` cvar list, or
//   3. the server operator set `entmod 1`.
// This is the same gate EntMod uses (shared engine cvars entmod / entmod_maps). DF_hook_on remains
// the mod's own master switch on top of this. The ranked de-auth (no XP/ELO) is handled on the
// AMXX/backend side off the same signals. The decision is printed to the server console each map.
// ======================================================================================

static cvar_t g_entmod      = { "entmod", "0", FCVAR_SERVER };
static cvar_t g_entmod_maps = { "entmod_maps", "the_betterthanbest_entmap;the_betterthanbest_entmap2", FCVAR_SERVER };
static int    g_active = 0;

// Case-insensitive substring test for "entmap" -- the primary activation trigger.
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

// Register the shared gate cvars (idempotent: EntMod registers the same names; first wins, value is
// shared by name). Called from HookGameDLLInit.
void H9HookGameInit(void)
{
	CVAR_REGISTER(&g_entmod);
	CVAR_REGISTER(&g_entmod_maps);
}

// Decide active state at each level start.
void H9HookServerActivate(void)
{
	const char *map  = STRING(gpGlobals->mapname);
	const char *list = CVAR_GET_STRING("entmod_maps");
	int by_cvar = (CVAR_GET_FLOAT("entmod") != 0.0f);
	int by_name = name_has_entmap(map);
	int by_list = map_in_list(map, list ? list : "");
	g_active = by_cvar || by_name || by_list;

	ALERT(at_console, "[HookMod] map '%s' -> hook %s  (entmod=%d, entmap-in-name=%d, in-list=%d)\n",
		map ? map : "(null)", g_active ? "ON" : "off", by_cvar, by_name, by_list);
}

int H9HookActive(void)
{
	return g_active;
}
