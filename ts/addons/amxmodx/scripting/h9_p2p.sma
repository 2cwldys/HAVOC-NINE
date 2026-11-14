/*
 * h9_p2p.sma -- h9_p2p: a friend joins this game without port forwarding, through a relay.
 *
 * The plugin is the host's control panel for the P2P join path (docs\P2P_JOIN.txt). It carries no network code: AMX Mod X
 * cannot start a program or open a socket for this, so the work is done by the helper (p2p\bin\h9p2p.js, started by
 * h9_p2p_host.bat or beside the dedicated server), and the two talk through three small files in addons/amxmodx/data:
 *
 *   h9_p2p_state.txt  the plugin writes it, whole, every 10 seconds while h9_p2p is 1: lines key=value, the last one end=1:
 *                     v enabled stopping public direct relay direct_public require_account service ttl uses name map
 *                     players maxplayers password time end. It carries no secret: the host token lives in p2p.ini only.
 *                     One more write with enabled=0 when h9_p2p goes back to 0, one with stopping=1 when the plugin ends (a
 *                     map change or a shutdown): the helper then waits for the next state instead of closing the path.
 *   h9_p2p_cmd.txt    the plugin appends one line per command: "<unix time> <number> <command>", the command being
 *                     invite <label> [direct] [account] | kick <n> | revoke <invite> | close | public <0|1>.
 *                     The helper reads it and drops a line older than 30 seconds.
 *   h9_p2p_out.txt    the helper appends "<unix time> <type> [re=<number>] <fields>": status, invite, invite-end, joiner,
 *                     left, error. The plugin reads it from where it stopped (a second between looks while the path is up),
 *                     replays it silently when the plugin starts again, and prints what is new in the server console and,
 *                     for an answer, to the admin who asked.
 *
 * With h9_p2p 0 (the stock value) the plugin registers its cvars and commands and does nothing else: it writes no file, reads
 * no file, and no timer is left running. The cvar is looked at when a map starts, 5 seconds later once, and when one of the
 * commands runs: after "h9_p2p 1" in the console, h9_p2p_status (or any other h9_p2p command) starts it.
 *
 * Every command is for the server console, rcon, the player of a listen server and an AMX Mod X admin with ADMIN_RCON.
 * Nothing here is shown to players, and the invite codes go to the console only.
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler: explicit tags, braces on every block, and no
 * backslash escapes in strings.
 */

#include <amxmodx>
#include <amxmisc>

#define PLUGIN  "H9 P2P"
#define VERSION "1.0"
#define AUTHOR  "H9"

#define STATE_EVERY   10.0   // seconds between two writes of the state file
#define TAIL_EVERY    1.0    // seconds between two looks at the helper's file while the path is up
#define BOOT_DELAY    5.0    // the one look at h9_p2p after a map starts, for a cvar a later config sets
#define ANSWER_WAIT   15     // seconds a command waits for the helper's answer
#define HELPER_QUIET  75     // seconds without a line from the helper before it counts as not running
#define TABLE_STALE   180    // a journal whose last line is older than this describes nobody: its rows are dropped
#define MAX_FRIENDS   32
#define MAX_INVITES   16
#define MAX_PENDING   8
#define MAX_LINES     200    // lines of the helper's file handled in one look

#define LEN_LABEL     28
#define LEN_ACCT      36
#define LEN_ID        16
#define LEN_CODE      20
#define LEN_WHAT      12

#define TASK_BOOT     74210
#define TASK_STATE    74211
#define TASK_TAIL     74212

new g_cv_on, g_cv_public, g_cv_direct, g_cv_direct_public, g_cv_relay, g_cv_service;
new g_cv_ttl, g_cv_uses, g_cv_account, g_cv_name;

new g_dir[64], g_state_path[96], g_cmd_path[96], g_out_path[96];

new bool:g_on = false;           // the path is up: the files are in use and the timers run
new bool:g_warned = false;       // a file could not be written (said once, until it can)
new bool:g_last_public = false;  // h9_p2p_public as the last write of the state saw it
new g_started = 0;               // unix time the path came up
new g_state_at = 0;              // unix time of the last write of the state
new g_out_off = 0;               // how far into the helper's file the plugin has read
new g_seq = 0;                   // the number of the last command
new g_helper_seen = 0;           // unix time on the helper's newest line (0: none yet)
new g_helper_text[96];           // the helper's newest status line

