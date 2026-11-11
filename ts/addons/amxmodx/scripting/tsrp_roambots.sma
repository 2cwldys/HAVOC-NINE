/*
 * tsrp_roambots.sma -- roaming citizens for H9's roleplay maps.
 *
 * RCBots that walk a roleplay city's public streets, halls and walkways at a walk, stop now
 * and then, talk when they meet, and fight only whoever attacks them, so that the city looks
 * lived in. They keep out of homes, shops and MSR space because the map's waypoints do: a
 * roleplay map gives RCBot
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
 * random waypoints at the speed of a player's walk key, pauses now and then, never jumps or
 * ducks, buys nothing, and is armed only when tsrp_roambots_weapons says so. It takes nobody for
 * an enemy but whoever hurt it in this life, and, in an insurgency, the players the insurgents are
 * set against. This plugin owns the rest: how many there are, their names and models, where they
 * appear, pickups, talking, the insurgency, and the slots real players need.
 *
 * WHAT IT PROVES IT RELIES ON. A bot is a fake client: it sends no client commands and is sent no
 * messages, AMXX's connect forwards do not fire for RCBot's bots, and in TS neither Ham_Spawn nor
 * Ham_TakeDamage fires at all. So everything here runs from a one-second task (bots are found by
 * polling the slots), FM_PlayerPostThink (measured firing for bots and players alike), and
 * engclient_cmd. The one other hook, FM_Touch for pickups, is counted, and amx_roambots shows
 * every counter, so whether each path runs is read off the server rather than assumed. The chat
 * commands come from real players' say; RCBot asks for a stuck citizen to be moved with a server
 * command, tsrp_roambots_unstick.
 *
 * SPAWNS. The map's generator also writes configs\tsrp_roamspots_<map>.cfg: places on the
 * public floor, each with its district. A citizen who has just (re)spawned is moved to one of them
 * in a district other than the one it stands in, the district with the fewest citizens, away from
 * real players where it can be. No file: TS's own spawn points.
 *
 * HURT AND KILLED. Players can hurt and kill citizens (tsrp_roambots_god 1 makes them unhurtable).
 * A citizen someone hurts fights that one back, with its hands, until he dies or leaves, or has
 * not hurt it for tsrp_roambots_defend_time seconds (RCBot, with tsrp_roambots_defend 1). A dying
 * citizen is left to TS: its body stays where it fell, TS respawns it on its own schedule, and the
 * moment it is back on its feet it is moved far off to another district with a new face from the
 * model list, so nobody sees the same citizen stand up again.
 *
 * HOSTILITY ENDS WITH THE LIFE. A citizen RCBot sees hurt by a player (the player behind pev
 * dmg_inflictor when its health falls: TS fires no damage hook) holds him for its attacker, and
 * lets him go when he dies, leaves, or has not hurt it for tsrp_roambots_defend_time seconds. All
 * of that is RCBot's, and needs an rcbot_mm.dll built from the rcbot-patch source of CHANGE 8 with
 * the defend_time rule (no tsrp_roambots_defend_time string in the DLL: an older build, which holds
 * the attacker for the rest of the citizen's life, so the citizens go for him again at his next
 * life). This plugin keeps a record of the same thing, one row per citizen and player
 * (amx_roamhostile prints it, inferred from the same health fall and inflictor, so it can differ
 * from RCBot's own), and ends a row when the player is back on his feet after a death, leaves, or
 * (where something writes pev team or pev playerclass, which the roleplay maps as shipped do not)
 * changes team or class. tsrp_rb_forgive_seconds above 0 sets tsrp_roambots_defend_time to that:
 * seconds after his last blow, RCBot lets him go. tsrp_rb_forget_cmd adds an action when a row
 * ends: 1 sends "rcbot roamforget <player>" (a build that has the command; any other prints that
 * the command does not exist), 2 sends away each citizen that was hostile to him once no player
 * can see it go, and keep_count brings in a fresh one (for an RCBot build that holds the attacker
 * for the whole life: a kick is the one thing that makes such a citizen forget).
 *
 * GETTING STUCK. RCBot judges a citizen by how far it gets, not how fast it moves: after about 5
 * seconds without getting anywhere it gives its goal up for another, and after about 12 it asks
 * this plugin to move it (the server command tsrp_roambots_unstick). The plugin then does what it
 * does after a death, without the death: a place in another district and a new face -- once no
 * real player near the citizen can see it go; RCBot asks again every 2 seconds until then.
 *
 * TALKING. Two citizens who meet -- within tsrp_roambots_talk_range of each other, level, in sight
 * of each other, both on the ground and unhurt in this life -- stop to talk with the chance
 * tsrp_roambots_talk. The plugin holds them with FL_FROZEN (the patched RCBot then stands still and
 * leaves its view alone), turns them to face each other, and has them murmur in turns for 3 to 6
 * seconds (sound\h9\murmur\murmur1-6.wav, each one precached only when it is installed); then
 * they walk on. A pair is asked once as they pass: after a talk, or a chance not taken, neither
 * stops again for a while. A hurt talker, or an insurgency, ends the talk at once.
 *
 * A WORD TO A PLAYER. A real player who presses +use (E) on a citizen within RB_HEED_REACH gets a
 * murmur from it, played from the citizen itself, and the citizen turns to face him and stays so
 * for RB_HEED_TIME (the same hold as a talk). tsrp_roambots_use 0 turns it off; after one, that
 * citizen and that player each wait tsrp_roambots_use_cooldown seconds before the next. A citizen
 * that is talking, hurt in this life, or an insurgent has nothing to say.
 *
 * INSURGENCY. An admin (tsrp_roambots_admin_flag) types .insurgency in chat: every citizen takes
 * the insurgent version of its face (tsrp_roambots_insurgent_models, "civilian:insurgent" pairs)
 * and the weapons of tsrp_roambots_insurgent_weapons, and RCBot sets the citizens on the players
 * (tsrp_roambots_insurgency): every player who is not a bot, or, with tsrp_roambots_insurgent_team
 * set, only the players of that team -- the guards, once RP teamplay runs, never the civilians.
 * They take up arms one at a time, RB_PACE_STEP apart, as ts_matchmode arms its players, and the
 * first weapon listed is given last and held: RCBot fights with the weapon in hand. A citizen
 * killed in the insurgency comes back an insurgent. TS throws a dying player's whole arsenal to
 * the ground; of an insurgent's, the gun in its hands is left (tsrp_roambots_insurgent_drop 0:
 * nothing). .civilians puts the insurgents down the same way, one at a time, leaving nothing on
 * the ground, and they come back as citizens. A mapconfig can start its map in an insurgency
 * (tsrp_roambots_insurgency 1) or switch both commands off (tsrp_roambots_commands 0).
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
 *   tsrp_roambots_defend   0|1   1: a citizen someone hurts fights that one back (read by RCBot)
 *   tsrp_roambots_defend_time 30  seconds it goes on without being hurt again before it lets him
 *                                be (read by RCBot)
 *   tsrp_rb_forgive_seconds 0    0: tsrp_roambots_defend_time is left as it is; N: it is set to N
 *   tsrp_rb_forget_cmd     0|1|2 0: nothing more than RCBot's own rules; 1: "rcbot roamforget <player>"
 *                                when a hostility ends (needs a build that has it); 2: the citizens
 *                                that were hostile to him are sent away and replaced
 *   tsrp_roambots_talk     40    percent chance that two citizens who meet stop to talk
 *   tsrp_roambots_talk_range 150 how close two citizens are when they stop to talk
 *   tsrp_roambots_insurgency 0|1 1: the citizens are insurgents (.insurgency and .civilians set it;
 *                                read by RCBot)
 *   tsrp_roambots_insurgent_models  "proletarian_healthy:ins_prole_helm;proletarian:ins_proletarian;
 *                                prole_fem:ins_prole_fem;prole_bfem:ins_prole_bfem" (one line)
 *   tsrp_roambots_insurgent_weapons "13:3,22:2"   TS weapon id:spare magazines, as the class lines
 *   tsrp_roambots_insurgent_team 0  0: insurgents are set on every player who is not a bot; a team
 *                                number: only on that team's players (read by RCBot)
 *   tsrp_roambots_insurgent_drop 1  1: a dying insurgent leaves the gun in its hands; 0: nothing
 *   tsrp_roambots_admin_flag "h" the admin flags .insurgency and .civilians need; empty: anyone
 *   tsrp_roambots_commands 0|1   0: .insurgency and .civilians do nothing on this map
 *   tsrp_roambots_use      0|1   1: a player's +use on a citizen gets him a murmur
 *   tsrp_roambots_use_cooldown 8  seconds before that citizen, or that player, does it again
 *   tsrp_roambots_active   (set by this plugin, read by RCBot: 1 while citizens run)
 *
 * amx_roambots (server console or an admin with ADMIN_CFG): what it is doing and every counter.
 * amx_roamhostile (the same): which citizen is hostile to which player, and when it ends.
 * .insurgency and .civilians (chat, an admin with tsrp_roambots_admin_flag): INSURGENCY, above.
 * tsrp_roambots_unstick <entity index> (server command, sent by RCBot): GETTING STUCK, above.
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
#define VERSION "1.4"
#define AUTHOR  "h9"

// Player-slot arrays are indexed 1..MAX_PLAYERS (AMX Mod X's own limit); the server's real slot count,
// as far as AMX Mod X goes, is g_maxplayers.
#define RB_SLOTS (MAX_PLAYERS + 1)

#define RB_TASK_TICK 73100
#define RB_TASK_PACE 73101

// tsrp_roambots_defend_time when it is not above 0: RCBot's own default.
#define RB_DEFEND_TIME_DEFAULT 30.0

// The first citizen joins this long after the map starts: ts_matchmode zeroes RCBot's quota and
// sends every bot away on its first tick (a second in) on a map it does not play, so ours come after.
#define RB_WARMUP 6.0
// One citizen joins every RB_JOIN_GAP seconds, one leaves per tick: never a burst in one frame.
#define RB_JOIN_GAP 2.0
// A citizen is moved this long after it is back on its feet, so TS has finished spawning it.
#define RB_PLACE_DELAY 0.2

// Two citizens who stop to talk do so for RB_TALK_LEAST to RB_TALK_MOST seconds, each murmuring
// every 2 x RB_TALK_TURN; then neither stops again for RB_TALK_AGAIN, nor, when the chance was not
// taken, for RB_TALK_RETRY. They are no farther apart up or down than RB_TALK_RISE.
#define RB_TALK_LEAST 3.0
#define RB_TALK_MOST 6.0
#define RB_TALK_TURN 2.4
#define RB_TALK_AGAIN 40.0
#define RB_TALK_RETRY 15.0
#define RB_TALK_RISE 48.0
#define RB_MURMURS 6
#define RB_MURMUR_LEN 40

// The insurgent face pairs, and the highest TS weapon id (tsconst.inc, TSW_TKNIFE).
#define RB_INS_MAX 16
#define RB_TSW_LAST TSW_TKNIFE
// The most weapons of tsrp_roambots_insurgent_weapons an insurgent is given.
#define RB_INS_WEAPONS 8
// One citizen takes up arms, or is put down, every RB_PACE_STEP seconds -- ts_matchmode's arm
// stagger (ARM_STAGGER) -- so a whole city's gives, faces and deaths never land in one frame.
#define RB_PACE_STEP 0.25

// A player's +use reaches a citizen this far from his eyes; the citizen faces him for RB_HEED_TIME.
#define RB_HEED_REACH 96
#define RB_HEED_TIME 2.5

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

// A model's path, "models/p_ak47.mdl".
#define RB_MODEL_LEN 64

#define RB_DAMAGE_NO 0.0
#define RB_DAMAGE_AIM 2.0
#define RB_FL_KILLME (1<<30)
#define RB_HULL_HUMAN 1
#define RB_DONT_IGNORE_MONSTERS 0
#define RB_IGNORE_MONSTERS 1
#define RB_FL_ONGROUND (1<<9)
#define RB_FL_FROZEN (1<<12)
#define RB_IN_USE (1<<5)

new const RB_DEFAULT_MODELS[] = "proletarian_healthy:m;proletarian:m;prole_fem:f;prole_bfem:f";
new const RB_DEFAULT_INS_MODELS[] = "proletarian_healthy:ins_prole_helm;proletarian:ins_proletarian;prole_fem:ins_prole_fem;prole_bfem:ins_prole_bfem";
new const RB_DEFAULT_INS_WEAPONS[] = "13:3,22:2";

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
new g_cv_defend, g_cv_talk, g_cv_talk_range, g_cv_insurgency, g_cv_ins_models, g_cv_ins_weapons,
	g_cv_ins_team, g_cv_admin_flag, g_cv_commands, g_cv_use, g_cv_use_cooldown, g_cv_defend_time,
	g_cv_ins_drop;

// Hostility (HOSTILITY ENDS WITH THE LIFE, above): when a player last hurt a citizen in this life of
// both (0.0: he has not), a citizen's health at its last frame (0.0: not alive), what is known of
// each real player (seen, alive, team, class), and tsrp_roambots_defend_time as it was before
// tsrp_rb_forgive_seconds took it over.
new Float:g_host_hurt[RB_SLOTS][RB_SLOTS];
new Float:g_c_health[RB_SLOTS];
new bool:g_p_seen[RB_SLOTS];
new bool:g_p_alive[RB_SLOTS];
new g_p_team[RB_SLOTS];
new g_p_class[RB_SLOTS];
new bool:g_replace_due[RB_SLOTS];
new bool:g_df_set;
new Float:g_df_saved;
new g_cv_forgive, g_cv_forget_cmd;
new g_n_host_set, g_n_host_ended, g_n_forget_cmds, g_n_replaced;

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
new Float:g_life_health[RB_SLOTS]; // its health when placed in this life: below it, it is hurt

// Talking (TALKING, above): with whom (0: nobody), until when, when it next murmurs, its health
// when the talk began, and when it may stop to talk again.
new g_talk_with[RB_SLOTS];
new Float:g_talk_until[RB_SLOTS];
new Float:g_talk_next_say[RB_SLOTS];
new Float:g_talk_health[RB_SLOTS];
new Float:g_talk_ready[RB_SLOTS];

// A word to a player (A WORD TO A PLAYER, above): the player a citizen faces (0: none), until when,
// its health when it turned to him, and when that citizen, or that player, may have the next.
new g_heed_with[RB_SLOTS];
new Float:g_heed_until[RB_SLOTS];
new Float:g_heed_health[RB_SLOTS];
new Float:g_heed_ready[RB_SLOTS];
new Float:g_heed_player_ready[RB_SLOTS];
new bool:g_use_down[RB_SLOTS];   // +use held at the last frame, so only a press counts

// The murmurs installed, precached on a roleplay map.
new g_murmur[RB_MURMURS][RB_MURMUR_LEN];
new g_murmur_count;

// The insurgency: whether this life of a citizen is dressed and armed as an insurgent, whether
// .civilians has put it down (its death not seen yet), the player model of the gun in its hands
// at its last frame alive, and the insurgent faces, parsed from their cvar when it changes.
new bool:g_insurgent[RB_SLOTS];
new bool:g_dismissed[RB_SLOTS];
new g_held[RB_SLOTS][RB_MODEL_LEN];
new g_ins_from[RB_INS_MAX][RB_NAME_LEN];
new g_ins_to[RB_INS_MAX][RB_NAME_LEN];
new g_ins_count;
new g_ins_models_from[RB_LIST_LEN];
new bool:g_ins_parsed;

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
	g_n_placed, g_n_place_failed, g_n_touch_refused, g_n_dropped, g_n_swept, g_n_model_writes,
	g_n_unstick_asked, g_n_unstick_seen, g_n_unstuck, g_n_talks, g_n_murmurs, g_n_armed, g_n_disarmed,
	g_n_heeds, g_n_left_slowed;

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

/*
 * The murmurs two talking citizens make, on a roleplay map only. Each is precached only when it is
 * installed (sound\h9\murmur\murmurN.wav), so a missing one is left out rather than sent to every
 * client to fail on; with none, citizens still stop and face each other, silently.
 */
