/*
 * ts_survival.sma -- WAVE SURVIVAL, a mode for ts_matchmode.
 *
 * Side 1 is the people: the class menu, their class lives, ready-up as always. Side 2 is the
 * enemy wave, bots only -- a person picking it is made a spectator -- and it never runs out:
 * every mutant that falls comes back with the next wave.
 *
 * A WAVE IS A WHOLE SET OF MUTANTS. The next one does not come until every mutant of the one
 * before is dead. Clearing a wave starts a breather, tsm_ws_wave seconds counted down on
 * everyone's screen, and then the next wave comes all at once: the wave count goes up, the
 * sting plays for everyone, every fallen survivor comes back with it and every survivor's
 * lives are set to their class's count again. There is no round clock and no sudden death:
 * the run goes on until side 1 is wiped out -- nobody standing, no lives left, nobody waiting
 * -- and then the match is over, chat says how far they got, and it is back to warmup.
 *
 * THE WAVES GROW. Each mutant spawns with its class's health plus tsm_ws_hp_per_wave percent
 * for every wave after the first, and rolls a gun or a blade by tsm_ws_gun_odds: 40% armed
 * at first, 60% from wave 16, every one of them from wave 25. After wave tsm_ws_kungfu_after
 * (30) each comes back with the kung fu powerup as well.
 *
 * WHICH MAPS. Any map whose name starts h9_ws_, while tsm_mutants_mode is 1. A map with
 * siege objectives stays a siege map (ts_matchmode refuses the claim), and the first mode to
 * claim a map keeps it. Side 2 needs bots: tsm_bots in ts_matchmode.cfg.
 *
 * BOTS. While the mode runs rcbot is told to hand out none of its own weapons and to pick none
 * up (rcbot config ts_kungfu 1, ts_dont_pickup_weapons 1), so a melee mutant stays a melee
 * mutant; the next map that is not a survival map puts both back.
 *
 * THE MODE API. Everything comes through include\tsm_api.inc. With ts_matchmode missing the
 * native filter lets this plugin load, and it does nothing.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <fun>
#include <tsm_api>

#define PLUGIN  "TS Wave Survival"
#define VERSION "1.0"
#define AUTHOR  "tsm"

#define WS_BUILD "1.0-modes1"

#define WS_TICK        0.5
#define WS_TASK_TICK   71201
#define WS_TASK_CLAIM  71202

#define WS_PWUP_KUNGFU 4          // TSPWUP_KUNGFU in tsconst.inc
#define WS_STING       "xom_laugh.wav"
#define WS_STING_FILE  "sound/xom_laugh.wav"
#define WS_PREFIX      "h9_ws_"

new g_cv_mode, g_cv_breather, g_cv_class, g_cv_odds, g_cv_guns, g_cv_melee, g_cv_hp, g_cv_kungfu;
new g_cv_sound, g_cv_stall, g_cv_desc;

new bool:g_have_core = true;   // cleared by the native filter when ts_matchmode is not loaded
new bool:g_active = false;     // this map is claimed for survival
new bool:g_sting_ok;           // the default sting was precached
new g_mapname[32];

new g_wave;                    // the wave being fought, from 1
new g_best;                    // the furthest wave reached on this map since it loaded
new Float:g_breather_until;    // the next wave's arrival while one is being waited for; 0 otherwise
new g_last_count;              // mutants in play at the last tick, for the stall check
new Float:g_last_change;       // when that count last moved
new bool:g_told_respawns;      // the tsm_respawns 0 warning, once a map

public plugin_natives()
{
	set_native_filter("native_filter");
}

/// A missing tsm_* native is allowed: the call returns 0, and this plugin stays out of the way.
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

public plugin_precache()
{
	// Precached only when the file is really there: a precached name with no file behind it is
	// a fatal Host_Error. It is the sudden-death sting, so a server running the match mode has it.
	g_sting_ok = (file_exists(WS_STING_FILE, true) != 0);
	if (g_sting_ok)
	{
		precache_sound(WS_STING);
	}
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_mode     = register_cvar("tsm_mutants_mode",      "1");
	g_cv_breather = register_cvar("tsm_ws_wave",           "30");
	g_cv_class    = register_cvar("tsm_ws_class",          "1");
	g_cv_odds     = register_cvar("tsm_ws_gun_odds",       "1:40,16:60,25:100");
	g_cv_guns     = register_cvar("tsm_ws_guns",           "13:3,3:3,7:3,20:3");
	g_cv_melee    = register_cvar("tsm_ws_melee",          "25,34,35,0");
	g_cv_hp       = register_cvar("tsm_ws_hp_per_wave",    "5");
	g_cv_kungfu   = register_cvar("tsm_ws_kungfu_after",   "30");
	g_cv_sound    = register_cvar("tsm_ws_wave_sound",     WS_STING);
	g_cv_stall    = register_cvar("tsm_ws_stall",          "120");
	g_cv_desc     = register_cvar("tsm_gamedesc_survival", "Wave Survival");

	register_concmd("amx_tsm_ws",      "cmd_ws_dump", ADMIN_CFG, " - the survival mode's whole state");
	register_concmd("amx_tsm_ws_wave", "cmd_ws_wave", ADMIN_CFG, " <n> - set the wave count, to test how the waves grow");
}

public plugin_cfg()
{
	get_mapname(g_mapname, charsmax(g_mapname));

	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_survival.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// After the map's entities and h9_autoconfig's ts/mapconfigs/<map>.cfg, like the uplink.
	set_task(2.0, "task_claim", WS_TASK_CLAIM);
}

/* ---- the claim -------------------------------------------------------------------------- */