new g_fn[MAX_FRIENDS];           // the helper's number for a friend (0: a free slot)
new g_flabel[MAX_FRIENDS][LEN_LABEL];
new g_facct[MAX_FRIENDS][LEN_ACCT];
new g_finv[MAX_FRIENDS][LEN_ID];
new g_fpath[MAX_FRIENDS];        // 0 through the relay, 1 directly
new g_fpublic[MAX_FRIENDS];      // came through the public list
new g_fwhen[MAX_FRIENDS];        // unix time the friend joined

new g_iid[MAX_INVITES][LEN_ID];  // an invite's id (empty: a free slot)
new g_icode[MAX_INVITES][LEN_CODE];
new g_ilabel[MAX_INVITES][LEN_LABEL];
new g_iexp[MAX_INVITES];         // unix time the invite expires
new g_iuses[MAX_INVITES];

new g_pseq[MAX_PENDING];         // commands waiting for the helper's answer (0: a free slot)
new g_pslot[MAX_PENDING];        // who asked: a player slot, or 0 for the server console
new g_puid[MAX_PENDING];         // that player's userid, so a slot that has changed hands is not answered
new g_pat[MAX_PENDING];
new g_pwhat[MAX_PENDING][LEN_WHAT];

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_on            = register_cvar("h9_p2p", "0");
	g_cv_public        = register_cvar("h9_p2p_public", "0");
	g_cv_direct        = register_cvar("h9_p2p_direct", "1");
	g_cv_direct_public = register_cvar("h9_p2p_direct_public", "0");
	g_cv_relay         = register_cvar("h9_p2p_relay", "1");
	g_cv_service       = register_cvar("h9_p2p_service", "");
	g_cv_ttl           = register_cvar("h9_p2p_ttl", "600");
	g_cv_uses          = register_cvar("h9_p2p_uses", "1");
	g_cv_account       = register_cvar("h9_p2p_require_account", "0");
	g_cv_name          = register_cvar("h9_p2p_name", "");

	register_concmd("h9_p2p_invite", "cmd_invite", ADMIN_RCON, "<label> [direct] [account] - an invite for one friend");
	register_concmd("h9_p2p_list",   "cmd_list",   ADMIN_RCON, "- the friends in this game over the path, and the open invites");
	register_concmd("h9_p2p_kick",   "cmd_kick",   ADMIN_RCON, "<n> - remove a friend now");
	register_concmd("h9_p2p_revoke", "cmd_revoke", ADMIN_RCON, "<invite> - kill an invite that was not used");
	register_concmd("h9_p2p_close",  "cmd_close",  ADMIN_RCON, "- close the path: every friend and every invite");
	register_concmd("h9_p2p_status", "cmd_status", ADMIN_RCON, "- what the path is doing");

	get_datadir(g_dir, charsmax(g_dir));
	formatex(g_state_path, charsmax(g_state_path), "%s/h9_p2p_state.txt", g_dir);
	formatex(g_cmd_path, charsmax(g_cmd_path), "%s/h9_p2p_cmd.txt", g_dir);
	formatex(g_out_path, charsmax(g_out_path), "%s/h9_p2p_out.txt", g_dir);
}

public plugin_cfg()
{
	// configs/h9_p2p.cfg: the host's own settings, when there is such a file (h9_p2p.cfg.example is the template)
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_p2p.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	if (get_pcvar_num(g_cv_on))
	{
		start_path();
	}
	set_task(BOOT_DELAY, "task_boot", TASK_BOOT);
}

public plugin_end()
{
	// a map change or a shutdown: the state says so, and the helper waits for the next one
	if (g_on)
	{
		write_state(true);
	}
}

public task_boot()
{
	if (!g_on && get_pcvar_num(g_cv_on))
	{
		start_path();
	}
}

// ---- the path up and down ------------------------------------------------------------------------------------------------

start_path()
{
	if (g_on)
	{
		return;
	}
	g_on = true;
	g_started = get_systime();
	g_out_off = 0;
	g_last_public = get_pcvar_num(g_cv_public) != 0;
	if (!dir_exists(g_dir))
	{
		mkdir(g_dir);
	}
	write_state(false);
	tail_out();
	if (g_helper_seen && get_systime() - g_helper_seen > TABLE_STALE)
	{
		clear_tables();
	}
	set_task(STATE_EVERY, "task_state", TASK_STATE, _, _, "b");
	set_task(TAIL_EVERY, "task_tail", TASK_TAIL, _, _, "b");
}

stop_path()
{
	remove_task(TASK_STATE);
	remove_task(TASK_TAIL);
	g_on = false;
}