public plugin_precache()
{
	new map[64];
	get_mapname(map, charsmax(map));
	if (!roleplay_map(map))
	{
		return;
	}
	new path[64];
	g_murmur_count = 0;
	for (new i = 1; i <= RB_MURMURS; i++)
	{
		formatex(path, charsmax(path), "sound/h9/murmur/murmur%d.wav", i);
		if (!file_exists(path))
		{
			continue;
		}
		formatex(g_murmur[g_murmur_count], charsmax(g_murmur[]), "h9/murmur/murmur%d.wav", i);
		precache_sound(g_murmur[g_murmur_count]);
		g_murmur_count++;
	}
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
	g_cv_defend      = register_cvar("tsrp_roambots_defend",      "1");
	g_cv_defend_time = register_cvar("tsrp_roambots_defend_time", "30");
	g_cv_talk        = register_cvar("tsrp_roambots_talk",        "40");
	g_cv_talk_range  = register_cvar("tsrp_roambots_talk_range",  "150");
	g_cv_insurgency  = register_cvar("tsrp_roambots_insurgency",  "0");
	g_cv_ins_models  = register_cvar("tsrp_roambots_insurgent_models",  RB_DEFAULT_INS_MODELS);
	g_cv_ins_weapons = register_cvar("tsrp_roambots_insurgent_weapons", RB_DEFAULT_INS_WEAPONS);
	g_cv_ins_team    = register_cvar("tsrp_roambots_insurgent_team",    "0");
	g_cv_ins_drop    = register_cvar("tsrp_roambots_insurgent_drop",    "1");
	g_cv_admin_flag  = register_cvar("tsrp_roambots_admin_flag",  "h");
	g_cv_commands    = register_cvar("tsrp_roambots_commands",    "1");
	g_cv_use         = register_cvar("tsrp_roambots_use",         "1");
	g_cv_use_cooldown = register_cvar("tsrp_roambots_use_cooldown", "8");
	g_cv_forgive     = register_cvar("tsrp_rb_forgive_seconds",   "0");
	g_cv_forget_cmd  = register_cvar("tsrp_rb_forget_cmd",        "0");
	// Ours to set, RCBot's to read. FCVAR_SPONLY: no client changes it.
	g_cv_active  = register_cvar("tsrp_roambots_active",  "0", FCVAR_SPONLY);

	// It survives a map change; RCBot must not see it on a map that runs no citizens.
	set_pcvar_num(g_cv_active, 0);

	register_concmd("amx_roambots", "cmd_status", ADMIN_CFG, "- roaming citizens: what they are doing, and every counter");
	register_concmd("amx_roamhostile", "cmd_hostile", ADMIN_CFG, "- roaming citizens: which is hostile to which player");
	// RCBot's, for a citizen that has got nowhere (rcbot-patch CHANGE 8): GETTING STUCK, above.
	register_srvcmd("tsrp_roambots_unstick", "cmd_unstick");

	if (!g_rp_map)
	{
		return;
	}

	// Only on a roleplay map: what a citizen needs, every frame and every second, and the
	// admins' .insurgency and .civilians.
	register_forward(FM_PlayerPostThink, "fw_postthink_post", 1);
	register_forward(FM_Touch, "fw_touch");
	register_forward(FM_ClientDisconnect, "fw_client_disconnect");
	register_clcmd("say", "hook_say");
	register_clcmd("say_team", "hook_say");
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
	set_pcvar_num(g_cv_defend, 1);
	set_pcvar_num(g_cv_defend_time, 30);
	set_pcvar_num(g_cv_talk, 40);
	set_pcvar_num(g_cv_talk_range, 150);
	set_pcvar_num(g_cv_insurgency, 0);
	set_pcvar_string(g_cv_ins_models, RB_DEFAULT_INS_MODELS);
	set_pcvar_string(g_cv_ins_weapons, RB_DEFAULT_INS_WEAPONS);
	set_pcvar_num(g_cv_ins_team, 0);
	set_pcvar_num(g_cv_ins_drop, 1);
	set_pcvar_string(g_cv_admin_flag, "h");
	set_pcvar_num(g_cv_commands, 1);
	set_pcvar_num(g_cv_use, 1);
	set_pcvar_num(g_cv_use_cooldown, 8);
	set_pcvar_num(g_cv_forgive, 0);
	set_pcvar_num(g_cv_forget_cmd, 0);
	g_df_set = false;
	hostile_reset();

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
	// The cvar outlives the map; nothing of ours does, and defend_time is put back.
	forgive_restore();
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
		if ((!equali(key, "tsrp_roambots", 13) && !equali(key, "tsrp_rb_", 8)) || equali(key, "tsrp_roambots_active"))
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
		pair_talkers();
		forgive_sync();
		hostile_expire();
		replace_flush();
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
	remove_task(RB_TASK_PACE);
	forgive_restore();
	hostile_reset();

	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (g_talk_with[id])
		{
			end_talk(id);
		}
		if (g_heed_with[id])
		{
			end_heed(id);
		}
	}

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
	if (g_talk_with[id])
	{
		end_talk(id);
	}
	if (g_heed_with[id])
	{
		end_heed(id);
	}
	g_insurgent[id] = false;
	g_talk_ready[id] = 0.0;
	g_citizen[id] = false;
	g_was_alive[id] = false;
	g_place_at[id] = 0.0;
	g_godded[id] = false;
	g_model_pick[id][0] = 0;
	g_gender[id] = RB_NEUTRAL;
	g_dismissed[id] = false;
	g_held[id][0] = 0;
	hostile_citizen_gone(id);
}

