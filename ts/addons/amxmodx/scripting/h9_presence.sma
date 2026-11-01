/*
 * h9_presence.sma -- tells havoc9.org who is in game on this server
 *
 * Every 60 seconds, and a few seconds after anyone joins, leaves or changes name, this POSTs a
 * report to h9web's presence module (https://havoc9.org/api/presence/report): the map, the mode
 * (named the way the engine's Discord card names it), and for every human player with an
 * h9_clientid that id, the name, the join time and the time in game. Bots and HLTV are left out.
 * h9web keeps only the players whose h9_clientid belongs to a havoc9.org account and drops every
 * other id at once. docs\H9_PRESENCE.txt is the guide; docs\H9_COMMUNITIES.txt for communities.
 *
 * THE KEY. Each server has its own key, and every report carries X-H9-Signature: HMAC-SHA256
 * over the exact body, keyed with it, and a timestamp later than the last one, so a report cannot
 * be forged, altered or replayed. A dedicated server gets its key by itself (ENROLLMENT, below); a
 * key made by hand with h9web's presence-key.js, put in h9_presence.cfg with h9_presence_server,
 * wins over it. The cvar is protected, and the key is never logged or printed.
 *
 * ENROLLMENT (h9_presence_autoenroll 1, the default; never on a listen server). The plugin asks
 * h9web for a key for its own address (the IP h9web sees and this server's port). The key comes
 * back inactive, with a code the plugin puts in h9_presence_enroll, an FCVAR_SERVER cvar (and
 * FCVAR_UNLOGGED: no "changed to" line for anyone). h9web reads the server's rules over UDP; the
 * code there proves the address is this server, and the key goes live (an H9 admin approves a
 * server that is not on h9web's list first). The key, the address, the public server id and the
 * enrollment's state are kept in addons/amxmodx/data/h9_presence.key, which client packages and
 * git leave out. A server h9web cannot reach (behind NAT, on a LAN) stays unenrolled and asks
 * again less and less often, from 10 seconds to every 6 hours, without a word in the console.
 *
 * KICKS AND MUTES. h9web's answer to each report says which players to kick (a ban of their
 * account, in this server's community or H9-wide, or a one-off kick) and which are muted; a muted
 * player's chat goes nowhere.
 *
 * FOR OTHER PLUGINS: natives h9p_ready, h9p_server, h9p_server_id, h9p_api, h9p_sign, h9p_nonce,
 * h9p_report_soon and h9p_muted (include/h9_community.inc), which h9_community.sma uses.
 *
 * THE PROOF (h9_presence_challenge 1, once the engine answers it). h9_clientid is the same value
 * for a player every time and every player on the server can read it, so on its own it proves
 * nothing. A client that advertises _h9idv 1 in its userinfo gets a one-time nonce
 * (h9_idchallenge <nonce>) and answers with HMAC-SHA256(its raw player id, nonce + this server's
 * address) and its masked device id (h9_idproof <nonce> <devmask> <proof>); the plugin forwards
 * the answer to its own challenge only, and h9web checks it. Off by default.
 *
 * NAMES (h9_presence_names 1, which needs h9_presence_challenge 1). On every map but roleplay
 * maps (roleplay_map(), as ts_matchmode.sma has it) and stock ts_ maps, the report asks h9web
 * for names: a proven account plays under its havoc9.org username, set on join and on every map
 * change and put back at once when changed in game, and anyone else using an account's name
 * (look-alikes included) plays as "Player 1234". One short chat line says why. Off by default.
 *
 * WHY THE PLUGIN HAS ITS OWN SHA-256. AMXX's hash_string takes text up to its first zero byte, and
 * the second half of an HMAC hashes raw bytes. sha_* below is FIPS 180-4 SHA-256 over bytes held
 * one per cell; it checks itself against the FIPS and RFC 4231 test vectors and against
 * hash_string when the plugin loads, and a plugin that fails the check never reports.
 *
 * Needs the AmxxEasyHttp module and its CA bundle, as ts_advertise does:
 *     addons/amxmodx/modules/easy_http_amxx.dll
 *     addons/amxmodx/data/amxx_easy_http_cacert.pem
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler: explicit tags, braces on
 * every block, and no backslash escapes in strings (a backslash is written as the number 92).
 */

#include <amxmodx>
#include <amxmisc>
#include <easy_http>

#pragma dynamic 8192

#define PLUGIN  "H9 Presence"
#define VERSION "1.1"
#define AUTHOR  "2cwldys"

#define MAX_BODY        12288   // the largest report, in bytes (h9web takes up to 16384)
#define ROOM_PER_PLAYER 640     // the most one player's entry can take, escaped
#define REPORT_DELAY    3.0     // seconds after a join, a leave or a new name before the report
#define FIRST_DELAY     15.0    // seconds after the map starts before the first report
#define PROOF_WAIT      8       // seconds a challenged player is left out while its answer comes
#define RECHALLENGE     21600   // seconds before a player is challenged again (h9web takes a day)

#define TASK_TICK  59210
#define TASK_SOON  59211
#define TASK_ENROLL 59212

new g_cv_url, g_cv_server, g_cv_key, g_cv_interval, g_cv_challenge, g_cv_names, g_cv_enroll, g_cv_autoenroll;
// ts_matchmode's tsm_pres_* cvars, the Discord card's source (0 when ts_matchmode is not loaded)
new g_cv_mode, g_cv_siege, g_cv_attack, g_cv_prog;

new g_max;
new bool:g_in[MAX_PLAYERS + 1];          // a person put in the server (not a bot or HLTV)
new g_joined[MAX_PLAYERS + 1];           // unix time of client_putinserver
new g_nonce[MAX_PLAYERS + 1][33];        // the challenge this slot was given
new g_asked[MAX_PLAYERS + 1];            // when
new g_devmask[MAX_PLAYERS + 1][33];      // its answer to that challenge
new g_proof[MAX_PLAYERS + 1][65];
new g_gen[MAX_PLAYERS + 1];              // counts who held the slot, so a late answer finds the right player
new g_sent_gen[MAX_PLAYERS + 1];         // g_gen as the report in flight saw it

// Names (h9_presence_names): on this map a proven account plays under its havoc9.org username, and
// nobody else under a registered one. h9web says which, per slot, in its answer to a report.
new bool:g_names = false;
new g_forced[MAX_PLAYERS + 1][64];       // the name the slot plays under on this map, or ""
new bool:g_neutral[MAX_PLAYERS + 1];     // g_forced is a neutral name: its own was an account's
new g_told[MAX_PLAYERS + 1];             // when the slot was last told why (one line in 10 seconds)

