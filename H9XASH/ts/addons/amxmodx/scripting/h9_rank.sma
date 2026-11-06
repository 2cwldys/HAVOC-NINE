/*
 * h9_rank.sma -- .rank: a player's havoc9.org rank in game, their own or anyone's.
 *
 *   .rank          your own: your level, your rating and place on the H9 ladder and on this
 *                  server's table, this season's matches, wins and losses, kills, deaths and K/D
 *   .rank <name>   someone else's: the player on this server whose name is <name>, or has it in
 *                  it; with nobody here by that name, the havoc9.org account named <name>
 *   /rank, !rank, /elo, !elo   the same as .rank (they were h9_compete's say /rank)
 *
 * Every answer goes to the player who asked, and to nobody else: one chat line, and the whole
 * readout in their console. What they typed is not shown in the chat either.
 *
 * havoc9.org answers (POST /api/presence/compete/rank, docs\H9_COMPETITIVE.txt), signed with
 * h9_presence's key, so there is no key to set here: a player's rank by their h9_clientid, an
 * account's by its username. A bot, and a player whose game has no havoc9.org account proven on
 * this server, is "not signed in: no rank". No switch on an account hides its rank.
 *
 *   h9_rank_command 1    .rank answers (0: .rank is left alone, as if the plugin were not here)
 *   h9_rank_cooldown 5   seconds between two .rank from one player (1 to 60)
 *
 * Needs h9_presence.amxx with a live key (its address and key: h9p_api, h9p_sign) and the
 * AmxxEasyHttp module. configs/h9_rank.cfg is executed on every map.
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler: explicit tags, braces on
 * every block, and no backslash escapes in strings.
 */

#include <amxmodx>
#include <amxmisc>
#include <easy_http>

#define H9C_CORE
#include <h9_community>

#define PLUGIN  "H9 Rank"
#define VERSION "1.0"
#define AUTHOR  "H9"

#define MAX_BODY     1024
#define CALL_TIMEOUT 10000
#define LABEL_LEN    32                  // the name an answer is about, as the asker will read it
#define UD_CELLS     (3 + LABEL_LEN + 1) // slot, who held it, own, then the label

new g_cv_command, g_cv_cooldown;
new bool:g_have_presence = true;
new g_maxplayers;
new g_gen[MAX_PLAYERS + 1];              // counts who held the slot, so a late answer finds the right player
new Float:g_last[MAX_PLAYERS + 1];       // when the slot last asked

new g_body[MAX_BODY];
new g_len;
new bool:g_full = false;
new const HEX[] = "0123456789abcdef";
new const RANK_WORDS[][] = { ".rank", "/rank", "!rank", "/elo", "!elo" };

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_command  = register_cvar("h9_rank_command", "1");
	g_cv_cooldown = register_cvar("h9_rank_cooldown", "5");

	register_clcmd("say",      "hook_say");
	register_clcmd("say_team", "hook_say");

	g_maxplayers = min(get_maxplayers(), MAX_PLAYERS);
}

public plugin_natives()
{
	set_native_filter("native_filter");
}

// h9_presence may be missing: its natives go unbound, and a call to one marks it gone and
// answers 0.
public native_filter(const name[], index, trap)
{
	if (!trap)
	{
		return PLUGIN_HANDLED;
	}
	if (equal(name, "h9p_", 4))
	{
		g_have_presence = false;
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

public plugin_cfg()
{
	// configs/h9_rank.cfg: the server's own settings, or a preset's (H9XASH\presets)
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_rank.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
}

public client_putinserver(id)
{
	if (id >= 1 && id <= g_maxplayers)
	{
		g_gen[id]++;
		g_last[id] = 0.0;
	}
}

public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id >= 1 && id <= g_maxplayers)
	{
		g_gen[id]++;
	}
}

