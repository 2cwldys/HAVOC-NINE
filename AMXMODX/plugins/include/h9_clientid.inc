#if defined _h9_clientid_included
	#endinput
#endif
#define _h9_clientid_included

/**
 * h9_clientid, as the engine publishes it in userinfo.
 *
 * It has two shapes and a server must accept both, because the engine that sends the short one
 * is deployed separately from the plugins that read it:
 *
 *   32 lowercase hex      every H9XASH built so far
 *   7  lowercase base36   once engine-h9-clientid7 is built (0-9 a-z)
 *
 * The short form exists because h9_clientid is a userinfo value, and userinfo is one 256-byte
 * string shared by every key a client sets: the full MD5 spent an eighth of it on this one key.
 * Base36 rather than hex at that length because 36^7 is 78 billion against hex's 268 million,
 * and havoc9.org looks a client id up against EVERY account rather than the players on the
 * server, so a collision is one account resolving to another.
 *
 * Accepting both is what lets the engine, the plugins and EntMod be deployed in any order. Do
 * not narrow this to one shape until no client sends the other.
 */

#define H9_CID_HEX_LEN  32            // the long form
#define H9_CID_B36_LEN  7             // the short form
#define H9_CID_MAX      33            // a buffer that holds either, with its terminator

/**
 * Whether s is an h9_clientid of either shape. Upper case is lowered in place, as the old
 * per-plugin checks did, so a caller may rely on s being lowercase afterwards.
 *
 * A 32-character id must be hex: that is what the engine has always sent at that length, and
 * accepting base36 there would also accept an authid or a random string of the same size.
 * A 7-character id may use the whole base36 alphabet.
 */
stock bool:h9_cid_ok(s[])
{
	new i;

	for (i = 0; s[i]; i++)
	{
		if (s[i] >= 'A' && s[i] <= 'Z')
		{
			s[i] += 32;
		}
		if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'z')))
		{
			return false;
		}
	}

	if (i == H9_CID_B36_LEN)
	{
		return true;
	}

	if (i != H9_CID_HEX_LEN)
	{
		return false;
	}

	for (i = 0; s[i]; i++)
	{
		if (s[i] > 'f')
		{
			return false;
		}
	}

	return true;
}

/**
 * The slot's h9_clientid in out, lowercased, or an empty string when it has none or what it
 * announces is not one. Replaces the "read it, then test strlen() == 32" that each plugin
 * used to do for itself.
 */
stock bool:h9_cid_get(id, out[], len)
{
	out[0] = 0;
	get_user_info(id, "h9_clientid", out, len);

	if (!h9_cid_ok(out))
	{
		out[0] = 0;
		return false;
	}

	return true;
}