new bool:g_ready = false;                // configured, and the self-test passed
new bool:g_selftest = false;
new bool:g_sending = false;              // a report in flight
new bool:g_again = false;                // something changed while it was in flight
new g_last_ts = 0;                       // the ts of the last report built
new g_last_count = -1;                   // players in the last accepted report (-1: none yet)
new g_last_status = 0;                   // the last outcome logged: 200, a status, or -1
new g_backoff_until = 0;
new g_sent_count = 0;
new g_accepted = 0;                      // reports accepted since the map started
new g_left_out = 0;                      // players left out of the last report for room

new g_body[MAX_BODY];                    // the report, one byte per cell
new g_len;
new g_ids[MAX_PLAYERS + 1][33];
new g_who[MAX_PLAYERS + 1];
new bool:g_hasid[MAX_PLAYERS + 1];
new g_scratch[300];

// The key and the address reports are signed for: a hand-made pair from h9_presence.cfg, or the
// pair this server enrolled with, kept with its server id and the enrollment's state in
// data/h9_presence.key across map changes and restarts.
new g_key[72], g_server[48], g_serverid[16], g_code[24];
new bool:g_manual = false;
#define ES_NONE     0    // no key: enroll
#define ES_PROOF    1    // a key, inactive: the code is in h9_presence_enroll until h9web has seen it
#define ES_APPROVAL 2    // proven; an H9 admin approves it first (a server not on servers.json)
#define ES_ACTIVE   3    // live: reports go out
new g_estate = ES_NONE;
new g_enext = 0;                         // when the next enrollment step may run (unix time)
new g_etries = 0;                        // steps in a row that failed or waited (the backoff)
new bool:g_ebusy = false;                // an enrollment request in flight
new g_bad = 0;                           // reports refused in a row because of the key
new bool:g_muted[MAX_PLAYERS + 1];       // h9web says this slot's account is muted here
new g_mute_told[MAX_PLAYERS + 1];
new g_signbuf[MAX_BODY];                 // what another plugin asks h9p_sign to sign
new const BACKOFF[] = { 10, 30, 60, 120, 300, 900, 1800, 3600, 21600 };

new const HEX[] = "0123456789abcdef";

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_url       = register_cvar("h9_presence_url", "https://havoc9.org/api/presence/report");
	g_cv_server    = register_cvar("h9_presence_server", "");
	// The key signs this server's reports. FCVAR_PROTECTED keeps its value out of cvar
	// listings and amx_cvar; the plugin never logs or prints it.
	g_cv_key       = register_cvar("h9_presence_key", "", FCVAR_PROTECTED);
	g_cv_interval  = register_cvar("h9_presence_interval", "60");
	g_cv_challenge = register_cvar("h9_presence_challenge", "0");
	g_cv_names     = register_cvar("h9_presence_names", "0");
	// The enrollment code: in the server's rules (FCVAR_SERVER) while h9web looks for it there.
	// FCVAR_UNLOGGED keeps each change out of the log and off every player's screen.
	g_cv_enroll     = register_cvar("h9_presence_enroll", "", FCVAR_SERVER | FCVAR_UNLOGGED);
	g_cv_autoenroll = register_cvar("h9_presence_autoenroll", "1");

	register_clcmd("h9_idproof", "cmd_idproof");
	register_clcmd("say", "hook_say");
	register_clcmd("say_team", "hook_say");
	register_srvcmd("h9_presence_status", "cmd_status");

	g_max = get_maxplayers();
	if (g_max > MAX_PLAYERS)
	{
		g_max = MAX_PLAYERS;
	}

	g_selftest = self_test();
	if (!g_selftest)
	{
		log_amx("[PRESENCE] The plugin's SHA-256 failed its self-test. Nothing will be reported. Tell whoever builds H9's plugins.");
	}
}

public plugin_cfg()
{
	// AMXX only execs amxx.cfg by itself; server_exec() runs the queued commands now, so the
	// cvars are set before anything reads them. h9_presence.cfg is optional: without one a
	// dedicated server enrolls by itself.
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_presence.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	g_cv_mode   = get_cvar_pointer("tsm_pres_mode");
	g_cv_siege  = get_cvar_pointer("tsm_pres_siege");
	g_cv_attack = get_cvar_pointer("tsm_pres_attack");
	g_cv_prog   = get_cvar_pointer("tsm_pres_prog");

	if (!g_selftest || !url_ok())
	{
		return;
	}

	// a hand-made key: both lines in h9_presence.cfg, as presence-key.js printed them
	new server[48], key[72];
	get_pcvar_string(g_cv_server, server, charsmax(server));
	get_pcvar_string(g_cv_key, key, charsmax(key));
	trim(server);
	trim(key);
	if (server[0] || key[0])
	{
		if (!address_ok(server) || strlen(key) != 64 || !hex_ok(key))
		{
			log_amx("[PRESENCE] h9_presence_server and h9_presence_key are set but not as presence-key.js printed them -- not reporting.");
			return;
		}
		copy(g_server, charsmax(g_server), server);
		copy(g_key, charsmax(g_key), key);
		g_manual = true;
		g_estate = ES_ACTIVE;
		go_live();
		return;
	}

	// A player's own listen server never enrolls. A dedicated one does, by itself and quietly: one
	// that h9web cannot reach (a LAN server) just stays unenrolled, asking again less and less often.
	if (!is_dedicated_server() || !get_pcvar_num(g_cv_autoenroll))
	{
		return;
	}
	load_state();
	if (g_estate == ES_ACTIVE)
	{
		set_pcvar_string(g_cv_enroll, "");
		go_live();
		return;
	}
	set_pcvar_string(g_cv_enroll, g_estate == ES_PROOF ? g_code : "");
	new wait = g_enext - get_systime();
	set_task(float(wait < 15 ? 15 : wait), "task_enroll", TASK_ENROLL);
}

/** Starts reporting with the live key. */
go_live()
{
	g_ready = true;

	if (get_pcvar_num(g_cv_names))
	{
		if (!get_pcvar_num(g_cv_challenge))
		{
			log_amx("[PRESENCE] h9_presence_names needs h9_presence_challenge 1: only a proven player is given a name. Names stay free.");
		}
		else
		{
			new map[64];
			get_mapname(map, charsmax(map));
			g_names = !names_free(map);
		}
	}

	new Float:every = get_pcvar_float(g_cv_interval);
	if (every < 30.0)
	{
		every = 30.0;
	}
	else if (every > 600.0)
	{
		every = 600.0;
	}
	remove_task(TASK_TICK);
	set_task(every, "task_tick", TASK_TICK, "", 0, "b");
	set_task(FIRST_DELAY, "task_soon", TASK_SOON);
}

/** Whether h9_presence_url can be used. */
bool:url_ok()
{
	new url[192];
	get_pcvar_string(g_cv_url, url, charsmax(url));
	trim(url);
	return equal(url, "https://", 8) || equal(url, "http://", 7);
}

