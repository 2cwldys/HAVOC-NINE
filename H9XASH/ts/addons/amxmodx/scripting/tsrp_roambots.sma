/*
 * tsrp_roambots.sma -- roaming citizens for H9's roleplay maps.
 *
 * RCBots that walk a roleplay city's public streets, halls and walkways at a walk, stop
 * now and then, and never fight anyone, so that the city looks lived in. They keep out of
 * homes, shops and MSR space because the map's waypoints do: a roleplay map gives RCBot
 * roam waypoints laid only in its public spaces (for h9_tsrp_newbyzantium,
 * export-map\h9_tsrp_newbyzantium\roamwaypoints.mjs writes them with every build of the map).
 *
 * WHERE IT RUNS. On a roleplay map, by the same test as ts_matchmode's (roleplay_map() below),
 * and only when that map's mapconfig asks for citizens with tsrp_roambots 1. On every other map
 * it registers its cvars and its status command and does nothing else at all: no forwards, no
 * tasks, no bots. It also stands down when ts_matchmode plays its match on the map
 * (tsm_enabled 1), which adds and balances bots of its own.
 *
 * HOW THE BOTS BEHAVE. The patched RCBot does that (rcbot-patch CHANGE 8, rcbot-ts-roam.patch):
 * while this plugin holds tsrp_roambots_active at 1, every bot is a roamer -- it walks between
 * random waypoints at the speed of a player's walk key, pauses now and then, never takes anything
 * for an enemy, buys nothing, and is armed only when tsrp_roambots_weapons says so. This plugin
 * owns the rest: how many there are, their names and models, where they appear, pickups, and the
 * slots real players need.
 *
 * WHAT IT PROVES IT RELIES ON. A bot is a fake client: it sends no client commands and is sent no
 * messages, AMXX's connect forwards do not fire for RCBot's bots, and in TS neither Ham_Spawn nor
 * Ham_TakeDamage fires at all. So everything here runs from a one-second task (bots are found by
 * polling the slots), FM_PlayerPostThink (measured firing for bots and players alike), and
 * engclient_cmd. The one other hook, FM_Touch for pickups, is counted, and amx_roambots shows
 * every counter, so whether each path runs is read off the server rather than assumed.
 *
 * SPAWNS. The map's generator also writes configs\tsrp_roamspots_<map>.cfg: places on the
 * public floor, each with its district. A citizen who has just (re)spawned is moved to one of them
 * in a district other than the one it stands in, the district with the fewest citizens, away from
 * real players where it can be. No file: TS's own spawn points.
 *
 * HURT AND KILLED. Players can hurt and kill citizens (tsrp_roambots_god 1 makes them unhurtable).
 * A dying citizen is left entirely to TS: its body stays where it fell, TS respawns it on its own
 * schedule, and the moment it is back on its feet it is moved far off to another district with a
 * new face from the model list, so nobody sees the same citizen stand up again.
 *
 * NAMES MATCH FACES. Each model in tsrp_roambots_models carries its gender, ":f" or ":m" after the
 * name ("prole_fem:f"); a model without one is neither. A citizen's name is drawn from the list for
 * its model's gender -- tsrp_roambots_names_f, tsrp_roambots_names_m, or tsrp_roambots_names for a
 * model with none; empty, the plugin's own lists -- one no other citizen has had on this map while
 * the list lasts, and a new face after a death is a model of the same gender, so the name still
 * fits. Names are given as citizens join, one every RB_JOIN_GAP seconds, so never in a burst.
 *
 * SLOTS. tsrp_roambots_reserve slots are always left free for real players: when people join, a
 * citizen leaves (a dead one, or the one farthest from any player), and they come back as people
 * leave. RCBot's own fill is switched off (min_bots -1, max_bots -1) while citizens run, so this
 * plugin is the only thing that adds or removes them, one at a time.
 *
 * CVARS (registration defaults; plugin_cfg puts them back at every map, then runs
 * configs\tsrp_roambots.cfg, then the map's own ts\mapconfigs\<map>.cfg lines for them):
 *   tsrp_roambots          0|1   citizens on this map (a roleplay map's mapconfig turns it on)
 *   tsrp_roambots_count    12    how many, at most (fewer when real players need the slots)
 *   tsrp_roambots_reserve  2     slots always kept free for real players (at least 1)
 *   tsrp_roambots_weapons  0|1   0: unarmed, and nothing on the ground is picked up
 *   tsrp_roambots_models   "proletarian_healthy:m;proletarian:m;prole_fem:f;prole_bfem:f"
 *   tsrp_roambots_names_f  ""    women's names, ";" between them; empty: the list in this file
 *   tsrp_roambots_names_m  ""    men's names; empty: the list in this file
 *   tsrp_roambots_names    ""    names for a model with no gender; empty: the list in this file
 *   tsrp_roambots_speed    120   the walk, units a second (read by RCBot)
 *   tsrp_roambots_pause    40    percent chance of a pause before each walk (read by RCBot)
 *   tsrp_roambots_god      0|1   1: citizens cannot be hurt
 *   tsrp_roambots_debug    0|1   1: log every placement, pickup refused and weapon dropped
 *   tsrp_roambots_active   (set by this plugin, read by RCBot: 1 while citizens run)
 *
 * amx_roambots (server console or an admin with ADMIN_CFG): what it is doing and every counter.
 *
 * ASCII only, braces on every block, no backslash escapes in strings.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <tsfun>

// The model and name lists are parsed in buffers of a few hundred cells each.
#pragma dynamic 16384

#define PLUGIN  "TSRP Roaming Citizens"
#define VERSION "1.0"
#define AUTHOR  "h9"

// Player-slot arrays are indexed 1..MAX_PLAYERS (AMX Mod X's own limit); the server's real slot count,
// as far as AMX Mod X goes, is g_maxplayers.
#define RB_SLOTS (MAX_PLAYERS + 1)

#define RB_TASK_TICK 73100

// The first citizen joins this long after the map starts: ts_matchmode zeroes RCBot's quota and
// sends every bot away on its first tick (a second in) on a map it does not play, so ours come after.
#define RB_WARMUP 6.0
// One citizen joins every RB_JOIN_GAP seconds, one leaves per tick: never a burst in one frame.
#define RB_JOIN_GAP 2.0
// A citizen is moved this long after it is back on its feet, so TS has finished spawning it.
#define RB_PLACE_DELAY 0.2

#define RB_SPOTS_MAX 4096
#define RB_DISTRICTS_MAX 32
#define RB_NAMES_MAX 64
#define RB_MODELS_MAX 16
#define RB_NAME_LEN 32
#define RB_LIST_LEN 1024

// A spot is clear when nobody alive stands within RB_SPOT_ROOM of it, and, on the first pass,
// no real player within RB_UNSEEN (so a citizen does not appear in front of someone).
#define RB_SPOT_ROOM 72.0
#define RB_UNSEEN 768.0
#define RB_PLACE_TRIES 24

// A dropped weapon is swept from within this of where its citizen dropped it.
#define RB_DROP_REACH 96.0

#define RB_TSW_KUNG_FU 36

#define RB_DAMAGE_NO 0.0
#define RB_DAMAGE_AIM 2.0
#define RB_FL_KILLME (1<<30)
#define RB_HULL_HUMAN 1
#define RB_DONT_IGNORE_MONSTERS 0

new const RB_DEFAULT_MODELS[] = "proletarian_healthy:m;proletarian:m;prole_fem:f;prole_bfem:f";

// A model's gender, and the name list it draws from (NAMES MATCH FACES).
#define RB_NEUTRAL 0
#define RB_FEMALE  1
#define RB_MALE    2
#define RB_GENDERS 3

// Citizens' names when their cvars are empty: ordinary people of an ordinary city, by gender.
new const RB_NAMES_F[][] =
{
	"Ada Varga", "Ilse Brandt", "Nadia Petrov", "Mira Castell", "Eva Sorensen", "Hana Okafor",
	"Rosa Albescu", "Yara Haddad", "Lena Vogt", "Clara Juarez", "Sofia Rinaldi", "Ines Moreau",
	"Talia Mercer", "Noor Rahman", "Irina Sokol", "Greta Falk", "Zofia Krol", "Amara Nwosu",
	"Vera Lasko", "Selma Aydin", "Dana Kovac", "Maren Quist", "Petra Hollis", "Alma Ruiz",
	"Agnes Moller", "Beatrix Lam", "Celine Doucet", "Dora Halvorsen", "Elif Demir", "Frida Nyberg",
	"Gemma Riordan", "Helga Strom", "Iva Maric", "Julia Brandao", "Katya Morozova", "Lucia Ferrante",
	"Magda Wojcik", "Nina Albrecht", "Olga Sandor", "Paula Ibarra"
};
new const RB_NAMES_M[][] =
{
	"Marek Holm", "Tomas Reyes", "Oskar Lind", "Jonah Weller", "Luka Novak", "Pavel Dvorak",
	"Felix Marlowe", "Bruno Keller", "Dmitri Orlov", "Anton Weiss", "Viktor Hale", "Karl Brenner",
	"Emil Strand", "Gustav Lorne", "Mateo Cruz", "Samuel Ottley", "Henrik Dahl", "Leon Fischer",
	"Otto Graves", "Ruben Vidal", "Igor Ventris", "Jules Arden", "Nico Barros", "Stefan Moll",
	"Aldo Ferri", "Boris Kral", "Cyril Vance", "Dario Conti", "Erik Halden", "Farid Nasser",
	"Gregor Pahl", "Hugo Lessard", "Ivan Petric", "Jakob Renner", "Kasimir Baran", "Lorenzo Bassi",
	"Milan Horak", "Nils Ekberg", "Omar Saleh", "Piotr Zielinski"
};
new const RB_NAMES_N[][] =
{
	"Alex Moreno", "Sam Okoro", "Robin Hale", "Jordan Price", "Casey Lund", "Riley Shaw",
	"Morgan Vale", "Quinn Adler", "Avery Stone", "Jesse Marin", "Kai Brandt", "Noel Ferris",
	"Sasha Lemaire", "Toni Marsh", "Rene Castor", "Charlie Webb"
};

new g_maxplayers;
new g_mapname[64];
new bool:g_rp_map;

new g_cv_on, g_cv_count, g_cv_reserve, g_cv_weapons, g_cv_models, g_cv_names, g_cv_speed,
	g_cv_pause, g_cv_god, g_cv_debug, g_cv_active;
new g_cv_names_g[RB_GENDERS];   // the name list cvar of each gender (g_cv_names is the neutral one)
new g_cv_tsm_enabled;

new bool:g_active;
new Float:g_next_join;
new bool:g_said_standdown;

// Citizens, by slot.
new bool:g_citizen[RB_SLOTS];
new bool:g_was_alive[RB_SLOTS];
new Float:g_place_at[RB_SLOTS];
new bool:g_godded[RB_SLOTS];
new g_model_pick[RB_SLOTS][RB_NAME_LEN];
new g_gender[RB_SLOTS];         // the gender of the citizen's face and name
new Float:g_sweep_at[RB_SLOTS];
new Float:g_sweep_from[RB_SLOTS][3];

// The models and names in use, parsed from their cvars when those change.
new g_models[RB_MODELS_MAX][RB_NAME_LEN];
new g_model_gender[RB_MODELS_MAX];
new g_model_count;
new g_models_from[RB_LIST_LEN];
new g_names[RB_GENDERS][RB_NAMES_MAX][RB_NAME_LEN];
new g_name_count[RB_GENDERS];
new g_names_from[RB_GENDERS][RB_LIST_LEN];
new bool:g_name_used[RB_GENDERS][RB_NAMES_MAX];   // given on this map already

// The map's spots, grouped by district: g_by_district holds spot numbers, district d's run of
// them starts at g_district_first[d] and is g_district_spots[d] long.
new Float:g_spot[RB_SPOTS_MAX][3];
new g_spot_district[RB_SPOTS_MAX];
new g_spot_count;
new g_district[RB_DISTRICTS_MAX][RB_NAME_LEN];
new g_district_count;
new g_by_district[RB_SPOTS_MAX];
new g_district_first[RB_DISTRICTS_MAX];
new g_district_spots[RB_DISTRICTS_MAX];

// Counters, for amx_roambots: what has run and how often.
new g_n_ticks, g_n_postthink, g_n_joins_asked, g_n_adopted, g_n_sent_away, g_n_spawns,
	g_n_placed, g_n_place_failed, g_n_touch_refused, g_n_dropped, g_n_swept, g_n_model_writes;

/*
 * A roleplay map by its name: rp_ or tsrp_ at the start, or _rp_ or _tsrp_ anywhere in it.
 *
 * THE TWIN of ts_matchmode.sma's roleplay_map() (search "bool:roleplay_map" there), which turns
 * the match mode off on the same maps. Keep the two the same: a map one calls roleplay and the
 * other does not would have both or neither running.
 */
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_maxplayers = get_maxplayers();
	if (g_maxplayers > RB_SLOTS - 1)
	{
		g_maxplayers = RB_SLOTS - 1;
	}
	get_mapname(g_mapname, charsmax(g_mapname));
	g_rp_map = roleplay_map(g_mapname);

	// Registered on every map, so a mapconfig line naming one is never an unknown command.
	g_cv_on      = register_cvar("tsrp_roambots",         "0");
	g_cv_count   = register_cvar("tsrp_roambots_count",   "12");
	g_cv_reserve = register_cvar("tsrp_roambots_reserve", "2");
	g_cv_weapons = register_cvar("tsrp_roambots_weapons", "0");
	g_cv_models  = register_cvar("tsrp_roambots_models",  RB_DEFAULT_MODELS);
	g_cv_names   = register_cvar("tsrp_roambots_names",   "");
	g_cv_names_g[RB_NEUTRAL] = g_cv_names;
	g_cv_names_g[RB_FEMALE] = register_cvar("tsrp_roambots_names_f", "");
	g_cv_names_g[RB_MALE]   = register_cvar("tsrp_roambots_names_m", "");
	g_cv_speed   = register_cvar("tsrp_roambots_speed",   "120");
	g_cv_pause   = register_cvar("tsrp_roambots_pause",   "40");
	g_cv_god     = register_cvar("tsrp_roambots_god",     "0");
	g_cv_debug   = register_cvar("tsrp_roambots_debug",   "0");
	// Ours to set, RCBot's to read. FCVAR_SPONLY: no client changes it.
	g_cv_active  = register_cvar("tsrp_roambots_active",  "0", FCVAR_SPONLY);

	// It survives a map change; RCBot must not see it on a map that runs no citizens.
	set_pcvar_num(g_cv_active, 0);

	register_concmd("amx_roambots", "cmd_status", ADMIN_CFG, "- roaming citizens: what they are doing, and every counter");

	if (!g_rp_map)
	{
		return;
	}

	// Only on a roleplay map: what a citizen needs, every frame and every second.
	register_forward(FM_PlayerPostThink, "fw_postthink_post", 1);
	register_forward(FM_Touch, "fw_touch");
	set_task(1.0, "task_tick", RB_TASK_TICK, "", 0, "b");
}

