/*
 * h9_marks.inc -- a mode's objectives drawn on every player's screen THROUGH THE WALLS.
 *
 * The capture points of Assault, the zones and the uplink of Capture the Uplink, the flags and pads of Capture the Flag: each is a
 * MARK, a slot 1 to H9V_MARK_MAX that holds who it belongs to, what is happening to it, where it hangs and a label of up to 7
 * letters. A game of H9 VGUI protocol 3 or later draws it as a badge on the screen (kept on the edge of the screen while it is out of
 * view, and as one more badge in the row under the top notices: docs\H9_VGUI.txt); any other game is given TS's own objective marker
 * at the same point, which writes `text` there. A mark goes out to everyone when what it shows changes, and, two a second in turn,
 * whatever it shows, so a player who joins late has them all within seconds and none grows older than the client's 30.
 *
 * A mode plugin includes this file, calls h9marks_set() for each mark as often as it likes (nothing is sent unless the mark changed),
 * h9marks_tick() from its own tick, h9marks_player_in() and h9marks_player_out() from client_putinserver and client_disconnected,
 * and h9marks_remove() / h9marks_remove_all() when a mark goes. Each plugin has its own copy of the state below.
 *
 *   owner  0 nobody's, 1 side 1's, 2 side 2's (the colour of the badge)
 *   phase  0 quiet, 1 being taken by `side` (a bar of `pct` per cent under it), 2 contested
 *   label  what the badge says: a letter, a digit, FLAG, DROPPED
 *   text   the words of the objective marker a game without H9 marks is shown (the label when empty)
 *
 * ASCII only, explicit braces, no warnings: the same rules as ts_matchmode.sma.
 */

#if defined _h9_marks_included
	#endinput
#endif
#define _h9_marks_included

#include <amxmodx>
#include <h9_vgui>

#define H9M_TASK_JOIN  71600   // plus a player's index: his marks, once his game has said what it draws

new bool:g_h9m_have[H9V_MARK_MAX + 1];
new g_h9m_owner[H9V_MARK_MAX + 1];
new g_h9m_phase[H9V_MARK_MAX + 1];
new g_h9m_side[H9V_MARK_MAX + 1];
new g_h9m_pct[H9V_MARK_MAX + 1];
new Float:g_h9m_at[H9V_MARK_MAX + 1][3];
new g_h9m_label[H9V_MARK_MAX + 1][8];
new g_h9m_text[H9V_MARK_MAX + 1][64];
new g_h9m_sig[H9V_MARK_MAX + 1];
new g_h9m_mode[MAX_PLAYERS + 1];     // per player: 0 nothing sent, 1 H9 marks, 2 TS's objective markers
new g_h9m_cursor;                    // the mark the rolling refresh is at
new g_h9m_ticks;
new g_h9m_msg_objective, g_h9m_msg_showobj;

/// What a mark shows, as one number: its owner, phase, who is taking it and how far (steps of 5 per cent), its label, and where it
/// hangs (steps of 12 units, so a carried mark follows its carrier without a message for every unit).
stock h9m_sig(slot)
{
	new sig = g_h9m_owner[slot] | (g_h9m_phase[slot] << 2);
	if (g_h9m_phase[slot] == 1)
	{
		sig |= (g_h9m_side[slot] << 4) | ((g_h9m_pct[slot] / 5) << 6);
	}
	new h = 7;
	for (new i = 0; g_h9m_label[slot][i]; i++)
	{
		h = h * 31 + g_h9m_label[slot][i];
	}
	h = h * 31 + floatround(g_h9m_at[slot][0] / 12.0);
	h = h * 31 + floatround(g_h9m_at[slot][1] / 12.0);
	h = h * 31 + floatround(g_h9m_at[slot][2] / 12.0);
	return sig ^ (h << 11) ^ (h >>> 7);
}

stock bool:h9m_obj_msgs()
{
	if (!g_h9m_msg_objective || !g_h9m_msg_showobj)
	{
		g_h9m_msg_objective = get_user_msgid("Objective");
		g_h9m_msg_showobj = get_user_msgid("ShowObj");
	}
	return (g_h9m_msg_objective != 0 && g_h9m_msg_showobj != 0);
}

/// TS's own objective marker, for a player whose game draws no H9 mark: the compass icon and the words are drawn at the point whatever
/// stands between.
stock h9m_obj_show(id, slot)
{
	if (!h9m_obj_msgs())
	{
		return;
	}
	message_begin(MSG_ONE_UNRELIABLE, g_h9m_msg_objective, _, id);
	write_coord(floatround(g_h9m_at[slot][0]));
	write_coord(floatround(g_h9m_at[slot][1]));
	write_coord(floatround(g_h9m_at[slot][2]));
	write_byte(slot);
	write_string(g_h9m_text[slot][0] ? g_h9m_text[slot] : g_h9m_label[slot]);
	message_end();
}

stock h9m_obj_hide(id, slot)
{
	if (!h9m_obj_msgs())
	{
		return;
	}
	message_begin(MSG_ONE_UNRELIABLE, g_h9m_msg_showobj, _, id);
	write_byte(slot);
	write_byte(0);
	message_end();
}

