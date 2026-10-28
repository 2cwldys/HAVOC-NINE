/*
 * ts_uplink.sma -- CAPTURE THE UPLINK, a mode for ts_matchmode.
 *
 * Both sides fight over one carried objective, the uplink. Whoever carries it can take the
 * map's control zones: fifteen seconds inside a zone with no living enemy in it. Holding
 * every zone wins the round on the spot; when the clock runs out the side holding the most
 * zones wins it, and equal zones is a draw. A side wiped out -- no lives left and nobody
 * waiting for a wave -- loses whatever it held, exactly as in team elimination, because
 * that part is ts_matchmode's own round logic and this plugin never overrides it.
 *
 * WHICH MAPS. A map is an uplink map when it has control zones: entities with the
 * targetnames tsm_cap_1 to tsm_cap_9 (any entity -- a point entity's origin is the zone's
 * centre, a brush's box is its footprint), or zones written to the map's own config,
 * configs/tsm_uplink_<map>.cfg, by the editor commands below. The uplink appears each round
 * at the point named tsm_uplink, or the config's tsm_uplink_at. tsm_uplink_mode 0 turns the
 * mode off everywhere. A map that also carries siege objectives (tsm_obj_#) stays a siege
 * map: ts_matchmode refuses the claim, and the conflict is logged.
 *
 * THE UPLINK is this plugin's own entity, built after TS's briefcase (the reTS CTSFlag and
 * CTSBriefcase): picked up by walking over it, worn on the carrier's back, dropped where the
 * carrier falls, and home again after tsm_uplink_return seconds untouched. The carrier keeps
 * every weapon and is marked to BOTH sides by a sprite overhead. "dropuplink" in the console
 * (bind it) or .drop in chat lets it go.
 *
 * THE MODE API. Everything this plugin needs from the match -- the round's start, end and
 * time-up, lives, waves, who is in play -- comes through include\tsm_api.inc. With
 * ts_matchmode missing the native filter below lets this plugin load, and it does nothing.
 *
 * BOTS fight on an uplink map but do not play the objective: no rcbot change reads it yet.
 * For one that would, the uplink is the entity with the classname tsm_uplink (its aiment is
 * the carrier while it is carried), and the zone rings are classname tsm_cap, whose team
 * field is the owner (0, 1 or 2), fuser1 the radius and iuser1 the zone's number. Keep
 * those fields as they are.
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler and a strict log:
 * ASCII only, explicit braces, no warnings.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <tsm_api>

#define PLUGIN  "TS Uplink"
#define VERSION "1.0"
#define AUTHOR  "tsm"

// Printed by amx_tsm_uplink, so there is never any doubt which build is loaded.
#define UPL_BUILD "1.0-modes2"

#define UPL_MAXZONES   9
#define UPL_TICK       0.1
#define UPL_TASK_TICK  71101
#define UPL_TASK_CLAIM 71102

/*
 * The assets. Built by export-map/h9_drainage/sprites.mjs (the sprites) and the SMAK model
 * script beside it (the uplink), shipped with the client and the server. Each is precached only
 * when the file is really there -- a precached name with no file is a fatal Host_Error -- and
 * the mode falls back to TS's own briefcase and to no zone sprites rather than not running.
 */
#define UPL_MODEL          "models/tsm_uplink.mdl"
#define UPL_MODEL_FALLBACK "models/briefcase.mdl"
#define UPL_RING_0         "sprites/tsm_zone_ring_0.spr"
#define UPL_RING_1         "sprites/tsm_zone_ring_1.spr"
#define UPL_RING_2         "sprites/tsm_zone_ring_2.spr"
#define UPL_RING_CAP       "sprites/tsm_zone_ring_cap.spr"
#define UPL_FLAG           "sprites/tsm_zone_flag.spr"
#define UPL_MARK           "sprites/tsm_uplink_mark.spr"

// Stock Half-Life sounds every client already has.
#define UPL_SND_PICKUP  "items/gunpickup2.wav"
#define UPL_SND_DROP    "items/weapondrop1.wav"
#define UPL_SND_RETURN  "items/suitchargeok1.wav"
#define UPL_SND_CAPTURE "buttons/bell1.wav"

// The ring sprites are 128 pixels across with the ring at 56 (export-map/h9_drainage/sprites.mjs):
// a sprite draws a pixel a unit, so a zone of radius R is the ring at scale R / 56.
#define UPL_RING_PX     56.0
#define UPL_FLAG_HIGH   110.0   // the control flag hangs this far above the zone's point
#define UPL_MARK_HIGH   78.0    // and the carrier's marker this far above his origin
#define UPL_ZONE_DZ     96.0    // how far above or below a zone's point still counts as in it
#define UPL_PICKUP      44.0    // how close a player must come to the loose uplink to take it
#define UPL_DROP_GRACE  1.5     // the one who dropped it cannot take it back for this long

// Engine values, spelled out here so this file needs nothing beyond fakemeta.
#define UPL_MT_NONE     0
#define UPL_MT_TOSS     6
#define UPL_MT_NOCLIP   8
#define UPL_MT_FOLLOW   12
#define UPL_SOLID_NOT     0
#define UPL_SOLID_TRIGGER 1
#define UPL_RENDER_NORMAL 0
#define UPL_RENDER_ADD    5
#define UPL_EF_NODRAW   128

new g_cv_mode, g_cv_captime, g_cv_radius, g_cv_reward, g_cv_wave, g_cv_return, g_cv_desc;

new bool:g_have_core = true;   // cleared by the native filter when ts_matchmode is not loaded
new bool:g_active = false;     // this map is claimed for the uplink
new g_mapname[32];

// What the precache found on disk.
new g_up_model[48];
new bool:g_ring_ok, bool:g_ringcap_ok, bool:g_flag_ok, bool:g_mark_ok;
new g_ring_frames[3], g_ringcap_frames;

