/*
 * h9_community.sma -- this server's havoc9.org community: chat between its servers and the
 * website, announcements, finding a player, per-account data for other plugins, and portals to
 * the community's other servers
 *
 * Needs h9_presence.amxx above it in plugins.ini. The server's key, address and public server id
 * are h9_presence's (it enrolls the server), and every call here is signed with that key through
 * h9_presence's natives: the key never leaves h9_presence. Until the server has a live key, and
 * on a listen server, which never gets one, this plugin sends nothing and prints nothing.
 * docs\H9_COMMUNITIES.txt is the guide, and holds the trust model.
 *
 * THE LINK. One long-poll to h9web at a time (POST /api/presence/server/poll, signed), which
 * h9web holds open up to 20 seconds and answers at once when there is something: community chat
 * and announcements for the players here, whether h9_presence should report now (a kick or a
 * sanction waits in the answer to that report), and the community with its servers. A server in
 * no community polls too, for H9-wide announcements. The last message seen is kept across map
 * changes (localinfo h9c_since), so a map change loses no line. A failed poll waits longer each
 * time, 5 seconds to 5 minutes, without a word; h9_community_status says how it is going.
 *
 * CHAT. "<prefix> <text>" in say or say_team (h9_community_prefix, ".relay") sends a line to the
 * community's channel. Only a player whose h9_clientid is a havoc9.org account's can relay, under
 * that account's name, and only while h9web has the account in game here. The game must also be one
 * h9web has proven holds the account's player id (h9p_account): an announced h9_clientid is readable
 * by every player on the server, so a copy of it proves nothing. The community's owner may switch
 * that off (CHAT NEEDS PROVEN PLAYERS; the poll's "chatProof" says which), and then a player whose
 * h9_clientid another player here announces too (one of them is a copy) relays only when h9web has
 * proven that player's game. A game that cannot prove (an older H9XASH, a Steam client, or a server
 * with h9_presence_challenge 0) is told why in chat, and keeps the server's own chat. h9web cleans
 * the text, keeps the cooldown and the rate limits, and refuses a muted or banned account. The line
 * shows here, on every other server of the community and in the website's chatbox as
 * "[Tag] Name: text"; lines from the website come as "[Web] Name: text". Every line from h9web
 * is cleaned again here (no control characters, colour codes, % or backslashes) and printed
 * with "%s", never as a format.
 *
 * FIND. "/find <name>" or "/where <name>" (also .find and .where): where that account is, the
 * exact username and up to four that start with it, this community's players first, each
 * account's own privacy switches applied by h9web, with the address to connect to. Who asks is
 * named to h9web only for a proven game, as a private community's servers show to its members.
 *
 * PORTALS. "h9_portal <tag|server id> <x> <y> <z> [yaw] [radius] [walk]" lines in
 * ts\mapconfigs\<map>.cfg (run by h9_autoconfig once the map is up) place portals to the
 * community's other servers: a ring, a label with the server's name and players, E (or walking
 * in, with walk 1), a confirm menu and h9_community_portal_wait seconds before the next. A
 * server cannot move a client itself: FWGS runs "connect" only when the player typed it. A
 * client whose userinfo has _h9travel "1" (H9XASH and the web client with engine-h9-travel.patch)
 * is sent "h9_travel <address> <name>", which its engine shows as its own YES/NO prompt; every
 * other client is given the address to type. h9_community_travel 1 sends h9_travel to those
 * others too (docs\H9_COMMUNITIES.txt, PORTALS).
 * amx_h9_portal_add places one where an admin stands and prints its line.
 *
 * LINKING. h9_community_claim (server console or rcon) or amx_h9_claim (in game, rcon admins)
 * asks h9web for a one-time code that links this server to a community on havoc9.org.
 *
 * FOR OTHER PLUGINS: include\h9_community.inc (h9c_get, h9c_set, h9c_delete, h9c_find, ...). A call
 * about a player goes out only for a proven game (h9p_account), unless the community's owner switched
 * DATA NEEDS PROVEN PLAYERS off (the poll's "dataProof").
 *
 * Written to the same rules as h9_presence.sma: explicit tags, braces on every block, and a
 * backslash in a string only where a menu's colour code needs one.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <easy_http>

#define H9C_CORE
#include <h9_community>
#include <h9_presence>  // h9p_account: the slot's proven account
#include <h9_vgui>      // an H9 game draws the portal's confirm on a panel

#pragma dynamic 16384

#define PLUGIN  "H9 Community"
#define VERSION "1.2"
#define AUTHOR  "2cwldys"

#define MAX_BODY      4096     // the largest call, in bytes (h9web takes up to 4096)
#define MAX_SERVERS   32       // the community's servers kept, for portals
#define MAX_PORTALS   16       // portals on one map
#define MAX_CALLS     24       // h9c_ calls in flight at once
#define POLL_TIMEOUT  35000    // ms; h9web holds a poll up to 20 seconds
#define CALL_TIMEOUT  15000    // ms, every other call
#define SAY_GAP       2.0      // seconds between two relayed lines of one player (h9web keeps 2)
#define FIND_GAP      5.0      // seconds between two searches of one player
#define NEAR          96.0     // a portal's label shows, and E works, this far beyond its radius
#define RING          "sprites/tsm_zone_ring_0.spr"
#define RING_PX       56.0     // the ring's radius in that sprite at scale 1 (as ts_uplink has it)

#define TASK_POLL     59220
#define TASK_WAIT     59221
#define TASK_PORTALS  59222

// A call's user data (ezhttp_option_set_user_data): what it was for, and for whom.
#define UD_KIND       0
#define UD_ID         1        // the player's slot; 0 for the server console
#define UD_USERID     2        // who held the slot then
#define UD_FWD        3        // the calling plugin's forward, -1 for none
#define UD_DATA       4        // the calling plugin's data
#define UD_TEXT       5        // the key, or the name searched for: 32 characters and the end
#define UD_SIZE       38

#define K_CHAT        1
#define K_FIND        2
#define K_GET         3
#define K_SET         4
#define K_CLAIM       5

new g_cv_prefix, g_cv_chat, g_cv_find, g_cv_travel, g_cv_wait;

new bool:g_have_presence = true;  // cleared when h9_presence is not loaded (the native filter)
new g_max;

// the link to h9web
new bool:g_polling = false;       // a poll in flight
new g_poll_at = 0;                // when it went out
new bool:g_linked = false;        // the last poll was answered
new g_fails = 0;                  // polls in a row that failed (the backoff)
new g_since = -1;                 // the last message seen; -1: none yet, h9web starts from now
new g_calls = 0;                  // h9c_ calls in flight
new g_last_code = 0;              // the last poll's HTTP status (0: no answer)
new g_last_error[32];             // h9web's error code, when that was not 200
new const WAITS[] = { 5, 10, 30, 60, 120, 300 };

// the community, as the last poll had it
new g_cslug[40], g_cname[48], g_ctag[16];
new bool:g_cchat = false;
new bool:g_cro = false;
new bool:g_cchatproof = true;     // CHAT NEEDS PROVEN PLAYERS: a poll that does not say counts as on
new bool:g_cdataproof = true;     // DATA NEEDS PROVEN PLAYERS

// its servers
new g_scount = 0;
new g_stag[MAX_SERVERS][16];
new g_sid[MAX_SERVERS][16];
new g_saddr[MAX_SERVERS][24];
new g_sname[MAX_SERVERS][48];
new g_shumans[MAX_SERVERS];       // -1: no fresh word from it
new g_smax[MAX_SERVERS];

// portals
new g_pcount = 0;
new g_pdest[MAX_PORTALS][24];     // where it leads, as written: a tag or a server id
new Float:g_porg[MAX_PORTALS][3];
new Float:g_pyaw[MAX_PORTALS];
new Float:g_prad[MAX_PORTALS];
new bool:g_pwalk[MAX_PORTALS];
new g_pent[MAX_PORTALS];          // its ring, 0 for none
new g_pto[MAX_PORTALS];           // the server it leads to, -1 while none
new bool:g_ring_ok = false;       // the ring was precached: this map's mapconfig has h9_portal lines
new bool:g_watching = false;      // the PreThink forward and the portal task run (a portal exists)
new g_hud;
new g_menuid;

new g_near[MAX_PLAYERS + 1];      // 1 + the portal this player is at, 0 for none
new g_lastbtn[MAX_PLAYERS + 1];
new bool:g_inside[MAX_PLAYERS + 1];
new g_menu_p[MAX_PLAYERS + 1];    // 1 + the portal its confirm menu is about
new g_wait_until[MAX_PLAYERS + 1];
new Float:g_said_at[MAX_PLAYERS + 1];
new Float:g_find_at[MAX_PLAYERS + 1];

new g_claim[16];                  // the last link code, shown again until it runs out (for rcon)
new g_claim_until = 0;

new g_body[MAX_BODY];             // a call's JSON body, one byte per cell
new g_len;
new bool:g_full = false;
new g_line[256];
new g_value[1025];
new const HEX[] = "0123456789abcdef";

/*
 * Lets every h9p_ native be missing instead of refusing to load (ts_uplink's pattern): without
 * h9_presence this plugin stays inert. Set here: AMXX links natives before any plugin_init.
 */