public task_claim()
{
	new bool:want = (g_have_core && get_pcvar_num(g_cv_mode) != 0
		&& equali(g_mapname, WS_PREFIX, strlen(WS_PREFIX)));

	if (want)
	{
		new desc[64];
		get_pcvar_string(g_cv_desc, desc, charsmax(desc));
		if (!desc[0])
		{
			copy(desc, charsmax(desc), "Wave Survival");
		}
		if (tsm_mode_claim("survival", desc,
			TSM_MODE_NO_SUDDEN | TSM_MODE_NO_CLOCK | TSM_MODE_SIDE2_BOTS | TSM_MODE_SIDE2_ENDLESS | TSM_MODE_ONE_RUN))
		{
			g_active = true;
		}
		else
		{
			log_amx("[SURVIVAL] %s wanted survival but the claim was refused (siege objectives, another mode, or no ts_matchmode).",
				g_mapname);
		}
	}

	if (!g_active)
	{
		// A survival map before this one left rcbot arming nobody: put that back.
		new was[4];
		get_localinfo("tsm_ws_rcbot", was, charsmax(was));
		if (was[0] == '1')
		{
			server_cmd("rcbot config ts_kungfu 0");
			server_cmd("rcbot config ts_dont_pickup_weapons 0");
			set_localinfo("tsm_ws_rcbot", "0");
		}
		return;
	}

	// Side 2's waves are this plugin's to bring: no timer, the dead wait for the clear.
	tsm_wave_seconds(2, -1.0);

	// The mutants' weapons are this plugin's alone: rcbot hands out none and picks none up.
	server_cmd("rcbot config ts_kungfu 1");
	server_cmd("rcbot config ts_dont_pickup_weapons 1");
	set_localinfo("tsm_ws_rcbot", "1");

	if (!get_cvar_num("tsm_bots"))
	{
		log_amx("[SURVIVAL] %s is a survival map but tsm_bots is 0 -- side 2 is bots only, so nothing will attack.", g_mapname);
	}

	g_wave = 1;
	refresh_hud();
	remove_task(WS_TASK_TICK);
	set_task(WS_TICK, "task_tick", WS_TASK_TICK, "", 0, "b");
	log_amx("[SURVIVAL] %s is a survival map.", g_mapname);
}

/* ---- the run ----------------------------------------------------------------------------- */

