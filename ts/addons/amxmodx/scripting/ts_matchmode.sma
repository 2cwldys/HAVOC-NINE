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

#define PLUGIN  "TS Match Mode"
#define VERSION "0.7"
#define AUTHOR  "tsm"

#define MAXPL 33

// Bumped on every change. amx_tsm_debug prints it, so there is never any doubt about
// which build is actually loaded -- which has already cost us two rounds of chasing
// symptoms that were fixed in source but not on the server.
#define TSM_BUILD "1.49-engdoor"

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
 * Where the insurgent copies of the icons start in that sheet.
 *
 * The sheet holds the classes twice: frames 0 upwards as the MSR wear them, and from
 * TSM_ICON_RED a RED copy of the first TSM_ICON_REDS of them for the insurgents. So the
 * frame is `ci` for team 1 and `TSM_ICON_RED + ci` for team 2.
 *
 * Only the first few are doubled. Medic and Officer are deliberately NOT: bone and amber
 * read as the role rather than as the side, and a medic you can pick out at a glance is
 * worth more than a medic whose team you can tell. A class past TSM_ICON_REDS therefore
 * shows the same icon to both sides, which is why the bound is checked and not assumed.
 *
 * make-class-sprite.mjs prints both numbers when it builds the sheet, and refuses to build
 * if the classes are reordered so that a doubled one is no longer among the first.
 */
#define TSM_ICON_RED  7
#define TSM_ICON_REDS 5

#define TSM_ARM_CASH 32000

/*
 * pev->deadflag, from the HL SDK. Anything other than DEAD_NO means TS is partway
 * through killing this player and owns the entity until it is finished.
 *
 *   0 DEAD_NO   1 DEAD_DYING   2 DEAD_DEAD   3 DEAD_RESPAWNABLE   4 DEAD_DISCARDBODY
 */
#define TSM_DEAD_NO 0

/* ---- match states ------------------------------------------------------- */
#define ST_WARMUP    0
#define ST_READYUP   1
#define ST_FREEZE    2
#define ST_LIVE      3
#define ST_ROUNDEND  4
#define ST_MATCHEND  5

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

#define TSM_DAMAGE_NO        0.0
#define TSM_DAMAGE_AIM       2.0

// Engine-level freeze. The player movement code refuses to move an entity carrying
// this flag, which is what makes it the right mechanism here: it does not touch the
// time base, so animations run at normal speed and clearing the bit fully undoes it.
#define TSM_FL_FROZEN        67108864
#define TSM_FL_KILLME        536870912

// kRenderTransTexture with zero alpha. EF_NODRAW alone was not making players
// invisible in TS, so the hide applies both.
#define TSM_RENDER_NORMAL    0
#define TSM_RENDER_TEXTURE   2

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
#define TSM_PERK_NONE        0
#define TSM_PERK_ENGINEER    1
#define TSM_PERK_BREACHER    2
#define TSM_PERK_MEDIC       3
#define TSM_PERK_OFFICER     4
#define TSM_PERK_REGEN       5

// The regeneration tick's task id. A server-wide task, so it needs an id that cannot
// collide with the per-player ones, which are all a player index plus a round
// thousand (1000 through 8000).
#define TSM_TASK_REGEN       90210

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

new bool:g_elim[MAXPL];      // eliminated for THIS round
new bool:g_ready[MAXPL];
new g_match_team[MAXPL];     // OUR authoritative team, never the mod's live value
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

// Saved presentation, so a player is always restorable.
new bool:g_frozen[MAXPL];          // we are holding this player right now
new Float:g_save_maxspeed[MAXPL];  // their speed before we clamped it

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

new g_cv_enabled, g_cv_rounds, g_cv_freeze, g_cv_roundtime, g_cv_minteam;
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
new g_cv_teamlock;
new g_cv_forcespawn;
new g_cv_classes, g_cv_defclass, g_cv_modelmode, g_cv_classlimits;
new g_cv_nocash, g_cv_blockbuy;
new g_cv_engrange, g_cv_engclips, g_cv_engents, g_cv_engcool;
new g_cv_engglow, g_cv_engshell;
new g_cv_medsound, g_cv_engsound, g_cv_suddensound;
new g_cv_regenamt, g_cv_regenevery, g_cv_regenpause;
new Float:g_last_hit[MAXPL];    // gametime they were last damaged, for the regen pause
new g_cv_breachents, g_cv_breachrange;
new g_cv_engdoorclass;
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
new g_cv_squadmax, g_cv_squaddist, g_cv_squadwarp, g_cv_squadspeed;
new g_cv_squadsteer, g_cv_squadreach;
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
new g_precached = 0;          // class models precached at map load
new g_model_last[MAXPL][32];  // the model we last wrote for this player
new Float:g_model_at[MAXPL];  // when we wrote it
new g_model_writes = 0;       // diagnostic: real model writes since map load
new g_model_want_idx[MAXPL];  // model index the engine must draw for this player
new g_model_chosen[MAXPL][32];// the name the class table picked, before it was checked
new g_model_ok[MAXPL];        // whether that name resolved to a file on disk
new bool:g_roaming[MAXPL];    // .roam -- out of the match, free to walk the map
new Float:g_bot_reload_at[MAXPL];  // last forced reload, so it is not every frame
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
new bool:g_locked_out[MAXPL];  // joined mid-match; sits out until the match ends
new bool:g_forfeit[MAXPL];     // has typed .forfeit this match
new g_last_use[MAXPL];
new bool:g_in_userinfo[MAXPL];
new g_gamedesc[64];

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

new g_freeze_left = 0;
new g_round_left = 0;
new g_cv_showtimer;
new g_cv_t1short, g_cv_t2short;
new g_cv_forceteams, g_cv_forcemodels;
new g_cv_t1label, g_cv_t2label;
new g_cv_menudelay;
new g_cv_blockvgui;
new g_cv_wpnmode;
new g_cv_clipbonus, g_cv_clipcap;
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
new g_cv_nopowerups;
new g_cv_modelpost;
new g_cv_icons, g_cv_iconhigh, g_cv_iconscale, g_cv_sudden;
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

new g_bot_class_rr = 0;  // round-robin cursor for spreading bots across classes

// Ground weapons that belong to the MAP, recorded once after it spawns. Anything not
// in here is something a player dropped.
new g_map_items[128];
new g_map_item_count = 0;
new g_arm_pending[MAXPL];
new Float:g_connect_at[MAXPL];
new Float:g_class_menu_at[MAXPL];
/*
 * A class menu built for ONE player, because what it says depends on his side.
 *
 * The shared g_class_menu cannot carry "2/2 full" -- MSR and the Insurrectionists fill their slots
 * at different rates, so the same item is open for one of them and not the other. It is still built
 * and still the flag that says classes are ready; this is what is actually put on the screen.
 */
new g_class_menu_id[MAXPL];
new Float:g_reassert_at[MAXPL];
new bool:g_issuing[MAXPL];   // our buy commands are executing for this player right now
new bool:g_cash_lend[MAXPL]; // BuyArmament is running for us and needs funds
new g_icon_ent[MAXPL];       // this player's class-icon sprite, 0 if none yet
new bool:g_sudden;           // the last minute has begun, and it is announced once
new bool:g_icon_ok;          // the sheet precached, so the entities may be made
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
		if (equali(mode, "1"))
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

		if (equali(cmode, "spread"))
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
	if (!get_pcvar_num(g_cv_nocash))
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
	if (cls < 1 || cls > g_class_count)
	{
		return false;
	}
	if (!g_class_limit[cls - 1])
	{
		return true;
	}
	// Already his: re-picking what he is holding is not a second slot.
	if (g_player_class[id] == cls)
	{
		return true;
	}
	if (count_class_on_team(cls, team) < g_class_limit[cls - 1])
	{
		return true;
	}

	for (new i = 1; i <= g_class_count; i++)
	{
		if (!g_class_limit[i - 1] || count_class_on_team(i, team) < g_class_limit[i - 1])
		{
			return false;   // something else is open, so he takes that instead
		}
	}
	return true;            // nothing is open anywhere: the limits give way
}

