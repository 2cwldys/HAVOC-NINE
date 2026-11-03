// h9_presence.inc -- havoc9.org accounts in game, for AMX Mod X plugins
//
// h9_presence.amxx (1.9 or later) answers these natives. It goes in plugins.ini above any plugin
// that includes this file. Its other natives, a server's key and h9web calls, are in
// h9_community.inc; a plugin may include both. docs\H9_PRESENCE.txt is the guide (section 4b).
//
// WHO HAS AN ACCOUNT. h9p_account gives a player's havoc9.org account only once h9web has PROVEN
// it: the player's game (H9XASH) answered h9_presence's ID proof for the account's own player id
// (docs\H9_PRESENCE.txt, section 8), so a copied h9_clientid gets nobody's account. These are the
// players with the green chain on the scoreboard. The proof needs h9_presence_challenge 1, or
// h9_require_account 1; with neither, nobody has an account here. A Steam (GoldSrc) game cannot
// prove one.
//
// WHEN. Never at once: a player's account comes a second or two after they are in game (the proof
// and h9web's answer to the report that carries it), and again at every map change, as each map
// starts with nothing known. h9p_account_changed says when; until then h9p_account is 0. A plugin
// that gives rights by account does it in the forward, and takes them back there too (account 0).
//
// TRUST. The account, the username and the roles are h9web's word, in its answer to h9_presence's
// signed report; no player or other server can set them. The roles are the account's as havoc9.org
// has them now: a role given or taken away on the site comes with the next answer (one every 60
// seconds at the most, or a few seconds after anyone joins or leaves).
//
// A plugin that should still load without h9_presence sets a native filter (set_native_filter)
// that lets these natives go unbound, as tsm_api.inc describes for its own, and calls none of them
// unless LibraryExists("h9_presence", LibType_Library).

#if defined _h9_presence_included
	#endinput
#endif
#define _h9_presence_included

/* ---- the roles h9p_roles gives, comma-separated, in this order -------------------------- */

// h9_admin       one of havoc9.org's site admins (H9's own staff)
// h9_moderator   one of havoc9.org's moderators
// owner          the owner of this server's community (docs\H9_COMMUNITIES.txt)
// staff          the community's owner or one of the admins the owner names
// member         a member of the community (its owner and its admins always are)
// A server in no community gets the site's two alone; most players have none.

/**
 * The player's proven havoc9.org account: its number on the site (accounts.id, as the profile at
 * https://havoc9.org/api/link/profile/<account> takes it), or 0 for no account, an unproven game,
 * a bot, an empty slot, or not yet.
 */
native h9p_account(id);

/**
 * That account's username on havoc9.org (its current one: a rename on the site follows), in out.
 * Returns false, with out "", when the player has no account (h9p_account 0).
 */
native h9p_account_name(id, out[], len);

/**
 * That account's roles, comma-separated, as listed above ("" for an account with none), in out;
 * 96 cells hold them all. Returns false, with out "", when the player has no account.
 */
native h9p_roles(id, out[], len);

/**
 * What h9p_account, h9p_account_name or h9p_roles says for a slot changed: the answer that proves
 * the player (account > 0), a rename or another role on the site (the same account), an id that
 * changes in game, h9_unlink or a REVOKE on the site (account 0), or the player leaving (account 0).
 */
forward h9p_account_changed(id, account);

/** Whether h9p_roles(id) holds role, one of the words above. */
stock bool:h9p_has_role(id, const role[])
{
	new roles[96];
	if (!h9p_roles(id, roles, charsmax(roles)))
	{
		return false;
	}
	new word[32], n = 0;
	for (new i = 0; ; i++)
	{
		if (roles[i] == ',' || roles[i] == 0)
		{
			word[n] = 0;
			if (equal(word, role))
			{
				return true;
			}
			if (roles[i] == 0)
			{
				break;
			}
			n = 0;
		}
		else if (n < charsmax(word))
		{
			word[n++] = roles[i];
		}
	}
	return false;
}
