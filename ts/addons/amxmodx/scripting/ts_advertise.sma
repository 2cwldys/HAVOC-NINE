/*
 * ts_advertise.sma -- ".advertise" posts a match call to Discord
 *
 * Someone types .advertise in chat and an embed goes to a Discord channel saying a
 * match is being organised, with the map, who is on, and a connect line to join with.
 * One advert every thirty minutes, SERVER-WIDE rather than per player.
 *
 * It posts as a BOT, through the REST API, rather than through a webhook: the message
 * comes from the server's own bot account and carries its name and avatar. That needs
 * a bot token and a channel id (tsm_ad_token, tsm_ad_channel) instead of a webhook
 * URL, and the bot has to be in the guild with Send Messages in that channel.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS AmxxEasyHttp
 *
 * The Discord API is HTTPS only. The sockets module that ships with AMXX speaks raw
 * TCP and has no TLS, so it cannot reach Discord at all -- not with more code, not
 * with a cleverer request. Something that can do TLS has to be involved.
 *
 * AmxxEasyHttp is that something, and compts/ already depends on it, so the module
 * and its CA bundle are already part of this server's story. It needs:
 *
 *     ts\addons\amxmodx\modules\easy_http_amxx.dll
 *     ts\addons\amxmodx\data\amxx_easy_http_cacert.pem
 *
 * WITHOUT THE .pem EVERY REQUEST FAILS certificate validation, and it reports as a
 * connection error rather than as a missing file, which is a miserable hour.
 * ---------------------------------------------------------------------------
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler: explicit
 * tags, braces on every block, and no backslash escapes in strings.
 */

#include <amxmodx>
#include <amxmisc>
#include <nvault>
#include <easy_http>

#define PLUGIN  "TS Advertise"
#define VERSION "1.0"
#define AUTHOR  "2cwldys"

// ts_matchmode's states, so the embed can say what is happening. Kept in step with
// ts_matchmode.sma by hand: there are six and they have not changed.
#define ST_WARMUP    0
#define ST_READYUP   1
#define ST_FREEZE    2
#define ST_LIVE      3
#define ST_ROUNDEND  4
#define ST_MATCHEND  5

/**
 * ts_matchmode's state, round and score, if it is loaded.
 *
 * Reached through a native filter (see native_filter below), so this plugin loads and
 * works with ts_matchmode absent, disabled or older than the native -- the embed just
 * leaves the match line out. Calling a missing native without a filter is fatal.
 */
native tsm_match_info(out[4]);

/**
 * The game description the server browser shows -- "Match Mode", "Siege 2/5", "Capture the
 * Uplink", "Wave Survival", "Mech Warrior" -- for the embed's Mode field. Through the same
 * native filter: with ts_matchmode absent or older than it, the field is left out.
 */
native tsm_match_desc(out[], len);

new g_cv_token, g_cv_channel, g_cv_role, g_cv_cooldown, g_cv_connect, g_cv_flag, g_cv_minplayers;
new g_vault = INVALID_HANDLE;
new bool:g_have_match = true;      // cleared by the native filter if ts_matchmode is not there
new bool:g_have_desc = true;       // the same for tsm_match_desc
new bool:g_sending = false;        // one request in flight at a time

/**
 * Lets tsm_match_info be missing instead of refusing to load.
 *
 * SET HERE AND NOT IN plugin_init. AMXX links a plugin's natives before it runs any
 * plugin_init, so a filter installed there arrives after the decision it is meant to
 * influence has already been taken -- and the plugin is refused outright with "uses an
 * unknown function", which is what happened.
 */
public plugin_natives()
{
	set_native_filter("native_filter");
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	// The bot token is the whole account: anyone holding it can act as the bot
	// ANYWHERE IT IS IN, not just in this one channel, until it is regenerated.
	// FCVAR_PROTECTED keeps it out of cvar listings and out of "amx_cvar" output,
	// where anyone with a little access would otherwise read it straight off the
	// screen. It is never logged, not even on failure.
	g_cv_token   = register_cvar("tsm_ad_token",   "", FCVAR_PROTECTED);
	g_cv_channel = register_cvar("tsm_ad_channel", "");

	g_cv_role       = register_cvar("tsm_ad_role",       "1559132404424380436");
	g_cv_cooldown   = register_cvar("tsm_ad_cooldown",   "1800");
	g_cv_connect    = register_cvar("tsm_ad_connect",    "");
	g_cv_flag       = register_cvar("tsm_ad_flag",       "");
	g_cv_minplayers = register_cvar("tsm_ad_minplayers", "1");

	register_clcmd("say",      "hook_say");
	register_clcmd("say_team", "hook_say");


	// The cooldown outlives the map. A map change reloads every plugin and clears its
	// globals, so a cooldown held in memory alone is reset by any map vote -- which is
	// both an obvious way round it and an easy accident on a server that rotates.
	g_vault = nvault_open("tsm_advertise");
	if (g_vault == INVALID_HANDLE)
	{
		log_amx("[ADVERT] WARNING: could not open the nvault. The cooldown will reset on every map change.");
	}
}

