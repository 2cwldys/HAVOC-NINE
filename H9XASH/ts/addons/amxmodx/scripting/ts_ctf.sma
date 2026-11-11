/*
 * ts_ctf.sma -- CAPTURE THE FLAG, a mode for ts_matchmode.
 *
 * Each side has a flag standing on its own flag pad. A side takes the ENEMY's flag by walking over it and carries it home: standing
 * on its own pad with the enemy flag on its back (and, by default, its own flag at home) turns the flag in and scores a capture. The
 * first side to tsm_cf_caps captures wins the round; at the clock the side with more captures wins it, and equal is a draw. Both
 * sides respawn in waves and never run out of lives: nobody is counted out, the flags decide.
 *
 * THE FLAG is this plugin's own entity (models/tsm_flag.mdl, made with SMAK by export-map/h9_drainage/flag.mjs, which carries it
 * in two bodies and three skins): a banner on a pole standing on the pad (body 0), the same pole worn up the carrier's back (body 1,
 * MOVETYPE_FOLLOW with the carrier as its aiment, so it rides his spine), and it CHANGES COLOUR WITH POSSESSION: a flag at its pad
 * wears its own side's colour (skin 1 blue, 2 red), the enemy that carries it turns it to the carrier's colour, and one that lies
 * where it was dropped is grey (skin 0). A flag that nobody takes back flies home after tsm_cf_return seconds; its own side
 * takes it back at once by walking over it. The carrier keeps every weapon, is marked to both sides, and lets the flag go with
 * "dropflag" in the console (bind it) or .drop in chat; he drops it where he falls. Without the model the mode falls back to TS's
 * briefcase tinted by a glow shell.
 *
 * SEEING THE FLAGS. Every flag and every pad is drawn on every player's screen through the walls (include\h9_marks.inc: a badge in
 * the colour of whoever holds it, FLAG, CARRIED or DROPPED, with a bar draining while a dropped flag flies home; BASE on each
 * pad), so everyone always knows where all four are. A game that draws no H9 marks gets TS's own objective markers.
 *
 * WHICH MAPS. A map is a flag map when it has both pads: entities with the targetnames tsm_flag_1 and tsm_flag_2 (a point entity's
 * origin is the pad's centre), or pads written to the map's own config, configs/tsm_ctf_<map>.cfg, by the editor commands below
 * (tsm_cf_pad <side> <x> <y> <z>). Maps are named h9_ctf_<name>. tsm_ctf_mode 0 turns the mode off everywhere. A map that also carries
 * siege objectives (tsm_obj_#) stays a siege map: ts_matchmode refuses the claim, and the conflict is logged. TS's own capture game
 * (the ctf_ and ctb_ maps, with TS's briefcases) is a different thing: this plugin takes no map that has not got these pads.
 *
 * ONE ROUND, ONE MATCH. By default (h9_ctf_rounds 0) the first round that ends is the whole match, as in Assault; 1 plays rounds.
 *
 * THE MODE API. Everything this plugin needs from the match comes through include\tsm_api.inc. With ts_matchmode missing the native
 * filter below lets this plugin load, and it does nothing.
 *
 * BOTS play the flags while tsm_bot_objectives is 1 (include\tsm_botobj.inc): rcbot_mm.dll sends them for the enemy flag, their own
 * dropped flag and the carriers, and a bot takes, returns and turns in a flag like anyone. With 0 they only fight, unless tsm_cf_bots
 * is 1: then a bot that walks over a flag still takes it and returns it. rcbot reads a flag from the entity with the classname
 * tsm_flag: team is whose flag it is, iuser1 is 0 at its pad, 1 carried, 2 dropped, owner and aiment the carrier while it is carried,
 * iuser2 is 1 while its carrier would score by reaching his pad now, fuser2 the seconds before a dropped flag flies home (-1
 * otherwise) and vuser1 its pad. A pad's ring is tsm_flagpad (team: the side it belongs to). Keep those fields as they are;
 * docs\BOT_OBJECTIVES.txt has the whole contract.
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler and a strict log: ASCII only, explicit braces, no warnings.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <tsm_api>
#include <h9_vgui>      // an H9 game shows the carrier's status and the news on panels
#include <h9_marks>     // and the flags and the pads through the walls
#include <tsm_botobj>   // and the flags' state for the bots

#define PLUGIN  "TS Capture the Flag"
#define VERSION "1.0"
#define AUTHOR  "tsm"

// Printed by amx_tsm_ctf, so there is never any doubt which build is loaded.
#define CF_BUILD "1.0-ctf2"

#define CF_TICK        0.1
#define CF_TASK_TICK   71201
#define CF_TASK_CLAIM  71202

// The marks' places (h9_marks.inc): the flags, then the pads.
#define CF_SLOT_FLAG   1     // plus the side
#define CF_SLOT_PAD    3     // plus the side

/*
 * The assets. models/tsm_flag.mdl is made by export-map/h9_drainage/flag.mjs (SMAK); the ring sprites are the uplink's. Each is
 * precached only when the file is really there -- a precached name with no file is a fatal Host_Error -- and the mode falls back to
 * TS's briefcase, tinted, and to no rings rather than not running.
 */
#define CF_MODEL          "models/tsm_flag.mdl"
#define CF_MODEL_FALLBACK "models/briefcase.mdl"
#define CF_RING_1         "sprites/tsm_zone_ring_1.spr"
#define CF_RING_2         "sprites/tsm_zone_ring_2.spr"

// Stock Half-Life sounds every client already has.
#define CF_SND_PICKUP  "items/gunpickup2.wav"
#define CF_SND_DROP    "items/weapondrop1.wav"
#define CF_SND_RETURN  "items/suitchargeok1.wav"
#define CF_SND_CAPTURE "buttons/bell1.wav"

// The ring sprites are 128 pixels across with the ring at 56 (export-map/h9_drainage/sprites.mjs): a pad of radius R is the ring at scale R / 56.
#define CF_RING_PX     56.0
#define CF_PICKUP      48.0    // how close a player must come across the floor to take or return a flag
#define CF_PICKUP_DZ   64.0    // and how far from the flag's foot to his middle, up or down
#define CF_PAD_DZ      72.0    // how far above or below a pad's floor a player's middle may be to be on it
#define CF_DROP_GRACE  1.5     // the one who dropped a flag cannot take it back for this long
#define CF_MARK_HIGH   54.0    // a flag's mark hangs this far above its foot, and over a carrier's middle

// The flag's state.
#define CF_HOME     0
#define CF_CARRIED  1
#define CF_DROPPED  2

// Engine values, spelled out here so this file needs nothing beyond fakemeta.
#define CF_MT_NONE       0
#define CF_MT_TOSS       6
#define CF_MT_FOLLOW     12
#define CF_SOLID_NOT     0
#define CF_SOLID_TRIGGER 1
#define CF_RENDER_NORMAL 0
#define CF_RENDER_ADD    5
#define CF_FX_GLOWSHELL  19
#define CF_EF_NODRAW     128

