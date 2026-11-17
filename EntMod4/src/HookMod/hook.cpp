#include "hookmod.h"
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <cmath>

// HookMod ("Hook Mod v5") -- reconstructed core: the per-player state, the DLL_FUNCTIONS-facing
// handlers, the per-frame reel/swing physics, and the round-reset log sniffer. Engine access uses
// the SDK macros (the shipped DLL cached enginefuncs_t at DAT_10054090 / gpGlobals at DAT_10054314);
// entity fields are written by SDK field name, never by raw offset.

// The one owner of the state array (original: base 0x10055658, stride 0x60, index == ENTINDEX).
hookstate_t g_hook[HOOK_MAXPLAYERS] = { 0 };

// ---- small helpers (original inlines) ----

// FUN_10013170 @0x10013170 -- a real, live edict: present, not freed, not flagged for death.
static bool EntIsLive(edict_t *pent)
{
	return pent != NULL && pent->free == 0 && (pent->v.flags & FL_KILLME) == 0;
}

// FUN_10011b10 @0x10011b10 -- truncate toward zero, then round half up (the original's VEC_TO_INT).
static int RoundHalfUp(float x)
{
	int n = (int)x;
	if (x - (float)n < 0.5f)
		return n;
	return n + 1;
}

// FUN_10011f90 @0x10011f90 -- player is alive (deadflag DEAD_NO and positive health).
static bool PlayerAlive(edict_t *player)
{
	return player->v.deadflag == DEAD_NO && player->v.health > 0.0f;
}

// ======================================================================================
// HookGameDLLInit (pfnGameInit) -- register the server cvars.
// ======================================================================================
void HookGameDLLInit(void)
{
	RegisterHookCvars();
	H9HookGameInit();   // H9: register the entmod / entmod_maps gate cvars (h9_gate.cpp)
	RETURN_META(MRES_IGNORED);
}

// ======================================================================================
// HookSpawn (pfnSpawn) @0x10011250 -- on worldspawn, precache the rope sprite, the bolt model and
// the crossbow sounds the grapple borrows.
// ======================================================================================
int HookSpawn(edict_t *pent)
{
	const char *classname = STRING(pent->v.classname);
	if (classname != NULL && strncmp(classname, "worldspawn", 11) == 0)
	{
		PRECACHE_MODEL((char *)"sprites/laserbeam.spr");
		PRECACHE_MODEL((char *)"models/crossbow_bolt.mdl");
		PRECACHE_SOUND((char *)"weapons/xbow_fire1.wav");
		PRECACHE_SOUND((char *)"weapons/xbow_hit1.wav");
		PRECACHE_SOUND((char *)"weapons/xbow_hitbod1.wav");
		PRECACHE_SOUND((char *)"weapons/xbow_hitbod2.wav");
	}
	RETURN_META_VALUE(MRES_IGNORED, 0);
}

// ======================================================================================
// HookClientConnect / HookClientPutInServer @0x100112d0 -- clear the joining player's slot.
// ======================================================================================
qboolean HookClientConnect(edict_t *pent, const char *name, const char *addr, char reject[128])
{
	memset(&g_hook[ENTINDEX(pent)], 0, sizeof(hookstate_t));
	RETURN_META_VALUE(MRES_IGNORED, TRUE);
}

void HookClientPutInServer(edict_t *pent)
{
	memset(&g_hook[ENTINDEX(pent)], 0, sizeof(hookstate_t));
	(*g_engfuncs.pfnClientPrintf)(pent, print_console, "This server is running Hook Mod v5.\n");
	RETURN_META(MRES_IGNORED);
}

// ======================================================================================
// HookPlayerPreThink (pfnPlayerPreThink) @0x10010620 -- +use autofire edge, then drive the pull.
// ======================================================================================
void HookPlayerPreThink(edict_t *player)
{
	entvars_t *pev = &player->v;
	const char *classname = STRING(pev->classname);
	if (classname == NULL || strcmp(classname, "player") != 0)
		RETURN_META(MRES_IGNORED);

	int idx = ENTINDEX(player);
	hookstate_t *hs = &g_hook[idx];

	// DF_hook_usekey: a rising edge on IN_USE fires, the release retracts.
	if (DF_hook_usekey.value != 0.0f)
	{
		bool pressed = (pev->button & IN_USE) != 0;
		if (pressed && hs->usekeyEdge == 0)
		{
			hs->usekeyEdge = 1;
			FireHookCmd(player, 1);
		}
		else if (!pressed && hs->usekeyEdge != 0)
		{
			hs->usekeyEdge = 0;
			FireHookCmd(player, 2);
		}
	}

	// While attached (state 2): keep pulling if still alive, un-expired and anchored; else retract.
	if (hs->hookstate == 2)
	{
		if (PlayerAlive(player) && gpGlobals->time < hs->holdExpiry && EntIsLive(hs->anchoredEnt))
		{
			HookPhysics(player);
			RETURN_META(MRES_IGNORED);
		}
		KillHook(player);
	}
	RETURN_META(MRES_IGNORED);
}