public task_state()
{
	if (!get_pcvar_num(g_cv_on))
	{
		// the last write says enabled=0: the helper closes the path, and nothing runs from here on
		write_state(false);
		stop_path();
		server_print("[P2P] h9_p2p is 0: the path is closed.");
		return;
	}

	new bool:pub = get_pcvar_num(g_cv_public) != 0;
	if (pub != g_last_public)
	{
		g_last_public = pub;
		send_cmd(0, "public %d", pub ? 1 : 0);
	}
	write_state(false);
	expire_invites();
}

public task_tail()
{
	tail_out();
	check_pending();
}

// ---- the state file ------------------------------------------------------------------------------------------------------

bool:write_state(bool:stopping)
{
	new f = fopen(g_state_path, "wb");
	if (!f)
	{
		if (!g_warned)
		{
			g_warned = true;
			log_amx("[P2P] cannot write %s: no invite can be made until it can.", g_state_path);
		}
		return false;
	}
	g_warned = false;

	new raw[170], name[72], map[40], service[168], pw[40], humans[MAX_PLAYERS], num = 0;
	get_pcvar_string(g_cv_name, raw, charsmax(raw));
	trim(raw);
	if (!raw[0])
	{
		get_cvar_string("hostname", raw, charsmax(raw));
	}
	clean_text(raw, name, 64);
	get_mapname(raw, charsmax(raw));
	clean_text(raw, map, 32);
	get_pcvar_string(g_cv_service, raw, charsmax(raw));
	trim(raw);
	clean_text(raw, service, 160);
	get_cvar_string("sv_password", pw, charsmax(pw));
	get_players(humans, num, "ch");
	g_state_at = get_systime();

	fprintf(f, "v=1^nenabled=%d^nstopping=%d^npublic=%d^n", get_pcvar_num(g_cv_on) ? 1 : 0, stopping ? 1 : 0, get_pcvar_num(g_cv_public) ? 1 : 0);
	fprintf(f, "direct=%d^nrelay=%d^ndirect_public=%d^nrequire_account=%d^n", get_pcvar_num(g_cv_direct) ? 1 : 0, get_pcvar_num(g_cv_relay) ? 1 : 0, get_pcvar_num(g_cv_direct_public) ? 1 : 0, get_pcvar_num(g_cv_account) ? 1 : 0);
	fprintf(f, "service=%s^nttl=%d^nuses=%d^n", service, clamp(get_pcvar_num(g_cv_ttl), 60, 900), clamp(get_pcvar_num(g_cv_uses), 1, 8));
	fprintf(f, "name=%s^nmap=%s^nplayers=%d^nmaxplayers=%d^n", name, map, num, get_maxplayers());
	fprintf(f, "password=%d^ntime=%d^nend=1^n", (pw[0] && !equali(pw, "none")) ? 1 : 0, g_state_at);
	fclose(f);
	return true;
}

// ---- the commands ----------------------------------------------------------------------------------------------------------

public cmd_invite(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!path_wanted(id))
	{
		return PLUGIN_HANDLED;
	}

	new arg[48], label[LEN_LABEL], bool:direct = false, bool:account = false;
	copy(label, charsmax(label), "friend");
	new argc = read_argc();
	if (argc >= 2)
	{
		read_argv(1, arg, charsmax(arg));
		clean_token(arg, label, 24);
		if (!label[0])
		{
			copy(label, charsmax(label), "friend");
		}
	}
	for (new i = 2; i < argc; i++)
	{
		read_argv(i, arg, charsmax(arg));
		if (equali(arg, "direct"))
		{
			direct = true;
		}
		else if (equali(arg, "account"))
		{
			account = true;
		}
		else
		{
			console_print(id, "[P2P] unknown word '%s': after the label only direct and account are understood.", arg);
			return PLUGIN_HANDLED;
		}
	}
	if (direct && !get_pcvar_num(g_cv_direct))
	{
		console_print(id, "[P2P] h9_p2p_direct is 0: an invite cannot be direct here.");
		return PLUGIN_HANDLED;
	}

	if (!send_cmd(id, "invite %s%s%s", label, direct ? " direct" : "", account ? " account" : ""))
	{
		console_print(id, "[P2P] cannot write %s: no invite can be made.", g_cmd_path);
		return PLUGIN_HANDLED;
	}
	console_print(id, "[P2P] asking the helper for an invite for %s ...", label);
	warn_helper(id);
	return PLUGIN_HANDLED;
}