adopt(id)
{
	g_citizen[id] = true;
	g_was_alive[id] = false;
	g_place_at[id] = 0.0;
	g_godded[id] = false;
	g_dismissed[id] = false;
	g_held[id][0] = 0;
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
 * arrived (an RCBot build without CHANGE 8 hands its bots weapons at spawn). The insurgency is
 * kept as well, at its pace (task_pace): every citizen an insurgent while it is on, and none once
 * it is off.
 */
look_after()
{
	pace_insurgency();

	new bool:unarmed = get_pcvar_num(g_cv_weapons) <= 0 && !insurgency();
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (!g_citizen[id] || !is_user_connected(id))
		{
			continue;
		}
		write_model(id);

		if (!unarmed || !is_user_alive(id) || g_insurgent[id])
		{
			continue;
		}
		new clip, ammo, mode, extra;
		new weapon = ts_getuserwpn(id, clip, ammo, mode, extra);
		// anything in hand but its fists (TSW_KUNG_FU, 0 in H9's TSX)
		if (weapon != TSW_KUNG_FU && weapon > 0)
		{
			// TS throws it there and then (DropWeapon), so it is taken in the same frame
			engclient_cmd(id, "drop");
			take_thrown(id, "");
			g_n_dropped++;
			if (get_pcvar_num(g_cv_debug))
			{
				log_amx("[ROAMBOTS] citizen %d held weapon %d: dropped.", id, weapon);
			}
		}
	}
}

/*
 * What a citizen has just thrown to the ground: the weapon an unarmed one dropped, or an
 * insurgent's whole arsenal as it died. TS throws each as a "WorldGun" whose owner is the thrower
 * until it lands, so they are taken in the frame they were thrown -- all but one gun whose world
 * model is keep (empty: none is kept). A gun TS has slowed (pev fuser1 under 1, in someone's
 * bullet time) is left on the ground: TS holds a pointer to it until that ends, and takes it
 * away itself. Returns how many were taken.
 */
take_thrown(id, const keep[])
{
	new ent = -1, n = 0, model[RB_MODEL_LEN];
	new bool:kept = keep[0] == 0;
	for (new guard = 0; guard < 512; guard++)
	{
		ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "WorldGun");
		if (ent <= 0)
		{
			break;
		}
		if (!pev_valid(ent) || pev(ent, pev_owner) != id)
		{
			continue;
		}
		if (!kept)
		{
			model[0] = 0;
			pev(ent, pev_model, model, charsmax(model));
			if (equali(model, keep))
			{
				kept = true;
				continue;
			}
		}
		if (Float:pev(ent, pev_fuser1) < 1.0)
		{
			g_n_left_slowed++;
			continue;
		}
		set_pev(ent, pev_flags, pev(ent, pev_flags) | RB_FL_KILLME);
		n++;
	}
	g_n_swept += n;
	return n;
}

