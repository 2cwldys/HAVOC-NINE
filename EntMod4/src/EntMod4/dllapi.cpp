#include <extdll.h>
#include <meta_api.h>
#include "plugin.h"
#include "h9_hooks.h"

// admin-path hook handlers (dll.cpp)
void DFGameDLLInit(void);
qboolean DFClientConnect(edict_t *pEntity, const char *pszName, const char *pszAddress, char szRejectReason[128]);
void DFClientDisconnect(edict_t *pEntity);
void DFClientPutInServer(edict_t *pEntity);
int DFClientCommand(edict_t *pEntity);
void DFStartFrame(void);

// --- metamod-style pre-hook thunks for the DF* entity-dispatch handlers (dispatch.cpp) ---
// The DF* handlers return int (1 = EntMod handled this call, suppress the game DLL; 0 = pass
// through) -- the standalone-shim convention. The DLL_FUNCTIONS table needs metamod handlers that
// turn that into RETURN_META, the same way dll.cpp's admin-path handlers do. PlayerPreThink/
// PostThink and ServerActivate/Deactivate are additive (EntMod runs, then the game runs).
static int  mSpawn(edict_t *e)             { if (DFDispatchSpawn(e))    RETURN_META_VALUE(MRES_SUPERCEDE, 0); RETURN_META_VALUE(MRES_IGNORED, 0); }
static void mThink(edict_t *e)             { if (DFDispatchThink(e))    RETURN_META(MRES_SUPERCEDE); RETURN_META(MRES_IGNORED); }
static void mUse(edict_t *a, edict_t *b)   { if (DFDispatchUse(a, b))   RETURN_META(MRES_SUPERCEDE); RETURN_META(MRES_IGNORED); }
static void mTouch(edict_t *a, edict_t *b) { if (DFDispatchTouch(a, b)) RETURN_META(MRES_SUPERCEDE); RETURN_META(MRES_IGNORED); }
static void mBlocked(edict_t *a, edict_t *b){ if (DFDispatchBlocked(a, b)) RETURN_META(MRES_SUPERCEDE); RETURN_META(MRES_IGNORED); }
static void mKeyValue(edict_t *e, KeyValueData *kvd) { if (DFDispatchKeyValue(e, kvd)) RETURN_META(MRES_SUPERCEDE); RETURN_META(MRES_IGNORED); }
static void mPlayerPreThink(edict_t *e)    { if (H9EntModActive()) DFPlayerPreThink(e);  RETURN_META(MRES_IGNORED); }
static void mPlayerPostThink(edict_t *e)   { if (H9EntModActive()) DFPlayerPostThink(e); RETURN_META(MRES_IGNORED); }
// H9: compute the entmap/entmod gate state at each level start.
static void mServerActivate(edict_t *l, int c, int m) { DFServerActivate(l, c, m); H9OnServerActivate(l, c, m); RETURN_META(MRES_IGNORED); }
static void mServerDeactivate(void)        { DFServerDeactivate(); RETURN_META(MRES_IGNORED); }
// H9: EntMod's admin/entity commands only work when the gate is active (entmap or `entmod 1`).
static void mClientCommand(edict_t *e)     { if (H9HandleIdCommand(e)) RETURN_META(MRES_SUPERCEDE); if (H9EntModActive() && DFClientCommand(e)) RETURN_META(MRES_SUPERCEDE); RETURN_META(MRES_IGNORED); }