public cmd_list(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!get_pcvar_num(g_cv_on))
	{
		console_print(id, "[P2P] h9_p2p is 0: nothing is running.");
		return PLUGIN_HANDLED;
	}
	if (!g_on)
	{
		start_path();
	}
	else
	{
		tail_out();
	}
	expire_invites();

	new now = get_systime(), shown = 0, when[24], acct[LEN_ACCT], left[24];
	console_print(id, "[P2P] friends in this game over the path:");
	for (new i = 0; i < MAX_FRIENDS; i++)
	{
		if (!g_fn[i])
		{
			continue;
		}
		shown++;
		elapsed(now - g_fwhen[i], when, charsmax(when));
		if (g_facct[i][0])
		{
			copy(acct, charsmax(acct), g_facct[i]);
		}
		else
		{
			copy(acct, charsmax(acct), "-");
		}
		console_print(id, "  %-3d %-24s %-18s %-7s joined %s%s", g_fn[i], g_flabel[i], acct, g_fpath[i] ? "direct" : "relay", when, g_fpublic[i] ? "  (public list)" : "");
	}
	if (!shown)
	{
		console_print(id, "  none");
	}
	shown = 0;
	console_print(id, "[P2P] invites not used yet:");
	for (new i = 0; i < MAX_INVITES; i++)
	{
		if (!g_iid[i][0])
		{
			continue;
		}
		shown++;
		if (g_iexp[i] > 0)
		{
			formatex(left, charsmax(left), "%d min left", (g_iexp[i] - now + 59) / 60);
		}
		else
		{
			copy(left, charsmax(left), "time unknown");
		}
		console_print(id, "  %-15s %-24s %s, %d use(s)  (id %s)", g_icode[i], g_ilabel[i], left, g_iuses[i], g_iid[i]);
	}
	if (!shown)
	{
		console_print(id, "  none");
	}
	if (helper_quiet())
	{
		console_print(id, "[P2P] the helper is not running (docs/P2P_JOIN.txt): the rows above are from its last run.");
	}
	return PLUGIN_HANDLED;
}

public cmd_kick(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	if (!path_wanted(id))
	{
		return PLUGIN_HANDLED;
	}
	new arg[16];
	read_argv(1, arg, charsmax(arg));
	new n = str_to_num(arg);
	if (find_friend(n) < 0)
	{
		console_print(id, "[P2P] no friend has the number %d: h9_p2p_list shows them.", n);
		return PLUGIN_HANDLED;
	}
	if (!send_cmd(id, "kick %d", n))
	{
		console_print(id, "[P2P] cannot write %s.", g_cmd_path);
		return PLUGIN_HANDLED;
	}
	console_print(id, "[P2P] asking the helper to remove friend %d ...", n);
	warn_helper(id);
	return PLUGIN_HANDLED;
}

public cmd_revoke(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	if (!path_wanted(id))
	{
		return PLUGIN_HANDLED;
	}
	new arg[48], key[LEN_ID];
	read_argv(1, arg, charsmax(arg));
	clean_token(arg, arg, charsmax(arg));
	copy(key, charsmax(key), arg);
	new at = find_invite(arg);
	if (at >= 0)
	{
		copy(key, charsmax(key), g_iid[at]);
	}
	if (!key[0])
	{
		console_print(id, "[P2P] say which invite: its code or its id (h9_p2p_list shows both).");
		return PLUGIN_HANDLED;
	}
	if (!send_cmd(id, "revoke %s", key))
	{
		console_print(id, "[P2P] cannot write %s.", g_cmd_path);
		return PLUGIN_HANDLED;
	}
	console_print(id, "[P2P] asking the helper to kill that invite ...");
	warn_helper(id);
	return PLUGIN_HANDLED;
}

public cmd_close(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!path_wanted(id))
	{
		return PLUGIN_HANDLED;
	}
	if (!send_cmd(id, "close"))
	{
		console_print(id, "[P2P] cannot write %s.", g_cmd_path);
		return PLUGIN_HANDLED;
	}
	console_print(id, "[P2P] asking the helper to close the path: every friend and every invite goes ...");
	warn_helper(id);
	return PLUGIN_HANDLED;
}

