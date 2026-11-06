/*
 * ts_assault.sma -- ASSAULT, a mode for ts_matchmode.
 *
 * Both sides fight over the map's capture points. A point is a wide circle on the ground (tsm_as_radius,
 * 384 units by default, against an uplink zone's 128), and there are many of them, up to 24, so a map can
 * be as large as its author likes. Nothing is carried: any player of a side standing in a point with no
 * living enemy in it takes it, more of them taking it faster. A point can be won back, and changes hands
 * as often as the fighting does.
 *
 * REINFORCEMENTS ARE A POOL. The match mode (TSM_MODE_LIFE_POOL) gives each side one pool instead of a
 * count of lives each player carries, and this mode calls it REINFORCEMENTS to the players: on the match
 * bar, the scoreboard, in chat and in the class menu (the other modes keep the word lives). A death
 * draws its class's cost from the pool (tsm_class_cost: the Officer 2, the Mech 3, the others 1) and the
 * player waits for the side's next respawn wave; a death with the pool empty is final. Taking a point adds
 * tsm_as_capture_reinforcements to the pool. A side with nobody alive and nobody waiting loses the round,
 * as it does everywhere; holding every point wins it on the spot; at the clock the side holding more
 * points wins, then the one with more reinforcements, and equal is a draw.
 *
 * RESPAWNS. The waves run as they always do (tsm_as_wave seconds apart), and a wave puts a side's dead
 * back at the points it holds. Spawn point set N, the forward points of tier N in the map's
 * configs/tsm_spawns_<map>.cfg (amx_tsm_spawn_add <team> <N>), belong to capture point N: they are open to
 * the side that holds it, and closed again when the point is lost. With no point held a side respawns at
 * its own tier 0 points. Round start and a living player are never moved.
 *
 * ONE ROUND, ONE MATCH. By default (h9_assault_rounds 0) the first round that ends is the whole match: its winner wins
 * the match and is rated for it, a drawn round is a drawn match, nothing counts rounds, and the match bar says MATCH
 * where the other modes say ROUND. h9_assault_rounds 1 plays Assault the way the other modes play, best of tsm_rounds
 * rounds. A change of the cvar takes effect within a second.
 *
 * WHICH MAPS. A map is an assault map when it has capture points: entities with the targetnames tsm_as_1 to
 * tsm_as_24 (any entity: a point entity's origin is the centre, a brush's box its footprint), or points
 * written to the map's own config, configs/tsm_assault_<map>.cfg, by the editor commands below. Maps are
 * named h9_as_<name>. tsm_assault_mode 0 turns the mode off everywhere. A map that also carries siege
 * objectives (tsm_obj_#) stays a siege map: ts_matchmode refuses the claim, and the conflict is logged.
 *
 * SEEING THE POINTS. Every point is drawn on the player's screen through the walls, so everyone always knows where
 * all of them are and who holds them. A game with H9 VGUI protocol 3 or later gets a badge with the point's letter
 * in the holder's colour (h9vgui_mark), a bar while the point is being taken, the badge pinned to the edge of the
 * screen while the point is out of view, and a row of the same badges under the top notices; any other game gets
 * TS's own objective marker (the Objective message), which writes the letter and the holder at the point's place.
 * A mark goes out to everyone when its point changes and, two a second in turn, whatever it shows, so a player who
 * joins late has them all within seconds and none grows older than the client's 30.
 *
 * THE MODE API. Everything this plugin needs from the match comes through include\tsm_api.inc. With
 * ts_matchmode missing the native filter below lets this plugin load, and it does nothing.
 *
 * BOTS fight on an assault map but do not play the objective: no rcbot change reads it yet. For one that
 * would, a point's ring is the entity with the classname tsm_cap, whose team field is the owner (0, 1 or 2),
 * fuser1 the radius and iuser1 the point's number. Keep those fields as they are.
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler and a strict log: ASCII only,
 * explicit braces, no warnings.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <tsm_api>
#include <h9_vgui>      // an H9 game shows the capture bar and the news on panels
#include <h9_marks>     // and the points through the walls

#define PLUGIN  "TS Assault"
#define VERSION "1.0"
#define AUTHOR  "tsm"

// Printed by amx_tsm_assault, so there is never any doubt which build is loaded.
#define AS_BUILD "1.0-assault1"

#define AS_MAXZONES    24
#define AS_TICK        0.25
#define AS_TASK_TICK   71401
#define AS_TASK_CLAIM  71402

// The sprites are the uplink's: the same rings and flags, made once (export-map/h9_drainage/sprites.mjs).
// Each is precached only when the file is really there, and the mode runs without it.
#define AS_RING_0      "sprites/tsm_zone_ring_0.spr"
#define AS_RING_1      "sprites/tsm_zone_ring_1.spr"
#define AS_RING_2      "sprites/tsm_zone_ring_2.spr"
#define AS_RING_CAP    "sprites/tsm_zone_ring_cap.spr"
#define AS_FLAG        "sprites/tsm_zone_flag.spr"

// Stock Half-Life sounds every client already has.
#define AS_SND_CAPTURE "buttons/bell1.wav"
#define AS_SND_LOST    "buttons/button10.wav"

// The ring sprites are 128 pixels across with the ring at 56: a sprite draws a pixel a unit, so a
// point of radius R is the ring at scale R / 56.
#define AS_RING_PX     56.0
#define AS_FLAG_HIGH   110.0   // the flag hangs this far above the point
#define AS_ZONE_DZ     128.0   // how far above or below a point still counts as in it

// Engine values, spelled out here so this file needs nothing beyond fakemeta.
#define AS_MT_NONE     0
#define AS_SOLID_NOT   0
#define AS_RENDER_ADD  5

new g_cv_mode, g_cv_radius, g_cv_time, g_cv_speedup, g_cv_maxcap, g_cv_wave, g_cv_capreinf, g_cv_capwave, g_cv_desc, g_cv_rounds, g_cv_atk;

new bool:g_have_core = true;   // cleared by the native filter when ts_matchmode is not loaded
new bool:g_active = false;     // this map is claimed for assault
new g_mapname[32];

// What the precache found on disk.
new bool:g_ring_ok, bool:g_ringcap_ok, bool:g_flag_ok;
new g_ring_frames[3], g_ringcap_frames;

// The points, 1..AS_MAXZONES. g_zone_cfg: placed by the map's config or an editor command, not by the
// map itself -- only those are written back out by amx_tsm_as_save. g_zone_prog runs from -1 (side 2 holds
// it in full) through 0 (neutral) to 1 (side 1 holds it in full); g_zone_state is 0 quiet, 1 being taken,
// 2 contested, for the ring's picture.
new bool:g_zone_have[AS_MAXZONES + 1];
new bool:g_zone_cfg[AS_MAXZONES + 1];
new Float:g_zone_org[AS_MAXZONES + 1][3];
new Float:g_zone_rad[AS_MAXZONES + 1];
new g_zone_owner[AS_MAXZONES + 1];
new Float:g_zone_prog[AS_MAXZONES + 1];
new g_zone_state[AS_MAXZONES + 1];
new g_zone_ring[AS_MAXZONES + 1];
new g_zone_flag[AS_MAXZONES + 1];
new g_zone_count;
new g_ring_frame;              // the shared animation frame of every ring
new Float:g_waves_set;         // the wave interval last handed to ts_matchmode, for the log
new g_ticks;                   // tick counter, for the once-a-second work
new g_zone_taker[AS_MAXZONES + 1];   // the side taking a point, while g_zone_state is 1

/*
 * Lets every tsm_* native be missing instead of refusing to load (the pattern ts_uplink uses). Set here
 * and not in plugin_init: AMXX links natives before any plugin_init runs. A missing native called at run
 * time returns 0, which every caller below reads as "no core".
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

	g_ring_ok = (file_exists(AS_RING_0, true) && file_exists(AS_RING_1, true) && file_exists(AS_RING_2, true));
	if (g_ring_ok)
	{
		g_ring_frames[0] = engfunc(EngFunc_ModelFrames, precache_model(AS_RING_0));
		g_ring_frames[1] = engfunc(EngFunc_ModelFrames, precache_model(AS_RING_1));
		g_ring_frames[2] = engfunc(EngFunc_ModelFrames, precache_model(AS_RING_2));
	}
	g_ringcap_ok = (file_exists(AS_RING_CAP, true) != 0);
	if (g_ringcap_ok)
	{
		g_ringcap_frames = engfunc(EngFunc_ModelFrames, precache_model(AS_RING_CAP));
	}
	g_flag_ok = (file_exists(AS_FLAG, true) != 0);
	if (g_flag_ok)
	{
		precache_model(AS_FLAG);
	}

	precache_sound(AS_SND_CAPTURE);
	precache_sound(AS_SND_LOST);
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);
	h9vgui_init("as");

	g_cv_mode     = register_cvar("tsm_assault_mode",     "1");
	g_cv_radius   = register_cvar("tsm_as_radius",        "384");   // a point's reach across the floor, units
	g_cv_time     = register_cvar("tsm_as_time",          "20");    // seconds for one player to take a point from neutral
	g_cv_speedup  = register_cvar("tsm_as_speedup",       "0.5");   // more speed for each further player taking it
	g_cv_maxcap   = register_cvar("tsm_as_maxcap",        "6");     // players who count toward that speed, at most
	g_cv_wave     = register_cvar("tsm_as_wave",          "30");    // seconds between a side's respawn waves
	g_cv_capreinf = register_cvar("tsm_as_capture_reinforcements", "5");   // reinforcements a side's pool gains when it takes a point
	g_cv_capwave  = register_cvar("tsm_as_capture_wave",  "1");     // 1: the side that took a point gets a wave at once
	g_cv_desc     = register_cvar("tsm_gamedesc_assault", "Assault");
	g_cv_rounds   = register_cvar("h9_assault_rounds",    "0");     // 0: the first round is the whole match; 1: rounds, best of tsm_rounds
	g_cv_atk      = register_cvar("tsm_as_spawn_under_attack", "0"); // 0: a point's respawn set is shut while an enemy is taking it

	// The point editor, the same shape as the uplink's zone editor.
	register_concmd("amx_tsm_as_add",    "cmd_as_add",    ADMIN_CFG, " [n] [radius] - a capture point where you stand");
	register_concmd("amx_tsm_as_del",    "cmd_as_del",    ADMIN_CFG, " <n> - remove a capture point");
	register_concmd("amx_tsm_as_list",   "cmd_as_list",   ADMIN_CFG, " - the capture points and who holds them");
	register_concmd("amx_tsm_as_give",   "cmd_as_give",   ADMIN_CFG, " <n> <0|1|2> - hand a point to a side (testing)");
	register_concmd("amx_tsm_as_radius", "cmd_as_radius", ADMIN_CFG, " <n> <radius> - how far a point reaches");
	register_concmd("amx_tsm_as_save",   "cmd_as_save",   ADMIN_CFG, " - write this map's capture points");
	register_concmd("amx_tsm_assault",   "cmd_as_dump",   ADMIN_CFG, " - the assault mode's whole state");

	// Read from configs/tsm_assault_<map>.cfg, which amx_tsm_as_save writes.
	register_srvcmd("tsm_as_zone", "srv_zone");
}

public plugin_cfg()
{
	get_mapname(g_mapname, charsmax(g_mapname));

	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/ts_assault.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// This map's points, if the editor saved any.
	map_cfg_path(file, charsmax(file));
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}

	// The claim waits a moment: the map's own entities have settled by then, and h9_autoconfig has run
	// ts/mapconfigs/<map>.cfg, which may set tsm_assault_mode for this map alone.
	set_task(2.0, "task_claim", AS_TASK_CLAIM);
}

map_cfg_path(path[], len)
{
	new dir[64];
	get_configsdir(dir, charsmax(dir));
	formatex(path, len, "%s/tsm_assault_%s.cfg", dir, g_mapname);
}

/* ---- the claim -------------------------------------------------------------------------- */