public plugin_natives()
{
	register_library("h9_community");
	register_native("h9c_ready", "nat_ready");
	register_native("h9c_server_id", "nat_server_id");
	register_native("h9c_community", "nat_community");
	register_native("h9c_get", "nat_get");
	register_native("h9c_set", "nat_set");
	register_native("h9c_delete", "nat_delete");
	register_native("h9c_find", "nat_find");
	set_native_filter("native_filter");
}

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

public plugin_precache()
{
	h9vgui_precache();

	// The ring is precached only for a map whose mapconfig places a portal, and only when the
	// sprite is there: a precached file that is missing stops the map from loading.
	new map[64];
	get_mapname(map, charsmax(map));
	if (mapconfig_has_portals(map) && file_exists(RING, true))
	{
		precache_model(RING);
		g_ring_ok = true;
	}
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_prefix = register_cvar("h9_community_prefix", ".relay");
	g_cv_chat   = register_cvar("h9_community_chat", "1");
	g_cv_find   = register_cvar("h9_community_find", "1");
	g_cv_travel = register_cvar("h9_community_travel", "0");
	g_cv_wait   = register_cvar("h9_community_portal_wait", "10");

	register_clcmd("say", "hook_say");
	register_clcmd("say_team", "hook_say");
	register_srvcmd("h9_community_status", "srv_status");
	register_srvcmd("h9_community_claim", "srv_claim");
	register_srvcmd("h9_portal", "srv_portal");
	register_concmd("amx_h9_claim", "cmd_claim", ADMIN_RCON, " [new] - a code that links this server to a community on havoc9.org");
	register_concmd("amx_h9_portal_add", "cmd_portal_add", ADMIN_CFG, " <tag|server id> [radius] [walk 0|1] - a portal where you stand");
	register_concmd("amx_h9_portal_list", "cmd_portal_list", ADMIN_CFG, " - this map's portals, as h9_portal lines");

	g_menuid = register_menuid("H9 Portal");
	register_menucmd(g_menuid, (1 << 0) | (1 << 1) | (1 << 9), "menu_portal");
	h9vgui_init("h9c");
	g_hud = CreateHudSyncObj();

	g_max = get_maxplayers();
	if (g_max > MAX_PLAYERS)
	{
		g_max = MAX_PLAYERS;
	}
	load_since();
}

public plugin_cfg()
{
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_community.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
	if (!LibraryExists("h9_presence", LibType_Library))
	{
		g_have_presence = false;
		return;
	}
	// h9_presence may get its key at any time (enrollment): looked at every 10 seconds, here
	// and locally, until the poll runs; after that the poll keeps itself going.
	set_task(3.0, "task_wait", TASK_WAIT);
	set_task(10.0, "task_wait", TASK_WAIT, "", 0, "b");
}

public client_putinserver(id)
{
	forget_player(id);
}

public client_disconnected(id, bool:drop, message[], maxlen)
{
	forget_player(id);
}

forget_player(id)
{
	if (id < 1 || id > MAX_PLAYERS)
	{
		return;
	}
	g_near[id] = 0;
	g_lastbtn[id] = 0;
	g_inside[id] = false;
	g_menu_p[id] = 0;
	g_wait_until[id] = 0;
	g_said_at[id] = -100.0;
	g_find_at[id] = -100.0;
}

// ---- the long-poll ------------------------------------------------------------------------------

public task_wait()
{
	if (!g_have_presence)
	{
		return;
	}
	// a poll is never left hanging: its timeout answers it, and one that went out a minute and a
	// half ago without an answer is given up here
	if (g_polling && get_systime() - g_poll_at > 90)
	{
		g_polling = false;
	}
	if (g_polling || task_exists(TASK_POLL))
	{
		return;
	}
	if (h9p_ready())
	{
		poll();
	}
}

public task_poll()
{
	poll();
}

poll()
{
	if (g_polling || !g_have_presence)
	{
		return;
	}
	if (!h9p_ready())
	{
		// the key is gone or not approved yet: task_wait starts again once it is live
		g_linked = false;
		return;
	}
	body_begin();
	if (g_since >= 0)
	{
		app_raw(",^"since^":");
		app_num(g_since);
	}
	app_raw(",^"hold^":20}");
	new ud[UD_SIZE];
	if (post_signed("/server/poll", "on_poll", ud, 0, POLL_TIMEOUT))
	{
		g_polling = true;
		g_poll_at = get_systime();
	}
	else
	{
		poll_failed();
	}
}

schedule_poll(Float:seconds)
{
	remove_task(TASK_POLL);
	set_task(seconds, "task_poll", TASK_POLL);
}

poll_failed()
{
	g_linked = false;
	new i = g_fails < sizeof(WAITS) ? g_fails : sizeof(WAITS) - 1;
	g_fails++;
	schedule_poll(float(WAITS[i]));
}

public on_poll(EzHttpRequest:request_id)
{
	g_polling = false;
	new EzHttpErrorCode:err = ezhttp_get_error_code(request_id);
	if (err == EZH_REQUEST_CANCELLED)
	{
		return;
	}
	if (err != EZH_OK)
	{
		g_last_code = 0;
		copy(g_last_error, charsmax(g_last_error), "no answer");
		poll_failed();
		return;
	}
	new code = ezhttp_get_http_code(request_id);
	g_last_code = code;
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (code != 200 || root == EzInvalid_JSON)
	{
		g_last_error[0] = 0;
		if (root != EzInvalid_JSON)
		{
			json_text(root, "error", g_last_error, charsmax(g_last_error));
			ezjson_free(root);
		}
		if (code == 401 || code == 403)
		{
			// the key: refused, revoked, or waiting for approval
			g_linked = false;
			schedule_poll(60.0);
			return;
		}
		poll_failed();
		return;
	}
	g_last_error[0] = 0;
	g_fails = 0;
	g_linked = true;
	if (ezjson_object_has_value(root, "last", EzJSONNumber))
	{
		g_since = ezjson_object_get_number(root, "last");
	}
	save_since();
	if (ezjson_object_has_value(root, "report", EzJSONBoolean) && ezjson_object_get_bool(root, "report"))
	{
		h9p_report_soon();
	}
	read_community(root);
	read_servers(root);
	read_messages(root);
	ezjson_free(root);
	resolve_portals();
	schedule_poll(1.0);
}