/** a.b.c.d:port, digits only. */
bool:address_ok(const s[])
{
	new dots = 0, colon = 0, i;
	for (i = 0; s[i]; i++)
	{
		if (s[i] == '.')
		{
			dots++;
		}
		else if (s[i] == ':')
		{
			colon++;
		}
		else if (s[i] < '0' || s[i] > '9')
		{
			return false;
		}
	}
	return dots == 3 && colon == 1 && i >= 9 && i <= 21;
}

/** Lowercase hex only (lowercases A to F in place). */
bool:hex_ok(s[])
{
	for (new i = 0; s[i]; i++)
	{
		if (s[i] >= 'A' && s[i] <= 'F')
		{
			s[i] += 32;
		}
		if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
		{
			return false;
		}
	}
	return true;
}

// ---- players ------------------------------------------------------------------------------------

public client_putinserver(id)
{
	if (id < 1 || id > g_max || is_user_bot(id) || is_user_hltv(id))
	{
		return;
	}
	g_in[id] = true;
	g_gen[id]++;
	g_joined[id] = get_systime();
	forget_proof(id);
	challenge(id);
	soon();
}

public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id < 1 || id > g_max || !g_in[id])
	{
		return;
	}
	g_in[id] = false;
	g_gen[id]++;
	forget_proof(id);
	soon();
}

public client_infochanged(id)
{
	if (id < 1 || id > g_max || !g_in[id])
	{
		return;
	}
	// here get_user_name still has the old name and the userinfo the new one
	new was[64], now[64];
	get_user_name(id, was, charsmax(was));
	get_user_info(id, "name", now, charsmax(now));
	if (equal(was, now))
	{
		return;
	}
	// a name h9web gave the slot on this map: put back at once
	if (g_names && g_forced[id][0] && !equal(now, g_forced[id]))
	{
		set_user_info(id, "name", g_forced[id]);
		tell(id);
		return;
	}
	soon();
}

forget_proof(id)
{
	g_nonce[id][0] = 0;
	g_devmask[id][0] = 0;
	g_proof[id][0] = 0;
	g_asked[id] = 0;
	g_forced[id][0] = 0;
	g_neutral[id] = false;
	g_muted[id] = false;
}

// ---- the challenge ------------------------------------------------------------------------------

/**
 * Sends a one-time nonce to a client that says it can answer (_h9idv 1 in its userinfo). The
 * nonce is the unix time (8 hex) and 24 random hex characters; only an answer to this slot's own
 * nonce is taken (cmd_idproof).
 */
challenge(id)
{
	if (!g_ready || !get_pcvar_num(g_cv_challenge))
	{
		return;
	}
	new can[8];
	get_user_info(id, "_h9idv", can, charsmax(can));
	if (!equal(can, "1"))
	{
		return;
	}
	hex32(get_systime(), g_nonce[id], 0);
	hex32(random32(), g_nonce[id], 8);
	hex32(random32(), g_nonce[id], 16);
	hex32(random32(), g_nonce[id], 24);
	g_nonce[id][32] = 0;
	g_devmask[id][0] = 0;
	g_proof[id][0] = 0;
	g_asked[id] = get_systime();
	client_cmd(id, "h9_idchallenge %s", g_nonce[id]);
}

random32()
{
	return (random_num(0, 0xFFFF) << 16) | random_num(0, 0xFFFF);
}

/** Eight lowercase hex characters of value at out[pos]. */
hex32(value, out[], pos)
{
	for (new k = 7; k >= 0; k--)
	{
		out[pos + k] = HEX[value & 15];
		value = value >>> 4;
	}
}

/** The client's answer: h9_idproof <nonce> <devmask> <proof>, for this slot's own challenge only. */
public cmd_idproof(id, level, cid)
{
	if (id < 1 || id > g_max || !g_in[id] || !g_nonce[id][0] || g_proof[id][0])
	{
		return PLUGIN_HANDLED;
	}
	new nonce[40], devmask[40], proof[72];
	read_argv(1, nonce, charsmax(nonce));
	read_argv(2, devmask, charsmax(devmask));
	read_argv(3, proof, charsmax(proof));
	if (strlen(nonce) != 32 || strlen(devmask) != 32 || strlen(proof) != 64 || !hex_ok(nonce) || !hex_ok(devmask) || !hex_ok(proof))
	{
		return PLUGIN_HANDLED;
	}
	if (!equal(nonce, g_nonce[id]))
	{
		return PLUGIN_HANDLED;
	}
	copy(g_devmask[id], charsmax(g_devmask[]), devmask);
	copy(g_proof[id], charsmax(g_proof[]), proof);
	soon();
	return PLUGIN_HANDLED;
}

// ---- when to report -----------------------------------------------------------------------------

soon()
{
	if (!g_ready || task_exists(TASK_SOON))
	{
		return;
	}
	set_task(REPORT_DELAY, "task_soon", TASK_SOON);
}

public task_soon()
{
	send_report("event");
}

public task_tick()
{
	// a challenge answered long ago is asked again, before h9web's day runs out
	new now = get_systime();
	for (new id = 1; id <= g_max; id++)
	{
		if (g_in[id] && g_asked[id] && now - g_asked[id] > RECHALLENGE)
		{
			challenge(id);
		}
	}
	// an empty server that h9web already knows is empty is not reported again
	if (count_players() > 0 || g_last_count != 0)
	{
		send_report("tick");
	}
}

count_players()
{
	new n = 0, cid[40];
	for (new id = 1; id <= g_max; id++)
	{
		if (g_in[id] && is_user_connected(id) && get_user_info(id, "h9_clientid", cid, charsmax(cid)) && cid[0])
		{
			n++;
		}
	}
	return n;
}

// ---- the report ---------------------------------------------------------------------------------

send_report(const reason[])
{
	if (!g_ready)
	{
		return;
	}
	if (g_sending)
	{
		g_again = true;
		return;
	}
	if (g_backoff_until && get_systime() < g_backoff_until)
	{
		return;
	}
	if (!g_key[0] || !url_ok())
	{
		return;
	}
	new url[200];
	api_url(url, charsmax(url), "/report");

	new count = build_report(reason, g_server);
	new sig[65];
	hmac_sha256(g_key, strlen(g_key), g_body, g_len, sig, charsmax(sig));

	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", g_server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_presence/1.1");
	ezhttp_option_set_timeout(opt, 8000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, g_body);

	g_sending = true;
	g_sent_count = count;
	ezhttp_post(url, "on_report_done", opt);
}

public on_report_done(EzHttpRequest:request_id)
{
	g_sending = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		new err[128];
		ezhttp_get_error_message(request_id, err, charsmax(err));
		note_result(-1, err);
	}
	else
	{
		new status = ezhttp_get_http_code(request_id);
		if (status == 200)
		{
			g_last_count = g_sent_count;
			g_accepted++;
			g_bad = 0;
			note_result(200, "");
			new EzJSON:root = ezhttp_parse_json_response(request_id);
			if (root != EzInvalid_JSON)
			{
				apply_actions(root);
				if (g_names)
				{
					apply_names(root);
				}
				ezjson_free(root);
			}
		}
		else
		{
			// h9web's answer is { "error": code, "message": text }: no secret in it
			new answer[200];
			ezhttp_get_data(request_id, answer, charsmax(answer));
			note_result(status, answer);
			if (status == 429 || status == 503)
			{
				g_backoff_until = get_systime() + 60;
			}
			if (!g_manual && (status == 401 || status == 403))
			{
				key_refused(answer);
			}
		}
	}
	if (g_again)
	{
		g_again = false;
		soon();
	}
}

