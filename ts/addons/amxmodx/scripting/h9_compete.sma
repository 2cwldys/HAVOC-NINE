/*
 * h9_compete.sma -- rated play on H9 servers: compts's Elo and scoreboard, on havoc9.org
 *
 * After xjiro's Competitive TS (compts\, MIT): his plugin sent every kill to his own web service,
 * which kept one Elo-like number per SteamID and showed a top 100. This does the same for H9's
 * servers, where there are no SteamIDs: it reports each match to h9web (havoc9.org), which keeps
 * the ratings per havoc9.org account and shows them on havoc9.org/ladder/. docs\H9_COMPETITIVE.txt
 * is the guide; h9web's modules\presence\compete.js holds the rule.
 *
 * WHAT IT SENDS. Three kinds of call, signed with h9_presence's key (h9p_sign), so there is no key
 * of its own to set:
 *   start   when a match begins: the map, the ladder, and each player's h9_clientid and side
 *   kills   every 10 seconds while kills wait, numbered so h9web takes each batch once and in
 *           order: who is here, and each kill as [killer id, victim id, headshot, team kill]
 *   end     how the match ended, and each player's side, rounds, time, whether they left and
 *           their assists in it
 * and "rating" for the join line. h9web rates only players whose game proved its havoc9.org id on
 * this server (h9_presence's challenge, or the web client's relay). Everyone else plays as ever
 * and moves nothing. A player's own rank, and anyone's, is h9_rank.amxx's .rank (and /rank).
 *
 * ASSISTS come from ts_matchmode's count for the map, without the assists on a kill a bot had a part
 * in (tsm_assists_ranked; the scoreboard's A column, tsm_assists, counts those too): a player's
 * assists in a match are what it added between their joining the match and its end or their leaving,
 * summed over each time they were in it. A ts_matchmode without tsm_assists leaves the native
 * unbound, and the end report says null for everyone's assists; one without tsm_assists_ranked is
 * read through tsm_assists.
 *
 * THE LADDERS. "match": a ts_matchmode match wherever its match mode plays (tsm_enabled 1: Team
 * Elimination, Siege, Uplink, Assault, Mech Warrior and Wave Survival), from its first round going
 * live to its end (tsm_match_complete, tsm_match_forfeit), or cancelled when the match stops any other
 * way. "dm": every other map, TS's own game on its own rules (deathmatch or teamplay: the stock ts_
 * maps, h9_dm_, h9_tdm_, h9_ctb_ and the rest), one map one match. Roleplay maps (rp_ or tsrp_ at
 * the start, _rp_ or _tsrp_ inside) are never rated and nothing is sent from them.
 * h9_compete_ladder picks one by hand.
 *
 * KILLS come from DeathMsg, which ts_matchmode relies on too. A headshot is marked when TSX's
 * client_death says so for the same kill; without it a kill counts as a body shot. Bots and HLTV
 * are left out, and so are suicides and kills by the world.
 *
 * Needs h9_presence.amxx (above this plugin in plugins.ini) with a live key, and the AmxxEasyHttp
 * module. Without ts_matchmode only the dm ladder runs. On by default (h9_compete 1, which
 * configs/h9_compete.cfg sets on every map). A server without a live key, one havoc9.org does not
 * know, sends nothing and says nothing: no match starts and no join line is told. When havoc9.org
 * does not answer, a match's start is asked again after 30 seconds, then 60, up to 5 minutes
 * apart, and a refused match is logged once a map.
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler: explicit tags, braces on
 * every block, and no backslash escapes in strings.
 */

#include <amxmodx>
#include <amxmisc>
#include <easy_http>

#define H9C_CORE
#include <h9_community>
#include <tsm_api>

#pragma dynamic 16384

#define PLUGIN  "H9 Compete"
#define VERSION "1.2"
#define AUTHOR  "2cwldys, after xjiro"

#define MAX_BODY     12000   // h9_presence signs at most 12287 characters
#define MAX_KILLS    256     // kills kept while h9web has not taken them
#define MAX_ROSTER   128     // players one match remembers, by h9_clientid
#define BATCH_ROOM   600     // what a kill entry and the closing brackets may take, at most
#define CALL_TIMEOUT 15000
#define END_TRIES    6

#define TASK_FLUSH   59310
#define TASK_WATCH   59311
#define TASK_DM      59312
#define TASK_JOIN    59400   // + the slot

#define LADDER_OFF   0
#define LADDER_MATCH 1
#define LADDER_DM    2

new g_cv_on, g_cv_ladder, g_cv_notice;
new bool:g_have_presence = true;
new bool:g_have_tsm = true;
new bool:g_have_assists = true;          // ts_matchmode has tsm_assists (its match-bar build and later)
new bool:g_have_assists_ranked = true;   // and tsm_assists_ranked, the count without a bot's kills
new g_maxplayers;
new g_gen[MAX_PLAYERS + 1];              // counts who held the slot, so a late answer finds the right player