/*
 * Every frame, for every player: returns at once unless this is a citizen. Notes a citizen back
 * on its feet (from its first spawn or from TS's respawn) and moves it a moment later, keeps a
 * talk going or ends it, and keeps tsrp_roambots_god on it (never on an insurgent). A dying
 * citizen is left to TS: TS makes its body and respawns it on its own schedule; a talk it was in
 * ends, and the other talker is let go; of what a dying insurgent throws to the ground, only the
 * gun in its hands stays (insurgent_down).
 */
public fw_postthink_post(id)
{
	if (id < 1 || id > g_maxplayers)
	{
		return FMRES_IGNORED;
	}
	if (!g_citizen[id])
	{
		// a real player: his +use on a citizen (A WORD TO A PLAYER), and his lives for the
		// citizens that hold him an enemy (HOSTILITY ENDS WITH THE LIFE)
		if (g_active)
		{
			hostile_player_frame(id);
			use_check(id);
		}
		return FMRES_IGNORED;
	}
	g_n_postthink++;

	new bool:alive = is_user_alive(id) != 0;
	if (alive && !g_was_alive[id])
	{
		g_n_spawns++;
		g_place_at[id] = get_gametime() + RB_PLACE_DELAY;
		// a new life starts as a citizen; the insurgency, while it lasts, dresses it again
		g_insurgent[id] = false;
		g_dismissed[id] = false;
		hostile_new_life(id);
	}
	else if (!alive && g_was_alive[id] && g_insurgent[id])
	{
		insurgent_down(id);
	}
	g_was_alive[id] = alive;
	if (g_talk_with[id])
	{
		talk_upkeep(id, alive);
	}
	if (g_heed_with[id])
	{
		heed_upkeep(id, alive);
	}
	if (!alive)
	{
		g_c_health[id] = 0.0;
		return FMRES_IGNORED;
	}

	hostile_citizen_frame(id);

	if (g_insurgent[id])
	{
		// the gun in its hands, for the death that leaves only that (insurgent_down)
		pev(id, pev_weaponmodel, g_held[id], charsmax(g_held[]));
	}

	if (g_place_at[id] > 0.0 && get_gametime() >= g_place_at[id])
	{
		g_place_at[id] = 0.0;
		g_life_health[id] = Float:pev(id, pev_health);
		// a new face for whoever it is now, of the gender its name is (an insurgent's while the
		// insurgency lasts); then somewhere else
		dress(id);
		place_citizen(id);
	}

	if (get_pcvar_num(g_cv_god) > 0 && !g_insurgent[id])
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
 * ammunition -- but an insurgent may. Touch is called by the server itself, for bots as for
 * players; fw_touch counts what it refuses (amx_roambots), and look_after() catches a weapon
 * however it arrived.
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
		|| (get_pcvar_num(g_cv_weapons) <= 0 && !g_insurgent[who] && (equal(cls, "ts_groundweapon") || equal(cls, "ts_groundammo")));
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
 * tries also keep it out of every real player's way (RB_UNSEEN). True when it was moved.
 */
bool:place_citizen(id)
{
	if (g_spot_count < 1 || g_district_count < 1)
	{
		return false;
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
		return false;
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
			return true;
		}
	}
	g_n_place_failed++;
	return false;
}

/// A clear TS spawn point for a citizen, out of every real player's way where one is: for a map
/// with no spots file. True when it was moved.
bool:place_at_spawn(id)
{
	new spawns[64], n = 0, ent = -1;
	while (n < sizeof(spawns))
	{
		ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "info_player_deathmatch");
		if (ent <= 0)
		{
			break;
		}
		spawns[n++] = ent;
	}
	if (n < 1)
	{
		return false;
	}
	new Float:at[3];
	for (new pass = 0; pass < 2; pass++)
	{
		for (new t = 0; t < RB_PLACE_TRIES; t++)
		{
			pev(spawns[random_num(0, n - 1)], pev_origin, at);
			if (spot_clear(at, id, pass == 0))
			{
				move_to(id, at);
				g_n_placed++;
				return true;
			}
		}
	}
	g_n_place_failed++;
	return false;
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

/// A face for this life: one of its gender from the model list -- the insurgent version, with
/// the insurgent's weapons, while the insurgency lasts.
dress(id)
{
	pick_model(id, true);
	if (insurgency())
	{
		make_insurgent(id);
	}
}

/*
 * RCBot's ask (rcbot-patch CHANGE 8): citizen <entity index> has got nowhere for about 12 seconds.
 * It is moved as after a death, without one: to another district, with a new face -- once no real
 * player near it can see it go. Until then it stays, and RCBot asks again every 2 seconds.
 */
public cmd_unstick()
{
	if (!g_rp_map || !g_active)
	{
		return PLUGIN_HANDLED;
	}
	new arg[12];
	read_argv(1, arg, charsmax(arg));
	new id = str_to_num(arg);
	if (id < 1 || id > g_maxplayers || !g_citizen[id] || !is_user_alive(id) || g_place_at[id] > 0.0 || g_talk_with[id] || g_heed_with[id])
	{
		return PLUGIN_HANDLED;
	}
	g_n_unstick_asked++;
	if (seen_by_person(id))
	{
		g_n_unstick_seen++;
		return PLUGIN_HANDLED;
	}
	if (place_citizen(id) || place_at_spawn(id))
	{
		dress(id);
		g_n_unstuck++;
		if (get_pcvar_num(g_cv_debug))
		{
			log_amx("[ROAMBOTS] citizen %d got nowhere: moved elsewhere.", id);
		}
	}
	return PLUGIN_HANDLED;
}

/// Whether a real player within RB_UNSEEN has a clear line from his eyes to a citizen.
bool:seen_by_person(id)
{
	new Float:at[3], Float:eye[3], Float:ofs[3], Float:frac;
	pev(id, pev_origin, at);
	for (new p = 1; p <= g_maxplayers; p++)
	{
		if (p == id || !is_user_alive(p) || is_user_bot(p))
		{
			continue;
		}
		pev(p, pev_origin, eye);
		if (get_distance_f(at, eye) > RB_UNSEEN)
		{
			continue;
		}
		pev(p, pev_view_ofs, ofs);
		eye[0] += ofs[0];
		eye[1] += ofs[1];
		eye[2] += ofs[2];
		engfunc(EngFunc_TraceLine, eye, at, RB_IGNORE_MONSTERS, p, 0);
		get_tr2(0, TR_flFraction, frac);
		if (frac >= 1.0)
		{
			return true;
		}
	}
	return false;
}

/// Whether a citizen may stop to talk now: alive and placed, not talking or just done, not hurt
/// in this life, and on the ground.
bool:may_talk(id, Float:now)
{
	if (!g_citizen[id] || !is_user_alive(id) || g_talk_with[id] || g_heed_with[id] || g_place_at[id] > 0.0 || now < g_talk_ready[id])
	{
		return false;
	}
	if (Float:pev(id, pev_health) < g_life_health[id])
	{
		return false;
	}
	return (pev(id, pev_flags) & RB_FL_ONGROUND) != 0;
}

/*
 * Once a second: two citizens who meet may stop to talk (TALKING, above). Each pair close enough,
 * level and in sight of each other is asked once; a citizen is in one talk at a time.
 */
pair_talkers()
{
	if (insurgency())
	{
		return;
	}
	new chance = get_pcvar_num(g_cv_talk);
	if (chance <= 0)
	{
		return;
	}
	new Float:range = get_pcvar_float(g_cv_talk_range);
	new Float:now = get_gametime();
	new Float:a_at[3], Float:b_at[3], Float:frac;
	for (new a = 1; a <= g_maxplayers; a++)
	{
		if (!may_talk(a, now))
		{
			continue;
		}
		pev(a, pev_origin, a_at);
		for (new b = a + 1; b <= g_maxplayers; b++)
		{
			if (!may_talk(b, now))
			{
				continue;
			}
			pev(b, pev_origin, b_at);
			if (floatabs(a_at[2] - b_at[2]) > RB_TALK_RISE || get_distance_f(a_at, b_at) > range)
			{
				continue;
			}
			engfunc(EngFunc_TraceLine, a_at, b_at, RB_IGNORE_MONSTERS, a, 0);
			get_tr2(0, TR_flFraction, frac);
			if (frac < 1.0)
			{
				continue;
			}
			if (random_num(1, 100) <= chance)
			{
				start_talk(a, b, now);
			}
			else
			{
				g_talk_ready[a] = now + RB_TALK_RETRY;
				g_talk_ready[b] = now + RB_TALK_RETRY;
			}
			break;
		}
	}
}