read_community(EzJSON:root)
{
	g_cslug[0] = 0;
	g_cname[0] = 0;
	g_ctag[0] = 0;
	g_cchat = false;
	g_cro = false;
	g_cchatproof = true;
	g_cdataproof = true;
	new EzJSON:c = ezjson_object_get_value(root, "community");
	if (c != EzInvalid_JSON)
	{
		if (ezjson_get_type(c) == EzJSONObject)
		{
			json_text(c, "slug", g_cslug, charsmax(g_cslug));
			json_text(c, "name", g_cname, charsmax(g_cname));
			json_text(c, "tag", g_ctag, charsmax(g_ctag));
			g_cchat = ezjson_object_has_value(c, "chat", EzJSONBoolean) && ezjson_object_get_bool(c, "chat");
			g_cro = ezjson_object_has_value(c, "readOnly", EzJSONBoolean) && ezjson_object_get_bool(c, "readOnly");
			g_cchatproof = !ezjson_object_has_value(c, "chatProof", EzJSONBoolean) || ezjson_object_get_bool(c, "chatProof");
			g_cdataproof = !ezjson_object_has_value(c, "dataProof", EzJSONBoolean) || ezjson_object_get_bool(c, "dataProof");
			clean_name(g_cslug);
			clean_name(g_cname);
			clean_name(g_ctag);
		}
		ezjson_free(c);
	}
	note_community();
}

/** One line in the AMXX log when the server's community changes, and none otherwise. */
note_community()
{
	new before[40], now[40];
	get_localinfo("h9c_comm", before, charsmax(before));
	if (g_cslug[0])
	{
		copy(now, charsmax(now), g_cslug);
	}
	else
	{
		copy(now, charsmax(now), "-");
	}
	if (equal(before, now))
	{
		return;
	}
	set_localinfo("h9c_comm", now);
	if (g_cslug[0])
	{
		log_amx("[COMMUNITY] This server is in the community %s (%s) as [%s].", g_cname, g_cslug, g_ctag);
	}
	else if (before[0])
	{
		log_amx("[COMMUNITY] This server is in no community now.");
	}
}

read_servers(EzJSON:root)
{
	g_scount = 0;
	new EzJSON:list = ezjson_object_get_value(root, "servers");
	if (list == EzInvalid_JSON)
	{
		return;
	}
	if (ezjson_get_type(list) == EzJSONArray)
	{
		new n = ezjson_array_get_count(list);
		for (new i = 0; i < n && g_scount < MAX_SERVERS; i++)
		{
			new EzJSON:s = ezjson_array_get_value(list, i);
			if (s == EzInvalid_JSON)
			{
				continue;
			}
			new k = g_scount;
			json_text(s, "tag", g_stag[k], charsmax(g_stag[]));
			json_text(s, "serverId", g_sid[k], charsmax(g_sid[]));
			json_text(s, "address", g_saddr[k], charsmax(g_saddr[]));
			json_text(s, "name", g_sname[k], charsmax(g_sname[]));
			g_shumans[k] = -1;
			g_smax[k] = 0;
			if (ezjson_object_has_value(s, "humans", EzJSONNumber))
			{
				g_shumans[k] = ezjson_object_get_number(s, "humans");
			}
			if (ezjson_object_has_value(s, "max", EzJSONNumber))
			{
				g_smax[k] = ezjson_object_get_number(s, "max");
			}
			ezjson_free(s);
			clean_name(g_stag[k]);
			clean_name(g_sname[k]);
			if (!g_sname[k][0])
			{
				copy(g_sname[k], charsmax(g_sname[]), g_stag[k]);
			}
			if (address_ok(g_saddr[k]))
			{
				g_scount++;
			}
		}
	}
	ezjson_free(list);
}

read_messages(EzJSON:root)
{
	new EzJSON:list = ezjson_object_get_value(root, "messages");
	if (list == EzInvalid_JSON)
	{
		return;
	}
	if (ezjson_get_type(list) == EzJSONArray)
	{
		new n = ezjson_array_get_count(list);
		new kind[16];
		for (new i = 0; i < n && i < 50; i++)
		{
			new EzJSON:m = ezjson_array_get_value(list, i);
			if (m == EzInvalid_JSON)
			{
				continue;
			}
			json_text(m, "kind", kind, charsmax(kind));
			json_text(m, "line", g_line, charsmax(g_line));
			ezjson_free(m);
			clean_line(g_line);
			if (!g_line[0])
			{
				continue;
			}
			// announcements always show; the community's chat as h9_community_chat says
			if (equal(kind, "announce") || get_pcvar_num(g_cv_chat))
			{
				client_print(0, print_chat, "%s", g_line);
			}
		}
	}
	ezjson_free(list);
}

/** The last message seen, with when: a map change carries it on, a restart starts from now. */
load_since()
{
	new v[48], a[16], b[16];
	get_localinfo("h9c_since", v, charsmax(v));
	parse(v, a, charsmax(a), b, charsmax(b));
	if (a[0] && b[0] && get_systime() - str_to_num(b) < 120)
	{
		g_since = str_to_num(a);
	}
}

save_since()
{
	if (g_since < 0)
	{
		return;
	}
	new v[48];
	formatex(v, charsmax(v), "%d %d", g_since, get_systime());
	set_localinfo("h9c_since", v);
}

// ---- what players type ----------------------------------------------------------------------------

public hook_say(id)
{
	if (!g_have_presence || id < 1 || id > g_max || is_user_bot(id))
	{
		return PLUGIN_CONTINUE;
	}
	new args[192];
	read_args(args, charsmax(args));
	remove_quotes(args);
	trim(args);
	if (!args[0])
	{
		return PLUGIN_CONTINUE;
	}

	new prefix[24];
	get_pcvar_string(g_cv_prefix, prefix, charsmax(prefix));
	trim(prefix);
	new pl = strlen(prefix);
	if (pl && equali(args, prefix, pl) && (args[pl] == ' ' || args[pl] == 0))
	{
		relay(id, args[pl], prefix);
		return PLUGIN_HANDLED;
	}

	if (get_pcvar_num(g_cv_find))
	{
		new word[16], rest[64];
		strtok(args, word, charsmax(word), rest, charsmax(rest), ' ');
		if (equali(word, "/find") || equali(word, "/where") || equali(word, ".find") || equali(word, ".where"))
		{
			trim(rest);
			find_for(id, rest, word);
			return PLUGIN_HANDLED;
		}
	}
	return PLUGIN_CONTINUE;
}

relay(id, const text[], const prefix[])
{
	new t[160];
	copy(t, charsmax(t), text);
	trim(t);
	if (!t[0])
	{
		client_print(id, print_chat, "[H9] %s <text> -- says it on every server of this community and on its web page.", prefix);
		return;
	}
	if (!h9p_ready() || !g_linked)
	{
		client_print(id, print_chat, "[H9] Community chat is not on here.");
		return;
	}
	if (!g_cslug[0])
	{
		client_print(id, print_chat, "[H9] This server is in no community.");
		return;
	}
	if (!g_cchat || !get_pcvar_num(g_cv_chat))
	{
		client_print(id, print_chat, "[H9] Community chat is off here.");
		return;
	}
	if (h9p_muted(id))
	{
		client_print(id, print_chat, "[H9] You are muted on this server's community.");
		return;
	}
	new Float:now = get_gametime();
	if (now - g_said_at[id] < SAY_GAP)
	{
		client_print(id, print_chat, "[H9] One line every %d seconds.", floatround(SAY_GAP));
		return;
	}
	new cid[40];
	get_user_info(id, "h9_clientid", cid, charsmax(cid));
	if (!cid_ok(cid))
	{
		client_print(id, print_chat, "[H9] Community chat needs a havoc9.org account and a game that sends its H9 id.");
		return;
	}
	// a line goes out for a game h9web has proven holds the account's player id; with the proof switched off by the
	// community's owner, for any game that announces an account's id
	if (g_cchatproof && h9p_account(id) <= 0)
	{
		tell_unproven(id);
		return;
	}
	// an id two games announce is a copy on one of them: only the game h9web has proven speaks
	if (cid_shared(id, cid) && h9p_account(id) <= 0)
	{
		client_print(id, print_chat, "[H9] Another player here announces the same H9 id as you; community chat waits until only one game does.");
		return;
	}
	g_said_at[id] = now;
	body_begin();
	app_raw(",^"id^":");
	app_str(cid);
	app_raw(",^"text^":");
	app_str(t);
	app_byte('}');
	new ud[UD_SIZE];
	ud[UD_KIND] = K_CHAT;
	ud[UD_ID] = id;
	ud[UD_USERID] = get_user_userid(id);
	ud[UD_FWD] = -1;
	if (!post_signed("/server/chat", "on_chat", ud, UD_SIZE, CALL_TIMEOUT))
	{
		client_print(id, print_chat, "[H9] Community chat is not on here.");
	}
}