/** Logs an outcome when it differs from the last one, so a lasting problem is one line, not one a minute. */
note_result(status, const text[])
{
	if (status == g_last_status)
	{
		return;
	}
	g_last_status = status;
	if (status == 200)
	{
		log_amx("[PRESENCE] h9web accepts this server's reports.");
	}
	else if (status == -1)
	{
		log_amx("[PRESENCE] Could not reach h9web: %s", text);
	}
	else
	{
		log_amx("[PRESENCE] h9web refused the report: HTTP %d %s", status, text);
	}
}

/**
 * Builds the report into g_body and returns how many players are in it. A player whose
 * h9_clientid appears twice is left out both times (h9web would drop both anyway), and a player
 * challenged a moment ago is left out until the answer comes or PROOF_WAIT runs out.
 */
build_report(const reason[], const server[])
{
	new map[64], key[32], siege[16], attack[8], prog[32], mode[48], detail[128];
	get_mapname(map, charsmax(map));
	pres(g_cv_mode, key, charsmax(key));
	pres(g_cv_siege, siege, charsmax(siege));
	pres(g_cv_attack, attack, charsmax(attack));
	pres(g_cv_prog, prog, charsmax(prog));
	mode_name(map, key, siege, mode, charsmax(mode));
	detail_line(mode, key, siege, attack, prog, detail, charsmax(detail));

	// a report's ts must be later than the last one h9web took from this server
	new ts = get_systime();
	if (ts <= g_last_ts)
	{
		ts = g_last_ts + 1;
	}
	g_last_ts = ts;

	g_len = 0;
	g_body[0] = 0;
	app_raw("{^"v^":1,^"server^":");
	app_str(server);
	app_raw(",^"ts^":");
	app_num(ts);
	app_raw(",^"reason^":");
	app_str(reason);
	app_raw(",^"map^":");
	app_str(map);
	app_raw(",^"mode^":");
	app_str(mode);
	if (!equal(detail, mode))
	{
		app_raw(",^"detail^":");
		app_str(detail);
	}
	new host[64], list[32], humans;
	get_cvar_string("hostname", host, charsmax(host));
	get_players(list, humans, "ch");
	app_raw(",^"name^":");
	app_str(host);
	app_raw(",^"humans^":");
	app_num(humans);
	app_raw(",^"max^":");
	app_num(g_max);
	if (g_names)
	{
		app_raw(",^"names^":true");
	}
	app_raw(",^"players^":[");

	new n = 0, now = get_systime();
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || !is_user_connected(id) || is_user_bot(id) || is_user_hltv(id))
		{
			continue;
		}
		if (g_nonce[id][0] && !g_proof[id][0] && now - g_asked[id] < PROOF_WAIT)
		{
			continue;
		}
		get_user_info(id, "h9_clientid", g_ids[n], charsmax(g_ids[]));
		g_hasid[n] = strlen(g_ids[n]) == 32 && hex_ok(g_ids[n]);
		if (!g_hasid[n] && !g_names)
		{
			continue;
		}
		g_who[n] = id;
		g_sent_gen[id] = g_gen[id];
		n++;
	}

	// with names on, a player without a usable h9_clientid goes in by slot and name alone, for
	// h9web's check that the name is not an account's
	new sent = 0;
	g_left_out = 0;
	for (new i = 0; i < n; i++)
	{
		new bool:full = g_hasid[i] && !listed_twice(i, n);
		if (!full && !g_names)
		{
			continue;
		}
		if (g_len > MAX_BODY - ROOM_PER_PLAYER)
		{
			g_left_out++;
			continue;
		}
		if (sent)
		{
			app_byte(',');
		}
		if (full)
		{
			app_player(g_who[i], g_ids[i]);
		}
		else
		{
			app_name_only(g_who[i]);
		}
		sent++;
	}
	app_raw("]}");
	if (g_left_out)
	{
		log_amx("[PRESENCE] The report was full: %d player(s) left out of it.", g_left_out);
	}
	return sent;
}

bool:listed_twice(i, n)
{
	for (new j = 0; j < n; j++)
	{
		if (j != i && g_hasid[j] && equal(g_ids[i], g_ids[j]))
		{
			return true;
		}
	}
	return false;
}

app_player(id, const cid[])
{
	new name[64], net[48];
	get_user_name(id, name, charsmax(name));
	app_raw("{^"id^":");
	app_str(cid);
	app_raw(",^"slot^":");
	app_num(id);
	app_raw(",^"name^":");
	app_str(name);
	app_raw(",^"joined^":");
	app_num(g_joined[id]);
	app_raw(",^"time^":");
	app_num(get_user_time(id, 1));
	if (g_proof[id][0])
	{
		app_raw(",^"nonce^":");
		app_str(g_nonce[id]);
		app_raw(",^"devmask^":");
		app_str(g_devmask[id]);
		app_raw(",^"proof^":");
		app_str(g_proof[id]);
		if (coarse_net(id, net, charsmax(net)))
		{
			app_raw(",^"net^":");
			app_str(net);
		}
	}
	app_byte('}');
}

app_name_only(id)
{
	new name[64];
	get_user_name(id, name, charsmax(name));
	app_raw("{^"slot^":");
	app_num(id);
	app_raw(",^"name^":");
	app_str(name);
	app_byte('}');
}

/**
 * The player's network, coarse: an IPv4 address cut to its /24 ("203.0.113"), an IPv6 one to its
 * first three groups (/48). Only sent with a proof; h9web keeps nothing but a keyed hash of it.
 */
bool:coarse_net(id, out[], len)
{
	new ip[64];
	get_user_ip(id, ip, charsmax(ip), 1);
	new cut = 0, seen = 0, i;
	new bool:v6 = contain(ip, ":") >= 0;
	for (i = 0; ip[i] && i < len; i++)
	{
		if (ip[i] == (v6 ? ':' : '.'))
		{
			seen++;
			if (seen == 3)
			{
				break;
			}
		}
		if (!((ip[i] >= '0' && ip[i] <= '9') || (ip[i] >= 'a' && ip[i] <= 'f') || (ip[i] >= 'A' && ip[i] <= 'F') || ip[i] == '.' || ip[i] == ':'))
		{
			return false;
		}
		out[cut++] = ip[i];
	}
	out[cut] = 0;
	return seen == 3 && cut > 0;
}

// ---- enrollment ---------------------------------------------------------------------------------

