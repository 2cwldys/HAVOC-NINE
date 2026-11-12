// tsm_api.inc -- the mode API ts_matchmode offers to mode plugins (ts_uplink, ts_survival,
// ts_mechwarrior, ts_assault, ts_ctf), and the match's own state to any plugin that needs it
// (ts_rtv, h9_compete).
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
#define TSM_MODE_SIDE2_BOTS    4    // the bots' side is bots only (side 2 unless the mode moved it: tsm_set_bot_side): humans picking it are
                                    // made spectators, every bot goes to it, and nothing balances the sides
#define TSM_MODE_SIDE2_ENDLESS 8    // the bots' side never runs out of lives: every death waits for a wave
#define TSM_MODE_ONE_RUN       16   // the first round that ends ends the match, back to warmup
#define TSM_MODE_NO_REINFORCE  256  // the respawn-wave notices go to a waiting player with a life left and to nobody else: not the Officer's
                                    // WAVE IN / REINFORCE line, not the countdown tsm_show_reinforce gives every living player. A mode that
                                    // brings its own waves and announces them itself (Wave Survival) sets it; the wave itself still fires
#define TSM_MODE_NO_ROUNDS     512  // the mode names no round and counts none: the bars say neither "ROUND 2" nor the tally of rounds won, the
                                    // chat gives no round number, and the mode's own text (tsm_hud_line) is the bar's first line. Wave Survival sets it
#define TSM_MODE_ENDLESS       128  // neither side ever runs out of lives: every death waits for the side's next wave, so no side is counted
                                    // out (a mode that is won and lost some other way, Capture the Flag). The bots' side alone is SIDE2_ENDLESS
#define TSM_MODE_ONE_ROUND     64   // the first round that ends is the whole match: its winner wins the match (a drawn round is a drawn
                                    // match, rated for nobody), the bars and the chat say MATCH where they would say ROUND, and no tally
                                    // of rounds is shown. A mode with a cvar for it sets or clears the bit with tsm_mode_flag()
#define TSM_MODE_LIFE_POOL     32   // a side's lives are ONE pool, not a count each player carries, and its players know it as
                                    // REINFORCEMENTS (the match bar, the scoreboard, chat and the class menu say so while the flag is
                                    // set; every mode without it says lives): a death draws its class's cost
                                    // (tsm_class_cost) from its side's pool and the player waits for a wave; a death with the pool
                                    // empty is final. The pool is sized as a round goes live (tsm_pool_base + tsm_pool_perplayer
                                    // a player), shown on the scoreboard, and tsm_pool_set / tsm_pool_add change it
#define TSM_MODE_LATE_JOIN     1024 // the mode asks for tsm_latejoin 2 to mean it: a person who arrives after the match began, or leaves
                                    // the spectators, may take a side, and is let in at his side's next respawn (the next respawn
                                    // wave where the side has waves, else the start of the next round). Nobody is let in during
                                    // sudden death. Never the bots' side of a TSM_MODE_SIDE2_BOTS mode. A joiner draws no life and no
                                    // reinforcement on the way in, and adds nothing to a pool. tsm_latejoin 1 gives it to every mode
#define TSM_MODE_CLASS_CHANGE  2048 // the mode asks for tsm_classchange 2 to mean it: a person who has a class may ask for another (.class)
                                    // at any time, and has it from his next respawn (a revive of a wave, else the next round's start);
                                    // in the freeze countdown the pick is the class at once. tsm_classchange 1 gives it to every mode

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

/* ---- class perks, as a tsm_classN line names them (tsm_class_of_perk) ------------------- */

#define TSM_PERK_NONE        0
#define TSM_PERK_ENGINEER    1
#define TSM_PERK_BREACHER    2
#define TSM_PERK_MEDIC       3
#define TSM_PERK_OFFICER     4
#define TSM_PERK_REGEN       5
#define TSM_PERK_RECON       6
#define TSM_PERK_MECH        7

/* ---- score events, for tsm_points_award ------------------------------------------------- */