/// Two citizens stop, face each other, and take turns murmuring for a few seconds.
start_talk(a, b, Float:now)
{
	new Float:until = now + random_float(RB_TALK_LEAST, RB_TALK_MOST);
	hold_talker(a, b, until);
	hold_talker(b, a, until);
	new first = random_num(0, 1) ? a : b;
	g_talk_next_say[first] = now + 0.3;
	g_talk_next_say[first == a ? b : a] = now + 0.3 + RB_TALK_TURN;
	g_n_talks++;
	if (get_pcvar_num(g_cv_debug))
	{
		log_amx("[ROAMBOTS] citizens %d and %d stop to talk.", a, b);
	}
}

/// Holds a citizen in a talk with another.
hold_talker(id, other, Float:until)
{
	g_talk_with[id] = other;
	g_talk_until[id] = until;
	g_talk_health[id] = Float:pev(id, pev_health);
	hold_facing(id, other);
}

/// Holds a citizen where it stands (FL_FROZEN: the patched RCBot stands and leaves its view alone),
/// turned to face another player.
hold_facing(id, other)
{
	set_pev(id, pev_flags, pev(id, pev_flags) | RB_FL_FROZEN);

	new Float:vel[3];
	pev(id, pev_velocity, vel);
	vel[0] = 0.0;
	vel[1] = 0.0;
	set_pev(id, pev_velocity, vel);
	face_toward(id, other);
}

/// Turns a citizen, view and body, to face another player.
face_toward(id, other)
{
	new Float:at[3], Float:to[3], Float:dir[3], Float:face[3];
	pev(id, pev_origin, at);
	pev(other, pev_origin, to);
	dir[0] = to[0] - at[0];
	dir[1] = to[1] - at[1];
	dir[2] = 0.0;
	engfunc(EngFunc_VecToAngles, dir, face);
	face[0] = 0.0;
	face[2] = 0.0;
	set_pev(id, pev_angles, face);
	set_pev(id, pev_v_angle, face);
}

/*
 * Every frame, for a citizen who is talking: the talk ends when its time is up, when either talker
 * is hurt or dies, when the other is gone, or when an insurgency starts. Until then the citizen is
 * kept held and murmurs when its turn comes.
 */
talk_upkeep(id, bool:alive)
{
	new other = g_talk_with[id];
	new Float:now = get_gametime();
	if (!alive || !g_active || insurgency() || now >= g_talk_until[id]
		|| other < 1 || other > g_maxplayers || g_talk_with[other] != id || !is_user_alive(other)
		|| Float:pev(id, pev_health) < g_talk_health[id])
	{
		end_talk(id);
		return;
	}
	// held again, and turned back to the other, whenever anything else has cleared its FL_FROZEN:
	// RCBot may have moved or turned it in the frame it was free
	if (!(pev(id, pev_flags) & RB_FL_FROZEN))
	{
		hold_facing(id, other);
	}
	if (now >= g_talk_next_say[id])
	{
		g_talk_next_say[id] = now + 2.0 * RB_TALK_TURN;
		murmur(id);
	}
}

/// Ends a talk for both talkers: both are let go, and neither stops to talk again for RB_TALK_AGAIN.
end_talk(id)
{
	new other = g_talk_with[id];
	release_talker(id);
	if (other >= 1 && other <= g_maxplayers && g_talk_with[other] == id)
	{
		release_talker(other);
	}
}

release_talker(id)
{
	g_talk_with[id] = 0;
	g_talk_ready[id] = get_gametime() + RB_TALK_AGAIN;
	if (is_user_connected(id))
	{
		set_pev(id, pev_flags, pev(id, pev_flags) & ~RB_FL_FROZEN);
	}
}

/// One murmur from a talking citizen: one of those installed, at a pitch for its voice.
murmur(id)
{
	if (g_murmur_count < 1)
	{
		return;
	}
	new pitch;
	switch (g_gender[id])
	{
		case RB_FEMALE:
		{
			pitch = random_num(104, 114);
		}
		case RB_MALE:
		{
			pitch = random_num(88, 98);
		}
		default:
		{
			pitch = random_num(95, 105);
		}
	}
	emit_sound(id, CHAN_VOICE, g_murmur[random_num(0, g_murmur_count - 1)], 0.8, ATTN_STATIC, 0, pitch);
	g_n_murmurs++;
}

/*
 * A real player's +use, every frame: pressed (not held), alive, looking at a citizen within
 * RB_HEED_REACH that is alive, placed, unhurt in this life and not talking or facing anyone,
 * neither of them in their cooldown, and no insurgency: the citizen murmurs to him and faces him.
 */
use_check(id)
{
	new bool:down = (pev(id, pev_button) & RB_IN_USE) != 0;
	new bool:pressed = down && !g_use_down[id];
	g_use_down[id] = down;
	if (!pressed || get_pcvar_num(g_cv_use) <= 0 || insurgency() || !is_user_alive(id) || is_user_bot(id))
	{
		return;
	}
	new bot, body;
	get_user_aiming(id, bot, body, RB_HEED_REACH);
	if (bot < 1 || bot > g_maxplayers || !g_citizen[bot] || !is_user_alive(bot) || g_talk_with[bot] || g_heed_with[bot]
		|| g_place_at[bot] > 0.0 || Float:pev(bot, pev_health) < g_life_health[bot])
	{
		return;
	}
	new Float:now = get_gametime();
	if (now < g_heed_ready[bot] || now < g_heed_player_ready[id])
	{
		return;
	}
	new Float:cooldown = get_pcvar_float(g_cv_use_cooldown);
	g_heed_ready[bot] = now + cooldown;
	g_heed_player_ready[id] = now + cooldown;
	g_heed_with[bot] = id;
	g_heed_until[bot] = now + RB_HEED_TIME;
	g_heed_health[bot] = Float:pev(bot, pev_health);
	hold_facing(bot, id);
	murmur(bot);
	g_n_heeds++;
	if (get_pcvar_num(g_cv_debug))
	{
		log_amx("[ROAMBOTS] citizen %d murmurs to player %d.", bot, id);
	}
}

/*
 * Every frame, for a citizen facing a player: it keeps facing him until RB_HEED_TIME is up, he is
 * gone or dead, it is hurt or dies, or an insurgency starts; then it is let go.
 */
heed_upkeep(id, bool:alive)
{
	new player = g_heed_with[id];
	if (!alive || !g_active || insurgency() || get_gametime() >= g_heed_until[id]
		|| !is_user_alive(player) || Float:pev(id, pev_health) < g_heed_health[id])
	{
		end_heed(id);
		return;
	}
	// held again whenever anything else has cleared its FL_FROZEN, and kept turned to him
	if (!(pev(id, pev_flags) & RB_FL_FROZEN))
	{
		hold_facing(id, player);
	}
	else
	{
		face_toward(id, player);
	}
}

/// Lets a citizen that faced a player go.
end_heed(id)
{
	g_heed_with[id] = 0;
	if (is_user_connected(id))
	{
		set_pev(id, pev_flags, pev(id, pev_flags) & ~RB_FL_FROZEN);
	}
}

bool:insurgency()
{
	return get_pcvar_num(g_cv_insurgency) > 0;
}

/// A living, placed citizen that is not an insurgent yet: one to arm while the insurgency is on.
bool:may_rise(id)
{
	return g_citizen[id] && !g_insurgent[id] && is_user_alive(id) && g_place_at[id] <= 0.0;
}

/// A living insurgent .civilians has not put down yet: one to put down once the insurgency is off.
bool:may_stand_down(id)
{
	return g_citizen[id] && g_insurgent[id] && !g_dismissed[id] && is_user_alive(id);
}

/// How many citizens the insurgency still has to change: to arm while it is on, to put down once it is off.
insurgency_due()
{
	new bool:rise = insurgency(), n = 0;
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (rise ? may_rise(id) : may_stand_down(id))
		{
			n++;
		}
	}
	return n;
}

/// The insurgency's pace (task_pace) set going when it has citizens to change and is not going yet.
pace_insurgency()
{
	if (g_active && !task_exists(RB_TASK_PACE) && insurgency_due() > 0)
	{
		set_task(RB_PACE_STEP, "task_pace", RB_TASK_PACE, "", 0, "b");
	}
}