DLL_FUNCTIONS g_DllFunctionTable =
{
	DFGameDLLInit,			// pfnGameInit
	mSpawn,					// pfnSpawn
	mThink,					// pfnThink
	mUse,					// pfnUse
	mTouch,					// pfnTouch
	mBlocked,				// pfnBlocked
	mKeyValue,				// pfnKeyValue
	NULL,					// pfnSave
	NULL,					// pfnRestore
	NULL,					// pfnSetAbsBox
	NULL,					// pfnSaveWriteFields
	NULL,					// pfnSaveReadFields
	NULL,					// pfnSaveGlobalState
	NULL,					// pfnRestoreGlobalState
	NULL,					// pfnResetGlobalState
	DFClientConnect,		// pfnClientConnect
	DFClientDisconnect,		// pfnClientDisconnect
	NULL,					// pfnClientKill
	DFClientPutInServer,	// pfnClientPutInServer
	mClientCommand,			// pfnClientCommand
	NULL,					// pfnClientUserInfoChanged
	mServerActivate,		// pfnServerActivate
	mServerDeactivate,		// pfnServerDeactivate
	mPlayerPreThink,		// pfnPlayerPreThink
	mPlayerPostThink,		// pfnPlayerPostThink
	DFStartFrame,			// pfnStartFrame
	NULL,					// pfnParmsNewLevel
	NULL,					// pfnParmsChangeLevel
	NULL,					// pfnGetGameDescription
	NULL,					// pfnPlayerCustomization
	NULL,					// pfnSpectatorConnect
	NULL,					// pfnSpectatorDisconnect
	NULL,					// pfnSpectatorThink
	NULL,					// pfnSys_Error
	NULL,					// pfnPM_Move
	NULL,					// pfnPM_Init
	NULL,					// pfnPM_FindTextureType
	NULL,					// pfnSetupVisibility
	NULL,					// pfnUpdateClientData
	NULL,					// pfnAddToFullPack
	NULL,					// pfnCreateBaseline
	NULL,					// pfnRegisterEncoders
	NULL,					// pfnGetWeaponData
	NULL,					// pfnCmdStart
	NULL,					// pfnCmdEnd
	NULL,					// pfnConnectionlessPacket
	NULL,					// pfnGetHullBounds
	NULL,					// pfnCreateInstancedBaselines
	NULL,					// pfnInconsistentFile
	NULL,					// pfnAllowLagCompensation
};

DLL_FUNCTIONS g_DllFunctionTable_Post =
{
	NULL,					// pfnGameInit
	NULL,					// pfnSpawn
	NULL,					// pfnThink
	NULL,					// pfnUse
	NULL,					// pfnTouch
	NULL,					// pfnBlocked
	NULL,					// pfnKeyValue
	NULL,					// pfnSave
	NULL,					// pfnRestore
	NULL,					// pfnSetAbsBox
	NULL,					// pfnSaveWriteFields
	NULL,					// pfnSaveReadFields
	NULL,					// pfnSaveGlobalState
	NULL,					// pfnRestoreGlobalState
	NULL,					// pfnResetGlobalState
	NULL,					// pfnClientConnect
	NULL,					// pfnClientDisconnect
	NULL,					// pfnClientKill
	NULL,					// pfnClientPutInServer
	NULL,					// pfnClientCommand
	NULL,					// pfnClientUserInfoChanged
	NULL,					// pfnServerActivate
	NULL,					// pfnServerDeactivate
	NULL,					// pfnPlayerPreThink
	NULL,					// pfnPlayerPostThink
	NULL,					// pfnStartFrame
	NULL,					// pfnParmsNewLevel
	NULL,					// pfnParmsChangeLevel
	NULL,					// pfnGetGameDescription
	NULL,					// pfnPlayerCustomization
	NULL,					// pfnSpectatorConnect
	NULL,					// pfnSpectatorDisconnect
	NULL,					// pfnSpectatorThink
	NULL,					// pfnSys_Error
	NULL,					// pfnPM_Move
	NULL,					// pfnPM_Init
	NULL,					// pfnPM_FindTextureType
	NULL,					// pfnSetupVisibility
	NULL,					// pfnUpdateClientData
	NULL,					// pfnAddToFullPack
	NULL,					// pfnCreateBaseline
	NULL,					// pfnRegisterEncoders
	NULL,					// pfnGetWeaponData
	NULL,					// pfnCmdStart
	NULL,					// pfnCmdEnd
	NULL,					// pfnConnectionlessPacket
	NULL,					// pfnGetHullBounds
	NULL,					// pfnCreateInstancedBaselines
	NULL,					// pfnInconsistentFile
	NULL,					// pfnAllowLagCompensation
};