// The match under way here. g_open from its start to its end; g_match once h9web has numbered it.
new bool:g_open = false;
new g_ladder = LADDER_OFF;
new g_match = 0;
new bool:g_starting = false;
new g_start_next = 0;                    // no start asked for again before this (systime)
new g_start_wait = 30;                   // and the wait after the next unanswered one, doubling to 300
new bool:g_refusal_logged = false;       // a refused match is logged once a map
new bool:g_unrated = false;              // h9web answered not_rated: this server gives no rating and no experience
new bool:g_unrated_told = false;         // and the players were told, once a map
new bool:g_ending = false;
new g_end_how[12];
new g_end_winner, g_end_s1, g_end_s2;
new g_end_tries = 0;
new g_seq = 0;                           // the last batch h9web took
new g_rounds = 0;
new g_oneround = 0;                      // 1 when the mode plays its match as one round (tsm_one_round), as the last round went live
new g_bots = 0;                          // the most bots seen on the sides at once
new g_others[3];                         // the most humans seen on each side without an h9_clientid
new g_last_batch = 0;

// Everyone the match has seen, by h9_clientid: side, rounds played, seconds in it, and whether
// they are here now.
new g_rid[MAX_ROSTER][33];
new g_rside[MAX_ROSTER];
new g_rrounds[MAX_ROSTER];
new g_rsecs[MAX_ROSTER];
new g_rsince[MAX_ROSTER];
new bool:g_rhere[MAX_ROSTER];
new g_rassists[MAX_ROSTER];              // assists banked from the times the player left the match
new g_rbase[MAX_ROSTER];                 // ts_matchmode's count for them when they last joined it
new g_rcount = 0;
new g_entry[MAX_PLAYERS + 1];            // the slot's roster entry, -1 for none

// Kills waiting for h9web, oldest first.
new g_kk[MAX_KILLS][33];
new g_kv[MAX_KILLS][33];
new g_khs[MAX_KILLS];
new g_ktk[MAX_KILLS];
new g_kn = 0;
new g_kdropped = 0;
new g_last_k, g_last_v, g_last_i = -1;
new Float:g_last_at;
new g_hs_k, g_hs_v;
new Float:g_hs_at;

// The one request in flight (start, kills or end): its batch's size and number.
new bool:g_busy = false;
new g_sent_kills = 0;
new g_sent_seq = 0;
new g_last_code = 0;
new g_last_error[64];

new g_body[MAX_BODY];
new g_len;
new bool:g_full = false;
new const HEX[] = "0123456789abcdef";
new const LADDER_NAMES[][] = { "off", "match", "dm" };

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);
	g_cv_on = register_cvar("h9_compete", "0", FCVAR_SERVER);
	g_cv_ladder = register_cvar("h9_compete_ladder", "auto");
	g_cv_notice = register_cvar("h9_compete_notice", "1");
	register_srvcmd("h9_compete_status", "cmd_status");
	register_event("DeathMsg", "ev_death", "a");
	g_maxplayers = min(get_maxplayers(), MAX_PLAYERS);
	for (new i = 0; i <= MAX_PLAYERS; i++)
	{
		g_entry[i] = -1;
	}
}

public plugin_natives()
{
	set_native_filter("native_filter");
}