/*
 * The insurgency's pace, every RB_PACE_STEP seconds while it has work: the next citizen, in slot
 * order, takes up arms (the insurgency on) or is put down (off). It stops once none is left; a
 * citizen back on its feet later is dressed and armed as it is placed (dress).
 */
public task_pace()
{
	new bool:rise = insurgency();
	for (new id = 1; g_active && id <= g_maxplayers; id++)
	{
		if (rise && may_rise(id))
		{
			rise_up(id);
			return;
		}
		if (!rise && may_stand_down(id))
		{
			stand_down(id);
			return;
		}
	}
	remove_task(RB_TASK_PACE);
}

/// A citizen takes up arms: out of any talk, then dressed and armed as an insurgent.
rise_up(id)
{
	if (g_talk_with[id])
	{
		end_talk(id);
	}
	if (g_heed_with[id])
	{
		end_heed(id);
	}
	make_insurgent(id);
}

/*
 * An insurgent put down by .civilians: TS's own suicide, which TS carries out a second later, and
 * a death that leaves nothing on the ground (insurgent_down). It comes back a citizen.
 */
stand_down(id)
{
	g_dismissed[id] = true;
	user_kill(id, 1);
	g_n_disarmed++;
}

/*
 * An insurgent has just died, and TS has thrown its whole arsenal to the ground
 * (TSDropWeaponsOnDeath). What is left of it is the gun in its hands -- whose world model is its
 * player model's, "models/w_" for "models/p_" -- or, with tsrp_roambots_insurgent_drop 0 or after
 * .civilians, nothing.
 */
insurgent_down(id)
{
	new keep[RB_MODEL_LEN];
	keep[0] = 0;
	if (!g_dismissed[id] && get_pcvar_num(g_cv_ins_drop) > 0)
	{
		copy(keep, charsmax(keep), g_held[id]);
		new at = containi(keep, "/p_");
		if (at == -1)
		{
			keep[0] = 0;
		}
		else
		{
			keep[at + 1] = 'w';
		}
	}
	g_dismissed[id] = false;
	new n = take_thrown(id, keep);
	if (get_pcvar_num(g_cv_debug))
	{
		log_amx("[ROAMBOTS] insurgent %d died: %d of its weapons taken off the ground (the one to leave: %s).",
			id, n, keep[0] ? keep : "none");
	}
}

/// An insurgent: the insurgent version of its face, and -- once in each life -- the insurgents' weapons.
make_insurgent(id)
{
	insurgent_face(id);
	if (!g_insurgent[id])
	{
		g_insurgent[id] = true;
		arm_insurgent(id);
		g_n_armed++;
	}
}

/// The insurgent version of a citizen's face, from the pairs; a face with none is kept.
insurgent_face(id)
{
	refresh_insurgent_models();
	for (new i = 0; i < g_ins_count; i++)
	{
		if (equali(g_model_pick[id], g_ins_from[i]))
		{
			copy(g_model_pick[id], RB_NAME_LEN - 1, g_ins_to[i]);
			write_model(id);
			return;
		}
	}
}

/// The insurgent face pairs ("civilian:insurgent", ";" between), parsed again only when their cvar changes.
refresh_insurgent_models()
{
	new now[RB_LIST_LEN];
	get_pcvar_string(g_cv_ins_models, now, charsmax(now));
	if (g_ins_parsed && equal(now, g_ins_models_from))
	{
		return;
	}
	g_ins_parsed = true;
	copy(g_ins_models_from, charsmax(g_ins_models_from), now);
	g_ins_count = 0;
	new piece[2 * RB_NAME_LEN], rest[RB_LIST_LEN], carry[RB_LIST_LEN], from[RB_NAME_LEN], to[RB_NAME_LEN], path[96];
	copy(rest, charsmax(rest), now);
	while (rest[0] && g_ins_count < RB_INS_MAX)
	{
		strtok(rest, piece, charsmax(piece), carry, charsmax(carry), ';', 1);
		copy(rest, charsmax(rest), carry);
		trim(piece);
		if (!piece[0])
		{
			continue;
		}
		strtok(piece, from, charsmax(from), to, charsmax(to), ':', 1);
		trim(from);
		trim(to);
		if (!from[0] || !to[0])
		{
			continue;
		}
		formatex(path, charsmax(path), "models/player/%s/%s.mdl", to, to);
		if (!file_exists(path))
		{
			log_amx("[ROAMBOTS] insurgent model %s is not installed (%s): %s keeps its own face.", to, path, from);
			continue;
		}
		copy(g_ins_from[g_ins_count], RB_NAME_LEN - 1, from);
		copy(g_ins_to[g_ins_count++], RB_NAME_LEN - 1, to);
	}
}

/*
 * The insurgents' weapons: tsrp_roambots_insurgent_weapons, "id:magazines" pairs, "," between, as
 * the match mode's class lines (TS weapon ids, tsconst.inc), given as ts_matchmode arms a player
 * (give_class_weapons): back to front, so the first one listed -- the primary -- is given last and
 * TS leaves it in hand, with room for each set before it is given, and the primary given once
 * more if TS refused it. RCBot fights with the weapon in hand, so the primary is then selected
 * ("weapon_<id>", TS's own select) if it is not held already. ts_giveweapon takes its figure as
 * single rounds, so a gun's spare is set again in magazines once it is in hand; a grenade's or a
 * knife's figure is how many it carries.
 */
arm_insurgent(id)
{
	new list[RB_LIST_LEN], rest[RB_LIST_LEN], carry[RB_LIST_LEN], piece[16], sid[8], sclips[8];
	new wpns[RB_INS_WEAPONS], mags[RB_INS_WEAPONS], count = 0;
	get_pcvar_string(g_cv_ins_weapons, list, charsmax(list));
	copy(rest, charsmax(rest), list);
	while (rest[0] && count < RB_INS_WEAPONS)
	{
		strtok(rest, piece, charsmax(piece), carry, charsmax(carry), ',', 1);
		copy(rest, charsmax(rest), carry);
		trim(piece);
		if (!piece[0])
		{
			continue;
		}
		strtok(piece, sid, charsmax(sid), sclips, charsmax(sclips), ':', 1);
		new wpn = str_to_num(sid), clips = str_to_num(sclips);
		if (wpn < 1 || wpn > RB_TSW_LAST || clips < 0)
		{
			continue;
		}
		wpns[count] = wpn;
		mags[count++] = clips;
	}

	new clip, ammo, mode, extra;
	for (new i = count - 1; i >= 0; i--)
	{
		// TS refuses a weapon its carried-weight count has no room for; raised before each give,
		// as the match mode does
		ts_setuserslots(id, 999);
		new gave = ts_giveweapon(id, wpns[i], mags[i], 0);
		if (!gave && i == 0)
		{
			// the primary, given last and so the one TS is likeliest to refuse: once more
			ts_setuserslots(id, 999);
			gave = ts_giveweapon(id, wpns[i], mags[i], 0);
		}
		if (!gave)
		{
			continue;
		}
		if (mags[i] > 0 && is_gun(wpns[i]) && ts_getuserwpn(id, clip, ammo, mode, extra) == wpns[i] && clip > 0)
		{
			ts_setuserammo(id, wpns[i], mags[i] * clip);
		}
	}

	if (count > 0 && ts_getuserwpn(id, clip, ammo, mode, extra) != wpns[0])
	{
		new cmd[16];
		formatex(cmd, charsmax(cmd), "weapon_%d", wpns[0]);
		engclient_cmd(id, cmd);
	}
}

/// Whether a TS weapon id is a gun, whose spare comes in magazines (not a grenade, knife, katana or the briefcase).
bool:is_gun(wpn)
{
	switch (wpn)
	{
		case TSW_M61GRENADE, TSW_CKNIFE, TSW_C4, TSW_KATANA, TSW_SKNIFE, TSW_TKNIFE:
		{
			return false;
		}
	}
	return true;
}

/*
 * .insurgency and .civilians in chat (INSURGENCY, above), for a player with the admin flags of
 * tsrp_roambots_admin_flag (empty: anyone), on a roleplay map whose citizens are out and whose
 * mapconfig leaves tsrp_roambots_commands on.
 */