// The zones, 1..UPL_MAXZONES. g_zone_cfg: placed by the map's config or an editor command,
// not by the map itself -- only those are written back out by amx_tsm_uplink_save.
new bool:g_zone_have[UPL_MAXZONES + 1];
new bool:g_zone_cfg[UPL_MAXZONES + 1];
new Float:g_zone_org[UPL_MAXZONES + 1][3];
new Float:g_zone_rad[UPL_MAXZONES + 1];
new g_zone_owner[UPL_MAXZONES + 1];
new g_zone_ring[UPL_MAXZONES + 1];
new g_zone_flag[UPL_MAXZONES + 1];
new g_zone_count;
new g_ring_frame;              // the shared animation frame of every ring

// The uplink itself.
new Float:g_home[3];
new Float:g_waves_set;         // the wave interval last handed to ts_matchmode, for the log
new bool:g_home_have, bool:g_home_cfg;
new g_up_ent;                  // the entity; 0 when it is not in the world
new g_carrier;                 // who carries it; 0 when it lies loose
new bool:g_at_home;            // lying where it appears, so it is never "returned"
new Float:g_loose_since;       // when it was last dropped
new g_dropper;                 // who dropped it last, kept off it for UPL_DROP_GRACE
new Float:g_dropped_at;
new Float:g_carrier_at[3];     // where the carrier was last seen, for a drop when he vanishes
new g_mark_ent;                // the marker over the carrier

// The capture in progress.
new g_cap_zone;                // zone being taken; 0 when none
new g_cap_side;
new Float:g_cap_started;

new g_ticks;                   // tick counter, for the once-a-second work

/*
 * Lets every tsm_* native be missing instead of refusing to load (the pattern ts_advertise uses).
 * Set here and not in plugin_init: AMXX links natives before any plugin_init runs. A missing
 * native called at run time returns 0, which every caller below reads as "no core".
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
	// The uplink's own model, or TS's briefcase, which ships with the game.
	if (file_exists(UPL_MODEL, true))
	{
		copy(g_up_model, charsmax(g_up_model), UPL_MODEL);
	}
	else
	{
		copy(g_up_model, charsmax(g_up_model), UPL_MODEL_FALLBACK);
	}
	precache_model(g_up_model);

	g_ring_ok = (file_exists(UPL_RING_0, true) && file_exists(UPL_RING_1, true) && file_exists(UPL_RING_2, true));
	if (g_ring_ok)
	{
		g_ring_frames[0] = engfunc(EngFunc_ModelFrames, precache_model(UPL_RING_0));
		g_ring_frames[1] = engfunc(EngFunc_ModelFrames, precache_model(UPL_RING_1));
		g_ring_frames[2] = engfunc(EngFunc_ModelFrames, precache_model(UPL_RING_2));
	}
	g_ringcap_ok = (file_exists(UPL_RING_CAP, true) != 0);
	if (g_ringcap_ok)
	{
		g_ringcap_frames = engfunc(EngFunc_ModelFrames, precache_model(UPL_RING_CAP));
	}
	g_flag_ok = (file_exists(UPL_FLAG, true) != 0);
	if (g_flag_ok)
	{
		precache_model(UPL_FLAG);
	}
	g_mark_ok = (file_exists(UPL_MARK, true) != 0);
	if (g_mark_ok)
	{
		precache_model(UPL_MARK);
	}

	precache_sound(UPL_SND_PICKUP);
	precache_sound(UPL_SND_DROP);
	precache_sound(UPL_SND_RETURN);
	precache_sound(UPL_SND_CAPTURE);
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_mode    = register_cvar("tsm_uplink_mode",        "1");
	g_cv_captime = register_cvar("tsm_cap_time",           "15");
	g_cv_radius  = register_cvar("tsm_cap_radius",         "128");
	g_cv_reward  = register_cvar("tsm_uplink_rewardlives", "1");
	g_cv_wave    = register_cvar("tsm_uplink_wave",        "30");
	g_cv_return  = register_cvar("tsm_uplink_return",      "20");
	g_cv_desc    = register_cvar("tsm_gamedesc_uplink",    "Capture the Uplink");

	// The carrier lets go: bindable from the console, or typed in chat.
	register_clcmd("dropuplink", "cmd_drop", 0, "- let the uplink go, if you carry it");
	register_clcmd("say .drop", "cmd_drop_say");
	register_clcmd("say_team .drop", "cmd_drop_say");

	// The zone editor, the same shape as the spawn editor's.
	register_concmd("amx_tsm_cap_add",     "cmd_cap_add",     ADMIN_CFG, " [n] [radius] - a control zone where you stand");
	register_concmd("amx_tsm_cap_del",     "cmd_cap_del",     ADMIN_CFG, " <n> - remove a control zone");
	register_concmd("amx_tsm_cap_list",    "cmd_cap_list",    ADMIN_CFG, " - the control zones and who holds them");
	register_concmd("amx_tsm_cap_give",    "cmd_cap_give",    ADMIN_CFG, " <n> <0|1|2> - hand a zone to a side (testing)");
	register_concmd("amx_tsm_uplink_set",  "cmd_uplink_set",  ADMIN_CFG, " - the uplink appears where you stand");
	register_concmd("amx_tsm_uplink_save", "cmd_uplink_save", ADMIN_CFG, " - write this map's zones and uplink point");
	register_concmd("amx_tsm_uplink",      "cmd_uplink_dump", ADMIN_CFG, " - the uplink mode's whole state");

	// Read from configs/tsm_uplink_<map>.cfg, which amx_tsm_uplink_save writes.
	register_srvcmd("tsm_cap",       "srv_cap");
	register_srvcmd("tsm_uplink_at", "srv_uplink_at");

	// The carrier's marker follows him every frame, not every tick.
	register_forward(FM_StartFrame, "fw_startframe_post", 1);
}

public plugin_cfg()
{
	get_mapname(g_mapname, charsmax(g_mapname));

	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_uplink.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// This map's zones and uplink point, if the editor saved any.
	map_cfg_path(file, charsmax(file));
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// The claim waits a moment: the map's own entities have settled by then, and h9_autoconfig
	// has run ts/mapconfigs/<map>.cfg, which may set tsm_uplink_mode for this map alone.
	set_task(2.0, "task_claim", UPL_TASK_CLAIM);
}

map_cfg_path(path[], len)
{
	new dir[64];
	get_configsdir(dir, charsmax(dir));
	formatex(path, len, "%s/tsm_uplink_%s.cfg", dir, g_mapname);
}

/* ---- the claim -------------------------------------------------------------------------- */