#define TSM_POINTS_ZONE      1    // an uplink zone taken: tsm_score_zone
#define TSM_POINTS_CARRY     2    // one second carrying the uplink: tsm_score_carry every tsm_score_carry_secs
#define TSM_POINTS_WAVE      3    // a survival wave cleared while still in play: tsm_score_wave
#define TSM_POINTS_CAPTURE   4    // a flag carried home and captured: tsm_score_capture
#define TSM_POINTS_RETURN    5    // a dropped flag taken back to its pad: tsm_score_return

/* ---- spawn sets ------------------------------------------------------------------------------- */

// The highest forward spawn tier (tsm_spawn ... <tier>), which a mode may open as a spawn set (tsm_spawn_open).
#define TSM_SPAWN_TIER_MAX   32

#if !defined TSM_CORE

/* ---- natives ---------------------------------------------------------------------------- */

/**
 * Claims this map for a mode. One claim per map: a second is refused, and so is any claim on
 * a map with siege objectives (tsm_obj_#), which stays a siege map.
 *
 * @param name    the mode's short key, lowercase: "uplink", "survival", "mechwarrior". Published
 *                as tsm_pres_mode, which the H9 client's rich presence names the mode by.
 * @param desc    what the server browser shows while the mode runs, e.g. "Capture the Uplink".
 * @param flags   TSM_MODE_* bits.
 * @return        1 when the map is now this mode's, 0 when the claim was refused.
 */
native tsm_mode_claim(const name[], const desc[], flags);

/**
 * The claimed mode turns one of its TSM_MODE_* flags on or off after the claim: a mode that lets a cvar decide (Assault's
 * h9_assault_rounds picks TSM_MODE_ONE_ROUND) sets the bit as it claims and again as each round starts. Returns 1 when a mode is
 * claimed and the bit was set as asked, 0 with no claim.
 */
native tsm_mode_flag(flag, bool:on);

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

/**
 * A countdown of the mode's own on the match bar, in place of the round line while it runs: text
 * with {s} for the seconds left ("WAVE 3 CLEARED -- NEXT WAVE IN {s}"); 0 seconds clears it. It
 * may be given again every tick. Only an H9 game's match bar shows it, so draw the hudmessage for
 * every player tsm_bar_shown() says no for.
 */
native tsm_hud_count(const text[], seconds);

/** Whether this player's game draws the match bar (h9_vgui.inc's h9vgui_status). */
native bool:tsm_bar_shown(id);

/** The match state: one of TSM_ST_*. */
native tsm_state();

/**
 * 1 while a match is under way: a round frozen, live or just ended, or the match halted in
 * ready-up with its score kept. 0 in warmup, in the ready-up before a match, once a match is
 * over, and with the match mode off (tsm_enabled 0).
 */
native tsm_match_running();

/**
 * 1 while the claimed mode plays its match as ONE ROUND (TSM_MODE_ONE_ROUND): the first round that ends is the whole match. h9_compete
 * tells h9web so, which then asks of such a match one round and the minimum time, not the several rounds of a match played in rounds.
 */
native tsm_one_round();

/**
 * The rounds side 1 or 2 has won in this match. A finished match keeps its score until warmup
 * clears it, so it can still be read in tsm_match_complete and tsm_match_forfeit. 0 for any
 * other side.
 */
native tsm_score(side);

/** The side a player belongs to this match, 1 or 2; 0 for nobody's. Eliminated players keep theirs. */
native tsm_side_of(id);

/**
 * The side TSM_MODE_SIDE2_BOTS and TSM_MODE_SIDE2_ENDLESS mean: 2 unless the claiming mode moved it. The other side is the
 * people's.
 */
native tsm_bot_side();

/**
 * Moves the bots' side to 1 or 2 (any other value is ignored; 2 is the default). A mode sets it BEFORE tsm_mode_claim, and puts
 * it back to 2 when the claim is refused. 1 when it was set.
 */
native tsm_set_bot_side(side);