new g_cv_mode, g_cv_caps, g_cv_return, g_cv_wave, g_cv_radius, g_cv_needhome, g_cv_capwave, g_cv_desc, g_cv_rounds, g_cv_bots;

new bool:g_have_core = true;   // cleared by the native filter when ts_matchmode is not loaded
new bool:g_active = false;     // this map is claimed for capture the flag
new g_mapname[32];
new g_rounds_seen = -1;        // h9_ctf_rounds as apply_rounds last read it
new Float:g_waves_set;

// What the precache found on disk.
new g_flag_model[48];
new bool:g_flag_custom;        // tsm_flag.mdl, which has the skins; else the briefcase and a tint
new bool:g_ring_ok;
new g_ring_frames[3];
new g_ring_frame;

// The pads: where each side's flag stands and where its carrier turns the enemy's in. 1 and 2.
new bool:g_pad_have[3];
new bool:g_pad_cfg[3];
new Float:g_pad[3][3];
new g_pad_ring[3];

// The flags. g_flag_state: CF_HOME, CF_CARRIED, CF_DROPPED.
new g_flag_ent[3];
new g_flag_state[3];
new g_flag_carrier[3];
new Float:g_flag_loose_since[3];
new g_flag_dropper[3];
new Float:g_flag_dropped_at[3];
new Float:g_flag_carrier_at[3][3];
new Float:g_flag_told_at[3];           // the carrier's "bring your flag home first" refusals, rate limited
new g_carry_told[3];                   // per flag: the player the core was last told carries it (tsm_set_carrying), 0 for nobody

new g_caps[3];                         // captures this round
new g_ticks;

// The carrier's status on an H9 game: who has it, what it says.
new g_status_id[3];
new g_status_text[3][64];

/*
 * Lets every tsm_* native be missing instead of refusing to load (the pattern ts_uplink uses). Set here and not in plugin_init:
 * AMXX links natives before any plugin_init runs. A missing native called at run time returns 0, which every caller below reads as
 * "no core".
 */
public plugin_natives()
{
	set_native_filter("native_filter");
}

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
	h9vgui_precache();

	if (file_exists(CF_MODEL, true))
	{
		copy(g_flag_model, charsmax(g_flag_model), CF_MODEL);
		g_flag_custom = true;
	}
	else
	{
		copy(g_flag_model, charsmax(g_flag_model), CF_MODEL_FALLBACK);
		g_flag_custom = false;
	}
	precache_model(g_flag_model);

	g_ring_ok = (file_exists(CF_RING_1, true) && file_exists(CF_RING_2, true));
	if (g_ring_ok)
	{
		g_ring_frames[1] = engfunc(EngFunc_ModelFrames, precache_model(CF_RING_1));
		g_ring_frames[2] = engfunc(EngFunc_ModelFrames, precache_model(CF_RING_2));
	}

	precache_sound(CF_SND_PICKUP);
	precache_sound(CF_SND_DROP);
	precache_sound(CF_SND_RETURN);
	precache_sound(CF_SND_CAPTURE);
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);
	h9vgui_init("cf");

	g_cv_mode     = register_cvar("tsm_ctf_mode",        "1");
	g_cv_caps     = register_cvar("tsm_cf_caps",         "3");     // captures that win the round
	g_cv_return   = register_cvar("tsm_cf_return",       "20");    // seconds before a dropped flag flies home; 0: it stays
	g_cv_wave     = register_cvar("tsm_cf_wave",         "20");    // seconds between a side's respawn waves
	g_cv_radius   = register_cvar("tsm_cf_pad_radius",   "72");    // how near its pad a carrier must be to turn the flag in, units
	g_cv_needhome = register_cvar("tsm_cf_needhome",     "1");     // 1: the carrier's own flag must be at its pad too
	g_cv_capwave  = register_cvar("tsm_cf_capture_wave", "1");     // 1: the side that captured gets a wave at once
	g_cv_bots     = register_cvar("tsm_cf_bots",         "0");     // 1: a bot that walks over a flag takes it even with tsm_bot_objectives 0
	g_cv_desc     = register_cvar("tsm_gamedesc_ctf",    "Capture the Flag");
	g_cv_rounds   = register_cvar("h9_ctf_rounds",       "0");     // 0: the first round is the whole match; 1: rounds, best of tsm_rounds
	tsb_register();   // tsm_bot_objectives: 1 lets rcbot send the bots for the flags

	// The carrier lets go: bindable from the console, or typed in chat.
	register_clcmd("dropflag", "cmd_drop", 0, "- let the flag go, if you carry it");
	register_clcmd("say .drop", "cmd_drop_say");
	register_clcmd("say_team .drop", "cmd_drop_say");

	// The pad editor, the same shape as the spawn editor's.
	register_concmd("amx_tsm_cf_pad",   "cmd_cf_pad",  ADMIN_CFG, " <1|2> - that side's flag pad where you stand");
	register_concmd("amx_tsm_cf_save",  "cmd_cf_save", ADMIN_CFG, " - write this map's flag pads");
	register_concmd("amx_tsm_cf_list",  "cmd_cf_list", ADMIN_CFG, " - the flag pads and the flags");
	register_concmd("amx_tsm_cf_give",  "cmd_cf_give", ADMIN_CFG, " <1|2> <0|1|2> - side <1|2>'s flag lies at its pad (0) or is taken by a side (testing)");
	register_concmd("amx_tsm_cf_tp",    "cmd_cf_tp",   ADMIN_CFG, " <side> <pad 1|2> - the first human of <side> in play goes to that pad (testing)");
	register_concmd("amx_tsm_ctf",      "cmd_cf_dump", ADMIN_CFG, " - the flag mode's whole state");

	// Read from configs/tsm_ctf_<map>.cfg, which amx_tsm_cf_save writes.
	register_srvcmd("tsm_cf_pad", "srv_cf_pad");
}

public plugin_cfg()
{
	get_mapname(g_mapname, charsmax(g_mapname));

	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_ctf.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// This map's pads, if the editor saved any.
	map_cfg_path(file, charsmax(file));
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// The claim waits a moment: the map's own entities have settled by then, and h9_autoconfig has run ts/mapconfigs/<map>.cfg, which may
	// set tsm_ctf_mode for this map alone.
	set_task(2.0, "task_claim", CF_TASK_CLAIM);
}

map_cfg_path(path[], len)
{
	new dir[64];
	get_configsdir(dir, charsmax(dir));
	formatex(path, len, "%s/tsm_ctf_%s.cfg", dir, g_mapname);
}

/* ---- the claim -------------------------------------------------------------------------- */

public task_claim()
{
	scan_map();
	try_claim();
}

/// The pads the map itself carries (tsm_flag_1 and tsm_flag_2), beside whatever the config placed.
scan_map()
{
	new name[16];
	for (new s = 1; s <= 2; s++)
	{
		if (g_pad_have[s])
		{
			continue;   // the config's placement wins over the map's
		}
		formatex(name, charsmax(name), "tsm_flag_%d", s);
		new ent = engfunc(EngFunc_FindEntityByString, -1, "targetname", name);
		if (ent <= 0 || !pev_valid(ent))
		{
			continue;
		}
		new Float:org[3];
		pev(ent, pev_origin, org);
		set_pad(s, org, false);
	}
}