// h9_presence and ts_matchmode may be missing: their natives go unbound, and a call to one marks
// it gone and answers 0.
public native_filter(const name[], index, trap)
{
	if (equal(name, "tsm_assists"))
	{
		g_have_assists = false;
		return PLUGIN_HANDLED;
	}
	if (equal(name, "tsm_assists_ranked"))
	{
		g_have_assists_ranked = false;
		return PLUGIN_HANDLED;
	}
	if (!trap)
	{
		return PLUGIN_HANDLED;
	}
	if (equal(name, "h9p_", 4))
	{
		g_have_presence = false;
		return PLUGIN_HANDLED;
	}
	if (equal(name, "tsm_", 4))
	{
		g_have_tsm = false;
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

public plugin_cfg()
{
	// configs/h9_compete.cfg: the server's own settings, or a preset's (H9XASH\presets)
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_compete.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
	set_task(10.0, "task_flush", TASK_FLUSH, _, _, "b");
	set_task(5.0, "task_watch", TASK_WATCH, _, _, "b");
	set_task(20.0, "task_dm", TASK_DM);
}

// ---- which ladder this map plays ----------------------------------------------------------------

/** rp_ or tsrp_ at the start, _rp_ or _tsrp_ anywhere: as roleplay_map() in ts_matchmode.sma. */
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

pick_ladder()
{
	if (!get_pcvar_num(g_cv_on))
	{
		return LADDER_OFF;
	}
	new want[16];
	get_pcvar_string(g_cv_ladder, want, charsmax(want));
	trim(want);
	if (equali(want, "off"))
	{
		return LADDER_OFF;
	}
	if (equali(want, "match"))
	{
		return LADDER_MATCH;
	}
	if (equali(want, "dm"))
	{
		return LADDER_DM;
	}
	new map[64];
	get_mapname(map, charsmax(map));
	if (roleplay_map(map))
	{
		return LADDER_OFF;
	}
	// ts_matchmode's match mode plays here (its plugin_cfg turns tsm_enabled off where it does not)
	if (g_have_tsm && get_cvar_num("tsm_enabled") != 0)
	{
		return LADDER_MATCH;
	}
	return LADDER_DM;
}

bool:ready()
{
	return g_have_presence && h9p_ready() != 0;
}

bool:is_human(id)
{
	return id >= 1 && id <= g_maxplayers && is_user_connected(id) && !is_user_bot(id) && !is_user_hltv(id);
}

/** The player's h9_clientid, when it is one: 32 lowercase hex characters. */
bool:client_id(id, out[33])
{
	out[0] = 0;
	get_user_info(id, "h9_clientid", out, 32);
	if (strlen(out) != 32)
	{
		out[0] = 0;
		return false;
	}
	for (new i = 0; i < 32; i++)
	{
		new c = out[i];
		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
		{
			out[0] = 0;
			return false;
		}
	}
	return true;
}

side_of(id)
{
	if (g_ladder == LADDER_MATCH && g_have_tsm)
	{
		return tsm_side_of(id);
	}
	return 0;
}

bool:same_side(a, b)
{
	if (g_ladder == LADDER_MATCH)
	{
		new s = side_of(a);
		return s != 0 && s == side_of(b);
	}
	return get_cvar_num("mp_teamplay") != 0 && get_user_team(a) != 0 && get_user_team(a) == get_user_team(b);
}

// ---- the match ----------------------------------------------------------------------------------

reset_match()
{
	g_open = false;
	g_match = 0;
	g_starting = false;
	g_ending = false;
	g_end_tries = 0;
	g_seq = 0;
	g_rounds = 0;
	g_oneround = 0;
	g_bots = 0;
	g_others[1] = 0;
	g_others[2] = 0;
	g_rcount = 0;
	g_kn = 0;
	g_kdropped = 0;
	g_last_i = -1;
	for (new i = 0; i <= MAX_PLAYERS; i++)
	{
		g_entry[i] = -1;
	}
}

begin_match(ladder)
{
	reset_match();
	g_ladder = ladder;
	g_open = true;
	g_last_batch = get_systime();
	for (new i = 1; i <= g_maxplayers; i++)
	{
		if (is_human(i))
		{
			roster_join(i);
		}
	}
	send_start();
}

roster_join(id)
{
	new cid[33];
	if (!client_id(id, cid))
	{
		g_entry[id] = -1;
		return;
	}
	new k = -1;
	for (new i = 0; i < g_rcount; i++)
	{
		if (equal(g_rid[i], cid))
		{
			k = i;
			break;
		}
	}
	if (k == -1)
	{
		if (g_rcount >= MAX_ROSTER)
		{
			g_entry[id] = -1;
			return;
		}
		k = g_rcount++;
		copy(g_rid[k], 32, cid);
		g_rside[k] = 0;
		g_rrounds[k] = 0;
		g_rsecs[k] = 0;
		g_rhere[k] = false;
		g_rassists[k] = 0;
	}
	if (!g_rhere[k])
	{
		g_rhere[k] = true;
		g_rsince[k] = get_systime();
		g_rbase[k] = assists_now(id);
	}
	new s = side_of(id);
	if (s)
	{
		g_rside[k] = s;
	}
	g_entry[id] = k;
}

roster_leave(id)
{
	new k = g_entry[id];
	g_entry[id] = -1;
	if (k < 0 || k >= g_rcount || !g_rhere[k])
	{
		return;
	}
	g_rsecs[k] += get_systime() - g_rsince[k];
	g_rassists[k] += assists_since(g_rbase[k], assists_now(id));
	g_rhere[k] = false;
}

/** ts_matchmode's assists for the player on this map, bots' kills left out; 0 without tsm_assists. */
assists_now(id)
{
	if (!g_have_tsm || !g_have_assists)
	{
		return 0;
	}
	if (g_have_assists_ranked)
	{
		return max(0, tsm_assists_ranked(id));
	}
	return max(0, tsm_assists(id));
}

/** What the count added since base; a count below base was started over (a new player in the slot). */
assists_since(base, now)
{
	return now >= base ? now - base : now;
}

/** A roster entry's assists in the match so far: banked, and since they joined while they are here. */
assists_of(k)
{
	new n = g_rassists[k];
	if (g_rhere[k])
	{
		for (new i = 1; i <= g_maxplayers; i++)
		{
			if (g_entry[i] == k && is_human(i))
			{
				n += assists_since(g_rbase[k], assists_now(i));
				break;
			}
		}
	}
	return n;
}

public tsm_round_live(round)
{
	#pragma unused round
	if (!g_open)
	{
		if (pick_ladder() != LADDER_MATCH || !g_have_tsm || !tsm_match_running() || !ready())
		{
			return;
		}
		begin_match(LADDER_MATCH);
	}
	if (g_ladder != LADDER_MATCH || g_ending)
	{
		return;
	}
	g_rounds++;
	g_oneround = tsm_one_round() ? 1 : 0;
	new bots = 0;
	new others[3];
	for (new i = 1; i <= g_maxplayers; i++)
	{
		if (!is_user_connected(i) || is_user_hltv(i))
		{
			continue;
		}
		new s = tsm_side_of(i);
		if (s != 1 && s != 2)
		{
			continue;
		}
		if (is_user_bot(i))
		{
			bots++;
			continue;
		}
		if (g_entry[i] < 0)
		{
			roster_join(i);
		}
		new k = g_entry[i];
		if (k < 0)
		{
			others[s]++;
			continue;
		}
		g_rside[k] = s;
		g_rrounds[k]++;
	}
	g_bots = max(g_bots, bots);
	g_others[1] = max(g_others[1], others[1]);
	g_others[2] = max(g_others[2], others[2]);
}

public tsm_match_complete(winner)
{
	if (g_open && g_ladder == LADDER_MATCH)
	{
		end_match("finished", winner, tsm_score(1), tsm_score(2));
	}
}

public tsm_match_forfeit(winner)
{
	if (g_open && g_ladder == LADDER_MATCH)
	{
		end_match("forfeit", winner, tsm_score(1), tsm_score(2));
	}
}

end_match(const how[], winner, s1, s2)
{
	if (!g_open || g_ending)
	{
		return;
	}
	g_ending = true;
	copy(g_end_how, charsmax(g_end_how), how);
	g_end_winner = winner;
	g_end_s1 = s1;
	g_end_s2 = s2;
	g_end_tries = 0;
	flush();
}

// A match that stops without its end (an admin's restart or cancel, sides that emptied) is
// cancelled; a deathmatch map's match ends 20 seconds before its time runs out.
public task_watch()
{
	if (!g_open || g_ending)
	{
		return;
	}
	if (g_ladder == LADDER_MATCH)
	{
		if (!g_have_tsm || !tsm_match_running())
		{
			end_match("cancelled", 0, 0, 0);
		}
		return;
	}
	if (g_ladder == LADDER_DM && get_cvar_float("mp_timelimit") > 0.0 && get_timeleft() <= 20)
	{
		end_match("finished", 0, 0, 0);
	}
}

public task_dm()
{
	if (g_open || pick_ladder() != LADDER_DM)
	{
		return;
	}
	new humans = 0;
	for (new i = 1; i <= g_maxplayers; i++)
	{
		if (is_human(i))
		{
			humans++;
		}
	}
	if (humans < 2 || !ready() || (get_cvar_float("mp_timelimit") > 0.0 && get_timeleft() <= 60))
	{
		set_task(20.0, "task_dm", TASK_DM);
		return;
	}
	begin_match(LADDER_DM);
}

// ---- players coming and going -------------------------------------------------------------------

public client_putinserver(id)
{
	if (id < 1 || id > g_maxplayers)
	{
		return;
	}
	g_gen[id]++;
	g_entry[id] = -1;
	if (!is_human(id))
	{
		return;
	}
	if (g_open)
	{
		roster_join(id);
	}
	if (get_pcvar_num(g_cv_on) && get_pcvar_num(g_cv_notice))
	{
		remove_task(TASK_JOIN + id);
		set_task(15.0, "task_join", TASK_JOIN + id);
	}
}

public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id < 1 || id > g_maxplayers)
	{
		return;
	}
	g_gen[id]++;
	remove_task(TASK_JOIN + id);
	if (g_open)
	{
		roster_leave(id);
	}
	g_entry[id] = -1;
}

