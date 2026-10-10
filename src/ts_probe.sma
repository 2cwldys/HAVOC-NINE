/*
 * ts_probe.sma -- throwaway diagnostic for The Specialists 3.0.
 *
 * Answers the four questions that decide how a round-based match mode has to be
 * built on a mod that has no rounds. None of them can be answered from
 * documentation, so they get measured on the live server instead of guessed:
 *
 *   1. Does get_user_team() return a usable team number under mp_teamplay 1?
 *   2. Does TS auto-respawn on death, or wait for a button press?
 *   3. Does HL1 observer mode (pev_iuser1/2) stick, or does TS reset it?
 *   4. Are the hamsandwich and tsx modules actually loaded for this mod?
 *   5. Does TS already enforce mp_teammodels per team on its own?
 *   6. Does forcing a player's "model" userinfo key stick, or does TS override it?
 *
 * 5 and 6 decide whether per-team model restriction is a cvar change or needs
 * enforcement code. mp_teammodels appears to use '|' between teams and ';' between
 * the models a team may use, so "seal|gordon" would already restrict two teams --
 * IF the mod enforces it. That is what Q5 measures.
 *
 * Deliberately depends on NOTHING but amxmodx and fakemeta. In particular it does
 * not #include <hamsandwich> or <tsx>: if either module is unavailable for TS, a
 * plugin that includes it fails to LOAD, and a diagnostic that cannot load tells
 * you nothing. Module presence is reported by walking the module list instead.
 *
 * Passive by default. The only thing that touches a player is ts_probe_obs, which
 * is an explicit admin command, so merely loading this plugin cannot affect play.
 *
 * Delete once it has answered.
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>

#define PLUGIN  "TS Probe"
#define VERSION "1.0"
#define AUTHOR  "diagnostic"

#define LOGFILE "ts_probe.log"

// Frame counter, so "how long until respawn" can be answered in frames rather
// than in wall-clock time (which would hide a same-frame respawn).
new g_frame = 0;

new g_death_frame[33];     // frame the player died on, 0 = not pending
new g_death_alive[33];     // were they still flagged alive at death time
new bool:g_watching[33];   // waiting to see them come back alive

// Observer-stick test state: the frame we wrote the observer vars on, so the
// next frames can report whether the mod clobbered them.
new g_obs_frame[33];
new bool:g_obs_testing[33];
new g_obs_wrote_iuser1[33];
new g_obs_wrote_iuser2[33];

// Model-stick test state: the model we forced, so later frames can report whether
// the mod reverted it.
new g_model_frame[33];
new bool:g_model_testing[33];
new g_model_wanted[33][32];

/*
 * Saved player state, so the full dead-player treatment can be UNDONE. Without
 * this a test leaves you stuck in free-roam with no way back into the round short
 * of reconnecting.
 *
 * Own constant names rather than SOLID_NOT / MOVETYPE_NOCLIP / EF_NODRAW, because
 * those may already be defined by the fakemeta includes and this compiler is strict
 * about redefinition.
 */
#define PROBE_SOLID_NOT        0
#define PROBE_MOVETYPE_NOCLIP  8
#define PROBE_EF_NODRAW        128
#define PROBE_OBS_CHASE_FREE   2

// True while the full dead treatment is applied, so PlayerPreThink knows whose
// input to swallow. Being immune and non-solid does NOT stop a player attacking --
// that needs the buttons cleared before the game DLL ever sees them.
new bool:g_dead_state[33];
new g_last_buttons[33];   // edge detection, so the disarm log is not per-frame spam

