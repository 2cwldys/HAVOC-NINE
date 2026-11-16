#include "hookmod.h"

// HookMod ("Hook Mod v5") -- reconstructed source. Metamod-only grappling-hook plugin for The
// Specialists on the H9XASH engine. Original by Drunken_F00l / Tony Paloma (adminop.net). This file
// + h_export.cpp + dllapi.cpp + engine_api.cpp are the Metamod plugin skeleton; the grappling
// mechanic lives in hook.cpp and the cvars in cvars.cpp.

meta_globals_t *gpMetaGlobals;
gamedll_funcs_t *gpGamedllFuncs;
mutil_funcs_t  *gpMetaUtilFuncs;

plugin_info_t Plugin_info =
{
	META_INTERFACE_VERSION,         // ifvers
	"Hook Mod",                     // name
	"5.0",                          // version
	__DATE__,                       // date
	"Drunken_F00l / Tony Paloma",   // author
	"http://www.adminop.net",       // url
	"HOOKMOD",                      // logtag
	PT_ANYTIME,                     // (when) loadable
	PT_ANYTIME,                     // (when) unloadable
};

C_DLLEXPORT int Meta_Query(char *interfaceVersion, plugin_info_t **plinfo, mutil_funcs_t *pMetaUtilFuncs)
{
	*plinfo = &Plugin_info;
	gpMetaUtilFuncs = pMetaUtilFuncs;
	return TRUE;
}

META_FUNCTIONS gMetaFunctionTable =
{
	NULL,                       // pfnGetEntityAPI
	NULL,                       // pfnGetEntityAPI_Post
	GetEntityAPI2,              // pfnGetEntityAPI2
	GetEntityAPI2_Post,         // pfnGetEntityAPI2_Post
	GetNewDLLFunctions,         // pfnGetNewDLLFunctions
	GetNewDLLFunctions_Post,    // pfnGetNewDLLFunctions_Post
	GetEngineFunctions,         // pfnGetEngineFunctions
	GetEngineFunctions_Post,    // pfnGetEngineFunctions_Post
};

C_DLLEXPORT int Meta_Attach(PLUG_LOADTIME now, META_FUNCTIONS *pFunctionTable, meta_globals_t *pMGlobals, gamedll_funcs_t *pGamedllFuncs)
{
	gpMetaGlobals = pMGlobals;
	gpGamedllFuncs = pGamedllFuncs;
	memcpy(pFunctionTable, &gMetaFunctionTable, sizeof(META_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int Meta_Detach(PLUG_LOADTIME now, PL_UNLOAD_REASON reason)
{
	return TRUE;
}
