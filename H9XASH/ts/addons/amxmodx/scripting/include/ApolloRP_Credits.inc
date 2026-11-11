/*
 * ApolloRP_Credits.inc -- H9: the credit sign.
 *
 * With arp_h9_credits 1 a player whose game can draw the credit sign (the userinfo key _h9vgui says H9VGUI_CREDIT_PROTOCOL or more, include\h9_vgui.inc)
 * is shown it in place of the "$" of every amount of money Apollo RP prints for him: "$1,250" reads "<sign>1,250". Every other player, a bot, every log
 * and anything a plugin parses keep "$", and so does a server with arp_h9_credits 0 or without ARP_Inventory (which registers the cvar).
 *
 * The sign has two spellings, and the one used is the one the text's destination takes:
 *   chat, console and centre text (client_print)       U+00A2 as UTF-8, the two bytes 0xC2 0xA2
 *   the text of an H9 panel (menus, the HUD panel)     the single byte 0xA2 (Latin-1), which the panels draw
 * The classic AMX Mod X text menu and a hudmessage are drawn in the HUD font, which has no such glyph: they keep "$".
 * A "$" is converted when a digit follows it.
 *
 * Why client_print is redirected here. AMX Mod X sends the message of client_print itself, straight to the engine, and register_message() only sees the
 * messages the game sends, so no message hook can reach it. Every Apollo RP plugin includes this file through ApolloRP.inc, and the macro at its end sends
 * every client_print to arp_client_print, which converts the text for the players who can draw the sign and gives it to the real client_print. ARP_Commands
 * includes this file before amxmisc.inc, so that show_activity (a stock that calls client_print) is redirected too.
 *
 * Panel text is converted where the panel is built: arpvgui_show_menu and the paged menus (ApolloRP_VGui.inc) and the HUD panel lines of ARP_Core.
 */

#if defined _ApolloRP_Credits_included
	#endinput
#endif

#define _ApolloRP_Credits_included

#include <amxmodx>
#include <h9_vgui>

#define ARP_CREDIT_BYTE 0xA2          // the sign as one byte, in the text of a panel

/// Whether this player is shown the credit sign: arp_h9_credits is 1 and his game says _h9vgui H9VGUI_CREDIT_PROTOCOL or more (with h9_vgui 1). A bot, a
/// player who is not in the game and the console (id 0) are not.
stock bool:arp_credit_sign(id)
{
	static credits, vgui;

	if (!credits)
	{
		credits = get_cvar_pointer("arp_h9_credits");
	}
	if (!credits || !get_pcvar_num(credits))
	{
		return false;
	}
	if (id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id))
	{
		return false;
	}
	if (!vgui)
	{
		vgui = get_cvar_pointer("h9_vgui");
	}
	if (vgui && !get_pcvar_num(vgui))
	{
		return false;
	}
	new v[8];
	get_user_info(id, "_h9vgui", v, charsmax(v));
	return str_to_num(v) >= H9VGUI_CREDIT_PROTOCOL;
}

/// Converts, in place, every "$" that a digit follows: to the single byte 0xA2 (utf8 false), or to the UTF-8 pair 0xC2 0xA2 (utf8 true: the text grows a
/// byte for each, and a "$" stays when the text would then not fit in `size` cells with its terminator). Returns how many were converted.
stock arp_credit_convert(text[], size, bool:utf8)
{
	new n = strlen(text), done;

	for (new i = 0; i < n; i++)
	{
		if (text[i] != '$' || text[i + 1] < '0' || text[i + 1] > '9')
		{
			continue;
		}
		if (!utf8)
		{
			text[i] = ARP_CREDIT_BYTE;
			done++;
			continue;
		}
		if (n + 1 >= size)
		{
			continue;
		}
		for (new j = n; j > i; j--)
		{
			text[j + 1] = text[j];
		}
		text[i] = 0xC2;
		text[i + 1] = 0xA2;
		n++;
		i++;
		done++;
	}
	return done;
}

/// The text a panel draws for this player: when he is shown the sign and `text` has a "$" that a digit follows, `out` gets the text with the single-byte
/// sign and the number converted is returned; otherwise 0 is returned and `out` is not touched (use `text`).
stock arp_credit_panel_text(id, const text[], out[], size)
{
	if (contain(text, "$") == -1 || strlen(text) >= size || !arp_credit_sign(id))
	{
		return 0;
	}
	copy(out, size - 1, text);
	return arp_credit_convert(out, size, false);
}

// H9: ARP_Core shows a print_chat line that starts with [ARP] as a popup when arp_h9_toast says so and the player's game draws H9 panels (it answers 0: print it)
native ARP_H9Toast(id, const text[]);

stock __arp_credit_send(id, type, const text[])
{
	if (type == print_chat && id >= 1 && text[0] == '[')
	{
		new shown = ARP_H9Toast(id, text);
		if (shown == 1)
		{
			return 0;
		}
	}
	if (contain(text, "$") != -1 && arp_credit_sign(id))
	{
		static out[512];
		copy(out, charsmax(out), text);
		// the limits of client_print: 126 bytes of console text, 189 of chat and centre text; a longer text is cut there as it always was
		arp_credit_convert(out, (type == print_notify || type == print_console) ? 127 : 190, true);
		return client_print(id, type, "%s", out);
	}
	return client_print(id, type, "%s", text);
}

/// client_print as it is, whatever the player: for text that is not Apollo RP's to change, what players type in the talk area (ApolloRP_Chat.inc).
stock arp_print_plain(id, type, const text[])
{
	return client_print(id, type, "%s", text);
}

/// client_print for the players who can be shown the credit sign; id 0 is every player, each with his own text. Every Apollo RP plugin's client_print is this.
stock arp_client_print(id, type, const fmt[], any:...)
{
	static text[512];
	new len = vformat(text, charsmax(text), fmt, 4);

	if (id)
	{
		return __arp_credit_send(id, type, text);
	}
	new players[MAX_PLAYERS], num;
	get_players(players, num);
	for (new i = 0; i < num; i++)
	{
		__arp_credit_send(players[i], type, text);
	}
	return len;
}

#define client_print arp_client_print