new bool:g_saved[33];
new g_save_iuser1[33];
new g_save_iuser2[33];
new g_save_solid[33];
new g_save_movetype[33];
new g_save_effects[33];
new Float:g_save_takedamage[33];
new g_save_teamnum[33];
new g_save_teamname[33][32];

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	// Generic HL1 death message. Present in every mod; whether TS actually emits
	// it (and with what arguments) is one of the things being measured.
	register_event("DeathMsg", "ev_death", "a");

	register_forward(FM_StartFrame, "fw_startframe");

	// Per-player, immediately before the game DLL processes movement and weapons.
	// This is the only place input can be swallowed early enough to disarm a
	// player without touching their weapons at all.
	register_forward(FM_PlayerPreThink, "fw_prethink");

	// THE disarm hook. GoldSrc latches buttons from the client usercmd in CmdStart,
	// which runs BEFORE PlayerPreThink, and the weapon code reads that latched copy
	// -- which is why clearing pev_button in PreThink did nothing. Editing the
	// usercmd here is the only point early enough to actually disarm a player.
	register_forward(FM_CmdStart, "fw_cmdstart");

	register_concmd("ts_probe_info",  "cmd_info",  ADMIN_CFG, " - dumps static facts: modules, cvars, amxx version");
	register_concmd("ts_probe_teams", "cmd_teams", ADMIN_CFG, " - dumps every connected player's team number and name");
	register_concmd("ts_probe_obs",   "cmd_obs",   ADMIN_CFG, " <target> - tests whether observer vars stick on <target>");
	register_concmd("ts_probe_model", "cmd_model", ADMIN_CFG, " <target> <model> - tests whether a forced model sticks");
	register_concmd("ts_probe_dead",  "cmd_dead",  ADMIN_CFG, " <target> - FULL dead treatment: observer + hidden + non-solid + immune");
	register_concmd("ts_probe_undead","cmd_undead",ADMIN_CFG, " <target> - undoes ts_probe_dead / ts_probe_obs");
	register_concmd("ts_probe_team",  "cmd_team",  ADMIN_CFG, " <target> <team> - tries every team-set mechanism and reports which works");
	register_concmd("ts_probe_help",  "cmd_help",  ADMIN_CFG, " - lists the probe commands");

	plog("==================================================");
	plog("TS Probe loaded. Run ts_probe_info first.");
	plog("==================================================");
}

/* ------------------------------------------------------------------------- */
/* logging -- everything goes to console AND a file, so it can be pasted back */
/* ------------------------------------------------------------------------- */

plog(const fmt[], any:...)
{
	new msg[512];
	vformat(msg, charsmax(msg), fmt, 2);
	server_print("[TS-PROBE] %s", msg);
	log_to_file(LOGFILE, "%s", msg);
}

/* ------------------------------------------------------------------------- */
/* Q4 -- which modules are actually loaded                                    */
/* ------------------------------------------------------------------------- */

public cmd_info(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
		return PLUGIN_HANDLED;

	plog("---------- ts_probe_info ----------");

	new ver[64];
	get_amxx_verstring(ver, charsmax(ver));
	plog("AMXX version    : %s", ver);

	// Q4: module presence, without depending on any of them.
	new count = get_modulesnum();
	plog("Modules loaded  : %d", count);

	new name[32], author[32], mver[32], status;
	new bool:has_ham = false, bool:has_tsx = false, bool:has_fm = false;

	for (new i = 0; i < count; i++)
	{
		get_module(i, name, charsmax(name), author, charsmax(author), mver, charsmax(mver), status);
		plog("  [%d] %-16s v%-10s (status %d)", i, name, mver, status);

		if (equali(name, "hamsandwich")) has_ham = true;
		if (equali(name, "tsx"))         has_tsx = true;
		if (equali(name, "fakemeta"))    has_fm  = true;
	}

	plog("");
	plog("ANSWER Q4: hamsandwich = %s | tsx = %s | fakemeta = %s",
		has_ham ? "LOADED" : "MISSING",
		has_tsx ? "LOADED" : "MISSING",
		has_fm  ? "LOADED" : "MISSING");
	if (!has_ham)
		plog("  -> hamsandwich unavailable, so the match engine MUST be fakemeta-based.");
	if (!has_fm)
		plog("  -> fakemeta MISSING. Nothing in the plan works without it; fix this first.");

	// Team-related cvars. mp_teamplay must be 1 for teams to mean anything.
	plog("");
	dump_cvar("mp_teamplay");
	dump_cvar("mp_teamlist");
	dump_cvar("mp_teammodels");
	dump_cvar("mp_friendlyfire");
	dump_cvar("mp_timelimit");
	dump_cvar("sv_maxspeed");

	plog("");
	plog("Max players     : %d", get_maxplayers());
	plog("-----------------------------------");
	plog("Next: put players on both teams and run ts_probe_teams.");

	return PLUGIN_HANDLED;
}

dump_cvar(const cvar[])
{
	if (!cvar_exists(cvar))
	{
		plog("cvar %-16s : <does not exist>", cvar);
		return;
	}
	new val[128];
	get_cvar_string(cvar, val, charsmax(val));
	plog("cvar %-16s : '%s'", cvar, val);
}