public cmd_status(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new on = get_pcvar_num(g_cv_on);
	console_print(id, "[P2P] %s %s", PLUGIN, VERSION);
	console_print(id, "  h9_p2p %d, public %d, direct %d, direct_public %d, relay %d, require_account %d, ttl %d, uses %d", on ? 1 : 0, get_pcvar_num(g_cv_public) ? 1 : 0, get_pcvar_num(g_cv_direct) ? 1 : 0, get_pcvar_num(g_cv_direct_public) ? 1 : 0, get_pcvar_num(g_cv_relay) ? 1 : 0, get_pcvar_num(g_cv_account) ? 1 : 0, clamp(get_pcvar_num(g_cv_ttl), 60, 900), clamp(get_pcvar_num(g_cv_uses), 1, 8));
	if (!on)
	{
		console_print(id, "  h9_p2p is 0: nothing is running. No file is written and no timer runs. Set h9_p2p 1 and run this again.");
		return PLUGIN_HANDLED;
	}
	if (!g_on)
	{
		start_path();
	}
	else
	{
		tail_out();
	}
	expire_invites();

	new now = get_systime(), svc[168], friends = 0, invites = 0;
	get_pcvar_string(g_cv_service, svc, charsmax(svc));
	trim(svc);
	if (svc[0])
	{
		console_print(id, "  service: %s", svc);
	}
	else
	{
		console_print(id, "  service: none set here (the helper uses the one in its p2p.ini)");
	}
	console_print(id, "  files: %s, %s, %s", g_state_path, g_cmd_path, g_out_path);
	console_print(id, "  state file written %d s ago (every %d s)", now - g_state_at, floatround(STATE_EVERY));
	if (helper_quiet())
	{
		console_print(id, "  helper: not running (%s). Start h9_p2p_host.bat or h9_p2p_host.sh (docs/P2P_JOIN.txt).", g_helper_seen ? "no word for a while" : "no word yet");
	}
	else
	{
		console_print(id, "  helper: running, last word %d s ago: %s", now - g_helper_seen, g_helper_text);
	}
	for (new i = 0; i < MAX_FRIENDS; i++)
	{
		if (g_fn[i])
		{
			friends++;
		}
	}
	for (new i = 0; i < MAX_INVITES; i++)
	{
		if (g_iid[i][0])
		{
			invites++;
		}
	}
	console_print(id, "  friends: %d, invites not used yet: %d (h9_p2p_list)", friends, invites);
	return PLUGIN_HANDLED;
}

/** The path must be wanted (h9_p2p 1) for a command to mean anything; it is brought up if the cvar was set after the map began. */
bool:path_wanted(id)
{
	if (!get_pcvar_num(g_cv_on))
	{
		console_print(id, "[P2P] h9_p2p is 0: nothing is running. Set h9_p2p 1 and try again.");
		return false;
	}
	if (!g_on)
	{
		start_path();
	}
	return true;
}

warn_helper(id)
{
	if (helper_quiet())
	{
		console_print(id, "[P2P] no word from the helper %s: start h9_p2p_host.bat or h9_p2p_host.sh (docs/P2P_JOIN.txt).", g_helper_seen ? "for a while" : "yet");
	}
}

bool:helper_quiet()
{
	return g_helper_seen == 0 || get_systime() - g_helper_seen > HELPER_QUIET;
}

// ---- the command file ------------------------------------------------------------------------------------------------------

/** Appends a command and remembers who asked; the number of the command, 0 when the file cannot be written. */
send_cmd(asker, const fmt[], any:...)
{
	new text[160];
	vformat(text, charsmax(text), fmt, 3);
	new f = fopen(g_cmd_path, "ab");
	if (!f)
	{
		return 0;
	}
	g_seq++;
	fprintf(f, "%d %d %s^n", get_systime(), g_seq, text);
	fclose(f);

	new verb[LEN_WHAT];
	copyc(verb, charsmax(verb), text, ' ');
	pend_add(g_seq, asker, verb);
	return g_seq;
}

pend_add(seq, asker, const verb[])
{
	new slot = -1, oldest = 0;
	for (new i = 0; i < MAX_PENDING; i++)
	{
		if (!g_pseq[i])
		{
			slot = i;
			break;
		}
		if (g_pat[i] < g_pat[oldest])
		{
			oldest = i;
		}
	}
	if (slot < 0)
	{
		slot = oldest;
	}
	g_pseq[slot] = seq;
	g_pslot[slot] = asker;
	g_puid[slot] = asker > 0 ? get_user_userid(asker) : 0;
	g_pat[slot] = get_systime();
	copy(g_pwhat[slot], LEN_WHAT - 1, verb);
}