set_pad(s, const Float:org[3], bool:from_cfg)
{
	if (s != 1 && s != 2)
	{
		return;
	}
	g_pad_have[s] = true;
	g_pad_cfg[s] = from_cfg;
	g_pad[s][0] = org[0];
	g_pad[s][1] = org[1];
	g_pad[s][2] = org[2];
}

/// Both sides' respawn waves every tsm_cf_wave seconds: on a flag map this, not tsm_respawn_wave, sets them. Applied at the claim and
/// again as each round starts, before ts_matchmode starts that round's wave clocks. Logged whenever the interval changes.
apply_waves()
{
	new Float:wave = get_pcvar_float(g_cv_wave);
	tsm_wave_seconds(1, wave);
	tsm_wave_seconds(2, wave);
	if (wave != g_waves_set)
	{
		g_waves_set = wave;
		log_amx("[CTF] Respawn waves every %.0fs for both sides on %s.", wave, g_mapname);
	}
}

/// Whether the first round is the whole match: h9_ctf_rounds 0, the default. Applied at the claim and as each round starts, and again
/// within a second of a change of the cvar (task_tick).
apply_rounds()
{
	g_rounds_seen = get_pcvar_num(g_cv_rounds);
	tsm_mode_flag(TSM_MODE_ONE_ROUND, g_rounds_seen == 0);
}

try_claim()
{
	// tsm_enabled 0: the map plays as the game ships (ts_matchmode's per-map rule, or the map's mapconfig).
	if (g_active || !g_have_core || !get_pcvar_num(g_cv_mode) || !get_cvar_num("tsm_enabled"))
	{
		return;
	}
	if (!g_pad_have[1] || !g_pad_have[2])
	{
		if (equali(g_mapname, "h9_ctf_", 7))
		{
			log_amx("[CTF] %s is named for capture the flag but has %d flag pad(s): it needs both (tsm_flag_1 and tsm_flag_2 in the map, or amx_tsm_cf_pad and amx_tsm_cf_save).",
				g_mapname, (g_pad_have[1] ? 1 : 0) + (g_pad_have[2] ? 1 : 0));
		}
		return;
	}

	new desc[64];
	get_pcvar_string(g_cv_desc, desc, charsmax(desc));
	if (!desc[0])
	{
		copy(desc, charsmax(desc), "Capture the Flag");
	}
	if (!tsm_mode_claim("ctf", desc, TSM_MODE_NO_SUDDEN | TSM_MODE_ENDLESS))
	{
		log_amx("[CTF] %s has both flag pads but the claim was refused (siege objectives, another mode, or no ts_matchmode).", g_mapname);
		return;
	}

	g_active = true;
	apply_waves();
	apply_rounds();
	for (new s = 1; s <= 2; s++)
	{
		build_pad(s);
	}
	refresh_hud();

	remove_task(CF_TASK_TICK);
	set_task(CF_TICK, "task_tick", CF_TASK_TICK, "", 0, "b");
	log_amx("[CTF] %s is a flag map: pad 1 at %.0f %.0f %.0f, pad 2 at %.0f %.0f %.0f.", g_mapname,
		g_pad[1][0], g_pad[1][1], g_pad[1][2], g_pad[2][0], g_pad[2][1], g_pad[2][2]);
}

/* ---- the pads ------------------------------------------------------------------------------ */

/// A pad's ring on the ground, in its side's colour, made once and reused all map.
build_pad(s)
{
	if (g_ring_ok && !pev_valid(g_pad_ring[s]))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent > 0)
		{
			set_pev(ent, pev_classname, "tsm_flagpad");
			engfunc(EngFunc_SetModel, ent, (s == 1) ? CF_RING_1 : CF_RING_2);
			set_pev(ent, pev_movetype, CF_MT_NONE);
			set_pev(ent, pev_solid, CF_SOLID_NOT);
			set_pev(ent, pev_rendermode, CF_RENDER_ADD);
			set_pev(ent, pev_renderamt, 255.0);
			// Laid flat: an oriented sprite faces along its angles, so a pitch of 90 faces it down.
			new Float:ang[3] = { 90.0, 0.0, 0.0 };
			set_pev(ent, pev_angles, ang);
			set_pev(ent, pev_scale, get_pcvar_float(g_cv_radius) / CF_RING_PX);
			set_pev(ent, pev_team, s);
			new Float:org[3];
			org[0] = g_pad[s][0];
			org[1] = g_pad[s][1];
			org[2] = g_pad[s][2] + 2.0;   // just off the floor, never inside it
			engfunc(EngFunc_SetOrigin, ent, org);
			g_pad_ring[s] = ent;
		}
	}
	pad_mark(s);
}

/// Steps every ring's animation on, ten frames a second.
animate_pads()
{
	g_ring_frame++;
	for (new s = 1; s <= 2; s++)
	{
		new ring = g_pad_ring[s];
		if (ring <= 0 || !pev_valid(ring) || g_ring_frames[s] < 2)
		{
			continue;
		}
		set_pev(ring, pev_frame, float(g_ring_frame % g_ring_frames[s]));
	}
}

/// Whether a point is on side s's pad: within tsm_cf_pad_radius across the floor, and near its height.
bool:on_pad(const Float:org[3], s)
{
	new Float:dx = org[0] - g_pad[s][0];
	new Float:dy = org[1] - g_pad[s][1];
	new Float:dz = org[2] - g_pad[s][2];
	if (dz < -CF_PAD_DZ || dz > CF_PAD_DZ)
	{
		return false;
	}
	new Float:r = get_pcvar_float(g_cv_radius);
	return (dx * dx + dy * dy <= r * r) ? true : false;
}

/* ---- the flags ------------------------------------------------------------------------------ */

/// The colour a flag wears, as a side: its own while it stands at its pad, the carrier's while it is carried, none (0, grey) where it lies.
flag_colour(f)
{
	if (g_flag_state[f] == CF_HOME)
	{
		return f;
	}
	if (g_flag_state[f] == CF_CARRIED && g_flag_carrier[f] && is_user_connected(g_flag_carrier[f]))
	{
		return tsm_side_of(g_flag_carrier[f]);
	}
	return 0;
}

/// A flag's skin (or, with the briefcase, its tint) for its state.
flag_paint(f)
{
	new ent = g_flag_ent[f];
	if (ent <= 0 || !pev_valid(ent))
	{
		return;
	}
	new colour = flag_colour(f);
	if (g_flag_custom)
	{
		set_pev(ent, pev_skin, colour);
	}
	else
	{
		new Float:rgb[3];
		rgb[0] = (colour == 2) ? 255.0 : ((colour == 1) ? 0.0 : 200.0);
		rgb[1] = (colour == 2) ? 50.0 : ((colour == 1) ? 128.0 : 200.0);
		rgb[2] = (colour == 2) ? 40.0 : ((colour == 1) ? 255.0 : 200.0);
		set_pev(ent, pev_renderfx, CF_FX_GLOWSHELL);
		set_pev(ent, pev_rendercolor, rgb);
		set_pev(ent, pev_renderamt, 12.0);
	}
	set_pev(ent, pev_iuser1, g_flag_state[f]);
	flag_publish(f);
}

