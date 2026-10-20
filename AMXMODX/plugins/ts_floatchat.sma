/*
 * ts_floatchat -- what a player said, shown above their head.
 *
 * Two different things, drawn two different ways, because the engine gives exactly one
 * tool for each and they are not the same tool.
 *
 *   THE BUBBLE is a SPRITE above the head. It marks a place in the world, which is what a
 *   sprite is for and what the class icons in ts_matchmode already do.
 *
 *   THE WORDS are a HUDMESSAGE. Text cannot be a sprite -- it is arbitrary words at
 *   runtime -- so it goes through the only screen-space tool that takes a position, and
 *   the head is projected into each viewer's screen to place it.
 *
 * WHY NOT BOTH AS SPRITES, since a sprite follows the head for free: a sprite is a picture
 * chosen before the map loads. There is no way to put words into one at runtime.
 *
 * WHY NOT BOTH AS HUDMESSAGES: a hudmessage is placed in SCREEN space, so it has to be
 * re-projected for every viewer every tick, and it lags a fast turn. For a mark that
 * belongs at a fixed place in the world, a sprite is simply correct and the projection is
 * a workaround only text needs.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT CANNOT BE DONE, said plainly because it is the obvious first request.
 *
 * THE SERVER CANNOT SEE WHAT ANYONE IS TYPING. GoldSrc has no keystroke stream; a message
 * exists only when enter is pressed. What the engine does give is that the client runs
 * `messagemode` as a console command when the chat box OPENS, and that can be hooked. So
 * the bubble appearing is real and live -- it means "this person is typing" -- and the
 * words appear when they send. There is no event for closing the chat box without sending,
 * so the bubble times out.
 * ---------------------------------------------------------------------------------------
 */
#include <amxmodx>
#include <fakemeta>

#define PLUGIN  "TS Float Chat"
#define VERSION "1.0"
#define AUTHOR  "TSM"

#define MAXPL 33

/*
 * The sprite, and the frames it animates through.
 *
 * Four: the lit dot walking across the three, then a blank beat. The engine is told which
 * to draw through pev_frame, exactly as ts_matchmode drives the class sheet, so nothing
 * new is needed to run it.
 */
#define FC_SPR    "sprites/tsm_typing.spr"
#define FC_FRAMES 4

// From the HL SDK.
#define FC_EF_NODRAW       128
#define FC_MOVETYPE_NOCLIP 8
#define FC_SOLID_NOT       0

/*
 * THE HUD CHANNELS, and why there are only three.
 *
 * set_hudmessage's last argument is the channel, and a message replaces whatever was on
 * the channel it is sent to. ts_matchmode already uses 1, 2, 3, 4 and 5 -- the countdown,
 * the round clock, the spectator lines -- so writing to any of those would stamp over the
 * round banner mid-countdown.
 *
 * That leaves 0, 6 and 7. Three people's words on screen at once, per viewer; a fourth
 * talker takes the oldest slot rather than stealing a channel that is not ours. It is a
 * limit of the engine, not a decision.
 */
new const FC_CHANNELS[] = { 0, 6, 7 };
#define FC_SLOTS 3

new g_slot_owner[FC_SLOTS];        // which player is in each slot, 0 for free
new Float:g_slot_until[FC_SLOTS];  // when their words come down
new g_slot_text[FC_SLOTS][128];

new bool:g_spr_ok;
new g_bubble[MAXPL];               // the typing sprite, one per player, kept
new Float:g_typing_until[MAXPL];   // while this is in the future, they are typing

