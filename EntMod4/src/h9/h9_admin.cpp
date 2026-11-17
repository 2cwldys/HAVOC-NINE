#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>
#include <stdio.h>

// ======================================================================================
// HAVOC9 addition -- admin identity parity (DF_admins.txt).
//
// Stock EntMod (entadmin.cpp CheckAdmin) matches a DF_admins.txt line's field 1 only against the
// engine auth id returned by GETPLAYERAUTHID -- the SteamID on a Steam server, "ID_<32hex>" on
// H9XASH. This seam additionally accepts the custom Xash id that the H9 client publishes in the
// "h9_clientid" userinfo key, so an account-derived id can authorise an admin as well.
//
// The id is read through the same userinfo path EntMod already uses for the "_entpass" password.
// _entpass is still required on top, so this only widens WHICH id selects a line, never the
// credential: an admin must still know the secret password. See docs DF_admins example.
// ======================================================================================

int H9AdminIdMatch(edict_t *player, const char *field1)
{
	const char *h9id = INFOKEY_VALUE(GET_INFOKEYBUFFER(player), "h9_clientid");
	if (h9id && h9id[0] && strcmp(field1, h9id) == 0)
		return 1;
	return 0;
}

// ======================================================================================
// HAVOC9 addition -- the "entmod_myid" console command.
//
// A player types "entmod_myid" in their OWN console and EntMod prints their ids back privately: the
// engine auth id (GETPLAYERAUTHID -- the SteamID on Steam, "ID_<32hex>" on H9XASH) and the custom
// h9_clientid published in userinfo. Either can be field 1 of a DF_admins.txt line, so this is how a
// would-be admin finds their id without digging through the server-console "status" output. It needs
// no admin and works on any map (you need it BEFORE you are an admin), so mClientCommand calls it
// ahead of the entmap/entmod gate. Private by construction: CLIENT_PRINTF to print_console reaches
// only this one player's console -- the very console they just typed the command into. szMsg is not a
// printf format (it is sent verbatim and printed client-side with "%s"), so an id is safe to pass.
// ======================================================================================
int H9HandleIdCommand(edict_t *player)
{
	if (!player)
		return 0;
	const char *cmd = CMD_ARGV(0);
	if (!cmd || strcasecmp(cmd, "entmod_myid") != 0)
		return 0;

	const char *authid = GETPLAYERAUTHID(player);
	if (!authid || !authid[0])
		authid = "(none -- not authenticated)";
	const char *h9id = INFOKEY_VALUE(GET_INFOKEYBUFFER(player), "h9_clientid");
	if (!h9id || !h9id[0])
		h9id = "(not published by this client)";

	char line[288];
	CLIENT_PRINTF(player, print_console, "----- your EntMod admin ids -----\n");
	snprintf(line, sizeof(line), "  engine auth id : %s\n", authid);
	CLIENT_PRINTF(player, print_console, line);
	snprintf(line, sizeof(line), "  h9_clientid    : %s\n", h9id);
	CLIENT_PRINTF(player, print_console, line);
	CLIENT_PRINTF(player, print_console, "  Add either as field 1 of a line in addons/EntMod/DF_admins.txt:\n");
	CLIENT_PRINTF(player, print_console, "      <id>;<a password you pick>;65535\n");
	CLIENT_PRINTF(player, print_console, "  then type in console:  setinfo _entpass <the same password>\n");
	return 1;
}
