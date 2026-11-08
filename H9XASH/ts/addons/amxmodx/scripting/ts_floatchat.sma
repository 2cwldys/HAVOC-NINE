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
 * exists only when enter is pressed. Nor does a stock engine tell the server the chat box
 * opened: messagemode and messagemode2 are the engine's own commands on the client, run there
 * and never sent on, on GoldSrc and Xash alike -- so a hook on them never fires, and that is
 * why no bubble ever showed. The H9XASH engine says it instead (engine-h9-typing.patch): the
 * client command "h9_typing 1" as the chat line opens and "h9_typing 0" as it closes, sent or
 * not, every time -- to a server that registered the H9Typing user message, as this plugin
 * does. So on H9XASH the bubble is live -- it means "this person is typing" -- and the words
 * appear when they send. A Steam client says nothing, and shows no bubble. (An H9XASH engine
 * from before the command set the userinfo key _h9typing instead, which is still read.)
 * ---------------------------------------------------------------------------------------
 */
#include <amxmodx>
#include <fakemeta>
#include <tsm_api>

#define PLUGIN  "TS Float Chat"
#define VERSION "1.0"
#define AUTHOR  "TSM"

#define MAXPL (MAX_PLAYERS + 1)

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
new bool:g_typing[MAXPL];          // the chat line is open: h9_typing 1 (or an old _h9typing "1")

/*
 * A BUBBLE NEVER HANGS. The engine says h9_typing 1 again every 2 seconds while the line stays
 * open, so a bubble with no word for FC_TYPING_QUIET seconds comes down by itself (a close that
 * never arrived); FC_TYPING_QUIET_OLD for an earlier engine's _h9typing, which says nothing
 * between. It comes down too when the player dies, changes team or leaves.
 */
#define FC_TYPING_QUIET     5.0
#define FC_TYPING_QUIET_OLD 30.0
new Float:g_typing_at[MAXPL];      // the last word that the line is open
new bool:g_typing_cmd[MAXPL];      // that word came as h9_typing, which is said again while open
new g_typing_team[MAXPL];          // the team he was on as the line opened
new bool:g_typing_logged;          // the first _h9typing on this map has been logged

/*
 * FLOAT CHAT OFF, per player. A player who has it off is sent neither: no typing bubble (held back
 * from him in fw_addtofullpack_pre) and no words over heads (draw_for skips him), so he costs
 * nothing. .bubbles toggles it and is remembered in FC_OFF_FILE, by the player's h9_clientid or
 * authid; the userinfo key _h9bubbles, when he has one, wins (setinfo _h9bubbles 0 in his
 * userconfig.cfg keeps it off on every server).
 */
#define FC_OFF_FILE "ts_floatchat_off.txt"
new bool:g_off[MAXPL];             // float chat off for this player
new bool:g_off_stored[MAXPL];      // FC_OFF_FILE has him off, read as he joins
new bool:g_is_bubble[2048];        // edict -> a typing bubble, for fw_addtofullpack_pre
new g_fw_afp = -1;                 // the AddToFullPack pre hook: only while someone has it off

/*
 * WHERE IT SITS. The bubble is fc_rise units above the player's eyes (origin plus view_ofs), so it
 * follows him down when he ducks, goes prone or dives, as his eyes do; the words sit FC_WORDS_ABOVE
 * units above the bubble, their box centred on that point and resting on it.
 *
 * YOUR OWN BUBBLE. A player's own words are never sent to him, and his own bubble, over his own
 * head, is out of his first-person view. fc_self 1 sends him his words too, centred near the top
 * of his screen (FC_SELF_Y), and in third person he sees his bubble over his head as anyone does.
 */
#define FC_WORDS_ABOVE 14.0
#define FC_SELF_Y      0.30
// The words' box, as a share of the screen: a character's width and the line's height.
#define FC_CHAR_W      0.0065
#define FC_LINE_H      0.03

// The words as last sent to each viewer, so a line that has not moved on his screen is not sent
// again until the one before is about to run out.
new Float:g_sent_x[MAXPL][FC_SLOTS];
new Float:g_sent_y[MAXPL][FC_SLOTS];
new Float:g_sent_at[MAXPL][FC_SLOTS];

