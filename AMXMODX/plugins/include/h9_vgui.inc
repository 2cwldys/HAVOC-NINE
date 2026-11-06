/*
 * h9_vgui.inc -- H9 VGUI: real panels on an H9 player's screen, built from an AMX Mod X plugin.
 *
 * docs\H9_VGUI.txt is the design and, in its section 8, the plugin author's guide; the rules,
 * shortly:
 *
 *   1. h9vgui_precache() in plugin_precache, h9vgui_init("yours") in plugin_init. Your panel ids
 *      are then "yours.<name>": 23 characters at most, a-z 0-9 . _ -.
 *   2. Send only through these stocks. They open every message with engfunc(EngFunc_MessageBegin,
 *      MSG_ONE, ...) -- Metamod-R does not record a plugin's messages, so AMX Mod X's
 *      message_begin refuses them -- keep each under 188 bytes, and send nothing to a player
 *      whose game cannot draw it (h9vgui_supported).
 *   3. A menu through h9vgui_show_menu() and a notice through h9vgui_notice() fall back to text
 *      by themselves, and so does h9vgui_alert() for what used to be a set_hudmessage and a
 *      show_hudmessage. For a panel, test h9vgui_supported(id) and give everyone else a menu.
 *   4. Placement: anchors are relative to the client's safe area. It starts 136 px from the top,
 *      under TS's kill notices ("is The Specialist", the killing sprees), and ends above the chat
 *      and TS's HUD; the client moves anything that leaves it back inside, and keeps a panel off
 *      the crosshair. Leave the centre column between 0.19 and 0.40 of the height to the HUD's
 *      centred messages. A menu goes in the left column, as AMX text menus do.
 *   5. A panel takes no mouse and no keyboard: its buttons answer their number keys. ESC always
 *      closes it, and the player's cl_h9_vgui 0 refuses every panel.
 *   6. Images: "#panel" and "#banner" (sprites/tsm_panel.spr and tsm_banner.spr), nothing else.
 *   7. A panel's reply is the client command "h9vgui <id> <control> <value>", given to your public
 *      h9vgui_event(id, const panel[], ctl, const value[]) for your own ids only. Anyone can type
 *      one at any time: check your own state before acting on it.
 *   8. Send a panel once, then h9vgui_set_*(); a menu re-offered with the same rows costs only its
 *      TWIN.
 *   9. A status (h9vgui_status) stays until its slot gets another or an empty one, and its clock
 *      counts down on the player's own screen: send it again only when what it says changes.
 *      Only games of protocol 2 draw one; it says whether it was sent, so the caller can give
 *      every other player its hudmessage.
 *  10. A mark (h9vgui_mark) is a point of the world drawn on the player's screen through the walls,
 *      and in the row of marks under the top stack. Only games of protocol 3 draw one; it says whether
 *      it was sent, so the caller can give every other player what it has (ts_assault falls back to
 *      TS's own Objective markers). It stays until another takes its slot or it is taken down, so
 *      send it again when it changes, and now and then for a game that joined late.
 *
 * h9_vgui 1 (a server cvar, registered by the first plugin that calls h9vgui_init) lets these
 * stocks send; 0 gives every player the text.
 */

#if defined _h9_vgui_included
	#endinput
#endif
#define _h9_vgui_included

#include <amxmodx>
#include <fakemeta>

#define H9VGUI_PROTOCOL  1       // the version this include speaks; _h9vgui must be at least it
#define H9VGUI_STATUS_PROTOCOL 2 // the first _h9vgui whose game draws a STATUS
#define H9VGUI_MARK_PROTOCOL 3   // the first _h9vgui whose game draws a MARK
#define H9VGUI_MSG_MAX   188     // bytes a message may carry: GoldSrc's 192 less a margin