/*
 * Reads the map's points and, when it has at least two, claims the map for assault. Done once a map.
 * A refused claim -- siege objectives on the map, another mode already holding it, no ts_matchmode --
 * leaves this plugin doing nothing at all.
 */
public task_claim()
{
	scan_map();
	try_claim();
}

/// The points the map itself carries, beside whatever the config placed.
scan_map()
{
	new name[16];
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			continue;   // the config's placement wins over the map's
		}
		formatex(name, charsmax(name), "tsm_as_%d", n);
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
}

set_zone(n, const Float:org[3], Float:rad, bool:from_cfg)
{
	if (n < 1 || n > AS_MAXZONES)
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
	g_zone_rad[n] = (rad > 32.0) ? rad : 32.0;
	g_zone_owner[n] = 0;
	g_zone_prog[n] = 0.0;
	g_zone_state[n] = 0;
	g_zone_taker[n] = 0;
}

/*
 * Both sides' respawn waves every tsm_as_wave seconds: on an assault map this, not tsm_respawn_wave, sets
 * them. Applied at the claim and again as each round starts, before ts_matchmode starts that round's wave
 * clocks, so a map's mapconfig or a console change takes effect from the next round.
 */
apply_waves()
{
	new Float:wave = get_pcvar_float(g_cv_wave);
	tsm_wave_seconds(1, wave);
	tsm_wave_seconds(2, wave);
	if (wave != g_waves_set)
	{
		g_waves_set = wave;
		log_amx("[ASSAULT] Respawn waves every %.0fs for both sides on %s.", wave, g_mapname);
	}
}