new g_cv_on, g_cv_range, g_cv_hold, g_cv_typehold, g_cv_rise, g_cv_scale;
new g_cv_r, g_cv_g, g_cv_b, g_cv_ytweak;

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	/*
	 * Hooked for the CHAT BOX OPENING, which is the only live signal there is. Both are
	 * registered because messagemode is open chat and messagemode2 is team chat, and the
	 * client runs whichever the player bound.
	 *
	 * Both pass the command on. Swallowing them would stop the chat box opening at all.
	 */
	register_clcmd("messagemode",  "cmd_typing");
	register_clcmd("messagemode2", "cmd_typing");

	register_clcmd("say",      "cmd_say");
	register_clcmd("say_team", "cmd_say");

	g_cv_on     = register_cvar("fc_enabled",  "1");
	g_cv_range  = register_cvar("fc_range",    "900");
	g_cv_hold   = register_cvar("fc_hold",     "5.0");
	g_cv_typehold = register_cvar("fc_type_hold", "6.0");
	g_cv_rise   = register_cvar("fc_rise",     "20.0");
	g_cv_scale  = register_cvar("fc_scale",    "0.20");

	g_cv_r = register_cvar("fc_red",   "150");
	g_cv_g = register_cvar("fc_green", "215");
	g_cv_b = register_cvar("fc_blue",  "255");

	/*
	 * The server does not know the viewer's aspect ratio, and the vertical half-angle
	 * depends on it. The maths below assumes 4:3; this nudges the result for anyone on
	 * something else, rather than pretending it can be worked out.
	 */
	g_cv_ytweak = register_cvar("fc_y_tweak", "1.0");

	// Ten times a second. Fast enough to follow someone running, far short of the cost of
	// doing it every frame for every pair of players.
	set_task(0.1, "task_float", 4211, "", 0, "b");
}

public plugin_precache()
{
	// A precache of a path that is not there is a fatal Host_Error that closes the server,
	// so this is checked rather than assumed -- the same guard ts_matchmode uses.
	if (file_exists(FC_SPR))
	{
		precache_model(FC_SPR);
		g_spr_ok = true;
	}
	else
	{
		log_amx("[FC] %s is missing -- typing bubbles are off for this map.", FC_SPR);
	}
}

public client_putinserver(id)
{
	g_typing_until[id] = 0.0;
	g_bubble[id] = 0;
}

public client_disconnected(id)
{
	drop_bubble(id);
	for (new i = 0; i < FC_SLOTS; i++)
	{
		if (g_slot_owner[i] == id)
		{
			g_slot_owner[i] = 0;
			g_slot_until[i] = 0.0;
		}
	}
}

/* ---- the bubble ---------------------------------------------------------- */

/*
 * One sprite per player, made once and kept.
 *
 * Not made and destroyed as people type: entity churn is what exhausted the edict table in
 * this mod before and stopped weapons spawning at all. It is hidden when it should not be
 * seen instead, which is how ts_matchmode's class icons are handled for the same reason.
 */
bubble_entity(id)
{
	if (!g_spr_ok)
	{
		return 0;
	}
	if (g_bubble[id] > 0 && pev_valid(g_bubble[id]))
	{
		return g_bubble[id];
	}

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (!ent)
	{
		g_bubble[id] = 0;
		log_amx("[FC] could not create a typing bubble for %d -- out of edicts?", id);
		return 0;
	}

	engfunc(EngFunc_SetModel, ent, FC_SPR);
	set_pev(ent, pev_classname, "ts_floatchat_bubble");
	set_pev(ent, pev_owner, id);
	set_pev(ent, pev_movetype, FC_MOVETYPE_NOCLIP);
	set_pev(ent, pev_solid,    FC_SOLID_NOT);
	set_pev(ent, pev_rendermode, 4);     // kRenderTransAlpha: the sprite's own alpha test
	set_pev(ent, pev_renderamt,  255.0);
	set_pev(ent, pev_effects, pev(ent, pev_effects) | FC_EF_NODRAW);

	g_bubble[id] = ent;
	return ent;
}

drop_bubble(id)
{
	g_typing_until[id] = 0.0;
	new ent = g_bubble[id];
	if (ent > 0 && pev_valid(ent))
	{
		engfunc(EngFunc_RemoveEntity, ent);
	}
	g_bubble[id] = 0;
}

/* ---- the two things a player does ---------------------------------------- */

