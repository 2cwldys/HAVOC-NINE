/*
 * ts_mechwarrior.sma -- MECH WARRIOR, a mode for ts_matchmode.
 *
 * The match with the classes cut down: each side gets one Officer, on two lives, as many Mechs
 * as it likes, on three lives each, and the Combat Engineer, who keeps the Mechs in ammunition
 * and stands up turrets and transporter pads. Every other class is gone from the class menu,
 * and every bot plays a Mech. The rest is the match as ts_matchmode plays it:
 * elimination rounds, the fallen back with their side's respawn wave while their lives last,
 * sudden death, the score and the match's end.
 *
 * WHICH MAPS. Any map whose name starts h9_mw_, while tsm_mechwarrior_mode is 1. A map with
 * siege objectives stays a siege map (ts_matchmode refuses the claim), and the first mode to
 * claim a map keeps it.
 *
 * THE CLASSES. Found by their perks in ts_matchmode.cfg -- the Officer's, the Mech's and the
 * Combat Engineer's -- not by their numbers, so reordering the tsm_classN lines does not break
 * the mode. tsm_mw_officers, tsm_mw_officer_lives, tsm_mw_mechs and tsm_mw_mech_lives set the
 * counts. tsm_mw_engineer lets the Combat Engineer in, at his class's own limit a side
 * (tsm_class_limits) and on its own lives (tsm_class_lives). They are read at the claim and
 * again as each round starts, so a mapconfig or a console change takes effect from the next
 * round. The lives need tsm_respawns 1.
 *
 * THE MODE API. Everything comes through include\tsm_api.inc. With ts_matchmode missing, or
 * too old to take class rules, the native filter lets this plugin load, and it does nothing.
 *
 * THE MECH'S EFFECTS. A Mech stunting gets a thruster at its back and a thrust sound, and a Mech
 * landing from a fall gets a cloud of dust under it, so that a jump reads as a jump. The stunt is
 * the mod's own state, pev_iuser4 & 0x10c10 -- the mask reTS itself tests to take a stunting
 * player's damage down and to score a STUNT kill -- so nothing has to be told when a stunt starts
 * or ends. Only players on the Mech class are touched, by tsm_class_of, and only on this mode's
 * own maps: the sprites and the sound are precached on an h9_mw_ map and nowhere else.
 *
 * The mod already shakes the screen when a super-jump lands (reTS dlls/player.cpp, the
 * TSSTUNT_WHEEL_DONE block) and already plays the fall sound, and it draws no particles of its
 * own for either, so none of this doubles what the game does. tsm_mw_thruster and
 * tsm_mw_landdust turn the two halves off; tsm_mw_thruster_max caps how many thrusters are drawn
 * in one pass, because every bot plays a Mech and a round of them all stunting at once would
 * otherwise be a temp entity each.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <tsm_api>

#define PLUGIN  "TS Mech Warrior"
#define VERSION "1.0"
#define AUTHOR  "tsm"

#define MW_BUILD "1.0-modes2"

#define MW_TASK_CLAIM  71301
#define MW_TASK_FX     71302
#define MW_PREFIX      "h9_mw_"
#define MAXPL          (MAX_PLAYERS + 1)

// The mod's own "is stunting" mask: reTS tests pev->iuser4 & 0x10c10 in dlls/player.cpp (incoming
// damage x0.7 while stunting) and in dlls/multiplay_gamerules.cpp (a STUNT kill). Reading the same
// bits means the effects start and stop exactly when the game says a stunt does.
#define MW_STUNT_MASK  0x10c10
// How often the Mechs are looked at. A stunt lasts about a second, so a tenth of a second catches
// its start, its end and a landing without a per-frame forward.
#define MW_FX_TICK     0.1
// How fast a Mech has to be coming down for the landing to raise dust, in units a second. A step
// off a kerb is nowhere near it; a super-jump (velocity.z 400 up) comes down well past it.
#define MW_LAND_Z      -300.0
// The fall speed the biggest cloud is drawn at: between the two the cloud grows with the drop.
#define MW_LAND_Z_FULL -900.0
// The thrust: the rocket launch sample, played low, which is a thruster rather than a shot. A
// single shot of 0.43 s, not a loop, so it cannot outlive the stunt that started it -- a loop
// would have to be stopped on death, on a disconnect and at the round's end to be safe.
#define MW_SND_THRUST  "weapons/rocketfire1.wav"
#define MW_SND_FILE    "sound/weapons/rocketfire1.wav"

new g_cv_mode, g_cv_desc, g_cv_officers, g_cv_officer_lives, g_cv_mechs, g_cv_mech_lives;
new g_cv_engineer;
new g_cv_thruster, g_cv_landdust, g_cv_thruster_max;

// The sprites, 0 when the file is not installed: an effect whose sprite is missing is skipped
// rather than precached blind, which would take the server down on a map change.
new g_spr_flash, g_spr_smoke, g_spr_dust, g_spr_bigdust;
new bool:g_snd_thrust = false;

new bool:g_was_stunt[MAXPL];   // was this player stunting last pass, for the two edges
new bool:g_was_air[MAXPL];     // was it off the ground last pass, for the landing edge
new Float:g_fall_z[MAXPL];     // the speed it was last coming down at, kept while it is airborne
new bool:g_thrust_flip[MAXPL]; // every other pass draws the thruster, so one sprite per 0.2 s

new bool:g_have_core = true;   // cleared by the native filter when ts_matchmode is not loaded
new bool:g_active = false;     // this map is claimed for Mech Warrior
new g_mapname[32];
new g_officer;                 // the Officer's class, 1 and up; 0 when ts_matchmode.cfg has none
new g_mech;                    // the Mech's class, 1 and up
new g_engineer;                // the Combat Engineer's class, 1 and up; 0 when ts_matchmode.cfg has none
new g_eng_on = -1;             // whether the Engineer was last played, for the log
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

/*
 * The Mech's sprites and sound, on this mode's maps only: a map that is not h9_mw_ never plays a
 * Mech, so it does not carry the files either. Each one is checked on disk first and left at 0
 * when it is absent, because precaching a model that is not there ends the map.
 */
