#include "hookmod.h"
#include <customentity.h>
#include <string.h>

// HookMod -- the fire/deploy path. pfnClientCommand dispatch, the big +hook/-hook/hook_login
// handler (FireHookCmd), the grapple-tip collision/attach handler driven as the tip think
// (GrappleTipThink/GrappleTipAttach), the rope CBeam build, and the rope color.
//
// g_hook[] lives in hook.cpp; this TU uses the extern from hookmod.h. Entity fields are written by
// SDK name; the grapple tip is a real "info_target" server entity and the rope is a real CBeam
// entity built through beam.cpp (BeamCreate / PointEntInit / EntsInit / RelinkBeam).

// The grapple tip's private classname (overwrites the spawned "info_target" classname so the attach
// handler can recognize its own tip). Reconstructed name -- only consistency between set and compare
// matters, and it must not collide with a real map entity classname.
static const char HOOK_TIP_CLASSNAME[] = "hook_tip";

#ifndef SVC_TEMP_ENTITY
#define SVC_TEMP_ENTITY 23
#endif

// ---- small helpers -------------------------------------------------------------------------------

// Original validity gate: edict live (pfnEntOffsetOfPEntity nonzero) + FUN_10013170 (not freed,
// not FL_KILLME). Folded into one predicate here.
static bool EntValid(edict_t *e)   // FUN_10013170 @0x10013170
{
	return e != NULL && !e->free && (e->v.flags & FL_KILLME) == 0;
}

// FUN_10011f90 @0x10011f90: a live, in-play player (deadflag clear, health > 0).
static bool PlayerAlive(edict_t *p)
{
	return p->v.deadflag == 0 && p->v.health > 0.0f;
}

// FUN_10013120 @0x10013120: single-client TextMsg print. dest is a HUD_PRINT* destination
// (1 console/notify, 4 center). The engine "TextMsg" id is cached on first use.
static int g_TextMsgId = 0;
static void ClientPrintHook(edict_t *player, int dest, const char *text)
{
	if (g_TextMsgId == 0)
		g_TextMsgId = REG_USER_MSG("TextMsg", -1);
	MESSAGE_BEGIN(MSG_ONE, g_TextMsgId, NULL, player);
	WRITE_BYTE(dest);
	WRITE_STRING(text);
	MESSAGE_END();
}

// The rope color enum (DF_hook_color 1..5) to a fixed RGB, per the FireHookCmd color table.
// Denormal constants in the decompile: 1,2,3,4,5 -> blue, red, yellow, green, white.
static Vector ColorIndexToRGB(int idx)
{
	switch (idx)
	{
		case 1:  return Vector(0,   0,   255);   // blue
		case 2:  return Vector(255, 0,   0);     // red
		case 3:  return Vector(255, 255, 0);     // yellow
		case 4:  return Vector(0,   255, 0);     // green
		default: return Vector(255, 255, 255);   // 5 (and any other) -> white
	}
}

// Reconstructed team-color index for DF_hook_showspy. The shipped FUN_10013560 read the player's
// "model" infokey and matched a long cstrike/firearms model table, falling back to pev->team; this
// uses pev->team directly (clamped into the 1..5 rope palette). Approximate -- see deviations.
static int HookTeamColorIndex(edict_t *player)
{
	int team = player->v.team;
	if (team >= 1 && team <= 5)
		return team;
	return 1;
}

// HookRopeColor @0x10013560 (+ the FireHookCmd color table): the rope RGB. Team color when
// DF_hook_showspy is on, otherwise the DF_hook_color enum (0 falls back to white, as FireHookCmd did).
Vector HookRopeColor(edict_t *player)   // HookRopeColor @0x10013560
{
	int idx;
	if (DF_hook_showspy.value != 0.0f)
		idx = HookTeamColorIndex(player);
	else
		idx = (int)DF_hook_color.value;

	if (idx == 0)
		idx = 5;   // DF_hook_color 0 -> white

	return ColorIndexToRGB(idx);
}

// ---- rope beam -----------------------------------------------------------------------------------