// ======================================================================================
// HookStartFrame (pfnStartFrame) @0x100117f0 -- drive each in-flight grapple tip.
// ======================================================================================
void HookStartFrame(void)
{
	int maxClients = gpGlobals->maxClients;
	for (int i = 1; i <= maxClients && i < HOOK_MAXPLAYERS; i++)
	{
		hookstate_t *hs = &g_hook[i];
		if (hs->hookstate == 1 && EntIsLive(hs->tipEnt))
			GrappleTipThink(hs->tipEnt);
	}
	RETURN_META(MRES_IGNORED);
}

// ======================================================================================
// HookPhysics @0x1000f990 -- the per-frame pull: straight reel (DF_hook_swing 0) or a constrained
// pendulum (DF_hook_swing != 0).
// ======================================================================================
void HookPhysics(edict_t *player)
{
	entvars_t *pev = &player->v;
	int idx = ENTINDEX(player);
	hookstate_t *hs = &g_hook[idx];
	edict_t *anchored = hs->anchoredEnt;

	// The attach point rides the (possibly moving) anchored entity; keep the tip glued to it.
	Vector target = (anchored->v.origin - hs->anchorPoint) + hs->anchorOffset;
	if (hs->tipEnt != NULL)
		hs->tipEnt->v.origin = target;

	if (DF_hook_swing.value == 0.0f)
	{
		// ---- straight reel ----
		float savedVelZ = pev->velocity.z;
		float speed = pev->velocity.Length();

		Vector toAnchor = target - pev->origin;
		float accel = speed * 0.2f + 400.0f;
		Vector blend = toAnchor * accel + pev->velocity * 0.2f;
		float blendLen = blend.Length();
		Vector dir = (blendLen == 0.0f) ? Vector(0.0f, 0.0f, 1.0f) : blend * (1.0f / blendLen);

		if (DF_hook_forcespeed.value == 0.0f)
			pev->velocity = dir * (DF_hook_speed.value * pev->maxspeed);  // speed-curve pull
		else
			pev->velocity = dir * DF_hook_forcespeed.value;              // constant-force pull

		// DF_hook_ground 0: never let the reel drag the player downward into the floor.
		if (DF_hook_ground.value == 0.0f && pev->velocity.z < 0.0f)
		{
			pev->velocity.z = savedVelZ;
			return;
		}
		return;
	}

	// ---- constrained pendulum swing ----
	if (hs->swingReelCooldown > gpGlobals->time)
		return;
	hs->swingReelCooldown = gpGlobals->time + 0.1f;

	Vector origin = pev->origin;

	// Where the player is looking, for the horizontal swing input.
	MAKE_VECTORS(pev->v_angle);
	Vector lookEnd = origin + gpGlobals->v_forward * 10240.0f;
	TraceResult tr;
	TRACE_LINE(origin, lookEnd, 0, player, &tr);
	Vector look = tr.vecEndPos;

	Vector vel = pev->velocity;

	int button = pev->button;
	float fwdAxis = (button & IN_FORWARD) ? 1.0f : 0.0f;
	if (button & IN_BACK)
		fwdAxis -= 1.0f;
	float rightAxis = (button & IN_MOVERIGHT) ? 1.0f : 0.0f;
	if (button & IN_MOVELEFT)
		rightAxis -= 1.0f;
	int reel = (button & IN_JUMP) ? 1 : 0;
	if (button & IN_DUCK)
		reel -= 1;

	// Forward/back + strafe push the swing in the horizontal plane toward/across the look point.
	if (fwdAxis != 0.0f || rightAxis != 0.0f)
	{
		float dx = look.x - origin.x;
		float dy = look.y - origin.y;
		float ix = fwdAxis * dx + rightAxis * dy;
		float iy = fwdAxis * dy - rightAxis * dx;
		float mag = sqrtf(ix * ix + iy * iy);
		vel.x += (float)RoundHalfUp((DF_hook_swing_acceleration.value * ix * 0.1f) / mag);
		vel.y += (float)RoundHalfUp((DF_hook_swing_acceleration.value * iy * 0.1f) / mag);
	}

	// Jump/duck reel the rope rest length in/out, clamped to the minimum.
	if (reel != 0)
		hs->ropeRestLen -= (float)RoundHalfUp((float)(reel * (int)DF_hook_swing_reelspeed.value) * 0.1f);
	if (hs->ropeRestLen < DF_hook_swing_minlength.value)
		hs->ropeRestLen = DF_hook_swing_minlength.value;

	// Rope from the tip to the player, and the tangent basis for the gravity component.
	Vector rope = hs->tipEnt->v.origin - origin;
	float ropeLen = rope.Length();
	float inv = 1.0f / ropeLen;
	float tanX = inv * rope.z * rope.x;
	float tanY = inv * rope.y * rope.z;
	float tanZ = (-1.0f / ropeLen) * (rope.x * rope.x + rope.y * rope.y);
	float tanLen = sqrtf(tanX * tanX + tanZ * tanZ + tanY * tanY);

	float svGravity = CVAR_GET_FLOAT("sv_gravity");
	float gravMag = (-1.0f / tanLen) * svGravity * tanZ;

	// Radial speed along the rope (the component the constraint cancels).
	float radial = (vel.x * rope.x + vel.z * rope.z + vel.y * rope.y) * inv;

	// Spring term pulling the player back toward the rest length.
	Vector rope2 = hs->tipEnt->v.origin - origin;
	float spring = (rope2.Length() - hs->ropeRestLen) * 4.0f;

	// Apply gravity's tangential pull (only when the tangent is well-defined).
	if (tanLen > 10.0f)
	{
		vel.x += (float)RoundHalfUp((tanX * gravMag * 0.1f) / tanLen);
		vel.y += (float)RoundHalfUp((tanY * gravMag * 0.1f) / tanLen);
		vel.z += (float)RoundHalfUp((tanZ * gravMag * 0.1f) / tanLen);
	}

	spring -= radial;
	pev->velocity.x = rope.x * spring * inv + vel.x;
	pev->velocity.y = rope.y * spring * inv + vel.y;
	pev->velocity.z = spring * rope.z * inv + vel.z;
}