public plugin_cfg()
{
	if (!g_rp_map)
	{
		return;
	}

	// Every map starts from the defaults: a value one map's mapconfig set must not carry on to the
	// next roleplay map, which may not want citizens at all.
	set_pcvar_num(g_cv_on, 0);
	set_pcvar_num(g_cv_count, 12);
	set_pcvar_num(g_cv_reserve, 2);
	set_pcvar_num(g_cv_weapons, 0);
	set_pcvar_string(g_cv_models, RB_DEFAULT_MODELS);
	set_pcvar_string(g_cv_names, "");
	set_pcvar_string(g_cv_names_g[RB_FEMALE], "");
	set_pcvar_string(g_cv_names_g[RB_MALE], "");
	set_pcvar_num(g_cv_speed, 120);
	set_pcvar_num(g_cv_pause, 40);
	set_pcvar_num(g_cv_god, 0);

	// The server's own defaults, if it has any.
	new cfgdir[64], path[128];
	get_configsdir(cfgdir, charsmax(cfgdir));
	formatex(path, charsmax(path), "%s/tsrp_roambots.cfg", cfgdir);
	if (file_exists(path))
	{
		server_cmd("exec %s", path);
		server_exec();
	}

	// Then the map's own lines for these cvars, read here as well as run by the engine
	// (h9_autoconfig): the map's values are in force whichever comes first, and on a server
	// that does not run mapconfigs at all.
	formatex(path, charsmax(path), "mapconfigs/%s.cfg", g_mapname);
	apply_cfg_lines(path);

	g_cv_tsm_enabled = get_cvar_pointer("tsm_enabled");

	load_spots();

	log_amx("[ROAMBOTS] %s is a roleplay map: citizens %s by its config (tsrp_roambots %d), %d spots in %d districts.",
		g_mapname, get_pcvar_num(g_cv_on) ? "asked for" : "not asked for", get_pcvar_num(g_cv_on),
		g_spot_count, g_district_count);
}