// Ops: the first byte of an H9Vgui message.
#define H9V_OP_MENU      1
#define H9V_OP_ROWS      2
#define H9V_OP_TWIN      3
#define H9V_OP_PANEL     10
#define H9V_OP_CTRL      11
#define H9V_OP_SET       12
#define H9V_OP_SHOW      13
#define H9V_OP_HIDE      14
#define H9V_OP_CLOSE     15
#define H9V_OP_COMMIT    16
#define H9V_OP_NOTICE    20
#define H9V_OP_STATUS    21      // protocol 2: a notice that stays, its clock counted by the client
#define H9V_OP_MARK      22      // protocol 3: a point of the world, drawn on the screen through the walls

// Anchors, relative to the safe area.
#define H9V_TL  0
#define H9V_T   1
#define H9V_TR  2
#define H9V_L   3
#define H9V_C   4
#define H9V_R   5
#define H9V_BL  6
#define H9V_B   7
#define H9V_BR  8

// Menu styles.
#define H9V_MENU_PANEL   0       // on the tsm_panel art
#define H9V_MENU_BANNER  1       // on the tsm_banner art
#define H9V_MENU_PLAIN   2       // on a plain dark box

// Row flags.
#define H9V_DIM  1               // dim, still pressable
#define H9V_RED  2
#define H9V_GAP  4               // a blank half row above it
#define H9V_HOT  8               // highlighted
#define H9V_OFF  16              // dim and not pressable

// Notice styles.
#define H9V_NOTICE_TEXT    0     // plain text
#define H9V_NOTICE_BANNER  1     // on the tsm_banner art
#define H9V_NOTICE_FLASH   2     // large text
#define H9V_NOTICE_BAR     3     // on the banner art, over a progress bar

// Panel flags.
#define H9V_MODAL  1             // asks for the mouse; this client keeps every panel keys only
#define H9V_KEEP   2             // stays open over death and respawn

// Controls, fonts and alignment.
#define H9V_LABEL     1
#define H9V_IMAGE     2
#define H9V_BUTTON    3
#define H9V_PROGRESS  4
#define H9V_FONT_TEXT    0
#define H9V_FONT_TITLE   1
#define H9V_FONT_DETAIL  2
#define H9V_FONT_FLASH   3
#define H9V_LEFT    0
#define H9V_CENTRE  1
#define H9V_RIGHT   2

#define H9V_MAX_ROWS  16

stock g_h9v_msg;                          // H9Vgui, from h9vgui_precache()
stock g_h9v_cvar;                         // h9_vgui
stock g_h9v_ns[16];                       // this plugin's namespace

// The menu being built (h9vgui_menu_begin, h9vgui_menu_row).
stock g_h9v_menu_id[24];
stock g_h9v_menu_title[64];
stock g_h9v_menu_style;
stock g_h9v_rows;
stock g_h9v_row_key[H9V_MAX_ROWS];
stock g_h9v_row_flags[H9V_MAX_ROWS];
stock g_h9v_row_label[H9V_MAX_ROWS][32];
stock g_h9v_row_detail[H9V_MAX_ROWS][32];

// What each player's game was last sent of a menu, so a re-offer sends only the TWIN.
stock g_h9v_sent_sig[MAX_PLAYERS + 1];
stock g_h9v_sent_uid[MAX_PLAYERS + 1];
stock Float:g_h9v_sent_at[MAX_PLAYERS + 1];
stock g_h9v_sent_id[MAX_PLAYERS + 1][24];

// A player's h9vgui commands this second.
stock Float:g_h9v_cmd_at[MAX_PLAYERS + 1];
stock g_h9v_cmd_count[MAX_PLAYERS + 1];

/// In plugin_precache: registers H9Vgui, so every game learns it at connect.
stock h9vgui_precache()
{
	g_h9v_msg = engfunc(EngFunc_RegUserMsg, "H9Vgui", -1);
}

/// In plugin_init: this plugin's ids are "<ns>.*"; its panels' replies reach h9vgui_event().
stock h9vgui_init(const ns[])
{
	copy(g_h9v_ns, charsmax(g_h9v_ns), ns);
	g_h9v_cvar = get_cvar_pointer("h9_vgui");
	if (!g_h9v_cvar)
	{
		g_h9v_cvar = register_cvar("h9_vgui", "1");
	}
	register_clcmd("h9vgui", "__h9vgui_cmd");
}