bool:ready()
{
	return g_have_presence && h9p_ready() != 0;
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

// ---- .rank --------------------------------------------------------------------------------------

public hook_say(id)
{
	if (id < 1 || id > g_maxplayers || !get_pcvar_num(g_cv_command) || !is_user_connected(id) || is_user_bot(id) || is_user_hltv(id))
	{
		return PLUGIN_CONTINUE;
	}

	new args[96];
	read_args(args, charsmax(args));
	remove_quotes(args);
	trim(args);

	new n = rank_command(args);
	if (!n)
	{
		return PLUGIN_CONTINUE;
	}
	new who[64];
	copy(who, charsmax(who), args[n]);
	trim(who);
	cmd_rank(id, who);
	return PLUGIN_HANDLED;
}

/** The length of the command at the start of text: .rank, or /rank, !rank, /elo, !elo; 0 for none. */
rank_command(const text[])
{
	for (new i = 0; i < sizeof(RANK_WORDS); i++)
	{
		new n = strlen(RANK_WORDS[i]);
		if (equali(text, RANK_WORDS[i], n) && (text[n] == 0 || text[n] == ' '))
		{
			return n;
		}
	}
	return 0;
}

cmd_rank(id, const who[])
{
	new Float:now = get_gametime();
	new wait = clamp(get_pcvar_num(g_cv_cooldown), 1, 60);
	if (g_last[id] > 0.0 && now - g_last[id] < float(wait))
	{
		client_print(id, print_chat, "[H9] One .rank every %d seconds.", wait);
		return;
	}
	if (!ready())
	{
		client_print(id, print_chat, "[H9] Ranks are not available here: this server has no live havoc9.org key.");
		return;
	}

	new asker[33];
	client_id(id, asker);

	// your own
	if (!who[0])
	{
		if (!asker[0])
		{
			client_print(id, print_chat, "[H9] You are not signed in: no rank. Link your game to your havoc9.org account to be ranked (.link).");
			return;
		}
		g_last[id] = now;
		new mine[32];
		get_user_name(id, mine, charsmax(mine));
		if (!ask(id, asker, asker, "", mine, true))
		{
			client_print(id, print_chat, "[H9] Your rank could not be asked for just now. Try again in a minute.");
		}
		return;
	}

	// a player on this server first
	new target = player_named(id, who);
	if (target < 0)
	{
		return;
	}
	if (target > 0)
	{
		new name[32];
		get_user_name(target, name, charsmax(name));
		new cid[33];
		if (is_user_bot(target) || is_user_hltv(target) || !client_id(target, cid))
		{
			client_print(id, print_chat, "[H9] %s: not signed in: no rank.", name);
			return;
		}
		g_last[id] = now;
		if (!ask(id, asker, cid, "", name, target == id))
		{
			client_print(id, print_chat, "[H9] That rank could not be asked for just now. Try again in a minute.");
		}
		return;
	}

	// nobody here by that name: the havoc9.org account named so
	g_last[id] = now;
	if (!ask(id, asker, "", who, who, false))
	{
		client_print(id, print_chat, "[H9] That rank could not be asked for just now. Try again in a minute.");
	}
}

/**
 * The player on this server named who: an exact name (any case) first, else the one name that
 * has who in it. 0 for nobody; -1 when several have it in their names, which the asker is told.
 */
player_named(id, const who[])
{
	new found = 0, count = 0;
	new name[32], list[128];
	list[0] = 0;
	for (new i = 1; i <= g_maxplayers; i++)
	{
		if (!is_user_connected(i) || is_user_hltv(i))
		{
			continue;
		}
		get_user_name(i, name, charsmax(name));
		if (equali(name, who))
		{
			return i;
		}
		if (containi(name, who) != -1)
		{
			found = i;
			count++;
			if (count <= 4)
			{
				if (list[0])
				{
					add(list, charsmax(list), ", ");
				}
				add(list, charsmax(list), name);
			}
		}
	}
	if (count == 1)
	{
		return found;
	}
	if (count > 1)
	{
		client_print(id, print_chat, "[H9] %d players here have that in their names: %s%s. Type more of the name.", count, list, count > 4 ? ", ..." : "");
		return -1;
	}
	return 0;
}

/** Asks havoc9.org for one rank: by h9_clientid (cid) or by username (name). label names it in the answer. */
bool:ask(id, const asker[], const cid[], const name[], const label[], bool:own)
{
	body_begin();
	if (asker[0])
	{
		app_raw(",^"asker^":");
		app_str(asker);
	}
	if (cid[0])
	{
		app_raw(",^"id^":");
		app_str(cid);
	}
	else
	{
		app_raw(",^"name^":");
		app_str(name);
	}
	app_raw("}");

	new ud[UD_CELLS];
	ud[0] = id;
	ud[1] = g_gen[id];
	ud[2] = own ? 1 : 0;
	new n = 0;
	for (; n < LABEL_LEN && label[n]; n++)
	{
		ud[3 + n] = label[n];
	}
	ud[3 + n] = 0;
	return post_signed("/compete/rank", "on_rank", ud, sizeof(ud));
}

public on_rank(EzHttpRequest:request_id)
{
	new ud[UD_CELLS];
	ezhttp_get_user_data(request_id, ud);
	new id = ud[0];
	if (id < 1 || id > g_maxplayers || g_gen[id] != ud[1] || !is_user_connected(id))
	{
		return;
	}
	new label[LABEL_LEN + 1];
	for (new i = 0; i < LABEL_LEN; i++)
	{
		label[i] = ud[3 + i];
		if (!label[i])
		{
			break;
		}
	}
	label[LABEL_LEN] = 0;

	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		client_print(id, print_chat, "[H9] havoc9.org did not answer. Try .rank again in a minute.");
		return;
	}
	new code = ezhttp_get_http_code(request_id);
	if (code == 429)
	{
		client_print(id, print_chat, "[H9] Too many questions to havoc9.org from this server just now. Try again in a minute.");
		return;
	}
	if (code != 200)
	{
		client_print(id, print_chat, "[H9] havoc9.org could not read ranks just now (%d).", code);
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		client_print(id, print_chat, "[H9] havoc9.org's answer could not be read.");
		return;
	}
	if (!ezjson_object_has_value(root, "account", EzJSONObject))
	{
		if (ezjson_object_has_value(root, "unknown", EzJSONBoolean) && ezjson_object_get_bool(root, "unknown"))
		{
			client_print(id, print_chat, "[H9] Nobody here and no havoc9.org account is named %s.", label);
		}
		else if (ud[2])
		{
			client_print(id, print_chat, "[H9] You are not signed in: no rank. Link your game to your havoc9.org account to be ranked (.link).");
		}
		else
		{
			client_print(id, print_chat, "[H9] %s: not signed in: no rank.", label);
		}
		ezjson_free(root);
		return;
	}

	new EzJSON:a = ezjson_object_get_value(root, "account");
	new user[64];
	ezjson_object_get_string(a, "username", user, charsmax(user));
	readout(id, a, user);
	ezjson_free(a);
	ezjson_free(root);
}