/// The chat box opened. The one moment the engine tells us anything live.
public cmd_typing(id)
{
	if (!get_pcvar_num(g_cv_on) || is_user_bot(id) || !is_user_alive(id))
	{
		return PLUGIN_CONTINUE;
	}
	g_typing_until[id] = get_gametime() + get_pcvar_float(g_cv_typehold);
	bubble_entity(id);
	return PLUGIN_CONTINUE;   // never swallowed, or the chat box would not open
}

/// They sent it. The bubble comes down and the words go up.
public cmd_say(id)
{
	if (!get_pcvar_num(g_cv_on))
	{
		return PLUGIN_CONTINUE;
	}
	g_typing_until[id] = 0.0;

	if (is_user_bot(id) || !is_user_alive(id))
	{
		return PLUGIN_CONTINUE;
	}

	new said[192];
	read_args(said, charsmax(said));
	remove_quotes(said);
	trim(said);

	// Commands are not conversation. ts_matchmode's .ready, .team and the rest start with
	// a dot and would otherwise be broadcast over the speaker's head.
	if (!said[0] || said[0] == '.' || said[0] == '/')
	{
		return PLUGIN_CONTINUE;
	}

	take_slot(id, said);
	return PLUGIN_CONTINUE;
}

/*
 * Puts a player's words in a channel, replacing their own if they are already in one.
 *
 * Replacing their own first matters: without it somebody talking quickly holds two of the
 * three slots and crowds everyone else out of the only channels we have.
 */
take_slot(id, const text[])
{
	new Float:now = get_gametime();
	new Float:hold = get_pcvar_float(g_cv_hold);

	new pick = -1;
	for (new i = 0; i < FC_SLOTS; i++)
	{
		if (g_slot_owner[i] == id) { pick = i; break; }
	}
	if (pick < 0)
	{
		for (new i = 0; i < FC_SLOTS; i++)
		{
			if (g_slot_owner[i] == 0 || g_slot_until[i] <= now) { pick = i; break; }
		}
	}
	if (pick < 0)
	{
		// All three busy: the one closest to expiring gives way.
		new Float:soonest = 1.0e9;
		for (new i = 0; i < FC_SLOTS; i++)
		{
			if (g_slot_until[i] < soonest) { soonest = g_slot_until[i]; pick = i; }
		}
	}

	g_slot_owner[pick] = id;
	g_slot_until[pick] = now + hold;
	copy(g_slot_text[pick], charsmax(g_slot_text[]), text);
}

/* ---- drawing, ten times a second ----------------------------------------- */

public task_float()
{
	if (!get_pcvar_num(g_cv_on))
	{
		return;
	}

	new Float:now = get_gametime();
	new players[32], pnum;
	get_players(players, pnum, "ch");   // connected humans only; a bot answers no menu and reads no text

	// The bubbles first: they are world objects and need no viewer.
	for (new i = 0; i < pnum; i++)
	{
		place_bubble(players[i], now);
	}

	// Then the words, which have to be worked out for each viewer separately.
	for (new s = 0; s < FC_SLOTS; s++)
	{
		new talker = g_slot_owner[s];
		if (talker < 1 || g_slot_until[s] <= now)
		{
			g_slot_owner[s] = 0;
			continue;
		}
		if (!is_user_connected(talker) || !is_user_alive(talker))
		{
			g_slot_owner[s] = 0;
			continue;
		}
		for (new i = 0; i < pnum; i++)
		{
			draw_for(players[i], talker, s);
		}
	}
}

/// The bubble, above the head, shown while they are typing and animated as it goes.
place_bubble(id, Float:now)
{
	new ent = g_bubble[id];
	if (ent < 1 || !pev_valid(ent))
	{
		return;
	}

	if (g_typing_until[id] <= now || !is_user_alive(id))
	{
		set_pev(ent, pev_effects, pev(ent, pev_effects) | FC_EF_NODRAW);
		return;
	}

	new Float:org[3];
	pev(id, pev_origin, org);
	org[2] += get_pcvar_float(g_cv_rise);
	engfunc(EngFunc_SetOrigin, ent, org);

	set_pev(ent, pev_scale, get_pcvar_float(g_cv_scale));
	// Four frames at ten ticks a second is a dot every two ticks, which reads as typing
	// rather than as a strobe.
	set_pev(ent, pev_frame, float((floatround(now * 5.0)) % FC_FRAMES));
	set_pev(ent, pev_effects, pev(ent, pev_effects) & ~FC_EF_NODRAW);
}

