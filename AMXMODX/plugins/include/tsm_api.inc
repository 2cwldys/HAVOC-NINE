// tsm_api.inc -- the mode API ts_matchmode offers to mode plugins (ts_uplink, ts_survival).
//
// ts_matchmode is the core: rounds, sides, lives, waves, classes and the HUD. A mode plugin
// CLAIMS a map with tsm_mode_claim() and from then on the core asks it at the points below.
// Without a claim every native here answers and every forward fires, but nothing in the core
// behaves differently -- a map no mode claims plays exactly as it always has.
//
// A mode plugin should load even when ts_matchmode is missing or older than this file: it
// sets a native filter (set_native_filter) that lets every tsm_* native here go unbound,
// and stays inert. ts_matchmode itself defines TSM_CORE before including this file, so it
// only takes the constants.

#if defined _tsm_api_included
	#endinput
#endif
#define _tsm_api_included

/* ---- claim flags: what a mode changes about the core ------------------------------------ */

#define TSM_MODE_NO_SUDDEN     1    // sudden death never starts
#define TSM_MODE_NO_CLOCK      2    // no round time limit; the round line shows tsm_hud_line() instead
#define TSM_MODE_SIDE2_BOTS    4    // side 2 is bots only: humans picking it are made spectators,
                                    // every bot goes to side 2, and nothing balances the sides
#define TSM_MODE_SIDE2_ENDLESS 8    // side 2 never runs out of lives: every death waits for a wave
#define TSM_MODE_ONE_RUN       16   // the first round that ends ends the match, back to warmup

/* ---- match states, as tsm_state() returns them ---------------------------------------- */

#define TSM_ST_WARMUP    0
#define TSM_ST_READYUP   1
#define TSM_ST_FREEZE    2
#define TSM_ST_LIVE      3
#define TSM_ST_ROUNDEND  4
#define TSM_ST_MATCHEND  5

/* ---- the size of a loadout spec ---------------------------------------------------------- */

// Longest spec tsm_loadout() can hand back, and the most weapons one may name.
#define TSM_LOADOUT_LEN  64
#define TSM_LOADOUT_MAX  8

#if !defined TSM_CORE

/* ---- natives ---------------------------------------------------------------------------- */

/**
 * Claims this map for a mode. One claim per map: a second is refused, and so is any claim on
 * a map with siege objectives (tsm_obj_#), which stays a siege map.
 *
 * @param name    the mode's short key, lowercase: "uplink", "survival". Published as tsm_pres_mode.
 * @param desc    what the server browser shows while the mode runs, e.g. "Uplink".
 * @param flags   TSM_MODE_* bits.
 * @return        1 when the map is now this mode's, 0 when the claim was refused.
 */
native tsm_mode_claim(const name[], const desc[], flags);

/** Ends the live round now: 1 or 2 wins it, 0 draws it. 1 when a round was ended. */
native tsm_end_round(winner);

/**
 * Lives back for one side (1 or 2) or both (0), as a new round would give them, in the round
 * still being played: every count SET to the class's, and anyone eliminated waits for their
 * side's next wave. Does nothing without waves (tsm_respawns 0, or sudden death with
 * tsm_respawn_sudden 0). Silent: the caller says what happened.
 *
 * @return  how many eliminated players were put back in line for a wave.
 */
native tsm_reward_lives(side);

/**
 * Seconds between one side's timed waves while the mode runs. 0 goes back to
 * tsm_respawn_wave. A negative value turns that side's timed waves off: its dead wait until
 * the mode brings them back with tsm_fire_wave().
 */
native tsm_wave_seconds(side, Float:seconds);

/** Brings everyone waiting on a side back now, as a forced wave does. How many were sent for. */
native tsm_fire_wave(side);

/** The mode's own text on the round line, e.g. "WAVE 12". Empty clears it. */
native tsm_hud_line(const text[]);

/** The match state: one of TSM_ST_*. */
native tsm_state();

/** The side a player belongs to this match, 1 or 2; 0 for nobody's. Eliminated players keep theirs. */
native tsm_side_of(id);

/** 1 when a player is playing right now: alive, on a side, not eliminated and not sitting out. */
native tsm_in_play(id);

/** Players a side still has in the round: alive, or eliminated and waiting for a wave. */
native tsm_side_alive(side);

/** Gives a TSPWUP_* powerup through TS's own pickup. 1 when TS took it. */
native tsm_give_powerup(id, type);

/** The browser's current game description into out. */
native tsm_match_desc(out[], len);

/** Sets a player's class (1 and up, in tsm_classN order). 1 when it was a real class. */
native tsm_set_class(id, cls);

/** The health a player's class sets. */
native tsm_class_hp(id);

/**
 * The mode's progress for the Discord card and the bots, published as tsm_pres_prog beside
 * tsm_pres_mode: "1/2/3/1" for the uplink (side 1's zones / side 2's / all / the carrier's
 * side), "12" for a survival wave. The core empties both whenever no mode runs.
 */
native tsm_set_progress(const text[]);

/* ---- forwards ---------------------------------------------------------------------------- */

/** A round's freeze has begun: the place to put the mode's own state back to its start. */
forward tsm_round_start(round);

/** The round has gone live. */
forward tsm_round_live(round);

/** The round has ended, however it ended: 1 or 2 won it, 0 is a draw. */
forward tsm_round_end(winner);

/**
 * The round clock has run out. Return PLUGIN_HANDLED to decide the round yourself
 * (tsm_end_round); PLUGIN_CONTINUE lets the core decide it as it always has.
 */
forward tsm_round_timeout();

/** A side's wave timer has fired. number counts this round's natural waves, from 1. */
forward tsm_wave(side, number);

/**
 * A player is about to be armed. Write a spec into spec and return PLUGIN_HANDLED to replace
 * the class's weapons for this arm only: "tsweaponid:clips" pairs, comma-separated, as in a
 * tsm_classN line -- "25:0" a combat knife, "13:3,22:2" an AK47 and a Glock 20, "" bare hands.
 */
forward tsm_loadout(id, spec[], len);

/** A player's loadout and health have just been set, at the round going live or a wave. */
forward tsm_armed(id);

#endif