/// Whether this player's game draws H9 VGUI: _h9vgui in his userinfo, not a bot, h9_vgui 1.
stock bool:h9vgui_supported(id)
{
	if (g_h9v_msg <= 0 || !g_h9v_cvar || !get_pcvar_num(g_h9v_cvar))
	{
		return false;
	}
	if (id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id))
	{
		return false;
	}
	new v[8];
	get_user_info(id, "_h9vgui", v, charsmax(v));
	return str_to_num(v) >= H9VGUI_PROTOCOL;
}

/// The H9 VGUI protocol this player's game speaks: 0 when it draws none (or h9_vgui is 0).
stock h9vgui_protocol(id)
{
	if (!h9vgui_supported(id))
	{
		return 0;
	}
	new v[8];
	get_user_info(id, "_h9vgui", v, charsmax(v));
	return str_to_num(v);
}

/// CRC-16/CCITT-FALSE (polynomial 0x1021, start 0xFFFF): what a TWIN carries of its menu's text.
stock h9vgui_crc16(const text[])
{
	new crc = 0xFFFF;
	for (new i = 0; text[i] != EOS; i++)
	{
		crc ^= (text[i] & 0xFF) << 8;
		for (new b = 0; b < 8; b++)
		{
			if (crc & 0x8000)
			{
				crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
			}
			else
			{
				crc = (crc << 1) & 0xFFFF;
			}
		}
	}
	return crc;
}

/// Opens an H9Vgui message to one player: always begun with fakemeta, ended with message_end().
stock h9vgui_begin(id, op)
{
	engfunc(EngFunc_MessageBegin, MSG_ONE, g_h9v_msg, Float:{0.0, 0.0, 0.0}, id);
	write_byte(op);
}

/* ---- menus ---------------------------------------------------------------------------------- */

/// Starts a menu's rows. panel is its id ("<ns>.<name>"); title "" for none.
stock h9vgui_menu_begin(const panel[], const title[], style = H9V_MENU_PANEL)
{
	copy(g_h9v_menu_id, charsmax(g_h9v_menu_id), panel);
	copy(g_h9v_menu_title, charsmax(g_h9v_menu_title), title);
	g_h9v_menu_style = style;
	g_h9v_rows = 0;
}

/// One row: its key (1-9, 10 for the 0 key, 0 for a row with no key), H9V_* flags, its label and
/// a detail drawn after it in the smaller font.
stock h9vgui_menu_row(key, flags, const label[], const detail[] = "")
{
	if (g_h9v_rows >= H9V_MAX_ROWS)
	{
		return;
	}
	g_h9v_row_key[g_h9v_rows] = clamp(key, 0, 10);
	g_h9v_row_flags[g_h9v_rows] = flags;
	copy(g_h9v_row_label[g_h9v_rows], charsmax(g_h9v_row_label[]), label);
	copy(g_h9v_row_detail[g_h9v_rows], charsmax(g_h9v_row_detail[]), detail);
	g_h9v_rows++;
}

/// The menu just built, to one player: its MENU and ROWS when they changed for him, its TWIN, and
/// then show_menu() itself, which every player gets, so the same menucmd handler answers both.
stock h9vgui_menu_send(id, keys, const text[], time, const amx[])
{
	if (h9vgui_supported(id))
	{
		new sig = __h9vgui_menu_sig(keys);
		new uid = get_user_userid(id);
		new Float:now = get_gametime();
		if (sig != g_h9v_sent_sig[id] || uid != g_h9v_sent_uid[id] || !equal(g_h9v_sent_id[id], g_h9v_menu_id)
			|| now - g_h9v_sent_at[id] > 15.0 || now < g_h9v_sent_at[id])
		{
			__h9vgui_send_def(id, keys, time);
			g_h9v_sent_sig[id] = sig;
			g_h9v_sent_uid[id] = uid;
			g_h9v_sent_at[id] = now;
			copy(g_h9v_sent_id[id], charsmax(g_h9v_sent_id[]), g_h9v_menu_id);
		}
		h9vgui_begin(id, H9V_OP_TWIN);
		write_string(g_h9v_menu_id);
		write_short(keys & 0x3FF);
		write_short(h9vgui_crc16(text));
		message_end();
	}
	show_menu(id, keys, text, time, amx);
}

