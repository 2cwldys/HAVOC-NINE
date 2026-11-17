#include "plugin.h"
#include "h9_hooks.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#ifdef _WIN32
#include <string.h>
#else
#include <strings.h>
#endif

// EntMod4 -- reconstructed: the admin system (original adminfuncs.cpp / entadmin.cpp; CheckAdmin @
// 0x467a0, IsAdmin @ 0x46710). CheckAdmin reads addons/EntMod/DF_admins.txt and grants admin flags
// to a player whose auth id and _entpass password match a line; IsAdmin tests a player's flags.
// DFStartFrame (dll.cpp) runs CheckAdmin on every client every 10 seconds; DFClientCommand (dll.cpp)
// gates the admin commands. The one H9 change (also accept the custom Xash id) is a seam -- see the
// marked line below and src/h9/h9_admin.cpp; the rest matches the original.

playerstate_t EntInfo3[ENT_MAXPLAYERS];
float NextAdminCheck = 0.0f;

// Does the player hold the given admin flag bits?  flags == 0 asks "is he any kind of admin at all".
int IsAdmin(edict_t *player, int flags)
{
	if (!UTIL_IsValidEntity(player))
		return 0;

	int idx = ENTINDEX(player);
	if (idx < 1 || idx > 32)
		return 0;

	if (flags == 0)
		return EntInfo3[idx].adminflags > 0;

	return EntInfo3[idx].adminflags & flags;
}

// Read addons/EntMod/DF_admins.txt and set this player's admin flags if a line's id matches his auth id
// and his _entpass matches the line's password.  A line is "id;password;flags":
//   id       the engine auth id (GETPLAYERAUTHID), or -1 for a wildcard (any id), or -- H9 addition --
//            the custom Xash id h9_clientid.
//   password compared caselessly to the player's "_entpass" userinfo value.
//   flags    the admin flag bits granted (a decimal number).
// Lines beginning with '#' or "//" and blank lines are skipped.
void CheckAdmin(edict_t *player)
{
	char path[256];
	snprintf(path, sizeof(path), "%s/addons/EntMod/DF_admins.txt", moddir);

	int idx = ENTINDEX(player);
	EntInfo3[idx].adminflags = 0;

	FILE *fp = fopen(path, "rt");
	if (!fp)
		return;

	const char *authid = GETPLAYERAUTHID(player);

	char line[100];
	while (fgets(line, sizeof(line), fp))
	{
		if (line[0] == '#' || line[0] == '\n' || line[0] == '\0')
			continue;
		if (strncmp(line, "//", 2) == 0)
			continue;
		if (strchr(line, ';') == NULL)
			continue;

		char *id      = strtok(line, ";");
		char *pass    = strtok(NULL, ";");
		char *flagtok = strtok(NULL, ";");
		if (!id || !pass || !flagtok)
			continue;

		char field1[128];
		strncpy(field1, id, sizeof(field1) - 1);
		field1[sizeof(field1) - 1] = '\0';
		long flags = strtol(flagtok, NULL, 10);

		// "-1" is the wildcard: it matches the LAN/invalid auth-id sentinel the engine returns.
		if (strcmp(field1, "-1") == 0)
			strcpy(field1, "4294967295");

		// Original: a line matches only when field 1 equals the engine auth id (GETPLAYERAUTHID).
		// --- H9 seam (src/h9/h9_admin.cpp): also accept the custom Xash id published as h9_clientid.
		if (strcmp(field1, authid) != 0 && !H9AdminIdMatch(player, field1))
			continue;

		// The password token runs up to the next ';' (strip any trailing field).
		for (char *p = pass; *p; ++p)
			if (*p == ';') { *p = '\0'; break; }

		const char *entpass = INFOKEY_VALUE(GET_INFOKEYBUFFER(player), "_entpass");
		if (strcasecmp(entpass, pass) == 0)
			EntInfo3[idx].adminflags = (int)flags;
	}

	fclose(fp);
}