public plugin_end()
{
	// The cvar outlives the map; nothing of ours does.
	set_pcvar_num(g_cv_active, 0);
}

/// Sets this plugin's cvars from the lines that name them in a config file (others are left alone).
apply_cfg_lines(const path[])
{
	new f = fopen(path, "rt", true);
	if (!f)
	{
		return;
	}
	new line[RB_LIST_LEN + 64], key[48], value[RB_LIST_LEN];
	while (!feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		if (!line[0] || (line[0] == '/' && line[1] == '/'))
		{
			continue;
		}
		key[0] = 0;
		value[0] = 0;
		parse(line, key, charsmax(key), value, charsmax(value));
		if (!equali(key, "tsrp_roambots", 13) || equali(key, "tsrp_roambots_active"))
		{
			continue;
		}
		new pcv = get_cvar_pointer(key);
		if (pcv)
		{
			set_pcvar_string(pcv, value);
		}
	}
	fclose(f);
}

/*
 * The map's spots: configs/tsrp_roamspots_<map>.cfg, one per line,
 *     roamspot <district> <x> <y> <z>
 * where x y z is a player's origin standing there (the feet 36 under it). The generator writes it
 * with the map's waypoints; lines starting // are notes.
 */
load_spots()
{
	g_spot_count = 0;
	g_district_count = 0;

	new cfgdir[64], path[160];
	get_configsdir(cfgdir, charsmax(cfgdir));
	formatex(path, charsmax(path), "%s/tsrp_roamspots_%s.cfg", cfgdir, g_mapname);
	new f = fopen(path, "rt");
	if (!f)
	{
		log_amx("[ROAMBOTS] no %s: citizens appear at TS's own spawn points.", path);
		return;
	}

	new line[160], word[16], name[RB_NAME_LEN], sx[16], sy[16], sz[16];
	while (!feof(f) && g_spot_count < RB_SPOTS_MAX)
	{
		fgets(f, line, charsmax(line));
		trim(line);
		if (!line[0] || line[0] == '/')
		{
			continue;
		}
		word[0] = 0;
		name[0] = 0;
		sx[0] = 0;
		sy[0] = 0;
		sz[0] = 0;
		parse(line, word, charsmax(word), name, charsmax(name), sx, charsmax(sx), sy, charsmax(sy), sz, charsmax(sz));
		if (!equali(word, "roamspot") || !name[0] || !sz[0])
		{
			continue;
		}
		new d = district_number(name);
		if (d < 0)
		{
			continue;
		}
		g_spot[g_spot_count][0] = str_to_float(sx);
		g_spot[g_spot_count][1] = str_to_float(sy);
		g_spot[g_spot_count][2] = str_to_float(sz);
		g_spot_district[g_spot_count] = d;
		g_spot_count++;
	}
	fclose(f);

	// Grouped by district, for a random spot in a chosen one.
	new at = 0;
	for (new d = 0; d < g_district_count; d++)
	{
		g_district_first[d] = at;
		g_district_spots[d] = 0;
		for (new s = 0; s < g_spot_count; s++)
		{
			if (g_spot_district[s] == d)
			{
				g_by_district[at++] = s;
				g_district_spots[d]++;
			}
		}
	}
}