new g_rounds_seen = -1;   // h9_assault_rounds as apply_rounds last read it

/// Whether the first round is the whole match: h9_assault_rounds 0, the default. Applied at the claim and as each round starts, and
/// again within a second of a change of the cvar (task_tick).
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
	if (g_zone_count < 2)
	{
		if (equali(g_mapname, "h9_as_", 6))
		{
			log_amx("[ASSAULT] %s is named for assault but has %d capture point(s): it needs at least 2 (tsm_as_1 and on in the map, or amx_tsm_as_add and amx_tsm_as_save).",
				g_mapname, g_zone_count);
		}
		return;
	}

	new desc[64];
	get_pcvar_string(g_cv_desc, desc, charsmax(desc));
	if (!desc[0])
	{
		copy(desc, charsmax(desc), "Assault");
	}
	if (!tsm_mode_claim("assault", desc, TSM_MODE_NO_SUDDEN | TSM_MODE_LIFE_POOL))
	{
		log_amx("[ASSAULT] %s has %d capture point(s) but the claim was refused (siege objectives, another mode, or no ts_matchmode).",
			g_mapname, g_zone_count);
		return;
	}

	g_active = true;
	apply_waves();
	apply_rounds();
	tsm_spawn_open_clear(0);   // from here the points a side holds decide where its waves land

	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			build_zone(n);
		}
	}
	refresh_hud();

	remove_task(AS_TASK_TICK);
	set_task(AS_TICK, "task_tick", AS_TASK_TICK, "", 0, "b");
	log_amx("[ASSAULT] %s is an assault map: %d capture point(s).", g_mapname, g_zone_count);
}

/* ---- the points' entities ----------------------------------------------------------------- */

/// A point's letter: 1 is A, 2 is B and so on, as the players call them.
zone_label(n, out[], len)
{
	if (n >= 1 && n <= 26)
	{
		formatex(out, len, "%c", 'A' + n - 1);
	}
	else
	{
		formatex(out, len, "%d", n);
	}
}