// Build the rope CBeam between the player and either the grapple tip (projectile / normal instant,
// BEAM_ENTS) or a fixed world anchor point (sky attach, BEAM_ENTPOINT). Mirrors FUN_1000e7d0 +
// FUN_1000e9b0 / FUN_1000ea20 and the shared beam-field tail of FireHookCmd.
static edict_t *BuildRopeBeam(edict_t *player, edict_t *tip, const Vector &anchorPoint, bool pointBeam)
{
	int w = (int)DF_hook_width.value;
	edict_t *beam = BeamCreate("sprites/laserbeam.spr", w);   // FUN_1000e7d0
	if (beam == NULL)
		return NULL;

	entvars_t *bpev = &beam->v;

	if (pointBeam)
	{
		PointEntInit(anchorPoint, ENTINDEX(player), bpev);        // FUN_1000e9b0
		if (DF_hook_weapon.value != 0.0f)
			bpev->skin = (bpev->skin & 0x0FFF) | 0x1000;          // DF_hook_weapon render flag
	}
	else
	{
		EntsInit(ENTINDEX(player), ENTINDEX(tip), bpev);          // FUN_1000ea20
		if (DF_hook_weapon.value != 0.0f)
			bpev->sequence = (bpev->sequence & 0x0FFF) | 0x1000;  // DF_hook_weapon render flag
	}

	bpev->animtime = 2.0f;                      // scroll rate
	bpev->renderamt = 128.0f;                   // brightness
	bpev->frame = 1.0f;
	bpev->spawnflags |= 0x8000;                 // SF_BEAM_TEMPORARY
	bpev->owner = player;
	bpev->rendercolor = HookRopeColor(player);
	bpev->body = (int)DF_hook_noise.value;      // beam noise
	return beam;
}

// ---- attach --------------------------------------------------------------------------------------

// Swing rope setup (DF_hook_swing): record the rope rest length and swap the player onto near-zero
// gravity for the pendulum. Lines 17034-17067 / 17140-17172 of the decompile.
static void SwingSetup(edict_t *player, edict_t *tip)
{
	(void)tip;
	int i = ENTINDEX(player);
	hookstate_t &hs = g_hook[i];
	edict_t *aEnt = hs.anchoredEnt;
	if (aEnt == NULL)
		return;

	Vector worldAnchor = aEnt->v.origin - hs.anchorPoint + hs.anchorOffset;
	Vector d = player->v.origin - worldAnchor;
	hs.ropeRestLen = d.Length();
	hs.savedGravityFlag = 1;
	hs.savedGravity = player->v.gravity;
	hs.swingReelCooldown = gpGlobals->time + 0.1f;
	player->v.gravity = 1.0e-4f;   // 0x38d1b717
}

// Retract everything for the firing player's slot (instant-miss mini-retract inside the attach).
static void AttachRetract(hookstate_t &hs, edict_t *tip)
{
	if (hs.beamEnt != NULL && EntValid(hs.beamEnt))
	{
		hs.beamEnt->v.flags |= FL_KILLME;
		hs.beamEnt = NULL;
	}
	hs.hookstate = 0;
	tip->v.flags |= FL_KILLME;
	hs.tipEnt = NULL;
	hs.lastHookTime = gpGlobals->time;
	hs.holdExpiry = gpGlobals->time;
	hs.usekeyEdge = 0;
}