/** h9_presence_url without its /report, and path after it. */
api_url(out[], len, const path[])
{
	new url[192];
	get_pcvar_string(g_cv_url, url, charsmax(url));
	trim(url);
	new n = strlen(url);
	if (n > 7 && equal(url[n - 7], "/report"))
	{
		url[n - 7] = 0;
	}
	formatex(out, len, "%s%s", url, path);
}

state_path(out[], len)
{
	new dir[64];
	get_datadir(dir, charsmax(dir));
	formatex(out, len, "%s/h9_presence.key", dir);
}

load_state()
{
	new path[128], line[192], name[16], value[160];
	state_path(path, charsmax(path));
	new f = fopen(path, "rt");
	if (!f)
	{
		return;
	}
	while (!feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		if (!line[0] || line[0] == '/')
		{
			continue;
		}
		split(line, name, charsmax(name), value, charsmax(value), "=");
		trim(name);
		trim(value);
		if (equal(name, "address"))
		{
			copy(g_server, charsmax(g_server), value);
		}
		else if (equal(name, "key"))
		{
			copy(g_key, charsmax(g_key), value);
		}
		else if (equal(name, "code"))
		{
			copy(g_code, charsmax(g_code), value);
		}
		else if (equal(name, "serverid"))
		{
			copy(g_serverid, charsmax(g_serverid), value);
		}
		else if (equal(name, "state"))
		{
			g_estate = str_to_num(value);
		}
		else if (equal(name, "next"))
		{
			g_enext = str_to_num(value);
		}
		else if (equal(name, "tries"))
		{
			g_etries = str_to_num(value);
		}
	}
	fclose(f);
	if (!address_ok(g_server) || strlen(g_key) != 64 || !hex_ok(g_key) || g_estate < ES_NONE || g_estate > ES_ACTIVE)
	{
		g_key[0] = 0;
		g_code[0] = 0;
		g_estate = ES_NONE;
	}
}

save_state()
{
	new path[128];
	state_path(path, charsmax(path));
	new f = fopen(path, "wt");
	if (!f)
	{
		return;
	}
	fputs(f, "// h9_presence: this server's enrollment with havoc9.org (docs/H9_PRESENCE.txt).^n");
	fputs(f, "// THE KEY IS A SECRET: whoever has it can report players onto this server. Never share or commit^n");
	fputs(f, "// this file; client packages leave *.key files out. Delete it to make the server enroll again.^n");
	fprintf(f, "address=%s^nkey=%s^ncode=%s^nserverid=%s^n", g_server, g_key, g_code, g_serverid);
	fprintf(f, "state=%d^nnext=%d^ntries=%d^n", g_estate, g_enext, g_etries);
	fclose(f);
}

forget_key()
{
	g_key[0] = 0;
	g_code[0] = 0;
	g_estate = ES_NONE;
	set_pcvar_string(g_cv_enroll, "");
}

schedule_enroll(seconds)
{
	g_enext = get_systime() + seconds;
	save_state();
	remove_task(TASK_ENROLL);
	set_task(float(seconds), "task_enroll", TASK_ENROLL);
}

/** The next enrollment step after a failure or a wait: further off each time, 10 seconds to 6 hours. */
wait_more()
{
	new i = g_etries < sizeof(BACKOFF) ? g_etries : sizeof(BACKOFF) - 1;
	g_etries++;
	schedule_enroll(BACKOFF[i]);
}

public task_enroll()
{
	if (g_ebusy || g_estate == ES_ACTIVE)
	{
		return;
	}
	if (g_estate == ES_NONE || !g_key[0])
	{
		send_enroll();
	}
	else
	{
		send_enroll_status();
	}
}

/** Asks h9web for a key for this server's own address (the caller's IP and this port). */
send_enroll()
{
	new port = get_cvar_num("hostport");
	if (port <= 0)
	{
		port = get_cvar_num("port");
	}
	if (port <= 0)
	{
		port = 27015;
	}
	new url[200], body[48];
	api_url(url, charsmax(url), "/enroll");
	formatex(body, charsmax(body), "{^"v^":1,^"port^":%d}", port);
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_user_agent(opt, "h9_presence/1.1");
	ezhttp_option_set_timeout(opt, 8000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, body);
	g_ebusy = true;
	ezhttp_post(url, "on_enroll", opt);
}

public on_enroll(EzHttpRequest:request_id)
{
	g_ebusy = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK || ezhttp_get_http_code(request_id) != 200)
	{
		wait_more();
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		wait_more();
		return;
	}
	new key[72], code[24], server[48], sid[16];
	if (ezjson_object_has_value(root, "key", EzJSONString))
	{
		ezjson_object_get_string(root, "key", key, charsmax(key));
	}
	if (ezjson_object_has_value(root, "code", EzJSONString))
	{
		ezjson_object_get_string(root, "code", code, charsmax(code));
	}
	if (ezjson_object_has_value(root, "server", EzJSONString))
	{
		ezjson_object_get_string(root, "server", server, charsmax(server));
	}
	if (ezjson_object_has_value(root, "serverId", EzJSONString))
	{
		ezjson_object_get_string(root, "serverId", sid, charsmax(sid));
	}
	ezjson_free(root);
	if (strlen(key) != 64 || !hex_ok(key) || !address_ok(server) || strlen(code) < 8)
	{
		wait_more();
		return;
	}
	copy(g_key, charsmax(g_key), key);
	copy(g_code, charsmax(g_code), code);
	copy(g_server, charsmax(g_server), server);
	copy(g_serverid, charsmax(g_serverid), sid);
	g_estate = ES_PROOF;
	g_etries = 0;
	set_pcvar_string(g_cv_enroll, g_code);
	schedule_enroll(5);
}

/** Asks whether h9web has seen the code (and checks again when it is time). */
send_enroll_status()
{
	new url[200], body[192], sig[65], nonce[17];
	api_url(url, charsmax(url), "/enroll/status");
	make_nonce(nonce);
	formatex(body, charsmax(body), "{^"v^":1,^"server^":^"%s^",^"ts^":%d,^"nonce^":^"%s^"}", g_server, get_systime(), nonce);
	hmac_sha256(g_key, strlen(g_key), body, strlen(body), sig, charsmax(sig));
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", g_server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_presence/1.1");
	ezhttp_option_set_timeout(opt, 12000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, body);
	g_ebusy = true;
	ezhttp_post(url, "on_enroll_status", opt);
}

