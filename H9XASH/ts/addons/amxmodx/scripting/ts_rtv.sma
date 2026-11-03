/*
 * ts_rtv.sma -- ROCK THE VOTE: the players vote the server onto another map.
 *
 * Built on "Rock The Vote" 1.0 by Destroyer7 (forums.alliedmods.net, showthread.php?t=351317):
 * its idea and its rule -- each player says .rtv once, and when 60% of the players have said it
 * the map is put to a vote. The original file states no licence. Ported to The Specialists and
 * to H9's match mode:
 *
 *   - .rtv in chat, H9's dot-command style, and .unrtv to take it back before the vote starts.
 *     Every connected person may say it, bots never. On a ts_ map TS plays deathmatch and has
 *     no teams to test, and between matches H9's match mode
 *     parks everyone without a side on the spectator team, so a team test would shut the vote off
 *     exactly where it is wanted.
 *   - The 60% is of the people on the server NOW: it is worked out again as people come and go,
 *     and a leaver's .rtv, nomination and vote leave with them. One person alone is all of them.
 *   - A real map vote: a menu of tsm_rtv_maps maps for everyone, RTV_VOTE_TIME seconds, the most
 *     votes win and a tie is drawn at random. Nominations (.nominate) go on it first, up to
 *     tsm_rtv_nominations; the rest are drawn at random from the maps allowed.
 *   - Which maps: with ts_matchmode's match mode on for this map (tsm_enabled), H9's game-mode
 *     maps -- every installed h9_ map that is not a roleplay one. With it off, any other map
 *     installed on the server. Never the map being played.
 *   - tsm_rtv_in_match 0 refuses .rtv while a match is in progress (ts_matchmode's
 *     tsm_match_running). tsm_rtv_auto 1 starts a vote RTV_AUTO_DELAY seconds after a match is
 *     played to its end (ts_matchmode's tsm_match_complete), with this map kept as a choice, and
 *     a vote that nobody answers then picks one of its maps at random.
 *   - tsm_rtv_roleplay 0 keeps the vote off a roleplay map (rp_ or tsrp_ at the start of its
 *     name, _rp_ or _tsrp_ inside it: ts_matchmode's roleplay_map rule): .rtv, .unrtv, .nominate
 *     and .unnominate are refused there with one line, and no vote starts, tsm_rtv_auto's included.
 *   - rtv_vote_running() and rtv_player_voted(id) are for ts_matchmode's side menu, which waits
 *     for the vote: it is not offered to a player who still has the vote to answer.
 *
 * Without ts_matchmode the native filter lets this load: no match is ever in progress, none ever
 * completes, and any other map can be voted for.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <newmenus>
#include <tsm_api>
#include <h9_vgui>      // an H9 game draws the vote and the nominations on panels

#define PLUGIN  "Rock The Vote"
#define VERSION "1.0-h9.2"
#define AUTHOR  "Destroyer7, H9"

#define RTV_RATIO         0.6     // the share of the players whose .rtv starts the vote
#define RTV_VOTE_TIME     20      // seconds the map vote runs
#define RTV_CHANGE_DELAY  5.0     // seconds from the result to the map change
#define RTV_AUTO_DELAY    10.0    // seconds from a match's end to tsm_rtv_auto's vote
#define RTV_MAX_MAPS      256     // installed maps read from maps\ at most
#define RTV_MAX_CHOICES   8       // maps on one vote at most (keys 1-8); a kept map takes 9
#define RTV_SLOTS         (MAX_PLAYERS + 1)   // the per-player tables, 1-based: every slot AMX Mod X takes

#define RTV_TASK_END      73101
#define RTV_TASK_CHANGE   73102
#define RTV_TASK_AUTO     73103
#define RTV_TASK_SHOW     73200   // + player id: the vote menu, staggered

#define RTV_MENU          "RTV Vote"
#define RTV_NOM_MENU      "RTV Nominate"
#define RTV_NOM_PAGE      7       // maps on one page of the nominations; 8 back, 9 more, 0 exit

new g_cv_in_match, g_cv_auto, g_cv_maps, g_cv_noms, g_cv_roleplay;

new bool:g_have_core = true;     // cleared by the native filter when ts_matchmode is not loaded
new bool:g_xash;                 // Xash3D FWGS: a leave arrives through FM_ClientDisconnect
new g_mapname[32];

new bool:g_rocked[RTV_SLOTS];    // said .rtv on this map
new g_nom[RTV_SLOTS][32];        // the map each player nominated; "" for none
new g_nom_part[RTV_SLOTS][32];   // what his nominations menu matches; "" for every map
new g_nom_page[RTV_SLOTS];       // its page

// The maps the vote may offer here, read from maps\ each time they are needed.
new g_maps[RTV_MAX_MAPS][32];
new g_map_count;

// The vote.
new bool:g_voting;
new bool:g_changing;
new g_next[32];                  // the map being changed to
new g_choice[RTV_MAX_CHOICES + 1][32];
new g_choices;                   // the options on the vote, the kept map included
new g_keep = -1;                 // the option that keeps this map; -1 when the vote has none
new g_tally[RTV_MAX_CHOICES + 1];
new g_voted[RTV_SLOTS];          // the option a player voted for, + 1; 0 for none yet
new bool:g_passed[RTV_SLOTS];    // answered the vote with 0, no vote
new bool:g_vote_auto;            // the vote tsm_rtv_auto started after a match
new g_vote_text[512];
new g_vote_keys;

public plugin_precache()
{
	h9vgui_precache();
}

public plugin_natives()
{
	// For ts_matchmode's side menu, which waits for the vote.
	register_native("rtv_vote_running", "native_vote_running");
	register_native("rtv_player_voted", "native_player_voted");
	set_native_filter("native_filter");
}

/// A missing tsm_* native is allowed: the call returns 0, and the vote runs without the match mode.
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

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_in_match = register_cvar("tsm_rtv_in_match",    "0");
	g_cv_auto     = register_cvar("tsm_rtv_auto",        "1");
	g_cv_maps     = register_cvar("tsm_rtv_maps",        "6");
	g_cv_noms     = register_cvar("tsm_rtv_nominations", "4");
	g_cv_roleplay = register_cvar("tsm_rtv_roleplay",    "0");

	register_clcmd("say",      "hook_say");
	register_clcmd("say_team", "hook_say");

	register_menucmd(register_menuid(RTV_MENU), 1023, "vote_key");
	register_menucmd(register_menuid(RTV_NOM_MENU), 1023, "nominate_key");
	h9vgui_init("rtv");

	// Xash3D FWGS: AMXX finds no SV_DropClient there, so client_disconnected never fires for a
	// player leaving; Metamod's ClientDisconnect does, on any engine. ts_matchmode does the same.
	g_xash = cvar_exists("host_ver") != 0;
	if (g_xash)
	{
		register_forward(FM_ClientDisconnect, "fw_client_disconnect_xash");
	}
}

public plugin_cfg()
{
	get_mapname(g_mapname, charsmax(g_mapname));

	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_rtv.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
}

/* ---- who may vote ------------------------------------------------------------------------- */

