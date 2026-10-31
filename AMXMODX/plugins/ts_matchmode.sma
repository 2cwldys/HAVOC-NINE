/*
 * ts_matchmode.sma -- team elimination match mode for The Specialists 3.0
 *
 * TS is deathmatch with infinite respawn and no round concept. This adds:
 * warmup -> ready-up -> best-of-X rounds -> match end, where a round ends when one
 * team has nobody left alive.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTE -- why this does NOT use observer mode
 *
 * The obvious way to hold a player out of a round is to make them a spectator.
 * Testing on TS showed that writing pev_iuser1 makes the mod reclassify the player
 * as a spectator and MOVE THEM OFF THEIR TEAM, with no reliable way to put them
 * back. That breaks alive-counting, team chat and the scoreboard at once.
 *
 * So nothing here ever touches iuser1. An eliminated player is left exactly as TS
 * made them -- alive, on their own team -- and is instead REMOVED FROM PLAY:
 * teleported to a holding spot, hidden, made non-solid and immune, and frozen.
 * Following a teammate is done by moving their view, not by spectating.
 *
 * The cost is that they are technically "alive"; the benefit is that the mod never
 * fights us and nobody ever loses their team.
 * ---------------------------------------------------------------------------
 *
 * Modules: amxmodx, amxmisc, fakemeta, fun, tsfun, newmenus, file and hamsandwich.
 * All REQUIRED -- hamsandwich and tsfun must both be listed in modules.ini or this
 * plugin will not load. (It began as fakemeta-only and that is no longer true.)
 *
 * Written deliberately conservatively for a strict compiler: explicit Float: tags on
 * float entvars, braces on every block, and no backslash escapes in strings.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <fun>
#include <tsfun>
#include <newmenus>
#include <file>

/*
 * Required, not optional.
 *
 * Friendly fire used to be undone from register_event("Damage"), which is driven
 * by the network message sent to the damaged CLIENT. A bot is a fake client and is
 * sent no messages at all, so that handler never fired once for a bot victim --
 * bot-on-bot friendly fire was completely unprotected for the entire life of this
 * plugin, which is why bots kept killing their own side.
 *
 * Ham_TakeDamage is the game DLL's own function. It fires for everyone, bots
 * included, and it can refuse the damage outright instead of handing it back
 * afterwards.
 *
 * hamsandwich must be listed in addons/amxmodx/configs/modules.ini or this plugin
 * will not load.
 */
#include <hamsandwich>

/*
 * The mode API this plugin offers to the mode plugins (ts_uplink, ts_survival): the claim
 * flags and the match states, shared from one file. TSM_CORE keeps its native and forward
 * declarations out -- this plugin is the one that provides them. build.bat syncs the file
 * into scripting\include before compiling.
 */
#define TSM_CORE
#include <tsm_api>

#define PLUGIN  "TS Match Mode"
#define VERSION "0.7"
#define AUTHOR  "tsm"

#define MAXPL 33

// Bumped on every change. amx_tsm_debug prints it, so there is never any doubt about
// which build is actually loaded -- which has already cost us two rounds of chasing
// symptoms that were fixed in source but not on the server.
#define TSM_BUILD "1.54-lift3"

/*
 * The class icon sheet: one 64x64 frame per class, in class order.
 *
 * Built for this plugin rather than borrowed, because nothing installed with TS
 * reads as an icon -- its sprites are all effects. VP_PARALLEL, so a frame above a
 * head faces the viewer from any angle, and SPR_ALPHTEST for a hard edge.
 *
 * It is precached, so CLIENTS NEED THE FILE. With sv_allowdownload on they fetch it
 * from the server on connect; a fastdl host serves it faster. A client without it
 * draws nothing where the icon should be.
 */
#define TSM_ICON_SPR "sprites/tsm_class.spr"

/*
 * WHICH FRAME OF THE SHEET IS EACH CLASS'S INSURGENT COPY.
 *
 * Frames 0 upwards are the classes as the MSR wear them, one per class in class order. After
 * them come RED copies of the ones that have two colours. This table says which frame holds each
 * class's red copy, and -1 says that class has only the one icon.
 *
 * EVERY class is doubled, the Medic and the Officer included. They were bone and amber and
 * single, on the reasoning that a role-colour beats a side-colour. Sudden death broke that: the
 * marker shown to the other side is always the red copy, so a class without one fell back to its
 * ordinary icon and an ENEMY medic was drawn exactly like a friendly one, in the one minute of
 * the round when telling them apart matters most. The SHAPE carries the role -- a cross is a
 * cross -- so the colour is free to carry the side.
 *
 * IT IS A TABLE AND NOT AN OFFSET, and that is the whole point. It used to be
 * `TSM_ICON_RED + ci`, which only holds while every two-colour class comes before every
 * one-colour one. The moment Recon and Mech were added after Medic and Officer that stopped
 * being true, and because nothing bounded `ci`, Recon was being shown the red Assault chevrons
 * and Mech a red gear. Restoring the old prefix would have meant renumbering tsm_class5..9 in
 * the cfg, which the cfg itself warns against; nine numbers here cost nothing and let a class be
 * added anywhere, in either one colour or two.
 *
 * make-class-sprite.mjs PRINTS THIS LINE when it builds the sheet. Paste what it prints.
 */
new const TSM_ICON_RED_OF[] = { 9, 10, 11, 12, 13, 14, 15, 16, 17 };

/** The frame `ci` should wear on `team`, or -1 when that class has no icon at all. */
stock icon_frame_for(ci, team)
{
	if (ci < 0 || ci >= sizeof(TSM_ICON_RED_OF))
	{
		return -1;
	}
	if (team == 2 && TSM_ICON_RED_OF[ci] >= 0)
	{
		return TSM_ICON_RED_OF[ci];
	}
	return ci;
}

#define TSM_ARM_CASH 32000

/*
 * pev->deadflag, from the HL SDK. Anything other than DEAD_NO means TS is partway
 * through killing this player and owns the entity until it is finished.
 *
 *   0 DEAD_NO   1 DEAD_DYING   2 DEAD_DEAD   3 DEAD_RESPAWNABLE   4 DEAD_DISCARDBODY
 */
#define TSM_DEAD_NO 0
#define TSM_DEAD_DYING 1
#define TSM_DEAD_DEAD 2

/* ---- match states ------------------------------------------------------- */
#define ST_WARMUP    0
#define ST_READYUP   1
#define ST_FREEZE    2
#define ST_LIVE      3
#define ST_ROUNDEND  4
#define ST_MATCHEND  5

/* ---- mech sounds, folded in from the old mech_footsteps plugin -------------
   mechwalk / mechwalk2 alternate on footsteps; mechloop is the idle hum under
   every living mech. All three live in ts\sound\ and are precached for clients.
*/
#define MECH_STEP_1     "mechwalk.wav"
#define MECH_STEP_2     "mechwalk2.wav"
#define MECH_LOOP       "mechloop.wav"
// A mech's stunts: the hydraulic surge as it leaps, the stomp and the clank as it comes down. Stock Half-Life.
#define MECH_LEAP       "ambience/loader_hydra1.wav"
#define MECH_LAND       "garg/gar_step1.wav"
#define MECH_LAND2      "ambience/loader_step1.wav"
// The Combat Engineer's sentry turret: Natural Selection's b_sentry, baked in each side's colour.
#define TSM_TURRET_MAX     8
#define TSM_TURRET_NAME    "tsm_turret"
#define TSM_TURRET_MDL_1   "models/tsm_turret_blue.mdl"
#define TSM_TURRET_MDL_2   "models/tsm_turret_red.mdl"
#define TSM_TURRET_PING    "turret/turret_ping.wav"
#define TSM_TURRET_DEPLOY  "turret/turret_deploy.wav"
#define TSM_TURRET_BOOM    "sprites/zerogxplode.spr"
#define TSM_TASK_TURRET    90510
// Its sequences, by number as the model keeps them.
#define TURRET_SEQ_IDLE    0
#define TURRET_SEQ_FIRE    1
#define TURRET_SEQ_SPIN    2
#define TURRET_SEQ_DEPLOY  3
#define TURRET_SEQ_DIE     5
// Where the model's gun is, in its body's own space: the head turns about an upright TURRET_AXIS_X in
// front of its origin; the gun tips about a point TURRET_PIVOT_BACK behind that axis, TURRET_GUN_Z up;
// the barrels end TURRET_BARREL out from there along the aim.
#define TURRET_AXIS_X      2.5
#define TURRET_PIVOT_BACK  2.7
#define TURRET_GUN_Z       42.8
#define TURRET_BARREL      22.3
// TS's stunt bits in pev_iuser4 (reTS ts_stunt.h): dive, cartwheels, wall-jump and wall-climb launching or under
// way, and the landing roll.
#define TSM_STUNT_BITS  (0x000010 | 0x000c00 | 0x007000 | 0x008000 | 0x010000 | 0x020000 | 0x040000)
// The idle hum is background, not an event: keep it well under footsteps and gunfire.
// The pilot hears the world emit AND their own 2D copy, so the two together are
// deliberately quieter than the old single 0.8 world emit.
#define MECH_LOOP_VOL   0.2
#define MECH_LOOP_PILOT_VOL 0.1     // pilot's own client-side copy, on top of the world emit
#define MECH_LOOP_ATTEN ATTN_NORM   // mid range
#define MECH_LOOP_PERIOD 2.2        // wav is 2.250 s; re-emit 50 ms early
#define TSM_M60_WPN     32          // TSW_M60E3, the M60 the Heavy and the Mech carry
// The pilot hears their own mech through playvol on their own client. The
// server's emit_sound for the player's own entity is what the client's local
// prediction also drives, and the two fight for the same channels -- so a
// certainty path for the person wearing the machine, one client command for
// the sound they are owed, on top of the world copy everyone else gets.

/* ---- entvar values we set (own names: the includes may already define these,
        and this compiler objects to redefinition) ---------------------------- */
#define TSM_SOLID_NOT        0
#define TSM_SOLID_BBOX       2

/*
 * What a live player must be.
 *
 * SOLID_BBOX collides but does not SLIDE along surfaces, so a player restored to it
 * jams against the floor: the engine keeps applying velocity and they never
 * translate. That reads in-game as being frozen, which is why it survived three
 * rounds of fixes aimed at the hold. Players are SOLID_SLIDEBOX; only brushes and
 * props are SOLID_BBOX.
 */
#define TSM_SOLID_SLIDEBOX   3
#define TSM_MOVETYPE_NONE    0
#define TSM_MOVETYPE_WALK    3
#define TSM_MOVETYPE_NOCLIP  8
#define TSM_EF_NODRAW        128
#define TSM_EF_DIMLIGHT      8     // player flashlight (hlsdk_const.inc: EF_DIMLIGHT)

// Human hull for TraceHull (hlsdk_const.inc: HULL_HUMAN = 1)
#define TSM_HULL_HUMAN       1
// Personal-space push / unstick reach and speed
#define TSM_UNSTICK_REACH    56.0
#define TSM_PUSH_SPEED       260.0
// How long a squad bot may stay beyond tsm_squad_dist before the follow loop itself
// warps it back into formation. Velocity steering alone loses the tug of war with
// rcbot over anything longer than the shortest catch-up, so the leash is what keeps
// .follow looping instead of leaving strays across the map.
#define TSM_SQUAD_LEASH      5.0

#define TSM_DAMAGE_NO        0.0
#define TSM_DAMAGE_AIM       2.0

// Mech .rocket ability constants
#define TSM_MECH_ROCKET_COOLDOWN   30.0   // seconds between rockets
#define TSM_MECH_ROCKET_MAX_USES   4      // max rockets per life
#define TSM_MECH_ROCKET_DAMAGE_MIN 50.0   // minimum AoE damage
#define TSM_MECH_ROCKET_DAMAGE_MAX 65.0   // maximum AoE damage
#define TSM_MECH_ROCKET_RADIUS     150.0  // explosion radius
#define TSM_MECH_ROCKET_RANGE      2000.0 // max distance to target

// Engine-level freeze (bit 12, the real FL_FROZEN). Confirmed from reTS pm_shared.cpp:
// it suppresses footstep/jump sounds and zeroes the WASD-derived movement command in
// PM_CheckParamters -- it does NOT stop gravity, the jump impulse, or
// PM_CheckStuck/PM_TryToUnstuck's own origin-snap. So it is not a substitute for the
// maxspeed clamp that actually holds movement, nor for explicitly managing velocity --
// see apply_freeze() and release_player(). Costs nothing to also set and clear, which
// is the only reason it is still here. Previously defined as 67108864 (bit 26), which is
// the engine's real FL_SPECTATOR, not FL_FROZEN -- every held player, bot or human, was
// being tagged a spectator for the duration (confirmed consequence: AddToFullPack refuses
// to network a FL_SPECTATOR entity to other clients at all while it's set).
#define TSM_FL_FROZEN        4096
// Real FL_KILLME is bit 30 ("marked for death -- allows the engine to kill ents at the
// appropriate time"); bit 29 is FL_CUSTOMENTITY, an inert flag for this purpose. Was
// 536870912 (bit 29) -- task_clean_drops() was tagging dropped weapons with a flag that
// does nothing, so the engine never actually removed them.
#define TSM_FL_KILLME        1073741824

// kRenderTransTexture with zero alpha. EF_NODRAW alone was not making players
// invisible in TS, so the hide applies both.
#define TSM_RENDER_NORMAL    0
#define TSM_RENDER_TEXTURE   2

// One player hull width. Spawn points this close to a body are "occupied":
// pick_spawn_point refuses them, and the warmup spread measures them.
#define TSM_SPAWN_CLEARANCE  64.0

/*
 * TS stores a player's team name with strncpy(dst, src, 16) into a 16-byte buffer.
 * At exactly 16 characters there is no room for the terminator, the stored name runs
 * past its end, and every later comparison against it fails -- the mod then treats the
 * player as being on no valid team and shows them as a spectator with no team model.
 *
 * "insurrectionists" is exactly 16. That is why that side could never be joined by
 * anyone, human or bot, regardless of which command was used to try.
 */
#define TSM_MAX_TEAMNAME     15

#define TSM_MAXCLASS         10

/*
 * How much room a class's model list gets.
 *
 * ONE SIDE'S comma-separated list, and the whole team1|team2 field that holds two of
 * them. These were 96 everywhere, which was comfortable until the insurgent Assault
 * pool grew to five names and landed on EXACTLY 96 characters -- and a Pawn [96] holds
 * 95 plus the terminator, so the last model silently lost its final letter and every
 * player who rolled it fell back to TS's default. Nothing errors; the name is simply
 * wrong by one character.
 *
 * Raised a THIRD time for the engineer: seven weathered RepuHeavyGld variants beside
 * RepuHeavyGld and scda_Spy02 come to 161, two over the old 159. Two characters is not
 * a reason to quietly drop somebody's model from a pool.
 *
 * Raised a second time when a seventh insurgent Assault model took the list to exactly
 * 127, which a [128] holds with nothing to spare -- the same knife edge as before, one
 * character from silently dropping a name again.
 *
 * At seven names the PARSER'S GUARD OF 8 is now the binding limit rather than this
 * buffer. One more model on a side and the loops in precache_models_in_spec and in the
 * precache walk have to come up with it, or the extra name is simply never read.
 */
/*
 * How much room a WHOLE class line gets, and the config line that carries it.
 *
 * These are a separate limit from TSM_MODELLIST and the easier one to overrun, because
 * a spec holds BOTH sides' model lists plus the name, two weapon lists, health, armour,
 * perk and speed. Class 1 reached 207 of the old 223 with five models a side -- sixteen
 * characters from silently losing the end of the line, and a truncated spec does not
 * warn, it hands the picker half a model name.
 *
 * TSM_LINE must stay ahead of TSM_SPEC: the file line is the spec plus `tsm_classN "`
 * and its closing quote.
 */
#define TSM_SPEC            320
#define TSM_LINE            384

/*
 * How many models one side of one class may list.
 *
 * The parser walked the list with a bare `guard < 8`, which is not a check but a stop:
 * a ninth name is simply never read, with nothing said. The medic's side reaches eight
 * exactly once its damaged variants go in, so the next addition anywhere would have
 * vanished -- the same silent-truncation shape as the buffers above, in a different
 * disguise.
 */
#define TSM_MAXMODELS        12
/*
 * The hard edge of TS's own corpse schedule: its think calls UTIL_Remove at ten seconds.
 * Settling past this does not hold a corpse for longer, it loses it -- TS deletes the body
 * before we ever take it over. Hence a ceiling slightly inside it.
 */
/// What our own copies of TS's bodies are called, so they can be found again.
#define TSM_CORPSE_CLASS     "tsm_corpse"

#define TSM_MODELLIST       224
#define TSM_MODELFIELD      344
#define TSM_MAXWPN           6
// The class perks (TSM_PERK_*) are in include\tsm_api.inc, which mode plugins share.

// The regeneration tick's task id. A server-wide task, so it needs an id that cannot
// collide with the per-player ones, which are all a player index plus a round
// thousand (1000 through 8000).
#define TSM_TASK_REGEN       90210

// Ambient music queue, server-wide, so it needs an id of its own as well.
#define TSM_TASK_MUSIC       90211

// The siege alarm siren's one server-wide loop beat; a round holds exactly one
// of these running, never a second stacked onto it.
#define TSM_TASK_ALARM       90212
#define TSM_TASK_BOTFILL     90213

// The staggered bot kicks: one task per bot, at this plus the bot's index, so the
// band 90401-90432 is theirs and no server-wide id below may fall inside it.
#define TSM_TASK_BOTKICK     90400

// The planted satchel's one fuse beat: as with the alarm, one objective holds
// the chain at a time, so one server-wide task id is the whole mechanism.
#define TSM_TASK_CHARGE      90300

// The round-start anthems' one server-wide tick: fired one second into every
// round, removed first whenever a round starts or the match tears down, so a
// halted round's anthem never rings over live play.
#define TSM_TASK_SONGS       90214

// The Insurgent roar's one server-wide tick: four seconds after their anthem,
// one task a round, removed at every round start with the anthems'.
#define TSM_TASK_ROAR        90215

// The MSR badum's one server-wide tick: same 5.0s timing as the roar (1.0s anthem + 4s).
#define TSM_TASK_BADUM       90216
#define TSM_TASK_WAVE        90217   // respawn wave clock: one tick a second while live
#define TSM_REVIVE_HOLD      15.0    // longest a wave keeps asking TS to respawn someone before it refuses them
#define TSM_TASK_REVIVE      16000   // one pending revive per player: 16000 + id
#define TSM_TASK_REVIVE_ARM  17000   // a wave revive's gear, once the spawn has settled: 17000 + id

// Forward declarations for functions used before definition
forward disband_squad(leader);
forward squad_size(leader);

/*
 * SIEGE OBJECTIVE BASICS, this far up because the map recorder below snapshots
 * the objective bodies at load and needs the prefix and the cap. The rest of
 * the siege constants sit with the siege system itself.
 */
#define TSM_OBJ_PREFIX "tsm_obj_"
#define TSM_OBJ_MAX    9

/*
 * THE OBJECTIVE BODY CACHE.
 *
 * A func_breakable that is destroyed is DELETED from the world outright, and
 * nothing in HL resurrects an entity -- so whichever round broke objective N
 * would leave every round after it nothing to aim at. The recorder keeps what
 * a body needs to exist again (its class, its brush model, the health and
 * spawnflags the mapper gave it, the fall target, where it stood and how it was
 * drawn), and siege_reset() spawns any missing body back at every round start.
 */
new g_obj_class[TSM_OBJ_MAX + 1][32];     // original entity class
new g_obj_model[TSM_OBJ_MAX + 1][16];     // brush model string, "*NN"
new Float:g_obj_health[TSM_OBJ_MAX + 1];  // the mapper's own health value
new g_obj_spawnflags[TSM_OBJ_MAX + 1];    // the mapper's own spawnflags key
new g_obj_target[TSM_OBJ_MAX + 1][64];    // what the fall fired (the spectacle)
new Float:g_obj_origin[TSM_OBJ_MAX + 1][3];      // where it stood (an origin brush moves it off zero)
new Float:g_obj_angles[TSM_OBJ_MAX + 1][3];
new g_obj_rendermode[TSM_OBJ_MAX + 1];           // how the mapper had it drawn
new Float:g_obj_renderamt[TSM_OBJ_MAX + 1];
new Float:g_obj_rendercolor[TSM_OBJ_MAX + 1][3];
new g_obj_renderfx[TSM_OBJ_MAX + 1];
new Float:g_plant_snd_at[TSM_OBJ_MAX + 1];       // when each objective last played the plant sound

// Glow shell, for the medic's heal. renderfx is a separate field from rendermode,
// so this does not disturb the hide that runs off rendermode and renderamt.
//
// 19 is kRenderFxGlowShell. It is NOT 3 -- 3 is kRenderFxPulseSlowWide, a subtle
// brightness pulse that looks like nothing at all, which is what the first attempt
// at this drew.
#define TSM_RENDER_ALPHA     4
#define TSM_RENDERFX_NONE    0
#define TSM_RENDERFX_GLOW    19
/*
 * kRenderGlow, and the renderfx that stops a glow sprite shrinking with distance.
 *
 * A glow sprite is the one rendermode GoldSrc does not depth-test like the rest: it is drawn after
 * the world with the depth test off, which is what makes it the marker to use when the point is to
 * see somebody who is behind something. The engine still runs its own trace for glow sprites, so
 * how much of this survives in TS is a question for the server and not for the compiler -- if it
 * turns out to hide behind walls, tsm_sudden_death 0 turns it off and nothing else changes.
 */
#define TSM_RENDER_GLOW      3
#define TSM_RENDERFX_NODISS  14
/*
 * The x-ray marker (64). Neither GoldSrc's enum (it ends at 20) nor Xash's (it ends at
 * 21, kRenderFxLightMultiplier) uses it. TS's own client draws a body carrying it plainly,
 * and the H9XASH engine patch (xash3d-h9-patches\patches\engine-h9-xray.patch) adds a
 * glow shell in the body's rendercolor with the depth test off, so it shows through walls.
 *
 * Sent only on Xash, and only from fw_addtofullpack, per viewer, never to pev: whoever is
 * not entitled to the reveal is sent some other renderfx, or none at all.
 */
#define TSM_RENDERFX_XRAY    64

// HL door spawnflag: the door refuses to be touched open and answers only +USE.
#define TSM_SF_DOOR_USE_ONLY 256

/*
 * The targetname a map puts on a door only a combat engineer may open.
 *
 * It is a contract with the .map, not a name chosen here: h9_te_neuropolis gives it
 * to the two doors into the slums behind the spawns. A door without it is an
 * ordinary door and is never touched by any of this.
 */
#define TSM_ENG_DOOR "tsm_eng_door"

/* ---- how an eliminated player is disarmed (cvar tsm_disarm) -------------- */
#define DISARM_CMDSTART  1   // zero the usercmd buttons (preferred)
#define DISARM_SPEED     2   // zero maxspeed as well, so they cannot act or move
#define DISARM_NONE      3   // rely on the holding area alone

new g_state = ST_WARMUP;
new g_round = 0;
new g_score[3];              // [1] team1, [2] team2
new bool:g_resetting = false;
new bool:g_halted = false;        // a round stopped over an imbalance; the score is kept
new bool:g_halt_waived = false;   // an admin is playing this match out as it stands
new g_start_alive[3];        // players per team when the round went live
new bool:g_warned_empty = false;
new g_prethink_calls = 0;
new g_speed_fixes = 0;        // restores from the post-PreThink hook
new g_speed_fixes_post = 0;   // restores from the post-PostThink hook    // diagnostic: is FM_PlayerPreThink even firing in TS?
new g_prethink_scale_hits = 0;   // times fw_prethink enforced class scale
new g_postthink_scale_hits = 0;  // times fw_postthink_post enforced class scale

new bool:g_elim[MAXPL];      // eliminated for THIS round
new bool:g_ready[MAXPL];
new g_match_team[MAXPL];     // OUR authoritative team, never the mod's live value
new g_depart_side[MAXPL];    // side of a human who just left, armed until the deferred check runs
new g_spec_target[MAXPL];    // who an eliminated player is watching
/*
 * The side a player BELONGS to for this match, which outlives being eliminated.
 *
 * g_match_team is the side they are playing on RIGHT NOW, and set_ts_spectator zeroes it
 * when it benches an eliminated player -- correct for alive counting, fatal for counting
 * who is still in the match. Wiping a side out is what a round IS here, so once the last
 * of them was benched that side counted nobody, check_match_viable() called it a forfeit
 * and the match dropped to warmup in the middle of play, every round, for no reason anyone
 * could see. This field is cleared when the MATCH ends, not when a round does.
 */
new g_side[MAXPL];
new g_last_buttons[MAXPL];

// Death tracking that does not rely on DeathMsg. TS respawns players automatically,
// so polling is_user_alive() on a one-second tick can miss a death entirely: the
// player is already back up by the time we look. These watch for the alive->dead
// TRANSITION per frame, so a death cannot be missed however briefly it lasts.
new bool:g_was_alive[MAXPL];
new Float:g_pending_elim[MAXPL];

new const g_mech_hit_snd[][] = {
    "debris/metal1.wav",
    "debris/metal2.wav",
    "debris/metal3.wav",
    "debris/metal4.wav",
    "debris/metal5.wav"
};

// Mech .rocket ability: cooldown and uses per life
new Float:g_mech_rocket_next[MAXPL];   // gametime when next rocket is allowed
new g_mech_rockets_used[MAXPL];        // rockets fired this life (max 4)

/*
 * Officer .scan: once per cooldown the Officer types .scan, and every cloaked ENEMY
 * inside a radius around him is marked -- for his WHOLE side, not just himself -- with
 * a blue glow shell (TSM_RENDERFX_GLOW) for a few seconds.
 *
 * The marks live per TARGET (who is marked, by which side, until when), because
 * fw_addtofullpack is per (viewer, entity) anyway: a viewer looks up the target's mark
 * and checks the side that placed it. No bookkeeping per viewer, and a second Officer
 * scanning later simply overwrites the mark with their own side's values.
 */
new Float:g_scan_next[MAXPL];    // gametime the next .scan is available (per OFFICER)
new Float:g_scan_until[MAXPL];   // gametime this player's scan mark expires (per TARGET)
new g_scan_team[MAXPL];          // the side that scanned him, so only they see the mark

/*
 * Recon .cloak / .uncloak.
 *
 * Shimmer, not full invisibility: TSM_RENDER_TEXTURE at a low nonzero renderamt
 * (tsm_cloak_opacity), so the body stays drawn, just faint. The warmup hold and spectating use
 * the same mode at renderamt 0 to hide a player outright.
 *
 * The cloaker never sees it on himself. The client redraws its own player at its own opacity --
 * cl_thirdtransparency in third person -- whatever the server sends, so the effect can only be
 * judged on someone else's screen. amx_tsm_cloak puts it on any player, a bot included, for
 * exactly that. Everyone else is sent it explicitly, from fw_addtofullpack.
 *
 * renderfx is TSM_RENDERFX_NONE, deliberately plain. kRenderFxHologram (16) does not add a
 * flicker on top of renderamt on this engine: it replaces renderamt with its own distance-based
 * value -- roughly 70% opacity at normal engagement range, whatever tsm_cloak_opacity says --
 * plus a random jitter every frame.
 *
 * Enemy bots neither see nor target a cloaked player; see cloak_active(). It is not damage
 * immunity.
 */

new const CLOAK_SND[2][] = { "cloak.wav", "cloak2.wav" };
new const UNCLOAK_SND[2][] = { "uncloak.wav", "uncloak2.wav" };

/*
 * The cloak's blue tint. Written to pev_rendercolor whenever cloak is on, and back to black when
 * it ends, or while an Officer's scan has him -- the one window in which bots may engage a cloaked
 * player. Invisible on screen (this rendermode ignores rendercolor for a studio model), but it
 * is the one render field nothing else in this plugin ever sets to this exact triplet, which makes
 * it the signature the patched RCBot source checks in IsEnemy() (rcbot-patch, Change 4). That
 * check is not in the deployed rcbot_mm.dll; cloak_active() keeps the deployed one off cloaked
 * players instead. Keep this byte-identical to the Vector(40, 120, 255) check in
 * rcbot-patch/src/bot.cpp -- there is no shared header between the two to enforce it.
 *
 * CLOAK_RGB is the same colour as whole numbers, for the entity state fw_addtofullpack writes:
 * set_es() stores render fields as integers, and a Float there arrives as its bit pattern.
 */
new const Float:CLOAK_COLOR[3] = { 40.0, 120.0, 255.0 };
new const CLOAK_RGB[3] = { 40, 120, 255 };

/*
 * The scan's glow and the sudden-death x-ray's two side colours. The scan's blue sits a
 * step away from the cloak tint above so the two never read as one effect. The x-ray
 * colours the body by its own side: MSR (side 1) blue, the Insurgents (side 2) the same
 * red the class icons flip to during sudden death (icon_view's second frame).
 * Whole numbers, for the same reason CLOAK_RGB is: set_es() stores render fields as
 * integers, and a Float here would arrive as its bit pattern.
 */
new const SCAN_RGB[3] = { 0, 170, 255 };
new const XRAY_MSR_RGB[3] = { 0, 170, 255 };
new const XRAY_INS_RGB[3] = { 255, 48, 48 };

new bool:g_cloaked[MAXPL];     // currently cloaked
new Float:g_cloak_at[MAXPL];   // gametime of the last toggle, so chat spam cannot refire every frame
new bool:g_cloak_nodraw[MAXPL]; // the EF_NODRAW on him is the cloak's, for RCBot -- see cloak_active()

new bool:g_flashlight[MAXPL];  // .light toggle, forced regardless of held weapon
new bool:g_ammo_used[MAXPL];   // .ammo used this round already -- once per round, reset in lives_reset_round()

// Saved presentation, so a player is always restorable.
new bool:g_frozen[MAXPL];          // we are holding this player right now
new Float:g_save_maxspeed[MAXPL];  // their speed before we clamped it
new bool:g_warmup_spread[MAXPL];   // already checked/moved off the shared warmup spawn pile this hold

/*
 * RCBot's own CheckStuck() watchdog (bot.cpp) measures a bot's raw 3D velocity, completely
 * blind to this plugin's hold -- after 8 continuous seconds at/under its bot_stuck_speed
 * threshold it sets m_bKill and calls MDLL_ClientKill() directly, a dead pev_health=0 write
 * that never reaches TakeDamage() and so can't be intercepted by anything in fw_takedamage.
 * A held bot's velocity is clamped near zero for the whole hold by design -- so every
 * warmup/freeze reliably runs this watchdog's 8-second timer out and kills the bot, on
 * loop, for as long as the hold lasts. Disabled for the whole held window with the same
 * rcbot-config command family already used elsewhere in this file (amx_tsm_debug et al.),
 * tracked with a simple refcount since apply_freeze()/release_player() run per player, not
 * once per round -- the config itself is a single global, not per-bot.
 */
new g_rcbot_held_count = 0;
new bool:g_rcbot_held[MAXPL];

new bool:g_saved[MAXPL];
new g_save_solid[MAXPL];
new g_save_movetype[MAXPL];
new g_save_effects[MAXPL];
new Float:g_save_takedamage[MAXPL];
new Float:g_save_origin[MAXPL][3];

// Spawn points, collected once per map, then split into two clusters so the teams
// do not spawn mixed together. TS has no team spawns, so the clusters are derived
// geometrically -- see partition_spawns().
new Float:g_spawns[64][3];
new g_spawn_count = 0;

new Float:g_spawn_t1[64][3];
new g_spawn_t1_count = 0;
new Float:g_spawn_t2[64][3];
new g_spawn_t2_count = 0;
new g_spawn_t1_tier[64];                       // forward tier of each point; 0 is the team default set
new g_spawn_t2_tier[64];

new g_cv_enabled, g_cv_rounds, g_cv_freeze, g_cv_roundtime, g_cv_minteam;
new bool:g_was_enabled = true;                 // tsm_enabled as watch_enabled() last saw it
new g_cv_no_weapons;
new g_cv_disarm, g_cv_report, g_cv_reporthp, g_cv_health;
new g_cv_team1name, g_cv_team2name, g_cv_teammode;
new g_cv_holdz;
new g_cv_warmhold;
new g_cv_warmhide;
new g_cv_reloadout;
new g_cv_loadout;
new g_cv_spawnmode;
new g_cv_solo;
new g_cv_dbglog, g_cv_logging;
new g_cv_nospec;
new g_cv_balgap, g_cv_balmode;
new g_cv_haltleave, g_cv_haltdelay, g_cv_haltbypass, g_cv_halthumans;
new g_cv_specmodel;
new g_cv_freezemethod;
new g_cv_forcespeed;
new g_cv_gamedesc;
new g_cv_gamedesc_siege;
new g_cv_presiege;
new g_cv_presattack;
new g_cv_presside1;
new g_cv_presside2;
new g_cv_presalive1;
new g_cv_presalive2;
new g_cv_teamlock;
new g_cv_forcespawn;
new g_cv_classes, g_cv_defclass, g_cv_modelmode, g_cv_classlimits;
new g_cv_nocash, g_cv_blockbuy;
new g_cv_engrange, g_cv_engclips, g_cv_engents, g_cv_engcool;
new g_cv_engglow, g_cv_engshell;
new g_cv_medsound, g_cv_engsound, g_cv_suddensound, g_cv_welcomesound;
new g_cv_scansound;   // the Officer's .scan ping; empty until the custom wav is supplied
// Which death-voice wavs are on disk and precached (slots 1..6); a missing file
// only shrinks the random pool, it never crashes the emit.
new bool:g_death_fem_ok[7];
new bool:g_death_male_ok[7];
#define TSM_DEATH_ROBO "weapons/explode3.wav"   // HL1 frag grenade, stock
#define TSM_DEATH_DROID "death/droid_powerdown.wav"   // a machine powering down, under the boom
#define TSM_DEATH_DROID_PATH "sound/death/droid_powerdown.wav"
new bool:g_death_droid_ok;   // droid_powerdown.wav is on disk and precached
#define TSM_DEATH_OFFICER "death/officer_perished.wav"   // both teams hear an Officer fall
#define TSM_DEATH_OFFICER_PATH "sound/death/officer_perished.wav"
new bool:g_death_officer_ok;   // officer_perished.wav is on disk and precached

/*
 * THE SIEGE FINALE BOOMS, three more of HL1's own stock explosions in the
 * engine's valve directory (no download, no existence check). They layer at
 * once -- separate channels, spread pitches -- the moment the LAST objective
 * of the chain falls; the precache and the whole siege section come later.
 */
#define TSM_OBJ_BOOM_A "weapons/explode4.wav"
#define TSM_OBJ_BOOM_B "weapons/explode5.wav"
#define TSM_OBJ_BOOM_C "explo/explode2.wav"
new const g_boom_snd[3][] = { TSM_OBJ_BOOM_A, TSM_OBJ_BOOM_B, TSM_OBJ_BOOM_C };
// The engine's ScreenShake game message, looked up once and sent raw by the
// finale boom further down.
new g_shake_msg;
new g_cv_musicvol, g_cv_startsound;   // tsm_startsound gates the round-start anthems

// Ambient music queue. One track at a time, for each player who has not turned it
// off. The lengths are the files' own durations, so the next track is armed to start
// as this one ends rather than on a fixed interval.
//
// Six ride HL's MP3 player (client_cmd "mp3 play"): MP3 player audio is 2D
// non-spatial, follows the listener and cannot be moved away from. Contaminated
// is a WAV on playvol instead -- it is by far the longest track
// (five minutes), so while it played it held the ONE mp3 stream for that whole
// time, and anything else that needed the stream was cutting it or being cut.
// As a wav it mixes over a normal sound channel and the mp3 stream is never
// held at all. music_is_wav() tells the two kinds apart; the precache and the
// play path both branch on it.
/*
 * vangelis.wav is track 6 (0-based index 6), and it is a WAV like contaminated rather than an
 * MP3 like the rest -- at 618.8 seconds it is more than twice contaminated's length, and
 * contaminated was already moved off the one shared MP3 stream for exactly this reason: holding
 * that stream for minutes at a time meant anything else that needed it was cutting it or being
 * cut. music_is_wav() below has to know about index 6 as well as index 5, or this would put the
 * same problem straight back, worse.
 */
new const g_music_mp3[][] = { "itsadream.mp3", "ihateher.mp3", "fivefingers.mp3", "deadinsects.mp3", "twoplustwo.mp3", "contaminated.wav", "vangelis.wav", "floatingmuseum.mp3", "grammaton_cleric.mp3", "burned.mp3", "supression.mp3", "alwaysknew.mp3", "equilibrium_suite.mp3", "equilibrium_final_countdown.mp3" };
new const Float:g_music_len[] = { 70.1, 73.7, 42.2, 107.5, 42.2, 304.0, 618.8, 305.6, 78.5, 129.9, 147.9, 306.9, 1105.2, 858.0 };
new g_music_order[14] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 };   // one slot per track in g_music_mp3
new g_music_pos = 14;        // matches sizeof g_music_order: forces a shuffle before the first track
new g_music_cur = -1;        // the track currently playing, -1 before the first
new bool:g_music_off[MAXPL];

/*
 * THE ROUND-START ANTHEMS, team-pure: one second into every round, each
 * sided player hears a random pick of their OWN side's short stinger --
 * ts\sound\start, six files the server ships -- locally on the player's
 * own machine via playvol, a NORMAL sound channel. They once rode the mp3
 * player, where HL's single mp3 stream made every anthem a hard cut of
 * the ambient queue's track; a wav mixes over the queue's mp3 instead of
 * fighting it for the one channel, so nothing needs leasing anymore.
 * Side 1 = MSR, side 2 = Insurgency; tsm_startsound 0 turns the pair off
 * entirely.
 */
new const g_start_t1[][] = { "fortherepublic.wav", "instructions.wav", "lordcommander.wav" };
new const g_start_t2[][] = { "slaythem.wav", "ripout.wav", "eliminatetheimpure.wav" };

/*
 * TEAM 2's ROAR: the monster's own cry, the Insurgents' SECOND round-start
 * sound -- four seconds after their anthem rings, heard by the Insurgents
 * only, locally on their own machines. Lives at ts\sound root like the
 * welcome jingle, and is existence-gated at precache like the death voices.
 */
#define TSM_ROAR_WAV "mutantroar.wav"
new bool:g_roar_ok;   // mutantroar.wav really stood on disk at precache time;

/*
 * TEAM 1's BADUM: the MSR's own second round-start sound, badum.wav the same
 * way the Insurgents' roar is theirs -- four seconds after their anthem rings,
 * heard by the MSR only, locally on their own machines. Lives at ts\sound root
 * like the roar, and is existence-gated at precache like the death voices.
 */
#define TSM_BADUM_WAV "badum.wav"
new bool:g_badum_ok;   // badum.wav really stood on disk at precache time;

new g_cv_regenamt, g_cv_regenevery, g_cv_regenpause;
new Float:g_last_hit[MAXPL];    // gametime they were last damaged, for the regen pause
new g_cv_breachents, g_cv_breachrange, g_cv_breachdoor[8];
new g_cv_engdoorclass;
new g_cv_engdoorteam;
new g_cv_objteam, g_cv_objclass, g_cv_objtime, g_cv_objfuse, g_cv_objslay, g_cv_objrange;
new g_cv_siegelives, g_cv_siegetime, g_cv_addtime;   // what a fall short of the last gives back
new g_cv_objmsg1, g_cv_objmsg2;   // the round-start team banners
new g_cv_armorder;
new g_cv_wpnextra;
new g_cv_classscale;
new g_cv_blindff;
new g_cv_modelverify;
new g_cv_modelfallback;
new g_cv_prune, g_cv_prunedist;
new g_cv_botreload;
new g_cv_hoverinfo, g_cv_hoverrange;
new g_cv_medheal, g_cv_medcool, g_cv_medrange, g_cv_medglow, g_cv_medshell;
new g_cv_stim, g_cv_stimmin, g_cv_stimmax, g_cv_stimglow, g_cv_stimshell;
new g_cv_deathlinger;

new g_cv_classretry, g_cv_deathgrace;
new g_cv_officerslain;

/*
 * When each of TS's corpses was first seen, by entity index.
 *
 * -1.0 means "released": we have given it back to TS and must not take it again, or an
 * index it reuses would be held on a timer that belongs to a body already gone. Cleared
 * at the top of every round, which bounds any staleness to the round it happened in --
 * corpses do not survive a round transition anyway.
 */
#define TSM_MAXENT 1024
new Float:g_corpse_born[TSM_MAXENT];
/// For a TS corpse, the copy of it we made; for one of our copies, nothing.
new g_corpse_clone[TSM_MAXENT];
new g_cv_squaddist, g_cv_squadwarp, g_cv_squadspeed;
new g_cv_squadsteer, g_cv_squadleash;
new g_cv_endelay;
new g_cv_botresup;
new g_bot_resup_rr = 0;        // round-robin, so only one bot is topped up per tick
new Float:g_bot_resup_at[MAXPL];
new Float:g_ff_told_at[MAXPL];   // rate limit on the friendly-fire warning

/*
 * Cached, because fw_traceline runs on a very hot path.
 *
 * is_user_bot() per traceline would mean a native call for every line of sight
 * every bot tests every frame. This is written once when they join.
 */
new bool:g_is_bot[MAXPL];
new g_blinded = 0;             // diagnostic: traces hidden from a bot so far
new g_traces_seen = 0;         // diagnostic: traces where a BOT was the tracer
new Float:g_deathtrace_at[MAXPL];  // diagnostic: log a death's visibility for a few seconds
new Float:g_end_pending_at = 0.0;   // when the win condition was first met
new g_end_pending_winner = 0;
new g_cv_botnames, g_cv_botname1, g_cv_botname2;

// Class tables, parsed once from the tsm_classN cvars.
new g_class_count = 0;
new g_class_name[TSM_MAXCLASS][32];
/*
 * Per team, and each side may hold a comma-separated list to pick from.
 *
 * Index 1 is MSR, index 2 the Insurgents, matching g_class_wpn. 96 is sized for
 * the longest list (the Insurgent Assault's three).
 */
new g_class_model[TSM_MAXCLASS][3][TSM_MODELLIST];
new g_model_pick[MAXPL];      // which entry of the list this player drew, 1-based
new g_model_pick_key[MAXPL];  // the (class, side) pair that pick was drawn for
new g_precached = 0;          // class models precached at map load
new g_model_last[MAXPL][32];  // the model we last wrote for this player
new Float:g_model_at[MAXPL];  // when we wrote it
new g_model_writes = 0;       // diagnostic: real model writes since map load
new g_model_want_idx[MAXPL];  // model index the engine must draw for this player
new g_model_chosen[MAXPL][32];// the name the class table picked, before it was checked
new g_model_ok[MAXPL];        // whether that name resolved to a file on disk
new g_spec_model_idx = 0;     // index of tsm_spectator_model, resolved once (see spec_model_index)
new bool:g_spec_model_tried;  // resolved it (or found it missing) at least once
new bool:g_roaming[MAXPL];    // .roam -- out of the match, free to walk the map
new Float:g_bot_reload_at[MAXPL];  // last forced reload, so it is not every frame
new Float:g_bot_dry_at[MAXPL];     // last dry-weapon cycle, same reasoning
new g_bot_dry_weapon[MAXPL];       // weapon id currently being dry-counted
new g_bot_dry_count[MAXPL];        // consecutive dry reads of that weapon
new g_bot_dry_switches[MAXPL];     // switches made this round, capped by weapon count
new g_class_wpn[TSM_MAXCLASS][3][TSM_MAXWPN];
new g_class_clips[TSM_MAXCLASS][3][TSM_MAXWPN];
new g_class_wcount[TSM_MAXCLASS][3];
new g_class_hp[TSM_MAXCLASS];
new g_class_ap[TSM_MAXCLASS];
new g_class_perk[TSM_MAXCLASS];
/*
 * How many of each class one SIDE may field. 0 is no limit.
 *
 * Kept out of the tsm_classN spec on purpose. That string already carries nine fields and a limit
 * would have to be the tenth, which means every class without a speed and a scale would need two
 * empty fields written in just to reach it -- "Assault;...;0;;;0", where nobody can tell what the
 * blanks were for. One list, read by position, says the same thing in a line you can read.
 */
new g_class_limit[TSM_MAXCLASS];
new g_mode_class_limit[TSM_MAXCLASS];  // a claimed mode's class rules: -1 not played, 0 no limit, n a side
new g_mode_class_lives[TSM_MAXCLASS];  // and the lives it gives a class; 0 keeps tsm_class_lives
new bool:g_mode_classes;               // a claimed mode has set class rules on this map
new g_mode_bot_class;                  // the class every bot plays while the mode runs; 0 leaves it to tsm_bot_class
new g_mech_stunt[MAXPL];               // a mech's stunt: 0 none, 1 under way, 2 under way and off the ground
new Float:g_mech_stunt_at[MAXPL];      // when that stunt began

// The sentry turrets standing, one slot each: the entity (0 a free slot), whose it is, its side, its health
// (kept here: TS's damage never reaches the func_breakable's own), when it can next be repaired, when it has
// deployed, its next look for a target, its next shot, its target, the shots it has fired, its body's yaw.
new g_turret[TSM_TURRET_MAX];
new g_turret_owner[TSM_TURRET_MAX];
new g_turret_side[TSM_TURRET_MAX];
new Float:g_turret_hp[TSM_TURRET_MAX];
new Float:g_turret_repair_at[TSM_TURRET_MAX];
new Float:g_turret_ready_at[TSM_TURRET_MAX];
new Float:g_turret_seek_at[TSM_TURRET_MAX];
new Float:g_turret_shot_at[TSM_TURRET_MAX];
new g_turret_target[TSM_TURRET_MAX];
new g_turret_shots[TSM_TURRET_MAX];
new Float:g_turret_yaw[TSM_TURRET_MAX];
new bool:g_turret_used[MAXPL];   // .turret placed this round (this wave in Wave Survival): once each
// A turret packed up with .pickup and carried: its health and when it can next be repaired, for .turret
// to stand it down again as it was.
new bool:g_turret_carry[MAXPL];
new Float:g_turret_carry_hp[MAXPL];
new Float:g_turret_carry_rep[MAXPL];
new bool:g_turret_ok;     // its models and sounds are all there and precached
new g_turret_boom;        // the explosion sprite's index
new g_turret_blood, g_turret_bloodspray;   // the blood sprites a hit shows, 0 when the game has none
new g_turret_flash;   // TS's own muzzle flash sprite, 0 when the game has none
new g_turret_trail, bool:g_turret_bullet;   // TS's slow-motion bullet trail and its bullet model, 0/false when missing
new g_cv_turret_resist;   // the share of every hit its armour turns aside
new g_cv_turret, g_cv_turret_per_team, g_cv_turret_hp, g_cv_turret_range, g_cv_turret_dmg;
new g_cv_turret_rate, g_cv_turret_spread, g_cv_turret_repair, g_cv_turret_repaircd;
new const g_turret_fire_snd[][] = { "turret/turret-1.wav", "turret/turret-2.wav", "turret/turret-3.wav", "turret/turret-4.wav" };
new Float:g_class_speed[TSM_MAXCLASS];   // movement multiplier, 1.0 = normal
new Float:g_class_scale[TSM_MAXCLASS];   // how tall the model is drawn, 1.0 = normal
new g_class_menu = 0;
new g_team_menu = 0;
new g_legend_menu = 0;

new bool:g_spectator[MAXPL];      // chose to sit out rather than pick a side
new Float:g_team_menu_at[MAXPL];  // last time the team menu was put up for them

new g_player_class[MAXPL];     // 0 = not picked; locked for the whole match
new Float:g_eng_used[MAXPL];   // when engineer last resupplied, for the cooldown
new bool:g_stim_used[MAXPL];   // this player has spent their stimpack THIS ROUND
new Float:g_medic_at[MAXPL];  // when this medic last healed, for the cooldown
new Float:g_perk_at[MAXPL];   // when perk_use last ran, to dedupe button vs command
new Float:g_engdoor_told_at[MAXPL];  // rate limit on the refusal at an engineer door
new g_squad_leader[MAXPL];    // for a BOT: the officer it is following, 0 = nobody
new g_bot_prethinks[MAXPL];   // diagnostic: does PlayerPreThink fire for bots at all?

// .unstick cooldown per player (gametime when next .unstick is allowed)
new Float:g_unstick_at[MAXPL];
// Shove persistence: until when, and in which 2D direction (per bot)
new Float:g_push_until[MAXPL];
new Float:g_push_dir[MAXPL][2];
// When a squad bot was FIRST seen beyond tsm_squad_dist, for task_squad's leash.
// 0 = the bot is inside formation distance and the clock is not running.
new Float:g_squad_lag_at[MAXPL];

/*
 * Diagnostic: does Ham_Use fire on func_door in THIS mod at all?
 *
 * Not idle curiosity. Ham_Spawn and Ham_TakeDamage on "player" were both measured at
 * ZERO hits in TS over a full session, and a fix built on one of them sat in the file
 * for builds as dead code because nothing errors when a Ham is never delivered. The
 * engineer doors rest on Ham_Use, so the first question anyone will ask is whether it
 * runs -- amx_tsm_debug answers it with these.
 */
new g_door_use_hits;          // every func_door Use the hook has seen
new g_engdoor_use_hits;       // of those, the ones on a door named tsm_eng_door
new g_player_dmg_hits;        // every Ham_TakeDamage on "player" this hook has seen, bots included
new g_fall_refused;           // of those, the fall hits on held bodies fw_takedamage sent back
new bool:g_forcing_door;      // tsm_opendoor is forcing a door: fw_door_use lets it through
new g_cv_forcedoor;           // amx_tsm_forcedoor: tsm_opendoor works only while this is 1
new bool:g_locked_out[MAXPL];  // joined mid-match; sits out until the match ends
new bool:g_forfeit[MAXPL];     // has typed .forfeit this match
new g_last_use[MAXPL];
new bool:g_in_userinfo[MAXPL];
new g_gamedesc[64];

/*
 * Running on Xash3D FWGS (H9XASH) rather than GoldSrc. Decided once, at precache, from
 * host_ver -- a cvar only Xash registers -- and checked by the few things Xash needs done
 * differently: the sv_visiblemaxplayers stand-in in plugin_precache, and the leave
 * cleanup from fw_client_disconnect_xash. On GoldSrc none of them run.
 */
new bool:g_xash;

// Facing for each team spawn. Only meaningful for config-placed spawns -- the
// entity scan has no angles to copy, so it leaves players looking wherever they
// already were.
new Float:g_ang_t1[64][3];
new Float:g_ang_t2[64][3];
new bool:g_spawns_have_angles = false;
new g_cfg_spawns = 0;        // how many spawns the per-map cfg supplied

// Placed at a spawn for the CURRENT round. Lets the freeze tick pick up anyone
// who was dead when the round started and respawned during the countdown.
new bool:g_placed[MAXPL];

new g_dbgfile[64];
new g_mapname[32];
new bool:g_map_h9 = true;    // this map plays the match mode (plugin_precache): H9's own, or its mapconfig says so

new g_freeze_left = 0;
new g_round_left = 0;
new Float:g_round_ends = 0.0;   // gametime the round clock runs out: what task 2 is set for

/*
 * THE MODE A PLUGIN HAS CLAIMED THIS MAP FOR (see include\tsm_api.inc).
 *
 * Empty name, zero flags: no mode, and every check below that reads them is a no-op. A claim
 * is made once per map, by ts_uplink or ts_survival, and lasts until the map changes.
 */
new g_mode_name[16];          // the claimant's key, "uplink" or "survival"; empty for none
new g_mode_desc[64];          // what the server browser shows while the mode runs
new g_mode_flags;             // TSM_MODE_* bits the claim asked for
new g_mode_hud[48];           // the mode's own text on the round line ("WAVE 12")
new Float:g_wave_secs[3];     // a side's wave interval while the mode runs; 0 = tsm_respawn_wave
new g_wave_num[3];            // natural waves fired this round, per side
new g_fw_round_start = -1, g_fw_round_live = -1, g_fw_round_end = -1, g_fw_timeout = -1;
new g_fw_wave = -1, g_fw_loadout = -1, g_fw_armed = -1;
new g_cv_presmode;            // tsm_pres_mode: the claimed mode's key, for the Discord card
new g_cv_presprog;            // tsm_pres_prog: the claimed mode's progress, as it last said it
new g_mode_prog[24];          // what tsm_set_progress last handed over

// A mode's loadout for the arm in progress: -1 takes the class's weapons, otherwise how many
// of g_lo_wpn/g_lo_clips to give. Resolved once per arm, so the M60-first half and the rest
// of the kit a beat later give from the same roll.
new g_lo_n[MAXPL] = { -1, ... };
new g_lo_wpn[MAXPL][TSM_LOADOUT_MAX];
new g_lo_clips[MAXPL][TSM_LOADOUT_MAX];
new g_cv_showtimer;
new g_cv_t1short, g_cv_t2short;
new g_cv_forceteams, g_cv_forcemodels;
new g_cv_t1label, g_cv_t2label;
new g_cv_menudelay;
new g_cv_blockvgui;
new g_cv_wpnmode;
new g_cv_clipbonus, g_cv_clipcap;
new g_cv_sparepct;   // reserve rewrite percentage: figure x mag x N% (tsm_clip_sparepct)
new g_cv_giveammo;
new g_cv_specteam;
new g_cv_armdelay;
new g_cv_defaultspec;
new g_cv_cleandrops;
new g_cv_friendlyfire;
new g_cv_autofill;
new g_cv_deathdelay;
new Float:g_elim_at[MAXPL];   // when this player was eliminated
new g_cv_sweepdrops;
new g_cv_cloak;
new g_cv_cloakduration;
new g_cv_cloakcooldown;
new g_cv_cloakopacity;
new g_cv_nopowerups;
new g_cv_modelpost;
new g_cv_icons, g_cv_iconhigh, g_cv_iconscale, g_cv_sudden;
new g_cv_suddenxray;                                                       // sudden-death X-ray on/off
new g_cv_suddenfog_r, g_cv_suddenfog_g, g_cv_suddenfog_b, g_cv_suddenfog_d; // the toxic bog
new g_cv_scanradius, g_cv_scancool, g_cv_scantime;                         // the Officer's .scan
new g_cv_botreturn;
new g_cv_bots, g_cv_botteams, g_cv_botclass, g_cv_botready;

/*
 * The flag string every get_players() call uses.
 *
 * "c" means SKIP BOTS (amxmodx.inc:329). The whole plugin passed it, so a bot was
 * invisible to team counts, ready-up, alive counting, round-end, the hold, loadouts
 * and kill reports alike. Chosen once here rather than hardcoded at 29 call sites --
 * 29 places to get wrong is 29 places to revert.
 */
new g_bots_were = -1;    // last tsm_bots value pushed to rcbot
new bool:g_bots_parked = false;  // bots sit out until the next match begins
new Float:g_botfill_at[MAXPL];   // last fill attempt, so a refused move is not spammed
new g_bot_slot[MAXPL];           // this bot's number within its side, 0 = none
new g_pf[4] = "c";      // all players
new g_pfa[4] = "ac";    // alive players only
new g_pfall[2];         // no flags at all: every connected player, dead or alive, bot or human.
                        // The wave machinery walks this one: with g_pf's skip-bots filter,
                        // a bot waiting for a wave was never scheduled, never counted and
                        // never listed -- which is why .reinforce called back every human
                        // and left one bot corpse standing.

new g_bot_class_rr = 0;  // round-robin cursor for spreading bots across classes

// Ground weapons that belong to the MAP, recorded once after it spawns. Anything not
// in here is something a player dropped.
new g_map_items[128];
new g_map_item_count = 0;
new g_arm_pending[MAXPL];
// ---- lives and respawn waves (lives_on_death, fire_wave, revive_player) ----
new g_class_lives[TSM_MAXCLASS];       // lives per class from tsm_class_lives; 1 unless listed
new g_lives_left[MAXPL];               // lives left this round, the one being played included
new bool:g_revive_pending[MAXPL];      // eliminated with lives left: waiting for a wave
new bool:g_revive_active[MAXPL];       // a wave is actively trying to revive this player RIGHT NOW --
                                        // narrower than g_revive_pending, which covers the whole wait
new Float:g_died_at[MAXPL];            // when the pending death happened
new Float:g_wave_left[3];              // seconds to each team's next wave, indexed 1 and 2
new Float:g_reinforce_next[MAXPL];     // the Officer's .reinforce cooldown
new g_revive_slot[MAXPL];             // where in the team's points this player is put on a wave
new g_revive_waits[MAXPL];           // half-second waits a wave revive has made so far
new bool:g_revive_washed[MAXPL];     // the wave's wash has been done for this player
new g_revive_refused[MAXPL];         // waves that could not bring this player back: 0 or 1
new g_revive_tries[MAXPL];           // retries left while a wave revive's gear waits for the spawn
new g_cv_respawns, g_cv_respwave, g_cv_respsecs, g_cv_respsudden, g_cv_reinforce, g_cv_classlives;
new bool:g_armed[MAXPL];      // true once task_arm_respawn has finished this player's loadout
new g_next[33];               // per walker: which mech step of the pair plays next
new Float:g_next_step_time[33]; // rate-limit for local player footstep detection
new g_mech_hp_watch[33];      // last known mech hp: any positive bump in live play is a stimpack role we out-law
new g_m60_skip[33];           // index in the class weapon list held back for the M60-first arm (-1 = none)
new Float:g_connect_at[MAXPL];
new Float:g_class_menu_at[MAXPL];
new Float:g_gate_deadline;    // when the LIVE gate stops waiting and forces go-live
/*
 * The side and class menus are raw ShowMenu text, keyed back to us through these ids. AMXX strips
 * the colour codes out of a menu_create() menu on any mod it does not know, TS included; raw text
 * goes out exactly as written, so this is the only way the pick menus keep their colour.
 */
#define TSM_SIDE_MENU  "TSM Side"
#define TSM_CLASS_MENU "TSM Class"
new g_side_menuid, g_class_menuid;
new g_team_menu_text[256];   // the side menu as sent, rebuilt with the team names
new g_team_menu_keys;
new Float:g_reassert_at[MAXPL];
new bool:g_issuing[MAXPL];   // our buy commands are executing for this player right now
new bool:g_cash_lend[MAXPL]; // BuyArmament is running for us and needs funds
new g_icon_ent[MAXPL];       // this player's class-icon sprite, 0 if none yet
new g_icon_owner[2048];      // edict -> the player whose class icon it is, 0 for anything else
new bool:g_sudden;           // the last minute has begun, and it is announced once
new bool:g_fogtest;           // tsm_fogtest's own toggle; never touched while g_sudden is real
new bool:g_icon_ok;          // the sheet precached, so the entities may be made
new g_maxplayers;            // the slot count, read once at precache: players are 1..g_maxplayers
new g_join_tries[MAXPL];     // jointeam attempts for the current pick
new g_teaminfo_seen = 0;     // TeamInfo messages from the mod since map load

/* ======================================================================== */

/* ---- debug log ----------------------------------------------------------- */

/*
 * Writes to addons/amxmodx/logs/tsm_debug.log, which is a file you can tail while
 * playing. tsm_debug_log 2 also echoes to the server console. Kept separate from
 * tlog() deliberately: the AMXX log interleaves with every other plugin and with
 * chat, and that mixing is what made the round-start ordering unreadable.
 */
/*
 * Verbose trace. Only writes at tsm_debug_log 3 or higher, so it can be left in.
 * Used for the per-tick detail that would drown the normal log.
 */
/*
 * EVERY LINE THIS PLUGIN EMITS GOES THROUGH ONE SWITCH, tsm_logging, and it is OFF
 * by default.
 *
 * At tsm_debug_log 3 the verbose trace writes on every tick for every player, and on
 * a dedicated server that is a wall of text that buries anything else being logged and
 * costs real time in the frame. Off by default means a server that nobody is debugging
 * says nothing at all.
 *
 * tsm_logging 1 restores whatever tsm_debug_log asks for. The two are deliberately
 * separate: the master switch is what you reach for, and the level is how much you
 * want once it is on.
 *
 * NOTE that this silences the misconfiguration warnings too -- a missing class model,
 * an empty mp_teammodels. If something looks wrong, turn tsm_logging on BEFORE
 * concluding that nothing is being reported.
 *
 * Replies to a typed console command, such as tsm_spawn's usage text, are not logging
 * and are not gated: a command that answers nothing looks broken.
 */
tlog(const fmt[], any:...)
{
	if (g_cv_logging == 0 || !get_pcvar_num(g_cv_logging))
	{
		return;
	}
	new msg[256];
	vformat(msg, charsmax(msg), fmt, 2);
	log_amx("%s", msg);
}

dbgv(const fmt[], any:...)
{
	if (g_cv_logging == 0 || !get_pcvar_num(g_cv_logging) || get_pcvar_num(g_cv_dbglog) < 3)
	{
		return;
	}

	new msg[256];
	vformat(msg, charsmax(msg), fmt, 2);
	log_to_file(g_dbgfile, "[v][state %d] %s", g_state, msg);

	if (get_pcvar_num(g_cv_dbglog) >= 4)
	{
		server_print("[TSMv] %s", msg);
	}
}

dbg(const fmt[], any:...)
{
	if (g_cv_logging == 0 || !get_pcvar_num(g_cv_logging))
	{
		return;
	}
	new mode = get_pcvar_num(g_cv_dbglog);
	if (mode < 1)
	{
		return;
	}

	new msg[256];
	vformat(msg, charsmax(msg), fmt, 2);

	log_to_file(g_dbgfile, "[state %d] %s", g_state, msg);

	if (mode >= 2)
	{
		server_print("[TSM] %s", msg);
	}
}

/* ---- the mode a plugin has claimed (see include\tsm_api.inc) ------------- */

/// 1 when the claimed mode asked for this TSM_MODE_* flag; always 0 with no claim.
mode_flag(flag)
{
	return (g_mode_flags & flag) ? 1 : 0;
}

/// Seconds between this side's waves: the claimed mode's interval, or tsm_respawn_wave.
Float:wave_interval(side)
{
	if (side >= 1 && side <= 2 && g_wave_secs[side] > 0.0)
	{
		return g_wave_secs[side];
	}
	return get_pcvar_float(g_cv_respwave);
}

/// 1 when this side's deaths wait for a wave: tsm_respawns, or side 2 where a mode made it endless.
side_respawns(side)
{
	if (side == 2 && mode_flag(TSM_MODE_SIDE2_ENDLESS))
	{
		return 1;
	}
	return get_pcvar_num(g_cv_respawns) ? 1 : 0;
}

/// Fires a mode forward that takes one number, while a mode has claimed the map. The answer is not wanted.
mode_notify(fw, value)
{
	if (fw != -1 && g_mode_name[0])
	{
		new ret;
		ExecuteForward(fw, ret, value);
	}
}

/*
 * === THE SIEGE ALARM =======================================================
 *
 * The FIRST successful attack of a round on anything the other side owns -- a
 * hold taken on a siege objective, or one of the breach doors forced -- starts
 * the alarm siren, and the siren then loops for the remainder of the round.
 *
 * It never stacks. Every trigger funnels into alarm_start, which is a no-op
 * while the alarm is already running, and the loop beat is one repeating task
 * that fires a twentieth of a second BEFORE the wav runs out -- so the next
 * play is always the only one next, and no round holds more than one alarm no
 * matter how many doors and objectives are attacked meanwhile.
 *
 * The wave length is measured once by reading the wav's own RIFF header: the
 * byte rate out of its fmt chunk, the file size out of the RIFF word itself.
 * A guessed interval could shorten the file into a stack; a missing or
 * unreadable wav measures as nothing at all, which stands the siren down but
 * keeps the warning text running on a plain two-second beat.
 *
 * Every human client hears the siren, both sides, wherever they stand. Only real
 * people receive the text: every player on the side opposite the trigger reads
 * tsm_alarm_msg, and every player on the trigger's own side reads
 * tsm_alarm_msg_attack, each centre screen in the reader's own side colour, the
 * same two colours the round banners use (pipes are row breaks, like the
 * banners'). tsm_alarm_vol is the siren's volume, tsm_alarm 0 stands the
 * alarm down entirely. It stops at round start, at match teardown, and by
 * itself in the next round's freeze; the round it belongs to owns it to the
 * very end of that round.
 */
#define TSM_ALARM_WAV "bloblarm.wav"
#define TSM_ALARM_Y   0.40    // above the crosshair, below the round clock (0.03); the plant bar sits just under it
#define TSM_PLANT_Y   0.47    // the planter's own progress bar shares that empty band
#define TSM_PLANT_WAV   "get_satchel.wav"   // the engine's own satchel-reach clack, valve dir fallback
#define TSM_PLANT_DONE  "plant.wav"         // the one the server ships in ts\sound -- rings once on success
#define TSM_WAITLIST_X  0.74    // the Officer's waiting list: right side, clear of the centre HUD
#define TSM_WAITLIST_Y  0.26    // top of the waiting list: under the wave clock (0.12)

new g_cv_alarm, g_cv_alarmvol, g_cv_alarmmsg, g_cv_alarmmsgatk;
// The siren's measured seconds; 0.0 means no wav behind the name, text only. One
// flag, so a second trigger of the round finds the alarm busy and walks away.
new Float:g_alarm_len;
new bool:g_alarm_on;
// The side that started the alarm; the defenders are everyone not on it.
new g_alarm_side;

// THE SATCHEL PLANT: one objective charges at a time across the whole chain,
// so the planted state is these three plus one fuse task. The last row is
// each planter's own plant-sound clock, set fresh on every hold they start.
new g_plant_ent, g_plant_n, g_plant_by;
new Float:g_plant_last[MAXPL];
// Measured lengths the planting and the finale lean on: the plant sound's own
// length, and each finale boom's span -- the ground shake covers their window.
new Float:g_plant_len;        // the plant sound's own length; it is not replayed sooner
new Float:g_plant_done_len;   // the SUCCESS plant.wav, reported by the siege dump
new Float:g_boom_len[3];
new g_obj_boom_spr;   // the explosion sprite's precache index, for the TE burst

/*
 * A moddir wav's own length in seconds, read from its header. The open IS the
 * existence gate: moddir first, then the engine's own valveshared stock (the
 * plant sound and the boom stack live there), and any wav with no readable
 * header measures 0.0 so the callers can fall back on their own terms.
 */
Float:sound_seconds(const snd[])
{
	new path[40];
	formatex(path, charsmax(path), "sound/%s", snd);
	new f = fopen(path, "rb");
	if (!f)
	{
		f = fopen(path, "rb", true);
	}
	if (!f)
	{
		return 0.0;
	}

	// "RIFF <u32> WAVE": that integer IS how many bytes follow it, so the
	// file's total comes out of its own first words and no fsize is needed.
	new id[4];
	if (fgetc(f) != 'R' || fgetc(f) != 'I' || fgetc(f) != 'F' || fgetc(f) != 'F')
	{
		fclose(f);
		return 0.0;
	}
	new riff = fgetc(f) | (fgetc(f) << 8) | (fgetc(f) << 16) | (fgetc(f) << 24);
	if (fgetc(f) != 'W' || fgetc(f) != 'A' || fgetc(f) != 'V' || fgetc(f) != 'E')
	{
		fclose(f);
		return 0.0;
	}

	// Then a chunk walk until "fmt ": every other chunk is stepped over whole
	// (the big data chunk is never entered), so the read stays a few bytes.
	// Sixteen steps is past any sane wav and harmless on a junk one.
	new rate = 0;
	for (new chunk = 0; chunk < 16 && !feof(f); chunk++)
	{
		id[0] = fgetc(f);
		id[1] = fgetc(f);
		id[2] = fgetc(f);
		id[3] = fgetc(f);
		new size = fgetc(f) | (fgetc(f) << 8) | (fgetc(f) << 16) | (fgetc(f) << 24);
		if (size <= 0 || feof(f))
		{
			break;
		}

		if (id[0] == 'f' && id[1] == 'm' && id[2] == 't' && size >= 16)
		{
			// fmt data: bytes 0..3 the format tag and channel count, 4..7 the
			// sample rate, 8..11 the byte rate -- rate x bytes per second on
			// the wire, which is the divisor wanted. The eight bytes before it
			// go straight past and the walk ends with the file, before the far
			// bigger data chunk.
			fgetc(f);
			fgetc(f);
			fgetc(f);
			fgetc(f);
			fgetc(f);
			fgetc(f);
			fgetc(f);
			fgetc(f);
			rate = fgetc(f) | (fgetc(f) << 8) | (fgetc(f) << 16) | (fgetc(f) << 24);
			break;
		}

		fseek(f, size, SEEK_CUR);
	}
	fclose(f);

	if (rate <= 0 || riff <= 16)
	{
		return 0.0;
	}

	// The RIFF word counts itself short by eight, so the file's own span is
	// eight more. Header tens of bytes against streaming tens of thousands
	// leaves the figure within milliseconds of the true play length.
	return float(riff + 8) / float(rate);
}

/*
 * One play of the siren on every human client, once each and wherever they stand:
 * playvol is the client's own local sound. An emit from the players' bodies reaches
 * only those in earshot of each body, and stacks one copy per player on everyone close.
 */
alarm_emit()
{
	new Float:vol = get_pcvar_float(g_cv_alarmvol);
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (is_user_connected(id) && !is_user_bot(id))
		{
			client_cmd(id, "playvol %s %f", TSM_ALARM_WAV, vol);
		}
	}
}

/*
 * The alarm's centre-screen lines, each in the reader's own side colour: the
 * defenders read tsm_alarm_msg, the attackers tsm_alarm_msg_attack. Held for the
 * whole beat plus a little, so the next beat's redraw always lands before the
 * previous one expires and the line never blinks.
 *
 * Channel 2. GoldSrc keeps four text slots and files a message in channel % 4, so
 * this is the slot the alarm has always had on Steam; Xash keeps eight, and a
 * channel above 4 there gets a slot of its own that TS's client does not show.
 */
alarm_draw()
{
	new dmsg[384], amsg[384];
	get_pcvar_string(g_cv_alarmmsg, dmsg, charsmax(dmsg));
	get_pcvar_string(g_cv_alarmmsgatk, amsg, charsmax(amsg));

	for (new c = 0; c < sizeof dmsg && dmsg[c]; c++)
	{
		if (dmsg[c] == '|')
		{
			dmsg[c] = '^n';
		}
	}
	for (new c = 0; c < sizeof amsg && amsg[c]; c++)
	{
		if (amsg[c] == '|')
		{
			amsg[c] = '^n';
		}
	}

	new Float:hold = (g_alarm_len > 2.0 ? g_alarm_len : 2.0) + 0.4;

	// Side 1 is MSR, blue; side 2 the Insurgents, red. Attacking side 1 puts side 2
	// under the alarm, so the defenders read red and the attackers blue; attacking
	// side 2 the other way round. Bots never read it, and neither does anyone whose
	// side is unset.
	if (dmsg[0])
	{
		if (g_alarm_side == 1)
		{
			set_hudmessage(255, 70, 60, -1.0, TSM_ALARM_Y, 0, 0.0, hold, 0.1, 1.0, 2);
		}
		else
		{
			set_hudmessage(0, 170, 255, -1.0, TSM_ALARM_Y, 0, 0.0, hold, 0.1, 1.0, 2);
		}
		for (new id = 1; id <= g_maxplayers; id++)
		{
			if ((g_match_team[id] == 1 || g_match_team[id] == 2) && g_match_team[id] != g_alarm_side
				&& is_user_connected(id) && !is_user_bot(id))
			{
				show_hudmessage(id, "%s", dmsg);
			}
		}
	}

	if (amsg[0] && (g_alarm_side == 1 || g_alarm_side == 2))
	{
		if (g_alarm_side == 1)
		{
			set_hudmessage(0, 170, 255, -1.0, TSM_ALARM_Y, 0, 0.0, hold, 0.1, 1.0, 2);
		}
		else
		{
			set_hudmessage(255, 70, 60, -1.0, TSM_ALARM_Y, 0, 0.0, hold, 0.1, 1.0, 2);
		}
		for (new id = 1; id <= g_maxplayers; id++)
		{
			if (g_match_team[id] == g_alarm_side && is_user_connected(id) && !is_user_bot(id))
			{
				show_hudmessage(id, "%s", amsg);
			}
		}
	}
}

/*
 * Turn the alarm on -- or find it already on and do nothing, which is the
 * whole no-stack rule made solid: the running loop does not care who touched
 * a door or objective after the first one did. FORCED -- the siege debug
 * suite's amx_tsm_siege_alarm -- still refuses an alarm already running
 * (idempotence survives) but skips the cvar and live-round gates, so the
 * siren can be heard from freeze on because it was ASKED for.
 */
alarm_start(id, bool:force = false)
{
	if (g_alarm_on || (!force && (!get_pcvar_num(g_cv_alarm) || g_state != ST_LIVE)))
	{
		return;
	}

	g_alarm_on = true;

	// The trigger's side defines who is under the alarm. A trigger without a
	// side falls back to the objective cvar's own attackers, so the recipients
	// are never "side zero".
	g_alarm_side = get_pcvar_num(g_cv_objteam);
	if (g_match_team[id] == 1 || g_match_team[id] == 2)
	{
		g_alarm_side = g_match_team[id];
	}

	if (g_alarm_len > 0.0)
	{
		alarm_emit();

		// The beat fires a twentieth early: firing after the wav ran out leaves
		// a gap between loops, firing exactly at the end risks two copies
		// marching together, and a twentieth shy is inaudible as a join.
		set_task(g_alarm_len - 0.05, "task_alarm_tick", TSM_TASK_ALARM, "", 0, "b");
		dbg("alarm: siren on, trigger %d side %d, %0.2f s loop", id, g_alarm_side, g_alarm_len);
	}
	else
	{
		set_task(2.0, "task_alarm_tick", TSM_TASK_ALARM, "", 0, "b");
		dbg("alarm: text-only beat, trigger %d side %d (no wav)", id, g_alarm_side);
	}

	alarm_draw();
}

/*
 * Cut the alarm where it stands: out of the loop task and out of everyone's
 * ears. stopsound blanks the client mix for a blink, which at a round or
 * match line is the least noticeable moment there is -- and it cannot touch
 * the music, because the mp3 player runs on its own stream. The flag clears
 * for whatever attack fires the next round.
 */
alarm_stop()
{
	if (!g_alarm_on)
	{
		return;
	}

	remove_task(TSM_TASK_ALARM);
	g_alarm_on = false;
	g_alarm_side = 0;
	client_cmd(0, "stopsound");
	dbg("alarm: cut");
}

/*
 * One beat of the alarm: re-sound it, re-show the warning. It runs its round
 * out to the last play -- warmup and the next round's freeze hold no alarm,
 * and both would be reached through an alarm_stop at a stop point that
 * exists exactly so this guard is belt to that one's braces.
 */
public task_alarm_tick()
{
	if (g_state == ST_WARMUP || g_state == ST_FREEZE)
	{
		alarm_stop();
		return;
	}

	if (g_alarm_len > 0.0)
	{
		alarm_emit();
	}

	alarm_draw();
}

/*
 * The spectator team's real 1-based position in the LIVE mp_teamlist, or 0 if it is
 * not there at all.
 *
 * Trusting a configured index is dangerous: jointeam with an out-of-range index does
 * not fail quietly -- TS resolves it to an empty team name, which it treats as "put me
 * on the side with fewest players". So a stale index does the opposite of what it was
 * asked and drops the player straight into a team. mp_teamlist is also only parsed at
 * map load, so a server that has not restarted since the spectator team was configured
 * will still have a two-team table while the cvar reads three.
 */
/*
 * Is this player sitting out?
 *
 * The plugin's own team assignment WINS over what the mod reports, exactly as
 * tsm_live_team_of() does. Without that priority, picking a side left a player held
 * and invisible forever: g_match_team said team 1, but TS still had them on the
 * spectator team, and the spectator check believed TS over us.
 */
/*
 * Puts a bot on a side and gives it a class, without any interaction.
 *
 * A bot cannot use a menu or run a client command, so everything a human does by
 * choosing is done here by assignment. g_match_team is authoritative, so no jointeam
 * is needed or attempted.
 */
/*
 * Names a bot after the side it is on: "Enforcer 3", "Insurgent 1".
 *
 * The number is a slot the PLUGIN owns, not something read back out of the other
 * bots' names.
 *
 * Deriving it from names could never work. The engine renames duplicates itself, so
 * the moment two bots were both called "Insurgent 1" it rewrote the second one to
 * "(1)Insurgent 1" -- which no longer begins with the prefix, so the scan for taken
 * numbers found none and handed out 1 again to every bot after it. The scoreboard
 * showing "(1)", "(2)", "(3)" was the engine disambiguating a name collision we had
 * created, not a numbering scheme.
 */
rename_bot(id)
{
	if (!is_user_bot(id) || !get_pcvar_num(g_cv_botnames))
	{
		return;
	}

	new team = g_match_team[id];
	if (team != 1 && team != 2)
	{
		// Back in spectator: give the number up so the next bot on that side can use it.
		g_bot_slot[id] = 0;
		return;
	}

	new prefix[32];
	get_pcvar_string(team == 1 ? g_cv_botname1 : g_cv_botname2, prefix, charsmax(prefix));
	if (!prefix[0])
	{
		return;   // blank prefix means leave this side's names alone
	}

	// Which numbers the other bots on this side are holding.
	new taken[33], players[32], pnum, n;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		if (players[i] == id
			|| !is_user_bot(players[i])
			|| g_match_team[players[i]] != team)
		{
			continue;
		}

		n = g_bot_slot[players[i]];
		if (n >= 1 && n <= 32)
		{
			taken[n] = 1;
		}
	}

	// Keep the number already held unless someone else now has it -- a bot should not
	// be renumbered every time this runs.
	new slot = g_bot_slot[id];
	if (slot < 1 || slot > 32 || taken[slot])
	{
		slot = 1;
		while (slot < 32 && taken[slot])
		{
			slot++;
		}
	}
	g_bot_slot[id] = slot;

	new want[40];
	formatex(want, charsmax(want), "%s %d", prefix, slot);

	new have[32];
	have[0] = 0;
	get_user_name(id, have, charsmax(have));
	if (equal(have, want))
	{
		return;
	}

	/*
	 * Written straight into the infokey buffer, not with a "name" client command.
	 *
	 * A fake client has no client process to run a stuffcmd -- the same reason every
	 * team move here goes through engclient_cmd. SetClientKeyValue re-enters the
	 * userinfo forward, so this borrows the guard that protects the team write.
	 */
	new bool:was = g_in_userinfo[id];
	g_in_userinfo[id] = true;
	new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);
	engfunc(EngFunc_SetClientKeyValue, id, buf, "name", want);
	g_in_userinfo[id] = was;

	dbg("renamed bot %d: '%s' -> '%s' (slot %d, team %d)", id, have, want, slot, team);
}

/// How many HUMANS are on a playing side right now.
humans_playing()
{
	new players[32], pnum, n = 0;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		if (!is_user_bot(players[i])
			&& (g_match_team[players[i]] == 1 || g_match_team[players[i]] == 2))
		{
			n++;
		}
	}
	return n;
}

assign_bot(id)
{
	if (!bot_player(id))
	{
		return;
	}

	/*
	 * No bot takes a side until a human has taken one.
	 *
	 * They are actively parked rather than just left alone: TS puts every
	 * connecting client on the side with fewest players, so doing nothing here
	 * leaves a server already split across both teams before anyone arrives, and
	 * the first person to join then has to be shuffled into it.
	 *
	 * Not during a live round -- moving a player then respawns them, which throws
	 * away the loadout they are holding.
	 */
	if (humans_playing() < 1)
	{
		if (g_state != ST_LIVE && g_state != ST_FREEZE && !on_spectator_team(id))
		{
			force_spectator(id);
			dbg("bot %d parked: no human has picked a side yet", id);
		}
		return;
	}

	// Never parked as a spectator, and never locked out -- a bot is here to play.
	g_spectator[id] = false;
	g_locked_out[id] = false;

	/*
	 * Follow TS first.
	 *
	 * rcbot chooses its bots' teams and uses TS's team for target selection and
	 * spawning. Overriding that in g_match_team alone put the two views out of step --
	 * bots shot their own side and spawned at the other team's points. So if the mod
	 * already has this bot on a recognised side, that IS its side.
	 */
	new tsname[32];
	tsname[0] = 0;
	get_user_team(id, tsname, charsmax(tsname));

	new from_mod = tsm_team_from_name(tsname);

	// Where side 2 is bots only (survival), TS putting a bot on side 1 -- it seats a new
	// client on the emptier side, and the people are all on side 1 -- is not followed: the
	// bot is moved across with set_ts_team below, the one route rcbot and TS both see.
	if (from_mod == 1 && mode_flag(TSM_MODE_SIDE2_BOTS))
	{
		from_mod = 0;
	}

	if (from_mod == 1 || from_mod == 2)
	{
		if (g_match_team[id] != from_mod)
		{
			// Mirrored into g_side, which elimination does not clear: see g_side. Every route
			// that puts somebody on a side has to set it, or they stop counting toward that
			// side the moment they are benched and the match forfeits itself.
			g_match_team[id] = from_mod;
			if (g_match_team[id]) { g_side[id] = g_match_team[id]; }
			g_player_class[id] = 0;

			/*
			 * AND THE ENGINE'S OWN TEAM FIELD, which this branch was the one place that never
			 * wrote it.
			 *
			 * RCBot's team check has a fast path for two entities that both carry a real
			 * pev_team: a plain number compare, decided correctly every time. Only when
			 * either side reads 0 does it fall back to comparing MODEL STRINGS -- and that
			 * fallback is broken by design the moment two teammates are wearing different
			 * classes, which after Recon and Mech is nearly always. This branch is reached
			 * whenever TS already has the bot on a recognised side by the time assign_bot()
			 * runs, and it was the one path that synced every piece of OUR OWN bookkeeping
			 * (g_match_team, g_side, g_player_class) without ever touching pev_team -- so a
			 * bot that took this branch kept pev_team at 0 for as long as it stayed connected,
			 * RCBot's fast path never engaged for it in either direction, and it fell straight
			 * into the broken fallback against every teammate in a different class's skin.
			 * That is the actual mechanism behind bots attacking their own side.
			 *
			 * set_ts_team() is not used here on purpose: it also re-issues jointeam and resets
			 * g_model_want_idx, both redundant and both a needless risk for a bot the mod
			 * already agrees is on this side -- this is a bookkeeping sync, not a join.
			 */
			set_pev(id, pev_team, from_mod);
			dbg("bot %d follows the mod onto team %d", id, from_mod);
		}
	}
	else
	{
		/*
		 * The mod does not have this bot on a playing side, whatever g_match_team
		 * says -- and the mod is the side that counts.
		 *
		 * This used to also require g_match_team to be unset, which stranded bots
		 * for good: set_ts_team writes the side we WANTED before TS has agreed, so
		 * a single refused jointeam left our value reading team 1 while the mod
		 * still had the bot spectating -- and the condition to try again was then
		 * false forever. That is why bots never picked sides again once a finished
		 * match had parked them.
		 */
		new mode[8];
		get_pcvar_string(g_cv_botteams, mode, charsmax(mode));

		new team;
		if (mode_flag(TSM_MODE_SIDE2_BOTS))
		{
			team = 2;   // the enemy wave, whatever tsm_bot_teams says
		}
		else if (equali(mode, "1"))
		{
			team = 1;
		}
		else if (equali(mode, "2"))
		{
			team = 2;
		}
		else
		{
			// Whichever side is short, so bots fill BOTH rather than stacking one.
			team = (count_on_team(1) <= count_on_team(2)) ? 1 : 2;
		}

		// Through set_ts_team, so rcbot and TS see the move too. A bot placed only in
		// g_match_team is still on its old side to rcbot -- which is why bots were
		// shooting their own teammates.
		set_ts_team(id, team);
		dbg("bot %d assigned to team %d", id, team);
	}

	rename_bot(id);

	if (!g_player_class[id] && g_class_count)
	{
		new cmode[12];
		get_pcvar_string(g_cv_botclass, cmode, charsmax(cmode));

		new team = tsm_live_team_of(id);

		// A claimed mode's bot class comes first: Mech Warrior's bots are all mechs.
		if (g_mode_bot_class && class_open_for(id, g_mode_bot_class, team))
		{
			g_player_class[id] = g_mode_bot_class;
		}
		else if (equali(cmode, "spread"))
		{
			/*
			 * Round-robin, so a bot side is not four identical Assaults -- and round PAST anything
			 * the limits have closed. Without this the bots fill the Officer and Medic slots on
			 * their way round and the humans arrive to find the side already composed.
			 */
			new tries = 0;
			do
			{
				g_bot_class_rr = (g_bot_class_rr + 1) % g_class_count;
				tries++;
			}
			while (tries <= g_class_count && !class_open_for(id, g_bot_class_rr + 1, team));

			g_player_class[id] = g_bot_class_rr + 1;
		}
		else
		{
			new fixed = str_to_num(cmode);
			g_player_class[id] = (fixed >= 1 && fixed <= g_class_count)
				? fixed
				: resolved_class(id);

			// A fixed bot class still gives way to a full slot, or tsm_bot_class 7 is seven Officers.
			if (!class_open_for(id, g_player_class[id], team))
			{
				for (new c = 1; c <= g_class_count; c++)
				{
					if (class_open_for(id, c, team))
					{
						g_player_class[id] = c;
						break;
					}
				}
			}
		}

		dbg("bot %d given class %d", id, g_player_class[id]);
	}
}

bool:is_spectating(id)
{
	if (g_match_team[id] == 1 || g_match_team[id] == 2)
	{
		return false;
	}
	return (g_spectator[id] || on_spectator_team(id));
}

live_spectator_index()
{
	new want[32];
	get_pcvar_string(g_cv_specteam, want, charsmax(want));
	if (!want[0])
	{
		return 0;
	}

	new list[96];
	get_cvar_string("mp_teamlist", list, charsmax(list));
	if (!list[0])
	{
		return 0;
	}

	new rest[96], carry[96], name[32];
	copy(rest, charsmax(rest), list);

	for (new slot = 1; slot <= 4 && rest[0]; slot++)
	{
		strtok(rest, name, charsmax(name), carry, charsmax(carry), ';', 0);
		copy(rest, charsmax(rest), carry);

		if (name[0] && equali(name, want))
		{
			return slot;
		}
	}

	return 0;
}

/*
 * Moves a player onto a side -- for real, on BOTH sides of the fence.
 *
 * client_cmd() does not execute anything. It asks the CLIENT to run a command and send
 * it back, which is unreliable for a human and impossible for a bot (a fake client has
 * no client process to run it). Every team change in this plugin used to go through it,
 * which is why joining the Insurrectionists never worked and why bots ended up on sides
 * TS disagreed with.
 *
 * engclient_cmd (amxmodx.inc:381) runs the command server-side, immediately, and its
 * own documentation says it works for "players and bots". It is the same thing rcbot
 * does internally with FakeClientCommand.
 *
 * g_match_team is set here and ONLY here for a real side, so the plugin can never
 * believe in a move it did not make.
 */
set_ts_team(id, team)
{
	if (!is_user_connected(id) || team < 1 || team > 2)
	{
		return;
	}

	new idx[8];
	num_to_str(team, idx, charsmax(idx));

	// The one that actually does it.
	engclient_cmd(id, "jointeam", idx);

	// And the stuffcmd as well for humans -- it is the path TS's own menu uses, and a
	// second attempt costs nothing. A bot simply ignores it.
	if (!is_user_bot(id))
	{
		client_cmd(id, "jointeam %d", team);
	}

	g_match_team[id] = team;
	g_side[id] = team;
	g_spectator[id] = false;

	// Back on a side: drop any spectator-model override so the class model can take
	// over. g_model_want_idx > 0 is what fw_postthink_post force-draws, so leaving the
	// Invisible index here would keep a just-joined player unseen until the next pass.
	g_model_want_idx[id] = 0;

	/*
	 * The engine's own team field, written as well as TS's.
	 *
	 * TS does not use pev->team, so it sits at 0 for everyone -- and a bot that
	 * reads the standard field to decide who is a teammate therefore sees one big
	 * team, or none at all. Costs nothing to keep correct and it is the field any
	 * outside code would look at first.
	 */
	set_pev(id, pev_team, team);

	// Confirmed and retried, because a refusal is silent.
	g_join_tries[id] = 0;
	remove_task(id + 4000);
	set_task(1.0, "task_verify_join", id + 4000);

	dbg("set_ts_team: %d -> team %d", id, team);
}

/// The same, for moving someone out of play onto the spectator side.
set_ts_spectator(id)
{
	if (!is_user_connected(id))
	{
		return;
	}

	new spec = live_spectator_index();
	if (spec > 0)
	{
		new idx[8];
		num_to_str(spec, idx, charsmax(idx));
		engclient_cmd(id, "jointeam", idx);

		if (!is_user_bot(id))
		{
			client_cmd(id, "jointeam %d", spec);
		}
	}

	g_match_team[id] = 0;
	remove_task(id + 4000);
}

/*
 * The model index of tsm_spectator_model, or 0 when it is not installed.
 *
 * Resolved once and remembered -- the model is precached at map load, so this never
 * shifts the index table, and the per-frame model enforcement can ask for it cheaply.
 * A missing model is also remembered, or the warning would land every frame.
 */
spec_model_index()
{
	if (g_spec_model_tried)
	{
		return g_spec_model_idx;
	}
	g_spec_model_tried = true;

	new want[32];
	get_pcvar_string(g_cv_specmodel, want, charsmax(want));
	if (!want[0])
	{
		return 0;
	}

	new mpath[96];
	formatex(mpath, charsmax(mpath), "models/player/%s/%s.mdl", want, want);
	if (!file_exists(mpath))
	{
		log_amx("[TSM] WARNING: tsm_spectator_model '%s' is not installed (%s) -- anyone out of play stays visible.",
			want, mpath);
		return 0;
	}

	g_spec_model_idx = engfunc(EngFunc_ModelIndex, mpath);
	return g_spec_model_idx;
}

/*
 * Puts tsm_spectator_model on a player and makes it the ENFORCED model.
 *
 * Writing the userinfo "model" key alone is only a request -- TS answers it on the
 * next ClientUserInfoChanged with its own pick. The half that sticks is
 * g_model_want_idx, which fw_postthink_post force-draws every frame exactly the way a
 * class model is drawn, so a spectator keeps the invisible model whatever TS writes.
 *
 * Every route onto the spectator team goes through this, not just the benched-late-
 * joiner one, or choosing to spectate leaves you wearing your last class model.
 */
set_spectator_model(id)
{
	if (!is_user_connected(id))
	{
		return;
	}

	new idx = spec_model_index();
	if (idx <= 0)
	{
		return;
	}

	new want[32];
	get_pcvar_string(g_cv_specmodel, want, charsmax(want));

	g_model_want_idx[id] = idx;
	copy(g_model_chosen[id], charsmax(g_model_chosen[]), want);
	g_model_ok[id] = 1;

	// A bot has no client to run a key write through; the enforced index above is what
	// draws for it anyway.
	if (is_user_bot(id))
	{
		return;
	}

	new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);
	g_in_userinfo[id] = true;
	engfunc(EngFunc_SetClientKeyValue, id, buf, "model", want);
	g_in_userinfo[id] = false;
	copy(g_model_last[id], charsmax(g_model_last[]), want);
}

/// True when this is a bot AND bot support is switched on.
/*
 * True once an eliminated player's body may be hidden.
 *
 * The hide is re-asserted every frame, so delaying only the initial call would be
 * undone immediately -- the per-frame paths have to respect the grace period too.
 */
bool:elim_hide_due(id)
{
	if (g_elim_at[id] <= 0.0)
	{
		return true;
	}

	new Float:since = get_gametime() - g_elim_at[id];

	/*
	 * A MINIMUM, before anything else gets a say.
	 *
	 * Keying purely off "are they alive again" looked right and was not: TS is a
	 * deathmatch mod and respawns a dead player almost immediately, so that test
	 * passed within a fraction of a second and the body was hidden before it had
	 * finished falling. That is the whole of the "my body disappears instantly"
	 * complaint -- the respawn was not a sign the corpse had gone, it was the thing
	 * taking the corpse away.
	 */
	if (since < get_pcvar_float(g_cv_deathlinger))
	{
		return false;
	}

	// Past the linger, being back on their feet means there is no corpse left to
	// interrupt, so that is the moment to take them out of play.
	if (is_user_alive(id))
	{
		return true;
	}

	// Ceiling, not a delay: if TS never respawns them they cannot be left solid and
	// visible in the middle of a live round forever.
	return (since >= get_pcvar_float(g_cv_deathdelay));
}

/*
 * Holds TS's corpses on the floor, then fades them out itself.
 *
 * WHY THIS EXISTS AT ALL, since tsm_death_linger looks like it should cover it.
 *
 * The body you see is not the player. TS registers its own `deadcorpse` entity and spawns
 * one during the death sequence with a lifetime it hardcodes at ten seconds -- opaque to
 * 3.33, fading in half-second steps to 10.0, then UTIL_Remove. tsm_death_linger only says
 * how long we leave the PLAYER alone, and at 10.5 it already outlasts all of that. The
 * body still went because TS was taking it, on its own clock, and no value of ours reached
 * that.
 *
 * One think does the fade AND the removal, so holding nextthink in the future stops both.
 * Nothing is drawn, moved or re-created: the corpse TS made is simply not asked to age.
 *
 * NOTHING HERE TOUCHES A PLAYER. Every earlier attempt at this problem did, and every one
 * of them made it worse -- hiding the player before the corpse is created makes
 * TSCreateDeadCorpse return without creating anything, so no body appears at all.
 */
/*
 * Nothing is done to TS's bodies any more.
 *
 * The history, so it is not tried a fourth time. This first held the corpse by pushing its
 * nextthink into the future, which did nothing: the value was tuned from 0 up to 9.5 seconds
 * and bodies vanished identically at every setting, which is the proof that the function was
 * never acting on anything. Then it made its own copy of each body, which also did nothing.
 *
 * The reason both failed is almost certainly the same one: this searched for an entity whose
 * classname is "deadcorpse". That string IS in mp.dll, but it sits among "deadback",
 * "deadsitting", "deadstomach" and "deadtable", which are Half-Life's dead POSE names -- so
 * it is a pose, not a classname, and FindEntityByString has been matching nothing from the
 * day it was written.
 *
 * amx_tsm_ents prints every classname in the world; run it with a body on the floor and the
 * corpse is whatever is in that list and should not be. Until then this does nothing at all,
 * which is better than three mechanisms fighting over an entity that may not exist.
 */
public task_hold_corpses()
{
	return;
}

/// Forgets every corpse, so a reused entity index cannot inherit a dead body's clock.
clear_corpse_memory()
{
	for (new i = 0; i < TSM_MAXENT; i++)
	{
		g_corpse_born[i] = 0.0;
		g_corpse_clone[i] = 0;
	}
}

bool:bot_player(id)
{
	if (!get_pcvar_num(g_cv_bots))
	{
		return false;
	}
	return (is_user_bot(id) != 0);
}

/*
 * Holds a player at zero TS cash, and lends it back only while we are the buyer.
 *
 * WHY CASH, when the buy commands are already blocked.
 *
 * Blocking tkw/tka/tki stops the equipment menu writing a NEW saved loadout, and
 * that is all it stops. TS keeps the saved armament in the player's own config and
 * BuyArmament re-applies it from there on every spawn -- so anyone who bought a
 * loadout before the block went on still spawned holding it, dropped it, took the
 * class loadout on top, and collected the first one again. Two primaries, and the
 * command block never saw anything, because no buy command was ever sent.
 *
 * An empty wallet leaves BuyArmament nothing to spend, so the saved loadout cannot
 * be applied at all. usecash deliberately stays ON: the menu is SLOT-limited rather
 * than cash-limited, so switching cash off makes buying free instead of impossible.
 *
 * The one purchase that must still go through is ours, down that same BuyArmament
 * path -- so the money exists for exactly as long as g_issuing is set.
 *
 * Written only when it is not already right: this runs every frame for every player,
 * and ts_setusercash sends the client a TSCash update.
 */
hold_cash(id)
{
	if (!get_pcvar_num(g_cv_nocash) || !is_user_connected(id))
	{
		return;
	}

	new want = g_cash_lend[id] ? TSM_ARM_CASH : 0;

	if (ts_getusercash(id) != want)
	{
		ts_setusercash(id, want);
	}
}

/*
 * Switches off the three places TS hands out cash on its own: initial_cash at spawn,
 * cashforwin and cashforlose at the end of a round.
 *
 * hold_cash() already takes any of it back within a frame, but a frame is long enough
 * for the menu to spend it, so the sources are shut off too.
 *
 * These three names are not guesses -- they sit in TS's own cvar table beside
 * nopowerup and roundtime. What has no cvar is a map's own handouts: the victorycash
 * and defeatcash keyvalues on a ts_wingiver entity are baked into the .bsp. That is
 * why the per-frame hold is the actual guarantee and this only narrows the window.
 */
kill_ts_cash_cvars()
{
	if (!get_pcvar_num(g_cv_nocash) || !get_pcvar_num(g_cv_enabled))
	{
		return;
	}

	// ON, deliberately. A purchase can only be refused if there is an economy to
	// refuse it: with usecash 0, CashBased() is false, nothing is ever charged, and
	// the equipment menu -- which is slot-limited, not cash-limited -- is free.
	set_cvar_num("usecash", 1);

	set_cvar_num("initial_cash", 0);
	set_cvar_num("cashforwin",   0);
	set_cvar_num("cashforlose",  0);
}

/* ---- classes: definitions and selection menu ----------------------------- */

/*
 * Parses one weapon list -- "5:3,22:2" -- into a class/team slot.
 *
 * Each entry is tsweaponid:extraclips. IDs are TS's own, from ts/ts_fgd.fgd:
 *   5 M4A1    9 Socom Mk23   13 AK47    18 Barrett M82   22 Glock 20
 *   23 HK UMP  25 Combat Knife  32 M60   34 Katana
 * 8, 10, 16 and 29 are gaps in TS's own list, not typos.
 */
parse_weapon_list(idx, team, const field[])
{
	g_class_wcount[idx][team] = 0;

	new rest[96], carry[96], pair[32], wpart[16], cpart[16];
	copy(rest, charsmax(rest), field);

	// Iteration cap: strtok cannot shrink an input it fails to split, so a malformed
	// cvar would spin here forever without it.
	for (new guard = 0; guard < TSM_MAXWPN && rest[0]; guard++)
	{
		strtok(rest, pair, charsmax(pair), carry, charsmax(carry), ',', 0);
		copy(rest, charsmax(rest), carry);
		if (!pair[0])
		{
			continue;
		}

		strtok(pair, wpart, charsmax(wpart), cpart, charsmax(cpart), ':', 0);
		new wid = str_to_num(wpart);
		if (wid < 1 || wid > 36)
		{
			tlog("[TSM] class %d team %d: ignoring out-of-range weapon id %d", idx + 1, team, wid);
			continue;
		}

		new n = g_class_wcount[idx][team];
		g_class_wpn[idx][team][n]   = wid;
		g_class_clips[idx][team][n] = str_to_num(cpart);
		g_class_wcount[idx][team]   = n + 1;
	}
}

/*
 * Parses one tsm_classN cvar.
 *
 * Format:  Name;team1weapons;team2weapons;model;health;armour;perk
 *
 * The two weapon lists let one class be asymmetric -- Assault carries an M4A1 for MSR
 * and an AK47 for the Insurrectionists -- without needing two separate classes and two
 * menu entries. A blank team2 list means both teams carry the same thing.
 */
parse_class(idx, const spec[])
{
	new rest[TSM_SPEC], carry[TSM_SPEC], field[TSM_MODELFIELD];
	copy(rest, charsmax(rest), spec);

	// 1: display name
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	copy(g_class_name[idx], charsmax(g_class_name[]), field);
	copy(rest, charsmax(rest), carry);

	// 2: team 1 weapons
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	parse_weapon_list(idx, 1, field);
	copy(rest, charsmax(rest), carry);

	// 3: team 2 weapons, or a copy of team 1 when left blank
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	copy(rest, charsmax(rest), carry);
	if (field[0])
	{
		parse_weapon_list(idx, 2, field);
	}
	else
	{
		g_class_wcount[idx][2] = g_class_wcount[idx][1];
		for (new i = 0; i < g_class_wcount[idx][1]; i++)
		{
			g_class_wpn[idx][2][i]   = g_class_wpn[idx][1][i];
			g_class_clips[idx][2][i] = g_class_clips[idx][1][i];
		}
	}

	/*
	 * 4: models, as team1|team2, each one a comma-separated list to pick from.
	 *
	 *     repuheavy|XCCPSoldier-wartorn,XCCPmutant
	 *
	 * | splits the two sides, matching mp_teammodels, where | also separates teams.
	 * Random choices are listed with , rather than mp_teammodels' ; because ; is
	 * already this table's field separator and cannot be reused.
	 *
	 * A blank side falls back to that side's Assault model, resolved at apply time
	 * rather than copied here, so editing Assault updates everything that leans on
	 * it.
	 */
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	copy(rest, charsmax(rest), carry);

	new mt1[TSM_MODELLIST], mt2[TSM_MODELLIST];
	strtok(field, mt1, charsmax(mt1), mt2, charsmax(mt2), '|', 0);
	copy(g_class_model[idx][1], charsmax(g_class_model[][]), mt1);
	copy(g_class_model[idx][2], charsmax(g_class_model[][]), mt2);

	// 5: health
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	g_class_hp[idx] = str_to_num(field);
	if (g_class_hp[idx] < 1)
	{
		g_class_hp[idx] = 100;
	}
	copy(rest, charsmax(rest), carry);

	// 6: armour
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	g_class_ap[idx] = str_to_num(field);
	copy(rest, charsmax(rest), carry);

	// 7: perk
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	g_class_perk[idx] = str_to_num(field);
	copy(rest, charsmax(rest), carry);

	// 8: speed multiplier, optional. Absent or 0 means normal speed.
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
	g_class_speed[idx] = str_to_float(field);
	if (g_class_speed[idx] <= 0.0)
	{
		g_class_speed[idx] = 1.0;
	}
	copy(rest, charsmax(rest), carry);

	/*
	 * 9: how tall the model is drawn. Optional; absent or 0 means normal.
	 *
	 * HELD TO A NARROW RANGE ON PURPOSE, and the reason is worth knowing before using it.
	 * This scales what is DRAWN and nothing else. GoldSrc gives every player the same
	 * movement hull -- the engine's own, not the entity's mins and maxs -- so a taller
	 * Heavy still fits through exactly the same gaps and ducks under exactly the same
	 * pipes. More to the point his HITBOX does not grow with him, so the head you can see
	 * above the normal silhouette is not a head you can shoot.
	 *
	 * At 1.1 that mismatch is a few inches and reads as a big man. Past about 1.50 it
	 * becomes a man you can shoot through, so the cvar is clamped rather than trusted.
	 */
	g_class_scale[idx] = str_to_float(rest);
	if (g_class_scale[idx] <= 0.0)
	{
		g_class_scale[idx] = 1.0;
	}
	if (g_class_scale[idx] < 0.80) { g_class_scale[idx] = 0.80; }
	if (g_class_scale[idx] > 1.50) { g_class_scale[idx] = 1.50; }
}

load_classes()
{
	g_class_count = 0;

	new cvname[24], spec[TSM_SPEC];
	for (new i = 0; i < TSM_MAXCLASS; i++)
	{
		formatex(cvname, charsmax(cvname), "tsm_class%d", i + 1);

		new pc = get_cvar_pointer(cvname);
		if (!pc)
		{
			continue;
		}
		get_pcvar_string(pc, spec, charsmax(spec));
		if (!spec[0])
		{
			continue;
		}

		parse_class(g_class_count, spec);
		tlog("[TSM] class %d '%s': t1=%d wpn t2=%d wpn, models t1='%s' t2='%s', %dhp %dap, perk %d, speed x%.2f",
			g_class_count + 1, g_class_name[g_class_count],
			g_class_wcount[g_class_count][1], g_class_wcount[g_class_count][2],
			g_class_model[g_class_count][1], g_class_model[g_class_count][2],
			g_class_hp[g_class_count],
			g_class_ap[g_class_count], g_class_perk[g_class_count],
			g_class_speed[g_class_count]);
		g_class_count++;
	}

	if (!g_class_count)
	{
		tlog("[TSM] No classes defined. Set tsm_class1 and up, or classes stay off.");
	}

	load_class_limits();
	load_class_lives();
}

/*
 * Reads tsm_class_limits: a comma list, one number per class in tsm_classN order.
 *
 *     tsm_class_limits "0,4,2,2,4,2,1"
 *
 * Position 1 is tsm_class1. 0, blank or missing means no limit, so a short list leaves the rest
 * unlimited and an empty cvar turns the whole thing off -- which is what it ships as.
 */
load_class_limits()
{
	for (new i = 0; i < TSM_MAXCLASS; i++)
	{
		g_class_limit[i] = 0;
	}

	new spec[128];
	get_pcvar_string(g_cv_classlimits, spec, charsmax(spec));
	if (!spec[0])
	{
		return;
	}

	new rest[128], field[16], carry[128], idx = 0;
	copy(rest, charsmax(rest), spec);

	while (rest[0] && idx < TSM_MAXCLASS)
	{
		strtok(rest, field, charsmax(field), carry, charsmax(carry), ',', 1);
		trim(field);
		g_class_limit[idx] = str_to_num(field);
		if (g_class_limit[idx] < 0)
		{
			g_class_limit[idx] = 0;
		}
		idx++;
		copy(rest, charsmax(rest), carry);
	}

	for (new i = 0; i < g_class_count; i++)
	{
		if (g_class_limit[i])
		{
			tlog("[TSM] Class limit: %s, %d a side.", g_class_name[i], g_class_limit[i]);
		}
	}
}

/// Whether class `cls` (1-based) is played at all on this map: a claimed mode can leave classes out.
bool:class_offered(cls)
{
	return !g_mode_classes || g_mode_class_limit[cls - 1] >= 0;
}

/// A class's limit a side: the mode's when it set rules, else tsm_class_limits. 0 is no limit.
class_limit_of(cls)
{
	if (g_mode_classes)
	{
		return (g_mode_class_limit[cls - 1] > 0) ? g_mode_class_limit[cls - 1] : 0;
	}
	return g_class_limit[cls - 1];
}

/// The lives a class carries: the mode's when it gave some, else tsm_class_lives.
class_lives_of(cls)
{
	if (g_mode_classes && g_mode_class_lives[cls - 1] > 0)
	{
		return g_mode_class_lives[cls - 1];
	}
	return g_class_lives[cls - 1];
}

/// The class anyone gets who has none, or holds one this map leaves out: the mode's bot class, else
/// tsm_default_class, else the first class played here.
default_class()
{
	if (g_mode_bot_class >= 1 && g_mode_bot_class <= g_class_count && class_offered(g_mode_bot_class))
	{
		return g_mode_bot_class;
	}
	new c = get_pcvar_num(g_cv_defclass);
	if (c >= 1 && c <= g_class_count && class_offered(c))
	{
		return c;
	}
	for (c = 1; c <= g_class_count; c++)
	{
		if (class_offered(c))
		{
			return c;
		}
	}
	return 1;
}

/*
 * How many players on `team` are already that class. `cls` is 1-based, as g_player_class is.
 *
 * Counts the whole side, living and dead: a limit is a composition rule for the match and not a
 * headcount of who happens to be breathing, and a Medic who has just been shot has not freed his
 * slot for somebody else.
 */
count_class_on_team(cls, team)
{
	new n = 0;
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		if (g_player_class[players[i]] == cls && tsm_live_team_of(players[i]) == team)
		{
			n++;
		}
	}
	return n;
}

/*
 * Whether `id` may still take class `cls` (1-based).
 *
 * EVERY CLASS BEING FULL DOES NOT BLOCK ANYBODY. Limits that add up to less than a side's size are
 * easy to write by accident, and a player who cannot be given any class at all would spawn with no
 * loadout and no model. So when nothing is open the limits stand aside: a side of ten with two of
 * everything is better than a side of ten with eight of them holding nothing.
 */
bool:class_open_for(id, cls, team)
{
	// A class the claimed mode leaves out is never open, limits or no limits.
	if (cls < 1 || cls > g_class_count || !class_offered(cls))
	{
		return false;
	}
	new limit = class_limit_of(cls);
	if (!limit)
	{
		return true;
	}
	// Already his: re-picking what he is holding is not a second slot.
	if (g_player_class[id] == cls)
	{
		return true;
	}
	if (count_class_on_team(cls, team) < limit)
	{
		return true;
	}

	for (new i = 1; i <= g_class_count; i++)
	{
		if (class_offered(i) && (!class_limit_of(i) || count_class_on_team(i, team) < class_limit_of(i)))
		{
			return false;   // something else is open, so he takes that instead
		}
	}
	return true;            // nothing is open anywhere: the limits give way
}

/// A class picked from the menu, 0 being the first. class_menu_key() reads the key press.
pick_class(id, item)
{
	if (item >= 0 && item < g_class_count)
	{
		// Locked for the rest of the match: the class IS the loadout, so swapping it
		// mid-match would be the economy this replaced.
		if (g_player_class[id] && g_state != ST_WARMUP && g_state != ST_READYUP)
		{
			client_print(id, print_chat, "[MATCH] You are already %s for this match.",
				g_class_name[g_player_class[id] - 1]);
		}
		else if (!class_offered(item + 1))
		{
			client_print(id, print_chat, "[MATCH] %s is not played on this map. Pick another.", g_class_name[item]);
			show_class_menu(id);
		}
		else if (!class_open_for(id, item + 1, tsm_live_team_of(id)))
		{
			/*
			 * Checked again HERE, not only when the menu was drawn. Everyone picks at once during
			 * the freeze, so the last slot can go to somebody else between the menu appearing on
			 * his screen and his finger coming down on the key.
			 */
			client_print(id, print_chat, "[MATCH] %s is full -- %d a side. Pick another.",
				g_class_name[item], class_limit_of(item + 1));
			show_class_menu(id);
		}
		else
		{
			g_player_class[id] = item + 1;
			client_print(id, print_chat, "[MATCH] You are %s. That is your class for the whole match.",
				g_class_name[item]);

			/*
			 * The loadout for this round was already written, using the default class,
			 * before the menu was shown -- so it is rewritten now or the pick would not
			 * take effect until the next round.
			 *
			 * Dispatched by task name rather than called directly: issue_armament() is
			 * defined further down the file and this compiler rejects forward references.
			 */
			if (g_state == ST_FREEZE)
			{
				set_task(0.1, "task_reissue_armament", id + 5000);
			}

			/*
			 * And the model, now, in every state.
			 *
			 * Picking a class only rewrote the WEAPONS, and only during the freeze. The
			 * model was left for whatever happened to touch it next, so choosing a
			 * loadout visibly did not change how you looked.
			 */
			new bool:cwas = g_in_userinfo[id];
			g_in_userinfo[id] = true;
			set_class_model(id, g_player_class[id] - 1);
			g_in_userinfo[id] = cwas;
		}
	}
}

/*
 * menu_cancel() guarded.
 *
 * Calling it for a player who is not fully in game raises an AMXX run-time error
 * ("Played N is not in game"), which was filling the error log whenever a menu was
 * dismissed around a connect or a disconnect.
 */
close_menu(id)
{
	if (is_user_connected(id))
	{
		menu_cancel(id);
	}
}

/// A side picked from the menu: 0 and 1 are the two teams, anything else spectates.
pick_side(id, item)
{
	if (item == 0 || item == 1)
	{
		// Sides are fixed for the duration of a match. A late joiner waits it out.
		if (g_state != ST_WARMUP && g_state != ST_READYUP)
		{
			client_print(id, print_chat, "[MATCH] A match is already in progress -- join when it finishes.");
			return;
		}

		new team = item + 1;
		new name[32];
		team_rawname(team, name, charsmax(name));

		/*
		 * Side 2 is the enemy wave in a mode that made it bots only (survival): a person
		 * picking it is made a spectator instead, and told where to go to play.
		 */
		if (team == 2 && mode_flag(TSM_MODE_SIDE2_BOTS) && !bot_player(id))
		{
			new s1[48];
			get_pcvar_string(g_cv_t1label, s1, charsmax(s1));
			if (!s1[0])
			{
				team_rawname(1, s1, charsmax(s1));
			}
			force_spectator(id);
			client_print(id, print_chat, "[MATCH] That side is the enemy wave in this mode -- you are spectating. Join %s to play.", s1);
			dbg("team menu: %d refused side 2 (bots only in this mode), spectating", id);
			return;
		}

		/*
		 * Refuse a pick that would unbalance the sides.
		 *
		 * Checked here rather than only at ready-up, because being told "the teams are
		 * uneven" after everyone has already picked is no use -- this steers people to
		 * the side that needs them while they are still choosing. Not where side 2 is
		 * bots by design: that side is meant to outnumber the people.
		 */
		new bmode[16];
		get_pcvar_string(g_cv_balmode, bmode, charsmax(bmode));

		if (!equali(bmode, "off") && !equali(bmode, "warn") && !mode_flag(TSM_MODE_SIDE2_BOTS))
		{
			new n1 = count_on_team(1);
			new n2 = count_on_team(2);

			// Their own arrival counts towards the gap.
			if (team == 1) { n1++; } else { n2++; }

			new gap = n1 - n2;
			if (gap < 0)
			{
				gap = -gap;
			}

			if (gap > get_pcvar_num(g_cv_balgap))
			{
				new other[32];
				team_rawname(team == 1 ? 2 : 1, other, charsmax(other));
				client_print(id, print_chat,
					"[MATCH] %s is full relative to %s. Join %s instead.", name, other, other);
				dbg("balance: refused %d joining team %d (would be %d v %d)", id, team, n1, n2);

				g_team_menu_at[id] = 0.0;
				set_task(0.5, "task_show_side", id + 2000);
				return;
			}
		}

		g_spectator[id] = false;
		remove_task(id + 1000);   // no longer waiting to be parked as a spectator

		// One call that moves them on BOTH sides. See set_ts_team().

		new shown[48];
		get_pcvar_string(team == 1 ? g_cv_t1label : g_cv_t2label, shown, charsmax(shown));
		if (!shown[0])
		{
			copy(shown, charsmax(shown), name);
		}

		/*
		 * jointeam takes an INDEX, not a name. TS's own client sends "jointeam %d" --
		 * 1 to 4 for the four teams in mp_teamlist. Sending the team NAME parses as
		 * index 0 and is silently ignored, which is why picking a side did nothing.
		 */
		set_ts_team(id, team);
		client_print(id, print_chat, "[MATCH] Joining %s...", shown);

		/*
		 * Straight on to the class menu, the same way the side menu itself arrives.
		 * Waiting for the warmup tick to notice meant the class menu depended on a
		 * different code path to the one that demonstrably works, and it never showed.
		 * Chaining them makes the second menu as reliable as the first.
		 */


		dbg("team menu: %d -> jointeam %d (%s)", id, team, name);
	}
	else
	{
		g_spectator[id] = true;
		set_ts_spectator(id);
		set_spectator_model(id);

		client_print(id, print_chat, "[MATCH] Spectating. Type .team when you want to play.");
		dbg("team menu: %d -> spectate", id);
	}
}

/// The side menu key press, 0-based: 1. and 2. are the teams, 3. spectates, 0. exits.
public team_menu_key(id, key)
{
	if (key <= 2)
	{
		pick_side(id, key);
	}
	return PLUGIN_HANDLED;
}

/*
 * Built from the live team names rather than hardcoded, and rebuilt whenever those
 * names are re-forced, so the menu can never offer a team the mod does not have.
 */
build_team_menu()
{
	g_team_menu = 0;

	new t1[32], t2[32];
	team_rawname(1, t1, charsmax(t1));
	team_rawname(2, t2, charsmax(t2));
	if (!t1[0] || !t2[0])
	{
		return;
	}

	/*
	 * COLOUR, because a background is not on offer.
	 *
	 * These are the engine's own text menus -- a ShowMenu usermsg -- drawn straight over
	 * whatever the player is looking at, with no layer behind them. A server plugin has
	 * no way to put a sprite or a panel under one; the only thing it controls is the text.
	 *
	 * So contrast comes from the text itself. The client reads four codes, and they are its
	 * palette rather than ours: \r red, \y warm orange, \w white, \d dim grey. A colour runs on
	 * across lines until the next code. The pick menus are orange throughout -- it reads on a
	 * bright wall where white washed out -- with \d dimming only what is not the main choice.
	 *
	 * Sent raw with show_menu() rather than built with menu_create(): AMXX strips every code out
	 * of a menu_create() menu on a mod it does not know, and TS is one, which is why these menus
	 * were plain white. No title line either, just the choices.
	 */

	// Displayed names fall back to the join names when no long label is configured,
	// so the menu still reads sensibly on a server that never set them.
	new l1[48], l2[48];
	get_pcvar_string(g_cv_t1label, l1, charsmax(l1));
	get_pcvar_string(g_cv_t2label, l2, charsmax(l2));
	if (!l1[0])
	{
		copy(l1, charsmax(l1), t1);
	}
	if (!l2[0])
	{
		copy(l2, charsmax(l2), t2);
	}

	formatex(g_team_menu_text, charsmax(g_team_menu_text),
		"\y1. Join %s^n2. Join %s^n\d3. Spectate Match\y^n^n0. Exit", l1, l2);
	g_team_menu_keys = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 9);
	g_team_menu = 1;
}

show_team_menu(id)
{
	// tsm_enabled 0 means the server is running TS's own game: there is no match side
	// to pick, so no menu and no side-count chat line. This also stops a queued task
	// from putting the menu back after a map has disabled the plugin.
	if (!get_pcvar_num(g_cv_enabled))
	{
		return;
	}

	// A bot can never answer a menu -- these are re-offered on a timer, which
	// would otherwise retry against it forever.
	if (bot_player(id))
	{
		return;
	}

	if (!is_user_connected(id) || !g_team_menu)
	{
		return;
	}
	// Sides can be changed freely during warmup and are locked once a match starts.
	// The old rule refused the menu to anyone already on a side, which meant a player
	// could never switch -- including off an over-full team the balance check was
	// complaining about.
	if ((g_match_team[id] == 1 || g_match_team[id] == 2)
		&& g_state != ST_WARMUP && g_state != ST_READYUP)
	{
		return;
	}
	g_team_menu_at[id] = get_gametime();

	// The counts matter when picking: the balance rule will refuse the fuller side,
	// and without this the refusal arrives with no warning.
	new sn1[32], sn2[32];
	team_short(1, sn1, charsmax(sn1));
	team_short(2, sn2, charsmax(sn2));
	client_print(id, print_chat, "[MATCH] Sides: %s %d -- %d %s",
		sn1, count_on_team(1), count_on_team(2), sn2);

	show_menu(id, g_team_menu_keys, g_team_menu_text, -1, TSM_SIDE_MENU);
	dbg("showed side menu to %d", id);
	client_print(id, print_chat, "[MATCH] Close any TS menu first, then press a number. Type .team to bring this back.");
}

/*
 * Says classes are ready to offer. The menu itself is drawn per player in show_class_menu(),
 * because what it says depends on his side, so there is nothing to build here but the flag.
 */
build_class_menu()
{
	g_class_menu = g_class_count ? 1 : 0;
}

/*
 * Confirms a side pick actually took on the mod's side, and retries if it did not.
 *
 * jointeam is fire-and-forget: it is a client command, it can be refused silently,
 * and TS gives no feedback either way. Issuing it once and assuming it worked is why
 * players could sit on the spectator team while the plugin believed otherwise.
 */
public task_verify_join(taskid)
{
	new id = taskid - 4000;

	if (!is_user_connected(id))
	{
		return;
	}

	new want = g_match_team[id];
	if (want != 1 && want != 2)
	{
		return;   // they are not trying to be on a side any more
	}

	new wantname[32];
	team_rawname(want, wantname, charsmax(wantname));

	new live[32];
	live[0] = 0;
	new livenum = get_user_team(id, live, charsmax(live));

	if (live[0] && equali(live, wantname))
	{
		dbg("join confirmed: %d is on '%s' after %d attempt(s)", id, live, g_join_tries[id]);
		g_join_tries[id] = 0;
		return;
	}

	g_join_tries[id]++;

	if (g_join_tries[id] > 3)
	{
		// The plugin still counts them as playing -- g_match_team is authoritative --
		// so the match works. Only TS's own scoreboard and team chat will disagree.
		tlog("[TSM] jointeam %d did not take for player %d after 3 tries (mod reports #%d '%s').",
			want, id, livenum, live);

		/*
		 * A team index of -1 with an EMPTY name is the signature of non-teamplay
		 * gamerules. TS picks its gamerules once per map load, and on CHalfLifeMultiplay
		 * the team functions are inherited stubs: GetTeamIndex always returns -1 and
		 * ChangePlayerTeam is a no-op, so no jointeam can ever succeed.
		 */
		if (livenum == -1 && !live[0])
		{
			tlog("[TSM] This server is running NON-TEAMPLAY gamerules, so jointeam cannot work at all.");
			tlog("[TSM] mp_teamplay must be 1 BEFORE the map loads. server.cfg is too late on a dedicated server -- put it in ts/game.cfg, then changelevel.");
		}

		/*
		 * Adopt whatever TS says rather than holding a value it disagrees with.
		 *
		 * A wrong-but-consistent team is playable: spawns, models, kill reports and
		 * rcbot's own target selection all line up. A SPLIT view is not -- that is what
		 * put players on spectator wearing the wrong model, and had bots shooting their
		 * own teammates.
		 */
		new adopted = tsm_team_from_name(live);
		if (adopted == 1 || adopted == 2)
		{
			// Mirrored into g_side, which elimination does not clear: see g_side. Every route
			// that puts somebody on a side has to set it, or they stop counting toward that
			// side the moment they are benched and the match forfeits itself.
			g_match_team[id] = adopted;
			if (g_match_team[id]) { g_side[id] = g_match_team[id]; }
			tlog("[TSM] Adopting the mod's answer: player %d is on team %d.", id, adopted);
		}
		g_join_tries[id] = 0;
		return;
	}

	dbg("join retry %d for %d: wanted '%s', mod reports #%d '%s'",
		g_join_tries[id], id, wantname, livenum, live);

	/*
	 * Deferred rather than sent, while a loadout is being written.
	 *
	 * TS respawns a player as part of changing their team, which discards the armament
	 * that was just applied -- weapons and ammunition both. A re-join landing in the
	 * middle of the round-start loadout is how players ended up with no ammo.
	 */
	if (g_issuing[id] || g_state == ST_FREEZE)
	{
		set_task(1.0, "task_verify_join", taskid);
		return;
	}

	// engclient_cmd, not client_cmd: it executes server-side and works for bots.
	new ridx[8];
	num_to_str(want, ridx, charsmax(ridx));
	engclient_cmd(id, "jointeam", ridx);

	if (!is_user_bot(id))
	{
		client_cmd(id, "jointeam %d", want);
	}

	set_task(1.0, "task_verify_join", taskid);
}

public task_show_side(taskid)
{
	new id = taskid - 2000;
	if (!is_user_connected(id) || tsm_live_team_of(id))
	{
		return;
	}
	show_team_menu(id);
}

public task_show_class(id)
{
	if (!is_user_connected(id) || g_player_class[id])
	{
		return;
	}
	show_class_menu(id);
}

/*
 * Whether a class pick can take effect right now.
 *
 * ONLY during the freeze countdown. That is where issue_armament() runs, so it is the
 * only moment choosing a class does anything -- outside it the pick was accepted, the
 * player was told "that is your class for the whole match", and then begin_match()
 * zeroed it on the way in. They were being lied to.
 *
 * Ready-up matters more than it looks: halt_for_imbalance() parks a LIVE match in
 * ST_READYUP with the score intact, so "we are in ready-up" does not mean "no match is
 * running". Letting a pick through there let someone re-pick mid-match, and that one
 * survived, because resume_match() deliberately leaves classes alone.
 *
 * One predicate, used by every route in, so the next route added cannot forget.
 */
bool:may_pick_class(id)
{
	if (!is_user_connected(id) || !g_class_count || !g_class_menu)
	{
		return false;
	}
	if (!get_pcvar_num(g_cv_classes))
	{
		return false;
	}
	if (g_state != ST_FREEZE)
	{
		return false;
	}
	if (g_locked_out[id] || !tsm_live_team_of(id))
	{
		return false;
	}
	return true;
}

/** One player's class menu, on its own frame. See the freeze tick for why it is spread out. */
public task_offer_class_menu(taskid)
{
	show_class_menu(taskid - 14000);
}

/*
 * Takes the class menu off his screen once a pick can no longer count. Only if it is still the
 * menu he has up: anything he opened since is his, and is left alone.
 */
drop_class_menu(id)
{
	if (!is_user_connected(id) || bot_player(id))
	{
		return;
	}
	new menu, newmenu;
	if (player_menu_info(id, menu, newmenu) && menu == g_class_menuid)
	{
		show_menu(id, 0, "^n", -1, "");
	}
}

show_class_menu(id)
{
	// A bot can never answer a menu -- these are re-offered on a timer, which
	// would otherwise retry against it forever.
	if (bot_player(id))
	{
		return;
	}

	// Everything funnels through here, so this is where the state rule lives. The
	// routes that a player drives say WHY they were refused; this one is the backstop
	// and stays silent.
	if (!may_pick_class(id))
	{
		return;
	}

	if (!is_user_connected(id) || !g_class_menu || !g_class_count)
	{
		return;
	}
	// Locked once picked. The freeze is the only state that reaches here now, so there
	// is no warmup exemption to make: a class is chosen once per match.
	if (g_player_class[id])
	{
		return;
	}

	/*
	 * Built fresh for him, every time, so the counts are the counts as they are NOW. A menu made
	 * once at map start would show a Medic slot as open for the whole match.
	 */
	new team = tsm_live_team_of(id);

	/*
	 * Every class on one page, numbered from 1 -- a tenth class takes 0, and the Exit line goes.
	 * The class in orange and its health dimmed: the name is what is being chosen, the number is
	 * only there to compare with. Nine lines come to about 400 bytes, inside the 512 the client
	 * keeps for a menu.
	 */
	new text[512], len = 0, keys = 0;
	for (new i = 0; i < g_class_count && i < 10; i++)
	{
		// A class this map's mode leaves out is not offered at all; the others keep their numbers.
		if (!class_offered(i + 1))
		{
			continue;
		}
		new key = (i == 9) ? 0 : i + 1;
		new lv = get_pcvar_num(g_cv_respawns) ? class_lives_of(i + 1) : 1;
		keys |= (1 << i);

		if (!class_limit_of(i + 1))
		{
			len += formatex(text[len], charsmax(text) - len, "\y%d. %s  \d[%d hp, %d %s]\y^n",
				key, g_class_name[i], g_class_hp[i], lv, (lv == 1) ? "life" : "lives");
		}
		else
		{
			/*
			 * HOW MANY ARE LEFT, not how many are taken. "(1)" is the question a player is
			 * actually asking -- can I still have one -- and 2/4 makes him do the subtraction.
			 */
			new free = class_limit_of(i + 1) - count_class_on_team(i + 1, team);
			if (free < 0)
			{
				free = 0;
			}

			if (!class_open_for(id, i + 1, team))
			{
				// Still listed, and still pressable: pick_class() says no and says why. Hiding it
				// would leave the numbers beside the other classes meaning nothing.
				len += formatex(text[len], charsmax(text) - len, "\d%d. %s  [%d hp, %d %s]  (full)\y^n",
					key, g_class_name[i], g_class_hp[i], lv, (lv == 1) ? "life" : "lives");
			}
			else
			{
				len += formatex(text[len], charsmax(text) - len, "\y%d. %s  \d[%d hp, %d %s]  \y(%d left)^n",
					key, g_class_name[i], g_class_hp[i], lv, (lv == 1) ? "life" : "lives", free);
			}
		}
	}
	if (g_class_count < 10)
	{
		len += formatex(text[len], charsmax(text) - len, "^n\y0. Exit");
		keys |= (1 << 9);
	}

	g_class_menu_at[id] = get_gametime();
	show_menu(id, keys, text, -1, TSM_CLASS_MENU);
	dbg("showed class menu to %d", id);
}

/*
 * The class menu key press, 0-based: keys 1-9 are the first nine classes, 0 the tenth if there
 * is one and Exit otherwise.
 *
 * A raw menu stays on screen until something replaces it, so a key can arrive after the freeze
 * has ended. may_pick_class() is asked again here for exactly that: a pick outside the freeze
 * would never reach the loadout.
 */
public class_menu_key(id, key)
{
	if (key < g_class_count && may_pick_class(id))
	{
		pick_class(id, key);
	}
	return PLUGIN_HANDLED;
}

/*
 * Precaches one player model if it is actually on disk.
 *
 * Precaching a path that does not exist takes the server down, so the check is not
 * optional. A name that is in the class table but not installed is skipped and logged
 * rather than being allowed to kill the map load.
 */
precache_player_model(const name[])
{
	if (!name[0])
	{
		return;
	}

	new path[160];
	formatex(path, charsmax(path), "models/player/%s/%s.mdl", name, name);

	if (!file_exists(path))
	{
		tlog("[TSM] WARNING: class model '%s' is not installed (%s) -- players assigned it will fall back to the default model.",
			name, path);
		return;
	}

	/*
	 * TS BUILDS THIS PATH INTO 64 BYTES OF ITS OWN and does not check it.
	 *
	 * Our buffer is 160 and precaches fine, so nothing fails here. The kill comes later,
	 * when TS re-applies its own model pick: it formats models/player/<name>/<name>.mdl
	 * into a 64-byte buffer, a long name loses its tail, and the engine takes the whole
	 * server down with
	 *
	 *     FATAL ERROR (shutting down): Mod_NumForName: models/player/X/X not found
	 *
	 * on a path that is cut mid-word. There is no plugin error and nothing in the AMXX
	 * log, just a server that restarts the map over and over.
	 *
	 * 19 characters of fixed text plus the name twice has to fit in 63, so the name has
	 * to be 22 or fewer. XCCPsgts_wrecked_gear_lost was 26 and did exactly this.
	 */
	if (strlen(path) > 63)
	{
		log_amx("[TSM] FATAL-IF-USED: class model '%s' makes a %d character path and TS truncates at 63. Rename the folder and file to 22 characters or fewer. NOT precaching it.",
			name, strlen(path));
		return;
	}

	precache_model(path);
	g_precached++;
}

/// Precaches every model named in one class spec's model field.
precache_models_in_spec(const spec[])
{
	new rest[TSM_SPEC], carry[TSM_SPEC], field[TSM_MODELFIELD];
	copy(rest, charsmax(rest), spec);

	// Fields 1-3 are name and the two weapon lists; field 4 is the models.
	for (new skip = 0; skip < 3; skip++)
	{
		strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);
		copy(rest, charsmax(rest), carry);
	}
	strtok(rest, field, charsmax(field), carry, charsmax(carry), ';', 0);

	// field is now team1|team2, each a comma-separated list.
	new sides[2][TSM_MODELLIST], one[TSM_MODELLIST], two[TSM_MODELLIST];
	strtok(field, one, charsmax(one), two, charsmax(two), '|', 0);
	copy(sides[0], charsmax(sides[]), one);
	copy(sides[1], charsmax(sides[]), two);

	for (new t = 0; t < 2; t++)
	{
		new list[TSM_MODELLIST], item[64], tail[TSM_MODELLIST];
		copy(list, charsmax(list), sides[t]);

		for (new guard = 0; guard < TSM_MAXMODELS && list[0]; guard++)
		{
			strtok(list, item, charsmax(item), tail, charsmax(tail), ',', 0);
			copy(list, charsmax(list), tail);
			precache_player_model(item);
		}
	}
}

/*
 * Precaches every model the class table can hand out.
 *
 * WHY THIS EXISTS
 *
 * mp_teammodels was being trusted to do this, and it does not. Models past the first
 * few on a side never got precached, so writing one of those names at runtime gave the
 * client a model index it had never been told about -- which renders as the default
 * player model. That is the "some insurgent models load null and show as gordon" bug:
 * the names were correct and the files were present, they had simply never been
 * precached.
 *
 * The config FILE is read rather than the cvars, because plugin_precache runs long
 * before amxx execs ts_matchmode.cfg -- at this point the cvars still hold their
 * compiled-in defaults, which are not necessarily what the server is running.
 */
precache_class_models()
{
	new cfg[128];
	get_configsdir(cfg, charsmax(cfg));
	formatex(cfg, charsmax(cfg), "%s/ts_matchmode.cfg", cfg);

	if (!file_exists(cfg))
	{
		tlog("[TSM] %s not found at precache time -- falling back to the built-in class defaults.", cfg);
	}

	new line[TSM_LINE], spec[TSM_SPEC], len;
	for (new i = 0; i < 10; i++)
	{
		new want[16];
		formatex(want, charsmax(want), "tsm_class%d", i + 1);

		spec[0] = 0;

		// The live value from the config file, if it is there.
		if (file_exists(cfg))
		{
			new ln = 0;
			while (read_file(cfg, ln++, line, charsmax(line), len))
			{
				trim(line);
				if (line[0] == ';' || (line[0] == '/' && line[1] == '/'))
				{
					continue;
				}
				if (containi(line, want) != 0)
				{
					continue;
				}

				// Everything between the first and last quote on the line.
				new q1 = -1, q2 = -1;
				for (new c = 0; line[c]; c++)
				{
					if (line[c] == '"')
					{
						if (q1 < 0) { q1 = c; } else { q2 = c; }
					}
				}
				if (q1 >= 0 && q2 > q1 + 1)
				{
					copy(spec, (q2 - q1 - 1 < charsmax(spec)) ? (q2 - q1 - 1) : charsmax(spec), line[q1 + 1]);
					break;
				}
			}
		}

		if (spec[0])
		{
			precache_models_in_spec(spec);
		}
	}

	tlog("[TSM] Precached %d class model(s).", g_precached);
	audit_class_models();
}

/*
 * Warns about any class model that is NOT listed in mp_teammodels.
 *
 * The two have to agree and nothing enforces it, which is the trap that has already
 * taken this server down once: a weapon or player model TS never precached is a fatal
 * Host_Error the moment something tries to set it, and the server closes rather than
 * logging and carrying on.
 *
 * This only warns -- the plugin precaches its own class models, so a name missing from
 * mp_teammodels is usually survivable. It is logged because finding it afterwards from
 * a silent close is miserable, and because adding a model to the class table while
 * forgetting the cvar is the obvious mistake to make.
 */
audit_class_models()
{
	new teamlist[256];
	get_cvar_string("mp_teammodels", teamlist, charsmax(teamlist));

	if (!teamlist[0])
	{
		tlog("[TSM] WARNING: mp_teammodels is empty. Teams have no models of their own.");
		return;
	}

	new missing = 0;

	for (new c = 0; c < g_class_count; c++)
	{
		for (new t = 1; t <= 2; t++)
		{
			new list[TSM_MODELLIST], item[48], tail[TSM_MODELLIST];
			copy(list, charsmax(list), g_class_model[c][t]);

			for (new guard = 0; guard < TSM_MAXMODELS && list[0]; guard++)
			{
				strtok(list, item, charsmax(item), tail, charsmax(tail), ',', 0);
				copy(list, charsmax(list), tail);

				if (!item[0] || containi(teamlist, item) != -1)
				{
					continue;
				}

				tlog("[TSM] WARNING: class %d '%s' team %d uses model '%s', which is NOT in mp_teammodels. Add it, or TS will not precache it.",
					c + 1, g_class_name[c], t, item);
				missing++;
			}
		}
	}

	if (!missing)
	{
		tlog("[TSM] Class models all present in mp_teammodels.");
	}
}

/*
 * Precaches every TS weapon world model.
 *
 * THIS IS WHAT CRASHED THE SERVER.
 *
 *     Host_Error: PF_setmodel_I: no precache: models/w_glock18.mdl
 *
 * Host_Error is fatal -- the server does not log and carry on, it closes. TS only
 * precaches the weapons a map actually needs, so handing someone a weapon the map
 * never contained kills the server the instant the model is set. The Officer class
 * carries a Glock 18, bots take classes round-robin, and the first bot to roll
 * Officer took the whole server down with it.
 *
 * The directory is SCANNED rather than listed by hand, so a class table that later
 * uses a weapon nobody thought of is covered without anyone remembering to come
 * back here. 35 models is nothing against the engine's limit.
 *
 * World models only. The crash named w_, and p_/v_ would add another 90-odd slots
 * for no demonstrated need.
 */
precache_weapon_models()
{
	new path[64], file[64];
	new dir = open_dir("models", file, charsmax(file));
	if (!dir)
	{
		tlog("[TSM] WARNING: could not scan models/ -- weapon models are NOT precached, and a weapon the map does not use will crash the server.");
		return;
	}

	new n = 0;
	do
	{
		// w_ is the world/ground model, which is the one PF_setmodel_I was refusing.
		if (file[0] != 'w' || file[1] != '_')
		{
			continue;
		}

		new len = strlen(file);
		if (len < 5 || !equali(file[len - 4], ".mdl"))
		{
			continue;
		}

		formatex(path, charsmax(path), "models/%s", file);
		if (file_exists(path))
		{
			precache_model(path);
			n++;
		}
	}
	while (next_file(dir, file, charsmax(file)));

	close_dir(dir);
	tlog("[TSM] Precached %d weapon world model(s).", n);
}

/*
 * Precaches a custom sound only when the file is actually there.
 *
 * An unguarded precache of a missing sound is a fatal Host_Error on map load, the
 * same failure the class icons are guarded against. The cvar holds the name relative
 * to sound\, which is what precache_sound and the client's spk both expect.
 *
 * serverwav picks the precache kind: true for a sound the SERVER emits (emit_sound,
 * which needs a numbered sound slot); false for one a CLIENT plays itself with
 * playvol, which has to be in the generic download list instead.
 */
precache_custom_sound(pcvar, const key[], bool:serverwav)
{
	new snd[64], path[80];

	// The cfg's own line first: plugin_precache runs before amxx execs it, so the cvar
	// still holds its compiled-in default here (see read_cfg_value).
	read_cfg_value(key, snd, charsmax(snd));
	if (!snd[0])
	{
		get_pcvar_string(pcvar, snd, charsmax(snd));
	}
	if (!snd[0])
	{
		return;
	}
	formatex(path, charsmax(path), "sound/%s", snd);
	if (!file_exists(path))
	{
		tlog("[TSM] WARNING: sound/%s is missing -- it will not play.", snd);
		return;
	}
	if (serverwav)
	{
		precache_sound(snd);
	}
	else
	{
		precache_generic(path);
	}
}

/*
 * The quoted value of a "key" line in ts_matchmode.cfg, or an empty string.
 *
 * plugin_precache runs before amxx execs the config, so the cvars still hold their
 * compiled-in defaults there. Anything precached from a cvar has to be read out of the
 * file, the way the class models already are.
 */
read_cfg_value(const key[], out[], outlen)
{
	out[0] = 0;

	new cfg[128];
	get_configsdir(cfg, charsmax(cfg));
	formatex(cfg, charsmax(cfg), "%s/ts_matchmode.cfg", cfg);
	if (!file_exists(cfg))
	{
		return;
	}

	new line[TSM_LINE], len, ln = 0;
	while (read_file(cfg, ln++, line, charsmax(line), len))
	{
		trim(line);
		if (line[0] == ';' || (line[0] == '/' && line[1] == '/'))
		{
			continue;
		}

		// At the start of the line, so a longer name that merely contains the key
		// cannot answer for it.
		if (containi(line, key) != 0)
		{
			continue;
		}

		new q1 = -1, q2 = -1;
		for (new c = 0; line[c]; c++)
		{
			if (line[c] == '"')
			{
				if (q1 < 0) { q1 = c; } else { q2 = c; }
			}
		}
		if (q1 >= 0 && q2 > q1 + 1)
		{
			copy(out, (q2 - q1 - 1 < outlen) ? (q2 - q1 - 1) : outlen, line[q1 + 1]);
			return;
		}
	}
}

/*
 * One player slot's class-icon entity, made hidden. Safe to call from plugin_precache: it reads
 * no cvar, because those are not registered until plugin_init.
 */
make_class_icon(id, Float:scale)
{
	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (!ent)
	{
		return 0;
	}

	engfunc(EngFunc_SetModel, ent, TSM_ICON_SPR);
	set_pev(ent, pev_classname, "tsm_class_icon");

	// The owner is how the AddToFullPack hooks work out whose icon this is, and therefore
	// which side is allowed to see it. g_icon_owner[] is the same link the other way round.
	set_pev(ent, pev_owner, id);

	set_pev(ent, pev_movetype,   TSM_MOVETYPE_NOCLIP);
	set_pev(ent, pev_solid,      TSM_SOLID_NOT);
	set_pev(ent, pev_rendermode, TSM_RENDER_ALPHA);
	set_pev(ent, pev_renderfx,   TSM_RENDERFX_NONE);
	set_pev(ent, pev_renderamt,  255.0);
	set_pev(ent, pev_scale,      scale);
	set_pev(ent, pev_effects,    pev(ent, pev_effects) | TSM_EF_NODRAW);

	g_icon_ent[id] = ent;
	if (ent < sizeof g_icon_owner)
	{
		g_icon_owner[ent] = id;
	}
	return ent;
}

/// A roleplay map by its name: rp_ or tsrp_ at the start, or _rp_ or _tsrp_ anywhere in it.
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

/// The value a map's own mapconfig (ts/mapconfigs/<map>.cfg, which h9_autoconfig runs once the map is up)
/// gives a cvar, by the last line that sets it; -1 when there is no such file or it does not set the cvar.
mapconfig_value(const map[], const cvar[])
{
	new path[96];
	formatex(path, charsmax(path), "mapconfigs/%s.cfg", map);
	new f = fopen(path, "rt", true);
	if (!f)
	{
		return -1;
	}
	new line[160], key[48], value[32], found = -1;
	while (!feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		if (!line[0] || (line[0] == '/' && line[1] == '/'))
		{
			continue;
		}
		value[0] = 0;
		parse(line, key, charsmax(key), value, charsmax(value));
		if (equali(key, cvar) && value[0])
		{
			found = str_to_num(value);
		}
	}
	fclose(f);
	return found;
}

public plugin_precache()
{
	g_maxplayers = get_maxplayers();

	/*
	 * Xash3D first: what it changes has to be in place before any plugin's plugin_init.
	 *
	 * AMXX's own adminslots.amxx reads sv_visiblemaxplayers on every connect, and Xash
	 * has no such cvar, so every join -- a bot every two seconds -- was an "Invalid CVAR
	 * pointer" run time error. A stand-in with GoldSrc's default (-1: show maxplayers)
	 * is made here: precache runs for every plugin before any plugin_init does.
	 */
	g_xash = cvar_exists("host_ver") != 0;
	if (g_xash && !cvar_exists("sv_visiblemaxplayers"))
	{
		register_cvar("sv_visiblemaxplayers", "-1");
	}

	/*
	 * REGISTERED HERE, not in plugin_init, because this forward runs first and already
	 * logs -- the missing-sprite warning below. A cvar registered in plugin_init does
	 * not exist yet at this point, so anything logging from precache would be dropped
	 * even with tsm_logging on, and would have been passing an unset handle to
	 * get_pcvar_num before that.
	 */
	g_cv_logging = register_cvar("tsm_logging", "0");

	/*
	 * WHICH GAME THIS MAP PLAYS, decided here because nothing later can: TS chooses its gamerules
	 * from mp_teamplay during the world's spawn, straight after game.cfg, and this forward runs just
	 * before that (AMXX loads its plugins as the world spawns). H9's own maps -- named h9_ or tsm_,
	 * and not roleplay maps -- play the match mode, on teamplay rules. TS's own modes under H9's
	 * names play as the game ships, on their own rules: deathmatch for h9_dm_, teamplay for h9_tdm_,
	 * h9_ctb_ and h9_ctf_. Every other map, a stock ts_ map or a roleplay one, plays as the game
	 * ships on deathmatch rules. Wherever the match mode does not play, plugin_cfg turns it and its
	 * bots off and puts TS's own cash and powerups back. The map's mapconfig has the last word: a
	 * tsm_enabled or mp_teamplay line in it decides in place of the name. A map's own worldspawn
	 * gamemode key still wins over mp_teamplay, as in the stock game.
	 */
	get_mapname(g_mapname, charsmax(g_mapname));
	new own = -1;   // one of TS's own modes by its H9 name: 0 deathmatch, 1 teamplay; -1 not one
	if (equali(g_mapname, "h9_dm_", 6))
	{
		own = 0;
	}
	else if (equali(g_mapname, "h9_tdm_", 7) || equali(g_mapname, "h9_ctb_", 7) || equali(g_mapname, "h9_ctf_", 7))
	{
		own = 1;
	}
	new cfg_on = mapconfig_value(g_mapname, "tsm_enabled");
	new cfg_tp = mapconfig_value(g_mapname, "mp_teamplay");
	if (cfg_on >= 0)
	{
		g_map_h9 = (cfg_on != 0);
	}
	else
	{
		g_map_h9 = (equali(g_mapname, "h9_", 3) || equali(g_mapname, "tsm_", 4)) && !roleplay_map(g_mapname) && own < 0;
	}
	new bool:teamplay;
	if (cfg_tp >= 0)
	{
		teamplay = (cfg_tp != 0);
	}
	else
	{
		teamplay = g_map_h9 || own == 1;
	}
	set_cvar_num("mp_teamplay", teamplay ? 1 : 0);
	if (cvar_exists("teamplay"))
	{
		set_cvar_num("teamplay", teamplay ? 1 : 0);
	}
	log_amx("[TSM] %s: %s, on %s rules.", g_mapname,
		g_map_h9 ? "an H9 map, the match mode plays" : "not an H9 map, the game as it ships",
		teamplay ? "teamplay" : "deathmatch");

	if (g_xash)
	{
		tlog("[TSM] Xash3D FWGS -- leave cleanup runs from Metamod's ClientDisconnect, sv_visiblemaxplayers stood in.");
	}

	/*
	 * The perk sounds, registered and precached here because precaching is only legal
	 * in this forward and a cvar registered in plugin_init does not exist yet.
	 *
	 * STOCK HALF-LIFE SOUNDS, deliberately, rather than generated ones. A custom wav
	 * has to reach every client before they can hear it -- without fastdl they get
	 * silence -- and precaching a path that does not exist is a fatal Host_Error on
	 * map load, which is the same crash this plugin already precaches weapon models to
	 * avoid. These two ship with the game.
	 *
	 * Replacing them with your own is supported, and the file then has to exist on the
	 * server AND be downloadable, or the server will not start.
	 */
	g_cv_medsound = register_cvar("tsm_medic_sound", "items/medshot4.wav");
	g_cv_engsound = register_cvar("tsm_eng_sound",   "items/9mmclip1.wav");

	new snd[64];
	get_pcvar_string(g_cv_medsound, snd, charsmax(snd));
	if (snd[0])
	{
		precache_sound(snd);
	}
	get_pcvar_string(g_cv_engsound, snd, charsmax(snd));
	if (snd[0])
	{
		precache_sound(snd);
	}

	g_cv_suddensound = register_cvar("tsm_sudden_sound", "xom_laugh.wav");
	g_cv_welcomesound = register_cvar("tsm_welcome_sound", "welcome.wav");
	precache_custom_sound(g_cv_suddensound, "tsm_sudden_sound", true);
	precache_custom_sound(g_cv_welcomesound, "tsm_welcome_sound", false);

	/*
	 * The Officer's scan ping. EMPTY until the custom wav arrives: empty means no
	 * sound at all (precache_custom_sound quietly steps over it), while a guessed
	 * path would be either a missing-file warning or, worse, a made-up name that
	 * never plays. Setting the cvar is all it takes to switch the sound on.
	 */
	g_cv_scansound = register_cvar("tsm_scan_sound", "");
	precache_custom_sound(g_cv_scansound, "tsm_scan_sound", true);

	/*
	 * THE DEATH VOICES, the elimination scream pool in ts\sound\death.
	 *
	 * Fixed NAMES, not cvars -- fem1..5 and male1..5 are a contract with whoever
	 * dropps files into the folder, not something every server operator renames.
	 * Each slot is checked for existence FIRST because precache_sound on a name
	 * with no file behind it is the fatal Host_Error the comment above weapon
	 * models explains; a missing file only shrinks that voice's random pool.
	 * The robot sound is stock Half-Life and lives in the ENGINE'S OWN valve
	 * directory, which file_exists cannot see into, so it is precached with no
	 * check -- the engine's own moddir-then-valve fallback finds it.
	 */
	new dv_snd[40], dv_path[56];
	for (new dv = 1; dv <= 6; dv++)
	{
		formatex(dv_snd, charsmax(dv_snd), "death/fem%d.wav", dv);
		formatex(dv_path, charsmax(dv_path), "sound/%s", dv_snd);
		if (file_exists(dv_path))
		{
			precache_sound(dv_snd);
			g_death_fem_ok[dv] = true;
		}
		else
		{
			tlog("[TSM] death voice not on disk, pool shrinks: %s", dv_snd);
		}

		formatex(dv_snd, charsmax(dv_snd), "death/male%d.wav", dv);
		formatex(dv_path, charsmax(dv_path), "sound/%s", dv_snd);
		if (file_exists(dv_path))
		{
			precache_sound(dv_snd);
			g_death_male_ok[dv] = true;
		}
		else
		{
			tlog("[TSM] death voice not on disk, pool shrinks: %s", dv_snd);
		}
	}
	precache_sound(TSM_DEATH_ROBO);

	// The machine power-down is a moddir file, so it is checked first like the voices: a
	// missing one only leaves the boom on its own.
	if (file_exists(TSM_DEATH_DROID_PATH))
	{
		precache_sound(TSM_DEATH_DROID);
		g_death_droid_ok = true;
	}
	else
	{
		tlog("[TSM] %s is not on disk -- machines detonate without powering down.", TSM_DEATH_DROID_PATH);
	}

	// The Officer's fall, a moddir file checked the same way: a missing one only leaves an
	// Officer to fall unannounced.
	if (file_exists(TSM_DEATH_OFFICER_PATH))
	{
		precache_sound(TSM_DEATH_OFFICER);
		g_death_officer_ok = true;
	}
	else
	{
		tlog("[TSM] %s is not on disk -- an Officer falls unannounced.", TSM_DEATH_OFFICER_PATH);
	}

	/*
	 * THE SIEGE FINALE BOOMS, the HL1 stock stack the last objective falls
	 * to. Engine-fallback files, so a plain precache like the robot voice
	 * above.
	 */
	precache_sound(TSM_OBJ_BOOM_A);
	precache_sound(TSM_OBJ_BOOM_B);
	precache_sound(TSM_OBJ_BOOM_C);

	/*
	 * THE SIEGE ALARM SIREN is a moddir file, so it is checked and measured
	 * before it is precached -- the measurement IS the loop interval and does
	 * double duty as the existence test. A wav with no readable header means
	 * no siren, and the alarm still works as text.
	 */
	g_alarm_len = sound_seconds(TSM_ALARM_WAV);
	if (g_alarm_len > 0.0)
	{
		precache_sound(TSM_ALARM_WAV);
		tlog("[TSM] siege alarm siren measured at %0.2f s", g_alarm_len);
	}
	else
	{
		tlog("[TSM] siege alarm has no readable siren wav; the warning stays text-only.");
	}

	/*
	 * THE SATCHEL'S TWO PLANT SOUNDS and the finale boom stack's lengths,
	 * measured once for the planting loop's restart clock and the ground
	 * shake's span. The HOLD clack and the stocked booms live in the
	 * engine's own valve tree, reached through the valve filesystem; the
	 * SUCCESS sound is the plant.wav the server ships in ts\sound -- and it
	 * is deliberately a DIFFERENT name from the hold clack, because clients
	 * resolve moddir first and one name cannot mean two files. If nothing
	 * measures, planting falls back on a one-second loop and the shake on a
	 * three-second window. Every file is precached plainly, like the robot
	 * voice -- the engine finds its own stock either way.
	 */
	g_plant_len = sound_seconds(TSM_PLANT_WAV);
	tlog("[TSM] satchel plant hold sound measured at %0.2f s", g_plant_len);
	for (new bs = 0; bs < 3; bs++)
	{
		g_boom_len[bs] = sound_seconds(g_boom_snd[bs]);
	}
	precache_sound(TSM_PLANT_WAV);
	// The sprite TE_EXPLOSION draws is not a client default -- the packet
	// carries the index, so it is precached here and passed at every burst.
	g_obj_boom_spr = precache_model("sprites/zerogxplode.spr");

	// The success sound: the server's own plant.wav. Precached plainly -- a
	// fresh install without it simply falls to the engine's same-name stock
	// copy, so it never has to crash and never has to be asked-after.
	g_plant_done_len = sound_seconds(TSM_PLANT_DONE);
	tlog("[TSM] satchel plant success sound measured at %0.2f s", g_plant_done_len);
	precache_sound(TSM_PLANT_DONE);

	/*
	 * MECH HIT SOUNDS: the randomized debris-metal pool a mech takes damage on.
	 * Stock files in ts\sound\debris; precached outright because the engine's
	 * own moddir tree carries them.
	 */
	for (new hs = 0; hs < sizeof g_mech_hit_snd; hs++)
	{
		precache_sound(g_mech_hit_snd[hs]);
	}

	// A mech's stunt sounds (mech_stunt_sounds): stock Half-Life files every client has.
	precache_sound(MECH_LEAP);
	precache_sound(MECH_LAND);
	precache_sound(MECH_LAND2);

	// The sentry turret's models and sounds, precached only when every one of them is there: a precached
	// name with no file behind it is a fatal Host_Error, so a missing file switches the turret off instead.
	new tpath[64];
	g_turret_ok = file_exists(TSM_TURRET_MDL_1, true) && file_exists(TSM_TURRET_MDL_2, true);
	formatex(tpath, charsmax(tpath), "sound/%s", TSM_TURRET_PING);
	g_turret_ok = g_turret_ok && file_exists(tpath, true);
	formatex(tpath, charsmax(tpath), "sound/%s", TSM_TURRET_DEPLOY);
	g_turret_ok = g_turret_ok && file_exists(tpath, true);
	for (new s = 0; g_turret_ok && s < sizeof g_turret_fire_snd; s++)
	{
		formatex(tpath, charsmax(tpath), "sound/%s", g_turret_fire_snd[s]);
		g_turret_ok = file_exists(tpath, true) != 0;
	}
	if (g_turret_ok)
	{
		precache_model(TSM_TURRET_MDL_1);
		precache_model(TSM_TURRET_MDL_2);
		precache_sound(TSM_TURRET_PING);
		precache_sound(TSM_TURRET_DEPLOY);
		for (new s = 0; s < sizeof g_turret_fire_snd; s++)
		{
			precache_sound(g_turret_fire_snd[s]);
		}
		g_turret_boom = precache_model(TSM_TURRET_BOOM);
		if (file_exists("sprites/blood.spr", true) && file_exists("sprites/bloodspray.spr", true))
		{
			g_turret_blood = precache_model("sprites/blood.spr");
			g_turret_bloodspray = precache_model("sprites/bloodspray.spr");
		}
		if (file_exists("sprites/ts_muzzleflash1.spr", true))
		{
			g_turret_flash = precache_model("sprites/ts_muzzleflash1.spr");
		}
		if (file_exists("sprites/bullet_trail.spr", true) && file_exists("models/bullet.mdl", true))
		{
			g_turret_trail = precache_model("sprites/bullet_trail.spr");
			precache_model("models/bullet.mdl");
			g_turret_bullet = true;
		}
	}

	/*
	 * MECH STEP AND LOOP SOUNDS: mechwalk / mechwalk2 alternate on footsteps,
	 * mechloop is the idle hum under every living mech. Moved here from the
	 * old mech_footsteps plugin.
	 */
	precache_sound(MECH_STEP_1);
	precache_sound(MECH_STEP_2);
	precache_sound(MECH_LOOP);

	// Recon's cloak/uncloak, two variants of each. Bare filenames, in sound\ beside everything
	// else here -- same convention as every other precache_sound in this file.
	precache_sound("cloak.wav");
	precache_sound("cloak2.wav");
	precache_sound("uncloak.wav");
	precache_sound("uncloak2.wav");

	/*
	 * Mech rocket launch sound. The stock valve\sound\weapons\rocketfire1.wav
	 * (9.5 KB, 11025 Hz mono) is copied into master sound\weapons\ and synced by
	 * build.bat. An existence gate avoids the fatal Host_Error if the file is
	 * missing from a particular install.
	 */
	new sPath[64];
	formatex(sPath, charsmax(sPath), "sound/weapons/rocketfire1.wav");
	if (file_exists(sPath))
	{
		precache_sound("weapons/rocketfire1.wav");
	}
	else
	{
		tlog("[TSM] weapons/rocketfire1.wav not on disk; Mech rocket will be silent");
	}

	/*
	 * MP3 music tracks for the ambient queue. Precached here so clients download
	 * them before task_music_queue tries to play them -- without precaching the
	 * client has no local copy and mp3 play is silent. MP3s go through
	 * precache_generic (the WAV path in precache_sound is a different download
	 * channel), and the path must include sound/ because that is how mp3 play
	 * resolves them later too.
	 */
	new i;
	for (i = 0; i < sizeof g_music_mp3; i++)
	{
		new sPath[64], sSnd[64];
		formatex(sPath, charsmax(sPath), "sound/music/%s", g_music_mp3[i]);

		if (music_is_wav(i))
		{
			// The playvol track: the standard sound download path, and the
			// existence gate applies -- precaching a name with no file behind
			// it is the fatal Host_Error, not a silent no-op.
			if (file_exists(sPath))
			{
				formatex(sSnd, charsmax(sSnd), "music/%s", g_music_mp3[i]);
				precache_sound(sSnd);
			}
			else
			{
				tlog("[TSM] %s not on disk; that music track stays quiet", sPath);
			}
		}
		else
		{
			// The path must include sound/ because that is how mp3 play
			// resolves them later too.
			precache_generic(sPath);
		}
	}

	// THE ROUND-START ANTHEMS are wavs now: precache_sound, the standard
	// sound download path, so playvol finds the file on every client. The
	// existence gates mirror the death voices above -- precaching a name
	// with no file behind it is the fatal Host_Error.
	for (i = 0; i < sizeof g_start_t1; i++)
	{
		new sSnd[64], sPath[64];
		formatex(sSnd, charsmax(sSnd), "start/%s", g_start_t1[i]);
		formatex(sPath, charsmax(sPath), "sound/%s", sSnd);
		if (file_exists(sPath))
		{
			precache_sound(sSnd);
			server_print("[TSM] precached MSR anthem: %s", sSnd);
			tlog("[TSM] precached MSR anthem: %s", sSnd);
		}
		else
		{
			server_print("[TSM] MSR anthem NOT FOUND on disk: %s (checked %s)", sSnd, sPath);
			tlog("[TSM] MSR anthem NOT FOUND on disk: %s (checked %s)", sSnd, sPath);
		}
	}
	for (i = 0; i < sizeof g_start_t2; i++)
	{
		new sSnd[64], sPath[64];
		formatex(sSnd, charsmax(sSnd), "start/%s", g_start_t2[i]);
		formatex(sPath, charsmax(sPath), "sound/%s", sSnd);
		if (file_exists(sPath))
		{
			precache_sound(sSnd);
			server_print("[TSM] precached INS anthem: %s", sSnd);
			tlog("[TSM] precached INS anthem: %s", sSnd);
		}
		else
		{
			server_print("[TSM] INS anthem NOT FOUND on disk: %s (checked %s)", sSnd, sPath);
			tlog("[TSM] INS anthem NOT FOUND on disk: %s (checked %s)", sSnd, sPath);
		}
	}

	/*
	 * THE INSURGENT ROAR, existence-gated like the death voices above:
	 * precaching a name with no file behind it is the fatal Host_Error, so
	 * a derailed roar only removes one cue quietly instead of killing the
	 * map load. The wav lives at ts\sound root; clients with the server's
	 * sound package will have it already from the downloads.
	 */
	new roar_path[48];   // its own buffer: the loops' sPath are block-scoped
	formatex(roar_path, charsmax(roar_path), "sound/%s", TSM_ROAR_WAV);
	g_roar_ok = (file_exists(roar_path) != 0);   // file_exists is an int; the flag is bool
	if (g_roar_ok)
	{
		precache_sound(TSM_ROAR_WAV);
		tlog("[TSM] precached roar: %s", TSM_ROAR_WAV);
	}
	else
	{
		tlog("[TSM] mutantroar.wav NOT FOUND on disk: %s", roar_path);
	}

	/*
	 * THE MSR BADUM, existence-gated the same way: missing file keeps the cue
	 * quiet rather than crashing the map load.
	 */
	new badum_path[48];
	formatex(badum_path, charsmax(badum_path), "sound/%s", TSM_BADUM_WAV);
	g_badum_ok = (file_exists(badum_path) != 0);
	if (g_badum_ok)
	{
		precache_sound(TSM_BADUM_WAV);
		tlog("[TSM] precached badum: %s", TSM_BADUM_WAV);
	}
	else
	{
		tlog("[TSM] badum.wav NOT FOUND on disk: %s", badum_path);
	}

	/*
	 * Has to happen HERE. A model precached any later shifts the model index table
	 * that clients were already sent, which is the "Bad model on beam (not sprite)"
	 * crash this plugin has hit before.
	 */
	precache_class_models();
	precache_weapon_models();

	/*
	 * The spectator model, for the same reason as the class models above.
	 *
	 * set_spectator_model resolves it with a runtime EngFunc_ModelIndex, and a model
	 * precached any later than this shifts the index table clients were already sent
	 * -- the "Bad model on beam (not sprite)" crash. Guarded, because precaching a
	 * missing file is a fatal Host_Error on map load.
	 */
	new specm[32];
	read_cfg_value("tsm_spectator_model", specm, charsmax(specm));
	if (specm[0])
	{
		new specpath[96];
		formatex(specpath, charsmax(specpath), "models/player/%s/%s.mdl", specm, specm);
		if (file_exists(specpath))
		{
			precache_model(specpath);
		}
		else
		{
			tlog("[TSM] WARNING: tsm_spectator_model '%s' is not installed (%s) -- spectators stay visible.",
				specm, specpath);
		}
	}

	// Guarded, because precaching a file that is not there is a fatal Host_Error
	// that closes the server -- the same failure the class models are guarded
	// against.
	if (file_exists(TSM_ICON_SPR))
	{
		precache_model(TSM_ICON_SPR);
		g_icon_ok = true;

		/*
		 * THE ICONS ARE MADE HERE, NOT ON FIRST USE.
		 *
		 * The engine sends each client at most 256 entities a frame, walking the edicts in
		 * order, so whatever has the highest numbers is what gets cut when a view is crowded --
		 * and an icon made at runtime always lands above every entity in the map. From the upper
		 * halls of neuropolis the dome's props alone fill the packet, so no icon made later ever
		 * reached a client there. Precache runs while only the world and the player slots exist,
		 * so these take the edicts right after the players, ahead of the whole map.
		 *
		 * Hidden until used: an EF_NODRAW entity is never sent, so an unused icon costs nothing.
		 * The scale is a stand-in because the cvar is not registered yet; update_class_icon()
		 * writes the real one whenever it shows an icon.
		 */
		new maxpl = get_maxplayers();
		for (new i = 1; i <= maxpl && i < MAXPL; i++)
		{
			if (!make_class_icon(i, 0.25))
			{
				tlog("[TSM] WARNING: could not create the class icon for slot %d at precache.", i);
				break;
			}
		}
	}
	else
	{
		tlog("[TSM] WARNING: %s is missing -- class icons are off for this map.", TSM_ICON_SPR);
	}


}

/**
 * The one thing this plugin tells anyone else: ts_advertise reads it to say in its
 * Discord embed whether a match is running. Nothing here depends on it being read.
 *
 * It MUST be registered here and not in plugin_init. AMXX resolves every plugin's
 * natives before it runs any plugin_init, so a native registered there does not exist
 * yet when the plugin that wants it is being linked -- and that plugin is refused with
 * "uses an unknown function", naming a native that is plainly in the source.
 */
public plugin_natives()
{
	register_native("tsm_match_info", "native_match_info");

	// The mode API, for ts_uplink and ts_survival: include\tsm_api.inc documents each one.
	register_native("tsm_mode_claim",    "native_mode_claim");
	register_native("tsm_end_round",     "native_end_round");
	register_native("tsm_reward_lives",  "native_reward_lives");
	register_native("tsm_wave_seconds",  "native_wave_seconds");
	register_native("tsm_fire_wave",     "native_fire_wave");
	register_native("tsm_hud_line",      "native_hud_line");
	register_native("tsm_state",         "native_state");
	register_native("tsm_side_of",       "native_side_of");
	register_native("tsm_in_play",       "native_in_play");
	register_native("tsm_side_alive",    "native_side_alive");
	register_native("tsm_give_powerup",  "native_give_powerup");
	register_native("tsm_match_desc",    "native_match_desc");
	register_native("tsm_set_class",     "native_set_class");
	register_native("tsm_class_hp",      "native_class_hp");
	register_native("tsm_set_progress",  "native_set_progress");
	register_native("tsm_refresh_abilities", "native_refresh_abilities");
	register_native("tsm_class_count",   "native_class_count");
	register_native("tsm_class_of_perk", "native_class_of_perk");
	register_native("tsm_class_rule",    "native_class_rule");
	register_native("tsm_mode_bot_class", "native_mode_bot_class");
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_enabled   = register_cvar("tsm_enabled",     "1");
	// Per-map, not a hardcoded map name: set in ts/mapconfigs/<mapname>.cfg (h9_autoconfig
	// execs it after that map loads), so turning this on/off for any map is a .cfg edit,
	// not a recompile. See clean_all_weapons() and mapconfigs/h9_tsrp_hive.cfg.
	g_cv_no_weapons = register_cvar("tsm_no_weapons", "0");
	g_cv_rounds    = register_cvar("tsm_rounds",      "9");    // best-of, so first to 5
	#define ARM_STAGGER 0.25
	// A forced wave (.reinforce) wakes everyone in the same tenth of a second, by
	// design -- but when a wave's size exceeds the tier's spawn-point count, two
	// players can still be told to respawn at the identical point in the identical
	// instant. This small a stagger doesn't dull the "all at once" feel (a 10-person
	// forced wave still finishes within half a second) but gives the engine enough
	// real separation that the alive-occupancy redirect in pick_spawn_point gets a
	// chance to see the first one land before the second one resolves.
	#define TSM_FORCED_STAGGER 0.05
	// How often the live gate re-checks arming progress, and the most it will
	// delay LIVE past the freeze timer for a player who still has not armed.
	#define ARM_GATE_CHECK 0.2
	#define ARM_GATE_MAX_EXTRA 8.0

	g_cv_freeze    = register_cvar("tsm_freezetime",  "10");
	g_cv_roundtime = register_cvar("tsm_roundtime",   "300");  // seconds, 0 = no limit
	g_cv_showtimer = register_cvar("tsm_show_timer",  "1");    // draw the round clock

	// Scoreboard abbreviations. Blank = first three letters of the team name.
	g_cv_t1short   = register_cvar("tsm_team1_short", "");
	g_cv_t2short   = register_cvar("tsm_team2_short", "");

	// Re-assert mp_teamlist after the map has loaded. See force_team_list().
	g_cv_forceteams  = register_cvar("tsm_force_teamlist", "1");
	g_cv_forcemodels = register_cvar("tsm_force_teammodels", "");

	// Long names, for the team menu only. The mod is still joined by the short team
	// name in tsm_team1_name / tsm_team2_name -- these are purely what people read.
	g_cv_t1label   = register_cvar("tsm_team1_label", "the Middle Sea Republic");
	g_cv_t2label   = register_cvar("tsm_team2_label", "the Insurrectionists");

	// The index TS uses for "no team". Its own menu sends jointeam 1-4 for the four
	// teams and jointeam 5 separately, which is the spectate button.
	// Accepted and ignored. The slot is now worked out from the live mp_teamlist by
	// live_spectator_index(), because a hardcoded index that no longer matches the
	// real team list auto-assigns the player to a playing side instead of failing.
	register_cvar("tsm_spectate_index", "3");

	// Seconds to wait after someone joins before offering the side menu. TS opens its
	// own buy menu on spawn, and that is a VGUI panel which holds keyboard focus -- an
	// AMXX menu drawn underneath it renders but never receives a keypress, which is
	// exactly why the side menu appeared and then ignored all input.
	g_cv_menudelay = register_cvar("tsm_menu_delay",     "3");

	/*
	 * How often the freeze tick re-offers the class menu to someone who has not picked.
	 *
	 * It has to keep asking, for the same reason tsm_menu_delay exists: TS opens its own
	 * buy menu on spawn and that is a modal VGUI panel which holds keyboard focus, so the
	 * class menu drawn underneath it renders and never receives a keypress. The first
	 * offer, 0.3 seconds after the spawn, is therefore always wasted.
	 *
	 * This used to be a hardcoded four seconds, which in a six second freeze bought one
	 * retry -- and if TS's panel was still up for that one, the menu did not land until
	 * after the round had already started. At one second it is re-offered on every tick of
	 * the countdown and appears the moment the panel goes away.
	 */
	g_cv_classretry = register_cvar("tsm_class_retry",   "1.0");

	// Refuse the command that opens TS's own team panel. See cmd_block_changeteam.
	g_cv_blockvgui = register_cvar("tsm_block_teamvgui", "1");

	/*
	 * 0 = classes set health, armour, model and perk but hand out NO weapons
	 * 1 = classes also arm the player from a ts_groundweapon
	 *
	 * Defaults to 0 because arming crashed clients with "Bad model on beam (not
	 * sprite)". Spawning a ts_groundweapon mid-game makes TS precache that weapon's
	 * assets at runtime, and a runtime precache shifts the model index table out of
	 * step with what clients already hold -- so the client reads a studio model where
	 * it expects a sprite. plugin_precache() below front-loads every weapon at map
	 * load to make this safe; set to 1 to test that.
	 */
	/*
	 * 0 = no weapons given and none stripped
	 * 2 = write TS's own armament and respawn  (DEFAULT)
	 *
	 * Mode 1 -- spawning a ts_groundweapon per weapon -- has been REMOVED. Creating
	 * those entities floods every client with entity traffic in a single frame, which
	 * overran the network buffer with a full server (SZ_GetSpace: overflow) and left
	 * clients reading the truncated message as a beam: "Bad model on beam (not
	 * sprite)". Precaching the weapons did not help; the precache table was never the
	 * problem. No weapon entity is created anywhere in this plugin now.
	 */
	g_cv_wpnmode   = register_cvar("tsm_weapon_mode",    "2");

	// Spare magazines added to every weapon on top of what its class line asks for,
	// and a hard ceiling on the total so no class can hand out a silly amount.
	g_cv_clipbonus = register_cvar("tsm_clip_bonus",     "2");
	g_cv_clipcap   = register_cvar("tsm_clip_max",       "6");

	/*
	 * HOW MUCH OF THOSE MAGAZINES TS ACTUALLY HOLDS, as a percentage.
	 *
	 * The class figure reaches ts_giveweapon as raw ROUNDS, not clips -- the odd little
	 * reserve everyone saw as a handful of 9-ish bullets instead of full mags. Once each
	 * weapon lands, the give rewrites the reserve in real ammunition, at
	 * figure x magazine size x this percent. 100 is every listed magazine held in full;
	 * 50 is the halved first tuning that read tight in play; anything 0 or below skips
	 * the rewrite and leaves ts_giveweapon's own small reserve standing. TS still clamps
	 * the result to whatever that weapon's own cap is, so a phrase like "six M60 mags"
	 * lands wherever TS says the M60 tops out.
	 */
	g_cv_sparepct  = register_cvar("tsm_clip_sparepct",  "100");

	/*
	 * A real third team for people who are not playing.
	 *
	 * Without one, "not on a team" and "watching" are the same state to TS, and a
	 * player sitting in it is still a live body in the world. Giving spectators their
	 * own team means the mod agrees with the plugin about who is in the match.
	 */
	g_cv_specteam  = register_cvar("tsm_spectator_team", "spectator");

	/*
	 * tsm_arm_delay. The seconds between the wash and the arm respawn that applies
	 * it: respawning too soon ran BuyArmament while pending commands were still
	 * outstanding and handed out a partial loadout, so the spacing stays and the
	 * pending-echo wait in the arm task rides on top of it.
	 */
	g_cv_armdelay = register_cvar("tsm_arm_delay",      "2.5");

	/*
	 * Magazines of every ammo type handed out with the loadout.
	 *
	 * This used to go through TS's tka command, which is a PURCHASE and so was refused
	 * outright by weaponrestriction 1 -- players got weapons with nothing to put in
	 * them. It is now given the same way the combat engineer's resupply is, with a
	 * ts_groundammo entity that is created, handed over and removed in one call.
	 *
	 * Still every type rather than only the matching one: the weapon-to-ammotype
	 * mapping lives in the mod's weapon table and is not reachable from a plugin. Only
	 * what a player's weapons actually use gets consumed, so a small number here stays
	 * modest in practice. 0 disables it.
	 */
	g_cv_giveammo  = register_cvar("tsm_ammo_mags",      "2");

	/*
	 * Put anyone who arrives without a side onto the spectator team.
	 *
	 * Joining used to leave people simply teamless, which is NOT the same thing: TS
	 * still had them as a live body in the world with no team, so they could wander
	 * around during a match. On the spectator team they are held and invisible like
	 * any other non-participant, and the side menu is what lets them in.
	 */
	g_cv_defaultspec = register_cvar("tsm_default_spectator", "1");

	/*
	 * Remove the weapon TS drops at a player's feet when their class loadout arrives.
	 *
	 * PlayerSpawn hands out the mod's default kit and THEN applies the armament, so a
	 * player who is given a class sidearm ends up holding two pistols, and TS drops
	 * the one that will not fit. The dropped entity is a live pickup that anyone can
	 * take, so it is cleared rather than left lying there.
	 */
	/*
	 * OFF by default. The sweep cannot tell a dropped DEFAULT weapon from a dropped
	 * CLASS weapon -- tsweaponid is a private member of the entity, not an entvar, so
	 * a plugin cannot read it -- and it was removing sidearms players were supposed to
	 * keep. Stripping before the respawn removes the overflow that caused the drop in
	 * the first place, so this is no longer needed.
	 */
	g_cv_cleandrops = register_cvar("tsm_clean_drops",   "0");

	/*
	 * 0 = teammates cannot hurt each other (DEFAULT), 1 = they can.
	 *
	 * Enforced by this plugin rather than by mp_friendlyfire, because the plugin owns
	 * team membership -- TS may not agree about who is on whose side, so its own
	 * friendly-fire check cannot be relied on here.
	 */
	g_cv_friendlyfire = register_cvar("tsm_friendlyfire", "0");

	/*
	 * Fill a side that is short at the start of a round.
	 *
	 * 0 = never
	 * 1 = pull in late joiners who are sitting the match out (DEFAULT)
	 * 2 = late joiners first, then people who chose to spectate
	 *
	 * Someone disconnecting mid-match otherwise leaves the round 2v1 for the rest of
	 * the match, because sides are locked once it starts.
	 */
	g_cv_autofill  = register_cvar("tsm_autofill",       "1");

	/*
	 * Seconds a body stays visible after being eliminated.
	 *
	 * Removal from play hides the player outright, and doing that the instant they die
	 * means the killer never sees them fall -- the target just vanishes mid-animation,
	 * which reads as a glitch rather than a kill.
	 */
	/*
	 * A CEILING, not a delay.
	 *
	 * The real trigger for going invisible is TS respawning the player. This only
	 * exists so a body cannot lie there forever if that never happens, so it should be
	 * comfortably longer than a respawn takes -- 2.5s was short enough that it fired
	 * first and still looked instant.
	 */
	g_cv_deathdelay = register_cvar("tsm_death_delay",   "10.0");

	/*
	 * Remove weapons players dropped, at the start of every round.
	 *
	 * Buying is already refused, but that does not stop someone dropping what they
	 * are holding during warmup and collecting it once the round is live -- which
	 * smuggles a whole extra loadout past the class system.
	 *
	 * Only DROPPED items are removed. Weapons the mapper placed are recorded when the
	 * map spawns and are left alone.
	 */
	g_cv_sweepdrops = register_cvar("tsm_sweep_drops",   "1");
	/*
	 * Recon's cloak. 1 = usable, 0 = .cloak and .uncloak are refused outright, same shape as
	 * tsm_classes for the class system as a whole -- one switch to turn the feature off without
	 * touching anything else.
	 */
	g_cv_cloak = register_cvar("tsm_cloak_enabled", "1");
	/*
	 * How long a cloak lasts on its own before it expires, in seconds. 0 means it never
	 * expires by itself -- only .uncloak or taking/dealing damage ends it.
	 */
	g_cv_cloakduration = register_cvar("tsm_cloak_duration", "30.0");
	/*
	 * How long a Recon has to wait after uncloaking -- by .uncloak, expiry, or a broken
	 * cloak -- before .cloak will work again, in seconds. 0 means no wait at all.
	 */
	g_cv_cloakcooldown = register_cvar("tsm_cloak_cooldown", "30.0");
	/*
	 * How solid a cloaked Recon is, 0-255 (0 fully invisible, 255 not cloaked at all).
	 *
	 * A FLAT NUMBER, not a #define: the first value shipped (40) read as barely dimmed
	 * in a real match, and tuning that used to mean a full recompile to try a different
	 * number. One cvar read in the two places that apply it means it can be tried in
	 * game and changed on the fly.
	 */
	g_cv_cloakopacity = register_cvar("tsm_cloak_opacity", "12.0");

	/*
	 * THE OFFICER'S .SCAN.
	 *
	 * Radius is the sphere around the Officer, in units, inside which a cloaked enemy
	 * is caught. The cooldown starts the moment the scan FIRES (measured like the cloak
	 * and the rocket, from use rather than from when the last effect ended), and the
	 * reveal lasts tsm_scan_time seconds. The mark itself is a blue glow shell, written
	 * per viewer from fw_addtofullpack.
	 */
	g_cv_scanradius = register_cvar("tsm_scan_radius",    "1024");
	g_cv_scancool   = register_cvar("tsm_scan_cooldown",  "30.0");
	g_cv_scantime   = register_cvar("tsm_scan_time",      "10.0");
	// ---- respawn waves and lives ----
	g_cv_respawns   = register_cvar("tsm_respawns",           "1");       // 0: no waves at all, one life each
	g_cv_respwave   = register_cvar("tsm_respawn_wave",       "60.0");    // seconds between a team's waves
	g_cv_respsecs   = register_cvar("tsm_respawn_seconds",    "5.0");     // dead this long before a wave takes you
	g_cv_respsudden = register_cvar("tsm_respawn_sudden",     "0");       // 1: waves still run in sudden death
	g_cv_reinforce  = register_cvar("tsm_reinforce_cooldown", "120.0");   // the Officer's .reinforce cooldown
	g_cv_classlives = register_cvar("tsm_class_lives",        "");        // lives per class, in class order

	/*
	 * Remove TS's powerups from match play.
	 *
	 * Powerups are a deathmatch feature -- whoever happens to be standing near one when
	 * a round starts gets an advantage nobody chose. Both the pickups and the command
	 * that activates them are taken out.
	 */
	g_cv_nopowerups = register_cvar("tsm_no_powerups",   "1");
	g_cv_modelpost  = register_cvar("tsm_model_post",     "1");
	g_cv_icons      = register_cvar("tsm_class_icons",    "1");
	// Above the player's ORIGIN, which is already his hull centre (feet+36): 52 floats the
	// icon about 88 units above the feet, clear of the head.
	g_cv_iconhigh   = register_cvar("tsm_icon_height",    "52.0");
	/*
	 * How many seconds of a round are "the last minute". 0 turns the whole thing off.
	 *
	 * The point is the end of a round where both sides are hiding and neither can find the other:
	 * a timer running down on two people in opposite corners is not tension, it is waiting. Past
	 * this mark every player is marked to the OTHER side and the round gets decided.
	 */
	g_cv_sudden     = register_cvar("tsm_sudden_death",   "60");
	g_cv_iconscale  = register_cvar("tsm_icon_scale",     "0.25");

	/*
	 * THE SUDDEN-DEATH EXTRAS, beyond the red icons the clock itself already flips on.
	 *
	 * tsm_sudden_xray puts the through-wall X-ray shell on every enemy to the other
	 * side for the last minute (only the sudden-death timer above gates it; the shell
	 * is refused over a cloaked Recon, exactly as the icons are). On a stock engine it
	 * renders as nothing, so the icons carry the feature everywhere else.
	 *
	 * tsm_sudden_fog_* is the "toxic bog". While sudden death is live the plugin holds
	 * the four h9_fog_* ENGINE cvars at these values (the engine reads them every frame
	 * and fogs the world; see engine-h9-suddendeath.patch), and zeroes them again when
	 * the round or the match cautious ends. Colour is 0-255 per channel; density is
	 * 0-255, scaled by the engine through 0.01/255, so 90 is "the far side of the map
	 * is already gone" and 0 is no fog at all.
	 */
	g_cv_suddenxray = register_cvar("tsm_sudden_xray",    "1");
	g_cv_suddenfog_r = register_cvar("tsm_sudden_fog_r",       "40");
	g_cv_suddenfog_g = register_cvar("tsm_sudden_fog_g",      "140");
	g_cv_suddenfog_b = register_cvar("tsm_sudden_fog_b",       "45");
	g_cv_suddenfog_d = register_cvar("tsm_sudden_fog_density","90");
	register_cvar("h9_fog_r",       "0");
	register_cvar("h9_fog_g",       "0");
	register_cvar("h9_fog_b",       "0");
	register_cvar("h9_fog_density", "0");

	/*
	 * Seconds bots sit out after a match before picking sides again.
	 *
	 * They are parked at match end so sides are re-picked rather than inherited, but
	 * they have to come back on their own: a bot cannot use the side menu, and waiting
	 * for the next match to start deadlocks -- the match needs players on both sides
	 * to begin, and every bot is sitting out.
	 */
	g_cv_botreturn  = register_cvar("tsm_bot_return",    "6.0");

	// ---- bots ----
	//
	// OFF by default. With tsm_bots 0 every enumeration keeps skipping bots and the
	// match mode behaves exactly as it does without any of this.
	g_cv_bots       = register_cvar("tsm_bots",          "0");

	// both | 1 | 2 -- which side(s) bots are put on.
	g_cv_botteams   = register_cvar("tsm_bot_teams",     "both");

	// 0 = tsm_default_class for all, spread = round-robin, or a fixed class number.
	g_cv_botclass   = register_cvar("tsm_bot_class",     "0");

	// Arm bots from their class. Uses the entity path, since a bot cannot run the
	// client commands the armament path depends on.
	// Accepted and ignored. Bots are armed by rcbot itself; this plugin creates no
	// weapon entities for anyone.
	register_cvar("tsm_bot_loadout", "0");

	// A bot cannot type .ready, so without this a side holding one never becomes ready.
	g_cv_botready   = register_cvar("tsm_bot_ready",     "1");
	g_cv_minteam   = register_cvar("tsm_min_per_team","1");
	g_cv_disarm    = register_cvar("tsm_disarm",      "2");    // DISARM_SPEED
	g_cv_report    = register_cvar("tsm_report_kills","1");
	g_cv_reporthp  = register_cvar("tsm_report_hp",   "1");
	g_cv_health    = register_cvar("tsm_spawn_health","100");
	g_cv_teammode  = register_cvar("tsm_team_mode",   "auto"); // auto | name | number
	g_cv_team1name = register_cvar("tsm_team1_name",  "");
	g_cv_team2name = register_cvar("tsm_team2_name",  "");
	g_cv_holdz     = register_cvar("tsm_hold_height", "900");
	g_cv_warmhold  = register_cvar("tsm_warmup_hold", "1");   // 0 = free play in warmup
	g_cv_warmhide  = register_cvar("tsm_warmup_hide", "1");   // hide players during warmup
	/*
	 * OFF by default while the "cannot move, cannot attack" fault is open.
	 *
	 * This plugin strips every player at the start of every round, and TS derives
	 * player speed from the equipped weapon -- so a player left with no valid active
	 * weapon reads maxspeed 0 and cannot fire, which is every reported symptom at
	 * once. strip_user_weapons comes from the fun module and is generic HL stripping;
	 * TS has its own slot and dual-wield handling that it may not unwind cleanly.
	 *
	 * Turn back on once movement is confirmed working with it off.
	 */
	g_cv_reloadout = register_cvar("tsm_reset_loadout", "0");
	// Accepted and ignored, so configs written for the old kill-and-respawn reset
	// still load without an unknown-cvar error.
	register_cvar("tsm_reset_delay", "1.0");

	// Weapons handed out at the start of each round, as "id:clips" pairs.
	// Default: MK23 with 3 clips plus a combat knife. IDs are the TSW_* enum.
	g_cv_loadout   = register_cvar("tsm_loadout",   "9:3,25:0");

	// auto   - per-map cfg spawns if present, otherwise scan map entities
	// config - ONLY per-map cfg spawns; refuses to guess
	// entity - ignore the cfg and always scan entities
	g_cv_spawnmode = register_cvar("tsm_spawn_mode", "auto");

	// Solo testing: lets a match run with only one team occupied.
	g_cv_solo      = register_cvar("tsm_test_solo",  "0");

	// 0 off, 1 write tsm_debug.log, 2 also echo to the server console.
	g_cv_dbglog    = register_cvar("tsm_debug_log",  "1");

	/*
	 * OFF by default now that the plugin owns team membership.
	 *
	 * This re-wrote the "team" userinfo key every tick whenever TS's own team index
	 * disagreed with ours -- and TS answers a team userinfo change by re-applying the
	 * player's model via SET_CLIENT_KEY_VALUE("model", GetPlayerModel(player)). A
	 * model applied at runtime that was not precached at map load shifts the model
	 * index table, and the client then reads a studio model where it expects a sprite:
	 * "Bad model on beam (not sprite)". Nothing depends on this cosmetically.
	 */
	g_cv_nospec    = register_cvar("tsm_block_spectator", "0");

	// Largest allowed difference in team sizes before the match is held up.
	// 1, not 2. A gap of 2 permits 2v0 -- which passes the balance check and then
	// cannot start a match, because a side with nobody on it never becomes ready.
	g_cv_balgap    = register_cvar("tsm_balance_gap",  "1");
	// off | warn | block (hold ready-up) | shuffle (also attempt a forced move)
	g_cv_balmode   = register_cvar("tsm_balance_mode", "block");

	/*
	 * Stop a round whose sides have gone uneven instead of playing it out short-handed.
	 *
	 * The threshold is tsm_balance_gap and deliberately not a number of its own.
	 * balance_ok() is the only definition of an even game in this plugin and it is what
	 * gates ready-up, so a second one here would let a match halt over a gap ready-up
	 * would happily have started on. tsm_balance_mode off switches this off with it.
	 */
	g_cv_haltleave = register_cvar("tsm_halt_on_leave", "1");
	g_cv_specmodel = register_cvar("tsm_spectator_model", "Invisible");
	g_cv_halthumans = register_cvar("tsm_halt_humans",   "1");

	/*
	 * How long after a departure the sides are counted again.
	 *
	 * Long enough for somebody else to close the gap before the match is stopped over
	 * it. With tsm_bots 1 that somebody is usually rcbot: balance_teams moves its own
	 * bots between sides on rcbot's schedule rather than ours, so a human leaving a 5v5
	 * reads as a gap for a second or two and then does not.
	 */
	g_cv_haltdelay = register_cvar("tsm_halt_delay", "3.0");

	// 1 never halts at all. amx_match_continue is the one-match form of the same thing.
	g_cv_haltbypass = register_cvar("tsm_halt_bypass", "0");

	// How a held player is stopped. 1 is the engine freeze flag and is what works;
	// 2 clamps maxspeed; 3 is the old ts_set_speed call, kept only so the
	// slow-motion behaviour can be reproduced on demand.
	// 2 = clamp maxspeed from the post hooks (DEFAULT, and the only one that holds)
	// 1 = FL_FROZEN alone, which TS ignores
	g_cv_freezemethod = register_cvar("tsm_freeze_method", "2");

	// Restore a released player's maxspeed when TS leaves it at 0. Applied from the
	// POST PlayerPreThink hook, which is the only place it survives.
	g_cv_forcespeed   = register_cvar("tsm_force_maxspeed", "1");

	// The "Game" column in the server browser. Blank leaves TS's own text alone.
	g_cv_gamedesc     = register_cvar("tsm_gamedesc", "Match Mode");
	// Shown instead of tsm_gamedesc, on maps that have siege objectives (tsm_obj_1 and
	// on) -- siege_count() decides which, refresh_gamedesc() picks between them.
	g_cv_gamedesc_siege = register_cvar("tsm_gamedesc_siege", "Siege");
	// What the Discord card reads, written by refresh_presence() through pres_set into the serverinfo
	// the client is sent: the siege progress ("2/5" on a siege map, empty elsewhere) and the rest
	// below. Plain cvars, not FCVAR_SERVER: a server cvar never reaches serverinfo, and each change
	// of one is printed to every player as "x" changed to "y".
	g_cv_presiege = register_cvar("tsm_pres_siege", "");
	g_cv_presattack = register_cvar("tsm_pres_attack", "");
	g_cv_presside1 = register_cvar("tsm_pres_side1", "");
	g_cv_presside2 = register_cvar("tsm_pres_side2", "");
	g_cv_presalive1 = register_cvar("tsm_pres_alive1", "");
	g_cv_presalive2 = register_cvar("tsm_pres_alive2", "");
	// The mode's key ("match", "siege", or a claimed mode's: "uplink", "survival", "mechwarrior"),
	// empty with tsm_enabled 0: the card picks its details line by it. The mode plugins publish
	// their own progress beside it.
	g_cv_presmode = register_cvar("tsm_pres_mode", "");
	// And its progress, in the mode's own short form ("1/2/3/1" zones and carrier, "12" a wave).
	g_cv_presprog = register_cvar("tsm_pres_prog", "");

	/*
	 * The mode API's forwards. A mode plugin implements whichever it needs as a public of the
	 * same name; include\tsm_api.inc says when each fires. The two that ask a question stop at
	 * the first plugin that answers PLUGIN_HANDLED.
	 */
	g_fw_round_start = CreateMultiForward("tsm_round_start", ET_IGNORE, FP_CELL);
	g_fw_round_live  = CreateMultiForward("tsm_round_live", ET_IGNORE, FP_CELL);
	g_fw_round_end   = CreateMultiForward("tsm_round_end", ET_IGNORE, FP_CELL);
	g_fw_timeout     = CreateMultiForward("tsm_round_timeout", ET_STOP);
	g_fw_wave        = CreateMultiForward("tsm_wave", ET_IGNORE, FP_CELL, FP_CELL);
	g_fw_loadout     = CreateMultiForward("tsm_loadout", ET_STOP, FP_CELL, FP_ARRAY, FP_CELL);
	g_fw_armed       = CreateMultiForward("tsm_armed", ET_IGNORE, FP_CELL);

	// Refuse team changes once a match is under way. Deliberately its own cvar and
	// not part of tsm_block_spectator, so turning that off for a model test cannot
	// quietly unlock teams mid-match.
	g_cv_teamlock     = register_cvar("tsm_lock_teams", "1");

	// Respawn anyone still dead when a round starts, rather than leaving them to sit
	// out until the mod gets round to it.
	g_cv_forcespawn   = register_cvar("tsm_force_spawn", "1");

	// ---- classes ----
	g_cv_classes   = register_cvar("tsm_classes",       "1");
	g_cv_defclass  = register_cvar("tsm_default_class", "1");
	g_cv_classlimits = register_cvar("tsm_class_limits", "");

	// force    - set the model per class and re-assert it when TS reverts
	// teamonly - leave TS's own mp_teammodels alone (DEFAULT)
	g_cv_modelmode = register_cvar("tsm_model_mode",    "teamonly");

	// There is no economy: you pick a class and keep it for the match.
	g_cv_nocash    = register_cvar("tsm_nocash",        "1");

	// Off by default. Refusing the buy commands did not stop a purchase and only
	// produced chat spam -- starving the cash does the job properly.
	g_cv_blockbuy  = register_cvar("tsm_block_buy",     "1");

	// ---- combat engineer ----
	g_cv_engrange  = register_cvar("tsm_eng_range",     "96");
	g_cv_engclips  = register_cvar("tsm_eng_clips",     "3");

	// Yellow glow on whoever was resupplied, mirroring the medic's red one. Without
	// it the engineer's perk is the only one that does its work invisibly -- nobody
	// can tell they have been given anything.
	g_cv_engglow   = register_cvar("tsm_eng_glow",      "1.5");
	g_cv_engshell  = register_cvar("tsm_eng_shell",     "16");
	g_cv_engcool   = register_cvar("tsm_eng_cooldown",  "30.0");

	// The Combat Engineer's sentry turret (.turret): how many, how tough, how far and how hard it shoots,
	// and its repair.
	g_cv_turret          = register_cvar("tsm_turret",                 "1");
	g_cv_turret_per_team = register_cvar("tsm_turret_per_team",        "2");
	g_cv_turret_hp       = register_cvar("tsm_turret_hp",              "400");
	g_cv_turret_resist   = register_cvar("tsm_turret_resist",          "0.5");
	g_cv_turret_range    = register_cvar("tsm_turret_range",           "1000");
	g_cv_turret_dmg      = register_cvar("tsm_turret_damage",          "72");
	g_cv_turret_rate     = register_cvar("tsm_turret_rate",            "8.0");
	g_cv_turret_spread   = register_cvar("tsm_turret_spread",          "1.5");
	g_cv_turret_repair   = register_cvar("tsm_turret_repair",          "100");
	g_cv_turret_repaircd = register_cvar("tsm_turret_repair_cooldown", "30");

	/*
	 * Slow health regeneration, for whatever class carries TSM_PERK_REGEN.
	 *
	 * 10 every 15 seconds is two thirds of a point a second -- it cannot out-heal
	 * anything being shot at it, which is the point. It is what lets a Heavy who
	 * breaks contact come back, not what keeps one alive in a firefight.
	 *
	 * The pause is counted from the last time they were HIT AT ALL, enemy fire or a
	 * fall, so a player under fire never ticks.
	 */
	g_cv_regenamt   = register_cvar("tsm_regen_amount",   "10");
	g_cv_regenevery = register_cvar("tsm_regen_interval", "15.0");
	g_cv_regenpause = register_cvar("tsm_regen_pause",    "15.0");
	g_cv_engents   = register_cvar("tsm_eng_entities",  "");

	// What a Breacher can force open. Doors by default; add a map's own locked
	// entities, or the MASTER that locks them, here.
	g_cv_breachents  = register_cvar("tsm_breach_entities",
		"func_door,func_door_rotating,func_wall_toggle,func_button");
	g_cv_breachrange = register_cvar("tsm_breach_range", "96");

	/*
	 * The map's DECLARED breach targets, tsm_breachdoor_1..8.
	 *
	 * These name doors BY TARGETNAME (comma or space separated lists), so a siege
	 * map can say "these specific doors are breach objectives". A door on any of
	 * the eight lists counts as breachable even when its lock is a master chain a
	 * plugin cannot read, and -- with the rule below -- "Breached." is only ever
	 * printed for a door that was actually locked (Use Only) or is on one of these
	 * lists; an everyday unlocked door under the crosshair gets stock behaviour and
	 * no callout.
	 */
	new bdname[24];
	for (new bd = 0; bd < 8; bd++)
	{
		formatex(bdname, charsmax(bdname), "tsm_breachdoor_%d", bd + 1);
		g_cv_breachdoor[bd] = register_cvar(bdname, "");
	}

	/*
	 * Which class the map's "tsm_eng_door" doors answer to, BY NAME.
	 *
	 * Matched against the class name rather than against its number, because the
	 * number is only its position in tsm_class1..tsm_class7 and reordering those is
	 * a one-line edit that would otherwise hand the doors to whoever landed in slot
	 * two. The name is the thing a server operator actually sets, so it is the thing
	 * this follows -- and if they rename the class, this is where they say so.
	 */
	g_cv_engdoorclass = register_cvar("tsm_eng_door_class", "Combat Engineer");

	/*
	 * Which SIDE's Combat Engineer the "tsm_eng_door" doors answer to: 0 either side's
	 * (as they always have), 1 or 2 only that side's. A siege map whose doors are the
	 * attackers' to open sets the attackers here, so a defender cannot open one for them.
	 */
	g_cv_engdoorteam = register_cvar("tsm_eng_door_team", "0");

	// Whether tsm_opendoor works at all: a debugging aid, off unless asked for.
	g_cv_forcedoor = register_cvar("amx_tsm_forcedoor", "0");

	/*
	 * Siege objectives (see siege_* below): the side that attacks them, the class that
	 * can take one (by name, as the doors are; blank: any class of that side), how long
	 * +USE is held on it, whether everyone left alive dies when it falls, and how far
	 * away a player may stand.
	 */
	g_cv_objteam  = register_cvar("tsm_obj_team",  "2");
	g_cv_objclass = register_cvar("tsm_obj_class", "Breacher");
	g_cv_objtime  = register_cvar("tsm_obj_time",  "10.0");
	g_cv_objfuse  = register_cvar("tsm_obj_fuse",  "5.0");
	g_cv_objslay  = register_cvar("tsm_obj_slay",  "1");
	g_cv_objrange = register_cvar("tsm_obj_range", "96");

	/*
	 * What a fallen objective gives back when it is not the last and the round goes on
	 * (see siege_reward_* below). Lives: every player's count SET to their class's again,
	 * never added to, and the eliminated return at their side's next wave. Time: the
	 * clock run back toward tsm_roundtime, by at most tsm_addtime seconds a fall and never
	 * past the round time; tsm_addtime is only read while tsm_siege_extratime is 1.
	 */
	g_cv_siegelives = register_cvar("tsm_siege_rewardlives", "1");
	g_cv_siegetime  = register_cvar("tsm_siege_extratime",   "1");
	g_cv_addtime    = register_cvar("tsm_addtime",           "150");

	/*
	 * THE ROUND-START TEAM BANNERS.
	 *
	 * tsm_obj_msg_1 is what SIDE 1 reads and tsm_obj_msg_2 what side 2 reads, one
	 * second after a round starts. Empty means a side gets nothing at all. A pipe
	 * inside the value is a row break, so several rows stack beneath each other:
	 * "BREACH|TAKES THE YARD" shows two rows. Side 1 draws blue and side 2 red,
	 * matching the MSR-1 / Insurgency-2 sides of this server.
	 */
	g_cv_objmsg1 = register_cvar("tsm_obj_msg_1", "");
	g_cv_objmsg2 = register_cvar("tsm_obj_msg_2", "");

	/*
	 * THE SIEGE ALARM: on/off, the siren's volume, the line the side under
	 * attack reads while it runs and the line the attacking side reads (pipes
	 * are row breaks, exactly like the banners). Everything else about the
	 * alarm is fixed behaviour.
	 */
	g_cv_alarm    = register_cvar("tsm_alarm",     "1");
	g_cv_alarmvol = register_cvar("tsm_alarm_vol", "0.3");
	g_cv_alarmmsg = register_cvar("tsm_alarm_msg", "BREACH IN PROGRESS");
	g_cv_alarmmsgatk = register_cvar("tsm_alarm_msg_attack", "YOUR TEAM IS CURRENTLY SIEGING THE MAP");

	// The finale's ground shake goes out as the raw ScreenShake game message,
	// so its id is looked up once here and reused at every last boom.
	g_shake_msg = get_user_msgid("ScreenShake");

	g_cv_armorder    = register_cvar("tsm_arm_order", "0");

	/*
	 * The attachment mask handed to ts_giveweapon, which is its fourth argument.
	 *
	 * TSA_SILENCER is 1, TSA_LASERSIGHT 2, TSA_FLASHLIGHT 4, TSA_SCOPE 8, so 0 asks for a
	 * bare weapon and is what this has always passed. It is a cvar rather than a constant
	 * because the M4A1 has been turning up silenced ANYWAY, and this is the only argument
	 * that could be asking for it -- there is exactly one ts_giveweapon call in the plugin
	 * and TS's own buy path is bypassed entirely, so nothing else here is attaching
	 * anything.
	 *
	 * If 0 still comes back silenced then TS is attaching it of its own accord and no
	 * value here will change that, which is what the readback below is for: it prints what
	 * TS says the weapon ended up with, so the question stops being a matter of opinion.
	 * There is no ts_setuserwpn, so reading it is as far as this can go.
	 */
	g_cv_wpnextra    = register_cvar("tsm_wpn_extra", "0");

	/*
	 * Whether a class's height is applied at all.
	 *
	 * Off switches every class back to normal without editing the class lines, which is
	 * the setting you want the moment someone complains that a Heavy is hard to hit --
	 * see the note on the class field for why that is a real risk and not a theoretical
	 * one.
	 */
	g_cv_classscale  = register_cvar("tsm_class_scale", "1");

	g_cv_blindff     = register_cvar("tsm_bot_blind_ff", "1");

	/*
	 * ON. The crash at round go-live was the friendly-fire cone, which has since
	 *
	 * been removed outright. This was switched off alongside it only because both
	 * ran in the same place and either could have been responsible.
	 */

	// Seconds between re-checking whether TS moved a player's model. 0 = never,
	// which is the default: the re-check IS the model-flipping-every-few-seconds
	// problem, because TS moves it and we move it back.
	g_cv_modelverify = register_cvar("tsm_model_verify", "0");

	// Which class a blank model field borrows from, per side. 1 is Assault.
	g_cv_modelfallback = register_cvar("tsm_model_fallback_class", "1");

	// Keep the map's own spawn points out of the custom set.
	g_cv_prune     = register_cvar("tsm_spawn_prune", "1");
	g_cv_prunedist = register_cvar("tsm_spawn_prune_dist", "64");

	// Seconds between forcing a bot to reload. 0 turns it off.
	//
	// Not aggressive on purpose: a short interval interrupts them mid-burst, since
	// a reload they did not ask for cancels the shot they were taking.
	g_cv_botreload   = register_cvar("tsm_bot_reload", "5.0");

	// Look at a teammate and their class and health are shown. 0 turns it off.
	g_cv_hoverinfo   = register_cvar("tsm_hover_info", "1");
	g_cv_hoverrange  = register_cvar("tsm_hover_range", "640");

	g_cv_medheal  = register_cvar("tsm_medic_heal",     "50");
	g_cv_medcool  = register_cvar("tsm_medic_cooldown", "15.0");
	g_cv_medrange = register_cvar("tsm_medic_range",    "96");
	g_cv_medglow  = register_cvar("tsm_medic_glow",     "1.5");
	g_cv_medshell = register_cvar("tsm_medic_shell",    "16");

	/*
	 * The stimpack: everyone's own single self-heal, beside the medic's because it is
	 * the same machinery pointed at the user instead of at someone they are aiming at.
	 *
	 * It has no sound of its own on purpose. It plays tsm_medic_sound, so there is one
	 * healing sound on the server to change rather than two that can drift apart -- and
	 * that one is already precached, so this adds no new way to fail a map load.
	 */
	g_cv_stim      = register_cvar("tsm_stim",           "1");
	g_cv_stimmin   = register_cvar("tsm_stim_min",       "25");
	g_cv_stimmax   = register_cvar("tsm_stim_max",       "50");
	g_cv_stimglow  = register_cvar("tsm_stim_glow",      "1.5");
	g_cv_stimshell = register_cvar("tsm_stim_shell",     "16");

	/*
	 * Long enough for the death animation to be seen.
	 *
	 * This is the window in which an eliminated player is NOT taken out of play. At 0 the
	 * NODRAW lands on the frame of death and eats the animation entirely -- you kill
	 * someone and they blink out mid-fall.
	 *
	 * The hold block in fw_prethink gates its take-out on elim_hide_due(). The one hide
	 * that does not wait is fw_postthink_post's EF_NODRAW on the player TS respawns, and
	 * that never reaches the dying body or TS's corpse. When the window ends they are
	 * taken out of play and become a spectator.
	 */
	g_cv_deathlinger = register_cvar("tsm_death_linger", "3.0");

	/*
	 * A flat wait after dying before anything is done to the player at all.
	 *
	 * TS puts a dead player back on their feet almost at once, and the think hook took
	 * that as its cue to pull them out of play -- so being shot read as being teleported
	 * straight into spectating, with no time to see the body.
	 *
	 * SHORT ON PURPOSE. This was tried at 6.0 and a long stretch of a round was spent with
	 * eliminated players not yet taken out; whether that is what stopped rounds resolving
	 * was never established, because the match-abandon bug was live at the same time and
	 * produces the same symptom. 2.5 is enough to see the body and short enough that it
	 * cannot swallow a round.
	 *
	 * They are NOT loose during it: g_elim is set the moment they die, so the disarm in
	 * fw_cmdstart already has them -- no weapon, no movement. 0 disables the wait.
	 */
	g_cv_deathgrace = register_cvar("tsm_death_grace",  "2.5");

	// Both teams hear death/officer_perished.wav when an Officer is slain. 0 turns it off.
	g_cv_officerslain = register_cvar("tsm_officerslain_sound", "1");



	g_cv_squaddist  = register_cvar("tsm_squad_dist",  "280");
	g_cv_squadwarp  = register_cvar("tsm_squad_warp",  "1200");
	g_cv_squadspeed = register_cvar("tsm_squad_speed", "240");
	g_cv_squadsteer = register_cvar("tsm_squad_steer", "1");
	// How far out counts as genuinely lost: the leash gauge. Under this a bot
	// that is drifting is ordinary fight-from-range play and only ever pulled,
	// never warped -- the "they constantly portal to me" report was the gauge
	// starting at tsm_squad_dist itself. Current value sits UNDER the formation
	// radius on purpose: leaving formation IS being out, the lag clock starts
	// the frame a squad bot passes tsm_squad_dist, and three seconds of it
	// brings them in by force.
	g_cv_squadleash = register_cvar("tsm_squad_leash", "50");

	g_cv_endelay    = register_cvar("tsm_roundend_delay", "4.0");
	g_cv_botresup   = register_cvar("tsm_bot_resupply", "20.0");

	g_cv_botnames  = register_cvar("tsm_bot_names",  "1");
	g_cv_botname1  = register_cvar("tsm_bot_name1",  "Enforcer");
	g_cv_botname2  = register_cvar("tsm_bot_name2",  "Insurgent");

	// Class definitions. See ts_matchmode.cfg for the format.
	// Name ; team1 weapons ; team2 weapons ; model ; hp ; armour ; perk
	// Weapon ids are TS's own: 5 M4A1, 13 AK47, 22 Glock 20, 25 Combat Knife,
	// 23 HK UMP, 18 Barrett M82, 32 M60.
	register_cvar("tsm_class1", "Assault;5:3,22:2;13:3,22:2;repuheavy|XCCPSoldier-wartorn,XCCPmutant;100;0;0");
	register_cvar("tsm_class2", "Combat Engineer;23:3,22:2;23:3,22:2;scda_Spy02|XCCPsgts;100;0;1");
	register_cvar("tsm_class3", "Marksman;18:2,22:2;18:2,22:2;;85;0;0");
	register_cvar("tsm_class4", "Heavy;32:2,22:2;32:2,22:2;repuheavyw|XCCPsgg;125;50;0;0.75");

	// 4 = Benelli M3. Perk 2 forces locked doors, which no other class can open.
	register_cvar("tsm_class5", "Breacher;4:4,22:2;4:4,22:2;;110;0;2");

	// Sidearm only -- no primary. 22 = Glock 20. Perk 3 heals a teammate on +USE.
	register_cvar("tsm_class6", "Medic;22:4;22:4;repuheavym|ins_medic_belt;100;0;3");

	// 1 = Glock 18, 34 = Katana (melee, so no spare clips). Perk 4 commands bots.
	register_cvar("tsm_class7", "Officer;1:4,34:0;1:4,34:0;reputengu|;100;0;4");
	register_cvar("tsm_class8", "Recon;12:2,15:2,34:0;12:2,15:2,34:0;repuheavy_recon|;75;0;0;1.20");
	register_cvar("tsm_class9", "Mech;32:2;32:2;repuheavy_recon|;300;0;0;0.60");

	register_event("DeathMsg", "ev_death", "a");

	// Damage taken, from any source. Used to undo friendly fire.
	register_event("Damage", "ev_damage", "b", "2!0");

	/*
	 * The real friendly-fire block. See the hamsandwich include at the top.
	 *
	 * The Damage event above is left registered because it still carries the hit
	 * information used for kill reports, but it is no longer what stops the damage.
	 */
	RegisterHam(Ham_TakeDamage, "player", "fw_takedamage");

	// Pre-hook, so the respawn can be refused before it happens.
	RegisterHam(Ham_Spawn, "player", "fw_player_spawn", 0);

	/*
	 * The engineer doors. A map marks one by giving it the targetname
	 * "tsm_eng_door"; every other func_door in the map is passed straight through.
	 *
	 * Pre-hook, because the only useful answer is to refuse the Use before
	 * CBaseDoor::Use has moved anything.
	 */
	RegisterHam(Ham_Use, "func_door", "fw_door_use", 0);

	// A map's env_shake, for everyone in its reach (fw_shake_use): TS sends the shake only to
	// players standing on the ground. Post-hook, so TS's own pass has gone first.
	RegisterHam(Ham_Use, "env_shake", "fw_shake_use", 1);

	/*
	 * THE DESTRUCTIBLE OBJECTIVE HOOKS. Both screen themselves with
	 * siege_number() inside, so an ordinary breakable of the map behaves
	 * exactly as the mod leaves it. fw_obj_dmg takes away the wound of
	 * every player who is not of the attacking side; fw_obj_killed books
	 * the fall when an attacking hand kills the body -- gunfire, grenade,
	 * or the Breacher's own charge finishing what it started.
	 */
	RegisterHam(Ham_TakeDamage, "func_breakable", "fw_obj_dmg",    0);
	RegisterHam(Ham_Killed,     "func_breakable", "fw_obj_killed", 0);

	/*
	 * Definitive gamerules test.
	 *
	 * CHalfLifeTeamplay sends TeamInfo from InitHUD and from ChangePlayerTeam.
	 * CHalfLifeMultiplay -- where every team function is an inherited stub and
	 * jointeam is a no-op -- never sends it at all. So a zero count here means the
	 * server is NOT running teamplay, whatever mp_teamplay reads.
	 */
	new msg_teaminfo = get_user_msgid("TeamInfo");
	if (msg_teaminfo)
	{
		register_message(msg_teaminfo, "msg_teaminfo");
	}

	register_forward(FM_CmdStart,       "fw_cmdstart");
	register_forward(FM_PlayerPreThink, "fw_prethink");

	// Registered POST (the trailing 1), so it runs AFTER the game DLL's own
	// PlayerPreThink. The pre hook sets maxspeed and TS then overwrites it to 0
	// before movement runs, so the pre hook could never win that exchange.
	register_forward(FM_PlayerPreThink, "fw_prethink_post", 1);

	// A second restore site, after player movement has run. If TS writes maxspeed
	// during the move itself rather than in PreThink, the post-PreThink hook is still
	// too early and only this one lands.
	register_forward(FM_PlayerPostThink, "fw_postthink_post", 1);

	register_forward(FM_GetGameDescription, "fw_gamedesc");
	register_forward(FM_AddToFullPack, "fw_addtofullpack_pre");
	register_forward(FM_AddToFullPack, "fw_addtofullpack", 1);

	// Sudden death's x-ray reaches past the PVS on Xash only, where the engine draws it.
	if (g_xash)
	{
		register_forward(FM_CheckVisibility, "fw_checkvis");
	}

	// The cloak's EF_NODRAW for RCBot: off straight after its think, on again at the end of
	// the frame. See cloak_active().
	register_forward(FM_StartFrame, "fw_startframe_pre");
	register_forward(FM_StartFrame, "fw_startframe_post", 1);

	// Xash3D: where a player leaving arrives on that engine. See fw_client_disconnect_xash.
	if (g_xash)
	{
		register_forward(FM_ClientDisconnect, "fw_client_disconnect_xash");
	}
	register_forward(FM_ClientUserInfoChanged, "fw_userinfo");

	/*
	 * POST as well as pre, and the post hook is the one that makes class models
	 * stick.
	 *
	 * CHalfLifeTeamplay::ClientUserInfoChanged force-writes the "model" key to
	 * CTSGameRules::GetPlayerModel() -- a RANDOM pick from the team mp_teammodels
	 * slots -- and the branch that does it is reached unconditionally. Writing the
	 * key from the pre hook therefore always loses, because our write is what
	 * triggers the handler that overwrites it.
	 *
	 * Superceding the whole hook is not the answer either: the mod stops processing
	 * userinfo at all and the scoreboard and team assignment break with it. So TS is
	 * left to run and have its say, and the class model is written afterwards, from
	 * here. Our own write re-enters the pre hook, which supercedes the re-entry so
	 * the mod cannot take a second bite at it.
	 */
	register_forward(FM_ClientUserInfoChanged, "fw_userinfo_post", 1);

	/*
	 * POST, so the engine has already filled the trace in and there is a result to
	 * rewrite. See fw_traceline -- this is what stops bots targeting their own side.
	 */
	register_forward(FM_TraceLine, "fw_traceline", 1);

	// Powerups, blocked where a BOT can actually be caught. See fw_touch.
	register_forward(FM_Touch, "fw_touch");

	// Intercept footstep sounds so mech models get mechwalk / mechwalk2 instead
	// of the stock player steps. Runs here with the other forwards.
	register_forward(FM_EmitSound, "fw_emit_sound");

	register_clcmd("say",      "hook_say");
	register_clcmd("say_team", "hook_say");

	// The pick menus are raw text (see build_team_menu); these route their keys back here.
	g_side_menuid  = register_menuid(TSM_SIDE_MENU);
	g_class_menuid = register_menuid(TSM_CLASS_MENU);
	register_menucmd(g_side_menuid,  1023, "team_menu_key");
	register_menucmd(g_class_menuid, 1023, "class_menu_key");

	register_concmd("amx_match_start",   "cmd_start",   ADMIN_CFG, " - force the match live");
	register_concmd("amx_match_cancel",  "cmd_cancel",  ADMIN_CFG, " - abort, send everyone to spectator, and return to warmup");
	register_concmd("amx_match_restart", "cmd_restart", ADMIN_CFG, " - restart the match from round 1");
	register_concmd("amx_match_score",   "cmd_score",   ADMIN_CFG, " - print the score");
	register_concmd("amx_match_continue","cmd_continue",ADMIN_CFG, " - resume a halted match as it stands, keeping the score");
	register_concmd("amx_tsm_fix",       "cmd_fix",     ADMIN_CFG, " <target> - force-restore a stuck player");
	register_concmd("amx_tsm_cloak",     "cmd_cloak_admin", ADMIN_CFG, " <target> - toggle a cloak on anyone, bots too, to see it from outside");
	register_concmd("amx_tsm_debug",     "cmd_debug",   ADMIN_CFG, " - why is nothing happening: teams, spawns, ready state");
	register_concmd("amx_tsm_ents",      "cmd_ents",    ADMIN_CFG, " - every entity classname in the world right now");
	/*
	 * Both spellings on purpose. amx_tsm_loc matches every other command in this family, and
	 * tsm_loc is what it gets called when somebody is standing in a map trying to describe where
	 * they are.
	 */
	register_concmd("amx_tsm_loc",       "cmd_loc",     ADMIN_CFG, " - exactly where you are standing, and what you are looking at");
	register_concmd("tsm_loc",           "cmd_loc",     ADMIN_CFG, " - the same as amx_tsm_loc");
	register_concmd("amx_tsm_unfreeze",  "cmd_unfreeze",ADMIN_CFG, " - force-release everyone (diagnostic)");

	// Spawn editing. Stand where you want a spawn and add it; save writes the
	// per-map cfg that is re-read automatically on every map load.
	register_concmd("amx_tsm_spawn_add",   "cmd_spawn_add",   ADMIN_CFG, " <1|2> - add a spawn for that team where you stand");
	register_concmd("amx_tsm_spawn_clear", "cmd_spawn_clear", ADMIN_CFG, " <1|2|0> - clear that team's spawns (0 = both)");
	register_concmd("amx_tsm_spawn_del",   "cmd_spawn_del",   ADMIN_CFG, " <1|2> <n> - remove one spawn");
	register_concmd("amx_tsm_spawn_list",  "cmd_spawn_list",  ADMIN_CFG, " - list configured spawns");
	register_concmd("amx_tsm_spawn_save",  "cmd_spawn_save",  ADMIN_CFG, " - write the per-map spawn cfg");
	register_concmd("amx_tsm_spawn_tp",    "cmd_spawn_tp",    ADMIN_CFG, " <1|2> <n> - teleport to a spawn to check it");

	// Solo testing without a second player.
	register_concmd("amx_tsm_simwin",      "cmd_simwin",      ADMIN_CFG, " <1|2> - award the current round to a team");
	register_concmd("amx_tsm_wave",         "cmd_wave",        ADMIN_CFG, " [1|2] - force a respawn wave now (both teams without a number)");
	register_concmd("amx_tsm_obj",         "cmd_obj",         ADMIN_CFG, " [reset|<n>] - the map's siege objectives: what has fallen; put them back, or say how many have fallen");
	register_concmd("amx_tsm_simelim",     "cmd_simelim",     ADMIN_CFG, " [target] - eliminate a player as if they were killed");
	register_concmd("tsm_opendoor",        "cmd_opendoor",    ADMIN_CFG, " - force open the door you are aiming at, locked or not");

	// THE SIEGE DEBUG SUITE: every stage of the satchel flow, on demand, with
	// no second player and not a single tsm_obj entity in the map required.
	register_concmd("amx_tsm_siege",       "cmd_siege",       ADMIN_CFG, " - dump the siege state: chain, planted fuse, holds, alarm, measured sounds");
	register_concmd("amx_tsm_siege_spawn", "cmd_siege_spawn", ADMIN_CFG, " [n] - place a synthetic objective where you look (no map entities needed)");
	register_concmd("amx_tsm_siege_plant", "cmd_siege_plant", ADMIN_CFG, " [n] - plant the satchel on an objective right now (the exact real path)");
	register_concmd("amx_tsm_siege_fuse",  "cmd_siege_fuse",  ADMIN_CFG, " - set the planted charge off this instant");
	register_concmd("amx_tsm_siege_alarm", "cmd_siege_alarm", ADMIN_CFG, " - force the raid alarm on, live round or not");
	register_concmd("amx_tsm_siege_reset", "cmd_siege_reset", ADMIN_CFG, " - fuse killed, alarm cut, every objective put back, chain at zero");

	// Called by the per-map spawn cfg. Not for humans.
	register_srvcmd("tsm_spawn", "srv_spawn");

	/*
	 * TS has no server-side "buy" command -- the buy menu is client-side VGUI in
	 * cl_dlls/client.dll reading tsbuylist.tsa. What it SENDS are these, and those do
	 * reach the server, so blocking them is what actually stops buying. Zeroing cash
	 * is not enough on its own: the equipment menu is slot-limited and always
	 * available, and usecash only layers an economy on top of it.
	 */
	register_clcmd("tkw",     "cmd_blockbuy");   // take weapon
	register_clcmd("tka",     "cmd_blockbuy");   // take ammo
	register_clcmd("tki",     "cmd_blockbuy");   // take item
	register_clcmd("rst_cfg", "cmd_blockbuy");   // reset saved equipment config
	register_clcmd("cashala", "cmd_blockbuy");   // undocumented, console-only

	// TS powerups: the command that activates one, and the cheat that grants one.
	register_clcmd("tsm_model", "cmd_model");
	register_clcmd("stim", "cmd_stim_console");
	register_clcmd("turret", "cmd_turret_console");
	register_clcmd("pickup", "cmd_pickup_console");

	// The mech sound bench. Console for a keybind, say .mechtest in hook_say for
	// use from chat -- it only ever plays sounds, so no dedicated say wrapper needed.
	register_clcmd("tsm_mechtest", "cmd_mechtest");

	register_clcmd("usepowerup", "cmd_blockpowerup");
	register_clcmd("powerup",    "cmd_blockpowerup");

	register_clcmd("say .class", "cmd_class");
	register_clcmd("say .team",  "cmd_team");
	register_clcmd("say .menu",  "cmd_legend");
	register_clcmd("say .roam",  "cmd_roam_say");

	// Ambient music, per player. tsm_music 0/1 in the client console, on by default.
	register_clcmd("tsm_music", "cmd_music", 0, "tsm_music 0/1 - ambient music on/off");
	g_cv_musicvol = register_cvar("tsm_music_volume", "0.5");

	// The round-start anthems: each side hears its own stinger one second into
	// a round. 0 turns the pair off entirely; tsm_music 0 still mutes the
	// sounds per client on top of this, the same switch the queue obeys.
	g_cv_startsound = register_cvar("tsm_startsound", "1");

	// Pass-through watchers. These return PLUGIN_CONTINUE so TS still handles the
	// command -- they exist only to prove whether it reaches the server at all.
	register_clcmd("jointeam",   "cmd_watch_join");
	register_clcmd("changeteam", "cmd_block_changeteam");

	register_concmd("amx_tsm_shuffle", "cmd_shuffle", ADMIN_CFG, " - attempt to even the teams out");
	register_concmd("amx_tsm_teaminfo", "cmd_teaminfo", ADMIN_CFG, " - dump the mod-side team state");
	register_concmd("amx_tsm_menu",     "cmd_menu",     ADMIN_CFG, " <side|class> - force a menu up for testing");
	register_concmd("amx_tsm_whystuck", "cmd_whystuck", ADMIN_CFG, " [target] - dump everything that can stop a player moving");
	register_concmd("amx_tsm_unstick",  "cmd_unstick",  ADMIN_CFG, " [target] - clear every hold and lift them clear of the floor");
	register_concmd("tsm_commands",     "cmd_commands", ADMIN_CFG, " - every tsm_ cvar this plugin has, name and current value");
	register_concmd("tsm_fogtest",      "cmd_fogtest",  ADMIN_CFG, " - toggles the sudden-death fog on or off for testing; needs tsm_logging 1");

	get_mapname(g_mapname, charsmax(g_mapname));
	copy(g_dbgfile, charsmax(g_dbgfile), "tsm_debug.log");

	tlog("[TSM] %s build %s loaded.", PLUGIN, TSM_BUILD);
	set_task(1.0, "task_tick", 0, "", 0, "b");

	// Squad steering runs far faster than the main tick: rcbot re-decides where its
	// bots are going every frame, so a once-a-second nudge would be overwritten long
	// before it moved anyone. Cheap while nobody has given an order -- the loop exits
	// on the first check for every bot without a leader.
	set_task(0.1, "task_squad", 11, "", 0, "b");

	// Teammate class/health readout. See task_hover_info.
	set_task(0.25, "task_hover_info", 12, "", 0, "b");

	// The bot join schedule: one rcbot addbot every two seconds until tsm_bots is
	// reached (rcbot's own auto-fill is switched OFF -- max_bots -1 -- in the
	// bots-ON branch, so this task is the ONLY thing that adds bots). Starting it
	// in plugin_init means it is running before the first deficit ever appears;
	// task_bot_fill itself reads tsm_bots each pass, so the cvar's exec order
	// cannot leave it in the wrong mode.
	set_task(2.0, "task_bot_fill", TSM_TASK_BOTFILL, "", 0, "b");

	// Quarter-second, which is comfortably inside the half-second steps TS fades on, so a
	// held corpse never shows a step of the fade it is being kept out of.
	set_task(0.25, "task_hold_corpses", 13, "", 0, "b");

	// Ambient music. Delayed so the first track does not start over the map's own intro.
	set_task(10.0, "task_music_queue", TSM_TASK_MUSIC);

	// Mech idle hum: re-emitted from every living mech so it hears as one loop.
	set_task(MECH_LOOP_PERIOD, "task_mech_loop", 21000, "", 0, "b");
	// Every sentry turret's sight and fire, ten times a second.
	set_task(0.1, "task_turrets", TSM_TASK_TURRET, "", 0, "b");
}

public plugin_cfg()
{
	// Load our own config rather than relying on someone remembering to exec it.
	// AMXX only auto-execs amxx.cfg, so a plugin-specific cfg is inert unless the
	// plugin asks for it. server_exec() forces the queued commands through now, so
	// the cvars are actually in effect before anything below reads them.
	new cfgdir[64], cfgfile[160];
	get_configsdir(cfgdir, charsmax(cfgdir));
	formatex(cfgfile, charsmax(cfgfile), "%s/ts_matchmode.cfg", cfgdir);

	if (file_exists(cfgfile))
	{
		server_cmd("exec %s", cfgfile);
		server_exec();
		tlog("[TSM] Executed %s", cfgfile);
	}
	else
	{
		tlog("[TSM] No config at %s -- using defaults. Teams will NOT work until tsm_team1_name and tsm_team2_name are set.", cfgfile);
	}

	// Not an H9 map (plugin_precache): the game as it ships. The match mode and its bots off, and TS's
	// own cash and powerups back over what game.cfg and ts_matchmode.cfg set for H9's maps. The map's
	// mapconfig runs after this and can set any of it back for its map.
	if (!g_map_h9)
	{
		set_pcvar_num(g_cv_enabled, 0);
		set_pcvar_num(g_cv_bots, 0);
		set_cvar_num("usecash", 0);
		set_cvar_num("initial_cash", 1200);
		set_cvar_num("cashforwin", 10000);
		set_cvar_num("cashforlose", 1200);
		set_cvar_num("nopowerup", 0);
		log_amx("[TSM] %s is not an H9 map: tsm_enabled 0, tsm_bots 0, and TS's own cash and powerups.", g_mapname);
	}

	get_mapname(g_mapname, charsmax(g_mapname));
	refresh_gamedesc();
	kill_ts_cash_cvars();
	load_classes();
	build_class_menu();
	build_team_menu();

	// Once now, and again shortly after, because the map's own worldspawn keyvalues
	// are applied around this point and would otherwise win the race.
	check_team_names();
	force_team_list();
	set_task(3.0, "task_force_teams", 6);
	collect_spawns();

	// Dispatched by task name: record_map_items() is defined further down the file and
	// this compiler rejects forward references. The short delay also lets any entity
	// the map spawns late settle first.
	set_task(0.5, "task_record_map_items", 7);
	dbg("plugin_cfg done on %s: build %s", g_mapname, TSM_BUILD);
	// Started once, here rather than in plugin_init, so the interval it arms with is
	// the one ts_matchmode.cfg asked for rather than the registration default.
	remove_task(TSM_TASK_REGEN);
	set_task(regen_interval(), "task_regen", TSM_TASK_REGEN);
}

public plugin_end()
{
	// Never leave anyone hidden, frozen or non-solid because the plugin unloaded -- the
	// cloak's EF_NODRAW included, so that comes off first.
	for (new i = 1; i < MAXPL; i++)
	{
		cloak_bots_show(i);
	}
	restore_all();

	// The icons are hidden, not removed: the map is ending, and the engine frees every edict
	// with it.
	for (new i = 1; i < MAXPL; i++)
	{
		drop_class_icon(i);
	}
}

/* ---- cloak: hidden from RCBot -------------------------------------------- */

/*
 * RCBOT DOES NOT TARGET WHAT IT IS TOLD IT CANNOT SEE.
 *
 * Its visibility list, its sight check and IsEnemy() all skip an entity carrying EF_NODRAW
 * (rcbot bot.cpp 5749, 6190, 8863), and a fight already going is dropped on its next think,
 * because the attack task asks IsEnemy() again. So a cloaked player carries EF_NODRAW whenever
 * RCBot thinks. It is not damage immunity: traces, bullets and blasts never look at EF_NODRAW,
 * and takedamage is not touched.
 *
 * WHEN is the whole difficulty. RCBot does all of its thinking in its own StartFrame pre-hook,
 * and fakemeta is a separate metamod plugin that AMXX loads after both plugins.ini entries, so
 * every FM_StartFrame hook here runs AFTER RCBot has already thought for the frame. The flag
 * therefore goes on at the END of one frame (fw_startframe_post) and comes off straight after
 * RCBot's think in the next (fw_startframe_pre), which puts every bot think inside it.
 *
 * It must never reach a client: TS's AddToFullPack drops an EF_NODRAW player from everybody
 * else's packet, and humans would lose him completely. fw_addtofullpack_pre lifts it for TS's
 * pack of that one entity and fw_addtofullpack puts it back. His own frame lifts it the same way
 * (fw_prethink to fw_postthink_post), so TS never sees it on him while it runs him.
 *
 * g_cloak_nodraw[] says the bit is the cloak's. A bit something else put there -- elimination, a
 * hold -- is never claimed and never taken off.
 */

/// The cloak is up and he is in the round: the only state it is drawn in, or hidden from bots in.
bool:cloak_active(id)
{
	return (g_cloaked[id] && is_user_alive(id) && !is_spectating(id) && !g_elim[id]
		&& !g_locked_out[id] && g_state == ST_LIVE);
}

/// Does sudden death show this player through walls to the other side right now? On
/// Xash only, where the engine patch draws the marker; a living body still in the round.
bool:xray_marks(ent)
{
	return (g_xash && g_sudden && get_pcvar_num(g_cv_sudden) > 0 && get_pcvar_num(g_cv_suddenxray)
		&& is_user_alive(ent) && !g_elim[ent]);
}

/// Puts the cloak's EF_NODRAW on him, unless something else has already hidden him.
cloak_bots_hide(id)
{
	// Not while an Officer's scan has him: for those seconds bots may see him too.
	if (g_cloak_nodraw[id] || !cloak_active(id) || g_scan_until[id] > get_gametime())
	{
		return;
	}
	new fx = pev(id, pev_effects);
	if (fx & TSM_EF_NODRAW)
	{
		return;   // not ours to claim
	}
	set_pev(id, pev_effects, fx | TSM_EF_NODRAW);
	g_cloak_nodraw[id] = true;
}

/// Takes the cloak's EF_NODRAW off him for good. A bit the cloak did not put there is left alone.
cloak_bots_show(id)
{
	if (!g_cloak_nodraw[id])
	{
		return;
	}
	g_cloak_nodraw[id] = false;
	set_pev(id, pev_effects, pev(id, pev_effects) & ~TSM_EF_NODRAW);
}

/*
 * Puts it back after his own frame lifted it. If something hid him during that frame, or the
 * cloak has ended, the cloak lets go of the bit instead and leaves it as it is.
 */
cloak_bots_restore(id)
{
	if (!g_cloak_nodraw[id])
	{
		return;
	}
	new fx = pev(id, pev_effects);
	if ((fx & TSM_EF_NODRAW) || !cloak_active(id))
	{
		g_cloak_nodraw[id] = false;
		return;
	}
	set_pev(id, pev_effects, fx | TSM_EF_NODRAW);
}

/// Straight after RCBot's think: off before TS's own StartFrame and AMXX's tasks run.
public fw_startframe_pre()
{
	for (new i = 1; i < MAXPL; i++)
	{
		cloak_bots_show(i);
	}
	return FMRES_IGNORED;
}

/// The end of StartFrame: on again for every live cloak, ready for RCBot's next think.
public fw_startframe_post()
{
	for (new i = 1; i < MAXPL; i++)
	{
		cloak_bots_hide(i);
	}
	return FMRES_IGNORED;
}

/* ---- class icons --------------------------------------------------------- */

/*
 * One sprite per player slot, made ONCE, at precache (see plugin_precache), and kept for the
 * whole map.
 *
 * Deliberately not created and destroyed as players live and die: entity churn is
 * what exhausted the edict table before and stopped weapons spawning at all. The
 * sprite is hidden when it should not be seen, and never removed.
 */
icon_entity(id)
{
	if (!g_icon_ok)
	{
		return 0;
	}
	if (g_icon_ent[id] > 0 && pev_valid(g_icon_ent[id]))
	{
		return g_icon_ent[id];
	}

	// Only reached when the precache pool has no icon for this slot. One made now lands above
	// every map entity, so it is the first thing cut wherever a view is crowded.
	new ent = make_class_icon(id, get_pcvar_float(g_cv_iconscale));
	if (!ent)
	{
		g_icon_ent[id] = 0;
		tlog("[TSM] WARNING: could not create a class icon for %d -- out of edicts?", id);
		return 0;
	}
	tlog("[TSM] class icon for %d made late, as edict %d -- it can drop out where a view is crowded.", id, ent);
	return ent;
}

/// Puts a player's icon where it belongs, on the right frame, or hides it.
update_class_icon(id)
{
	new ent = g_icon_ent[id];

	/*
	 * An icon over an invisible player is a free wallhack on their own side, and
	 * during the freeze countdown it marks a row of people nobody can see.
	 *
	 * Both ways of hiding a player are tested, because the plugin uses both: the
	 * warmup and freeze holds zero the alpha with rendermode set to a transparent
	 * mode, while elimination and the spectator hold use EF_NODRAW.
	 */
	new bool:unseen = ((pev(id, pev_effects) & TSM_EF_NODRAW) != 0)
		|| (pev(id, pev_rendermode) != TSM_RENDER_NORMAL
			&& Float:pev(id, pev_renderamt) <= 1.0);

	new bool:want = (get_pcvar_num(g_cv_enabled) != 0
		&& get_pcvar_num(g_cv_icons) != 0
		&& g_icon_ok
		&& g_class_count > 0
		&& is_user_alive(id) != 0
		&& !g_elim[id]
		&& !unseen
		&& g_match_team[id] >= 1
		&& g_match_team[id] <= 2);

	if (!want)
	{
		// Hidden rather than removed. Hiding costs one flag; removing costs an edict
		// and a rebuild the moment they respawn.
		if (ent > 0 && pev_valid(ent))
		{
			set_pev(ent, pev_effects, pev(ent, pev_effects) | TSM_EF_NODRAW);
		}
		return;
	}

	ent = icon_entity(id);
	if (!ent)
	{
		return;
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0)
	{
		return;
	}

	new Float:org[3];
	pev(id, pev_origin, org);
	org[2] += get_pcvar_float(g_cv_iconhigh);
	engfunc(EngFunc_SetOrigin, ent, org);

	/*
	 * One frame per class, in class order, so the sheet and the class table stay in step
	 * without a second mapping to keep correct -- and the insurgent side reads from the
	 * red copies further along the same sheet.
	 *
	 * tsm_live_team_of() rather than get_user_team(): every TS-side route to joining a
	 * team fails on this server, so g_match_team is the only thing that knows the sides.
	 */
	new frame = icon_frame_for(ci, tsm_live_team_of(id));
	if (frame < 0)
	{
		return;   // a class the sheet has no icon for: better nothing than somebody else's
	}
	set_pev(ent, pev_frame, float(frame));
	set_pev(ent, pev_scale, get_pcvar_float(g_cv_iconscale));
	set_pev(ent, pev_effects, pev(ent, pev_effects) & ~TSM_EF_NODRAW);
}

/*
 * Hides a player's icon when he leaves. The entity stays for whoever takes the slot next: its low
 * edict number is the whole point of it, and a freed edict would go to whatever is made next.
 */
drop_class_icon(id)
{
	new ent = g_icon_ent[id];
	if (ent > 0 && pev_valid(ent))
	{
		set_pev(ent, pev_effects, pev(ent, pev_effects) | TSM_EF_NODRAW);
	}
}

/*
 * What one viewer is shown of one player's icon: 0 nothing, 1 the icon in its own colour, 2 the
 * red copy that marks an enemy in sudden death. Both AddToFullPack hooks ask this, so the icon the
 * pre hook refuses and the frame the post hook writes cannot disagree.
 */
icon_view(owner, host)
{
	// Never your own: you know your class, and in third person or on a spectator camera it
	// would hang over your head for no reason.
	if (host == owner)
	{
		return 0;
	}

	// His own side sees it, in his own colour.
	if (g_match_team[host] >= 1 && g_match_team[host] == g_match_team[owner])
	{
		return 1;
	}

	// The other side sees it only as the sudden-death marker, and never over a cloaked Recon:
	// the marker would point straight at the man the cloak is hiding.
	if (g_sudden && g_state == ST_LIVE && get_pcvar_num(g_cv_sudden) > 0 && !g_cloaked[owner]
		&& g_match_team[host] >= 1 && g_match_team[host] <= 2
		&& g_match_team[owner] >= 1 && g_match_team[owner] <= 2
		&& icon_frame_for(resolved_class(owner) - 1, 2) >= 0)
	{
		return 2;
	}

	// Someone with no side -- a spectator, or a player still choosing -- is shown none of them,
	// because an icon is squad information and he is not on a squad.
	return 0;
}

/*
 * Shows each icon to its OWN SIDE only, and does not send it at all to anyone else.
 *
 * AddToFullPack is asked once per (viewer, entity) pair and decides what that one
 * viewer is told about that one entity, so it is the only place a thing can be
 * visible to some players and not to others.
 *
 * A withheld icon is refused outright here rather than sent hidden. The engine sends each client
 * at most 256 entities, so a hidden icon still spends a slot -- and in a crowded view those slots
 * are exactly what is short.
 *
 * The other job here is the cloak's EF_NODRAW: lifted for TS's pack of a cloaked player, so no
 * client ever receives it. fw_addtofullpack puts it back. See cloak_active().
 */
new g_afp_host;   // the viewer of the pack TS is building right now, for fw_checkvis

public fw_addtofullpack_pre(es, e, ent, host, hostflags, player, pSet)
{
	g_afp_host = host;

	// The real slot count, not MAXPL: the icons are made straight after the player slots, so on
	// a server with fewer than 32 of them they sit below MAXPL and would pass for players here.
	if (ent >= 1 && ent <= g_maxplayers)
	{
		if (g_cloak_nodraw[ent])
		{
			set_pev(ent, pev_effects, pev(ent, pev_effects) & ~TSM_EF_NODRAW);
		}
		return FMRES_IGNORED;
	}

	if (ent >= sizeof g_icon_owner || !g_icon_owner[ent])
	{
		return FMRES_IGNORED;   // not an icon; every other entity is left alone
	}
	if (!get_pcvar_num(g_cv_enabled) || !g_icon_ok || !get_pcvar_num(g_cv_icons))
	{
		return FMRES_IGNORED;
	}
	new owner = g_icon_owner[ent];
	if (host < 1 || host >= MAXPL || g_icon_ent[owner] != ent)
	{
		return FMRES_IGNORED;
	}

	if (!icon_view(owner, host))
	{
		forward_return(FMV_CELL, 0);
		return FMRES_SUPERCEDE;
	}
	return FMRES_IGNORED;
}

/*
 * Sends a living enemy to the viewer from beyond the viewer's PVS while sudden death's
 * x-ray is on, so the H9XASH engine has a body to draw through even a solid wall.
 * TS's AddToFullPack asks this about the entity it is packing; the viewer is the host
 * fw_addtofullpack_pre recorded for that same pack. Registered on Xash only.
 */
public fw_checkvis(ent, pset)
{
	if (!g_sudden || ent < 1 || ent > g_maxplayers)
	{
		return FMRES_IGNORED;
	}
	new host = g_afp_host;
	if (host < 1 || host > g_maxplayers || host == ent || g_state != ST_LIVE
		|| !g_match_team[ent] || !g_match_team[host] || g_match_team[ent] == g_match_team[host]
		|| !xray_marks(ent))
	{
		return FMRES_IGNORED;
	}
	forward_return(FMV_CELL, 1);
	return FMRES_SUPERCEDE;
}

/*
 * The cloak's EF_NODRAW goes back on, and the cloak itself is written into what the other
 * players are sent. Then the one icon change a pre hook cannot make: the red copy for an enemy
 * the pre hook let through in sudden death.
 */
public fw_addtofullpack(es, e, ent, host, hostflags, player, pSet)
{
	// Players only -- the same slot test as fw_addtofullpack_pre.
	if (ent >= 1 && ent <= g_maxplayers)
	{
		// First, before anything can return: it was lifted only for TS's pack of this entity.
		if (g_cloak_nodraw[ent])
		{
			set_pev(ent, pev_effects, pev(ent, pev_effects) | TSM_EF_NODRAW);
		}

		/*
		 * The cloak, written into the STATE sent to everyone but the cloaker. This is the last
		 * word on the wire, so a medic glow or its clear-glow task landing between his frame and
		 * this packet cannot flash him visible. Whole numbers: set_es() stores render fields as
		 * integers, and a Float here would arrive as its bit pattern.
		 */
		if (host != ent && get_orig_retval() && cloak_active(ent))
		{
			set_es(es, ES_RenderMode, TSM_RENDER_TEXTURE);
			set_es(es, ES_RenderAmt, floatround(get_pcvar_float(g_cv_cloakopacity)));
			set_es(es, ES_RenderFx, TSM_RENDERFX_NONE);
			set_es(es, ES_RenderColor, CLOAK_RGB);
		}

		/*
		 * THE SCAN MARK AND THE SUDDEN-DEATH X-RAY, decided per viewer exactly like the
		 * cloak above, and refused to anyone whose side is not entitled to the reveal.
		 *
		 * A scanned cloaked ENEMY to the viewer: a blue glow shell, the medic's
		 * kRenderFxGlowShell, which TS's own client draws on any engine, and the body
		 * taken out of the cloak's dimming -- the block above already wrote the shimmer
		 * for this same pair, and these lines are the last word on the wire. Uncloak
		 * inside the window and the blue stops; recloak and it is still live. The
		 * Officer's whole side sees it, the Officer included.
		 *
		 * Sudden death on Xash: every living enemy to the viewer, cloaked or not, carries
		 * the x-ray marker in their own side's colour, which the H9XASH engine draws as a
		 * glow shell through walls; fw_checkvis sends them from beyond the viewer's PVS
		 * as well. It wins over the scan's shell, which only shows in line of sight. A plain
		 * enemy's body is sent solid under it, so he shows nothing but the glow; a cloaked one
		 * keeps the cloak's mode and amount, or the scan's faint body if his side has scanned
		 * him. Steam is never sent the marker.
		 */
		if (get_orig_retval() && g_state == ST_LIVE && g_match_team[ent] && g_match_team[host]
			&& g_match_team[ent] != g_match_team[host])
		{
			new bool:scanned = (g_scan_until[ent] > get_gametime() && g_scan_team[ent] == g_match_team[host]
				&& cloak_active(ent) && g_cloaked[ent]);
			if (xray_marks(ent))
			{
				if (!cloak_active(ent))
				{
					// a plain enemy's body is solid: the glow is all the x-ray adds to him
					set_es(es, ES_RenderMode, TSM_RENDER_NORMAL);
					set_es(es, ES_RenderAmt, 255);   // the H9XASH shell sets its own thickness
				}
				else if (scanned)
				{
					// a scanned cloaked enemy keeps the faint body he has while cloaked
					set_es(es, ES_RenderMode, TSM_RENDER_NORMAL);
					set_es(es, ES_RenderAmt, 16);
				}
				set_es(es, ES_RenderFx, TSM_RENDERFX_XRAY);
				if (g_match_team[ent] == 1)
				{
					set_es(es, ES_RenderColor, XRAY_MSR_RGB);
				}
				else
				{
					set_es(es, ES_RenderColor, XRAY_INS_RGB);
				}
			}
			else if (scanned)
			{
				set_es(es, ES_RenderMode, TSM_RENDER_NORMAL);
				set_es(es, ES_RenderAmt, 16);   // glow-shell thickness, not an alpha
				set_es(es, ES_RenderFx, TSM_RENDERFX_GLOW);
				set_es(es, ES_RenderColor, SCAN_RGB);
			}
		}
		return FMRES_IGNORED;
	}

	if (ent >= sizeof g_icon_owner || !g_icon_owner[ent])
	{
		return FMRES_IGNORED;
	}
	if (!get_pcvar_num(g_cv_enabled) || !g_icon_ok || !get_pcvar_num(g_cv_icons))
	{
		return FMRES_IGNORED;
	}
	new owner = g_icon_owner[ent];
	if (host < 1 || host >= MAXPL || g_icon_ent[owner] != ent)
	{
		return FMRES_IGNORED;
	}

	/*
	 * SUDDEN DEATH SHOWS THE SAME SPRITE TO THE OTHER SIDE, IN RED, rather than giving every
	 * player a second entity to carry it.
	 *
	 * It was a second entity, and that was a mistake worth not repeating. One sprite per player
	 * became two, which is 32 more edicts on a full server -- enough that the mod could no longer
	 * create a ts_groundammo and the round died -- and 32 more entities in every packet, which is
	 * what pushed clients into svc_bad.
	 *
	 * AddToFullPack is asked once per (viewer, entity) pair and what it writes is the state sent
	 * to THAT viewer, so one entity can be a different frame for each of them. Always the red
	 * copy here, whatever side the owner is on: in sudden death this is the marker the OTHER
	 * side sees, and red is what says "enemy".
	 */
	if (icon_view(owner, host) == 2)
	{
		set_es(es, ES_Frame, float(icon_frame_for(resolved_class(owner) - 1, 2)));
	}
	return FMRES_IGNORED;
}

/* ---- spawn points -------------------------------------------------------- */

/*
 * Records every ground weapon and ammo box the MAP placed.
 *
 * Taken once, after the map has spawned its entities and before anyone can drop
 * anything, so the sweep below can tell a mapper's pickup from a player's discard.
 * Entity indices are safe to compare against: map entities are never removed, so a
 * dropped weapon can never inherit one of their slots while they still exist.
 */
public task_record_map_items()
{
	record_map_items();
}

record_map_items()
{
	g_map_item_count = 0;

	new ent;
	for (new pass = 0; pass < 2; pass++)
	{
		ent = -1;
		for (new guard = 0; guard < 256 && g_map_item_count < sizeof(g_map_items); guard++)
		{
			ent = engfunc(EngFunc_FindEntityByString, ent, "classname",
				pass == 0 ? "ts_groundweapon" : "ts_groundammo");
			if (ent <= 0)
			{
				break;
			}
			g_map_items[g_map_item_count] = ent;
			g_map_item_count++;
		}
	}

	tlog("[TSM] Recorded %d map-placed weapon/ammo pickup(s).", g_map_item_count);

	/*
	 * THE OBJECTIVE BODIES, for siege_reset()'s rebuild. One pass over the
	 * targetnames captures everything a body needs to exist again after it
	 * died: classname, brush model, the mapper's own health and spawnflags,
	 * the fall target, its origin and angles, and its render settings.
	 * Private class-data keyvalues the engine consumes
	 * at spawn (material, gib type) are NOT replayable, which MAP_ENTITIES.txt
	 * says plainly -- an objective breakable should stay an ordinary one.
	 *
	 * A body missing entirely (present neither in world nor in cache) means
	 * the objective never existed; a "missing" ENTITY that still has a cache
	 * is exactly the state a previous round broke and rebuild undoes.
	 */
	new objname[16];
	new objent, objcount;
	for (new n = 1; n <= TSM_OBJ_MAX; n++)
	{
		formatex(objname, charsmax(objname), "%s%d", TSM_OBJ_PREFIX, n);
		objent = engfunc(EngFunc_FindEntityByString, -1, "targetname", objname);
		if (objent <= 0)
		{
			g_obj_class[n][0] = 0;
			g_obj_model[n][0] = 0;
			g_obj_health[n] = 0.0;
			g_obj_spawnflags[n] = 0;
			g_obj_target[n][0] = 0;
			continue;
		}
		objcount++;
		pev(objent, pev_classname, g_obj_class[n], charsmax(g_obj_class[]));
		pev(objent, pev_model, g_obj_model[n], charsmax(g_obj_model[]));
		pev(objent, pev_target, g_obj_target[n], charsmax(g_obj_target[]));
		g_obj_health[n] = Float:pev(objent, pev_health);
		g_obj_spawnflags[n] = pev(objent, pev_spawnflags);
		pev(objent, pev_origin, g_obj_origin[n]);
		pev(objent, pev_angles, g_obj_angles[n]);
		g_obj_rendermode[n] = pev(objent, pev_rendermode);
		g_obj_renderamt[n] = Float:pev(objent, pev_renderamt);
		pev(objent, pev_rendercolor, g_obj_rendercolor[n]);
		g_obj_renderfx[n] = pev(objent, pev_renderfx);
	}
	tlog("[TSM] Recorded %d siege objective bod(ies) for the rebuild cache.", objcount);
}

bool:is_map_item(ent)
{
	for (new i = 0; i < g_map_item_count; i++)
	{
		if (g_map_items[i] == ent)
		{
			return true;
		}
	}
	return false;
}

/// Clears everything players dropped, leaving the map's own pickups in place.
/// Clears TS powerup pickups out of the arena.
sweep_powerups()
{
	if (!get_pcvar_num(g_cv_nopowerups))
	{
		return;
	}

	new ent = -1, removed = 0;
	for (new guard = 0; guard < 128; guard++)
	{
		ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "ts_powerup");
		if (ent <= 0)
		{
			break;
		}
		if (!pev_valid(ent))
		{
			continue;
		}

		// Hidden and intangible rather than deleted, so the map's own respawn logic has
		// nothing to trip over and the entity can come back if this is switched off.
		set_pev(ent, pev_effects, pev(ent, pev_effects) | TSM_EF_NODRAW);
		set_pev(ent, pev_solid, TSM_SOLID_NOT);
		removed++;
	}

	if (removed)
	{
		dbgv("round start: hid %d powerup pickup(s)", removed);
	}
}

sweep_dropped_items()
{
	if (!get_pcvar_num(g_cv_sweepdrops))
	{
		return;
	}

	/*
	 * Not while bots are playing.
	 *
	 * rcbot arms its bots by spawning a ts_groundweapon for them to walk into
	 * (UTIL_makeTSweapon). That is indistinguishable from a weapon a player dropped --
	 * both are ts_groundweapon entities that were not present when the map loaded --
	 * so this sweep was deleting bots' guns before they could pick them up, which is
	 * why they ran at people punching.
	 *
	 * The warmup-drop exploit this guards against is the lesser problem of the two, and
	 * it only exists on servers with humans to exploit it.
	 */
	if (get_pcvar_num(g_cv_bots))
	{
		dbgv("drop sweep skipped: bots are enabled and rcbot arms them with ground weapons");
		return;
	}

	new ent, removed = 0;
	for (new pass = 0; pass < 2; pass++)
	{
		ent = -1;
		for (new guard = 0; guard < 256; guard++)
		{
			ent = engfunc(EngFunc_FindEntityByString, ent, "classname",
				pass == 0 ? "ts_groundweapon" : "ts_groundammo");
			if (ent <= 0)
			{
				break;
			}
			if (!pev_valid(ent) || is_map_item(ent))
			{
				continue;
			}

			set_pev(ent, pev_flags, pev(ent, pev_flags) | TSM_FL_KILLME);
			removed++;
		}
	}

	if (removed)
	{
		dbg("round start: swept %d dropped weapon/ammo pickup(s)", removed);
	}
}

collect_spawns()
{
	new mode[16];
	get_pcvar_string(g_cv_spawnmode, mode, charsmax(mode));

	// The per-map cfg wins whenever it has anything to say. Scanning map entities is
	// a fallback for maps nobody has placed spawns on yet: TS maps are deathmatch
	// maps, so their spawn pool was never authored with two teams in mind and the
	// geometric split below is a guess by nature.
	if (!equali(mode, "entity"))
	{
		if (load_spawn_cfg() > 0)
		{
			g_spawn_count = 0;
			tlog("[TSM] Using configured spawns for %s (team1=%d team2=%d).",
				g_mapname, g_spawn_t1_count, g_spawn_t2_count);
			return;
		}

		if (equali(mode, "config"))
		{
			tlog("[TSM] tsm_spawn_mode is 'config' and %s has no spawn cfg. Place spawns with amx_tsm_spawn_add then amx_tsm_spawn_save.", g_mapname);
			return;
		}
	}

	g_spawn_count = 0;
	new ent = -1;
	new Float:org[3];

	// Standard HL1 deathmatch spawns. Collected once so round reset can place
	// players without having to kill them and wait for the mod to respawn them.
	while (g_spawn_count < sizeof(g_spawns))
	{
		ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "info_player_deathmatch");
		if (ent <= 0)
		{
			break;
		}
		pev(ent, pev_origin, org);
		g_spawns[g_spawn_count][0] = org[0];
		g_spawns[g_spawn_count][1] = org[1];
		g_spawns[g_spawn_count][2] = org[2];
		g_spawn_count++;
	}

	new dm_count = g_spawn_count;

	// info_player_start as well, ALWAYS rather than only as a fallback. The first
	// run found exactly one deathmatch spawn, which is far too few to separate two
	// teams -- so every candidate classname gets gathered and counted.
	ent = -1;
	while (g_spawn_count < sizeof(g_spawns))
	{
		ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "info_player_start");
		if (ent <= 0)
		{
			break;
		}
		pev(ent, pev_origin, org);
		g_spawns[g_spawn_count][0] = org[0];
		g_spawns[g_spawn_count][1] = org[1];
		g_spawns[g_spawn_count][2] = org[2];
		g_spawn_count++;
	}
	new start_count = g_spawn_count - dm_count;

	tlog("[TSM] Spawns: info_player_deathmatch=%d info_player_start=%d total=%d",
		dm_count, start_count, g_spawn_count);
	if (g_spawn_count < 2)
	{
		tlog("[TSM] WARNING: fewer than 2 spawn points. Both teams will share them, so they will spawn on top of each other. This map may use a spawn entity this plugin does not know about.");
	}
	partition_spawns();
}

/*
 * Splits the spawn points into two team clusters.
 *
 * TS is deathmatch, so its maps have one undifferentiated pool of spawns. Dropping
 * both teams into that pool means they can spawn on top of each other, which breaks
 * a round before it starts.
 *
 * So: find the two spawns furthest apart and treat them as the two "ends" of the
 * map, then assign every spawn to whichever end it is closer to. Entirely
 * map-agnostic and needs no per-map configuration, which matters for a mod whose
 * maps were never authored with teams in mind.
 */
partition_spawns()
{
	g_spawn_t1_count = 0;
	g_spawn_t2_count = 0;

	if (g_spawn_count < 2)
	{
		// Nothing to split. Both teams share what little there is.
		for (new i = 0; i < g_spawn_count; i++)
		{
			copy_vec(g_spawn_t1[g_spawn_t1_count], g_spawns[i]);
			g_spawn_t1_tier[g_spawn_t1_count] = 0;
			g_spawn_t1_count++;
			copy_vec(g_spawn_t2[g_spawn_t2_count], g_spawns[i]);
			g_spawn_t2_tier[g_spawn_t2_count] = 0;
			g_spawn_t2_count++;
		}
		tlog("[TSM] Only %d spawn(s) -- teams share them.", g_spawn_count);
		return;
	}

	// The most distant pair becomes the two anchors.
	new best_a = 0, best_b = 1;
	new Float:best_d = 0.0;
	for (new i = 0; i < g_spawn_count; i++)
	{
		for (new j = i + 1; j < g_spawn_count; j++)
		{
			new Float:d = get_distance_f(g_spawns[i], g_spawns[j]);
			if (d > best_d)
			{
				best_d = d;
				best_a = i;
				best_b = j;
			}
		}
	}

	for (new k = 0; k < g_spawn_count; k++)
	{
		new Float:da = get_distance_f(g_spawns[k], g_spawns[best_a]);
		new Float:db = get_distance_f(g_spawns[k], g_spawns[best_b]);
		if (da <= db)
		{
			if (g_spawn_t1_count < sizeof(g_spawn_t1))
			{
				copy_vec(g_spawn_t1[g_spawn_t1_count], g_spawns[k]);
				g_spawn_t1_tier[g_spawn_t1_count] = 0;
				g_spawn_t1_count++;
			}
		}
		else
		{
			if (g_spawn_t2_count < sizeof(g_spawn_t2))
			{
				copy_vec(g_spawn_t2[g_spawn_t2_count], g_spawns[k]);
				g_spawn_t2_tier[g_spawn_t2_count] = 0;
				g_spawn_t2_count++;
			}
		}
	}

	tlog("[TSM] Spawn clusters: team1=%d team2=%d (anchors %.0f units apart).",
		g_spawn_t1_count, g_spawn_t2_count, best_d);
}

copy_vec(Float:dest[3], const Float:src[3])
{
	dest[0] = src[0];
	dest[1] = src[1];
	dest[2] = src[2];
}

/*
 * Whether warmup should hold players.
 *
 * Hard safety rule: if the team names are not configured, tsm_live_team_of() returns
 * 0 for everybody, nobody can ever satisfy ready-up, and holding players would brick
 * the server with no way out. So the hold is REFUSED until teams are usable, and the
 * reason is said out loud rather than left as a mystery.
 */
/* ---- team assignment ----------------------------------------------------- */

/*
 * Attempts to move a player onto a team.
 *
 * No TS native does this -- tsfun, tsx and tsconst contain no team setter at all --
 * so this tries the two generic mechanisms and records which one stuck. Treat a
 * success here as discovered rather than assumed: tsm_debug.log has the answer.
 */
bool:try_set_team(id, team)
{
	if (!is_user_connected(id) || team < 1 || team > 2)
	{
		return false;
	}

	new name[32];
	team_rawname(team, name, charsmax(name));

	new before = tsm_live_team_of(id);

	// 1. the team userinfo key
	if (name[0])
	{
		new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);
		engfunc(EngFunc_SetClientKeyValue, id, buf, "team", name);
	}

	// 2. the entvar
	set_pev(id, pev_team, team);

	new after = tsm_live_team_of(id);
	dbg("try_set_team %N -> %d: live team was %d, now %d", id, team, before, after);

	return (after == team);
}

/*
 * The mod moves a player to spectator in some situations -- staying dead was the one
 * that bit us. Our own g_match_team stays authoritative regardless, so round logic
 * never breaks, but the player's scoreboard and team chat do, so put them back.
 */
reassert_team(id)
{
	if (!get_pcvar_num(g_cv_nospec))
	{
		return;
	}
	if (!is_user_connected(id) || g_match_team[id] < 1)
	{
		return;
	}

	// Advisory only. g_match_team is authoritative now, so this exists purely to nudge
	// TS's own display back into agreement and must never write to g_match_team.
	//
	// Rate limited hard: each attempt rewrites the team userinfo key, and TS responds
	// by re-applying the player's model. Doing that once a second is a model reload
	// once a second.
	if (get_user_team(id) != g_match_team[id]
		&& (get_gametime() - g_reassert_at[id]) > 30.0)
	{
		g_reassert_at[id] = get_gametime();
		dbgv("reassert_team: %d live=%d ours=%d -- rewriting team key",
			id, get_user_team(id), g_match_team[id]);
		try_set_team(id, g_match_team[id]);
	}
}

/* ---- team balance -------------------------------------------------------- */

/*
 * The team's display name. Server team names arrive lowercase ("msr"), which reads
 * like a typo in a HUD. upper is for the all-caps HUD; otherwise just the first
 * letter is capitalised, for chat.
 */
team_label(team, out[], len, bool:upper)
{
	if (team == 1)
	{
		get_pcvar_string(g_cv_team1name, out, len);
	}
	else
	{
		get_pcvar_string(g_cv_team2name, out, len);
	}

	if (!out[0])
	{
		formatex(out, len, "Team %d", team);
	}

	if (upper)
	{
		strtoupper(out);
	}
	else if (out[0] >= 'a' && out[0] <= 'z')
	{
		out[0] -= 32;
	}
}

count_on_team(team)
{
	new n = 0;
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		if (tsm_live_team_of(players[i]) == team)
		{
			n++;
		}
	}
	return n;
}

/**
 * How many players BELONG to a side, whether or not they are still in the round.
 *
 * This is the count that decides whether a match can go on. count_on_team() cannot: it
 * reads g_match_team, which elimination zeroes, so it reports a wiped-out side as having
 * nobody left -- and a wiped-out side is the normal end of every round here.
 */
count_side(team)
{
	new n = 0;
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		if (g_side[players[i]] == team)
		{
			n++;
		}
	}
	return n;
}

/*
 * The same count, PEOPLE ONLY.
 *
 * count_on_team() counts bodies, which is the right definition of an even game: a side
 * of three humans and a bot plays four. It is the wrong definition of someone leaving.
 * rcbot refills a gap within a second or two, so a human walking out mid-match left the
 * totals even and nothing ever halted -- the match simply carried on with a bot standing
 * in for the player who had gone.
 */
count_humans_on_team(team)
{
	new n = 0;
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		/*
		 * g_side, NOT tsm_live_team_of.
		 *
		 * tsm_live_team_of resolves to g_match_team, and set_ts_spectator zeroes that
		 * when it benches an eliminated player -- so being eliminated took you out of
		 * your own side's HUMAN count. On a server with one human and bots that meant
		 * the first time that human died, h1 and h2 were both nought, and the caller
		 * decided every human had left and abandoned the match back to warmup, mid
		 * round, for no reason anyone could see.
		 *
		 * g_side is the side a player belongs to for the whole match and elimination
		 * does not touch it, which is the entire reason it exists.
		 */
		if (!is_user_bot(players[i]) && g_side[players[i]] == team)
		{
			n++;
		}
	}
	return n;
}

/*
 * True when the teams are close enough in size to play. "off" always passes, "warn"
 * passes but complains, "block" and "shuffle" hold the match up.
 */
bool:balance_ok()
{
	new mode[16];
	get_pcvar_string(g_cv_balmode, mode, charsmax(mode));
	if (equali(mode, "off"))
	{
		return true;
	}

	// Side 2 bots only by design (survival): the sides are meant to be uneven.
	if (mode_flag(TSM_MODE_SIDE2_BOTS))
	{
		return true;
	}

	new gap = count_on_team(1) - count_on_team(2);
	if (gap < 0)
	{
		gap = -gap;
	}

	if (gap <= get_pcvar_num(g_cv_balgap))
	{
		return true;
	}

	return (equali(mode, "warn") != 0);
}

/*
 * The team name EXACTLY as configured, for anything that writes it back to the mod.
 *
 * team_label() capitalises for display -- "msr" becomes "Msr" -- which is correct on a
 * HUD and wrong everywhere else. Writing the prettified form into the team userinfo
 * key put players on a team name that is not in mp_teamlist, which dropped them off
 * the scoreboard and stopped them joining a team at all.
 */
team_rawname(team, out[], len)
{
	if (team == 1)
	{
		get_pcvar_string(g_cv_team1name, out, len);
	}
	else
	{
		get_pcvar_string(g_cv_team2name, out, len);
	}
}

/// Maps a team NAME back to our 1 or 2, or 0 if it is neither side.
tsm_team_from_name(const name[])
{
	if (!name[0])
	{
		return 0;
	}

	new t1[32], t2[32];
	team_rawname(1, t1, charsmax(t1));
	team_rawname(2, t2, charsmax(t2));

	if (t1[0] && equali(name, t1))
	{
		return 1;
	}
	if (t2[0] && equali(name, t2))
	{
		return 2;
	}
	return 0;
}

/*
 * A short team name for the score line. "INSURRECTIONISTS 0 -- 0 MSR" does not fit a
 * HUD, so a long name is cut to three letters unless an explicit abbreviation is set.
 */
/*
 * The full name for chat: 'the Middle Sea Republic' rather than 'Msr'.
 *
 * team_label() returns the short JOIN name, which is what the mod needs and what a
 * scoreboard wants, but reads like a typo in a sentence.
 */
team_display(team, out[], len)
{
	if (team == 1)
	{
		get_pcvar_string(g_cv_t1label, out, len);
	}
	else
	{
		get_pcvar_string(g_cv_t2label, out, len);
	}

	if (!out[0])
	{
		team_label(team, out, len, false);
	}
}

team_short(team, out[], len)
{
	if (team == 1)
	{
		get_pcvar_string(g_cv_t1short, out, len);
	}
	else
	{
		get_pcvar_string(g_cv_t2short, out, len);
	}

	if (out[0])
	{
		strtoupper(out);
		return;
	}

	team_label(team, out, len, true);
	if (strlen(out) > 4)
	{
		out[3] = 0;
	}
}

/// True when the mod has this player on the spectator team.
bool:on_spectator_team(id)
{
	new sp[32];
	get_pcvar_string(g_cv_specteam, sp, charsmax(sp));
	if (!sp[0])
	{
		return false;
	}

	new tname[32];
	tname[0] = 0;
	get_user_team(id, tname, charsmax(tname));

	return (tname[0] != 0 && equali(tname, sp));
}

/*
 * Parks a player as a spectator: off both sides, out of the match, held and hidden.
 *
 * Shared by joining, by the Spectate menu option and by the end of a match, so those
 * three cannot drift apart.
 */
force_spectator(id)
{
	if (!is_user_connected(id))
	{
		return;
	}

	if (!on_spectator_team(id))
	{
		if (live_spectator_index() <= 0)
		{
			// Sending an unresolvable jointeam would auto-assign them to a PLAYING side,
			// the exact opposite of spectating, so it is not sent at all.
			tlog("[TSM] WARNING: spectator team is not in mp_teamlist. Add it and change map -- mp_teamlist is only read at map load.");
		}
	}

	g_spectator[id] = true;
	set_ts_spectator(id);
	g_player_class[id] = 0;
	set_spectator_model(id);

	// Cleared so the side menu will offer itself again.
	g_team_menu_at[id] = 0.0;
	g_class_menu_at[id] = 0.0;
}

/*
 * The staggered form of the match-end move. task_to_warmup schedules one of these
 * per player instead of moving the whole roster in a single frame, because a
 * synchronous roster's worth of team changes and teleports reliably overflowed
 * the per-client datagram the moment a match ended.
 */
public task_force_spec_late(taskid)
{
	new id = taskid - 7800;
	if (is_user_connected(id))
	{
		force_spectator(id);
	}
}

/// First connected player who is not on a recognised team, or 0 if everyone is.
id_of_first_teamless()
{
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		if (!tsm_live_team_of(players[i]))
		{
			return players[i];
		}
	}
	return 0;
}

/// The team that needs people, or 0 when the teams are even enough.
balance_short_team()
{
	new n1 = count_on_team(1);
	new n2 = count_on_team(2);
	new allowed = get_pcvar_num(g_cv_balgap);

	if (n1 - n2 > allowed)
	{
		return 2;
	}
	if (n2 - n1 > allowed)
	{
		return 1;
	}
	return 0;
}

/*
 * Brings people in to even up the sides, between rounds.
 *
 * Run at round start rather than the moment someone leaves: dropping a player into a
 * round already in progress is worse than playing it short, and the next round starts
 * seconds later anyway.
 */

autofill_teams()
{
	new mode = get_pcvar_num(g_cv_autofill);
	if (!mode)
	{
		return;
	}

	// Where side 2 is bots by design (survival) there is no evening up to do, and a person
	// must never be filled onto the enemy wave. A late joiner waits for the next run.
	if (mode_flag(TSM_MODE_SIDE2_BOTS))
	{
		return;
	}

	new allowed = get_pcvar_num(g_cv_balgap);
	if (allowed < 1)
	{
		allowed = 1;
	}

	new players[32], pnum;
	get_players(players, pnum, g_pf);

	// Two passes: people who were locked out of the match first, because they were
	// trying to play. Only then anyone who deliberately chose to spectate.
	for (new pass = 0; pass < 2; pass++)
	{
		if (pass == 1 && mode < 2)
		{
			break;
		}

		for (new i = 0; i < pnum; i++)
		{
			new id = players[i];

			if (g_match_team[id] == 1 || g_match_team[id] == 2)
			{
				continue;   // already playing
			}
			if (pass == 0 && !g_locked_out[id])
			{
				continue;
			}

			new n1 = count_on_team(1);
			new n2 = count_on_team(2);
			new gap = n1 - n2;
			if (gap < 0)
			{
				gap = -gap;
			}

			// Both sides are fine, or neither has anyone -- nothing to fill.
			if (gap <= allowed && n1 > 0 && n2 > 0)
			{
				return;
			}

			new short_team = (n1 <= n2) ? 1 : 2;

			g_locked_out[id] = false;
			g_spectator[id] = false;
			g_player_class[id] = 0;
			set_ts_team(id, short_team);

			new shown[48];
			team_display(short_team, shown, charsmax(shown));
			client_print(id, print_chat, "[MATCH] A side was short -- you are in, on %s.", shown);

			new nm[32];
			get_user_name(id, nm, charsmax(nm));
			all_print("[MATCH] %s joins %s to even the sides.", nm, shown);
			dbg("autofill: %d -> team %d (was %d v %d)", id, short_team, n1, n2);
		}
	}
}

public cmd_shuffle(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	if (mode_flag(TSM_MODE_SIDE2_BOTS))
	{
		console_print(id, "[TSM] This is a %s map: side 2 is bots only, so there is nothing to shuffle.", g_mode_name);
		return PLUGIN_HANDLED;
	}

	new short_team = balance_short_team();
	if (!short_team)
	{
		console_print(id, "[TSM] Teams are already within tsm_balance_gap (%d).", get_pcvar_num(g_cv_balgap));
		return PLUGIN_HANDLED;
	}

	new big = 1;
	if (short_team == 1)
	{
		big = 2;
	}

	new players[32], pnum, moved = 0;
	get_players(players, pnum, g_pf);

	for (new i = 0; i < pnum; i++)
	{
		if (!balance_short_team())
		{
			break;
		}
		if (tsm_live_team_of(players[i]) != big)
		{
			continue;
		}
		if (try_set_team(players[i], short_team))
		{
			moved++;
		}
	}

	if (moved)
	{
		console_print(id, "[TSM] Moved %d player(s) to team %d.", moved, short_team);
		all_print("[MATCH] Teams shuffled for balance.");
	}
	else
	{
		console_print(id, "[TSM] Could not move anyone. TS exposes no team setter, so this has to be done by hand -- see tsm_debug.log for what was tried.");
	}
	return PLUGIN_HANDLED;
}

/* ---- configured spawn points -------------------------------------------- */

add_cfg_spawn(team, const Float:org[3], const Float:ang[3], tier = 0)
{
	if (team == 1 && g_spawn_t1_count < sizeof(g_spawn_t1))
	{
		copy_vec(g_spawn_t1[g_spawn_t1_count], org);
		g_spawn_t1_tier[g_spawn_t1_count] = tier;
		copy_vec(g_ang_t1[g_spawn_t1_count], ang);
		g_spawn_t1_count++;
	}
	else if (team == 2 && g_spawn_t2_count < sizeof(g_spawn_t2))
	{
		copy_vec(g_spawn_t2[g_spawn_t2_count], org);
		g_spawn_t2_tier[g_spawn_t2_count] = tier;
		copy_vec(g_ang_t2[g_spawn_t2_count], ang);
		g_spawn_t2_count++;
	}
	else
	{
		return 0;
	}

	g_cfg_spawns++;
	g_spawns_have_angles = true;

	// The map's own spawn entities are retired the moment this map has one custom
	// position. Without this, spawns added mid-map left the earlier entity scan in
	// place and a team with no custom positions kept using the map's.
	g_spawn_count = 0;

	return 1;
}

/*
 * tsm_spawn <team> <x> <y> <z> [pitch] [yaw]
 *
 * A server command rather than a set of cvars: a map needs an arbitrary number of
 * spawns per team, which fixed cvars cannot express. The per-map cfg is just a list
 * of these, and exec'ing that file is what loads them.
 */
public srv_spawn()
{
	if (read_argc() < 5)
	{
		server_print("[TSM] usage: tsm_spawn <team 1|2> <x> <y> <z> [pitch] [yaw]");
		return PLUGIN_HANDLED;
	}

	new a[16];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);

	new Float:org[3], Float:ang[3];
	read_argv(2, a, charsmax(a));
	org[0] = str_to_float(a);
	read_argv(3, a, charsmax(a));
	org[1] = str_to_float(a);
	read_argv(4, a, charsmax(a));
	org[2] = str_to_float(a);

	if (read_argc() > 5)
	{
		read_argv(5, a, charsmax(a));
		ang[0] = str_to_float(a);
	}
	if (read_argc() > 6)
	{
		read_argv(6, a, charsmax(a));
		ang[1] = str_to_float(a);
	}

	new tier = 0;
	if (read_argc() > 7)
	{
		read_argv(7, a, charsmax(a));
		tier = str_to_num(a);
	}

	if (team < 1 || team > 2)
	{
		server_print("[TSM] tsm_spawn: team must be 1 or 2, got %d", team);
		return PLUGIN_HANDLED;
	}

	if (!add_cfg_spawn(team, org, ang, tier))
	{
		server_print("[TSM] tsm_spawn: team %d spawn list is full", team);
	}
	return PLUGIN_HANDLED;
}

spawn_cfg_path(path[], len)
{
	new cfgdir[64];
	get_configsdir(cfgdir, charsmax(cfgdir));
	formatex(path, len, "%s/tsm_spawns_%s.cfg", cfgdir, g_mapname);
}

load_spawn_cfg()
{
	g_cfg_spawns = 0;
	g_spawn_t1_count = 0;
	g_spawn_t2_count = 0;
	g_spawns_have_angles = false;

	new path[160];
	spawn_cfg_path(path, charsmax(path));

	if (!file_exists(path))
	{
		dbg("no spawn cfg at %s", path);
		return 0;
	}

	server_cmd("exec %s", path);
	server_exec();
	tlog("[TSM] Loaded %d spawn(s) from %s (team1=%d team2=%d)",
		g_cfg_spawns, path, g_spawn_t1_count, g_spawn_t2_count);

	prune_map_spawns();
	return g_cfg_spawns;
}

/// True when this position sits on top of one of the map's own spawn entities.
bool:is_map_spawn(const Float:org[3])
{
	new Float:limit = get_pcvar_float(g_cv_prunedist);
	if (limit <= 0.0)
	{
		return false;
	}

	for (new i = 0; i < g_spawn_count; i++)
	{
		new Float:d[3];
		d[0] = org[0] - g_spawns[i][0];
		d[1] = org[1] - g_spawns[i][1];
		d[2] = org[2] - g_spawns[i][2];

		if (vector_length(d) <= limit)
		{
			return true;
		}
	}
	return false;
}

/*
 * Drops any custom spawn that sits on one of the map's own spawn entities.
 *
 * Adding a spawn while standing on an info_player_start records the map's position as
 * though it were a deliberate choice -- and doing it for both sides puts both teams on
 * the same point, which is how the two teams ended up spawning on top of each other.
 * The custom set exists to REPLACE the map's spawns, so a copy of one in it is always
 * a mistake rather than a preference.
 *
 * Run after loading the per-map cfg, so an old file with the mistake already baked in
 * is cleaned up without anyone having to notice.
 */
prune_map_spawns()
{
	if (!g_spawn_count || !get_pcvar_num(g_cv_prune))
	{
		return 0;
	}

	new dropped = 0;

	for (new team = 1; team <= 2; team++)
	{
		new count = (team == 1) ? g_spawn_t1_count : g_spawn_t2_count;

		for (new i = count - 1; i >= 0; i--)
		{
			new Float:org[3];
			if (team == 1)
			{
				copy_vec(org, g_spawn_t1[i]);
			}
			else
			{
				copy_vec(org, g_spawn_t2[i]);
			}

			if (!is_map_spawn(org))
			{
				continue;
			}

			// Shuffle the rest down over the hole, exactly as amx_tsm_spawn_del does.
			for (new k = i; k < count - 1; k++)
			{
				if (team == 1)
				{
					copy_vec(g_spawn_t1[k], g_spawn_t1[k + 1]);
					copy_vec(g_ang_t1[k], g_ang_t1[k + 1]);
					g_spawn_t1_tier[k] = g_spawn_t1_tier[k + 1];
				}
				else
				{
					copy_vec(g_spawn_t2[k], g_spawn_t2[k + 1]);
					copy_vec(g_ang_t2[k], g_ang_t2[k + 1]);
					g_spawn_t2_tier[k] = g_spawn_t2_tier[k + 1];
				}
			}

			count--;
			dropped++;
			tlog("[TSM] Pruned team %d spawn #%d at %.0f %.0f %.0f -- it is one of the map's own spawn points.",
				team, i + 1, org[0], org[1], org[2]);
		}

		if (team == 1)
		{
			g_spawn_t1_count = count;
		}
		else
		{
			g_spawn_t2_count = count;
		}
	}

	if (dropped)
	{
		g_cfg_spawns = g_spawn_t1_count + g_spawn_t2_count;
		tlog("[TSM] Pruned %d map spawn(s) from the custom set. Run amx_tsm_spawn_save to keep it that way.",
			dropped);
	}
	return dropped;
}

public cmd_spawn_add(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	if (!is_user_connected(id))
	{
		console_print(id, "[TSM] Run this in-game -- it records where you are standing.");
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);
	if (team < 1 || team > 2)
	{
		console_print(id, "[TSM] usage: amx_tsm_spawn_add <1|2>");
		return PLUGIN_HANDLED;
	}

	new Float:org[3], Float:ang[3];
	pev(id, pev_origin, org);
	pev(id, pev_v_angle, ang);

	/*
	 * Refused on the map's own spawn points.
	 *
	 * Standing on an info_player_start and adding it records the map's position as a
	 * deliberate choice, and doing it for both sides puts both teams on one point. The
	 * custom set exists to replace the map's spawns, so this is always a mistake --
	 * and catching it here is better than pruning it later, because the admin finds
	 * out while they are still standing there.
	 */
	if (is_map_spawn(org))
	{
		console_print(id, "[TSM] Refused: you are standing on one of the map's own spawn points.");
		console_print(id, "[TSM] Move away and try again. tsm_spawn_prune 0 overrides this.");
		return PLUGIN_HANDLED;
	}

	new tier = 0;
	if (read_argc() > 2)
	{
		new ta[8];
		read_argv(2, ta, charsmax(ta));
		tier = str_to_num(ta);
	}
	if (tier < 0 || tier > TSM_OBJ_MAX)
	{
		console_print(id, "[TSM] A tier is 0 (the defaults) to %d.", TSM_OBJ_MAX);
		return PLUGIN_HANDLED;
	}

	if (!add_cfg_spawn(team, org, ang, tier))
	{
		console_print(id, "[TSM] Team %d spawn list is full.", team);
		return PLUGIN_HANDLED;
	}

	new n = g_spawn_t2_count;
	if (team == 1)
	{
		n = g_spawn_t1_count;
	}
	console_print(id, "[TSM] Team %d spawn #%d added at %.0f %.0f %.0f. Run amx_tsm_spawn_save to keep it.",
		team, n, org[0], org[1], org[2]);
	return PLUGIN_HANDLED;
}

/*
 * Removes ONE spawn point, so a bad entry can be dropped without clearing the set.
 *
 * The common mistake is adding a spawn while standing on the map's own
 * info_player_start -- it then sits in the custom list looking like a deliberate
 * choice, and both teams end up sharing it.
 */
public cmd_spawn_del(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);
	read_argv(2, a, charsmax(a));
	new n = str_to_num(a);

	new count = (team == 1) ? g_spawn_t1_count : g_spawn_t2_count;
	if (team < 1 || team > 2 || n < 1 || n > count)
	{
		console_print(id, "[TSM] usage: amx_tsm_spawn_del <1|2> <1..%d>", count);
		return PLUGIN_HANDLED;
	}

	// Shuffle the rest down over the hole.
	for (new i = n - 1; i < count - 1; i++)
	{
		if (team == 1)
		{
			copy_vec(g_spawn_t1[i], g_spawn_t1[i + 1]);
			copy_vec(g_ang_t1[i], g_ang_t1[i + 1]);
			g_spawn_t1_tier[i] = g_spawn_t1_tier[i + 1];
		}
		else
		{
			copy_vec(g_spawn_t2[i], g_spawn_t2[i + 1]);
			copy_vec(g_ang_t2[i], g_ang_t2[i + 1]);
			g_spawn_t2_tier[i] = g_spawn_t2_tier[i + 1];
		}
	}

	if (team == 1)
	{
		g_spawn_t1_count--;
	}
	else
	{
		g_spawn_t2_count--;
	}
	g_cfg_spawns = g_spawn_t1_count + g_spawn_t2_count;

	console_print(id, "[TSM] Removed team %d spawn #%d. team1=%d team2=%d. Run amx_tsm_spawn_save to keep it.",
		team, n, g_spawn_t1_count, g_spawn_t2_count);
	return PLUGIN_HANDLED;
}

/// Removes one forward tier's points from a team's list, keeping the rest in order.
drop_tier(team, tier)
{
	if (team == 1)
	{
		new n = 0;
		for (new i = 0; i < g_spawn_t1_count; i++)
		{
			if (g_spawn_t1_tier[i] == tier)
			{
				continue;
			}
			copy_vec(g_spawn_t1[n], g_spawn_t1[i]);
			copy_vec(g_ang_t1[n], g_ang_t1[i]);
			g_spawn_t1_tier[n] = g_spawn_t1_tier[i];
			n++;
		}
		g_spawn_t1_count = n;
	}
	else
	{
		new n = 0;
		for (new i = 0; i < g_spawn_t2_count; i++)
		{
			if (g_spawn_t2_tier[i] == tier)
			{
				continue;
			}
			copy_vec(g_spawn_t2[n], g_spawn_t2[i]);
			copy_vec(g_ang_t2[n], g_ang_t2[i]);
			g_spawn_t2_tier[n] = g_spawn_t2_tier[i];
			n++;
		}
		g_spawn_t2_count = n;
	}
	g_cfg_spawns = g_spawn_t1_count + g_spawn_t2_count;
}
public cmd_spawn_clear(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);

	new tierarg[8], drop = -1;
	if (read_argc() > 2)
	{
		read_argv(2, tierarg, charsmax(tierarg));
		drop = str_to_num(tierarg);
	}

	if (drop >= 0)
	{
		if (team != 2)
		{
			drop_tier(1, drop);
		}
		if (team != 1)
		{
			drop_tier(2, drop);
		}
	}
	else
	{
		if (team != 2)
		{
			g_spawn_t1_count = 0;
		}
		if (team != 1)
		{
			g_spawn_t2_count = 0;
		}
	}

	g_cfg_spawns = g_spawn_t1_count + g_spawn_t2_count;
	console_print(id, "[TSM] Cleared. team1=%d team2=%d. Run amx_tsm_spawn_save to persist.",
		g_spawn_t1_count, g_spawn_t2_count);
	return PLUGIN_HANDLED;
}

public cmd_spawn_list(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new angnote[8] = "no";
	if (g_spawns_have_angles)
	{
		copy(angnote, charsmax(angnote), "yes");
	}

	console_print(id, "[TSM] Map %s -- %d configured spawn(s), facing stored: %s",
		g_mapname, g_cfg_spawns, angnote);

	for (new i = 0; i < g_spawn_t1_count; i++)
	{
		console_print(id, "  T1 #%d  %.0f %.0f %.0f  yaw %.0f  tier %d",
			i + 1, g_spawn_t1[i][0], g_spawn_t1[i][1], g_spawn_t1[i][2], g_ang_t1[i][1], g_spawn_t1_tier[i]);
	}
	for (new i = 0; i < g_spawn_t2_count; i++)
	{
		console_print(id, "  T2 #%d  %.0f %.0f %.0f  yaw %.0f  tier %d",
			i + 1, g_spawn_t2[i][0], g_spawn_t2[i][1], g_spawn_t2[i][2], g_ang_t2[i][1], g_spawn_t2_tier[i]);
	}
	return PLUGIN_HANDLED;
}

public cmd_spawn_save(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new path[160];
	spawn_cfg_path(path, charsmax(path));

	if (file_exists(path))
	{
		delete_file(path);
	}

	new line[160];
	formatex(line, charsmax(line), "// ts_matchmode spawn points for %s -- written by amx_tsm_spawn_save", g_mapname);
	write_file(path, line);
	write_file(path, "// tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>");

	/*
	 * The map's own spawn points are NOT written out.
	 *
	 * On a map with no custom set, partition_spawns() fills both team lists from the
	 * map's info_player_start / info_player_deathmatch entities so that teams at least
	 * start apart. Those are a runtime fallback, not a choice anybody made -- and
	 * saving afterwards wrote the whole list, so every map spawn ended up in the cfg
	 * alongside the handful that were actually placed by hand.
	 *
	 * Skipping them here means amx_tsm_spawn_save writes exactly what was added with
	 * amx_tsm_spawn_add, which is what the file is for.
	 */
	new written = 0, skipped = 0;

	for (new i = 0; i < g_spawn_t1_count; i++)
	{
		if (is_map_spawn(g_spawn_t1[i]))
		{
			skipped++;
			continue;
		}
		formatex(line, charsmax(line), "tsm_spawn 1 %.2f %.2f %.2f %.2f %.2f %d",
			g_spawn_t1[i][0], g_spawn_t1[i][1], g_spawn_t1[i][2], g_ang_t1[i][0], g_ang_t1[i][1], g_spawn_t1_tier[i]);
		write_file(path, line);
		written++;
	}
	for (new i = 0; i < g_spawn_t2_count; i++)
	{
		if (is_map_spawn(g_spawn_t2[i]))
		{
			skipped++;
			continue;
		}
		formatex(line, charsmax(line), "tsm_spawn 2 %.2f %.2f %.2f %.2f %.2f %d",
			g_spawn_t2[i][0], g_spawn_t2[i][1], g_spawn_t2[i][2], g_ang_t2[i][0], g_ang_t2[i][1], g_spawn_t2_tier[i]);
		write_file(path, line);
		written++;
	}

	console_print(id, "[TSM] Saved %d spawn(s) to %s", written, path);
	if (skipped)
	{
		console_print(id, "[TSM] Left out %d of the map's own spawn points -- those are a fallback, not yours.",
			skipped);
	}
	if (!written)
	{
		console_print(id, "[TSM] NOTHING was saved: every position was a map spawn. Add some with amx_tsm_spawn_add first.");
	}

	tlog("[TSM] Spawn cfg written: %s (%d saved, %d map spawns skipped)", path, written, skipped);
	return PLUGIN_HANDLED;
}

public cmd_spawn_tp(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	if (!is_user_alive(id))
	{
		console_print(id, "[TSM] You need to be alive to teleport.");
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);
	read_argv(2, a, charsmax(a));
	new n = str_to_num(a);

	new count = g_spawn_t2_count;
	if (team == 1)
	{
		count = g_spawn_t1_count;
	}

	if (team < 1 || team > 2 || n < 1 || n > count)
	{
		console_print(id, "[TSM] usage: amx_tsm_spawn_tp <1|2> <1..%d>", count);
		return PLUGIN_HANDLED;
	}

	new Float:org[3];
	if (team == 1)
	{
		copy_vec(org, g_spawn_t1[n - 1]);
	}
	else
	{
		copy_vec(org, g_spawn_t2[n - 1]);
	}

	engfunc(EngFunc_SetOrigin, id, org);
	console_print(id, "[TSM] Teleported to team %d spawn #%d.", team, n);
	return PLUGIN_HANDLED;
}

/* ---- solo testing ------------------------------------------------------- */

/*
 * Everything that can stop a player moving, in one place.
 *
 * Written because "still frozen" has now had three different causes -- a time-scale
 * native that did not reverse, a corpse that was never alive, and the hold flag --
 * and guessing between them from a description costs a server restart each time.
 */
dump_player_state(viewer, target, const when[])
{
	if (!is_user_connected(target))
	{
		return;
	}

	new Float:vel[3], Float:org[3];
	pev(target, pev_velocity, vel);
	pev(target, pev_origin, org);

	new flags = pev(target, pev_flags);
	new line1[192], line2[192];

	// The name is fetched rather than formatted with %N: that specifier is not
	// supported here, and it printed a literal "N" while consuming no argument, which
	// shifted every field after it by one and made the first dump read as the exact
	// opposite of the truth.
	new who[32];
	get_user_name(target, who, charsmax(who));

	formatex(line1, charsmax(line1),
		"[%s] %s: frozen=%d elim=%d placed=%d alive=%d team=%d",
		when, who, g_frozen[target] ? 1 : 0, g_elim[target] ? 1 : 0,
		g_placed[target] ? 1 : 0, is_user_alive(target) ? 1 : 0, g_match_team[target]);

	formatex(line2, charsmax(line2),
		"[%s] %s: FL_FROZEN=%d movetype=%d solid=%d maxspeed=%.0f vel=%.0f org=%.0f %.0f %.0f effects=%d",
		when, who,
		(flags & TSM_FL_FROZEN) ? 1 : 0,
		pev(target, pev_movetype),
		pev(target, pev_solid),
		Float:pev(target, pev_maxspeed),
		vector_length(vel),
		org[0], org[1], org[2],
		pev(target, pev_effects));

	new line3[192], wl[32], wn;
	get_user_weapons(target, wl, wn);
	formatex(line3, charsmax(line3),
		"[%s] %s: deadflag=%d iuser1=%d weapons=%d lives=%d pending=%d refused=%d",
		when, who, pev(target, pev_deadflag), pev(target, pev_iuser1), wn,
		g_lives_left[target], g_revive_pending[target] ? 1 : 0, g_revive_refused[target]);

	dbg("%s", line1);
	dbg("%s", line2);
	dbg("%s", line3);

	if (viewer)
	{
		console_print(viewer, "[TSM] %s", line1);
		console_print(viewer, "[TSM] %s", line2);
		console_print(viewer, "[TSM] %s", line3);
	}
}

public cmd_whystuck(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new target = id;
	if (read_argc() > 1)
	{
		new a[32];
		read_argv(1, a, charsmax(a));
		target = cmd_target(id, a, CMDTARGET_ALLOW_SELF);
		if (!target)
		{
			return PLUGIN_HANDLED;
		}
	}

	console_print(id, "[TSM] state=%d round=%d freeze_method=%d force_maxspeed=%d sv_maxspeed=%.0f",
		g_state, g_round, get_pcvar_num(g_cv_freezemethod),
		get_pcvar_num(g_cv_forcespeed), get_cvar_float("sv_maxspeed"));
	console_print(id, "[TSM] maxspeed restored: %d from post-PreThink, %d from post-PostThink (0 and 0 means TS never zeroed it).",
		g_speed_fixes, g_speed_fixes_post);
	console_print(id, "[TSM] class scale enforced: %d by preThink, %d by postThink (0 and 0 means TS never touches it).",
		g_prethink_scale_hits, g_postthink_scale_hits);
	dump_player_state(id, target, "whystuck");
	console_print(id, "[TSM] A live player should read movetype=3 and solid=3.");
	return PLUGIN_HANDLED;
}

/*
 * Last resort. Clears our holds, restores normal movement, and lifts the player
 * clear of the floor in case they were made solid again inside world geometry --
 * which looks identical to being frozen and is a real risk on a map whose only
 * spawn point both teams share.
 */
public cmd_unstick(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}

	new target = id;
	if (read_argc() > 1)
	{
		new a[32];
		read_argv(1, a, charsmax(a));
		target = cmd_target(id, a, CMDTARGET_ALLOW_SELF);
		if (!target)
		{
			return PLUGIN_HANDLED;
		}
	}

	dump_player_state(id, target, "before unstick");

	g_frozen[target] = false;
	g_elim[target] = false;
	release_player(target);
	set_pev(target, pev_movetype, TSM_MOVETYPE_WALK);
	set_pev(target, pev_solid, TSM_SOLID_SLIDEBOX);
	set_user_maxspeed(target, 320.0);

	new Float:org[3];
	pev(target, pev_origin, org);
	org[2] = org[2] + 24.0;
	engfunc(EngFunc_SetOrigin, target, org);

	dump_player_state(id, target, "after unstick");
	console_print(id, "[TSM] Unstuck %N.", target);
	return PLUGIN_HANDLED;
}

/// Dumps everyone shortly after go-live, so a stuck round explains itself.
public task_live_audit()
{
	if (g_state != ST_LIVE)
	{
		return;
	}

	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		dump_player_state(0, players[i], "1s after live");
	}
}

/*
 * Refuses a purchase. These are the client commands TS's client-side buy menu sends;
 * there is no server-side "buy" command to block, so this is the only layer that can
 * stop it. Allowed during warmup so people can still look at the menu.
 */
/*
 * Refuses a powerup activation while tsm_no_powerups is on.
 *
 * This is also the command TS sends when E is pressed, which is the same key the
 * perks use -- so a medic pressing E to heal was being told powerups were off
 * instead. The perk runs from here as well as from the IN_USE button, because
 * whichever of the two TS actually delivers, the perk has to work.
 */
/*
 * tsm_model -- what the gamemode has this player wearing, right now.
 *
 * It reports the DECISION and the RESULT separately, because the interesting failure is
 * when those disagree: the class table picks a name, the name turns out not to resolve
 * to a file, and the player quietly keeps whatever TS gave them. Printing only the final
 * model would show the fallback and hide the cause.
 *
 * It also prints the pick as "n of m", which is what tells you whether the list is being
 * read whole. A list that always reports the same small m is a list being truncated
 * somewhere before it gets here.
 */
/*
 * The stimpack: 50 health to yourself, once a round.
 *
 * The same three things the medic's heal does -- raise health, glow, make a noise --
 * pointed at the user instead of at whoever they are aiming at. It deliberately shares
 * glow_player and perk_sound rather than repeating them, so the three heals on this
 * server look and sound like one another.
 *
 * WHITE, where the medic is red and the engineer yellow, so what happened is readable
 * from across a room without anybody saying anything.
 */
/*
 * .forfeit -- a side concedes, but only when ALL of its people agree.
 *
 * Shaped like ready-up on purpose: one person saying it is an opinion, everybody saying
 * it is a decision. Each vote is announced with who is still holding out, so the side
 * knows it is being asked rather than wondering why nothing happened.
 *
 * BOTS DO NOT COUNT, for the same reason they do not count when someone leaves: a side
 * of one human and five bots could otherwise never concede, because five of its six
 * members can never type anything.
 */
cmd_forfeit(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return PLUGIN_HANDLED;
	}
	if (g_state != ST_LIVE && g_state != ST_FREEZE && g_state != ST_ROUNDEND)
	{
		client_print(id, print_chat, "[MATCH] There is no match running to forfeit.");
		return PLUGIN_HANDLED;
	}

	new team = g_match_team[id];
	if (team != 1 && team != 2)
	{
		client_print(id, print_chat, "[MATCH] You are not on a side.");
		return PLUGIN_HANDLED;
	}
	if (g_forfeit[id])
	{
		client_print(id, print_chat, "[MATCH] You have already voted to forfeit.");
		return PLUGIN_HANDLED;
	}
	g_forfeit[id] = true;

	new name[32], tname[48];
	get_user_name(id, name, charsmax(name));
	team_display(team, tname, charsmax(tname));

	new players[32], pnum, want = 0, got = 0, holding[160];
	holding[0] = 0;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		new pl = players[i];
		if (is_user_bot(pl) || tsm_live_team_of(pl) != team)
		{
			continue;
		}
		want++;
		if (g_forfeit[pl])
		{
			got++;
		}
		else
		{
			new n2[32];
			get_user_name(pl, n2, charsmax(n2));
			if (holding[0]) { add(holding, charsmax(holding), ", "); }
			add(holding, charsmax(holding), n2);
		}
	}

	if (got < want)
	{
		all_print("[MATCH] %s votes to forfeit for %s (%d of %d). Waiting on: %s",
			name, tname, got, want, holding);
		return PLUGIN_HANDLED;
	}

	// Everyone on that side agreed. The other takes it, by the same path an emptied
	// side is taken on: score, announce, end, back to warmup.
	new w = (team == 1) ? 2 : 1;
	new wname[48];
	team_display(w, wname, charsmax(wname));

	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);
	g_freeze_left = 0;
	g_round_left = 0;
	g_end_pending_at = 0.0;
	g_end_pending_winner = 0;

	g_score[w]++;
	all_print("[MATCH] MATCH OVER -- %s forfeits. %s wins, %d -- %d.",
		tname, wname, g_score[1], g_score[2]);
	tlog("[TSM] Match forfeited by team %d: all %d human player(s) agreed.", team, want);

	g_state = ST_MATCHEND;
	restore_all();
	set_task(5.0, "task_to_warmup");
	return PLUGIN_HANDLED;
}

cmd_stim(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_stim))
	{
		return PLUGIN_HANDLED;
	}
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] You have to be alive to use a stimpack.");
		return PLUGIN_HANDLED;
	}

	if (g_stim_used[id])
	{
		client_print(id, print_chat, "[TSM] You have no more stimpacks left.");
		return PLUGIN_HANDLED;
	}

	// Mech class cannot use stimpacks
	new ci = resolved_class(id) - 1;
	if (ci >= 0 && g_class_perk[ci] == TSM_PERK_MECH)
	{
		client_print(id, print_chat, "[TSM] Mechs don't use stimpacks -- they self-repair");
		return PLUGIN_HANDLED;
	}

	/*
	 * Capped at the player's own class health, as the medic's heal is: a Heavy tops out
	 * at 200 and a Marksman at 85, and a stim must not push anyone past what their class
	 * is worth.
	 */
	new maxhp = (ci >= 0 && ci < g_class_count) ? g_class_hp[ci] : 100;
	if (maxhp < 1)
	{
		maxhp = 100;
	}

	new cur = get_user_health(id);
	if (cur >= maxhp)
	{
		// REFUSED WITHOUT SPENDING IT, exactly as the medic's heal refuses. Taking
		// someone's only stimpack for a heal that did nothing would just teach them to
		// check the number before pressing the key.
		client_print(id, print_chat, "[TSM] You are already at full health -- stimpack kept.");
		return PLUGIN_HANDLED;
	}

	/*
	 * Rolled HERE, after the full-health refusal above and not before it.
	 *
	 * A stimpack worth a known 50 is a number; one worth somewhere between 25 and 50 is
	 * a decision, because spending it early might buy very little. Rolling before the
	 * refusal would throw a roll away on a use that never happened, which costs nothing
	 * but is the kind of thing that confuses anyone reading this later.
	 *
	 * random_num is inclusive at both ends. A min above max is clamped rather than
	 * handed over backwards.
	 */
	new lo = get_pcvar_num(g_cv_stimmin);
	new hi = get_pcvar_num(g_cv_stimmax);
	if (lo < 1)  { lo = 1; }
	if (hi < lo) { hi = lo; }

	new after = cur + random_num(lo, hi);
	if (after > maxhp)
	{
		after = maxhp;
	}
	set_user_health(id, after);
	g_stim_used[id] = true;

	glow_player(id, 255.0, 255.0, 255.0,
		get_pcvar_float(g_cv_stimglow), get_pcvar_num(g_cv_stimshell));

	// The medic's own healing sound, from the user's body so the people around them hear
	// it too -- a stim nobody else notices is worth less than one they do.
	perk_sound(id, g_cv_medsound);

	client_print(id, print_chat, "[TSM] You used your only stimpack. (+%d health)", after - cur);
	dbgv("stim: %d %d -> %d (cap %d)", id, cur, after, maxhp);
	return PLUGIN_HANDLED;
}

/// `stim` in the console, so it can be bound to a key. Bots never see this.
public cmd_stim_console(id)
{
	return cmd_stim(id);
}

/*
 * The mech sound bench: everything the mech kit owns, played ONCE from the caller's
 * own client, with the detection facts printed in front of it.
 *
 * Built for the hour nobody could hear a mech sound at all. The first three lines
 * answer "is the detection contract even matched" -- the model string the server
 * sees for your body, what the class resolve says, and whether wears_mech() takes
 * that body. Then the three sounds go: mechwalk (a step), mechloop (the idle hum)
 * and one of the clang pool.
 */
public cmd_mechtest(id)
{
	if (!is_user_connected(id))
	{
		return PLUGIN_HANDLED;
	}

	new mdl[64];
	pev(id, pev_model, mdl, charsmax(mdl));

	new ci = resolved_class(id) - 1;
	new cname[32];
	if (ci >= 0 && ci < g_class_count)
	{
		copy(cname, charsmax(cname), g_class_name[ci]);
	}
	else
	{
		copy(cname, charsmax(cname), "(none)");
	}

	console_print(id, "[TSM] ---- mech sound self-test ----");
	console_print(id, "[TSM] alive: %d   wears_mech: %d   enabled cvar: %d",
		is_user_alive(id), wears_mech(id), get_pcvar_num(g_cv_enabled));
	console_print(id, "[TSM] model path: %s", mdl[0] ? mdl : "(empty)");
	console_print(id, "[TSM] class resolved as: %s", cname);

	// The sounds, straight to this client -- one of each so all three packs can
	// be ruled in or out by ear in a single pass.
	console_print(id, "[TSM] playing on YOUR client: mechwalk, mechloop, one clang");
	// Task id packs the player and the sound slot: N*10 + 1..3.
	set_task(0.6, "task_mechtest_snd", id * 10 + 1);
	set_task(3.0, "task_mechtest_snd", id * 10 + 2);
	set_task(4.5, "task_mechtest_snd", id * 10 + 3);
	return PLUGIN_HANDLED;
}

public task_mechtest_snd(taskid)
{
	// Dispatch: tens are the player, the last digit is which sound comes next.
	new id = taskid / 10;
	new step = taskid % 10;
	if (!is_user_connected(id))
	{
		return;
	}
	switch (step)
	{
		case 1: client_cmd(id, "playvol %s 0.7", MECH_STEP_1);
		case 2: client_cmd(id, "playvol %s %f", MECH_LOOP, MECH_LOOP_PILOT_VOL);
		case 3:
		{
			new hitname[24];
			copy(hitname, charsmax(hitname), g_mech_hit_snd[random(sizeof g_mech_hit_snd)]);
			client_cmd(id, "playvol %s 0.9", hitname);
		}
	}
}

public cmd_model(id)
{
	if (!is_user_connected(id))
	{
		return PLUGIN_HANDLED;
	}

	new ci = resolved_class(id) - 1;
	new team = g_match_team[id];

	console_print(id, "[TSM] ---- your model ----");
	console_print(id, "[TSM] class      : %s", (ci >= 0 && ci < g_class_count) ? g_class_name[ci] : "none");
	console_print(id, "[TSM] side       : %d", team);

	if (!g_model_chosen[id][0])
	{
		console_print(id, "[TSM] chosen     : nothing yet -- the gamemode has not assigned you one this round.");
		return PLUGIN_HANDLED;
	}

	console_print(id, "[TSM] chosen     : %s", g_model_chosen[id]);
	console_print(id, "[TSM] on disk    : %s", g_model_ok[id] ? "yes" : "NO -- you are wearing TS's default instead");
	console_print(id, "[TSM] model index: %d", g_model_want_idx[id]);
	console_print(id, "[TSM] last written: %s", g_model_last[id][0] ? g_model_last[id] : "(none)");

	// The list it was drawn from, so a truncated list is visible from in game.
	if (ci >= 0 && ci < g_class_count && team >= 1 && team <= 2)
	{
		new list[TSM_MODELLIST];
		copy(list, charsmax(list), g_class_model[ci][team]);
		if (!list[0])
		{
			new fb = get_pcvar_num(g_cv_modelfallback);
			if (fb < 1 || fb > g_class_count) { fb = 1; }
			copy(list, charsmax(list), g_class_model[fb - 1][team]);
			console_print(id, "[TSM] (your class has no models of its own, so it follows %s)", g_class_name[fb - 1]);
		}
		new count = 1;
		for (new i = 0; list[i]; i++)
		{
			if (list[i] == ',') { count++; }
		}
		console_print(id, "[TSM] pick       : %d of %d", g_model_pick[id], count);
		console_print(id, "[TSM] list       : %s", list);
	}

	return PLUGIN_HANDLED;
}

public cmd_blockpowerup(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_nopowerups))
	{
		return PLUGIN_CONTINUE;
	}

	new perk = TSM_PERK_NONE;
	if (g_class_count && is_user_alive(id) && g_state == ST_LIVE)
	{
		perk = g_class_perk[resolved_class(id) - 1];
	}

	// The Officer is the one class allowed his powerup -- his kung fu IS a powerup --
	// so his activation command passes through to the mod while everyone else's stops.
	if (perk == TSM_PERK_OFFICER)
	{
		dbgv("officer %d powerup use passed through", id);
		return PLUGIN_CONTINUE;
	}

	if (perk != TSM_PERK_NONE)
	{
		// Deduped against the button path, so a key that delivers both does not run
		// the perk twice and burn the cooldown on the second one.
		if ((get_gametime() - g_perk_at[id]) > 0.2)
		{
			perk_use(id);
		}
		return PLUGIN_HANDLED;   // still no powerup, but silently
	}

	client_print(id, print_chat, "[MATCH] Powerups are off in match mode.");
	return PLUGIN_HANDLED;
}

public cmd_blockbuy(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_blockbuy))
	{
		return PLUGIN_CONTINUE;
	}
	/*
	 * Blocked in EVERY state, warmup included.
	 *
	 * Allowing purchases during warmup was the whole exploit: buy a second loadout,
	 * drop it on the floor, and collect it once the round is live. Blocking only
	 * during the match closed the door after the guns were already outside.
	 *
	 * This blocks the menu writing a loadout. It does NOT stop a loadout already saved
	 * in the player's config from being re-applied at spawn -- that is what hold_cash()
	 * is for. The two together are what closes the exploit; neither does it alone.
	 */
	if (g_issuing[id])
	{
		// Our own loadout write coming back from the client. Logged so a partial
		// loadout can be told apart from a loadout that never finished arriving.
		new cmd[32], arg[32];
		read_argv(0, cmd, charsmax(cmd));
		read_argv(1, arg, charsmax(arg));
		dbgv("armament echo from %d: %s %s", id, cmd, arg);

		// Only tkw is counted. The ammo commands are fire-and-forget: a missing
		// magazine is cosmetic, a missing weapon is not, so the respawn waits only on
		// the weapons.
		if (equali(cmd, "tkw") && g_arm_pending[id] > 0)
		{
			g_arm_pending[id]--;
		}
		return PLUGIN_CONTINUE;
	}

	// Silent. This fires once per item the menu touches, so a message here is spam.
	return PLUGIN_HANDLED;
}

/*
 * The buy menu also submits a combined numeric form, "13_3", which cannot be
 * registered as a fixed command name -- so it is caught here instead.
 */
public client_command(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_blockbuy))
	{
		return PLUGIN_CONTINUE;
	}
	/*
	 * Blocked in EVERY state, warmup included.
	 *
	 * Allowing purchases during warmup was the whole exploit: buy a second loadout,
	 * drop it on the floor, and collect it once the round is live. Blocking only
	 * during the match closed the door after the guns were already outside.
	 *
	 * This blocks the menu writing a loadout. It does NOT stop a loadout already saved
	 * in the player's config from being re-applied at spawn -- that is what hold_cash()
	 * is for. The two together are what closes the exploit; neither does it alone.
	 */

	new cmd[32];
	read_argv(0, cmd, charsmax(cmd));

	// digits, one underscore, digits -- and nothing else.
	new seen_sep = 0, digits = 0;
	for (new i = 0; cmd[i]; i++)
	{
		if (cmd[i] == '_')
		{
			seen_sep++;
		}
		else if (cmd[i] >= '0' && cmd[i] <= '9')
		{
			digits++;
		}
		else
		{
			return PLUGIN_CONTINUE;
		}
	}

	if (seen_sep == 1 && digits >= 2)
	{
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

/*
 * Logs a team-join attempt without interfering with it.
 *
 * Whether this fires is the question that matters: if it does, the command reaches
 * the server and TS is declining the join, which points at the mod's team table. If
 * it does not, the command never leaves the client.
 */
/*
 * Refuses "changeteam", which is the ONLY thing that opens TS's team panel.
 *
 * That panel is modal and it eats input. TeamFortressViewport::KeyInput returns 0 for
 * every digit while a team or class panel is open, so the client never runs slot1..9
 * and never sends "menuselect N" -- which is precisely why an AMXX menu renders but
 * ignores every keypress. Worse, ESC only closes it once the client-side g_iTeamNumber
 * is non-zero, so a player whose join did not register can be trapped in it.
 *
 * The plugin's own side menu replaces it entirely.
 */
public cmd_block_changeteam(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_blockvgui))
	{
		return PLUGIN_CONTINUE;
	}

	client_print(id, print_chat, "[MATCH] Use .team to pick a side.");
	show_team_menu(id);
	return PLUGIN_HANDLED;
}

public cmd_watch_join(id)
{
	new cmd[32], arg[32];
	read_argv(0, cmd, charsmax(cmd));
	read_argv(1, arg, charsmax(arg));

	// Joining a side is only allowed before the match goes live. Once a round is
	// under way, spectators stay spectators -- the .team menu already refuses, so
	// the raw jointeam console command must too.
	if (g_state != ST_WARMUP && g_state != ST_READYUP)
	{
		client_print(id, print_chat, "[MATCH] A match is already in progress -- join when it finishes.");
		return PLUGIN_HANDLED;
	}

	// The raw console route onto side 2, where a mode made it bots only: refused the same
	// way the side menu refuses it. jointeam takes the mp_teamlist index, 2 for side 2.
	if (mode_flag(TSM_MODE_SIDE2_BOTS) && !bot_player(id) && str_to_num(arg) == 2)
	{
		force_spectator(id);
		client_print(id, print_chat, "[MATCH] That side is the enemy wave in this mode -- you are spectating. Type .team to join the other side.");
		return PLUGIN_HANDLED;
	}

	new before[32];
	before[0] = 0;
	new bnum = get_user_team(id, before, charsmax(before));

	new list[64];
	get_cvar_string("mp_teamlist", list, charsmax(list));

	dbg("JOIN WATCH: %d sent '%s %s' -- team was #%d '%s', mp_teamlist='%s'",
		id, cmd, arg, bnum, before, list);
	tlog("[TSM] JOIN WATCH: player %d sent '%s %s' (team was #%d '%s')",
		id, cmd, arg, bnum, before);

	set_task(0.5, "task_join_result", id);
	return PLUGIN_CONTINUE;
}

public task_join_result(id)
{
	if (!is_user_connected(id))
	{
		return;
	}
	new after[32];
	after[0] = 0;
	new anum = get_user_team(id, after, charsmax(after));
	dbg("JOIN WATCH: %d is now team #%d '%s' (resolved=%d)",
		id, anum, after, tsm_live_team_of(id));
	tlog("[TSM] JOIN WATCH: player %d is now team #%d '%s'", id, anum, after);
}

/*
 * Forces a menu up on demand, so "the menu did not appear" can be told apart from
 * "the menu appeared and ate my keys" without waiting on warmup state.
 */
public cmd_menu(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new which[16];
	read_argv(1, which, charsmax(which));

	if (equali(which, "class"))
	{
		console_print(id, "[TSM] class menu: built=%d classes=%d yours=%d state=%d may_pick=%d",
			g_class_menu ? 1 : 0, g_class_count, g_player_class[id],
			g_state, may_pick_class(id) ? 1 : 0);

		// This clears the admin's own locked class so the menu will open. That is a
		// debugging tool, so it stays -- but only where a pick can take effect, or it
		// drops the class and then shows nothing, which reads as the command failing.
		if (!may_pick_class(id))
		{
			console_print(id, "[TSM] not during state %d -- classes are picked in the freeze (state %d).",
				g_state, ST_FREEZE);
			return PLUGIN_HANDLED;
		}

		g_player_class[id] = 0;
		show_class_menu(id);
		return PLUGIN_HANDLED;
	}

	console_print(id, "[TSM] side menu: built=%d your team=%d spectator=%d",
		g_team_menu ? 1 : 0, g_match_team[id], g_spectator[id] ? 1 : 0);
	g_spectator[id] = false;
	g_team_menu_at[id] = 0.0;
	show_team_menu(id);
	return PLUGIN_HANDLED;
}

public legend_menu_handler(id, menu, item)
{
	if (item == MENU_EXIT || item < 0)
	{
		close_menu(id);
		return PLUGIN_HANDLED;
	}

	close_menu(id);

	switch (item)
	{
		case 0:
		{
			g_spectator[id] = false;
			g_team_menu_at[id] = 0.0;

			// Released first, so the balance check does not count them on the side they
			// are trying to leave.
			if (g_state == ST_WARMUP || g_state == ST_READYUP)
			{
				g_match_team[id] = 0;
				g_player_class[id] = 0;
			}

			show_team_menu(id);
		}
		case 1:
		{
			if (!tsm_live_team_of(id))
			{
				client_print(id, print_chat, "[MATCH] Pick a side first.");
				g_team_menu_at[id] = 0.0;
				show_team_menu(id);
			}
			else if (!may_pick_class(id))
			{
				client_print(id, print_chat, "[MATCH] Classes are picked during the countdown before a round, not now.");
			}
			else
			{
				g_class_menu_at[id] = 0.0;
				show_class_menu(id);
			}
		}
		default:
		{
			// Match status. The spectate option was removed deliberately: dropping out
			// of a match mid-way is not something a player should do to their team.
			print_status(id);
		}
	}

	return PLUGIN_HANDLED;
}

/*
 * The one menu that leads to all the others, so a player who dismissed something has a
 * way back to it without needing to know a command for each.
 *
 * Built on first use rather than at startup: it calls print_status(), which is defined
 * further down the file, and this compiler rejects forward references.
 */
public cmd_legend(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return PLUGIN_CONTINUE;
	}
	if (!g_legend_menu)
	{
		g_legend_menu = menu_create("\yTS Match \d-- \ymenus", "legend_menu_handler");
		menu_additem(g_legend_menu, "\yPick a side",        "0", 0);
		menu_additem(g_legend_menu, "\yPick a class",       "1", 0);
		menu_additem(g_legend_menu, "\yMatch status",       "3", 0);
	}

	menu_display(id, g_legend_menu, 0);
	return PLUGIN_HANDLED;
}

public cmd_teaminfo(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new list[64], models[96];
	get_cvar_string("mp_teamlist", list, charsmax(list));
	get_cvar_string("mp_teammodels", models, charsmax(models));

	console_print(id, "[TSM] mp_teamlist     = '%s'", list);
	console_print(id, "[TSM] mp_teammodels   = '%s'", models);
	console_print(id, "[TSM] mp_teamplay     = %d   teamplay = %d",
		get_cvar_num("mp_teamplay"), get_cvar_num("teamplay"));
	console_print(id, "[TSM] TeamInfo msgs   = %d %s",
		g_teaminfo_seen,
		g_teaminfo_seen > 0
			? "(teamplay gamerules ACTIVE)"
			: "(ZERO -- gamerules are NOT teamplay, jointeam cannot work)");

	new spname[32];
	get_pcvar_string(g_cv_specteam, spname, charsmax(spname));
	new spidx = live_spectator_index();
	console_print(id, "[TSM] spectator team  = '%s' -> slot %d %s",
		spname, spidx,
		spidx > 0 ? "(ok)" : "(NOT IN mp_teamlist -- add it and change map)");
	console_print(id, "[TSM] mp_teamoverride = %d", get_cvar_num("mp_teamoverride"));
	console_print(id, "[TSM] tsm_force_teamlist = %d (set 0 to stop the plugin touching it)",
		get_pcvar_num(g_cv_forceteams));

	new players[32], pnum, nm[32], tn[32];
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		get_user_name(players[i], nm, charsmax(nm));
		tn[0] = 0;
		new num = get_user_team(players[i], tn, charsmax(tn));
		console_print(id, "[TSM]   %-20s team#=%d name='%s' resolved=%d alive=%d",
			nm, num, tn, tsm_live_team_of(players[i]), is_user_alive(players[i]) ? 1 : 0);
	}

	console_print(id, "[TSM] Try: jointeam 1   then run this again. Watch logs/tsm_debug.log for JOIN WATCH lines.");
	return PLUGIN_HANDLED;
}

public cmd_team(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return PLUGIN_CONTINUE;
	}
	// Clear the current side first so the balance check sees the player as unassigned
	// -- otherwise they are counted on the team they are trying to leave.
	if (g_state == ST_WARMUP || g_state == ST_READYUP)
	{
		g_match_team[id] = 0;
		g_player_class[id] = 0;
	}

	if (g_state != ST_WARMUP && g_state != ST_READYUP)
	{
		client_print(id, print_chat, "[MATCH] A match is already in progress -- join when it finishes.");
		return PLUGIN_HANDLED;
	}
	if (!g_team_menu)
	{
		client_print(id, print_chat, "[MATCH] Team names are not configured yet.");
		return PLUGIN_HANDLED;
	}
	g_spectator[id] = false;
	remove_task(id + 1000);   // cancel any pending spectator parking
	show_team_menu(id);
	return PLUGIN_HANDLED;
}

public cmd_class(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return PLUGIN_CONTINUE;
	}
	if (!g_class_count)
	{
		client_print(id, print_chat, "[MATCH] No classes are configured on this server.");
		return PLUGIN_HANDLED;
	}
	if (g_player_class[id])
	{
		client_print(id, print_chat, "[MATCH] You are %s for this match. Classes are locked once picked.",
			g_class_name[g_player_class[id] - 1]);
		return PLUGIN_HANDLED;
	}

	// Say why, rather than opening a menu whose answer would be thrown away. A class
	// picked outside the freeze never reached the loadout and begin_match() cleared it.
	if (!may_pick_class(id))
	{
		if (!get_pcvar_num(g_cv_classes))
		{
			client_print(id, print_chat, "[MATCH] Classes are switched off on this server.");
		}
		else if (!tsm_live_team_of(id))
		{
			client_print(id, print_chat, "[MATCH] Pick a side first -- type .team.");
		}
		else if (g_locked_out[id])
		{
			client_print(id, print_chat, "[MATCH] You joined mid-match -- you are in at the next one.");
		}
		else
		{
			client_print(id, print_chat, "[MATCH] Classes are picked during the countdown before a round, not now.");
		}
		return PLUGIN_HANDLED;
	}

	show_class_menu(id);
	return PLUGIN_HANDLED;
}

public cmd_simwin(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}
	if (g_state != ST_LIVE)
	{
		console_print(id, "[TSM] Not in a live round (state %d).", g_state);
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);
	if (team < 1 || team > 2)
	{
		console_print(id, "[TSM] usage: amx_tsm_simwin <1|2>");
		return PLUGIN_HANDLED;
	}

	dbg("simwin: round %d awarded to team %d by admin", g_round, team);
	end_round(team);
	return PLUGIN_HANDLED;
}

public cmd_simelim(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
	{
		return PLUGIN_HANDLED;
	}

	new target = id;
	if (read_argc() > 1)
	{
		new a[32];
		read_argv(1, a, charsmax(a));
		target = cmd_target(id, a, CMDTARGET_ALLOW_SELF);
		if (!target)
		{
			return PLUGIN_HANDLED;
		}
	}

	if (g_elim[target])
	{
		console_print(id, "[TSM] %N is already eliminated.", target);
		return PLUGIN_HANDLED;
	}

	dbg("simelim: %N eliminated by admin", target);
	g_elim[target] = true;
	// The admin test gets the voice too -- it is also the easiest way in game
	// to hear what the model-name rules picked.
	death_voice(target);
	remove_from_play(target);
	lives_on_death(target);
	check_round_end();
	console_print(id, "[TSM] Eliminated %N.", target);
	return PLUGIN_HANDLED;
}

/* ---- classes: arming, models and perks ----------------------------------- */

/// One DispatchKeyValue, through fakemeta so no engine module is required.
kv_set(ent, const classname[], const key[], const value[])
{
	set_kvd(0, KV_ClassName, classname);
	set_kvd(0, KV_KeyName,   key);
	set_kvd(0, KV_Value,     value);
	set_kvd(0, KV_fHandled,  0);
	dllfunc(DLLFunc_KeyValue, ent, 0);
}

/*
 * Per-class models.
 *
 * TS does use the standard "model" userinfo key, but it is server-authoritative:
 * CTSGameRules::GetPlayerModel() re-applies the team model on ClientUserInfoChanged
 * and on spawn, so a plain SetClientKeyValue is reverted within about 30 frames.
 * "force" therefore re-asserts from fw_userinfo as well; "teamonly" leaves TS's own
 * mp_teammodels alone and classes simply do not change how you look.
 */
set_class_model(id, ci)
{
	new mode[16];
	get_pcvar_string(g_cv_modelmode, mode, charsmax(mode));
	if (!equali(mode, "force"))
	{
		return;
	}

	new team = g_match_team[id];
	if (team != 1 && team != 2)
	{
		return;
	}

	// A class with no model of its own wears what Assault wears on that side.
	/*
	 * A class with no model of its own borrows another class's, per side.
	 *
	 * Which class that is comes from tsm_model_fallback_class rather than being fixed
	 * at Assault, so a blank model field is a deliberate "same as <that class>" rather
	 * than a hole. Leave a class blank and it follows whatever the fallback wears,
	 * including that class's random picks.
	 */
	new list[TSM_MODELLIST];
	copy(list, charsmax(list), g_class_model[ci][team]);

	if (!list[0] && g_class_count > 0)
	{
		new fb = get_pcvar_num(g_cv_modelfallback);
		if (fb < 1 || fb > g_class_count)
		{
			fb = 1;
		}
		copy(list, charsmax(list), g_class_model[fb - 1][team]);
	}
	if (!list[0])
	{
		return;
	}

	/*
	 * Pick one, and keep it -- per class and side, so it is re-rolled when either
	 * changes.
	 *
	 * Rolling per spawn would change a player's appearance every round, which makes
	 * people unrecognisable mid-match; g_model_pick is cleared with the rest of the
	 * per-MATCH state, not per round. But a pick carried ACROSS classes is a pick
	 * drawn from another list: everyone is modelled as the default class on the way
	 * in, that list is two names, and the Heavy then reused entry 1 or 2 of his
	 * eight -- which is why he always came out as the first variant.
	 */
	/*
	 * carry and rest HOLD THE WHOLE LIST and must be sized with it.
	 *
	 * These two were left at 96 when everything else moved to TSM_MODELLIST, and they are
	 * what walks the list to pick a name. At 96 the copy stops after 95 characters, which
	 * landed eight characters into "ins_proletarian" and handed the picker "ins_prol" --
	 * a model that does not exist, so the player silently got TS's default and the server
	 * logged the same warning every frame.
	 *
	 * The name buffer is fine at 32: no single model name comes close. It is the LIST
	 * that overflows, and it grows every time a model is added to a class.
	 */
	new chosen[32], carry[TSM_MODELLIST], rest[TSM_MODELLIST];
	copy(rest, charsmax(rest), list);

	new count = 1;
	for (new i = 0; list[i]; i++)
	{
		if (list[i] == ',')
		{
			count++;
		}
	}

	new key = (ci + 1) * 3 + team;
	if (g_model_pick[id] < 1 || g_model_pick[id] > count || g_model_pick_key[id] != key)
	{
		g_model_pick[id] = random_num(1, count);
		g_model_pick_key[id] = key;
	}

	for (new n = 0; n < g_model_pick[id]; n++)
	{
		strtok(rest, chosen, charsmax(chosen), carry, charsmax(carry), ',', 0);
		copy(rest, charsmax(rest), carry);
	}
	if (!chosen[0])
	{
		return;
	}

	/*
	 * Record the model index we want, ALWAYS, before any of the write throttling
	 * below gets a say.
	 *
	 * This is the half that actually sticks. The userinfo "model" key is a request:
	 * CTSGameRules::GetPlayerModel answers it by re-applying its own mp_teammodels
	 * pick, and because every key write raises ClientUserInfoChanged, arguing with it
	 * produced the model visibly cycling. pev->modelindex is what the engine DRAWS,
	 * and writing it raises nothing at all -- so it is enforced per frame in
	 * fw_postthink_post instead, silently, and TS is welcome to keep the key.
	 */
	new mpath[96];
	formatex(mpath, charsmax(mpath), "models/player/%s/%s.mdl", chosen, chosen);

	// Kept whatever happens, so tsm_model can say what was picked even when the pick was
	// not usable -- "it chose X and X is missing" is the answer worth having.
	copy(g_model_chosen[id], charsmax(g_model_chosen[]), chosen);

	if (file_exists(mpath))
	{
		g_model_want_idx[id] = engfunc(EngFunc_ModelIndex, mpath);
		g_model_ok[id] = 1;
	}
	else
	{
		g_model_want_idx[id] = 0;
		g_model_ok[id] = 0;
		tlog("[TSM] WARNING: model '%s' is not installed (%s) -- leaving TS's choice alone.",
			chosen, mpath);
	}

	// Any model written at runtime that was not precached at map load will shift the
	// model index table and crash clients with "Bad model on beam (not sprite)" --
	// so every name used here must also be in mp_teammodels.
	dbgv("set_class_model: wants '%s' (idx %d) for %d (team %d, pick %d of %d)",
		chosen, g_model_want_idx[id], id, team, g_model_pick[id], count);
	new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);

	/*
	 * Write only when the WANTED model changes; verify only rarely.
	 *
	 * Reading the infokey back and comparing was not enough. Several callers reach
	 * this function -- the loadout, the userinfo forward, round start -- and every
	 * write raises ClientUserInfoChanged, which brings us straight back in. The log
	 * showed the same model written to the same four players several times a second.
	 *
	 * So the authority is what WE last wrote, kept in g_model_last. If the wanted
	 * model has not changed there is nothing to do, and we do not even read the
	 * infokey -- no read, no write, no event, no loop, however many callers arrive.
	 *
	 * TS can still move it, so every tsm_model_verify seconds we do read the live
	 * value and correct it if it has drifted. Once in a while per player, instead of
	 * a fight, and it is now the only path that can produce a repeat write.
	 */
	new Float:mnow = get_gametime();
	// equali returns an untagged cell, so the comparison makes the tag explicit.
	new bool:same_want = (equali(g_model_last[id], chosen) != 0);

	/*
	 * 0 means never re-check, and that is the default.
	 *
	 * The periodic re-check was the visible model change every few seconds: TS moves
	 * the model on its own schedule, we notice and write ours back, and the player
	 * watches it flip. Writing only when something actually happens -- a class is
	 * picked, a round starts, userinfo changes -- means one write per event and no
	 * cycling.
	 *
	 * If TS then wins and the model is wrong, that is a stable, visible problem to
	 * solve rather than a fight to referee.
	 */
	new Float:verify = get_pcvar_float(g_cv_modelverify);
	if (same_want && (verify <= 0.0 || (mnow - g_model_at[id]) < verify))
	{
		return;
	}

	if (same_want)
	{
		// Due a verification. Only write if TS has actually moved it.
		new live[32];
		live[0] = 0;
		engfunc(EngFunc_InfoKeyValue, buf, "model", live, charsmax(live));
		g_model_at[id] = mnow;

		if (equali(live, chosen))
		{
			return;
		}
	}

	copy(g_model_last[id], charsmax(g_model_last[]), chosen);
	g_model_at[id] = mnow;
	g_model_writes++;
	dbgv("set_class_model: WROTE '%s' for %d (team %d, pick %d of %d)",
		chosen, id, team, g_model_pick[id], count);
	engfunc(EngFunc_SetClientKeyValue, id, buf, "model", chosen);

	// The rendered model is not set here. g_model_want_idx was recorded above and is
	// enforced every frame in fw_postthink_post -- a one-off write here would just be
	// overruled by the next spawn, which is the whole history of this bug.
}

/// The class a player will actually play, falling back to tsm_default_class.
resolved_class(id)
{
	new c = g_player_class[id];
	if (c < 1 || c > g_class_count || !class_offered(c))
	{
		c = default_class();
	}
	return c;
}

/*
 * Places the class on the player: health, armor, model -- what a class IS, minus
 * the weapons.
 *
 * The weapons are written by the arm respawn (task_arm_respawn), inside the same
 * wash-and-arm operation. This pass runs from the freeze ticks and the release,
 * repeats resolved_class so a late pick does not lose its look, and must never
 * stand between a strip and the give: TS derives player speed from the weapon
 * slots the loadout consumes, so a weaponless frame is an immobile frame.
 */
apply_class(id)
{
	if (!get_pcvar_num(g_cv_classes) || !g_class_count)
	{
		return;
	}
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		return;
	}

	new c = resolved_class(id);
	new ci = c - 1;

	if (!g_player_class[id])
	{
		g_player_class[id] = c;
		client_print(id, print_chat, "[MATCH] No class picked -- you are %s for this match.",
			g_class_name[ci]);
	}

	// Weapons are per team: Assault carries an M4A1 for MSR and an AK47 for the
	// Insurrectionists, off one class and one menu entry.
	new team = g_match_team[id];
	if (team != 1 && team != 2)
	{
		team = 1;
	}

	/*
	 * Stripping and re-arming are ONE operation and must never be separated.
	 *
	 * TS derives player speed from the weapon slots the loadout consumes
	 * (CBasePlayer::GetSpeedBySlots), so a player holding nothing has zero maxspeed --
	 * and with no weapon there is also nothing to fire, scroll or select. Stripping
	 * while tsm_weapon_mode is 0 therefore left players unable to move or act at all.
	 */
	/*
	 * NO weapon entities are created here, by design.
	 *
	 * Spawning ts_groundweapon entities to hand out a loadout floods every connected
	 * client with entity traffic in a single frame -- with ten players that overran
	 * the network buffer (SZ_GetSpace: overflow) and the truncated message was then
	 * read as a beam, crashing clients with "Bad model on beam (not sprite)".
	 * Precaching the weapons did not help, because the precache table was never the
	 * problem.
	 *
	 * Humans are armed with ts_giveweapon in give_class_weapons() from task_arm_respawn,
	 * which creates nothing. Bots keep whatever rcbot gives them on top of the class
	 * loadout they are handed the same way.
	 */

	set_user_health(id, g_class_hp[ci]);

	// The machine's anti-heal watch is synced AT the write, not left to notice the
	// new value later: a mech's class health arriving with a stale watch is exactly
	// what the rule would refuse (see fw_prethink).
	if (g_class_perk[ci] == TSM_PERK_MECH)
	{
		g_mech_hp_watch[id] = g_class_hp[ci];
	}

	if (g_class_ap[ci] > 0)
	{
		set_user_armor(id, g_class_ap[ci]);
	}

	// Mech class: initialize rocket tracking
	if (g_class_perk[ci] == TSM_PERK_MECH)
	{
		g_mech_rocket_next[id] = 0.0;
		g_mech_rockets_used[id] = 0;
	}

	/*
	 * Guarded, because SetClientKeyValue inside raises ClientUserInfoChanged, and
	 * fw_userinfo answers that by calling set_class_model again. Without the flag the
	 * two bounced off each other and the model was rewritten in a burst -- which is
	 * what the once-a-second model change in game actually was.
	 */
	new bool:was_ui = g_in_userinfo[id];
	g_in_userinfo[id] = true;
	set_class_model(id, ci);
	g_in_userinfo[id] = was_ui;

	// Mech class: hide weapon worldmodel (M60) after a brief delay
	if (g_class_perk[ci] == TSM_PERK_MECH)
	{
		set_task(1.0, "task_hide_mech_weapon", id + 9000);
	}

	dbgv("apply_class done for %d", id);
	dbg("armed %d as '%s' team %d (%d weapons, %dhp)",
		id, g_class_name[ci], team, g_class_wcount[ci][team], g_class_hp[ci]);
}

/*
 * Writes a class loadout into TS's own armament, then respawns the player so
 * BuyArmament equips it.
 *
 * No entity is created, so nothing is precached at runtime -- which is the whole
 * point. The commands are TS's own and are not cheat-gated.
 */
/*
 * Is this weapon id in the player's weapon list right now?
 *
 * The tail check and every retry ask the same question, and they ask it of
 * get_user_weapons -- the engine's own item list -- rather than of any native's
 * return value, because that is the only answer that cannot be wrong about what
 * the player is actually carrying.
 */
stock bool:user_carries(id, wpn)
{
	new wl[32], wn;
	get_user_weapons(id, wl, wn);
	for (new w = 0; w < wn; w++)
	{
		if (wl[w] == wpn)
		{
			return true;
		}
	}
	return false;
}

/*
 * Asks a claimed mode for this arm's weapons (tsm_loadout in include\tsm_api.inc).
 *
 * A mode that answers PLUGIN_HANDLED replaces the class's weapons for this arm only --
 * survival's mutants roll a blade or a gun at every wave -- with a spec written like a class
 * line's weapon list: "13:3,22:2", "25:0", or "" for bare hands. The answer is kept in g_lo_*
 * until the next arm, so the M60-first half of an arm and the rest of its kit a beat later
 * give from the same roll. No mode, or no answer: -1, and the class's own weapons are given.
 */
resolve_loadout(id)
{
	g_lo_n[id] = -1;
	if (g_fw_loadout == -1 || !g_mode_name[0])
	{
		return;
	}

	new spec[TSM_LOADOUT_LEN];
	spec[0] = 0;
	new ret = PLUGIN_CONTINUE;
	ExecuteForward(g_fw_loadout, ret, id, PrepareArray(spec, sizeof spec, 1), sizeof spec);
	if (ret != PLUGIN_HANDLED)
	{
		return;
	}

	new n = 0;
	new rest[TSM_LOADOUT_LEN], carry[TSM_LOADOUT_LEN], pair[16], wpart[8], cpart[8];
	copy(rest, charsmax(rest), spec);
	while (rest[0] && n < TSM_LOADOUT_MAX)
	{
		strtok(rest, pair, charsmax(pair), carry, charsmax(carry), ',', 1);
		copy(rest, charsmax(rest), carry);
		if (!pair[0])
		{
			continue;
		}
		strtok(pair, wpart, charsmax(wpart), cpart, charsmax(cpart), ':', 1);
		new w = str_to_num(wpart);
		if (w < 1 || w > 38)
		{
			continue;
		}
		g_lo_wpn[id][n] = w;
		g_lo_clips[id][n] = str_to_num(cpart);
		n++;
	}
	g_lo_n[id] = n;
	dbg("loadout: the mode armed %d with '%s' (%d weapon(s))", id, spec, n);
}

/// How many weapons this arm gives: the mode's answer when it gave one, else the class's.
lo_count(id, ci, team)
{
	return (g_lo_n[id] >= 0) ? g_lo_n[id] : g_class_wcount[ci][team];
}

/// The i-th weapon this arm gives, from the mode's answer or the class line.
lo_wpn(id, ci, team, i)
{
	return (g_lo_n[id] >= 0) ? g_lo_wpn[id][i] : g_class_wpn[ci][team][i];
}

/// The i-th weapon's spare figure, from the mode's answer or the class line.
lo_clips(id, ci, team, i)
{
	return (g_lo_n[id] >= 0) ? g_lo_clips[id][i] : g_class_clips[ci][team][i];
}

/*
 * Hands the class loadout over directly, with no purchase involved.
 *
 * MUST BE PART OF THE ARM OPERATION, WITH NOTHING CLEARING THE INVENTORY BEHIND IT.
 * The call site is the arm respawn (task_arm_respawn): the gated strip happens right
 * before, and TS's own spawn-stripping is far away by now, so anything given here
 * survives -- once per round for a picked-and-applied class, and again only ever
 * through a fresh pick (the reissue path), never at go-live.
 *
 * ts_giveweapon goes nowhere near TS's buy path, which is the entire point: the
 * server runs weaponrestriction 1 because blocking buy commands from a plugin does
 * not actually stop people buying, and the old tkw path was refused by it along with
 * every other purchase. Verified with ts_probe_give before this was written.
 *
 * The weapon ids need no translation -- the class table already uses TS's own, the
 * ones tsconst.inc names TSW_GLOCK18 = 1, TSW_AK47 = 13, TSW_M82A1 = 18.
 */
give_class_weapons(id)
{
	if (!is_user_connected(id) || !is_user_alive(id) || !g_class_count)
	{
		return;
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0)
	{
		return;
	}

	new team = g_match_team[id];
	if (team != 1 && team != 2)
	{
		team = 1;
	}

	new bonus = get_pcvar_num(g_cv_clipbonus);
	new cap = get_pcvar_num(g_cv_clipcap);
	new spct = get_pcvar_num(g_cv_sparepct);
	if (cap < 1)
	{
		cap = 1;
	}

	/*
	 * Given BACK TO FRONT, so the primary is the last weapon handed over.
	 *
	 * TS leaves the most recently given weapon selected, and class lines read
	 * primary-first because that is the sane way to write them -- which meant the
	 * sidearm was always issued last and everyone, bots included, spawned holding a
	 * pistol with a rifle on their back.
	 *
	 * tsm_arm_order 0 restores the literal order if this ever needs inverting.
	 */
	new wn = lo_count(id, ci, team);
	new bool:reverse = (get_pcvar_num(g_cv_armorder) != 0);
	new given = 0;

	/*
	 * Room for the loadout, re-asserted before EVERY weapon.
	 *
	 * TS refuses a weapon that does not fit the player's free slots, and the loadout is
	 * given back to front -- so the one handed over LAST is the one that vanished when
	 * the slots ran out. For the Heavy that is the M60, which is why he spawned with
	 * nothing but his pistol and his grenade.
	 *
	 * One set before the loop is not enough: TS derives the figure from the weapons
	 * carried and recomputes it on every change, so by the time the M60 -- last -- was
	 * offered it was back to the weapons-derived value and refused.
	 *
	 * The figure is deliberately NOT put back: it is normally derived from the weapons
	 * carried and would be wrong either way, and the class speed clamp in fw_prethink is
	 * what actually governs movement.
	 */

	for (new step = 0; step < wn; step++)
	{
		new i = reverse ? (wn - 1 - step) : step;

		// The M60-first arm: the machine gun was handed over in task_arm_respawn
		// before TS had anything else crowding its slot table, and the rest of the
		// kit follows in task_give_rest. Here its index is simply walked past,
		// once, and the record is then retired.
		if (g_m60_skip[id] == i)
		{
			g_m60_skip[id] = -1;
			continue;
		}

		// The class line sets the baseline, tsm_clip_bonus tops every weapon up, and
		// tsm_clip_max stops any combination turning into an ammo dump.
		/*
		 * The class line sets the baseline, tsm_clip_bonus tops it up and tsm_clip_max is
		 * the ceiling nothing passes.
		 *
		 * AN EXPLICIT ZERO IS LEFT ALONE. A class line that asks for :0 means the weapon
		 * comes with exactly what it holds and no spares -- the Heavy's single frag
		 * grenade, the Officer's katana. Adding the bonus to those turned one grenade into
		 * as many as the bonus, which is a quietly large change to how the Heavy plays and
		 * nothing anyone asked for.
		 */
		new wpnid = lo_wpn(id, ci, team, i);
		new base = lo_clips(id, ci, team, i);

		// tsm_clip_bonus tops GUNS up with spare MAGAZINES. For the frag grenade
		// and the knives the class figure is a carried count -- the same native
		// reads it as "how many he carries" -- so the bonus is withheld from
		// them: a class line of one frag stays one frag. Explicit class values
		// live, the bonus just never reaches these ids (is_gun_id).
		new clips = base;
		if (base > 0 && is_gun_id(wpnid))
		{
			clips = base + bonus;
		}
		if (clips > cap)
		{
			clips = cap;
		}
		if (clips < 0)
		{
			clips = 0;
		}

		// Re-asserted before every give: TS derives free slots from carried weapons and
		// recomputes on every change, so by the time the M60 (given last) is offered the
		// figure is back to the weapons-derived value and refuses. Start at 200 and step
		// up to 999 if the give refuses -- the M60's slot cost exceeds whatever TS reports
		// as free after the pistol and grenade are already in hand.
		// Use 999 from the start so primaries (M60, Barrett, etc.) always fit,
		// especially with tsm_arm_order 0 giving them first.
		ts_setuserslots(id, 999);
		new gave = ts_giveweapon(id, wpnid, clips, get_pcvar_num(g_cv_wpnextra));
		given++;

		/*
		 * THE CLASS FIGURE IS SPARE RELOADS; TS'S RESERVE COUNTER IS SINGLE ROUNDS.
		 *
		 * ts_giveweapon's third argument and the class line both looked like clip counts,
		 * but the reserve TS keeps is the number itself in one-round units: hand an AK47
		 * a 3 and the reserve reads back as 3 beside a full 30-round magazine (measured
		 * with ts_probe), so the "most magazines have 9 extra bullets" everyone sees is
		 * exactly the class figure plus tsm_clip_bonus -- one partial reload at best.
		 * Once the weapon lands, the reserve is therefore rewritten in real ammunition:
		 * ts_getuserwpn hands over the freshly issued weapon's magazine capacity while it
		 * is still the selected weapon, and ts_setuserammo tops the spare to
		 * figure x mag size, HALVED and floor-rounded after the full amount read too
		 * generous, so an AK's 3+6 becomes 135 spare rounds instead of 9. The
		 * class line and tsm_clip_max keep meaning clips; only the value reaching TS
		 * changes.
		 *
		 * The in-hand check keeps the rewrite honest: ts_getuserwpn reports the weapon
		 * TS SELECTED, so if the give was refused or selection moved elsewhere, the
		 * figure is left alone rather than written onto the wrong gun.
		 */
		if (clips > 0 && gave && is_gun_id(wpnid))
		{
			new m_clip, m_ammo, m_mode, m_extra;
			new held = ts_getuserwpn(id, m_clip, m_ammo, m_mode, m_extra);
			if (held == wpnid && m_clip > 0 && spct > 0)
			{
				// Floor-rounded so no weapon gets the odd extra round; spct is the
				// percentage of the full mag stack, 100 = every listed magazine.
				new rounds = (clips * m_clip * spct) / 100;
				ts_setuserammo(id, wpnid, rounds);
				dbgv("give: %d <- weapon %d spare set to %d rounds (figure %d x mag %d x %d%%), reads back %d",
					id, wpnid, rounds, clips, m_clip, spct, ts_getuserammo(id, wpnid));
			}
			else
			{
				dbgv("give: %d <- weapon %d landed but not in hand (held %d, mag %d), spare left at %d",
					id, wpnid, held, m_clip, clips);
			}
		}
	}

	/*
	 * Did the LAST weapon out land? The one handed over last is the one TS is allowed
	 * to refuse on slots, and a refusal is otherwise invisible -- which is how the
	 * Heavy's M60 disappeared with no trace in any log.
	 *
	 * ONE RETRY NOW, THEN THE WARNING. The warning alone fired for every player every
	 * round since the fix-era rework and nothing ever came of it; a missing tail is
	 * either a real refusal or a give that did not stick, and both are cured by the
	 * same move: set the room again and hand it over once more, this time with the
	 * spare written the same way the loop writes it. Only a weapon that is STILL
	 * missing after that is reported, so the log stays a list of real failures.
	 */
	new tail = reverse ? 0 : (wn - 1);
	if (wn > 0)
	{
		new tail_wpn = lo_wpn(id, ci, team, tail);
		if (!user_carries(id, tail_wpn))
		{
			new tail_clips = lo_clips(id, ci, team, tail);

			// The bonus is withheld from carried-count weapons, same as the loop.
			if (tail_clips > 0 && is_gun_id(tail_wpn))
			{
				tail_clips += bonus;
			}
			if (tail_clips > cap)
			{
				tail_clips = cap;
			}
			if (tail_clips < 0)
			{
				tail_clips = 0;
			}

			ts_setuserslots(id, 999);
			ts_giveweapon(id, tail_wpn, tail_clips, get_pcvar_num(g_cv_wpnextra));

			if (user_carries(id, tail_wpn))
			{
				tlog("[TSM] tail retry: %s (%d) -- weapon %d landed on the second give.",
					g_class_name[ci], id, tail_wpn);

				// The same spare rewrite the loop would have run: the weapon is the
				// most recently handed over, so this is where the in-hand read is
				// trustworthy. Percentage and skip-rule included: spct <= 0 leaves
				// ts_giveweapon's small reserve standing, exactly like the loop.
				// Carried-count weapons (grenade, knives) skip the rewrite: their
				// figure is not rounds, and the give already set the right count.
				if (tail_clips > 0 && spct > 0 && is_gun_id(tail_wpn))
				{
					new t_clip, t_ammo, t_mode, t_extra;
					if (ts_getuserwpn(id, t_clip, t_ammo, t_mode, t_extra) == tail_wpn && t_clip > 0)
					{
						ts_setuserammo(id, tail_wpn, (tail_clips * t_clip * spct) / 100);
					}
				}
			}
			else
			{
				tlog("[TSM] WARNING: loadout for %s (%d): last weapon %d did NOT land (slots %d, m60 ammo %d).",
					g_class_name[ci], id, tail_wpn, ts_getuserslots(id), ts_getuserammo(id, 32));
			}
		}
	}

	dbg("gave %d weapon(s) to %d as '%s' (team %d)", given, id, g_class_name[ci], team);

	/*
	 * What TS actually attached, as opposed to what it was asked for.
	 *
	 * ONCE, AT THE END, AND ONLY WHEN SOMEONE IS READING IT. This started out inside the
	 * loop above and that was a bad place for it twice over: ts_getuserwpn reports the
	 * weapon IN HAND, which mid-loop is whatever TS happens to have switched to and often
	 * nothing at all -- and a native that errors aborts the whole call, which here is
	 * the arming call site (task_arm_respawn). Everything after the call site went
	 * with it, so the loadout menu simply never appeared during the countdown. A
	 * diagnostic must not be able to break the thing it is watching.
	 *
	 * Behind the same gate dbgv uses, so in ordinary play the native is never called.
	 */
	if (g_cv_logging != 0 && get_pcvar_num(g_cv_logging) && get_pcvar_num(g_cv_dbglog) >= 3)
	{
		new clip, ammo, mode, got;
		ts_getuserwpn(id, clip, ammo, mode, got);
		dbgv("give: %d asked for extra %d, ended up holding mode %d extra %d%s",
			id, get_pcvar_num(g_cv_wpnextra), mode, got,
			(got & TSA_SILENCER) ? " SILENCED" : "");
	}
}

issue_armament(id)
{
	if (!is_user_connected(id) || !g_class_count)
	{
		return;
	}

	/*
	 * NOTHING IS BOUGHT HERE.
	 *
	 * This used to write the loadout with TS's own tkw and tka commands, which go
	 * through the PURCHASE path -- they write the player's saved armament, and
	 * BuyArmament bought it on the respawn. That is why weaponrestriction 1
	 * emptied every loadout: as far as TS was concerned the plugin was a customer,
	 * and a restricted weapon is refused to customers.
	 *
	 * The weapons are handed over directly with ts_giveweapon in give_class_weapons(),
	 * measured with ts_probe_give: it arrives with weaponrestriction 1 set, which the
	 * purchase path never could. The server needs that cvar on, because blocking the
	 * buy commands from a plugin does not actually stop people buying.
	 *
	 * WHAT THIS FUNCTION DOES: the wash, and THE ONE ARM. Whatever the player had
	 * SAVED is emptied by the rst_cfg below before the round-start respawn, so
	 * TS's own PlayerSpawn applies an empty armament instead of their old loadout.
	 * The arm itself is THE SECOND ONE: it is scheduled for a class that is
	 * settled, and an unpicked player IS given the default as their pick here,
	 * so the freeze arm dresses them with everyone else -- the old rule of
	 * letting their arm follow the pick itself left a player who never picked
	 * holding nothing for the whole match, because nothing else in the match
	 * schedules an arm for them. An explicit pick still re-arms through
	 * task_reissue_armament.
	 */

	// Still ours as far as cmd_blockbuy is concerned, for the rst_cfg call.
	g_issuing[id] = true;

	/*
	 * engclient_cmd, not client_cmd.
	 *
	 * client_cmd asks the CLIENT to run the command and send it back, which a bot has
	 * no client to do. engclient_cmd executes it server-side for players and bots
	 * alike -- which also means the bypass can close on this same call frame, right
	 * below: nothing of ours is still in flight when this function returns.
	 */
	engclient_cmd(id, "rst_cfg");

	g_issuing[id] = false;

	dbg("armament washed for %d (class '%s') -- weapons follow on the arm task",
		id, g_class_name[resolved_class(id) - 1]);

	/*
	 * The arm, for whatever class resolved_class() currently resolves to.
	 * tsm_arm_delay into the freeze, on its own task id (born + 6000: bare
	 * player ids collide with remove_task(3) and the repeating freeze tick),
	 * and a wash re-entry kills any arm that is still pending first. The
	 * pick-driven path reaches this same tail through task_reissue_armament,
	 * so both routes share one gating decision.
	 *
	 * NOT gated on g_player_class[id] (an earlier version of this function
	 * both defaulted the pick AND gated the arm on that same write, right
	 * here). That default fired every round, before the class menu had ever
	 * been offered once that round -- may_pick_class() requires ST_FREEZE and
	 * the whole freeze-tick re-offer exists specifically because picking
	 * happens DURING the freeze, not before it, so locking in a default this
	 * early silently defeated the pick window every single round, including
	 * round 1 of a brand-new match. resolved_class() (used below and by every
	 * real gear-giving call) already falls back to the default class on its
	 * own while g_player_class[id] is still 0, so arming unconditionally here
	 * costs nothing -- the real "no class picked -> default" lock-in now
	 * happens only at go-live (apply_class(), task_go_live()'s own fallback),
	 * genuinely after the pick window has closed.
	 */
	{
		g_arm_pending[id] = 0;

		/*
		 * THE SCHEDULE NEVER OUTLIVES THE FREEZE WINDOW.
		 *
		 * The arm used to be delay = tsm_arm_delay + id*ARM_STAGGER, unconditionally:
		 * with a six-second freeze that is past go-live from about id 14 upward -- and
		 * every later pick pushes its whole schedule past it too, because the delay
		 * counts from the wash, not from the start of the freeze. The round moved;
		 * the loadout did not. The arm task then refused itself outside ST_FREEZE
		 * and the player spent the round empty, which is exactly "the loadouts just
		 * no-op sometimes".
		 *
		 * So the delay is WINDOWED: the base is clamped to what is left of the
		 * freeze, and the stagger -- still one slot per player, still in id order,
		 * because the burst it spreads is real -- is scaled down to fit inside the
		 * same window whenever the roster is too wide for 0.25s slots. Nobody is
		 * ever scheduled with the freeze already gone, and the late-arm path in
		 * task_arm_respawn arms anyone a live pick still catches out.
		 */
		new Float:delay = get_pcvar_float(g_cv_armdelay);
		if (delay < 0.5)
		{
			delay = 0.5;
		}

		if (g_state == ST_FREEZE)
		{
			new Float:room = float(g_freeze_left) - 1.0;
			if (room < 0.5)
			{
				room = 0.5;
			}
			if (delay > room)
			{
				delay = room;
			}

			new Float:slack = room - delay;
			if (slack < 0.0)
			{
				slack = 0.0;
			}

			// One slot per live player, in id order; the slot shrinks whenever the
			// roster would not otherwise fit inside the room that is left.
			new roster[32], rnum, rank = 0;
			get_players(roster, rnum, g_pf);
			for (new r = 0; r < rnum; r++)
			{
				if (roster[r] == id)
				{
					break;
				}
				if (roster[r] < id)
				{
					rank++;
				}
			}

			new Float:step = ARM_STAGGER;
			if (rank > 0 && float(rank) * step > slack)
			{
				step = slack / float(rank);
			}

			delay += float(rank) * step;
		}
		else
		{
			delay = 0.5;   // live re-issue: one player, straight away
		}

		remove_task(id + 6000);
		set_task(delay, "task_arm_respawn", id + 6000);
	}
}

/*
 * Clears weapons TS dropped at a player's feet while applying their loadout.
 *
 * Deliberately a tight radius and only run in the moment after arming, so a weapon the
 * mapper placed near a spawn point is not swept up with it.
 */
public task_clean_drops(taskid)
{
	new id = taskid - 3000;
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		return;
	}

	new Float:porg[3], Float:eorg[3];
	pev(id, pev_origin, porg);

	// Bounded rather than while(1): a search that never terminates would hang the
	// server, and the compiler objects to the constant test anyway.
	new ent = -1, removed = 0;
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

		pev(ent, pev_origin, eorg);
		if (get_distance_f(porg, eorg) > 72.0)
		{
			continue;
		}

		set_pev(ent, pev_flags, pev(ent, pev_flags) | TSM_FL_KILLME);
		removed++;
	}

	if (removed)
	{
		dbgv("cleaned %d dropped weapon(s) around %d", removed, id);
	}
}

/*
 * Some maps should carry no weapons at all -- not a bug workaround, a per-map choice.
 * task_clean_drops() above is deliberately narrow (one player, 72 units, the moment
 * after arming) and leaves everything else on the ground alone, so most of what
 * combat drops across a map this size just sits there. This runs every second from
 * task_tick (already a 1-second repeating task) and sweeps every ts_groundweapon on
 * the map unconditionally -- no radius, no trigger player, map-authored or dropped,
 * all the same. Gated on tsm_no_weapons, which a map turns on for itself from its own
 * ts/mapconfigs/<mapname>.cfg -- every map that does not set it keeps normal drops.
 */
clean_all_weapons()
{
	if (!get_pcvar_num(g_cv_no_weapons))
	{
		return;
	}

	new ent = -1;
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
		set_pev(ent, pev_flags, pev(ent, pev_flags) | TSM_FL_KILLME);
	}
}

/*
 * Rewrites a player's loadout after a late class pick, so the choice applies to the
 * round that is already counting down rather than the next one.
 */
public task_reissue_armament(taskid)
{
	new id = taskid - 5000;

	/*
	 * ST_LIVE is allowed as well: a pick that lands after go-live still re-arms
	 * through the same wash-and-schedule, and task_arm_respawn's late arm hands
	 * the kit over in place. Before, the pick was simply ignored.
	 */
	if (!is_user_connected(id) || (g_state != ST_FREEZE && g_state != ST_LIVE))
	{
		return;
	}
	if (get_pcvar_num(g_cv_wpnmode) != 2 || !get_pcvar_num(g_cv_classes))
	{
		return;
	}

	/*
	 * The class was picked and applied -- this is the arm that FOLLOWS the pick.
	 * issue_armament() washes the saved armament and schedules the arm respawn
	 * straight away, so something chosen during the countdown is worn this round,
	 * once, through the same machinery as every other arm. This task also serves
	 * .roam's hand-back dispatch: cmd_roam goes through it because issue_armament
	 * lives further down the file and this file's compiler rejects forward
	 * references -- the roam call keeps working by the same route.
	 */
	dbg("re-issuing loadout for %d after a late class pick", id);
	issue_armament(id);
}

/*
 * One-time backup for the per-frame clear in fw_prethink: the same four cosmetic
 * pairs, re-asserted just after the class lands, so the very first frames of a
 * mech's life are clean even before its first prethink pass.
 *
 * The old version of this task hunted an entity called weapon_m249 and set
 * EF_NODRAW on it. That classname does not exist in TS -- nothing was ever found,
 * and the mesh is not an entity anyway: it is the attachment model TS hangs on
 * the player entvar, which is why it is cleared here and in prethink.
 */
public task_hide_mech_weapon(taskid)
{
	new id = taskid - 9000;
	if (!is_user_connected(id))
	{
		return;
	}
	new ci = resolved_class(id) - 1;
	if (ci < 0 || g_class_perk[ci] != TSM_PERK_MECH)
	{
		return;
	}

	set_pev(id, pev_weaponmodel, 0);
	set_pev(id, pev_weaponmodel2, "");
	set_pev(id, pev_viewmodel, 0);
	set_pev(id, pev_viewmodel2, "");
	dbgv("mech %d weapon pictures cleared (weaponmodel + viewmodel)", id);
}

/*
 * The give half of an arm, shared by the in-freeze arm and the late arm.
 *
 * THE M60 GOES FIRST. Its slot demand outgrows whatever TS will report free once a
 * pistol and a grenade are already carried, and a refusal is invisible, which is
 * how the Heavy kept spawning M60-less. So the machine gun is issued ALONE, before
 * anything teaches TS's slot table that more is coming, and the rest of the kit
 * follows a beat later in task_give_rest -- where the ammunition goes too, behind
 * every weapon it will feed.
 *
 * g_m60_skip records the M60's index in the class list so give_class_weapons walks
 * past it instead of issuing it a second time -- BUT ONLY WHEN IT REALLY WENT IN.
 * The record used to be set unconditionally, so a refused machine gun counted as
 * delivered and was never retried: the Heavy and the Mech spent whole rounds
 * without it while the only trace was one dbgv line into a log nobody reads. A
 * refusal now clears the record and the kit loop gets its own attempt at the same
 * weapon, and both outcomes speak to the always-on log.
 */
arm_give_kit(id)
{
	g_m60_skip[id] = -1;
	remove_task(id + 8500);

	// The weapons this arm gives, settled once: a claimed mode's loadout, or the class's own.
	resolve_loadout(id);

	new ciH = resolved_class(id) - 1;
	if (ciH >= 0 && ciH < g_class_count)
	{
		new teamH = g_match_team[id];
		if (teamH != 1 && teamH != 2)
		{
			teamH = 1;
		}

		new m60i = -1;
		new m60n = lo_count(id, ciH, teamH);
		for (new xi = 0; xi < m60n; xi++)
		{
			if (lo_wpn(id, ciH, teamH, xi) == TSM_M60_WPN)
			{
				m60i = xi;
				break;
			}
		}

		if (m60i >= 0)
		{
			new m60base = lo_clips(id, ciH, teamH, m60i);
			new m60clips = (m60base > 0) ? (m60base + get_pcvar_num(g_cv_clipbonus)) : 0;
			new m60cap = get_pcvar_num(g_cv_clipcap);
			if (m60cap < 1)
			{
				m60cap = 1;
			}
			if (m60clips > m60cap)
			{
				m60clips = m60cap;
			}
			if (m60clips < 0)
			{
				m60clips = 0;
			}

			ts_setuserslots(id, 999);
			new m60gave = ts_giveweapon(id, TSM_M60_WPN, m60clips, get_pcvar_num(g_cv_wpnextra));

			// The native's answer is not taken over the weapon list: a give that
			// landed is a give that landed, whatever the return value said.
			if (!m60gave && user_carries(id, TSM_M60_WPN))
			{
				m60gave = 1;
			}

			if (m60clips > 0 && m60gave)
			{
				new m_clip, m_ammo, m_mode, m_extra;
				new held = ts_getuserwpn(id, m_clip, m_ammo, m_mode, m_extra);
				if (held == TSM_M60_WPN && m_clip > 0)
				{
					// Floor-rounded, the same reserve arithmetic every other give uses --
					// percentage from tsm_clip_sparepct, and the same skip-rule: spct
					// 0 or less leaves ts_giveweapon's small reserve standing.
					new m60spct = get_pcvar_num(g_cv_sparepct);
					if (m60spct > 0)
					{
						new m60rounds = (m60clips * m_clip * m60spct) / 100;
						ts_setuserammo(id, TSM_M60_WPN, m60rounds);
						dbgv("give: M60-first for %d spare set to %d rounds", id, m60rounds);
					}
				}
			}

			if (m60gave)
			{
				g_m60_skip[id] = m60i;
			}
			else
			{
				g_m60_skip[id] = -1;
			}

			// Always-on, deliberately: which way the machine gun went is the one
			// fact the Heavy's and the Mech's whole complaint turns on, and dbgv
			// only writes when a debug session is already open. One line per M60
			// class per arm.
			tlog("[TSM] M60-first for %d: %s -- rest of the kit on task_give_rest",
				id, m60gave ? "issued" : "REFUSED, the kit will retry it");

			set_task(1.2, "task_give_rest", id + 8500);
			return;
		}
	}

	give_class_weapons(id);
	top_up_reserve(id, get_pcvar_num(g_cv_giveammo) * 25);
}

public task_arm_respawn(taskid)
{
	new id = taskid - 6000;

	if (!is_user_connected(id))
	{
		g_issuing[id] = false;
		g_cash_lend[id] = false;
		g_arm_pending[id] = 0;
		return;
	}

	/*
	 * THE LATE ARM: the schedule lost its race with LIVE.
	 *
	 * This task is set tsm_arm_delay plus the player's stagger after the wash, and
	 * nothing in the freeze is obliged to last that long -- so a late class pick, a
	 * late bot, or a slow schedule can come due after the round has already gone
	 * live. That used to be the end of it: the task returned here without giving
	 * anything, and the player went a whole round with no loadout at all.
	 *
	 * NO strip, NO respawn, NO teleport: the player is alive, live and placed, and
	 * it is the weapons that are missing -- so the kit is what is handed over. Only
	 * the still-unarmed take this route (a re-issue for an already-armed player has
	 * nothing to add), and the give is the same one the freeze arm uses.
	 */
	if (g_state == ST_LIVE)
	{
		if (!g_armed[id] && is_user_alive(id)
			&& (tsm_live_team_of(id) == 1 || tsm_live_team_of(id) == 2))
		{
			arm_give_kit(id);
			g_armed[id] = true;
			tlog("[TSM] late arm: %d armed after LIVE (class %d).", id, resolved_class(id));
			mode_notify(g_fw_armed, id);
		}

		g_issuing[id] = false;
		g_cash_lend[id] = false;
		g_arm_pending[id] = 0;
		return;
	}

	if (g_state != ST_FREEZE)
	{
		g_issuing[id] = false;
		g_cash_lend[id] = false;
		g_arm_pending[id] = 0;
		return;
	}

	/*
	 * If the client has not sent everything back yet, wait another beat rather than
	 * respawning into a half-written armament. Capped so a dropped command cannot
	 * stall the round -- a partial loadout still beats no round.
	 */
	if (g_arm_pending[id] > 0 && g_freeze_left > 2)
	{
		dbgv("armament: %d still has %d command(s) outstanding, waiting", id, g_arm_pending[id]);
		set_task(0.5, "task_arm_respawn", id + 6000);
		return;
	}

	if (g_arm_pending[id] > 0)
	{
		dbg("armament: %d respawned with %d command(s) unconfirmed -- loadout may be short",
			id, g_arm_pending[id]);
	}
	g_arm_pending[id] = 0;

	/*
	 * The strip, gated: a server running weaponrestriction 1 has already refused
	 * every purchase the round did not sanction and the respawn below empties the
	 * inventory regardless, so the wipe only stays for the case where that cvar
	 * is not set, keeping a fresh loadout from stacking on a carried-over one.
	 */
	if (get_cvar_num("weaponrestriction") != 1)
	{
		strip_user_weapons(id);
	}

	/*
	 * The respawn no longer equips anything -- it just puts the player back on their
	 * feet. BuyArmament still runs inside PlayerSpawn, but rst_cfg left it an empty
	 * armament to apply, and the wallet is no longer opened for it.
	 *
	 * NOT LENDING THE CASH HERE IS DELIBERATE. The loan existed so BuyArmament could
	 * afford our loadout, and it was the one window in which a player's OWN saved
	 * armament could also be re-applied, because the money happened to be there.
	 * Nothing is bought now, so the window closes.
	 */
	spawn(id);

	/*
	 * The class menu requeue the old arm carried is NOT back with it: this task only
	 * ever reaches a player whose class is already picked and applied, so the old
	 * task_show_class follow-up could never show anything -- the pick and the freeze
	 * tick's re-offer own the menu.
	 */

	/*
	 * AFTER the spawn, never before it.
	 *
	 * spawn() clears the inventory, so a weapon given any earlier is thrown away a
	 * moment later -- and the loadout comes out empty again, for a completely
	 * different reason that looks exactly the same.
	 */
	/*
	 * The kit itself, M60-first where the class carries one. Shared with the late
	 * arm so both routes hand over exactly the same loadout; the whole shuffle --
	 * the machine gun alone first, the rest and the ammunition a beat later -- now
	 * lives in one place, arm_give_kit.
	 */
	arm_give_kit(id);

	new ci = resolved_class(id) - 1;
	apply_class_scale(id);
	set_user_health(id, g_class_hp[ci]);
	if (g_class_perk[ci] == TSM_PERK_MECH)
	{
		g_mech_hp_watch[id] = g_class_hp[ci];
	}
	if (g_class_ap[ci] > 0)
	{
		set_user_armor(id, g_class_ap[ci]);
	}

	place_at_spawn(id);
	hold_player(id, false);
	g_armed[id] = true;           // loadout complete -- this player counts toward the LIVE gate
	g_issuing[id] = false;

	// After placement, so the sweep happens where the player actually ended up.
	if (get_pcvar_num(g_cv_cleandrops))
	{
		set_task(0.4, "task_clean_drops", id + 3000);
	}

	dbgv("armament: respawned and placed %d", id);
}

/*
 * Second half of the M60-first arm: the rest of the class kit, handed over now
 * that TS has settled the machine gun into its slot table, plus the ammunition
 * that waits behind the weapons it feeds.
 */
public task_give_rest(taskid)
{
	new id = taskid - 8500;

	if (!is_user_connected(id) || !is_user_alive(id) || g_elim[id])
	{
		return;
	}
	if (g_state != ST_FREEZE && g_state != ST_LIVE)
	{
		return;
	}
	if (g_m60_skip[id] < 0)
	{
		return;   // there was no M60-first arm waiting for this
	}

	give_class_weapons(id);
	top_up_reserve(id, get_pcvar_num(g_cv_giveammo) * 25);

	dbgv("give-rest: %d finished the rest of the kit and their ammunition", id);
}

/*
 * True for The Specialists 3.0 ids that are GUNS -- the ones whose figure in
 * the ammo native is a caliber reserve. False for kung fu (0), the frag grenade
 * (24), the combat knife (25), the briefcase (29), the katana (34), the seal
 * knife (35) and the throwing knife (38): for those the same native reads and
 * writes HOW MANY THE PLAYER CARRIES, not spare rounds. The sawed-off (33), the
 * contender (36) and the akimbo Skorpion (37) are guns.
 */
stock bool:is_gun_id(w)
{
	switch (w)
	{
		case TSW_KUNG_FU, TSW_M61GRENADE, TSW_CKNIFE, TSW_C4, TSW_KATANA,
			TSW_SKNIFE, TSW_TKNIFE:
		{
			return false;
		}
	}

	return true;
}

/*
 * Tops the target's carried guns up with spare rounds, precisely, and returns
 * how many rounds actually landed.
 *
 * REPLACES the ts_groundammo hand-out that used to live under this name. That
 * scheme was decoded out of the TS 3.0 binary while chasing ".ammo gave me
 * nothing", and the brokenness is in the mod's own entity code, not just in
 * how it was used here:
 *
 *   - the mags<N> key lands one caliber HIGHER than its number (the entity
 *     writes caliber slot N+1 for key N), so with keys 1..11 the 9 x 19mm pool
 *     was unreachable by any key, and 7.62 x 51mm -- the M60E3's caliber --
 *     would only be reachable through a key that was never set;
 *   - the amount the key writes follows the KEY's caliber, not the slot it
 *     lands in, so the sizes that did arrive belonged to a different round;
 *   - the grab hands EVERY nonzero caliber over to whoever touched it,
 *     carried or not, so one player's spares would flow into another.
 *
 * There is no entity any more: the ammo goes through the tsx natives, which
 * hold the same caliber mapping the game itself reloads from. Pass one reads
 * every gun's current reserve (a shared-caliber pair shares one baseline),
 * pass two writes baseline + rounds and reads back. The read-back is the
 * honesty clause: a caliber already at TS's cap reads unchanged, a gun the
 * player does not carry is refused outright, so the returned total is rounds
 * that actually landed. The grenade and the knives never appear (is_gun_id
 * keeps them out): the native would write a carried count for them, which is
 * exactly the "extra ammo given to the grenade" the resupply was told not do.
 *
 * Callers: the class loadout, the combat engineer, and the bot resupply ticker.
 */
top_up_reserve(target, rounds)
{
	if (rounds < 1)
	{
		return 0;
	}

	// Pass 1: the baseline, read BEFORE any write. That is what makes one
	// caliber gain exactly `rounds` however many guns of it are carried.
	new pre[39];
	for (new w = 1; w <= 38; w++)
	{
		if (!is_gun_id(w))
		{
			continue;
		}
		pre[w] = ts_getuserammo(target, w);
		if (pre[w] < 0)
		{
			pre[w] = 0;
		}
	}

	new total = 0;
	for (new w = 1; w <= 38; w++)
	{
		if (!is_gun_id(w))
		{
			continue;
		}

		// Absolute write of baseline + rounds: for a shared caliber that is the
		// value the caliber's first gun already set, so later guns of the same
		// caliber are read-back-verified no-ops.
		ts_setuserammo(target, w, pre[w] + rounds);
		new after = ts_getuserammo(target, w);
		if (after > pre[w])
		{
			total += after - pre[w];
		}
	}

	return total;
}

/*
 * Puts a coloured glow shell on a player for a few seconds.
 *
 * Shared by the medic's heal (red) and the engineer's resupply (yellow), so that the
 * two cannot drift apart -- and because the one detail that matters here is easy to
 * get wrong twice.
 *
 * THAT DETAIL: renderamt is the SHELL THICKNESS for a glow shell, not an alpha.
 * Leaving it at zero sets up a shell with no thickness, which is exactly as invisible
 * as not setting the glow at all. That is why the first version of the medic's glow
 * drew nothing.
 *
 * ONE TASK ID FOR BOTH, deliberately. If a medic heals someone and an engineer
 * resupplies them a moment later, the second glow replaces the first and a single
 * timer clears it. Giving them separate ids instead leaves two timers racing, and the
 * earlier one strips a glow the later one had just set.
 */
/*
 * Slow health regeneration for anyone whose class carries TSM_PERK_REGEN.
 *
 * One server-wide repeating task rather than a task per player: it walks everyone
 * once per interval, which is cheaper than up to 32 timers and means a player
 * changing class or dying needs no bookkeeping to cancel anything.
 *
 * It RE-ARMS ITSELF from the cvar rather than using a repeating task, so changing
 * tsm_regen_interval takes effect on the next tick instead of needing a map change.
 *
 * Capped at the class's own health, so a Heavy stops at 200 and nothing creeps past
 * what its class line asks for.
 */
public task_regen()
{
	set_task(regen_interval(), "task_regen", TSM_TASK_REGEN);

	if (!get_pcvar_num(g_cv_enabled) || !g_class_count)
	{
		return;
	}

	new amount = get_pcvar_num(g_cv_regenamt);
	if (amount < 1)
	{
		return;
	}

	new Float:pause = get_pcvar_float(g_cv_regenpause);
	new Float:now = get_gametime();
	new players[32], pnum, id;
	get_players(players, pnum, g_pf);

	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (!is_user_alive(id) || g_elim[id] || g_locked_out[id])
		{
			continue;
		}

		new ci = resolved_class(id) - 1;
		if (ci < 0 || g_class_perk[ci] != TSM_PERK_REGEN)
		{
			continue;
		}

		// Hit too recently. Skipped entirely rather than healed by a smaller amount:
		// "it stops while you are being shot at" is the behaviour asked for.
		if ((now - g_last_hit[id]) < pause)
		{
			continue;
		}

		new cur = get_user_health(id);
		new top = g_class_hp[ci];
		if (cur >= top)
		{
			continue;
		}

		new after = cur + amount;
		if (after > top)
		{
			after = top;
		}
		set_user_health(id, after);
		dbgv("regen: %d %d -> %d (cap %d)", id, cur, after, top);
	}
}

Float:regen_interval()
{
	new Float:every = get_pcvar_float(g_cv_regenevery);
	// Never zero or negative: a task that re-arms itself at 0.0 is an infinite loop
	// inside one frame, and the server does not come back from it.
	if (every < 1.0)
	{
		every = 15.0;
	}
	return every;
}

/*
 * Plays a perk's sound ON the player it was used on, so everyone nearby hears it.
 *
 * Emitted from the target entity at ATTN_NORM, which is what makes it carry a sensible
 * distance and fall off -- a sound sent only to the two players involved would be
 * silent to the squad standing around them, and the point of these is that the people
 * nearby know a medic or an engineer is working.
 *
 * On CHAN_AUTO, like the death voice. Every perk prints a chat line straight after its
 * sound, and TS's client plays misc/talk.wav for a chat line on the local player's
 * CHAN_ITEM -- the channel a sound on that player would share, and a sound replaces the
 * one before it on the same entity and channel. GoldSrc sends entity sounds unreliably,
 * so the chat line starts first and the perk sound replaces it; Xash3D FWGS sends them
 * reliably and in order, so the chat line comes second. CHAN_AUTO is never replaced.
 */
perk_sound(target, pcvar)
{
	if (!is_user_connected(target))
	{
		return;
	}
	new snd[64];
	get_pcvar_string(pcvar, snd, charsmax(snd));
	if (!snd[0])
	{
		return;
	}
	emit_sound(target, CHAN_AUTO, snd, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
}

glow_player(target, Float:r, Float:g, Float:b, Float:secs, shell)
{
	if (!is_user_connected(target) || !is_user_alive(target))
	{
		return;
	}
	if (shell < 1)
	{
		shell = 16;
	}

	new Float:col[3];
	col[0] = r;
	col[1] = g;
	col[2] = b;
	set_pev(target, pev_renderfx, TSM_RENDERFX_GLOW);
	set_pev(target, pev_rendercolor, col);
	set_pev(target, pev_renderamt, float(shell));
	set_pev(target, pev_rendermode, TSM_RENDER_NORMAL);

	remove_task(target + 8000);
	set_task(secs, "task_clear_glow", target + 8000);
}

/*
 * Clears a glow shell off a player.
 *
 * renderfx is restored rather than rendermode, because the elimination hide owns
 * rendermode and renderamt -- writing those back from here would un-hide the body
 * of someone who died while still glowing.
 */
public task_clear_glow(taskid)
{
	new id = taskid - 8000;
	if (!is_user_connected(id))
	{
		return;
	}

	set_pev(id, pev_renderfx, TSM_RENDERFX_NONE);
	set_pev(id, pev_renderamt, 0.0);
}

/*
 * A medic's heal: top a teammate up, on a cooldown, and glow them red while it
 * lands so both of them can see that it happened.
 *
 * Capped at the target's own class health. A Heavy's 125 is part of what that
 * class costs, so being able to top anyone past their own ceiling would undo the
 * class table.
 */
medic_heal(id, target)
{
	new Float:now = get_gametime();
	new Float:cool = get_pcvar_float(g_cv_medcool);

	if (g_medic_at[id] > 0.0 && (now - g_medic_at[id]) < cool)
	{
		client_print(id, print_center, "Medkit ready in %.0fs", cool - (now - g_medic_at[id]));
		return;
	}

	new ci = resolved_class(target) - 1;
	new maxhp = g_class_hp[ci];
	if (maxhp < 1)
	{
		maxhp = 100;
	}

	// Mech class cannot be healed by medics (not biologically alive)
	if (ci >= 0 && g_class_perk[ci] == TSM_PERK_MECH)
	{
		client_print(id, print_center, "Cannot heal a Mech -- it's not alive");
		return;
	}

	new cur = get_user_health(target);
	if (cur >= maxhp)
	{
		// Refused WITHOUT spending the cooldown. Charging a medic for a heal that did
		// nothing would just teach them to check health bars before pressing use.
		client_print(id, print_center, "They are already at full health");
		return;
	}

	new after = cur + get_pcvar_num(g_cv_medheal);
	if (after > maxhp)
	{
		after = maxhp;
	}

	set_user_health(target, after);
	g_medic_at[id] = now;

	// Red, for a heal.
	glow_player(target, 255.0, 0.0, 0.0,
		get_pcvar_float(g_cv_medglow), get_pcvar_num(g_cv_medshell));
	perk_sound(target, g_cv_medsound);

	new a[32], b[32];
	get_user_name(id, a, charsmax(a));
	get_user_name(target, b, charsmax(b));
	client_print(id,     print_chat, "[MATCH] You healed %s to %d hp.", b, after);
	client_print(target, print_chat, "[MATCH] %s healed you to %d hp.", a, after);
	dbg("medic %d healed %d: %d -> %d", id, target, cur, after);
}

/*
 * .follow -- take the bots on your side under command.
 *
 * Officer only, and only while a round is live. Bots already following someone
 * else are left alone rather than poached, so two officers do not spend the round
 * taking the same squad off each other.
 */
cmd_squad_follow(id)
{
	if (!is_officer(id))
	{
		client_print(id, print_chat, "[MATCH] Only an Officer can give orders, and only during a round.");
		return;
	}

	if (is_user_bot(id))
	{
		return;   // rcbot's squad menu is a menu; a bot cannot answer one
	}

	/*
	 * Taken by PROXIMITY, here, rather than handed to rcbot's own squad menu.
	 *
	 * The menu was the previous answer and it is a reasonable one -- rcbot paths and
	 * holds formation properly, which steering from outside cannot. What it cannot do
	 * is answer the question an officer is actually asking in an elimination round:
	 * "these men, with me, now". Its squad is chosen from a list, it is not scoped to
	 * who is standing beside you, and it re-decides on its own schedule.
	 *
	 * So the men near him come under command and the steering in task_squad holds
	 * them. The cost is pathing, and it is paid for in task_squad by handing a bot
	 * back to rcbot whenever it cannot see its officer -- see the note there.
	 */
	new Float:me[3];
	pev(id, pev_origin, me);

	// No distance cap and no squad cap -- every bot on the officer's side is taken.
	// Bots too far to steer are warped beside the officer by task_squad's existing
	// teleport logic (g_cv_squad_warp).
	new cand[32], Float:dist[32], n = 0, owned = 0;
	new players[32], pnum;
	get_players(players, pnum, g_pf);

	for (new i = 0; i < pnum; i++)
	{
		new b = players[i];
		if (!is_user_bot(b) || !is_user_alive(b) || g_elim[b])
		{
			continue;
		}
		if (g_match_team[b] != g_match_team[id])
		{
			continue;
		}

		new Float:him[3];
		pev(b, pev_origin, him);
		new Float:d = get_distance_f(me, him);

		// Already somebody else's. Counted so he is told, and left alone: two officers
		// steering one bot would pull it between them every frame.
		if (g_squad_leader[b] && g_squad_leader[b] != id)
		{
			owned++;
			continue;
		}
		if (g_squad_leader[b] == id)
		{
			continue;   // already his
		}

		cand[n] = b;
		dist[n] = d;
		n++;
	}

	// Insertion sort: at most 32 and usually a handful, so nothing cleverer is worth
	// the lines.
	for (new i = 1; i < n; i++)
	{
		new c = cand[i];
		new Float:dv = dist[i];
		new j = i - 1;
		while (j >= 0 && dist[j] > dv)
		{
			cand[j + 1] = cand[j];
			dist[j + 1] = dist[j];
			j--;
		}
		cand[j + 1] = c;
		dist[j + 1] = dv;
	}

	new took = 0;
	new have = squad_size(id);
	for (new i = 0; i < n; i++)
	{
		g_squad_leader[cand[i]] = id;
		took++;
	}

	if (!took)
	{
		if (owned)
		{
			client_print(id, print_chat, "[MATCH] %d nearby %s already being commanded by another officer.",
				owned, owned == 1 ? "is" : "are");
		}
		else
		{
			client_print(id, print_chat, "[MATCH] No bots available on your side.");
		}
		return;
	}

	new name[32];
	get_user_name(id, name, charsmax(name));
	client_print(id, print_chat, "[MATCH] %d on you. Squad is now %d under command. Type .unfollow to stand them down.",
		took, have + took);
	if (owned)
	{
		client_print(id, print_chat, "[MATCH] %d more nearby %s already being commanded by another officer.",
			owned, owned == 1 ? "is" : "are");
	}
	team_print(g_match_team[id], "[MATCH] %s has taken %d under command.", name, took);
	dbg("officer %d took %d bot(s), %d already owned", id, took, owned);
}

/// .unfollow -- stand the whole squad down.
cmd_squad_dismiss(id)
{
	// Guarded like .follow is. Without this any player at all could type .unfollow --
	// harmless once it stopped opening rcbot's menu at them, but it answered as though
	// they could have had a squad.
	if (!is_officer(id))
	{
		client_print(id, print_chat, "[MATCH] Only an Officer gives orders, and only during a round.");
		return;
	}

	new n = disband_squad(id);
	if (!n)
	{
		client_print(id, print_chat, "[MATCH] Nobody is following you.");
		return;
	}

	client_print(id, print_chat, "[MATCH] %d stood down.", n);
	dbg("officer %d dismissed %d bot(s)", id, n);
}

/// .unstick -- clear yourself and nearby teammate bots off you.
cmd_player_unstick(id)
{
	// Dead players can't unstick
	if (!is_user_alive(id) || !is_user_connected(id))
	{
		client_print(id, print_chat, "[MATCH] You are not in the game.");
		return;
	}
	
	// 3-second cooldown
	new Float:now = get_gametime();
	if (g_unstick_at[id] > now)
	{
		client_print(id, print_chat, "[MATCH] Give that a second.");
		return;
	}
	g_unstick_at[id] = now + 3.0;
	
	new moved = 0;
	new Float:my_origin[3];
	pev(id, pev_origin, my_origin);
	
	// Find teammate bots IN YOUR SQUAD within 56 units (2D)
	new players[32], pnum;
	get_players(players, pnum, "a"); // alive, includes bots
	for (new i = 0; i < pnum; i++)
	{
		new bot = players[i];
		if (bot == id || !is_user_bot(bot))
		{
			continue;
		}
		// Only bots in YOUR squad (following YOU)
		if (g_squad_leader[bot] != id)
		{
			continue;
		}
		// Same team only (0==0 in warmup)
		if (g_match_team[bot] != g_match_team[id])
		{
			continue;
		}
		
		new Float:bot_origin[3];
		pev(bot, pev_origin, bot_origin);
		
		new Float:dx = bot_origin[0] - my_origin[0];
		new Float:dy = bot_origin[1] - my_origin[1];
		new Float:dist2d = floatsqroot(dx*dx + dy*dy);
		
		if (dist2d >= TSM_UNSTICK_REACH)
		{
			continue;
		}
		
		// Try to push bot outward: base direction + ±45/±90/±180
		new Float:base_yaw = floatatan2(dy, dx, degrees);
		new const Float:yaw_offsets[8] = { 0.0, 45.0, -45.0, 90.0, -90.0, 135.0, -135.0, 180.0 };
		
		for (new j = 0; j < 8; j++)
		{
			new Float:yaw = base_yaw + yaw_offsets[j];
			new Float:cand[3];
			cand[0] = my_origin[0] + floatcos(yaw, degrees) * TSM_UNSTICK_REACH;
			cand[1] = my_origin[1] + floatsin(yaw, degrees) * TSM_UNSTICK_REACH;
			cand[2] = my_origin[2];
			
			// TraceHull to verify clear spot (ignore the CALLER so their own hull doesn't veto)
			new tr = 0;
			new Float:start[3], Float:end[3];
			start[0] = cand[0];
			start[1] = cand[1];
			start[2] = cand[2] + 8.0;
			end[0] = cand[0];
			end[1] = cand[1];
			end[2] = cand[2] - 128.0;
			engfunc(EngFunc_TraceHull, start, end, DONT_IGNORE_MONSTERS, TSM_HULL_HUMAN, id, tr);
			
			new Float:frac;
			get_tr2(tr, TR_flFraction, frac);
			new bool:start_solid;
			get_tr2(tr, TR_StartSolid, start_solid);
			
			if (start_solid || frac < 1.0)
			{
				continue;
			}
			
			// Valid: place bot there
			new Float:dest[3];
			get_tr2(tr, TR_vecEndPos, dest);
			engfunc(EngFunc_SetOrigin, bot, dest);
			
			new Float:zero_vel[3] = { 0.0, 0.0, 0.0 };
			set_pev(bot, pev_velocity, zero_vel);
			moved++;
			break;
		}
		// If no spot found, this bot stays put (silent)
	}
	
	if (moved > 0)
	{
		client_print(id, print_chat, "[MATCH] Moved %d bot%s off you.", moved, moved == 1 ? "" : "s");
	}
	else
	{
		client_print(id, print_chat, "[MATCH] Nothing to move off you.");
	}
}

/*
 * .rocket -- Mech class ability: fire an explosive rocket at crosshair location.
 */
cmd_mech_rocket(id)
{
	// Only Mech class can use this
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] You have to be alive to fire a rocket.");
		return;
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0 || g_class_perk[ci] != TSM_PERK_MECH)
	{
		client_print(id, print_chat, "[TSM] Only the Mech class can fire rockets.");
		return;
	}

	// Check cooldown
	new Float:now = get_gametime();
	if (g_mech_rocket_next[id] > now)
	{
		client_print(id, print_chat, "[TSM] Rocket recharging -- ready in %.0fs", g_mech_rocket_next[id] - now);
		return;
	}

	// Check uses per life
	if (g_mech_rockets_used[id] >= TSM_MECH_ROCKET_MAX_USES)
	{
		client_print(id, print_chat, "[TSM] No rockets remaining this life (%d/%d used).", g_mech_rockets_used[id], TSM_MECH_ROCKET_MAX_USES);
		return;
	}

	// Get aim origin and direction
	new Float:origin[3], Float:angles[3], Float:dest[3];
	pev(id, pev_origin, origin);
	pev(id, pev_v_angle, angles);

	// Calculate destination from view angles (manual forward vector from angles)
	new Float:range = TSM_MECH_ROCKET_RANGE;
	new Float:fwd_x = floatcos(angles[1], degrees) * floatcos(angles[0], degrees);
	new Float:fwd_y = floatsin(angles[1], degrees) * floatcos(angles[0], degrees);
	new Float:fwd_z = -floatsin(angles[0], degrees);
	dest[0] = origin[0] + fwd_x * range;
	dest[1] = origin[1] + fwd_y * range;
	dest[2] = origin[2] + fwd_z * range;

	// Trace to find impact point
	new tr = 0;
	engfunc(EngFunc_TraceLine, origin, dest, DONT_IGNORE_MONSTERS, id, tr);
	new Float:frac;
	get_tr2(tr, TR_flFraction, frac);
	new Float:endpos[3];
	get_tr2(tr, TR_vecEndPos, endpos);

	// Draw white decaying beam trail
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_BEAMPOINTS);
	write_coord(floatround(origin[0]));
	write_coord(floatround(origin[1]));
	write_coord(floatround(origin[2]));
	write_coord(floatround(endpos[0]));
	write_coord(floatround(endpos[1]));
	write_coord(floatround(endpos[2]));
	write_short(g_obj_boom_spr); // sprite
	write_byte(0);   // startframe
	write_byte(1);   // framerate
	write_byte(10);  // life in 0.1s = 1 second
	write_byte(10);  // width
	write_byte(50);  // noise
	write_byte(255); // r
	write_byte(255); // g
	write_byte(255); // b
	write_byte(200); // brightness
	write_byte(0);   // speed
	message_end();

	// Explosion at impact point (visual)
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(endpos[0]));
	write_coord(floatround(endpos[1]));
	write_coord(floatround(endpos[2]));
	write_short(g_obj_boom_spr);
	write_byte(120);
	write_byte(255);
	write_byte(TE_EXPLFLAG_NONE);
	message_end();

	// REAL SPLASH DAMAGE using env_explosion entity (engine handles falloff, physics, sound)
	// This is how HL grenades work - the engine does proper radius damage with falloff
	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "env_explosion"));
	if (ent)
	{
		set_pev(ent, pev_origin, endpos);
		set_pev(ent, pev_dmg, floatround(TSM_MECH_ROCKET_DAMAGE_MAX)); // max damage at center
		set_pev(ent, pev_spawnflags, 1); // SF_ENVEXPLOSION_NOSPARKS | SF_ENVEXPLOSION_NOSMOKE | SF_ENVEXPLOSION_NODECAL
		set_pev(ent, pev_solid, SOLID_NOT);
		set_pev(ent, pev_movetype, MOVETYPE_NONE);
		set_pev(ent, pev_owner, id); // attribute damage to the mech
		dllfunc(DLLFunc_Spawn, ent);
		// Fire it immediately
		dllfunc(DLLFunc_Use, ent, id);
		// Remove after a short delay
		set_task(0.1, "remove_ent", ent);
	}
	else
	{
		// Fallback: manual radius damage with falloff
		rocket_radius_damage(id, endpos, TSM_MECH_ROCKET_RADIUS, float(random_num(floatround(TSM_MECH_ROCKET_DAMAGE_MIN), floatround(TSM_MECH_ROCKET_DAMAGE_MAX))));
	}

	// Sound - from the firing player
	emit_sound(id, CHAN_WEAPON, "weapons/rocketfire1.wav", 1.0, ATTN_NORM, 0, PITCH_NORM);

	// Update tracking
	g_mech_rockets_used[id]++;
	g_mech_rocket_next[id] = now + TSM_MECH_ROCKET_COOLDOWN;

	client_print(id, print_chat, "[TSM] Rocket fired! %d/%d used this life.", g_mech_rockets_used[id], TSM_MECH_ROCKET_MAX_USES);
	dbg("Mech %d fired rocket at (%.0f,%.0f,%.0f) -- dmg %.0f radius %.0f", id, endpos[0], endpos[1], endpos[2], float(random_num(floatround(TSM_MECH_ROCKET_DAMAGE_MIN), floatround(TSM_MECH_ROCKET_DAMAGE_MAX))), TSM_MECH_ROCKET_RADIUS);
}

/*
 * THE BLUE FLASH, one place.
 *
 * The point light both the Recon's cloak and the Officer's .scan announce themselves
 * with. TE_DLIGHT rather than a sprite-based effect: it is a point light with its own
 * radius, life and decay, needs no precached sprite, and the same
 * message_begin/SVC_TEMPENTITY pattern cmd_mech_rocket uses -- just a different byte
 * in it. Blue (100/180/255), because that is the plugin's cloak signature colour, and
 * the scan borrowing it is the whole point: "the Officer is reading" reads exactly
 * like "a Recon slipped away".
 *
 * Tuning, measured, not guessed -- radius*10=400u, decay*10=80u/s, life*0.1=1.8s: the
 * light is still ~64% of its radius when its own life timer ends it. The old values
 * (radius 80u, decay 200u/s, life 0.8s) collapsed to zero radius in 0.4s -- dead
 * before its own timer ran out at 0.8s -- which is the actual, measured reason the
 * flash read as "barely tell" rather than a vague brightness complaint.
 */
blue_flash(Float:org[3])
{
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_DLIGHT);
	write_coord(floatround(org[0]));
	write_coord(floatround(org[1]));
	write_coord(floatround(org[2]) + 36);   // roughly chest height, not at the feet
	write_byte(40);    // radius, in 10s of units -- a bigger burst, still body-scale
	write_byte(100);   // r
	write_byte(180);   // g
	write_byte(255);   // b
	write_byte(18);    // life, in 10ths of a second
	write_byte(8);     // decay rate
	message_end();
}

/*
 * Recon's cloak and uncloak, as one function: a blue TE_DLIGHT flash and a sound either way, then
 * the render state that makes a cloaked body a shimmer and an uncloaked one ordinary again.
 *
 * The flash is blue_flash() above; the sound is straight emit_sound. TE_DLIGHT rather
 * than a sprite-based effect: a point light needs no precached sprite.
 *
 * Called from cmd_cloak/cmd_uncloak on a deliberate toggle, and from fw_takedamage when a hit
 * forces an uncloak -- which is why this takes the end state rather than flipping it, and why it
 * is harmless to call with the state it is already in (cmd_cloak/cmd_uncloak refuse that before
 * ever reaching here, but a forced break cannot check "already uncloaked" first without an extra
 * flag, so set_cloak staying idempotent is what keeps that path simple).
 *
 * silent is for the match ending a cloak (fw_postthink_post): no sound and no flash, because
 * those are for a player choosing to end it, not the match choosing for him.
 */
set_cloak(id, bool:on, bool:silent = false)
{
	g_cloaked[id] = on;
	g_cloak_at[id] = get_gametime();

	/*
	 * The expiry timer is owned HERE, the one place on/off actually happens, so every route to
	 * turning the cloak off -- .uncloak, a hit landed or taken, the match benching the player --
	 * cancels it the same way. Without that a player who was hit at second 5 would still have a
	 * stale task fire at second 30 and call set_cloak(id, false) on a body that is not cloaked,
	 * which is harmless by itself but would flash and play the uncloak sound a second time out
	 * of nowhere.
	 */
	remove_task(id + 15000);
	if (on)
	{
		new Float:duration = get_pcvar_float(g_cv_cloakduration);
		if (duration > 0.0)
		{
			set_task(duration, "task_cloak_expire", id + 15000);
		}

		set_pev(id, pev_rendermode, TSM_RENDER_TEXTURE);
		set_pev(id, pev_renderamt, get_pcvar_float(g_cv_cloakopacity));
		set_pev(id, pev_renderfx, TSM_RENDERFX_NONE);
		set_pev(id, pev_rendercolor, CLOAK_COLOR);
	}
	else
	{
		set_pev(id, pev_rendermode, TSM_RENDER_NORMAL);
		set_pev(id, pev_renderamt, 255.0);
		set_pev(id, pev_renderfx, TSM_RENDERFX_NONE);

		// Black, so the blue signature never outlives the cloak -- and he is visible to RCBot again.
		new Float:nocolor[3];
		set_pev(id, pev_rendercolor, nocolor);
		cloak_bots_show(id);
	}

	dbgv("cloak: %d is now %s%s", id, on ? "cloaked" : "uncloaked", silent ? " (silently)" : "");

	if (silent)
	{
		return;
	}

	new Float:org[3];
	pev(id, pev_origin, org);

	// CHAN_AUTO for the reason in perk_sound: the chat line printed after it must not cut it off.
	emit_sound(id, CHAN_AUTO, on ? CLOAK_SND[random(2)] : UNCLOAK_SND[random(2)],
		VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	// The announcement light, from the one helper both the cloak and the scan share.
	blue_flash(org);
}

/// Cloak's own clock running out. Not reached if .uncloak, a hit, or the match itself already
/// turned it off -- set_cloak() cancels this task on every one of those before it can fire.
public task_cloak_expire(taskid)
{
	new id = taskid - 15000;
	if (!is_user_connected(id) || !g_cloaked[id])
	{
		return;
	}

	set_cloak(id, false);
	client_print(id, print_chat, "[TSM] Cloak expired.");
}

/// Is this player a Recon, right now, alive and connected? Shared by both chat commands.
bool:is_recon_for_cloak(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		return false;
	}
	new ci = resolved_class(id) - 1;
	return (ci >= 0 && g_class_perk[ci] == TSM_PERK_RECON);
}

public cmd_cloak(id)
{
	if (!get_pcvar_num(g_cv_cloak))
	{
		return;
	}
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] You have to be alive to cloak.");
		return;
	}
	if (!is_recon_for_cloak(id))
	{
		client_print(id, print_chat, "[TSM] Only the Recon class can cloak.");
		return;
	}
	if (g_cloaked[id])
	{
		client_print(id, print_chat, "[TSM] Already cloaked.");
		return;
	}

	/*
	 * Only in a live round, and only while actually in it. Anywhere else fw_postthink_post ends
	 * the cloak again on the very next frame, so a .cloak typed in the warmup or the freeze only
	 * burned the cooldown on a cloak that never existed.
	 */
	if (g_state != ST_LIVE || is_spectating(id) || g_elim[id] || g_locked_out[id] || g_frozen[id])
	{
		client_print(id, print_chat, "[TSM] You can only cloak while playing in a live round.");
		return;
	}

	/*
	 * g_cloak_at is set on every toggle, cloak or uncloak, so by the time we get here with
	 * g_cloaked[id] already false it holds the moment the LAST cloak ended -- exactly what a
	 * post-uncloak cooldown needs to measure against. Guarded on g_cloak_at[id] > 0.0 too: a
	 * player who has never cloaked still has it at its default 0.0, and without this a fresh
	 * spawn in the first tsm_cloak_cooldown seconds of the map would read as "on cooldown"
	 * against a cloak that never happened.
	 */
	new Float:cooldown = get_pcvar_float(g_cv_cloakcooldown);
	if (cooldown > 0.0 && g_cloak_at[id] > 0.0)
	{
		new Float:remaining = cooldown - (get_gametime() - g_cloak_at[id]);
		if (remaining > 0.0)
		{
			client_print(id, print_chat, "[TSM] Cloak recharging, %d more seconds.",
				floatround(remaining, floatround_ceil));
			return;
		}
	}

	set_cloak(id, true);
	client_print(id, print_chat, "[TSM] Cloaked. Taking or dealing damage breaks it.");
}

public cmd_uncloak(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		return;
	}
	if (!g_cloaked[id])
	{
		client_print(id, print_chat, "[TSM] Not cloaked.");
		return;
	}

	set_cloak(id, false);
	client_print(id, print_chat, "[TSM] Uncloaked.");
}

/*
 * .light -- forces the flashlight on or off regardless of the held weapon, by flipping
 * EF_DIMLIGHT directly rather than going through impulse 100, which TS's own weapon
 * code gates. See fw_postthink_post if this turns out not to survive a weapon switch --
 * TS "re-applies its own values... whenever it feels like it," the same reason the
 * cloak's render state has to be re-asserted there every frame.
 */
public cmd_light(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] You have to be alive to use your flashlight.");
		return;
	}
	if (g_state != ST_LIVE || is_spectating(id) || g_elim[id] || g_locked_out[id] || g_frozen[id])
	{
		client_print(id, print_chat, "[TSM] You can only toggle your flashlight while playing in a live round.");
		return;
	}

	g_flashlight[id] = !g_flashlight[id];
	set_pev(id, pev_effects, pev(id, pev_effects) ^ TSM_EF_DIMLIGHT);
	client_print(id, print_chat, "[TSM] Flashlight %s.", g_flashlight[id] ? "ON" : "off");
}

/*
 * .ammo -- +25 spare rounds to every gun the player carries, once per round.
 *
 * The carried-weapon list used to come from get_user_weapons, which walks the
 * pev->weapons BITS: every id fits a bit up to 31, but TS 3.0 ids run to 38 --
 * the M60E3 (32) overlays kung fu's bit 0, the katana (34) overlays the
 * beretta's bit 2 -- so M60 carriers were told "no guns", trying to hand a
 * knife carrier pistol rounds was possible, and nothing could name the guns
 * they actually held. This walks the gun ids directly instead, and the tsx
 * natives do the carrying checks: ts_setuserammo refuses what the player does
 * not carry outright, and for the grenade and the knives the same native would
 * write HOW MANY HE CARRIES rather than rounds, so is_gun_id keeps those ids
 * out.
 *
 * The write is absolute and read back: pass one reads every gun's baseline --
 * guns sharing a caliber share it, so one caliber gains exactly +25 however
 * many of its guns are carried -- pass two asks for baseline +25 and re-reads.
 * A caliber already at TS's cap clamps and reads back unchanged, so the
 * once-per-round fee below only clears when rounds actually landed, and the
 * report says what happened instead of claiming a resupply that was not.
 */
public cmd_ammo(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] You have to be alive to resupply.");
		return;
	}
	if (g_state != ST_LIVE || is_spectating(id) || g_elim[id] || g_locked_out[id] || g_frozen[id])
	{
		client_print(id, print_chat, "[TSM] You can only resupply while playing in a live round.");
		return;
	}
	if (g_ammo_used[id])
	{
		client_print(id, print_chat, "[TSM] You have already resupplied this round.");
		return;
	}

	// Pass 1: the baseline, read BEFORE any write. Shared calibers therefore
	// share one baseline, which is what keeps the +25 per-caliber once.
	new pre[39];
	for (new w = 1; w <= 38; w++)
	{
		if (!is_gun_id(w))
		{
			continue;
		}
		pre[w] = ts_getuserammo(id, w);
		if (pre[w] < 0)
		{
			pre[w] = 0;
		}
	}

	// Pass 2: baseline +25, then read back. A full caliber returns exactly what
	// it started with; an uncarried gun is refused and nothing moves.
	new rounds = 0, guns = 0, full = 0;
	for (new w = 1; w <= 38; w++)
	{
		if (!is_gun_id(w))
		{
			continue;
		}
		new ok = ts_setuserammo(id, w, pre[w] + 25);
		new after = ts_getuserammo(id, w);
		if (after > pre[w])
		{
			rounds += after - pre[w];
			guns++;
		}
		else if (ok)
		{
			full++;   // carried, wanted nothing: the caliber was already at its cap
		}
	}

	if (rounds > 0)
	{
		g_ammo_used[id] = true;

		// Same presentation as the Engineer resupplying a teammate -- yellow glow,
		// ammo sound -- just aimed at himself. perk_use() does the identical pair
		// of calls on "hit" (the resupplied teammate); here id is both giver and
		// target.
		glow_player(id, 255.0, 220.0, 0.0, get_pcvar_float(g_cv_engglow), get_pcvar_num(g_cv_engshell));
		perk_sound(id, g_cv_engsound);

		client_print(id, print_chat, "[TSM] Resupplied: +%d rounds on %d gun(s).", rounds, guns);
	}
	else if (full > 0)
	{
		client_print(id, print_chat, "[TSM] Your guns are already full.");
	}
	else
	{
		client_print(id, print_chat, "[TSM] No guns to resupply.");
	}

	dbg("ammo: %d got +%d rounds on %d gun(s), %d already full, once this round",
		id, rounds, guns, full);
}

/*
 * Removes an entity after a short delay (used for env_explosion cleanup).
 */
public remove_ent(taskid)
{
	if (pev_valid(taskid))
	{
		engfunc(EngFunc_RemoveEntity, taskid);
	}
}

/*
 * Manual radius damage with proper falloff (used if env_explosion creation fails).
 * Damage falls off linearly from center to edge of radius.
 */
stock rocket_radius_damage(attacker, Float:origin[3], Float:radius, Float:max_dmg)
{
	new players[32], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		new target = players[i];
		if (target == attacker) continue;
		if (g_match_team[target] == g_match_team[attacker]) continue; // no team damage
			
		new Float:targ_origin[3];
		pev(target, pev_origin, targ_origin);
		new Float:dist = vector_distance(origin, targ_origin);
		if (dist <= radius)
		{
			// Linear falloff: full damage at center, zero at edge
			new Float:falloff = 1.0 - (dist / radius);
			new Float:dmg = max_dmg * falloff;
			if (dmg > 0.0)
			{
				ExecuteHamB(Ham_TakeDamage, target, attacker, attacker, dmg, DMG_BLAST);
			}
		}
	}
}

/*
 * Tops ONE bot up with ammunition, once a second at most.
 *
 * Bots run dry and then keep pulling the trigger, because rcbot never sees the
 * weapons we hand out: the class loadout is written through TS's own buy commands
 * (tkw/tka) and applied by BuyArmament at spawn, so no pickup ever happens for
 * rcbot to observe. Its ammo tracking, its reload decision and its "switch to
 * something that still has rounds" decision are all working from an inventory it
 * does not have.
 *
 * Keeping them topped up sidesteps all three: a bot that never runs out never
 * needs to reload or switch. It does not make rcbot correct, it makes being wrong
 * cost nothing.
 *
 * ONE per tick, round-robin, because this creates a ts_groundammo entity per call
 * -- and spawning a batch of entities in one frame is what flooded clients with
 * SZ_GetSpace: overflow when the loadout used to be handed out that way.
 */
resupply_one_bot()
{
	new Float:every = get_pcvar_float(g_cv_botresup);
	if (every <= 0.0 || g_state != ST_LIVE || !get_pcvar_num(g_cv_bots))
	{
		return;
	}

	new players[32], pnum;
	get_players(players, pnum, g_pf);
	if (!pnum)
	{
		return;
	}

	new Float:now = get_gametime();

	// Starts where it left off, so every bot comes round in turn instead of the
	// first one in the list being topped up over and over.
	for (new n = 0; n < pnum; n++)
	{
		g_bot_resup_rr = (g_bot_resup_rr + 1) % pnum;
		new id = players[g_bot_resup_rr];

		if (!is_user_bot(id) || !is_user_alive(id) || g_elim[id])
		{
			continue;
		}
		if (g_match_team[id] != 1 && g_match_team[id] != 2)
		{
			continue;
		}
		if (g_bot_resup_at[id] > 0.0 && (now - g_bot_resup_at[id]) < every)
		{
			continue;
		}

		g_bot_resup_at[id] = now;
		top_up_reserve(id, get_pcvar_num(g_cv_engclips) * 25);
		dbgv("bot resupply: topped up %d", id);
		return;   // one per tick, deliberately
	}
}

/*
 * Refuses the respawn that would end a killed player's linger.
 *
 * TS is a deathmatch mod: it respawns a dead player almost immediately, and in
 * GoldSrc the corpse IS the player entity -- so the respawn does not leave a body
 * behind, it carries it off to the spawn point. That is what takes the body away,
 * not anything to do with visibility.
 *
 * SECOND LINE OF DEFENCE ONLY. Ham_Spawn is not delivered in this mod, so this is
 * never actually called; the respawn is stopped in fw_prethink instead, by clearing
 * the attack button TS waits on. This is kept registered because it costs nothing
 * and is the cleaner block of the two wherever the hook does arrive.
 */
public fw_player_spawn(id)
{
	if (!get_pcvar_num(g_cv_enabled) || g_state != ST_LIVE)
	{
		return HAM_IGNORED;
	}
	if (!g_elim[id] || g_elim_at[id] <= 0.0)
	{
		return HAM_IGNORED;   // not a death we are holding -- round starts included
	}

	if ((get_gametime() - g_elim_at[id]) < get_pcvar_float(g_cv_deathlinger))
	{
		dbgv("held %d dead: %.1fs of linger left", id,
			get_pcvar_float(g_cv_deathlinger) - (get_gametime() - g_elim_at[id]));
		return HAM_SUPERCEDE;
	}

	return HAM_IGNORED;
}

/*
 * A map's env_shake, felt by everyone in its reach. TS's UTIL_ScreenShake sends its ScreenShake
 * only to players standing on the ground, and never reads the shake's "in the air" flag: a
 * spectator following the play, or anyone in mid-jump, felt nothing as a train went by. The
 * people it passed over get the same message here: amplitude (pev_scale), duration
 * (pev_dmg_take) and frequency (pev_dmg_save) in the SDK's fixed point, as the siege's own
 * shake writes them, within the shake's radius (pev_dmg; 0 reaches everyone). Bots have no
 * screen to shake. Only where the match mode plays: elsewhere the map shakes as the game ships.
 */
public fw_shake_use(ent, caller, activator, use_type, Float:value)
{
	if (!get_pcvar_num(g_cv_enabled) || !g_shake_msg || !pev_valid(ent))
	{
		return HAM_IGNORED;
	}
	new Float:amp, Float:dur, Float:freq, Float:radius, Float:org[3];
	pev(ent, pev_scale, amp);
	pev(ent, pev_dmg_take, dur);
	pev(ent, pev_dmg_save, freq);
	pev(ent, pev_dmg, radius);
	pev(ent, pev_origin, org);
	if (amp <= 0.0 || dur <= 0.0)
	{
		return HAM_IGNORED;
	}
	new players[32], pnum, Float:at[3];
	get_players(players, pnum, "c");
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (pev(id, pev_flags) & FL_ONGROUND)
		{
			continue;   // TS's own pass reached him
		}
		if (radius > 0.0)
		{
			pev(id, pev_origin, at);
			if (get_distance_f(org, at) >= radius)
			{
				continue;
			}
		}
		message_begin(MSG_ONE, g_shake_msg, _, id);
		write_short(clamp(floatround(amp * 4096.0), 0, 65535));
		write_short(clamp(floatround(dur * 4096.0), 0, 65535));
		write_short(clamp(floatround(freq * 256.0), 0, 65535));
		message_end();
	}
	return HAM_IGNORED;
}

/*
 * Refuses the Use of a door the map has reserved for combat engineers.
 *
 * Every func_door in the map comes through here and all but the marked ones leave
 * again on the first test -- a door without the targetname is somebody else's door
 * and is not this plugin's business.
 *
 * The two entity arguments are the SDK's pActivator and pCaller in that order, which
 * is the order CBaseDoor::Use declares them; ham_const.inc labels them the other way
 * round. It makes no difference for a door opened by hand, because
 * CBasePlayer::PlayerUse passes the player as both -- but it is why both are looked
 * at rather than one.
 *
 * Nothing else in the map fires these doors, so a Use with no player behind it is
 * refused as well: the door opens for a combat engineer and for nothing else.
 */
public fw_door_use(ent, activator, caller, use_type, Float:value)
{
	/*
	 * FIRST LINE, BEFORE ANY TEST: this is how a human proves the hook is delivered.
	 *
	 * Set tsm_logging 1, walk up to a door, press +USE and look in the AMX log. A line
	 * here means Ham_Use reaches func_door in this mod. NO line means the hook is not
	 * delivered and the whole gate is dead code, which is exactly how two earlier Ham
	 * hooks in this plugin failed -- silently, with correct-looking logic that never
	 * ran. amx_tsm_debug prints the counters for the same question.
	 */
	new cls[32], name[32];
	cls[0] = 0;
	name[0] = 0;
	if (pev_valid(ent))
	{
		pev(ent, pev_classname, cls, charsmax(cls));
		pev(ent, pev_targetname, name, charsmax(name));
	}
	g_door_use_hits++;
	/*
	 * The first few only. Proving the hook fires takes one line; it does not take one for every
	 * door anybody opens for the rest of the map, which is what this was and which drowns the log
	 * the moment tsm_logging is turned on for some other reason. The counters above carry on
	 * regardless, and amx_tsm_debug prints them.
	 */
	if (g_door_use_hits <= 20)
	{
		tlog("[TSM] Ham_Use on ent %d class='%s' targetname='%s' activator=%d caller=%d  (hit %d)",
			ent, cls, name, activator, caller, g_door_use_hits);
	}

	// An admin's tsm_opendoor is forcing this door open, or the match mode is off: no gate of ours
	// applies.
	if (g_forcing_door || !get_pcvar_num(g_cv_enabled))
	{
		return HAM_IGNORED;
	}

	if (!is_eng_door(ent))
	{
		return HAM_IGNORED;
	}
	g_engdoor_use_hits++;

	new id = activator;
	if (id < 1 || id >= MAXPL || !is_user_connected(id))
	{
		id = caller;
	}
	if (id < 1 || id >= MAXPL || !is_user_connected(id))
	{
		dbgv("eng door %d used by entity %d/%d -- refused", ent, activator, caller);
		return HAM_SUPERCEDE;
	}

	new door_team = get_pcvar_num(g_cv_engdoorteam);
	if (is_engineer(id) && (door_team < 1 || g_match_team[id] == door_team))
	{
		dbg("eng door %d opened by %d", ent, id);
		return HAM_IGNORED;
	}
	if (is_engineer(id))
	{
		if (!is_user_bot(id) && (get_gametime() - g_engdoor_told_at[id]) > 2.0)
		{
			g_engdoor_told_at[id] = get_gametime();
			client_print(id, print_chat, "[MATCH] That door is the other side's to open.");
		}
		dbgv("eng door %d refused to %d: wrong side", ent, id);
		return HAM_SUPERCEDE;
	}

	/*
	 * Rate limited on gametime, the same way the friendly-fire warning is. A player
	 * who cannot get in will stand there pressing the key, and one line a second is
	 * an explanation where ten a second is a reason to leave.
	 */
	if (!is_user_bot(id) && (get_gametime() - g_engdoor_told_at[id]) > 2.0)
	{
		new want[32];
		get_pcvar_string(g_cv_engdoorclass, want, charsmax(want));
		g_engdoor_told_at[id] = get_gametime();
		client_print(id, print_chat, "[MATCH] That door answers to a %s and to nobody else.", want);
	}

	dbgv("eng door %d refused to %d", ent, id);
	return HAM_SUPERCEDE;
}

/*
 * Refuses damage between players on the same side.
 *
 * Decided on g_match_team rather than on TS's own view, because this plugin owns
 * team membership -- and on rcbot's side of the fence TS's teams are exactly what
 * cannot be relied on.
 *
 * SUPERCEDE, not a refund: the damage never lands, so there is no health to give
 * back, no armour lost, no hit sound and no pain animation. A refund after the
 * fact could never have worked for bots anyway.
 */
public fw_takedamage(victim, inflictor, attacker, Float:damage, damagebits)
{
	/*
	 * FIRST LINE, BEFORE ANY TEST: proves whether Ham_TakeDamage on "player" is actually
	 * delivered in this mod, the same way g_door_use_hits proves it for Ham_Use on
	 * func_door. The comment above g_door_use_hits records Ham_Spawn AND Ham_TakeDamage
	 * on "player" both once measured at zero hits in TS. Ham_Spawn is confirmed still
	 * dead today (see fw_player_spawn); nothing had re-confirmed Ham_TakeDamage was not
	 * also still dead. amx_tsm_debug prints this counter.
	 */
	g_player_dmg_hits++;

	// The match mode off: damage is the game's own.
	if (!get_pcvar_num(g_cv_enabled))
	{
		return HAM_IGNORED;
	}

	/*
	 * Stamped FIRST, ahead of every guard below.
	 *
	 * This records that the victim was hit, for the regeneration pause, and it has to
	 * happen before anything returns -- almost all damage is from an ENEMY, which the
	 * friendly-fire guards below let through on the very first test. Stamping after
	 * them would record only teammate damage, and a Heavy under fire would regenerate
	 * happily all the way through it.
	 *
	 * World damage and falls count too: the test is "has anything hurt you lately",
	 * not "has anybody shot you".
	 */
	if (victim > 0 && victim < MAXPL && damage > 0.0)
	{
		g_last_hit[victim] = get_gametime();

		// Recon's cloak: broken by taking any real damage, whoever or whatever it is from --
		// a bullet, a fall, the world. set_cloak is a no-op if he was not cloaked.
		if (g_cloaked[victim])
		{
			set_cloak(victim, false);
		}

		/*
		 * Machine hit sound -- a mech, or robo / droid / bot in the model name: on EVERY
		 * damaging hit.
		 *
		 * This was one ricochet per three seconds, and through a firefight that read
		 * as "the machine does not react to being shot". A hit now always speaks.
		 * The channel is FIXED rather than CHAN_AUTO on purpose: under sustained
		 * fire a new channel per bullet runs the entity's sound pool dry within a
		 * second, while one fixed channel makes each new hit REPLACE the previous
		 * clang -- the stutter of metal being hammered, which is what this is.
		 */
		if (machine_body(victim))
		{
			new hitname[24];
			copy(hitname, charsmax(hitname), g_mech_hit_snd[random(sizeof g_mech_hit_snd)]);
			emit_sound(victim, CHAN_ITEM, hitname, 1.0, ATTN_NORM, 0, PITCH_NORM);

			// The mech's pilot hears the through-the-armor clang on their own
			// client too -- the world copy above is everyone else's.
			if (!is_user_bot(victim))
			{
				client_cmd(victim, "playvol %s 0.9", hitname);
			}
		}

		// Mech class: 50% damage resistance
		new ci = resolved_class(victim) - 1;
		if (ci >= 0 && g_class_perk[ci] == TSM_PERK_MECH)
		{
			SetHamParamFloat(4, damage * 0.25);  // reduce damage by 75%
			damage *= 0.25;
		}
	}

	/*
	 * Recon's cloak, the other direction: hurting someone breaks the attacker's own cloak too,
	 * not only the victim's. Self-damage is excluded -- falling on your own satchel is not
	 * "attacking", and this stays out of the friendly-fire guards below on purpose: a shot that
	 * friendly fire later discards still broke the cloak, because the act of firing at somebody
	 * is what gave him away, whatever the game then does with the damage.
	 */
	if (attacker >= 1 && attacker < MAXPL && attacker != victim && damage > 0.0 && g_cloaked[attacker])
	{
		set_cloak(attacker, false);
	}

	/*
	 * Out of the round means out of the damage, both directions. TS puts an
	 * eliminated player back on his feet about ten seconds after death -- loadout
	 * and all -- so without this a respawned ghost went on hurting people until
	 * something else noticed, and a ghost could be hurt again in the gaps too.
	 */
	if (attacker >= 1 && attacker < MAXPL && g_elim[attacker])
	{
		dbgv("damage from eliminated %d on %d blocked", attacker, victim);
		return HAM_SUPERCEDE;
	}
	// Only once TS has actually finished with them -- a deadflag still mid-death
	// means TS's own TakeDamage may still have work to do finishing this same kill
	// (a trailing pellet, a second damage tick), and superceding that is what kept
	// the animation/corpse from ever completing. A confirmed ghost (deadflag back
	// to normal) still can't be hurt again, exactly as before.
	if (victim >= 1 && victim < MAXPL && g_elim[victim] && pev(victim, pev_deadflag) == TSM_DEAD_NO)
	{
		return HAM_SUPERCEDE;
	}

	/*
	 * NOBODY DIES TO A FALL WHILE THE MATCH IS HOLDING THEM: the bug the ground-slap sound
	 * gave away. TS lands respawns wherever its own info_player_start logic put them, and
	 * the held pre-round phase is exactly when a body is standing somewhere it did not
	 * choose -- a spawn point above a ledge, a respawn the spread just teleported below a
	 * high point, a pinned frame with an old fall velocity -- and TS's own landing code
	 * still hands back the fall damage. Where it used to cost nothing, the lives system
	 * now makes every such deck-landing a kill, so a squad died mid-warmup with the round
	 * not even started, players and rcbots alike.
	 *
	 * The test is the hold, not the warmup states alone: should_hold() is the same
	 * derived hold the freeze runs on every frame -- warmup and ready-up, the round-start
	 * freeze, spectators, locked-out idlers -- so a body that TS is about to land or was
	 * just landed under the hold is covered no matter which second of the pre-round the
	 * fall begins in. A round that is live (or a roaming admin) falls like it always did,
	 * TS's own verdict and all.
	 */
	if ((damagebits & (DMG_FALL | DMG_GENERIC)) == DMG_FALL
		&& victim >= 1 && victim < MAXPL
		&& should_hold(victim))
	{
		g_fall_refused++;
		dbgv("takedamage: fall of %d refused (held, state %d, %.0f)", victim, g_state, damage);
		return HAM_SUPERCEDE;
	}

	if (!get_pcvar_num(g_cv_enabled) || get_pcvar_num(g_cv_friendlyfire))
	{
		return HAM_IGNORED;
	}

	if (victim < 1 || victim >= MAXPL || attacker < 1 || attacker >= MAXPL)
	{
		return HAM_IGNORED;   // world damage, falls, map hazards
	}
	if (victim == attacker)
	{
		return HAM_IGNORED;   // self damage is their own business
	}

	new vt = g_match_team[victim];
	if (vt < 1 || vt != g_match_team[attacker])
	{
		return HAM_IGNORED;
	}

	// Only humans are told. A bot cannot read it, and ten bots bumping into each
	// other would otherwise bury the chat.
	if (!is_user_bot(attacker) && (get_gametime() - g_ff_told_at[attacker]) > 2.0)
	{
		g_ff_told_at[attacker] = get_gametime();
		client_print(attacker, print_chat, "[MATCH] Friendly fire is off -- that is a teammate.");
	}

	dbgv("friendly fire blocked: %d -> %d for %.0f", attacker, victim, damage);
	return HAM_SUPERCEDE;
}

/*
 * Shows a teammate's class and health when you look at them.
 *
 * Run four times a second rather than per frame: the trace is cheap but it is one
 * per living human, and a HUD message that refreshes faster than it is read is
 * just network traffic. The hold time is slightly longer than the interval so the
 * text does not blink between refreshes.
 *
 * Humans only -- a bot has no screen to put it on.
 */
public task_hover_info()
{
	if (!get_pcvar_num(g_cv_hoverinfo) || g_state != ST_LIVE)
	{
		return;
	}

	new Float:range = float(get_pcvar_num(g_cv_hoverrange));
	new players[32], pnum;
	get_players(players, pnum, g_pf);

	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (is_user_bot(id) || !is_user_alive(id) || g_elim[id])
		{
			continue;
		}

		new team = g_match_team[id];
		if (team != 1 && team != 2)
		{
			continue;
		}

		new Float:start[3], Float:vo[3], Float:ang[3], Float:fwd[3], Float:dest[3];
		pev(id, pev_origin, start);
		pev(id, pev_view_ofs, vo);
		start[0] += vo[0];
		start[1] += vo[1];
		start[2] += vo[2];

		pev(id, pev_v_angle, ang);
		engfunc(EngFunc_MakeVectors, ang);
		global_get(glb_v_forward, fwd);

		dest[0] = start[0] + fwd[0] * range;
		dest[1] = start[1] + fwd[1] * range;
		dest[2] = start[2] + fwd[2] * range;

		engfunc(EngFunc_TraceLine, start, dest, 0, id, 0);
		new hit = get_tr2(0, TR_pHit);

		if (hit < 1 || hit >= MAXPL || hit == id
			|| !is_user_connected(hit) || !is_user_alive(hit) || g_elim[hit])
		{
			continue;
		}
		if (g_match_team[hit] != team)
		{
			continue;   // only your own side
		}

		new cname[32];
		cname[0] = 0;
		if (g_class_count)
		{
			new ci = resolved_class(hit) - 1;
			if (ci >= 0 && ci < g_class_count)
			{
				copy(cname, charsmax(cname), g_class_name[ci]);
			}
		}
		if (!cname[0])
		{
			copy(cname, charsmax(cname), "No class");
		}

		new hname[32];
		get_user_name(hit, hname, charsmax(hname));

		// Channel 1. GoldSrc keeps four text slots and files a message in channel % 4,
		// so this is the slot the readout has always had on Steam, beside the round
		// timer; Xash keeps eight, and a channel above 4 there gets a slot of its own
		// that TS's client does not show.
		set_hudmessage(120, 220, 120, -1.0, 0.56, 0, 0.0, 0.4, 0.0, 0.0, 1);
		show_hudmessage(id, "%s^n%s^n%d HP", hname, cname, get_user_health(hit));
	}
}

/*
 * Writes every player's class model once, shortly after the round has gone live.
 *
 * The round-start write happens during the FREEZE, before TS has spawned anyone --
 * and TS re-applies its own mp_teammodels pick on spawn, so our model was being set
 * and then thrown away a moment later. The log shows the correct model written
 * ('reputengu' for the MSR Officer, 'repuheavy' for MSR Assault) while the player
 * still ends up wearing something else.
 *
 * A ONE-SHOT, not a timer. The periodic re-check this replaces is what made the model
 * visibly cycle every few seconds, because it traded writes with TS forever. One write
 * per player per round, placed after the spawn that would have undone it.
 */
public task_models_after_spawn()
{
	if (!get_pcvar_num(g_cv_classes))
	{
		return;
	}

	new players[32], pnum;
	get_players(players, pnum, g_pf);

	/*
	 * ONE PLAYER PER TICK, NOT ALL OF THEM ON ONE FRAME.
	 *
	 * Writing a model writes userinfo, and the server tells every client about every userinfo
	 * change -- so doing the whole server in this loop put one svc_updateuserinfo per player into
	 * a single packet. On a full server that is sixteen of them at about 160 bytes each, landing
	 * on top of whatever else that frame was already carrying, and the client's buffer does not
	 * stretch: it overflows and drops the connection with "Illegible server message - svc_bad".
	 *
	 * Spread out they cost exactly the same in total and nothing notices the difference, because
	 * this is a one-shot tidy-up after the spawn rather than anything a player is waiting on.
	 */
	new at = 0;
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!is_user_connected(id) || g_match_team[id] < 1)
		{
			continue;
		}
		remove_task(id + 13000);
		set_task(0.1 + 0.08 * float(at), "task_model_one", id + 13000);
		at++;
	}
}

/** One player's class model, re-asserted on its own frame. See task_models_after_spawn. */
public task_model_one(taskid)
{
	new id = taskid - 13000;
	if (!is_user_connected(id) || g_match_team[id] < 1)
	{
		return;
	}

	// Forget what we think we last wrote: TS has moved it since, and the cache
	// would otherwise decide there is nothing to do.
	g_model_last[id][0] = 0;

	new bool:was = g_in_userinfo[id];
	g_in_userinfo[id] = true;
	set_class_model(id, resolved_class(id) - 1);
	g_in_userinfo[id] = was;
}

/*
 * .roam -- walk the map freely, then go back to being held.
 *
 * Placing spawn points means walking to each position and running
 * amx_tsm_spawn_add there, which the warmup hold makes impossible: it clamps
 * maxspeed to 1 and you cannot leave the spot you spawned on. Doing it during a live
 * round instead means doing it while being shot at.
 *
 * So this lifts every hold for one player and hands them normal movement. Toggling it
 * again puts them back under whatever hold the current state calls for -- should_hold()
 * decides that fresh every frame, so there is no saved state to restore and no way for
 * the two to disagree.
 *
 * Deliberately NOT admin-gated in the same breath as the spawn commands: those already
 * require ADMIN_CFG, and a roaming player is frozen out of the match anyway.
 */
public cmd_roam_say(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return PLUGIN_CONTINUE;
	}
	cmd_roam(id);
	return PLUGIN_HANDLED;
}

cmd_roam(id)
{
	if (!is_user_connected(id))
	{
		return;
	}

	g_roaming[id] = !g_roaming[id];

	if (g_roaming[id])
	{
		/*
		 * Released immediately rather than waiting for the next frame to notice.
		 *
		 * release_player() undoes the maxspeed clamp and the frozen flag; without it
		 * the hold stays applied until something else happens to lift it, which during
		 * warmup is never.
		 */
		g_frozen[id] = false;
		release_player(id);
		set_pev(id, pev_movetype, TSM_MOVETYPE_WALK);
		set_pev(id, pev_solid, TSM_SOLID_SLIDEBOX);

		/*
		 * AND HIS HANDS BACK.
		 *
		 * Whatever hold he was under before this will have stripped him -- hold_player() disarms
		 * anyone out of a round -- so a roamer had nothing to shoot, nothing to open a door with
		 * and nothing to test the map with. Walking a map to place spawn points is most of the
		 * job; trying a doorway is the rest of it.
		 *
		 * Through the same task the class menu uses, because issue_armament() is defined further
		 * down the file and this compiler will not take a forward reference.
		 */
		set_task(0.1, "task_reissue_armament", id + 5000);

		client_print(id, print_chat, "[MATCH] Roaming. You are out of the match -- walk the map and place spawns.");
		client_print(id, print_chat, "[MATCH] amx_tsm_spawn_add 1 / 2 where you stand, then .roam again to go back.");
		dbg("roam: %d is now roaming", id);
	}
	else
	{
		/*
		 * The hold itself needs nothing restoring: should_hold() recomputes from the match state,
		 * so the next frame applies exactly the hold this state calls for. The WEAPONS do, though
		 * -- they were handed over for roaming and he is not entitled to them back in the match
		 * he is about to rejoin, so they go the same way they came.
		 */
		strip_user_weapons(id);
		client_print(id, print_chat, "[MATCH] Roaming off -- back to normal, and disarmed again.");
		dbg("roam: %d is back under match control", id);
	}
}

/// Is this player an Officer, right now, in a live round?
bool:is_officer(id)
{
	if (!g_class_count || !is_user_connected(id) || !is_user_alive(id))
	{
		return false;
	}
	if (g_state != ST_LIVE || g_elim[id])
	{
		return false;
	}

	return (g_class_perk[resolved_class(id) - 1] == TSM_PERK_OFFICER);
}

/*
 * THE OFFICER'S SCAN.
 *
 * .scan from chat: once per cooldown, everything cloaked and ENEMY inside a sphere
 * around the Officer is exposed -- to his ENTIRE side, not just to himself, and to that
 * side's bots as well (cloak_bots_hide stands down for a scanned body). The mark is a
 * blue glow shell, the medic's kRenderFxGlowShell, which TS's own client draws on every
 * engine, within line of sight.
 *
 * Written into fw_addtofullpack by way of three arrays per target (see the declaration
 * block); the per-viewer side of it is the whole point of the split. The sound comes
 * from tsm_scan_sound and plays FROM the Officer at ATTN_NORM, so the people standing
 * near him of BOTH sides hear that a scan went off.
 */
cmd_scan(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] You have to be alive to scan.");
		return;
	}

	// is_officer answers the live-round and alive halves itself, so the message can be
	// about the class alone and never about the clock.
	if (!is_officer(id))
	{
		client_print(id, print_chat, "[TSM] Only the Officer class can scan.");
		return;
	}

	new Float:now = get_gametime();
	new Float:cool = get_pcvar_float(g_cv_scancool);
	if (g_scan_next[id] > now)
	{
		client_print(id, print_center, "Scanner ready in %.0fs", g_scan_next[id] - now);
		return;
	}

	// Charged ON USE, like the cloak and the rocket: the clock below the reveal is
	// tsm_scan_cooldown minus tsm_scan_time, whatever the two cvars say relative to
	// each other. A conflict there is an operator's choice, not a plugin error.
	g_scan_next[id] = now + cool;

	new Float:radius = get_pcvar_float(g_cv_scanradius);
	new Float:until = now + get_pcvar_float(g_cv_scantime);
	new team = g_match_team[id];

	new Float:origin[3], Float:pos[3];
	pev(id, pev_origin, origin);

	new found = 0;
	for (new victim = 1; victim < MAXPL; victim++)
	{
		if (victim == id || !is_user_connected(victim) || !is_user_alive(victim)
			|| !g_match_team[victim] || g_match_team[victim] == team
			|| !g_cloaked[victim] || !cloak_active(victim))
		{
			continue;
		}

		pev(victim, pev_origin, pos);
		new Float:dx = pos[0] - origin[0];
		new Float:dy = pos[1] - origin[1];
		new Float:dz = pos[2] - origin[2];
		if (dx*dx + dy*dy + dz*dz > radius*radius)
		{
			continue;
		}

		// A second scan by the other side overwrites the first mark: one mark per
		// target, whoever last covered him.
		g_scan_until[victim] = until;
		g_scan_team[victim] = team;
		found++;
	}

	// The ping, on the cvar -- empty until supplied, and then only if the file is there.
	perk_sound(id, g_cv_scansound);

	// And the visual the Recon's cloak announces with: the same blue point light,
	// same tuned burst, from the one helper both effects share -- seen by anyone
	// nearby, of BOTH sides. The scan should read as something happening, not as
	// a quiet chat line.
	blue_flash(origin);

	new name[32];
	get_user_name(id, name, charsmax(name));
	for (new mate = 1; mate < MAXPL; mate++)
	{
		// Bots and eliminated players among the team receive nothing they cannot use;
		// client_print to an unconnected slot is guarded by the test above.
		if (is_user_connected(mate) && g_match_team[mate] == team)
		{
			if (found)
			{
				client_print(mate, print_chat, "[SCAN] %s's survey: %d cloaked enemy(ies) exposed for %.0f seconds.",
					name, found, get_pcvar_float(g_cv_scantime));
			}
			else
			{
				client_print(mate, print_chat, "[SCAN] %s's survey: nothing cloaked within %.0f units.",
					name, get_pcvar_float(g_cv_scanradius));
			}
		}
	}

	dbg("scan: officer %d revealed %d cloaked target(s) for %.0fs", id, found, get_pcvar_float(g_cv_scantime));
}

/// Returns true if this body walks as a mech (mech_msr / mech_ins model).
///
/// The pev_model STRING is not the picture. TS force-writes the userinfo "model"
/// key back to its own mp_teammodels pick, so the string can say a soldier while
/// fw_postthink_post is drawing a mech through pev_modelindex every frame -- and
/// reading the string alone is what kept every mech gate (steps, hum, hp watch,
/// the nodraw) shut on a player who was visibly a mech. The name we actually
/// selected for the body lives in g_model_chosen; test that first, and keep the
/// string test under it for any path where we did not pick the model ourselves.
bool:wears_mech(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		return false;
	}
	if (containi(g_model_chosen[id], "mech_msr") != -1 || containi(g_model_chosen[id], "mech_ins") != -1)
	{
		return true;
	}
	new model[64];
	pev(id, pev_model, model, charsmax(model));
	if (containi(model, "mech_msr") != -1 || containi(model, "mech_ins") != -1)
	{
		return true;
	}
	return false;
}

/*
 * A mech's stunts, heard: the hydraulic surge the frame a stunt begins (TS's stunt bits in pev_iuser4, set
 * for humans and bots alike -- the module's client_stunt forward is never raised), and the stomp the frame
 * it is back on the ground, if the stunt took it off the ground at all. A stunt still going after four
 * seconds without leaving the ground ends quietly. Played in the world and on the pilot's own client, as
 * the mech's footsteps are.
 */
mech_stunt_sounds(id)
{
	if (!wears_mech(id))
	{
		g_mech_stunt[id] = 0;
		return;
	}
	new bits = pev(id, pev_iuser4);
	new bool:ground = (pev(id, pev_flags) & FL_ONGROUND) != 0;
	new Float:now = get_gametime();

	if (!g_mech_stunt[id])
	{
		if (bits & TSM_STUNT_BITS)
		{
			g_mech_stunt[id] = ground ? 1 : 2;
			g_mech_stunt_at[id] = now;
			emit_sound(id, CHAN_AUTO, MECH_LEAP, 1.0, ATTN_NORM, 0, PITCH_NORM);
			if (!is_user_bot(id))
			{
				client_cmd(id, "playvol %s 0.6", MECH_LEAP);
			}
		}
		return;
	}

	if (!ground)
	{
		g_mech_stunt[id] = 2;
		return;
	}
	if (g_mech_stunt[id] == 2)
	{
		g_mech_stunt[id] = 0;
		emit_sound(id, CHAN_AUTO, MECH_LAND, 1.0, ATTN_NORM, 0, 92);
		emit_sound(id, CHAN_AUTO, MECH_LAND2, 0.8, ATTN_NORM, 0, PITCH_NORM);
		if (!is_user_bot(id))
		{
			client_cmd(id, "playvol %s 0.7", MECH_LAND);
		}
		return;
	}
	if (!(bits & TSM_STUNT_BITS) || now - g_mech_stunt_at[id] > 4.0)
	{
		g_mech_stunt[id] = 0;
	}
}

/// True for a model name a machine wears: robo, droid or bot anywhere in it, in any case.
/// The mech models (mech_msr_bot, mech_ins_bot) carry "bot", so every mech is a machine too.
stock bool:machine_name(const name[])
{
	return (containi(name, "robo") >= 0 || containi(name, "droid") >= 0 || containi(name, "bot") >= 0);
}

/// A body that is a machine: its userinfo model or its class pick names one, or it walks as a
/// mech. Both strings are read because either one alone can miss a body (see set_class_model),
/// and neither is alive-gated, so the answer holds on a hit and on the death frame alike.
bool:machine_body(id)
{
	if (id < 1 || id > g_maxplayers || !is_user_connected(id))
	{
		return false;
	}
	new mdl[48];
	get_user_info(id, "model", mdl, charsmax(mdl));
	return (machine_name(mdl) || machine_name(g_model_chosen[id]) || wears_mech(id));
}

/// What the engine calls a footstep: pm_shared picks these by the floor texture
/// (pl_step default, then pl_dirt, pl_metal, pl_grate, pl_tile, pl_duct, ...),
/// all under the player/pl_ prefix. The prefix also covers a handful of sounds
/// that are NOT steps, and those are turned away by name.
stock bool:is_footstep(const sample[])
{
	if (!equali(sample, "player/pl_", 9))
	{
		return false;
	}
	new const g_not_steps[][] = {
		"pain", "die", "drown", "swim", "wade", "water", "ladder", "breathe", "fall"
	};
	for (new i = 0; i < sizeof g_not_steps; i++)
	{
		if (containi(sample, g_not_steps[i]) != -1)
		{
			return false;
		}
	}
	return true;
}

/// Intercept footstep sounds: any player/pl_* event from a living mech walker
/// is superceded with mechwalk / mechwalk2, alternating, so the stock step is
/// never heard. Moved here from the old mech_footsteps plugin. A cloaked Recon's
/// own footstep is superceded too, with nothing played at all -- the one thing
/// the shimmer alone can't hide is the sound of him walking -- and so is every
/// footstep of an eliminated player, whom TS has put back on their feet.
public fw_emit_sound(id, channel, const sample[], Float:volume, Float:attenuation, flags, pitch)
{
	if (id < 1 || id > get_maxplayers())
	{
		return FMRES_IGNORED;            // a world sound, not a walker
	}
	if (!is_user_alive(id) || !is_footstep(sample))
	{
		return FMRES_IGNORED;
	}

	if (g_cloaked[id] || g_elim[id])
	{
		return FMRES_SUPERCEDE;          // cloaked or eliminated: no footstep sound at all, nothing emitted
	}

	if (!wears_mech(id))
	{
		return FMRES_IGNORED;
	}

	emit_sound(id, channel, g_next[id] == 0 ? MECH_STEP_1 : MECH_STEP_2,
		volume, attenuation, flags, pitch);
	g_next[id] = (g_next[id] + 1) % 2;
	return FMRES_SUPERCEDE;              // the stock step is never heard
}



/// Every MECH_LOOP_PERIOD, hand the hum to everyone standing in range of a living
/// mech. CHAN_STATIC so a weapon or voice from the same walker does not cut it;
/// each pass replaces the last one on that channel, which is what makes the loop
/// continuous. An eliminated mech is skipped: TS puts it back on its feet, but it
/// is out of the round, and death_voice() has already stopped its hum.
public task_mech_loop()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!is_user_alive(id) || !wears_mech(id) || g_elim[id])
		{
			continue;
		}
		tlog("[TSM DEBUG] mechloop emit for %d", id);
		emit_sound(id, CHAN_STATIC, MECH_LOOP, MECH_LOOP_VOL, MECH_LOOP_ATTEN, 0, PITCH_NORM);

		// The pilot's own certainty copy: neighbouring players hear the emit above,
		// the walk machine's own ears are served here, on their own client, where
		// no server entity channel can fight them for it.
		if (!is_user_bot(id))
		{
			client_cmd(id, "playvol %s %f", MECH_LOOP, MECH_LOOP_PILOT_VOL);
		}
	}
}

/// spawnflags bit 30 on a ts_powerup: the patched mp.dll arms its Touch at Spawn. See tsm_grant_powerup.
#define TSM_PWUP_GRANT_SF    1073741824

/*
 * Gives a player a TS powerup at once, through TS's own pickup: the grant a powerup on the floor
 * makes when it is walked over (mp.dll RVA 0x6fcc0), so every type does what TS makes it do --
 * kung fu sets the player's flag and the PwUp icon, armor and health top up, a slow-motion type
 * is carried until used.
 *
 * It takes the patched mp.dll (decompile_dll\mp_patched_slots_pwup.dll.patch). TS leaves a new
 * powerup's Touch empty until its first think finds nopowerup off and the powerup on the floor,
 * so with nopowerup 1 nothing can be handed over -- ts_createpwup builds a powerup that never
 * appears, and ts_givepwup touches one that is not armed. The patch arms Touch at Spawn, but only
 * for a powerup carrying TSM_PWUP_GRANT_SF while tsm_enabled is on, so nopowerup 1 still blocks
 * every other powerup, and every powerup on a server without this mode.
 *
 * The powerup is spawned and touched in one frame, and TS's Touch removes it. True when TS took
 * it; false when it refused (a dead player, or a carried slow-motion type only +use swaps) or the
 * DLL is not the patched one. Nothing is left behind either way.
 */
bool:tsm_grant_powerup(id, type, duration = 60)
{
	if (!get_pcvar_num(g_cv_enabled) || !is_user_alive(id))
	{
		return false;
	}

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "ts_powerup"));
	if (!pev_valid(ent))
	{
		return false;
	}

	new num[12];
	num_to_str(type, num, charsmax(num));
	kv_set(ent, "ts_powerup", "pwuptype", num);
	num_to_str(duration, num, charsmax(num));
	kv_set(ent, "ts_powerup", "pwupduration", num);

	new Float:org[3];
	pev(id, pev_origin, org);
	set_pev(ent, pev_origin, org);
	set_pev(ent, pev_spawnflags, pev(ent, pev_spawnflags) | TSM_PWUP_GRANT_SF);
	dllfunc(DLLFunc_Spawn, ent);
	dllfunc(DLLFunc_Touch, ent, id);

	// TS's Touch removes a powerup it handed over (FL_KILLME, freed at the end of the frame).
	if (pev_valid(ent) && !(pev(ent, pev_flags) & FL_KILLME))
	{
		engfunc(EngFunc_RemoveEntity, ent);
		return false;
	}
	return true;
}

/*
 * The Officer's automatic powerup, granted as the round goes live.
 *
 * The kung-fu powerup is handed to him through TS's own pickup (tsm_grant_powerup) -- not
 * bought, so weaponrestriction has no say in it. Until now the Officer's whole perk was the two
 * chat orders, which are invisible unless you already know they are there.
 */
officer_powerup(id)
{
	if (!g_class_count || !is_user_connected(id) || !is_user_alive(id))
	{
		return;
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0 || g_class_perk[ci] != TSM_PERK_OFFICER)
	{
		return;
	}

	if (tsm_grant_powerup(id, TSPWUP_KUNGFU))
	{
		dbgv("officer %d given the kung-fu powerup", id);
	}
	else
	{
		tlog("[TSM] Officer %d: kung fu was not given -- TS refused it, or ts/dlls/mp.dll is not the patched build.", id);
	}

	// Read it back HALF A SECOND LATER, from TS's own flag: a spawn after the grant clears
	// it. One log line per round per officer settles "kung fu does nothing" reports from the
	// log instead of another reload.
	remove_task(id + 12000);
	set_task(0.5, "task_officer_check", id + 12000);
}

/*
 * Half-second-after readback of the officer's kung-fu grant (see officer_powerup), from the
 * player's own kung fu flag. ts_getuserpwup never holds kung fu: tsx files it as an item.
 */
public task_officer_check(taskid)
{
	new id = taskid - 12000;
	if (!is_user_connected(id) || !is_user_alive(id) || !g_class_count)
	{
		return;
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0 || g_class_perk[ci] != TSM_PERK_OFFICER)
	{
		return;
	}

	if (ts_has_fupowerup(id))
	{
		tlog("[TSM] Officer %d: kung-fu powerup is running.", id);
	}
	else
	{
		tlog("[TSM] Officer %d: kung-fu powerup did NOT stick.", id);
	}
}

/*
 * Is this player a combat engineer, right now, in a live round?
 *
 * By NAME, case insensitively, against tsm_eng_door_class. The perk would be the
 * shorter test and it is the wrong one: perk 1 is the resupply, and a second class
 * given that perk would quietly inherit the doors with it. The doors belong to one
 * named class.
 */
bool:is_engineer(id)
{
	if (!g_class_count || !is_user_connected(id) || !is_user_alive(id))
	{
		return false;
	}
	if (g_state != ST_LIVE || g_elim[id] || g_locked_out[id])
	{
		return false;
	}

	new want[32];
	get_pcvar_string(g_cv_engdoorclass, want, charsmax(want));
	if (!want[0])
	{
		return false;
	}

	return (equali(g_class_name[resolved_class(id) - 1], want) != 0);
}

/* ---- siege objectives ------------------------------------------------------
 *
 * A map's objectives are brush entities named tsm_obj_1, tsm_obj_2 ... up to
 * tsm_obj_9, and they fall in that order, the next one only. Every round starts
 * the chain over at objective 1.
 *
 * Make them func_wall (or anything a player cannot use by himself: a func_button
 * would fire for whoever walks up and presses it, and the plugin would never see
 * it). Taking one is holding +USE on it for tsm_obj_time seconds, as the attacking
 * side (tsm_obj_team) and the class named in tsm_obj_class. Anyone else is told
 * why not -- that is what stops a defender handing his own objective over.
 *
 * When one falls, the plugin fires the objective's own "target" (the map's
 * explosion, sparks, alarm, the wall that opens the way to the next) and the round
 * goes on. The LAST one also gives the round to the attackers and, with
 * tsm_obj_slay 1, kills everyone left alive. At every round start it fires
 * tsm_obj_<n>_reset for each one that fell, for the map to put back what its
 * explosion took away, and rebuilds each destroyed body from the load-time cache.
 */
/*
 * TSM_OBJ_PREFIX and TSM_OBJ_MAX live with the early constants, up by the
 * task ids, because the map recorder at load runs before this file's siege
 * section and needs them there.
 */
#define TSM_TASK_OBJ   15000

/*
 * THE BREACH DAMAGE. One piece of HL DMG_BLAST (1<<6) through the mod's own
 * TakeDamage: beyond armour, and every breakable dies to a plain explosive
 * hit. 1500 is past any sensible breakable health, so the E charge is always
 * fatal wherever the body can be hurt at all.
 */
#define TSM_DMG_BLAST    64
#define TSM_OBJ_BREAKDMG 1500.0

/*
 * The round-start team banner tasks (one per side). Sits above the TSM_TASK_OBJ
 * band (player indices ride 15000+1..32) with room to spare, so the two can
 * never share an id.
 */
#define TSM_TASK_OBJMSG 15100

/*
 * HOW the banner reads:
 *
 *   Y    0.43 -- mid-screen, in the one band no other display uses. Every
 *               set_hudmessage in this plugin already claims 0.03, 0.18, 0.20,
 *               0.22, 0.28, 0.32, 0.36, 0.56 and 0.72, so the vertical gap
 *               between the sudden-death flash (0.36) and the crosshair hover
 *               readout (0.56) belongs to the banner alone; the engine's own
 *               centreprint ("Breached.", the charge counter) draws at 0.5 and
 *               only at other moments.
 *   HOLD 5.0  -- shown from one second after the round starts, gone again at
 *               the sixth, deliberately ahead of the LIVE flash at go-live so
 *               a banner never outlives the freeze it was launched from.
 *
 * Both banners ride CHANNEL 3, whose only other uses are the warmup readout,
 * the round-end score card and the spectator readout -- none of which draw
 * during a freeze countdown, so the banner owns the channel outright for those
 * seconds. The two teams never share a client, so one channel is enough: each
 * player is sent exactly one of the two messages.
 */
#define TSM_OBJMSG_Y    0.43
#define TSM_OBJMSG_HOLD 5.0

new g_obj_taken = 0;               // how many have fallen this match, counting from 1
new g_obj_holding[MAXPL];          // the objective a player is holding +USE on, 0 for none
new Float:g_obj_started[MAXPL];    // when he began
new Float:g_obj_told_at[MAXPL];    // rate limit on the refusals

/// The objective's number, 1..9, or 0 when this entity is none.
siege_number(ent)
{
	if (ent < 1 || !pev_valid(ent))
	{
		return 0;
	}
	new name[32];
	name[0] = 0;
	pev(ent, pev_targetname, name, charsmax(name));
	// exactly "tsm_obj_" and one digit: tsm_obj_1_reset and the like are the map's own relays
	if (strlen(name) != 9 || !equal(name, TSM_OBJ_PREFIX, 8) || name[8] < '1' || name[8] > '9')
	{
		return 0;
	}
	return name[8] - '0';
}

/*
 * How many objectives the map has: tsm_obj_1 and on, up to the first slot that was
 * neither recorded at map load, nor has fallen this round, nor stands right now (the
 * debug suite's synthetic ones live only in the world).
 *
 * The world alone is not enough: a fallen objective's body is deleted, so counting
 * only what stands would put the end of the chain right behind the first fall.
 */
siege_count()
{
	new name[16], n = 0;
	for (new i = 1; i <= TSM_OBJ_MAX; i++)
	{
		if (!g_obj_class[i][0] && i > g_obj_taken)
		{
			formatex(name, charsmax(name), "%s%d", TSM_OBJ_PREFIX, i);
			if (engfunc(EngFunc_FindEntityByString, -1, "targetname", name) <= 0)
			{
				break;
			}
		}
		n = i;
	}
	return n;
}

/// The objective under this player's crosshair and within tsm_obj_range, or 0.
siege_aimed(id)
{
	new Float:start[3], Float:vo[3], Float:ang[3], Float:fwd[3], Float:dest[3];
	pev(id, pev_origin, start);
	pev(id, pev_view_ofs, vo);
	start[0] += vo[0];
	start[1] += vo[1];
	start[2] += vo[2];

	pev(id, pev_v_angle, ang);
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);

	new Float:range = float(get_pcvar_num(g_cv_objrange));
	dest[0] = start[0] + fwd[0] * range;
	dest[1] = start[1] + fwd[1] * range;
	dest[2] = start[2] + fwd[2] * range;

	engfunc(EngFunc_TraceLine, start, dest, 0, id, 0);
	new hit = get_tr2(0, TR_pHit);
	if (hit < MAXPL || !siege_number(hit))
	{
		return 0;
	}
	return hit;
}

/// May this player take objective n now? With tell, a refusal says why (rate limited).
bool:siege_allowed(id, n, bool:tell)
{
	if (g_state != ST_LIVE || !is_user_alive(id) || g_elim[id] || g_locked_out[id])
	{
		return false;
	}

	new why[96];
	why[0] = 0;
	new team = get_pcvar_num(g_cv_objteam);
	new want[32];
	get_pcvar_string(g_cv_objclass, want, charsmax(want));

	if (g_match_team[id] != team)
	{
		copy(why, charsmax(why), "That is yours to defend.");
	}
	else if (want[0] && (!g_class_count || !equali(g_class_name[resolved_class(id) - 1], want)))
	{
		formatex(why, charsmax(why), "Only a %s can set the charge.", want);
	}
	else if (n <= g_obj_taken)
	{
		copy(why, charsmax(why), "That one is already destroyed.");
	}
	else if (n > g_obj_taken + 1)
	{
		formatex(why, charsmax(why), "Objective %d has to fall first.", g_obj_taken + 1);
	}

	if (!why[0])
	{
		return true;
	}
	if (tell && !is_user_bot(id) && (get_gametime() - g_obj_told_at[id]) > 2.0)
	{
		g_obj_told_at[id] = get_gametime();
		client_print(id, print_center, "%s", why);
	}
	return false;
}

/*
 * +USE was pressed. True when the crosshair is on an objective -- taken in hand or
 * refused -- so that the class's own perk does not also run on the same press.
 */
bool:siege_use(id)
{
	new ent = siege_aimed(id);
	if (!ent)
	{
		return false;
	}
	new n = siege_number(ent);
	if (!siege_allowed(id, n, true))
	{
		return true;
	}

	/*
	 * A SATCHEL, NOT A SNAP. Nobody takes an objective with a single press of
	 * E, and PLANTING is the class gate's verb alone -- with this server's
	 * tsm_obj_class that is the Breacher and nobody else (other classes only
	 * ever take a breakable body, by gunfire). The allowed planter holds the
	 * full plant here, the fuse runs on its own, and the CHARGE's explosion
	 * is what destroys the body. While an objective is on its fuse, the
	 * planted state is exactly these three globals: every later press on it
	 * lands here and is told where things stand.
	 */
	if (g_plant_n == n)
	{
		client_print(id, print_center, "The satchel is already planted.");
		return true;
	}

	g_obj_holding[id] = ent;
	g_plant_last[id] = -10.0;   // a new hold: the plant sound plays on its first tick
	g_obj_started[id] = get_gametime();
	remove_task(id + TSM_TASK_OBJ);
	set_task(0.1, "task_siege_hold", id + TSM_TASK_OBJ, "", 0, "b");

	// The hold is one of the alarm's two triggers: a round's first one turns
	// the siren on, and every later one changes nothing at all.
	alarm_start(id);
	dbg("siege: %d began on objective %d (ent %d)", id, n, ent);
	return true;
}

/*
 * THE PLANTING BAR: the planter's own loading read at screen centre -- a text
 * bar of equals marks that fills across the plant's seconds, refreshed by the
 * hold tick so the row visibly grows while they hold. The colour is the
 * planting side's own, the same two colours the round banners use, and the
 * bar only ever exists on ONE screen -- the planter's own.
 */
plant_bar(id, Float:need, Float:held)
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

	if (get_pcvar_num(g_cv_objteam) == 1)
	{
		set_hudmessage(0, 170, 255, -1.0, TSM_PLANT_Y, 0, 0.0, 0.25, 0.05, 1.0, 3);
	}
	else
	{
		set_hudmessage(255, 70, 60, -1.0, TSM_PLANT_Y, 0, 0.0, 0.25, 0.05, 1.0, 3);
	}
	show_hudmessage(id, "PLANTING THE SATCHEL^n[%s]", bar);
}

/// Every tenth of a second while +USE is held on an objective.
public task_siege_hold(taskid)
{
	new id = taskid - TSM_TASK_OBJ;
	new ent = g_obj_holding[id];
	new n = siege_number(ent);

	if (!is_user_connected(id) || !n || !(pev(id, pev_button) & IN_USE)
		|| siege_aimed(id) != ent || !siege_allowed(id, n, false))
	{
		remove_task(taskid);
		g_obj_holding[id] = 0;
		g_plant_last[id] = 0.0;   // the sound clock was this hold's alone
		if (is_user_connected(id) && g_state == ST_LIVE)
		{
			client_print(id, print_center, "Charge not set.");
		}
		return;
	}

	new Float:need = get_pcvar_float(g_cv_objtime);
	new Float:held = get_gametime() - g_obj_started[id];
	if (held < need)
	{
		/*
		 * THE PLANT'S OWN SOUND AND READ. The satchel-planting sound rings once,
		 * as the hold starts, from the objective's spot (spatial: the closer you
		 * stand, the louder) -- and not again while that objective's last play is
		 * still sounding, so a release and a quick re-press cannot restart it.
		 * The planter reads their progress bar growing for the whole hold.
		 */
		if (g_plant_last[id] < 0.0)
		{
			g_plant_last[id] = held;
			new Float:pnow = get_gametime();
			if (pnow - g_plant_snd_at[n] >= g_plant_len)
			{
				emit_sound(ent, CHAN_BODY, TSM_PLANT_WAV, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
				g_plant_snd_at[n] = pnow;
			}
		}
		plant_bar(id, need, held);
		return;
	}

	/*
	 * THE SATCHEL IS IN. The objective is NOT destroyed here -- the code that
	 * fell it at this instant is gone. Everything that makes the plant real
	 * lives in siege_plant_now, directly below: the planted state, the
	 * success sound, the story in chat and the fuse's arm. The siege debug
	 * suite's force-plant command (amx_tsm_siege_plant) calls that same one,
	 * so a drilled test of the flow is the REAL path, not a copy of it.
	 */
	remove_task(taskid);
	siege_plant_now(id, ent, n);
}

/*
 * THE PLANT ITSELF, the shared line the hold's own completion and the
 * debug suite both run: the planted state (one satchel owns the chain --
 * siege_use refuses any other hold while these three are set), the SUCCESS
 * sound from the objective's spot, the story all sides read, and
 * tsm_obj_fuse's fuse armed on its one server-wide task.
 */
siege_plant_now(id, ent, n)
{
	if (g_plant_n)
	{
		return;   // one satchel at a time; belt for the natural path's braces
	}

	new who[32];
	get_user_name(id, who, charsmax(who));

	g_obj_holding[id] = 0;
	g_plant_last[id] = 0.0;   // the sound clock was that hold's, and it is done
	g_plant_ent = ent;
	g_plant_n = n;
	g_plant_by = id;

	// THE SUCCESS SOUND: the server's own plant.wav rings from the
	// objective's spot, on the same channel the hold loop was using -- so
	// the last hold clack melds into it instead of ringing underneath it.
	emit_sound(ent, CHAN_BODY, TSM_PLANT_DONE, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	all_print("[MATCH] %s planted the satchel on objective %d.", who, n);
	client_print(id, print_center, "The satchel is set -- get clear.");
	dbg("siege: %d planted objective %d (ent %d), %0.1f s fuse", id, n, ent, get_pcvar_float(g_cv_objfuse));
	set_task(get_pcvar_float(g_cv_objfuse), "task_charge_fuse", TSM_TASK_CHARGE);
}

/// Objective n falls, taken by this player.
siege_fall(id, ent, n)
{
	g_obj_taken = n;

	// No one else's hold carries on past a fall: the chain has moved on.
	for (new i = 1; i < MAXPL; i++)
	{
		if (g_obj_holding[i])
		{
			remove_task(i + TSM_TASK_OBJ);
			g_obj_holding[i] = 0;
		}
	}

	// The map's own explosion: whatever the objective targets.
	new tgt[64];
	tgt[0] = 0;
	pev(ent, pev_target, tgt, charsmax(tgt));
	if (tgt[0])
	{
		siege_fire(tgt, id);
	}

	new who[32];
	get_user_name(id, who, charsmax(who));
	new count = siege_count();
	if (n >= count)
	{
		all_print("[MATCH] %s destroyed the last siege objective (%d of %d).", who, n, count);
	}
	else
	{
		all_print("[MATCH] %s destroyed objective %d of %d.", who, n, count);
	}
	dbg("siege: objective %d fell to %d", n, id);

	// Only the last objective ends the round. An earlier one has blown and the
	// round goes on: the attackers move to the next in the chain, and the round
	// gets its time and its lives back. The time goes first, so that a clock that
	// lifts sudden death lets the lives return under the ordinary wave rules.
	if (n >= count)
	{
		end_round(get_pcvar_num(g_cv_objteam));
	}
	else
	{
		if (get_pcvar_num(g_cv_siegetime))
		{
			siege_reward_time();
		}
		if (get_pcvar_num(g_cv_siegelives) && reward_lives(0) >= 0)
		{
			all_print("[MATCH] Lives restored on both sides -- the fallen return with the next wave.");
		}
	}

	/*
	 * THE BOOM, on every fall. Three of HL1's stock explosions layered at once,
	 * world-wide (emit to 0 = everyone, ATTN_NONE so it never fades with distance),
	 * on separate channels and spread pitches so the stack reads as ONE huge blast.
	 * The last fall also ends the round, below; the boom and the shake are the same.
	 */
	emit_sound(0, CHAN_WEAPON, TSM_OBJ_BOOM_A, VOL_NORM, ATTN_NONE, 0, PITCH_NORM);
	emit_sound(0, CHAN_BODY, TSM_OBJ_BOOM_B, VOL_NORM, ATTN_NONE, 0, 110);
	emit_sound(0, CHAN_ITEM, TSM_OBJ_BOOM_C, VOL_NORM, ATTN_NONE, 0, 88);

	/*
	 * EVERY FALL SHAKES THE GROUND -- FOR AS LONG AS THE BOOMS RING. Each stock
	 * boom's own seconds are measured at precache, so the shake is cut to the
	 * stack's combined window: never shorter than any one of the three sounds it
	 * carries, and never under three seconds whatever the files measure. The raw
	 * ScreenShake message, in the HLSDK's own encoding -- amplitude and duration
	 * at 12.4 fixed point (wire value = degrees x 4096 and seconds x 4096),
	 * frequency at 8.8 (ticks a second x 256): exactly the three shorts the SDK's
	 * UTIL_ScreenShake writes. Eight degrees swung at 25 ticks a second, broadcast,
	 * so every player rides out the blast wherever they stand.
	 */
	new Float:bang = g_boom_len[0];
	if (g_boom_len[1] > bang)
	{
		bang = g_boom_len[1];
	}
	if (g_boom_len[2] > bang)
	{
		bang = g_boom_len[2];
	}
	if (bang < 1.0)
	{
		bang = 3.0;
	}
	message_begin(MSG_BROADCAST, g_shake_msg);
	write_short(8 << 12);                    // amplitude, degrees of swing
	write_short(floatround(bang * 4096.0));  // duration, outlasting every boom
	write_short(25 << 8);                    // frequency, shakes a second
	message_end();

	// After end_round: deaths outside a live round are not eliminations, so nobody
	// is counted out of the next one for being caught in the blast. The last
	// objective only, like the round end.
	if (n >= count && get_pcvar_num(g_cv_objslay))
	{
		set_task(0.5, "task_siege_slay", TSM_TASK_OBJ);
	}
}

/*
 * A fall short of the last puts time back on the round clock: toward a full tsm_roundtime,
 * by at most tsm_addtime seconds, and never past the round time itself.
 *
 * What is left is measured from g_round_ends rather than g_round_left, which only counts
 * down while the clock is drawn. Both move together with the timeout task, so the clock on
 * screen and the round's real end stay in step.
 *
 * A clock back above the tsm_sudden_death mark lifts sudden death for everyone: the
 * markers, the x-ray, the bog and the health drain all go with g_sudden, and the wave clock
 * respawn_sudden_cut stopped runs again. It comes back, announced as ever, when the clock
 * reaches the mark a second time.
 */
siege_reward_time()
{
	new rt = get_pcvar_num(g_cv_roundtime);
	new add = get_pcvar_num(g_cv_addtime);
	if (g_state != ST_LIVE || rt <= 0 || add <= 0)
	{
		return;
	}

	new Float:now = get_gametime();
	new left = floatround(g_round_ends - now, floatround_ceil);
	if (left < 0)
	{
		left = 0;
	}
	new target = left + add;
	if (target > rt)
	{
		target = rt;
	}
	if (target <= left)
	{
		return;
	}

	g_round_left = target;
	g_round_ends = now + float(target);
	remove_task(2);
	set_task(float(target), "task_round_timeout", 2);

	new gain = target - left;
	if (g_sudden && target > get_pcvar_num(g_cv_sudden))
	{
		g_sudden = false;
		sudden_fog(false);
		if (get_pcvar_num(g_cv_respawns) && !task_exists(TSM_TASK_WAVE))
		{
			set_task(1.0, "task_wave_tick", TSM_TASK_WAVE, "", 0, "b");
		}
		tlog("[TSM] Sudden death lifted: an objective fell with %d seconds left, %d on the clock now.", left, target);
		all_print("[MATCH] +%d:%02d on the clock -- sudden death is lifted.", gain / 60, gain % 60);
	}
	else
	{
		all_print("[MATCH] +%d:%02d on the clock.", gain / 60, gain % 60);
	}
	dbg("siege: clock %d -> %d seconds (+%d)", left, target, gain);
}

/*
 * Lives back, as a new round would give them, in the round still being played: for one side
 * (1 or 2) or both (0). A siege fall short of the last asks for both; an uplink capture asks
 * for the capturing side or both (tsm_reward_lives). Every count is SET to the class's own
 * (lives_for), never added to, so a full count stays as it is. Anyone eliminated -- out of
 * lives or already waiting -- waits for their side's next wave.
 *
 * The same players start_wave_clocks gives lives to at go-live, less anyone sitting the
 * match out. Without waves (tsm_respawns 0, or sudden death with tsm_respawn_sudden 0) no
 * wave would ever take them and a waiting player holds the round open, so nothing changes
 * and the answer is -1. Otherwise the answer is how many eliminated players were put back in
 * line. Silent: each caller says what happened in its own words.
 */
reward_lives(side)
{
	if (g_state != ST_LIVE || !get_pcvar_num(g_cv_respawns))
	{
		return -1;
	}
	if (g_sudden && !get_pcvar_num(g_cv_respsudden))
	{
		return -1;
	}

	new back = 0;
	new players[32], pnum, id, team;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		team = g_match_team[id];
		if ((team != 1 && team != 2) || g_locked_out[id] || (side && team != side))
		{
			continue;
		}

		g_lives_left[id] = lives_for(id);
		if (g_elim[id])
		{
			g_revive_pending[id] = true;
			g_revive_refused[id] = 0;
			back++;
		}
	}

	// Everyone just queued needs a wave clock running to be taken by.
	if (!task_exists(TSM_TASK_WAVE))
	{
		set_task(1.0, "task_wave_tick", TSM_TASK_WAVE, "", 0, "b");
	}

	dbg("lives restored for side %d (0 = both), %d eliminated waiting for the next wave", side, back);
	return back;
}

public task_siege_slay()
{
	new players[32], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		user_kill(players[i], 1);
	}
}

/*
 * === THE SATCHEL'S FUSE ====================================================
 *
 * tsm_obj_fuse seconds after a plant, this is the charge going off:
 *
 *   - the TE_EXPLOSION sprite lights up at the body's own spot, from its
 *     cubic centre (brush entities carry their corners, not a middle, so the
 *     centre is computed from pev_absmin/abssmax);
 *   - UNLESS this is the chain's last objective -- the round-end stack in
 *     siege_fall is the wide broadcast of the same blast, and one local copy
 *     underneath it would only double the same explosion;
 *   - then the fall goes through siege_fall() as always: the credit stays
 *     with the PLANTER, the map's own target relay fires, and on the last
 *     objective this is also the round end, the finale stack and the shake;
 *   - and only after the fall is the body explicitly finished off: one piece
 *     of breach damage (with fw_obj_killed already satisfied by the fall, so
 *     no double-book), and if the body refuses damage outright -- a plain
 *     brush that is nobody's breakable -- it is pulled from the world.
 *
 * Nothing of the planted state survives the function: the next take of the
 * chain is free to plant again the moment this returns.
 */
public task_charge_fuse()
{
	/*
	 * The fuse fires into whatever is actually standing by: the planted body
	 * may have been destroyed by an attacking hand in the meantime (its fall
	 * was then taken in fw_obj_killed and the chain has moved), the round may
	 * be over, or the match itself may have been halted. Whatever the reason,
	 * the planted state -- if there is one left -- releases here.
	 */
	if (!g_plant_ent || !pev_valid(g_plant_ent) || g_plant_n != g_obj_taken + 1
		|| g_state != ST_LIVE)
	{
		g_plant_ent = 0;
		g_plant_n = 0;
		g_plant_by = 0;
		return;
	}

	new ent = g_plant_ent;
	new n = g_plant_n;
	new by = g_plant_by;
	new last = (n >= siege_count());

	// The planted state hands its burden over before any spectacle: nothing
	// under this fires can re-enter these three, whatever the world does.
	g_plant_ent = 0;
	g_plant_n = 0;
	g_plant_by = 0;

	new Float:mn[3], Float:mx[3], Float:mid[3];
	pev(ent, pev_absmin, mn);
	pev(ent, pev_absmax, mx);
	mid[0] = (mn[0] + mx[0]) * 0.5;
	mid[1] = (mn[1] + mx[1]) * 0.5;
	mid[2] = (mn[2] + mx[2]) * 0.5;

	// THE EXPLOSION ITSELF: HL's own sprite decoded at the matter's centre.
	// GoldSrc's TE_EXPLOSION packet is coord x3, sprite index, scale byte in
	// tenths, framerate byte, flags byte.
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(mid[0]));
	write_coord(floatround(mid[1]));
	write_coord(floatround(mid[2]));
	write_short(g_obj_boom_spr);
	write_byte(120);   // scale in tenths -- a full-size blast
	write_byte(255);
	write_byte(TE_EXPLFLAG_NONE);
	message_end();

	// The STOCK BOOM, spatial at the body -- intermediate falls keep their
	// local blast; the last one's wide stack rides just below.
	if (!last)
	{
		emit_sound(ent, CHAN_WEAPON, TSM_OBJ_BOOM_A, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	}

	siege_fall(by, ent, n);

	// THE BODY'S LAST WORD: after the fall's bookkeeping, dealt its breach
	// damage so a breakable breaks with its own gib, and removed outright
	// when it was never going to break at all.
	if (pev_valid(ent))
	{
		ExecuteHamB(Ham_TakeDamage, ent, by, by, TSM_OBJ_BREAKDMG, TSM_DMG_BLAST);
		if (pev_valid(ent))
		{
			engfunc(EngFunc_RemoveEntity, ent);
		}
	}
}

/*
 * === THE DESTRUCTIBLE OBJECTIVE ============================================
 *
 * A tsm_obj_N does not have to be an indestructible brush. If an objective's
 * body is (or is like) a FUNC_BREAKABLE -- anything that can take damage and
 * die -- three things change, on purpose:
 *
 *   - Players of the DEFENDING side, and players of no side at all, cannot
 *     even CHIP it: their damage is cut to nothing before the mod applies
 *     it, so their gate always stands whole for the attackers to breach.
 *   - When the body DIES to an ATTACKING player, the objective falls then
 *     and there, whatever dealt the wound -- gunfire, a grenade, or the
 *     Breacher's own charge. The round-credit has one source of truth: the
 *     body died to an attacking hand.
 *   - Every take is a SATCHEL, and whose hand sets it is the CLASS GATE'S
 *     call (tsm_obj_class): this server hands planting to the Breacher
 *     alone -- hold +USE for the plant (tsm_obj_time), the fuse burns
 *     (tsm_obj_fuse), and the explosion is what destroys the body. No other
 *     class plants; every OTHER route to destruction needs a body that can
 *     actually break. The Breacher's one press is reserved for doors.
 *
 * Destruction obeys the SAME "fall in order" rule as the held charge: only
 * the next objective ever falls, and a body destroyed ahead of its turn
 * earns nothing (siege_reset rebuilds it from cache next round).
 * ==========================================================================
 */

/*
 * THE OLD ONE-PRESS BREACH IS GONE. Planting is the class gate's verb -- with
 * this server's tsm_obj_class, the Breacher ALONE: they hold the plant
 * (task_siege_hold), then the fuse (task_charge_fuse above) is what falls the
 * objective and destroys the body. Every other class's only route to a fall
 * is a body that can break, by their own gunfire. Nothing destroys an
 * objective on a single press of E any more; the Breacher's instant press is
 * reserved for the breach DOORS, where it always was breach_entity.
 */

/*
 * The defenders' rule, at the wound level: damage a player of the defending
 * side -- or of no side at all -- lands on an objective is reduced to zero
 * before the mod applies it. Attacking-side players are left fully armed:
 * their gunfire and grenades count as the breach, and a body that takes no
 * damage anyway (a plain brush) is untouched either way, because the mod
 * itself refuses to hurt it.
 */
public fw_obj_dmg(ent, inflictor, attacker, Float:damage, damagebits)
{
	// A sentry turret keeps its own health (turret_damage): CBreakable never sees the wound.
	new t = turret_slot(ent);
	if (t >= 0)
	{
		turret_damage(t, attacker, damage);
		return HAM_SUPERCEDE;
	}
	if (!siege_number(ent))
	{
		return HAM_IGNORED;
	}
	if (attacker < 1 || attacker >= MAXPL)
	{
		return HAM_IGNORED;   // world or non-player source: not attributable, untouched
	}
	if (g_match_team[attacker] == get_pcvar_num(g_cv_objteam))
	{
		return HAM_IGNORED;   // the attackers may wound it freely
	}
	SetHamParamFloat(4, 0.0);
	return HAM_IGNORED;
}

/*
 * The body DIED: the objective is achieved, when the destroyer is an
 * attacking player. Every fall in the round still has to come in order --
 * the body of an objective blown ahead of its turn is refused, the shooter
 * is told the same thing the hold mechanic tells them, and the fall stays
 * with whoever comes to it in turn. A fall nobody can be named for (the
 * world, a mapper hazard, a defender shelling their own gate) is refused:
 * no side can hand the round over by breaking what the other side guards.
 */
public fw_obj_killed(victim, attacker, gib)
{
	if (g_state != ST_LIVE)
	{
		return HAM_IGNORED;
	}
	new n = siege_number(victim);
	if (!n || n <= g_obj_taken)
	{
		// No objective at all here, or one already accounted for -- the
		// planted satchel's detonation books its fall first and calls this
		// hook as the body breaks: nothing to do the second time.
		return HAM_IGNORED;
	}
	if (n > g_obj_taken + 1)
	{
		if (attacker >= 1 && attacker < MAXPL && !is_user_bot(attacker)
			&& g_match_team[attacker] == get_pcvar_num(g_cv_objteam)
			&& (get_gametime() - g_obj_told_at[attacker]) > 2.0)
		{
			g_obj_told_at[attacker] = get_gametime();
			client_print(attacker, print_center, "Objective %d has to fall first.", g_obj_taken + 1);
		}
		return HAM_IGNORED;
	}
	if (attacker < 1 || attacker >= MAXPL
		|| g_match_team[attacker] != get_pcvar_num(g_cv_objteam))
	{
		dbg("siege: objective %d died to entity %d, not attacker-side work -- no fall", n, attacker);
		return HAM_IGNORED;
	}

	dbg("siege: objective %d fell by body destruction (attacker %d)", n, attacker);
	siege_fall(attacker, victim, n);
	return HAM_IGNORED;
}

/*
 * Spawns back every objective body that is missing from the world, from the cache
 * recorded at map load. The chain starts over at every round, so every body comes back.
 *
 * Origin, angles and render settings are set BEFORE the Spawn, as the map's own
 * entity lump would have set them, so the body's Spawn places and draws it the same.
 */
siege_rebuild_bodies()
{
	new name[16], hstr[16];
	for (new n = 1; n <= TSM_OBJ_MAX; n++)
	{
		if (!g_obj_model[n][0])
		{
			continue;
		}
		formatex(name, charsmax(name), "%s%d", TSM_OBJ_PREFIX, n);
		if (engfunc(EngFunc_FindEntityByString, -1, "targetname", name) > 0)
		{
			continue;   // still whole: nothing to bring back
		}
		new body = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, g_obj_class[n]));
		if (body <= 0)
		{
			continue;
		}
		kv_set(body, g_obj_class[n], "model", g_obj_model[n]);
		kv_set(body, g_obj_class[n], "targetname", name);
		if (g_obj_target[n][0])
		{
			kv_set(body, g_obj_class[n], "target", g_obj_target[n]);
		}
		formatex(hstr, charsmax(hstr), "%f", g_obj_health[n]);
		kv_set(body, g_obj_class[n], "health", hstr);
		set_pev(body, pev_spawnflags, g_obj_spawnflags[n]);
		set_pev(body, pev_origin, g_obj_origin[n]);
		set_pev(body, pev_angles, g_obj_angles[n]);
		set_pev(body, pev_rendermode, g_obj_rendermode[n]);
		set_pev(body, pev_renderamt, g_obj_renderamt[n]);
		set_pev(body, pev_rendercolor, g_obj_rendercolor[n]);
		set_pev(body, pev_renderfx, g_obj_renderfx[n]);
		dllfunc(DLLFunc_Spawn, body);
		dbg("siege: objective %d rebuilt from cache (#%d)", n, body);
	}
}

/// Uses everything with this targetname.
siege_fire(const name[], activator)
{
	new e = -1;
	for (new guard = 0; guard < 64; guard++)
	{
		e = engfunc(EngFunc_FindEntityByString, e, "targetname", name);
		if (e <= 0)
		{
			break;
		}
		dllfunc(DLLFunc_Use, e, activator, activator, 2, 0.0);   // 2 = USE_TOGGLE
	}
}

/// Puts back what fell: tsm_obj_<n>_reset for each, last first. Called at every round start and wherever a match is reset.
siege_reset()
{
	new name[24];
	for (new n = g_obj_taken; n >= 1; n--)
	{
		formatex(name, charsmax(name), "%s%d_reset", TSM_OBJ_PREFIX, n);
		siege_fire(name, 0);
	}
	if (g_obj_taken)
	{
		dbg("siege: %d objective(s) put back", g_obj_taken);
	}
	g_obj_taken = 0;
	for (new i = 1; i < MAXPL; i++)
	{
		remove_task(i + TSM_TASK_OBJ);
		g_obj_holding[i] = 0;
	}

	/*
	 * THE BODIES THE LAST MATCH DESTROYED, BACK AGAIN.
	 *
	 * The relays above cannot reach the objective entity itself: a breakable
	 * that died is deleted, and no relay hits thin air. siege_rebuild_bodies
	 * spawns every missing one back from the cache recorded at map load, and
	 * the whole chain starts over.
	 */
	siege_rebuild_bodies();
}

/*
 * === THE SIEGE DEBUG SUITE ==================================================
 *
 * Six admin commands that exercise every stage of the satchel flow on their
 * own and, when you want, WITHOUT ANY tsm_obj entities in the map at all:
 *
 *   amx_tsm_siege          -- the whole state, printed
 *   amx_tsm_siege_spawn    -- a synthetic objective where you look
 *   amx_tsm_siege_plant    -- force-complete a plant, the exact real path
 *   amx_tsm_siege_fuse     -- set that charge off now
 *   amx_tsm_siege_alarm    -- the raid siren, forced on
 *   amx_tsm_siege_reset    -- fuse + alarm killed, synthetics taken back out,
 *                             every cached body rebuilt, the chain at zero
 *
 * The chronology rules stay honest in debug: the fuse only detonates in a
 * live round and only on the NEXT objective of the chain -- walk the chain
 * forward with amx_tsm_obj <n> (or take earlier objectives properly) and the
 * suite fires the finale exactly as a full run of the map would.
 */
siege_line(id, const fmt[], any:...)
{
	new line[256];
	vformat(line, charsmax(line), fmt, 3);
	if (id == 0)
	{
		server_print("[TSM] %s", line);
	}
	else
	{
		console_print(id, "[TSM] %s", line);
	}
}

/// The objective's entity by number, or 0 when none stands: a map brush or
/// one of the suite's synthetics alike, both are just a standing targetname.
siege_by_number(n)
{
	new name[16];
	formatex(name, charsmax(name), "%s%d", TSM_OBJ_PREFIX, n);
	return engfunc(EngFunc_FindEntityByString, -1, "targetname", name);
}

/// WHOLE-STATE DUMP: chain, planted fuse, holds, alarm, gate, measured sounds.
public cmd_siege(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new stc[16];
	switch (g_state)
	{
		case ST_WARMUP:   copy(stc, charsmax(stc), "warmup");
		case ST_READYUP:  copy(stc, charsmax(stc), "ready-up");
		case ST_FREEZE:   copy(stc, charsmax(stc), "freeze");
		case ST_LIVE:     copy(stc, charsmax(stc), "live");
		case ST_ROUNDEND: copy(stc, charsmax(stc), "round end");
		case ST_MATCHEND: copy(stc, charsmax(stc), "match end");
		default:          copy(stc, charsmax(stc), "?");
	}
	siege_line(id, "siege dump ----------------------------------");
	siege_line(id, "state: %d (%s)", g_state, stc);
	siege_line(id, "chain: %d objective(s) live, %d fallen, next due %d",
		siege_count(), g_obj_taken, g_obj_taken + 1);

	if (g_plant_n && pev_valid(g_plant_ent))
	{
		new who[32];
		who[0] = 0;
		if (g_plant_by >= 1 && g_plant_by < MAXPL)
		{
			get_user_name(g_plant_by, who, charsmax(who));
		}
		siege_line(id, "planted: objective %d (ent %d, by %s), fuse %.1f s, task %s",
			g_plant_n, g_plant_ent, who, get_pcvar_float(g_cv_objfuse),
			task_exists(TSM_TASK_CHARGE) ? "running" : "MISSING");
	}
	else if (g_plant_n)
	{
		siege_line(id, "planted: stale state on objective %d over a dead body -- the fuse releases on its own", g_plant_n);
	}
	else
	{
		siege_line(id, "planted: nothing");
	}

	new held = 0;
	for (new i = 1; i < MAXPL; i++)
	{
		if (g_obj_holding[i] && is_user_connected(i))
		{
			new who[32];
			get_user_name(i, who, charsmax(who));
			siege_line(id, "holding: %d is on objective %d (%s)",
				i, siege_number(g_obj_holding[i]), who);
			held++;
		}
	}
	if (!held)
	{
		siege_line(id, "holding: nobody");
	}

	siege_line(id, "alarm: %s (side %d, siren %.2f s a loop, vol %.2f)",
		g_alarm_on ? "ON" : "off", g_alarm_side, g_alarm_len,
		get_pcvar_float(g_cv_alarmvol));

	new cls[32];
	get_pcvar_string(g_cv_objclass, cls, charsmax(cls));
	siege_line(id, "gate: team %d as %s, plant %.1f s, fuse %.1f s",
		get_pcvar_num(g_cv_objteam), cls,
		get_pcvar_float(g_cv_objtime), get_pcvar_float(g_cv_objfuse));
	siege_line(id, "sounds: hold %.2f s, success %.2f s, booms %.2f/%.2f/%.2f s, sprite %d",
		g_plant_len, g_plant_done_len, g_boom_len[0], g_boom_len[1], g_boom_len[2],
		g_obj_boom_spr);
	return PLUGIN_HANDLED;
}

/// SPAWN: a synthetic objective where the admin looks. No tsm_obj entity (or
/// none left standing) is fine -- this is how the satchel flow can be played
/// out on ANY map at all.
/*
 * WHERE AM I, exactly, and what am I looking at.
 *
 * Describing a place in a map in words does not work. "The middle of this hallway" and "the stairs
 * near the centre of town" have each cost several rounds of rebuilding the wrong thing, because a
 * screenshot carries no coordinates and a map has several staircases that look alike.
 *
 * So this prints the numbers: where the feet are, where the eyes are, which way they point, how far
 * the floor is, and -- most usefully when something is not behaving -- the entity under the
 * crosshair with its classname and its targetname. An objective that will not plant or a door that
 * will not open can be identified from here rather than guessed at.
 *
 * Printed to the console AND to chat: the console copy can be scrolled back and pasted, the chat
 * copy can be read without leaving the spot.
 */
public cmd_loc(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!is_user_connected(id))
	{
		return PLUGIN_HANDLED;
	}

	new Float:org[3], Float:vo[3], Float:ang[3];
	pev(id, pev_origin, org);
	pev(id, pev_view_ofs, vo);
	pev(id, pev_v_angle, ang);

	new Float:eye[3];
	eye[0] = org[0] + vo[0];
	eye[1] = org[1] + vo[1];
	eye[2] = org[2] + vo[2];

	console_print(id, "[TSM] origin   %d %d %d   (feet; the .map coordinate)",
		floatround(org[0]), floatround(org[1]), floatround(org[2]));
	console_print(id, "[TSM] eyes     %d %d %d   angles  pitch %d  yaw %d",
		floatround(eye[0]), floatround(eye[1]), floatround(eye[2]),
		floatround(ang[0]), floatround(ang[1]));
	client_print(id, print_chat, "[MATCH] you are at %d %d %d (yaw %d)",
		floatround(org[0]), floatround(org[1]), floatround(org[2]), floatround(ang[1]));

	// how far the floor is, straight down, so a height can be read without jumping about
	new Float:down[3];
	down[0] = org[0];
	down[1] = org[1];
	down[2] = org[2] - 4096.0;
	engfunc(EngFunc_TraceLine, org, down, 1, id, 0);
	new Float:floorpos[3];
	get_tr2(0, TR_vecEndPos, floorpos);
	console_print(id, "[TSM] floor    z %d, which is %d below you",
		floatround(floorpos[2]), floatround(org[2] - floorpos[2]));

	/*
	 * And what is under the crosshair. 4096 rather than a perk's reach: this is for finding out
	 * what a thing IS, not for deciding whether it can be used from here.
	 */
	new Float:fwd[3], Float:dest[3];
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);
	dest[0] = eye[0] + fwd[0] * 4096.0;
	dest[1] = eye[1] + fwd[1] * 4096.0;
	dest[2] = eye[2] + fwd[2] * 4096.0;
	engfunc(EngFunc_TraceLine, eye, dest, 0, id, 0);

	new hit = get_tr2(0, TR_pHit);
	new Float:at[3];
	get_tr2(0, TR_vecEndPos, at);
	console_print(id, "[TSM] aiming at %d %d %d", floatround(at[0]), floatround(at[1]), floatround(at[2]));

	if (hit > 0 && pev_valid(hit))
	{
		new cls[32], tname[32], gname[32];
		cls[0] = 0; tname[0] = 0; gname[0] = 0;
		pev(hit, pev_classname, cls, charsmax(cls));
		pev(hit, pev_targetname, tname, charsmax(tname));
		pev(hit, pev_target, gname, charsmax(gname));
		console_print(id, "[TSM] that is ent %d  class='%s'  targetname='%s'  target='%s'",
			hit, cls, tname[0] ? tname : "(none)", gname[0] ? gname : "(none)");
		if (tname[0])
		{
			client_print(id, print_chat, "[MATCH] looking at %s '%s'", cls, tname);
		}
	}
	else
	{
		console_print(id, "[TSM] that is world geometry, not an entity");
	}

	return PLUGIN_HANDLED;
}

public cmd_siege_spawn(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	// The number: given, or the first slot with nothing standing under it.
	new a[8], n = 0;
	if (read_argc() > 1)
	{
		read_argv(1, a, charsmax(a));
		n = str_to_num(a);
		if (n < 1 || n > TSM_OBJ_MAX)
		{
			siege_line(id, "Number 1 to %d, please.", TSM_OBJ_MAX);
			return PLUGIN_HANDLED;
		}
		if (siege_by_number(n) > 0)
		{
			siege_line(id, "tsm_obj_%d already stands -- take the next slot.", n);
			return PLUGIN_HANDLED;
		}
	}
	if (!n)
	{
		for (n = 1; n <= TSM_OBJ_MAX; n++)
		{
			if (siege_by_number(n) <= 0)
			{
				break;
			}
		}
		if (n > TSM_OBJ_MAX)
		{
			siege_line(id, "All nine slots stand -- amx_tsm_siege_reset first.");
			return PLUGIN_HANDLED;
		}
	}

	// WHERE it stands: the end of the admin's line of sight, 256 units down
	// the pipe, so the box lands wherever they can see.
	new Float:start[3], Float:vo[3], Float:ang[3], Float:dest[3];
	pev(id, pev_origin, start);
	pev(id, pev_view_ofs, vo);
	start[0] += vo[0];
	start[1] += vo[1];
	start[2] += vo[2];
	pev(id, pev_v_angle, ang);
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, vo);
	dest[0] = start[0] + vo[0] * 256.0;
	dest[1] = start[1] + vo[1] * 256.0;
	dest[2] = start[2] + vo[2] * 256.0;
	engfunc(EngFunc_TraceLine, start, dest, 0, id, 0);
	get_tr2(0, TR_vecEndPos, dest);
	dest[2] += 0.5;   // sit on the surface, never sink into it

	// THE BODY: a model-less SOLID_BBOX point entity -- invisible bar its
	// light aura, but siege_use's line of sight hits it like a real brush,
	// the plant sound rings spatially at its origin, and the charge's
	// RemoveEntity fallback can delete it, which is a whole flow in a grain.
	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (ent <= 0)
	{
		siege_line(id, "The engine refused the entity.");
		return PLUGIN_HANDLED;
	}
	set_pev(ent, pev_solid, SOLID_BBOX);
	set_pev(ent, pev_movetype, MOVETYPE_NONE);
	set_pev(ent, pev_effects, EF_BRIGHTLIGHT);   // HL's light aura, the marker the eyes get
	engfunc(EngFunc_SetOrigin, ent, dest);
	new Float:mins[3], Float:maxs[3];
	mins[0] = -16.0; mins[1] = -16.0; mins[2] = 0.0;
	maxs[0] = 16.0; maxs[1] = 16.0; maxs[2] = 32.0;
	engfunc(EngFunc_SetSize, ent, mins, maxs);

	new name[16];
	formatex(name, charsmax(name), "%s%d", TSM_OBJ_PREFIX, n);
	set_pev(ent, pev_targetname, engfunc(EngFunc_AllocString, name));

	siege_line(id, "Synthetic objective tsm_obj_%d placed (ent %d) where you look. Next due is %d%s",
		n, ent, g_obj_taken + 1,
		(n == g_obj_taken + 1) ? " -- this one is in turn." : " -- take earlier ones first (amx_tsm_obj <n> walks the chain).");
	dbg("siege: synthetic objective %d spawned as ent %d by %d", n, ent, id);
	return PLUGIN_HANDLED;
}

/// FORCE-PLANT: the hold's own completion, right now. Outside a live round
/// and on a non-next objective the fuse's own guards still win.
public cmd_siege_plant(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (g_state != ST_LIVE)
	{
		siege_line(id, "The satchel only runs in a live round -- amx_match_start first.");
		return PLUGIN_HANDLED;
	}
	if (g_plant_n)
	{
		siege_line(id, "The satchel is already planted (objective %d) -- amx_tsm_siege_fuse sets it off.", g_plant_n);
		return PLUGIN_HANDLED;
	}

	new ent = 0, n = 0;
	new a[8];
	if (read_argc() > 1)
	{
		read_argv(1, a, charsmax(a));
		n = str_to_num(a);
		if (n < 1 || n > TSM_OBJ_MAX)
		{
			siege_line(id, "Number 1 to %d, please.", TSM_OBJ_MAX);
			return PLUGIN_HANDLED;
		}
		ent = siege_by_number(n);
	}
	else
	{
		ent = siege_aimed(id);
		n = siege_number(ent);
	}
	if (!n || ent <= 0 || !pev_valid(ent))
	{
		siege_line(id, "No objective there -- aim at one, name its number, or make one with amx_tsm_siege_spawn.");
		return PLUGIN_HANDLED;
	}
	if (n <= g_obj_taken)
	{
		siege_line(id, "Objective %d has already fallen -- amx_tsm_obj reset puts it back.", n);
		return PLUGIN_HANDLED;
	}
	if (n != g_obj_taken + 1)
	{
		siege_line(id, "NOTE: next in the chain is objective %d -- the fuse on %d will reconcile and fall nothing. amx_tsm_obj %d points the chain there first.",
			g_obj_taken + 1, n, n - 1);
	}

	// THE REAL PATH, not a copy of it.
	siege_plant_now(id, ent, n);
	return PLUGIN_HANDLED;
}

/// FORCE-FUSE: zero the wait and run the real fuse tick, guards and all --
/// an out-of-order plant releases here exactly as time would have.
public cmd_siege_fuse(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!g_plant_n)
	{
		siege_line(id, "Nothing is planted -- amx_tsm_siege_plant first.");
		return PLUGIN_HANDLED;
	}

	siege_line(id, "Fuse forced on objective %d.", g_plant_n);
	remove_task(TSM_TASK_CHARGE);
	task_charge_fuse();
	return PLUGIN_HANDLED;
}

/// THE SIREN, FORCED: what a round's first successful attack would have
/// started, from freeze on. A round boundary still cuts it exactly as ever.
public cmd_siege_alarm(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (g_alarm_on)
	{
		siege_line(id, "The alarm is already on (side %d).", g_alarm_side);
		return PLUGIN_HANDLED;
	}

	alarm_start(id, true);
	if (g_alarm_on)
	{
		siege_line(id, "Alarm forced ON (side %d), siren %.2f s a loop -- it stops at the round line as always.",
			g_alarm_side, g_alarm_len);
	}
	return PLUGIN_HANDLED;
}

/// THE CLEAN SLATE: fuse killed, alarm cut, the suite's own creatures taken
/// back out of the world, every cached body rebuilt, the chain at zero.
public cmd_siege_reset(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	// SYNTHETICS OUT. A standing body filling a chain slot with NO cache row
	// is one of the suite's own -- every real objective is recorded at map
	// load -- so the real bodies are never touched while the test creatures
	// are pulled from the world.
	new removed = 0;
	for (new n = 1; n <= TSM_OBJ_MAX; n++)
	{
		if (g_obj_model[n][0] || g_obj_class[n][0])
		{
			continue;
		}
		new body = siege_by_number(n);
		if (body > 0)
		{
			engfunc(EngFunc_RemoveEntity, body);
			removed++;
		}
	}

	remove_task(TSM_TASK_CHARGE);
	g_plant_ent = 0;
	g_plant_n = 0;
	g_plant_by = 0;
	alarm_stop();
	siege_reset();

	siege_line(id, "siege reset: %d synthetic objective(s) removed, %d objective(s) standing, chain at 0, alarm cut",
		removed, siege_count());
	return PLUGIN_HANDLED;
}

public cmd_obj(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new a[16];
	a[0] = 0;
	if (read_argc() > 1)
	{
		read_argv(1, a, charsmax(a));
	}
	if (equali(a, "reset"))
	{
		siege_reset();
	}
	else if (a[0])
	{
		new k = str_to_num(a);
		new count = siege_count();
		g_obj_taken = (k < 0) ? 0 : ((k > count) ? count : k);
	}

	new cls[32];
	get_pcvar_string(g_cv_objclass, cls, charsmax(cls));
	console_print(id, "[TSM] siege: %d objective(s) in the map, %d fallen; taken by team %d as '%s', hold %.1fs, slay %d",
		siege_count(), g_obj_taken, get_pcvar_num(g_cv_objteam), cls,
		get_pcvar_float(g_cv_objtime), get_pcvar_num(g_cv_objslay));
	return PLUGIN_HANDLED;
}

/// Is this entity one of the map's engineer-only doors?
bool:is_eng_door(ent)
{
	if (ent < 1 || !pev_valid(ent))
	{
		return false;
	}

	new name[32];
	name[0] = 0;
	pev(ent, pev_targetname, name, charsmax(name));
	return (equal(name, TSM_ENG_DOOR) != 0);
}

/// Drops every bot following this officer.
disband_squad(leader)
{
	new n = 0;
	for (new i = 1; i < MAXPL; i++)
	{
		if (g_squad_leader[i] == leader)
		{
			g_squad_leader[i] = 0;
			g_push_until[i] = 0.0;      // clear any pending shove
			g_squad_lag_at[i] = 0.0;    // and any half-run lag clock with it
			n++;
		}
	}
	return n;
}

/// How many bots are following this officer.
squad_size(leader)
{
	new n = 0;
	for (new i = 1; i < MAXPL; i++)
	{
		if (g_squad_leader[i] == leader && is_user_connected(i))
		{
			n++;
		}
	}
	return n;
}

/// Tries to place a bot on a clear ring around the center at the given radius.
/// Returns true on success (bot moved to TR_vecEndPos, velocity zeroed), false if no
/// clear spot found among the 8 candidates (base yaw + 8 offsets).
bool:step_bot_to_ring(bot, Float:center[3], Float:base_yaw, Float:radius)
{
	// 8 yaw offsets: 0, ±45, ±90, ±135, 180 degrees from base_yaw
	new const Float:yaw_offsets[8] = { 0.0, 45.0, -45.0, 90.0, -90.0, 135.0, -135.0, 180.0 };
	
	for (new i = 0; i < 8; i++)
	{
		new Float:yaw = base_yaw + yaw_offsets[i];
		new Float:cand[3];
		cand[0] = center[0] + floatcos(yaw, degrees) * radius;
		cand[1] = center[1] + floatsin(yaw, degrees) * radius;
		cand[2] = center[2];

		// TraceHull down from slightly above to find ground. GEOMETRY ONLY:
		// with DONT_IGNORE_MONSTERS the hull caught every standing player near
		// the officer, and in a scrum all eight candidates came back blocked --
		// the warp then fired for nobody, which is exactly the ".follow never
		// teleports" report. A body is a moving thing, not a wall, so whoever
		// stands in a candidate is checked below, as occupancy, and only that
		// one spot is skipped.
		new tr = 0;
		new Float:start[3], Float:end[3];
		start[0] = cand[0];
		start[1] = cand[1];
		start[2] = cand[2] + 8.0;
		end[0] = cand[0];
		end[1] = cand[1];
		end[2] = cand[2] - 128.0;
		engfunc(EngFunc_TraceHull, start, end, IGNORE_MONSTERS, TSM_HULL_HUMAN, bot, tr);

		new Float:frac;
		get_tr2(tr, TR_flFraction, frac);
		new bool:start_solid;
		get_tr2(tr, TR_StartSolid, start_solid);

		// Reject if starting inside solid or the trace never found ground in reach.
		if (start_solid || frac >= 1.0)
		{
			continue;
		}

		// Occupancy: anyone standing at the landing spot (the officer included)
		// rules this one candidate out, 2D and 36 units wide, so the spot is
		// only refused while a body is actually in it -- and jumping bodies do
		// not hold a veto on the ground they left.
		new bool:occupied = false;
		new occ[32], occn, occ_id;
		get_players(occ, occn, "a");
		for (new k = 0; k < occn; k++)
		{
			occ_id = occ[k];
			if (occ_id == bot)
			{
				continue;
			}
			new Float:oo[3];
			pev(occ_id, pev_origin, oo);
			new Float:dx = oo[0] - cand[0];
			new Float:dy = oo[1] - cand[1];
			if (dx * dx + dy * dy < 1296.0)   // 36 units, squared
			{
				occupied = true;
				break;
			}
		}
		if (occupied)
		{
			continue;
		}

		// Valid spot: place bot at trace end position, zero velocity
		new Float:dest[3];
		get_tr2(tr, TR_vecEndPos, dest);
		engfunc(EngFunc_SetOrigin, bot, dest);

		new Float:zero_vel[3] = { 0.0, 0.0, 0.0 };
		set_pev(bot, pev_velocity, zero_vel);
		return true;
	}
	return false;
}

/*
 * Steers the squad, once every tenth of a second.
 *
 * rcbot has no follow command -- there is nothing in its command set to order a
 * bot to a player -- so the bots are steered from here instead, by writing their
 * velocity towards the officer. rcbot is still driving them on its own frames, so
 * this is a tug of war rather than a handover: expect them to trail along rather
 * than form up neatly.
 *
 * Run from a task rather than per-frame on purpose. Whether PlayerPreThink fires
 * at all for an rcbot fake client is still unconfirmed, and the one-second poll
 * demonstrably does reach them -- so the mechanism that is known to work is the
 * one this is built on.
 */
public task_squad()
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return;
	}
	/*
	 * Shove persistence: any bot with an active push gets its velocity refreshed
	 * every 0.1s so the nudge lasts ~0.7s instead of a single frame. Runs BEFORE
	 * the steering cvar gate so it continues even if squadsteer is toggled off.
	 */
	new Float:now = get_gametime();
	for (new bot = 1; bot < MAXPL; bot++)
	{
		if (g_push_until[bot] > now)
		{
			new Float:vel[3];
			pev(bot, pev_velocity, vel);
			vel[0] = g_push_dir[bot][0] * TSM_PUSH_SPEED;
			vel[1] = g_push_dir[bot][1] * TSM_PUSH_SPEED;
			set_pev(bot, pev_velocity, vel);
		}
	}

	/*
	 * This is what actually makes .follow follow, so it runs by default now.
	 *
	 * It is in tension with rcbot, which re-decides where its bots are going every
	 * frame -- two things steering one bot. rcbot rewrites their velocity far more
	 * often than this once-a-tenth steering can, so the pull is only trusted for
	 * SHORT catch-ups: inside tsm_squad_dist the bot is rcbot's own, just beyond it
	 * the pull keeps the drift closing, and a bot that STAYS out -- or goes way
	 * out -- is warped back beside the officer by the tier below. That last tier is
	 * what makes the loop an actual loop; without it the order decays into rcbot
	 * wandering off and a velocity shove that never wins.
	 */
	if (!get_pcvar_num(g_cv_squadsteer))
	{
		return;
	}

	new Float:want = float(get_pcvar_num(g_cv_squaddist));
	new Float:warp = float(get_pcvar_num(g_cv_squadwarp));
	new Float:speed = float(get_pcvar_num(g_cv_squadspeed));
	new Float:leash = float(get_pcvar_num(g_cv_squadleash));
	if (leash > warp)
	{
		leash = warp;   // a gauge above the warp range would swallow the leash whole
	}

	for (new bot = 1; bot < MAXPL; bot++)
	{
		new leader = g_squad_leader[bot];
		if (!leader)
		{
			continue;
		}

		// The order dies with the officer, with the round, or if they swap class.
		if (!is_user_connected(bot) || !is_user_alive(bot) || g_elim[bot]
			|| !is_officer(leader)
			|| g_match_team[bot] != g_match_team[leader])
		{
			g_squad_leader[bot] = 0;
			g_push_until[bot] = 0.0;      // clear any pending shove
			g_squad_lag_at[bot] = 0.0;    // and any half-run lag clock with it
			continue;
		}

		new Float:bo[3], Float:lo[3];
		pev(bot, pev_origin, bo);
		pev(leader, pev_origin, lo);

		new Float:d[3];
		d[0] = lo[0] - bo[0];
		d[1] = lo[1] - bo[1];
		d[2] = lo[2] - bo[2];
		new Float:dist = vector_length(d);

		if (dist <= want)
		{
			// Back in formation: the lag clock is stopped, so the next drift out
			// starts it fresh rather than warping on a stale count.
			g_squad_lag_at[bot] = 0.0;

			// Personal-space push: if a squad bot is inside 40 units but outside
			// 1.0 unit, give it a gentle outward shove so it doesn't sit on the
			// officer. This runs inside the "close enough" branch so we don't
			// fight rcbot's pathing at normal follow distances.
			if (dist > 1.0 && dist < 40.0)
			{
				new Float:vel[3];
				pev(bot, pev_velocity, vel);
				vel[0] = -(d[0] / dist) * TSM_PUSH_SPEED;
				vel[1] = -(d[1] / dist) * TSM_PUSH_SPEED;
				set_pev(bot, pev_velocity, vel);
				// Persist the shove for ~0.7s (7 ticks at 0.1s)
				g_push_until[bot] = get_gametime() + 0.7;
				g_push_dir[bot][0] = -(d[0] / dist);
				g_push_dir[bot][1] = -(d[1] / dist);
			}
			continue;   // close enough; leave them to rcbot entirely
		}

		// base_yaw = behind the officer (leader yaw + 180), shared by both warp tiers.
		new Float:leader_angles[3];
		pev(leader, pev_v_angle, leader_angles);

		if (dist > warp)
		{
			/*
			 * Lost them completely: put them back BESIDE the officer, never onto
			 * them. Without this a bot that rcbot has walked into another room
			 * simply never comes back, because nudging a velocity cannot beat
			 * rcbot's own pathing over a long distance. A warp is blunt but it is
			 * the difference between the order working and the order being
			 * decorative.
			 */
			if (step_bot_to_ring(bot, lo, leader_angles[1] + 180.0, 40.0))
			{
				dbgv("squad: warped bot %d to ring beside officer %d (%.0f units)", bot, leader, dist);
				g_squad_lag_at[bot] = 0.0;
				continue;
			}
			// Warp failed (no clear spot) -- fall through to the velocity pull.
		}
		else if (dist <= leash)
		{
			/*
			 * Back inside the leash gauge: ordinary fight-from-range play. The
			 * pull below still holds them, but the clock never starts, and a
			 * bot that dips back under the gauge between spikes clears the old
			 * count instead of cashing it in.
			 */
			g_squad_lag_at[bot] = 0.0;
		}
		else if (g_squad_lag_at[bot] <= 0.0)
		{
			/*
			 * First frame WELL beyond formation -- past tsm_squad_leash, the
			 * genuinely-lost gauge. rcbot may simply be re-pathing them, and
			 * the pull below still shortens the gap meanwhile.
			 */
			g_squad_lag_at[bot] = now;
		}
		else if (now - g_squad_lag_at[bot] >= TSM_SQUAD_LEASH)
		{
			/*
			 * THE LEASH: a bot that has stayed out of formation for
			 * TSM_SQUAD_LEASH seconds is brought in by force. This is the second
			 * half of "constantly loop follow" -- velocity steering alone loses
			 * the tug of war against rcbot whenever rcbot has decided to go
			 * somewhere, and the report was bots that trailed, fell behind and
			 * never actually arrived. The clock is burnt either way, so a ring
			 * with no free spot retries in another leash rather than every tick.
			 */
			g_squad_lag_at[bot] = now;
			if (step_bot_to_ring(bot, lo, leader_angles[1] + 180.0, 40.0))
			{
				dbgv("squad: leashed bot %d back to formation around officer %d (%.0f units)", bot, leader, dist);
				continue;
			}
		}

		if (dist < 1.0)
		{
			continue;
		}

		new Float:vel[3];
		pev(bot, pev_velocity, vel);      // read first: vertical motion stays the engine's
		vel[0] = (d[0] / dist) * speed;   // (the old vel[2] form wrote past the array)
		vel[1] = (d[1] / dist) * speed;
		set_pev(bot, pev_velocity, vel);
	}
}

/// True when classname appears in that cvar's comma-separated list.
bool:classname_in_list(pcvar, const classname[])
{
	new list[192];
	get_pcvar_string(pcvar, list, charsmax(list));
	if (!list[0] || !classname[0])
	{
		return false;
	}

	new rest[192], carry[192], item[48];
	copy(rest, charsmax(rest), list);

	for (new guard = 0; guard < 24 && rest[0]; guard++)
	{
		strtok(rest, item, charsmax(item), carry, charsmax(carry), ',', 0);
		copy(rest, charsmax(rest), carry);
		if (item[0] && equali(item, classname))
		{
			return true;
		}
	}
	return false;
}

/// True when name appears in any of tsm_breachdoor_1..8, or begins with tsm_breach_ -- a map's own breach door,
/// which needs no list (and so works on a server that runs no map config).
///
/// Those lists accept comma OR space separation. The split is done locally, onto a
/// scratch copy with the spaces folded to commas -- classname_in_list cannot be used
/// directly because it re-reads the cvar and would throw the fold away.
bool:breachdoor_listed(const name[])
{
	if (!name[0])
	{
		return false;
	}
	if (equali(name, "tsm_breach_", 11))
	{
		return true;
	}

	for (new i = 0; i < 8; i++)
	{
		new list[192];
		get_pcvar_string(g_cv_breachdoor[i], list, charsmax(list));
		if (!list[0])
		{
			continue;
		}

		new rest[192], carry[192], item[48];
		copy(rest, charsmax(rest), list);
		for (new c = 0; c < 192 && rest[c]; c++)
		{
			if (rest[c] == ' ')
			{
				rest[c] = ',';
			}
		}

		for (new guard = 0; guard < 24 && rest[0]; guard++)
		{
			strtok(rest, item, charsmax(item), carry, charsmax(carry), ',', 0);
			copy(rest, charsmax(rest), carry);
			if (item[0] && equali(item, name))
			{
				return true;
			}
		}
	}
	return false;
}

/*
 * Hides teammates from a bot's line of sight.
 *
 * THIS is what stops bots shooting their own side. Everything before it failed,
 * and all of it failed for the same reason: it tried to reach a decision that is
 * made inside rcbot's compiled binary. rcbot picks its own targets, its team
 * support for TS is broken upstream, and no setting it exposes changes that.
 *
 * So this does not argue with the decision -- it removes the input. A bot asks the
 * engine whether it can see a player by tracing a line to them. When that trace
 * comes back empty the teammate is not a candidate, and no team logic is needed
 * anywhere.
 *
 * The trace is reported CLEAR rather than blocked, so bots shoot straight through
 * a teammate at whatever is behind them. That is deliberate. Reporting a wall
 * instead would make bots hold fire every time a teammate crossed their line, and
 * friendly damage is already refused outright by fw_takedamage, so a bullet that
 * passes through costs nothing.
 *
 * Cost matters here: this fires for every line of sight every bot tests, so the
 * guards are ordered cheapest first and the bot lookup is a cached array rather
 * than a native call. tsm_bot_blind_ff 0 switches it off live.
 */
public fw_traceline(const Float:start[3], const Float:end[3], noMonsters, skip, tr)
{
	// Plain array reads first, then a cvar, then anything that touches an entity.
	if (skip < 1 || skip >= MAXPL || !g_is_bot[skip])
	{
		return FMRES_IGNORED;
	}
	g_traces_seen++;

	new team = g_match_team[skip];
	if (team != 1 && team != 2 || g_state != ST_LIVE)
	{
		return FMRES_IGNORED;
	}
	if (!get_pcvar_num(g_cv_blindff))
	{
		return FMRES_IGNORED;
	}

	new hit = get_tr2(tr, TR_pHit);
	if (hit < 1 || hit >= MAXPL || g_match_team[hit] != team)
	{
		return FMRES_IGNORED;
	}

	// Clear through: no hit, full fraction, and the end point the caller asked for.
	set_tr2(tr, TR_pHit, 0);
	set_tr2(tr, TR_flFraction, 1.0);
	set_tr2(tr, TR_vecEndPos, end);
	g_blinded++;

	return FMRES_IGNORED;
}

/*
 * Refuses a powerup pickup.
 *
 * Touch is an entity call the server makes itself, which is the only reason this
 * works on bots. The usepowerup command hook next to it never saw one: a fake
 * client sends no client commands, so register_clcmd can never fire for a bot.
 * That is the same mistake that left friendly fire unblocked for bots, and it is
 * why they were helping themselves to powerups while players could not.
 */
public fw_touch(touched, toucher)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_nopowerups))
	{
		return FMRES_IGNORED;
	}
	if (toucher < 1 || toucher >= MAXPL || !pev_valid(touched))
	{
		return FMRES_IGNORED;
	}

	new cls[32];
	cls[0] = 0;
	pev(touched, pev_classname, cls, charsmax(cls));
	if (!equal(cls, "ts_powerup"))
	{
		return FMRES_IGNORED;
	}

	// The Officer's class powerup (kung fu) is legitimately a powerup, so the one
	// class exemption lives here as well as on the usepowerup command.
	if (is_officer(toucher))
	{
		dbgv("officer %d allowed powerup pickup", toucher);
		return FMRES_IGNORED;
	}

	dbgv("powerup pickup refused for %d", toucher);
	return FMRES_SUPERCEDE;
}


/*
 * Forces one entity open for a Breacher.
 *
 * HL locks a door in two different ways, and only one of them is reachable from
 * here:
 *
 *   SF_DOOR_USE_ONLY in spawnflags -- the door will not be touched open and answers
 *   only +USE. That lives in entvars, so it is cleared below, and clearing it is
 *   what makes an otherwise sealed door respond at all.
 *
 *   A master entity (the "master" keyvalue, usually a multisource). That is in the
 *   door's private data, NOT in entvars, so it can be neither read nor cleared from
 *   a plugin. For those doors, put the master or the trigger that feeds it in
 *   tsm_breach_entities instead of the door itself -- firing the master is what
 *   unlocks the door, and a master IS reachable.
 */
breach_entity(id, ent)
{
	if (ent < 1)
	{
		return;
	}

	new flags = pev(ent, pev_spawnflags);
	if (flags & TSM_SF_DOOR_USE_ONLY)
	{
		set_pev(ent, pev_spawnflags, flags & ~TSM_SF_DOOR_USE_ONLY);
	}

	dllfunc(DLLFunc_Use, ent, id, id, 2, 0.0);   // 2 = USE_TOGGLE

	/*
	 * Then whatever it targets.
	 *
	 * A door is frequently a shell that fires the real mover, and double doors are
	 * two entities that each open the other -- forcing only the brush under the
	 * crosshair leaves half the doorway shut.
	 */
	new tgt[64];
	tgt[0] = 0;
	pev(ent, pev_target, tgt, charsmax(tgt));
	if (tgt[0])
	{
		new linked = -1;
		for (new guard = 0; guard < 16; guard++)
		{
			linked = engfunc(EngFunc_FindEntityByString, linked, "targetname", tgt);
			if (linked <= 0)
			{
				break;
			}
			dllfunc(DLLFunc_Use, linked, id, id, 2, 0.0);
		}
	}
}

/*
 * tsm_opendoor: forces open the door the admin is aiming at, locked or not.
 *
 * A door's lock is its master (the "master" keyvalue, usually a multisource). reTS
 * keeps it in the door's private data at 0xec, and CBaseDoor::DoorActivate (mp.dll
 * 0x100108d0) asks UTIL_IsMasterTriggered about it before the door moves. It is
 * cleared for the one Use and put back straight after, so the door opens once and
 * then its own timer, and its lock, behave as they always do.
 *
 * The door's toggle state is at 0x70: 0 at the top (open), 1 at the bottom, 2 going
 * up, 3 going down. A Use only moves a door that is at the bottom.
 */
#define TSM_PD_DOOR_STATE   28   // m_toggle_state, private data 0x70
#define TSM_PD_DOOR_MASTER  59   // m_sMaster, private data 0xec

public cmd_opendoor(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!get_pcvar_num(g_cv_forcedoor))
	{
		console_print(id, "[TSM] tsm_opendoor is off -- set amx_tsm_forcedoor 1 to use it.");
		return PLUGIN_HANDLED;
	}
	if (id < 1 || !is_user_connected(id))
	{
		console_print(id, "[TSM] tsm_opendoor opens the door a player is aiming at -- run it from a player's console.");
		return PLUGIN_HANDLED;
	}

	new Float:start[3], Float:vo[3], Float:ang[3], Float:fwd[3], Float:dest[3];
	pev(id, pev_origin, start);
	pev(id, pev_view_ofs, vo);
	start[0] += vo[0];
	start[1] += vo[1];
	start[2] += vo[2];

	pev(id, pev_v_angle, ang);
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);
	dest[0] = start[0] + fwd[0] * 8192.0;
	dest[1] = start[1] + fwd[1] * 8192.0;
	dest[2] = start[2] + fwd[2] * 8192.0;

	engfunc(EngFunc_TraceLine, start, dest, 0, id, 0);
	new door = get_tr2(0, TR_pHit);
	new cls[32];
	cls[0] = 0;
	if (door > 0 && pev_valid(door))
	{
		pev(door, pev_classname, cls, charsmax(cls));
	}
	if (!equal(cls, "func_door") && !equal(cls, "func_door_rotating"))
	{
		console_print(id, "[TSM] Not aiming at a door (hit: %s).", cls[0] ? cls : "nothing");
		return PLUGIN_HANDLED;
	}

	new dstate = get_pdata_int(door, TSM_PD_DOOR_STATE);
	if (dstate == 0 || dstate == 2)
	{
		console_print(id, "[TSM] That door is already open.");
		return PLUGIN_HANDLED;
	}
	if (dstate == 3)
	{
		console_print(id, "[TSM] That door is closing -- run it again once it has shut.");
		return PLUGIN_HANDLED;
	}

	new master = get_pdata_int(door, TSM_PD_DOOR_MASTER);
	set_pdata_int(door, TSM_PD_DOOR_MASTER, 0);
	g_forcing_door = true;
	dllfunc(DLLFunc_Use, door, id, id, 1, 0.0);   // 1 = USE_ON
	g_forcing_door = false;
	set_pdata_int(door, TSM_PD_DOOR_MASTER, master);

	console_print(id, "[TSM] Forced door %d (%s) open.", door, cls);
	dbg("tsm_opendoor: %d forced door %d (%s), master %d", id, door, cls, master);
	return PLUGIN_HANDLED;
}

/*
 * What +USE does for a class with a perk: resupply a teammate as a Combat Engineer,
 * or force an entity open as a Breacher.
 *
 * Deliberately open-ended -- tsm_eng_entities is empty by default, so until maps ship
 * entities meant for this, +USE against the world behaves exactly as stock TS.
 */
/* ---- the Combat Engineer's sentry turret ------------------------------- */

/*
 * THE SENTRY TURRET, after Natural Selection's: a Combat Engineer stands one up with .turret, it
 * shoots the other side's players and nobody else, his side repairs it with +USE once every
 * tsm_turret_repair_cooldown seconds, and enough damage destroys it.
 *
 * It is a func_breakable the plugin makes without spawning it, wearing the side's own model
 * (tsm_turret_blue.mdl for side 1, tsm_turret_red.mdl for side 2): TS's gunfire and grenades reach
 * a func_breakable's TakeDamage, which fw_obj_dmg hands to turret_damage, and its health is kept
 * here. The body faces where it was put down; the head turns by the model's two bone controllers,
 * 0 the yaw (0-360 degrees) and 1 the pitch (-60 to 60). task_turrets sees and fires for every
 * turret ten times a second. Every turret goes at each round's start, at the end of a match, with
 * tsm_enabled 0, and when its engineer leaves.
 */

/// The slot of a turret's entity, -1 when it is not one.
turret_slot(ent)
{
	if (ent <= 0)
	{
		return -1;
	}
	for (new t = 0; t < TSM_TURRET_MAX; t++)
	{
		if (g_turret[t] == ent)
		{
			return t;
		}
	}
	return -1;
}

/// Removes one turret at once, and forgets it.
turret_remove(t)
{
	if (g_turret[t] && pev_valid(g_turret[t]))
	{
		engfunc(EngFunc_RemoveEntity, g_turret[t]);
	}
	g_turret[t] = 0;
	g_turret_owner[t] = 0;
	g_turret_target[t] = 0;
}

/// Removes every turret, or only an owner's (owner > 0).
turrets_clear(owner = 0)
{
	for (new t = 0; t < TSM_TURRET_MAX; t++)
	{
		if (g_turret[t] && (!owner || g_turret_owner[t] == owner))
		{
			turret_remove(t);
		}
	}
}

/// How many turrets stand for a side.
turret_count(side)
{
	new n = 0;
	for (new t = 0; t < TSM_TURRET_MAX; t++)
	{
		if (g_turret[t] && g_turret_side[t] == side)
		{
			n++;
		}
	}
	return n;
}

/// Plays one of the model's sequences from its start.
turret_sequence(ent, seq)
{
	if (pev(ent, pev_sequence) == seq)
	{
		return;
	}
	set_pev(ent, pev_sequence, seq);
	set_pev(ent, pev_frame, 0.0);
	set_pev(ent, pev_framerate, 1.0);
	set_pev(ent, pev_animtime, get_gametime());
}

/// Where a turret looks from: its head's turning axis, at the height of its gun.
turret_muzzle(ent, Float:muzzle[3])
{
	// the head's turning axis, at the gun's height: where the turret looks from
	new Float:ang[3];
	pev(ent, pev_origin, muzzle);
	pev(ent, pev_angles, ang);
	muzzle[0] += floatcos(ang[1], degrees) * TURRET_AXIS_X;
	muzzle[1] += floatsin(ang[1], degrees) * TURRET_AXIS_X;
	muzzle[2] += TURRET_GUN_Z;
}

/// Where a turret aims on a player: his chest.
turret_aim_point(id, Float:at[3])
{
	pev(id, pev_origin, at);
	at[2] += 8.0;
}

/*
 * Whether a turret may shoot a player: on the OTHER playing side (1 or 2 -- never the spectator
 * team, never nobody's), alive and in the round, not eliminated, held out, spectating or cloaked,
 * within tsm_turret_range, and in clear sight of the barrel.
 */
bool:turret_can_shoot(t, id, Float:muzzle[3])
{
	if (id < 1 || id > g_maxplayers || !is_user_alive(id))
	{
		return false;
	}
	new side = g_match_team[id];
	if ((side != 1 && side != 2) || side == g_turret_side[t])
	{
		return false;
	}
	if (g_elim[id] || g_locked_out[id] || is_spectating(id) || cloak_active(id))
	{
		return false;
	}
	new Float:at[3];
	turret_aim_point(id, at);
	if (get_distance_f(muzzle, at) > get_pcvar_float(g_cv_turret_range))
	{
		return false;
	}
	engfunc(EngFunc_TraceLine, muzzle, at, 0, g_turret[t], 0);
	new Float:frac;
	get_tr2(0, TR_flFraction, frac);
	return frac >= 1.0 || get_tr2(0, TR_pHit) == id;
}

/// The nearest player the turret may shoot, 0 for none.
turret_seek(t, Float:muzzle[3])
{
	new best = 0, Float:bestd = 999999.0;
	for (new id = 1; id <= g_maxplayers; id++)
	{
		if (!turret_can_shoot(t, id, muzzle))
		{
			continue;
		}
		new Float:at[3];
		turret_aim_point(id, at);
		new Float:d = get_distance_f(muzzle, at);
		if (d < bestd)
		{
			bestd = d;
			best = id;
		}
	}
	return best;
}

/*
 * A shot seen as TS draws a bullet in slow motion, at any speed of play: its bullet model flying from
 * the barrel to where the round went, TS's bullet_trail along its line. Only a picture: the round itself
 * landed when it was fired. A plain tracer where the game has no such files.
 */
turret_trail(Float:from[3], Float:to[3])
{
	new Float:dir[3];
	for (new k = 0; k < 3; k++)
	{
		dir[k] = to[k] - from[k];
	}
	new Float:dist = floatsqroot(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
	new b = 0;
	if (g_turret_bullet && dist > 32.0)
	{
		b = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	}
	if (!b || !pev_valid(b))
	{
		message_begin_f(MSG_PVS, SVC_TEMPENTITY, from);
		write_byte(TE_TRACER);
		write_coord(floatround(from[0]));
		write_coord(floatround(from[1]));
		write_coord(floatround(from[2]));
		write_coord(floatround(to[0]));
		write_coord(floatround(to[1]));
		write_coord(floatround(to[2]));
		message_end();
		return;
	}
	// No faster than the engine's own cap (sv_maxvelocity, 2000 unless told): a full 1000-unit shot
	// is half a second in the air.
	new Float:speed = 2000.0, Float:vel[3], Float:ang[3];
	for (new k = 0; k < 3; k++)
	{
		vel[k] = dir[k] / dist * speed;
	}
	engfunc(EngFunc_VecToAngles, vel, ang);
	ang[0] = -ang[0];   // a studio model's pitch is the other way from a vector's
	set_pev(b, pev_classname, "turret_bullet");
	engfunc(EngFunc_SetModel, b, "models/bullet.mdl");
	engfunc(EngFunc_SetOrigin, b, from);
	set_pev(b, pev_angles, ang);
	set_pev(b, pev_solid, SOLID_NOT);
	set_pev(b, pev_movetype, MOVETYPE_NOCLIP);
	set_pev(b, pev_velocity, vel);

	// The trail is drawn between two points, not after the bullet: in the frame the bullet is made no
	// client has it yet, and a trail sent to follow it would have nothing to follow. To everyone, not
	// only those who see the barrel: whoever stands at the far end sees it arrive. It lasts until the
	// bullet has got there, and a moment more.
	new Float:life = dist / speed;
	new tenths = clamp(floatround((life + 0.2) * 10.0, floatround_ceil), 2, 255);
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_BEAMPOINTS);
	write_coord(floatround(from[0]));
	write_coord(floatround(from[1]));
	write_coord(floatround(from[2]));
	write_coord(floatround(to[0]));
	write_coord(floatround(to[1]));
	write_coord(floatround(to[2]));
	write_short(g_turret_trail);
	write_byte(0);     // first frame
	write_byte(10);    // frame rate
	write_byte(tenths);   // life, tenths of a second
	write_byte(3);     // width
	write_byte(0);     // no noise: a straight line
	write_byte(255);
	write_byte(255);
	write_byte(255);
	write_byte(180);   // brightness
	write_byte(30);    // scroll
	message_end();

	set_task(life > 0.1 ? life : 0.1, "remove_ent", b);
}

/*
 * One shot, out of the barrels' end: along the gun as it points (its world yaw and its pitch, in
 * degrees), from the point it tips about, spread by tsm_turret_spread degrees.
 */
turret_fire(t, Float:pivot[3], Float:yaw, Float:pitch)
{
	new ent = g_turret[t];
	new Float:dir[3];
	dir[0] = floatcos(pitch, degrees) * floatcos(yaw, degrees);
	dir[1] = floatcos(pitch, degrees) * floatsin(yaw, degrees);
	dir[2] = floatsin(pitch, degrees);
	new Float:muzzle[3];
	for (new k = 0; k < 3; k++)
	{
		muzzle[k] = pivot[k] + dir[k] * TURRET_BARREL;
	}
	// The flash at the barrels' end, a TS gun's own, and every other shot a moment's light around it.
	if (g_turret_flash)
	{
		message_begin_f(MSG_PVS, SVC_TEMPENTITY, muzzle);
		write_byte(TE_SPRITE);
		write_coord(floatround(muzzle[0]));
		write_coord(floatround(muzzle[1]));
		write_coord(floatround(muzzle[2]));
		write_short(g_turret_flash);
		write_byte(random_num(4, 6));   // scale, tenths
		write_byte(220);                // brightness
		message_end();
	}
	if (g_turret_shots[t] % 2 == 0)
	{
		message_begin_f(MSG_PVS, SVC_TEMPENTITY, muzzle);
		write_byte(TE_DLIGHT);
		write_coord(floatround(muzzle[0]));
		write_coord(floatround(muzzle[1]));
		write_coord(floatround(muzzle[2]));
		write_byte(14);    // radius, tens of units
		write_byte(255);
		write_byte(190);
		write_byte(90);
		write_byte(1);     // life, tenths of a second
		write_byte(60);    // decay, tens of units a second
		message_end();
	}

	new Float:spread = floattan(get_pcvar_float(g_cv_turret_spread), degrees);
	for (new k = 0; k < 3; k++)
	{
		dir[k] += random_float(-spread, spread);
	}
	new Float:range = get_pcvar_float(g_cv_turret_range);
	new Float:end[3];
	for (new k = 0; k < 3; k++)
	{
		end[k] = muzzle[k] + dir[k] * range;
	}
	engfunc(EngFunc_TraceLine, muzzle, end, 0, ent, 0);
	new hit = get_tr2(0, TR_pHit);
	get_tr2(0, TR_vecEndPos, end);

	turret_trail(muzzle, end);

	if (g_turret_shots[t]++ % 2 == 0)
	{
		emit_sound(ent, CHAN_WEAPON, g_turret_fire_snd[random(sizeof g_turret_fire_snd)], 0.9, ATTN_NORM, 0, PITCH_NORM);
	}

	// Only the other side is ever hurt: a stray round through a teammate does nothing.
	if (hit >= 1 && hit <= g_maxplayers && is_user_alive(hit)
		&& (g_match_team[hit] == 1 || g_match_team[hit] == 2) && g_match_team[hit] != g_turret_side[t])
	{
		// TS's TakeDamage draws no blood of its own: the burst where the round went in.
		if (g_turret_blood)
		{
			message_begin_f(MSG_PVS, SVC_TEMPENTITY, end);
			write_byte(TE_BLOODSPRITE);
			write_coord(floatround(end[0]));
			write_coord(floatround(end[1]));
			write_coord(floatround(end[2]));
			write_short(g_turret_bloodspray);
			write_short(g_turret_blood);
			write_byte(247);
			write_byte(8);
			message_end();
		}
		new by = g_turret_owner[t];
		if (!is_user_connected(by))
		{
			by = ent;
		}
		new before = get_user_health(hit);
		ExecuteHamB(Ham_TakeDamage, hit, ent, by, get_pcvar_float(g_cv_turret_dmg), DMG_BULLET);
		dbgv("turret %d hit %d for %.0f: health %d -> %d", t, hit, get_pcvar_float(g_cv_turret_dmg), before,
			is_user_alive(hit) ? get_user_health(hit) : 0);
	}
}

/// Every turret, ten times a second: deploying, looking for a target, turning its head, firing.
public task_turrets()
{
	new Float:now = get_gametime();
	for (new t = 0; t < TSM_TURRET_MAX; t++)
	{
		new ent = g_turret[t];
		if (!ent)
		{
			continue;
		}
		if (!pev_valid(ent))
		{
			g_turret[t] = 0;
			continue;
		}
		if (now < g_turret_ready_at[t])
		{
			continue;
		}
		if (g_state != ST_LIVE || !get_pcvar_num(g_cv_enabled))
		{
			g_turret_target[t] = 0;
			turret_sequence(ent, TURRET_SEQ_IDLE);
			continue;
		}

		new Float:muzzle[3];
		turret_muzzle(ent, muzzle);
		new target = g_turret_target[t];
		if (now >= g_turret_seek_at[t] || !turret_can_shoot(t, target, muzzle))
		{
			g_turret_seek_at[t] = now + 0.25;
			new best = turret_seek(t, muzzle);
			if (best && best != target)
			{
				emit_sound(ent, CHAN_ITEM, TSM_TURRET_PING, 0.8, ATTN_NORM, 0, PITCH_NORM);
			}
			target = best;
			g_turret_target[t] = best;
		}
		if (!target)
		{
			turret_sequence(ent, TURRET_SEQ_SPIN);
			continue;
		}

		// The head on the target: yaw against the body's own, pitch clamped to the model's travel.
		new Float:at[3];
		turret_aim_point(target, at);
		// Yaw about the head's axis; the gun's pivot then stands behind that axis, and its pitch is
		// taken from there.
		new Float:wyaw = floatatan2(at[1] - muzzle[1], at[0] - muzzle[0], degrees);
		new Float:pivot[3];
		pivot[0] = muzzle[0] - floatcos(wyaw, degrees) * TURRET_PIVOT_BACK;
		pivot[1] = muzzle[1] - floatsin(wyaw, degrees) * TURRET_PIVOT_BACK;
		pivot[2] = muzzle[2];
		new Float:dx = at[0] - pivot[0], Float:dy = at[1] - pivot[1], Float:dz = at[2] - pivot[2];
		new Float:yaw = wyaw - g_turret_yaw[t];
		while (yaw < 0.0)
		{
			yaw += 360.0;
		}
		while (yaw >= 360.0)
		{
			yaw -= 360.0;
		}
		new Float:flat = floatsqroot(dx * dx + dy * dy);
		new Float:pitch = floatatan2(dz, flat, degrees);
		// Up the model's whole 60; down only 35, past which the long barrels would meet the column.
		if (pitch > 60.0)
		{
			pitch = 60.0;
		}
		else if (pitch < -35.0)
		{
			pitch = -35.0;
		}
		set_pev(ent, pev_controller_0, floatround(yaw * 255.0 / 360.0));
		// The model's pitch runs the other way: +60 on its controller is the barrel full down.
		set_pev(ent, pev_controller_1, floatround((60.0 - pitch) * 255.0 / 120.0));
		turret_sequence(ent, TURRET_SEQ_FIRE);

		new Float:rate = get_pcvar_float(g_cv_turret_rate);
		if (rate <= 0.0)
		{
			continue;
		}
		new Float:gap = 1.0 / rate;
		if (g_turret_shot_at[t] < now - 0.2)
		{
			g_turret_shot_at[t] = now;
		}
		while (g_turret_shot_at[t] <= now)
		{
			turret_fire(t, pivot, wyaw, pitch);
			g_turret_shot_at[t] += gap;
		}
	}
}

/*
 * A turret is hit. Its own side's fire, and anything no player is behind, does nothing; the
 * rest comes off its health, and at none it is destroyed: a burst, the metal's crash, its death
 * sequence for a moment, and gone. Its engineer is told.
 */
turret_damage(t, attacker, Float:damage)
{
	if (attacker < 1 || attacker > g_maxplayers || g_match_team[attacker] == g_turret_side[t] || damage <= 0.0)
	{
		return;
	}
	// its armour turns aside tsm_turret_resist of every hit (never all of it)
	g_turret_hp[t] -= damage * (1.0 - floatclamp(get_pcvar_float(g_cv_turret_resist), 0.0, 0.95));
	new ent = g_turret[t];
	set_pev(ent, pev_health, g_turret_hp[t] > 1.0 ? g_turret_hp[t] : 1.0);
	// Metal hammered, on every hit, as a mech's armour rings: one fixed channel, so each clang takes
	// the place of the last under sustained fire.
	emit_sound(ent, CHAN_BODY, g_mech_hit_snd[random(sizeof g_mech_hit_snd)], 1.0, ATTN_NORM, 0, PITCH_NORM);
	if (g_turret_hp[t] > 0.0)
	{
		return;
	}

	new Float:org[3];
	pev(ent, pev_origin, org);
	org[2] += 24.0;
	message_begin_f(MSG_PVS, SVC_TEMPENTITY, org);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(org[0]));
	write_coord(floatround(org[1]));
	write_coord(floatround(org[2]));
	write_short(g_turret_boom);
	write_byte(35);    // scale in tenths
	write_byte(20);
	write_byte(TE_EXPLFLAG_NONE);
	message_end();
	emit_sound(ent, CHAN_WEAPON, TSM_OBJ_BOOM_A, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	emit_sound(ent, CHAN_BODY, "debris/metal2.wav", 1.0, ATTN_NORM, 0, PITCH_NORM);

	new owner = g_turret_owner[t];
	if (is_user_connected(owner) && !is_user_bot(owner))
	{
		client_print(owner, print_chat, "[TSM] Your turret was destroyed.");
	}

	// The body lies a moment in its death sequence, harmless, before it goes.
	set_pev(ent, pev_takedamage, 0.0);
	set_pev(ent, pev_solid, SOLID_NOT);
	turret_sequence(ent, TURRET_SEQ_DIE);
	set_task(1.4, "remove_ent", ent);
	g_turret[t] = 0;
	g_turret_owner[t] = 0;
	g_turret_target[t] = 0;
}

/// The engineer's yellow shell on a repaired turret, as on a resupplied player, for `secs`.
turret_glow(t, Float:secs, shell)
{
	new ent = g_turret[t];
	if (!ent || !pev_valid(ent))
	{
		return;
	}
	set_pev(ent, pev_renderfx, TSM_RENDERFX_GLOW);
	set_pev(ent, pev_rendercolor, Float:{255.0, 220.0, 0.0});
	set_pev(ent, pev_renderamt, float(shell < 1 ? 16 : shell));
	set_pev(ent, pev_rendermode, TSM_RENDER_NORMAL);
	remove_task(TSM_TASK_TURRET + 1 + t);
	set_task(secs, "task_turret_glow_off", TSM_TASK_TURRET + 1 + t);
}

public task_turret_glow_off(taskid)
{
	new ent = g_turret[taskid - TSM_TASK_TURRET - 1];
	if (ent && pev_valid(ent))
	{
		set_pev(ent, pev_renderfx, TSM_RENDERFX_NONE);
		set_pev(ent, pev_renderamt, 0.0);
	}
}

/// +USE on his side's turret by a Combat Engineer: tsm_turret_repair back, once every cooldown.
turret_repair(id, t)
{
	if (g_turret_side[t] != g_match_team[id])
	{
		return;
	}
	new Float:full = get_pcvar_float(g_cv_turret_hp);
	if (g_turret_hp[t] >= full)
	{
		client_print(id, print_center, "The turret is undamaged.");
		return;
	}
	new Float:now = get_gametime();
	if (now < g_turret_repair_at[t])
	{
		client_print(id, print_center, "Turret repair ready in %.0fs", g_turret_repair_at[t] - now);
		return;
	}
	g_turret_hp[t] += get_pcvar_float(g_cv_turret_repair);
	if (g_turret_hp[t] > full)
	{
		g_turret_hp[t] = full;
	}
	set_pev(g_turret[t], pev_health, g_turret_hp[t]);
	g_turret_repair_at[t] = now + get_pcvar_float(g_cv_turret_repaircd);
	perk_sound(id, g_cv_engsound);
	if (get_pcvar_float(g_cv_engglow) > 0.0)
	{
		turret_glow(t, get_pcvar_float(g_cv_engglow), get_pcvar_num(g_cv_engshell));
	}
	client_print(id, print_center, "Turret repaired: %.0f / %.0f", g_turret_hp[t], full);
}

/// turret in the console: the same as .turret.
public cmd_turret_console(id)
{
	cmd_turret(id);
	return PLUGIN_HANDLED;
}

/*
 * .turret -- a Combat Engineer stands a sentry turret on the floor 64 units in front of him,
 * facing the way he faces, in a live round: one a round (one a wave in Wave Survival), even
 * once it is destroyed, and tsm_turret_per_team on his side at most, on clear floor nobody
 * stands on. It deploys, and
 * starts looking for the other side a second later.
 */
cmd_turret(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_turret) || !g_turret_ok)
	{
		client_print(id, print_chat, "[TSM] Turrets are off on this server.");
		return;
	}
	if (!is_engineer(id) || g_state != ST_LIVE || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] Only a Combat Engineer can place a turret, in a live round.");
		return;
	}
	new side = g_match_team[id];
	if (side != 1 && side != 2)
	{
		return;
	}
	if (g_turret_used[id] && !g_turret_carry[id])
	{
		client_print(id, print_chat, "[TSM] One turret a round -- yours is already placed.");
		return;
	}
	if (turret_count(side) >= get_pcvar_num(g_cv_turret_per_team))
	{
		client_print(id, print_chat, "[TSM] Your side already has %d turrets standing.", get_pcvar_num(g_cv_turret_per_team));
		return;
	}
	new t = -1;
	for (new k = 0; k < TSM_TURRET_MAX; k++)
	{
		if (!g_turret[k])
		{
			t = k;
			break;
		}
	}
	if (t < 0)
	{
		client_print(id, print_chat, "[TSM] No more turrets can stand on this map.");
		return;
	}

	// The spot: 64 units ahead on the level, in clear air from his eyes, then down to the floor.
	new Float:eye[3], Float:org[3], Float:ang[3], Float:spot[3], Float:frac;
	pev(id, pev_origin, org);
	pev(id, pev_view_ofs, eye);
	for (new k = 0; k < 3; k++)
	{
		eye[k] += org[k];
	}
	pev(id, pev_v_angle, ang);
	new Float:yaw = ang[1];
	spot[0] = org[0] + floatcos(yaw, degrees) * 64.0;
	spot[1] = org[1] + floatsin(yaw, degrees) * 64.0;
	spot[2] = org[2];
	engfunc(EngFunc_TraceLine, eye, spot, 0, id, 0);
	get_tr2(0, TR_flFraction, frac);
	if (frac < 1.0)
	{
		client_print(id, print_chat, "[TSM] No room for a turret there.");
		return;
	}
	new Float:down[3];
	down[0] = spot[0];
	down[1] = spot[1];
	down[2] = spot[2] - 160.0;
	engfunc(EngFunc_TraceLine, spot, down, 0, id, 0);
	get_tr2(0, TR_flFraction, frac);
	if (frac >= 1.0)
	{
		client_print(id, print_chat, "[TSM] A turret needs floor under it.");
		return;
	}
	get_tr2(0, TR_vecEndPos, spot);

	// Clear of walls and of anyone standing there: a standing body's hull at the spot.
	new Float:hull[3];
	hull[0] = spot[0];
	hull[1] = spot[1];
	hull[2] = spot[2] + 37.0;
	engfunc(EngFunc_TraceHull, hull, hull, 0, TSM_HULL_HUMAN, id, 0);
	if (get_tr2(0, TR_StartSolid) || get_tr2(0, TR_AllSolid))
	{
		client_print(id, print_chat, "[TSM] No room for a turret there.");
		return;
	}

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "func_breakable"));
	if (!pev_valid(ent))
	{
		return;
	}
	set_pev(ent, pev_targetname, TSM_TURRET_NAME);
	// TS names a kill by its inflictor's classname: "turret" in the kill feed, not "breakable". The
	// entity stays a CBreakable underneath, so fw_obj_dmg still takes its damage.
	set_pev(ent, pev_classname, "turret");
	// Its side, as every player carries his: the patched rcbot takes a turret of the other side for an enemy.
	set_pev(ent, pev_team, side);
	engfunc(EngFunc_SetModel, ent, side == 1 ? TSM_TURRET_MDL_1 : TSM_TURRET_MDL_2);
	new Float:body[3];
	body[1] = yaw;
	set_pev(ent, pev_angles, body);
	set_pev(ent, pev_solid, SOLID_BBOX);
	set_pev(ent, pev_movetype, MOVETYPE_NONE);
	engfunc(EngFunc_SetSize, ent, Float:{-16.0, -16.0, 0.0}, Float:{16.0, 16.0, 52.0});
	engfunc(EngFunc_SetOrigin, ent, spot);
	new Float:full = get_pcvar_float(g_cv_turret_hp);
	// A carried turret stands down as it was packed up: its health and its repair's wait.
	new Float:hp = full, Float:repair_at = 0.0;
	if (g_turret_carry[id])
	{
		hp = floatmin(g_turret_carry_hp[id], full);
		repair_at = g_turret_carry_rep[id];
		g_turret_carry[id] = false;
	}
	set_pev(ent, pev_takedamage, 1.0);
	set_pev(ent, pev_health, hp);
	set_pev(ent, pev_controller_0, 0);
	set_pev(ent, pev_controller_1, 128);

	new Float:now = get_gametime();
	g_turret[t] = ent;
	g_turret_owner[t] = id;
	g_turret_side[t] = side;
	g_turret_hp[t] = hp;
	g_turret_repair_at[t] = repair_at;
	g_turret_ready_at[t] = now + 1.0;
	g_turret_seek_at[t] = 0.0;
	g_turret_shot_at[t] = 0.0;
	g_turret_target[t] = 0;
	g_turret_shots[t] = 0;
	g_turret_yaw[t] = yaw;
	g_turret_used[id] = true;
	turret_sequence(ent, TURRET_SEQ_DEPLOY);
	// At the spot, not on the entity: no client has the new entity yet, and a sound on one it has not
	// been sent is placed where it last knew it to be -- the middle of the map, out of anyone's hearing.
	engfunc(EngFunc_EmitAmbientSound, ent, spot, TSM_TURRET_DEPLOY, 1.0, ATTN_NORM, 0, PITCH_NORM);
	client_print(id, print_chat, "[TSM] Turret placed (%.0f / %.0f). +USE on it repairs it, once every %.0f seconds; .pickup packs it up.",
		hp, full, get_pcvar_float(g_cv_turret_repaircd));
}

/// pickup in the console: the same as .pickup.
public cmd_pickup_console(id)
{
	cmd_pickup(id);
	return PLUGIN_HANDLED;
}

/*
 * .pickup -- a Combat Engineer packs up his own turret, the one he is looking at within his +USE's
 * reach (tsm_eng_range), and carries it: .turret stands it down again with the health it had and its
 * repair's wait still running. A carried turret is gone with the round (the wave in Wave Survival).
 */
cmd_pickup(id)
{
	if (!is_engineer(id) || g_state != ST_LIVE || !is_user_alive(id))
	{
		client_print(id, print_chat, "[TSM] Only a Combat Engineer can pick up a turret, in a live round.");
		return;
	}
	new Float:eye[3], Float:vo[3], Float:ang[3], Float:fwd[3], Float:dest[3];
	pev(id, pev_origin, eye);
	pev(id, pev_view_ofs, vo);
	pev(id, pev_v_angle, ang);
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);
	new Float:range = float(get_pcvar_num(g_cv_engrange));
	for (new k = 0; k < 3; k++)
	{
		eye[k] += vo[k];
		dest[k] = eye[k] + fwd[k] * range;
	}
	engfunc(EngFunc_TraceLine, eye, dest, 0, id, 0);
	new t = turret_slot(get_tr2(0, TR_pHit));
	if (t < 0 || g_turret_owner[t] != id)
	{
		client_print(id, print_chat, "[TSM] Look at your own turret, up close, to pick it up.");
		return;
	}
	new Float:org[3];
	pev(g_turret[t], pev_origin, org);
	g_turret_carry[id] = true;
	g_turret_carry_hp[id] = g_turret_hp[t];
	g_turret_carry_rep[id] = g_turret_repair_at[t];
	engfunc(EngFunc_EmitAmbientSound, 0, org, TSM_TURRET_DEPLOY, 1.0, ATTN_NORM, 0, 92);
	remove_task(TSM_TASK_TURRET + 1 + t);
	turret_remove(t);
	client_print(id, print_chat, "[TSM] Turret packed up (%.0f / %.0f). .turret sets it down again.",
		g_turret_carry_hp[id], get_pcvar_float(g_cv_turret_hp));
}

perk_use(id)
{
	if (!is_user_alive(id) || !g_class_count)
	{
		return;
	}

	g_perk_at[id] = get_gametime();

	new ci = resolved_class(id) - 1;
	new perk = g_class_perk[ci];
	if (perk != TSM_PERK_ENGINEER && perk != TSM_PERK_BREACHER && perk != TSM_PERK_MEDIC)
	{
		return;
	}

	new Float:start[3], Float:vo[3], Float:ang[3], Float:fwd[3], Float:dest[3];
	pev(id, pev_origin, start);
	pev(id, pev_view_ofs, vo);
	start[0] += vo[0];
	start[1] += vo[1];
	start[2] += vo[2];

	pev(id, pev_v_angle, ang);
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);

	new reach = g_cv_engrange;
	if (perk == TSM_PERK_BREACHER)
	{
		reach = g_cv_breachrange;
	}
	else if (perk == TSM_PERK_MEDIC)
	{
		reach = g_cv_medrange;
	}
	new Float:range = float(get_pcvar_num(reach));
	dest[0] = start[0] + fwd[0] * range;
	dest[1] = start[1] + fwd[1] * range;
	dest[2] = start[2] + fwd[2] * range;

	engfunc(EngFunc_TraceLine, start, dest, 0, id, 0);
	new hit = get_tr2(0, TR_pHit);
	if (hit < 1)
	{
		return;
	}

	// The engineer's own side's sentry turret: repaired (turret_repair).
	if (perk == TSM_PERK_ENGINEER)
	{
		new t = turret_slot(hit);
		if (t >= 0)
		{
			turret_repair(id, t);
			return;
		}
	}

	// A teammate. The engineer resupplies one, the medic heals one, and the
	// breacher has nothing to do with one.
	if (hit < MAXPL && is_user_connected(hit))
	{
		if (perk != TSM_PERK_ENGINEER && perk != TSM_PERK_MEDIC)
		{
			return;
		}

		if (hit == id || !is_user_alive(hit) || g_elim[hit] || g_locked_out[hit])
		{
			return;
		}
		if (g_match_team[hit] != g_match_team[id] || !g_match_team[id])
		{
			return;
		}

		if (perk == TSM_PERK_MEDIC)
		{
			medic_heal(id, hit);
			return;
		}

		new Float:now = get_gametime();
		new Float:cool = get_pcvar_float(g_cv_engcool);

		if (g_eng_used[id] > 0.0 && (now - g_eng_used[id]) < cool)
		{
			client_print(id, print_center, "Resupply ready in %.0fs", cool - (now - g_eng_used[id]));
			return;
		}

		g_eng_used[id] = now;
		new plan = get_pcvar_num(g_cv_engclips) * 25;
		new gave = top_up_reserve(hit, plan);

		// Yellow, for ammunition. Red is the medic's.
		glow_player(hit, 255.0, 220.0, 0.0,
			get_pcvar_float(g_cv_engglow), get_pcvar_num(g_cv_engshell));
		perk_sound(hit, g_cv_engsound);

		new a[32], b[32];
		get_user_name(id, a, charsmax(a));
		get_user_name(hit, b, charsmax(b));
		client_print(id,  print_chat, "[MATCH] You resupplied %s.", b);
		if (gave > 0)
		{
			client_print(hit, print_chat, "[MATCH] %s resupplied you. (+%d rounds)", a, gave);
		}
		else
		{
			client_print(hit, print_chat, "[MATCH] %s resupplied you.", a);
		}
		dbg("engineer %d resupplied %d (+%d of %d rounds)", id, hit, gave, plan);
		return;
	}

	// A map entity, but only one the server allows.
	new cls[48];
	pev(hit, pev_classname, cls, charsmax(cls));

	if (perk == TSM_PERK_BREACHER)
	{
		/*
		 * An engineer door is not forceable, and the refusal has to be HERE.
		 *
		 * breach_entity() works by clearing SF_DOOR_USE_ONLY before it fires the
		 * door. Refusing the Use afterwards in fw_door_use would leave that flag
		 * cleared for the rest of the map -- the door would keep its brush and lose
		 * its lock, and anyone at all could then walk into it and open it.
		 */
		if (is_eng_door(hit))
		{
			if (!is_user_bot(id) && (get_gametime() - g_engdoor_told_at[id]) > 2.0)
			{
				g_engdoor_told_at[id] = get_gametime();
				client_print(id, print_chat, "[MATCH] That door has no lock to break -- it reads who is at it.");
			}
			dbgv("breach refused on engineer door %d for %d", hit, id);
			return;
		}

		if (!classname_in_list(g_cv_breachents, cls))
		{
			dbgv("breach: '%s' is not in tsm_breach_entities", cls);
			return;
		}

		/*
		 * A BREACH IS ONLY A BREACH ON A LOCKED OR DECLARED DOOR.
		 *
		 * "Breached." used to print for everything under the crosshair, which turned
		 * the callout into noise: the flag-clear below is the breach, and on an
		 * ordinary unlocked door there is nothing to clear. So the force and the
		 * message both happen only when the door was genuinely LOCKED (Use Only --
		 * the flag breach_entity strips) or when its targetname is one of the map's
		 * tsm_breachdoor_1..8 entries. Anything else is an everyday door: stock TS
		 * use/touch opens it for whoever the map allows, with no message at all.
		 */
		new bool:locked = (pev(hit, pev_spawnflags) & TSM_SF_DOOR_USE_ONLY) != 0;
		new name[32];
		name[0] = 0;
		pev(hit, pev_targetname, name, charsmax(name));
		if (!locked && !breachdoor_listed(name))
		{
			dbgv("breach: '%s' named '%s' is neither locked nor listed -- ordinary use", cls, name);
			return;
		}

		breach_entity(id, hit);
		client_print(id, print_center, "Breached.");

		// A forced door is the alarm's other trigger, same rule as the
		// objectives: the round's first one starts the siren, and that is it.
		alarm_start(id);
		dbg("breacher %d forced '%s' (ent %d, %s)", id, cls, hit, locked ? "locked" : "listed");
		return;
	}

	if (classname_in_list(g_cv_engents, cls))
	{
		dllfunc(DLLFunc_Use, hit, id, id, 2, 0.0);
		dbg("engineer %d used entity '%s'", id, cls);
	}
}

bool:warmup_hold_active()
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_warmhold))
	{
		return false;
	}

	new t1[32], t2[32], mode[16];
	get_pcvar_string(g_cv_team1name, t1, charsmax(t1));
	get_pcvar_string(g_cv_team2name, t2, charsmax(t2));
	get_pcvar_string(g_cv_teammode, mode, charsmax(mode));

	// Number mode does not need names, so it is allowed to hold.
	if (equali(mode, "number"))
	{
		return true;
	}
	if (!t1[0] || !t2[0])
	{
		return false;
	}
	return true;
}

/*
 * Learns the team names (or confirms the numbers) by LOOKING at who is connected,
 * instead of demanding they be configured by hand.
 *
 * Requiring manual config for something observable was the original sin here: with
 * the names blank, every team lookup returned 0, which silently disabled the warmup
 * hold, made ready-up uncountable and stopped any round from ever starting. Four
 * symptoms, one unset cvar.
 *
 * Returns true once teams are usable.
 */
bool:autodetect_teams()
{
	new mode[16];
	get_pcvar_string(g_cv_teammode, mode, charsmax(mode));

	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	if (pnum < 1)
	{
		return false;
	}

	// Collect the distinct non-zero numbers and non-empty names in play.
	new nums[4], nnum = 0;
	new names[4][32], nname = 0;
	new tname[32], tnum;

	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		tname[0] = 0;
		tnum = get_user_team(id, tname, charsmax(tname));

		if (tnum > 0 && nnum < sizeof(nums))
		{
			new bool:seen = false;
			for (new k = 0; k < nnum; k++)
			{
				if (nums[k] == tnum) { seen = true; }
			}
			if (!seen)
			{
				nums[nnum] = tnum;
				nnum++;
			}
		}

		if (tname[0] && nname < sizeof(names))
		{
			new bool:seenn = false;
			for (new k = 0; k < nname; k++)
			{
				if (equali(names[k], tname)) { seenn = true; }
			}
			if (!seenn)
			{
				copy(names[nname], charsmax(names[]), tname);
				nname++;
			}
		}
	}

	// Explicit modes are respected; only "auto" is allowed to decide.
	if (equali(mode, "number"))
	{
		return (nnum >= 2);
	}

	new t1[32], t2[32];
	get_pcvar_string(g_cv_team1name, t1, charsmax(t1));
	get_pcvar_string(g_cv_team2name, t2, charsmax(t2));

	if (t1[0] && t2[0])
	{
		return true;   // already configured, nothing to learn
	}

	// Two distinct names seen: adopt them and say so loudly, because silently
	// guessing team identity is the kind of thing that should never be invisible.
	if (nname >= 2)
	{
		set_pcvar_string(g_cv_team1name, names[0]);
		set_pcvar_string(g_cv_team2name, names[1]);
		set_pcvar_string(g_cv_teammode, "name");
		tlog("[TSM] Auto-detected teams: team1='%s' team2='%s'. Set tsm_team1_name/tsm_team2_name in the cfg to pin these.", names[0], names[1]);
		client_print(0, print_chat, "[MATCH] Teams detected: %s vs %s", names[0], names[1]);
		return true;
	}

	return false;
}

/* ---- team identity ------------------------------------------------------- */

/*
 * The mod's live team value is only consulted ONCE, when the match goes live, and
 * cached into g_match_team. Everything afterwards uses the cache, so a player whose
 * team the mod changes mid-round cannot corrupt the round.
 *
 * Numbers vs names is still an open question on TS (get_user_team() was observed
 * returning 0 with a meaningful name), so both are supported and chosen by cvar.
 */
tsm_live_team_of(id)
{
	/*
	 * The plugin's own assignment wins.
	 *
	 * Every TS-side route to joining a team failed on this server -- jointeam by name,
	 * jointeam by index, set_pev(pev_team) and the team userinfo key -- leaving
	 * get_user_team() at -1 with an empty name for everyone. Since g_match_team[] is
	 * already what round logic, alive counting, spawns, kill reports, balance and
	 * classes all read, it simply becomes the source of truth. TS is still told, but
	 * the match no longer depends on TS agreeing.
	 */
	if (g_match_team[id] == 1 || g_match_team[id] == 2)
	{
		return g_match_team[id];
	}

	/*
	 * Xash3D: only the plugin's own assignment counts. TS's team is not a reliable reading
	 * of who is on a side there -- a benched player can still read as his old side -- and
	 * the side menu, the side counts and the round logic all ask this. On GoldSrc the
	 * fallback below comes to the same answer (get_user_team() reads nothing there), so it
	 * stays for servers where TS's own teams do work.
	 */
	if (g_xash)
	{
		return 0;
	}

	new tname[32], mode[16];
	tname[0] = 0;
	new tnum = get_user_team(id, tname, charsmax(tname));

	get_pcvar_string(g_cv_teammode, mode, charsmax(mode));

	if (equali(mode, "number"))
	{
		if (tnum == 1 || tnum == 2)
		{
			return tnum;
		}
		return 0;
	}

	// "auto" resolves to name matching once autodetect_teams() has filled the names in.
	// name mode
	new t1[32], t2[32];
	get_pcvar_string(g_cv_team1name, t1, charsmax(t1));
	get_pcvar_string(g_cv_team2name, t2, charsmax(t2));

	if (t1[0] && equali(tname, t1))
	{
		return 1;
	}
	if (t2[0] && equali(tname, t2))
	{
		return 2;
	}
	return 0;
}

/// Snapshots everyone's team at match start. This is the only time the mod is asked.
cache_teams()
{
	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];

		// Never overwrite an assignment the player made themselves. This used to
		// re-read TS every round, which would wipe a plugin-side team back to 0 the
		// moment TS reported nothing.
		if (g_match_team[id] == 1 || g_match_team[id] == 2)
		{
			continue;
		}
		// Mirrored into g_side, which elimination does not clear: see g_side. Every route
		// that puts somebody on a side has to set it, or they stop counting toward that
		// side the moment they are benched and the match forfeits itself.
		g_match_team[id] = tsm_live_team_of(id);
		if (g_match_team[id]) { g_side[id] = g_match_team[id]; }
	}
}

// ---- lives and respawn waves ------------------------------------------------
// A death is still an elimination: voice, kill report and ghost are the usual ones.
// With lives left the player waits for their team's next wave, and a wave brings them
// back with the full loadout at one of their team's spawns. Running out of lives is the
// ordinary elimination.

/// Lives a player starts each round with: the class's tsm_class_lives entry, or 1 when
/// tsm_respawns is 0 or the class has no entry.
lives_for(id)
{
	if (!get_pcvar_num(g_cv_respawns))
	{
		return 1;
	}
	new ci = resolved_class(id) - 1;
	if (ci < 0 || ci >= TSM_MAXCLASS || class_lives_of(ci + 1) < 1)
	{
		return 1;
	}
	return class_lives_of(ci + 1);
}

/// One player's once-a-round abilities, ready again as a new round would have them: the stim, .ammo, the
/// Engineer's resupply and turret, the Medic's heal, the Officer's scan and reinforcements, the Mech's rockets.
refresh_abilities(id)
{
	g_stim_used[id] = false;
	g_ammo_used[id] = false;
	g_eng_used[id] = 0.0;
	g_medic_at[id] = 0.0;
	g_scan_next[id] = 0.0;
	g_reinforce_next[id] = 0.0;
	g_mech_rockets_used[id] = 0;
	g_mech_rocket_next[id] = 0.0;
	g_turret_used[id] = false;
	g_turret_carry[id] = false;
}

/// tsm_class_lives, read in class order like tsm_class_limits. Unlisted classes keep 1.
load_class_lives()
{
	for (new i = 0; i < TSM_MAXCLASS; i++)
	{
		g_class_lives[i] = 1;
	}

	new spec[128];
	get_pcvar_string(g_cv_classlives, spec, charsmax(spec));
	if (!spec[0])
	{
		return;
	}

	new rest[128], field[16], carry[128], idx = 0;
	copy(rest, charsmax(rest), spec);
	while (rest[0] && idx < TSM_MAXCLASS)
	{
		strtok(rest, field, charsmax(field), carry, charsmax(carry), ',', 1);
		trim(field);
		new v = str_to_num(field);
		g_class_lives[idx] = (v < 1) ? 1 : v;
		idx++;
		copy(rest, charsmax(rest), carry);
	}

	for (new i = 0; i < g_class_count; i++)
	{
		tlog("[TSM] Lives: %s, %d.", g_class_name[i], g_class_lives[i]);
	}
}

/// Does this player's class carry the Officer's wave call?
bool:class_is_officer(id)
{
	new ci = resolved_class(id) - 1;
	return (ci >= 0 && ci < g_class_count && g_class_perk[ci] == TSM_PERK_OFFICER);
}

/// How many players on the team are waiting for a wave.
///
/// g_pfall, not g_pf: the count has to include bots or the Officer sees a different
/// waiting total than a reinforce would act on -- and, before the wave fix, never
/// saw a waiting bot at all.
count_waiting(team)
{
	new n = 0;
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (g_revive_pending[id] && g_match_team[id] == team)
		{
			n++;
		}
	}
	return n;
}

/// Total lives remaining across the team, for the alive-vs-alive report. Counts every
/// player on the team, not just the ones alive right now -- a fully eliminated player's
/// lives are already down to 0 by then, so including them changes nothing.
///
/// g_pfall for the same reason as the waves: bots carry lives, and a filter that
/// skips bots underreported a side's remaining stock whenever a bot held any.
team_lives_left(team)
{
	new total = 0;
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (g_match_team[id] == team)
		{
			total += g_lives_left[id];
		}
	}
	return total;
}

/// Starts a round's lives: every player gets their class's lives, and each team's wave
/// clock starts from tsm_respawn_wave. The clock runs only while tsm_respawns is 1.
start_wave_clocks()
{
	remove_task(TSM_TASK_WAVE);

	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		g_lives_left[id] = lives_for(id);
		g_revive_pending[id] = false;
		g_revive_refused[id] = 0;
		remove_task(TSM_TASK_REVIVE + id);
	}

	// Per side: a claimed mode can give a side its own interval (wave_interval), and side 2
	// can wait for waves even with tsm_respawns 0 when the mode made it endless.
	g_wave_left[1] = wave_interval(1);
	g_wave_left[2] = wave_interval(2);
	g_wave_num[1] = 0;
	g_wave_num[2] = 0;
	if (side_respawns(1) || side_respawns(2))
	{
		set_task(1.0, "task_wave_tick", TSM_TASK_WAVE, "", 0, "b");
	}
}

/// Clears every life and every waiting player and stops the wave clock. Called at the start
/// and the end of each round, so nothing carries over.
lives_reset_round()
{
	remove_task(TSM_TASK_WAVE);

	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		g_lives_left[id] = 0;
		g_revive_pending[id] = false;
		g_reinforce_next[id] = 0.0;
		g_ammo_used[id] = false;
		g_turret_used[id] = false;
		g_turret_carry[id] = false;
		remove_task(TSM_TASK_REVIVE + id);
	}

	g_wave_left[1] = 0.0;
	g_wave_left[2] = 0.0;
}

/// Waves were switched off in a live round (tsm_respawns 0). Nobody waiting can come back now,
/// so every waiting player stays eliminated and the round can end. One side only (1 or 2)
/// when the other still has waves of its own; 0 for both.
///
/// Same filter question as the waves: leaving a bot pending while waves are off would leave
/// round-end logic believing someone is still waiting to come back.
respawns_off_cut(side = 0)
{
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (side && g_match_team[id] != side)
		{
			continue;
		}
		if (g_revive_pending[id])
		{
			g_revive_pending[id] = false;
			remove_task(TSM_TASK_REVIVE + id);
		}
	}
	check_round_end();
}

/// Sudden death with tsm_respawn_sudden 0: nobody waiting comes back. Every waiting player
/// stays eliminated, and the round can end.
respawn_sudden_cut()
{
	if (get_pcvar_num(g_cv_respsudden))
	{
		return;
	}

	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		g_revive_pending[id] = false;
		remove_task(TSM_TASK_REVIVE + id);
	}
	remove_task(TSM_TASK_WAVE);
	check_round_end();
}

/// A death with lives left: spend one and wait for the next wave. The last life's death is
/// final, exactly as an elimination always was. In sudden death with waves off nobody comes
/// back, so a death in that state is final too.
///
/// A side a claimed mode made endless (TSM_MODE_SIDE2_ENDLESS) spends nothing: every death on
/// it waits for that side's next wave, so the side can never be counted out. g_side, because it
/// is the side for the whole match and elimination never clears it.
lives_on_death(victim)
{
	if (g_state != ST_LIVE)
	{
		return;
	}
	if (g_side[victim] == 2 && mode_flag(TSM_MODE_SIDE2_ENDLESS))
	{
		g_revive_pending[victim] = true;
		g_died_at[victim] = get_gametime();
		dbg("lives: %d down on the endless side, waiting for its next wave", victim);
		return;
	}
	if (!get_pcvar_num(g_cv_respawns))
	{
		return;
	}
	if (g_sudden && !get_pcvar_num(g_cv_respsudden))
	{
		return;
	}
	if (g_lives_left[victim] <= 0)
	{
		return;
	}

	g_lives_left[victim]--;
	if (g_lives_left[victim] <= 0)
	{
		g_revive_pending[victim] = false;
		return;
	}

	g_revive_pending[victim] = true;
	g_died_at[victim] = get_gametime();
	client_print(victim, print_chat, "[MATCH] %d %s left -- back in the next wave.",
		g_lives_left[victim], (g_lives_left[victim] == 1) ? "life" : "lives");
	dbg("lives: %d down, %d left, waiting for team %d", victim, g_lives_left[victim], g_match_team[victim]);
}

/// Brings the team's waiting players back in one wave. A forced wave (the Officer's call,
/// amx_tsm_wave) takes everyone waiting. A natural wave takes only players dead for at least
/// tsm_respawn_seconds, so a death just before a wave waits for the next one.
///
/// Bots are members: fire_wave used to walk the same skip-bots list the spectate picks use,
/// so a bot waiting for a wave was never scheduled, never counted and never shown on the
/// waiting list -- the ".reinforce calls back two of three and leaves one behind" report,
/// where the one left standing was always a bot. g_pfall has no filter; the pending and
/// team guards below do the actual choosing.
fire_wave(team, bool:forced)
{
	if (!side_respawns(team) || g_state != ST_LIVE)
	{
		return 0;
	}
	if (g_sudden && !get_pcvar_num(g_cv_respsudden))
	{
		return 0;
	}

	new Float:now = get_gametime();
	new Float:minwait = get_pcvar_float(g_cv_respsecs);
	new offset = random_num(0, 7);   // where this wave starts along the team's points

	/*
	 * point_count is the SAME denominator pick_spawn_point will divide by for every one
	 * of this wave's players a moment from now (they all resolve through
	 * place_at_spawn(id, slot, true), i.e. tier = active_spawn_tier(team), the exact
	 * tier computed here). claimed[] tracks which of that tier's (offset + n) %
	 * point_count values THIS call has already handed out, so two players queued in the
	 * same wave never request the same point -- the ghost-vs-ghost collision
	 * pick_spawn_point cannot see on its own, because its occupancy scan only looks at
	 * players who are already alive, and two ghosts resolving on the same frame are
	 * both still ghosts to each other right up until they land.
	 *
	 * point_count <= 0 means this tier has no points of its own; place_at_spawn falls
	 * back to the other side's defaults or the map's own spawns, so there's nothing to
	 * be collision-aware against -- the slot is left as the old flat offset + n and
	 * pick_spawn_point's alive-occupancy check is the only guard, exactly as before.
	 */
	new tier = active_spawn_tier(team);
	new point_count = spawn_count_for_tier(team, tier);
	new bool:claimed[64];

	new players[32], pnum, id, n = 0;
	get_players(players, pnum, g_pfall);   // every waiting member, bots included: with the
	                                       // old skip-bots list a bot waiting for a wave was
	                                       // never scheduled and stayed behind forever
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (!g_revive_pending[id] || g_match_team[id] != team)
		{
			continue;
		}
		if (!forced && (now - g_died_at[id]) < minwait)
		{
			continue;
		}

		remove_task(TSM_TASK_REVIVE + id);

		if (point_count > 0)
		{
			new cand = (offset + n) % point_count;
			new tries = 0;
			while (claimed[cand] && tries < point_count)
			{
				cand = (cand + 1) % point_count;
				tries++;
			}
			claimed[cand] = true;
			g_revive_slot[id] = cand;
		}
		else
		{
			g_revive_slot[id] = offset + n;
		}

		g_revive_washed[id] = false;
		g_revive_waits[id] = 0;
		g_revive_active[id] = true;
		/*
		 * A natural wave keeps the ARM_STAGGER spacing between revive tasks, so a
		 * full team spine-walks in a body at a time. A forced wave -- the Officer's
		 * .reinforce above all -- wakes the whole waiting pool, bots included, within
		 * TSM_FORCED_STAGGER of each other rather than bit-for-bit simultaneously (see
		 * its own comment) -- still unmistakably "all at once" to a player. TS's own
		 * respawntime still decides when each player is taken back (a teammate who died
		 * seconds earlier waits out TS's deathcam), which is the only remaining delay
		 * that is TS's, not ours.
		 */
		set_task(forced ? (0.1 + TSM_FORCED_STAGGER * float(n)) : 0.1 + ARM_STAGGER * float(n), "task_revive", TSM_TASK_REVIVE + id);
		n++;
	}

	dbg("wave: team %d, %d revive(s), forced %d, tier %d, points %d", team, n, forced ? 1 : 0, tier, point_count);
	return n;
}

/// The Officer's list of teammates waiting for a wave, on the right of the screen. It takes HUD
/// channel 0, the one no other message here uses, and the wave clock redraws it every second, so
/// it goes away on its own once nobody is waiting.
show_waiting_list(id, team)
{
	new waiting = count_waiting(team);
	if (!waiting)
	{
		return;
	}

	new list[256], len = 0, shown = 0;
	len += formatex(list[len], charsmax(list) - len, "WAITING FOR A WAVE (%d)^n", waiting);

	new players[32], pnum, mate, mname[16];
	get_players(players, pnum, g_pfall);   // everyone, bots included
	for (new i = 0; i < pnum && shown < 6; i++)
	{
		mate = players[i];
		if (!g_revive_pending[mate] || g_match_team[mate] != team)
		{
			continue;
		}

		get_user_name(mate, mname, charsmax(mname));
		len += formatex(list[len], charsmax(list) - len, "%s^n", mname);
		shown++;
	}

	if (waiting > shown)
	{
		formatex(list[len], charsmax(list) - len, "+%d more", waiting - shown);
	}

	set_hudmessage(255, 140, 0, TSM_WAITLIST_X, TSM_WAITLIST_Y, 0, 0.0, 1.2, 0.0, 0.0, 0);
	show_hudmessage(id, "%s", list);
}

/// The wave clock: one tick a second while the round is live. Each team's clock runs down to
/// its next wave. Players who can see a timer get it: anyone waiting to come back, and any
/// living Officer. Someone out of lives gets no timer, because they are fully out.
public task_wave_tick()
{
	if (g_state != ST_LIVE || (!side_respawns(1) && !side_respawns(2)))
	{
		remove_task(TSM_TASK_WAVE);
		if (g_state == ST_LIVE)
		{
			respawns_off_cut();
		}
		return;
	}

	for (new t = 1; t <= 2; t++)
	{
		// One side can lose its waves while the other keeps them -- tsm_respawns 0 under a
		// mode whose side 2 is endless. Nobody left waiting on it may hold the round open.
		if (!side_respawns(t))
		{
			if (count_waiting(t) > 0)
			{
				respawns_off_cut(t);
			}
			continue;
		}

		// A side whose waves the mode brings itself (tsm_wave_seconds below 0) has no timer.
		if (g_wave_secs[t] < 0.0)
		{
			continue;
		}

		g_wave_left[t] -= 1.0;
		if (g_wave_left[t] <= 0.0)
		{
			g_wave_num[t]++;
			if (g_fw_wave != -1 && g_mode_name[0])
			{
				new ret;
				ExecuteForward(g_fw_wave, ret, t, g_wave_num[t]);
			}
			fire_wave(t, false);
			g_wave_left[t] = wave_interval(t);
		}
	}

	new Float:now = get_gametime();
	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (is_user_bot(id) || !is_user_connected(id))
		{
			continue;
		}

		new team = g_match_team[id];
		if (team != 1 && team != 2)
		{
			continue;
		}

		new bool:waiting = g_revive_pending[id];
		new bool:officer = (class_is_officer(id) && is_user_alive(id) && !g_elim[id]);
		if (!waiting && !officer)
		{
			continue;
		}

		set_hudmessage(255, 200, 80, -1.0, 0.12, 0, 0.0, 1.2, 0.0, 0.0, 4);
		if (waiting)
		{
			show_hudmessage(id, "RESPAWN WAVE IN %ds -- %d %s left",
				floatround(g_wave_left[team]), g_lives_left[id], (g_lives_left[id] == 1) ? "life" : "lives");
		}
		else
		{
			new Float:cool = g_reinforce_next[id] - now;
			if (cool > 0.0)
			{
				show_hudmessage(id, "WAVE IN %ds -- REINFORCE IN %ds", floatround(g_wave_left[team]), floatround(cool));
			}
			else
			{
				show_hudmessage(id, "WAVE IN %ds -- REINFORCE READY", floatround(g_wave_left[team]));
			}
			show_waiting_list(id, team);
		}
	}
}

/// A wave has come for this player: the timer ran out and they were waiting.
public task_revive(taskid)
{
	revive_player(taskid - TSM_TASK_REVIVE);
}

/// Brings one waiting player back. The armament is washed once per wave, before TS's own respawn
/// can apply it. A player TS still has dead is asked to respawn again until TS accepts, or until
/// the wait runs out. Nothing is undone until the player is alive. The gear follows in task_revive_arm.
revive_player(id)
{
	if (!is_user_connected(id))
	{
		return;
	}
	if (!g_revive_pending[id] || g_state != ST_LIVE)
	{
		g_revive_pending[id] = false;
		return;
	}

	if (!g_revive_washed[id])
	{
		g_issuing[id] = true;
		engclient_cmd(id, "rst_cfg");
		g_issuing[id] = false;
		g_revive_washed[id] = true;
	}

	/*
	 * TS's own respawn lands only once its death timer has run out, and only for a player in its
	 * observer state. A player who is still dead is asked again on every try and nothing else is done
	 * to them. A forced spawn is never used here: it leaves the observer state behind, so the player
	 * would read as alive while the client still shows a spectator.
	 */
	if (!is_user_alive(id))
	{
		/*
		 * Moved to the real spawn point WHILE STILL GHOSTED, before respawn can make
		 * them visible. The ghost is already invisible, non-solid and noclipping, so
		 * this is the same safe, unseen teleport the follow-camera already does every
		 * frame. Without it, "respawn" made the player visible again wherever the
		 * ghost camera had last put them -- hovering just over whichever teammate
		 * they had been following -- for a visible instant before task_revive_arm's
		 * own place_at_spawn corrected it a moment later.
		 */
		place_at_spawn(id, g_revive_slot[id], true);
		engclient_cmd(id, "respawn");
	}

	if (!is_user_alive(id))
	{
		if (float(++g_revive_waits[id]) * 0.5 < TSM_REVIVE_HOLD)
		{
			set_task(0.5, "task_revive", TSM_TASK_REVIVE + id);
			return;
		}

		/*
		 * TS did not take them back within the wait. The first time they stay pending for the next
		 * wave. The second time the elimination is final, the same as a death with no lives left.
		 */
		if (!g_revive_refused[id])
		{
			g_revive_refused[id] = 1;
			g_revive_active[id] = false;   // this attempt is over; normal spectate resumes until the next wave
			tlog("[TSM] Revive refused for %d -- waiting for the next wave.", id);
			return;
		}

		g_revive_pending[id] = false;
		g_revive_active[id] = false;
		g_elim[id] = true;
		g_elim_at[id] = 0.0;
		g_was_alive[id] = false;
		tlog("[TSM] Revive refused for %d -- stays eliminated.", id);
		check_round_end();
		return;
	}

	/*
	 * Alive now, so the elimination state is undone. It is left alone while TS still has the player
	 * dead, which is why this comes after the respawn.
	 */
	g_revive_pending[id] = false;
	g_revive_active[id] = false;
	g_revive_refused[id] = 0;
	remove_task(id + 7000);
	g_elim_at[id] = 0.0;
	g_elim[id] = false;
	g_spec_target[id] = 0;
	g_last_buttons[id] = 0;
	g_pending_elim[id] = 0.0;

	/*
	 * Moved to the real spawn point before the presentation restore makes them solid
	 * and visible -- the same "move while still hidden, then reveal" ordering already
	 * used four lines up, in the branch for a player TS has not actually respawned yet.
	 * Without this, a player who was already alive the whole wait (the steady-state
	 * case: TS auto-respawns almost instantly, so the ghost presentation usually sits
	 * on top of an already-alive entity) became solid/visible/damageable exactly where
	 * the elim camera's per-frame SetOrigin last parked them -- on top of the teammate
	 * they were watching -- for the 0.3s until task_revive_arm's own placement caught
	 * up. g_revive_slot[id] was set by fire_wave() before this task was even scheduled
	 * (see fire_wave), so it is valid here.
	 */
	place_at_spawn(id, g_revive_slot[id], true);
	restore_presentation(id);

	g_was_alive[id] = true;
	g_revive_tries[id] = 0;
	set_task(0.3, "task_revive_arm", TSM_TASK_REVIVE_ARM + id);
	client_print(id, print_chat, "[MATCH] RESPAWNED -- %d %s left.",
		g_lives_left[id], (g_lives_left[id] == 1) ? "life" : "lives");
	dbg("revive: %d back in play, %d %s left", id, g_lives_left[id], (g_lives_left[id] == 1) ? "life" : "lives");
}

/// The gear for a wave revive, handed over once the player is alive. The spawn clears the
/// inventory, so the kit goes on after it, and the placement comes last.
public task_revive_arm(taskid)
{
	new id = taskid - TSM_TASK_REVIVE_ARM;
	if (!is_user_connected(id) || g_state != ST_LIVE || g_elim[id])
	{
		return;
	}
	if (!is_user_alive(id))
	{
		if (++g_revive_tries[id] < 20)
		{
			set_task(0.2, "task_revive_arm", taskid);
		}
		return;
	}
	if (get_cvar_num("weaponrestriction") != 1)
	{
		strip_user_weapons(id);
	}
	spawn(id);

	/*
	 * Snapped to the correct, occupancy-scanned point THE INSTANT they are visible and
	 * solid again -- not after the gear. spawn() is what makes them alive/solid/visible,
	 * at wherever TS's own internal spawn selection puts them, not this plugin's chosen
	 * point; every tick between spawn() and here used to be spent standing somewhere
	 * uncontrolled, potentially overlapping whoever was already there. Moved ahead of
	 * arm_give_kit/apply_class_scale/set_user_health/set_user_armor below -- none of them
	 * read or depend on the player's position.
	 */
	place_at_spawn(id, g_revive_slot[id], true);

	new wl[32], wn;
	get_user_weapons(id, wl, wn);
	tlog("[TSM] revive gear for %d: deadflag %d, iuser1 %d, %d weapon(s) after the spawn",
		id, pev(id, pev_deadflag), pev(id, pev_iuser1), wn);

	new ci = resolved_class(id) - 1;
	arm_give_kit(id);
	apply_class_scale(id);
	set_user_health(id, g_class_hp[ci]);
	if (g_class_perk[ci] == TSM_PERK_MECH)
	{
		g_mech_hp_watch[id] = g_class_hp[ci];
	}
	if (g_class_ap[ci] > 0)
	{
		set_user_armor(id, g_class_ap[ci]);
	}
	g_armed[id] = true;

	if (is_user_bot(id))
	{
		new bool:bwas = g_in_userinfo[id];
		g_in_userinfo[id] = true;
		set_class_model(id, ci);
		g_in_userinfo[id] = bwas;
	}

	// After the class health above, so a mode's own health (survival's waves) is the last word.
	mode_notify(g_fw_armed, id);
}

/// The Officer's call: brings the team's waiting players back now, whatever the wave timer
/// says -- the whole pool, bots included, woken in the same tenth of a second. Once per
/// tsm_reinforce_cooldown seconds. Nobody waiting costs nothing. A teammate TS just killed
/// still waits out TS's own respawntime deathcam (server.cfg, 5s here); the revive poll
/// carries them the moment it is over, and they never wait for the next wave.
cmd_reinforce(id)
{
	if (!is_user_connected(id) || !is_user_alive(id) || g_elim[id])
	{
		client_print(id, print_chat, "[TSM] You have to be alive to call reinforcements.");
		return;
	}
	if (!is_officer(id))
	{
		client_print(id, print_chat, "[TSM] Only the Officer class can call reinforcements.");
		return;
	}
	if (!get_pcvar_num(g_cv_respawns))
	{
		client_print(id, print_chat, "[TSM] Respawn waves are off on this server.");
		return;
	}

	new Float:now = get_gametime();
	if (g_reinforce_next[id] > now)
	{
		client_print(id, print_center, "Reinforcements ready in %.0fs", g_reinforce_next[id] - now);
		return;
	}

	new team = g_match_team[id];
	if (count_waiting(team) == 0)
	{
		client_print(id, print_center, "No one is waiting to respawn");
		return;
	}

	g_reinforce_next[id] = now + get_pcvar_float(g_cv_reinforce);
	new n = fire_wave(team, true);
	// The side's own interval: a claimed mode's (tsm_uplink_wave on an uplink map), or tsm_respawn_wave.
	g_wave_left[team] = wave_interval(team);

	new name[32], players[32], pnum, mate;
	get_user_name(id, name, charsmax(name));
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		mate = players[i];
		if (g_match_team[mate] == team && !is_user_bot(mate))
		{
			client_print(mate, print_chat, "[MATCH] %s called reinforcements: %d coming back.", name, n);
		}
	}
}

/// Admin: force a respawn wave now. amx_tsm_wave with no number wakes both teams.
public cmd_wave(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (g_state != ST_LIVE)
	{
		console_print(id, "[TSM] Waves only run in a live round.");
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);
	if (team == 1 || team == 2)
	{
		console_print(id, "[TSM] Wave for team %d: %d revived.", team, fire_wave(team, true));
	}
	else
	{
		console_print(id, "[TSM] Waves for both teams: %d and %d revived.", fire_wave(1, true), fire_wave(2, true));
	}
	return PLUGIN_HANDLED;
}
count_alive(team)
{
	new n = 0;
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);   // bots wait for waves like anyone, now that they
	                                       // actually get them: a team whose remaining
	                                       // members are all wave-waiting bots must not
	                                       // be read as having lost the round
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (g_match_team[id] == team && ((!g_elim[id] && is_user_alive(id)) || g_revive_pending[id]))
		{
			n++;
		}
	}
	return n;
}

/// On their feet right now: alive and not eliminated, leaving out anyone waiting for a wave. What the
/// elimination report means by "alive"; count_alive() is what the round itself counts.
count_standing(team)
{
	new n = 0;
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (g_match_team[id] == team && !g_elim[id] && is_user_alive(id))
		{
			n++;
		}
	}
	return n;
}

/*
 * Applies the warmup presentation: hidden, non-solid, immune.
 *
 * Driven from the 1-second task rather than from PlayerPreThink, because PreThink is
 * suspect in this mod exactly as CmdStart turned out to be -- and the freeze proves
 * the timer path works. One second of granularity is irrelevant for something that
 * only has to be true for the whole of warmup.
 */
apply_warmup_hide(id)
{
	if (!is_user_connected(id) || !is_user_alive(id))
	{
		return;
	}
	set_pev(id, pev_takedamage, TSM_DAMAGE_NO);
	if (get_pcvar_num(g_cv_warmhide))
	{
		set_pev(id, pev_effects, pev(id, pev_effects) | TSM_EF_NODRAW);
		set_pev(id, pev_solid, TSM_SOLID_NOT);
	}
}

/*
 * Freezing, done with TS's own native rather than the engine.
 *
 * FM_CmdStart does NOT fire in this mod -- proven twice: the disarm test never
 * stopped anyone attacking, and the warmup hold reported active while players moved
 * freely. Zeroing the usercmd is therefore dead code here.
 *
 * tsfun gives ts_set_speed(), whose own include says "0.0 for speed will freeze
 * people". It carries a duration, so a hold has to be RENEWED while it applies --
 * task_tick does that every second.
 */
/*
 * Holds a player in place.
 *
 * This used to take a duration, because ts_set_speed takes one, and that native was
 * the wrong tool twice over: it scales the player's whole time base, so a held
 * player's animations crawl and dying while held plays the death in slow motion --
 * and ts_set_speed(id, 1.0, ...) does not reverse ts_set_speed(id, 0.0, ...), so the
 * hold never lifted at all. The hold is now a flag re-asserted every frame in
 * fw_prethink, which is confirmed to fire in TS, so there is nothing to expire and
 * nothing to renew.
 */
hold_player(id, bool:disarm)
{
	if (!is_user_connected(id))
	{
		return;
	}

	/*
	 * NEVER while TS is still killing them -- the same guard should_hold() already
	 * applies at its own call site, for the same reason (see should_hold's own comment,
	 * "the oldest bug in the file"). hold_player() is called unconditionally, once a
	 * second, from three separate loops with no deadflag check of their own -- without
	 * this, a player who dies during any of those windows gets re-frozen on the very
	 * next tick, before TS has finished killing them, and the death sequence that
	 * produces the corpse never finishes.
	 */
	if (pev(id, pev_deadflag) != TSM_DEAD_NO)
	{
		return;
	}

	if (!g_frozen[id])
	{
		g_save_maxspeed[id] = Float:pev(id, pev_maxspeed);
		if (g_save_maxspeed[id] <= 0.0)
		{
			g_save_maxspeed[id] = 320.0;
		}
	}

	g_frozen[id] = true;
	apply_freeze(id);

	// Weapons are only taken from players who are OUT of a round. During warmup a
	// frozen player cannot act anyway, and stripping them would throw away the
	// loadout they are about to need.
	if (disarm)
	{
		strip_user_weapons(id);
	}
}

/*
 * Whether this player should be held RIGHT NOW, derived purely from match state.
 *
 * The hold used to be a flag set by a one-second timer, which left gaps: anyone who
 * spawned just after a tick had up to a full second of free movement, and start_round
 * releases everybody before the freeze begins, so there was a guaranteed gap at the
 * top of every countdown. Deriving it per frame closes both.
 */
bool:should_hold(id)
{
	if (!is_user_connected(id))
	{
		return false;
	}

	/*
	 * NEVER while TS is still killing them. This is the oldest bug in the file and the
	 * cause of bodies vanishing the instant a player was shot.
	 *
	 * The ST_LIVE case below returns g_elim[id], and g_elim is set on the FRAME OF
	 * DEATH -- so the hold engaged on a player who had not finished dying, and then
	 * ran every frame. apply_freeze() zeroes pev_velocity, so the body could not fall
	 * and no death animation ever played; the caller also clears IN_ATTACK, which is
	 * the press TS waits on to respawn ("press Fire to Play!") and therefore to finish
	 * the death sequence that produces the corpse.
	 *
	 * The hold is for a player who is out of play and standing around, not for a
	 * corpse. Holding one is what took the body away.
	 */
	if (pev(id, pev_deadflag) != TSM_DEAD_NO)
	{
		return false;
	}

	/*
	 * Roaming beats every other reason to hold.
	 *
	 * .roam exists for placing spawn points: walking the map to pick positions is
	 * impossible while the warmup hold has you clamped in place, and doing it with a
	 * live match running means doing it under fire.
	 *
	 * Checked first so it overrides the spectator hold, the warmup hold and the freeze
	 * alike -- a roamer is deliberately outside all of them.
	 */
	if (g_roaming[id])
	{
		return false;
	}

	/*
	 * AN ELIMINATED PLAYER STAYS "HELD" HERE, and is freed where the hold is applied instead.
	 *
	 * Returning false for him looks right and is not: the else branch below calls
	 * release_player(), and that undoes EF_NODRAW, puts rendermode back to normal, makes him
	 * SOLID_SLIDEBOX again and -- the part that matters -- sets takedamage back to AIM. A ghost
	 * sent through it is a visible, solid, killable player standing in the middle of the round
	 * he was knocked out of.
	 *
	 * So he is still held as far as this is concerned, which keeps release_player away from him,
	 * and the hold itself gives him his movement back without touching any of the rest.
	 */

	// Spectators are held in every state. They are not in the match and must never be
	// able to act in it, but they stay in the world so they can still watch -- and the
	// hold only clamps movement and attack, so menus still work for them.
	if (is_spectating(id))
	{
		return true;
	}

	// Locked out for the whole match: held in every state until it ends.
	if (g_locked_out[id])
	{
		return (g_state != ST_WARMUP && g_state != ST_READYUP);
	}

	if (g_state == ST_FREEZE || g_state == ST_ROUNDEND)
	{
		return (tsm_live_team_of(id) != 0);
	}

	if (g_state == ST_WARMUP || g_state == ST_READYUP)
	{
		// Teamless players are never held -- they still have to reach the side menu.
		return (warmup_hold_active() && tsm_live_team_of(id) != 0);
	}

	if (g_state == ST_LIVE)
	{
		return g_elim[id];
	}

	return false;
}

/// Re-applies whichever hold mechanism tsm_freeze_method selects.
apply_freeze(id)
{
	if (!g_rcbot_held[id])
	{
		g_rcbot_held[id] = true;
		g_rcbot_held_count++;
		if (g_rcbot_held_count == 1)
		{
			server_cmd("rcbot config bot_stuck_speed -1");
			dbgv("rcbot stuck-watchdog disabled (%d held)", g_rcbot_held_count);
		}
	}

	new Float:zero[3];
	set_pev(id, pev_velocity, zero);

	// Same reasoning as apply_warmup_hide: a held player cannot fight back or move,
	// so without this he can still be farmed -- or killed outright by a stray hit
	// while frozen, which is how a late-placed player landing on an occupied spawn
	// point during the freeze tick used to die before the countdown even finished.
	set_pev(id, pev_takedamage, TSM_DAMAGE_NO);

	switch (get_pcvar_num(g_cv_freezemethod))
	{
		case 1:
		{
			// Kept selectable, but it does not actually hold anyone in TS: players
			// were measured walking around during warmup with this flag set.
			set_pev(id, pev_flags, pev(id, pev_flags) | TSM_FL_FROZEN);
		}
		default:
		{
			// Default. The flag is set as well because it costs nothing, but the
			// clamp that does the work is re-applied from the POST hooks, after TS
			// has written its own value for the frame.
			set_pev(id, pev_flags, pev(id, pev_flags) | TSM_FL_FROZEN);
			set_pev(id, pev_maxspeed, 1.0);
		}
	}

	/*
	 * NO FL_FROZEN ON A GHOST OR A CHOSEN SPECTATOR.
	 *
	 * Xash3D FWGS's SV_ParseClientMove zeroes every button, the movement and the impulse of a
	 * client carrying FL_FROZEN before the game DLL ever sees the move, so the click that changes
	 * who they watch (the attack cycle in fw_prethink) never arrived. They watch through the
	 * follow camera, which places them every frame, so the flag holds nothing for them anyway;
	 * and a ghost's punch lands on nobody (fw_takedamage refuses an eliminated attacker).
	 */
	if (g_elim[id] || is_spectating(id))
	{
		set_pev(id, pev_flags, pev(id, pev_flags) & ~TSM_FL_FROZEN);
	}
}

release_player(id)
{
	if (!is_user_connected(id))
	{
		return;
	}
	g_frozen[id] = false;

	if (g_rcbot_held[id])
	{
		g_rcbot_held[id] = false;
		g_rcbot_held_count--;
		if (g_rcbot_held_count <= 0)
		{
			g_rcbot_held_count = 0;
			server_cmd("rcbot config bot_stuck_speed 7");
			dbgv("rcbot stuck-watchdog restored (%d held)", g_rcbot_held_count);
		}
	}

	// Undo EVERY hold mechanism, not just the one tsm_freeze_method currently
	// selects. Otherwise a player held under one setting stays held forever after
	// the cvar changes, which is exactly how a stuck player goes unexplained.
	set_pev(id, pev_flags, pev(id, pev_flags) & ~TSM_FL_FROZEN);

	// MOVETYPE_NONE cannot move at all, and an eliminated player is left on
	// MOVETYPE_NOCLIP. Either one survives into the next round as "frozen in place"
	// that no amount of flag-clearing explains, so normal walking movement is
	// asserted rather than assumed.
	//
	// Skipped while roaming: should_hold() returns false for a roamer every frame
	// (that is the point of .roam), so this runs every frame too -- and a roamer
	// who types noclip to fly over the map had it reset back to walk the instant
	// they set it. This safety net exists to recover a STALE movetype left over
	// from a hold that was not cleaned up properly; a roamer choosing noclip for
	// themselves is neither of those.
	new mt = pev(id, pev_movetype);
	if (mt != TSM_MOVETYPE_WALK && !g_roaming[id])
	{
		set_pev(id, pev_movetype, TSM_MOVETYPE_WALK);
	}

	set_pev(id, pev_maxspeed, wanted_speed());
	set_user_maxspeed(id, wanted_speed());

	/*
	 * ts_set_speed is NOT called here, and that is the point.
	 *
	 * Players could move freely during warmup -- where hold_player runs every second
	 * and never calls ts_set_speed -- and froze the instant the round went live,
	 * which is the only moment release_player runs. The call meant to free them was
	 * freezing them. tsfun documents the speed argument and not the duration, so
	 * whatever ts_set_speed(id, 1.0, 0.0, 0.0) means to TS, it is not "restore".
	 *
	 * It is only used now when tsm_freeze_method is 3, which exists to reproduce the
	 * old behaviour deliberately.
	 */

	// Undo the warmup hide explicitly. Leaving this to the normal restore path would
	// mean anyone hidden during warmup walks into the round still invisible, which is
	// strictly worse than not hiding them at all.
	set_pev(id, pev_effects, pev(id, pev_effects) & ~TSM_EF_NODRAW);
	set_pev(id, pev_rendermode, TSM_RENDER_NORMAL);
	set_pev(id, pev_renderamt, 255.0);
	set_pev(id, pev_solid, TSM_SOLID_SLIDEBOX);

	/*
	 * LAST-LINE SAFETY NET, RIGHT BEFORE TAKEDAMAGE GOES LIVE AGAIN.
	 *
	 * This release branch ran instead of apply_freeze() this frame, so neither that
	 * zero nor fw_postthink_post's post-physics zero touched this frame's velocity.
	 * Whatever the last held frame's gravity left behind, or whatever
	 * PM_CheckStuck/PM_TryToUnstuck popped the origin through while velocity was being
	 * suppressed and nobody was watching, is still sitting in pev_velocity the instant
	 * takedamage flips to AIM below. Zeroed here so a body resting at the wrong height
	 * falls that height for real, from a standing start, instead of cashing in
	 * whatever fall state the hold silently built up in the one frame it finally can.
	 */
	new Float:relvel[3];
	pev(id, pev_velocity, relvel);
	new Float:zero[3];
	set_pev(id, pev_velocity, zero);
	dbg("release safety: %d had vel %.0f, onground %d, at the takedamage flip",
		id, vector_length(relvel), (pev(id, pev_flags) & FL_ONGROUND) ? 1 : 0);

	set_pev(id, pev_takedamage, TSM_DAMAGE_AIM);

	new rname[32];
	get_user_name(id, rname, charsmax(rname));
	dbg("released %s: movetype %d -> %d, maxspeed -> %.0f, FL_FROZEN cleared",
		rname, mt, pev(id, pev_movetype), Float:pev(id, pev_maxspeed));
}

/* ---- presentation: removing a player from play --------------------------- */

save_presentation(id)
{
	// The cloak's EF_NODRAW comes off first: whoever is saving this is about to hide him for
	// reasons of its own, and a snapshot holding the bit would put it back on the restore, with
	// nothing left that knows it is there.
	cloak_bots_show(id);

	if (g_saved[id])
	{
		return;
	}
	g_save_solid[id]      = pev(id, pev_solid);
	g_save_movetype[id]   = pev(id, pev_movetype);
	g_save_effects[id]    = pev(id, pev_effects);
	g_save_takedamage[id] = Float:pev(id, pev_takedamage);
	pev(id, pev_origin, g_save_origin[id]);
	g_saved[id] = true;
}

restore_presentation(id)
{
	if (!is_user_connected(id))
	{
		g_saved[id] = false;
		return;
	}

	if (g_saved[id])
	{
		set_pev(id, pev_solid,      g_save_solid[id]);
		set_pev(id, pev_movetype,   g_save_movetype[id]);
		set_pev(id, pev_effects,    g_save_effects[id]);
		set_pev(id, pev_takedamage, g_save_takedamage[id]);
	}
	else
	{
		// No snapshot: apply normal player values rather than leave them broken.
		set_pev(id, pev_solid,      TSM_SOLID_SLIDEBOX);
		set_pev(id, pev_movetype,   TSM_MOVETYPE_WALK);
		set_pev(id, pev_effects,    pev(id, pev_effects) & ~TSM_EF_NODRAW);
		set_pev(id, pev_takedamage, TSM_DAMAGE_AIM);
	}
	set_pev(id, pev_maxspeed, 320.0);
	release_player(id);
	g_saved[id] = false;
}

/// Parks an eliminated player out of the fight. Never touches iuser1 -- see header.
remove_from_play(id)
{
	/*
	 * Not while TS is still killing them.
	 *
	 * This is the one that made players vanish the instant they were shot. It is
	 * reached from a task as well as from the think hooks, so the guards there do not
	 * cover it -- and hiding the edict mid-death takes the player away before the mod
	 * has produced the body that is supposed to replace them.
	 *
	 * Deferred rather than dropped, and bounded so a player who never respawns is
	 * still taken out of play instead of retrying forever.
	 */
	new Float:since = (g_elim_at[id] > 0.0) ? (get_gametime() - g_elim_at[id]) : 0.0;

	/*
	 * The bound is WHICHEVER DEATH TIMER IS LARGER. The config carried
	 * tsm_death_delay 4.0 under tsm_death_linger 10.5 for a while, and the scheduled
	 * task then fired inside TS's death sequence -- animation plus a three second
	 * sit -- which took the dying body away mid-animation and read as the death cut
	 * short. Two timers the wrong way round must not be able to hide a body, so the
	 * ceiling is now the larger of the two.
	 */
	new Float:bound = get_pcvar_float(g_cv_deathlinger);
	if (get_pcvar_float(g_cv_deathdelay) > bound)
	{
		bound = get_pcvar_float(g_cv_deathdelay);
	}

	if (pev(id, pev_deadflag) != TSM_DEAD_NO
		&& g_elim_at[id] > 0.0
		&& since < bound)
	{
		dbgv("remove_from_play deferred for %d: TS still has them dying (deadflag %d, since %.1f of %.1f)",
			id, pev(id, pev_deadflag), since, bound);
		set_task(0.5, "task_remove_from_play", id + 7000);
		return;
	}

	/*
	 * The grace, on top of the deferral above.
	 *
	 * EVERY route out of play comes through this function -- the think hook the instant TS
	 * puts them back on their feet, the tsm_death_delay ceiling, the admin command -- so
	 * this is the one place the wait can be enforced that none of them can step around.
	 *
	 * Re-scheduled ONCE with exactly the time left, never in a loop: the task is removed
	 * first, and the delay shrinks to zero, so this cannot defer a player forever.
	 */
	if (g_elim_at[id] > 0.0)
	{
		new Float:waited = get_gametime() - g_elim_at[id];
		new Float:grace = get_pcvar_float(g_cv_deathgrace);
		if (grace > 0.0 && waited < grace)
		{
			dbg("remove_from_play held for %d: %.1f of %.1f seconds", id, waited, grace);
			remove_task(id + 7000);
			set_task(grace - waited, "task_remove_from_play", id + 7000);
			return;
		}
	}

	save_presentation(id);

	set_pev(id, pev_solid,      TSM_SOLID_NOT);
	set_pev(id, pev_movetype,   TSM_MOVETYPE_NOCLIP);
	set_pev(id, pev_effects,    pev(id, pev_effects) | TSM_EF_NODRAW);
	set_pev(id, pev_takedamage, TSM_DAMAGE_NO);

	// Frozen and disarmed through TS's own natives, because the engine-level route
	// does not work in this mod.
	hold_player(id, get_pcvar_num(g_cv_disarm) != DISARM_NONE);

	pick_spec_target(id);

	/*
	 * THE OUT-OF-PLAY MARK.
	 *
	 * Until here g_elim_at means "seconds since they were eliminated"; from this
	 * frame it means 0, and every per-frame check that reads it is answering one
	 * question -- is the takeout finished. Dropping the flag HERE, once, rather
	 * than at each caller, is what makes the leave-alone rule in fw_prethink hold
	 * for EVERY route into the ghost state: death-delay task, a respawned frame,
	 * an admin command -- whichever completed, the ghost is hidden from this frame
	 * on and re-asserted every frame after. Before this mark the task route
	 * finished its hide at tsm_death_delay 4.0 while the per-frame NODRAW still
	 * waited on the 10.5 linger window, so when TS next cleared effects the ghost
	 * re-appeared wherever the follow camera had carried them -- the blink.
	 */
	g_elim_at[id] = 0.0;
}

/* ---- following a teammate, without spectator mode ------------------------ */

/*
 * True when this viewer may watch that player.
 *
 * An ELIMINATED player watches their own side only -- they are still in the match
 * and must not become a camera pointed at the enemy.
 *
 * Someone who CHOSE to spectate has no side at all, and the old test compared their
 * team (0) against each candidate's, so it matched nobody and they could not follow
 * anyone. They get to watch both teams, which is the entire point of spectating.
 */
bool:may_watch(viewer, cand)
{
	if (cand == viewer || g_elim[cand] || !is_user_alive(cand))
	{
		return false;
	}
	if (g_match_team[cand] != 1 && g_match_team[cand] != 2)
	{
		return false;   // not playing, nothing to watch
	}

	new vteam = g_match_team[viewer];
	if (vteam != 1 && vteam != 2)
	{
		return true;    // no side of their own: anyone will do
	}
	return (g_match_team[cand] == vteam);
}

pick_spec_target(id)
{
	new players[32], pnum, cand;
	get_players(players, pnum, g_pfa);   // alive
	for (new i = 0; i < pnum; i++)
	{
		cand = players[i];
		if (may_watch(id, cand))
		{
			g_spec_target[id] = cand;
			return;
		}
	}
	g_spec_target[id] = 0;
}

cycle_spec_target(id)
{
	new players[32], pnum, cand;
	new found_current = 0;
	get_players(players, pnum, g_pfa);

	// Walk past the current target, then take the next eligible one.
	for (new pass = 0; pass < 2; pass++)
	{
		for (new i = 0; i < pnum; i++)
		{
			cand = players[i];
			if (!may_watch(id, cand))
			{
				continue;
			}
			if (pass == 0)
			{
				if (cand == g_spec_target[id])
				{
					found_current = 1;
				}
				else if (found_current)
				{
					g_spec_target[id] = cand;
					return;
				}
			}
			else
			{
				// Wrapped around.
				g_spec_target[id] = cand;
				return;
			}
		}
	}
}

/* ---- hooks --------------------------------------------------------------- */

public fw_cmdstart(id, uc_handle, seed)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return FMRES_IGNORED;
	}

	/*
	 * A dying player's input is left COMPLETELY alone, and this is what makes their
	 * body appear when they fall instead of seconds later.
	 *
	 * TS builds its corpse in PlayerDeathThink as soon as EITHER the player is
	 * pressing any button except IN_SCORE, OR three seconds have passed since the
	 * kill. The three seconds is only a fallback for someone touching nothing; a
	 * player who dies with a key down normally gets their body straight away.
	 *
	 * Zeroing the usercmd below removed the button half of that test, so the fallback
	 * was the only route left and every corpse waited out the full delay. It is set at
	 * the usercmd rather than on pev->button, which is why it survived the guards added
	 * to the think hooks -- this runs upstream of them.
	 *
	 * Eliminated players are still stripped once TS has finished with them; the guard
	 * only covers the window where the mod is still killing them.
	 */
	if (pev(id, pev_deadflag) != TSM_DEAD_NO)
	{
		return FMRES_IGNORED;
	}

	/*
	 * A ROAMER AND AN ELIMINATED PLAYER ARE OUTSIDE EVERY WIPE BELOW.
	 *
	 * should_hold() already exempts both, so neither is frozen -- but the three blocks that
	 * follow zero the buttons straight off the usercmd without ever asking it, which is why
	 * .roam gave you movement and nothing else: no attack, no +use, no impulse. You could walk
	 * to a spot and not open the door you were standing at.
	 *
	 * The same went for a player who had been eliminated. Out of the match is not the same as
	 * out of the game: he keeps his hands, and what makes him harmless is that he has no weapon,
	 * takes no damage and is not solid -- not that his keyboard has been taken away.
	 */
	if (g_roaming[id] || g_elim[id])
	{
		return FMRES_IGNORED;
	}

	// Warmup hold: players cannot move or act until the match is readied up. This is
	// what makes the plugin visibly in control instead of apparently absent.
	if ((g_state == ST_WARMUP || g_state == ST_READYUP) && warmup_hold_active())
	{
		set_uc(uc_handle, UC_Buttons, 0);
		set_uc(uc_handle, UC_Impulse, 0);
		set_uc(uc_handle, UC_ForwardMove, 0.0);
		set_uc(uc_handle, UC_SideMove, 0.0);
		set_uc(uc_handle, UC_UpMove, 0.0);
		return FMRES_IGNORED;
	}

	// Freeze time: nobody moves or acts.
	if (g_state == ST_FREEZE)
	{
		set_uc(uc_handle, UC_Buttons, 0);
		set_uc(uc_handle, UC_Impulse, 0);
		set_uc(uc_handle, UC_ForwardMove, 0.0);
		set_uc(uc_handle, UC_SideMove, 0.0);
		set_uc(uc_handle, UC_UpMove, 0.0);
		return FMRES_IGNORED;
	}

	if (g_state != ST_LIVE || !g_elim[id])
	{
		return FMRES_IGNORED;
	}

	// Read intent BEFORE stripping it, so the same hook that disarms is where the
	// spectator-cycle keypress is noticed.
	new buttons = get_uc(uc_handle, UC_Buttons);
	if ((buttons & IN_ATTACK) && !(g_last_buttons[id] & IN_ATTACK))
	{
		cycle_spec_target(id);
	}
	g_last_buttons[id] = buttons;

	/*
	 * A player who is ALREADY a spectator is left alone entirely.
	 *
	 * TS's own spectator is driving them at this point -- it is TS that prints "Attack to
	 * switch player" on their screen -- and wiping the buttons here ate the very keypress
	 * that message is asking for. Clicking did nothing, which is exactly how it was
	 * reported. There is nothing to disarm either: a spectator has no weapon, is not solid
	 * and takes no damage.
	 */
	if (is_spectating(id))
	{
		return FMRES_IGNORED;
	}

	if (get_pcvar_num(g_cv_disarm) != DISARM_NONE)
	{
		/*
		 * THE ATTACK BITS AND THE IMPULSE ARE LEFT ALONE. Movement is still taken.
		 *
		 * Wiping every button took the one keypress TS's own spectator asks for -- "Attack to
		 * switch player" -- and the impulse with it, which is how a menu is answered. An
		 * eliminated player has nothing to disarm: remove_from_play has already stripped them
		 * through hold_player, and they are non-solid and take no damage. There is nothing for
		 * attack to do here except change who they are watching.
		 */
		set_uc(uc_handle, UC_Buttons, buttons & (IN_ATTACK | IN_ATTACK2));
		set_uc(uc_handle, UC_ForwardMove, 0.0);
		set_uc(uc_handle, UC_SideMove, 0.0);
		set_uc(uc_handle, UC_UpMove, 0.0);
	}

	return FMRES_IGNORED;
}

/*
 * The "Game" column in the server browser.
 *
 * That column is the mod's game description, which the engine asks the game DLL for
 * on every server query -- it is not the hostname and not a cvar TS exposes. This is
 * how the custom modes in the browser list (Fu/Stunt/Boost, Zombie TDM, TSRP) get
 * their own entry: they supersede the DLL's answer.
 *
 * The string is cached rather than read per call, because this fires on every
 * incoming A2S_INFO query and a busy public server gets a lot of them.
 */
public fw_gamedesc()
{
	if (!g_gamedesc[0])
	{
		return FMRES_IGNORED;
	}

	forward_return(FMV_STRING, g_gamedesc);
	return FMRES_SUPERCEDE;
}

/*
 * Keeps a released player's maxspeed usable.
 *
 * Measured repeatedly at 0 during a live round with FL_FROZEN clear, movetype WALK,
 * solid SLIDEBOX and our own hold flag down -- motionless with zero velocity. A zero
 * maxspeed cannot move, so this is the last clamp standing. Whether TS zeroes it
 * deliberately or it is residue from a ts_set_speed freeze set by an earlier build is
 * unresolved; running post-DLL makes the question moot, because whatever TS writes is
 * already written by the time this runs.
 */
public fw_prethink_post(id)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_forcespeed))
	{
		return FMRES_IGNORED;
	}
	if (!is_user_alive(id))
	{
		return FMRES_IGNORED;
	}

	// Holding and releasing are the same job from here: whatever TS wrote this frame
	// has already been written, so this is the only place either value survives.
	if (g_frozen[id] || g_elim[id])
	{
		set_pev(id, pev_maxspeed, 1.0);
		return FMRES_IGNORED;
	}

	new Float:mult = class_speed_for(id);
	new Float:target = wanted_speed() * mult;

	/*
	 * A class that is slower than normal has to be written EVERY frame, not just when
	 * the value looks broken -- TS sets maxspeed from the held weapon each frame, so a
	 * one-off write is overwritten immediately.
	 */
	if (mult != 1.0)
	{
		set_pev(id, pev_maxspeed, target);
	}
	else if (Float:pev(id, pev_maxspeed) <= 1.0)
	{
		set_pev(id, pev_maxspeed, target);
		g_speed_fixes++;
	}

	return FMRES_IGNORED;
}

public fw_postthink_post(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return FMRES_IGNORED;
	}

	/*
	 * NOT guarded on is_user_alive here, deliberately: a player who has just died is exactly
	 * who needs his icon hidden, and the cloak's EF_NODRAW handed back, below.
	 *
	 * The speed clamp further down keeps its own alive check instead.
	 */
	if (!is_user_connected(id))
	{
		return FMRES_IGNORED;
	}

	// Above the death guard, because it writes to the ICON entity and never to the
	// player -- and a player who has just died is exactly who needs theirs hidden.
	update_class_icon(id);

	// His frame is done: the cloak's EF_NODRAW, lifted in fw_prethink, goes back on for RCBot --
	// or is let go, if he died or was hidden some other way meanwhile. See cloak_active().
	cloak_bots_restore(id);

	// Same reason as the prethink guard: while TS is killing them, the entity is its
	// to write, including the model the corpse is about to be built from.
	if (pev(id, pev_deadflag) != TSM_DEAD_NO)
	{
		return FMRES_IGNORED;
	}

	/*
	 * Defense in depth for the warmup/freeze hold. apply_freeze() (fw_prethink, the PRE
	 * forward on FM_PlayerPreThink) zeroes pev_velocity before PM_Move runs -- but
	 * PM_Move's own gravity/jump/stuck integration happens AFTER that, between the pre
	 * and post forwards on FM_PlayerPreThink, so that zero never survives past this
	 * frame's physics step. This forward is FM_PlayerPostThink, which runs strictly
	 * after PM_Move for this frame, so it is the one hook that can undo whatever
	 * gravity just added before it reaches the next frame. Deliberately not folded
	 * into any speed-tuning cvar check: this is a safety guard, not a tuning one.
	 */
	if (g_frozen[id] || g_elim[id])
	{
		new Float:zerovel[3];
		set_pev(id, pev_velocity, zerovel);
	}

	/*
	 * CLOAK, RE-ASSERTED EVERY FRAME, same reasoning as the model index just below: a render
	 * state written once is not proven to survive whatever TS does to a player next frame, and
	 * the model index fix exists precisely because a one-time write did not stick there.
	 *
	 * rendercolor is included, not just rendermode/renderamt/renderfx: medic's glow_player()
	 * overwrites it on any target including a cloaked one, and set_cloak() only writes it on the
	 * initial on-transition. It does nothing on screen (this rendermode ignores rendercolor for a
	 * studio model), but it is what the patched RCBot source compares against (CLOAK_COLOR), so
	 * an un-reasserted color would leave a glowed-then-cloaked player targetable to that build.
	 * While an Officer's scan has him it is black instead: no signature, so that build engages him
	 * for those seconds, as the deployed one does once cloak_bots_hide stands down.
	 *
	 * Deliberately NOT applied while spectating, eliminated, locked out, or outside a live round
	 * -- those paths set rendermode themselves (the warmup hold and spectator blocks in
	 * fw_prethink), and this must never fight them for it. set_cloak(id, false) runs once, on
	 * the transition into any of those states below, rather than being left to this block to
	 * notice -- this block only RE-ASSERTS an active cloak, it does not decide when one ends.
	 */
	if (g_cloaked[id])
	{
		if (!is_spectating(id) && !g_elim[id] && !g_locked_out[id] && g_state == ST_LIVE)
		{
			set_pev(id, pev_rendermode, TSM_RENDER_TEXTURE);
			set_pev(id, pev_renderamt, get_pcvar_float(g_cv_cloakopacity));
			set_pev(id, pev_renderfx, TSM_RENDERFX_NONE);
			if (g_scan_until[id] > get_gametime())
			{
				new Float:nocolor[3];
				set_pev(id, pev_rendercolor, nocolor);
			}
			else
			{
				set_pev(id, pev_rendercolor, CLOAK_COLOR);
			}
		}
		else
		{
			// Out of the round some other way: the cloak ends silently, no sound or flash --
			// those are for a player choosing to end it, not the match choosing for them.
			set_cloak(id, false, true);
		}
	}

	/*
	 * Enforce the class model, every frame, SILENTLY.
	 *
	 * This is what finally makes class models stick. Writing the userinfo "model" key
	 * only asks: TS answers on spawn and on every userinfo change by re-applying its
	 * own mp_teammodels pick, and since each key write raises another userinfo change,
	 * arguing with it is what made the model cycle every few seconds.
	 *
	 * pev->modelindex is the model the engine actually draws, and writing it raises no
	 * event whatsoever. So TS keeps the key, we keep the picture, and neither provokes
	 * the other. One integer compare per player per frame, a write only when TS has
	 * just moved it.
	 */
	new want_model = g_model_want_idx[id];

	/*
	 * A spectator keeps their side model in g_model_want_idx and is drawn with the invisible
	 * model here, in the one place that draws; g_model_want_idx is left alone, so a round
	 * reset drops the override by itself.
	 *
	 * An ELIMINATED player is hidden with EF_NODRAW instead, from the first frame TS puts
	 * them back on their feet, so the server stops sending them at all. A model index would
	 * not hide them: with more than one player slot, GoldSrc and FWGS both draw a player
	 * from their userinfo "model" key (R_StudioSetupPlayerModel loads
	 * models/player/<key>/<key>.mdl) and use the model index only when that file is
	 * missing, and an eliminated player's key still names the model they played in.
	 *
	 * TS's corpse is its own entity and is drawn from that same key, so hiding the player
	 * leaves it alone -- TS's own death sequence does exactly this, building the corpse and
	 * then putting the player into observer mode under EF_NODRAW. The one thing EF_NODRAW
	 * must not reach is the dying player, because TS makes no corpse for a hidden one; the
	 * deadflag guard above keeps this line away from them until TS has respawned them.
	 */
	if (g_elim[id] && !is_spectating(id))
	{
		set_pev(id, pev_effects, pev(id, pev_effects) | TSM_EF_NODRAW);
	}
	else if (is_spectating(id))
	{
		new sidx = spec_model_index();
		if (sidx > 0)
		{
			want_model = sidx;
		}
	}

	if (want_model > 0 && pev(id, pev_modelindex) != want_model)
	{
		set_pev(id, pev_modelindex, want_model);
	}

	/*
	 * The class height, on the same terms as the model above.
	 *
	 * apply_class_scale() runs at arm time, and that is during the freeze -- where
	 * class_scale_for() answers 1.0 -- so the one write that ever mattered was the
	 * reset to normal. The Heavy went live at ordinary height and nothing applied the
	 * 1.50 again. One float compare per frame here is what keeps him tall, and it
	 * falls back to normal on its own the moment the round is not live.
	 */
	new Float:want_scale = class_scale_for(id);
	new Float:have_scale = Float:pev(id, pev_scale);
	if (want_scale == 1.0)
	{
		if (have_scale != 0.0)
		{
			set_pev(id, pev_scale, 0.0);
		}
	}
	else if (have_scale != want_scale)
	{
		set_pev(id, pev_scale, want_scale);
	}

	/*
	 * Hold a killed player where they fell, AFTER the game DLL has had the frame.
	 *
	 * This is the whole "people go invisible the instant they are killed" bug, and
	 * it was a hook-ordering mistake of exactly the kind the maxspeed clamp below
	 * already exists to work around.
	 *
	 * TS is a deathmatch mod and respawns a dead player almost immediately, which
	 * teleports them to a spawn point. From everyone else's view the body does not
	 * fall -- it simply stops existing, and the corpse TS leaves behind turns up a
	 * moment later with no death attached to it.
	 *
	 * The first attempt at this pinned the origin from the PRE hook, which runs
	 * BEFORE the DLL. The DLL moved them anyway and the pin was overwritten on the
	 * same frame, which is precisely the reported flicker of a body vanishing and
	 * something reappearing shortly after. Written from the POST hook it lands
	 * after the DLL has finished, so it is the value that survives the frame.
	 *
	 * Refusing the respawn outright through Ham_Spawn would be cleaner, and that is
	 * what 0.99 tried. The debug log proves that hook never fires once in this mod:
	 * zero hits across a whole session with verbose logging on, while the
	 * PlayerPreThink path logged 28,565. So this is built on the hook that is
	 * demonstrably delivered rather than the one that ought to be.
	 */


	if (!get_pcvar_num(g_cv_forcespeed) || !is_user_alive(id))
	{
		return FMRES_IGNORED;
	}

	if (g_frozen[id] || g_elim[id])
	{
		set_pev(id, pev_maxspeed, 1.0);
		return FMRES_IGNORED;
	}

	new Float:pmult = class_speed_for(id);
	new Float:ptarget = wanted_speed() * pmult;

	if (pmult != 1.0)
	{
		set_pev(id, pev_maxspeed, ptarget);
	}
	else if (Float:pev(id, pev_maxspeed) <= 1.0)
	{
		set_pev(id, pev_maxspeed, ptarget);
		g_speed_fixes_post++;
	}

	return FMRES_IGNORED;
}

/// Normal running speed for this server, with a sane fallback.
/*
 * The movement multiplier this player's class imposes, or 1.0.
 *
 * Only while a round is LIVE, because that is the only time the class loadout is
 * actually in their hands -- a Heavy should not be lumbering around warmup before
 * they have been handed the M60.
 */
Float:class_speed_for(id)
{
	if (g_state != ST_LIVE || !get_pcvar_num(g_cv_classes) || !g_class_count)
	{
		return 1.0;
	}

	new c = g_player_class[id];
	if (c < 1 || c > g_class_count)
	{
		return 1.0;
	}

	return g_class_speed[c - 1];
}

/*
 * How tall this player's class is drawn, right now.
 *
 * Mirrors class_speed_for() exactly, including the ST_LIVE gate: a Heavy should not be
 * towering over warmup before he has been handed the M60, and more usefully it means the
 * height falls away on its own the moment a round ends, a match ends, or the server drops
 * back to warmup -- there is no state to get stuck.
 */
Float:class_scale_for(id)
{
	if (g_state != ST_LIVE || !get_pcvar_num(g_cv_classes) || !g_class_count)
	{
		return 1.0;
	}
	if (!get_pcvar_num(g_cv_classscale))
	{
		return 1.0;
	}

	new c = g_player_class[id];
	if (c < 1 || c > g_class_count)
	{
		return 1.0;
	}

	return g_class_scale[c - 1];
}

/// Draws the player at their class's height, or back at normal.
apply_class_scale(id)
{
	if (!is_user_connected(id))
	{
		return;
	}
	new Float:k = class_scale_for(id);
	// 1.0 and 0.0 both mean "normal" to the renderer, and 0.0 is what an untouched
	// entity carries -- so normal is written as 0.0 to leave nothing behind.
	set_pev(id, pev_scale, (k == 1.0) ? 0.0 : k);
}

Float:wanted_speed()
{
	new Float:want = get_cvar_float("sv_maxspeed");
	if (want <= 1.0)
	{
		want = 320.0;
	}
	return want;
}

/*
 * Holds a player on the team they started the round with.
 *
 * TS changes team from the userinfo "team" key, so the change arrives here before
 * anything else sees it and can simply be written back. Doing it here rather than on
 * the one-second tick matters: a correction a second later still lets someone switch,
 * shoot, and switch back, and alive-counting is wrong for every frame in between.
 */
/*
 * Puts someone who may not play back on the bench, and hides them.
 *
 * A late joiner was already eliminated and taken out of play, but they were left ON a
 * playing side wearing a player model: they showed on the scoreboard as a man on that
 * team, counted to anyone reading the sides by eye, and could sit in the middle of a
 * firefight as a body nobody could shoot. This moves them to the spectator team as well
 * and puts the Invisible model on them, so they are watching in every sense.
 *
 * The model is written the same way class models are, and is enforced per frame by
 * fw_postthink_post like any other -- so TS re-applying its own pick does not undo it.
 */
park_spectator(id, const why[])
{
	if (!is_user_connected(id) || is_user_bot(id))
	{
		return;
	}

	g_elim[id] = true;
	remove_from_play(id);
	set_ts_spectator(id);
	set_spectator_model(id);

	client_print(id, print_chat, "[MATCH] %s", why);
}

/// Deferred out of fw_userinfo, which must not be re-entered while it is deciding.
public task_park_spectator(taskid)
{
	new id = taskid - 11000;
	if (!is_user_connected(id) || !g_locked_out[id])
	{
		return;
	}
	park_spectator(id, "A match is in progress -- you are benched until it finishes.");
}

public fw_userinfo(id, buffer)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return FMRES_IGNORED;
	}

	/*
	 * Our own SetClientKeyValue re-enters this forward, and the re-entry is SUPERCEDED
	 * rather than ignored.
	 *
	 * Ignoring it stopped the recursion but still handed our write to the mod, whose
	 * handler answers by replacing the model with its own random team pick -- so the
	 * value was gone before the frame ended. Superceding stops the recursion just the
	 * same AND keeps the mod out of a change it did not make.
	 *
	 * Only the re-entry. A userinfo change the mod or the player raised is still passed
	 * through, because TS has to process those for the scoreboard and team assignment.
	 *
	 * Checked above tsm_team_lock, because the guard has to hold even with team locking
	 * switched off -- the model writes happen either way.
	 */
	if (g_in_userinfo[id])
	{
		return FMRES_SUPERCEDE;
	}

	if (!get_pcvar_num(g_cv_teamlock))
	{
		return FMRES_IGNORED;
	}

	// Teams are only fixed once a match is actually running. Warmup is when people
	// are supposed to be picking sides.
	if (g_state != ST_FREEZE && g_state != ST_LIVE && g_state != ST_ROUNDEND)
	{
		return FMRES_IGNORED;
	}

	/*
	 * THE HOLE THIS CLOSES: someone with no side of their own, taking one mid-match.
	 *
	 * Everything below locks a player to the team they already have, and the early
	 * return under it skips anyone whose g_match_team is 0 -- which is precisely the
	 * spectator, or the late joiner, who is in the act of joining. The plugin's own
	 * .team menu refuses during a match, but TS's native one does not go through it, so
	 * that was the way in: pick a side from the mod's menu, land on it, unbalance the
	 * round.
	 *
	 * Deferred to a task rather than acted on here, because putting them back means
	 * writing userinfo and this forward must not be re-entered while it is deciding.
	 */
	if (is_user_connected(id) && !is_user_bot(id) && g_match_team[id] < 1)
	{
		new got[32];
		engfunc(EngFunc_InfoKeyValue, buffer, "team", got, charsmax(got));

		new t1[32], t2[32];
		team_rawname(1, t1, charsmax(t1));
		team_rawname(2, t2, charsmax(t2));

		if (got[0] && (equali(got, t1) || equali(got, t2)))
		{
			g_locked_out[id] = true;
			remove_task(id + 11000);
			set_task(0.2, "task_park_spectator", id + 11000);
			dbgv("late join refused: %d tried to take '%s' mid-match", id, got);
		}
	}

	if (!is_user_connected(id) || g_match_team[id] < 1)
	{
		return FMRES_IGNORED;
	}

	new want[32];
	team_rawname(g_match_team[id], want, charsmax(want));
	if (!want[0])
	{
		return FMRES_IGNORED;   // nothing reliable to put them back on
	}

	new got[32];
	engfunc(EngFunc_InfoKeyValue, buffer, "team", got, charsmax(got));

	/*
	 * The class model is re-asserted on EVERY userinfo change, not only the ones that
	 * also needed the team key corrected.
	 *
	 * TS re-applies its own mp_teammodels pick from CTSGameRules::GetPlayerModel on
	 * this same event. The re-assert used to sit BELOW the early return just under
	 * this comment, so whenever the team key was already right -- which is nearly
	 * always -- the function returned and TS random team model stood. That is why
	 * everyone wore a random team model instead of the one their class specifies.
	 */
	/*
	 * resolved_class(), NOT g_player_class.
	 *
	 * g_player_class is 0 for anyone who never opened the class menu, which is most
	 * players and every bot -- they play tsm_default_class instead. Keying the
	 * re-assert off the raw value meant TS own mp_teammodels pick stood for all of
	 * them, which is why loadout models were still wrong. resolved_class() is the
	 * class they are actually playing, and it is what the loadout path already uses.
	 */
	new uci = resolved_class(id) - 1;
	if (uci >= 0)
	{
		g_in_userinfo[id] = true;
		set_class_model(id, uci);
		g_in_userinfo[id] = false;
	}

	if (!got[0] || equali(got, want))
	{
		return FMRES_IGNORED;
	}

	g_in_userinfo[id] = true;
	engfunc(EngFunc_SetClientKeyValue, id, buffer, "team", want);

	// TS re-applies its team model on this same event, so a class model has to be
	// re-asserted here or it reverts within about thirty frames.
	if (uci >= 0)
	{
		set_class_model(id, uci);
	}
	g_in_userinfo[id] = false;

	client_print(id, print_chat, "[MATCH] Teams are locked until the match ends. You are staying on %s.", want);
	dbg("team lock: %d tried to move to '%s', put back on '%s'", id, got, want);

	// NOT superceded. Superceding stops the mod processing the userinfo change at all,
	// which breaks the scoreboard and team assignment outright. The value has already
	// been corrected above, so letting TS handle it is both safe and necessary.
	return FMRES_IGNORED;
}

/*
 * Writes the class model AFTER TS has written its own.
 *
 * This runs post, so by the time it is reached CHalfLifeTeamplay has already forced
 * the key to a random model from the team list. Overwriting it here is the last word
 * on the value, and the pre hook supercedes the re-entry our write causes so the mod
 * does not simply answer again.
 *
 * resolved_class(), not g_player_class: the latter is 0 for anyone who never opened
 * the class menu, which is most players and every bot.
 */
public fw_userinfo_post(id, buffer)
{
	if (!get_pcvar_num(g_cv_enabled) || !get_pcvar_num(g_cv_modelpost))
	{
		return FMRES_IGNORED;
	}
	if (!is_user_connected(id) || g_match_team[id] < 1 || !g_class_count)
	{
		return FMRES_IGNORED;
	}
	if (g_in_userinfo[id])
	{
		return FMRES_IGNORED;   // our own write coming back round
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0)
	{
		return FMRES_IGNORED;
	}

	// Forget the write cache: TS has just moved the key, so set_class_model would
	// otherwise decide the model it last wrote is still in place and do nothing.
	g_model_last[id][0] = 0;

	g_in_userinfo[id] = true;
	set_class_model(id, ci);
	g_in_userinfo[id] = false;

	return FMRES_IGNORED;
}

/*
 * Re-applies mp_teamlist (and optionally mp_teammodels) after the map has loaded.
 *
 * teamlist, teammodels, mapteams and defaultteam are worldspawn KEYVALUES, so the map
 * sets them when it spawns -- which is after server.cfg and listenserver.cfg have run.
 * With mp_teamoverride 1 the map wins, and correctly quoted config lines are simply
 * discarded a moment later. That is why mp_teamlist kept reverting to names nobody
 * configured and mp_teammodels kept emptying.
 *
 * The list is built from tsm_team1_name / tsm_team2_name, so the mod's teams and the
 * plugin's idea of the teams cannot drift apart -- which is the root of most of the
 * team-detection trouble this plugin has had.
 */
/*
 * Refuses to let a team name be long enough to break TS's own storage.
 *
 * Silent corruption is the worst kind: the join appears to succeed, the plugin and
 * the mod disagree, and every symptom points somewhere else. Worth a loud line at
 * every map load.
 */
check_team_names()
{
	new n[32];

	for (new t = 1; t <= 2; t++)
	{
		team_rawname(t, n, charsmax(n));
		if (n[0] && strlen(n) > TSM_MAX_TEAMNAME)
		{
			tlog("[TSM] *** TEAM NAME TOO LONG: '%s' is %d characters. TS truncates team names to %d.",
				n, strlen(n), TSM_MAX_TEAMNAME);
			tlog("[TSM] *** Nobody will be able to join that side -- the mod will show them as spectators.");
			tlog("[TSM] *** Shorten tsm_team%d_name and mp_teamlist, then change map. Use tsm_team%d_label for the long display name.",
				t, t);
		}
	}
}

force_team_list()
{
	if (!get_pcvar_num(g_cv_forceteams))
	{
		return;
	}

	new t1[32], t2[32];
	team_rawname(1, t1, charsmax(t1));
	team_rawname(2, t2, charsmax(t2));

	if (!t1[0] || !t2[0])
	{
		return;   // nothing trustworthy to force
	}

	new sp[32];
	get_pcvar_string(g_cv_specteam, sp, charsmax(sp));

	// Quoted: an unquoted semicolon ends the command early in the engine's command
	// buffer, which silently drops everything after the first team.
	if (sp[0])
	{
		server_cmd("mp_teamlist ^"%s;%s;%s^"", t1, t2, sp);
	}
	else
	{
		server_cmd("mp_teamlist ^"%s;%s^"", t1, t2);
	}

	new models[96];
	get_pcvar_string(g_cv_forcemodels, models, charsmax(models));
	if (models[0])
	{
		server_cmd("mp_teammodels ^"%s^"", models);
	}

	server_exec();

	/*
	 * Read back rather than reconstructed. This line used to print "t1;t2" from the
	 * local variables regardless of what was actually sent, so it reported a two-team
	 * list while the command above was setting three -- the log was wrong, not the code.
	 */
	new live[96];
	get_cvar_string("mp_teamlist", live, charsmax(live));
	tlog("[TSM] mp_teamlist is now '%s' (spectator slot %d).", live, live_spectator_index());

	/*
	 * BOTH menus are rebuilt here, not just the team one.
	 *
	 * This runs once at plugin_cfg and again on a short delay. The side menu worked
	 * and the class menu did not, from near-identical code -- the only difference was
	 * that the side menu got this second, later build and the class menu was only ever
	 * created during plugin_cfg.
	 */
	build_team_menu();
	build_class_menu();

	tlog("[TSM] Menus built: side=%d class=%d (%d class(es) parsed).",
		g_team_menu, g_class_menu, g_class_count);
}

public task_force_teams()
{
	force_team_list();
}

refresh_gamedesc()
{
	// The match mode off: TS's own description (fw_gamedesc leaves an empty one alone).
	if (!get_pcvar_num(g_cv_enabled))
	{
		g_gamedesc[0] = 0;
	}
	else if (siege_count() > 0)
	{
		get_pcvar_string(g_cv_gamedesc_siege, g_gamedesc, charsmax(g_gamedesc));
	}
	else if (g_mode_name[0])
	{
		// The claimed mode's own name: "Uplink", "Wave Survival". A claim is refused on a
		// siege map, so the branch above never hides one.
		copy(g_gamedesc, charsmax(g_gamedesc), g_mode_desc);
	}
	else
	{
		get_pcvar_string(g_cv_gamedesc, g_gamedesc, charsmax(g_gamedesc));
	}
}

/// The players on a side, for the presence helper: every connected player on that side, bots
/// included, alive or eliminated alike, since the card shows the roster.
presence_side_count(side)
{
	new n = 0;
	for (new id = 1; id < MAXPL; id++)
	{
		if (g_match_team[id] == side && is_user_connected(id))
		{
			n++;
		}
	}
	return n;
}

/// What the Discord card reads, published into serverinfo (pres_set) once a second: the siege progress
/// ("2/5" on a siege map, empty elsewhere; between rounds a siege map reads 0 of its
/// objectives), the side that attacks the objectives ("1" or "2", empty elsewhere), and how
/// many players each side has, and how many of them are alive.
/*
 * One of the card's values, kept in its cvar and, on Xash, in serverinfo: "serverinfo <key> <value>"
 * sets it there and sends every client the whole string again, which is what the card reads from.
 * Only when it changed, since each send is the whole string to everyone. Steam's GoldSrc has no such
 * command, and no client of it reads the card, so there the cvar alone is kept.
 */
pres_set(pcvar, const key[], const value[])
{
	new was[64];
	get_pcvar_string(pcvar, was, charsmax(was));
	if (equal(was, value))
	{
		return;
	}
	set_pcvar_string(pcvar, value);
	if (g_xash)
	{
		server_cmd("serverinfo %s ^"%s^"", key, value);
	}
}

refresh_presence()
{
	// The match mode off: nothing for the card but the map's own name and the player counts.
	if (!get_pcvar_num(g_cv_enabled))
	{
		pres_set(g_cv_presiege, "tsm_pres_siege", "");
		pres_set(g_cv_presattack, "tsm_pres_attack", "");
		pres_set(g_cv_presmode, "tsm_pres_mode", "");
		pres_set(g_cv_presprog, "tsm_pres_prog", "");
		pres_set(g_cv_presside1, "tsm_pres_side1", "");
		pres_set(g_cv_presside2, "tsm_pres_side2", "");
		pres_set(g_cv_presalive1, "tsm_pres_alive1", "");
		pres_set(g_cv_presalive2, "tsm_pres_alive2", "");
		return;
	}
	new count = siege_count();
	new text[16], attack[4], num[8];
	text[0] = 0;
	attack[0] = 0;
	if (count > 0)
	{
		formatex(text, charsmax(text), "%d/%d", (g_state == ST_LIVE) ? g_obj_taken : 0, count);
		num_to_str(get_pcvar_num(g_cv_objteam), attack, charsmax(attack));
	}
	pres_set(g_cv_presiege, "tsm_pres_siege", text);
	pres_set(g_cv_presattack, "tsm_pres_attack", attack);
	// The mode, named whenever match mode runs, so the card never has to guess on an H9 server: the
	// claimed mode's key ("uplink", "survival", "mechwarrior"), else "siege" on a siege map, else
	// "match". Empty with tsm_enabled 0: the card then names the mode by the map.
	if (!get_pcvar_num(g_cv_enabled))
	{
		pres_set(g_cv_presmode, "tsm_pres_mode", "");
	}
	else if (g_mode_name[0])
	{
		pres_set(g_cv_presmode, "tsm_pres_mode", g_mode_name);
	}
	else
	{
		pres_set(g_cv_presmode, "tsm_pres_mode", (count > 0) ? "siege" : "match");
	}
	if (g_mode_name[0])
	{
		pres_set(g_cv_presprog, "tsm_pres_prog", g_mode_prog);
	}
	else
	{
		pres_set(g_cv_presprog, "tsm_pres_prog", "");
	}

	num_to_str(presence_side_count(1), num, charsmax(num));
	pres_set(g_cv_presside1, "tsm_pres_side1", num);
	num_to_str(presence_side_count(2), num, charsmax(num));
	pres_set(g_cv_presside2, "tsm_pres_side2", num);

	num_to_str(count_alive(1), num, charsmax(num));
	pres_set(g_cv_presalive1, "tsm_pres_alive1", num);
	num_to_str(count_alive(2), num, charsmax(num));
	pres_set(g_cv_presalive2, "tsm_pres_alive2", num);
}

public fw_prethink(id)
{
	// The cloak's EF_NODRAW is for RCBot only: off for his own frame, so TS never sees it while
	// it runs him. fw_postthink_post puts it back. See cloak_active().
	if (id >= 1 && id < MAXPL && g_cloak_nodraw[id])
	{
		set_pev(id, pev_effects, pev(id, pev_effects) & ~TSM_EF_NODRAW);
	}

	g_prethink_calls++;

	// Counted per player because the bot fixes that run from here are worthless if
	// this forward never fires for a fake client, and that is not something the
	// global counter above can show.
	if (id >= 1 && id < MAXPL)
	{
		g_bot_prethinks[id]++;
	}

	// The menu backdrop rides the player's view, so it is placed here -- before anything
	// that might return early, because a panel left where the player used to be looking
	// is worse than no panel at all.
	if (!get_pcvar_num(g_cv_enabled))
	{
		return FMRES_IGNORED;
	}

	// A mech's stunts get their own sound, in any state.
	if (id >= 1 && id < MAXPL)
	{
		mech_stunt_sounds(id);
	}

	// Mech machinery: the carried M60 is stripped off the model, every hp bump
	// in live play is refused back, and the walking machine keeps its sound kit
	// on the walker's own client as well as in the world.
	if (is_user_alive(id) && wears_mech(id))
	{
		// The M60 hanging off the mech model, out of sight for good. TS redraws
		// the attachment whenever the carried weapon changes, so this is not a
		// one-shot hide: prethink clears it every frame and wins by constant
		// repetition rather than by catching it once. Both cosmetic pairs are
		// zeroed -- the on-body mesh TS attaches (weaponmodel) and the first-person
		// in-hand mesh (viewmodel). The weapon itself is untouched; only its
		// pictures are gone.
		set_pev(id, pev_weaponmodel, 0);
		set_pev(id, pev_weaponmodel2, "");
		set_pev(id, pev_viewmodel, 0);
		set_pev(id, pev_viewmodel2, "");

		new mechhp = get_user_health(id);

		/*
		 * A watch of ZERO means there is no baseline yet -- a fresh body, or one a
		 * death or the match reset has just cleared -- and the next sighting only
		 * records it. Without that, the first live frame after a go-live health raise
		 * or a mid-round respawn would read the class's own 300 (or the respawn's
		 * 100) as a heal and step it straight back down; that is how a live mech was
		 * held at the freeze's 100, and a respawned one at 2. The explicit sets (arm,
		 * apply_class, go-live) sync the watch at the write and a death clears it, so
		 * the only values it ever refuses are genuine bumps.
		 */
		if (g_state == ST_LIVE && g_mech_hp_watch[id] > 0)
		{
			/*
			 * The stimpack and every other route to healing a machine are closed
			 * here by EFFECT, not by command name. TS's own stimpack runs inside
			 * the game dll with no client command to intercept, so anything that
			 * raises this body's hp during a live round is stepped back -- the
			 * medic heal, our own .stim and the pickups are all already refused
			 * or not ours to own; this is the floor under all of them.
			 */
			if (mechhp > g_mech_hp_watch[id] + 1)
			{
				set_user_health(id, g_mech_hp_watch[id]);
				client_print(id, print_center, "[TSM] Mechs do not heal -- self-repair is not a thing");
				tlog("[TSM] mech hp bump on %d refused (%d -> %d)", id, g_mech_hp_watch[id], mechhp);
				mechhp = g_mech_hp_watch[id];
			}
		}
		g_mech_hp_watch[id] = mechhp;

		// Pilot step sound, on the pilot's own client as well as in the world. Not for
		// an eliminated pilot, whom TS has put back on their feet.
		if (!is_user_bot(id) && !g_elim[id])
		{
			new Float:vel[3];
			pev(id, pev_velocity, vel);
			new Float:speed = vector_length(vel);
			if (speed >= 50.0 && (pev(id, pev_flags) & FL_ONGROUND))
			{
				new Float:now = get_gametime();
				if (g_next_step_time[id] <= now)
				{
					g_next_step_time[id] = now + 0.4;
					new stepname[16];
					copy(stepname, charsmax(stepname), g_next[id] == 0 ? MECH_STEP_1 : MECH_STEP_2);
					tlog("[TSM DEBUG] mech step emit for %d", id);
					emit_sound(id, CHAN_BODY, stepname, 1.0, ATTN_NORM, 0, PITCH_NORM);
					client_cmd(id, "playvol %s 0.7", stepname);
					g_next[id] = (g_next[id] + 1) % 2;
				}
			}
		}
	}

	// Above every early return below, so a held, spectating, eliminated or dead player
	// is kept broke as well.
	hold_cash(id);

	// The hold is asserted here, before any state check, so it can never be skipped
	// by an early return further down. This is the whole mechanism now -- there is no
	// timer to renew and nothing to expire.
	/*
	 * Read the buttons BEFORE anything strips them.
	 *
	 * Spectator cycling used to live in fw_cmdstart, which never fires in TS -- so it
	 * has never worked. Moving it here needs the raw value, because the hold below
	 * clears the attack bits and an eliminated player is always held.
	 */
	new raw_buttons = pev(id, pev_button);


	/*
	 * Bots are made to reload on a timer.
	 *
	 * They run dry and then keep pulling the trigger: rcbot never saw the weapons
	 * we handed out, because the loadout is written through TS's own buy commands
	 * and applied by BuyArmament at spawn, so no pickup ever happened for it to
	 * observe. Its ammo count, its reload decision and its decision to switch are
	 * all working from an inventory it does not have.
	 *
	 * IN_RELOAD costs nothing when the clip is already full -- the weapon code
	 * ignores it -- so this does not need to know how much ammo they have. The dry
	 * check below does ask, with ts_getuserwpn, but only when a weapon is in hand.
	 *
	 * Set in the PRE hook, because the DLL turns pev->button into the pressed edge
	 * the weapon code acts on. Driven from here rather than a task because
	 * PlayerPreThink is the one path the logs prove reaches a fake client.
	 */
	if (g_state == ST_LIVE
		&& is_user_bot(id)
		&& is_user_alive(id)
		&& !g_elim[id])
	{
		new Float:every = get_pcvar_float(g_cv_botreload);
		if (every > 0.0 && (get_gametime() - g_bot_reload_at[id]) >= every)
		{
			g_bot_reload_at[id] = get_gametime();
			set_pev(id, pev_button, pev(id, pev_button) | IN_RELOAD);
		}

		/*
		 * Completely dry weapons get cycled to the next one. A reload cannot help and
		 * rcbot cannot make this call: its weapon bookkeeping never saw the loadout we
		 * handed the bot, so it stands there pulling the trigger on an empty gun --
		 * rcbot's own release notes list exactly this as an open TS 3.0 issue.
		 *
		 * Only asked while a weapon is in hand: ts_getuserwpn aborts its caller when
		 * there is nothing to report, and aborting here would cost the frame.
		 */
		if (get_user_weapon(id) > 0 && (get_gametime() - g_bot_dry_at[id]) >= 1.0)
		{
			new weapon = get_user_weapon(id);
			new clip, spare, mode, extra;
			ts_getuserwpn(id, clip, spare, mode, extra);

			/*
			 * Count consecutive dry reads of the SAME weapon before cycling.
			 * A single dry read can happen mid-raise or mid-switch, so it must not
			 * by itself trigger a switch -- that caused the M4/AK -> pistol cascade.
			 * Three in a row on the same gun means it is genuinely out of ammo.
			 */
			new bool:dry = (clip <= 0 && spare <= 0);
			if (dry)
			{
				if (weapon == g_bot_dry_weapon[id])
				{
					g_bot_dry_count[id]++;
				}
				else
				{
					g_bot_dry_weapon[id] = weapon;
					g_bot_dry_count[id] = 1;
				}
			}
			else
			{
				g_bot_dry_weapon[id] = weapon;
				g_bot_dry_count[id] = 0;
			}

			if (g_bot_dry_count[id] >= 3)
			{
				new weapons[32], num;
				get_user_weapons(id, weapons, num);
				if (g_bot_dry_switches[id] < num)
				{
					engclient_cmd(id, "invnext");
					g_bot_dry_switches[id]++;
					g_bot_dry_count[id] = 0;
					dbgv("dry weapon on bot %d -- cycling to the next (switch %d/%d)", id, g_bot_dry_switches[id], num);
				}
				else
				{
					// No weapon has ammo: fall back to unarmed kung fu.
					// slot0 selects kung fu; invnext/invprev ignore it.
					engclient_cmd(id, "slot0");
					g_bot_dry_count[id] = 0;
					dbgv("bot %d out of ammo on every weapon -- kung fu", id);
				}
			}

			g_bot_dry_at[id] = get_gametime();
		}
	}

	new bool:want_hold = should_hold(id);

	if (want_hold)
	{
		// Picked up the instant they need holding, including the frame they respawn.
		if (!g_frozen[id])
		{
			g_save_maxspeed[id] = Float:pev(id, pev_maxspeed);
			if (g_save_maxspeed[id] <= 0.0)
			{
				g_save_maxspeed[id] = 320.0;
			}
			g_frozen[id] = true;
			g_warmup_spread[id] = false;   // fresh hold: allow one check/spread this cycle
			dbgv("hold engaged on %d (state %d)", id, g_state);
		}

		/*
		 * A GHOST IS NOT FROZEN, he is just out of the round.
		 *
		 * What elimination is meant to be is three things -- he takes no damage, he deals none
		 * because remove_from_play() has already stripped his weapons, and he is not drawn. Being
		 * pinned to the spot he was shot on is none of them, and it is what made elimination feel
		 * like a disconnect: you watched the rest of the round from wherever you happened to fall.
		 *
		 * So the freeze is skipped for him and the three things that DO define it are asserted
		 * every frame instead, where TS cannot quietly put them back.
		 *
		 * THE CHOSEN SPECTATOR IS THE SAME CAMERA. Team 3 used to take the freeze below
		 * instead: held in place with their attack bits cleared, so the click that changes
		 * the player they are watching could never be heard, which is why sitting out felt
		 * like a dark room. may_watch() already answers for them -- a viewer with no side
		 * watches BOTH teams -- and everything else this block does is either a general
		 * assert (NODRAW, non-solid, no weapon model, no damage) a spectator wants too, or
		 * a guard written as g_elim_at > 0, which someone who was never eliminated simply
		 * does not enter. Their one real difference stands a few lines down: their attack
		 * bits are cleared after the click has been read, because unlike a ghost they were
		 * not guaranteed stripped.
		 */
		if (g_elim[id] || is_spectating(id))
		{
			set_pev(id, pev_solid,      TSM_SOLID_NOT);
			set_pev(id, pev_takedamage, TSM_DAMAGE_NO);
			set_pev(id, pev_maxspeed,   wanted_speed());
			set_user_maxspeed(id, wanted_speed());

			// Disarm a respawned eliminated player so they cannot shoot while their
			// body is still being left to TS. Harmless when they have no weapons.
			//
			// Not for one a wave is ACTIVELY reviving right now (g_revive_active): TS's
			// respawn for them lands on a later frame than revive_player's own "respawn"
			// command, and the moment it does, this condition would otherwise fire before
			// revive_player's own 0.5s poll ever notices -- see the guard below.
			//
			// g_revive_active, not g_revive_pending: g_revive_pending covers the WHOLE
			// wait for a wave (seconds to tsm_respawn_wave's full interval), not just the
			// moment a wave is actually trying. Gating on g_revive_pending suppressed
			// remove_from_play() -- and therefore the camera-follow/attack-cycle spectate
			// below, which only runs once g_elim_at is zeroed -- for the entire wait, not
			// just the risky instant, which is what broke "attack to cycle spectate
			// teammates" for anyone waiting on a wave. g_revive_active is true only from
			// fire_wave()'s commit through that attempt's resolution in revive_player().
			if (g_elim_at[id] > 0.0 && is_user_alive(id) && !g_revive_active[id])
			{
				strip_user_weapons(id);
			}

			/*
			 * Respawned after elimination: TS puts him back on his feet when the
			 * death sequence ends, loadout and all. Taken out of play here too, as
			 * a backstop on the death-delay task -- and remove_from_play() itself
			 * now drops the out-of-play flag when it finally completes.
			 *
			 * NOT for a player a wave is ACTIVELY reviving (g_revive_active, see above --
			 * not g_revive_pending, which would suppress this for the whole wait, not just
			 * the risky instant). Without the guard, this fires the instant TS's respawn
			 * lands -- before revive_player's own 0.5s poll clears g_elim -- and
			 * remove_from_play's pick_spec_target() then glues the freshly-alive body onto
			 * a teammate via the camera-follow code below, which is the "spawns inside a
			 * teammate" bug. revive_player's own success path clears
			 * g_elim_at/g_elim/g_revive_pending/g_revive_active together, so once
			 * this guard stops applying, the whole branch is skipped anyway.
			 */
			if (g_elim_at[id] > 0.0 && is_user_alive(id) && !g_revive_active[id] && elim_hide_due(id))
			{
				remove_from_play(id);
			}

			/*
			 * A PLAYER STILL INSIDE THE DEATH WINDOW IS NOT MOVED HERE.
			 *
			 * g_elim_at > 0 means the takeout has not completed yet: TS is still
			 * working the death sequence, or the death-delay task has not landed.
			 * From the frame of elimination this hook used to SetOrigin the body
			 * above whoever g_spec_target named -- or park it on the last saved
			 * origin -- on every frame, WHILE IT WAS STILL VISIBLE. The post-think
			 * hook got a leave-alone guard for exactly this and this one never
			 * did, and the visible result was the old complaint in the flesh: a
			 * killed player that blinked and hopped around instead of falling
			 * still long enough to be a corpse.
			 *
			 * So the body is left wherever TS put it until the takeout has
			 * genuinely finished with them, NODRAW and all; the camera only
			 * starts once there is no visible thing left to blink.
			 */
			if (g_elim_at[id] > 0.0)
			{
				g_last_buttons[id] = raw_buttons;
				return FMRES_IGNORED;
			}

			// Out of play: the invisible fact is asserted every frame too, and
			// there is no linger window on it any more. The visible body on the
			// floor belongs to TS's own corpse, not to this entity, so there is
			// nothing left to cut short -- and a ghost whose effects TS quietly
			// clears must be re-hidden the same frame, not at the next window
			// boundary.
			set_pev(id, pev_effects,    pev(id, pev_effects) | TSM_EF_NODRAW);

			/*
			 * His own leftover weapon stays in his hands otherwise -- TS keeps re-populating
			 * these from whatever he was last holding, the same way it fights the mech's M60
			 * (see wears_mech's block below), so this wins by asserting it every frame too
			 * rather than once. He has no weapon to use and no HUD to use it with; the model
			 * should match.
			 */
			set_pev(id, pev_weaponmodel,  0);
			set_pev(id, pev_weaponmodel2, "");
			set_pev(id, pev_viewmodel,    0);
			set_pev(id, pev_viewmodel2,   "");

			/*
			 * A WAVE IS BRINGING THEM BACK RIGHT NOW, so the camera stands down.
			 *
			 * task_revive has already placed this player at their spawn slot and asked
			 * TS to respawn them. With the camera still running, the next frame would
			 * drag them back onto the followed teammate -- and the respawn that finally
			 * lands would then happen THERE: made visible again standing inside
			 * whoever they had been watching, for as long as it took task_revive_arm
			 * to find them again. That is the "they respawn inside of me" report in
			 * full. So for as long as the wave owns them -- until TS accepts the
			 * respawn, or its hold runs out and hands them back to the camera for
			 * normal spectate -- they stay where the wave put them.
			 */
			if (g_revive_active[id])
			{
				g_last_buttons[id] = raw_buttons;
				return FMRES_IGNORED;
			}

			/*
			 * Attack switches to the next teammate, edge-detected on the raw buttons --
			 * the click the spectator HUD names, read before the hold clears it.
			 */
			if ((raw_buttons & IN_ATTACK) && !(g_last_buttons[id] & IN_ATTACK))
			{
				cycle_spec_target(id);
			}
			if ((raw_buttons & IN_ATTACK2) && !(g_last_buttons[id] & IN_ATTACK2))
			{
				cycle_spec_target(id);
			}
			g_last_buttons[id] = raw_buttons;

			/*
			 * THE ONE DIFFERENCE a chosen spectator brings: their attack bits never
			 * reach TS.
			 *
			 * An eliminated body was disarmed by remove_from_play(), so leaving the bits
			 * alone costs nothing there -- whatever a click does, there is nothing in
			 * their hands to fire with. A spectator who sat out was never guaranteed
			 * stripped (only the bench route through park_spectator() takes a loadout
			 * away), so the clearing the plain hold branch makes is repeated here for
			 * them alone: the press was read above from raw_buttons, and what TS's
			 * PlayerPreThink then sees on an invisible, non-solid, free-moving body is
			 * one button short of a punch.
			 */
			if (is_spectating(id))
			{
				set_pev(id, pev_button, pev(id, pev_button) & ~(IN_ATTACK | IN_ATTACK2));
			}
			new wt = g_spec_target[id];
			if (wt && is_user_connected(wt) && is_user_alive(wt) && !g_elim[wt])
			{
				new Float:wpos[3];
				pev(wt, pev_origin, wpos);
				wpos[2] = wpos[2] + 40.0;
				engfunc(EngFunc_SetOrigin, id, wpos);

				new Float:sang[3];
				pev(wt, pev_v_angle, sang);
				set_pev(id, pev_angles, sang);
				set_pev(id, pev_v_angle, sang);
				set_pev(id, pev_fixangle, 1);
			}
			else
			{
				pick_spec_target(id);
				if (!g_spec_target[id])
				{
					// Nobody left to watch: park them high above the map instead of
					// leaving them loose in the arena.
					new Float:park[3];
					park[0] = g_save_origin[id][0];
					park[1] = g_save_origin[id][1];
					park[2] = g_save_origin[id][2] + float(get_pcvar_num(g_cv_holdz));
					engfunc(EngFunc_SetOrigin, id, park);
				}
			}
			return FMRES_IGNORED;
		}

		/*
		 * THE WARMUP SPAWN PILE NEVER FORMS.
		 *
		 * TS puts every new body on the map's own info_player_start -- the one
		 * spot every join, every team pickup and every warmup respawn shares --
		 * and the warmup hold then freezes the body exactly there: inside the
		 * last body that respawned. A body standing inside another dies
		 * outright, the same lesson the round starts taught outright (see
		 * pick_spawn_point: the freeze stagger killed bots at spawn until the
		 * occupancy check existed), and with the hold keeping them there it
		 * kills one over and over while nobody can see or anything.
		 *
		 * So in warmup and ready-up, any held body still standing on one of the
		 * map's own spawn points is put on its own team's list instead, one
		 * frame after TS lands it, with pick_spawn_point choosing a point no
		 * other body stands at. Nobody standing there means nobody can respawn
		 * into anybody, and bodies that drift off the points afterwards are
		 * left wherever they drifted.
		 */
		if ((g_state == ST_WARMUP || g_state == ST_READYUP)
			&& warmup_hold_active() && g_match_team[id] >= 1 && g_spawn_count > 0
			&& !g_warmup_spread[id])
		{
			new Float:pos[3];
			pev(id, pev_origin, pos);

			new bool:on_spawn = false;
			for (new s = 0; s < g_spawn_count && !on_spawn; s++)
			{
				if (get_distance_f(pos, g_spawns[s]) < TSM_SPAWN_CLEARANCE)
				{
					on_spawn = true;
				}
			}

			/*
			 * CHECKED, AND RESOLVED, EXACTLY ONCE PER HOLD. Without g_warmup_spread,
			 * this ran every single frame of warmup/ready-up -- and place_at_spawn()
			 * picks its destination from g_spawn_t1/g_spawn_t2, which are themselves
			 * built FROM g_spawns (see where they're populated), so the point a body
			 * was just moved to is, by construction, also within TSM_SPAWN_CLEARANCE
			 * of an entry in g_spawns. The very next frame's on_spawn check found that
			 * true again and moved them again -- forever, every frame, for the whole
			 * hold. That is the "repeatedly slamming up and down" / fall-damage-sound
			 * report in full: a held body does not walk off a ledge, but an instant
			 * EngFunc_SetOrigin between two points at different floor heights, every
			 * single frame, reads to TS's own landing/fall-damage check exactly like
			 * one does -- and pev_takedamage=NO never has to be bypassed for that,
			 * since it is driven by TS's own prediction/movement code, not TakeDamage().
			 */
			g_warmup_spread[id] = true;

			if (on_spawn)
			{
				place_at_spawn(id);
				dbgv("warmup spread: %d moved off the shared spawn point", id);
			}
		}

		apply_freeze(id);

		/*
		 * ATTACK and JUMP are cleared, in the pre hook, because the game DLL's own
		 * PlayerPreThink is what turns pev->button into the pressed/released edges that
		 * weapon code acts on in PostThink, and is also where CBasePlayer::PreThink
		 * itself calls Jump() synchronously off pev->button & IN_JUMP -- clearing the
		 * bits first means the DLL never sees the press, for either one.
		 *
		 * IN_JUMP joined ATTACK/ATTACK2 because maxspeed and FL_FROZEN only gate
		 * WASD-derived movement (PM_CheckParamters zeroes cmd.forward/side/upmove) --
		 * reTS's PM_Jump applies the jump impulse straight to pev_velocity.z regardless
		 * of either one, so a held body could still be launched upward by one press.
		 * Still deliberately NOT the whole button field and NOT pev_impulse: movement
		 * is already stopped by the maxspeed clamp, and wiping impulse every frame
		 * broke menu input, including the team menu -- which left players unable to
		 * join a team at all.
		 */
		set_pev(id, pev_button, pev(id, pev_button) & ~(IN_ATTACK | IN_ATTACK2 | IN_JUMP));
	}
	else if (g_frozen[id] && pev(id, pev_deadflag) == TSM_DEAD_NO)
	{
		/*
		 * Released the frame the state stops calling for a hold, rather than waiting
		 * on whichever timer happens to run next.
		 *
		 * Not while they are dying, though: should_hold() now returns false for a
		 * dying player, so without this check every death would come straight down
		 * here and release_player() would write visibility and movetype onto a body
		 * TS is still using. A dying player is neither held nor released -- untouched.
		 */
		dbgv("hold lifted on %d (state %d)", id, g_state);
		release_player(id);
	}

	/*
	 * No shooting outside a live round -- warmup, the freeze countdown, round end and
	 * match end alike. Only the attack bits are cleared, so players can still walk
	 * around and use menus during warmup; clearing every button would freeze them.
	 */
	// Not while they are dying: TS waits on fire to respawn ("press Fire to Play!"),
	// and swallowing it holds them in the death state, which holds up the corpse too.
	if (g_state != ST_LIVE && pev(id, pev_deadflag) == TSM_DEAD_NO)
	{
		set_pev(id, pev_button, pev(id, pev_button) & ~(IN_ATTACK | IN_ATTACK2));
	}

	// Watch for deaths every frame. A suicide sends no useful DeathMsg and TS respawns
	// players on its own, so without this a player can die and be back on their feet
	// before any poll notices -- which is why a last-man suicide never ended the round.
	if (g_state == ST_LIVE && !g_elim[id] && !g_locked_out[id] && g_match_team[id] > 0)
	{
		new bool:now_alive = (is_user_alive(id) != 0);

		if (g_was_alive[id] && !now_alive && g_pending_elim[id] <= 0.0)
		{
			g_pending_elim[id] = get_gametime();
		}
		g_was_alive[id] = now_alive;

		// Short grace so DeathMsg, which knows who the killer was, gets first refusal.
		if (g_pending_elim[id] > 0.0 && (get_gametime() - g_pending_elim[id]) >= 0.3)
		{
			g_pending_elim[id] = 0.0;
			g_elim[id] = true;
			g_elim_at[id] = get_gametime();
			g_mech_hp_watch[id] = 0;   // same death reset as ev_death, for the no-DeathMsg path
			set_task(get_pcvar_float(g_cv_deathdelay), "task_remove_from_play", id + 7000);
			dbg("frame watcher eliminated %d (no DeathMsg -- suicide or world death)", id);
			death_voice(id);
			// The life is spent before the report, as in ev_death, so its lives tally counts this death.
			lives_on_death(id);
			// Same lookup as ev_death: a suicide genuinely has no killer, but a death
			// that simply produced no DeathMsg usually does.
			report_elimination(get_user_attacker(id), id);
			check_round_end();
		}
	}

	/*
	 * NOTHING BELOW THIS POINT TOUCHES A PLAYER TS HAS NOT FINISHED KILLING.
	 *
	 * This is the fix for bodies vanishing on death, and it is a guard rather than
	 * another mechanism because every mechanism tried here made it worse.
	 *
	 * TS owns the whole death sequence. It plays the animation, builds a separate
	 * body with TSCreateDeadCorpse() -- the corpse is its own CTSDeadCorpse entity,
	 * NOT this edict -- and respawns on its own schedule. Writing effects, solidity,
	 * movetype or origin to a player in the middle of that is writing to an entity
	 * the mod is still using, and it showed: the body vanished the instant the
	 * player was killed instead of after the corpse had appeared.
	 *
	 * deadflag is the mod's own statement of whether it is done. While it is set,
	 * this plugin keeps its hands off entirely. Elimination is still RECORDED above
	 * -- the frame watcher, round-end counting and the death delay all run -- so
	 * nothing is missed; only the presentation waits, and elim_hide_due() already
	 * requires them to be alive again before any of it applies.
	 */
	if (pev(id, pev_deadflag) != TSM_DEAD_NO)
	{
		g_last_buttons[id] = pev(id, pev_button);
		return FMRES_IGNORED;
	}

	// Combat engineer. Read before the eliminated-player branch below, because that
	// branch returns early for everyone who is still playing.
	if (g_state == ST_LIVE && !g_elim[id] && !g_locked_out[id] && is_user_alive(id))
	{
		new btn = pev(id, pev_button);
		if ((btn & IN_USE) && !(g_last_use[id] & IN_USE))
		{
			// An objective under the crosshair is the objective's business, whatever the class.
			if (!siege_use(id))
			{
				perk_use(id);
			}
		}
		g_last_use[id] = btn;
	}

	// Spectators are invisible and intangible in every state, the same presentation an
	// eliminated player gets -- they are in the world only to watch.
	//
	// Reached only where the hold is NOT: a roamer sitting out skips the hold entirely,
	// and every other spectator never gets this far, because the ghost camera above
	// asserts the same fields and answers their movement. This is the roaming case's
	// invisibility, plus a catch-all, not the watcher's main path.
	if (is_spectating(id))
	{
		if (is_user_alive(id))
		{
			set_pev(id, pev_takedamage, TSM_DAMAGE_NO);
			set_pev(id, pev_effects, pev(id, pev_effects) | TSM_EF_NODRAW);
			set_pev(id, pev_rendermode, TSM_RENDER_TEXTURE);
			set_pev(id, pev_renderamt, 0.0);
			set_pev(id, pev_solid, TSM_SOLID_NOT);
		}
		return FMRES_IGNORED;
	}

	// Held in warmup: immune so a held player cannot be farmed, and hidden plus
	// non-solid so nobody can body-block or shoot anyone before the match starts.
	if ((g_state == ST_WARMUP || g_state == ST_READYUP) && warmup_hold_active())
	{
		// Same reasoning as the tick: someone with no team is still picking one, and
		// hiding or freezing them stops them ever doing it.
		if (!tsm_live_team_of(id))
		{
			return FMRES_IGNORED;
		}

		if (is_user_alive(id))
		{
			set_pev(id, pev_takedamage, TSM_DAMAGE_NO);
			if (get_pcvar_num(g_cv_warmhide))
			{
				// EF_NODRAW on its own was not hiding players in TS, so the alpha
				// is zeroed as well. One of the two reliably takes.
				set_pev(id, pev_effects, pev(id, pev_effects) | TSM_EF_NODRAW);
				set_pev(id, pev_rendermode, TSM_RENDER_TEXTURE);
				set_pev(id, pev_renderamt, 0.0);
				set_pev(id, pev_solid, TSM_SOLID_NOT);
			}
		}
		return FMRES_IGNORED;
	}

	if (g_state != ST_LIVE)
	{
		return FMRES_IGNORED;
	}
	if (!g_elim[id] || !is_user_connected(id))
	{
		return FMRES_IGNORED;
	}

	/*
	 * Nothing at all happens to a player who is still dying.
	 *
	 * The hide was already deferred to elim_hide_due(), but the camera below was
	 * not -- so from the frame of death the body was being SetOrigin'd to a point
	 * above a teammate while it was still visible and solid. That is what put the
	 * corpse inside whoever it had picked to follow, and it stayed there until the
	 * body finally went away.
	 *
	 * Dying is left completely alone now. Spectating begins when the corpse does
	 * go -- the moment TS puts them back on their feet, or the tsm_death_delay
	 * ceiling if it never does.
	 */
	if (!elim_hide_due(id))
	{
		/*
		 * A dying player is left COMPLETELY alone, and that is the fix.
		 *
		 * The body on the floor is not this entity. TS registers its own `deadcorpse`
		 * entity and spawns one as part of the death sequence, so the corpse outlives
		 * the player edict and nothing here has to keep that edict visible.
		 *
		 * Everything that used to run here worked on the wrong entity. Clearing the
		 * attack button to refuse the respawn was the worst of it: TS finishes the
		 * death sequence at the respawn, so blocking it for the linger did not hold a
		 * body -- it delayed the corpse by exactly tsm_death_linger, which is why one
		 * appeared three seconds late with its animation already over.
		 *
		 * So the linger is now only a window in which we do not touch a dying player.
		 * TS plays the death animation, drops its corpse, and respawns on its own
		 * schedule; the hide below applies to the respawned player, not to the body.
		 */

		/*
		 * Diagnostic only, behind tsm_debug_log 2: every field that can stop a player
		 * being drawn, sampled each frame for four seconds after a death. Worth keeping
		 * -- it is what showed nodraw staying clear for the whole linger while the body
		 * still went, which is what ruled visibility out.
		 */
		if (g_deathtrace_at[id] > 0.0 && get_pcvar_num(g_cv_dbglog) >= 2)
		{
			new Float:age = get_gametime() - g_deathtrace_at[id];
			if (age > 4.0)
			{
				g_deathtrace_at[id] = 0.0;
			}
			else
			{
				// modelindex is the one that matters when nodraw is clear and the body is
				// still not drawn: a model that was never precached has no index to send.
				dbg("deathtrace %d t=%.2f alive=%d solid=%d nodraw=%d rm=%d ra=%.0f seq=%d modelindex=%d deadflag=%d movetype=%d",
					id, age, is_user_alive(id) ? 1 : 0, pev(id, pev_solid),
					(pev(id, pev_effects) & TSM_EF_NODRAW) ? 1 : 0,
					pev(id, pev_rendermode), Float:pev(id, pev_renderamt),
					pev(id, pev_sequence), pev(id, pev_modelindex),
					pev(id, pev_deadflag), pev(id, pev_movetype));
			}
		}

		g_last_buttons[id] = raw_buttons;
		return FMRES_IGNORED;
	}

	/*
	 * Attack = watch the next teammate. Edge-detected on the raw buttons captured at
	 * the top, since the hold has already cleared them by now.
	 */
	if ((raw_buttons & IN_ATTACK) && !(g_last_buttons[id] & IN_ATTACK))
	{
		cycle_spec_target(id);
	}
	if ((raw_buttons & IN_ATTACK2) && !(g_last_buttons[id] & IN_ATTACK2))
	{
		cycle_spec_target(id);
	}
	g_last_buttons[id] = raw_buttons;

	/*
	 * Respawned after being eliminated: this is the moment they become a spectator.
	 * save_presentation() inside remove_from_play() is guarded against running twice,
	 * so calling it on the frame they come back is safe.
	 */
	if (g_elim_at[id] > 0.0 && is_user_alive(id) && pev(id, pev_solid) != TSM_SOLID_NOT)
	{
		dbgv("%d respawned after elimination -- taking them out of play now", id);
		remove_from_play(id);
	}

	/*
	 * Eliminated players are disarmed -- attack bits only, so menus keep working -- but
	 * NOT once they are a spectator proper.
	 *
	 * The old comment here claimed stripping attack left "their spectate controls" alone.
	 * It does the opposite: on TS's spectator HUD, attack IS the control, the one the
	 * "Attack to switch player" prompt names. Taking the bit meant the click never reached
	 * TS and the view never changed teammate.
	 */
	/*
	 * Not taken at all from an eliminated player: attack is how they change who they watch, and
	 * they have no weapon for it to fire.
	 */
	if (!is_spectating(id) && !g_elim[id])
	{
		set_pev(id, pev_button, pev(id, pev_button) & ~(IN_ATTACK | IN_ATTACK2));
	}

	// Re-asserted every frame because the mod re-applies its own values on respawn
	// and whenever it feels like it. Past the guard above, the body is already due
	// to be gone.
	set_pev(id, pev_solid,      TSM_SOLID_NOT);
	set_pev(id, pev_effects,    pev(id, pev_effects) | TSM_EF_NODRAW);
	set_pev(id, pev_takedamage, TSM_DAMAGE_NO);

	// Same reasoning as the other elimination-hold block above: his own leftover weapon
	// otherwise stays in his hands, re-populated by TS every time it feels like it, so
	// this is asserted every frame alongside the three fields above rather than once.
	set_pev(id, pev_weaponmodel,  0);
	set_pev(id, pev_weaponmodel2, "");
	set_pev(id, pev_viewmodel,    0);
	set_pev(id, pev_viewmodel2,   "");

	new t = g_spec_target[id];
	if (t && is_user_connected(t) && is_user_alive(t) && !g_elim[t])
	{
		// Follow by moving the view, not by spectating.
		new Float:org[3];
		pev(t, pev_origin, org);
		org[2] = org[2] + 40.0;
		engfunc(EngFunc_SetOrigin, id, org);

		new Float:ang[3];
		pev(t, pev_v_angle, ang);
		set_pev(id, pev_angles, ang);
		set_pev(id, pev_v_angle, ang);
		set_pev(id, pev_fixangle, 1);
	}
	else
	{
		pick_spec_target(id);
		if (!g_spec_target[id])
		{
			// Nobody left to watch: park them high above the map instead of
			// leaving them loose in the arena.
			new Float:org[3];
			org[0] = g_save_origin[id][0];
			org[1] = g_save_origin[id][1];
			org[2] = g_save_origin[id][2] + float(get_pcvar_num(g_cv_holdz));
			engfunc(EngFunc_SetOrigin, id, org);
		}
	}

	/*
	 * Enforce class height every frame in the PRE hook (proven-firing in TS),
	 * in addition to the POST hook. class_scale_for() answers 1.0 during the
	 * freeze, so the one write at arm time is lost -- this per-frame write is
	 * what keeps the Heavy at 1.50 once the round is live.
	 */
	new Float:want_scale = class_scale_for(id);
	new Float:have_scale = Float:pev(id, pev_scale);
	if (want_scale == 1.0)
	{
		if (have_scale != 0.0)
		{
			set_pev(id, pev_scale, 0.0);
			g_prethink_scale_hits++;
		}
	}
	else if (have_scale != want_scale)
	{
		set_pev(id, pev_scale, want_scale);
		g_prethink_scale_hits++;
	}

	return FMRES_IGNORED;
}

public msg_teaminfo(msgid, dest, ent)
{
	g_teaminfo_seen++;
	if (g_teaminfo_seen == 1)
	{
		tlog("[TSM] First TeamInfo seen -- this server IS running teamplay gamerules.");
	}
	return PLUGIN_CONTINUE;
}

/*
 * Undoes damage between teammates.
 *
 * The damage is given back rather than prevented: stopping it outright needs a hook
 * on the entity's TakeDamage, which lives in hamsandwich -- not loaded on this server
 * -- and TS's own mp_friendlyfire keys off ITS idea of teams, which can disagree with
 * ours. Healing on the Damage event needs neither.
 *
 * Knockback still applies; only the health loss is reversed.
 */
public ev_damage(id)
{
	if (!get_pcvar_num(g_cv_enabled) || get_pcvar_num(g_cv_friendlyfire))
	{
		return;
	}
	if (g_state != ST_LIVE || !is_user_alive(id))
	{
		return;
	}

	new attacker = get_user_attacker(id);
	if (attacker < 1 || attacker >= MAXPL || attacker == id)
	{
		return;   // world damage, or self-inflicted -- both stand
	}

	new team = g_match_team[id];
	if (team < 1 || g_match_team[attacker] != team)
	{
		return;   // not a teammate
	}

	new dmg = read_data(2);
	if (dmg <= 0)
	{
		return;
	}

	// Capped at the class's own health so this can never be used to heal past maximum.
	new cap = get_pcvar_num(g_cv_health);
	if (g_class_count)
	{
		new ci = resolved_class(id) - 1;
		if (ci >= 0 && ci < g_class_count)
		{
			cap = g_class_hp[ci];
		}
	}

	new hp = get_user_health(id) + dmg;
	if (hp > cap)
	{
		hp = cap;
	}
	set_user_health(id, hp);

	client_print(attacker, print_chat, "[MATCH] Friendly fire is off -- that was a teammate.");
	dbgv("friendly fire: %d hit %d for %d, refunded", attacker, id, dmg);
}

public ev_death()
{
	if (!get_pcvar_num(g_cv_enabled) || g_resetting)
	{
		return;
	}

	new killer = read_data(1);
	new victim = read_data(2);

	/*
	 * DeathMsg does not always carry a usable killer here, and without one the report
	 * falls through to the no-killer branch -- which is told to BOTH sides and carries
	 * no health, which is exactly what a global, 0hp/0ap report looks like.
	 *
	 * The engine tracks the last entity to damage a player independently, so it is
	 * used whenever DeathMsg comes up empty.
	 */
	if (killer < 1 || killer >= MAXPL || killer == victim)
	{
		new attacker = get_user_attacker(victim);
		if (attacker >= 1 && attacker < MAXPL && attacker != victim)
		{
			dbgv("death: DeathMsg killer was %d, using attacker %d instead", killer, attacker);
			killer = attacker;
		}
	}

	if (victim < 1 || victim >= MAXPL)
	{
		return;
	}
	if (g_state != ST_LIVE)
	{
		return;   // warmup deaths are none of our business
	}
	if (g_elim[victim])
	{
		return;   // already out; this is TS re-killing a parked player
	}

	// The frame watcher may already have this death queued. Clear it so the same
	// death is not reported twice -- DeathMsg wins because it knows the killer.
	g_pending_elim[victim] = 0.0;

	/*
	 * Marked out IMMEDIATELY so round-end counting is correct this frame, but not
	 * hidden until tsm_death_delay has passed -- the body should be seen to fall.
	 */
	g_elim[victim] = true;
	g_elim_at[victim] = get_gametime();

	/*
	 * The mech health watch dies with the body. TS puts the player back on their
	 * feet on its own schedule, and a baseline from before the death would refuse
	 * the respawn's OWN 100 hp as a "heal" -- which is how a mech once came back
	 * at 2. Zero means "no baseline yet": the first sighting after this only
	 * records.
	 */
	g_mech_hp_watch[victim] = 0;

	// Watch what happens to the body for the next few seconds. If it vanishes and
	// nothing here did it, the mod did -- and the log says which.
	g_deathtrace_at[victim] = get_gametime();
	set_task(get_pcvar_float(g_cv_deathdelay), "task_remove_from_play", victim + 7000);

	// The elimination voice, picked by the dying player's model name (see
	// death_voice()). Plays before anything here has hidden or moved the body.
	death_voice(victim);
	// The life is spent before the report, so the report's lives tally counts this death.
	lives_on_death(victim);
	report_elimination(killer, victim);
	check_round_end();
}

/* ---- the elimination voice ------------------------------------------------ */

/*
 * Both teams hear it when an Officer is slain: death/officer_perished.wav, played on every
 * human client through playvol, so it reaches the whole server at full volume wherever they
 * stand. An emit_sound reaches only the players in earshot of the body -- even at attenuation
 * 0 the engine sends it to that spot's audible set -- and that is not both teams.
 *
 * tsm_officerslain_sound 0 turns it off.
 */
officer_slain_sound(id)
{
	if (!g_death_officer_ok || !get_pcvar_num(g_cv_officerslain) || !g_class_count)
	{
		return;
	}

	new ci = resolved_class(id) - 1;
	if (ci < 0 || g_class_perk[ci] != TSM_PERK_OFFICER)
	{
		return;
	}

	new sent = 0;
	for (new pl = 1; pl <= g_maxplayers; pl++)
	{
		if (!is_user_connected(pl) || is_user_bot(pl))
		{
			continue;
		}
		client_cmd(pl, "playvol %s 0.9", TSM_DEATH_OFFICER);
		sent++;
	}
	tlog("[TSM] officer_slain_sound: Officer %d fell, announced to %d players", id, sent);
}

/*
 * What everyone hears when a player is taken out of play.
 *
 * The dying player's MODEL NAME picks the voice, so a server's model pool is the
 * voice table:
 *
 *   robo / droid / bot in the name -- the HL1 frag grenade explosion, because a
 *                                    machine does not scream, it detonates --
 *                                    and death\droid_powerdown.wav with it
 *   fem (or female) in the name   -- death\fem1..fem5.wav
 *   anything else                 -- death\male1..male6.wav
 *
 * Every check is case-insensitive containi(), and the robot test runs FIRST: a
 * "fembot" is still a machine, and both rules would otherwise claim it. The
 * gender pools are played in random order over the slots the precache step found
 * on disk, falling over to the other voice rather than falling silent entirely.
 *
 * LOCAL to the spot they were eliminated: emitted from the body at ATTN_NORM, the
 * stock attenuation for entity sounds. It fades to nothing about 1250 units from the
 * body, and the engine sends it only to the clients whose audible set covers that spot.
 */
death_voice(id)
{
	if (!is_user_connected(id))
	{
		return;
	}

	// An Officer's fall is announced to both teams as well, whatever voice the body gets.
	officer_slain_sound(id);

	// A mech's hum stops with it for everyone in earshot, rather than running out its
	// last pass. On any other body there is no hum to stop, and the stop does nothing.
	emit_sound(id, CHAN_STATIC, MECH_LOOP, 0.0, MECH_LOOP_ATTEN, SND_STOP, PITCH_NORM);

	// The dying body's model, for the machine test below. The userinfo key is
	// read as before, but it can be TS's own re-answered pick rather than the
	// drawn body (see set_class_model), so g_model_chosen is consulted beside
	// it -- it is not alive-gated and follows the body to the death frame.
	new mdl[48];
	get_user_info(id, "model", mdl, charsmax(mdl));
	if (!mdl[0])
	{
		copy(mdl, charsmax(mdl), g_model_chosen[id]);
	}

	/*
	 * Machine or man? robo / droid / bot in the name do not scream, they
	 * detonate; a "fembot" is still a machine. The mech class models --
	 * mech_msr_bot / mech_ins_bot -- carry "bot" and land here too, which
	 * is what makes the mechs detonate. TWO strings are tested, the live
	 * key and the class pick record, because either one alone can miss a
	 * body.
	 */
	new bool:machine = (machine_name(mdl) || machine_name(g_model_chosen[id]));

	new sample[48];
	if (machine)
	{
		copy(sample, charsmax(sample), TSM_DEATH_ROBO);
	}
	else
	{
		// "female" contains "fem", so one keyword covers both spellings.
		new bool:fem = (containi(mdl, "fem") >= 0);

		new slot = pick_death_voice(fem);
		if (slot < 1)
		{
			// The whole pool of one voice is missing: try the other before
			// giving up, since one wav on disk is still better than silence.
			slot = pick_death_voice(!fem);
			if (slot < 1)
			{
				tlog("[TSM] death_voice: id=%d NO voice available (machine=%d fem=%d)", id, machine, fem);
				return;
			}
			fem = !fem;
		}
		formatex(sample, charsmax(sample), "death/%s%d.wav", fem ? "fem" : "male", slot);
	}

	// Volume 1.0, attenuation ATTN_NORM (the local rule above), no send flags,
	// normal pitch. CHAN_AUTO so it never clobbers TS's own weapon or speech
	// channels playing on the same body.
	emit_sound(id, CHAN_AUTO, sample, 1.0, ATTN_NORM, 0, PITCH_NORM);
	tlog("[TSM] death_voice: id=%d machine=%d sample=%s", id, machine, sample);

	// The dying mech pilot's own copy. Dead or not they are still connected, so
	// their client can take the local playvol even though their entity can no
	// longer be trusted with a channel -- the world copy above carries the boom
	// for everyone standing near it.
	if (!is_user_bot(id))
	{
		client_cmd(id, "playvol %s 0.9", sample);
	}

	// A machine powers down as it goes: droid_powerdown.wav plays with the boom, not instead
	// of it, on its own channel and at the boom's attenuation, and to the pilot the same way.
	if (machine && g_death_droid_ok)
	{
		emit_sound(id, CHAN_AUTO, TSM_DEATH_DROID, 1.0, ATTN_NORM, 0, PITCH_NORM);
		if (!is_user_bot(id))
		{
			client_cmd(id, "playvol %s 0.9", TSM_DEATH_DROID);
		}
	}

	/*
	 * THE MACHINES DETONATE -- and only the machines.
	 *
	 * The sprite rides the same machine test as the boom above: bodies that
	 * read as bots or mechs burst where they fall, everyone else just falls
	 * with their voice. (An earlier pass drew this for EVERY elimination,
	 * because the old mech-only check asked wears_mech() -- alive-gated, on
	 * an already-dead body, so it could never fire and the shape of that
	 * bug read as "mech deaths have no sprite". The machine test reads the
	 * class pick record, which has no alive gate, so it holds on the death
	 * frame.)
	 *
	 * Sits AFTER the voice emit, before anything here has hidden or moved
	 * the body, so the sprite lands where the body still is.
	 */
	if (machine)
	{
		new Float:dorigin[3];
		pev(id, pev_origin, dorigin);
		dorigin[2] += 16.0;   // a corpse's origin sits at waist height; lift the burst clear of the floor
		message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
		write_byte(TE_EXPLOSION);
		write_coord(floatround(dorigin[0]));
		write_coord(floatround(dorigin[1]));
		write_coord(floatround(dorigin[2]));
		write_short(g_obj_boom_spr);   // zerogxplode.spr
		write_byte(25);                // scale in tenths
		write_byte(20);                // framerate
		write_byte(TE_EXPLFLAG_NONE);
		message_end();
	}
}

/// A random working slot from a voice pool, 1..5 -- 0 when none of its wavs exist.
pick_death_voice(bool:fem)
{
	// Six slots, not five: male6.wav sits in the folder and is precached with the
	// rest, and the old one-to-five bound silently removed it from the pool -- the
	// one death voice the file list contained that was never played.
	new ready[6], picks = 0;
	for (new i = 1; i <= 6; i++)
	{
		if (fem ? g_death_fem_ok[i] : g_death_male_ok[i])
		{
			ready[picks++] = i;
		}
	}
	if (picks == 0)
	{
		return 0;
	}
	return ready[random_num(0, picks - 1)];
}

/* ---- team-scoped kill reporting ----------------------------------------- */

report_elimination(killer, victim)
{
	if (!get_pcvar_num(g_cv_report))
	{
		return;
	}

	new vname[32], kname[32];
	get_user_name(victim, vname, charsmax(vname));

	new vteam = g_match_team[victim];
	new bool:has_killer = (killer >= 1 && killer < MAXPL && killer != victim && is_user_connected(killer));
	new kteam = 0;

	new hp[32];
	hp[0] = 0;

	if (has_killer)
	{
		get_user_name(killer, kname, charsmax(kname));
		kteam = g_match_team[killer];

		if (get_pcvar_num(g_cv_reporthp))
		{
			// Both are float entvars, so the Float: tag override is required.
			new Float:fhp = Float:pev(killer, pev_health);
			new Float:fap = Float:pev(killer, pev_armorvalue);
			new khp = floatround(fhp);
			new kap = floatround(fap);

			/*
			 * Only reported when it is believable. A killer who is somehow on 0hp is a
			 * reading we failed to take, not a real state -- and '0hp / 0ap' is worse
			 * than saying nothing, because it reads as hard intel and is wrong.
			 */
			if (khp > 0)
			{
				if (kap > 0)
				{
					formatex(hp, charsmax(hp), " -- on %dhp / %dap", khp, kap);
				}
				else
				{
					formatex(hp, charsmax(hp), " -- on %dhp", khp);
				}
			}
			else
			{
				dbgv("kill report: could not read %d's health (got %d/%d)", killer, khp, kap);
			}
		}
	}

	if (!has_killer)
	{
		team_print(vteam, "[MATCH] %s was eliminated.", vname);
		team_print(vteam == 1 ? 2 : 1, "[MATCH] %s was eliminated.", vname);
	}
	else if (kteam == vteam)
	{
		// Team kill: told only to the team it happened to, and not dressed up.
		team_print(vteam, "[MATCH] TEAMKILL: %s eliminated %s.", kname, vname);
	}
	else
	{
		// The killer's side learns the trade and their own man's condition.
		team_print(kteam, "[MATCH] %s eliminated %s%s", kname, vname, hp);
		// The victim's side learns who did it and how hurt they are -- the
		// actionable half, and the reason this is team-scoped.
		team_print(vteam, "[MATCH] %s was eliminated by %s%s", vname, kname, hp);
	}

	// On their feet, not counting anyone waiting for a wave -- the victim among them, whose life is
	// already spent by the time this reports it.
	new a1 = count_standing(1);
	new a2 = count_standing(2);

	// Lives are meaningless at the one-life-each tsm_respawns 0 default, so the extra
	// half of the line only appears once there is something to say with it.
	if (get_pcvar_num(g_cv_respawns))
	{
		new l1 = team_lives_left(1);
		new l2 = team_lives_left(2);
		team_print(1, "[MATCH] %d alive vs %d alive -- %d %s left vs %d %s left",
			a1, a2, l1, (l1 == 1) ? "life" : "lives", l2, (l2 == 1) ? "life" : "lives");
		team_print(2, "[MATCH] %d alive vs %d alive -- %d %s left vs %d %s left",
			a2, a1, l2, (l2 == 1) ? "life" : "lives", l1, (l1 == 1) ? "life" : "lives");
	}
	else
	{
		team_print(1, "[MATCH] %d alive vs %d alive", a1, a2);
		team_print(2, "[MATCH] %d alive vs %d alive", a2, a1);
	}
}

team_print(team, const fmt[], any:...)
{
	if (team != 1 && team != 2)
	{
		return;
	}
	new msg[192];
	vformat(msg, charsmax(msg), fmt, 3);

	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (g_match_team[id] == team)
		{
			client_print(id, print_chat, "%s", msg);
		}
	}
}

all_print(const fmt[], any:...)
{
	new msg[192];
	vformat(msg, charsmax(msg), fmt, 2);
	client_print(0, print_chat, "%s", msg);
}

/* ---- round flow ---------------------------------------------------------- */

check_round_end()
{
	if (g_state != ST_LIVE)
	{
		return;
	}

	// A side that began the round with nobody has not been "eliminated" -- there was
	// never anyone to eliminate. Without this the round ends the instant it starts,
	// forever, which also leaves everyone permanently frozen and weaponless because
	// the freeze and the loadout reset are re-run on every cycle.
	if (!g_start_alive[1] || !g_start_alive[2])
	{
		return;
	}

	new a1 = count_alive(1);
	new a2 = count_alive(2);

	if (a1 > 0 && a2 > 0)
	{
		return;
	}

	new winner = 0;
	if (a1 > 0)
	{
		winner = 1;
	}
	else if (a2 > 0)
	{
		winner = 2;
	}

	/*
	 * Held for tsm_roundend_delay before the round actually ends.
	 *
	 * Ending on the frame the last enemy dies froze and hid everyone mid-kill --
	 * the shot that won the round and the round ending were the same instant, so
	 * nobody got to see it happen. The delay is also what lets the last death play
	 * out, because ST_ROUNDEND holds every player the moment it starts.
	 */
	if (g_end_pending_at <= 0.0)
	{
		g_end_pending_at = get_gametime();
		g_end_pending_winner = winner;
		dbg("round won by %d -- holding %.1fs before ending it",
			winner, get_pcvar_float(g_cv_endelay));
		return;
	}

	if ((get_gametime() - g_end_pending_at) < get_pcvar_float(g_cv_endelay))
	{
		return;
	}

	// The winner is the one from when the condition was FIRST met. Re-reading it
	// here would let a late respawn inside the delay change who won.
	new decided = g_end_pending_winner;
	g_end_pending_at = 0.0;
	g_end_pending_winner = 0;
	end_round(decided);
}

end_round(winner)
{
	// Belt and braces against a second entry before the state change lands: a
	// duplicated end would double-count the score and queue two next-rounds, which
	// is one way a match can blow straight past its win total.
	if (g_state != ST_LIVE)
	{
		return;
	}

	g_state = ST_ROUNDEND;
	remove_task(2);
	remove_task(4);
	lives_reset_round();

	// Cleared here as well, so a round ended any OTHER way (time up, a forfeit, an
	// admin command) does not leave a stale hold to trip the next round's check.
	g_end_pending_at = 0.0;
	g_end_pending_winner = 0;

	if (winner)
	{
		g_score[winner]++;
		new wonname[32];
		team_display(winner, wonname, charsmax(wonname));
		all_print("[MATCH] Round %d won by %s. Score: %d -- %d.",
			g_round, wonname, g_score[1], g_score[2]);
	}
	else
	{
		all_print("[MATCH] Round %d drawn. Score: %d -- %d.", g_round, g_score[1], g_score[2]);
	}

	show_score_hud();

	// A claimed mode closes the round its own way: the uplink takes its carrier's item back,
	// survival says how many waves were held.
	mode_notify(g_fw_round_end, winner);

	new need = (get_pcvar_num(g_cv_rounds) / 2) + 1;
	if (need < 1)
	{
		need = 1;   // a nonsense tsm_rounds must not mean "never end"
	}
	// A one-run mode (survival) has no best-of: the run that just ended was the match.
	if (mode_flag(TSM_MODE_ONE_RUN) || g_score[1] >= need || g_score[2] >= need)
	{
		set_task(3.0, "task_match_end", 4);
	}
	else
	{
		set_task(3.0, "task_next_round", 4);
	}
}

public task_next_round()
{
	start_round();
}

public task_match_end()
{
	g_state = ST_MATCHEND;
	if (mode_flag(TSM_MODE_ONE_RUN))
	{
		// The mode has already said how the run went; a 0 -- 1 scoreline would only confuse it.
		all_print("[MATCH] RUN OVER -- back to warmup. Type .ready for another.");
	}
	else
	{
		new w = (g_score[1] > g_score[2]) ? 1 : 2;
		new wname[32];
		team_display(w, wname, charsmax(wname));
		all_print("[MATCH] MATCH OVER -- %s wins, %d -- %d.", wname, g_score[1], g_score[2]);
	}
	restore_all();
	set_task(5.0, "task_to_warmup");
}

/*
 * Clears everything that belongs to a match rather than to a round.
 *
 * Kept as one function so the three ways a match can end -- finishing, being
 * cancelled, being restarted -- cannot drift apart. They had: cancelling returned to
 * warmup but left players still classed and late joiners still locked out of a match
 * that no longer existed.
 */
clear_match_state()
{
	for (new i = 1; i < MAXPL; i++)
	{
		g_locked_out[i] = false;
		g_player_class[i] = 0;
		g_class_menu_at[i] = 0.0;
		g_team_menu_at[i] = 0.0;
		g_eng_used[i] = 0.0;
		g_medic_at[i] = 0.0;
		g_squad_leader[i] = 0;
		g_scan_next[i] = 0.0;
		g_scan_until[i] = 0.0;
		g_scan_team[i] = 0;

		// The side they belonged to, released with the match it belonged to. Cleared
		// HERE and nowhere else, which is the whole point of it: see g_side.
		g_side[i] = 0;

		// Per MATCH, not per round: a player who changed appearance every round
		// would be unrecognisable to their own side.
		g_model_pick[i] = 0;
		g_model_pick_key[i] = 0;
		g_arm_pending[i] = 0;
		g_issuing[i] = false;
		g_cash_lend[i] = false;
		g_elim[i] = false;
		g_m60_skip[i] = -1;
		g_mech_hp_watch[i] = 0;
		g_start_alive[1] = 0;
		g_start_alive[2] = 0;
		remove_task(i);          // any pending armament respawn
	}
	g_warned_empty = false;

	// Per MATCH as well. A halt belongs to the match it interrupted, and so does an
	// admin's decision to play that match out short-handed -- neither may be inherited
	// by the next one, whose score they were never protecting.
	g_halted = false;
	g_halt_waived = false;

	// The alarm goes down with the match too: the next one is silent until its
	// own first attack, no matter how this one was called off. So does any
	// planted satchel and its fuse, which belong to the match they broke into.
	alarm_stop();
	remove_task(TSM_TASK_CHARGE);
	g_plant_ent = 0;
	g_plant_n = 0;
	g_plant_by = 0;
}

/*
 * The bot join schedule: ONE bot per pass, every two seconds.
 *
 * With rcbot's own auto-fill switched off (max_bots -1, see the bots-ON branch),
 * this is what reaches tsm_bots -- and it is the answer to the overflow: rcbot
 * used to paste its entire quota the moment it saw a deficit, every TS spawn,
 * precache and team message in one tick. A join every two seconds spreads ten
 * bots over twenty seconds, and a bot that leaves the game is replaced the same
 * slow way instead of a batch refill.
 *
 * Parked bots are left alone: between matches they sit out on purpose, and
 * refilling a bench that nobody sits on yet would just churn sides that the
 * next match's balance check is about to deal with anyway.
 *
 * Being over the target drains ONE bot per pass too, so lowering tsm_bots on a
 * live server bleeds the extras out on the same slow drip rather than a burst
 * of kicks in a single frame.
 */
public task_bot_fill()
{
	new want = get_pcvar_num(g_cv_bots);
	if (want <= 0 || g_bots_parked)
	{
		return;
	}

	new bp[32], bn, n = 0;
	get_players(bp, bn, "");   // no flags -- bots count
	for (new i = 0; i < bn; i++)
	{
		if (is_user_bot(bp[i]))
		{
			n++;
		}
	}

	if (n < want)
	{
		server_cmd("rcbot addbot");
		server_exec();
		dbg("bot fill: %d/%d -- one joining", n, want);
	}
	else if (n > want)
	{
		for (new i = 0; i < bn; i++)
		{
			if (is_user_bot(bp[i]))
			{
				server_cmd("kick #%d", get_user_userid(bp[i]));
				server_exec();
				dbg("bot trim: %d on, target %d -- sending %d out", n, want, bp[i]);
				break;
			}
		}
	}
}

/*
 * One delayed kick, so turning bots OFF does not kick the whole fleet in a
 * single tick either -- same staggering discipline as every other move here.
 */
public task_kick_bot(taskid)
{
	new id = taskid - TSM_TASK_BOTKICK;
	if (is_user_connected(id) && is_user_bot(id))
	{
		server_cmd("kick #%d", get_user_userid(id));
		server_exec();
	}
}

/*
 * Hand every bot an assign task SPREAD OVER TIME instead of all of them inside
 * one tick, which side-wrote and respawned the whole fleet at once.
 *
 * Half a second apart, so ten bots are all placed within five seconds -- quick
 * enough that the freeze countdown never exposes a missing bot, and slow enough
 * that no tick carries more than one respawn's worth of messages.
 */
stagger_assign_bots()
{
	new bp[32], bnum, k = 0;
	get_players(bp, bnum, g_pf);
	for (new i = 0; i < bnum; i++)
	{
		if (is_user_bot(bp[i]))
		{
			remove_task(bp[i] + 6000);
			set_task(0.5 * float(k), "task_assign_bot", bp[i] + 6000);
			k++;
		}
	}
	return k;
}

/*
 * Lets bots pick sides again after a match.
 *
 * g_match_team was cleared when they were parked, so assign_bot() places each of them
 * fresh -- which is the point of parking them at all: sides are rebalanced rather than
 * carried over from the match that just finished.
 */
public task_unpark_bots()
{
	if (!get_pcvar_num(g_cv_bots))
	{
		return;
	}

	g_bots_parked = false;

	new n = stagger_assign_bots();

	if (n)
	{
		all_print("[MATCH] %d bot(s) back in and picking sides.", n);
		dbg("unparked %d bot(s) after the match, staggered", n);
	}
}

public task_to_warmup()
{
	// The match is over, so the lockout ends here -- everyone becomes eligible again.
	clear_match_state();
	turrets_clear();

	g_state = ST_WARMUP;

	bench_everyone();
	g_round = 0;
	siege_reset();
	g_score[1] = 0;
	g_score[2] = 0;
	reset_ready();
	all_print("[MATCH] Back in warmup. Type .ready when you are.");
}

/*
 * Everyone off the sides, onto the spectator team, with the side menu offered to the humans:
 * how a finished match hands back to warmup, and how amx_match_cancel ends one early.
 */
bench_everyone()
{
	/*
	 * Everyone goes back to spectator between matches and opts in again.
	 *
	 * Sides are re-picked rather than carried over, so the balance check gets a say
	 * before the next match instead of inheriting whatever the last one ended with.
	 */
	/*
	 * Bots are parked too, and STAY parked.
	 *
	 * Without the flag the one-second poll put them straight back on a side, so they
	 * never actually sat out -- sides carried over from the finished match and the
	 * balance check never got a say. They are brought back in by begin_match().
	 */
	g_bots_parked = true;

	// They come back on their own after a breather -- see task_unpark_bots.
	remove_task(9);
	set_task(get_pcvar_float(g_cv_botreturn), "task_unpark_bots", 9);

	new wp[32], wnum;
	get_players(wp, wnum, g_pf);
	/*
	 * THE TRANSITION STAGGER. force_spectator sends every one of these bodies its
	 * team change, its own teleport and its own reliable messages, and a whole
	 * match's worth of players moved in ONE frame is exactly the burst that has
	 * been ending the match over the reliable datagram rather than at the score.
	 * Player N is moved N*0.25 s after the first, so the same volume flows across
	 * several seconds instead of one instant -- the same spread that ended the
	 * armature's round-start overload.
	 */
	for (new i = 0; i < wnum; i++)
	{
		set_task(0.25 * float(i), "task_force_spec_late", wp[i] + 7800);

		// Only humans get the menu -- a bot cannot answer one. Staggered the
		// same way, because twenty-four ShowMenu reliable packets in one
		// instant brought the same verdict more than once.
		if (!is_user_bot(wp[i]))
		{
			set_task(2.0 + 0.25 * float(i), "task_show_side", wp[i] + 2000);
		}
	}
	all_print("[MATCH] Everyone is spectating. Pick a side to play the next match, or type .menu.");
}

/*
 * The sudden-death fog, in one place.
 *
 * The h9_fog_* cvars belong to the ENGINE (see engine-h9-suddendeath.patch): every
 * server frame it reads all four, packs them into movevars, and the clients' renderers
 * fog the world with them. On a stock engine they are ordinary unknown cvars that do
 * nothing at all, which is exactly what this wants.
 *
 * on=true holds the plugin's chosen colour and density; anything else zeroes all four,
 * which is also what a round boundary does to them -- the bog belongs to sudden death
 * alone, and never survives into the next minute that has none.
 */
sudden_fog(bool:on)
{
	set_cvar_num("h9_fog_r",       on ? get_pcvar_num(g_cv_suddenfog_r) : 0);
	set_cvar_num("h9_fog_g",       on ? get_pcvar_num(g_cv_suddenfog_g) : 0);
	set_cvar_num("h9_fog_b",       on ? get_pcvar_num(g_cv_suddenfog_b) : 0);
	set_cvar_num("h9_fog_density", on ? get_pcvar_num(g_cv_suddenfog_d) : 0);
	tlog("[TSM] Sudden fog %s, h9_fog_density now %d", on ? "on" : "off", get_cvar_num("h9_fog_density"));
}

/// Debug toggle for the sudden-death fog, so it can be looked at without waiting for a
/// real sudden death. Needs tsm_logging 1, so it cannot be run by accident on a server
/// that is not already being watched for problems. Refuses outright once real sudden
/// death has started this round, so it can never turn the real fog off early or leave
/// behind a state the real trigger or start_round() does not already clear -- the real
/// trigger always wins, and g_fogtest is reset at every round start alongside it.
public cmd_fogtest(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}
	if (!get_pcvar_num(g_cv_logging))
	{
		console_print(id, "[TSM] tsm_fogtest needs tsm_logging 1 first -- it is a debug-only toggle.");
		return PLUGIN_HANDLED;
	}
	if (g_sudden)
	{
		console_print(id, "[TSM] Sudden death is already live this round -- tsm_fogtest leaves its fog alone.");
		return PLUGIN_HANDLED;
	}

	g_fogtest = !g_fogtest;
	sudden_fog(g_fogtest);
	console_print(id, "[TSM] Test fog %s (h9_fog_density now %d). A new round clears this the same as the real fog.",
		g_fogtest ? "ON" : "OFF", get_cvar_num("h9_fog_density"));
	return PLUGIN_HANDLED;
}

/// Every command this plugin has registered, in the two groups AMXX itself keeps them in:
/// console commands first (register_concmd, and the one register_srvcmd -- admin and
/// operator commands, run from the server console or an admin's own client), then client
/// commands (register_clcmd -- what an ordinary player's own client sends, typed or not).
///
/// The console half is read live through get_concmd_plid: cid, the id of THIS command's own
/// invocation, already names this plugin, so nothing needs to be hardcoded there and it can
/// never go stale. Client commands have no such lookup in AMXX -- get_clcmd has no plugin-id
/// filter the way get_concmd does -- so that half is named by hand. Keep it matching every
/// register_clcmd( call in plugin_init if one is ever added, removed or renamed.
public cmd_commands(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new myid = get_concmd_plid(cid, -1, -1);
	new name[32], info[192], flags, bool:info_ml, shown;

	console_print(id, "[TSM] Server-side commands (console and admin -- register_concmd, register_srvcmd):");
	shown = 0;
	new total_con = get_concmdsnum(-1, -1);
	for (new i = 0; i < total_con; i++)
	{
		if (get_concmd_plid(i, -1, -1) != myid)
		{
			continue;
		}
		if (!get_concmd(i, name, charsmax(name), flags, info, charsmax(info), -1, -1, info_ml))
		{
			continue;
		}
		console_print(id, "  %-24s %s", name, info);
		shown++;
	}
	console_print(id, "[TSM] %d server-side command(s).", shown);

	static const clcmds[][] = {
		"say", "say_team", "tkw", "tka", "tki", "rst_cfg", "cashala", "tsm_model",
		"stim", "tsm_mechtest", "usepowerup", "powerup", "say .class", "say .team",
		"say .menu", "say .roam", "tsm_music", "jointeam", "changeteam"
	};

	console_print(id, "[TSM] Client commands (register_clcmd):");
	shown = 0;
	new total_cl = get_clcmdsnum(-1);
	for (new i = 0; i < total_cl; i++)
	{
		if (!get_clcmd(i, name, charsmax(name), flags, info, charsmax(info), -1, info_ml))
		{
			continue;
		}
		new bool:mine = false;
		for (new k = 0; k < sizeof clcmds; k++)
		{
			if (equal(name, clcmds[k]))
			{
				mine = true;
				break;
			}
		}
		if (!mine)
		{
			continue;
		}
		console_print(id, "  %-24s %s", name, info);
		shown++;
	}
	console_print(id, "[TSM] %d client command(s).", shown);
	return PLUGIN_HANDLED;
}

start_round()
{
	g_round++;
	g_resetting = true;
	lives_reset_round();
	turrets_clear();

	/*
	 * THE WHOLE CHAIN COMES BACK EVERY ROUND. The map's reset relays fire for
	 * whatever fell, every destroyed body is rebuilt from the load-time cache,
	 * and the round starts at objective 1 again -- after a full chain as much
	 * as after a partial one.
	 */
	siege_reset();

	// The old round's alarm dies with the old round: a fresh one is silent
	// until somebody attacks something of the other side again. And a satchel
	// still on its fuse when the round ended dies with it: no planted state
	// and no fuse cross into the next one.
	alarm_stop();
	remove_task(TSM_TASK_CHARGE);
	g_plant_ent = 0;
	g_plant_n = 0;
	g_plant_by = 0;

	// A new round is never in sudden death, whatever the last one ended as. The
	// go-live reset keeps the headline honest; this one makes the freeze itself
	// clean, so nothing sudden-death shaped can cross a round boundary through any
	// path that skips the release.
	g_sudden = false;

	// The fog lifts with it. Zeroed rather than merely left: an operator's hand can
	// have set an h9_fog cvar to something odd while sudden death ran, and the round
	// boundary is the one place every route back to plain visibility passes.
	sudden_fog(false);

	// tsm_fogtest never survives into a new round either, for the same reason.
	g_fogtest = false;

	// A claimed mode puts its own state back to the round's start: the uplink's zones go
	// neutral, the survival wave count goes back to 1.
	mode_notify(g_fw_round_start, g_round);

	// Re-forced every round: cashforwin and cashforlose are read at the END of one,
	// and a map change or an rcon set in between would have put them back.
	kill_ts_cash_cvars();

	// Even the sides up before anything else reads them -- a disconnect mid-match
	// would otherwise leave the rest of the match short-handed.
	autofill_teams();

	// Bots that connected mid-match get their side and class here -- staggered the
	// same way as the unpark and begin_match, one bot per half second.
	stagger_assign_bots();

	// Anything dropped during warmup or the previous round goes now, so it cannot be
	// collected once the round is live.
	sweep_dropped_items();
	sweep_powerups();

	// Teams are re-read at the START of each round rather than only once at match
	// start. That stabilises them WITHIN a round (so a mid-round change cannot
	// corrupt alive-counting) while still picking up players who joined or switched
	// between rounds -- who would otherwise be invisible to the whole system.
	cache_teams();

	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		g_elim[id] = false;
		g_spec_target[id] = 0;
		g_last_buttons[id] = 0;
		g_elim_at[id] = 0.0;
		g_was_alive[id] = (is_user_alive(id) != 0);
		g_pending_elim[id] = 0.0;
		g_last_use[id] = 0;

		// The engineer's resupply, the medic's cooldown and any standing squad order
		// are per-ROUND budgets; the class itself is picked once and kept for the
		// whole match.
		g_eng_used[id] = 0.0;
		g_medic_at[id] = 0.0;
		g_stim_used[id] = false;
		g_forfeit[id] = false;
		g_squad_leader[id] = 0;

		// The Officer's .scan re-arms with the round like the other perks' cool-downs,
		// and no scan mark outlives the round it was scanned in: the shell is refused
		// by the expiry check anyway, but a carried mark would fire the WRONG side's
		// line the moment g_match_team changed under someone.
		g_scan_next[id] = 0.0;
		g_scan_until[id] = 0.0;
		g_scan_team[id] = 0;

		// Zeroed so the first tick of the round tops bots up straight away rather
		// than making them wait out a full interval with whatever BuyArmament left them.
		g_bot_resup_at[id] = 0.0;

		/*
		 * PUT BACK ON THEIR SIDE, not merely un-eliminated.
		 *
		 * Elimination moves a player onto TS's spectator team (set_ts_spectator), and
		 * clearing g_elim above does not undo that. is_spectating() stays true, and the
		 * presentation hook acts on it in EVERY state -- hidden, non-solid, no damage --
		 * so they spawned into the next round alive and the plugin went on treating them
		 * as dead for the whole of it. That is the "still dead in the buy menu after the
		 * respawn" fault.
		 *
		 * g_match_team survives elimination precisely so this can be reversed; a player
		 * who CHOSE to sit out has no match team and is left alone by the guard.
		 */
		if (g_match_team[id] && is_spectating(id))
		{
			dbg("round start: %d was still on the spectator team -- back to %d", id, g_match_team[id]);
			set_ts_team(id, g_match_team[id]);
		}

		restore_presentation(id);
	}

	/*
	 * Loadout reset.
	 *
	 * This used to kill everyone and let TS respawn them with its default kit. That
	 * was wrong three ways over: ts_set_speed scales a player's whole time base, so
	 * dying while held produced a slow-motion death; the corpse was still dead when
	 * the round went live, which made count_alive() report zero for both teams and
	 * suspended round-end checking; and a player who stays dead gets moved to
	 * spectator by the mod, knocking them off their team.
	 *
	 * ts_giveweapon and strip_user_weapons do the same job without any of that, so
	 * nobody dies at a round start any more.
	 */
	/*
	 * Everything goes, every round.
	 *
	 * Whatever is sitting in a player's TS purchase cart must not survive into a
	 * round -- the class is the only source of equipment. Safe only because players
	 * are frozen for the whole freeze countdown and re-armed by apply_class() in the
	 * same function that releases them: TS derives player speed from the weapon slots
	 * the loadout consumes, so a stripped player has zero maxspeed and must never be
	 * mobile in that state.
	 */
	// Nothing is stripped here. Stripping lives inside the arm operation (the gated
	// wipe in task_arm_respawn) and never separates from it -- in TS a player holding
	// nothing has zero maxspeed, so strip and re-arm are one never-separated operation.

	finish_round_start();
}

public task_finish_round_start()
{
	finish_round_start();
}

finish_round_start()
{
	/*
	 * The freeze is set before anyone is armed. issue_armament spaces the arms across the freeze,
	 * and it can only do that when the state is already FREEZE at the moment it is called.
	 */
	g_state = ST_FREEZE;
	g_freeze_left = get_pcvar_num(g_cv_freeze);

	new players[32], pnum, id, still_dead = 0;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		g_placed[id] = false;

		if (!is_user_alive(id))
		{
			// Still a corpse at round start. Spawn them rather than let them miss the
			// round: the freeze countdown would eventually catch them, but only once
			// the mod decided to respawn them, which is not guaranteed to happen
			// before the round is already live.
			if (get_pcvar_num(g_cv_forcespawn) && g_match_team[id] > 0)
			{
				/*
				 * TS's OWN respawn command FIRST, and this is what gets a loadout on
				 * every round after the first.
				 *
				 * A player who died is left in the mod's observer state:
				 * PlayerDeathThink ends in StartObserver, which sets iuser1, deadflag
				 * DEAD_RESPAWNABLE, EF_NODRAW, SOLID_NOT and MOVETYPE_NONE.
				 * DLLFunc_Spawn does not lift any of that, so they were still not alive
				 * on the line below, were counted as still_dead, and skipped the arming
				 * further down -- a round with no weapons and no attack. The first round
				 * of a match was fine only because nobody had died into it yet.
				 *
				 * The mod's own command is used rather than clearing iuser1 here. Per
				 * the design note at the top of this file, writing iuser1 makes TS
				 * reclassify the player as a spectator and move them off their team,
				 * which breaks alive-counting, team chat and the scoreboard at once.
				 * Asking TS to respawn them leaves that bookkeeping to the mod.
				 */
				engclient_cmd(id, "respawn");

				// Kept as the fallback it always was, for the case where the mod
				// declines -- it answers "You have to wait until the next round." in
				// some states, and a player with no loadout is worse than a hard spawn.
				if (!is_user_alive(id))
				{
					dllfunc(DLLFunc_Spawn, id);
				}

				dbg("force-spawned %d at round start (alive=%d)", id, is_user_alive(id) ? 1 : 0);
			}

			if (!is_user_alive(id))
			{
				still_dead++;
				continue;
			}
		}
		set_pev(id, pev_health, float(get_pcvar_num(g_cv_health)));
		place_at_spawn(id);

		// The wash, and the ONE arm behind it: rst_cfg empties what TS had SAVED for
		// This player, so their old loadout can never be re-applied by the round-start
		// respawn, and issue_armament schedules the arm respawn for the settled
		// class. An unpicked player IS settled at the wash: tsm_default_class is
		// made their pick right there, so the freeze arm dresses them too, and
		// the go-live release never strips or gives anything. An explicit pick
		// made this round still re-arms on the spot through task_reissue_armament.
		//
		// Bots included -- engclient_cmd reaches them, so they get the class loadout
		// the same way humans do.
		if (get_pcvar_num(g_cv_wpnmode) == 2 && get_pcvar_num(g_cv_classes))
		{
			issue_armament(id);
		}

		/*
		 * Bots get their class model here, once per round.
		 *
		 * ClientUserInfoChanged never fires for a fake client, so the re-assert that
		 * keeps humans looking right cannot reach a bot. This is the one place that
		 * runs for every bot on every round -- one write each, instead of the
		 * per-second loop that was rewriting everyone's model forever.
		 *
		 * Guarded against re-entry for the same reason the loadout call is.
		 */
		if (is_user_bot(id))
		{
			/*
			 * resolved_class, not g_player_class.
			 *
			 * A bot whose class was never assigned has g_player_class 0, and the old test
			 * skipped it entirely -- so it kept whatever model TS handed it and never fell
			 * back to its side's Assault model. resolved_class falls back to
			 * tsm_default_class, so there is always an answer.
			 */
			new bool:bwas = g_in_userinfo[id];
			g_in_userinfo[id] = true;
			set_class_model(id, resolved_class(id) - 1);
			g_in_userinfo[id] = bwas;
		}

		// An Officer's whole perk is two chat commands, so it is invisible unless we
		// say so. Humans only -- a bot cannot read it and cannot type one.
		if (!is_user_bot(id)
			&& g_class_count
			&& g_class_perk[resolved_class(id) - 1] == TSM_PERK_OFFICER)
		{
			client_print(id, print_chat,
				"[MATCH] Officer: .follow takes bots on your side under command, .unfollow releases them, .scan exposes cloaked enemies near you, .reinforce calls the waiting dead back.");
		}
	}

	if (still_dead)
	{
		dbg("round %d: %d player(s) dead at placement time; freeze tick will place them", g_round, still_dead);
	}

	g_resetting = false;
	// Every corpse of the round just gone is forgotten here, so an entity index the
	// engine recycles cannot inherit the clock of a body that is already gone.
	clear_corpse_memory();

	// Arm-gate: nobody is equipped yet this round.
	for (new _g = 1; _g <= get_maxplayers(); _g++)
	{
		g_armed[_g] = false;
	}
	g_gate_deadline = 0.0;

	all_print("[MATCH] Round %d starting -- %d second freeze.", g_round, get_pcvar_num(g_cv_freeze));

	// A freeze with no visible timer reads as the server having hung, even when it
	// is working perfectly. The countdown is the difference between "broken" and
	// "about to start".
	// Class pick happens once, during the first freeze of the match.
	if (g_round == 1 && g_class_count && get_pcvar_num(g_cv_classes))
	{
		new mp[32], mnum, shown = 0;
		get_players(mp, mnum, g_pf);
		for (new i = 0; i < mnum; i++)
		{
			g_class_menu_at[mp[i]] = 0.0;
			if (!g_player_class[mp[i]])
			{
				show_class_menu(mp[i]);
				shown++;
			}
		}
		dbg("class menu offered to %d of %d player(s) (menu built=%d, classes=%d)",
			shown, mnum, g_class_menu ? 1 : 0, g_class_count);
		all_print("[MATCH] Pick your class. Anyone who does not gets %s.",
			g_class_name[resolved_class(0) - 1]);
	}

	remove_task(3);
	set_task(1.0, "task_freeze_tick", 3, "", 0, "b");

	set_task(float(get_pcvar_num(g_cv_freeze)), "task_go_live");

	tlog("[TSM] finish_round_start: scheduling sound tasks (freeze=%d)", get_pcvar_num(g_cv_freeze));

	/*
	 * THE TEAM OBJECTIVE BANNERS, ONE SECOND IN.
	 *
	 * Two tasks, one per side, both one second after finish_round_start() because
	 * the round-start HUD storm (the countdown itself taking channel 2 every
	 * second) needs to settle before anything new is posted. Each task re-reads
	 * ITS cvar at fire time, so editing ts_matchmode.cfg changes what the NEXT
	 * round shows without a restart. Stale tasks from a round that ended inside
	 * the window are removed first -- a halted or cancelled round must not paint
	 * its banner over ready-up.
	 */
	for (new ob = 1; ob <= 2; ob++)
	{
		remove_task(ob + TSM_TASK_OBJMSG);
		set_task(1.0, "task_team_objmsg", ob + TSM_TASK_OBJMSG);
	}

	/*
	 * THE ROUND-START ANTHEMS, one second in with the banners. One task a
	 * round, on its own server-wide id, and stale anthem tasks from a round
	 * that ended inside the window are removed first -- the same reason the
	 * banner tasks above carry theirs with them.
	 */
	remove_task(TSM_TASK_SONGS);
	set_task(1.0, "task_start_songs", TSM_TASK_SONGS);
	tlog("[TSM] finish_round_start: task_start_songs scheduled at 1.0s (id=%d)", TSM_TASK_SONGS);

	/*
	 * THE INSURGENT ROAR, four seconds after their anthem (the songs play at
	 * 1.0, so the cry lands at 5.0). One task a round on its own id, cut
	 * first at every round start the same way -- a round that ended inside
	 * the window never roars over live play.
	 */
	remove_task(TSM_TASK_ROAR);
	set_task(5.0, "task_team_roar", TSM_TASK_ROAR);
	tlog("[TSM] finish_round_start: task_team_roar scheduled at 5.0s (id=%d)", TSM_TASK_ROAR);

	/*
	 * THE MSR BADUM, same 5.0s timing (1.0s anthem + 4s).
	 */
	remove_task(TSM_TASK_BADUM);
	set_task(5.0, "task_team_badum", TSM_TASK_BADUM);
	tlog("[TSM] finish_round_start: task_team_badum scheduled at 5.0s (id=%d)", TSM_TASK_BADUM);
}

/// Collects this team's spawn point indices at this tier into idx[] (which must hold at
/// least `size` entries), returning how many there are. The single source of truth for
/// "how many spawn points does this team have at this tier" -- pick_spawn_point uses it
/// to build its own candidate list, and spawn_count_for_tier() below hands fire_wave()
/// just the count, off the exact same data, so the two can never disagree about the
/// denominator.
spawn_tier_points(team, tier, idx[], size)
{
	new n = 0;
	new count = (team == 1) ? g_spawn_t1_count : g_spawn_t2_count;
	for (new i = 0; i < count; i++)
	{
		new t = (team == 1) ? g_spawn_t1_tier[i] : g_spawn_t2_tier[i];
		if (t == tier && n < size)
		{
			idx[n++] = i;
		}
	}
	return n;
}

/// How many spawn points this team has at this tier -- spawn_tier_points() without
/// needing anywhere to put the indices.
spawn_count_for_tier(team, tier)
{
	new idx[64];
	return spawn_tier_points(team, tier, idx, sizeof idx);
}

/// Picks one of the team's points at a tier, in the order they were placed. A slot steps
/// through them (a wave hands out one slot per player); no slot picks at random.
bool:pick_spawn_point(id, team, tier, slot, Float:org[3], Float:ang[3])
{
	new idx[64];
	new n = spawn_tier_points(team, tier, idx, sizeof idx);
	if (n == 0)
	{
		return false;
	}

	/*
	 * Occupancy scan, shared by both the explicit-slot and random paths below.
	 *
	 * Originally only the random (slot < 0) path checked this -- added to fix
	 * "bots die for no reason at round start" (two independent random picks, or
	 * a late placement and an already-settled player, landing on the exact same
	 * point, stacked and frozen, then both exposed the instant they stop being
	 * damage-immune). But fire_wave() hands every revived player in one wave an
	 * EXPLICIT slot ("offset + n", one per player queued that wave) that flows
	 * straight into the slot>=0 branch below, which had no occupancy check at
	 * all -- so whenever one wave revives more players than there are spawn
	 * points at that tier, two slots are guaranteed to collide on the same point
	 * by the pigeonhole principle (e.g. 5 players, 4 points: slots 0 and 4 both
	 * land on index 0 mod 4). That is "dying inside each other during the held
	 * freeze," reported after the lives/respawn-wave system shipped -- the wave
	 * system's own explicit-slot path was simply never covered by the earlier
	 * fix. Prefer a candidate not within a hull width of any other connected,
	 * alive player's CURRENT origin; fall back to plain random/modulo across
	 * every candidate if all of them are occupied, which is never worse than
	 * before.
	 */
	new Float:occ[32][3], onum = 0;
	new occp[32], opnum;
	get_players(occp, opnum, g_pfa);   // connected and alive
	for (new p = 0; p < opnum && onum < sizeof occ; p++)
	{
		if (occp[p] == id)
		{
			continue;
		}
		pev(occp[p], pev_origin, occ[onum]);
		onum++;
	}

	new free[64], fn = 0;
	for (new k = 0; k < n; k++)
	{
		new Float:cand[3];
		if (team == 1)
		{
			copy_vec(cand, g_spawn_t1[idx[k]]);
		}
		else
		{
			copy_vec(cand, g_spawn_t2[idx[k]]);
		}

		new bool:occupied = false;
		for (new o = 0; o < onum; o++)
		{
			if (get_distance_f(cand, occ[o]) < TSM_SPAWN_CLEARANCE)
			{
				occupied = true;
				break;
			}
		}
		if (!occupied)
		{
			free[fn++] = k;
		}
	}

	new pick;
	if (slot >= 0)
	{
		// Try the requested slot first -- preserves the "spread across the
		// ring" intent when there's no collision. Only redirect to a free
		// point if the requested one is actually occupied; if everything is
		// occupied there's nothing to gain by redirecting either.
		new wanted = slot % n;
		new bool:wanted_free = false;
		for (new f = 0; f < fn; f++)
		{
			if (free[f] == wanted)
			{
				wanted_free = true;
				break;
			}
		}
		pick = (wanted_free || fn == 0) ? wanted : free[random_num(0, fn - 1)];
	}
	else
	{
		pick = (fn > 0) ? free[random_num(0, fn - 1)] : random_num(0, n - 1);
	}

	if (team == 1)
	{
		copy_vec(org, g_spawn_t1[idx[pick]]);
		copy_vec(ang, g_ang_t1[idx[pick]]);
	}
	else
	{
		copy_vec(org, g_spawn_t2[idx[pick]]);
		copy_vec(ang, g_ang_t2[idx[pick]]);
	}
	return true;
}

/// The team's active tier: the highest forward tier whose objective has fallen and which has
/// points for this team. 0 means the team's defaults. A reached tier replaces the defaults.
active_spawn_tier(team)
{
	new best = 0;
	new count = (team == 1) ? g_spawn_t1_count : g_spawn_t2_count;
	for (new i = 0; i < count; i++)
	{
		new t = (team == 1) ? g_spawn_t1_tier[i] : g_spawn_t2_tier[i];
		if (t > best && t <= g_obj_taken)
		{
			best = t;
		}
	}
	return best;
}

/// Puts the player at one of their team's points. A wave respawn (respawn = true) takes the
/// team's active forward tier. Anyone else gets the team's defaults, so a living player is
/// never moved to a forward point. Then the other side's defaults if the team has nothing at
/// that tier, then the map's own spawns. Locked tiers are never used.
place_at_spawn(id, slot = -1, bool:respawn = false)
{
	new team = g_match_team[id];
	new Float:org[3], Float:ang[3];
	new bool:has_ang = false;
	new bool:found = false;

	if (team == 1 || team == 2)
	{
		found = pick_spawn_point(id, team, respawn ? active_spawn_tier(team) : 0, slot, org, ang);
		if (found)
		{
			has_ang = g_spawns_have_angles;
		}
	}

	if (!found && (team == 1 || team == 2))
	{
		found = pick_spawn_point(id, 3 - team, 0, slot, org, ang);
		if (found)
		{
			has_ang = g_spawns_have_angles;
			dbg("place: team %d has no points at its tier, borrowed the other side's defaults", team);
		}
	}

	if (!found && g_spawn_count > 0)
	{
		copy_vec(org, g_spawns[random_num(0, g_spawn_count - 1)]);
		found = true;
	}

	if (!found)
	{
		dbg("place: no spawn available for player %d (team %d)", id, team);
		return;
	}

	engfunc(EngFunc_SetOrigin, id, org);
	g_placed[id] = true;

	if (has_ang)
	{
		// fixangle snaps the client's view to match instead of letting it lerp.
		set_pev(id, pev_angles,  ang);
		set_pev(id, pev_v_angle, ang);
		set_pev(id, pev_fixangle, 1);
	}
	// Clear momentum, or they arrive still carrying their old velocity.
	new Float:zero[3];
	zero[0] = 0.0;
	zero[1] = 0.0;
	zero[2] = 0.0;
	set_pev(id, pev_velocity, zero);
}

public task_freeze_tick()
{
	if (g_state != ST_FREEZE)
	{
		remove_task(3);
		return;
	}

	// Same renewal requirement as the warmup hold.
	new fp[32], fnum, fid;
	get_players(fp, fnum, g_pf);
	new offered = 0;      // how many menus this tick has already spaced out
	for (new i = 0; i < fnum; i++)
	{
		fid = fp[i];
		hold_player(fid, false);
		reassert_team(fid);

		/*
		 * Re-offered for the whole countdown rather than shown once at round start.
		 * A single menu_display is fragile: anything that takes keyboard focus -- a TS
		 * VGUI panel, another menu -- swallows it and it never comes back, which is
		 * why the class menu appeared to never show at all.
		 */
		if (g_class_count
			&& get_pcvar_num(g_cv_classes)
			&& !g_player_class[fid]
			&& !g_spectator[fid]
			&& tsm_live_team_of(fid)
			&& (get_gametime() - g_class_menu_at[fid]) > get_pcvar_float(g_cv_classretry))
		{
			/*
			 * ONE MENU PER FRAME, NOT ONE PER PLAYER ON THIS FRAME.
			 *
			 * This tick runs once a second and tsm_class_retry is a second, so at the top of a
			 * freeze every player who has not picked yet is offered the menu on the SAME frame.
			 * A ShowMenu carrying seven classes and their names is a few hundred bytes, so on a
			 * full server that is several kilobytes in one packet, every second, on top of the
			 * entity updates the frame was already carrying -- and a client whose buffer will not
			 * take it drops out with "Illegible server message - svc_bad".
			 *
			 * Spread over the second they are all offered just as quickly from a player's point
			 * of view, and no frame carries more than one.
			 */
			dbgv("freeze tick: offering class menu to %d", fid);
			remove_task(fid + 14000);
			set_task(0.02 + 0.05 * float(offered), "task_offer_class_menu", fid + 14000);
			offered++;
		}

		// Anyone who was a corpse when the round started and has since respawned,
		// plus anyone who joined during the countdown. Without this they play the
		// round from wherever TS dropped them, which on a deathmatch map can be
		// inside the other team.
		if (!g_placed[fid] && is_user_alive(fid))
		{
			if (g_match_team[fid] < 1)
			{
				// Mirrored into g_side, which elimination does not clear: see g_side. Every route
				// that puts somebody on a side has to set it, or they stop counting toward that
				// side the moment they are benched and the match forfeits itself.
				g_match_team[fid] = tsm_live_team_of(fid);
				if (g_match_team[fid]) { g_side[fid] = g_match_team[fid]; }
			}
			set_pev(fid, pev_health, float(get_pcvar_num(g_cv_health)));
			place_at_spawn(fid);
			dbgv("freeze tick: placed %d late (team %d)", fid, g_match_team[fid]);
		}
	}

	dbgv("freeze tick: %d left, %d player(s)", g_freeze_left, fnum);

	if (g_freeze_left > 0)
	{
		// Channel 2: the freeze countdown. Hold exceeds the 1.0s refresh so there is
		// no gap between redraws, which is half of what the blinking was.
		set_hudmessage(255, 180, 0, -1.0, 0.28, 0, 0.0, 1.5, 0.0, 0.0, 2);
		new ft1[32], ft2[32];
		team_short(1, ft1, charsmax(ft1));
		team_short(2, ft2, charsmax(ft2));
		show_hudmessage(0, "ROUND %d^nStarting in %d...^n^n%s %d  --  %d %s",
			g_round, g_freeze_left, ft1, g_score[1], g_score[2], ft2);

		g_freeze_left--;
	}
	else
	{
		// Same blank, for the case where the tick reaches zero before go-live does.
		set_hudmessage(0, 0, 0, -1.0, 0.28, 0, 0.0, 0.05, 0.0, 0.0, 2);
		show_hudmessage(0, " ");

		remove_task(3);
	}
}

/// Score and round shown on its own HUD channel so it cannot stomp the countdown.
/*
 * The round clock. Counts down from tsm_roundtime and is the only on-screen thing
 * during a live round, so it sits high enough to stay clear of the weapon HUD.
 */
/*
 * Tells anyone watching whose side they are on and who they are following.
 *
 * An eliminated player has no HUD of their own and no weapon, so without this there
 * is nothing on screen telling them which team they are still part of -- or that the
 * attack key moves between teammates.
 */
show_spectator_hud()
{
	new players[32], pnum, id;
	get_players(players, pnum, g_pf);

	for (new i = 0; i < pnum; i++)
	{
		id = players[i];

		new bool:watching = (g_elim[id] || g_locked_out[id] || is_spectating(id));
		if (!watching)
		{
			continue;
		}

		new side[48];
		if (g_match_team[id] == 1 || g_match_team[id] == 2)
		{
			team_display(g_match_team[id], side, charsmax(side));
		}
		else
		{
			copy(side, charsmax(side), "no side");
		}

		new target = g_spec_target[id];
		new watching_name[32];
		if (target && is_user_connected(target))
		{
			get_user_name(target, watching_name, charsmax(watching_name));
		}
		else
		{
			copy(watching_name, charsmax(watching_name), "nobody");
		}

		// Channel 3, which the live round does not otherwise use -- the round timer is
		// on 1 and transient banners on 4.
		set_hudmessage(200, 200, 200, -1.0, 0.72, 0, 0.0, 1.5, 0.0, 0.0, 3);
		show_hudmessage(id, "Your side: %s^nWatching: %s^nAttack to switch player",
			side, watching_name);
	}
}

show_round_timer()
{
	if (!get_pcvar_num(g_cv_showtimer) || g_round_left < 0)
	{
		return;
	}

	new t1[32], t2[32];
	team_short(1, t1, charsmax(t1));
	team_short(2, t2, charsmax(t2));

	// A mode with no clock: the round runs until it is decided, so nothing counts down and
	// the line carries the mode's own text ("WAVE 12") where the time would be.
	if (mode_flag(TSM_MODE_NO_CLOCK))
	{
		set_hudmessage(186, 116, 255, -1.0, 0.03, 0, 0.0, 1.5, 0.0, 0.0, 1);
		if (g_mode_hud[0])
		{
			show_hudmessage(0, "ROUND %d -- %s^n%s %d  --  %d %s",
				g_round, g_mode_hud, t1, g_score[1], g_score[2], t2);
		}
		else
		{
			show_hudmessage(0, "ROUND %d^n%s %d  --  %d %s",
				g_round, t1, g_score[1], g_score[2], t2);
		}
		return;
	}

	new mins = g_round_left / 60;
	new secs = g_round_left % 60;

	// Red for the last fifteen seconds, which is when it actually matters.
	if (g_round_left <= 15)
	{
		set_hudmessage(255, 60, 60, -1.0, 0.03, 0, 0.0, 1.5, 0.0, 0.0, 1);
	}
	else
	{
		// Purple-pink from the menu scheme (trackerscheme.res: 186 116 255),
		// matching the themed menus instead of the old cyan.
		set_hudmessage(186, 116, 255, -1.0, 0.03, 0, 0.0, 1.5, 0.0, 0.0, 1);
	}

	if (get_pcvar_num(g_cv_roundtime) > 0)
	{
		// A mode's own text rides after the time ("ZONES 2 - 1").
		if (g_mode_hud[0])
		{
			show_hudmessage(0, "ROUND %d -- %d:%02d -- %s^n%s %d  --  %d %s",
				g_round, mins, secs, g_mode_hud, t1, g_score[1], g_score[2], t2);
		}
		else
		{
			show_hudmessage(0, "ROUND %d -- %d:%02d^n%s %d  --  %d %s",
				g_round, mins, secs, t1, g_score[1], g_score[2], t2);
		}

		if (g_round_left <= 0)
		{
			// Resolved from the counter the player can actually see, rather than from
			// a separate task. The two could disagree, and when the task declined to
			// act the clock just sat at 0:00 looking hung.
			round_time_expired();
			return;
		}
		g_round_left--;

		/*
		 * THE LAST MINUTE. Every player is marked to the other side from here on.
		 *
		 * Latched rather than recomputed, so the announcement happens once and the markers do not
		 * blink off if the cvar is changed mid-round. start_round() clears it again.
		 */
		// Never in a mode that turned it off (TSM_MODE_NO_SUDDEN): the uplink and survival.
		new sd = get_pcvar_num(g_cv_sudden);
		if (sd > 0 && !g_sudden && g_round_left <= sd && !mode_flag(TSM_MODE_NO_SUDDEN))
		{
			g_sudden = true;
			tlog("[TSM] Sudden death on at %d seconds left, %d waiting for a wave.", g_round_left, count_waiting(1) + count_waiting(2));
			respawn_sudden_cut();
			set_hudmessage(255, 80, 60, -1.0, 0.36, 0, 0.0, 3.0, 0.2, 0.4, 4);
			show_hudmessage(0, "SUDDEN DEATH^nEveryone is marked");
			client_print(0, print_chat, "[MATCH] Sudden death -- every player is now marked to the other side.");
			dbg("sudden death on at %d seconds left", g_round_left);
			// Global sudden death sound
			emit_sound(0, CHAN_STATIC, "xom_laugh.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
			// And the bog comes with it: the same clock that flips the icons on turns
			// the engine's fog cvars on, for the whole map, on both sides.
			sudden_fog(true);
		}
	}
	else
	{
		show_hudmessage(0, "ROUND %d^n%s %d  --  %d %s",
			g_round, t1, g_score[1], g_score[2], t2);
	}
}

/*
 * The team objective banner, one second after a round starts.
 *
 * Two cvars, tsm_obj_msg_1 and tsm_obj_msg_2: side 1's message and side 2's.
 * EMPTY IS NOTHING -- a side with an empty string gets no banner at all, which
 * is why the defaults are empty, not sample text. Rows inside a value are
 * separated by a pipe character, because a quoted cfg value cannot carry a real
 * newline; each pipe folds to ^n, and the HUD stacks the rows beneath each
 * other.
 *
 * Sent per player, by the plugin's own side table, so a player of side 1 sees
 * the side 1 text in blue and a player of side 2 sees the side 2 text in red --
 * never both, never a colour that is not their own side's.
 */
public task_team_objmsg(taskid)
{
	new team = taskid - TSM_TASK_OBJMSG;

	new msg[384];
	get_pcvar_string(team == 1 ? g_cv_objmsg1 : g_cv_objmsg2, msg, charsmax(msg));
	if (!msg[0])
	{
		return;
	}

	for (new c = 0; c < sizeof msg && msg[c]; c++)
	{
		if (msg[c] == '|')
		{
			msg[c] = '^n';
		}
	}

	// Side 1 = MSR = blue, side 2 = Insurgency = red. Same two colours the
	// warmup HUD uses for the two sides, at positions the rest of the plugin
	// never touches (see TSM_OBJMSG_Y).
	if (team == 1)
	{
		set_hudmessage(0, 170, 255, -1.0, TSM_OBJMSG_Y, 0, 0.0, TSM_OBJMSG_HOLD, 0.1, 1.0, 3);
	}
	else
	{
		set_hudmessage(255, 70, 60, -1.0, TSM_OBJMSG_Y, 0, 0.0, TSM_OBJMSG_HOLD, 0.1, 1.0, 3);
	}

	for (new id = 1; id < MAXPL; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id) || g_match_team[id] != team)
		{
			continue;
		}
		show_hudmessage(id, "%s", msg);
	}
}

/*
 * THE ROUND-START ANTHEMS. One second into a round -- with the team banners
 * firing beside it -- every sided player with music on hears a random pick of
 * their OWN side's short stinger: side 1 (MSR) one of fortherepublic /
 * instructions / lordcommander, side 2 (Insurgency) one of slaythem / ripout
 * / eliminatetheimpure, all from ts\sound\start. Local, 2D, on the player's
 * own machine: playvol, a NORMAL sound channel, so the ambient queue's mp3
 * keeps playing underneath. The old mp3 route could never do that -- HL has
 * ONE mp3 stream, and that is the whole reason the files moved off it.
 */
public task_start_songs()
{
	if (get_pcvar_num(g_cv_startsound) == 0)
	{
		tlog("[TSM] task_start_songs: tsm_startsound=0, skipping");
		return;
	}

	// Same ceiling the ambient queue keeps, so the anthem sits in the mix
	// exactly where the old mp3 route placed it.
	new Float:vol = get_pcvar_float(g_cv_musicvol);
	if (vol < 0.0) vol = 0.0;
	if (vol > 1.0) vol = 1.0;

	new sent1 = 0, sent2 = 0, skipped = 0;
	for (new id = 1; id < MAXPL; id++)
	{
		if (!is_user_connected(id))
		{
			continue;
		}
		if (is_user_bot(id))
		{
			skipped++;
			continue;
		}
		if (g_match_team[id] != 1 && g_match_team[id] != 2)
		{
			skipped++;
			continue;
		}
		if (g_music_off[id])
		{
			skipped++;
			continue;
		}

		if (g_match_team[id] == 1)
		{
			new pick = random_num(0, sizeof g_start_t1 - 1);
			new snd[64];
			formatex(snd, charsmax(snd), "start/%s", g_start_t1[pick]);
			
			// playvol (client-side, needs download) + emit_sound (server-side fallback, no download)
			// CHAN_AUTO + ATTN_NONE on the player entity = local 2D playback for that client only
			client_cmd(id, "playvol %s %f", snd, vol);
			emit_sound(id, CHAN_AUTO, snd, vol, ATTN_NONE, 0, PITCH_NORM);
			
			tlog("[TSM] task_start_songs: id=%d team=MSR anthem=%s vol=%.2f (playvol+emit)", id, snd, vol);
			sent1++;
		}
		else
		{
			new pick = random_num(0, sizeof g_start_t2 - 1);
			new snd[64];
			formatex(snd, charsmax(snd), "start/%s", g_start_t2[pick]);
			
			client_cmd(id, "playvol %s %f", snd, vol);
			emit_sound(id, CHAN_AUTO, snd, vol, ATTN_NONE, 0, PITCH_NORM);
			
			tlog("[TSM] task_start_songs: id=%d team=INS anthem=%s vol=%.2f (playvol+emit)", id, snd, vol);
			sent2++;
		}
	}
	tlog("[TSM] task_start_songs: sent MSR=%d INS=%d skipped=%d vol=%.2f", sent1, sent2, skipped, vol);
}

/*
 * THE INSURGENT ROAR. Four seconds after the Insurgents' anthem rang, the
 * monster's cry goes out to every Insurgents player ON THEIR OWN MACHINE --
 * playvol at full volume, the exact way the welcome jingle reaches a joiner
 * (spk only speaks sentences; emit_sound would put it in the world for
 * anyone standing near them). ONLY side 2 hears it: attackers of side 1,
 * bystanders and bots never do, and it is a match CUE rather than music, so
 * the ambient music switch does not silence it -- tsm_startsound 0 does,
 * being part of the same round-start package.
 */
public task_team_roar()
{
	if (get_pcvar_num(g_cv_startsound) == 0 || !g_roar_ok)
	{
		tlog("[TSM] task_team_roar: startsound=%d roar_ok=%d, skipping", get_pcvar_num(g_cv_startsound), g_roar_ok);
		return;
	}
	if (g_state == ST_WARMUP || g_state == ST_READYUP
		|| g_state == ST_ROUNDEND || g_state == ST_MATCHEND)
	{
		tlog("[TSM] task_team_roar: state=%d not live, skipping", g_state);
		return;
	}

	new sent = 0, skipped = 0;
	for (new id = 1; id < MAXPL; id++)
	{
		if (!is_user_connected(id))
		{
			continue;
		}
		if (is_user_bot(id))
		{
			skipped++;
			continue;
		}
		if (g_match_team[id] != 2)
		{
			skipped++;
			continue;
		}
		// playvol (client-side) + emit_sound (server-side fallback, no download needed)
		// CHAN_AUTO + ATTN_NONE on the player entity = local 2D playback for that client only
		client_cmd(id, "playvol %s 1.0", TSM_ROAR_WAV);
		emit_sound(id, CHAN_AUTO, TSM_ROAR_WAV, 1.0, ATTN_NONE, 0, PITCH_NORM);
		tlog("[TSM] task_team_roar: id=%d INS roar", id);
		sent++;
	}
	tlog("[TSM] task_team_roar: sent=%d skipped=%d", sent, skipped);
}

/*
 * THE MSR BADUM. Mirrors the Insurgent roar: four seconds after the MSR's
 * anthem, the drum cue goes out locally -- playvol, full volume -- to every
 * MSR player only. Side 2 and bystanders never hear it; bots never do either.
 * It is a match cue, not music, so the ambient music switch does not silence it
 * -- tsm_startsound 0 does, with the anthems.
 */
public task_team_badum()
{
	if (get_pcvar_num(g_cv_startsound) == 0 || !g_badum_ok)
	{
		tlog("[TSM] task_team_badum: startsound=%d badum_ok=%d, skipping", get_pcvar_num(g_cv_startsound), g_badum_ok);
		return;
	}
	if (g_state == ST_WARMUP || g_state == ST_READYUP
		|| g_state == ST_ROUNDEND || g_state == ST_MATCHEND)
	{
		tlog("[TSM] task_team_badum: state=%d not live, skipping", g_state);
		return;
	}

	new sent = 0, skipped = 0;
	for (new id = 1; id < MAXPL; id++)
	{
		if (!is_user_connected(id))
		{
			continue;
		}
		if (is_user_bot(id))
		{
			skipped++;
			continue;
		}
		if (g_match_team[id] != 1)
		{
			skipped++;
			continue;
		}
		// playvol (client-side) + emit_sound (server-side fallback, no download needed)
		// CHAN_AUTO + ATTN_NONE on the player entity = local 2D playback for that client only
		client_cmd(id, "playvol %s 1.0", TSM_BADUM_WAV);
		emit_sound(id, CHAN_AUTO, TSM_BADUM_WAV, 1.0, ATTN_NONE, 0, PITCH_NORM);
		tlog("[TSM] task_team_badum: id=%d MSR badum", id);
		sent++;
	}
	tlog("[TSM] task_team_badum: sent=%d skipped=%d", sent, skipped);
}

show_score_hud()
{
	set_hudmessage(0, 220, 120, -1.0, 0.18, 0, 0.0, 4.0, 0.2, 0.3, 3);
	show_hudmessage(0, "Round %d  --  %d : %d  (first to %d).",
		g_round, g_score[1], g_score[2], (get_pcvar_num(g_cv_rounds) / 2) + 1);
}

/// Every non-spectator player on a live team has finished arming this round.
stock bool:gate_all_armed()
{
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		new id = players[i];
		if (!is_user_connected(id))
		{
			continue;
		}
		if (tsm_live_team_of(id) != 1 && tsm_live_team_of(id) != 2)
		{
			continue;   // spectator or unassigned -- not gated
		}
		if (g_player_class[id] == 0)
		{
			continue;   // never picked a class -- goes live with default class,
			            // exactly as before the gate existed
		}
		if (!g_armed[id])
		{
			return false;
		}
	}
	return true;
}

public task_go_live()
{
	/*
	 * The freeze this belongs to has to still be running.
	 *
	 * The task carries no id -- id 0 is the one-second tick, which must not be removed
	 * -- so it cannot be cancelled, only refused. Anything that leaves ST_FREEZE early,
	 * a halt over an imbalance or an admin cancelling, needs the round not to go live
	 * behind it.
	 */
	if (g_state != ST_FREEZE)
	{
		return;
	}

	// ARM-GATE: hold LIVE until everyone on a live team is armed, or the safety
	// deadline passes -- so a full server never releases into half-equipped players.
	if (!gate_all_armed())
	{
		if (g_gate_deadline == 0.0)
		{
			g_gate_deadline = get_gametime() + ARM_GATE_MAX_EXTRA;
			dbg("arm gate: waiting for loadouts, deadline in %.1fs", ARM_GATE_MAX_EXTRA);
		}
		else if (get_gametime() < g_gate_deadline)
		{
			set_task(ARM_GATE_CHECK, "task_go_live");
			return;
		}
		// else: deadline passed -- fall through and go live anyway rather than stall forever
	}
	g_gate_deadline = 0.0;

	/*
	 * FORCE-ARM THE FALL-THROUGH.
	 *
	 * The gate above holds LIVE for the loadouts, but it also gives up when
	 * ARM_GATE_MAX_EXTRA runs out -- and going live with an empty player is worse
	 * than a late give. Anyone on a live team still unarmed right now gets their
	 * kit in place; the freeze hold has them where the round wants them, so no
	 * strip and no respawn. A player who never picked gets the default class
	 * settled here the same way the wash did it, so the fall-through cannot send
	 * an empty body to LIVE either.
	 */
	new fp[32], fnum;
	get_players(fp, fnum, g_pf);
	for (new i = 0; i < fnum; i++)
	{
		new id = fp[i];

		// THE FALL-THROUGH'S OWN DEFAULT PICK: identical to the wash's, for whatever
		// slipped past it whole. Without this an unpicked straggler keeps the empty
		// armament the wash wrote and goes live holding nothing.
		if (g_player_class[id] == 0)
		{
			g_player_class[id] = resolved_class(id);
			client_print(id, print_chat, "[MATCH] No class picked -- you are %s for this match.",
				g_class_name[g_player_class[id] - 1]);
		}

		if (g_armed[id] || !is_user_alive(id))
		{
			continue;
		}
		if (tsm_live_team_of(id) != 1 && tsm_live_team_of(id) != 2)
		{
			continue;
		}

		arm_give_kit(id);
		g_armed[id] = true;
		tlog("[TSM] go-live force-arm: %d was still unarmed.", id);
	}

	remove_task(3);
	g_state = ST_LIVE;

	// Hand control back. Logged, because "are players actually being released"
	// has been guesswork twice and the log can simply answer it.
	new rp[32], rnum;
	get_players(rp, rnum, g_pf);
	for (new i = 0; i < rnum; i++)
	{
		// The pick window has closed: a class menu still up would only take keys that do nothing.
		drop_class_menu(rp[i]);

		/*
		 * NOTHING IS STRIPPED OR GIVEN HERE.
		 *
		 * The arm operation is the second one and it lands during the freeze, tsm_arm_delay
		 * after the wash -- and never twice in a round: only a class that is picked and
		 * applied gets scheduled, and a pick made this round re-arms on the spot through
		 * task_reissue_armament. The class pass below repeats resolved_class so a late
		 * pick made during the six seconds does not lose its look.
		 */
		apply_class(rp[i]);

		/*
		 * Belt and braces: sudden-death damage cannot carry into a new round.
		 * apply_class() restores class HP, but this is unconditional so a player
		 * drained to 1 HP in the last round starts fresh here no matter what.
		 */
		if (is_user_connected(rp[i]) && is_user_alive(rp[i]))
		{
			new ci = resolved_class(rp[i]) - 1;
			if (ci >= 0)
			{
				set_user_health(rp[i], g_class_hp[ci]);

				// The anti-heal watch is synced AT this write, exactly as at the
				// arm and apply_class writes: a raise with a stale watch is what
				// the rule itself would refuse (see fw_prethink).
				if (g_class_perk[ci] == TSM_PERK_MECH)
				{
					g_mech_hp_watch[rp[i]] = g_class_hp[ci];
				}
			}
		}

		/*
		 * Scale, AGAIN, right here. apply_class_scale also runs at arm time, which is
		 * during the freeze where class_scale_for() answers 1.0 -- so the one pass that
		 * ever mattered wrote the reset to normal, and the Heavy went live at ordinary
		 * height. g_state is ST_LIVE by now, so this pass answers 1.50 for the Heavy
		 * and 0.0 for everyone else.
		 */
		apply_class_scale(rp[i]);

		officer_powerup(rp[i]);

		// After the class health above, so a mode's own health (survival's waves) is the last word.
		mode_notify(g_fw_armed, rp[i]);

		release_player(rp[i]);

		// Fresh round: reset the bot dry-weapon counters so a bot that ran dry last
		// round does not start this one mid-switch.
		if (is_user_bot(rp[i]))
		{
			g_bot_dry_count[rp[i]] = 0;
			g_bot_dry_switches[rp[i]] = 0;
			g_bot_dry_weapon[rp[i]] = 0;
		}

		// Apply class height at go-live, not just at arm time: the freeze writes
		// class_scale_for() == 1.0, so the per-frame hooks are what keep the Heavy
		// tall once the round is live.
		apply_class_scale(rp[i]);
	}
	start_wave_clocks();
	tlog("[TSM] Round %d LIVE: released %d player(s).", g_round, rnum);
	dbg("round %d live: released %d, alive t1=%d t2=%d, placed-check follows",
		g_round, rnum, count_alive(1), count_alive(2));
	all_print("[MATCH] LIVE -- round %d.", g_round);

	/*
	 * Models, once, a moment after the spawn.
	 *
	 * Every other model write happens during the freeze, and TS re-applies its own
	 * mp_teammodels pick when it spawns the player -- so those writes were correct and
	 * then discarded. This one lands after that, which is the only place it can stick.
	 */
	remove_task(13);
	set_task(0.5, "task_models_after_spawn", 13);

	// Snapshot the starting strength of each side. check_round_end() needs it to tell
	// "this team has been wiped out" apart from "this team never had anybody", which
	// are completely different situations that look identical from an alive count.
	g_start_alive[1] = count_alive(1);
	g_start_alive[2] = count_alive(2);

	/*
	 * Wipe the countdown off channel 2 first.
	 *
	 * Its last draw holds for 1.5 seconds -- deliberately longer than the one-second
	 * refresh, so the countdown does not flicker -- which means the yellow "Starting
	 * in 1" is still on screen when the round actually begins. Blanking the channel
	 * lets LIVE stand on its own.
	 */
	set_hudmessage(0, 0, 0, -1.0, 0.28, 0, 0.0, 0.05, 0.0, 0.0, 2);
	show_hudmessage(0, " ");

	set_hudmessage(0, 255, 0, -1.0, 0.32, 0, 0.0, 1.5, 0.0, 0.3, 4);
	show_hudmessage(0, "LIVE");

	// A fresh round is not sudden death, whatever the last one ended as.
	g_sudden = false;

	if (!g_start_alive[1] || !g_start_alive[2])
	{
		if (!g_warned_empty)
		{
			g_warned_empty = true;
			if (get_pcvar_num(g_cv_solo))
			{
				all_print("[MATCH] Solo test mode -- rounds will not end by themselves. Use amx_tsm_simwin <1|2>.");
			}
			else
			{
				all_print("[MATCH] Only one side has players -- rounds will not resolve until both teams are occupied.");
			}
			tlog("[TSM] Round %d went live with team1=%d team2=%d alive. Round-end checks are suspended.", g_round, g_start_alive[1], g_start_alive[2]);
		}
	}
	else
	{
		g_warned_empty = false;
	}

	// One second in, every player's movement state goes to the debug log. If anyone
	// is still held, this says exactly which mechanism is holding them.
	set_task(1.0, "task_live_audit", 5);

	g_round_left = get_pcvar_num(g_cv_roundtime);

	// A mode with no clock (TSM_MODE_NO_CLOCK) runs the round until it is decided, so no
	// timeout is armed and the round line shows the mode's own text instead of a time.
	new rt = mode_flag(TSM_MODE_NO_CLOCK) ? 0 : get_pcvar_num(g_cv_roundtime);
	if (rt > 0)
	{
		g_round_ends = get_gametime() + float(rt);
		set_task(float(rt), "task_round_timeout", 2);
	}

	mode_notify(g_fw_round_live, g_round);
}

public task_round_timeout()
{
	round_time_expired();
}

/*
 * The round ran out of time, so it is decided on who is left standing.
 *
 * Unlike check_round_end() this does NOT refuse to act when a side started empty. That
 * guard exists to stop an elimination check declaring a winner the instant a round
 * begins, and looping forever. A timeout cannot loop -- it happens once, at a fixed
 * time -- so refusing here just left the clock sitting at 0:00 with nothing happening.
 */
round_time_expired()
{
	if (g_state != ST_LIVE)
	{
		return;
	}

	remove_task(2);

	// A claimed mode decides its own time-up: the uplink by who holds the most zones. It
	// answers PLUGIN_HANDLED and ends the round through tsm_end_round; anything else falls
	// through to the rules below.
	if (g_fw_timeout != -1 && g_mode_name[0])
	{
		new ret = PLUGIN_CONTINUE;
		ExecuteForward(g_fw_timeout, ret);
		if (g_state != ST_LIVE)
		{
			return;
		}
		// Answered but left the round running: a round with no timeout armed would hang, so
		// the usual rules below decide it after all.
		if (ret == PLUGIN_HANDLED)
		{
			tlog("[TSM] Mode '%s' took the time-up but left the round live -- the usual rules decide it.", g_mode_name);
		}
	}

	// Siege: the attacker (tsm_obj_team) must finish the objective to win. Time running
	// out with it still standing is a defensive win, headcount notwithstanding -- only a
	// map with no siege objectives at all (siege_count() == 0) falls through to the
	// ordinary tiebreak below. Reaching this function at all means the last objective
	// has not already fallen -- that path ends the round immediately, elsewhere.
	if (siege_count() > 0)
	{
		new defender = (get_pcvar_num(g_cv_objteam) == 1) ? 2 : 1;
		all_print("[MATCH] Time up -- the objective still stands. Defensive win.");
		end_round(defender);
		return;
	}

	new a1 = count_alive(1);
	new a2 = count_alive(2);

	all_print("[MATCH] Time up -- %d alive versus %d.", a1, a2);

	if (a1 == a2)
	{
		end_round(0);
	}
	else
	{
		end_round(a1 > a2 ? 1 : 2);
	}
}

/* ---- ready-up ------------------------------------------------------------ */

reset_ready()
{
	for (new i = 1; i < MAXPL; i++)
	{
		g_ready[i] = false;
	}
}

public hook_say(id)
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		return PLUGIN_CONTINUE;
	}

	new args[64];
	read_args(args, charsmax(args));
	remove_quotes(args);

	if (equali(args, ".ready"))
	{
		if (g_state != ST_WARMUP && g_state != ST_READYUP)
		{
			client_print(id, print_chat, "[MATCH] A match is already in progress.");
			return PLUGIN_HANDLED;
		}

		/*
		 * Readying up before being spawned in left the match waiting on a player the
		 * round could never start with: the ready flag was set, but there was no live
		 * body to freeze, place or count.
		 */
		if (!tsm_live_team_of(id))
		{
			client_print(id, print_chat, "[MATCH] Pick a side first -- type .team.");
			return PLUGIN_HANDLED;
		}
		if (!is_user_alive(id))
		{
			client_print(id, print_chat, "[MATCH] You are not in the game yet. Spawn in, then type .ready.");
			return PLUGIN_HANDLED;
		}
		g_ready[id] = true;
		g_state = ST_READYUP;
		new name[32];
		get_user_name(id, name, charsmax(name));
		all_print("[MATCH] %s is ready.", name);
		check_all_ready();
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".unready"))
	{
		g_ready[id] = false;
		new name[32];
		get_user_name(id, name, charsmax(name));
		all_print("[MATCH] %s is NOT ready.", name);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".status"))
	{
		print_status(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".stim"))
	{
		cmd_stim(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".mechtest"))
	{
		// Chat alias for tsm_mechtest -- the sound bench prints its detection facts
		// before playing, so a Mech that hears nothing can separate "not detected"
		// from "not audible" in one round of testing.
		cmd_mechtest(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".forfeit"))
	{
		cmd_forfeit(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".roam"))
	{
		cmd_roam(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".follow") || equali(args, ".squad"))
	{
		cmd_squad_follow(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".unfollow") || equali(args, ".dismiss"))
	{
		cmd_squad_dismiss(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".unstick"))
	{
		cmd_player_unstick(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".rocket"))
	{
		cmd_mech_rocket(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".turret"))
	{
		cmd_turret(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".pickup"))
	{
		cmd_pickup(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".cloak"))
	{
		cmd_cloak(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".uncloak"))
	{
		cmd_uncloak(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".light"))
	{
		cmd_light(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".ammo"))
	{
		cmd_ammo(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".scan"))
	{
		cmd_scan(id);
		return PLUGIN_HANDLED;
	}

	if (equali(args, ".reinforce"))
	{
		cmd_reinforce(id);
		return PLUGIN_HANDLED;
	}

	return PLUGIN_CONTINUE;
}

/**
 * tsm_match_info(out[4]) -- state, round, team 1 score, team 2 score.
 *
 * The only native this plugin provides. Read-only and without side effects, so there is
 * nothing a caller can do with it except report. ts_advertise reads it for its Discord
 * embed and reaches it through a native filter, so neither plugin needs the other to be
 * loaded.
 */
public native_match_info(plugin, params)
{
	new out[4];
	out[0] = g_state;
	out[1] = g_round;
	out[2] = g_score[1];
	out[3] = g_score[2];
	set_array(1, out, 4);
	return 1;
}

/* ---- the mode API (include\tsm_api.inc) ---------------------------------- */

/*
 * tsm_mode_claim(name[], desc[], flags): this map becomes the mode's.
 *
 * One claim a map, made by a mode plugin a moment after the map loads, and none on a map with
 * siege objectives: siege_count() is read as the claim is made, so a map carrying tsm_obj_#
 * and tsm_cap_# both stays a siege map, and the conflict is logged rather than half-played.
 */
public native_mode_claim(plugin, params)
{
	new name[16], desc[64];
	get_string(1, name, charsmax(name));
	get_string(2, desc, charsmax(desc));
	new flags = get_param(3);

	if (!name[0])
	{
		return 0;
	}
	if (g_mode_name[0])
	{
		tlog("[TSM] Mode '%s' wanted %s, but '%s' already has it.", name, g_mapname, g_mode_name);
		return 0;
	}
	if (siege_count() > 0)
	{
		tlog("[TSM] Mode '%s' refused: %s has siege objectives (tsm_obj_#), so it stays a siege map.", name, g_mapname);
		return 0;
	}

	copy(g_mode_name, charsmax(g_mode_name), name);
	copy(g_mode_desc, charsmax(g_mode_desc), desc);
	g_mode_flags = flags;
	g_mode_hud[0] = 0;
	refresh_gamedesc();

	// rcbot evens its own bots across the two sides, which would keep pulling them back off
	// side 2. The bots-on push in the tick reads the claim too, so it cannot undo this.
	if (mode_flag(TSM_MODE_SIDE2_BOTS))
	{
		server_cmd("rcbot config balance_teams 0");
	}

	tlog("[TSM] %s is a %s map (flags %d).", g_mapname, g_mode_name, g_mode_flags);
	dbg("mode claimed: %s, browser '%s', flags %d", g_mode_name, g_mode_desc, g_mode_flags);
	return 1;
}

/// tsm_end_round(winner): ends the live round now, 1 or 2 winning it and anything else drawing it.
public native_end_round(plugin, params)
{
	if (g_state != ST_LIVE)
	{
		return 0;
	}
	new winner = get_param(1);
	end_round((winner == 1 || winner == 2) ? winner : 0);
	return 1;
}

/// tsm_reward_lives(side): lives back for side 1, side 2 or both (0). See reward_lives().
public native_reward_lives(plugin, params)
{
	return reward_lives(get_param(1));
}

/*
 * tsm_wave_seconds(side, Float:seconds): a side's wave interval while the mode runs.
 * 0 is tsm_respawn_wave again; below 0 the side has no timed waves at all, and its dead wait
 * for the mode's own tsm_fire_wave -- how a survival wave waits for the last mutant to fall.
 */
public native_wave_seconds(plugin, params)
{
	new side = get_param(1);
	if (side != 1 && side != 2)
	{
		return 0;
	}
	new Float:secs = get_param_f(2);
	g_wave_secs[side] = (secs < 0.0) ? -1.0 : secs;

	// A shorter interval reaches a clock already running, so the change shows at once rather than one
	// long wave later.
	if (g_state == ST_LIVE && secs > 0.0 && g_wave_left[side] > secs)
	{
		g_wave_left[side] = secs;
	}
	return 1;
}

/// tsm_fire_wave(side): everyone waiting on that side back now, as a forced wave does.
public native_fire_wave(plugin, params)
{
	new side = get_param(1);
	if (side != 1 && side != 2)
	{
		return 0;
	}
	return fire_wave(side, true);
}

/// tsm_hud_line(text[]): the mode's own text on the round line. Empty clears it.
public native_hud_line(plugin, params)
{
	get_string(1, g_mode_hud, charsmax(g_mode_hud));
	return 1;
}

/// tsm_state(): the match state, ST_* (the include's TSM_ST_*).
public native_state(plugin, params)
{
	return g_state;
}

/// tsm_side_of(id): 1 or 2 for a player on a side this match, eliminated or not; 0 otherwise.
public native_side_of(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id >= MAXPL)
	{
		return 0;
	}
	if (g_match_team[id] == 1 || g_match_team[id] == 2)
	{
		return g_match_team[id];
	}
	return (g_side[id] == 1 || g_side[id] == 2) ? g_side[id] : 0;
}

/// tsm_in_play(id): alive, on a side, not eliminated and not sitting the match out.
public native_in_play(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id >= MAXPL || !is_user_connected(id) || !is_user_alive(id))
	{
		return 0;
	}
	if (g_elim[id] || g_locked_out[id] || is_spectating(id))
	{
		return 0;
	}
	return (g_match_team[id] == 1 || g_match_team[id] == 2) ? 1 : 0;
}

/// tsm_side_alive(side): what the round counts as still in it -- alive, or waiting for a wave.
public native_side_alive(plugin, params)
{
	new side = get_param(1);
	return (side == 1 || side == 2) ? count_alive(side) : 0;
}

/// tsm_give_powerup(id, type): a TSPWUP_* through TS's own pickup (tsm_grant_powerup).
public native_give_powerup(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id >= MAXPL)
	{
		return 0;
	}
	return tsm_grant_powerup(id, get_param(2)) ? 1 : 0;
}

/// tsm_match_desc(out[], len): the browser's game description as it reads right now.
public native_match_desc(plugin, params)
{
	set_string(1, g_gamedesc, get_param(2));
	return 1;
}

/// tsm_set_class(id, cls): the class a player plays, 1 and up in tsm_classN order.
public native_set_class(plugin, params)
{
	new id = get_param(1);
	new cls = get_param(2);
	if (id < 1 || id >= MAXPL || cls < 1 || cls > g_class_count)
	{
		return 0;
	}
	g_player_class[id] = cls;
	return 1;
}

/// tsm_refresh_abilities(side): every once-a-round ability ready again for side 1 or 2 (0 both), as a new
/// round would leave them (refresh_abilities). Answers how many players.
public native_refresh_abilities(plugin, params)
{
	new side = get_param(1);
	new n = 0;
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		new team = g_match_team[id] ? g_match_team[id] : g_side[id];
		if ((team != 1 && team != 2) || (side && team != side))
		{
			continue;
		}
		refresh_abilities(id);
		n++;
	}
	return n;
}

/// tsm_class_count(): how many classes ts_matchmode.cfg defines.
public native_class_count(plugin, params)
{
	return g_class_count;
}

/// tsm_class_of_perk(perk): the first class (1-based) carrying that perk (TSM_PERK_*), 0 for none.
public native_class_of_perk(plugin, params)
{
	new perk = get_param(1);
	for (new i = 0; i < g_class_count; i++)
	{
		if (g_class_perk[i] == perk)
		{
			return i + 1;
		}
	}
	return 0;
}

/*
 * tsm_class_rule(cls, limit, lives): while the claimed mode runs, class `cls` (1-based) may be taken by
 * `limit` players a side (0 no limit, -1 not played at all) and carries `lives` (0 keeps tsm_class_lives).
 * The first rule a map gets starts every class from the config's own limits. Anyone holding a class left
 * out gives it up (reseat_classes).
 */
public native_class_rule(plugin, params)
{
	new cls = get_param(1);
	if (cls < 1 || cls > g_class_count)
	{
		return 0;
	}
	if (!g_mode_classes)
	{
		for (new i = 0; i < TSM_MAXCLASS; i++)
		{
			g_mode_class_limit[i] = g_class_limit[i];
			g_mode_class_lives[i] = 0;
		}
		g_mode_classes = true;
	}
	new limit = get_param(2);
	new lives = get_param(3);
	g_mode_class_limit[cls - 1] = (limit < 0) ? -1 : limit;
	g_mode_class_lives[cls - 1] = (lives > 0) ? lives : 0;
	reseat_classes();
	return 1;
}

/// tsm_mode_bot_class(cls): the class every bot plays while the mode runs; 0 hands it back to tsm_bot_class.
public native_mode_bot_class(plugin, params)
{
	new cls = get_param(1);
	g_mode_bot_class = (cls >= 1 && cls <= g_class_count) ? cls : 0;
	reseat_classes();
	return 1;
}

/// Classes put right after a mode's rules change: every bot takes the mode's bot class when it has one,
/// and anyone else holding a class the mode leaves out gives it up -- a person picks again at the next freeze.
reseat_classes()
{
	new players[32], pnum, id;
	get_players(players, pnum, g_pfall);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		if (is_user_bot(id) && g_mode_bot_class)
		{
			g_player_class[id] = g_mode_bot_class;
		}
		else if (g_player_class[id] && !class_offered(g_player_class[id]))
		{
			g_player_class[id] = is_user_bot(id) ? default_class() : 0;
		}
	}
}

/// tsm_set_progress(text[]): the mode's progress, published as tsm_pres_prog once a second.
public native_set_progress(plugin, params)
{
	get_string(1, g_mode_prog, charsmax(g_mode_prog));
	return 1;
}

/// tsm_class_hp(id): the health the player's class sets.
public native_class_hp(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id >= MAXPL || !g_class_count)
	{
		return 0;
	}
	new ci = resolved_class(id) - 1;
	return (ci >= 0 && ci < g_class_count) ? g_class_hp[ci] : 0;
}

print_status(id)
{
	client_print(id, print_chat, "[MATCH] State %d, round %d, score %d - %d",
		g_state, g_round, g_score[1], g_score[2]);

	new players[32], pnum, p, name[32];
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		p = players[i];
		get_user_name(p, name, charsmax(name));
		client_print(id, print_chat, "[MATCH]   %s  team %d  %s",
			name, tsm_live_team_of(p), g_ready[p] ? "READY" : "not ready");
	}
}

check_all_ready()
{
	new players[32], pnum, id;
	new n1 = 0, n2 = 0, r1 = 0, r2 = 0;
	get_players(players, pnum, g_pf);

	for (new i = 0; i < pnum; i++)
	{
		id = players[i];
		new t = tsm_live_team_of(id);
		// A bot cannot type .ready, so it is counted as ready or a side holding one
		// could never satisfy the gate.
		new bool:rdy = (g_ready[id] || (bot_player(id) && get_pcvar_num(g_cv_botready) != 0));

		if (t == 1)
		{
			n1++;
			if (rdy) { r1++; }
		}
		else if (t == 2)
		{
			n2++;
			if (rdy) { r2++; }
		}
	}

	new need = get_pcvar_num(g_cv_minteam);
	new bool:solo = (get_pcvar_num(g_cv_solo) != 0);

	// Solo testing: one occupied team is enough. Round-end checking already refuses
	// to resolve a round for a side that started it with nobody, so the match simply
	// will not end on its own -- use amx_tsm_simwin to walk the score.
	if (solo)
	{
		if ((n1 + n2) < 1 || (r1 + r2) < (n1 + n2))
		{
			return;
		}
	}
	else
	{
		if (n1 < need || n2 < need)
		{
			return;
		}
		// Side 2 bots only by design (survival) never readies: the people on side 1 decide.
		if (r1 < n1 || (r2 < n2 && !mode_flag(TSM_MODE_SIDE2_BOTS)))
		{
			return;
		}
		if (!balance_ok())
		{
			return;
		}
	}

	/*
	 * A halted match resumes; it does not start again.
	 *
	 * begin_match() is the start of a NEW match and zeroes g_round and g_score, which is
	 * the one thing a halt exists to protect. The gate above is shared on purpose -- it
	 * is the only combined balance-and-ready test in the plugin, so a halt cannot resume
	 * on terms a match would not have started on -- and only what it leads to differs.
	 */
	if (g_halted)
	{
		resume_match();
		return;
	}

	begin_match();
}

begin_match()
{
	cache_teams();

	/*
	 * Economy ON, wallet empty.
	 *
	 * usecash 0 does NOT stop buying -- it makes CashBased() false, so nothing is ever
	 * charged and TS's equipment menu, which is slot-limited rather than cash-limited,
	 * hands weapons out for free. The economy has to be ON for a purchase to be
	 * refusable, and the wallet has to be empty for it to be refused every time. TS
	 * does the refusing itself, with its own message.
	 *
	 * The class loadout runs down that same BuyArmament path, so it would be refused
	 * too -- hold_cash() lends the money from the moment the armament is written until
	 * the respawn that applies it has finished, keyed on g_cash_lend. Any other
	 * spawn, including the ones TS performs itself, finds the wallet empty.
	 */
	if (get_pcvar_num(g_cv_nocash))
	{
		kill_ts_cash_cvars();
		dbg("economy on with an empty wallet: usecash 1, every cash source zeroed");
	}

	// Classes are per match, so selections clear here and nowhere else.
	for (new i = 1; i < MAXPL; i++)
	{
		g_player_class[i] = 0;
		g_class_menu_at[i] = 0.0;
	}

	// Bots come back in for this match, assigned fresh so the sides are balanced from
	// the start rather than inherited from the last one -- over the next few seconds,
	// one at a time, rather than the whole fleet inside a single tick.
	g_bots_parked = false;

	stagger_assign_bots();

	g_round = 0;
	siege_reset();
	g_score[1] = 0;
	g_score[2] = 0;
	all_print("[MATCH] All ready -- best of %d. Good luck.", get_pcvar_num(g_cv_rounds));
	start_round();
}

/* ---- admin -------------------------------------------------------------- */

public cmd_start(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }

	new n1 = 0, n2 = 0, t;
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		t = tsm_live_team_of(players[i]);
		if (t == 1) { n1++; }
		else if (t == 2) { n2++; }
	}
	if (!n1 || !n2)
	{
		console_print(id, "[TSM] Forcing live with team1=%d team2=%d players.", n1, n2);
		console_print(id, "[TSM] Rounds will NOT resolve while a side is empty -- that is deliberate, not a hang.");
	}

	g_warned_empty = false;
	begin_match();
	return PLUGIN_HANDLED;
}

public cmd_cancel(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }
	new bool:was_on = (g_state != ST_WARMUP);
	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);
	g_state = ST_WARMUP;
	g_round = 0;
	siege_reset();
	g_score[1] = 0;
	g_score[2] = 0;
	g_freeze_left = 0;
	g_round_left = 0;
	reset_ready();

	// Restore first, then wipe match state -- restore_all() reads g_elim to decide
	// what to put back.
	restore_all();
	clear_match_state();

	all_print("[MATCH] Match cancelled -- back to warmup. Pick a side and type .ready.");

	// Sides are picked again, exactly as after a match that ran to its end.
	if (was_on)
	{
		bench_everyone();
	}
	dbg("match cancelled by admin: round counter and all per-match state cleared");
	return PLUGIN_HANDLED;
}

public cmd_restart(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }
	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);
	restore_all();
	clear_match_state();
	begin_match();
	return PLUGIN_HANDLED;
}

public cmd_score(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }
	client_print(id, print_console, "[MATCH] Round %d, score %d - %d, state %d",
		g_round, g_score[1], g_score[2], g_state);
	return PLUGIN_HANDLED;
}

/*
 * Overrides a halt and plays the match out with the sides as they are.
 *
 * Separate from amx_match_start, which calls begin_match() and would zero the score
 * this exists to keep.
 */
public cmd_continue(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }

	if (!g_halted)
	{
		console_print(id, "[TSM] Nothing is halted (state %d, round %d, score %d-%d).",
			g_state, g_round, g_score[1], g_score[2]);
		console_print(id, "[TSM] tsm_halt_bypass 1 stops it halting at all; tsm_halt_on_leave 0 removes the feature.");
		return PLUGIN_HANDLED;
	}

	/*
	 * Waived for the REST OF THIS MATCH, not just for this instant.
	 *
	 * An admin overriding a halt is saying the match is to be played out as it stands.
	 * Letting the override lapse here would hand the very next departure the power to
	 * stop the match they just restarted, which is the override meaning nothing.
	 * clear_match_state() clears it, so it cannot reach the next match.
	 */
	g_halt_waived = true;

	all_print("[MATCH] An admin is playing this match out as it stands -- the sides stay as they are.");
	tlog("[TSM] Halt bypassed by admin at round %d, score %d-%d; no further halts this match.",
		g_round, g_score[1], g_score[2]);
	resume_match();
	return PLUGIN_HANDLED;
}

public cmd_fix(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2)) { return PLUGIN_HANDLED; }
	new arg[32];
	read_argv(1, arg, charsmax(arg));
	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[MATCH] No such player.");
		return PLUGIN_HANDLED;
	}
	g_elim[target] = false;
	restore_presentation(target);
	console_print(id, "[MATCH] Restored.");
	return PLUGIN_HANDLED;
}

/*
 * Toggles the cloak on anyone, bots included, without the Recon rule -- because the cloaker can
 * never judge it himself: his client redraws its own player at its own opacity, whatever the
 * server sends. Still a live round only, since anywhere else the next frame ends it again.
 */
public cmd_cloak_admin(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2)) { return PLUGIN_HANDLED; }
	new arg[32];
	read_argv(1, arg, charsmax(arg));
	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[TSM] No such player.");
		return PLUGIN_HANDLED;
	}
	if (!g_cloaked[target] && (g_state != ST_LIVE || !is_user_alive(target) || is_spectating(target)
		|| g_elim[target] || g_locked_out[target]))
	{
		console_print(id, "[TSM] Only someone alive and playing in a live round can be cloaked.");
		return PLUGIN_HANDLED;
	}

	set_cloak(target, !g_cloaked[target]);

	new tname[32];
	get_user_name(target, tname, charsmax(tname));
	console_print(id, "[TSM] %s is now %s.", tname, g_cloaked[target] ? "cloaked" : "uncloaked");
	return PLUGIN_HANDLED;
}

public cmd_debug(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }

	new t1[32], t2[32], mode[16];
	get_pcvar_string(g_cv_team1name, t1, charsmax(t1));
	get_pcvar_string(g_cv_team2name, t2, charsmax(t2));
	get_pcvar_string(g_cv_teammode, mode, charsmax(mode));

	console_print(id, "[TSM] BUILD %s", TSM_BUILD);
	console_print(id, "[TSM] engine=%s", g_xash ? "Xash3D FWGS (leave cleanup from ClientDisconnect)" : "GoldSrc");
	console_print(id, "[TSM] state=%d round=%d score=%d-%d  start_alive=%d/%d",
		g_state, g_round, g_score[1], g_score[2], g_start_alive[1], g_start_alive[2]);
	console_print(id, "[TSM] respawns=%d  team1: next wave %.0fs, %d waiting  team2: next wave %.0fs, %d waiting",
		get_pcvar_num(g_cv_respawns), g_wave_left[1], count_waiting(1), g_wave_left[2], count_waiting(2));
	// The claimed mode, if any (include\tsm_api.inc): 1 no sudden death, 2 no clock, 4 side 2
	// bots only, 8 side 2 endless, 16 one run per match. Wave seconds below 0: the mode's own waves.
	console_print(id, "[TSM] mode='%s' browser='%s' flags=%d hud='%s' wave secs %.0f/%.0f, waves fired %d/%d",
		g_mode_name[0] ? g_mode_name : "none", g_gamedesc, g_mode_flags, g_mode_hud,
		g_wave_secs[1], g_wave_secs[2], g_wave_num[1], g_wave_num[2]);
	console_print(id, "[TSM] rounds cvar=%d -> need %d to win",
		get_pcvar_num(g_cv_rounds), (get_pcvar_num(g_cv_rounds) / 2) + 1);
	console_print(id, "[TSM] team_mode='%s' team1='%s' team2='%s'", mode, t1, t2);

	new live_list[64];
	get_cvar_string("mp_teamlist", live_list, charsmax(live_list));
	console_print(id, "[TSM] mp_teamlist is now '%s' (force_teamlist=%d)",
		live_list, get_pcvar_num(g_cv_forceteams));
	console_print(id, "[TSM] warmup_hold_active=%d  spawns: total=%d t1=%d t2=%d",
		warmup_hold_active() ? 1 : 0, g_spawn_count, g_spawn_t1_count, g_spawn_t2_count);

	new smode[16], bmode[16];
	get_pcvar_string(g_cv_spawnmode, smode, charsmax(smode));
	get_pcvar_string(g_cv_balmode, bmode, charsmax(bmode));

	new spath[160];
	spawn_cfg_path(spath, charsmax(spath));
	console_print(id, "[TSM] spawn_mode='%s' from_cfg=%d facing=%d  cfg=%s (%s)",
		smode, g_cfg_spawns, g_spawns_have_angles ? 1 : 0, spath,
		file_exists(spath) ? "exists" : "MISSING");

	console_print(id, "[TSM] balance: mode='%s' gap<=%d  t1=%d t2=%d  ok=%d short=%d",
		bmode, get_pcvar_num(g_cv_balgap), count_on_team(1), count_on_team(2),
		balance_ok() ? 1 : 0, balance_short_team());

	// A halted match sits in ready-up (state 1) holding a non-zero score, which looks
	// like nothing happening unless this says why.
	console_print(id, "[TSM] halt: on_leave=%d delay=%.1f bypass=%d  halted=%d waived=%d",
		get_pcvar_num(g_cv_haltleave), get_pcvar_float(g_cv_haltdelay),
		get_pcvar_num(g_cv_haltbypass), g_halted ? 1 : 0, g_halt_waived ? 1 : 0);

	new mmode[16];
	get_pcvar_string(g_cv_modelmode, mmode, charsmax(mmode));
	console_print(id, "[TSM] weapon_mode=%d  (0 = no weapons given AND none stripped, 1 = strip and arm)",
		get_pcvar_num(g_cv_wpnmode));
	console_print(id, "[TSM] classes=%d parsed  default=%d  model_mode='%s'  nocash=%d  block_buy=%d",
		g_class_count, get_pcvar_num(g_cv_defclass), mmode,
		get_pcvar_num(g_cv_nocash), get_pcvar_num(g_cv_blockbuy));

	/*
	 * The engineer doors, and whether the hook that gates them is being delivered.
	 *
	 * in_map is counted from the live entity list, so a map with none says so instead
	 * of looking like a broken hook. ham_use is every func_door Use this plugin has
	 * been handed since the map loaded. A map with doors in it, a player who has stood
	 * at one and pressed +USE, and ham_use=0 means Ham_Use is NOT delivered in this mod
	 * -- the gate is then dead code and the doors are open to whoever walks up.
	 */
	new doors = 0, door_ent = -1;
	for (new guard = 0; guard < 32; guard++)
	{
		door_ent = engfunc(EngFunc_FindEntityByString, door_ent, "targetname", TSM_ENG_DOOR);
		if (door_ent <= 0)
		{
			break;
		}
		doors++;
	}
	new door_class[32];
	get_pcvar_string(g_cv_engdoorclass, door_class, charsmax(door_class));
	console_print(id, "[TSM] eng doors: in_map=%d class='%s'  ham_use=%d (on an eng door=%d)",
		doors, door_class, g_door_use_hits, g_engdoor_use_hits);
	console_print(id, "[TSM] Ham_TakeDamage on player: hits=%d  (0 = the hook is not delivered -- every damage gate in fw_takedamage, friendly fire included, is dead code)",
		g_player_dmg_hits);
	console_print(id, "[TSM] fall damage refused on held bodies: %d  (rising = the warmup fall fix is landing)",
		g_fall_refused);

	console_print(id, "[TSM] solo_test=%d  loadout_reset=%d  block_spectator=%d  lock_teams=%d",
		get_pcvar_num(g_cv_solo), get_pcvar_num(g_cv_reloadout),
		get_pcvar_num(g_cv_nospec), get_pcvar_num(g_cv_teamlock));

	new ldspec[128];
	get_pcvar_string(g_cv_loadout, ldspec, charsmax(ldspec));
	console_print(id, "[TSM] loadout='%s'  debug_log=%d -> logs/%s",
		ldspec, get_pcvar_num(g_cv_dbglog), g_dbgfile);
	console_print(id, "[TSM] PlayerPreThink calls since load: %d  %s",
		g_prethink_calls,
		g_prethink_calls ? "(hook works)" : "(HOOK IS DEAD -- same as CmdStart; per-frame features cannot work)");

	new players[32], pnum, p, pname[32], rawname[32], rawnum, resolved;
	get_players(players, pnum, g_pf);
	console_print(id, "[TSM] --- players (%d) ---", pnum);
	for (new i = 0; i < pnum; i++)
	{
		p = players[i];
		get_user_name(p, pname, charsmax(pname));
		rawname[0] = 0;
		rawnum = get_user_team(p, rawname, charsmax(rawname));
		resolved = tsm_live_team_of(p);
		console_print(id, "[TSM]   %-20s raw#=%d raw='%s' -> resolved=%d  %s%s",
			pname, rawnum, rawname, resolved,
			g_ready[p] ? "READY" : "notready",
			(resolved == 0) ? "  <-- NOT ON A RECOGNISED TEAM" : "");
	}

	// Bots get their own block: the common failures (stuck spectating, never
	// renamed, a refused move being retried forever) are all invisible in the line
	// above, which shows only where they ended up and not why.
	new bots = 0;
	for (new i = 0; i < pnum; i++)
	{
		if (is_user_bot(players[i]))
		{
			bots++;
		}
	}

	if (bots)
	{
		console_print(id, "[TSM] --- bots (%d)  parked=%d  humans_on_a_side=%d ---",
			bots, g_bots_parked ? 1 : 0, humans_playing());

		// If this is 0 while bots are alive and fighting, the traceline hook is not
		// reaching them and they will still be targeting their own side.
		console_print(id, "[TSM] blind_ff=%d  bot traces seen: %d  teammate traces hidden: %d",
			get_pcvar_num(g_cv_blindff), g_traces_seen, g_blinded);
		if (!g_traces_seen)
		{
			console_print(id, "[TSM]   seen=0 -- the traceline hook is not seeing bots at all.");
		}
		else if (!g_blinded)
		{
			console_print(id, "[TSM]   seen>0 but hidden=0 -- bots trace, but never onto a teammate we agree with.");
		}

		for (new i = 0; i < pnum; i++)
		{
			p = players[i];
			if (!is_user_bot(p))
			{
				continue;
			}

			get_user_name(p, pname, charsmax(pname));
			rawname[0] = 0;
			get_user_team(p, rawname, charsmax(rawname));

			console_print(id, "[TSM]   %-20s mod='%s' ours=%d slot=%d class=%d prethinks=%d%s%s",
				pname, rawname, g_match_team[p], g_bot_slot[p], g_player_class[p],
				g_bot_prethinks[p],
				(g_match_team[p] != 1 && g_match_team[p] != 2) ? "  <-- NOT PLACED" : "",
				(g_bot_prethinks[p] == 0) ? "  <-- PreThink NEVER FIRES: no per-frame fix can reach this bot" : "");
		}

		if (humans_playing() < 1)
		{
			console_print(id, "[TSM] No human is on a side, so every bot is held in spectator by design. Join one.");
		}
	}

	console_print(id, "[TSM] If any player resolves to 0, ready-up can never complete.");
	if (get_pcvar_num(g_cv_solo))
	{
		console_print(id, "[TSM] Solo test mode is ON: one team is enough, and rounds end only via amx_tsm_simwin <1|2>.");
	}
	return PLUGIN_HANDLED;
}

/*
 * Emergency / diagnostic release.
 *
 * Isolates the two possible causes of "still frozen when the round starts": if this
 * frees you, release_player() works and simply was not reached. If it does NOT free
 * you, ts_set_speed() cannot restore movement and the freeze needs a different
 * mechanism entirely.
 */
public cmd_unfreeze(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }

	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		g_elim[players[i]] = false;
		release_player(players[i]);
	}
	console_print(id, "[TSM] Released %d player(s) and cleared elimination flags.", pnum);
	console_print(id, "[TSM] If you can move now, release_player() works and was simply not called.");
	console_print(id, "[TSM] If you still cannot move, ts_set_speed cannot undo the freeze.");
	tlog("[TSM] amx_tsm_unfreeze: released %d player(s).", pnum);
	return PLUGIN_HANDLED;
}

/*
 * Every entity classname in the world, with a count.
 *
 * Written because the corpse holder never worked and the reason turned out to be an
 * ASSUMPTION: that TS's body entity is called "deadcorpse". That string is in the game
 * dll, but so are "deadback", "deadsitting", "deadstomach" and "deadtable", which are
 * Half-Life's dead POSE names -- so it is very likely a pose and not a classname, and
 * FindEntityByString has been matching nothing this whole time.
 *
 * Run it right after a kill, while a body is on the floor, and the corpse is whatever
 * appears that was not there before.
 */
public cmd_ents(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }

	new names[48][32], counts[48], n = 0;
	new cls[32];

	for (new e = 1; e < TSM_MAXENT; e++)
	{
		if (!pev_valid(e))
		{
			continue;
		}
		pev(e, pev_classname, cls, charsmax(cls));
		if (!cls[0])
		{
			continue;
		}

		new at = -1;
		for (new i = 0; i < n; i++)
		{
			if (equal(names[i], cls))
			{
				at = i;
				break;
			}
		}
		if (at < 0)
		{
			if (n >= sizeof(names))
			{
				continue;
			}
			copy(names[n], charsmax(names[]), cls);
			counts[n] = 1;
			n++;
		}
		else
		{
			counts[at]++;
		}
	}

	console_print(id, "[TSM] %d distinct entity classname(s):", n);
	for (new i = 0; i < n; i++)
	{
		console_print(id, "    %-30s %d", names[i], counts[i]);
	}
	return PLUGIN_HANDLED;
}

/*
 * tsm_enabled flipped off mid-hold would otherwise leave whoever was frozen at that
 * instant stuck: fw_prethink's own gate (g_cv_enabled check, near its top) returns
 * before should_hold()/release_player() ever run again, so nothing would clear
 * TSM_FL_FROZEN or the maxspeed clamp on its own. restore_all() is the existing,
 * already-safe per-player reset (it does not touch round/match state), so reuse it
 * here rather than write a second copy of the same loop.
 *
 * Polled from task_tick, not hooked with hook_cvar_change: AMXX hooks a cvar change by
 * detouring the engine's Cvar_DirectSet, found by a gamedata signature, and H9XASH's
 * xash.dll matches none ("Binding/Hooking cvars have been disabled" in the AMXX log),
 * so a hooked callback never runs. A second's delay is soon enough.
 */
watch_enabled()
{
	new bool:enabled = get_pcvar_num(g_cv_enabled) != 0;
	if (g_was_enabled && !enabled)
	{
		restore_all();
		turrets_clear();
		music_stop_all();
	}
	g_was_enabled = enabled;
}

/* ---- safety ------------------------------------------------------------- */

restore_all()
{
	new players[32], pnum;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		g_elim[players[i]] = false;
		g_spec_target[players[i]] = 0;
		g_locked_out[players[i]] = false;
		// Back to normal height. Only the drawn scale is cleared here and NOT the class
		// itself: restore_all() is called from eight places, not just the end of a match,
		// and resume_match() after a halt deliberately leaves classes alone -- so wiping
		// the pick here would quietly take everyone's class away mid-match.
		apply_class_scale(players[i]);
		release_player(players[i]);
		restore_presentation(players[i]);
	}
}

public client_putinserver(id)
{
	// Cached once here. fw_traceline runs on a hot path and must not call a native
	// to answer this for every line of sight every bot tests.
	g_is_bot[id] = (is_user_bot(id) != 0);

	g_elim[id] = false;
	g_ready[id] = false;
	g_saved[id] = false;
	g_spec_target[id] = 0;
	g_last_buttons[id] = 0;
	g_match_team[id] = 0;
	g_depart_side[id] = 0;   // a previous player's departure must not follow the new one

	g_player_class[id] = 0;
	g_eng_used[id] = 0.0;
	g_medic_at[id] = 0.0;
	g_last_use[id] = 0;
	g_was_alive[id] = false;
	g_pending_elim[id] = 0.0;
	g_spectator[id] = false;
	g_team_menu_at[id] = 0.0;
	g_connect_at[id] = get_gametime();
	g_mech_hp_watch[id] = 0;
	g_m60_skip[id] = -1;
	g_lo_n[id] = -1;

	// The slot may have belonged to somebody else a second ago: no half-forgotten
	// scanner cooldown or scan mark may follow a new player in.
	g_scan_next[id] = 0.0;
	g_scan_until[id] = 0.0;
	g_scan_team[id] = 0;

	/*
	 * Ambient music is on by default, but the client's own history wins when there is
	 * one: cmd_music mirrors every choice into the client's userinfo (setinfo
	 * "tsm_music"), which the client console keeps like any cvar, so someone who has
	 * switched music off stays off across reconnects.
	 */
	new off[4];
	get_user_info(id, "tsm_music", off, charsmax(off));
	g_music_off[id] = (off[0] && str_to_num(off) == 0);   // ambient music is on by default

	/*
	 * Anyone arriving while a match is running sits the WHOLE match out, not just the
	 * current round. Set immediately rather than on the deferred task, so there is no
	 * window where they can act -- the old three-second delay was long enough to join
	 * a firefight.
	 */
	g_locked_out[id] = (g_state != ST_WARMUP && g_state != ST_READYUP);

	if (g_locked_out[id])
	{
		set_task(3.0, "task_late_join", id);
	}

	// Offset task id so this cannot collide with the armament respawn, which keys its
	// task on the bare player index.
	// Bots are put straight onto a side instead -- they cannot use the side menu, so
	// parking them as spectators would strand them there for good.
	if (bot_player(id))
	{
		set_task(1.0, "task_assign_bot", id + 6000);
		return;
	}

	// The join jingle, for this player alone. Deferred so TS has finished setting the
	// client up before the sound is sent -- too early and it is dropped on the floor.
	set_task(2.0, "task_welcome_sound", id + 9000);

	// And this player's music, joining whatever track the queue is on.
	set_task(3.5, "task_music_join", id + 10000);

	new Float:wait = float(get_pcvar_num(g_cv_menudelay));
	if (wait < 1.0)
	{
		wait = 1.0;
	}
	set_task(wait, "task_default_spectator", id + 1000);
}

/*
 * The join jingle. Sent with client_cmd rather than emit_sound so only the joining
 * player hears it -- emit_sound would put it in the world for everyone standing near
 * them, and this one is meant to be personal. playvol plays it from the client's own
 * sound folder at full volume; spk (the old command) only speaks SENTENCES, which is
 * why the jingle was never heard.
 */
public task_welcome_sound(taskid)
{
	new id = taskid - 9000;
	if (!is_user_connected(id) || is_user_bot(id) || !get_pcvar_num(g_cv_enabled))
	{
		return;
	}
	new snd[64];
	get_pcvar_string(g_cv_welcomesound, snd, charsmax(snd));
	if (snd[0])
	{
		client_cmd(id, "playvol %s 1.0", snd);
	}
}

/* ---- ambient music ------------------------------------------------------- */

/*
 * tsm_music 0/1 from the client console, per player, on by default.
 *
 * Turns the whole queue off for that one player only: every track is sent to each
 * listener with playvol rather than emitted into the world, so emitting to one client
 * cannot be heard by anyone standing near them.
 */
public cmd_music(id, level, cid)
{
	if (!is_user_connected(id))
	{
		return PLUGIN_HANDLED;
	}

	new arg[8];
	read_argv(1, arg, charsmax(arg));
	g_music_off[id] = arg[0] ? (str_to_num(arg) == 0) : !g_music_off[id];

	// Mirrored into the client's userinfo so the choice survives a reconnect -- it is
	// read back where the defaults are cleared on connection.
	client_cmd(id, "setinfo tsm_music %d", g_music_off[id] ? 0 : 1);

	client_print(id, print_chat, "[MATCH] Ambient music is %s. (tsm_music 0 / 1)",
		g_music_off[id] ? "OFF" : "ON");

	if (g_music_off[id])
	{
		// stopsound only reaches wav playback; HL's MP3 player is a separate channel
		// and needs its own stop -- without it the current track plays to the end.
		client_cmd(id, "mp3 stop");
		client_cmd(id, "stopsound");
	}
	else if (g_music_cur >= 0)
	{
		// Switching back on rejoins the track the queue is on, at its running volume.
		music_play(g_music_cur, id);
	}
	return PLUGIN_HANDLED;
}

// A track for every player who wants it, then the next one armed for when it ends.
// One at a time, so two tracks can never overlap on the same client. With tsm_enabled 0
// the server is running TS's own game and nothing plays: the queue looks again every
// MUSIC_IDLE_POLL seconds, so the music starts once the match mode is turned on.
#define MUSIC_IDLE_POLL 10.0
public task_music_queue()
{
	if (!get_pcvar_num(g_cv_enabled))
	{
		g_music_cur = -1;
		set_task(MUSIC_IDLE_POLL, "task_music_queue", TSM_TASK_MUSIC);
		return;
	}

	new idx = music_next();
	g_music_cur = idx;
	music_play(idx, 0);
	tlog("[TSM] Ambient music: %s", g_music_mp3[idx]);

	set_task(g_music_len[idx] + 2.0, "task_music_queue", TSM_TASK_MUSIC);
}

// Stops the ambient track for everyone when the match mode is turned off, and sets the
// queue looking again: it starts a fresh track once tsm_enabled is back on.
music_stop_all()
{
	if (g_music_cur < 0)
	{
		return;
	}
	g_music_cur = -1;
	new players[32], pnum;
	get_players(players, pnum, "c");
	for (new i = 0; i < pnum; i++)
	{
		// the same pair cmd_music sends: mp3 stop for the mp3 tracks, stopsound for the wavs
		client_cmd(players[i], "mp3 stop");
		client_cmd(players[i], "stopsound");
	}
	remove_task(TSM_TASK_MUSIC);
	set_task(MUSIC_IDLE_POLL, "task_music_queue", TSM_TASK_MUSIC);
}

// A fresh player joins the track that is already playing rather than waiting out a
// whole one for the queue to reach them.
public task_music_join(taskid)
{
	new id = taskid - 10000;
	if (g_music_cur >= 0 && get_pcvar_num(g_cv_enabled))
	{
		music_play(g_music_cur, id);
	}
}

// Random, reshuffling when the order runs out and never repeating the track that just
// played across the boundary.
music_next()
{
	if (g_music_pos >= sizeof g_music_order)
	{
		for (new i = sizeof g_music_order - 1; i > 0; i--)
		{
			new j = random(i + 1);
			new t = g_music_order[i];
			g_music_order[i] = g_music_order[j];
			g_music_order[j] = t;
		}
		g_music_pos = 0;
		if (g_music_order[0] == g_music_cur)
		{
			new t = g_music_order[0];
			g_music_order[0] = g_music_order[1];
			g_music_order[1] = t;
		}
	}
	return g_music_order[g_music_pos++];
}

// Returns true if the indexed track is a WAV (contaminated) rather than an MP3.
stock bool:music_is_wav(idx)
{
	// contaminated.wav (5) and vangelis.wav (6): both too long for the shared MP3 stream,
	// both played on an ordinary sound channel via playvol instead.
	return idx == 5 || idx == 6;
}

// HL's MP3 player is invoked with a client execute ("mp3 play <track>"). MP3 player
// audio is 2D non-spatial: it follows the listener and cannot be moved away from.
// Nothing is precached or downloaded, and only the player it is sent to hears it.
// `only` picks one player; 0 sends to everyone with music on.
// Track 5 (contaminated.wav) uses playvol on a normal sound channel instead.
// An mp3 track plays at the player's own MP3Volume: neither engine's mp3 command takes a
// volume, and MP3Volume is the player's setting, so tsm_music_volume is for playvol only.
music_play(idx, only)
{
	new Float:vol = get_pcvar_float(g_cv_musicvol);
	if (vol < 0.0) vol = 0.0;
	if (vol > 1.0) vol = 1.0;

	// The anthems used to own this channel for their seconds -- a per-player
	// lease every queue play and replay had to skip on. They are wavs on a
	// sound channel now, so the one mp3 stream belongs to the queue again:
	// the players skipped here are only the earless (bots) and the opted-out.
	if (music_is_wav(idx))
	{
		// contaminated.wav plays via playvol, not the mp3 player
		if (only)
		{
			if (is_user_connected(only) && !is_user_bot(only) && !g_music_off[only])
			{
				client_cmd(only, "playvol music/%s %f", g_music_mp3[idx], vol);
			}
			return;
		}

		new players[32], pnum;
		get_players(players, pnum, "");
		for (new i = 0; i < pnum; i++)
		{
			if (is_user_bot(players[i]) || g_music_off[players[i]])
			{
				continue;
			}
			client_cmd(players[i], "playvol music/%s %f", g_music_mp3[idx], vol);
		}
		return;
	}

	if (only)
	{
		if (is_user_connected(only) && !is_user_bot(only) && !g_music_off[only])
		{
			client_cmd(only, "mp3 play sound/music/%s", g_music_mp3[idx]);
		}
		return;
	}

	new players[32], pnum;
	get_players(players, pnum, "");
	for (new i = 0; i < pnum; i++)
	{
		if (is_user_bot(players[i]) || g_music_off[players[i]])
		{
			continue;
		}
		client_cmd(players[i], "mp3 play sound/music/%s", g_music_mp3[idx]);
	}
}

/*
 * Parks a player with no side on the spectator team, then offers them the side menu.
 *
 * Deferred rather than done on connect because TS has not finished setting the player
 * up at that point -- the same reason task_late_join waits.
 */
public task_assign_bot(taskid)
{
	new id = taskid - 6000;
	if (!is_user_connected(id))
	{
		return;
	}

	/*
	 * A queued assign must not pull a bot off the bench.
	 *
	 * stagger_assign_bots() schedules these ahead of time, and a match can end
	 * between the schedule and the fire. Without this guard a task that was about
	 * to place a bot would assign a side and respawn it DURING the park, wrecking
	 * the "bots sit out until the next match" the flag exists to provide.
	 */
	if (g_bots_parked || !get_pcvar_num(g_cv_enabled))
	{
		return;
	}

	assign_bot(id);
}

public task_default_spectator(taskid)
{
	new id = taskid - 1000;

	if (!is_user_connected(id) || !get_pcvar_num(g_cv_defaultspec) || !get_pcvar_num(g_cv_enabled))
	{
		return;
	}

	/*
	 * Everyone STARTS as a spectator and picks in -- but only if they have not already
	 * picked.
	 *
	 * This used to wipe g_match_team unconditionally. It runs on a delay, and if it
	 * ever fired a second time (a re-entry of client_putinserver, a late task) it tore
	 * a player off the side they had already chosen and dumped them back on spectator
	 * with the wrong model -- long after they had joined.
	 */
	if (g_match_team[id] == 1 || g_match_team[id] == 2)
	{
		dbgv("default-spectator skipped for %d: already on side %d", id, g_match_team[id]);
		return;
	}

	g_match_team[id] = 0;

	force_spectator(id);
	dbg("defaulting %d to the spectator team", id);

	client_print(id, print_chat, "[MATCH] You are spectating. Pick a side to play, or type .menu.");
	show_team_menu(id);
}

public task_late_join(id)
{
	if (!is_user_connected(id))
	{
		return;
	}
	// Mirrored into g_side, which elimination does not clear: see g_side. Every route
	// that puts somebody on a side has to set it, or they stop counting toward that
	// side the moment they are benched and the match forfeits itself.
	g_match_team[id] = tsm_live_team_of(id);
	if (g_match_team[id]) { g_side[id] = g_match_team[id]; }

	// Held out regardless of whether a team resolved. The old version only acted when
	// a team was known, so anyone TS had not finished assigning played the round free.
	if (g_locked_out[id])
	{
		g_elim[id] = true;
		remove_from_play(id);
		client_print(id, print_chat, "[MATCH] A match is in progress -- you are in once it finishes.");
	}
}

/*
 * A player leaving: everything the plugin keeps about him is put back, and a side he
 * left empty is dealt with. It touches only the plugin's own state, so it runs the
 * same whether or not AMXX still counts him as connected. GoldSrc gets here from
 * client_disconnected, Xash3D from fw_client_disconnect_xash.
 */
player_left(id)
{
	turrets_clear(id);
	g_turret_used[id] = false;
	g_turret_carry[id] = false;
	// Captured BEFORE it is cleared further down: whether this departure emptied a
	// side of its last human decides below whether the match ends without a winner.
	new was_team = g_match_team[id];

	// Their slot is about to be reused by whoever connects next, so the side they
	// belonged to goes with them -- otherwise the newcomer inherits it and counts
	// toward a team they never joined.
	g_side[id] = 0;
	g_elim[id] = false;
	g_ready[id] = false;
	remove_task(id + TSM_TASK_OBJ);
	g_obj_holding[id] = 0;
	g_saved[id] = false;
	g_frozen[id] = false;
	g_placed[id] = false;
	g_in_userinfo[id] = false;
	g_locked_out[id] = false;
	g_spectator[id] = false;
	remove_task(id + 1000);
	g_arm_pending[id] = 0;
	g_issuing[id] = false;
	g_cash_lend[id] = false;
	drop_class_icon(id);
	g_class_menu_at[id] = 0.0;
	g_team_menu_at[id] = 0.0;
	g_player_class[id] = 0;
	g_eng_used[id] = 0.0;
	g_stim_used[id] = false;
	g_forfeit[id] = false;
	// A reused slot must never inherit a stray cloak -- no sound or flash, there is nobody left
	// to hear or see it, this is just making sure the flag, and the EF_NODRAW it keeps on him for
	// RCBot, do not survive into whoever is next. The expiry task is cancelled explicitly too:
	// set_cloak() is not what is clearing the flag here, so it never gets the chance to cancel
	// its own timer the way it normally would.
	g_cloaked[id] = false;
	g_lives_left[id] = 0;
	g_revive_pending[id] = false;
	remove_task(TSM_TASK_REVIVE + id);
	g_revive_refused[id] = 0;
	cloak_bots_show(id);
	remove_task(id + 15000);
	g_last_use[id] = 0;

	// Frees the number for the next bot on that side, so the set stays dense.
	g_is_bot[id] = false;
	g_bot_slot[id] = 0;
	g_model_pick[id] = 0;
	g_model_pick_key[id] = 0;
	g_medic_at[id] = 0.0;

	// Both directions: whoever was following THIS officer is released, and this
	// player stops following anyone.
	disband_squad(id);
	g_squad_leader[id] = 0;
	remove_task(id + 8000);   // any glow still pending on them
	remove_task(id + 12000);  // officer kung-fu readback they will not answer
	g_botfill_at[id] = 0.0;
	g_was_alive[id] = false;
	g_pending_elim[id] = 0.0;
	g_match_team[id] = 0;
	g_last_buttons[id] = 0;
	g_push_until[id] = 0.0;      // clear any pending shove
	g_squad_lag_at[id] = 0.0;    // and any half-run lag clock with it

	// Anyone watching the departed needs a new target, or they would be stuck
	// following a dead index forever.
	for (new i = 1; i < MAXPL; i++)
	{
		if (g_spec_target[i] == id)
		{
			g_spec_target[i] = 0;
		}
	}
	g_spec_target[id] = 0;

	/*
	 * Deferred, not immediate.
	 *
	 * client_disconnected fires while the player is often still present in
	 * get_players(), so a synchronous check still counts them as alive and the round
	 * looks healthy -- which is why a side emptying by disconnect never ended it.
	 * A fraction of a second later they are genuinely gone.
	 *
	 * A side that loses its LAST HUMAN goes with this same deferred check, whichever
	 * state the match is in -- a freeze countdown counts, it holds a round just as
	 * much. Bots on either side change nothing about the trigger: bots are not players
	 * and a side carried by bots alone is autofill, not a match. Was_team can only be
	 * a side here for a real player -- rcbot's bots reach the gamedll past Metamod, so
	 * they never fire client_disconnected at all.
	 */
	if ((g_state == ST_FREEZE || g_state == ST_LIVE) && was_team != 0)
	{
		g_depart_side[id] = was_team;
		set_task(0.3, "task_round_check", id);
	}
	else if (g_state == ST_LIVE)
	{
		set_task(0.3, "task_round_check");
	}

	/*
	 * The balance check is armed separately, and on a longer fuse.
	 *
	 * The 0.3s above only has to outlast the departing player's own presence in
	 * get_players(). This one has to outlast whoever might close the gap -- rcbot
	 * moving its bots, or somebody on the bench picking the short side -- so it waits
	 * tsm_halt_delay rather than a frame. The freeze counts as mid-round: a player who
	 * leaves during the countdown leaves the round just as short as one who leaves
	 * after it.
	 */
	/*
	 * A BOT leaving is not someone leaving the game.
	 *
	 * rcbot adds and removes its own bots constantly, and it balances its sides on
	 * its own schedule rather than ours. Arming the check on those churned the
	 * match out of the freeze countdown -- which takes the loadout with it, because
	 * a halt that leaves ST_FREEZE refuses task_go_live, and the arm respawn refuses
	 * anything that is not the freeze, so a halting round's pending arms are
	 * dropped on the spot. It also clears attack,
	 * because that happens in every state but ST_LIVE. tsm_halt_delay was meant to
	 * ride that out and a refill does not always land inside it.
	 *
	 * A human leaving is what this feature is for, so that is what arms it. Bots
	 * still COUNT once it is armed -- balance_ok() is the only definition of an even
	 * game and must stay the only one -- they just cannot be the trigger.
	 */
	if ((g_state == ST_LIVE || g_state == ST_FREEZE) && !g_is_bot[id])
	{
		new Float:fuse = get_pcvar_float(g_cv_haltdelay);
		if (fuse < 0.1)
		{
			fuse = 0.1;   // set_task will not take a zero delay
		}
		remove_task(14);
		set_task(fuse, "task_halt_check", 14);
	}
}

public client_disconnected(id)
{
	player_left(id);
}

/*
 * Xash3D: a player leaving, from Metamod's ClientDisconnect. Registered only on Xash.
 *
 * AMXX fires client_disconnected from its own hook on the engine's SV_DropClient, found by
 * a byte signature in its gamedata -- which only knows GoldSrc's engines. On Xash it finds
 * nothing, says "client_disconnected and client_remove forwards have been disabled", and
 * a player leaving never reaches client_disconnected at all. Metamod's ClientDisconnect
 * arrives on any engine. There is no double run: on Xash AMXX sends client_disconnected
 * only at map end, when every plugin is reloaded anyway.
 */
public fw_client_disconnect_xash(id)
{
	if (id >= 1 && id < MAXPL)
	{
		player_left(id);
	}
	return FMRES_IGNORED;
}

/*
 * Ends the match outright when a side has nobody left on it.
 *
 * Losing a round because everyone on your side died is normal. Losing every PLAYER
 * on a side is not a round outcome at all -- there is no opposition left to play the
 * remaining rounds against, so continuing just runs the best-of out against an empty
 * team. The surviving side takes it by forfeit.
 *
 * Returns true when it ended the match, so the caller stops.
 */
bool:check_match_viable()
{
	if (g_state != ST_FREEZE && g_state != ST_LIVE && g_state != ST_ROUNDEND)
	{
		return false;
	}

	// count_side, not count_on_team: see count_side. Asking the live field here ended the
	// match every time a side was eliminated, which is every round.
	if (count_side(1) > 0 && count_side(2) > 0)
	{
		return false;
	}

	// Give the bench a chance before calling it -- a spectator or a locked-out late
	// joiner standing by is a better outcome than ending the match.
	autofill_teams();

	new n1 = count_side(1);
	new n2 = count_side(2);
	if (n1 > 0 && n2 > 0)
	{
		all_print("[MATCH] A side was left empty and has been filled. Play on.");
		return false;
	}

	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);

	new w = 0;
	if (n1 > 0)
	{
		w = 1;
	}
	else if (n2 > 0)
	{
		w = 2;
	}

	if (w)
	{
		new wname[48];
		team_display(w, wname, charsmax(wname));
		g_score[w]++;
		all_print("[MATCH] MATCH OVER -- the other side has no players left. %s wins by forfeit, %d -- %d.",
			wname, g_score[1], g_score[2]);
		tlog("[TSM] Match forfeited to team %d: opposing side empty.", w);
	}
	else
	{
		all_print("[MATCH] MATCH OVER -- nobody left to play.");
		tlog("[TSM] Match abandoned: both sides empty.");
	}

	g_state = ST_MATCHEND;
	restore_all();
	set_task(5.0, "task_to_warmup");
	return true;
}

/*
 * Humans on one side, and nothing else. Bots are deliberately invisible here: rcbot
 * backfills a side the way autofill_teams() does, and a side carried entirely by bots
 * is that feature at work, not a match that exists. This is the answer to "did any
 * human leave this side", not to "is there anyone at all".
 */
count_side_humans(team)
{
	new pl[32], pnum, n = 0;
	get_players(pl, pnum, "");
	for (new i = 0; i < pnum; i++)
	{
		if (!is_user_bot(pl[i]) && g_match_team[pl[i]] == team)
		{
			n++;
		}
	}
	return n;
}

/*
 * THE LAST HUMAN ON A SIDE LEFT -- the match goes back to warmup with NO winner.
 *
 * This is deliberately separate from check_match_viable()'s forfeit above. That one
 * ends a match by FORFEIT: a whole side (bots included) is gone and the opposition
 * takes the scoreline. But a side whose last HUMAN left while bots still hold it is
 * not a defeat anyone earned -- the forfeit would be handed to a side that exists
 * only because autofill put bots on it, and a spectator watching bots play bots is
 * not what anyone means by a winner. So no score, no side named as victor: the match
 * simply ends, everything is restored, and warmup opens with the score erased by
 * task_to_warmup.
 *
 * It is keyed on humanity rather than balance on purpose. A full side losing one
 * player has humans still on it and triggers nothing here; an uneven but human-holding
 * pair of sides belongs to halt_for_imbalance instead.
 */
bool:end_match_last_human(side)
{
	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);
	remove_task(14);   // a halt armed off another departure has no reason to fire now

	new tname[48];
	team_display(side, tname, charsmax(tname));
	all_print("[MATCH] MATCH OVER -- the last player of %s left. Nobody wins.", tname);
	tlog("[TSM] match ended without a winner: team %d (%s) ran out of humans.", side, tname);

	g_state = ST_MATCHEND;
	restore_all();
	set_task(5.0, "task_to_warmup");
	return true;
}

public task_halt_check()
{
	halt_for_imbalance();
}

/*
 * Stops a round whose sides have gone uneven and parks the match in ready-up with the
 * score untouched.
 *
 * This is the middle case between the two that already existed. A side being wiped out
 * is a round result; a side being EMPTY ends the match by forfeit. A side merely being
 * SHORT is neither -- the round that is running can no longer be won fairly, but the
 * rounds already won were, so the match is suspended rather than decided.
 *
 * WHY BOTS ARE NOT SPECIAL-CASED HERE.
 *
 * balance_ok() counts bots as players whenever tsm_bots is 1, because that is what
 * gates ready-up. Using anything else here would give the plugin two notions of an
 * even game, and a match could then halt over a gap ready-up would have started on.
 * So a bot counts, and what keeps rcbot's own churn from stopping matches is the delay
 * on task_halt_check instead: rcbot's balance_teams moves its bots back into line
 * within a second or two, so by the time the sides are counted a 5v5 that a human left
 * and a bot refilled reads as even and nothing happens. With tsm_bots 0 bots are
 * absent from every enumeration, so a bot arriving or leaving cannot move these
 * numbers at all and the check is a no-op by construction.
 *
 * Returns true when it halted, so a caller can stop.
 */
bool:halt_for_imbalance()
{
	/*
	 * Only a round in progress can be interrupted.
	 *
	 * In warmup and ready-up the very same balance_ok() test is already holding the
	 * match at the gate and the HUD is already naming the side that is short, so a halt
	 * there would be shutting a door that is shut. Round end and match end are both on
	 * their way somewhere else: start_round() evens the sides up for the next round, and
	 * a finished match has no round left to replay.
	 */
	if (g_state != ST_FREEZE && g_state != ST_LIVE)
	{
		return false;
	}

	if (!get_pcvar_num(g_cv_haltleave))
	{
		return false;
	}

	// Both forms of the bypass are read here rather than at the call sites, so no path
	// into this can miss one.
	if (get_pcvar_num(g_cv_haltbypass) || g_halt_waived)
	{
		return false;
	}

	/*
	 * Solo test mode is exempt, because it plays deliberately lopsided.
	 *
	 * check_all_ready() skips the balance check outright under tsm_test_solo, so halting
	 * over the balance here would stop a round on the one condition the gate was told to
	 * ignore -- and the match could then never resume, because the gate that has to let
	 * it back in is the gate that does not look.
	 */
	if (get_pcvar_num(g_cv_solo))
	{
		return false;
	}

	/*
	 * Two ways to be short, and either one halts.
	 *
	 * balance_ok() asks whether the sides are even counting everybody. The human test
	 * asks whether they are even counting only PEOPLE, which is what a match actually
	 * is -- without it a player leaving is invisible, because rcbot closes the gap
	 * before tsm_halt_delay is up and the totals never look wrong.
	 *
	 * A side with no humans left on it at all halts whatever the gap setting says. There
	 * is nobody there to play the rest of the match against.
	 */
	new h1 = count_humans_on_team(1);
	new h2 = count_humans_on_team(2);
	new hgap = (h1 > h2) ? (h1 - h2) : (h2 - h1);
	new bool:humans_short = false;

	if (get_pcvar_num(g_cv_halthumans))
	{
		humans_short = (hgap > get_pcvar_num(g_cv_balgap));

		/*
		 * "A side with nobody human on it" halts only when BOTS ARE OFF.
		 *
		 * With tsm_bots on, a side carried entirely by bots is not a fault, it is the
		 * designed state -- autofill_teams() puts them there on purpose. Treating it as
		 * grounds to stop the match set two features of this plugin against each other,
		 * and the bots won every time: the match halted into ST_READYUP a few seconds
		 * into play, over and over, for no reason a player could see. Testing alone hit
		 * it every single round, because one side is then always all bots.
		 *
		 * With bots off there is nobody to carry that side, so the rule is right and
		 * stays.
		 */
		if (!get_pcvar_num(g_cv_bots) && (h1 == 0 || h2 == 0))
		{
			humans_short = true;
		}
	}

	/*
	 * Side 2 bots only by design (survival): nobody human is ever on it, and the sides are
	 * meant to be uneven, so neither test above means anything. The one thing that still
	 * stops the run is side 1 emptying of people -- the abandonment below.
	 */
	if (mode_flag(TSM_MODE_SIDE2_BOTS))
	{
		if (h1 > 0)
		{
			return false;
		}
	}
	else if (balance_ok() && !humans_short)
	{
		return false;
	}

	/*
	 * NOBODY HUMAN LEFT AT ALL is not a suspension, it is an abandonment.
	 *
	 * A halt parks the match in ready-up and KEEPS THE SCORE, which is right when one
	 * side is short and the people still here are waiting for a replacement. It is wrong
	 * when everyone has gone: the bots carry on holding a scoreline nobody is playing
	 * for, and the next person to connect walks into somebody else's half-finished match
	 * and resumes it.
	 *
	 * So an empty server goes all the way back to warmup, exactly as amx_match_cancel
	 * leaves it, rather than sitting halted.
	 */
	if (h1 == 0 && h2 == 0)
	{
		remove_task(2);
		remove_task(3);
		remove_task(4);
		remove_task(5);
		g_freeze_left = 0;
		g_round_left = 0;
		g_end_pending_at = 0.0;
		g_end_pending_winner = 0;

		reset_ready();
		// Restore first, then wipe: restore_all() reads g_elim to decide who to put back.
		restore_all();
		clear_match_state();

		all_print("[MATCH] Everyone left -- match abandoned, back to warmup.");
		tlog("[TSM] match abandoned: no human players remain on either side");
		return true;
	}

	new n1 = count_on_team(1);
	new n2 = count_on_team(2);

	new short_team = balance_short_team();
	if (!short_team)
	{
		short_team = 1;   // balance_ok() refused, so a side IS short -- name one anyway
	}
	new shortname[48];
	team_display(short_team, shortname, charsmax(shortname));

	// The abandoned round's timers all have to stop: the round clock, the freeze
	// countdown, the queued next round and the live audit would otherwise fire into a
	// match that is no longer running one. The same four as cmd_cancel, for the same reason.
	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);
	g_freeze_left = 0;
	g_round_left = 0;

	// Cleared for the reason end_round() clears it: a round sitting inside the win hold
	// must not resolve on its way out.
	g_end_pending_at = 0.0;
	g_end_pending_winner = 0;

	g_halted = true;
	g_state = ST_READYUP;

	/*
	 * Everyone is put back exactly as the cancel and match-end paths put them back.
	 *
	 * restore_all() un-hides, un-freezes and re-solidifies every player and clears
	 * g_elim, so nobody is left parked in the holding area above the map waiting for a
	 * round that is not coming. It also clears g_locked_out, which is what makes the
	 * halt useful: a late joiner who was sitting the match out is now free to pick the
	 * side that is short, and that is the whole reason for going back to ready-up rather
	 * than simply pausing. The ready-up tick re-holds and re-hides whoever is on a side,
	 * so nobody is loose in the map while the match is parked.
	 *
	 * Loadouts are left alone. start_round() strips and re-arms every player from their
	 * class when the round is replayed, so whatever anyone is holding now is overwritten
	 * rather than inspected, and classes are per match and survive untouched.
	 */
	restore_all();

	// Resuming is opted into, not done to people mid-conversation -- and clearing these
	// is what makes the resume gate literally the match-start gate. See check_all_ready().
	reset_ready();

	all_print("[MATCH] HALTED -- the sides went uneven at %d v %d. Round %d does not count.",
		n1, n2, g_round);
	all_print("[MATCH] Score is kept at %d -- %d. %s is short; type .ready to carry on.",
		g_score[1], g_score[2], shortname);
	all_print("[MATCH] Admins: amx_match_continue plays the match out as it stands.");

	tlog("[TSM] Match halted at round %d (%d v %d); score %d-%d kept.",
		g_round, n1, n2, g_score[1], g_score[2]);
	dbg("halted round %d over a %d v %d imbalance; back to ready-up with the score kept",
		g_round, n1, n2);
	return true;
}

/*
 * Puts a halted match back into the round it was stopped in.
 *
 * Deliberately not begin_match(): that zeroes g_round and g_score. Everything a round
 * actually needs -- autofill, team caching, elimination flags, placement and loadouts
 * -- is start_round()'s job already, and is the same whether the round is the next one
 * or the one the halt threw away.
 */
resume_match()
{
	g_halted = false;

	// The interrupted round is replayed under its own number rather than skipped:
	// start_round() opens with g_round++, so it is stepped back here to land on the same
	// round again.
	if (g_round > 0)
	{
		g_round--;
	}

	all_print("[MATCH] Resuming at round %d. Score: %d -- %d.",
		g_round + 1, g_score[1], g_score[2]);
	tlog("[TSM] Halted match resumed at round %d with the score at %d-%d.",
		g_round + 1, g_score[1], g_score[2]);
	dbg("resuming a halted match at round %d, score kept at %d-%d",
		g_round + 1, g_score[1], g_score[2]);

	start_round();
}

public task_remove_from_play(taskid)
{
	new id = taskid - 7000;
	if (!is_user_connected(id) || !g_elim[id] || g_revive_active[id])
	{
		return;
	}

	// The ceiling fired. Normally elim_hide_due() has already triggered this from the
	// per-frame path the moment TS put them back on their feet.
	//
	// g_revive_active, not g_revive_pending: the 10s-default tsm_death_delay ceiling
	// firing while a player is merely WAITING for a wave (g_revive_pending true, no
	// wave attempt in flight yet) is exactly the normal, intended transition into
	// ghost/spectate mode -- the same thing that would happen on a permanent
	// elimination, just happening early because a wave hasn't arrived yet. Blocking it
	// there (an earlier version of this guard did, via g_revive_pending) left anyone
	// waiting on a wave unable to spectate/attack-cycle teammates for their entire wait.
	// Only exclude the narrow window where a wave is ACTIVELY trying to revive this
	// player right now (g_revive_active) -- that's the one moment remove_from_play()
	// zeroing g_elim_at and picking a spectate target would glue the about-to-be-alive
	// body onto a teammate via the camera-follow code in fw_prethink. revive_player()'s
	// own cleanup handles g_elim_at for this player once the wave actually revives them.
	remove_from_play(id);
}

public task_round_check(id)
{
	/*
	 * Did the departure this task was armed FOR empty a side of its last human?
	 *
	 * id is the departing player, armed in client_disconnected; g_depart_side is what
	 * side that was, and it is consumed here whether or not the rule fires, so the
	 * slot's next occupant can never inherit it. Running BEFORE check_match_viable
	 * matters: on a side the autofill never reached with bots, that forfeit path would
	 * race this one with a winning verdict nobody earned -- last human off a
	 * botless side says MATCH OVER to a wrong winner a moment later unless this check
	 * has already ended the match.
	 */
	if (id >= 1 && id < MAXPL && g_depart_side[id] != 0
		&& (g_state == ST_FREEZE || g_state == ST_LIVE))
	{
		new side = g_depart_side[id];
		g_depart_side[id] = 0;
		if (count_side_humans(side) == 0)
		{
			end_match_last_human(side);
			return;
		}
	}

	// A side being EMPTY is a different thing from a side being dead, and it ends the
	// whole match rather than the round -- so it is checked first.
	if (check_match_viable())
	{
		return;
	}

	if (g_state == ST_LIVE)
	{
		check_round_end();
	}
}


/// Safety net: catches a round that should have ended but whose DeathMsg was missed.
/// Keeps the enumeration flags in step with tsm_bots.
refresh_player_flags()
{
	/*
	 * Who is a bot, refreshed by POLLING rather than from client_putinserver.
	 *
	 * This is the same trap the bot assignment below already documents, and the
	 * traceline fix walked straight into it: rcbot creates its bots with MDLL_
	 * macros that talk to the gamedll without going through Metamod, so AMXX's
	 * connect forwards never fire for them. g_is_bot was only ever written in
	 * client_putinserver, so it stayed false for every rcbot bot -- and
	 * fw_traceline, which tests it first of all, bailed out every single time and
	 * hid nothing at all.
	 *
	 * The cache itself is still worth having; fw_traceline runs on a very hot path
	 * and must not call a native per trace. It just has to be filled from somewhere
	 * a bot actually reaches.
	 */
	new pl[32], pnum;
	get_players(pl, pnum, "");   // no flags: bots included, whatever tsm_bots says
	for (new i = 0; i < pnum; i++)
	{
		g_is_bot[pl[i]] = (is_user_bot(pl[i]) != 0);
	}

	new on = get_pcvar_num(g_cv_bots);

	if (on)
	{
		copy(g_pf, charsmax(g_pf), "");
		copy(g_pfa, charsmax(g_pfa), "a");
	}
	else
	{
		copy(g_pf, charsmax(g_pf), "c");
		copy(g_pfa, charsmax(g_pfa), "ac");
	}

	if (on == g_bots_were)
	{
		return;   // only act on a change
	}
	g_bots_were = on;

	/*
	 * Tell rcbot as well.
	 *
	 * tsm_bots only controlled whether THIS plugin counted bots -- rcbot kept adding
	 * them regardless, so turning it off left bots wandering a match that ignored
	 * them. Its quota cvars are set to match, and existing bots are removed.
	 */
	if (!on)
	{
		// There is no kickall command. Per rcbot's own docs, a bot is kicked whenever
		// the bot count exceeds min_bots -- so zeroing the quota empties the server.
		server_cmd("rcbot config min_bots 0");
		server_cmd("rcbot config max_bots 0");
		server_exec();

		/*
		 * And kick the ones already here.
		 *
		 * Zeroing the quota only stops NEW bots. rcbot's docs say a bot is kicked once
		 * the count exceeds min_bots, but that is rcbot's own housekeeping on its own
		 * schedule -- turning the cvar off and watching ten bots carry on playing is not
		 * what anyone means by off.
		 *
		 * By userid, because the bot names this plugin assigns contain a space.
		 */
		new kp[32], knum, kicked = 0, k = 0;
		get_players(kp, knum, "");   // no flags, so bots are included
		for (new i = 0; i < knum; i++)
		{
			if (!is_user_bot(kp[i]))
			{
				continue;
			}
			remove_task(kp[i] + TSM_TASK_BOTKICK);
			set_task(0.25 * float(k), "task_kick_bot", kp[i] + TSM_TASK_BOTKICK);
			k++;
			kicked++;
		}
		if (kicked)
		{
			dbg("bots off: %d bot(s) scheduled to leave, 0.25s apart", kicked);
		}
		tlog("[TSM] tsm_bots 0 -- rcbot quota zeroed and %d bot(s) scheduled to leave.", kicked);
	}
	else
	{
		/*
		 * rcbot balances its OWN bots, which this plugin cannot.
		 *
		 * Moving a bot plugin-side only changed our view: rcbot still had it on the old
		 * side, so its new teammates looked like enemies and it shot them, and it kept
		 * using the old side's spawn points. rcbot moving its own bots keeps every view
		 * in agreement.
		 */
		// Not where side 2 is bots only by design (survival): rcbot would even them back out.
		server_cmd("rcbot config balance_teams %d", mode_flag(TSM_MODE_SIDE2_BOTS) ? 0 : 1);
		server_cmd("rcbot config min_bots 0");

		/*
		 * And switch rcbot's own fill OFF (rcbot_commands.txt on max_bots): "-1
		 * disables auto-bot adding/removing".
		 *
		 * Left alone, rcbot pasted its whole quota the instant it saw a deficit --
		 * every TS spawn, precache and team message landing in the same tick, the
		 * burst that read as "all the bots filling the team at once". The joins are
		 * OURS now: task_bot_fill adds one bot every two seconds until tsm_bots is
		 * reached, and replaces a departed bot the same way, so neither rcbot nor
		 * anything else ever makes up a whole side in a single frame.
		 *
		 * The saved bot_config.ini still carries a plain number for rcbot's own
		 * resume-at-boot use; nothing reads it as a fill target once this ran.
		 */
		server_cmd("rcbot config max_bots -1");
		server_exec();

		new botmax = get_pcvar_num(g_cv_bots);
		tlog("[TSM] tsm_bots %d -- rcbot auto-fill OFF (max_bots -1); bots join one every 2s from task_bot_fill.", botmax);
	}
}

public task_tick()
{
	watch_enabled();
	refresh_player_flags();
	clean_all_weapons();

	// Behind the per-frame hold in fw_prethink, which does not run for a player the
	// engine has not started thinking -- which is exactly when initial_cash lands.
	new cp[32], cnum;
	get_players(cp, cnum, "");   // no flags: bots carry cash too
	for (new i = 0; i < cnum; i++)
	{
		hold_cash(cp[i]);
	}

	/*
	 * Bots are picked up by POLLING, not by client_putinserver.
	 *
	 * rcbot creates its bots with MDLL_ClientConnect / MDLL_ClientPutInServer, and
	 * those macros are documented as talking straight to the gamedll without being
	 * multiplexed through Metamod to the other plugins -- so AMXX's connect forwards
	 * do not fire for them. Anything hung off those forwards would simply never run,
	 * and the bot would sit on no side forever.
	 *
	 * One pass a second is cheap and cannot be missed.
	 */
	/*
	 * Keep TS's idea of a player's team in step with ours.
	 *
	 * g_match_team is authoritative for the match, but TS's team is what drives the
	 * MODEL (through mp_teammodels) and the scoreboard. When the two drift, a player
	 * gets the right loadout wearing the wrong side's model -- which is worse than
	 * either being wrong on its own, because it reads as the other team.
	 */
	new sp[32], snum, sid;
	get_players(sp, snum, g_pf);
	for (new i = 0; i < snum; i++)
	{
		sid = sp[i];

		if (is_user_bot(sid) || g_match_team[sid] < 1 || g_match_team[sid] > 2)
		{
			continue;
		}
		if ((get_gametime() - g_reassert_at[sid]) < 10.0)
		{
			continue;   // rate limited; a jointeam makes TS re-apply the model
		}

		new want[32], live[32];
		team_rawname(g_match_team[sid], want, charsmax(want));
		live[0] = 0;
		get_user_team(sid, live, charsmax(live));

		if (want[0] && live[0] && !equali(live, want))
		{
			g_reassert_at[sid] = get_gametime();
			dbg("team drift: %d is '%s' to the mod but '%s' to us -- re-joining", sid, live, want);

			g_join_tries[sid] = 0;
			remove_task(sid + 4000);
			set_task(0.2, "task_verify_join", sid + 4000);
		}
	}

	resupply_one_bot();

	// Sudden death health drain: TWO HP EVERY SECOND, LIVE rounds only. Was one,
	// which rode a five-tick gate before that and made sudden death toothless --
	// one point every five seconds is a scratch, not an emergency. g_sudden is
	// cleared in start_round and again at go-live, so it cannot cross a round
	// boundary, but the state test still matters: between rounds this task keeps
	// firing through the round-end pause and the next freeze.
	if (g_sudden && g_state == ST_LIVE && get_pcvar_num(g_cv_sudden) > 0)
	{
		// get_players with "a" hands back alive players only, so the per-player
		// alive test the five-second version carried is not needed any more.
		new players[32], pnum;
		get_players(players, pnum, "a");
		for (new i = 0; i < pnum; i++)
		{
			new hp = get_user_health(players[i]);
			if (hp > 2)
			{
				set_user_health(players[i], hp - 2);
			}
			else
			{
				// At or below the drain step there is no leaving them the odd
				// remainder: a 2-HP body goes under on this tick, not next.
				user_kill(players[i]);
			}
		}
	}

	if (get_pcvar_num(g_cv_bots))
	{
		new bp[32], bnum, bid, blive[32], bteam;
		get_players(bp, bnum, g_pf);
		new humans = humans_playing();

		for (new i = 0; i < bnum; i++)
		{
			bid = bp[i];
			if (g_bots_parked || !is_user_bot(bid))
			{
				continue;
			}

			/*
			 * Measured against what the mod REPORTS, not against g_match_team.
			 *
			 * Checking our own value could never recover from a refused jointeam,
			 * because set_ts_team has already written the side we asked for -- see
			 * assign_bot. Asking TS costs one string compare a second and it is the
			 * only answer that drives models, spawn points and rcbot's targeting.
			 */
			blive[0] = 0;
			get_user_team(bid, blive, charsmax(blive));
			bteam = tsm_team_from_name(blive);

			if ((bteam == 1 || bteam == 2) && humans > 0)
			{
				// Settled where the mod wants it. Only act if we disagree.
				if (g_match_team[bid] != bteam)
				{
					assign_bot(bid);
				}
				else
				{
					// Cheap, and it returns immediately once the name is right. Without
					// it a bot that missed its rename kept its profile name for good,
					// because assign_bot is not called again once a bot has settled.
					rename_bot(bid);
				}
				continue;
			}

			// Rate limited, because a jointeam respawns the bot and a mod that is
			// refusing the move should not be asked once a second forever.
			if ((get_gametime() - g_botfill_at[bid]) >= 2.0)
			{
				g_botfill_at[bid] = get_gametime();
				assign_bot(bid);
			}
		}

		// Sides are evened out by rcbot itself (balance_teams), not here. Moving a bot
		// plugin-side only desynced us from the mod.
	}

	/*
	 * Re-swept every second, not just at round start.
	 *
	 * A map respawns its own powerups on a timer, so a single sweep at the start of
	 * the round left them coming back solid partway through -- which is how bots were
	 * still picking them up with tsm_no_powerups on. Blocking the usepowerup command
	 * was never going to cover a bot either: a fake client sends no client commands,
	 * so a clcmd hook cannot see one.
	 */
	if (g_state != ST_WARMUP)
	{
		sweep_powerups();
	}

	// Picked up once a second so changing tsm_gamedesc takes effect without a
	// restart. Cheap, and it keeps the query path itself free of cvar reads.
	refresh_gamedesc();
	refresh_presence();

	if (g_state == ST_LIVE)
	{
		// Eliminated players' freeze also expires and has to be renewed.
		new lp[32], lnum;
		get_players(lp, lnum, g_pf);
		for (new i = 0; i < lnum; i++)
		{
			// Nobody should be drifting to spectator now that round starts no longer
			// kill anyone, but this is cheap and the drift was silent when it happened.
			reassert_team(lp[i]);

			if (g_elim[lp[i]])
			{
				hold_player(lp[i], false);
				// Re-asserted here too, not only in PreThink, for the same reason the
				// warmup hide moved: the per-frame hook may not run at all.
				if (is_user_connected(lp[i]) && elim_hide_due(lp[i]))
				{
					set_pev(lp[i], pev_solid, TSM_SOLID_NOT);
					set_pev(lp[i], pev_effects, pev(lp[i], pev_effects) | TSM_EF_NODRAW);
					set_pev(lp[i], pev_takedamage, TSM_DAMAGE_NO);
				}
			}
		}
		show_round_timer();
		show_spectator_hud();
		check_round_end();
		return;
	}

	if (g_state != ST_WARMUP && g_state != ST_READYUP)
	{
		return;
	}

	// tsm_enabled 0: the plugin has stood down for this map -- non-H9 maps set it in
	// plugin_cfg. This branch used to keep drawing the idle banner and re-offering the
	// side menu forever, because neither checked the switch.
	if (!get_pcvar_num(g_cv_enabled))
	{
		return;
	}

	// Teams are learned from whoever is connected, so the plugin works out of the box
	// instead of sitting inert behind an unset cvar.
	autodetect_teams();

	/*
	 * The side menu is offered here, ahead of every early return below.
	 *
	 * It used to be inside the player loop further down, which only runs once
	 * warmup_hold_active() passes -- and that guard fails precisely when nobody is on
	 * a team yet, which is the one situation the menu exists for. The menu was
	 * unreachable exactly when it was needed.
	 */
	new mp[32], mnum, mid;
	get_players(mp, mnum, g_pf);
	for (new i = 0; i < mnum; i++)
	{
		mid = mp[i];

		if ((get_gametime() - g_connect_at[mid]) < float(get_pcvar_num(g_cv_menudelay)))
		{
			continue;   // let TS's own menus settle first
		}

		if (!tsm_live_team_of(mid))
		{
			// No side yet. Re-offered rather than shown once, because a menu is easy
			// to miss or dismiss by accident.
			if (g_team_menu_at[mid] <= 0.0 || (get_gametime() - g_team_menu_at[mid]) > 20.0)
			{
				show_team_menu(mid);
			}
			continue;
		}

		// The class menu is deliberately NOT offered here. It is shown during the
		// countdown by the freeze tick (and directly at the start of the first freeze)
		// -- offering it in warmup as well meant seeing it twice: once on joining a
		// side and again when the round began.
	}

	if (!warmup_hold_active())
	{
		// Say exactly WHAT is missing. "Nothing happens" is the worst possible
		// failure message, and it was the one this plugin gave.
		set_hudmessage(255, 60, 60, -1.0, 0.22, 0, 0.0, 1.5, 0.0, 0.0, 2);
		show_hudmessage(0, "MATCH MODE IDLE^n^nWaiting for two teams to be detected.^nPlayers are needed on two different teams.");
		return;
	}

	// Counted PER TEAM, because that is what actually gates the start. The old
	// global "1 / 1 ready" display looked complete while the real requirement --
	// players on BOTH teams -- was unmet, which made the plugin look broken when it
	// was working exactly as written.
	new n1 = 0, n2 = 0, r1 = 0, r2 = 0;
	new players[32], pnum, id, t;
	get_players(players, pnum, g_pf);
	for (new i = 0; i < pnum; i++)
	{
		id = players[i];

		// The freeze carries a duration, so it must be renewed or it lapses and
		// players quietly regain control. 1.5s against a 1s tick leaves overlap.
		t = tsm_live_team_of(id);

		/*
		 * Only hold players who are actually ON a team.
		 *
		 * Holding everyone deadlocked the server: a player is released when the match
		 * starts, the match cannot start until everyone has readied up, readying up
		 * needs a team -- and a held player cannot reach the team menu to join one.
		 * Someone with no team is still choosing, so they are left alone.
		 */
		if (t)
		{
			hold_player(id, false);
			apply_warmup_hide(id);
		}
		else
		{
			// Teamless players are never held -- they still have to reach the side
			// menu. The menu itself is offered above, before any early return.
			release_player(id);
		}
		// A bot cannot type .ready, so it is counted as ready or a side holding one
		// could never satisfy the gate.
		new bool:rdy = (g_ready[id] || (bot_player(id) && get_pcvar_num(g_cv_botready) != 0));

		if (t == 1)
		{
			n1++;
			if (rdy) { r1++; }
		}
		else if (t == 2)
		{
			n2++;
			if (rdy) { r2++; }
		}
	}

	new need = get_pcvar_num(g_cv_minteam);
	new t1[32], t2[32];
	team_label(1, t1, charsmax(t1), true);
	team_label(2, t2, charsmax(t2), true);

	new bool:solo = (get_pcvar_num(g_cv_solo) != 0);

	new reason[96];
	if (solo && (n1 + n2) > 0 && (r1 + r2) >= (n1 + n2))
	{
		copy(reason, charsmax(reason), "SOLO TEST MODE. STARTING...");
	}
	else if (solo)
	{
		copy(reason, charsmax(reason), "SOLO TEST MODE. TYPE .ready WHEN YOU ARE.");
	}
	else if (id_of_first_teamless())
	{
		copy(reason, charsmax(reason), "SOMEONE HAS NOT PICKED A TEAM YET.");
	}
	else if (n1 < need || n2 < need)
	{
		if (need == 1)
		{
			copy(reason, charsmax(reason), "NEED A PLAYER ON EACH TEAM.");
		}
		else
		{
			formatex(reason, charsmax(reason), "NEED %d PLAYERS ON EACH TEAM.", need);
		}
	}
	else if (!balance_ok())
	{
		new short_team = balance_short_team();
		new shortname[32];
		if (short_team == 1)
		{
			copy(shortname, charsmax(shortname), t1);
		}
		else
		{
			copy(shortname, charsmax(shortname), t2);
		}
		formatex(reason, charsmax(reason), "TEAMS UNEVEN BY MORE THAN %d. SOMEONE SWITCH TO %s.",
			get_pcvar_num(g_cv_balgap), shortname);
	}
	else if (r1 < n1 || r2 < n2)
	{
		copy(reason, charsmax(reason), "WAITING FOR EVERYONE TO TYPE .ready");
	}
	else
	{
		copy(reason, charsmax(reason), "STARTING...");
	}

	// Channel 2 as well: warmup and the freeze countdown are different states and
	// never draw at the same time, so they can share without fighting.
	// Purple-pink, same as the round clock, instead of the old blue.
	set_hudmessage(186, 116, 255, -1.0, 0.20, 0, 0.0, 1.5, 0.0, 0.0, 2);
	show_hudmessage(0, "WARMUP -- PLAYERS HELD^n%s^n^n%s: %d/%d ready^n%s: %d/%d ready",
		reason, t1, r1, n1, t2, r2, n2);

	/*
	 * A HALTED match is re-tested every tick; a fresh one is not.
	 *
	 * Normally check_all_ready() is driven by .ready, which is fine because typing it is
	 * the last thing that can complete the gate. A halt breaks that: the gap can be
	 * closed by somebody joining, switching side or being pulled in, and nobody is going
	 * to re-type .ready to announce it -- so a match whose last blocker was the balance
	 * check would sit there with every flag set and never resume. The call is gated on
	 * g_halted rather than run unconditionally so warmup keeps starting matches exactly
	 * when someone asks it to and not a moment sooner.
	 */
	if (g_halted)
	{
		check_all_ready();
	}
}