public task_join(task)
{
	new id = task - TASK_JOIN;
	if (!is_human(id) || pick_ladder() == LADDER_OFF || !ready())
	{
		return;
	}
	if (g_unrated)
	{
		client_print(id, print_chat, "[H9] This server is not rated by havoc9.org: matches here give no rating and no experience.");
		return;
	}
	client_print(id, print_chat, "[H9] Rated server: matches here count on havoc9.org for players using their account's id.");
	client_print(id, print_chat, "[H9] Your ACCOUNT page there decides who sees your rating. Say .rank for yours.");
	send_rating(id);
}

// ---- kills --------------------------------------------------------------------------------------

public ev_death()
{
	if (!g_open || g_ending)
	{
		return;
	}
	new killer = read_data(1);
	new victim = read_data(2);
	if (killer == victim || !is_human(killer) || !is_human(victim))
	{
		return;
	}
	new kid[33], vid[33];
	if (!client_id(killer, kid) || !client_id(victim, vid))
	{
		return;
	}
	if (g_kn >= MAX_KILLS)
	{
		g_kdropped++;
		return;
	}
	new Float:t = get_gametime();
	new k = g_kn++;
	copy(g_kk[k], 32, kid);
	copy(g_kv[k], 32, vid);
	g_khs[k] = (g_hs_k == killer && g_hs_v == victim && t - g_hs_at < 0.5) ? 1 : 0;
	g_ktk[k] = same_side(killer, victim) ? 1 : 0;
	g_hs_k = 0;
	g_last_k = killer;
	g_last_v = victim;
	g_last_at = t;
	g_last_i = k;
}