/** Why .relay is not for this game, and what to do: link it, and wait for the proof; or the server asks for none. */
tell_unproven(id)
{
	if (get_cvar_num("h9_presence_challenge") == 0 && get_cvar_num("h9_require_account") != 1)
	{
		client_print(id, print_chat, "[H9] Community chat needs players havoc9.org has proven, and this server asks no game to prove its account (h9_presence_challenge 0).");
	}
	else
	{
		client_print(id, print_chat, "[H9] Community chat needs a game havoc9.org has proven is yours: link it to your account (.link) and wait a few seconds after joining.");
	}
}

public on_chat(EzHttpRequest:request_id)
{
	new ud[UD_SIZE];
	ezhttp_get_user_data(request_id, ud);
	new id = player_of(ud);
	new EzHttpErrorCode:err = ezhttp_get_error_code(request_id);
	if (err == EZH_REQUEST_CANCELLED)
	{
		return;
	}
	if (err != EZH_OK)
	{
		if (id)
		{
			client_print(id, print_chat, "[H9] havoc9.org did not answer; your line was not sent.");
		}
		return;
	}
	new code = ezhttp_get_http_code(request_id);
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	new reason[32];
	reason[0] = 0;
	g_line[0] = 0;
	if (root != EzInvalid_JSON)
	{
		json_text(root, "line", g_line, charsmax(g_line));
		json_text(root, "error", reason, charsmax(reason));
		ezjson_free(root);
	}
	if (code == 200)
	{
		// the line as the community's other servers show it, for everyone here
		clean_line(g_line);
		if (g_line[0])
		{
			client_print(0, print_chat, "%s", g_line);
		}
		return;
	}
	if (!id)
	{
		return;
	}
	if (equal(reason, "not_an_account"))
	{
		client_print(id, print_chat, "[H9] Community chat needs a havoc9.org account linked to your game.");
	}
	else if (equal(reason, "not_here"))
	{
		client_print(id, print_chat, "[H9] havoc9.org has not seen you on this server yet; try again in a few seconds.");
	}
	else if (equal(reason, "muted"))
	{
		client_print(id, print_chat, "[H9] You are muted in this community.");
	}
	else if (equal(reason, "unverified"))
	{
		client_print(id, print_chat, "[H9] This community's chat needs a game that proves your H9 id.");
	}
	else if (equal(reason, "chat_off") || equal(reason, "no_community"))
	{
		client_print(id, print_chat, "[H9] Community chat is off here.");
	}
	else if (code == 429)
	{
		client_print(id, print_chat, "[H9] Too many lines; wait a few seconds.");
	}
	else
	{
		client_print(id, print_chat, "[H9] Your line was not sent (%d).", code);
	}
}

find_for(id, const name[], const word[])
{
	new q[40];
	copy(q, charsmax(q), name);
	clean_name(q);
	trim(q);
	if (!q[0])
	{
		client_print(id, print_chat, "[H9] %s <name> -- where a havoc9.org player is.", word);
		return;
	}
	if (!h9p_ready() || !g_linked)
	{
		client_print(id, print_chat, "[H9] Finding players needs this server enrolled with havoc9.org.");
		return;
	}
	new Float:now = get_gametime();
	if (now - g_find_at[id] < FIND_GAP)
	{
		client_print(id, print_chat, "[H9] One search every %d seconds.", floatround(FIND_GAP));
		return;
	}
	g_find_at[id] = now;
	if (!send_find(q, id, -1, 0))
	{
		client_print(id, print_chat, "[H9] Finding players is not on here.");
	}
}

bool:send_find(const q[], id, fwd, data)
{
	body_begin();
	app_raw(",^"q^":");
	app_str(q);
	// who asks: h9web shows a private community's servers only to its members, so only a game
	// h9web has proven is named; an announced id could be anyone's
	if (id)
	{
		new cid[40];
		get_user_info(id, "h9_clientid", cid, charsmax(cid));
		if (cid_ok(cid) && h9p_account(id) > 0)
		{
			app_raw(",^"id^":");
			app_str(cid);
		}
	}
	app_byte('}');
	new ud[UD_SIZE];
	ud[UD_KIND] = K_FIND;
	ud[UD_ID] = id;
	ud[UD_USERID] = id ? get_user_userid(id) : 0;
	ud[UD_FWD] = fwd;
	ud[UD_DATA] = data;
	ud_set_text(ud, q);
	return post_signed("/server/find", "on_find", ud, UD_SIZE, CALL_TIMEOUT);
}

public on_find(EzHttpRequest:request_id)
{
	new ud[UD_SIZE];
	ezhttp_get_user_data(request_id, ud);
	new fwd = ud[UD_FWD];
	if (fwd >= 0)
	{
		g_calls--;
	}
	new EzHttpErrorCode:err = ezhttp_get_error_code(request_id);
	if (err == EZH_REQUEST_CANCELLED)
	{
		if (fwd >= 0)
		{
			DestroyForward(fwd);
		}
		return;
	}
	new q[40];
	ud_get_text(ud, q, charsmax(q));
	new id = player_of(ud);
	new status = H9C_ERROR, count = 0;
	new EzJSON:root = EzInvalid_JSON;
	new EzJSON:list = EzInvalid_JSON;
	if (err == EZH_OK)
	{
		new code = ezhttp_get_http_code(request_id);
		root = ezhttp_parse_json_response(request_id);
		if (code == 200 && root != EzInvalid_JSON)
		{
			list = ezjson_object_get_value(root, "results");
			if (list != EzInvalid_JSON && ezjson_get_type(list) == EzJSONArray)
			{
				count = ezjson_array_get_count(list);
				status = count ? H9C_OK : H9C_NOT_FOUND;
			}
		}
		else
		{
			status = status_of(code, root);
		}
	}
	if (fwd < 0 && id && status != H9C_OK)
	{
		if (status == H9C_NOT_FOUND)
		{
			client_print(id, print_chat, "[H9] No havoc9.org account is called %s.", q);
		}
		else if (status == H9C_LIMIT)
		{
			client_print(id, print_chat, "[H9] Too many searches here; try again in a minute.");
		}
		else
		{
			client_print(id, print_chat, "[H9] havoc9.org did not answer; try again later.");
		}
	}
	new own[48], username[40], where[12], server[64], address[24], ret;
	h9p_server(own, charsmax(own));
	for (new i = 0; i < count; i++)
	{
		new EzJSON:r = ezjson_array_get_value(list, i);
		if (r == EzInvalid_JSON)
		{
			continue;
		}
		json_text(r, "username", username, charsmax(username));
		json_text(r, "state", where, charsmax(where));
		json_text(r, "server", server, charsmax(server));
		json_text(r, "address", address, charsmax(address));
		new same = ezjson_object_has_value(r, "community", EzJSONBoolean) && ezjson_object_get_bool(r, "community");
		ezjson_free(r);
		clean_name(username);
		clean_name(where);
		clean_name(server);
		if (!address_ok(address))
		{
			address[0] = 0;
		}
		if (fwd >= 0)
		{
			ExecuteForward(fwd, ret, H9C_OK, i, count, username, where, server, address, same, ud[UD_DATA]);
		}
		else if (id && i < 3)
		{
			tell_place(id, username, where, server, address, own);
		}
	}
	if (fwd >= 0)
	{
		if (!count)
		{
			ExecuteForward(fwd, ret, status, 0, 0, "", "", "", "", 0, ud[UD_DATA]);
		}
		DestroyForward(fwd);
	}
	if (list != EzInvalid_JSON)
	{
		ezjson_free(list);
	}
	if (root != EzInvalid_JSON)
	{
		ezjson_free(root);
	}
}