/// In place of show_menu(): the rows are read out of the AMX text itself ("N." starts a row, a
/// \d row is dim, a \r row red, a blank line a gap, the lines before the first row the title
/// unless one is given, and a \d switch or two spaces split a row's label from its detail).
stock h9vgui_show_menu(id, keys, const text[], time, const amx[], const panel[], const title[] = "", style = H9V_MENU_PANEL)
{
	if (h9vgui_supported(id))
	{
		h9vgui_menu_from_text(text, panel, title, style);
	}
	h9vgui_menu_send(id, keys, text, time, amx);
}

/// Builds the menu's rows from an AMX menu text (see h9vgui_show_menu).
stock h9vgui_menu_from_text(const text[], const panel[], const title[], style = H9V_MENU_PANEL)
{
	h9vgui_menu_begin(panel, title, style);
	new colour = 'w';             // an AMX menu's colour runs on from line to line
	new bool:gap = false;
	new bool:titled = title[0] != EOS;
	new line[192], len = 0;
	for (new i = 0; ; i++)
	{
		new c = text[i];
		if (c == '^n' || c == EOS)
		{
			line[len] = EOS;
			colour = __h9vgui_line(line, colour, gap, titled);
			len = 0;
			if (c == EOS)
			{
				break;
			}
			continue;
		}
		if (len < charsmax(line))
		{
			line[len++] = c;
		}
	}
}

/* ---- notices -------------------------------------------------------------------------------- */

/// What a hudmessage would say. To an H9 player, a NOTICE in the slot (a newer one in the same
/// slot replaces it, as a channel does): at y 0.38 or lower it sits at y, centred, else it stacks
/// under the top band. To any other player, the set_hudmessage and show_hudmessage it replaces.
/// id 0 is every player, each the right way.
stock h9vgui_notice(id, const slot[], style, const text[], Float:hold, Float:fade, r, g, b, Float:x = -1.0, Float:y = -1.0, channel = -1)
{
	__h9vgui_notice(id, slot, style, text, hold, fade, r, g, b, x, y, channel, -1);
}

/// A notice over a progress bar, permille 0-1000.
stock h9vgui_notice_bar(id, const slot[], const text[], permille, Float:hold, r, g, b, Float:x = -1.0, Float:y = 0.47, channel = -1)
{
	__h9vgui_notice(id, slot, H9V_NOTICE_BAR, text, hold, 0.2, r, g, b, x, y, channel, clamp(permille, 0, 1000));
}

/// An alert a plugin showed as a hudmessage: the set_hudmessage that gave it its old look has been called, and this shows the text
/// to the player (id 0 is everyone) the way their game draws it. An H9 game: a NOTICE in the slot, in the same colour, for the same
/// hold and fade, at y when that is 0.38 or more (centred there) and under the top band when it is less. Any other game: that
/// hudmessage, exactly as before.
stock h9vgui_alert(id, const slot[], style, const text[], r, g, b, Float:y, Float:hold, Float:fade)
{
	new first = id, last = id;
	if (id == 0)
	{
		first = 1;
		last = min(get_maxplayers(), MAX_PLAYERS);
	}
	for (new i = first; i <= last; i++)
	{
		if (!is_user_connected(i) || is_user_bot(i))
		{
			continue;
		}
		if (h9vgui_supported(i))
		{
			__h9vgui_notice(i, slot, style, text, hold, fade, r, g, b, -1.0, y, -1, -1);
		}
		else
		{
			show_hudmessage(i, "%s", text);
		}
	}
}