// TSX's own death forward, used only for the headshot: whichever of the two comes first, the
// kill gets the mark.
public client_death(killer, victim, wpnindex, hitplace, TK)
{
	#pragma unused wpnindex, TK
	if (hitplace != 1)
	{
		return;
	}
	new Float:t = get_gametime();
	if (g_last_k == killer && g_last_v == victim && t - g_last_at < 0.5 && g_last_i >= 0 && g_last_i < g_kn)
	{
		g_khs[g_last_i] = 1;
		return;
	}
	g_hs_k = killer;
	g_hs_v = victim;
	g_hs_at = t;
}

/** Forgets the first n kills, which h9web has taken. */
drop_kills(n)
{
	if (n <= 0)
	{
		return;
	}
	if (n >= g_kn)
	{
		g_kn = 0;
		g_last_i = -1;
		return;
	}
	for (new i = n; i < g_kn; i++)
	{
		copy(g_kk[i - n], 32, g_kk[i]);
		copy(g_kv[i - n], 32, g_kv[i]);
		g_khs[i - n] = g_khs[i];
		g_ktk[i - n] = g_ktk[i];
	}
	g_kn -= n;
	g_last_i = g_last_i >= n ? g_last_i - n : -1;
}

// ---- the calls ----------------------------------------------------------------------------------

/** Whatever is due: the start again, a batch of kills, or the end once every kill is in. */
flush()
{
	if (g_busy || !g_open)
	{
		return;
	}
	if (!g_match)
	{
		if (g_ending)
		{
			// h9web never numbered this match: there is nothing to end there
			reset_match();
			return;
		}
		if (!g_starting && get_systime() >= g_start_next)
		{
			send_start();
		}
		return;
	}
	if (g_kn > 0 || (!g_ending && get_systime() - g_last_batch >= 60))
	{
		send_kills();
		return;
	}
	if (g_ending)
	{
		send_end();
	}
}

public task_flush()
{
	flush();
}

send_start()
{
	if (!ready())
	{
		return;
	}
	body_begin();
	new map[64], mode[48];
	get_mapname(map, charsmax(map));
	get_cvar_string("tsm_pres_mode", mode, charsmax(mode));
	if (!mode[0])
	{
		if (g_ladder == LADDER_DM)
		{
			copy(mode, charsmax(mode), "deathmatch");
		}
		else
		{
			copy(mode, charsmax(mode), "Team Elimination");
		}
	}
	app_raw(",^"ladder^":");
	app_str(LADDER_NAMES[g_ladder]);
	app_raw(",^"map^":");
	app_str(map);
	app_raw(",^"mode^":");
	app_str(mode);
	new humans = 0, bots = 0;
	for (new i = 1; i <= g_maxplayers; i++)
	{
		if (!is_user_connected(i) || is_user_hltv(i))
		{
			continue;
		}
		if (is_user_bot(i))
		{
			bots++;
		}
		else
		{
			humans++;
		}
	}
	app_raw(",^"humans^":");
	app_num(humans);
	app_raw(",^"bots^":");
	app_num(bots);
	app_roster();
	app_raw("}");
	g_starting = true;
	if (!post_signed("/compete/start", "on_start"))
	{
		g_starting = false;
	}
}

/** ,"players":[["<id>",side],...] for everyone here with an h9_clientid. */
app_roster()
{
	app_raw(",^"players^":[");
	new bool:first = true;
	for (new i = 1; i <= g_maxplayers; i++)
	{
		if (!is_human(i))
		{
			continue;
		}
		new cid[33];
		if (!client_id(i, cid))
		{
			continue;
		}
		if (!first)
		{
			app_raw(",");
		}
		first = false;
		app_raw("[");
		app_str(cid);
		app_raw(",");
		app_num(side_of(i));
		app_raw("]");
	}
	app_raw("]");
}

send_kills()
{
	body_begin();
	app_raw(",^"match^":");
	app_num(g_match);
	app_raw(",^"seq^":");
	app_num(g_seq + 1);
	app_roster();
	app_raw(",^"kills^":[");
	new n = 0;
	for (new i = 0; i < g_kn && n < 150; i++)
	{
		if (g_len > MAX_BODY - BATCH_ROOM)
		{
			break;
		}
		if (n)
		{
			app_raw(",");
		}
		app_raw("[");
		app_str(g_kk[i]);
		app_raw(",");
		app_str(g_kv[i]);
		app_raw(",");
		app_num(g_khs[i]);
		app_raw(",");
		app_num(g_ktk[i]);
		app_raw("]");
		n++;
	}
	app_raw("]}");
	g_sent_kills = n;
	g_sent_seq = g_seq + 1;
	post_signed("/compete/kills", "on_kills");
}

