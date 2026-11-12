/*
 * ts_survival.sma -- WAVE SURVIVAL, a mode for ts_matchmode.
 *
 * Side 1 is the people: the class menu, their class lives, ready-up as always. Side 2 is the
 * enemy wave, bots only -- a person picking it is made a spectator -- and it never runs out:
 * every mutant that falls comes back with the next wave. tsm_ws_human_side 2 swaps them: the
 * people play side 2 and the mutants are side 1's bots.
 *
 * A WAVE IS A WHOLE SET OF MUTANTS. The next one does not come until every mutant of the one
 * before is dead. Clearing a wave starts a breather, tsm_ws_wave seconds counted down on
 * everyone's screen, and then the next wave comes all at once: the wave count goes up, the
 * sting plays for everyone, every fallen survivor comes back with it and every survivor's
 * lives are set to their class's count again. Each wave is a new round for the once-a-round
 * abilities too: the stim, .ammo, the class abilities and the Mech's rockets are all ready
 * again. There is no round clock and no sudden death:
 * the run goes on until the people's side is wiped out -- nobody standing, no lives left, nobody waiting
 * -- and then the match is over, chat says how far they got, and it is back to warmup.
 *
 * LATE JOINERS AND CLASS CHANGES. The claim asks ts_matchmode for both, which is what tsm_latejoin 2 and tsm_classchange 2
 * mean (their default, 1, gives every mode both): a person who arrives while a run is going takes the people's side from the side menu, waits
 * as a ghost like a fallen survivor and comes in with the next respawn wave of the people's side, the one that
 * comes with each cleared wave of mutants included. A player may type .class at any time for another class,
 * which he has on when he next comes back from a death. A late joiner is not counted as standing or waiting, so
 * he never keeps a lost run open.
 *
 * THE WAVES GROW. Each mutant spawns with its class's health plus tsm_ws_hp_per_wave percent
 * for every wave after the first, and rolls a gun or a blade by tsm_ws_gun_odds: 40% armed
 * at first, 60% from wave 16, every one of them from wave 25. After wave tsm_ws_kungfu_after
 * (30) each comes back with the kung fu powerup as well. From wave tsm_ws_mech_after (25) a
 * growing share of them play the Mech class instead.
 *
 * OVERTIME. A wave that runs past tsm_ws_overtime seconds (225) starts costing the mutants
 * tsm_ws_overtime_hp health a second each, in the sudden-death fog, until the wave is cleared.
 *
 * WHICH MAPS. Any map whose name starts h9_ws_, while tsm_mutants_mode is 1. A map with
 * siege objectives stays a siege map (ts_matchmode refuses the claim), and the first mode to
 * claim a map keeps it. The bots' side needs bots: tsm_bots in ts_matchmode.cfg.
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
#include <h9_vgui>    // an H9 game shows the wave's flash as a notice

#define PLUGIN  "TS Wave Survival"
#define VERSION "1.0"
#define AUTHOR  "tsm"

#define WS_BUILD "1.0-modes2"

#define WS_TICK        0.5
#define WS_TASK_TICK   71201
#define WS_TASK_CLAIM  71202

#define WS_PWUP_KUNGFU 4          // TSPWUP_KUNGFU in tsconst.inc
#define WS_STING       "xom_laugh.wav"
#define WS_STING_FILE  "sound/xom_laugh.wav"
#define WS_PREFIX      "h9_ws_"
#define WS_MAXP        (MAX_PLAYERS + 1)   // player slots, 1-based

new g_cv_mode, g_cv_breather, g_cv_class, g_cv_odds, g_cv_guns, g_cv_melee, g_cv_hp, g_cv_kungfu;
new g_cv_sound, g_cv_stall, g_cv_desc;
new g_cv_hside, g_cv_ot, g_cv_ot_hp, g_cv_ot_fog, g_cv_mech_after, g_cv_mech_per;

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

new g_bside = 2;               // the mutants' side this map: the other one is the people's

new Float:g_wave_began;        // when the wave being fought started
new bool:g_ot_on;              // overtime is running
new bool:g_ot_fog;             // overtime turned the fog on
new Float:g_ot_next;           // the next second of the drain

new bool:g_mech[WS_MAXP];      // this mutant's roll for the wave: it plays the Mech class
new g_mech_wave[WS_MAXP];      // the wave that roll was made for

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
	h9vgui_precache(); // H9Vgui, the notices' message (h9_vgui.inc)

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
	h9vgui_init("sur");

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
	g_cv_hside    = register_cvar("tsm_ws_human_side",     "1");
	g_cv_ot       = register_cvar("tsm_ws_overtime",       "225");
	g_cv_ot_hp    = register_cvar("tsm_ws_overtime_hp",    "2");
	g_cv_ot_fog   = register_cvar("tsm_ws_overtime_fog",   "1");
	g_cv_mech_after = register_cvar("tsm_ws_mech_after",   "25");
	g_cv_mech_per = register_cvar("tsm_ws_mech_per_wave",  "1");

	register_concmd("amx_tsm_ws",      "cmd_ws_dump", ADMIN_CFG, " - the survival mode's whole state");
	register_concmd("amx_tsm_ws_wave", "cmd_ws_wave", ADMIN_CFG, " <n> - set the wave count, to test how the waves grow");
	register_concmd("amx_tsm_ws_mechs", "cmd_ws_mechs", ADMIN_CFG, " - how many mutants play the Mech class");
}

public plugin_end()
{
	overtime_end();
}

public client_putinserver(id)
{
	mech_forget(id);
}

/// Clears one slot's Mech roll, so a bot that takes over the slot is rolled afresh.
mech_forget(id)
{
	if (id >= 1 && id < WS_MAXP)
	{
		g_mech[id] = false;
		g_mech_wave[id] = 0;
	}
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
	// tsm_enabled 0: the map plays as the game ships (ts_matchmode's per-map rule, or the map's mapconfig).
	new bool:want = (g_have_core && get_pcvar_num(g_cv_mode) != 0 && get_cvar_num("tsm_enabled") != 0
		&& equali(g_mapname, WS_PREFIX, strlen(WS_PREFIX)));

	if (want)
	{
		new desc[64];
		get_pcvar_string(g_cv_desc, desc, charsmax(desc));
		if (!desc[0])
		{
			copy(desc, charsmax(desc), "Wave Survival");
		}
		// The mutants' side is set before the claim, which reads it; a core without the native keeps side 2.
		tsm_set_bot_side((get_pcvar_num(g_cv_hside) == 2) ? 1 : 2);
		g_bside = (tsm_bot_side() == 1) ? 1 : 2;
		if (get_pcvar_num(g_cv_hside) == 2 && g_bside != 1)
		{
			log_amx("[SURVIVAL] tsm_ws_human_side 2 is set but the core did not move the bots to side 1 (core too old?): the people play side 1.");
		}
		if (tsm_mode_claim("survival", desc,
			TSM_MODE_NO_SUDDEN | TSM_MODE_NO_CLOCK | TSM_MODE_SIDE2_BOTS | TSM_MODE_SIDE2_ENDLESS | TSM_MODE_ONE_RUN | TSM_MODE_NO_REINFORCE | TSM_MODE_NO_ROUNDS
			| TSM_MODE_LATE_JOIN | TSM_MODE_CLASS_CHANGE))
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
		if (want)
		{
			tsm_set_bot_side(2);
		}
		g_bside = 2;
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

	// The mutants' waves are this plugin's to bring: no timer, the dead wait for the clear.
	tsm_wave_seconds(g_bside, -1.0);

	// The mutants' weapons are this plugin's alone: rcbot hands out none and picks none up.
	server_cmd("rcbot config ts_kungfu 1");
	server_cmd("rcbot config ts_dont_pickup_weapons 1");
	set_localinfo("tsm_ws_rcbot", "1");

	if (!get_cvar_num("tsm_bots"))
	{
		log_amx("[SURVIVAL] %s is a survival map but tsm_bots is 0 -- side %d is bots only, so nothing will attack.", g_mapname, g_bside);
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
		overtime_end();
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
			// An H9 game shows it on ts_matchmode's match bar, counting down by itself; every
			// other game gets the hudmessage, each second.
			new bar[64];
			formatex(bar, charsmax(bar), "WAVE %d CLEARED -- NEXT WAVE IN {s}", g_wave);
			tsm_hud_count(bar, left);
			set_hudmessage(255, 200, 80, -1.0, 0.28, 0, 0.0, 0.6, 0.0, 0.1, 2);
			new players[MAX_PLAYERS], pnum;
			get_players(players, pnum, "c");
			for (new i = 0; i < pnum; i++)
			{
				if (!tsm_bar_shown(players[i]))
				{
					show_hudmessage(players[i], "WAVE %d CLEARED^nNext wave in %d", g_wave, left);
				}
			}
			return;
		}
		tsm_hud_count("", 0);
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
		overtime_step(now);

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
			mode_chat(0, "[MATCH] The last mutants were lost in the drains -- wave %d is cleared.", g_wave);
		}
		return;
	}

	// Every mutant of this wave is down (and the mutants' side has members at all): the breather begins.
	if (tsm_side_alive(g_bside) > 0)
	{
		overtime_end();
		new Float:wait = get_pcvar_float(g_cv_breather);
		if (wait < 0.0)
		{
			wait = 0.0;
		}
		g_breather_until = now + wait;
		if (wait > 0.0)
		{
			mode_chat(0, "[MATCH] Wave %d cleared! The next wave comes in %d seconds.", g_wave, floatround(wait));
		}

		// Everyone still in play on the survivors' side has survived the wave (ts_matchmode's
		// tsm_score_wave each).
		new pl[MAX_PLAYERS], pn;
		get_players(pl, pn, "");
		for (new i = 0; i < pn; i++)
		{
			if (tsm_side_of(pl[i]) == 3 - g_bside && tsm_in_play(pl[i]))
			{
				tsm_points_award(pl[i], TSM_POINTS_WAVE);
			}
		}
	}
}

/// How many mutants are on their feet right now: the mutants' side, alive and in play.
mutants_in_play()
{
	new players[MAX_PLAYERS], pnum, n = 0;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		if (tsm_side_of(players[i]) == g_bside && tsm_in_play(players[i]))
		{
			n++;
		}
	}
	return n;
}

slay_stragglers()
{
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (tsm_side_of(id) == g_bside && tsm_in_play(id))
		{
			user_kill(id, 1);
		}
	}
	g_last_change = get_gametime();
}

/// Every mutant plays tsm_ws_class (its model and its base health), or the Mech where its roll for the wave says so. Bots only,
/// the mutants' side only.
keep_mutant_classes()
{
	new cls = get_pcvar_num(g_cv_class);
	new mech = tsm_class_of_perk(TSM_PERK_MECH);
	if (cls < 1 && !mech)
	{
		return;
	}
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (is_user_bot(id) && tsm_side_of(id) == g_bside)
		{
			// A mutant that came in since the wave's roll, still waiting to be armed, is rolled now.
			if (g_mech_wave[id] != g_wave && !is_user_alive(id))
			{
				roll_mech(id);
			}
			if (mech && g_mech[id])
			{
				tsm_set_class(id, mech);
			}
			else if (cls >= 1)
			{
				tsm_set_class(id, cls);
			}
		}
	}
}

/// The chance, in percent, that a mutant of this wave plays the Mech: tsm_ws_mech_per_wave for each wave from tsm_ws_mech_after on, 100 at most.
mech_chance(wave)
{
	new per = get_pcvar_num(g_cv_mech_per);
	new after = get_pcvar_num(g_cv_mech_after);
	if (after < 1)
	{
		after = 1;
	}
	if (per <= 0 || wave < after)
	{
		return 0;
	}
	return clamp((wave - after + 1) * per, 0, 100);
}

/// One mutant's roll for the wave being fought: kept until the next wave rolls again.
roll_mech(id)
{
	g_mech_wave[id] = g_wave;
	g_mech[id] = false;
	new pct = mech_chance(g_wave);
	if (pct > 0 && tsm_class_of_perk(TSM_PERK_MECH) > 0 && random_num(1, 100) <= pct)
	{
		g_mech[id] = true;
	}
}

/// Every mutant rolled for the wave about to come. standing: leave a mutant that is on its feet alone, as its class cannot change under it.
roll_mechs(bool:standing)
{
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!is_user_bot(id) || tsm_side_of(id) != g_bside)
		{
			continue;
		}
		if (standing && is_user_alive(id) && tsm_in_play(id))
		{
			continue;
		}
		roll_mech(id);
	}
}

/* ---- overtime ------------------------------------------------------------------------------ */