/*
 * Reads the map's zones and point and, when it has zones, claims the map for the uplink. Done
 * once a map. A refused claim -- siege objectives on the map, another mode already holding
 * it, no ts_matchmode -- leaves this plugin doing nothing at all.
 */
public task_claim()
{
	scan_map();
	try_claim();
}

/// The zones and the uplink point the map itself carries, beside whatever the config placed.
scan_map()
{
	new name[16];
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			continue;   // the config's placement wins over the map's
		}
		formatex(name, charsmax(name), "tsm_cap_%d", n);
		new ent = engfunc(EngFunc_FindEntityByString, -1, "targetname", name);
		if (ent <= 0 || !pev_valid(ent))
		{
			continue;
		}

		new Float:org[3], Float:mins[3], Float:maxs[3];
		pev(ent, pev_absmin, mins);
		pev(ent, pev_absmax, maxs);
		new Float:rad = get_pcvar_float(g_cv_radius);

		// A brush is its own footprint: the centre of its box, at its floor, as wide as it is.
		if (maxs[0] - mins[0] > 4.0 && maxs[1] - mins[1] > 4.0)
		{
			org[0] = (mins[0] + maxs[0]) * 0.5;
			org[1] = (mins[1] + maxs[1]) * 0.5;
			org[2] = mins[2];
			new Float:wx = (maxs[0] - mins[0]) * 0.5;
			new Float:wy = (maxs[1] - mins[1]) * 0.5;
			rad = (wx > wy) ? wx : wy;
		}
		else
		{
			pev(ent, pev_origin, org);
		}
		set_zone(n, org, rad, false);
	}

	if (!g_home_have)
	{
		new ent = engfunc(EngFunc_FindEntityByString, -1, "targetname", "tsm_uplink");
		if (ent > 0 && pev_valid(ent))
		{
			pev(ent, pev_origin, g_home);
			g_home_have = true;
		}
	}
}

set_zone(n, const Float:org[3], Float:rad, bool:from_cfg)
{
	if (n < 1 || n > UPL_MAXZONES)
	{
		return;
	}
	if (!g_zone_have[n])
	{
		g_zone_count++;
	}
	g_zone_have[n] = true;
	g_zone_cfg[n] = from_cfg;
	g_zone_org[n][0] = org[0];
	g_zone_org[n][1] = org[1];
	g_zone_org[n][2] = org[2];
	g_zone_rad[n] = (rad > 16.0) ? rad : 16.0;
	g_zone_owner[n] = 0;
}

/*
 * Both sides' respawn waves every tsm_uplink_wave seconds: on an uplink map this, not
 * tsm_respawn_wave, sets them. Applied at the claim and again as each round starts, before
 * ts_matchmode starts that round's wave clocks, so a map's mapconfig or a console change takes
 * effect from the next round. Logged whenever the interval changes.
 */
apply_waves()
{
	new Float:wave = get_pcvar_float(g_cv_wave);
	tsm_wave_seconds(1, wave);
	tsm_wave_seconds(2, wave);
	if (wave != g_waves_set)
	{
		g_waves_set = wave;
		log_amx("[UPLINK] Respawn waves every %.0fs for both sides on %s.", wave, g_mapname);
	}
}

try_claim()
{
	// tsm_enabled 0: the map plays as the game ships (ts_matchmode's per-map rule, or the map's mapconfig).
	if (g_active || !g_have_core || !get_pcvar_num(g_cv_mode) || !g_zone_count || !get_cvar_num("tsm_enabled"))
	{
		return;
	}

	new desc[64];
	get_pcvar_string(g_cv_desc, desc, charsmax(desc));
	if (!desc[0])
	{
		copy(desc, charsmax(desc), "Capture the Uplink");
	}
	if (!tsm_mode_claim("uplink", desc, TSM_MODE_NO_SUDDEN))
	{
		log_amx("[UPLINK] %s has %d control zone(s) but the claim was refused (siege objectives, another mode, or no ts_matchmode).",
			g_mapname, g_zone_count);
		return;
	}

	g_active = true;
	apply_waves();

	if (!g_home_have)
	{
		// No point placed: the first zone stands in, so the round still has an uplink.
		for (new n = 1; n <= UPL_MAXZONES; n++)
		{
			if (g_zone_have[n])
			{
				g_home[0] = g_zone_org[n][0];
				g_home[1] = g_zone_org[n][1];
				g_home[2] = g_zone_org[n][2] + 16.0;
				g_home_have = true;
				log_amx("[UPLINK] %s has no tsm_uplink point -- the uplink appears at zone %d instead.", g_mapname, n);
				break;
			}
		}
	}

	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			build_zone(n);
		}
	}
	refresh_hud();

	remove_task(UPL_TASK_TICK);
	set_task(UPL_TICK, "task_tick", UPL_TASK_TICK, "", 0, "b");
	log_amx("[UPLINK] %s is an uplink map: %d control zone(s), uplink point %.0f %.0f %.0f.",
		g_mapname, g_zone_count, g_home[0], g_home[1], g_home[2]);
}

/* ---- the zones' entities ---------------------------------------------------------------- */

/// A zone's ring on the ground and its control flag overhead, made once and reused all map.
build_zone(n)
{
	if (g_ring_ok && !pev_valid(g_zone_ring[n]))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent > 0)
		{
			set_pev(ent, pev_classname, "tsm_cap");
			engfunc(EngFunc_SetModel, ent, UPL_RING_0);
			set_pev(ent, pev_movetype, UPL_MT_NONE);
			set_pev(ent, pev_solid, UPL_SOLID_NOT);
			set_pev(ent, pev_rendermode, UPL_RENDER_ADD);
			set_pev(ent, pev_renderamt, 255.0);
			// Laid flat: an oriented sprite faces along its angles, so a pitch of 90 faces it down.
			new Float:ang[3] = { 90.0, 0.0, 0.0 };
			set_pev(ent, pev_angles, ang);
			set_pev(ent, pev_scale, g_zone_rad[n] / UPL_RING_PX);
			new Float:org[3];
			org[0] = g_zone_org[n][0];
			org[1] = g_zone_org[n][1];
			org[2] = g_zone_org[n][2] + 2.0;   // just off the floor, never inside it
			engfunc(EngFunc_SetOrigin, ent, org);
			g_zone_ring[n] = ent;
		}
	}
	if (g_flag_ok && !pev_valid(g_zone_flag[n]))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent > 0)
		{
			set_pev(ent, pev_classname, "tsm_cap_flag");
			engfunc(EngFunc_SetModel, ent, UPL_FLAG);
			set_pev(ent, pev_movetype, UPL_MT_NONE);
			set_pev(ent, pev_solid, UPL_SOLID_NOT);
			set_pev(ent, pev_rendermode, UPL_RENDER_ADD);
			set_pev(ent, pev_renderamt, 255.0);
			set_pev(ent, pev_scale, 0.5);
			new Float:org[3];
			org[0] = g_zone_org[n][0];
			org[1] = g_zone_org[n][1];
			org[2] = g_zone_org[n][2] + UPL_FLAG_HIGH;
			engfunc(EngFunc_SetOrigin, ent, org);
			g_zone_flag[n] = ent;
		}
	}
	paint_zone(n);
}