send_end()
{
	new now = get_systime();
	body_begin();
	app_raw(",^"match^":");
	app_num(g_match);
	app_raw(",^"seq^":");
	app_num(g_seq);
	app_raw(",^"result^":{^"how^":");
	app_str(g_end_how);
	app_raw(",^"winner^":");
	app_num(g_end_winner);
	app_raw(",^"score1^":");
	app_num(g_end_s1);
	app_raw(",^"score2^":");
	app_num(g_end_s2);
	app_raw(",^"rounds^":");
	app_num(g_rounds);
	app_raw(",^"oneRound^":");
	app_num(g_oneround);
	app_raw("},^"players^":[");
	for (new k = 0; k < g_rcount; k++)
	{
		if (k)
		{
			app_raw(",");
		}
		new secs = g_rsecs[k] + (g_rhere[k] ? now - g_rsince[k] : 0);
		app_raw("[");
		app_str(g_rid[k]);
		app_raw(",");
		app_num(g_rside[k]);
		app_raw(",");
		app_num(g_rrounds[k]);
		app_raw(",");
		app_num(secs);
		app_raw(",");
		app_num(g_rhere[k] ? 0 : 1);
		app_raw(",");
		if (g_have_tsm && g_have_assists)
		{
			app_num(assists_of(k));
		}
		else
		{
			app_raw("null");
		}
		app_raw("]");
	}
	app_raw("],^"others^":{^"1^":");
	app_num(g_others[1]);
	app_raw(",^"2^":");
	app_num(g_others[2]);
	app_raw("},^"bots^":");
	app_num(g_bots);
	app_raw("}");
	post_signed("/compete/end", "on_end");
}

/** The answer's status, or 0 with g_last_error set when there was none. */
answer(EzHttpRequest:request_id, &EzJSON:root)
{
	root = EzInvalid_JSON;
	g_busy = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		g_last_code = 0;
		copy(g_last_error, charsmax(g_last_error), "no answer");
		return 0;
	}
	new code = ezhttp_get_http_code(request_id);
	g_last_code = code;
	root = ezhttp_parse_json_response(request_id);
	g_last_error[0] = 0;
	if (code != 200 && root != EzInvalid_JSON && ezjson_object_has_value(root, "error", EzJSONString))
	{
		ezjson_object_get_string(root, "error", g_last_error, charsmax(g_last_error));
	}
	return code;
}

/** h9web answered not_rated (the server is not authenticated, is UNRANKED or a listen server, or its match was voided): nothing here
 * gives a rating or experience. Said to everyone once a map, when h9_compete_notice is on, and to each player who joins after. */
tell_unrated()
{
	g_unrated = true;
	if (g_unrated_told || !get_pcvar_num(g_cv_notice))
	{
		return;
	}
	g_unrated_told = true;
	client_print(0, print_chat, "[H9] This server is not rated by havoc9.org: matches here give no rating and no experience.");
}

public on_start(EzHttpRequest:request_id)
{
	new EzJSON:root;
	new code = answer(request_id, root);
	g_starting = false;
	if (code == 200 && root != EzInvalid_JSON && ezjson_object_has_value(root, "match", EzJSONNumber))
	{
		g_start_wait = 30;
		g_start_next = 0;
		if (g_open)
		{
			g_match = ezjson_object_get_number(root, "match");
			g_seq = 0;
		}
	}
	else if (code >= 400 && code < 500 && code != 429)
	{
		// refused (the key, a roleplay map, an UNRANKED server): nothing of this match goes anywhere
		if (!g_refusal_logged)
		{
			g_refusal_logged = true;
			log_amx("[H9] h9web does not rate matches here: HTTP %d %s", code, g_last_error);
		}
		if (code == 409 && equal(g_last_error, "not_rated"))
		{
			tell_unrated();
		}
		reset_match();
	}
	else
	{
		// no answer, or a busy one: ask again later, each time a while longer
		g_start_next = get_systime() + g_start_wait;
		g_start_wait = min(g_start_wait * 2, 300);
	}
	if (root != EzInvalid_JSON)
	{
		ezjson_free(root);
	}
	if (g_open && g_match && (g_kn > 0 || g_ending))
	{
		flush();
	}
}

public on_kills(EzHttpRequest:request_id)
{
	new EzJSON:root;
	new code = answer(request_id, root);
	if (root != EzInvalid_JSON)
	{
		ezjson_free(root);
	}
	if (!g_open)
	{
		return;
	}
	if (code == 200)
	{
		drop_kills(g_sent_kills);
		g_seq = g_sent_seq;
		g_last_batch = get_systime();
		if (g_kn > 0 || g_ending)
		{
			flush();
		}
		return;
	}
	if (code == 404 || (code == 409 && (equal(g_last_error, "match_over") || equal(g_last_error, "not_rated"))))
	{
		// h9web has closed this match (another started, or it was abandoned), or voided it: the server is no longer one
		// that is rated (it stopped being authenticated, or an admin made it UNRANKED)
		if (code == 409 && equal(g_last_error, "not_rated"))
		{
			tell_unrated();
		}
		reset_match();
	}
}