public plugin_precache()
{
	new mapname[32];
	get_mapname(mapname, charsmax(mapname));
	if (!equali(mapname, MW_PREFIX, strlen(MW_PREFIX)))
	{
		return;
	}
	if (file_exists("sprites/h9_rocket_flash.spr", true))
	{
		g_spr_flash = precache_model("sprites/h9_rocket_flash.spr");
	}
	if (file_exists("sprites/h9_rocket_smoke.spr", true))
	{
		g_spr_smoke = precache_model("sprites/h9_rocket_smoke.spr");
	}
	if (file_exists("sprites/dust.spr", true))
	{
		g_spr_dust = precache_model("sprites/dust.spr");
	}
	if (file_exists("sprites/taxi_dust.spr", true))
	{
		g_spr_bigdust = precache_model("sprites/taxi_dust.spr");
	}
	if (file_exists(MW_SND_FILE, true))
	{
		precache_sound(MW_SND_THRUST);
		g_snd_thrust = true;
	}
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
	g_cv_engineer      = register_cvar("tsm_mw_engineer",          "1");

	// The Mech's effects. Both on: they are this mode's own and no other mode or class sees them.
	g_cv_thruster      = register_cvar("tsm_mw_thruster",          "1");
	g_cv_landdust      = register_cvar("tsm_mw_landdust",          "1");
	// 0 is no cap. Every bot plays a Mech, so a round of them stunting together is this many
	// sprites a pass and no more.
	g_cv_thruster_max  = register_cvar("tsm_mw_thruster_max",      "6");

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
	g_engineer = tsm_class_of_perk(TSM_PERK_ENGINEER);
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
	// The Mechs' effects run only while the mode holds the map.
	if (!task_exists(MW_TASK_FX))
	{
		set_task(MW_FX_TICK, "task_fx", MW_TASK_FX, "", 0, "b");
	}
	log_amx("[MECHWARRIOR] %s is a Mech Warrior map: class %d is the Officer, class %d the Mech.",
		g_mapname, g_officer, g_mech);
}

/// The Combat Engineer's limit a side as ts_matchmode.cfg has it: his class's number in tsm_class_limits (the first is class 1),
/// 0 for no limit when that list is blank or stops short of him.
engineer_limit()
{
	new spec[128], field[16], rest[128], carry[128];
	get_cvar_string("tsm_class_limits", spec, charsmax(spec));
	copy(rest, charsmax(rest), spec);
	for (new cls = 1; rest[0]; cls++)
	{
		strtok(rest, field, charsmax(field), carry, charsmax(carry), ',', 1);
		if (cls == g_engineer)
		{
			return max(str_to_num(field), 0);
		}
		copy(rest, charsmax(rest), carry);
	}
	return 0;
}