/// A status: a notice that stays in its slot until another replaces it or an empty text clears it,
/// and stacks first under the top band, before the notices. In its text {t} counts down as m:ss
/// and {s} as seconds, from clock seconds, on the player's own screen (clock -1: no clock). For one
/// player of protocol 2 or later; false for any other, who is sent nothing and gets the caller's
/// hudmessage instead.
stock bool:h9vgui_status(id, const slot[], const text[], r, g, b, clock = -1, style = H9V_NOTICE_BANNER)
{
	if (h9vgui_protocol(id) < H9VGUI_STATUS_PROTOCOL)
	{
		return false;
	}
	new room = H9VGUI_MSG_MAX - (1 + strlen(slot) + 1 + 1 + 3 + 2) - 1;
	new cut[192];
	copy(cut, min(charsmax(cut), max(1, room)), text);
	h9vgui_begin(id, H9V_OP_STATUS);
	write_string(slot);
	write_byte(style);
	write_byte(r);
	write_byte(g);
	write_byte(b);
	write_short(clamp(clock, -1, 32767));
	write_string(cut);
	message_end();
	return true;
}

/* ---- marks ---------------------------------------------------------------------------------- */

#define H9V_MARK_MAX    32      // the slots of marks: 1 to this
#define H9V_MARK_GONE   3       // an owner that takes the mark down

/**
 * A MARK: a point of the world drawn on the player's screen through the walls, kept on the screen's edge while it is out of
 * view, as a badge with its label in the owner's colour (owner 0 nobody's, 1 and 2 a side's) and, when state is 1 (being
 * taken by side `side`) or 2 (contested), the progress pct (0-100) as a bar under it; and as one more badge in the row of
 * marks under the top stack. slot 1 to H9V_MARK_MAX is the mark's place, and a newer mark in it replaces it; owner
 * H9V_MARK_GONE takes it down, and slot 0 takes every mark down. The label is a few letters or digits, 7 at most.
 * For one player of protocol 3 or later; false for any other, who is sent nothing.
 */
stock bool:h9vgui_mark(id, slot, owner, phase, side, pct, const Float:at[3], const label[])
{
	if (h9vgui_protocol(id) < H9VGUI_MARK_PROTOCOL)
	{
		return false;
	}
	h9vgui_begin(id, H9V_OP_MARK);
	write_byte(clamp(slot, 0, H9V_MARK_MAX));
	write_byte(clamp(owner, 0, H9V_MARK_GONE));
	write_byte(clamp(phase, 0, 2));
	write_byte(clamp(side, 0, 2));
	write_byte(clamp(pct, 0, 100));
	write_short(clamp(floatround(at[0]), -32767, 32767));
	write_short(clamp(floatround(at[1]), -32767, 32767));
	write_short(clamp(floatround(at[2]), -32767, 32767));
	write_string(label);
	message_end();
	return true;
}

/* ---- panels --------------------------------------------------------------------------------- */

/// Starts (or rebuilds) a panel: H9V_* flags, an anchor and offsets, a size in virtual units
/// (1/480 of the screen height; 0 = the art's own size), the art ("#panel", "#banner" or ""),
/// and seconds until it closes by itself (0 for never). Then its controls, then h9vgui_commit().
stock h9vgui_panel(id, const panel[], flags, anchor, x, y, w, h, const art[], timeout = 0)
{
	if (!h9vgui_supported(id))
	{
		return;
	}
	h9vgui_begin(id, H9V_OP_PANEL);
	write_string(panel);
	write_byte(flags);
	write_byte(clamp(anchor, 0, 8));
	write_short(x);
	write_short(y);
	write_short(max(0, w));
	write_short(max(0, h));
	write_string(art);
	write_byte(clamp(timeout, 0, 255));
	message_end();
}

stock h9vgui_label(id, const panel[], ctl, anchor, x, y, w, h, const text[], font = H9V_FONT_TEXT, align = H9V_LEFT)
{
	__h9vgui_ctrl(id, panel, ctl, H9V_LABEL, anchor, x, y, w, h, font, align, 0, 0, 0, 0, 0, 0, text);
}