/// Shows who holds a zone: the ring in the holder's colour, the flag on the holder's frame.
paint_zone(n)
{
	new ring = g_zone_ring[n];
	if (ring > 0 && pev_valid(ring))
	{
		// The bots read these three: the holder, the reach and the number.
		set_pev(ring, pev_team, g_zone_owner[n]);
		set_pev(ring, pev_fuser1, g_zone_rad[n]);
		set_pev(ring, pev_iuser1, n);

		if (g_cap_zone == n && g_ringcap_ok)
		{
			engfunc(EngFunc_SetModel, ring, UPL_RING_CAP);
		}
		else if (g_zone_owner[n] == 1)
		{
			engfunc(EngFunc_SetModel, ring, UPL_RING_1);
		}
		else if (g_zone_owner[n] == 2)
		{
			engfunc(EngFunc_SetModel, ring, UPL_RING_2);
		}
		else
		{
			engfunc(EngFunc_SetModel, ring, UPL_RING_0);
		}
		set_pev(ring, pev_scale, g_zone_rad[n] / UPL_RING_PX);
	}

	new flag = g_zone_flag[n];
	if (flag > 0 && pev_valid(flag))
	{
		set_pev(flag, pev_frame, float(g_zone_owner[n]));
	}
}

/// Steps every ring's animation on, ten frames a second.
animate_rings()
{
	g_ring_frame++;
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		new ring = g_zone_ring[n];
		if (!g_zone_have[n] || ring <= 0 || !pev_valid(ring))
		{
			continue;
		}
		new frames = (g_cap_zone == n && g_ringcap_ok) ? g_ringcap_frames : g_ring_frames[g_zone_owner[n]];
		if (frames > 1)
		{
			set_pev(ring, pev_frame, float(g_ring_frame % frames));
		}
	}
}

/* ---- the uplink --------------------------------------------------------------------------- */

/// The uplink, loose, at a point: made if it is not in the world yet.
put_uplink(const Float:org[3], bool:home)
{
	if (!pev_valid(g_up_ent))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent <= 0)
		{
			log_amx("[UPLINK] WARNING: could not create the uplink -- out of edicts?");
			return;
		}
		set_pev(ent, pev_classname, "tsm_uplink");
		engfunc(EngFunc_SetModel, ent, g_up_model);
		g_up_ent = ent;
	}

	new ent = g_up_ent;
	set_pev(ent, pev_aiment, 0);
	set_pev(ent, pev_owner, 0);
	set_pev(ent, pev_movetype, UPL_MT_TOSS);
	set_pev(ent, pev_solid, UPL_SOLID_TRIGGER);
	set_pev(ent, pev_body, 0);           // body 0: the case lying in the world
	set_pev(ent, pev_sequence, 0);       // its idle turn
	set_pev(ent, pev_framerate, 1.0);
	set_pev(ent, pev_animtime, get_gametime());
	set_pev(ent, pev_effects, pev(ent, pev_effects) & ~UPL_EF_NODRAW);
	new Float:mins[3] = { -10.0, -10.0, 0.0 };
	new Float:maxs[3] = { 10.0, 10.0, 20.0 };
	engfunc(EngFunc_SetSize, ent, mins, maxs);
	engfunc(EngFunc_SetOrigin, ent, org);
	new Float:zero[3];
	set_pev(ent, pev_velocity, zero);

	g_carrier = 0;
	g_at_home = home;
	g_loose_since = get_gametime();
	hide_mark();
}

/// Takes the uplink out of the world, carried or not.
remove_uplink()
{
	if (pev_valid(g_up_ent))
	{
		engfunc(EngFunc_RemoveEntity, g_up_ent);
	}
	g_up_ent = 0;
	g_carrier = 0;
	g_at_home = false;
	hide_mark();
	clear_capture();
}