/// The fields of a flag that the bots read besides its side (team), state (iuser1) and carrier (owner, aiment): iuser2 is 1 while its
/// carrier would score by reaching his pad now (his own flag at its pad, or tsm_cf_needhome 0), fuser2 the seconds before it flies home
/// while it lies dropped (-1 otherwise, or when tsm_cf_return is 0), vuser1 its pad. Written whenever the flag is painted and every tick.
flag_publish(f)
{
	new ent = g_flag_ent[f];
	if (ent <= 0 || !pev_valid(ent))
	{
		return;
	}
	new ready = (g_flag_state[f] == CF_CARRIED && (g_flag_state[3 - f] == CF_HOME || !get_pcvar_num(g_cv_needhome))) ? 1 : 0;
	new Float:left = -1.0;
	new Float:wait = get_pcvar_float(g_cv_return);
	if (g_flag_state[f] == CF_DROPPED && wait > 0.0)
	{
		left = wait - (get_gametime() - g_flag_loose_since[f]);
		if (left < 0.0)
		{
			left = 0.0;
		}
	}
	set_pev(ent, pev_iuser2, ready);
	set_pev(ent, pev_fuser2, left);
	set_pev(ent, pev_vuser1, g_pad[f]);
}

/// A flag, loose, at a point: made if it is not in the world yet. home: it stands at its pad.
put_flag(f, const Float:org[3], bool:home)
{
	if (!pev_valid(g_flag_ent[f]))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent <= 0)
		{
			log_amx("[CTF] WARNING: could not create a flag -- out of edicts?");
			return;
		}
		set_pev(ent, pev_classname, "tsm_flag");
		engfunc(EngFunc_SetModel, ent, g_flag_model);
		set_pev(ent, pev_team, f);
		g_flag_ent[f] = ent;
	}

	new ent = g_flag_ent[f];
	set_pev(ent, pev_aiment, 0);
	set_pev(ent, pev_owner, 0);
	set_pev(ent, pev_movetype, home ? CF_MT_NONE : CF_MT_TOSS);
	set_pev(ent, pev_solid, CF_SOLID_TRIGGER);
	set_pev(ent, pev_body, 0);           // body 0: the flag standing
	set_pev(ent, pev_sequence, 0);       // its ripple
	set_pev(ent, pev_framerate, 1.0);
	set_pev(ent, pev_animtime, get_gametime());
	set_pev(ent, pev_effects, pev(ent, pev_effects) & ~CF_EF_NODRAW);
	new Float:mins[3] = { -12.0, -12.0, 0.0 };
	new Float:maxs[3] = { 12.0, 12.0, 72.0 };
	engfunc(EngFunc_SetSize, ent, mins, maxs);
	engfunc(EngFunc_SetOrigin, ent, org);
	new Float:zero[3];
	set_pev(ent, pev_velocity, zero);

	g_flag_state[f] = home ? CF_HOME : CF_DROPPED;
	g_flag_carrier[f] = 0;
	carry_sync();
	g_flag_loose_since[f] = get_gametime();
	flag_paint(f);
	carrier_status(f, 0, "");
}

/// Takes both flags out of the world, carried or not.
remove_flags()
{
	for (new f = 1; f <= 2; f++)
	{
		if (pev_valid(g_flag_ent[f]))
		{
			engfunc(EngFunc_RemoveEntity, g_flag_ent[f]);
		}
		g_flag_ent[f] = 0;
		g_flag_carrier[f] = 0;
		g_flag_state[f] = CF_HOME;
		carrier_status(f, 0, "");
		h9marks_remove(CF_SLOT_FLAG + f);
	}
	carry_sync();
}

/// Tells the core whether this player carries a flag now, either of the two (tsm_set_carrying): a test command can hand one man both.
carry_tell(id)
{
	if (id < 1 || id > MAX_PLAYERS)
	{
		return;
	}
	new bool:carrying = false;
	for (new f = 1; f <= 2; f++)
	{
		if (g_flag_state[f] == CF_CARRIED && g_flag_carrier[f] == id)
		{
			carrying = true;
		}
	}
	tsm_set_carrying(id, carrying);
}

/// Brings the core's idea of who carries a flag in line with the flags' own. A cloaked Recon who takes one is uncloaked on the spot, and
/// .cloak is refused him until he holds none. Called wherever a flag changes hands; only a change is told.
carry_sync()
{
	for (new f = 1; f <= 2; f++)
	{
		new who = (g_flag_state[f] == CF_CARRIED) ? g_flag_carrier[f] : 0;
		new old = g_carry_told[f];
		if (who == old)
		{
			continue;
		}
		g_carry_told[f] = who;
		carry_tell(old);
		carry_tell(who);
	}
}

