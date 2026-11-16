#include "plugin.h"
#include "h9_hooks.h"
#include <string.h>

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
