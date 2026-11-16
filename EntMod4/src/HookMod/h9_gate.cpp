#include "hookmod.h"
#include <string.h>

// ======================================================================================
// HAVOC9 gate -- HookMod is loaded on every map but INERT unless this is a designated "entmap" or
// the server operator set `entmod 1`, the same gate EntMod uses (shared engine cvars entmod /
// entmod_maps). DF_hook_on remains the mod's own master switch on top of this. The ranked de-auth
// (no XP/ELO) is handled on the AMXX/backend side off the same signals.
// ======================================================================================

static cvar_t g_entmod      = { "entmod", "0", FCVAR_SERVER };
static cvar_t g_entmod_maps = { "entmod_maps", "the_betterthanbest_entmap;the_betterthanbest_entmap2", FCVAR_SERVER };
static int    g_active = 0;

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
	g_active = (CVAR_GET_FLOAT("entmod") != 0.0f) || map_in_list(map, list ? list : "");
}

int H9HookActive(void)
{
	return g_active;
}