public hook_say(id)
{
	new args[32];
	read_args(args, charsmax(args));
	remove_quotes(args);
	trim(args);

	new bool:rise = equali(args, ".insurgency") != 0;
	if (!rise && !equali(args, ".civilians"))
	{
		return PLUGIN_CONTINUE;
	}
	cmd_insurgency(id, rise);
	return PLUGIN_HANDLED;
}

cmd_insurgency(id, bool:rise)
{
	if (!is_user_connected(id))
	{
		return;
	}
	new flag[8];
	get_pcvar_string(g_cv_admin_flag, flag, charsmax(flag));
	trim(flag);
	if (flag[0] && !(get_user_flags(id) & read_flags(flag)))
	{
		client_print(id, print_chat, "[CITY] Only an admin can %s.", rise ? "start an insurgency" : "end the insurgency");
		return;
	}
	if (get_pcvar_num(g_cv_commands) <= 0)
	{
		client_print(id, print_chat, "[CITY] .insurgency and .civilians are switched off on this map.");
		return;
	}
	if (!g_active)
	{
		client_print(id, print_chat, "[CITY] There are no citizens on this map.");
		return;
	}
	new name[32];
	get_user_name(id, name, charsmax(name));
	if (rise)
	{
		if (insurgency())
		{
			client_print(id, print_chat, "[CITY] The citizens are insurgents already. .civilians ends it.");
			return;
		}
		set_pcvar_num(g_cv_insurgency, 1);
		new n = insurgency_due();
		pace_insurgency();
		log_amx("[ROAMBOTS] %s started an insurgency on %s: %d citizens take up arms, one every %.2f seconds.",
			name, g_mapname, n, RB_PACE_STEP);
		client_print(0, print_chat, "[CITY] Insurgency! The citizens are taking up arms.");
	}
	else
	{
		if (!insurgency())
		{
			client_print(id, print_chat, "[CITY] The citizens are civilians already.");
			return;
		}
		set_pcvar_num(g_cv_insurgency, 0);
		new n = insurgency_due();
		pace_insurgency();
		log_amx("[ROAMBOTS] %s ended the insurgency on %s: %d insurgents put down, one every %.2f seconds, to come back as citizens.",
			name, g_mapname, n, RB_PACE_STEP);
		client_print(0, print_chat, "[CITY] The insurgency is over: the citizens lay down their arms.");
	}
}

/*
 * HOSTILITY (HOSTILITY ENDS WITH THE LIFE, above). g_host_hurt[citizen][player] is when that player
 * last hurt that citizen, 0.0 when he has not in this life of both. It mirrors what RCBot holds for
 * the citizens, which is the player behind pev dmg_inflictor when a citizen's health falls.
 */
hostile_reset()
{
	for (new c = 0; c < RB_SLOTS; c++)
	{
		for (new p = 0; p < RB_SLOTS; p++)
		{
			g_host_hurt[c][p] = 0.0;
		}
		g_c_health[c] = 0.0;
		g_replace_due[c] = false;
		g_p_seen[c] = false;
		g_p_alive[c] = false;
		g_p_team[c] = 0;
		g_p_class[c] = 0;
	}
}

/// The real player behind what hurt a citizen -- the entity itself, or whoever owns it (a grenade, a
/// thrown blade) -- or 0: the world, a bot, nobody alive.
hostile_attacker(ent)
{
	if (ent < 1 || !pev_valid(ent))
	{
		return 0;
	}
	new who = ent;
	if (who > g_maxplayers)
	{
		who = pev(ent, pev_owner);
	}
	if (who < 1 || who > g_maxplayers || !is_user_connected(who) || is_user_bot(who) || !is_user_alive(who))
	{
		return 0;
	}
	return who;
}

/// A living citizen, every frame: a fall in its health is the last damage's player (when there is one) hurting it.
hostile_citizen_frame(id)
{
	new Float:hp = Float:pev(id, pev_health);
	new Float:was = g_c_health[id];
	g_c_health[id] = hp;
	if (was <= 0.0 || hp >= was || get_pcvar_num(g_cv_defend) <= 0)
	{
		return;
	}
	new who = hostile_attacker(pev(id, pev_dmg_inflictor));
	if (!who)
	{
		return;
	}
	if (g_host_hurt[id][who] <= 0.0)
	{
		g_n_host_set++;
		if (get_pcvar_num(g_cv_debug))
		{
			new cname[RB_NAME_LEN], pname[RB_NAME_LEN];
			get_user_name(id, cname, charsmax(cname));
			get_user_name(who, pname, charsmax(pname));
			log_amx("[ROAMBOTS] citizen %d (%s) is hostile to player %d (%s): he hurt it.", id, cname, who, pname);
		}
	}
	g_host_hurt[id][who] = get_gametime();
}

/// A citizen back on its feet: nobody has hurt this life.
hostile_new_life(id)
{
	for (new p = 1; p <= g_maxplayers; p++)
	{
		if (g_host_hurt[id][p] > 0.0)
		{
			g_host_hurt[id][p] = 0.0;
			g_n_host_ended++;
		}
	}
	g_replace_due[id] = false;
	g_c_health[id] = Float:pev(id, pev_health);
}

/// A citizen that is no longer one (kicked, or a real player now).
hostile_citizen_gone(id)
{
	for (new p = 1; p <= g_maxplayers; p++)
	{
		g_host_hurt[id][p] = 0.0;
	}
	g_replace_due[id] = false;
	g_c_health[id] = 0.0;
}

/// A real player, every frame: a new life, a new team or a new class ends the hostility of the citizens against him
/// (pev team and pev playerclass change only where something writes them).
hostile_player_frame(id)
{
	new bool:alive = is_user_alive(id) != 0;
	new team = pev(id, pev_team);
	new pclass = pev(id, pev_playerclass);
	if (!g_p_seen[id])
	{
		g_p_seen[id] = true;
		g_p_alive[id] = alive;
		g_p_team[id] = team;
		g_p_class[id] = pclass;
		return;
	}
	if (team != g_p_team[id] || pclass != g_p_class[id])
	{
		g_p_team[id] = team;
		g_p_class[id] = pclass;
		hostile_end(id, "changed team or class", true);
	}
	if (alive && !g_p_alive[id])
	{
		hostile_end(id, "is back on his feet", true);
	}
	g_p_alive[id] = alive;
}

/// A slot is being emptied (FM_ClientDisconnect: AMXX's own disconnect forward does not run on every engine).
public fw_client_disconnect(id)
{
	if (id < 1 || id > g_maxplayers)
	{
		return FMRES_IGNORED;
	}
	hostile_end(id, "left the server", false);
	hostile_citizen_gone(id);
	g_p_seen[id] = false;
	g_p_alive[id] = false;
	return FMRES_IGNORED;
}

/*
 * Ends every citizen's hostility toward a player and, with act and tsrp_rb_forget_cmd, tells RCBot
 * (1) or replaces each citizen that was hostile to him (2). Returns how many citizens were hostile.
 */
hostile_end(player, const why[], bool:act)
{
	new n = 0;
	new bool:replace = act && g_active && get_pcvar_num(g_cv_forget_cmd) == 2;
	for (new c = 1; c <= g_maxplayers; c++)
	{
		if (g_host_hurt[c][player] > 0.0)
		{
			g_host_hurt[c][player] = 0.0;
			n++;
			if (replace && g_citizen[c] && is_user_connected(c))
			{
				replace_citizen(c);
			}
		}
	}
	if (!n)
	{
		return 0;
	}
	g_n_host_ended += n;
	if (get_pcvar_num(g_cv_debug))
	{
		new pname[RB_NAME_LEN];
		get_user_name(player, pname, charsmax(pname));
		log_amx("[ROAMBOTS] player %d (%s) %s: %d citizen(s) hostile to him in the record ended%s.", player, pname, why, n,
			act ? "" : " (nothing to tell RCBot)");
	}
	if (act)
	{
		forget_player(player);
	}
	return n;
}