/// A district's number, added when it is new; -1 when the table is full.
district_number(const name[])
{
	for (new d = 0; d < g_district_count; d++)
	{
		if (equali(g_district[d], name))
		{
			return d;
		}
	}
	if (g_district_count >= RB_DISTRICTS_MAX)
	{
		return -1;
	}
	copy(g_district[g_district_count], charsmax(g_district[]), name);
	return g_district_count++;
}

/// Citizens wanted on this map now: asked for, and the match mode is not playing it.
bool:want_citizens()
{
	if (get_pcvar_num(g_cv_on) <= 0)
	{
		return false;
	}
	if (g_cv_tsm_enabled && get_pcvar_num(g_cv_tsm_enabled) > 0)
	{
		if (!g_said_standdown)
		{
			g_said_standdown = true;
			log_amx("[ROAMBOTS] tsm_enabled is 1 on %s: ts_matchmode plays its match here and runs its own bots, so no citizens.", g_mapname);
		}
		return false;
	}
	g_said_standdown = false;
	return true;
}

/*
 * Once a second, on a roleplay map only: start or stop, find the bots, keep the count, look
 * after each citizen.
 */
public task_tick()
{
	g_n_ticks++;

	new bool:want = want_citizens();
	if (want && !g_active && get_gametime() >= RB_WARMUP)
	{
		start_citizens();
	}
	else if (!want && g_active)
	{
		stop_citizens();
	}

	find_citizens();

	if (g_active)
	{
		refresh_lists();
		keep_count();
		look_after();
	}
	else
	{
		// Stopped: they leave one a second, as they came.
		send_one_away(true);
	}
}

start_citizens()
{
	g_active = true;
	set_pcvar_num(g_cv_active, 1);

	/*
	 * RCBot's own fill off, both ways (rcbot_commands.txt: -1 disables auto-bot adding/removing).
	 * With min_bots 0, which ts_matchmode leaves on a map it does not play, RCBot kicks a bot every
	 * time a real player connects; with -1 this plugin alone adds and removes citizens.
	 */
	server_cmd("rcbot config min_bots -1");
	server_cmd("rcbot config max_bots -1");

	g_next_join = get_gametime();
	log_amx("[ROAMBOTS] citizens on: up to %d on %s, %d slots kept free, %s.",
		get_pcvar_num(g_cv_count), g_mapname, reserve_slots(),
		get_pcvar_num(g_cv_weapons) ? "armed" : "unarmed");
}

