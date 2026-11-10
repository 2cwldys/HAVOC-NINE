/*
 * ApolloRP_VGui.inc -- H9: Apollo RP's menus on an H9 player's screen.
 *
 * Apollo RP's menus are AMX Mod X menus, the classic TS text menu. A player whose game draws H9 VGUI
 * (include\h9_vgui.inc, docs\H9_VGUI.txt) gets each of them as a framed panel in H9's purple art, with
 * the same rows, the same number keys and the same handler behind it; every other player, and every
 * server without the H9 client, and a player whose cl_h9_arpvgui is 0 (arpvgui_wanted), gets the text menu exactly as before.
 *
 * Two kinds of menu are in Apollo RP, and each has one call:
 *
 *   A text menu, built with format() and shown with show_menu(): arpvgui_show_menu() takes its place.
 *   It reads the panel's title and rows out of the same text and sends the text menu as well, so the
 *   register_menucmd() handler answers both and nothing else changes.
 *
 *   A menu made with menu_create() and menu_additem(), paged by AMX Mod X: arpvgui_menu_display()
 *   takes the place of menu_display(). For a player without H9 VGUI, or who does not want panels, it IS menu_display(). For an H9
 *   player it pages the same items itself, the way AMX Mod X does (seven to a page, 8 Back, 9 More,
 *   0 Exit), as a text menu with a panel for its twin, and calls the same handler with the same
 *   (id, menu, item): item is the number of the item in the whole menu, or MENU_EXIT. The menu stays
 *   an AMX Mod X menu that the handler reads (menu_item_getinfo) and destroys as ever; it is only not
 *   shown by AMX Mod X. A plugin that uses it defines ARPVGUI_PAGED before it includes this file.
 *
 * A plugin calls arpvgui_precache() in plugin_precache and arpvgui_init("<ns>") in plugin_init. Its
 * panels are "<ns>.<name>": 23 characters at most, a-z 0-9 . _ -.
 *
 * In a paged menu an item named "<name> - $<price>" or "<name> x <count>" is drawn as the name with
 * "$<price>" or "x <count>" after it, in the smaller font; a name is cut to 31 characters on the panel.
 */

#if defined _ApolloRP_VGui_included
	#endinput
#endif

#define _ApolloRP_VGui_included

#include <amxmodx>
#include <fakemeta>
#include <h9_vgui>

#if defined ARPVGUI_PAGED

#define ARPVGUI_PER_PAGE 7

stock g_av_menuname[40];                  // the text menu a paged menu is shown as
stock bool:g_av_on[MAX_PLAYERS + 1];      // whether the player has a paged menu of this plugin up
stock g_av_menu[MAX_PLAYERS + 1];         // its AMX Mod X menu
stock g_av_page[MAX_PLAYERS + 1];
stock g_av_panel[MAX_PLAYERS + 1][24];
stock g_av_title[MAX_PLAYERS + 1][40];
stock g_av_handler[MAX_PLAYERS + 1][32];  // the menu's handler, called with (id, menu, item)

#endif

/// In plugin_precache: registers H9Vgui, so every game learns it at connect.
stock arpvgui_precache()
{
	h9vgui_precache();
}

/// In plugin_init: this plugin's panels are "<ns>.*".
stock arpvgui_init(const ns[])
{
	h9vgui_init(ns);
#if defined ARPVGUI_PAGED
	formatex(g_av_menuname, charsmax(g_av_menuname), "ARP_Paged_%s", ns);
	register_menucmd(register_menuid(g_av_menuname), 1023, "__arpvgui_paged_key");
#endif
}