/* ------------------------------------------------------------------------- */
/* Q1 -- does get_user_team() mean anything in TS                             */
/* ------------------------------------------------------------------------- */

public cmd_teams(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
		return PLUGIN_HANDLED;

	plog("---------- ts_probe_teams ----------");

	new tp = cvar_exists("mp_teamplay") ? get_cvar_num("mp_teamplay") : -1;
	plog("mp_teamplay = %d%s", tp, tp == 1 ? "" : "   <-- teams will likely be meaningless unless this is 1");

	new players[32], pnum;
	get_players(players, pnum, "c");   // "c" = skip bots? ("c" excludes bots)

	if (!pnum)
	{
		plog("No players connected -- connect at least one per team and re-run.");
		plog("------------------------------------");
		return PLUGIN_HANDLED;
	}

	new pid, pname[32], tname[32], pmodel[32], tnum;
	new teamcount[8];

	for (new i = 0; i < pnum; i++)
	{
		pid = players[i];
		get_user_name(pid, pname, charsmax(pname));

		tname[0] = 0;
		tnum = get_user_team(pid, tname, charsmax(tname));

		// Q5: the model each player is actually wearing, next to their team. If
		// mp_teammodels is being enforced, these will only ever be models that
		// cvar permits for that team.
		pmodel[0] = 0;
		get_user_info(pid, "model", pmodel, charsmax(pmodel));

		plog("  %-24s team# = %-3d  team = '%s'  model = '%s'  alive = %d",
			pname, tnum, tname, pmodel, is_user_alive(pid) ? 1 : 0);

		if (tnum >= 0 && tnum < sizeof(teamcount))
			teamcount[tnum]++;
	}

	plog("");
	plog("Team tallies by index:");
	for (new t = 0; t < sizeof(teamcount); t++)
		if (teamcount[t])
			plog("  index %d -> %d player(s)", t, teamcount[t]);

	plog("");
	plog("ANSWER Q1: if the indices above are stable non-zero values that match");
	plog("  who is on which team, get_user_team() is usable and team handling is free.");
	plog("  If everything reads 0 or the same value, the match mode has to track");
	plog("  teams itself.");
	plog("");
	plog("ANSWER Q5: compare each model above against mp_teammodels (ts_probe_info).");
	plog("  If every player's model is one their team is permitted, TS enforces the");
	plog("  cvar and per-team models are a CONFIG change, not code. If anyone is");
	plog("  wearing a model their team should not have, enforcement code is needed --");
	plog("  test that with ts_probe_model.");
	plog("------------------------------------");

	return PLUGIN_HANDLED;
}

/* ------------------------------------------------------------------------- */
/* Q2 -- auto-respawn or button press                                         */
/* ------------------------------------------------------------------------- */

public ev_death()
{
	// Args 1 and 2 are killer and victim in every HL1 mod that emits DeathMsg.
	// Anything past that varies per mod, so the count is reported rather than
	// assumed -- that alone tells us the layout to use later.
	new argc   = read_datanum();
	new killer = read_data(1);
	new victim = read_data(2);

	plog("DeathMsg fired: argc=%d killer=%d victim=%d (frame %d)", argc, killer, victim, g_frame);

	if (victim < 1 || victim > 32)
	{
		plog("  victim index %d out of range -- DeathMsg layout is NOT the standard one.", victim);
		return;
	}

	new vname[32];
	if (is_user_connected(victim))
		get_user_name(victim, vname, charsmax(vname));
	else
		copy(vname, charsmax(vname), "<not connected>");

	g_death_frame[victim] = g_frame;
	g_death_alive[victim] = is_user_alive(victim) ? 1 : 0;
	g_watching[victim]    = true;

	plog("  victim '%s': is_user_alive() at DeathMsg time = %d", vname, g_death_alive[victim]);
	plog("  now counting frames until they are alive again...");
}

/*
 * Swallows a dead player's input AT THE USERCMD LEVEL.
 *
 * This is the hook that actually works. pev_button in PlayerPreThink is too late:
 * CmdStart runs first and the mod's weapon code reads the buttons latched there.
 * Clearing them here means the mod never sees the input at all, so the player is
 * disarmed without their weapons being touched -- which is what keeps this
 * mod-agnostic.
 *
 * Buttons are READ before being cleared, so the same hook that strips intent is
 * where spectator-cycling intent gets picked up. The real plugin uses the attack
 * edge here to change who you are following.
 */