public plugin_cfg()
{
	// AMXX only auto-execs amxx.cfg, so a plugin's own config is inert unless the
	// plugin asks for it. server_exec() forces the queued commands through now rather
	// than next frame, so the cvars are really set before anything reads them.
	//
	// ONE config file, token included. build.bat does not overwrite it once it exists,
	// so a rebuild cannot wipe the token out of it.
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_advertise.cfg", dir);

	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
	else
	{
		log_amx("[ADVERT] No config at %s -- advertising is disabled until it exists.", file);
	}
}

public plugin_end()
{
	if (g_vault != INVALID_HANDLE)
	{
		nvault_close(g_vault);
	}
}

/**
 * Lets a missing native pass instead of killing the plugin.
 *
 * `trap` is 0 while the plugin is being loaded and 1 when a missing native is actually
 * called. Returning PLUGIN_HANDLED in both cases means "I have dealt with it", and the
 * call returns 0 rather than throwing.
 */
public native_filter(const name[], index, trap)
{
	if (!trap)
	{
		return PLUGIN_HANDLED;
	}
	if (equal(name, "tsm_match_info"))
	{
		g_have_match = false;
		return PLUGIN_HANDLED;
	}
	if (equal(name, "tsm_match_desc"))
	{
		g_have_desc = false;
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

public hook_say(id)
{
	new args[64];
	read_args(args, charsmax(args));
	remove_quotes(args);
	trim(args);

	if (equali(args, ".advertise") || equali(args, ".ad"))
	{
		cmd_advertise(id);
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

// ── the cooldown ───────────────────────────────────────────────────────────

/** When the last advert was accepted, as unix time. 0 if there has never been one. */
last_advert()
{
	if (g_vault == INVALID_HANDLE)
	{
		return 0;
	}
	new data[32];
	if (!nvault_get(g_vault, "last_advert", data, charsmax(data)))
	{
		return 0;
	}
	return str_to_num(data);
}

arm_cooldown()
{
	if (g_vault == INVALID_HANDLE)
	{
		return;
	}
	new data[32];
	num_to_str(get_systime(), data, charsmax(data));
	// pset rather than set: a timestamped entry can be pruned out from under us, and a
	// cooldown that quietly forgets itself is worse than no cooldown at all.
	nvault_pset(g_vault, "last_advert", data);
}

// ── the command ────────────────────────────────────────────────────────────

cmd_advertise(id)
{
	if (!is_user_connected(id))
	{
		return;
	}

	new token[128], channel[32];
	get_pcvar_string(g_cv_token, token, charsmax(token));
	get_pcvar_string(g_cv_channel, channel, charsmax(channel));
	trim(token);
	trim(channel);
	if (!token[0] || !channel[0])
	{
		client_print(id, print_chat, "[ADVERT] Discord is not configured on this server.");
		return;
	}

	new flag[8];
	get_pcvar_string(g_cv_flag, flag, charsmax(flag));
	trim(flag);
	if (flag[0] && !(get_user_flags(id) & read_flags(flag)))
	{
		client_print(id, print_chat, "[ADVERT] You are not allowed to advertise on this server.");
		return;
	}

	new here = get_playersnum();
	new need = get_pcvar_num(g_cv_minplayers);
	if (here < need)
	{
		client_print(id, print_chat, "[ADVERT] Not enough players to advertise yet -- %d here, %d needed.", here, need);
		return;
	}

	new left = last_advert() + get_pcvar_num(g_cv_cooldown) - get_systime();
	if (left > 0)
	{
		// Minutes, rounded up, so "1 minute" never means "any moment now" for 59 seconds.
		client_print(id, print_chat, "[ADVERT] Already advertised recently. Try again in %d minute%s.",
			(left + 59) / 60, (left + 59) / 60 == 1 ? "" : "s");
		return;
	}

	if (g_sending)
	{
		client_print(id, print_chat, "[ADVERT] An advert is already on its way.");
		return;
	}

	send_advert(id, token, channel);
}

// ── the payload ────────────────────────────────────────────────────────────

send_advert(id, const token[], const channel[])
{
	new name[32], host[128], map[64], role[32], connect[64];
	get_user_name(id, name, charsmax(name));
	get_cvar_string("hostname", host, charsmax(host));
	get_mapname(map, charsmax(map));
	get_pcvar_string(g_cv_role, role, charsmax(role));
	trim(role);

	get_pcvar_string(g_cv_connect, connect, charsmax(connect));
	trim(connect);
	if (!connect[0])
	{
		// net_address is the address the server BOUND to, which behind NAT is a LAN
		// address nobody outside can reach. It is the fallback, never the answer, and
		// tsm_ad_connect exists to be the answer.
		get_cvar_string("net_address", connect, charsmax(connect));
	}

	new EzJSON:root = ezjson_init_object();
	new mention[64];
	if (role[0])
	{
		formatex(mention, charsmax(mention), "<@&%s>", role);
	}
	ezjson_object_set_string(root, "content", mention);

	// Discord renders <@&id> as plain text unless allowed_mentions names the role, and
	// the ping then silently does nothing. It looks exactly like a server permissions
	// problem and it is not one. An empty "parse" turns off everything else, so this
	// can never ping @everyone however the message is worded.
	new EzJSON:allow = ezjson_init_object();
	ezjson_object_set_value(allow, "parse", ezjson_init_array());
	if (role[0])
	{
		new EzJSON:roles = ezjson_init_array();
		ezjson_array_append_string(roles, role);
		ezjson_object_set_value(allow, "roles", roles);
	}
	ezjson_object_set_value(root, "allowed_mentions", allow);

	new EzJSON:embed = ezjson_init_object();
	new line[192];
	formatex(line, charsmax(line), "%s is organising a match on %s", name, host);
	ezjson_object_set_string(embed, "title", "Someone is looking for a match");
	ezjson_object_set_string(embed, "description", line);
	ezjson_object_set_number(embed, "color", 0xA78BFA);   // the embed sidebar: light purple

	new EzJSON:fields = ezjson_init_array();
	add_field(fields, "Map", map, true);

	// The mode, as the server browser names it.
	new mode[64];
	if (g_have_desc && tsm_match_desc(mode, charsmax(mode)) && mode[0])
	{
		add_field(fields, "Mode", mode, true);
	}

	// HUMANS, not everyone. get_playersnum() counts bots along with people -- its one
	// argument is about players still connecting, not about bots -- so a server with
	// eleven bots and nobody in it would advertise "11 / 24" and read as busy.
	new humans, bots, count[48];
	count_players(humans, bots);
	formatex(count, charsmax(count), "%d / %d", humans, get_maxplayers());
	add_field(fields, "Players", count, true);

	// Only when there are any. A permanent "Bots: 0" is noise, and on a server that
	// never runs them it is noise for ever.
	if (bots > 0)
	{
		formatex(count, charsmax(count), "%d", bots);
		add_field(fields, "Bots", count, true);
	}

	// Not "state": that is a reserved word in Pawn, for automaton states, and using it
	// gets "invalid symbol name" pointing at the line AFTER the declaration.
	new standing[64];
	if (match_line(standing, charsmax(standing)))
	{
		add_field(fields, "Match", standing, true);
	}

	new conn[96];
	formatex(conn, charsmax(conn), "`connect %s`", connect);
	add_field(fields, "Connect", conn, false);

	ezjson_object_set_value(embed, "fields", fields);

	new EzJSON:embeds = ezjson_init_array();
	ezjson_array_append_value(embeds, embed);
	ezjson_object_set_value(root, "embeds", embeds);

	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_timeout(opt, 8000);

	// "Bot " in front of the token is required and is not a formality -- Discord reads
	// the word to decide which kind of credential it has been handed, and without it
	// answers 401 with the token perfectly valid.
	new auth[160];
	formatex(auth, charsmax(auth), "Bot %s", token);
	ezhttp_option_set_header(opt, "Authorization", auth);

	// A real bot needs a user agent; Discord rejects requests without one.
	ezhttp_option_set_user_agent(opt, "ts_advertise (https://github.com/2cwldys, 1.0)");

	// Serialised by hand rather than with ezhttp_option_set_body_from_json, BECAUSE
	// THAT NAME IS 32 CHARACTERS and this compiler truncates symbols at 31 -- it says
	// so as warning 200 and carries on. Whether the truncated name still finds the
	// module's native is a question answered at runtime, on a live server, by the
	// request silently never being sent. ezjson_serial_to_string is 23 characters and
	// cannot have the problem.
	new body[2048];
	if (ezjson_serial_size(root) >= charsmax(body))
	{
		log_amx("[ADVERT] payload too large (%d bytes) -- shorten the hostname or the connect line.", ezjson_serial_size(root));
		ezjson_free(root);
		client_print(id, print_chat, "[ADVERT] Could not build the message. Nothing was posted.");
		return;
	}
	ezjson_serial_to_string(root, body, charsmax(body));
	ezhttp_option_set_body(opt, body);

	// Only the root is freed. Whether set_value takes ownership of what it is given or
	// copies it is not written down anywhere, and the two are not both safe: freeing
	// the children as well is a double free if it takes ownership, while freeing only
	// the root leaks a few handles once every thirty minutes if it copies. One of those
	// crashes a game server and the other does not.
	ezjson_free(root);

	new url[128];
	formatex(url, charsmax(url), "https://discord.com/api/v10/channels/%s/messages", channel);

	g_sending = true;
	ezhttp_post(url, "on_posted", opt);
	client_print(id, print_chat, "[ADVERT] Posting to Discord...");
}

/**
 * Who is on, split into people and bots.
 *
 * get_players' flags do the separating: "c" skips bots, "d" skips real players, and "h"
 * skips HLTV in both cases so a spectating recorder is never counted as either.
 */
count_players(&humans, &bots)
{
	new list[32], n;
	get_players(list, n, "ch");
	humans = n;
	get_players(list, n, "dh");
	bots = n;
}

/** One embed field. `inline` puts it beside its neighbours rather than on its own row. */
add_field(EzJSON:fields, const title[], const value[], bool:inline)
{
	new EzJSON:f = ezjson_init_object();
	ezjson_object_set_string(f, "name", title);
	ezjson_object_set_string(f, "value", value);
	ezjson_object_set_bool(f, "inline", inline);
	ezjson_array_append_value(fields, f);
}

/** ts_matchmode's state in words. False when it is not loaded, and the field is dropped. */
bool:match_line(out[], len)
{
	if (!g_have_match)
	{
		return false;
	}

	new info[4];
	tsm_match_info(info);
	if (!g_have_match)
	{
		return false;      // the filter has just told us the native was missing
	}

	switch (info[0])
	{
		case ST_WARMUP:   { formatex(out, len, "Warmup"); }
		case ST_READYUP:  { formatex(out, len, "Ready-up"); }
		case ST_MATCHEND: { formatex(out, len, "Just finished, %d - %d", info[2], info[3]); }
		case ST_FREEZE, ST_LIVE, ST_ROUNDEND:
		{
			formatex(out, len, "Live -- round %d, %d - %d", info[1], info[2], info[3]);
		}
		default: { formatex(out, len, "Warmup"); }
	}
	return true;
}

// ── what Discord said about it ─────────────────────────────────────────────

public on_posted(EzHttpRequest:request_id)
{
	g_sending = false;

	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		new err[128];
		ezhttp_get_error_message(request_id, err, charsmax(err));
		log_amx("[ADVERT] request failed: %s", err);
		announce("[ADVERT] Could not reach Discord. Nothing was posted.");
		return;
	}

	new code = ezhttp_get_http_code(request_id);
	if (code < 200 || code > 299)
	{
		new body[256];
		ezhttp_get_data(request_id, body, charsmax(body));
		log_amx("[ADVERT] Discord refused the post: HTTP %d -- %s", code, body);
		announce("[ADVERT] Discord refused the post. Nothing was advertised.");
		return;
	}

	// ARMED ON SUCCESS, not on attempt. A failed advert that still started the clock
	// would lock the server out for half an hour over a typo in the channel id.
	arm_cooldown();
	announce("[ADVERT] Posted to Discord -- a match is being organised.");
}

announce(const msg[])
{
	new players[32], pnum;
	get_players(players, pnum, "ch");
	for (new i = 0; i < pnum; i++)
	{
		client_print(players[i], print_chat, "%s", msg);
	}
}