/**
 * The toxic-bog fog sudden death uses, on or off, for a claimed mode that wants it without sudden death. The core clears it at
 * every round start. 1 when a mode is claimed and the fog was set, 0 otherwise.
 */
native tsm_fog(bool:on);

/** 1 when a player is playing right now: alive, on a side, not eliminated and not sitting out. */
native tsm_in_play(id);

/**
 * 1 while the match mode draws a player as he is: in play (tsm_in_play), the round frozen, live
 * or just ended, and not cloaked. 0 in warmup, in ready-up and at a match's end, where the holds
 * hide everyone, and for anyone eliminated, benched, spectating or under the Recon's .cloak.
 * With the match mode off (tsm_enabled 0) it hides nobody: 1 for anyone alive.
 */
native tsm_shown(id);

/**
 * Whether a player carries the mode's objective now (the uplink, a flag). The mode says so as he takes it and again as he loses it --
 * dropped, returned, captured, dead -- and saying the same thing twice changes nothing.
 *
 * A carrier cannot cloak: .cloak is refused him, and a Recon who is cloaked as he takes the objective is uncloaked on the spot, with the
 * sound and flash of any other break. He is marked to both sides anyway, so a cloak would hide nothing. A carry the mode never ends is
 * ended by the core when the player dies, leaves, or the round is no longer live.
 *
 * @return  1 when the core took it; 0 for a number that is no player, or (for carrying) one that is not connected.
 */
native tsm_set_carrying(id, bool:carrying);

/** A player's points this match: his score on the scoreboard (tsm_score). */
native tsm_points(id);

/** Side 1's or 2's points this match: its total in the scoreboard's header. */
native tsm_points_side(side);

/** A player's assists on this map, as the scoreboard's A column counts them. */
native tsm_assists(id);

/**
 * The same without the assists on a kill a bot had a part in, as victim or killer: what ranked play
 * counts, as it counts no kill of a bot or by one.
 */
native tsm_assists_ranked(id);

/**
 * Points for something a mode counts (TSM_POINTS_*), worth what that event's tsm_score_* cvar says,
 * to the player and his side. Returns the points given: 0 outside a round, with tsm_score 0, and
 * for TSM_POINTS_CARRY until enough seconds are carried.
 */
native tsm_points_award(id, event);

/** Players a side still has in the round: alive, or eliminated and waiting for a wave. */
native tsm_side_alive(side);

/**
 * Gives a TSPWUP_* powerup through TS's own pickup. 1 when TS took it. 0 when it refused, and always for a
 * bot while the match mode is on and tsm_bot_powerups is 0 (its default): bots are held off powerups, the
 * ones a mode hands out included.
 */
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

/**
 * Every once-a-round ability ready again for side 1 or 2 (0 both), as a new round leaves them:
 * the stim, .ammo, the Engineer's resupply, the Medic's heal, the Officer's scan and
 * reinforcements, the Mech's rockets. Silent: the caller says what happened.
 *
 * @return  how many players were refreshed.
 */
native tsm_refresh_abilities(side);

/** How many classes ts_matchmode.cfg defines (tsm_class1 and up). */
native tsm_class_count();

/** The first class (1 and up) carrying a TSM_PERK_* perk; 0 when no class has it. */
native tsm_class_of_perk(perk);

/**
 * A class's rule while the mode runs: at most limit players a side take it (0 no limit, -1
 * not played at all -- the class menu leaves it out) and it carries lives lives (0 keeps
 * tsm_class_lives). The first rule a map gets starts every other class from the config's own
 * limits; anyone holding a class left out gives it up. Call it again each map: a claim lasts
 * one map, and so do these.
 *
 * @return  1 when cls was a real class.
 */
native tsm_class_rule(cls, limit, lives);

/** The class every bot plays while the mode runs, ahead of tsm_bot_class; 0 hands it back. */
native tsm_mode_bot_class(cls);