tell_place(id, const username[], const where[], const server[], const address[], const own[])
{
	if (equal(where, "game"))
	{
		if (address[0] && equal(address, own))
		{
			formatex(g_line, charsmax(g_line), "[H9] %s is here.", username);
		}
		else if (address[0] && server[0])
		{
			formatex(g_line, charsmax(g_line), "[H9] %s is on %s -- to join, type in the console: connect %s", username, server, address);
		}
		else if (address[0])
		{
			formatex(g_line, charsmax(g_line), "[H9] %s is in game -- to join, type in the console: connect %s", username, address);
		}
		else
		{
			formatex(g_line, charsmax(g_line), "[H9] %s is in game.", username);
		}
	}
	else if (equal(where, "web"))
	{
		formatex(g_line, charsmax(g_line), "[H9] %s is in the H9 web client.", username);
	}
	else if (equal(where, "site"))
	{
		formatex(g_line, charsmax(g_line), "[H9] %s is on havoc9.org.", username);
	}
	else
	{
		formatex(g_line, charsmax(g_line), "[H9] %s is offline.", username);
	}
	client_print(id, print_chat, "%s", g_line);
	client_print(id, print_console, "%s", g_line);
}

// ---- natives (include/h9_community.inc) ---------------------------------------------------------

public nat_ready(plugin, params)
{
	return g_have_presence && g_linked && g_cslug[0] != 0;
}

public nat_server_id(plugin, params)
{
	new sid[16];
	sid[0] = 0;
	if (g_have_presence)
	{
		h9p_server_id(sid, charsmax(sid));
	}
	set_string(1, sid, get_param(2));
	return sid[0] != 0;
}

public nat_community(plugin, params)
{
	set_string(1, g_cslug, get_param(2));
	return g_cslug[0] != 0;
}

public nat_get(plugin, params)
{
	new key[40], cb[64];
	get_string(2, key, charsmax(key));
	get_string(3, cb, charsmax(cb));
	return data_call(plugin, K_GET, get_param(1), key, "", false, -1, cb, get_param(4));
}

public nat_set(plugin, params)
{
	new key[40], cb[64];
	get_string(2, key, charsmax(key));
	if (get_string(3, g_value, charsmax(g_value)) >= charsmax(g_value))
	{
		return 0;
	}
	get_string(5, cb, charsmax(cb));
	return data_call(plugin, K_SET, get_param(1), key, g_value, false, get_param(4), cb, get_param(6));
}

public nat_delete(plugin, params)
{
	new key[40], cb[64];
	get_string(2, key, charsmax(key));
	get_string(4, cb, charsmax(cb));
	return data_call(plugin, K_SET, get_param(1), key, "", true, get_param(3), cb, get_param(5));
}

public nat_find(plugin, params)
{
	new q[40], cb[64];
	get_string(1, q, charsmax(q));
	get_string(2, cb, charsmax(cb));
	clean_name(q);
	trim(q);
	if (!q[0] || !cb[0] || !g_have_presence || !h9p_ready() || g_calls >= MAX_CALLS)
	{
		return 0;
	}
	if (get_func_id(cb, plugin) < 0)
	{
		log_error(AMX_ERR_NATIVE, "[H9] h9c_find: no public function %s", cb);
		return 0;
	}
	new fwd = CreateOneForward(plugin, cb, FP_CELL, FP_CELL, FP_CELL, FP_STRING, FP_STRING, FP_STRING, FP_STRING, FP_CELL, FP_CELL);
	if (fwd < 0)
	{
		return 0;
	}
	if (!send_find(q, 0, fwd, get_param(3)))
	{
		DestroyForward(fwd);
		return 0;
	}
	g_calls++;
	return 1;
}

/** h9c_get, h9c_set and h9c_delete: one signed call about a player here. */
data_call(plugin, kind, id, const key[], const value[], bool:remove, version, const cb[], data)
{
	if (!g_have_presence || !h9p_ready() || g_calls >= MAX_CALLS || !key_ok(key))
	{
		return 0;
	}
	if (id < 1 || id > g_max || !is_user_connected(id) || is_user_bot(id) || is_user_hltv(id))
	{
		return 0;
	}
	if (kind == K_GET && !cb[0])
	{
		return 0;
	}
	new cid[40];
	get_user_info(id, "h9_clientid", cid, charsmax(cid));
	if (!cid_ok(cid))
	{
		return 0;
	}
	// the player's game must be one h9web has proven holds the account's player id, unless the community's owner
	// switched that off: the announced id alone is anyone's, and a plugin that gives perks by these values would be fooled
	if (g_cslug[0] && g_cdataproof && h9p_account(id) <= 0)
	{
		return 0;
	}
	new fwd = -1;
	if (cb[0])
	{
		if (get_func_id(cb, plugin) < 0)
		{
			log_error(AMX_ERR_NATIVE, "[H9] h9c_get/h9c_set: no public function %s", cb);
			return 0;
		}
		fwd = CreateOneForward(plugin, cb, FP_CELL, FP_CELL, FP_STRING, FP_STRING, FP_CELL, FP_CELL);
		if (fwd < 0)
		{
			return 0;
		}
	}
	body_begin();
	app_raw(",^"id^":");
	app_str(cid);
	new path[24];
	if (kind == K_GET)
	{
		app_raw(",^"keys^":[");
		app_str(key);
		app_byte(']');
		copy(path, charsmax(path), "/server/data/get");
	}
	else
	{
		app_raw(",^"key^":");
		app_str(key);
		app_raw(",^"value^":");
		if (remove)
		{
			app_raw("null");
		}
		else
		{
			app_str(value);
		}
		if (version >= 0)
		{
			app_raw(",^"version^":");
			app_num(version);
		}
		copy(path, charsmax(path), "/server/data/set");
	}
	app_byte('}');
	new ud[UD_SIZE];
	ud[UD_KIND] = kind;
	ud[UD_ID] = id;
	ud[UD_USERID] = get_user_userid(id);
	ud[UD_FWD] = fwd;
	ud[UD_DATA] = data;
	ud_set_text(ud, key);
	if (!post_signed(path, "on_data", ud, UD_SIZE, CALL_TIMEOUT))
	{
		if (fwd >= 0)
		{
			DestroyForward(fwd);
		}
		return 0;
	}
	g_calls++;
	return 1;
}

public on_data(EzHttpRequest:request_id)
{
	g_calls--;
	new ud[UD_SIZE];
	ezhttp_get_user_data(request_id, ud);
	new fwd = ud[UD_FWD];
	new EzHttpErrorCode:err = ezhttp_get_error_code(request_id);
	if (err == EZH_REQUEST_CANCELLED)
	{
		if (fwd >= 0)
		{
			DestroyForward(fwd);
		}
		return;
	}
	new key[40];
	ud_get_text(ud, key, charsmax(key));
	new id = player_of(ud);
	new status = H9C_ERROR, version = 0;
	g_value[0] = 0;
	if (err == EZH_OK)
	{
		new code = ezhttp_get_http_code(request_id);
		new EzJSON:root = ezhttp_parse_json_response(request_id);
		if (code == 200 && root != EzInvalid_JSON)
		{
			if (ud[UD_KIND] == K_GET)
			{
				new EzJSON:values = ezjson_object_get_value(root, "values");
				if (values != EzInvalid_JSON)
				{
					if (ezjson_get_type(values) == EzJSONObject && ezjson_object_has_value(values, key, EzJSONObject))
					{
						new EzJSON:v = ezjson_object_get_value(values, key);
						if (v != EzInvalid_JSON)
						{
							if (ezjson_object_has_value(v, "value", EzJSONString))
							{
								ezjson_object_get_string(v, "value", g_value, charsmax(g_value));
								status = H9C_OK;
							}
							else
							{
								status = H9C_NOT_FOUND;
							}
							if (ezjson_object_has_value(v, "version", EzJSONNumber))
							{
								version = ezjson_object_get_number(v, "version");
							}
							ezjson_free(v);
						}
					}
					ezjson_free(values);
				}
			}
			else
			{
				status = H9C_OK;
				if (ezjson_object_has_value(root, "version", EzJSONNumber))
				{
					version = ezjson_object_get_number(root, "version");
				}
			}
		}
		else
		{
			status = status_of(code, root);
			if (status == H9C_CONFLICT && root != EzInvalid_JSON)
			{
				json_text(root, "value", g_value, charsmax(g_value));
				if (ezjson_object_has_value(root, "version", EzJSONNumber))
				{
					version = ezjson_object_get_number(root, "version");
				}
			}
		}
		if (root != EzInvalid_JSON)
		{
			ezjson_free(root);
		}
	}
	if (fwd >= 0)
	{
		new ret;
		ExecuteForward(fwd, ret, id, status, key, g_value, version, ud[UD_DATA]);
		DestroyForward(fwd);
	}
}