/// A button on a number key (1-9, 10 for 0): the player's key answers h9vgui <id> <ctl> 1.
stock h9vgui_button(id, const panel[], ctl, anchor, x, y, w, h, const text[], key = 0)
{
	__h9vgui_ctrl(id, panel, ctl, H9V_BUTTON, anchor, x, y, w, h, H9V_FONT_TEXT, H9V_CENTRE, 0, 0, 0, 0, 0, key, text);
}

/// A built-in art ("#panel", "#banner") drawn into the control's rect.
stock h9vgui_image(id, const panel[], ctl, anchor, x, y, w, h, const art[])
{
	__h9vgui_ctrl(id, panel, ctl, H9V_IMAGE, anchor, x, y, w, h, H9V_FONT_TEXT, H9V_LEFT, 0, 0, 0, 0, 0, 0, art);
}

/// A progress bar; its value (0-1000) comes with h9vgui_set_value().
stock h9vgui_progress(id, const panel[], ctl, anchor, x, y, w, h)
{
	__h9vgui_ctrl(id, panel, ctl, H9V_PROGRESS, anchor, x, y, w, h, H9V_FONT_TEXT, H9V_LEFT, 0, 0, 0, 0, 0, 0, "");
}

stock h9vgui_set_text(id, const panel[], ctl, const text[])
{
	if (!h9vgui_supported(id))
	{
		return;
	}
	h9vgui_begin(id, H9V_OP_SET);
	write_string(panel);
	write_byte(ctl);
	write_byte(1);
	write_string(text);
	message_end();
}

stock h9vgui_set_value(id, const panel[], ctl, permille)
{
	__h9vgui_set(id, panel, ctl, 4, clamp(permille, 0, 1000));
}

stock h9vgui_set_visible(id, const panel[], ctl, bool:visible)
{
	__h9vgui_set(id, panel, ctl, 2, visible ? 1 : 0);
}

stock h9vgui_set_enabled(id, const panel[], ctl, bool:enabled)
{
	__h9vgui_set(id, panel, ctl, 3, enabled ? 1 : 0);
}

stock h9vgui_commit(id, const panel[])
{
	__h9vgui_id_op(id, H9V_OP_COMMIT, panel);
}

stock h9vgui_show(id, const panel[])
{
	__h9vgui_id_op(id, H9V_OP_SHOW, panel);
}

stock h9vgui_hide(id, const panel[])
{
	__h9vgui_id_op(id, H9V_OP_HIDE, panel);
}

/// Closes a panel; "<ns>.*" closes every one of the namespace.
stock h9vgui_close(id, const panel[])
{
	__h9vgui_id_op(id, H9V_OP_CLOSE, panel);
}

/* ---- the reply ------------------------------------------------------------------------------ */

/// "h9vgui <id> <control> <value>": this plugin's own ids go to its h9vgui_event(), at most ten
/// a second from one player; any other id goes on to the next plugin's handler.
public __h9vgui_cmd(id)
{
	new panel[32];
	read_argv(1, panel, charsmax(panel));
	new n = strlen(g_h9v_ns);
	if (!n || !equal(panel, g_h9v_ns, n) || panel[n] != '.')
	{
		return PLUGIN_CONTINUE;
	}
	if (id >= 1 && id <= MAX_PLAYERS)
	{
		new Float:now = get_gametime();
		if (now - g_h9v_cmd_at[id] >= 1.0 || now < g_h9v_cmd_at[id])
		{
			g_h9v_cmd_at[id] = now;
			g_h9v_cmd_count[id] = 0;
		}
		if (++g_h9v_cmd_count[id] > 10)
		{
			return PLUGIN_HANDLED;
		}
	}
	new ctl[8], value[64];
	read_argv(2, ctl, charsmax(ctl));
	read_argv(3, value, charsmax(value));
	if (callfunc_begin("h9vgui_event") == 1)
	{
		callfunc_push_int(id);
		callfunc_push_str(panel, false);
		callfunc_push_int(str_to_num(ctl));
		callfunc_push_str(value, false);
		callfunc_end();
	}
	return PLUGIN_HANDLED;
}

/* ---- inside -------------------------------------------------------------------------------- */

