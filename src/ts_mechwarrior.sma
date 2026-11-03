/*
 * ts_mechwarrior.sma -- MECH WARRIOR, a mode for ts_matchmode.
 *
 * The match with the classes cut down to two: each side gets one Officer, on two lives, and
 * as many Mechs as it likes, on three lives each. Every other class is gone from the class
 * menu, and every bot plays a Mech. The rest is the match as ts_matchmode plays it:
 * elimination rounds, the fallen back with their side's respawn wave while their lives last,
 * sudden death, the score and the match's end.
 *
 * WHICH MAPS. Any map whose name starts h9_mw_, while tsm_mechwarrior_mode is 1. A map with
 * siege objectives stays a siege map (ts_matchmode refuses the claim), and the first mode to
 * claim a map keeps it.
 *
 * THE CLASSES. Found by their perks in ts_matchmode.cfg -- the Officer's and the Mech's --
 * not by their numbers, so reordering the tsm_classN lines does not break the mode.
 * tsm_mw_officers, tsm_mw_officer_lives, tsm_mw_mechs and tsm_mw_mech_lives set the counts.
 * They are read at the claim and again as each round starts, so a mapconfig or a console
 * change takes effect from the next round. The lives need tsm_respawns 1.
 *
 * THE MODE API. Everything comes through include\tsm_api.inc. With ts_matchmode missing, or
 * too old to take class rules, the native filter lets this plugin load, and it does nothing.
 */

#include <amxmodx>
#include <amxmisc>
#include <tsm_api>

#define PLUGIN  "TS Mech Warrior"
#define VERSION "1.0"
#define AUTHOR  "tsm"

#define MW_BUILD "1.0-modes2"

#define MW_TASK_CLAIM  71301
#define MW_PREFIX      "h9_mw_"

new g_cv_mode, g_cv_desc, g_cv_officers, g_cv_officer_lives, g_cv_mechs, g_cv_mech_lives;

new bool:g_have_core = true;   // cleared by the native filter when ts_matchmode is not loaded
new bool:g_active = false;     // this map is claimed for Mech Warrior
new g_mapname[32];
new g_officer;                 // the Officer's class, 1 and up; 0 when ts_matchmode.cfg has none
new g_mech;                    // the Mech's class, 1 and up
new g_rules[4] = { -1, ... };  // the counts last applied, for the log: officers, their lives, mechs, theirs

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

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_mode          = register_cvar("tsm_mechwarrior_mode",     "1");
	g_cv_desc          = register_cvar("tsm_gamedesc_mechwarrior", "Mech Warrior");
	g_cv_officers      = register_cvar("tsm_mw_officers",          "1");
	g_cv_officer_lives = register_cvar("tsm_mw_officer_lives",     "2");
	g_cv_mechs         = register_cvar("tsm_mw_mechs",             "0");
	g_cv_mech_lives    = register_cvar("tsm_mw_mech_lives",        "3");

	register_concmd("amx_tsm_mw", "cmd_mw_dump", ADMIN_CFG, " - the Mech Warrior mode's whole state");
}

public plugin_cfg()
{
	get_mapname(g_mapname, charsmax(g_mapname));

	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_mechwarrior.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// After the map's entities and h9_autoconfig's ts/mapconfigs/<map>.cfg, like the other modes.
	set_task(2.0, "task_claim", MW_TASK_CLAIM);
}

/* ---- the claim -------------------------------------------------------------------------- */