/** What h9web's refusal means for the calling plugin. */
status_of(code, EzJSON:root)
{
	new err[32];
	err[0] = 0;
	if (root != EzInvalid_JSON)
	{
		json_text(root, "error", err, charsmax(err));
	}
	if (code == 409 && equal(err, "conflict"))
	{
		return H9C_CONFLICT;
	}
	if (code == 403)
	{
		if (equal(err, "not_an_account"))
		{
			return H9C_NO_ACCOUNT;
		}
		if (equal(err, "not_here"))
		{
			return H9C_NOT_HERE;
		}
		if (equal(err, "no_key"))
		{
			return H9C_ERROR;
		}
		return H9C_DENIED;
	}
	if (code == 404)
	{
		return H9C_NOT_FOUND;
	}
	if (code == 413 || code == 429 || code == 507)
	{
		return H9C_LIMIT;
	}
	return H9C_ERROR;
}

/** The player a call was for, if the slot is still theirs; else 0. */
player_of(const ud[])
{
	new id = ud[UD_ID];
	if (id >= 1 && id <= g_max && is_user_connected(id) && get_user_userid(id) == ud[UD_USERID])
	{
		return id;
	}
	return 0;
}

ud_set_text(ud[], const text[])
{
	new i;
	for (i = 0; i < 32 && text[i]; i++)
	{
		ud[UD_TEXT + i] = text[i];
	}
	ud[UD_TEXT + i] = 0;
}

ud_get_text(const ud[], out[], len)
{
	new i;
	for (i = 0; i < 32 && i < len && ud[UD_TEXT + i]; i++)
	{
		out[i] = ud[UD_TEXT + i];
	}
	out[i] = 0;
}

// ---- linking this server to a community -----------------------------------------------------------

public srv_claim()
{
	new arg[8];
	read_argv(1, arg, charsmax(arg));
	claim_for(0, equali(arg, "new") != 0);
	return PLUGIN_HANDLED;
}

public cmd_claim(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new arg[8];
	read_argv(1, arg, charsmax(arg));
	claim_for(id, equali(arg, "new") != 0);
	return PLUGIN_HANDLED;
}

/**
 * The code is shown again while it lasts: an answer that comes after an rcon command has
 * returned goes to the server's own console only, so running the command again shows it.
 */
claim_for(id, bool:fresh)
{
	if (!g_have_presence || !h9p_ready())
	{
		console_print(id, "[H9] This server has no live havoc9.org key yet (h9_presence_status says why).");
		return;
	}
	if (!fresh && g_claim[0] && get_systime() < g_claim_until)
	{
		show_claim(id);
		return;
	}
	body_begin();
	app_byte('}');
	new ud[UD_SIZE];
	ud[UD_KIND] = K_CLAIM;
	ud[UD_ID] = id;
	ud[UD_USERID] = id ? get_user_userid(id) : 0;
	ud[UD_FWD] = -1;
	if (post_signed("/server/claim", "on_claim", ud, UD_SIZE, CALL_TIMEOUT))
	{
		console_print(id, "[H9] Asking havoc9.org for a link code... (over rcon, run the command again in a few seconds to see it)");
	}
	else
	{
		console_print(id, "[H9] Could not ask havoc9.org for a link code.");
	}
}

public on_claim(EzHttpRequest:request_id)
{
	new ud[UD_SIZE];
	ezhttp_get_user_data(request_id, ud);
	new EzHttpErrorCode:err = ezhttp_get_error_code(request_id);
	if (err == EZH_REQUEST_CANCELLED)
	{
		return;
	}
	new id = ud[UD_ID];
	if (id && !player_of(ud))
	{
		id = 0;
	}
	if (err != EZH_OK || ezhttp_get_http_code(request_id) != 200)
	{
		console_print(id, "[H9] havoc9.org gave no link code; try again in a minute.");
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		console_print(id, "[H9] havoc9.org gave no link code; try again in a minute.");
		return;
	}
	new code[16], minutes = 15;
	json_text(root, "code", code, charsmax(code));
	if (ezjson_object_has_value(root, "minutes", EzJSONNumber))
	{
		minutes = ezjson_object_get_number(root, "minutes");
	}
	ezjson_free(root);
	if (!claim_ok(code))
	{
		console_print(id, "[H9] havoc9.org gave no link code; try again in a minute.");
		return;
	}
	copy(g_claim, charsmax(g_claim), code);
	g_claim_until = get_systime() + minutes * 60;
	show_claim(id);
}

show_claim(id)
{
	new left = (g_claim_until - get_systime()) / 60;
	if (left < 1)
	{
		left = 1;
	}
	console_print(id, "[H9] Link code: %s (good for %d more minutes, once).", g_claim, left);
	console_print(id, "[H9] On havoc9.org/community/, open your community, choose Link a server, and enter it with a tag for this server.");
}

/** xxxx-xxxx of h9web's code alphabet. */
bool:claim_ok(const s[])
{
	if (strlen(s) != 9 || s[4] != '-')
	{
		return false;
	}
	for (new i = 0; i < 9; i++)
	{
		if (i == 4)
		{
			continue;
		}
		if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '2' && s[i] <= '9')))
		{
			return false;
		}
	}
	return true;
}

// ---- status ---------------------------------------------------------------------------------------

public srv_status()
{
	new sid[16];
	copy(sid, charsmax(sid), "none");
	new bool:live = false;
	if (g_have_presence)
	{
		live = h9p_ready() != 0;
		if (!h9p_server_id(sid, charsmax(sid)))
		{
			copy(sid, charsmax(sid), "none");
		}
	}
	server_print("[H9] h9_community %s: h9_presence %s; key %s; server id %s", VERSION,
		g_have_presence ? "loaded" : "NOT LOADED", live ? "live" : "not live", sid);
	if (g_linked)
	{
		server_print("[H9] havoc9.org: answering (last message %d)", g_since);
	}
	else
	{
		server_print("[H9] havoc9.org: not answering (HTTP %d %s; %d failures in a row)", g_last_code, g_last_error, g_fails);
	}
	if (g_cslug[0])
	{
		server_print("[H9] community: %s (%s) as [%s]; chat %s here; %s", g_cname, g_cslug, g_ctag,
			(g_cchat && get_pcvar_num(g_cv_chat)) ? "on" : "off", g_cro ? "read-only" : "may write data");
		server_print("[H9] proven players needed for: chat %s, data %s", g_cchatproof ? "yes" : "no (the owner switched it off)", g_cdataproof ? "yes" : "no (the owner switched it off)");
	}
	else
	{
		server_print("[H9] community: none (h9_community_claim gives a code to link this server)");
	}
	new shown = 0;
	for (new p = 0; p < g_pcount; p++)
	{
		if (g_pto[p] >= 0)
		{
			shown++;
		}
	}
	server_print("[H9] community servers: %d; portals: %d (%d leading somewhere; ring %s); calls in flight: %d",
		g_scount, g_pcount, shown, g_ring_ok ? "precached" : "none", g_calls);
	return PLUGIN_HANDLED;
}

// ---- portals ----------------------------------------------------------------------------------------