/// A point's ring on the ground and its flag overhead, made once and reused all map.
build_zone(n)
{
	if (g_ring_ok && !pev_valid(g_zone_ring[n]))
	{
		new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent > 0)
		{
			set_pev(ent, pev_classname, "tsm_cap");
			engfunc(EngFunc_SetModel, ent, AS_RING_0);
			set_pev(ent, pev_movetype, AS_MT_NONE);
			set_pev(ent, pev_solid, AS_SOLID_NOT);
			set_pev(ent, pev_rendermode, AS_RENDER_ADD);
			set_pev(ent, pev_renderamt, 255.0);
			// Laid flat: an oriented sprite faces along its angles, so a pitch of 90 faces it down.
			new Float:ang[3] = { 90.0, 0.0, 0.0 };
			set_pev(ent, pev_angles, ang);
			set_pev(ent, pev_scale, g_zone_rad[n] / AS_RING_PX);
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
			engfunc(EngFunc_SetModel, ent, AS_FLAG);
			set_pev(ent, pev_movetype, AS_MT_NONE);
			set_pev(ent, pev_solid, AS_SOLID_NOT);
			set_pev(ent, pev_rendermode, AS_RENDER_ADD);
			set_pev(ent, pev_renderamt, 255.0);
			set_pev(ent, pev_scale, 0.5);
			new Float:org[3];
			org[0] = g_zone_org[n][0];
			org[1] = g_zone_org[n][1];
			org[2] = g_zone_org[n][2] + AS_FLAG_HIGH;
			engfunc(EngFunc_SetOrigin, ent, org);
			g_zone_flag[n] = ent;
		}
	}
	paint_zone(n);
}

/// Shows who holds a point: the ring in the holder's colour (the capture ring while it is being taken or
/// contested), the flag on the holder's frame.
paint_zone(n)
{
	new ring = g_zone_ring[n];
	if (ring > 0 && pev_valid(ring))
	{
		// The bots read these three: the holder, the reach and the number.
		set_pev(ring, pev_team, g_zone_owner[n]);
		set_pev(ring, pev_fuser1, g_zone_rad[n]);
		set_pev(ring, pev_iuser1, n);

		if (g_zone_state[n] != 0 && g_ringcap_ok)
		{
			engfunc(EngFunc_SetModel, ring, AS_RING_CAP);
		}
		else if (g_zone_owner[n] == 1)
		{
			engfunc(EngFunc_SetModel, ring, AS_RING_1);
		}
		else if (g_zone_owner[n] == 2)
		{
			engfunc(EngFunc_SetModel, ring, AS_RING_2);
		}
		else
		{
			engfunc(EngFunc_SetModel, ring, AS_RING_0);
		}
		set_pev(ring, pev_scale, g_zone_rad[n] / AS_RING_PX);
	}

	new flag = g_zone_flag[n];
	if (flag > 0 && pev_valid(flag))
	{
		set_pev(flag, pev_frame, float(g_zone_owner[n]));
	}
}

/// Steps every ring's animation on, a frame for each tick.
animate_rings()
{
	g_ring_frame++;
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		new ring = g_zone_ring[n];
		if (!g_zone_have[n] || ring <= 0 || !pev_valid(ring))
		{
			continue;
		}
		new frames = (g_zone_state[n] != 0 && g_ringcap_ok) ? g_ringcap_frames : g_ring_frames[g_zone_owner[n]];
		if (frames > 1)
		{
			set_pev(ring, pev_frame, float(g_ring_frame % frames));
		}
	}
}

/// Changes what a point's ring shows (0 quiet, 1 being taken, 2 contested), repainting it only when that changed.
set_zone_state(n, value)
{
	if (g_zone_state[n] == value)
	{
		return;
	}
	g_zone_state[n] = value;
	paint_zone(n);
}

/* ---- the tick ------------------------------------------------------------------------------ */

/// Whether each point's respawn set is open to its holder: the holder has the point, and (tsm_as_spawn_under_attack 0) no enemy is
/// taking it. A wave must not put the fallen into a point while the other side stands in it wearing it down; the set opens again
/// when that side is gone or beaten, and a point both sides stand in (contested) stays as it was.
sync_sets()
{
	new bool:shut = (get_pcvar_num(g_cv_atk) == 0);
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (!g_zone_have[n])
		{
			continue;
		}
		new owner = g_zone_owner[n];
		if (owner != 1 && owner != 2)
		{
			continue;   // a point nobody holds has no set open: set_owner closed it
		}
		if (g_zone_state[n] == 2)
		{
			continue;   // contested: both sides stand in it, and its set stays as it was
		}
		new bool:attacked = (g_zone_state[n] == 1 && g_zone_taker[n] != owner);
		tsm_spawn_open(owner, n, !(shut && attacked));
	}
}

public task_tick()
{
	if (!g_active)
	{
		return;
	}

	g_ticks++;
	animate_rings();
	marks_tick();
	sync_sets();
	if (get_pcvar_num(g_cv_rounds) != g_rounds_seen)
	{
		apply_rounds();
	}

	// Nothing is taken outside a live round, whatever ended the round: a halt, a cancel and an
	// abandoned match all pass through here, not only the round-end forward.
	if (tsm_state() != TSM_ST_LIVE)
	{
		for (new n = 1; n <= AS_MAXZONES; n++)
		{
			if (g_zone_have[n])
			{
				set_zone_state(n, 0);
			}
		}
		if (g_ticks % 4 == 0)
		{
			refresh_hud();
		}
		return;
	}

	// Who stands in which point, by side.
	new cnt[AS_MAXZONES + 1][3];
	new first[AS_MAXZONES + 1][3];   // one of each side's players there, for the bar
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!tsm_in_play(id))
		{
			continue;
		}
		new side = tsm_side_of(id);
		if (side != 1 && side != 2)
		{
			continue;
		}
		new Float:p[3];
		pev(id, pev_origin, p);
		new z = zone_at(p);
		if (z)
		{
			cnt[z][side]++;
			if (!first[z][side])
			{
				first[z][side] = id;
			}
		}
	}

	new bool:show = (g_ticks % 2 == 0);   // the bars, twice a second
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			step_zone(n, cnt[n][1], cnt[n][2], players, pnum, show);
		}
	}

	if (g_ticks % 4 == 0)
	{
		refresh_hud();
	}
}