/// Past tsm_ws_overtime seconds of a wave, the mutants lose tsm_ws_overtime_hp health a second each until the wave is cleared.
overtime_step(Float:now)
{
	new limit = get_pcvar_num(g_cv_ot);
	if (limit <= 0)
	{
		overtime_end();
		return;
	}

	if (!g_ot_on)
	{
		if (now - g_wave_began < float(limit))
		{
			return;
		}
		g_ot_on = true;
		g_ot_next = now;
		if (get_pcvar_num(g_cv_ot_fog) != 0 && tsm_fog(true))
		{
			g_ot_fog = true;
		}

		set_hudmessage(255, 80, 60, -1.0, 0.36, 0, 0.0, 3.0, 0.1, 0.5, 4);
		h9vgui_alert(0, "sur.overtime", H9V_NOTICE_FLASH, "OVERTIME^nThe mutants are weakening", 255, 80, 60, 0.36, 3.0, 0.5);
		mode_chat(0, "[MATCH] OVERTIME. The mutants lose health every second until the wave is cleared.");
	}

	new step = get_pcvar_num(g_cv_ot_hp);
	if (step < 1 || now + 0.05 < g_ot_next)
	{
		return;
	}
	g_ot_next = (now - g_ot_next > 2.0) ? now + 1.0 : g_ot_next + 1.0;

	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!is_user_bot(id) || tsm_side_of(id) != g_bside || !tsm_in_play(id))
		{
			continue;
		}
		new hp = get_user_health(id);
		if (hp > step)
		{
			set_user_health(id, hp - step);
		}
		else
		{
			user_kill(id);
		}
	}
}