/** The chat line and the console block for one account's rank. */
readout(id, EzJSON:a, const user[])
{
	new level = -1;
	if (ezjson_object_has_value(a, "level", EzJSONNumber))
	{
		level = ezjson_object_get_number(a, "level");
	}
	new rule[16];
	ezjson_object_get_string(a, "rule", rule, charsmax(rule));
	new season = 0;
	new since[16];
	since[0] = 0;
	if (ezjson_object_has_value(a, "season", EzJSONObject))
	{
		new EzJSON:s = ezjson_object_get_value(a, "season");
		season = ezjson_object_get_number(s, "number");
		if (ezjson_object_has_value(s, "started", EzJSONString))
		{
			ezjson_object_get_string(s, "started", since, 10);
		}
		ezjson_free(s);
	}

	new head[48];
	if (level >= 0)
	{
		formatex(head, charsmax(head), "%s, Lv %d", user, level);
	}
	else
	{
		copy(head, charsmax(head), user);
	}

	new EzJSON:list = ezjson_object_has_value(a, "ladders", EzJSONArray) ? ezjson_object_get_value(a, "ladders") : EzInvalid_JSON;
	new count = list != EzInvalid_JSON ? ezjson_array_get_count(list) : 0;

	client_print(id, print_console, "---- H9 RANK: %s (havoc9.org) ----", user);
	if (level >= 0)
	{
		if (equal(rule, "career"))
		{
			client_print(id, print_console, "Level      Lv %d, by career experience (%d XP)", level, ezjson_object_get_number(a, "xp"));
		}
		else
		{
			client_print(id, print_console, "Level      Lv %d, by rating", level);
		}
	}
	if (season > 0)
	{
		client_print(id, print_console, "Season     %d, since %s", season, since);
	}

	// the chat line takes the H9 ladder's MATCH table, else the first there is
	new chat[190];
	new bool:said = false;
	for (new i = 0; i < count; i++)
	{
		new EzJSON:l = ezjson_array_get_value(list, i);
		new kind[12], ladder[8];
		ezjson_object_get_string(l, "kind", kind, charsmax(kind));
		ezjson_object_get_string(l, "ladder", ladder, charsmax(ladder));
		new elo = ezjson_object_get_number(l, "elo");
		new place = ezjson_object_get_number(l, "place");
		new matches = ezjson_object_get_number(l, "matches");
		new wins = ezjson_object_get_number(l, "wins");
		new losses = ezjson_object_get_number(l, "losses");
		new kills = ezjson_object_get_number(l, "kills");
		new deaths = ezjson_object_get_number(l, "deaths");
		new headshots = ezjson_object_get_number(l, "headshots");
		new Float:kd = ezjson_object_get_real(l, "kd");
		new assists = ezjson_object_has_value(l, "assists", EzJSONNumber) ? ezjson_object_get_number(l, "assists") : -1;
		ezjson_free(l);

		new where[24];
		copy(where, charsmax(where), equal(kind, "network") ? "H9 ladder" : equal(kind, "server") ? "This server" : "Community");
		new table[8];
		copy(table, charsmax(table), equal(ladder, "dm") ? "DM" : "MATCH");

		new numbers[96];
		if (assists >= 0)
		{
			formatex(numbers, charsmax(numbers), "%d kills, %d deaths, %d assists, %d headshots, K/D %.2f", kills, deaths, assists, headshots, kd);
		}
		else
		{
			formatex(numbers, charsmax(numbers), "%d kills, %d deaths, %d headshots, K/D %.2f", kills, deaths, headshots, kd);
		}
		client_print(id, print_console, "%s, %s: rating %d, #%d | %d %s, %d won, %d lost", where, table, elo, place, matches, matches == 1 ? "match" : "matches", wins, losses);
		client_print(id, print_console, "    %s", numbers);

		if (!said && (i == 0 || (equal(kind, "network") && equal(ladder, "match"))))
		{
			new kda[48];
			if (assists >= 0)
			{
				formatex(kda, charsmax(kda), "%d kills, %d deaths, %d assists", kills, deaths, assists);
			}
			else
			{
				formatex(kda, charsmax(kda), "%d kills, %d deaths", kills, deaths);
			}
			formatex(chat, charsmax(chat), "[H9] %s | %s %s %d (#%d) | %d-%d in %d %s | K/D %.2f (%s)",
				head, where, table, elo, place, wins, losses, matches, matches == 1 ? "match" : "matches", kd, kda);
			said = equal(kind, "network") && equal(ladder, "match");
		}
	}
	if (list != EzInvalid_JSON)
	{
		ezjson_free(list);
	}
	if (!count)
	{
		client_print(id, print_console, "No ranked matches or kills yet this season.");
		formatex(chat, charsmax(chat), "[H9] %s | no ranked matches yet this season.", head);
	}
	client_print(id, print_console, "-----------------------------------------");
	client_print(id, print_chat, "%s", chat);
	client_print(id, print_chat, "[H9] The whole readout is in your console.");
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

/** POSTs g_body to h9web's presence API + path, signed with h9_presence's live key. */
bool:post_signed(const path[], const callback[], const ud[], udlen)
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
	ezhttp_option_set_user_agent(opt, "h9_rank/1.0");
	ezhttp_option_set_timeout(opt, CALL_TIMEOUT);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, g_body);
	ezhttp_option_set_user_data(opt, ud, udlen);
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