// The grapple-tip attach handler. Called with the entity the tip struck and the tip itself. Sets the
// firing player's slot to attached (hookstate 2), records the anchor, and plays the hit feedback.
// Decompiled FUN_10010900 @0x10010900 (the shipped signature was (pHit, pTip); hookmod.h declares
// GrappleTipThink(tip), so the body lives here and GrappleTipThink / FireHookCmd both route to it).
static void GrappleTipAttach(edict_t *pHit, edict_t *tip)   // GrappleTipAttach @0x10010900
{
	entvars_t *tpev = &tip->v;

	// this must be one of our hook tips, with a valid firing player
	if (strncmp(STRING(tpev->classname), HOOK_TIP_CLASSNAME, 8) != 0)
		return;
	edict_t *player = tpev->euser1;
	if (player == NULL || !EntValid(player))
		return;

	// never grab triggers; the struck entity must be solid (SOLID_BBOX or better)
	if (pHit == NULL)
		return;
	if (strncmp(STRING(pHit->v.classname), "trigger_", 8) == 0)
		return;
	if (pHit->v.solid <= 1)
		return;

	int pidx = ENTINDEX(player);
	hookstate_t &hs = g_hook[pidx];
	bool hitIsPlayer = (strncmp(STRING(pHit->v.classname), "player", 7) == 0);

	if (hitIsPlayer)
	{
		if (pHit == player)
			return;

		// hitbody sound, with a short per-slot cooldown (the int _pad0c carries the float stamp)
		float *bodyStamp = reinterpret_cast<float *>(&hs._pad0c);
		if (*bodyStamp <= gpGlobals->time)
		{
			*bodyStamp = gpGlobals->time + 0.5f;
			EMIT_SOUND_DYN2(pHit, CHAN_STATIC, "weapons/xbow_hitbod1.wav", 1.0f, 0.8f, 0, 100);
		}

		if (DF_hook_players.value != 0.0f)
		{
			tpev->velocity = Vector(0, 0, 0);
			tpev->solid = SOLID_NOT;
			tpev->movetype = MOVETYPE_NOCLIP;
			hs.anchoredEnt = pHit;
			hs.anchorPoint = pHit->v.origin;
			hs.holdExpiry = DF_hook_hold.value + gpGlobals->time;
			hs.anchorOffset = tpev->origin;
			hs.hookstate = 2;
		}

		if (DF_hook_swing.value != 0.0f)
			SwingSetup(player, tip);
		return;
	}

	// world / wall hit
	bool allow = true;
	if (DF_hook_sky.value == 0.0f && POINT_CONTENTS(tpev->origin) == CONTENTS_SKY)   // FUN_10011e40
		allow = false;
	if (DF_hook_onlywalls.value != 0.0f)
	{
		const char *hc = STRING(pHit->v.classname);
		if (strncmp(hc, "worldspawn", 11) != 0 && strncmp(hc, "func_wall", 10) != 0)
			allow = false;
	}

	if ((tpev->flags & FL_ONGROUND) == 0 && allow)
	{
		tpev->velocity = Vector(0, 0, 0);
		tpev->solid = SOLID_NOT;
		tpev->movetype = MOVETYPE_NOCLIP;
		hs.anchoredEnt = pHit;
		hs.anchorPoint = pHit->v.origin;
		hs.holdExpiry = DF_hook_hold.value + gpGlobals->time;
		hs.anchorOffset = tpev->origin;
		hs.hookstate = 2;

		if (DF_hook_sound.value != 0.0f)
		{
			EMIT_SOUND_DYN2(tip, CHAN_STATIC, "weapons/xbow_hit1.wav", 1.0f, 0.8f, 0, 100);
			MESSAGE_BEGIN(MSG_PVS, SVC_TEMP_ENTITY, tpev->origin);
			WRITE_BYTE(TE_SPARKS);
			WRITE_COORD(tpev->origin.x);
			WRITE_COORD(tpev->origin.y);
			WRITE_COORD(tpev->origin.z);
			MESSAGE_END();
		}

		if (DF_hook_swing.value != 0.0f)
			SwingSetup(player, tip);
	}
	else if (DF_hook_instant.value != 0.0f)
	{
		AttachRetract(hs, tip);
	}
}

// GrappleTipThink @0x10010900: advance the in-flight tip and, on collision (a forward trace along
// its velocity, or coming to rest on the ground), hand off to the attach handler. Per-frame driver
// for the hookmod.h one-argument prototype; the shipped build drove the attach from pfnStartFrame,
// so the trace-advance here is reconstructed (see deviations).
void GrappleTipThink(edict_t *tip)   // GrappleTipThink @0x10010900
{
	entvars_t *tpev = &tip->v;
	edict_t *player = tpev->euser1;
	if (player == NULL || !EntValid(player))
		return;

	Vector nextPos = tpev->origin + tpev->velocity * gpGlobals->frametime;
	TraceResult tr;
	TRACE_LINE(tpev->origin, nextPos, dont_ignore_monsters, tip, &tr);

	if (tr.flFraction < 1.0f && tr.pHit != NULL)
	{
		tpev->origin = tr.vecEndPos;
		GrappleTipAttach(tr.pHit, tip);
	}
	else if (tpev->flags & FL_ONGROUND)
	{
		edict_t *ground = tpev->groundentity ? tpev->groundentity : INDEXENT(0);
		GrappleTipAttach(ground, tip);
	}

	tpev->nextthink = gpGlobals->time + 0.01f;
}