/// A player takes the uplink: on his back, marked for everyone.
pick_up(id)
{
	new ent = g_up_ent;
	if (!pev_valid(ent))
	{
		return;
	}

	g_carrier = id;
	g_at_home = false;
	pev(id, pev_origin, g_carrier_at);

	// Carried on the back: the model follows the carrier and merges onto his skeleton.
	set_pev(ent, pev_solid, UPL_SOLID_NOT);
	set_pev(ent, pev_movetype, UPL_MT_FOLLOW);
	set_pev(ent, pev_aiment, id);
	set_pev(ent, pev_owner, id);
	set_pev(ent, pev_body, 1);           // body 1: the pack worn on the back
	engfunc(EngFunc_SetOrigin, ent, g_carrier_at);

	emit_sound(id, CHAN_AUTO, UPL_SND_PICKUP, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	new name[32], side[24];
	get_user_name(id, name, charsmax(name));
	side_name(tsm_side_of(id), side, charsmax(side));
	client_print(0, print_chat, "[MATCH] %s has the uplink for %s!", name, side);
	if (!is_user_bot(id))
	{
		client_print(id, print_center, "You have the uplink -- take a zone. Type dropuplink to let it go.");
	}
}

/// The carrier lets go, or falls: the uplink drops where he is.
drop_uplink(const reason[])
{
	new ent = g_up_ent;
	new id = g_carrier;
	if (!pev_valid(ent) || !id)
	{
		return;
	}

	new Float:org[3], Float:vel[3];
	if (is_user_connected(id))
	{
		pev(id, pev_origin, org);
		pev(id, pev_velocity, vel);
	}
	else
	{
		org[0] = g_carrier_at[0];
		org[1] = g_carrier_at[1];
		org[2] = g_carrier_at[2];
	}
	clear_capture();
	put_uplink(org, false);

	// Thrown a little up and on, the way a dropped briefcase leaves the hand.
	vel[0] *= 0.5;
	vel[1] *= 0.5;
	vel[2] = 150.0;
	set_pev(ent, pev_velocity, vel);

	g_dropper = id;
	g_dropped_at = get_gametime();
	emit_sound(ent, CHAN_AUTO, UPL_SND_DROP, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	new name[32];
	if (is_user_connected(id))
	{
		get_user_name(id, name, charsmax(name));
	}
	else
	{
		copy(name, charsmax(name), "The carrier");
	}
	client_print(0, print_chat, "[MATCH] %s %s the uplink.", name, reason);
}

/// Home again: untouched too long, or somewhere nobody can reach.
return_uplink()
{
	if (!g_home_have)
	{
		return;
	}
	put_uplink(g_home, true);
	if (pev_valid(g_up_ent))
	{
		emit_sound(g_up_ent, CHAN_AUTO, UPL_SND_RETURN, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	}
	client_print(0, print_chat, "[MATCH] The uplink is back at its post.");
}

hide_mark()
{
	if (g_mark_ent > 0 && pev_valid(g_mark_ent))
	{
		set_pev(g_mark_ent, pev_effects, pev(g_mark_ent, pev_effects) | UPL_EF_NODRAW);
	}
}

/// The marker over the carrier, seen by both sides: made once, moved every frame.
show_mark(id)
{
	if (!g_mark_ok)
	{
		return;
	}
	if (g_mark_ent <= 0 || !pev_valid(g_mark_ent))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent <= 0)
		{
			return;
		}
		set_pev(ent, pev_classname, "tsm_uplink_mark");
		engfunc(EngFunc_SetModel, ent, UPL_MARK);
		set_pev(ent, pev_movetype, UPL_MT_NOCLIP);
		set_pev(ent, pev_solid, UPL_SOLID_NOT);
		set_pev(ent, pev_rendermode, UPL_RENDER_ADD);
		set_pev(ent, pev_renderamt, 255.0);
		set_pev(ent, pev_scale, 0.4);
		g_mark_ent = ent;
	}
	// Frame 0 is side 1's colour, frame 1 side 2's.
	set_pev(g_mark_ent, pev_frame, (tsm_side_of(id) == 2) ? 1.0 : 0.0);
	set_pev(g_mark_ent, pev_effects, pev(g_mark_ent, pev_effects) & ~UPL_EF_NODRAW);
}

public fw_startframe_post()
{
	if (!g_active || !g_carrier || g_mark_ent <= 0 || !pev_valid(g_mark_ent) || !is_user_connected(g_carrier))
	{
		return FMRES_IGNORED;
	}
	new Float:org[3];
	pev(g_carrier, pev_origin, org);
	org[2] += UPL_MARK_HIGH;
	engfunc(EngFunc_SetOrigin, g_mark_ent, org);
	return FMRES_IGNORED;
}

/* ---- the tick ------------------------------------------------------------------------------ */

public task_tick()
{
	if (!g_active)
	{
		return;
	}

	g_ticks++;
	animate_rings();

	// Outside a live round there is no uplink in play, whatever ended the round: a halt, a
	// cancel and an abandoned match all pass through here, not only the round-end forward.
	if (tsm_state() != TSM_ST_LIVE)
	{
		if (pev_valid(g_up_ent) || g_carrier)
		{
			remove_uplink();
		}
		if (g_ticks % 10 == 0)
		{
			refresh_hud();
		}
		return;
	}

	if (!pev_valid(g_up_ent))
	{
		if (g_home_have)
		{
			put_uplink(g_home, true);
		}
		return;
	}

	if (g_carrier)
	{
		carried_tick();
	}
	else
	{
		loose_tick();
	}

	if (g_ticks % 10 == 0)
	{
		refresh_hud();
	}
}

carried_tick()
{
	new id = g_carrier;

	// Dead, eliminated, benched, gone: the uplink falls where he was.
	if (!is_user_connected(id))
	{
		drop_uplink("lost");
		return;
	}
	if (!tsm_in_play(id))
	{
		if (is_user_alive(id))
		{
			drop_uplink("let go of");
		}
		else
		{
			drop_uplink("dropped");
		}
		return;
	}

	pev(id, pev_origin, g_carrier_at);
	show_mark(id);

	new side = tsm_side_of(id);
	new z = zone_at(g_carrier_at);
	if (!z || g_zone_owner[z] == side)
	{
		if (g_cap_zone)
		{
			clear_capture();
		}
		if (!z && !is_user_bot(id) && g_ticks % 10 == 0)
		{
			set_hudmessage(255, 255, 255, -1.0, 0.47, 0, 0.0, 1.1, 0.0, 0.2, 3);
			show_hudmessage(id, "YOU HAVE THE UPLINK^nTake a zone");
		}
		return;
	}

	if (zone_contested(z, side))
	{
		if (g_cap_zone)
		{
			if (!is_user_bot(id))
			{
				client_print(id, print_center, "Zone %d is contested -- clear it first.", z);
			}
			clear_capture();
		}
		return;
	}

	new Float:now = get_gametime();
	if (g_cap_zone != z || g_cap_side != side)
	{
		clear_capture();
		g_cap_zone = z;
		g_cap_side = side;
		g_cap_started = now;
		paint_zone(z);

		new sname[24];
		side_name(side, sname, charsmax(sname));
		client_print(0, print_chat, "[MATCH] %s is taking zone %d.", sname, z);
	}

	new Float:need = get_pcvar_float(g_cv_captime);
	new Float:held = now - g_cap_started;
	if (held >= need)
	{
		capture_zone(z, side, id);
		return;
	}
	capture_bar(id, side, held, need);
}

loose_tick()
{
	new ent = g_up_ent;
	new Float:org[3];
	pev(ent, pev_origin, org);

	// Fallen out of the world, into the sky or a wall: home at once.
	new contents = engfunc(EngFunc_PointContents, org);
	if (contents == -2 || contents == -6 || org[2] < -16000.0)   // CONTENTS_SOLID, CONTENTS_SKY
	{
		return_uplink();
		return;
	}

	new Float:now = get_gametime();

	// Somebody takes it: the nearest player in play within reach.
	new players[32], pnum, best = 0;
	new Float:bestd = UPL_PICKUP;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!tsm_in_play(id))
		{
			continue;
		}
		if (id == g_dropper && now - g_dropped_at < UPL_DROP_GRACE)
		{
			continue;
		}
		new Float:p[3];
		pev(id, pev_origin, p);
		new Float:dx = p[0] - org[0];
		new Float:dy = p[1] - org[1];
		new Float:dz = p[2] - org[2];
		// The player's origin is his middle, about 36 units above his feet: measured from there.
		if (dz > 0.0)
		{
			dz = (dz > 36.0) ? (dz - 36.0) : 0.0;
		}
		new Float:d = floatsqroot(dx * dx + dy * dy + dz * dz);
		if (d <= bestd)
		{
			bestd = d;
			best = id;
		}
	}
	if (best)
	{
		pick_up(best);
		return;
	}

	// Untouched too long: home.
	new Float:wait = get_pcvar_float(g_cv_return);
	if (!g_at_home && wait > 0.0 && now - g_loose_since >= wait)
	{
		return_uplink();
	}
}