stop_citizens()
{
	g_active = false;
	set_pcvar_num(g_cv_active, 0);

	// Back to the quota ts_matchmode gives a map it does not play.
	server_cmd("rcbot config min_bots 0");
	server_cmd("rcbot config max_bots 0");

	log_amx("[ROAMBOTS] citizens off on %s: they leave one a second.", g_mapname);
}

reserve_slots()
{
	new r = get_pcvar_num(g_cv_reserve);
	return r < 1 ? 1 : r;
}

/*
 * Who is a citizen. RCBot makes its bots past Metamod, so no connect forward tells us of one:
 * the slots are read every second instead. While citizens run, every bot on the map is one --
 * ts_matchmode sends every other bot away on a roleplay map it does not play.
 */
find_citizens()
{
	for (new id = 1; id <= g_maxplayers; id++)
	{
		new bool:bot = is_user_connected(id) && is_user_bot(id);
		if (g_citizen[id] && !bot)
		{
			forget(id);
		}
		else if (bot && !g_citizen[id] && g_active)
		{
			adopt(id);
		}
	}
}

forget(id)
{
	g_citizen[id] = false;
	g_was_alive[id] = false;
	g_place_at[id] = 0.0;
	g_godded[id] = false;
	g_model_pick[id][0] = 0;
	g_gender[id] = RB_NEUTRAL;
	g_sweep_at[id] = 0.0;
}

adopt(id)
{
	g_citizen[id] = true;
	g_was_alive[id] = false;
	g_place_at[id] = 0.0;
	g_godded[id] = false;
	g_sweep_at[id] = 0.0;
	g_n_adopted++;

	refresh_lists();
	pick_model(id, false);
	give_name(id);
}

/// The model and name lists, parsed again only when their cvars change.
refresh_lists()
{
	new now[RB_LIST_LEN];

	get_pcvar_string(g_cv_models, now, charsmax(now));
	if (!equal(now, g_models_from) || !g_model_count)
	{
		copy(g_models_from, charsmax(g_models_from), now);
		g_model_count = 0;
		new piece[RB_NAME_LEN], rest[RB_LIST_LEN], carry[RB_LIST_LEN], path[96];
		copy(rest, charsmax(rest), now);
		while (rest[0] && g_model_count < RB_MODELS_MAX)
		{
			strtok(rest, piece, charsmax(piece), carry, charsmax(carry), ';', 1);
			copy(rest, charsmax(rest), carry);
			trim(piece);
			if (!piece[0])
			{
				continue;
			}
			// "name:f" a woman's face, "name:m" a man's, the name alone neither
			new gender = RB_NEUTRAL, colon = contain(piece, ":");
			if (colon >= 0)
			{
				new tag = tolower(piece[colon + 1]);
				gender = (tag == 'f') ? RB_FEMALE : ((tag == 'm') ? RB_MALE : RB_NEUTRAL);
				piece[colon] = 0;
			}
			formatex(path, charsmax(path), "models/player/%s/%s.mdl", piece, piece);
			if (!file_exists(path))
			{
				log_amx("[ROAMBOTS] model %s is not installed (%s): left out.", piece, path);
				continue;
			}
			g_model_gender[g_model_count] = gender;
			copy(g_models[g_model_count++], RB_NAME_LEN - 1, piece);
		}
	}

	for (new g = 0; g < RB_GENDERS; g++)
	{
		get_pcvar_string(g_cv_names_g[g], now, charsmax(now));
		if (equal(now, g_names_from[g]) && g_name_count[g])
		{
			continue;
		}
		copy(g_names_from[g], charsmax(g_names_from[]), now);
		g_name_count[g] = 0;
		arrayset(g_name_used[g], false, RB_NAMES_MAX);
		if (now[0])
		{
			new piece[RB_NAME_LEN], rest[RB_LIST_LEN], carry[RB_LIST_LEN];
			copy(rest, charsmax(rest), now);
			while (rest[0] && g_name_count[g] < RB_NAMES_MAX)
			{
				strtok(rest, piece, charsmax(piece), carry, charsmax(carry), ';', 1);
				copy(rest, charsmax(rest), carry);
				trim(piece);
				if (piece[0])
				{
					copy(g_names[g][g_name_count[g]++], RB_NAME_LEN - 1, piece);
				}
			}
		}
		if (!g_name_count[g])
		{
			builtin_names(g);
		}
	}
}

/// The plugin's own names for one gender, when its cvar is empty.
builtin_names(g)
{
	if (g == RB_FEMALE)
	{
		for (new i = 0; i < sizeof(RB_NAMES_F) && g_name_count[g] < RB_NAMES_MAX; i++)
		{
			copy(g_names[g][g_name_count[g]++], RB_NAME_LEN - 1, RB_NAMES_F[i]);
		}
	}
	else if (g == RB_MALE)
	{
		for (new i = 0; i < sizeof(RB_NAMES_M) && g_name_count[g] < RB_NAMES_MAX; i++)
		{
			copy(g_names[g][g_name_count[g]++], RB_NAME_LEN - 1, RB_NAMES_M[i]);
		}
	}
	else
	{
		for (new i = 0; i < sizeof(RB_NAMES_N) && g_name_count[g] < RB_NAMES_MAX; i++)
		{
			copy(g_names[g][g_name_count[g]++], RB_NAME_LEN - 1, RB_NAMES_N[i]);
		}
	}
}

/*
 * A face from the model list, written to the bot's "model" key (what every client draws). With
 * same_gender, a face of the citizen's own gender (a new face after a death, so its name still
 * fits); without, any face, and the citizen takes that face's gender.
 */