/// Whether the player wants Apollo RP's menus as panels: his game's cl_h9_arpvgui, which it keeps in the private
/// userinfo key _h9arpvgui ("0" off, "1" on). A game without the key (an older client) wants them.
stock bool:arpvgui_wanted(id)
{
	if (id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
	{
		return true;
	}
	new v[4];
	get_user_info(id, "_h9arpvgui", v, charsmax(v));
	return v[0] == EOS || str_to_num(v) != 0;
}

/// In place of show_menu(): the same text menu to everyone, and to an H9 player who wants panels the panel drawn from it.
stock arpvgui_show_menu(id, keys, const text[], time, const amx[], const panel[], const title[] = "")
{
	if (arpvgui_wanted(id))
	{
		h9vgui_show_menu(id, keys, text, time, amx, panel, title);
	}
	else
	{
		show_menu(id, keys, text, time, amx);
	}
}

#if defined ARPVGUI_PAGED

/// In place of menu_display(id, menu, page): `handler` is the name of the menu's handler (the one menu_create() was given).
stock arpvgui_menu_display(id, menu, const panel[], const title[], const handler[], page = 0)
{
	if (!g_av_menuname[0] || !h9vgui_supported(id) || !arpvgui_wanted(id))
	{
		return menu_display(id, menu, page);
	}
	g_av_on[id] = true;
	g_av_menu[id] = menu;
	g_av_page[id] = page;
	copy(g_av_panel[id], charsmax(g_av_panel[]), panel);
	copy(g_av_title[id], charsmax(g_av_title[]), title);
	copy(g_av_handler[id], charsmax(g_av_handler[]), handler);
	__arpvgui_page(id);
	return 1;
}

/// A menu item's name as the panel's row: the name, and "$<price>" or "x <count>" as its detail.
stock __arpvgui_split(const name[], label[], labellen, detail[], detaillen)
{
	new cut = -1, skip = 0;
	for (new i = strlen(name) - 4; i > 0; i--)
	{
		if (name[i] != ' ')
		{
			continue;
		}
		if (name[i + 1] == '-' && name[i + 2] == ' ' && name[i + 3] == '$')
		{
			cut = i;
			skip = 3;
			break;
		}
		if (name[i + 1] == 'x' && name[i + 2] == ' ' && name[i + 3] >= '0' && name[i + 3] <= '9')
		{
			cut = i;
			skip = 1;
			break;
		}
	}
	if (cut > 0)
	{
		copy(label, min(labellen, cut), name);
		copy(detail, detaillen, name[cut + skip]);
	}
	else
	{
		copy(label, labellen, name);
		detail[0] = EOS;
	}
	trim(label);
	trim(detail);
}

/// The player's current page of his paged menu: its panel's rows and the text menu that stands for them.
stock __arpvgui_page(id)
{
	new menu = g_av_menu[id];
	new count = menu_items(menu);
	new pages = max(1, (count + ARPVGUI_PER_PAGE - 1) / ARPVGUI_PER_PAGE);
	g_av_page[id] = clamp(g_av_page[id], 0, pages - 1);
	new page = g_av_page[id];
	new first = page * ARPVGUI_PER_PAGE;

	new title[56];
	if (pages > 1)
	{
		formatex(title, charsmax(title), "%s %d/%d", g_av_title[id], page + 1, pages);
	}
	else
	{
		copy(title, charsmax(title), g_av_title[id]);
	}

	h9vgui_menu_begin(g_av_panel[id], title);
	new text[640];
	new pos = formatex(text, charsmax(text), "\y%s^n^n", title);
	new keys = MENU_KEY_0;
	for (new k = 0; k < ARPVGUI_PER_PAGE && first + k < count; k++)
	{
		new access, callback, info[2], name[64], label[32], detail[32];
		menu_item_getinfo(menu, first + k, access, info, charsmax(info), name, charsmax(name), callback);
		__arpvgui_split(name, label, charsmax(label), detail, charsmax(detail));
		h9vgui_menu_row(k + 1, 0, label, detail);
		if (detail[0])
		{
			pos += formatex(text[pos], charsmax(text) - pos, "\y%d. \w%s  \d%s^n", k + 1, label, detail);
		}
		else
		{
			pos += formatex(text[pos], charsmax(text) - pos, "\y%d. \w%s^n", k + 1, label);
		}
		keys |= (1 << k);
	}
	new flags = H9V_GAP;
	pos += formatex(text[pos], charsmax(text) - pos, "^n");
	if (page > 0)
	{
		h9vgui_menu_row(8, flags, "Back");
		flags = 0;
		pos += formatex(text[pos], charsmax(text) - pos, "\y8. \wBack^n");
		keys |= MENU_KEY_8;
	}
	if (page < pages - 1)
	{
		h9vgui_menu_row(9, flags, "More");
		flags = 0;
		pos += formatex(text[pos], charsmax(text) - pos, "\y9. \wMore^n");
		keys |= MENU_KEY_9;
	}
	h9vgui_menu_row(10, flags, "Exit");
	formatex(text[pos], charsmax(text) - pos, "\y0. \wExit");
	h9vgui_menu_send(id, keys, text, -1, g_av_menuname);
}

/// A key of a paged menu, 0-based: 0-6 the page's items, 7 back, 8 more, 9 exit.
public __arpvgui_paged_key(id, key)
{
	if (id < 1 || id > MAX_PLAYERS || !g_av_on[id])
	{
		return PLUGIN_HANDLED;
	}
	new count = menu_items(g_av_menu[id]);
	new pages = max(1, (count + ARPVGUI_PER_PAGE - 1) / ARPVGUI_PER_PAGE);
	new page = g_av_page[id];
	if (key == 9)
	{
		__arpvgui_pick(id, MENU_EXIT);
	}
	else if (key == 7 && page > 0)
	{
		g_av_page[id] = page - 1;
		__arpvgui_page(id);
	}
	else if (key == 8 && page < pages - 1)
	{
		g_av_page[id] = page + 1;
		__arpvgui_page(id);
	}
	else if (key < ARPVGUI_PER_PAGE && page * ARPVGUI_PER_PAGE + key < count)
	{
		__arpvgui_pick(id, page * ARPVGUI_PER_PAGE + key);
	}
	return PLUGIN_HANDLED;
}

/// The menu's handler, as AMX Mod X calls it: (id, menu, item) with item the menu's item, or MENU_EXIT.
stock __arpvgui_pick(id, item)
{
	new menu = g_av_menu[id];
	new handler[32];
	copy(handler, charsmax(handler), g_av_handler[id]);
	g_av_on[id] = false;
	if (callfunc_begin(handler) == 1)
	{
		callfunc_push_int(id);
		callfunc_push_int(menu);
		callfunc_push_int(item);
		callfunc_end();
	}
}

#endif