/* ---- zones and capture -------------------------------------------------------------------- */

/// The zone a point stands in: within its radius across the floor, and near its height.
zone_at(const Float:org[3])
{
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (!g_zone_have[n])
		{
			continue;
		}
		new Float:dx = org[0] - g_zone_org[n][0];
		new Float:dy = org[1] - g_zone_org[n][1];
		new Float:dz = org[2] - g_zone_org[n][2];
		if (dz < -UPL_ZONE_DZ || dz > UPL_ZONE_DZ)
		{
			continue;
		}
		if (dx * dx + dy * dy <= g_zone_rad[n] * g_zone_rad[n])
		{
			return n;
		}
	}
	return 0;
}

/// Is a living enemy of this side standing in the zone?
bool:zone_contested(z, side)
{
	new players[32], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!tsm_in_play(id))
		{
			continue;
		}
		new s = tsm_side_of(id);
		if (s == side || (s != 1 && s != 2))
		{
			continue;
		}
		new Float:p[3];
		pev(id, pev_origin, p);
		if (zone_at(p) == z)
		{
			return true;
		}
	}
	return false;
}

/// Puts a capture in progress back to nothing, and the zone's ring back to its holder's colour.
clear_capture()
{
	new z = g_cap_zone;
	g_cap_zone = 0;
	g_cap_side = 0;
	g_cap_started = 0.0;
	if (z)
	{
		paint_zone(z);
	}
}

/// The carrier's own bar, the siege plant's shape, in his side's colour.
capture_bar(id, side, Float:held, Float:need)
{
	if (is_user_bot(id))
	{
		return;
	}
	new filled = floatround((held / need) * 20.0);
	if (filled < 0)
	{
		filled = 0;
	}
	if (filled > 20)
	{
		filled = 20;
	}
	new bar[24];
	for (new i = 0; i < 20; i++)
	{
		bar[i] = (i < filled) ? '=' : ' ';
	}
	bar[20] = 0;

	if (side == 1)
	{
		set_hudmessage(0, 170, 255, -1.0, 0.47, 0, 0.0, 0.25, 0.05, 1.0, 3);
	}
	else
	{
		set_hudmessage(255, 70, 60, -1.0, 0.47, 0, 0.0, 0.25, 0.05, 1.0, 3);
	}
	show_hudmessage(id, "TAKING THE ZONE^n[%s]", bar);
}

/*
 * What taking a zone gives back, by tsm_uplink_rewardlives: 1 the side that took it, 2 both
 * sides, 0 nothing. Every count is SET to the player's class count, never added to, and the
 * fallen are brought back at once by a forced wave rather than left for the next one. With
 * waves off (tsm_respawns 0) ts_matchmode answers -1 and nothing changes.
 */
reward_capture(side, const sname[])
{
	new reward = get_pcvar_num(g_cv_reward);
	if (reward != 1 && reward != 2)
	{
		return;
	}
	if (tsm_reward_lives(reward == 1 ? side : 0) < 0)
	{
		return;
	}

	new back = tsm_fire_wave(side);
	if (reward == 2)
	{
		new other = tsm_fire_wave(3 - side);
		client_print(0, print_chat, "[MATCH] Lives are back to full on both sides -- %d of the fallen are back in the fight.",
			back + other);
		log_amx("[UPLINK] Zone reward, both sides: lives reset, %d and %d back at once.", back, other);
		return;
	}
	client_print(0, print_chat, "[MATCH] Lives are back to full for %s -- %d of their fallen %s back in the fight.",
		sname, back, (back == 1) ? "is" : "are");
	log_amx("[UPLINK] Zone reward for side %d: lives reset, %d back at once.", side, back);
}

/// A zone falls to a side: painted, announced, and either every zone held wins the round or the
/// side's lives come back (reward_capture).
capture_zone(z, side, id)
{
	g_zone_owner[z] = side;
	clear_capture();

	if (g_zone_ring[z] > 0 && pev_valid(g_zone_ring[z]))
	{
		emit_sound(g_zone_ring[z], CHAN_AUTO, UPL_SND_CAPTURE, VOL_NORM, ATTN_NONE, 0, PITCH_NORM);
	}

	new held[3];
	count_zones(held);

	new name[32], sname[24];
	get_user_name(id, name, charsmax(name));
	side_name(side, sname, charsmax(sname));
	client_print(0, print_chat, "[MATCH] %s took zone %d for %s -- %s holds %d of %d.",
		name, z, sname, sname, held[side], g_zone_count);

	refresh_hud();

	// Every zone held ends the round on the spot: nothing is left to give lives back for.
	if (held[side] >= g_zone_count)
	{
		client_print(0, print_chat, "[MATCH] %s holds every zone.", sname);
		tsm_end_round(side);
		return;
	}

	reward_capture(side, sname);
}