public task_tick()
{
	if (!g_active)
	{
		return;
	}

	if (tsm_state() != TSM_ST_LIVE)
	{
		g_breather_until = 0.0;
		return;
	}

	keep_mutant_classes();

	new Float:now = get_gametime();

	// The breather between waves, counted down on everyone's screen.
	if (g_breather_until > 0.0)
	{
		new left = floatround(g_breather_until - now, floatround_ceil);
		if (left > 0)
		{
			set_hudmessage(255, 200, 80, -1.0, 0.28, 0, 0.0, 0.6, 0.0, 0.1, 2);
			show_hudmessage(0, "WAVE %d CLEARED^nNext wave in %d", g_wave, left);
			return;
		}
		next_wave();
		return;
	}

	new count = mutants_in_play();
	if (count != g_last_count)
	{
		g_last_count = count;
		g_last_change = now;
	}

	if (count > 0)
	{
		/*
		 * THE STALL. A wave is only over when its last mutant is dead, and a bot that has
		 * wedged itself somewhere nobody can reach would hold the run forever. After
		 * tsm_ws_stall seconds without a single mutant falling, the last few left standing
		 * are taken off the board and the wave counts as cleared. 0 never does it.
		 */
		new Float:stall = get_pcvar_float(g_cv_stall);
		if (stall > 0.0 && count <= 3 && now - g_last_change >= stall)
		{
			slay_stragglers();
			client_print(0, print_chat, "[MATCH] The last mutants were lost in the drains -- wave %d is cleared.", g_wave);
		}
		return;
	}

	// Every mutant of this wave is down (and side 2 has members at all): the breather begins.
	if (tsm_side_alive(2) > 0)
	{
		new Float:wait = get_pcvar_float(g_cv_breather);
		if (wait < 0.0)
		{
			wait = 0.0;
		}
		g_breather_until = now + wait;
		if (wait > 0.0)
		{
			client_print(0, print_chat, "[MATCH] Wave %d cleared! The next wave comes in %d seconds.", g_wave, floatround(wait));
		}
	}
}

/// How many mutants are on their feet right now: side 2, alive and in play.
mutants_in_play()
{
	new players[32], pnum, n = 0;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		if (tsm_side_of(players[i]) == 2 && tsm_in_play(players[i]))
		{
			n++;
		}
	}
	return n;
}

slay_stragglers()
{
	new players[32], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (tsm_side_of(id) == 2 && tsm_in_play(id))
		{
			user_kill(id, 1);
		}
	}
	g_last_change = get_gametime();
}

/// Every mutant plays tsm_ws_class: its model and its base health. Bots only, side 2 only.
keep_mutant_classes()
{
	new cls = get_pcvar_num(g_cv_class);
	if (cls < 1)
	{
		return;
	}
	new players[32], pnum;
	get_players(players, pnum, "");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (is_user_bot(id) && tsm_side_of(id) == 2)
		{
			tsm_set_class(id, cls);
		}
	}
}

/*
 * The next wave: the count goes up, the survivors come back in full, the mutants come back
 * stronger, and everyone hears it.
 */
next_wave()
{
	g_breather_until = 0.0;
	g_wave++;
	g_last_count = 0;
	g_last_change = get_gametime();

	// Every survivor's lives set to their class's again, the fallen among them back now.
	if (tsm_reward_lives(1) < 0 && !g_told_respawns)
	{
		g_told_respawns = true;
		log_amx("[SURVIVAL] tsm_respawns is 0, so the survivors cannot be brought back between waves -- set it to 1 for %s.",
			g_mapname);
	}
	tsm_fire_wave(1);

	// And the mutants, every one of them, armed for this wave as they arrive (tsm_loadout).
	tsm_fire_wave(2);

	sting();
	refresh_hud();

	set_hudmessage(255, 80, 60, -1.0, 0.32, 0, 0.0, 2.5, 0.1, 0.5, 4);
	show_hudmessage(0, "WAVE %d", g_wave);
	client_print(0, print_chat, "[MATCH] WAVE %d -- the fallen are back with you. Hold them off.", g_wave);

	// The milestones, said once each as they arrive.
	if (g_wave == 16)
	{
		client_print(0, print_chat, "[MATCH] More of them carry guns now.");
	}
	else if (g_wave == 25)
	{
		client_print(0, print_chat, "[MATCH] Every one of them is armed now.");
	}
	new kfa = get_pcvar_num(g_cv_kungfu);
	if (kfa > 0 && g_wave == kfa + 1)
	{
		client_print(0, print_chat, "[MATCH] They have learned kung fu.");
	}
}