/*
 * The class rules, from the cvars: the Officer limited to tsm_mw_officers a side on
 * tsm_mw_officer_lives lives (0 officers is no Officer at all), the Mech to tsm_mw_mechs a
 * side (0 no limit) on tsm_mw_mech_lives, the Combat Engineer played with tsm_mw_engineer 1
 * (his class's own limit and lives), every other class not played, and every bot a Mech.
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
		else if (cls == g_engineer && get_pcvar_num(g_cv_engineer))
		{
			tsm_class_rule(cls, engineer_limit(), 0);
		}
		else
		{
			tsm_class_rule(cls, -1, 0);
		}
	}
	tsm_mode_bot_class(g_mech);

	new eng_on = (g_engineer && get_pcvar_num(g_cv_engineer)) ? 1 : 0;
	if (eng_on != g_eng_on)
	{
		g_eng_on = eng_on;
		if (eng_on)
		{
			log_amx("[MECHWARRIOR] The Combat Engineer (class %d) is played: %d a side (0 no limit), on the lives tsm_class_lives gives him.",
				g_engineer, engineer_limit());
		}
		else
		{
			log_amx("[MECHWARRIOR] The Combat Engineer is not played.");
		}
	}

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

/* ---- the Mech's effects ----------------------------------------------------------------- */

/*
 * Every tenth of a second, each living Mech: the thruster while it is stunting, and a cloud of
 * dust the moment it touches down from a fall. The stunt is the mod's own pev_iuser4 bits, so
 * there is nothing to keep in step; the landing is the ground flag's edge, with the speed the
 * player was last falling at, which is why the fall speed is kept each pass while it is airborne.
 *
 * A player who is not alive, or not on the Mech class, has its state cleared, so a Mech that dies
 * mid-stunt or changes class leaves nothing half-finished behind.
 */
public task_fx()
{
	if (!g_active || !g_have_core)
	{
		return;
	}
	new bool:thrust_on = get_pcvar_num(g_cv_thruster) != 0;
	new bool:dust_on = get_pcvar_num(g_cv_landdust) != 0;
	new cap = get_pcvar_num(g_cv_thruster_max);
	if (cap < 0)
	{
		cap = 0;
	}
	new drawn = 0;
	new maxpl = get_maxplayers();
	if (maxpl > MAX_PLAYERS)
	{
		maxpl = MAX_PLAYERS;
	}
	for (new id = 1; id <= maxpl; id++)
	{
		if (!is_user_alive(id) || tsm_class_of(id) != g_mech)
		{
			g_was_stunt[id] = false;
			g_was_air[id] = false;
			g_thrust_flip[id] = false;
			g_fall_z[id] = 0.0;
			continue;
		}

		new Float:origin[3], Float:vel[3];
		pev(id, pev_origin, origin);
		pev(id, pev_velocity, vel);
		new bool:onground = (pev(id, pev_flags) & FL_ONGROUND) != 0;
		new bool:stunting = (pev(id, pev_iuser4) & MW_STUNT_MASK) != 0;

		if (thrust_on && stunting)
		{
			// the sound once, as the stunt starts, not every pass
			if (!g_was_stunt[id] && g_snd_thrust)
			{
				emit_sound(id, CHAN_STATIC, MW_SND_THRUST, 0.7, ATTN_NORM, 0, 70);
				mw_puff(origin);
			}
			if (!g_thrust_flip[id] && (!cap || drawn < cap))
			{
				mw_thruster(id, origin);
				drawn++;
			}
			g_thrust_flip[id] = !g_thrust_flip[id];
		}
		else
		{
			g_thrust_flip[id] = false;
		}
		g_was_stunt[id] = stunting;

		// the landing: it was off the ground and coming down hard, and now it is down
		if (dust_on && onground && g_was_air[id] && g_fall_z[id] <= MW_LAND_Z)
		{
			mw_landdust(origin, g_fall_z[id]);
		}
		if (!onground)
		{
			g_fall_z[id] = vel[2];
		}
		g_was_air[id] = !onground;
	}
}