pick_model(id, bool:same_gender)
{
	if (!g_model_count)
	{
		g_model_pick[id][0] = 0;
		g_gender[id] = RB_NEUTRAL;
		return;
	}
	new pool[RB_MODELS_MAX], n = 0;
	for (new i = 0; i < g_model_count; i++)
	{
		if (!same_gender || g_model_gender[i] == g_gender[id])
		{
			pool[n++] = i;
		}
	}
	if (!n)
	{
		write_model(id);   // no other face of its gender: it keeps the one it has
		return;
	}
	new pick = pool[random_num(0, n - 1)];
	copy(g_model_pick[id], RB_NAME_LEN - 1, g_models[pick]);
	g_gender[id] = g_model_gender[pick];
	write_model(id);
}

/*
 * On a map TS plays as deathmatch (every roleplay map) TS keeps a model key it is given unless
 * mp_defaultteam is 1 or the name is a stock Half-Life one (CHalfLifeMultiplay::
 * ClientUserInfoChanged). Written only when it differs, and checked once a second.
 */
write_model(id)
{
	if (!g_model_pick[id][0])
	{
		return;
	}
	new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);
	new live[RB_NAME_LEN];
	live[0] = 0;
	engfunc(EngFunc_InfoKeyValue, buf, "model", live, charsmax(live));
	if (equali(live, g_model_pick[id]))
	{
		return;
	}
	engfunc(EngFunc_SetClientKeyValue, id, buf, "model", g_model_pick[id]);
	g_n_model_writes++;
}

/*
 * A name from the list that nobody on the server has, written straight into the bot's userinfo:
 * a fake client runs no "name" command. Kept if it already has one of the list's names.
 */
give_name(id)
{
	new g = g_gender[id];
	if (g < 0 || g >= RB_GENDERS || !g_name_count[g])
	{
		return;
	}
	new have[RB_NAME_LEN];
	get_user_name(id, have, charsmax(have));
	for (new i = 0; i < g_name_count[g]; i++)
	{
		if (equal(have, g_names[g][i]))
		{
			g_name_used[g][i] = true;
			return;   // a name of its gender already
		}
	}

	// A name nobody has had on this map while the list lasts, then one nobody has now.
	new start = random_num(0, g_name_count[g] - 1);
	for (new pass = 0; pass < 2; pass++)
	{
		for (new k = 0; k < g_name_count[g]; k++)
		{
			new i = (start + k) % g_name_count[g];
			if ((pass == 0 && g_name_used[g][i]) || name_taken(g_names[g][i]))
			{
				continue;
			}
			g_name_used[g][i] = true;
			new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);
			engfunc(EngFunc_SetClientKeyValue, id, buf, "name", g_names[g][i]);
			return;
		}
	}
}

bool:name_taken(const name[])
{
	new other[RB_NAME_LEN];
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (!is_user_connected(id))
		{
			continue;
		}
		get_user_name(id, other, charsmax(other));
		if (equal(other, name))
		{
			return true;
		}
	}
	return false;
}

/*
 * As many citizens as asked for, less the slots real players need. One joins every RB_JOIN_GAP
 * seconds while there are too few; one leaves each second while there are too many.
 */
keep_count()
{
	new citizens = 0, bots = 0;
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (!is_user_connected(id) || !is_user_bot(id))
		{
			continue;
		}
		bots++;
		if (g_citizen[id])
		{
			citizens++;
		}
	}
	// get_playersnum(1) counts players still connecting: their slot is taken already.
	new people = get_playersnum(1) - bots;
	if (people < 0)
	{
		people = 0;
	}

	new want = get_pcvar_num(g_cv_count);
	new room = g_maxplayers - people - reserve_slots();
	if (want > room)
	{
		want = room;
	}
	if (want < 0)
	{
		want = 0;
	}

	if (citizens > want)
	{
		send_one_away(false);
	}
	else if (citizens < want && get_gametime() >= g_next_join)
	{
		g_next_join = get_gametime() + RB_JOIN_GAP;
		g_n_joins_asked++;
		server_cmd("rcbot addbot");
	}
}

/*
 * One citizen leaves: a dead one if there is one, else the one farthest from every real player.
 * Kicked by userid -- a citizen's name has a space in it.
 */
send_one_away(bool:any)
{
	new pick = 0, Float:best = -1.0;
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (!g_citizen[id] || !is_user_connected(id))
		{
			continue;
		}
		new Float:far = is_user_alive(id) ? nearest_person(id) : 999999.0;
		if (far > best)
		{
			best = far;
			pick = id;
		}
		if (any)
		{
			break;
		}
	}
	if (!pick)
	{
		return;
	}
	g_n_sent_away++;
	server_cmd("kick #%d", get_user_userid(pick));
	forget(pick);
}

/// How far the nearest living real player is from a citizen.
Float:nearest_person(id)
{
	new Float:at[3], Float:other[3], Float:best = 999999.0;
	pev(id, pev_origin, at);
	for (new p = 1; p <= g_maxplayers; p++)
	{
		if (p == id || !is_user_alive(p) || is_user_bot(p))
		{
			continue;
		}
		pev(p, pev_origin, other);
		new Float:d = get_distance_f(at, other);
		if (d < best)
		{
			best = d;
		}
	}
	return best;
}

/*
 * Each citizen, once a second: its face kept, and -- unarmed citizens -- anything it holds
 * dropped and taken away. Pickups are refused in fw_touch; this catches a weapon however it
 * arrived (an RCBot build without CHANGE 8 hands its bots weapons at spawn).
 */