public on_enroll_status(EzHttpRequest:request_id)
{
	g_ebusy = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		wait_more();
		return;
	}
	new code = ezhttp_get_http_code(request_id);
	if (code == 401 || code == 403)
	{
		// the enrollment is gone (unproven for an hour, or revoked): start again, later
		forget_key();
		wait_more();
		return;
	}
	if (code != 200)
	{
		wait_more();
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		wait_more();
		return;
	}
	new status[24], sid[16];
	if (ezjson_object_has_value(root, "status", EzJSONString))
	{
		ezjson_object_get_string(root, "status", status, charsmax(status));
	}
	if (ezjson_object_has_value(root, "serverId", EzJSONString))
	{
		ezjson_object_get_string(root, "serverId", sid, charsmax(sid));
		if (sid[0])
		{
			copy(g_serverid, charsmax(g_serverid), sid);
		}
	}
	ezjson_free(root);
	if (equal(status, "active"))
	{
		g_estate = ES_ACTIVE;
		g_etries = 0;
		g_code[0] = 0;
		set_pcvar_string(g_cv_enroll, "");
		save_state();
		log_amx("[PRESENCE] Enrolled with havoc9.org as server %s; reporting.", g_serverid);
		if (!g_ready)
		{
			go_live();
		}
	}
	else if (equal(status, "pending_approval"))
	{
		if (g_estate != ES_APPROVAL)
		{
			log_amx("[PRESENCE] Enrolled with havoc9.org as server %s; an H9 admin approves it before it reports.", g_serverid);
		}
		g_estate = ES_APPROVAL;
		g_etries = 0;
		g_code[0] = 0;
		set_pcvar_string(g_cv_enroll, "");
		schedule_enroll(600);
	}
	else if (equal(status, "blocked"))
	{
		forget_key();
		g_etries = sizeof(BACKOFF) - 1;
		wait_more();
	}
	else
	{
		// not seen yet: a LAN or firewalled server stays here, quietly, asking less and less often
		wait_more();
	}
}

/** Three refused reports in a row with an enrolled key: waiting for approval again, or the key is gone. */
key_refused(const answer[])
{
	if (++g_bad < 3)
	{
		return;
	}
	g_bad = 0;
	g_ready = false;
	remove_task(TASK_TICK);
	g_etries = 0;
	if (contain(answer, "pending_approval") >= 0)
	{
		g_estate = ES_APPROVAL;
		schedule_enroll(600);
	}
	else
	{
		forget_key();
		schedule_enroll(30);
	}
}

make_nonce(out[17])
{
	hex32(random32(), out, 0);
	hex32(random32(), out, 8);
	out[16] = 0;
}

// ---- what h9web says to do with each player ----------------------------------------------------

/** The answer's actions: kick a banned account or a one-off kick, and who is muted. */
apply_actions(EzJSON:root)
{
	new key[32], reason[72];
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		formatex(key, charsmax(key), "actions.%d.kick", id);
		if (ezjson_object_has_value(root, key, EzJSONString, true))
		{
			ezjson_object_get_string(root, key, reason, charsmax(reason), true);
			clean_reason(reason);
			server_cmd("kick #%d ^"%s^"", get_user_userid(id), reason);
			continue;
		}
		formatex(key, charsmax(key), "actions.%d.mute", id);
		g_muted[id] = ezjson_object_has_value(root, key, EzJSONBoolean, true) && ezjson_object_get_bool(root, key, true);
	}
}

/** A reason as it may go into a server command: letters, digits, space and . , : ! ? ( ) - only. */
clean_reason(s[])
{
	new j = 0;
	for (new i = 0; s[i]; i++)
	{
		new c = s[i];
		if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == ' ' || c == '.' || c == ',' || c == ':' || c == '!' || c == '?' || c == '(' || c == ')' || c == '-')
		{
			s[j] = c;
			j++;
		}
	}
	s[j] = 0;
	if (!s[0])
	{
		copy(s, 8, "Removed");
	}
}

/** A muted account's chat goes nowhere, here or to the community. */
public hook_say(id)
{
	if (id < 1 || id > g_max || !g_muted[id])
	{
		return PLUGIN_CONTINUE;
	}
	new now = get_systime();
	if (now - g_mute_told[id] >= 5)
	{
		g_mute_told[id] = now;
		client_print(id, print_chat, "[H9] You are muted on this server's community.");
	}
	return PLUGIN_HANDLED;
}

// ---- natives for h9_community.sma (and any plugin): include/h9_community.inc ---------------------

public plugin_natives()
{
	register_library("h9_presence");
	register_native("h9p_ready", "nat_ready");
	register_native("h9p_server", "nat_server");
	register_native("h9p_server_id", "nat_server_id");
	register_native("h9p_api", "nat_api");
	register_native("h9p_sign", "nat_sign");
	register_native("h9p_nonce", "nat_nonce");
	register_native("h9p_report_soon", "nat_report_soon");
	register_native("h9p_muted", "nat_muted");
}

public nat_ready(plugin, params)
{
	return g_ready && g_key[0] && g_estate == ES_ACTIVE;
}

public nat_server(plugin, params)
{
	set_string(1, g_server, get_param(2));
	return g_server[0] != 0;
}

public nat_server_id(plugin, params)
{
	set_string(1, g_serverid, get_param(2));
	return g_serverid[0] != 0;
}

public nat_api(plugin, params)
{
	new url[200];
	api_url(url, charsmax(url), "");
	set_string(1, url, get_param(2));
	return 1;
}

/** h9p_sign(const body[], out[], len): the live key's HMAC-SHA256 of body, as 64 hex. */
public nat_sign(plugin, params)
{
	if (!g_key[0] || g_estate != ES_ACTIVE)
	{
		return 0;
	}
	get_string(1, g_signbuf, charsmax(g_signbuf));
	new sig[65];
	hmac_sha256(g_key, strlen(g_key), g_signbuf, strlen(g_signbuf), sig, charsmax(sig));
	set_string(2, sig, get_param(3));
	return 1;
}

public nat_nonce(plugin, params)
{
	new n[17];
	make_nonce(n);
	set_string(1, n, get_param(2));
	return 1;
}

public nat_report_soon(plugin, params)
{
	soon();
	return 1;
}

public nat_muted(plugin, params)
{
	new id = get_param(1);
	return id >= 1 && id <= g_max && g_muted[id];
}

// ---- names ------------------------------------------------------------------------------------

/**
 * h9web's answer to a report that asked for names: per slot, "set" (a proven account: play under
 * its username, the current one, so a rename on the site follows) or "taken" (someone else using
 * an account's name, look-alikes included: a neutral name instead). Only for a slot still held by
 * the player the report was about.
 */
apply_names(EzJSON:root)
{
	new key[32], name[64];
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		formatex(key, charsmax(key), "names.%d.set", id);
		if (ezjson_object_has_value(root, key, EzJSONString, true))
		{
			ezjson_object_get_string(root, key, name, charsmax(name), true);
			if (name[0])
			{
				force_name(id, name, false);
			}
			continue;
		}
		formatex(key, charsmax(key), "names.%d.taken", id);
		if (ezjson_object_has_value(root, key, EzJSONBoolean, true) && !g_neutral[id])
		{
			// "Player 1234": a space, which no username can hold, so it is never an account's
			formatex(name, charsmax(name), "Player %d", random_num(1000, 9999));
			force_name(id, name, true);
		}
	}
}