/// Once a second: a record row older than tsrp_roambots_defend_time since the last blow is over (RCBot has let him go by then).
hostile_expire()
{
	new Float:limit = get_pcvar_float(g_cv_defend_time);
	if (limit <= 0.0)
	{
		limit = RB_DEFEND_TIME_DEFAULT;
	}
	new bool:forgive = get_pcvar_num(g_cv_forgive) > 0;
	new bool:replace = forgive && get_pcvar_num(g_cv_forget_cmd) == 2;
	new Float:now = get_gametime();
	for (new p = 1; p <= g_maxplayers; p++)
	{
		new bool:ended = false;
		for (new c = 1; c <= g_maxplayers; c++)
		{
			if (g_host_hurt[c][p] > 0.0 && now - g_host_hurt[c][p] > limit)
			{
				g_host_hurt[c][p] = 0.0;
				g_n_host_ended++;
				ended = true;
				if (replace && g_citizen[c] && is_user_connected(c))
				{
					replace_citizen(c);
				}
			}
		}
		if (ended)
		{
			if (get_pcvar_num(g_cv_debug))
			{
				log_amx("[ROAMBOTS] player %d: a citizen was not hurt by him for %.0f seconds, so its record of him ended.", p, limit);
			}
			if (forgive)
			{
				forget_player(p);
			}
		}
	}
}

/// "rcbot roamforget <player>" (tsrp_rb_forget_cmd 1): every citizen that holds him for its attacker drops him. An RCBot
/// build without the command prints that it does not exist.
forget_player(player)
{
	if (!g_active || get_pcvar_num(g_cv_forget_cmd) != 1)
	{
		return;
	}
	server_cmd("rcbot roamforget %d", player);
	g_n_forget_cmds++;
}

/// tsrp_rb_forget_cmd 2: a citizen that was hostile to a player is to leave (replace_flush sends it away).
replace_citizen(c)
{
	g_replace_due[c] = true;
}

/// Once a second: each citizen due to leave goes when no real player has it in sight (as cmd_unstick waits); keep_count brings in another.
replace_flush()
{
	for (new c = 1; c <= g_maxplayers; c++)
	{
		if (!g_replace_due[c])
		{
			continue;
		}
		if (!g_citizen[c] || !is_user_connected(c))
		{
			g_replace_due[c] = false;
			continue;
		}
		if (is_user_alive(c) && seen_by_person(c))
		{
			continue;
		}
		g_replace_due[c] = false;
		g_n_replaced++;
		if (get_pcvar_num(g_cv_debug))
		{
			log_amx("[ROAMBOTS] citizen %d is sent away and replaced.", c);
		}
		server_cmd("kick #%d", get_user_userid(c));
		forget(c);
	}
}

/// tsrp_rb_forgive_seconds above 0 is tsrp_roambots_defend_time (RCBot reads it once a second); at 0 the setting is what it was.
forgive_sync()
{
	new secs = get_pcvar_num(g_cv_forgive);
	if (secs <= 0)
	{
		forgive_restore();
		return;
	}
	if (!g_df_set)
	{
		g_df_set = true;
		g_df_saved = get_pcvar_float(g_cv_defend_time);
	}
	if (get_pcvar_float(g_cv_defend_time) != float(secs))
	{
		set_pcvar_float(g_cv_defend_time, float(secs));
	}
}

/// tsrp_roambots_defend_time as it was before tsrp_rb_forgive_seconds.
forgive_restore()
{
	if (!g_df_set)
	{
		return;
	}
	g_df_set = false;
	set_pcvar_float(g_cv_defend_time, g_df_saved);
}

/// amx_roamhostile: the plugin's record of which citizen is hostile to which player, and when it ends.
public cmd_hostile(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	console_print(id, "[ROAMBOTS] %s %s: hostility on %s.", PLUGIN, VERSION, g_mapname);
	if (!g_rp_map)
	{
		console_print(id, "  not a roleplay map (the plugin does nothing here)");
		return PLUGIN_HANDLED;
	}

	new Float:limit = get_pcvar_float(g_cv_defend_time);
	if (limit <= 0.0)
	{
		limit = RB_DEFEND_TIME_DEFAULT;
	}
	new how[40];
	switch (get_pcvar_num(g_cv_forget_cmd))
	{
		case 1: copy(how, charsmax(how), "rcbot roamforget");
		case 2: copy(how, charsmax(how), "the citizen is replaced");
		default: copy(how, charsmax(how), "nothing beyond RCBot's own rules");
	}
	console_print(id, "  the plugin's record, inferred from a citizen's health and the inflictor of its last damage; RCBot's own is not readable from here");
	console_print(id, "  RCBot ends it itself at the player's death and after defend_time only in an rcbot_mm.dll built from the CHANGE 8 source with tsrp_roambots_defend_time");
	console_print(id, "  defend %d  defend_time %.0f s  forgive %d s  insurgency %d (team %d: while it lasts every such player is hostile to every citizen)  at a new life: %s",
		get_pcvar_num(g_cv_defend), limit, get_pcvar_num(g_cv_forgive), get_pcvar_num(g_cv_insurgency),
		get_pcvar_num(g_cv_ins_team), how);

	new cname[RB_NAME_LEN], pname[RB_NAME_LEN], rows = 0;
	new Float:now = get_gametime();
	for (new c = 1; c <= g_maxplayers; c++)
	{
		if (!g_citizen[c] || !is_user_connected(c))
		{
			continue;
		}
		for (new p = 1; p <= g_maxplayers; p++)
		{
			if (g_host_hurt[c][p] <= 0.0 || !is_user_connected(p))
			{
				continue;
			}
			get_user_name(c, cname, charsmax(cname));
			get_user_name(p, pname, charsmax(pname));
			new Float:ago = now - g_host_hurt[c][p];
			new Float:remain = limit - ago;
			console_print(id, "  citizen #%2d %-20s -> player #%2d %-20s  last hurt %.1f s ago, %s  ends at his next life, or in %.0f s",
				c, cname, p, pname, ago, is_user_alive(p) ? "alive" : "dead", remain < 0.0 ? 0.0 : remain);
			rows++;
		}
	}
	if (!rows)
	{
		console_print(id, "  no citizen is hostile to any player.");
	}
	return PLUGIN_HANDLED;
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
	new flag[8];
	get_pcvar_string(g_cv_admin_flag, flag, charsmax(flag));
	console_print(id, "  defend %d (%d s)  talk %d pct within %d  murmurs %d installed  insurgency %d (team %d, drop %d)  commands %d (flag %s)",
		get_pcvar_num(g_cv_defend), get_pcvar_num(g_cv_defend_time), get_pcvar_num(g_cv_talk),
		get_pcvar_num(g_cv_talk_range), g_murmur_count, get_pcvar_num(g_cv_insurgency), get_pcvar_num(g_cv_ins_team),
		get_pcvar_num(g_cv_ins_drop), get_pcvar_num(g_cv_commands), flag[0] ? flag : "none");
	console_print(id, "  unstick asked %d  seen, so waited %d  moved %d  talks %d  murmurs %d  armed %d  put down %d%s",
		g_n_unstick_asked, g_n_unstick_seen, g_n_unstuck, g_n_talks, g_n_murmurs, g_n_armed, g_n_disarmed,
		task_exists(RB_TASK_PACE) ? "  (the insurgency's pace is running)" : "");
	console_print(id, "  thrown guns left on the ground because TS had slowed them %d", g_n_left_slowed);
	console_print(id, "  +use: %s, cooldown %d s, murmured to players %d",
		get_pcvar_num(g_cv_use) > 0 ? "on" : "off", get_pcvar_num(g_cv_use_cooldown), g_n_heeds);
	console_print(id, "  hostility: marked %d  ended %d  roamforget sent %d  citizens replaced %d  (amx_roamhostile)",
		g_n_host_set, g_n_host_ended, g_n_forget_cmds, g_n_replaced);

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
		console_print(id, "  #%2d %-20s %-20s %-6s %-12s %5d %5d %5d  speed %d%s%s", c, name, live,
			is_user_alive(c) ? "alive" : "dead", d >= 0 ? g_district[d] : "-",
			floatround(at[0]), floatround(at[1]), floatround(at[2]), floatround(vector_speed(c)),
			g_insurgent[c] ? "  insurgent" : "", g_talk_with[c] ? "  talking" : (g_heed_with[c] ? "  facing a player" : ""));
	}
	return PLUGIN_HANDLED;
}

Float:vector_speed(id)
{
	new Float:v[3];
	pev(id, pev_velocity, v);
	return floatsqroot(v[0] * v[0] + v[1] * v[1]);
}