public client_putinserver(id)
{
	forget(id);
}

public client_disconnected(id)
{
	player_left(id);
}

/// Xash3D: a player leaving, from Metamod's ClientDisconnect. Registered only on Xash, where
/// AMXX sends client_disconnected only at the map's end.
public fw_client_disconnect_xash(id)
{
	if (id >= 1 && id < RTV_SLOTS)
	{
		player_left(id);
	}
	return FMRES_IGNORED;
}

forget(id)
{
	if (id < 1 || id >= RTV_SLOTS)
	{
		return;
	}
	g_rocked[id] = false;
	g_nom[id][0] = 0;
	g_voted[id] = 0;
	g_passed[id] = false;
	remove_task(RTV_TASK_SHOW + id);
}

/// A leaver takes their .rtv, nomination and vote with them, and the 60% is of who is left.
player_left(id)
{
	if (id < 1 || id >= RTV_SLOTS)
	{
		return;
	}
	if (g_voting && g_voted[id] > 0)
	{
		g_tally[g_voted[id] - 1]--;
	}
	forget(id);

	// One fewer here can be enough: the 60% is of whoever stays.
	if (g_voting)
	{
		check_all_voted(id);
	}
	else
	{
		check_rtv(id);
	}
}

/// The people who count: connected, not a bot and not HLTV. `leaving` is a player on the way out,
/// still connected while he leaves.
count_people(leaving = 0)
{
	new pl[MAX_PLAYERS], n, c = 0;
	get_players(pl, n, "ch");
	for (new i = 0; i < n; i++)
	{
		if (pl[i] != leaving)
		{
			c++;
		}
	}
	return c;
}