/// A player takes the enemy's flag: on his back, marked for everyone.
pick_up(f, id)
{
	new ent = g_flag_ent[f];
	if (!pev_valid(ent))
	{
		return;
	}
	g_flag_carrier[f] = id;
	g_flag_state[f] = CF_CARRIED;
	pev(id, pev_origin, g_flag_carrier_at[f]);
	carry_sync();

	// Carried on the back: the model follows the carrier and merges onto his skeleton.
	set_pev(ent, pev_solid, CF_SOLID_NOT);
	set_pev(ent, pev_movetype, CF_MT_FOLLOW);
	set_pev(ent, pev_aiment, id);
	set_pev(ent, pev_owner, id);
	set_pev(ent, pev_body, 1);           // body 1: the flag worn up the back
	engfunc(EngFunc_SetOrigin, ent, g_flag_carrier_at[f]);
	flag_paint(f);

	emit_sound(id, CHAN_AUTO, CF_SND_PICKUP, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	new name[32], mine[24], theirs[24];
	get_user_name(id, name, charsmax(name));
	side_name(tsm_side_of(id), mine, charsmax(mine));
	side_name(f, theirs, charsmax(theirs));
	mode_chat(0, "[MATCH] %s has the %s flag for %s!", name, theirs, mine);
	log_amx("[CTF] %s (%d) took the %s flag for %s.", name, id, theirs, mine);
	ctf_news(tsm_side_of(id), "%s has the %s flag for %s", name, theirs, mine);
	if (!is_user_bot(id))
	{
		client_print(id, print_center, "You have the %s flag -- take it to your pad. Type dropflag to let it go.", theirs);
	}
}

/// The carrier lets go, or falls: the flag drops where he is, grey, to be taken again or taken back.
drop_flag(f, const reason[])
{
	new ent = g_flag_ent[f];
	new id = g_flag_carrier[f];
	if (!pev_valid(ent) || !id)
	{
		return;
	}

	new Float:org[3], Float:vel[3];
	if (is_user_connected(id))
	{
		pev(id, pev_origin, org);
		pev(id, pev_velocity, vel);
		org[2] -= 34.0;   // the flag stands on the floor, not at the carrier's middle
	}
	else
	{
		org[0] = g_flag_carrier_at[f][0];
		org[1] = g_flag_carrier_at[f][1];
		org[2] = g_flag_carrier_at[f][2] - 34.0;
	}
	put_flag(f, org, false);

	// Thrown a little up and on, the way a dropped briefcase leaves the hand.
	vel[0] *= 0.5;
	vel[1] *= 0.5;
	vel[2] = 150.0;
	set_pev(ent, pev_velocity, vel);

	g_flag_dropper[f] = id;
	g_flag_dropped_at[f] = get_gametime();
	emit_sound(ent, CHAN_AUTO, CF_SND_DROP, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	new name[32], theirs[24];
	if (is_user_connected(id))
	{
		get_user_name(id, name, charsmax(name));
	}
	else
	{
		copy(name, charsmax(name), "The carrier");
	}
	side_name(f, theirs, charsmax(theirs));
	mode_chat(0, "[MATCH] %s %s the %s flag.", name, reason, theirs);
	log_amx("[CTF] %s (%d) %s the %s flag at %.0f %.0f %.0f.", name, id, reason, theirs, org[0], org[1], org[2]);
	ctf_news(f, "%s %s the %s flag", name, reason, theirs);
}

/// A flag goes home to its pad: taken back by one of its own side (by, who is given the points), or flown home after lying too long.
return_flag(f, by)
{
	put_flag(f, g_pad[f], true);
	if (pev_valid(g_flag_ent[f]))
	{
		emit_sound(g_flag_ent[f], CHAN_AUTO, CF_SND_RETURN, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	}
	new sname[24];
	side_name(f, sname, charsmax(sname));
	log_amx("[CTF] The %s flag is back at its pad%s.", sname, (by && is_user_connected(by)) ? ", taken back by a player of its side" : "");
	if (by && is_user_connected(by))
	{
		new name[32];
		get_user_name(by, name, charsmax(name));
		tsm_points_award(by, TSM_POINTS_RETURN);
		mode_chat(0, "[MATCH] %s took the %s flag back to its pad.", name, sname);
		ctf_news(f, "%s took the %s flag back", name, sname);
	}
	else
	{
		mode_chat(0, "[MATCH] The %s flag is back at its pad.", sname);
		ctf_news(0, "The %s flag is back at its pad", sname);
	}
}

/// The carrier of side f's flag brings it to his own pad: a capture.
capture(id, f)
{
	new side = 3 - f;
	g_caps[side]++;
	tsm_points_award(id, TSM_POINTS_CAPTURE);
	if (pev_valid(g_pad_ring[side]))
	{
		emit_sound(g_pad_ring[side], CHAN_AUTO, CF_SND_CAPTURE, VOL_NORM, ATTN_NONE, 0, PITCH_NORM);
	}

	new name[32], sname[24], theirs[24];
	get_user_name(id, name, charsmax(name));
	side_name(side, sname, charsmax(sname));
	side_name(f, theirs, charsmax(theirs));
	mode_chat(0, "[MATCH] %s captured the %s flag for %s -- %d of %d.", name, theirs, sname, g_caps[side], get_pcvar_num(g_cv_caps));
	log_amx("[CTF] %s (%d) captured the %s flag for %s: %d - %d.", name, id, theirs, sname, g_caps[1], g_caps[2]);
	ctf_news(side, "%s captured the %s flag for %s -- %d of %d", name, theirs, sname, g_caps[side], get_pcvar_num(g_cv_caps));

	// The flag is turned in: it stands at its pad again, silently.
	put_flag(f, g_pad[f], true);
	refresh_hud();

	if (g_caps[side] >= get_pcvar_num(g_cv_caps))
	{
		mode_chat(0, "[MATCH] %s has the captures.", sname);
		tsm_end_round(side);
		return;
	}
	if (get_pcvar_num(g_cv_capwave))
	{
		new back = tsm_fire_wave(side);
		if (back > 0)
		{
			mode_chat(0, "[MATCH] %d of %s's fallen are back in the fight.", back, sname);
		}
	}
}

/* ---- the carrier's status and the news --------------------------------------------------------- */

/// Whether this player's game draws a status: the carrier's then replaces his hudmessages.
bool:status_player(id)
{
	return h9vgui_protocol(id) >= H9VGUI_STATUS_PROTOCOL;
}

/// The carrier's status under the match bar (h9_vgui.inc's h9vgui_status) for flag f, sent only when it changes. Id 0, or an empty
/// text, takes it down.
carrier_status(f, id, const text[])
{
	if (g_status_id[f] && (g_status_id[f] != id || !text[0]))
	{
		if (is_user_connected(g_status_id[f]))
		{
			h9vgui_status(g_status_id[f], "cf.carrier", "", 0, 0, 0);
		}
		g_status_id[f] = 0;
		g_status_text[f][0] = EOS;
	}
	if (!id || !text[0])
	{
		return;
	}
	if (g_status_id[f] == id && equal(text, g_status_text[f]))
	{
		return;
	}
	if (h9vgui_status(id, "cf.carrier", text, 255, 255, 255, -1))
	{
		g_status_id[f] = id;
		copy(g_status_text[f], charsmax(g_status_text[]), text);
	}
}

/// A line of news for every H9 game, a few seconds under the match bar in the side's colour (0 for none). Chat carries the same for every game.
ctf_news(side, const fmt[], any:...)
{
	new text[128];
	vformat(text, charsmax(text), fmt, 3);
	new r = 220, g = 220, b = 220;
	if (side == 1)
	{
		r = 0; g = 170; b = 255;
	}
	else if (side == 2)
	{
		r = 255; g = 70; b = 60;
	}
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");
	for (new i = 0; i < pnum; i++)
	{
		if (h9vgui_supported(players[i]))
		{
			h9vgui_notice(players[i], "cf.news", H9V_NOTICE_BANNER, text, 3.0, 0.5, r, g, b);
		}
	}
}

/* ---- the marks: where the flags and the pads are, through the walls -------------------------------- */

/// A pad's mark: BASE in its side's colour, a little above the floor of the pad.
pad_mark(s)
{
	if (!g_active || !g_pad_have[s])
	{
		return;
	}
	new Float:at[3], text[32], sname[24];
	at[0] = g_pad[s][0];
	at[1] = g_pad[s][1];
	at[2] = g_pad[s][2] + CF_MARK_HIGH;
	side_name(s, sname, charsmax(sname));
	formatex(text, charsmax(text), "%s BASE", sname);
	h9marks_set(CF_SLOT_PAD + s, s, 0, 0, 0, at, "BASE", text);
}

/// A flag's mark: FLAG while it stands at its pad, CARRIED over whoever has it (following him), DROPPED where it lies with a bar draining
/// to the moment it flies home. In the colour of whoever holds it, as the flag itself is painted.
flag_mark(f)
{
	if (!g_active || !pev_valid(g_flag_ent[f]))
	{
		h9marks_remove(CF_SLOT_FLAG + f);
		return;
	}
	new Float:at[3], text[64], sname[24];
	side_name(f, sname, charsmax(sname));
	new owner = flag_colour(f);
	if (g_flag_state[f] == CF_CARRIED && g_flag_carrier[f] && is_user_connected(g_flag_carrier[f]))
	{
		pev(g_flag_carrier[f], pev_origin, at);
		at[2] += CF_MARK_HIGH;
		formatex(text, charsmax(text), "THE %s FLAG - CARRIED", sname);
		h9marks_set(CF_SLOT_FLAG + f, owner, 0, 0, 0, at, "CARRIED", text);
		return;
	}
	pev(g_flag_ent[f], pev_origin, at);
	at[2] += CF_MARK_HIGH;
	if (g_flag_state[f] == CF_DROPPED)
	{
		new pct = 100;
		new Float:wait = get_pcvar_float(g_cv_return);
		if (wait > 0.0)
		{
			pct = clamp(floatround(100.0 * (1.0 - (get_gametime() - g_flag_loose_since[f]) / wait)), 0, 100);
		}
		formatex(text, charsmax(text), "THE %s FLAG - DROPPED", sname);
		h9marks_set(CF_SLOT_FLAG + f, 0, 1, f, pct, at, "DROPPED", text);
		return;
	}
	formatex(text, charsmax(text), "THE %s FLAG", sname);
	h9marks_set(CF_SLOT_FLAG + f, owner, 0, 0, 0, at, "FLAG", text);
}

/// Each tick: every mark as things stand (only a changed one goes out), and the rolling refresh.
marks_tick()
{
	for (new s = 1; s <= 2; s++)
	{
		pad_mark(s);
		flag_mark(s);
	}
	h9marks_tick(10);
}

public client_putinserver(id)
{
	h9marks_player_in(id);
}

public client_disconnected(id)
{
	h9marks_player_out(id);
}

/* ---- the tick ------------------------------------------------------------------------------ */

public task_tick()
{
	if (!g_active)
	{
		return;
	}

	g_ticks++;
	animate_pads();
	marks_tick();
	if (get_pcvar_num(g_cv_rounds) != g_rounds_seen)
	{
		apply_rounds();
	}

	// Outside a live round there are no flags in play, whatever ended the round: a halt, a cancel and an abandoned match all pass through
	// here, not only the round-end forward.
	if (tsm_state() != TSM_ST_LIVE)
	{
		if (pev_valid(g_flag_ent[1]) || pev_valid(g_flag_ent[2]))
		{
			remove_flags();
		}
		if (g_ticks % 10 == 0)
		{
			refresh_hud();
		}
		return;
	}

	for (new f = 1; f <= 2; f++)
	{
		if (!pev_valid(g_flag_ent[f]))
		{
			put_flag(f, g_pad[f], true);
			continue;
		}
		if (g_flag_state[f] == CF_CARRIED)
		{
			carried_tick(f);
		}
		else
		{
			loose_tick(f);
		}
	}

	// Each flag's fields for the bots after both have ticked: one's depends on the state of the other.
	flag_publish(1);
	flag_publish(2);

	if (g_ticks % 10 == 0)
	{
		refresh_hud();
	}
}

carried_tick(f)
{
	new id = g_flag_carrier[f];

	// Dead, eliminated, benched, gone: the flag falls where he was.
	if (!is_user_connected(id))
	{
		drop_flag(f, "lost");
		return;
	}
	if (!tsm_in_play(id))
	{
		drop_flag(f, is_user_alive(id) ? "let go of" : "dropped");
		return;
	}

	pev(id, pev_origin, g_flag_carrier_at[f]);
	flag_paint(f);

	// A second carried, toward the carry's points (ts_matchmode's tsm_score_carry).
	if (g_ticks % 10 == 0)
	{
		tsm_points_award(id, TSM_POINTS_CARRY);
	}

	new own = 3 - f;   // the carrier's own side, whose pad he is making for
	new bool:home = (g_flag_state[own] == CF_HOME);
	new bool:ready = (home || !get_pcvar_num(g_cv_needhome));
	if (on_pad(g_flag_carrier_at[f], own))
	{
		if (ready)
		{
			capture(id, f);
			return;
		}
		new Float:now = get_gametime();
		if (!is_user_bot(id) && now - g_flag_told_at[f] >= 5.0)
		{
			g_flag_told_at[f] = now;
			client_print(id, print_center, "Your own flag is not at your pad -- get it back first.");
		}
	}
	if (status_player(id))
	{
		carrier_status(f, id, ready ? "YOU HAVE THE ENEMY FLAG -- TAKE IT TO YOUR PAD" : "YOUR FLAG IS AWAY -- GET IT BACK, THEN SCORE");
	}
	else if (!is_user_bot(id) && g_ticks % 10 == 0)
	{
		set_hudmessage(255, 255, 255, -1.0, 0.47, 0, 0.0, 1.1, 0.0, 0.2, 3);
		show_hudmessage(id, "YOU HAVE THE ENEMY FLAG^nTake it to your pad");
	}
}

loose_tick(f)
{
	new ent = g_flag_ent[f];
	new Float:org[3];
	pev(ent, pev_origin, org);

	// Fallen out of the world, into the sky or a wall: home at once.
	new contents = engfunc(EngFunc_PointContents, org);
	if (contents == -2 || contents == -6 || org[2] < -16000.0)   // CONTENTS_SOLID, CONTENTS_SKY
	{
		return_flag(f, 0);
		return;
	}

	new Float:now = get_gametime();

	// Somebody walks over it: the nearest player in play within reach.
	new players[MAX_PLAYERS], pnum, best = 0;
	new Float:bestd = CF_PICKUP;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!tsm_in_play(id))
		{
			continue;
		}
		if (is_user_bot(id) && !get_pcvar_num(g_cv_bots) && !tsb_bots_play())
		{
			continue;   // a bot plays the flags when tsm_cf_bots or tsm_bot_objectives says so
		}
		if (id == g_flag_dropper[f] && now - g_flag_dropped_at[f] < CF_DROP_GRACE)
		{
			continue;
		}
		new Float:p[3];
		pev(id, pev_origin, p);
		new Float:dx = p[0] - org[0];
		new Float:dy = p[1] - org[1];
		new Float:dz = p[2] - (org[2] + 36.0);   // a player's origin is his middle, about 36 above his feet
		if (dz < -CF_PICKUP_DZ || dz > CF_PICKUP_DZ)
		{
			continue;
		}
		new Float:d = floatsqroot(dx * dx + dy * dy);
		if (d <= bestd)
		{
			bestd = d;
			best = id;
		}
	}
	if (best)
	{
		new side = tsm_side_of(best);
		if (side == f)
		{
			// Its own side takes it back at once, when it was dropped; at its pad it is simply theirs.
			if (g_flag_state[f] == CF_DROPPED)
			{
				return_flag(f, best);
			}
		}
		else if (side == 3 - f)
		{
			pick_up(f, best);
		}
		return;
	}

	// Lying too long: home.
	new Float:wait = get_pcvar_float(g_cv_return);
	if (g_flag_state[f] == CF_DROPPED && wait > 0.0 && now - g_flag_loose_since[f] >= wait)
	{
		return_flag(f, 0);
	}
}

/* ---- the round, from ts_matchmode (include\tsm_api.inc) ----------------------------------- */

/// The round line's captures and the Discord card's progress.
refresh_hud()
{
	if (!g_active)
	{
		return;
	}
	new line[48];
	formatex(line, charsmax(line), "CAPTURES %d - %d  (FIRST TO %d)", g_caps[1], g_caps[2], get_pcvar_num(g_cv_caps));
	tsm_hud_line(line);

	new prog[24];
	formatex(prog, charsmax(prog), "%d/%d/%d", g_caps[1], g_caps[2], get_pcvar_num(g_cv_caps));
	tsm_set_progress(prog);
}

public tsm_round_start(round)
{
	#pragma unused round
	if (!g_active)
	{
		return;
	}
	// This round's waves, before ts_matchmode starts its clocks at go-live, and whether the round is the match.
	apply_waves();
	apply_rounds();

	// No captures yet, and no flags until the round goes live.
	g_caps[1] = 0;
	g_caps[2] = 0;
	remove_flags();
	refresh_hud();
	h9marks_resend();
}

public tsm_round_live(round)
{
	#pragma unused round
	if (!g_active)
	{
		return;
	}
	for (new f = 1; f <= 2; f++)
	{
		put_flag(f, g_pad[f], true);
	}
	mode_chat(0, "[MATCH] The flags are up -- take the enemy's and carry it to your own pad.");
	refresh_hud();
}

public tsm_round_end(winner)
{
	#pragma unused winner
	if (!g_active)
	{
		return;
	}
	remove_flags();
	refresh_hud();
}

/// Time up: the side with more captures takes the round, and equal is a draw.
public tsm_round_timeout()
{
	if (!g_active)
	{
		return PLUGIN_CONTINUE;
	}
	new s1[24], s2[24];
	side_name(1, s1, charsmax(s1));
	side_name(2, s2, charsmax(s2));
	mode_chat(0, "[MATCH] Time up -- %s has %d capture(s), %s has %d.", s1, g_caps[1], s2, g_caps[2]);

	if (g_caps[1] > g_caps[2])
	{
		tsm_end_round(1);
	}
	else if (g_caps[2] > g_caps[1])
	{
		tsm_end_round(2);
	}
	else
	{
		tsm_end_round(0);
	}
	return PLUGIN_HANDLED;
}

/* ---- commands --------------------------------------------------------------------------- */

/// dropflag in the console: always answered, so a bound key never prints "Unknown command".
public cmd_drop(id)
{
	if (!g_active)
	{
		console_print(id, "[CTF] This map has no flags.");
		return PLUGIN_HANDLED;
	}
	for (new f = 1; f <= 2; f++)
	{
		if (g_flag_state[f] == CF_CARRIED && g_flag_carrier[f] == id)
		{
			drop_flag(f, "dropped");
			return PLUGIN_HANDLED;
		}
	}
	console_print(id, "[CTF] You are not carrying a flag.");
	return PLUGIN_HANDLED;
}

/// A player's use key on a bot of his side asks it to let go of the flag it carries (ts_matchmode, tsm_handoff): the flag drops where the bot
/// stands, and that bot stays off it for secs seconds, long enough for the player to take it.
public tsm_handoff_drop(id, Float:secs)
{
	if (!g_active)
	{
		return PLUGIN_CONTINUE;
	}
	for (new f = 1; f <= 2; f++)
	{
		if (g_flag_state[f] == CF_CARRIED && g_flag_carrier[f] == id)
		{
			drop_flag(f, "handed over");
			g_flag_dropped_at[f] = get_gametime() + secs - CF_DROP_GRACE;
			return PLUGIN_HANDLED;
		}
	}
	return PLUGIN_CONTINUE;
}

/// .drop in chat: only the carrier's line is taken; anyone else's goes out as normal.
public cmd_drop_say(id)
{
	if (!g_active)
	{
		return PLUGIN_CONTINUE;
	}
	for (new f = 1; f <= 2; f++)
	{
		if (g_flag_state[f] == CF_CARRIED && g_flag_carrier[f] == id)
		{
			drop_flag(f, "dropped");
			return PLUGIN_HANDLED;
		}
	}
	return PLUGIN_CONTINUE;
}

public srv_cf_pad()
{
	if (read_argc() < 5)
	{
		server_print("[CTF] usage: tsm_cf_pad <side 1|2> <x> <y> <z>");
		return PLUGIN_HANDLED;
	}
	new a[16];
	read_argv(1, a, charsmax(a));
	new s = str_to_num(a);
	new Float:org[3];
	read_argv(2, a, charsmax(a));
	org[0] = str_to_float(a);
	read_argv(3, a, charsmax(a));
	org[1] = str_to_float(a);
	read_argv(4, a, charsmax(a));
	org[2] = str_to_float(a);
	set_pad(s, org, true);
	return PLUGIN_HANDLED;
}

feet_of(id, Float:org[3])
{
	pev(id, pev_origin, org);
	org[2] -= 34.0;
}

public cmd_cf_pad(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new s = str_to_num(a);
	if (s != 1 && s != 2)
	{
		console_print(id, "[CTF] usage: amx_tsm_cf_pad <1|2>");
		return PLUGIN_HANDLED;
	}
	new Float:org[3];
	feet_of(id, org);
	set_pad(s, org, true);
	if (g_active)
	{
		build_pad(s);
		if (pev_valid(g_pad_ring[s]))
		{
			new Float:ring[3];
			ring[0] = org[0];
			ring[1] = org[1];
			ring[2] = org[2] + 2.0;
			engfunc(EngFunc_SetOrigin, g_pad_ring[s], ring);
		}
	}
	else
	{
		// Both pads make the map a flag map now.
		try_claim();
	}
	console_print(id, "[CTF] Side %d's flag pad is at %.0f %.0f %.0f. amx_tsm_cf_save keeps it.", s, org[0], org[1], org[2]);
	return PLUGIN_HANDLED;
}

public cmd_cf_save(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!g_pad_have[1] && !g_pad_have[2])
	{
		console_print(id, "[CTF] This map has no flag pads to write.");
		return PLUGIN_HANDLED;
	}
	new file[160];
	map_cfg_path(file, charsmax(file));
	if (file_exists(file))
	{
		delete_file(file);
	}
	new line[160];
	formatex(line, charsmax(line), "// ts_ctf flag pads for %s -- written by amx_tsm_cf_save", g_mapname);
	write_file(file, line);
	formatex(line, charsmax(line), "// tsm_cf_pad <side 1|2> <x> <y> <z>   (the floor where that side's flag stands and its carrier turns the enemy's in)");
	write_file(file, line);
	for (new s = 1; s <= 2; s++)
	{
		if (g_pad_have[s])
		{
			formatex(line, charsmax(line), "tsm_cf_pad %d %.2f %.2f %.2f", s, g_pad[s][0], g_pad[s][1], g_pad[s][2]);
			write_file(file, line);
		}
	}
	console_print(id, "[CTF] Wrote %s.", file);
	return PLUGIN_HANDLED;
}