/// The point a position stands in: within its radius across the floor and near its height; the nearest when it stands in
/// more than one.
zone_at(const Float:org[3])
{
	new best = 0;
	new Float:bestd = 0.0;
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (!g_zone_have[n])
		{
			continue;
		}
		new Float:dx = org[0] - g_zone_org[n][0];
		new Float:dy = org[1] - g_zone_org[n][1];
		new Float:dz = org[2] - g_zone_org[n][2];
		if (dz < -AS_ZONE_DZ || dz > AS_ZONE_DZ)
		{
			continue;
		}
		new Float:d2 = dx * dx + dy * dy;
		if (d2 > g_zone_rad[n] * g_zone_rad[n])
		{
			continue;
		}
		if (!best || d2 < bestd)
		{
			best = n;
			bestd = d2;
		}
	}
	return best;
}

/*
 * One tick of one point. a and b are the players of side 1 and side 2 in it. Both there: contested, and
 * nothing moves. One side there: its progress moves toward that side, at 1 / tsm_as_time a second for one player
 * and faster for each more, up to tsm_as_maxcap. A point the other side held first goes neutral as the progress
 * passes 0, then goes to the taker when it reaches its end. Nobody there: the point keeps what it has.
 */
step_zone(z, a, b, const players[], pnum, bool:show)
{
	new mover = 0;
	new n = 0;
	if (a > 0 && b > 0)
	{
		set_zone_state(z, 2);
		if (show)
		{
			zone_bars(z, players, pnum, 0, 0);
		}
		return;
	}
	if (a > 0)
	{
		mover = 1;
		n = a;
	}
	else if (b > 0)
	{
		mover = 2;
		n = b;
	}
	if (!mover)
	{
		set_zone_state(z, 0);
		return;
	}

	// A point the mover holds in full has nothing left to take.
	if (g_zone_owner[z] == mover && floatabs(g_zone_prog[z]) >= 1.0)
	{
		set_zone_state(z, 0);
		return;
	}

	new Float:need = get_pcvar_float(g_cv_time);
	if (need < 1.0)
	{
		need = 1.0;
	}
	new maxcap = get_pcvar_num(g_cv_maxcap);
	if (maxcap < 1)
	{
		maxcap = 1;
	}
	new extra = ((n < maxcap) ? n : maxcap) - 1;
	new Float:rate = (1.0 + get_pcvar_float(g_cv_speedup) * float(extra)) * AS_TICK / need;
	new Float:p = g_zone_prog[z] + ((mover == 1) ? rate : -rate);
	if (p > 1.0)
	{
		p = 1.0;
	}
	else if (p < -1.0)
	{
		p = -1.0;
	}
	g_zone_prog[z] = p;
	g_zone_taker[z] = mover;
	set_zone_state(z, 1);

	new owner = g_zone_owner[z];
	if (owner != 0 && owner != mover)
	{
		// The holder's end of the progress is +1 for side 1 and -1 for side 2: it is lost when it reaches 0.
		if ((owner == 1 && p <= 0.0) || (owner == 2 && p >= 0.0))
		{
			lose_zone(z, owner, mover);
		}
	}
	else if (owner != mover && floatabs(p) >= 1.0)
	{
		capture_zone(z, mover, players, pnum);
		return;
	}

	if (show)
	{
		zone_bars(z, players, pnum, mover, zone_pct(z) * 10);
	}
}

/// Each player standing in a point sees where it stands: the taker's bar, or that it is contested. permille 0 with
/// side 0 is a contested point.
zone_bars(z, const players[], pnum, side, permille)
{
	new label[8], text[64];
	zone_label(z, label, charsmax(label));
	if (side)
	{
		new sname[24];
		side_name(side, sname, charsmax(sname));
		formatex(text, charsmax(text), "POINT %s -- %s TAKING IT", label, sname);
	}
	else
	{
		formatex(text, charsmax(text), "POINT %s IS CONTESTED", label);
	}

	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (is_user_bot(id) || !tsm_in_play(id))
		{
			continue;
		}
		new Float:p[3];
		pev(id, pev_origin, p);
		if (zone_at(p) != z)
		{
			continue;
		}
		new r = 255, g = 220, b = 80;
		if (side == 1)
		{
			r = 0; g = 170; b = 255;
		}
		else if (side == 2)
		{
			r = 255; g = 70; b = 60;
		}
		if (h9vgui_supported(id))
		{
			h9vgui_notice_bar(id, "as.cap", text, permille, 0.6, r, g, b);
		}
		else
		{
			set_hudmessage(r, g, b, -1.0, 0.47, 0, 0.0, 0.6, 0.05, 0.3, 3);
			show_hudmessage(id, "%s", text);
		}
	}
}

/// A point goes neutral: the holder lost its hold on it, and the spawn set it had closes with it.
lose_zone(z, old, taker)
{
	set_owner(z, 0);

	new label[8], sname[24], tname[24];
	zone_label(z, label, charsmax(label));
	side_name(old, sname, charsmax(sname));
	side_name(taker, tname, charsmax(tname));
	mode_chat(0, "[MATCH] %s lost point %s to %s.", sname, label, tname);
	assault_news(taker, "%s lost point %s", sname, label);
	if (get_zone_ring_ent(z) > 0)
	{
		emit_sound(g_zone_ring[z], CHAN_AUTO, AS_SND_LOST, VOL_NORM, ATTN_NONE, 0, PITCH_NORM);
	}
	refresh_hud();
}

