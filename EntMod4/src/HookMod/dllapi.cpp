#include "hookmod.h"

// HookMod -- the game-DLL (DLL_FUNCTIONS) hook table. The handlers (hook.cpp) use RETURN_META
// directly, so the slots point straight at them. HookSpawn precaches on worldspawn; the grappling
// mechanic is driven from pfnClientCommand (+hook/-hook/hook_login), pfnPlayerPreThink (usekey +
// physics) and pfnStartFrame (tip projectile think). The round-reset sniffer is an engine post-hook
// on pfnAlertMessage (engine_api.cpp).

// H9: compute the entmap/entmod gate state at each level start (h9_gate.cpp).
static void mHookServerActivate(edict_t *l, int c, int m) { H9HookServerActivate(); RETURN_META(MRES_IGNORED); }

DLL_FUNCTIONS g_DllFunctionTable =
{
	HookGameDLLInit,		// pfnGameInit
	HookSpawn,				// pfnSpawn
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
	HookClientConnect,		// pfnClientConnect
	NULL,					// pfnClientDisconnect
	NULL,					// pfnClientKill
	HookClientPutInServer,	// pfnClientPutInServer
	HookClientCommand,		// pfnClientCommand
	NULL,					// pfnClientUserInfoChanged
	mHookServerActivate,	// pfnServerActivate
	NULL,					// pfnServerDeactivate
	HookPlayerPreThink,		// pfnPlayerPreThink
	NULL,					// pfnPlayerPostThink
	HookStartFrame,			// pfnStartFrame
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

DLL_FUNCTIONS g_DllFunctionTable_Post = { 0 };

NEW_DLL_FUNCTIONS g_NewDllFunctionTable = { 0 };
NEW_DLL_FUNCTIONS g_NewDllFunctionTable_Post = { 0 };

C_DLLEXPORT int GetEntityAPI2(DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion)
{
	if (!pFunctionTable)
		return FALSE;
	if (*interfaceVersion != INTERFACE_VERSION) {
		*interfaceVersion = INTERFACE_VERSION;
		return FALSE;
	}
	memcpy(pFunctionTable, &g_DllFunctionTable, sizeof(DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetEntityAPI2_Post(DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion)
{
	if (!pFunctionTable)
		return FALSE;
	if (*interfaceVersion != INTERFACE_VERSION) {
		*interfaceVersion = INTERFACE_VERSION;
		return FALSE;
	}
	memcpy(pFunctionTable, &g_DllFunctionTable_Post, sizeof(DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetNewDLLFunctions(NEW_DLL_FUNCTIONS *pNewFunctionTable, int *interfaceVersion)
{
	if (!pNewFunctionTable)
		return FALSE;
	if (*interfaceVersion != NEW_DLL_FUNCTIONS_VERSION) {
		*interfaceVersion = NEW_DLL_FUNCTIONS_VERSION;
		return FALSE;
	}
	memcpy(pNewFunctionTable, &g_NewDllFunctionTable, sizeof(NEW_DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetNewDLLFunctions_Post(NEW_DLL_FUNCTIONS *pNewFunctionTable, int *interfaceVersion)
{
	if (!pNewFunctionTable)
		return FALSE;
	if (*interfaceVersion != NEW_DLL_FUNCTIONS_VERSION) {
		*interfaceVersion = NEW_DLL_FUNCTIONS_VERSION;
		return FALSE;
	}
	memcpy(pNewFunctionTable, &g_NewDllFunctionTable_Post, sizeof(NEW_DLL_FUNCTIONS));
	return TRUE;
}