public fw_cmdstart(id, uc_handle, seed)
{
	if (!g_dead_state[id])
		return FMRES_IGNORED;

	new buttons = get_uc(uc_handle, UC_Buttons);
	if (buttons)
	{
		// Logged once per press rather than per frame, so the console stays usable.
		if (!g_last_buttons[id])
			plog("CMDSTART: swallowed buttons=%d from player %d (this is the disarm working)", buttons, id);
	}
	g_last_buttons[id] = buttons;

	set_uc(uc_handle, UC_Buttons, 0);
	set_uc(uc_handle, UC_Impulse, 0);

	return FMRES_IGNORED;
}

/*
 * Swallows a dead player's input. pev_button is cleared before the mod reads it, so
 * attack / jump / use do nothing -- without ever touching their weapons, which keeps
 * this mod-agnostic.
 *
 * Observer movement is driven by the client's move commands rather than by buttons,
 * so flying around still works: only the action keys die.
 */
public fw_prethink(id)
{
	if (!g_dead_state[id])
		return FMRES_IGNORED;

	if (!is_user_connected(id))
	{
		g_dead_state[id] = false;
		return FMRES_IGNORED;
	}

	set_pev(id, pev_button, 0);
	set_pev(id, pev_oldbuttons, 0);
	set_pev(id, pev_impulse, 0);

	return FMRES_IGNORED;
}

public fw_startframe()
{
	g_frame++;

	// Q2: watch for a dead player becoming alive again, and report how long it
	// took and whether they were holding a button when it happened.
	for (new id = 1; id <= 32; id++)
	{
		if (g_watching[id])
		{
			if (!is_user_connected(id))
			{
				g_watching[id] = false;
				continue;
			}
			if (is_user_alive(id))
			{
				new delta   = g_frame - g_death_frame[id];
				new buttons = pev(id, pev_button);
				new oldbtn  = pev(id, pev_oldbuttons);

				plog("RESPAWN: player %d alive again after %d frame(s). button=%d oldbuttons=%d", id, delta, buttons, oldbtn);
				if (delta <= 2)
				{
					plog("  ANSWER Q2: effectively IMMEDIATE auto-respawn. Respawn cannot be waited out;");
					plog("    the match mode must neutralise the player AFTER respawn (as planned).");
				}
				else if (buttons || oldbtn)
				{
					plog("  ANSWER Q2: respawned while holding a button -> likely BUTTON-TRIGGERED respawn,");
					plog("    which means blocking the button may be enough to hold players dead.");
				}
				else
				{
					plog("  ANSWER Q2: delayed auto-respawn (%d frames) with no button held.", delta);
				}

				g_watching[id] = false;
			}
		}

		// Observer-stick follow-up, reported for a few frames after the write.
		if (g_obs_testing[id])
		{
			new since = g_frame - g_obs_frame[id];
			if (since == 1 || since == 5 || since == 20)
			{
				new iu1 = pev(id, pev_iuser1);
				new iu2 = pev(id, pev_iuser2);
				plog("OBS +%2d frames: iuser1=%d (wrote %d) iuser2=%d (wrote %d) solid=%d effects=%d",
					since, iu1, g_obs_wrote_iuser1[id], iu2, g_obs_wrote_iuser2[id],
					pev(id, pev_solid), pev(id, pev_effects));

				if (since == 20)
				{
					if (iu1 == g_obs_wrote_iuser1[id])
						plog("  ANSWER Q3: observer vars STUCK -> native spectating is viable.");
					else
						plog("  ANSWER Q3: observer vars were RESET by the mod -> use the attached-camera fallback.");
					g_obs_testing[id] = false;
				}
			}
		}

		// Q6: model-stick follow-up. Checked over a longer window than the
		// observer test, because a mod is most likely to re-apply a model on the
		// next SPAWN rather than on the next frame -- so this has to outlive a
		// death and respawn to be meaningful.
		if (g_model_testing[id])
		{
			new msince = g_frame - g_model_frame[id];
			if (msince == 1 || msince == 30 || msince == 300)
			{
				new cur[32];
				cur[0] = 0;
				if (is_user_connected(id))
					get_user_info(id, "model", cur, charsmax(cur));

				plog("MODEL +%3d frames: model = '%s' (forced '%s')%s",
					msince, cur, g_model_wanted[id],
					equal(cur, g_model_wanted[id]) ? "  [holding]" : "  [REVERTED]");

				if (msince == 300)
				{
					if (equal(cur, g_model_wanted[id]))
					{
						plog("  ANSWER Q6: the forced model HELD for 300 frames -> forcing via");
						plog("    SetClientKeyValue works, so per-team models can be enforced in code.");
						plog("    Die and respawn, then re-run ts_probe_model, to confirm it also");
						plog("    survives a respawn (that is when a mod usually re-applies models).");
					}
					else
					{
						plog("  ANSWER Q6: the mod REVERTED the forced model -> SetClientKeyValue alone");
						plog("    is not enough. Enforcement will need to re-apply on");
						plog("    ClientUserInfoChanged and on spawn, or rely on mp_teammodels instead.");
					}
					g_model_testing[id] = false;
				}
			}
		}
	}
}

