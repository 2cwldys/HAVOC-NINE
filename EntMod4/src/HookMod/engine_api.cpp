#include "hookmod.h"

// HookMod engine-function tables. Only one hook is used: a POST hook on pfnAlertMessage, to sniff
// the server log for "Round Start/Round End/Restart Round" and retract every active hook
// (HookAlertSniffer -> RoundReset). Everything else is NULL (no hook).
enginefuncs_t g_EngineFunctionsTable = { 0 };
enginefuncs_t g_EngineFunctionsTable_Post = { 0 };

C_DLLEXPORT int GetEngineFunctions(enginefuncs_t *pengfuncsFromEngine, int *interfaceVersion)
{
	if (!pengfuncsFromEngine)
		return FALSE;
	if (*interfaceVersion != ENGINE_INTERFACE_VERSION) {
		*interfaceVersion = ENGINE_INTERFACE_VERSION;
		return FALSE;
	}
	memcpy(pengfuncsFromEngine, &g_EngineFunctionsTable, sizeof(enginefuncs_t));
	return TRUE;
}

C_DLLEXPORT int GetEngineFunctions_Post(enginefuncs_t *pengfuncsFromEngine, int *interfaceVersion)
{
	if (!pengfuncsFromEngine)
		return FALSE;
	if (*interfaceVersion != ENGINE_INTERFACE_VERSION) {
		*interfaceVersion = ENGINE_INTERFACE_VERSION;
		return FALSE;
	}
	g_EngineFunctionsTable_Post.pfnAlertMessage = HookAlertSniffer;   // round-event log sniffer
	memcpy(pengfuncsFromEngine, &g_EngineFunctionsTable_Post, sizeof(enginefuncs_t));
	return TRUE;
}