force_name(id, const name[], bool:neutral)
{
	copy(g_forced[id], charsmax(g_forced[]), name);
	g_neutral[id] = neutral;
	new was[64];
	get_user_name(id, was, charsmax(was));
	if (equal(was, name))
	{
		return;
	}
	set_user_info(id, "name", name);
	tell(id);
}

/** One short line on why the name changed, at most every 10 seconds per player. */
tell(id)
{
	new now = get_systime();
	if (now - g_told[id] < 10)
	{
		return;
	}
	g_told[id] = now;
	if (g_neutral[id])
	{
		client_print(id, print_chat, "[H9] That name belongs to a havoc9.org account. On H9 maps you play as %s.", g_forced[id]);
	}
	else
	{
		client_print(id, print_chat, "[H9] On H9 maps you play under your havoc9.org name, %s.", g_forced[id]);
	}
}

/// A roleplay map by its name: rp_ or tsrp_ at the start, or _rp_ or _tsrp_ anywhere in it.
/// Copied exactly from roleplay_map() in ts_matchmode.sma; keep the two the same.
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

/** Names are free on roleplay maps and on stock TS maps (ts_), and fixed on every other map. */
bool:names_free(const map[])
{
	return roleplay_map(map) || equali(map, "ts_", 3);
}

// ---- the mode, as the Discord card names it -----------------------------------------------------

pres(pcvar, out[], len)
{
	out[0] = 0;
	if (pcvar)
	{
		get_pcvar_string(pcvar, out, len);
		trim(out);
	}
}

/**
 * H9P_Mode in engine/client/cl_presence.c, in Pawn: the server's own word first (tsm_pres_siege,
 * tsm_pres_mode), then the map's name (h9_<mode>_ prefixes, then rp_ / tsrp_ for Roleplay), then
 * "match" for Match Mode, else Deathmatch.
 */
mode_name(const map[], const key[], const siege[], out[], len)
{
	if (siege[0] || equali(key, "siege"))
	{
		copy(out, len, "Siege");
		return;
	}
	if (equali(key, "uplink"))
	{
		copy(out, len, "Capture the Uplink");
		return;
	}
	if (equali(key, "survival"))
	{
		copy(out, len, "Wave Survival");
		return;
	}
	if (equali(key, "mechwarrior"))
	{
		copy(out, len, "Mech Warrior");
		return;
	}
	new name[64];
	copy(name, charsmax(name), map);
	strtolower(name);
	if (equal(name, "h9_te_", 6))
	{
		copy(out, len, "Team Elimination");
	}
	else if (equal(name, "h9_siege_", 9))
	{
		copy(out, len, "Siege");
	}
	else if (equal(name, "h9_up_", 6))
	{
		copy(out, len, "Capture the Uplink");
	}
	else if (equal(name, "h9_mw_", 6))
	{
		copy(out, len, "Mech Warrior");
	}
	else if (equal(name, "h9_ws_", 6))
	{
		copy(out, len, "Wave Survival");
	}
	else if (equal(name, "h9_dm_", 6))
	{
		copy(out, len, "Deathmatch");
	}
	else if (equal(name, "h9_tdm_", 7))
	{
		copy(out, len, "Team Deathmatch");
	}
	else if (equal(name, "h9_ctb_", 7))
	{
		copy(out, len, "Capture the Briefcase");
	}
	else if (equal(name, "h9_ctf_", 7))
	{
		copy(out, len, "Capture the Flag");
	}
	else if (equal(name, "rp_", 3) || equal(name, "tsrp_", 5) || contain(name, "_rp_") >= 0 || contain(name, "_tsrp_") >= 0)
	{
		copy(out, len, "Roleplay");
	}
	else if (equali(key, "match"))
	{
		copy(out, len, "Match Mode");
	}
	else
	{
		copy(out, len, "Deathmatch");
	}
}

/**
 * The card's details line (H9P_Activity): the siege's attacking side and objectives, the
 * uplink's zones, the survival wave, or the mode alone.
 */
detail_line(const mode[], const key[], const siege[], const attack[], const prog[], out[], len)
{
	new side[16];
	side[0] = 0;
	if (attack[0] == '1')
	{
		copy(side, charsmax(side), "MSR");
	}
	else if (attack[0] == '2')
	{
		copy(side, charsmax(side), "Insurgents");
	}

	if (siege[0] && side[0])
	{
		new slash = contain(siege, "/");
		formatex(out, len, "%s - %s attacking: %d of %d objectives", mode, side, str_to_num(siege), slash >= 0 ? str_to_num(siege[slash + 1]) : 0);
	}
	else if (siege[0])
	{
		formatex(out, len, "%s %s", mode, siege);
	}
	else if (equali(key, "uplink") && prog[0])
	{
		new held[3], at = 0, cut;
		for (new i = 0; i < 3; i++)
		{
			held[i] = str_to_num(prog[at]);
			cut = contain(prog[at], "/");
			if (cut < 0)
			{
				break;
			}
			at += cut + 1;
		}
		formatex(out, len, "%s - zones: MSR %d, Insurgents %d of %d", mode, held[0], held[1], held[2]);
	}
	else if (equali(key, "survival") && prog[0])
	{
		formatex(out, len, "%s - wave %d", mode, str_to_num(prog));
	}
	else
	{
		copy(out, len, mode);
	}
}

// ---- the JSON body ------------------------------------------------------------------------------