/// One line of an AMX menu text into the menu being built; returns the colour in force after it.
stock __h9vgui_line(const line[], colour, &bool:gap, &bool:titled)
{
	// The codes before the text: \w \y \r \d set the colour (\R right-aligns, and is passed over).
	new i = 0;
	while (line[i] == ' ' || (line[i] == 92 && line[i + 1] != EOS))
	{
		if (line[i] == 92)
		{
			if (line[i + 1] != 'R')
			{
				colour = line[i + 1];
			}
			i += 2;
		}
		else
		{
			i++;
		}
	}
	new start = colour;

	// The text with its codes out; where a \d after some text starts a detail.
	new plain[192], p = 0, detail_at = -1;
	for (new j = i; line[j] != EOS; j++)
	{
		if (line[j] == 92 && line[j + 1] != EOS)
		{
			new code = line[j + 1];
			if (code == 'd' && detail_at < 0 && p > 0)
			{
				detail_at = p;
			}
			if (code != 'R')
			{
				colour = code;
			}
			j++;
			continue;
		}
		if (p < charsmax(plain))
		{
			plain[p++] = line[j];
		}
	}
	plain[p] = EOS;
	trim(plain);

	if (plain[0] == EOS)
	{
		if (g_h9v_rows > 0)
		{
			gap = true;
		}
		return colour;
	}

	if (plain[0] >= '0' && plain[0] <= '9' && plain[1] == '.')
	{
		new key = plain[0] - '0';
		if (key == 0)
		{
			key = 10;
		}
		new flags = 0;
		if (start == 'd')
		{
			flags |= H9V_DIM;
		}
		else if (start == 'r')
		{
			flags |= H9V_RED;
		}
		if (gap)
		{
			flags |= H9V_GAP;
			gap = false;
		}
		new body = 2;
		while (plain[body] == ' ')
		{
			body++;
		}
		// detail_at counts from the line's text before trim(); trim() only took spaces off its end
		new split = -1;
		if (detail_at > body)
		{
			split = detail_at;
		}
		else
		{
			new k = contain(plain[body], "  ");
			if (k > 0)
			{
				split = body + k;
			}
		}
		new label[32], detail[32];
		if (split > body)
		{
			copy(label, min(charsmax(label), split - body), plain[body]);
			copy(detail, charsmax(detail), plain[split]);
			trim(detail);
		}
		else
		{
			copy(label, charsmax(label), plain[body]);
		}
		trim(label);
		h9vgui_menu_row(key, flags, label, detail);
		return colour;
	}

	if (!titled && g_h9v_rows == 0)
	{
		copy(g_h9v_menu_title, charsmax(g_h9v_menu_title), plain);
		titled = true;
		return colour;
	}

	// Any other line: a row without a key.
	new flags = (start == 'd') ? H9V_DIM : 0;
	if (gap)
	{
		flags |= H9V_GAP;
		gap = false;
	}
	h9vgui_menu_row(0, flags, plain);
	return colour;
}

/// The menu being built, as a number: a re-offer with the same one sends only its TWIN.
stock __h9vgui_menu_sig(keys)
{
	new sig = h9vgui_crc16(g_h9v_menu_title) ^ (keys & 0x3FF) ^ (g_h9v_menu_style << 12) ^ (g_h9v_rows << 16);
	for (new i = 0; i < g_h9v_rows; i++)
	{
		sig = (sig * 31) ^ h9vgui_crc16(g_h9v_row_label[i]) ^ (h9vgui_crc16(g_h9v_row_detail[i]) << 8)
			^ (g_h9v_row_key[i] << 20) ^ (g_h9v_row_flags[i] << 24);
	}
	return sig;
}