// ---- fire / command ------------------------------------------------------------------------------

// FireHookCmd @0x1000ed40: parse +hook / -hook / hook_login and fire or retract. mode 0 = console
// command, 1 = usekey fire, 2 = usekey release. Returns 1 when handled, 0 when the command was not
// ours. 478 lines in the decompile.
int FireHookCmd(edict_t *player, int mode)   // FireHookCmd @0x1000ed40
{
	if (!H9HookActive())   // H9: HookMod is inert off entmaps unless `entmod 1`
		return 0;
	entvars_t *pev = &player->v;
	int idx = ENTINDEX(player);
	hookstate_t &hs = g_hook[idx];
	const char *cmd = CMD_ARGV(0);

	bool fire;
	if (DF_hook_on.value == 0.0f)
		fire = false;                                           // disabled: retract / login only
	else
		fire = (strcmp(cmd, "+hook") == 0) || (mode == 1);

	if (fire)
	{
		// re-fire cooldown (DF_hook_wait); projectile mode floors it at 0.05s
		float wait = DF_hook_wait.value;
		if ((int)DF_hook_instant.value == 0 && wait < 0.05f)
			wait = 0.05f;
		if (wait < 0.001f)
			wait = 0.001f;

		if (hs.hookstate != 0)
			return 1;
		if (!PlayerAlive(player))
			return 1;
		if (pev->movetype != MOVETYPE_WALK)
			return 1;
		if (wait + hs.lastHookTime > gpGlobals->time)
			return 1;

		// password gate
		const char *pw = DF_hook_password.string;
		if (strncmp(pw, "0", 2) != 0 && strncmp(pw, "", 1) != 0)
		{
			if (strncmp(hs.password, pw, sizeof(hs.password)) != 0)
			{
				ClientPrintHook(player, 1, "The hook has a password set and you are not logged in.\n");
				ClientPrintHook(player, 1, "To log in, type in the console: hook_login <password>\n");
				ClientPrintHook(player, 4, "The hook has a password set. Read the console.\n");
				hs.lastHookTime = gpGlobals->time;
				return 1;
			}
		}

		MAKE_VECTORS(pev->v_angle);
		Vector forward = gpGlobals->v_forward;
		Vector gunpos = pev->origin + pev->view_ofs;
		bool instant = ((int)DF_hook_instant.value != 0);

		// short probe: a projectile would stick in your face against a near wall, so abort that case
		TraceResult trProbe;
		TRACE_LINE(gunpos, gunpos + forward * 48.0f, dont_ignore_monsters, player, &trProbe);
		if (trProbe.flFraction != 1.0f && !instant)
			return 1;

		// far aim trace for the launch direction
		TraceResult trFar;
		TRACE_LINE(gunpos, pev->origin + forward * 8192.0f, dont_ignore_monsters, player, &trFar);

		// spawn the grapple tip
		edict_t *tip = CREATE_NAMED_ENTITY(ALLOC_STRING("info_target"));
		if (tip == NULL)
			return 1;
		entvars_t *tpev = &tip->v;
		tpev->classname = MAKE_STRING(HOOK_TIP_CLASSNAME);
		tpev->solid = SOLID_BBOX;
		tpev->movetype = MOVETYPE_BOUNCE;   // decompile value 10
		SET_MODEL(tip, "models/crossbow_bolt.mdl");
		UTIL_SetSize(tpev, Vector(-1, -8, -1), Vector(1, 8, 1));
		tpev->angles = pev->v_angle;
		tpev->angles.x = -tpev->angles.x;
		tpev->euser1 = player;              // firing player
		tpev->team = pev->team;
		tpev->owner = player;

		bool pointBeam = false;             // sky attach draws a BEAM_ENTPOINT rope
		Vector anchorPoint(0, 0, 0);

		if (!instant)
		{
			// projectile: launch the tip toward the aim point
			MAKE_VECTORS(pev->v_angle);
			forward = gpGlobals->v_forward;
			Vector tipPos = pev->origin + forward * 48.0f;
			tpev->origin = tipPos;

			Vector dir = trFar.vecEndPos - tipPos;
			float len = dir.Length();
			if (len == 0.0f)
				dir = Vector(0, 0, 1);
			else
				dir = dir * (1.0f / len);

			tpev->velocity = dir * DF_hook_deployspeed.value;
			tpev->gravity = DF_hook_gravity.value;
			tpev->friction = 0.5f;
			hs.hookstate = 1;
			if (DF_hook_sound.value != 0.0f)
				EMIT_SOUND_DYN2(tip, CHAN_STATIC, "weapons/xbow_fire1.wav", 1.0f, 0.8f, 0, 100);
		}
		else
		{
			// instant: hit-scan out to 10240u and attach where it lands
			MAKE_VECTORS(pev->v_angle);
			forward = gpGlobals->v_forward;
			TraceResult trInst;
			TRACE_LINE(gunpos, gunpos + forward * 10240.0f, dont_ignore_monsters, player, &trInst);

			if (trInst.pHit == NULL)
			{
				REMOVE_ENTITY(tip);
				hs.lastHookTime = gpGlobals->time;
				return 1;
			}

			if (POINT_CONTENTS(trInst.vecEndPos) == CONTENTS_SKY)
			{
				if (DF_hook_sky.value == 0.0f)
				{
					REMOVE_ENTITY(tip);
					hs.lastHookTime = gpGlobals->time;
					return 1;
				}
				pointBeam = true;
				anchorPoint = trInst.vecEndPos;
			}
			else if (strncmp(STRING(trInst.pHit->v.classname), "player", 7) == 0 &&
			         DF_hook_players.value == 0.0f)
			{
				REMOVE_ENTITY(tip);
				hs.lastHookTime = gpGlobals->time;
				return 1;
			}

			tpev->origin = trInst.vecEndPos;
			GrappleTipAttach(trInst.pHit, tip);
			hs.hookstate = 2;
		}

		tpev->nextthink = gpGlobals->time + 0.1f;

		// drop any stale rope, then build the new one
		if (hs.beamEnt != NULL && EntValid(hs.beamEnt))
		{
			hs.beamEnt->v.flags |= FL_KILLME;
			hs.beamEnt = NULL;
		}
		hs.beamEnt = BuildRopeBeam(player, tip, anchorPoint, pointBeam);
		hs.tipEnt = tip;
		return 1;
	}

	// not a fire: retract (-hook / usekey release) or login
	if (strcmp(cmd, "-hook") == 0 || mode == 2)
	{
		if (hs.hookstate != 0)
			KillHook(player);
		return 1;
	}

	if (strcmp(cmd, "hook_login") != 0)
		return 0;

	if (CMD_ARGC() < 2)
	{
		ClientPrintHook(player, 1, "Invalid login format!\n");
		return 1;
	}
	strncpy(hs.password, CMD_ARGV(1), sizeof(hs.password));
	hs._pad5c = 0;
	ClientPrintHook(player, 1, "You are now logged in with that password\n");
	return 1;
}

// pfnClientCommand: claim +hook / -hook / hook_login, let everything else pass.
void HookClientCommand(edict_t *pent)   // HookClientCommand (pfnClientCommand)
{
	const char *cmd = CMD_ARGV(0);
	if (strcmp(cmd, "+hook") == 0 || strcmp(cmd, "-hook") == 0 || strcmp(cmd, "hook_login") == 0)
	{
		if (FireHookCmd(pent, 0))
			RETURN_META(MRES_SUPERCEDE);
	}
	RETURN_META(MRES_IGNORED);
}