public cmd_cf_list(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	for (new s = 1; s <= 2; s++)
	{
		if (g_pad_have[s])
		{
			console_print(id, "[CTF] side %d: pad at %.0f %.0f %.0f (%s); its flag is %s", s, g_pad[s][0], g_pad[s][1], g_pad[s][2],
				g_pad_cfg[s] ? "config" : "map",
				(g_flag_state[s] == CF_CARRIED) ? "carried" : ((g_flag_state[s] == CF_DROPPED) ? "dropped" : "at its pad"));
		}
		else
		{
			console_print(id, "[CTF] side %d: no pad", s);
		}
	}
	return PLUGIN_HANDLED;
}

/// Gives side f's flag to the other side's first player in play (1, 2), or puts it back at its pad (0): to test the colours and the marks.
public cmd_cf_give(id, level, cid)
{
	if (!cmd_access(id, level, cid, 3))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new f = str_to_num(a);
	read_argv(2, a, charsmax(a));
	new who = str_to_num(a);
	if (!g_active || (f != 1 && f != 2) || who < 0 || who > 2 || !pev_valid(g_flag_ent[f]))
	{
		console_print(id, "[CTF] usage: amx_tsm_cf_give <flag side 1|2> <0|1|2>, in a live round on a flag map");
		return PLUGIN_HANDLED;
	}
	if (who == 0)
	{
		return_flag(f, 0);
		return PLUGIN_HANDLED;
	}
	new taker = first_in_play(who);
	if (taker)
	{
		if (g_flag_state[f] == CF_CARRIED)
		{
			drop_flag(f, "let go of");
		}
		pick_up(f, taker);
		console_print(id, "[CTF] The flag of side %d is on a player of side %d.", f, who);
		return PLUGIN_HANDLED;
	}
	console_print(id, "[CTF] No player of side %d is in play.", who);
	return PLUGIN_HANDLED;
}