new g_cv_on, g_cv_range, g_cv_hold, g_cv_rise, g_cv_scale;
new g_cv_r, g_cv_g, g_cv_b, g_cv_ytweak, g_cv_self;
new g_cv_tsm;                     // ts_matchmode's tsm_enabled; 0 without it
new bool:g_have_core = true;     // ts_matchmode's natives are bound (native_filter)

public plugin_natives()
{
	set_native_filter("native_filter");
}

/// A missing tsm_* native is allowed: without ts_matchmode every live player can talk.
public native_filter(const name[], index, trap)
{
	if (!trap)
	{
		return PLUGIN_HANDLED;
	}
	if (equal(name, "tsm_", 4))
	{
		g_have_core = false;
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

public plugin_cfg()
{
	g_cv_tsm = get_cvar_pointer("tsm_enabled");
}

/// Who gets a bubble and words: a live player, and while the match mode runs on this map only one
/// it draws as he is (ts_matchmode's tsm_shown): in the match, the round frozen, live or just
/// ended, and not cloaked -- never anyone eliminated, spectating, in warmup or ready-up, at a
/// match's end, or under the Recon's .cloak. task_float asks again every tick, so a bubble or a
/// line already up comes down the moment its player stops being shown.
bool:may_talk(id)
{
	if (!is_user_alive(id))
	{
		return false;
	}
	if (g_have_core && g_cv_tsm && get_pcvar_num(g_cv_tsm))
	{
		return tsm_shown(id) != 0;
	}
	return true;
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	// The chat line opening and closing: the H9XASH engine's h9_typing command, and the
	// userinfo key _h9typing an earlier H9XASH engine set (plus _h9bubbles, below).
	register_clcmd("h9_typing", "cmd_h9_typing");
	register_forward(FM_ClientUserInfoChanged, "fw_userinfo_post", 1);

	register_clcmd("say",      "cmd_say");
	register_clcmd("say_team", "cmd_say");

	// Xash3D FWGS: AMXX finds no SV_DropClient there, so client_disconnected never fires for a
	// player leaving; Metamod's ClientDisconnect does, on any engine. ts_matchmode does the same.
	if (cvar_exists("host_ver"))
	{
		register_forward(FM_ClientDisconnect, "fw_client_disconnect_xash");
	}

	g_cv_on     = register_cvar("fc_enabled",  "1");
	g_cv_range  = register_cvar("fc_range",    "900");
	g_cv_hold   = register_cvar("fc_hold",     "5.0");
	g_cv_rise   = register_cvar("fc_rise",     "24.0");   // above the eyes (WHERE IT SITS)
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

	// 1: a player is sent his own words as well (YOUR OWN BUBBLE, above). Off by default.
	g_cv_self = register_cvar("fc_self", "0");

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

	// Never sent. Registered so the H9XASH engine knows this server takes h9_typing: it sends
	// the command only to a server whose game has this message.
	engfunc(EngFunc_RegUserMsg, "H9Typing", 0);
}

public client_putinserver(id)
{
	g_typing[id] = false;
	g_bubble[id] = 0;
	for (new s = 0; s < FC_SLOTS; s++)
	{
		g_sent_at[id][s] = -1.0;
	}
	g_off_stored[id] = false;
	new key[64];
	if (!is_user_bot(id) && player_key(id, key, charsmax(key)))
	{
		g_off_stored[id] = stored_off(key);
	}
	refresh_off(id);
}

public client_disconnected(id)
{
	player_left(id);
}

/// Xash3D: a player leaving, from Metamod's ClientDisconnect. Registered only on Xash.
public fw_client_disconnect_xash(id)
{
	if (id >= 1 && id < MAXPL)
	{
		player_left(id);
	}
	return FMRES_IGNORED;
}

player_left(id)
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
	g_off[id] = false;
	g_off_stored[id] = false;
	update_afp_hook(id);
}

/* ---- float chat off, per player ------------------------------------------ */

/// The key a player's choice is kept by: his h9_clientid (H9XASH), else an authid that is his
/// alone. False when he has neither.
bool:player_key(id, key[], len)
{
	get_user_info(id, "h9_clientid", key, len);
	// the id is 32 lowercase hex characters or nothing: a client chooses the text, and it goes into a data file
	new bool:hex = (strlen(key) == 32);
	for (new i = 0; hex && key[i]; i++)
	{
		hex = ('0' <= key[i] <= '9') || ('a' <= key[i] <= 'f');
	}
	if (hex)
	{
		return true;
	}
	key[0] = 0;
	get_user_authid(id, key, len);
	return key[0] && !equali(key, "STEAM_ID_LAN") && !equali(key, "STEAM_ID_PENDING")
		&& !equali(key, "VALVE_ID_LAN") && !equali(key, "VALVE_ID_PENDING") && !equali(key, "BOT")
		&& !equali(key, "HLTV") && !equali(key, "UNKNOWN");
}

stored_path(path[], len)
{
	get_localinfo("amxx_datadir", path, len);
	format(path, len, "%s/%s", path, FC_OFF_FILE);
}

/// Is this key in FC_OFF_FILE, a player who turned float chat off?
bool:stored_off(const key[])
{
	new path[128];
	stored_path(path, charsmax(path));
	new f = fopen(path, "rt");
	if (!f)
	{
		return false;
	}
	new line[96], bool:found = false;
	while (!found && !feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		found = line[0] && line[0] != '/' && equal(line, key);
	}
	fclose(f);
	return found;
}

/// Puts this key in FC_OFF_FILE (off) or takes it out (on). The file holds only the players who
/// turned float chat off, one key a line.
store_off(const key[], bool:off)
{
	new path[128], tmp[136];
	stored_path(path, charsmax(path));
	formatex(tmp, charsmax(tmp), "%s.new", path);
	new out = fopen(tmp, "wt");
	if (!out)
	{
		return;
	}
	fputs(out, "// Players who turned ts_floatchat off with .bubbles, by h9_clientid or authid. One a line.^n");
	new f = fopen(path, "rt");
	if (f)
	{
		new line[96];
		while (!feof(f))
		{
			fgets(f, line, charsmax(line));
			trim(line);
			if (line[0] && line[0] != '/' && !equal(line, key))
			{
				fprintf(out, "%s^n", line);
			}
		}
		fclose(f);
	}
	if (off)
	{
		fprintf(out, "%s^n", key);
	}
	fclose(out);
	delete_file(path);
	rename_file(tmp, path, 1);
}

/// Works out whether a player has float chat off: his userinfo _h9bubbles when he has one, else
/// his choice in FC_OFF_FILE.
refresh_off(id)
{
	new ui[4];
	get_user_info(id, "_h9bubbles", ui, charsmax(ui));
	new bool:off = ui[0] ? (ui[0] == '0') : g_off_stored[id];
	if (off != g_off[id])
	{
		g_off[id] = off;
		update_afp_hook(0);
	}
}

/// The AddToFullPack hook runs for every entity and every player each frame, so it is there only
/// while a player who has float chat off is on the server. `leaving` is a player on his way out.
update_afp_hook(leaving)
{
	new bool:need = false;
	for (new i = 1; i < MAXPL; i++)
	{
		if (i != leaving && g_off[i] && is_user_connected(i))
		{
			need = true;
			break;
		}
	}
	if (need && g_fw_afp == -1)
	{
		g_fw_afp = register_forward(FM_AddToFullPack, "fw_addtofullpack_pre");
	}
	else if (!need && g_fw_afp != -1)
	{
		unregister_forward(FM_AddToFullPack, g_fw_afp);
		g_fw_afp = -1;
	}
}

/// Where a player's bubble sits: fc_rise units above his eyes, as they are now.
bubble_anchor(id, Float:at[3])
{
	new Float:ofs[3];
	pev(id, pev_origin, at);
	pev(id, pev_view_ofs, ofs);
	at[0] += ofs[0];
	at[1] += ofs[1];
	at[2] += ofs[2] + get_pcvar_float(g_cv_rise);
}

/// A typing bubble is never sent to a player who has float chat off.
public fw_addtofullpack_pre(es, e, ent, host, hostflags, player, pSet)
{
	if (ent > 0 && ent < sizeof g_is_bubble && g_is_bubble[ent] && host > 0 && host < MAXPL && g_off[host])
	{
		forward_return(FMV_CELL, 0);
		return FMRES_SUPERCEDE;
	}
	return FMRES_IGNORED;
}

/// .bubbles: float chat off for this player, or back on. Kept in FC_OFF_FILE and in his userinfo.
cmd_bubbles(id)
{
	new bool:off = !g_off[id];
	new key[64];
	if (player_key(id, key, charsmax(key)))
	{
		store_off(key, off);
	}
	g_off_stored[id] = off;

	// In his userinfo too, as tsm_music keeps its choice. A client may refuse a server's
	// setinfo; the file above holds the choice then.
	new ui[4];
	get_user_info(id, "_h9bubbles", ui, charsmax(ui));
	client_cmd(id, "setinfo _h9bubbles %d", off ? 0 : 1);
	g_off[id] = off;
	update_afp_hook(0);

	if (off)
	{
		client_print(id, print_chat, "[FC] Float chat is OFF for you: no typing bubbles, no words over heads. Type .bubbles to turn it back on.");
	}
	else
	{
		client_print(id, print_chat, "[FC] Float chat is ON for you: typing bubbles and words over heads. Type .bubbles to turn it off.");
	}
	if (ui[0] && (ui[0] == '0') != off)
	{
		client_print(id, print_chat, "[FC] If your own setinfo _h9bubbles %s is still set, it decides: change it in your console.", ui);
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
	if (ent < sizeof g_is_bubble)
	{
		g_is_bubble[ent] = true;
	}
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
	g_typing[id] = false;
	new ent = g_bubble[id];
	if (ent > 0 && ent < sizeof g_is_bubble)
	{
		g_is_bubble[ent] = false;
	}
	if (ent > 0 && pev_valid(ent))
	{
		engfunc(EngFunc_RemoveEntity, ent);
	}
	g_bubble[id] = 0;
}

/* ---- the two things a player does ---------------------------------------- */

/*
 * The chat line opened or closed: _h9typing in the userinfo, "1" while it is open and "0" once
 * it closes, sent or not -- set by the H9XASH engine (engine-h9-typing.patch) and by nothing else.
 */
public fw_userinfo_post(id, buffer)
{
	if (id < 1 || id >= MAXPL || !is_user_connected(id) || is_user_bot(id))
	{
		return FMRES_IGNORED;
	}

	// _h9bubbles may have changed with it: float chat off for him, or back on.
	refresh_off(id);

	// An earlier H9XASH engine's _h9typing, read only when the key is there at all: today's
	// engine sends h9_typing instead and leaves the key out.
	new v[4];
	v[0] = 0;
	engfunc(EngFunc_InfoKeyValue, buffer, "_h9typing", v, charsmax(v));
	if (v[0])
	{
		set_typing(id, v[0] == '1', "_h9typing");
	}
	return FMRES_IGNORED;
}

/// h9_typing 1 / 0, from the H9XASH engine as the chat line opens and closes. Kept from TS, which
/// would answer it with "Unknown command".
public cmd_h9_typing(id)
{
	if (id >= 1 && id < MAXPL && is_user_connected(id) && !is_user_bot(id))
	{
		new arg[4];
		read_argv(1, arg, charsmax(arg));
		set_typing(id, arg[0] == '1', "h9_typing");
	}
	return PLUGIN_HANDLED;
}

/// The chat line open or closed: the bubble up while it is open, every time it opens.
set_typing(id, bool:typing, const how[])
{
	if (typing)
	{
		// every word that it is open, the engine's repeats included, keeps the bubble up
		g_typing_at[id] = get_gametime();
		g_typing_cmd[id] = equal(how, "h9_typing") != 0;
	}
	if (typing == g_typing[id])
	{
		return;
	}
	g_typing[id] = typing;
	g_typing_team[id] = get_user_team(id);

	// Once a map, the proof that the engine's word arrives at all.
	if (typing && !g_typing_logged)
	{
		g_typing_logged = true;
		log_amx("[FC] %s: player %d opened the chat line, as the H9XASH engine reports it.", how, id);
	}
	if (typing && get_pcvar_num(g_cv_on))
	{
		bubble_entity(id);
	}
}

/// They sent it. The bubble comes down and the words go up.
public cmd_say(id)
{
	if (id >= 1 && id < MAXPL && !is_user_bot(id))
	{
		new cmd[16];
		read_args(cmd, charsmax(cmd));
		remove_quotes(cmd);
		trim(cmd);
		if (equali(cmd, ".bubbles"))
		{
			cmd_bubbles(id);
			return PLUGIN_HANDLED;
		}
	}

	if (!get_pcvar_num(g_cv_on))
	{
		return PLUGIN_CONTINUE;
	}
	g_typing[id] = false;

	if (is_user_bot(id) || !may_talk(id))
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

	// New words go out to every viewer on the next tick, wherever they were drawn before.
	for (new v = 1; v < MAXPL; v++)
	{
		g_sent_at[v][pick] = -1.0;
	}
}

/* ---- drawing, ten times a second ----------------------------------------- */

public task_float()
{
	if (!get_pcvar_num(g_cv_on))
	{
		return;
	}

	new Float:now = get_gametime();
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");   // connected humans only; a bot answers no menu and reads no text

	// The AddToFullPack hooks follow who has float chat off, who is typing, and fc_self.
	update_afp_hook(0);

	// A BUBBLE NEVER HANGS: no word for a while, death, leaving the match, a new team.
	for (new i = 0; i < pnum; i++)
	{
		new p = players[i];
		if (!g_typing[p])
		{
			continue;
		}
		new Float:quiet = g_typing_cmd[p] ? FC_TYPING_QUIET : FC_TYPING_QUIET_OLD;
		if (now - g_typing_at[p] > quiet || !may_talk(p) || get_user_team(p) != g_typing_team[p])
		{
			g_typing[p] = false;
		}
	}

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
		if (!is_user_connected(talker) || !may_talk(talker))
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

	if (!g_typing[id] || !may_talk(id))
	{
		set_pev(ent, pev_effects, pev(ent, pev_effects) | FC_EF_NODRAW);
		return;
	}

	new Float:org[3];
	bubble_anchor(id, org);
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
 * THE PROJECTION. A hudmessage is positioned in screen fractions, so the point above the
 * talker's bubble has to be turned into a point on this viewer's screen (head_on_screen):
 *
 *   d          = that point - viewer's eye
 *   forward/right/up come from the VIEWER's own v_angle
 *   behind them (d . forward <= 0)  -> nothing to draw
 *   sx = (d.right) / (d.forward) / tan(fov/2)
 *   sy = (d.up)    / (d.forward) / (tan(fov/2) * 0.75)
 *
 * The fov is a 4:3 view's width, so its height's half-angle is tan(fov/2) * 3/4. The server is
 * never told the viewer's screen shape: 4:3 is assumed and fc_y_tweak corrects it. The box is then
 * centred on the point and rests on it, its width guessed from the line's length.
 */
draw_for(viewer, talker, slot)
{
	// A viewer who has float chat off is sent nothing at all.
	if (viewer >= MAXPL || g_off[viewer] || !is_user_alive(viewer))
	{
		return;
	}

	new Float:hx, Float:hy;
	if (viewer == talker)
	{
		// His own words, only with fc_self 1: centred near the top of his own screen.
		if (!get_pcvar_num(g_cv_self))
		{
			return;
		}
		hx = -1.0;   // a hudmessage at -1 is centred across the screen
		hy = FC_SELF_Y;
	}
	else if (!head_on_screen(viewer, talker, hx, hy))
	{
		return;
	}
	else
	{
		// The box rests on the point above the bubble and is centred on it: a hudmessage's x and
		// y are its left and its top.
		hx -= float(strlen(g_slot_text[slot])) * FC_CHAR_W * 0.5;
		hy -= FC_LINE_H;
		if (hx < 0.0)
		{
			hx = 0.0;
		}
		if (hy < 0.0)
		{
			hy = 0.0;
		}
	}

	/*
	 * Sent again only when it has moved on this viewer's screen, or before the last one runs out.
	 * The hold is 0.25 s, so a line that stands still on his screen goes out about five times a
	 * second instead of ten, and one that moves as he turns still follows every tick.
	 */
	new Float:now = get_gametime();
	if (floatabs(hx - g_sent_x[viewer][slot]) < 0.004 && floatabs(hy - g_sent_y[viewer][slot]) < 0.004
		&& g_sent_at[viewer][slot] >= 0.0 && now - g_sent_at[viewer][slot] < 0.18)
	{
		return;
	}
	g_sent_x[viewer][slot] = hx;
	g_sent_y[viewer][slot] = hy;
	g_sent_at[viewer][slot] = now;

	// Held a little longer than the tick that draws it, so it does not flicker between
	// updates, and faded by nothing -- a fade would restart on every re-send.
	set_hudmessage(get_pcvar_num(g_cv_r), get_pcvar_num(g_cv_g), get_pcvar_num(g_cv_b),
		hx, hy, 0, 0.0, 0.25, 0.0, 0.0, FC_CHANNELS[slot]);
	show_hudmessage(viewer, "%s", g_slot_text[slot]);
}

/// Where the talker's head is on this viewer's screen, as fractions in hx and hy. False when it is
/// out of fc_range, behind a wall, behind the viewer or off the edge of his screen.
bool:head_on_screen(viewer, talker, &Float:hx, &Float:hy)
{
	new Float:eye[3], Float:ofs[3], Float:head[3], Float:torg[3];
	pev(viewer, pev_origin, eye);
	pev(viewer, pev_view_ofs, ofs);
	eye[0] += ofs[0]; eye[1] += ofs[1]; eye[2] += ofs[2];

	bubble_anchor(talker, torg);
	head[0] = torg[0];
	head[1] = torg[1];
	head[2] = torg[2] + FC_WORDS_ABOVE;

	new Float:d[3];
	for (new k = 0; k < 3; k++)
	{
		d[k] = head[k] - eye[k];
	}
	new Float:dist = floatsqroot(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
	if (dist > get_pcvar_float(g_cv_range) || dist < 1.0)
	{
		return false;
	}

	// Nothing through walls. Cheap enough ten times a second for the few pairs that get
	// this far, and without it the whole thing becomes a wallhack.
	new tr = 0;
	engfunc(EngFunc_TraceLine, eye, head, 0, viewer, tr);
	if (get_tr2(tr, TR_flFraction) < 0.95)
	{
		return false;
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
		return false;   // behind the viewer, or so close the projection blows up
	}
	new Float:dr = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
	new Float:du = d[0] * up[0]    + d[1] * up[1]    + d[2] * up[2];

	// The viewer's own field of view; 0 is the engine's default of 90.
	new Float:fov = float(pev(viewer, pev_fov));
	if (fov < 1.0) { fov = 90.0; }
	new Float:half = floattan(fov / 2.0, degrees);
	if (half < 0.01) { half = 1.0; }

	// The engine's fov is the width of a 4:3 view, so the view's vertical half-angle is that of
	// its 3:4 height: tan(fov/2) times 0.75. fc_y_tweak nudges it for a screen of another shape.
	new Float:sx = (dr / df) / half;
	new Float:sy = (du / df) / (half * 0.75) * get_pcvar_float(g_cv_ytweak);

	hx = 0.5 + 0.5 * sx;
	hy = 0.5 - 0.5 * sy;
	if (hx < 0.02 || hx > 0.98 || hy < 0.02 || hy > 0.98)
	{
		return false;   // off the edge of their screen
	}
	return true;
}