/** The answer to command seq has come: true when it was waiting, and who asked (0: the server console, or nobody still there). */
bool:pend_take(seq, &asker)
{
	asker = 0;
	for (new i = 0; i < MAX_PENDING; i++)
	{
		if (g_pseq[i] != seq)
		{
			continue;
		}
		g_pseq[i] = 0;
		new who = g_pslot[i];
		if (who > 0 && who <= MAX_PLAYERS && is_user_connected(who) && get_user_userid(who) == g_puid[i])
		{
			asker = who;
		}
		return true;
	}
	return false;
}

check_pending()
{
	new now = get_systime();
	for (new i = 0; i < MAX_PENDING; i++)
	{
		if (!g_pseq[i] || now - g_pat[i] < ANSWER_WAIT)
		{
			continue;
		}
		new asker = 0;
		new what[LEN_WHAT];
		copy(what, charsmax(what), g_pwhat[i]);
		pend_take(g_pseq[i], asker);
		say_out(asker, "no answer to '%s' from the helper in %d s: is h9_p2p_host.bat running? (h9_p2p_status)", what, ANSWER_WAIT);
	}
}

// ---- the helper's file ---------------------------------------------------------------------------------------------------------

tail_out()
{
	new f = fopen(g_out_path, "rb");
	if (!f)
	{
		g_out_off = 0;
		return;
	}
	fseek(f, 0, SEEK_END);
	if (ftell(f) < g_out_off)
	{
		g_out_off = 0;   // the helper began a new file
	}
	fseek(f, g_out_off, SEEK_SET);

	new line[256], n = 0, bool:skipping = false;
	while (n < MAX_LINES)
	{
		new at = ftell(f);
		line[0] = 0;
		if (feof(f) || !fgets(f, line, charsmax(line)))
		{
			break;
		}
		new len = strlen(line);
		new bool:whole = (len > 0 && line[len - 1] == '^n');
		if (!whole && feof(f) && !skipping)
		{
			g_out_off = at;   // the helper is still writing this line: it is read again at the next look
			break;
		}
		g_out_off = ftell(f);
		if (skipping)
		{
			skipping = !whole;
			continue;
		}
		if (!whole)
		{
			skipping = true;   // longer than any line the helper writes: dropped
			continue;
		}
		trim(line);
		if (line[0])
		{
			handle_line(line);
		}
		n++;
	}
	fclose(f);
}

handle_line(const line[])
{
	new stamp[16], type[16];
	parse(line, stamp, charsmax(stamp), type, charsmax(type));
	new when = str_to_num(stamp);
	if (when <= 0 || !type[0])
	{
		return;
	}
	if (when > g_helper_seen)
	{
		g_helper_seen = when;
	}

	new body[200], tmp[200];
	copy(tmp, charsmax(tmp), line[skip_tokens(line, 2)]);
	new re = 0;
	if (equal(tmp, "re=", 3))
	{
		re = str_to_num(tmp[3]);
		copy(body, charsmax(body), tmp[skip_tokens(tmp, 1)]);
	}
	else
	{
		copy(body, charsmax(body), tmp);
	}

	new bool:live = (when >= g_started - 2);
	new asker = 0;
	if (live && re > 0)
	{
		pend_take(re, asker);
	}

	if (equal(type, "status"))
	{
		on_status(live, asker, body);
	}
	else if (equal(type, "invite"))
	{
		on_invite(live, asker, body);
	}
	else if (equal(type, "invite-end"))
	{
		on_invite_end(live, asker, body);
	}
	else if (equal(type, "joiner"))
	{
		on_joiner(live, body);
	}
	else if (equal(type, "left"))
	{
		on_left(live, body);
	}
	else if (equal(type, "error"))
	{
		if (live)
		{
			say_out(asker, "helper: %s", body);
		}
	}
}

on_status(bool:live, asker, const body[])
{
	copy(g_helper_text, charsmax(g_helper_text), body);
	if (!live || equal(body, "beat", 4))
	{
		return;
	}
	if (equal(body, "public listed", 13))
	{
		say_out(asker, "this game is on the public list (%s)", body[14]);
		return;
	}
	say_out(asker, "helper: %s", body);
}