/// The wave sting, for every person on the server at full volume wherever they stand.
sting()
{
	new snd[64];
	get_pcvar_string(g_cv_sound, snd, charsmax(snd));
	if (!snd[0])
	{
		return;
	}
	// Only the default sting is precached here; another file has to reach the clients some other way.
	if (equal(snd, WS_STING) && !g_sting_ok)
	{
		return;
	}
	new players[32], pnum;
	get_players(players, pnum, "c");
	for (new i = 0; i < pnum; i++)
	{
		client_cmd(players[i], "playvol %s 1.0", snd);
	}
}

/// The round line's wave count and the Discord card's progress.
refresh_hud()
{
	if (!g_active)
	{
		return;
	}
	new line[24], prog[8];
	formatex(line, charsmax(line), "WAVE %d", g_wave);
	tsm_hud_line(line);
	num_to_str(g_wave, prog, charsmax(prog));
	tsm_set_progress(prog);
}

/* ---- arming the mutants (include\tsm_api.inc) ---------------------------------------------- */

/// The chance, in percent, that a mutant of this wave carries a gun: tsm_ws_gun_odds' step for it.
gun_odds(wave)
{
	new spec[96], rest[96], carry[96], pair[16], wpart[8], ppart[8];
	get_pcvar_string(g_cv_odds, spec, charsmax(spec));
	copy(rest, charsmax(rest), spec);
	new pct = 40;
	while (rest[0])
	{
		strtok(rest, pair, charsmax(pair), carry, charsmax(carry), ',', 1);
		copy(rest, charsmax(rest), carry);
		if (!pair[0])
		{
			continue;
		}
		strtok(pair, wpart, charsmax(wpart), ppart, charsmax(ppart), ':', 1);
		if (wave >= str_to_num(wpart))
		{
			pct = str_to_num(ppart);
		}
	}
	return pct;
}

/// One entry, picked at random, from a comma-separated list cvar.
pick_from(cvar, out[], len)
{
	new list[128], rest[128], carry[128], item[24];
	get_pcvar_string(cvar, list, charsmax(list));

	// Counted first, then walked to the chosen one.
	new count = 0;
	copy(rest, charsmax(rest), list);
	while (rest[0])
	{
		strtok(rest, item, charsmax(item), carry, charsmax(carry), ',', 1);
		copy(rest, charsmax(rest), carry);
		if (item[0])
		{
			count++;
		}
	}
	out[0] = 0;
	if (!count)
	{
		return 0;
	}

	new want = random_num(0, count - 1), at = 0;
	copy(rest, charsmax(rest), list);
	while (rest[0])
	{
		strtok(rest, item, charsmax(item), carry, charsmax(carry), ',', 1);
		copy(rest, charsmax(rest), carry);
		if (!item[0])
		{
			continue;
		}
		if (at == want)
		{
			copy(out, len, item);
			return 1;
		}
		at++;
	}
	return 0;
}

/*
 * A mutant is about to be armed: a gun or a blade, rolled by this wave's odds. The answer goes
 * back to ts_matchmode as a weapon list ("13:3", "34:0", or "" for bare hands), which it hands
 * over exactly as it would a class line. Side 1 is left to its classes.
 */