/* ------------------------------------------------------------------------- */
/* Q3 -- does observer mode stick                                             */
/* ------------------------------------------------------------------------- */

public cmd_obs(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
		return PLUGIN_HANDLED;

	new arg[32];
	read_argv(1, arg, charsmax(arg));

	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[TS-PROBE] No such player.");
		return PLUGIN_HANDLED;
	}

	// Find a living player other than the target to follow, so iuser2 points at
	// something real -- pointing it at nothing could be rejected for its own
	// reasons and would muddy the result.
	new follow = 0;
	new players[32], pnum;
	get_players(players, pnum, "a");   // "a" = alive only
	for (new i = 0; i < pnum; i++)
	{
		if (players[i] != target)
		{
			follow = players[i];
			break;
		}
	}

	new tname[32];
	get_user_name(target, tname, charsmax(tname));

	plog("---------- ts_probe_obs ----------");
	plog("Target: '%s' (index %d), follow target index %d", tname, target, follow);
	// pev() returns an untagged cell, so reading a FLOAT entvar needs an explicit
	// Float: tag override -- without it the assignment is a tag mismatch.
	new Float:td_before = Float:pev(target, pev_takedamage);
	plog("BEFORE: iuser1=%d iuser2=%d solid=%d movetype=%d effects=%d takedamage=%f",
		pev(target, pev_iuser1), pev(target, pev_iuser2),
		pev(target, pev_solid), pev(target, pev_movetype),
		pev(target, pev_effects), td_before);

	// 2 == chase-free in the standard HL1 observer modes.
	g_obs_wrote_iuser1[target] = 2;
	g_obs_wrote_iuser2[target] = follow;

	set_pev(target, pev_iuser1, g_obs_wrote_iuser1[target]);
	set_pev(target, pev_iuser2, g_obs_wrote_iuser2[target]);

	g_obs_frame[target]   = g_frame;
	g_obs_testing[target] = true;

	plog("WROTE : iuser1=%d iuser2=%d -- watching for 20 frames to see if it holds.",
		g_obs_wrote_iuser1[target], g_obs_wrote_iuser2[target]);
	console_print(id, "[TS-PROBE] Observer test started on %s. Watch the server console / %s.", tname, LOGFILE);

	return PLUGIN_HANDLED;
}

/* ------------------------------------------------------------------------- */
/* The full dead-player treatment, and its undo                               */
/*                                                                            */
/* This is a live prototype of what the match mode will do to an eliminated    */
/* player: observer camera AND a hidden, non-solid, immune body. ts_probe_obs  */
/* only wrote the camera vars, which is why your model stayed visible.         */
/* ------------------------------------------------------------------------- */

probe_save_state(target)
{
	if (g_saved[target])
		return;   // already saved; do not overwrite with the modified values

	g_save_iuser1[target]     = pev(target, pev_iuser1);
	g_save_iuser2[target]     = pev(target, pev_iuser2);
	g_save_solid[target]      = pev(target, pev_solid);
	g_save_movetype[target]   = pev(target, pev_movetype);
	g_save_effects[target]    = pev(target, pev_effects);
	g_save_takedamage[target] = Float:pev(target, pev_takedamage);

	// Team too. Observer mode makes TS reassign the player to spectator, so without
	// this a test leaves you on the wrong team with nothing recorded to go back to.
	g_save_teamname[target][0] = 0;
	g_save_teamnum[target] = get_user_team(target, g_save_teamname[target], charsmax(g_save_teamname[]));

	g_saved[target]           = true;
}