on_invite(bool:live, asker, const body[])
{
	new code[LEN_CODE], label[LEN_LABEL], id[LEN_ID], val[24], exp = 0, uses = 1, ttl = 0;
	parse(body, code, charsmax(code), label, charsmax(label));
	if (!code[0] || !line_kv(body, "id", id, charsmax(id)) || !id[0])
	{
		return;
	}
	if (line_kv(body, "exp", val, charsmax(val)))
	{
		exp = str_to_num(val);
	}
	if (line_kv(body, "uses", val, charsmax(val)))
	{
		uses = str_to_num(val);
	}
	if (line_kv(body, "ttl", val, charsmax(val)))
	{
		ttl = str_to_num(val);
	}
	if (exp > 0 && exp <= get_systime())
	{
		return;
	}
	new at = find_invite(id);
	if (at < 0)
	{
		for (new i = 0; i < MAX_INVITES; i++)
		{
			if (!g_iid[i][0])
			{
				at = i;
				break;
			}
		}
	}
	if (at < 0)
	{
		at = 0;
	}
	copy(g_iid[at], LEN_ID - 1, id);
	copy(g_icode[at], LEN_CODE - 1, code);
	copy(g_ilabel[at], LEN_LABEL - 1, label);
	g_iexp[at] = exp;
	g_iuses[at] = uses;

	if (live && contain(body, " snap") < 0)
	{
		new mins = ttl / 60;
		if (mins < 1)
		{
			mins = 1;
		}
		say_out(asker, "invite for %s: %s (%d min, %d %s). The friend runs: h9_p2p_join.bat %s", label, code, mins, uses, uses == 1 ? "use" : "uses", code);
	}
}

on_invite_end(bool:live, asker, const body[])
{
	new id[LEN_ID], why[24];
	parse(body, id, charsmax(id), why, charsmax(why));
	new at = find_invite(id);
	if (at < 0)
	{
		return;
	}
	if (live && equal(why, "revoked"))
	{
		say_out(asker, "invite for %s killed.", g_ilabel[at]);
	}
	g_iid[at][0] = 0;
}

on_joiner(bool:live, const body[])
{
	new tn[12], label[LEN_LABEL], acct[LEN_ACCT], inv[LEN_ID], path[12], flag1[12], flag2[12];
	parse(body, tn, charsmax(tn), label, charsmax(label), acct, charsmax(acct), inv, charsmax(inv), path, charsmax(path), flag1, charsmax(flag1), flag2, charsmax(flag2));
	new n = str_to_num(tn);
	if (n <= 0 || !label[0])
	{
		return;
	}
	new bool:snap = equal(flag1, "snap") || equal(flag2, "snap");
	new pub = (equal(flag1, "public") || equal(flag2, "public")) ? 1 : 0;
	new p = equal(path, "direct") ? 1 : 0;

	new at = find_friend(n);
	if (at < 0)
	{
		for (new i = 0; i < MAX_FRIENDS; i++)
		{
			if (!g_fn[i])
			{
				at = i;
				break;
			}
		}
		if (at < 0)
		{
			return;
		}
		g_fn[at] = n;
		g_fwhen[at] = get_systime();
		g_fpath[at] = p;
		copy(g_flabel[at], LEN_LABEL - 1, label);
		g_facct[at][0] = 0;
		if (!equal(acct, "-"))
		{
			copy(g_facct[at], LEN_ACCT - 1, acct);
		}
		g_finv[at][0] = 0;
		if (!equal(inv, "-"))
		{
			copy(g_finv[at], LEN_ID - 1, inv);
		}
		g_fpublic[at] = pub;
		if (live && !snap)
		{
			if (g_facct[at][0])
			{
				say_out(0, "%s joined (account %s) by %s, number %d", label, g_facct[at], p ? "a direct path" : "the relay", n);
			}
			else
			{
				say_out(0, "%s joined by %s, number %d", label, p ? "a direct path" : "the relay", n);
			}
			log_amx("[P2P] %s joined (number %d, %s)", label, n, p ? "direct" : "relay");
		}
		return;
	}
	if (g_fpath[at] != p)
	{
		g_fpath[at] = p;
		if (live && !snap)
		{
			say_out(0, "%s is now %s", g_flabel[at], p ? "direct" : "through the relay");
		}
	}
}

on_left(bool:live, const body[])
{
	new tn[12], why[40];
	parse(body, tn, charsmax(tn), why, charsmax(why));
	new at = find_friend(str_to_num(tn));
	if (at < 0)
	{
		return;
	}
	if (live)
	{
		say_out(0, "%s left (%s)", g_flabel[at], why[0] ? why : "gone");
		log_amx("[P2P] %s left (number %d, %s)", g_flabel[at], g_fn[at], why[0] ? why : "gone");
	}
	g_fn[at] = 0;
}

// ---- tables -------------------------------------------------------------------------------------------------------------------

find_friend(n)
{
	if (n <= 0)
	{
		return -1;
	}
	for (new i = 0; i < MAX_FRIENDS; i++)
	{
		if (g_fn[i] == n)
		{
			return i;
		}
	}
	return -1;
}