/// The ring's entity, or 0 when it has none.
get_zone_ring_ent(z)
{
	return (g_zone_ring[z] > 0 && pev_valid(g_zone_ring[z])) ? g_zone_ring[z] : 0;
}

/// A point goes to a side. The spawn set of that number opens for it and closes for the other side, the capturers are scored, the
/// side's pool grows, and a wave is sent for its fallen; every point held ends the round.
capture_zone(z, side, const players[], pnum)
{
	set_owner(z, side);

	if (get_zone_ring_ent(z) > 0)
	{
		emit_sound(g_zone_ring[z], CHAN_AUTO, AS_SND_CAPTURE, VOL_NORM, ATTN_NONE, 0, PITCH_NORM);
	}

	// The players of that side standing in it share the points.
	new first_name[32];
	first_name[0] = EOS;
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!tsm_in_play(id) || tsm_side_of(id) != side)
		{
			continue;
		}
		new Float:p[3];
		pev(id, pev_origin, p);
		if (zone_at(p) == z)
		{
			tsm_points_award(id, TSM_POINTS_ZONE);
			if (!first_name[0])
			{
				get_user_name(id, first_name, charsmax(first_name));
			}
		}
	}

	new held[3];
	count_zones(held);

	new label[8], sname[24];
	zone_label(z, label, charsmax(label));
	side_name(side, sname, charsmax(sname));
	mode_chat(0, "[MATCH] %s took point %s -- %s holds %d of %d.", first_name[0] ? first_name : sname, label, sname,
		held[side], g_zone_count);
	assault_news(side, "%s took point %s -- %d of %d held", sname, label, held[side], g_zone_count);

	new reinf = get_pcvar_num(g_cv_capreinf);
	if (reinf > 0)
	{
		tsm_pool_add(side, reinf);
	}

	refresh_hud();

	// Every point held ends the round on the spot.
	if (held[side] >= g_zone_count)
	{
		mode_chat(0, "[MATCH] %s holds every point.", sname);
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

/// Gives a point to a side (0: nobody): its holder, its progress, its picture, and the spawn set of its number.
set_owner(z, side)
{
	new old = g_zone_owner[z];
	g_zone_owner[z] = side;
	g_zone_prog[z] = (side == 1) ? 1.0 : ((side == 2) ? -1.0 : 0.0);
	g_zone_state[z] = 0;

	if (old == 1 || old == 2)
	{
		tsm_spawn_open(old, z, false);
	}
	if (side == 1 || side == 2)
	{
		tsm_spawn_open(side, z, true);
	}
	paint_zone(z);
	if (g_active)
	{
		marks_update(z);
	}
}

/// How many points each side holds: held[1], held[2]; held[0] the neutral ones.
count_zones(held[3])
{
	held[0] = 0;
	held[1] = 0;
	held[2] = 0;
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			new o = g_zone_owner[n];
			held[(o == 1 || o == 2) ? o : 0]++;
		}
	}
}

/// The round line's points and reinforcements, and the Discord card's progress.
refresh_hud()
{
	if (!g_active)
	{
		return;
	}
	new held[3];
	count_zones(held);

	new line[48];
	formatex(line, charsmax(line), "POINTS %d - %d  REINFORCEMENTS %d - %d", held[1], held[2], tsm_pool_get(1), tsm_pool_get(2));
	tsm_hud_line(line);

	new prog[24];
	formatex(prog, charsmax(prog), "%d/%d/%d", held[1], held[2], g_zone_count);
	tsm_set_progress(prog);
}

/* ---- the marks: where the points are, through the walls ------------------------------------- */

/// How far the side taking a point has got with the job in hand, 0 to 100: wearing the other side's hold away first, then
/// taking the neutral point, each from nothing to the whole of the bar.
zone_pct(n)
{
	new taker = g_zone_taker[n];
	if (taker != 1 && taker != 2)
	{
		return 0;
	}
	new Float:p = floatabs(g_zone_prog[n]);
	if (p > 1.0)
	{
		p = 1.0;
	}
	new owner = g_zone_owner[n];
	if (owner != 0 && owner != taker)
	{
		p = 1.0 - p;
	}
	return floatround(p * 100.0);
}

/// Where a point's mark hangs: the flag's place, above the point.
mark_place(n, Float:at[3])
{
	at[0] = g_zone_org[n][0];
	at[1] = g_zone_org[n][1];
	at[2] = g_zone_org[n][2] + AS_FLAG_HIGH;
}

/// The text TS's own objective marker writes at a point: its letter, who holds it and what is going on there.
objective_label(n, out[], len)
{
	new label[8], sname[24];
	zone_label(n, label, charsmax(label));
	new taker = g_zone_taker[n];
	if (g_zone_state[n] == 2)
	{
		formatex(out, len, "%s - CONTESTED", label);
	}
	else if (g_zone_state[n] == 1 && (taker == 1 || taker == 2))
	{
		side_name(taker, sname, charsmax(sname));
		formatex(out, len, "%s - %s TAKING %d%%", label, sname, zone_pct(n));
	}
	else if (g_zone_owner[n] == 1 || g_zone_owner[n] == 2)
	{
		side_name(g_zone_owner[n], sname, charsmax(sname));
		formatex(out, len, "%s - %s", label, sname);
	}
	else
	{
		copy(out, len, label);
	}
}

