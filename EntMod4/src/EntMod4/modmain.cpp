#include <extdll.h>
#include <meta_api.h>

// EntMod4 -- recovered/reconstructed source. Metamod plugin for The Specialists on the H9XASH engine.
// Original by Drunken_F00l / remortal (adminop.net). Reconstruction in progress:
//   STAGE 1 (this file + h_export.cpp + dllapi.cpp + engine_api.cpp): the Metamod plugin skeleton and the
//   (currently empty) hook tables -- a plugin that loads and does nothing. The hook handlers (DFDispatch*,
//   DFClient*, DFPlayer*, the e_/es_ commands, entmover/entphaser/weaponcore/beam, the admin system) are
//   reconstructed module by module from the decompiled binary and filled into the tables in dllapi.cpp /
//   engine_api.cpp as they land.

meta_globals_t *gpMetaGlobals;
gamedll_funcs_t *gpGamedllFuncs;
mutil_funcs_t  *gpMetaUtilFuncs;

plugin_info_t Plugin_info =
{
	META_INTERFACE_VERSION,         // ifvers
	"Ent Mod",                      // name
	"4.0",                          // version
	__DATE__,                       // date
	"Drunken_F00l / remortal",      // author
	"http://www.adminop.net",       // url
	"ENTMOD",                       // logtag
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