probe_restore_state(target)
{
	if (!g_saved[target])
		return 0;

	set_pev(target, pev_iuser1,     g_save_iuser1[target]);
	set_pev(target, pev_iuser2,     g_save_iuser2[target]);
	set_pev(target, pev_solid,      g_save_solid[target]);
	set_pev(target, pev_movetype,   g_save_movetype[target]);
	set_pev(target, pev_effects,    g_save_effects[target]);
	set_pev(target, pev_takedamage, g_save_takedamage[target]);

	// Best effort: which mechanism actually works is still unknown, so all of them
	// are attempted. ts_probe_team is what identifies the real one.
	probe_set_team(target, 1, g_save_teamnum[target], g_save_teamname[target]);
	probe_set_team(target, 2, g_save_teamnum[target], g_save_teamname[target]);

	g_saved[target] = false;
	return 1;
}

public cmd_dead(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
		return PLUGIN_HANDLED;

	new arg[32];
	read_argv(1, arg, charsmax(arg));

	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[TS-PROBE] No such player.");
		return PLUGIN_HANDLED;
	}

	// Someone living to follow, preferring anyone other than the target.
	new follow = 0;
	new players[32], pnum;
	get_players(players, pnum, "a");
	for (new i = 0; i < pnum; i++)
	{
		if (players[i] != target)
		{
			follow = players[i];
			break;
		}
	}

	new tname[32];
	get_user_name(target, tname, charsmax(tname));

	probe_save_state(target);

	plog("---------- ts_probe_dead ----------");
	plog("Target '%s' (index %d). Follow target index %d%s",
		tname, target, follow, follow ? "" : "  <-- nobody else alive, so free-roam only");

	set_pev(target, pev_solid,      PROBE_SOLID_NOT);
	set_pev(target, pev_movetype,   PROBE_MOVETYPE_NOCLIP);
	set_pev(target, pev_effects,    g_save_effects[target] | PROBE_EF_NODRAW);
	set_pev(target, pev_takedamage, 0.0);
	set_pev(target, pev_iuser1,     PROBE_OBS_CHASE_FREE);
	set_pev(target, pev_iuser2,     follow);

	g_dead_state[target] = true;   // fw_prethink now swallows their input

	plog("APPLIED: solid=0 movetype=8 effects|=128(NODRAW) takedamage=0.0 iuser1=2 iuser2=%d", follow);
	plog("         plus input swallowed every frame (attack/jump/use disabled).");
	plog("This is what an eliminated player will look like. Check that:");
	plog("  - your own body is now INVISIBLE to others");
	plog("  - you cannot be shot and cannot shoot anyone");
	plog("  - you can see the arena (and follow a teammate, if one is alive)");
	plog("Run ts_probe_undead to get back in. Prior state was saved.");

	console_print(id, "[TS-PROBE] Full dead treatment applied to %s. Use ts_probe_undead %s to revert.", tname, tname);
	return PLUGIN_HANDLED;
}

public cmd_undead(id, level, cid)
{
	if (!cmd_access(id, level, cid, 2))
		return PLUGIN_HANDLED;

	new arg[32];
	read_argv(1, arg, charsmax(arg));

	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[TS-PROBE] No such player.");
		return PLUGIN_HANDLED;
	}

	new tname[32];
	get_user_name(target, tname, charsmax(tname));

	g_dead_state[target] = false;   // give them their input back first

	if (probe_restore_state(target))
	{
		plog("ts_probe_undead: restored '%s' to their pre-test state.", tname);
		console_print(id, "[TS-PROBE] %s restored.", tname);
	}
	else
	{
		// No saved state: still clear the things a test could have set, so this is
		// never a dead end.
		set_pev(target, pev_iuser1,     0);
		set_pev(target, pev_iuser2,     0);
		set_pev(target, pev_solid,      2);    // SOLID_BBOX, the normal player value
		set_pev(target, pev_movetype,   3);    // MOVETYPE_WALK
		set_pev(target, pev_effects,    pev(target, pev_effects) & ~PROBE_EF_NODRAW);
		set_pev(target, pev_takedamage, 2.0);  // DAMAGE_AIM, the normal player value
		plog("ts_probe_undead: no saved state for '%s' -- applied sane defaults instead.", tname);
		console_print(id, "[TS-PROBE] No saved state for %s; applied normal player defaults.", tname);
		console_print(id, "[TS-PROBE] If anything still looks wrong, type retry to reconnect.");
	}

	g_obs_testing[target] = false;
	return PLUGIN_HANDLED;
}