app_byte(b)
{
	if (g_len >= MAX_BODY - 1)
	{
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

/** A JSON string: quoted, with " and the backslash escaped and control characters as u00XX. */
app_str(const s[])
{
	app_byte(34);
	for (new i = 0; s[i]; i++)
	{
		new c = s[i] & 0xFF;
		if (c == 0)
		{
			continue;
		}
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

// ---- SHA-256 and HMAC-SHA256 (FIPS 180-4, RFC 2104) ---------------------------------------------

new const g_k[64] =
{
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

new g_h[8];
new g_w[64];
new g_block[64];
new g_blen;
new g_total;
new g_digest[32];
new g_kpad[64];
new g_inner[32];

rotr(x, n)
{
	return (x >>> n) | (x << (32 - n));
}

sha_init()
{
	g_h[0] = 0x6a09e667;
	g_h[1] = 0xbb67ae85;
	g_h[2] = 0x3c6ef372;
	g_h[3] = 0xa54ff53a;
	g_h[4] = 0x510e527f;
	g_h[5] = 0x9b05688c;
	g_h[6] = 0x1f83d9ab;
	g_h[7] = 0x5be0cd19;
	g_blen = 0;
	g_total = 0;
}

sha_block()
{
	new i, s0, s1, t1, t2, a, b, c, d, e, f, g, h;
	for (i = 0; i < 16; i++)
	{
		g_w[i] = (g_block[i * 4] << 24) | (g_block[i * 4 + 1] << 16) | (g_block[i * 4 + 2] << 8) | g_block[i * 4 + 3];
	}
	for (i = 16; i < 64; i++)
	{
		s0 = rotr(g_w[i - 15], 7) ^ rotr(g_w[i - 15], 18) ^ (g_w[i - 15] >>> 3);
		s1 = rotr(g_w[i - 2], 17) ^ rotr(g_w[i - 2], 19) ^ (g_w[i - 2] >>> 10);
		g_w[i] = g_w[i - 16] + s0 + g_w[i - 7] + s1;
	}
	a = g_h[0];
	b = g_h[1];
	c = g_h[2];
	d = g_h[3];
	e = g_h[4];
	f = g_h[5];
	g = g_h[6];
	h = g_h[7];
	for (i = 0; i < 64; i++)
	{
		s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
		t1 = h + s1 + ((e & f) ^ (~e & g)) + g_k[i] + g_w[i];
		s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
		t2 = s0 + ((a & b) ^ (a & c) ^ (b & c));
		h = g;
		g = f;
		f = e;
		e = d + t1;
		d = c;
		c = b;
		b = a;
		a = t1 + t2;
	}
	g_h[0] += a;
	g_h[1] += b;
	g_h[2] += c;
	g_h[3] += d;
	g_h[4] += e;
	g_h[5] += f;
	g_h[6] += g;
	g_h[7] += h;
}

sha_byte(value)
{
	g_block[g_blen] = value & 0xFF;
	g_blen++;
	g_total++;
	if (g_blen == 64)
	{
		sha_block();
		g_blen = 0;
	}
}

sha_final()
{
	// the length in bits, as two 32-bit halves, taken before the padding is added
	new hi = g_total >>> 29;
	new lo = g_total << 3;
	sha_byte(0x80);
	while (g_blen != 56)
	{
		sha_byte(0);
	}
	sha_byte(hi >>> 24);
	sha_byte(hi >>> 16);
	sha_byte(hi >>> 8);
	sha_byte(hi);
	sha_byte(lo >>> 24);
	sha_byte(lo >>> 16);
	sha_byte(lo >>> 8);
	sha_byte(lo);
	for (new i = 0; i < 8; i++)
	{
		g_digest[i * 4] = (g_h[i] >>> 24) & 0xFF;
		g_digest[i * 4 + 1] = (g_h[i] >>> 16) & 0xFF;
		g_digest[i * 4 + 2] = (g_h[i] >>> 8) & 0xFF;
		g_digest[i * 4 + 3] = g_h[i] & 0xFF;
	}
}

to_hex(const bytes[], n, out[], len)
{
	new j = 0;
	for (new i = 0; i < n && j + 2 <= len; i++)
	{
		out[j] = HEX[(bytes[i] >> 4) & 15];
		out[j + 1] = HEX[bytes[i] & 15];
		j += 2;
	}
	out[j] = 0;
}

sha256_text(const text[], out[], len)
{
	sha_init();
	for (new i = 0; text[i]; i++)
	{
		sha_byte(text[i]);
	}
	sha_final();
	to_hex(g_digest, 32, out, len);
}

/** HMAC-SHA256(key, msg) as lowercase hex in out (len 64 or more). */
hmac_sha256(const key[], keylen, const msg[], msglen, out[], len)
{
	new i;
	for (i = 0; i < 64; i++)
	{
		g_kpad[i] = 0;
	}
	if (keylen > 64)
	{
		sha_init();
		for (i = 0; i < keylen; i++)
		{
			sha_byte(key[i]);
		}
		sha_final();
		for (i = 0; i < 32; i++)
		{
			g_kpad[i] = g_digest[i];
		}
	}
	else
	{
		for (i = 0; i < keylen; i++)
		{
			g_kpad[i] = key[i] & 0xFF;
		}
	}
	sha_init();
	for (i = 0; i < 64; i++)
	{
		sha_byte(g_kpad[i] ^ 0x36);
	}
	for (i = 0; i < msglen; i++)
	{
		sha_byte(msg[i]);
	}
	sha_final();
	for (i = 0; i < 32; i++)
	{
		g_inner[i] = g_digest[i];
	}
	sha_init();
	for (i = 0; i < 64; i++)
	{
		sha_byte(g_kpad[i] ^ 0x5C);
	}
	for (i = 0; i < 32; i++)
	{
		sha_byte(g_inner[i]);
	}
	sha_final();
	to_hex(g_digest, 32, out, len);
}

/** The FIPS 180-4 and RFC 4231 vectors, and a long text against AMXX's own SHA-256. */
bool:self_test()
{
	new out[65], ref[65];
	sha256_text("abc", out, charsmax(out));
	if (!equal(out, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
	{
		return false;
	}
	sha256_text("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", out, charsmax(out));
	if (!equal(out, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"))
	{
		return false;
	}
	hmac_sha256("Jefe", 4, "what do ya want for nothing?", 28, out, charsmax(out));
	if (!equal(out, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"))
	{
		return false;
	}
	for (new i = 0; i < charsmax(g_scratch); i++)
	{
		g_scratch[i] = 'a' + (i * 7) % 26;
	}
	g_scratch[charsmax(g_scratch)] = 0;
	sha256_text(g_scratch, out, charsmax(out));
	hash_string(g_scratch, Hash_Sha256, ref, charsmax(ref));
	strtolower(ref);
	return bool:equal(out, ref);
}

// ---- the server console -------------------------------------------------------------------------

public cmd_status()
{
	server_print("[PRESENCE] %s %s", PLUGIN, VERSION);
	server_print("  self-test: %s", g_selftest ? "passed" : "FAILED (nothing is reported)");
	server_print("  config: %s (server ^"%s^", key %s)", g_ready ? "reporting" : "not reporting", g_server, g_key[0] ? "set" : "not set");
	new const STATES[][] = { "not enrolled", "enrolled, waiting for h9web to see the code", "enrolled, waiting for an H9 admin", "live" };
	server_print("  enrollment: %s%s; server id %s", g_manual ? "a hand-made key" : STATES[g_estate], is_dedicated_server() ? "" : " (a listen server never enrolls)", g_serverid[0] ? g_serverid : "none yet");
	server_print("  challenge: %s; names: %s", get_pcvar_num(g_cv_challenge) ? "on" : "off", g_names ? "fixed on this map" : "free on this map");
	new ids = 0, proven = 0;
	for (new id = 1; id <= g_max; id++)
	{
		if (g_in[id])
		{
			ids++;
			if (g_proof[id][0])
			{
				proven++;
			}
		}
	}
	server_print("  players in game: %d (with a proof: %d); in the last accepted report: %d", ids, proven, g_last_count < 0 ? 0 : g_last_count);
	server_print("  reports accepted this map: %d; last outcome: %d", g_accepted, g_last_status);
	return PLUGIN_HANDLED;
}