look_after()
{
	new bool:unarmed = get_pcvar_num(g_cv_weapons) <= 0;
	new Float:now = get_gametime();
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (!g_citizen[id] || !is_user_connected(id))
		{
			continue;
		}
		write_model(id);

		if (g_sweep_at[id] > 0.0 && now >= g_sweep_at[id])
		{
			g_sweep_at[id] = 0.0;
			sweep_dropped(id);
		}

		if (!unarmed || !is_user_alive(id))
		{
			continue;
		}
		new clip, ammo, mode, extra;
		new weapon = ts_getuserwpn(id, clip, ammo, mode, extra);
		if (weapon > 0 && weapon != RB_TSW_KUNG_FU)
		{
			pev(id, pev_origin, g_sweep_from[id]);
			engclient_cmd(id, "drop");
			g_sweep_at[id] = now + 0.5;
			g_n_dropped++;
			if (get_pcvar_num(g_cv_debug))
			{
				log_amx("[ROAMBOTS] citizen %d held weapon %d: dropped.", id, weapon);
			}
		}
	}
}

/// The weapon a citizen just dropped, taken off the ground where it fell.
sweep_dropped(id)
{
	new ent = -1, Float:at[3];
	for (new guard = 0; guard < 256; guard++)
	{
		ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "ts_groundweapon");
		if (ent <= 0)
		{
			break;
		}
		if (!pev_valid(ent))
		{
			continue;
		}
		pev(ent, pev_origin, at);
		if (get_distance_f(at, g_sweep_from[id]) > RB_DROP_REACH)
		{
			continue;
		}
		set_pev(ent, pev_flags, pev(ent, pev_flags) | RB_FL_KILLME);
		g_n_swept++;
	}
}

/*
 * Every frame, for every player: returns at once unless this is a citizen. Notes a citizen back
 * on its feet (from its first spawn or from TS's respawn) and moves it a moment later, and keeps
 * tsrp_roambots_god on it. A dying citizen is left entirely alone: TS makes its body and respawns
 * it on its own schedule.
 */
public fw_postthink_post(id)
{
	if (id < 1 || id > g_maxplayers || !g_citizen[id])
	{
		return FMRES_IGNORED;
	}
	g_n_postthink++;

	new bool:alive = is_user_alive(id) != 0;
	if (alive && !g_was_alive[id])
	{
		g_n_spawns++;
		g_place_at[id] = get_gametime() + RB_PLACE_DELAY;
	}
	g_was_alive[id] = alive;
	if (!alive)
	{
		return FMRES_IGNORED;
	}

	if (g_place_at[id] > 0.0 && get_gametime() >= g_place_at[id])
	{
		g_place_at[id] = 0.0;
		// a new face for whoever it is now, of the gender its name is; then somewhere else
		pick_model(id, true);
		place_citizen(id);
	}

	if (get_pcvar_num(g_cv_god) > 0)
	{
		if (Float:pev(id, pev_takedamage) != RB_DAMAGE_NO)
		{
			set_pev(id, pev_takedamage, RB_DAMAGE_NO);
		}
		g_godded[id] = true;
	}
	else if (g_godded[id])
	{
		set_pev(id, pev_takedamage, RB_DAMAGE_AIM);
		g_godded[id] = false;
	}
	return FMRES_IGNORED;
}

/*
 * A citizen picks nothing up: no powerup ever, and with tsrp_roambots_weapons 0 no weapon or
 * ammunition. Touch is called by the server itself, for bots as for players; fw_touch counts what
 * it refuses (amx_roambots), and look_after() catches a weapon however it arrived.
 */
public fw_touch(touched, toucher)
{
	new who = 0, thing = 0;
	if (toucher >= 1 && toucher <= g_maxplayers && g_citizen[toucher])
	{
		who = toucher;
		thing = touched;
	}
	else if (touched >= 1 && touched <= g_maxplayers && g_citizen[touched])
	{
		who = touched;
		thing = toucher;
	}
	if (!who || thing <= g_maxplayers || !pev_valid(thing))
	{
		return FMRES_IGNORED;
	}

	new cls[32];
	cls[0] = 0;
	pev(thing, pev_classname, cls, charsmax(cls));
	new bool:refuse = equal(cls, "ts_powerup")
		|| (get_pcvar_num(g_cv_weapons) <= 0 && (equal(cls, "ts_groundweapon") || equal(cls, "ts_groundammo")));
	if (!refuse)
	{
		return FMRES_IGNORED;
	}
	g_n_touch_refused++;
	if (get_pcvar_num(g_cv_debug) && g_n_touch_refused < 50)
	{
		log_amx("[ROAMBOTS] citizen %d refused a %s.", who, cls);
	}
	return FMRES_SUPERCEDE;
}

/// The district of the spot nearest a point; -1 when the map has no spots.
district_at(const Float:at[3])
{
	new best = -1, Float:bestd = 0.0;
	for (new s = 0; s < g_spot_count; s++)
	{
		new Float:d = get_distance_f(at, g_spot[s]);
		if (best < 0 || d < bestd)
		{
			best = s;
			bestd = d;
		}
	}
	return best < 0 ? -1 : g_spot_district[best];
}

/*
 * Moves a citizen who has just spawned to a spot in another district: the district with the
 * fewest citizens in it, not the one it stands in, so they spread through the whole city. A spot
 * is clear when nobody alive is within RB_SPOT_ROOM and a standing body fits there; the first
 * tries also keep it out of every real player's way (RB_UNSEEN).
 */