/// MENU, then as many rows to each ROWS message as fit in H9VGUI_MSG_MAX.
stock __h9vgui_send_def(id, keys, time)
{
	h9vgui_begin(id, H9V_OP_MENU);
	write_string(g_h9v_menu_id);
	write_short(keys & 0x3FF);
	write_char(clamp(time, -1, 127));
	write_byte(g_h9v_menu_style);
	write_byte(0);
	write_string(g_h9v_menu_title);
	write_string("");
	message_end();

	new head = 1 + strlen(g_h9v_menu_id) + 1 + 1;
	new i = 0;
	while (i < g_h9v_rows)
	{
		new size = head, n = 0;
		while (i + n < g_h9v_rows)
		{
			new row = 2 + strlen(g_h9v_row_label[i + n]) + 1 + strlen(g_h9v_row_detail[i + n]) + 1;
			if (n > 0 && size + row > H9VGUI_MSG_MAX)
			{
				break;
			}
			size += row;
			n++;
		}
		h9vgui_begin(id, H9V_OP_ROWS);
		write_string(g_h9v_menu_id);
		write_byte(n);
		for (new k = 0; k < n; k++)
		{
			write_byte(g_h9v_row_key[i + k]);
			write_byte(g_h9v_row_flags[i + k]);
			write_string(g_h9v_row_label[i + k]);
			write_string(g_h9v_row_detail[i + k]);
		}
		message_end();
		i += n;
	}
}

stock __h9vgui_notice(id, const slot[], style, const text[], Float:hold, Float:fade, r, g, b, Float:x, Float:y, channel, value)
{
	new first = id, last = id;
	if (id == 0)
	{
		first = 1;
		last = min(get_maxplayers(), MAX_PLAYERS);
	}
	// The text, cut to what one message can carry beside the rest of the notice.
	new room = H9VGUI_MSG_MAX - (1 + strlen(slot) + 1 + 12) - 1;
	new cut[192];
	copy(cut, min(charsmax(cut), max(1, room)), text);
	for (new i = first; i <= last; i++)
	{
		if (!is_user_connected(i) || is_user_bot(i))
		{
			continue;
		}
		if (h9vgui_supported(i))
		{
			h9vgui_begin(i, H9V_OP_NOTICE);
			write_string(slot);
			write_byte(style);
			write_byte(y >= 0.38 ? H9V_C : H9V_T);
			write_short(y >= 0.0 ? floatround(y * 1000.0) : -1);
			write_byte(r);
			write_byte(g);
			write_byte(b);
			write_byte(clamp(floatround(hold * 10.0), 0, 250));
			write_byte(clamp(floatround(fade * 10.0), 0, 250));
			write_short(value);
			write_string(cut);
			message_end();
		}
		else
		{
			set_hudmessage(r, g, b, x, y, 0, 0.0, hold, 0.0, fade, channel);
			show_hudmessage(i, "%s", text);
		}
	}
}

stock __h9vgui_ctrl(id, const panel[], ctl, type, anchor, x, y, w, h, font, align, r, g, b, a, flags, key, const text[])
{
	if (!h9vgui_supported(id))
	{
		return;
	}
	new room = H9VGUI_MSG_MAX - (1 + strlen(panel) + 1 + 22) - 1;
	new cut[128];
	copy(cut, min(charsmax(cut), max(1, room)), text);
	h9vgui_begin(id, H9V_OP_CTRL);
	write_string(panel);
	write_byte(ctl);
	write_byte(type);
	write_byte(clamp(anchor, 0, 8));
	write_short(x);
	write_short(y);
	write_short(max(0, w));
	write_short(max(0, h));
	write_byte(font);
	write_byte(align);
	write_byte(r);
	write_byte(g);
	write_byte(b);
	write_byte(a);
	write_byte(flags);
	write_byte(clamp(key, 0, 10));
	write_string(cut);
	message_end();
}

stock __h9vgui_set(id, const panel[], ctl, what, value)
{
	if (!h9vgui_supported(id))
	{
		return;
	}
	h9vgui_begin(id, H9V_OP_SET);
	write_string(panel);
	write_byte(ctl);
	write_byte(what);
	if (what == 4)
	{
		write_short(value);
	}
	else
	{
		write_byte(value);
	}
	message_end();
}

stock __h9vgui_id_op(id, op, const panel[])
{
	if (!h9vgui_supported(id))
	{
		return;
	}
	h9vgui_begin(id, op);
	write_string(panel);
	message_end();
}