NEW_DLL_FUNCTIONS g_NewDllFunctionTable =
{
	NULL,					//! pfnOnFreeEntPrivateData()	Called right before the object's memory is freed.  Calls its destructor.
	NULL,					//! pfnGameShutdown()
	NULL,					//! pfnShouldCollide()
	NULL,					//! pfnCvarValue()
	NULL,					//! pfnCvarValue2()
};

NEW_DLL_FUNCTIONS g_NewDllFunctionTable_Post =
{
	NULL,					//! pfnOnFreeEntPrivateData()	Called right before the object's memory is freed.  Calls its destructor.
	NULL,					//! pfnGameShutdown()
	NULL,					//! pfnShouldCollide()
	NULL,					//! pfnCvarValue()
	NULL,					//! pfnCvarValue2()
};

C_DLLEXPORT int GetEntityAPI2(DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion)
{
	if (!pFunctionTable) {
		ALERT(at_logged, "%s called with null pFunctionTable", __FUNCTION__);
		return FALSE;
	}
	if (*interfaceVersion != INTERFACE_VERSION) {
		ALERT(at_logged, "%s version mismatch; requested=%d ours=%d", __FUNCTION__, *interfaceVersion, INTERFACE_VERSION);
		*interfaceVersion = INTERFACE_VERSION;
		return FALSE;
	}

	memcpy(pFunctionTable, &g_DllFunctionTable, sizeof(DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetEntityAPI2_Post(DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion)
{
	if (!pFunctionTable) {
		ALERT(at_logged, "%s called with null pFunctionTable", __FUNCTION__);
		return FALSE;
	}
	if (*interfaceVersion != INTERFACE_VERSION) {
		ALERT(at_logged, "%s version mismatch; requested=%d ours=%d", __FUNCTION__, *interfaceVersion, INTERFACE_VERSION);
		*interfaceVersion = INTERFACE_VERSION;
		return FALSE;
	}

	memcpy(pFunctionTable, &g_DllFunctionTable_Post, sizeof(DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetNewDLLFunctions(NEW_DLL_FUNCTIONS *pNewFunctionTable, int *interfaceVersion)
{
	if (!pNewFunctionTable) {
		ALERT(at_logged, "%s called with null pNewFunctionTable", __FUNCTION__);
		return FALSE;
	}
	if (*interfaceVersion != NEW_DLL_FUNCTIONS_VERSION) {
		ALERT(at_logged, "%s version mismatch; requested=%d ours=%d", __FUNCTION__, *interfaceVersion, NEW_DLL_FUNCTIONS_VERSION);
		*interfaceVersion = NEW_DLL_FUNCTIONS_VERSION;
		return FALSE;
	}

	memcpy(pNewFunctionTable, &g_NewDllFunctionTable, sizeof(NEW_DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetNewDLLFunctions_Post(NEW_DLL_FUNCTIONS *pNewFunctionTable, int *interfaceVersion)
{
	if (!pNewFunctionTable) {
		ALERT(at_logged, "%s called with null pNewFunctionTable", __FUNCTION__);
		return FALSE;
	}
	if (*interfaceVersion != NEW_DLL_FUNCTIONS_VERSION) {
		ALERT(at_logged, "%s version mismatch; requested=%d ours=%d", __FUNCTION__, *interfaceVersion, NEW_DLL_FUNCTIONS_VERSION);
		*interfaceVersion = NEW_DLL_FUNCTIONS_VERSION;
		return FALSE;
	}

	memcpy(pNewFunctionTable, &g_NewDllFunctionTable_Post, sizeof(NEW_DLL_FUNCTIONS));
	return TRUE;
}