place_citizen(id)
{
	if (g_spot_count < 1 || g_district_count < 1)
	{
		return;
	}

	new Float:at[3];
	pev(id, pev_origin, at);
	new here = district_at(at);

	new counts[RB_DISTRICTS_MAX];
	for (new c = 1; c <= g_maxplayers; c++)
	{
		if (c == id || !g_citizen[c] || !is_user_alive(c))
		{
			continue;
		}
		new Float:o[3];
		pev(c, pev_origin, o);
		new d = district_at(o);
		if (d >= 0)
		{
			counts[d]++;
		}
	}

	// the emptiest district that is not this one, ties broken at random
	new target = -1;
	new start = random_num(0, g_district_count - 1);
	for (new k = 0; k < g_district_count; k++)
	{
		new d = (start + k) % g_district_count;
		if ((d == here && g_district_count > 1) || g_district_spots[d] < 1)
		{
			continue;
		}
		if (target < 0 || counts[d] < counts[target])
		{
			target = d;
		}
	}
	if (target < 0)
	{
		return;
	}

	for (new pass = 0; pass < 2; pass++)
	{
		for (new t = 0; t < RB_PLACE_TRIES; t++)
		{
			new s = g_by_district[g_district_first[target] + random_num(0, g_district_spots[target] - 1)];
			if (!spot_clear(g_spot[s], id, pass == 0))
			{
				continue;
			}
			move_to(id, g_spot[s]);
			g_n_placed++;
			if (get_pcvar_num(g_cv_debug))
			{
				log_amx("[ROAMBOTS] citizen %d placed in %s (%d %d %d), from %s.", id, g_district[target],
					floatround(g_spot[s][0]), floatround(g_spot[s][1]), floatround(g_spot[s][2]),
					here >= 0 ? g_district[here] : "nowhere");
			}
			return;
		}
	}
	g_n_place_failed++;
}

bool:spot_clear(const Float:spot[3], skip, bool:unseen)
{
	new Float:o[3];
	for (new p = 1; p <= g_maxplayers; p++)
	{
		if (p == skip || !is_user_alive(p))
		{
			continue;
		}
		pev(p, pev_origin, o);
		new Float:d = get_distance_f(spot, o);
		if (d < RB_SPOT_ROOM)
		{
			return false;
		}
		if (unseen && d < RB_UNSEEN && !is_user_bot(p))
		{
			return false;
		}
	}
	// a standing body fits there
	engfunc(EngFunc_TraceHull, spot, spot, RB_DONT_IGNORE_MONSTERS, RB_HULL_HUMAN, skip, 0);
	if (get_tr2(0, TR_StartSolid) || get_tr2(0, TR_AllSolid))
	{
		return false;
	}
	return true;
}

move_to(id, const Float:spot[3])
{
	new Float:to[3], Float:still[3], Float:face[3];
	to[0] = spot[0];
	to[1] = spot[1];
	to[2] = spot[2];
	face[1] = random_float(-180.0, 180.0);
	engfunc(EngFunc_SetOrigin, id, to);
	set_pev(id, pev_velocity, still);
	set_pev(id, pev_angles, face);
	set_pev(id, pev_v_angle, face);
	set_pev(id, pev_fixangle, 1);
}

/// amx_roambots: what the plugin is doing on this map, and how often each part has run.
public cmd_status(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	console_print(id, "[ROAMBOTS] %s %s: map %s, %s.", PLUGIN, VERSION, g_mapname,
		g_rp_map ? "a roleplay map" : "not a roleplay map (the plugin does nothing here)");
	if (!g_rp_map)
	{
		return PLUGIN_HANDLED;
	}

	new models[RB_LIST_LEN];
	get_pcvar_string(g_cv_models, models, charsmax(models));
	console_print(id, "  tsrp_roambots %d  active %d  count %d  reserve %d  weapons %d  god %d  speed %d  pause %d",
		get_pcvar_num(g_cv_on), get_pcvar_num(g_cv_active), get_pcvar_num(g_cv_count), reserve_slots(),
		get_pcvar_num(g_cv_weapons), get_pcvar_num(g_cv_god), get_pcvar_num(g_cv_speed), get_pcvar_num(g_cv_pause));
	console_print(id, "  models %s (%d installed), names %d women / %d men / %d either, %d spots in %d districts, maxplayers %d",
		models, g_model_count, g_name_count[RB_FEMALE], g_name_count[RB_MALE], g_name_count[RB_NEUTRAL],
		g_spot_count, g_district_count, g_maxplayers);
	console_print(id, "  ticks %d  postthink %d  joins asked %d  adopted %d  sent away %d",
		g_n_ticks, g_n_postthink, g_n_joins_asked, g_n_adopted, g_n_sent_away);
	console_print(id, "  spawns %d  placed %d  place failed %d  pickups refused %d  dropped %d  swept %d  model writes %d",
		g_n_spawns, g_n_placed, g_n_place_failed, g_n_touch_refused, g_n_dropped, g_n_swept, g_n_model_writes);

	new name[RB_NAME_LEN], Float:at[3], live[RB_NAME_LEN];
	for (new c = 1; c <= g_maxplayers; c++)
	{
		if (!g_citizen[c] || !is_user_connected(c))
		{
			continue;
		}
		get_user_name(c, name, charsmax(name));
		pev(c, pev_origin, at);
		new d = district_at(at);
		new buf = engfunc(EngFunc_GetInfoKeyBuffer, c);
		live[0] = 0;
		engfunc(EngFunc_InfoKeyValue, buf, "model", live, charsmax(live));
		console_print(id, "  #%2d %-20s %-20s %-6s %-12s %5d %5d %5d  speed %d", c, name, live,
			is_user_alive(c) ? "alive" : "dead", d >= 0 ? g_district[d] : "-",
			floatround(at[0]), floatround(at[1]), floatround(at[2]), floatround(vector_speed(c)));
	}
	return PLUGIN_HANDLED;
}

Float:vector_speed(id)
{
	new Float:v[3];
	pev(id, pev_velocity, v);
	return floatsqroot(v[0] * v[0] + v[1] * v[1]);
}