/** An invite by its id, or by its code as it was shown or typed (H9-XXXXX-XXXXX, upper or lower case, with or without the dashes). */
find_invite(const key[])
{
	if (!key[0])
	{
		return -1;
	}
	new want[LEN_CODE], have[LEN_CODE];
	code_digits(key, want, charsmax(want));
	for (new i = 0; i < MAX_INVITES; i++)
	{
		if (!g_iid[i][0])
		{
			continue;
		}
		if (equal(g_iid[i], key))
		{
			return i;
		}
		code_digits(g_icode[i], have, charsmax(have));
		if (want[0] && equal(have, want))
		{
			return i;
		}
	}
	return -1;
}

/** The characters of a code that count: upper case letters and digits, without the H9 and the dashes. */
code_digits(const in[], out[], len)
{
	new j = 0;
	for (new i = 0; in[i] && j < len; i++)
	{
		new c = in[i];
		if (c >= 'a' && c <= 'z')
		{
			c -= 32;
		}
		if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
		{
			out[j++] = c;
		}
	}
	out[j] = 0;
	if (j == 12 && out[0] == 'H' && out[1] == '9')
	{
		for (new k = 0; k <= 10; k++)
		{
			out[k] = out[k + 2];
		}
	}
}

expire_invites()
{
	new now = get_systime();
	for (new i = 0; i < MAX_INVITES; i++)
	{
		if (g_iid[i][0] && g_iexp[i] > 0 && g_iexp[i] <= now)
		{
			g_iid[i][0] = 0;
		}
	}
}

clear_tables()
{
	for (new i = 0; i < MAX_FRIENDS; i++)
	{
		g_fn[i] = 0;
	}
	for (new i = 0; i < MAX_INVITES; i++)
	{
		g_iid[i][0] = 0;
	}
}

// ---- text helpers ------------------------------------------------------------------------------------------------------------

/** A line for the server console and, where the console is not the asker's own, for the admin who asked. */
say_out(asker, const fmt[], any:...)
{
	new buf[224];
	vformat(buf, charsmax(buf), fmt, 3);
	server_print("[P2P] %s", buf);
	if (asker > 0 && is_user_connected(asker) && !(asker == 1 && !is_dedicated_server()))
	{
		console_print(asker, "[P2P] %s", buf);
	}
}

/** What fits on a file line: printable ASCII only. */
clean_text(const in[], out[], len)
{
	new j = 0;
	for (new i = 0; in[i] && j < len; i++)
	{
		new c = in[i];
		out[j++] = (c < 32 || c > 126) ? '?' : c;
	}
	out[j] = 0;
}

/** One word: letters, digits, dot, dash and underscore; a space becomes an underscore, anything else is dropped. */
clean_token(const in[], out[], len)
{
	new j = 0;
	for (new i = 0; in[i] && j < len; i++)
	{
		new c = in[i];
		if (c == ' ')
		{
			c = '_';
		}
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.')
		{
			out[j++] = c;
		}
	}
	out[j] = 0;
}

/** The index of the first character after count words and the blanks behind them. */
skip_tokens(const text[], count)
{
	new i = 0;
	while (count > 0)
	{
		while (text[i] == ' ')
		{
			i++;
		}
		while (text[i] && text[i] != ' ')
		{
			i++;
		}
		count--;
	}
	while (text[i] == ' ')
	{
		i++;
	}
	return i;
}

/** The value of key=value among the words of a line (a word that starts with a blank before key). */
bool:line_kv(const line[], const key[], out[], len)
{
	new pat[24];
	formatex(pat, charsmax(pat), " %s=", key);
	new at = contain(line, pat);
	out[0] = 0;
	if (at < 0)
	{
		return false;
	}
	at += strlen(pat);
	new j = 0;
	while (line[at] && line[at] != ' ' && j < len)
	{
		out[j++] = line[at++];
	}
	out[j] = 0;
	return true;
}

/** "3 s ago", "5 min ago", "2 h 5 min ago": how long ago something was. */
elapsed(seconds, out[], len)
{
	if (seconds < 0)
	{
		seconds = 0;
	}
	if (seconds < 60)
	{
		formatex(out, len, "%d s ago", seconds);
	}
	else if (seconds < 3600)
	{
		formatex(out, len, "%d min ago", seconds / 60);
	}
	else
	{
		formatex(out, len, "%d h %d min ago", seconds / 3600, (seconds % 3600) / 60);
	}
}