/// The first player of a side in play, a person before a bot; 0 for none.
first_in_play(side)
{
	new players[MAX_PLAYERS], pnum, bot = 0;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new p = players[i];
		if (!tsm_in_play(p) || tsm_side_of(p) != side)
		{
			continue;
		}
		if (!is_user_bot(p))
		{
			return p;
		}
		if (!bot)
		{
			bot = p;
		}
	}
	return bot;
}

/// Takes the first person of a side in play to a pad, as though he had walked there: the carrier at his own pad, to see a capture.
public cmd_cf_tp(id, level, cid)
{
	if (!cmd_access(id, level, cid, 3))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new who = str_to_num(a);
	read_argv(2, a, charsmax(a));
	new pad = str_to_num(a);
	if (!g_active || (who != 1 && who != 2) || (pad != 1 && pad != 2))
	{
		console_print(id, "[CTF] usage: amx_tsm_cf_tp <side 1|2> <pad 1|2>, on a flag map");
		return PLUGIN_HANDLED;
	}
	// The side's carrier when it has one, so that a give and a tp name the same player; else its first player in play.
	new p = g_flag_carrier[3 - who];
	if (g_flag_state[3 - who] != CF_CARRIED || !p || !tsm_in_play(p) || tsm_side_of(p) != who)
	{
		p = first_in_play(who);
	}
	if (!p)
	{
		console_print(id, "[CTF] No player of side %d is in play.", who);
		return PLUGIN_HANDLED;
	}
	new Float:org[3], Float:zero[3];
	org[0] = g_pad[pad][0];
	org[1] = g_pad[pad][1];
	org[2] = g_pad[pad][2] + 36.0;
	engfunc(EngFunc_SetOrigin, p, org);
	set_pev(p, pev_velocity, zero);
	console_print(id, "[CTF] A player of side %d is on pad %d.", who, pad);
	return PLUGIN_HANDLED;
}