public on_end(EzHttpRequest:request_id)
{
	new EzJSON:root;
	new code = answer(request_id, root);
	if (code == 200 && root != EzInvalid_JSON)
	{
		tell_result(root);
	}
	if (root != EzInvalid_JSON)
	{
		ezjson_free(root);
	}
	if (code == 200 || code == 404 || (code == 409 && equal(g_last_error, "not_rated")) || (code >= 400 && code < 500 && code != 429 && code != 409))
	{
		if (code == 409)
		{
			tell_unrated();
		}
		reset_match();
		return;
	}
	if (code == 409)
	{
		// a batch of kills is still missing: send it first
		g_ending = true;
	}
	if (++g_end_tries >= END_TRIES)
	{
		log_amx("[H9] Could not report the end of match %d to h9web (HTTP %d %s).", g_match, code, g_last_error);
		reset_match();
	}
}

/** Each player's change in this match, to that player; and why it was not rated, to everyone. */
tell_result(EzJSON:root)
{
	new bool:rated = ezjson_object_has_value(root, "rated", EzJSONBoolean) && ezjson_object_get_bool(root, "rated");
	if (!rated && equal(g_end_how, "cancelled"))
	{
		return;
	}
	if (!rated && g_ladder == LADDER_MATCH && ezjson_object_has_value(root, "why", EzJSONString))
	{
		new why[128];
		ezjson_object_get_string(root, "why", why, charsmax(why));
		client_print(0, print_chat, "[H9] Match recorded, result not rated: %s.", why);
	}
	if (!ezjson_object_has_value(root, "changes", EzJSONObject))
	{
		return;
	}
	new EzJSON:changes = ezjson_object_get_value(root, "changes");
	for (new i = 1; i <= g_maxplayers; i++)
	{
		new cid[33];
		if (!is_human(i) || !client_id(i, cid) || !ezjson_object_has_value(changes, cid, EzJSONObject))
		{
			continue;
		}
		new EzJSON:c = ezjson_object_get_value(changes, cid);
		new line[160], part[48];
		copy(line, charsmax(line), "[H9] This match:");
		if (ezjson_object_has_value(c, "server", EzJSONNumber))
		{
			signed_num(ezjson_object_get_number(c, "server"), part, charsmax(part));
			format(line, charsmax(line), "%s %s on this server's table", line, part);
		}
		if (ezjson_object_has_value(c, "network", EzJSONNumber))
		{
			signed_num(ezjson_object_get_number(c, "network"), part, charsmax(part));
			format(line, charsmax(line), "%s, %s on the H9 ladder", line, part);
		}
		ezjson_free(c);
		if (strlen(line) > 16)
		{
			client_print(i, print_chat, "%s.", line);
		}
	}
	ezjson_free(changes);
}

signed_num(n, out[], len)
{
	if (n >= 0)
	{
		formatex(out, len, "+%d", n);
	}
	else
	{
		formatex(out, len, "%d", n);
	}
}

// ---- the join line ------------------------------------------------------------------------------

/**
 * Asks h9web for one player's rating, to tell everyone, as compts did. A player's own rank is
 * h9_rank.amxx's .rank (and /rank).
 */
bool:send_rating(id)
{
	new cid[33];
	if (!ready() || !client_id(id, cid))
	{
		return false;
	}
	body_begin();
	app_raw(",^"ladder^":");
	if (pick_ladder() == LADDER_DM)
	{
		app_str("dm");
	}
	else
	{
		app_str("match");
	}
	app_raw(",^"ids^":[");
	app_str(cid);
	app_raw("]}");
	new ud[2];
	ud[0] = id;
	ud[1] = g_gen[id];
	return post_raw("/compete/rating", "on_rating", ud, sizeof(ud));
}