/// How many .rtv the vote needs: 60% of the people here now, rounded up, never fewer than one.
rtv_needed(people)
{
	new need = floatround(float(people) * RTV_RATIO, floatround_ceil);
	return need < 1 ? 1 : need;
}

count_rocked(leaving = 0)
{
	new pl[MAX_PLAYERS], n, c = 0;
	get_players(pl, n, "ch");
	for (new i = 0; i < n; i++)
	{
		if (pl[i] != leaving && pl[i] < RTV_SLOTS && g_rocked[pl[i]])
		{
			c++;
		}
	}
	return c;
}

/// True while ts_matchmode has a match under way and tsm_rtv_in_match 0 keeps the vote out of it.
bool:match_blocks()
{
	return !get_pcvar_num(g_cv_in_match) && g_have_core && tsm_match_running() != 0;
}

/// Is the match mode playing this map? ts_matchmode's own switch, which it turns off on every map
/// it does not play, and which a map's mapconfig can set either way.
bool:match_mode_on()
{
	return g_have_core && get_cvar_num("tsm_enabled") != 0;
}

/// A roleplay map by its name: the same test as ts_matchmode's roleplay_map().
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

/// tsm_rtv_roleplay 0 on a roleplay map: no .rtv, no nomination and no vote on this map.
bool:rtv_closed()
{
	return !get_pcvar_num(g_cv_roleplay) && roleplay_map(g_mapname);
}

/// tsm_rtv_auto's vote is on its way: a match was played to its end less than RTV_AUTO_DELAY ago.
bool:auto_vote_due()
{
	return task_exists(RTV_TASK_AUTO) && get_pcvar_num(g_cv_auto) != 0 && !rtv_closed();
}

/* ---- chat ---------------------------------------------------------------------------------- */