/// How many zones each side holds: held[1], held[2]; held[0] the neutral ones.
count_zones(held[3])
{
	held[0] = 0;
	held[1] = 0;
	held[2] = 0;
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			new o = g_zone_owner[n];
			held[(o == 1 || o == 2) ? o : 0]++;
		}
	}
}

/// The round line's zone count and the Discord card's progress.
refresh_hud()
{
	if (!g_active)
	{
		return;
	}
	new held[3];
	count_zones(held);

	new line[32];
	formatex(line, charsmax(line), "ZONES %d - %d", held[1], held[2]);
	tsm_hud_line(line);

	new carrier_side = 0;
	if (g_carrier && is_user_connected(g_carrier))
	{
		carrier_side = tsm_side_of(g_carrier);
	}
	new prog[24];
	formatex(prog, charsmax(prog), "%d/%d/%d/%d", held[1], held[2], g_zone_count, carrier_side);
	tsm_set_progress(prog);
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

/* ---- the round, from ts_matchmode (include\tsm_api.inc) ----------------------------------- */

public tsm_round_start(round)
{
	#pragma unused round
	if (!g_active)
	{
		return;
	}
	// This round's waves, before ts_matchmode starts its clocks at go-live.
	apply_waves();

	// Every zone neutral again, and no uplink until the round goes live.
	remove_uplink();
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			g_zone_owner[n] = 0;
			paint_zone(n);
		}
	}
	refresh_hud();
}

public tsm_round_live(round)
{
	#pragma unused round
	if (!g_active || !g_home_have)
	{
		return;
	}
	put_uplink(g_home, true);
	client_print(0, print_chat, "[MATCH] The uplink is up -- carry it into a zone to take it.");
}

public tsm_round_end(winner)
{
	#pragma unused winner
	if (!g_active)
	{
		return;
	}
	remove_uplink();
	refresh_hud();
}

/// Time up: the side holding more zones takes the round, and equal is a draw.
public tsm_round_timeout()
{
	if (!g_active)
	{
		return PLUGIN_CONTINUE;
	}
	new held[3];
	count_zones(held);

	new s1[24], s2[24];
	side_name(1, s1, charsmax(s1));
	side_name(2, s2, charsmax(s2));
	client_print(0, print_chat, "[MATCH] Time up -- %s holds %d zone(s), %s holds %d.", s1, held[1], s2, held[2]);

	if (held[1] > held[2])
	{
		tsm_end_round(1);
	}
	else if (held[2] > held[1])
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

/// dropuplink in the console: always answered, so a bound key never prints "Unknown command".
public cmd_drop(id)
{
	if (!g_active)
	{
		console_print(id, "[UPLINK] This map has no uplink.");
	}
	else if (g_carrier != id)
	{
		console_print(id, "[UPLINK] You are not carrying the uplink.");
	}
	else
	{
		drop_uplink("dropped");
	}
	return PLUGIN_HANDLED;
}

/// .drop in chat: only the carrier's line is taken; anyone else's goes out as normal.
public cmd_drop_say(id)
{
	if (!g_active || g_carrier != id)
	{
		return PLUGIN_CONTINUE;
	}
	drop_uplink("dropped");
	return PLUGIN_HANDLED;
}

public srv_cap()
{
	if (read_argc() < 5)
	{
		server_print("[UPLINK] usage: tsm_cap <n 1-9> <x> <y> <z> [radius]");
		return PLUGIN_HANDLED;
	}
	new a[16];
	read_argv(1, a, charsmax(a));
	new n = str_to_num(a);
	new Float:org[3];
	read_argv(2, a, charsmax(a));
	org[0] = str_to_float(a);
	read_argv(3, a, charsmax(a));
	org[1] = str_to_float(a);
	read_argv(4, a, charsmax(a));
	org[2] = str_to_float(a);
	new Float:rad = get_pcvar_float(g_cv_radius);
	if (read_argc() > 5)
	{
		read_argv(5, a, charsmax(a));
		rad = str_to_float(a);
	}
	if (n < 1 || n > UPL_MAXZONES)
	{
		server_print("[UPLINK] tsm_cap: the zone number runs 1 to %d, got %d", UPL_MAXZONES, n);
		return PLUGIN_HANDLED;
	}
	set_zone(n, org, rad, true);
	return PLUGIN_HANDLED;
}

public srv_uplink_at()
{
	if (read_argc() < 4)
	{
		server_print("[UPLINK] usage: tsm_uplink_at <x> <y> <z>");
		return PLUGIN_HANDLED;
	}
	new a[16];
	read_argv(1, a, charsmax(a));
	g_home[0] = str_to_float(a);
	read_argv(2, a, charsmax(a));
	g_home[1] = str_to_float(a);
	read_argv(3, a, charsmax(a));
	g_home[2] = str_to_float(a);
	g_home_have = true;
	g_home_cfg = true;
	return PLUGIN_HANDLED;
}

/// Where the admin stands, at his feet: a zone's point or the uplink's.
feet_of(id, Float:org[3])
{
	pev(id, pev_origin, org);
	org[2] -= 34.0;
}

public cmd_cap_add(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new n = 0;
	new Float:rad = get_pcvar_float(g_cv_radius);
	new a[16];
	if (read_argc() > 1)
	{
		read_argv(1, a, charsmax(a));
		n = str_to_num(a);
	}
	if (read_argc() > 2)
	{
		read_argv(2, a, charsmax(a));
		rad = str_to_float(a);
	}
	if (n < 1)
	{
		for (new i = 1; i <= UPL_MAXZONES; i++)
		{
			if (!g_zone_have[i])
			{
				n = i;
				break;
			}
		}
	}
	if (n < 1 || n > UPL_MAXZONES)
	{
		console_print(id, "[UPLINK] No free zone number -- the map already has %d.", UPL_MAXZONES);
		return PLUGIN_HANDLED;
	}

	new Float:org[3];
	feet_of(id, org);
	set_zone(n, org, rad, true);
	if (g_active)
	{
		build_zone(n);
		refresh_hud();
	}
	else
	{
		// The first zone on a map nothing claimed makes it an uplink map now.
		try_claim();
	}
	console_print(id, "[UPLINK] Zone %d at %.0f %.0f %.0f, radius %.0f. amx_tsm_uplink_save keeps it.",
		n, org[0], org[1], org[2], g_zone_rad[n]);
	return PLUGIN_HANDLED;
}

public cmd_cap_del(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new n = str_to_num(a);
	if (n < 1 || n > UPL_MAXZONES || !g_zone_have[n])
	{
		console_print(id, "[UPLINK] There is no zone %d.", n);
		return PLUGIN_HANDLED;
	}
	g_zone_have[n] = false;
	g_zone_cfg[n] = false;
	g_zone_owner[n] = 0;
	g_zone_count--;
	if (g_cap_zone == n)
	{
		clear_capture();
	}
	if (g_zone_ring[n] > 0 && pev_valid(g_zone_ring[n]))
	{
		engfunc(EngFunc_RemoveEntity, g_zone_ring[n]);
	}
	if (g_zone_flag[n] > 0 && pev_valid(g_zone_flag[n]))
	{
		engfunc(EngFunc_RemoveEntity, g_zone_flag[n]);
	}
	g_zone_ring[n] = 0;
	g_zone_flag[n] = 0;
	refresh_hud();
	console_print(id, "[UPLINK] Zone %d removed. amx_tsm_uplink_save keeps the change.", n);
	return PLUGIN_HANDLED;
}

public cmd_cap_list(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			console_print(id, "[UPLINK] zone %d: %.0f %.0f %.0f radius %.0f, held by %d (%s)",
				n, g_zone_org[n][0], g_zone_org[n][1], g_zone_org[n][2], g_zone_rad[n], g_zone_owner[n],
				g_zone_cfg[n] ? "config" : "map");
		}
	}
	console_print(id, "[UPLINK] %d zone(s); uplink point %s at %.0f %.0f %.0f",
		g_zone_count, g_home_have ? (g_home_cfg ? "from the config" : "from the map") : "MISSING",
		g_home[0], g_home[1], g_home[2]);
	return PLUGIN_HANDLED;
}