/* ------------------------------------------------------------------------- */
/* Team setting -- which mechanism actually works                             */
/*                                                                            */
/* There is no generic AMXX native for this: cs_set_user_team is Counter-Strike */
/* only. So the candidates get tried and measured instead of assumed.          */
/*   1 = pev_team entvar                                                       */
/*   2 = the "team" userinfo key                                               */
/*   3 = a client command (a guess -- TS may not have one)                     */
/* ------------------------------------------------------------------------- */

probe_set_team(target, mech, teamnum, const teamname[])
{
	if (!is_user_connected(target))
		return;

	switch (mech)
	{
		case 1:
		{
			set_pev(target, pev_team, teamnum);
		}
		case 2:
		{
			if (teamname[0])
			{
				new buf = engfunc(EngFunc_GetInfoKeyBuffer, target);
				engfunc(EngFunc_SetClientKeyValue, target, buf, "team", teamname);
			}
		}
		case 3:
		{
			if (teamname[0])
			{
				client_cmd(target, "jointeam %s", teamname);
			}
		}
	}
}

public cmd_team(id, level, cid)
{
	if (!cmd_access(id, level, cid, 3))
		return PLUGIN_HANDLED;

	new arg[32], want[32];
	read_argv(1, arg, charsmax(arg));
	read_argv(2, want, charsmax(want));

	if (!want[0])
	{
		console_print(id, "[TS-PROBE] Usage: ts_probe_team <target> <teamname>");
		console_print(id, "[TS-PROBE] Use a team name from ts_probe_teams output, e.g. msr");
		return PLUGIN_HANDLED;
	}

	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[TS-PROBE] No such player.");
		return PLUGIN_HANDLED;
	}

	new tname[32], cur[32], curnum;
	get_user_name(target, tname, charsmax(tname));

	plog("---------- ts_probe_team ----------");
	cur[0] = 0;
	curnum = get_user_team(target, cur, charsmax(cur));
	plog("Target '%s' (index %d). BEFORE: team# %d name '%s'. Want '%s'.",
		tname, target, curnum, cur, want);
	plog("Trying each mechanism in turn. The first one that CHANGES the reading is the");
	plog("answer -- the later ones then just set the same value again, harmlessly.");

	// Mechanism 1 -- pev_team
	probe_set_team(target, 1, 1, want);
	cur[0] = 0;
	curnum = get_user_team(target, cur, charsmax(cur));
	plog("  [1] set_pev(pev_team)        -> team# %d name '%s'", curnum, cur);

	// Mechanism 2 -- userinfo key
	probe_set_team(target, 2, 1, want);
	cur[0] = 0;
	curnum = get_user_team(target, cur, charsmax(cur));
	plog("  [2] userinfo 'team' key      -> team# %d name '%s'", curnum, cur);

	// Mechanism 3 -- client command (a guess; may simply not exist in TS)
	probe_set_team(target, 3, 1, want);
	plog("  [3] client_cmd jointeam %s  -> issued; reading is deferred, see below", want);

	// The command is asynchronous, so the result is read a moment later.
	set_task(0.5, "task_team_report", target);

	console_print(id, "[TS-PROBE] Team test running on %s. Watch the console / %s.", tname, LOGFILE);
	return PLUGIN_HANDLED;
}

public task_team_report(target)
{
	if (!is_user_connected(target))
		return;

	new cur[32];
	cur[0] = 0;
	new curnum = get_user_team(target, cur, charsmax(cur));
	plog("  [3] after 0.5s               -> team# %d name '%s'", curnum, cur);
	plog("ANSWER: whichever line above first shows the wanted team is the mechanism");
	plog("  the match mode must use to put eliminated players back on their team at");
	plog("  round reset. If NONE of them changed it, native observer spectating is");
	plog("  unusable and the attached-camera approach is required instead.");
	plog("-----------------------------------");
}

/* ------------------------------------------------------------------------- */
/* Q6 -- does a forced model stick                                            */
/* ------------------------------------------------------------------------- */