public hook_say(id)
{
	if (id < 1 || id >= RTV_SLOTS || is_user_bot(id))
	{
		return PLUGIN_CONTINUE;
	}

	new args[96];
	read_args(args, charsmax(args));
	remove_quotes(args);
	trim(args);

	// tsm_rtv_roleplay 0: on a roleplay map each of these is answered with the one line.
	if (rtv_closed() && (equali(args, ".rtv") || equali(args, ".unrtv") || equali(args, ".unnominate")
		|| (equali(args, ".nominate", 9) && (args[9] == 0 || args[9] == ' '))))
	{
		client_print(id, print_chat, "[RTV] Rock the vote is off on roleplay maps.");
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".rtv"))
	{
		cmd_rtv(id);
		return PLUGIN_HANDLED;
	}
	if (equali(args, ".unrtv"))
	{
		cmd_unrtv(id);
		return PLUGIN_HANDLED;
	}
	if (equali(args, ".nominate", 9) && (args[9] == 0 || args[9] == ' '))
	{
		new part[64];
		copy(part, charsmax(part), args[9]);
		trim(part);
		cmd_nominate(id, part);
		return PLUGIN_HANDLED;
	}
	if (equali(args, ".unnominate"))
	{
		cmd_unnominate(id);
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

/* ---- .rtv ---------------------------------------------------------------------------------- */

cmd_rtv(id)
{
	if (g_changing)
	{
		client_print(id, print_chat, "[RTV] The map is already changing to %s.", g_next);
		return;
	}
	if (g_voting)
	{
		// The way back to a vote menu that a TS panel swallowed.
		if (!g_voted[id])
		{
			show_vote(id);
		}
		client_print(id, print_chat, "[RTV] The map vote is running -- press the number of a map.");
		return;
	}
	if (match_blocks())
	{
		client_print(id, print_chat, "[RTV] Not while a match is in progress. Rock the vote once it is over.");
		return;
	}

	new people = count_people();
	new need = rtv_needed(people);
	if (g_rocked[id])
	{
		client_print(id, print_chat, "[RTV] You have already rocked the vote (%d of %d).", count_rocked(), need);
		return;
	}

	g_rocked[id] = true;
	new name[32];
	get_user_name(id, name, charsmax(name));
	new have = count_rocked();
	client_print(0, print_chat, "[RTV] %s wants a new map: %d of %d. Type .rtv to agree.", name, have, need);
	check_rtv();
}

/// .unrtv: takes back the player's .rtv, while the vote has not started.
cmd_unrtv(id)
{
	if (g_voting || g_changing)
	{
		client_print(id, print_chat, "[RTV] The vote has already started; it cannot be taken back now.");
		return;
	}
	if (!g_rocked[id])
	{
		client_print(id, print_chat, "[RTV] You have not rocked the vote.");
		return;
	}
	g_rocked[id] = false;
	new name[32];
	get_user_name(id, name, charsmax(name));
	client_print(0, print_chat, "[RTV] %s no longer wants a new map: %d of %d.", name, count_rocked(), rtv_needed(count_people()));
}

/// Starts the vote once enough of the people here have said .rtv, and when nothing holds it back.
check_rtv(leaving = 0)
{
	if (g_voting || g_changing || match_blocks() || rtv_closed())
	{
		return;
	}
	new people = count_people(leaving);
	new have = count_rocked(leaving);
	if (people > 0 && have > 0 && have >= rtv_needed(people))
	{
		client_print(0, print_chat, "[RTV] The vote is rocked: %d of %d want a new map.", have, people);
		start_vote(false);
	}
}

/// tsm_rtv_auto: a vote a short while after a match is played to its end.
public tsm_match_complete(winner)
{
	#pragma unused winner
	remove_task(RTV_TASK_AUTO);
	set_task(RTV_AUTO_DELAY, "task_auto_vote", RTV_TASK_AUTO);
}

public task_auto_vote()
{
	// Nothing to do if a vote is on, if the next match has already started, or on a roleplay map
	// that tsm_rtv_roleplay 0 keeps.
	if (g_voting || g_changing || match_blocks() || rtv_closed())
	{
		return;
	}
	if (get_pcvar_num(g_cv_auto))
	{
		client_print(0, print_chat, "[RTV] The match is over: vote for the next map.");
		start_vote(true);
	}
	else
	{
		// No vote of its own, but .rtv said before the match may have enough behind it now.
		check_rtv();
	}
}

/* ---- the maps ------------------------------------------------------------------------------ */

/// May the vote offer this map here? Never the map being played. With the match mode on, H9's
/// game-mode maps only: an h9_ map that is not a roleplay one. With it off, any other map.
bool:map_allowed(const name[], bool:mode_on)
{
	if (equali(name, g_mapname))
	{
		return false;
	}
	if (mode_on)
	{
		return equali(name, "h9_", 3) && !roleplay_map(name);
	}
	return true;
}

/// Reads every installed map the vote may offer here into g_maps, sorted by name.
build_map_list()
{
	g_map_count = 0;
	new bool:mode_on = match_mode_on();
	new file[64], len;
	new dir = open_dir("maps", file, charsmax(file));
	if (!dir)
	{
		return 0;
	}
	do
	{
		len = strlen(file);
		if (len <= 4 || len - 4 >= sizeof g_maps[] || !equali(file[len - 4], ".bsp"))
		{
			continue;
		}
		file[len - 4] = 0;
		if (!map_allowed(file, mode_on) || !is_map_valid(file) || map_index(file) >= 0)
		{
			continue;
		}
		// in name order, so the nomination menu reads as a list
		new at = g_map_count;
		while (at > 0 && strcmp(g_maps[at - 1], file, true) > 0)
		{
			copy(g_maps[at], charsmax(g_maps[]), g_maps[at - 1]);
			at--;
		}
		copy(g_maps[at], charsmax(g_maps[]), file);
		if (++g_map_count >= RTV_MAX_MAPS)
		{
			break;
		}
	}
	while (next_file(dir, file, charsmax(file)));
	close_dir(dir);
	return g_map_count;
}

/// The map's place in g_maps, or -1.
map_index(const name[])
{
	for (new i = 0; i < g_map_count; i++)
	{
		if (equali(g_maps[i], name))
		{
			return i;
		}
	}
	return -1;
}

/// How many maps the vote offers: tsm_rtv_maps, held to 2..RTV_MAX_CHOICES.
vote_size()
{
	new n = get_pcvar_num(g_cv_maps);
	return n < 2 ? 2 : (n > RTV_MAX_CHOICES ? RTV_MAX_CHOICES : n);
}

/// How many nominations go on the vote: tsm_rtv_nominations, held to 0..the vote's size.
nomination_cap()
{
	new n = get_pcvar_num(g_cv_noms), size = vote_size();
	return n < 0 ? 0 : (n > size ? size : n);
}

bool:on_vote(const name[])
{
	for (new i = 0; i < g_choices; i++)
	{
		if (equali(g_choice[i], name))
		{
			return true;
		}
	}
	return false;
}

/* ---- the vote ------------------------------------------------------------------------------ */

/// Puts the vote to everyone: the nominations first, the rest drawn from the maps allowed, and
/// for tsm_rtv_auto's vote this map kept as the last choice.
start_vote(bool:auto)
{
	if (g_voting || g_changing)
	{
		return;
	}
	if (!build_map_list())
	{
		client_print(0, print_chat, "[RTV] There is no other map here to vote for.");
		reset_rtv();
		return;
	}

	new size = vote_size();
	g_choices = 0;
	g_keep = -1;

	// Nominations first, in player order, as many as tsm_rtv_nominations lets on.
	new cap = nomination_cap();
	for (new id = 1; id < RTV_SLOTS && g_choices < cap && g_choices < size; id++)
	{
		if (g_nom[id][0] && is_user_connected(id) && map_index(g_nom[id]) >= 0 && !on_vote(g_nom[id]))
		{
			copy(g_choice[g_choices++], charsmax(g_choice[]), g_nom[id]);
		}
	}

	// Then at random from the rest.
	new pool[RTV_MAX_MAPS], n = 0;
	for (new i = 0; i < g_map_count; i++)
	{
		if (!on_vote(g_maps[i]))
		{
			pool[n++] = i;
		}
	}
	while (g_choices < size && n > 0)
	{
		new r = random(n);
		copy(g_choice[g_choices++], charsmax(g_choice[]), g_maps[pool[r]]);
		pool[r] = pool[--n];
	}

	if (auto)
	{
		g_keep = g_choices;
		copy(g_choice[g_choices++], charsmax(g_choice[]), g_mapname);
	}

	g_vote_auto = auto;
	arrayset(g_tally, 0, sizeof g_tally);
	arrayset(g_voted, 0, sizeof g_voted);
	arrayset(g_passed, false, sizeof g_passed);
	g_voting = true;

	// The menu: orange title and numbers, the maps in white. Raw ShowMenu text, as ts_matchmode
	// sends its own pick menus: AMXX strips the colour codes out of a menu_create() menu on TS.
	new pos = formatex(g_vote_text, charsmax(g_vote_text), "\yVote for the next map:^n^n");
	g_vote_keys = (1 << 9);
	for (new i = 0; i < g_choices; i++)
	{
		if (i == g_keep)
		{
			pos += formatex(g_vote_text[pos], charsmax(g_vote_text) - pos, "^n\y%d. \wKeep %s^n", i + 1, g_choice[i]);
		}
		else
		{
			pos += formatex(g_vote_text[pos], charsmax(g_vote_text) - pos, "\y%d. \w%s^n", i + 1, g_choice[i]);
		}
		g_vote_keys |= (1 << i);
	}
	formatex(g_vote_text[pos], charsmax(g_vote_text) - pos, "^n\d0. No vote");

	// One menu a tenth of a second after the last, rather than every menu in one frame.
	new pl[MAX_PLAYERS], pn;
	get_players(pl, pn, "ch");
	for (new i = 0; i < pn; i++)
	{
		set_task(0.1 * float(i), "task_show_vote", RTV_TASK_SHOW + pl[i]);
	}

	client_print(0, print_chat, "[RTV] Vote for the next map: press its number. %d seconds; .rtv brings the vote back.", RTV_VOTE_TIME);
	log_amx("[RTV] Map vote started%s on %s: %d choice(s).", auto ? " after the match" : "", g_mapname, g_choices);
	remove_task(RTV_TASK_END);
	set_task(float(RTV_VOTE_TIME), "task_vote_end", RTV_TASK_END);
}

public task_show_vote(taskid)
{
	new id = taskid - RTV_TASK_SHOW;
	if (id >= 1 && id < RTV_SLOTS && g_voting && !g_voted[id] && is_user_connected(id))
	{
		show_vote(id);
	}
}

show_vote(id)
{
	// An H9 game draws it on a panel, the first line its title; every game gets the text menu.
	h9vgui_show_menu(id, g_vote_keys, g_vote_text, RTV_VOTE_TIME, RTV_MENU, "rtv.vote");
}

public vote_key(id, key)
{
	if (!g_voting || id < 1 || id >= RTV_SLOTS || g_voted[id])
	{
		return PLUGIN_HANDLED;
	}
	if (key < 0 || key >= g_choices)
	{
		// 0, no vote: an answer all the same, so ts_matchmode's side menu stops waiting for him.
		// .rtv still brings the vote back.
		g_passed[id] = true;
		return PLUGIN_HANDLED;
	}

	g_voted[id] = key + 1;
	g_tally[key]++;
	new name[32];
	get_user_name(id, name, charsmax(name));
	if (key == g_keep)
	{
		client_print(0, print_chat, "[RTV] %s voted to keep %s.", name, g_choice[key]);
	}
	else
	{
		client_print(0, print_chat, "[RTV] %s voted for %s.", name, g_choice[key]);
	}
	check_all_voted();
	return PLUGIN_HANDLED;
}

/// Ends the vote early once everyone here has voted.
check_all_voted(leaving = 0)
{
	new pl[MAX_PLAYERS], pn, waiting = 0;
	get_players(pl, pn, "ch");
	for (new i = 0; i < pn; i++)
	{
		if (pl[i] != leaving && pl[i] < RTV_SLOTS && !g_voted[pl[i]])
		{
			waiting++;
		}
	}
	if (!waiting)
	{
		remove_task(RTV_TASK_END);
		set_task(0.1, "task_vote_end", RTV_TASK_END);
	}
}

public task_vote_end()
{
	if (!g_voting)
	{
		return;
	}
	g_voting = false;

	// Closes the menu of anyone who has not answered it.
	new pl[MAX_PLAYERS], pn;
	get_players(pl, pn, "ch");
	for (new i = 0; i < pn; i++)
	{
		remove_task(RTV_TASK_SHOW + pl[i]);
		if (pl[i] < RTV_SLOTS && !g_voted[pl[i]])
		{
			show_menu(pl[i], 0, "^n", 1);
		}
	}

	new best = 0;
	for (new i = 0; i < g_choices; i++)
	{
		if (g_tally[i] > best)
		{
			best = g_tally[i];
		}
	}

	new win = -1;
	if (best > 0)
	{
		// the most votes; a tie is drawn at random
		new tied[RTV_MAX_CHOICES + 1], tn = 0;
		for (new i = 0; i < g_choices; i++)
		{
			if (g_tally[i] == best)
			{
				tied[tn++] = i;
			}
		}
		win = tied[random(tn)];
	}
	else if (get_pcvar_num(g_cv_auto))
	{
		// tsm_rtv_auto 1: nobody voted, so a map is picked anyway -- never the kept one.
		new maps = (g_keep >= 0) ? g_choices - 1 : g_choices;
		if (maps > 0)
		{
			win = random(maps);
			client_print(0, print_chat, "[RTV] Nobody voted, so the next map is drawn at random.");
		}
	}

	if (win < 0)
	{
		client_print(0, print_chat, "[RTV] Nobody voted. The map stays %s.", g_mapname);
		log_amx("[RTV] Map vote on %s: no votes, no change.", g_mapname);
		reset_rtv();
		return;
	}
	if (win == g_keep)
	{
		client_print(0, print_chat, "[RTV] The map stays %s (%d vote(s)).", g_mapname, g_tally[win]);
		log_amx("[RTV] Map vote on %s: kept.", g_mapname);
		reset_rtv();
		return;
	}

	copy(g_next, charsmax(g_next), g_choice[win]);
	g_changing = true;
	if (cvar_exists("amx_nextmap"))
	{
		set_cvar_string("amx_nextmap", g_next);
	}
	client_print(0, print_chat, "[RTV] The next map is %s (%d vote(s)). Changing in %d seconds.",
		g_next, g_tally[win], floatround(RTV_CHANGE_DELAY));
	log_amx("[RTV] Map vote on %s: %s with %d vote(s)%s.", g_mapname, g_next, g_tally[win], g_vote_auto ? ", after the match" : "");
	set_task(RTV_CHANGE_DELAY, "task_change", RTV_TASK_CHANGE);
}

public task_change()
{
	server_cmd("changelevel %s", g_next);
}

/// After a vote that changed nothing: every .rtv is spent, and it starts again from none.
/// Nominations stand for the next vote.
reset_rtv()
{
	arrayset(g_rocked, false, sizeof g_rocked);
	arrayset(g_voted, 0, sizeof g_voted);
	arrayset(g_passed, false, sizeof g_passed);
	g_choices = 0;
	g_keep = -1;
}

/* ---- for ts_matchmode ---------------------------------------------------------------------- */

/// rtv_vote_running(): 1 while the map vote is up, while the map changes to its winner, and in the
/// RTV_AUTO_DELAY before tsm_rtv_auto's vote after a match; 0 otherwise.
public native_vote_running(plugin, params)
{
	return (g_voting || g_changing || auto_vote_due()) ? 1 : 0;
}

/// rtv_player_voted(id): 1 once this player has answered the vote that is up, with a map or with 0;
/// 0 before that, and whenever no vote is up.
public native_player_voted(plugin, params)
{
	new id = get_param(1);
	if (!g_voting || id < 1 || id >= RTV_SLOTS)
	{
		return 0;
	}
	return (g_voted[id] > 0 || g_passed[id]) ? 1 : 0;
}

/* ---- .nominate ----------------------------------------------------------------------------- */

/// How many players hold a nomination; no two hold the same map.
count_noms()
{
	new c = 0;
	for (new id = 1; id < RTV_SLOTS; id++)
	{
		if (g_nom[id][0] && is_user_connected(id))
		{
			c++;
		}
	}
	return c;
}

/// The player holding a nomination of this map, or 0.
nominated_by(const map[])
{
	for (new id = 1; id < RTV_SLOTS; id++)
	{
		if (g_nom[id][0] && equali(g_nom[id], map) && is_user_connected(id))
		{
			return id;
		}
	}
	return 0;
}

/// .nominate <part of a name>: one map that matches is nominated, several are offered in a menu,
/// and with nothing after it the menu holds every map that can be nominated here.
cmd_nominate(id, const part[])
{
	if (g_changing)
	{
		client_print(id, print_chat, "[RTV] The map is already changing to %s.", g_next);
		return;
	}
	if (g_voting)
	{
		client_print(id, print_chat, "[RTV] The map vote is running; nominate for the next one once it is over.");
		return;
	}
	if (!nomination_cap())
	{
		client_print(id, print_chat, "[RTV] Nominations are off on this server.");
		return;
	}
	if (!build_map_list())
	{
		client_print(id, print_chat, "[RTV] There is no other map here to nominate.");
		return;
	}
	if (!part[0])
	{
		nominate_menu(id, "");
		return;
	}

	new exact = -1, first = -1, found = 0;
	for (new i = 0; i < g_map_count; i++)
	{
		if (equali(g_maps[i], part))
		{
			exact = i;
		}
		if (containi(g_maps[i], part) != -1)
		{
			if (first < 0)
			{
				first = i;
			}
			found++;
		}
	}
	if (exact >= 0)
	{
		nominate(id, exact);
	}
	else if (found == 1)
	{
		nominate(id, first);
	}
	else if (found > 1)
	{
		nominate_menu(id, part);
	}
	else
	{
		client_print(id, print_chat, "[RTV] No map here can be nominated that matches ^"%s^". Type .nominate for the list.", part);
	}
}

nominate(id, idx)
{
	new map[32];
	copy(map, charsmax(map), g_maps[idx]);
	if (equali(g_nom[id], map))
	{
		client_print(id, print_chat, "[RTV] You have already nominated %s.", map);
		return;
	}
	new other = nominated_by(map);
	if (other)
	{
		new oname[32];
		get_user_name(other, oname, charsmax(oname));
		client_print(id, print_chat, "[RTV] %s is already nominated, by %s.", map, oname);
		return;
	}
	new cap = nomination_cap();
	if (!g_nom[id][0] && count_noms() >= cap)
	{
		client_print(id, print_chat, "[RTV] The vote already has its %d nomination(s).", cap);
		return;
	}

	new old[32], name[32];
	copy(old, charsmax(old), g_nom[id]);
	copy(g_nom[id], charsmax(g_nom[]), map);
	get_user_name(id, name, charsmax(name));
	if (old[0])
	{
		client_print(0, print_chat, "[RTV] %s nominated %s, in place of %s.", name, map, old);
	}
	else
	{
		client_print(0, print_chat, "[RTV] %s nominated %s.", name, map);
	}
}

/// The maps that can be nominated here, those matching `part` when it is not empty, in a menu of
/// RTV_NOM_PAGE a page with 8 back and 9 more: raw ShowMenu text, as the vote is, so an H9 game
/// draws each page on a panel (h9_vgui.inc) and every other game gets the text.
nominate_menu(id, const part[])
{
	copy(g_nom_part[id], charsmax(g_nom_part[]), part);
	g_nom_page[id] = 0;
	nominate_page(id);
}

/// The maps of a player's nominations menu, as indices into g_maps. How many.
nominate_list(id, list[RTV_MAX_MAPS])
{
	new n = 0;
	for (new i = 0; i < g_map_count; i++)
	{
		if (g_nom_part[id][0] && containi(g_maps[i], g_nom_part[id]) == -1)
		{
			continue;
		}
		list[n++] = i;
	}
	return n;
}

/// One page of a player's nominations menu, built from the maps as they are now.
nominate_page(id)
{
	new list[RTV_MAX_MAPS];
	new n = nominate_list(id, list);
	new pages = max(1, (n + RTV_NOM_PAGE - 1) / RTV_NOM_PAGE);
	g_nom_page[id] = clamp(g_nom_page[id], 0, pages - 1);
	new first = g_nom_page[id] * RTV_NOM_PAGE;

	new text[512], pos, keys = (1 << 9);
	if (g_nom_part[id][0])
	{
		pos = formatex(text, charsmax(text), "\yNominate a map (matching %s)^n^n", g_nom_part[id]);
	}
	else
	{
		pos = formatex(text, charsmax(text), "\yNominate a map^n^n");
	}
	for (new k = 0; k < RTV_NOM_PAGE && first + k < n; k++)
	{
		new m = list[first + k];
		if (nominated_by(g_maps[m]))
		{
			pos += formatex(text[pos], charsmax(text) - pos, "\y%d. \w%s  \d(nominated)^n", k + 1, g_maps[m]);
		}
		else
		{
			pos += formatex(text[pos], charsmax(text) - pos, "\y%d. \w%s^n", k + 1, g_maps[m]);
		}
		keys |= (1 << k);
	}
	pos += formatex(text[pos], charsmax(text) - pos, "^n");
	if (g_nom_page[id] > 0)
	{
		pos += formatex(text[pos], charsmax(text) - pos, "\y8. \wBack^n");
		keys |= (1 << 7);
	}
	if (g_nom_page[id] < pages - 1)
	{
		pos += formatex(text[pos], charsmax(text) - pos, "\y9. \wMore^n");
		keys |= (1 << 8);
	}
	formatex(text[pos], charsmax(text) - pos, "\y0. \wExit");
	h9vgui_show_menu(id, keys, text, -1, RTV_NOM_MENU, "rtv.nominate");
}

/// A key of the nominations menu, 0-based: 0-6 the page's maps, 7 back, 8 more, 9 exit.
public nominate_key(id, key)
{
	if (key == 9 || id < 1 || id >= RTV_SLOTS)
	{
		return PLUGIN_HANDLED;
	}
	if (key == 7 || key == 8)
	{
		g_nom_page[id] += (key == 8) ? 1 : -1;
		nominate_page(id);
		return PLUGIN_HANDLED;
	}
	new list[RTV_MAX_MAPS];
	new n = nominate_list(id, list);
	new at = g_nom_page[id] * RTV_NOM_PAGE + key;
	if (key >= RTV_NOM_PAGE || at >= n)
	{
		return PLUGIN_HANDLED;
	}
	new map[32];
	copy(map, charsmax(map), g_maps[list[at]]);

	if (g_voting || g_changing || !is_user_connected(id))
	{
		return PLUGIN_HANDLED;
	}
	// read again: the match mode, or the maps on disk, may have changed while the menu was up
	build_map_list();
	new idx = map_index(map);
	if (idx < 0)
	{
		client_print(id, print_chat, "[RTV] %s cannot be nominated here.", map);
		return PLUGIN_HANDLED;
	}
	nominate(id, idx);
	return PLUGIN_HANDLED;
}

/// .unnominate: takes back the player's nomination.
cmd_unnominate(id)
{
	if (!g_nom[id][0])
	{
		client_print(id, print_chat, "[RTV] You have not nominated a map.");
		return;
	}
	new name[32];
	get_user_name(id, name, charsmax(name));
	client_print(0, print_chat, "[RTV] %s took back the nomination of %s.", name, g_nom[id]);
	g_nom[id][0] = 0;
}