public cmd_cap_give(id, level, cid)
{
	if (!cmd_access(id, level, cid, 3))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new n = str_to_num(a);
	read_argv(2, a, charsmax(a));
	new side = str_to_num(a);
	if (n < 1 || n > UPL_MAXZONES || !g_zone_have[n] || side < 0 || side > 2)
	{
		console_print(id, "[UPLINK] usage: amx_tsm_cap_give <zone> <0|1|2>");
		return PLUGIN_HANDLED;
	}
	g_zone_owner[n] = side;
	if (g_cap_zone == n)
	{
		clear_capture();
	}
	paint_zone(n);
	refresh_hud();
	console_print(id, "[UPLINK] Zone %d now held by %d.", n, side);
	return PLUGIN_HANDLED;
}

public cmd_uplink_set(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	feet_of(id, g_home);
	g_home[2] += 16.0;
	g_home_have = true;
	g_home_cfg = true;
	console_print(id, "[UPLINK] The uplink appears at %.0f %.0f %.0f from the next round. amx_tsm_uplink_save keeps it.",
		g_home[0], g_home[1], g_home[2]);
	return PLUGIN_HANDLED;
}

public cmd_uplink_save(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new path[160];
	map_cfg_path(path, charsmax(path));
	if (file_exists(path))
	{
		delete_file(path);
	}

	new line[160];
	formatex(line, charsmax(line), "// ts_uplink zones and uplink point for %s -- written by amx_tsm_uplink_save", g_mapname);
	write_file(path, line);
	write_file(path, "// tsm_cap <n> <x> <y> <z> <radius>   |   tsm_uplink_at <x> <y> <z>");

	// Only what was placed by the config or the editor: the map's own zones are the map's.
	new written = 0;
	for (new n = 1; n <= UPL_MAXZONES; n++)
	{
		if (g_zone_have[n] && g_zone_cfg[n])
		{
			formatex(line, charsmax(line), "tsm_cap %d %.2f %.2f %.2f %.2f",
				n, g_zone_org[n][0], g_zone_org[n][1], g_zone_org[n][2], g_zone_rad[n]);
			write_file(path, line);
			written++;
		}
	}
	if (g_home_have && g_home_cfg)
	{
		formatex(line, charsmax(line), "tsm_uplink_at %.2f %.2f %.2f", g_home[0], g_home[1], g_home[2]);
		write_file(path, line);
	}
	console_print(id, "[UPLINK] Saved %d zone(s)%s to %s", written,
		(g_home_have && g_home_cfg) ? " and the uplink point" : "", path);
	return PLUGIN_HANDLED;
}

public cmd_uplink_dump(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new held[3];
	count_zones(held);
	console_print(id, "[UPLINK] build %s  active=%d core=%d mode=%d  map=%s", UPL_BUILD,
		g_active ? 1 : 0, g_have_core ? 1 : 0, get_pcvar_num(g_cv_mode), g_mapname);
	console_print(id, "[UPLINK] zones %d: side1 %d side2 %d neutral %d  capturing zone %d for side %d (%.1fs of %.0f)",
		g_zone_count, held[1], held[2], held[0], g_cap_zone, g_cap_side,
		g_cap_zone ? (get_gametime() - g_cap_started) : 0.0, get_pcvar_float(g_cv_captime));
	console_print(id, "[UPLINK] uplink ent %d carrier %d at_home %d loose %.0fs  model %s",
		pev_valid(g_up_ent) ? g_up_ent : 0, g_carrier, g_at_home ? 1 : 0,
		(pev_valid(g_up_ent) && !g_carrier) ? (get_gametime() - g_loose_since) : 0.0, g_up_model);
	console_print(id, "[UPLINK] sprites: rings %d (frames %d/%d/%d) capture ring %d flag %d marker %d",
		g_ring_ok ? 1 : 0, g_ring_frames[0], g_ring_frames[1], g_ring_frames[2],
		g_ringcap_ok ? 1 : 0, g_flag_ok ? 1 : 0, g_mark_ok ? 1 : 0);
	cmd_cap_list(id, level, cid);
	return PLUGIN_HANDLED;
}