/// The thruster flame, behind the player and a little above its middle: the yaw alone, so a Mech
/// looking up or down still wears it on its back.
mw_thruster(id, Float:origin[3])
{
	if (!g_spr_flash)
	{
		return;
	}
	new Float:ang[3];
	pev(id, pev_angles, ang);
	new Float:pos[3];
	pos[0] = origin[0] - floatcos(ang[1], degrees) * 18.0;
	pos[1] = origin[1] - floatsin(ang[1], degrees) * 18.0;
	pos[2] = origin[2] + 6.0;

	message_begin_f(MSG_PVS, SVC_TEMPENTITY, pos);
	write_byte(TE_SPRITE);
	write_coord(floatround(pos[0]));
	write_coord(floatround(pos[1]));
	write_coord(floatround(pos[2]));
	write_short(g_spr_flash);
	write_byte(6);   // scale, in tenths
	write_byte(200); // brightness
	message_end();
}

/// One plume where the stunt began, so the thruster reads as having lit rather than appeared.
mw_puff(Float:origin[3])
{
	if (!g_spr_smoke)
	{
		return;
	}
	message_begin_f(MSG_PVS, SVC_TEMPENTITY, origin);
	write_byte(TE_SPRITE);
	write_coord(floatround(origin[0]));
	write_coord(floatround(origin[1]));
	write_coord(floatround(origin[2]));
	write_short(g_spr_smoke);
	write_byte(5);
	write_byte(120);
	message_end();
}

/*
 * The landing cloud, at the feet rather than the middle. One wide puff for the weight of it and a
 * few smaller ones around it so that it is not a single flat disc, both grown by how hard the Mech
 * came down. Only the additive dust sprites are used: debris_concrete3 is an indexalpha sprite and
 * a temp-entity sprite is drawn additively, which would make chunks glow instead of fall.
 */
mw_landdust(Float:origin[3], Float:fall)
{
	new Float:pos[3];
	pos[0] = origin[0];
	pos[1] = origin[1];
	pos[2] = origin[2] - 30.0;

	// 0.0 at the speed the dust starts, 1.0 at the speed it is fullest
	new Float:hard = (fall - MW_LAND_Z) / (MW_LAND_Z_FULL - MW_LAND_Z);
	if (hard < 0.0)
	{
		hard = 0.0;
	}
	if (hard > 1.0)
	{
		hard = 1.0;
	}

	if (g_spr_bigdust)
	{
		message_begin_f(MSG_PVS, SVC_TEMPENTITY, pos);
		write_byte(TE_SPRITE);
		write_coord(floatround(pos[0]));
		write_coord(floatround(pos[1]));
		write_coord(floatround(pos[2]));
		write_short(g_spr_bigdust);
		write_byte(8 + floatround(hard * 10.0)); // 0.8 wide up to 1.8
		write_byte(150);
		message_end();
	}
	if (!g_spr_dust)
	{
		return;
	}
	new puffs = 2 + floatround(hard * 2.0);
	for (new k = 0; k < puffs; k++)
	{
		new Float:p[3];
		p[0] = pos[0] + float(random_num(-22, 22));
		p[1] = pos[1] + float(random_num(-22, 22));
		p[2] = pos[2] + float(random_num(0, 10));
		message_begin_f(MSG_PVS, SVC_TEMPENTITY, p);
		write_byte(TE_SPRITE);
		write_coord(floatround(p[0]));
		write_coord(floatround(p[1]));
		write_coord(floatround(p[2]));
		write_short(g_spr_dust);
		write_byte(5 + random_num(0, 4));
		write_byte(130);
		message_end();
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
	console_print(id, "[MECHWARRIOR] Combat Engineer class %d: %s, %d a side (0 no limit), on the lives tsm_class_lives gives him.",
		g_engineer, (g_engineer && get_pcvar_num(g_cv_engineer)) ? "played" : "not played", g_engineer ? engineer_limit() : 0);
	console_print(id, "[MECHWARRIOR] Every class but those is not played, and every bot plays the Mech.  Side 1 in the round %d, side 2 %d.",
		tsm_side_alive(1), tsm_side_alive(2));
	console_print(id, "[MECHWARRIOR] Effects: thruster %d (max %d a pass), landing dust %d.  Sprites flash=%d smoke=%d dust=%d bigdust=%d, thrust sound %d.",
		get_pcvar_num(g_cv_thruster), get_pcvar_num(g_cv_thruster_max), get_pcvar_num(g_cv_landdust),
		g_spr_flash, g_spr_smoke, g_spr_dust, g_spr_bigdust, g_snd_thrust ? 1 : 0);
	return PLUGIN_HANDLED;
}