/** h9_portal <tag|server id> <x> <y> <z> [yaw] [radius] [walk 0|1], from a mapconfig. */
public srv_portal()
{
	if (read_argc() < 5)
	{
		server_print("[H9] usage: h9_portal <tag|server id> <x> <y> <z> [yaw] [radius] [walk 0|1]");
		return PLUGIN_HANDLED;
	}
	new dest[24], a[16];
	read_argv(1, dest, charsmax(dest));
	new Float:org[3];
	read_argv(2, a, charsmax(a));
	org[0] = str_to_float(a);
	read_argv(3, a, charsmax(a));
	org[1] = str_to_float(a);
	read_argv(4, a, charsmax(a));
	org[2] = str_to_float(a);
	new Float:yaw = 0.0, Float:rad = 48.0, bool:walk = false;
	if (read_argc() > 5)
	{
		read_argv(5, a, charsmax(a));
		yaw = str_to_float(a);
	}
	if (read_argc() > 6)
	{
		read_argv(6, a, charsmax(a));
		rad = str_to_float(a);
	}
	if (read_argc() > 7)
	{
		read_argv(7, a, charsmax(a));
		walk = str_to_num(a) != 0;
	}
	if (add_portal(dest, org, yaw, rad, walk) < 0)
	{
		server_print("[H9] h9_portal %s: not placed (a tag or server id of 1 to 23 letters, digits, space _ . -; at most %d portals).", dest, MAX_PORTALS);
	}
	return PLUGIN_HANDLED;
}

public cmd_portal_add(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	if (!id || !is_user_alive(id))
	{
		console_print(id, "[H9] Stand where the portal goes, alive, and run it from the game.");
		return PLUGIN_HANDLED;
	}
	new dest[24], a[16];
	read_argv(1, dest, charsmax(dest));
	new Float:rad = 48.0, bool:walk = false;
	if (read_argc() > 2)
	{
		read_argv(2, a, charsmax(a));
		rad = str_to_float(a);
	}
	if (read_argc() > 3)
	{
		read_argv(3, a, charsmax(a));
		walk = str_to_num(a) != 0;
	}
	new Float:org[3], Float:ang[3];
	pev(id, pev_origin, org);
	pev(id, pev_v_angle, ang);
	new p = add_portal(dest, org, ang[1], rad, walk);
	if (p < 0)
	{
		console_print(id, "[H9] Not placed: a tag or server id of 1 to 23 letters, digits, space _ . -, and at most %d portals a map.", MAX_PORTALS);
		return PLUGIN_HANDLED;
	}
	new map[64];
	get_mapname(map, charsmax(map));
	console_print(id, "[H9] Portal %d. To keep it, put this line in ts/mapconfigs/%s.cfg:", p + 1, map);
	portal_line(id, p);
	if (!g_ring_ok)
	{
		console_print(id, "[H9] Its ring shows once this map's mapconfig has an h9_portal line, from the next map change.");
	}
	if (g_pto[p] < 0)
	{
		console_print(id, "[H9] %s is none of this community's other servers yet: the portal stays hidden until it is.", dest);
	}
	return PLUGIN_HANDLED;
}

public cmd_portal_list(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!g_pcount)
	{
		console_print(id, "[H9] No portals on this map.");
	}
	for (new p = 0; p < g_pcount; p++)
	{
		portal_line(id, p);
	}
	return PLUGIN_HANDLED;
}

portal_line(id, p)
{
	console_print(id, "h9_portal ^"%s^" %.0f %.0f %.0f %.0f %.0f %d", g_pdest[p], g_porg[p][0], g_porg[p][1], g_porg[p][2],
		g_pyaw[p], g_prad[p], g_pwalk[p] ? 1 : 0);
}

/** A portal; the same destination at the same place again is the one already there. */
add_portal(const dest[], const Float:org[3], Float:yaw, Float:rad, bool:walk)
{
	if (!dest_ok(dest))
	{
		return -1;
	}
	for (new p = 0; p < g_pcount; p++)
	{
		if (equali(g_pdest[p], dest) && get_distance_f(g_porg[p], org) < 1.0)
		{
			return p;
		}
	}
	if (g_pcount >= MAX_PORTALS)
	{
		return -1;
	}
	if (rad < 16.0)
	{
		rad = 16.0;
	}
	else if (rad > 256.0)
	{
		rad = 256.0;
	}
	new p = g_pcount;
	copy(g_pdest[p], charsmax(g_pdest[]), dest);
	g_porg[p][0] = org[0];
	g_porg[p][1] = org[1];
	g_porg[p][2] = org[2];
	g_pyaw[p] = yaw;
	g_prad[p] = rad;
	g_pwalk[p] = walk;
	g_pent[p] = 0;
	g_pto[p] = -1;
	g_pcount++;
	make_ring(p);
	resolve_portals();
	if (!g_watching)
	{
		g_watching = true;
		register_forward(FM_PlayerPreThink, "fw_prethink");
		set_task(0.25, "task_portals", TASK_PORTALS, "", 0, "b");
	}
	return p;
}

/** An upright ring facing along the portal's yaw, standing on the floor under a player's origin. */
make_ring(p)
{
	if (!g_ring_ok)
	{
		return;
	}
	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (ent <= 0)
	{
		return;
	}
	set_pev(ent, pev_classname, "h9_portal");
	engfunc(EngFunc_SetModel, ent, RING);
	set_pev(ent, pev_movetype, 0);       // MOVETYPE_NONE
	set_pev(ent, pev_solid, 0);          // SOLID_NOT
	set_pev(ent, pev_rendermode, 5);     // kRenderTransAdd
	set_pev(ent, pev_renderamt, 230.0);
	new Float:ang[3];
	ang[0] = 0.0;
	ang[1] = g_pyaw[p];
	ang[2] = 0.0;
	set_pev(ent, pev_angles, ang);
	set_pev(ent, pev_scale, g_prad[p] / RING_PX);
	new Float:o[3];
	o[0] = g_porg[p][0];
	o[1] = g_porg[p][1];
	o[2] = g_porg[p][2] + g_prad[p] - 34.0;   // a standing player's origin is 36 above the floor
	engfunc(EngFunc_SetOrigin, ent, o);
	set_pev(ent, pev_effects, EF_NODRAW);
	g_pent[p] = ent;
}

/** Which of the community's servers each portal leads to; a portal to none (or here) is hidden. */
resolve_portals()
{
	new own[48];
	own[0] = 0;
	if (g_have_presence)
	{
		h9p_server(own, charsmax(own));
	}
	for (new p = 0; p < g_pcount; p++)
	{
		new to = -1;
		for (new s = 0; s < g_scount; s++)
		{
			if ((equali(g_stag[s], g_pdest[p]) || equal(g_sid[s], g_pdest[p])) && !equal(g_saddr[s], own))
			{
				to = s;
				break;
			}
		}
		g_pto[p] = to;
		if (g_pent[p] > 0 && pev_valid(g_pent[p]))
		{
			set_pev(g_pent[p], pev_effects, to >= 0 ? 0 : EF_NODRAW);
		}
	}
}

public task_portals()
{
	new Float:o[3];
	for (new id = 1; id <= g_max; id++)
	{
		if (!is_user_alive(id) || is_user_bot(id))
		{
			g_near[id] = 0;
			g_inside[id] = false;
			continue;
		}
		pev(id, pev_origin, o);
		new best = -1;
		new Float:bestd = 100000.0;
		for (new p = 0; p < g_pcount; p++)
		{
			if (g_pto[p] < 0 || floatabs(o[2] - g_porg[p][2]) > 72.0)
			{
				continue;
			}
			new Float:dx = o[0] - g_porg[p][0];
			new Float:dy = o[1] - g_porg[p][1];
			new Float:d = floatsqroot(dx * dx + dy * dy);
			if (d <= g_prad[p] + NEAR && d < bestd)
			{
				best = p;
				bestd = d;
			}
		}
		if (best < 0)
		{
			g_near[id] = 0;
			g_inside[id] = false;
			continue;
		}
		if (g_near[id] != best + 1)
		{
			// arriving with E already held is not a press
			g_near[id] = best + 1;
			g_lastbtn[id] = pev(id, pev_button);
		}
		show_label(id, best);
		if (g_pwalk[best] && bestd <= g_prad[best])
		{
			if (!g_inside[id])
			{
				g_inside[id] = true;
				offer(id, best);
			}
		}
		else
		{
			g_inside[id] = false;
		}
	}
}