/** With TSM_MODE_LIFE_POOL: the reinforcements left in a side's pool (1 or 2). 0 for any other side, and without the flag. */
native tsm_pool_get(side);

/** With TSM_MODE_LIFE_POOL: the pool a side started the round with, the number the scoreboard shows the pool "left of". */
native tsm_pool_start(side);

/**
 * With TSM_MODE_LIFE_POOL: sets a side's pool, and what it started with, to amount: the mode's own number in place of
 * tsm_pool_base + tsm_pool_perplayer a player. The core sizes the pools as a round goes live, so call it from
 * tsm_round_live or later. 1 when it was set.
 */
native tsm_pool_set(side, amount);

/**
 * With TSM_MODE_LIFE_POOL: adds reinforcements to a side's pool (a negative amount takes them away; the pool never goes below 0). What
 * the scoreboard shows the pool left of grows to match when the pool passes it. Returns the pool now.
 */
native tsm_pool_add(side, amount);

/**
 * With TSM_MODE_LIFE_POOL: what a death of class cls draws from the pool while the mode runs (1 and up); 0 keeps the number
 * tsm_class_cost gives. Call it again each map: a claim lasts one map, and so does this. 1 when cls was a real class.
 */
native tsm_class_cost(cls, cost);

/**
 * Opens or closes a spawn set for a side: the forward points of that tier (tsm_spawn ... <tier>, amx_tsm_spawn_add <team> <tier>),
 * 1 to TSM_SPAWN_TIER_MAX. From the first call a side's respawn waves land on the points of ONE open set, the front one: of the sets
 * that are open and have a point for the side, the one nearest the other side's base (the middle of its tier 0 points). When none
 * is open (or none has a point) they land on the side's tier 0 points, and they no longer follow the siege objectives. Round start
 * and a living player are never moved. 1 when it was taken.
 */
native tsm_spawn_open(side, set, bool:open);

/** Closes every spawn set a mode opened for a side (0 both). The mode stays in charge of where that side respawns. */
native tsm_spawn_open_clear(side);

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

/**
 * A match has been played to its end: a side reached the win total (winner 1 or 2), or a
 * one-run mode's run is over (winner 0). Sent whether or not a mode claimed the map, as the
 * match goes back to warmup. Not sent for a match cancelled, forfeited or left with an empty side.
 */
forward tsm_match_complete(winner);

/**
 * A player has died in a live round and lost a life: left is how many he has still to come, 0
 * for none. Sent only while a mode claims the map. Return PLUGIN_HANDLED once you have told him
 * in your own words; PLUGIN_CONTINUE lets the core say its own line ("2 lives left -- back in the
 * next wave"), and with none left the core says nothing.
 */
forward tsm_life_lost(id, left);

/**
 * A person has taken a side after the match began (tsm_latejoin) and waits to be let in at his side's next respawn. Return PLUGIN_HANDLED once you
 * have told him in your own words (Wave Survival's wave is the mutants' own, so it says when he comes in); PLUGIN_CONTINUE lets the core say its
 * own line. Sent only while a mode claims the map. tsm_side_of answers 0 for him until he is let in.
 */
forward tsm_late_wait(id);

/**
 * A match a side forfeited: all of its people voted .forfeit, or it was left with no players
 * while the other side still had some. winner is the side that stayed. Sent as the match goes
 * back to warmup, with its score final (tsm_score). A cancelled match, one both sides left, and
 * one whose side ran out of humans ("Nobody wins") send nothing.
 */
forward tsm_match_forfeit(winner);

/**
 * A player pressed the use key on a bot of his own side and asks it to let go of what it carries. A mode that has that bot carry an
 * objective drops it (as dropuplink or dropflag would for a person), keeps that bot off it for secs seconds so that the player can take
 * it, and returns PLUGIN_HANDLED; a mode whose bot carries nothing returns PLUGIN_CONTINUE. Sent whether or not a mode has claimed the
 * map. TS's own briefcase is handled by the core and sends no forward of its own.
 */
forward tsm_handoff_drop(id, Float:secs);

#endif