/// Overtime over: the drain stops and the fog it brought is lifted.
overtime_end()
{
	if (g_ot_fog)
	{
		tsm_fog(false);
	}
	g_ot_fog = false;
	g_ot_on = false;
}

/*
 * The next wave: the count goes up, the survivors come back in full with their once-a-round
 * abilities ready again, the mutants come back stronger, and everyone hears it.
 */
next_wave()
{
	g_breather_until = 0.0;
	g_wave++;
	g_last_count = 0;
	g_last_change = get_gametime();
	g_wave_began = g_last_change;
	overtime_end();

	// The mutants' roll for the Mech, and the class it gives, before they are brought back.
	roll_mechs(true);
	keep_mutant_classes();

	// Every survivor's lives set to their class's again, the fallen among them back now.
	new restored = tsm_reward_lives(3 - g_bside);
	if (restored < 0 && !g_told_respawns)
	{
		g_told_respawns = true;
		log_amx("[SURVIVAL] tsm_respawns is 0, so the survivors cannot be brought back between waves -- set it to 1 for %s.",
			g_mapname);
	}
	tsm_fire_wave(3 - g_bside);

	// And the mutants, every one of them, armed for this wave as they arrive (tsm_loadout).
	tsm_fire_wave(g_bside);

	// A wave is a new round for what can be used once a round: the stim, .ammo, the class
	// abilities, the Mech's rockets.
	tsm_refresh_abilities(0);

	sting();
	refresh_hud();

	set_hudmessage(255, 80, 60, -1.0, 0.32, 0, 0.0, 2.5, 0.1, 0.5, 4);
	new text[16];
	formatex(text, charsmax(text), "WAVE %d", g_wave);
	h9vgui_alert(0, "sur.wave", H9V_NOTICE_FLASH, text, 255, 80, 60, 0.32, 2.5, 0.5);
	if (restored < 0)
	{
		// tsm_respawns 0: nobody comes back, so nothing is said about lives
		mode_chat(0, "[MATCH] WAVE %d. Your .stim, .ammo and class abilities are ready again. Hold them off.", g_wave);
	}
	else
	{
		mode_chat(0, "[MATCH] WAVE %d. Everyone who fell is back, every survivor has full lives again, and .stim, .ammo and class abilities are ready. Hold them off.", g_wave);
	}

	// The milestones, said once each as they arrive.
	if (g_wave == 16)
	{
		mode_chat(0, "[MATCH] More of them carry guns now.");
	}
	else if (g_wave == 25)
	{
		mode_chat(0, "[MATCH] Every one of them is armed now.");
	}
	new kfa = get_pcvar_num(g_cv_kungfu);
	if (kfa > 0 && g_wave == kfa + 1)
	{
		mode_chat(0, "[MATCH] They have learned kung fu.");
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
	new players[MAX_PLAYERS], pnum;
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
 * over exactly as it would a class line. The people are left to their classes, and so is a Mech.
 */
public tsm_loadout(id, spec[], len)
{
	if (!g_active || id < 1 || id >= WS_MAXP || tsm_side_of(id) != g_bside || g_mech[id])
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

/// The mutant is armed: this wave's health, and the kung fu powerup once the waves are past it. A Mech keeps its class's health and kit.
public tsm_armed(id)
{
	if (!g_active || id < 1 || id >= WS_MAXP || tsm_side_of(id) != g_bside || !is_user_alive(id) || g_mech[id])
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
	overtime_end();
	for (new i = 1; i < WS_MAXP; i++)
	{
		mech_forget(i);
	}
	roll_mechs(false);
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
	g_wave_began = g_last_change;
	sting();
	if (get_cvar_num("tsm_respawns"))
	{
		mode_chat(0, "[MATCH] WAVE 1. Hold them off. Clear a wave and everyone who fell comes back for the next one, with full lives.");
	}
	else
	{
		mode_chat(0, "[MATCH] WAVE 1. Hold them off. One life each: whoever falls is out for the rest of the run.");
	}
}

/*
 * A survivor is down, said plainly. The core's own line, "1 life left -- back in the next wave",
 * reads here as if the mutants' next WAVE were meant, when it is the side's own respawn: this mode
 * has two kinds of wave, so it says which. Nothing is said for a mutant (their side never runs out).
 */
public tsm_life_lost(id, left)
{
	if (!g_active || tsm_side_of(id) != 3 - g_bside)
	{
		return PLUGIN_CONTINUE;
	}
	if (left > 0)
	{
		mode_chat(id, "[MATCH] You are down, with %d %s left. You come back at your side's next respawn (the countdown on your screen), or when this wave of mutants is cleared.",
			left, left == 1 ? "life" : "lives");
	}
	else
	{
		mode_chat(id, "[MATCH] You are down, with no lives left. If your side clears this wave of mutants, you come back for the next one.");
	}
	return PLUGIN_HANDLED;
}

/*
 * A person has taken the people's side while the run goes on. He comes in with the next respawn wave of his side, which is the
 * side's own countdown (on his screen) or the wave that follows when every mutant of this one has fallen, whichever is first.
 */
public tsm_late_wait(id)
{
	if (!g_active)
	{
		return PLUGIN_CONTINUE;
	}
	mode_chat(id, "[MATCH] You are in the run. You come in at your side's next respawn (the countdown on your screen) or when this wave of mutants is cleared. Pick your class with .class.");
	return PLUGIN_HANDLED;
}

/// The run is over: how far the survivors got, and the best on this map since it loaded.
public tsm_round_end(winner)
{
	if (!g_active)
	{
		return;
	}
	g_breather_until = 0.0;
	overtime_end();

	if (winner == g_bside)
	{
		mode_chat(0, "[MATCH] The survivors held out to wave %d -- %d wave(s) cleared.", g_wave, g_wave - 1);
	}
	else
	{
		mode_chat(0, "[MATCH] The run ended on wave %d.", g_wave);
	}

	if (g_wave > g_best)
	{
		if (g_best > 0)
		{
			mode_chat(0, "[MATCH] A new best on this map -- the last was wave %d.", g_best);
		}
		g_best = g_wave;
	}
	else
	{
		mode_chat(0, "[MATCH] The best on this map is wave %d.", g_best);
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
	console_print(id, "[SURVIVAL] wave %d (best %d), gun odds %d%%, mutants up %d, side %d (the mutants) in the round %d",
		g_wave, g_best, gun_odds(g_wave), mutants_in_play(), g_bside, tsm_side_alive(g_bside));
	console_print(id, "[SURVIVAL] Mech chance %d%%, overtime %s (%.0fs into the wave)",
		mech_chance(g_wave), g_ot_on ? "running" : "off", get_gametime() - g_wave_began);
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

public cmd_ws_mechs(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new players[MAX_PLAYERS], pnum, bots = 0, mechs = 0, up = 0;
	get_players(players, pnum, "");
	for (new i = 0; i < pnum; i++)
	{
		new bot = players[i];
		if (!is_user_bot(bot) || tsm_side_of(bot) != g_bside)
		{
			continue;
		}
		bots++;
		if (g_mech[bot])
		{
			mechs++;
			if (is_user_alive(bot))
			{
				up++;
			}
		}
	}
	console_print(id, "[SURVIVAL] %d of %d mutants play the Mech class (%d on their feet); wave %d, Mech chance %d%%.",
		mechs, bots, up, g_wave, mech_chance(g_wave));
	return PLUGIN_HANDLED;
}

/// A "[MATCH]" chat line, kept off the chat while ts_matchmode's tsm_verbosity is 0, as its own
/// are: the mode is then told by what players see (the HUD, the scoreboard, the centre texts).
/// With no ts_matchmode to ask, the line goes out.
mode_chat(id, const fmt[], any:...)
{
	new verbosity = get_cvar_pointer("tsm_verbosity");
	if (verbosity && !get_pcvar_num(verbosity))
	{
		return;
	}
	new msg[256];
	vformat(msg, charsmax(msg), fmt, 3);
	client_print(id, print_chat, "%s", msg);
}