public task_claim()
{
	// tsm_enabled 0: the map plays as the game ships (ts_matchmode's per-map rule, or the map's mapconfig).
	if (!g_have_core || !get_pcvar_num(g_cv_mode) || !equali(g_mapname, MW_PREFIX, strlen(MW_PREFIX)) || !get_cvar_num("tsm_enabled"))
	{
		return;
	}

	// The two classes the mode is played with, by their perks. tsm_class_count() is also the
	// test for a ts_matchmode new enough to take class rules: an older one leaves it unbound.
	new classes = tsm_class_count();
	g_officer = tsm_class_of_perk(TSM_PERK_OFFICER);
	g_mech = tsm_class_of_perk(TSM_PERK_MECH);
	if (!g_have_core || !classes)
	{
		log_amx("[MECHWARRIOR] %s wanted Mech Warrior but ts_matchmode is missing or too old for class rules.", g_mapname);
		return;
	}
	if (!g_mech)
	{
		log_amx("[MECHWARRIOR] %s wanted Mech Warrior but ts_matchmode.cfg has no Mech class (perk 7).", g_mapname);
		return;
	}

	new desc[64];
	get_pcvar_string(g_cv_desc, desc, charsmax(desc));
	if (!desc[0])
	{
		copy(desc, charsmax(desc), "Mech Warrior");
	}
	if (!tsm_mode_claim("mechwarrior", desc, 0))
	{
		log_amx("[MECHWARRIOR] %s wanted Mech Warrior but the claim was refused (siege objectives or another mode).",
			g_mapname);
		return;
	}

	g_active = true;
	apply_rules();
	log_amx("[MECHWARRIOR] %s is a Mech Warrior map: class %d is the Officer, class %d the Mech.",
		g_mapname, g_officer, g_mech);
}

/*
 * The class rules, from the cvars: the Officer limited to tsm_mw_officers a side on
 * tsm_mw_officer_lives lives (0 officers is no Officer at all), the Mech to tsm_mw_mechs a
 * side (0 no limit) on tsm_mw_mech_lives, every other class not played, and every bot a Mech.
 * Logged when the counts change.
 */
apply_rules()
{
	new rules[4];
	rules[0] = max(get_pcvar_num(g_cv_officers), 0);
	rules[1] = max(get_pcvar_num(g_cv_officer_lives), 1);
	rules[2] = max(get_pcvar_num(g_cv_mechs), 0);
	rules[3] = max(get_pcvar_num(g_cv_mech_lives), 1);

	new count = tsm_class_count();
	for (new cls = 1; cls <= count; cls++)
	{
		if (cls == g_officer)
		{
			tsm_class_rule(cls, rules[0] ? rules[0] : -1, rules[1]);
		}
		else if (cls == g_mech)
		{
			tsm_class_rule(cls, rules[2], rules[3]);
		}
		else
		{
			tsm_class_rule(cls, -1, 0);
		}
	}
	tsm_mode_bot_class(g_mech);

	if (rules[0] == g_rules[0] && rules[1] == g_rules[1] && rules[2] == g_rules[2] && rules[3] == g_rules[3])
	{
		return;
	}
	for (new i = 0; i < 4; i++)
	{
		g_rules[i] = rules[i];
	}
	new mechs[16];
	if (rules[2])
	{
		num_to_str(rules[2], mechs, charsmax(mechs));
	}
	else
	{
		copy(mechs, charsmax(mechs), "any number of");
	}
	log_amx("[MECHWARRIOR] Each side: %d Officer(s) on %d lives, %s Mechs on %d lives each.",
		g_officer ? rules[0] : 0, rules[1], mechs, rules[3]);
}

/* ---- the rounds (include\tsm_api.inc) ---------------------------------------------------- */

public tsm_round_start(round)
{
	#pragma unused round
	if (g_active)
	{
		apply_rules();
	}
}

/* ---- the admin's view ------------------------------------------------------------------- */

public cmd_mw_dump(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	console_print(id, "[MECHWARRIOR] build %s  active=%d core=%d mode=%d  map=%s", MW_BUILD,
		g_active ? 1 : 0, g_have_core ? 1 : 0, get_pcvar_num(g_cv_mode), g_mapname);
	console_print(id, "[MECHWARRIOR] Officer class %d: %d a side on %d lives.  Mech class %d: %d a side (0 no limit) on %d lives.",
		g_officer, g_rules[0], g_rules[1], g_mech, g_rules[2], g_rules[3]);
	console_print(id, "[MECHWARRIOR] Every other class is not played, and every bot plays the Mech.  Side 1 in the round %d, side 2 %d.",
		tsm_side_alive(1), tsm_side_alive(2));
	return PLUGIN_HANDLED;
}