show_label(id, p)
{
	new s = g_pto[p];
	if (s < 0)
	{
		return;
	}
	if (g_shumans[s] < 0)
	{
		formatex(g_line, charsmax(g_line), "%s^n(no word from it lately)^n%s", g_sname[s],
			g_pwalk[p] ? "Walk in or press E" : "Press E");
	}
	else
	{
		formatex(g_line, charsmax(g_line), "%s^n%d / %d players^n%s", g_sname[s], g_shumans[s], g_smax[s],
			g_pwalk[p] ? "Walk in or press E to travel" : "Press E to travel");
	}
	set_hudmessage(110, 200, 255, -1.0, 0.62, 0, 0.0, 0.4, 0.0, 0.1, -1);
	ShowSyncHudMsg(id, g_hud, "%s", g_line);
}

public fw_prethink(id)
{
	if (id < 1 || id > MAX_PLAYERS || !g_near[id])
	{
		return FMRES_IGNORED;
	}
	new b = pev(id, pev_button);
	if ((b & IN_USE) && !(g_lastbtn[id] & IN_USE))
	{
		new p = g_near[id] - 1;
		if (p < g_pcount && g_pto[p] >= 0)
		{
			offer(id, p);
		}
	}
	g_lastbtn[id] = b;
	return FMRES_IGNORED;
}

/** The confirm menu: raw ShowMenu text, as ts_matchmode sends its own (colour codes kept). */
offer(id, p)
{
	new now = get_systime();
	if (now < g_wait_until[id])
	{
		client_print(id, print_center, "Wait %d seconds before the next portal.", g_wait_until[id] - now);
		return;
	}
	new s = g_pto[p];
	if (s < 0)
	{
		return;
	}
	g_menu_p[id] = p + 1;
	new players[32], text[256];
	if (g_shumans[s] < 0)
	{
		copy(players, charsmax(players), "no word from it lately");
	}
	else
	{
		formatex(players, charsmax(players), "%d / %d players", g_shumans[s], g_smax[s]);
	}
	formatex(text, charsmax(text), "\yTravel to %s?^n\w[%s] %s^n^n1. Go^n2. Stay", g_sname[s], g_stag[s], players);
	// An H9 game draws it on a panel, the first line its title; every game gets the text menu.
	h9vgui_show_menu(id, (1 << 0) | (1 << 1) | (1 << 9), text, 15, "H9 Portal", "h9c.portal");
}

public menu_portal(id, key)
{
	new p = g_menu_p[id] - 1;
	g_menu_p[id] = 0;
	if (key != 0 || p < 0 || p >= g_pcount || g_pto[p] < 0 || !is_user_connected(id))
	{
		return PLUGIN_HANDLED;
	}
	travel(id, g_pto[p]);
	return PLUGIN_HANDLED;
}

/**
 * A server cannot connect a client elsewhere (FWGS refuses "connect" unless the player typed
 * it). A client that advertises h9_travel (_h9travel "1" in its userinfo) is sent
 * "h9_travel <address> <name>": its engine asks the player itself, YES or NO, and only the
 * player's YES connects. Every other client is given the address to type; with
 * h9_community_travel 1 it is sent h9_travel as well (an engine without it says the command is
 * unknown).
 */
travel(id, s)
{
	new wait = get_pcvar_num(g_cv_wait);
	if (wait < 0)
	{
		wait = 0;
	}
	else if (wait > 600)
	{
		wait = 600;
	}
	g_wait_until[id] = get_systime() + wait;
	new addr[24];
	copy(addr, charsmax(addr), g_saddr[s]);
	if (!address_ok(addr))
	{
		return;
	}
	new adv[4];
	get_user_info(id, "_h9travel", adv, charsmax(adv));
	new bool:asks = (equal(adv, "1") != 0);

	if (asks || get_pcvar_num(g_cv_travel))
	{
		// the name as the prompt shows it: letters, digits, spaces and a few marks, nothing that
		// could end the command
		new name[48];
		copy(name, charsmax(name), g_sname[s]);
		for (new i = 0; name[i] != EOS; i++)
		{
			new c = name[i];
			if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
				|| c == ' ' || c == '.' || c == '-' || c == '_' || c == ':' || c == '#' || c == '(' || c == ')'))
			{
				name[i] = ' ';
			}
		}
		client_cmd(id, "h9_travel %s ^"%s^"", addr, name);
	}

	if (asks)
	{
		// the prompt is the engine's; the address stays in the console as well
		client_print(id, print_console, "[H9] %s: connect %s", g_sname[s], addr);
		return;
	}

	client_print(id, print_chat, "[H9] %s is at %s -- open the console (~) and type: connect %s", g_sname[s], addr, addr);
	client_print(id, print_console, "[H9] %s: connect %s", g_sname[s], addr);
}

/** Whether ts/mapconfigs/<map>.cfg (searched as the game finds files) has an h9_portal line. */
bool:mapconfig_has_portals(const map[])
{
	new path[96];
	formatex(path, charsmax(path), "mapconfigs/%s.cfg", map);
	new f = fopen(path, "rt", true);
	if (!f)
	{
		return false;
	}
	new line[200];
	new bool:found = false;
	while (!feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		if (equali(line, "h9_portal", 9) && (line[9] == ' ' || line[9] == 9))
		{
			found = true;
			break;
		}
	}
	fclose(f);
	return found;
}

// ---- text -------------------------------------------------------------------------------------------

/**
 * A line from h9web as it is printed: no control characters, no colour codes (^ and a digit),
 * no % (a client would read it as a format) and at most 186 bytes, cut between two characters.
 */
clean_line(s[])
{
	new j = 0;
	for (new i = 0; s[i]; i++)
	{
		new c = s[i] & 0xFF;
		if (c < 32 || c == 127 || c == 37)
		{
			continue;
		}
		if (c == 94 && s[i + 1] >= '0' && s[i + 1] <= '9')
		{
			i++;
			continue;
		}
		s[j] = c;
		j++;
	}
	s[j] = 0;
	if (j > 186)
	{
		new cut = 186;
		while (cut > 0 && (s[cut] & 0xC0) == 0x80)
		{
			cut--;
		}
		s[cut] = 0;
	}
}

/** A name or tag from h9web: as clean_line, and without backslashes (menu colour codes). */
clean_name(s[])
{
	clean_line(s);
	new j = 0;
	for (new i = 0; s[i]; i++)
	{
		if (s[i] != 92)
		{
			s[j] = s[i];
			j++;
		}
	}
	s[j] = 0;
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

/** Whether another human on the server announces the same h9_clientid as slot id (cid, already lowercased). */
bool:cid_shared(id, const cid[])
{
	new other[40];
	for (new i = 1; i <= g_max; i++)
	{
		if (i == id || !is_user_connected(i) || is_user_bot(i) || is_user_hltv(i))
		{
			continue;
		}
		get_user_info(i, "h9_clientid", other, charsmax(other));
		if (equali(other, cid))
		{
			return true;
		}
	}
	return false;
}

/** An h9_clientid: 32 hex characters (A to F lowercased in place). */
bool:cid_ok(s[])
{
	new i;
	for (i = 0; s[i]; i++)
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
	return i == 32;
}

/** A data key: 1 to 32 of a-z 0-9 _ . - */
bool:key_ok(const s[])
{
	new i;
	for (i = 0; s[i]; i++)
	{
		new c = s[i];
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-'))
		{
			return false;
		}
	}
	return i >= 1 && i <= 32;
}

/** A portal's destination: a tag or a server id, 1 to 23 of letters, digits, space _ . - */
bool:dest_ok(const s[])
{
	new i;
	for (i = 0; s[i]; i++)
	{
		new c = s[i];
		if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == ' ' || c == '_' || c == '.' || c == '-'))
		{
			return false;
		}
	}
	return i >= 1 && i <= 23;
}

json_text(EzJSON:obj, const name[], out[], len)
{
	out[0] = 0;
	if (ezjson_object_has_value(obj, name, EzJSONString))
	{
		ezjson_object_get_string(obj, name, out, len);
	}
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
bool:post_signed(const path[], const callback[], const ud[], udlen, timeout)
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
	if (!(equal(url, "https://", 8) || equal(url, "http://127.0.0.1", 16) || equal(url, "http://localhost", 16)))
	{
		return false;
	}
	add(url, charsmax(url), path);
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_community/1.0");
	ezhttp_option_set_timeout(opt, timeout);
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