public on_rating(EzHttpRequest:request_id)
{
	new ud[2];
	ezhttp_get_user_data(request_id, ud);
	new id = ud[0];
	if (ezhttp_get_error_code(request_id) != EZH_OK || ezhttp_get_http_code(request_id) != 200)
	{
		return;
	}
	if (id < 1 || id > g_maxplayers || g_gen[id] != ud[1] || !is_human(id))
	{
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		return;
	}
	new cid[33];
	client_id(id, cid);
	new EzJSON:players = ezjson_object_has_value(root, "players", EzJSONObject) ? ezjson_object_get_value(root, "players") : EzInvalid_JSON;
	if (players != EzInvalid_JSON && cid[0] && ezjson_object_has_value(players, cid, EzJSONObject))
	{
		new EzJSON:p = ezjson_object_get_value(players, cid);
		new bool:public_ = ezjson_object_has_value(p, "public", EzJSONBoolean) && ezjson_object_get_bool(p, "public");
		new elo = -1, rank = 0;
		if (ezjson_object_has_value(p, "server", EzJSONObject))
		{
			new EzJSON:sv = ezjson_object_get_value(p, "server");
			elo = ezjson_object_get_number(sv, "elo");
			rank = ezjson_object_get_number(sv, "rank");
			ezjson_free(sv);
		}
		ezjson_free(p);
		if (public_ && elo >= 0)
		{
			new name[64];
			get_user_name(id, name, charsmax(name));
			client_print(0, print_chat, "[H9] %s: #%d on this server (%d).", name, rank, elo);
		}
	}
	if (players != EzInvalid_JSON)
	{
		ezjson_free(players);
	}
	ezjson_free(root);
}

// ---- the console --------------------------------------------------------------------------------

public cmd_status()
{
	server_print("[H9] h9_compete %s, ladder on this map: %s", VERSION, LADDER_NAMES[pick_ladder()]);
	if (ready())
	{
		server_print("[H9]   h9_presence key: live");
	}
	else if (g_have_presence)
	{
		server_print("[H9]   h9_presence key: not live yet");
	}
	else
	{
		server_print("[H9]   h9_presence is not loaded");
	}
	if (g_open)
	{
		server_print("[H9]   match %d (%s), %d rounds, batch %d, %d kills waiting, %d dropped",
			g_match, LADDER_NAMES[g_ladder], g_rounds, g_seq, g_kn, g_kdropped);
		if (g_ending)
		{
			server_print("[H9]   the match is ending: its last kills and its end are on the way");
		}
	}
	else
	{
		server_print("[H9]   no match under way");
	}
	if (g_last_code || g_last_error[0])
	{
		server_print("[H9]   last answer from h9web: %d %s", g_last_code, g_last_error);
	}
	return PLUGIN_HANDLED;
}

// ---- signed calls -------------------------------------------------------------------------------

/** { "v": 1, "server", "ts", "nonce" -- the caller adds its fields and the closing brace. */
body_begin()
{
	g_len = 0;
	g_body[0] = 0;
	g_full = false;
	new server[48], nonce[20];
	server[0] = 0;
	nonce[0] = 0;
	h9p_server(server, charsmax(server));
	h9p_nonce(nonce, charsmax(nonce));
	app_raw("{^"v^":1,^"server^":");
	app_str(server);
	app_raw(",^"ts^":");
	app_num(get_systime());
	app_raw(",^"nonce^":");
	app_str(nonce);
}

/** POSTs g_body as the one call in flight. */
bool:post_signed(const path[], const callback[])
{
	if (g_busy)
	{
		return false;
	}
	new ud[1];
	if (!post_raw(path, callback, ud, 0))
	{
		return false;
	}
	g_busy = true;
	return true;
}

/** POSTs g_body to h9web's presence API + path, signed with h9_presence's live key. */
bool:post_raw(const path[], const callback[], const ud[], udlen)
{
	if (g_full)
	{
		return false;
	}
	new sig[72], server[48], url[224];
	if (!h9p_server(server, charsmax(server)) || !h9p_sign(g_body, sig, charsmax(sig)) || strlen(sig) != 64)
	{
		return false;
	}
	h9p_api(url, charsmax(url));
	if (!equal(url, "https://", 8) && !equal(url, "http://", 7))
	{
		return false;
	}
	add(url, charsmax(url), path);
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_compete/1.0");
	ezhttp_option_set_timeout(opt, CALL_TIMEOUT);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, g_body);
	if (udlen > 0)
	{
		ezhttp_option_set_user_data(opt, ud, udlen);
	}
	ezhttp_post(url, callback, opt);
	return true;
}

app_byte(b)
{
	if (g_len >= MAX_BODY - 2)
	{
		g_full = true;
		return;
	}
	g_body[g_len] = b & 0xFF;
	g_len++;
	g_body[g_len] = 0;
}

app_raw(const s[])
{
	for (new i = 0; s[i]; i++)
	{
		app_byte(s[i]);
	}
}

app_num(n)
{
	new t[16];
	num_to_str(n, t, charsmax(t));
	app_raw(t);
}

/** A JSON string: quoted, with the quote and the backslash escaped and control characters as u00XX. */
app_str(const s[])
{
	app_byte(34);
	for (new i = 0; s[i]; i++)
	{
		new c = s[i] & 0xFF;
		if (c == 34 || c == 92)
		{
			app_byte(92);
			app_byte(c);
		}
		else if (c < 32 || c == 127)
		{
			app_byte(92);
			app_raw("u00");
			app_byte(HEX[(c >> 4) & 15]);
			app_byte(HEX[c & 15]);
		}
		else
		{
			app_byte(c);
		}
	}
	app_byte(34);
}
