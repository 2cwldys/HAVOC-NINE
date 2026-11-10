/*
 * h9_link.sma -- .link: an H9XASH player links their game to their havoc9.org account from in game.
 *
 * The game does the linking itself (engine-h9-link.patch, docs\CUSTOM_XASH_USERID.txt): it asks
 * havoc9.org for a code, shows it on screen, and once the player approves it on havoc9.org/link it
 * is handed the account's player id and plays as the account. This plugin only starts it: to a
 * player who says .link, and whose game can link, it sends h9_link. Nothing of the account passes
 * through the server.
 *
 * A game says in its userinfo whether it can link and whether it is linked: _h9lnk "0" not linked,
 * "1" linked. Older H9XASH builds, the browser game (signed in to its account already) and other
 * clients have no _h9lnk, and are told what to do instead. Bots and HLTV never get h9_link: the
 * plugin leaves them out, and a bot has no client to run it anyway. The game puts up its code at
 * most three times in ten minutes for a server, and never opens the browser by itself.
 *
 *   h9_link_command 1   .link answers (0: .link is left alone, as if the plugin were not here)
 *   h9_link_hint 0      1: a player whose game can link and is not linked is told once, a while
 *                       after joining, that .link links it. Once per player on this server: the
 *                       vault h9_link_hints remembers the h9_clientid it told, for 60 days
 *
 * Every answer is one chat line to the player alone.
 */

#include <amxmodx>
#include <nvault>

#define PLUGIN  "H9 Link"
#define VERSION "1.0"
#define AUTHOR  "H9"

#define LINK_SLOTS       (MAX_PLAYERS + 1)  // the per-player tables, 1-based
#define LINK_COOLDOWN    20.0               // seconds between two codes for one player
#define HINT_DELAY       45.0               // seconds from joining to the hint
#define HINT_DAYS        60                 // days the vault remembers a hinted player
#define TASK_HINT        74100              // + player id

new g_cv_command, g_cv_hint;
new g_vault = INVALID_HANDLE;
new Float:g_last_link[LINK_SLOTS];
new g_userid[LINK_SLOTS];

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_command = register_cvar("h9_link_command", "1");
	g_cv_hint    = register_cvar("h9_link_hint",    "0");

	register_clcmd("say",      "hook_say");
	register_clcmd("say_team", "hook_say");
}

public plugin_cfg()
{
	g_vault = nvault_open("h9_link_hints");
	if (g_vault == INVALID_HANDLE)
	{
		log_amx("[H9 LINK] could not open the vault h9_link_hints: the hint may be told more than once.");
		return;
	}
	nvault_prune(g_vault, 0, get_systime() - HINT_DAYS * 86400);
}

public plugin_end()
{
	if (g_vault != INVALID_HANDLE)
	{
		nvault_close(g_vault);
	}
}

public client_putinserver(id)
{
	if (id < 1 || id >= LINK_SLOTS)
	{
		return;
	}
	g_last_link[id] = 0.0;
	g_userid[id] = get_user_userid(id);
	remove_task(TASK_HINT + id);
	if (get_pcvar_num(g_cv_hint) && !is_user_bot(id) && !is_user_hltv(id))
	{
		set_task(HINT_DELAY, "task_hint", TASK_HINT + id);
	}
}

/// The game's word on linking: -1 no _h9lnk (it cannot link), 0 not linked, 1 linked.
link_state(id)
{
	new v[4];
	get_user_info(id, "_h9lnk", v, charsmax(v));
	if (!v[0])
	{
		return -1;
	}
	return v[0] == '1' ? 1 : 0;
}

public hook_say(id)
{
	if (id < 1 || id >= LINK_SLOTS || !get_pcvar_num(g_cv_command) || is_user_bot(id) || is_user_hltv(id))
	{
		return PLUGIN_CONTINUE;
	}

	new args[32];
	read_args(args, charsmax(args));
	remove_quotes(args);
	trim(args);

	if (!equali(args, ".link"))
	{
		return PLUGIN_CONTINUE;
	}
	cmd_link(id);
	return PLUGIN_HANDLED;
}

cmd_link(id)
{
	new st = link_state(id);

	if (st == 1)
	{
		client_print(id, print_chat, "[H9] Your game is linked to your havoc9.org account already. Unlink your Account in its main menu ends it.");
		return;
	}
	if (st < 0)
	{
		client_print(id, print_chat, "[H9] Your game cannot link from here: get the latest H9XASH at havoc9.org/downloads. The web client is signed in already.");
		return;
	}

	new Float:now = get_gametime();
	if (g_last_link[id] > 0.0 && now - g_last_link[id] < LINK_COOLDOWN)
	{
		client_print(id, print_chat, "[H9] Your code is on screen already. h9_link in the console shows it again.");
		return;
	}
	g_last_link[id] = now;

	client_cmd(id, "h9_link");
	client_print(id, print_chat, "[H9] Your game shows a code: open havoc9.org/link, sign in and approve it. Your game then plays as your account.");
}

public task_hint(taskid)
{
	new id = taskid - TASK_HINT;

	if (id < 1 || id >= LINK_SLOTS || !is_user_connected(id) || get_user_userid(id) != g_userid[id])
	{
		return;
	}
	if (!get_pcvar_num(g_cv_hint) || !get_pcvar_num(g_cv_command) || link_state(id) != 0)
	{
		return;
	}

	new key[40];
	get_user_info(id, "h9_clientid", key, charsmax(key));
	new bool:hex = (strlen(key) == 32);
	for (new i = 0; hex && key[i]; i++)
	{
		hex = ('0' <= key[i] <= '9') || ('a' <= key[i] <= 'f');
	}
	if (!hex)
	{
		return;
	}
	if (g_vault != INVALID_HANDLE)
	{
		new data[4], stamp;
		if (nvault_lookup(g_vault, key, data, charsmax(data), stamp))
		{
			return;
		}
		nvault_set(g_vault, key, "1");
	}

	client_print(id, print_chat, "[H9] Got a havoc9.org account? Type .link and your game plays as you here: presence, your name, your picture.");
}