public cmd_model(id, level, cid)
{
	if (!cmd_access(id, level, cid, 3))
		return PLUGIN_HANDLED;

	new arg[32], model[32];
	read_argv(1, arg, charsmax(arg));
	read_argv(2, model, charsmax(model));

	if (!model[0])
	{
		console_print(id, "[TS-PROBE] Usage: ts_probe_model <target> <model>");
		console_print(id, "[TS-PROBE] Models seen in mp_teammodels: seal, merc, gordon, laurence, agent, hitman, castor");
		return PLUGIN_HANDLED;
	}

	new target = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
	if (!target)
	{
		console_print(id, "[TS-PROBE] No such player.");
		return PLUGIN_HANDLED;
	}

	new tname[32], before[32], tteam[32];
	get_user_name(target, tname, charsmax(tname));
	get_user_info(target, "model", before, charsmax(before));
	new tnum = get_user_team(target, tteam, charsmax(tteam));

	// Forcing the model the player is ALREADY wearing proves nothing -- it cannot
	// revert, so the test would always report success. Refuse it outright.
	if (equal(model, before))
	{
		console_print(id, "[TS-PROBE] INVALID TEST: '%s' is already their model. Pick a different one.", model);
		new tm[128], tl[128];
		tm[0] = 0; tl[0] = 0;
		if (cvar_exists("mp_teammodels")) get_cvar_string("mp_teammodels", tm, charsmax(tm));
		if (cvar_exists("mp_teamlist"))   get_cvar_string("mp_teamlist",   tl, charsmax(tl));
		console_print(id, "[TS-PROBE] mp_teamlist   = %s", tl);
		console_print(id, "[TS-PROBE] mp_teammodels = %s", tm);
		console_print(id, "[TS-PROBE] Pick a model from mp_teammodels that is NOT '%s'.", before);
		plog("ts_probe_model REFUSED: '%s' already equals the target's current model.", model);
		return PLUGIN_HANDLED;
	}

	plog("---------- ts_probe_model ----------");
	plog("Target '%s' (index %d), team# %d '%s'", tname, target, tnum, tteam);
	plog("BEFORE: model = '%s'", before);
	plog("FORCING model = '%s'", model);

	// The standard AMXX forced-model idiom: rewrite the client's "model" key in
	// its own info buffer. Engine-level, so it does not depend on TS exposing
	// anything -- which is exactly why it is worth testing here.
	new infobuffer = engfunc(EngFunc_GetInfoKeyBuffer, target);
	engfunc(EngFunc_SetClientKeyValue, target, infobuffer, "model", model);

	copy(g_model_wanted[target], charsmax(g_model_wanted[]), model);
	g_model_frame[target]   = g_frame;
	g_model_testing[target] = true;

	plog("Watching for 300 frames. Die and respawn during that window -- a mod that");
	plog("re-applies models usually does it on spawn, not on the next frame.");
	console_print(id, "[TS-PROBE] Model test started on %s. Watch the console / %s.", tname, LOGFILE);

	return PLUGIN_HANDLED;
}

/* ------------------------------------------------------------------------- */

public cmd_help(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
		return PLUGIN_HANDLED;

	console_print(id, "[TS-PROBE] commands:");
	console_print(id, "  ts_probe_info          - modules, cvars, amxx version  (run this first)");
	console_print(id, "  ts_probe_teams         - every player's team number    (needs players on both teams)");
	console_print(id, "  ts_probe_obs <target>  - observer-mode stick test      (changes that player briefly)");
	console_print(id, "  ts_probe_model <t> <m> - forced-model stick test       (changes that player's model)");
	console_print(id, "  ts_probe_dead <target> - FULL dead treatment: hidden, non-solid, immune, disarmed");
	console_print(id, "  ts_probe_undead <t>    - undo the above (also fixes ts_probe_obs)");
	console_print(id, "  ts_probe_team <t> <tm> - finds which team-set mechanism works");
	console_print(id, "Death/respawn data is collected automatically -- just die once.");
	console_print(id, "Everything is logged to amxmodx/logs/%s", LOGFILE);
	return PLUGIN_HANDLED;
}

public client_disconnected(id)
{
	// Guarded against a stale index continuing to be polled every frame.
	if (id >= 1 && id <= 32)
	{
		g_watching[id]      = false;
		g_obs_testing[id]   = false;
		g_model_testing[id] = false;
		g_dead_state[id]    = false;
		g_saved[id]         = false;
		g_last_buttons[id]  = 0;
		g_death_frame[id]   = 0;
	}
}