/// One mark to one player: an H9 mark for a game that draws it, else TS's objective marker.
stock h9m_to(id, slot)
{
	new mode = (h9vgui_protocol(id) >= H9VGUI_MARK_PROTOCOL) ? 1 : 2;
	if (g_h9m_mode[id] == 2 && mode == 1)
	{
		// The game's userinfo was not in yet when the first marks went: the objective markers it was given come down.
		for (new k = 1; k <= H9V_MARK_MAX; k++)
		{
			if (g_h9m_have[k])
			{
				h9m_obj_hide(id, k);
			}
		}
	}
	g_h9m_mode[id] = mode;

	if (mode == 1)
	{
		h9vgui_mark(id, slot, g_h9m_owner[slot], g_h9m_phase[slot], g_h9m_side[slot], g_h9m_pct[slot], g_h9m_at[slot], g_h9m_label[slot]);
	}
	else
	{
		h9m_obj_show(id, slot);
	}
}

/// One mark to every player.
stock h9m_send(slot)
{
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");
	for (new i = 0; i < pnum; i++)
	{
		h9m_to(players[i], slot);
	}
}

/// Puts a mark in its slot (1 to H9V_MARK_MAX), and out to everyone when what it shows is not what was last sent.
stock h9marks_set(slot, owner, phase, side, pct, const Float:at[3], const label[], const text[] = "")
{
	if (slot < 1 || slot > H9V_MARK_MAX)
	{
		return;
	}
	new bool:fresh = !g_h9m_have[slot];
	g_h9m_have[slot] = true;
	g_h9m_owner[slot] = owner;
	g_h9m_phase[slot] = phase;
	g_h9m_side[slot] = side;
	g_h9m_pct[slot] = pct;
	g_h9m_at[slot][0] = at[0];
	g_h9m_at[slot][1] = at[1];
	g_h9m_at[slot][2] = at[2];
	copy(g_h9m_label[slot], charsmax(g_h9m_label[]), label);
	copy(g_h9m_text[slot], charsmax(g_h9m_text[]), text);
	new sig = h9m_sig(slot);
	if (fresh || sig != g_h9m_sig[slot])
	{
		g_h9m_sig[slot] = sig;
		h9m_send(slot);
	}
}

/// A mark taken off the map: it comes down for every player it was shown to.
stock h9marks_remove(slot)
{
	if (slot < 1 || slot > H9V_MARK_MAX || !g_h9m_have[slot])
	{
		return;
	}
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (g_h9m_mode[id] == 1)
		{
			new Float:at[3];
			h9vgui_mark(id, slot, H9V_MARK_GONE, 0, 0, 0, at, "");
		}
		else if (g_h9m_mode[id] == 2)
		{
			h9m_obj_hide(id, slot);
		}
	}
	g_h9m_have[slot] = false;
	g_h9m_sig[slot] = -1;
}

/// Every mark down.
stock h9marks_remove_all()
{
	for (new slot = 1; slot <= H9V_MARK_MAX; slot++)
	{
		h9marks_remove(slot);
	}
}

/// Every mark to every player again, whatever it shows: a round that has just reset them.
stock h9marks_resend()
{
	for (new slot = 1; slot <= H9V_MARK_MAX; slot++)
	{
		if (g_h9m_have[slot])
		{
			g_h9m_sig[slot] = h9m_sig(slot);
			h9m_send(slot);
		}
	}
}

/// Every mark to one player, as when he joins.
stock h9marks_send_to(id)
{
	for (new slot = 1; slot <= H9V_MARK_MAX; slot++)
	{
		if (g_h9m_have[slot])
		{
			h9m_to(id, slot);
		}
	}
}

/// From the plugin's own tick, `hz` times a second: each second two marks go out whatever they show, in turn.
stock h9marks_tick(hz)
{
	g_h9m_ticks++;
	if (hz < 1 || g_h9m_ticks % hz != 0)
	{
		return;
	}
	for (new k = 0; k < 2; k++)
	{
		new n = g_h9m_cursor;
		new bool:found = false;
		for (new tries = 0; tries < H9V_MARK_MAX && !found; tries++)
		{
			n = (n % H9V_MARK_MAX) + 1;
			found = g_h9m_have[n];
		}
		if (!found)
		{
			return;
		}
		g_h9m_cursor = n;
		h9m_send(n);
	}
}

/// From client_putinserver: his game takes a few seconds to say what it draws, so his marks follow then.
stock h9marks_player_in(id)
{
	g_h9m_mode[id] = 0;
	if (!is_user_bot(id) && !is_user_hltv(id))
	{
		remove_task(H9M_TASK_JOIN + id);
		set_task(5.0, "h9m_task_join", H9M_TASK_JOIN + id);
	}
}

/// From client_disconnected.
stock h9marks_player_out(id)
{
	g_h9m_mode[id] = 0;
	remove_task(H9M_TASK_JOIN + id);
}

public h9m_task_join(taskid)
{
	new id = taskid - H9M_TASK_JOIN;
	if (id >= 1 && id <= MAX_PLAYERS && is_user_connected(id))
	{
		h9marks_send_to(id);
	}
}
