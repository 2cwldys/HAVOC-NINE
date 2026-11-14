/*
 * tsm_botobj.inc -- what the mode plugins write on their objective entities for the bots, and the switch that lets the bots play them.
 *
 * rcbot_mm.dll (rcbot-patch, CHANGE 11) reads these fields straight off the entities with the engine's own entvars: no message, no
 * cvar per field. None of them reaches a client (reTS AddToFullPack copies no iuser, fuser, vuser or team), none is a field the
 * game library reads on these info_target entities, and no player carries one. The whole contract is in docs\BOT_OBJECTIVES.txt.
 *
 * tsm_bot_objectives (default 1) is the switch: 1 lets the bots play the objectives of the mode, 0 leaves them fighting. Every
 * mode plugin registers it here (a cvar that exists keeps its value), and rcbot reads it once a second. The value line stays
 * commented out in ts_matchmode.cfg, like tsm_bot_powerups: that file runs on every map load.
 */
#if defined _tsm_botobj_included
	#endinput
#endif
#define _tsm_botobj_included

#include <amxmodx>
#include <fakemeta>

// pev_iuser2 of a capture point (Assault) or a control zone (Uplink)
#define TSB_QUIET      0   // nobody is taking it
#define TSB_TAKING     1   // a side is taking it (Uplink: its carrier, the timer running)
#define TSB_CONTESTED  2   // Assault: both sides stand in it and nothing moves. Uplink: the carrier is in it with a living enemy
#define TSB_OFF        3   // not in play: warmup, freeze, round end, match end

// pev_iuser2 of the uplink
#define TSB_UP_POST    1   // at its post, never carried this round
#define TSB_UP_CARRIED 2
#define TSB_UP_DROPPED 3   // loose where a carrier lost it

new g_tsb_cvar;   // tsm_bot_objectives

/// Registers tsm_bot_objectives; called once from a mode plugin's plugin_init.
stock tsb_register()
{
	g_tsb_cvar = register_cvar("tsm_bot_objectives", "1");
}

/// Whether the bots play the objectives (tsm_bot_objectives is not 0).
stock bool:tsb_bots_play()
{
	if (!g_tsb_cvar)
	{
		g_tsb_cvar = register_cvar("tsm_bot_objectives", "1");
	}
	return (get_pcvar_num(g_tsb_cvar) != 0) ? true : false;
}

/// The fields on a capture point's or a zone's ring, as the bots read them. progress is a point's -1 to +1 (side 1 holds it in full at
/// +1, side 2 at -1) or a zone's 0 to 1 (the carrier's hold, a share of tsm_cap_time); reach is how far above or below the ring's floor a
/// player still counts as in it; side1 and side2 are how many players of each side stand in it.
stock tsb_ring(ent, phase, taker, Float:progress, Float:reach, side1, side2)
{
	if (ent <= 0 || !pev_valid(ent))
	{
		return;
	}
	new Float:inside[3];
	inside[0] = float(side1);
	inside[1] = float(side2);
	set_pev(ent, pev_iuser2, phase);
	set_pev(ent, pev_iuser3, taker);
	set_pev(ent, pev_fuser2, progress);
	set_pev(ent, pev_fuser3, reach);
	set_pev(ent, pev_vuser1, inside);
}