/// A point's mark, handed to the marks include: who holds it, what is happening to it, where it hangs and what it says. Nothing goes
/// out unless it differs from what everyone was last sent.
marks_update(n)
{
	new Float:at[3], label[8], text[64];
	mark_place(n, at);
	zone_label(n, label, charsmax(label));
	objective_label(n, text, charsmax(text));
	h9marks_set(n, g_zone_owner[n], g_zone_state[n], g_zone_taker[n], zone_pct(n), at, label, text);
}

/// Every point's mark, as the points stand.
marks_update_all()
{
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			marks_update(n);
		}
	}
}

/// Every point's mark to every player, whatever it shows: a round that has just reset the points.
marks_send_all()
{
	marks_update_all();
	h9marks_resend();
}

/// Each tick: the marks whose point changed go out, and each second two more go out whatever they show, in turn.
marks_tick()
{
	marks_update_all();
	h9marks_tick(4);
}

public client_putinserver(id)
{
	h9marks_player_in(id);
}

public client_disconnected(id)
{
	h9marks_player_out(id);
}

/// A line of news for every H9 game, a few seconds under the match bar in the side's colour. Chat carries the same news for
/// every game.
assault_news(side, const fmt[], any:...)
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
			h9vgui_notice(players[i], "as.news", H9V_NOTICE_BANNER, text, 3.0, 0.5, r, g, b);
		}
	}
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
	// This round's waves, before ts_matchmode starts its clocks at go-live, and whether the round is the match.
	apply_waves();
	apply_rounds();

	// Every point neutral again and every spawn set closed: each side starts from its own spawns.
	tsm_spawn_open_clear(0);
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			g_zone_owner[n] = 0;
			g_zone_prog[n] = 0.0;
			g_zone_state[n] = 0;
			g_zone_taker[n] = 0;
			paint_zone(n);
		}
	}
	refresh_hud();
	marks_send_all();
}

public tsm_round_live(round)
{
	#pragma unused round
	if (!g_active)
	{
		return;
	}
	mode_chat(0, "[MATCH] Take the capture points -- hold more of them than the enemy.");
	refresh_hud();
}

public tsm_round_end(winner)
{
	#pragma unused winner
	if (!g_active)
	{
		return;
	}
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			set_zone_state(n, 0);
		}
	}
	refresh_hud();
}

/// Time up: the side holding more points takes the round, then the one with more reinforcements, and equal is a draw.
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
	mode_chat(0, "[MATCH] Time up -- %s holds %d point(s), %s holds %d.", s1, held[1], s2, held[2]);

	new winner = 0;
	if (held[1] > held[2])
	{
		winner = 1;
	}
	else if (held[2] > held[1])
	{
		winner = 2;
	}
	else
	{
		new l1 = tsm_pool_get(1);
		new l2 = tsm_pool_get(2);
		if (l1 > l2)
		{
			winner = 1;
		}
		else if (l2 > l1)
		{
			winner = 2;
		}
		if (winner)
		{
			mode_chat(0, "[MATCH] Equal points -- %s has more reinforcements.", (winner == 1) ? s1 : s2);
		}
	}
	tsm_end_round(winner);
	return PLUGIN_HANDLED;
}

/* ---- the config and the editor ----------------------------------------------------------- */

public srv_zone()
{
	if (read_argc() < 5)
	{
		server_print("[ASSAULT] usage: tsm_as_zone <n 1-%d> <x> <y> <z> [radius]", AS_MAXZONES);
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
	if (n < 1 || n > AS_MAXZONES)
	{
		server_print("[ASSAULT] tsm_as_zone: the point number runs 1 to %d, got %d", AS_MAXZONES, n);
		return PLUGIN_HANDLED;
	}
	set_zone(n, org, rad, true);
	return PLUGIN_HANDLED;
}

/// Where the admin stands, at his feet.
feet_of(id, Float:org[3])
{
	pev(id, pev_origin, org);
	org[2] -= 34.0;
}

public cmd_as_add(id, level, cid)
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
		for (new i = 1; i <= AS_MAXZONES; i++)
		{
			if (!g_zone_have[i])
			{
				n = i;
				break;
			}
		}
	}
	if (n < 1 || n > AS_MAXZONES)
	{
		console_print(id, "[ASSAULT] No free point number -- the map already has %d.", AS_MAXZONES);
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
		// Two points on a map nothing claimed make it an assault map now.
		try_claim();
	}
	new label[8];
	zone_label(n, label, charsmax(label));
	console_print(id, "[ASSAULT] Point %d (%s) at %.0f %.0f %.0f, radius %.0f. amx_tsm_as_save keeps it. Its spawn set is tier %d: amx_tsm_spawn_add <team> %d.",
		n, label, org[0], org[1], org[2], g_zone_rad[n], n, n);
	return PLUGIN_HANDLED;
}

public cmd_as_del(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	new a[8];
	read_argv(1, a, charsmax(a));
	new n = str_to_num(a);
	if (n < 1 || n > AS_MAXZONES || !g_zone_have[n])
	{
		console_print(id, "[ASSAULT] There is no point %d.", n);
		return PLUGIN_HANDLED;
	}
	set_owner(n, 0);
	h9marks_remove(n);
	g_zone_have[n] = false;
	g_zone_cfg[n] = false;
	g_zone_count--;
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
	console_print(id, "[ASSAULT] Point %d removed. amx_tsm_as_save keeps the change.", n);
	return PLUGIN_HANDLED;
}