// ======================================================================================
// KillHook @0x100104c0 -- retract: kill the beam and the tip, restore gravity, stamp the cooldown.
// ======================================================================================
void KillHook(edict_t *player)
{
	entvars_t *pev = &player->v;
	int idx = ENTINDEX(player);
	hookstate_t *hs = &g_hook[idx];

	if (hs->beamEnt != NULL && ENTINDEX(hs->beamEnt) != 0 && EntIsLive(hs->beamEnt))
	{
		hs->beamEnt->v.flags |= FL_KILLME;
		hs->beamEnt = NULL;
	}

	hs->hookstate = 0;

	if (hs->tipEnt != NULL && ENTINDEX(hs->tipEnt) != 0 && EntIsLive(hs->tipEnt))
		hs->tipEnt->v.flags |= FL_KILLME;
	hs->tipEnt = NULL;

	hs->lastHookTime = gpGlobals->time;

	if (hs->savedGravityFlag != 0)
		pev->gravity = hs->savedGravity;

	hs->usekeyEdge = 0;
}

// ======================================================================================
// RoundReset @0x100116f0 -- retract every active hook at round boundaries and log the restart.
// ======================================================================================
void RoundReset(void)
{
	int maxClients = gpGlobals->maxClients;
	for (int i = 1; i <= maxClients; i++)
	{
		edict_t *player = INDEXENT(i);
		if (!EntIsLive(player))
			continue;
		const char *classname = STRING(player->v.classname);
		if (classname == NULL || strcmp(classname, "player") != 0)
			continue;
		if (g_hook[ENTINDEX(player)].hookstate != 0)
			KillHook(player);
	}
	ALERT(at_console, "Round Start!\n");
}

// ======================================================================================
// HookAlertSniffer (pfnAlertMessage post-hook) @0x100030e0 -- watch the server log for the round
// boundary lines and retract everyone when one appears.
// ======================================================================================
void HookAlertSniffer(ALERT_TYPE atype, const char *szFmt, ...)
{
	static bool inSniffer = false;
	char buf[1024];

	va_list ap;
	va_start(ap, szFmt);
	vsnprintf(buf, sizeof(buf), szFmt, ap);
	va_end(ap);

	if (!inSniffer &&
	    (strstr(buf, "Round Start") != NULL ||
	     strstr(buf, "Round End") != NULL ||
	     strstr(buf, "Restart Round") != NULL))
	{
		inSniffer = true;
		RoundReset();
		inSniffer = false;
	}

	RETURN_META(MRES_IGNORED);
}