public cmd_cf_dump(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	console_print(id, "[CTF] build %s  active=%d core=%d mode=%d  map=%s", CF_BUILD, g_active ? 1 : 0, g_have_core ? 1 : 0, get_pcvar_num(g_cv_mode), g_mapname);
	console_print(id, "[CTF] captures %d - %d (first to %d)  needhome %d  return %.0fs  wave %.0fs  pad radius %.0f  h9_ctf_rounds %d",
		g_caps[1], g_caps[2], get_pcvar_num(g_cv_caps), get_pcvar_num(g_cv_needhome), get_pcvar_float(g_cv_return), get_pcvar_float(g_cv_wave),
		get_pcvar_float(g_cv_radius), get_pcvar_num(g_cv_rounds));
	console_print(id, "[CTF] model %s (%s), rings %d", g_flag_model, g_flag_custom ? "skins" : "tinted briefcase", g_ring_ok ? 1 : 0);
	console_print(id, "[CTF] bots: tsm_bot_objectives %d, tsm_cf_bots %d -- %s", tsb_bots_play() ? 1 : 0, get_pcvar_num(g_cv_bots),
		(tsb_bots_play() || get_pcvar_num(g_cv_bots)) ? "a bot takes and returns flags" : "the flags are the people's");
	cmd_cf_list(id, level, cid);
	for (new f = 1; f <= 2; f++)
	{
		if (g_active && pev_valid(g_flag_ent[f]))
		{
			new Float:left, Float:padat[3];
			pev(g_flag_ent[f], pev_fuser2, left);
			pev(g_flag_ent[f], pev_vuser1, padat);
			console_print(id, "[CTF] flag %d for the bots: state %d scores-now %d home-in %.1fs pad %.0f %.0f %.0f", f,
				pev(g_flag_ent[f], pev_iuser1), pev(g_flag_ent[f], pev_iuser2), left, padat[0], padat[1], padat[2]);
		}
	}
	return PLUGIN_HANDLED;
}

/* ---- helpers ------------------------------------------------------------------------------- */

/// A "[MATCH]" chat line, kept off the chat while ts_matchmode's tsm_verbosity is 0, as its own are. With no ts_matchmode to ask, the line goes out.
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

/// A side's short name for chat: tsm_teamN_short, else the team's own name tidied up.
side_name(side, out[], len)
{
	if (side != 1 && side != 2)
	{
		copy(out, len, "nobody");
		return;
	}
	get_cvar_string((side == 1) ? "tsm_team1_short" : "tsm_team2_short", out, len);
	if (out[0])
	{
		return;
	}
	get_cvar_string((side == 1) ? "tsm_team1_name" : "tsm_team2_name", out, len);
	if (!out[0])
	{
		copy(out, len, (side == 1) ? "Side 1" : "Side 2");
		return;
	}
	if (strlen(out) <= 4)
	{
		strtoupper(out);
	}
	else
	{
		out[0] = char_to_upper(out[0]);
	}
}