/*
 * One talker's words, placed on one viewer's screen.
 *
 * THE PROJECTION. A hudmessage is positioned in screen fractions, so the talker's head has
 * to be turned into a point on this viewer's screen:
 *
 *   d          = head - viewer's eye
 *   forward/right/up come from the VIEWER's own v_angle
 *   behind them (d . forward <= 0)  -> nothing to draw
 *   sx = (d.right) / (d.forward) / tan(fov/2)
 *   sy = (d.up)    / (d.forward) / tan(fov/2)
 *
 * The horizontal is exact. The VERTICAL is not, because the vertical half-angle depends on
 * the viewer's aspect ratio and the server is never told it -- 4:3 is assumed and fc_y_tweak
 * corrects it. Being a little high or low over a head is a far smaller fault than it would
 * be for a panel meant to frame a menu.
 */
draw_for(viewer, talker, slot)
{
	if (viewer == talker || !is_user_alive(viewer))
	{
		return;
	}

	new Float:eye[3], Float:ofs[3], Float:head[3], Float:torg[3];
	pev(viewer, pev_origin, eye);
	pev(viewer, pev_view_ofs, ofs);
	eye[0] += ofs[0]; eye[1] += ofs[1]; eye[2] += ofs[2];

	pev(talker, pev_origin, torg);
	head[0] = torg[0];
	head[1] = torg[1];
	head[2] = torg[2] + get_pcvar_float(g_cv_rise) + 8.0;

	new Float:d[3];
	for (new k = 0; k < 3; k++)
	{
		d[k] = head[k] - eye[k];
	}
	new Float:dist = floatsqroot(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
	if (dist > get_pcvar_float(g_cv_range) || dist < 1.0)
	{
		return;
	}

	// Nothing through walls. Cheap enough ten times a second for the few pairs that get
	// this far, and without it the whole thing becomes a wallhack.
	new tr = 0;
	engfunc(EngFunc_TraceLine, eye, head, 0, viewer, tr);
	if (get_tr2(tr, TR_flFraction) < 0.95)
	{
		return;
	}

	new Float:ang[3];
	pev(viewer, pev_v_angle, ang);
	new Float:fwd[3], Float:right[3], Float:up[3];
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);
	global_get(glb_v_right,   right);
	global_get(glb_v_up,      up);

	new Float:df = d[0] * fwd[0]   + d[1] * fwd[1]   + d[2] * fwd[2];
	if (df <= 1.0)
	{
		return;   // behind the viewer, or so close the projection blows up
	}
	new Float:dr = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
	new Float:du = d[0] * up[0]    + d[1] * up[1]    + d[2] * up[2];

	// The viewer's own field of view; 0 is the engine's default of 90.
	new Float:fov = float(pev(viewer, pev_fov));
	if (fov < 1.0) { fov = 90.0; }
	new Float:half = floattan(fov / 2.0, degrees);
	if (half < 0.01) { half = 1.0; }

	new Float:sx = (dr / df) / half;
	new Float:sy = (du / df) / half * get_pcvar_float(g_cv_ytweak);

	new Float:hx = 0.5 + 0.5 * sx;
	new Float:hy = 0.5 - 0.5 * sy;
	if (hx < 0.02 || hx > 0.98 || hy < 0.02 || hy > 0.98)
	{
		return;   // off the edge of their screen
	}

	// Held a little longer than the tick that draws it, so it does not flicker between
	// updates, and faded by nothing -- a fade would restart on every re-send.
	set_hudmessage(get_pcvar_num(g_cv_r), get_pcvar_num(g_cv_g), get_pcvar_num(g_cv_b),
		hx, hy, 0, 0.0, 0.25, 0.0, 0.0, FC_CHANNELS[slot]);
	show_hudmessage(viewer, "%s", g_slot_text[slot]);
}