public cmd_as_list(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n])
		{
			new label[8];
			zone_label(n, label, charsmax(label));
			console_print(id, "[ASSAULT] point %d (%s): %.0f %.0f %.0f radius %.0f, held by %d (%s)",
				n, label, g_zone_org[n][0], g_zone_org[n][1], g_zone_org[n][2], g_zone_rad[n], g_zone_owner[n],
				g_zone_cfg[n] ? "config" : "map");
		}
	}
	console_print(id, "[ASSAULT] %d point(s).", g_zone_count);
	return PLUGIN_HANDLED;
}

public cmd_as_give(id, level, cid)
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
	if (n < 1 || n > AS_MAXZONES || !g_zone_have[n] || side < 0 || side > 2)
	{
		console_print(id, "[ASSAULT] usage: amx_tsm_as_give <point> <0|1|2>");
		return PLUGIN_HANDLED;
	}
	set_owner(n, side);
	refresh_hud();
	console_print(id, "[ASSAULT] Point %d now held by %d.", n, side);
	return PLUGIN_HANDLED;
}

public cmd_as_radius(id, level, cid)
{
	if (!cmd_access(id, level, cid, 3))
	{
		return PLUGIN_HANDLED;
	}
	new a[16];
	read_argv(1, a, charsmax(a));
	new n = str_to_num(a);
	read_argv(2, a, charsmax(a));
	new Float:rad = str_to_float(a);
	if (n < 1 || n > AS_MAXZONES || !g_zone_have[n] || rad < 32.0)
	{
		console_print(id, "[ASSAULT] usage: amx_tsm_as_radius <point> <radius, 32 or more>");
		return PLUGIN_HANDLED;
	}
	g_zone_rad[n] = rad;
	g_zone_cfg[n] = true;
	paint_zone(n);
	console_print(id, "[ASSAULT] Point %d now reaches %.0f units. amx_tsm_as_save keeps it.", n, rad);
	return PLUGIN_HANDLED;
}

public cmd_as_save(id, level, cid)
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
	formatex(line, charsmax(line), "// ts_assault capture points for %s -- written by amx_tsm_as_save", g_mapname);
	write_file(path, line);
	write_file(path, "// tsm_as_zone <n> <x> <y> <z> <radius>   (point n's spawn set is tier n of the map's tsm_spawns file)");

	// Only what was placed by the config or the editor: the map's own points are the map's.
	new written = 0;
	for (new n = 1; n <= AS_MAXZONES; n++)
	{
		if (g_zone_have[n] && g_zone_cfg[n])
		{
			formatex(line, charsmax(line), "tsm_as_zone %d %.2f %.2f %.2f %.2f",
				n, g_zone_org[n][0], g_zone_org[n][1], g_zone_org[n][2], g_zone_rad[n]);
			write_file(path, line);
			written++;
		}
	}
	console_print(id, "[ASSAULT] Saved %d point(s) to %s", written, path);
	return PLUGIN_HANDLED;
}

public cmd_as_dump(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	new held[3];
	count_zones(held);
	console_print(id, "[ASSAULT] build %s  active=%d core=%d mode=%d  map=%s", AS_BUILD,
		g_active ? 1 : 0, g_have_core ? 1 : 0, get_pcvar_num(g_cv_mode), g_mapname);
	console_print(id, "[ASSAULT] tsm_as_spawn_under_attack %d: a point's respawn set %s while an enemy is taking it", get_pcvar_num(g_cv_atk),
		get_pcvar_num(g_cv_atk) ? "stays open" : "is shut");
	console_print(id, "[ASSAULT] h9_assault_rounds %d: %s", get_pcvar_num(g_cv_rounds),
		get_pcvar_num(g_cv_rounds) ? "rounds, best of tsm_rounds" : "the first round is the whole match");
	console_print(id, "[ASSAULT] points %d: side1 %d side2 %d neutral %d  reinforcements %d - %d (started %d - %d)",
		g_zone_count, held[1], held[2], held[0], tsm_pool_get(1), tsm_pool_get(2), tsm_pool_start(1), tsm_pool_start(2));
	console_print(id, "[ASSAULT] taking: %.0f s for one player, +%.2f for each further one up to %d; a take gives %d reinforcement(s); waves every %.0f s",
		get_pcvar_float(g_cv_time), get_pcvar_float(g_cv_speedup), get_pcvar_num(g_cv_maxcap), get_pcvar_num(g_cv_capreinf),
		get_pcvar_float(g_cv_wave));
	console_print(id, "[ASSAULT] sprites: rings %d (frames %d/%d/%d) capture ring %d flag %d",
		g_ring_ok ? 1 : 0, g_ring_frames[0], g_ring_frames[1], g_ring_frames[2], g_ringcap_ok ? 1 : 0, g_flag_ok ? 1 : 0);
	new h9games = 0, others = 0;
	for (new i = 1; i <= MAX_PLAYERS; i++)
	{
		if (g_h9m_mode[i] == 1)
		{
			h9games++;
		}
		else if (g_h9m_mode[i] == 2)
		{
			others++;
		}
	}
	console_print(id, "[ASSAULT] marks: %d H9 game(s) draw them, %d other(s) get TS's own objective markers", h9games, others);
	cmd_as_list(id, level, cid);
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