public class_menu_handler(id, menu, item)
{
	if (item == MENU_EXIT || item < 0)
	{
		close_menu(id);
		return PLUGIN_HANDLED;
	}

	if (item < g_class_count)
	{
		// Locked for the rest of the match: the class IS the loadout, so swapping it
		// mid-match would be the economy this replaced.
		if (g_player_class[id] && g_state != ST_WARMUP && g_state != ST_READYUP)
		{
			client_print(id, print_chat, "[MATCH] You are already %s for this match.",
				g_class_name[g_player_class[id] - 1]);
		}
		else if (!class_open_for(id, item + 1, tsm_live_team_of(id)))
		{
			/*
			 * Checked again HERE, not only when the menu was drawn. Everyone picks at once during
			 * the freeze, so the last slot can go to somebody else between the menu appearing on
			 * his screen and his finger coming down on the key.
			 */
			client_print(id, print_chat, "[MATCH] %s is full -- %d a side. Pick another.",
				g_class_name[item], g_class_limit[item]);
			close_menu(id);
			show_class_menu(id);
			return PLUGIN_HANDLED;
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

	close_menu(id);
	return PLUGIN_HANDLED;
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

public team_menu_handler(id, menu, item)
{
	if (item == MENU_EXIT || item < 0)
	{
		close_menu(id);
		return PLUGIN_HANDLED;
	}

	if (item == 0 || item == 1)
	{
		// Sides are fixed for the duration of a match. A late joiner waits it out.
		if (g_state != ST_WARMUP && g_state != ST_READYUP)
		{
			client_print(id, print_chat, "[MATCH] A match is already in progress -- you are in when it finishes.");
			close_menu(id);
			return PLUGIN_HANDLED;
		}

		new team = item + 1;
		new name[32];
		team_rawname(team, name, charsmax(name));

		/*
		 * Refuse a pick that would unbalance the sides.
		 *
		 * Checked here rather than only at ready-up, because being told "the teams are
		 * uneven" after everyone has already picked is no use -- this steers people to
		 * the side that needs them while they are still choosing.
		 */
		new bmode[16];
		get_pcvar_string(g_cv_balmode, bmode, charsmax(bmode));

		if (!equali(bmode, "off") && !equali(bmode, "warn"))
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
				close_menu(id);
				return PLUGIN_HANDLED;
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

		client_print(id, print_chat, "[MATCH] Spectating. Type .team when you want to play.");
		dbg("team menu: %d -> spectate", id);
	}

	close_menu(id);
	return PLUGIN_HANDLED;
}

/*
 * Built from the live team names rather than hardcoded, and rebuilt whenever those
 * names are re-forced, so the menu can never offer a team the mod does not have.
 */
build_team_menu()
{
	if (g_team_menu)
	{
		menu_destroy(g_team_menu);
		g_team_menu = 0;
	}

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
	 * So contrast comes from the text itself. AMXX menus take four codes, and they are the
	 * CLIENT's palette rather than ours: \r red, \y yellow, \w white, \d dim grey. Yellow
	 * on a bright wall reads where white does not, and dimming the furniture -- the
	 * brackets, the dashes -- stops it competing with the words that matter.
	 */
	g_team_menu = menu_create("\yTS Match \d-- \wpick a side", "team_menu_handler");

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

	new label[64];
	formatex(label, charsmax(label), "\wJoin \y%s", l1);
	menu_additem(g_team_menu, label, "1", 0);
	formatex(label, charsmax(label), "\wJoin \y%s", l2);
	menu_additem(g_team_menu, label, "2", 0);
	menu_additem(g_team_menu, "\dSpectate Match", "0", 0);
}

show_team_menu(id)
{
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

	menu_display(id, g_team_menu, 0);
	dbg("showed side menu to %d", id);
	client_print(id, print_chat, "[MATCH] Close any TS menu first, then press a number. Type .team to bring this back.");
}

build_class_menu()
{
	if (g_class_menu)
	{
		menu_destroy(g_class_menu);
		g_class_menu = 0;
	}
	if (!g_class_count)
	{
		return;
	}

	g_class_menu = menu_create("\yTS Match \d-- \wpick your class", "class_menu_handler");

	new label[64], info[8];
	for (new i = 0; i < g_class_count; i++)
	{
		// The class in yellow and its health dimmed: the name is what is being chosen, the
		// number is only there to compare with.
		formatex(label, charsmax(label), "\y%s  \d[%d hp]", g_class_name[i], g_class_hp[i]);
		num_to_str(i, info, charsmax(info));
		menu_additem(g_class_menu, label, info, 0);
	}
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

/* Frees a player's own class menu. Cancelled first: destroying one still on screen is an error. */
drop_class_menu(id)
{
	if (g_class_menu_id[id])
	{
		close_menu(id);
		menu_destroy(g_class_menu_id[id]);
		g_class_menu_id[id] = 0;
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
	drop_class_menu(id);
	g_class_menu_id[id] = menu_create("\yTS Match \d-- \wpick your class", "class_menu_handler");

	new label[64], info[8];
	for (new i = 0; i < g_class_count; i++)
	{
		if (!g_class_limit[i])
		{
			formatex(label, charsmax(label), "\y%s  \d[%d hp]", g_class_name[i], g_class_hp[i]);
		}
		else
		{
			/*
			 * HOW MANY ARE LEFT, not how many are taken. "(1)" is the question a player is
			 * actually asking -- can I still have one -- and 2/4 makes him do the subtraction.
			 */
			new free = g_class_limit[i] - count_class_on_team(i + 1, team);
			if (free < 0)
			{
				free = 0;
			}

			if (!class_open_for(id, i + 1, team))
			{
				// Still listed, and still pressable: the handler says no and says why. Hiding it
				// would leave the numbers beside the other classes meaning nothing.
				formatex(label, charsmax(label), "\d%s  [%d hp]  (full)", g_class_name[i], g_class_hp[i]);
			}
			else
			{
				formatex(label, charsmax(label), "\y%s  \d[%d hp]  \w(%d left)",
					g_class_name[i], g_class_hp[i], free);
			}
		}
		num_to_str(i, info, charsmax(info));
		menu_additem(g_class_menu_id[id], label, info, 0);
	}

	g_class_menu_at[id] = get_gametime();
	menu_display(id, g_class_menu_id[id], 0);
	dbg("showed class menu to %d", id);
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

public plugin_precache()
{
	/*
	 * REGISTERED HERE, not in plugin_init, because this forward runs first and already
	 * logs -- the missing-sprite warning below. A cvar registered in plugin_init does
	 * not exist yet at this point, so anything logging from precache would be dropped
	 * even with tsm_logging on, and would have been passing an unset handle to
	 * get_pcvar_num before that.
	 */
	g_cv_logging = register_cvar("tsm_logging", "0");

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
	get_pcvar_string(g_cv_suddensound, snd, charsmax(snd));
	if (snd[0])
	{
		precache_sound(snd);
	}

	/*
	 * Has to happen HERE. A model precached any later shifts the model index table
	 * that clients were already sent, which is the "Bad model on beam (not sprite)"
	 * crash this plugin has hit before.
	 */
	precache_class_models();
	precache_weapon_models();

	// Guarded, because precaching a file that is not there is a fatal Host_Error
	// that closes the server -- the same failure the class models are guarded
	// against.
	if (file_exists(TSM_ICON_SPR))
	{
		precache_model(TSM_ICON_SPR);
		g_icon_ok = true;
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
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_enabled   = register_cvar("tsm_enabled",     "1");
	g_cv_rounds    = register_cvar("tsm_rounds",      "9");    // best-of, so first to 5
	g_cv_freeze    = register_cvar("tsm_freezetime",  "6");
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
	 * A real third team for people who are not playing.
	 *
	 * Without one, "not on a team" and "watching" are the same state to TS, and a
	 * player sitting in it is still a live body in the world. Giving spectators their
	 * own team means the mod agrees with the plugin about who is in the match.
	 */
	g_cv_specteam  = register_cvar("tsm_spectator_team", "spectator");

	/*
	 * Seconds between writing the armament and the respawn that applies it.
	 *
	 * rst_cfg and tkw are CLIENT commands: the server tells the client to run them and
	 * the client sends them back. That round trip is not instant, so respawning too
	 * soon runs BuyArmament before the last tkw has arrived -- which hands out a
	 * partial loadout, and the magazines attached to the missing entries with it.
	 */
	g_cv_armdelay  = register_cvar("tsm_arm_delay",      "2.5");

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
	 * Remove TS's powerups from match play.
	 *
	 * Powerups are a deathmatch feature -- whoever happens to be standing near one when
	 * a round starts gets an advantage nobody chose. Both the pickups and the command
	 * that activates them are taken out.
	 */
	g_cv_nopowerups = register_cvar("tsm_no_powerups",   "1");
	g_cv_modelpost  = register_cvar("tsm_model_post",     "1");
	g_cv_icons      = register_cvar("tsm_class_icons",    "1");
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
	 * Which class the map's "tsm_eng_door" doors answer to, BY NAME.
	 *
	 * Matched against the class name rather than against its number, because the
	 * number is only its position in tsm_class1..tsm_class7 and reordering those is
	 * a one-line edit that would otherwise hand the doors to whoever landed in slot
	 * two. The name is the thing a server operator actually sets, so it is the thing
	 * this follows -- and if they rename the class, this is where they say so.
	 */
	g_cv_engdoorclass = register_cvar("tsm_eng_door_class", "Combat Engineer");

	g_cv_armorder    = register_cvar("tsm_arm_order", "1");

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
	 * This is the window in which an eliminated player is NOT hidden. At 0 the NODRAW
	 * lands on the frame of death and eats the animation entirely -- you kill someone
	 * and they blink out mid-fall.
	 *
	 * tsm_body_restore actively clears NODRAW every frame of this window, so nothing
	 * else can hide them during it either. When the window ends they are hidden and
	 * become a spectator.
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



	g_cv_squadmax   = register_cvar("tsm_squad_max",   "4");
	g_cv_squaddist  = register_cvar("tsm_squad_dist",  "160");
	g_cv_squadwarp  = register_cvar("tsm_squad_warp",  "1200");
	g_cv_squadspeed = register_cvar("tsm_squad_speed", "240");

	g_cv_squadsteer  = register_cvar("tsm_squad_steer",     "1");
	g_cv_squadreach  = register_cvar("tsm_squad_reach",     "400");

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
	register_forward(FM_AddToFullPack, "fw_addtofullpack", 1);
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

	register_clcmd("say",      "hook_say");
	register_clcmd("say_team", "hook_say");

	register_concmd("amx_match_start",   "cmd_start",   ADMIN_CFG, " - force the match live");
	register_concmd("amx_match_cancel",  "cmd_cancel",  ADMIN_CFG, " - abort and return to warmup");
	register_concmd("amx_match_restart", "cmd_restart", ADMIN_CFG, " - restart the match from round 1");
	register_concmd("amx_match_score",   "cmd_score",   ADMIN_CFG, " - print the score");
	register_concmd("amx_match_continue","cmd_continue",ADMIN_CFG, " - resume a halted match as it stands, keeping the score");
	register_concmd("amx_tsm_fix",       "cmd_fix",     ADMIN_CFG, " <target> - force-restore a stuck player");
	register_concmd("amx_tsm_debug",     "cmd_debug",   ADMIN_CFG, " - why is nothing happening: teams, spawns, ready state");
	register_concmd("amx_tsm_ents",      "cmd_ents",    ADMIN_CFG, " - every entity classname in the world right now");
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
	register_concmd("amx_tsm_simelim",     "cmd_simelim",     ADMIN_CFG, " [target] - eliminate a player as if they were killed");

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

	register_clcmd("usepowerup", "cmd_blockpowerup");
	register_clcmd("powerup",    "cmd_blockpowerup");

	register_clcmd("say .class", "cmd_class");
	register_clcmd("say .team",  "cmd_team");
	register_clcmd("say .menu",  "cmd_legend");
	register_clcmd("say .roam",  "cmd_roam_say");

	// Pass-through watchers. These return PLUGIN_CONTINUE so TS still handles the
	// command -- they exist only to prove whether it reaches the server at all.
	register_clcmd("jointeam",   "cmd_watch_join");
	register_clcmd("changeteam", "cmd_block_changeteam");

	register_concmd("amx_tsm_shuffle", "cmd_shuffle", ADMIN_CFG, " - attempt to even the teams out");
	register_concmd("amx_tsm_teaminfo", "cmd_teaminfo", ADMIN_CFG, " - dump the mod-side team state");
	register_concmd("amx_tsm_menu",     "cmd_menu",     ADMIN_CFG, " <side|class> - force a menu up for testing");
	register_concmd("amx_tsm_whystuck", "cmd_whystuck", ADMIN_CFG, " [target] - dump everything that can stop a player moving");
	register_concmd("amx_tsm_unstick",  "cmd_unstick",  ADMIN_CFG, " [target] - clear every hold and lift them clear of the floor");

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

	// Quarter-second, which is comfortably inside the half-second steps TS fades on, so a
	// held corpse never shows a step of the fade it is being kept out of.
	set_task(0.25, "task_hold_corpses", 13, "", 0, "b");
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
	// Never leave anyone hidden, frozen or non-solid because the plugin unloaded.
	restore_all();

	// The icons are ours, so they go with us rather than being left in the map.
	for (new i = 1; i < MAXPL; i++)
	{
		drop_class_icon(i);
	}
}

/* ---- class icons --------------------------------------------------------- */

/*
 * One sprite per player, made ONCE and then kept.
 *
 * Deliberately not created and destroyed as players live and die: entity churn is
 * what exhausted the edict table before and stopped weapons spawning at all. The
 * sprite is made on first use and hidden when it should not be seen, and only
 * removed when the player leaves.
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

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (!ent)
	{
		g_icon_ent[id] = 0;
		tlog("[TSM] WARNING: could not create a class icon for %d -- out of edicts?", id);
		return 0;
	}

	engfunc(EngFunc_SetModel, ent, TSM_ICON_SPR);
	set_pev(ent, pev_classname, "tsm_class_icon");

	// The owner is how fw_addtofullpack works out whose icon this is, and therefore
	// which side is allowed to see it. It is the only link between the two.
	set_pev(ent, pev_owner, id);

	set_pev(ent, pev_movetype,   TSM_MOVETYPE_NOCLIP);
	set_pev(ent, pev_solid,      TSM_SOLID_NOT);
	set_pev(ent, pev_rendermode, TSM_RENDER_ALPHA);
	set_pev(ent, pev_renderfx,   TSM_RENDERFX_NONE);
	set_pev(ent, pev_renderamt,  255.0);
	set_pev(ent, pev_scale,      get_pcvar_float(g_cv_iconscale));

	g_icon_ent[id] = ent;
	dbgv("class icon %d created for %d", ent, id);
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
	new frame = ci;
	if (ci < TSM_ICON_REDS && tsm_live_team_of(id) == 2)
	{
		frame = TSM_ICON_RED + ci;
	}
	set_pev(ent, pev_frame, float(frame));
	set_pev(ent, pev_scale, get_pcvar_float(g_cv_iconscale));
	set_pev(ent, pev_effects, pev(ent, pev_effects) & ~TSM_EF_NODRAW);
}

/// Called when a player leaves, because the edict must not outlive them.
drop_class_icon(id)
{
	if (g_icon_ent[id] > 0 && pev_valid(g_icon_ent[id]))
	{
		engfunc(EngFunc_RemoveEntity, g_icon_ent[id]);
	}
	g_icon_ent[id] = 0;
}


/*
 * Shows each icon to its OWN SIDE only.
 *
 * AddToFullPack is asked once per (viewer, entity) pair and decides what that one
 * viewer is told about that one entity, so it is the only place a thing can be
 * visible to some players and not to others.
 *
 * The hide is written into the entity STATE being sent, NOT into pev_effects -- the
 * real entity is left alone, so the same sprite is drawn for a teammate on the very
 * frame it is withheld from an enemy.
 */
public fw_addtofullpack(es, e, ent, host, hostflags, player, pSet)
{
	if (!get_pcvar_num(g_cv_enabled) || !g_icon_ok)
	{
		return FMRES_IGNORED;
	}
	if (ent < 1 || host < 1 || host >= MAXPL || !pev_valid(ent))
	{
		return FMRES_IGNORED;
	}

	new owner = pev(ent, pev_owner);
	if (owner < 1 || owner >= MAXPL)
	{
		return FMRES_IGNORED;
	}
	if (!get_pcvar_num(g_cv_icons))
	{
		return FMRES_IGNORED;
	}
	if (g_icon_ent[owner] != ent)
	{
		return FMRES_IGNORED;   // not one of ours; every other entity is left alone
	}

	/*
	 * Never your own, and only your own side's.
	 *
	 * You know your own class, so your icon is for the people around you -- and in
	 * third person or on a spectator camera it would otherwise hang over your head
	 * for no reason.
	 *
	 * Someone with no side -- a spectator, or a player still choosing -- is shown
	 * none of them, because an icon is squad information and they are not on a squad.
	 */
	if (host == owner)
	{
		// Never your own: you know your class, and in third person it would hang over your head.
		set_es(es, ES_Effects, get_es(es, ES_Effects) | TSM_EF_NODRAW);
		return FMRES_IGNORED;
	}

	if (g_match_team[host] >= 1 && g_match_team[host] == g_match_team[owner])
	{
		return FMRES_IGNORED;   // his own side sees it, in his own colour
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
	 * to THAT viewer, so one entity can be a different frame for each of them. The owner's side
	 * sees his class icon above; everyone else sees the red copy of it, and only in the last
	 * stretch of the round.
	 */
	if (g_sudden && g_state == ST_LIVE && get_pcvar_num(g_cv_sudden) > 0
		&& g_match_team[host] >= 1 && g_match_team[host] <= 2
		&& g_match_team[owner] >= 1 && g_match_team[owner] <= 2)
	{
		new ci = resolved_class(owner) - 1;
		if (ci >= 0 && ci < TSM_ICON_REDS)
		{
			set_es(es, ES_Frame, float(TSM_ICON_RED + ci));
			return FMRES_IGNORED;
		}
	}

	set_es(es, ES_Effects, get_es(es, ES_Effects) | TSM_EF_NODRAW);
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
			g_spawn_t1_count++;
			copy_vec(g_spawn_t2[g_spawn_t2_count], g_spawns[i]);
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
				g_spawn_t1_count++;
			}
		}
		else
		{
			if (g_spawn_t2_count < sizeof(g_spawn_t2))
			{
				copy_vec(g_spawn_t2[g_spawn_t2_count], g_spawns[k]);
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

	// Cleared so the side menu will offer itself again.
	g_team_menu_at[id] = 0.0;
	g_class_menu_at[id] = 0.0;
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

add_cfg_spawn(team, const Float:org[3], const Float:ang[3])
{
	if (team == 1 && g_spawn_t1_count < sizeof(g_spawn_t1))
	{
		copy_vec(g_spawn_t1[g_spawn_t1_count], org);
		copy_vec(g_ang_t1[g_spawn_t1_count], ang);
		g_spawn_t1_count++;
	}
	else if (team == 2 && g_spawn_t2_count < sizeof(g_spawn_t2))
	{
		copy_vec(g_spawn_t2[g_spawn_t2_count], org);
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

	if (team < 1 || team > 2)
	{
		server_print("[TSM] tsm_spawn: team must be 1 or 2, got %d", team);
		return PLUGIN_HANDLED;
	}

	if (!add_cfg_spawn(team, org, ang))
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
				}
				else
				{
					copy_vec(g_spawn_t2[k], g_spawn_t2[k + 1]);
					copy_vec(g_ang_t2[k], g_ang_t2[k + 1]);
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

	if (!add_cfg_spawn(team, org, ang))
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
		}
		else
		{
			copy_vec(g_spawn_t2[i], g_spawn_t2[i + 1]);
			copy_vec(g_ang_t2[i], g_ang_t2[i + 1]);
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

public cmd_spawn_clear(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new a[8];
	read_argv(1, a, charsmax(a));
	new team = str_to_num(a);

	if (team != 2)
	{
		g_spawn_t1_count = 0;
	}
	if (team != 1)
	{
		g_spawn_t2_count = 0;
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
		console_print(id, "  T1 #%d  %.0f %.0f %.0f  yaw %.0f",
			i + 1, g_spawn_t1[i][0], g_spawn_t1[i][1], g_spawn_t1[i][2], g_ang_t1[i][1]);
	}
	for (new i = 0; i < g_spawn_t2_count; i++)
	{
		console_print(id, "  T2 #%d  %.0f %.0f %.0f  yaw %.0f",
			i + 1, g_spawn_t2[i][0], g_spawn_t2[i][1], g_spawn_t2[i][2], g_ang_t2[i][1]);
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
	write_file(path, "// tsm_spawn <team> <x> <y> <z> <pitch> <yaw>");

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
		formatex(line, charsmax(line), "tsm_spawn 1 %.2f %.2f %.2f %.2f %.2f",
			g_spawn_t1[i][0], g_spawn_t1[i][1], g_spawn_t1[i][2], g_ang_t1[i][0], g_ang_t1[i][1]);
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
		formatex(line, charsmax(line), "tsm_spawn 2 %.2f %.2f %.2f %.2f %.2f",
			g_spawn_t2[i][0], g_spawn_t2[i][1], g_spawn_t2[i][2], g_ang_t2[i][0], g_ang_t2[i][1]);
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

	dbg("%s", line1);
	dbg("%s", line2);

	if (viewer)
	{
		console_print(viewer, "[TSM] %s", line1);
		console_print(viewer, "[TSM] %s", line2);
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

	/*
	 * Capped at the player's own class health, as the medic's heal is: a Heavy tops out
	 * at 200 and a Marksman at 85, and a stim must not push anyone past what their class
	 * is worth.
	 */
	new ci = resolved_class(id) - 1;
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

	new bool:has_perk = false;
	if (g_class_count && is_user_alive(id) && g_state == ST_LIVE)
	{
		new ci = resolved_class(id) - 1;
		has_perk = (g_class_perk[ci] != TSM_PERK_NONE);
	}

	if (has_perk)
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
	if (!g_legend_menu)
	{
		g_legend_menu = menu_create("TS Match -- menus", "legend_menu_handler");
		menu_additem(g_legend_menu, "Pick a side",        "0", 0);
		menu_additem(g_legend_menu, "Pick a class",       "1", 0);
		menu_additem(g_legend_menu, "Match status",       "3", 0);
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
	// Clear the current side first so the balance check sees the player as unassigned
	// -- otherwise they are counted on the team they are trying to leave.
	if (g_state == ST_WARMUP || g_state == ST_READYUP)
	{
		g_match_team[id] = 0;
		g_player_class[id] = 0;
	}

	if (g_state != ST_WARMUP && g_state != ST_READYUP)
	{
		client_print(id, print_chat, "[MATCH] A match is already in progress -- you are in when it finishes.");
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
	remove_from_play(target);
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
	 * Pick one, and keep it for the whole match.
	 *
	 * Rolling per spawn would change a player's appearance every round, which makes
	 * people unrecognisable mid-match. g_model_pick is cleared with the rest of the
	 * per-MATCH state, not per round.
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

	if (g_model_pick[id] < 1 || g_model_pick[id] > count)
	{
		g_model_pick[id] = random_num(1, count);
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
	if (c < 1 || c > g_class_count)
	{
		c = get_pcvar_num(g_cv_defclass);
	}
	if (c < 1 || c > g_class_count)
	{
		c = 1;
	}
	return c;
}

/*
 * Strips and re-arms a player for their class.
 *
 * Called from task_go_live immediately before the release, and never as a deferred
 * task. That ordering is a hard requirement: TS derives player speed from the weapon
 * slots the loadout consumes (CBasePlayer::GetSpeedBySlots), so a player with no
 * weapons has ZERO maxspeed. Leaving a gap between the strip and the re-arm is what
 * produced the long-running "cannot move, cannot attack, maxspeed 0" fault.
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
	 * Humans are armed through TS's own armament commands in issue_armament(), which
	 * creates nothing. Bots keep whatever rcbot gives them.
	 */

	set_user_health(id, g_class_hp[ci]);
	if (g_class_ap[ci] > 0)
	{
		set_user_armor(id, g_class_ap[ci]);
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
 * Hands the class loadout over directly, with no purchase involved.
 *
 * MUST BE CALLED AFTER THE RESPAWN. strip_user_weapons() and spawn() both clear the
 * inventory, so anything given before them is gone a moment later.
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
	new wn = g_class_wcount[ci][team];
	new bool:reverse = (get_pcvar_num(g_cv_armorder) != 0);
	new given = 0;

	for (new step = 0; step < wn; step++)
	{
		new i = reverse ? (wn - 1 - step) : step;

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
		new base = g_class_clips[ci][team][i];
		new clips = (base > 0) ? (base + bonus) : 0;
		if (clips > cap)
		{
			clips = cap;
		}
		if (clips < 0)
		{
			clips = 0;
		}

		ts_giveweapon(id, g_class_wpn[ci][team][i], clips, get_pcvar_num(g_cv_wpnextra));
		given++;

		dbgv("give: %d <- weapon %d with %d spare clip(s)", id, g_class_wpn[ci][team][i], clips);
	}

	dbg("gave %d weapon(s) to %d as '%s' (team %d)", given, id, g_class_name[ci], team);

	/*
	 * What TS actually attached, as opposed to what it was asked for.
	 *
	 * ONCE, AT THE END, AND ONLY WHEN SOMEONE IS READING IT. This started out inside the
	 * loop above and that was a bad place for it twice over: ts_getuserwpn reports the
	 * weapon IN HAND, which mid-loop is whatever TS happens to have switched to and often
	 * nothing at all -- and a native that errors aborts the whole call, which here is
	 * task_arm_respawn. Everything after the call site went with it, including the
	 * set_task that opens the class menu, so the loadout menu simply never appeared during
	 * the countdown. A diagnostic must not be able to break the thing it is watching.
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

	new ci = resolved_class(id) - 1;
	new team = g_match_team[id];
	if (team != 1 && team != 2)
	{
		team = 1;
	}

	/*
	 * NOTHING IS BOUGHT HERE ANY MORE.
	 *
	 * This used to write the loadout with TS's own tkw and tka commands, which go
	 * through the PURCHASE path -- they write the player's saved armament, and
	 * BuyArmament bought it on the respawn below. That is why weaponrestriction 1
	 * emptied every loadout: as far as TS was concerned the plugin was a customer,
	 * and a restricted weapon is refused to customers.
	 *
	 * The weapons are now handed over directly with ts_giveweapon, AFTER the respawn,
	 * in give_class_weapons(). Measured with ts_probe_give: it arrives with
	 * weaponrestriction 1 set, which the purchase path never could.
	 *
	 * The server needs that cvar on, because blocking the buy commands from a plugin
	 * does not actually stop people buying. So the loadout had to stop being a
	 * purchase rather than the restriction being turned off.
	 */

	// Still ours as far as cmd_blockbuy is concerned, for the rst_cfg below.
	g_issuing[id] = true;

	/*
	 * engclient_cmd, not client_cmd.
	 *
	 * client_cmd asks the CLIENT to run the command and send it back, which a bot has
	 * no client to do. engclient_cmd executes it server-side for players and bots
	 * alike.
	 *
	 * rst_cfg stays even though nothing is bought now: it clears whatever the player
	 * had saved, so BuyArmament has nothing of THEIRS to re-apply when the respawn
	 * below runs.
	 */
	engclient_cmd(id, "rst_cfg");

	/*
	 * The blanket ammunition top-up is gone with the rest of the purchase path.
	 *
	 * tka handed out magazines of all eleven ammo types, and like tkw it was a
	 * purchase, so weaponrestriction refused it too. ts_giveweapon has no equivalent:
	 * it takes a spare-clip count PER WEAPON, which is what give_class_weapons() now
	 * passes -- the class line's own figure, topped up by tsm_clip_bonus and capped by
	 * tsm_clip_max, exactly as before.
	 *
	 * tsm_ammo_mags therefore no longer does anything. It is left registered rather
	 * than removed so that a server.cfg still setting it does not error, and it is
	 * marked dead in ts_matchmode.cfg.
	 */

	dbg("armament prepared for %d as '%s' (team %d, %d weapon(s) to give after the respawn)",
		id, g_class_name[ci], team, g_class_wcount[ci][team]);

	/*
	 * Nothing to wait for now.
	 *
	 * engclient_cmd runs the command immediately on the server, so there is no client
	 * round trip that could arrive after the respawn. The counter that used to track
	 * those echoes is zeroed rather than removed, so the respawn path stays unchanged.
	 */
	g_arm_pending[id] = 0;

	new Float:delay = get_pcvar_float(g_cv_armdelay);
	if (delay < 0.5)
	{
		delay = 0.5;
	}

	/*
	 * The bypass closes HERE, not in task_arm_respawn.
	 *
	 * engclient_cmd executes on the server during the calls above, so by this line
	 * every tkw and tka has already run and nothing of ours is still in flight.
	 * Leaving the flag set until the respawn task fired held cmd_blockbuy open for
	 * tsm_arm_delay and, while echoes were pending, through the freeze countdown --
	 * a multi-second window in which a player's OWN buy menu was waved through, and
	 * whatever they bought was saved to their config and re-applied by BuyArmament
	 * at the respawn. That is the drop-and-collect exploit, held open by our own
	 * exemption.
	 *
	 * The money is a separate flag, g_cash_lend, because it has to stay open longer
	 * than this one -- through the respawn that applies the armament.
	 */
	g_issuing[id] = false;

	remove_task(id);
	set_task(delay, "task_arm_respawn", id);
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
 * Rewrites a player's loadout after a late class pick, so the choice applies to the
 * round that is already counting down rather than the next one.
 */
public task_reissue_armament(taskid)
{
	new id = taskid - 5000;

	if (!is_user_connected(id) || g_state != ST_FREEZE)
	{
		return;
	}
	if (get_pcvar_num(g_cv_wpnmode) != 2 || !get_pcvar_num(g_cv_classes))
	{
		return;
	}

	dbg("re-issuing loadout for %d after a late class pick", id);
	issue_armament(id);
}

public task_arm_respawn(id)
{
	if (!is_user_connected(id) || g_state != ST_FREEZE)
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
		set_task(0.5, "task_arm_respawn", id);
		return;
	}

	if (g_arm_pending[id] > 0)
	{
		dbg("armament: %d respawned with %d command(s) unconfirmed -- loadout may be short",
			id, g_arm_pending[id]);
	}
	g_arm_pending[id] = 0;

	/*
	 * Wiped immediately before the respawn, in the same frame, so every round starts
	 * from nothing.
	 *
	 * Without this the armament is applied ON TOP of what the player already held:
	 * ammunition accumulated round on round (60, then 90, then more), and the weapons
	 * overflowed the slot limit so TS dropped whichever would not fit -- which is why
	 * a sidearm could vanish while the primary survived.
	 *
	 * Safe only because the respawn follows on the very next line: a stripped player
	 * has zero maxspeed in TS, so there must never be a gap where they are both
	 * weaponless and able to act.
	 */
	strip_user_weapons(id);

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
	 * The class menu is QUEUED HERE, directly after the respawn and before anything
	 * else is done to the player.
	 *
	 * Its one real requirement is to come after the respawn: spawn() sends ResetHUD,
	 * which wipes any open menu off the client, so a menu shown before it never
	 * survived. This line satisfies that and nothing more.
	 *
	 * It used to sit at the END of this function, after the weapons, the ammunition,
	 * the health and the placement -- which quietly made the menu depend on all of them
	 * succeeding. It does not: a menu is not part of a loadout. When a diagnostic added
	 * to give_class_weapons() called a native that errored, the whole function aborted
	 * and took this set_task with it, so no class menu appeared during the countdown
	 * while the weapons still arrived -- a weapon fault wearing a menu's face.
	 *
	 * set_task only registers the callback; task_show_class re-checks the state when it
	 * fires 0.3 seconds later, so queueing it early changes when it is ASKED for and not
	 * when it is shown or whether it is allowed.
	 */
	if (g_class_count && get_pcvar_num(g_cv_classes))
	{
		g_class_menu_at[id] = 0.0;
		set_task(0.3, "task_show_class", id);
	}

	/*
	 * AFTER the spawn, never before it.
	 *
	 * strip_user_weapons() above and spawn() itself both clear the inventory, so a
	 * weapon given any earlier is thrown away a moment later -- and the loadout comes
	 * out empty again, for a completely different reason that looks exactly the same.
	 */
	give_class_weapons(id);

	/*
	 * And something to put in them.
	 *
	 * ts_giveweapon takes a spare-clip count, but the clip field on TS's own buy
	 * command was never what produced spare ammunition either -- that is why tka
	 * existed alongside tkw in the first place. So ammunition is handed over
	 * separately, exactly as the engineer's resupply does it, and for the same reason:
	 * it is a pickup rather than a purchase, so weaponrestriction has no say in it.
	 */
	give_ammo_to(id, get_pcvar_num(g_cv_giveammo));

	new ci = resolved_class(id) - 1;
	apply_class_scale(id);
	set_user_health(id, g_class_hp[ci]);
	if (g_class_ap[ci] > 0)
	{
		set_user_armor(id, g_class_ap[ci]);
	}

	place_at_spawn(id);
	hold_player(id, false);
	g_issuing[id] = false;

	// After placement, so the sweep happens where the player actually ended up.
	if (get_pcvar_num(g_cv_cleandrops))
	{
		set_task(0.4, "task_clean_drops", id + 3000);
	}

	dbgv("armament: respawned and placed %d", id);
}

/*
 * Spawns a ts_groundammo and makes the target touch it. `mags` magazines of every
 * ammo type.
 *
 * USED FOR TWO THINGS: the combat engineer's resupply, and the spare ammunition that
 * comes with a class loadout. The loadout used to get its ammunition from TS's tka
 * command, but that is a PURCHASE and weaponrestriction 1 refuses it -- this creates
 * an entity and hands it over instead, so nothing is bought and nothing is refused.
 *
 * Every magazine slot is filled rather than matching their held weapon, because the
 * weapon-to-ammotype mapping lives in the mod's weapon table and is not reachable
 * from a plugin. TS applies what is relevant to what they carry, so the rest is
 * simply ignored.
 *
 * The entity is created and removed inside this call, so however many players are
 * armed in one frame, only ever one exists at a time.
 */
give_ammo_to(target, mags)
{
	if (mags < 1)
	{
		return 0;
	}
	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "ts_groundammo"));
	if (!ent)
	{
		dbg("resupply: could not create ts_groundammo");
		return 0;
	}

	new key[12], v[8];
	num_to_str(mags, v, charsmax(v));
	for (new m = 1; m <= 11; m++)
	{
		formatex(key, charsmax(key), "mags%d", m);
		kv_set(ent, "ts_groundammo", key, v);
	}

	new Float:org[3];
	pev(target, pev_origin, org);
	engfunc(EngFunc_SetOrigin, ent, org);

	dllfunc(DLLFunc_Spawn, ent);

	/*
	 * Touch AND Use.
	 *
	 * TS ground items end their Spawn with SetTouch(NULL), so a Touch dispatched
	 * after DispatchSpawn lands on nothing. Use is what actually transfers. Both go
	 * out because neither costs anything and the two differ by item type.
	 */
	dllfunc(DLLFunc_Touch, ent, target);
	dllfunc(DLLFunc_Use, ent, target, target, 2, 0.0);

	/*
	 * REMOVED, always, picked up or not.
	 *
	 * This leaked an edict on every resupply -- nothing in this plugin ever removed
	 * one. With bots topped up on a timer the server ran out of entity slots within
	 * minutes: first "could not create ts_groundammo", and then no loadout weapons
	 * either, because weapons need edicts too. That is the missing-equipment-on-a-
	 * new-round bug and the resupply failure, same cause.
	 *
	 * Nothing is lost by removing it: the transfer above has already happened or
	 * already failed, and an uncollected pickup lying around is not wanted.
	 */
	if (pev_valid(ent))
	{
		engfunc(EngFunc_RemoveEntity, ent);
	}

	return 1;
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
	emit_sound(target, CHAN_ITEM, snd, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
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
	new cap = get_pcvar_num(g_cv_squadmax);
	new have = squad_size(id);
	if (have >= cap)
	{
		client_print(id, print_chat, "[MATCH] Your squad is full (%d). Type .unfollow to stand them down.", have);
		return;
	}

	new Float:reach = get_pcvar_float(g_cv_squadreach);
	new Float:me[3];
	pev(id, pev_origin, me);

	// Gathered first and sorted by distance, so a cap of four takes the four NEAREST
	// rather than the four lowest entity indices -- which is what taking them in
	// get_players order quietly did.
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
		if (d > reach)
		{
			continue;
		}

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
	for (new i = 0; i < n && have + took < cap; i++)
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
			client_print(id, print_chat, "[MATCH] Nobody within %.0f units on your side.", reach);
		}
		return;
	}

	new name[32];
	get_user_name(id, name, charsmax(name));
	client_print(id, print_chat, "[MATCH] %d on you. Squad is %d of %d. Type .unfollow to stand them down.",
		took, have + took, cap);
	if (owned)
	{
		client_print(id, print_chat, "[MATCH] %d more nearby %s already being commanded by another officer.",
			owned, owned == 1 ? "is" : "are");
	}
	team_print(g_match_team[id], "[MATCH] %s has taken %d under command.", name, took);
	dbg("officer %d took %d bot(s) within %.0f units, %d already owned", id, took, reach, owned);
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
		give_ammo_to(id, get_pcvar_num(g_cv_engclips));
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

	if (is_engineer(id))
	{
		dbg("eng door %d opened by %d", ent, id);
		return HAM_IGNORED;
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

		// Channel 5: 1-4 are already taken by the round timer, score, kill reports
		// and the spectator HUD, and sharing a channel makes both messages flicker.
		set_hudmessage(120, 220, 120, -1.0, 0.56, 0, 0.0, 0.4, 0.0, 0.0, 5);
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
	/*
	 * This is what actually makes .follow follow, so it runs by default now.
	 *
	 * It is in tension with rcbot, which re-decides where its bots are going every
	 * frame -- two things steering one bot. The tension is resolved below by LINE OF
	 * SIGHT: in sight the plugin steers, out of sight it does not touch the bot at
	 * all and rcbot's pathing brings it back. That keeps what steering is good at
	 * (being immediate, close in) and leaves rcbot what it is good at (getting there
	 * around corners), instead of fighting it the whole way.
	 */
	if (!get_pcvar_num(g_cv_squadsteer))
	{
		return;
	}

	new Float:want = float(get_pcvar_num(g_cv_squaddist));
	new Float:warp = float(get_pcvar_num(g_cv_squadwarp));
	new Float:speed = float(get_pcvar_num(g_cv_squadspeed));

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
			continue;   // close enough; leave them to rcbot entirely
		}

		/*
		 * Out of sight, hands off.
		 *
		 * Steering is a straight pull toward the officer, so through a wall it pulls a
		 * bot INTO the wall and holds it there -- worse than not helping. rcbot can
		 * path around that; this cannot. So the plugin only steers where it can see,
		 * and otherwise leaves the bot entirely alone to find its own way.
		 *
		 * IGNORE_MONSTERS deliberately: the test is whether the WORLD is in the way,
		 * not whether another player is standing between them. It also keeps this out
		 * of the way of tsm_bot_blind_ff, which hooks FM_TraceLine to hide teammates
		 * from rcbot -- an officer is a teammate, so a trace that tested bodies could
		 * be answered by our own blinding rather than by the map.
		 */
		new tr = 0;
		engfunc(EngFunc_TraceLine, bo, lo, IGNORE_MONSTERS, bot, tr);
		new Float:frac;
		get_tr2(tr, TR_flFraction, frac);
		if (frac < 1.0)
		{
			continue;
		}

		/*
		 * Lost them completely: put them back.
		 *
		 * Without this a bot that rcbot has walked into another room simply never
		 * comes back, because nudging a velocity cannot beat rcbot's own pathing
		 * over a long distance. A warp is blunt but it is the difference between the
		 * order working and the order being decorative.
		 */
		if (dist > warp)
		{
			new Float:dest[3];
			dest[0] = lo[0];
			dest[1] = lo[1];
			dest[2] = lo[2] + 8.0;
			engfunc(EngFunc_SetOrigin, bot, dest);
			dbgv("squad: warped bot %d back to officer %d (%.0f units)", bot, leader, dist);
			continue;
		}

		if (dist < 1.0)
		{
			continue;
		}

		new Float:vel[3];
		vel[0] = (d[0] / dist) * speed;
		vel[1] = (d[1] / dist) * speed;
		pev(bot, pev_velocity, vel[2]);   // leave vertical motion to the engine
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
 * What +USE does for a class with a perk: resupply a teammate as a Combat Engineer,
 * or force an entity open as a Breacher.
 *
 * Deliberately open-ended -- tsm_eng_entities is empty by default, so until maps ship
 * entities meant for this, +USE against the world behaves exactly as stock TS.
 */
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
		give_ammo_to(hit, get_pcvar_num(g_cv_engclips));

		// Yellow, for ammunition. Red is the medic's.
		glow_player(hit, 255.0, 220.0, 0.0,
			get_pcvar_float(g_cv_engglow), get_pcvar_num(g_cv_engshell));
		perk_sound(hit, g_cv_engsound);

		new a[32], b[32];
		get_user_name(id, a, charsmax(a));
		get_user_name(hit, b, charsmax(b));
		client_print(id,  print_chat, "[MATCH] You resupplied %s.", b);
		client_print(hit, print_chat, "[MATCH] %s resupplied you.", a);
		dbg("engineer %d resupplied %d", id, hit);
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

		breach_entity(id, hit);
		client_print(id, print_center, "Breached.");
		dbg("breacher %d forced '%s' (ent %d)", id, cls, hit);
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

count_alive(team)
{
	new n = 0;
	new players[32], pnum, id;
	get_players(players, pnum, g_pf);
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
	new Float:zero[3];
	set_pev(id, pev_velocity, zero);

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
}

release_player(id)
{
	if (!is_user_connected(id))
	{
		return;
	}
	g_frozen[id] = false;

	// Undo EVERY hold mechanism, not just the one tsm_freeze_method currently
	// selects. Otherwise a player held under one setting stays held forever after
	// the cvar changes, which is exactly how a stuck player goes unexplained.
	set_pev(id, pev_flags, pev(id, pev_flags) & ~TSM_FL_FROZEN);

	// MOVETYPE_NONE cannot move at all, and an eliminated player is left on
	// MOVETYPE_NOCLIP. Either one survives into the next round as "frozen in place"
	// that no amount of flag-clearing explains, so normal walking movement is
	// asserted rather than assumed.
	new mt = pev(id, pev_movetype);
	if (mt != TSM_MOVETYPE_WALK)
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
	set_pev(id, pev_takedamage, TSM_DAMAGE_AIM);

	new rname[32];
	get_user_name(id, rname, charsmax(rname));
	dbg("released %s: movetype %d -> %d, maxspeed -> %.0f, FL_FROZEN cleared",
		rname, mt, pev(id, pev_movetype), Float:pev(id, pev_maxspeed));
}

/* ---- presentation: removing a player from play --------------------------- */

save_presentation(id)
{
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
	 * Deferred rather than dropped, and bounded by tsm_death_delay so a player who
	 * never respawns is still taken out of play instead of retrying forever.
	 */
	if (pev(id, pev_deadflag) != TSM_DEAD_NO
		&& g_elim_at[id] > 0.0
		&& (get_gametime() - g_elim_at[id]) < get_pcvar_float(g_cv_deathdelay))
	{
		dbgv("remove_from_play deferred for %d: TS still has them dying (deadflag %d)",
			id, pev(id, pev_deadflag));
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
	 * NOT guarded on is_user_alive here, deliberately.
	 *
	 * A corpse is not alive, so an alive-only guard at the top would skip the one
	 * thing below that exists to act on corpses -- the visibility restore. That guard
	 * used to be here and would have made this whole fix dead code.
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

	// Same reason as the prethink guard: while TS is killing them, the entity is its
	// to write, including the model the corpse is about to be built from.
	if (pev(id, pev_deadflag) != TSM_DEAD_NO)
	{
		return FMRES_IGNORED;
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
	if (g_model_want_idx[id] > 0 && pev(id, pev_modelindex) != g_model_want_idx[id])
	{
		set_pev(id, pev_modelindex, g_model_want_idx[id]);
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

	new want[32];
	get_pcvar_string(g_cv_specmodel, want, charsmax(want));
	if (want[0])
	{
		new mpath[96];
		formatex(mpath, charsmax(mpath), "models/player/%s/%s.mdl", want, want);
		if (file_exists(mpath))
		{
			g_model_want_idx[id] = engfunc(EngFunc_ModelIndex, mpath);
			copy(g_model_chosen[id], charsmax(g_model_chosen[]), want);
			g_model_ok[id] = 1;

			new buf = engfunc(EngFunc_GetInfoKeyBuffer, id);
			g_in_userinfo[id] = true;
			engfunc(EngFunc_SetClientKeyValue, id, buf, "model", want);
			g_in_userinfo[id] = false;
			copy(g_model_last[id], charsmax(g_model_last[]), want);
		}
		else
		{
			log_amx("[TSM] WARNING: tsm_spectator_model '%s' is not installed (%s) -- a benched player stays visible.",
				want, mpath);
		}
	}

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
	get_pcvar_string(g_cv_gamedesc, g_gamedesc, charsmax(g_gamedesc));
}

public fw_prethink(id)
{
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
	 * ignores it -- so this does not need to know how much ammo they have, which
	 * is just as well because that lives in private data we cannot read.
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
		 */
		if (g_elim[id] && !is_spectating(id))
		{
			set_pev(id, pev_solid,      TSM_SOLID_NOT);
			set_pev(id, pev_effects,    pev(id, pev_effects) | TSM_EF_NODRAW);
			set_pev(id, pev_takedamage, TSM_DAMAGE_NO);
			set_pev(id, pev_maxspeed,   wanted_speed());
			set_user_maxspeed(id, wanted_speed());
			return FMRES_IGNORED;
		}

		apply_freeze(id);

		/*
		 * Only the ATTACK bits are cleared, in the pre hook, because the game DLL's own
		 * PlayerPreThink is what turns pev->button into the pressed/released edges that
		 * weapon code acts on in PostThink -- clearing them first means the DLL never
		 * sees the press.
		 *
		 * Deliberately NOT the whole button field and NOT pev_impulse. Movement is
		 * already stopped by the maxspeed clamp, and wiping impulse every frame broke
		 * menu input, including the team menu -- which left players unable to join a
		 * team at all.
		 */
		set_pev(id, pev_button, pev(id, pev_button) & ~(IN_ATTACK | IN_ATTACK2));
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
			set_task(get_pcvar_float(g_cv_deathdelay), "task_remove_from_play", id + 7000);
			// Same lookup as ev_death: a suicide genuinely has no killer, but a death
			// that simply produced no DeathMsg usually does.
			report_elimination(get_user_attacker(id), id);
			dbg("frame watcher eliminated %d (no DeathMsg -- suicide or world death)", id);
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
			perk_use(id);
		}
		g_last_use[id] = btn;
	}

	// Spectators are invisible and intangible in every state, the same presentation an
	// eliminated player gets -- they are in the world only to watch.
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
		g_elim_at[id] = 0.0;
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

	// Watch what happens to the body for the next few seconds. If it vanishes and
	// nothing here did it, the mod did -- and the log says which.
	g_deathtrace_at[victim] = get_gametime();
	set_task(get_pcvar_float(g_cv_deathdelay), "task_remove_from_play", victim + 7000);

	report_elimination(killer, victim);
	check_round_end();
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

	new a1 = count_alive(1);
	new a2 = count_alive(2);
	team_print(1, "[MATCH] %d alive vs %d alive", a1, a2);
	team_print(2, "[MATCH] %d alive vs %d alive", a2, a1);
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

	new need = (get_pcvar_num(g_cv_rounds) / 2) + 1;
	if (need < 1)
	{
		need = 1;   // a nonsense tsm_rounds must not mean "never end"
	}
	if (g_score[1] >= need || g_score[2] >= need)
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
	new w = (g_score[1] > g_score[2]) ? 1 : 2;
	new wname[32];
	team_display(w, wname, charsmax(wname));
	all_print("[MATCH] MATCH OVER -- %s wins, %d -- %d.", wname, g_score[1], g_score[2]);
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

		// The side they belonged to, released with the match it belonged to. Cleared
		// HERE and nowhere else, which is the whole point of it: see g_side.
		g_side[i] = 0;

		// Per MATCH, not per round: a player who changed appearance every round
		// would be unrecognisable to their own side.
		g_model_pick[i] = 0;
		g_arm_pending[i] = 0;
		g_issuing[i] = false;
		g_cash_lend[i] = false;
		g_elim[i] = false;
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

	new bp[32], bnum, n = 0;
	get_players(bp, bnum, g_pf);
	for (new i = 0; i < bnum; i++)
	{
		if (is_user_bot(bp[i]))
		{
			assign_bot(bp[i]);
			n++;
		}
	}

	if (n)
	{
		all_print("[MATCH] %d bot(s) back in and picking sides.", n);
		dbg("unparked %d bot(s) after the match", n);
	}
}

public task_to_warmup()
{
	// The match is over, so the lockout ends here -- everyone becomes eligible again.
	clear_match_state();

	g_state = ST_WARMUP;

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
	for (new i = 0; i < wnum; i++)
	{
		force_spectator(wp[i]);

		// Only humans get the menu -- a bot cannot answer one.
		if (!is_user_bot(wp[i]))
		{
			set_task(2.0, "task_show_side", wp[i] + 2000);
		}
	}
	all_print("[MATCH] Everyone is spectating. Pick a side to play the next match, or type .menu.");
	g_round = 0;
	g_score[1] = 0;
	g_score[2] = 0;
	reset_ready();
	all_print("[MATCH] Back in warmup. Type .ready when you are.");
}

start_round()
{
	g_round++;
	g_resetting = true;

	// Re-forced every round: cashforwin and cashforlose are read at the END of one,
	// and a map change or an rcon set in between would have put them back.
	kill_ts_cash_cvars();

	// Even the sides up before anything else reads them -- a disconnect mid-match
	// would otherwise leave the rest of the match short-handed.
	autofill_teams();

	// Bots that connected mid-match get their side and class here.
	new bp[32], bnum;
	get_players(bp, bnum, g_pf);
	for (new i = 0; i < bnum; i++)
	{
		assign_bot(bp[i]);
	}

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
	// Nothing is stripped here any more. The armament path strips and re-arms as one
	// operation inside task_arm_respawn; stripping separately would leave players
	// weaponless -- and in TS a player holding nothing has zero maxspeed.

	finish_round_start();
}

public task_finish_round_start()
{
	finish_round_start();
}

finish_round_start()
{
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

		// Written now, during the freeze, so the respawn that applies it lands well
		// before the round goes live.
		//
		// Bots included -- engclient_cmd reaches them, so they get their class loadout
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

			// Bot fallback: if a bot has no weapons after arming, give them the class loadout.
			// get_user_weapons (NOT get_user_weapon) -- the latter's second argument is a
			// by-ref clip output for the current weapon, not a slot index. Passing a loop
			// counter there rewrites it with the clip count on every pass, and any clip
			// under 30 makes the loop endless. That was the .ready freeze.
			if (is_user_alive(id) && g_match_team[id] > 0)
			{
				new wlist[32], wnum;
				get_user_weapons(id, wlist, wnum);
				if (wnum == 0)
				{
					dbg("bot %d has no weapons at round start -- giving class loadout", id);
					apply_class(id);
				}
			}
		}

		// An Officer's whole perk is two chat commands, so it is invisible unless we
		// say so. Humans only -- a bot cannot read it and cannot type one.
		if (!is_user_bot(id)
			&& g_class_count
			&& g_class_perk[resolved_class(id) - 1] == TSM_PERK_OFFICER)
		{
			client_print(id, print_chat,
				"[MATCH] Officer: type .follow to take bots on your side under command, .unfollow to release them.");
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
	g_state = ST_FREEZE;

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

	g_freeze_left = get_pcvar_num(g_cv_freeze);
	remove_task(3);
	set_task(1.0, "task_freeze_tick", 3, "", 0, "b");

	set_task(float(get_pcvar_num(g_cv_freeze)), "task_go_live");
}

place_at_spawn(id)
{
	new team = g_match_team[id];
	new Float:org[3], Float:ang[3];
	new bool:has_ang = false;

	if (team == 1 && g_spawn_t1_count > 0)
	{
		new pick = random_num(0, g_spawn_t1_count - 1);
		copy_vec(org, g_spawn_t1[pick]);
		copy_vec(ang, g_ang_t1[pick]);
		has_ang = g_spawns_have_angles;
	}
	else if (team == 2 && g_spawn_t2_count > 0)
	{
		new pick = random_num(0, g_spawn_t2_count - 1);
		copy_vec(org, g_spawn_t2[pick]);
		copy_vec(ang, g_ang_t2[pick]);
		has_ang = g_spawns_have_angles;
	}
	else if (g_cfg_spawns > 0)
	{
		/*
		 * Configured spawns exist, but not for this side.
		 *
		 * Borrow from the other side rather than dropping back to the map's own spawn
		 * entities. Once a map has custom positions those are the ONLY acceptable
		 * places to put someone -- the map's deathmatch spawns are what the custom ones
		 * were created to replace, so falling back to them silently undoes the whole
		 * point.
		 */
		if (g_spawn_t1_count > 0)
		{
			new pick = random_num(0, g_spawn_t1_count - 1);
			copy_vec(org, g_spawn_t1[pick]);
			copy_vec(ang, g_ang_t1[pick]);
			has_ang = g_spawns_have_angles;
		}
		else if (g_spawn_t2_count > 0)
		{
			new pick = random_num(0, g_spawn_t2_count - 1);
			copy_vec(org, g_spawn_t2[pick]);
			copy_vec(ang, g_ang_t2[pick]);
			has_ang = g_spawns_have_angles;
		}
		else
		{
			return;
		}

		dbg("place: team %d has no configured spawns, borrowed one. Add some with amx_tsm_spawn_add %d.",
			team, team);
	}
	else if (g_spawn_count > 0)
	{
		// No custom spawns on this map at all, so the map's own entities are the
		// fallback -- which is the only situation they should ever be used in.
		copy_vec(org, g_spawns[random_num(0, g_spawn_count - 1)]);
	}
	else
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

	new mins = g_round_left / 60;
	new secs = g_round_left % 60;

	// Red for the last fifteen seconds, which is when it actually matters.
	if (g_round_left <= 15)
	{
		set_hudmessage(255, 60, 60, -1.0, 0.03, 0, 0.0, 1.5, 0.0, 0.0, 1);
	}
	else
	{
		set_hudmessage(0, 200, 255, -1.0, 0.03, 0, 0.0, 1.5, 0.0, 0.0, 1);
	}

	if (get_pcvar_num(g_cv_roundtime) > 0)
	{
		show_hudmessage(0, "ROUND %d -- %d:%02d^n%s %d  --  %d %s",
			g_round, mins, secs, t1, g_score[1], g_score[2], t2);

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
		new sd = get_pcvar_num(g_cv_sudden);
		if (sd > 0 && !g_sudden && g_round_left <= sd)
		{
			g_sudden = true;
			set_hudmessage(255, 80, 60, -1.0, 0.36, 0, 0.0, 3.0, 0.2, 0.4, 4);
			show_hudmessage(0, "SUDDEN DEATH^nEveryone is marked");
			client_print(0, print_chat, "[MATCH] Sudden death -- every player is now marked to the other side.");
			dbg("sudden death on at %d seconds left", g_round_left);
			// Global sudden death sound
			emit_sound(0, CHAN_STATIC, "xom_laugh.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
		}
	}
	else
	{
		show_hudmessage(0, "ROUND %d^n%s %d  --  %d %s",
			g_round, t1, g_score[1], g_score[2], t2);
	}
}

show_score_hud()
{
	set_hudmessage(0, 220, 120, -1.0, 0.18, 0, 0.0, 4.0, 0.2, 0.3, 3);
	show_hudmessage(0, "Round %d  --  %d : %d  (first to %d).",
		g_round, g_score[1], g_score[2], (get_pcvar_num(g_cv_rounds) / 2) + 1);
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

	remove_task(3);
	g_state = ST_LIVE;

	// Hand control back. Logged, because "are players actually being released"
	// has been guesswork twice and the log can simply answer it.
	new rp[32], rnum;
	get_players(rp, rnum, g_pf);
	for (new i = 0; i < rnum; i++)
	{
		// Armed immediately before the release, never as a deferred task: TS derives
		// player speed from the weapon slots the loadout consumes, so a player with no
		// weapons has zero maxspeed and cannot move or shoot.
		apply_class(rp[i]);
		release_player(rp[i]);
	}
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

	new rt = get_pcvar_num(g_cv_roundtime);
	if (rt > 0)
	{
		set_task(float(rt), "task_round_timeout", 2);
	}
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
		if (r1 < n1 || r2 < n2)
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
	// the start rather than inherited from the last one.
	g_bots_parked = false;

	new bp[32], bnum;
	get_players(bp, bnum, g_pf);
	for (new i = 0; i < bnum; i++)
	{
		if (is_user_bot(bp[i]))
		{
			assign_bot(bp[i]);
		}
	}

	g_round = 0;
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
	remove_task(2);
	remove_task(3);
	remove_task(4);
	remove_task(5);
	g_state = ST_WARMUP;
	g_round = 0;
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

public cmd_debug(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1)) { return PLUGIN_HANDLED; }

	new t1[32], t2[32], mode[16];
	get_pcvar_string(g_cv_team1name, t1, charsmax(t1));
	get_pcvar_string(g_cv_team2name, t2, charsmax(t2));
	get_pcvar_string(g_cv_teammode, mode, charsmax(mode));

	console_print(id, "[TSM] BUILD %s", TSM_BUILD);
	console_print(id, "[TSM] state=%d round=%d score=%d-%d  start_alive=%d/%d",
		g_state, g_round, g_score[1], g_score[2], g_start_alive[1], g_start_alive[2]);
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

	g_player_class[id] = 0;
	g_eng_used[id] = 0.0;
	g_medic_at[id] = 0.0;
	g_last_use[id] = 0;
	g_was_alive[id] = false;
	g_pending_elim[id] = 0.0;
	g_spectator[id] = false;
	g_team_menu_at[id] = 0.0;
	g_connect_at[id] = get_gametime();

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

	new Float:wait = float(get_pcvar_num(g_cv_menudelay));
	if (wait < 1.0)
	{
		wait = 1.0;
	}
	set_task(wait, "task_default_spectator", id + 1000);
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
	assign_bot(id);
}

public task_default_spectator(taskid)
{
	new id = taskid - 1000;

	if (!is_user_connected(id) || !get_pcvar_num(g_cv_defaultspec))
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

public client_disconnected(id)
{
	// Their slot is about to be reused by whoever connects next, so the side they
	// belonged to goes with them -- otherwise the newcomer inherits it and counts
	// toward a team they never joined.
	g_side[id] = 0;
	g_elim[id] = false;
	g_ready[id] = false;
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
	// His class menu is his own object. Left behind it would leak a menu handle per disconnect.
	drop_class_menu(id);
	g_class_menu_at[id] = 0.0;
	g_team_menu_at[id] = 0.0;
	g_player_class[id] = 0;
	g_eng_used[id] = 0.0;
	g_stim_used[id] = false;
	g_forfeit[id] = false;
	g_last_use[id] = 0;

	// Frees the number for the next bot on that side, so the set stays dense.
	g_is_bot[id] = false;
	g_bot_slot[id] = 0;
	g_model_pick[id] = 0;
	g_medic_at[id] = 0.0;

	// Both directions: whoever was following THIS officer is released, and this
	// player stops following anyone.
	disband_squad(id);
	g_squad_leader[id] = 0;
	remove_task(id + 8000);   // any glow still pending on them
	g_botfill_at[id] = 0.0;
	g_was_alive[id] = false;
	g_pending_elim[id] = 0.0;
	g_match_team[id] = 0;
	g_last_buttons[id] = 0;

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
	 */
	if (g_state == ST_LIVE)
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
	 * task_arm_respawn requires ST_FREEZE, and clears attack, because that happens
	 * in every state but ST_LIVE. tsm_halt_delay was meant to ride that out and a
	 * refill does not always land inside it.
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

	if (balance_ok() && !humans_short)
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
	if (!is_user_connected(id) || !g_elim[id])
	{
		return;
	}

	// The ceiling fired. Normally elim_hide_due() has already triggered this from the
	// per-frame path the moment TS put them back on their feet.
	remove_from_play(id);
}

public task_round_check()
{
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
		new kp[32], knum, kicked = 0;
		get_players(kp, knum, "");   // no flags, so bots are included
		for (new i = 0; i < knum; i++)
		{
			if (!is_user_bot(kp[i]))
			{
				continue;
			}
			server_cmd("kick #%d", get_user_userid(kp[i]));
			kicked++;
		}
		if (kicked)
		{
			server_exec();
		}
		tlog("[TSM] tsm_bots 0 -- rcbot quota zeroed and %d bot(s) kicked.", kicked);
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
		server_cmd("rcbot config balance_teams 1");
		server_exec();
		tlog("[TSM] tsm_bots 1 -- bots count as players; rcbot balances them (balance_teams 1).");
	}
}

public task_tick()
{
	refresh_player_flags();

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

	// Sudden death health drain: 1 HP every 5 seconds for all alive players.
	if (g_sudden && get_pcvar_num(g_cv_sudden) > 0)
	{
		static sd_tick = 0;
		sd_tick++;
		if (sd_tick >= 5)
		{
			sd_tick = 0;
			new players[32], pnum;
			get_players(players, pnum, "a");
			for (new i = 0; i < pnum; i++)
			{
				if (is_user_alive(players[i]))
				{
					new hp = get_user_health(players[i]);
					if (hp > 1)
					{
						set_user_health(players[i], hp - 1);
					}
					else
					{
						user_kill(players[i]);
					}
				}
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

		// The class menu is deliberately NOT offered here. It is shown once, at the
		// start of a round, from task_arm_respawn -- offering it in warmup as well
		// meant seeing it twice: once on joining a side and again when the round began.
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
	set_hudmessage(0, 180, 255, -1.0, 0.20, 0, 0.0, 1.5, 0.0, 0.0, 2);
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