public tsm_loadout(id, spec[], len)
{
	if (!g_active || tsm_side_of(id) != 2)
	{
		return PLUGIN_CONTINUE;
	}

	new pick[24];
	if (random_num(1, 100) <= gun_odds(g_wave))
	{
		pick_from(g_cv_guns, pick, charsmax(pick));
		copy(spec, len - 1, pick);
	}
	else
	{
		pick_from(g_cv_melee, pick, charsmax(pick));
		new w = str_to_num(pick);
		if (w > 0)
		{
			formatex(spec, len - 1, "%d:0", w);
		}
		else
		{
			spec[0] = 0;   // bare hands
		}
	}
	return PLUGIN_HANDLED;
}

/// The mutant is armed: this wave's health, and the kung fu powerup once the waves are past it.
public tsm_armed(id)
{
	if (!g_active || tsm_side_of(id) != 2 || !is_user_alive(id))
	{
		return;
	}

	new base = tsm_class_hp(id);
	if (base > 0)
	{
		new pct = get_pcvar_num(g_cv_hp);
		new hp = base + (base * pct * (g_wave - 1)) / 100;
		if (hp > base)
		{
			set_user_health(id, hp);
		}
	}

	new kfa = get_pcvar_num(g_cv_kungfu);
	if (kfa > 0 && g_wave > kfa)
	{
		tsm_give_powerup(id, WS_PWUP_KUNGFU);
	}
}

/* ---- the round, from ts_matchmode -------------------------------------------------------- */

public tsm_round_start(round)
{
	#pragma unused round
	if (!g_active)
	{
		return;
	}
	g_wave = 1;
	g_breather_until = 0.0;
	g_last_count = 0;
	g_last_change = get_gametime();
	keep_mutant_classes();
	refresh_hud();
}

public tsm_round_live(round)
{
	#pragma unused round
	if (!g_active)
	{
		return;
	}
	g_last_change = get_gametime();
	sting();
	client_print(0, print_chat, "[MATCH] WAVE 1 -- hold them off. Every wave you clear brings your fallen back.");
}

/// The run is over: how far the survivors got, and the best on this map since it loaded.
public tsm_round_end(winner)
{
	if (!g_active)
	{
		return;
	}
	g_breather_until = 0.0;

	if (winner == 2)
	{
		client_print(0, print_chat, "[MATCH] The survivors held out to wave %d -- %d wave(s) cleared.", g_wave, g_wave - 1);
	}
	else
	{
		client_print(0, print_chat, "[MATCH] The run ended on wave %d.", g_wave);
	}

	if (g_wave > g_best)
	{
		if (g_best > 0)
		{
			client_print(0, print_chat, "[MATCH] A new best on this map -- the last was wave %d.", g_best);
		}
		g_best = g_wave;
	}
	else
	{
		client_print(0, print_chat, "[MATCH] The best on this map is wave %d.", g_best);
	}
}

/* ---- commands --------------------------------------------------------------------------- */

public cmd_ws_dump(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	console_print(id, "[SURVIVAL] build %s  active=%d core=%d mode=%d  map=%s", WS_BUILD,
		g_active ? 1 : 0, g_have_core ? 1 : 0, get_pcvar_num(g_cv_mode), g_mapname);
	console_print(id, "[SURVIVAL] wave %d (best %d), gun odds %d%%, mutants up %d, side 2 in the round %d",
		g_wave, g_best, gun_odds(g_wave), mutants_in_play(), tsm_side_alive(2));
	console_print(id, "[SURVIVAL] breather %s, %.0fs since a mutant last fell, sting %s",
		(g_breather_until > 0.0) ? "running" : "off", get_gametime() - g_last_change, g_sting_ok ? "precached" : "MISSING");
	return PLUGIN_HANDLED;
}

public cmd_ws_wave(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new n = str_to_num(a);
	if (n < 1)
	{
		console_print(id, "[SURVIVAL] usage: amx_tsm_ws_wave <n>, 1 or more");
		return PLUGIN_HANDLED;
	}
	g_wave = n;
	refresh_hud();
	console_print(id, "[SURVIVAL] Wave count set to %d: gun odds %d%%, mutants at +%d%% health from their next arming.",
		g_wave, gun_odds(g_wave), get_pcvar_num(g_cv_hp) * (g_wave - 1));
	return PLUGIN_HANDLED;
}
